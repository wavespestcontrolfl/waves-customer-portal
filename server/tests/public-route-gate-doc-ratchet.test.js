/**
 * Ratchet: a public route file may not gain a gate that its entry in
 * `docs/public-route-contracts.md` does not name.
 *
 * AGENTS.md "Public route surface": a change to a listed route's auth, gate,
 * payload or headers that the contract does not describe is P0. A new `GATE_*`
 * on a public route keeps shipping undocumented — `GATE_LEAD_ALERT_CALL` on the
 * lead webhook (#6336) and `GATE_SMS_SHARED_PHONE_LINK` on the Twilio webhook
 * (#6268) each landed with no contract entry — so the mechanical half of that
 * rule is pinned here instead of restated in prose.
 *
 * An alias is only ever a gate KEY, never the name of the code that reads it:
 * see `note()`. Attributing `GATE_STOPS_AWAY` to `computeStopsAhead`, which the
 * contract mentions as inline code for its own reasons, made the round-1
 * finding read as documented the moment helper bodies were parsed.
 *
 * A route rarely spells the env name: it calls `isEnabled('leadAlertCall')`,
 * `gateEnvValue('GATE_STOPS_AWAY')`, `cfg.gates.payPageFaq`, or a `…Live()` /
 * `is…Enabled()` helper, and the `GATE_*` literal appears only in a comment. Miss
 * one form and an undocumented gate reads as NO gate at all and this ratchet
 * passes on the diff it exists to fail — which is how `GATE_STOPS_AWAY` sat green
 * here through one round of review. So resolution is deliberately broad:
 *   - the `feature-gates.js` key table takes any shape that names a gate on the
 *     key's line, not just `key: process.env.GATE_X` — `gateEnvValue('GATE_X')`
 *     and the env-default ternary (`askWaves: isProd ? … : true`) are most of it;
 *   - helpers are parsed from `feature-gates.js` AND from the modules each route
 *     requires, one level deep, so a wrapper that lives elsewhere still resolves
 *     (`isVoiceLatePaymentEnabled` in `services/collections/outbound-voice/gates.js`,
 *     read by `collections-voice-webhook.js`);
 *   - an identifier argument is resolved through its binding, local or imported
 *     (`isEnabled(OUTBOUND_VOICEMAIL_SMS_GATE)` in `twilio-voice-webhook.js`,
 *     where `GATE = 'outboundVoicemailSms'` lives in `outbound-voicemail-sms.js`).
 *
 * THE READ SIDE IS PARSED, NOT PATTERN-MATCHED. Six review rounds found six
 * different reads that pattern matching silently treated as "no gate", each one
 * a diff this test should have failed (#6342) — the last being
 * `isEnabled(true ? 'askWaves' : UNKNOWN_KEY)`, where one resolving literal was
 * taken for the whole expression. `scripts/lib/gate-scan.js` says why: parsed,
 * "comments, regex literals and JSX text can never be mistaken for code". So
 * gate reads come from the AST (`@babel/parser`, as `route-surface/scan.js`
 * already does in this suite), and an argument resolves only when EVERY value it
 * can take resolves: a conditional needs both branches, a logical both sides, and
 * the condition is not a candidate. Anything else is reported, not ignored.
 * Parsing also tightened the other direction, verified against this baseline as
 * a no-op: a gate named in a trailing comment or inside a string literal is no
 * longer counted as a read of it.
 *
 * Gates also propagate along each module's own call graph to a fixed point,
 * because a wrapper that only DELEGATES reads nothing itself:
 * `pastCustomerLastStart()` is `customerLastStart16Enabled() && …`, and
 * `booking.js` reaches `GATE_CUSTOMER_LAST_START_16` only through two such hops
 * (#6342 r8). That makes a file's entry a sound OVER-approximation — "calling
 * into this file's handlers can consult these gates" — not a precise read list,
 * which is the right direction for a floor but worth knowing before reading the
 * fixture as documentation.
 *
 * Helper DEFINITIONS are parsed for the same reason, one round later: a 400-
 * character regex body could not see `linkWorkerAuth`, the factory through which
 * all five `integrations-*-worker.js` routers read their only gate, so
 * `GATE_HERMES_WORKER` was undocumented and invisible here (#6342 r7). What
 * stays textual is only the `feature-gates.js` key table and the exported key
 * constants — a line that names a gate. Even there a shape was missed: the
 * table uses `get key() { … }` as well as `key: …`, and `visitCloseout` was
 * invisible until this test's own fail-closed report named it (#6342 r8).
 * Helper bodies resolve `isEnabled(IDENT)` through their module's string
 * constants too — the round-4 read-side fix, which the definition side did not
 * get until r9 — and a helper whose argument still does not resolve is marked
 * OPAQUE and reported when a scanned file calls it, rather than contributing
 * nothing.
 *
 * Propagation runs TWICE: inside each module, and again over the maps unioned
 * across every module a file reaches, which is the only level where a
 * cross-module edge has both ends (`applyOutlinkTracking` in
 * `outlink-tracking.js` delegates to `outlinkTrackingLive` in
 * `feature-gates.js`, #6342 r10). Helper maps are keyed by bare function name
 * and UNIONED, never first-wins: keeping the first discarded the other
 * definition's gates outright (#6342 r9).
 *
 * A NAME IS NOT A GATE. A local shaped like one may hold the real gate
 * (`const GATE_ENV = 'GATE_PHOTO_MARKS'`) or something unrelated
 * (`GATE_UUID_ARRAY` is a SQL fragment that filters malformed uuids). Taking
 * the identifier at face value put two gates that have never existed into this
 * fixture, across four files, while hiding the real ones (#6342 r10) — so a
 * declared name resolves to its string value, counts as no gate when that
 * value is not a gate name, and is opaque only when unreadable.
 *
 * KNOWN LOOSENESS (#6342 review): "documented" means the gate is named ANYWHERE
 * in the contract, not in this route's own entry, so adding an
 * already-documented gate to a different public route passes here. Scoping it to
 * the entry was tried and does not work on this document: it has no per-route
 * delimiter, and splitting on blank lines yields blocks up to ~70 KB that span
 * many routes, so a path-proximity test reads as "documented" for almost any
 * pairing — tighter-looking and no tighter. Closing it needs a per-route gate
 * list in the contract (or a structural split of that file), which is a bigger
 * change than this ratchet; until then the baseline below is the real floor and
 * the prose rule still makes an undocumented gate P0.
 *
 * The file set is deliberately over-inclusive: the `public-*` / `*-public.js` /
 * `*webhook*` conventions UNION every route file that does not apply auth AT THE
 * ROUTER LEVEL. That last test is AGENTS.md's own convention ("every
 * `server/routes/admin-*.js` starts with `router.use(adminAuthenticate, …)`;
 * per-handler on mixed public/staff routers like `badges.js`"), so a router
 * whose auth is per-handler stays IN. Testing the file for any mention of
 * `authenticate` instead dropped `auth.js`, whose `/send-code`, `/verify-code`,
 * `/refresh` and `/logout` are unauthenticated, because later endpoints in the
 * same file are not (#6342 r5 security). And router-level auth counts only when
 * it PRECEDES every route registration in the file, because that is all Express
 * applies it to: `admin-push.js` serves `/vapid-key` with no auth on purpose and
 * applies router-level auth after it, so a file-wide test excluded a genuinely
 * public endpoint (#6342 r8 — the same mistake as r5, one level further in).
 * Scanning a non-public file costs only a baseline entry; dropping a public one
 * costs the whole point of the test.
 *
 * fixtures/public-route-undocumented-gates.json is an upper bound per file: a
 * file may not gain an undocumented gate, and a new file may not have one. Every
 * entry must still be EARNED — the gate still read by that file and still absent
 * from the contract — or the test fails asking for the entry to go. Without that,
 * documenting a gate would leave a stale exemption behind that silently
 * re-whitelists the same gate if its contract line is ever deleted. The cost is
 * that documenting a gate also means deleting its baseline line, in the same PR.
 * Deterministic, filesystem only, no DB.
 *
 * This covers the gate half only. A payload change (#6299) and a brand-new
 * public route stay the prose rule's: both are P0 whether or not this is green.
 */
const fs = require('fs');
const path = require('path');
const { parse } = require('@babel/parser');

const SERVER_ROOT = path.join(__dirname, '..');
const ROUTES_DIR = path.join(SERVER_ROOT, 'routes');
const GATES_FILE = path.join(SERVER_ROOT, 'config', 'feature-gates.js');
const CONTRACTS_DOC = path.join(SERVER_ROOT, '..', 'docs', 'public-route-contracts.md');
const BASELINE_PATH = path.join(__dirname, 'fixtures', 'public-route-undocumented-gates.json');

