// @ts-check
// Lander physics, scoring, the data-mode questions and seeded random starts.
// Shared by the server, the headless tool and the browser (served as /sim.mjs), so no Node-only imports here.

/**
 * The ship's full state. Field names are part of the /decide API, so they stay short.
 * @typedef {object} Ship
 * @property {number} x          horizontal position, m (world is 0..WORLD_WIDTH)
 * @property {number} y          height above the world floor, m (the pad surface is at PAD.y)
 * @property {number} vx         horizontal speed, m/s (+ = moving right)
 * @property {number} vy         vertical speed, m/s (+ = climbing, - = falling)
 * @property {number} fuel       fuel left, percent (0..100)
 * @property {number} angle      tilt, radians (+ = tilted right)
 * @property {number} t          simulated time since the start, s
 * @property {string | null} outcome  null while flying, then 'LANDED' or 'crash (...)'
 * @property {number} [score]    landing score 0..10 (0 for a crash)
 * @property {Record<string, number | string>} [scoreBreakdown]  points per part; { crash: reasons } for a crash
 * @property {number} [outcomeT]  the game records when the outcome happened
 * @property {string} [layout]   pad layout: 'classic' (one pad, the default) or 'pads' (choose a pad)
 * @property {string} [target]   id of the pad the pilot is aiming for (pads layout)
 * @property {number} [targetT]  sim time of the last pad choice
 * @property {number} [targetP]  the model's probability for the chosen pad
 * @property {string} [landedPad]  id of the pad the ship landed on
 */

/**
 * A landing pad. `reward` multiplies the landing score.
 * @typedef {object} Pad
 * @property {string} id      short name, also the pad_choice criteria key
 * @property {number} x0      left edge, m
 * @property {number} x1      right edge, m
 * @property {number} y       surface height, m
 * @property {number} reward  score multiplier
 * @property {string} name    how prose names it, e.g. 'the wide pad'
 * @property {string} trait   how prose describes it, e.g. 'wide and easy'
 * @property {string} sign    the small sign drawn above it, e.g. 'WIDE ×1'
 */

/** @typedef {'left' | 'center' | 'right'} Tilt */

/**
 * Engine command: false = off, true = full, or a throttle level between 0 and 1.
 * @typedef {boolean | number} Thrust
 */

export const G = 1.62; // lunar gravity, m/s²
export const THRUST = 4.0; // full-throttle engine acceleration, m/s²
export const TILT = 0.35; // how far the ship leans when steering, radians
export const FUEL_RATE = 1.0;
export const W = 200; // world width, m
export const WORLD_WIDTH = W;

/** The landing pad: from x0 to x1, at height y. */
export const PAD = { x0: 120, x1: 150, y: 10 };

/** Horizontal middle of the pad, m. */
export const PAD_CENTER_X = (PAD.x0 + PAD.x1) / 2;

/** Height of the world floor where there are no bumps, m (the classic pad sits on it). */
export const FLOOR_Y = 10;

/**
 * The pad layouts. 'classic' is the original single pad; 'pads' offers three pads to choose from.
 * @type {Record<string, Pad[]>}
 */
export const LAYOUTS = {
  classic: [
    { id: 'pad', ...PAD, reward: 1, name: 'the pad', trait: 'wide', sign: '' },
  ],
  pads: [
    { id: 'narrow', x0: 22, x1: 32, y: 10, reward: 2, name: 'the narrow pad', trait: 'narrow, needs care', sign: 'NARROW ×2' },
    { id: 'wide', x0: 80, x1: 110, y: 10, reward: 1, name: 'the wide pad', trait: 'wide and easy', sign: 'WIDE ×1' },
    { id: 'ridge', x0: 172, x1: 182, y: 40, reward: 3, name: 'the ridge pad', trait: 'narrow, high on a ridge', sign: 'RIDGE ×3' },
  ],
};

/** The classic pads (kept for code that predates layouts). */
export const PADS = LAYOUTS.classic;

/**
 * The pads for a ship's layout.
 * @param {{ layout?: string }} [ship]
 * @returns {Pad[]}
 */
export function padsFor(ship) {
  return LAYOUTS[ship?.layout || 'classic'] || LAYOUTS.classic;
}

/** @param {Pad} pad */
export function padCenter(pad) {
  return (pad.x0 + pad.x1) / 2;
}

/**
 * The pad the ship is aiming for: its chosen target, else the nearest pad.
 * @param {Ship} ship
 * @returns {Pad}
 */
