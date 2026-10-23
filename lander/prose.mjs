// @ts-check
// PROSE mode (the default). Code turns the physics into plain sentences using fixed bands, standing
// in for a vision model, and asks the choice questions from lander/modes/prose.json in one call.
// The model never sees numbers and never picks raw controls; it judges the situation from the sentences.
// Code then maps the model's choices to a target sideways speed, a tilt and a throttle (PROSE_TABLE).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { padsFor, padCenter, targetPad, terrainY } from './sim.mjs';

/** @typedef {import('./sim.mjs').Ship} Ship */
/** @typedef {import('./sim.mjs').Tilt} Tilt */
/** @typedef {import('./sim.mjs').Pad} Pad */

/**
 * The editable question set.
 * @typedef {object} ProseQuestionSet
 * @property {string} [about]
 * @property {string[]} [perception]  which sentences to send: 'pad', 'altitude', 'terrain',
 *   'approach' (drift toward / away from the pad), 'drift' (drift left / right)
 * @property {Record<string, { type: string, instructions: string, criteria: Record<string, string> }>} questions
 * @property {PadChoiceSet} [pad_choice]  the landing-pad question (pads layout only)
 * @property {{ about?: string, questions: Record<string, { type: string, instructions: string, criteria: Record<string, string> }> }} [final_approach]
 *   the questions asked instead of `questions` while the ship is in the final-approach zone
 */

/**
 * The landing-pad choice: asked in its own call, re-asked every `review_seconds` of sim time.
 * @typedef {object} PadChoiceSet
 * @property {number} [review_seconds]
 * @property {{ type: string, instructions: string, criteria: Record<string, string> }} question
 */

/**
 * A choice answer from /v1/systemone.
 * @typedef {{ choice?: string, probabilities?: Record<string, number> }} ChoiceAnswer
 */

/** The question set file under lander/modes/; PROSE_FILE=prose-decomp.json picks another (experiments). */
const QUESTION_FILE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'modes',
  process.env.PROSE_FILE || 'prose.json',
);

/**
 * Read lander/modes/prose.json. It is re-read on every call so edits apply without a restart.
 * @returns {ProseQuestionSet}
 */
export function proseSet() {
  return JSON.parse(fs.readFileSync(QUESTION_FILE, 'utf8'));
}

/**
 * Perception bands: each entry is [upper limit, words]. A value goes in the first band it is below.
 * Pad distance is |pad center − x| in m; altitude is height above the pad in m; fall and drift are m/s.
 * @type {Record<string, [number, string][]>}
 */
export const BANDS = {
  pad: [
    [4, 'directly above'],
    [12, 'close'],
    [35, 'a fair way'],
    [80, 'far'],
    [1e9, 'way in the distance'],
  ],
  alt: [
    [4, 'about to touch down'],
    [33, 'low'], // raised from 25 m so the model starts slowing a little earlier
    [60, 'medium'],
    [1e9, 'high'],
  ],
  fall: [
    [1, 'very slowly'],
    [3, 'slowly'],
    [6, 'fast'],
    [1e9, 'very fast'],
  ],
  drift: [
    [0.3, 'none'],
    [1.5, 'slowly'],
    [3, 'fast'],
    [1e9, 'very fast'],
  ],
};

/**
 * @param {[number, string][]} bands
 * @param {number} value
 * @returns {string}
 */
function bandFor(bands, value) {
  // The last band's limit is 1e9, so a band is always found for real values.
  const band = /** @type {[number, string]} */ (bands.find(([upperLimit]) => value < upperLimit));
  return band[1];
}

/**
 * Where the pad is, as an impression with the side stated twice:
 * "The pad is far off to your right. You are left of the pad."
 * @param {number} distanceToPad  pad center − ship x, m (+ = pad is to the right)
 * @returns {string}
 */
export function padSentence(distanceToPad) {
  const band = bandFor(BANDS.pad, Math.abs(distanceToPad));
  if (band === 'directly above') {
    return 'You are directly above the pad.';
  }
  const side = distanceToPad > 0 ? 'right' : 'left';
  const otherSide = distanceToPad > 0 ? 'left' : 'right';
  const yourSide = `You are ${otherSide} of the pad.`;
  if (band === 'close') {
    return `The pad is close, just off to your ${side}. ${yourSide}`;
  }
  if (band === 'a fair way') {
    return `The pad is a fair way off to your ${side}. ${yourSide}`;
  }
  if (band === 'far') {
    return `The pad is far off to your ${side}. ${yourSide}`;
  }
  return `The pad is far off to your ${side}, way in the distance. ${yourSide}`;
}

