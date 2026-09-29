// customer-page-views recorder: skips bots / staff previews, dedupes in SQL,
// hashes the IP like short_code_clicks, and never throws or blocks.
const mockRaw = jest.fn();
jest.mock('../models/db', () => ({ raw: (...a) => mockRaw(...a) }));
jest.mock('../config', () => ({ jwt: { secret: 'page-views-test-secret' } }));
const mockWarn = jest.fn();
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: (...a) => mockWarn(...a), error: jest.fn(), debug: jest.fn(),
}));

const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { recordPageView, logViewFailure, DEDUPE_MINUTES } = require('../services/customer-page-views');

const HUMAN_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';

function mkReq({ ua = HUMAN_UA, ip = '203.0.113.9', headers = {} } = {}) {
  const h = { ...headers };
  if (ua !== null) h['user-agent'] = ua;
  return { ip, headers: h, get: (name) => h[String(name).toLowerCase()] };
}

describe('recordPageView', () => {
  const savedAdminIps = process.env.WAVES_ADMIN_IPS;
  beforeEach(() => {
    mockRaw.mockReset();
    mockRaw.mockResolvedValue({ rowCount: 1 });
    mockWarn.mockReset();
    delete process.env.WAVES_ADMIN_IPS;
  });
  afterAll(() => {
    if (savedAdminIps === undefined) delete process.env.WAVES_ADMIN_IPS;
    else process.env.WAVES_ADMIN_IPS = savedAdminIps;
  });

  test('writes one row with a sha256 ip hash and a truncated user agent', async () => {
    const longUa = `${HUMAN_UA} ${'x'.repeat(800)}`;
    const wrote = await recordPageView({
      req: mkReq({ ua: longUa }), page: 'appointment', customerId: 'cust-1', subjectType: 'scheduled_service', subjectId: 42,
    });
    expect(wrote).toBe(true);
    expect(mockRaw).toHaveBeenCalledTimes(1);
    const [sql, params] = mockRaw.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO customer_page_views/);
    expect(sql).toMatch(/WHERE NOT EXISTS/);
    const expectedHash = crypto.createHash('sha256').update('203.0.113.9').digest('hex');
    expect(params.slice(0, 6)).toEqual(['cust-1', 'appointment', 'scheduled_service', '42', expectedHash, longUa.slice(0, 500)]);
    // the dedupe probe repeats page/subject/ip and carries the window
    expect(params.slice(6)).toEqual(['appointment', 'scheduled_service', '42', expectedHash, DEDUPE_MINUTES]);
  });

  test('a caller-supplied dedupe window replaces the default; a bad one falls back', async () => {
    await recordPageView({ req: mkReq(), page: 'track', subjectType: 'scheduled_service', subjectId: 'a', dedupeMinutes: 60 });
    await recordPageView({ req: mkReq(), page: 'track', subjectType: 'scheduled_service', subjectId: 'a', dedupeMinutes: -5 });
    expect(mockRaw.mock.calls[0][1].slice(-1)).toEqual([60]);
    expect(mockRaw.mock.calls[1][1].slice(-1)).toEqual([DEDUPE_MINUTES]);
  });

  test('a deduped view (0 rows inserted) resolves false', async () => {
    mockRaw.mockResolvedValue({ rowCount: 0 });
    expect(await recordPageView({ req: mkReq(), page: 'track', subjectType: 'scheduled_service', subjectId: 'a' })).toBe(false);
  });

  test.each([
    ['facebookexternalhit/1.1', 'link unfurler'],
    ['Slackbot-LinkExpanding 1.0', 'slack unfurler'],
    ['curl/8.4.0', 'cli client'],
    ['Mozilla/5.0 (Windows NT 10.0) HeadlessChrome/120', 'headless browser'],
  ])('skips bot user agent %s (%s)', async (ua) => {
    expect(await recordPageView({ req: mkReq({ ua }), page: 'appointment', customerId: 'c' })).toBe(false);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  test('skips a staff browser carrying the signed waves_admin marker cookie', async () => {
    const marker = jwt.sign({ kind: 'admin_marker', sub: 't1' }, 'page-views-test-secret');
    const req = mkReq({ headers: { cookie: `a=b; waves_admin=${encodeURIComponent(marker)}` } });
    expect(await recordPageView({ req, page: 'appointment', customerId: 'c' })).toBe(false);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  test('a forged or wrong-kind waves_admin cookie does not exempt the view', async () => {
    const forged = jwt.sign({ kind: 'admin_marker' }, 'some-other-secret');
    const wrongKind = jwt.sign({ kind: 'customer' }, 'page-views-test-secret');
    expect(await recordPageView({ req: mkReq({ headers: { cookie: `waves_admin=${forged}` } }), page: 'p' })).toBe(true);
    expect(await recordPageView({ req: mkReq({ headers: { cookie: `waves_admin=${wrongKind}` } }), page: 'p' })).toBe(true);
  });

  test('skips an IP on the WAVES_ADMIN_IPS staff allowlist', async () => {
    process.env.WAVES_ADMIN_IPS = '198.51.100.1, 203.0.113.9';
    expect(await recordPageView({ req: mkReq(), page: 'appointment', customerId: 'c' })).toBe(false);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  test('requires a req and a page', async () => {
    expect(await recordPageView({ page: 'x' })).toBe(false);
    expect(await recordPageView({ req: mkReq() })).toBe(false);
    expect(await recordPageView()).toBe(false);
    expect(mockRaw).not.toHaveBeenCalled();
  });

  test('null ip / subject / customer are stored as NULL, page stays generic', async () => {
    await recordPageView({ req: mkReq({ ip: null, ua: null }), page: 'portal:invoices' });
    const [, params] = mockRaw.mock.calls[0];
    expect(params.slice(0, 6)).toEqual([null, 'portal:invoices', null, null, null, null]);
  });

  test('never throws when the DB rejects, and logs a warning', async () => {
    mockRaw.mockRejectedValue(new Error('relation "customer_page_views" does not exist'));
    await expect(recordPageView({ req: mkReq(), page: 'appointment', customerId: 'c' })).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledWith(expect.stringContaining('insert failed'));
  });

  test('a Knex-style failure is logged without its message (SQL text / bound token never reach the log)', async () => {
    const secret = 'SeCrEtBearerToken0123456789abc';
    const err = new Error(`select * from "appointment_card_requests" where "token" = '${secret}' limit 1 - connection terminated`);
    err.code = '57P01';
    mockRaw.mockRejectedValue(err);
    await expect(recordPageView({ req: mkReq(), page: 'secure-card', subjectType: 'appointment_card_request', subjectId: 'r' })).resolves.toBe(false);
    expect(mockWarn).toHaveBeenCalledTimes(1);
    const line = mockWarn.mock.calls[0].join(' ');
    expect(line).not.toContain(secret);
    expect(line).not.toContain('select *');
    expect(line).toContain('secure-card');
    expect(line).toContain('appointment_card_request');
    expect(line).toContain('57P01');
  });

  test('logViewFailure tolerates a non-Error rejection', () => {
    expect(() => logViewFailure('lookup', 'secure-card', 'x', undefined)).not.toThrow();
    expect(mockWarn.mock.calls[0][0]).toContain('code=unknown');
  });

  test('never throws when db.raw throws synchronously', async () => {
    mockRaw.mockImplementation(() => { throw new Error('boom'); });
    await expect(recordPageView({ req: mkReq(), page: 'appointment' })).resolves.toBe(false);
  });

  test('does not block the caller: returns a promise without awaiting the insert', () => {
    mockRaw.mockReturnValue(new Promise(() => {})); // never settles
    const p = recordPageView({ req: mkReq(), page: 'appointment' });
    expect(p).toBeInstanceOf(Promise); // returned immediately; caller does not await
  });
});
