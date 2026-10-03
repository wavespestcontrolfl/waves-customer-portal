/**
 * Finds every GATE_* environment variable the production code reads.
 *
 * Shared by scripts/generate-gate-index.js (writes the index block in
 * docs/gates-and-env.md) and scripts/check-domain-rules.js (fails when a
 * gate the code reads has no line in that file), so both agree on what a
 * gate is.
 *
 * A gate is a whole GATE_* name in the parsed code (never a comment):
 *   - a property read from the environment: process.env.GATE_X, env?.GATE_X,
 *     const { GATE_X } = process.env;
 *   - a string that is exactly the name, wherever it sits: a helper argument
 *     (gateEnvValue('GATE_X')), a bracket lookup, a constant, or an entry in
 *     an array or map of gate names that is read later. Counting every such
 *     string is deliberate: an indirect read cannot be told from a direct
 *     one, and a missed gate is worse than an extra line.
 * Two kinds of string are not gates: a name in a retired-names list
 * (const RETIRED = new Set([...])) and an error code ({ code: 'GATE_...' }).
 * A prefix used to build a name (GATE_BOOK_) is never a whole name.
 */

const fs = require('fs');
const path = require('path');
// The parser scripts/check-portal-brand.js already uses in the same prebuild.
const { parse } = require('@babel/parser');

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
  // Not production code, the same as scripts/check-domain-rules.js: one-off
  // and maintenance scripts, and the contract-test harness.
  /^server\/scripts\//,
  /^server\/contract-tests\//,
];

const FEATURE_GATES_FILE = 'server/config/feature-gates.js';

const NAME = 'GATE_[A-Z0-9_]*[A-Z0-9]';
const WHOLE_NAME = new RegExp(`^${NAME}$`);

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

function isGateName(value) {
  return typeof value === 'string' && WHOLE_NAME.test(value);
}

// process.env, import.meta.env, or a bare `env` object.
function isEnvObject(node) {
  if (!node) return false;
  if (node.type === 'Identifier') return node.name === 'env';
  if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    return !node.computed && node.property.type === 'Identifier' && node.property.name === 'env';
  }
  return false;
}

function keyName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'StringLiteral') return node.value;
  return null;
}

// The whole text of a string, or of a template with no ${} part.
function literalText(node) {
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked;
  return null;
}

const COMMENT_KEYS = new Set(['loc', 'leadingComments', 'trailingComments', 'innerComments']);

// const { GATE_X, GATE_Y: alias = 'off' } = process.env;
function collectDestructured(node, names) {
  if (node.id.type !== 'ObjectPattern' || !isEnvObject(node.init)) return;
  for (const property of node.id.properties) {
    const key = property.type === 'ObjectProperty' && !property.computed ? keyName(property.key) : null;
    if (isGateName(key)) names.add(key);
  }
}

// Adds the gate names this one node reads. Returns true when the strings
// under it are not gates (a retired-names list, an error code).
function collect(node, names, excluded) {
  switch (node.type) {
    case 'StringLiteral':
    case 'TemplateLiteral': {
      const text = literalText(node);
      if (!excluded && isGateName(text)) names.add(text);
      return false;
    }
    case 'MemberExpression':
    case 'OptionalMemberExpression':
      // env.GATE_X, env?.GATE_X (env['GATE_X'] is caught as a string)
      if (!node.computed && isEnvObject(node.object) && isGateName(node.property.name)) {
        names.add(node.property.name);
      }
      return false;
    case 'VariableDeclarator':
      collectDestructured(node, names);
      // const RETIRED = new Set(['GATE_OLD']): names kept so they stay off.
      return node.id.type === 'Identifier' && /retired/i.test(node.id.name);
    case 'ObjectProperty':
      // { code: 'GATE_CODE_BELLS_FAILED' } is an error code, not a gate.
      return !node.computed && keyName(node.key) === 'code';
    default:
      return false;
  }
}

// The gate names one source file reads. Parsed, not pattern-matched, so
// comments, regex literals and JSX text can never be mistaken for code.
function gatesInSource(src, filename = 'source.js') {
  const ast = parse(src, {
    sourceType: 'unambiguous',
    sourceFilename: filename,
    errorRecovery: true,
    allowReturnOutsideFunction: true,
    plugins: ['jsx'],
  });
  const names = new Set();
  const visit = (node, excluded) => {
    if (!node || typeof node.type !== 'string') return;
    const skipLiterals = excluded || collect(node, names, excluded);
    for (const key of Object.keys(node)) {
      if (COMMENT_KEYS.has(key)) continue;
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) visit(item, skipLiterals);
      else if (child && typeof child.type === 'string') visit(child, skipLiterals);
    }
  };
  visit(ast.program, false);
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
    for (const name of gatesInSource(src, rel)) {
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
