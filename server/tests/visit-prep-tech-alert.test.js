// visit-prep-tech-alert.js — the tech card + one-line push for a customer's
// visit-prep photo submission (PR 6, customer-visit-photos scope doc §5.4
// item 4). Gate matrix, current-technician resolution (never a stale
// snapshot), no-technician / non-assignable silence, a push failure never
// losing the card, and the exact push copy.
const mockInsertCard = jest.fn().mockResolvedValue(undefined);
const mockSendToAdminUser = jest.fn().mockResolvedValue({ sent: 1 });

jest.mock('../models/db', () => jest.fn());
// The shared per-visit ordering chain (tech-visit-notifications.js).
const mockEnqueue = jest.fn((_visitId, fn) => fn());
jest.mock('../services/tech-visit-notifications', () => ({
  enqueueForVisit: (...args) => mockEnqueue(...args),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/push-notifications', () => ({
  // The real sender runs beforeDispatch after its lookup and before the
  // provider handoff; a false return sends nothing.
  sendToAdminUsers: async (ids, notification, opts = {}) => {
    if (typeof opts.beforeDispatch === 'function' && (await opts.beforeDispatch()) === false) return { superseded: true };
    return mockSendToAdminUser(ids[0], notification);
  },
}));

const db = require('../models/db');
const logger = require('../services/logger');
const notice = require('../services/visit-prep-tech-alert');

const TECH = { id: 'tech-1', employment_status: 'active', field_dispatchable: true };

function chain(firstImpl) {
  const c = {};
  for (const m of ['where', 'forShare']) c[m] = jest.fn(() => c);
  c.first = jest.fn(firstImpl);
  return c;
}

let mockLastSvcChain = null;
// Order of lock vs. the liveness read, per test.
let mockEvents = [];
let mockLastTechChain = null;

// scheduled_services.technician_id and technicians rows are independently
// stubbed per test — the module re-reads BOTH fresh on every call, never
// from any value the caller passed in (there is none to pass: the function
// takes only scheduledServiceId/visitId).
function prime({
  svcTechnicianId = 'tech-1', techs = { 'tech-1': TECH }, visitId = 'visit-9', scheduledDate = '2026-10-02', status = 'confirmed',
  alertableAtPush = true,
} = {}) {
  // The card is written inside db.transaction; the trx is the same stub.
  db.transaction = jest.fn(async (fn) => fn(db));
  // SET LOCAL lock_timeout + the per-visit advisory lock (push transaction).
  db.raw = jest.fn(async (sql) => { mockEvents.push(/pg_advisory_xact_lock/.test(sql) ? 'lock' : 'raw'); });
  db.mockImplementation((table) => {
    if (table === 'scheduled_services as s') {
      // The last check right before the push.
      mockEvents.push('liveness');
      const c = {};
      for (const m of ['join', 'where', 'whereNotIn']) c[m] = jest.fn(() => c);
      c.first = jest.fn(async () => (alertableAtPush ? { id: 'svc-1' } : null));
      return c;
    }
    if (table === 'scheduled_services') {
      mockLastSvcChain = chain(async () => ({
        id: 'svc-1', technician_id: svcTechnicianId, visit_id: visitId, scheduled_date: scheduledDate, status,
      }));
      return mockLastSvcChain;
    }
    if (table === 'technicians') {
      const c = chain(null);
      mockLastTechChain = c;
      c.where = jest.fn((arg) => { c.first = jest.fn(async () => techs[arg.id] || null); return c; });
      return c;
    }
    if (table === 'tech_notifications') {
      return { insert: jest.fn((row) => mockInsertCard(row.technician_id, { ...row, payload: JSON.parse(row.payload) })) };
    }
    throw new Error(`unexpected table ${table}`);
  });
}

