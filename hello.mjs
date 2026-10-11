// System-1 decision hello world: Ollama /v1/systemone (TypeSafe Jev-style API), no deps.
const HOST = process.env.OLLAMA_URL || process.env.OLLAMA_HOST_URL || 'http://localhost:11434';
const MODEL = process.env.MODEL || 'tev1:0.8b';
const RUNS = Number(process.env.RUNS || 5);

const states = [
  { altitude_m: 120, vertical_velocity_mps: -3.0, fuel_pct: 80, horizontal_drift_mps: 0.0 },
  { altitude_m: 15, vertical_velocity_mps: -12.0, fuel_pct: 40, horizontal_drift_mps: 2.5 },
  { altitude_m: 5, vertical_velocity_mps: -1.0, fuel_pct: 10, horizontal_drift_mps: -2.0 },
];

const questions = {
  thrust: {
    type: 'noul',
    instructions: 'Should the main engine fire now? Fire if descending faster than 5 m/s or if altitude is below 20 m and descent is faster than 2 m/s.',
    criteria: { true: 'Fire the main engine.', false: 'Do not fire; descent is safe.' },
  },
  angle: {
    type: 'choice',
    instructions: 'Which way should the lander tilt to cancel horizontal drift? Positive drift is to the right.',
    criteria: {
      left: 'Tilt left to cancel rightward (positive) drift.',
      center: 'Stay upright; drift is near zero.',
      right: 'Tilt right to cancel leftward (negative) drift.',
    },
  },
};

async function decide(state) {
  const t0 = performance.now();
  const res = await fetch(`${HOST}/v1/systemone`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, questions, keep_alive: '30m' }),
  });
  const ms = performance.now() - t0;
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const j = await res.json();
  const a = j.answers;
  return { ms, decision: { thrust: a.thrust.noul >= 0.5, angle: a.angle.choice }, p_thrust: a.thrust.noul, p_angle: a.angle.probabilities, usage: j.usage };
}

for (const s of states) {
  const lat = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await decide(s);
    lat.push(r.ms);
    if (i === 0 || i === RUNS - 1) console.log(JSON.stringify({ run: i, state: s, ...r, ms: +r.ms.toFixed(1) }));
  }
  const sorted = [...lat].sort((a, b) => a - b);
  console.log(`latency ms: ${lat.map(x => x.toFixed(0)).join(', ')} | median ${sorted[sorted.length >> 1].toFixed(0)}\n`);
}
