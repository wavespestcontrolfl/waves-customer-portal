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
  // Mirror the real exported business bounds — slot-reservation destructures
  // these at require time for its server-side slot policy.
  SLOT_DAY_START_MINUTES: 8 * 60,
  SLOT_DAY_END_MINUTES: 17 * 60,
  MAX_SLOT_HORIZON_DAYS: 90,
}));

const db = require('../models/db');
const estimateSlotAvailability = require('../services/estimate-slot-availability');
const slotReservation = require('../services/slot-reservation');
const reservationHoldMigration = require('../models/migrations/20260516000016_allow_scheduled_service_reservation_holds');
const { signSlotOffer, appendOfferToSlotId } = require('../utils/slot-offer-token');

// Mint the exact slotId shape the generator returns — base id + `.exp.sig`
// (signCustomerFacingSlots). durationMinutes must match what reserveSlot
// resolves from the (mocked) service profile, since the HMAC binds it.
// Call under the test's fake timers so exp is anchored to the pinned clock.
function signedSlotId({ estimateId, date, hhmm, techId, durationMinutes = 90 }) {
  const base = `${date}_${hhmm.replace(':', '-')}_${techId || 'unassigned'}`;
  const [h, m] = hhmm.split(':').map(Number);
  const offer = signSlotOffer({
    surface: 'estimate',
    scopeId: String(estimateId),
    date,
    startMinutes: h * 60 + m,
    technicianId: techId || null,
    durationMinutes,
  });
  return appendOfferToSlotId(base, offer);
}

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

  test('one-time pest accepts are not stamped with a recurring cadence prefix', () => {
    // One-time profile carries empty services → visits unknown → would default
    // to "Quarterly Pest Control". serviceMode one_time must collapse to bare
    // "Pest Control" instead.
    expect(slotReservation._internals.canonicalServiceTypeForProfile(
      { serviceMode: 'one_time', services: [] },
      'Pest Control',
    )).toBe('Pest Control');
    // Already-mislabeled fallback ("Quarterly Pest Control") must NOT survive a
    // one-time canonicalization.
    expect(slotReservation._internals.canonicalServiceTypeForProfile(
      { serviceMode: 'one_time', services: [] },
      'Quarterly Pest Control',
    )).toBe('Pest Control');
    // Re-mislabel guard: a null profile at commit must still honor an explicit
    // one-time serviceMode rather than re-deriving the cadence from the
    // (possibly stale) fallback.
    expect(slotReservation._internals.canonicalServiceTypeForProfile(
      null,
      'Quarterly Pest Control',
      { serviceMode: 'one_time' },
    )).toBe('Pest Control');
  });

  // Shared builder factories for the reserveSlot transaction mocks. The txn
  // touches, in order: estimates (lock), technicians (active check),
  // service_zones (zone lock — the mock trx throws for it and the caught
  // error degrades to zone:unknown), then scheduled_services queries in
  // FIFO order via scheduledBuilders.
  function makeEstimateBuilder(row) {
    return {
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(row),
    };
  }
  function makeTechnicianBuilder(row = { id: 'tech-1' }) {
    return {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(row),
    };
  }
  function makeLiveHoldsBuilder(rows = []) {
    return {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      select: jest.fn().mockResolvedValue(rows),
    };
  }
  function makeConflictBuilder(result = null) {
    return {
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
      first: jest.fn().mockResolvedValue(result),
    };
  }
  function makeInsertBuilder(returned) {
    return {
      insert: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([returned]),
    };
  }
  // The GLOBAL tech-blind probe (shared scheduling/occupancy module) both
  // write paths now run under the date lock before committing. Chain shape
  // follows findConflictingVisits; rows resolve at orderBy (the chain tail).
  function makeGlobalProbeBuilder(rows = []) {
    const builder = {};
    Object.assign(builder, {
      where: jest.fn(function where(arg) {
        if (typeof arg === 'function') arg.call(builder, builder);
        return builder;
      }),
      whereNotIn: jest.fn().mockReturnThis(),
      whereRaw: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereNotNull: jest.fn().mockReturnThis(),
      orWhereRaw: jest.fn().mockReturnThis(),
      orWhereNull: jest.fn().mockReturnThis(),
      orWhereNot: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      orderBy: jest.fn(() => Promise.resolve(rows)),
    });
    return builder;
  }
  function makeDeleteBuilder() {
    return {
      whereIn: jest.fn().mockReturnThis(),
      del: jest.fn().mockResolvedValue(1),
    };
  }
  function makeTrx({ estimateBuilder, technicianBuilder, scheduledBuilders }) {
    const trx = jest.fn((table) => {
      if (table === 'estimates') return estimateBuilder;
      if (table === 'technicians') return technicianBuilder;
      if (table === 'scheduled_services') return scheduledBuilders.shift();
      throw new Error(`unexpected table ${table}`);
    });
    trx.raw = jest.fn((sql) => ({ raw: sql }));
    return trx;
  }

  test('reserveSlot writes service-profile duration and checks overlapping windows', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    try {
      const estimateBuilder = makeEstimateBuilder({
        id: 'estimate-456',
        status: 'sent',
        service_interest: 'Generic estimate service',
      });
      const technicianBuilder = makeTechnicianBuilder();
      const liveHoldsBuilder = makeLiveHoldsBuilder([]);
      const conflictBuilder = makeConflictBuilder(null);
      const globalProbeBuilder = makeGlobalProbeBuilder([]);
      const insertBuilder = makeInsertBuilder({
        id: 'scheduled-123',
        reservation_expires_at: '2027-05-20T13:15:00.000Z',
      });
      const scheduledBuilders = [liveHoldsBuilder, conflictBuilder, globalProbeBuilder, insertBuilder];
      const trx = makeTrx({ estimateBuilder, technicianBuilder, scheduledBuilders });
      db.transaction = jest.fn(async (callback) => callback(trx));

      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-05-20', hhmm: '09:00', techId: 'tech-1', durationMinutes: 90 }),
        selectedFrequency: 'quarterly',
      })).resolves.toEqual({
        scheduledServiceId: 'scheduled-123',
        expiresAt: '2027-05-20T13:15:00.000Z',
      });

      expect(technicianBuilder.where).toHaveBeenCalledWith({ id: 'tech-1', active: true });
      // ORDERING CONTRACT (services/scheduling/occupancy.js): rung 1
      // (date-occupancy) → rung 3 (tech) → rung 4 (zone). The hold row this
      // inserts is COUNTED by findConflictingVisits, so the estimate path is
      // a real occupancy writer; the tech + zone locks below it are not
      // enough on their own — the rebooker takes rungs 1+3 and NO zone lock,
      // so a hold for a different tech shared nothing with a concurrent move.
      expect(trx.raw.mock.calls
        .filter((c) => String(c[0]).includes('pg_advisory_xact_lock'))
        .map((c) => c[1])).toEqual([
        ['slot-reserve', 'occupancy:2027-05-20'],
        ['slot-reserve', 'tech-1:2027-05-20'],
        ['slot-reserve', 'zone:unknown:2027-05-20'],
      ]);
      expect(liveHoldsBuilder.where).toHaveBeenCalledWith({ source_estimate_id: 'estimate-456' });
      expect(conflictBuilder.where).toHaveBeenCalledWith({ scheduled_date: '2027-05-20' });
      expect(conflictBuilder.where).toHaveBeenCalledWith('technician_id', 'tech-1');
      expect(conflictBuilder.andWhereRaw).toHaveBeenCalledWith(
        expect.stringContaining('NULLIF(estimated_duration_minutes, 0)'),
        ['10:30:00', 60, '09:00:00'],
      );
      // GLOBAL probe under the date lock, after the narrow tech/zone fast
      // paths, before the hold insert: tech-blind (no technician predicate —
      // the builder's plain-string wheres carry only the date)...
      expect(globalProbeBuilder.where).toHaveBeenCalledWith('scheduled_date', '2027-05-20');
      expect(globalProbeBuilder.where).not.toHaveBeenCalledWith('technician_id', expect.anything());
      expect(globalProbeBuilder.whereRaw).toHaveBeenCalledWith(
        expect.stringContaining('NULLIF(estimated_duration_minutes, 0)'),
        ['10:30:00', 60, '09:00:00'],
      );
      // ...and against COMMITTED visits only (includeHolds:false) — a hold
      // over a committed visit is the offer→409 dead-end; hold-vs-hold stays
      // governed by the narrow checks above.
      expect(globalProbeBuilder.whereNotNull).toHaveBeenCalledWith('customer_id');
      expect(globalProbeBuilder.orWhereNull).toHaveBeenCalledWith('reservation_expires_at');
      // Rung 1 was granted before the probe read.
      const occupancyRawIdx = trx.raw.mock.calls.findIndex(
        (c) => Array.isArray(c[1]) && c[1][1] === 'occupancy:2027-05-20',
      );
      expect(trx.raw.mock.invocationCallOrder[occupancyRawIdx])
        .toBeLessThan(globalProbeBuilder.where.mock.invocationCallOrder[0]);
      expect(insertBuilder.insert).toHaveBeenCalledWith(expect.objectContaining({
        service_type: 'Quarterly Pest Control',
        notes: 'Accepted service mix: 4x Pest Control + 9x Lawn Care.',
        scheduled_date: '2027-05-20',
        window_start: '09:00:00',
        window_end: '10:30:00',
        estimated_duration_minutes: 90,
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserveSlot labels a one-time pest accept "Pest Control" and pins is_recurring=false', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    try {
      // One-time profile: empty services, so the cadence is unknown — the old
      // behavior defaulted the pest label to "Quarterly Pest Control".
      estimateSlotAvailability.resolveEstimateSlotProfile.mockReturnValueOnce({
        serviceMode: 'one_time',
        serviceLabel: 'Pest Control',
        durationMinutes: 60,
        services: [],
      });
      const estimateBuilder = makeEstimateBuilder({
        id: 'estimate-789',
        status: 'sent',
        service_interest: 'Pest Control',
      });
      const technicianBuilder = makeTechnicianBuilder();
      const insertBuilder = makeInsertBuilder({
        id: 'scheduled-789',
        reservation_expires_at: '2027-05-20T13:15:00.000Z',
      });
      const scheduledBuilders = [makeLiveHoldsBuilder([]), makeConflictBuilder(null), makeGlobalProbeBuilder([]), insertBuilder];
      const trx = makeTrx({ estimateBuilder, technicianBuilder, scheduledBuilders });
      db.transaction = jest.fn(async (callback) => callback(trx));

      await slotReservation.reserveSlot({
        estimateId: 'estimate-789',
        slotId: signedSlotId({ estimateId: 'estimate-789', date: '2027-05-20', hhmm: '09:00', techId: 'tech-1', durationMinutes: 60 }),
        serviceMode: 'one_time',
      });

      expect(insertBuilder.insert).toHaveBeenCalledWith(expect.objectContaining({
        service_type: 'Pest Control',
        is_recurring: false,
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  test('commitReservation rebinds the held row to the accepted service profile', async () => {
    // Unlocked pre-read that keys the date-occupancy lock (rung 1) — taken
    // before the FOR UPDATE so a writer already holding the date lock and
    // waiting on this row can't deadlock us.
    const dateProbeBuilder = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ scheduled_date: '2027-05-20' }),
    };
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
    const globalProbeBuilder = makeGlobalProbeBuilder([]);
    const scheduledBuilders = [dateProbeBuilder, reservationBuilder, conflictBuilder, globalProbeBuilder, updateBuilder];
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
    // Rung 1 is the FIRST advisory lock this path takes, keyed by the held
    // row's calendar date — commitReservation takes no tech or zone lock, so
    // it is the only thing serializing the commit against the rebooker and
    // the self-booking confirms (and the commit can WIDEN window_end).
    expect(trx.raw.mock.calls[0]).toEqual([
      'SELECT pg_advisory_xact_lock(hashtext(?), hashtext(?::text))',
      ['slot-reserve', 'occupancy:2027-05-20'],
    ]);
    expect(conflictBuilder.where).toHaveBeenCalledWith({ scheduled_date: '2027-05-20' });
    expect(conflictBuilder.where).toHaveBeenCalledWith('technician_id', 'tech-1');
    expect(conflictBuilder.whereNot).toHaveBeenCalledWith('id', 'scheduled-123');
    expect(conflictBuilder.andWhereRaw).toHaveBeenCalledWith(
      expect.stringContaining('NULLIF(estimated_duration_minutes, 0)'),
      ['10:30:00', 60, '09:00:00'],
    );
    // GLOBAL probe before graduation: tech-blind, over the ACCEPT-time
    // window (the commit can widen window_end), excluding this hold's own
    // row, committed visits only (includeHolds:false).
    expect(globalProbeBuilder.where).toHaveBeenCalledWith('scheduled_date', '2027-05-20');
    expect(globalProbeBuilder.where).not.toHaveBeenCalledWith('technician_id', expect.anything());
    expect(globalProbeBuilder.whereRaw).toHaveBeenCalledWith(
      expect.stringContaining('NULLIF(estimated_duration_minutes, 0)'),
      ['10:30:00', 60, '09:00:00'],
    );
    expect(globalProbeBuilder.whereNotIn).toHaveBeenCalledWith('id', ['scheduled-123']);
    expect(globalProbeBuilder.whereNotNull).toHaveBeenCalledWith('customer_id');
    expect(globalProbeBuilder.orWhereNull).toHaveBeenCalledWith('reservation_expires_at');
    // Rung 1 (the FIRST trx.raw above) was granted before the probe read.
    expect(trx.raw.mock.invocationCallOrder[0])
      .toBeLessThan(globalProbeBuilder.where.mock.invocationCallOrder[0]);
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

  test('reserveSlot rejects a same-day slot inside the 2-hour booking lead', async () => {
    // The guard fires before any db work, so no query mocks are needed.
    jest.useFakeTimers();
    // 15:00Z = 11:00 ET (EDT): a 12:30 ET start is only 90 minutes out.
    jest.setSystemTime(new Date('2027-07-14T15:00:00Z'));
    try {
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-07-14', hhmm: '12:30', techId: 'tech-1' }),
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(db.transaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserveSlot lets a same-day slot outside the booking lead through the guard', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-07-14T15:00:00Z'));
    // Sentinel transaction: reaching the db proves the lead guard passed.
    db.transaction = jest.fn(async () => { throw new Error('REACHED_DB'); });
    try {
      // 13:30 ET start = 150 minutes out — bookable.
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-07-14', hhmm: '13:30', techId: 'tech-1' }),
      })).rejects.toThrow('REACHED_DB');
      expect(db.transaction).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserveSlot accepts a slot exactly at the lead boundary — the generator still offers it', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-07-14T15:00:00Z'));
    db.transaction = jest.fn(async () => { throw new Error('REACHED_DB'); });
    try {
      // 13:00 ET start = exactly 120 minutes out; the generator's
      // startMin >= earliest offers it, so the guard must not 409 it.
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-07-14', hhmm: '13:00', techId: 'tech-1' }),
      })).rejects.toThrow('REACHED_DB');
      expect(db.transaction).toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserveSlot rejects a forged slotId before the working day starts', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    db.transaction = jest.fn();
    try {
      // 03:00 is format-valid but before the 8 AM day start — no generator
      // ever offers it, so it must be rejected before any db work. Signed
      // here so the DAY-START guard (not the signature gate) is what fires —
      // the coarse policy checks stay live as defense-in-depth.
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-05-20', hhmm: '03:00', techId: 'tech-1' }),
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(db.transaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserveSlot rejects a forged slotId beyond the 90-day offer horizon', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    db.transaction = jest.fn(async () => { throw new Error('REACHED_DB'); });
    try {
      // 2027-09-01 is 123 days out — beyond every offer surface's clamp.
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-09-01', hhmm: '09:00', techId: 'tech-1' }),
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(db.transaction).not.toHaveBeenCalled();

      // Exactly 90 days out is the furthest legitimate offer — must pass the
      // pre-txn policy guards (sentinel proves the db was reached).
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-07-30', hhmm: '09:00', techId: 'tech-1' }),
      })).rejects.toThrow('REACHED_DB');
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserveSlot rejects a slotId naming an inactive or unknown technician', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    try {
      const estimateBuilder = makeEstimateBuilder({
        id: 'estimate-456',
        status: 'sent',
        service_interest: 'Pest Control',
      });
      const technicianBuilder = makeTechnicianBuilder(null); // no active match
      const scheduledBuilders = [];
      const trx = makeTrx({ estimateBuilder, technicianBuilder, scheduledBuilders });
      db.transaction = jest.fn(async (callback) => callback(trx));

      // Signed for tech-ghost (a signed offer's tech can be DEACTIVATED
      // between browse and reserve) — proves the active-tech check still
      // fires behind the signature gate.
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-05-20', hhmm: '09:00', techId: 'tech-ghost' }),
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(technicianBuilder.where).toHaveBeenCalledWith({ id: 'tech-ghost', active: true });
      // Rejected before any scheduled_services query or insert.
      expect(scheduledBuilders).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserveSlot rejects a slot whose window runs past the working-day end', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    try {
      // 180-minute profile starting 15:00 ends 18:00 — more than the 59-min
      // round-up grace past the 17:00 close, so no generator offers it.
      estimateSlotAvailability.resolveEstimateSlotProfile.mockReturnValueOnce({
        serviceMode: 'recurring',
        serviceLabel: 'Lawn Care',
        durationMinutes: 180,
        services: [{ service: 'lawn_care', visitsPerYear: 9 }],
      });
      const estimateBuilder = makeEstimateBuilder({
        id: 'estimate-456',
        status: 'sent',
        service_interest: 'Lawn Care',
      });
      const technicianBuilder = makeTechnicianBuilder();
      const scheduledBuilders = [];
      const trx = makeTrx({ estimateBuilder, technicianBuilder, scheduledBuilders });
      db.transaction = jest.fn(async (callback) => callback(trx));

      // Signed over the 180-minute profile duration so the HMAC passes and
      // the DAY-END guard is what rejects (defense-in-depth stays live).
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-05-20', hhmm: '15:00', techId: 'tech-1', durationMinutes: 180 }),
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      // Rejected before the hold/conflict/insert queries ran.
      expect(scheduledBuilders).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserveSlot refreshes this estimate\'s own live hold for the same slot instead of 409ing', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    try {
      const estimateBuilder = makeEstimateBuilder({
        id: 'estimate-456',
        status: 'sent',
        service_interest: 'Generic estimate service',
      });
      const technicianBuilder = makeTechnicianBuilder();
      const liveHoldsBuilder = makeLiveHoldsBuilder([{
        id: 'held-1',
        scheduled_date: '2027-05-20',
        window_start: '09:00:00',
        technician_id: 'tech-1',
        estimated_duration_minutes: 90,
        reservation_expires_at: '2027-05-20T13:05:00.000Z',
      }]);
      const refreshBuilder = {
        where: jest.fn().mockReturnThis(),
        update: jest.fn().mockReturnThis(),
        returning: jest.fn().mockResolvedValue([{
          id: 'held-1',
          reservation_expires_at: '2027-05-20T13:30:00.000Z',
        }]),
      };
      const scheduledBuilders = [liveHoldsBuilder, refreshBuilder];
      const trx = makeTrx({ estimateBuilder, technicianBuilder, scheduledBuilders });
      db.transaction = jest.fn(async (callback) => callback(trx));

      // The client re-POSTs /reserve with the same slotId after "go back" —
      // the estimate's own live hold must be returned (expiry extended), not
      // treated as a conflicting booking.
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-05-20', hhmm: '09:00', techId: 'tech-1', durationMinutes: 90 }),
        selectedFrequency: 'quarterly',
      })).resolves.toEqual({
        scheduledServiceId: 'held-1',
        expiresAt: '2027-05-20T13:30:00.000Z',
      });

      expect(refreshBuilder.where).toHaveBeenCalledWith({ id: 'held-1' });
      expect(refreshBuilder.update).toHaveBeenCalledWith(expect.objectContaining({
        reservation_expires_at: expect.anything(),
      }));
      // No conflict check / insert consumed — the hold was reused.
      expect(scheduledBuilders).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserveSlot supersedes this estimate\'s live hold for a different slot and books the new one', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    try {
      const estimateBuilder = makeEstimateBuilder({
        id: 'estimate-456',
        status: 'sent',
        service_interest: 'Generic estimate service',
      });
      const technicianBuilder = makeTechnicianBuilder();
      const liveHoldsBuilder = makeLiveHoldsBuilder([{
        id: 'held-old',
        scheduled_date: '2027-05-19',
        window_start: '11:00:00',
        technician_id: 'tech-1',
        estimated_duration_minutes: 90,
        reservation_expires_at: '2027-05-19T15:05:00.000Z',
      }]);
      const deleteBuilder = makeDeleteBuilder();
      const conflictBuilder = makeConflictBuilder(null);
      const insertBuilder = makeInsertBuilder({
        id: 'scheduled-new',
        reservation_expires_at: '2027-05-20T13:15:00.000Z',
      });
      const scheduledBuilders = [liveHoldsBuilder, deleteBuilder, conflictBuilder, makeGlobalProbeBuilder([]), insertBuilder];
      const trx = makeTrx({ estimateBuilder, technicianBuilder, scheduledBuilders });
      db.transaction = jest.fn(async (callback) => callback(trx));

      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-05-20', hhmm: '09:00', techId: 'tech-1', durationMinutes: 90 }),
        selectedFrequency: 'quarterly',
      })).resolves.toEqual({
        scheduledServiceId: 'scheduled-new',
        expiresAt: '2027-05-20T13:15:00.000Z',
      });

      // The stale hold was released inside the txn before the conflict check.
      expect(deleteBuilder.whereIn).toHaveBeenCalledWith('id', ['held-old']);
      expect(deleteBuilder.del).toHaveBeenCalledTimes(1);
      expect(insertBuilder.insert).toHaveBeenCalledWith(expect.objectContaining({
        scheduled_date: '2027-05-20',
        window_start: '09:00:00',
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  test('reserveSlot: a COMMITTED visit the tech/zone checks never see blocks the hold (global probe, round-3 P1)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    try {
      const estimateBuilder = makeEstimateBuilder({
        id: 'estimate-456',
        status: 'sent',
        service_interest: 'Generic estimate service',
      });
      const technicianBuilder = makeTechnicianBuilder();
      // Narrow checks pass (no same-tech row, zone unresolved in this
      // harness) — but a committed DIFFERENT-tech visit overlaps. A hold
      // stacked over it would be the offer→409 dead-end at accept time.
      const globalProbeBuilder = makeGlobalProbeBuilder([{
        id: 'svc-other-tech', technician_id: 'tech-2', window_start: '09:30:00',
      }]);
      const scheduledBuilders = [makeLiveHoldsBuilder([]), makeConflictBuilder(null), globalProbeBuilder];
      const trx = makeTrx({ estimateBuilder, technicianBuilder, scheduledBuilders });
      db.transaction = jest.fn(async (callback) => callback(trx));

      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-05-20', hhmm: '09:00', techId: 'tech-1', durationMinutes: 90 }),
        selectedFrequency: 'quarterly',
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });

      // No hold row was inserted — every queued builder was consumed and
      // none beyond the probe was requested.
      expect(scheduledBuilders).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('commitReservation probes even when no accept-time duration resolves (the narrow check is skipped then)', async () => {
    // Null profile → windowEnd null → the tech-scoped conflict check does
    // not run at all — but graduation still commits real occupancy, so the
    // global probe must still gate it, over the HELD window.
    estimateSlotAvailability.resolveEstimateSlotProfile.mockReturnValueOnce(null);
    const dateProbeBuilder = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ scheduled_date: '2027-05-20' }),
    };
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
        reservation_expires_at: '2027-05-20T13:15:00.000Z',
      }),
    };
    const globalProbeBuilder = makeGlobalProbeBuilder([]);
    const updateBuilder = {
      where: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'scheduled-123', customer_id: 'customer-1' }]),
    };
    const scheduledBuilders = [dateProbeBuilder, reservationBuilder, globalProbeBuilder, updateBuilder];
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services') return scheduledBuilders.shift();
      throw new Error(`unexpected table ${table}`);
    });
    trx.raw = jest.fn((sql) => ({ raw: sql }));

    await expect(slotReservation.commitReservation({
      scheduledServiceId: 'scheduled-123',
      customerId: 'customer-1',
      estimate: { id: 'estimate-456', service_interest: 'Pest Control' },
      trx,
    })).resolves.toEqual({ id: 'scheduled-123', customer_id: 'customer-1' });

    // Probe ran over the held window (row.window_end fallback), tech-blind,
    // excluding the graduating row itself.
    expect(globalProbeBuilder.whereRaw).toHaveBeenCalledWith(
      expect.stringContaining('NULLIF(estimated_duration_minutes, 0)'),
      ['10:00:00', 60, '09:00:00'],
    );
    expect(globalProbeBuilder.whereNotIn).toHaveBeenCalledWith('id', ['scheduled-123']);
    expect(globalProbeBuilder.whereNotNull).toHaveBeenCalledWith('customer_id');
  });

  test('commitReservation refuses to graduate over a COMMITTED overlapping visit (tech-blind, round-3 P1)', async () => {
    const dateProbeBuilder = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ scheduled_date: '2027-05-20' }),
    };
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
    // The rebooker parked an unassigned visit over this window while the
    // customer sat on the accept screen: the tech-scoped narrow check
    // (technician_id = tech-1) never sees the technician-NULL row.
    const globalProbeBuilder = makeGlobalProbeBuilder([{
      id: 'svc-unassigned', technician_id: null, window_start: '09:00:00',
    }]);
    const updateBuilder = {
      where: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      returning: jest.fn().mockResolvedValue([{ id: 'scheduled-123' }]),
    };
    const scheduledBuilders = [dateProbeBuilder, reservationBuilder, conflictBuilder, globalProbeBuilder, updateBuilder];
    const trx = jest.fn((table) => {
      if (table === 'scheduled_services') return scheduledBuilders.shift();
      throw new Error(`unexpected table ${table}`);
    });
    trx.raw = jest.fn((sql) => ({ raw: sql }));

    await expect(slotReservation.commitReservation({
      scheduledServiceId: 'scheduled-123',
      customerId: 'customer-1',
      estimate: { id: 'estimate-456', service_interest: 'Pest Control + Lawn Care' },
      serviceMode: 'recurring',
      selectedFrequency: 'quarterly',
      trx,
    })).rejects.toMatchObject({
      code: 'SLOT_UNAVAILABLE',
      slotId: '2027-05-20_09-00_tech-1',
    });
    // The graduation was refused — the row was never updated.
    expect(updateBuilder.update).not.toHaveBeenCalled();
  });
});

