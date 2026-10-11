import '../../env.mjs';
const MODEL = process.env.MODEL || 'tev1:4b'; let seed = 9; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const T = (dx, vx) => Math.abs(vx) > Math.min(Math.abs(dx) / 8, 3);
const QS = {
  div8: { type: 'noul', instructions: 'Is sideways_speed_mps greater than pad_distance_m divided by 8, or greater than 3?', criteria: { true: 'yes, too fast for the distance', false: 'no' } },
  mul8: { type: 'noul', instructions: 'Multiply sideways_speed_mps by 8. Is the result bigger than pad_distance_m, or is sideways_speed_mps above 3?', criteria: { true: 'yes', false: 'no' } },
  choice: { type: 'choice', instructions: 'Rule: safe sideways speed is pad_distance_m/8, never more than 3. Compare sideways_speed_mps to it.', criteria: { too_fast: 'sideways_speed_mps is above the safe speed', ok_or_slow: 'sideways_speed_mps is at or below the safe speed' } },
  table: { type: 'choice', instructions: 'Safe sideways speed by pad_distance_m: 24 m or more → 3; 16 → 2; 8 → 1; 0 → 0 (interpolate). Compare sideways_speed_mps to the safe speed.', criteria: { too_fast: 'sideways_speed_mps is above the safe speed', ok_or_slow: 'sideways_speed_mps is at or below the safe speed' } },
};
const acc = {}, lat = {}; for (const k in QS) acc[k] = lat[k] = 0; let n = 0;
for (let i = 0; i < 24; i++) { const dx = Math.round((rnd() * 2 - 1) * 600) / 10 || 5, vx = Math.round((rnd() * 2 - 1) * 60) / 10 || 1, lim = Math.min(Math.abs(dx) / 8, 3);
  if (Math.abs(Math.abs(vx) - lim) < 0.5) continue; n++;
  for (const [k, q] of Object.entries(QS)) { const st = { pad_distance_m: Math.abs(dx), sideways_speed_mps: Math.abs(vx) }, t = performance.now();
    const j = await (await fetch((process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone', { method: 'POST', body: JSON.stringify({ model: MODEL, state: st, questions: { q }, keep_alive: '30m' }) })).json(); lat[k] += performance.now() - t;
    const a = j.answers.q, v = q.type === 'noul' ? a.noul > .5 : a.choice === 'too_fast'; acc[k] += v === T(dx, vx); } }
for (const k in acc) lat[k] = (lat[k] / n) | 0; console.log(MODEL, 'n=' + n, 'acc', JSON.stringify(acc), 'ms', JSON.stringify(lat));
