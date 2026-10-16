// @ts-check
// The lander server. It serves the game and the playground, and turns a ship state into controls
// by asking a System 1 model (POST /v1/systemone) in one of three modes: prose, data or policy.
//
// Routes:
//   POST /decide          { sim, variant?, model?, host? } → controls + the exact upstream calls
//   POST /api/systemone   playground proxy: { host?, body } → validated, forwarded, timed
//   GET  /api/models      models on an Ollama host (?host=primary)
//   GET  /api/examples    playground examples
//   GET  /config          defaults and the mode list
//   GET  /playground      playground page; other paths serve the game page

import './env.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostTable, send } from './providers/index.mjs';
import { ACTIONS, DATA_QUESTIONS, DATA_TABLE, dataMap, dataThrust } from './sim.mjs';
import { proseSet, perceive, proseMap, PROSE_TABLE } from './prose.mjs';
import {
  POLICY_QUESTIONS,
  POLICY_TABLE,
  policyMap,
  policyNames,
  policyText,
  shipJSON,
} from './policy.mjs';
import { examples } from './examples.mjs';

/** @typedef {import('./sim.mjs').Ship} Ship */
/** @typedef {import('./sim.mjs').Tilt} Tilt */
/** @typedef {import('./providers/index.mjs').Host} Host */

/**
 * Options for a decision. All are optional.
 * @typedef {{ variant?: string, model?: string, host?: string }} DecideOptions
 */

/**
 * One finished upstream call.
 * @typedef {object} UpstreamCall
 * @property {string} body       the exact JSON text sent
 * @property {any} request       the same body as an object
 * @property {string} raw        the raw response text
 * @property {any} j             the parsed response
 * @property {string} url
 * @property {string | false} fellBack  why the call used the fallback host, or false
 * @property {number} ms
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LISTEN_HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT) || 8787;
const MODEL = process.env.MODEL || 'tev1:4b';
// Test override (a mock): when set, every call goes to this URL.
const FORCED_OLLAMA_URL = process.env.OLLAMA;

// Hosts and providers come from the environment (.env); see providers/index.mjs and .env.example.
const HOST_TABLE = hostTable();

/** @type {Record<string, string>} */
export const HOSTS = {};
/** @type {Record<string, string>} */
export const HOST_LABELS = {};
for (const [key, host] of Object.entries(HOST_TABLE)) {
  HOSTS[key] = host.url;
  HOST_LABELS[key] = host.label;
}

/**
 * Unknown host keys fall back to 'primary'.
 * @param {string | undefined | null} hostKey
 * @returns {string}
 */
function knownHostKey(hostKey) {
  if (hostKey && HOST_TABLE[hostKey]) {
    return hostKey;
  }
  return 'primary';
}

const DEFAULT_HOST = knownHostKey(
  process.env.PROVIDER || process.env.OLLAMA_HOST_KEY || 'primary',
);

// ---- Sending, with fallback between Ollama hosts ----

/** When a host failed, skip it until this time (ms since epoch). */
/** @type {Record<string, number>} */
const hostDownUntil = {};

/**
 * The other Ollama host to fall back to, if there is one. Hosted providers never fall back.
 * @param {string} hostKey
 * @returns {Host | null}
 */
function fallbackHostFor(hostKey) {
  if (HOST_TABLE[hostKey].kind !== 'ollama') {
    return null;
  }
  const otherKey = Object.keys(HOST_TABLE).find(
    (key) => key !== hostKey && HOST_TABLE[key].kind === 'ollama',
  );
  return otherKey ? HOST_TABLE[otherKey] : null;
}

/**
 * POST a body to the chosen host. On a network failure, fall back to the other Ollama host and
 * mark the failed host down for 30 s.
 * @param {string | undefined} hostKey
 * @param {string} bodyText
 * @returns {Promise<{ r: Response, sent?: string, url: string, fellBack: string | false }>}
 */
