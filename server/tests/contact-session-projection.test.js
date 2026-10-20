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
}));
jest.mock('../services/context-aggregator', () => ({ customerSafeVisitNotes: () => 'Treated the lanai perimeter.' }));
jest.mock('../services/photos', () => ({ getViewUrl: jest.fn(async () => 'https://cdn/photo'), CUSTOMER_DWELL_TTL_SECONDS: 3600 }));
jest.mock('../services/account-properties', () => ({
  resolveSessionScope: jest.fn(async () => null),
  resolvedScopePayload: () => ({ enabled: false }),
  isSecondarySelection: () => false,
  applyPropertyPredicate: (q) => q,
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
const { listPortalServiceHistory } = require('../services/portal-service-history');
const projection = require('../services/contact-session-projection');

const OCCUPANT = { slot: 'service_contact', name: 'Sam', phone: '+19415550202', contactRole: '', phoneKey: '9415550202' };
const TENANT = { ...OCCUPANT, contactRole: 'tenant' };

function chain(rows) {
  const c = {};
  for (const m of ['where', 'whereIn', 'whereNull', 'whereNot', 'whereNotIn', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'leftJoin', 'select', 'orderBy']) c[m] = jest.fn(() => c);
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
      reportGeneratedAt: null, reportViewedAt: null, reportAvailable: false, projectReportPortalAttached: false,
    });
    // The detail shape has photos; the list shape has none — neither gains a key.
    expect(projection.withholdReportArtifacts({ id: 'd', notes: 'x', photos: [{ url: 'u' }] })).toEqual({ id: 'd', notes: null, photos: [] });
    expect(JSON.stringify(projection.withholdReportArtifacts(row))).not.toContain('tok');
  });

  test('contactSafeReportCustomer addresses the PDF to the contact and withholds the holder\'s name, phone, email and plan', () => {
    const holder = { id: 'c', first_name: 'Pat', last_name: 'Owner', phone: '+19415550101', email: 'pat@example.com', waveguard_tier: 'gold', monthly_rate: '120.00',
      address_line1: '1 Gulf Dr', city: 'Bradenton', state: 'FL', zip: '34205', lawn_type: 'St. Augustine', property_sqft: 8000 };
    const out = projection.contactSafeReportCustomer(holder, { name: 'Sam Spouse', phone: '+19415550202', email: null });
    expect(out).toEqual({ ...holder, first_name: 'Sam', last_name: 'Spouse', phone: '+19415550202', email: '', waveguard_tier: null, monthly_rate: null });
    expect(JSON.stringify(out)).not.toMatch(/Pat|Owner|0101|pat@|gold|120/);
  });

  test('withoutTrackBearers keeps the live tracker and drops the public /track bearer', () => {
    const tracker = { id: 's', state: 'en_route', currentStep: 3, trackToken: 'tt', trackUrl: '/track/tt', etaMinutes: 12, steps: [] };
    expect(projection.withoutTrackBearers(tracker)).toEqual({ ...tracker, trackToken: null, trackUrl: null });
    expect(projection.withoutTrackBearers(null)).toBeNull();
  });

  test('contactSchedulePayload / contactNextPayload drop every bearer and the re-service card', () => {
    const out = projection.contactSchedulePayload({
      hasCancellableWork: true, reservice: { url: '/reservice/rt', lanes: ['pest'] }, overlayHandoff: true,
      upcoming: [{ id: 'a', date: '2099-01-05', rescheduleUrl: '/reschedule/t1', calendarUrl: '/api/public/appointment/t1/calendar.ics', calendarExpiresAt: '2099-01-05T17:00:00Z' }],
    });
    expect(out.reservice).toBeNull();
    expect(out.overlayHandoff).toBe(false);
    expect(out.upcoming[0]).toEqual({ id: 'a', date: '2099-01-05', rescheduleUrl: null, calendarUrl: null, calendarExpiresAt: null });
    expect(projection.contactNextPayload({ next: null })).toEqual({ next: null });
    expect(projection.contactNextPayload({ next: { id: 'n', rescheduleUrl: '/reschedule/t', calendarUrl: 'c', calendarExpiresAt: 'e' } }).next)
      .toEqual({ id: 'n', rescheduleUrl: null, calendarUrl: null, calendarExpiresAt: null });
  });

  test('contactSessionReportsWithheld: never for a holder; tenant yes; unlabeled occupant only on a managed account', async () => {
    db.mockImplementation(() => chain([]));
    expect(await projection.contactSessionReportsWithheld({ customer: { id: 'c' } })).toBe(false);
    expect(await projection.contactSessionReportsWithheld({ customer: { id: 'c', contact_role: null }, contactSession: TENANT })).toBe(true);
    expect(await projection.contactSessionReportsWithheld({ customer: { id: 'c', contact_role: null }, contactSession: OCCUPANT })).toBe(false);
    expect(await projection.contactSessionReportsWithheld({ customer: { id: 'c', contact_role: 'property_manager' }, contactSession: OCCUPANT })).toBe(true);
  });
});

