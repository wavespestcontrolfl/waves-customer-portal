/**
 * GATE_DAY_ONLY_PROMISE part D: the portal chat assistant's tools state only the DATE for a visit whose customer was
 * told only the day, plus the plain "do not state or guess an hour" note. Gate off = today's results. No model call, no
 * database: the schedule rows are fakes and the promise reader (time-promise.js) is mocked.
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
const { arrivalWindowRange } = require('../utils/sms-time-format');

const HOUR_PATTERN = /\d{1,2}(:\d{2})? ?(AM|PM)|\d{1,2} ?(to|-|–) ?\d{1,2}/i;
const NOTE = 'texted the day before (do not state or guess an hour; if the customer needs a set time, offer the reschedule link or the office)';

function thenable(rows) {
  const q = {};
  for (const m of ['where', 'whereIn', 'whereNotNull', 'select', 'orderBy', 'limit']) q[m] = jest.fn(() => q);
  q.offset = jest.fn(async (n) => rows.slice(n, n + 12));
  q.first = jest.fn(async () => rows[0] || null);
  q.then = (res, rej) => Promise.resolve(rows).then(res, rej);
  return q;
}

const verdicts = (map) => new Map(Object.entries(map).map(([id, showHour]) => [id, { showHour, level: showHour ? 'hour' : 'none', eligible: !showHour }]));

beforeEach(() => {
  jest.clearAllMocks();
  mockGates.reserviceStreamline = true;
  timePromise.dayOnlyPromiseOn.mockReturnValue(false);
  reschedulePage.loadById.mockImplementation(async (id) => ({ id }));
  reschedulePage.pageEligibility.mockResolvedValue({ ok: true });
});

describe('get_upcoming_services', () => {
  const ROWS = [
    { id: 'v-day', scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '09:00:00', status: 'confirmed' },
    { id: 'v-hour', scheduled_date: '2026-09-18', service_type: 'Lawn Care', window_start: '13:00:00', status: 'confirmed' },
  ];
  const run = () => { db.mockReturnValue(thenable(ROWS)); return executeToolCall('get_upcoming_services', {}, 'cust-1'); };

  test('gate off: today\'s windows, byte for byte, and no promise read', async () => {
    const out = await run();
    expect(out.services.map((s) => s.window)).toEqual([arrivalWindowRange('09:00:00'), arrivalWindowRange('13:00:00')]);
    expect(JSON.stringify(out)).not.toContain('texted the day before');
    expect(timePromise.loadTimeDisplay).not.toHaveBeenCalled();
  });

  test('gate on: the day-only visit gets the date and the note (no hour), the customer-picked visit keeps its window; ONE read', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'v-day': false, 'v-hour': true }));
    const out = await run();
    expect(timePromise.loadTimeDisplay).toHaveBeenCalledTimes(1);
    expect(out.services[0]).toEqual({ date: '2026-08-18', type: 'Pest Control', window: NOTE, status: 'confirmed' });
    expect(out.services[0].window).not.toMatch(HOUR_PATTERN);
    expect(out.services[1].window).toBe(arrivalWindowRange('13:00:00'));
  });

  test('gate on + the read failed: the day-only wording for every visit', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockRejectedValue(new Error('db down'));
    const out = await run();
    expect(out.services.map((s) => s.window)).toEqual([NOTE, NOTE]);
  });
});

describe('offer_reschedule_link', () => {
  const ROWS = [
    { id: 'r-1', scheduled_date: '2026-10-09', service_type: 'Pest Control', window_start: '10:00', reschedule_token: 'tok_one' },
    { id: 'r-2', scheduled_date: '2026-10-20', service_type: 'Lawn Care', window_start: '13:00', reschedule_token: 'tok_two' },
  ];
  const run = (turn = null) => { db.mockReturnValue(thenable(ROWS)); return executeToolCall('offer_reschedule_link', {}, 'cust-1', [], null, {}, turn); };

  test('gate off: today\'s windows, no promise read', async () => {
    const out = await run();
    expect(out.visits.map((v) => v.window)).not.toContain(NOTE);
    expect(out.visits[0].window).toBe(arrivalWindowRange('10:00'));
    expect(timePromise.loadTimeDisplay).not.toHaveBeenCalled();
  });

  test('gate on: one bulk read; the day-only visit states the date and the note only', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'r-1': false, 'r-2': true }));
    const out = await run();
    expect(timePromise.loadTimeDisplay).toHaveBeenCalledTimes(1);
    expect(out.visits[0]).toEqual({ date: '2026-10-09', type: 'Pest Control', window: NOTE });
    expect(out.visits[0].window).not.toMatch(HOUR_PATTERN);
    expect(out.visits[1].window).toBe(arrivalWindowRange('13:00'));
  });
});

describe('a re-service already booked (offer_reservice)', () => {
  const BOOKED = { date: '2026-10-09', windowStart: '10:00', serviceType: 'Pest Control Re-Service', rescheduleUrl: `/reschedule/${'c'.repeat(64)}` };
  const offer = () => executeToolCall('offer_reservice', { service_line: 'pest' }, 'cust-1', [], null, { secondaryProperty: false, customerMessage: 'The ants are back in the kitchen' });
  beforeEach(() => {
    mockOpen.mockResolvedValue({ pest: BOOKED });
    db.mockImplementation((table) => {
      const chain = { where: jest.fn(() => chain), whereNull: jest.fn(() => chain), first: jest.fn(async () => (table === 'customers' ? { reservice_token: 'a'.repeat(64) } : { id: 'svc-callback-1' })) };
      return chain;
    });
    mockPage.pageLaneState.mockResolvedValue({ customer: {}, laneCatalog: {}, lanes: [], bookableLanes: [] });
    mockPage.reserviceLocationReviewRequired.mockResolvedValue(false);
  });

  test('gate off: its date and window, as today', async () => {
    const out = await offer();
    expect(out.already_booked).toEqual({ date: 'Oct 9, 2026', window: expect.stringMatching(/10/) });
    expect(timePromise.loadTimeDisplay).not.toHaveBeenCalled();
  });

  test('gate on + day-only: the date and the note, no hour; the visit is read by its real start', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'svc-callback-1': false }));
    const out = await offer();
    expect(out.already_booked).toEqual({ date: 'Oct 9, 2026', window: NOTE });
    expect(out.already_booked.window).not.toMatch(HOUR_PATTERN);
    expect(timePromise.loadTimeDisplay.mock.calls[0][1]).toEqual([{ id: 'svc-callback-1', scheduled_date: '2026-10-09', window_start: '10:00:00' }]);
  });

  test('gate on + a customer-picked visit: the window is kept', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'svc-callback-1': true }));
    const out = await offer();
    expect(out.already_booked.window).toMatch(/10/);
    expect(out.already_booked.window).not.toBe(NOTE);
  });

  test('gate on + the read failed: the day-only wording', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockRejectedValue(new Error('db down'));
    const out = await offer();
    expect(out.already_booked.window).toBe(NOTE);
  });
});
