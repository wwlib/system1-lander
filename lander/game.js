// @ts-check
// The game page. The browser runs the physics (sim.mjs) at the display frame rate and, whenever no
// call is in flight, POSTs the ship state to /decide. The reply's controls are applied when it
// arrives, so model latency is visible as lag. The right panel shows every call.
//
// URL parameters: ?seed=N (replay a random start), ?random=0|1, ?pads=0|1 (choose a landing pad,
// prose mode only), ?redact=1 (mask IPs in screenshots),
// pilot loop: ?rate=1|2|4|5|10 ?smooth=0|1 ?comp=0|1 ?impulse=0|1 ?delay=ms (artificial lag).

import { newState, step, terrainY, PAD, W, ACTIONS, randomStart, padsFor, targetPad } from './sim.mjs';
import {
  createPilotLoop,
  uiRate,
  parseFlag,
  rateLabel,
  RATE_CHOICES,
  DEFAULT_SETTINGS,
} from './pilot-loop.mjs';

/** @typedef {import('./sim.mjs').Ship} Ship */

/** One color per action, used for markers, bars and the call log. */
/** @type {Record<string, string>} */
const ACTION_COLORS = {
  burn_left: '#f60',
  burn_center: '#f33',
  burn_right: '#f0a',
  coast_left: '#0af',
  coast_center: '#0f8',
  coast_right: '#a6f',
};

const MAX_LOGGED_CALLS = 50;
const MAX_MARKERS = 120;
const MAX_LATENCIES = 200;

// ---- Page elements ----

/** @param {string} id @returns {any} */
function byId(id) {
  return document.getElementById(id);
}

/** @type {HTMLCanvasElement} */
const canvas = byId('c');
const context = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const hud = byId('hud');
const logElement = byId('log');
/** @type {HTMLCanvasElement} */
const sparkline = byId('spark');
const sparkContext = /** @type {CanvasRenderingContext2D} */ (sparkline.getContext('2d'));

// ---- Flight state ----

/** @type {Ship} */
let ship;
let aiPiloting = true;
/** The decision currently flying the ship. */
/** @type {any} */
let activeDecision = { thrust: false, tilt: 'center', action: null, ms: 0 };
/** The call waiting for a reply, or null. */
/** @type {any} */
let inflightCall = null;
/** Bumped on every reset so replies from an earlier flight are discarded. */
let flightGeneration = 0;
let callNumber = 0;
/** Glow around the ship when a decision is applied; fades from 1 to 0. */
let flash = 0;
let appliedCallId = null;
let lastGap = null;
let firstAppliedWallTime = null;
let shownOutcome = null;
let paused = false;
/** A reply that arrived while paused; it is applied on resume. */
/** @type {any} */
let heldReply = null;
let showMarkers = localStorage.getItem('lander.marks') !== '0';
/** Description of how this flight started, shown in the HUD. */
let startInfo = '';
/** The latest call body, for "open latest call in playground". */
/** @type {any} */
let latestCapture = null;
/** Mode id → label, from /config. */
/** @type {Record<string, string>} */
let modeLabels = {};

/** @type {any[]} */
const calls = [];
/** Where each call was sent (ring) and applied (dot). */
/** @type {any[]} */
const markers = [];
/** @type {number[]} */
const latencies = [];
let appliedCount = 0;
/** Prose calls the server skipped because the scene was identical to the last call's. */
let sameSceneSkips = 0;
let latencySum = 0;
/** Applied count at the start of the flight (always 0 since reset clears counts). */
let appliedCountAtStart = 0;
/** @type {Record<string, boolean>} */
const keysDown = {};

// Options sent with every /decide call. Key order (variant, model, host, timeScale) is part of
// the request body.
/** @type {{ variant: string, model: string, host: string, timeScale?: number }} */
const options = {
  variant: localStorage.getItem('lander.mode3') || '',
  model: localStorage.getItem('lander.model') || '',
  host: localStorage.getItem('lander.host') || '',
};

const urlParams = new URLSearchParams(location.search);
/** A seed from ?seed=N, used once for the first random start. */
let urlSeed = urlParams.has('seed') ? Number(urlParams.get('seed')) >>> 0 : null;
let randomStartOn = urlParams.has('random')
  ? urlParams.get('random') !== '0'
  : urlSeed != null || localStorage.getItem('lander.random') === '1';
/** Choose landing pad: three pads with rewards; the model picks one (prose mode only). */
let padsOn = urlParams.has('pads')
  ? urlParams.get('pads') !== '0'
  : localStorage.getItem('lander.pads') === '1';
// ?redact=1 masks IPv4 host addresses (for screenshots).
const REDACT = new URLSearchParams(location.search).has('redact');

// ---- Pilot loop settings (lander/pilot-loop.mjs): URL parameter, else saved, else default ----

/** @param {string} urlKey @param {string} storageKey */
function savedSetting(urlKey, storageKey) {
  return urlParams.get(urlKey) ?? localStorage.getItem('lander.' + storageKey);
}

const pilotSettings = {
  rate: uiRate(savedSetting('rate', 'rate')),
  smoothing: parseFlag(savedSetting('smooth', 'smooth'), DEFAULT_SETTINGS.smoothing),
  latencyComp: parseFlag(savedSetting('comp', 'comp'), DEFAULT_SETTINGS.latencyComp),
  impulseLimits: parseFlag(savedSetting('impulse', 'impulse'), DEFAULT_SETTINGS.impulseLimits),
};
/** Artificial extra latency per reply, ms (for testing slow hosts; not saved). */
const DELAY_MS = Number(urlParams.get('delay') || 0);
/** @type {import('./pilot-loop.mjs').PilotLoop} */
let pilot = createPilotLoop(pilotSettings);

// ---- Small helpers ----

/**
 * Escape text for HTML (and mask IPs when redacting).
 * @param {any} text
 * @returns {string}
 */
function esc(text) {
  let value = String(text);
  if (REDACT) {
    value = value.replace(/\b\d{1,3}(\.\d{1,3}){3}\b/g, 'gpu-host');
  }
  /** @type {Record<string, string>} */
  const entities = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
  return value.replace(/[&<>]/g, (character) => entities[character]);
}

/** "+1.2" / "−3.4" (with a real minus sign). @param {number} value */
function signed(value) {
  return (value >= 0 ? '+' : '−') + Math.abs(value).toFixed(1);
}