async function post(hostKey, bodyText) {
  if (FORCED_OLLAMA_URL) {
    const url = `${FORCED_OLLAMA_URL}/v1/systemone`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyText,
    });
    return { r: response, url, fellBack: false };
  }

  const key = knownHostKey(hostKey || DEFAULT_HOST);
  const host = HOST_TABLE[key];
  const fallbackHost = fallbackHostFor(key);

  if (fallbackHost && hostDownUntil[key] > Date.now()) {
    const sent = await send(fallbackHost, bodyText);
    return { ...sent, url: fallbackHost.url, fellBack: 'host down (retry in <30s)' };
  }
  try {
    const sent = await send(host, bodyText, AbortSignal.timeout(20000));
    return { ...sent, url: host.url, fellBack: false };
  } catch (error) {
    if (!fallbackHost) {
      throw error;
    }
    hostDownUntil[key] = Date.now() + 30000;
    const sent = await send(fallbackHost, bodyText);
    const reason = /** @type {any} */ (error);
    return { ...sent, url: fallbackHost.url, fellBack: String(reason.cause?.code || reason.name) };
  }
}

// ---- Modes ----

/**
 * The modes. Their ids are what /decide, headless VARIANT and .env VARIANT accept.
 * @returns {{ id: string, label: string }[]}
 */
export function MODES() {
  const policyModes = policyNames().map((name) => ({
    id: 'policy:' + name,
    label: `Policy (plain-English rules): ${name}`,
  }));
  return [
    { id: 'prose', label: 'Prose input (choice questions)' },
    { id: 'data', label: 'Data input (yes/no fact checks)' },
    ...policyModes,
  ];
}

/**
 * Unknown modes fall back to 'prose'.
 * @param {string | undefined} variant
 * @returns {string}
 */
function knownModeId(variant) {
  const isKnown = MODES().some((mode) => mode.id === variant);
  return isKnown ? /** @type {string} */ (variant) : 'prose';
}

export const DEFAULTS = {
  variant: knownModeId(process.env.VARIANT),
  model: MODEL,
  host: DEFAULT_HOST,
  hosts: HOSTS,
  hostLabels: HOST_LABELS,
  timeScale: Number(process.env.TIME_SCALE || 1),
};

/** How long Ollama keeps the model loaded between calls. */
const KEEP_ALIVE = '2h';

/**
 * A one-hot probability table over ACTIONS for the chosen controls (for the UI).
 * @param {number | boolean} thrust
 * @param {Tilt} tilt
 * @returns {Record<string, number>}
 */
function probsFor(thrust, tilt) {
  /** @type {Record<string, number>} */
  const probabilities = {};
  for (const [actionName, [burns, actionTilt]] of Object.entries(ACTIONS)) {
    const matches = burns === !!thrust && actionTilt === tilt;
    probabilities[actionName] = matches ? 1 : 0;
  }
  return probabilities;
}

/**
 * Send one /v1/systemone request and parse the reply.
 * @param {string | undefined} hostKey
 * @param {any} request
 * @returns {Promise<UpstreamCall>}
 */
async function call(hostKey, request) {
  const body = JSON.stringify(request);
  const startedAt = performance.now();
  const posted = await post(hostKey, body);
  const response = posted.r;
  if (!response.ok) {
    throw new Error(`upstream ${response.status}: ${await response.text()}`);
  }
  const raw = await response.text();
  return {
    body,
    request,
    raw,
    j: JSON.parse(raw),
    url: posted.url,
    fellBack: posted.fellBack,
    ms: Math.round(performance.now() - startedAt),
  };
}

/** @param {number | boolean} thrust @param {Tilt} tilt */
function actionName(thrust, tilt) {
  return (thrust ? 'burn_' : 'coast_') + tilt;
}

/** @param {number} throttle */
function throttlePercent(throttle) {
  return Math.round(throttle * 100) + '%';
}

/**
 * Sum token usage over several calls.
 * @param {{ usage?: any }[]} calls
 */
function totalUsage(calls) {
  let inputTokens = 0;
  let outputTokens = 0;
  for (const finishedCall of calls) {
    inputTokens = inputTokens + (finishedCall.usage?.input_tokens || 0);
    outputTokens = outputTokens + (finishedCall.usage?.output_tokens || 0);
  }
  return { input_tokens: inputTokens, output_tokens: outputTokens, calls: calls.length };
}

