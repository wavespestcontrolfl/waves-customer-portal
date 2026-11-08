/**
 * GATE_DAY_ONLY_PROMISE part D: the voice agent's context states only the DATE for a visit whose customer was told only
 * the day, plus the plain "do not state or guess an hour" note. Gate off = today's text. No model call, no database:
 * the schedule rows are fakes and the promise reader (time-promise.js) is mocked.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/call-booking-source-actions', () => ({ DISPATCH_OWNED_PENDING_SOURCE_ACTIONS: ['call_followup'] }));
jest.mock('../utils/service-normalizer', () => ({ normalizeServiceType: jest.fn((v) => v) }));
jest.mock('../services/waveguard-existing-services', () => ({ loadOwnedRecurringServiceKeys: jest.fn(async () => []) }));
jest.mock('../services/open-balance', () => ({
  openBalanceSummary: jest.fn(async () => ({ total: 0, count: 0, moreCount: 0, invoices: [] })),
  openBalanceExists: jest.fn(async () => false),
}));
jest.mock('../services/time-promise', () => ({ dayOnlyPromiseOn: jest.fn(), loadTimeDisplay: jest.fn() }));

const db = require('../models/db');
const timePromise = require('../services/time-promise');
const relayContext = require('../services/voice-agent/relay-context');

const HOUR_PATTERN = /\d{1,2}(:\d{2})? ?(AM|PM)|\d{1,2} to \d{1,2}/i;
const NOTE = 'arrival window: texted the day before (do not state or guess an hour; if the customer needs a set time, offer the reschedule link or the office)';

function makeBuilder(rows) {
  const b = {};
  for (const m of ['whereNull', 'whereIn', 'orderBy', 'select', 'limit', 'whereNot', 'orWhere', 'orWhereNot', 'orWhereNotIn']) b[m] = jest.fn(() => b);
  b.where = jest.fn((arg) => { if (typeof arg === 'function') arg.call(b, b); return b; });
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return b;
}

const VISIT = { id: 'visit-1', scheduled_date: '2026-08-18', service_type: 'Pest Control', window_start: '09:00:00', window_end: '15:00:00', status: 'confirmed' };

function primeSchedule(rows) {
  db.mockImplementation(() => makeBuilder(rows));
}

const overview = () => relayContext.accountOverviewText('c-1111', { tier: 'full', attested: true });

beforeEach(() => {
  jest.clearAllMocks();
  timePromise.dayOnlyPromiseOn.mockReturnValue(false);
  primeSchedule([VISIT]);
});

describe('account overview (lookup tool text)', () => {
  test('gate off: today\'s text, the window is stated, the promise reader is never called', async () => {
    const out = await overview();
    expect(out).toContain('Next appointment: Tuesday August 18 for Pest Control, arrival window 9:00 AM to 11:00 AM.');
    expect(timePromise.loadTimeDisplay).not.toHaveBeenCalled();
  });

  test('gate on + day-only visit: the date and the note, no hour anywhere in the line', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(new Map([['visit-1', { showHour: false, level: 'none', eligible: true }]]));
    const out = await overview();
    const line = out.match(/Next appointment:[^.]*\./)[0];
    expect(line).toContain('Tuesday August 18 for Pest Control');
    expect(line).toContain(NOTE);
    expect(line.replace(NOTE, '')).not.toMatch(HOUR_PATTERN);
    expect(timePromise.loadTimeDisplay).toHaveBeenCalledTimes(1);
  });

  test('gate on + customer-picked visit: the hour is kept exactly as today', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(new Map([['visit-1', { showHour: true, level: 'hour', eligible: false }]]));
    const out = await overview();
    expect(out).toContain('Next appointment: Tuesday August 18 for Pest Control, arrival window 9:00 AM to 11:00 AM.');
    expect(out).not.toContain('texted the day before');
  });

  test('gate on + the read failed: the day-only wording, never the hour', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockRejectedValue(new Error('db down'));
    const out = await overview();
    expect(out).toContain(NOTE);
    expect(out).not.toContain('9:00 AM');
  });
});

describe('KNOWN CALLER block', () => {
  const base = { customer: { first_name: 'Pat', member_since: '2023-04-01T00:00:00Z' }, services: [], lastVisit: null, balance: null, priorCall: null, tier: 'full', attested: true };

  test('gate off / hour visit: today\'s line', () => {
    const out = relayContext.buildKnownCallerBlock({ ...base, nextAppointment: { date: 'Tuesday, August 18th', service: 'Pest Control', window: '9:00 AM to 11:00 AM' } });
    expect(out).toContain('Next appointment: Tuesday, August 18th — Pest Control (window starts 9:00 AM to 11:00 AM)');
  });

  test('day-only visit: the date and the note, no hour', () => {
    const out = relayContext.buildKnownCallerBlock({ ...base, nextAppointment: { date: 'Tuesday, August 18th', service: 'Pest Control', window: null, windowDayOnly: true } });
    const line = out.split('\n').find((l) => l.startsWith('Next appointment:'));
    expect(line).toBe(`Next appointment: Tuesday, August 18th — Pest Control (${NOTE})`);
    expect(line.replace(NOTE, '')).not.toMatch(HOUR_PATTERN);
  });
});