/** @param {number} radians */
function degrees(radians) {
  return signed((radians * 180) / Math.PI).replace('.0', '') + '°';
}

/** "HH:MM:SS.mmm" */
function wallClock() {
  const time = new Date().toLocaleTimeString([], { hour12: false });
  return time + '.' + String(Date.now() % 1000).padStart(3, '0');
}

// ---- Settings: /config, selects, time scale ----

/** @param {any} config */
function applyConfig(config) {
  const modeOptions = config.modes.map(
    (/** @type {any} */ mode) => `<option value="${mode.id}">${esc(mode.label)}</option>`,
  );
  byId('selvar').innerHTML = modeOptions.join('');

  if (!config.modes.some((/** @type {any} */ mode) => mode.id === options.variant)) {
    options.variant = config.variant;
  }
  if (!localStorage.getItem('lander.ts2') && config.timeScale) {
    options.timeScale = config.timeScale;
    byId('ts').value = config.timeScale;
    byId('tsv').textContent = config.timeScale + '×';
  }
  options.model ||= config.model;
  options.host = config.hosts?.[options.host] ? options.host : config.host;

  const hostKeys = Object.keys(config.hosts || { primary: 1 });
  const hostOptions = hostKeys.map(
    (hostKey) => `<option value="${hostKey}">${esc(config.hostLabels?.[hostKey] || hostKey)}</option>`,
  );
  byId('selhost').innerHTML = hostOptions.join('');
  byId('selhost').value = options.host;
  byId('selvar').value = options.variant;
  byId('selmodel').value = options.model;
  modeLabels = Object.fromEntries(
    config.modes.map((/** @type {any} */ mode) => [mode.id, mode.label]),
  );
}

function setUpTimeScale() {
  options.timeScale = Number(localStorage.getItem('lander.ts2') || 1);
  byId('ts').value = options.timeScale;
  byId('tsv').textContent = options.timeScale + '×';
  byId('ts').oninput = (/** @type {any} */ event) => {
    options.timeScale = Number(event.target.value);
    byId('tsv').textContent = options.timeScale + '×';
    localStorage.setItem('lander.ts2', String(options.timeScale));
  };
  // Blur so the keyboard shortcuts keep working.
  byId('ts').onchange = (/** @type {any} */ event) => event.target.blur();
}

function setUpSelects() {
  /** @type {[string, 'variant' | 'model' | 'host', string][]} */
  const selects = [
    ['selvar', 'variant', 'mode3'],
    ['selmodel', 'model', 'model'],
    ['selhost', 'host', 'host'],
  ];
  for (const [elementId, optionKey, storageKey] of selects) {
    byId(elementId).onchange = (/** @type {any} */ event) => {
      options[optionKey] = event.target.value;
      localStorage.setItem('lander.' + storageKey, event.target.value);
      event.target.blur();
    };
  }
}

// ---- Starting and resetting a flight ----

/**
 * The start for a new flight: a seeded random start (replay with ?seed=N), or the classic fixed
 * start (x 40, altitude 110 m, at rest).
 */
function chooseStart() {
  if (!randomStartOn) {
    startInfo = 'fixed start';
    return { x: 40 };
  }
  const seed = urlSeed ?? Math.floor(Math.random() * 1e6);
  urlSeed = null;
  const start = randomStart(seed);
  const altitude = start.y - PAD.y;
  const tilt = (start.angle * 57.3).toFixed(0);
  startInfo =
    `seed ${seed} · x ${start.x} · alt ${altitude} m · vx ${start.vx} · vy ${start.vy} · ` +
    `tilt ${tilt}°`;
  return start;
}

/** The pads layout applies only in prose mode (the other modes aim for the classic pad). */
function padLayoutActive() {
  const isProse = !options.variant || options.variant === 'prose';
  return padsOn && isProse;
}

/** A new flight. Per-flight counters and stats restart (call #, latency stats, log). */
function reset() {
  callNumber = 0;
  appliedCount = 0;
  sameSceneSkips = 0;
  latencySum = 0;
  appliedCountAtStart = 0;
  latencies.length = 0;
  calls.length = 0;
  byId('lat').textContent = '';
  byId('howBody').textContent = 'waiting for first call…';
  heldReply = null;
  lastGap = null;
  firstAppliedWallTime = null;
  shownOutcome = null;
  byId('outcome').className = '';
  ship = newState({ ...chooseStart(), ...(padLayoutActive() ? { layout: 'pads' } : {}) });
  pilot = createPilotLoop(pilotSettings);
  activeDecision = { ...activeDecision, thrust: false, tilt: 'center', action: null };
  flightGeneration = flightGeneration + 1;
  markers.length = 0;
  appliedCallId = null;
  inflightCall = null;
  renderLog();
}

// ---- Toggles and keys ----

function togglePanel() {
  const hidden = document.body.classList.toggle('nopanel');
  localStorage.setItem('lander.panel', hidden ? '0' : '1');
}

function markersButtonText() {
  return `Markers: ${showMarkers ? 'on' : 'off'} (T)`;
}

function toggleMarkers() {
  showMarkers = !showMarkers;
  localStorage.setItem('lander.marks', showMarkers ? '1' : '0');
  byId('tmarks').textContent = markersButtonText();
}

function togglePause() {
  paused = !paused;
  document.body.classList.toggle('paused', paused);
  byId('pause').textContent = paused ? 'Resume (P/Space)' : 'Pause (P/Space)';
  if (!paused && heldReply) {
    const held = heldReply;
    heldReply = null;
    applyDecision(held.call, held.decision, held.marker);
    renderLog();
  }
}

function togglePilot() {
  aiPiloting = !aiPiloting;
  byId('mode').textContent = `Mode: ${aiPiloting ? 'AI' : 'Manual'} (M)`;
}

/** @param {KeyboardEvent} event */
function onKeyDown(event) {
  keysDown[event.key] = true;
  const key = event.key.toLowerCase();
  if (event.key === '?') {
    document.body.classList.toggle('help');
  }
  if (key === 'm') {
    togglePilot();
  }
  if (key === 'r') {
    reset();
  }
  if (key === 's') {
    togglePanel();
  }
  if (key === 't') {
    toggleMarkers();
  }
  if (key === 'p' || event.key === ' ') {
    event.preventDefault();
    togglePause();
  }
}

