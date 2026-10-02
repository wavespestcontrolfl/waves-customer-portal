// Call booking-miss watchdog: ringing past the admin bell policy and repeat
// paging (owner ruling 2026-09-30). Under GATE_ADMIN_BELL_POLICY the 'alert'
// category is silenced by default, which muted this pager from 2026-08-07
// while the job kept logging "alert fired". These tests pin bell:true on
// every bell, that a suppressed bell never counts as fired, and the repeat
// rules: slot under a day away, ET daytime, last bell older than the
// interval, office has not closed the call's cards. All fixture identities
// are synthetic.
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn((_name, fn) => fn()) }));

const mockState = { calls: [], booked: [], triage: [], alertedKeys: new Set(), rung: [] };

// Minimal chainable stand-in for the knex builder: resolves rows per table.
jest.mock('../models/db', () => {
  const makeBuilder = (table) => {
    const ctx = { table, rawArgs: [] };
    const rows = () => {
      if (table === 'call_log') return mockState.calls;
      if (table === 'scheduled_services') return mockState.booked;
      if (table === 'triage_items') return mockState.triage;
      if (table === 'notifications') return mockState.rung;
      return [];
    };
    const b = {
      where: () => b,
      whereRaw: (_sql, args) => { if (args) ctx.rawArgs.push(...args); return b; },
      whereNotNull: () => b,
      whereIn: () => b,
      whereNotIn: () => b,
      groupByRaw: () => b,
      orderBy: () => b,
      select: () => b,
      first: () => Promise.resolve(
        table === 'notifications' && ctx.rawArgs.some((k) => mockState.alertedKeys.has(k)) ? { id: 'n-old' } : undefined,
      ),
      then: (res, rej) => Promise.resolve(rows()).then(res, rej),
    };
    return b;
  };
  const db = jest.fn((table) => makeBuilder(table));
  db.raw = jest.fn((sql) => sql);
  return db;
});

const NotificationService = require('../services/notification-service');
const logger = require('../services/logger');
const {
  runCallBookingMissWatchdog,
  repeatWindowOpen,
  officeClosedCall,
  REPEAT_INTERVAL_MINUTES,
} = require('../services/call-booking-miss-watchdog');

// Sat Oct 3 2026, 12:00 ET. The synthetic slot is Sun Oct 4 11:00 ET (23h out).
const NOW = new Date('2026-10-03T16:00:00Z');
const CALL_ID = 'call-miss-1';

function missCall(over = {}) {
  return {
    id: CALL_ID, twilio_call_sid: 'CAsynthetic900', customer_id: 'cust-9',
    direction: 'inbound', created_at: '2026-09-28T21:30:00Z',
    from_phone: '+19415550199', to_phone: '+19415550100',
    ai_extraction_enriched: {
      caller: { name_full: 'Robin Example' },
      service_request: { specific_service_name: 'Wasp Nest Removal' },
      scheduling: { status: 'confirmed', confirmed_start_at: '2026-10-04T11:00:00-04:00' },
    },
    ...over,
  };
}

beforeEach(() => {
  mockState.calls = [missCall()];
  mockState.booked = [];
  mockState.triage = [];
  mockState.alertedKeys = new Set();
  mockState.rung = [];
  NotificationService.notifyAdmin.mockReset();
  NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-new', deduped: false });
  logger.warn.mockClear();
});

describe('first bell', () => {
  test('rings with bell:true so the admin bell policy cannot silence it', async () => {
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result).toMatchObject({ misses: 1, alerted: 1, repeated: 0 });
    const [category, title, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('alert');
    expect(title).toBe("Schedule — book Robin Example's Wasp Nest Removal");
    expect(why).toBe('Confirmed Sun Oct 4 at 11:00 AM on a call; nothing is on the calendar.');
    expect(opts.link).toMatch(/^\/admin\/dispatch\?tab=schedule&date=\d{4}-\d{2}-\d{2}$/);
    expect(opts.metadata).toMatchObject({ call_log_id: CALL_ID, area: 'Schedule', severity: 'needs-you', subject: { type: 'call', id: CALL_ID }, doneWhen: 'visit_booked', who: 'person' });
    expect(opts.detail).toMatch(/2026-10-04 11:00 ET/);
    expect(opts.bell).toBe(true);
    expect(opts.dedupeKey).toBe(`call-booking-miss:${CALL_ID}`);
    expect(opts.dedupeWindowMs).toBeUndefined();
  });

  test('a suppressed bell is not counted or logged as fired', async () => {
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true, reason: 'internal_test' });
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result).toMatchObject({ alerted: 0, repeated: 0 });
    expect(logger.warn.mock.calls.some(([msg]) => /fired/.test(msg))).toBe(false);
  });

  test('a lost insert still fails the run loudly', async () => {
    NotificationService.notifyAdmin.mockResolvedValue(null);
    await expect(runCallBookingMissWatchdog({ now: NOW })).rejects.toThrow(/pager output lost/);
  });

  test('a booked call-linked row clears the miss: nothing rings', async () => {
    mockState.booked = [{ customer_id: 'cust-9', sched_date: '2026-10-04', window_start: '11:00:00', source_call_log_id: CALL_ID, notes: null }];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result.misses).toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});

