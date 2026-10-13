// @ts-check
// The System 1 Playground: edit a /v1/systemone body (state + questions), send it through the
// server proxy (/api/systemone) to one or two models, and see the answers, timing and raw JSON.
//
// URL parameters: ?example=<id> ?model=<name> ?compare=<model B> ?run=1 ?redact=1
// #capture loads the call the game saved with "open latest call in playground".

// ?redact=1 masks IPv4 host addresses (for screenshots).
const REDACT = new URLSearchParams(location.search).has('redact');

/** @type {any[]} */
let examples = [];
/** @type {any} */
let config = {};

/** @param {string} id @returns {any} */
function byId(id) {
  return document.getElementById(id);
}

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

// ---- The editor ----

/** 'json' or 'text': how the state box is sent. */
function stateMode() {
  const checked = /** @type {HTMLInputElement} */ (
    document.querySelector('input[name=sm]:checked')
  );
  return checked.value;
}

/** Put a state into the editor and pick the matching JSON / prose radio. @param {any} state */
function setState(state) {
  const isText = typeof state === 'string';
  const radio = /** @type {HTMLInputElement} */ (
    document.querySelector(`input[name=sm][value=${isText ? 'text' : 'json'}]`)
  );
  radio.checked = true;
  byId('state').value = isText ? state : JSON.stringify(state, null, 2);
}

/** @param {any} example */
function loadExample(example) {
  setState(example.state);
  byId('qs').value = JSON.stringify(example.questions, null, 2);
  byId('exnote').textContent = example.note || '';
}

/**
 * The /v1/systemone body for a model, from the editor.
 * @param {string} model
 * @throws {string} a message when the state or questions are not valid JSON
 */
function buildBody(model) {
  let state;
  let questions;
  byId('err').textContent = '';
  if (stateMode() === 'json') {
    try {
      state = JSON.parse(byId('state').value);
    } catch (error) {
      const reason = /** @type {Error} */ (error).message;
      throw `state is not valid JSON: ${reason} (switch to "prose text" to send a string)`;
    }
  } else {
    state = byId('state').value;
  }
  try {
    questions = JSON.parse(byId('qs').value);
  } catch (error) {
    throw 'questions is not valid JSON: ' + /** @type {Error} */ (error).message;
  }
  const keepAlive = byId('ka').value.trim();
  return { model, state, questions, ...(keepAlive ? { keep_alive: keepAlive } : {}) };
}

// ---- Models ----

/** @param {HTMLSelectElement} select @param {string | null} value */
function hasOption(select, value) {
  return [...select.options].some((option) => option.value === value);
}

/** Fill the model A / B lists from the selected host, keeping earlier choices. */
async function loadModels() {
  const url = '/api/models?host=' + encodeURIComponent(byId('host').value);
  const response = await fetch(url);
  const reply = await response.json().catch(() => ({ models: [] }));

  const modelOptions = (reply.models || []).map(
    (/** @type {any} */ model) =>
      `<option value="${esc(model.name)}">${esc(model.name)} ` +
      `${model.params ? '(' + esc(model.params) + ')' : ''}</option>`,
  );
  const optionsHTML = modelOptions.join('') || `<option>${esc(config.model || 'tev1:4b')}</option>`;

  for (const selectId of ['mA', 'mB']) {
    const select = byId(selectId);
    const keep = select.value || localStorage.getItem('pg.' + selectId);
    select.innerHTML = optionsHTML;
    if (hasOption(select, keep)) {
      select.value = keep;
    }
  }
  // First visit: default to tev1:4b versus nimble:9b.
  if (!localStorage.getItem('pg.mA') && hasOption(byId('mA'), 'tev1:4b')) {
    byId('mA').value = 'tev1:4b';
  }
  if (!localStorage.getItem('pg.mB') && hasOption(byId('mB'), 'nimble:9b')) {
    byId('mB').value = 'nimble:9b';
  }
}

// ---- Results ----

/** @param {string} label @param {number} probability @param {boolean} isTop */
function probabilityBar(label, probability, isTop) {
  return (
    `<div class="bar"><span class="${isTop ? 'top' : ''}">${esc(label)}</span>` +
    `<i style="width:${Math.round(probability * 200)}px"></i>${Number(probability).toFixed(3)}</div>`
  );
}