function setUpControls() {
  if (localStorage.getItem('lander.panel') === '0') {
    document.body.classList.add('nopanel');
  }
  byId('rnd').checked = randomStartOn;
  byId('rnd').onchange = (/** @type {any} */ event) => {
    randomStartOn = event.target.checked;
    localStorage.setItem('lander.random', randomStartOn ? '1' : '0');
    event.target.blur();
    reset();
  };
  byId('pads').checked = padsOn;
  byId('pads').onchange = (/** @type {any} */ event) => {
    padsOn = event.target.checked;
    localStorage.setItem('lander.pads', padsOn ? '1' : '0');
    event.target.blur();
    reset();
  };
  addEventListener('keydown', onKeyDown);
  addEventListener('keyup', (event) => {
    keysDown[event.key] = false;
  });
  byId('tpanel').onclick = togglePanel;
  byId('tmarks').onclick = toggleMarkers;
  byId('pause').onclick = togglePause;
  byId('tmarks').textContent = markersButtonText();
  byId('mode').onclick = togglePilot;
  byId('reset').onclick = reset;
  byId('cap').onclick = openLatestCallInPlayground;
}

// ---- The call log ----

/**
 * Probability bars over every action, with the chosen one highlighted.
 * @param {Record<string, number> | undefined} probabilities @param {string} chosenAction
 */
function bars(probabilities, chosenAction) {
  const rows = Object.keys(ACTIONS).map((action) => {
    const probability = Number(probabilities?.[action] ?? 0);
    const width = (probability * 100).toFixed(1);
    return (
      `<div class="bar ${action === chosenAction ? 'ch' : ''}"><span class="lab">${action}</span>` +
      `<span class="bg"><span class="fg" style="display:block;width:${width}%;` +
      `background:${ACTION_COLORS[action]}"></span></span><span>${probability.toFixed(3)}</span></div>`
    );
  });
  return rows.join('');
}

/**
 * One sub-call of a multi-call (data or policy) decision.
 * @param {any} subCall @param {boolean} showFullBody
 */
function subCallHTML(subCall, showFullBody) {
  if (subCall.skipped) {
    return (
      `<div class="meta" style="opacity:.5">· ${esc(subCall.name)}: ` +
      `skipped (decided by earlier answer)</div>`
    );
  }
  const borderColor = subCall.answer ? '#0f8' : '#f66';
  let html =
    `<div style="border-left:2px solid ${borderColor};padding-left:4px;margin:2px 0">` +
    `<span style="color:#fff">${esc(subCall.name)}</span> → ` +
    `<b>${subCall.answer ? 'YES' : 'no'}</b> (p=${Number(subCall.p).toFixed(2)}) · ` +
    `${subCall.ms} ms · ${subCall.usage?.input_tokens} tok`;
  if (showFullBody) {
    const prettyBody = JSON.stringify(JSON.parse(subCall.body), null, 2);
    html +=
      `<pre>${esc(prettyBody)}</pre><div class="meta">raw response</div>` +
      `<pre>${esc(subCall.rawResponse)}</pre>`;
  } else {
    html +=
      `<div class="meta">state ${esc(JSON.stringify(subCall.request.state))} · ` +
      `Q: ${esc(subCall.request.questions.q.instructions)}</div>`;
  }
  return html + `</div>`;
}

/**
 * The summary line plus every sub-call of a data or policy decision.
 * @param {any} decision @param {boolean} showFullBody
 */
function subCallsHTML(decision, showFullBody) {
  const madeCount = decision.upstream.calls.filter(
    (/** @type {any} */ subCall) => !subCall.skipped && !subCall.cached,
  ).length;
  const summary =
    `<div class="meta">${madeCount} sequential sub-calls · total ${decision.ms} ms · ` +
    `${decision.usage.input_tokens} input tokens</div>`;
  const subCalls = decision.upstream.calls.map(
    (/** @type {any} */ subCall) => subCallHTML(subCall, showFullBody),
  );
  return summary + subCalls.join('');
}

/** @param {any} call */
function statusTagHTML(call) {
  if (call.status === 'pending') {
    return (
      `<span class="tag pend"><span class="spin"></span> in flight ` +
      `<span class="el" data-id="${call.id}">0</span> ms</span>`
    );
  }
  if (call.status === 'held') {
    return '<span class="tag pend">HELD (paused) – applies on resume</span>';
  }
  if (call.id === appliedCallId) {
    return '<span class="tag app">APPLIED</span>';
  }
  if (call.status === 'error') {
    return '<span class="tag err">error</span>';
  }
  if (call.status === 'too-old') {
    return `<span class="tag">discarded: ${call.age.toFixed(1)} s old</span>`;
  }
  if (call.status === 'stale') {
    return '<span class="tag">discarded (reset)</span>';
  }
  return '';
}

/** @param {any} call */
function appliedNote(call) {
  if (call.appliedT != null) {
    return `applied at t=${call.appliedT.toFixed(2)}s`;
  }
  return call.status === 'held' ? 'held until resume' : 'not applied';
}

/** The body of a single-call (prose) log entry. @param {any} call */
function singleCallBodyHTML(call) {
  const { questions, ...restOfRequest } = call.res.upstream.request;
  const questionsJson = esc(JSON.stringify(questions, null, 1));
  // The first call shows the questions; later ones fold them away (they change only for the final approach).
  const isOldestCall = call.id === calls.find((logged) => logged.kind !== 'pad')?.id;
  const questionsHTML = isOldestCall
    ? `<div class="meta">questions</div><pre>${questionsJson}</pre>`
    : `<details><summary>questions</summary><pre>${questionsJson}</pre></details>`;
  const usage = call.res.usage;
  return (
    `<div class="meta">request → ${esc(call.res.upstream.url)}</div>` +
    `<pre>${esc(JSON.stringify(restOfRequest, null, 1))}</pre>` +
    questionsHTML +
    `<div class="meta">result: <b style="color:${ACTION_COLORS[call.res.action]}">` +
    `${call.res.action}</b> · ${call.res.ms} ms · ` +
    `tokens in ${usage?.input_tokens ?? '?'} / out ${usage?.output_tokens ?? '?'} · ` +
    `${appliedNote(call)}</div>${bars(call.res.probs, call.res.action)}` +
    `<details><summary>raw response</summary>` +
    `<pre>${esc(JSON.stringify(call.res.upstream.response, null, 1))}</pre></details>`
  );
}

