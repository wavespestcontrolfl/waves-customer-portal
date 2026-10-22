// Admin Settings → Advanced → Features: what each GATE_ variable is set to.
//
// The page used to read the gate map from the public /api/health reply. That
// reply stopped carrying gates on 2026-07-18 (#2853, the map told anyone which
// dark lanes exist), so the page showed an empty list and every cron badge read
// "Off". This builds the list for an authenticated, admin-only route.
//
// It reports the SETTING, not whether a feature runs. Whether a feature runs
// depends on its reader, and readers combine gates in many ways, some in other
// files (Codex rounds 1-7 on #6402 each found a new one). The setting is what
// the owner changes in Railway → Variables and can be shown exactly.
//
// The variables are every GATE_ name the code reads, from the generated
// docs/gate-index.md (`npm run gates:index`; check:domain-rules fails a PR
// that leaves it stale), plus any GATE_ variable set in the environment that
// the code no longer reads (shown as such, so stale settings can be found).
// Retired gates stay out. If the index cannot be read, the gate catalogue
// (knownGateCatalog(), feature-gates.js only) is the fallback.
//
// The value is the raw string, never trimmed: " true " is not "true" to a
// strict reader (some readers trim, some do not), so the page shows it as set. It is shown
// only when its trimmed form is a plain switch word or a timestamp; anything
// else (an allowlist of ids, say) shows as set, with the value withheld.

const fs = require('fs');
const path = require('path');
const featureGates = require('../config/feature-gates');

const GATE_INDEX = path.join(__dirname, '..', '..', 'docs', 'gate-index.md');

// Names the catalogue's token scan picks up that are not variables: the tail
// of the INVERTED_GATE_RE constant and the doc placeholder `GATE_X=value`.
// Built from parts so the gate-index scan does not list them as gates.
const NOT_GATES = new Set(['RE', 'X'].map((suffix) => `GATE_${suffix}`));

const SHOWN_WORD = /^(true|false|on|off|1|0|yes|no|shadow|auto|live|required)$/i;
const SHOWN_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

function gateSetting(name) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return { set: false, value: null };
  const trimmed = raw.trim();
  if (trimmed === '' || SHOWN_WORD.test(trimmed) || SHOWN_TIMESTAMP.test(trimmed)) return { set: true, value: raw };
  return { set: true, value: null };
}

let indexCache = null;

// docs/gate-index.md lines: "- `GATE_X` — `file`, `file` — description".
function readGateIndex() {
  if (indexCache) return indexCache;
  const names = new Map();
  try {
    for (const line of fs.readFileSync(GATE_INDEX, 'utf8').split('\n')) {
      const m = line.match(/^- `(GATE_[A-Z0-9_]+)` — (?:`[^`]+`(?:, )?)+(?: — (.*))?$/);
      if (m) names.set(m[1], m[2] || null);
    }
  } catch {
    // unreadable index → catalogue fallback below
  }
  indexCache = names;
  return names;
}

function listGates() {
  let catalog = new Map();
  try {
    catalog = featureGates.knownGateCatalog();
  } catch {
    catalog = new Map();
  }
  const retired = featureGates.RETIRED_GATES || new Set();
  const index = readGateIndex();
  const read = index.size ? index : new Map([...catalog.keys()].map((name) => [name, null]));
  const names = new Set([...read.keys(), ...Object.keys(process.env).filter((n) => /^GATE_[A-Z0-9_]+$/.test(n))]);
  return [...names]
    .filter((name) => !NOT_GATES.has(name) && !retired.has(name))
    .map((name) => ({
      name,
      ...gateSetting(name),
      readByCode: read.has(name),
      description: catalog.get(name)?.description || read.get(name) || null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listGates, gateSetting };
