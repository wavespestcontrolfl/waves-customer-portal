// A visit text recipient's tracker link (GATE_CALL_GIVEN_VISIT_TEXTS, owner 2026-11-24 "yes he gets it").
// The recipient's own token opens a REDUCED, map-only view of the one visit. The holder's payload carries the report
// token, invoice token, prep token, photos, the offer and referral cards, names and the street address; none of
// that may reach the recipient, whatever the visit's state. Pinned here with a whitelist (exact key sets) and
// with the absence of every holder-only value. The token -> visit resolution (gate, row, decline, visit) is
// pinned in call-visit-recipient-track-token.test.js and call-visit-recipient-postgres.test.js.
const mockDb = jest.fn();
jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/geocoder', () => ({ ensureCustomerGeocoded: jest.fn() }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn(), CUSTOMER_DWELL_TTL_SECONDS: 60 }));
jest.mock('../services/tech-photo', () => ({ resolveTechPhotoUrl: jest.fn(async () => 'https://img.test/pat.jpg') }));
jest.mock('../services/customer-page-views', () => ({ recordPageView: jest.fn(), logViewFailure: jest.fn() }));
const mockVisitForTrackToken = jest.fn();
jest.mock('../services/call-visit-recipient', () => ({ visitForTrackToken: (...a) => mockVisitForTrackToken(...a) }));
jest.mock('../services/tracking-vehicle-location', () => ({
  resolveFreshTechPosition: jest.fn(async () => ({ lat: 27.1, lng: -82.1, lastReportedAt: new Date().toISOString(), source: 'bouncie' })),
}));
jest.mock('../services/customer-tracking-eta', () => ({
  ...jest.requireActual('../services/customer-tracking-eta'),
  calculateBoundedTrackingEta: jest.fn(async () => ({ minutes: 9, source: 'matrix' })),
}));
const mockCompute = jest.fn();
jest.mock('../services/stops-ahead', () => ({
  ...jest.requireActual('../services/stops-ahead'),
  computeStopsAhead: mockCompute,
}));
const mockRecordPageView = require('../services/customer-page-views').recordPageView;

const trackPublicRouter = require('../routes/track-public');

const RECIPIENT_TOKEN = 'b'.repeat(64);
const HOLDER_TOKEN = 'a'.repeat(64);
const find = (path, method) => trackPublicRouter.stack.find((l) => l.route?.path === path && l.route.methods[method]).route.stack[0].handle;

// Everything only the account holder may see, in the visit row the route reads.
const HOLDER_ONLY = {
  firstName: 'Phyllis', lastName: 'Zzroe', line1: '123 Zzmain St', line2: 'Unit ZZ9', zip: '34219', contact: 'Zztenant Person',
  prep: 'zz-prep-token', report: 'zz-report-token', invoice: 'zz-invoice-token', review: '/api/go/zz-review', reason: 'zz-reason-text',
};
function visitRow(over = {}) {
  return {
    id: 'visit-1', customer_id: 'cust-1', technician_id: 'tech-1', scheduled_date: '2026-12-01', window_start: '09:00:00', window_end: '11:00:00',
    service_type: 'Pest Control', status: 'confirmed', track_state: 'scheduled', arrived_at: null, completed_at: null,
    cancelled_at: '2026-11-30T00:00:00.000Z', cancellation_reason: HOLDER_ONLY.reason,
    track_token_expires_at: new Date(Date.now() + 86400000).toISOString(), prep_token: HOLDER_ONLY.prep, prep_sent_at: '2026-11-25T00:00:00.000Z',
    cust_first_name: HOLDER_ONLY.firstName, cust_last_name: HOLDER_ONLY.lastName,
    service_contact_name: HOLDER_ONLY.contact, service_contact_phone: '+19415550123',
    address_line1: HOLDER_ONLY.line1, address_line2: HOLDER_ONLY.line2, city: 'Parrish', state: 'FL', zip: HOLDER_ONLY.zip,
    latitude: '27.2', longitude: '-82.2', stamped_address_diverges: false,
    tech_name: 'Pat Zztech', tech_photo_url: null, tech_photo_s3_key: 'k', tech_mapping_changed_at: null,
    service_description: 'zz-service-description', service_customer_visible: true,
    ...over,
  };
}

