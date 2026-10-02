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

// Owner 2026-10-01: six "Series move needs route review" bells in 72h, every one
// with no conflicts and no preserved visits, only accepted overlap dates.
describe('series move overlap-only findings', () => {
  const markerWrites = [];
  beforeEach(() => {
    jest.clearAllMocks();
    markerWrites.length = 0;
    db.fn = { now: () => new Date() };
    db.mockImplementation((table) => {
      if (table !== 'series_moves') throw new Error(`Unexpected table ${table}`);
      return {
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({ status: 'committed', conflict_card_at: null, reminders_synced_at: new Date(), notified_at: new Date() }),
        update: jest.fn(async (values) => { markerWrites.push(values); return 1; }),
      };
    });
    notifyAdmin.mockResolvedValue({ id: 'card' });
  });
  const move = (extra) => applySeriesMoveEffects({
    result: { seriesMoveId: 'move-1', notifyRequested: false, rescheduledOccurrences: [], ...extra },
    serviceId: 'visit-1', newDate: '2099-01-01', newWindow: { start: '09:00', end: '10:00' },
  });

  test.each([
    ['promised arrival windows at stake', { overlapDates: ['2099-02-05', '2099-02-12'], arrivalWindowDates: ['2099-02-05'] }],
    ['plain overlap', { overlapDates: ['2099-02-05'] }],
  ])('an accepted overlap with no conflict and no preserved visit rings no bell (%s)', async (_name, extra) => {
    await move({ ...extra, preservedOccurrences: [] });
    expect(notifyAdmin).not.toHaveBeenCalled();
    expect(markerWrites.some((row) => Object.hasOwn(row, 'conflict_card_at'))).toBe(false);
  });

  test('a real conflict still rings, and the card lists the overlap beside it', async () => {
    await move({
      rescheduledOccurrences: [{ id: 'visit-3', date: '2099-02-03', conflicted: true }],
      overlapDates: ['2099-02-05'], arrivalWindowDates: ['2099-02-05'],
    });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, title, body, opts] = notifyAdmin.mock.calls[0];
    expect(category).toBe('schedule_conflict');
    expect(title).toBe('Series move left visits without a time window');
    expect(body).toContain('NO time window');
    expect(body).toContain('need route review');
    expect(opts.metadata).toMatchObject({ conflicts: [{ id: 'visit-3', date: '2099-02-03' }], overlapDates: ['2099-02-05'] });
    expect(markerWrites.some((row) => Object.hasOwn(row, 'conflict_card_at'))).toBe(true);
  });
});

describe('superseded series move card', () => {
  // The successor owns the preserved and overlap work; the old operation's
  // card is about the conflicts still windowless, and stores only those — the
  // items admin-alert-relevance.js settles the card by.
  test('a card-only pass stores only the conflicts it rings for', async () => {
    jest.clearAllMocks();
    db.fn = { now: () => new Date() };
    db.mockImplementation((table) => {
      if (table === 'series_moves') {
        return {
          where: jest.fn().mockReturnThis(),
          whereNull: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue({ status: 'superseded', conflict_card_at: null, reminders_synced_at: new Date(), notified_at: new Date() }),
          update: jest.fn(async () => 1),
        };
      }
      if (table === 'scheduled_services') {
        const q = { whereIn: jest.fn(() => q), whereNull: jest.fn(() => q), whereNotIn: jest.fn(() => q), select: jest.fn(async () => [{ id: 'visit-3' }]) };
        return q;
      }
      throw new Error(`Unexpected table ${table}`);
    });
    notifyAdmin.mockResolvedValue({ id: 'card' });
    await applySeriesMoveEffects({
      result: {
        seriesMoveId: 'move-2', notifyRequested: false,
        rescheduledOccurrences: [{ id: 'visit-3', date: '2099-02-03', conflicted: true }],
        preservedOccurrences: [{ id: 'visit-2', date: '2099-02-01' }],
        overlapDates: ['2099-02-05'],
      },
      serviceId: 'visit-1', newDate: '2099-01-01', newWindow: { start: '09:00', end: '10:00' },
    });
    expect(notifyAdmin).toHaveBeenCalledWith('schedule_conflict', expect.any(String), expect.any(String), expect.objectContaining({
      metadata: { scheduledServiceId: 'visit-1', seriesMoveId: 'move-2', conflicts: [{ id: 'visit-3', date: '2099-02-03' }], overlapDates: [], preservedOccurrences: [] },
    }));
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
