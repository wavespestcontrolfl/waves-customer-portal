jest.mock('../models/db', () => jest.fn());
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
        expect.objectContaining({ bell: true }),
      );
      expect(markerWrites.some((row) => Object.hasOwn(row, 'conflict_card_at'))).toBe(!!notification?.id);
    },
  );
});
