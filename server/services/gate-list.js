// Admin Settings → Advanced → Features: the live gate list.
//
// The page used to read the gate map from the public /api/health reply. That
// reply stopped carrying gates on 2026-07-18 (#2853, the map told anyone which
// dark lanes exist), so the page showed an empty list and every cron badge read
// "Off". This builds the same list for an authenticated, admin-only route.
//
// State comes from the `gates` map (what the running code computed at boot,
// including non-production defaults). The Railway variable name and the
// plain-English line come from feature-gates.js itself. An entry's own
// variable is the GATE_ token in its value expression that spells its key
// (callIncidents → GATE_CALL_INCIDENTS); with no such token, a lone token is
// the variable and a compound one takes its last token. Every other token is a
// prerequisite. The description, kind (boolean or mode) and inversion come
// from the header catalogue entry for that variable, when it has one.

const fs = require('fs');
const featureGates = require('../config/feature-gates');

let envNameCache = null;

// Map each `gates` key to the GATE_ variables its value expression reads, in
// order. Comment lines are skipped, so a GATE_ named in a comment above an entry
// is never taken for that entry's own variable.
function gateEnvNames() {
  if (envNameCache) return envNameCache;
  const src = fs.readFileSync(require.resolve('../config/feature-gates'), 'utf8');
  const start = src.search(/^const gates = \{/m);
  const end = start === -1 ? -1 : src.indexOf('\n};', start);
  const names = new Map();
  if (start === -1 || end === -1) {
    envNameCache = names;
    return names;
  }
  let currentKey = null;
  for (const line of src.slice(start, end).split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const entry = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/) || line.match(/^\s+get\s+([A-Za-z0-9_]+)\(\)\s*(.*)$/);
    const code = entry ? entry[2] : trimmed;
    if (entry) currentKey = entry[1];
    if (!currentKey) continue;
    const tokens = code.replace(/\/\/.*$/, '').match(/GATE_[A-Z0-9_]*[A-Z0-9]/g) || [];
    const list = names.get(currentKey) || [];
    for (const token of tokens) if (!list.includes(token)) list.push(token);
    if (list.length) names.set(currentKey, list);
  }
  envNameCache = names;
  return names;
}

const ownName = (key) => `GATE_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

function pickOwn(key, vars) {
  if (vars.includes(ownName(key))) return ownName(key);
  return vars.length ? vars[vars.length - 1] : null;
}

function listGates() {
  const envNames = gateEnvNames();
  let catalog = new Map();
  try {
    catalog = featureGates.knownGateCatalog();
  } catch {
    catalog = new Map();
  }
  return Object.entries(featureGates.gates)
    .map(([key, value]) => {
      const vars = envNames.get(key) || [];
      const envName = pickOwn(key, vars);
      const doc = envName ? catalog.get(envName) : null;
      return {
        key,
        envName,
        requires: vars.filter((v) => v !== envName),
        enabled: value === true,
        kind: doc?.kind === 'mode' ? 'mode' : 'boolean',
        inverted: doc?.inverted === true,
        description: doc?.description || null,
      };
    })
    .sort((a, b) => (a.envName || a.key).localeCompare(b.envName || b.key));
}

module.exports = { listGates, gateEnvNames, pickOwn };