const NAME_PATTERNS = [/^public-/, /-public\.js$/, /webhook/i];
// Auth applied to the whole router, the admin convention. A file with only
// per-handler auth is a mixed router and stays in scope.
const ROUTER_LEVEL_AUTH = /router\.use\(\s*[^)]*\b(?:adminAuthenticate|authenticate)\b/;
// `router.route('/x').get(…)` registers a handler as much as `router.get(…)`
// does, and the ordering check below saw only the latter — so a mixed router
// whose PUBLIC handler is registered that way before `router.use(authenticate)`
// read as fully authenticated and left the scan (#6342 r23). No file under
// `server/routes/` writes it today, so the scanned set does not move; it is the
// classification that was wrong.
const ROUTE_REGISTRATION = /router\.(?:route|get|post|put|patch|delete|all)\(/g;

const stripComments = (source) => source
  .split('\n')
  .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
  .join('\n');

// `a.b`, `a['b']` and `` a[`b`] `` are the same read. Requiring an Identifier
// skipped `process.env['GATE_FOO']` silently — neither recorded nor reported
// (#6342 r12). Returns null for a property that is not statically known — a
// computed `a[name]` included — so the caller can fail closed on it instead of
// reading a variable's NAME as the property it happens to hold.
//
// Module scope because it is the answer to "which property is this", and both
// walkers ask: the route half had it and the helper half did not, which is why
// `gates['someKey']` in a helper body and a bracketed CALLEE
// (`require('../config/feature-gates')['portalActivityLive']()`) both read as
// nothing at all (#6342 r16). Two copies is how r10 and r15 happened.
function propertyName(node) {
  if (!node || !node.property) return null;
  if (!node.computed && node.property.type === 'Identifier') return node.property.name;
  if (node.property.type === 'StringLiteral') return node.property.value;
  if (node.property.type === 'TemplateLiteral' && node.property.expressions.length === 0
    && node.property.quasis.length === 1) return node.property.quasis[0].value.cooked;
  return null;
}

// The string an argument IS, when that is statically knowable. Separates the
// two outcomes `resolveGateArg` returns null for: an expression this resolver
// cannot decode, and a plain string that decodes fine and simply is not a gate
// key — `isEnabled('emailTemplateAutomations')` in `admin-email-templates.js`,
// whose key the table does not define (its canonical reader there is
// `emailTemplateAutomationsMode()`). Treating that as unreadable fails this
// test on code it has already judged correctly (r10's `GATE_UUID_ARRAY`, r13's
// error codes: a name is not a gate).
//
// Used by the HELPER walker only, which is where that live read is, and
// deliberately NOT by the route walker. I generalised it to both in r16 for
// symmetry; the demonstrated requirement was one half, and widening it opened
// a hole — a key the table does not define because `keyToGate` reads the table
// by regex (`key: SOME_CONSTANT` names no `GATE_*`) then read silently in a
// public route (#6342 r17). A public route reading an unknown key is worth
// failing on; a pre-existing helper read of one is not. Resolving the table
// STRUCTURALLY is what removes the difference, and that is decision 2.
function staticString(node) {
  if (!node) return null;
  if (node.type === 'StringLiteral') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0
    && node.quasis.length === 1) return node.quasis[0].value.cooked;
  return null;
}

// `module.exports = internalGate` ⇒ the implementation name. A CommonJS export
// may rename a helper on the way out, and the helper map is keyed by the name
// whose body this resolver indexed, so a route calling the imported name
// matched nothing and its gate read as NO gate (#6342 r16).
const DEFAULT_EXPORT = 'module.exports';

// The readers whose argument is the `GATE_*` env NAME rather than a feature
// key. `gateEnvTimestamp` is exported beside `gateEnvValue` and read in eight
// services for activation-time guards, and this test knew only two readers, so
// a timestamp-gated public route could ship undocumented (#6342 r17).
const ENV_NAME_READERS = new Set(['gateEnvValue', 'gateEnvTimestamp']);
const GATE_READERS_VIA = new Set(['call', 'apply']);
// `['GATE_A', 'GATE_B'].every(gateEnvValue)` passes the reader as a CALLBACK and
// puts the gate names in the receiver. Six live sites —
// `scheduling/quality-alerts.js`, `scheduling/quality-after-change.js`,
// `route-reorder.js` (twice), `geocoder-service-locations.js` — and the
// identifier branch followed only mapped helpers, so every one of them read as
// no gate at all (#6342 r23).
const ITERATOR_CALLBACKS = new Set(['every', 'some', 'map', 'filter', 'forEach', 'find']);
function readerAsCallback(node, readerAliases) {
  const c = node.callee;
  if (!c || (c.type !== 'MemberExpression' && c.type !== 'OptionalMemberExpression')) return null;
  if (!ITERATOR_CALLBACKS.has(propertyName(c))) return null;
  const args = node.arguments || [];
  if (args.length !== 1 || args[0].type !== 'Identifier') return null;
  const reader = readerAliases.get(args[0].name) || args[0].name;
  return GATE_READERS.has(reader) ? { reader, receiver: c.object } : null;
}

// The receiver's elements as strings: an array literal, or a name bound to one
// (`const repairGates = ['GATE_ROUTE_REORDER_REPAIR', …]` in
// `route-reorder.js`). Returns null when any element is not statically known,
// so the caller fails closed rather than reading a partial list as the whole.
function callbackGateNames(receiver, arrayLookup) {
  if (!receiver) return null;
  if (receiver.type === 'ArrayExpression') {
    const out = [];
    for (const el of receiver.elements) {
      const value = staticString(el);
      if (value === null) return null;
      out.push(value);
    }
    return out;
  }
  if (receiver.type === 'Identifier') return arrayLookup(receiver.name);
  return null;
}

// NAME ⇒ the string elements of the array it is bound to, read textually like
// the other local lookups in this file.
function stringArrays(source) {
  const map = new Map();
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*\[([^\]]*)\]/g)) {
    const items = [...m[2].matchAll(/'([^']*)'|"([^"]*)"|`([^`]*)`/g)].map((q) => q[1] ?? q[2] ?? q[3]);
    const bare = m[2].replace(/'[^']*'|"[^"]*"|`[^`]*`|[\s,]/g, '');
    if (items.length && !bare && !map.has(m[1])) map.set(m[1], items);
  }
  return map;
}

// `isEnabled.call(null, 'someKey')` — the callee resolves to `call`, so the
// reader branch never looked at the argument and the read counted as no gate
// (#6342 r20). Reported rather than DECODED: `.call` shifts the argument by one
// and `.apply` hides it in an array, which is argument-index branching in the
// hottest part of both walkers for a form this codebase does not contain (the
// only `.call(` sites under `server/` are knex mocks in test files). Fail
// closed, so the bypass is impossible without the machinery — the alternative
// the finding itself offers.
function readerViaCallApply(callee, readerAliases) {
  if (!callee || (callee.type !== 'MemberExpression' && callee.type !== 'OptionalMemberExpression')) return null;
  if (!GATE_READERS_VIA.has(propertyName(callee))) return null;
  // The RECEIVER is a name or a member: `isEnabled.call(…)`,
  // `featureGates.isEnabled.call(…)` and
  // `require('../config/feature-gates').isEnabled.call(…)` are one form, and
  // taking only the Identifier receiver left the other two through — the second
  // half of r20's own fix, which the grep-every-other-place rule should have
  // caught before pushing it (#6342 r21).
  const obj = callee.object;
  if (!obj) return null;
  const reader = obj.type === 'Identifier' ? (readerAliases.get(obj.name) || obj.name)
    : ((obj.type === 'MemberExpression' || obj.type === 'OptionalMemberExpression')
      ? propertyName(obj) : null);
  return reader && GATE_READERS.has(reader) ? reader : null;
}
const GATE_READERS = new Set(['isEnabled', ...ENV_NAME_READERS]);