/**
 * Sideways drift relative to the pad: closing in or moving away.
 * "You are drifting toward the pad, fast." / "You are drifting away from the pad, slowly."
 * @param {number} distanceToPad    pad center − ship x, m
 * @param {number} horizontalSpeed  m/s (+ = moving right)
 * @returns {string}
 */
export function approachSentence(distanceToPad, horizontalSpeed) {
  const speedBand = bandFor(BANDS.drift, Math.abs(horizontalSpeed));
  if (speedBand === 'none') {
    return 'You are not drifting sideways.';
  }
  const speedWords = speedBand === 'slowly' ? 'slowly' : 'fast';
  const padBand = bandFor(BANDS.pad, Math.abs(distanceToPad));
  if (padBand === 'directly above') {
    const direction = horizontalSpeed > 0 ? 'right' : 'left';
    return `You are drifting ${speedWords} to the ${direction}.`;
  }
  const closing = Math.sign(horizontalSpeed) === Math.sign(distanceToPad);
  if (closing) {
    return `You are drifting toward the pad, ${speedWords}.`;
  }
  return `You are drifting away from the pad, ${speedWords}.`;
}

/**
 * "The lander is near the ground (low altitude) and is descending fast."
 * @param {number} altitude        height above the pad, m
 * @param {number} verticalSpeed   m/s (+ = climbing)
 * @returns {string}
 */
export function altSentence(altitude, verticalSpeed) {
  const band = bandFor(BANDS.alt, altitude);
  let opening = 'The lander is at high altitude';
  if (altitude < 0) {
    opening = 'The lander is below the level of the pad';
  } else if (band === 'about to touch down') {
    opening = 'The lander is about to touch down';
  } else if (band === 'low') {
    opening = 'The lander is near the ground (low altitude)';
  } else if (band === 'medium') {
    opening = 'The lander is at medium altitude';
  }
  if (verticalSpeed > 0.3) {
    return `${opening} and is rising.`;
  }
  return `${opening} and is descending ${bandFor(BANDS.fall, -verticalSpeed)}.`;
}

/**
 * "The lander is drifting to the left fast." (not sent by default; see `perception` in prose.json)
 * @param {number} horizontalSpeed  m/s (+ = moving right)
 * @returns {string}
 */
export function driftSentence(horizontalSpeed) {
  const band = bandFor(BANDS.drift, Math.abs(horizontalSpeed));
  if (band === 'none') {
    return 'The lander is not drifting sideways.';
  }
  const direction = horizontalSpeed > 0 ? 'right' : 'left';
  return `The lander is drifting to the ${direction} ${band}.`;
}

/**
 * The highest ground between the ship and a pad (the pad itself not included), m.
 * Returns -Infinity when the ship is already over the pad.
 * @param {Ship} ship @param {Pad} pad
 * @returns {number}
 */
export function highestGroundToward(ship, pad) {
  const pads = padsFor(ship);
  const goingRight = padCenter(pad) > ship.x;
  const from = goingRight ? ship.x : pad.x1;
  const to = goingRight ? pad.x0 : ship.x;
  let highest = -Infinity;
  for (let x = Math.ceil(from); x < to; x++) {
    highest = Math.max(highest, terrainY(x, pads));
  }
  return highest;
}

/**
 * A terrain-clearance impression along the way to the target pad, as a line-of-sight stand-in:
 * "There is a ridge ahead, higher than you." / "…just below your height." / "The ground … is clear."
 * @param {Ship} ship @param {Pad} pad
 * @returns {string}
 */
export function terrainSentence(ship, pad) {
  const clearance = ship.y - highestGroundToward(ship, pad);
  if (clearance < 0) {
    return 'There is a ridge ahead, higher than you.';
  }
  if (clearance < 12) {
    return 'There is a ridge ahead, just below your height.';
  }
  return 'The ground between you and the pad is clear.';
}

/**
 * The perception prose sent as the model's state, one sentence group per line, e.g.
 * "The pad is far off to your right. You are left of the pad.\n
 *  The lander is at high altitude and is descending fast."
 * Distances and altitude are measured to the target pad.
 * In the final-approach zone (see inFinalApproach) the scene switches to finalApproachScene.
 * @param {Ship} ship
 * @param {ProseQuestionSet} questionSet
 * @returns {string}
 */
