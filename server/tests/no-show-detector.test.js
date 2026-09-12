jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ resolveAlert: jest.fn().mockResolvedValue({ id: 'resolved' }) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn().mockResolvedValue({ id: 'audit' }) }));
const { evaluateNoShow, latestPromises, trackingKey, resolveLegacyCollision, alreadyHasOpenAlert, callerIdentityMatches, loadPromiseEvents, noticeStillCurrent } = require('../services/no-show-detector');
const { resolveAlert } = require('../services/dispatch-alerts');
const { replay } = require('../../ops/agents/replay-no-show-detector');

describe('missing tracking stages', () => {
  const promise = { visit_id: 'visit', start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' };
  const visit = { id: 'visit', status: 'pending', scheduled_date: '2026-09-10' };
  const at = (time, extra = {}) => evaluateNoShow({ visit: { ...visit, ...extra }, promise, now: new Date(`2026-09-10T${time}:00-04:00`) });
  test('45 minutes warns; an en-route stamp stops stage 1 but cannot stop stage 2', () => {
    expect(at('09:44')).toBeNull();
    expect(at('09:45')?.stage).toBe(1);
    expect(at('09:45', { en_route_at: '2026-09-10T09:30:00-04:00' })).toBeNull();
    expect(at('11:30', { en_route_at: '2026-09-10T09:30:00-04:00' })).toMatchObject({ stage: 2, evidence: 'missing_tracking' });
  });
  test('a later arrival is not used in the past, but an observed arrival clears the card', () => {
    const stamps = { arrived_at: '2026-09-10T11:40:00-04:00' };
    expect(at('11:30', stamps)?.stage).toBe(2);
    expect(at('11:45', stamps)).toBeNull();
    expect(at('11:30', { arrived_at: '2026-09-09T09:30:00-04:00' })?.stage).toBe(2);
  });
  test('an internal move cannot reset the old promised window', () => {
    expect(at('11:30', { scheduled_date: '2026-09-12', window_start: '14:00' })?.stage).toBe(2);
    expect(at('11:30', { status: 'completed' })).toBeNull();
  });
  test('the 48h horizon gates creation only: ignoreHorizon keeps a still-live, evidence-free visit overdue past it', () => {
    // 2026-09-12 09:01 ET is 48h + 1min after the promised 09:00 start.
    const late = (extra = {}, opts = {}) => evaluateNoShow({ visit: { ...visit, ...extra }, promise, now: new Date('2026-09-12T09:01:00-04:00'), ...opts });
    // Default (listNoShows' candidate feed): nothing new is minted this late.
    expect(late()).toBeNull();
    // Reconcile passes: elapsed time alone is not "no longer applicable".
    expect(late({}, { ignoreHorizon: true })).toMatchObject({ stage: 2, evidence: 'missing_tracking' });
    // Every other exit still applies with the horizon ignored.
    expect(late({ arrived_at: '2026-09-10T11:40:00-04:00' }, { ignoreHorizon: true })).toBeNull();
    expect(late({ status: 'completed' }, { ignoreHorizon: true })).toBeNull();
    expect(evaluateNoShow({ visit, promise: null, now: new Date('2026-09-12T09:01:00-04:00'), ignoreHorizon: true })).toBeNull();
  });
  test('a newer unknown communication window cannot be replaced by an older known one', () => {
    const map = latestPromises([promise, { ...promise, start_at: null, communicated_at: '2026-09-10T08:00:00-04:00' }], new Date('2026-09-10T12:00:00-04:00'));
    expect(map.get('visit').start_at).toBeNull();
  });
  test('replay reconstructs state before a later completion and compares both thresholds', () => {
    const report = replay({ synthetic: true, from: '2026-09-01T00:00:00Z', to: '2026-09-11T00:00:00Z', visits: [{
      id: 'visit', initial: visit, promises: [promise], events: [{ at: '2026-09-10T12:00:00-04:00', patch: { status: 'completed' } }],
      outcome: 'late', complaint_at: '2026-09-10T11:40:00-04:00',
    }] });
    expect(report.thresholds.map((r) => [r.stage1_minutes, r.stage1_alerts, r.stage2_alerts, r.before_complaint])).toEqual([[45, 1, 1, 2], [60, 1, 1, 2]]);
  });
  test('replay sees departure evidence cleared between thresholds on the next cron tick', () => {
    const report = replay({ synthetic: true, from: '2026-09-10T09:00:00-04:00', to: '2026-09-10T11:00:00-04:00', visits: [{
      id: 'visit', initial: { ...visit, en_route_at: '2026-09-10T09:30:00-04:00' }, promises: [promise],
      events: [{ at: '2026-09-10T10:07:00-04:00', patch: { en_route_at: null } }], outcome: 'tracking_gap',
    }] });
    for (const result of report.thresholds) expect(result.alerts).toMatchObject([{ stage: 1, at: '2026-09-10T14:10:00.000Z' }]);
  });
  test('replay counts a null latest promised window as missing coverage, not covered', () => {
    // new Date(null).getTime() is 0 — a finite, valid instant (the epoch) —
    // not NaN, so a naive `!Number.isFinite(new Date(start_at).getTime())`
    // guard lets an unknown latest window (start_at: null, the legacy-move
    // case latestPromises models) slip through as "covered" and understate
    // missing evidence in the backtest (codex P1).
    const report = replay({ synthetic: true, from: '2026-09-09T00:00:00-04:00', to: '2026-09-10T00:00:00-04:00', visits: [{
      id: 'visit', initial: visit, events: [],
      promises: [{ start_at: null, communicated_at: '2026-09-09T12:00:00-04:00', source: 'call' }],
      outcome: 'unknown',
    }] });
    for (const result of report.thresholds) expect(result.missing_promise_visits).toBe(1);
  });
  test('coverage is measured at the decision points, not from the final state at `to` (round-4 P1)', () => {
    // The promise is communicated AFTER the visit is already completed, but
    // before the export window closes. Every production tick that could have
    // judged this visit had nothing usable, so it is missing coverage — the
    // end-of-window lookup reported it as covered and made an evidence-poor
    // backtest look complete.
    const backfilled = { visit_id: 'visit', start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-10T18:00:00-04:00', source: 'call' };
    const report = replay({ synthetic: true, from: '2026-09-10T00:00:00-04:00', to: '2026-09-10T23:00:00-04:00', visits: [{
      id: 'visit', initial: visit, promises: [backfilled], outcome: 'unknown',
      events: [{ at: '2026-09-10T12:00:00-04:00', patch: { status: 'completed' } }],
    }] });
    for (const result of report.thresholds) {
      expect(result.missing_promise_visits).toBe(1);
      expect(result.alerts).toEqual([]);
    }
    // Communicated a day EARLIER, the same promise is real coverage at the
    // same decision points — and then the visit's own ticks emit the alerts.
    const intime = replay({ synthetic: true, from: '2026-09-10T00:00:00-04:00', to: '2026-09-10T23:00:00-04:00', visits: [{
      id: 'visit', initial: visit, promises: [{ ...backfilled, communicated_at: '2026-09-09T12:00:00-04:00' }],
      outcome: 'unknown', events: [{ at: '2026-09-10T12:00:00-04:00', patch: { status: 'completed' } }],
    }] });
    for (const result of intime.thresholds) {
      expect(result.missing_promise_visits).toBe(0);
      expect(result.alerts.length).toBeGreaterThan(0);
    }
  });

});

describe('the offline replay never loads the database module (audit P1)', () => {
  // ops/agents/replay-no-show-detector.js advertises READ-ONLY, no database
  // access, and imports this module for its pure helpers. Every service
  // dependency here is therefore required at CALL time — a module-scope
  // require of audit-log or technician-eligibility pulls in ../models/db and
  // builds a connection module for an operator running the CLI with no
  // DATABASE_URL. This test fails the moment one of them moves back to the
  // top of the file.
  // Checked in a REAL node process, not this one: jest.mock('../models/db')
  // at the top of this file makes an in-process require.cache assertion
  // vacuous, and the CLI's guarantee is about plain node with no DATABASE_URL.
  test('importing the detector in a plain node process loads no models/db', () => {
    const { execFileSync } = require('child_process');
    const path = require('path');
    const detector = path.join(__dirname, '..', 'services', 'no-show-detector.js');
    const probe = `require(${JSON.stringify(detector)});`
      + 'process.stdout.write(String(Object.keys(require.cache).some((f) => /[\\\\/]models[\\\\/]db\\.js$/.test(f))));';
    const env = { ...process.env };
    delete env.DATABASE_URL;
    delete env.DATABASE_PUBLIC_URL;
    expect(execFileSync(process.execPath, ['-e', probe], { env, encoding: 'utf8' })).toBe('false');
  });
});

describe('tracking key (reassignment refreshes the office alert)', () => {
  const base = { visitId: 'visit', startAt: '2026-09-10T13:00:00.000Z', stage: 2, type: 'tech_late' };
  test('a different recipient tech changes the key, even with promise/stage/type unchanged', () => {
    const keyForA = trackingKey({ ...base, recipient: 'tech-a' });
    const keyForB = trackingKey({ ...base, recipient: 'tech-b' });
    expect(keyForA).not.toBe(keyForB);
    // Same reason: the sweep's `alert.payload?.tracking_key !== key` branch
    // (no-show-detector.js sweep()) resolves the alert holding keyForA once
    // the live key is keyForB, so a reassigned stage-2 visit gets its office
    // alert resolved and recreated instead of sitting stale under the old
    // tech_id — /admin/dispatch/alerts joins tech_name off that stale
    // tech_id otherwise (codex P1).
  });
  test('an unassigned visit and a same-visit assigned visit never collide on the "unassigned" placeholder', () => {
    const unassigned = trackingKey({ ...base, type: 'unassigned_overdue', recipient: null });
    const assigned = trackingKey({ ...base, recipient: 'tech-a' });
    expect(unassigned).not.toBe(assigned);
  });
  test('identical inputs are stable (no spurious resolve/recreate churn on an unchanged visit)', () => {
    expect(trackingKey({ ...base, recipient: 'tech-a' })).toBe(trackingKey({ ...base, recipient: 'tech-a' }));
  });
});

describe('resolveLegacyCollision (legacy alert handover)', () => {
  // The partial unique index behind createAlertOnce
  // (idx_dispatch_alerts_tech_late_one_unresolved /
  // ..._unassigned_overdue_one_unresolved) has no payload.source condition,
  // so an unresolved LEGACY tech_late/unassigned_overdue row (the older
  // cron detectors, no payload.source) blocks the detector's own insert for
  // the same (type, job_id) forever, even though the sweep's cleanup loop
  // deliberately never auto-resolves a non-detector-sourced row (codex P1).
  function fakeAlertsTable(rows) {
    const whereRaw = jest.fn().mockResolvedValue(rows);
    const whereNull = jest.fn(() => ({ whereRaw }));
    const where = jest.fn(() => ({ whereNull }));
    const trx = jest.fn((name) => { expect(name).toBe('dispatch_alerts'); return { where }; });
    return { trx, where, whereNull, whereRaw };
  }

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('an unresolved legacy tech_late row (no payload.source) is resolved so the handover can insert', async () => {
    const legacyRow = { id: 'legacy-1', job_id: 'visit-1', type: 'tech_late', payload: { delay_minutes: 12 } };
    const { trx, where, whereNull, whereRaw } = fakeAlertsTable([legacyRow]);

    const count = await resolveLegacyCollision(trx, { jobId: 'visit-1', type: 'tech_late' });

    expect(where).toHaveBeenCalledWith({ job_id: 'visit-1', type: 'tech_late' });
    expect(whereNull).toHaveBeenCalledWith('resolved_at');
    expect(whereRaw.mock.calls[0][0]).toMatch(/payload->>'source'.*!=\s*'no_show_detector'/);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert).toHaveBeenCalledWith({ id: 'legacy-1', trx });
    expect(count).toBe(1);
  });

  test('no unresolved legacy row → nothing to resolve, no-op', async () => {
    const { trx } = fakeAlertsTable([]);
    const count = await resolveLegacyCollision(trx, { jobId: 'visit-2', type: 'unassigned_overdue' });
    expect(resolveAlert).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });

  test('every matching legacy row is resolved, not just the first', async () => {
    const rows = [
      { id: 'legacy-1', job_id: 'visit-3', type: 'unassigned_overdue', payload: null },
      { id: 'legacy-2', job_id: 'visit-3', type: 'unassigned_overdue', payload: {} },
    ];
    const { trx } = fakeAlertsTable(rows);

    const count = await resolveLegacyCollision(trx, { jobId: 'visit-3', type: 'unassigned_overdue' });

    expect(resolveAlert).toHaveBeenCalledTimes(2);
    expect(resolveAlert).toHaveBeenNthCalledWith(1, { id: 'legacy-1', trx });
    expect(resolveAlert).toHaveBeenNthCalledWith(2, { id: 'legacy-2', trx });
    expect(count).toBe(2);
  });
});


describe('alreadyHasOpenAlert (A -> B -> A reassignment does not silence recreation)', () => {
  // trackingKey (no-show-detector.js) is deterministic from
  // visitId+startAt+stage+type+recipient, so a visit reassigned A -> B -> A
  // across sweeps reuses A's ORIGINAL key on the third tick. That row was
  // auto-resolved (as a supersession) when B took over on tick 2 — it must
  // not block A's fresh recreation on tick 3, while a row a dispatcher
  // actually clicked Resolve on must still block it (codex P1, pre-push
  // audit on f32a48e35).
  function fakeAlreadyTable(finalRow) {
    const first = jest.fn().mockResolvedValue(finalRow);
    let capturedOrClause;
    const nestedWhere = jest.fn((cb) => { capturedOrClause = cb; return { first }; });
    const whereRaw = jest.fn(() => ({ where: nestedWhere }));
    const where = jest.fn(() => ({ whereRaw }));
    const trx = jest.fn((name) => { expect(name).toBe('dispatch_alerts'); return { where }; });
    return { trx, where, whereRaw, nestedWhere, first, orClause: () => capturedOrClause };
  }

  test('queries by job_id, type, and the exact tracking_key', async () => {
    const { trx, where, whereRaw } = fakeAlreadyTable(null);
    await alreadyHasOpenAlert(trx, { jobId: 'visit-1', type: 'tech_late', key: 'tracking:visit-1:...:2:tech_late:tech-a' });
    expect(where).toHaveBeenCalledWith({ job_id: 'visit-1', type: 'tech_late' });
    expect(whereRaw.mock.calls[0][0]).toContain("payload->>'tracking_key'");
    expect(whereRaw.mock.calls[0][1]).toEqual(['tracking:visit-1:...:2:tech_late:tech-a']);
  });

  test('the OR clause blocks on unresolved OR resolved-without-a-supersession-stamp', async () => {
    const { trx, orClause } = fakeAlreadyTable(null);
    await alreadyHasOpenAlert(trx, { jobId: 'visit-1', type: 'tech_late', key: 'k' });
    const qb = { whereNull: jest.fn(() => qb), orWhereRaw: jest.fn(() => qb) };
    orClause()(qb);
    expect(qb.whereNull).toHaveBeenCalledWith('resolved_at');
    expect(qb.orWhereRaw.mock.calls[0][0]).toMatch(/superseded_at.*IS NULL/);
  });

  test('resolves to the blocking row (still open, or a human resolved it) when present', async () => {
    const { trx } = fakeAlreadyTable({ id: 'alert-1' });
    const result = await alreadyHasOpenAlert(trx, { jobId: 'visit-1', type: 'tech_late', key: 'k' });
    expect(result).toEqual({ id: 'alert-1' });
  });

  test('resolves to undefined when nothing blocks (auto-superseded row does not count)', async () => {
    const { trx } = fakeAlreadyTable(undefined);
    const result = await alreadyHasOpenAlert(trx, { jobId: 'visit-1', type: 'tech_late', key: 'k' });
    expect(result).toBeUndefined();
  });
});

describe('A -> B -> A reassignment lifecycle (trackingKey + alreadyHasOpenAlert together)', () => {
  const base = { visitId: 'visit-1', startAt: '2026-09-10T13:00:00.000Z', stage: 2, type: 'tech_late' };

  // Drives alreadyHasOpenAlert against a small in-memory dispatch_alerts
  // table, honoring the SAME nested where()/orWhereRaw() shape the real
  // query builds — this exercises the actual production predicate, not a
  // reimplementation of it.
  function trxOver(rows) {
    return jest.fn((name) => {
      expect(name).toBe('dispatch_alerts');
      return {
        where: (cond) => ({
          whereRaw: (_sql, [key]) => ({
            where: (orCb) => ({
              first: async () => {
                const candidates = rows.filter((r) => r.job_id === cond.job_id && r.type === cond.type
                  && r.payload.tracking_key === key);
                for (const row of candidates) {
                  let matched = false;
                  const qb = {
                    whereNull: (col) => { if (col === 'resolved_at' && !row.resolved_at) matched = true; return qb; },
                    orWhereRaw: (sql) => { if (/superseded_at/.test(sql) && row.payload.superseded_at == null) matched = true; return qb; },
                  };
                  orCb(qb);
                  if (matched) return row;
                }
                return undefined;
              },
            }),
          }),
        }),
      };
    });
  }

  test('A -> B -> A: A gets a fresh alert on the third tick; B\'s handover freed A\'s original key', async () => {
    const keyA = trackingKey({ ...base, recipient: 'tech-a' });
    const keyB = trackingKey({ ...base, recipient: 'tech-b' });
    const rows = [];

    // Tick 1: A is overdue — nothing blocks, R1 created under keyA.
    expect(await alreadyHasOpenAlert(trxOver(rows), { jobId: 'visit-1', type: 'tech_late', key: keyA })).toBeUndefined();
    rows.push({ id: 'R1', job_id: 'visit-1', type: 'tech_late', resolved_at: null, payload: { tracking_key: keyA } });

    // Reassigned to B. Tick 2: R1's key (keyA) no longer matches the live
    // key (keyB) — the sweep's existing-loop auto-resolves it AND stamps
    // the supersession marker (mirrors no-show-detector.js sweep()).
    rows[0].resolved_at = '2026-09-10T15:00:00.000Z';
    rows[0].payload.superseded_at = rows[0].resolved_at;
    expect(await alreadyHasOpenAlert(trxOver(rows), { jobId: 'visit-1', type: 'tech_late', key: keyB })).toBeUndefined();
    rows.push({ id: 'R2', job_id: 'visit-1', type: 'tech_late', resolved_at: null, payload: { tracking_key: keyB } });

    // Reassigned back to A. Tick 3: live key is keyA again (trackingKey is
    // deterministic) — R2 (keyB) gets superseded the same way, and R1
    // (keyA), though resolved, carries its OWN supersession stamp from
    // tick 2, so it does NOT block a fresh alert for A.
    rows[1].resolved_at = '2026-09-10T16:00:00.000Z';
    rows[1].payload.superseded_at = rows[1].resolved_at;
    expect(await alreadyHasOpenAlert(trxOver(rows), { jobId: 'visit-1', type: 'tech_late', key: keyA })).toBeUndefined();
  });

  test('a manually-resolved alert (no supersession stamp) is never recreated under the same key', async () => {
    const keyA = trackingKey({ ...base, recipient: 'tech-a' });
    const rows = [
      // A dispatcher clicked Resolve — resolved_at set, but no
      // payload.superseded_at (routes/admin-dispatch.js's resolve route
      // never writes one).
      { id: 'R1', job_id: 'visit-1', type: 'tech_late', resolved_at: '2026-09-10T14:00:00.000Z', payload: { tracking_key: keyA } },
    ];
    const blocking = await alreadyHasOpenAlert(trxOver(rows), { jobId: 'visit-1', type: 'tech_late', key: keyA });
    expect(blocking).toEqual(rows[0]);
  });
});


describe('callerIdentityMatches (shared caller-identity rule with call-reschedule-apply.js)', () => {
  // Same primitive call-reschedule-apply.js's applied-reschedule path uses
  // (counterpartPhone + KNOWN_CALLER_PHONE_COLS) — reused, not copied, so
  // recordAgreedWindow never rejects a caller the apply path would accept
  // (codex P1, pre-push audit on e2e0e089c).
  const customer = {
    phone: '+19410000001',
    secondary_phone: '+19410000002',
    service_contact_phone: '+19410000003',
    service_contact2_phone: null,
    service_contact3_phone: null,
  };

  test('an inbound caller matched on the primary phone', () => {
    const call = { direction: 'inbound', from_phone: '+19410000001', to_phone: '+19415551234' };
    expect(callerIdentityMatches(call, customer)).toBe(true);
  });

  test('(a) an inbound caller matched only via a secondary/service-contact column still matches — not just customer.phone', () => {
    const viaSecondary = { direction: 'inbound', from_phone: '+19410000002', to_phone: '+19415551234' };
    expect(callerIdentityMatches(viaSecondary, customer)).toBe(true);
    const viaServiceContact = { direction: 'inbound', from_phone: '+19410000003', to_phone: '+19415551234' };
    expect(callerIdentityMatches(viaServiceContact, customer)).toBe(true);
  });

  test('an outbound (exact "outbound") call is matched on the DIALED party (to_phone), not from_phone', () => {
    const call = { direction: 'outbound', from_phone: '+19415551234', to_phone: '+19410000001' };
    expect(callerIdentityMatches(call, customer)).toBe(true);
    // from_phone (the Waves line) is not on file — proves to_phone drove the match.
    const flippedNotOnFile = { direction: 'outbound', from_phone: '+19410000001', to_phone: '+19415559999' };
    expect(callerIdentityMatches(flippedNotOnFile, customer)).toBe(false);
  });

  test('(b) direction "outbound-api" is classified as outbound (matched on to_phone), same as the apply path\'s prefix rule', () => {
    const call = { direction: 'outbound-api', from_phone: '+19415551234', to_phone: '+19410000002' };
    expect(callerIdentityMatches(call, customer)).toBe(true);
    // If this were misread as inbound (exact 'outbound' match), it would
    // compare from_phone (the Waves line, not on file) and wrongly reject.
    const wouldFailIfMisreadAsInbound = { direction: 'outbound-api', from_phone: '+19415551234', to_phone: '+19415559999' };
    expect(callerIdentityMatches(wouldFailIfMisreadAsInbound, customer)).toBe(false);
  });

  test('direction "outbound-dial" is also classified as outbound', () => {
    const call = { direction: 'outbound-dial', from_phone: '+19415551234', to_phone: '+19410000003' };
    expect(callerIdentityMatches(call, customer)).toBe(true);
  });

  test('a phone matching nothing on file does not match', () => {
    const call = { direction: 'inbound', from_phone: '+19415559999', to_phone: '+19415551234' };
    expect(callerIdentityMatches(call, customer)).toBe(false);
  });

  test('null call or null customer is handled without throwing', () => {
    expect(callerIdentityMatches(null, customer)).toBe(false);
    expect(callerIdentityMatches({ direction: 'inbound', from_phone: '+19410000001' }, null)).toBe(false);
  });
});

describe('series reschedule confirmation feeds promise evidence (P1-1)', () => {
  // admin-dispatch.js's applySeriesMoveEffects sends
  // reschedule_series_confirmation with purpose='appointment'. Before this
  // fix its metadata carried only {scheduled_service_id, series_move_id,
  // reasonText} — no rendered_slot_ms and not the rain_out_moved legacy
  // type — so loadPromiseEvents' SQL predicate
  // (`purpose = 'appointment' AND (rendered_slot_ms IS NOT NULL OR
  // original_message_type LIKE 'rain_out_moved%')`) excluded the row
  // entirely: it never became a candidate row, so latestPromises kept
  // ranking the ORIGINAL booking confirmation as "latest" and the detector
  // enforced the pre-move window after a customer-notified series move
  // (codex P1). These are the exact shapes loadPromiseEvents' `messages.map`
  // produces from a messaging_audit_log row — before (no rendered_slot_ms,
  // excluded from the query, so never in this array at all) and after (the
  // fix stamps rendered_slot_ms, so the row is included).
  test('a series move notice with rendered_slot_ms outranks the stale original-booking promise', () => {
    const originalBooking = { visit_id: 'visit', start_at: '2026-09-10T13:00:00.000Z',
      communicated_at: '2026-09-01T12:00:00.000Z', source: 'message' };
    // The series notice, AFTER the fix: rendered_slot_ms present, so
    // loadPromiseEvents' ternary resolves start_at instead of null.
    const seriesMoveNotice = { visit_id: 'visit', start_at: '2026-09-12T13:00:00.000Z',
      communicated_at: '2026-09-10T15:00:00.000Z', source: 'message' };
    const map = latestPromises([originalBooking, seriesMoveNotice], new Date('2026-09-10T16:00:00.000Z'));
    expect(map.get('visit').start_at).toBe(seriesMoveNotice.start_at);
    expect(map.get('visit').start_at).not.toBe(originalBooking.start_at);
  });

  test('without rendered_slot_ms (the pre-fix shape) the notice is invisible and the stale promise wins', () => {
    // Models loadPromiseEvents' own ternary directly: no rendered_slot_ms in
    // metadata -> start_at: null (the "excluded from the WHERE clause
    // entirely" case is stronger still — this models the row even reaching
    // the mapper, and it's STILL unusable).
    const metadata = { scheduled_service_id: 'visit', series_move_id: 'move-1', reasonText: 'weather' };
    const startAt = Number.isFinite(Number(metadata?.rendered_slot_ms)) && metadata?.rendered_slot_ms != null
      ? new Date(Number(metadata.rendered_slot_ms)).toISOString() : null;
    expect(startAt).toBeNull();
  });
});

describe('loadPromiseEvents: email promise evidence checks the LIVE delivery state (P1-3)', () => {
  function passthroughChain(result = []) {
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where']) chain[m] = () => chain;
    chain.select = () => Promise.resolve(result);
    return chain;
  }

  function fakeConn() {
    const calls = {};
    const conn = (table) => {
      if (table === 'messaging_audit_log as a' || table === 'audit_log' || table === 'series_moves as sm') return passthroughChain([]);
      if (table === 'customer_interactions as ci') {
        const chain = {};
        chain.leftJoin = (joinTable, cb) => { calls.leftJoinTable = joinTable; calls.leftJoinCb = cb; return chain; };
        chain.where = (...args) => { (calls.whereCalls ||= []).push(args); return chain; };
        chain.whereBetween = () => chain;
        chain.whereRaw = (...args) => { (calls.whereRawCalls ||= []).push(args); return chain; };
        chain.select = (...args) => { calls.selected = args; return Promise.resolve([]); };
        return chain;
      }
      throw new Error(`fake conn: unexpected table ${table}`);
    };
    conn.raw = (sql, bindings) => ({ sql, bindings });
    conn.isTransaction = true;
    return { conn, calls };
  }

  test('joins email_messages on the stable id and counts only a currently delivered row', async () => {
    const { conn, calls } = fakeConn();
    await loadPromiseEvents(conn, ['visit-1']);

    expect(calls.leftJoinTable).toBe('email_messages as em');
    const onClause = { on: jest.fn() };
    calls.leftJoinCb.call(onClause);
    // The PRIMARY key match is what survives a retry: the retry worker
    // clears/replaces provider_message_id on the SAME email_messages row, so
    // a provider-id-only join stops matching and the em.id IS NULL branch
    // below would read a known-failed delivery as usable evidence (round-4
    // P1). The provider-id match remains only as the legacy fallback, for
    // interaction rows written before email_message_id was stamped.
    const [{ sql: joinSql }] = onClause.on.mock.calls[0];
    expect(joinSql).toContain("em.id::text = (ci.metadata->>'email_message_id')");
    expect(joinSql).toContain("ci.metadata->>'email_message_id' IS NULL AND em.provider_message_id = (ci.metadata->>'provider_message_id')");
    // Third branch for rows written before email_message_id existed: their
    // provider-id link breaks the moment a retry claim clears that id, after
    // which the row reads as unlinked-and-therefore-neutral forever, even
    // while the retry sits queued or failed (round-7 P1). idempotency_key is
    // immutable and encodes <event_type>:<scheduled_service_id>:.
    // Pinned to the OCCURRENCE, not just the visit: the key's appointment
    // stamp is the slot epoch the interaction records as rendered_slot_ms, so
    // a visit rescheduled twice cannot have a later delivered confirmation
    // vouch for an earlier one the customer never received.
    expect(joinSql).toContain("em.idempotency_key LIKE (ci.metadata->>'event_type') || ':' || (ci.metadata->>'scheduled_service_id') || ':' || (ci.metadata->>'rendered_slot_ms') || ':%'");
    expect(joinSql).toContain("ci.metadata->>'rendered_slot_ms' IS NOT NULL");

    // Both grouped predicates in this read pass a function to `.where(...)`
    // (every other call passes a string/object filter). Replay each against a
    // recorder and assert on what it called.
    const grouped = (calls.whereCalls || []).filter(([arg]) => typeof arg === 'function');
    expect(grouped).toHaveLength(2);
    const replay = (fn) => {
      const seen = [];
      const qb = {};
      for (const method of ['where', 'whereRaw', 'whereNull', 'whereIn', 'orWhere', 'orWhereRaw', 'orWhereNull', 'orWhereIn']) {
        qb[method] = (...args) => { seen.push([method, ...args]); return qb; };
      }
      fn(qb);
      return seen;
    };
    const flat = grouped.map(([fn]) => replay(fn));
    const calledWith = (method, first) => flat.some((seen) => seen.some(([m, arg]) => m === method && arg === first));

    // (a) A send that FAILED and was later retried successfully still reads
    // 'failed' in its own write-once interaction row — the retry worker
    // reuses the email_messages row and writes no new interaction row. The
    // live linked status counts too, or the window the customer really got on
    // the retry would be discarded and an older promise would stand as the
    // latest (round-6 P1).
    expect(calledWith('whereRaw', "ci.metadata->>'status' IN ('sent','delivered')")).toBe(true);
    // ...and the promise is ordered at the retry's send time, not at the
    // moment the first attempt failed, or an intervening reminder would look
    // newer than a window the customer heard afterwards (round-6 P1).
    expect(calls.selected).toContain('em.sent_at as provider_sent_at');

    // (b) Unlinked stays neutral; a LINKED row must show a delivery the
    // recipient actually got — an ALLOWLIST, not "anything but the terminal
    // failures", because the retry worker flips a failed row back to 'queued'
    // before any new provider handoff and a deny-list read that interval as
    // evidence for a send that had already failed (round-6 P1).
    expect(calledWith('whereNull', 'em.id')).toBe(true);
    const statusAllowlists = flat.flat().filter(([m, arg]) => m === 'orWhereIn' && arg === 'em.status');
    expect(statusAllowlists.length).toBeGreaterThan(0);
    for (const [, , allowed] of statusAllowlists) {
      expect(allowed).toEqual(['sent', 'processed', 'delivered', 'complained', 'spam_report', 'unsubscribed']);
      for (const inFlightOrFailed of ['queued', 'processing', 'failed', 'bounced', 'dropped', 'blocked']) {
        expect(allowed).not.toContain(inFlightOrFailed);
      }
    }
  });
});


describe('loadPromiseEvents: an UNLINKED sms_log row is neutral, a sentinel sid is not (audit P1)', () => {
  // twilio.js inserts the sms_log row AFTER Twilio accepted the message,
  // inside its own try/catch — a logging failure (or an audit row that
  // predates the twilio_sid link) leaves a text the customer really got
  // with no sms_log row. Requiring positive sms_log proof dropped that
  // promise and let latestPromises fall back to an older window. Mirror of
  // the email read's em.id IS NULL rule, but only for a real SM/MM sid:
  // 'owner-silence' and the gate-/template-/internal- sentinels mean NO
  // text went out and never get an sms_log row either.
  function passthroughChain(result = []) {
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where']) chain[m] = () => chain;
    chain.select = () => Promise.resolve(result);
    return chain;
  }
  function fakeConn() {
    const calls = {};
    const conn = (table) => {
      if (table === 'customer_interactions as ci' || table === 'audit_log' || table === 'series_moves as sm') return passthroughChain([]);
      if (table === 'messaging_audit_log as a') {
        const chain = {};
        for (const m of ['leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull']) chain[m] = () => chain;
        chain.where = (...args) => { (calls.whereCalls ||= []).push(args); return chain; };
        chain.select = () => Promise.resolve([]);
        return chain;
      }
      throw new Error(`fake conn: unexpected table ${table}`);
    };
    conn.raw = (sql, bindings) => ({ sql, bindings });
    conn.isTransaction = true;
    return { conn, calls };
  }

  test('push OR linked sent/delivered/read OR (unlinked AND real Twilio sid)', async () => {
    const { conn, calls } = fakeConn();
    await loadPromiseEvents(conn, ['visit-1']);
    // Two grouped predicates now: the visit-linkage scope (appointment_id, or
    // metadata for a legacy row that predates the column) and the delivery
    // rule. The delivery one is the one that asks about sms_log status.
    const deliveredCall = (calls.whereCalls || []).filter(([arg]) => typeof arg === 'function')
      .find(([fn]) => {
        const probe = { where: () => probe, orWhereIn: (col) => { probe.sawStatus = probe.sawStatus || col === 's.status'; return probe; },
          orWhere: () => probe, whereIn: () => probe, orWhereRaw: () => probe, whereNull: () => probe, whereRaw: () => probe };
        fn.call(probe, probe);
        return probe.sawStatus === true;
      });
    expect(deliveredCall).toBeTruthy();

    const inner = { whereNull: jest.fn(() => inner), whereRaw: jest.fn(() => inner) };
    const qb = {
      where: jest.fn(() => qb), orWhereIn: jest.fn(() => qb),
      orWhere: jest.fn((fn) => { fn.call(inner); return qb; }),
    };
    deliveredCall[0].call(qb, qb);
    expect(qb.where).toHaveBeenCalledWith('a.provider', 'push');
    expect(qb.orWhereIn).toHaveBeenCalledWith('s.status', ['sent', 'delivered', 'read']);
    expect(inner.whereNull).toHaveBeenCalledWith('s.id');
    const [sidSql] = inner.whereRaw.mock.calls[0];
    expect(sidSql).toContain('a.provider_message_id');
    // The sid shape gate is the one thing that keeps the sentinels out.
    const pattern = new RegExp(sidSql.match(/'(\^.*\$)'/)[1], 'i');
    expect(pattern.test('SM' + 'a'.repeat(32))).toBe(true);
    expect(pattern.test('MM' + '0123456789abcdef'.repeat(2))).toBe(true);
    expect(pattern.test('owner-silence')).toBe(false);
    expect(pattern.test('gate-quiet-hours')).toBe(false);
    expect(pattern.test('template-disabled')).toBe(false);
    expect(pattern.test('internal-redirect')).toBe(false);
    expect(pattern.test('push:delivered')).toBe(false);
  });


  test('a legacy audit row with no appointment_id is still scoped by its metadata visit id (round-6 P1)', async () => {
    const { conn, calls } = fakeConn();
    await loadPromiseEvents(conn, ['visit-1']);
    const scopeCall = (calls.whereCalls || []).filter(([arg]) => typeof arg === 'function')
      .map(([fn]) => {
        const seen = [];
        const probe = {};
        for (const m of ['whereIn', 'orWhereRaw', 'where', 'orWhere', 'orWhereIn', 'whereNull', 'whereRaw']) {
          probe[m] = (...args) => { seen.push([m, ...args]); return probe; };
        }
        fn.call(probe, probe);
        return seen;
      })
      .find((seen) => seen.some(([m, col]) => m === 'whereIn' && col === 'a.appointment_id'));
    expect(scopeCall).toBeTruthy();
    const [, legacySql, bindings] = scopeCall.find(([m]) => m === 'orWhereRaw');
    expect(legacySql).toContain("a.appointment_id IS NULL AND a.metadata->>'scheduled_service_id' = ANY(?::text[])");
    expect(bindings).toEqual([['visit-1']]);
  });
});

describe('callCommitmentInstant (when the customer heard the promise) (round-5 P2)', () => {
  const { callCommitmentInstant } = require('../services/no-show-detector');
  // Dated at the call's START, a promise the agent made 20 minutes into a
  // long reschedule call looked OLDER to latestPromises than an automated
  // reminder that went out mid-call — and the applied-reschedule path sends
  // no confirmation of its own, so the stale window kept being enforced.
  test('uses the call end (created_at + duration), which outranks a reminder sent during the call', () => {
    const call = { created_at: '2026-09-10T10:00:00-04:00', duration_seconds: 1500 };
    expect(callCommitmentInstant(call).toISOString()).toBe('2026-09-10T14:25:00.000Z');
    const midCallReminder = { visit_id: 'visit', start_at: '2026-09-11T09:00:00-04:00', communicated_at: '2026-09-10T10:10:00-04:00', source: 'message' };
    const callPromise = { visit_id: 'visit', start_at: '2026-09-12T13:00:00-04:00', communicated_at: callCommitmentInstant(call).toISOString(), source: 'call' };
    const latest = latestPromises([midCallReminder, callPromise], new Date('2026-09-10T12:00:00-04:00')).get('visit');
    expect(latest.source).toBe('call');
  });
  test('a recording duration wins over the reported one, and no usable duration falls back to the call start', () => {
    expect(callCommitmentInstant({ created_at: '2026-09-10T10:00:00Z', recording_duration_seconds: 60, duration_seconds: 5 }).toISOString())
      .toBe('2026-09-10T10:01:00.000Z');
    expect(callCommitmentInstant({ created_at: '2026-09-10T10:00:00Z' }).toISOString()).toBe('2026-09-10T10:00:00.000Z');
    expect(callCommitmentInstant({ created_at: '2026-09-10T10:00:00Z', duration_seconds: -5 }).toISOString()).toBe('2026-09-10T10:00:00.000Z');
  });
});

describe('seriesSupersessions: one series text supersedes every moved sibling (round-6 P1, derived not written)', () => {
  const { seriesSupersessions } = require('../services/no-show-detector');
  // Derived from the series_moves row the operation already committed, not
  // written at notification time: nothing to retry when a write fails after
  // the text went out, and every move made before this feature existed reads
  // the same way (no backfill).
  // sent_at, not the move's notified_at marker: the moment the customer was
  // actually told. The read that produces these rows already held the text to
  // the same delivery bar as any other promise evidence (round-6 P1), so a
  // series text the carrier never delivered never reaches this function.
  const move = {
    id: 'move-1', sent_at: '2026-09-11T18:00:00.000Z', anchor_service_id: 'anchor',
    rows: [{ id: 'anchor', anchor: true }, { id: 'sib-1' }, { id: 'sib-2' }, { id: 'sib-x', exception: true }],
  };
  const all = new Set(['anchor', 'sib-1', 'sib-2', 'sib-x', 'other']);

  test('every moved sibling gets an UNKNOWN window stamped when the customer was told', () => {
    expect(seriesSupersessions([move], all)).toEqual([
      { visit_id: 'sib-1', start_at: null, communicated_at: move.sent_at, source: 'series_move', source_id: 'move-1' },
      { visit_id: 'sib-2', start_at: null, communicated_at: move.sent_at, source: 'series_move', source_id: 'move-1' },
      { visit_id: 'sib-x', start_at: null, communicated_at: move.sent_at, source: 'series_move', source_id: 'move-1' },
    ]);
  });

  test('the anchor is excluded (its new slot IS in the text, with a rendered_slot_ms of its own)', () => {
    const byId = Object.fromEntries(seriesSupersessions([move], all).map((e) => [e.visit_id, e]));
    expect(byId.anchor).toBeUndefined();
    // Even when the row does not carry the anchor flag, anchor_service_id does.
    const unflagged = { ...move, rows: [{ id: 'anchor' }, { id: 'sib-1' }] };
    expect(seriesSupersessions([unflagged], all).map((e) => e.visit_id)).toEqual(['sib-1']);
  });

  // rebooker.js's projectOccurrenceDate SHIFTS an exceptional date by the
  // anchor delta and stores the shifted row with exception: true — the move
  // did not leave it where it was. Dropping it here left its old-slot
  // reminder standing as its latest promise, able to raise an alert on the
  // very date the customer was told the series had moved (round-7 P1).
  test('a shifted date_exception occurrence is superseded like any other moved sibling', () => {
    expect(seriesSupersessions([move], all).map((e) => e.visit_id)).toContain('sib-x');
  });

  // Both surfaces that notify a customer of a series move stamp the move id
  // on the text they send — admin-dispatch's series confirmation and Quick
  // Move's anchor-only moved-SMS (rain-out.js's sendMovedSms) — which is what
  // the read joins on. Without the Quick Move half, every sibling a quick
  // move touched kept its pre-move reminder as its latest promise (round-6
  // P1); this asserts the sender still stamps it.
  test('a historical series move whose text carries no move id is matched by its anchor notice (round-7 P1)', async () => {
    // Quick Move's moved-SMS only starts carrying series_move_id in this PR,
    // so every quick move already in the database needs the fallback: the
    // anchor's own delivered notice inside the hour after the move committed
    // IS the text that told the customer, bounded on both sides so a later
    // ordinary reminder can never stand in for it.
    let joinSql = null;
    const chain = {};
    for (const m of ['leftJoin', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'where']) chain[m] = () => chain;
    chain.join = (table, cb) => {
      const onClause = { on: (arg) => { joinSql = arg.sql; return onClause; } };
      cb.call(onClause);
      return chain;
    };
    chain.select = () => Promise.resolve([]);
    const conn = () => chain;
    conn.raw = (sql) => ({ sql });
    conn.isTransaction = true;
    await loadPromiseEvents(conn, ['visit-1']);
    expect(joinSql).toContain("a.metadata->>'series_move_id' = sm.id::text");
    expect(joinSql).toContain("a.metadata->>'series_move_id' IS NULL AND a.appointment_id = sm.anchor_service_id");
    expect(joinSql).toContain("a.sent_at >= sm.created_at AND a.sent_at < sm.created_at + interval '1 hour'");
    // ...and only a text that actually announces a move qualifies: a 24h
    // reminder landing in the same hour announces no series move.
    expect(joinSql).toContain("a.metadata->>'original_message_type' LIKE 'rain_out_moved%'");
    expect(joinSql).toContain("a.metadata->>'original_message_type' = 'reschedule_series_confirmation'");
  });

  test('the Quick Move moved-SMS carries the series move id it is the notification of', () => {
    const rainOut = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'rain-out.js'), 'utf8');
    expect(rainOut).toContain("...(seriesMoveId ? { series_move_id: String(seriesMoveId) } : {}),");
    expect(rainOut).toContain('seriesMoveId: seriesMoveId && ownsSeriesText ? seriesMoveId : null,');
  });

  test('a fan-out to two contacts (two delivered audit rows) yields ONE event, at the earliest send', () => {
    const late = { ...move, sent_at: '2026-09-11T18:04:00.000Z' };
    const events = seriesSupersessions([late, move], all);
    expect(events).toHaveLength(3);
    for (const event of events) expect(event.communicated_at).toBe('2026-09-11T18:00:00.000Z');
  });

  test('rows outside the candidate set are dropped, and a JSON-encoded rows column is parsed', () => {
    expect(seriesSupersessions([move], new Set(['sib-2'])).map((e) => e.visit_id)).toEqual(['sib-2']);
    expect(seriesSupersessions([{ ...move, rows: JSON.stringify(move.rows) }], all).map((e) => e.visit_id)).toEqual(['sib-1', 'sib-2', 'sib-x']);
    expect(seriesSupersessions([{ ...move, rows: null }], all)).toEqual([]);
  });

  test('it outranks the sibling\'s stale pre-move reminder, and its own next reminder outranks it', () => {
    const staleReminder = { visit_id: 'sib-1', start_at: '2026-09-11T13:00:00.000Z', communicated_at: '2026-09-10T12:00:00.000Z', source: 'message' };
    const [supersession] = seriesSupersessions([move], all);
    const now = new Date('2026-09-11T19:00:00.000Z');
    expect(latestPromises([staleReminder, supersession], now).get('sib-1')).toMatchObject({ source: 'series_move', start_at: null });
    // Unknown window -> nothing to alert against.
    expect(evaluateNoShow({ visit: { id: 'sib-1', status: 'pending' }, promise: latestPromises([staleReminder, supersession], now).get('sib-1'), now })).toBeNull();
    const newReminder = { visit_id: 'sib-1', start_at: '2026-09-12T13:00:00.000Z', communicated_at: '2026-09-11T18:30:00.000Z', source: 'message' };
    expect(latestPromises([staleReminder, supersession, newReminder], now).get('sib-1')).toMatchObject({ source: 'message', start_at: '2026-09-12T13:00:00.000Z' });
  });
});