/**
 * A pad-choice log entry (pads layout): the landing-pad call the server made before a flight call,
 * with its full request body and response.
 * @param {any} call
 */
function padCallHTML(call) {
  const pad = call.res;
  const { questions, ...restOfRequest } = pad.upstream.request;
  const usage = pad.usage;
  const body =
    `<div class="meta">request → ${esc(pad.upstream.url)}</div>` +
    `<pre>${esc(JSON.stringify(restOfRequest, null, 1))}</pre>` +
    `<details><summary>questions</summary><pre>${esc(JSON.stringify(questions, null, 1))}</pre></details>` +
    `<div class="meta">result: <b style="color:#fc6">${esc(pad.target)}</b> · ` +
    `confidence ${Math.round(pad.confidence * 100)}% · ${pad.ms} ms · ` +
    `tokens in ${usage?.input_tokens ?? '?'} / out ${usage?.output_tokens ?? '?'}</div>` +
    `<div class="meta">${probabilityList(pad.probabilities)}</div>` +
    `<details><summary>raw response</summary>` +
    `<pre>${esc(JSON.stringify(pad.upstream.response, null, 1))}</pre></details>`;
  return (
    `<div class="call" style="border-left-color:#fc6">` +
    `\n   <div class="hd"><span>#${call.id} · <b>pad choice</b> · ${call.wall} · sim t=${call.sentT.toFixed(2)}s</span>` +
    `<span class="tag">pad choice (before flight call #${call.flightCallId})</span></div>${body}</div>`
  );
}

/** One entry in the call log. @param {any} call */
function callHTML(call) {
  if (call.kind === 'pad') {
    return padCallHTML(call);
  }
  const request = call.res?.upstream?.request;
  let body = '';
  if (request && call.res.upstream.multi) {
    const applied = call.appliedT != null ? 't=' + call.appliedT.toFixed(2) + 's' : call.status;
    body =
      subCallsHTML(call.res, false) +
      `<div class="meta">result: <b style="color:${ACTION_COLORS[call.res.action]}">` +
      `${call.res.action}</b> · applied ${applied}</div>`;
  } else if (request) {
    body = singleCallBodyHTML(call);
  } else if (call.status === 'pending') {
    body =
      `<div class="meta">sim state sent to /decide</div>` +
      `<pre>${esc(JSON.stringify(call.sent))}</pre>`;
  }
  if (call.err) {
    body += `<div class="err">${esc(call.err)}</div>`;
  }
  const pendingClass = call.status === 'pending' ? 'pending' : '';
  const appliedClass = call.id === appliedCallId ? 'applied' : '';
  const borderColor = ACTION_COLORS[call.res?.action] || '#555';
  return (
    `<div class="call ${pendingClass} ${appliedClass}" style="border-left-color:${borderColor}">` +
    `\n   <div class="hd"><span>#${call.id} · ${call.wall} · sim t=${call.sentT.toFixed(2)}s</span>` +
    `${statusTagHTML(call)}</div>${body}</div>`
  );
}

/** @param {Element} details */
function detailsKey(details) {
  const callElement = /** @type {HTMLElement | null} */ (details.closest('.call'));
  const summary = details.querySelector('summary');
  return callElement?.dataset.k + '|' + summary?.textContent;
}

/** Redraw the log, newest first, keeping open <details> open. */
function renderLog() {
  const openDetails = new Set([...logElement.querySelectorAll('details[open]')].map(detailsKey));
  const entries = calls
    .slice()
    .reverse()
    .map((call) => callHTML(call).replace('<div class="call', `<div data-k="${call.id}" class="call`));
  logElement.innerHTML = entries.join('');
  for (const details of logElement.querySelectorAll('details')) {
    if (openDetails.has(detailsKey(details))) {
      details.open = true;
    }
  }
  drawSparkline();
}

/** Latency sparkline of the last 60 applied calls, with a grey 500 ms line. */
function drawSparkline() {
  sparkContext.clearRect(0, 0, sparkline.width, sparkline.height);
  const recent = latencies.slice(-60);
  if (!recent.length) {
    return;
  }
  const scaleMax = Math.max(1000, ...recent);
  const height = sparkline.height;

  sparkContext.strokeStyle = '#333';
  const y500 = height - (500 / scaleMax) * height;
  sparkContext.beginPath();
  sparkContext.moveTo(0, y500);
  sparkContext.lineTo(sparkline.width, y500);
  sparkContext.stroke();

  sparkContext.strokeStyle = '#0f0';
  sparkContext.beginPath();
  recent.forEach((latency, index) => {
    const x = (index * sparkline.width) / 59;
    sparkContext.lineTo(x, height - (latency / scaleMax) * height);
  });
  sparkContext.stroke();

  const last = recent[recent.length - 1];
  const averageMs = (latencySum / appliedCount).toFixed(0);
  byId('lat').textContent =
    `last ${last} ms · avg ${averageMs} · min ${Math.min(...recent)} · ` +
    `max ${Math.max(...recent)} (n=${appliedCount}) · grey line=500ms`;
}

// ---- Applying a decision ----

/**
 * Start flying with a decision and record how late it arrived.
 * @param {any} call @param {any} decision @param {any} marker
 */
function applyDecision(call, decision, marker) {
  const verdict = pilot.receive(call.pilotCall, decision, ship);
  if (verdict === 'discarded') {
    // Too old to trust (latency compensation): keep the previous targets.
    call.status = 'too-old';
    call.age = pilot.stats.lastAge;
    return;
  }
  activeDecision = decision;
  decision.appliedSimT = ship.t;
  if (decision.sameScene) {
    sameSceneSkips = sameSceneSkips + 1;
  }
  lastGap = {
    id: call.id,
    dt: ship.t - call.sentT,
    dist: Math.hypot(ship.x - marker.x, ship.y - marker.y),
    ms: decision.ms,
    calls: decision.usage?.calls ?? 1,
    tok: decision.usage?.input_tokens ?? 0,
  };
  call.status = 'done';
  call.appliedT = ship.t;
  appliedCallId = call.id;
  marker.action = decision.action;
  marker.ax = ship.x;
  marker.ay = ship.y;
  flash = 1;
  appliedCount = appliedCount + 1;
  latencySum = latencySum + decision.ms;
  latencies.push(decision.ms);
  if (latencies.length > MAX_LATENCIES) {
    latencies.shift();
  }
}

