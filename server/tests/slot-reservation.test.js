jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-slot-availability', () => ({
  invalidateEstimate: jest.fn(),
}));

const db = require('../models/db');
const slotReservation = require('../services/slot-reservation');
const reservationHoldMigration = require('../models/migrations/20260516000016_allow_scheduled_service_reservation_holds');

describe('slot reservation helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('releaseReservation scopes deletes by source_estimate_id', async () => {
    const chain = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      modify: jest.fn(function (callback) {
        callback(this);
        return this;
      }),
      del: jest.fn().mockResolvedValue(1),
    };
    db.mockReturnValue(chain);

    await expect(slotReservation.releaseReservation({
      scheduledServiceId: 'scheduled-123',
      estimateId: 'estimate-456',
    })).resolves.toEqual({ released: true });

    expect(db).toHaveBeenCalledWith('scheduled_services');
    expect(chain.where).toHaveBeenCalledWith({ id: 'scheduled-123' });
    expect(chain.where).toHaveBeenCalledWith({ source_estimate_id: 'estimate-456' });
    expect(chain.where).not.toHaveBeenCalledWith({ estimate_id: 'estimate-456' });
    expect(chain.whereNull).toHaveBeenCalledWith('customer_id');
    expect(chain.whereNotNull).toHaveBeenCalledWith('reservation_expires_at');
    expect(chain.del).toHaveBeenCalledTimes(1);
  });
});

describe('scheduled service reservation hold migration', () => {
  test('up allows customer_id to be null while a reservation is uncommitted', async () => {
    const knex = { raw: jest.fn(async () => {}) };

    await reservationHoldMigration.up(knex);

    expect(knex.raw.mock.calls.map(([sql]) => sql).join('\n')).toContain(
      'ALTER COLUMN customer_id DROP NOT NULL'
    );
  });

  test('down clears uncommitted reservation holds before restoring NOT NULL', async () => {
    const chain = {
      whereNull: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      del: jest.fn().mockResolvedValue(1),
    };
    const knex = jest.fn(() => chain);
    knex.raw = jest.fn(async () => {});

    await reservationHoldMigration.down(knex);

    expect(knex).toHaveBeenCalledWith('scheduled_services');
    expect(chain.whereNull).toHaveBeenCalledWith('customer_id');
    expect(chain.whereNotNull).toHaveBeenCalledWith('reservation_expires_at');
    expect(chain.del).toHaveBeenCalledTimes(1);
    expect(knex.raw.mock.calls.map(([sql]) => sql).join('\n')).toContain(
      'ALTER COLUMN customer_id SET NOT NULL'
    );
  });
});
