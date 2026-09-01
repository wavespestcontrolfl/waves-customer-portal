/**
 * Public-route allowlist — mechanical enforcement of the AGENTS.md rule:
 * "New public routes outside this list are P0."
 *
 * Until now that rule was prose only. This test recomputes the app's real
 * unauthenticated surface with a static scan of server/index.js and every
 * router it mounts (server/tests/route-surface/scan.js — no require of app
 * code, no DB, no network) and asserts it equals
 * server/config/public-route-allowlist.json EXACTLY, in both directions:
 *
 *   - a route reachable without a recognised auth guard that is missing from
 *     the allowlist FAILS (new public route — a P0 unless deliberately
 *     reviewed and allowlisted with a reason);
 *   - an allowlist entry whose route no longer exists, or is no longer
 *     public, also FAILS (stale allowlist — remove the entry).
 *
 * "Recognised auth guard" is itself a checked-in list,
 * server/config/route-auth-guards.json: an unlisted or anonymous middleware
 * NEVER counts as auth (fail closed), so introducing a new auth middleware
 * is an explicit, reviewed change to that registry.
 */

const fs = require('fs');
const path = require('path');
const {
  Scanner,
  allowlistKeys,
  routeKey,
  GUARD_REGISTRY_FILE,
} = require('./route-surface/scan');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ALLOWLIST_FILE = 'server/config/public-route-allowlist.json';

function fmtRoute(r) {
  return `${r.method} ${r.path}${r.extra ? ` (${r.extra})` : ''}  [${r.router} @ ${r.mount}, ${r.loc}]`;
}

describe('public-route allowlist (AGENTS.md: "New public routes outside this list are P0.")', () => {
  let result;
  let allowKeys;

  beforeAll(() => {
    result = new Scanner().scan();
    const doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ALLOWLIST_FILE), 'utf8'));
    allowKeys = allowlistKeys(doc); // throws on duplicate entries or a missing reason
  }, 60000);

  test('the scanner can account for every mount and route (no problems)', () => {
    // A problem here means the route surface has a shape the scanner cannot
    // prove safe (unresolvable path on an unguarded route, a guard registered
    // inside a conditional, router.route() chains, ...). Fix the route file to
    // use the supported, provable shapes — do not weaken the scanner.
    expect(result.problems).toEqual([]);
  });

  test('every route reachable without a recognised auth guard is allowlisted', () => {
    const extras = result.publicRoutes.filter((r) => !allowKeys.has(routeKey(r)));
    const message = extras.length === 0 ? '' : [
      'NEW PUBLIC ROUTE(S) — not in the allowlist:',
      ...extras.map((r) => `  - ${fmtRoute(r)}`),
      '',
      'AGENTS.md: "New public routes outside this list are P0." Any HTTP route',
      'reachable WITHOUT authentication must be a deliberate, reviewed decision.',
      'Either:',
      '  1. add an auth guard from server/config/route-auth-guards.json to the',
      '     route or its mount (a new auth middleware must be registered there',
      '     first — unlisted middleware deliberately counts as NOT auth), or',
      `  2. after owner review and sign-off, add the route to ${ALLOWLIST_FILE}`,
      '     under its router+mount entry WITH a one-line reason.',
      '',
      'Compare surfaces with: node server/tests/route-surface/scan.js',
    ].join('\n');
    expect(message).toBe('');
  });

  test('every allowlist entry still exists and is still public (no stale entries)', () => {
    const liveKeys = new Set(result.publicRoutes.map(routeKey));
    const stale = [...allowKeys.keys()].filter((k) => !liveKeys.has(k));
    const message = stale.length === 0 ? '' : [
      'STALE ALLOWLIST ENTRY(IES) — no longer a live public route:',
      ...stale.map((k) => `  - ${k}`),
      '',
      `The route was removed, renamed, or gained an auth guard. Remove the entry`,
      `from ${ALLOWLIST_FILE} so the allowlist stays an exact inventory of the`,
      'public surface (a stale entry could silently readmit a route later).',
      '',
      'Compare surfaces with: node server/tests/route-surface/scan.js',
    ].join('\n');
    expect(message).toBe('');
  });

  test('the public surface is non-trivial (scanner is actually seeing the app)', () => {
    // Guards against a scanner regression that "passes" by seeing nothing.
    expect(result.routes.length).toBeGreaterThan(500);
    expect(result.publicRoutes.length).toBeGreaterThan(50);
    expect(result.publicRoutes.length).toBeLessThan(result.routes.length / 2);
  });
});