export function targetPad(ship) {
  const pads = padsFor(ship);
  const chosen = pads.find((pad) => pad.id === ship.target);
  if (chosen) {
    return chosen;
  }
  let nearest = pads[0];
  for (const pad of pads) {
    if (Math.abs(padCenter(pad) - ship.x) < Math.abs(padCenter(nearest) - ship.x)) {
      nearest = pad;
    }
  }
  return nearest;
}

/**
 * Approach zones beside every pad. The model cannot see terrain, so no bump may stand near a pad.
 * Within `flat` m of a pad edge the ground is pad height; over the next `ramp` m the bumps grow back
 * smoothly to full size (and a raised pad's shoulder slopes down to the floor).
 */
export const APPROACH = { flat: 20, ramp: 25 };

/**
 * Horizontal distance from x to the nearest edge of a pad (0 on the pad).
 * @param {Pad} pad @param {number} x
 */
function distanceFromPad(pad, x) {
  return Math.max(0, pad.x0 - x, x - pad.x1);
}

/**
 * 0 inside the flat zone, rising smoothly to 1 at the end of the ramp.
 * @param {number} distance  from the pad edge, m
 */
function rampAt(distance) {
  const intoRamp = (distance - APPROACH.flat) / APPROACH.ramp;
  const ramp = Math.min(1, Math.max(0, intoRamp));
  return ramp * ramp * (3 - 2 * ramp);
}

/**
 * How much of the full bump height is allowed at x: 0 next to a pad, 1 far from every pad.
 * @param {number} x
 * @param {Pad[]} [pads]
 * @returns {number}
 */
export function bumpScale(x, pads = PADS) {
  let scale = 1;
  for (const pad of pads) {
    scale = Math.min(scale, rampAt(distanceFromPad(pad, x)));
  }
  return scale;
}

/**
 * Ground height at a horizontal position. Flat on and beside each pad, bumpy farther away.
 * A raised pad stands on a flat shoulder that slopes down to the floor.
 * @param {number} x
 * @param {Pad[]} [pads]  the layout's pads (default: the classic pad)
 * @returns {number}
 */
export function terrainY(x, pads = PADS) {
  for (const pad of pads) {
    if (x >= pad.x0 && x <= pad.x1) {
      return pad.y;
    }
  }
  for (const pad of pads) {
    const isFloorPad = pad.y <= FLOOR_Y;
    if (isFloorPad && distanceFromPad(pad, x) <= APPROACH.flat) {
      return pad.y;
    }
  }
  const bigBumps = 8 * Math.abs(Math.sin(x * 0.07));
  const smallBumps = 4 * Math.abs(Math.sin(x * 0.23));
  let height = FLOOR_Y + bumpScale(x, pads) * (bigBumps + smallBumps);
  for (const pad of pads) {
    const shoulder = FLOOR_Y + (pad.y - FLOOR_Y) * (1 - rampAt(distanceFromPad(pad, x)));
    height = Math.max(height, shoulder);
  }
  return height;
}

/**
 * The pad under x, if any.
 * @param {number} x @param {Pad[]} pads
 * @returns {Pad | undefined}
 */
export function padUnder(x, pads) {
  return pads.find((pad) => x >= pad.x0 && x <= pad.x1);
}

/** Touchdown limits for the shock-absorbing legs: stay under all three to survive. */
export const LAND = { vy: 4, vx: 2, ang: 0.3 };

/** @param {number} value @param {number} max */
function clampBetweenZeroAnd(value, max) {
  return Math.min(max, Math.max(0, value));
}

/** @param {number} value */
function roundToTenth(value) {
  return Math.round(value * 10) / 10;
}

/**
 * Gymnastics-style score for a landing. Start at 9.0, add up to 1.0 for fuel left,
 * then subtract capped deductions:
 *   vertical:   1.0 per m/s above 1 m/s (max 3)
 *   horizontal: 1.0 per m/s (max 2)
 *   tilt:       2.0 × |angle| / 0.3 (max 2)
 *   off-center: 2.0 × |x − pad center| / half the pad width (max 2)
 * The total (0..10) is then multiplied by the pad's reward.
 * @param {Ship} ship
 * @param {Pad} [pad]  the pad landed on (default: the pad under the ship)
 * @returns {{ score: number, scoreBreakdown: Record<string, number> }}
 */