/** @param {any} event */
function openLatestCallInPlayground(event) {
  event.target.blur();
  if (!latestCapture) {
    return alert('no model call yet');
  }
  localStorage.setItem('pg.capture', JSON.stringify(latestCapture));
  window.open('/playground#capture', '_blank');
}

// ---- "How the model sees the game" ----

/** Remember the latest body so it can be opened in the playground. @param {any} call */
function captureForPlayground(call) {
  const decision = call.res;
  const upstream = decision.upstream;
  try {
    let label = `${decision.variant} call #${call.id}`;
    if (upstream.multi) {
      const madeCount = upstream.calls.filter((/** @type {any} */ sub) => !sub.skipped).length;
      label += ' (sub-call 1 of ' + madeCount + ': ' + upstream.calls[0].name + ')';
    }
    latestCapture = { body: JSON.parse(upstream.body), host: options.host, label };
  } catch {
    // Keep the previous capture.
  }
}

/** @param {any} decision */
function howHeaderHTML(decision, callId) {
  const upstream = decision.upstream;
  const fellBack = decision.fellBack
    ? '<b style="color:#f55">primary host unreachable → fell back to secondary</b> · '
    : '';
  const modeLabel = esc(modeLabels[decision.variant] || decision.variant);
  return (
    `<div class="meta">${fellBack}<b style="color:#ff0">${modeLabel}</b> · ` +
    `${esc(decision.model)} · call #${callId} · ${decision.ms} ms · ` +
    `${decision.usage?.calls ?? 1} call(s) · ${decision.usage?.input_tokens ?? '?'} tok · ` +
    `${esc(upstream.url)}</div>`
  );
}

/** @param {any} decision */
function controlTableHTML(decision) {
  const rows = decision.table.map((/** @type {string} */ line) => `<tr><td colspan=3>${esc(line)}</td></tr>`);
  return `<h3>code: fixed map from answers to controls</h3><table class="ex">${rows.join('')}</table>`;
}

/** @param {any} decision */
function resultLineHTML(decision) {
  const throttle = decision.throttle ? ` · throttle <b>${esc(decision.throttle)}</b>` : '';
  const targetSpeed = decision.tvx != null ? ` · target vx ${decision.tvx} m/s` : '';
  return (
    `<div class="meta">→ <b style="color:${ACTION_COLORS[decision.action]}">` +
    `${esc(decision.action)}</b>${throttle}${targetSpeed}</div>`
  );
}

/** @param {any} decision */
function policyHowHTML(decision) {
  const upstream = decision.upstream;
  const answerRows = upstream.calls.map(
    (/** @type {any} */ sub) =>
      `<tr><td>${esc(sub.name)}</td><td>${esc(sub.request.questions.q.instructions)}</td>` +
      `<td><b>${Number(sub.p).toFixed(2)}</b></td></tr>`,
  );
  return (
    `<h3>pilot policy (lander/modes/policies/${esc(decision.policy)}.txt; ` +
    `edit the text to change behavior)</h3>` +
    `<pre style="white-space:pre-wrap;color:#ff0">${esc(decision.policyText)}</pre>` +
    `<h3>ship state sent (compact JSON)</h3>` +
    `<pre>${esc(JSON.stringify(upstream.calls[0].request.state.ship, null, 1))}</pre>` +
    `<h3>model: judgment answers (probabilities, used graded)</h3>` +
    `<table class="ex">${answerRows.join('')}</table>`
  );
}

/** "a 0.80 · b 0.20", highest first. @param {Record<string, number> | undefined} probabilities */
function probabilityList(probabilities) {
  return Object.entries(probabilities || {})
    .sort((a, b) => b[1] - a[1])
    .map(([option, probability]) => `${esc(option)} ${Number(probability).toFixed(2)}`)
    .join(' · ');
}

/** @param {any} decision */
/**
 * The landing-pad choice made with this decision, if one was (pads layout).
 * @param {any} pad
 */
function padChoiceHTML(pad) {
  if (!pad) {
    return '';
  }
  return (
    `<h3>landing pad choice (its own call, ${pad.ms} ms): <b>${esc(pad.target)}</b> · ` +
    `${Math.round(pad.confidence * 100)}%</h3>` +
    `<pre style="white-space:pre-wrap;color:#fc6">${esc(pad.state)}</pre>` +
    `<div class="meta">${probabilityList(pad.probabilities)}</div>`
  );
}

function proseHowHTML(decision) {
  const upstream = decision.upstream;
  const body = JSON.parse(upstream.body);
  const answerRows = Object.entries(decision.answers).map(
    ([question, answer]) =>
      `<tr><td>${esc(question)}</td><td><b>${esc(answer.choice)}</b></td>` +
      `<td>${probabilityList(answer.probabilities)}</td></tr>`,
  );
  const questionNotes = Object.entries(body.questions).map(
    ([question, details]) =>
      `<div class="meta"><b>${esc(question)}</b> (${esc(details.type)}): ` +
      `${esc(details.instructions)}<br>options: ${esc(JSON.stringify(details.criteria))}</div>`,
  );
  return {
    perception:
      `<h3>perception: prose state sent (written by code from the physics, standing in for a ` +
      `vision model)</h3><pre style="white-space:pre-wrap;color:#fc6">${esc(body.state)}</pre>` +
      `<h3>model: choice answers (questions from lander/modes/prose.json)</h3>` +
      `<table class="ex">${answerRows.join('')}</table>` +
      padChoiceHTML(decision.pad),
    details:
      `<details><summary>question instructions + criteria</summary>` +
      `${questionNotes.join('')}</details>` +
      `<h3>exact body POSTed (${upstream.body.length} bytes)</h3>` +
      `<pre>${esc(JSON.stringify(body, null, 2))}</pre>` +
      `<h3>raw response</h3><pre>${esc(upstream.rawResponse)}</pre>`,
  };
}

