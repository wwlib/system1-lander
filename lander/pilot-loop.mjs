// @ts-check
// The pilot loop: everything between "the model answered" and "the engine does something".
// Shared by the browser game (game.js) and the headless runner (tools/headless.mjs), so both fly
// the same way. All of this is plain code, not model behavior. Each assist has its own switch so
// it can be turned off alone (see ASSISTS and the README section "Is the code cheating?"):
//
//   - Decision rate: send at most `rate` calls per SIM second, never more than one in flight.
//   - smoothing: a reply sets TARGET throttle and tilt; the actual controls ease toward them.
//   - predict: send the state predicted for when the reply will land, instead of the current one.
//   - discardStale: drop a reply older than `maxAge` sim seconds while a recent target exists.
//   - lease: a throttle target expires after max(1/rate, leaseMin) s; then the engine eases to
//     hover, or to idle while rising (steers toward a gentle descent: off by default).
//   - climbGuard: rising faster than `climbLimit` caps the throttle at half hover (stops a held
//     burn from flying the ship away).
//   - touchdownLevel: within `levelHeight` m of the ground below, the tilt goes to center without
//     waiting for a reply (steers toward a clean touchdown: off by default).
//
// The request body is untouched: the loop only chooses WHEN to call and WHICH ship state to send.

import { step, G, THRUST, terrainY, padsFor } from './sim.mjs';

/** @typedef {import('./sim.mjs').Ship} Ship */
/** @typedef {import('./sim.mjs').Tilt} Tilt */

/**
 * @typedef {object} PilotSettings
 * @property {number} rate            decisions per sim second; Infinity = as fast as replies come
 * @property {boolean} smoothing      ease controls toward targets instead of jumping
 * @property {number} throttleTau     throttle time constant, s (smoothing on)
 * @property {number} tiltRate        tilt slew limit, rad/s (smoothing on; physics default is 2)
 * @property {boolean} predict        send the state predicted for when the reply lands
 * @property {boolean} discardStale   discard replies older than maxAge (while a recent target exists)
 * @property {number} maxAge          sim s
 * @property {boolean} lease          a throttle target expires, then eases to hover (or idle while rising)
 * @property {number} leaseMin        a throttle target lasts max(1/rate, leaseMin) sim seconds
 * @property {boolean} climbGuard     cap the throttle at half hover while rising fast
 * @property {number} climbLimit      m/s; above this upward speed the guard caps throttle below hover
 * @property {boolean} touchdownLevel tilt to center near the ground without waiting for a reply
 * @property {number} levelHeight     m above the ground below; under it the tilt goes to center
 */

/** Throttle that exactly cancels gravity (about 0.41). */
export const HOVER_THROTTLE = G / THRUST;

/**
 * The assists with their switch, a short label, and what kind of help they are.
 * 'safety' = only stops runaway or stale behavior; 'steering' = pushes toward a good landing.
 * @type {{ key: 'smoothing' | 'predict' | 'discardStale' | 'lease' | 'climbGuard' | 'touchdownLevel', label: string, env: string, url: string, kind: string }[]}
 */
export const ASSISTS = [
  { key: 'smoothing', label: 'smoothing', env: 'SMOOTHING', url: 'smooth', kind: 'actuator' },
  { key: 'predict', label: 'predict', env: 'PREDICT', url: 'predict', kind: 'timing' },
  { key: 'discardStale', label: 'stale discard', env: 'STALE_DISCARD', url: 'stale', kind: 'safety' },
  { key: 'lease', label: 'burn lease', env: 'LEASE', url: 'lease', kind: 'steering' },
  { key: 'climbGuard', label: 'climb guard', env: 'CLIMB_GUARD', url: 'climb', kind: 'safety' },
  { key: 'touchdownLevel', label: 'touchdown level', env: 'TOUCHDOWN_LEVEL', url: 'level', kind: 'steering' },
];

/** @type {PilotSettings} */
export const DEFAULT_SETTINGS = {
  rate: 4,
  smoothing: true,
  throttleTau: 0.15,
  tiltRate: 2.0,
  predict: true,
  discardStale: true,
  maxAge: 1.5,
  lease: false,
  leaseMin: 0.4,
  climbGuard: true,
  climbLimit: 1.0,
  touchdownLevel: false,
  levelHeight: 4,
};

/**
 * "smoothing on · predict off · …" for logs and the HUD.
 * @param {Partial<PilotSettings>} settings
 * @returns {string}
 */
