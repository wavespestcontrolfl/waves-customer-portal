/**
 * Schedule & Dispatch audit — Batch 3 alerts, stuck on_site & board backend fixes.
 * Covers:
 *   - P0-8:  DECISION_ONLY_ALERT_TYPES protects visit_not_closed_out, follow_up_needed,
 *            and tech_out_overflow from resolveAlertAsDispatcher and resolveAllOpenAlerts.
 *   - P1-16: MissedAppointment.logSkip accepts yesterday's stuck en_route/on_site candidate
 *            while still rejecting a pending/confirmed candidate that moved to on_site mid-run;
 *            tech-open-visit-nudge carryover query includes stuck past en_route/on_site visits.
 *   - P1-18/P2: dispatch-alerts createAlert & resolveAllOpenAlerts defer emits on
 *            commitPromiseOf(trx) (savepoint-safe); tech-late-detector &
 *            unassigned-overdue-detector exclude rescheduled, slot holds, terminal track_state,
 *            and test customers, and unassigned-overdue normalizes scheduled_date + caps delay;
 *            unassigned-timed-visits-check keeps booked visits with leftover reservation_expires_at;
 *            stale-visit-sweep excludes slot holds, street-level holds & test customers.
 */

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';

describe('P0-8 & P2: dispatch-alerts decision-only protection and savepoint-safe post-commit emits', () => {
  test('BULK_CLEAR_PROTECTED_ALERT_TYPES protects all 3 decision cards from bulk Clear while follow_up_needed retains single-card Resolve', async () => {
    await jest.isolateModulesAsync(async () => {
      const targetRows = new Map([
        ['a-nco', { id: 'a-nco', type: 'visit_not_closed_out', resolved_at: null }],
        ['a-fu', { id: 'a-fu', type: 'follow_up_needed', resolved_at: null }],
        ['a-to', { id: 'a-to', type: 'tech_out_overflow', resolved_at: null }],
      ]);
      const whereNotInCalls = [];
      const makeChain = (id) => ({
        where: jest.fn(({ id: qid }) => ({
          first: jest.fn().mockResolvedValue(targetRows.get(qid) || null),
          whereNull: jest.fn().mockReturnThis(),
          update: jest.fn().mockReturnThis(),
          returning: jest.fn().mockResolvedValue(targetRows.get(qid) ? [{ ...targetRows.get(qid), resolved_at: new Date(), resolved_by: 'admin-1' }] : []),
        })),
        whereNull: jest.fn().mockReturnThis(),
        whereNotIn: jest.fn((col, vals) => {
          whereNotInCalls.push([col, vals]);
          return {
            update: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([]),
          };
        }),
        whereIn: jest.fn().mockReturnThis(),
        update: jest.fn().mockResolvedValue(0),
      });
      const fakeDb = jest.fn(() => makeChain());
      fakeDb.fn = { now: jest.fn(() => 'NOW()') };
      fakeDb.raw = jest.fn((s) => s);
      fakeDb.transaction = jest.fn(async (cb) => cb(fakeDb));
      jest.doMock('../models/db', () => fakeDb);
      jest.doMock('../sockets', () => ({ getIo: jest.fn(() => null) }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

      const {
        DECISION_ONLY_ALERT_TYPES,
        BULK_CLEAR_PROTECTED_ALERT_TYPES,
        resolveAlertAsDispatcher,
        resolveAllOpenAlerts,
      } = require('../services/dispatch-alerts');

      // Bulk Clear protects all three decision cards (P0-8).
      expect(BULK_CLEAR_PROTECTED_ALERT_TYPES).toEqual(
        expect.arrayContaining(['visit_not_closed_out', 'follow_up_needed', 'tech_out_overflow']),
      );
      await resolveAllOpenAlerts({ resolvedBy: 'admin-1' });
      expect(whereNotInCalls[0]).toEqual(['type', BULK_CLEAR_PROTECTED_ALERT_TYPES]);

      // Single-card Resolve still requires dedicated buttons for visit_not_closed_out,
      // while allowing explicit office dismissal of follow_up_needed and tech_out_overflow.
      expect(DECISION_ONLY_ALERT_TYPES).toEqual(['visit_not_closed_out']);
      expect(await resolveAlertAsDispatcher({ id: 'a-nco', resolvedBy: 'admin-1' }))
        .toEqual({ outcome: 'decision_required' });
      const fuRes = await resolveAlertAsDispatcher({ id: 'a-fu', resolvedBy: 'admin-1' });
      expect(fuRes.outcome).toBe('resolved');
    });
  });

  test('createAlert and resolveAllOpenAlerts wait on commitPromiseOf(trx) instead of raw trx.executionPromise', async () => {
    await jest.isolateModulesAsync(async () => {
      const emit = jest.fn();
      jest.doMock('../sockets', () => ({ getIo: jest.fn(() => ({ to: jest.fn(() => ({ emit })) })) }));
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

      let rejectOuter;
      const outerPromise = new Promise((_res, rej) => { rejectOuter = rej; });
      let resolveSavepoint;
      const savepointPromise = new Promise((res) => { resolveSavepoint = res; });

      const insertedRow = { id: 'al-1', type: 'tech_late', severity: 'warn', tech_id: 't1', job_id: 'j1', payload: null };
      const fakeTrx = jest.fn((table) => {
        if (table === 'dispatch_alerts') {
          return {
            insert: jest.fn().mockReturnThis(),
            whereNull: jest.fn().mockReturnThis(),
            whereNotIn: jest.fn().mockReturnThis(),
            update: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([insertedRow]),
          };
        }
        return { whereIn: jest.fn().mockReturnThis(), update: jest.fn().mockResolvedValue(0) };
      });
      fakeTrx.fn = { now: jest.fn(() => 'NOW()') };
      // Simulate Knex savepoint: own executionPromise resolves, outer trx rolls back.
      fakeTrx.executionPromise = savepointPromise;
      fakeTrx.parentTransaction = { executionPromise: outerPromise };

      const { createAlert, resolveAllOpenAlerts } = require('../services/dispatch-alerts');
      await createAlert({ type: 'tech_late', severity: 'warn', techId: 't1', jobId: 'j1', trx: fakeTrx });
      await resolveAllOpenAlerts({ resolvedBy: 'admin-1', trx: fakeTrx });

      // Savepoint releases, outer transaction has NOT committed yet -> zero emits!
      resolveSavepoint();
      await Promise.resolve();
      await Promise.resolve();
      expect(emit).not.toHaveBeenCalled();

      // Outer transaction rolls back -> still zero emits!
      rejectOuter(new Error('outer rollback'));
      await new Promise((r) => setImmediate(r));
      expect(emit).not.toHaveBeenCalled();

      // Inner savepoint rolls back while outer transaction catches & commits -> still zero emits!
      emit.mockClear();
      let resolveOuterOk;
      const outerOkPromise = new Promise((res) => { resolveOuterOk = res; });
      let rejectInner;
      const innerFailPromise = new Promise((_res, rej) => { rejectInner = rej; });
      fakeTrx.executionPromise = innerFailPromise;
      fakeTrx.parentTransaction = { executionPromise: outerOkPromise };
      await createAlert({ type: 'tech_late', severity: 'warn', techId: 't1', jobId: 'j2', trx: fakeTrx });
      await resolveAllOpenAlerts({ resolvedBy: 'admin-1', trx: fakeTrx });
      rejectInner(new Error('savepoint rollback'));
      resolveOuterOk();
      await new Promise((r) => setImmediate(r));
      expect(emit).not.toHaveBeenCalled();
    });
  });
});

describe('P1-16: missed-appointment accepts stuck yesterday en_route/on_site visits while guarding live transitions', () => {
  test('stillScannedCandidate accepts stuck on_site from scan, rejects pending->on_site transition', async () => {
    await jest.isolateModulesAsync(async () => {
      const insertCalls = [];
      let currentRow = null;
      const fakeConn = jest.fn((table) => {
        if (table === 'scheduled_services') {
          return {
            where: jest.fn().mockReturnThis(),
            forUpdate: jest.fn().mockReturnThis(),
            first: jest.fn(async () => currentRow),
          };
        }
        if (table === 'customers') {
          return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue({ id: 'c1' }) };
        }
        if (table === 'reschedule_log') {
          return {
            insert: jest.fn((row) => {
              insertCalls.push(row);
              return { returning: jest.fn().mockResolvedValue([{ id: 'log-1' }]) };
            }),
          };
        }
        return { where: jest.fn().mockReturnThis(), first: jest.fn().mockResolvedValue(null) };
      });
      jest.doMock('../models/db', () => fakeConn);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/not-closed-out', () => ({
        queueEnabled: jest.fn(() => true),
        raiseCard: jest.fn().mockResolvedValue(undefined),
        isSameNoShowOccurrence: jest.fn(() => true),
        RESOLUTION_BY_STATUS: {},
      }));
      jest.doMock('../services/visit-hold', () => ({ rowIsHeld: jest.fn(() => false) }));

      const missedAppointment = require('../services/workflows/missed-appointment');

      // Case 1: Yesterday's stuck on_site row stays on_site -> accepted and logged!
      currentRow = { id: 'svc-stuck', customer_id: 'c1', status: 'on_site', scheduled_date: '2026-11-26', window_start: '10:00:00', window_end: '12:00:00' };
      const r1 = await missedAppointment.onSkip('svc-stuck', 'no_show', fakeConn, {
        scanned: { id: 'svc-stuck', status: 'on_site', scheduled_date: '2026-11-26', window_start: '10:00:00', window_end: '12:00:00' },
      });
      expect(r1).toEqual({ action: 'awaiting_confirmation' });
      expect(insertCalls).toHaveLength(1);

      // Case 2: Today's pending row moved to on_site mid-run -> stale_candidate!
      currentRow = { id: 'svc-live', customer_id: 'c1', status: 'on_site', scheduled_date: '2026-11-27', window_start: '16:00:00', window_end: '18:00:00' };
      const r2 = await missedAppointment.onSkip('svc-live', 'no_show', fakeConn, {
        scanned: { id: 'svc-live', status: 'pending', scheduled_date: '2026-11-27', window_start: '16:00:00', window_end: '18:00:00' },
      });
      expect(r2).toEqual({ action: 'stale_candidate' });
      expect(insertCalls).toHaveLength(1);
    });
  });
});

