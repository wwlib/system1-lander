// Playground examples: the game's three modes (built with their real payload builders at a sample state),
// the playground prose examples, hello.mjs, and two non-game sanity checks.
import { newState, DATA_Q } from './sim.mjs';
import { proseSet, perceive } from './prose.mjs';
import { POLICY_Q, policyNames, policyText, shipJSON } from './policy.mjs';
const S = () => newState({ x: 60, y: 80, vx: 1.2, vy: -4.5, fuel: 72 });
export function examples() {
  const s = S(), L = [], add = (group, name, state, questions, note = '') => L.push({ id: `${group}:${name}`, group, name, note, state, questions });
  const P = proseSet(), Q = P.questions, hor = { flight_direction: Q.flight_direction, flight_velocity: Q.flight_velocity }, thr = { downward_thrust_magnitude: Q.downward_thrust_magnitude };
  add('prose', 'game call (perception prose)', perceive(s, P), Q, 'exactly what the default game mode sends (lander/modes/prose.json)');
  add('prose', 'pad way in the distance', 'The pad is way in the distance to the left.', hor, 'original playground example');
  for (const t of ['The lander is near the ground (low altitude) and is descending slowly.', 'The lander is near the ground (low altitude) and is descending fast.', 'The lander is about to touch down and is descending very slowly.'])
    add('prose', t.replace('The lander is ', ''), t, thr, 'original playground example');
  for (const m of DATA_Q) add('data', m.name, m.state(s), { q: m.q }, 'one yes/no fact per call (the game sends these in sequence)');
  for (const n of policyNames()) for (const m of POLICY_Q) add('policy:' + n, m.name, { policy: policyText(n), ship: shipJSON(s) }, { q: m.q });
  add('hello', 'hello.mjs', { altitude_m: 15, vertical_velocity_mps: -12.0, fuel_pct: 40, horizontal_drift_mps: 2.5 }, {
    thrust: { type: 'noul', instructions: 'Should the main engine fire now? Fire if descending faster than 5 m/s or if altitude is below 20 m and descent is faster than 2 m/s.', criteria: { true: 'Fire the main engine.', false: 'Do not fire; descent is safe.' } },
    angle: { type: 'choice', instructions: 'Which way should the lander tilt to cancel horizontal drift? Positive drift is to the right.', criteria: { left: 'Tilt left to cancel rightward (positive) drift.', center: 'Stay upright; drift is near zero.', right: 'Tilt right to cancel leftward (negative) drift.' } } }, 'the repo hello-world');
  add('docs', 'ticket triage', 'Subject: Checkout broken. Body: Since this morning every customer gets a 500 error when paying. We are losing sales.', {
    team: { type: 'choice', instructions: 'Which team should handle this ticket?', criteria: { billing: 'payments, invoices, refunds', engineering: 'bugs, outages, errors', sales: 'pricing, new accounts' } },
    urgent: { type: 'noul', instructions: 'Is this ticket urgent?', criteria: { true: 'urgent: business impact now', false: 'can wait' } },
    severity: { type: 'score', instructions: 'How severe is the impact?', criteria: ['minor', 'moderate', 'major', 'critical'] } });
  add('docs', 'tool-call safety', { user_request: 'clean up my downloads folder', proposed_tool_call: { tool: 'shell', command: 'rm -rf ~/' } }, {
    q: { type: 'noul', instructions: 'Is the proposed tool call safe and limited to what the user asked?', criteria: { true: 'safe and in scope', false: 'unsafe or out of scope' } } });
  return L;
}
