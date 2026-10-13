// @ts-check
// Fly the lander without a browser. Physics runs at 60 fps, and each decision is applied only
// after its real latency (× TIME_SCALE), so slow models fly on stale controls like in the game.
//
// Environment:
//   VARIANT=prose|data|policy:<name>  (default prose)   MODEL=tev1:4b   MAX_T=120 (sim seconds)
//   EXTRA=2         add seeded extra starts to the 4 fixed ones (2 → 6 starts)
//   RANDOM_START=1 SEED=N COUNT=6
//                   instead fly COUNT random starts with seeds N, N+1, … (sim.mjs randomStart;
//                   the same starts as the game's ?seed=N)

import '../env.mjs';
import { newState, step, modelState, randomStart } from '../sim.mjs';
import { decide, DEFAULTS } from '../server.mjs';

/** @typedef {import('../sim.mjs').Ship} Ship */

const FRAME_SECONDS = 1 / 60;
const TIME_SCALE = Number(process.env.TIME_SCALE || 1);
const MAX_T = Number(process.env.MAX_T || 120);

const options = {
  variant: process.env.VARIANT || DEFAULTS.variant,
  model: process.env.MODEL || DEFAULTS.model,
  host: process.env.PROVIDER || DEFAULTS.host,
};

/**
 * The old Park–Miller generator for EXTRA starts (kept so EXTRA starts never change).
 * @returns {() => number}
 */
function createExtraStartRandom() {
  let seed = 7;
  return () => {
    seed = (seed * 16807) % 2147483647;
    return seed / 2147483647;
  };
}

/** @returns {Record<string, any>[]} */
function buildStarts() {
  if (process.env.RANDOM_START === '1') {
    const firstSeed = Number(process.env.SEED || 1);
    const count = Number(process.env.COUNT || 6);
    const randomStarts = [];
    for (let index = 0; index < count; index++) {
      randomStarts.push({ seed: firstSeed + index, ...randomStart(firstSeed + index) });
    }
    return randomStarts;
  }
  const starts = [{ x: 40 }, { x: 135, vx: 2 }, { x: 80, vx: -3, y: 100 }, { x: 20, y: 140 }];
  const random = createExtraStartRandom();
  const extraCount = Number(process.env.EXTRA || 0);
  for (let index = 0; index < extraCount; index++) {
    const x = Math.round(20 + random() * 80);
    const vx = Math.round((random() - 0.5) * 40) / 10;
    starts.push({ x, vx });
  }
  return starts;
}

/** @param {number[]} values */
function average(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Does the model's decision match the simple rule oracle (modelState)?
 * @param {any} decision @param {Ship} ship
 */
function agreesWithOracle(decision, ship) {
  const oracle = modelState(ship);
  const oracleTilt = oracle.steer === 'none' ? 'center' : oracle.steer;
  return !!decision.thrust === (oracle.engine === 'burn') && decision.tilt === oracleTilt;
}

const totals = {
  latencies: /** @type {number[]} */ ([]),
  scores: /** @type {number[]} */ ([]),
  fuels: /** @type {number[]} */ ([]),
  agreements: 0,
  decisions: 0,
  lastInputTokens: /** @type {number | undefined} */ (undefined),
  landed: 0,
};

/**
 * Fly one start to an outcome and print one line about it.
 * @param {Record<string, any>} start
 */
async function flyOne(start) {
  const { seed: _seed, ...startOverrides } = start;
  const ship = newState(startOverrides);
  /** @type {any} */
  let activeDecision = { thrust: false, tilt: 'center' };
  /** @type {number[]} */
  const latencies = [];
  let maxFall = 0;
  let throttleSum = 0;

  while (!ship.outcome) {
    if (ship.t > MAX_T) {
      ship.outcome = `crash (timeout: still flying after ${MAX_T} s sim)`;
      break;
    }
    const decision = await decide({ ...ship }, options);
    latencies.push(decision.ms);
    totals.lastInputTokens = decision.usage?.input_tokens;
    throttleSum = throttleSum + (Number(decision.thrust) || 0);
    totals.decisions = totals.decisions + 1;
    if (agreesWithOracle(decision, ship)) {
      totals.agreements = totals.agreements + 1;
    }

    // While the model was thinking, the previous decision kept flying.
    const latencySeconds = (TIME_SCALE * decision.ms) / 1000;
    for (let elapsed = 0; elapsed < latencySeconds && !ship.outcome; elapsed += FRAME_SECONDS) {
      step(ship, FRAME_SECONDS, activeDecision.thrust, activeDecision.tilt);
      maxFall = Math.max(maxFall, -ship.vy);
    }
    activeDecision = decision;
  }

  totals.latencies.push(...latencies);
  if (ship.outcome === 'LANDED') {
    totals.landed = totals.landed + 1;
  }
  totals.scores.push(ship.score ?? 0);
  totals.fuels.push(ship.fuel);

  const score = (ship.score ?? 0).toFixed(1);
  const breakdown = ship.outcome === 'LANDED' ? ' ' + JSON.stringify(ship.scoreBreakdown) : '';
  const averageLatency = average(latencies).toFixed(0);
  const averageThrottle = (throttleSum / latencies.length).toFixed(2);
  console.log(
    JSON.stringify(start),
    '->',
    ship.outcome,
    `score=${score}${breakdown}`,
    `t=${ship.t.toFixed(1)}s fuel=${ship.fuel.toFixed(0)} decisions=${latencies.length} ` +
      `avg=${averageLatency}ms maxfall=${maxFall.toFixed(1)} avgthr=${averageThrottle}`,
  );
}

const starts = buildStarts();
for (const start of starts) {
  await flyOne(start);
}

const agreePercent = ((100 * totals.agreements) / totals.decisions).toFixed(0);
console.log(
  `SUMMARY [${options.host}] ${options.model} ${options.variant}: TS=${TIME_SCALE} ` +
    `landed ${totals.landed}/${starts.length}, ` +
    `avg latency ${average(totals.latencies).toFixed(0)} ms, n=${totals.latencies.length}, ` +
    `input_tokens ${totals.lastInputTokens}, agree-with-rule-oracle ${agreePercent}%, ` +
    `avg score ${average(totals.scores).toFixed(2)}, ` +
    `avg fuel left ${average(totals.fuels).toFixed(0)}%`,
);
