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
  // Only an absent variable is "not set"; GATE_X= (empty) is a setting too.
  if (raw === undefined) return { set: false, value: null };
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

// Whether Settings → Features may flip a gate, and if not, the one-line
// reason the row shows. The same check the Intelligence Bar's
// set_railway_gate applies (a plain on/off gate with a description line), plus
// the page's own exclusions: the flip switch itself stays Railway-only.
const FLIP_SWITCH = 'GATE_SETTINGS_GATE_FLIP';
function flipStatus(name, entry) {
  if (name === FLIP_SWITCH) return { flippable: false, notFlippableReason: 'This switch turns gate flipping on and off, so it is set in Railway only.' };
  if (!entry) return { flippable: false, notFlippableReason: 'Not in the gate catalogue (no description line in feature-gates.js yet). Set it in Railway.' };
  if (entry.kind === 'mode') return { flippable: false, notFlippableReason: 'Takes a mode, timestamp or list, not just on/off. Set it in Railway.' };
  if (!entry.boolean) return { flippable: false, notFlippableReason: 'The code does not show it is a plain on/off switch. Set it in Railway.' };
  if (!entry.description) return { flippable: false, notFlippableReason: 'No description line in feature-gates.js yet, so it cannot be flipped here. Set it in Railway.' };
  return { flippable: true, notFlippableReason: null };
}

// Whether the code reads the variable as on, by the gate's own parser: a
// strict reader takes exactly 'true'; a gateEnvValue reader takes 1 / true /
// on in any case. Computed from the raw value, which the list may withhold.
function readsOnFor(name, entry) {
  const raw = process.env[name];
  if (raw === undefined) return false;
  if (entry?.reader === 'loose') return ['1', 'true', 'on'].includes(String(raw).toLowerCase());
  return raw === 'true';
}

// GATE_* names a gate's description says it depends on ("needs GATE_Y").
function mentionedGates(name, description) {
  return [...new Set(String(description || '').match(/GATE_[A-Z0-9_]*[A-Z0-9]/g) || [])].filter((n) => n !== name);
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
      inverted: catalog.get(name)?.inverted === true,
      readsOn: readsOnFor(name, catalog.get(name)),
      ...flipStatus(name, catalog.get(name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listGates, gateSetting, flipStatus, mentionedGates, readsOnFor, FLIP_SWITCH };