// key ⇒ EVERY gate its line names, in any shape the table uses:
// `key: process.env.GATE_X === 'true'`, `key: gateEnvValue('GATE_X')`, the
// env-default ternary `key: isProd ? … : true`, and the compound guard
// `typedDecisionsClef: gateEnvValue('GATE_TYPED_DECISIONS') && gateEnvValue('GATE_TYPED_DECISIONS_CLEF')`.
// Seven keys name more than one gate; keeping only the first let a compound
// guard ship with just its already-documented master gate (#6342 r3).
function keyToGate(gatesSource) {
  const map = new Map();
  // `key: …` and `get key() { … }` — the table uses both, and only the first
  // was matched, so `visitCloseout` (a getter) was not a key and
  // `isEnabled('visitCloseout')` in `admin-schedule.js` resolved to nothing.
  // Found by this test's own fail-closed report once that file came into scope
  // (#6342 r8), which is the report doing its job. Two patterns, not one
  // widened one: a pattern loose enough to catch both also catches
  // `function name() {` and would register helper names as keys — and a key is
  // what `note()` accepts as a documenting alias, so that would quietly
  // re-open the hole round 7 closed.
  const PATTERNS = [
    /^\s*([a-zA-Z0-9_]+)\s*:\s*(.*GATE_[A-Z0-9_]+.*)$/gm,
    /^\s*get\s+([a-zA-Z0-9_]+)\s*\(\s*\)\s*\{\s*(.*GATE_[A-Z0-9_]+.*)$/gm,
  ];
  for (const pattern of PATTERNS) {
    for (const m of gatesSource.matchAll(pattern)) {
      const gates = [...new Set(m[2].match(/GATE_[A-Z0-9_]+/g) || [])];
      if (gates.length && !map.has(m[1])) map.set(m[1], gates);
    }
  }
  return map;
}

// A helper is any named function whose body — at ANY depth, including a
// middleware it returns — reads a gate. Parsed, for the same reason the read
// side is: the regex this replaces capped bodies at 400 characters and ended
// them at the first line-start `}`, so `linkWorkerAuth(endpoint)`
// (`middleware/link-worker-auth.js`) resolved to nothing even though the
// middleware it returns answers 403 unless `isEnabled('hermesWorker')`. All
// five `integrations-*-worker.js` routers read their only gate through it, so
// `GATE_HERMES_WORKER` was undocumented, unbaselined and invisible here
// (#6342 r7). Attributing a nested read to the enclosing name is the point: a
// route that calls the factory is gated by what the factory returns.
// ONE argument resolver for both halves of this file. Keeping two meant every
// shape had to be fixed twice and never was: the read side resolved ternaries
// from r5 and identifiers from r4, while helper bodies took only string
// literals — which is three separate r9/r10 findings
// (`isEnabled(GATE)`, `featureGates.isEnabled(...)`,
// `isEnabled(cond ? 'a' : 'b')`) with one cause. Returns [[gate, key], …], or
// null when ANY value the expression can take does not resolve; the condition
// of a ternary is not one of those values. `lookup` maps an identifier to a
// gate key, and differs per half (route-local bindings vs module constants).
function resolveGateArg(node, keys, lookup, reader = 'isEnabled', propLookup = null) {
  // `isEnabled` takes a feature KEY; `gateEnvValue` takes the `GATE_*` name
  // itself. Both reach their argument through the same shapes, so the two
  // readers differ only in how a resolved string maps to gates — not in how
  // the string is found. Wiring this to `isEnabled` alone left
  // `gateEnvValue(GATE)` with a module constant contributing nothing from a
  // helper body (#6342 r14), which is the r10 consolidation applied to one of
  // its two call sites.
  const fromString = (value) => {
    if (ENV_NAME_READERS.has(reader)) {
      return /^GATE_[A-Z0-9_]+$/.test(value) ? [[value, value]] : null;
    }
    const gates = keys.get(value);
    return gates ? gates.map((g) => [g, value]) : null;
  };
  if (!node) return null;
  if (node.type === 'StringLiteral') return fromString(node.value);
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return fromString(node.quasis[0].value.cooked);
  }
  if (node.type === 'Identifier') {
    const value = lookup(node.name);
    return value ? fromString(value) : null;
  }
  // `gateEnvValue(c.gate)` over a table of `{ gate: 'GATE_…' }` rows
  // (`sms-shadow-drafter.js`) is statically knowable: the read can consult any
  // value the module gives that property, so resolve to all of them. Every one
  // must resolve, or the whole read is unreadable.
  if ((node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression')
    && propLookup && !node.computed && node.property && node.property.type === 'Identifier') {
    const values = propLookup(node.property.name);
    if (!values || !values.length) return null;
    const out = [];
    for (const value of values) {
      const resolved = fromString(value);
      if (!resolved) return null;
      out.push(...resolved);
    }
    return out;
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    const [a, b] = node.type === 'ConditionalExpression'
      ? [node.consequent, node.alternate] : [node.left, node.right];
    const left = resolveGateArg(a, keys, lookup, reader, propLookup);
    const right = left && resolveGateArg(b, keys, lookup, reader, propLookup);
    return left && right ? [...left, ...right] : null;
  }
  return null;
}

// The bindings BOTH walkers need, built once from a source. Keeping these
// per-walker is what made r13's alias fix apply to routes and not to helper
// modules, and the `.gates` read resolvable on one side only — the third and
// fourth times a fix landed on one half of this file (#6342 r15). One function,
// two callers.
//
// `readerAliases`: `const { isEnabled: reviewGateOn } = require(…)` ⇒
//   reviewGateOn ⇒ isEnabled. Any rename of either reader counts, from any
//   module: the names are distinctive and over-accepting only resolves or
//   reports more reads.
// `gatesBindings`: `const { gates } = require('../config/feature-gates')` ⇒
//   the local names holding the key table, so `gates.someKey` reads the same as
//   `featureGates.gates.someKey`. Live in `admin-visits.js` and three services.
// Is this node the feature-gates MODULE? A named binding, or the inline
// `require('../config/feature-gates')` that most of this codebase uses. Needed
// because `.gates.<key>` alone is not a gate read — `previsit-brief.js` has
// `entry.gates.targetN` (lawn label limits) — but requiring a named binding
// alone dropped three real reads written as an inline require (#6342 r15).
function isGatesModule(node, moduleBindings) {
  if (!node) return false;
  if (node.type === 'Identifier') return moduleBindings.has(node.name);
  if (node.type === 'CallExpression' && node.callee && node.callee.type === 'Identifier'
    && node.callee.name === 'require' && node.arguments.length === 1) {
    const arg = node.arguments[0];
    return arg.type === 'StringLiteral' && /feature-gates$/.test(arg.value);
  }
  return false;
}

function gateBindings(source) {
  const readerAliases = new Map();
  const gatesBindings = new Set();
  // `const featureGates = require('../config/feature-gates')` ⇒ featureGates.
  // Required, because `.gates.<key>` alone is NOT a gate read: `previsit-brief.js`
  // has `entry.gates.targetN` and `p.gates.trigger`, which are lawn product
  // label limits on a data object that happens to carry a `gates` property.
  // Counting those put non-gates through the resolver — the same mistake as
  // `GATE_ENV` and `GATE_UUID_ARRAY`, found by this walker's own fail-closed
  // report (#6342 r15). The object has to be the gates MODULE.
  const moduleBindings = new Set();
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"]([^'"]*feature-gates)['"]\s*\)/g)) {
    moduleBindings.add(m[1]);
  }
  // `const featureGates = require('../config/feature-gates')` and then
  // `const { gateEnvValue } = featureGates` — live in `admin-protocols.js:38`
  // and `admin-inventory.js:73`. Only a pattern assigned DIRECTLY from
  // `require(…)` was collected, so those aliases were invisible to both
  // walkers (#6342 r23). The right-hand side may be any module binding
  // gathered above.
  const MODULE_RE = moduleBindings.size ? [...moduleBindings].join('|') : null;
  const destructured = MODULE_RE
    ? new RegExp(`\\{([^}]{0,400}?)\\}\\s*=\\s*(?:require\\(|(?:${MODULE_RE})\\b)`, 'g')
    : /\{([^}]{0,400}?)\}\s*=\s*require\(/g;
  for (const m of source.matchAll(destructured)) {
    for (const binding of m[1].split(',')) {
      const [original, alias] = binding.split(':').map((x) => x.trim());
      const local = alias || original;
      if (!/^[A-Za-z_$][\w$]*$/.test(local || '')) continue;
      if (GATE_READERS.has(original)) readerAliases.set(local, original);
      if (original === 'gates') gatesBindings.add(local);
    }
  }
  // A LOCAL can hold a reader too, and this codebase injects them that way:
  // `const enabled = gates.isEnabled || isEnabled` in three functions of
  // `call-recording-processor.js`, and `function
  // unclearServiceAssessmentActive(enabled = isEnabled)` beside them, each then
  // called as `enabled('someKey')`. That hid a LIVE read of
  // `GATE_CALL_OUTBOUND_BOOKING` — undocumented in
  // `docs/public-route-contracts.md`, unbaselined, and reached from
  // `twilio-voice-webhook.js` (#6342 r19), which is the defect class this test
  // exists for rather than another spelling.
  //
  // The reader must be REFERENCED, not CALLED: `const on = isEnabled('x')`
  // holds a boolean, and counting that would make every gated local a reader
  // and every later `on(…)` a gate read. Hence the `(?!\()` — the same
  // reference-vs-call distinction `noteRef` draws for helpers.
  const READERS = [...GATE_READERS].join('|');
  const held = new RegExp(`\\b(${READERS})\\b\\s*(?!\\()`);
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*([^;\n]*)/g)) {
    const ref = held.exec(m[2]);
    if (ref) readerAliases.set(m[1], ref[1]);
  }
  // `(enabled = isEnabled)` — a parameter default, which is how
  // `unclearServiceAssessmentActive` takes its reader.
  for (const m of source.matchAll(new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*(${READERS})\\s*[,)]`, 'g'))) {
    readerAliases.set(m[1], m[2]);
  }
  return { readerAliases, gatesBindings, moduleBindings };
}

const GATE_MENTION = /GATE_[A-Z0-9_]+|isEnabled\s*\(|gateEnvValue\s*\(/;

function helperToGates(source, keys, filename = 'module.js', unresolved = null) {
  const map = new Map();
  // Helper names whose `isEnabled(…)` argument this resolver could not decode.
  // Tracked, not ignored: a helper body read `isEnabled(GATE)` with a module
  // constant and contributed NOTHING, so `textBackIfMissed()` in
  // `missed-call-text-back.js` hid both of its gates from
  // `twilio-voice-webhook.js` and the ratchet passed (#6342 r9). Reported only
  // when a scanned file actually calls the helper, so an undecodable read in a
  // module nobody calls is not noise.
  const opaque = new Set();
  // Nothing to find, and 900-odd of the ~1120 reachable modules take this exit.
  // NO PREFILTER. A `GATE_*`/`isEnabled(`/`gateEnvValue(` text test used to skip
  // more than half these modules unparsed, and it was unsound by construction: a
  // module that only imports and DELEGATES to a gate helper contains none of
  // those strings, so its helper and its call-graph edge were discarded and the
  // gate vanished (#6342 r14). Any module that requires another could
  // contribute, which is nearly all of them, so there is no sound version of
  // this filter — only the parse. It costs ~13 s to ~17 s and finds 7 more live
  // gates; this test's whole history is optimizations hiding gates, so the
  // parse wins. The per-path memoisation below is what keeps it affordable.
  let ast;
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      sourceFilename: filename,
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: ['jsx'],
    });
  } catch (err) {
    // Only reached for a module that DOES mention a gate, so it is worth a
    // report rather than the regex's silent nothing.
    if (unresolved) unresolved.push(`${filename} defines gates but does not parse: ${err.message}`);
    return { gates: map, opaque, calls: new Map(), moduleGates: [], moduleOpaque: false, exports: new Map() };
  }

  // `const GATE = 'missedCallTextBack'` — the same indirection round 4 fixed on
  // the read side, which the definition side never got. Taken textually,
  // exactly as `identifierValues` does for route files; over-collecting is
  // harmless because only names used as an `isEnabled` argument are looked up.
  // All three quote styles, each to its own closing delimiter so a string may
  // contain the other quote characters. Single quotes alone was not enough —
  // the SQL fragment that exposed this is double-quoted AND contains single
  // quotes, so its value read as "no value" and the name alone decided the
  // outcome.
  const consts = new Map();
  for (const quote of ["'", '"', '`']) {
    const pattern = new RegExp(
      `(?:const|let|var)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${quote}((?:[^${quote}\\\\]|\\\\.)*)${quote}`,
      'g',
    );
    for (const m of source.matchAll(pattern)) if (!consts.has(m[1])) consts.set(m[1], m[2]);
  }
  // Every local binding, string-valued or not, so a name that merely LOOKS like
  // a gate can be told from a gate.
  const declared = new Set();
  for (const m of source.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) declared.add(m[1]);
  const { readerAliases, gatesBindings, moduleBindings } = gateBindings(source);
  // A local name can also come from ANOTHER module:
  // `gateEnvValue(TERMITE_BOND_GATE)` in `property.js` reads a constant
  // destructured from `services/termite-bonds.js`, which exports it as the
  // string `GATE_PORTAL_TERMITE_BOND`. The route half has resolved that since
  // r4 through `identifierValues`; this half had only its own file, so the read
  // decoded to nothing and — sitting in an anonymous handler, with no enclosing
  // name to be opaque — was dropped by the module-scope path (#6342 r16). The
  // SAME function, not a second lookup. Lazy and memoised: it reads the files a
  // destructuring names, and consulting it eagerly for all 367 modules cost
  // 39 s for the one name in this codebase that needs it. Local declarations
  // are checked first, because a local binding shadows an import.
  const helperArrays = stringArrays(source);
  let imported = null;
  const constValue = (name) => {
    if (consts.has(name)) return consts.get(name);
    if (!imported) imported = identifierValues(path.join(SERVER_ROOT, filename), stripComments(source));
    return imported.get(name);
  };

  // `prop: 'value'` — the values a property name takes anywhere in the module,
  // so a read through a data table resolves instead of reading as nothing.
  const propStrings = new Map();
  for (const quote of ["'", '"', '`']) {
    const pattern = new RegExp(
      `([A-Za-z_$][\\w$]*)\\s*:\\s*${quote}((?:[^${quote}\\\\]|\\\\.)*)${quote}`,
      'g',
    );
    for (const m of source.matchAll(pattern)) {
      if (!propStrings.has(m[1])) propStrings.set(m[1], new Set());
      propStrings.get(m[1]).add(m[2]);
    }
  }

  // ONE pass. `stack` is the named functions enclosing the current node, so a
  // gate read is attributed to each of them — which is what makes the factory
  // resolve — without re-walking a subtree per function. Walking each function
  // separately is O(nodes x nesting depth) and cost 2.7 s over the 367 modules
  // these routes reach; this is a single traversal.
  const isFn = (n) => !!n && (n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression'
    || n.type === 'FunctionDeclaration' || n.type === 'ObjectMethod' || n.type === 'ClassMethod');

  // The name a function is bound to, from the node that binds it:
  // `function f()`, `const f = () =>`, `exports.f = function`, `{ f() {} }`.
  const boundName = (node) => {
    if (node.type === 'FunctionDeclaration' && node.id) return node.id.name;
    if (node.type === 'VariableDeclarator' && node.id && node.id.type === 'Identifier' && isFn(node.init)) {
      return node.id.name;
    }
    if (node.type === 'AssignmentExpression' && isFn(node.right) && node.left) {
      if (node.left.type === 'Identifier') return node.left.name;
      if (node.left.type === 'MemberExpression' && node.left.property
        && node.left.property.type === 'Identifier') return node.left.property.name;
    }
    if ((node.type === 'ObjectMethod' || node.type === 'ClassMethod')
      && node.key && node.key.type === 'Identifier') return node.key.name;
    if (node.type === 'ObjectProperty' && node.key && node.key.type === 'Identifier'
      && isFn(node.value)) return node.key.name;
    return null;
  };

  const stack = [];
  const calls = new Map();
  // A gate read at MODULE scope has no enclosing function to attribute it to,
  // so `attribute()` discarded it: moving a guard out of a named function, to
  // pick which middleware a module exports, hid it entirely (#6342 r14). It
  // runs on require, so it belongs to any file that requires the module.
  const moduleGates = new Set();
  let moduleOpaque = false;
  const exportBindings = new Map();
  const attribute = (gates) => {
    if (!gates.length) return;
    if (!stack.length) { for (const g of gates) moduleGates.add(g); return; }
    for (const name of stack) {
      const prev = map.get(name);
      if (!prev) map.set(name, [...new Set(gates)]);
      else for (const g of gates) if (!prev.includes(g)) prev.push(g);
    }
  };
  const markOpaque = () => { for (const name of stack) opaque.add(name); };
  // A gate READ this resolver cannot decode, which is not the same thing as a
  // NAME that merely looks like a gate. Opacity needed the module-scope case
  // `moduleGates` got in r14: with an empty stack `markOpaque` marks NOTHING,
  // so a require-time `isEnabled(KEY)` whose `KEY` picks a key conditionally
  // was discarded as no read at all — the fail-open the resolved half already
  // closed (#6342 r16). A module whose require-time read is unreadable makes
  // every file requiring it unreadable.
  //
  // Only the two READ branches report that way. The gate-shaped identifier
  // branch below must not: at module scope its opaque case is a local whose
  // value this resolver cannot read, which is dominated by constants that are
  // not gates and never were — `const GATE_LOCK_WAIT_MS = 300` and `const
  // GATE_WRITE_TRIES = 3` (`admin-neighborhood-access.js`), `const GATE_RETIRE
  // = {…}` and `const GATE_HOLD_MESSAGES = {…}` (`admin-drafts.js`). Reporting
  // it would fail this test on those two files over names it has already
  // decided are not gates (r10, r13). Measured: reporting every branch named
  // four files, and the other two were real reads this round fixes —
  // `property.js` (a constant imported from another module, resolved by
  // `constValue` below) and `admin-email-templates.js` (a literal key the
  // table does not define, judged by `staticString`).
  const markUnreadableRead = () => {
    if (!stack.length) { moduleOpaque = true; return; }
    markOpaque();
  };
  // An edge is any REFERENCE to a name, not only a call of it. This codebase
  // injects dependencies by default parameter — `scheduleRecovery(cron, { sweep
  // = sweepAbandonedDeliveries } = {})` calls it as `sweep(...)`, so following
  // calls alone found no path from `scheduleRecovery` to the gate its sweep
  // reads, and `index.js` (which calls only `scheduleRecovery`) resolved none
  // of `GATE_LAWN_DELIVERY_RECOVERY` (#6342 r9). Referencing a gated function
  // is enough to be gated by it; a reference that is never invoked
  // over-attributes, which costs a baseline entry, and following calls only
  // loses the gate.
  // A CALL at module scope has no enclosing function either, and `noteRef`
  // dropped it, so a module whose require-time work is `initialize()` — the
  // gate read one hop inside a named function invoked at top level —
  // contributed nothing, the same fail-open r14 closed for a read written
  // directly at module scope (#6342 r17). Folded into `moduleGates` after the
  // fixed point, when the callee's own gates are known.
  //
  // CALLS only. Collecting every module-scope reference, as the first cut did,
  // counts `const { gatedHelper } = require('./x')` as a require-time read and
  // attributed 111 more gates across 49 files to files that merely IMPORT a
  // gated helper — over-attribution on the scale that makes a baseline
  // meaningless. Importing a gated function is not calling it.
  const moduleRefs = new Set();
  const noteRef = (ref) => {
    if (!ref || !stack.length) return;
    for (const name of stack) {
      if (name === ref) continue;
      if (!calls.has(name)) calls.set(name, new Set());
      calls.get(name).add(ref);
    }
  };

  const walk = (node) => {
    if (!node || typeof node.type !== 'string') return;
    const name = boundName(node);
    if (name) stack.push(name);

    if (node.type === 'StringLiteral' && /^GATE_[A-Z0-9_]+$/.test(node.value)) attribute([node.value]);
    if (node.type === 'Identifier' && /^GATE_[A-Z0-9_]+$/.test(node.name)) {
      // A name shaped like a gate may be a local binding HOLDING the real one:
      // `const GATE_ENV = 'GATE_PHOTO_MARKS'; process.env[GATE_ENV]`.
      // Attributing the identifier itself put a gate that does not exist,
      // `GATE_ENV`, into the baseline for two files and hid both real gates
      // behind it (#6342 r10). An undeclared one is a property of
      // `process.env`; a declared one resolves to its string value or is
      // opaque (it can be an object, as in `voice-relay-replay.js`).
      if (!declared.has(node.name)) attribute([node.name]);
      else {
        const value = consts.get(node.name);
        // Three outcomes, and the middle one is the whole point: a local whose
        // value is a string that is NOT a gate name is NOT A GATE, however it
        // is spelled. `GATE_UUID_ARRAY` in `annual-prepay-renewals.js` holds a
        // SQL fragment that filters malformed uuids; attributing the name put a
        // gate that has never existed into `stripe-webhook.js`'s baseline, as
        // `GATE_ENV` did for two more files (#6342 r10). Only an unreadable
        // binding — an object, a call — is opaque.
        if (value === undefined) markOpaque();
        else if (/^GATE_[A-Z0-9_]+$/.test(value)) attribute([value]);
      }
    }
    // `featureGates.gates.someKey` and a destructured `gates.someKey` are gate
    // reads in a helper body exactly as they are in a route; this walker did
    // not look for them at all, which r15 would have found next.
    if (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
      const prop = propertyName(node);
      const obj = node.object;
      const viaGates = (obj && (obj.type === 'MemberExpression' || obj.type === 'OptionalMemberExpression')
          && propertyName(obj) === 'gates' && isGatesModule(obj.object, moduleBindings))
        || (obj && obj.type === 'Identifier' && gatesBindings.has(obj.name));
      if (viaGates) {
        const gates = prop === null ? null : keys.get(prop);
        if (gates) attribute(gates);
        else markUnreadableRead();
      }
      // `process.env.GATE_X` and `process.env['GATE_X']` already reached the
      // Identifier and StringLiteral branches above; `` process.env[`GATE_X`] ``
      // reached neither, so a backtick read in a helper body was no gate at all
      // (#6342 r17).
      //
      // The gate name only. A COMPUTED `process.env[expr]` is left alone here,
      // against the suggestion that came with the finding, because in a helper
      // body that shape is a generic env accessor whose name belongs to the
      // caller — `const n = Number(process.env[name])`
      // (`call-recording-processor.js`), and every reader inside
      // `config/feature-gates.js` itself. Marking it unreadable made 27 helpers
      // in the gates module opaque, plus `call-recording-processor.js` and
      // `photo-text-triage.js`, and each one makes every route that calls it
      // report a read this resolver had already resolved by name at the call
      // site: r10's 273-line cascade again. The route walker still reports the
      // computed form, where no such accessor lives.
      const isProcessEnv = (obj && (obj.type === 'MemberExpression' || obj.type === 'OptionalMemberExpression')
        && obj.object && obj.object.type === 'Identifier' && obj.object.name === 'process'
        && propertyName(obj) === 'env');
      if (isProcessEnv && prop !== null && /^GATE_[A-Z0-9_]+$/.test(prop)) attribute([prop]);
    }
    if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') && !stack.length) {
      if (node.callee && node.callee.type === 'Identifier') moduleRefs.add(node.callee.name);
    }
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      // `featureGates.isEnabled('treatmentZoneMap')` is the same read as the
      // bare call, and taking only Identifier callees meant
      // `treatmentZonePdfSignature()` contributed nothing and was not even
      // marked opaque, hiding `GATE_TREATMENT_ZONE_MAP` from
      // `reports-public.js` (#6342 r10). The route-side walker already took
      // member callees; this half did not.
      const c = node.callee;
      const rawCallee = !c ? null
        : (c.type === 'Identifier' ? c.name
          : ((c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression')
            ? propertyName(c) : null));
      if (readerViaCallApply(c, readerAliases)) markUnreadableRead();
      const asCallback = readerAsCallback(node, readerAliases);
      if (asCallback) {
        const names = callbackGateNames(asCallback.receiver, (n) => helperArrays.get(n));
        if (!names) markUnreadableRead();
        else {
          const found = [];
          let whole = true;
          for (const value of names) {
            const resolved = resolveGateArg(
              { type: 'StringLiteral', value }, keys, constValue, asCallback.reader,
            );
            if (!resolved) { whole = false; break; }
            for (const [gate] of resolved) found.push(gate);
          }
          if (whole) attribute(found);
          else markUnreadableRead();
        }
      }
      const callee = readerAliases.get(rawCallee) || rawCallee;
      if (GATE_READERS.has(callee) && node.arguments.length) {
        const resolved = resolveGateArg(
          node.arguments[0], keys, constValue, callee,
          (prop) => [...(propStrings.get(prop) || [])],
        );
        if (resolved) attribute(resolved.map(([g]) => g));
        else if (staticString(node.arguments[0]) === null) markUnreadableRead();
      }
    }
    if (node.type === 'Identifier') noteRef(node.name);

    // `module.exports = internalGate`, `module.exports = { publicGuard:
    // internalGate }` and `exports.publicGuard = internalGate` all rename a
    // helper on the way out. Recorded as export name ⇒ indexed name, and wired
    // up as an EDGE by the caller, so a rename reaches its gates through the
    // fixed point already there rather than a second lookup path (#6342 r16).
    if (node.type === 'AssignmentExpression' && node.left
      && (node.left.type === 'MemberExpression') && node.left.object) {
      // `module.exports.publicGuard = internalGate` is a nested member, so the
      // object is not an Identifier and this branch skipped it — the live form
      // in `estimate-recommendations.js` (`sealRecommendationsForSend =
      // sealForSend`) and `invoices.js`, and half of r16's own fix (#6342 r17).
      // `module.exports.<name>` is read as `exports.<name>`, which it is.
      const obj = node.left.object;
      const target = obj.type === 'Identifier' ? obj.name
        : (obj.type === 'MemberExpression' && obj.object && obj.object.type === 'Identifier'
          && obj.object.name === 'module' && propertyName(obj) === 'exports' ? 'exports' : null);
      const slot = propertyName(node.left);
      // `module.exports = Object.freeze({ … })` is the same export map with a
      // wrapper around it, and the wrapper hid every rename inside it (#6342
      // r18). `Object.freeze` ONLY: it is the one wrapper this codebase uses
      // (`sms-offer-sources.js`), and "static wrappers such as" is the
      // generalisation past a demonstrated requirement that cost r17 a hole.
      const raw = node.right;
      const right = (raw && raw.type === 'CallExpression' && raw.callee
        && raw.callee.type === 'MemberExpression' && raw.callee.object
        && raw.callee.object.type === 'Identifier' && raw.callee.object.name === 'Object'
        && propertyName(raw.callee) === 'freeze' && raw.arguments.length === 1)
        ? raw.arguments[0] : raw;
      if (target === 'module' && slot === 'exports') {
        if (right && right.type === 'Identifier') exportBindings.set(DEFAULT_EXPORT, right.name);
        else if (right && right.type === 'ObjectExpression') {
          for (const prop of right.properties) {
            if (prop.type !== 'ObjectProperty' || !prop.key || !prop.value) continue;
            const name = prop.key.type === 'Identifier' ? prop.key.name
              : (prop.key.type === 'StringLiteral' ? prop.key.value : null);
            if (name && prop.value.type === 'Identifier') exportBindings.set(name, prop.value.name);
          }
        }
      } else if (target === 'exports' && slot && right && right.type === 'Identifier') {
        exportBindings.set(slot, right.name);
      }
    }

    // `{ code: 'GATE_CODE_BELLS_FAILED' }` is an Error code, not a gate — the
    // exact exclusion `scripts/lib/gate-scan.js` already carries, which I did
    // not mirror, so two error codes sat in this fixture as gates that have
    // never existed (#6342 r13). Same class as r10's `GATE_ENV`: a name is not
    // a gate.
    const isErrorCode = node.type === 'ObjectProperty' && node.key
      && ((node.key.type === 'Identifier' && node.key.name === 'code')
        || (node.key.type === 'StringLiteral' && node.key.value === 'code'));

    for (const key of Object.keys(node)) {
      if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      if (isErrorCode && key === 'value') continue;
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) walk(item);
      else if (child && typeof child === 'object' && typeof child.type === 'string') walk(child);
    }
    if (name) stack.pop();
  };
  walk(ast.program);

  // A helper that only DELEGATES reads no gate itself, so the walk above leaves
  // it empty: `pastCustomerLastStart()` is `customerLastStart16Enabled() &&
  // startMin > …`, and the gate is read one function further on, in a sibling —
  // which the enclosing-name stack never covers. `booking.js` calls both that
  // and `customerWindowAdmits()` (two hops), so `GATE_CUSTOMER_LAST_START_16`
  // resolved to nothing and deleting both its contract mentions left this green
  // (#6342 r8). Propagate along the module's own call graph to a FIXED POINT,
  // not one hop; cycles just stop changing anything. Still one module deep —
  // a helper delegating to an IMPORTED helper is the next hop out, and the
  // KNOWN LIMITS note above says so.
  for (let changed = true; changed;) {
    changed = false;
    for (const [fn, callees] of calls) {
      for (const callee of callees) {
        // Opacity rides the same edges: calling something undecodable makes the
        // caller undecodable too, or the fail-closed report stops one hop short.
        if (opaque.has(callee) && !opaque.has(fn)) { opaque.add(fn); changed = true; }
        const gates = map.get(callee);
        if (!gates) continue;
        const prev = map.get(fn);
        if (!prev) { map.set(fn, [...gates]); changed = true; continue; }
        for (const g of gates) if (!prev.includes(g)) { prev.push(g); changed = true; }
      }
    }
  }
  // After the fixed point: the gates a module-scope call resolves to belong to
  // any file that requires this module. A BARE call only — `initialize()`, not
  // `obj.method()`: both produced the same 30 entries here, so the narrower
  // rule is the one to keep, and it does not read `router.get(…)` as a call to
  // a helper named `get`.
  //
  // "Module scope" is this walker's own sense of it: not inside a NAMED
  // function. That includes a call inside an anonymous route handler, which is
  // per-request, not require-time — an approximation inherited from r14, which
  // attributes a direct read in the same position the same way. It is where all
  // 30 of this round's new entries come from (`estimate-public.js` ⇒
  // `public-quote.js` and the like), 642 ⇒ 672 gates over the same 47 files.
  // Each is a gate genuinely read by code in that file's graph; the widening is
  // 4.7%, against the 2.7x that made a second module hop unacceptable in r11.
  //
  // GATES, not opacity, and that is a measured limit rather than an oversight.
  // `opaque` does not record WHY a name is in it, and r16 established that its
  // two causes differ: an unreadable READ is a gate this resolver missed, while
  // a gate-SHAPED name whose value it cannot read (`const GATE_RETIRE = {…}`)
  // is usually not a gate at all. Propagating opacity through a top-level call
  // reported `admin-neighborhood-access.js`, `admin-drafts.js` and
  // `admin-pricing-config.js` on exactly the constants r16 measured and
  // excluded. So the residual hole, stated rather than papered over: an
  // unreadable read reached ONLY through a named function called at require
  // time is still silent. A read written at module scope is reported (r16), and
  // separating the two causes of opacity is the kind of thing one pass over the
  // module graph gets for free — decision 2.
  for (const ref of moduleRefs) {
    for (const gate of map.get(ref) || []) moduleGates.add(gate);
  }
  return {
    gates: map, opaque, calls, moduleGates: [...moduleGates],
    moduleOpaque, exports: exportBindings,
  };
}

