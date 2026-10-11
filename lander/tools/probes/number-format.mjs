import '../../env.mjs';
const H = (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone';
const forms = {
  plain: T => ({ type: 'noul', instructions: `Is fall_speed_mps greater than ${T}?`, criteria: { true: `greater than ${T}`, false: 'not greater' } }),
  orig: T => ({ type: 'noul', instructions: `Is fall_speed_mps greater than ${T}?`, criteria: { true: `greater than ${T}`, false: `${T} or less` } }),
  dec: T => ({ type: 'noul', instructions: `Is fall_speed_mps greater than ${T}.0?`, criteria: { true: `fall_speed_mps > ${T}.0`, false: `fall_speed_mps ≤ ${T}.0` } }),
};
for (const [f, Q] of Object.entries(forms)) { let ok = 0, n = 0; const bad = [];
  for (const T of [1, 2, 3, 5, 7]) for (const v of [0.4, 1.5, 2.6, 3.8, 4, 5.5, 6.2, 8.1]) { if (Math.abs(v - T) < 0.3) continue; n++;
    const j = await (await fetch(H, { method: 'POST', body: JSON.stringify({ model: 'tev1:4b', state: { fall_speed_mps: v }, questions: { q: Q(T) }, keep_alive: '30m' }) })).json();
    const a = j.answers.q.noul > .5; if (a === v > T) ok++; else bad.push(`${v}>${T}?${a}`); }
  console.log(f, `${ok}/${n}`, bad.join(' ')); }