export function assistSummary(settings) {
  const parts = [];
  for (const assist of ASSISTS) {
    parts.push(`${assist.label} ${settings[assist.key] ? 'on' : 'off'}`);
  }
  return parts.join(' · ');
}
/** The rate choices offered in the UI. ('max' is accepted only by headless tests, DECISION_RATE=max.) */
export const RATE_CHOICES = ['1', '2', '4', '5', '10'];

/**
 * A rate for the browser: one of RATE_CHOICES, else the default. A saved 'max' from older
 * versions therefore becomes 4/s.
 * @param {string | null | undefined} text
 * @returns {number}
 */
export function uiRate(text) {
  if (text != null && RATE_CHOICES.includes(text)) {
    return Number(text);
  }
  return DEFAULT_SETTINGS.rate;
}

/**
 * Parse a rate like "5" or "max".
 * @param {string | null | undefined} text
 * @returns {number | null}  null when not a valid rate
 */
export function parseRate(text) {
  if (text == null || text === '') {
    return null;
  }
  if (text === 'max') {
    return Infinity;
  }
  const rate = Number(text);
  return rate > 0 ? rate : null;
}

/** @param {number} rate */
export function rateLabel(rate) {
  return rate === Infinity ? 'max' : String(rate);
}

/**
 * Read "1"/"0"/"true"/"false"/"on"/"off" style flags.
 * @param {string | null | undefined} text @param {boolean} fallback
 */
export function parseFlag(text, fallback) {
  if (text == null || text === '') {
    return fallback;
  }
  return !['0', 'false', 'off', 'no'].includes(String(text).toLowerCase());
}


/**
 * Pilot settings from flags. `read(name)` returns the text of one flag (env var or URL parameter)
 * or null. Group flags first, then single ones, so LATENCY_COMP=0 PREDICT=1 keeps prediction:
 *   ASSISTS=0 (all off) · LATENCY_COMP=0 (predict + stale discard) · IMPULSE_LIMITS=0 (lease + climb guard + touchdown level)
 * @param {(name: string) => string | null | undefined} read
 * @param {Record<string, string>} [names]  flag names per assist key (default: the env names)
 * @returns {Partial<PilotSettings>}
 */
export function settingsFromFlags(read, names = {}) {
  /** @type {Record<string, boolean>} */
  const flags = {};
  for (const assist of ASSISTS) {
    flags[assist.key] = DEFAULT_SETTINGS[assist.key];
  }
  if (read(names.all || 'ASSISTS') != null && read(names.all || 'ASSISTS') !== '') {
    const allOn = parseFlag(read(names.all || 'ASSISTS'), true);
    for (const assist of ASSISTS) {
      flags[assist.key] = allOn;
    }
  }
  const latencyGroup = read(names.latencyComp || 'LATENCY_COMP');
  if (latencyGroup != null && latencyGroup !== '') {
    flags.predict = parseFlag(latencyGroup, true);
    flags.discardStale = parseFlag(latencyGroup, true);
  }
  const impulseGroup = read(names.impulseLimits || 'IMPULSE_LIMITS');
  if (impulseGroup != null && impulseGroup !== '') {
    flags.lease = parseFlag(impulseGroup, true);
    flags.climbGuard = parseFlag(impulseGroup, true);
    flags.touchdownLevel = parseFlag(impulseGroup, true);
  }
  for (const assist of ASSISTS) {
    const name = names[assist.key] || assist.env;
    flags[assist.key] = parseFlag(read(name), flags[assist.key]);
  }
  return flags;
}

/** @param {number | boolean} thrust */
function throttleOf(thrust) {
  if (thrust === true) {
    return 1;
  }
  return Number(thrust) || 0;
}

/**
 * Propagate a copy of the ship forward with fixed controls (for latency compensation).
 * A predicted touchdown is not reported: the copy is returned as it was just before.
 * @param {Ship} ship @param {number} horizon s @param {number} throttle @param {Tilt} tilt
 * @param {number} tiltRate
 * @returns {Ship}
 */
export function predictShip(ship, horizon, throttle, tilt, tiltRate) {
  let predicted = { ...ship };
  const frame = 1 / 60;
  for (let elapsed = 0; elapsed < horizon; elapsed += frame) {
    const next = step({ ...predicted }, Math.min(frame, horizon - elapsed), throttle, tilt, tiltRate);
    if (next.outcome) {
      break;
    }
    predicted = next;
  }
  return predicted;
}

