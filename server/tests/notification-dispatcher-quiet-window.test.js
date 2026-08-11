/**
 * deferredNotificationStillWanted × customer quiet hours vs the global
 * 8AM-8PM ET send window (codex r13 P2, PR #3259).
 *
 * A customer whose OWN quiet window covers the entire global window (e.g.
 * 08:00-21:00) has NO deliverable minute: the replay scheduled for the
 * quiet-hours end is rejected by the global cutoff and rescheduled back to
 * 08:00 — with the attempt refunded each cycle — forever. The recheck must
 * detect the empty intersection and terminally suppress (no retryable flag)
 * so the row gets its blocked settlement instead of ping-ponging.
 *
 * All instants are fixed UTC (August = EDT, UTC-4) so the assertions don't
 * depend on when the suite runs.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));

const mockState = { prefs: null };
jest.mock('../models/db', () => jest.fn(() => ({
  where: jest.fn().mockReturnThis(),
  first: jest.fn(async () => mockState.prefs),
})));

const { deferredNotificationStillWanted } = require('../services/notification-dispatcher');
const logger = require('../services/logger');

// review_request has a real toggle + channel column in TYPE_MAP.
const TYPE = 'review_request';
const basePrefs = (quietStart, quietEnd) => ({
  review_request: true,
  review_request_channel: 'sms',
  quiet_hours_start: quietStart,
  quiet_hours_end: quietEnd,
});

const NOON_ET = new Date('2026-08-07T16:00:00Z');      // 12:00 ET
const EIGHT_THIRTY_AM_ET = new Date('2026-08-07T12:30:00Z'); // 08:30 ET
const NINE_PM_ET = new Date('2026-08-08T01:00:00Z');   // 21:00 ET

beforeEach(() => {
  jest.clearAllMocks();
  mockState.prefs = null;
});

test('quiet 08:00-21:00 covers the whole window → terminal suppress, alert logged', async () => {
  mockState.prefs = basePrefs('08:00:00', '21:00:00');
  const res = await deferredNotificationStillWanted(TYPE, 'cust-1', NOON_ET);
  expect(res).toEqual({ eligible: false, reason: 'quiet_hours_cover_send_window' });
  expect(res.retryable).toBeUndefined();
  expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('cover the entire'));
});

test('quiet 07:30-20:00 (exactly reaching the close) is also terminal', async () => {
  mockState.prefs = basePrefs('07:30:00', '20:00:00');
  const res = await deferredNotificationStillWanted(TYPE, 'cust-1', NOON_ET);
  expect(res).toEqual({ eligible: false, reason: 'quiet_hours_cover_send_window' });
});

test('wraparound 22:00-09:00 leaves 09:00-20:00 deliverable → normal retryable hold', async () => {
  mockState.prefs = basePrefs('22:00:00', '09:00:00');
  const res = await deferredNotificationStillWanted(TYPE, 'cust-1', EIGHT_THIRTY_AM_ET);
  expect(res.eligible).toBe(false);
  expect(res.reason).toBe('customer_quiet_hours');
  expect(res.retryable).toBe(true);
  expect(res.retryAt).toBeInstanceOf(Date);
});

test('wraparound 20:00-08:00 (the exact global window as the gap) stays retryable', async () => {
  mockState.prefs = basePrefs('20:00:00', '08:00:00');
  const res = await deferredNotificationStillWanted(TYPE, 'cust-1', NINE_PM_ET);
  expect(res.eligible).toBe(false);
  expect(res.reason).toBe('customer_quiet_hours');
  expect(res.retryable).toBe(true);
});

test('outside quiet hours the notification is simply eligible', async () => {
  mockState.prefs = basePrefs('22:00:00', '06:00:00');
  const res = await deferredNotificationStillWanted(TYPE, 'cust-1', NOON_ET);
  expect(res).toEqual({ eligible: true });
});
