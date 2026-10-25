// GATE_NEW_CALLER_BOOKING, the timed bells for a visit booked by address that
// still has no customer (services/booking/new-caller-visit-bells.js, D4 b and
// c, D9): no call picked, a recording not processed 90 minutes after the call,
// a finished pass that left the visit unlinked, and once more on the visit's
// last day. A call still in its first 90 minutes waits for its own pass. The
// bells run through the real composer, so a copy-rule break fails here. Unit
// cases run everywhere; the ring, dedupe, link-close and stale-ring lifecycle
// on Postgres runs in CI (DATABASE_URL). Fixtures fictitious.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

let mockNewCallerGate = true;
jest.mock('../config/feature-gates', () => {
  const actual = jest.requireActual('../config/feature-gates');
  return { ...actual, isEnabled: (gate) => (gate === 'newCallerBooking' ? mockNewCallerGate : actual.isEnabled(gate)) };
});

const fs = require('fs');
const path = require('path');
const NotificationService = require('../services/notification-service');
const { runNewCallerVisitBells, _private } = require('../services/booking/new-caller-visit-bells');

const COMPLETED = new Set(['processed', 'voicemail', 'spam']);
// Thu Mar 6 2031, 10:00 ET.
const NOW = new Date('2031-03-06T15:00:00Z');
const minutesBefore = (n) => new Date(NOW.getTime() - n * 60 * 1000).toISOString();
const visit = (overrides = {}) => ({
  id: '0f8b9d1e-2c3a-4b5d-8e6f-7a8b9c0d1e2f', scheduled_date: '2031-03-12', window_start: '13:00:00',
  source_call_log_id: '2b3c4d5e-6f70-4b1c-9d2e-3f4a5b6c7d8e', ...overrides,
});
// A call row: created when it began, with the /call-status end stamp.
const call = (status, endedMinutesAgo) => ({
  id: '2b3c4d5e-6f70-4b1c-9d2e-3f4a5b6c7d8e', processing_status: status,
  created_at: minutesBefore(endedMinutesAgo + 5), duration_seconds: 300, metadata: { ended_at: minutesBefore(endedMinutesAgo) },
});

describe('when a waiting visit\'s bell is due', () => {
  const { stageOf } = _private;
  test.each([
    ['no call was picked at Book', visit({ source_call_log_id: null }), null, 'no_call'],
    ['the pass finished', visit(), call('processed', 20), 'processed'],
    ['the pass failed to create the customer, after its link step', visit(), call('customer_creation_failed', 20), 'processed'],
    ['a voicemail verdict ended the pass before its link step', visit(), call('voicemail', 20), 'processed'],
    ['the recording is not processed 90 minutes after the call', visit(), call(null, 95), 'not_processed'],
    ['the extraction keeps failing', visit(), call('extraction_failed', 120), 'not_processed'],
    ['the call is still in its first 90 minutes: its own pass may link it', visit(), call('processing', 30), null],
    ['a due bell on the visit\'s last day says so', visit({ scheduled_date: '2031-03-07', window_start: '09:00:00' }), call('processed', 20), 'soon'],
    ['a visit tomorrow but more than a day out is not its last day yet', visit({ scheduled_date: '2031-03-07' }), call('processed', 20), 'processed'],
    ['a visit today with no call picked', visit({ scheduled_date: '2031-03-06', source_call_log_id: null }), null, 'soon'],
    ['a call in its first 90 minutes waits, even for a visit tomorrow', visit({ scheduled_date: '2031-03-07' }), call(null, 10), null],
  ])('%s', (_label, v, c, expected) => {
    expect(stageOf(v, c, NOW.getTime(), COMPLETED)).toBe(expected);
  });

  test('a call row inserted after the call has no end: the 90 minutes run from when it began', () => {
    const late = { id: 'c1', processing_status: null, created_at: minutesBefore(100), duration_seconds: 0, metadata: {} };
    expect(_private.stageOf(visit(), late, NOW.getTime(), COMPLETED)).toBe('not_processed');
  });
});

