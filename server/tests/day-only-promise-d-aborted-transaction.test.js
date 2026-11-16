/**
 * GATE_DAY_ONLY_PROMISE part D: a day-only promise read that FAILS inside the portal turn's transaction. The SQL error leaves
 * the PostgreSQL transaction aborted even though loadDayOnlyCheck swallows it, so turn.transaction's closing query rejects.
 * The tools must still answer in their normal shape with the date-only wording; a cancellation must still throw.
 * Fake turn + mocked promise reader; no model call, no database.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/reschedule-public', () => ({ _internals: { TOKEN_RE: /^[a-f0-9]{64}$/, loadById: jest.fn(), pageEligibility: jest.fn() } }));
const mockPage = { TOKEN_RE: /^[a-f0-9]{64}$/, pageLaneState: jest.fn(), reserviceLocationReviewRequired: jest.fn() };
jest.mock('../routes/reservice-public', () => ({ _internals: mockPage }));
jest.mock('../services/portal-payment-history', () => ({ listPortalPayments: jest.fn() }));
jest.mock('../services/portal-service-history', () => ({ listPortalServiceHistory: jest.fn() }));
const mockGates = { reserviceStreamline: true };
jest.mock('../config/feature-gates', () => ({ isEnabled: (name) => mockGates[name] === true }));
jest.mock('../services/time-promise', () => ({ dayOnlyPromiseOn: jest.fn(), loadTimeDisplay: jest.fn() }));
const mockOpen = jest.fn();
jest.mock('../services/reservice-scheduler', () => {
  const actual = jest.requireActual('../services/reservice-scheduler');
  return {
    reportedReserviceLanes: actual.reportedReserviceLanes,
    reportedReserviceExcludedSpecialty: actual.reportedReserviceExcludedSpecialty,
    isActivePestReport: actual.isActivePestReport,
    RESERVICE_LAWN_SERVICE_WORDS: actual.RESERVICE_LAWN_SERVICE_WORDS,
    reserviceSelfServeEnabled: () => true,
    openReserviceCallbacks: (...a) => mockOpen(...a),
  };
});

const db = require('../models/db');
const timePromise = require('../services/time-promise');
const { _internals: reschedulePage } = require('../routes/reschedule-public');
const { executeToolCall } = require('../services/ai-assistant/tools');


const NOTE = 'texted the day before (do not state or guess an hour; if the customer needs a set time, offer the reschedule link or the office)';
const HOUR_PATTERN = /\d{1,2}(:\d{2})? ?(AM|PM)|\d{1,2} ?(to|-|–) ?\d{1,2}/i;

function thenable(rows) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNotNull', 'select', 'orderBy', 'limit']) q[m] = jest.fn(() => q);
  q.offset = jest.fn(async (n) => rows.slice(n, n + 12));
  q.first = jest.fn(async () => rows[0] || null);
  q.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  return q;
}

/** A turn whose transaction behaves like Postgres: once a statement inside it failed, the closing query rejects. */
function abortedTurn() {
  const turn = {
    assertActive: jest.fn(),
    query: jest.fn(async (query) => query),
    transaction: jest.fn(async (stage, container) => {
      const trx = (...args) => db(...args);
      trx.aborted = false;
      const result = await container(trx);
      if (trx.aborted) throw Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' });
      return result;
    }),
  };
  return turn;
}

/** The promise reader fails on its read: it marks every row failed (as the real one does) and aborts the transaction. */
const failedReader = () => async (conn, rows) => {
  conn.aborted = true;
  return new Map(rows.map((r) => [r.id, { showHour: true, level: 'hour', eligible: false, failed: true }]));
};

beforeEach(() => {
  jest.clearAllMocks();
  mockGates.reserviceStreamline = true;
  timePromise.dayOnlyPromiseOn.mockReturnValue(true);
  timePromise.loadTimeDisplay.mockImplementation(failedReader());
  reschedulePage.loadById.mockImplementation(async (id) => ({ id }));
  reschedulePage.pageEligibility.mockResolvedValue({ ok: true });
});

