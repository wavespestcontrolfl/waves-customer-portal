/**
 * Booking-funnel conversion canary: fires when real /book funnel entries see
 * zero conversions across a window (the July slot_sig outage signature),
 * raises one keyed open-only bell (state is the row, so a restart re-rings
 * nothing), texts the owner only for a fresh row, closes the row on recovery,
 * rethrows read errors, and no-ops entirely while the gate is unset.
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

jest.mock('../services/admin-alert-compose', () => ({
  raiseAdminAlert: jest.fn(async () => ({ id: 'notif-1' })),
}));

jest.mock('../services/admin-alert-episodes', () => ({
  openAdminAlertKeys: jest.fn(async () => []),
  closeAdminAlertKeys: jest.fn(async () => 1),
}));

jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn(async () => ({ sid: 'SM1' })),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const episodes = require('../services/admin-alert-episodes');
const TwilioService = require('../services/twilio');
const { runBookingFunnelCanary } = require('../services/booking-funnel-canary');

// One run issues 4 counts in order: fast attempts, fast conversions,
// slow attempts, slow conversions.
function queueCounts(fastAttempts, fastConversions, slowAttempts, slowConversions) {
  db._queue.push({ n: String(fastAttempts) }, { n: String(fastConversions) },
    { n: String(slowAttempts) }, { n: String(slowConversions) });
}

// The standing open row for a key, as the episodes edge reports it.
const openRows = (...keys) => episodes.openAdminAlertKeys.mockImplementation(async (_conn, key) => (keys.includes(key) ? [key] : []));

beforeEach(() => {
  db.mockClear();
  db._queue.length = 0;
  raiseAdminAlert.mockReset().mockResolvedValue({ id: 'notif-1' });
  episodes.openAdminAlertKeys.mockReset().mockResolvedValue([]);
  episodes.closeAdminAlertKeys.mockReset().mockResolvedValue(1);
  TwilioService.sendSMS.mockClear();
  isEnabled.mockReturnValue(true);
  process.env.ADAM_PHONE = '+19415550001';
});

test('no-ops while the gate is off (standard feature-gate registry)', async () => {
  isEnabled.mockReturnValue(false);
  const result = await runBookingFunnelCanary();
  expect(result).toEqual({ skipped: true });
  expect(isEnabled).toHaveBeenCalledWith('bookingFunnelCanary');
  expect(db).not.toHaveBeenCalled();
  expect(raiseAdminAlert).not.toHaveBeenCalled();
});

test('stays quiet when the funnel is converting', async () => {
  queueCounts(6, 2, 9, 3);
  const result = await runBookingFunnelCanary();
  expect(result.firing).toBeNull();
  expect(raiseAdminAlert).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('stays quiet at low volume even with zero conversions', async () => {
  queueCounts(2, 0, 2, 0);
  const result = await runBookingFunnelCanary();
  expect(result.firing).toBeNull();
  expect(raiseAdminAlert).not.toHaveBeenCalled();
});

test('fires one keyed bell + owner SMS on attempts with zero conversions', async () => {
  queueCounts(6, 0, 8, 0);
  const first = await runBookingFunnelCanary();
  expect(first.firing).toBe('fast');
  expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
  expect(category).toBe('system');
  expect(spec).toMatchObject({ area: 'System', severity: 'needs-you', link: '/admin/schedule' });
  expect(opts).toMatchObject({ dedupeKey: 'booking-funnel-canary:fast', dedupeOpenOnly: true });
  expect(opts.detail).toMatch(/ZERO bookings/);
  // The real composer accepts the spec (headline, why, link, subject, done-when).
  expect(() => jest.requireActual('../services/admin-alert-compose').composeAdminAlert(spec)).not.toThrow();
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  expect(TwilioService.sendSMS.mock.calls[0][2]).toMatchObject({
    messageType: 'internal_alert',
    allowOwnerSms: true,
  });
});

test('a restart or a persisting outage (the standing row dedupes) rings and texts nothing new', async () => {
  raiseAdminAlert.mockResolvedValue({ id: 'notif-1', deduped: true });
  queueCounts(7, 0, 9, 0);
  const result = await runBookingFunnelCanary();
  expect(result.firing).toBe('fast');
  expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('a suppressed raise (bell policy) is not a fresh episode', async () => {
  raiseAdminAlert.mockResolvedValue({ id: null, suppressed: true });
  queueCounts(7, 0, 9, 0);
  await runBookingFunnelCanary();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('a failed bell write still texts the owner (nothing was stored)', async () => {
  raiseAdminAlert.mockRejectedValue(new Error('db down'));
  queueCounts(6, 0, 8, 0);
  await runBookingFunnelCanary();
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
});

test('slow rule catches low-traffic outages over 7 days, under its own key', async () => {
  queueCounts(3, 0, 4, 0);
  const result = await runBookingFunnelCanary();
  expect(result.firing).toBe('slow');
  expect(raiseAdminAlert.mock.calls[0][2]).toMatchObject({ dedupeKey: 'booking-funnel-canary:slow' });
});

test('the other rule\'s standing row is closed when this rule takes over', async () => {
  openRows('booking-funnel-canary:fast');
  queueCounts(3, 0, 4, 0);
  await runBookingFunnelCanary();
  expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(db, ['booking-funnel-canary:fast'], 'conversions_back', expect.any(Object));
});

test('closes the row and texts a recovery line when conversions reappear after an alert', async () => {
  openRows('booking-funnel-canary:fast');
  queueCounts(5, 2, 8, 2);
  const result = await runBookingFunnelCanary();
  expect(result.firing).toBeNull();
  expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(
    db, ['booking-funnel-canary:fast'], 'conversions_back',
    expect.objectContaining({ resolution: expect.stringMatching(/Recovered/) }),
  );
  expect(raiseAdminAlert).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  expect(TwilioService.sendSMS.mock.calls[0][1]).toMatch(/recovered/i);
});

test('clears quietly when the rule stops firing without conversions', async () => {
  openRows('booking-funnel-canary:fast');
  // Attempts fell below both thresholds and still no conversions: do not
  // claim recovery, just close the row.
  queueCounts(1, 0, 2, 0);
  await runBookingFunnelCanary();
  expect(episodes.closeAdminAlertKeys).toHaveBeenCalledWith(
    db, ['booking-funnel-canary:fast'], 'conversions_back',
    expect.objectContaining({ resolution: expect.stringMatching(/Cleared/) }),
  );
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});

test('a read error is logged and rethrown so job_health records the run', async () => {
  db.schema.hasTable.mockRejectedValueOnce(new Error('connection lost'));
  await expect(runBookingFunnelCanary()).rejects.toThrow('connection lost');
  expect(raiseAdminAlert).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
});