// Answers the sweep's two list reads (the waiting visits, then their calls)
// and, per bell, the visit re-read under a lock: `now` gives a visit's row as
// it stands at that moment (waiting unless a case says otherwise).
function fakeConn(visits, calls, now = () => ({ customer_id: null, status: 'pending' })) {
  const reads = [];
  const conn = (table) => {
    const steps = [];
    const chain = {};
    for (const method of ['where', 'whereNull', 'whereNotIn', 'whereIn', 'whereRaw', 'orderBy', 'limit', 'forShare']) {
      chain[method] = (...args) => { steps.push([method, ...args]); return chain; };
    }
    chain.modify = (fn) => { fn(chain); return chain; };
    chain.select = async () => {
      reads.push({ table, steps });
      if (table !== 'scheduled_services') return calls;
      // Keyset pages: the rows after the bound id, up to the limit.
      const bound = steps.find(([m]) => m === 'whereRaw');
      const start = bound ? visits.findIndex((v) => v.id === bound[2][1]) + 1 : 0;
      const [, limit] = steps.find(([m]) => m === 'limit');
      return visits.slice(start, start + limit);
    };
    chain.first = async () => {
      reads.push({ table, steps });
      return now(steps.find(([m]) => m === 'where')[1].id);
    };
    return chain;
  };
  conn.transaction = async (fn) => fn(conn);
  conn.reads = reads;
  return conn;
}

