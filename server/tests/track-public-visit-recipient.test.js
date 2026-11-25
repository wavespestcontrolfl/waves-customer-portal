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
const mockIsToday = jest.fn(() => false);
jest.mock('../services/stops-ahead', () => ({
  ...jest.requireActual('../services/stops-ahead'),
  computeStopsAhead: mockCompute,
  isServiceDateToday: (...a) => mockIsToday(...a),
}));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(), createShortCode: jest.fn() }));
const { ensureCustomerGeocoded: mockGeocode } = require('../services/geocoder');
const { resolveFreshTechPosition: mockResolvePosition } = require('../services/tracking-vehicle-location');
const { calculateBoundedTrackingEta: mockEta } = require('../services/customer-tracking-eta');
const mockShorten = require('../services/short-url');
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
const writes = [];
function install(row, { holderRow = null, members = null } = {}) {
  const tablesRead = [];
  mockDb.raw = jest.fn((sql) => sql);
  mockDb.mockImplementation((table) => {
    tablesRead.push(table);
    let byToken = false;
    const q = {};
    // Any write through the handle is recorded: a recipient GET must make none.
    for (const m of ['update', 'insert', 'del', 'delete', 'upsert', 'increment']) q[m] = jest.fn(() => { writes.push(`${table}.${m}`); return q; });
    q.where = jest.fn((arg, val) => { if ((arg && arg['s.track_view_token']) || (arg === 's.track_view_token' && val)) byToken = true; return q; });
    for (const m of ['leftJoin', 'whereNotNull', 'orderBy', 'whereRaw', 'select', 'limit']) q[m] = jest.fn(() => q);
    q.first = jest.fn(async () => {
      if (table !== 'scheduled_services as s' && table !== 'scheduled_services') return null;
      return byToken ? holderRow : row;
    });
    // The visit-group read (visit-groups.sameDriveSiblingIds): one query over the visit's members joined to the visit.
    q.join = jest.fn(() => q);
    q.whereNotIn = jest.fn(() => q);
    q.then = (resolve, reject) => Promise.resolve(table === 'scheduled_services as m' && members ? members : []).then(resolve, reject);
    return q;
  });
  return tablesRead;
}

async function get(token = RECIPIENT_TOKEN, query = undefined) {
  const res = { statusCode: 200, body: undefined, set: jest.fn(() => res), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn((b) => { res.body = b; return res; }) };
  const next = jest.fn();
  await find('/:token', 'get')({ params: { token }, query }, res, next);
  if (next.mock.calls.length) throw next.mock.calls[0][0];
  return res;
}

const ALLOWED_KEYS = ['arrivedAt', 'meta', 'property', 'scope', 'service', 'state', 'tech', 'vehicle', 'window'];

beforeEach(() => {
  jest.clearAllMocks();
  mockDb.mockReset();
  writes.length = 0;
  mockVisitForTrackToken.mockResolvedValue({ visitId: 'visit-1', recipientId: 'r-1', customerId: 'cust-1' });
});

const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000).toISOString();
const ENROUTE = { status: 'en_route', track_state: 'en_route', en_route_at: minutesAgo(10) };
const ONSITE = { status: 'on_site', track_state: 'on_property', en_route_at: minutesAgo(40), arrived_at: minutesAgo(20) };
const DONE = (minutes) => ({ status: 'completed', track_state: 'complete', completed_at: minutesAgo(minutes) });

