// The day a drafted review text speaks about (owner 2026-10-27, "FIX"): the day the
// technician was at the visit, not the close day a late completion stamps on the record.
jest.mock('../models/db', () => jest.fn());
const mockProfile = { value: { serviceKey: 'pest_general', findingsType: null, completionMode: 'standard', deliveryMode: 'auto_send', category: 'pest' } };
const mockResolve = jest.fn(async () => {
  if (mockProfile.value instanceof Error) throw mockProfile.value;
  return mockProfile.value;
});
jest.mock('../services/service-completion-profiles', () => ({
  ...jest.requireActual('../services/service-completion-profiles'),
  resolveCompletionProfileForScheduledService: (...args) => mockResolve(...args),
}));
const { draftServiceDate, draftVisitDate, visitWorkedOn, closedWithinDaysOfWorkedDay, lateCloseAskKeptForVisit, lateCloseAskVerdict } = require('../services/review-visit-day');
const { etCalendarDayOf } = require('../utils/datetime-et');

const DAY = 86400000;
const daysAgo = (n) => new Date(Date.now() - n * DAY);
const dayString = (n) => etCalendarDayOf(daysAgo(n));

// A two-table fake: where({ id }).first(...) returns the row with that id.
function fakeDb(tables, { throwOn = null } = {}) {
  return jest.fn((table) => ({
    where: ({ id }) => ({
      first: async () => {
        if (throwOn === table) throw new Error('pg blip');
        return (tables[table] || []).find((row) => row.id === id) || null;
      },
    }),
  }));
}

describe('visitWorkedOn: the service report\'s staleness rule', () => {
  test('a kept arrival stamp is the day worked', () => {
    const arrived = daysAgo(5);
    expect(visitWorkedOn({ arrivedAt: arrived, scheduledDate: dayString(5), completedAt: new Date() })).toBe(arrived.toISOString());
  });

  test('an arrival before the scheduled day is an earlier, aborted attempt: the scheduled day wins', () => {
    expect(visitWorkedOn({ arrivedAt: daysAgo(3), scheduledDate: dayString(0), completedAt: new Date() })).toBe(dayString(0));
  });

  test('no arrival: the scheduled day, when the close is on or after it', () => {
    expect(visitWorkedOn({ scheduledDate: dayString(4), completedAt: new Date() })).toBe(dayString(4));
  });

  test('an early close of a future visit has no scheduled day: its arrival, else nothing', () => {
    const arrived = new Date();
    expect(visitWorkedOn({ arrivedAt: arrived, scheduledDate: etCalendarDayOf(new Date(Date.now() + 3 * DAY)), completedAt: new Date() })).toBe(arrived.toISOString());
    expect(visitWorkedOn({ scheduledDate: etCalendarDayOf(new Date(Date.now() + 3 * DAY)), completedAt: new Date() })).toBeNull();
  });

  test('nothing known: null', () => {
    expect(visitWorkedOn({})).toBeNull();
  });
});

describe('draftVisitDate: the earlier ET day wins', () => {
  test('a visit worked on an earlier day than the record\'s date: that ET day, as YYYY-MM-DD', () => {
    const record = new Date();
    const worked = daysAgo(22);
    expect(draftVisitDate(record, worked.toISOString())).toBe(etCalendarDayOf(worked));
    expect(draftVisitDate(record, dayString(3))).toBe(dayString(3));
  });

  test('an evening arrival is its ET day, not its UTC day (an 8 PM ET stamp is the next UTC day)', () => {
    expect(draftVisitDate('2026-10-26', '2026-10-25T00:30:00.000Z')).toBe('2026-10-24');
    // Exactly midnight UTC is still an instant here, never read as a date-only value.
    expect(draftVisitDate('2026-10-26', new Date('2026-10-25T00:00:00.000Z'))).toBe('2026-10-24');
    expect(draftVisitDate('2026-10-25', '2026-10-25T00:30:00.000Z')).toBe('2026-10-24');
  });

  test('the same day (or a later one) keeps the record\'s date', () => {
    const record = new Date();
    expect(draftVisitDate(record, record.toISOString())).toBe(record);
    expect(draftVisitDate(daysAgo(2), dayString(0))).toEqual(expect.any(Date));
  });

  test('either alone when the other is missing', () => {
    const record = new Date();
    expect(draftVisitDate(record, null)).toBe(record);
    expect(draftVisitDate(null, dayString(1))).toBe(dayString(1));
    expect(draftVisitDate(null, null)).toBeNull();
  });
});