/**
 * The per-call record shown in the UI for multi-call modes.
 * @param {string} name @param {UpstreamCall} upstream @param {number} probability @param {boolean} answer
 */
function callRecord(name, upstream, probability, answer) {
  return {
    name,
    body: upstream.body,
    request: upstream.request,
    rawResponse: upstream.raw,
    response: upstream.j,
    p: probability,
    answer,
    usage: upstream.j.usage,
    ms: upstream.ms,
  };
}

/**
 * Same-scene skip (prose mode). Perception prose changes only when the ship crosses a band, so
 * consecutive bodies are often byte-identical. Ollama answers those from its prompt cache in a
 * few ms anyway; here we skip the call entirely while the last answer is fresh. Answers are only
 * reused for an IDENTICAL body (same model, scene and questions), so they are never stale for it.
 */
const SAME_SCENE_MAX_AGE = 1.0; // sim seconds
/** @type {{ body: string, t: number, result: any } | null} */
let lastProseCall = null;
const sameSceneEnabled = process.env.SAME_SCENE_SKIP !== '0';

/**
 * PROSE: one call. state = perception sentences; questions come from lander/modes/prose.json.
 * @param {Ship} ship @param {string} model @param {number} startedAt @param {DecideOptions} options
 */
async function decideProse(ship, model, startedAt, options) {
  const questionSet = proseSet();
  const request = {
    model,
    state: perceive(ship, questionSet),
    questions: questionSet.questions,
    keep_alive: KEEP_ALIVE,
  };
  const bodyText = JSON.stringify(request);
  const age = lastProseCall ? ship.t - lastProseCall.t : Infinity;
  if (sameSceneEnabled && lastProseCall?.body === bodyText && age >= 0 && age <= SAME_SCENE_MAX_AGE) {
    const reused = lastProseCall.result;
    return {
      ...reused,
      sameScene: true,
      usage: { input_tokens: 0, output_tokens: 0, calls: 0 },
      ms: Math.round(performance.now() - startedAt),
      simState: ship,
    };
  }
  const upstream = await call(options.host, request);
  const answers = upstream.j.answers || {};
  const controls = proseMap(answers, ship);
  const thrust = controls.throttle > 0 ? controls.throttle : false;
  const result = {
    variant: 'prose',
    model,
    thrust,
    tilt: controls.tilt,
    action: actionName(thrust, controls.tilt),
    throttle: throttlePercent(controls.throttle),
    tvx: controls.tvx,
    answers,
    table: PROSE_TABLE,
    probs: probsFor(thrust, controls.tilt),
    usage: upstream.j.usage,
    ms: Math.round(performance.now() - startedAt),
    fellBack: upstream.fellBack,
    upstream: {
      url: upstream.url,
      body: upstream.body,
      request: upstream.request,
      rawResponse: upstream.raw,
      response: upstream.j,
    },
    simState: ship,
  };
  if (Number.isFinite(ship.t)) {
    lastProseCall = { body: bodyText, t: ship.t, result };
  }
  return result;
}

/**
 * DATA: a chain of small yes/no fact calls (neutral key "q"). Later calls are skipped when earlier
 * answers already decide the controls.
 * @param {Ship} ship @param {string} model @param {number} startedAt @param {DecideOptions} options
 */
async function decideData(ship, model, startedAt, options) {
  /** @type {Record<string, any>} */
  const answers = {};
  /** @type {any[]} */
  const calls = [];
  /** @type {string | undefined} */
  let url;
  /** @type {string | false} */
  let fellBack = false;

  for (const question of DATA_QUESTIONS) {
    if (question.skipIf && question.skipIf(answers)) {
      calls.push({ name: question.name, skipped: true });
      continue;
    }
    const request = {
      model,
      state: question.state(ship),
      questions: { q: question.q },
      keep_alive: KEEP_ALIVE,
    };
    const upstream = await call(options.host, request);
    const answer = upstream.j.answers?.q ?? {};
    url = upstream.url;
    fellBack = fellBack || upstream.fellBack;

    // Choice questions have a `read` function; noul questions use the probability directly.
    let probability;
    if (question.read) {
      probability = answer.probabilities?.touching_down ?? (question.read(answer) ? 1 : 0);
      answers[question.name] = question.read(answer);
    } else {
      probability = answer.noul ?? 0;
      answers[question.name] = probability > 0.5;
    }
    answers[question.name + '_p'] = probability;
    calls.push(callRecord(question.name, upstream, probability, answers[question.name]));
  }

  const tilt = dataMap(answers);
  const thrust = dataThrust(answers);
  const madeCalls = calls.filter((record) => !record.skipped);
  return {
    variant: 'data',
    model,
    thrust,
    tilt,
    action: actionName(thrust, tilt),
    answers,
    table: DATA_TABLE,
    probs: probsFor(thrust, tilt),
    usage: totalUsage(madeCalls),
    ms: Math.round(performance.now() - startedAt),
    fellBack,
    upstream: { url, multi: true, calls, body: madeCalls[0].body },
    simState: ship,
  };
}

