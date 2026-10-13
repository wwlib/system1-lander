import '../env.mjs';
// Decision-quality eval: model answer vs rule oracle (features) on states sampled from oracle flights.
import { newState, step, modelState, payloadFor, ACTIONS } from '../sim.mjs';
const MODEL = process.env.MODEL || 'tev1:4b', V = process.env.V || 'one', N = +(process.env.N || 30);
const S = []; for (const st of [{ x: 40 }, { x: 135, vx: 2 }, { x: 80, vx: -3, y: 100 }, { x: 20, y: 140 }]) { const s = newState(st); let i = 0;
  while (!s.outcome) { const m = modelState(s); for (let t = 0; t < .5; t += 1 / 60) step(s, 1 / 60, m.engine === 'burn', m.steer === 'none' ? 'center' : m.steer); if (i++ % 6 == 0) S.push({ ...s }); } }
let okE = 0, okS = 0, lat = [], tok = 0; const bad = [];
for (const s of S.filter((_, i) => i % Math.ceil(S.length / N) == 0)) { const p = payloadFor(s, 'physics', V), t = performance.now();
  const j = await (await fetch((process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone', { method: 'POST', body: JSON.stringify({ model: MODEL, ...p, keep_alive: '30m' }) })).json(); lat.push(performance.now() - t); tok = j.usage?.input_tokens;
  let th, ti; if (j.answers.act) [th, ti] = ACTIONS[j.answers.act.choice] || [false, 'center']; else { th = j.answers.thrust.noul > .5; ti = j.answers.tilt.choice; }
  const m = modelState(s), eE = th === (m.engine === 'burn'), eS = ti === (m.steer === 'none' ? 'center' : m.steer); okE += eE; okS += eS;
  if (!(eE && eS) && bad.length < 6) bad.push({ st: p.state, model: [th ? 'burn' : 'coast', ti], oracle: [m.engine, m.steer] }); }
const n = lat.length; console.log(MODEL, V, `n=${n} engine ${okE}/${n} steer ${okS}/${n} avg ${(lat.reduce((a, b) => a + b) / n) | 0}ms tokens ${tok}`); bad.forEach(b => console.log(JSON.stringify(b)));
