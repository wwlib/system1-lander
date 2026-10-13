// Shared physics + model prompt (used by server, headless test, and browser via /sim.mjs)
export const G = 1.62, THRUST = 4.0, TILT = 0.35 /*rad*/, FUEL_RATE = 1.0, W = 200; // world 200m wide
export const PAD = { x0: 120, x1: 150, y: 10 };
export function terrainY(x) {
  if (x >= PAD.x0 && x <= PAD.x1) return PAD.y;
  return PAD.y + 8 * Math.abs(Math.sin(x * 0.07)) + 4 * Math.abs(Math.sin(x * 0.23));
}
// Landing limits (shock-absorbing legs) and gymnastics-style score 0.0–10.0.
export const LAND = { vy: 4, vx: 2, ang: 0.3 };
// Score: start 9.0, + fuel bonus up to 1.0, minus deductions (each capped):
//   vertical: 1.0 per m/s above 1 m/s (max 3) · horizontal: 1.0 per m/s (max 2) · tilt: 2.0 × |angle|/0.3 (max 2) · off-center: 2.0 × |x − pad center|/15 (max 2)
export function landingScore(s) { const padC = (PAD.x0 + PAD.x1) / 2, c = (v, m) => Math.min(m, Math.max(0, v)), r = v => Math.round(v * 10) / 10;
  const b = { base: 9, fuel_bonus: r(s.fuel / 100), vertical: -r(c(Math.abs(s.vy) - 1, 3)), horizontal: -r(c(Math.abs(s.vx), 2)), tilt: -r(c(2 * Math.abs(s.angle) / 0.3, 2)), off_center: -r(c(2 * Math.abs(s.x - padC) / 15, 2)) };
  return { score: r(c(Object.values(b).reduce((a, x) => a + x, 0), 10)), scoreBreakdown: b }; }
export function newState(o = {}) {
  return { x: 40, y: 120, vx: 0, vy: 0, fuel: 100, angle: 0, t: 0, outcome: null, ...o };
}
// tilt: 'left' | 'center' | 'right'. Tilting left points thrust leftward => pushes lander LEFT (vx decreases).
export function step(s, dt, thrust, tilt) {
  if (s.outcome) return s;
  const target = tilt === 'left' ? -TILT : tilt === 'right' ? TILT : 0;
  s.angle += Math.sign(target - s.angle) * Math.min(Math.abs(target - s.angle), 2.0 * dt);
  let ax = 1.0 * Math.sin(s.angle) / Math.sin(TILT), ay = -G; // attitude jets give lateral push when tilted
  const lvl = thrust === true ? 1 : +thrust || 0;
  if (lvl > 0 && s.fuel > 0) {
    ax = THRUST * lvl * Math.sin(s.angle); ay += THRUST * lvl * Math.cos(s.angle);
    s.fuel = Math.max(0, s.fuel - FUEL_RATE * dt * 3 * lvl);
  }
  s.vx += ax * dt; s.vy += ay * dt; s.x += s.vx * dt; s.y += s.vy * dt; s.t += dt;
  if (s.x < 0 || s.x > W) s.outcome = 'crash (out of bounds)';
  else if (s.y <= terrainY(s.x)) {
    s.y = terrainY(s.x);
    const onPad = s.x >= PAD.x0 && s.x <= PAD.x1;
    // Shock-absorbing legs: survivable if on pad with |vy| < LAND.vy, |vx| < LAND.vx, |angle| < LAND.ang.
    const why = [!onPad && 'off pad', Math.abs(s.vy) >= LAND.vy && `vy ${s.vy.toFixed(1)} ≥ ${LAND.vy}`, Math.abs(s.vx) >= LAND.vx && `vx ${s.vx.toFixed(1)} ≥ ${LAND.vx}`,
      Math.abs(s.angle) >= LAND.ang && `tilt ${s.angle.toFixed(2)} ≥ ${LAND.ang}`].filter(Boolean);
    if (!why.length) { s.outcome = 'LANDED'; Object.assign(s, landingScore(s)); }
    else { s.outcome = `crash (${why.join(', ')})`; s.score = 0; s.scoreBreakdown = { crash: why.join(', ') }; }
  } else if (s.t > 300) s.outcome = 'timeout';
  return s;
}
// Rule oracle (reference only: headless agreement stat; never sent to the model).
export function features(s) {
  const padC = (PAD.x0 + PAD.x1) / 2, dx = padC - s.x, alt = s.y - PAD.y;
  const far = Math.abs(dx) > 12;                                      // hold altitude-ish while traversing
  const targetVy = far && alt < 35 ? -0.5 : -Math.max(0.7, Math.min(alt / 10, 5));
  const descent = s.vy < targetVy ? 'too_fast' : 'ok';
  const wantVx = Math.max(-3, Math.min(4, dx / 8));                  // desired sideways speed toward pad
  let steer = s.vx < wantVx - 0.2 ? 'right' : s.vx > wantVx + 0.2 ? 'left' : 'none';
  if (alt < 1.5) steer = 'none';                                        // touch down upright
  return { descent, steer, pad: Math.abs(dx) < 10 ? 'below' : dx > 0 ? 'right' : 'left', alt: Math.round(alt) };
}
export function modelState(s) { const f = features(s); return { engine: f.descent === 'too_fast' ? 'burn' : 'off', steer: f.steer, pad: f.pad, alt: f.alt }; }
export const ACTIONS = { burn_left: [true, 'left'], burn_center: [true, 'center'], burn_right: [true, 'right'], coast_left: [false, 'left'], coast_center: [false, 'center'], coast_right: [false, 'right'] };

