// @ts-check
// POLICY mode. The model judges the ship against a plain-English policy text
// (lander/modes/policies/*.txt). To change behavior, edit the policy text, not the code.
// Each decision is 4 small yes/no calls (key "q"), each with state = { policy, ship }.
// Code uses the answer PROBABILITIES as graded values (POLICY_TABLE), not a 0.5 cutoff.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAD, PAD_CENTER_X, G, THRUST } from './sim.mjs';

/** @typedef {import('./sim.mjs').Ship} Ship */
/** @typedef {import('./sim.mjs').Tilt} Tilt */

const POLICY_FOLDER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'modes', 'policies');

/**
 * Names of the policy files, without ".txt", sorted.
 * @returns {string[]}
 */
export function policyNames() {
  const fileNames = fs.readdirSync(POLICY_FOLDER).filter((fileName) => fileName.endsWith('.txt'));
  return fileNames.map((fileName) => fileName.slice(0, -4)).sort();
}

/**
 * The text of a policy. Unknown names fall back to "careful".
 * @param {string} name
 * @returns {string}
 */
export function policyText(name) {
  const knownName = policyNames().includes(name) ? name : 'careful';
  return fs.readFileSync(path.join(POLICY_FOLDER, knownName + '.txt'), 'utf8').trim();
}

/** @param {number} value */
function roundToTenth(value) {
  return Math.round(value * 10) / 10;
}

/** @param {number} distanceToPad */
function padDirection(distanceToPad) {
  if (Math.abs(distanceToPad) < 3) {
    return 'directly below';
  }
  return distanceToPad > 0 ? 'right' : 'left';
}

/** @param {number} verticalSpeed */
function verticalMotion(verticalSpeed) {
  if (verticalSpeed < -0.05) {
    return 'descending';
  }
  if (verticalSpeed > 0.05) {
    return 'climbing';
  }
  return 'level';
}

/** @param {number} horizontalSpeed */
function sidewaysMotion(horizontalSpeed) {
  if (horizontalSpeed > 0.05) {
    return 'right';
  }
  if (horizontalSpeed < -0.05) {
    return 'left';
  }
  return 'none';
}

/** @param {number} horizontalSpeed @param {number} distanceToPad */
function sidewaysRelativeToPad(horizontalSpeed, distanceToPad) {
  if (Math.abs(horizontalSpeed) < 0.05) {
    return 'not moving sideways';
  }
  const movingRight = horizontalSpeed > 0;
  const padIsRight = distanceToPad > 0;
  return movingRight === padIsRight ? 'moving toward the pad' : 'moving away from the pad';
}

/**
 * The compact ship description sent with every policy question. Key order is part of the request body.
 * @param {Ship} ship
 */
export function shipJSON(ship) {
  const distanceToPad = roundToTenth(PAD_CENTER_X - ship.x);
  return {
    height_above_pad_m: roundToTenth(ship.y - PAD.y),
    vertical_speed_mps: roundToTenth(ship.vy),
    vertical_motion: verticalMotion(ship.vy),
    pad_direction: padDirection(distanceToPad),
    pad_distance_m: Math.abs(distanceToPad),
    sideways_motion: sidewaysMotion(ship.vx),
    sideways_speed_mps: roundToTenth(Math.abs(ship.vx)),
    sideways_vs_pad: sidewaysRelativeToPad(ship.vx, distanceToPad),
    fuel_pct: Math.round(ship.fuel),
    crash_limits:
      'touchdown is a crash if falling 4 m/s or faster, sideways 2 m/s or faster, or tilted; pad is 30 m wide',
  };
}

/** @param {string} instructions @param {string} whenTrue @param {string} whenFalse */
function yesNoQuestion(instructions, whenTrue, whenFalse) {
  return { type: 'noul', instructions, criteria: { true: whenTrue, false: whenFalse } };
}

const STEERING_HINT =
  'Consider where the pad is, and that sideways speed must shrink to almost zero as the ship gets over the pad and near the ground.';

/** The four judgment questions, asked in this order (wording from round 2 of the experiment). */
export const POLICY_QUESTIONS = [
  {
    name: 'too_fast',
    q: yesNoQuestion(
      'Following the pilot policy, is the ship falling faster than the policy allows at its current height?',
      'yes, falling too fast for the policy',
      'no, the fall rate is acceptable or the ship is not falling',
    ),
  },
  {
    name: 'too_slow',
    q: yesNoQuestion(
      'Following the pilot policy, is the ship falling slower than it needs to (or climbing), wasting fuel or time?',
      'yes, too slow or climbing',
      'no',
    ),
  },
  {
    name: 'go_right',
    q: yesNoQuestion(
      'Following the pilot policy, does the ship need more rightward speed? ' + STEERING_HINT,
      'yes, it needs more rightward speed',
      'no, rightward speed is enough or too much',
    ),
  },
  {
    name: 'go_left',
    q: yesNoQuestion(
      'Following the pilot policy, does the ship need more leftward speed? ' + STEERING_HINT,
      'yes, it needs more leftward speed',
      'no, leftward speed is enough or too much',
    ),
  },
];

/** Throttle that exactly cancels gravity. */
export const HOVER = Math.round((G / THRUST) * 100) / 100;

/** The policy-mode control table, shown in the game's System 1 panel. */
export const POLICY_TABLE = [
  `throttle = clamp(${HOVER} + 0.9·P(too_fast) − 0.9·P(too_slow), 0, 1)   (${HOVER} = hover throttle; graded, not a 0.5 cutoff)`,
  'steer = P(go_right) − P(go_left): > +0.15 → tilt right, < −0.15 → tilt left, else center',
  'height < 4 m → tilt center (touch down upright)',
];

/**
 * Turn the four probabilities into controls.
 * @param {{ too_fast_p: number, too_slow_p: number, go_right_p: number, go_left_p: number }} answers
 * @param {Ship} ship
 * @returns {{ throttle: number, tilt: Tilt }}
 */
export function policyMap(answers, ship) {
  const rawThrottle = HOVER + 0.9 * answers.too_fast_p - 0.9 * answers.too_slow_p;
  const throttle = Math.max(0, Math.min(1, rawThrottle));
  const steerPreference = answers.go_right_p - answers.go_left_p;

  /** @type {Tilt} */
  let tilt = 'center';
  if (ship.y - PAD.y < 4) {
    tilt = 'center';
  } else if (steerPreference > 0.15) {
    tilt = 'right';
  } else if (steerPreference < -0.15) {
    tilt = 'left';
  }
  return { throttle: Math.round(throttle * 100) / 100, tilt };
}
