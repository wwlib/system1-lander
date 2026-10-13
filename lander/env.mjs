// @ts-check
// A tiny no-dependency .env loader. Import it first.
// It looks for .env in the repo root, then in lander/. Real environment variables win over .env.
// Format: KEY=value, # comments, optional quotes, optional "export ".

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LINE_PATTERN = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/**
 * @param {string} rawValue
 * @returns {string}
 */
function cleanValue(rawValue) {
  const isQuoted = /^(['"]).*\1$/.test(rawValue);
  if (isQuoted) {
    return rawValue.slice(1, -1);
  }
  // Unquoted values may end with a trailing comment.
  return rawValue.replace(/\s+#.*$/, '');
}

/** @param {string} filePath */
function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }
  const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const match = line.match(LINE_PATTERN);
    if (!match) {
      continue;
    }
    const [, key, rawValue] = match;
    if (process.env[key] === undefined) {
      process.env[key] = cleanValue(rawValue);
    }
  }
}

const here = path.dirname(fileURLToPath(import.meta.url));
loadEnvFile(path.join(here, '..', '.env'));
loadEnvFile(path.join(here, '.env'));