export function physicsState(s) {
  const padC = (PAD.x0 + PAD.x1) / 2, r1 = v => Math.round(v * 10) / 10;
  return { alt_m: r1(s.y - PAD.y), vy_mps: r1(s.vy), vx_mps: r1(s.vx), dx_to_pad_m: r1(padC - s.x), angle_deg: Math.round(s.angle * 57.3), fuel_pct: Math.round(s.fuel) };
}

// ---- DATA mode: one tiny yes/no fact per /v1/systemone call (neutral key "q"); code maps answers with DATA_TABLE ----
const _r1 = v => Math.round(v * 10) / 10;
const nq = (instructions, t, f) => ({ type: 'noul', instructions, criteria: { true: t, false: f } });
const fall = s => _r1(-s.vy), spd = s => _r1(Math.abs(s.vx)), dist = s => _r1(Math.abs((PAD.x0 + PAD.x1) / 2 - s.x));
const MULTI = [
  { name: 'near_ground', state: s => ({ alt_m: _r1(s.y - PAD.y) }),
    q: { type: 'choice', instructions: 'How high is the lander?', criteria: { high: 'alt_m is 3 or more', touching_down: 'alt_m is less than 3' } }, read: a => a.choice === 'touching_down' },
  { name: 'fall_gt5', state: s => ({ fall_speed_mps: fall(s) }), q: nq('Is fall_speed_mps greater than 5?', 'greater than 5', '5 or less') },
  { name: 'fall_gt1', skipIf: a => a.fall_gt5, state: s => ({ fall_speed_mps: fall(s) }), q: nq('Is fall_speed_mps greater than 1?', 'greater than 1', '1 or less') },
  { name: 'fall_x10', skipIf: a => a.fall_gt5 || !a.fall_gt1, state: s => ({ fall_speed_mps: fall(s), alt_m: _r1(s.y - PAD.y) }),
    q: nq('Is fall_speed_mps times 10 greater than alt_m?', 'fall_speed_mps × 10 > alt_m', 'not greater') },
  { name: 'pad_right', skipIf: a => a.near_ground, state: s => ({ dx_to_pad_m: _r1((PAD.x0 + PAD.x1) / 2 - s.x) }),
    q: nq('Is dx_to_pad_m positive (pad is to the right)?', 'dx_to_pad_m is positive', 'dx_to_pad_m is zero or negative') },
  { name: 'moving_right', skipIf: a => a.near_ground, state: s => ({ vx_mps: _r1(s.vx) }), q: nq('Is vx_mps positive (moving right)?', 'vx_mps is positive', 'vx_mps is zero or negative') },
  { name: 'spd_gt3', skipIf: a => a.near_ground || a.pad_right !== a.moving_right, state: s => ({ sideways_speed_mps: spd(s) }), q: nq('Is sideways_speed_mps greater than 3?', 'greater than 3', '3 or less') },
  { name: 'spd_x8', skipIf: a => a.near_ground || a.pad_right !== a.moving_right || a.spd_gt3, state: s => ({ sideways_speed_mps: spd(s), pad_distance_m: dist(s) }),
    q: nq('Is sideways_speed_mps times 8 greater than pad_distance_m?', 'sideways_speed_mps × 8 > pad_distance_m', 'not greater') },
];
export function multiThrust(a) { return !!(a.fall_gt5 || (a.fall_gt1 && a.fall_x10)); }
const M1 = Object.fromEntries(MULTI.map(m => [m.name, m]));
export const DATA_Q = [
  M1.near_ground,
  { name: 'rising', state: s => ({ vy_mps: _r1(s.vy) }), q: nq('Is vy_mps positive (moving up)?', 'vy_mps is positive', 'vy_mps is zero or negative') },
  { ...M1.fall_gt5, skipIf: a => a.rising },
  { ...M1.fall_gt1, skipIf: a => a.rising || a.fall_gt5 },
  { ...M1.fall_x10, skipIf: a => a.rising || a.fall_gt5 || !a.fall_gt1 },
  M1.pad_right, M1.moving_right,
  M1.spd_gt3, M1.spd_x8,
  { name: 'spd_lt2_5', skipIf: a => a.near_ground || a.pad_right !== a.moving_right || a.spd_gt3 || a.spd_x8, state: s => ({ sideways_speed_mps: spd(s) }),
    q: nq('Is sideways_speed_mps less than 2.5?', 'less than 2.5', '2.5 or more') },
  { name: 'slow_x8', skipIf: a => a.near_ground || a.pad_right !== a.moving_right || a.spd_gt3 || a.spd_x8 || !a.spd_lt2_5, state: s => ({ sideways_speed_mps: spd(s), pad_distance_m: dist(s) }),
    q: { type: 'noul', instructions: 'Is (sideways_speed_mps times 8) plus 8 less than pad_distance_m?', criteria: { true: 'yes, less', false: 'no' } } },
];
export const DATA_TABLE = [
  'rising = yes → engine off',
  'else engine on  ⇐  fall_gt5 = yes, OR (fall_gt1 = yes AND fall_x10 = yes)',

  'near_ground = yes → tilt center (level for touchdown)',
  'pad_right ≠ moving_right (moving away or still) → tilt toward pad',
  'approaching AND (spd_gt3 OR spd_x8) → tilt away (brake)',
  'approaching AND spd_lt2_5 AND slow_x8 → tilt toward (speed up)',
  'approaching otherwise → HOLD: tilt center',
  'later questions are skipped when an earlier answer already decides the row',
];
export function dataThrust(a) { return !a.rising && multiThrust(a); }
export function dataMap(a) {
  if (a.near_ground) return 'center';
  const toward = a.pad_right ? 'right' : 'left', away = a.pad_right ? 'left' : 'right';
  if (a.pad_right !== a.moving_right) return toward;
  if (a.spd_gt3 || a.spd_x8) return away;
  return a.spd_lt2_5 && a.slow_x8 ? toward : 'center';
}
