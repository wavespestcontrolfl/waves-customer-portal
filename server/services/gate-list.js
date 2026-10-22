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
// The variables are every GATE_ name in the gate catalogue
// (knownGateCatalog(), which already leaves retired gates out). A value is
// shown only when it is a plain switch word or a timestamp; anything else (an
// allowlist of ids, say) shows as set, with the value withheld.

const featureGates = require('../config/feature-gates');

// Names the catalogue's token scan picks up that are not variables: the tail
// of the INVERTED_GATE_RE constant and the doc placeholder `GATE_X=value`.
// Built from parts so the gate-index scan does not list them as gates.
const NOT_GATES = new Set(['RE', 'X'].map((suffix) => `GATE_${suffix}`));

const SHOWN_WORD = /^(true|false|on|off|1|0|yes|no|shadow|auto|live|required)$/i;
const SHOWN_TIMESTAMP = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/;

function gateSetting(name) {
  const raw = String(process.env[name] ?? '').trim();
  if (!raw) return { set: false, value: null };
  if (SHOWN_WORD.test(raw) || SHOWN_TIMESTAMP.test(raw)) return { set: true, value: raw };
  return { set: true, value: null };
}

function listGates() {
  let catalog = new Map();
  try {
    catalog = featureGates.knownGateCatalog();
  } catch {
    catalog = new Map();
  }
  return [...catalog.values()]
    .filter((doc) => !NOT_GATES.has(doc.name))
    .map((doc) => ({ name: doc.name, ...gateSetting(doc.name), description: doc.description || null }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { listGates, gateSetting };
