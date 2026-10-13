// Playground examples, built from the game's real payload builders (sim.mjs, policy.mjs) at a fixed sample state.
import { newState, MULTI, MULTI2, payloadFor, PHYS_VARIANTS, scenePayload, SCENE_T, SCENE_VARIANTS } from './sim.mjs';
import { POLICY_Q, policyNames, policyText, shipJSON } from './policy.mjs';
const S = () => newState({ x: 60, y: 80, vx: 1.2, vy: -4.5, fuel: 72 });
export function examples() {
  const s = S(), L = [];
  const add = (group, name, state, questions, note = '') => L.push({ id: `${group}:${name}`, group, name, note, state, questions });
  add('hello', 'hello.mjs', { altitude_m: 15, vertical_velocity_mps: -12.0, fuel_pct: 40, horizontal_drift_mps: 2.5 }, {
    thrust: { type: 'noul', instructions: 'Should the main engine fire now? Fire if descending faster than 5 m/s or if altitude is below 20 m and descent is faster than 2 m/s.', criteria: { true: 'Fire the main engine.', false: 'Do not fire; descent is safe.' } },
    angle: { type: 'choice', instructions: 'Which way should the lander tilt to cancel horizontal drift? Positive drift is to the right.', criteria: { left: 'Tilt left to cancel rightward (positive) drift.', center: 'Stay upright; drift is near zero.', right: 'Tilt right to cancel leftward (negative) drift.' } } }, 'the repo hello-world (two questions in one call)');
  for (const [lst, g] of [[MULTI, 'multi'], [MULTI2, 'multi2']]) for (const m of lst) if (typeof m.q !== 'function') add(g, m.name, m.state(s), { q: m.q }, 'one yes/no fact per call (game sends these in sequence)');
  for (const v of Object.keys(PHYS_VARIANTS)) if (!['multi', 'multi2', 'multi2p', 'rival'].includes(v)) { try { const p = payloadFor(s, 'physics', v); add('physics', v, p.state, p.questions); } catch {} }
  for (const v of [...SCENE_VARIANTS, ...SCENE_T]) { try { const p = scenePayload(s, v, [], false, /s[45]t/.test(v) ? { throttle: 'off', tilt: 'center' } : null); add('scene', v.replace('scene_', ''), p.state, p.questions, /j/.test(v) ? 'joystick wording' : ''); } catch {} }
  for (const n of policyNames()) for (const m of POLICY_Q) add('policy:' + n, m.name, { policy: policyText(n), ship: shipJSON(s) }, { q: m.q });
  add('docs', 'ticket triage', 'Subject: Checkout broken. Body: Since this morning every customer gets a 500 error when paying. We are losing sales.', {
    team: { type: 'choice', instructions: 'Which team should handle this ticket?', criteria: { billing: 'payments, invoices, refunds', engineering: 'bugs, outages, errors', sales: 'pricing, new accounts' } },
    urgent: { type: 'noul', instructions: 'Is this ticket urgent?', criteria: { true: 'urgent: business impact now', false: 'can wait' } },
    severity: { type: 'score', instructions: 'How severe is the impact?', criteria: ['minor', 'moderate', 'major', 'critical'] } });
  add('docs', 'tool-call safety', { user_request: 'clean up my downloads folder', proposed_tool_call: { tool: 'shell', command: 'rm -rf ~/' } }, {
    q: { type: 'noul', instructions: 'Is the proposed tool call safe and limited to what the user asked?', criteria: { true: 'safe and in scope', false: 'unsafe or out of scope' } } });
  return L;
}
