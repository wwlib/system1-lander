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
// Compact pre-computed features: model maps features -> one combined action (one question = one forward pass).
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
export const QUESTIONS = {
  act: { type: 'choice', instructions: 'Pick action matching engine and steer.',
    criteria: { burn_left: 'engine burn, steer left', burn_center: 'engine burn, steer none', burn_right: 'engine burn, steer right',
      coast_left: 'engine off, steer left', coast_center: 'engine off, steer none', coast_right: 'engine off, steer right' } },
};
// Debug/explain: every intermediate of features() with the rule that produced it (for the UI).
export function explain(s) {
  const padC = (PAD.x0 + PAD.x1) / 2, dx = padC - s.x, alt = s.y - PAD.y, far = Math.abs(dx) > 12;
  const targetVy = far && alt < 35 ? -0.5 : -Math.max(0.7, Math.min(alt / 10, 5));
  const wantVx = Math.max(-3, Math.min(4, dx / 8)), f = features(s), m = modelState(s);
  const r = v => +v.toFixed(2);
  return [
    ['pad_center_x', r(padC), `(PAD.x0 ${PAD.x0} + PAD.x1 ${PAD.x1}) / 2`],
    ['dx', r(dx), 'pad_center_x − x (positive = pad is to the right)'],
    ['alt', r(alt), `y − PAD.y (${PAD.y})`],
    ['far', far, '|dx| > 12 m'],
    ['target_vy', r(targetVy), 'far && alt < 35 ? −0.5 : −clamp(alt/10, 0.7, 5)'],
    ['descent', f.descent, `vy (${r(s.vy)}) < target_vy ? too_fast : ok`],
    ['want_vx', r(wantVx), 'clamp(dx/8, −3, 4)'],
    ['steer', f.steer, `vx (${r(s.vx)}) < want_vx−0.2 → right; > want_vx+0.2 → left; else none; alt<1.5 → none`],
    ['pad', f.pad, '|dx| < 10 → below; dx>0 → right; else left'],
    ['→ state.engine', m.engine, 'descent too_fast → burn, else off'],
    ['→ state.steer', m.steer, 'steer'], ['→ state.pad', m.pad, 'pad'], ['→ state.alt', m.alt, 'round(alt)'],
  ];
}
// ---- PHYSICS mode: raw rounded physics, model must apply the piloting rules itself ----
export function physicsState(s) {
  const padC = (PAD.x0 + PAD.x1) / 2, r1 = v => Math.round(v * 10) / 10;
  return { alt_m: r1(s.y - PAD.y), vy_mps: r1(s.vy), vx_mps: r1(s.vx), dx_to_pad_m: r1(padC - s.x), angle_deg: Math.round(s.angle * 57.3), fuel_pct: Math.round(s.fuel) };
}
export const PHYS_VARIANTS = {
  // one 6-way question
  one: { act: { type: 'choice',
    instructions: 'You pilot a lunar lander. vy_mps<0 means falling; dx_to_pad_m>0 means pad is to the right. Burn if falling faster than alt_m/10 m/s (never faster than 5, below 10 m keep under 1 m/s); otherwise coast. Steer toward the pad: aim for sideways speed about dx_to_pad_m/8 (max 3); steer right if vx_mps is below that, left if above, center if close or alt_m<2.',
    criteria: { burn_left: 'falling too fast and need to move/slow leftward', burn_center: 'falling too fast, sideways speed fine', burn_right: 'falling too fast and need to move/slow rightward',
      coast_left: 'descent fine, need to move/slow leftward', coast_center: 'descent fine, sideways fine', coast_right: 'descent fine, need to move/slow rightward' } } },
  // two questions
  two: {
    thrust: { type: 'noul', instructions: 'Lunar lander, vy_mps<0 means falling. Safe fall speed is about alt_m/10 m/s (max 5; under 1 m/s below 10 m). Fire the engine if falling faster than safe.',
      criteria: { true: 'falling faster than safe speed for this altitude', false: 'falling at or slower than safe speed' } },
    tilt: { type: 'choice', instructions: 'dx_to_pad_m>0 means pad is right. Desired sideways speed is about dx_to_pad_m/8 m/s (max 3). Compare vx_mps to it.',
      criteria: { left: 'vx_mps is more than 0.3 above desired', center: 'vx_mps within 0.3 of desired, or alt_m<2', right: 'vx_mps is more than 0.3 below desired' } } },
};
export function payloadFor(s, mode = 'physics', variant = 'one') {
  return mode === 'hints' ? { state: modelState(s), questions: QUESTIONS } : { state: stateFor(s, variant), questions: PHYS_VARIANTS[variant] };
}
PHYS_VARIANTS.one_q = { act: { type: 'choice',
  instructions: 'Lunar lander pilot. vy_mps<0 = falling. dx_to_pad_m>0 = pad is right. Safe fall speed ~ alt_m/10 (max 5). Good sideways speed ~ dx_to_pad_m/8 (max 3), so slow down sideways as dx shrinks.',
  criteria: {
    burn_left: 'falling faster than safe AND vx_mps is above the good sideways speed (too fast rightward)',
    burn_center: 'falling faster than safe AND vx_mps is close to the good sideways speed',
    burn_right: 'falling faster than safe AND vx_mps is below the good sideways speed (too slow rightward)',
    coast_left: 'falling at or below safe speed AND vx_mps is above the good sideways speed',
    coast_center: 'falling at or below safe speed AND vx_mps is close to the good sideways speed',
    coast_right: 'falling at or below safe speed AND vx_mps is below the good sideways speed' } } };