describe('GET /:token with a visit text recipient\'s token: the link\'s lifetime', () => {
  test.each([
    ['en route', ENROUTE],
    ['on property', ONSITE],
    ['complete, 5 minutes ago', DONE(5)],
    ['complete, 119 minutes ago', DONE(119)],
  ])('%s: opens', async (_label, over) => {
    install(visitRow(over));
    expect((await get()).statusCode).toBe(200);
  });

  test.each([
    ['scheduled', { status: 'confirmed', track_state: 'scheduled' }],
    ['pending', { status: 'pending', track_state: 'scheduled' }],
    ['cancelled', { status: 'cancelled', track_state: 'cancelled' }],
    ['skipped', { status: 'skipped', track_state: 'scheduled' }],
    ['no show', { status: 'no_show', track_state: 'scheduled' }],
    ['the office is rebooking', { status: 'rescheduled', track_state: 'scheduled' }],
    ['parked for the holder to pick a day', { status: 'confirmed', track_state: 'scheduled', customer_pick_by: '2026-11-20T00:00:00Z', window_start: null, window_end: null }],
    ['a stale en-route state on a rebooked visit', { status: 'rescheduled', track_state: 'en_route' }],
    ['en route by status but scheduled by track state', { status: 'en_route', track_state: 'scheduled' }],
    ['on site by status but en route by track state (mixed: no GPS)', { status: 'on_site', track_state: 'en_route' }],
    ['en route by status but on property by track state (mixed)', { status: 'en_route', track_state: 'on_property' }],
    ['complete, 121 minutes ago', DONE(121)],
    ['complete, a day ago', DONE(24 * 60)],
    ['complete with no completed_at', { status: 'completed', track_state: 'complete', completed_at: null }],
    ['complete with an unreadable completed_at', { status: 'completed', track_state: 'complete', completed_at: 'not-a-date' }],
  ])('404: %s', async (_label, over) => {
    install(visitRow(over));
    const res = await get();
    expect(res.statusCode).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  test('404: the visit\'s own link has expired', async () => {
    install(visitRow({ ...ENROUTE, track_token_expires_at: '2000-01-01T00:00:00.000Z' }));
    expect((await get()).statusCode).toBe(404);
  });

  test.each([[null], [undefined], ['not-a-date']])('404: the visit has no live expiry on record (%s)', async (expiry) => {
    install(visitRow({ ...ENROUTE, track_token_expires_at: expiry }));
    expect((await get()).statusCode).toBe(404);
  });

  test('the holder\'s own legacy link with a null expiry still opens, in any state (unchanged)', async () => {
    const row = visitRow({ status: 'confirmed', track_state: 'scheduled', track_token_expires_at: null });
    install(row, { holderRow: row });
    expect((await get(HOLDER_TOKEN)).statusCode).toBe(200);
  });

  test.each([
    ['gate off, a declined person or a deleted row (the module answers null)', () => mockVisitForTrackToken.mockResolvedValue(null)],
  ])('404: %s', async (_label, arrange) => {
    install(visitRow(ENROUTE));
    arrange();
    expect((await get()).statusCode).toBe(404);
  });

  test('404: the visit row is gone', async () => {
    install(null);
    expect((await get()).statusCode).toBe(404);
  });

  test('a malformed token never reaches the recipient lookup', async () => {
    install(visitRow(ENROUTE));
    expect((await get('nope')).statusCode).toBe(404);
    expect(mockVisitForTrackToken).not.toHaveBeenCalled();
  });

  test('the holder\'s own token never asks the recipient module and keeps its full payload', async () => {
    install(visitRow(ENROUTE), { holderRow: visitRow(ENROUTE) });
    const res = await get(HOLDER_TOKEN);
    expect(mockVisitForTrackToken).not.toHaveBeenCalled();
    expect(res.body.scope).toBeUndefined();
    expect(res.body.customerFirstName).toBe(HOLDER_ONLY.firstName);
  });
});

describe('GET /:token with a visit text recipient\'s token: the reduced payload', () => {
  test.each([
    ['en route', ENROUTE],
    ['on property', ONSITE],
    ['complete', DONE(5)],
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
    expect(text).not.toMatch(/prepToken|serviceReportToken|invoiceToken|reviewUrl|crossSell|referral|summary|customerFirstName|customer"|cancellation|stopsAhead|routeProgress|vehicleApprox|photos|visitChange/);
    // The holder-only reads never happen: no report, invoice, review, prep project or offer lookups.
    for (const table of ['invoices', 'service_records', 'service_photos', 'review_requests', 'projects', 'referrals']) {
      expect(tablesRead).not.toContain(table);
    }
    expect(mockCompute).not.toHaveBeenCalled();
  });

  test.each([
    ['en route with a stored pin', ENROUTE],
    ['en route with NO stored pin', { ...ENROUTE, latitude: null, longitude: null }],
    ['on property', ONSITE],
    ['complete', DONE(5)],
  ])('read-only: %s makes no write, no geocoder call, no Bouncie fetch, no paid ETA, no short link, no page view', async (_label, over) => {
    install(visitRow(over));
    const res = await get();
    expect(res.statusCode).toBe(200);
    expect(writes).toEqual([]);
    expect(mockGeocode).not.toHaveBeenCalled();
    expect(mockShorten.shortenOrPassthrough).not.toHaveBeenCalled();
    expect(mockShorten.createShortCode).not.toHaveBeenCalled();
    expect(mockRecordPageView).not.toHaveBeenCalled();
    expect(mockCompute).not.toHaveBeenCalled();
    // When the live position is read at all, it is the cached one (no fetch that writes) and the ETA is the local estimate.
    for (const [arg] of mockResolvePosition.mock.calls) expect(arg.allowBouncieFallback).toBe(false);
    for (const [arg] of mockEta.mock.calls) expect(arg.allowProvider).toBe(false);
  });

  test('the truck shows only while the technician\'s active job is this visit (or a same-drive sibling): an ungrouped visit asks for its own id and nothing else', async () => {
    const tablesRead = install(visitRow(ENROUTE));
    await get();
    expect(mockResolvePosition.mock.calls.at(-1)[0].requireCurrentJobIds).toEqual(['visit-1']);
    // an ungrouped visit makes no group lookup: a sibling visit's active job never shows this visit's truck
    expect(tablesRead.filter((table) => table === 'scheduled_services')).toEqual([]);
    mockResolvePosition.mockClear();
    // a grouped visit with no admissible sibling is still only itself (the group rules are pinned just below)
    install(visitRow({ ...ENROUTE, visit_id: 'group-1' }), { members: [] });
    await get();
    expect(mockResolvePosition.mock.calls.at(-1)[0].requireCurrentJobIds).toEqual(['visit-1']);
  });

  describe('a GROUPED visit: the fan-out moves current_job_id to a sibling', () => {
    const START = minutesAgo(10);
    const STOP = { v_status: 'open', v_technician_id: 'tech-1', v_customer_id: 'cust-1', v_property_id: 'prop-1', v_scheduled_date: '2026-12-01', v_window_start: '09:00:00', v_window_end: '11:00:00' };
    const member = (id, over = {}) => ({
      id, status: 'en_route', track_state: 'en_route', en_route_at: START, technician_id: 'tech-1', customer_id: 'cust-1', property_id: 'prop-1',
      scheduled_date: '2026-12-01', window_start: '09:00:00', window_end: '11:00:00', ...STOP, ...over,
    });
    const grouped = () => visitRow({ ...ENROUTE, en_route_at: START, visit_id: 'group-1', property_id: 'prop-1' });
    // The resolver stands in for tech_status: the technician's active job is the SIBLING, so a fix exists only if the sibling is asked for.
    const techOnSibling = () => mockResolvePosition.mockImplementation(async ({ requireCurrentJobIds }) => (requireCurrentJobIds.includes('sib-1')
      ? { lat: 27.1, lng: -82.1, lastReportedAt: new Date().toISOString(), source: 'bouncie' } : null));
    afterEach(() => mockResolvePosition.mockImplementation(async () => ({ lat: 27.1, lng: -82.1, lastReportedAt: new Date().toISOString(), source: 'bouncie' })));
    const vehicleFor = async (members) => {
      install(grouped(), { members });
      techOnSibling();
      return (await get()).body.vehicle;
    };

    test('a sibling at the SAME stop (same tech, property, window chain, en route in the same drive): the truck shows', async () => {
      expect(await vehicleFor([member('visit-1'), member('sib-1', { en_route_at: minutesAgo(9.9) })])).not.toBeNull();
      expect(mockResolvePosition.mock.calls.at(-1)[0].requireCurrentJobIds).toEqual(['visit-1', 'sib-1']);
    });

    test.each([
      ['moved to another stop (another date) but still holding the old visit_id', { scheduled_date: '2026-12-09' }],
      ['moved to another property', { property_id: 'prop-2' }],
      ['moved to another customer', { customer_id: 'cust-2' }],
      ['with no property on file (null property_id)', { property_id: null }],
      ['on another technician', { technician_id: 'tech-2' }],
      ['no technician', { technician_id: null }],
      ['its window no longer chains to the stop', { window_start: '15:00:00', window_end: '16:00:00' }],
      ['not en route by status', { status: 'confirmed' }],
      ['not en route by tracker', { track_state: 'scheduled' }],
      ['en route with no en_route_at', { en_route_at: null }],
      ['en route in a DIFFERENT drive (stamped an hour later)', { en_route_at: minutesAgo(-50) }],
    ])('a sibling %s is never this drive: no truck', async (_label, over) => {
      expect(await vehicleFor([member('visit-1'), member('sib-1', over)])).toBeNull();
      expect(mockResolvePosition.mock.calls.at(-1)[0].requireCurrentJobIds).toEqual(['visit-1']);
    });

    test('two addresses with NO property on file (this row, the visit and the sibling all null) never share a truck', async () => {
      const nullStop = { v_property_id: null, property_id: null };
      install(visitRow({ ...ENROUTE, en_route_at: START, visit_id: 'group-1', property_id: null }), { members: [member('visit-1', nullStop), member('sib-1', nullStop)] });
      techOnSibling();
      expect((await get()).body.vehicle).toBeNull();
      expect(mockResolvePosition.mock.calls.at(-1)[0].requireCurrentJobIds).toEqual(['visit-1']);
    });

    test('a visit that is not open, a detached viewer row, or this row on another stop admits no sibling', async () => {
      expect(await vehicleFor([member('visit-1', { v_status: 'dissolved' }), member('sib-1', { v_status: 'dissolved' })])).toBeNull();
      expect(await vehicleFor([member('visit-1', { technician_id: 'tech-2' }), member('sib-1')])).toBeNull();
      expect(await vehicleFor([member('visit-1', { scheduled_date: '2026-12-09' }), member('sib-1')])).toBeNull();
      expect(await vehicleFor([member('sib-1')])).toBeNull(); // this row is not even a live member
    });

    test('a FAILED group read answers 404 like an unknown token (strict), never a quiet "no truck"', async () => {
      mockDb.raw = jest.fn((sql) => sql);
      mockDb.mockImplementation((table) => {
        let byToken = false;
        const q = {};
        for (const m of ['join', 'whereNotIn', 'leftJoin', 'whereNotNull', 'whereRaw', 'select', 'orderBy', 'limit']) q[m] = jest.fn(() => q);
        q.where = jest.fn((arg) => { if (arg && arg['s.track_view_token']) byToken = true; return q; });
        q.first = jest.fn(async () => (table === 'scheduled_services as s' && !byToken ? grouped() : null));
        q.then = (resolve, reject) => (table === 'scheduled_services as m' ? Promise.reject(Object.assign(new Error('x'), { code: '57P01' })) : Promise.resolve([])).then(resolve, reject);
        return q;
      });
      techOnSibling();
      expect((await get()).statusCode).toBe(404);
    });

    test('an ungrouped visit makes no group read at all', async () => {
      const tablesRead = install(visitRow(ENROUTE), { members: [member('visit-1'), member('sib-1')] });
      techOnSibling();
      expect((await get()).body.vehicle).toBeNull();
      expect(tablesRead).not.toContain('scheduled_services as m');
    });
  });

  test('the cached fix must be from THIS drive: the resolver is asked for fixes strictly after the visit\'s en_route_at', async () => {
    install(visitRow(ENROUTE));
    await get();
    expect(mockResolvePosition.mock.calls.at(-1)[0].requireFixAfter).toBe(ENROUTE.en_route_at);
  });

  test('buildVehicle for a recipient serves coordinates only when status AND track state are both en route', async () => {
    const { buildVehicle } = trackPublicRouter._test;
    const base_ = visitRow(ENROUTE);
    for (const mixed of [{ status: 'on_site' }, { track_state: 'on_property' }, { status: 'confirmed' }, { track_state: 'scheduled' }]) {
      mockResolvePosition.mockClear();
      expect(await buildVehicle({ ...base_, ...mixed }, { readOnly: true })).toBeNull();
      expect(mockResolvePosition).not.toHaveBeenCalled();
    }
    install(visitRow(ENROUTE));
    expect(await buildVehicle(base_, { readOnly: true })).not.toBeNull();
  });

  test('en route with no en_route_at on record: the link is ineligible (404), and buildVehicle itself reads no position', async () => {
    install(visitRow({ ...ENROUTE, en_route_at: null }));
    expect((await get()).statusCode).toBe(404);
    const { buildVehicle } = trackPublicRouter._test;
    mockResolvePosition.mockClear();
    expect(await buildVehicle({ ...visitRow(ENROUTE), en_route_at: null }, { readOnly: true })).toBeNull();
    expect(mockResolvePosition).not.toHaveBeenCalled();
  });

  test.each([
    ['en route more than 3 h ago', { ...ENROUTE, en_route_at: minutesAgo(181) }],
    ['on site more than 4 h after arrival', { ...ONSITE, arrived_at: minutesAgo(241) }],
    ['on site with neither arrived_at nor en_route_at', { ...ONSITE, arrived_at: null, en_route_at: null }],
  ])('the live-state cap: %s answers 404 on the GET', async (_label, over) => {
    install(visitRow(over));
    expect((await get()).statusCode).toBe(404);
  });

  test('a FAILED tech_status read (strict) answers 404 exactly as an unknown token, with a code-only log; a read with no usable fix is a 200 with vehicle null', async () => {
    const logger = require('../services/logger');
    // the unknown-token baseline
    install(null);
    mockVisitForTrackToken.mockResolvedValueOnce(null);
    const unknownAnswer = await get().then((r) => ({ statusCode: r.statusCode, body: r.body }));
    // a failed read
    install(visitRow(ENROUTE));
    mockResolvePosition.mockRejectedValueOnce(Object.assign(new Error('select ... tech-secret-1 - connection terminated +19415550123'), { code: '57P01' }));
    const failed = await get();
    expect({ statusCode: failed.statusCode, body: failed.body }).toEqual(unknownAnswer);
    expect(mockResolvePosition.mock.calls.at(-1)[0].strict).toBe(true);
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('code=57P01');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('9415550123');
    // a successful read with no usable fix
    install(visitRow(ENROUTE));
    mockResolvePosition.mockResolvedValueOnce(null);
    const noFix = await get();
    expect(noFix.statusCode).toBe(200);
    expect(noFix.body.state).toBe('en_route');
    expect(noFix.body.vehicle).toBeNull();
  });

  test('the technician has moved on to another stop (the resolver answers no position): no vehicle at all', async () => {
    mockResolvePosition.mockResolvedValueOnce(null);
    install(visitRow(ENROUTE));
    const { body } = await get();
    expect(body.state).toBe('en_route');
    expect(body.vehicle).toBeNull();
  });

  test('en route with no stored pin: no map (vehicle null), never a geocode', async () => {
    install(visitRow({ ...ENROUTE, latitude: null, longitude: null }));
    const { body } = await get();
    expect(body.state).toBe('en_route');
    expect(body.vehicle).toBeNull();
    expect(body.property).toEqual({ lat: null, lng: null, city: 'Parrish' });
    expect(mockGeocode).not.toHaveBeenCalled();
  });

  test('the holder\'s own en-route GET still geocodes, fetches and asks the provider (unchanged)', async () => {
    const row = visitRow({ ...ENROUTE, latitude: null, longitude: null });
    install(row, { holderRow: row });
    mockGeocode.mockResolvedValue(null);
    await get(HOLDER_TOKEN);
    expect(mockGeocode).toHaveBeenCalled();
  });

  test('the property is the pin and the town, never the street, unit or zip', async () => {
    install(visitRow(ENROUTE));
    const { body } = await get();
    expect(body.property).toEqual({ lat: 27.2, lng: -82.2, city: 'Parrish' });
    expect(body.service).toEqual({ type: 'Pest Control' });
    expect(body.tech).toEqual({ firstName: 'Pat', photoUrl: 'https://img.test/pat.jpg', yearsWithWaves: null });
  });

  test('en route: the whitelisted vehicle fields and a 30 s poll; on property polls too; complete does not', async () => {
    install(visitRow(ENROUTE));
    const enRoute = (await get()).body;
    expect(enRoute.state).toBe('en_route');
    expect(Object.keys(enRoute.vehicle).sort()).toEqual(['etaMinutes', 'etaSource', 'lastReportedAt', 'lat', 'lng', 'stale']);
    expect(enRoute.meta).toEqual({ pollIntervalSeconds: 30 });
    install(visitRow(ONSITE));
    expect((await get()).body.meta).toEqual({ pollIntervalSeconds: 30 });
    install(visitRow(DONE(5)));
    expect((await get()).body.meta).toEqual({ pollIntervalSeconds: 0 });
  });

  test('complete is a plain done state: no summary, no links, no cards', async () => {
    install(visitRow(DONE(5)));
    const { body } = await get();
    expect(body.state).toBe('complete');
    expect(body.vehicle).toBeNull();
    expect(Object.keys(body).sort()).toEqual(ALLOWED_KEYS.slice().sort());
  });
});

describe('the HOLDER\'s GET: the socket-connect refetch (?refresh=socket) makes no paid ETA call', () => {
  const enRouteHolder = () => visitRow({ ...ENROUTE, en_route_at: minutesAgo(10) });
  test('the flag asks for the no-provider ETA; the plain GET and the poll leave the provider allowed', async () => {
    install(enRouteHolder(), { holderRow: enRouteHolder() });
    mockEta.mockClear();
    expect((await get(HOLDER_TOKEN, { refresh: 'socket' })).statusCode).toBe(200);
    expect(mockEta).toHaveBeenCalledTimes(1);
    expect(mockEta.mock.calls[0][0].allowProvider).toBe(false);

    mockEta.mockClear();
    install(enRouteHolder(), { holderRow: enRouteHolder() });
    expect((await get(HOLDER_TOKEN)).statusCode).toBe(200);
    expect(mockEta).toHaveBeenCalledTimes(1);
    expect(mockEta.mock.calls[0][0]).not.toHaveProperty('allowProvider');

    // any other value of the flag is not the flag
    mockEta.mockClear();
    install(enRouteHolder(), { holderRow: enRouteHolder() });
    await get(HOLDER_TOKEN, { refresh: 'yes' });
    expect(mockEta.mock.calls[0][0]).not.toHaveProperty('allowProvider');
  });

  test('buildVehicle: allowProvider false reaches the ETA call, the default does not set it', async () => {
    const { buildVehicle } = trackPublicRouter._test;
    mockEta.mockClear();
    await buildVehicle(enRouteHolder(), { readOnly: false, allowProvider: false });
    expect(mockEta.mock.calls[0][0].allowProvider).toBe(false);
    mockEta.mockClear();
    await buildVehicle(enRouteHolder(), { readOnly: false });
    expect(mockEta.mock.calls[0][0]).not.toHaveProperty('allowProvider');
  });
});

describe('ONE eligibility rule: an ineligible recipient token answers exactly as an unknown token, on all three routes', () => {
  const run = async (path, method, token = RECIPIENT_TOKEN) => {
    const res = { statusCode: 200, body: undefined, headers: {}, set: jest.fn((h) => { Object.assign(res.headers, h); return res; }), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn((b) => { res.body = b; return res; }), end: jest.fn(() => res) };
    await find(path, method)({ params: { token }, headers: {}, get: () => null }, res, jest.fn());
    return { statusCode: res.statusCode, body: res.body, headers: res.headers };
  };
  const ROUTES = [['/:token', 'get'], ['/:token/stops-ahead', 'post'], ['/:token/view', 'post']];
  const unknown = async (path, method) => {
    install(null);
    mockVisitForTrackToken.mockResolvedValue(null);
    const out = await run(path, method);
    mockVisitForTrackToken.mockResolvedValue({ visitId: 'visit-1', recipientId: 'r-1', customerId: 'cust-1' });
    return out;
  };

  test.each(ROUTES)('%s (%s): a PARKED row that is en route by status and track state (customer pick set, no window) is the same 404 as an unknown token', async (path, method) => {
    const expected = await unknown(path, method);
    expect(expected.statusCode).toBe(404);
    install(visitRow({ ...ENROUTE, customer_pick_by: '2026-11-20T00:00:00Z', window_start: null, window_end: null }));
    expect(await run(path, method)).toEqual(expected);
  });

  test.each(ROUTES)('%s (%s): a visit REASSIGNED to another customer after the row was bound is the same 404 as an unknown token', async (path, method) => {
    const expected = await unknown(path, method);
    // the module's answer is bound to cust-1; the visit row the route reads now belongs to cust-2 (the final payload lookup)
    install(visitRow({ ...ENROUTE, customer_id: 'cust-2' }));
    expect(await run(path, method)).toEqual(expected);
    // a module answer with no customer binding at all is never served either
    install(visitRow(ENROUTE));
    mockVisitForTrackToken.mockResolvedValueOnce({ visitId: 'visit-1', recipientId: 'r-1' });
    expect(await run(path, method)).toEqual(expected);
    // control: bound and unchanged
    install(visitRow(ENROUTE));
    expect((await run(path, method)).statusCode).not.toBe(404);
  });

  test.each(ROUTES)('%s (%s): every other ineligible row is the same 404 as an unknown token', async (path, method) => {
    const expected = await unknown(path, method);
    for (const over of [
      { status: 'confirmed', track_state: 'scheduled' },
      { status: 'rescheduled', track_state: 'en_route' },
      { status: 'on_site', track_state: 'en_route' },
      { ...ENROUTE, track_token_expires_at: null },
      DONE(130),
      { status: 'cancelled', track_state: 'cancelled' },
      // the live-state caps: a tech who never tapped on or off must not keep the link open
      { ...ENROUTE, en_route_at: minutesAgo(181) },
      { ...ENROUTE, en_route_at: null },
      { ...ONSITE, arrived_at: minutesAgo(241) },
      { ...ONSITE, arrived_at: null, en_route_at: null },
    ]) {
      install(visitRow(over));
      expect(await run(path, method)).toEqual(expected);
    }
  });

  test.each(ROUTES)('%s (%s): an eligible row is NOT the unknown answer', async (path, method) => {
    const expected = await unknown(path, method);
    install(visitRow(ENROUTE));
    expect((await run(path, method)).statusCode).not.toBe(expected.statusCode);
  });
});

describe('POST /:token/stops-ahead and /:token/view with a recipient token', () => {
  const post = async (path, token = RECIPIENT_TOKEN) => {
    const res = { statusCode: 200, body: undefined, set: jest.fn(() => res), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn((b) => { res.body = b; return res; }), end: jest.fn(() => res) };
    await find(path, 'post')({ params: { token }, headers: {}, get: () => null }, res, jest.fn());
    return res;
  };

  test('stops-ahead answers the generic state, computes nothing and writes nothing', async () => {
    install(visitRow(ENROUTE));
    const res = await post('/:token/stops-ahead');
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ stopsAhead: null, routeProgress: null });
    expect(mockCompute).not.toHaveBeenCalled();
  });

  test('view answers 204 and records no customer page view', async () => {
    install(visitRow(ENROUTE));
    const res = await post('/:token/view');
    expect(res.statusCode).toBe(204);
    expect(mockRecordPageView).not.toHaveBeenCalled();
  });

  test.each(['/:token/stops-ahead', '/:token/view'])('%s: 404 when the link does not resolve', async (path) => {
    install(visitRow(ENROUTE));
    mockVisitForTrackToken.mockResolvedValue(null);
    expect((await post(path)).statusCode).toBe(404);
  });

  test.each(['/:token/stops-ahead', '/:token/view'])('%s: 404 when the visit\'s link has expired or has no expiry on record', async (path) => {
    for (const expiry of ['2000-01-01T00:00:00.000Z', null]) {
      install(visitRow({ ...ENROUTE, track_token_expires_at: expiry }));
      expect((await post(path)).statusCode).toBe(404);
    }
  });

  test.each(['/:token/stops-ahead', '/:token/view'])('%s: 404 outside the lifetime (scheduled, cancelled, skipped, parked, 2 h after completion)', async (path) => {
    for (const over of [
      { status: 'confirmed', track_state: 'scheduled' },
      { status: 'cancelled', track_state: 'cancelled' },
      { status: 'skipped', track_state: 'scheduled' },
      { status: 'rescheduled', track_state: 'scheduled' },
      DONE(130),
    ]) {
      install(visitRow(over));
      expect((await post(path)).statusCode).toBe(404);
    }
  });

  test.each(['/:token/stops-ahead', '/:token/view'])('%s: opens while en route, on site, or within 2 h of completion', async (path) => {
    for (const over of [ENROUTE, ONSITE, DONE(60)]) {
      install(visitRow(over));
      expect([200, 204]).toContain((await post(path)).statusCode);
    }
  });
});

describe('no route forwards or logs the bearer token when the FIRST query fails', () => {
  const logger = require('../services/logger');
  const knexLike = (token) => Object.assign(
    new Error(`select "s"."id" from "scheduled_services" as "s" where "s"."track_view_token" = '${token}' - connection terminated`),
    { code: '57P01' },
  );
  const failFirstQuery = (token) => {
    mockDb.raw = jest.fn((sql) => sql);
    mockDb.mockImplementation(() => {
      const q = {};
      for (const m of ['where', 'leftJoin', 'whereNotNull', 'orderBy', 'whereRaw', 'select', 'limit']) q[m] = jest.fn(() => q);
      q.first = jest.fn(async () => { throw knexLike(token); });
      return q;
    });
  };
  const run = async (path, method, token) => {
    const res = { statusCode: 200, set: jest.fn(() => res), status: jest.fn((c) => { res.statusCode = c; return res; }), json: jest.fn(() => res), end: jest.fn(() => res) };
    const next = jest.fn();
    await find(path, method)({ params: { token }, headers: {}, get: () => null }, res, next);
    return { res, next };
  };

  test.each([
    ['/:token', 'get'],
    ['/:token/stops-ahead', 'post'],
  ])('%s: next() gets a fresh error with only the driver code', async (path, method) => {
    const token = 'c'.repeat(64);
    failFirstQuery(token);
    const { next } = await run(path, method, token);
    expect(next).toHaveBeenCalledTimes(1);
    const [err] = next.mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe('57P01');
    expect(`${err.message}\n${err.stack}`).not.toContain(token);
    expect(JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls, logger.info.mock.calls])).not.toContain(token);
  });

  test('/:token/view: answers 204, forwards nothing, logs no token', async () => {
    const token = 'c'.repeat(64);
    failFirstQuery(token);
    const { res, next } = await run('/:token/view', 'post', token);
    expect(res.statusCode).toBe(204);
    expect(next).not.toHaveBeenCalled();
    expect(JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls])).not.toContain(token);
  });

  test('every token route in the router is wrapped by the one sanitizer', () => {
    const routes = trackPublicRouter.stack.filter((l) => l.route);
    expect(routes.length).toBeGreaterThanOrEqual(3);
    for (const layer of routes) expect(layer.route.stack[0].handle.name).toBe('trackRoute');
  });

  test('a handler that throws (not just next(err)) is sanitized too', async () => {
    const token = 'd'.repeat(64);
    mockVisitForTrackToken.mockRejectedValue(knexLike(token));
    install(null);
    const { next } = await run('/:token', 'get', token);
    const [err] = next.mock.calls[0];
    expect(`${err.message}\n${err.stack}`).not.toContain(token);
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
