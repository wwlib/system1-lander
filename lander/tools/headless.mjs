// @ts-check
// Fly the lander without a browser. Physics runs at 60 fps in SIM time. Calls go through the same
// pilot loop as the game (lander/pilot-loop.mjs): a decision-rate limit, smoothing, latency
// compensation and impulse limits. Each reply lands only after its real latency (× TIME_SCALE)
// plus DELAY_MS, so slow models fly on stale controls just like in the game.
//
// Environment:
//   VARIANT=prose|data|policy:<name>  (default prose)   MODEL=tev1:4b   MAX_T=120 (sim seconds)
//   LAYOUT=pads     three pads to choose from (prose mode); default classic (one pad)
//   EXTRA=2         add seeded extra starts to the 4 fixed ones (2 → 6 starts)
//   RANDOM_START=1 SEED=N COUNT=6
//                   instead fly COUNT random starts with seeds N, N+1, … (sim.mjs randomStart;
//                   the same starts as the game's ?seed=N)
//   Pilot loop (defaults from pilot-loop.mjs DEFAULT_SETTINGS; each assist can be switched alone):
//   DECISION_RATE=4 (calls per sim second; max = no limit, tests only)
//   SMOOTHING  PREDICT  STALE_DISCARD  LEASE  CLIMB_GUARD  TOUCHDOWN_LEVEL   (1/0)
//   groups: ASSISTS=0 (all off)  LATENCY_COMP=0 (predict + stale discard)
//           IMPULSE_LIMITS=0 (lease + climb guard + touchdown level); single flags win over groups
//   TILT_RATE=2     tilt slew limit with smoothing on, rad/s
//   SAME_SCENE_SKIP=1  reuse the last prose answer for an identical body (< 1 sim s old)
//   DELAY_MS=0      artificial extra latency added to every reply (simulates a slow host)
//   TRACE=1         print one line per decision: time, height, speeds, tilt, throttle, choices, scene
//   THRUST_CUTOFF=0.5  confidence gate: a less sure thrust answer keeps the previous throttle (0 = off)
//   PROSE_FILE=prose-decomp.json  question set under lander/modes/

import '../env.mjs';
import { newState, modelState, randomStart } from '../sim.mjs';
import { decide, DEFAULTS } from '../server.mjs';
import {
  createPilotLoop,
  parseRate,
  rateLabel,
  assistSummary,
  settingsFromFlags,
  DEFAULT_SETTINGS,
} from '../pilot-loop.mjs';

/** @typedef {import('../sim.mjs').Ship} Ship */

const FRAME_SECONDS = 1 / 60;
const TIME_SCALE = Number(process.env.TIME_SCALE || 1);
const MAX_T = Number(process.env.MAX_T || 120);
const DELAY_MS = Number(process.env.DELAY_MS || 0);
/** A ship that climbs this high above the pad (m), or leaves the world, has flown away. */
const FLY_AWAY_HEIGHT = 250;

const LAYOUT = process.env.LAYOUT || 'classic';
const TRACE = process.env.TRACE === '1';

const options = {
  variant: process.env.VARIANT || DEFAULTS.variant,
  model: process.env.MODEL || DEFAULTS.model,
  host: process.env.PROVIDER || DEFAULTS.host,
};

const pilotSettings = {
  rate: parseRate(process.env.DECISION_RATE) ?? DEFAULT_SETTINGS.rate,
  ...settingsFromFlags((name) => process.env[name]),
  tiltRate: Number(process.env.TILT_RATE) || DEFAULT_SETTINGS.tiltRate,
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
  if (!values.length) {
    return 0;
  }
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
  rates: /** @type {number[]} */ ([]),
  agreements: 0,
  decisions: 0,
  /** Decisions where the confidence gate kept the previous throttle. */
  held: 0,
  /** Sum of thrust-answer confidences over real (not reused) calls, and their count. */
  confidenceSum: 0,
  confidenceCount: 0,
  lastInputTokens: /** @type {number | undefined} */ (undefined),
  landed: 0,
  flewAway: 0,
  discarded: 0,
  skipped: 0,
  scenes: /** @type {number[]} */ ([]),
  pads: /** @type {string[]} */ ([]),
  /** Assist engagement summed over all flights (events and seconds). */
  engagement: { leaseEvents: 0, leaseSeconds: 0, climbGuardEvents: 0, climbGuardSeconds: 0, levelEvents: 0, levelSeconds: 0 },
};