export function landingScore(ship, pad) {
  const landedOn = pad || padUnder(ship.x, padsFor(ship)) || targetPad(ship);
  const halfWidth = (landedOn.x1 - landedOn.x0) / 2;
  const offCenter = Math.abs(ship.x - padCenter(landedOn));
  const breakdown = {
    base: 9,
    fuel_bonus: roundToTenth(ship.fuel / 100),
    vertical: -roundToTenth(clampBetweenZeroAnd(Math.abs(ship.vy) - 1, 3)),
    horizontal: -roundToTenth(clampBetweenZeroAnd(Math.abs(ship.vx), 2)),
    tilt: -roundToTenth(clampBetweenZeroAnd((2 * Math.abs(ship.angle)) / 0.3, 2)),
    off_center: -roundToTenth(clampBetweenZeroAnd((2 * offCenter) / halfWidth, 2)),
  };
  let total = 0;
  for (const points of Object.values(breakdown)) {
    total = total + points;
  }
  const baseScore = roundToTenth(clampBetweenZeroAnd(total, 10));
  if (landedOn.reward === 1) {
    return { score: baseScore, scoreBreakdown: breakdown };
  }
  const withReward = { ...breakdown, reward: landedOn.reward };
  return { score: roundToTenth(baseScore * landedOn.reward), scoreBreakdown: withReward };
}

/**
 * A ship at the classic start (x 40, 110 m above the pad, at rest, full fuel),
 * with any fields in `overrides` replacing the defaults.
 * @param {Partial<Ship>} [overrides]
 * @returns {Ship}
 */
export function newState(overrides = {}) {
  return { x: 40, y: 120, vx: 0, vy: 0, fuel: 100, angle: 0, t: 0, outcome: null, ...overrides };
}

/**
 * Why a touchdown was a crash, or an empty list if it was a safe landing.
 * @param {Ship} ship
 * @returns {string[]}
 */
function crashReasons(ship) {
  const reasons = [];
  const onPad = !!padUnder(ship.x, padsFor(ship));
  if (!onPad) {
    reasons.push('off pad');
  }
  if (Math.abs(ship.vy) >= LAND.vy) {
    reasons.push(`vy ${ship.vy.toFixed(1)} ≥ ${LAND.vy}`);
  }
  if (Math.abs(ship.vx) >= LAND.vx) {
    reasons.push(`vx ${ship.vx.toFixed(1)} ≥ ${LAND.vx}`);
  }
  if (Math.abs(ship.angle) >= LAND.ang) {
    reasons.push(`tilt ${ship.angle.toFixed(2)} ≥ ${LAND.ang}`);
  }
  return reasons;
}

/**
 * Advance the ship by one time step. Mutates and returns `ship`.
 * Tilting left points the thrust leftward, which pushes the ship left (vx decreases).
 * @param {Ship} ship
 * @param {number} timeStep  seconds
 * @param {Thrust} thrust
 * @param {Tilt} tilt
 * @param {number} [tiltRate]  how fast the ship leans toward the commanded tilt, rad/s
 * @returns {Ship}
 */
export function step(ship, timeStep, thrust, tilt, tiltRate = 2.0) {
  if (ship.outcome) {
    return ship;
  }

  // Lean toward the commanded tilt at up to tiltRate rad/s (2 by default).
  let targetAngle = 0;
  if (tilt === 'left') {
    targetAngle = -TILT;
  } else if (tilt === 'right') {
    targetAngle = TILT;
  }
  const angleGap = targetAngle - ship.angle;
  ship.angle += Math.sign(angleGap) * Math.min(Math.abs(angleGap), tiltRate * timeStep);

  // With the engine off, small attitude jets still give a sideways push when tilted.
  let accelerationX = (1.0 * Math.sin(ship.angle)) / Math.sin(TILT);
  let accelerationY = -G;

  let throttle = 0;
  if (thrust === true) {
    throttle = 1;
  } else {
    throttle = +thrust || 0;
  }
  if (throttle > 0 && ship.fuel > 0) {
    accelerationX = THRUST * throttle * Math.sin(ship.angle);
    accelerationY += THRUST * throttle * Math.cos(ship.angle);
    ship.fuel = Math.max(0, ship.fuel - FUEL_RATE * timeStep * 3 * throttle);
  }

  ship.vx += accelerationX * timeStep;
  ship.vy += accelerationY * timeStep;
  ship.x += ship.vx * timeStep;
  ship.y += ship.vy * timeStep;
  ship.t += timeStep;

  if (ship.x < 0 || ship.x > W) {
    ship.outcome = 'crash (out of bounds)';
  } else if (ship.y <= terrainY(ship.x, padsFor(ship))) {
    ship.y = terrainY(ship.x, padsFor(ship));
    const reasons = crashReasons(ship);
    if (reasons.length === 0) {
      ship.outcome = 'LANDED';
      const landedOn = padUnder(ship.x, padsFor(ship));
      if (ship.layout && landedOn) {
        ship.landedPad = landedOn.id;
      }
      Object.assign(ship, landingScore(ship));
    } else {
      ship.outcome = `crash (${reasons.join(', ')})`;
      ship.score = 0;
      ship.scoreBreakdown = { crash: reasons.join(', ') };
    }
  } else if (ship.t > 300) {
    ship.outcome = 'timeout';
  }
  return ship;
}