/** @param {string} key @param {any} answer */
function answerHTML(key, answer) {
  if (answer.type === 'noul' || 'noul' in answer) {
    return (
      `<h3>${esc(key)} · noul</h3>` +
      probabilityBar('true (yes)', answer.noul, answer.noul > 0.5) +
      probabilityBar('false (no)', 1 - answer.noul, answer.noul <= 0.5)
    );
  }
  if (answer.type === 'score') {
    const confidence =
      answer.confidence != null ? ` · confidence ${Number(answer.confidence).toFixed(2)}` : '';
    const levelBars = Object.entries(answer.probabilities || {}).map(([level, probability]) =>
      probabilityBar(
        level + ': ' + (answer.legend?.[level] ?? ''),
        probability,
        String(Math.round(answer.score)) === level,
      ),
    );
    return (
      `<h3>${esc(key)} · score <b class="top">${Number(answer.score).toFixed(2)}</b>` +
      `${confidence}</h3>` +
      levelBars.join('')
    );
  }
  const optionBars = Object.entries(answer.probabilities || {})
    .sort((first, second) => second[1] - first[1])
    .map(([option, probability]) => probabilityBar(option, probability, option === answer.choice));
  return `<h3>${esc(key)} · choice → <b class="top">${esc(answer.choice)}</b></h3>` + optionBars.join('');
}

/** Bars for every answer in a response. @param {any} response */
function answersHTML(response) {
  const answers = response?.answers || {};
  return Object.entries(answers)
    .map(([key, answer]) => answerHTML(key, answer))
    .join('');
}

/** The number a summary averages for an answer. @param {any} answer */
function answerValue(answer) {
  if (!answer) {
    return NaN;
  }
  if ('noul' in answer) {
    return answer.noul;
  }
  if (answer.type === 'score') {
    return answer.score;
  }
  return answer.probabilities?.[answer.choice];
}

/** The label a summary counts for an answer. @param {any} answer */
function answerLabel(answer) {
  if (!answer) {
    return '?';
  }
  if ('noul' in answer) {
    return answer.noul > 0.5 ? 'true' : 'false';
  }
  if (answer.type === 'score') {
    return Math.round(answer.score);
  }
  return answer.choice;
}

/** Latency and answer statistics over several runs. @param {any[]} runs */
function runsSummaryHTML(runs) {
  if (runs.length < 2) {
    return '';
  }
  const latencies = runs.map((run) => run.ms);
  const sorted = [...latencies].sort((a, b) => a - b);
  const keys = Object.keys(runs[0].response?.answers || {});

  const rows = keys.map((key) => {
    const values = runs.map((run) => answerValue(run.response?.answers?.[key]));
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
    const standardDeviation = Math.sqrt(variance);
    /** @type {Record<string, number>} */
    const labelCounts = {};
    for (const run of runs) {
      const label = answerLabel(run.response?.answers?.[key]);
      labelCounts[label] = (labelCounts[label] || 0) + 1;
    }
    const counts = Object.entries(labelCounts)
      .map(([label, count]) => label + '×' + count)
      .join(' ');
    return (
      `<tr><td>${esc(key)}</td><td>mean ${mean.toFixed(3)} ± ${standardDeviation.toFixed(3)}</td>` +
      `<td>${esc(counts)}</td></tr>`
    );
  });

  return (
    `<h3>${runs.length} runs · latency ms min ${sorted[0]} · median ${sorted[sorted.length >> 1]} · ` +
    `max ${sorted[sorted.length - 1]} · all: ${latencies.join(', ')}</h3><table>` +
    rows.join('') +
    '</table>'
  );
}

/** @param {string} model @param {any} lastRun @param {any[]} runs */
function resultBoxHTML(model, lastRun, runs) {
  const usage = lastRun.response?.usage || {};
  const answers = lastRun.response?.error
    ? `<div class="err">${esc(lastRun.response.error)}</div>`
    : answersHTML(lastRun.response);
  const sentUpstream = lastRun.sent
    ? `<h3>as sent upstream (provider adapter)</h3>` +
      `<pre>${esc(JSON.stringify(lastRun.sent, null, 2))}</pre>`
    : '';
  return (
    `<h3 style="font-size:14px">${esc(model)} <span class="meta">@ ${esc(lastRun.host)}</span></h3>` +
    `<div class="meta">upstream ${lastRun.upstreamStatus} · ` +
    `<b style="color:#fff">${lastRun.ms} ms</b> (server→model) · ${lastRun.rt} ms round trip · ` +
    `tokens in ${usage.input_tokens ?? '?'} / out ${usage.output_tokens ?? '?'} · ` +
    `${esc(lastRun.url)}</div>` +
    answers +
    runsSummaryHTML(runs) +
    `<h3>raw request payload (${JSON.stringify(lastRun.request).length} bytes)</h3>` +
    `<pre>${esc(JSON.stringify(lastRun.request, null, 2))}</pre>` +
    sentUpstream +
    `<h3>raw response</h3><pre>${esc(lastRun.raw)}</pre>`
  );
}

// ---- Sending ----

/**
 * Send the body to one model `runs` times and fill its result box.
 * @param {string} model @param {HTMLElement} box
 */
