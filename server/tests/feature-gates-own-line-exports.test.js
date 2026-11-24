/**
 * feature-gates.js exports most readers with an own-line `module.exports.X = X;` (so gate PRs never conflict on the one
 * object export). A line placed ABOVE `module.exports = { ... }` is replaced with that object and lost, and every caller
 * reads the gate with `?.()`, so a lost reader is silently off: GATE_RESERVICE_FOLD, GATE_RESERVICE_FOLD_LINK and the
 * GATE_LIVE_CALL_UPSET_ALERT phone banner read off from #7929 / #7911 (2026-11-17) until 2026-11-18, with the owner's
 * Railway values set to true. Unit suites mock the module, so they never saw it.
 */
const fs = require('fs');
const path = require('path');

const SERVER = path.join(__dirname, '..');
const GATES_FILE = path.join(SERVER, 'config', 'feature-gates.js');
const gates = require('../config/feature-gates');
const { BELL_BANNER_KINDS } = require('../services/bell-banners');

const source = fs.readFileSync(GATES_FILE, 'utf8');
const lineOf = (index) => source.slice(0, index).split('\n').length;

function serverSources(dir = SERVER, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'tests' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) serverSources(full, out);
    else if (entry.name.endsWith('.js') && full !== GATES_FILE) out.push(full);
  }
  return out;
}

const GATES_REQUIRE = String.raw`require\(\s*['"](?:\.\.?\/)+(?:config\/)?feature-gates(?:\.js)?['"]\s*\)`;

describe('feature-gates own-line exports', () => {
  test('every own-line export sits below the object export, so the loaded module keeps it', () => {
    const objectExport = source.search(/^module\.exports = \{/m);
    expect(objectExport).toBeGreaterThan(-1);
    const lost = [];
    for (const m of source.matchAll(/^module\.exports\.([A-Za-z_$][\w$]*)\s*=/gm)) {
      if (m.index < objectExport || gates[m[1]] === undefined) lost.push(`${m[1]} (line ${lineOf(m.index)})`);
    }
    expect(lost).toEqual([]);
  });

  test('every server caller names a reader the module exports', () => {
    const missing = [];
    const member = new RegExp(`${GATES_REQUIRE}\\s*\\.\\s*([A-Za-z_$][\\w$]*)`, 'g');
    const destructured = new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${GATES_REQUIRE}`, 'g');
    for (const file of serverSources()) {
      const src = fs.readFileSync(file, 'utf8');
      if (!src.includes('feature-gates')) continue;
      const rel = path.relative(SERVER, file);
      for (const m of src.matchAll(member)) if (!(m[1] in gates)) missing.push(`${rel}: .${m[1]}`);
      for (const m of src.matchAll(destructured)) {
        for (const part of m[1].replace(/\/\/[^\n]*/g, '').split(',')) {
          const key = part.split(':')[0].trim();
          if (key && !(key in gates)) missing.push(`${rel}: { ${key} }`);
        }
      }
    }
    expect(missing).toEqual([]);
  });

  test('every bell banner gate names a reader function', () => {
    const named = Object.entries(BELL_BANNER_KINDS).filter(([, kind]) => kind.gate);
    expect(named.length).toBeGreaterThan(0);
    for (const [kind, { gate }] of named) expect([kind, typeof gates[gate]]).toEqual([kind, 'function']);
  });

  test('the three readers lost before 2026-11-18 read their gates', () => {
    const env = { ...process.env };
    try {
      process.env.GATE_RESERVICE_FOLD = 'true';
      process.env.GATE_RESERVICE_FOLD_LINK = 'true';
      process.env.GATE_LIVE_CALL_UPSET_ALERT = 'true';
      expect([gates.reserviceFoldLive(), gates.reserviceFoldLinkLive(), gates.liveCallUpsetAlertLive()]).toEqual([true, true, true]);
      delete process.env.GATE_RESERVICE_FOLD;
      delete process.env.GATE_RESERVICE_FOLD_LINK;
      delete process.env.GATE_LIVE_CALL_UPSET_ALERT;
      expect([gates.reserviceFoldLive(), gates.reserviceFoldLinkLive(), gates.liveCallUpsetAlertLive()]).toEqual([false, false, false]);
    } finally {
      process.env = env;
    }
  });
});