/** Fill the "How the model sees the game" panel for the latest call. @param {any} call */
function renderHow(call) {
  const decision = call.res;
  captureForPlayground(call);
  const header = howHeaderHTML(decision, call.id);
  const table = controlTableHTML(decision);
  const result = resultLineHTML(decision);
  const howBody = byId('howBody');

  if (decision.policyText) {
    howBody.innerHTML =
      header +
      policyHowHTML(decision) +
      result +
      table +
      `<h3>every exact body POSTed and raw response</h3>` +
      subCallsHTML(decision, true);
    return;
  }
  if (decision.upstream.multi) {
    howBody.innerHTML =
      header +
      `<div class="meta">The model answers one tiny yes/no fact per call; each call gets only ` +
      `the rounded numbers it needs. Question keys are neutral ("q").</div>` +
      result +
      table +
      `<h3>every exact body POSTed and raw response, in order</h3>` +
      subCallsHTML(decision, true);
    return;
  }
  const prose = proseHowHTML(decision);
  howBody.innerHTML = header + prose.perception + result + table + prose.details;
}

// ---- Asking the model ----

/**
 * Log the pad-choice call (pads layout) as its own entry, just before the flight call it came with.
 * @param {any} call  the flight call @param {any} decision
 */
function logPadCall(call, decision) {
  if (!decision.pad?.upstream) {
    return;
  }
  callNumber = callNumber + 1;
  const padCall = {
    id: callNumber,
    kind: 'pad',
    flightCallId: call.id,
    wall: call.wall,
    sentT: call.sentT,
    status: 'done',
    res: decision.pad,
  };
  const flightIndex = calls.indexOf(call);
  calls.splice(Math.max(0, flightIndex), 0, padCall);
  if (calls.length > MAX_LOGGED_CALLS) {
    calls.shift();
  }
}

/** Send the ship state to /decide, unless a call is already in flight. */
async function ask() {
  if (!aiPiloting || paused || inflightCall || !pilot.shouldSend(ship)) {
    return;
  }
  const generation = flightGeneration;
  // With latency compensation, this is the state predicted for when the reply lands.
  const { call: pilotCall, requestShip } = pilot.send(ship);
  callNumber = callNumber + 1;
  const call = {
    id: callNumber,
    wall: wallClock(),
    sentT: ship.t,
    sent: { ...requestShip },
    pilotCall,
    status: 'pending',
    t0: performance.now(),
  };
  const marker = { x: ship.x, y: ship.y, id: call.id, action: null };
  markers.push(marker);
  if (markers.length > MAX_MARKERS) {
    markers.shift();
  }
  inflightCall = call;
  calls.push(call);
  if (calls.length > MAX_LOGGED_CALLS) {
    calls.shift();
  }
  renderLog();

  try {
    const response = await fetch('/decide', {
      method: 'POST',
      body: JSON.stringify({ sim: requestShip, ...options }),
    });
    const decision = await response.json();
    if (decision.error) {
      throw decision.error;
    }
    if (DELAY_MS > 0) {
      await new Promise((resolve) => setTimeout(resolve, DELAY_MS));
    }
    call.res = decision;
    logPadCall(call, decision);
    if (generation !== flightGeneration) {
      call.status = 'stale';
    } else if (paused) {
      call.status = 'held';
      heldReply = { call, decision, marker };
    } else {
      applyDecision(call, decision, marker);
    }
    // A reply from before a reset is discarded, not shown.
    if (generation === flightGeneration) {
      renderHow(call);
    }
  } catch (error) {
    call.status = 'error';
    call.err = String(error);
    if (generation === flightGeneration) {
      pilot.abandon();
    }
  }
  if (inflightCall === call) {
    inflightCall = null;
  }
  renderLog();
}

// ---- HUD ----

/** @param {...[string, string]} pairs */
function hudRow(...pairs) {
  const cells = pairs.map(
    ([label, value]) => `<span><span class="k">${label}</span> <span class="v">${value}</span></span>`,
  );
  return `<div class="r">${cells.join('')}</div>`;
}

/** @param {number} fuel @param {string} color */
function fuelBar(fuel, color) {
  const barColor = fuel < 20 ? '#f44' : color;
  return (
    `<span class="fb"><i style="width:${Math.max(0, fuel)}%;background:${barColor}"></i></span>` +
    `${fuel.toFixed(0)}%`
  );
}

/** Pads layout: the chosen pad, its reward and the model's confidence. */
function targetRowHTML() {
  if (!ship.layout) {
    return '';
  }
  if (!ship.target) {
    return hudRow(['target pad', 'choosing…']);
  }
  const pad = targetPad(ship);
  const confidence = Math.round((ship.targetP ?? 0) * 100);
  return hudRow(['target pad', `${esc(pad.id)} ×${pad.reward} · ${confidence}%`]);
}

/** @param {Ship} state @param {string} color */
function shipRows(state, color) {
  return (
    hudRow(
      ['alt', (state.y - targetPad(state).y).toFixed(1) + ' m'],
      ['vy', signed(state.vy) + ' m/s'],
      ['vx', signed(state.vx) + ' m/s'],
    ) + hudRow(['tilt', degrees(state.angle)], ['fuel', fuelBar(state.fuel, color)])
  );
}

function pilotLabel() {
  if (!aiPiloting) {
    return 'MANUAL (arrows)';
  }
  const model = esc(options.model || 'tev1:4b');
  const host = esc(options.host || 'primary');
  const mode = esc(modeLabels[options.variant] || options.variant);
  return `AI ${model} @ ${host} · ${mode}`;
}

/** @param {number} now @param {boolean} burning @param {string} callRate */
function hudHTML(now, burning, callRate) {
  let html =
    `<div class="g">SHIP · t ${ship.t.toFixed(1)} s · ${options.timeScale}×` +
    `${paused ? ' · PAUSED' : ''}</div>` +
    shipRows(ship, '#0f8') +
    targetRowHTML();
  html += `<div class="k" style="font-size:11px">start: ${esc(startInfo)}</div>`;
  html += `<div class="g">PILOT · ${pilotLabel()}</div>`;

  const engine = activeDecision.throttle ? activeDecision.throttle.toUpperCase() : 'ON';
  html += hudRow(
    ['action', aiPiloting ? activeDecision.action ?? '-' : '-'],
    ['engine', burning ? `<span class="on">${engine}</span>` : 'off'],
  );

  if (aiPiloting) {
    let lastCall = '-';
    if (lastGap) {
      const subCalls = lastGap.calls > 1 ? ` (${lastGap.calls} sub-calls)` : '';
      lastCall = `#${lastGap.id} · ${lastGap.ms} ms${subCalls}`;
    }
    let status = 'idle';
    if (inflightCall) {
      status = `calling ${Math.round(now - inflightCall.t0)} ms`;
    } else if (ship.outcome) {
      status = 'done';
    }
    html +=
      hudRow(['call', lastCall], ['lag', lastGap ? lastGap.dt.toFixed(1) + ' s' : '-']) +
      hudRow(
        ['now', status],
        ['avg', appliedCount ? (latencySum / appliedCount).toFixed(0) + ' ms' : '-'],
        ['rate', callRate + '/s'],
      ) +
      pilotRowsHTML();
  }
  return html + '<div class="k" style="margin-top:4px;font-size:11px">? = keys &amp; legend</div>';
}

