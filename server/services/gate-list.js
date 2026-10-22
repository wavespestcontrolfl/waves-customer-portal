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
// prerequisite. The description and kind (boolean or mode) come from the
// header catalogue entry for that variable, when it has one. The catalogue's
// `inverted` flag is a name-suffix guess (the IB staff autopay _OFF gate set to true turns
// that action ON), so it is not passed on.

const fs = require('fs');
const featureGates = require('../config/feature-gates');

let envNameCache = null;
let helperCache = new Map();

const GATE_TOKEN = /GATE_[A-Z0-9_]*[A-Z0-9]/g;

// Top-level helper functions in feature-gates.js → the GATE_ variables their
// bodies read (comments stripped), following calls to other helpers, so
// adminMfaEnforceLive() reads GATE_ADMIN_MFA (through adminMfaLive()) and
// GATE_ADMIN_MFA_ENFORCE. Entries such as
// `termiteAnnualPlan: termiteAnnualPlanSelectionEnabled()` read their gates
// only through one of these.
function helperGateTokens(src) {
  const direct = new Map();
  for (const [, name, body] of src.matchAll(/^function ([A-Za-z0-9_]+)\([^)]*\) \{\n([\s\S]*?)\n\}/gm)) {
    const code = body.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    direct.set(name, {
      tokens: code.match(GATE_TOKEN) || [],
      calls: [...code.matchAll(/([A-Za-z0-9_]+)\(/g)].map(([, fn]) => fn),
    });
  }
  const resolved = new Map();
  const resolve = (name, seen = new Set()) => {
    if (resolved.has(name)) return resolved.get(name);
    const fn = direct.get(name);
    if (!fn || seen.has(name)) return [];
    seen.add(name);
    const tokens = [...new Set([...fn.calls.flatMap((c) => resolve(c, seen)), ...fn.tokens])];
    resolved.set(name, tokens);
    return tokens;
  };
  const helpers = new Map();
  for (const name of direct.keys()) {
    const tokens = resolve(name);
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
    const list = names.get(currentKey) || [];
    for (const token of tokens) if (!list.includes(token)) list.push(token);
    if (list.length) names.set(currentKey, list);
  }
  envNameCache = names;
  helperCache = helpers;
  return names;
}

// The gate's own call-time reader is the helper named after it
// (GATE_ADMIN_MFA_ENFORCE → adminMfaEnforceLive / …Enabled / …Mode). Its other
// variables are the gate's prerequisites. A helper that merely mentions the
// gate is not used: it may consume it as its own prerequisite
// (lawnLightingLive() reads GATE_LAWN_VISIT_ASSESSMENT, not the reverse).
// No own reader → no prerequisites are claimed.
const OWN_READER_SUFFIXES = ['Live', 'Enabled', 'Mode', 'On', ''];

const readerBase = (name) => name.replace(/^GATE_/, '').toLowerCase().replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());

// When feature-gates.js EXPORTS the gate's own zero-argument reader, its answer
// is the effective state, every prerequisite included (gates-map lookups such
// as dunningCustomerScheduleLive's gates.payIncludeBalance too), so it wins
// over anything inferred here. A boolean is the state; a mode reader's string
// is 'off' = off, else on in that mode. Anything else (no export, arguments,
// a throw, another type) → undefined, and the inferred state stands.
function ownReaderState(name) {
  for (const suffix of OWN_READER_SUFFIXES) {
    const fn = featureGates[`${readerBase(name)}${suffix}`];
    if (typeof fn !== 'function') continue;
    if (fn.length > 0) return undefined;
    try {
      const value = fn();
      if (typeof value === 'boolean') return { enabled: value };
      if (typeof value === 'string') return { enabled: value !== 'off', modeValue: value };
    } catch {
      // fall through to the inferred state
    }
    return undefined;
  }
  return undefined;
}

function callTimePrerequisites(name) {
  gateEnvNames();
  const base = readerBase(name);
  for (const suffix of OWN_READER_SUFFIXES) {
    const tokens = helperCache.get(`${base}${suffix}`);
    if (tokens && tokens.includes(name)) return tokens.filter((t) => t !== name);
  }
  return [];
}

const ownName = (key) => `GATE_${key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()}`;

function pickOwn(key, vars) {
  if (vars.includes(ownName(key))) return ownName(key);
  return vars.length ? vars[vars.length - 1] : null;
}