// The same fixed point, run over maps UNIONED across every module a file
// reaches, which is the only level where a cross-module edge has both ends.
// `applyOutlinkTracking()` in `outlink-tracking.js` delegates to
// `outlinkTrackingLive()`, which is defined in `feature-gates.js`, so
// propagating inside each module found nothing and `GATE_OUTLINK_TRACKING`
// vanished for `prep-public.js` (#6342 r10).
function propagate(gatesByName, opaqueNames, edges) {
  for (let changed = true; changed;) {
    changed = false;
    for (const [fn, callees] of edges) {
      for (const callee of callees) {
        if (opaqueNames.has(callee) && !opaqueNames.has(fn)) { opaqueNames.add(fn); changed = true; }
        const gates = gatesByName.get(callee);
        if (!gates) continue;
        const prev = gatesByName.get(fn);
        if (!prev) { gatesByName.set(fn, [...gates]); changed = true; continue; }
        for (const g of gates) if (!prev.includes(g)) { prev.push(g); changed = true; }
      }
    }
  }
}
// GATE_* ⇒ the alias the route actually wrote, so "documented" can be checked
// against the name a reader would search for. Reads are taken from the AST.
function gatesUsedBy(source, keys, helpers, idents = new Map(), unresolved = [], filename = 'route.js', opaqueHelpers = new Set()) {
  const used = new Map();
  // An alias is the name a CONTRACT ENTRY may legitimately use for the gate —
  // its key (`payPageFaq`) or the `GATE_*` literal. It is never the name of the
  // code that reads the gate: with helper bodies parsed, `GATE_STOPS_AWAY` in
  // `track-public.js` resolved through `computeStopsAhead`, which the contract
  // mentions as inline code for unrelated reasons, and `documentsGate` read
  // that as documentation — silently reopening the round-1 finding this test
  // was built for. So anything that is not a key documents itself only.
  const note = (gate, alias) => {
    if (!gate || used.has(gate)) return;
    used.set(gate, keys.has(alias) ? alias : gate);
  };
  let ast;
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      sourceFilename: filename,
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      plugins: ['jsx'],
    });
  } catch (err) {
    // A file this test cannot parse is not a file it may silently skip.
    unresolved.push(`${filename} does not parse: ${err.message}`);
    return used;
  }

  // `?.` gives babel its own node types, so every shape below accepts both or a
  // `helper?.()` read resolves to nothing (#6342 r4: `callMakesNoServiceAsk?.()`).
  const isMember = (node) => !!node
    && (node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression');
  const isCall = (node) => !!node
    && (node.type === 'CallExpression' || node.type === 'OptionalCallExpression');

  // `const { isEnabled: reviewGateOn } = require('../config/feature-gates')` is
  // a live form here (`appointment-reminders.js`, `complete-scheduled-service.js`),
  // and matching the callee name literally treated the alias as unrelated code
  // (#6342 r13). Any destructured rename of a reader counts, whatever module it
  // is taken from, because the names are distinctive and over-accepting only
  // resolves or reports more reads.
  const { readerAliases, gatesBindings, moduleBindings } = gateBindings(source);

  // The callee is resolved with the SAME static-property rule as a read, so
  // `featureGates['portalActivityLive']()` cannot slip past a check that
  // `featureGates.portalActivityLive()` fails (#6342 r16), and a computed
  // `fns[name]()` no longer resolves to a helper called `name`.
  const calleeName = (node) => {
    if (!node) return null;
    if (node.type === 'Identifier') return node.name;
    if (isMember(node)) return propertyName(node);
    return null;
  };

  const resolveArg = (node) => {
    const resolved = resolveGateArg(node, keys, (n) => idents.get(n));
    if (!resolved) return false;
    for (const [gate, key] of resolved) note(gate, key);
    return true;
  };

  const src = (node) => source.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 120);
  const arrays = stringArrays(source);

  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (isCall(node)) {
      const viaCallApply = readerViaCallApply(node.callee, readerAliases);
      if (viaCallApply) unresolved.push(src(node));
      const asCallback = readerAsCallback(node, readerAliases);
      if (asCallback) {
        const names = callbackGateNames(asCallback.receiver, (n) => arrays.get(n));
        if (!names) unresolved.push(src(node));
        else {
          for (const value of names) {
            const resolved = resolveGateArg(
              { type: 'StringLiteral', value }, keys, (n) => idents.get(n), asCallback.reader,
            );
            if (resolved) for (const [gate, alias] of resolved) note(gate, alias);
            else unresolved.push(src(node));
          }
        }
      }
      const raw = calleeName(node.callee);
      const name = readerAliases.get(raw) || raw;
      // `techNotices.isEnabled()` is an unrelated method that happens to share
      // the name; with no argument there is no gate to name, so it is neither a
      // read nor something to report.
      // A statically known string that is not a key is not a gate, the same
      // judgement the helper half makes — otherwise one expression is a
      // failure here and silence there, which is how r10 and r15 happened.
      if (name === 'isEnabled' && node.arguments.length) {
        if (!resolveArg(node.arguments[0])) unresolved.push(src(node));
      } else if (ENV_NAME_READERS.has(name)) {
        const resolved = resolveGateArg(node.arguments[0], keys, (n) => idents.get(n), name);
        if (resolved) for (const [gate, alias] of resolved) note(gate, alias);
        else unresolved.push(src(node));
      } else if (name && (helpers.has(name) || opaqueHelpers.has(name))) {
        for (const g of helpers.get(name) || []) note(g, name);
        // The helper reads a gate this resolver could not decode, so whatever
        // it reads would otherwise count as nothing at all.
        if (opaqueHelpers.has(name)) {
          unresolved.push(`${name}() (its own isEnabled argument)`);
        }
      }
    }
    if (isMember(node)) {
      const prop = propertyName(node);
      const objectIsGates = (isMember(node.object) && propertyName(node.object) === 'gates'
          && isGatesModule(node.object.object, moduleBindings))
        || (node.object && node.object.type === 'Identifier' && gatesBindings.has(node.object.name));
      if (objectIsGates) {
        const gates = prop === null ? null : keys.get(prop);
        if (gates) for (const g of gates) note(g, prop);
        else unresolved.push(src(node));
      }
      const isProcessEnv = isMember(node.object)
        && node.object.object && node.object.object.type === 'Identifier'
        && node.object.object.name === 'process'
        && propertyName(node.object) === 'env';
      if (isProcessEnv) {
        if (prop === null) unresolved.push(src(node));
        else if (/^GATE_[A-Z0-9_]+$/.test(prop)) note(prop, prop);
      }
    }

    // `const { GATE_X } = process.env` is the same read as `process.env.GATE_X`,
    // and neither the destructuring nor the later use of `GATE_X` was recorded
    // or reported (#6342 r14). Only statically named properties count; a
    // computed or rest element is not a gate name.
    if (node.type === 'VariableDeclarator' && node.id && node.id.type === 'ObjectPattern'
      && isMember(node.init) && node.init.object && node.init.object.type === 'Identifier'
      && node.init.object.name === 'process' && propertyName(node.init) === 'env') {
      for (const prop of node.id.properties) {
        if (prop.type !== 'ObjectProperty' || prop.computed) continue;
        const key = prop.key.type === 'Identifier' ? prop.key.name
          : (prop.key.type === 'StringLiteral' ? prop.key.value : null);
        if (key && /^GATE_[A-Z0-9_]+$/.test(key)) note(key, key);
      }
    }

    // A helper used as middleware is passed BY REFERENCE, never called here:
    // `router.use(codexGate)` is an Identifier, so a call-only check never
    // consulted the helper map and the gate it reads counted as none (#6342
    // r12). The definition side has followed references since r9; this half had
    // not. Over-attributing an imported-but-uncalled helper costs a baseline
    // entry; missing a registered one loses the gate.
    if (node.type === 'Identifier' && (helpers.has(node.name) || opaqueHelpers.has(node.name))) {
      for (const g of helpers.get(node.name) || []) note(g, node.name);
      if (opaqueHelpers.has(node.name)) {
        unresolved.push(`${node.name}() (its own isEnabled argument)`);
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
      const child = node[key];
      if (Array.isArray(child)) for (const item of child) visit(item);
      else if (child && typeof child === 'object' && typeof child.type === 'string') visit(child);
    }
  };
  visit(ast.program);
  return used;
}

