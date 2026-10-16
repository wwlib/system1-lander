// @ts-check
// Probe the prose-mode questions (lander/modes/prose.json) on single perception sentences and
// score the answers against what a sensible pilot would pick.
// Environment: MODELS=nimble:9b,tev1:4b (also d1:3b, nimble-v3:9b)   OLLAMA_URL=http://localhost:11434

import '../env.mjs';
// (This used to import '../criteria.mjs', which no longer exists.)
import { proseSet, padSentence, altSentence, driftSentence } from '../prose.mjs';

const SYSTEMONE_URL = (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone';
const MODELS = (process.env.MODELS || 'nimble:9b,tev1:4b').split(',');

const allQuestions = proseSet().questions;

/** @param {(key: string) => boolean} keep */
function pickQuestions(keep) {
  return Object.fromEntries(Object.entries(allQuestions).filter(([key]) => keep(key)));
}
const thrustQuestions = pickQuestions((key) => /thrust/.test(key));
const horizontalQuestions = pickQuestions((key) => !/thrust/.test(key));

/**
 * @param {string} model @param {string} state @param {Record<string, any>} questions
 * @returns {Promise<{ ms: number, answers: any, inputTokens: number | undefined }>}
 */
async function ask(model, state, questions) {
  const startedAt = performance.now();
  const response = await fetch(SYSTEMONE_URL, {
    method: 'POST',
    body: JSON.stringify({ model, state, questions, keep_alive: '2h' }),
  });
  const reply = await response.json();
  return {
    ms: performance.now() - startedAt,
    answers: reply.answers,
    inputTokens: reply.usage?.input_tokens,
  };
}

/** Expected flight_velocity for each pad band. */
const EXPECTED_VELOCITY = {
  'directly below': ['none'],
  'very near': ['very_slow'],
  near: ['slow'],
  far: ['fast'],
  'way in the distance': ['fast'],
};

/** @typedef {{ sentence: string, direction: string, velocities: string[] }} PadCase */

/** @returns {PadCase[]} */
function buildPadCases() {
  /** @type {[number, keyof typeof EXPECTED_VELOCITY][]} */
  const distances = [
    [0, 'directly below'],
    [8, 'very near'],
    [25, 'near'],
    [60, 'far'],
    [120, 'way in the distance'],
  ];
  /** @type {PadCase[]} */
  const cases = [];
  for (const [distance, band] of distances) {
    const sides = distance ? [1, -1] : [1];
    for (const side of sides) {
      let direction = 'none';
      if (distance) {
        direction = side > 0 ? 'right' : 'left';
      }
      cases.push({
        sentence: padSentence(side * distance),
        direction,
        velocities: EXPECTED_VELOCITY[band],
      });
    }
  }
  return cases;
}

/**
 * Which thrust levels are acceptable for an altitude band and a fall band.
 * @param {string} altitudeBand  'high' | 'medium' | 'low' | 'touch'
 * @param {string} fallBand      'rising' | 'vslow' | 'slow' | 'fast' | 'vfast'
 */
function expectedThrust(altitudeBand, fallBand) {
  if (fallBand === 'rising') {
    return ['none'];
  }
  if (altitudeBand === 'high') {
    return fallBand === 'vfast' ? ['medium', 'large'] : ['small', 'none'];
  }
  if (altitudeBand === 'medium') {
    if (fallBand === 'vfast') {
      return ['large', 'medium'];
    }
    return fallBand === 'fast' ? ['medium', 'small'] : ['small'];
  }
  if (fallBand === 'vfast' || fallBand === 'fast') {
    return ['large'];
  }
  return fallBand === 'slow' ? ['medium'] : ['small', 'medium'];
}

/** @returns {{ sentence: string, expected: string[] }[]} */
function buildAltitudeCases() {
  /** @type {[number, string][]} */
  const altitudes = [
    [100, 'high'],
    [40, 'medium'],
    [15, 'low'],
    [2, 'touch'],
  ];
  /** @type {[number, string][]} */
  const falls = [
    [0.5, 'rising'],
    [-0.5, 'vslow'],
    [-2, 'slow'],
    [-4.5, 'fast'],
    [-9, 'vfast'],
  ];
  const cases = [];
  for (const [altitude, altitudeBand] of altitudes) {
    for (const [verticalSpeed, fallBand] of falls) {
      cases.push({
        sentence: altSentence(altitude, verticalSpeed),
        expected: expectedThrust(altitudeBand, fallBand),
      });
    }
  }
  return cases;
}

const padCases = buildPadCases();
const altitudeCases = buildAltitudeCases();
const driftCases = [-4, -2, -0.8, 0, 0.8, 2, 4].map((horizontalSpeed) => ({
  sentence: padSentence(25) + ' ' + driftSentence(horizontalSpeed),
  direction: 'right',
}));

/** @param {boolean} ok */
function mark(ok) {
  return ok ? '✓' : '✗';
}

/** @param {string} model */
async function probeModel(model) {
  await ask(model, 'warm up', thrustQuestions);
  /** @type {number[]} */
  const latencies = [];
  const correct = { direction: 0, velocity: 0, thrust: 0 };
  console.log(`== ${model}  prose.json`);

  for (const padCase of padCases) {
    const result = await ask(model, padCase.sentence, horizontalQuestions);
    latencies.push(result.ms);
    const direction = result.answers.flight_direction;
    const velocity = result.answers.flight_velocity;
    const directionOk = direction.choice === padCase.direction;
    const velocityOk = padCase.velocities.includes(velocity.choice);
    correct.direction = correct.direction + (directionOk ? 1 : 0);
    correct.velocity = correct.velocity + (velocityOk ? 1 : 0);
    const directionP = direction.probabilities[direction.choice].toFixed(2);
    const velocityP = velocity.probabilities[velocity.choice].toFixed(2);
    console.log(
      `${mark(directionOk)}${mark(velocityOk)} ${padCase.sentence.padEnd(48)} ` +
        `dir=${direction.choice} ${directionP} vel=${velocity.choice} ${velocityP} ` +
        `(want ${padCase.direction}/${padCase.velocities}) ${result.ms.toFixed(0)}ms`,
    );
  }

  for (const altitudeCase of altitudeCases) {
    const result = await ask(model, altitudeCase.sentence, thrustQuestions);
    latencies.push(result.ms);
    const thrust = result.answers.downward_thrust_magnitude;
    const thrustOk = altitudeCase.expected.includes(thrust.choice);
    correct.thrust = correct.thrust + (thrustOk ? 1 : 0);
    const probabilityList = Object.entries(thrust.probabilities)
      .map(([level, probability]) => level + ':' + Number(probability).toFixed(2))
      .join(' ');
    console.log(
      `${mark(thrustOk)} ${altitudeCase.sentence.padEnd(70)} thrust=${thrust.choice} ` +
        `${probabilityList} (want ${altitudeCase.expected}) ${result.ms.toFixed(0)}ms`,
    );
  }

  for (const driftCase of driftCases) {
    const result = await ask(model, driftCase.sentence, horizontalQuestions);
    latencies.push(result.ms);
    const direction = result.answers.flight_direction.choice;
    const velocity = result.answers.flight_velocity.choice;
    console.log(`  drift: ${driftCase.sentence.padEnd(80)} dir=${direction} vel=${velocity}`);
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const median = sorted[sorted.length >> 1].toFixed(0);
  console.log(
    `SUMMARY ${model}: direction ${correct.direction}/${padCases.length}, ` +
      `velocity ${correct.velocity}/${padCases.length}, ` +
      `thrust ${correct.thrust}/${altitudeCases.length}, median ${median} ms`,
  );
}

for (const model of MODELS) {
  await probeModel(model);
}