export function perceive(ship, questionSet) {
  if (questionSet.final_approach && inFinalApproach(ship)) {
    return finalApproachScene(ship);
  }
  const pad = targetPad(ship);
  const distanceToPad = padCenter(pad) - ship.x;
  const altitude = ship.y - pad.y;
  const sentenceKinds = questionSet.perception || ['pad', 'altitude'];
  const sentences = [];
  for (const kind of sentenceKinds) {
    if (kind === 'pad') {
      sentences.push(padSentence(distanceToPad));
    } else if (kind === 'altitude') {
      sentences.push(altSentence(altitude, ship.vy));
    } else if (kind === 'terrain') {
      sentences.push(terrainSentence(ship, pad));
    } else if (kind === 'approach') {
      sentences.push(approachSentence(distanceToPad, ship.vx));
    } else if (kind === 'drift') {
      sentences.push(driftSentence(ship.vx));
    }
  }
  return sentences.join('\n');
}

// ---- Final approach (the last few meters over the pad) ----

/** The final-approach zone: below this height above the target pad, m. */
export const FINAL_APPROACH_HEIGHT = 18;

/** …and no further than this outside the target pad's edges, m. */
export const FINAL_APPROACH_MARGIN = 15;

/**
 * Is the ship in the final-approach zone: low over (or just beside) the target pad?
 * @param {Ship} ship
 * @returns {boolean}
 */
export function inFinalApproach(ship) {
  const pad = targetPad(ship);
  const heightAbovePad = ship.y - pad.y;
  const isLow = heightAbovePad >= 0 && heightAbovePad < FINAL_APPROACH_HEIGHT;
  const isOverPad = ship.x > pad.x0 - FINAL_APPROACH_MARGIN && ship.x < pad.x1 + FINAL_APPROACH_MARGIN;
  return isLow && isOverPad;
}

/**
 * Where the legs are over the pad, with the side of the pad (or its middle) stated too:
 * "Your legs are over the middle of the pad." /
 * "Your legs are over the pad, near its left edge; the middle of the pad is just off to your right." /
 * "Your legs are past the pad's left edge, over rough ground; the pad is just off to your right."
 * @param {Ship} ship @param {Pad} pad
 * @returns {string}
 */
export function footingSentence(ship, pad) {
  const shortOfLeftEdge = pad.x0 - ship.x;
  const pastRightEdge = ship.x - pad.x1;
  if (shortOfLeftEdge > 4) {
    return 'You are short of the pad, over rough ground; the pad is a short way off to your right.';
  }
  if (pastRightEdge > 4) {
    return 'You are short of the pad, over rough ground; the pad is a short way off to your left.';
  }
  if (shortOfLeftEdge > 0) {
    return "Your legs are past the pad's left edge, over rough ground; the pad is just off to your right.";
  }
  if (pastRightEdge > 0) {
    return "Your legs are past the pad's right edge, over rough ground; the pad is just off to your left.";
  }
  const halfWidth = (pad.x1 - pad.x0) / 2;
  const offset = ship.x - padCenter(pad);
  if (Math.abs(offset) < halfWidth * 0.6) {
    return 'Your legs are over the middle of the pad.';
  }
  const edgeSide = offset > 0 ? 'right' : 'left';
  const middleSide = offset > 0 ? 'left' : 'right';
  return `Your legs are over the pad, near its ${edgeSide} edge; the middle of the pad is just off to your ${middleSide}.`;
}

/**
 * Height above the pad in fine bands: "You are almost touching the pad."
 * @param {number} heightAbovePad  m
 * @returns {string}
 */
export function heightSentence(heightAbovePad) {
  if (heightAbovePad < 1.5) {
    return 'You are almost touching the pad; your legs are about to touch it.';
  }
  if (heightAbovePad < 4) {
    return 'You are a couple of meters above the pad; your legs are about to touch it.';
  }
  if (heightAbovePad < 8) {
    return 'You are a few meters above the pad.';
  }
  if (heightAbovePad < 13) {
    return 'You are a little way above the pad.';
  }
  return 'You are some way above the pad, coming in to land.';
}

/**
 * The sink rate as an impression: "You are settling gently." / "You are dropping hard."
 * @param {number} verticalSpeed  m/s (+ = climbing)
 * @returns {string}
 */
