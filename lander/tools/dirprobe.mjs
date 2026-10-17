// @ts-check
// Mirrored direction probe. Builds left/right-symmetric flight scenes (pad distance × sideways drift
// × altitude), turns each into perception prose with the real perceive(), asks all the flight
// questions in one call (exactly like a flight), and scores flight_direction for each side.
// Symmetry = share of mirrored pairs whose answers are mirror images.
// Environment: MODEL=tev1:4b   OLLAMA_URL=http://localhost:11434
//   PROSE_FILE=path/to/prose.json  score another question set (default lander/modes/prose.json)

import '../env.mjs';
import fs from 'node:fs';
import { newState, PAD_CENTER_X, PAD } from '../sim.mjs';
import { proseSet, perceive } from '../prose.mjs';

const SYSTEMONE_URL = (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone';
const MODEL = process.env.MODEL || 'tev1:4b';

/** @type {import('../prose.mjs').ProseQuestionSet} */
const questionSet = process.env.PROSE_FILE
  ? JSON.parse(fs.readFileSync(process.env.PROSE_FILE, 'utf8'))
  : proseSet();

/** Pad distances, m (pad center − ship x, before mirroring). */
const DISTANCES = [2, 8, 25, 60, 110];
/** Sideways speeds, m/s, toward the pad when positive (before mirroring). */
const DRIFTS = [-3, -1, 0, 1, 3];
/** [altitude above the pad m, vertical speed m/s] */
const ALTITUDES = [
  [100, -2],
  [40, -4.5],
  [15, -2],
  [2, -0.5],
];

/**
 * @param {string} state
 * @returns {Promise<Record<string, any>>}
 */
async function ask(state) {
  const response = await fetch(SYSTEMONE_URL, {
    method: 'POST',
    body: JSON.stringify({ model: MODEL, state, questions: questionSet.questions, keep_alive: '2h' }),
  });
  const reply = await response.json();
  return reply.answers || {};
}

/** The direction a sensible pilot picks. @param {number} distanceToPad */
function expectedDirection(distanceToPad) {
  if (Math.abs(distanceToPad) < 4) {
    return ['none', 'left', 'right'];
  }
  return [distanceToPad > 0 ? 'right' : 'left'];
}

/** @param {string} choice */
function mirrorChoice(choice) {
  if (choice === 'left') {
    return 'right';
  }
  if (choice === 'right') {
    return 'left';
  }
  return choice;
}

const tally = {
  right: { ok: 0, total: 0 },
  left: { ok: 0, total: 0 },
  above: { ok: 0, total: 0 },
  pairs: 0,
  mirrored: 0,
};

for (const [altitude, verticalSpeed] of ALTITUDES) {
  for (const distance of DISTANCES) {
    for (const drift of DRIFTS) {
      /** @type {Record<string, string>} */
      const pairAnswers = {};
      for (const side of [1, -1]) {
        const distanceToPad = side * distance;
        const ship = newState({
          x: PAD_CENTER_X - distanceToPad,
          y: PAD.y + altitude,
          vx: side * drift,
          vy: verticalSpeed,
        });
        const state = perceive(ship, questionSet);
        const answers = await ask(state);
        const direction = answers.flight_direction || {};
        const ok = expectedDirection(distanceToPad).includes(direction.choice);
        const bucket = Math.abs(distanceToPad) < 4 ? 'above' : side > 0 ? 'right' : 'left';
        tally[bucket].total = tally[bucket].total + 1;
        tally[bucket].ok = tally[bucket].ok + (ok ? 1 : 0);
        pairAnswers[side > 0 ? 'right' : 'left'] = direction.choice;
        const probability = direction.probabilities?.[direction.choice] ?? 0;
        console.log(
          `${ok ? '✓' : '✗'} pad ${bucket.padEnd(5)} d=${String(distance).padStart(3)} drift=${String(side * drift).padStart(2)} ` +
            `alt=${altitude} dir=${direction.choice} ${probability.toFixed(2)} vel=${answers.flight_velocity?.choice} ` +
            `thrust=${answers.downward_thrust_magnitude?.choice} | ${state}`,
        );
      }
      tally.pairs = tally.pairs + 1;
      if (pairAnswers.left === mirrorChoice(pairAnswers.right)) {
        tally.mirrored = tally.mirrored + 1;
      }
    }
  }
}

console.log(
  `SUMMARY ${MODEL} ${process.env.PROSE_FILE || 'prose.json'}: ` +
    `pad right ${tally.right.ok}/${tally.right.total}, pad left ${tally.left.ok}/${tally.left.total}, ` +
    `above ${tally.above.ok}/${tally.above.total}, mirrored pairs ${tally.mirrored}/${tally.pairs}`,
);
