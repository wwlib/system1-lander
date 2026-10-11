import '../env.mjs';
// Offline steering accuracy on a fixed, diverse set of 30 states. env MODEL, VARS=comma list
import { STEER, oracleSteer } from './steervars.mjs';
const MODEL = process.env.MODEL || 'tev1:4b', PADX = 135;
let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const S = []; while (S.length < 30) { const dx = Math.round((rnd() * 2 - 1) * 110 * 10) / 10, vx = Math.round((rnd() * 2 - 1) * 6 * 10) / 10;
  const o = oracleSteer(dx, vx), want = Math.sign(dx) * Math.min(Math.abs(dx) / 8, 3), e = Math.abs(vx - want);
  if (o !== 'center' && e < 0.8) continue; // skip borderline
  if (o === 'center' && S.filter(s => s.o === 'center').length >= 6) continue; S.push({ dx, vx, o }); }
if (S.filter(s => s.o === 'center').length < 4) for (const dx of [40, -16, 2, -60]) S.splice(0, 1, { dx, vx: Math.sign(dx) * Math.min(Math.abs(dx) / 8, 3), o: 'center' });
const out = [];
for (const name of (process.env.VARS || Object.keys(STEER).join(',')).split(',')) { const V = STEER[name]; let ok = 0, lat = 0, tok = 0; const cnt = {}, bad = [];
  for (const s of S) { const st = V.state(s.dx, s.vx, PADX - s.dx, PADX), t = performance.now();
    const j = await (await fetch((process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone', { method: 'POST', body: JSON.stringify({ model: MODEL, state: st, questions: V.questions, keep_alive: '30m' }) })).json();
    lat += performance.now() - t; tok = j.usage?.input_tokens; const d = V.decode(j.answers, s.dx); cnt[d] = (cnt[d] || 0) + 1;
    if (d === s.o) ok++; else if (bad.length < 3) bad.push(`${JSON.stringify(st)} model=${d} want=${s.o}`); }
  const line = `${MODEL} ${name}: steer ${ok}/${S.length} (${(100 * ok / S.length) | 0}%) avg ${(lat / S.length) | 0}ms tokens ${tok} picks ${JSON.stringify(cnt)}`;
  console.log(line); bad.forEach(b => console.log('   bad', b)); }
console.log('oracle dist', JSON.stringify(S.reduce((a, s) => (a[s.o] = (a[s.o] || 0) + 1, a), {})));