describe('booked then cancelled by the office', () => {
  const afterCall = '2026-09-28T21:50:00Z';

  test('first ring is suppressed for a post-call visit that was later cancelled', async () => {
    mockState.booked = [{ customer_id: 'cust-9', status: 'cancelled', sched_date: '2026-10-04', window_start: '08:00:00', created_at: afterCall, source_call_log_id: null, notes: null }];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result.misses).toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('a repeat is suppressed too (the first bell already rang, then the office cancelled)', async () => {
    mockState.alertedKeys = new Set([`call-booking-miss:${CALL_ID}`]);
    mockState.rung = [{ call_log_id: CALL_ID, last_at: new Date(NOW.getTime() - (REPEAT_INTERVAL_MINUTES + 10) * 60000).toISOString() }];
    mockState.booked = [{ customer_id: 'cust-9', status: 'cancelled', sched_date: '2026-10-04', window_start: '08:00:00', created_at: afterCall, source_call_log_id: null, notes: null }];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result).toMatchObject({ misses: 0, repeated: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('no repeat once the confirmed slot start has passed', async () => {
    mockState.alertedKeys = new Set([`call-booking-miss:${CALL_ID}`]);
    mockState.rung = [{ call_log_id: CALL_ID, last_at: '2026-10-04T12:00:00Z' }];
    const result = await runCallBookingMissWatchdog({ now: new Date('2026-10-04T16:30:00Z') }); // 12:30 ET, slot 11:00
    expect(result.repeated).toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});

describe('repeat paging', () => {
  beforeEach(() => {
    mockState.alertedKeys = new Set([`call-booking-miss:${CALL_ID}`]);
  });

  test('re-rings when the slot is under a day away and the last bell is older than the interval', async () => {
    mockState.rung = [{ call_log_id: CALL_ID, last_at: new Date(NOW.getTime() - (REPEAT_INTERVAL_MINUTES + 10) * 60000).toISOString() }];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result).toMatchObject({ alerted: 0, repeated: 1 });
    const [, title, why, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toMatch(/^Schedule — book Robin Example/);
    expect(why).toMatch(/^Still unbooked: confirmed /);
    expect(opts.detail).toMatch(/keeps ringing until the visit is booked/);
    expect(opts.bell).toBe(true);
    expect(opts.dedupeKey).toBe(`call-booking-miss-repeat:${CALL_ID}`);
    expect(opts.metadata.repeat).toBe(true);
    expect(opts.dedupeWindowMs).toBe(REPEAT_INTERVAL_MINUTES * 60000);
  });

  test('no repeat while the last bell is younger than the interval', async () => {
    mockState.rung = [{ call_log_id: CALL_ID, last_at: new Date(NOW.getTime() - 30 * 60000).toISOString() }];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result.repeated).toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('no repeat once the office dismissed or resolved every card on the call', async () => {
    mockState.triage = [
      { call_log_id: CALL_ID, status: 'dismissed', resolution_source: 'human' },
      { call_log_id: CALL_ID, status: 'resolved', resolution_source: 'auto' },
    ];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result.repeated).toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('cards closed only by automation (sweep, processor, event resolvers) keep the repeat going', async () => {
    mockState.triage = [
      { call_log_id: CALL_ID, status: 'resolved', resolution_source: 'auto' },
      { call_log_id: CALL_ID, status: 'dismissed', resolution_source: 'system' },
      { call_log_id: CALL_ID, status: 'resolved', resolution_source: null },
    ];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result.repeated).toBe(1);
  });

  test('an open card keeps the repeat going', async () => {
    mockState.triage = [{ call_log_id: CALL_ID, status: 'dismissed', resolution_source: 'human' }, { call_log_id: CALL_ID, status: 'open' }];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result.repeated).toBe(1);
  });

  test('a deduped repeat (another tick won the window) is not counted', async () => {
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-standing', deduped: true });
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result.repeated).toBe(0);
  });

  test('a call older than the first-ring lookback still repeats once its slot is under a day away', async () => {
    // Called Sunday 9/27 for Sunday 10/4: six days old at the Saturday 10/3 tick.
    mockState.calls = [missCall({ created_at: '2026-09-27T14:00:00Z' })];
    mockState.rung = [{ call_log_id: CALL_ID, last_at: '2026-09-27T16:00:00Z' }];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result).toMatchObject({ misses: 1, repeated: 1 });
  });

  test('a call older than the 30-day scan still repeats when it already rang for a slot in the next day', async () => {
    // Booked in August for Sunday 10/4; the first bell rang back then.
    mockState.calls = [missCall({ created_at: '2026-08-20T14:00:00Z' })];
    mockState.rung = [{ call_log_id: CALL_ID, last_at: '2026-08-20T16:00:00Z' }];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result).toMatchObject({ misses: 1, repeated: 1 });
  });

  test('an old call whose slot is not inside the repeat window is not scanned at all', async () => {
    mockState.calls = [missCall({
      created_at: '2026-09-20T14:00:00Z',
      ai_extraction_enriched: {
        caller: { name_full: 'Robin Example' },
        scheduling: { status: 'confirmed', confirmed_start_at: '2026-10-09T11:00:00-04:00' },
      },
    })];
    const result = await runCallBookingMissWatchdog({ now: NOW });
    expect(result).toMatchObject({ scanned: 0, misses: 0 });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test('no repeat when the slot is more than a day away', async () => {
    const early = new Date('2026-10-02T16:00:00Z');
    const result = await runCallBookingMissWatchdog({ now: early });
    expect(result.repeated).toBe(0);
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });
});

describe('repeatWindowOpen', () => {
  const slot = { dateET: '2026-10-04', minutes: 11 * 60 };

  test('open in ET daytime inside the last day before the slot', () => {
    expect(repeatWindowOpen(slot, new Date('2026-10-03T16:00:00Z'))).toBe(true);
    expect(repeatWindowOpen(slot, new Date('2026-10-04T14:30:00Z'))).toBe(true);
  });

  test('closed overnight in ET', () => {
    expect(repeatWindowOpen(slot, new Date('2026-10-04T02:00:00Z'))).toBe(false); // 22:00 ET
    expect(repeatWindowOpen(slot, new Date('2026-10-04T10:30:00Z'))).toBe(false); // 06:30 ET
  });

  test('closes once the slot start time has passed (no repeats through the rest of that day)', () => {
    expect(repeatWindowOpen(slot, new Date('2026-10-04T14:59:00Z'))).toBe(true); // 10:59 ET, slot 11:00
    expect(repeatWindowOpen(slot, new Date('2026-10-04T15:00:00Z'))).toBe(false); // 11:00 ET
    expect(repeatWindowOpen(slot, new Date('2026-10-04T23:30:00Z'))).toBe(false); // 19:30 ET
  });

  test('closed from the next ET day on', () => {
    expect(repeatWindowOpen(slot, new Date('2026-10-05T14:00:00Z'))).toBe(false);
  });

  test('closed more than a day out', () => {
    expect(repeatWindowOpen(slot, new Date('2026-10-03T14:00:00Z'))).toBe(false);
  });
});

describe('officeClosedCall', () => {
  test('no cards is not closed', () => {
    expect(officeClosedCall([])).toBe(false);
  });
  test('a person closing the cards is closed', () => {
    expect(officeClosedCall([{ status: 'dismissed', resolution_source: 'human' }, { status: 'resolved', resolution_source: 'auto' }])).toBe(true);
  });
  test('only automated closures is not closed', () => {
    expect(officeClosedCall([{ status: 'resolved', resolution_source: 'auto' }, { status: 'dismissed', resolution_source: null }])).toBe(false);
  });
  test('any open or in-progress card keeps it open', () => {
    expect(officeClosedCall([{ status: 'dismissed', resolution_source: 'human' }, { status: 'in_progress' }])).toBe(false);
  });
});
