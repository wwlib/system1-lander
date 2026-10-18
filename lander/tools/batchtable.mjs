// @ts-check
// Summarize headless logs into a markdown table: landed, score, touchdown speeds, fuel, failures,
// and how often each code assist engaged (events / seconds per flight).
// Usage: node lander/tools/batchtable.mjs <log prefix> [config …]
//   reads results/<prefix>-<config>-<classic|pads>-<run>.log; without configs, every config found.
//   RUNS=2 counts only that run number (e.g. the uncontended run).

import fs from 'node:fs';

const prefix = process.argv[2] || 'batch25-ablation';
const wantedConfigs = process.argv.slice(3);
const onlyRun = process.env.RUNS || '';

/**
 * Totals for one config and layout.
 * @typedef {object} Group
 * @property {number} runs @property {number} flights @property {number} landed
 * @property {number[]} scores @property {number[]} sideways @property {number[]} sink @property {number[]} fuel
 * @property {Record<string, number>} failures
 * @property {Record<string, number>} engaged  leaseEvents, leaseSeconds, climbEvents, …
 */

/** @type {Record<string, Group>} */
const groups = {};
/** @type {string[]} */
const configOrder = [];

/** @param {number[]} values */
function average(values) {
  if (!values.length) {
    return NaN;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * One failure in a few words: "tilt", "vy (fuel out)", "off-pad".
 * @param {string} line
 */
function failureKind(line) {
  const reason = /crash \(([^)]*)\)/.exec(line)?.[1] || 'other';
  const parts = [];
  if (/vy/.test(reason)) {
    parts.push('vy');
  }
  if (/vx/.test(reason)) {
    parts.push('vx');
  }
  if (/tilt/.test(reason)) {
    parts.push('tilt');
  }
  if (/off pad/.test(reason)) {
    parts.push('off-pad');
  }
  if (/out of bounds|timeout/.test(reason) || line.includes('FLEW-AWAY')) {
    parts.push('flew-away');
  }
  let kind = parts.join('+') || reason;
  if (/ fuel=0 /.test(line)) {
    kind = kind + ' (fuel out)';
  }
  return kind;
}

const fileNames = fs.readdirSync('results').filter((name) => name.startsWith(prefix + '-') && name.endsWith('.log'));
for (const fileName of fileNames.sort()) {
  const match = fileName.slice(prefix.length + 1, -4).match(/^(.*)-(classic|pads)-(\d+)$/);
  if (!match) {
    continue;
  }
  const [, config, layout, run] = match;
  if (wantedConfigs.length && !wantedConfigs.includes(config)) {
    continue;
  }
  if (onlyRun && onlyRun !== run) {
    continue;
  }
  const text = fs.readFileSync('results/' + fileName, 'utf8');
  if (!text.includes('SUMMARY')) {
    continue;
  }
  if (!configOrder.includes(config)) {
    configOrder.push(config);
  }
  const key = config + ' ' + layout;
  groups[key] = groups[key] || {
    runs: 0, flights: 0, landed: 0, scores: [], sideways: [], sink: [], fuel: [], failures: {},
    engaged: { leaseEvents: 0, leaseSeconds: 0, climbEvents: 0, climbSeconds: 0, levelEvents: 0, levelSeconds: 0 },
  };
  const group = groups[key];
  group.runs = group.runs + 1;
  for (const line of text.split('\n')) {
    if (!line.includes(' -> ')) {
      continue;
    }
    const number = (/** @type {RegExp} */ pattern) => Number(pattern.exec(line)?.[1]);
    group.flights = group.flights + 1;
    group.scores.push(number(/score=([\d.]+)/));
    group.fuel.push(number(/ fuel=(\d+)/));
    const assists = /lease=(\d+)\/([\d.]+)s climb=(\d+)\/([\d.]+)s level=(\d+)\/([\d.]+)s/.exec(line);
    if (assists) {
      const names = ['leaseEvents', 'leaseSeconds', 'climbEvents', 'climbSeconds', 'levelEvents', 'levelSeconds'];
      names.forEach((name, index) => {
        group.engaged[name] = group.engaged[name] + Number(assists[index + 1]);
      });
    }
    if (line.includes('LANDED')) {
      group.landed = group.landed + 1;
      group.sideways.push(Math.abs(number(/touch_vx=(-?[\d.]+)/)));
      group.sink.push(-number(/touch_vy=(-?[\d.]+)/));
    } else {
      const kind = failureKind(line);
      group.failures[kind] = (group.failures[kind] || 0) + 1;
    }
  }
}

console.log('| config | layout | runs | landed | avg score | touch \\|vx\\| | touch sink | fuel left | failures | lease ×/s | climb guard ×/s | level ×/s |');
console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
for (const config of wantedConfigs.length ? wantedConfigs : configOrder) {
  for (const layout of ['classic', 'pads']) {
    const group = groups[config + ' ' + layout];
    if (!group) {
      continue;
    }
    const perFlight = (/** @type {string} */ name) => (group.engaged[name] / group.flights).toFixed(1);
    const failures = Object.entries(group.failures).map(([kind, count]) => `${count} ${kind}`).join(', ') || '–';
    const engagement = (/** @type {string} */ name) => `${perFlight(name + 'Events')} / ${perFlight(name + 'Seconds')}`;
    console.log(
      `| ${config} | ${layout} | ${group.runs} | ${group.landed}/${group.flights} | ${average(group.scores).toFixed(2)} | ` +
        `${average(group.sideways).toFixed(2)} | ${average(group.sink).toFixed(2)} | ${average(group.fuel).toFixed(0)}% | ` +
        `${failures} | ${engagement('lease')} | ${engagement('climb')} | ${engagement('level')} |`,
    );
  }
}