export function sinkSentence(verticalSpeed) {
  if (verticalSpeed > 0.3) {
    return 'You are rising.';
  }
  const sinkRate = -verticalSpeed;
  if (sinkRate < 1.2) {
    return 'You are settling gently.';
  }
  if (sinkRate < 2.5) {
    return 'You are sinking steadily.';
  }
  if (sinkRate < 3.5) {
    return 'You are dropping fast.';
  }
  return 'You are dropping hard.';
}

/**
 * Sideways motion as an impression, relative to the pad:
 * "You are sliding sideways quickly to the left, toward the pad's left edge." / "You are nearly still sideways."
 * @param {Ship} ship @param {Pad} pad
 * @returns {string}
 */
export function slideSentence(ship, pad) {
  const sidewaysSpeed = Math.abs(ship.vx);
  if (sidewaysSpeed < 0.3) {
    return 'You are nearly still sideways.';
  }
  const direction = ship.vx > 0 ? 'right' : 'left';
  let manner = 'sliding';
  if (sidewaysSpeed < 1) {
    manner = 'sliding slowly';
  } else if (sidewaysSpeed >= 1.8) {
    manner = 'sliding sideways quickly';
  }
  const towardCenter = Math.sign(padCenter(pad) - ship.x) === Math.sign(ship.vx);
  const isOverPad = ship.x >= pad.x0 && ship.x <= pad.x1;
  let where = `toward the pad's ${direction} edge`;
  if (towardCenter) {
    where = 'toward the middle of the pad';
  } else if (!isOverPad) {
    where = 'away from the pad';
  }
  return `You are ${manner} to the ${direction}, ${where}.`;
}

/**
 * The lean: "You are leaning left; your legs are not level." / "You are upright."
 * @param {number} angle  rad (+ = leaning right)
 * @returns {string}
 */
export function leanSentence(angle) {
  if (Math.abs(angle) < 0.05) {
    return 'You are upright.';
  }
  const side = angle > 0 ? 'right' : 'left';
  return `You are leaning ${side}; your legs are not level.`;
}

/**
 * The final-approach scene, one sentence per line, e.g.
 * "Your legs are over the pad, near its left edge; the middle of the pad is just off to your right.\n You are a few meters above the pad.\n
 *  You are sinking steadily.\n You are sliding slowly to the left, toward the pad's left edge.\n You are upright."
 * @param {Ship} ship
 * @returns {string}
 */
export function finalApproachScene(ship) {
  const pad = targetPad(ship);
  const sentences = [
    footingSentence(ship, pad),
    heightSentence(ship.y - pad.y),
    sinkSentence(ship.vy),
    slideSentence(ship, pad),
    leanSentence(ship.angle),
  ];
  return sentences.join('\n');
}

/**
 * The questions to ask now: the final-approach set inside the zone (when prose.json has one), else the usual set.
 * @param {Ship} ship @param {ProseQuestionSet} questionSet
 */
export function questionsFor(ship, questionSet) {
  if (questionSet.final_approach && inFinalApproach(ship)) {
    return questionSet.final_approach.questions;
  }
  return questionSet.questions;
}

// ---- Landing-pad choice (pads layout) ----

/**
 * Where a pad is, in words: "far to the right" / "directly below you".
 * @param {number} distanceToPad  pad center − ship x, m
 */
function padPlace(distanceToPad) {
  const band = bandFor(BANDS.pad, Math.abs(distanceToPad));
  const side = distanceToPad > 0 ? 'right' : 'left';
  if (band === 'directly above') {
    return 'directly below you';
  }
  if (band === 'close') {
    return `close, just off to your ${side}`;
  }
  if (band === 'a fair way') {
    return `a fair way off to your ${side}`;
  }
  if (band === 'far') {
    return `far off to your ${side}`;
  }
  return `way in the distance to your ${side}`;
}

/**
 * How high the ship is above a pad, in words.
 * @param {number} heightAbovePad  m
 */
function padDepth(heightAbovePad) {
  if (heightAbovePad < 0) {
    return 'higher than you';
  }
  const band = bandFor(BANDS.alt, heightAbovePad);
  if (band === 'high') {
    return 'far below you';
  }
  if (band === 'medium') {
    return 'below you';
  }
  return 'just below you';
}

