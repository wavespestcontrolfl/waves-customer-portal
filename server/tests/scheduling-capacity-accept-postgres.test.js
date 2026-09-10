/** Real reservation acceptance and revalidation in a synthetic private schema. */
const { createCapacityDbFixture, describeDb } = require('./helpers/scheduling-capacity-db');
const { reserveSlot, commitReservation, prepareReservationCommit } = require('../services/slot-reservation');
jest.setTimeout(30000);

describeDb('scheduling capacity acceptance on PostgreSQL', () => {
  const f = createCapacityDbFixture('scheduling_capacity_accept');

  test.each([
    ['pest_control', 30, null, '10:30'],
    ['lawn_care', 40, null, '10:40'],
    ['pest_control', 90, 90, '11:30'],
  ])('commit retains %s work of %i minutes', async (service, duration, explicitDuration, expectedEnd) => {
    const data = f.estimateData([service]);
    if (explicitDuration) data.result.recurring.services[0].estimatedDurationMinutes = explicitDuration;
    await f.db('estimates').where({ id: f.ids.estimates[0] }).update({ estimate_data: data });
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0], duration) });
    const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer });
    expect(booked).toMatchObject({ estimated_duration_minutes: duration, window_start: '10:00:00',
      window_end: `${expectedEnd}:00`, reservation_expires_at: null });
    expect((await f.db('scheduled_services').where({ id: booked.id }).first()).route_order).toBe(1);
  });

  test.each([20, 90])('changed single-service allowance of %i minutes rejects prepare and live commit', async duration => {
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    await f.db('services').where({ service_key: 'pest_general_quarterly' }).update({
      scheduling_duration_policy: { version: 1, default_duration_minutes: duration,
        min_duration_minutes: duration, max_duration_minutes: duration },
    });
    try {
      await expect(prepareReservationCommit(held.scheduledServiceId))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
      await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer, preparedCapacity }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
      expect(await f.db('scheduled_services').where({ id: held.scheduledServiceId }).first())
        .toMatchObject({ customer_id: null, estimated_duration_minutes: 30 });
    } finally {
      await f.db('services').where({ service_key: 'pest_general_quarterly' }).update({
        scheduling_duration_policy: { version: 1, default_duration_minutes: 30,
          min_duration_minutes: 30, max_duration_minutes: 40 },
      });
    }
  });

  test('reselecting a legacy single hold upgrades its policy and rejects catalog growth after shutdown', async () => {
    const catalog = await f.db('services').where({ service_key: 'pest_general_quarterly' }).first();
    try {
      await f.db('services').where({ id: catalog.id }).update({
        scheduling_duration_policy: { version: 1, default_duration_minutes: 60, min_duration_minutes: 60, max_duration_minutes: 60 },
      });
      delete process.env.GATE_SCHEDULING_CAPACITY;
      const args = { estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0], 60) };
      const legacy = await reserveSlot(args);
      expect((await f.db('scheduled_services').where({ id: legacy.scheduledServiceId }).first()).reservation_policy_version)
        .not.toBe(2);
      process.env.GATE_SCHEDULING_CAPACITY = 'true';
      const current = await reserveSlot(args);
      expect((await f.db('scheduled_services').where({ id: current.scheduledServiceId }).first()).reservation_policy_version)
        .toBe(2);
      delete process.env.GATE_SCHEDULING_CAPACITY;
      await f.db('services').where({ id: catalog.id }).update({
        scheduling_duration_policy: { version: 1, default_duration_minutes: 90, min_duration_minutes: 90, max_duration_minutes: 90 },
      });
      await expect(commitReservation({ scheduledServiceId: current.scheduledServiceId, customerId: f.ids.customer }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
      expect(await f.db('scheduled_services').where({ id: current.scheduledServiceId }).first())
        .toMatchObject({ customer_id: null, estimated_duration_minutes: 60 });
    } finally {
      await f.db('services').where({ id: catalog.id }).update({ scheduling_duration_policy: catalog.scheduling_duration_policy });
    }
  });

  test('a changed route invalidates a prepared commit and leaves the hold intact', async () => {
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    await f.db('scheduled_services').insert(f.baseStop({ window_start: '10:00', window_end: '12:00' }));
    await expect(f.db.transaction(trx => commitReservation({ scheduledServiceId: held.scheduledServiceId,
      customerId: f.ids.customer, preparedCapacity, trx })))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_changed' });
    expect((await f.db('scheduled_services').where({ id: held.scheduledServiceId }).first()).customer_id).toBeNull();
  });

  test('a combined hold preserves each resolved allowance when the release gate is disabled', async () => {
    await f.db('estimates').where({ id: f.ids.estimates[0] }).update({ estimate_data: f.estimateData(['pest_control', 'lawn_care']) });
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0], 70) });
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer });
    expect(booked.estimated_duration_minutes).toBe(70);
    expect(booked.reservation_service_mix).toMatchObject({ version: 2, durations: [30, 40], durationMinutes: 70 });
  });

  test('legacy combined holds retain hourly members beside a new catalog-sized hold', async () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'true';
    await f.db('estimates').where({ id: f.ids.estimates[0] }).update({ estimate_data: f.estimateData(['pest_control', 'lawn_care']) });
    const legacy = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0], 120, '09:00') });
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    const current = await reserveSlot({ estimateId: f.ids.estimates[1], slotId: f.signedSlot(f.ids.estimates[1], 30, '13:00') });
    const { scheduling_duration_policy: priorPolicy } = await f.db('services')
      .where({ service_key: 'pest_general_quarterly' }).first('scheduling_duration_policy');
    await f.db('services').where({ service_key: 'pest_general_quarterly' }).update({
      scheduling_duration_policy: { version: 1, default_duration_minutes: 90, min_duration_minutes: 90, max_duration_minutes: 90 },
    });
    try {
      const booked = await commitReservation({ scheduledServiceId: legacy.scheduledServiceId, customerId: f.ids.customer });
      expect(booked).toMatchObject({ estimated_duration_minutes: 120,
        reservation_service_mix: { version: 1, durationMinutes: 120 }, window_end: '11:00:00' });
      expect((await f.db('scheduled_services').where({ id: current.scheduledServiceId }).first()).estimated_duration_minutes).toBe(30);
    } finally {
      await f.db('services').where({ service_key: 'pest_general_quarterly' }).update({ scheduling_duration_policy: priorPolicy });
    }
  });

  test('acceptance refuses a changed single-service selection with a different allowance', async () => {
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) });
    await f.db('estimates').where({ id: f.ids.estimates[0] }).update({ estimate_data: f.estimateData(['lawn_care']) });
    await f.db('technician_capabilities').insert({ technician_id: f.ids.technician, service_category: 'lawn', active: false });
    await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer }))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
    expect((await f.db('scheduled_services').where({ id: held.scheduledServiceId }).first()).customer_id).toBeNull();
  });

  test('equal-total allocation changes require a fresh combined hold', async () => {
    await f.db('estimates').where({ id: f.ids.estimates[0] })
      .update({ estimate_data: f.estimateData(['pest_control', 'lawn_care']) });
    const slotId = f.signedSlot(f.ids.estimates[0], 70);
    const oldHold = await reserveSlot({ estimateId: f.ids.estimates[0], slotId });
    await f.db('services').where({ service_key: 'pest_general_quarterly' }).update({
      scheduling_duration_policy: { version: 1, default_duration_minutes: 40,
        min_duration_minutes: 30, max_duration_minutes: 40 },
    });
    await f.db('services').where({ service_key: 'lawn_care_recurring' }).update({
      scheduling_duration_policy: { version: 1, default_duration_minutes: 30,
        min_duration_minutes: 30, max_duration_minutes: 40 },
    });
    try {
      await expect(commitReservation({ scheduledServiceId: oldHold.scheduledServiceId, customerId: f.ids.customer }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
      expect(await f.db('scheduled_services').where({ id: oldHold.scheduledServiceId }).first())
        .toMatchObject({ customer_id: null, reservation_service_mix: { durations: [30, 40] } });
      const freshHold = await reserveSlot({ estimateId: f.ids.estimates[0], slotId });
      expect(freshHold.scheduledServiceId).not.toBe(oldHold.scheduledServiceId);
      expect(await f.db('scheduled_services').where({ id: oldHold.scheduledServiceId }).first()).toBeUndefined();
      const booked = await commitReservation({ scheduledServiceId: freshHold.scheduledServiceId, customerId: f.ids.customer });
      expect(booked.reservation_service_mix).toMatchObject({ version: 2, durations: [40, 30], durationMinutes: 70 });
    } finally {
      await f.db('services').where({ service_key: 'pest_general_quarterly' }).update({
        scheduling_duration_policy: { version: 1, default_duration_minutes: 30,
          min_duration_minutes: 30, max_duration_minutes: 40 },
      });
      await f.db('services').where({ service_key: 'lawn_care_recurring' }).update({ scheduling_duration_policy: null });
    }
  });

  test('a multi-program estimate with combined capacity off holds only the primary allowance', async () => {
    process.env.GATE_VISIT_COMBINED_CAPACITY = 'false';
    await f.db('estimates').where({ id: f.ids.estimates[0] }).update({ estimate_data: f.estimateData(['lawn_care', 'pest_control']) });
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0], 30) });
    const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer });
    expect(booked.estimated_duration_minutes).toBe(30);
    expect(booked.reservation_service_mix).toBeNull();
    expect(booked.service_type).toContain('Pest');
  });

  test('commit waits for the tech-day fence before row locks and rejects a reorder that wins first', async () => {
    const { lockTechDays } = require('../services/scheduling/tech-day-lock');
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    const reorder = await f.db.transaction();
    let outcome;
    try {
      await lockTechDays(reorder, [{ techId: f.ids.technician, date: f.date }]);
      outcome = commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer, preparedCapacity })
        .then(value => ({ value }), error => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 50 && !waiting; attempt += 1) {
        const result = await f.admin.raw(`SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype = 'advisory'
          AND NOT granted AND classid = hashtext('slot-reserve')::oid AND objid = hashtext(?::text)::oid) AS waiting`,
        [`${f.ids.technician}:${f.date}`]);
        waiting = result.rows[0].waiting;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      await reorder('scheduled_services').where({ id: held.scheduledServiceId }).forUpdate().noWait().first();
      await reorder('scheduled_services').where({ id: held.scheduledServiceId }).update({ route_order: 9 });
      await reorder.commit();
      expect((await outcome).error).toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_changed' });
      expect((await f.db('scheduled_services').where({ id: held.scheduledServiceId }).first()).customer_id).toBeNull();
    } finally {
      if (!reorder.isCompleted()) await reorder.rollback();
      if (outcome) await outcome;
    }
  });

  test('dispatch-first unassignment fences standalone acceptance before its hold row lock', async () => {
    const { lockTechDays } = require('../services/scheduling/tech-day-lock');
    const stop = f.baseStop({ technician_id: f.ids.otherTech, window_start: '08:00',
      window_end: '16:00', estimated_duration_minutes: 480, route_order: 1 });
    await f.db('scheduled_services').insert(stop);
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    const dispatch = await f.db.transaction();
    let outcome;
    try {
      const { rows: [{ pid }] } = await dispatch.raw('SELECT pg_backend_pid()::int AS pid');
      await lockTechDays(dispatch, [{ techId: f.ids.otherTech, date: f.date }, { techId: null, date: f.date }]);
      expect(await dispatch('scheduled_services').where({ id: stop.id })
        .whereRaw('technician_id IS NOT DISTINCT FROM ?', [f.ids.otherTech])
        .whereRaw("to_char(scheduled_date, 'YYYY-MM-DD') = ?", [f.date])
        .update({ technician_id: null, route_order: null, updated_at: dispatch.fn.now() })).toBe(1);
      outcome = commitReservation({ scheduledServiceId: held.scheduledServiceId,
        customerId: f.ids.customer, preparedCapacity }).then(value => ({ value }), error => ({ error }));
      let waiting = false;
      for (let attempt = 0; attempt < 100 && !waiting; attempt += 1) {
        const result = await f.admin.raw(
          'SELECT 1 FROM pg_stat_activity WHERE application_name = ? AND ?::int = ANY(pg_blocking_pids(pid))',
          [f.schema, pid],
        );
        waiting = result.rows.length > 0;
        if (!waiting) await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(waiting).toBe(true);
      const rowProbe = await f.db.transaction();
      try {
        await expect(rowProbe('scheduled_services').where({ id: held.scheduledServiceId }).forUpdate().noWait().first())
          .resolves.toMatchObject({ id: held.scheduledServiceId });
        await rowProbe.commit();
      } finally { if (!rowProbe.isCompleted()) await rowProbe.rollback(); }
      await dispatch.commit();
      expect((await outcome).error).toMatchObject({ code: 'SLOT_UNAVAILABLE' });
      expect(await f.db('scheduled_services').where({ id: held.scheduledServiceId }).first())
        .toMatchObject({ customer_id: null, reservation_expires_at: expect.anything() });
    } finally {
      if (!dispatch.isCompleted()) await dispatch.rollback();
      if (outcome) await outcome;
    }
  });

  test('a hold moved to another technician cannot reuse the old route certification', async () => {
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    await f.db('scheduled_services').where({ id: held.scheduledServiceId })
      .update({ technician_id: f.ids.otherTech, route_order: null });
    await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer, preparedCapacity }))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_changed' });
    expect((await f.db('scheduled_services').where({ id: held.scheduledServiceId }).first()).customer_id).toBeNull();
  });

  test.each([false, true])('gate-off changed selection rejects a v2 hold (combined=%s)', async combined => {
    if (combined) await f.db('estimates').where({ id: f.ids.estimates[0] })
      .update({ estimate_data: f.estimateData(['pest_control', 'lawn_care']) });
    const held = await reserveSlot({ estimateId: f.ids.estimates[0],
      slotId: f.signedSlot(f.ids.estimates[0], combined ? 70 : 30) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const changed = f.estimateData(combined ? ['pest_control', 'lawn_care'] : ['lawn_care']);
    if (combined) changed.result.recurring.services[0].estimatedDurationMinutes = 90;
    await f.db('estimates').where({ id: f.ids.estimates[0] }).update({ estimate_data: changed });
    await expect(prepareReservationCommit(held.scheduledServiceId))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
    await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer, preparedCapacity }))
      .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'service_duration_changed' });
  });

  test('another technician changing their route does not invalidate acceptance', async () => {
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    await f.db('scheduled_services').insert(f.baseStop({ technician_id: f.ids.otherTech }));
    const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId,
      customerId: f.ids.customer, preparedCapacity });
    expect(booked.customer_id).toBe(f.ids.customer);
  });

  test('a completion holding a route row makes acceptance retry without waiting', async () => {
    const stop = f.baseStop({ route_order: 1 });
    await f.db('scheduled_services').insert(stop);
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) });
    const preparedCapacity = await prepareReservationCommit(held.scheduledServiceId);
    const completion = await f.db.transaction();
    try {
      await completion('scheduled_services').where({ id: stop.id }).forUpdate().first();
      await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer, preparedCapacity }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_busy' });
      await completion('scheduled_services').where({ id: stop.id }).update({ status: 'completed' });
      await completion.commit();
      await expect(commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer, preparedCapacity }))
        .rejects.toMatchObject({ code: 'SLOT_UNAVAILABLE', reason: 'route_changed' });
    } finally { if (!completion.isCompleted()) await completion.rollback(); }
  });

  test('verified route rows remain locked through order persistence', async () => {
    const { verifyArrivalCapacity, persistArrivalOrder } = require('../services/scheduling/arrival-route');
    const stop = f.baseStop({ route_order: 1 });
    await f.db('scheduled_services').insert(stop);
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) });
    const prepared = await prepareReservationCommit(held.scheduledServiceId);
    await f.db.transaction(async trx => {
      const fit = await verifyArrivalCapacity(prepared, { conn: trx });
      await expect(f.db.transaction(other => other('scheduled_services').where({ id: stop.id }).forUpdate().noWait().first()))
        .rejects.toMatchObject({ code: '55P03' });
      await persistArrivalOrder(trx, fit, held.scheduledServiceId);
    });
  });

  test('an unchanged single-service hold keeps its catalog allowance after gate shutdown', async () => {
    const held = await reserveSlot({ estimateId: f.ids.estimates[0], slotId: f.signedSlot(f.ids.estimates[0]) });
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const booked = await commitReservation({ scheduledServiceId: held.scheduledServiceId, customerId: f.ids.customer });
    expect(booked).toMatchObject({ estimated_duration_minutes: 30, customer_id: f.ids.customer,
      reservation_expires_at: null });
  });
});