/**
 * POLICY: 4 judgment calls against a plain-English policy file. The graded probabilities become
 * throttle and steering.
 * @param {Ship} ship @param {string} model @param {number} startedAt @param {DecideOptions} options
 * @param {string} policyName
 */
async function decidePolicy(ship, model, startedAt, options, policyName) {
  const policy = policyText(policyName);
  const shipDescription = shipJSON(ship);
  /** @type {Record<string, any>} */
  const answers = {};
  /** @type {any[]} */
  const calls = [];
  /** @type {string | undefined} */
  let url;
  /** @type {string | false} */
  let fellBack = false;

  for (const question of POLICY_QUESTIONS) {
    const request = {
      model,
      state: { policy, ship: shipDescription },
      questions: { q: question.q },
      keep_alive: KEEP_ALIVE,
    };
    const upstream = await call(options.host, request);
    const probability = upstream.j.answers?.q?.noul ?? 0;
    url = upstream.url;
    fellBack = fellBack || upstream.fellBack;
    answers[question.name] = probability > 0.5;
    answers[question.name + '_p'] = Math.round(probability * 1000) / 1000;
    calls.push(callRecord(question.name, upstream, probability, answers[question.name]));
  }

  const { throttle, tilt } = policyMap(/** @type {any} */ (answers), ship);
  const thrust = throttle > 0 ? throttle : false;
  return {
    variant: 'policy:' + policyName,
    policy: policyName,
    policyText: policy,
    model,
    thrust,
    tilt,
    action: actionName(thrust, tilt),
    throttle: throttlePercent(throttle),
    answers,
    table: POLICY_TABLE,
    probs: probsFor(thrust, tilt),
    usage: totalUsage(calls),
    ms: Math.round(performance.now() - startedAt),
    fellBack,
    upstream: { url, multi: true, calls, body: calls[0].body },
    simState: ship,
  };
}

/**
 * Decide the controls for a ship state in the requested mode.
 * @param {Ship} ship
 * @param {DecideOptions} [options]
 */
export async function decide(ship, options = {}) {
  const mode = knownModeId(options.variant || DEFAULTS.variant);
  const model = options.model || MODEL;
  const startedAt = performance.now();
  if (mode === 'data') {
    return decideData(ship, model, startedAt, options);
  }
  if (mode.startsWith('policy:')) {
    return decidePolicy(ship, model, startedAt, options, mode.slice('policy:'.length));
  }
  return decideProse(ship, model, startedAt, options);
}

// ---- Playground proxy: validate a /v1/systemone body, forward it, return timing and raw text ----

/**
 * Check one question; push any problems onto `errors`.
 * @param {string} key @param {any} question @param {string[]} errors
 */
function validateQuestion(key, question, errors) {
  if (!/^[\w-]{1,64}$/.test(key)) {
    errors.push(`questions key "${key}": letters, digits, _ or -`);
  }
  if (!question || !['noul', 'choice', 'score'].includes(question.type)) {
    errors.push(`questions.${key}.type must be noul, choice or score`);
    return;
  }
  if (typeof question.instructions !== 'string' || !question.instructions.trim()) {
    errors.push(`questions.${key}.instructions: required string`);
  }
  const criteria = question.criteria;
  const isPlainObject = !!criteria && typeof criteria === 'object' && !Array.isArray(criteria);
  if (question.type === 'choice' && (!isPlainObject || Object.keys(criteria).length < 2)) {
    errors.push(`questions.${key}.criteria: choice needs an object with 2+ options`);
  }
  if (question.type === 'score' && (!Array.isArray(criteria) || criteria.length < 2)) {
    errors.push(`questions.${key}.criteria: score needs an array of 2+ level descriptions`);
  }
  if (question.type === 'noul' && criteria != null) {
    if (typeof criteria !== 'object' || Array.isArray(criteria)) {
      errors.push(`questions.${key}.criteria: noul criteria must be {true, false}`);
    }
  }
}

