// A recipient token that fails AFTER the token lookup (a permission read, the visit recheck) must answer on all three track routes
// exactly as an UNKNOWN token does: the same 404, body and headers, a code-only log. Only an error on the token lookup itself may
// surface as an error. This drives the REAL call-visit-recipient module behind the real routes; only the database, the hold read and
// the heavy collaborators are faked.
const mockTables = {};
jest.mock('../models/db', () => {
  const mockDb = jest.fn((table) => {
    const state = mockTables[table] || {};
    let byToken = false;
    const q = {};
    q.where = jest.fn((arg, val) => { if ((arg && arg['s.track_view_token']) || (arg === 's.track_view_token' && val)) byToken = true; return q; });
    for (const m of ['leftJoin', 'whereNotNull', 'orderBy', 'whereRaw', 'select', 'limit', 'whereNull']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => {
      const v = byToken && 'byToken' in state ? state.byToken : state.first;
      if (typeof v === 'function') return v();
      return v ?? null;
    });
    q.then = (resolve, reject) => Promise.resolve(state.list ?? []).then(resolve, reject);
    return q;
  });
  mockDb.raw = jest.fn((sql) => sql);
  return mockDb;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn(), CUSTOMER_DWELL_TTL_SECONDS: 60 }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async () => null) }));
jest.mock('../services/customer-page-views', () => ({ recordPageView: jest.fn(), logViewFailure: jest.fn() }));
jest.mock('../services/tracking-vehicle-location', () => ({ resolveFreshTechPosition: jest.fn(async () => null) }));
jest.mock('../services/disclaimed-number-holds', () => ({
  disclaimedNumberHeldForVisit: jest.fn(async () => false),
  disclaimedNumberHeld: jest.fn(async () => false),
}));
jest.mock('../services/contact-notification-prefs', () => ({
  contactPrefsLive: jest.fn(() => true), getContactPrefRow: jest.fn(async () => null), contactAllows: jest.fn(() => true),
}));
jest.mock('../services/messaging/auto-text-holds', () => ({ callVetoesForNumber: jest.fn(async () => ({ doNotContact: false, smsDeclined: false })) }));

const logger = require('../services/logger');
const holds = require('../services/disclaimed-number-holds');
const trackPublicRouter = require('../routes/track-public');

const TOKEN = 'b'.repeat(64);
const RECIP = { id: 'r-1', scheduled_service_id: 'visit-1', phone_key: '9415550002', phone_e164: '+19415550002', first_name: 'Bob' };
const LIVE = new Date(Date.now() + 86400000).toISOString();
const EN_ROUTE = {
  id: 'visit-1', customer_id: 'cust-1', status: 'en_route', track_state: 'en_route', completed_at: null, track_token_expires_at: LIVE,
  customer_pick_by: null, window_start: '09:00:00', window_end: '11:00:00', scheduled_date: '2026-12-01', service_type: 'Pest Control', en_route_at: new Date().toISOString(),
};
const PARKED = { ...EN_ROUTE, customer_pick_by: '2026-11-20T00:00:00Z', window_start: null, window_end: null };
const find = (path, method) => trackPublicRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack[0].handle;
const ROUTES = [['/:token', 'get'], ['/:token/stops-ahead', 'post'], ['/:token/view', 'post']];

async function run(path, method) {
  const res = { statusCode: 200, body: undefined, headers: {}, set: jest.fn((h) => { Object.assign(res.headers, h); return res; }), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn((b) => { res.body = b; return res; }), end: jest.fn(() => res) };
  const next = jest.fn();
  await find(path, method)({ params: { token: TOKEN }, headers: {}, get: () => null }, res, next);
  return { statusCode: res.statusCode, body: res.body, headers: res.headers, nextCalled: next.mock.calls.length };
}

function world({ recipient = RECIP, visit = EN_ROUTE } = {}) {
  for (const k of Object.keys(mockTables)) delete mockTables[k];
  mockTables.visit_text_recipients = { first: recipient, list: recipient ? [recipient] : [] };
  mockTables.scheduled_services = { first: visit };
  mockTables['scheduled_services as s'] = { byToken: null, first: visit };
  mockTables.customers = { first: { phone: '+19415550001' } };
}

