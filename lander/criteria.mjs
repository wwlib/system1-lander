// ---- CRITERIA pilot: perception prose (bands) + choice questions from an editable file (lander/criteria/<name>.json). ----
// Code: physics → prose sentences (perception), and fixed maps from the model's choices to controls (CRITERIA_TABLE).
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { PAD } from './sim.mjs';
const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'criteria');
export const criteriaNames = () => fs.readdirSync(DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5)).sort();
export const criteriaSet = n => JSON.parse(fs.readFileSync(path.join(DIR, (criteriaNames().includes(n) ? n : 'user-v1') + '.json'), 'utf8'));
// Bands (m, m/s). Pad distance = |pad center − x|.
export const BANDS = { pad: [[4, 'directly below'], [12, 'very near'], [35, 'near'], [80, 'far'], [1e9, 'way in the distance']],
  alt: [[4, 'about to touch down'], [25, 'low'], [60, 'medium'], [1e9, 'high']], fall: [[1, 'very slowly'], [3, 'slowly'], [6, 'fast'], [1e9, 'very fast']], drift: [[0.3, 'none'], [1.5, 'slowly'], [3, 'fast'], [1e9, 'very fast']] };
const band = (B, v) => B.find(([t]) => v < t)[1];
export function padSentence(dx) { const b = band(BANDS.pad, Math.abs(dx)), side = dx > 0 ? 'right' : 'left';
  return b === 'directly below' ? 'The pad is directly below.' : b === 'very near' ? `The pad is very near, just a little to the ${side}.` : b === 'near' ? `The pad is near, to the ${side}.` : b === 'far' ? `The pad is far to the ${side}.` : `The pad is way in the distance to the ${side}.`; }
export function altSentence(alt, vy) { const a = band(BANDS.alt, alt), lead = a === 'about to touch down' ? 'The lander is about to touch down' : a === 'low' ? 'The lander is near the ground (low altitude)' : a === 'medium' ? 'The lander is at medium altitude' : 'The lander is at high altitude';
  return vy > 0.3 ? `${lead} and is rising.` : `${lead} and is descending ${band(BANDS.fall, -vy)}.`; }
export function driftSentence(vx) { const b = band(BANDS.drift, Math.abs(vx)); return b === 'none' ? 'The lander is not drifting sideways.' : `The lander is drifting to the ${vx > 0 ? 'right' : 'left'} ${b}.`; }
export function perceive(s, set) { const dx = (PAD.x0 + PAD.x1) / 2 - s.x, alt = s.y - PAD.y, P = set.perception || ['pad', 'altitude'];
  return P.map(k => k === 'pad' ? padSentence(dx) : k === 'altitude' ? altSentence(alt, s.vy) : k === 'drift' ? driftSentence(s.vx) : '').filter(Boolean).join(' '); }
export const SPEED = { fast: 4, slow: 2, very_slow: 0.8, none: 0 }, LEVEL = { none: 0, small: 0.3, medium: 0.55, large: 1 };
export const CRITERIA_TABLE = [
  'target vx = sign(flight_direction: right +1, left −1, none 0) × speed(flight_velocity: fast 4, slow 2, very_slow 0.8, none 0 m/s)',
  'tilt toward (target vx − actual vx) if the gap > 0.4 m/s, else center; center below 4 m (touch down upright)',
  'throttle = Σ P(level) × {none 0, small 0.3, medium 0.55, large 1}  (expected value of the choice probabilities; hover ≈ 0.41)',
  'optional drift_correction question (v2+): left/right/none overrides the tilt when present',
];
export function criteriaMap(A, s) {
  const dir = A.flight_direction?.choice, v = A.flight_velocity?.choice, sgn = dir === 'right' ? 1 : dir === 'left' ? -1 : 0, tvx = sgn * (SPEED[v] ?? 0), gap = tvx - s.vx;
  let tilt = Math.abs(gap) > 0.4 ? (gap > 0 ? 'right' : 'left') : 'center';
  if (A.drift_correction?.choice in { left: 1, right: 1, none: 1 }) tilt = A.drift_correction.choice === 'none' ? tilt : A.drift_correction.choice;
  if (s.y - PAD.y < 4) tilt = 'center';
  const tp = A.downward_thrust_magnitude?.probabilities || {}, throttle = Object.entries(LEVEL).reduce((a, [k, l]) => a + (tp[k] || 0) * l, 0);
  return { tvx, tilt, throttle: Math.round(throttle * 100) / 100 };
}