describe('auth-guard registry (server/config/route-auth-guards.json)', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, GUARD_REGISTRY_FILE), 'utf8'));

  test('every registered guard and passthrough resolves to a real identifier in its module', () => {
    // Package passthroughs (module = an npm package name) have no repo file
    // to resolve against — the scanner matches them by require() specifier.
    const fileEntries = [...registry.guards, ...(registry.passthroughs || []).filter((p) => !p.package)];
    for (const g of fileEntries) {
      const file = path.join(REPO_ROOT, g.module);
      expect({ guard: g.name, exists: fs.existsSync(file) }).toEqual({ guard: g.name, exists: true });
      const src = fs.readFileSync(file, 'utf8');
      // Local guards are declared in the route file; exported guards must be
      // defined (not merely imported) in the middleware module.
      const defined = new RegExp(
        `(function\\s+${g.name}\\b|(const|let|var)\\s+${g.name}\\b|(async\\s+)?function\\s+${g.name}\\b)`
      ).test(src);
      expect({ guard: g.name, module: g.module, defined }).toEqual({ guard: g.name, module: g.module, defined: true });
      // A 4-arity middleware is an ERROR handler to Express — it is skipped
      // on ordinary requests, so a GUARD refactored to (err, req, res, next)
      // would silently stop guarding while staying registry-credited.
      // Passthroughs are exempt: a reviewed error shaper is 4-arity by
      // design and skipping it cannot weaken auth.
      if (!g.factory && registry.guards.includes(g)) {
        const pm = src.match(new RegExp(`function\\s+${g.name}\\s*\\(([^)]*)\\)`))
          || src.match(new RegExp(`(?:const|let|var)\\s+${g.name}\\s*=\\s*(?:async\\s*)?function[^(]*\\(([^)]*)\\)`))
          || src.match(new RegExp(`(?:const|let|var)\\s+${g.name}\\s*=\\s*(?:async\\s*)?\\(([^)=]*)\\)\\s*=>`));
        if (pm) {
          const arity = pm[1].trim() ? pm[1].split(',').length : 0;
          expect({ guard: g.name, errorHandlerShaped: arity >= 4 })
            .toEqual({ guard: g.name, errorHandlerShaped: false });
        }
      }
      // The export must be the SAME-NAMED value — `module.exports = {
      // adminAuthenticate: noop }` would keep the definition check green
      // while runtime Express receives the no-op. Local entries are consumed
      // in-file and are not exported.
      if (!g.local) {
        const honestExport = new RegExp(
          `module\\.exports\\s*=\\s*\\{[^}]*\\b${g.name}\\b\\s*(?::\\s*${g.name}\\b)?\\s*[,}]`, 's'
        ).test(src) || new RegExp(`module\\.exports\\.${g.name}\\s*=\\s*${g.name}\\b`).test(src);
        expect({ guard: g.name, module: g.module, honestExport }).toEqual({ guard: g.name, module: g.module, honestExport: true });
        // ...and that export must be FINAL: a later `module.exports.<name> =
        // noop`, a second wholesale `module.exports =` assignment, or an
        // Object.assign over module.exports could replace the guard after
        // the honest-looking export this regex matched.
        const memberRewrites = [...src.matchAll(new RegExp(`module\\.exports\\.${g.name}\\s*=\\s*(\\w+)`, 'g'))]
          .map((x) => x[1]).filter((v) => v !== g.name);
        const wholesale = (src.match(/module\.exports\s*=[^=]/g) || []).length;
        const assignOver = /Object\.assign\(\s*module\.exports/.test(src);
        // A COMPUTED export write (`module.exports['name'] = noop`) is the
        // same rewrite in a spelling the regexes above cannot see — a guard
        // module may not contain one at all (fail closed). Ditto descriptor
        // APIs (`Object.defineProperty(module.exports, ...)`) and
        // Reflect.set, which rewrite exports without any `=` spelling.
        const computedExportWrites = (src.match(/module\.exports\s*\[/g) || []).length;
        const descriptorWrites = /(Object\.define(Property|Properties)|Reflect\.(set|defineProperty))\s*\(\s*module\.exports/.test(src);
        expect({ guard: g.name, module: g.module, memberRewrites, wholesale, assignOver, computedExportWrites, descriptorWrites })
          .toEqual({ guard: g.name, module: g.module, memberRewrites: [], wholesale: 1, assignOver: false, computedExportWrites: 0, descriptorWrites: false });
        // ...and the BINDING itself must never be reassigned before export
        // (`adminAuthenticate = noop; module.exports = { adminAuthenticate }`
        // would pass every check above while exporting the no-op).
        const reassignedLines = src.split('\n').filter((line) =>
          new RegExp(`(^|[^.\\w$'"\`])${g.name}\\s*=[^=>]`).test(line)
          && !new RegExp(`(const|let|var|function)\\s+(async\\s+)?${g.name}\\b`).test(line)
          && !/module\.exports/.test(line)
          && !new RegExp(`${g.name}\\s*:`).test(line));
        expect({ guard: g.name, module: g.module, reassignedLines })
          .toEqual({ guard: g.name, module: g.module, reassignedLines: [] });
        // ...including DESTRUCTURING reassignments (`[name] = [noop]`,
        // `({ name } = source)`) — assignment-pattern targets rebind without
        // a bare `name =` spelling. Declarations create new bindings and are
        // exempt; any other line putting the name inside a bracketed target
        // followed by `=` fails.
        const destructuredReassigned = src.split('\n').filter((line) =>
          !/^\s*(const|let|var)\b/.test(line)
          && new RegExp(`[\\[{][^\\]}]*\\b${g.name}\\b[^\\]}]*[\\]}]\\s*=[^=]`).test(line));
        expect({ guard: g.name, module: g.module, destructuredReassigned })
          .toEqual({ guard: g.name, module: g.module, destructuredReassigned: [] });
      }
    }
  });

  test("adminAuthenticateExceptOauthCallback's runtime exemption set matches its registry exempts", () => {
    // The guard lets through req.path values in OAUTH_PUBLIC_PATHS (GET only).
    // The registry's exempts must mirror that set EXACTLY — a path added to
    // the runtime Set without a registry (and allowlist) update would be an
    // untracked public route the scanner still reports as authenticated.
    const src = fs.readFileSync(path.join(REPO_ROOT, 'server/routes/admin-email.js'), 'utf8');
    const m = src.match(/OAUTH_PUBLIC_PATHS\s*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(m).not.toBeNull();
    // The initializer must be the ONLY source of members: a later mutation
    // (`OAUTH_PUBLIC_PATHS.add(...)`) would widen the runtime exemption
    // invisibly to this comparison. Only .has() reads are allowed.
    const mutations = [...src.matchAll(/OAUTH_PUBLIC_PATHS\s*\.\s*(\w+)/g)]
      .map((x) => x[1]).filter((method) => method !== 'has');
    expect(mutations).toEqual([]);
    // EVERY occurrence must be the declaration or a .has() read — an alias
    // (`const paths = OAUTH_PUBLIC_PATHS`), a borrowed mutator, or passing
    // the Set to any function could widen the exemption invisibly.
    const occurrences = [...src.matchAll(/OAUTH_PUBLIC_PATHS/g)].length;
    const hasReads = [...src.matchAll(/OAUTH_PUBLIC_PATHS\s*\.\s*has\s*\(/g)].length;
    expect({ occurrences, accountedFor: 1 + hasReads }).toEqual({ occurrences: 1 + hasReads, accountedFor: 1 + hasReads });
    const runtimePaths = [...m[1].matchAll(/'([^']+)'|"([^"]+)"/g)].map((x) => x[1] || x[2]).sort();
    const guard = registry.guards.find((g) => g.name === 'adminAuthenticateExceptOauthCallback');
    expect(guard).toBeDefined();
    const exemptPaths = (guard.exempts || []).map((e) => {
      const [method, p] = e.split(/\s+/);
      expect(method).toBe('GET'); // the guard's carve-out is GET-only
      return p;
    }).sort();
    expect(exemptPaths).toEqual(runtimePaths);
  });

  test('exempted paths on guards are themselves allowlisted', () => {
    const doc = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, ALLOWLIST_FILE), 'utf8'));
    for (const g of registry.guards) {
      for (const e of g.exempts || []) {
        const [method, rel] = e.split(/\s+/);
        // The exempted route must appear (by trailing path segment match) in
        // the allowlist for the same router file — an exemption that is not
        // allowlisted would be an untracked public route.
        const hit = doc.mounts.some((m) => m.router === g.module
          && m.routes.some((r) => r.startsWith(`${method} `) && r.endsWith(rel)));
        expect({ guard: g.name, exempt: e, allowlisted: hit }).toEqual({ guard: g.name, exempt: e, allowlisted: true });
      }
    }
  });
});

