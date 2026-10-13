import './env.mjs';
import { hostTable, send } from './providers/index.mjs';
import { ACTIONS, DATA_Q, DATA_TABLE, dataMap, dataThrust } from './sim.mjs';
import { proseSet, perceive, proseMap, PROSE_TABLE } from './prose.mjs';
import { POLICY_Q, POLICY_TABLE, policyMap, policyNames, policyText, shipJSON } from './policy.mjs';
import { examples } from './examples.mjs';
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
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
// Modes (ids are what /decide, headless VARIANT and .env VARIANT take).
export const MODES = () => [
  { id: 'prose', label: 'Prose input (choice questions)' },
  { id: 'data', label: 'Data input (yes/no fact checks)' },
  ...policyNames().map(n => ({ id: 'policy:' + n, label: `Policy (plain-English rules): ${n}` })),
];
const modeId = v => MODES().some(m => m.id === v) ? v : 'prose';
export const DEFAULTS = { variant: modeId(process.env.VARIANT), model: MODEL, host: DEFAULT_HOST, hosts: HOSTS, hostLabels: HOST_LABELS, timeScale: +(process.env.TIME_SCALE || 1) };
const KEEP = '2h';
const probsFor = (thrust, tilt) => Object.fromEntries(Object.entries(ACTIONS).map(([k, [b, t]]) => [k, (b === !!thrust ? 1 : 0) * (t === tilt ? 1 : 0)]));
async function call(hostKey, request) { const body = JSON.stringify(request), c0 = performance.now(), P = await post(hostKey, body), r = P.r;
  if (!r.ok) throw new Error(`upstream ${r.status}: ${await r.text()}`); const raw = await r.text();
  return { body, request, raw, j: JSON.parse(raw), url: P.url, fellBack: P.fellBack, ms: Math.round(performance.now() - c0) }; }
