/**
 * Schedule & Dispatch audit — Batch 2 multi-tech, routing & reschedule fixes.
 * Covers:
 *   - P0-7:  makeSeriesProjector nudges projected siblings off kept tech's work_days off-days
 *            without mutating caller closedDays.
 *   - P1-2:  rain-out hand-off refuses held visits ('visit_on_hold'); reschedule-sms does not
 *            short-circuit alreadyOnSlot for held or no_show visits.
 *   - P1-12: tech-out-auto-move skips tech-blind preview when GATE_MULTI_TECH_CONFIRM is on.
 *   - P1-13: find-time-hints scorePickedHour passes technicianId into gap occupancy check;
 *            pick-technician & office-auto-technician honor serviceAddons and shift hours;
 *            dispatch-assignment warns on add-on capability off and auto-resolves old tech's tech_late alerts.
 *   - P1-14: find-time records tech_absent in rejections_by_date; SmartRebooker.findRescheduleOptions
 *            skips days in absentTechDays (absences + work_days).
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

describe('P0-7: series projection respects kept technician work_days without mutating closedDays', () => {
  test('nudges Adam (Wed-Sun) off Mon/Tue and Tech #2 (Mon-Thu) off Fri-Sun', async () => {
    const { makeSeriesProjector } = require('../services/rebooker');
    const baseClosed = {
      dates: new Set(['2027-01-01']),
      weeklyDaysOff: new Set(),
      closedHolidays: new Set(),
    };
    const techWorkDaysById = new Map([
      ['tech-adam', [0, 3, 4, 5, 6]], // Wed-Sun (Mon=1, Tue=2 off)
      ['tech-two', [1, 2, 3, 4]], // Mon-Thu (Fri=5, Sat=6, Sun=0 off)
    ]);
    // Anchor moves to Mon 2027-01-04; monthly cadence (+1 month) lands on Thu 2027-02-04.
    // Use weekly (+7 days) from Wed 2027-01-06 with date_exception on a Mon or Fri, AND
    // monthly on 1st Monday: 2027-01-04 (Mon) -> 2027-02-01 (Mon, Adam off -> nudged to Wed 2027-02-03).
    const service = {
      id: 'svc-1',
      customer_id: 'cust-1',
      technician_id: 'tech-adam',
      scheduled_date: '2027-01-06',
      is_recurring: true,
    };
    const parent = {
      id: 'svc-1',
      customer_id: 'cust-1',
      recurring_pattern: 'monthly',
      skip_weekends: false,
    };
    const { projectOccurrenceDate } = await makeSeriesProjector({
      service,
      parent,
      newDate: '2027-01-04', // Monday (1st Monday)
      seriesDateStr: '2027-01-04',
      prefersNoWeekends: false,
      closedDays: baseClosed,
      techWorkDaysById,
    });

    // Anchor (idx 0) honors the picked date as-is.
    expect(projectOccurrenceDate(0, service)).toBe('2027-01-04');

    // Occurrence 1 (1st Monday of Feb = 2027-02-01) for Adam (Mon/Tue off) nudges to Wed 2027-02-03.
    const adamNext = projectOccurrenceDate(1, { id: 'svc-2', technician_id: 'tech-adam', scheduled_date: '2027-02-03' });
    expect(adamNext).toBe('2027-02-03');

    // Occurrence 2 with date_exception landing on Friday for Tech #2 (Mon-Thu only) nudges to Monday.
    // deltaDays = -2 (Jan 6 -> Jan 4). Sibling originally on Sun 2027-03-07 -> shifted to Fri 2027-03-05 -> Tech #2 off Fri-Sun -> Mon 2027-03-08.
    const tech2Exc = projectOccurrenceDate(2, {
      id: 'svc-3',
      technician_id: 'tech-two',
      scheduled_date: '2027-03-07',
      date_exception: true,
    });
    expect(tech2Exc).toBe('2027-03-08');

    // Base closedDays object was never mutated (assertClosedDaysUnchanged safety).
    expect(baseClosed.weeklyDaysOff.size).toBe(0);
    expect([...baseClosed.dates]).toEqual(['2027-01-01']);
  });
});

describe('P1-2: rain-out hand-off refuses held visits', () => {
  const prevHoldGate = process.env.GATE_VISIT_HOLD;
  afterEach(() => {
    if (prevHoldGate === undefined) delete process.env.GATE_VISIT_HOLD;
    else process.env.GATE_VISIT_HOLD = prevHoldGate;
  });

  test('pickRefusalResponse returns 409 copy for visit_on_hold and handOffToCustomer rejects held row when GATE_VISIT_HOLD is on', async () => {
    process.env.GATE_VISIT_HOLD = 'true';
    await jest.isolateModulesAsync(async () => {
      const heldRow = {
        id: 'svc-held-1',
        customer_id: 'cust-1',
        cust_id: 'cust-1',
        is_recurring: true,
        recurring_parent_id: 'parent-1',
        visit_id: null,
        status: 'confirmed',
        scheduled_date: '2026-11-27',
        held_at: '2026-11-26T15:00:00Z',
        customer_active: true,
        phone: '+19415550101',
      };
      const chain = {
        where: jest.fn().mockReturnThis(),
        leftJoin: jest.fn().mockReturnThis(),
        select: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(heldRow),
      };
      jest.doMock('../models/db', () => jest.fn(() => chain));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      const rainOut = require('../services/rain-out');

      const resp = rainOut.pickRefusalResponse('visit_on_hold');
      expect(resp.status).toBe(409);
      expect(resp.body.reason).toBe('visit_on_hold');
      expect(resp.body.error).toMatch(/hold/i);

      const res = await rainOut.handOffToCustomer({
        serviceId: 'svc-held-1',
        reasonCode: 'weather_rain',
      });
      expect(res).toEqual({ ok: false, reason: 'visit_on_hold' });

      // Rollback: with GATE_VISIT_HOLD off, a stored held_at no longer blocks as visit_on_hold
      delete process.env.GATE_VISIT_HOLD;
      const resOff = await rainOut.handOffToCustomer({
        serviceId: 'svc-held-1',
        reasonCode: 'weather_rain',
      });
      expect(resOff.reason).not.toBe('visit_on_hold');
    });
  });
});

describe('P1-2: reschedule-sms does not confirm-in-place a held or no_show visit', () => {
  const prevHoldGate = process.env.GATE_VISIT_HOLD;
  afterEach(() => {
    if (prevHoldGate === undefined) delete process.env.GATE_VISIT_HOLD;
    else process.env.GATE_VISIT_HOLD = prevHoldGate;
  });

  test.each([
    ['held visit', { scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'confirmed', held_at: '2026-07-03T12:00:00Z' }],
    ['no_show visit', { scheduled_date: '2026-07-04', window_start: '13:00:00', window_end: '14:00:00', status: 'no_show', held_at: null }],
  ])('falls through to SmartRebooker.reschedule for %s', async (_label, svcRow) => {
    process.env.GATE_VISIT_HOLD = 'true';
    await jest.isolateModulesAsync(async () => {
      const option1 = { date: '2026-07-04', window: { start: '13:00', end: '14:00', display: '1:00 PM - 3:00 PM' } };
      const pending = {
        id: 'log-1',
        scheduled_service_id: 'svc-1',
        reason_code: 'weather_rain',
        sms_sent_at: '2026-07-04T17:00:00Z',
        notes: JSON.stringify({ option1 }),
      };
      const mkChain = ({ rows = [], firstVal = undefined } = {}) => ({
        where: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockReturnThis(),
        first: jest.fn().mockResolvedValue(firstVal),
        update: jest.fn().mockResolvedValue(1),
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
      });
      const queues = {
        reschedule_log: [mkChain({ rows: [pending] }), mkChain(), mkChain()],
        scheduled_services: [mkChain({ firstVal: svcRow })],
        customers: [mkChain({ firstVal: { id: 'cust-1', phone: '+19415551234' } })],
      };
      const fakeDb = jest.fn((table) => queues[table].shift());
      fakeDb.fn = { now: jest.fn(() => 'NOW()') };
      const rescheduleMock = jest.fn().mockRejectedValue(Object.assign(new Error('Visit is on hold'), { statusCode: 409, isOperational: true }));

      jest.doMock('../models/db', () => fakeDb);
      jest.doMock('../services/rebooker', () => ({ reschedule: rescheduleMock }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn().mockResolvedValue(undefined) }));
      jest.doMock('../services/messaging/send-customer-message', () => ({
        sendCustomerMessage: jest.fn().mockResolvedValue({ sent: true }),
      }));
      jest.doMock('../utils/datetime-et', () => ({
        ...jest.requireActual('../utils/datetime-et'),
        etDateString: jest.fn((d) => (d ? '2026-07-05' : '2026-07-04')),
        etParts: jest.fn(() => ({ hour: 13, minute: 30 })),
        addETDays: jest.fn(() => new Date('2026-07-05T12:00:00Z')),
      }));
      jest.doMock('../services/appointment-reminders', () => ({
        handleReschedule: jest.fn().mockResolvedValue({}),
        markRescheduleNoticeSent: jest.fn().mockResolvedValue({ updated: 1 }),
      }));

      const RescheduleSMS = require('../services/reschedule-sms');
      await RescheduleSMS.handleRescheduleReply('cust-1', '1');
      expect(rescheduleMock).toHaveBeenCalledTimes(1);
    });
  });
});

describe('P1-12: tech-out-auto-move skips tech-blind preview when techScopedConfirmActive is on', () => {
  const prevGate = process.env.GATE_MULTI_TECH_CONFIRM;
  const prevAutoMove = process.env.GATE_TECH_OUT_AUTO_MOVE;
  const prevRedist = process.env.GATE_TECH_OUT_REDISTRIBUTE;
  afterEach(() => {
    if (prevGate === undefined) delete process.env.GATE_MULTI_TECH_CONFIRM;
    else process.env.GATE_MULTI_TECH_CONFIRM = prevGate;
    if (prevAutoMove === undefined) delete process.env.GATE_TECH_OUT_AUTO_MOVE;
    else process.env.GATE_TECH_OUT_AUTO_MOVE = prevAutoMove;
    if (prevRedist === undefined) delete process.env.GATE_TECH_OUT_REDISTRIBUTE;
    else process.env.GATE_TECH_OUT_REDISTRIBUTE = prevRedist;
  });

  test('does not call previewMoveConflicts({ occupancyTechBlind: true }) when multi-tech confirm is live', async () => {
    process.env.GATE_TECH_OUT_REDISTRIBUTE = 'true';
    process.env.GATE_TECH_OUT_AUTO_MOVE = 'true';
    process.env.GATE_MULTI_TECH_CONFIRM = 'true';

    await jest.isolateModulesAsync(async () => {
      const previewMoveConflicts = jest.fn().mockResolvedValue([{ id: 'other-tech-visit' }]);
      const reschedule = jest.fn().mockResolvedValue({ success: true });
      const mkQuery = (result) => {
        const self = {};
        ['where', 'whereNot', 'whereNull', 'whereIn', 'whereNotIn', 'whereRaw', 'select', 'orderBy', 'orderByRaw', 'leftJoin', 'forShare', 'whereExists']
          .forEach((m) => { self[m] = jest.fn(() => self); });
        self.first = jest.fn(async () => (Array.isArray(result) ? (result[0] ?? null) : result));
        self.update = jest.fn(() => {
          const p = Promise.resolve(1);
          p.returning = jest.fn(async () => [{ id: 'alert-1', payload: {} }]);
          return p;
        });
        self.then = (resolve, reject) => Promise.resolve(Array.isArray(result) ? result : (result == null ? [] : [result])).then(resolve, reject);
        return self;
      };
      const alert = {
        id: 'alert-1',
        type: 'tech_out_overflow',
        tech_id: 'tech-absent',
        job_id: 'job-1',
        resolved_at: null,
        payload: { date: '2027-02-15', window_start: '09:00', window_end: '11:00' },
      };
      const stop = {
        id: 'job-1',
        status: 'confirmed',
        service_type: 'general_pest',
        window_start: '09:00',
        window_end: '11:00',
        estimated_duration_minutes: 60,
        visit_id: null,
        technician_id: 'tech-absent',
        scheduled_date: '2027-02-15',
        customer_id: 'cust-1',
        track_state: 'scheduled',
        source_action: null,
        customer_confirmed: true,
      };
      let svcCalls = 0;
      const fakeDb = jest.fn((table) => {
        if (table === 'dispatch_alerts') return mkQuery(alert);
        if (table === 'scheduled_services') {
          svcCalls += 1;
          return mkQuery(svcCalls === 1 ? stop : []);
        }
        if (table === 'technicians') return mkQuery([{ id: 'tech-free', name: 'Tech Free' }]);
        if (table === 'technician_absences') return mkQuery([]);
        return mkQuery([]);
      });
      fakeDb.raw = jest.fn(() => ({ __raw: true }));
      fakeDb.transaction = jest.fn(async (fn) => fn(fakeDb));

      jest.doMock('../models/db', () => fakeDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/rebooker', () => ({ reschedule, previewMoveConflicts }));
      jest.doMock('../services/dispatch-alerts', () => ({ resolveAlert: jest.fn().mockResolvedValue({ id: 'alert-1' }), emitAlert: jest.fn() }));
      jest.doMock('../services/dispatch-assignment', () => ({
        emitDispatchJobUpdate: jest.fn().mockResolvedValue(null),
        flushDispatchQualityDates: jest.fn().mockResolvedValue(null),
      }));
      jest.doMock('../services/technician-capabilities', () => ({
        assertCapabilitiesActive: jest.fn().mockResolvedValue(undefined),
        inactiveCapabilitiesForServices: jest.fn().mockResolvedValue([]),
      }));
      jest.doMock('../services/technician-eligibility', () => ({
        ...jest.requireActual('../services/technician-eligibility'),
        assertAssignableTechnician: jest.fn().mockResolvedValue({ id: 'tech-free' }),
        absentTechDays: jest.fn().mockResolvedValue(new Set()),
      }));
      jest.doMock('../services/scheduling/arrival-route', () => ({
        arrivalWindowRoutingEnabled: jest.fn(() => false),
        checkArrivalPlacement: jest.fn(),
      }));
      jest.doMock('../services/scheduling/day-stops', () => ({
        dayStopsQuery: jest.fn().mockResolvedValue([]),
        guardedCoordSelects: jest.fn(() => []),
      }));
      jest.doMock('../services/scheduling/tech-day-lock', () => ({ lockTechDays: jest.fn().mockResolvedValue(['k']) }));
      jest.doMock('../services/visit-groups', () => ({
        LIVE_COMPLETION_CLAIM_STATUSES: jest.requireActual('../services/visit-groups').LIVE_COMPLETION_CLAIM_STATUSES,
        lockStopForRow: jest.fn().mockResolvedValue(null),
      }));
      jest.doMock('../sockets', () => ({ getIo: jest.fn() }));
      jest.doMock('../services/estimate-slot-availability', () => ({ invalidateAllEstimates: jest.fn() }));

      const { autoAssignParkedAlert } = require('../services/tech-out-auto-move');
      const result = await autoAssignParkedAlert({ alertId: 'alert-1', actorId: 'admin-1' });
      expect(previewMoveConflicts).not.toHaveBeenCalled();
      expect(reschedule).toHaveBeenCalled();
      expect(result.moved).toBe(true);
    });
  });
});

describe('P1-13: find-time-hints scorePickedHour scopes gap occupancy check to technicianId', () => {
  test('forwards technicianId into conflictsForTarget so another tech does not block a free tech', async () => {
    await jest.isolateModulesAsync(async () => {
      const conflictsForTarget = jest.fn().mockReturnValue([]);
      const loadOccupancy = jest.fn().mockResolvedValue([]);
      jest.doMock('../services/rain-out', () => ({ conflictsForTarget, loadOccupancy }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

      const { scorePickedHour } = require('../services/scheduling/find-time-hints');
      const verdict = await scorePickedHour({
        rawSlots: [{ date: '2026-12-03', start_time: '09:00', latest_start_min: 660, detour_minutes: 5 }],
        from: '2026-12-03',
        today: '2026-12-01',
        sameDayFloorMin: 0,
        useArrivalWindows: false,
        pickedStart: '10:00',
        pickedEnd: '11:00',
        spanMin: 60,
        technicianId: 'tech-free',
        excluded: [],
        withReason: true,
      });

      expect(verdict.fits).toBe(true);
      expect(conflictsForTarget).toHaveBeenCalledWith(
        expect.anything(),
        null,
        '2026-12-03',
        { start: '10:00', end: '11:00' },
        expect.objectContaining({ technicianId: 'tech-free' }),
      );
    });
  });
});

describe('P1-13 & P2: pickTechnicianForVisit and resolveOfficeAutoTechnician enforce serviceAddons and shift hours', () => {
  test('pickTechnicianForVisit filters out techs lacking an add-on capability or outside shift', async () => {
    await jest.isolateModulesAsync(async () => {
      const inactiveCapabilitiesForServices = jest.fn().mockResolvedValue([{ technician_id: 'tech-pest-only', service_category: 'lawn' }]);
      const shiftExcluding = jest.fn(async (_conn, techId) => (techId === 'tech-short-shift' ? 'outside_shift' : null));
      const mkChain = (rows) => ({
        select: jest.fn().mockResolvedValue(rows),
        where: jest.fn().mockReturnThis(),
        whereNot: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        whereNull: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn().mockReturnThis(),
        whereRaw: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
      });
      const fakeConn = jest.fn((table) => {
        if (table === 'technicians') {
          return mkChain([
            { id: 'tech-pest-only', name: 'Pest Only' },
            { id: 'tech-short-shift', name: 'Short Shift' },
            { id: 'tech-qualified', name: 'Qualified' },
          ]);
        }
        return mkChain([]);
      });

      jest.doMock('../config/feature-gates', () => ({
        ...jest.requireActual('../config/feature-gates'),
        techShiftHoursLive: jest.fn(() => true),
      }));
      jest.doMock('../services/technician-eligibility', () => ({
        applyAssignable: (q) => q,
        absentTechDays: jest.fn().mockResolvedValue(new Set()),
        shiftExcluding,
      }));
      jest.doMock('../services/technician-capabilities', () => ({
        inactiveCapabilitiesForServices,
        stateOf: jest.fn(() => 'qualified'),
      }));
      jest.doMock('../services/scheduling/occupancy', () => ({
        ...jest.requireActual('../services/scheduling/occupancy'),
        techScopedConfirmActive: jest.fn(() => true),
        findConflictingVisits: jest.fn().mockResolvedValue([]),
      }));
      jest.doMock('../services/scheduling/line-technician', () => ({
        lineMapLive: jest.fn(() => false),
        serviceLineFor: jest.fn().mockResolvedValue({ line: null }),
        pickLineTechnician: jest.fn(),
      }));

      const { pickTechnicianForVisit } = require('../services/scheduling/pick-technician');
      const result = await pickTechnicianForVisit({
        conn: fakeConn,
        date: '2026-12-03',
        windowStart: '16:00',
        windowEnd: '17:00',
        durationMinutes: 60,
        serviceType: 'Quarterly Pest',
        serviceAddons: [{ service_type: 'Lawn Fertilizer' }],
      });

      expect(shiftExcluding).toHaveBeenCalled();
      expect(inactiveCapabilitiesForServices).toHaveBeenCalledWith(
        fakeConn,
        expect.any(Array),
        expect.arrayContaining([
          expect.objectContaining({ service_type: 'Quarterly Pest' }),
          expect.objectContaining({ service_type: 'Lawn Fertilizer' }),
        ]),
      );
      expect(result.technician?.id).toBe('tech-qualified');
    });
  });

  test('resolveOfficeAutoTechnician excludes technicians outside shift or missing add-on capability', async () => {
    await jest.isolateModulesAsync(async () => {
      const inactiveCapabilitiesForServices = jest.fn().mockResolvedValue([{ technician_id: 'tech-no-addon' }]);
      const shiftExcluding = jest.fn(async (_conn, techId) => (techId === 'tech-off-shift' ? 'outside_shift' : null));
      const mkChain = (rows) => ({
        select: jest.fn().mockResolvedValue(rows),
        where: jest.fn().mockReturnThis(),
        whereIn: jest.fn().mockReturnThis(),
        then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
      });
      const fakeConn = jest.fn((table) => {
        if (table === 'technicians') {
          return mkChain([
            { id: 'tech-off-shift', name: 'Off Shift' },
            { id: 'tech-no-addon', name: 'No Addon' },
            { id: 'tech-fit', name: 'Fits All' },
          ]);
        }
        return mkChain([]);
      });

      jest.doMock('../config/feature-gates', () => ({
        ...jest.requireActual('../config/feature-gates'),
        techShiftHoursLive: jest.fn(() => true),
      }));
      jest.doMock('../services/technician-eligibility', () => ({
        applyAssignable: (q) => q,
        absentTechDays: jest.fn().mockResolvedValue(new Set()),
        shiftExcluding,
      }));
      jest.doMock('../services/technician-capabilities', () => ({
        stateOf: jest.fn(() => 'qualified'),
        inactiveCapabilitiesForServices,
      }));
      jest.doMock('../services/scheduling/line-technician', () => ({
        lineMapLive: jest.fn(() => false),
        serviceLineFor: jest.fn().mockResolvedValue({ line: null }),
        pickLineTechnician: jest.fn(),
      }));

      const { _internals } = require('../services/scheduling/office-auto-technician');
      const techs = await _internals.assignableTechnicians(fakeConn, {
        day: '2026-12-03',
        serviceType: 'Quarterly Pest',
        serviceAddons: [{ service_type: 'Monthly Lawn' }],
        windowStart: '16:00',
        windowEnd: '17:00',
        durationMinutes: 60,
      });

      expect(techs.map((t) => t.id)).toEqual(['tech-fit']);
    });
  });
});

describe('P1-13 & P1-18: dispatch-assignment checks add-ons and auto-resolves old tech tech_late alerts', () => {
  test('queries scheduled_service_addons with service_name alias and resolves old tech tech_late alerts', async () => {
    jest.dontMock('../services/dispatch-assignment');
    await jest.isolateModulesAsync(async () => {
      const resolveAlert = jest.fn().mockResolvedValue({ id: 'late-alert-1' });
      const capabilityOffWarningsFor = jest.fn().mockResolvedValue(['Lawn capability is Off for Tech Two']);
      const addonSelect = jest.fn().mockResolvedValue([{ service_type: 'Monthly Lawn', service_id: 'addon-svc-1' }]);
      const alertWhereCalls = [];

      const job = {
        id: 'job-1',
        customer_id: 'cust-1',
        technician_id: 'tech-old',
        status: 'confirmed',
        scheduled_date: '2026-12-03',
        window_start: '10:00',
        window_end: '11:00',
        service_type: 'Quarterly Pest',
        visit_id: null,
      };
      const updatedJob = { ...job, technician_id: 'tech-new' };

      const makeTrx = () => {
        const trx = jest.fn((table) => {
          if (table === 'scheduled_services') {
            return {
              where: jest.fn().mockReturnThis(),
              whereNotIn: jest.fn().mockReturnThis(),
              whereRaw: jest.fn().mockReturnThis(),
              modify: jest.fn().mockReturnThis(),
              forUpdate: jest.fn().mockReturnThis(),
              first: jest.fn().mockResolvedValue(job),
              update: jest.fn().mockReturnThis(),
              returning: jest.fn().mockResolvedValue([updatedJob]),
            };
          }
          if (table === 'scheduled_service_addons') {
            return {
              where: jest.fn().mockReturnThis(),
              select: addonSelect,
            };
          }
          if (table === 'dispatch_alerts') {
            return {
              where: jest.fn((cond) => { alertWhereCalls.push(cond); return trx._alertChain; }),
              whereNull: jest.fn().mockReturnThis(),
              select: jest.fn().mockResolvedValue([{ id: 'late-alert-1' }]),
            };
          }
          return {
            where: jest.fn().mockReturnThis(),
            select: jest.fn().mockResolvedValue([]),
            first: jest.fn().mockResolvedValue(null),
            insert: jest.fn().mockResolvedValue([]),
          };
        });
        trx._alertChain = {
          whereNull: jest.fn().mockReturnThis(),
          select: jest.fn().mockResolvedValue([{ id: 'late-alert-1' }]),
        };
        trx.fn = { now: jest.fn(() => 'NOW()') };
        trx.raw = jest.fn().mockResolvedValue({ rows: [] });
        trx.transaction = jest.fn(async (fn) => fn(trx));
        return trx;
      };
      const fakeDb = makeTrx();

      jest.doMock('../models/db', () => fakeDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/technician-eligibility', () => ({
        assertAssignableTechnician: jest.fn().mockResolvedValue({ id: 'tech-new', name: 'Tech Two' }),
        capabilityOffWarningsFor,
        dayWarningFor: jest.fn().mockResolvedValue(null),
        workDayWarningFor: jest.fn().mockResolvedValue(null),
        shiftWarningFor: jest.fn().mockResolvedValue(null),
      }));
      jest.doMock('../services/dispatch-alerts', () => ({
        autoResolveUnassignedAlertsForJob: jest.fn().mockResolvedValue({ resolved: 0 }),
        resolveAlert,
      }));
      jest.doMock('../services/tech-visit-notifications', () => ({
        notifyAssignmentChange: jest.fn().mockResolvedValue(undefined),
        notifyVisitAssigned: jest.fn().mockResolvedValue(undefined),
        notifyVisitUnassigned: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('../services/visit-groups', () => ({
        syncVisitTechnician: jest.fn().mockResolvedValue(undefined),
        handleChildStopChanged: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('../services/appointment-reminders', () => ({
        releaseMoveHoldIfRepaired: jest.fn().mockResolvedValue(undefined),
      }));
      jest.doMock('../sockets', () => ({ getIo: jest.fn(() => null) }));

      const { assignDispatchJob } = require('../services/dispatch-assignment');
      const res = await assignDispatchJob({
        jobId: 'job-1',
        technicianId: 'tech-new',
        actorId: 'admin-1',
        emit: false,
      });

      expect(addonSelect).toHaveBeenCalledWith('service_name as service_type', 'service_id');
      expect(capabilityOffWarningsFor).toHaveBeenCalledWith(
        'tech-new',
        expect.arrayContaining([job, { service_type: 'Monthly Lawn', service_id: 'addon-svc-1' }]),
        expect.any(Object),
      );
      expect(alertWhereCalls).toContainEqual({ type: 'tech_late', job_id: 'job-1', tech_id: 'tech-old' });
      expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({
        id: 'late-alert-1',
        resolvedBy: 'admin-1',
        auto: true,
      }));
      expect(res.warnings).toContain('Lawn capability is Off for Tech Two');
    });
  });
});

describe('P1-14: find-time records tech_absent in rejections_by_date', () => {
  test('findAvailableSlots reports rejections_by_date[date].tech_absent when a tech is absent', async () => {
    await jest.isolateModulesAsync(async () => {
      const mkChain = (rows) => {
        const self = {};
        ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereBetween', 'leftJoin', 'join', 'orderBy', 'select', 'modify']
          .forEach((m) => { self[m] = jest.fn(() => self); });
        self.first = jest.fn().mockResolvedValue(rows[0] ?? null);
        self.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
        return self;
      };
      const fakeDb = jest.fn((table) => {
        if (table === 'technicians') return mkChain([{ id: 'tech-1', name: 'Tech One', home_lat: 27.49, home_lng: -82.57 }]);
        return mkChain([]);
      });
      fakeDb.raw = jest.fn(() => ({ rows: [] }));

      jest.doMock('../models/db', () => fakeDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/technician-eligibility', () => ({
        applyAssignable: (q) => q,
        absentTechDays: jest.fn().mockResolvedValue(new Set(['tech-1:2026-12-03'])),
        loadTechShifts: jest.fn().mockResolvedValue(() => null),
        shiftBounds: jest.fn((_s, open, close) => ({ openMin: open, closeMin: close })),
      }));
      jest.doMock('../services/scheduling/blackout-dates', () => ({
        getBlackoutDates: jest.fn().mockResolvedValue(new Set()),
        getBlackoutLayers: jest.fn().mockResolvedValue({ dates: new Set(), weeklyDaysOff: new Set(), closedHolidays: new Set() }),
      }));

      const { findAvailableSlots } = require('../services/scheduling/find-time');
      const result = await findAvailableSlots({
        lat: 27.49,
        lng: -82.57,
        dateFrom: '2026-12-03',
        dateTo: '2026-12-03',
        durationMinutes: 60,
        includeWeekends: true,
      });

      expect(result.rejections_by_date).toEqual({
        '2026-12-03': { tech_absent: 1 },
      });
      expect(result.searched_dates).toEqual([]);
    });
  });
});