// ---- Rule oracle: a hand-written controller used only for the headless "agreement" statistic. ----
// It is never sent to the model.

/**
 * @param {Ship} ship
 * @returns {{ descent: 'too_fast' | 'ok', steer: 'left' | 'right' | 'none', pad: 'below' | 'left' | 'right', alt: number }}
 */
export function features(ship) {
  const aimPad = targetPad(ship);
  const distanceToPad = padCenter(aimPad) - ship.x; // + = pad is to the right
  const altitude = ship.y - aimPad.y;

  // While still far from the pad and low, nearly hold height; otherwise allow faster descent higher up.
  const farFromPad = Math.abs(distanceToPad) > 12;
  let targetVerticalSpeed;
  if (farFromPad && altitude < 35) {
    targetVerticalSpeed = -0.5;
  } else {
    targetVerticalSpeed = -Math.max(0.7, Math.min(altitude / 10, 5));
  }
  const descent = ship.vy < targetVerticalSpeed ? 'too_fast' : 'ok';

  const wantedSidewaysSpeed = Math.max(-3, Math.min(4, distanceToPad / 8));
  /** @type {'left' | 'right' | 'none'} */
  let steer = 'none';
  if (ship.vx < wantedSidewaysSpeed - 0.2) {
    steer = 'right';
  } else if (ship.vx > wantedSidewaysSpeed + 0.2) {
    steer = 'left';
  }
  if (altitude < 1.5) {
    steer = 'none'; // touch down upright
  }

  /** @type {'below' | 'left' | 'right'} */
  let pad = 'left';
  if (Math.abs(distanceToPad) < 10) {
    pad = 'below';
  } else if (distanceToPad > 0) {
    pad = 'right';
  }
  return { descent, steer, pad, alt: Math.round(altitude) };
}

/**
 * The rule oracle's decision in engine/steer terms.
 * @param {Ship} ship
 */
export function modelState(ship) {
  const oracle = features(ship);
  return {
    engine: oracle.descent === 'too_fast' ? 'burn' : 'off',
    steer: oracle.steer,
    pad: oracle.pad,
    alt: oracle.alt,
  };
}

/** The six engine/tilt combinations, used for the panel's action names and colors. */
export const ACTIONS = {
  burn_left: [true, 'left'],
  burn_center: [true, 'center'],
  burn_right: [true, 'right'],
  coast_left: [false, 'left'],
  coast_center: [false, 'center'],
  coast_right: [false, 'right'],
};

/**
 * Rounded physics numbers (used for logging disagreements with the rule oracle).
 * @param {Ship} ship
 */
export function physicsState(ship) {
  return {
    alt_m: roundToTenth(ship.y - PAD.y),
    vy_mps: roundToTenth(ship.vy),
    vx_mps: roundToTenth(ship.vx),
    dx_to_pad_m: roundToTenth(PAD_CENTER_X - ship.x),
    angle_deg: Math.round(ship.angle * 57.3),
    fuel_pct: Math.round(ship.fuel),
  };
}

// ---- DATA mode: one tiny yes/no fact per /v1/systemone call (neutral key "q"). ----
// Each question gets only the rounded numbers it needs. Code maps the answers with DATA_TABLE.

/**
 * Answers collected so far in one data-mode decision: `name` → yes/no, and `name_p` → probability.
 * @typedef {Record<string, boolean | number>} DataAnswers
 */

/**
 * @typedef {object} DataQuestion
 * @property {string} name
 * @property {(ship: Ship) => Record<string, number>} state   the numbers sent with this question
 * @property {object} q                                       the question, sent as-is under key "q"
 * @property {(answers: DataAnswers) => boolean} [skipIf]     skip when earlier answers already decide
 * @property {(answer: any) => boolean} [read]                for choice questions: turn the answer into yes/no
 */

