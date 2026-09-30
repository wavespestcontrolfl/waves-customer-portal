/**
 * Ratchet: raw `notifyAdmin(` call sites under server/ may only decrease.
 *
 * docs/admin-notifications.md: new or changed admin notifications are raised with
 * `raiseAdminAlert` (server/services/admin-alert-compose.js), which enforces the
 * headline / why / link / subject / done-when rules. Existing raw call sites keep
 * working and are converted by Area in later changes. This test counts them per file
 * against fixtures/admin-alert-raw-callsites.json, an upper bound per file: a file
 * may not gain a raw call, and a new file may not have one. A file that loses raw
 * calls passes as it is, so a conversion in another branch never has to touch the
 * baseline; the numbers are lowered when someone is in there anyway.
 * Deterministic, filesystem only, no DB.
 */
const fs = require('fs');
const path = require('path');

const SERVER_ROOT = path.join(__dirname, '..');
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'admin-alert-raw-callsites.json');
const SKIP_DIRS = new Set(['node_modules', 'tests', '__tests__', 'migrations', 'coverage', 'dist']);
// The definition itself, and the composer's own delegating calls.
const EXCLUDED = new Set(['services/notification-service.js', 'services/admin-alert-compose.js']);
const RAW_CALL = /\bnotifyAdmin\s*\(/g;

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

// Comment lines are not call sites.
const rawCalls = (source) => source.split('\n')
  .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
  .reduce((n, line) => n + (line.match(RAW_CALL) || []).length, 0);

test('no file gains a raw notifyAdmin call; new admin alerts use raiseAdminAlert', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const counts = {};
  for (const file of walk(SERVER_ROOT)) {
    const rel = path.relative(SERVER_ROOT, file).split(path.sep).join('/');
    if (EXCLUDED.has(rel)) continue;
    const n = rawCalls(fs.readFileSync(file, 'utf8'));
    if (n) counts[rel] = n;
  }
  const grew = [];
  for (const rel of Object.keys(counts)) {
    const was = baseline[rel] || 0;
    if (counts[rel] > was) grew.push(`${rel}: ${counts[rel]} raw notifyAdmin call(s), baseline ${was}`);
  }
  expect(grew.length
    ? `Do not add raw notifyAdmin( calls. Raise the alert with raiseAdminAlert (server/services/admin-alert-compose.js) following docs/admin-notifications.md:\n  ${grew.join('\n  ')}`
    : '').toBe('');
});