describe('scanner semantics — fail closed (virtual app fixtures)', () => {
  const REGISTRY = {
    guards: [
      { name: 'guardA', module: 'server/middleware/a.js' },
      { name: 'makeGuard', module: 'server/middleware/f.js', factory: true },
    ],
  };

  const scanOf = (files) => new Scanner({ files, registry: REGISTRY, appFile: 'server/index.js' }).scan();

  const app = (body) => [
    "const express = require('express');",
    'const app = express();',
    body,
  ].join('\n');

  test('an UNREGISTERED middleware does not count as auth', () => {
    const res = scanOf({
      'server/index.js': app([
        "const someCheck = require('./middleware/unlisted');",
        "app.use('/api/x', someCheck, require('./routes/x'));",
      ].join('\n')),
      'server/middleware/unlisted.js': 'module.exports = function someCheck(req, res, next) { next(); };',
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/thing']);
  });

  test('an ANONYMOUS inline wrapper around a real guard does not count as auth', () => {
    const res = scanOf({
      'server/index.js': app([
        "const { guardA } = require('./middleware/a');",
        "app.use('/api/x', (req, res, next) => guardA(req, res, next), require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    // The wrapper itself is also inventoried as scoped USE surface — it is
    // unproven middleware that runs for every request under /api/x.
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['GET /api/x/thing', 'USE /api/x']);
  });

  test('a REGISTERED guard on the mount protects every route under it', () => {
    const res = scanOf({
      'server/index.js': app([
        "const { guardA } = require('./middleware/a');",
        "app.use('/api/x', guardA, require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        "router.post('/other', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes).toEqual([]);
  });

  test('router.use(guard) protects only routes registered AFTER it (source order)', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        "router.get('/before', (req, res) => res.json({}));",
        'router.use(guardA);',
        "router.get('/after', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/before']);
  });

  test('a guard registered inside a CONDITIONAL is not counted and is reported', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        "if (process.env.NODE_ENV === 'production') { router.use(guardA); }",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/thing']);
    expect(res.problems.some((p) => p.includes('conditional'))).toBe(true);
  });

  test('a guard AFTER the router in app.use does not protect it (middleware order)', () => {
    const res = scanOf({
      'server/index.js': app([
        "const { guardA } = require('./middleware/a');",
        "app.use('/api/x', require('./routes/x'), guardA);",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/thing']);
  });

  test('a guard preceded by ANY unregistered handler is voided (it may never run)', () => {
    // `router.get('/x', publicHandler, guardA, realHandler)` — publicHandler
    // can respond before guardA ever runs, so guardA proves nothing. Only a
    // guard whose entire prefix is guards/registered passthroughs counts.
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        'const limiter = (req, res, next) => next();',
        "router.get('/late-guard', (req, res) => res.json({}), guardA);",
        "router.get('/voided', limiter, guardA, (req, res) => res.json({}));",
        "router.get('/guarded', guardA, limiter, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['GET /api/x/late-guard', 'GET /api/x/voided']);
  });

  test('a REGISTERED passthrough before a guard does not void it; unregistered does', () => {
    const files = (registerIt) => ({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        "function devOnly(req, res, next) { if (process.env.NODE_ENV === 'production') return res.status(404).end(); next(); }",
        "router.post('/thing', devOnly, guardA, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    const registry = (passthroughs) => ({ ...REGISTRY, passthroughs });
    const withReg = new Scanner({
      files: files(true), appFile: 'server/index.js',
      registry: registry([{ name: 'devOnly', module: 'server/routes/x.js', local: true }]),
    }).scan();
    expect(withReg.publicRoutes).toEqual([]);
    const withoutReg = new Scanner({ files: files(false), appFile: 'server/index.js', registry: registry([]) }).scan();
    expect(withoutReg.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/x/thing']);
  });

  test('an opaque use() handler (in-repo factory call) is a reported problem, never silence', () => {
    // `app.use('/api/new', buildRouter())` — the factory could return a
    // router whose routes would silently bypass the allowlist.
    const res = scanOf({
      'server/index.js': app([
        "const { buildRouter } = require('./routes/factory');",
        "app.use('/api/new', buildRouter());",
      ].join('\n')),
      'server/routes/factory.js': [
        "function buildRouter() { const r = require('express').Router(); r.get('/leak', (req, res) => res.json({})); return r; }",
        'module.exports = { buildRouter };',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('is not a router'))).toBe(true);
  });

  test('package factories are OPAQUE unless registry-reviewed; inline/in-repo functions are middleware', () => {
    // A package factory (cors, rateLimit) CAN return a router, so an
    // UNREVIEWED one in use() is a problem; a reviewed package passthrough
    // is silent, and an inline function is provably-not-a-router middleware
    // (inventoried as USE surface, never a problem).
    const files = {
      'server/index.js': app([
        "const cors = require('cors');",
        "const rateLimit = require('express-rate-limit');",
        'const limiter = rateLimit({ max: 5 });',
        'app.use(cors({}));',
        "app.use('/api', limiter);",
        'app.use((req, res, next) => next());',
        "app.use('/api/x', require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    };
    const unreviewed = scanOf(files);
    expect(unreviewed.problems.filter((p) => p.includes('unreviewed package factory')).length).toBe(2);
    const reviewed = new Scanner({
      files, appFile: 'server/index.js',
      registry: {
        ...REGISTRY,
        passthroughs: [
          { name: '*', module: 'cors', package: true },
          { name: '*', module: 'express-rate-limit', package: true },
        ],
      },
    }).scan();
    expect(reviewed.problems).toEqual([]);
    // Only the inline fn remains inventoried (pathless, scope '/').
    expect(reviewed.publicRoutes.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['GET /api/x/thing', 'USE /']);
  });

  test('PATHLESS terminal middleware is inventoried as USE / surface', () => {
    const res = scanOf({
      'server/index.js': app("app.use((req, res) => res.json({ secret: 1 }));"),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['USE /']);
  });

  test('a fluent chain preserves EXECUTION order (get before chained use(guard))', () => {
    // router.get('/leak', h).use(guardA) runs the get() FIRST — the chained
    // guard must not retroactively protect it.
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        "router.get('/leak', (req, res) => res.json({})).use(guardA);",
        "router.get('/after', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('an identifier bound to a string ARRAY in path position expands to its paths', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const PATHS = ['/a', '/leak'];",
        'router.get(PATHS, (req, res) => res.json({}));',
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['GET /api/x/a', 'GET /api/x/leak']);
  });

  test('passing the app or a router to an unanalysed in-repo helper is a reported problem', () => {
    const res = scanOf({
      'server/index.js': app([
        "const { installRoutes } = require('./routes/helper');",
        'installRoutes(app);',
      ].join('\n')),
      'server/routes/helper.js': [
        "function installRoutes(a) { a.get('/leak', (req, res) => res.json({})); }",
        'module.exports = { installRoutes };',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('unanalysed function'))).toBe(true);
  });

  test('registrations through an APP alias (const api = app) are not lost', () => {
    const res = scanOf({
      'server/index.js': app([
        'const api = app;',
        "api.get('/new-public-route', (req, res) => res.json({}));",
      ].join('\n')),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /new-public-route']);
  });

  test('registrations through a router ALIAS are not lost', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'const api = router;',
        "api.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('two loops reusing an enumeration variable name stay separate (lexical scoping)', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "for (const p of ['/a', '/b']) router.get(p, (req, res) => res.json({}));",
        "for (const p of ['/c']) router.post(p, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`).sort()).toEqual([
      'GET /api/x/a', 'GET /api/x/b', 'POST /api/x/c',
    ]);
  });

  test('TERMINAL middleware mounted with a scoped use() is inventoried as USE surface', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/leak', (req, res) => res.json({ secret: 1 }));"),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['USE /api/leak']);
  });

  test('a registered PACKAGE passthrough factory neither voids guards nor inventories USE surface', () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, passthroughs: [{ name: '*', module: 'express-rate-limit', package: true }] },
      files: {
        'server/index.js': app([
          "const rateLimit = require('express-rate-limit');",
          "const { guardA } = require('./middleware/a');",
          "app.use('/api/x', rateLimit({ max: 5 }), guardA, require('./routes/x'));",
        ].join('\n')),
        'server/routes/x.js': [
          "const router = require('express').Router();",
          "router.get('/thing', (req, res) => res.json({}));",
          'module.exports = router;',
        ].join('\n'),
      },
    }).scan();
    expect(res.publicRoutes).toEqual([]);
    expect(res.problems).toEqual([]);
  });

  test('fluent CHAINED registrations are all recorded (router.get(...).post(...))', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/a', (req, res) => res.json({})).post('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['GET /api/x/a', 'POST /api/x/leak']);
  });

  test('a registration chained on an INLINE Router() call is a reported problem', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', express.Router().get('/leak', (req, res) => res.json({})));"),
    });
    expect(res.problems.some((p) => p.includes('inline Router()'))).toBe(true);
  });

  test('an unsupported expression in verb path position is an UNRESOLVED path, not a handler', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const PATHS = { leak: '/leak' };",
        "router.get(PATHS.leak, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    // The route surfaces as unresolved-and-public, which is itself a problem —
    // it can never silently pass as the mount root's existing allowlist entry.
    expect(res.publicRoutes.some((r) => r.path.includes('<unresolved:PATHS.leak>'))).toBe(true);
    expect(res.problems.some((p) => p.includes('unresolvable path'))).toBe(true);
  });

  test('a guard name SHADOWED by a nested redeclaration is never credited', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        'function setup() { const guardA = (req, res, next) => next(); return guardA; }',
        "router.get('/thing', guardA, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/thing']);
  });

  test('every Express HTTP method counts as surface (trace, checkout, ...)', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.trace('/leak', (req, res) => res.json({}));",
        "router.checkout('/leak2', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['CHECKOUT /api/x/leak2', 'TRACE /api/x/leak']);
  });

  test('two indistinguishable public responders sharing one allowlist identity is a problem', () => {
    // A second IDENTICAL anonymous pathless middleware lands on the SAME
    // `USE / (inline function#<digest>)` key as an already-approved one and
    // would reuse its approval — the scanner must refuse identical keys from
    // distinct source locations. (Distinct BODIES get distinct digests and
    // are legitimately distinguishable.)
    const res = scanOf({
      'server/index.js': app([
        'app.use((req, res) => res.json({ a: 1 }));',
        'app.use((req, res) => res.json({ a: 1 }));',
      ].join('\n')),
    });
    expect(res.problems.some((p) => p.includes('share the allowlist identity'))).toBe(true);
  });

  test('path normalization within ONE registration does not trip the duplicate-identity check', () => {
    const res = scanOf({
      'server/index.js': app("app.get(['/thing', '/thing/'], (req, res) => res.json({}));"),
    });
    expect(res.problems).toEqual([]);
  });

  test('a router alias established by ASSIGNMENT is not lost', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'let api;',
        'api = router;',
        "api.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a Router() factory NOT proven to come from Express is not trusted as a router', () => {
    // helper.Router() could return terminal middleware wearing the name; the
    // module then has no provable exported Express router and mounting it is
    // a reported problem instead of silent acceptance.
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const helper = require('../services/router-lookalike');",
        'const router = helper.Router();',
        "router.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/services/router-lookalike.js': [
        'function Router() { return (req, res) => res.json({ secret: 1 }); }',
        'module.exports = { Router };',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('is not a router') || p.includes('no exported Router'))).toBe(true);
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual([]);
  });

  test('registrations through a MEMBER-based router reference (holder.router) are not lost', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'const holder = { router };',
        "holder.router.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a router assigned into an object PROPERTY (holder.api = router) is not lost', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'const holder = {};',
        'holder.api = router;',
        "holder.api.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a REASSIGNED name is never credited as a guard (value depends on execution order)', () => {
    // `let gate = noop; router.get('/leak', gate, h); gate = guardA;` — the
    // live route runs the no-op, so the later guard value must not count.
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        'let gate = (req, res, next) => next();',
        "router.get('/leak', gate, (req, res) => res.json({}));",
        'gate = guardA;',
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a router stored in an object shape the scanner cannot model is a problem', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'const deep = { nested: { router } };',
        'void deep;',
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('object shape the scanner cannot model'))).toBe(true);
  });

  test('a SHADOWED path constant resolves to an unresolved path, never the top-level value', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const PATH = '/approved';",
        "function setup() { const PATH = '/leak'; router.get(PATH, (req, res) => res.json({})); }",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.some((r) => r.path.includes('/approved'))).toBe(false);
    expect(res.problems.some((p) => p.includes('unresolvable path'))).toBe(true);
  });

  test('a nested registration gets NO credit from source-order use() guards', () => {
    // install() runs before router.use(guardA) even though it is DECLARED
    // after it — the scanner must not apply the guard by source position.
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        'install();',
        'router.use(guardA);',
        "function install() { router.get('/leak', (req, res) => res.json({})); }",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
    expect(res.publicRoutes[0].conditional).toBe(true);
  });

  test('a static() NOT proven to come from Express is not trusted', () => {
    const res = scanOf({
      'server/index.js': app([
        "const helper = require('./services/lookalike');",
        "app.use('/files', helper.static('dir'));",
      ].join('\n')),
      'server/services/lookalike.js': [
        'function staticImpl() { return (req, res) => res.json({ secret: 1 }); }',
        'module.exports = { static: staticImpl };',
      ].join('\n'),
    });
    expect(res.routes.some((r) => r.method === 'STATIC')).toBe(false);
    expect(res.problems.some((p) => p.includes('is not a router'))).toBe(true);
  });

  test("a guard's exempts match the path RELATIVE TO WHERE THE GUARD EXECUTES", () => {
    // Guard with an exemption mounted ABOVE a nested router: at runtime the
    // guard sees /oauth/callback even though the route is declared as
    // /callback inside a child mounted at /oauth.
    const registry = {
      guards: [{
        name: 'exceptCallback', module: 'server/middleware/e.js',
        exempts: ['GET /oauth/callback'],
      }],
    };
    const res = new Scanner({
      appFile: 'server/index.js',
      registry,
      files: {
        'server/index.js': app([
          "const { exceptCallback } = require('./middleware/e');",
          "app.use('/api', exceptCallback, require('./routes/parent'));",
        ].join('\n')),
        'server/routes/parent.js': [
          "const parent = require('express').Router();",
          "parent.use('/oauth', require('./child'));",
          'module.exports = parent;',
        ].join('\n'),
        'server/routes/child.js': [
          "const child = require('express').Router();",
          "child.get('/callback', (req, res) => res.json({}));",
          "child.get('/other', (req, res) => res.json({}));",
          'module.exports = child;',
        ].join('\n'),
      },
    }).scan();
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/oauth/callback']);
  });

  test('a CONDITIONAL registration carries its PREDICATE in its allowlist identity', () => {
    // Flipping the predicate (!== to ===) or moving the route to top level
    // changes the key, so the existing approval cannot be reused.
    const res = scanOf({
      'server/index.js': app([
        "if (process.env.NODE_ENV !== 'production') {",
        "  app.get('/debug', (req, res) => res.json({}));",
        '}',
      ].join('\n')),
    });
    expect(res.publicRoutes.map(routeKey))
      .toEqual(["server/index.js @ / :: GET /debug [conditional: process.env.NODE_ENV !== 'production']"]);
  });

  test("a CONDITIONAL router MOUNT makes every descendant route conditional with the mount's predicate", () => {
    const res = scanOf({
      'server/index.js': app([
        "if (process.env.ENABLE_X === 'true') {",
        "  app.use('/api/x', require('./routes/x'));",
        '}',
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map(routeKey)).toEqual([
      "server/routes/x.js @ /api/x :: GET /api/x/thing [conditional: process.env.ENABLE_X === 'true']",
    ]);
  });

  test('an optional-call registration (app?.get) on a known router is a reported problem', () => {
    const res = scanOf({
      'server/index.js': app("app?.get('/leak', (req, res) => res.json({}));"),
    });
    expect(res.problems.some((p) => p.includes('optional-call registration'))).toBe(true);
  });

  test('a PACKAGE helper receiving the app is a problem unless routerConsumers-reviewed', () => {
    const files = {
      'server/index.js': app([
        "const pkg = require('some-installer');",
        'pkg.install(app);',
      ].join('\n')),
    };
    const unreviewed = scanOf(files);
    expect(unreviewed.problems.some((p) => p.includes('unanalysed function'))).toBe(true);
    const reviewed = new Scanner({
      files, appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'install', module: 'some-installer' }] },
    }).scan();
    expect(reviewed.problems).toEqual([]);
  });

  test('the ALTERNATE branch of an if carries negated-polarity identity', () => {
    const res = scanOf({
      'server/index.js': app([
        "if (process.env.NODE_ENV !== 'production') {",
        "  app.get('/debug', (req, res) => res.json({}));",
        '} else {',
        "  app.get('/prod-leak', (req, res) => res.json({}));",
        '}',
      ].join('\n')),
    });
    expect(res.publicRoutes.map(routeKey).sort()).toEqual([
      "server/index.js @ / :: GET /debug [conditional: process.env.NODE_ENV !== 'production']",
      "server/index.js @ / :: GET /prod-leak [conditional: !(process.env.NODE_ENV !== 'production')]",
    ]);
  });

  test('REASSIGNING an object property that held a router is a problem', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'const fallback = (req, res, next) => next();',
        'const holder = {};',
        'holder.api = router;',
        "holder.api.get('/leak', (req, res) => res.json({}));",
        'holder.api = fallback;',
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('holding a router is reassigned'))).toBe(true);
  });

  test('a SHADOWED factory callee is never credited as a guard factory', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { makeGuard } = require('../middleware/f');",
        'function setup() { const makeGuard = () => (req, res, next) => next(); return makeGuard; }',
        "router.get('/leak', makeGuard('scope'), (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('router.all() honors method-specific guard exemptions (ALL covers GET)', () => {
    const registry = {
      guards: [{ name: 'except', module: 'server/middleware/e.js', exempts: ['GET /open'] }],
    };
    const res = new Scanner({
      appFile: 'server/index.js',
      registry,
      files: {
        'server/index.js': app([
          "const { except } = require('./middleware/e');",
          "app.use('/api', except, require('./routes/x'));",
        ].join('\n')),
        'server/routes/x.js': [
          "const router = require('express').Router();",
          "router.all('/open', (req, res) => res.json({}));",
          'module.exports = router;',
        ].join('\n'),
      },
    }).scan();
    // The runtime guard lets GET /open through, so the ALL registration is
    // public surface and must be allowlisted.
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['ALL /api/open']);
  });

  test('a SPREAD path array ([...PATHS]) expands to its paths, never a mount-root handler', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const PATHS = ['/a', '/leak'];",
        'router.get([...PATHS], (req, res) => res.json({}));',
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['GET /api/x/a', 'GET /api/x/leak']);
  });

  test('an identifier-bound MIXED path array (regex + string) expands to its paths', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const PATHS = [/^\\/secret$/, '/other'];",
        'router.get(PATHS, (req, res) => res.json({}));',
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['GET /api/x/other', 'GET /api/x<re:^\\/secret$>']);
  });

  test('two anonymous responders on ONE source line are still distinct locations', () => {
    const res = scanOf({
      'server/index.js': app('app.use((req, res) => res.json({ a: 1 })); app.use((req, res) => res.json({ a: 1 }));'),
    });
    expect(res.problems.some((p) => p.includes('share the allowlist identity'))).toBe(true);
  });

  test("Express's deprecated del() alias registers as DELETE", () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.del('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['DELETE /api/x/leak']);
  });

  test('a module.exports REWRITE clears the stale router export (fail closed)', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/old', (req, res) => res.json({}));",
        'module.exports = router;',
        'module.exports = (req, res) => res.json({ secret: 1 });',
      ].join('\n'),
    });
    // The final export is inline middleware, not a provable router — the
    // mount is rejected instead of scanning the stale router.
    expect(res.problems.some((p) => p.includes('no exported Router'))).toBe(true);
  });

  test('a router stored in an ARRAY literal is a problem (computed access is unattributable)', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'const holders = [router];',
        "holders[0].get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('stored in an array'))).toBe(true);
  });

  test('an inline handler array in a call argument is still legal', () => {
    const res = scanOf({
      'server/index.js': app([
        "const { guardA } = require('./middleware/a');",
        "app.use('/api/x', [guardA, require('./routes/x')]);",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems).toEqual([]);
    expect(res.publicRoutes).toEqual([]);
  });

  test('a predicate longer than 80 chars keeps a content digest in its identity', () => {
    const longCond = "process.env.AAAAAAAAAA === 'x' && process.env.BBBBBBBBBB === 'y' && process.env.CCCCCCCCCC === 'z'";
    const flipped = longCond.replace("'z'", "'Z'");
    const keyOf = (cond) => scanOf({
      'server/index.js': app(`if (${cond}) {\n  app.get('/debug', (req, res) => res.json({}));\n}`),
    }).publicRoutes.map(routeKey)[0];
    const a = keyOf(longCond);
    const b = keyOf(flipped);
    expect(a).toMatch(/…#[0-9a-f]{8}\]$/);
    expect(a).not.toEqual(b); // the edit is past char 80 — only the digest differs
  });

  test('a SHADOWED package object (const express) is never trusted for member provenance', () => {
    const res = scanOf({
      'server/index.js': app([
        'function setup() { const express = { json: () => (req, res) => res.json({ secret: 1 }) }; return express; }',
        'app.use(express.json());',
      ].join('\n')),
    });
    // express is bound at top level (the app() helper) AND shadowed in a
    // block — provenance refuses, and the opaque factory call is a problem.
    expect(res.problems.some((p) => p.includes('express.json'))).toBe(true);
  });

  test('a side-effect module registering on ANOTHER module\'s mounted router is a problem', () => {
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/services/installer.js': [
        "const shared = require('../routes/x');",
        "shared.get('/leak', (req, res) => res.json({}));",
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test("an unproven router.param() callback voids per-route guards on matching routes", () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        "router.param('id', (req, res, next, id) => res.json({ leak: id }));",
        "router.get('/:id', guardA, (req, res) => res.json({}));",
        "router.get('/static', guardA, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    // The param callback answers before guardA on /:id; /static (no param)
    // keeps its guard.
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/:id']);
  });

  test('an array holding a router passed to a NON-registration call is rejected', () => {
    const res = scanOf({
      'server/index.js': app([
        "const { install } = require('./services/installer');",
        "const router = require('express').Router();",
        'install([router]);',
        "app.use('/api/x', router);",
      ].join('\n')),
      'server/services/installer.js': [
        "function install(arr) { arr[0].get('/leak', (req, res) => res.json({})); }",
        'module.exports = { install };',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('stored in an array') || p.includes('unanalysed function'))).toBe(true);
  });

  test('a SPREAD call argument in path position expands (router.get(...arr))', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get(...['/leak', (req, res) => res.json({})]);",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a named module member resolves through the FINAL export mapping, not internal bindings', () => {
    // module.exports = { api: leak } — requiring .api mounts leak at runtime;
    // the guarded internal `api` binding must not be credited.
    const res = scanOf({
      'server/index.js': app([
        "const { api } = require('./routes/multi');",
        "app.use('/api/x', api);",
      ].join('\n')),
      'server/routes/multi.js': [
        "const express = require('express');",
        'const api = express.Router();',
        'const leak = express.Router();',
        "const { guardA } = require('../middleware/a');",
        "api.get('/thing', guardA, (req, res) => res.json({}));",
        "leak.get('/thing', (req, res) => res.json({}));",
        'module.exports = { api: leak };',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/thing']);
  });

  test("a static() root passed as an identifier binds the RESOLVED initializer into the identity", () => {
    const res = scanOf({
      'server/index.js': app([
        "const path = require('path');",
        "const buildDir = path.join(__dirname, 'dist');",
        "app.use('/assets', express.static(buildDir));",
      ].join('\n')),
    });
    expect(res.publicRoutes.map(routeKey)).toEqual([
      "server/index.js @ / :: STATIC /assets (buildDir = path.join(__dirname, 'dist'))",
    ]);
  });

  test("an inline named-export mutation (require('./m').api.get) is rejected", () => {
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/multi').api);",
      ].join('\n')),
      'server/routes/multi.js': [
        "const api = require('express').Router();",
        "api.get('/thing', (req, res) => res.json({}));",
        'module.exports = { api };',
      ].join('\n'),
      'server/services/installer.js': "require('../routes/multi').api.get('/leak', (req, res) => res.json({}));",
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test('a short-circuit registration (cond && app.get) carries operator polarity in its identity', () => {
    const key = (expr) => scanOf({
      'server/index.js': app(`${expr};`),
    }).publicRoutes.map(routeKey)[0];
    const andKey = key("process.env.DEV === 'true' && app.get('/debug', (req, res) => res.json({}))");
    const orKey = key("process.env.DEV === 'true' || app.get('/debug', (req, res) => res.json({}))");
    expect(andKey).toBe("server/index.js @ / :: GET /debug [conditional: process.env.DEV === 'true']");
    expect(orKey).toBe("server/index.js @ / :: GET /debug [conditional: !(process.env.DEV === 'true')]");
  });

  test('a registration RETURN value aliases the router (const api = router.get(...))', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const api = router.get('/a', (req, res) => res.json({}));",
        "api.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`).sort())
      .toEqual(['GET /api/x/a', 'GET /api/x/leak']);
  });

  test('an appOnly routerConsumer receiving a non-app router is a problem', () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'createServer', module: 'http', appOnly: true }] },
      files: {
        'server/index.js': app([
          "const http = require('http');",
          "const leakRouter = require('express').Router();",
          "leakRouter.get('/leak', (req, res) => res.json({}));",
          'http.createServer(leakRouter);',
        ].join('\n')),
      },
    }).scan();
    expect(res.problems.some((p) => p.includes('reviewed to receive only the app'))).toBe(true);
  });

  test('a middleware array MUTATED after its initializer is never trusted', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        'const chain = [guardA];',
        'chain.unshift((req, res) => res.json({ secret: 1 }));',
        "router.get('/leak', chain, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    // The tainted array is opaque — the guard inside it is never credited.
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a server file the side-effect sweep cannot analyze is a problem, never silence', () => {
    const res = scanOf({
      'server/index.js': app("app.get('/ok', (req, res) => res.json({}));"),
      'server/services/broken.js': 'this is not javascript {{{',
    });
    expect(res.problems.some((p) => p.includes('sweep cannot analyze'))).toBe(true);
  });

  test('a CONSTRUCTOR receiving the app (new Installer(app)) is an unanalysed-consumer problem', () => {
    const res = scanOf({
      'server/index.js': app([
        "const { Installer } = require('./services/installer');",
        'new Installer(app);',
      ].join('\n')),
      'server/services/installer.js': [
        "function Installer(a) { a.get('/leak', (req, res) => res.json({})); }",
        'module.exports = { Installer };',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('unanalysed function'))).toBe(true);
  });

  test('a PUBLIC route registered inside a function is a problem (invocation is unknowable)', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'install();',
        "function install() { router.get('/debug', (req, res) => res.json({})); }",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('registered inside a function'))).toBe(true);
  });

  test('overwriting a router registration METHOD (router.use = noop) is a problem; helper exports are not', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'router.use = () => router;',
        'router._test = { helper: 1 };',
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    const methodWrites = res.problems.filter((p) => p.includes('overwriting a router/app registration method'));
    expect(methodWrites.length).toBe(1); // router.use, not router._test
  });

  test('registrations through module.exports itself attribute to the exported router', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'module.exports = router;',
        "module.exports.get('/leak', (req, res) => res.json({}));",
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a SECOND express() app handed to the listener is caught by the appOnly check', () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'createServer', module: 'http', appOnly: true }] },
      files: {
        'server/index.js': app([
          "const http = require('http');",
          'const live = express();',
          "live.get('/leak', (req, res) => res.json({}));",
          'http.createServer(live);',
        ].join('\n')),
      },
    }).scan();
    expect(res.problems.some((p) => p.includes('reviewed to receive only the app'))).toBe(true);
  });

  test('external mutations resolve the target through the FINAL export mapping', () => {
    // module.exports = { api: leak } — mutating .api from outside mutates
    // leak, which is mounted; the internal name `api` does not even exist.
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/multi').api);",
      ].join('\n')),
      'server/routes/multi.js': [
        "const leak = require('express').Router();",
        "leak.get('/thing', (req, res) => res.json({}));",
        'module.exports = { api: leak };',
      ].join('\n'),
      'server/services/installer.js': "require('../routes/multi').api.get('/extra', (req, res) => res.json({}));",
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test('a member-expression argument (install(holder.api)) enters the unanalysed-consumer check', () => {
    const res = scanOf({
      'server/index.js': app([
        "const { install } = require('./services/installer');",
        "const router = require('express').Router();",
        'const holder = { api: router };',
        'install(holder.api);',
        "app.use('/api/x', router);",
      ].join('\n')),
      'server/services/installer.js': [
        "function install(r) { r.get('/leak', (req, res) => res.json({})); }",
        'module.exports = { install };',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('unanalysed function'))).toBe(true);
  });

  test("a directly required factory app (require('express')()) is caught by the appOnly check", () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'createServer', module: 'http', appOnly: true }] },
      files: {
        'server/index.js': app([
          "const http = require('http');",
          "const live = require('express')();",
          "live.get('/leak', (req, res) => res.json({}));",
          'http.createServer(live);',
        ].join('\n')),
      },
    }).scan();
    expect(res.problems.some((p) => p.includes('reviewed to receive only the app'))).toBe(true);
  });

  test('a middleware array mutated through an ALIAS is tainted like a direct mutation', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        'const chain = [guardA];',
        'const alias = chain;',
        'alias.unshift((req, res) => res.json({ secret: 1 }));',
        "router.get('/leak', chain, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    // The alias mutates the same array object — the guard is never credited.
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('an optional-call registration on a REQUIRED router routes through the external sweep', () => {
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/services/installer.js': [
        "const shared = require('../routes/x');",
        "shared?.get('/leak', (req, res) => res.json({}));",
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test('a reassigned router binding is a reported problem, never a guarded route', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const { guardA } = require('../middleware/a');",
        "let router = require('express').Router();",
        'router.use(guardA);',
        "router = require('express').Router();",
        "router.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('assigned more than once'))).toBe(true);
  });

  test('a mutated imported guard property is refused credit AND reported', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const auth = require('../middleware/a');",
        "const router = require('express').Router();",
        'auth.guardA = (req, res, next) => next();',
        "router.get('/leak', auth.guardA, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    // The overwritten export is never credited (route stays public) and the
    // write itself is rejected.
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toContain('GET /api/x/leak');
    expect(res.problems.some((p) => p.includes('overwriting a registered guard'))).toBe(true);
  });

  test('a method-specific exemption on router.all() opens ONLY that method, stamped into the identity', () => {
    // Dropping the guard later yields the bare `ALL /api/open` key — an auth
    // widening always breaks the allowlist match and forces review.
    const registry = {
      guards: [{ name: 'exceptOpen', module: 'server/middleware/e.js', exempts: ['GET /open'] }],
    };
    const res = new Scanner({
      appFile: 'server/index.js',
      registry,
      files: {
        'server/index.js': app([
          "const { exceptOpen } = require('./middleware/e');",
          "app.use('/api', exceptOpen, require('./routes/x'));",
        ].join('\n')),
        'server/routes/x.js': [
          "const router = require('express').Router();",
          "router.all('/open', (req, res) => res.json({}));",
          'module.exports = router;',
        ].join('\n'),
      },
    }).scan();
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}${r.extra ? ` (${r.extra})` : ''}`))
      .toEqual(['ALL /api/open (exempt: GET)']);
  });

  test("a COMPUTED overwrite of a registration method (router['use'] = fn) is a problem", () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const { guardA } = require('../middleware/a');",
        "const router = require('express').Router();",
        "router['use'] = () => router;",
        'router.use(guardA);',
        "router.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('overwriting a router/app registration method'))).toBe(true);
  });

  test("a middleware array mutated via COMPUTED access (chain['unshift']) is tainted", () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        'const chain = [guardA];',
        "chain['unshift']((req, res) => res.json({ secret: 1 }));",
        "router.get('/leak', chain, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('an alias assigned from a MODELED object member (const api = holder.router) registers', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'const holder = { router };',
        'const api = holder.router;',
        "api.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a TEMPLATE-bound static root keeps its real initializer in the identity', () => {
    const res = scanOf({
      'server/index.js': app([
        'const root = `${__dirname}/public-a`;',
        "app.use('/files', express.static(root));",
      ].join('\n')),
    });
    const st = res.publicRoutes.find((r) => r.path === '/files');
    expect(st).toBeDefined();
    expect(st.extra).toContain('public-a');
    expect(st.extra).not.toContain('<unresolved>');
  });

  test('a route registered under a SWITCH carries discriminant and case in its identity', () => {
    const res = scanOf({
      'server/index.js': app([
        'switch (process.env.NODE_ENV) {',
        "case 'development':",
        "  app.get('/debug', (req, res) => res.json({}));",
        '  break;',
        'default:',
        '  break;',
        '}',
      ].join('\n')),
    });
    const r = res.publicRoutes.find((x) => x.path === '/debug');
    expect(r).toBeDefined();
    expect(r.cond).toContain('switch (process.env.NODE_ENV)');
    expect(r.cond).toContain("case 'development'");
  });

  test('a .cjs side-effect module mutating a mounted router is swept like a .js one', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/installer.cjs': "require('./routes/x').get('/leak', (req, res) => res.json({}));",
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test('directory modules resolve like Node (require(./routes/x) → routes/x/index.js)', () => {
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/x'));",
      ].join('\n')),
      'server/routes/x/index.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/services/installer.js': "require('../routes/x').get('/leak', (req, res) => res.json({}));",
    });
    // The mounted directory module is walked AND the side-effect mutation
    // resolves to the same module identity.
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toContain('GET /api/x/thing');
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test('listen() on an application other than the scanned root is a problem', () => {
    const res = scanOf({
      'server/index.js': app([
        'const live = express();',
        "live.get('/leak', (req, res) => res.json({}));",
        'live.listen(3000);',
      ].join('\n')),
    });
    expect(res.problems.some((p) => p.includes('listen() on application live'))).toBe(true);
  });

  test('an ESM side-effect module (import + mutate) is swept like its CommonJS twin', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/installer.mjs': [
        "import shared from './routes/x.js';",
        "shared.get('/leak', (req, res) => res.json({}));",
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test('a route inside a LOOP carries the loop test in its identity', () => {
    const res = scanOf({
      'server/index.js': app([
        "for (; process.env.NODE_ENV !== 'production';) {",
        "  app.get('/debug', (req, res) => res.json({}));",
        '  break;',
        '}',
      ].join('\n')),
    });
    const r = res.publicRoutes.find((x) => x.path === '/debug');
    expect(r).toBeDefined();
    expect(r.cond).toContain("loop while (process.env.NODE_ENV !== 'production')");
  });

  test('an inline wrapper DELEGATING to a captured router is never plain middleware', () => {
    const res = scanOf({
      'server/index.js': app([
        "const hidden = require('express').Router();",
        "hidden.get('/leak', (req, res) => res.json({}));",
        "app.use('/approved', (req, res, next) => hidden(req, res, next));",
      ].join('\n')),
    });
    // The wrapper must NOT be inventoried as an approvable plain inline
    // function — the delegation is visible in its identity or rejected.
    const clean = res.publicRoutes.filter((r) => (r.extra || '').includes('inline function') && !(r.extra || '').includes('delegating'));
    expect(clean).toEqual([]);
    expect(JSON.stringify([res.problems, res.publicRoutes.map((r) => r.extra)])).toContain('delegating to router hidden');
  });

  test("registrations through Express internals (app._router.get) are rejected, never dropped", () => {
    const res = scanOf({
      'server/index.js': app([
        "app.get('/ok', (req, res) => res.json({}));",
        "app._router.get('/leak', (req, res) => res.json({}));",
      ].join('\n')),
    });
    expect(res.problems.some((p) => p.includes('through unresolved member'))).toBe(true);
  });

  test('a public route registered inside a CLASS METHOD is rejected like any function', () => {
    const res = scanOf({
      'server/index.js': app([
        'class Installer {',
        '  install() {',
        "    app.get('/leak', (req, res) => res.json({}));",
        '  }',
        '}',
        'new Installer().install();',
      ].join('\n')),
    });
    expect(res.problems.some((p) => p.includes('registered inside a function'))).toBe(true);
  });

  test('a public route registered inside an OBJECT METHOD is rejected like any function', () => {
    const res = scanOf({
      'server/index.js': app([
        'const installer = {',
        '  install() {',
        "    app.get('/leak', (req, res) => res.json({}));",
        '  },',
        '};',
        'installer.install();',
      ].join('\n')),
    });
    expect(res.problems.some((p) => p.includes('registered inside a function'))).toBe(true);
  });

  test("a COMPUTED holder access (holder['api'].get) resolves like the dot spelling", () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'const holder = { api: router };',
        "holder['api'].get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a middleware array mutated via a BORROWED mutator (unshift.call) is tainted', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { guardA } = require('../middleware/a');",
        'const chain = [guardA];',
        'Array.prototype.unshift.call(chain, (req, res) => res.json({ secret: 1 }));',
        "router.get('/leak', chain, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('routes in TRY and CATCH carry the branch in their identity', () => {
    const res = scanOf({
      'server/index.js': app([
        'try {',
        "  app.get('/debug-try', (req, res) => res.json({}));",
        '} catch (err) {',
        "  app.get('/debug-catch', (req, res) => res.json({}));",
        '}',
      ].join('\n')),
    });
    const t = res.publicRoutes.find((r) => r.path === '/debug-try');
    const c = res.publicRoutes.find((r) => r.path === '/debug-catch');
    expect(t && t.cond).toBe('try');
    expect(c && c.cond).toBe('catch');
  });

  test('express.static OPTIONS are part of the allowlist identity', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/files', express.static('public', { dotfiles: 'allow' }));"),
    });
    const st = res.publicRoutes.find((r) => r.path === '/files');
    expect(st).toBeDefined();
    expect(st.extra).toContain("dotfiles: 'allow'");
  });

  test('a LOGICAL assignment to a registration method (router.use &&= fn) is a problem', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const { guardA } = require('../middleware/a');",
        "const router = require('express').Router();",
        'router.use &&= (() => router);',
        'router.use(guardA);',
        "router.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('overwriting a router/app registration method'))).toBe(true);
  });

  test('an IMPORTED router handed to an unanalysed function is caught in the sweep', () => {
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/services/installer.js': [
        "const shared = require('../routes/x');",
        "function install(r) { r.get('/leak', (req, res) => res.json({})); }",
        'install(shared);',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('passed to an unanalysed function'))).toBe(true);
  });

  test("a module that REBINDS require is rejected outright", () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const require = () => ({ guardA: (req, res, next) => next() });",
        "const { guardA } = require('../middleware/a');",
        "const router = { get: () => {} };",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes("'require' is rebound"))).toBe(true);
  });

  test('a function PARAMETER shadowing a registered guard refuses credit', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const { guardA } = require('../middleware/a');",
        "const router = require('express').Router();",
        'function install(guardA) {',
        "  router.get('/leak', guardA, (req, res) => res.json({}));",
        '}',
        'install((req, res, next) => next());',
        'module.exports = router;',
      ].join('\n'),
    });
    // With the shadow refused, the route is PUBLIC — and a public route
    // inside a function is itself rejected.
    expect(res.problems.some((p) => p.includes('registered inside a function'))).toBe(true);
  });

  test('a registration on a helper RETURN VALUE (current().get) is rejected when the helper touches a router', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'function current() { return router; }',
        "current().get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('on the return value of current()'))).toBe(true);
  });

  test('an application constructed with NEW (new express()) is tracked', () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'createServer', module: 'http', appOnly: true }] },
      files: {
        'server/index.js': app([
          "const http = require('http');",
          'const live = new express();',
          "live.get('/leak', (req, res) => res.json({}));",
          'http.createServer(live);',
        ].join('\n')),
      },
    }).scan();
    expect(res.problems.some((p) => p.includes('reviewed to receive only the app'))).toBe(true);
  });

  test('a consumer-side DESCRIPTOR rewrite of an imported guard is refused credit and reported', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const auth = require('../middleware/a');",
        "const router = require('express').Router();",
        "Object.defineProperty(auth, 'guardA', { value: (req, res, next) => next() });",
        "router.get('/leak', auth.guardA, (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toContain('GET /api/x/leak');
    expect(res.problems.some((p) => p.includes('rewrite of server/middleware/a.js export'))).toBe(true);
  });

  test('an inline use() responder carries a BODY DIGEST in its identity', () => {
    const res = scanOf({
      'server/index.js': app([
        "app.use('/a', (req, res, next) => next());",
        "app.use('/b', (req, res) => res.json({ leak: 1 }));",
      ].join('\n')),
    });
    const a = res.publicRoutes.find((r) => r.path === '/a');
    const b = res.publicRoutes.find((r) => r.path === '/b');
    expect(a.extra).toMatch(/inline function#[0-9a-f]{8}/);
    expect(b.extra).toMatch(/inline function#[0-9a-f]{8}/);
    expect(a.extra).not.toBe(b.extra);
  });

  test('a side-effect module SERVING its own app is propagated from the sweep', () => {
    const res = scanOf({
      'server/index.js': app("require('./services/side');"),
      'server/services/side.js': [
        "const express2 = require('express');",
        'const live = express2();',
        "live.get('/leak', (req, res) => res.json({}));",
        'live.listen(3000);',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('listen() on application live'))).toBe(true);
  });

  test('dynamic code (eval) in a server module is a problem, never silence', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'eval("router.get(\'/leak\', (req, res) => res.json({}))");',
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('dynamic code (eval)'))).toBe(true);
  });

  test('a WRAPPED side-app listener (http.createServer(live).listen) propagates from the sweep', () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'createServer', module: 'http', appOnly: true }] },
      files: {
        'server/index.js': app("require('./services/side');"),
        'server/services/side.js': [
          "const http = require('http');",
          "const express2 = require('express');",
          'const live = express2();',
          "live.get('/leak', (req, res) => res.json({}));",
          'http.createServer(live).listen(3000);',
        ].join('\n'),
      },
    }).scan();
    expect(res.problems.some((p) => p.includes('reviewed to receive only the app'))).toBe(true);
  });

  test('a helper returning a MODELED router member (return holder.api) is rejected', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'const holder = { api: router };',
        'function current() { return holder.api; }',
        "current().get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('on the return value of current()'))).toBe(true);
  });

  test('an appOnly consumer given an INLINE FUNCTION (raw handler) is a problem', () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'createServer', module: 'http', appOnly: true }] },
      files: {
        'server/index.js': app([
          "const http = require('http');",
          "http.createServer((req, res) => { res.end('leak'); }).listen(3000);",
        ].join('\n')),
      },
    }).scan();
    expect(res.problems.some((p) => p.includes('got an inline function'))).toBe(true);
  });

  test('a BORROWED registration (get.call) on an imported router is caught by the sweep', () => {
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/services/installer.js': "require('../routes/x').get.call(require('../routes/x'), '/leak', (req, res) => res.json({}));",
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test('a BORROWED registration through a required BINDING (shared.get.call) is caught too', () => {
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/services/installer.js': [
        "const shared = require('../routes/x');",
        "shared.get.call(shared, '/leak', (req, res) => res.json({}));",
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test('a BORROWED registration on a LOCAL router is rejected outright', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get.call(router, '/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('borrowed registration methods are not supported'))).toBe(true);
  });

  test('a DESCRIPTOR rewrite of module.exports makes the export untrusted', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const safe = require('express').Router();",
        "const leak = require('express').Router();",
        "leak.get('/leak', (req, res) => res.json({}));",
        'module.exports = safe;',
        "Object.defineProperty(module, 'exports', { get() { return leak; } });",
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('descriptor rewrite of module.exports'))).toBe(true);
  });

  test('STRICT routing options on Router() are rejected — path identities assume defaults', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router({ strict: true });",
        "router.get('/leak/', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('strict routing'))).toBe(true);
  });

  test('a mutation through a RE-EXPORT alias module reaches the mounted router', () => {
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/routes/alias.js': "module.exports = require('./x');",
      'server/services/installer.js': "require('../routes/alias').get('/leak', (req, res) => res.json({}));",
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test('listen() on an UNREVIEWED server factory (https.createServer) is a problem', () => {
    const res = scanOf({
      'server/index.js': app([
        "const https = require('https');",
        "https.createServer({}, (req, res) => { res.end('leak'); }).listen(443);",
      ].join('\n')),
    });
    expect(res.problems.some((p) => p.includes('unreviewed factory'))).toBe(true);
  });

  test("a mutation of a router's INTERNAL stack (router.stack.push) is rejected", () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const hidden = require('express').Router();",
        "hidden.get('/leak', (req, res) => res.json({}));",
        'router.stack.push(...hidden.stack);',
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('mutation of router.stack'))).toBe(true);
  });

  test('the chained CommonJS spelling (exports = module.exports = router) keeps the alias', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'exports = module.exports = router;',
        "exports.get('/leak', (req, res) => res.json({}));",
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a REQUIRE-VALUED holder property (holder.api = require(...)) routes through the sweep', () => {
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/services/installer.js': [
        "const holder = { api: require('../routes/x') };",
        "holder.api.get('/leak', (req, res) => res.json({}));",
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test("REPLACING a server's 'request' listener is a problem", () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'createServer', module: 'http', appOnly: true }] },
      files: {
        'server/index.js': app([
          "const http = require('http');",
          'const server = http.createServer(app);',
          "server.removeAllListeners('request');",
          "server.on('request', (req, res) => { res.end('leak'); });",
          'server.listen(3000);',
        ].join('\n')),
      },
    }).scan();
    expect(res.problems.some((p) => p.includes("on the 'request' event"))).toBe(true);
  });

  test('a NAMED local responder carries a body digest in its identity', () => {
    const res = scanOf({
      'server/index.js': app([
        'function responder(req, res, next) { next(); }',
        "app.use('/a', responder);",
      ].join('\n')),
    });
    const a = res.publicRoutes.find((r) => r.path === '/a');
    expect(a.extra).toMatch(/responder#[0-9a-f]{8}/);
  });

  test('a helper RETURNING a required module (return require(...)) routes through the sweep', () => {
    const res = scanOf({
      'server/index.js': app([
        "require('./services/installer');",
        "app.use('/api/x', require('./routes/x'));",
      ].join('\n')),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router.get('/thing', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
      'server/services/installer.js': [
        "function current() { return require('../routes/x'); }",
        "current().get('/leak', (req, res) => res.json({}));",
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('outside the owning module'))).toBe(true);
  });

  test('a DYNAMIC import() in a server module is a problem, never silence', () => {
    const res = scanOf({
      'server/index.js': app("require('./services/installer');"),
      'server/services/installer.js': "import('./routes/x.js').then((m) => m.default.get('/leak', (req, res) => res.json({})));",
    });
    expect(res.problems.some((p) => p.includes('dynamic import()'))).toBe(true);
  });

  test('an IMPORTED second app handed to an appOnly consumer is caught by the sweep', () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'createServer', module: 'http', appOnly: true }] },
      files: {
        'server/index.js': app("require('./services/side');"),
        'server/apps/live.js': [
          "const express2 = require('express');",
          'const live = express2();',
          "live.get('/leak', (req, res) => res.json({}));",
          'module.exports = live;',
        ].join('\n'),
        'server/services/side.js': [
          "const http = require('http');",
          "const live = require('../apps/live');",
          'http.createServer(live);',
        ].join('\n'),
      },
    }).scan();
    expect(res.problems.some((p) => p.includes('received the application exported by'))).toBe(true);
  });

  test('NESTED conditions serialize unambiguously (never colliding with a flat spelling)', () => {
    const res = scanOf({
      'server/index.js': app([
        'const a = process.env.A;',
        'const b = process.env.B;',
        'const c = process.env.C;',
        "if (a) { if (b || c) { app.get('/debug', (req, res) => res.json({})); } }",
        "if (a && b || c) { app.get('/debug2', (req, res) => res.json({})); }",
      ].join('\n')),
    });
    const nested = res.publicRoutes.find((r) => r.path === '/debug');
    const flat = res.publicRoutes.find((r) => r.path === '/debug2');
    expect(nested.cond).toBe('(a) && (b || c)');
    expect(flat.cond).toBe('a && b || c');
  });

  test('an IDENTIFIER-BOUND static options object resolves to its initializer in the identity', () => {
    const res = scanOf({
      'server/index.js': app([
        "const opts = { dotfiles: 'allow' };",
        "app.use('/files', express.static('public', opts));",
      ].join('\n')),
    });
    const st = res.publicRoutes.find((r) => r.path === '/files');
    expect(st.extra).toContain("opts = { dotfiles: 'allow' }");
  });

  test('a DESTRUCTURED write to a registration method ([router.use] = [noop]) is a problem', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const { guardA } = require('../middleware/a');",
        "const router = require('express').Router();",
        '[router.use] = [() => router];',
        'router.use(guardA);',
        "router.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('overwriting a router/app registration method'))).toBe(true);
  });

  test("a COMPUTED listen through a const string (server[method]) is judged like .listen", () => {
    const res = scanOf({
      'server/index.js': app([
        "const https = require('https');",
        "const method = 'listen';",
        "const server = https.createServer({}, (req, res) => { res.end('leak'); });",
        'server[method](443);',
      ].join('\n')),
    });
    expect(res.problems.some((p) => p.includes('unreviewed factory'))).toBe(true);
  });

  test('a static options object MUTATED after its initializer is rejected', () => {
    const res = scanOf({
      'server/index.js': app([
        'const opts = {};',
        "opts.dotfiles = 'allow';",
        "app.use('/files', express.static('public', opts));",
      ].join('\n')),
    });
    expect(res.problems.some((p) => p.includes('mutated after its initializer — inline the final options'))).toBe(true);
  });

  test("a responder's digest covers REACHABLE local helpers (editing dispatch breaks the key)", () => {
    const files = (dispatchBody) => ({
      'server/index.js': app([
        `function dispatch(req, res, next) { ${dispatchBody} }`,
        'function responder(req, res, next) { return dispatch(req, res, next); }',
        "app.use('/a', responder);",
      ].join('\n')),
    });
    const a = scanOf(files('next();')).publicRoutes.find((r) => r.path === '/a');
    const b = scanOf(files("res.json({ leak: 1 });")).publicRoutes.find((r) => r.path === '/a');
    expect(a.extra).toMatch(/responder#[0-9a-f]{8}/);
    expect(a.extra).not.toBe(b.extra);
  });

  test('a resolvable LITERAL binding in a predicate joins the condition label', () => {
    const res = scanOf({
      'server/index.js': app([
        'const enabled = false;',
        "if (enabled) { app.get('/debug', (req, res) => res.json({})); }",
      ].join('\n')),
    });
    const r = res.publicRoutes.find((x) => x.path === '/debug');
    expect(r.cond).toBe('enabled [with enabled=false]');
  });

  test('a router constructed with NEW (new express.Router()) is tracked', () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'createServer', module: 'http', appOnly: true }] },
      files: {
        'server/index.js': app([
          "const http = require('http');",
          'const router = new express.Router();',
          "router.get('/leak', (req, res) => res.json({}));",
          'http.createServer(router);',
        ].join('\n')),
      },
    }).scan();
    expect(res.problems.some((p) => p.includes('reviewed to receive only the app'))).toBe(true);
  });

  test('a WITH statement in a server module is a problem, never silence', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "with (router) { get('/leak', (req, res) => res.json({})); }",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('with statement'))).toBe(true);
  });

  test('a SEQUENCE-wrapped alias (const api = (0, router)) still registers', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        'const api = (0, router);',
        "api.get('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
  });

  test('a block-local CLASS shadowing an imported guard namespace refuses credit', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const auth = require('../middleware/a');",
        "const router = require('express').Router();",
        '{',
        '  class auth { static guardA(req, res, next) { next(); } }',
        "  router.get('/leak', auth.guardA, (req, res) => res.json({}));",
        '}',
        'module.exports = router;',
      ].join('\n'),
    });
    // The shadowed reference is never credited — the route surfaces public.
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toContain('GET /api/x/leak');
  });

  test('an ALIAS of the express factory (const makeApp = express) still makes a tracked app', () => {
    const res = new Scanner({
      appFile: 'server/index.js',
      registry: { ...REGISTRY, routerConsumers: [{ name: 'createServer', module: 'http', appOnly: true }] },
      files: {
        'server/index.js': app([
          "const http = require('http');",
          'const makeApp = express;',
          'const live = makeApp();',
          "live.get('/leak', (req, res) => res.json({}));",
          'http.createServer(live);',
        ].join('\n')),
      },
    }).scan();
    expect(res.problems.some((p) => p.includes('reviewed to receive only the app'))).toBe(true);
  });

  test("a computed string-literal verb (router['get']) registers like the plain form", () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "router['get']('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/leak']);
    expect(res.problems).toEqual([]);
  });

  test('a computed NON-literal method on a router is a reported problem, never silence', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const verb = 'get';",
        "router[verb]('/leak', (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.problems.some((p) => p.includes('computed method call'))).toBe(true);
  });

  test('a registered FACTORY guard call is recognised as auth', () => {
    const res = scanOf({
      'server/index.js': app("app.use('/api/x', require('./routes/x'));"),
      'server/routes/x.js': [
        "const router = require('express').Router();",
        "const { makeGuard } = require('../middleware/f');",
        "router.get('/thing', makeGuard('scope'), (req, res) => res.json({}));",
        'module.exports = router;',
      ].join('\n'),
    });
    expect(res.publicRoutes).toEqual([]);
  });

  test('an allowlist entry without a reason is rejected', () => {
    expect(() => allowlistKeys({
      mounts: [{ router: 'server/routes/x.js', mount: '/api/x', reason: '  ', routes: ['GET /api/x/thing'] }],
    })).toThrow(/no reason/);
  });

  test('duplicate allowlist entries are rejected', () => {
    expect(() => allowlistKeys({
      mounts: [
        { router: 'server/routes/x.js', mount: '/api/x', reason: 'r', routes: ['GET /api/x/thing', 'GET /api/x/thing'] },
      ],
    })).toThrow(/twice/);
  });
});