PHYS_VARIANTS.two_short = {
  thrust: { type: 'noul', instructions: 'Lander. Fire if falling (vy_mps<0) faster than alt_m/10, or faster than 1 below 10 m.',
    criteria: { true: 'falling too fast', false: 'fall speed safe' } },
  tilt: { type: 'choice', instructions: 'Target vx_mps is dx_to_pad_m/8 (max 3).',
    criteria: { left: 'vx_mps above target', center: 'vx_mps near target', right: 'vx_mps below target' } } };
// ---- (B) coarse bands + table rules (model still compares itself) ----
const band = (v, b) => Math.round(v / b) * b;
export function coarseState(s) { const padC = (PAD.x0 + PAD.x1) / 2;
  return { alt_m: band(s.y - PAD.y, 10), vy_mps: Math.round(s.vy), vx_mps: Math.round(s.vx), dx_to_pad_m: band(padC - s.x, 10) }; }
const COARSE_THRUST = { type: 'noul', instructions: 'Lunar lander. vy_mps<0 = falling. Safe fall speed by alt_m: 50+ → 5, 20-40 → 3, 10 → 2, 0 → 1. Fire if falling faster than safe.',
  criteria: { true: 'falling faster than the safe speed for this alt_m', false: 'falling no faster than safe, or rising' } };
const COARSE_TILT = { type: 'choice', instructions: 'dx_to_pad_m>0 = pad is right. Wanted vx_mps by dx_to_pad_m: 30+ → 3, 10-20 → 1, 0 → 0, -10..-20 → -1, -30 or less → -3. Compare vx_mps with wanted.',
  criteria: { left: 'vx_mps greater than wanted', center: 'vx_mps equals wanted', right: 'vx_mps less than wanted' } };
PHYS_VARIANTS.coarse = { thrust: COARSE_THRUST, tilt: COARSE_TILT };
// ---- (C) hybrid: code does thrust (features rule), model steers from raw vx/dx ----
PHYS_VARIANTS.hybrid = { tilt: { type: 'choice', instructions: 'Lander steering. dx_to_pad_m>0 = pad is right. Wanted sideways speed is about dx_to_pad_m/8 m/s (max 3 either way); slow down as you get close.',
  criteria: { left: 'vx_mps is above wanted (too fast rightward or not left enough)', center: 'vx_mps about equal to wanted', right: 'vx_mps is below wanted (too fast leftward or not right enough)' } } };
PHYS_VARIANTS.hybrid_coarse = { tilt: COARSE_TILT };
export function isHybrid(v) { return String(v).startsWith('hybrid'); }
export function stateFor(s, variant) {
  if (variant === 'facts') return wordsState(s);
  if (variant === 'coarse' || variant === 'hybrid_coarse') { const c = coarseState(s); return variant === 'coarse' ? c : { vx_mps: c.vx_mps, dx_to_pad_m: c.dx_to_pad_m }; }
  const p = physicsState(s); return isHybrid(variant) ? { vx_mps: p.vx_mps, dx_to_pad_m: p.dx_to_pad_m } : p;
}
// hybrid_dir: steering criteria phrased as directions instead of above/below comparisons
PHYS_VARIANTS.hybrid_dir = { tilt: { type: 'choice', instructions: 'Lander steering. dx_to_pad_m>0 means the pad is to the RIGHT; <0 means LEFT. vx_mps>0 means moving right. Move toward the pad, at most about 3 m/s, slowing as dx_to_pad_m nears 0.',
  criteria: { left: 'pad is to the left and not already moving left fast, OR moving right too fast for how far the pad is', center: 'moving toward the pad at a sensible speed, or over the pad and nearly still sideways',
    right: 'pad is to the right and not already moving right fast, OR moving left too fast for how far the pad is' } } };