// Parsing a module is memoised by path: without it the loop re-read 180 MB
// (feature-gates.js 82 times). This test shares a jest worker pool with
// timing-sensitive suites in the same shard — sms-label-facts.js asserts
// sub-quadratic SCALING — so its own CPU burst is not free, and the cost is
// stated rather than discovered: the 93 files reach ~770 distinct modules, more
// than half of which the GATE_MENTION prefilter drops unparsed; parsing the
// rest (~30 MB) is most of the test's ~12 s, up from ~2.2 s before definitions
// were parsed. What that bought is five routers' `GATE_HERMES_WORKER`, two
// `GATE_MISSED_CALL_TEXT_BACK*` on the voice webhook,
// `GATE_LAWN_DELIVERY_RECOVERY` on the mount file, `GATE_TREATMENT_ZONE_MAP`
// and `GATE_PHOTO_MARKS` on the report routes, and the removal of two gates
// that never existed — each of them a live defect in what this test reported.
// The obvious
// further cut — parse a module only when the route calls a name it defines —
// needs the parse to know the names, and every textual shortcut to that is the
// kind of approximation these rounds were spent removing.
function helperCache(unresolved) {
  const cache = new Map();
  return (modPath, keys) => {
    if (!cache.has(modPath)) {
      cache.set(modPath, helperToGates(
        fs.readFileSync(modPath, 'utf8'), keys, path.relative(SERVER_ROOT, modPath), unresolved,
      ));
    }
    return cache.get(modPath);
  };
}

