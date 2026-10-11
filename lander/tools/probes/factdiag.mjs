import '../../env.mjs';
import { STEER } from '../steervars.mjs';
const MODEL = process.env.MODEL || 'tev1:4b'; let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const Q = STEER.facts.questions, st = STEER.facts.state; const acc = { approaching: 0, too_fast: 0, too_slow: 0 }; let n = 0;
for (let i = 0; i < 24; i++) { const dx = Math.round((rnd() * 2 - 1) * 1100) / 10, vx = Math.round((rnd() * 2 - 1) * 60) / 10, s = st(dx, vx);
  const lim = Math.min(Math.abs(dx) / 8, 3), truth = { approaching: Math.sign(vx) === Math.sign(dx) && vx !== 0, too_fast: Math.abs(vx) > lim, too_slow: Math.abs(vx) < lim - 0.3 };
  const j = await (await fetch((process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone', { method: 'POST', body: JSON.stringify({ model: MODEL, state: s, questions: Q, keep_alive: '30m' }) })).json(); n++;
  for (const k in acc) acc[k] += (j.answers[k].noul > .5) === truth[k]; }
console.log(MODEL, 'fact accuracy n=' + n, JSON.stringify(acc));
