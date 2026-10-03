/**
 * Finds every GATE_* environment variable the production code reads.
 *
 * Shared by scripts/generate-gate-index.js (writes the index block in
 * docs/gates-and-env.md) and scripts/check-domain-rules.js (fails when a
 * gate the code reads has no line in that file), so both agree on what a
 * gate is.
 *
 * A gate is a GATE_* name the code READS from the environment:
 *   process.env.GATE_X or env.GATE_X, process.env['GATE_X'],
 *   const { GATE_X } = process.env,
 *   a gate helper called with the name (gateEnvValue('GATE_X'),
 *   gateEnvTimestamp('GATE_X'), gate('GATE_X')), or a gate-named constant
 *   that holds the name for a later lookup (const GATE_ENV = 'GATE_X').
 * A GATE_* word in a comment, a message, a list of retired names, an error
 * code, or used as a prefix (GATE_BOOK_) is not a gate.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const SCAN_DIRS = ['server', 'client/src'];
const EXTENSIONS = new Set(['.js', '.jsx']);
const EXCLUDE_PATTERNS = [
  /\.test\.jsx?$/,
  /__mocks__/,
  /node_modules/,
  /(^|\/)tests?\//,
  /(^|\/)fixtures?\//,
  /(^|\/)migrations\//,
  /(^|\/)seeds\//,
];

const FEATURE_GATES_FILE = 'server/config/feature-gates.js';

// One read of a gate. The name must end in a letter or digit, so a prefix
// used to build a name (GATE_BOOK_ + suffix) never matches.
const NAME = 'GATE_[A-Z0-9_]*[A-Z0-9]';
const QUOTED = `['"\`](${NAME})['"\`]`;
const READ_PATTERNS = [
  new RegExp(`\\benv\\.(${NAME})\\b`, 'g'),
  new RegExp(`\\benv\\[\\s*${QUOTED}\\s*\\]`, 'g'),
  // gateEnvValue('GATE_X'), featureGates.gateEnvTimestamp('GATE_X'), gate('GATE_X')
  new RegExp(`[A-Za-z0-9_$]*[gG]ate[A-Za-z0-9_$]*\\(\\s*${QUOTED}`, 'g'),
  // const GATE_ENV = 'GATE_X'; const SUMMARY_GATE = 'GATE_X';
  new RegExp(`\\b(?:const|let|var)\\s+[A-Za-z0-9_$]*(?:GATE|[gG]ate)[A-Za-z0-9_$]*\\s*=\\s*${QUOTED}`, 'g'),
];

const DESTRUCTURED = /\{([^{}]*)\}\s*=\s*(?:process\.)?env\b/g;
const KEY = new RegExp(`^(${NAME})(?![A-Z0-9_])`);

function walk(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.relative(ROOT, full).split(path.sep).join('/');
    if (EXCLUDE_PATTERNS.some((re) => re.test(rel + (entry.isDirectory() ? '/' : '')))) continue;
    if (entry.isDirectory()) walk(full, out);
    else if (EXTENSIONS.has(path.extname(entry.name))) out.push(rel);
  }
}

// Blank out comments, keeping line breaks, so a gate named only in prose is
// not counted as read. String contents are kept: 'GATE_X' literals are reads.
function stripComments(src) {
  let out = '';
  let i = 0;
  let quote = null;
  while (i < src.length) {
    const ch = src[i];
    const next = src[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next === undefined ? '' : next;
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      i += 1;
    } else if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      out += ch;
      i += 1;
    } else if (ch === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
    } else if (ch === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n';
        i += 1;
      }
      i += 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

// The gate names one source file reads.
function gatesInSource(src) {
  const code = stripComments(src);
  const names = new Set();
  for (const pattern of READ_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(code))) names.add(match[1]);
  }
  // const { GATE_X, GATE_Y: alias = 'off' } = process.env;
  DESTRUCTURED.lastIndex = 0;
  let block;
  while ((block = DESTRUCTURED.exec(code))) {
    for (const property of block[1].split(',')) {
      const key = property.trim().match(KEY);
      if (key) names.add(key[1]);
    }
  }
  return names;
}

/**
 * @returns {Map<string, string[]>} gate name -> sorted repo-relative files that read it
 */
function scanGates() {
  const files = [];
  for (const dir of SCAN_DIRS) walk(path.join(ROOT, dir), files);
  const gates = new Map();
  for (const rel of files.sort()) {
    const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (!src.includes('GATE_')) continue;
    for (const name of gatesInSource(src)) {
      if (!gates.has(name)) gates.set(name, new Set());
      gates.get(name).add(rel);
    }
  }
  return new Map([...gates.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, set]) => [name, [...set].sort()]));
}

// The one-line description from the feature-gates.js header comment
// (` *   GATE_X=true (what it does)`), when the header has one.
function headerDescriptions() {
  const src = fs.readFileSync(path.join(ROOT, FEATURE_GATES_FILE), 'utf8');
  const out = new Map();
  const re = new RegExp(`^ \\*\\s+(${NAME})=\\S*\\s*\\((.*)\\)\\s*$`, 'gm');
  let match;
  while ((match = re.exec(src))) {
    if (!out.has(match[1])) out.set(match[1], match[2].trim());
  }
  return out;
}

module.exports = { ROOT, FEATURE_GATES_FILE, gatesInSource, scanGates, headerDescriptions };
