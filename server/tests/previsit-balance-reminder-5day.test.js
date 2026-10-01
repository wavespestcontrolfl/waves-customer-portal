/**
 * Pre-visit balance reminder window widens 3 -> 5 days before the visit
 * under GATE_PREVISIT_BALANCE_5DAY (dunning unification, owner decision 6,
 * 2026-09-27) — ahead of the 72-hour appointment reminder. Strict
 * `=== 'true'`, read at call time via leadDays().
 *
 * Pins: gate off keeps the original 3-day window byte-identical; gate on
 * widens the upper bound to today+5. The sweep's own SELECT clauses are
 * exercised here (whereBetween on scheduled_date, whereNull on the
 * balance_reminder_sent_at claim) rather than inferred, so a visit exactly
 * 5 days out is proven selected, a visit 6 days out is proven excluded, and
 * an already-claimed visit is proven excluded even though its date falls
 * inside the window — the one-per-appointment claim (unchanged by this PR)
 * still guarantees no visit is ever sent twice.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../models/db', () => jest.fn());
jest.mock('../utils/cron-lock', () => ({ runExclusive: jest.fn(async (_name, run) => run()) }));

const db = require('../models/db');
const { runSweep, leadDays } = require('../services/previsit-balance-reminder');

function templateChain() {
  const q = {};
  q.where = jest.fn(() => q);
  q.first = jest.fn(async () => ({ is_active: true }));
  return q;
}

// A minimal, real-semantics fake of the sweep's own scheduled_services query:
// whereBetween actually narrows by scheduled_date, and whereNull on the claim
// column actually excludes an already-claimed row — the same two clauses the
// live query runs, so this proves selection, not just infers it.
function scheduledServicesChain(rows) {
  let filtered = rows.slice();
  const q = {};
  q.leftJoin = jest.fn(() => q);
  q.where = jest.fn(() => q);
  q.whereIn = jest.fn(() => q);
  q.whereBetween = jest.fn((_col, [start, end]) => {
    filtered = filtered.filter((row) => row.scheduled_date >= start && row.scheduled_date <= end);
    return q;
  });
  q.whereNull = jest.fn((col) => {
    if (col === 'scheduled_services.balance_reminder_sent_at') {
      filtered = filtered.filter((row) => !row.balance_reminder_sent_at);
    }
    return q;
  });
  q.select = jest.fn(() => q);
  q.then = (resolve, reject) => Promise.resolve(filtered).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(filtered).catch(reject);
  return q;
}

// Any downstream table read (notification_prefs, invoices, ...) is
// deliberately left unmocked — a thrown "unexpected table" is caught by
// runSweepHeld's own per-visit try/catch and counted as skipped, which
// never affects `considered` (the count that answers "did the window+claim
// query select this visit?", the only thing this suite is pinning).
function setDb(rows) {
  db.mockImplementation((table) => {
    if (table === 'sms_templates') return templateChain();
    if (table === 'scheduled_services') return scheduledServicesChain(rows);
    throw new Error(`Unexpected db table ${table} (not mocked for this window test)`);
  });
}

const NOW = new Date('2026-08-14T15:00:00Z'); // todayEt = 2026-08-14

beforeEach(() => {
  jest.clearAllMocks();
  process.env.PREVISIT_BALANCE_REMINDER = 'true';
  delete process.env.GATE_PREVISIT_BALANCE_5DAY;
});

afterAll(() => {
  delete process.env.PREVISIT_BALANCE_REMINDER;
  delete process.env.GATE_PREVISIT_BALANCE_5DAY;
});

test('gate off: leadDays() is 3 and the window ends at today+3 (existing expectation unchanged)', async () => {
  expect(leadDays()).toBe(3);
  const threeOut = { id: 'ss-3', scheduled_date: '2026-08-17', balance_reminder_sent_at: null };
  const fourOut = { id: 'ss-4', scheduled_date: '2026-08-18', balance_reminder_sent_at: null };
  setDb([threeOut, fourOut]);

  const result = await runSweep({ now: NOW });

  expect(result.considered).toBe(1);
  expect(result.targetDate).toBe('2026-08-17');
});

test('gate on: leadDays() is 5, a visit 5 days out is selected, 6 days out is not, an already-claimed visit is not re-sent', async () => {
  process.env.GATE_PREVISIT_BALANCE_5DAY = 'true';
  expect(leadDays()).toBe(5);
  const fiveOut = { id: 'ss-5', scheduled_date: '2026-08-19', balance_reminder_sent_at: null };
  const sixOut = { id: 'ss-6', scheduled_date: '2026-08-20', balance_reminder_sent_at: null };
  const alreadyClaimed = {
    id: 'ss-claimed', scheduled_date: '2026-08-16', balance_reminder_sent_at: new Date('2026-08-01T00:00:00Z'),
  };
  setDb([fiveOut, sixOut, alreadyClaimed]);

  const result = await runSweep({ now: NOW });

  expect(result.considered).toBe(1);
  expect(result.targetDate).toBe('2026-08-19');
});

test('a non-strict spelling never widens the window (strict === "true" only)', async () => {
  process.env.GATE_PREVISIT_BALANCE_5DAY = '1';
  expect(leadDays()).toBe(3);
});
