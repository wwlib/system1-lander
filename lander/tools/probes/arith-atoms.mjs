import '../../env.mjs';
const MODEL = process.env.MODEL || 'tev1:4b'; let seed = 3; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647; const r1 = v => Math.round(v * 10) / 10;
const A = {
  spd_gt3: [x => ({ sideways_speed_mps: x.sp }), { type: 'noul', instructions: 'Is sideways_speed_mps greater than 3?', criteria: { true: 'greater than 3', false: '3 or less' } }, x => x.sp > 3],
  spd_x8: [x => ({ sideways_speed_mps: x.sp, pad_distance_m: x.d }), { type: 'noul', instructions: 'Is sideways_speed_mps times 8 greater than pad_distance_m?', criteria: { true: 'sideways_speed_mps × 8 > pad_distance_m', false: 'not greater' } }, x => x.sp * 8 > x.d],
  spd_div8: [x => ({ sideways_speed_mps: x.sp, pad_distance_m: x.d }), { type: 'noul', instructions: 'Is sideways_speed_mps greater than pad_distance_m divided by 8?', criteria: { true: 'greater', false: 'not greater' } }, x => x.sp > x.d / 8],
  fall_div10: [x => ({ alt_m: x.alt, fall_speed_mps: x.f }), { type: 'noul', instructions: 'Is fall_speed_mps greater than alt_m divided by 10?', criteria: { true: 'greater', false: 'not greater' } }, x => x.f > x.alt / 10],
  fall_gt5: [x => ({ fall_speed_mps: x.f }), { type: 'noul', instructions: 'Is fall_speed_mps greater than 5?', criteria: { true: 'greater than 5', false: '5 or less' } }, x => x.f > 5],
  fall_gt1: [x => ({ fall_speed_mps: x.f }), { type: 'noul', instructions: 'Is fall_speed_mps greater than 1?', criteria: { true: 'greater than 1', false: '1 or less' } }, x => x.f > 1],
  alt_lt3: [x => ({ alt_m: x.alt }), { type: 'noul', instructions: 'Is alt_m less than 3?', criteria: { true: 'less than 3', false: '3 or more' } }, x => x.alt < 3],
  alt_lt3_c: [x => ({ alt_m: x.alt }), { type: 'choice', instructions: 'How high is the lander?', criteria: { high: 'alt_m is 3 or more', touching_down: 'alt_m is less than 3' } }, x => x.alt < 3],
};
const acc = {}, ms = {}; for (const k in A) acc[k] = ms[k] = 0; const N = 20;
for (let i = 0; i < N; i++) { const x = { sp: r1(rnd() * 7), d: r1(rnd() * 100), alt: r1(i % 4 == 0 ? rnd() * 5 : rnd() * 110), f: r1(rnd() * 10) };
  for (const [k, [st, q, tr]] of Object.entries(A)) { const t = performance.now();
    const j = await (await fetch((process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone', { method: 'POST', body: JSON.stringify({ model: MODEL, state: st(x), questions: { q }, keep_alive: '30m' }) })).json(); ms[k] += performance.now() - t;
    const a = j.answers.q, v = q.type === 'noul' ? a.noul > .5 : a.choice === 'touching_down'; acc[k] += v === tr(x); } }
for (const k in A) console.log(MODEL, k.padEnd(11), `${acc[k]}/${N}`, `${(ms[k] / N) | 0}ms`);
