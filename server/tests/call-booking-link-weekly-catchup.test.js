/**
 * call-booking-link-weekly-check missed-tick catch-up. The Monday 8:13 ET tick can be
 * lost. weekIsMissing() tells the Monday/Tuesday catch-up whether this week's report
 * has been stamped; a catch-up run reports the SAME week as the Monday tick would have.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({ isConfigured: jest.fn(() => true), sendOne: jest.fn(async () => ({ ok: true })) }));

const mockFirst = jest.fn();
jest.mock('../models/db', () => {
  const chain = { where: jest.fn(() => chain), first: (...args) => mockFirst(...args) };
  return jest.fn(() => chain);
});

const {
  runCallBookingLinkWeeklyCheck,
  weekIsMissing,
  _private: { reportWindow, dedupeKeyFor },
} = require('../services/call-booking-link-weekly-check');

const MONDAY_TICK = new Date('2026-10-05T12:13:00.000Z'); // Monday 8:13 AM EDT
const MONDAY_CATCH_UP = new Date('2026-10-05T14:44:00.000Z');
const TUESDAY_CATCH_UP = new Date('2026-10-06T14:44:00.000Z');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('weekIsMissing', () => {
  test('gate off: never missing, and the marker is not read', async () => {
    await expect(weekIsMissing(TUESDAY_CATCH_UP, { gateEnabled: false })).resolves.toBe(false);
    expect(mockFirst).not.toHaveBeenCalled();
  });

  test('no marker yet: this week is missing', async () => {
    mockFirst.mockResolvedValue(undefined);
    await expect(weekIsMissing(TUESDAY_CATCH_UP, { gateEnabled: true })).resolves.toBe(true);
  });

  test("last week's marker does not count for this week", async () => {
    mockFirst.mockResolvedValue({ last_sent_at: new Date('2026-09-28T12:14:00.000Z') });
    await expect(weekIsMissing(TUESDAY_CATCH_UP, { gateEnabled: true })).resolves.toBe(true);
  });

  test('a marker stamped by the Monday tick: not missing, Monday or Tuesday', async () => {
    mockFirst.mockResolvedValue({ last_sent_at: new Date('2026-10-05T12:13:20.000Z') });
    await expect(weekIsMissing(MONDAY_CATCH_UP, { gateEnabled: true })).resolves.toBe(false);
    await expect(weekIsMissing(TUESDAY_CATCH_UP, { gateEnabled: true })).resolves.toBe(false);
  });

  test('a marker stamped by a catch-up (after Monday 8:13) also counts', async () => {
    mockFirst.mockResolvedValue({ last_sent_at: new Date('2026-10-06T14:44:30.000Z') });
    await expect(weekIsMissing(TUESDAY_CATCH_UP, { gateEnabled: true })).resolves.toBe(false);
  });

  test('an unreadable marker answers "not missing": the catch-up skips instead of sending without the guard', async () => {
    mockFirst.mockRejectedValue(new Error('connection reset'));
    await expect(weekIsMissing(TUESDAY_CATCH_UP, { gateEnabled: true })).resolves.toBe(false);
  });
});

describe('a catch-up run covers the same week as the Monday tick', () => {
  const deps = () => ({
    gateEnabled: true,
    sentRecently: jest.fn(async () => false),
    loadWeek: jest.fn(async () => ({ rows: [{ status: 'sent', reason: null }], job: { last_success_at: new Date(), consecutive_failures: 0 } })),
    deliver: jest.fn(async () => ({ ok: true, channel: 'bell' })),
    stampSendMarker: jest.fn(async () => {}),
  });

  test('same window, same dedupeKey, same week key from Monday 8:13 through Tuesday night', async () => {
    const monday = reportWindow(MONDAY_TICK);
    for (const at of [MONDAY_CATCH_UP, TUESDAY_CATCH_UP, new Date('2026-10-07T03:00:00.000Z')]) {
      expect(reportWindow(at)).toEqual(monday);
      expect(dedupeKeyFor(at)).toBe(dedupeKeyFor(MONDAY_TICK));
    }
  });

  test('the Tuesday catch-up delivers one report for the Monday week and stamps the marker', async () => {
    const opts = deps();
    const out = await runCallBookingLinkWeeklyCheck({ ...opts, now: TUESDAY_CATCH_UP });
    expect(out.sent).toBe(true);
    expect(opts.loadWeek).toHaveBeenCalledWith(TUESDAY_CATCH_UP);
    expect(opts.deliver).toHaveBeenCalledTimes(1);
    expect(opts.deliver.mock.calls[0][0]).toMatchObject({ key: 'call-booking-link-weekly', dedupeKey: dedupeKeyFor(MONDAY_TICK), itemKeys: ['2026-10-05'] });
    expect(opts.stampSendMarker).toHaveBeenCalledTimes(1);
  });

  test('a catch-up after the Monday tick reported does nothing', async () => {
    const opts = deps();
    opts.sentRecently = jest.fn(async () => true);
    const out = await runCallBookingLinkWeeklyCheck({ ...opts, now: TUESDAY_CATCH_UP });
    expect(out).toEqual({ skipped: 'recent_send' });
    expect(opts.loadWeek).not.toHaveBeenCalled();
    expect(opts.deliver).not.toHaveBeenCalled();
  });
});
