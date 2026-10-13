// @ts-check
// Provider adapters. Every caller builds one Ollama-style /v1/systemone body:
//   { model, state, questions: { q: { type: 'noul'|'choice', instructions, criteria } }, keep_alive }
// and gets back { answers: { q: { noul } | { choice, probabilities } }, usage }.
// Each adapter maps that body to its service and normalizes the reply.
// API keys come only from the environment (.env), never from code.
// Status: 'ollama' is tested. 'jev', 'msd1' (Azure Foundry) and 'openrouter' were written from
// public docs and are UNTESTED (no keys).

/**
 * One configured host, as shown in the UI dropdown.
 * @typedef {object} Host
 * @property {string} kind      'ollama' | 'jev' | 'msd1' | 'openrouter'
 * @property {string} label
 * @property {string} url       full /v1/systemone (or equivalent) URL
 * @property {Record<string, string>} headers
 * @property {(body: any) => any} body  rewrites the Ollama-style body for this service
 * @property {boolean} tested
 */

const env = process.env;

/**
 * Hosted services take no keep_alive and use their own model name.
 * @param {any} body
 * @param {string | undefined} model
 */
function withoutKeepAlive(body, model) {
  const { keep_alive, ...rest } = body;
  if (model) {
    return { ...rest, model };
  }
  return rest;
}

/**
 * Accept either { answers } or a { data: { answers } } wrapper.
 * @param {any} reply
 */
function normalizeReply(reply) {
  if (reply && reply.answers) {
    return reply;
  }
  if (reply?.data?.answers) {
    return reply.data;
  }
  return reply;
}

export const ADAPTERS = {
  // Local or remote Ollama (tested). Configured with OLLAMA_URL / OLLAMA_URL2.
  /** @param {string} baseUrl */
  ollama: (baseUrl) => ({
    url: `${baseUrl}/v1/systemone`,
    headers: {},
    body: (/** @type {any} */ body) => body,
    tested: true,
  }),

  // TypeSafe Jev (docs: jevtypesafeai.com/how-to-use): POST https://api.typesafe.ai/v1/systemone,
  // Bearer key, model 'jev-latest'. Same {state, questions} shape. The docs show noul with
  // instructions only; we pass criteria too (assumed accepted or ignored).
  jev: () => ({
    url: `${env.JEV_URL || 'https://api.typesafe.ai'}/v1/systemone`,
    headers: { authorization: `Bearer ${env.JEV_API_KEY}` },
    body: (/** @type {any} */ body) => withoutKeepAlive(body, env.JEV_MODEL || 'jev-latest'),
    tested: false,
  }),

  // Microsoft-Decision-1 on Azure Foundry (docs: learn.microsoft.com
  // .../use-foundry-models-microsoft-decision): POST <endpoint>/providers/microsoft/v1/systemone,
  // header api-key, model = your DEPLOYMENT name. noul criteria {true,false} is documented.
  msd1: () => ({
    url: `${(env.AZURE_ENDPOINT || '').replace(/\/$/, '')}/providers/microsoft/v1/systemone`,
    headers: { 'api-key': env.AZURE_API_KEY },
    body: (/** @type {any} */ body) => withoutKeepAlive(body, env.AZURE_DEPLOYMENT),
    tested: false,
  }),

  // Microsoft-Decision-1 via the OpenRouter Decisions API (not the chat endpoint).
  // ASSUMED path /api/v1/decisions (the model page shows base https://openrouter.ai/api and the
  // SDK call alpha.decisions.create).
  openrouter: () => ({
    url: env.OPENROUTER_DECISIONS_URL || 'https://openrouter.ai/api/v1/decisions',
    headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, 'x-title': 'system1-lander' },
    body: (/** @type {any} */ body) =>
      withoutKeepAlive(body, env.OPENROUTER_MODEL || 'microsoft/microsoft-decision-1'),
    tested: false,
  }),
};

/**
 * The host table for the UI dropdown. Ollama primary is always present; hosted providers appear
 * only when their key or endpoint is configured.
 * @returns {Record<string, Host>}
 */
export function hostTable() {
  /** @type {Record<string, any>} */
  const hosts = {
    primary: {
      kind: 'ollama',
      label: env.OLLAMA_LABEL || 'Ollama (primary)',
      ...ADAPTERS.ollama(env.OLLAMA_URL || 'http://localhost:11434'),
    },
  };
  if (env.OLLAMA_URL2) {
    hosts.secondary = {
      kind: 'ollama',
      label: env.OLLAMA_LABEL2 || 'Ollama (secondary)',
      ...ADAPTERS.ollama(env.OLLAMA_URL2),
    };
  }
  if (env.JEV_API_KEY) {
    hosts.jev = { kind: 'jev', label: 'TypeSafe Jev (untested)', ...ADAPTERS.jev() };
  }
  if (env.AZURE_API_KEY && env.AZURE_ENDPOINT && env.AZURE_DEPLOYMENT) {
    hosts.msd1 = { kind: 'msd1', label: 'MS Decision-1 · Foundry (untested)', ...ADAPTERS.msd1() };
  }
  if (env.OPENROUTER_API_KEY) {
    hosts.openrouter = {
      kind: 'openrouter',
      label: 'MS Decision-1 · OpenRouter (untested)',
      ...ADAPTERS.openrouter(),
    };
  }
  return hosts;
}

/**
 * POST a body to a host. For hosted providers the reply is normalized to the Ollama shape.
 * @param {Host} host
 * @param {string} bodyText   Ollama-style JSON body
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ r: Response, sent: string }>}  r = response, sent = the JSON actually sent
 */
export async function send(host, bodyText, signal) {
  const serviceBody = host.body(JSON.parse(bodyText));
  const sent = JSON.stringify(serviceBody);
  const response = await fetch(host.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...host.headers },
    body: sent,
    signal,
  });
  if (!response.ok || host.kind === 'ollama') {
    return { r: response, sent };
  }
  const reply = normalizeReply(await response.json());
  const normalized = new Response(JSON.stringify(reply), {
    status: response.status,
    headers: { 'content-type': 'application/json' },
  });
  return { r: normalized, sent };
}
