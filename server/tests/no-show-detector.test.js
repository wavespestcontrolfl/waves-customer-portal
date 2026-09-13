jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/dispatch-alerts', () => ({ resolveAlert: jest.fn().mockResolvedValue({ id: 'resolved' }) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn().mockResolvedValue({ id: 'audit' }) }));
const { evaluateNoShow, latestPromises, trackingKey, resolveLegacyCollision, alreadyHasOpenAlert, loadPromiseEvents, noticeStillCurrent } = require('../services/no-show-detector');
const { resolveAlert } = require('../services/dispatch-alerts');
const { replay } = require('../../ops/agents/replay-no-show-detector');

describe('missing tracking stages', () => {
  const promise = { visit_id: 'visit', start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' };
  const visit = { id: 'visit', status: 'pending', scheduled_date: '2026-09-10' };
  const at = (time, extra = {}) => evaluateNoShow({ visit: { ...visit, ...extra }, promise, now: new Date(`2026-09-10T${time}:00-04:00`) });
  test('an en_route STATUS stops stage 1 even with no stamp yet (round-14 P2)', () => {
    // admin-dispatch commits transitionJobStatus before calling
    // trackTransitions.markEnRoute, and a failure there is caught — so a
    // visit can sit at status 'en_route' with no en_route_at, and stage 1
    // ("no departure recorded") would be a false warning about a tech who is
    // already driving.
    expect(at('09:45', { status: 'en_route' })).toBeNull();
    // Stage 2 still fires: departure is not arrival.
    expect(at('11:30', { status: 'en_route' })).toMatchObject({ stage: 2 });
  });
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
  test('on a TIE the known window wins, but a newer unknown still supersedes (round-14 P1)', () => {
    const at = '2026-09-10T12:00:00-04:00';
    const unknown = { visit_id: 'visit', start_at: null, communicated_at: at, source: 'email' };
    const known = { visit_id: 'visit', start_at: '2026-09-10T09:00:00-04:00', communicated_at: at, source: 'email' };
    const now = new Date('2026-09-10T13:00:00-04:00');
    // The same send can arrive twice: once from a legacy interaction row with
    // no rendered_slot_ms, once recovered from the message key. Keeping the
    // unknown copy threw away the window the recovery exists to restore.
    expect(latestPromises([unknown, known], now).get('visit').start_at).toBe(known.start_at);
    expect(latestPromises([known, unknown], now).get('visit').start_at).toBe(known.start_at);
    // A strictly NEWER unknown still supersedes — the legacy move-notice rule.
    const laterUnknown = { ...unknown, communicated_at: '2026-09-10T12:30:00-04:00' };
    expect(latestPromises([known, laterUnknown], now).get('visit').start_at).toBeNull();
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
  test('a reassignment re-alerts in the replay, as production does (round-10 P2)', () => {
    // trackingKey folds in the recipient, so A -> B with the same promise and
    // stage mints a fresh card for B; deduping on window+stage alone
    // suppressed it and understated the volume a rollout decision is made on.
    const report = replay({ synthetic: true, from: '2026-09-10T09:00:00-04:00', to: '2026-09-10T12:00:00-04:00', visits: [{
      id: 'visit', initial: { ...visit, technician_id: 'tech-a' }, outcome: 'late',
      promises: [{ start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' }],
      // After BOTH thresholds (09:45 and 10:00), so each run sees a card for
      // A and then a fresh one for B.
      events: [{ at: '2026-09-10T10:30:00-04:00', patch: { technician_id: 'tech-b' } }],
    }] });
    for (const result of report.thresholds) {
      const stage1 = result.alerts.filter((a) => a.stage === 1);
      expect(stage1).toHaveLength(2);
      expect(stage1[1].at).toBe('2026-09-10T14:30:00.000Z');
    }
  });
  test('a card that auto-resolves and recurs alerts twice in the replay (round-10 P1)', () => {
    // En Route recorded at 09:50 clears the stage-1 card (production resolves
    // it, stamped superseded); cleared again at 10:30, the same key must be
    // raisable — production would raise a fresh card.
    const report = replay({ synthetic: true, from: '2026-09-10T09:00:00-04:00', to: '2026-09-10T11:00:00-04:00', visits: [{
      id: 'visit', initial: visit, outcome: 'tracking_gap',
      promises: [{ start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' }],
      events: [
        { at: '2026-09-10T09:50:00-04:00', patch: { en_route_at: '2026-09-10T09:50:00-04:00' } },
        { at: '2026-09-10T10:30:00-04:00', patch: { en_route_at: null } },
      ],
    }] });
    const stage1 = report.thresholds[0].alerts.filter((a) => a.stage === 1);
    expect(stage1).toHaveLength(2);
  });
  test('an A -> B -> A reassignment gives A a second card in the replay (round-10 P1)', () => {
    const report = replay({ synthetic: true, from: '2026-09-10T09:00:00-04:00', to: '2026-09-10T13:00:00-04:00', visits: [{
      id: 'visit', initial: { ...visit, technician_id: 'tech-a' }, outcome: 'late',
      promises: [{ start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' }],
      events: [
        { at: '2026-09-10T10:30:00-04:00', patch: { technician_id: 'tech-b' } },
        { at: '2026-09-10T11:00:00-04:00', patch: { technician_id: 'tech-a' } },
      ],
    }] });
    const stage1 = report.thresholds[0].alerts.filter((a) => a.stage === 1);
    expect(stage1).toHaveLength(3);
  });
  test('a promise that flip-flops A -> B -> A alerts for A twice (round-10 P1)', () => {
    // Production supersedes the A card when B arrives and allows a fresh one
    // when A returns; a key suppressed for the whole export hid the second.
    const base = { visit_id: 'visit', source: 'message' };
    const report = replay({ synthetic: true, from: '2026-09-10T09:00:00-04:00', to: '2026-09-10T13:00:00-04:00', visits: [{
      id: 'visit', initial: visit, outcome: 'tracking_gap', events: [],
      promises: [
        { ...base, start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00' },
        { ...base, start_at: '2026-09-10T10:00:00-04:00', communicated_at: '2026-09-10T09:50:00-04:00' },
        { ...base, start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-10T11:00:00-04:00' },
      ],
    }] });
    const forA = report.thresholds[0].alerts
      .filter((a) => a.stage === 1 || a.stage === 2);
    // The A window is alerted on before the B notice and again after it.
    expect(forA.length).toBeGreaterThanOrEqual(3);
  });
  test('replay sees departure evidence cleared between thresholds on the next cron tick', () => {
    const report = replay({ synthetic: true, from: '2026-09-10T09:00:00-04:00', to: '2026-09-10T11:00:00-04:00', visits: [{
      id: 'visit', initial: { ...visit, en_route_at: '2026-09-10T09:30:00-04:00' }, promises: [promise],
      events: [{ at: '2026-09-10T10:07:00-04:00', patch: { en_route_at: null } }], outcome: 'tracking_gap',
    }] });
    for (const result of report.thresholds) expect(result.alerts).toMatchObject([{ stage: 1, at: '2026-09-10T14:10:00.000Z' }]);
  });
  test('a grouped stop\'s member rows replay as ONE visit (round-12 P2)', () => {
    // Production collapses rows sharing a service_visits row into one card
    // with one merged state and the latest promise across members; an export
    // carrying the members must not count duplicate alerts, nor mark the
    // non-owner sibling as missing evidence.
    const promise = { start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' };
    const grouped = replay({ synthetic: true, from: '2026-09-10T09:00:00-04:00', to: '2026-09-10T12:00:00-04:00', visits: [
      { id: 'aaa', stop_id: 'stop-1', initial: visit, promises: [promise], events: [], outcome: 'late' },
      // The sibling holds no evidence of its own — the grouped reminder went
      // out under the other member's claim.
      { id: 'bbb', stop_id: 'stop-1', initial: visit, promises: [], events: [], outcome: 'unknown' },
    ] });
    expect(grouped.visits).toBe(1);
    for (const result of grouped.thresholds) {
      expect(result.missing_promise_visits).toBe(0);
      expect(result.alerts.filter((a) => a.stage === 1)).toHaveLength(1);
    }
    // Without the grouping key they are two separate stops, as every row is
    // while GATE_VISIT_GROUPS is off.
    const ungrouped = replay({ synthetic: true, from: '2026-09-10T09:00:00-04:00', to: '2026-09-10T12:00:00-04:00', visits: [
      { id: 'aaa', initial: visit, promises: [promise], events: [], outcome: 'late' },
      { id: 'bbb', initial: visit, promises: [], events: [], outcome: 'unknown' },
    ] });
    expect(ungrouped.visits).toBe(2);
    for (const result of ungrouped.thresholds) expect(result.missing_promise_visits).toBe(1);
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
  test('a window replaced by an unknown one BEFORE either threshold is missing coverage, not covered (round-8 P1)', () => {
    // The old confirmation has a real window, but a reschedule notice with no
    // saved slot replaces it at 09:20 — before the 09:45 stage-1 threshold.
    // Every tick that could have judged this visit had an unknown window; a
    // pre-window tick at 08:00 must not mark it covered.
    const report = replay({ synthetic: true, from: '2026-09-10T07:00:00-04:00', to: '2026-09-10T23:00:00-04:00', visits: [{
      id: 'visit', initial: visit, outcome: 'unknown', events: [],
      promises: [
        { start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' },
        { start_at: null, communicated_at: '2026-09-10T09:20:00-04:00', source: 'message' },
      ],
    }] });
    for (const result of report.thresholds) {
      expect(result.missing_promise_visits).toBe(1);
      expect(result.alerts).toEqual([]);
    }
    // Without the replacement, the same promise IS coverage — it is usable at
    // the thresholds, and the visit alerts.
    const covered = replay({ synthetic: true, from: '2026-09-10T07:00:00-04:00', to: '2026-09-10T23:00:00-04:00', visits: [{
      id: 'visit', initial: visit, outcome: 'unknown', events: [],
      promises: [{ start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' }],
    }] });
    for (const result of covered.thresholds) {
      expect(result.missing_promise_visits).toBe(0);
      expect(result.alerts.length).toBeGreaterThan(0);
    }
  });
  test('an on-time visit completed before the first threshold is NOT counted as missing evidence (round-9 P2)', () => {
    // 09:00 window, completed 09:30, stage-1 threshold 09:45: no decision
    // point was ever required, and a valid promise was in hand throughout.
    // Counting it missing inflated the denominator the rollout report is
    // read for.
    const report = replay({ synthetic: true, from: '2026-09-10T07:00:00-04:00', to: '2026-09-10T23:00:00-04:00', visits: [{
      id: 'visit', initial: visit, outcome: 'on_time',
      promises: [{ start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' }],
      events: [{ at: '2026-09-10T09:30:00-04:00', patch: { status: 'completed' } }],
    }] });
    for (const result of report.thresholds) {
      expect(result.missing_promise_visits).toBe(0);
      expect(result.alerts).toEqual([]);
    }
    // A visit with NO usable window that completes early is still missing
    // evidence — the fix must not swallow the real case.
    const unknown = replay({ synthetic: true, from: '2026-09-10T07:00:00-04:00', to: '2026-09-10T23:00:00-04:00', visits: [{
      id: 'visit', initial: visit, outcome: 'on_time',
      promises: [{ start_at: null, communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' }],
      events: [{ at: '2026-09-10T09:30:00-04:00', patch: { status: 'completed' } }],
    }] });
    for (const result of unknown.thresholds) expect(result.missing_promise_visits).toBe(1);
  });
  test('a window replaced before the threshold and then completed is still missing coverage (round-9 P1)', () => {
    // The early-completion exception must not resurrect a window the visit
    // no longer held: known at 08:00, replaced by an unknown-window notice
    // at 09:20, completed 09:30, threshold 09:45.
    const report = replay({ synthetic: true, from: '2026-09-10T07:00:00-04:00', to: '2026-09-10T23:00:00-04:00', visits: [{
      id: 'visit', initial: visit, outcome: 'on_time',
      promises: [
        { start_at: '2026-09-10T09:00:00-04:00', communicated_at: '2026-09-09T12:00:00-04:00', source: 'message' },
        { start_at: null, communicated_at: '2026-09-10T09:20:00-04:00', source: 'message' },
      ],
      events: [{ at: '2026-09-10T09:30:00-04:00', patch: { status: 'completed' } }],
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

describe('candidates come from the promise as well as the schedule (deferred P2, round 18)', () => {
  const { promisedVisitIds } = require('../services/no-show-detector');
  // A still-live visit staff moved far out of the date window WITHOUT telling
  // the customer would otherwise drop out before its immutable promise
  // evidence was ever read — the uncommunicated move this detector exists to
  // catch.
  // Recall follows the PROMISED WINDOW, not the send time: a confirmation for
  // a visit booked months ahead is the only communication that visit may ever
  // get, and a send-time cutoff dropped exactly the long-lead-confirmation
  // plus uncommunicated-move case this path exists for (round-19 P1).
  test('the recall range is the promised window, not the send time', async () => {
    const seen = [];
    const conn = (table) => {
      const chain = {};
      chain.where = () => chain;
      chain.whereIn = () => chain;
      chain.join = () => chain;
      chain.whereRaw = (sql, bindings) => { seen.push([table, sql, bindings]); return chain; };
      chain.whereBetween = (col, range) => { seen.push([table, col?.sql || col, range]); return chain; };
      chain.select = () => Promise.resolve([]);
      return chain;
    };
    conn.raw = (sql) => ({ sql });
    const now = new Date('2026-09-12T12:00:00.000Z');
    await promisedVisitIds(conn, { now });
    const slotRanges = seen.filter(([, sql]) => String(sql).includes('rendered_slot_ms')
      || String(sql).includes("split_part(idempotency_key, ':', 3)::bigint"));
    // Three tables carry a slot: the two metadata ones and email_messages,
    // whose durable row is the recovery when the interaction insert failed —
    // leaving it out of recall meant that visit could still be moved out of
    // the date window and vanish (round-20 P1).
    expect(slotRanges).toHaveLength(3);
    for (const [, , bindings] of slotRanges) {
      expect(bindings).toEqual([now.getTime() - 48 * 3600000, now.getTime()]);
    }
    const auditRange = seen.find(([table]) => table === 'audit_log');
    expect(auditRange[1]).toContain("metadata->>'start_at'");
    expect(auditRange[2]).toEqual(['2026-09-10T12:00:00.000Z', '2026-09-12T12:00:00.000Z']);
  });

  test('ids come from every evidence linkage, deduped', async () => {
    const conn = (table) => {
      const chain = {};
      for (const m of ['where', 'whereRaw', 'whereBetween', 'whereIn', 'join']) chain[m] = () => chain;
      chain.select = () => Promise.resolve(({
        messaging_audit_log: [{ appointment_id: 'v1', meta_visit_id: null }, { appointment_id: null, meta_visit_id: 'v2' }],
        customer_interactions: [{ meta_visit_id: 'v2' }, { meta_visit_id: 'v3' }],
        audit_log: [{ resource_id: 'v4' }],
        email_messages: [{ meta_visit_id: 'v5' }],
        activity_log: [{ meta_visit_id: 'v6' }],
        'scheduled_services as sv': [{ meta_visit_id: 'v7' }],
      })[table] || []);
      return chain;
    };
    conn.raw = (sql) => ({ sql });
    const ids = await promisedVisitIds(conn, { now: new Date('2026-09-12') });
    // Including the two DERIVED call promises, which are the only evidence
    // their visits have — neither path sends the customer anything of its
    // own (round-20 P1).
    expect(ids.sort()).toEqual(['v1', 'v2', 'v3', 'v4', 'v5', 'v6', 'v7']);
  });

  // The grouped reminder is linked to whichever member won the send claim,
  // and that member may have been cancelled since — the live siblings still
  // holding its window would then be recalled by nobody, because the status
  // filter drops the only id the promise pointed at (round-26 P1).
  test('the live siblings of a cancelled promise owner are pulled in explicitly', () => {
    const detector = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'no-show-detector.js'), 'utf8');
    expect(detector).toContain('const strandedStops = promisedIds.length');
    expect(detector).toContain(".whereIn('id', promisedIds).whereNotIn('status', LIVE_STATUSES)");
    expect(detector).toContain(".whereIn('s.visit_id', strandedStops).whereIn('s.status', LIVE_STATUSES)");
  });

  test('nothing communicated recently -> no extra candidates', async () => {
    const conn = () => {
      const chain = {};
      for (const m of ['where', 'whereRaw', 'whereBetween', 'whereIn', 'join']) chain[m] = () => chain;
      chain.select = () => Promise.resolve([]);
      return chain;
    };
    conn.raw = (sql) => ({ sql });
    expect(await promisedVisitIds(conn, { now: new Date('2026-09-12') })).toEqual([]);
  });
});

describe('cleanupAfterDisable stands down while the feature runs elsewhere (round-20 P1)', () => {
  const { cleanupAfterDisable } = require('../services/no-show-detector');
  // The gate is read per process, so during a zero-downtime deploy an old
  // replica can still see it as OFF while a new one creates rows under it.
  // Judging each row by its own age was not enough — a long-standing alert
  // the enabled replica is still maintaining is old — so the signal is
  // detector ACTIVITY anywhere in the fleet.
  function fakeConn({ sweepRan = null, recentAlert = null, recentNotice = null } = {}) {
    const calls = { updated: 0, probed: [] };
    const conn = (table) => {
      const chain = {};
      for (const m of ['whereIn', 'whereRaw', 'whereNull', 'where']) chain[m] = () => chain;
      chain.first = async () => {
        calls.probed.push(table);
        if (table === 'job_health') return sweepRan;
        return table === 'dispatch_alerts' ? recentAlert : recentNotice;
      };
      chain.first.catch = undefined;
      chain.select = async () => [];
      chain.update = async () => { calls.updated += 1; return 0; };
      return chain;
    };
    conn.raw = (sql) => ({ sql });
    return { conn, calls };
  }

  afterEach(() => { delete process.env.GATE_NOSHOW_DETECTOR; });

  // The durable fleet signal is the sweep's own cron health row: an enabled
  // replica stamps last_started_at every tick, including ticks that create
  // nothing — which is exactly what row-recency probes missed (round-22 P2).
  test('a recent sweep run defers the pass, without needing any new rows', async () => {
    const { conn, calls } = fakeConn({ sweepRan: { job_name: 'no-show-detector' } });
    expect(await cleanupAfterDisable(conn)).toMatchObject({ deferred: true });
    expect(calls.updated).toBe(0);
    expect(calls.probed).toEqual(['job_health']);
  });

  test('a tracking row created inside the grace window defers the whole pass', async () => {
    const { conn, calls } = fakeConn({ recentAlert: { id: 'a1' } });
    expect(await cleanupAfterDisable(conn)).toMatchObject({ resolved: 0, dismissed: 0, deferred: true });
    expect(calls.updated).toBe(0);
  });

  test('no recent activity -> the pass clears everything, whatever its age', async () => {
    const { conn, calls } = fakeConn();
    const result = await cleanupAfterDisable(conn);
    expect(result.deferred).toBeUndefined();
    expect(calls.updated).toBe(1);
  });

  test('the gate being ON is still the first thing checked', async () => {
    process.env.GATE_NOSHOW_DETECTOR = 'true';
    const { conn, calls } = fakeConn();
    expect(await cleanupAfterDisable(conn)).toMatchObject({ resolved: 0, dismissed: 0 });
    expect(calls.updated).toBe(0);
  });
});

describe('grouped stops are evaluated as one visit (round-10 P1)', () => {
  const { groupedStops, stopState, stopPromise } = require('../services/no-show-detector');
  // A service_visits row is ONE physical stop shared by N scheduled_services:
  // the reminder pipeline sends a single grouped text and links its evidence
  // to whichever member won the claim, and one En Route/Arrived advances
  // every member. Evaluating members independently read a sibling's evidence
  // as missing and could raise several cards for one truck visit.
  const a = { id: 'aaa', visit_id: 'stop-1', status: 'pending' };
  const b = { id: 'bbb', visit_id: 'stop-1', status: 'pending' };
  const solo = { id: 'ccc', visit_id: null, status: 'pending' };

  test('members of one stop collapse into a single candidate; ungrouped rows stand alone', () => {
    const stops = groupedStops([b, solo, a]);
    expect(stops).toHaveLength(2);
    const grouped = stops.find((g) => g.members.length > 1);
    // Representative = lowest member id, so the tracking key (and the
    // dispatch_alerts job_id it carries) is stable across sweeps even as the
    // reminder claim moves between members from tier to tier.
    expect(grouped.representative.id).toBe('aaa');
    expect(grouped.members.map((m) => m.id)).toEqual(['aaa', 'bbb']);
    expect(stops.find((g) => g.members.length === 1).representative.id).toBe('ccc');
  });

  test('stopState merges arrival evidence and settles on any member that left the live statuses', () => {
    const opts = { now: new Date('2026-09-10T12:00:00Z'), since: '2026-09-10T13:00:00Z' };
    expect(stopState([a, { ...b, arrived_at: '2026-09-10T09:50:00Z' }], opts).arrived_at).toBe('2026-09-10T09:50:00Z');
    expect(stopState([{ ...a, en_route_at: '2026-09-10T09:40:00Z' }, { ...b, en_route_at: '2026-09-10T09:30:00Z' }], opts).en_route_at)
      .toBe('2026-09-10T09:30:00Z');
    // A stale prior-day stamp on one member must not be offered ahead of a
    // valid one on another: evaluateNoShow would reject the stale value and
    // the stop would read as never departed (round-10 P1).
    expect(stopState([{ ...a, en_route_at: '2026-09-03T09:40:00Z' }, { ...b, en_route_at: '2026-09-10T09:30:00Z' }], opts).en_route_at)
      .toBe('2026-09-10T09:30:00Z');
    // ...and a stamp in the future is not evidence yet either.
    expect(stopState([{ ...a, arrived_at: '2026-09-10T23:00:00Z' }, { ...b, arrived_at: '2026-09-10T09:30:00Z' }], opts).arrived_at)
      .toBe('2026-09-10T09:30:00Z');
    expect(stopState([a, { ...b, status: 'completed' }], opts).status).toBe('completed');
    // The most ADVANCED live status wins, whichever member holds it: one
    // member on_site or en_route is evidence for the whole stop (round-14
    // P1) — on_site clears the card, en_route stops stage 1.
    expect(stopState([a, { ...b, status: 'on_site' }], opts).status).toBe('on_site');
    expect(stopState([{ ...a, status: 'en_route' }, b], opts).status).toBe('en_route');
    expect(stopState([a, { ...b, status: 'en_route' }], opts).status).toBe('en_route');
    // A CANCELLED sibling is not proof the truck attended: the customer may
    // still be waiting on the members that remain live (round-10 P1).
    expect(stopState([a, { ...b, status: 'cancelled' }], opts).status).toBe('pending');
    expect(stopState([{ ...a, status: 'cancelled' }, b], opts).status).toBe('pending');
    expect(stopState([{ ...a, status: 'skipped' }, { ...b, status: 'no_show' }], opts).status).toBe('skipped');
    // A single-row stop is passed through untouched.
    expect(stopState([solo], opts)).toBe(solo);
  });

  test('a GROUPED send supersedes every member\'s own confirmation', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    // A grouped reminder quotes ONE window for the whole stop, so it replaces
    // each member's older per-service confirmation — the earliest-window rule
    // applies only between confirmations that each speak for one service
    // (round-24 P1, second pass).
    const promises = new Map([
      ['aaa', [{ visit_id: 'aaa', start_at: '2026-09-10T09:00:00Z', communicated_at: '2026-09-08T12:00:00Z', source: 'message' }]],
      ['bbb', [{ visit_id: 'bbb', start_at: '2026-09-10T13:00:00Z', communicated_at: '2026-09-09T12:00:00Z', source: 'message', grouped: true }]],
    ]);
    expect(stopPromise([a, b], promises, now)).toMatchObject({ visit_id: 'bbb', start_at: '2026-09-10T13:00:00Z' });
  });

  test('a member confirmation older than the newest grouped send is gone', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    // The grouped send quoted one window for every member, so aaa's older
    // 09:00 confirmation no longer stands — even though ccc's own 11:00
    // confirmation came later and is not itself grouped (round-24 P1).
    const c = { id: 'ccc', visit_id: 'stop-1', status: 'pending' };
    const promises = new Map([
      ['aaa', [{ visit_id: 'aaa', start_at: '2026-09-10T09:00:00Z', communicated_at: '2026-09-08T12:00:00Z', source: 'message' }]],
      ['bbb', [{ visit_id: 'bbb', start_at: '2026-09-10T13:00:00Z', communicated_at: '2026-09-09T12:00:00Z', source: 'message', grouped: true }]],
      ['ccc', [{ visit_id: 'ccc', start_at: '2026-09-10T11:00:00Z', communicated_at: '2026-09-09T18:00:00Z', source: 'message' }]],
    ]);
    expect(stopPromise([a, b, c], promises, now)).toMatchObject({ visit_id: 'ccc', start_at: '2026-09-10T11:00:00Z' });
  });

  test('members with no replacement keep the grouped window after the claim owner gets a later notice', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    // The grouped send lives only in the claim owner's event list, and a
    // later per-service notice displaced it as that member's latest. Members
    // whose own confirmation it replaced, and who have had nothing since,
    // still hold it — so it must remain a candidate (round-24 P1).
    const promises = new Map([
      ['aaa', [{ visit_id: 'aaa', start_at: '2026-09-10T09:00:00Z', communicated_at: '2026-09-08T12:00:00Z', source: 'message' }]],
      ['bbb', [
        { visit_id: 'bbb', start_at: '2026-09-10T13:00:00Z', communicated_at: '2026-09-09T12:00:00Z', source: 'message', grouped: true },
        { visit_id: 'bbb', start_at: '2026-09-10T15:00:00Z', communicated_at: '2026-09-09T18:00:00Z', source: 'message' },
      ]],
    ]);
    // 13:00 (grouped, held by aaa) is earlier than bbb's own 15:00.
    expect(stopPromise([a, b], promises, now)).toMatchObject({ start_at: '2026-09-10T13:00:00Z', grouped: true });
    // ...but once EVERY member has been told something since, the grouped
    // window is fully superseded and must not linger as the stop's earliest.
    const allReplaced = new Map([...promises,
      ['aaa', [{ visit_id: 'aaa', start_at: '2026-09-10T16:00:00Z', communicated_at: '2026-09-09T20:00:00Z', source: 'message' }]]]);
    expect(stopPromise([a, b], allReplaced, now)).toMatchObject({ start_at: '2026-09-10T15:00:00Z' });
  });

  test('a cancelled member contributes no window of its own', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    // The customer is not expecting that service, so the stop must not be
    // held to its 09:00 — the live sibling's 13:00 is the window (round-25 P1).
    const promises = new Map([
      ['aaa', [{ visit_id: 'aaa', start_at: '2026-09-10T09:00:00Z', communicated_at: '2026-09-08T12:00:00Z', source: 'message' }]],
      ['bbb', [{ visit_id: 'bbb', start_at: '2026-09-10T13:00:00Z', communicated_at: '2026-09-09T12:00:00Z', source: 'message' }]],
    ]);
    expect(stopPromise([{ ...a, status: 'cancelled' }, b], promises, now))
      .toMatchObject({ visit_id: 'bbb', start_at: '2026-09-10T13:00:00Z' });
    // Live members are unaffected.
    expect(stopPromise([a, b], promises, now)).toMatchObject({ visit_id: 'aaa' });
    // ...and a GROUPED reminder owned by a member that has since been
    // cancelled is still the window its live siblings hold (round-25 P1).
    const groupedByCancelled = new Map([
      ['aaa', [{ visit_id: 'aaa', start_at: '2026-09-10T13:00:00Z', communicated_at: '2026-09-09T12:00:00Z', source: 'message', grouped: true }]],
      ['bbb', []],
    ]);
    expect(stopPromise([{ ...a, status: 'cancelled' }, b], groupedByCancelled, now))
      .toMatchObject({ start_at: '2026-09-10T13:00:00Z', grouped: true });
  });

  test('stopPromise takes the EARLIEST promised window across members, not the latest sent', () => {
    const now = new Date('2026-09-10T12:00:00Z');
    const promises = new Map([
      ['aaa', [{ visit_id: 'aaa', start_at: '2026-09-10T13:00:00Z', communicated_at: '2026-09-08T12:00:00Z', source: 'message' }]],
      ['bbb', [{ visit_id: 'bbb', start_at: '2026-09-10T09:00:00Z', communicated_at: '2026-09-09T12:00:00Z', source: 'message' }]],
    ]);
    // Staff can group already-confirmed appointments without sending
    // replacement copy, so each member still holds its own confirmation:
    // picking by recency let a later-sent 13:00 confirmation override a
    // sibling's still-standing 09:00 promise and delay both stages for a stop
    // the customer expects at 09:00 (round-24 P1).
    expect(stopPromise([a, b], promises, now)).toMatchObject({ visit_id: 'bbb' });
    const reversed = new Map([
      ['aaa', [{ visit_id: 'aaa', start_at: '2026-09-10T09:00:00Z', communicated_at: '2026-09-09T12:00:00Z', source: 'message' }]],
      ['bbb', [{ visit_id: 'bbb', start_at: '2026-09-10T13:00:00Z', communicated_at: '2026-09-09T18:00:00Z', source: 'message' }]],
    ]);
    expect(stopPromise([a, b], reversed, now)).toMatchObject({ visit_id: 'aaa' });
    // An UNKNOWN window still wins when it is the newest thing the customer
    // heard — the legacy move-notice rule.
    const superseded = new Map([...reversed,
      ['bbb', [{ visit_id: 'bbb', start_at: null, communicated_at: '2026-09-10T08:00:00Z', source: 'message' }]]]);
    expect(stopPromise([a, b], superseded, now)).toMatchObject({ visit_id: 'bbb', start_at: null });
    // A sibling with no evidence of its own inherits the stop's.
    expect(stopPromise([a, { id: 'zzz' }], promises, now)).toMatchObject({ visit_id: 'aaa' });
    expect(stopPromise([{ id: 'zzz' }], promises, now)).toBeNull();
  });
});

describe('lockedStop: creation and both reconcile passes see the same stop (round-10 P1)', () => {
  const { lockedStop } = require('../services/no-show-detector');
  // The per-card loop evaluated the whole stop while the reconcile passes
  // looked only at the representative row, so a grouped reminder owned by a
  // SIBLING read as "no promise" there: every tick created the alert and
  // notice and then immediately resolved and dismissed them, re-notifying
  // the tech every five minutes. One shared reader makes that impossible.
  const now = new Date('2026-09-10T15:30:00Z');
  const members = [
    { id: 'aaa', visit_id: 'stop-1', status: 'pending', scheduled_date: '2026-09-10', customer_id: 'cust-1', property_id: 'prop-1' },
    { id: 'bbb', visit_id: 'stop-1', status: 'pending', scheduled_date: '2026-09-10', customer_id: 'cust-1', property_id: 'prop-1' },
  ];
  // The grouped reminder's evidence is linked to the SIBLING, not the
  // representative the card and the alert are keyed on.
  const siblingEvidence = [{ id: 'm1', appointment_id: 'bbb', sent_at: '2026-09-09T12:00:00Z',
    metadata: { rendered_slot_ms: Date.parse('2026-09-10T13:00:00Z') } }];

  function fakeTrx(rows) {
    return (table) => {
      const chain = {};
      for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'forUpdate', 'orderBy']) {
        chain[m] = () => chain;
      }
      if (table === 'scheduled_services') {
        chain.where = (args) => {
          chain._members = args?.visit_id ? rows : rows.filter((r) => String(r.id) === String(args?.id));
          return chain;
        };
        chain.first = async () => chain._members[0];
        chain.select = async () => chain._members;
        return chain;
      }
      if (table === 'messaging_audit_log as a') { chain.select = () => Promise.resolve(siblingEvidence); return chain; }
      chain.select = () => Promise.resolve([]);
      return chain;
    };
  }

  test('a stop whose promise is linked to a sibling still evaluates as overdue', async () => {
    const trx = fakeTrx(members);
    trx.raw = (sql) => ({ sql });
    trx.isTransaction = true;
    const { visit, members: locked, promise, live } = await lockedStop(trx, 'aaa', { now });
    expect(visit.id).toBe('aaa');
    expect(locked.map((m) => m.id)).toEqual(['aaa', 'bbb']);
    // Evidence belongs to 'bbb'; the stop uses it for 'aaa' too.
    expect(promise).toMatchObject({ visit_id: 'bbb' });
    expect(live).toMatchObject({ stage: 2, evidence: 'missing_tracking' });
  });

  test('a stop whose representative moved on treats the old row\'s card as superseded', async () => {
    // The lowest-id member cancelled, so the stop's card belongs to the next
    // live member now. Reconciling the OLD row must clear its card rather
    // than leave two up for one stop (round-10 P1).
    const moved = [{ ...members[0], status: 'cancelled' }, members[1]];
    const trx = fakeTrx(moved);
    trx.raw = (sql) => ({ sql });
    trx.isTransaction = true;
    const stale = await lockedStop(trx, 'aaa', { now });
    expect(stale.representative.id).toBe('bbb');
    expect(stale.live).toBeNull();
    // ...and the new representative still evaluates as overdue.
    const current = await lockedStop(trx, 'bbb', { now });
    expect(current.live).toMatchObject({ stage: 2 });
  });

  // Evidence is read ONCE per sweep tick and handed to every lockedStop call:
  // re-reading it per row meant nine queries per card, each while holding the
  // stop's row locks (round-16 P2).
  test('pre-loaded evidence is used instead of re-reading it under the lock', async () => {
    let evidenceReads = 0;
    const trx = (table) => {
      const chain = {};
      for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'forUpdate', 'orderBy', 'distinct']) chain[m] = () => chain;
      if (table === 'scheduled_services') {
        chain.where = (args) => { chain._rows = args?.visit_id ? members : members.filter((r) => String(r.id) === String(args?.id)); return chain; };
        chain.first = async () => chain._rows[0];
        chain.select = async () => chain._rows;
        return chain;
      }
      chain.where = () => chain;
      chain.select = () => { evidenceReads += 1; return Promise.resolve([]); };
      return chain;
    };
    trx.raw = (sql) => ({ sql });
    trx.isTransaction = true;
    const preloaded = new Map([['bbb', [{ visit_id: 'bbb', start_at: '2026-09-10T13:00:00Z',
      communicated_at: '2026-09-09T12:00:00Z', source: 'message' }]]]);
    const { promise, live } = await lockedStop(trx, 'aaa', { now, promises: preloaded });
    expect(evidenceReads).toBe(0);
    expect(promise).toMatchObject({ visit_id: 'bbb' });
    expect(live).toMatchObject({ stage: 2 });
  });

  test('the push is re-checked after the card commits, and a manual dismissal clears the stamp', () => {
    const detector = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'no-show-detector.js'), 'utf8');
    // An arrival/completion/reassignment waiting on the row lock can commit
    // the moment this transaction releases it, and nothing retracts a push
    // (round-24 P2).
    // On a clock taken NOW, not the tick's: the check is about what is true
    // at the moment the push leaves (round-24 P1).
    expect(detector).toContain('if (notice && await stillOverdue(conn, notice, { now: new Date() })) await techNotices.pushTrackingNotice(notice);');
    expect(detector).toContain('async function stillOverdue(conn, notice, { now = new Date() } = {}) {');
    // And a tech's own dismissal clears any supersession stamp the sweep
    // wrote in the meantime, or the next cycle resurrects the card it cleared.
    const route = require('fs').readFileSync(require('path').join(__dirname, '..', 'routes', 'tech-notifications.js'), 'utf8');
    expect(route).toContain("payload: db.raw(\"COALESCE(payload, '{}'::jsonb) - 'superseded_at'\")");
  });

  test('a stop lock that cannot be taken skips the row, and never proceeds unlocked', async () => {
    const detector = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'no-show-detector.js'), 'utf8');
    // The lock is taken BEFORE any row lock — visit-groups' splitChild can
    // lock the higher-id child and wait for its sibling while an id-ordered
    // FOR UPDATE here does the reverse (round-22 P1) — and its failure is
    // propagated, not swallowed: continuing unlocked restores the inversion.
    expect(detector).toContain("await require('./visit-groups').lockStopForRow(trx, serviceId);");
    expect(detector).not.toContain('lockStopForRow(trx, serviceId).catch');
    expect(detector.indexOf('lockStopForRow(trx, serviceId)'))
      .toBeLessThan(detector.indexOf("const row = await trx('scheduled_services').where({ id: serviceId }).first();"));
    // Each row runs inside withRow, so one unlockable stop skips that row
    // instead of aborting the sweep.
    expect(detector).toContain('async function withRow(id, run) {');
    expect(detector).toContain('const notice = await withRow(card.id, () => conn.transaction(async (trx) => {');
  });

  test('a missing row yields nothing, not a throw', async () => {
    const trx = fakeTrx([]);
    trx.raw = (sql) => ({ sql });
    trx.isTransaction = true;
    expect(await lockedStop(trx, 'gone', { now })).toMatchObject({ visit: null, live: null });
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

  test('the handoff stamps the resolve as automatic, so a rollback is not suppressed by it', async () => {
    const { trx } = fakeAlertsTable([{ id: 'legacy-1', payload: {} }]);
    await resolveLegacyCollision(trx, { jobId: 'job-1', type: 'tech_late' });
    expect(resolveAlert).toHaveBeenCalledWith(expect.objectContaining({ id: 'legacy-1', auto: true }));
  });

  test('an unresolved legacy tech_late row (no payload.source) is resolved so the handover can insert', async () => {
    const legacyRow = { id: 'legacy-1', job_id: 'visit-1', type: 'tech_late', payload: { delay_minutes: 12 } };
    const { trx, where, whereNull, whereRaw } = fakeAlertsTable([legacyRow]);

    const count = await resolveLegacyCollision(trx, { jobId: 'visit-1', type: 'tech_late' });

    expect(where).toHaveBeenCalledWith({ job_id: 'visit-1', type: 'tech_late' });
    expect(whereNull).toHaveBeenCalledWith('resolved_at');
    expect(whereRaw.mock.calls[0][0]).toMatch(/payload->>'source'.*!=\s*'no_show_detector'/);
    expect(resolveAlert).toHaveBeenCalledTimes(1);
    expect(resolveAlert).toHaveBeenCalledWith({ id: 'legacy-1', trx, auto: true });
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
    expect(resolveAlert).toHaveBeenNthCalledWith(1, { id: 'legacy-1', trx, auto: true });
    expect(resolveAlert).toHaveBeenNthCalledWith(2, { id: 'legacy-2', trx, auto: true });
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
    for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct']) chain[m] = () => chain;
    chain.select = () => Promise.resolve(result);
    return chain;
  }

  function fakeConn() {
    const calls = {};
    const conn = (table) => {
      if (table === 'messaging_audit_log as a' || table === 'audit_log as al' || table === 'activity_log as al' || table === 'scheduled_services as sv' || table === 'email_messages' || table === 'email_messages as em' || table === 'series_moves as sm') return passthroughChain([]);
      if (table === 'customer_interactions as ci') {
        const chain = {};
        chain.leftJoin = (joinTable, cb) => { calls.leftJoinTable = joinTable; calls.leftJoinCb = cb; return chain; };
        chain.where = (...args) => { (calls.whereCalls ||= []).push(args); return chain; };
        chain.whereBetween = () => chain;
        chain.whereIn = () => chain;
        chain.whereNotNull = () => chain;
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
    // A GROUPED interaction's key is <event>:visit:<stop>:<effect>:<date>, so
    // it relinks through the stop AND the occurrence date the text quoted —
    // without the date, a reminder for the stop's next occurrence would
    // answer for this one's delivery state (round-13 P1).
    expect(joinSql).toContain("em.idempotency_key LIKE (ci.metadata->>'event_type') || ':visit:%'");
    expect(joinSql).toContain("AT TIME ZONE 'America/New_York', 'YYYY-MM-DD')");
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
    // ...and the key, which identifies a GROUPED send (`…:visit:<stop>:…`):
    // that copy speaks for every member of the stop, so it supersedes each
    // member's own confirmation (round-24 P1).
    expect(calls.selected).toContain('em.idempotency_key as em_key');

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
    for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct']) chain[m] = () => chain;
    chain.select = () => Promise.resolve(result);
    return chain;
  }
  function fakeConn() {
    const calls = {};
    const conn = (table) => {
      if (table === 'customer_interactions as ci' || table === 'audit_log as al' || table === 'activity_log as al' || table === 'scheduled_services as sv' || table === 'email_messages' || table === 'email_messages as em' || table === 'series_moves as sm') return passthroughChain([]);
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

describe('an appointment email with no interaction row still yields its promise (round-11 P1)', () => {
  // appointment-email.js's logEmailAttempt swallows a failed insert and the
  // send still reports success, and an idempotent retry writes no second
  // interaction — so an email-only customer could permanently lose the
  // window they were given. The durable email_messages row survives that,
  // and its idempotency_key encodes <event_type>:<visit>:<slot ms>.
  function fakeConn(rows) {
    const passthrough = () => {
      const chain = {};
      for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct']) chain[m] = () => chain;
      chain.select = () => Promise.resolve([]);
      return chain;
    };
    const captured = {};
    const conn = (table) => {
      if (table !== 'email_messages') return passthrough();
      const chain = {};
      chain.whereIn = (col, values) => { (captured.whereIn ||= []).push([col?.sql || col, values]); return chain; };
      for (const m of ['whereRaw', 'where', 'whereNotNull']) chain[m] = () => chain;
      chain.select = () => Promise.resolve(rows);
      return chain;
    };
    conn.raw = (sql) => ({ sql });
    conn.isTransaction = true;
    return { conn, captured };
  }

  test('a GROUPED reminder key (…:visit:<stop>:…) is recovered through the stop, as an unknown window', async () => {
    // appointment-reminders.js keys a grouped email by the visit-effect claim
    // — segment 2 is the literal 'visit', segment 3 the service_visits id,
    // and there is no slot epoch — so the per-service read cannot see it at
    // all. Unknown is the honest recovery: the key proves the customer was
    // told about this occurrence, not at what time (round-12 P1).
    const captured = {};
    const chain = {};
    for (const m of ['whereRaw', 'where', 'whereNotNull']) chain[m] = () => chain;
    chain.join = (table, cb) => {
      const onClause = { on: (arg) => { (captured.joins ||= []).push([table, arg.sql]); return onClause; } };
      if (typeof cb === 'function') cb.call(onClause); else (captured.joins ||= []).push([table, cb?.sql || cb]);
      return chain;
    };
    chain.whereIn = (col, values) => { (captured.whereIn ||= []).push([col?.sql || col, values]); return chain; };
    chain.select = (...args) => { captured.selected = args.map((a) => a?.sql || a); return Promise.resolve([{ id: 'em-9', sent_at: '2026-09-10T12:00:00.000Z', visit_id: 'visit-1', stop_id: 'stop-1', tier: 'appointment.reminder_72h', occurrence: '2026-09-10' }]); };
    const passthrough = () => {
      const other = {};
      for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where']) other[m] = () => other;
      other.select = () => Promise.resolve([]);
      return other;
    };
    const conn = (table) => (table === 'email_messages as em' ? chain : passthrough());
    conn.raw = (sql) => ({ sql });
    conn.isTransaction = true;

    const [promise] = await loadPromiseEvents(conn, ['visit-1']);
    const joins = Object.fromEntries(captured.joins.map(([table, sql]) => [table, sql]));
    // The key's OWN stop, and only that stop: stop_base_key was tried here to
    // follow a split, but it is (property|customer, date) — every other stop
    // at that property that day shares it (round-18 P2).
    expect(joins['service_visits as keyed']).toContain("keyed.id::text = split_part(em.idempotency_key, ':', 3)");
    expect(joins['service_visits as own']).toBeUndefined();
    expect(joins['scheduled_services as sv']).toContain('sv.visit_id = keyed.id');
    // The stop id is selected so the "already recovered" check can be
    // stop-wide: the interaction row is keyed to whichever member owned the
    // claim, and a sibling seeing none of its own would otherwise keep an
    // unknown window that outranks the owner's real one (round-12 P1).
    // The stop id comes from the KEY (the stop the reminder was sent for),
    // not from the row's current visit_id, which a split may have changed.
    expect(captured.selected).toContain('keyed.id as stop_id');
    // ...and bounded by the OCCURRENCE: the claim dedupe key ends in the
    // occurrence date, so a reminder for the stop's NEXT occurrence cannot
    // mint an unknown-window promise for today's visit (round-13 P1), while a
    // date in the visit's past still counts — the schedule may have moved
    // under it (round-16 P1).
    expect(joins['scheduled_services as sv']).toContain("split_part(em.idempotency_key, ':', 5) <= to_char(sv.scheduled_date, 'YYYY-MM-DD')");
    expect(promise).toMatchObject({ visit_id: 'visit-1', source: 'email', source_id: 'em-9', start_at: null,
      communicated_at: '2026-09-10T12:00:00.000Z' });
  });

  // One grouped reminder writes an email_messages row per RECIPIENT, and
  // logEmailAttempt can fail for a later one after an earlier one already
  // recorded the window. Measuring from the earliest row of the fan-out keeps
  // that known window; keying on the exact send time let the later row
  // survive as an unknown fallback and outrank it (round-17 P1).
  test('the grouped recovery matches a SEND by identity: visit, occurrence and tier', () => {
    const { reminderTier } = require('../services/no-show-detector');
    const detector = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'no-show-detector.js'), 'utf8');
    // Identity, not order: a `both`-channel reminder sends its SMS BEFORE the
    // email, so the known window is timestamped earlier than the fan-out it
    // covers and a time comparison could never see it (round-21 P1) — while
    // the 72h reminder must still not answer for the 24h send (round-17 P1).
    // GROUPED evidence only: a member's individual reminder from before it
    // was grouped can share the tier and occurrence with the later grouped
    // send, and counting it as proof discarded the grouped send's own
    // fallback (round-25 P2).
    expect(detector).toContain('const knownSends = new Set(noticeEvents');
    expect(detector).toContain('.filter((event) => event.grouped && event.visit_id && event.start_at != null && event.tier)');
    expect(detector).toContain('knownSends.has(`${memberId}:${r.occurrence}:${reminderTier(r.tier)}`)');
    // The tier for a TEXT comes from its purpose: the sender passes a generic
    // 'appointment_reminder' message type and names the rung in the purpose.
    expect(detector).toContain("'a.sent_at', 'a.purpose')");
    expect(detector).toContain('tier: reminderTier(r.purpose || r.metadata?.original_message_type)');
    // ...and one canonical name across the three spellings.
    expect(reminderTier('appointment_reminder_72h')).toBe(reminderTier('appointment.reminder_72h'));
    expect(reminderTier('appointment.reminder_24h')).not.toBe(reminderTier('appointment.reminder_72h'));
    expect(reminderTier('appointment_reminder')).not.toBe(reminderTier('appointment.reminder_24h'));
    expect(reminderTier('appointment.confirmation')).toBe('confirmation');
    expect(reminderTier(null)).toBeNull();
    // ...and the reprocessing guard reads a column the query actually selects.
    expect(detector).toContain("'cl.processing_token', 'cl.processing_generation',");
  });

  test('the recovery unit is one SEND — stop, tier, occurrence', () => {
    const detector = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'no-show-detector.js'), 'utf8');
    // So the 72h reminder's recovery does not cover the 24h send, a different
    // message the customer received later (round-17 P1).
    expect(detector).toContain("const sendKey = (r) => `${r.stop_id}:${r.tier}:${r.occurrence}`;");
    expect(detector).toContain('.map(sendKey));');
  });

  test('the window comes straight off the message row, scoped by the key\'s visit id and a delivered status', async () => {
    const slot = Date.parse('2026-09-12T13:00:00.000Z');
    const { conn, captured } = fakeConn([{ id: 'em-1', sent_at: '2026-09-10T12:00:00.000Z', visit_id: 'visit-1', slot_ms: String(slot) }]);
    const [promise] = await loadPromiseEvents(conn, ['visit-1']);
    expect(promise).toMatchObject({ visit_id: 'visit-1', source: 'email', source_id: 'em-1',
      start_at: new Date(slot).toISOString(), communicated_at: '2026-09-10T12:00:00.000Z' });
    const scoped = captured.whereIn.map(([col, values]) => [col, values]);
    expect(scoped).toEqual(expect.arrayContaining([
      ["split_part(idempotency_key, ':', 1)", ['appointment.confirmation', 'appointment.reminder_72h', 'appointment.reminder_24h']],
      ["split_part(idempotency_key, ':', 2)", ['visit-1']],
      ['status', ['sent', 'processed', 'delivered', 'complained', 'spam_report', 'unsubscribed']],
    ]));
  });
});

describe('the call-booking promise derives from the visit\'s own call link (round-10 P1)', () => {
  const flags = require('../services/call-triage-flags');
  function fakeConn(bookingRows) {
    const passthrough = () => {
      const chain = {};
      for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct']) chain[m] = () => chain;
      chain.select = () => Promise.resolve([]);
      return chain;
    };
    const conn = (table) => {
      if (table !== 'scheduled_services as sv') return passthrough();
      const chain = {};
      for (const m of ['join', 'whereIn', 'whereRaw', 'where', 'whereNull', 'whereNotNull']) chain[m] = () => chain;
      chain.select = () => Promise.resolve(bookingRows);
      return chain;
    };
    conn.raw = (sql) => ({ sql });
    conn.isTransaction = true;
    return conn;
  }
  const row = {
    visit_id: 'visit-1', call_id: 'call-1', transcription: 'Agent: We will see you Friday at one.\nCaller: Great.',
    ai_extraction_enriched: { meta: {}, scheduling: { agent_committed_booking: true, confirmed_start_at: '2026-09-12T13:00:00-04:00' } },
    call_created_at: '2026-09-10T14:00:00.000Z', duration_seconds: 300, processing_token: null,
    // A first-pass call with a valid extraction: the only shape whose window
    // this derivation asserts (round-22 P1).
    processing_generation: 1, v2_extraction_status: 'valid',
  };

  beforeEach(() => { process.env.GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS = 'true'; });
  afterEach(() => { delete process.env.GATE_CALL_AGENT_COMMIT_TRUSTED_LABELS; });

  test('the trusted-speaker check receives the CALL\'s start, not undefined', async () => {
    const spy = jest.spyOn(flags, 'hasAgentCommittedEvidence').mockReturnValue(true);
    const [promise] = await loadPromiseEvents(fakeConn([row]), ['visit-1']);
    expect(spy).toHaveBeenCalledWith(row.ai_extraction_enriched, row.transcription, row.call_created_at);
    // A REPROCESSED call keeps the promise, without its window — and without
    // consulting the extraction at all, so an invalidated one or a removed
    // commitment cannot erase it either (round-22 P1).
    for (const over of [{ processing_generation: 3 },
      { processing_generation: 3, v2_extraction_status: 'invalid' },
      { processing_generation: 3, ai_extraction_enriched: { meta: {}, scheduling: {} } }]) {
      const [reprocessed] = await loadPromiseEvents(fakeConn([{ ...row, ...over }]), ['visit-1']);
      expect(reprocessed).toMatchObject({ visit_id: 'visit-1', source: 'call', start_at: null });
    }
    // A FIRST-pass call whose extraction is not valid is no evidence at all.
    expect(await loadPromiseEvents(fakeConn([{ ...row, v2_extraction_status: 'invalid' }]), ['visit-1'])).toEqual([]);
    // A follow-up child the same call spawned carries source_call_log_id too
    // but has no confirmed time of its own — the primary's window must not be
    // mapped onto it (round-16 P1).
    const detector = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'no-show-detector.js'), 'utf8');
    expect(detector).toContain(".whereNull('sv.followup_source_service_id').whereNull('sv.parent_service_id')");
    // ...and the extraction must still predate the booking it produced: a
    // force-reprocess rewrites ai_extraction_enriched on the same row, and a
    // changed commitment would move or erase a promise the customer was given
    // at booking time with no new communication behind it (round-19 P1).
    // Past the first processing pass the window is no longer asserted — but
    // the promise is not dropped either, or a call-only booking would lose
    // its one piece of evidence to an ordinary recovery pass (round-19 P1,
    // round-21 P2).
    expect(detector).toContain('const firstPass = Number(r.processing_generation || 0) <= 1;');
    // The reprocessed branch returns BEFORE either mutable-extraction check,
    // so an invalidated extraction or a removed commitment cannot erase the
    // promise (round-22 P1).
    expect(detector.indexOf('if (!firstPass) {')).toBeLessThan(detector.indexOf("if (r.v2_extraction_status !== 'valid') return null;"));
    expect(detector).not.toContain('cl.updated_at <=');
    expect(promise).toMatchObject({ visit_id: 'visit-1', source: 'call', source_id: 'call-1',
      communicated_at: '2026-09-10T14:05:00.000Z' });
    spy.mockRestore();
  });

  test('a call still being processed, or one the trusted-labels rule rejects, yields no promise', async () => {
    const spy = jest.spyOn(flags, 'hasAgentCommittedEvidence').mockReturnValue(true);
    expect(await loadPromiseEvents(fakeConn([{ ...row, processing_token: 'tok' }]), ['visit-1'])).toEqual([]);
    spy.mockReturnValue(false);
    expect(await loadPromiseEvents(fakeConn([row]), ['visit-1'])).toEqual([]);
    spy.mockRestore();
  });
});

describe('the applied-reschedule promise is dated by the CALL, not the processing pass (round-9 P1)', () => {
  // call-reschedule-apply.js sends the customer nothing — the agent already
  // said it on the call — so this derived promise is the only record of that
  // window. The activity row is written when the recording pass ran, which
  // can be long after the call; dating the promise there lets a reminder
  // sent in between outrank a window the customer heard first.
  function fakeConn(activityRows) {
    const passthrough = () => {
      const chain = {};
      for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct']) chain[m] = () => chain;
      chain.select = () => Promise.resolve([]);
      return chain;
    };
    const conn = (table) => {
      if (table !== 'activity_log as al') return passthrough();
      const chain = {};
      for (const m of ['leftJoin', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'where']) chain[m] = () => chain;
      chain.select = () => Promise.resolve(activityRows);
      return chain;
    };
    conn.raw = (sql) => ({ sql });
    conn.isTransaction = true;
    return conn;
  }

  const row = {
    id: 'act-1', created_at: '2026-09-10T16:30:00.000Z',
    metadata: { call_log_id: 'call-1', scheduled_service_id: 'visit-1', to: { date: '2026-09-12', start: '13:00', end: '15:00' } },
    call_created_at: '2026-09-10T14:00:00.000Z', duration_seconds: 600,
  };

  test('communicated_at is the call end (start + duration), so a reminder sent after the call cannot outrank it', async () => {
    const [promise] = await loadPromiseEvents(fakeConn([row]), ['visit-1']);
    expect(promise).toMatchObject({ visit_id: 'visit-1', source: 'call', source_id: 'act-1',
      communicated_at: '2026-09-10T14:10:00.000Z' });
    expect(promise.start_at).toBe(new Date('2026-09-12T13:00:00-04:00').toISOString());
    // A reminder sent BEFORE the call still loses; the derived promise wins.
    const reminder = { visit_id: 'visit-1', start_at: '2026-09-11T13:00:00.000Z', communicated_at: '2026-09-10T14:05:00.000Z', source: 'message' };
    expect(latestPromises([reminder, promise], new Date('2026-09-10T18:00:00.000Z')).get('visit-1').source).toBe('call');
  });

  test('with the call gone (purged/legacy), it falls back to the activity row timestamp', async () => {
    const [promise] = await loadPromiseEvents(fakeConn([{ ...row, call_created_at: null, duration_seconds: null }]), ['visit-1']);
    expect(promise.communicated_at).toBe('2026-09-10T16:30:00.000Z');
  });

  test('an unparseable applied window becomes an UNKNOWN promise, not a guess', async () => {
    const [promise] = await loadPromiseEvents(fakeConn([{ ...row, metadata: { ...row.metadata, to: {} } }]), ['visit-1']);
    expect(promise.start_at).toBeNull();
  });
});

describe('recordSentWindowFallback (the audit row failed, the text went out) (round-9 P1)', () => {
  const { recordSentWindowFallback } = require('../services/no-show-detector');
  const { recordAuditEvent } = require('../services/audit-log');
  beforeEach(() => recordAuditEvent.mockClear());

  // persistAudit is best-effort: if its insert fails AFTER the provider
  // accepted the text, the customer holds a window nothing records, the
  // reminder is marked sent and never retried, and the detector later reads
  // an OLDER window as the latest promise — a critical alert against a slot
  // the customer was already moved off.
  test('lands the promised window in the durable ledger this file already reads', async () => {
    const startAtMs = Date.parse('2026-09-11T13:00:00.000Z');
    expect(await recordSentWindowFallback({ visitId: 'visit-1', startAtMs, communicatedAt: '2026-09-10T12:00:00.000Z' })).toBe(true);
    const [[event]] = recordAuditEvent.mock.calls;
    expect(event).toMatchObject({ action: 'visit_window_promised', resource_type: 'scheduled_service', resource_id: 'visit-1', critical: true });
    expect(event.metadata.series_move_id).toBeUndefined();
    expect(event.metadata).toMatchObject({ start_at: '2026-09-11T13:00:00.000Z', communicated_at: '2026-09-10T12:00:00.000Z',
      fallback_reason: 'messaging_audit_unavailable' });
  });

  // A series confirmation also proves every sibling the move touched was
  // superseded — proof that normally lives on the audit row this fallback
  // exists because we could not write (round-14 P1).
  test('a series confirmation stamps the move id, and the sibling derivation accepts that proof', async () => {
    await recordSentWindowFallback({ visitId: 'visit-1', startAtMs: Date.now(), seriesMoveId: 'move-7' });
    const [[event]] = recordAuditEvent.mock.calls;
    expect(event.metadata.series_move_id).toBe('move-7');
    const detector = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'no-show-detector.js'), 'utf8');
    expect(detector).toContain("fb.action = 'visit_window_promised'");
    expect(detector).toContain("AND fb.metadata->>'series_move_id' = sm.id::text");
    const sender = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'messaging', 'send-customer-message.js'), 'utf8');
    // ...and only for the series confirmation: the placement confirmation
    // carries the same move id but supersedes nothing (round-14 P1).
    expect(sender).toContain("sendInput.metadata?.original_message_type === 'reschedule_series_confirmation'");
    // The fallback proof is held to the same delivery bar as the audit row.
    expect(detector).toContain("fbs.twilio_sid");
    expect(detector).toContain("orWhereIn('fbs.status', DELIVERED_SMS_STATUSES)");
  });

  test('a send with no visit or no rendered slot writes nothing', async () => {
    expect(await recordSentWindowFallback({ visitId: null, startAtMs: 1 })).toBe(false);
    expect(await recordSentWindowFallback({ visitId: 'visit-1', startAtMs: null })).toBe(false);
    expect(await recordSentWindowFallback({ visitId: 'visit-1', startAtMs: 1, communicatedAt: 'not a date' })).toBe(false);
    expect(recordAuditEvent).not.toHaveBeenCalled();
  });

  // A date-only series move quotes no arrival range, so there is no window to
  // record — but refusing to write anything lost both the anchor's
  // unknown-window promise and the siblings' supersession proof, leaving
  // every one of those visits on its older window (round-15 P1).
  test('a WINDOWLESS series confirmation still records the supersession proof', async () => {
    expect(await recordSentWindowFallback({ visitId: 'visit-1', startAtMs: null, seriesMoveId: 'move-7' })).toBe(true);
    const [[event]] = recordAuditEvent.mock.calls;
    expect(event.metadata).toMatchObject({ start_at: null, series_move_id: 'move-7' });
    // The sender allows that path only for the series confirmation.
    const sender = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'messaging', 'send-customer-message.js'), 'utf8');
    expect(sender).toContain('if (!knownSlot && !seriesMoveId) return;');
    // Stop-wide copy keeps that identity in the fallback, or the siblings
    // stay on their pre-move windows (round-26 P1).
    expect(sender).toContain('stopWide: !!sendInput.metadata?.notificationEventKey,');
  });

  test('it never throws into the send path', async () => {
    recordAuditEvent.mockRejectedValueOnce(new Error('ledger down'));
    expect(await recordSentWindowFallback({ visitId: 'visit-1', startAtMs: Date.now() })).toBe(false);
  });

  // The sender calls it on exactly the path that loses the promise.
  test('the carrier\'s later verdict still governs a fallback row', async () => {
    // The row carries the sid it was accepted under, so the audit_log read
    // left-joins sms_log on it and drops the promise if that message is now
    // undelivered/failed/blocked — the same live-delivery discipline an
    // ordinary audit row gets. A call-evidence row carries no sid.
    let joined = null;
    const captured = [];
    const chain = {};
    for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull']) chain[m] = () => chain;
    chain.leftJoin = (table, col, raw) => { joined = { table, col, raw: raw?.sql }; return chain; };
    chain.where = (...args) => { captured.push(args); return chain; };
    chain.select = () => Promise.resolve([]);
    const conn = (table) => {
      if (table !== 'audit_log as al') { const other = {}; for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where']) other[m] = () => other; other.select = () => Promise.resolve([]); return other; }
      return chain;
    };
    conn.raw = (sql) => ({ sql });
    conn.isTransaction = true;
    await loadPromiseEvents(conn, ['visit-1']);
    expect(joined).toMatchObject({ table: 'sms_log as fs', col: 'fs.twilio_sid' });
    expect(joined.raw).toContain("al.metadata->>'provider_sid'");
    const grouped = captured.find(([arg]) => typeof arg === 'function');
    const seen = [];
    const qb = {};
    for (const m of ['whereRaw', 'orWhereNull', 'orWhereIn']) qb[m] = (...args) => { seen.push([m, ...args]); return qb; };
    grouped[0](qb);
    // The same allowlist the messaging read applies: a linked row still at
    // queued/scheduled/sending has not reached the phone, and counting it
    // would make a fallback promise stronger than an ordinary one (round-10
    // P1).
    expect(seen).toEqual([
      ['whereRaw', "al.metadata->>'provider_sid' IS NULL"],
      ['orWhereNull', 'fs.id'],
      ['orWhereIn', 'fs.status', ['sent', 'delivered', 'read']],
    ]);
  });

  test('send-customer-message calls it when the audit row could not be written', () => {
    const sender = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'messaging', 'send-customer-message.js'), 'utf8');
    expect(sender).toContain('await recordPromiseEvidenceFallback(sendInput, providerOutcome, audit);');
    expect(sender).toContain('if (audit.id || !sendInput.appointmentId) return;');
    // ...and only for a send that actually reached someone: a real Twilio
    // SM/MM sid or a proven push, never a success-shaped sentinel.
    expect(sender).toContain("/^(SM|MM)[a-f0-9]{32}$/i.test(providerSid)");
    expect(sender).toContain("providerOutcome.provider === 'push' && providerOutcome.deliveryOutcome === 'accepted'");
    expect(sender).toContain("require('../no-show-detector').recordSentWindowFallback(");
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
  // A portal OUTBOUND call inserts call_log before Twilio rings anyone, so
  // talk time alone omits setup and ringing. The status callback's
  // updated_at is the closest stored terminal stamp, trusted up to a bounded
  // ringing allowance past the talk time — later processing writes move it
  // too (round-10 P2).
  test('an outbound call is measured from its recorded bridge, and the result never drifts', () => {
    const created = '2026-09-10T10:00:00Z';
    // bridged_at is when the two legs were actually connected — the same
    // convention call-commitments.js's callEndedAt uses — so the end is
    // bridge + talk time, measured rather than guessed (round-11 P2).
    expect(callCommitmentInstant({ created_at: created, duration_seconds: 600, direction: 'outbound-api',
      bridged_at: '2026-09-10T10:01:30Z' }).toISOString()).toBe('2026-09-10T10:11:30.000Z');
    // Inbound with no bridge: created_at + duration.
    expect(callCommitmentInstant({ created_at: created, duration_seconds: 600, direction: 'inbound' }).toISOString())
      .toBe('2026-09-10T10:10:00.000Z');
    // OUTBOUND with no bridge is a recovered row, inserted near the END of
    // the call — adding the duration would push the commitment past the call
    // itself, so created_at stands (call-commitments.js's callEndedAt
    // convention, round-14 P2).
    expect(callCommitmentInstant({ created_at: created, duration_seconds: 600, direction: 'outbound-api' }).toISOString())
      .toBe('2026-09-10T10:00:00.000Z');
    // A bridge stamp from before the row was created is ignored (this row has
    // no direction, so it keeps the created_at + duration reading).
    expect(callCommitmentInstant({ created_at: created, duration_seconds: 600, bridged_at: '2026-09-10T09:00:00Z' }).toISOString())
      .toBe('2026-09-10T10:10:00.000Z');
    // Deterministic: updated_at is NOT consulted, so later processing writes
    // cannot advance a promise after the fact and leapfrog a reminder that
    // really was newer (round-10 P1).
    expect(callCommitmentInstant({ created_at: created, duration_seconds: 600, updated_at: '2026-09-10T18:00:00Z' }).toISOString())
      .toBe('2026-09-10T10:10:00.000Z');
    // A row written AFTER the call ended (a recovery/ingest path) would
    // otherwise land past the real end; each caller passes the row its own
    // processing pass wrote, which is at or after the call ended (round-10
    // P1).
    expect(callCommitmentInstant({ created_at: created, duration_seconds: 600, direction: 'outbound-api',
      bridged_at: '2026-09-10T10:01:00Z' }, { notAfter: '2026-09-10T10:02:00Z' }).toISOString())
      .toBe('2026-09-10T10:02:00.000Z');
    expect(callCommitmentInstant({ created_at: created, duration_seconds: 600 },
      { notAfter: '2026-09-10T23:00:00Z' }).toISOString()).toBe('2026-09-10T10:10:00.000Z');
    // An anchor from BEFORE the call is ignored: source_call_log_id can be
    // attached to a visit that already existed, and clamping to its creation
    // time would drag the promise back before it was spoken (round-10 P1).
    expect(callCommitmentInstant({ created_at: created, duration_seconds: 600 },
      { notAfter: '2026-08-01T00:00:00Z' }).toISOString()).toBe('2026-09-10T10:10:00.000Z');
  });
  test('the reported duration wins over the recording, and no usable duration falls back to the call start', () => {
    expect(callCommitmentInstant({ created_at: '2026-09-10T10:00:00Z', recording_duration_seconds: 5, duration_seconds: 60 }).toISOString())
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
  test('only a text that ANNOUNCES a move can supersede — the placement confirmation cannot (round-9 P1)', async () => {
    // A customer self-service placement move sends
    // appointment_recurring_placement_confirmed, whose seeded copy says
    // existing commitments stay as they are until staff review. Treating it
    // as a supersession would drop a sibling's still-standing confirmation
    // and leave a visit the customer expects with no alert at all.
    let joinSql = null;
    const chain = {};
    for (const m of ['leftJoin', 'whereIn', 'whereRaw', 'whereNull', 'whereNotNull', 'where']) chain[m] = () => chain;
    chain.join = (table, cb) => {
      // The series read joins with a callback; the booking read joins on
      // plain columns — only the callback form carries the predicate here.
      if (typeof cb !== 'function') return chain;
      const onClause = { on: (arg) => { joinSql = arg.sql; return onClause; } };
      cb.call(onClause);
      return chain;
    };
    chain.select = () => Promise.resolve([]);
    const conn = () => chain;
    conn.raw = (sql) => ({ sql });
    conn.isTransaction = true;
    await loadPromiseEvents(conn, ['visit-1']);
    // The message-type allowlist gates BOTH branches (the id match and the
    // legacy anchor-notice fallback), so no other message type can qualify.
    // Exactly ONE message type qualifies. Quick Move's rain_out_moved* text
    // describes the anchor only (admin-dispatch keeps the siblings'
    // reminders open for that reason), and the placement confirmation says
    // later commitments stand until staff review (round-12 P1).
    expect(joinSql).toContain("a.metadata->>'original_message_type' = 'reschedule_series_confirmation'");
    expect(joinSql).not.toContain('rain_out_moved');
    expect(joinSql).not.toContain('appointment_recurring_placement_confirmed');
    expect(joinSql).toContain("a.metadata->>'series_move_id' = sm.id::text");
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
    for (const m of ['join', 'leftJoin', 'whereIn', 'whereRaw', 'whereBetween', 'whereNull', 'whereNotNull', 'where', 'distinct']) chain[m] = () => chain;
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
      if (table === 'customer_interactions as ci' || table === 'audit_log as al' || table === 'activity_log as al' || table === 'scheduled_services as sv' || table === 'email_messages' || table === 'email_messages as em' || table === 'series_moves as sm') return passthroughChain([]);
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
      if (table === 'customer_interactions as ci' || table === 'audit_log as al' || table === 'activity_log as al' || table === 'scheduled_services as sv' || table === 'email_messages' || table === 'email_messages as em' || table === 'series_moves as sm') return passthroughChain([]);
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
