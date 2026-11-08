/**
 * GATE_DAY_ONLY_PROMISE part D: the voice agent's visit lookup (get_today_eta) and its booked re-service answer
 * (request_reservice) state only the DATE for a visit whose customer was told only the day, plus the plain "do not state or
 * guess an hour" note. Gate off = today's text. No model call, no database: rows are fakes, the promise reader is mocked.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false), reportWriterRulesLive: jest.fn(() => false) }));
jest.mock('../services/call-recording-processor', () => ({ CONTACT_MATCH_PHONE_COLS: ['phone'], summarizePriorCall: jest.fn() }));
jest.mock('../services/call-booking-source-actions', () => ({ DISPATCH_OWNED_PENDING_SOURCE_ACTIONS: ['call_followup'] }));
jest.mock('../services/project-types', () => ({ customerSafeServiceNotes: jest.fn((n) => n) }));
jest.mock('../services/pricing-engine', () => ({ generateEstimate: jest.fn() }));
jest.mock('../services/service-report/reentry', () => ({ buildReentryContext: jest.fn() }));
jest.mock('../services/reservice-scheduler', () => ({
  openReserviceCallbacks: jest.fn(async () => ({})),
  reserviceLanesForCustomer: jest.fn(async () => ['pest']),
  RESERVICE_LANES: { pest: { serviceKey: 'pest_reservice' }, lawn: { serviceKey: 'lawn_reservice' } },
  openCallbackExistsForLane: jest.fn(async () => false),
}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n-1' })) }));
jest.mock('../services/voice-agent/relay-alert', () => ({ alertOwnerHotLead: jest.fn(async () => false), alertOwnerReservice: jest.fn(async () => true) }));
jest.mock('../services/time-promise', () => ({ dayOnlyPromiseOn: jest.fn(), loadTimeDisplay: jest.fn() }));
jest.mock('../utils/datetime-et', () => {
  const actual = jest.requireActual('../utils/datetime-et');
  return { ...actual, etDateString: jest.fn(() => '2026-08-12') };
});

const db = require('../models/db');
const timePromise = require('../services/time-promise');
const reserviceScheduler = require('../services/reservice-scheduler');
const { executeTool } = require('../services/voice-agent/relay-tools');

const HOUR_PATTERN = /\d{1,2}(:\d{2})? ?(AM|PM)|\d{1,2} to \d{1,2}/i;
const NOTE = 'texted the day before (do not state or guess an hour; if the customer needs a set time, offer the reschedule link or the office)';
const CUSTOMER_ID = 'c-1111';
const FULL = { customerId: CUSTOMER_ID, customerTier: 'full', callerAttested: true };

function makeBuilder(rows) {
  const b = {};
  for (const m of ['where', 'whereNull', 'whereIn', 'whereNotIn', 'whereNot', 'whereRaw', 'orWhere', 'orWhereNot', 'orWhereNotIn', 'orderBy', 'orderByRaw', 'select', 'limit']) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  return b;
}
const prime = (tables) => {
  const builders = {};
  for (const [t, rows] of Object.entries(tables)) builders[t] = makeBuilder(rows);
  db.mockImplementation((t) => builders[t] || (builders[t] = makeBuilder([])));
};
const verdicts = (map) => new Map(Object.entries(map).map(([id, showHour]) => [id, { showHour, level: showHour ? 'hour' : 'none', eligible: !showHour }]));

const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
afterAll(() => {
  if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
});
beforeEach(() => {
  jest.clearAllMocks();
  process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';
  timePromise.dayOnlyPromiseOn.mockReturnValue(false);
});

describe('get_today_eta', () => {
  const VISIT = {
    id: 'ss-1', status: 'confirmed', service_type: 'Pest Control', window_start: '09:00:00', window_end: '11:00:00',
    track_state: 'scheduled', en_route_at: null, arrived_at: null, customer_confirmed: true,
  };
  const eta = () => { prime({ scheduled_services: [VISIT] }); return executeTool('get_today_eta', {}, FULL); };

  test('gate off: today\'s window, byte for byte, and no promise read', async () => {
    const out = await eta();
    expect(out).toBe('Today\'s appointment window is 9 AM to 11 AM for Pest Control. The technician has not started toward the property yet, so there is no live arrival time. Give the window only; never invent a more precise ETA.');
    expect(timePromise.loadTimeDisplay).not.toHaveBeenCalled();
  });

  test('gate on + day-only: no hour anywhere, the note present, one read', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'ss-1': false }));
    const out = await eta();
    expect(timePromise.loadTimeDisplay).toHaveBeenCalledTimes(1);
    expect(out).toContain(`Arrival window: ${NOTE}`);
    expect(out).toContain('Pest Control');
    expect(out.replace(NOTE, '')).not.toMatch(HOUR_PATTERN);
    expect(out).not.toMatch(/Give the window only/);
  });

  test('gate on + customer-picked visit: the hour is kept exactly as today', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'ss-1': true }));
    const out = await eta();
    expect(out).toContain('Today\'s appointment window is 9 AM to 11 AM for Pest Control.');
    expect(out).not.toContain('texted the day before');
  });

  test('gate on + the read failed: the day-only wording, never the hour', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockRejectedValue(new Error('db down'));
    const out = await eta();
    expect(out).toContain(NOTE);
    expect(out.replace(NOTE, '')).not.toMatch(HOUR_PATTERN);
  });

  test('gate on + no window on the row: day-only never falls back to the reminder time', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'ss-1': false }));
    prime({ scheduled_services: [{ ...VISIT, window_start: null }], appointment_reminders: [{ appointment_time: new Date('2026-08-12T17:30:00Z') }] });
    const out = await executeTool('get_today_eta', {}, FULL);
    expect(out.replace(NOTE, '')).not.toMatch(HOUR_PATTERN);
    expect(db).not.toHaveBeenCalledWith('appointment_reminders');
  });
});

describe('request_reservice: a re-service already booked', () => {
  const GOOD = { lane: 'pest', issue: 'ants are back in the kitchen along the baseboard' };
  const CTX = { ...FULL, from: '+19415550142', callSid: 'CA-res-1', markCaptured: jest.fn(), markReserviceFiled: jest.fn() };
  const WITH_TOKEN = { date: '2026-08-20', windowStart: '09:00', serviceType: 'Re-Service', rescheduleUrl: `/reschedule/${'d'.repeat(64)}` };
  const book = (entry = WITH_TOKEN) => {
    reserviceScheduler.openReserviceCallbacks.mockResolvedValue({ pest: entry });
    prime({ scheduled_services: [{ id: 'ss-9' }], service_requests: [], customers: [{ id: CUSTOMER_ID, active: true }] });
    return executeTool('request_reservice', GOOD, CTX);
  };

  test('gate off: today\'s window and no promise read', async () => {
    const out = await book();
    expect(out).toMatch(/\(arrival window 09:00-11:00\)/);
    expect(timePromise.loadTimeDisplay).not.toHaveBeenCalled();
  });

  test('gate on + day-only: the date and the note, no hour; the visit is read by its real start', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'ss-9': false }));
    const out = await book();
    expect(out).toContain(`(arrival window: ${NOTE})`);
    expect(out.replace(NOTE, '')).not.toMatch(HOUR_PATTERN);
    expect(out).not.toContain('09:00');
    expect(timePromise.loadTimeDisplay.mock.calls[0][1]).toEqual([{ id: 'ss-9', scheduled_date: '2026-08-20', window_start: '09:00:00' }]);
  });

  test('gate on + customer-picked visit: the window is kept', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockResolvedValue(verdicts({ 'ss-9': true }));
    const out = await book();
    expect(out).toMatch(/\(arrival window 09:00-11:00\)/);
  });

  test('gate on + the read failed, or no visit id to judge by: the day-only wording', async () => {
    timePromise.dayOnlyPromiseOn.mockReturnValue(true);
    timePromise.loadTimeDisplay.mockRejectedValue(new Error('db down'));
    expect(await book()).toContain(`(arrival window: ${NOTE})`);
    const { rescheduleUrl, ...noToken } = WITH_TOKEN;
    expect(await book(noToken)).toContain(`(arrival window: ${NOTE})`);
  });
});