/** @param {number} fuel percent */
function fuelSentence(fuel) {
  if (fuel > 60) {
    return 'You have plenty of fuel.';
  }
  if (fuel > 30) {
    return 'You have about half of your fuel.';
  }
  return 'You are low on fuel.';
}

/**
 * One pad, relative to the ship: "The ridge pad (narrow, high on a ridge, ×3 points) is far to
 * the right and far below you; a ridge higher than you is in the way."
 * @param {Ship} ship @param {Pad} pad
 */
export function padSummary(ship, pad) {
  const place = padPlace(padCenter(pad) - ship.x);
  const depth = padDepth(ship.y - pad.y);
  const name = pad.name.charAt(0).toUpperCase() + pad.name.slice(1);
  const blocked = ship.y < highestGroundToward(ship, pad);
  const obstacle = blocked ? '; a ridge higher than you is in the way' : '';
  return `${name} (${pad.trait}, ×${pad.reward} points) is ${place} and ${depth}${obstacle}.`;
}

/**
 * The state for the pad choice: every pad, the fuel, and the current target, one per line.
 * @param {Ship} ship
 * @returns {string}
 */
export function padChoiceState(ship) {
  const sentences = padsFor(ship).map((pad) => padSummary(ship, pad));
  sentences.push(fuelSentence(ship.fuel));
  const current = padsFor(ship).find((pad) => pad.id === ship.target);
  if (current) {
    sentences.push(`You are heading for ${current.name}.`);
  }
  return sentences.join('\n');
}

/**
 * Is it time to (re)choose a pad? Always without a target; otherwise every `review_seconds`,
 * but not once the ship is committed (near the target and low above it).
 * @param {Ship} ship @param {ProseQuestionSet} questionSet
 */
export function padChoiceDue(ship, questionSet) {
  if (!questionSet.pad_choice || padsFor(ship).length < 2) {
    return false;
  }
  if (!ship.target || ship.targetT == null) {
    return true;
  }
  const pad = targetPad(ship);
  const isNear = Math.abs(padCenter(pad) - ship.x) < 35;
  const isLow = ship.y - pad.y < 25;
  if (isNear && isLow) {
    return false;
  }
  const reviewSeconds = questionSet.pad_choice.review_seconds ?? 5;
  return ship.t - ship.targetT >= reviewSeconds;
}

/** Target sideways speed for each flight_velocity choice, m/s. */
export const SPEED = { fast: 4, slow: 2, very_slow: 0.8, none: 0 };

/** Throttle for each downward_thrust_magnitude choice (hover is about 0.41). */
export const LEVEL = { none: 0, small: 0.3, medium: 0.55, large: 1 };

/** The prose-mode control table, shown in the game's System 1 panel. */
export const PROSE_TABLE = [
  'target vx = sign(flight_direction: right +1, left −1, none 0) × speed(flight_velocity: fast 4, slow 2, very_slow 0.8, none 0 m/s)',
  'tilt toward (target vx − actual vx) if the gap > 0.4 m/s, else center; center when legs_about_to_touch ≥ 0.9 (final approach)',
  'pads layout: pad_choice (own call, every few s until near and low) picks the target pad; distances and altitude are to that pad',
  'final approach (< 18 m above the target pad, within 15 m of its edges): the scene switches to legs vs pad edges, fine height, sink and slide impressions, lean; questions from final_approach in prose.json',
  'throttle = Σ P(level) × {none 0, small 0.3, medium 0.55, large 1}  (expected value of the choice probabilities; hover ≈ 0.41)',
];

/** legs_about_to_touch at or above this counts as yes (the model says about 0.96–0.99 under 4 m, at most 0.86 above). */
export const TOUCH_YES = 0.9;

/**
 * Did the model judge that the legs are about to touch the pad (final-approach question)?
 * @param {Record<string, any>} answers
 * @returns {boolean}
 */
export function legsAboutToTouch(answers) {
  const value = answers.legs_about_to_touch?.noul;
  return typeof value === 'number' && value >= TOUCH_YES;
}

/**
 * @typedef {object} ConfidenceGate
 * @property {number} cutoff   answers with confidence below this are "unsure" (0 = gate off)
 * @property {'hold' | 'rollup' | 'blend'} mode
 *   hold   = keep the previous command for that control;
 *   rollup = report the answer one level up its hierarchy (see ROLLUP), no second call;
 *   blend  = probability-weighted mix of the options' controls
 * @property {{ throttle: number, tvx: number } | null} previous  the last command sent (hold mode)
 */