describe('cancellation -> reopen lifecycle (same key throughout, not just reassignment)', () => {
  // Distinguishes this from the A -> B -> A case above: here the tracking
  // key never changes (same visit, same technician, same promise/stage) —
  // only the VISIT STATUS does. autoResolveOverdueAlertsForJob
  // (dispatch-alerts.js) auto-resolves the tracking alert when a job
  // transitions to cancelled/completed/on_site/skipped/no_show, with no
  // key mismatch involved at all — the sweep's own reconcile loops never
  // see this row again once resolved_at is set. Without the auto stamp
  // there, reopening a WRONGLY cancelled visit (or reversing any of those
  // statuses) under the exact same promise + technician would find that
  // resolved row blocking recreation forever (codex P1, pre-push audit on
  // 925e9e977).
  function trxOver(rows) {
    return jest.fn((name) => {
      expect(name).toBe('dispatch_alerts');
      return {
        where: (cond) => ({
          whereRaw: (_sql, [key]) => ({
            where: (orCb) => ({
              first: async () => {
                const candidates = rows.filter((r) => r.job_id === cond.job_id && r.type === cond.type
                  && r.payload.tracking_key === key);
                for (const row of candidates) {
                  let matched = false;
                  const qb = {
                    whereNull: (col) => { if (col === 'resolved_at' && !row.resolved_at) matched = true; return qb; },
                    orWhereRaw: (sql) => { if (/superseded_at/.test(sql) && row.payload.superseded_at == null) matched = true; return qb; },
                  };
                  orCb(qb);
                  if (matched) return row;
                }
                return undefined;
              },
            }),
          }),
        }),
      };
    });
  }

  test('cancellation auto-resolves (stamped) the tracking alert; reopening under the same key allows a fresh one', async () => {
    const key = trackingKey({ visitId: 'visit-1', startAt: '2026-09-10T13:00:00.000Z', stage: 2, type: 'tech_late', recipient: 'tech-a' });
    // The office alert was open when the visit was (mistakenly) cancelled.
    // autoResolveOverdueAlertsForJob resolves it via resolveAlert({..., auto: true}),
    // which stamps superseded_at on the SAME write (dispatch-alerts.js).
    const rows = [
      { id: 'R1', job_id: 'visit-1', type: 'tech_late', resolved_at: '2026-09-10T14:30:00.000Z',
        payload: { tracking_key: key, superseded_at: '2026-09-10T14:30:00.000Z' } },
    ];
    // The visit is reopened (status corrected back to pending) and, on the
    // next sweep tick, is overdue again under the EXACT same key.
    const blocking = await alreadyHasOpenAlert(trxOver(rows), { jobId: 'visit-1', type: 'tech_late', key });
    expect(blocking).toBeUndefined();
  });

  test('a human-resolved tracking alert (dispatcher clicked Resolve, then the same overdue situation recurs) stays quiet', async () => {
    const key = trackingKey({ visitId: 'visit-1', startAt: '2026-09-10T13:00:00.000Z', stage: 2, type: 'tech_late', recipient: 'tech-a' });
    const rows = [
      // PATCH /alerts/:id/resolve (routes/admin-dispatch.js) calls
      // resolveAlert with no `auto` flag — no stamp.
      { id: 'R1', job_id: 'visit-1', type: 'tech_late', resolved_at: '2026-09-10T14:30:00.000Z', payload: { tracking_key: key } },
    ];
    const blocking = await alreadyHasOpenAlert(trxOver(rows), { jobId: 'visit-1', type: 'tech_late', key });
    expect(blocking).toEqual(rows[0]);
  });
});

