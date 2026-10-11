import './env.mjs';
import { hostTable, send } from './providers/index.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
import { payloadFor, ACTIONS, explain, PHYS_VARIANTS, isHybrid, modelState, factsToSteer, MULTI, MULTI_TABLE, multiMap, multiThrust, MULTI2, MULTI2_TABLE, multi2Map, multi2Thrust, PULSE_S, rivalList, RIVAL_TABLE, rivalMap, rivalThrust, PERSONAS } from './sim.mjs';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const HOST = process.env.HOST || '0.0.0.0', PORT = +process.env.PORT || 8787, MODEL = process.env.MODEL || 'tev1:4b', OLLAMA_FORCE = process.env.OLLAMA; // test override (mock): forces every call to this URL
// Hosts/providers come from env (.env): see providers/index.mjs and .env.example.
const HT = hostTable();
export const HOSTS = Object.fromEntries(Object.entries(HT).map(([k, h]) => [k, h.url]));
export const HOST_LABELS = Object.fromEntries(Object.entries(HT).map(([k, h]) => [k, h.label]));
const hk = k => HT[k] ? k : 'primary';
const DEFAULT_HOST = hk(process.env.PROVIDER || process.env.OLLAMA_HOST_KEY || 'primary');
// POST to the chosen host; on a network failure fall back to the other Ollama host (if configured). Hosted providers never fall back.
const downUntil = {};
async function post(hostKey, body) {
  if (OLLAMA_FORCE) { const r = await fetch(`${OLLAMA_FORCE}/v1/systemone`, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); return { r, url: `${OLLAMA_FORCE}/v1/systemone`, fellBack: false }; }
  const key = hk(hostKey || DEFAULT_HOST), h = HT[key], altK = h.kind === 'ollama' ? Object.keys(HT).find(k => k !== key && HT[k].kind === 'ollama') : null, alt = altK && HT[altK];
  if (alt && downUntil[key] > Date.now()) return { ...(await send(alt, body)), url: alt.url, fellBack: 'host down (retry in <30s)' };
  try { return { ...(await send(h, body, AbortSignal.timeout(20000))), url: h.url, fellBack: false }; }
  catch (e) { if (!alt) throw e; downUntil[key] = Date.now() + 30000; return { ...(await send(alt, body)), url: alt.url, fellBack: String(e.cause?.code || e.name) }; }
}
export const DEFAULTS = { mode: process.env.MODE || 'physics', variant: process.env.VARIANT || 'multi2', model: MODEL, host: DEFAULT_HOST, hosts: HOSTS, hostLabels: HOST_LABELS, timeScale: +(process.env.TIME_SCALE || 1) };
const PCACHE = {}; // personality answers: asked from the model once per (model, personality), then reused
async function decideMulti(s, model, t0, hostKey, v2 = false, persona = null) {
  const LIST = persona ? rivalList(persona) : v2 ? MULTI2 : MULTI;
  const ans = {}, calls = []; let url, fellBack = false;
  for (const m of LIST) {
    if (m.skipIf && m.skipIf(ans)) { calls.push({ name: m.name, skipped: true }); continue; }
    const ck = persona && m.name.startsWith('persona_') ? `${model}|${persona}|${m.name}` : null;
    if (ck && PCACHE[ck]) { Object.assign(ans, PCACHE[ck].ans); calls.push({ ...PCACHE[ck].call, cached: true, ms: 0, usage: { input_tokens: 0, output_tokens: 0 } }); continue; }
    const Q = typeof m.q === 'function' ? m.q(ans) : m.q;
    const request = { model, state: m.state(s), questions: { q: Q }, keep_alive: '30m' }, body = JSON.stringify(request), c0 = performance.now();
    const P = await post(hostKey, body), r = P.r; url = P.url; fellBack = fellBack || P.fellBack;
    if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
    const raw = await r.text(), j = JSON.parse(raw), A = j.answers?.q ?? {};
    const p = m.readP ? m.readP(A) : m.read ? (A.probabilities?.touching_down ?? (m.read(A) ? 1 : 0)) : A.noul ?? 0; ans[m.name] = m.read ? m.read(A) : p > 0.5; if (m.name.startsWith('persona_')) ans[m.name] = +ans[m.name]; ans[m.name + '_p'] = p;
    calls.push({ name: m.name, body, sentUpstream: P.sent !== body ? P.sent : undefined, request, rawResponse: raw, response: j, p, answer: ans[m.name], usage: j.usage, ms: Math.round(performance.now() - c0) });
    if (ck) PCACHE[ck] = { ans: { [m.name]: ans[m.name], [m.name + '_p']: p }, call: calls[calls.length - 1] };
  }
  const tilt = persona ? rivalMap(ans) : v2 ? multi2Map(ans) : multiMap(ans), thrust = persona ? rivalThrust(ans) : v2 ? multi2Thrust(ans) : multiThrust(ans), pThrust = thrust ? 1 : 0, c = (thrust ? 'burn_' : 'coast_') + tilt;
  const pr = Object.fromEntries(Object.entries(ACTIONS).map(([k, [b, t]]) => [k, (b ? pThrust : 1 - pThrust) * (t === tilt ? 1 : 0)]));
  const done = calls.filter(x => !x.skipped && !x.cached), usage = { input_tokens: done.reduce((a, x) => a + (x.usage?.input_tokens || 0), 0), output_tokens: done.reduce((a, x) => a + (x.usage?.output_tokens || 0), 0), calls: done.length };
  const first = done[0];
  return { thrustBy: 'model', mode: 'physics', variant: persona ? 'rival' : v2 ? (v2 === 'p' ? 'multi2p' : 'multi2') : 'multi', persona, pulse: v2 === 'p' ? PULSE_S : null, model, thrust, pThrust, tilt, action: c, probs: pr, usage, ms: Math.round(performance.now() - t0), answers: ans, table: persona ? RIVAL_TABLE : v2 ? (v2 === 'p' ? [...MULTI2_TABLE, `burn pulse (game mechanic): engine fires at most ${PULSE_S} s sim time per decision, then coasts`] : MULTI2_TABLE) : MULTI_TABLE,
    fellBack, upstream: { url, multi: true, calls, body: first.body, request: { model, state: Object.assign({}, ...done.map(x => x.request.state)), questions: Object.fromEntries(done.map(x => [x.name, x.request.questions.q])), keep_alive: '30m' }, rawResponse: done.map(x => x.rawResponse).join('\n'), response: done.map(x => x.response) }, simState: s, explain: null };
}
export async function decide(s, opt = {}) {
  const mode = opt.mode === 'hints' ? 'hints' : 'physics', variant = PHYS_VARIANTS[opt.variant] ? opt.variant : DEFAULTS.variant, model = opt.model || MODEL;
  const t0 = performance.now();
  if (opt.variant === 'rival') return decideMulti(s, model, t0, opt.host, true, PERSONAS[opt.persona] ? opt.persona : 'careful');
  if (mode === 'physics' && ['multi', 'multi2', 'multi2p'].includes(variant)) return decideMulti(s, model, t0, opt.host, variant === 'multi2p' ? 'p' : variant === 'multi2');
  const request = { model, ...payloadFor(s, mode, variant), keep_alive: '30m' };
  const body = JSON.stringify(request); // exact bytes sent upstream
  const P = await post(opt.host, body), r = P.r;
  if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
  const raw = await r.text(), j = JSON.parse(raw), a = j.answers || {};
  let c, pr, thrust, tilt, pThrust;
  if (a.act) { c = a.act.choice in ACTIONS ? a.act.choice : 'coast_center'; [thrust, tilt] = ACTIONS[c]; pr = a.act.probabilities ?? {};
    pThrust = (pr.burn_left ?? 0) + (pr.burn_center ?? 0) + (pr.burn_right ?? 0);
  } else { // two-question form: combine noul thrust x tilt choice into the same 6-way view
    const hyb = mode === 'physics' && isHybrid(variant); pThrust = hyb ? (modelState(s).engine === 'burn' ? 1 : 0) : a.thrust?.noul ?? 0; thrust = pThrust > 0.5; tilt = a.pad_right ? factsToSteer(a.pad_right.noul > .5, a.moving_right.noul > .5, a.too_fast.noul > .5, s.vx === 0) : ['left', 'center', 'right'].includes(a.tilt?.choice) ? a.tilt.choice : 'center';
    c = (thrust ? 'burn_' : 'coast_') + tilt; const tp = a.tilt?.probabilities ?? { [tilt]: 1 };
    pr = Object.fromEntries(Object.entries(ACTIONS).map(([k, [b, t]]) => [k, (b ? pThrust : 1 - pThrust) * (tp[t] ?? 0)])); }
  return { thrustBy: mode === 'physics' && isHybrid(variant) ? 'code (descent rule)' : 'model', mode, variant, model, thrust, pThrust, tilt, action: c, probs: pr, usage: j.usage, ms: Math.round(performance.now() - t0),
    fellBack: P.fellBack, upstream: { url: P.url, body, request, rawResponse: raw, response: j }, simState: s, explain: mode === 'hints' ? explain(s) : null };
}
if (import.meta.url === `file://${process.argv[1]}`) {
  http.createServer(async (req, res) => {
    try {
      if (req.method === 'POST' && req.url === '/decide') {
        let b = ''; for await (const c of req) b += c;
        const q = JSON.parse(b), d = q.sim ? await decide(q.sim, q) : await decide(q);
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify(d));
      }
      if (req.url === '/config') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ...DEFAULTS, variants: Object.keys(PHYS_VARIANTS), personas: Object.keys(PERSONAS) })); }
      const f = req.url === '/sim.mjs' ? 'sim.mjs' : 'index.html';
      res.writeHead(200, { 'content-type': f.endsWith('.mjs') ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(path.join(DIR, f)));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ error: String(e) })); }
  }).listen(PORT, HOST, () => console.log(`lander on http://${HOST}:${PORT} model=${MODEL}`));
}