async function runModel(model, box) {
  const runCount = Math.max(1, Math.min(50, Number(byId('n').value) || 1));
  const runs = [];
  let body;
  try {
    body = buildBody(model);
  } catch (error) {
    byId('err').textContent = error;
    return;
  }
  const statusElement = /** @type {HTMLElement} */ (box.querySelector('.st'));
  for (let run = 0; run < runCount; run++) {
    statusElement.textContent = `run ${run + 1}/${runCount}…`;
    const startedAt = performance.now();
    const response = await fetch('/api/systemone', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ host: byId('host').value, body }),
    });
    const result = await response.json();
    result.rt = Math.round(performance.now() - startedAt);
    if (result.error) {
      const details = (result.details || []).map(esc).join('<br>');
      box.innerHTML =
        `<h3>${esc(model)}</h3><div class="err">${esc(result.error)}<br>${details}</div>`;
      return;
    }
    runs.push(result);
  }
  box.innerHTML = resultBoxHTML(model, runs[runs.length - 1], runs);
}

/** Send to model A (and model B when comparing), in parallel. */
async function send() {
  const models = [byId('mA').value];
  if (byId('cmp').checked) {
    models.push(byId('mB').value);
  }
  byId('outs').innerHTML = models
    .map(() => `<div class="out"><span class="st meta"></span></div>`)
    .join('');
  byId('status').textContent = 'sending…';
  localStorage.setItem('pg.mA', byId('mA').value);
  localStorage.setItem('pg.mB', byId('mB').value);
  const boxes = [...byId('outs').children];
  await Promise.all(models.map((model, index) => runModel(model, boxes[index])));
  byId('status').textContent = 'done';
}

// ---- Wiring ----

function setUpControls() {
  byId('send').onclick = send;
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      send();
    }
  });
  byId('ex').onchange = () => {
    const example = examples.find((candidate) => candidate.id === byId('ex').value);
    if (example) {
      loadExample(example);
    }
  };
  byId('host').onchange = loadModels;

  // Switching to "prose text" unwraps a JSON string, so "abc" becomes abc.
  for (const radio of document.querySelectorAll('input[name=sm]')) {
    /** @type {HTMLInputElement} */ (radio).onchange = () => {
      if (stateMode() !== 'text') {
        return;
      }
      try {
        const value = JSON.parse(byId('state').value);
        if (typeof value === 'string') {
          byId('state').value = value;
        }
      } catch {
        // Not JSON; leave the text as it is.
      }
    };
  }
}

function fillHostList() {
  const hostOptions = Object.entries(config.hosts).map(
    ([hostKey, url]) =>
      `<option value="${hostKey}">${esc(config.hostLabels?.[hostKey] || hostKey)} · ` +
      `${esc(String(url).replace('/v1/systemone', ''))}</option>`,
  );
  byId('host').innerHTML = hostOptions.join('');
  byId('host').value = config.host;
}

function fillExampleList() {
  const groups = [...new Set(examples.map((example) => example.group))];
  const groupsHTML = groups.map((group) => {
    const groupOptions = examples
      .filter((example) => example.group === group)
      .map((example) => `<option value="${esc(example.id)}">${esc(group)} · ${esc(example.name)}</option>`);
    return `<optgroup label="${esc(group)}">${groupOptions.join('')}</optgroup>`;
  });
  byId('ex').innerHTML = '<option value="">— pick an example —</option>' + groupsHTML.join('');
}

/** Load the call the game saved for the playground. @param {string} savedCapture */
async function loadCapture(savedCapture) {
  const capture = JSON.parse(savedCapture);
  setState(capture.body.state);
  byId('qs').value = JSON.stringify(capture.body.questions, null, 2);
  if (capture.body.keep_alive) {
    byId('ka').value = capture.body.keep_alive;
  }
  byId('exnote').textContent = 'captured from game: ' + (capture.label || '');
  if (capture.host && config.hosts[capture.host]) {
    byId('host').value = capture.host;
  }
  await loadModels();
  if (capture.body.model) {
    byId('mA').value = capture.body.model;
  }
}

/** Load the example and models named in the URL (or the hello example). */
async function loadFromUrl() {
  await loadModels();
  const params = new URLSearchParams(location.search);
  const wanted = params.get('example');
  const example =
    examples.find((candidate) => candidate.id === wanted) ||
    examples.find((candidate) => candidate.id === 'hello:hello.mjs') ||
    examples[0];
  byId('ex').value = example.id;
  loadExample(example);
  if (params.get('model')) {
    byId('mA').value = params.get('model');
  }
  if (params.get('compare')) {
    byId('cmp').checked = true;
    byId('mB').value = params.get('compare');
  }
  if (params.get('run') === '1') {
    send();
  }
}

async function start() {
  config = await (await fetch('/config')).json();
  fillHostList();
  examples = await (await fetch('/api/examples')).json();
  fillExampleList();
  const savedCapture = localStorage.getItem('pg.capture');
  if (savedCapture && location.hash === '#capture') {
    await loadCapture(savedCapture);
  } else {
    await loadFromUrl();
  }
}

setUpControls();
start();
