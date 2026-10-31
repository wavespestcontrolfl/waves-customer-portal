/**
 * The general admin read on the OFFICE login (owner ruling 2026-10-28 "A1", GATE_IB_GENERAL_READ_OFFICE): a non-owner ADMIN gets
 * find_admin_reads and read_admin_data limited to the catalog rows reviewed as `office: true`. The owner login is unchanged, a
 * technician gets nothing, the gate off is byte-identical, notes are withheld on her login, and the catalog build refuses an office
 * row on the never-office list. No network: global fetch is mocked.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const catalog = require('../services/intelligence-bar/admin-read-catalog.json');
const reviewed = require('../services/intelligence-bar/admin-read-reviewed.json');
const registry = require('../services/intelligence-bar/action-registry');
const ownerDirect = require('../services/intelligence-bar/owner-direct');
const { executeAdminReadTool } = require('../services/intelligence-bar/admin-read-tools');
const { validateReviewedRow } = require('../../scripts/build-ib-admin-read-catalog');

const AUTH = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJvZmZpY2UiOiJ0b2tlbiJ9.c2lnbmF0dXJl';
const READ = 'read_admin_data';
const FIND = 'find_admin_reads';
const OFFICE_ENDPOINTS = ['/admin/dispatch/alerts', '/admin/email-templates', '/admin/email-templates/automations', '/admin/schedule/blackout-dates'];
const owner = (extra = {}) => ({ fullAccess: true, isAdmin: true, staffAuthorization: AUTH, ...extra });
const office = (extra = {}) => ({ fullAccess: false, isAdmin: true, staffAuthorization: AUTH, ...extra });
const json = (body) => ({ status: 200, headers: { get: (k) => ({ 'content-type': 'application/json' })[String(k).toLowerCase()] ?? null }, text: async () => JSON.stringify(body) });
const ENV = ['GATE_IB_PLATFORM', 'GATE_IB_GENERAL_READ', 'GATE_IB_GENERAL_READ_OFFICE', 'GATE_IB_READ_NOTES', 'GATE_IB_OWNER_DIRECT'];
let saved;
beforeEach(() => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  process.env.GATE_IB_PLATFORM = 'true';
  process.env.GATE_IB_GENERAL_READ = 'true';
  process.env.GATE_IB_GENERAL_READ_OFFICE = 'true';
  delete process.env.GATE_IB_READ_NOTES;
  global.fetch = jest.fn(async () => json({ ok: true }));
});
afterEach(() => { for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } });

const read = (input, ctx) => executeAdminReadTool(READ, input, ctx);
const find = (query, ctx) => executeAdminReadTool(FIND, { query }, ctx);

describe('which rows are office rows', () => {
  test('exactly the four reviewed office rows, carried into the catalog', () => {
    expect(catalog.entries.filter((e) => e.office).map((e) => e.endpoint).sort()).toEqual([...OFFICE_ENDPOINTS].sort());
    expect(reviewed.reviewed.filter((r) => r.office).map((r) => r.endpoint).sort()).toEqual([...OFFICE_ENDPOINTS].sort());
  });

  test('no office entry is on the never-office list, returns notes (keepNotes) or touches money, pay, SEO, tax or credentials', () => {
    for (const e of catalog.entries.filter((x) => x.office)) {
      expect(e.keepNotes).toBeUndefined();
      expect(e.endpoint).not.toMatch(/banking|payout|payroll|tax|seo|revenue\/settings|pricing|discount|credential|secret|token|settings\/|integration/i);
    }
  });
});

describe('the catalog build refuses a bad office row', () => {
  const row = (endpoint, extra = {}) => ({ endpoint, reviewed: 'x', scope: 'broad', query: [], office: true, ...extra });
  test.each([
    '/admin/banking/accounts', '/admin/payouts/history', '/admin/referrals/payouts', '/admin/revenue/settings', '/admin/seo/pipeline/runs',
    '/admin/payroll/runs', '/admin/tax/summary', '/admin/pricing-config/lawn-brackets', '/admin/discounts', '/admin/settings/stripe',
    '/admin/integrations/status', '/admin/tokens/health', '/admin/vendors/credentials',
  ])('%s cannot be an office row', (endpoint) => {
    expect(() => validateReviewedRow(row(endpoint))).toThrow(/office row cannot be on the never-office list/);
  });
  test('a row reviewed to return notes cannot be an office row; office must be true', () => {
    expect(() => validateReviewedRow(row('/admin/dispatch/alerts', { keep: ['alerts.*.id'], keepNotes: ['alerts.*.note'] }))).toThrow(/cannot return notes/);
    expect(() => validateReviewedRow(row('/admin/dispatch/alerts', { office: false }))).toThrow(/office must be true or absent/);
  });
  test('an ordinary office row passes', () => {
    expect(() => validateReviewedRow(row('/admin/dispatch/alerts'))).not.toThrow();
    expect(() => validateReviewedRow(row('/admin/dispatch/alerts', { office: undefined }))).not.toThrow();
  });
});

describe('the office login', () => {
  test('find_admin_reads lists only office rows', async () => {
    const out = await find('dispatch alerts', office());
    expect(out.matches.map((m) => m.endpoint)).toEqual(['/admin/dispatch/alerts']);
    for (const q of ['customer timeline', 'invoices', 'referral payouts', 'revenue settings', 'pricing', 'email templates', 'blackout dates']) {
      const matches = (await find(q, office())).matches;
      expect(matches.every((m) => OFFICE_ENDPOINTS.includes(m.endpoint))).toBe(true);
    }
    expect((await find('email templates', office())).matches.map((m) => m.endpoint)).toEqual(expect.arrayContaining(['/admin/email-templates', '/admin/email-templates/automations']));
    expect((await find('blackout dates', office())).matches.map((m) => m.endpoint)).toContain('/admin/schedule/blackout-dates');
  });

  test('read_admin_data reads an office row with HER OWN bearer token (the endpoint\'s own auth applies)', async () => {
    const out = await read({ endpoint: '/admin/dispatch/alerts' }, office());
    expect(out).toMatchObject({ status: 200, endpoint: '/admin/dispatch/alerts' });
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe(AUTH);
    expect(global.fetch.mock.calls[0][0]).toContain('/api/admin/dispatch/alerts');
  });

  test('any other reviewed row is refused plainly, with no request made', async () => {
    for (const endpoint of catalog.entries.filter((e) => !e.office).map((e) => e.endpoint)) {
      const input = { endpoint, params: Object.fromEntries(catalog.entries.find((e) => e.endpoint === endpoint).params.map((p) => [p, '10000000-0000-4000-8000-00000000000a'])) };
      expect(await read(input, office())).toMatchObject({ code: 'permission_denied', error: 'That read is not available on this login.' });
    }
    expect(await read({ endpoint: '/admin/not-a-reviewed-row' }, office())).toMatchObject({ code: 'capability_unimplemented' });
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('notes are withheld on her login even with GATE_IB_READ_NOTES on; the owner login gets them scrubbed as before', async () => {
    process.env.GATE_IB_READ_NOTES = 'true';
    global.fetch = jest.fn(async () => json({ blackout_dates: [{ id: 1, date: '2026-11-26', reason: 'Closed for Thanksgiving, gate code 4455' }] }));
    const hers = await read({ endpoint: '/admin/schedule/blackout-dates' }, office());
    expect(hers.notes_withheld).toBeGreaterThan(0);
    expect(hers).not.toHaveProperty('notes_returned');
    expect(JSON.stringify(hers.data)).not.toContain('Thanksgiving');
    expect(JSON.stringify(hers.data)).not.toContain('4455');
    const owners = await read({ endpoint: '/admin/schedule/blackout-dates' }, owner());
    expect(owners.notes_returned).toBeGreaterThan(0);
    expect(JSON.stringify(owners.data)).toContain('Thanksgiving');
    expect(owners).not.toHaveProperty('notes_withheld');
  });

  test('without GATE_IB_READ_NOTES her login and the owner login both withhold (today\'s behavior)', async () => {
    global.fetch = jest.fn(async () => json({ blackout_dates: [{ id: 1, date: '2026-11-26', reason: 'Closed' }] }));
    expect((await read({ endpoint: '/admin/schedule/blackout-dates' }, office())).notes_withheld).toBeGreaterThan(0);
    expect((await read({ endpoint: '/admin/schedule/blackout-dates' }, owner())).notes_withheld).toBeGreaterThan(0);
  });
});

describe('the owner login is unchanged', () => {
  test('finds and reads every row, office or not, with the office gate on or off', async () => {
    const hits = async () => (await find('invoices customer timeline referral payouts', owner())).matches.map((m) => m.endpoint);
    const on = await hits();
    expect(on.some((e) => !OFFICE_ENDPOINTS.includes(e))).toBe(true);
    delete process.env.GATE_IB_GENERAL_READ_OFFICE;
    expect(await hits()).toEqual(on);
    const readOwner = async () => JSON.stringify(await read({ endpoint: '/admin/referrals/payouts' }, owner()));
    const off = await readOwner();
    process.env.GATE_IB_GENERAL_READ_OFFICE = 'true';
    expect(await readOwner()).toBe(off);
    expect(JSON.parse(off)).toMatchObject({ status: 200 });
  });
});

describe('no access for anyone else', () => {
  test('a technician, a missing admin flag and isAdmin false get nothing; the tools are not offered to a technician', async () => {
    for (const ctx of [{ fullAccess: false, isAdmin: false, staffAuthorization: AUTH }, { fullAccess: false, staffAuthorization: AUTH }, {}, undefined]) {
      expect(await read({ endpoint: '/admin/dispatch/alerts' }, ctx)).toMatchObject({ code: 'permission_denied' });
      expect(await find('dispatch alerts', ctx)).toMatchObject({ code: 'permission_denied' });
    }
    for (const name of [READ, FIND]) {
      expect(registry.allowed(registry.actions.get(name), { role: 'technician', context: 'tech' })).toBe(false);
      expect(registry.allowed(registry.actions.get(name), { role: 'technician', context: 'customers', fullAccess: false })).toBe(false);
      expect(registry.allowed(registry.actions.get(name), { role: 'admin', context: 'tech', fullAccess: false })).toBe(false);
      expect(registry.allowed(registry.actions.get(name), { role: 'admin', context: 'agent_estimate', fullAccess: false })).toBe(false);
    }
    const viaRegistry = await registry.execute(READ, { endpoint: '/admin/dispatch/alerts' }, { role: 'technician', context: 'tech', techContext: { techId: 't1' }, actionContext: office() });
    expect(viaRegistry).toMatchObject({ code: 'permission_denied' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('gate off is byte-identical', () => {
  test('the office gate off: her login is refused as today and neither tool is offered; the office gate needs the general read gate', async () => {
    delete process.env.GATE_IB_GENERAL_READ_OFFICE;
    expect(await read({ endpoint: '/admin/dispatch/alerts' }, office())).toMatchObject({ code: 'permission_denied', error: 'This read is limited to the owner account.' });
    const names = (scope) => registry.initialTools('dashboard', scope).map((t) => t.name);
    expect(names({ role: 'admin', context: 'dashboard', fullAccess: false })).not.toEqual(expect.arrayContaining([READ]));
    expect(names({ role: 'admin', context: 'dashboard', fullAccess: false })).not.toContain(FIND);
    process.env.GATE_IB_GENERAL_READ_OFFICE = 'true';
    delete process.env.GATE_IB_GENERAL_READ;
    expect(await read({ endpoint: '/admin/dispatch/alerts' }, office())).toMatchObject({ code: 'gate_off' });
    expect(names({ role: 'admin', context: 'dashboard', fullAccess: false })).not.toContain(READ);
    delete process.env.GATE_IB_PLATFORM;
    process.env.GATE_IB_GENERAL_READ = 'true';
    expect(await read({ endpoint: '/admin/dispatch/alerts' }, office())).toMatchObject({ code: 'gate_off' });
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe('what is offered on her login', () => {
  const names = (context) => registry.initialTools(context, { role: 'admin', context, fullAccess: false }).map((t) => t.name);
  test('exactly the two read tools, on a page that carries them, and nothing owner-only', () => {
    for (const context of ['dashboard', 'customers', 'comms']) {
      expect(names(context)).toEqual(expect.arrayContaining([READ, FIND]));
      for (const ownerOnly of ['find_admin_edits', 'propose_admin_edit', 'resolve_sentry_issue', 'set_railway_gate']) expect(names(context)).not.toContain(ownerOnly);
    }
    expect(registry.allowed(registry.actions.get('find_admin_edits'), { role: 'admin', context: 'dashboard', fullAccess: false })).toBe(false);
  });

  test('validateInput accepts the call for her login and discovery finds the tools', () => {
    expect(registry.validateInput(READ, { endpoint: '/admin/dispatch/alerts' }, { role: 'admin', context: 'platform', fullAccess: false })).toBeNull();
    const found = registry.discover({ query: 'read admin screen data endpoint' }, { role: 'admin', context: 'customers', fullAccess: false }).definitions.map((d) => d.name);
    expect(found).toEqual(expect.arrayContaining([READ]));
  });

  test('every later write is still carded: owner-direct never runs for her login, after a read or not', () => {
    process.env.GATE_IB_OWNER_DIRECT = 'true';
    const req = { techRole: 'admin', technician: { email: 'office@example.test' } };
    expect(ownerDirect.ownerDirectLive(req)).toBe(false);
    expect(ownerDirect.ownerDirectLive({ techRole: 'admin', technician: { email: 'contact@wavespestcontrol.com' } })).toBe(true);
  });
});
