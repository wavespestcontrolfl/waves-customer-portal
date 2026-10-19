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
const ROUTE_REGISTRATION = /router\.(?:get|post|put|patch|delete|all)\(/g;

const stripComments = (source) => source
  .split('\n')
  .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
  .join('\n');

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
function resolveGateArg(node, keys, lookup) {
  if (!node) return null;
  if (node.type === 'StringLiteral') {
    const gates = keys.get(node.value);
    return gates ? gates.map((g) => [g, node.value]) : null;
  }
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
    return resolveGateArg({ type: 'StringLiteral', value: node.quasis[0].value.cooked }, keys, lookup);
  }
  if (node.type === 'Identifier') {
    const key = lookup(node.name);
    const gates = key ? keys.get(key) : null;
    return gates ? gates.map((g) => [g, key]) : null;
  }
  if (node.type === 'ConditionalExpression' || node.type === 'LogicalExpression') {
    const [a, b] = node.type === 'ConditionalExpression'
      ? [node.consequent, node.alternate] : [node.left, node.right];
    const left = resolveGateArg(a, keys, lookup);
    const right = left && resolveGateArg(b, keys, lookup);
    return left && right ? [...left, ...right] : null;
  }
  return null;
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
  if (!GATE_MENTION.test(source)) return { gates: map, opaque, calls: new Map() };
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
    return { gates: map, opaque, calls: new Map() };
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
  const attribute = (gates) => {
    if (!gates.length) return;
    for (const name of stack) {
      const prev = map.get(name);
      if (!prev) map.set(name, [...new Set(gates)]);
      else for (const g of gates) if (!prev.includes(g)) prev.push(g);
    }
  };
  const markOpaque = () => { for (const name of stack) opaque.add(name); };
  // An edge is any REFERENCE to a name, not only a call of it. This codebase
  // injects dependencies by default parameter — `scheduleRecovery(cron, { sweep
  // = sweepAbandonedDeliveries } = {})` calls it as `sweep(...)`, so following
  // calls alone found no path from `scheduleRecovery` to the gate its sweep
  // reads, and `index.js` (which calls only `scheduleRecovery`) resolved none
  // of `GATE_LAWN_DELIVERY_RECOVERY` (#6342 r9). Referencing a gated function
  // is enough to be gated by it; a reference that is never invoked
  // over-attributes, which costs a baseline entry, and following calls only
  // loses the gate.
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
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
      // `featureGates.isEnabled('treatmentZoneMap')` is the same read as the
      // bare call, and taking only Identifier callees meant
      // `treatmentZonePdfSignature()` contributed nothing and was not even
      // marked opaque, hiding `GATE_TREATMENT_ZONE_MAP` from
      // `reports-public.js` (#6342 r10). The route-side walker already took
      // member callees; this half did not.
      const c = node.callee;
      const callee = !c ? null
        : (c.type === 'Identifier' ? c.name
          : ((c.type === 'MemberExpression' || c.type === 'OptionalMemberExpression')
            && c.property && c.property.type === 'Identifier' ? c.property.name : null));
      if (callee === 'isEnabled' && node.arguments.length) {
        const resolved = resolveGateArg(node.arguments[0], keys, (n) => consts.get(n));
        if (resolved) attribute(resolved.map(([g]) => g));
        else markOpaque();
      }
    }
    if (node.type === 'Identifier') noteRef(node.name);

    for (const key of Object.keys(node)) {
      if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments') continue;
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
  return { gates: map, opaque, calls };
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

  const calleeName = (node) => {
    if (!node) return null;
    if (node.type === 'Identifier') return node.name;
    if (isMember(node) && node.property && node.property.type === 'Identifier') {
      return node.property.name;
    }
    return null;
  };

  const resolveArg = (node) => {
    const resolved = resolveGateArg(node, keys, (n) => idents.get(n));
    if (!resolved) return false;
    for (const [gate, key] of resolved) note(gate, key);
    return true;
  };

  const src = (node) => source.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 120);

  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (isCall(node)) {
      const name = calleeName(node.callee);
      // `techNotices.isEnabled()` is an unrelated method that happens to share
      // the name; with no argument there is no gate to name, so it is neither a
      // read nor something to report.
      if (name === 'isEnabled' && node.arguments.length) {
        if (!resolveArg(node.arguments[0])) unresolved.push(src(node));
      } else if (name === 'gateEnvValue') {
        const arg = node.arguments[0];
        if (arg && arg.type === 'StringLiteral' && /^GATE_[A-Z0-9_]+$/.test(arg.value)) note(arg.value, arg.value);
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
    if (isMember(node) && node.property && node.property.type === 'Identifier') {
      const objectIsGates = isMember(node.object)
        && node.object.property && node.object.property.name === 'gates';
      if (objectIsGates) {
        const gates = keys.get(node.property.name);
        if (gates) for (const g of gates) note(g, node.property.name);
        else unresolved.push(src(node));
      }
      if (isMember(node.object)
        && node.object.object && node.object.object.type === 'Identifier'
        && node.object.object.name === 'process'
        && node.object.property && node.object.property.name === 'env'
        && /^GATE_[A-Z0-9_]+$/.test(node.property.name)) {
        note(node.property.name, node.property.name);
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
function requiredLocalModules(routeFile, code) {
  const out = [];
  for (const m of code.matchAll(/require\(\s*'(\.[^']+)'\s*\)/g)) {
    const base = path.resolve(path.dirname(routeFile), m[1]);
    for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
      if (candidate.startsWith(SERVER_ROOT) && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        out.push(candidate);
        break;
      }
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
  const destructured = /\{\s*([A-Za-z_$][\w$,:\s]*?)\s*\}\s*=\s*require\(\s*'(\.[^']+)'\s*\)/g;
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

  for (const [file, routePath] of publicRouteFiles()) {
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
    for (const mod of requiredLocalModules(routePath, stripComments(source))) {
      const { gates: modGates, opaque, calls } = helpersOf(mod, keys);
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
