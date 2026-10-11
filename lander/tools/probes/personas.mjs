import '../../env.mjs';
import { PERSONAS } from '../../sim.mjs';
const H = (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone';
const Q = {
  hi: { type: 'choice', instructions: 'How fast are you willing to fall while still high up (above 20 m)?', criteria: { '3': '3 m/s, slow and safe', '5': '5 m/s, normal', '7': '7 m/s, fast and daring' } },
  lo: { type: 'choice', instructions: 'How fast are you willing to fall in the last 20 m before touchdown? (above 4 m/s at touchdown is a crash)', criteria: { '1': '1 m/s, very gentle', '2': '2 m/s, normal', '3': '3 m/s, hard and daring' } },
  side: { type: 'choice', instructions: 'How fast are you willing to move sideways toward the pad?', criteria: { '2': '2 m/s, cautious', '3': '3 m/s, normal', '4': '4 m/s, aggressive' } },
};
for (const [p, txt] of Object.entries(PERSONAS)) { const out = {};
  for (const [k, q] of Object.entries(Q)) { const j = await (await fetch(H, { method: 'POST', body: JSON.stringify({ model: 'tev1:4b', state: { personality: txt }, questions: { q }, keep_alive: '30m' }) })).json();
    out[k] = j.answers.q.choice + ' ' + JSON.stringify(Object.fromEntries(Object.entries(j.answers.q.probabilities).map(([a, b]) => [a, +b.toFixed(2)]))); }
  console.log(p.padEnd(10), JSON.stringify(out)); }