/**
 * Coarse levels, one step up each choice's hierarchy, used when the model is unsure.
 * Thrust: small / medium / large roll up to "some thrust" (about hover); none stays none.
 * Direction: left / right / none roll up to "not sure which way" = no sideways push (upright).
 * Speed: fast / slow roll up to "moving" (slow); very_slow / none roll up to "barely" (very_slow).
 */
export const ROLLUP = {
  someThrust: 0.45,
  speed: { fast: 'slow', slow: 'slow', very_slow: 'very_slow', none: 'none' },
};

/**
 * Turn the model's choices into controls, with an optional confidence gate.
 * @param {Record<string, ChoiceAnswer>} answers
 * @param {Ship} ship
 * @param {ConfidenceGate} [gate]
 * @returns {{ tvx: number, tilt: Tilt, throttle: number, thrustConfidence: number, sideConfidence: number, gated: string[] }}
 *   tvx = target sideways speed, m/s; gated lists the controls the gate changed ("thrust", "side")
 */
export function proseMap(answers, ship, gate) {
  const cutoff = gate?.cutoff ?? 0;
  const mode = gate?.mode ?? 'hold';
  const thrustConfidence = groupConfidence(answers, THRUST_KEYS);
  const sideConfidence = groupConfidence(answers, SIDE_KEYS);
  const thrustUnsure = thrustConfidence < cutoff;
  const sideUnsure = sideConfidence < cutoff;
  /** @type {string[]} */
  const gated = [];

  const direction = answers.flight_direction?.choice;
  let speedChoice = answers.flight_velocity?.choice;
  let directionSign = 0;
  if (direction === 'right') {
    directionSign = 1;
  } else if (direction === 'left') {
    directionSign = -1;
  }
  const directionUnsure = answerConfidence(answers.flight_direction) < cutoff;
  const speedUnsure = answerConfidence(answers.flight_velocity) < cutoff;
  if (mode === 'rollup' && speedUnsure && speedChoice) {
    speedChoice = ROLLUP.speed[/** @type {keyof typeof ROLLUP.speed} */ (speedChoice)] ?? speedChoice;
  }
  const speed = SPEED[/** @type {keyof typeof SPEED} */ (speedChoice)] ?? 0;
  let targetSidewaysSpeed = directionSign * speed;
  let noSidewaysPush = false;
  if (sideUnsure) {
    gated.push('side');
    if (mode === 'hold' && gate?.previous) {
      targetSidewaysSpeed = gate.previous.tvx;
    } else if (mode === 'blend') {
      targetSidewaysSpeed = expectedSign(answers.flight_direction) * expectedSpeed(answers.flight_velocity);
    } else if (mode === 'rollup' && directionUnsure) {
      noSidewaysPush = true;
      targetSidewaysSpeed = ship.vx;
    }
  }

  // Tilt toward the target speed when it is more than 0.4 m/s away.
  const speedGap = targetSidewaysSpeed - ship.vx;
  /** @type {Tilt} */
  let tilt = 'center';
  if (Math.abs(speedGap) > 0.4 && !noSidewaysPush) {
    tilt = speedGap > 0 ? 'right' : 'left';
  }
  // The model's own touchdown call (final approach): when it judges the legs are about to touch,
  // the lander stops leaning, whatever the sideways speed. (The pilot loop's touchdownLevel assist
  // is the code version of this; see pilot-loop.mjs.)
  if (legsAboutToTouch(answers)) {
    tilt = 'center';
  }

  // Throttle is already the probability-weighted blend of the options (blend mode = no change).
  let throttle = throttleFromAnswers(answers);
  if (thrustUnsure) {
    gated.push('thrust');
    if (mode === 'hold' && gate?.previous) {
      throttle = gate.previous.throttle;
    } else if (mode === 'rollup' && !chosenRising(answers)) {
      throttle = ROLLUP.someThrust;
    }
  }

  return {
    tvx: targetSidewaysSpeed,
    tilt,
    throttle: Math.round(throttle * 100) / 100,
    thrustConfidence,
    sideConfidence,
    gated,
  };
}

/**
 * Did the thrust answer pick "the lander is rising" (no thrust)?
 * @param {Record<string, any>} answers
 */
function chosenRising(answers) {
  return answers.downward_thrust_magnitude?.choice === 'none' || answers.descent_rate?.choice === 'rising';
}

