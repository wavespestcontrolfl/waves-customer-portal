/**
 * Picker Audit Phase 2B-1 — GATE_VISIT_HOLD edge-case gaps:
 *  1. Public reschedule (reschedule-public.js): held visits bypass move-notice refusal
 *     and never short-circuit as idempotent replay when picking their old slot.
 *  2. South-zone day funnel (zone-day-funnel.js): held visits never invent cluster days.
 *  3. Re-service fold (reservice-fold.js): findFoldTarget and holdReplay exclude held visits.
 *  4. Portal reschedule-request (routes/schedule.js): excludes held visits and fences held_at IS NULL.
 *  5. Gap candidates (gap-candidates.js): loadGapCandidate rejects held visits.
 *  6. Day replan apply (day-replan/apply.js): recheckVisit rejects held rows and writeMoves fences held_at IS NULL.
 *  7. Arrival route (arrival-route.js): placeMovedVisit refuses held rows and persistCapacityAllocation excludes them.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

describe('GATE_VISIT_HOLD gaps (Phase 2B-1)', () => {
  const prevGate = process.env.GATE_VISIT_HOLD;

  afterEach(() => {
    if (prevGate === undefined) delete process.env.GATE_VISIT_HOLD;
    else process.env.GATE_VISIT_HOLD = prevGate;
    jest.restoreAllMocks();
  });

  test('reschedule-public withSelfServeNotice skips move notice for a held visit only while gate is live', () => {
    const notice = require('../services/scheduling/self-serve-notice');
    const noticeSpy = jest.spyOn(notice, 'visitInsideMoveNoticeWindow').mockReturnValue(true);
    const { withSelfServeNotice } = require('../routes/reschedule-public')._test;
    const heldSvc = { id: 'svc-1', scheduled_date: '2099-05-10', window_start: '09:00', held_at: new Date().toISOString() };

    process.env.GATE_VISIT_HOLD = 'true';
    expect(withSelfServeNotice({ ok: true, missed: false }, heldSvc)).toEqual({ ok: true, missed: false });
    expect(withSelfServeNotice({ ok: true, missed: false }, { ...heldSvc, held_at: null }))
      .toEqual({ ok: false, reason: 'self_serve_notice' });

    process.env.GATE_VISIT_HOLD = 'false';
    expect(withSelfServeNotice({ ok: true, missed: false }, heldSvc))
      .toEqual({ ok: false, reason: 'self_serve_notice' });
    noticeSpy.mockRestore();
  });

  test('reschedule-public visitChangedSince flags a hold-state flip while gate is live', async () => {
    const { visitChangedSince } = require('../routes/reschedule-public')._test;
    const base = {
      id: 'svc-1', scheduled_date: '2099-05-10', window_start: '09:00', status: 'confirmed', held_at: null,
    };
    const fakeDb = jest.fn(() => ({
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({ ...base, held_at: new Date().toISOString() }),
    }));
    fakeDb.raw = (sql) => sql;

    process.env.GATE_VISIT_HOLD = 'true';
    await expect(visitChangedSince(base, fakeDb)).resolves.toBe(true);

    process.env.GATE_VISIT_HOLD = 'false';
    await expect(visitChangedSince(base, fakeDb)).resolves.toBe(false);
  });

  test('zone-day-funnel zoneStopDays excludes held visits when gate is live and keeps gate-off SQL unchanged', async () => {
    const { _internals } = require('../services/scheduling/zone-day-funnel');
    const makeDb = () => {
      const chain = {
        leftJoin: jest.fn().mockReturnThis(),
        whereBetween: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
      };
      return { dbc: jest.fn(() => chain), chain };
    };

    process.env.GATE_VISIT_HOLD = 'true';
    const on = makeDb();
    await _internals.zoneStopDays(on.dbc, { id: 'z1', zone_name: 'Venice', cities: ['Venice'] }, '2027-05-01', '2027-05-14');
    expect(on.chain.whereNull).toHaveBeenCalledWith('scheduled_services.held_at');

    process.env.GATE_VISIT_HOLD = 'false';
    const off = makeDb();
    await _internals.zoneStopDays(off.dbc, { id: 'z1', zone_name: 'Venice', cities: ['Venice'] }, '2027-05-01', '2027-05-14');
    expect(off.chain.whereNull).not.toHaveBeenCalledWith('scheduled_services.held_at');
  });

  test('reservice-fold findFoldTarget and holdReplay exclude held visits when gate is live', async () => {
    const { findFoldTarget, holdReplay } = require('../services/reservice-fold');
    const makeFoldDb = () => {
      const ssChain = {
        leftJoin: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        whereRaw: jest.fn().mockReturnThis(),
        modify: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        orderByRaw: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        forUpdate: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([]),
        first: jest.fn().mockResolvedValue(null),
      };
      const conn = jest.fn((table) => {
        if (table === 'customer_properties') return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
        return ssChain;
      });
      conn.transaction = jest.fn(async (fn) => fn(conn));
      return { conn, ssChain };
    };

    process.env.GATE_VISIT_HOLD = 'true';
    const on = makeFoldDb();
    await findFoldTarget(on.conn, { customerId: 'cust-1', lane: 'pest', date: '2027-05-10' });
    expect(on.ssChain.whereNull).toHaveBeenCalledWith('s.held_at');

    const replayTarget = {
      id: 'plan-1', customer_id: 'cust-1', property_id: null, service_id: 'svc-1',
      service_type: 'Pest Control', is_callback: false, scheduled_date: '2027-05-10',
      status: 'confirmed', window_start: '09:00',
    };
    const replayOn = makeFoldDb();
    const replayed = await holdReplay({ conn: replayOn.conn, target: replayTarget, date: '2027-05-10' });
    expect(replayed).toBe(false);
    expect(replayOn.ssChain.whereNull).toHaveBeenCalledWith('scheduled_services.held_at');

    process.env.GATE_VISIT_HOLD = 'false';
    const off = makeFoldDb();
    await findFoldTarget(off.conn, { customerId: 'cust-1', lane: 'pest', date: '2027-05-10' });
    expect(off.ssChain.whereNull).not.toHaveBeenCalledWith('s.held_at');
  });

  test('gap-candidates loadGapCandidate rejects a held visit with candidate_on_hold when gate is live', async () => {
    const { loadGapCandidate } = require('../services/scheduling/gap-candidates');
    const conn = jest.fn(() => ({
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue({
        id: 'svc-held', status: 'confirmed', reservation_expires_at: null,
        customer_active: true, customer_deleted_at: null,
        held_at: new Date().toISOString(),
      }),
    }));
    conn.raw = (sql) => sql;

    process.env.GATE_VISIT_HOLD = 'true';
    await expect(loadGapCandidate('svc-held', conn)).resolves.toEqual({ unavailable: 'candidate_on_hold' });
  });

  test('day-replan apply recheckVisit refuses a held visit and writeMoves fences held_at: null when gate is live', async () => {
    const { _internals } = require('../services/day-replan/apply');

    process.env.GATE_VISIT_HOLD = 'true';
    const firstMock = jest.fn().mockResolvedValue({
      id: 'svc-1', status: 'confirmed', window_start: '09:00', customer_id: 'c-1',
      property_id: null, visit_id: null, reservation_expires_at: null,
      auto_dispatch_locked: false, auto_dispatch_excluded: false,
      held_at: new Date().toISOString(),
    });
    const recheckTrx = jest.fn(() => ({
      where: jest.fn().mockReturnThis(),
      first: firstMock,
    }));
    await expect(_internals.recheckVisit(recheckTrx, { excludedStatuses: ['cancelled'], now: () => new Date() }, {
      id: 'svc-1', dateStr: '2027-05-10', toStart: 600,
    })).rejects.toMatchObject({ code: 'NOT_MOVABLE', why: 'on_hold' });
    expect(firstMock.mock.calls[0]).toContain('held_at');

    const whereCalls = [];
    const writeTrx = jest.fn((table) => {
      if (table === 'reschedule_log') return { insert: jest.fn().mockResolvedValue([]) };
      return {
        whereIn: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{
          id: 'svc-1', customer_id: 'c-1', visit_id: null, scheduled_date: '2027-05-10',
          window_start: '09:00', window_end: '10:00', status: 'confirmed', technician_id: 'tech-1',
          service_type: 'Pest Control', service_id: 's-1', property_id: null,
        }]),
        where: jest.fn((cond) => {
          whereCalls.push(cond);
          return { update: jest.fn().mockResolvedValue(1) };
        }),
      };
    });
    await _internals.writeMoves(writeTrx, { trackTokenExpiry: () => null }, {
      dateStr: '2027-05-10',
      moves: [{ id: 'svc-1', toStart: 600, widthMin: 60, openEnd: false }],
    });
    expect(whereCalls[0]).toMatchObject({ id: 'svc-1', held_at: null });
  });

  test('arrival-route placeMovedVisit refuses a held visit and persistCapacityAllocation excludes held rows', async () => {
    const arrivalRoute = require('../services/scheduling/arrival-route');
    const prevRouting = process.env.GATE_ARRIVAL_WINDOW_ROUTING;
    const prevCap = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_ARRIVAL_WINDOW_ROUTING = 'true';
    process.env.GATE_SCHEDULING_CAPACITY = 'false';
    process.env.GATE_VISIT_HOLD = 'true';
    try {
      const sp = jest.fn(() => ({
        where: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          scheduled_date: '2027-05-10', technician_id: 'tech-1',
          window_start: '09:00', window_end: '10:00', held_at: new Date().toISOString(),
        }),
      }));
      const conn = { isTransaction: true, transaction: jest.fn(async (fn) => fn(sp)) };
      await expect(arrivalRoute.placeMovedVisit(conn, { serviceId: 'svc-held', source: 'test' })).resolves.toBeNull();

      const lockSpy = jest.spyOn(require('../services/scheduling/tech-day-lock'), 'lockTechDays').mockResolvedValue(true);
      const auditSpy = jest.spyOn(require('../services/audit-log'), 'recordAuditEvent').mockResolvedValue();
      const allocChain = {
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        select: jest.fn().mockResolvedValue([{ id: 'anchor-1', route_order: 1, window_start: '09:00', created_at: '2027-05-01' }]),
        update: jest.fn().mockResolvedValue(1),
      };
      const allocConn = jest.fn(() => allocChain);
      await arrivalRoute.persistCapacityAllocation(
        allocConn,
        { id: 'anchor-1', scheduled_date: '2027-05-10', technician_id: 'tech-1' },
        ['anchor-1'],
      );
      expect(allocChain.whereNull).toHaveBeenCalledWith('scheduled_services.held_at');
      lockSpy.mockRestore();
      auditSpy.mockRestore();
    } finally {
      if (prevRouting === undefined) delete process.env.GATE_ARRIVAL_WINDOW_ROUTING; else process.env.GATE_ARRIVAL_WINDOW_ROUTING = prevRouting;
      if (prevCap === undefined) delete process.env.GATE_SCHEDULING_CAPACITY; else process.env.GATE_SCHEDULING_CAPACITY = prevCap;
    }
  });

  test('schedule POST /:id/reschedule excludes held rows on read and fences held_at: null on update', async () => {
    const selectChain = {
      where: jest.fn().mockReturnThis(),
      whereNull: jest.fn().mockReturnThis(),
      whereIn: jest.fn().mockReturnThis(),
      forUpdate: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(null),
    };
    const fakeDb = jest.fn(() => selectChain);
    fakeDb.transaction = jest.fn(async (fn) => fn(jest.fn(() => selectChain)));

    process.env.GATE_VISIT_HOLD = 'true';
    jest.resetModules();
    jest.doMock('../models/db', () => fakeDb);
    try {
      const scheduleRouter = require('../routes/schedule');
      const layer = scheduleRouter.stack.find((l) => l.route?.path === '/:id/reschedule' && l.route.methods.post);
      const handler = layer.route.stack[layer.route.stack.length - 1].handle;

      const req = { params: { id: 'svc-held' }, customerId: 'cust-1', body: { notes: 'Please move' } };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      await handler(req, res, (err) => { if (err) throw err; });
      expect(selectChain.whereNull).toHaveBeenCalledWith('scheduled_services.held_at');
      expect(res.status).toHaveBeenCalledWith(404);

      // Also verify the CAS update fences held_at: null when the visit is not held at read time.
      const whereCalls = [];
      let call = 0;
      const readChain = {
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        forUpdate: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue({
          id: 'svc-1', customer_id: 'cust-1', status: 'confirmed', notes: null, source_action: null,
        }),
      };
      const updateChain = {
        where: jest.fn((cond) => { whereCalls.push(cond); return { update: jest.fn().mockResolvedValue(0) }; }),
      };
      fakeDb.transaction.mockImplementation(async (fn) => fn(jest.fn(() => (call++ === 0 ? readChain : updateChain))));
      const res2 = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      await handler(req, res2, (err) => { if (err) throw err; });
      expect(whereCalls[0]).toMatchObject({ id: 'svc-held', customer_id: 'cust-1', status: 'confirmed', held_at: null });
      expect(res2.status).toHaveBeenCalledWith(409);
    } finally {
      jest.dontMock('../models/db');
      jest.resetModules();
    }
  });

  test('reschedule-public POST /:token on a held visit picking its old date+time releases hold instead of replaying', async () => {
    const { etDateString, addETDays } = require('../utils/datetime-et');
    const targetDate = etDateString(addETDays(new Date(), 3));
    const heldSvc = {
      id: 'svc-held-1', customer_id: 'cust-1', technician_id: 'tech-1',
      scheduled_date: targetDate, window_start: '09:00:00', window_end: '10:00:00',
      status: 'confirmed', source_action: null, customer_confirmed: false,
      service_id: 'cat-1', service_type: 'Pest Control', service_key_snapshot: 'pest_control',
      estimated_duration_minutes: 60, is_recurring: false, visit_id: null,
      recurring_pattern: null, recurring_interval_days: null,
      date_exception: false, date_exception_cadence_date: null,
      is_callback: false, followup_included: false, catalog_frequency: null,
      recurring_parent_id: null, self_booking_id: null, office_move_approved_for: null,
      customer_pick_by: null, last_auto_dispatch_at: null,
      cust_first_name: 'Pat', cust_last_name: 'Customer', customer_phone: '9415551234',
      address_line1: '123 Main St', city: 'Sarasota', state: 'FL', zip: '34236',
      latitude: 27.33, longitude: -82.53, customer_deleted_at: null, customer_active: true,
      held_at: new Date().toISOString(),
    };
    const fakeQuery = {
      leftJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      first: jest.fn().mockResolvedValue(heldSvc),
    };
    const fakeDb = jest.fn(() => fakeQuery);
    fakeDb.raw = (sql) => sql;
    fakeDb.fn = { now: () => new Date() };

    process.env.GATE_VISIT_HOLD = 'true';
    jest.resetModules();
    jest.doMock('../models/db', () => fakeDb);
    try {
      const isolatedNotice = require('../services/scheduling/self-serve-notice');
      jest.spyOn(isolatedNotice, 'visitInsideMoveNoticeWindow').mockReturnValue(true);
      const isolatedBooking = require('../routes/booking');
      jest.spyOn(isolatedBooking._internals, 'loadBookingConfig').mockResolvedValue({ advance_days_min: 1, advance_days_max: 14 });
      jest.spyOn(isolatedBooking._internals, 'resolveBookingCoords').mockResolvedValue({ lat: 27.33, lng: -82.53 });
      jest.spyOn(isolatedBooking._internals, 'buildBookingAvailability').mockResolvedValue({
        slots: [{ date: targetDate, start_time: '09:00', end_time: '10:00', start_label: '9:00 AM', end_label: '11:00 AM', technician_id: 'tech-1' }],
        days: [{ date: targetDate, slots: [{ start_time: '09:00', end_time: '10:00', start_label: '9:00 AM', end_label: '11:00 AM', technician_id: 'tech-1' }] }],
        nearby: [],
      });
      const isolatedRebooker = require('../services/rebooker');
      jest.spyOn(isolatedRebooker, 'reschedule').mockResolvedValue({ originalDate: targetDate, newDate: targetDate });
      jest.spyOn(require('../services/appointment-reminders'), 'handleReschedule').mockResolvedValue({});
      jest.spyOn(require('../services/dispatch-assignment'), 'emitDispatchJobUpdate').mockResolvedValue();
      jest.spyOn(require('../services/reschedule-link-promises'), 'resolveUsedLink').mockResolvedValue();
      jest.spyOn(require('../services/owner-alerts'), 'recordOwnerAlert').mockResolvedValue();
      const isolatedRouter = require('../routes/reschedule-public');
      const postLayer = isolatedRouter.stack.find((l) => l.route?.path === '/:token' && l.route.methods.post);
      const postHandler = postLayer.route.stack[postLayer.route.stack.length - 1].handle;

      const req = {
        params: { token: 'a'.repeat(64) },
        body: { date: targetDate, start_time: '09:00' },
      };
      const res = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      await postHandler(req, res, (err) => { if (err) throw err; });

      expect(isolatedRebooker.reschedule).toHaveBeenCalledWith(
        'svc-held-1', targetDate, { start: '09:00', end: '10:00' }, 'customer_request', 'customer_self_serve',
        expect.objectContaining({ releaseHold: true }),
      );
      const body = res.json.mock.calls[0]?.[0];
      expect(body).toMatchObject({ success: true, newDate: targetDate });
      expect(body.replayed).toBeUndefined();

      // Concurrent same-slot hold release: a second submission that read the
      // row as held before the first committed finds held_at already cleared
      // on the same active date+start AND a matching customer_self_serve move
      // log inside moveGuard, replaying as success without duplicating logs/texts.
      const winnerMoveGuard = isolatedRebooker.reschedule.mock.calls[0][5].moveGuard;
      const makeLockedTrx = (lockedRow, logRow) => jest.fn((table) => {
        if (table === 'reschedule_log') {
          return {
            where: jest.fn().mockReturnThis(),
            orderBy: jest.fn().mockReturnThis(),
            first: jest.fn().mockResolvedValue(logRow),
          };
        }
        return {
          where: jest.fn().mockReturnThis(),
          forUpdate: jest.fn().mockReturnThis(),
          first: jest.fn().mockResolvedValue(lockedRow),
        };
      });
      const baseLocked = {
        scheduled_date: targetDate, window_start: '09:00:00', window_end: '10:00:00', status: 'confirmed',
        office_move_approved_for: null, recurring_pattern: null, recurring_interval_days: null,
        customer_pick_by: null, technician_id: 'tech-1', service_id: 'cat-1',
        is_recurring: false, recurring_parent_id: null, is_callback: false,
        followup_included: false, date_exception: false, date_exception_cadence_date: null,
        held_at: null,
      };
      // Cancelled visit with cleared hold must NEVER replay as success.
      await expect(winnerMoveGuard({
        trx: makeLockedTrx({ ...baseLocked, status: 'cancelled' }, { new_date: targetDate, new_window: '09:00-10:00' }),
      })).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
      // Cleared hold without a matching committed customer_self_serve log must NEVER replay.
      await expect(winnerMoveGuard({
        trx: makeLockedTrx(baseLocked, null),
      })).rejects.toMatchObject({ code: 'SLOT_TAKEN' });
      // Active visit on the same slot with a matching committed move log replays cleanly.
      const winnerTrx = makeLockedTrx(baseLocked, { new_date: targetDate, new_window: '09:00-10:00' });
      await expect(winnerMoveGuard({ trx: winnerTrx })).rejects.toMatchObject({ code: 'HOLD_RELEASE_REPLAY' });

      isolatedRebooker.reschedule.mockImplementationOnce(async (_id, _d, _w, _r, _by, opts) => {
        await opts.moveGuard({ trx: makeLockedTrx(baseLocked, { new_date: targetDate, new_window: '09:00-10:00' }) });
      });
      const resConcurrent = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
      await postHandler(req, resConcurrent, (err) => { if (err) throw err; });
      expect(resConcurrent.json).toHaveBeenCalledWith(expect.objectContaining({
        success: true, replayed: true, newDate: targetDate,
      }));
    } finally {
      jest.dontMock('../models/db');
      jest.resetModules();
    }
  });
});