describe('notifyTechVisitPrepPhotos', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.GATE_VISIT_PREP_TECH_ALERTS;
    delete process.env.GATE_VISIT_PREP_PHOTOS;
    prime();
  });

  afterAll(() => {
    delete process.env.GATE_VISIT_PREP_TECH_ALERTS;
    delete process.env.GATE_VISIT_PREP_PHOTOS;
  });

  test('exact push copy (owner-approved, scope doc §5.4 item 4)', () => {
    expect(notice.PUSH_TITLE).toBe('A customer sent photos for a visit on your route');
  });

  describe('gate matrix', () => {
    test('both gates unset → nothing read or written', async () => {
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(db).not.toHaveBeenCalled();
      expect(mockInsertCard).not.toHaveBeenCalled();
      expect(mockSendToAdminUser).not.toHaveBeenCalled();
    });

    test('GATE_VISIT_PREP_TECH_ALERTS on, GATE_VISIT_PREP_PHOTOS off → nothing', async () => {
      process.env.GATE_VISIT_PREP_TECH_ALERTS = 'true';
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(db).not.toHaveBeenCalled();
      expect(mockInsertCard).not.toHaveBeenCalled();
    });

    test('GATE_VISIT_PREP_PHOTOS on, GATE_VISIT_PREP_TECH_ALERTS off → nothing', async () => {
      process.env.GATE_VISIT_PREP_PHOTOS = 'true';
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(db).not.toHaveBeenCalled();
      expect(mockInsertCard).not.toHaveBeenCalled();
    });

    test('a non-"true" value (e.g. "1") is off, same as unset', async () => {
      process.env.GATE_VISIT_PREP_TECH_ALERTS = '1';
      process.env.GATE_VISIT_PREP_PHOTOS = 'true';
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(mockInsertCard).not.toHaveBeenCalled();
    });

    test('both gates true → card written and pushed', async () => {
      process.env.GATE_VISIT_PREP_TECH_ALERTS = 'true';
      process.env.GATE_VISIT_PREP_PHOTOS = 'true';
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(mockInsertCard).toHaveBeenCalledWith('tech-1', expect.objectContaining({
        type: 'customer_visit_photos',
        message: 'A customer sent photos for a visit on your route',
        payload: { scheduled_service_id: 'svc-1', visit_id: 'visit-9', scheduled_date: '2026-10-02' },
      }));
      // Delivered through the visit's shared queue, keyed by the service id.
      expect(mockEnqueue).toHaveBeenCalledWith('svc-1', expect.any(Function));
      // The card's transaction (visit row read FOR SHARE inside it), the
      // push's (only the visit's advisory lock), and the recheck's savepoint
      // inside it (the stub routes a nested transaction through the same fn).
      expect(db.transaction).toHaveBeenCalledTimes(3);
      // Same lock key as a visit notice's push for this stop, so a photo
      // alert and a move/cancel push never interleave across instances.
      expect(db.raw).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['tech-visit-push:svc-1']);
      expect(mockLastSvcChain.forShare).toHaveBeenCalled();
      // The technician row too, so an office-only edit can't slip in.
      expect(mockLastTechChain.forShare).toHaveBeenCalled();
      expect(mockSendToAdminUser).toHaveBeenCalledWith('tech-1', expect.objectContaining({
        title: 'A customer sent photos for a visit on your route',
        body: '',
      }));
    });
  });

  describe('with both gates on', () => {
    beforeEach(() => {
      process.env.GATE_VISIT_PREP_TECH_ALERTS = 'true';
      process.env.GATE_VISIT_PREP_PHOTOS = 'true';
    });

    test('resolves the CURRENT technician fresh from the DB — a reassignment after submission reaches the NEW holder', async () => {
      // Same call shape both times; only the DB row differs — proving the
      // recipient comes from a fresh read, never a value baked into the call.
      prime({ svcTechnicianId: 'tech-1', techs: { 'tech-1': TECH } });
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(mockInsertCard).toHaveBeenCalledWith('tech-1', expect.anything());

      jest.clearAllMocks();
      const TECH_2 = { id: 'tech-2', employment_status: 'active', field_dispatchable: true };
      prime({ svcTechnicianId: 'tech-2', techs: { 'tech-2': TECH_2 } });
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(mockInsertCard).toHaveBeenCalledWith('tech-2', expect.anything());
      expect(mockSendToAdminUser).toHaveBeenCalledWith('tech-2', expect.anything());
    });

    test('the visit key and date come from the LIVE row (a regroup after submission is followed)', async () => {
      prime({ visitId: null, scheduledDate: new Date('2026-10-05T00:00:00Z') });
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(mockInsertCard).toHaveBeenCalledWith('tech-1', expect.objectContaining({
        payload: { scheduled_service_id: 'svc-1', visit_id: null, scheduled_date: '2026-10-05' },
      }));
    });

    test.each(['cancelled', 'completed', 'skipped', 'no_show', 'rescheduled'])('a %s visit (still carrying its technician) → no card, no push', async (status) => {
      prime({ status });
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(mockInsertCard).not.toHaveBeenCalled();
      expect(mockSendToAdminUser).not.toHaveBeenCalled();
    });

    test('the liveness check runs UNDER the visit push lock, just before the send', async () => {
      mockEvents = [];
      prime();
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(mockEvents.indexOf('lock')).toBeGreaterThan(-1);
      expect(mockEvents.lastIndexOf('liveness')).toBeGreaterThan(mockEvents.indexOf('lock'));
      expect(mockSendToAdminUser).toHaveBeenCalledTimes(1);
    });

    test('a lock error still sends the alert (fail open) and never throws', async () => {
      prime();
      db.raw = jest.fn(async (sql) => { if (/pg_advisory_xact_lock/.test(sql)) throw new Error('lock timeout'); });
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(mockSendToAdminUser).toHaveBeenCalledTimes(1);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sending unordered'));
    });

    test('a reassignment before the provider handoff (beforeDispatch) → card written, NO push', async () => {
      prime({ alertableAtPush: false });
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(mockInsertCard).toHaveBeenCalledTimes(1);
      expect(mockSendToAdminUser).not.toHaveBeenCalled();
    });

    test('no technician assigned → no card, no push', async () => {
      prime({ svcTechnicianId: null });
      const out = await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(out).toBeUndefined();
      expect(mockInsertCard).not.toHaveBeenCalled();
      expect(mockSendToAdminUser).not.toHaveBeenCalled();
    });

    test('no scheduledServiceId → nothing read or written', async () => {
      await notice.notifyTechVisitPrepPhotos({});
      expect(db).not.toHaveBeenCalled();
    });

    test.each([
      ['prospective placeholder', { employment_status: 'prospective', field_dispatchable: false }],
      ['inactive account', { employment_status: 'inactive', field_dispatchable: true }],
      ['office-only admin', { employment_status: 'active', field_dispatchable: false }],
    ])('a %s technician never receives a card or a push', async (_label, row) => {
      prime({ svcTechnicianId: 'tech-9', techs: { 'tech-9': { id: 'tech-9', ...row } } });
      await notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' });
      expect(mockInsertCard).not.toHaveBeenCalled();
      expect(mockSendToAdminUser).not.toHaveBeenCalled();
    });

    test('a push failure never loses the already-written card, and never throws', async () => {
      mockSendToAdminUser.mockRejectedValueOnce(new Error('APNs down'));
      await expect(notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' })).resolves.toBeUndefined();
      expect(mockInsertCard).toHaveBeenCalledWith('tech-1', expect.anything());
      expect(logger.warn).toHaveBeenCalled();
    });

    test('an unexpected error (e.g. the DB read throws) is caught and logged, never thrown', async () => {
      db.mockImplementation(() => { throw new Error('pool exhausted'); });
      await expect(notice.notifyTechVisitPrepPhotos({ scheduledServiceId: 'svc-1' })).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalled();
      expect(mockInsertCard).not.toHaveBeenCalled();
    });
  });
});

