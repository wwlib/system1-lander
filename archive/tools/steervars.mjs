import '../env.mjs';
// Steering question variants. Each: state(dx, vx, x, padX) -> state obj; questions; decode(answers, dx) -> 'left'|'center'|'right'.
// "code" in decode is only a fixed mapping from the model's answers (relative->absolute, facts->action); no thresholds on physics.
const r1 = v => Math.round(v * 10) / 10;
const side = v => (v > 0 ? 'right' : 'left');
const words = (dx, vx) => ({ pad_side: Math.abs(dx) < 0.5 ? 'below' : side(dx), pad_distance_m: r1(Math.abs(dx)), sideways_motion: Math.abs(vx) < 0.05 ? 'none' : side(vx), sideways_speed_mps: r1(Math.abs(vx)) });
const RULE = 'Good approach speed is distance/8 m/s (max 3), so slow down as the pad gets close.';
const rel = (a, dx) => a === 'center' || a === 'hold' ? 'center' : (a === 'toward' ? side(dx) : side(-dx));
const relQ = (instr) => ({ steer: { type: 'choice', instructions: instr, criteria: {
  toward: 'push toward the pad: not moving toward it, or approaching slower than the good speed',
  hold: 'keep as is: approaching at about the good speed',
  away: 'push away from the pad (brake): approaching faster than the good speed, or moving away from it' } } });
const absQ = (order = ['left', 'center', 'right']) => { const c = { left: 'vx_mps is above wanted (too fast rightward or not left enough)', center: 'vx_mps about equal to wanted', right: 'vx_mps is below wanted (too fast leftward or not right enough)' };
  return { tilt: { type: 'choice', instructions: 'Lander steering. dx_to_pad_m>0 = pad is right. Wanted sideways speed is about dx_to_pad_m/8 m/s (max 3 either way); slow down as you get close.', criteria: Object.fromEntries(order.map(k => [k, c[k]])) } }; };
export const STEER = {
  base: { state: (dx, vx) => ({ vx_mps: r1(vx), dx_to_pad_m: r1(dx) }), questions: absQ(), decode: a => a.tilt.choice },
  base_perm: { state: (dx, vx) => ({ vx_mps: r1(vx), dx_to_pad_m: r1(dx) }), questions: absQ(['right', 'center', 'left']), decode: a => a.tilt.choice },
  base_perm2: { state: (dx, vx) => ({ vx_mps: r1(vx), dx_to_pad_m: r1(dx) }), questions: absQ(['center', 'right', 'left']), decode: a => a.tilt.choice },
  words_abs: { state: words, questions: { tilt: { type: 'choice', instructions: 'Lander steering. Steer toward the pad; ' + RULE + ' Steering right pushes right, left pushes left.',
    criteria: { left: 'pad is left and approach too slow, or pad is right and approaching too fast', center: 'approaching at about the good speed', right: 'pad is right and approach too slow, or pad is left and approaching too fast' } } }, decode: a => a.tilt.choice },
  xpos: { state: (dx, vx, x, px) => ({ lander_x_m: r1(x), pad_x_m: px, vx_mps: r1(vx) }), questions: { tilt: { type: 'choice', instructions: 'Lander steering. x grows to the right. Steer so the lander approaches pad_x_m; good approach speed is |pad_x_m-lander_x_m|/8 m/s (max 3).',
    criteria: { left: 'should be moving more to the left than now', center: 'sideways speed about right', right: 'should be moving more to the right than now' } } }, decode: a => a.tilt.choice },
  rel: { state: words, questions: relQ('Lander steering relative to the pad. ' + RULE + ' "approaching" means sideways_motion is the same as pad_side.'), decode: (a, dx) => rel(a.steer.choice, dx) },
  rel_fs: { state: words, questions: relQ('Lander steering relative to the pad. ' + RULE + ' "approaching" means sideways_motion equals pad_side. Examples: pad right 80 m, moving right 1 → toward. pad left 40 m, moving right 2 → toward. pad right 10 m, moving right 4 → away. pad left 24 m, moving left 3 → hold. pad below 0 m, motion none → hold.'), decode: (a, dx) => rel(a.steer.choice, dx) },
  facts: { state: words, questions: {
      approaching: { type: 'noul', instructions: 'Is the lander moving toward the pad? (sideways_motion equals pad_side)', criteria: { true: 'moving toward the pad', false: 'not moving toward the pad' } },
      too_fast: { type: 'noul', instructions: 'Is sideways_speed_mps greater than pad_distance_m/8 (max 3)?', criteria: { true: 'faster than that', false: 'not faster' } },
      too_slow: { type: 'noul', instructions: 'Is sideways_speed_mps less than pad_distance_m/8 (max 3) minus 0.3?', criteria: { true: 'slower than that', false: 'not slower' } } },
    decode: (a, dx) => { const ap = a.approaching.noul > .5, f = a.too_fast.noul > .5, sl = a.too_slow.noul > .5;
      return rel(!ap ? 'toward' : f ? 'away' : sl ? 'toward' : 'hold', dx); } },
};
export function oracleSteer(dx, vx) { const want = Math.sign(dx) * Math.min(Math.abs(dx) / 8, 3), e = vx - want; return e < -0.3 ? 'right' : e > 0.3 ? 'left' : 'center'; }
// facts2: three atomic facts the model answers; code maps facts -> action with a fixed table (no physics math in code).
const F2Q = {
  pad_right: { type: 'noul', instructions: 'Is the pad to the right of the lander?', criteria: { true: 'pad_side is right', false: 'pad_side is left' } },
  moving_right: { type: 'noul', instructions: 'Is the lander moving to the right?', criteria: { true: 'sideways_motion is right', false: 'sideways_motion is left or none' } },
  too_fast: { type: 'noul', instructions: 'Is sideways_speed_mps greater than pad_distance_m divided by 8, or greater than 3?', criteria: { true: 'yes, too fast for the distance', false: 'no' } } };
export function factsToSteer(padRight, movingRight, tooFast, stopped = false) {
  const toward = padRight ? 'right' : 'left', away = padRight ? 'left' : 'right';
  const approaching = !stopped && movingRight === padRight;
  return !approaching ? toward : tooFast ? away : toward;
}
STEER.facts2 = { state: words, questions: F2Q,
  decode: a => factsToSteer(a.pad_right.noul > .5, a.moving_right.noul > .5, a.too_fast.noul > .5) };
STEER.facts2_min = { state: (dx, vx) => ({ pad_side: dx > 0 ? 'right' : 'left', sideways_motion: vx > 0 ? 'right' : vx < 0 ? 'left' : 'none', pad_distance_m: r1(Math.abs(dx)), sideways_speed_mps: r1(Math.abs(vx)) }), questions: F2Q,
  decode: a => factsToSteer(a.pad_right.noul > .5, a.moving_right.noul > .5, a.too_fast.noul > .5) };