/**
 * Probability-weighted direction: P(right) − P(left).
 * @param {any} answer
 */
function expectedSign(answer) {
  const probabilities = answer?.probabilities || {};
  return (probabilities.right || 0) - (probabilities.left || 0);
}

/**
 * Probability-weighted sideways speed, m/s.
 * @param {any} answer
 */
function expectedSpeed(answer) {
  const probabilities = answer?.probabilities || {};
  let speed = 0;
  for (const [band, bandSpeed] of Object.entries(SPEED)) {
    speed = speed + (probabilities[band] || 0) * bandSpeed;
  }
  return speed;
}

/**
 * Decomposed thrust (TypeSafe-style): the model answers narrow questions and this table maps
 * them to a thrust level. It is the same policy the single downward_thrust_magnitude criteria
 * describe, written as a lookup: rows = altitude_band, columns = descent_rate.
 * @type {Record<string, Record<string, keyof typeof LEVEL>>}
 */
export const THRUST_TABLE = {
  high: { rising: 'none', slow: 'small', fast: 'small' },
  medium: { rising: 'none', slow: 'small', fast: 'medium' },
  low: { rising: 'none', slow: 'medium', fast: 'large' },
};

/**
 * Throttle from the answers.
 * Single question: expected value of LEVEL over downward_thrust_magnitude's probabilities.
 * Decomposed: expected value of THRUST_TABLE over P(altitude_band) × P(descent_rate); then, when
 * the warning approach_trouble says trouble (P ≥ 0.5) and the lander is not rising, at least medium.
 * @param {Record<string, any>} answers
 * @returns {number}  0..1
 */
export function throttleFromAnswers(answers) {
  if (answers.downward_thrust_magnitude) {
    const thrustProbabilities = answers.downward_thrust_magnitude.probabilities || {};
    let throttle = 0;
    for (const [level, levelThrottle] of Object.entries(LEVEL)) {
      throttle = throttle + (thrustProbabilities[level] || 0) * levelThrottle;
    }
    return throttle;
  }
  const heightProbabilities = answers.altitude_band?.probabilities || {};
  const sinkProbabilities = answers.descent_rate?.probabilities || {};
  let throttle = 0;
  for (const [height, row] of Object.entries(THRUST_TABLE)) {
    for (const [sink, level] of Object.entries(row)) {
      const weight = (heightProbabilities[height] || 0) * (sinkProbabilities[sink] || 0);
      throttle = throttle + weight * LEVEL[level];
    }
  }
  const trouble = answers.approach_trouble?.noul;
  const rising = answers.descent_rate?.choice === 'rising';
  if (typeof trouble === 'number' && trouble >= 0.5 && !rising) {
    throttle = Math.max(throttle, LEVEL.medium);
  }
  return throttle;
}

/** The questions that set the throttle, single or decomposed. */
const THRUST_KEYS = ['downward_thrust_magnitude', 'altitude_band', 'descent_rate', 'approach_trouble'];

/** The questions that set the sideways target. */
const SIDE_KEYS = ['flight_direction', 'flight_velocity'];

/**
 * An answer's confidence: a choice's own `confidence` field (how concentrated its probability
 * spread is, 1 = all on one option); for a noul, 1 − binary entropy of P (P 0.5 → 0, P 0 or 1 → 1).
 * @param {any} answer
 * @returns {number}  0..1 (1 when there is no answer)
 */
export function answerConfidence(answer) {
  if (!answer) {
    return 1;
  }
  if (typeof answer.noul === 'number') {
    const p = Math.min(Math.max(answer.noul, 1e-9), 1 - 1e-9);
    const entropy = -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
    return 1 - entropy;
  }
  if (typeof answer.confidence === 'number') {
    return answer.confidence;
  }
  return answer.probabilities?.[answer.choice] ?? 0;
}

/**
 * The lowest confidence among a group of questions (max-style: one unsure answer is enough).
 * @param {Record<string, any>} answers @param {string[]} keys
 */
function groupConfidence(answers, keys) {
  let lowest = 1;
  for (const key of keys) {
    if (answers[key]) {
      lowest = Math.min(lowest, answerConfidence(answers[key]));
    }
  }
  return lowest;
}

/**
 * Confidence of the thrust answer (lowest among the thrust questions asked).
 * @param {Record<string, any>} answers
 */
export function thrustConfidence(answers) {
  return groupConfidence(answers, THRUST_KEYS);
}
