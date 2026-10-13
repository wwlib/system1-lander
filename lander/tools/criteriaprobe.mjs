import '../env.mjs';
// Probe a criteria set (CRIT=user-v1) on prose perception sentences. MODELS=nimble:9b,tev1:4b
import { criteriaSet, padSentence, altSentence, driftSentence } from '../criteria.mjs';
const set = criteriaSet(process.env.CRIT || 'user-v1'), Q = set.questions, URL0 = (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone';
const models = (process.env.MODELS || 'nimble:9b,tev1:4b').split(',');
const ask = async (model, state, questions) => { const t0 = performance.now(); const r = await fetch(URL0, { method: 'POST', body: JSON.stringify({ model, state, questions, keep_alive: '2h' }) }); const j = await r.json(); return { ms: performance.now() - t0, A: j.answers, tok: j.usage?.input_tokens }; };
const padCases = []; for (const [d, b] of [[0, 'directly below'], [8, 'very near'], [25, 'near'], [60, 'far'], [120, 'way in the distance']]) for (const side of d ? [1, -1] : [1])
  padCases.push({ s: padSentence(side * d), dir: d ? (side > 0 ? 'right' : 'left') : 'none', vel: { 'directly below': ['none'], 'very near': ['very_slow'], near: ['slow'], far: ['fast'], 'way in the distance': ['fast'] }[b] });
const altCases = []; for (const [alt, a] of [[100, 'high'], [40, 'medium'], [15, 'low'], [2, 'touch']]) for (const [vy, f] of [[0.5, 'rising'], [-0.5, 'vslow'], [-2, 'slow'], [-4.5, 'fast'], [-9, 'vfast']]) {
  const exp = f === 'rising' ? ['none'] : a === 'high' ? (f === 'vfast' ? ['medium', 'large'] : ['small', 'none']) : a === 'medium' ? (f === 'vfast' ? ['large', 'medium'] : f === 'fast' ? ['medium', 'small'] : ['small']) : (f === 'vfast' || f === 'fast') ? ['large'] : f === 'slow' ? ['medium'] : ['small', 'medium'];
  altCases.push({ s: altSentence(alt, vy), exp }); }
const driftCases = [-4, -2, -0.8, 0, 0.8, 2, 4].map(vx => ({ s: padSentence(25) + ' ' + driftSentence(vx), dir: 'right' }));
const thrQ = Object.fromEntries(Object.entries(Q).filter(([k]) => /thrust/.test(k))), horQ = Object.fromEntries(Object.entries(Q).filter(([k]) => !/thrust/.test(k)));
for (const m of models) { await ask(m, 'warm up', thrQ); let ms = [], ok = { dir: 0, vel: 0, thr: 0 };
  console.log(`== ${m}  criteria=${process.env.CRIT || 'user-v1'}`);
  for (const c of padCases) { const r = await ask(m, c.s, horQ); ms.push(r.ms); const d = r.A.flight_direction, v = r.A.flight_velocity; ok.dir += d.choice === c.dir; ok.vel += c.vel.includes(v.choice);
    console.log(`${d.choice === c.dir ? '✓' : '✗'}${c.vel.includes(v.choice) ? '✓' : '✗'} ${c.s.padEnd(48)} dir=${d.choice} ${(d.probabilities[d.choice]).toFixed(2)} vel=${v.choice} ${(v.probabilities[v.choice]).toFixed(2)} (want ${c.dir}/${c.vel}) ${r.ms.toFixed(0)}ms`); }
  for (const c of altCases) { const r = await ask(m, c.s, thrQ); ms.push(r.ms); const t = r.A.downward_thrust_magnitude; ok.thr += c.exp.includes(t.choice);
    console.log(`${c.exp.includes(t.choice) ? '✓' : '✗'} ${c.s.padEnd(70)} thrust=${t.choice} ${Object.entries(t.probabilities).map(([k, p]) => k + ':' + p.toFixed(2)).join(' ')} (want ${c.exp}) ${r.ms.toFixed(0)}ms`); }
  for (const c of driftCases) { const r = await ask(m, c.s, horQ); ms.push(r.ms); console.log(`  drift: ${c.s.padEnd(80)} dir=${r.A.flight_direction.choice} vel=${r.A.flight_velocity.choice}`); }
  const s = [...ms].sort((a, b) => a - b);
  console.log(`SUMMARY ${m}: direction ${ok.dir}/${padCases.length}, velocity ${ok.vel}/${padCases.length}, thrust ${ok.thr}/${altCases.length}, median ${s[s.length >> 1].toFixed(0)} ms`); }
