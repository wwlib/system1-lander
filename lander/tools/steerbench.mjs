import '../env.mjs';
// Offline steering-wording bench: perception scene prose (facts + impressions, no action advice) is fixed;
// only the steering control wording / options / framing varies. Direct /v1/systemone calls, no game.
// REFERENCE rule (simple, documented): let dx = pad centre − x, pace = min(3, |dx|/8)
//   over the pad (|dx| ≤ 15 m):  |vx| > 1 → steer against vx (to stop drifting), else none
//   else moving away or not moving toward the pad (vx·dx ≤ 0 or |vx| ≤ 0.3) → steer toward the pad
//   else toward but too fast (|vx| > 1.3·pace + 0.3) → steer away (brake)
//   else toward but slow (|vx| < 0.6·pace) → steer toward;  else (on track) → none
// The impressions use the same thresholds, so they describe the situation the rule reacts to (they never name the control).
// env: MODELS=tev1:4b,nimble:9b,tev1:0.8b  W=comma list of wordings  ORDERS=2|6  OUT=../results/steer-bench.txt
import fs from 'node:fs';
import { newState, PAD, proseS1, proseS5, perceive } from '../sim.mjs';
const URL = (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone';
const MODELS = (process.env.MODELS || 'tev1:4b,nimble:9b,tev1:0.8b').split(',');
const C = (PAD.x0 + PAD.x1) / 2;
function ref(s) { const dx = C - s.x, pace = Math.min(3, Math.abs(dx) / 8), sv = Math.sign(dx), vx = s.vx;
  if (Math.abs(dx) <= 15) return Math.abs(vx) > 1 ? (vx > 0 ? 'left' : 'right') : 'none';
  if (vx * dx <= 0 || Math.abs(vx) <= 0.3) return sv > 0 ? 'right' : 'left';
  if (Math.abs(vx) > 1.3 * pace + 0.3) return sv > 0 ? 'left' : 'right';
  if (Math.abs(vx) < 0.6 * pace) return sv > 0 ? 'right' : 'left';
  return 'none'; }
// Balanced set: pad left / right / below × drifting toward / away / still × fast / slow → ~40 states.
const STATES = []; let seed = 7; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
for (const dx of [-70, -35, -12, 0, 10, 30, 75]) for (const vx of [-3.5, -1.6, -0.6, 0, 0.6, 1.6, 3.5]) {
  if (rnd() < 0.18) continue; const s = newState({ x: C - dx, y: 30 + Math.round(rnd() * 60), vx }); s.vy = -(1 + Math.round(rnd() * 30) / 10); s.fuel = 60; STATES.push(s); }
const S = STATES.filter((_, i) => i % Math.ceil(STATES.length / 40) === 0).slice(0, 40);
const dist = S.reduce((a, s) => (a[ref(s)]++, a), { left: 0, right: 0, none: 0 });
// prose: facts + impressions (pad wording variants replace the pad sentence)
function prose(s, padW, lastSteer) { if (padW === 's5' || padW === 's5only') return proseS5(s) + (lastSteer ? ` Last steering input: ${lastSteer}.` : '') + (padW === 's5' ? ' Impressions: ' + perceive(s) : '');
  let p = proseS1(s, false).replace(/ The main engine is (on|off)\.$/, ''), dx = C - s.x;
  if (padW === 'ahead') p = p.replace(/The landing pad[^.]*\./, Math.abs(dx) <= 15 ? 'The landing pad is directly below you.' : `The landing pad is ahead-${dx > 0 ? 'right' : 'left'} of you, ${Math.abs(dx).toFixed(0)} meters away.`);
  if (padW === 'xpos') p = p.replace(/The landing pad[^.]*\./, `Your position is x=${s.x.toFixed(0)} m. The landing pad spans x=${PAD.x0} to x=${PAD.x1} m (x increases to the right).`);
  if (lastSteer) p += ` Last steering input: ${lastSteer}.`;
  return p + ' Impressions: ' + perceive(s); }
const MISSION = 'You are piloting a lunar lander. Goal: touch down gently and upright on the landing pad. A touchdown is survivable only on the pad, drifting slower than 2 m/s.';
// wordings: labels for left/right/none, question text, optional controls-explanation sentence
const W = {
  fly: { L: 'fly left', R: 'fly right', N: 'hold', q: 'Which way do you fly the ship sideways right now?', ex: 'Flying left pushes the ship toward the left; flying right pushes it toward the right.' },
  move: { L: 'move left', R: 'move right', N: 'stay', q: 'Which way do you move the ship sideways right now?', ex: 'Moving left pushes the ship toward the left; moving right pushes it toward the right.' },
  push: { L: 'push left', R: 'push right', N: 'none', q: 'Which sideways push do you apply right now?', ex: 'Pushing left accelerates the ship toward the left; pushing right accelerates it toward the right.' },
  thrust: { L: 'thrust sideways left', R: 'thrust sideways right', N: 'no sideways thrust', q: 'Which sideways thrust do you apply right now?', ex: 'Sideways thrust left accelerates the ship toward the left; right accelerates it toward the right.' },
  tilt: { L: 'tilt left', R: 'tilt right', N: 'stay level', q: 'How do you tilt the ship right now?', ex: 'Tilting left pushes the ship toward the left; tilting right pushes it toward the right.' },
  joy: { L: 'joystick left', R: 'joystick right', N: 'joystick center', q: 'Where do you put the steering joystick right now?', ex: 'Joystick left pushes the ship toward the left; joystick right pushes it toward the right.' },
  pad: { L: 'press LEFT', R: 'press RIGHT', N: 'no input', q: 'Which game-controller input do you give right now?', ex: 'LEFT pushes the ship toward the left; RIGHT pushes it toward the right.' },
};
const ORD = { n: ['N', 'L', 'R'], r: ['R', 'L', 'N'], a: ['L', 'N', 'R'], b: ['R', 'N', 'L'], c: ['N', 'R', 'L'], d: ['L', 'R', 'N'] };
const KEY = { L: 'left', R: 'right', N: 'none' }; // neutral-ish keys mapped back; criteria text carries the wording
function choiceQ(w, ex, ord) { const o = Object.fromEntries(ORD[ord].map(k => [String.fromCharCode(97 + ORD[ord].indexOf(k)), w[k]]));
  return { q: { type: 'choice', instructions: `${MISSION}${ex ? ' ' + w.ex : ''} ${w.q}`, criteria: o } }; }
const decodeChoice = (ord, ch) => KEY[ORD[ord][ch.charCodeAt(0) - 97]] ?? 'none';
async function call(model, state, questions) { const t = performance.now(); const j = await (await fetch(URL, { method: 'POST', body: JSON.stringify({ model, state, questions, keep_alive: '30m' }) })).json(); return { j, ms: performance.now() - t }; }
// configs: [label, wordingKey, explain?, form ('choice'|'yesno'), padWording, withLast]
const CFG = [];
for (const k of Object.keys(W)) for (const ex of [false, true]) CFG.push([`${k}${ex ? '+ex' : ''}`, k, ex, 'choice', 'side', false]);
const extra = process.env.EXTRA_CFG !== '0';
if (process.env.S5) { CFG.length = 0; for (const k of ['joy', 'pad']) { CFG.push([k, k, false, 'choice', 's5', false], [k, k, false, 'choice', 's5only', false], [k, k, false, 'choice', 'ahead', false]); } }
const ONLY = process.env.W ? process.env.W.split(',') : null; // e.g. W=joy,pad,tilt,move
const CFG2 = ONLY ? CFG.filter(c => ONLY.includes(c[0])) : CFG;
async function run(model, cfg, orders) { const [label, wk, ex, form, padW, withLast] = cfg, w = W[wk];
  const conf = { left: { left: 0, right: 0, none: 0 }, right: { left: 0, right: 0, none: 0 }, none: { left: 0, right: 0, none: 0 } };
  let ok = 0, n = 0, flips = 0, ms = 0, tok = 0, calls = 0;
  for (const s of S) { const r = ref(s), last = withLast ? w.N : null, st = prose(s, padW, last); const ans = [];
    for (const ord of orders) { let a;
      if (form === 'yesno') { const qs = { q: { type: 'noul', instructions: `${MISSION}${ex ? ' ' + w.ex : ''} Do you ${w.L.replace(/^press /, 'press ')} right now?`, criteria: { true: w.L, false: `not ${w.L}` } } };
        const q2 = { q: { type: 'noul', instructions: `${MISSION}${ex ? ' ' + w.ex : ''} Do you ${w.R} right now?`, criteria: { true: w.R, false: `not ${w.R}` } } };
        const [A, B] = ord === 'n' ? [await call(model, st, qs), await call(model, st, q2)] : [await call(model, st, q2), await call(model, st, qs)].reverse();
        const pl = A.j.answers?.q?.noul ?? 0, pr = B.j.answers?.q?.noul ?? 0; a = pl > 0.5 && pr <= 0.5 ? 'left' : pr > 0.5 && pl <= 0.5 ? 'right' : 'none';
        ms += A.ms + B.ms; tok += (A.j.usage?.input_tokens || 0) + (B.j.usage?.input_tokens || 0); calls += 2; }
      else { const { j, ms: m } = await call(model, st, choiceQ(w, ex, ord)); a = decodeChoice(ord, j.answers?.q?.choice || 'a'); ms += m; tok += j.usage?.input_tokens || 0; calls++; }
      ans.push(a); conf[r][a]++; ok += a === r; n++; }
    if (new Set(ans).size > 1) flips++; }
  return { label: label + (form === 'yesno' ? ' yes/no' : '') + (padW !== 'side' ? ` pad:${padW}` : '') + (withLast ? ' +last' : ''), model, acc: ok / n, conf, bias: flips / S.length, ms: ms / calls * (form === 'yesno' ? 2 : 1), tok: tok / calls * (form === 'yesno' ? 2 : 1) }; }
const fmtC = c => ['left', 'right', 'none'].map(r => `${r[0].toUpperCase()}→${c[r].left}/${c[r].right}/${c[r].none}`).join(' ');
const out = [`# steer-bench  ${new Date().toISOString()}  states=${S.length} reference dist ${JSON.stringify(dist)}  (majority-class baseline ${(Math.max(...Object.values(dist)) / S.length * 100).toFixed(0)}%)`,
  '# acc = mean over option orders; bias = share of states whose answer changes with option order; conf = ref→answers left/right/none'];
const res = [];
const orders = (process.env.ORDERS || '2') === '6' ? Object.keys(ORD) : ['n', 'r'];
for (const model of MODELS) { const cfgs = model === 'tev1:0.8b' ? CFG2.filter(c => !c[2]) : CFG2;
  for (const c of cfgs) { const r = await run(model, c, orders); res.push(r); console.log(`${r.model} ${r.label}: ${(r.acc * 100).toFixed(0)}% bias ${(r.bias * 100).toFixed(0)}% ${r.ms | 0}ms`); } }
// follow-ups on the best 2 wordings for the main model: yes/no form, pad wording, last command, 6 permutations
const best = res.filter(r => r.model === MODELS[0]).sort((a, b) => b.acc - a.acc).slice(0, 2);
if (extra && !process.env.S5) for (const b of best) { const c = CFG.find(c => c[0] === b.label);
  for (const v of [[...c.slice(0, 3), 'yesno', 'side', false], [...c.slice(0, 4), 'ahead', false], [...c.slice(0, 4), 'xpos', false], [...c.slice(0, 4), 'side', true]]) {
    const r = await run(MODELS[0], v, orders); res.push(r); console.log(`${r.model} ${r.label}: ${(r.acc * 100).toFixed(0)}%`); }
  const r6 = await run(MODELS[0], c, Object.keys(ORD)); r6.label += ' (6 orders)'; res.push(r6); console.log(`${r6.model} ${r6.label}: ${(r6.acc * 100).toFixed(0)}% bias ${(r6.bias * 100).toFixed(0)}%`); }
res.sort((a, b) => b.acc - a.acc);
out.push('| rank | wording | model | accuracy | bias | confusion (ref L/R/N → answered L/R/N) | ms/decision | tok/decision |', '|---|---|---|---|---|---|---|---|');
res.forEach((r, i) => out.push(`| ${i + 1} | ${r.label} | ${r.model} | ${(r.acc * 100).toFixed(0)}% | ${(r.bias * 100).toFixed(0)}% | ${fmtC(r.conf)} | ${r.ms | 0} | ${r.tok | 0} |`));
fs.writeFileSync(new globalThis.URL(process.env.OUT || '../../results/steer-bench.txt', import.meta.url), out.join('\n') + '\n'); console.log(out.slice(0, 2).join('\n'));