const GATE = 'GATE_CALL_GIVEN_VISIT_TEXTS';
const gateBefore = process.env[GATE];
beforeEach(() => { jest.clearAllMocks(); process.env[GATE] = 'true'; holds.disclaimedNumberHeldForVisit.mockResolvedValue(false); });
afterAll(() => { if (gateBefore === undefined) delete process.env[GATE]; else process.env[GATE] = gateBefore; });

describe.each(ROUTES)('%s (%s)', (path, method) => {
  const unknownAnswer = async () => { world({ recipient: null }); return run(path, method); };
  const failPermission = () => holds.disclaimedNumberHeldForVisit.mockRejectedValue(Object.assign(new Error(`select where phone '+19415550002' token '${TOKEN}'`), { code: '57P01' }));

  test('the unknown token baseline is a plain 404 with no error', async () => {
    const answer = await unknownAnswer();
    expect(answer.statusCode).toBe(404);
    expect(answer.body).toEqual({ error: 'Not found' });
    expect(answer.nextCalled).toBe(0);
  });

  test('an eligible row whose PERMISSION read fails answers exactly as an unknown token, with a code-only log', async () => {
    const expected = await unknownAnswer();
    world();
    failPermission();
    expect(await run(path, method)).toEqual(expected);
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('57P01');
    expect(logged).not.toContain('9415550002');
    expect(logged).not.toContain(TOKEN);
  });

  test('a PARKED mixed row (customer pick set, no window, en route by status and track state) + a failing permission read: the same unknown answer', async () => {
    const expected = await unknownAnswer();
    world({ visit: PARKED });
    failPermission();
    expect(await run(path, method)).toEqual(expected);
  });

  test('a parked mixed row with every read healthy: the same unknown answer', async () => {
    const expected = await unknownAnswer();
    world({ visit: PARKED });
    expect(await run(path, method)).toEqual(expected);
  });

  test('the visit read AFTER the token lookup failing (route side) answers as unknown too', async () => {
    const expected = await unknownAnswer();
    world();
    let reads = 0;
    // the module reads the visit twice (before and after the permission reads); the route reads it once more by id
    mockTables.scheduled_services.first = () => { reads += 1; if (reads > 2) throw Object.assign(new Error('x'), { code: '57P01' }); return EN_ROUTE; };
    mockTables['scheduled_services as s'].first = () => { throw Object.assign(new Error('x'), { code: '57P01' }); };
    expect(await run(path, method)).toEqual(expected);
  });

  test('an error on the token lookup ITSELF is the only one allowed to surface as an error', async () => {
    world();
    mockTables.visit_text_recipients.first = () => { throw Object.assign(new Error('x'), { code: '57P01' }); };
    const answer = await run(path, method);
    // GET and stops-ahead forward a sanitized error to next(); the view beacon answers 204 by design
    expect(answer.nextCalled === 1 || answer.statusCode === 204).toBe(true);
  });

  test('an eligible row with healthy reads is NOT the unknown answer', async () => {
    const expected = await unknownAnswer();
    world();
    const answer = await run(path, method);
    expect(answer.statusCode).not.toBe(expected.statusCode);
  });
});

describe('the module and the route share ONE eligibility rule', () => {
  const { recipientLinkEligible } = require('../services/track-token-expiry');
  const { publicTrackState } = trackPublicRouter._test;
  const RECIPIENT_STATES = new Set(['en_route', 'on_property', 'complete']);
  const minutesAgo = (n) => new Date(Date.now() - n * 60000).toISOString();

  test('across a matrix of rows it agrees with the state the route reports (publicTrackState) plus the lifetime', () => {
    const { recipientTrackLinkOpen } = require('../services/track-token-expiry');
    const statuses = ['confirmed', 'pending', 'en_route', 'on_site', 'completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'];
    const states = ['scheduled', 'en_route', 'on_property', 'complete', 'cancelled'];
    for (const status of statuses) {
      for (const track_state of states) {
        for (const parked of [false, true]) {
          for (const completed_at of [null, minutesAgo(30), minutesAgo(300)]) {
            const row = { status, track_state, completed_at, en_route_at: minutesAgo(30), arrived_at: minutesAgo(10), track_token_expires_at: LIVE, customer_pick_by: parked ? '2026-11-20T00:00:00Z' : null, window_start: parked ? null : '09:00:00' };
            const viaRoute = recipientTrackLinkOpen(row) && RECIPIENT_STATES.has(publicTrackState(row));
            expect(recipientLinkEligible(row)).toBe(viaRoute);
          }
        }
      }
    }
  });
});