/** Decision rate (target vs actual, in sim time), controls vs targets, and safety flags. */
function pilotRowsHTML() {
  const settings = pilot.settings;
  const actual = pilot.actualRate(ship).toFixed(1);
  const throttlePercent = Math.round(pilot.controls.throttle * 100) + '%';
  const targetPercent = Math.round(pilot.targets.throttle * 100) + '%';
  const flags = [];
  if (pilot.isLate(ship)) {
    flags.push('<span class="on">LATE REPLY</span>');
  }
  if (pilot.stats.leaseExpired) {
    flags.push('<span class="on">burn lease expired</span>');
  }
  if (pilot.stats.climbGuardActive) {
    flags.push('<span class="on">climb guard</span>');
  }
  const onOff = (/** @type {boolean} */ value) => (value ? 'on' : 'off');
  return (
    hudRow(
      ['decisions/s', `${rateLabel(settings.rate)} → ${actual}`],
      ['throttle', `${throttlePercent} (target ${targetPercent})`],
    ) +
    hudRow(
      ['smooth', onOff(settings.smoothing)],
      ['comp', onOff(settings.latencyComp)],
      ['impulse', onOff(settings.impulseLimits)],
      ['delay', DELAY_MS + ' ms'],
    ) +
    hudRow(
      ['age', pilot.stats.lastAge.toFixed(2) + ' s'],
      ['discarded', String(pilot.stats.discarded)],
      ['skipped (same scene)', String(sameSceneSkips)],
    ) +
    (flags.length ? `<div class="r">${flags.join(' · ')}</div>` : '')
  );
}

// ---- Pilot loop controls ----

function setUpPilotControls() {
  const rateSelect = byId('selrate');
  rateSelect.innerHTML = RATE_CHOICES.map(
    (choice) => `<option value="${choice}">${choice}/s</option>`,
  ).join('');
  // Older versions could save 'max'; it is no longer offered, so store the default instead.
  if (localStorage.getItem('lander.rate') === 'max') {
    localStorage.setItem('lander.rate', String(DEFAULT_SETTINGS.rate));
  }
  rateSelect.value = rateLabel(pilotSettings.rate);
  rateSelect.onchange = (/** @type {any} */ event) => {
    pilotSettings.rate = uiRate(event.target.value);
    pilot.settings.rate = pilotSettings.rate;
    localStorage.setItem('lander.rate', event.target.value);
    event.target.blur();
  };

  /** @type {[string, 'smoothing' | 'latencyComp' | 'impulseLimits', string][]} */
  const toggles = [
    ['smooth', 'smoothing', 'smooth'],
    ['comp', 'latencyComp', 'comp'],
    ['impulse', 'impulseLimits', 'impulse'],
  ];
  for (const [elementId, settingKey, storageKey] of toggles) {
    const checkbox = byId(elementId);
    checkbox.checked = pilotSettings[settingKey];
    checkbox.onchange = (/** @type {any} */ event) => {
      pilotSettings[settingKey] = event.target.checked;
      pilot.settings[settingKey] = event.target.checked;
      localStorage.setItem('lander.' + storageKey, event.target.checked ? '1' : '0');
      event.target.blur();
    };
  }
}

// ---- Drawing ----

let lastFrameTime = performance.now();
let canvasWidth = 0;
let canvasHeight = 0;
let lastHudUpdate = 0;

/** World → canvas coordinates for the current canvas size. */
function worldToCanvas() {
  const scaleX = canvasWidth / W;
  return {
    toX: (/** @type {number} */ x) => x * scaleX,
    toY: (/** @type {number} */ y) => canvasHeight - y * Math.min(scaleX, canvasHeight / 140),
  };
}

function resizeCanvasIfNeeded() {
  const rect = canvas.getBoundingClientRect();
  if (rect.width !== canvasWidth || rect.height !== canvasHeight) {
    canvasWidth = canvas.width = rect.width;
    canvasHeight = canvas.height = rect.height;
  }
}

/** @param {(x: number) => number} toX @param {(y: number) => number} toY */
function drawTerrainAndPad(toX, toY) {
  context.strokeStyle = '#888';
  context.beginPath();
  for (let x = 0; x <= W; x++) {
    context.lineTo(toX(x), toY(terrainY(x, padsFor(ship))));
  }
  context.stroke();

  for (const pad of padsFor(ship)) {
    drawPad(pad, toX, toY);
  }
}

/**
 * One pad, with its sign in the pads layout. The target pad is bright; the others are dim.
 * @param {import('./sim.mjs').Pad} pad
 * @param {(x: number) => number} toX @param {(y: number) => number} toY
 */
function drawPad(pad, toX, toY) {
  const isTarget = !ship.layout || pad.id === ship.target;
  context.strokeStyle = isTarget ? '#ff0' : '#886';
  context.lineWidth = isTarget ? 4 : 3;
  context.beginPath();
  context.moveTo(toX(pad.x0), toY(pad.y));
  context.lineTo(toX(pad.x1), toY(pad.y));
  context.stroke();
  context.lineWidth = 1;
  if (!ship.layout || !pad.sign) {
    return;
  }
  const centerX = toX((pad.x0 + pad.x1) / 2);
  const signY = toY(pad.y) - 10;
  let label = pad.sign;
  if (pad.id === ship.target) {
    label = `▼ ${pad.sign} · ${Math.round((ship.targetP ?? 0) * 100)}%`;
  }
  context.font = '11px monospace';
  context.textAlign = 'center';
  context.fillStyle = isTarget ? '#ff0' : '#aa9';
  context.fillText(label, centerX, signY);
  context.textAlign = 'start';
}

/**
 * Call markers: a ring where a request was sent, a dot where its result was applied, and a line
 * between them (the latency gap).
 * @param {(x: number) => number} toX @param {(y: number) => number} toY
 */