// The local modules a route requires, resolved to real paths under server/, so a
// gate wrapper defined outside feature-gates.js still resolves.
//
// ONE hop, deliberately, and a KNOWN LIMIT rather than a conclusion: a gate
// reached only through a direct import's OWN dependency is invisible here.
// `estimate-public.js` imports `notification-service.js`, whose
// `notifyCustomer()` calls `account-properties.js`'s
// `appPropertyScopeEnabled()`, so `GATE_APP_PROPERTY_SCOPE` resolves for the
// three routes importing `account-properties` directly and for no others
// (#6342 r11).
//
// Two hops was measured, not assumed, and rejected on PRECISION before cost:
// it produces 1,396 baselined gates over 56 files against 522 over 43, and
// unbounded closure reaches 2,127 modules from one file. Every extra hop
// attributes more of the codebase's gates to every public file, and a baseline
// approaching "every gate under every file" cannot fail on a NEWLY added one,
// which is the only thing this test exists to do. Cost agrees (two hops runs
// for minutes, driven by the reference edges the fixed point rescans, which
// scale with code volume rather than module count) but is the weaker argument.
//
// Closing it needs attribution that does not widen with depth — one module
// parsed once into a global map, shared with `scripts/lib/gate-scan.js`, which
// is decision 2 in the PR body and a design call, not a review fix.
function requiredLocalModules(routeFile, code) {
  const out = [];
  // Both quote styles: 16 files under server/ write `require("./x")`, so
  // matching only single quotes let a formatting choice hide a helper module
  // from this scan entirely (#6342 r13).
  for (const m of code.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    const resolved = resolveLocalModule(routeFile, m[1]);
    if (resolved) out.push(resolved);
  }
  return out;
}