/**
 * A yes/no (noul) question.
 * @param {string} instructions @param {string} whenTrue @param {string} whenFalse
 */
function yesNoQuestion(instructions, whenTrue, whenFalse) {
  return { type: 'noul', instructions, criteria: { true: whenTrue, false: whenFalse } };
}

/** @param {Ship} ship */
function fallSpeed(ship) {
  return roundToTenth(-ship.vy);
}

/** @param {Ship} ship */
function sidewaysSpeed(ship) {
  return roundToTenth(Math.abs(ship.vx));
}

/** @param {Ship} ship */
function padDistance(ship) {
  return roundToTenth(Math.abs(PAD_CENTER_X - ship.x));
}

/** @param {Ship} ship */
function altitudeRounded(ship) {
  return roundToTenth(ship.y - PAD.y);
}

/** @param {DataAnswers} answers  true when the ship is moving away from the pad or not moving toward it */
function notApproaching(answers) {
  return answers.pad_right !== answers.moving_right;
}

/** @type {DataQuestion} */
const nearGroundQuestion = {
  name: 'near_ground',
  state: (ship) => ({ alt_m: altitudeRounded(ship) }),
  q: {
    type: 'choice',
    instructions: 'How high is the lander?',
    criteria: { high: 'alt_m is 3 or more', touching_down: 'alt_m is less than 3' },
  },
  read: (answer) => answer.choice === 'touching_down',
};

/** @type {DataQuestion[]} The questions in the order they are asked. */
export const DATA_QUESTIONS = [
  nearGroundQuestion,
  {
    name: 'rising',
    state: (ship) => ({ vy_mps: roundToTenth(ship.vy) }),
    q: yesNoQuestion('Is vy_mps positive (moving up)?', 'vy_mps is positive', 'vy_mps is zero or negative'),
  },
  {
    name: 'fall_gt5',
    skipIf: (answers) => !!answers.rising,
    state: (ship) => ({ fall_speed_mps: fallSpeed(ship) }),
    q: yesNoQuestion('Is fall_speed_mps greater than 5?', 'greater than 5', '5 or less'),
  },
  {
    name: 'fall_gt1',
    skipIf: (answers) => !!(answers.rising || answers.fall_gt5),
    state: (ship) => ({ fall_speed_mps: fallSpeed(ship) }),
    q: yesNoQuestion('Is fall_speed_mps greater than 1?', 'greater than 1', '1 or less'),
  },
  {
    name: 'fall_x10',
    skipIf: (answers) => !!(answers.rising || answers.fall_gt5 || !answers.fall_gt1),
    state: (ship) => ({ fall_speed_mps: fallSpeed(ship), alt_m: altitudeRounded(ship) }),
    q: yesNoQuestion(
      'Is fall_speed_mps times 10 greater than alt_m?',
      'fall_speed_mps × 10 > alt_m',
      'not greater',
    ),
  },
  {
    name: 'pad_right',
    skipIf: (answers) => !!answers.near_ground,
    state: (ship) => ({ dx_to_pad_m: roundToTenth(PAD_CENTER_X - ship.x) }),
    q: yesNoQuestion(
      'Is dx_to_pad_m positive (pad is to the right)?',
      'dx_to_pad_m is positive',
      'dx_to_pad_m is zero or negative',
    ),
  },
  {
    name: 'moving_right',
    skipIf: (answers) => !!answers.near_ground,
    state: (ship) => ({ vx_mps: roundToTenth(ship.vx) }),
    q: yesNoQuestion('Is vx_mps positive (moving right)?', 'vx_mps is positive', 'vx_mps is zero or negative'),
  },
  {
    name: 'spd_gt3',
    skipIf: (answers) => !!(answers.near_ground || notApproaching(answers)),
    state: (ship) => ({ sideways_speed_mps: sidewaysSpeed(ship) }),
    q: yesNoQuestion('Is sideways_speed_mps greater than 3?', 'greater than 3', '3 or less'),
  },
  {
    name: 'spd_x8',
    skipIf: (answers) => !!(answers.near_ground || notApproaching(answers) || answers.spd_gt3),
    state: (ship) => ({ sideways_speed_mps: sidewaysSpeed(ship), pad_distance_m: padDistance(ship) }),
    q: yesNoQuestion(
      'Is sideways_speed_mps times 8 greater than pad_distance_m?',
      'sideways_speed_mps × 8 > pad_distance_m',
      'not greater',
    ),
  },
  {
    name: 'spd_lt2_5',
    skipIf: (answers) =>
      !!(answers.near_ground || notApproaching(answers) || answers.spd_gt3 || answers.spd_x8),
    state: (ship) => ({ sideways_speed_mps: sidewaysSpeed(ship) }),
    q: yesNoQuestion('Is sideways_speed_mps less than 2.5?', 'less than 2.5', '2.5 or more'),
  },
  {
    name: 'slow_x8',
    skipIf: (answers) =>
      !!(
        answers.near_ground ||
        notApproaching(answers) ||
        answers.spd_gt3 ||
        answers.spd_x8 ||
        !answers.spd_lt2_5
      ),
    state: (ship) => ({ sideways_speed_mps: sidewaysSpeed(ship), pad_distance_m: padDistance(ship) }),
    q: {
      type: 'noul',
      instructions: 'Is (sideways_speed_mps times 8) plus 8 less than pad_distance_m?',
      criteria: { true: 'yes, less', false: 'no' },
    },
  },
];

