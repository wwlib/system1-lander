// @ts-check
// Probe the thrust questions on cruise scenes (pad + altitude + terrain sentences) and score them
// against the scene's own words: the single downward_thrust_magnitude choice (prose.json) versus
// the decomposed altitude_band / descent_rate / approach_trouble questions (prose-decomp.json).
// Also reports how often each answer's confidence falls below a few cutoffs, and whether
// low-confidence answers are the wrong ones (calibration).
// Environment: MODEL=tev1:4b   OLLAMA_URL=http://localhost:11434

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { padSentence, altSentence, THRUST_TABLE, thrustConfidence } from '../prose.mjs';

const SYSTEMONE_URL = (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone';
const MODEL = process.env.MODEL || 'tev1:4b';
const modesDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'modes');

/** @param {string} file */
function readQuestions(file) {
  return JSON.parse(fs.readFileSync(path.join(modesDirectory, file), 'utf8')).questions;
}
const singleQuestions = { downward_thrust_magnitude: readQuestions('prose.json').downward_thrust_magnitude };
const decompAll = readQuestions('prose-decomp.json');
const decompQuestions = {
  altitude_band: decompAll.altitude_band,
  descent_rate: decompAll.descent_rate,
  approach_trouble: decompAll.approach_trouble,
};

/**
 * @param {string} state @param {Record<string, any>} questions
 * @returns {Promise<{ ms: number, answers: any }>}
 */
async function ask(state, questions) {
  const startedAt = performance.now();
  const response = await fetch(SYSTEMONE_URL, {
    method: 'POST',
    body: JSON.stringify({ model: MODEL, state, questions, keep_alive: '2h' }),
  });
  const reply = await response.json();
  return { ms: performance.now() - startedAt, answers: reply.answers || {} };
}

const TERRAIN = {
  clear: 'The ground between you and the pad is clear.',
  below: 'There is a ridge ahead, just below your height.',
  higher: 'There is a ridge ahead, higher than you.',
};
const altitudes = [{ m: 80, band: 'high' }, { m: 45, band: 'medium' }, { m: 20, band: 'low' }];
const fallSpeeds = [{ vy: 1, sink: 'rising' }, { vy: -0.5, sink: 'slow' }, { vy: -2, sink: 'slow' }, { vy: -4, sink: 'fast' }, { vy: -7, sink: 'fast' }];
const distances = [{ dx: 100, far: true }, { dx: -50, far: true }, { dx: 20, far: false }, { dx: -8, far: false }];

const cases = [];
for (const altitude of altitudes) {
  for (const fall of fallSpeeds) {
    for (const distance of distances) {
      for (const [terrainKey, terrainText] of Object.entries(TERRAIN)) {
        const trouble = fall.sink !== 'rising' && (terrainKey === 'higher' || (distance.far && altitude.band === 'low'));
        let level = THRUST_TABLE[altitude.band][fall.sink];
        if (trouble && (level === 'small' || level === 'none')) {
          level = 'medium';
        }
        cases.push({
          state: [padSentence(distance.dx), altSentence(altitude.m, fall.vy), terrainText].join('\n'),
          band: altitude.band,
          sink: fall.sink,
          trouble,
          level,
        });
      }
    }
  }
}

const cutoffs = [0.4, 0.5, 0.6, 0.7];
const tally = {
  single: { right: 0, lowRight: Object.fromEntries(cutoffs.map((c) => [c, 0])), lowWrong: Object.fromEntries(cutoffs.map((c) => [c, 0])), ms: 0 },
  decomp: { right: 0, band: 0, sink: 0, trouble: 0, lowRight: Object.fromEntries(cutoffs.map((c) => [c, 0])), lowWrong: Object.fromEntries(cutoffs.map((c) => [c, 0])), ms: 0 },
};
await ask('warm up', decompQuestions);
for (const testCase of cases) {
  const single = await ask(testCase.state, singleQuestions);
  const singleChoice = single.answers.downward_thrust_magnitude?.choice;
  const singleOk = singleChoice === testCase.level;
  const singleConfidence = thrustConfidence(single.answers);
  tally.single.ms = tally.single.ms + single.ms;
  tally.single.right = tally.single.right + (singleOk ? 1 : 0);

  const decomp = await ask(testCase.state, decompQuestions);
  const bandChoice = decomp.answers.altitude_band?.choice;
  const sinkChoice = decomp.answers.descent_rate?.choice;
  const troubleYes = (decomp.answers.approach_trouble?.noul ?? 0) >= 0.5;
  let decompLevel = THRUST_TABLE[bandChoice]?.[sinkChoice];
  if (troubleYes && sinkChoice !== 'rising' && (decompLevel === 'small' || decompLevel === 'none')) {
    decompLevel = 'medium';
  }
  const decompOk = decompLevel === testCase.level;
  const decompConfidence = thrustConfidence(decomp.answers);
  tally.decomp.ms = tally.decomp.ms + decomp.ms;
  tally.decomp.right = tally.decomp.right + (decompOk ? 1 : 0);
  tally.decomp.band = tally.decomp.band + (bandChoice === testCase.band ? 1 : 0);
  tally.decomp.sink = tally.decomp.sink + (sinkChoice === testCase.sink ? 1 : 0);
  tally.decomp.trouble = tally.decomp.trouble + (troubleYes === testCase.trouble ? 1 : 0);
  for (const cutoff of cutoffs) {
    if (singleConfidence < cutoff) {
      const key = singleOk ? 'lowRight' : 'lowWrong';
      tally.single[key][cutoff] = tally.single[key][cutoff] + 1;
    }
    if (decompConfidence < cutoff) {
      const key = decompOk ? 'lowRight' : 'lowWrong';
      tally.decomp[key][cutoff] = tally.decomp[key][cutoff] + 1;
    }
  }
  const mark = (/** @type {boolean} */ ok) => (ok ? '✓' : '✗');
  console.log(
    `${mark(singleOk)}${mark(decompOk)} want ${testCase.level.padEnd(6)} single=${singleChoice} (${singleConfidence.toFixed(2)}) ` +
      `decomp=${decompLevel} [${bandChoice}/${sinkChoice}/${troubleYes ? 'trouble' : 'ok'}] (${decompConfidence.toFixed(2)}) | ${testCase.state.replace(/\n/g, ' ')}`,
  );
}
const total = cases.length;
const singleWrong = total - tally.single.right;
const decompWrong = total - tally.decomp.right;
console.log(`SINGLE thrust ${tally.single.right}/${total}, mean ${(tally.single.ms / total).toFixed(0)} ms`);
console.log(
  `DECOMP thrust ${tally.decomp.right}/${total} (altitude_band ${tally.decomp.band}, descent_rate ${tally.decomp.sink}, approach_trouble ${tally.decomp.trouble}), mean ${(tally.decomp.ms / total).toFixed(0)} ms`,
);
for (const cutoff of cutoffs) {
  console.log(
    `cutoff ${cutoff}: single flags ${tally.single.lowWrong[cutoff]}/${singleWrong} wrong + ${tally.single.lowRight[cutoff]}/${tally.single.right} right; ` +
      `decomp flags ${tally.decomp.lowWrong[cutoff]}/${decompWrong} wrong + ${tally.decomp.lowRight[cutoff]}/${tally.decomp.right} right`,
  );
}
