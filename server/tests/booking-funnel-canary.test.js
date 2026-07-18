/**
 * Booking-funnel conversion canary: fires when real /book funnel entries see
 * zero conversions across a window (the July slot_sig outage signature),
 * stays quiet while a known outage persists (< 24h), sends a recovery notice
 * when conversions reappear, and no-ops entirely while the gate is unset.
 */

jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../models/db', () => {
  const results = [];
  const builder = () => {
    const q = {
      where: jest.fn(() => q),
      whereNotNull: jest.fn(() => q),
      count: jest.fn(() => q),
      first: jest.fn(async () => results.shift()),
    };
    return q;
  };
  const fn = jest.fn(() => builder());
  fn.schema = { hasTable: jest.fn(async () => true) };
  fn._queue = results;
  return fn;
});

jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));

jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })),
}));

jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn(async () => ({ sid: 'SM1' })),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const NotificationService = require('../services/notification-service');
const TwilioService = require('../services/twilio');
const { runBookingFunnelCanary, _test } = require('../services/booking-funnel-canary');

// One run issues 4 counts in order: fast attempts, fast conversions,
// slow attempts, slow conversions.
function queueCounts(fastAttempts, fastConversions, slowAttempts, slowConversions) {
  db._queue.push({ n: String(fastAttempts) }, { n: String(fastConversions) },
    { n: String(slowAttempts) }, { n: String(slowConversions) });
}

beforeEach(() => {
  db.mockClear();
  db._queue.length = 0;
  NotificationService.notifyAdmin.mockClear();
  TwilioService.sendSMS.mockClear();
  _test.state.alerting = null;
  _test.state.lastAlertAt = 0;
  isEnabled.mockReturnValue(true);
  process.env.ADAM_PHONE = '+19415550001';
});

test('no-ops while the gate is off (standard feature-gate registry)', async () => {
  isEnabled.mockReturnValue(false);
  const result = await runBookingFunnelCanary();
  expect(result).toEqual({ skipped: true });
  expect(isEnabled).toHaveBeenCalledWith('bookingFunnelCanary');
  expect(db).not.toHaveBeenCalled();
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('stays quiet when the funnel is converting', async () => {
  queueCounts(6, 2, 9, 3);
  const result = await runBookingFunnelCanary();
  expect(result.firing).toBeNull();
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('stays quiet at low volume even with zero conversions', async () => {
  queueCounts(2, 0, 2, 0);
  const result = await runBookingFunnelCanary();
  expect(result.firing).toBeNull();
  expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
});

test('fires bell + owner SMS on attempts with zero conversions, then stays quiet while the outage persists', async () => {
  queueCounts(6, 0, 8, 0);
  const first = await runBookingFunnelCanary();
  expect(first.firing).toBe('fast');
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(NotificationService.notifyAdmin.mock.calls[0][1]).toMatch(/booking funnel/i);
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  expect(TwilioService.sendSMS.mock.calls[0][2]).toMatchObject({
    messageType: 'internal_alert',
    allowOwnerSms: true,
  });

  queueCounts(7, 0, 9, 0);
  const second = await runBookingFunnelCanary();
  expect(second.firing).toBe('fast');
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
});

test('slow rule catches low-traffic outages over 7 days', async () => {
  queueCounts(3, 0, 4, 0);
  const result = await runBookingFunnelCanary();
  expect(result.firing).toBe('slow');
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
});

test('sends a recovery notice when conversions reappear after an alert', async () => {
  queueCounts(6, 0, 8, 0);
  await runBookingFunnelCanary();
  expect(_test.state.alerting).toBe('fast');

  queueCounts(5, 2, 8, 2);
  const result = await runBookingFunnelCanary();
  expect(result.firing).toBeNull();
  expect(_test.state.alerting).toBeNull();
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(2);
  expect(NotificationService.notifyAdmin.mock.calls[1][1]).toMatch(/recovered/i);
});

test('clears quietly when the rule stops firing without conversions', async () => {
  queueCounts(6, 0, 8, 0);
  await runBookingFunnelCanary();
  expect(_test.state.alerting).toBe('fast');

  // Attempts fell below both thresholds and still no conversions — do not
  // claim recovery, just drop the alert state.
  queueCounts(1, 0, 2, 0);
  await runBookingFunnelCanary();
  expect(_test.state.alerting).toBeNull();
  expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
});
