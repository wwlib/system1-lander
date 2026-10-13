import '../env.mjs';
// Fly the lander without a browser. Physics at 60 fps; each decision is applied after its real latency (× TIME_SCALE).
// env: VARIANT=prose|data|policy:<name> (default prose) MODEL=tev1:4b EXTRA=2 (add seeded random starts; 2 → 6 starts) MAX_T=120
import { newState, step, modelState } from '../sim.mjs'; import { decide, DEFAULTS } from '../server.mjs';
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const starts = [{ x: 40 }, { x: 135, vx: 2 }, { x: 80, vx: -3, y: 100 }, { x: 20, y: 140 }];
for (let i = 0; i < +(process.env.EXTRA || 0); i++) starts.push({ x: Math.round(20 + rnd() * 80), vx: Math.round((rnd() - .5) * 40) / 10 });
const TS = +(process.env.TIME_SCALE || 1), MAX_T = +(process.env.MAX_T || 120);
const opt = { variant: process.env.VARIANT || DEFAULTS.variant, model: process.env.MODEL || DEFAULTS.model, host: process.env.PROVIDER || DEFAULTS.host };
const all = [], scores = [], fuels = []; let agree = 0, nDec = 0, tok = 0, landed = 0;
for (const st of starts) {
  const s = newState(st); let d = { thrust: false, tilt: 'center' }, lat = [], maxFall = 0, thrSum = 0;
  while (!s.outcome) { if (s.t > MAX_T) { s.outcome = `crash (timeout: still flying after ${MAX_T} s sim)`; break; }
    const r = await decide({ ...s }, opt); lat.push(r.ms); tok = r.usage?.input_tokens; thrSum += +r.thrust || 0; nDec++;
    const o = modelState(s); agree += !!r.thrust === (o.engine === 'burn') && r.tilt === (o.steer === 'none' ? 'center' : o.steer);
    for (let t = 0; t < TS * r.ms / 1000 && !s.outcome; t += 1 / 60) { step(s, 1 / 60, d.thrust, d.tilt); maxFall = Math.max(maxFall, -s.vy); } // previous decision flies during latency
    d = r; }
  all.push(...lat); landed += s.outcome === 'LANDED'; scores.push(s.score ?? 0); fuels.push(s.fuel);
  console.log(JSON.stringify(st), '->', s.outcome, `score=${(s.score ?? 0).toFixed(1)}${s.outcome === 'LANDED' ? ' ' + JSON.stringify(s.scoreBreakdown) : ''}`, `t=${s.t.toFixed(1)}s fuel=${s.fuel.toFixed(0)} decisions=${lat.length} avg=${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(0)}ms maxfall=${maxFall.toFixed(1)} avgthr=${(thrSum / lat.length).toFixed(2)}`);
}
const avg = a => a.reduce((x, y) => x + y, 0) / a.length;
console.log(`SUMMARY [${opt.host}] ${opt.model} ${opt.variant}: TS=${TS} landed ${landed}/${starts.length}, avg latency ${avg(all).toFixed(0)} ms, n=${all.length}, input_tokens ${tok}, agree-with-rule-oracle ${(100 * agree / nDec).toFixed(0)}%, avg score ${avg(scores).toFixed(2)}, avg fuel left ${avg(fuels).toFixed(0)}%`);