describe('draftServiceDate: record first, then the cadence\'s visit', () => {
  test('a late close: the record\'s visit arrival', async () => {
    const arrived = daysAgo(10);
    const database = fakeDb({
      service_records: [{ id: 'sr-1', scheduled_service_id: 'ss-1', created_at: new Date() }],
      scheduled_services: [{ id: 'ss-1', arrived_at: arrived, scheduled_date: dayString(10), completed_at: new Date() }],
    });
    const recordDate = new Date();
    expect(await draftServiceDate({ recordDate, serviceRecordId: 'sr-1', scheduledServiceId: 'ss-other' }, database)).toBe(etCalendarDayOf(arrived));
  });

  test('a record with no visit link falls back to the cadence\'s visit', async () => {
    const database = fakeDb({
      service_records: [{ id: 'sr-2', scheduled_service_id: null, created_at: new Date() }],
      scheduled_services: [{ id: 'ss-2', arrived_at: null, scheduled_date: dayString(6), completed_at: new Date() }],
    });
    expect(await draftServiceDate({ recordDate: new Date(), serviceRecordId: 'sr-2', scheduledServiceId: 'ss-2' }, database)).toBe(dayString(6));
  });

  test('a same-day close keeps the record\'s date', async () => {
    const database = fakeDb({
      service_records: [{ id: 'sr-3', scheduled_service_id: 'ss-3', created_at: new Date() }],
      scheduled_services: [{ id: 'ss-3', arrived_at: new Date(), scheduled_date: dayString(0), completed_at: new Date() }],
    });
    const recordDate = new Date();
    expect(await draftServiceDate({ recordDate, serviceRecordId: 'sr-3' }, database)).toBe(recordDate);
  });

  test('no visit, a missing visit row or a failed read keeps the record\'s date', async () => {
    const recordDate = new Date();
    expect(await draftServiceDate({ recordDate }, fakeDb({}))).toBe(recordDate);
    expect(await draftServiceDate({ recordDate, scheduledServiceId: 'ss-gone' }, fakeDb({ scheduled_services: [] }))).toBe(recordDate);
    const failing = fakeDb({ service_records: [{ id: 'sr-4', scheduled_service_id: 'ss-4' }] }, { throwOn: 'scheduled_services' });
    expect(await draftServiceDate({ recordDate, serviceRecordId: 'sr-4' }, failing)).toBe(recordDate);
  });
});

// Late backdated closeouts keep the review ask (owner 2026-11-20, D6 R3): the 3-ET-day window.
describe('closedWithinDaysOfWorkedDay: the 3-day late-close window', () => {
  const closedAt = new Date('2026-11-20T15:00:00Z'); // Nov 20, 10 AM ET
  const within = (scheduledDate, extra = {}) => closedWithinDaysOfWorkedDay({ scheduledDate, closedAt, ...extra });

  test('the same day and 3 days back are inside the window', () => {
    expect(within('2026-11-20')).toBe(true);
    expect(within('2026-11-17')).toBe(true);
  });

  test('4 days back is outside the window', () => {
    expect(within('2026-11-16')).toBe(false);
  });

  test('a late-evening ET arrival counts by its ET day, not its UTC day', () => {
    // Nov 16 9 PM ET = Nov 17 02:00 UTC. ET day gap 4 (out); a UTC-cut day would read 3 (in).
    expect(closedWithinDaysOfWorkedDay({ arrivedAt: '2026-11-17T02:00:00Z', scheduledDate: '2026-11-16', closedAt })).toBe(false);
    // Nov 17 9 PM ET = Nov 18 02:00 UTC. ET day gap 3 (in).
    expect(closedWithinDaysOfWorkedDay({ arrivedAt: '2026-11-18T02:00:00Z', scheduledDate: '2026-11-17', closedAt })).toBe(true);
  });

  test('a stale arrival before the scheduled day falls back to the scheduled day', () => {
    expect(closedWithinDaysOfWorkedDay({ arrivedAt: '2026-11-01T14:00:00Z', scheduledDate: '2026-11-19', closedAt })).toBe(true);
  });

  test('an unreadable worked day, or an unreadable close, is outside the window', () => {
    expect(closedWithinDaysOfWorkedDay({ closedAt })).toBe(false);
    expect(closedWithinDaysOfWorkedDay({ scheduledDate: 'not a day', closedAt })).toBe(false);
    expect(closedWithinDaysOfWorkedDay({ scheduledDate: '2026-11-19' })).toBe(false);
    expect(closedWithinDaysOfWorkedDay({ scheduledDate: '2026-11-19', closedAt: 'garbage' })).toBe(false);
  });

  test('a worked day after the close is outside the window', () => {
    expect(within('2026-11-22')).toBe(false);
  });
});

