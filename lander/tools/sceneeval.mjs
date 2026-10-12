import '../env.mjs';
// Offline eval of SCENE variants: model's controls vs the hand-written rule reference (modelState in sim.mjs) on ~30 states
// sampled from reference flights (same sampling as evalq.mjs). For s3, history frames come from the preceding samples with the reference's controls.
// Agreement with the rule is a rough proxy (the rule is one reasonable policy, not the only correct one).
import { newState, step, modelState, scenePayload, sceneRead, SCENE_VARIANTS } from '../sim.mjs';
const URL = (process.env.OLLAMA_URL || 'http://localhost:11434') + '/v1/systemone', MODEL = process.env.MODEL || 'tev1:4b', N = +(process.env.N || 30);
const VS = process.env.V ? process.env.V.split(',') : SCENE_VARIANTS;
const S = []; for (const st of [{ x: 40 }, { x: 135, vx: 2 }, { x: 80, vx: -3, y: 100 }, { x: 20, y: 140 }]) { const s = newState(st); let i = 0, hist = [];
  while (!s.outcome) { const m = modelState(s), ctrl = (m.engine === 'burn' ? 'on_' : 'off_') + (m.steer === 'none' ? 'upright' : m.steer);
    if (i++ % 6 == 0) { S.push({ s: { ...s }, hist: hist.map(h => ({ ...h, ago: s.t - h.t })), m }); hist.push({ t: s.t, s: { ...s }, ctrl }); if (hist.length > 2) hist.shift(); }
    for (let t = 0; t < .5; t += 1 / 60) step(s, 1 / 60, m.engine === 'burn', m.steer === 'none' ? 'center' : m.steer); } }
const pick = S.filter((_, i) => i % Math.ceil(S.length / N) == 0);
for (const V of VS) { let okE = 0, okT = 0, both = 0, lat = 0, tok = 0; const cnt = {}, bad = [];
  for (const x of pick) { const p = scenePayload(x.s, V, x.hist, false), t0 = performance.now();
    const j = await (await fetch(URL, { method: 'POST', body: JSON.stringify({ model: MODEL, ...p, keep_alive: '30m' }) })).json(); lat += performance.now() - t0; tok = j.usage?.input_tokens ?? tok;
    const r = sceneRead(V, j.answers || {}), refT = x.m.steer === 'none' ? 'center' : x.m.steer, eE = r.thrust === (x.m.engine === 'burn'), eT = r.tilt === refT;
    okE += eE; okT += eT; both += eE && eT; cnt[r.ctrl] = (cnt[r.ctrl] || 0) + 1; if (!(eE && eT) && bad.length < 3) bad.push(`${p.state.slice(0, 120)}… → ${r.ctrl} (ref ${x.m.engine}/${refT})`); }
  const n = pick.length; console.log(`${MODEL} ${V}: engine ${okE}/${n}, tilt ${okT}/${n}, both ${both}/${n}, ${Math.round(lat / n)} ms, ${tok} tok, picks ${JSON.stringify(cnt)}`);
  if (process.env.BAD) bad.forEach(b => console.log('   ', b)); }
