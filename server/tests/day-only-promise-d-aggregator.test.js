/**
 * GATE_DAY_ONLY_PROMISE part D: the context aggregator (the texting AI's grounding) and the SMS draft helper's facts block
 * state only the DATE for a visit whose customer was told only the day, plus the plain "do not state or guess an hour"
 * note. Gate off = today's context. No model call, no database: the rows are fakes and the promise reader is mocked.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/visit-loops-facts', () => ({
  loadVisitLoops: jest.fn(),
  emptyVisitLoops: () => ({ lateAlert: null, pastWindow: null, weOwe: [], customerWaiting: [] }),
}));
jest.mock('../services/time-promise', () => ({ dayOnlyPromiseOn: jest.fn(), loadTimeDisplay: jest.fn() }));

const db = require('../models/db');
db.schema = { hasTable: async () => true };
const timePromise = require('../services/time-promise');
const ContextAggregator = require('../services/context-aggregator');
const { buildFactsBlock } = require('../services/sms-shadow-drafter');

const HOUR_PATTERN = /\d{1,2}(:\d{2})? ?(AM|PM)|\d{1,2} to \d{1,2}/i;
const NOTE = 'texted the day before (do not state or guess an hour; if the customer needs a set time, offer the reschedule link or the office)';

function genericQuery(resolveValue = []) {
  const proxy = new Proxy(function () {}, {
    get(_target, prop) {
      if (prop === 'then') return (res, rej) => Promise.resolve(resolveValue).then(res, rej);
      if (prop === 'catch') return (rej) => Promise.resolve(resolveValue).then(undefined, rej);
      if (prop === 'first') return () => Promise.resolve(Array.isArray(resolveValue) ? (resolveValue[0] ?? null) : (resolveValue ?? null));
      if (prop === 'count') return () => ({ first: async () => ({ count: '0', c: '0' }) });
      return () => proxy;
    },
  });
  return proxy;
}

const customer = {
  id: 'cust-d-1', first_name: 'Pat', last_name: 'Doe', phone: '+19415551234',
  email: 'pat@example.com', address_line1: '1 Main St', city: 'Bradenton', zip: '34205',
  waveguard_tier: null, monthly_rate: 0, pipeline_stage: 'active_customer', lead_score: null,
  customer_since: '2024-01-01', deleted_at: null, autopay_enabled: false,
  billing_mode: null, ach_status: null, autopay_paused_until: null, autopay_payment_method_id: null,
};

// Far enough out that the visits are never "today" (no live status lines).
const VISITS = [
  { id: 'v-day', service_type: 'Pest Control', scheduled_date: '2099-03-02', window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed', technician_name: 'Jamie Rivera', track_state: null },
  { id: 'v-hour', service_type: 'Lawn Care', scheduled_date: '2099-04-06', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed', technician_name: 'Jamie Rivera', track_state: null },
];

const verdicts = (map) => new Map(Object.entries(map).map(([id, showHour]) => [id, { showHour, level: showHour ? 'hour' : 'none', eligible: !showHour }]));
const build = () => ContextAggregator.getContextForCustomer(customer);

beforeEach(() => {
  jest.clearAllMocks();
  timePromise.dayOnlyPromiseOn.mockReturnValue(false);
  db.mockImplementation((table) => (String(table).startsWith('scheduled_services') ? genericQuery(VISITS) : genericQuery([])));
});

describe('context aggregator: upcomingServices[].window', () => {
  test('gate off: today\'s context, the same keys and values, and no promise read', async () => {
    const context = await build();
    expect(context.upcomingServices.map((s) => s.window)).toEqual(['9:00 AM–11:00 AM', '1:00 PM–3:00 PM']);
    expect(context.upcomingServices.every((s) => !('windowDayOnly' in s))).toBe(true);
    expect(timePromise.loadTimeDisplay).not.toHaveBeenCalled();
  });

  test('gate on: ONE bulk read; the day-only visit carries the note and no hour, the customer-picked visit keeps its window', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'v-day': false, 'v-hour': true }));
    const context = await build();
    expect(timePromise.loadTimeDisplay).toHaveBeenCalledTimes(1);
    const [dayOnly, picked] = context.upcomingServices;
    expect(dayOnly.window).toBe(NOTE);
    expect(dayOnly.windowDayOnly).toBe(true);
    expect(dayOnly.window).not.toMatch(HOUR_PATTERN);
    expect(picked.window).toBe('1:00 PM–3:00 PM');
    expect('windowDayOnly' in picked).toBe(false);
    // The one-line summary names the date only; nothing in it is an hour.
    expect(context.summary).not.toMatch(HOUR_PATTERN);
  });

  test('gate on + the read failed: every listed visit says only the day', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockRejectedValue(new Error('db down'));
    const context = await build();
    expect(context.upcomingServices.map((s) => s.window)).toEqual([NOTE, NOTE]);
  });
});

describe('SMS draft helper facts block (buildFactsBlock)', () => {
  const upcomingLines = (facts) => facts.split('\n').filter((l) => /^- (Pest Control|Lawn Care) on /.test(l));

  test('gate off context: today\'s line, "window 9:00 AM–11:00 AM"', async () => {
    const facts = buildFactsBlock(await build());
    expect(upcomingLines(facts).join('\n')).toContain('window 9:00 AM–11:00 AM');
    expect(facts).not.toContain('texted the day before');
  });

  test('day-only visit: the date, "arrival window:" and the note, no hour; the picked visit keeps its window', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'v-day': false, 'v-hour': true }));
    const facts = buildFactsBlock(await build());
    const [dayLine, pickedLine] = upcomingLines(facts);
    expect(dayLine).toContain('Pest Control');
    expect(dayLine).toContain(`arrival window: ${NOTE}`);
    expect(dayLine.replace(NOTE, '')).not.toMatch(HOUR_PATTERN);
    expect(pickedLine).toContain('window 1:00 PM–3:00 PM');
  });

  test('a hand-built context without the day-only key renders exactly as today', () => {
    const facts = buildFactsBlock({ upcomingServices: [{ type: 'Pest Control', date: '2099-03-02', window: null, tech: null, status: 'confirmed' }] });
    expect(facts).toContain('no arrival window set');
  });
});
