/**
 * find_admin_reads / read_admin_data (owner ruling 2026-10-12): the URL
 * builder, the response handling and the access rules. No network: global
 * fetch is mocked.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const logger = require('../services/logger');
const config = require('../config');
const rules = require('../utils/admin-read-rules');
const catalog = require('../services/intelligence-bar/admin-read-catalog.json');
const registry = require('../services/intelligence-bar/action-registry');
const { executeAdminReadTool, MAX_RESULT_CHARS } = require('../services/intelligence-bar/admin-read-tools');

const TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJ0ZXN0IjoidG9rZW4ifQ.c2lnbmF0dXJl';
const AUTH = `Bearer ${TOKEN}`;
const ORIGIN = `http://127.0.0.1:${Number(config.port)}`;
const READ = 'read_admin_data';
const FIND = 'find_admin_reads';

const ONE_PARAM = catalog.entries.find(entry => entry.params.length === 1);
const NO_PARAM = catalog.entries.find(entry => entry.params.length === 0);
const ownerContext = (extra = {}) => ({ fullAccess: true, isAdmin: true, staffAuthorization: AUTH, ...extra });

function jsonResponse(status, body, headers = { 'content-type': 'application/json; charset=utf-8' }) {
  return {
    status, headers: { get: key => headers[String(key).toLowerCase()] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

let gateBefore;
beforeEach(() => {
  gateBefore = process.env.GATE_IB_GENERAL_READ;
  process.env.GATE_IB_GENERAL_READ = 'true';
  global.fetch = jest.fn(async () => jsonResponse(200, { ok: true }));
  jest.clearAllMocks();
});
afterEach(() => {
  if (gateBefore === undefined) delete process.env.GATE_IB_GENERAL_READ;
  else process.env.GATE_IB_GENERAL_READ = gateBefore;
});

const read = (input, context = ownerContext()) => executeAdminReadTool(READ, input, context);
const callsOf = () => global.fetch.mock.calls;

describe('the path builder', () => {
  test('fills a catalog pattern and sends one loopback GET with the request token', async () => {
    const result = await read({ endpoint: ONE_PARAM.endpoint, params: { [ONE_PARAM.params[0]]: 'abc-123' }, query: { limit: 5, status: 'open', all: true } });
    expect(result).toMatchObject({ status: 200, endpoint: ONE_PARAM.endpoint, data: { ok: true }, truncated: false });
    expect(callsOf()).toHaveLength(1);
    const [url, options] = callsOf()[0];
    const parsed = new URL(url);
    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.pathname).toBe(`/api${ONE_PARAM.endpoint.replace(`:${ONE_PARAM.params[0]}`, 'abc-123')}`);
    expect(Object.fromEntries(parsed.searchParams)).toEqual({ limit: '5', status: 'open', all: 'true' });
    expect(options.method).toBe('GET');
    expect(options.headers.Authorization).toBe(AUTH);
    expect(options.redirect).toBe('manual');
    expect(options.signal).toBeDefined();
    expect(options.body).toBeUndefined();
  });

  test('a pattern with no parameters needs none', async () => {
    await read({ endpoint: NO_PARAM.endpoint });
    expect(new URL(callsOf()[0][0]).pathname).toBe(`/api${NO_PARAM.endpoint}`);
  });

  test.each([
    ['an unknown endpoint', () => ({ endpoint: '/admin/not-in-the-catalog' })],
    ['a pre-built URL', () => ({ endpoint: `/api${NO_PARAM.endpoint}` })],
    ['an absolute URL', () => ({ endpoint: `http://evil.example${NO_PARAM.endpoint}` })],
    ['a pattern with its parameter already filled', () => ({ endpoint: ONE_PARAM.endpoint.replace(/:[A-Za-z0-9_]+/, '123') })],
    ['a pattern with a trailing slash', () => ({ endpoint: `${NO_PARAM.endpoint}/` })],
    ['a pattern in other case', () => ({ endpoint: NO_PARAM.endpoint.toUpperCase() })],
    ['a path-climbing endpoint', () => ({ endpoint: '/admin/../auth/me' })],
    ['a missing endpoint', () => ({})],
    ['a non-string endpoint', () => ({ endpoint: { toString: () => NO_PARAM.endpoint } })],
  ])('refuses %s', async (_label, build) => {
    const result = await read(build());
    expect(result).toMatchObject({ code: 'capability_unimplemented', hint: 'find_admin_reads' });
    expect(callsOf()).toHaveLength(0);
  });

  test.each([
    ['a dot-dot value', '..'], ['a single dot', '.'], ['a slash', 'a/b'], ['an encoded slash', 'a%2Fb'],
    ['a percent sign', '100%'], ['a backslash', 'a\\b'], ['a space', 'a b'], ['a query mark', 'a?b=1'],
    ['an at sign', 'a@evil.example'], ['a colon', 'a:b'], ['an empty value', ''], ['a long value', 'x'.repeat(81)],
    ['a newline', 'a\nb'],
  ])('refuses a parameter with %s', async (_label, value) => {
    const result = await read({ endpoint: ONE_PARAM.endpoint, params: { [ONE_PARAM.params[0]]: value } });
    expect(result).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
  });

  test('refuses an extra, a missing and a non-object params', async () => {
    const name = ONE_PARAM.params[0];
    expect(await read({ endpoint: ONE_PARAM.endpoint, params: { [name]: '1', extra: '2' } })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ endpoint: ONE_PARAM.endpoint, params: {} })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ endpoint: ONE_PARAM.endpoint })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ endpoint: ONE_PARAM.endpoint, params: [name] })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ endpoint: ONE_PARAM.endpoint, params: { [name]: { toString: () => '1' } } })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ endpoint: NO_PARAM.endpoint, params: { id: '1' } })).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
  });

  test('refuses an object, array or null query value, a bad query key and too many keys', async () => {
    const base = { endpoint: NO_PARAM.endpoint };
    expect(await read({ ...base, query: { a: { b: 1 } } })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ ...base, query: { a: [1, 2] } })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ ...base, query: { a: null } })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ ...base, query: { 'a b': 1 } })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ ...base, query: { 'a&b=c': 1 } })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ ...base, query: [1] })).toMatchObject({ code: 'invalid_input' });
    expect(await read({ ...base, query: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, i])) })).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
  });

  test('caps a query value at 200 characters and keeps filter keys such as a[b]', async () => {
    await read({ endpoint: NO_PARAM.endpoint, query: { note: 'x'.repeat(500), 'filter[status]': 'open' } });
    const search = new URL(callsOf()[0][0]).searchParams;
    expect(search.get('note')).toHaveLength(200);
    expect(search.get('filter[status]')).toBe('open');
  });

  test('a parameter that looks like a host or a file name is refused, and the origin never moves', async () => {
    const name = ONE_PARAM.params[0];
    expect(await read({ endpoint: ONE_PARAM.endpoint, params: { [name]: 'evil.example.com' } })).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
    await read({ endpoint: ONE_PARAM.endpoint, params: { [name]: 'evil-example-com' } });
    const parsed = new URL(callsOf()[0][0]);
    expect(parsed.origin).toBe(ORIGIN);
    expect(parsed.username).toBe('');
    expect(parsed.pathname.startsWith('/api/admin/')).toBe(true);
  });

  test('refuses a parameter value that spells a denied segment', async () => {
    const result = await read({ endpoint: ONE_PARAM.endpoint, params: { [ONE_PARAM.params[0]]: 'export' } });
    expect(result).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
  });

  test('every catalog pattern builds a path that passes the deny rules', () => {
    for (const entry of catalog.entries) {
      const params = Object.fromEntries(entry.params.map(name => [name, 'a1']));
      const filled = rules.fillPattern(entry.endpoint, params);
      expect({ endpoint: entry.endpoint, error: filled.error }).toEqual({ endpoint: entry.endpoint, error: undefined });
      expect(rules.denyReason(filled.path)).toBeNull();
    }
  });
});

describe('a parameter value that reaches an unreviewed route', () => {
  test('is refused, while an ordinary value still reads', async () => {
    let isolated;
    jest.isolateModules(() => {
      jest.doMock('../services/intelligence-bar/admin-read-catalog.json', () => ({
        version: 1, counts: {},
        entries: [{ endpoint: '/admin/widgets/:id', params: ['id'], screens: ['Widgets'], handlers: [], label: 'widgets' }],
        blockedRoutes: ['/admin/widgets/internal-tool'],
      }));
      isolated = require('../services/intelligence-bar/admin-read-tools');
    });
    const run = value => isolated.executeAdminReadTool(READ, { endpoint: '/admin/widgets/:id', params: { id: value } }, ownerContext());
    expect(await run('internal-tool')).toMatchObject({ code: 'invalid_input' });
    expect(await run('INTERNAL-TOOL')).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
    expect(await run('12345')).toMatchObject({ status: 200 });
    jest.dontMock('../services/intelligence-bar/admin-read-catalog.json');
  });

  test('the committed blocked routes collide only through a literal at a parameter position', () => {
    expect(rules.collidesWithRoute('/admin/widgets/internal-tool', ['admin', 'widgets', 'internal-tool'], '/admin/widgets/:id')).toBe(true);
    expect(rules.collidesWithRoute('/admin/widgets/internal-tool', ['admin', 'widgets', 'other'], '/admin/widgets/:id')).toBe(false);
    expect(rules.collidesWithRoute('/admin/widgets/internal-tool', ['admin', 'widgets', 'internal-tool'], '/admin/widgets/list')).toBe(false);
    expect(rules.collidesWithRoute('/admin/widgets/:id', ['admin', 'widgets', 'a1'], '/admin/widgets/:id')).toBe(false);
  });
});

describe('the token', () => {
  test('is forwarded, and appears in no returned value and no logger call', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { echoed: `see ${TOKEN} here`, rows: [1, 2] }));
    const ok = await read({ endpoint: NO_PARAM.endpoint });
    expect(callsOf()[0][1].headers.Authorization).toBe(AUTH);
    global.fetch.mockResolvedValueOnce(jsonResponse(500, { error: `failed for ${TOKEN}` }));
    const failed = await read({ endpoint: NO_PARAM.endpoint });
    global.fetch.mockRejectedValueOnce(Object.assign(new Error(`socket ${AUTH}`), { name: 'FetchError' }));
    const broken = await read({ endpoint: NO_PARAM.endpoint });
    const refused = await read({ endpoint: '/admin/nope' });
    const everything = JSON.stringify([ok, failed, broken, refused, ...Object.values(logger).flatMap(fn => fn.mock.calls)]);
    expect(everything).not.toContain(TOKEN);
    expect(everything).toContain('[redacted]');
  });

  test('comes from the action context only, never from model input', async () => {
    const result = await read({ endpoint: NO_PARAM.endpoint, staffAuthorization: 'Bearer attacker-token-attacker' }, ownerContext({ staffAuthorization: undefined }));
    expect(result).toMatchObject({ code: 'permission_denied' });
    expect(callsOf()).toHaveLength(0);
    // And through the registry, the schema refuses the extra field outright.
    const viaRegistry = await registry.execute(READ, { endpoint: NO_PARAM.endpoint, staffAuthorization: 'Bearer attacker-token-attacker' },
      { role: 'admin', context: 'customers', actionContext: ownerContext() });
    expect(viaRegistry).toMatchObject({ code: 'invalid_input' });
    expect(callsOf()).toHaveLength(0);
  });

  test.each([undefined, '', 'Basic abc', 'Bearer', 'Bearer short', `Bearer ${TOKEN}\r\nX-Evil: 1`])('refuses a missing or malformed token (%j)', async (value) => {
    expect(await read({ endpoint: NO_PARAM.endpoint }, ownerContext({ staffAuthorization: value }))).toMatchObject({ code: 'permission_denied' });
    expect(callsOf()).toHaveLength(0);
  });
});

describe('the answer', () => {
  test('cuts a big array to the first items that fit and says how to narrow', async () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ id: i, name: `row ${i}`, note: 'some descriptive text' }));
    global.fetch.mockResolvedValueOnce(jsonResponse(200, rows));
    const result = await read({ endpoint: NO_PARAM.endpoint });
    expect(result.truncated).toBe(true);
    expect(result.total_items).toBe(2000);
    expect(Array.isArray(result.data)).toBe(true);
    expect(result.data.length).toBeGreaterThan(10);
    expect(result.data.length).toBeLessThan(2000);
    expect(result.data[0]).toEqual(rows[0]);
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(result.note).toMatch(/narrow/i);
    expect(result.note).toMatch(/query/);
  });

  test('cuts the big array inside an object and names the paging keys it saw', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: i, label: `item ${i}`, detail: 'more words to fill space' }));
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { rows, page: 1, total: 1500, has_more: true, meta: { source: 'x' } }));
    const result = await read({ endpoint: NO_PARAM.endpoint });
    expect(result.truncated).toBe(true);
    expect(result.data.rows.length).toBeLessThan(1500);
    expect(result.data.rows_total_items).toBe(1500);
    expect(result.data.meta).toEqual({ source: 'x' });
    expect(result.data.total).toBe(1500);
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
    expect(result.note).toMatch(/page/);
    expect(result.note).toMatch(/has_more/);
  });

  test('cuts a big nested object and long strings', async () => {
    const nested = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`group${i}`, { text: 'y'.repeat(900), inner: { a: 1, b: { c: 'deep'.repeat(100) } } }]));
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { nested, summary: 'kept' }));
    const result = await read({ endpoint: NO_PARAM.endpoint });
    expect(result.truncated).toBe(true);
    expect(result.data.summary).toBe('kept');
    expect(JSON.stringify(result.data).length).toBeLessThanOrEqual(MAX_RESULT_CHARS);
  });

  test('a small answer comes back whole', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(200, { rows: [{ id: 1 }], total: 1 }));
    expect(await read({ endpoint: NO_PARAM.endpoint })).toEqual({ status: 200, endpoint: NO_PARAM.endpoint, data: { rows: [{ id: 1 }], total: 1 }, truncated: false, note: null });
  });

  test('a non-JSON answer returns no body', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(200, '<html>secret page</html>', { 'content-type': 'text/html' }));
    const result = await read({ endpoint: NO_PARAM.endpoint });
    expect(result).toEqual({ status: 200, endpoint: NO_PARAM.endpoint, note: 'not a JSON data read' });
    global.fetch.mockResolvedValueOnce(jsonResponse(200, 'a,b\n1,2', { 'content-type': 'text/csv' }));
    expect(await read({ endpoint: NO_PARAM.endpoint })).toMatchObject({ note: 'not a JSON data read' });
    global.fetch.mockResolvedValueOnce(jsonResponse(200, 'x', {}));
    expect(await read({ endpoint: NO_PARAM.endpoint })).toMatchObject({ note: 'not a JSON data read' });
  });

  test('a redirect is not followed', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(302, '', { location: 'http://evil.example/' }));
    const result = await read({ endpoint: NO_PARAM.endpoint });
    expect(result.status).toBe(302);
    expect(result.data).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('evil.example');
  });

  test('404 and 500 return the message string only', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(404, { error: 'Customer not found', stack: 'secret stack', extra: { a: 1 } }));
    expect(await read({ endpoint: NO_PARAM.endpoint })).toEqual({ status: 404, endpoint: NO_PARAM.endpoint, error: 'Customer not found' });
    global.fetch.mockResolvedValueOnce(jsonResponse(500, { message: 'Server error', trace: 'x' }));
    expect(await read({ endpoint: NO_PARAM.endpoint })).toEqual({ status: 500, endpoint: NO_PARAM.endpoint, error: 'Server error' });
    global.fetch.mockResolvedValueOnce(jsonResponse(502, 'Bad gateway', { 'content-type': 'text/plain' }));
    expect(await read({ endpoint: NO_PARAM.endpoint })).toMatchObject({ status: 502, error: expect.stringMatching(/502/) });
    global.fetch.mockResolvedValueOnce(jsonResponse(401, { error: 'Admin authentication required' }));
    expect(await read({ endpoint: NO_PARAM.endpoint })).toMatchObject({ status: 401, error: 'Admin authentication required' });
  });

  test('a timeout and a connection failure fail closed without detail', async () => {
    global.fetch.mockRejectedValueOnce(Object.assign(new Error('The operation timed out'), { name: 'TimeoutError' }));
    expect(await read({ endpoint: NO_PARAM.endpoint })).toMatchObject({ code: 'read_timeout' });
    global.fetch.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await read({ endpoint: NO_PARAM.endpoint })).toMatchObject({ code: 'read_failed', error: 'The admin endpoint could not be reached' });
  });

  test('unreadable JSON returns an error, not a body', async () => {
    global.fetch.mockResolvedValueOnce(jsonResponse(200, '{not json'));
    expect(await read({ endpoint: NO_PARAM.endpoint })).toMatchObject({ status: 200, error: expect.any(String) });
  });
});

describe('find_admin_reads', () => {
  test('returns up to 10 entries with endpoint, params, label and screen, and reads no rows', async () => {
    const result = await executeAdminReadTool(FIND, { query: 'customer' }, ownerContext());
    expect(result.status).toBe('reads_found');
    expect(result.matches.length).toBeGreaterThan(0);
    expect(result.matches.length).toBeLessThanOrEqual(10);
    for (const match of result.matches) {
      expect(Object.keys(match).sort()).toEqual(['endpoint', 'label', 'params', 'screen']);
      expect(catalog.entries.some(entry => entry.endpoint === match.endpoint)).toBe(true);
    }
    expect(callsOf()).toHaveLength(0);
  });

  test('finds an endpoint by its path words, its screen name and its handler name', async () => {
    const entry = catalog.entries.find(e => rules.splitPath(e.endpoint).length >= 3 && e.handlers.length > 0);
    const lastWord = rules.splitPath(entry.endpoint).filter(s => !rules.isParam(s)).pop().split('-')[0];
    const byPath = await executeAdminReadTool(FIND, { query: lastWord }, ownerContext());
    expect(byPath.matches.length).toBeGreaterThan(0);
    const byHandler = await executeAdminReadTool(FIND, { query: entry.handlers[0].replace(/([a-z])([A-Z])/g, '$1 $2') }, ownerContext());
    expect(byHandler.matches.map(m => m.endpoint)).toContain(entry.endpoint);
    const byScreen = await executeAdminReadTool(FIND, { query: entry.screens[0].replace(/([a-z])([A-Z])/g, '$1 $2') }, ownerContext());
    expect(byScreen.matches.length).toBeGreaterThan(0);
  });

  test('says so when nothing matches and for empty input', async () => {
    expect(await executeAdminReadTool(FIND, { query: 'zzzzqqqq' }, ownerContext())).toMatchObject({ status: 'no_match', matches: [] });
    expect(await executeAdminReadTool(FIND, { query: 'the a of' }, ownerContext())).toMatchObject({ status: 'no_match' });
    expect(await executeAdminReadTool(FIND, {}, ownerContext())).toMatchObject({ status: 'no_match' });
  });
});

describe('access', () => {
  const action = name => registry.actions.get(name);
  const scope = (extra = {}) => ({ role: 'admin', context: 'customers', fullAccess: true, ...extra });

  test('are offered and allowed only to the owner login with the gate on', () => {
    for (const name of [READ, FIND]) {
      expect(registry.allowed(action(name), scope())).toBe(true);
      expect(registry.allowed(action(name), scope({ fullAccess: false }))).toBe(false);
      expect(registry.allowed(action(name), scope({ fullAccess: undefined }))).toBe(false);
      expect(registry.allowed(action(name), scope({ role: 'technician' }))).toBe(false);
      expect(registry.allowed(action(name), scope({ context: 'tech' }))).toBe(false);
      expect(registry.allowed(action(name), scope({ context: 'agent_estimate' }))).toBe(false);
      process.env.GATE_IB_GENERAL_READ = 'false';
      expect(registry.allowed(action(name), scope())).toBe(false);
      delete process.env.GATE_IB_GENERAL_READ;
      expect(registry.allowed(action(name), scope())).toBe(false);
      process.env.GATE_IB_GENERAL_READ = 'true';
    }
  });

  test('discovery finds them for the owner login only, and only with the gate on', () => {
    const found = discovery => registry.discover({ query: 'read admin screen data endpoint' }, discovery).definitions.map(d => d.name);
    expect(found(scope())).toEqual(expect.arrayContaining([READ]));
    expect(found(scope({ fullAccess: false }))).not.toContain(READ);
    expect(found(scope({ fullAccess: false }))).not.toContain(FIND);
    process.env.GATE_IB_GENERAL_READ = 'false';
    expect(found(scope())).not.toContain(READ);
    expect(found(scope())).not.toContain(FIND);
  });

  test('no starting tool list carries them for a login without full access, a technician or the tech and estimate rails', () => {
    for (const context of ['customers', 'dashboard', 'ops', 'revenue']) {
      const names = registry.initialTools(context, { role: 'admin', context, fullAccess: false }).map(t => t.name);
      expect(names).not.toContain(READ);
      expect(names).not.toContain(FIND);
    }
    for (const [role, context] of [['technician', 'tech'], ['admin', 'tech'], ['technician', 'customers'], ['admin', 'agent_estimate']]) {
      const names = registry.initialTools(context, { role, context, fullAccess: true }).map(t => t.name);
      expect(names).not.toContain(READ);
      expect(names).not.toContain(FIND);
    }
  });

  test('execute refuses a login without full access, a technician, the tech context, and a gate that is off', async () => {
    const input = { endpoint: NO_PARAM.endpoint };
    const run = (role, context, actionContext) => registry.execute(READ, input, { role, context, actionContext, techContext: role === 'technician' ? { techId: 't1' } : undefined });
    expect(await run('admin', 'platform', ownerContext({ fullAccess: false }))).toMatchObject({ code: 'permission_denied' });
    expect(await run('technician', 'tech', ownerContext())).toMatchObject({ code: 'permission_denied' });
    expect(await run('admin', 'tech', ownerContext())).toMatchObject({ code: 'permission_denied' });
    expect(await run('admin', 'agent_estimate', ownerContext())).toMatchObject({ code: 'permission_denied' });
    process.env.GATE_IB_GENERAL_READ = 'false';
    expect(await run('admin', 'platform', ownerContext())).toMatchObject({ code: 'permission_denied' });
    expect(callsOf()).toHaveLength(0);
    process.env.GATE_IB_GENERAL_READ = 'true';
    expect(await run('admin', 'platform', ownerContext())).toMatchObject({ status: 200 });
    expect(callsOf()).toHaveLength(1);
  });

  test('the executor itself refuses when the gate is off or the login lacks full access', async () => {
    process.env.GATE_IB_GENERAL_READ = 'false';
    expect(await read({ endpoint: NO_PARAM.endpoint })).toMatchObject({ code: 'gate_off' });
    expect(await executeAdminReadTool(FIND, { query: 'customer' }, ownerContext())).toMatchObject({ code: 'gate_off' });
    process.env.GATE_IB_GENERAL_READ = 'true';
    expect(await read({ endpoint: NO_PARAM.endpoint }, ownerContext({ fullAccess: false }))).toMatchObject({ code: 'permission_denied' });
    expect(await read({ endpoint: NO_PARAM.endpoint }, ownerContext({ isAdmin: false }))).toMatchObject({ code: 'permission_denied' });
    expect(await executeAdminReadTool(FIND, { query: 'customer' }, {})).toMatchObject({ code: 'permission_denied' });
    expect(await executeAdminReadTool(FIND, { query: 'customer' })).toMatchObject({ code: 'permission_denied' });
    expect(callsOf()).toHaveLength(0);
  });

  test('the read tool is classified as a broad reader and the finder as none', () => {
    expect(action(READ)).toMatchObject({ kind: 'read', scope: 'broad', role: 'admin', approval: null });
    expect(action(FIND)).toMatchObject({ kind: 'read', scope: 'none', role: 'admin', approval: null });
  });
});
