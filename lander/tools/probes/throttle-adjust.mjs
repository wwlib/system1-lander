import '../../env.mjs';
// Does the model adjust throttle relative to the LAST command? Synthetic states in 3 descent situations × 4 last-throttle levels × 3 positions.
// Counts whether the chosen level steps up / stays / steps down vs the last one. Expect: too fast → up (or stay at high), slow → down.
import { newState, scenePayload, sceneRead, perceive } from '../../sim.mjs';
const URL = (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone', MODEL = process.env.MODEL || 'tev1:4b';
const VS = (process.env.V || 'scene_s4tp,scene_s4tpr,scene_s1tp').split(','), R = { off: 0, low: 1, medium: 2, high: 3 };
const SIT = { too_fast: { y: 50, vy: -8 }, about_right: { y: 50, vy: -4.5 }, slow: { y: 50, vy: -0.6 } };
for (const V of VS) { console.log(`== ${MODEL} ${V}`);
  for (const [name, o] of Object.entries(SIT)) { const row = {};
    for (const last of ['off', 'low', 'medium', 'high']) { let up = 0, same = 0, down = 0; const picks = [];
      for (const x of [60, 128, 175]) { const s = newState({ x, y: o.y + 10, vx: 0 }); s.vy = o.vy;
        const p = scenePayload(s, V, [], false, { throttle: last, tilt: 'center' });
        const j = await (await fetch(URL, { method: 'POST', body: JSON.stringify({ model: MODEL, ...p, keep_alive: '30m' }) })).json();
        const r = sceneRead(V, j.answers || {}), d = R[r.throttle] - R[last]; picks.push(r.throttle); d > 0 ? up++ : d < 0 ? down++ : same++; }
      row[last] = `${picks.join('/')} (↑${up} =${same} ↓${down})`; }
    console.log(`  ${name.padEnd(12)} ${Object.entries(row).map(([k, v]) => `last ${k}: ${v}`).join(' | ')}`); } }
console.log('impression for too_fast:', perceive(Object.assign(newState({ x: 60, y: 60 }), { vy: -8 })).split('.')[0]);
