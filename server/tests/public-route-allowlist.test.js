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
    for (const g of [...registry.guards, ...(registry.passthroughs || [])]) {
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
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/thing']);
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

  test('a provably-non-router use() handler (inline fn, node_modules call) is NOT a problem', () => {
    const res = scanOf({
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
    });
    expect(res.problems).toEqual([]);
    expect(res.publicRoutes.map((r) => `${r.method} ${r.path}`)).toEqual(['GET /api/x/thing']);
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
