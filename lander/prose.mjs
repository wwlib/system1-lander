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

const QUESTION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'modes', 'prose.json');

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
 * @param {Ship} ship
 * @param {ProseQuestionSet} questionSet
 * @returns {string}
 */
export function perceive(ship, questionSet) {
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
  'tilt toward (target vx − actual vx) if the gap > 0.4 m/s, else center; center below 4 m (touch down upright)',
  'pads layout: pad_choice (own call, every few s until near and low) picks the target pad; distances and altitude are to that pad',
  'throttle = Σ P(level) × {none 0, small 0.3, medium 0.55, large 1}  (expected value of the choice probabilities; hover ≈ 0.41)',
];

/**
 * Turn the model's three choices into controls.
 * @param {Record<string, ChoiceAnswer>} answers
 * @param {Ship} ship
 * @returns {{ tvx: number, tilt: Tilt, throttle: number }}  tvx = target sideways speed, m/s
 */
export function proseMap(answers, ship) {
  const direction = answers.flight_direction?.choice;
  const speedChoice = answers.flight_velocity?.choice;

  let directionSign = 0;
  if (direction === 'right') {
    directionSign = 1;
  } else if (direction === 'left') {
    directionSign = -1;
  }
  const speed = SPEED[/** @type {keyof typeof SPEED} */ (speedChoice)] ?? 0;
  const targetSidewaysSpeed = directionSign * speed;

  // Tilt toward the target speed when it is more than 0.4 m/s away; level out for touchdown.
  const speedGap = targetSidewaysSpeed - ship.vx;
  /** @type {Tilt} */
  let tilt = 'center';
  if (Math.abs(speedGap) > 0.4) {
    tilt = speedGap > 0 ? 'right' : 'left';
  }
  const altitude = ship.y - targetPad(ship).y;
  if (altitude >= 0 && altitude < 4) {
    tilt = 'center';
  }

  // Throttle is the expected value over the thrust choices, using their probabilities.
  const thrustProbabilities = answers.downward_thrust_magnitude?.probabilities || {};
  let throttle = 0;
  for (const [level, levelThrottle] of Object.entries(LEVEL)) {
    throttle = throttle + (thrustProbabilities[level] || 0) * levelThrottle;
  }

  return { tvx: targetSidewaysSpeed, tilt, throttle: Math.round(throttle * 100) / 100 };
}
