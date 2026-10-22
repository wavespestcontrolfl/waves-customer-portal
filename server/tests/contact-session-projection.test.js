'use strict';

// Contact session (GATE_CONTACT_LOGIN) response projections (codex #6363 r2
// P2 ×2): a contact's /api/schedule payloads carry no action bearer, and a
// contact the report rule withholds from reads /api/services without report
// artifacts — the same verdict /api/documents already applied.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })) }));
jest.mock('../services/cancellation-eligibility', () => ({ hasCancellableWork: jest.fn(async () => true) }));
jest.mock('../services/reservice-scheduler', () => ({
  reserviceSelfServeEnabled: () => true,
  reserviceLanesForCustomer: jest.fn(async () => ['pest']),
}));
jest.mock('../services/portal-service-history', () => ({
  listPortalServiceHistory: jest.fn(),
  parseJsonObject: () => ({}),
  suppressesCustomerArtifacts: () => false,
  scopeRecordsToProperty: jest.fn((q) => q),
}));
jest.mock('../services/celsius-application-count', () => ({ celsiusApplicationsThisYear: jest.fn(async () => 1) }));
jest.mock('../services/context-aggregator', () => ({ customerSafeVisitNotes: () => 'Treated the lanai perimeter.' }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn(async () => 'https://cdn/photo'), CUSTOMER_DWELL_TTL_SECONDS: 3600 }));
jest.mock('../services/account-properties', () => ({
  resolveSessionScope: jest.fn(async () => null),
  resolvedScopePayload: () => ({ enabled: false }),
  isSecondarySelection: () => false,
  applyPropertyPredicate: jest.fn((q) => q),
}));
const mockSession = {};
jest.mock('../middleware/auth', () => ({
  authenticate: (req, _res, next) => {
    req.customerId = 'cust-1';
    req.customer = { id: 'cust-1', first_name: 'Pat', last_name: 'Customer', contact_role: mockSession.accountRole || null };
    if (mockSession.contact) req.contactSession = mockSession.contact;
    next();
  },
}));

const express = require('express');
const db = require('../models/db');
const { listPortalServiceHistory, scopeRecordsToProperty } = require('../services/portal-service-history');
const { resolveSessionScope, applyPropertyPredicate } = require('../services/account-properties');
const { celsiusApplicationsThisYear } = require('../services/celsius-application-count');
const projection = require('../services/contact-session-projection');

// A multi-property profile's saved-property rows, and the PRIMARY scope a
// contact's reads resolve from them — whatever GATE_APP_PROPERTY_SCOPE says.
const PROPERTY_ROWS = [{ id: 'prop-1', customer_id: 'cust-1', active: true, is_primary: true }, { id: 'prop-2', customer_id: 'cust-1', active: true, is_primary: false }];
const PRIMARY_SCOPE = { customerId: 'cust-1', enabled: true, multi: true, scoped: true, closed: false, property: PROPERTY_ROWS[0] };
// Table-aware db: the saved-property rows, else the given rows by table, else nothing.
function wireTables(byTable, properties = PROPERTY_ROWS) {
  db.mockImplementation((table) => chain(table === 'customer_properties' ? properties : (byTable[table] || [])));
}

