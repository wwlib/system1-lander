// @ts-check
// Offline confidence-gate sweep over headless TRACE logs: for each cutoff, how many real calls
// (not same-scene reuses) would have had their thrust or sideways answer marked unsure.
// Usage: node lander/tools/gatesweep.mjs results/batch27-*.log

import fs from 'node:fs';

const CUTOFFS = [0.5, 0.6, 0.7, 0.8, 0.9];
const files = process.argv.slice(2);

for (const file of files) {
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  /** @type {{ thrust: number, side: number }[]} */
  const calls = [];
  for (const line of lines) {
    const match = line.match(/ conf=([\d.]+)\/([\d.]+) /);
    if (!match || line.includes('(same scene)')) {
      continue;
    }
    calls.push({ thrust: Number(match[1]), side: Number(match[2]) });
  }
  if (calls.length === 0) {
    continue;
  }
  const parts = CUTOFFS.map((cutoff) => {
    const thrustUnsure = calls.filter((call) => call.thrust < cutoff).length;
    const sideUnsure = calls.filter((call) => call.side < cutoff).length;
    const thrustPercent = Math.round((100 * thrustUnsure) / calls.length);
    const sidePercent = Math.round((100 * sideUnsure) / calls.length);
    return `${cutoff}: thrust ${thrustPercent}% side ${sidePercent}%`;
  });
  console.log(`${file} (${calls.length} calls) unsure at ${parts.join(' · ')}`);
}