describe('reserveSlot signed-offer gate (booking-audit round 2)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Local mini-harness (the shared builder factories live inside the first
  // describe's scope): estimate row loads fine, and any scheduled_services /
  // technicians touch is observable — the gate must fire before both.
  function makeVerifyHarness() {
    const estimateBuilder = {
      where: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        id: 'estimate-456',
        status: 'sent',
        service_interest: 'Pest Control',
      }),
    };
    const technicianBuilder = {
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ id: 'tech-1' }),
    };
    const scheduledBuilders = [];
    const trx = jest.fn((table) => {
      if (table === 'estimates') return estimateBuilder;
      if (table === 'technicians') return technicianBuilder;
      if (table === 'scheduled_services') return scheduledBuilders.shift();
      throw new Error(`unexpected table ${table}`);
    });
    trx.raw = jest.fn((sql) => ({ raw: sql }));
    db.transaction = jest.fn(async (callback) => callback(trx));
    return { technicianBuilder, scheduledBuilders };
  }

  test('an UNSIGNED slotId — including a crafted _unassigned one — is rejected before any db work', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    db.transaction = jest.fn();
    try {
      for (const bare of ['2027-05-20_09-00_tech-1', '2027-05-20_09-00_unassigned']) {
        await expect(slotReservation.reserveSlot({
          estimateId: 'estimate-456',
          slotId: bare,
        })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      }
      expect(db.transaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('an EXPIRED offer is rejected before any db work (409 → client refreshes slots)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    db.transaction = jest.fn();
    try {
      const stale = signedSlotId({ estimateId: 'estimate-456', date: '2027-05-20', hhmm: '09:00', techId: 'tech-1' });
      jest.setSystemTime(new Date('2027-05-01T15:46:00Z')); // 46 min later > 45-min TTL
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: stale,
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(db.transaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('a TAMPERED signature fails the in-txn HMAC before any scheduling query', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    try {
      const { technicianBuilder, scheduledBuilders } = makeVerifyHarness();
      const good = signedSlotId({ estimateId: 'estimate-456', date: '2027-05-20', hhmm: '09:00', techId: 'tech-1', durationMinutes: 90 });
      const tampered = good.slice(0, -1) + (good.slice(-1) === 'A' ? 'B' : 'A');
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: tampered,
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(scheduledBuilders).toHaveLength(0);
      expect(technicianBuilder.where).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('an offer signed for ANOTHER estimate is rejected (scope binding)', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    try {
      const { scheduledBuilders } = makeVerifyHarness();
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-OTHER', date: '2027-05-20', hhmm: '09:00', techId: 'tech-1', durationMinutes: 90 }),
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(scheduledBuilders).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('a RETIMED signed offer (same estimate, shifted start) fails the HMAC', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    try {
      const { scheduledBuilders } = makeVerifyHarness();
      // Take a legitimate 09:00 offer's exp+sig and splice them onto 10:00.
      const good = signedSlotId({ estimateId: 'estimate-456', date: '2027-05-20', hhmm: '09:00', techId: 'tech-1', durationMinutes: 90 });
      const [, exp, sig] = good.match(/^(?:.+?)\.(\d+)\.(.+)$/).slice(0);
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: `2027-05-20_10-00_tech-1.${exp}.${sig}`,
      })).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(scheduledBuilders).toHaveLength(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test('an impossible calendar date (2027-09-31) is INVALID_SLOT_ID even when signed', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2027-05-01T15:00:00Z'));
    db.transaction = jest.fn();
    try {
      await expect(slotReservation.reserveSlot({
        estimateId: 'estimate-456',
        slotId: signedSlotId({ estimateId: 'estimate-456', date: '2027-09-31', hhmm: '09:00', techId: 'tech-1' }),
      })).rejects.toMatchObject({ code: 'INVALID_SLOT_ID' });
      expect(db.transaction).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('parseSlotId still reads SIGNED ids (accept-time reservation lookup) and rejects fake dates', () => {
    const { parseSlotId } = slotReservation._internals;
    const signed = signedSlotId({ estimateId: 'e', date: '2027-05-20', hhmm: '09:00', techId: 'tech-1' });
    expect(parseSlotId(signed)).toMatchObject({
      date: '2027-05-20',
      windowStart: '09:00:00',
      techId: 'tech-1',
      offerExp: expect.any(Number),
      offerSig: expect.any(String),
    });
    // Unsigned base ids still PARSE (enforcement is reserveSlot's job).
    expect(parseSlotId('2027-05-20_09-00_unassigned')).toMatchObject({
      date: '2027-05-20', techId: null, offerExp: null, offerSig: null,
    });
    expect(parseSlotId('2027-09-31_09-00_tech-1')).toBeNull();
    expect(parseSlotId('2027-02-29_09-00_tech-1')).toBeNull(); // 2027 is not a leap year
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