// PROSE: one call; state = perception sentences; questions from lander/modes/prose.json.
async function decideProse(s, model, t0, opt) {
  const set = proseSet(), C = await call(opt.host, { model, state: perceive(s, set), questions: set.questions, keep_alive: KEEP }), A = C.j.answers || {}, M = proseMap(A, s), thrust = M.throttle > 0 ? M.throttle : false;
  return { variant: 'prose', model, thrust, tilt: M.tilt, action: (thrust ? 'burn_' : 'coast_') + M.tilt, throttle: Math.round(M.throttle * 100) + '%', tvx: M.tvx, answers: A, table: PROSE_TABLE,
    probs: probsFor(thrust, M.tilt), usage: C.j.usage, ms: Math.round(performance.now() - t0), fellBack: C.fellBack, upstream: { url: C.url, body: C.body, request: C.request, rawResponse: C.raw, response: C.j }, simState: s };
}
// DATA: a chain of tiny yes/no fact calls (neutral key "q"), later ones skipped when earlier answers decide.
async function decideData(s, model, t0, opt) {
  const ans = {}, calls = []; let url, fellBack = false;
  for (const m of DATA_Q) {
    if (m.skipIf && m.skipIf(ans)) { calls.push({ name: m.name, skipped: true }); continue; }
    const C = await call(opt.host, { model, state: m.state(s), questions: { q: m.q }, keep_alive: KEEP }), A = C.j.answers?.q ?? {}; url = C.url; fellBack = fellBack || C.fellBack;
    const p = m.read ? (A.probabilities?.touching_down ?? (m.read(A) ? 1 : 0)) : A.noul ?? 0; ans[m.name] = m.read ? m.read(A) : p > 0.5; ans[m.name + '_p'] = p;
    calls.push({ name: m.name, body: C.body, request: C.request, rawResponse: C.raw, response: C.j, p, answer: ans[m.name], usage: C.j.usage, ms: C.ms });
  }
  const tilt = dataMap(ans), thrust = dataThrust(ans), done = calls.filter(x => !x.skipped);
  const usage = { input_tokens: done.reduce((a, x) => a + (x.usage?.input_tokens || 0), 0), output_tokens: done.reduce((a, x) => a + (x.usage?.output_tokens || 0), 0), calls: done.length };
  return { variant: 'data', model, thrust, tilt, action: (thrust ? 'burn_' : 'coast_') + tilt, answers: ans, table: DATA_TABLE, probs: probsFor(thrust, tilt), usage, ms: Math.round(performance.now() - t0),
    fellBack, upstream: { url, multi: true, calls, body: done[0].body }, simState: s };
}
// POLICY: 4 judgment calls against a plain-English policy file; graded probabilities → throttle/steer.
async function decidePolicy(s, model, t0, opt, name) {
  const policy = policyText(name), ship = shipJSON(s), ans = {}, calls = []; let url, fellBack = false;
  for (const m of POLICY_Q) {
    const C = await call(opt.host, { model, state: { policy, ship }, questions: { q: m.q }, keep_alive: KEEP }), p = C.j.answers?.q?.noul ?? 0; url = C.url; fellBack = fellBack || C.fellBack;
    ans[m.name] = p > 0.5; ans[m.name + '_p'] = Math.round(p * 1000) / 1000;
    calls.push({ name: m.name, body: C.body, request: C.request, rawResponse: C.raw, response: C.j, p, answer: ans[m.name], usage: C.j.usage, ms: C.ms });
  }
  const { throttle, tilt } = policyMap(ans, s), thrust = throttle > 0 ? throttle : false;
  const usage = { input_tokens: calls.reduce((a, x) => a + (x.usage?.input_tokens || 0), 0), output_tokens: calls.reduce((a, x) => a + (x.usage?.output_tokens || 0), 0), calls: calls.length };
  return { variant: 'policy:' + name, policy: name, policyText: policy, model, thrust, tilt, action: (thrust ? 'burn_' : 'coast_') + tilt, throttle: Math.round(throttle * 100) + '%', answers: ans, table: POLICY_TABLE,
    probs: probsFor(thrust, tilt), usage, ms: Math.round(performance.now() - t0), fellBack, upstream: { url, multi: true, calls, body: calls[0].body }, simState: s };
}
export async function decide(s, opt = {}) {
  const v = modeId(opt.variant || DEFAULTS.variant), model = opt.model || MODEL, t0 = performance.now();
  if (v === 'data') return decideData(s, model, t0, opt);
  if (v.startsWith('policy:')) return decidePolicy(s, model, t0, opt, v.slice(7));
  return decideProse(s, model, t0, opt);
}
// ---- Playground proxy: validate a /v1/systemone body, forward to the chosen host, return timing + raw text ----
export function validateBody(b) {
  const E = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return ['body must be a JSON object'];
  if (typeof b.model !== 'string' || !/^[\w.:/-]{1,100}$/.test(b.model)) E.push('model: required string (letters, digits, . : / - _)');
  if (!(typeof b.state === 'string' || (b.state && typeof b.state === 'object'))) E.push('state: required (JSON object or prose string)');
  if (!b.questions || typeof b.questions !== 'object' || Array.isArray(b.questions) || !Object.keys(b.questions).length) E.push('questions: required non-empty object');
  else for (const [k, q] of Object.entries(b.questions)) {
    if (!/^[\w-]{1,64}$/.test(k)) E.push(`questions key "${k}": letters, digits, _ or -`);
    if (!q || !['noul', 'choice', 'score'].includes(q.type)) { E.push(`questions.${k}.type must be noul, choice or score`); continue; }
    if (typeof q.instructions !== 'string' || !q.instructions.trim()) E.push(`questions.${k}.instructions: required string`);
    if (q.type === 'choice' && (!q.criteria || typeof q.criteria !== 'object' || Array.isArray(q.criteria) || Object.keys(q.criteria).length < 2)) E.push(`questions.${k}.criteria: choice needs an object with 2+ options`);
    if (q.type === 'score' && (!Array.isArray(q.criteria) || q.criteria.length < 2)) E.push(`questions.${k}.criteria: score needs an array of 2+ level descriptions`);
    if (q.type === 'noul' && q.criteria != null && (typeof q.criteria !== 'object' || Array.isArray(q.criteria))) E.push(`questions.${k}.criteria: noul criteria must be {true, false}`);
  }
  if (b.keep_alive != null && !(typeof b.keep_alive === 'string' && /^-?\d+(\.\d+)?(ms|s|m|h)?$/.test(b.keep_alive)) && typeof b.keep_alive !== 'number') E.push('keep_alive: e.g. "30m", "2h", "-1"');
  return E;
}
async function playground(q) {
  const key = hk(q.host), h = HT[key], b = q.body, errs = validateBody(b);
  if (errs.length) return { status: 400, json: { error: 'invalid request', details: errs } };
  const clean = { model: b.model, state: b.state, questions: b.questions, ...(b.keep_alive != null ? { keep_alive: b.keep_alive } : {}) }, body = JSON.stringify(clean), t0 = performance.now();
  try { const { r, sent } = await send(h, body, AbortSignal.timeout(60000)), raw = await r.text(), ms = Math.round(performance.now() - t0); let j = null; try { j = JSON.parse(raw); } catch {}
    return { status: 200, json: { host: key, url: h.url, upstreamStatus: r.status, ms, request: clean, sent: sent !== body ? JSON.parse(sent) : undefined, raw, response: j } };
  } catch (e) { return { status: 502, json: { error: 'upstream failed', details: [String(e.cause?.code || e.message)], host: key, url: h.url, ms: Math.round(performance.now() - t0) } }; }
}
async function models(hostKey) { const h = HT[hk(hostKey)]; if (h.kind !== 'ollama') return { models: [], note: 'model list only for Ollama hosts' };
  const base = h.url.replace(/\/v1\/systemone$/, ''); const r = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(5000) }); const j = await r.json();
  return { host: hk(hostKey), base, models: (j.models || []).map(m => ({ name: m.name, size: m.size, params: m.details?.parameter_size, quant: m.details?.quantization_level })) }; }