/** @param {any} keepAlive */
function isValidKeepAlive(keepAlive) {
  if (typeof keepAlive === 'number') {
    return true;
  }
  return typeof keepAlive === 'string' && /^-?\d+(\.\d+)?(ms|s|m|h)?$/.test(keepAlive);
}

/**
 * Validate a playground body.
 * @param {any} body
 * @returns {string[]}  error messages; empty when valid
 */
export function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return ['body must be a JSON object'];
  }
  /** @type {string[]} */
  const errors = [];
  if (typeof body.model !== 'string' || !/^[\w.:/-]{1,100}$/.test(body.model)) {
    errors.push('model: required string (letters, digits, . : / - _)');
  }
  const stateIsValid =
    typeof body.state === 'string' || (body.state && typeof body.state === 'object');
  if (!stateIsValid) {
    errors.push('state: required (JSON object or prose string)');
  }
  const questions = body.questions;
  const hasQuestions =
    questions &&
    typeof questions === 'object' &&
    !Array.isArray(questions) &&
    Object.keys(questions).length;
  if (!hasQuestions) {
    errors.push('questions: required non-empty object');
  } else {
    for (const [key, question] of Object.entries(questions)) {
      validateQuestion(key, question, errors);
    }
  }
  if (body.keep_alive != null && !isValidKeepAlive(body.keep_alive)) {
    errors.push('keep_alive: e.g. "30m", "2h", "-1"');
  }
  return errors;
}

/**
 * Forward a validated playground request.
 * @param {{ host?: string, body?: any }} payload
 * @returns {Promise<{ status: number, json: any }>}
 */
async function playground(payload) {
  const key = knownHostKey(payload.host);
  const host = HOST_TABLE[key];
  const body = payload.body;
  const errors = validateBody(body);
  if (errors.length) {
    return { status: 400, json: { error: 'invalid request', details: errors } };
  }

  // Forward only the known fields, in a fixed order.
  const cleanRequest = {
    model: body.model,
    state: body.state,
    questions: body.questions,
    ...(body.keep_alive != null ? { keep_alive: body.keep_alive } : {}),
  };
  const bodyText = JSON.stringify(cleanRequest);
  const startedAt = performance.now();
  try {
    const { r: response, sent } = await send(host, bodyText, AbortSignal.timeout(60000));
    const raw = await response.text();
    const ms = Math.round(performance.now() - startedAt);
    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Not JSON; the raw text is still returned.
    }
    return {
      status: 200,
      json: {
        host: key,
        url: host.url,
        upstreamStatus: response.status,
        ms,
        request: cleanRequest,
        // Only shown when the provider adapter rewrote the body.
        sent: sent !== bodyText ? JSON.parse(sent) : undefined,
        raw,
        response: parsed,
      },
    };
  } catch (error) {
    const reason = /** @type {any} */ (error);
    return {
      status: 502,
      json: {
        error: 'upstream failed',
        details: [String(reason.cause?.code || reason.message)],
        host: key,
        url: host.url,
        ms: Math.round(performance.now() - startedAt),
      },
    };
  }
}

/**
 * The models installed on an Ollama host.
 * @param {string | null} hostKey
 */
async function models(hostKey) {
  const host = HOST_TABLE[knownHostKey(hostKey)];
  if (host.kind !== 'ollama') {
    return { models: [], note: 'model list only for Ollama hosts' };
  }
  const base = host.url.replace(/\/v1\/systemone$/, '');
  const response = await fetch(base + '/api/tags', { signal: AbortSignal.timeout(5000) });
  const tags = await response.json();
  const modelList = (tags.models || []).map((/** @type {any} */ model) => ({
    name: model.name,
    size: model.size,
    params: model.details?.parameter_size,
    quant: model.details?.quantization_level,
  }));
  return { host: knownHostKey(hostKey), base, models: modelList };
}

