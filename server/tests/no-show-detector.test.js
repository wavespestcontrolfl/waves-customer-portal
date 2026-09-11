jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ resolveAlert: jest.fn().mockResolvedValue({ id: 'resolved' }) }));
const { evaluateNoShow, latestPromises, trackingKey, resolveLegacyCollision, alreadyHasOpenAlert, callerIdentityMatches, loadPromiseEvents } = require('../services/no-show-detector');
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
  // appointment-email.js's own customer_interactions row is write-once
  // (status stays 'sent' forever); the live bounce/drop/block/fail state
  // lands on email_messages via the SendGrid webhook, joined through
  // provider_message_id. A row the webhook later marked bounced must not
  // count as promise evidence — same live-status discipline
  // loadPromiseEvents already applies to sms_log.status for texts
  // (codex P1).
  function passthroughChain(result = []) {
    const chain = {};
    for (const m of ['leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'where']) chain[m] = () => chain;
    chain.select = () => Promise.resolve(result);
    return chain;
  }

  function fakeConn() {
    const calls = {};
    const conn = (table) => {
      if (table === 'messaging_audit_log as a' || table === 'audit_log') return passthroughChain([]);
      if (table === 'customer_interactions as ci') {
        const chain = {};
        chain.leftJoin = (joinTable, cb) => { calls.leftJoinTable = joinTable; calls.leftJoinCb = cb; return chain; };
        chain.where = (...args) => { (calls.whereCalls ||= []).push(args); return chain; };
        chain.whereBetween = () => chain;
        chain.whereRaw = (...args) => { (calls.whereRawCalls ||= []).push(args); return chain; };
        chain.select = () => Promise.resolve([]);
        return chain;
      }
      throw new Error(`fake conn: unexpected table ${table}`);
    };
    conn.raw = (sql, bindings) => ({ sql, bindings });
    conn.isTransaction = true;
    return { conn, calls };
  }

  test('joins email_messages on provider_message_id and excludes a currently bounced/dropped/blocked/failed match', async () => {
    const { conn, calls } = fakeConn();
    await loadPromiseEvents(conn, ['visit-1']);

    expect(calls.leftJoinTable).toBe('email_messages as em');
    const onClause = { on: jest.fn() };
    calls.leftJoinCb.call(onClause);
    expect(onClause.on).toHaveBeenCalledWith(expect.objectContaining({
      sql: expect.stringContaining("em.provider_message_id = (ci.metadata->>'provider_message_id')"),
    }));

    // The exclusion predicate is the one `.where(...)` call whose first arg
    // is a function (every other `.where(...)` call in this read passes a
    // string/object filter).
    const exclusionCall = (calls.whereCalls || []).find(([arg]) => typeof arg === 'function');
    expect(exclusionCall).toBeTruthy();
    const qb = { whereNull: jest.fn(() => qb), orWhereNotIn: jest.fn(() => qb) };
    exclusionCall[0](qb);
    expect(qb.whereNull).toHaveBeenCalledWith('em.id');
    // A bounced/dropped/blocked/failed email_messages match is excluded —
    // exactly the status vocabulary webhooks-sendgrid.js's
    // computeEmailMessageEventUpdates writes for those terminal outcomes.
    expect(qb.orWhereNotIn).toHaveBeenCalledWith('em.status', ['bounced', 'dropped', 'blocked', 'failed']);
  });
});