function drawMarkers(toX, toY) {
  if (showMarkers) {
    for (const marker of markers) {
      const color = ACTION_COLORS[marker.action] || '#ff0';
      context.globalAlpha = marker.id === appliedCallId ? 1 : 0.55;
      context.strokeStyle = color;
      context.beginPath();
      context.arc(toX(marker.x), toY(marker.y), 3.5, 0, 7);
      context.stroke();
      if (marker.ax != null) {
        context.beginPath();
        context.moveTo(toX(marker.x), toY(marker.y));
        context.lineTo(toX(marker.ax), toY(marker.ay));
        context.stroke();
        context.fillStyle = color;
        context.beginPath();
        context.arc(toX(marker.ax), toY(marker.ay), 2.5, 0, 7);
        context.fill();
      }
    }
  }
  context.globalAlpha = 1;

  // A dashed line from where the in-flight call was sent to where the ship is now.
  if (inflightCall && showMarkers) {
    const marker = markers[markers.length - 1];
    context.strokeStyle = '#ff0';
    context.setLineDash([3, 3]);
    context.beginPath();
    context.moveTo(toX(marker.x), toY(marker.y));
    context.lineTo(toX(ship.x), toY(ship.y));
    context.stroke();
    context.setLineDash([]);
  }
}

/**
 * @param {(x: number) => number} toX @param {(y: number) => number} toY
 * @param {boolean | number} thrust @param {number} timeStep
 */
function drawShip(toX, toY, thrust, timeStep) {
  context.save();
  context.translate(toX(ship.x), toY(ship.y));
  context.rotate(ship.angle);

  // A glow in the action's color when a decision was just applied.
  if (flash > 0) {
    const color = ACTION_COLORS[activeDecision.action] || '#fff';
    context.shadowColor = color;
    context.shadowBlur = 25 * flash;
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.strokeRect(-9, -17, 18, 20);
    context.lineWidth = 1;
    flash = Math.max(0, flash - timeStep * 3);
  }
  context.fillStyle = '#ddd';
  context.fillRect(-6, -14, 12, 14);
  context.shadowBlur = 0;

  if (thrust && ship.fuel > 0 && !ship.outcome) {
    context.fillStyle = flash > 0.3 ? '#ff0' : '#f80';
    context.beginPath();
    context.moveTo(-4, 0);
    context.lineTo(4, 0);
    context.lineTo(0, 12 + Math.random() * 6 + flash * 8);
    context.fill();
  }
  context.restore();
}

function showOutcomeIfNew() {
  if (!ship.outcome || shownOutcome === ship.outcome) {
    return;
  }
  shownOutcome = ship.outcome;
  const outcomeElement = byId('outcome');
  const landed = ship.outcome === 'LANDED';
  outcomeElement.className = 'show ' + (landed ? 'win' : 'lose');
  if (landed) {
    // A landing's breakdown is all numbers (only a crash has a text reason).
    const parts = /** @type {[string, number][]} */ (Object.entries(ship.scoreBreakdown || {}));
    const breakdown = parts
      .map(([part, value]) => `${part.replace('_', ' ')} ${value > 0 ? '+' : ''}${value.toFixed(1)}`)
      .join('   ');
    outcomeElement.innerHTML =
      `<div class="big">LANDED · ${Number(ship.score).toFixed(1)}</div>` +
      `<div class="sub">${breakdown}\nlimits: |vy|<4  |vx|<2  tilt<0.30 rad · press R to reset</div>`;
  } else {
    const reason = esc(ship.outcome.replace(/^crash \(|\)$/g, ''));
    outcomeElement.innerHTML =
      `<div class="big">CRASHED</div><div class="sub">${reason}\nscore 0.0 · press R to reset</div>`;
  }
}

/** Calls applied per second of wall time this flight. */
function callRate() {
  const applied = appliedCount - appliedCountAtStart;
  if (!firstAppliedWallTime || applied <= 1 || ship.outcome) {
    return '-';
  }
  const seconds = (performance.now() - firstAppliedWallTime) / 1000;
  return ((applied - 1) / seconds).toFixed(1);
}

/** @param {number} now */
function frame(now) {
  const elapsedSeconds = Math.min(0.05, (now - lastFrameTime) / 1000);
  const timeStep = paused ? 0 : elapsedSeconds * (options.timeScale || 1);
  lastFrameTime = now;
  ask();

  // The AI flies with the active decision; manual uses the arrow keys.
  let thrust = !!keysDown.ArrowUp;
  let tilt = 'center';
  if (keysDown.ArrowLeft) {
    tilt = 'left';
  } else if (keysDown.ArrowRight) {
    tilt = 'right';
  }
  if (!paused) {
    if (aiPiloting) {
      // The pilot loop eases toward the model's targets and applies the impulse limits.
      pilot.stepShip(ship, timeStep);
    } else {
      step(ship, timeStep, thrust, /** @type {any} */ (tilt));
    }
  }
  if (aiPiloting) {
    thrust = pilot.controls.throttle > 0;
  }
  if (ship.outcome && ship.outcomeT == null) {
    ship.outcomeT = ship.t;
  }

  resizeCanvasIfNeeded();
  context.clearRect(0, 0, canvasWidth, canvasHeight);
  const { toX, toY } = worldToCanvas();
  drawTerrainAndPad(toX, toY);
  drawMarkers(toX, toY);
  if (inflightCall) {
    const elapsedElement = logElement.querySelector('.el');
    if (elapsedElement) {
      elapsedElement.textContent = Math.round(now - inflightCall.t0);
    }
  }
  drawShip(toX, toY, thrust, timeStep);

  if (!firstAppliedWallTime && appliedCount > appliedCountAtStart) {
    firstAppliedWallTime = performance.now();
  }
  const burning = !!thrust && ship.fuel > 0 && !ship.outcome;
  const rate = callRate();
  // The HUD is HTML, so update it at most 10 times a second.
  if (now - lastHudUpdate > 100) {
    lastHudUpdate = now;
    hud.innerHTML = hudHTML(now, burning, rate);
  }
  showOutcomeIfNew();
  requestAnimationFrame(frame);
}

// ---- Start ----

fetch('/config')
  .then((response) => response.json())
  .then(applyConfig)
  .catch(() => {});
setUpTimeScale();
setUpSelects();
setUpControls();
setUpPilotControls();
reset();
requestAnimationFrame(frame);
