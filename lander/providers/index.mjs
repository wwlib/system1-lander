// Provider adapters. Every caller builds one Ollama-style /v1/systemone body:
//   { model, state, questions: { q: { type: 'noul'|'choice', instructions, criteria } }, keep_alive }
// and gets back { answers: { q: { noul } | { choice, probabilities } }, usage }.
// Each adapter maps that to its service and normalizes the reply. Keys come only from env (.env), never from code.
// Status: 'ollama' is tested. 'jev', 'msd1' (Azure Foundry) and 'openrouter' are written from public docs and UNTESTED (no keys).
const E = process.env;
const strip = (b, model) => { const { keep_alive, ...rest } = b; return model ? { ...rest, model } : rest; };
const norm = j => (j && j.answers ? j : j?.data?.answers ? j.data : j); // tolerate a {data:{...}} wrapper

export const ADAPTERS = {
  // Local/remote Ollama (tested). OLLAMA_URL / OLLAMA_URL2.
  ollama: url => ({ url: `${url}/v1/systemone`, headers: {}, body: b => b, tested: true }),
  // TypeSafe Jev (docs: jevtypesafeai.com/how-to-use): POST https://api.typesafe.ai/v1/systemone, Bearer key, model 'jev-latest'.
  // Same {state, questions} shape; docs show noul with instructions only — we pass criteria too (assumed accepted/ignored).
  jev: () => ({ url: `${E.JEV_URL || 'https://api.typesafe.ai'}/v1/systemone`, headers: { authorization: `Bearer ${E.JEV_API_KEY}` }, body: b => strip(b, E.JEV_MODEL || 'jev-latest'), tested: false }),
  // Microsoft-Decision-1 on Azure Foundry (docs: learn.microsoft.com .../use-foundry-models-microsoft-decision):
  // POST <endpoint>/providers/microsoft/v1/systemone, header api-key, model = your DEPLOYMENT name. noul criteria {true,false} is documented.
  msd1: () => ({ url: `${(E.AZURE_ENDPOINT || '').replace(/\/$/, '')}/providers/microsoft/v1/systemone`, headers: { 'api-key': E.AZURE_API_KEY }, body: b => strip(b, E.AZURE_DEPLOYMENT), tested: false }),
  // Microsoft-Decision-1 via OpenRouter Decisions API (not the chat endpoint). Model 'microsoft/microsoft-decision-1'.
  // ASSUMED path /api/v1/decisions (the model page shows base https://openrouter.ai/api and SDK alpha.decisions.create).
  openrouter: () => ({ url: E.OPENROUTER_DECISIONS_URL || 'https://openrouter.ai/api/v1/decisions', headers: { authorization: `Bearer ${E.OPENROUTER_API_KEY}`, 'x-title': 'system1-lander' }, body: b => strip(b, E.OPENROUTER_MODEL || 'microsoft/microsoft-decision-1'), tested: false }),
};
// Host table shown in the UI dropdown: Ollama hosts always (primary), hosted providers only when their key/endpoint is configured.
export function hostTable() {
  const H = { primary: { kind: 'ollama', label: E.OLLAMA_LABEL || 'Ollama (primary)', ...ADAPTERS.ollama(E.OLLAMA_URL || 'http://localhost:11434') } };
  if (E.OLLAMA_URL2) H.secondary = { kind: 'ollama', label: E.OLLAMA_LABEL2 || 'Ollama (secondary)', ...ADAPTERS.ollama(E.OLLAMA_URL2) };
  if (E.JEV_API_KEY) H.jev = { kind: 'jev', label: 'TypeSafe Jev (untested)', ...ADAPTERS.jev() };
  if (E.AZURE_API_KEY && E.AZURE_ENDPOINT && E.AZURE_DEPLOYMENT) H.msd1 = { kind: 'msd1', label: 'MS Decision-1 · Foundry (untested)', ...ADAPTERS.msd1() };
  if (E.OPENROUTER_API_KEY) H.openrouter = { kind: 'openrouter', label: 'MS Decision-1 · OpenRouter (untested)', ...ADAPTERS.openrouter() };
  return H; }
export async function send(h, bodyStr, signal) { const b = h.body(JSON.parse(bodyStr)), sent = JSON.stringify(b);
  const r = await fetch(h.url, { method: 'POST', headers: { 'content-type': 'application/json', ...h.headers }, body: sent, signal });
  if (!r.ok || h.kind === 'ollama') return { r, sent };
  const j = norm(await r.json()); return { r: new Response(JSON.stringify(j), { status: r.status, headers: { 'content-type': 'application/json' } }), sent }; }
