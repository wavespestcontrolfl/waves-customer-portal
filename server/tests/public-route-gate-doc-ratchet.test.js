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
 * The definition side stays textual — the `feature-gates.js` table, helper
 * bodies, exported key constants. Every one of the six findings was on the read
 * side; if one lands on a definition, that half moves to the AST too.
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
 * same file are not (#6342 r5 security). Scanning a non-public file costs only a
 * baseline entry; dropping a public one costs the whole point of the test.
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
  for (const m of gatesSource.matchAll(/^\s*([a-zA-Z0-9_]+)\s*:\s*(.*GATE_[A-Z0-9_]+.*)$/gm)) {
    const gates = [...new Set(m[2].match(/GATE_[A-Z0-9_]+/g) || [])];
    if (gates.length && !map.has(m[1])) map.set(m[1], gates);
  }
  return map;
}

// `function fooLive() { return process.env.GATE_X === 'true'; }` (or gateEnvValue /
// isEnabled) → fooLive ⇒ [GATE_X]
function helperToGates(gatesSource, keys) {
  const map = new Map();
  for (const m of gatesSource.matchAll(/function\s+([a-zA-Z0-9_]+)\s*\([^)]*\)\s*\{([\s\S]{0,400}?)\n\}/g)) {
    const body = m[2];
    const direct = body.match(/GATE_[A-Z0-9_]+/g) || [];
    const viaKey = [...body.matchAll(/isEnabled\(\s*'([a-zA-Z0-9_]+)'/g)]
      .flatMap((k) => keys.get(k[1]) || []);
    const gates = [...new Set([...direct, ...viaKey])];
    if (gates.length) map.set(m[1], gates);
  }
  return map;
}

// GATE_* ⇒ the alias the route actually wrote, so "documented" can be checked
// against the name a reader would search for. Reads are taken from the AST.
function gatesUsedBy(source, keys, helpers, idents = new Map(), unresolved = [], filename = 'route.js') {
  const used = new Map();
  const note = (gate, alias) => { if (gate && !used.has(gate)) used.set(gate, alias); };
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

  // Every value the expression can take must resolve to a gate; the condition of
  // a ternary is not one of them. Returns false when any branch cannot resolve.
  const resolveArg = (node, alias) => {
    if (!node) return false;
    if (node.type === 'StringLiteral') {
      const gates = keys.get(node.value);
      if (!gates) return false;
      for (const g of gates) note(g, node.value);
      return true;
    }
    if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
      return resolveArg({ type: 'StringLiteral', value: node.quasis[0].value.cooked }, alias);
    }
    if (node.type === 'Identifier') {
      const key = idents.get(node.name);
      const gates = key ? keys.get(key) : null;
      if (!gates) return false;
      for (const g of gates) note(g, key);
      return true;
    }
    if (node.type === 'ConditionalExpression') {
      return resolveArg(node.consequent, alias) && resolveArg(node.alternate, alias);
    }
    if (node.type === 'LogicalExpression') {
      return resolveArg(node.left, alias) && resolveArg(node.right, alias);
    }
    return false;
  };

  const src = (node) => source.slice(node.start, node.end).replace(/\s+/g, ' ').slice(0, 120);

  const visit = (node) => {
    if (!node || typeof node.type !== 'string') return;
    if (isCall(node)) {
      const name = calleeName(node.callee);
      if (name === 'isEnabled') {
        if (!resolveArg(node.arguments[0], null)) unresolved.push(src(node));
      } else if (name === 'gateEnvValue') {
        const arg = node.arguments[0];
        if (arg && arg.type === 'StringLiteral' && /^GATE_[A-Z0-9_]+$/.test(arg.value)) note(arg.value, arg.value);
        else unresolved.push(src(node));
      } else if (name && helpers.has(name)) {
        for (const g of helpers.get(name)) note(g, name);
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

// Parsing a module is memoised by path: 75 routes reach 473 distinct modules
// through 1,566 requires, so the naive loop re-read 180 MB (feature-gates.js 82
// times) and regexed all of it. This test shares a jest worker pool with
// timing-sensitive suites in the same shard — sms-label-facts.js asserts
// sub-quadratic SCALING — so its own CPU burst is not free. Cached: 473 reads.
function helperCache() {
  const cache = new Map();
  return (modPath, keys) => {
    if (!cache.has(modPath)) {
      cache.set(modPath, helperToGates(stripComments(fs.readFileSync(modPath, 'utf8')), keys));
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

function publicRouteFiles() {
  return fs.readdirSync(ROUTES_DIR)
    .filter((f) => f.endsWith('.js') && !f.includes('.test.'))
    .filter((f) => {
      if (NAME_PATTERNS.some((r) => r.test(f))) return true;
      const code = stripComments(fs.readFileSync(path.join(ROUTES_DIR, f), 'utf8'));
      return !ROUTER_LEVEL_AUTH.test(code);
    })
    .sort();
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
  const gatesSource = stripComments(fs.readFileSync(GATES_FILE, 'utf8'));
  const keys = keyToGate(gatesSource);
  const helpers = helperToGates(gatesSource, keys);
  const doc = fs.readFileSync(CONTRACTS_DOC, 'utf8');

  // Every resolver input is load-bearing: if one stops parsing, the gates it
  // resolves silently read as "no gate used" and this ratchet passes on a diff
  // it should fail. Floors, not exact counts, so ordinary growth is free.
  expect(keys.size).toBeGreaterThan(100);
  expect(helpers.size).toBeGreaterThan(100);

  const helpersOf = helperCache();
  const added = [];
  const stale = [];
  const unreadable = [];
  for (const file of publicRouteFiles()) {
    const routePath = path.join(ROUTES_DIR, file);
    const source = fs.readFileSync(routePath, 'utf8');
    const reachable = new Map(helpers);
    for (const mod of requiredLocalModules(routePath, stripComments(source))) {
      for (const [fn, gates] of helpersOf(mod, keys)) {
        if (!reachable.has(fn)) reachable.set(fn, gates);
      }
    }
    const unresolved = [];
    const used = gatesUsedBy(source, keys, reachable, identifierValues(routePath, stripComments(source)), unresolved, file);
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
