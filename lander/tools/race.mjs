import '../env.mjs';
// Race: player (multi2) and rival (personality) fly at the same time; both decide concurrently against one Ollama host (it serializes),
// so each ship's latency includes waiting behind the other's sub-calls. Each ship advances by its own decision latency (1x).
import { newState, step } from '../sim.mjs'; import { decide } from '../server.mjs';
const host = process.env.OLLAMA_HOST_KEY || 'primary', persona = process.env.PERSONA || 'careful';
const pairs = [[{ x: 40 }, { x: 230 - 40 }], [{ x: 75 }, { x: 195 }], [{ x: 40, y: 150 }, { x: 20, y: 150 }], [{ x: 60, vx: 1 }, { x: 180, vx: -1 }]];
async function fly(st, opt) { const s = newState(st); let d = { thrust: false, tilt: 'center' }, lat = [], appliedT = 0;
  while (!s.outcome) { const r = await decide({ ...s }, opt); lat.push(r.ms);
    for (let t = 0; t < r.ms / 1000 && !s.outcome; t += 1 / 60) step(s, 1 / 60, d.thrust && (d.pulse == null || s.t - appliedT < d.pulse), d.tilt); d = r; appliedT = s.t; }
  return { s, avg: lat.reduce((a, b) => a + b) / lat.length, n: lat.length }; }
const tot = { p: [], r: [] };
for (const [a, b] of pairs) { const [P, Rv] = await Promise.all([fly(a, { variant: 'multi2', host }), fly(b, { variant: 'rival', persona, host })]);
  tot.p.push(P); tot.r.push(Rv);
  const w = x => x.s.outcome === 'LANDED' ? `LANDED ${x.s.score.toFixed(1)} t=${x.s.t.toFixed(1)}` : x.s.outcome;
  const win = P.s.outcome === 'LANDED' && Rv.s.outcome === 'LANDED' ? (P.s.t <= Rv.s.t ? 'player' : 'rival') : P.s.outcome === 'LANDED' ? 'player' : Rv.s.outcome === 'LANDED' ? 'rival' : 'none';
  console.log(`player ${w(P)} avg ${P.avg | 0}ms | rival(${persona}) ${w(Rv)} avg ${Rv.avg | 0}ms | winner ${win}`); }
const sm = L => `landed ${L.filter(x => x.s.outcome === 'LANDED').length}/${L.length}, avg score ${(L.reduce((a, x) => a + (x.s.score ?? 0), 0) / L.length).toFixed(2)}, avg latency ${(L.reduce((a, x) => a + x.avg, 0) / L.length) | 0} ms`;
console.log(`RACE SUMMARY vs ${persona}: player ${sm(tot.p)} | rival ${sm(tot.r)}`);