describe('loadPromiseEvents: pre-deploy legacy reschedule/confirmation messages count as unknown, not dropped (round-3 P1)', () => {
  // rendered_slot_ms only helps FUTURE sends. A row already sent before
  // that writer fix shipped (or a future rung this list hasn't caught up
  // to) has purpose='appointment', original_message_type naming a
  // reschedule/confirmation rung, and NO rendered_slot_ms — the WHERE
  // clause used to drop it entirely, so latestPromises fell back to an
  // OLDER (often the original booking) promise and could raise a critical
  // alert against a window the visit no longer holds.
  function passthroughChain(result = []) {
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where']) chain[m] = () => chain;
    chain.select = () => Promise.resolve(result);
    return chain;
  }

  // select()'s filter is driven by the bound params the CODE UNDER TEST
  // actually passed to whereRaw — not a second, hardcoded copy of the
  // expected type list. If the fix regresses (the type dropped from the
  // list, or the whole OR-branch removed), the captured legacyTypes array
  // no longer contains it and the row is correctly filtered out, exactly
  // like a real "no such row matched" Postgres result.
  function fakeConn({ messageRows = [] } = {}) {
    const calls = {};
    const conn = (table) => {
      if (table === 'customer_interactions as ci' || table === 'audit_log' || table === 'series_moves as sm') return passthroughChain([]);
      if (table === 'messaging_audit_log as a') {
        const chain = {};
        chain.leftJoin = () => chain;
        chain.whereIn = () => chain;
        chain.whereRaw = (sql, bindings) => { calls.purposeSql = sql; calls.purposeBindings = bindings; return chain; };
        chain.where = () => chain;
        chain.whereBetween = () => chain;
        chain.whereNull = () => chain;
        chain.select = () => {
          const legacyTypes = (calls.purposeBindings && calls.purposeBindings[1]) || [];
          const matched = messageRows.filter((r) => r.metadata?.rendered_slot_ms != null
            || legacyTypes.includes(r.metadata?.original_message_type));
          return Promise.resolve(matched);
        };
        return chain;
      }
      throw new Error(`fake conn: unexpected table ${table}`);
    };
    conn.raw = (sql, bindings) => ({ sql, bindings });
    conn.isTransaction = true;
    return { conn, calls };
  }

  test('the purpose predicate matches original_message_type reschedule_series_confirmation / confirmation even without rendered_slot_ms', async () => {
    const { conn, calls } = fakeConn();
    await loadPromiseEvents(conn, ['visit-1']);
    expect(calls.purposeSql).toContain("a.metadata->>'original_message_type' = ANY(?::text[])");
    expect(calls.purposeBindings[1]).toEqual(['reschedule_series_confirmation', 'confirmation']);
  });

  test.each([
    ['reschedule_series_confirmation'],
    ['confirmation'],
  ])('a legacy %s row without rendered_slot_ms, newer than the booking confirmation, is FETCHED and becomes the latest promise as UNKNOWN (not the stale booking confirmation)', async (originalMessageType) => {
    const bookingConfirmation = { id: 'm1', appointment_id: 'visit-1',
      metadata: { rendered_slot_ms: new Date('2026-09-10T13:00:00.000Z').getTime() }, sent_at: '2026-09-01T12:00:00.000Z' };
    const legacyRow = { id: 'm2', appointment_id: 'visit-1',
      metadata: { original_message_type: originalMessageType }, sent_at: '2026-09-05T12:00:00.000Z' };
    const { conn } = fakeConn({ messageRows: [bookingConfirmation, legacyRow] });
    const now = new Date('2026-09-10T00:00:00.000Z');
    const events = await loadPromiseEvents(conn, ['visit-1'], { now });
    // The legacy row was actually returned by the (simulated) query — not
    // silently dropped — and mapped to a null start_at.
    expect(events.find((e) => e.source_id === 'm2')).toMatchObject({ start_at: null });
    const map = latestPromises(events, now);
    const latest = map.get('visit-1');
    expect(latest.start_at).toBeNull();
    expect(latest.source_id).toBe('m2');
  });
});