describe('lateCloseAskKeptForVisit: the preview read', () => {
  let savedGate;
  beforeEach(() => { savedGate = process.env.GATE_REVIEW_LATE_CLOSE_ASK; process.env.GATE_REVIEW_LATE_CLOSE_ASK = 'true'; });
  afterEach(() => { if (savedGate === undefined) delete process.env.GATE_REVIEW_LATE_CLOSE_ASK; else process.env.GATE_REVIEW_LATE_CLOSE_ASK = savedGate; });
  const now = new Date('2026-11-20T15:00:00Z');
  const IDENT = { id: 'v1', service_id: 'sv-1', service_type: 'General Pest Control', service_key_snapshot: null, is_recurring: true };
  const visitDb = (row, fail = false) => jest.fn(() => ({ where: () => ({ first: async () => { if (fail) throw new Error('pg blip'); return row; } }) }));

  test('a visit worked 2 days ago is kept; one worked 5 days ago is not', async () => {
    expect(await lateCloseAskKeptForVisit('v1', visitDb({ ...IDENT, arrived_at: null, scheduled_date: '2026-11-18' }), now)).toBe(true);
    expect(await lateCloseAskKeptForVisit('v1', visitDb({ ...IDENT, arrived_at: null, scheduled_date: '2026-11-15' }), now)).toBe(false);
  });

  describe('delivery posture the commit enforces (GATE_REVIEW_LATE_CLOSE_ASK)', () => {
    const inWindow = { ...IDENT, arrived_at: null, scheduled_date: '2026-11-18' };
    afterEach(() => { mockProfile.value = { serviceKey: 'pest_general', findingsType: null, completionMode: 'standard', deliveryMode: 'auto_send', category: 'pest' }; });

    test('an internal-only assessment is never kept', async () => {
      mockProfile.value = { serviceKey: 'pest_general', findingsType: null, completionMode: 'internal_only', deliveryMode: 'auto_send', category: 'pest' };
      expect(await lateCloseAskKeptForVisit('v1', visitDb(inWindow), now)).toBe(false);
    });

    test('a typed profile with delivery off is never kept; an auto-send one is', async () => {
      mockProfile.value = { serviceKey: 'pest_general', findingsType: 'pest_findings', completionMode: 'standard', deliveryMode: 'internal_only', category: 'pest' };
      expect(await lateCloseAskKeptForVisit('v1', visitDb(inWindow), now)).toBe(false);
      mockProfile.value = { serviceKey: 'pest_general', findingsType: 'pest_findings', completionMode: 'standard', deliveryMode: 'auto_send', category: 'pest' };
      expect(await lateCloseAskKeptForVisit('v1', visitDb(inWindow), now)).toBe(true);
    });

    test('an unreadable profile is false', async () => {
      mockProfile.value = null;
      expect(await lateCloseAskKeptForVisit('v1', visitDb(inWindow), now)).toBe(false);
      mockProfile.value = new Error('pg blip');
      expect(await lateCloseAskKeptForVisit('v1', visitDb(inWindow), now)).toBe(false);
    });
  });

  test('no visit, no id, or a failed read is false', async () => {
    expect(await lateCloseAskKeptForVisit('v1', visitDb(null), now)).toBe(false);
    expect(await lateCloseAskKeptForVisit('', visitDb({ ...IDENT, scheduled_date: '2026-11-18' }), now)).toBe(false);
    expect(await lateCloseAskKeptForVisit('v1', visitDb(null, true), now)).toBe(false);
  });
});

