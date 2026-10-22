// Admin Settings → Advanced → Features: the live gate list.
//
// The page used to read the gate map from the public /api/health reply. That
// reply stopped carrying gates on 2026-07-18 (#2853, the map told anyone which
// dark lanes exist), so the page showed an empty list and every cron badge read
// "Off". This builds the same list for an authenticated, admin-only route.
//
// Rows come from the `gates` map (state as the running code computed it at
// boot, including non-production defaults), plus every catalogue gate no map
// row names: those are read only at call time, so their state is the variable
// as set now (see callTimeEnabled). The Railway variable name and the
// plain-English line come from feature-gates.js itself. An entry's own
// variable is the GATE_ token in its value expression that spells its key
// (callIncidents → GATE_CALL_INCIDENTS); with no such token, a lone token is
// the variable and a compound one takes its last token. Every other token is a
// prerequisite. The description, kind (boolean or mode) and inversion come
// from the header catalogue entry for that variable, when it has one.

const fs = require('fs');
const featureGates = require('../config/feature-gates');

let envNameCache = null;

const GATE_TOKEN = /GATE_[A-Z0-9_]*[A-Z0-9]/g;

// Top-level helper functions in feature-gates.js → the GATE_ variables their
// bodies read (comments stripped). Entries such as
// `termiteAnnualPlan: termiteAnnualPlanSelectionEnabled()` read their gates
// only through one of these.
function helperGateTokens(src) {
  const helpers = new Map();
  for (const [, name, body] of src.matchAll(/^function ([A-Za-z0-9_]+)\([^)]*\) \{\n([\s\S]*?)\n\}/gm)) {
    const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    const tokens = [...new Set(code.match(GATE_TOKEN) || [])];
    if (tokens.length) helpers.set(name, tokens);
  }
  return helpers;
}

// Map each `gates` key to the GATE_ variables its value expression reads, in
// order, including those read inside a helper it calls. Comment lines are
// skipped, so a GATE_ named in a comment above an entry is never taken for
// that entry's own variable.
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
  const helpers = helperGateTokens(src);
  let currentKey = null;
  for (const line of src.slice(start, end).split('\n').slice(1)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;
    const entry = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/) || line.match(/^\s+get\s+([A-Za-z0-9_]+)\(\)\s*(.*)$/);
    const code = entry ? entry[2] : trimmed;
    if (entry) currentKey = entry[1];
    if (!currentKey) continue;
    const expr = code.replace(/\/\/.*$/, '');
    const tokens = [
      ...(expr.match(GATE_TOKEN) || []),
      ...[...expr.matchAll(/([A-Za-z0-9_]+)\(/g)].flatMap(([, fn]) => helpers.get(fn) || []),
    ];
    // A few entries read a plain variable (an allowlist, a token); name it so
    // the row still says what to set. Only the name is returned, never a value.
    if (!tokens.length) tokens.push(...[...expr.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(([, v]) => v));
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

// State of a catalogue gate that has no gates-map entry. These are read only
// at call time, so the variable as set now is what the next call sees. A mode
// gate is on when set to anything but an off value. For a boolean gate the two
// reader styles (strict 'true'; gateEnvValue's 1/true/on) agree on most values;
// where they differ ('on', '1', 'TRUE') the answer is the loose one only when
// the catalogue saw a gateEnvValue reader, else unknown: the catalogue defaults
// a gate read in another file to 'strict' without seeing its reader. A gate of
// kind 'unverified' is unknown too. Only a boolean or null leaves here.
function callTimeEnabled(doc) {
  if (doc.kind === 'unverified') return null;
  const raw = String(process.env[doc.name] || '').trim();
  if (doc.kind === 'mode') return raw !== '' && !['false', 'off', '0'].includes(raw.toLowerCase());
  const strict = raw === 'true';
  const loose = featureGates.gateEnvValue(doc.name);
  if (strict === loose) return strict;
  return doc.reader === 'loose' ? loose : null;
}

// Names the catalogue's token scan picks up that are not variables: the tail
// of the INVERTED_GATE_RE constant and the doc placeholder `GATE_X=value`.
// Built from parts so the gate-index scan does not list them as gates.
const NOT_GATES = new Set(['RE', 'X'].map((suffix) => `GATE_${suffix}`));

function listGates() {
  const envNames = gateEnvNames();
  let catalog = new Map();
  try {
    catalog = featureGates.knownGateCatalog();
  } catch {
    catalog = new Map();
  }
  const semantics = (doc) => ({
    kind: doc?.kind === 'mode' ? 'mode' : 'boolean',
    inverted: doc?.inverted === true,
    description: doc?.description || null,
  });
  // Rows from the gates map: state as the running code computed it at boot.
  const mapRows = Object.entries(featureGates.gates).map(([key, value]) => {
    const vars = envNames.get(key) || [];
    const envName = pickOwn(key, vars);
    return {
      key,
      envName,
      requires: vars.filter((v) => v !== envName),
      enabled: value === true,
      readAt: 'boot',
      ...semantics(envName ? catalog.get(envName) : null),
    };
  });
  // Catalogue gates no map row names (as its own variable or a prerequisite):
  // call-time-only gates such as GATE_ADMIN_MFA.
  const named = new Set(mapRows.flatMap((r) => [r.envName, ...r.requires]));
  const callTimeRows = [...catalog.values()]
    .filter((doc) => !named.has(doc.name) && !NOT_GATES.has(doc.name))
    .map((doc) => ({
      key: doc.name,
      envName: doc.name,
      requires: [],
      enabled: callTimeEnabled(doc),
      readAt: 'call',
      ...semantics(doc),
    }));
  return [...mapRows, ...callTimeRows]
    .sort((a, b) => (a.envName || a.key).localeCompare(b.envName || b.key));
}

module.exports = { listGates, gateEnvNames, pickOwn };