describe('noticeStillCurrent: an ineligible technician\'s tracking notice is dismissed (round-3 P2-A)', () => {
  const live = { stage: 2, promised_window: { start_at: '2026-09-10T13:00:00.000Z' } };
  const visit = { technician_id: 'tech-a' };
  const notice = { technician_id: 'tech-a', payload: { stage: 2, promised_window: { start_at: '2026-09-10T13:00:00.000Z' } } };

  test('same recipient, same stage/window, and the tech is still assignable -> stays current', () => {
    const recipientTech = { id: 'tech-a', employment_status: 'active', field_dispatchable: true };
    expect(noticeStillCurrent({ live, visit, notice, recipientTech })).toBe(true);
  });

  test('the recipient went field_dispatchable=false (office-only) -> no longer current, even though everything else matches', () => {
    const recipientTech = { id: 'tech-a', employment_status: 'active', field_dispatchable: false };
    expect(noticeStillCurrent({ live, visit, notice, recipientTech })).toBe(false);
  });

  test('the recipient is no longer active (offboarded) -> no longer current', () => {
    const recipientTech = { id: 'tech-a', employment_status: 'inactive', field_dispatchable: true };
    expect(noticeStillCurrent({ live, visit, notice, recipientTech })).toBe(false);
  });

  test('a different recipient (reassigned) -> no longer current regardless of recipientTech', () => {
    const otherVisit = { technician_id: 'tech-b' };
    expect(noticeStillCurrent({ live, visit: otherVisit, notice, recipientTech: { id: 'tech-b', employment_status: 'active', field_dispatchable: true } })).toBe(false);
  });

  test('live is null (visit no longer overdue) -> no longer current', () => {
    expect(noticeStillCurrent({ live: null, visit, notice, recipientTech: { id: 'tech-a', employment_status: 'active', field_dispatchable: true } })).toBe(false);
  });
});

