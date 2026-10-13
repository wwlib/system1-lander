import '../env.mjs';
// Offline: steering on the same 30-state set as steerq.mjs + thrust accuracy on 20 states, for variant multi.
import { decide } from '../server.mjs'; import { oracleSteer } from './steervars.mjs'; import { PAD } from '../sim.mjs';
const model = process.env.MODEL || 'tev1:4b', padC = (PAD.x0 + PAD.x1) / 2;
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const S = []; while (S.length < 30) { const dx = Math.round((rnd() * 2 - 1) * 110 * 10) / 10, vx = Math.round((rnd() * 2 - 1) * 6 * 10) / 10;
  const o = oracleSteer(dx, vx), want = Math.sign(dx) * Math.min(Math.abs(dx) / 8, 3), e = Math.abs(vx - want);
  if (o !== 'center' && e < 0.8) continue; if (o === 'center' && S.filter(s => s.o === 'center').length >= 6) continue; S.push({ dx, vx, o }); }
let ok = 0, okDir = 0, nDir = 0, ms = 0, tok = 0, n = 0; const bad = [];
for (const t of S) { const d = await decide({ x: padC - t.dx, y: 60, vx: t.vx, vy: -3, fuel: 90, angle: 0, t: 0 }, { mode: 'physics', variant: 'multi', model, host: process.env.OLLAMA_HOST_KEY || 'primary' }); n++; ms += d.ms; tok += d.usage.input_tokens;
  ok += d.tilt === t.o; if (t.o !== 'center') { nDir++; okDir += d.tilt === t.o; } if (d.tilt !== t.o && bad.length < 3) bad.push(`dx=${t.dx} vx=${t.vx} model=${d.tilt} want=${t.o} ans=${JSON.stringify(Object.fromEntries(Object.entries(d.answers).filter(([k]) => !k.endsWith('_p'))))}`); }
let okT = 0; const badT = []; for (let i = 0; i < 20; i++) { const alt = Math.round(5 + rnd() * 110), vy = Math.round((-rnd() * 12 + 1.5) * 10) / 10, safe = alt < 10 ? 1 : Math.min(alt / 10, 5), truth = -vy > safe;
  const d = await decide({ x: 100, y: alt + PAD.y, vx: 0, vy, fuel: 90, angle: 0, t: 0 }, { mode: 'physics', variant: 'multi', model, host: process.env.OLLAMA_HOST_KEY || 'primary' }); okT += d.thrust === truth; if (d.thrust !== truth && badT.length < 3) badT.push(`alt=${alt} vy=${vy} model=${d.thrust} want=${truth}`); }
console.log(`${model} multi: steer ${ok}/30 (dir-only ${okDir}/${nDir}), thrust ${okT}/20, avg ${(ms / n) | 0} ms/decision, ${(tok / n) | 0} input tokens/decision`); bad.forEach(b => console.log('  bad', b)); badT.forEach(b => console.log('  badT', b));