/**
 * One trace line for a decision (TRACE=1).
 * @param {Ship} ship @param {Record<string, any>} decision
 */
function traceDecision(ship, decision) {
  const choices = [];
  for (const [question, answer] of Object.entries(decision.answers || {})) {
    if (typeof answer?.noul === 'number') {
      choices.push(`${question}=${answer.noul.toFixed(2)}`);
      continue;
    }
    const probability = answer?.probabilities?.[answer?.choice];
    const shown = probability != null ? ' ' + probability.toFixed(2) : '';
    choices.push(`${question.split('_')[0]}=${answer?.choice}${shown}`);
  }
  const scene = String(decision.upstream?.request?.state || '').replace(/\n/g, ' | ');
  const sameScene = decision.sameScene ? ' (same scene)' : '';
  console.log(
    `  t=${ship.t.toFixed(1)} y=${ship.y.toFixed(1)} vx=${ship.vx.toFixed(2)} vy=${ship.vy.toFixed(2)} ` +
      `angle=${ship.angle.toFixed(2)} fuel=${ship.fuel.toFixed(0)} throttle=${decision.throttle} tilt=${decision.tilt} ` +
      `${choices.join(' ')}${sameScene} :: ${scene}`,
  );
}

/**
 * Fly one start to an outcome and print one line about it.
 * @param {Record<string, any>} start
 */
async function flyOne(start) {
  const { seed: _seed, ...startOverrides } = start;
  const ship = newState({ ...startOverrides, ...(LAYOUT !== 'classic' ? { layout: LAYOUT } : {}) });
  /** Each pad choice: "t=0.0 ridge 0.85". */
  const padPicks = [];
  const loop = createPilotLoop(pilotSettings);
  /** @type {number[]} */
  const latencies = [];
  let maxFall = 0;
  let maxHeight = ship.y;
  let throttleSum = 0;
  let sameSceneSkips = 0;
  /** Distinct prose states sent (cache misses for Ollama's prompt cache). */
  const scenes = new Set();

  function stepFrame() {
    loop.stepShip(ship, FRAME_SECONDS);
    maxFall = Math.max(maxFall, -ship.vy);
    maxHeight = Math.max(maxHeight, ship.y);
  }

  while (!ship.outcome) {
    if (ship.t > MAX_T) {
      ship.outcome = `crash (timeout: still flying after ${MAX_T} s sim)`;
      break;
    }
    if (!loop.shouldSend(ship)) {
      stepFrame();
      continue;
    }
    const { call, requestShip } = loop.send(ship);
    const decision = await decide({ ...requestShip }, options);
    if (decision.sameScene) {
      sameSceneSkips = sameSceneSkips + 1;
    }
    if (typeof decision.upstream?.request?.state === 'string') {
      scenes.add(decision.upstream.request.state);
    }
    // A skipped call has no model latency; the artificial delay stands for a real call only.
    const latencyMs = decision.ms + (decision.sameScene ? 0 : DELAY_MS);
    latencies.push(latencyMs);
    totals.lastInputTokens = decision.usage?.input_tokens;
    throttleSum = throttleSum + (Number(decision.thrust) || 0);
    totals.decisions = totals.decisions + 1;
    if (decision.held && !decision.sameScene) {
      totals.held = totals.held + 1;
    }
    if (typeof decision.thrustConfidence === 'number' && !decision.sameScene) {
      totals.confidenceSum = totals.confidenceSum + decision.thrustConfidence;
      totals.confidenceCount = totals.confidenceCount + 1;
    }
    if (agreesWithOracle(decision, ship)) {
      totals.agreements = totals.agreements + 1;
    }

    // While the model was thinking, the ship kept flying on the previous controls.
    const arrivalT = ship.t + (TIME_SCALE * latencyMs) / 1000;
    while (ship.t < arrivalT && !ship.outcome) {
      stepFrame();
    }
    if (!ship.outcome) {
      loop.receive(call, decision, ship);
    }
    if (TRACE) {
      traceDecision(ship, decision);
    }
    if (decision.pad) {
      padPicks.push(`t=${decision.pad.t.toFixed(1)} ${decision.pad.target} ${decision.pad.confidence.toFixed(2)}`);
    }
  }

  const altitudeReached = maxHeight - 10;
  const flewAway =
    altitudeReached >= FLY_AWAY_HEIGHT || /out of bounds|timeout/.test(ship.outcome || '');
  for (const latency of latencies) {
    totals.latencies.push(latency);
  }
  if (ship.outcome === 'LANDED') {
    totals.landed = totals.landed + 1;
  }
  if (flewAway) {
    totals.flewAway = totals.flewAway + 1;
  }
  totals.scores.push(ship.score ?? 0);
  totals.fuels.push(ship.fuel);
  totals.rates.push(loop.actualRate(ship));
  totals.discarded = totals.discarded + loop.stats.discarded;
  totals.scenes.push(scenes.size);
  totals.skipped = totals.skipped + sameSceneSkips;
  for (const key of Object.keys(totals.engagement)) {
    totals.engagement[key] = totals.engagement[key] + loop.stats[key];
  }
  const engaged =
    `lease=${loop.stats.leaseEvents}/${loop.stats.leaseSeconds.toFixed(1)}s ` +
    `climb=${loop.stats.climbGuardEvents}/${loop.stats.climbGuardSeconds.toFixed(1)}s ` +
    `level=${loop.stats.levelEvents}/${loop.stats.levelSeconds.toFixed(1)}s`;

  const score = (ship.score ?? 0).toFixed(1);
  const breakdown = ship.outcome === 'LANDED' ? ' ' + JSON.stringify(ship.scoreBreakdown) : '';
  const padReport = padPicks.length
    ? ` pad=${ship.landedPad ?? '-'} picks=[${padPicks.join(', ')}]`
    : '';
  if (ship.landedPad) {
    totals.pads.push(ship.landedPad);
  }
  console.log(
    JSON.stringify(start),
    '->',
    ship.outcome,
    `score=${score}${breakdown}`,
    `x=${ship.x.toFixed(1)} touch_vx=${ship.vx.toFixed(2)} touch_vy=${ship.vy.toFixed(2)} t=${ship.t.toFixed(1)}s fuel=${ship.fuel.toFixed(0)} decisions=${latencies.length} ` +
      `avg=${average(latencies).toFixed(0)}ms maxfall=${maxFall.toFixed(1)} ` +
      `avgthr=${(throttleSum / Math.max(1, latencies.length)).toFixed(2)} ` +
      `rate=${loop.actualRate(ship).toFixed(1)}/s discarded=${loop.stats.discarded} ` +
      `scenes=${scenes.size} skipped=${sameSceneSkips} ` +
      `maxalt=${altitudeReached.toFixed(0)}m${flewAway ? ' FLEW-AWAY' : ''} assists[${engaged}]${padReport}`,
  );
}

