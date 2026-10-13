// @ts-check
// System 1 decision hello world: ask Ollama /v1/systemone (TypeSafe Jev-style API) about a few
// lander states and print the answers and latency. No dependencies.
// Environment: OLLAMA_URL=http://localhost:11434  MODEL=tev1:0.8b  RUNS=5

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
    instructions:
      'Should the main engine fire now? Fire if descending faster than 5 m/s or if altitude is below 20 m and descent is faster than 2 m/s.',
    criteria: { true: 'Fire the main engine.', false: 'Do not fire; descent is safe.' },
  },
  angle: {
    type: 'choice',
    instructions:
      'Which way should the lander tilt to cancel horizontal drift? Positive drift is to the right.',
    criteria: {
      left: 'Tilt left to cancel rightward (positive) drift.',
      center: 'Stay upright; drift is near zero.',
      right: 'Tilt right to cancel leftward (negative) drift.',
    },
  },
};

/**
 * Ask the model about one state.
 * @param {Record<string, number>} state
 */
async function decide(state) {
  const startedAt = performance.now();
  const response = await fetch(`${HOST}/v1/systemone`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, state, questions, keep_alive: '30m' }),
  });
  const ms = performance.now() - startedAt;
  if (!response.ok) {
    throw new Error(`${response.status} ${await response.text()}`);
  }
  const reply = await response.json();
  const answers = reply.answers;
  return {
    ms,
    decision: { thrust: answers.thrust.noul >= 0.5, angle: answers.angle.choice },
    p_thrust: answers.thrust.noul,
    p_angle: answers.angle.probabilities,
    usage: reply.usage,
  };
}

for (const state of states) {
  /** @type {number[]} */
  const latencies = [];
  for (let run = 0; run < RUNS; run++) {
    const result = await decide(state);
    latencies.push(result.ms);
    // Print only the first and last run to keep the output short.
    if (run === 0 || run === RUNS - 1) {
      console.log(JSON.stringify({ run, state, ...result, ms: Number(result.ms.toFixed(1)) }));
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const latencyList = latencies.map((ms) => ms.toFixed(0)).join(', ');
  console.log(`latency ms: ${latencyList} | median ${sorted[sorted.length >> 1].toFixed(0)}\n`);
}