// db: the holder lookup (by track_view_token) misses; the by-id read returns the visit; every other table is recorded.
function install(row, { holderRow = null } = {}) {
  const tablesRead = [];
  mockDb.raw = jest.fn((sql) => sql);
  mockDb.mockImplementation((table) => {
    tablesRead.push(table);
    let byToken = false;
    const q = {};
    q.where = jest.fn((arg, val) => { if ((arg && arg['s.track_view_token']) || (arg === 's.track_view_token' && val)) byToken = true; return q; });
    for (const m of ['leftJoin', 'whereNotNull', 'orderBy', 'whereRaw', 'select', 'limit']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => {
      if (table !== 'scheduled_services as s' && table !== 'scheduled_services') return null;
      return byToken ? holderRow : row;
    });
    return q;
  });
  return tablesRead;
}

async function get(token = RECIPIENT_TOKEN) {
  const res = { statusCode: 200, body: undefined, set: jest.fn(() => res), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn((b) => { res.body = b; return res; }) };
  const next = jest.fn();
  await find('/:token', 'get')({ params: { token } }, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return res;
}

const ALLOWED_KEYS = ['arrivedAt', 'meta', 'property', 'scope', 'service', 'state', 'tech', 'vehicle', 'visitChange', 'window'];

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.mockReset();
  mockVisitForTrackToken.mockResolvedValue({ visitId: 'visit-1', recipientId: 'r-1' });
});

describe('GET /:token with a visit text recipient\'s token', () => {
  test.each([
    ['scheduled', {}],
    ['en route', { track_state: 'en_route', status: 'en_route', en_route_at: new Date().toISOString() }],
    ['on property', { track_state: 'on_property', arrived_at: '2026-12-01T14:00:00.000Z' }],
    ['complete', { status: 'completed', track_state: 'complete', completed_at: '2026-12-01T15:00:00.000Z' }],
    ['cancelled', { status: 'cancelled', track_state: 'cancelled' }],
  ])('%s: only whitelisted keys, no holder-only value anywhere', async (_label, over) => {
    const tablesRead = install(visitRow(over));
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).every((k) => ALLOWED_KEYS.includes(k))).toBe(true);
    expect(res.body.scope).toBe('visit_recipient');
    const text = JSON.stringify(res.body);
    for (const value of Object.values(HOLDER_ONLY)) expect(text).not.toContain(value);
    expect(text).not.toContain('Zztenant');
    expect(text).not.toContain('Zzroe');
    expect(text).not.toMatch(/prepToken|serviceReportToken|invoiceToken|reviewUrl|crossSell|referral|summary|customerFirstName|customer"|cancellation|stopsAhead|routeProgress|vehicleApprox|photos/);
    // The holder-only reads never happen: no report, invoice, review, prep project or offer lookups.
    for (const table of ['invoices', 'service_records', 'service_photos', 'review_requests', 'projects', 'referrals']) {
      expect(tablesRead).not.toContain(table);
    }
    expect(mockCompute).not.toHaveBeenCalled();
  });

  test('the property is the pin and the town, never the street, unit or zip', async () => {
    install(visitRow());
    const { body } = await get();
    expect(body.property).toEqual({ lat: 27.2, lng: -82.2, city: 'Parrish' });
    expect(body.service).toEqual({ type: 'Pest Control' });
    expect(body.tech).toEqual({ firstName: 'Pat', photoUrl: 'https://img.test/pat.jpg', yearsWithWaves: null });
  });

  test('en route: the whitelisted vehicle fields and a poll; every other state does not poll', async () => {
    install(visitRow({ track_state: 'en_route', status: 'en_route' }));
    const enRoute = (await get()).body;
    expect(enRoute.state).toBe('en_route');
    expect(Object.keys(enRoute.vehicle).sort()).toEqual(['etaMinutes', 'etaSource', 'lastReportedAt', 'lat', 'lng', 'stale']);
    expect(enRoute.meta).toEqual({ pollIntervalSeconds: 30 });
    install(visitRow());
    expect((await get()).body.meta).toEqual({ pollIntervalSeconds: 0 });
  });

  test('complete is a plain done state: no summary, no links, no cards', async () => {
    install(visitRow({ status: 'completed', track_state: 'complete', completed_at: '2026-12-01T15:00:00.000Z' }));
    const { body } = await get();
    expect(body.state).toBe('complete');
    expect(body.vehicle).toBeNull();
    expect(Object.keys(body).sort()).toEqual(ALLOWED_KEYS.slice().sort());
  });

  test('a visit the office is rebooking says so, with no reason, action or other visit', async () => {
    install(visitRow({ status: 'rescheduled' }));
    const { body } = await get();
    expect(body.visitChange).toEqual({ kind: 'pending_rebook' });
  });

  test.each([
    [{ kind: 'customer_pick', stage: 'awaiting_customer', reason: 'zz', action: { kind: 'portal_visits', href: '/?tab=schedule' } }],
    [{ kind: 'skipped', nextVisit: { date: '2026-12-20' } }],
    [{ kind: 'office_move', reason: 'zz' }],
  ])('a visit change that names the holder\'s other visits or an action never reaches the recipient (%j)', (visitChange) => {
    const out = trackPublicRouter._test.recipientTrackPayload({ state: 'scheduled', visitChange, customer: { name: 'zz' }, summary: { x: 1 }, prepToken: 'zz' });
    expect(out.visitChange).toBeNull();
    expect(Object.keys(out).sort()).toEqual(ALLOWED_KEYS.slice().sort());
  });

  test.each([
    ['gate off, a declined person or a deleted row (the module answers null)', () => mockVisitForTrackToken.mockResolvedValue(null)],
  ])('404: %s', async (_label, arrange) => {
    install(visitRow());
    arrange();
    const res = await get();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  test('404: the visit\'s own link has expired', async () => {
    install(visitRow({ track_token_expires_at: '2000-01-01T00:00:00.000Z' }));
    expect((await get()).statusCode).toBe(404);
  });

  test('404: the visit row is gone', async () => {
    install(null);
    expect((await get()).statusCode).toBe(404);
  });

  test('a malformed token never reaches the recipient lookup', async () => {
    install(visitRow());
    expect((await get('nope')).statusCode).toBe(404);
    expect(mockVisitForTrackToken).not.toHaveBeenCalled();
  });

  test('the holder\'s own token never asks the recipient module and keeps its full payload', async () => {
    install(visitRow(), { holderRow: visitRow() });
    const res = await get(HOLDER_TOKEN);
    expect(mockVisitForTrackToken).not.toHaveBeenCalled();
    expect(res.body.scope).toBeUndefined();
    expect(res.body.customerFirstName).toBe(HOLDER_ONLY.firstName);
  });
});

describe('POST /:token/stops-ahead and /:token/view with a recipient token', () => {
  const post = async (path, token = RECIPIENT_TOKEN) => {
    const res = { statusCode: 200, body: undefined, set: jest.fn(() => res), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn((b) => { res.body = b; return res; }), end: jest.fn(() => res) };
    await find(path, 'post')({ params: { token }, headers: {}, get: () => null }, res, jest.fn());
    return res;
  };

  test('stops-ahead answers the generic state, computes nothing and writes nothing', async () => {
    install(visitRow());
    const res = await post('/:token/stops-ahead');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ stopsAhead: null, routeProgress: null });
    expect(mockCompute).not.toHaveBeenCalled();
  });

  test('view answers 204 and records no customer page view', async () => {
    install(visitRow());
    const res = await post('/:token/view');
    expect(res.statusCode).toBe(204);
    expect(mockRecordPageView).not.toHaveBeenCalled();
  });

  test.each(['/:token/stops-ahead', '/:token/view'])('%s: 404 when the link does not resolve', async (path) => {
    install(visitRow());
    mockVisitForTrackToken.mockResolvedValue(null);
    expect((await post(path)).statusCode).toBe(404);
  });

  test.each(['/:token/stops-ahead', '/:token/view'])('%s: 404 when the visit\'s link has expired', async (path) => {
    install(visitRow({ track_token_expires_at: '2000-01-01T00:00:00.000Z' }));
    expect((await post(path)).statusCode).toBe(404);
  });
});