// ---- facts: model answers atomic yes/no facts; code only maps facts -> tilt with a fixed table ----
export function factsToSteer(padRight, movingRight, tooFast, stopped = false) {
  const toward = padRight ? 'right' : 'left', away = padRight ? 'left' : 'right';
  return (stopped || movingRight !== padRight) ? toward : tooFast ? away : toward;
}
PHYS_VARIANTS.facts = {
  thrust: PHYS_VARIANTS.two.thrust,
  pad_right: { type: 'noul', instructions: 'Is the pad to the right of the lander?', criteria: { true: 'pad_side is right', false: 'pad_side is left' } },
  moving_right: { type: 'noul', instructions: 'Is the lander moving to the right?', criteria: { true: 'sideways_motion is right', false: 'sideways_motion is left or none' } },
  too_fast: { type: 'noul', instructions: 'Is sideways_speed_mps greater than pad_distance_m divided by 8, or greater than 3?', criteria: { true: 'yes, too fast for the distance', false: 'no' } } };
// two_perm: same as 'two' but tilt options reordered (center, right, left) — reduces 4b position bias in tests
PHYS_VARIANTS.two_perm = { thrust: PHYS_VARIANTS.two.thrust, tilt: { ...PHYS_VARIANTS.two.tilt, criteria: { center: PHYS_VARIANTS.two.tilt.criteria.center, right: PHYS_VARIANTS.two.tilt.criteria.right, left: PHYS_VARIANTS.two.tilt.criteria.left } } };
export function wordsState(s) { const p = physicsState(s), dx = p.dx_to_pad_m, vx = p.vx_mps;
  return { alt_m: p.alt_m, vy_mps: p.vy_mps, pad_side: dx > 0 ? 'right' : 'left', pad_distance_m: Math.abs(dx), sideways_motion: vx > 0 ? 'right' : vx < 0 ? 'left' : 'none', sideways_speed_mps: Math.abs(vx) }; }
