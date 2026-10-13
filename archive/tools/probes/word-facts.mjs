import '../../env.mjs';
const MODEL = process.env.MODEL || 'tev1:4b'; let seed = 5; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const QS = {
  pad_right: [{ type: 'noul', instructions: 'Is the pad to the right of the lander?', criteria: { true: 'pad_side is right', false: 'pad_side is left' } }, (dx) => dx > 0],
  moving_right: [{ type: 'noul', instructions: 'Is the lander moving to the right?', criteria: { true: 'sideways_motion is right', false: 'sideways_motion is left' } }, (dx, vx) => vx > 0],
  same: [{ type: 'noul', instructions: 'Are pad_side and sideways_motion the same word?', criteria: { true: 'same word', false: 'different words' } }, (dx, vx) => Math.sign(dx) === Math.sign(vx)],
  same_choice: [{ type: 'choice', instructions: 'Compare pad_side and sideways_motion.', criteria: { same: 'pad_side and sideways_motion are the same direction', different: 'pad_side and sideways_motion are opposite directions' } }, (dx, vx) => Math.sign(dx) === Math.sign(vx)],
  faster: [{ type: 'noul', instructions: 'Is sideways_speed_mps bigger than good_speed_mps?', criteria: { true: 'sideways_speed_mps > good_speed_mps', false: 'sideways_speed_mps <= good_speed_mps' } }, (dx, vx) => Math.abs(vx) > Math.min(Math.abs(dx) / 8, 3), true],
};
const acc = {}; for (const k in QS) acc[k] = 0;
for (let i = 0; i < 20; i++) { const dx = Math.round((rnd() * 2 - 1) * 1100) / 10 || 5, vx = Math.round((rnd() * 2 - 1) * 60) / 10 || 1;
  for (const [k, [q, tf, gs]] of Object.entries(QS)) { const st = { pad_side: dx > 0 ? 'right' : 'left', pad_distance_m: Math.abs(dx), sideways_motion: vx > 0 ? 'right' : 'left', sideways_speed_mps: Math.abs(vx) };
    if (gs) st.good_speed_mps = Math.round(Math.min(Math.abs(dx) / 8, 3) * 10) / 10;
    const j = await (await fetch((process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone', { method: 'POST', body: JSON.stringify({ model: MODEL, state: st, questions: { q }, keep_alive: '30m' }) })).json();
    const a = j.answers.q, v = q.type === 'noul' ? a.noul > .5 : a.choice === 'same'; acc[k] += v === tf(dx, vx); } }
console.log(MODEL, 'n=20', JSON.stringify(acc));