// A relative specifier ⇒ the real file under `server/`, or null.
// `.js` only: `require('../config/protocols.json')` resolves to a real file and
// is data, not code with gates — feeding it to the JS parser is a parse error
// reported as an unreadable gate read. The GATE_MENTION prefilter used to hide
// that by accident.
function resolveLocalModule(fromFile, spec) {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    if (!candidate.endsWith('.js')) continue;
    if (candidate.startsWith(SERVER_ROOT) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }
  return null;
}

// The LOCAL name a route gives each thing it imports, with the export it came
// from: `const publicGuard = require('./guard')` is the module's default export
// under a new name, `const { a: b } = require('./m')` is export `a` under the
// name `b`. Needed because the helper map is keyed by the name whose body was
// indexed, so an import rename has to be joined back to it (#6342 r16).
function requireBindings(routeFile, code) {
  const out = [];
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  const add = (local, exported, spec) => {
    const file = resolveLocalModule(routeFile, spec);
    if (file) out.push({ local, exported, path: file });
  };
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    add(m[1], DEFAULT_EXPORT, m[2]);
  }
  // The same conservative destructuring list `identifierValues` uses: names,
  // commas and renames only, so a stray brace cannot swallow a function body.
  for (const m of code.matchAll(/\{\s*([A-Za-z_$][\w$,:\s]*?)\s*\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
    for (const binding of m[1].split(',')) {
      const [original, alias] = binding.split(':').map((x) => x.trim());
      if (!IDENT.test(original || '') || (alias !== undefined && !IDENT.test(alias))) continue;
      add(alias || original, original, m[2]);
    }
  }
  return out;
}

// IDENT ⇒ its string value, for `isEnabled(IDENT)`: a local `const IDENT = 'key'`,
// or a destructured require (renamed or not) whose source module binds that name
// to a string. One level, which is where these constants live.
function identifierValues(routeFile, code) {
  const values = new Map();
  for (const m of code.matchAll(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*'([^']+)'/g)) {
    values.set(m[1], m[2]);
  }
  // Only a real destructuring list: identifiers, commas and renames, nothing
  // with braces, calls or statement breaks. `[^}]*` spans newlines, so without
  // this a far-away brace swallows a whole function body and "identifiers" come
  // back as code — which then cannot be interpolated into a RegExp.
  const IDENT = /^[A-Za-z_$][\w$]*$/;
  const destructured = /\{\s*([A-Za-z_$][\w$,:\s]*?)\s*\}\s*=\s*require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  for (const m of code.matchAll(destructured)) {
    const target = path.resolve(path.dirname(routeFile), m[2]);
    const file = [target, `${target}.js`, path.join(target, 'index.js')]
      .find((c) => c.startsWith(SERVER_ROOT) && fs.existsSync(c) && fs.statSync(c).isFile());
    if (!file) continue;
    const modSource = stripComments(fs.readFileSync(file, 'utf8'));
    for (const binding of m[1].split(',')) {
      const [original, alias] = binding.split(':').map((x) => x.trim());
      if (!IDENT.test(original || '') || (alias !== undefined && !IDENT.test(alias))) continue;
      const local = alias || original;
      const direct = modSource.match(new RegExp(`(?:const|let|var)\\s+${original}\\s*=\\s*'([^']+)'`))
        || modSource.match(new RegExp(`\\b${original}\\s*:\\s*'([^']+)'`));
      if (direct && !values.has(local)) values.set(local, direct[1]);
    }
  }
  return values;
}

// Express applies `router.use(authenticate)` only to what is registered AFTER
// it, so WHERE it appears decides what it covers — presence alone does not.
// `admin-push.js` registers `/vapid-key` with no auth at all (deliberately:
// "an expired admin token can't silently break Enable push") and only then
// applies router-level auth, so a file-wide test excluded a genuinely public
// endpoint (#6342 r8). A file is covered only when its router-level auth
// precedes EVERY route registration in it; anything earlier keeps the file in
// scope, whether or not that handler carries its own auth. The three files
// this pulls in whose early handlers do carry per-handler auth cost a baseline
// entry at most, which is the trade this set makes everywhere else.
function routerAuthCoversFile(code) {
  const auth = code.search(ROUTER_LEVEL_AUTH);
  if (auth === -1) return false;
  ROUTE_REGISTRATION.lastIndex = 0;
  for (let m = ROUTE_REGISTRATION.exec(code); m; m = ROUTE_REGISTRATION.exec(code)) {
    if (m.index < auth) return false;
  }
  return true;
}