if (import.meta.url === `file://${process.argv[1]}`) {
  const json = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  const readBody = async (req, max = 256000) => { let b = ''; for await (const c of req) { b += c; if (b.length > max) throw Object.assign(new Error('body too large'), { code: 413 }); } return b; };
  http.createServer(async (req, res) => {
    try {
      const url = req.url.split('?')[0];
      if (req.method === 'POST' && url === '/decide') { const q = JSON.parse(await readBody(req)); if (!q.sim || typeof q.sim !== 'object') return json(res, 400, { error: 'sim required' }); return json(res, 200, await decide(q.sim, q)); }
      if (req.method === 'POST' && url === '/api/systemone') { let q; try { q = JSON.parse(await readBody(req)); } catch (e) { return json(res, e.code || 400, { error: e.code ? e.message : 'invalid JSON' }); } const o = await playground(q || {}); return json(res, o.status, o.json); }
      if (url === '/api/models') return json(res, 200, await models(new URL(req.url, 'http://x').searchParams.get('host')));
      if (url === '/api/examples') return json(res, 200, examples());
      if (url === '/config') return json(res, 200, { ...DEFAULTS, modes: MODES() });
      const f = url === '/sim.mjs' ? 'sim.mjs' : url.replace(/\/$/, '') === '/playground' ? 'playground.html' : 'index.html';
      res.writeHead(200, { 'content-type': f.endsWith('.mjs') ? 'text/javascript' : 'text/html', 'cache-control': 'no-store' });
      res.end(fs.readFileSync(path.join(DIR, f)));
    } catch (e) { json(res, e.code === 413 ? 413 : 500, { error: String(e.message || e) }); }
  }).listen(PORT, HOST, () => console.log(`lander on http://${HOST}:${PORT} model=${MODEL} mode=${DEFAULTS.variant}`));
}