/** The data-mode control table, shown in the game's System 1 panel. */
export const DATA_TABLE = [
  'rising = yes → engine off',
  'else engine on  ⇐  fall_gt5 = yes, OR (fall_gt1 = yes AND fall_x10 = yes)',

  'near_ground = yes → tilt center (level for touchdown)',
  'pad_right ≠ moving_right (moving away or still) → tilt toward pad',
  'approaching AND (spd_gt3 OR spd_x8) → tilt away (brake)',
  'approaching AND spd_lt2_5 AND slow_x8 → tilt toward (speed up)',
  'approaching otherwise → HOLD: tilt center',
  'later questions are skipped when an earlier answer already decides the row',
];

/**
 * Data mode engine rule: fire unless climbing, when falling fast for the height.
 * @param {DataAnswers} answers
 * @returns {boolean}
 */
export function dataThrust(answers) {
  if (answers.rising) {
    return false;
  }
  return !!(answers.fall_gt5 || (answers.fall_gt1 && answers.fall_x10));
}

/**
 * Data mode steering rule (see DATA_TABLE).
 * @param {DataAnswers} answers
 * @returns {Tilt}
 */
export function dataMap(answers) {
  if (answers.near_ground) {
    return 'center';
  }
  const towardPad = answers.pad_right ? 'right' : 'left';
  const awayFromPad = answers.pad_right ? 'left' : 'right';
  if (notApproaching(answers)) {
    return towardPad;
  }
  if (answers.spd_gt3 || answers.spd_x8) {
    return awayFromPad; // brake
  }
  if (answers.spd_lt2_5 && answers.slow_x8) {
    return towardPad; // speed up
  }
  return 'center'; // hold the current speed
}

// ---- Random start: seeded so a start can be replayed (?seed=N in the game, SEED=N headless). ----
// The ranges are landable: well inside the world, moderate speeds, small tilt. Fuel stays at 100.

/** [min, max] for each start field. y is world height (the pad is at 10). Speeds in m/s, angle in rad. */
export const RANDOM_START = {
  x: [15, 185],
  y: [60, 150],
  vx: [-3, 3],
  vy: [-4, 1],
  angle: [-0.15, 0.15],
};

/**
 * A repeatable random-number generator (mulberry32). The seed is mixed first so that
 * consecutive seeds give unrelated sequences.
 * @param {number} seed
 * @returns {() => number}  returns numbers in [0, 1)
 */
export function createSeededRandom(seed) {
  let state = Math.imul(seed >>> 0, 2654435761) ^ 0x9e3779b9;
  return function nextRandom() {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * A random start for a seed. Each value is rounded: x and y to 1 m, speeds to 0.1 m/s, angle to 0.01 rad.
 * @param {number} seed
 * @returns {{ x: number, y: number, vx: number, vy: number, angle: number }}
 */
export function randomStart(seed) {
  const nextRandom = createSeededRandom(seed);
  /** @param {number[]} range @param {number} [steps] how many steps per unit when rounding */
  function pick([min, max], steps = 1) {
    return Math.round((min + nextRandom() * (max - min)) * steps) / steps;
  }
  // The order of the picks matters: it fixes which random number goes to which field.
  const x = pick(RANDOM_START.x);
  const y = pick(RANDOM_START.y);
  const vx = pick(RANDOM_START.vx, 10);
  const vy = pick(RANDOM_START.vy, 10);
  const angle = pick(RANDOM_START.angle, 100);
  return { x, y, vx, vy, angle };
}