// [label, absolute path]. `index.js` is in the set because the gate that makes
// a public prefix dark is often applied THERE, in pre-router middleware, and
// never read by the router: `/api/public/careers` 404s unless
// `isEnabled('jobApplications')` in `server/index.js`, while
// `public-careers.js` never mentions that key, so deleting
// `GATE_JOB_APPLICATIONS` from the contract left this green (#6342 r7).
//
// It goes in WHOLE, not filtered to its public mounts. Selecting mounts by path
// was tried and is wrong twice over: `/api/pay/statement` is dark behind
// `payerStatements` with no `public` in its path, and the `/estimate/:token`
// embed guard that reads `websiteQuoteBooking` is mounted with no path at all.
// A pattern that drops either is the same defect six rounds of this test were
// spent closing. So its ~60 non-public reads (`cronJobs` and the agent gates)
// each cost one baseline entry instead — the trade this file set makes
// everywhere else, and each entry still has to stay earned.
function publicRouteFiles() {
  const routes = fs.readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.js') && !f.includes('.test.'))
    .filter((f) => {
      if (NAME_PATTERNS.some((r) => r.test(f))) return true;
      const code = stripComments(fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8'));
      return !routerAuthCoversFile(code);
    })
    .sort()
    .map((f) => [f, path.join(ROUTES_DIR, f)]);
  return [['index.js', path.join(SERVER_ROOT, 'index.js')], ...routes];
}

// Named in the contract as a WHOLE gate token, or under the alias the route
// wrote as inline code. Both bounds matter: `doc.includes(gate)` let
// `GATE_VOICE_LATE_PAYMENT_AUTODIAL` stand in as documentation for its own
// prefix `GATE_VOICE_LATE_PAYMENT` (#6342 r3), and a bare-prose alias match
// would let an unrelated sentence satisfy a future single-word key.
const documentsGate = (doc, gate, alias) => new RegExp(`(?<![A-Z0-9_])${gate}(?![A-Z0-9_])`).test(doc)
  || doc.includes(`\`${alias}\``);

test('no public route file gains a gate the public-route contract does not name', () => {
  const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  const gatesRaw = fs.readFileSync(GATES_FILE, 'utf8');
  // The key TABLE is read textually (a line naming a gate); helper bodies are
  // parsed, so they get the raw source, comments and all.
  const keys = keyToGate(stripComments(gatesRaw));
  const doc = fs.readFileSync(CONTRACTS_DOC, 'utf8');

  const added = [];
  const stale = [];
  const unreadable = [];
  const base = helperToGates(gatesRaw, keys, 'config/feature-gates.js', unreadable);
  const helpersOf = helperCache(unreadable);

  // Every resolver input is load-bearing: if one stops parsing, the gates it
  // resolves silently read as "no gate used" and this ratchet passes on a diff
  // it should fail. Floors, not exact counts, so ordinary growth is free.
  expect(keys.size).toBeGreaterThan(100);
  expect(base.gates.size).toBeGreaterThan(100);

  const visited = new Set();
  for (const [file, routePath] of publicRouteFiles()) {
    visited.add(file);
    const source = fs.readFileSync(routePath, 'utf8');
    // UNION per name, never first-wins. Helper maps are keyed by bare function
    // name across every module a route reaches, so two modules can define the
    // same name — and keeping the first DISCARDED the other's gates outright:
    // `gateOpen` resolved to `GATE_APPOINTMENT_PAGE` and threw away
    // `GATE_LAWN_DELIVERY_RECOVERY` from `lawn-visit-delivery.js`, which
    // `index.js` reaches, so that gate was in neither the contract nor the
    // baseline and this test passed (#6342 r9). Three such collisions were
    // live. A union over-attributes when two unrelated helpers share a name,
    // which costs a baseline entry; dropping one loses the gate.
    const reachable = new Map([...base.gates].map(([fn, gates]) => [fn, [...gates]]));
    const opaqueHelpers = new Set(base.opaque);
    const edges = new Map([...base.calls].map(([fn, to]) => [fn, new Set(to)]));
    const moduleScopeGates = new Set();
    const bindings = requireBindings(routePath, stripComments(source));
    for (const mod of requiredLocalModules(routePath, stripComments(source))) {
      const {
        gates: modGates, opaque, calls, moduleGates, moduleOpaque, exports: exportBindings,
      } = helpersOf(mod, keys);
      // `config/feature-gates.js` is excluded on purpose: its module scope IS
      // the key table every file requires, read textually by `keyToGate`, not
      // a consumer's gate check.
      if (!mod.endsWith(path.join('config', 'feature-gates.js'))) {
        for (const g of moduleGates) moduleScopeGates.add(g);
        // A require-time read that does not decode is reported against the file
        // that requires it, which is the only place it can be acted on.
        if (moduleOpaque) {
          unreadable.push(`${file}: ${path.relative(SERVER_ROOT, mod)} reads a gate at module scope that does not resolve to a GATE_*`);
        }
      }
      // An export rename becomes an edge, so the fixed point below carries both
      // the gates and the opacity across it: the exported name for any importer
      // (`m.publicGuard()`), and this route's own local name for a rename
      // (`const pg = require('./guard')`, `{ publicGuard: pg }`).
      for (const [exported, impl] of exportBindings) {
        if (exported === DEFAULT_EXPORT || exported === impl) continue;
        if (!edges.has(exported)) edges.set(exported, new Set());
        edges.get(exported).add(impl);
      }
      for (const binding of bindings) {
        if (binding.path !== mod) continue;
        const impl = exportBindings.get(binding.exported);
        if (!impl || impl === binding.local) continue;
        if (!edges.has(binding.local)) edges.set(binding.local, new Set());
        edges.get(binding.local).add(impl);
      }
      for (const [fn, gates] of modGates) {
        const prev = reachable.get(fn);
        if (!prev) reachable.set(fn, [...gates]);
        else for (const g of gates) if (!prev.includes(g)) prev.push(g);
      }
      for (const fn of opaque) opaqueHelpers.add(fn);
      for (const [fn, to] of calls) {
        if (!edges.has(fn)) edges.set(fn, new Set(to));
        else for (const t of to) edges.get(fn).add(t);
      }
    }
    // Re-run the fixed point now that every module's names and edges sit in one
    // place, so a delegation that crosses a module boundary resolves.
    propagate(reachable, opaqueHelpers, edges);
    const unresolved = [];
    const used = gatesUsedBy(
      source, keys, reachable, identifierValues(routePath, stripComments(source)),
      unresolved, file, opaqueHelpers,
    );
    // A module-scope read runs on require, so it counts for this file.
    for (const gate of moduleScopeGates) if (!used.has(gate)) used.set(gate, gate);
    for (const expr of new Set(unresolved)) {
      unreadable.push(`${file}: ${expr} does not resolve to a GATE_*`);
    }
    const allowed = new Set(baseline[file] || []);
    for (const gate of allowed) {
      if (!used.has(gate)) stale.push(`${file}: ${gate} is no longer read there — drop the baseline entry`);
      else if (documentsGate(doc, gate, used.get(gate))) stale.push(`${file}: ${gate} is documented now — drop the baseline entry`);
    }
    for (const [gate, alias] of used) {
      if (documentsGate(doc, gate, alias)) continue;
      if (allowed.has(gate)) continue;
      added.push(`${file}: ${gate} (read as \`${alias}\`) is not named in docs/public-route-contracts.md`);
    }
  }

  // A baseline key for a file this scan never visited is checked by nothing:
  // the loop above only consults `baseline[file]` for files it visits, so an
  // entry whose route was deleted, renamed, or newly classified as
  // authenticated survives forever — and silently re-exempts that gate if the
  // filename is ever reused (#6342 r13). Every key must be earned by a file in
  // the set, the same rule the entries themselves already live under.
  for (const file of Object.keys(baseline)) {
    if (!visited.has(file)) {
      stale.push(`${file}: not in the scanned set — the whole baseline entry is orphaned, remove it`);
    }
  }

  expect(added.length
    ? `Document the gate's on/off behavior in that route's entry in docs/public-route-contracts.md in the same PR (AGENTS.md "Public route surface" — undocumented is P0):\n  ${added.sort().join('\n  ')}`
    : '').toBe('');

  // A gate read this resolver cannot decode would otherwise read as no gate at
  // all, which is how four rounds of blind spots stayed green.
  expect(unreadable.length
    ? `A gate read could not be resolved, so it would silently count as no gate:\n  ${unreadable.sort().join('\n  ')}`
    : '').toBe('');

  // A baseline entry that is no longer earned is a standing exemption; it goes
  // in the PR that earned its removal, so the floor can only tighten.
  expect(stale.length
    ? `Stale entries in ${path.basename(BASELINE_PATH)} — remove them in this PR:\n  ${stale.sort().join('\n  ')}`
    : '').toBe('');
});