const starts = buildStarts();
for (const start of starts) {
  await flyOne(start);
}

const agreePercent = ((100 * totals.agreements) / Math.max(1, totals.decisions)).toFixed(0);
console.log(
  `SUMMARY [${options.host}] ${options.model} ${options.variant}: TS=${TIME_SCALE} ` +
    `landed ${totals.landed}/${starts.length}, ` +
    `avg latency ${average(totals.latencies).toFixed(0)} ms, n=${totals.latencies.length}, ` +
    `input_tokens ${totals.lastInputTokens}, agree-with-rule-oracle ${agreePercent}%, ` +
    `avg score ${average(totals.scores).toFixed(2)}, ` +
    `avg fuel left ${average(totals.fuels).toFixed(0)}%, ` +
    `rate ${rateLabel(pilotSettings.rate)} → actual ${average(totals.rates).toFixed(1)}/s, ` +
    `assists: ${assistSummary(pilotSettings)}, delay ${DELAY_MS} ms, ` +
    `discarded ${totals.discarded}, flew away ${totals.flewAway}, ` +
    `unique scenes/flight ${average(totals.scenes).toFixed(1)}, same-scene skips ${totals.skipped}, ` +
    `engaged: lease ${totals.engagement.leaseEvents}×/${totals.engagement.leaseSeconds.toFixed(1)}s ` +
    `climb ${totals.engagement.climbGuardEvents}×/${totals.engagement.climbGuardSeconds.toFixed(1)}s ` +
    `level ${totals.engagement.levelEvents}×/${totals.engagement.levelSeconds.toFixed(1)}s, ` +
    `thrust cutoff ${process.env.THRUST_CUTOFF || 0}: held ${totals.held}, ` +
    `mean thrust confidence ${(totals.confidenceSum / Math.max(1, totals.confidenceCount)).toFixed(2)}` +
    (LAYOUT !== 'classic' ? `, layout ${LAYOUT}, landed on [${totals.pads.join(', ')}]` : ''),
);
