// Probe the ridge_in_the_way warning noul (prose-decomp2.json) on 12 cruise scenes. OLLAMA at localhost.
import fs from 'node:fs';
const q = JSON.parse(fs.readFileSync('lander/modes/prose-decomp2.json')).questions.ridge_in_the_way;
const T = { clear: 'The ground between you and the pad is clear.', below: 'There is a ridge ahead, just below your height.', higher: 'There is a ridge ahead, higher than you.' };
const pads = ['The pad is far off to your right, way in the distance. You are left of the pad.', 'The pad is close, just off to your left. You are right of the pad.'];
const alts = ['The lander is at high altitude and is descending fast.', 'The lander is near the ground (low altitude) and is descending slowly.'];
let ok = 0, n = 0;
for (const p of pads) for (const a of alts) for (const [k, t] of Object.entries(T)) {
  const r = await (await fetch('http://localhost:11434/v1/systemone', { method: 'POST', body: JSON.stringify({ model: 'tev1:4b', state: [p, a, t].join('\n'), questions: { q }, keep_alive: '2h' }) })).json();
  const v = r.answers.q.noul; const good = (v >= 0.5) === (k === 'higher'); ok += good; n++;
  console.log(good ? '✓' : '✗', v.toFixed(2), k, '|', p.slice(0, 30), a.slice(0, 40));
}
console.log(`ridge_in_the_way ${ok}/${n}`);
