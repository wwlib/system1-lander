import '../env.mjs';
// Simulates async decisions: physics at 60fps, decision applied after its real latency.
// env: MODE=physics|hints VARIANT=two|one|one_q MODEL=tev1:4b BAD=1 (print decisions that disagree with the rule oracle)
import { newState, step, modelState, physicsState } from '../sim.mjs'; import { decide } from '../server.mjs';
let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const starts = [{ x: 40 }, { x: 135, vx: 2 }, { x: 80, vx: -3, y: 100 }, { x: 20, y: 140 }];
for (let i = 0; i < +(process.env.EXTRA || 0); i++) starts.push({ x: Math.round(20 + rnd() * 80), vx: Math.round((rnd() - .5) * 40) / 10 });
const TS = +(process.env.TIME_SCALE || 1); // <1 = slower sim per real second of model latency
const scores = [], all = [], bad = [], climbs = [], rises = [], fuels = []; let agree = 0, tok = 0, landed = 0;
const opt = { mode: process.env.MODE || 'physics', variant: process.env.VARIANT, model: process.env.MODEL, persona: process.env.PERSONA, host: process.env.OLLAMA_HOST_KEY || 'primary' };
for (const st of starts) {
  const s = newState(st); let d = { thrust: false, tilt: 'center' }, lat = [], appliedT = 0; const y0 = s.y; let maxY = s.y, riseT = 0;
  while (!s.outcome) { if (s.t > +(process.env.MAX_T || 120)) { s.outcome = 'crash (timeout: still flying after ' + (process.env.MAX_T || 120) + ' s sim)'; break; }
    const r = await decide({ ...s }, opt); lat.push(r.ms); tok = r.usage?.input_tokens;
    const o = modelState(s), ot = o.steer === 'none' ? 'center' : o.steer, ok = !!r.thrust === (o.engine === 'burn') && r.tilt === ot; agree += ok;
    if (!ok) bad.push({ t: +s.t.toFixed(1), sent: physicsState(s), model: r.action, rule: (o.engine === 'burn' ? 'burn_' : 'coast_') + ot });
    for (let t = 0; t < TS * r.ms / 1000 && !s.outcome; t += 1 / 60) { step(s, 1 / 60, (d.pulse == null || s.t - appliedT < d.pulse) ? d.thrust : false, d.tilt); maxY = Math.max(maxY, s.y); if (s.vy > 0) riseT += 1 / 60; } // old decision during latency; burn pulse if set
    d = r; appliedT = s.t;
  }
  all.push(...lat); landed += s.outcome === 'LANDED';
  scores.push(s.score ?? 0);
  console.log(JSON.stringify(st), '->', s.outcome, `score=${(s.score ?? 0).toFixed(1)}${s.outcome === 'LANDED' ? ' ' + JSON.stringify(s.scoreBreakdown) : ''}`, `t=${s.t.toFixed(1)}s fuel=${s.fuel.toFixed(0)} decisions=${lat.length} avg=${(lat.reduce((a, b) => a + b, 0) / lat.length).toFixed(0)}ms climb=${(maxY - y0).toFixed(1)}m rising=${riseT.toFixed(1)}s`); climbs.push(maxY - y0); rises.push(riseT); fuels.push(s.fuel);
}
if (process.env.BAD) bad.filter((_, i) => i % Math.max(1, (bad.length / 6) | 0) == 0).slice(0, 6).forEach(b => console.log('  bad', JSON.stringify(b)));
console.log(`SUMMARY [${opt.host}] ${opt.model || 'tev1:4b'} ${opt.mode}/${opt.variant || '-'}${opt.persona ? '/' + opt.persona : ''}: TS=${TS} landed ${landed}/${starts.length}, avg latency ${(all.reduce((a, b) => a + b, 0) / all.length).toFixed(0)} ms, n=${all.length}, input_tokens ${tok}, agree-with-rules ${(100 * agree / all.length).toFixed(0)}%, avg climb ${(climbs.reduce((a, b) => a + b) / climbs.length).toFixed(1)}m, avg rising ${(rises.reduce((a, b) => a + b) / rises.length).toFixed(1)}s, avg score ${(scores.reduce((a, b) => a + b) / scores.length).toFixed(2)}, avg fuel left ${(fuels.reduce((a, b) => a + b) / fuels.length).toFixed(0)}%`);
