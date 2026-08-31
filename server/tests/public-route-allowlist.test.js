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
    // A second anonymous pathless middleware would land on the SAME
    // `USE / (inline function)` key as an already-approved one and reuse its
    // approval — the scanner must refuse identical keys from distinct
    // source locations.
    const res = scanOf({
      'server/index.js': app([
        'app.use((req, res) => res.json({ a: 1 }));',
        'app.use((req, res) => res.json({ b: 2 }));',
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

  test('an optional-call registration (app?.get) on a known router is a reported problem', () => {
    const res = scanOf({
      'server/index.js': app("app?.get('/leak', (req, res) => res.json({}));"),
    });
    expect(res.problems.some((p) => p.includes('optional-call registration'))).toBe(true);
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
