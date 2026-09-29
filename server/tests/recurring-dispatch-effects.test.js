jest.mock('../models/db', () => jest.fn());
// visitPrefsRow: the series notice reads the anchor visit's prefs row through
// the saved property (app property scope, PR 3); a plain row = the profile.
jest.mock('../services/appointment-reminders', () => ({ safeSendAppointment: jest.fn(), visitPrefsRow: jest.fn(async () => ({})) }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn() }));

const db = require('../models/db');
const { notifyAdmin } = require('../services/notification-service');
const { applySeriesMoveEffects } = require('../routes/admin-dispatch');

describe('preserved recurring visit staff alert', () => {
  const markerWrites = [];
  beforeEach(() => {
    jest.clearAllMocks();
    markerWrites.length = 0;
    db.fn = { now: () => new Date() };
    db.mockImplementation((table) => {
      if (table !== 'series_moves') throw new Error(`Unexpected table ${table}`);
      const query = {
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          status: 'committed', conflict_card_at: null,
          reminders_synced_at: new Date(), notified_at: new Date(),
        }),
        update: jest.fn(async (values) => { markerWrites.push(values); return 1; }),
      };
      return query;
    });
  });

  test.each([null, { id: null, suppressed: true }, { id: 'staff-alert' }])(
    'requires a saved alert before concluding the retry marker: %j', async (notification) => {
      notifyAdmin.mockResolvedValue(notification);
      await applySeriesMoveEffects({
        result: {
          seriesMoveId: 'move-1', notifyRequested: false,
          rescheduledOccurrences: [],
          preservedOccurrences: [{ id: 'visit-2', date: '2099-02-01' }],
        },
        serviceId: 'visit-1', newDate: '2099-01-01', newWindow: { start: '09:00', end: '10:00' },
      });
      expect(notifyAdmin).toHaveBeenCalledWith(
        'schedule_conflict', expect.any(String), expect.stringContaining('kept existing appointments'),
        expect.objectContaining({ bell: true, link: '/admin/dispatch?tab=schedule&date=2099-02-01' }),
      );
      expect(markerWrites.some((row) => Object.hasOwn(row, 'conflict_card_at'))).toBe(!!notification?.id);
    },
  );
});

// Admin alerts check the live record (owner ruling 2026-09-28): a date the move
// only flagged for arrival-window route review (rebooker.js arrivalWindowDates —
// no other appointment sits on it) is a heads-up, not work, so with nothing
// preserved, untimed or truly overlapping it is written into the bell already
// read: visible in the list, never counted or rung.
describe('series move card rings only when there is something to act on', () => {
  let tableUpdates;
  beforeEach(() => {
    jest.clearAllMocks();
    tableUpdates = [];
    db.fn = { now: () => new Date() };
    db.mockImplementation((table) => ({
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        status: 'committed', conflict_card_at: null, reminders_synced_at: new Date(), notified_at: new Date(),
      }),
      update: jest.fn(async (patch) => { tableUpdates.push({ table, patch }); return 1; }),
    }));
    notifyAdmin.mockResolvedValue({ id: 'staff-alert' });
  });
  const readOnInsert = () => tableUpdates.some((u) => u.table === 'notifications' && u.patch.read_at instanceof Date);

  const move = (result) => applySeriesMoveEffects({
    result: { seriesMoveId: 'move-1', notifyRequested: false, rescheduledOccurrences: [], ...result },
    serviceId: 'visit-1', newDate: '2099-01-01', newWindow: { start: '09:00', end: '10:00' },
  });
  const cardOpts = () => notifyAdmin.mock.calls[0][3];

  test('a pure route-review move (only arrival-window dates, nothing preserved or untimed) is written into the bell already read', async () => {
    await move({ overlapDates: ['2099-02-01', '2099-03-01'], arrivalWindowDates: ['2099-02-01', '2099-03-01'] });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(notifyAdmin.mock.calls[0][1]).toBe('Series move needs route review');
    // In the bell list (no Activity-only feed, which shows ops digests only), never unread.
    expect(cardOpts().metadata).toMatchObject({ seriesMoveId: 'move-1' });
    expect(cardOpts().metadata.feed).toBeUndefined();
    expect(readOnInsert()).toBe(true);
  });

  test.each([
    ['a real overlap with another appointment', { overlapDates: ['2099-02-01'], arrivalWindowDates: [] }],
    ['a real overlap beside a route-review date', { overlapDates: ['2099-02-01', '2099-03-01'], arrivalWindowDates: ['2099-02-01'] }],
    ['a preserved future visit beside a route-review date', {
      overlapDates: ['2099-02-01'], arrivalWindowDates: ['2099-02-01'], preservedOccurrences: [{ id: 'visit-2', date: '2099-04-01' }],
    }],
    ['a visit left without a time window', {
      overlapDates: ['2099-02-01'], arrivalWindowDates: ['2099-02-01'],
      rescheduledOccurrences: [{ id: 'visit-3', date: '2099-05-01', conflicted: true }],
    }],
  ])('still rings for %s', async (_label, result) => {
    await move(result);
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    expect(cardOpts().metadata.quiet).toBeUndefined();
    expect(cardOpts().metadata.feed).toBeUndefined();
    expect(cardOpts()).toMatchObject({ bell: true });
    expect(readOnInsert()).toBe(false);
  });
});

describe('recurring confirmation describes the recorded placement policy', () => {
  test.each([
    [3, 'appointment_recurring_placement_confirmed'],
    [null, 'appointment_series_rescheduled'],
  ])('placement policy %s selects %s', async (futurePlacementDays, templateKey) => {
    const templates = require('../routes/admin-sms-templates');
    const reminders = require('../services/appointment-reminders');
    const render = jest.spyOn(templates, 'getTemplate').mockResolvedValue('Synthetic confirmation');
    reminders.safeSendAppointment.mockImplementation(async (_customer, _prefs, message) => {
      await message({ name: 'Test' });
      return false; // Exercise rendering without sending any communication.
    });
    db.mockImplementation((table) => ({
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        scheduled_services: { customer_id: 'customer-1', scheduled_date: '2099-01-01', window_start: '09:00' },
        customers: { id: 'customer-1', first_name: 'Test' },
        notification_prefs: {},
      }[table]),
    }));
    await applySeriesMoveEffects({
      result: { seriesMoveId: null, notifyRequested: true, rescheduledOccurrences: [], futurePlacementDays },
      serviceId: 'visit-1', newDate: '2099-01-01', newWindow: { start: '09:00', end: '10:00' },
    });
    expect(render).toHaveBeenCalledWith(templateKey, expect.objectContaining({ first_name: 'Test' }), expect.any(Object));
    render.mockRestore();
  });
});
