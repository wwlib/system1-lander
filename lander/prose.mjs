// @ts-check
// PROSE mode (the default). Code turns the physics into plain sentences using fixed bands, standing
// in for a vision model, and asks the choice questions from lander/modes/prose.json in one call.
// The model never sees numbers and never picks raw controls; it judges the situation from the sentences.
// Code then maps the model's choices to a target sideways speed, a tilt and a throttle (PROSE_TABLE).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAD, PAD_CENTER_X } from './sim.mjs';

/** @typedef {import('./sim.mjs').Ship} Ship */
/** @typedef {import('./sim.mjs').Tilt} Tilt */

/**
 * The editable question set.
 * @typedef {object} ProseQuestionSet
 * @property {string} [about]
 * @property {string[]} [perception]  which sentences to send: 'pad', 'altitude', 'drift'
 * @property {Record<string, { type: string, instructions: string, criteria: Record<string, string> }>} questions
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
    [4, 'directly below'],
    [12, 'very near'],
    [35, 'near'],
    [80, 'far'],
    [1e9, 'way in the distance'],
  ],
  alt: [
    [4, 'about to touch down'],
    [25, 'low'],
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
 * "The pad is far to the right."
 * @param {number} distanceToPad  pad center − ship x, m (+ = pad is to the right)
 * @returns {string}
 */
export function padSentence(distanceToPad) {
  const band = bandFor(BANDS.pad, Math.abs(distanceToPad));
  const side = distanceToPad > 0 ? 'right' : 'left';
  if (band === 'directly below') {
    return 'The pad is directly below.';
  }
  if (band === 'very near') {
    return `The pad is very near, just a little to the ${side}.`;
  }
  if (band === 'near') {
    return `The pad is near, to the ${side}.`;
  }
  if (band === 'far') {
    return `The pad is far to the ${side}.`;
  }
  return `The pad is way in the distance to the ${side}.`;
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
  if (band === 'about to touch down') {
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
 * The perception prose sent as the model's state, e.g.
 * "The pad is far to the right. The lander is at high altitude and is descending fast."
 * @param {Ship} ship
 * @param {ProseQuestionSet} questionSet
 * @returns {string}
 */
export function perceive(ship, questionSet) {
  const distanceToPad = PAD_CENTER_X - ship.x;
  const altitude = ship.y - PAD.y;
  const sentenceKinds = questionSet.perception || ['pad', 'altitude'];
  const sentences = [];
  for (const kind of sentenceKinds) {
    if (kind === 'pad') {
      sentences.push(padSentence(distanceToPad));
    } else if (kind === 'altitude') {
      sentences.push(altSentence(altitude, ship.vy));
    } else if (kind === 'drift') {
      sentences.push(driftSentence(ship.vx));
    }
  }
  return sentences.join(' ');
}

/** Target sideways speed for each flight_velocity choice, m/s. */
export const SPEED = { fast: 4, slow: 2, very_slow: 0.8, none: 0 };

/** Throttle for each downward_thrust_magnitude choice (hover is about 0.41). */
export const LEVEL = { none: 0, small: 0.3, medium: 0.55, large: 1 };

/** The prose-mode control table, shown in the game's System 1 panel. */
export const PROSE_TABLE = [
  'target vx = sign(flight_direction: right +1, left −1, none 0) × speed(flight_velocity: fast 4, slow 2, very_slow 0.8, none 0 m/s)',
  'tilt toward (target vx − actual vx) if the gap > 0.4 m/s, else center; center below 4 m (touch down upright)',
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
  if (ship.y - PAD.y < 4) {
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