// State of a catalogue gate that has no gates-map entry. These are read only
// at call time, so the variable as set now is what the next call sees (mode
// gates: callTimeModeEnabled). For a boolean gate the two
// reader styles (strict 'true'; gateEnvValue's 1/true/on) agree on most values;
// where they differ ('on', '1', 'TRUE') the answer is the loose one only when
// the catalogue saw a gateEnvValue reader, else unknown: the catalogue defaults
// a gate read in another file to 'strict' without seeing its reader. A gate of
// kind 'unverified' is unknown too. Only a boolean or null leaves here.
// A mode gate is off when unset or set to an off value. A timestamp gate
// (_SINCE / _AT, or documented as a timestamp) goes through the canonical
// gateEnvTimestamp reader: a value it rejects is off, as the runtime treats
// it; a valid past time is on; a future one is unknown (readers differ on
// whether it is armed). Any other set mode value (shadow, auto, an allowlist)
// is unknown: its meaning belongs to its own reader.
function callTimeModeEnabled(doc, raw) {
  if (raw === '' || ['false', 'off', '0'].includes(raw.toLowerCase())) return false;
  const timestamp = /(_SINCE|_AT)$/.test(doc.name) || /timestamp/i.test(doc.description || '');
  if (!timestamp) return null;
  const at = featureGates.gateEnvTimestamp(doc.name);
  if (!at) return false;
  return at.getTime() <= Date.now() ? true : null;
}

function callTimeEnabled(doc) {
  if (doc.kind === 'unverified') return null;
  const raw = String(process.env[doc.name] || '').trim();
  if (doc.kind === 'mode') return callTimeModeEnabled(doc, raw);
  const strict = raw === 'true';
  const loose = featureGates.gateEnvValue(doc.name);
  if (strict === loose) return strict;
  return doc.reader === 'loose' ? loose : null;
}

// A call-time gate set on is effectively on only when every prerequisite is
// on too. The reader's exact combination is not parsed, so any prerequisite
// that is not plainly on makes the state unknown rather than a guess.
function withPrerequisites(own, requires, catalog) {
  if (own !== true || !requires.length) return own;
  const reqOn = (name) => callTimeEnabled(catalog.get(name) || { name, kind: 'boolean', reader: 'strict' });
  return requires.every((name) => reqOn(name) === true) ? true : null;
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
    description: doc?.description || null,
  });
  // Rows from the gates map: state as the running code computed it at boot.
  // A map entry whose variable the catalogue leaves out is RETIRED there (the
  // catalogue scans every GATE_ name in the file except those), e.g.
  // GATE_SELF_BOOK_DAY_CAP: it is not offered as a control.
  const retired = (envName) => catalog.size > 0 && /^GATE_/.test(envName || '') && !catalog.has(envName);
  const mapRows = Object.entries(featureGates.gates).map(([key, value]) => {
    const vars = envNames.get(key) || [];
    const envName = pickOwn(key, vars);
    // Many map entries are a startup-log mirror of a compound live reader
    // (visitPrepPestRead mirrors only its own variable; visitPrepPestReadLive()
    // also needs GATE_VISIT_PREP_PHOTOS and GATE_VISIT_FACTS). Add the own
    // reader's prerequisites and judge them as call-time rows are judged.
    const mapRequires = vars.filter((v) => v !== envName);
    const readerRequires = envName ? callTimePrerequisites(envName).filter((v) => !mapRequires.includes(v)) : [];
    return {
      key,
      envName,
      requires: [...mapRequires, ...readerRequires],
      enabled: withPrerequisites(value === true, readerRequires, catalog),
      readAt: 'boot',
      ...semantics(envName ? catalog.get(envName) : null),
    };
  // Only GATE_ switches are listed. The two map entries that read a plain
  // variable are configuration, not switches, and one is a bearer credential
  // (OPS_DIGEST_INGEST_TOKEN): offering it beside "turns on with true" would
  // invite a guessable secret. Retired gates are not offered as controls.
  }).filter((row) => /^GATE_/.test(row.envName || '') && !retired(row.envName));
  // Catalogue gates that are no map row's own variable get a row of their
  // own: call-time-only gates such as GATE_ADMIN_MFA, including those that
  // also appear as another row's prerequisite.
  const named = new Set(mapRows.map((r) => r.envName));
  const callTimeRows = [...catalog.values()]
    .filter((doc) => !named.has(doc.name) && !NOT_GATES.has(doc.name))
    .map((doc) => {
      const requires = callTimePrerequisites(doc.name);
      return {
        key: doc.name,
        envName: doc.name,
        requires,
        enabled: withPrerequisites(callTimeEnabled(doc), requires, catalog),
        readAt: 'call',
        ...semantics(doc),
      };
    });
  // The gate's own exported reader, when there is one, is authoritative.
  const rows = [...mapRows, ...callTimeRows].map((row) => {
    const own = ownReaderState(row.envName);
    return own ? { ...row, ...own, stateFrom: 'reader' } : { ...row, stateFrom: 'inferred' };
  });
  return rows
    .sort((a, b) => (a.envName || a.key).localeCompare(b.envName || b.key));
}

module.exports = { listGates, gateEnvNames, pickOwn };
