/**
 * Every literal `identityTrustLevel` a server sender passes must be a trust
 * level the messaging policy knows (services/messaging/policy.js
 * IDENTITY_TRUST_LEVELS). sendCustomerMessage refuses any other value as a
 * contract violation, so the text never sends, and a suite that mocks the
 * sender never sees it. 2026-11-04: the plan-hold restart text passed 'system'
 * and could not send. Deterministic, filesystem only, no DB.
 */
const fs = require('fs');
const path = require('path');
const { IDENTITY_TRUST_LEVELS } = require('../services/messaging/policy');

const SERVER_ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'coverage', 'dist']);
const LITERAL = /\bidentityTrustLevel\s*:\s*['"`]([^'"`]+)['"`]/g;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.includes('.test.')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

test('every literal identityTrustLevel in a server sender is a policy trust level', () => {
  const unknown = [];
  let seen = 0;
  for (const file of walk(SERVER_ROOT)) {
    const rel = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // Comment lines are not call sites.
      if (/^\s*(?:\/\/|\/?\*)/.test(line)) return;
      for (const match of line.matchAll(LITERAL)) {
        seen += 1;
        if (!IDENTITY_TRUST_LEVELS.includes(match[1])) unknown.push(`${rel}:${i + 1} '${match[1]}'`);
      }
    });
  }
  // The scan must reach the real senders, or an empty walk passes.
  expect(seen).toBeGreaterThan(40);
  expect(unknown).toEqual([]);
});