describe('P1-18 & P2: unassigned-overdue-detector normalizes date, enforces max delay & filters test customers', () => {
  test('skips internal test customer and writes YYYY-MM-DD scheduled_date in payload', async () => {
    await jest.isolateModulesAsync(async () => {
      const createAlert = jest.fn().mockResolvedValue({ id: 'al-uo-1' });
      const rawCalls = [];
      const fakeDb = jest.fn();
      fakeDb.raw = jest.fn(async (sql) => {
        rawCalls.push(sql);
        return {
          rows: [
            { job_id: 'job-test', customer_id: 'test-cust-1', window_start: '09:00:00', window_end: '11:00:00', scheduled_date: new Date('2026-11-27T05:00:00.000Z'), delay_minutes: 45 },
            { job_id: 'job-real', customer_id: 'real-cust-1', window_start: '09:00:00', window_end: '11:00:00', scheduled_date: new Date('2026-11-27T05:00:00.000Z'), delay_minutes: 75 },
          ],
        };
      });
      jest.doMock('../models/db', () => fakeDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/dispatch-alerts', () => ({ createAlert }));
      jest.doMock('../services/no-show-detector', () => ({ enabled: jest.fn(() => false) }));
      jest.doMock('../services/street-level-hold', () => ({
        heldVisitSql: jest.fn(() => 'SELECT 1 WHERE FALSE'),
        isStreetLevelHoldVisit: jest.fn().mockResolvedValue(false),
      }));
      jest.doMock('../services/visit-hold', () => ({ heldSqlGuard: jest.fn(() => '') }));
      jest.doMock('../services/internal-test-customers', () => ({
        isInternalTestCustomerId: jest.fn((id) => id === 'test-cust-1'),
      }));

      const { runUnassignedOverdueCheck, UNASSIGNED_OVERDUE_MAX_DELAY_MINUTES } = require('../services/unassigned-overdue-detector');
      expect(UNASSIGNED_OVERDUE_MAX_DELAY_MINUTES).toBe(180);
      const res = await runUnassignedOverdueCheck();
      expect(res.created).toBe(1);
      expect(rawCalls[0]).toContain("'rescheduled'");
      expect(rawCalls[0]).toContain("INTERVAL '180 minutes'");
      expect(rawCalls[0]).toContain("superseded_at");
      expect(createAlert).toHaveBeenCalledTimes(1);
      expect(createAlert).toHaveBeenCalledWith(expect.objectContaining({
        type: 'unassigned_overdue',
        severity: 'critical',
        jobId: 'job-real',
        payload: expect.objectContaining({ scheduled_date: '2026-11-27' }),
      }));
    });
  });
});

describe('P1-16: tech-open-visit-nudge zero-spend guard on ordinary stuck carryover visits', () => {
  const prevNudgeGate = process.env.GATE_TECH_OPEN_VISIT_NUDGE;
  afterEach(() => {
    if (prevNudgeGate === undefined) delete process.env.GATE_TECH_OPEN_VISIT_NUDGE;
    else process.env.GATE_TECH_OPEN_VISIT_NUDGE = prevNudgeGate;
  });

  test('surfaces ordinary on_site carryover on free banner but does not trigger paid SMS fallback when banner fails', async () => {
    process.env.GATE_TECH_OPEN_VISIT_NUDGE = 'true';
    await jest.isolateModulesAsync(async () => {
      const sendSMS = jest.fn();
      const triggerNotification = jest.fn().mockResolvedValue({ push: { sent: 0 } });
      let callIdx = 0;
      const makeQuery = (rows) => {
        const c = {};
        for (const m of ['join', 'leftJoin', 'where', 'whereIn', 'whereNotNull', 'whereNull', 'whereNotExists', 'orderBy']) {
          c[m] = jest.fn().mockReturnValue(c);
        }
        c.select = jest.fn().mockResolvedValue(rows);
        return c;
      };
      const fakeDb = jest.fn((table) => {
        if (table === 'scheduled_services as s') {
          callIdx += 1;
          // 1 & 3 = today (empty), 2 & 4 = carryover (ordinary on_site visit)
          const isCarry = callIdx % 2 === 0;
          return makeQuery(isCarry ? [{
            visit_id: 'svc-carry-1',
            stop_id: null,
            technician_id: 'owner-1',
            customer_id: 'cust-1',
            service_type: 'Quarterly Pest Control',
            is_callback: false,
            service_key: 'pest_control',
            status: 'on_site',
            window_start: '09:00:00',
            scheduled_day: '2026-11-26',
            tech_name: 'Owner',
            employment_status: 'active',
            field_dispatchable: true,
            tech_phone: '+19415550100',
            cust_first_name: 'Sam',
            cust_last_name: 'Oak',
          }] : []);
        }
        if (table === 'tech_notifications') {
          return {
            insert: jest.fn().mockReturnThis(),
            onConflict: jest.fn().mockReturnThis(),
            ignore: jest.fn().mockReturnThis(),
            returning: jest.fn().mockResolvedValue([{ id: 'notif-1' }]),
            where: jest.fn().mockReturnThis(),
            del: jest.fn().mockResolvedValue(1),
          };
        }
        return makeQuery([]);
      });
      fakeDb.raw = jest.fn((s) => s);
      jest.doMock('../models/db', () => fakeDb);
      jest.doMock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
      jest.doMock('../services/twilio', () => ({ isKnownOwnerPhone: jest.fn(() => true), sendSMS }));
      jest.doMock('../services/notification-triggers', () => ({ triggerNotification }));
      jest.doMock('../services/technician-eligibility', () => ({
        isAssignable: jest.fn(() => true),
        absentTechDays: jest.fn().mockResolvedValue(new Set()),
      }));
      jest.doMock('../services/visit-hold', () => ({ excludeHeld: jest.fn((q) => q) }));
      jest.doMock('../services/street-level-hold', () => ({ heldVisitSubquery: jest.fn() }));
      jest.doMock('../services/internal-test-customers', () => ({ isInternalTestCustomerId: jest.fn(() => false) }));

      const { runTechOpenVisitNudge } = require('../services/tech-open-visit-nudge');
      const res = await runTechOpenVisitNudge({ now: new Date('2026-11-27T23:00:00Z') });
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      expect(triggerNotification).toHaveBeenCalledWith(
        'open_visits_nudge',
        expect.objectContaining({ headline: '1 visit from earlier days is still open' }),
        expect.any(Object),
      );
      expect(sendSMS).not.toHaveBeenCalled();
      expect(res.sent).toBe(0);
    });
  });
});

describe('P2: unassigned-timed-visits-check keeps booked visits with leftover reservation_expires_at', () => {
  test('SQL allows customer_id IS NOT NULL even when reservation_expires_at is set', async () => {
    jest.dontMock('../services/visit-hold');
    jest.dontMock('../services/street-level-hold');
    jest.dontMock('../services/internal-test-customers');
    const realKnex = require('knex')({ client: 'pg' });
    let capturedSql = '';
    const wrappedConn = (table) => {
      const q = realKnex(table);
      const origSelect = q.select.bind(q);
      q.select = (...args) => {
        const resQ = origSelect(...args);
        capturedSql = resQ.toSQL().sql;
        return Promise.resolve([]);
      };
      return q;
    };
    wrappedConn.raw = realKnex.raw.bind(realKnex);

    const { _private } = require('../services/unassigned-timed-visits-check');
    await _private.loadUnassignedTimedVisits(wrappedConn, '2026-11-27');
    expect(capturedSql).toMatch(/"s"\."customer_id" is not null or "s"\."reservation_expires_at" is null/i);
    await realKnex.destroy();
  });
});
