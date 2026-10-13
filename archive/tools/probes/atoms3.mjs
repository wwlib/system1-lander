import '../../env.mjs';
const H = (process.env.OLLAMA_URL || 'http://localhost:11434'); let seed = 21; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const P = {
  plus8: { type: 'noul', instructions: 'Is (sideways_speed_mps times 8) plus 8 less than pad_distance_m?', criteria: { true: 'yes, less', false: 'no' } },
  dist_more: { type: 'noul', instructions: 'Is pad_distance_m more than 8 times (sideways_speed_mps + 1)?', criteria: { true: 'yes, pad_distance_m is more', false: 'no' } },
  x8_lt: { type: 'noul', instructions: 'Is sideways_speed_mps times 8 less than pad_distance_m? (only yes if clearly less, by 8 or more)', criteria: { true: 'clearly less', false: 'not clearly less' } },
};
for (const [k, q] of Object.entries(P)) { let ok = 0; const N = 24; seed = 21;
  for (let i = 0; i < N; i++) { const sp = Math.round(rnd() * 25) / 10, d = Math.round(rnd() * 600) / 10;
    const j = await (await fetch(H + '/v1/systemone', { method: 'POST', body: JSON.stringify({ model: 'tev1:4b', state: { sideways_speed_mps: sp, pad_distance_m: d }, questions: { q }, keep_alive: '30m' }) })).json();
    ok += (j.answers.q.noul > .5) === (sp * 8 + 8 < d); }
  console.log(k, `${ok}/${N}`); }