// ---- HTTP ----

/** Static files the pages load, with their content types. Any other path serves index.html. */
const STATIC_FILES = {
  '/sim.mjs': 'text/javascript',
  '/pilot-loop.mjs': 'text/javascript',
  '/game.js': 'text/javascript',
  '/game.css': 'text/css',
  '/playground.js': 'text/javascript',
  '/playground.css': 'text/css',
};

/**
 * @param {http.ServerResponse} response @param {number} statusCode @param {any} value
 */
function sendJson(response, statusCode, value) {
  response.writeHead(statusCode, { 'content-type': 'application/json' });
  response.end(JSON.stringify(value));
}

/**
 * Read a request body, refusing anything over `maxLength` characters.
 * @param {http.IncomingMessage} request
 * @param {number} [maxLength]
 */
async function readBody(request, maxLength = 256000) {
  let bodyText = '';
  for await (const chunk of request) {
    bodyText = bodyText + chunk;
    if (bodyText.length > maxLength) {
      throw Object.assign(new Error('body too large'), { code: 413 });
    }
  }
  return bodyText;
}

/** @param {http.ServerResponse} response */
async function handleDecide(request, response) {
  const payload = JSON.parse(await readBody(request));
  if (!payload.sim || typeof payload.sim !== 'object') {
    return sendJson(response, 400, { error: 'sim required' });
  }
  return sendJson(response, 200, await decide(payload.sim, payload));
}

/** @param {http.IncomingMessage} request @param {http.ServerResponse} response */
async function handlePlayground(request, response) {
  let payload;
  try {
    payload = JSON.parse(await readBody(request));
  } catch (error) {
    const reason = /** @type {any} */ (error);
    const statusCode = reason.code || 400;
    return sendJson(response, statusCode, { error: reason.code ? reason.message : 'invalid JSON' });
  }
  const result = await playground(payload || {});
  return sendJson(response, result.status, result.json);
}

/** @param {string} urlPath @param {http.ServerResponse} response */
function serveFile(urlPath, response) {
  /** @type {Record<string, string>} */
  const staticFiles = STATIC_FILES;
  let fileName = 'index.html';
  let contentType = 'text/html';
  if (staticFiles[urlPath]) {
    fileName = urlPath.slice(1);
    contentType = staticFiles[urlPath];
  } else if (urlPath.replace(/\/$/, '') === '/playground') {
    fileName = 'playground.html';
  }
  response.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' });
  response.end(fs.readFileSync(path.join(HERE, fileName)));
}

/** @param {http.IncomingMessage} request @param {http.ServerResponse} response */
async function route(request, response) {
  const fullUrl = request.url || '/';
  const urlPath = fullUrl.split('?')[0];
  if (request.method === 'POST' && urlPath === '/decide') {
    return handleDecide(request, response);
  }
  if (request.method === 'POST' && urlPath === '/api/systemone') {
    return handlePlayground(request, response);
  }
  if (urlPath === '/api/models') {
    const hostKey = new URL(fullUrl, 'http://x').searchParams.get('host');
    return sendJson(response, 200, await models(hostKey));
  }
  if (urlPath === '/api/examples') {
    return sendJson(response, 200, examples());
  }
  if (urlPath === '/config') {
    return sendJson(response, 200, { ...DEFAULTS, modes: MODES() });
  }
  return serveFile(urlPath, response);
}

function startServer() {
  const server = http.createServer(async (request, response) => {
    try {
      await route(request, response);
    } catch (error) {
      const reason = /** @type {any} */ (error);
      const statusCode = reason.code === 413 ? 413 : 500;
      sendJson(response, statusCode, { error: String(reason.message || reason) });
    }
  });
  server.listen(PORT, LISTEN_HOST, () => {
    console.log(`lander on http://${LISTEN_HOST}:${PORT} model=${MODEL} mode=${DEFAULTS.variant}`);
  });
}

// Only start listening when run directly (tests and tools import this file).
if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