describe('loadPromiseEvents: no fixed lookback — confirmations older than 100 days still count (round-3 P2-B)', () => {
  function passthroughChain(result = []) {
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'where']) chain[m] = () => chain;
    chain.select = () => Promise.resolve(result);
    return chain;
  }

  // The messaging_audit_log chain intentionally has no `whereBetween` — if
  // the real query still called it, this test would throw "not a
  // function" instead of silently passing.
  function fakeConn({ messageRows = [] } = {}) {
    const conn = (table) => {
      if (table === 'customer_interactions as ci' || table === 'audit_log' || table === 'series_moves as sm') return passthroughChain([]);
      if (table === 'messaging_audit_log as a') return passthroughChain(messageRows);
      throw new Error(`fake conn: unexpected table ${table}`);
    };
    conn.raw = (sql, bindings) => ({ sql, bindings });
    conn.isTransaction = true;
    return conn;
  }

  test('a visit booked >100 days out whose only evidence is a 120-day-old confirmation still gets it as the latest promise', async () => {
    // A visit booked far ahead, reminders disabled: nothing else was ever
    // sent, and the sweep evaluates near the actual service date — 120
    // days after the confirmation went out. The old fixed
    // now-100days..now lookback excluded this row entirely; with the gate
    // on, the legacy overdue scans are off too, so the visit got NO alert
    // at all.
    const now = new Date('2026-09-10T00:00:00.000Z');
    const oldConfirmation = { id: 'm1', appointment_id: 'visit-1',
      metadata: { rendered_slot_ms: new Date('2026-09-10T13:00:00.000Z').getTime() },
      sent_at: new Date(now.getTime() - 120 * 86400000).toISOString() };
    const conn = fakeConn({ messageRows: [oldConfirmation] });
    const events = await loadPromiseEvents(conn, ['visit-1'], { now });
    const map = latestPromises(events, now);
    expect(map.get('visit-1')).toMatchObject({ start_at: new Date('2026-09-10T13:00:00.000Z').toISOString(), source_id: 'm1' });
  });
});
