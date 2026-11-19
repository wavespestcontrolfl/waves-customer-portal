/** Real offer/hold queries and lock ordering in a synthetic private schema. */
const { randomUUID } = require('node:crypto');
const { createCapacityDbFixture, describeDb } = require('./helpers/scheduling-capacity-db');
const { reserveSlot } = require('../services/slot-reservation');
const { findAvailableSlots } = require('../services/scheduling/find-time');
const { lockTechDays } = require('../services/scheduling/tech-day-lock');
const { lockClosureState } = require('../services/scheduling/blackout-dates');
jest.setTimeout(30000);

describeDb('scheduling capacity holds on PostgreSQL', () => {
  const f = createCapacityDbFixture('scheduling_capacity_holds');

  async function waitForBlockedBy(blockerPid, message) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const result = await f.admin.raw(
        'SELECT 1 FROM pg_stat_activity WHERE application_name = ? AND ?::int = ANY(pg_blocking_pids(pid))',
        [f.schema, blockerPid],
      );
      if (result.rows.length) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(message);
  }

  async function dispatchToUnassigned(trx, stopId) {
    await lockTechDays(trx, [
      { techId: f.ids.otherTech, date: f.date },
      { techId: null, date: f.date },
    ]);
    return trx('scheduled_services')
      .where({ id: stopId })
      .whereNotIn('status', ['completed', 'cancelled', 'skipped', 'no_show'])
      .whereRaw('technician_id IS NOT DISTINCT FROM ?', [f.ids.otherTech])
      .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [f.date])
      .update({ technician_id: null, route_order: null, updated_at: trx.fn.now() })
      .returning('*');
  }

  test.each([
    ['pest_control', 30, null, '10:30'],
    ['lawn_care', 40, null, '10:40'],
    ['pest_control', 90, 90, '11:30'],
  ])('offer and hold retry retain %s work of %i minutes', async (service, duration, explicitDuration, expectedEnd) => {
    const data = f.estimateData([service]);
    if (explicitDuration) data.result.recurring.services[0].estimatedDurationMinutes = explicitDuration;
    await f.db('estimates').where({ id: f.ids.estimates[0] }).update({ estimate_data: data });
    const offers = await findAvailableSlots({ ...f.PIN, dateFrom: f.date, dateTo: f.date,
      technicianId: f.ids.technician, serviceType: service, durationMinutes: duration, includeWeekends: true, topN: 99 });
    expect(offers.slots.some(slot => slot.start_time === '10:00' && slot.end_time === expectedEnd)).toBe(true);
    // Customer-facing day close moved from 17:00 to 18:00 (picker-windows PR 2,
    // owner ruling 2026-09-23) — this fixture calls findAvailableSlots the same
    // way the estimate offer surface does, so a 17:00 start (this job's short
    // duration ends well within 18:00) is now a legitimately offered slot, not
    // a bug. Only a start at/after the NEW close is disallowed.
    expect(offers.slots.some(slot => slot.start_time >= '18:00')).toBe(false);
    const args = { estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0], duration) };
    const hold = await reserveSlot(args);
    expect((await reserveSlot(args)).scheduledServiceId).toBe(hold.scheduledServiceId);
    expect(await f.db('scheduled_services').where({ id: hold.scheduledServiceId }).first()).toMatchObject({
      estimated_duration_minutes: duration, window_start: '10:00:00', window_end: `${expectedEnd}:00`, customer_id: null,
    });
  });

  test('a technician disabled after the offer returns a recoverable reservation conflict', async () => {
    await f.db('technicians').where({ id: f.ids.technician }).update({ field_dispatchable: false });
    try {
      await expect(reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', status: 409, reason: 'technician_unavailable' });
      expect(await f.db('scheduled_services')).toHaveLength(0);
    } finally {
      await f.db('technicians').where({ id: f.ids.technician }).update({ field_dispatchable: true });
    }
  });

  describe.each([
    ['fixed-hour', 'false'],
    ['arrival-window', 'true'],
  ])('%s reservation writes at 10 a.m.', (_, capacityGate) => {
    test.each([true, false])('expiry releases the last opening only when staff left it unclaimed (claimed: %s)', async claimed => {
      process.env.GATE_SCHEDULING_CAPACITY = capacityGate;
      const [firstEstimate, secondEstimate] = f.ids.estimates;
      const estimate = await f.db('estimates').where({ id: firstEstimate }).first();
      const { durationMinutes } = await require('../services/estimate-slot-availability')
        .resolveCatalogSlotProfile(estimate, {}, f.db);
      await f.db('tech_schedule_blocks').insert({
        id: randomUUID(), date: f.date, technician_id: f.ids.technician,
        block_type: 'blocked', start_time: '11:00', end_time: '18:00',
      });
      const first = await reserveSlot({
        estimateId: firstEstimate,
        slotId: f.signedSlot(firstEstimate, durationMinutes),
      });
      const bookedCustomer = randomUUID();
      if (claimed) {
        await f.db('customers').insert({
          id: bookedCustomer, first_name: 'Office', last_name: 'Booking', phone: '+19415550112',
        });
        await f.db('scheduled_services').where({ id: first.scheduledServiceId })
          .update({ customer_id: bookedCustomer, status: 'confirmed' });
      }
      await f.db('scheduled_services').where({ id: first.scheduledServiceId })
        .update({ reservation_expires_at: f.db.raw("NOW() - INTERVAL '1 minute'") });

      const second = reserveSlot({
        estimateId: secondEstimate,
        slotId: f.signedSlot(secondEstimate, durationMinutes),
      });
      if (claimed) {
        await expect(second).rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
        expect(await f.db('scheduled_services').where({ source_estimate_id: secondEstimate })).toHaveLength(0);
        expect(await f.db('scheduled_services').where({ id: first.scheduledServiceId })
          .first('customer_id', 'window_start')).toEqual({
          customer_id: bookedCustomer,
          window_start: '10:00:00',
        });
      } else {
        await expect(second).resolves.toHaveProperty('scheduledServiceId');
      }
    });
  });

  test.each([
    ['another estimate after expiry', 0, -1],
    ['the requesting estimate before expiry', 1, 1],
  ])('a staff booking from %s invalidates a prepared capacity proof without adding road requests', async (_, estimateIndex, minutesToExpiry) => {
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const { prepareArrivalCapacity, verifyArrivalCapacity } = require('../services/scheduling/arrival-route');
    await f.db('scheduled_services').insert(f.baseStop({
      window_start: '08:00', window_end: '08:30', route_order: 1,
    }));
    const travel = require('../services/route-optimizer').createSchedulingTravel({ maxRequests: 0 });
    const preload = jest.fn(async () => {});
    const options = {
      conn: f.db,
      now: new Date(),
      date: f.date,
      technicianId: f.ids.technician,
      excludeEstimateId: f.ids.estimates[1],
      prospective: {
        lat: Number(f.PIN.lat) + 0.01,
        lng: f.PIN.lng,
        service_type: 'Pest Control',
        estimated_duration_minutes: 30,
      },
      windowStart: '10:00',
      windowEnd: '10:30',
      durationMinutes: 30,
      travel: { ...travel, preload },
    };
    const before = await prepareArrivalCapacity(options);
    const roadRequests = preload.mock.calls.slice();
    expect(roadRequests.some(([legs]) => legs.length)).toBe(true);
    preload.mockClear();

    await f.db('scheduled_services').insert(f.baseStop({
      technician_id: null,
      window_start: '10:00',
      window_end: '11:00',
      estimated_duration_minutes: 60,
      source_estimate_id: f.ids.estimates[estimateIndex],
      reservation_expires_at: f.db.raw('NOW() + make_interval(mins => ?)', [minutesToExpiry]),
    }));
    const after = await prepareArrivalCapacity(options);
    expect(preload.mock.calls).toEqual(roadRequests);
    expect(after.fingerprint).not.toBe(before.fingerprint);
    await expect(f.db.transaction(conn => verifyArrivalCapacity(before, { conn })))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_changed' });
    await expect(f.db.transaction(conn => verifyArrivalCapacity(after, { conn })))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE' });
  });

  // The placed visit plans the owner table now (owner 2026-10-30: this fixture's uncadenced
  // 'pest_control' reads one-time pest, 45), so the last gap is the 60 minutes before the block;
  // the row it holds is still its 30-minute allowance.
  test('concurrent customers cannot both consume the final gap', async () => {
    await f.db('scheduled_services').insert(f.baseStop({ window_start: '08:00', window_end: '16:00',
      estimated_duration_minutes: 480, route_order: 1 }));
    await f.db('tech_schedule_blocks').insert({ id: require('node:crypto').randomUUID(), date: f.date,
      technician_id: f.ids.technician, block_type: 'blocked', start_time: '17:00', end_time: '18:00' });
    const outcomes = await Promise.allSettled(f.ids.estimates.map(estimateId => reserveSlot({
      estimateId, slotId: f.signedSlot(estimateId, 30, '16:00'),
    })));
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect(await f.db('scheduled_services').whereNotNull('reservation_expires_at')).toHaveLength(1);
  });

  test('invalid signed offers never prepare route traffic', async () => {
    const optimizer = require('../services/route-optimizer');
    const travel = jest.spyOn(optimizer, 'createSchedulingTravel');
    try {
      const good = f.signedSlot(f.ids.estimates[0]);
      const bad = good.slice(0, -1) + (good.endsWith('a') ? 'b' : 'a');
      await expect(reserveSlot({ estimateId: f.ids.estimates[0], slotId: bad }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'invalid_offer' });
      expect(travel).not.toHaveBeenCalled();
    } finally { travel.mockRestore(); }
  });

  test('reserve holds selected and unassigned day fences through its outer commit', async () => {
    const stop = f.baseStop({ technician_id: f.ids.otherTech, window_start: '13:00', window_end: '13:30', route_order: 1 });
    await f.db('scheduled_services').insert(stop);
    let releaseReserve;
    const release = new Promise(resolve => { releaseReserve = resolve; });
    let bodyReady;
    const ready = new Promise(resolve => { bodyReady = resolve; });
    let reserve;
    let dispatch;
    f.beforeNextOuterCommit(async trx => {
      const { rows: [{ pid }] } = await trx.raw('SELECT pg_backend_pid()::int AS pid');
      bodyReady({ trx, pid });
      await release;
    });
    try {
      reserve = reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) })
        .then(value => ({ value }), error => ({ error }));
      const { pid } = await Promise.race([ready, reserve.then((outcome) => {
        if (outcome.error) throw outcome.error;
        throw new Error('Reservation committed without reaching the outer-transaction pause');
      })]);
      for (const key of [`${f.ids.technician}:${f.date}`, `unassigned:${f.date}`]) {
        const result = await f.admin.raw(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ?::int
          AND locktype = 'advisory' AND granted AND classid = hashtext('slot-reserve')::oid
          AND objid = hashtext(?::text)::oid) AS held`, [pid, key]);
        expect(result.rows[0].held).toBe(true);
      }
      dispatch = f.db.transaction(trx => dispatchToUnassigned(trx, stop.id))
        .then(value => ({ value }), error => ({ error }));
      await waitForBlockedBy(pid, 'Dispatch unassignment never waited for the reservation fence');
      releaseReserve();
      expect((await reserve).value).toMatchObject({ scheduledServiceId: expect.anything() });
      expect((await dispatch).value).toHaveLength(1);
      expect((await f.db('scheduled_services').where({ id: stop.id }).first()).technician_id).toBeNull();
    } finally {
      releaseReserve();
      await Promise.allSettled([reserve, dispatch].filter(Boolean));
    }
  });

  test('dispatch-first unassignment fences reserve before row locks and invalidates its stale slot', async () => {
    const stop = f.baseStop({ technician_id: f.ids.otherTech, window_start: '10:00', window_end: '10:30', route_order: 1 });
    await f.db('scheduled_services').insert(stop);
    const dispatch = await f.db.transaction();
    let reserve;
    try {
      const { rows: [{ pid }] } = await dispatch.raw('SELECT pg_backend_pid()::int AS pid');
      expect(await dispatchToUnassigned(dispatch, stop.id)).toHaveLength(1);
      reserve = reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) })
        .then(value => ({ value }), error => ({ error }));
      await waitForBlockedBy(pid, 'Reservation never waited for the unassigned day fence');

      const rowProbe = await f.db.transaction();
      try {
        await expect(rowProbe('estimates').where({ id: f.ids.estimates[0] }).forUpdate().noWait().first())
          .resolves.toMatchObject({ id: f.ids.estimates[0] });
        await rowProbe.commit();
      } finally { if (!rowProbe.isCompleted()) await rowProbe.rollback(); }

      await dispatch.commit();
      expect((await reserve).error).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(await f.db('scheduled_services').whereNotNull('reservation_expires_at')).toHaveLength(0);
    } finally {
      if (!dispatch.isCompleted()) await dispatch.rollback();
      if (reserve) await reserve;
    }
  });

  test('an uncommitted exclusive closure-state lock blocks reservation, then the newly closed day is rejected', async () => {
    const blocker = await f.db.transaction();
    let reserve;
    try {
      const { rows: [{ pid }] } = await blocker.raw('SELECT pg_backend_pid()::int AS pid');
      await lockClosureState(blocker, { exclusive: true });
      await blocker('schedule_blackout_dates').insert({ date: f.date, reason: 'test' });
      reserve = reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) })
        .then(value => ({ value }), error => ({ error }));
      await waitForBlockedBy(pid, 'Reservation never waited for the closure-state lock held by the blackout write');
      await blocker.commit();
      expect((await reserve).error).toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'day_unavailable' });
      expect(await f.db('scheduled_services')).toHaveLength(0);
    } finally {
      if (!blocker.isCompleted()) await blocker.rollback();
      if (reserve) await reserve;
    }
  });

  test('reserve holds the closure-state lock shared through its outer commit, blocking an exclusive blackout write', async () => {
    let releaseReserve;
    const release = new Promise(resolve => { releaseReserve = resolve; });
    let bodyReady;
    const ready = new Promise(resolve => { bodyReady = resolve; });
    let reserve;
    let writer;
    f.beforeNextOuterCommit(async trx => {
      const { rows: [{ pid }] } = await trx.raw('SELECT pg_backend_pid()::int AS pid');
      bodyReady({ trx, pid });
      await release;
    });
    try {
      reserve = reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) })
        .then(value => ({ value }), error => ({ error }));
      const { pid } = await Promise.race([ready, reserve.then((outcome) => {
        if (outcome.error) throw outcome.error;
        throw new Error('Reservation committed without reaching the outer-transaction pause');
      })]);
      const held = await f.admin.raw(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE pid = ?::int
        AND locktype = 'advisory' AND granted AND classid = hashtext('slot-reserve')::oid
        AND objid = hashtext('closure-state')::oid) AS held`, [pid]);
      expect(held.rows[0].held).toBe(true);
      writer = f.db.transaction(async trx => {
        await lockClosureState(trx, { exclusive: true });
        return 'locked';
      }).then(value => ({ value }), error => ({ error }));
      await waitForBlockedBy(pid, 'Exclusive closure-state write never waited for the reservation shared lock');
      releaseReserve();
      expect((await reserve).value).toMatchObject({ scheduledServiceId: expect.anything() });
      expect((await writer).value).toBe('locked');
    } finally {
      releaseReserve();
      await Promise.allSettled([reserve, writer].filter(Boolean));
    }
  });
});