describe('refreshPhotoCardDates', () => {
  function liveConn(liveRows) {
    return jest.fn(() => {
      const c = {};
      for (const m of ['join', 'whereIn', 'whereNotIn', 'where']) c[m] = jest.fn(() => c);
      c.select = jest.fn(async () => liveRows);
      return c;
    });
  }

  test('a card shows its visit\'s CURRENT date and visit key', async () => {
    const rows = [
      { type: 'customer_visit_photos', technician_id: 'tech-1', payload: { scheduled_service_id: 'svc-1', visit_id: 'visit-9', scheduled_date: '2026-10-02' } },
      { type: 'visit_assigned', technician_id: 'tech-1', payload: { x: 1 } },
    ];
    const out = await notice.refreshPhotoCardDates(rows, liveConn([{ id: 'svc-1', scheduled_date: '2026-10-09', visit_id: null, technician_id: 'tech-1' }]));
    expect(out).toHaveLength(2);
    expect(out[0].payload).toEqual({ scheduled_service_id: 'svc-1', visit_id: null, scheduled_date: '2026-10-09' });
    expect(out[1].payload).toEqual({ x: 1 });
  });

  test('a card whose visit stopped qualifying (or changed tech) between the two reads is dropped', async () => {
    const rows = [
      { type: 'customer_visit_photos', technician_id: 'tech-1', payload: { scheduled_service_id: 'svc-gone' } },
      { type: 'customer_visit_photos', technician_id: 'tech-1', payload: { scheduled_service_id: 'svc-moved' } },
      { type: 'visit_assigned', technician_id: 'tech-1', payload: { x: 1 } },
    ];
    const out = await notice.refreshPhotoCardDates(rows, liveConn([{ id: 'svc-moved', scheduled_date: '2026-10-02', visit_id: null, technician_id: 'tech-2' }]));
    expect(out.map((r) => r.type)).toEqual(['visit_assigned']);
  });
});
