jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-slot-availability', () => ({
  invalidateEstimate: jest.fn(),
  resolveEstimateSlotProfile: jest.fn(() => ({
    durationMinutes: 90,
    serviceLabel: '4x Pest Control + 9x Lawn Care',
    services: [
      { service: 'pest_control', visitsPerYear: 4 },
      { service: 'lawn_care', visitsPerYear: 9 },
    ],
  })),
}));

const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const slotReservation = require('../services/slot-reservation');
const reservationHoldMigration = require('../models/migrations/20260516000016_allow_scheduled_service_reservation_holds');

describe('slot reservation helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('canonicalizes rodent trapping reservations to the trapping service type', () => {
    expect(slotReservation._internals.canonicalServiceTypeForProfile(
      { serviceMode: 'one_time', services: [] },
      'Rodent Trapping',
    )).toBe('Rodent Trapping Service');
  });

  test('one-time pest reservations keep the non-recurring service label', () => {
    expect(slotReservation._internals.canonicalServiceTypeForProfile(
      { serviceMode: 'one_time', services: [] },
      'Pest Control',
    )).toBe('Pest Control');
  });

  test('reserveSlot writes service-profile duration and checks overlapping windows', async () => {
    const estimateBuilder = {
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        id: 'estimate-456',
        status: 'sent',
        service_interest: 'Generic estimate service',
      }),
    };
    const conflictBuilder = {
      where: jest.fn().mockReturnThis(),
      modify: jest.fn(function (callback) {
        callback(this);
        return this;
      }),
      whereNotIn: jest.fn().mockReturnThis(),
      andWhereRaw: jest.fn().mockReturnThis(),
      andWhere: jest.fn(function (callback) {
        callback(this);
        return this;
      }),
      whereNull: jest.fn().mockReturnThis(),
      orWhereRaw: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    const insertBuilder = {
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{
        id: 'scheduled-123',
        reservation_expires_at: '2027-05-20T13:15:00.000Z',
      }]),
    };
    const scheduledBuilders = [conflictBuilder, insertBuilder];
    const trx = jest.fn((table) => {
      if (table === 'estimates') return estimateBuilder;
      if (table === 'scheduled_services') return scheduledBuilders.shift();
      throw new Error(`unexpected table ${table}`);
    });
    trx.raw = jest.fn((sql) => ({ raw: sql }));
    db.transaction = jest.fn(async (callback) => callback(trx));

    await expect(slotReservation.reserveSlot({
      estimateId: 'estimate-456',
      slotId: '2027-05-20_09-00_tech-1',
      selectedFrequency: 'quarterly',
    })).resolves.toEqual({
      scheduledServiceId: 'scheduled-123',
      expiresAt: '2027-05-20T13:15:00.000Z',
    });

    expect(conflictBuilder.where).toHaveBeenCalledWith({ scheduled_date: '2027-05-20' });
    expect(conflictBuilder.where).toHaveBeenCalledWith('technician_id', 'tech-1');
    expect(conflictBuilder.andWhereRaw).toHaveBeenCalledWith(
      expect.stringContaining('NULLIF(estimated_duration_minutes, 0)'),
      ['10:30:00', 60, '09:00:00'],
    );
    expect(insertBuilder.insert).toHaveBeenCalledWith(expect.objectContaining({
      service_type: 'Quarterly Pest Control',
      notes: 'Accepted service mix: 4x Pest Control + 9x Lawn Care.',
      scheduled_date: '2027-05-20',
      window_start: '09:00:00',
      window_end: '10:30:00',
      estimated_duration_minutes: 90,
    }));
  });

  test('commitReservation rebinds the held row to the accepted service profile', async () => {
    const reservationBuilder = {
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        id: 'scheduled-123',
        source_estimate_id: 'estimate-456',
        scheduled_date: '2027-05-20',
        window_start: '09:00:00',
        window_end: '10:00:00',
        technician_id: 'tech-1',
        notes: 'Gate code in customer profile.',
        reservation_expires_at: '2027-05-20T13:15:00.000Z',
      }),
    };
    const conflictBuilder = {
      where: jest.fn().mockReturnThis(),
      modify: jest.fn(function (callback) {
        callback(this);
        return this;
      }),
      whereNot: jest.fn().mockReturnThis(),
      whereNotIn: jest.fn().mockReturnThis(),
      andWhereRaw: jest.fn().mockReturnThis(),
      andWhere: jest.fn(function (callback) {
        callback(this);
        return this;
      }),
      whereNull: jest.fn().mockReturnThis(),
      orWhereRaw: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    const updateBuilder = {
      where: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'scheduled-123', customer_id: 'customer-1' }]),
    };
    const scheduledBuilders = [reservationBuilder, conflictBuilder, updateBuilder];
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services') return scheduledBuilders.shift();
      throw new Error(`unexpected table ${table}`);
    });
    trx.raw = jest.fn((sql) => ({ raw: sql }));

    await expect(slotReservation.commitReservation({
      scheduledServiceId: 'scheduled-123',
      customerId: 'customer-1',
      paymentMethodPreference: 'card_on_file',
      estimatedPrice: 219.6,
      estimate: { id: 'estimate-456', service_interest: 'Pest Control + Lawn Care' },
      serviceMode: 'recurring',
      selectedFrequency: 'quarterly',
      trx,
    })).resolves.toEqual({ id: 'scheduled-123', customer_id: 'customer-1' });

    expect(estimateSlotAvailability.resolveEstimateSlotProfile).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'estimate-456' }),
      expect.objectContaining({ serviceMode: 'recurring', selectedFrequency: 'quarterly' }),
    );
    expect(conflictBuilder.where).toHaveBeenCalledWith({ scheduled_date: '2027-05-20' });
    expect(conflictBuilder.where).toHaveBeenCalledWith('technician_id', 'tech-1');
    expect(conflictBuilder.whereNot).toHaveBeenCalledWith('id', 'scheduled-123');
    expect(conflictBuilder.andWhereRaw).toHaveBeenCalledWith(
      expect.stringContaining('NULLIF(estimated_duration_minutes, 0)'),
      ['10:30:00', 60, '09:00:00'],
    );
    expect(updateBuilder.update).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'customer-1',
      payment_method_preference: 'card_on_file',
      estimated_price: 219.6,
      window_end: '10:30:00',
      estimated_duration_minutes: 90,
      service_type: 'Quarterly Pest Control',
      notes: 'Gate code in customer profile.\nAccepted service mix: 4x Pest Control + 9x Lawn Care.',
      reservation_expires_at: null,
    }));
  });

  test('canonical service type keeps protocol/default lookups stable', () => {
    expect(slotReservation._internals.canonicalServiceTypeForProfile({
      services: [{ service: 'pest_control', visitsPerYear: 12 }],
    }, 'Pest Control')).toBe('Monthly Pest Control');
    expect(slotReservation._internals.canonicalServiceTypeForProfile({
      services: [{ service: 'pest_control', visitsPerYear: 6 }],
    }, 'Pest Control')).toBe('Bi-Monthly Pest Control');
    expect(slotReservation._internals.canonicalServiceTypeForProfile({
      services: [{ service: 'lawn_care', visitsPerYear: 9 }],
    }, 'Lawn Care')).toBe('Lawn Care');
    expect(slotReservation._internals.canonicalServiceTypeForProfile(
      null,
      'Pest Control + Lawn Care',
    )).toBe('Quarterly Pest Control');
  });

  test('service profile labels are capped to scheduled_services service_type length', () => {
    const longLabel = '4x Pest Control + 9x Lawn Care + 12x Mosquito + 4x Tree & Shrub + 4x Termite Bait + 2x Palm Injection';
    const capped = slotReservation._internals.cappedServiceType(longLabel);

    expect(capped).toHaveLength(100);
    expect(capped.endsWith('...')).toBe(true);
  });

  test('service mix notes preserve bundled accepted services separately from service_type', () => {
    const profile = {
      serviceLabel: '4x Pest Control + 9x Lawn Care',
      services: [
        { service: 'pest_control', visitsPerYear: 4 },
        { service: 'lawn_care', visitsPerYear: 9 },
      ],
    };

    expect(slotReservation._internals.notesWithServiceMix(null, profile, '')).toBe(
      'Accepted service mix: 4x Pest Control + 9x Lawn Care.',
    );
    expect(slotReservation._internals.notesWithServiceMix('Existing note', profile, '')).toBe(
      'Existing note\nAccepted service mix: 4x Pest Control + 9x Lawn Care.',
    );
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
