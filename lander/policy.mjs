// ---- POLICY pilot: the model judges the state against a plain-English policy text (lander/modes/policies/*.txt). ----
// Behavior is changed by editing the policy file, not code. Each decision = 4 tiny noul calls (key 'q'),
// each with state = { policy, ship } where ship is a compact JSON of named fields.
// Code only maps the answer PROBABILITIES (graded) to controls with POLICY_TABLE below.
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { PAD, G, THRUST } from './sim.mjs';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'modes', 'policies');
export const policyNames = () => fs.readdirSync(DIR).filter(f => f.endsWith('.txt')).map(f => f.slice(0, -4)).sort();
export const policyText = n => fs.readFileSync(path.join(DIR, (policyNames().includes(n) ? n : 'careful') + '.txt'), 'utf8').trim();
const r1 = v => Math.round(v * 10) / 10;
export function shipJSON(s) { const dx = r1((PAD.x0 + PAD.x1) / 2 - s.x);
  return { height_above_pad_m: r1(s.y - PAD.y), vertical_speed_mps: r1(s.vy), vertical_motion: s.vy < -0.05 ? 'descending' : s.vy > 0.05 ? 'climbing' : 'level',
    pad_direction: Math.abs(dx) < 3 ? 'directly below' : dx > 0 ? 'right' : 'left', pad_distance_m: Math.abs(dx),
    sideways_motion: s.vx > 0.05 ? 'right' : s.vx < -0.05 ? 'left' : 'none', sideways_speed_mps: r1(Math.abs(s.vx)), sideways_vs_pad: Math.abs(s.vx) < 0.05 ? 'not moving sideways' : (s.vx > 0) === (dx > 0) ? 'moving toward the pad' : 'moving away from the pad', fuel_pct: Math.round(s.fuel),
    crash_limits: 'touchdown is a crash if falling 4 m/s or faster, sideways 2 m/s or faster, or tilted; pad is 30 m wide' }; }
const nq = (i, t, f) => ({ type: 'noul', instructions: i, criteria: { true: t, false: f } });
// Question wording (round 2; see README for round 1).
export const POLICY_Q = [
  { name: 'too_fast', q: nq('Following the pilot policy, is the ship falling faster than the policy allows at its current height?', 'yes, falling too fast for the policy', 'no, the fall rate is acceptable or the ship is not falling') },
  { name: 'too_slow', q: nq('Following the pilot policy, is the ship falling slower than it needs to (or climbing), wasting fuel or time?', 'yes, too slow or climbing', 'no') },
  { name: 'go_right', q: nq('Following the pilot policy, does the ship need more rightward speed? Consider where the pad is, and that sideways speed must shrink to almost zero as the ship gets over the pad and near the ground.', 'yes, it needs more rightward speed', 'no, rightward speed is enough or too much') },
  { name: 'go_left', q: nq('Following the pilot policy, does the ship need more leftward speed? Consider where the pad is, and that sideways speed must shrink to almost zero as the ship gets over the pad and near the ground.', 'yes, it needs more leftward speed', 'no, leftward speed is enough or too much') },
];
export const HOVER = Math.round(G / THRUST * 100) / 100; // throttle that cancels gravity
export const POLICY_TABLE = [
  `throttle = clamp(${HOVER} + 0.9·P(too_fast) − 0.9·P(too_slow), 0, 1)   (${HOVER} = hover throttle; graded, not a 0.5 cutoff)`,
  'steer = P(go_right) − P(go_left): > +0.15 → tilt right, < −0.15 → tilt left, else center',
  'height < 4 m → tilt center (touch down upright)',
];
export function policyMap(a, s) {
  const thr = Math.max(0, Math.min(1, HOVER + 0.9 * a.too_fast_p - 0.9 * a.too_slow_p)), d = a.go_right_p - a.go_left_p;
  const tilt = s.y - PAD.y < 4 ? 'center' : d > 0.15 ? 'right' : d < -0.15 ? 'left' : 'center';
  return { throttle: Math.round(thr * 100) / 100, tilt };
}