describe('GET /schedule and /schedule/next for a contact session', () => {
  const row = {
    id: 'svc-1', scheduled_date: '2099-01-05', window_start: '08:00:00', window_end: '10:00:00', service_type: 'Pest Control',
    status: 'confirmed', technician_name: 'Adam', customer_confirmed: true, is_recurring: true, reschedule_token: 'tok-1',
  };
  const customerRow = { id: 'cust-1', active: true, waveguard_tier: 'gold', monthly_rate: '120', reservice_token: 'rt-1' };

  test('the holder keeps the reschedule link, the re-service card and the overlay handoff', async () => {
    let calls = 0;
    db.mockImplementation(() => { calls += 1; return calls === 1 ? chain([row]) : chain([customerRow]); });
    await withServer(async (get) => {
      const { body } = await get('/schedule');
      expect(body.upcoming[0].rescheduleUrl).toBe('/reschedule/tok-1');
      expect(body.reservice).toEqual({ url: '/reservice/rt-1', lanes: ['pest'] });
      expect(body.overlayHandoff).toBe(true);
    });
  });

  test('a contact gets the same visits with no bearer, no re-service card, no handoff — and the token never rides the JSON', async () => {
    mockSession.contact = OCCUPANT;
    let calls = 0;
    db.mockImplementation(() => { calls += 1; return calls === 1 ? chain([row]) : chain([customerRow]); });
    await withServer(async (get) => {
      const { status, body } = await get('/schedule');
      expect(status).toBe(200);
      expect(body.upcoming[0]).toMatchObject({ id: 'svc-1', date: '2099-01-05', technician: 'Adam', rescheduleUrl: null, calendarUrl: null, calendarExpiresAt: null });
      expect(body.reservice).toBeNull();
      expect(body.overlayHandoff).toBe(false);
      expect(JSON.stringify(body)).not.toMatch(/tok-1|rt-1/);
    });
    db.mockImplementation(() => chain([row]));
    await withServer(async (get) => {
      const { body } = await get('/schedule/next');
      expect(body.next).toMatchObject({ id: 'svc-1', rescheduleUrl: null, calendarUrl: null, calendarExpiresAt: null });
      expect(JSON.stringify(body)).not.toContain('tok-1');
    });
  });
});

describe('GET /services for a contact session', () => {
  const listed = [{
    id: 'svc-1', date: '2026-10-01', type: 'Pest Control', technician: 'Adam', notes: 'Treated the lanai perimeter.',
    products: [{ product_name: 'Alpine' }], hasPhotos: true, photoCount: 1, reportUrl: '/report/rpt-1', reportPdfUrl: '/api/reports/rpt-1',
    reportToken: 'rpt-1', reportGeneratedAt: '2026-10-01', reportViewedAt: null, reportAvailable: true,
  }];
  const record = { id: 'svc-1', service_date: '2026-10-01', service_type: 'Pest Control', technician_name: 'Adam', structured_notes: null };

  function wireDetail() {
    db.mockImplementation((table) => {
      if (table === 'service_records') return chain([record]);
      if (table === 'service_products') return chain([{ id: 'p1', product_name: 'Alpine' }]);
      if (table === 'service_photos') return chain([{ id: 'ph1', photo_type: 'after', caption: '', s3_key: 'k' }]);
      return chain([]);
    });
  }

  test('an occupant the rule allows reads list and detail exactly as the holder does', async () => {
    mockSession.contact = OCCUPANT;
    listPortalServiceHistory.mockResolvedValue({ services: listed, total: 1 });
    wireDetail();
    await withServer(async (get) => {
      const list = await get('/services');
      expect(list.body.services).toEqual(listed);
      const detail = await get('/services/svc-1');
      expect(detail.body).toMatchObject({ id: 'svc-1', notes: 'Treated the lanai perimeter.' });
      expect(detail.body.products).toHaveLength(1);
      expect(detail.body.photos).toHaveLength(1);
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
      });
      expect(JSON.stringify(list.body)).not.toMatch(/rpt-1|lanai/);
      const detail = await get('/services/svc-1');
      expect(detail.status).toBe(200);
      expect(detail.body).toMatchObject({ id: 'svc-1', technician: 'Adam', notes: null, products: [], photos: [] });
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