/**
 * One reply waiting to come back.
 * @typedef {{ id: number, sentT: number, predictedFor: number }} PendingCall
 */


/**
 * Create a pilot loop for one flight.
 * @param {Partial<PilotSettings>} [overrides]
 */
export function createPilotLoop(overrides = {}) {
  /** @type {PilotSettings} */
  const settings = { ...DEFAULT_SETTINGS, ...overrides };

  // Targets come from the model; controls are what the engine actually does.
  const targets = { throttle: 0, tilt: /** @type {Tilt} */ ('center'), throttleUntil: 0 };
  const controls = { throttle: 0 };

  const stats = {
    sent: 0,
    applied: 0,
    discarded: 0,
    firstSentT: /** @type {number | null} */ (null),
    lastSentT: -Infinity,
    lastAppliedT: /** @type {number | null} */ (null),
    lastAge: 0,
    /** Smoothed reply age, sim s (used as the prediction horizon). */
    averageAge: 0,
    /** The throttle lease has run out and lowered the throttle right now (for the HUD). */
    leaseExpired: false,
    climbGuardActive: false,
    /** Touchdown leveling is overriding a non-center tilt target right now. */
    levelling: false,
    // Engagement counters: an event = the assist starts changing the controls; seconds = how long it did.
    leaseEvents: 0,
    leaseSeconds: 0,
    climbGuardEvents: 0,
    climbGuardSeconds: 0,
    levelEvents: 0,
    levelSeconds: 0,
  };

  /** @type {PendingCall | null} */
  let pending = null;
  let nextId = 0;

  /** How long one throttle target stays valid. */
  function leaseLength() {
    const interval = settings.rate === Infinity ? 0 : 1 / settings.rate;
    return Math.max(interval, settings.leaseMin);
  }

  /** May a new call be sent now? @param {Ship} ship */
  function shouldSend(ship) {
    if (pending || ship.outcome) {
      return false;
    }
    const interval = settings.rate === Infinity ? 0 : 1 / settings.rate;
    return ship.t - stats.lastSentT >= interval - 1e-9;
  }

  /**
   * Record a send and return the ship state to put in the request.
   * @param {Ship} ship
   * @returns {{ call: PendingCall, requestShip: Ship }}
   */
  function send(ship) {
    nextId = nextId + 1;
    const horizon = settings.predict ? stats.averageAge : 0;
    let requestShip = ship;
    if (horizon > 0) {
      requestShip = predictShip(ship, horizon, controls.throttle, targets.tilt, currentTiltRate());
    }
    pending = { id: nextId, sentT: ship.t, predictedFor: horizon };
    stats.sent = stats.sent + 1;
    stats.firstSentT ??= ship.t;
    stats.lastSentT = ship.t;
    return { call: pending, requestShip };
  }

  /**
   * A reply arrived. Returns 'applied' or 'discarded' (too old).
   * @param {PendingCall} call
   * @param {{ thrust: number | boolean, tilt: Tilt, pad?: { target: string, t: number, confidence: number } | null }} decision
   * @param {Ship} ship
   * @returns {'applied' | 'discarded' | 'ignored'}
   */
  function receive(call, decision, ship) {
    if (!pending || call.id !== pending.id) {
      return 'ignored';
    }
    pending = null;
    // A new landing-pad choice applies even if the controls in this reply are too old.
    if (decision.pad) {
      ship.target = decision.pad.target;
      ship.targetT = decision.pad.t;
      ship.targetP = decision.pad.confidence;
    }
    const age = ship.t - call.sentT;
    stats.lastAge = age;
    // Smooth the age so one slow reply does not swing the prediction horizon.
    stats.averageAge = stats.applied + stats.discarded === 0 ? age : 0.7 * stats.averageAge + 0.3 * age;
    // Discard a too-old reply only while a recent target is still in force. When every reply is
    // slow (cold model, slow host), an old answer is better than flying blind.
    const haveRecentTarget =
      stats.lastAppliedT != null && ship.t - stats.lastAppliedT <= settings.maxAge;
    if (settings.discardStale && age > settings.maxAge && haveRecentTarget) {
      stats.discarded = stats.discarded + 1;
      return 'discarded';
    }
    targets.throttle = throttleOf(decision.thrust);
    targets.tilt = decision.tilt;
    targets.throttleUntil = ship.t + leaseLength();
    stats.applied = stats.applied + 1;
    stats.lastAppliedT = ship.t;
    return 'applied';
  }

  /** A call failed or was dropped (reset, error): free the slot. */
  function abandon() {
    pending = null;
  }

  function currentTiltRate() {
    return settings.smoothing ? settings.tiltRate : 2.0;
  }

  /**
   * The throttle the engine should aim for right now, after the lease and the climb guard.
   * @param {Ship} ship @param {number} timeStep
   */
  function limitedTargetThrottle(ship, timeStep) {
    let throttle = targets.throttle;
    const wasLeaseExpired = stats.leaseExpired;
    const wasClimbGuardActive = stats.climbGuardActive;
    stats.leaseExpired = false;
    stats.climbGuardActive = false;
    // Lease: an old burn command does not stay valid while we wait for a reply.
    if (settings.lease && ship.t > targets.throttleUntil && throttle > 0) {
      const leased = ship.vy > 0 ? 0 : Math.min(throttle, HOVER_THROTTLE);
      if (leased < throttle) {
        stats.leaseExpired = true;
        throttle = leased;
      }
    }
    // Climb guard: once rising faster than climbLimit, cap below hover so the ship slows its climb.
    if (settings.climbGuard && ship.vy > settings.climbLimit && throttle > HOVER_THROTTLE * 0.5) {
      stats.climbGuardActive = true;
      throttle = HOVER_THROTTLE * 0.5;
    }
    countEngagement('lease', stats.leaseExpired, wasLeaseExpired, timeStep);
    countEngagement('climbGuard', stats.climbGuardActive, wasClimbGuardActive, timeStep);
    return throttle;
  }

  /**
   * Add to an assist's event and seconds counters.
   * @param {'lease' | 'climbGuard' | 'level'} name @param {boolean} active @param {boolean} wasActive
   * @param {number} timeStep
   */
  function countEngagement(name, active, wasActive, timeStep) {
    if (!active) {
      return;
    }
    if (!wasActive) {
      stats[`${name}Events`] = stats[`${name}Events`] + 1;
    }
    stats[`${name}Seconds`] = stats[`${name}Seconds`] + timeStep;
  }

  /**
   * The tilt to fly with: the target, or center when the ground is close below (touchdownLevel on).
   * @param {Ship} ship @param {number} timeStep
   * @returns {Tilt}
   */
  function touchdownTilt(ship, timeStep) {
    const wasLevelling = stats.levelling;
    const heightAboveGround = ship.y - terrainY(ship.x, padsFor(ship));
    const isNearGround = settings.touchdownLevel && heightAboveGround < settings.levelHeight;
    stats.levelling = isNearGround && targets.tilt !== 'center';
    countEngagement('level', stats.levelling, wasLevelling, timeStep);
    return isNearGround ? 'center' : targets.tilt;
  }

  /**
   * Advance the ship by one physics step with the current controls.
   * @param {Ship} ship @param {number} timeStep
   */
  function stepShip(ship, timeStep) {
    const target = limitedTargetThrottle(ship, timeStep);
    if (settings.smoothing && timeStep > 0) {
      const blend = 1 - Math.exp(-timeStep / settings.throttleTau);
      controls.throttle = controls.throttle + (target - controls.throttle) * blend;
      if (controls.throttle < 0.005 && target === 0) {
        controls.throttle = 0;
      }
    } else {
      controls.throttle = target;
    }
    const tilt = touchdownTilt(ship, timeStep);
    step(ship, timeStep, controls.throttle > 0 ? controls.throttle : false, tilt, currentTiltRate());
    return ship;
  }

  /** Waiting longer than maxAge for a reply (or none applied for that long). @param {Ship} ship */
  function isLate(ship) {
    if (pending && ship.t - pending.sentT > settings.maxAge) {
      return true;
    }
    return false;
  }

  /** Applied decisions per sim second since the first send. @param {Ship} ship */
  function actualRate(ship) {
    if (stats.firstSentT == null || ship.t - stats.firstSentT <= 0) {
      return 0;
    }
    return stats.applied / (ship.t - stats.firstSentT);
  }

  return {
    settings,
    targets,
    controls,
    stats,
    shouldSend,
    send,
    receive,
    abandon,
    stepShip,
    isLate,
    actualRate,
    get pending() {
      return pending;
    },
  };
}

/** @typedef {ReturnType<typeof createPilotLoop>} PilotLoop */