describe('get_upcoming_services in a turn whose transaction aborts on the promise read', () => {
  const ROWS = [
    { id: 'v-1', scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '09:00:00', status: 'confirmed' },
    { id: 'v-2', scheduled_date: '2026-09-18', service_type: 'Lawn Care', window_start: '13:00:00', status: 'confirmed' },
  ];
  const run = (turn) => { db.mockReturnValue(thenable(ROWS)); return executeToolCall('get_upcoming_services', {}, 'cust-1', [], null, {}, turn); };

  test('returns its normal shape with the date-only wording for every visit (no tool error)', async () => {
    const out = await run(abortedTurn());
    expect(out.error).toBeUndefined();
    expect(out.services).toEqual([
      { date: '2026-08-18', type: 'Pest Control', window: NOTE, status: 'confirmed' },
      { date: '2026-09-18', type: 'Lawn Care', window: NOTE, status: 'confirmed' },
    ]);
    expect(out.services[0].window).not.toMatch(HOUR_PATTERN);
  });

  test('a cancellation (turn deadline) still throws', async () => {
    const turn = abortedTurn();
    turn.transaction.mockRejectedValue(Object.assign(new Error('deadline'), { code: 'PORTAL_CHAT_DEADLINE' }));
    await expect(run(turn)).rejects.toMatchObject({ code: 'PORTAL_CHAT_DEADLINE' });
  });

  test('a statement-timeout cancellation (57014) still throws', async () => {
    const turn = abortedTurn();
    turn.transaction.mockRejectedValue(Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
    await expect(run(turn)).rejects.toMatchObject({ code: '57014' });
  });

  test('gate off: no transaction and no read', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(false);
    const turn = abortedTurn();
    const out = await run(turn);
    expect(out.services.map((s) => s.window)).not.toContain(NOTE);
    expect(turn.transaction).not.toHaveBeenCalled();
  });
});

describe('offer_reschedule_link in a turn whose transaction aborts on the promise read', () => {
  const ROWS = [
    { id: 'r-1', scheduled_date: '2026-10-09', service_type: 'Pest Control', window_start: '10:00', reschedule_token: 'tok_one' },
    { id: 'r-2', scheduled_date: '2026-10-20', service_type: 'Lawn Care', window_start: '13:00', reschedule_token: 'tok_two' },
  ];
  const run = (turn) => { db.mockReturnValue(thenable(ROWS)); return executeToolCall('offer_reschedule_link', {}, 'cust-1', [], null, {}, turn); };

  test('returns its normal shape with the date-only wording for every visit (no tool error)', async () => {
    const out = await run(abortedTurn());
    expect(out.error).toBeUndefined();
    expect(out.visits).toEqual([
      { date: '2026-10-09', type: 'Pest Control', window: NOTE },
      { date: '2026-10-20', type: 'Lawn Care', window: NOTE },
    ]);
  });

  test('a cancellation on the promise read still throws', async () => {
    const turn = abortedTurn();
    const real = turn.transaction.getMockImplementation();
    turn.transaction.mockImplementation(async (stage, container) => {
      if (stage === 'day-only promise') throw Object.assign(new Error('deadline'), { code: 'PORTAL_CHAT_DEADLINE' });
      return real(stage, container);
    });
    await expect(run(turn)).rejects.toMatchObject({ code: 'PORTAL_CHAT_DEADLINE' });
  });
});

describe('a booked re-service in a turn whose transaction aborts on the promise read', () => {
  const BOOKED = { date: '2026-10-09', windowStart: '10:00', serviceType: 'Pest Control Re-Service', rescheduleUrl: `/reschedule/${'c'.repeat(64)}` };
  beforeEach(() => {
    mockOpen.mockResolvedValue({ pest: BOOKED });
    db.mockImplementation((table) => {
      const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), first: jest.fn(async () => (table === 'customers' ? { reservice_token: 'a'.repeat(64) } : { id: 'svc-callback-1' })) };
      return chain;
    });
    mockPage.pageLaneState.mockResolvedValue({ customer: {}, laneCatalog: {}, lanes: [], bookableLanes: [] });
    mockPage.reserviceLocationReviewRequired.mockResolvedValue(false);
  });

  test('keeps the booked visit facts in the date-only wording', async () => {
    const out = await executeToolCall('offer_reservice', { service_line: 'pest' }, 'cust-1', [], null,
      { secondaryProperty: false, customerMessage: 'The ants are back in the kitchen' }, abortedTurn());
    expect(out.error).toBeUndefined();
    expect(out.already_booked).toEqual({ date: 'Oct 9, 2026', window: NOTE });
  });
});