describe('the offer and referral cards never see a recipient token', () => {
  test('trackCardCustomerId resolves holder tokens only: a recipient token finds no visit, so no customer and no cards', async () => {
    const gateBefore = process.env.GATE_DOC_CROSS_SELL;
    process.env.GATE_DOC_CROSS_SELL = 'true';
    const wheres = [];
    mockDb.mockImplementation(() => {
      const q = {};
      q.leftJoin = jest.fn(() => q);
      q.where = jest.fn((...a) => { wheres.push(a); return q; });
      q.first = jest.fn(async () => null); // no scheduled_services row carries a recipient token as its track_view_token
      return q;
    });
    expect(await trackPublicRouter._test.trackCards(RECIPIENT_TOKEN)).toEqual({});
    expect(wheres).toEqual([['s.track_view_token', RECIPIENT_TOKEN]]);
    if (gateBefore === undefined) delete process.env.GATE_DOC_CROSS_SELL; else process.env.GATE_DOC_CROSS_SELL = gateBefore;
  });

  test('the route never calls trackCards or buildSummary for a recipient scope', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'track-public.js'), 'utf8');
    expect(src).toContain("customerState === 'complete' && !recipientScope ? await buildSummary(row)");
    expect(src).toContain("customerState === 'complete' && !recipientScope ? await trackCards(req.params.token)");
  });
});