// THE verdict (commit and preview): every input fails closed.
describe('lateCloseAskVerdict', () => {
  const closedAt = new Date('2026-11-20T15:00:00Z');
  const ident = { id: 'v1', service_id: 'sv-1', service_type: 'General Pest Control', service_key_snapshot: null, is_recurring: true };
  const visit = { ...ident, arrived_at: null, scheduled_date: '2026-11-18' };
  const base = { isBackfill: true, visitOutcome: 'completed', systemQuietCloseout: false, recapReviewOnly: false, isInternalOnlyCompletion: false, deliverySuppressed: false, visit, preLockVisit: { ...visit }, knex: {}, closedAt };
  let saved;
  beforeEach(() => {
    saved = process.env.GATE_REVIEW_LATE_CLOSE_ASK; process.env.GATE_REVIEW_LATE_CLOSE_ASK = 'true';
    mockResolve.mockClear();
    mockProfile.value = { serviceKey: 'pest_general', findingsType: null, completionMode: 'standard', deliveryMode: 'auto_send', category: 'pest' };
  });
  afterEach(() => { if (saved === undefined) delete process.env.GATE_REVIEW_LATE_CLOSE_ASK; else process.env.GATE_REVIEW_LATE_CLOSE_ASK = saved; });

  test('gate on, completed backfill worked 2 days ago, auto-send profile: kept; the profile is read STRICT from the locked row', async () => {
    expect(await lateCloseAskVerdict(base)).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith(visit, base.knex, { strict: true });
  });

  test('gate off or not exactly true: not kept', async () => {
    delete process.env.GATE_REVIEW_LATE_CLOSE_ASK;
    expect(await lateCloseAskVerdict(base)).toBe(false);
    process.env.GATE_REVIEW_LATE_CLOSE_ASK = 'yes';
    expect(await lateCloseAskVerdict(base)).toBe(false);
  });

  test('worked 5 days ago, or an unreadable worked day: not kept', async () => {
    const old = { ...visit, scheduled_date: '2026-11-15' };
    expect(await lateCloseAskVerdict({ ...base, visit: old, preLockVisit: { ...old } })).toBe(false);
    const blank = { ...ident, arrived_at: null, scheduled_date: null };
    expect(await lateCloseAskVerdict({ ...base, visit: blank, preLockVisit: { ...blank } })).toBe(false);
  });

  test('only a completed admin backfill: live, system quiet, invoice-issued, recap-only, internal-only, other outcomes are all not kept', async () => {
    expect(await lateCloseAskVerdict({ ...base, isBackfill: false })).toBe(false);
    expect(await lateCloseAskVerdict({ ...base, systemQuietCloseout: true })).toBe(false);
    expect(await lateCloseAskVerdict({ ...base, issuedInvoiceCloseout: { invoiceId: 'i' } })).toBe(false);
    expect(await lateCloseAskVerdict({ ...base, recapReviewOnly: true })).toBe(false);
    expect(await lateCloseAskVerdict({ ...base, isInternalOnlyCompletion: true })).toBe(false);
    for (const visitOutcome of ['incomplete', 'customer_declined', 'inspection_only', 'follow_up_needed', null, undefined]) {
      expect(await lateCloseAskVerdict({ ...base, visitOutcome })).toBe(false);
    }
  });

  test('an omitted or non-boolean flag is unknown: not kept', async () => {
    for (const flag of ['systemQuietCloseout', 'recapReviewOnly', 'isInternalOnlyCompletion', 'deliverySuppressed']) {
      const { [flag]: _gone, ...without } = base;
      expect(await lateCloseAskVerdict(without)).toBe(false);
      expect(await lateCloseAskVerdict({ ...base, [flag]: null })).toBe(false);
      expect(await lateCloseAskVerdict({ ...base, [flag]: 'false' })).toBe(false);
    }
    expect(await lateCloseAskVerdict({ ...base, isBackfill: 'true' })).toBe(false);
    expect(await lateCloseAskVerdict({ ...base, isBackfill: undefined })).toBe(false);
  });

  test('the resolver\'s synthesized fallback (an ambiguous or missing profile) is not kept, even when it names a key', async () => {
    // The real resolver's answer for a visit whose service resolves to nothing.
    const none = () => { const q = { where: () => q, whereRaw: () => q, first: async () => null, select: async () => [] }; return q; };
    const actual = jest.requireActual('../services/service-completion-profiles');
    mockResolve.mockImplementationOnce((row, k, opts) => actual.resolveCompletionProfileForScheduledService(row, k, opts));
    const fallback = await actual.resolveCompletionProfileForScheduledService(visit, none, { strict: true });
    expect(fallback.synthesized).toBe(true);
    mockResolve.mockImplementationOnce(async () => fallback);
    expect(await lateCloseAskVerdict({ ...base, knex: none })).toBe(false);
    mockProfile.value = { ...fallback, serviceKey: 'pest_general' };
    expect(await lateCloseAskVerdict(base)).toBe(false);
    mockProfile.value = { ...mockProfile.value, synthesized: undefined, serviceKey: null };
    expect(await lateCloseAskVerdict(base)).toBe(false);
  });

  test('inside the closeout transaction the profile read runs in its own savepoint: an error drops the ask and rolls only the savepoint back', async () => {
    const raw = jest.fn(async () => ({}));
    const trx = { isTransaction: true, raw };
    mockProfile.value = new Error('relation does not exist');
    expect(await lateCloseAskVerdict({ ...base, knex: trx })).toBe(false);
    const sql = raw.mock.calls.map((c) => String(c[0]));
    expect(sql[0]).toMatch(/^SAVEPOINT scope_/);
    expect(sql[1]).toMatch(/^ROLLBACK TO SAVEPOINT scope_/);
    expect(sql[2]).toMatch(/^RELEASE SAVEPOINT scope_/);
    // The transaction handle is untouched and still usable: a later good read releases its savepoint normally.
    raw.mockClear();
    mockProfile.value = { serviceKey: 'pest_general', findingsType: null, completionMode: 'standard', deliveryMode: 'auto_send', category: 'pest' };
    expect(await lateCloseAskVerdict({ ...base, knex: trx })).toBe(true);
    expect(raw.mock.calls.map((c) => String(c[0]))).toEqual([expect.stringMatching(/^SAVEPOINT scope_/), expect.stringMatching(/^RELEASE SAVEPOINT scope_/)]);
  });

  test('a delivery posture that already silenced comms (or an omitted one) is never lifted', async () => {
    expect(await lateCloseAskVerdict({ ...base, deliverySuppressed: true })).toBe(false);
    const { deliverySuppressed: _omit, ...unsaid } = base;
    expect(await lateCloseAskVerdict(unsaid)).toBe(false);
  });

  test('a strict profile lookup error, or no profile, is not kept', async () => {
    mockProfile.value = new Error('profile table probe failed');
    expect(await lateCloseAskVerdict(base)).toBe(false);
    mockProfile.value = null;
    expect(await lateCloseAskVerdict(base)).toBe(false);
  });

  test('the locked profile silencing delivery (internal-only mode, typed delivery off) is not kept', async () => {
    mockProfile.value = { serviceKey: 'pest_general', findingsType: null, completionMode: 'internal_only', deliveryMode: 'auto_send', category: 'pest' };
    expect(await lateCloseAskVerdict(base)).toBe(false);
    mockProfile.value = { serviceKey: 'pest_general', findingsType: 'pest_findings', completionMode: 'standard', deliveryMode: 'disabled', category: 'pest' };
    expect(await lateCloseAskVerdict(base)).toBe(false);
  });

  test('drift between the pre-lock row and the locked row on ANY identity column the resolver keys on is not kept', async () => {
    for (const [col, value] of [['service_id', 'sv-2'], ['service_type', 'WDO Inspection'], ['service_key_snapshot', 'wdo_inspection'], ['is_recurring', false], ['id', 'v2']]) {
      expect(await lateCloseAskVerdict({ ...base, preLockVisit: { ...visit, [col]: value } })).toBe(false);
    }
  });

  test('an identity column the projection never read (undefined), a missing row or a missing pre-lock row is unknown: not kept', async () => {
    const { service_key_snapshot: _s, ...partial } = visit;
    expect(await lateCloseAskVerdict({ ...base, visit: partial, preLockVisit: { ...partial } })).toBe(false);
    expect(await lateCloseAskVerdict({ ...base, visit: null })).toBe(false);
    expect(await lateCloseAskVerdict({ ...base, preLockVisit: null })).toBe(false);
  });
});