// ---- multi: one tiny /v1/systemone call per fact, each with only the numbers it needs ----
// Code never does physics math; it only rounds/selects raw values and maps the model's yes/no answers with MULTI_TABLE.
const _r1 = v => Math.round(v * 10) / 10;
const nq = (instructions, t, f) => ({ type: 'noul', instructions, criteria: { true: t, false: f } });
const fall = s => _r1(-s.vy), spd = s => _r1(Math.abs(s.vx)), dist = s => _r1(Math.abs((PAD.x0 + PAD.x1) / 2 - s.x));
export const MULTI = [
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
export const MULTI_TABLE = [
  'engine on  ⇐  fall_gt5 = yes, OR (fall_gt1 = yes AND fall_x10 = yes)',
  'near_ground = yes (touching_down) → tilt center (level for touchdown)',
  'pad_right ≠ moving_right (moving away or still) → tilt toward pad',
  'approaching AND (spd_gt3 = yes OR spd_x8 = yes) → tilt away from pad (brake)',
  'approaching AND both no → tilt toward pad',
  'later questions are skipped when an earlier answer already decides the row',
];
export function multiThrust(a) { return !!(a.fall_gt5 || (a.fall_gt1 && a.fall_x10)); }
export function multiMap(a) {
  if (a.near_ground) return 'center';
  const toward = a.pad_right ? 'right' : 'left', away = a.pad_right ? 'left' : 'right';
  return a.pad_right !== a.moving_right ? toward : (a.spd_gt3 || a.spd_x8) ? away : toward;
}
PHYS_VARIANTS.multi = Object.fromEntries(MULTI.map(m => [m.name, m.q])); // for listing/UI
// ---- multi2: multi + "rising" fact (engine off when climbing), "hold" steering, and a capped burn pulse ----
const M1 = Object.fromEntries(MULTI.map(m => [m.name, m]));
export const PULSE_S = 0.5; // game mechanic: a "burn" decision fires the engine for at most 0.3 s of sim time, then coasts until the next decision
export const MULTI2 = [
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
export const MULTI2_TABLE = [
  'rising = yes → engine off',
  'else engine on  ⇐  fall_gt5 = yes, OR (fall_gt1 = yes AND fall_x10 = yes)',

  'near_ground = yes → tilt center (level for touchdown)',
  'pad_right ≠ moving_right (moving away or still) → tilt toward pad',
  'approaching AND (spd_gt3 OR spd_x8) → tilt away (brake)',
  'approaching AND spd_lt2_5 AND slow_x8 → tilt toward (speed up)',
  'approaching otherwise → HOLD: tilt center',
  'later questions are skipped when an earlier answer already decides the row',
];
export function multi2Thrust(a) { return !a.rising && multiThrust(a); }
export function multi2Map(a) {
  if (a.near_ground) return 'center';
  const toward = a.pad_right ? 'right' : 'left', away = a.pad_right ? 'left' : 'right';
  if (a.pad_right !== a.moving_right) return toward;
  if (a.spd_gt3 || a.spd_x8) return away;
  return a.spd_lt2_5 && a.slow_x8 ? toward : 'center';
}
PHYS_VARIANTS.multi2 = Object.fromEntries(MULTI2.map(m => [m.name, m.q]));
PHYS_VARIANTS.multi2p = PHYS_VARIANTS.multi2; // same questions + burn pulse (engine fires at most PULSE_S sim-seconds per decision)
// ---- RIVAL: multi2-style facts + personality calls. The personality lives only in the model's prompt text. ----
export const PERSONAS = {
  reckless: 'You are a reckless pilot who loves speed, falls fast and brakes as late as you dare.',
  careful: 'You are a careful pilot who keeps the descent slow and safe at all times.',
  'show-off': 'You are a show-off pilot: you want a dramatic fast drop, then a perfect last-second touchdown.',
  'fuel-miser': 'You are a fuel-miser pilot who uses the engine as little as possible, but still wants to survive.',
};
const LAND_HINT = 'Touchdown is survivable only if fall_speed_mps is below 4 at alt_m 0.';
// Personality = 3 choice questions whose ONLY state is the personality text (cached by Ollama after the first decision).
// The model's chosen numbers are then written into the wording of later yes/no fact questions (code copies the number, never computes with physics).
const PROFILE_Q = {
  hi: { type: 'choice', instructions: 'How fast are you willing to fall while still high up (above 20 m)?', criteria: { '3': '3 m/s, slow and safe', '5': '5 m/s, normal', '7': '7 m/s, fast and daring' } },
  lo: { type: 'choice', instructions: 'How fast are you willing to fall in the last 20 m before touchdown? (above 4 m/s at touchdown is a crash)', criteria: { '1': '1 m/s, very gentle', '2': '2 m/s, normal', '3': '3 m/s, hard and daring' } },
  side: { type: 'choice', instructions: 'How fast are you willing to move sideways toward the pad?', criteria: { '2': '2 m/s, cautious', '3': '3 m/s, normal', '4': '4 m/s, aggressive' } },
};
const gtq = (f, T) => { const t = (+T).toFixed(1); return { type: 'noul', instructions: `Is ${f} greater than ${t}?`, criteria: { true: `${f} > ${t}`, false: `${f} ≤ ${t}` } }; };
const ltq = (f, T) => { const t = (+T).toFixed(1); return { type: 'noul', instructions: `Is ${f} less than ${t}?`, criteria: { true: `${f} < ${t}`, false: `${f} ≥ ${t}` } }; };
export function rivalList(persona) { const P = PERSONAS[persona] || PERSONAS.careful, M = Object.fromEntries(MULTI2.map(m => [m.name, m]));
  const prof = k => ({ name: 'persona_' + k, state: () => ({ personality: P }), q: PROFILE_Q[k], read: A => A.choice, readP: A => A.probabilities?.[A.choice] ?? 0 });
  return [
    prof('hi'), prof('lo'), prof('side'),
    M.near_ground, M.rising,
    { name: 'low_zone', skipIf: a => a.rising, state: s => ({ alt_m: _r1(s.y - PAD.y) }), q: nq('Is alt_m less than 20?', 'less than 20', '20 or more') },
    { name: 'fall_too_fast', skipIf: a => a.rising, state: s => ({ fall_speed_mps: fall(s) }),
      q: a => gtq('fall_speed_mps', a.low_zone ? a.persona_lo : a.persona_hi) },
    M.pad_right, M.moving_right,
    { name: 'side_too_fast', skipIf: a => a.near_ground || a.pad_right !== a.moving_right, state: s => ({ sideways_speed_mps: spd(s) }),
      q: a => gtq('sideways_speed_mps', a.persona_side) },
    { ...M.spd_x8, skipIf: a => a.near_ground || a.pad_right !== a.moving_right || a.side_too_fast },
    { name: 'side_slow', skipIf: a => a.near_ground || a.pad_right !== a.moving_right || a.side_too_fast || a.spd_x8, state: s => ({ sideways_speed_mps: spd(s) }),
      q: a => ltq('sideways_speed_mps', a.persona_side - 0.5) },
    { ...M.slow_x8, skipIf: a => a.near_ground || a.pad_right !== a.moving_right || a.side_too_fast || a.spd_x8 || !a.side_slow },
  ]; }
export const RIVAL_TABLE = [
  'MODEL (personality text only): persona_hi / persona_lo = max fall speed it accepts above / below 20 m; persona_side = max sideways speed',
  'those chosen numbers are copied into the wording of fall_too_fast and side_too_fast / side_slow; the MODEL answers them',
  'rising = yes → engine off; else engine = fall_too_fast',
  'near_ground = yes → tilt center',
  'pad_right ≠ moving_right → tilt toward pad',
  'approaching AND (side_too_fast OR spd_x8) → tilt away (brake)',
  'approaching AND side_slow AND slow_x8 → tilt toward; otherwise hold center',
  'code only maps answers; it never reads the personality text',
];
export function rivalThrust(a) { return !a.rising && !!a.fall_too_fast; }
export function rivalMap(a) { if (a.near_ground) return 'center'; const toward = a.pad_right ? 'right' : 'left', away = a.pad_right ? 'left' : 'right';
  if (a.pad_right !== a.moving_right) return toward; if (a.side_too_fast || a.spd_x8) return away; return a.side_slow && a.slow_x8 ? toward : 'center'; }
// ---- SCENE mode: the model gets a prose description of what a pilot perceives and chooses the controls itself. ----
// The prose is DESCRIPTIVE only (positions, speeds, tilt, fuel). No code-computed judgments ("too fast", "you should burn").
// s1 = numbers in prose · s2 = words from fixed bins (gray area: the bin edges are code choices, but they describe magnitude, not what to do)
// s3 = s1 + the last 2 decisions as short "frames" (state + what you chose).   Output forms: a = one 6-way choice, b = engine noul + tilt choice, c = three nouls.
const side = v => v > 0 ? 'right' : 'left';
const padDx = s => { const c = (PAD.x0 + PAD.x1) / 2; return c - s.x; };
export function proseS1(s, engineOn) { const alt = Math.max(0, s.y - PAD.y), vy = s.vy, vx = s.vx, dx = padDx(s), deg = Math.round(s.angle * 180 / Math.PI), half = (PAD.x1 - PAD.x0) / 2;
  return [`You are ${alt.toFixed(0)} meters above the ground, ${Math.abs(vy) < 0.05 ? 'not moving vertically' : `${vy < 0 ? 'falling' : 'rising'} at ${Math.abs(vy).toFixed(1)} meters per second`}.`,
    Math.abs(dx) <= half ? `The landing pad is directly below you (its center is ${Math.abs(dx).toFixed(0)} meters to your ${side(dx)}).` : `The landing pad's center is ${Math.abs(dx).toFixed(0)} meters to your ${side(dx)}.`,
    Math.abs(vx) < 0.05 ? 'You are not drifting sideways.' : `You are drifting ${side(vx)} at ${Math.abs(vx).toFixed(1)} meters per second.`,
    deg === 0 ? 'The ship is upright.' : `The ship is tilted ${Math.abs(deg)} degrees ${deg > 0 ? 'right' : 'left'}.`,
    `Fuel is ${Math.round(s.fuel)}%. The main engine is ${engineOn ? 'on' : 'off'}.`].join(' '); }
const bin = (v, edges, words) => { for (let i = 0; i < edges.length; i++) if (v < edges[i]) return words[i]; return words[words.length - 1]; };
function proseS2(s, engineOn) { const alt = Math.max(0, s.y - PAD.y), dx = padDx(s), half = (PAD.x1 - PAD.x0) / 2, deg = s.angle * 180 / Math.PI;
  const h = bin(alt, [3, 10, 30, 70], ['just above the ground', 'very low', 'low', 'high', 'very high above the ground']);
  const v = Math.abs(s.vy) < 0.3 ? 'barely moving vertically' : (s.vy < 0 ? 'falling ' : 'rising ') + bin(Math.abs(s.vy), [1.5, 3.5, 6], ['slowly', 'steadily', 'quickly', 'very quickly']);
  const p = Math.abs(dx) <= half ? 'The landing pad is directly below you.' : `The landing pad is ${bin(Math.abs(dx), [30, 70], ['a short way', 'some way', 'far'])} to your ${side(dx)}.`;
  const d = Math.abs(s.vx) < 0.3 ? 'You are barely drifting sideways.' : `You are drifting ${side(s.vx)} ${bin(Math.abs(s.vx), [1.5, 3.5], ['slowly', 'steadily', 'quickly'])}.`;
  const t = Math.abs(deg) < 3 ? 'The ship is upright.' : `The ship is tilted ${deg > 0 ? 'right' : 'left'}.`;
  return `You are ${h}, ${v}. ${p} ${d} ${t} Fuel is ${bin(s.fuel, [15, 40, 75], ['almost empty', 'low', 'about half', 'mostly full'])}. The main engine is ${engineOn ? 'on' : 'off'}.`; }
// s4 PERCEPTION layer (could be a vision model): impressions a pilot would form, with NO action words.
// Judgments it makes (all code): descent vs a height-scaled comfort speed (alt/10 clamped 0.7–5 m/s, same as hints mode),
// sideways approach vs a distance-scaled pace (dx/8 clamped ±3 m/s) → overshoot / fall short / on track / drifting away,
// tilt noticeable (>5°), fuel low (<20%), close to the ground (<10 m).
export function perceive(s) { const alt = Math.max(0, s.y - PAD.y), fallv = -s.vy, comfy = Math.min(5, Math.max(0.7, alt / 10)), dx = padDx(s), half = (PAD.x1 - PAD.x0) / 2, deg = s.angle * 180 / Math.PI;
  const P = [];
  P.push(s.vy > 0.3 ? 'You are rising.' : fallv > comfy * 1.25 ? 'You are falling too fast for this height.' : fallv < comfy * 0.6 ? 'You are descending slowly.' : 'Your descent speed looks about right for this height.');
  const toward = Math.sign(s.vx) === Math.sign(dx) && Math.abs(s.vx) > 0.3, pace = Math.min(3, Math.abs(dx) / 8);
  if (Math.abs(dx) <= half && Math.abs(s.vx) < 1) P.push(`You are over the landing pad and ${Math.abs(s.vx) < 0.3 ? 'holding steady sideways' : `drifting slowly ${side(s.vx)}`}.`);
  else if (!toward && Math.abs(s.vx) > 0.3) P.push(`You are drifting away from the landing pad, which is to your ${side(dx)}.`);
  else if (!toward) P.push(`You are not moving toward the landing pad, which is to your ${side(dx)}.`);
  else if (Math.abs(s.vx) > pace * 1.3 + 0.3) P.push(`You are moving toward the landing pad (to your ${side(dx)}) too quickly; it looks like you will overshoot it.`);
  else if (Math.abs(s.vx) < pace * 0.6) P.push(`You are moving toward the landing pad (to your ${side(dx)}) slowly; it looks like you will fall short of it.`);
  else P.push(`You are on track toward the landing pad (to your ${side(dx)}).`);
  if (Math.abs(deg) > 5) P.push(`The ship is tilted noticeably ${deg > 0 ? 'right' : 'left'}.`); else P.push('The ship is upright.');
  if (alt < 10) P.push('You are close to the ground.');
  if (s.fuel < 20) P.push('Fuel is running low.');
  return P.join(' '); }
const CTRL = { on_upright: 'engine on, upright', off_upright: 'engine off, upright', on_left: 'engine on, tilt left', off_left: 'engine off, tilt left', on_right: 'engine on, tilt right', off_right: 'engine off, tilt right' };
function frame(h) { const alt = Math.max(0, h.s.y - PAD.y);
  return `${h.ago.toFixed(1)} s earlier: ${alt.toFixed(0)} m up, ${Math.abs(h.s.vy) < 0.05 ? 'not moving vertically' : (h.s.vy < 0 ? 'falling' : 'rising') + ' at ' + Math.abs(h.s.vy).toFixed(1) + ' m/s'}, drifting ${side(h.s.vx)} at ${Math.abs(h.s.vx).toFixed(1)} m/s; you chose ${CTRL[h.ctrl] || 'engine off, upright'}.`; }
export const SCENE_MISSION = 'You are piloting a lunar lander. Goal: touch down gently and upright on the landing pad, using as little fuel as possible. ' +
  'A touchdown is survivable only on the pad, falling slower than 4 m/s, drifting slower than 2 m/s, and nearly upright. ' +
  'Gravity pulls you down at 1.6 m/s². The main engine pushes along the ship\'s axis at 4 m/s²: upright it pushes straight up; tilted left it also pushes you left; tilted right it also pushes you right. Tilting without the engine does nothing to your motion.';
// Graded throttle (scene t-variants). Hover needs 1.62/4 = 0.41, so low (0.3) still sinks slowly, medium (0.55) brakes gently, high brakes hard.
export const THROTTLE = { off: 0, low: 0.3, medium: 0.55, high: 1 };
export const SCENE_T = ['scene_s1tn', 'scene_s1tp', 'scene_s4tn', 'scene_s4tp', 'scene_s4tpr', 'scene_s4tjn', 'scene_s4tjp', 'scene_s5tjn', 'scene_s5tjp', 'scene_s5bjp'];
// s5 QUALITATIVE BANDS (no numbers at all). Fixed thresholds, descriptive only:
//   vertical  vy: >2 rising fast · 0.3..2 rising slowly · |vy|≤0.3 hovering · fall 0.3..1.5 falling very slowly · 1.5..3.5 falling slowly · 3.5..6 falling fast · >6 falling very fast
//   altitude  m:  >80 very high · 40..80 medium high · 15..40 low · 5..15 very low · <5 nearly on the ground
//   pad |dx| m:   ≤15 directly below · 15..40 a little to the L/R · 40..80 a lot to the L/R · >80 very far L/R
//   sideways vx:  <0.3 not drifting · 0.3..1.5 slowly · 1.5..3.5 fast · >3.5 very fast (left/right)
//   tilt deg:     <5 upright · 5..12 tilted slightly L/R · >12 tilted strongly L/R
//   fuel %:       >60 plenty · 30..60 about half · 10..30 low · <10 almost empty
// s5tj* = bands + perception impressions (same perceive()) + joystick steering + graded throttle; s5bjp = bands only (no impressions) + last command.
export function proseS5(s) { const alt = Math.max(0, s.y - PAD.y), dx = (PAD.x0 + PAD.x1) / 2 - s.x, ad = Math.abs(dx), deg = s.angle * 180 / Math.PI, f = -s.vy, avx = Math.abs(s.vx);
  const v = s.vy > 2 ? 'rising fast' : s.vy > 0.3 ? 'rising slowly' : Math.abs(s.vy) <= 0.3 ? 'hovering' : f < 1.5 ? 'falling very slowly' : f < 3.5 ? 'falling slowly' : f < 6 ? 'falling fast' : 'falling very fast';
  const a = alt > 80 ? 'very high' : alt > 40 ? 'medium high' : alt > 15 ? 'low' : alt > 5 ? 'very low' : 'nearly on the ground';
  const L = dx > 0 ? 'right' : 'left', pad = ad <= 15 ? 'directly below you' : `${ad < 40 ? 'a little' : ad < 80 ? 'a lot' : 'very far'} to the ${L}`;
  const sw = avx < 0.3 ? 'not drifting sideways' : `drifting ${avx < 1.5 ? 'slowly' : avx < 3.5 ? 'fast' : 'very fast'} ${s.vx > 0 ? 'right' : 'left'}`;
  const t = Math.abs(deg) < 5 ? 'upright' : `tilted ${Math.abs(deg) < 12 ? 'slightly' : 'strongly'} ${deg > 0 ? 'right' : 'left'}`;
  const fu = s.fuel > 60 ? 'plenty' : s.fuel > 30 ? 'about half' : s.fuel > 10 ? 'low' : 'almost empty';
  return `You are ${a}, ${v}. The landing pad is ${pad}. You are ${sw}. The ship is ${t}. Fuel: ${fu}.`; }
// s4tj*: steering worded as a joystick (best in tools/steerbench.mjs) + pad position as 'ahead-right/left, N meters away'.
export const SCENE_VARIANTS = ['scene_s1a', 'scene_s1b', 'scene_s1c', 'scene_s2a', 'scene_s2b', 'scene_s2c', 'scene_s3a', 'scene_s3b', 'scene_s3c', 'scene_s4a', 'scene_s4b', 'scene_s4c'];
const TILTW = { center: 'none', left: 'left', right: 'right' };
function scenePayloadT(s, variant, last) { const joy = /^scene_s[45][tb]j/.test(variant), s5 = variant.startsWith('scene_s5'), [, kind, prev, rev] = joy ? [, variant.includes('bj') ? '5b' : '4', variant.slice(-1), ''] : variant.match(/^scene_s(\d)t([pn])(r?)$/);
  let state = proseS1(s, false).replace(/ The main engine is (on|off)\.$/, '');
  if (s5) state = proseS5(s);
  else if (joy) { const dx = (PAD.x0 + PAD.x1) / 2 - s.x; state = state.replace(/The landing pad[^.]*\.( \(its center[^)]*\)\.)?/, Math.abs(dx) <= 15 ? 'The landing pad is directly below you.' : `The landing pad is ahead-${dx > 0 ? 'right' : 'left'} of you, ${Math.abs(dx).toFixed(0)} meters away.`); }
  if (prev === 'p') state += joy ? ` Last command: ${last ? `${last.throttle === 'off' ? 'engine off' : last.throttle + ' thrust'}, joystick ${last.tilt === 'left' ? 'left' : last.tilt === 'right' ? 'right' : 'center'}` : 'engine off, joystick center'}.`
    : ` Last command: ${last ? `${last.throttle === 'off' ? 'engine off' : last.throttle + ' thrust'}, tilt ${TILTW[last.tilt] || 'none'}` : 'engine off, tilt none'}.`;
  if (kind === '4') state += ' Impressions: ' + perceive(s);
  const thr = { off: 'main engine off', low: 'low thrust (not quite enough to hover)', medium: 'medium thrust (a bit more than hovering)', high: 'high thrust (full power)' };
  const order = rev ? ['high', 'medium', 'low', 'off'] : ['off', 'low', 'medium', 'high'];
  const M = SCENE_MISSION.replace('The main engine pushes along the ship\'s axis at 4 m/s²', 'The main engine has throttle levels and pushes along the ship\'s axis (full power 4 m/s²)');
  return { state, questions: {
    a: { type: 'choice', instructions: `${M} What throttle do you set right now?`, criteria: Object.fromEntries(order.map(k => [k, thr[k]])) },
    b: joy ? { type: 'choice', instructions: `${M} Where do you put the steering joystick right now?`, criteria: { a: 'joystick center', b: 'joystick left', c: 'joystick right' } }
      : { type: 'choice', instructions: `${M} How do you tilt the ship right now?`, criteria: { upright: 'keep the ship upright', left: 'tilt left', right: 'tilt right' } } } }; }
export function scenePayload(s, variant, hist = [], engineOn = false, last = null) {
  if (SCENE_T.includes(variant)) return scenePayloadT(s, variant, last);
  const [, kind, form] = variant.match(/^scene_s(\d)([abc])$/) || [, '1', 'a'];
  let state = kind === '2' ? proseS2(s, engineOn) : kind === '4' ? proseS1(s, engineOn) + ' Impressions: ' + perceive(s) : proseS1(s, engineOn);
  if (kind === '3' && hist.length) state += ' Recent moments: ' + hist.slice(-2).map(frame).join(' ');
  const M = SCENE_MISSION;
  if (form === 'a') return { state, questions: { q: { type: 'choice', instructions: `${M} Which controls do you set right now?`, criteria: { ...CTRL } } } };
  if (form === 'b') return { state, questions: {
    a: { type: 'noul', instructions: `${M} Do you fire the main engine right now?`, criteria: { true: 'fire the main engine', false: 'leave the main engine off' } },
    b: { type: 'choice', instructions: `${M} How do you tilt the ship right now?`, criteria: { upright: 'keep the ship upright', left: 'tilt left', right: 'tilt right' } } } };
  return { state, questions: {
    a: { type: 'noul', instructions: `${M} Do you fire the main engine right now?`, criteria: { true: 'fire the main engine', false: 'leave the main engine off' } },
    b: { type: 'noul', instructions: `${M} Do you tilt the ship left right now?`, criteria: { true: 'tilt left', false: 'do not tilt left' } },
    c: { type: 'noul', instructions: `${M} Do you tilt the ship right right now?`, criteria: { true: 'tilt right', false: 'do not tilt right' } } } };
}
// Code maps control NAMES to inputs only. Form c: exactly one of left/right = yes → that tilt, otherwise upright (documented tie rule).
export function sceneRead(variant, a) {
  if (SCENE_T.includes(variant)) { const th = a.a?.choice in THROTTLE ? a.a.choice : 'off', c = ({ a: 'upright', b: 'left', c: 'right' })[a.b?.choice] ?? a.b?.choice, tilt = c === 'left' || c === 'right' ? c : 'center', p0 = a.b?.probabilities || {}, p = 'a' in p0 ? { upright: p0.a, left: p0.b, right: p0.c } : p0, pa = a.a?.probabilities || {};
    return { ctrl: th + '_' + (tilt === 'center' ? 'upright' : tilt), throttle: th, thrust: THROTTLE[th] || false, tilt, pThrust: 1 - (pa.off ?? 0), throttleP: pa, tiltP: { center: p.upright ?? 0, left: p.left ?? 0, right: p.right ?? 0 } }; }
  const form = variant.slice(-1);
  if (form === 'a') { const k = a.q?.choice in CTRL ? a.q.choice : 'off_upright', [e, t] = k.split('_'); const pr = a.q?.probabilities || {};
    return { ctrl: k, thrust: e === 'on', tilt: t === 'upright' ? 'center' : t, pThrust: (pr.on_upright ?? 0) + (pr.on_left ?? 0) + (pr.on_right ?? 0), tiltP: { center: (pr.on_upright ?? 0) + (pr.off_upright ?? 0), left: (pr.on_left ?? 0) + (pr.off_left ?? 0), right: (pr.on_right ?? 0) + (pr.off_right ?? 0) } }; }
  const pT = a.a?.noul ?? 0, thrust = pT > 0.5;
  let tilt, tiltP;
  if (form === 'b') { const c = a.b?.choice; tilt = c === 'left' || c === 'right' ? c : 'center'; const p = a.b?.probabilities || {}; tiltP = { center: p.upright ?? 0, left: p.left ?? 0, right: p.right ?? 0 }; }
  else { const L = (a.b?.noul ?? 0) > 0.5, R = (a.c?.noul ?? 0) > 0.5; tilt = L && !R ? 'left' : R && !L ? 'right' : 'center'; tiltP = { left: a.b?.noul ?? 0, right: a.c?.noul ?? 0 }; }
  return { ctrl: (thrust ? 'on_' : 'off_') + (tilt === 'center' ? 'upright' : tilt), thrust, tilt, pThrust: pT, tiltP };
}