describe('the sweep', () => {
  let notify;
  beforeEach(() => {
    mockNewCallerGate = true;
    notify = jest.spyOn(NotificationService, 'notifyAdmin').mockResolvedValue({ id: 'n-1', deduped: false });
  });
  afterEach(() => notify.mockRestore());

  test('the gate off reads nothing', async () => {
    mockNewCallerGate = false;
    const conn = fakeConn([], []);
    await expect(runNewCallerVisitBells({ now: NOW, conn })).resolves.toEqual({ skipped: 'disabled' });
    expect(conn.reads).toHaveLength(0);
  });

  test('rings each due visit on its own row, with the call read past sandbox calls; a visit still in its pass\'s time waits', async () => {
    const noCall = visit({ id: 'a1b2c3d4-0000-4000-8000-000000000001', source_call_log_id: null });
    const waiting = visit({ id: 'a1b2c3d4-0000-4000-8000-000000000002', source_call_log_id: 'call-young' });
    const stuck = visit({ id: 'a1b2c3d4-0000-4000-8000-000000000003', source_call_log_id: 'call-old' });
    const conn = fakeConn([noCall, waiting, stuck], [
      { ...call('processing', 30), id: 'call-young' },
      { ...call(null, 100), id: 'call-old' },
    ]);

    await expect(runNewCallerVisitBells({ now: NOW, conn })).resolves.toEqual({ waiting: 3, due: 2, rung: 2 });

    expect(conn.reads[0].steps).toEqual(expect.arrayContaining([
      ['where', { source_action: 'admin_new_caller' }], ['whereNull', 'customer_id'], ['where', 'scheduled_date', '>=', '2031-03-05'],
    ]));
    expect(conn.reads[1].steps).toEqual(expect.arrayContaining([['whereIn', 'id', ['call-young', 'call-old']], ['whereRaw', "COALESCE(??, '') <> ?", expect.any(Array)]]));
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenCalledWith('schedule', "Schedule — link the new caller's visit on Wed Mar 12", _private.WHY.no_call, expect.objectContaining({
      trx: conn,
      dedupeKey: `new-caller-visit:${noCall.id}`,
      bellDefault: true,
      link: `/admin/dispatch?tab=schedule&date=2031-03-12&appointment=${noCall.id}`,
      metadata: expect.objectContaining({ stage: 'no_call', subject: { type: 'visit', id: noCall.id }, doneWhen: 'visit_linked', who: 'person' }),
    }));
    expect(notify).toHaveBeenCalledWith('schedule', expect.any(String), _private.WHY.not_processed, expect.objectContaining({ dedupeKey: `new-caller-visit:${stuck.id}` }));
    // An earlier stage never rewrites a row: only the last day refreshes one.
    expect(notify.mock.calls.every(([, , , opts]) => !opts.refreshOnDedupe)).toBe(true);
  });

  test('on the visit\'s last day the row rings once more, unless its last ring was already inside that day', async () => {
    const tomorrow = visit({ scheduled_date: '2031-03-07', window_start: '09:00:00' });
    await runNewCallerVisitBells({ now: NOW, conn: fakeConn([tomorrow], [call('processed', 20)]) });

    const [, headline, why, opts] = notify.mock.calls[0];
    expect(headline).toBe("Schedule — link the new caller's visit on Fri Mar 7");
    expect(why).toBe(_private.WHY.soon);
    expect(opts.refreshOnDedupe).toBe(true);
    // The visit starts Fri Mar 7 at 9:00 ET; its last day began Thu Mar 6 at 9:00 ET (14:00Z).
    expect(opts.ringOnRefresh({ created_at: '2031-03-06T09:00:00Z' }, {})).toBe(true);
    expect(opts.ringOnRefresh({ created_at: '2031-03-01T09:00:00Z' }, { rungAt: '2031-03-06T19:00:00Z' })).toBe(false);
    expect(opts.ringOnRefresh({ created_at: '2031-03-06T14:30:00Z' }, {})).toBe(false);
  });

  test('the list is a snapshot: a visit linked or cancelled since it was read gets no bell', async () => {
    const linked = visit({ id: 'v-linked', source_call_log_id: null });
    const cancelled = visit({ id: 'v-cancelled', source_call_log_id: null });
    const conn = fakeConn([linked, cancelled], [], (id) => (id === 'v-linked' ? { customer_id: 'cust-1', status: 'pending' } : { customer_id: null, status: 'cancelled' }));

    await expect(runNewCallerVisitBells({ now: NOW, conn })).resolves.toEqual({ waiting: 2, due: 2, rung: 0 });
    expect(conn.reads.filter((r) => r.steps.some(([m]) => m === 'forShare'))).toHaveLength(2);
    expect(notify).not.toHaveBeenCalled();
  });

  test('every waiting visit is read, past the first page; ten bells a run, so a backlog rings over successive runs', async () => {
    const many = Array.from({ length: 105 }, (_, i) => visit({ id: `v-${String(i).padStart(3, '0')}`, source_call_log_id: null }));
    const rungKeys = new Set();
    notify.mockImplementation(async (_category, _headline, _why, opts) => {
      const deduped = rungKeys.has(opts.dedupeKey);
      rungKeys.add(opts.dedupeKey);
      return { id: 'n', deduped };
    });
    const conn = fakeConn(many, []);

    await expect(runNewCallerVisitBells({ now: NOW, conn })).resolves.toEqual({ waiting: 105, due: 105, rung: 10 });
    const pages = conn.reads.filter((r) => r.table === 'scheduled_services' && r.steps.some(([m]) => m === 'limit'));
    expect(pages).toHaveLength(2);
    expect(pages[1].steps).toContainEqual(['whereRaw', '(scheduled_date, id) > (?::date, ?::uuid)', ['2031-03-12', 'v-099']]);

    await expect(runNewCallerVisitBells({ now: NOW, conn })).resolves.toEqual({ waiting: 105, due: 105, rung: 10 });
    expect(rungKeys.size).toBe(20);
  });

  test('a row that already shows the stage counts as no ring; a bell that fails never stops the sweep', async () => {
    notify.mockResolvedValueOnce({ id: 'n-1', deduped: true }).mockRejectedValueOnce(new Error('insert failed'));
    const conn = fakeConn([visit({ id: 'v1', source_call_log_id: null }), visit({ id: 'v2', source_call_log_id: null }), visit({ id: 'v3', source_call_log_id: null })], []);
    await expect(runNewCallerVisitBells({ now: NOW, conn })).resolves.toEqual({ waiting: 3, due: 3, rung: 1 });
  });

  test('every why passes the notification rule', () => {
    const { composeAdminAlert } = require('../services/admin-alert-compose');
    const spec = { area: 'Schedule', action: "link the new caller's visit on Wed Mar 12", severity: 'needs-you', link: '/admin/dispatch?tab=schedule', subject: { type: 'visit', id: 'v1' }, doneWhen: 'visit_linked', who: 'person' };
    for (const why of Object.values(_private.WHY)) expect(() => composeAdminAlert({ ...spec, why })).not.toThrow();
  });

  test('the scheduler runs it every 10 minutes under its own lock, checking the gate each tick', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
    const at = src.indexOf("cron.schedule('4,14,24,34,44,54 * * * *'");
    expect(at).toBeGreaterThan(-1);
    const job = src.slice(at, src.indexOf('}, { timezone', at));
    expect(job).toContain("isEnabled('newCallerBooking')");
    expect(job).toContain("runExclusive('new-caller-visit-bells'");
    expect(job).toContain("require('./booking/new-caller-visit-bells').runNewCallerVisitBells()");
  });
});