const OCCUPANT = { slot: 'service_contact', name: 'Sam', phone: '+19415550202', contactRole: '', phoneKey: '9415550202' };
const TENANT = { ...OCCUPANT, contactRole: 'tenant' };

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNotNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'leftJoin', 'select', 'orderBy', 'count']) c[m] = jest.fn(() => c);
  c.first = jest.fn(async () => rows[0] || null);
  c.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return c;
}

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/schedule', require('../routes/schedule'));
  app.use('/services', require('../routes/services'));
  app.use((err, _req, res, _next) => res.status(500).json({ error: err.message }));
  const server = app.listen(0);
  try {
    await fn(async (path) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}${path}`);
      return { status: res.status, body: await res.json() };
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  delete mockSession.contact; delete mockSession.accountRole;
  db.raw = jest.fn((sql) => sql);
  process.env.GATE_RESERVICE_SELF_SERVE = 'true';
  process.env.GATE_RESERVICE_STREAMLINE = 'true';
});
afterEach(() => {
  delete process.env.GATE_RESERVICE_SELF_SERVE;
  delete process.env.GATE_RESERVICE_STREAMLINE;
});

describe('pure projections', () => {
  test('withholdReportArtifacts rewrites only the artifact keys the payload carries', () => {
    const row = {
      id: 'svc-1', date: '2026-10-01', type: 'Pest Control', technician: 'Adam', notes: 'Treated.', soilTemp: 71,
      products: [{ product_name: 'Alpine' }], hasPhotos: true, photoCount: 2, reportUrl: '/report/tok', reportPdfUrl: '/api/reports/tok',
      reportToken: 'tok', reportGeneratedAt: '2026-10-01', reportViewedAt: null, reportAvailable: true, projectReportPortalAttached: true,
    };
    expect(projection.withholdReportArtifacts(row)).toEqual({
      ...row, notes: null, products: [], hasPhotos: false, photoCount: 0, reportUrl: null, reportPdfUrl: null, reportToken: null,
      reportGeneratedAt: null, reportViewedAt: null, reportAvailable: false, projectReportPortalAttached: false, soilTemp: null,
    });
    // The detail shape has photos and a measurements object; the list shape
    // has neither — neither gains a key (codex r16: the measurements go too).
    expect(projection.withholdReportArtifacts({ id: 'd', notes: 'x', photos: [{ url: 'u' }], measurements: { soilTemp: 71, thatchMeasurement: 0.5, soilPh: 6.5, soilMoisture: 'dry' } }))
      .toEqual({ id: 'd', notes: null, photos: [], measurements: { soilTemp: null, thatchMeasurement: null, soilPh: null, soilMoisture: null } });
    expect(JSON.stringify(projection.withholdReportArtifacts(row))).not.toMatch(/tok|71/);
  });

  test('contactRecordScope / scopeContactRecords: a contact\'s record reads carry the PRIMARY saved-property scope built from the rows — never the holder\'s gate-dependent resolver; a holder\'s carry none (codex r16 P1 + security P1)', async () => {
    const req = { customerId: 'cust-1', customer: { id: 'cust-1' }, contactSession: OCCUPANT };
    wireTables({});
    expect(await projection.contactRecordScope(req)).toEqual(PRIMARY_SCOPE);
    expect(resolveSessionScope).not.toHaveBeenCalled();
    // One primary row: still scoped (a visit stamped to a retired house stays out).
    wireTables({}, [PROPERTY_ROWS[0]]);
    expect(await projection.contactRecordScope(req)).toMatchObject({ enabled: true, multi: false, scoped: true, property: PROPERTY_ROWS[0] });
    // No active row: a profile that never had one keeps its customer-wide reads; one whose rows were all retired is closed.
    wireTables({}, []);
    expect(await projection.contactRecordScope(req)).toMatchObject({ enabled: true, scoped: false, closed: false, property: null });
    wireTables({}, [{ id: 'retired', customer_id: 'cust-1', active: false, is_primary: true }]);
    expect(await projection.contactRecordScope(req)).toMatchObject({ enabled: true, scoped: true, closed: true, property: null });
    // Several rows at once (the contact's property list): ONE customer_properties read for all of them (codex #6364 r2 P2).
    wireTables({}, [...PROPERTY_ROWS, { id: 'retired-2', customer_id: 'cust-2', active: false, is_primary: true }]);
    db.mockClear();
    const scopes = await projection.contactRecordScopes(['cust-1', 'cust-2', 'cust-3']);
    expect(db.mock.calls.filter(([table]) => table === 'customer_properties')).toHaveLength(1);
    expect(scopes.get('cust-1')).toEqual(PRIMARY_SCOPE);
    expect(scopes.get('cust-2')).toMatchObject({ customerId: 'cust-2', scoped: true, closed: true, property: null });
    expect(scopes.get('cust-3')).toMatchObject({ customerId: 'cust-3', scoped: false, closed: false, property: null });
    expect(await projection.contactRecordScope({ customerId: 'cust-1', customer: { id: 'cust-1' } })).toBeNull();
    const q = { marker: true };
    expect(projection.scopeContactRecords(q, PRIMARY_SCOPE)).toBe(q);
    expect(scopeRecordsToProperty).toHaveBeenCalledWith(q, PRIMARY_SCOPE);
    scopeRecordsToProperty.mockClear();
    expect(projection.scopeContactRecords(q, null)).toBe(q);
    expect(scopeRecordsToProperty).not.toHaveBeenCalled();
  });

  test('sessionRecordScope: a contact resolves its own scope, a holder the saved-property resolver; contactAddress names the scoped house, not a retired primary (codex r20 P2)', async () => {
    wireTables({});
    expect(await projection.sessionRecordScope({ customerId: 'cust-1', contactSession: OCCUPANT })).toEqual(PRIMARY_SCOPE);
    expect(resolveSessionScope).not.toHaveBeenCalled();
    resolveSessionScope.mockResolvedValueOnce({ marker: 'holder' });
    expect(await projection.sessionRecordScope({ customerId: 'cust-1' })).toEqual({ marker: 'holder' });

    const customer = { address_line1: '1 Gulf Dr', address_line2: null, city: 'Bradenton', state: 'FL', zip: '34205' };
    const oak = { id: 'prop-2', is_primary: false, address_line1: '99 Oak St', address_line2: 'Unit B', city: 'Venice', state: 'FL', zip: '34293' };
    // The active row standing in for a retired primary is the house named.
    expect(projection.contactAddress(customer, { ...PRIMARY_SCOPE, property: oak }))
      .toEqual({ line1: '99 Oak St', line2: 'Unit B', city: 'Venice', state: 'FL', zip: '34293' });
    // Every row retired: no house to name — never the row's retired address.
    expect(projection.contactAddress(customer, { ...PRIMARY_SCOPE, scoped: true, closed: true, property: null }))
      .toEqual({ line1: null, line2: null, city: null, state: null, zip: null });
    // Never had a saved-property row: the profile's one address.
    expect(projection.contactAddress(customer, { ...PRIMARY_SCOPE, scoped: false, closed: false, property: null }))
      .toEqual({ line1: '1 Gulf Dr', line2: null, city: 'Bradenton', state: 'FL', zip: '34205' });
  });

  test('contactSafeReportLinks: the public /report and /api/reports bearers go, the authed PDF route stays; a project completion offers no report', () => {
    const row = { id: 'svc-1', notes: 'kept', reportUrl: '/report/t', reportPdfUrl: '/api/reports/t', reportToken: 't', reportAvailable: true, projectReportPortalAttached: false };
    expect(projection.contactSafeReportLinks(row)).toEqual({ ...row, reportUrl: null, reportPdfUrl: '/api/documents/service-report/svc-1', reportToken: null });
    expect(projection.contactSafeReportLinks({ ...row, reportAvailable: false, reportUrl: null, reportPdfUrl: null, reportToken: null }))
      .toMatchObject({ reportPdfUrl: null, reportAvailable: false });
    expect(projection.contactSafeReportLinks({ ...row, isProjectCompletion: true, projectReportPortalAttached: true, reportUrl: '/report/project/p' }))
      .toMatchObject({ reportUrl: null, reportPdfUrl: null, reportToken: null, reportAvailable: false, projectReportPortalAttached: false });
    expect(projection.contactSafeReportLinks({ id: 'x', date: '2026-10-01' })).toEqual({ id: 'x', date: '2026-10-01' });
  });

  test('contactSafeReportCustomer addresses the PDF to the contact and withholds the holder\'s name, phone, email and plan', () => {
    const holder = { id: 'c', first_name: 'Pat', last_name: 'Owner', phone: '+19415550101', email: 'pat@example.com', waveguard_tier: 'gold', monthly_rate: '120.00',
      address_line1: '1 Gulf Dr', city: 'Bradenton', state: 'FL', zip: '34205', lawn_type: 'St. Augustine', property_sqft: 8000 };
    const out = projection.contactSafeReportCustomer(holder, { name: 'Sam Spouse', phone: '+19415550202', email: null });
    expect(out).toEqual({ ...holder, first_name: 'Sam', last_name: 'Spouse', phone: '+19415550202', email: '', waveguard_tier: null, monthly_rate: null });
    expect(JSON.stringify(out)).not.toMatch(/Pat|Owner|0101|pat@|gold|120/);
    // A legacy record with no frozen address: the PDF is labeled with the
    // house the contact is scoped to, never the row's retired primary (codex r33 P2).
    const oak = { line1: '99 Oak St', line2: 'Unit B', city: 'Venice', state: 'FL', zip: '34293' };
    expect(projection.contactSafeReportCustomer(holder, { name: 'Sam Spouse' }, { address: oak }))
      .toMatchObject({ address_line1: '99 Oak St', address_line2: 'Unit B', city: 'Venice', state: 'FL', zip: '34293' });
    expect(projection.contactSafeReportCustomer(holder, { name: 'Sam Spouse' }, { address: null }).address_line1).toBe('1 Gulf Dr');
  });

  test('withoutTrackBearers keeps the live tracker and drops the public /track bearer', () => {
    const tracker = { id: 's', state: 'en_route', currentStep: 3, trackToken: 'tt', trackUrl: '/track/tt', etaMinutes: 12, steps: [] };
    expect(projection.withoutTrackBearers(tracker)).toEqual({ ...tracker, trackToken: null, trackUrl: null });
    expect(projection.withoutTrackBearers(null)).toBeNull();
  });

  test('contactSchedulePayload / contactNextPayload drop every bearer, the re-service card, the cancellable flag and the plan signals (codex r15)', () => {
    const out = projection.contactSchedulePayload({
      hasCancellableWork: true, reservice: { url: '/reservice/rt', lanes: ['pest'] }, overlayHandoff: true,
      upcoming: [{
        id: 'a', date: '2099-01-05', serviceType: 'Pest Control', status: 'confirmed', technician: 'Adam', serviceDisplayName: null,
        isRecurring: true, isCallback: false, waveguardQualifying: true, serviceFamily: 'pest',
        rescheduleUrl: '/reschedule/t1', calendarUrl: '/api/public/appointment/t1/calendar.ics', calendarExpiresAt: '2099-01-05T17:00:00Z',
      }],
    });
    expect(out.hasCancellableWork).toBe(false);
    expect(out.reservice).toBeNull();
    expect(out.overlayHandoff).toBe(false);
    expect(out.upcoming[0]).toEqual({
      id: 'a', date: '2099-01-05', serviceType: 'Pest Control', status: 'confirmed', technician: 'Adam', serviceDisplayName: null,
      rescheduleUrl: null, calendarUrl: null, calendarExpiresAt: null,
    });
    for (const key of projection._test.PLAN_SIGNAL_KEYS) expect(key in out.upcoming[0]).toBe(false);
    expect(projection.contactNextPayload({ next: null })).toEqual({ next: null, propertyScope: { enabled: false, propertyId: null, closed: false } });
    expect(out.propertyScope).toEqual({ enabled: false, propertyId: null, closed: false });
    expect(projection.contactNextPayload({ next: { id: 'n', isRecurring: true, isCallback: true, rescheduleUrl: '/reschedule/t', calendarUrl: 'c', calendarExpiresAt: 'e' } }).next)
      .toEqual({ id: 'n', rescheduleUrl: null, calendarUrl: null, calendarExpiresAt: null });
  });

  test('contactSessionReportsWithheld: never for a holder; tenant yes; unlabeled occupant only on a managed account', async () => {
    db.mockImplementation(() => chain([]));
    expect(await projection.contactSessionReportsWithheld({ customer: { id: 'c' } })).toBe(false);
    expect(await projection.contactSessionReportsWithheld({ customer: { id: 'c', contact_role: null }, contactSession: TENANT })).toBe(true);
    expect(await projection.contactSessionReportsWithheld({ customer: { id: 'c', contact_role: null }, contactSession: OCCUPANT })).toBe(false);
    expect(await projection.contactSessionReportsWithheld({ customer: { id: 'c', contact_role: 'property_manager' }, contactSession: OCCUPANT })).toBe(true);
  });

  test('deny wins across every slot carrying the number: an allowed slot 1 does not open reports a tenant slot 2 withholds (codex r4)', async () => {
    db.mockImplementation(() => chain([]));
    const twice = {
      id: 'c', contact_role: null,
      service_contact_name: 'Sam', service_contact_phone: '+19415550202', service_contact_role: null,
      service_contact2_name: 'Sam', service_contact2_phone: '(941) 555-0202', service_contact2_role: 'tenant',
    };
    // The login matched slot 1 (unlabeled); the verdict still sees slot 2.
    expect(await projection.contactSessionReportsWithheld({ customer: twice, contactSession: OCCUPANT })).toBe(true);
    // The same number in two allowed slots stays allowed.
    expect(await projection.contactSessionReportsWithheld({ customer: { ...twice, service_contact2_role: null }, contactSession: OCCUPANT })).toBe(false);
  });
});

describe('GET /schedule and /schedule/next for a contact session', () => {
  const row = {
    id: 'svc-1', scheduled_date: '2099-01-05', window_start: '08:00:00', window_end: '10:00:00', service_type: 'Pest Control',
    status: 'confirmed', technician_name: 'Adam', customer_confirmed: true, is_recurring: true, reschedule_token: 'tok-1',
  };
  const customerRow = { id: 'cust-1', active: true, waveguard_tier: 'gold', monthly_rate: '120', reservice_token: 'rt-1' };

  const scheduleTables = { scheduled_services: [row], customers: [customerRow] };

  test('the holder keeps the reschedule link, the re-service card and the overlay handoff — and reads through the saved-property resolver, never the contact scope', async () => {
    wireTables(scheduleTables);
    await withServer(async (get) => {
      const { body } = await get('/schedule');
      expect(body.upcoming[0].rescheduleUrl).toBe('/reschedule/tok-1');
      expect(body.reservice).toEqual({ url: '/reservice/rt-1', lanes: ['pest'] });
      expect(body.overlayHandoff).toBe(true);
      expect(resolveSessionScope).toHaveBeenCalled();
      expect(applyPropertyPredicate).not.toHaveBeenCalledWith(expect.anything(), PRIMARY_SCOPE);
    });
  });

  test('a contact gets the same visits with no bearer, no re-service card, no handoff — scoped to the PRIMARY property whatever the holder gate says, echoing the scope off (codex r16 security P1)', async () => {
    mockSession.contact = OCCUPANT;
    wireTables(scheduleTables);
    await withServer(async (get) => {
      const { status, body } = await get('/schedule');
      expect(status).toBe(200);
      expect(body.upcoming[0]).toMatchObject({ id: 'svc-1', date: '2099-01-05', technician: 'Adam', rescheduleUrl: null, calendarUrl: null, calendarExpiresAt: null });
      expect(body.reservice).toBeNull();
      expect(body.overlayHandoff).toBe(false);
      // The holder's plan facts stay off the ordinary payload too (codex r15).
      expect(body.hasCancellableWork).toBe(false);
      for (const key of ['isRecurring', 'isCallback', 'waveguardQualifying', 'serviceFamily']) expect(body.upcoming[0]).not.toHaveProperty(key);
      expect(JSON.stringify(body)).not.toMatch(/tok-1|rt-1/);
      // The visit query carried the primary-property predicate, built without the holder's resolver.
      expect(resolveSessionScope).not.toHaveBeenCalled();
      expect(applyPropertyPredicate).toHaveBeenCalledWith(expect.anything(), PRIMARY_SCOPE);
      expect(body.propertyScope).toEqual({ enabled: false, propertyId: null, closed: false });
    });
    applyPropertyPredicate.mockClear();
    await withServer(async (get) => {
      const { body } = await get('/schedule/next');
      expect(body.next).toMatchObject({ id: 'svc-1', rescheduleUrl: null, calendarUrl: null, calendarExpiresAt: null });
      expect(body.next).not.toHaveProperty('isRecurring');
      expect(body.next).not.toHaveProperty('isCallback');
      expect(JSON.stringify(body)).not.toContain('tok-1');
      expect(applyPropertyPredicate).toHaveBeenCalledWith(expect.anything(), PRIMARY_SCOPE);
      expect(body.propertyScope).toEqual({ enabled: false, propertyId: null, closed: false });
    });
  });

  test('a contact with no upcoming visit gets the empty /schedule/next answer through the same projection — the scope echo, never the resolved property id (codex r22)', async () => {
    mockSession.contact = OCCUPANT;
    wireTables({ scheduled_services: [], customers: [customerRow] });
    await withServer(async (get) => {
      const { status, body } = await get('/schedule/next');
      expect(status).toBe(200);
      expect(body).toEqual({ propertyScope: { enabled: false, propertyId: null, closed: false }, next: null });
      expect(JSON.stringify(body)).not.toContain('prop-1');
    });
  });

  test('a contact asking for allProperties=1 gets the ordinary contact projection, never the coverage payload (codex r14)', async () => {
    mockSession.contact = OCCUPANT;
    wireTables(scheduleTables);
    await withServer(async (get) => {
      const { status, body } = await get('/schedule?allProperties=1');
      expect(status).toBe(200);
      expect(body.coverageOnly).toBeUndefined();
      expect(body.upcoming[0]).toMatchObject({ id: 'svc-1', rescheduleUrl: null });
      expect(body.reservice).toBeNull();
      expect(JSON.stringify(body)).not.toMatch(/tok-1|rt-1/);
    });
    await withServer(async (get) => {
      const { body } = await get('/schedule/next?allProperties=1');
      expect(body.next).toMatchObject({ id: 'svc-1', rescheduleUrl: null });
      expect(body.propertyScope).toBeDefined();
      expect(JSON.stringify(body)).not.toContain('tok-1');
    });
  });
});

describe('GET /services for a contact session', () => {
  const listed = [{
    id: 'svc-1', date: '2026-10-01', type: 'Pest Control', technician: 'Adam', notes: 'Treated the lanai perimeter.',
    products: [{ product_name: 'Alpine' }], hasPhotos: true, photoCount: 1, reportUrl: '/report/rpt-1', reportPdfUrl: '/api/reports/rpt-1',
    reportToken: 'rpt-1', reportGeneratedAt: '2026-10-01', reportViewedAt: null, reportAvailable: true,
    soilTemp: 71, thatchMeasurement: 0.5, soilPh: 6.5, soilMoisture: 'dry',
  }];
  const record = {
    id: 'svc-1', service_date: '2026-10-01', service_type: 'Pest Control', technician_name: 'Adam', structured_notes: null,
    soil_temp: '71', thatch_measurement: '0.5', soil_ph: '6.5', soil_moisture: 'dry',
  };

  function wireDetail() {
    wireTables({
      service_records: [record],
      service_products: [{ id: 'p1', product_name: 'Alpine' }],
      service_photos: [{ id: 'ph1', photo_type: 'after', caption: '', s3_key: 'k' }],
    });
  }

  test('an occupant the rule allows reads the visits and detail, with the public report bearers replaced by the contact-safe PDF route (codex r7 P1)', async () => {
    mockSession.contact = OCCUPANT;
    listPortalServiceHistory.mockResolvedValue({ services: listed, total: 1 });
    wireDetail();
    await withServer(async (get) => {
      const list = await get('/services');
      expect(list.body.services[0]).toEqual({
        ...listed[0], reportUrl: null, reportToken: null, reportPdfUrl: '/api/documents/service-report/svc-1', reportAvailable: true,
      });
      expect(JSON.stringify(list.body)).not.toMatch(/rpt-1/);
      const detail = await get('/services/svc-1');
      expect(detail.body).toMatchObject({ id: 'svc-1', notes: 'Treated the lanai perimeter.', measurements: { soilTemp: 71, thatchMeasurement: 0.5 } });
      expect(detail.body.products).toHaveLength(1);
      expect(detail.body.photos).toHaveLength(1);
    });
  });

  test('a contact\'s list, detail, documents-style record reads and stats are scoped to the primary property; the holder\'s list stays customer-wide unless asked (codex r16 P1)', async () => {
    mockSession.contact = OCCUPANT;
    listPortalServiceHistory.mockResolvedValue({ services: listed, total: 1 });
    wireDetail();
    await withServer(async (get) => {
      const list = await get('/services');
      expect(list.status).toBe(200);
      expect(listPortalServiceHistory).toHaveBeenCalledWith('cust-1', expect.objectContaining({ scope: PRIMARY_SCOPE }));
      // The echo stays an opt-in of the propertyScoped read.
      expect(list.body.propertyScope).toBeUndefined();
      scopeRecordsToProperty.mockClear();
      const detail = await get('/services/svc-1');
      expect(detail.status).toBe(200);
      expect(scopeRecordsToProperty).toHaveBeenCalledWith(expect.anything(), PRIMARY_SCOPE);
      scopeRecordsToProperty.mockClear();
      const stats = await get('/services/stats/summary');
      expect(stats.status).toBe(200);
      expect(scopeRecordsToProperty).toHaveBeenCalledTimes(3);
      expect(celsiusApplicationsThisYear).toHaveBeenCalledWith('cust-1', expect.anything(), { propertyId: 'prop-1' });
    });
    // Every saved property retired (a CLOSED contact scope): the records match nothing and the Celsius count is 0 —
    // never the helper's "busiest lawn" fallback for a null propertyId (codex r18 P2).
    celsiusApplicationsThisYear.mockClear();
    const retired = chain([{ id: 'retired', customer_id: 'cust-1', active: false, is_primary: true }]);
    db.mockImplementation((table) => (table === 'customer_properties' ? retired : chain(table === 'service_records' ? [{ count: '0' }] : [])));
    await withServer(async (get) => {
      const stats = await get('/services/stats/summary');
      expect(stats.status).toBe(200);
      expect(stats.body.celsiusApplicationsThisYear).toBe(0);
      expect(celsiusApplicationsThisYear).not.toHaveBeenCalled();
    });
    delete mockSession.contact;
    listPortalServiceHistory.mockClear();
    scopeRecordsToProperty.mockClear();
    await withServer(async (get) => {
      await get('/services');
      expect(listPortalServiceHistory).toHaveBeenCalledWith('cust-1', expect.objectContaining({ scope: null }));
      await get('/services/svc-1');
      await get('/services/stats/summary');
      expect(scopeRecordsToProperty).not.toHaveBeenCalled();
    });
  });

  test('a tenant reads the visits with every report artifact withheld; the report token never rides the JSON', async () => {
    mockSession.contact = TENANT;
    listPortalServiceHistory.mockResolvedValue({ services: listed, total: 1 });
    wireDetail();
    await withServer(async (get) => {
      const list = await get('/services');
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(1);
      expect(list.body.services[0]).toMatchObject({
        id: 'svc-1', type: 'Pest Control', technician: 'Adam', notes: null, products: [], hasPhotos: false, photoCount: 0,
        reportUrl: null, reportPdfUrl: null, reportToken: null, reportAvailable: false,
        soilTemp: null, thatchMeasurement: null, soilPh: null, soilMoisture: null,
      });
      expect(JSON.stringify(list.body)).not.toMatch(/rpt-1|lanai|71|dry/);
      const detail = await get('/services/svc-1');
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({
        id: 'svc-1', technician: 'Adam', notes: null, products: [], photos: [],
        measurements: { soilTemp: null, thatchMeasurement: null, soilPh: null, soilMoisture: null },
      });
      expect(JSON.stringify(detail.body)).not.toMatch(/71|dry/);
      // The lawn-stats endpoint carries the same findings: withheld, every figure null (codex r16).
      const stats = await get('/services/stats/summary');
      expect(stats.status).toBe(200);
      expect(stats.body).toEqual({
        servicesYTD: null, celsiusApplicationsThisYear: null, celsiusWindow: expect.any(String), celsiusMaxPerYear: null,
        thatch: { current: null, initial: null, currentDate: null, initialDate: null }, withheld: true,
      });
    });
  });

  test('an unlabeled occupant on a property-manager account is withheld too (fail closed on the managed account)', async () => {
    mockSession.contact = OCCUPANT;
    mockSession.accountRole = 'property_manager';
    listPortalServiceHistory.mockResolvedValue({ services: listed, total: 1 });
    await withServer(async (get) => {
      const list = await get('/services');
      expect(list.body.services[0].reportToken).toBeNull();
      expect(list.body.services[0].notes).toBeNull();
    });
  });
});
