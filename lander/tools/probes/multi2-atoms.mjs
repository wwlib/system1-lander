import '../../env.mjs';
import { MULTI2 } from '../../sim.mjs';
const H = (process.env.OLLAMA_URL || 'http://localhost:11434'), MODEL = process.env.MODEL || 'tev1:4b'; let seed = 21; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const by = Object.fromEntries(MULTI2.map(m => [m.name, m]));
const truth = { rising: s => s.vy > 0, spd_lt2_5: s => Math.abs(s.vx) < 2.5, slow_x8: s => Math.abs(s.vx) * 8 < Math.abs(135 - s.x) - 8 };
for (const k of Object.keys(truth)) { let ok = 0, ms = 0; const N = 24, bad = [];
  for (let i = 0; i < N; i++) { const s = { x: 135 + (rnd() * 2 - 1) * 90, y: 20 + rnd() * 100, vx: Math.round((rnd() * 2 - 1) * 50) / 10, vy: Math.round((rnd() * 2 - 1) * 60) / 10 }, st = by[k].state(s), t = performance.now();
    const j = await (await fetch(H + '/v1/systemone', { method: 'POST', body: JSON.stringify({ model: MODEL, state: st, questions: { q: by[k].q }, keep_alive: '30m' }) })).json(); ms += performance.now() - t;
    const v = j.answers.q.noul > .5, tr = truth[k](s); ok += v === tr; if (v !== tr && bad.length < 2) bad.push(JSON.stringify(st) + ' model=' + v); }
  console.log(MODEL, k.padEnd(10), `${ok}/${N}`, `${(ms / N) | 0}ms`, bad.join(' | ')); }