const SKIP = !process.env.DATABASE_URL;
const maybeDescribe = SKIP ? describe.skip : describe;

maybeDescribe('the timed bell on Postgres', () => {
  let db;
  const made = { callIds: [], visitIds: [], customerIds: [] };
  const ADDRESS = { line1: '100 Example Way', city: 'Bradenton', state: 'FL', zip: '34200', lat: 27.5, lng: -82.5 };

  beforeAll(() => {
    db = require('../models/db');
  });
  afterAll(async () => {
    if (made.visitIds.length) {
      await db('notifications').whereRaw("metadata->>'dedupeKey' = ANY(?)", [made.visitIds.map((id) => `new-caller-visit:${id}`)]).del();
      await db('activity_log').whereIn('action', ['new_caller_visit_booked', 'new_caller_visit_linked']).whereRaw("metadata->>'scheduled_service_id' = ANY(?)", [made.visitIds]).del();
      await db('scheduled_services').whereIn('id', made.visitIds).del();
    }
    if (made.callIds.length) await db('call_log').whereIn('id', made.callIds).del();
    if (made.customerIds.length) {
      await db('customer_properties').whereIn('customer_id', made.customerIds).del();
      await db('customers').whereIn('id', made.customerIds).del();
    }
    await db.destroy();
  });

  // The ring path for this suite's own visit (the sweep's list reads every
  // waiting visit in the database, other suites' fixtures included).
  test('a waiting visit rings once; a second ring adds nothing; the link closes it; a stale last-day ring after the link writes nothing', async () => {
    const minutesAgo = (n) => new Date(Date.now() - n * 60 * 1000);
    const [row] = await db('call_log').insert({
      direction: 'inbound', from_phone: '+15555550100', to_phone: '+15555550999', status: 'in-progress',
      twilio_call_sid: `CA${require('crypto').randomBytes(16).toString('hex')}`, duration_seconds: 0,
      created_at: minutesAgo(6), updated_at: minutesAgo(1),
      metadata: JSON.stringify({ forward_acceptance: { accepted: true, csr_name: 'Office', answered_by_number: '+15555550123', accepted_at: minutesAgo(5).toISOString() } }),
    }).returning(['id']);
    made.callIds.push(row.id);
    const service = require('../services/booking/new-caller-visit');
    const svc = await db('services').whereNot('service_key', 'mosquito_one_time').whereNotNull('name').first('id');
    const booked = await service.bookNewCallerVisit({ input: { scheduledDate: '2031-05-07', windowStart: '13:00', serviceId: svc.id, address: ADDRESS, callLogId: row.id } });
    made.visitIds.push(booked.visit.id);
    const key = `new-caller-visit:${booked.visit.id}`;
    const rows = () => db('notifications').whereRaw("metadata->>'dedupeKey' = ?", [key]).select('id', 'done_at');

    const first = await _private.ringVisit(db, booked.visit, 'processed');
    expect(first.waits).toBe(true);
    expect(first.raised.deduped).toBe(false);
    const second = await _private.ringVisit(db, booked.visit, 'processed');
    expect(second.raised.deduped).toBe(true);
    expect(await rows()).toHaveLength(1);

    const customerId = require('crypto').randomUUID();
    await db('customers').insert({ id: customerId, first_name: 'Synthetic', last_name: 'Bell', phone: '+15555550148', address_line1: '1 Synthetic Ln', city: 'Bradenton', zip: '34201', active: true });
    made.customerIds.push(customerId);
    await service.linkNewCallerVisit({ visitId: booked.visit.id, customerId });
    const [closed] = await rows();
    expect(closed.done_at).not.toBeNull();

    // A sweep that listed the visit before the link, ringing its last-day bell after it: no reopen.
    await expect(_private.ringVisit(db, booked.visit, 'soon')).resolves.toEqual({ waits: false });
    const after = await rows();
    expect(after).toHaveLength(1);
    expect(after[0].done_at).not.toBeNull();
  });
});
