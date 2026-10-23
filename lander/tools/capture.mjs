// @ts-check
// Capture one real /v1/systemone call (prose mode) with the current defaults, for the README.
// Usage: SEED=1 node lander/tools/capture.mjs > results/capture.json
import '../env.mjs';
import { newState, randomStart } from '../sim.mjs';
import { decide, DEFAULTS } from '../server.mjs';

const seed = Number(process.env.SEED || 1);
const ship = newState(randomStart(seed));
const options = {
  variant: 'prose',
  model: process.env.MODEL || DEFAULTS.model,
  host: process.env.PROVIDER || DEFAULTS.host,
};
const decision = await decide(ship, options);
const output = {
  url: decision.upstream?.url,
  request: decision.upstream?.request,
  response: decision.upstream?.response,
  mapped: {
    throttle: decision.throttle,
    tilt: decision.tilt,
    tvx: decision.tvx,
    action: decision.action,
    gated: decision.gated,
  },
  ms: decision.ms,
};
console.log(JSON.stringify(output, null, 2));
