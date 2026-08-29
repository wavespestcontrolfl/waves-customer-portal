/**
 * fanOutLiveTransition — one En Route / Arrived signal moves the whole stop
 * (visit-group-scope.md §3), from INSIDE the canonical tracker path. Fake
 * db: each table answers from a script; the shared status writer and the
 * tracker writers are mocked so the contract under test is the fan-out.
 */
jest.mock('../models/db', () => {
  const calls = [];
  function makeChain(table, script, log) {
    const chain = {
      _ops: [],
      where() { chain._ops.push(['where', ...arguments]); return chain; },
      whereIn() { chain._ops.push(['whereIn', ...arguments]); return chain; },
      whereNot() { chain._ops.push(['whereNot', ...arguments]); return chain; },
      whereNotIn() { chain._ops.push(['whereNotIn', ...arguments]); return chain; },
      whereNull() { chain._ops.push(['whereNull', ...arguments]); return chain; },
      forUpdate() { chain._ops.push(['forUpdate']); return chain; },
      first(...cols) { log.push({ table, op: 'first', ops: chain._ops, cols }); return Promise.resolve(script[table] && script[table].first ? script[table].first(chain._ops) : null); },
      select(...cols) { log.push({ table, op: 'select', ops: chain._ops, cols }); return Promise.resolve(script[table] && script[table].select ? script[table].select(chain._ops) : []); },
      update(values) { log.push({ table, op: 'update', ops: chain._ops, values }); return Promise.resolve(1); },
      insert(values) { chain._insert = values; log.push({ table, op: 'insert', values }); return chain; },
      onConflict() { chain._ops.push(['onConflict', ...arguments]); return chain; },
      merge(values) { chain._merge = values; log.push({ table, op: 'merge', values }); return chain; },
      ignore() { return chain; },
      returning() { log.push({ table, op: 'returning', values: chain._insert }); return Promise.resolve(script[table] && script[table].returning ? script[table].returning() : []); },
      then(res, rej) { return Promise.resolve([]).then(res, rej); },
    };
    return chain;
  }
  const db = jest.fn((table) => makeChain(table, db.__script, calls));
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.__calls = calls;
  db.__script = {};
  db.__rawCalls = [];
  db.transaction = jest.fn(async (fn) => {
    const trx = jest.fn((table) => makeChain(table, db.__script, calls));
    trx.raw = jest.fn(async (...a) => { db.__rawCalls.push(a); return { rows: [] }; });
    trx.isTransaction = true;
    return fn(trx);
  });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/track-transitions', () => ({
  markEnRoute: jest.fn().mockResolvedValue({ ok: true }),
  markOnProperty: jest.fn().mockResolvedValue({ ok: true }),
}));

const db = require('../models/db');
const logger = require('../services/logger');
const { transitionJobStatus } = require('../services/job-status');
const trackTransitions = require('../services/track-transitions');
const { fanOutLiveTransition, claimVisitNotification, finalizeVisitNotification } = require('../services/visit-groups');

const PRIMARY = { id: 'p', visit_id: 'v1', technician_id: 't1', status: 'en_route' };
const lockedPrimary = (over = {}) => () => ({ id: 'p', visit_id: 'v1', technician_id: 't1', status: 'en_route', window_start: '09:00', window_end: '10:00', ...over });
const VISIT = { id: 'v1', status: 'open', stop_base_key: 'p1:2026-08-30', scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1' };

beforeEach(() => { db.__calls.length = 0; db.__rawCalls.length = 0; db.__script = {}; jest.clearAllMocks(); });

describe('fanOutLiveTransition', () => {
  test('ungrouped primary: no transaction, no query', async () => {
    const out = await fanOutLiveTransition({ primary: { id: 'p', visit_id: null }, kind: 'en_route' });
    expect(out).toBe(null);
    expect(db.transaction).not.toHaveBeenCalled();
    expect(db).not.toHaveBeenCalled();
  });

  test('moves eligible exact-tech siblings via the shared writer under the stop lock; skips the rest; stamps the visit', async () => {
    db.__script = {
      service_visits: { first: () => VISIT },
      scheduled_services: {
        first: lockedPrimary(),
        select: () => [
          { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's1', status: 'confirmed', technician_id: 't1', track_state: 'scheduled' },
          { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's2', status: 'on_site', technician_id: 't1', track_state: 'on_property' },   // not eligible for en_route
          { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's3', status: 'pending', technician_id: 't2', track_state: 'scheduled' },     // other tech
          { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's4', status: 'pending', technician_id: null, track_state: 'scheduled' },     // UNASSIGNED ≠ wildcard (codex r1)
          { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's5', status: 'en_route', technician_id: 't1', track_state: 'scheduled' },    // status there, tracker lagging
          { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's6', status: 'pending', technician_id: 't1', track_state: 'scheduled', source_action: 'ai_call_outbound_review', customer_confirmed: false }, // office review
        ],
      },
    };
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route', actorType: 'tech', actorId: 't1', smsOutcome: 'sent', notificationOwner: true });
    expect(out.ok).toBe(true);
    expect(out.visitId).toBe('v1');
    expect(out.siblingIds).toEqual(['s1']);
    expect(out.trackerIds).toEqual(['s1', 's5']);
    expect(out.skipped.map((x) => `${x.id}:${x.reason}`)).toEqual(['s2:status:on_site', 's3:technician', 's4:technician', 's6:office_review']);
    expect(transitionJobStatus).toHaveBeenCalledTimes(1);
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({ jobId: 's1', fromStatus: 'confirmed', toStatus: 'en_route', transitionedBy: 't1' }));
    expect(db.__rawCalls[0][1]).toEqual(['visit.stop', 'p1:2026-08-30']);
    const stamp = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update');
    expect(stamp.values).toHaveProperty('en_route_at');
    expect(stamp.ops).toEqual(expect.arrayContaining([['whereNull', 'en_route_at']]));
    // siblings' trackers written with the customer text suppressed, marked as siblings
    expect(trackTransitions.markEnRoute).toHaveBeenCalledTimes(2);
    expect(trackTransitions.markEnRoute).toHaveBeenCalledWith('s5', expect.objectContaining({ suppressCustomerSms: true, _visitSibling: true }));
    // covered stamps on every reconciled sibling
    const covered = db.__calls.find((c) => c.table === 'scheduled_services' && c.op === 'update' && c.values.track_sms_sent_at);
    // fenced to THIS visit attempt: visit id, date, target tracker state, guard null
    expect(covered.ops).toEqual(expect.arrayContaining([
      ['whereIn', 'id', ['s1', 's5']], ['where', { visit_id: 'v1' }], ['where', 'scheduled_date', '2026-08-30'],
      ['where', 'track_state', 'en_route'], ['whereNull', 'track_sms_sent_at'],
    ]));
    const effect = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'insert');
    expect(effect.values).toMatchObject({ visit_id: 'v1', effect_type: 'tracker_en_route', dedupe_key: 'v1:tracker_en_route', status: 'sent' });
    // upsert: a later delivered attempt advances a non-sent row; never downgrades a sent one
    const merge = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'merge');
    expect(merge.values).toMatchObject({ status: 'sent', attempts: { sql: '?? + 1' } });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('s6=office_review'));
  });

  test('on_site: arrival lifecycle written per moved sibling; effect status follows the primary send outcome', async () => {
    db.__script = {
      service_visits: { first: () => VISIT },
      scheduled_services: { first: lockedPrimary({ status: 'on_site' }), select: () => [{ scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's1', status: 'en_route', technician_id: 't1', track_state: 'en_route' }] },
    };
    const out = await fanOutLiveTransition({ primary: { ...PRIMARY, status: 'on_site' }, kind: 'on_site', actorId: 't1', smsOutcome: 'gate_off', notificationOwner: true });
    expect(out.siblingIds).toEqual(['s1']);
    const lifecycle = db.__calls.find((c) => c.table === 'scheduled_services' && c.op === 'update' && c.values.arrived_at);
    expect(lifecycle.values).toMatchObject({ arrived_at: expect.any(Date), check_in_time: expect.any(Date), actual_start_time: expect.any(Date) });
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('s1', expect.objectContaining({ suppressArrivalSms: true, _visitSibling: true, actingTechId: 't1' }));
    const effect = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'insert');
    expect(effect.values).toMatchObject({ effect_type: 'tracker_arrived', status: 'suppressed', sent_at: null });
    expect(out.effect).toEqual({ effectType: 'tracker_arrived', status: 'suppressed' });
  });

  test.each([['retry', 'failed'], ['suppressed', 'suppressed'], ['sent', 'sent']])('smsOutcome %s → effect %s', async (outcome, status) => {
    db.__script = { service_visits: { first: () => VISIT }, scheduled_services: { first: lockedPrimary(), select: () => [] } };
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route', smsOutcome: outcome, notificationOwner: true });
    expect(out.effect.status).toBe(status);
  });

  test('a visit that is not open never fans out', async () => {
    db.__script = { service_visits: { first: () => ({ ...VISIT, status: 'closing' }) }, scheduled_services: { select: () => [{ scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's1', status: 'pending', technician_id: 't1' }] } };
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route' });
    expect(out).toBe(null);
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('a failure inside the fan-out transaction is SURFACED as ok:false (the primary transition stands; next signal repairs)', async () => {
    db.__script = { service_visits: { first: () => { throw new Error('boom'); } } };
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route' });
    expect(out).toMatchObject({ ok: false, visitId: 'v1', reason: 'boom', siblingIds: [] });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('boom'));
  });

  test('non-owner / non-attempt outcomes never touch the effect ledger (a recorded failure stays visible)', async () => {
    db.__script = { service_visits: { first: () => VISIT }, scheduled_services: { first: lockedPrimary(), select: () => [] } };
    for (const [outcome, owner] of [['already_handled', true], ['covered', false], ['sent', false], ['claim_error', false]]) {
      db.__calls.length = 0;
      const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route', smsOutcome: outcome, notificationOwner: owner });
      expect(out.ok).toBe(true);
      expect(out.effect).toBe(null);
      expect(db.__calls.some((c) => c.table === 'visit_effects')).toBe(false);
    }
  });

  test('a covered-stamp write failure is surfaced as ok:false', async () => {
    db.__script = {
      service_visits: { first: () => VISIT },
      scheduled_services: { first: lockedPrimary(), select: () => [{ scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's1', status: 'en_route', technician_id: 't1', track_state: 'en_route' }] },
    };
    const origDb = db.getMockImplementation();
    db.mockImplementation((table) => {
      const chain = origDb(table);
      if (table === 'scheduled_services') { const u = chain.update; chain.update = (v) => (v.track_sms_sent_at ? Promise.reject(new Error('stamp boom')) : u(v)); }
      return chain;
    });
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route', smsOutcome: 'sent', notificationOwner: true });
    db.mockImplementation(origDb);
    expect(out.ok).toBe(false);
    expect(out.trackerFailures).toEqual([{ id: 'covered_stamp', reason: 'stamp boom' }]);
  });

  test('a sibling tracker write failure after the status commit is SURFACED as ok:false with the failures listed', async () => {
    db.__script = {
      service_visits: { first: () => VISIT },
      scheduled_services: { first: lockedPrimary(), select: () => [
        { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's1', status: 'en_route', technician_id: 't1', track_state: 'scheduled' },
        { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's2', status: 'en_route', technician_id: 't1', track_state: 'scheduled' },
      ] },
    };
    trackTransitions.markEnRoute.mockResolvedValueOnce({ ok: false, reason: 'concurrent_update' }).mockRejectedValueOnce(new Error('pool timeout'));
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route', smsOutcome: 'sent' });
    expect(out.ok).toBe(false);
    expect(out.trackerFailures).toEqual([{ id: 's1', reason: 'concurrent_update' }, { id: 's2', reason: 'pool timeout' }]);
    expect(out.reason).toContain('s2: pool timeout');
  });

  test('on_site siblings carry the audit actor separately from the acting tech', async () => {
    db.__script = {
      service_visits: { first: () => VISIT },
      scheduled_services: { first: lockedPrimary({ status: 'on_site' }), select: () => [{ scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's1', status: 'on_site', technician_id: 't1', track_state: 'en_route' }] },
    };
    await fanOutLiveTransition({ primary: { ...PRIMARY, status: 'on_site' }, kind: 'on_site', actorType: 'admin', actorId: 'admin-1' });
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('s1', expect.objectContaining({ actorType: 'admin', actorId: 'admin-1', _visitSibling: true }));
  });

  test('the stop is the primary\'s CONNECTED COMPONENT: a 09-10 · 10-11 · 11-12 chain all follows the 09-10 tap', async () => {
    db.__script = {
      service_visits: { first: () => VISIT },
      scheduled_services: { first: lockedPrimary(), select: () => [
        { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's1', status: 'confirmed', technician_id: 't1', track_state: 'scheduled', window_start: '11:00', window_end: '12:00' },
        { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's2', status: 'confirmed', technician_id: 't1', track_state: 'scheduled', window_start: '10:00', window_end: '11:00' },
        { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's3', status: 'confirmed', technician_id: 't1', track_state: 'scheduled', window_start: '14:00', window_end: '15:00' },
      ] },
    };
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route' });
    expect(out.siblingIds.sort()).toEqual(['s1', 's2']);
    expect(out.skipped).toEqual([{ id: 's3', reason: 'stop_changed' }]);
  });

  test('a sibling whose stop tuple changed (reschedule committed, detach seam not yet run) is skipped', async () => {
    db.__script = {
      service_visits: { first: () => VISIT },
      scheduled_services: { first: lockedPrimary(), select: () => [
        { scheduled_date: '2026-09-02', customer_id: 'c1', property_id: 'p1', id: 's1', status: 'confirmed', technician_id: 't1', track_state: 'scheduled' },
        { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p9', id: 's2', status: 'confirmed', technician_id: 't1', track_state: 'scheduled' },
        { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's3', status: 'confirmed', technician_id: 't1', track_state: 'scheduled', window_start: '14:00', window_end: '15:00' },
        { scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's4', status: 'rescheduled', technician_id: 't1', track_state: 'scheduled' },
      ] },
    };
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route' });
    expect(out.siblingIds).toEqual([]);
    // s3: same-day window moved off the primary's 09-10 (r7); s4: withdrawn placeholder never advanced
    expect(out.skipped.map((x) => x.reason)).toEqual(['stop_changed', 'stop_changed', 'stop_changed', 'status:rescheduled']);
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });

  test('a primary whose operational status lags the tracker is reported incomplete, not benign', async () => {
    db.__script = { service_visits: { first: () => VISIT }, scheduled_services: { first: lockedPrimary({ status: 'confirmed' }), select: () => [] } };
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route' });
    expect(out).toMatchObject({ ok: false, reason: 'primary_status_lagging', visitId: 'v1' });
  });

  test.each([
    ['detached (split committed under the lock)', { visit_id: 'v2' }],
    ['reassigned technician', { technician_id: 't9' }],
  ])('primary revalidated under the stop lock — %s ⇒ no fan-out', async (_label, over) => {
    db.__script = {
      service_visits: { first: () => VISIT },
      scheduled_services: { first: lockedPrimary(over), select: () => [{ scheduled_date: '2026-08-30', customer_id: 'c1', property_id: 'p1', id: 's1', status: 'confirmed', technician_id: 't1', track_state: 'scheduled' }] },
    };
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route' });
    expect(out).toBe(null);
    expect(transitionJobStatus).not.toHaveBeenCalled();
    expect(trackTransitions.markEnRoute).not.toHaveBeenCalled();
    const lockRead = db.__calls.find((c) => c.table === 'scheduled_services' && c.op === 'first');
    expect(lockRead.ops).toEqual(expect.arrayContaining([['forUpdate']]));
  });
});

describe('claimVisitNotification (visit-scoped at-most-once claim, under the stop lock)', () => {
  const ROW = { id: 'p', visit_id: 'v1' };
  test('first claimant owns the send; a concurrent member sees taken; the stop lock is held', async () => {
    db.__script = { service_visits: { first: () => VISIT }, scheduled_services: { first: () => ({ id: 'p', visit_id: 'v1' }) }, visit_effects: { returning: () => [{ id: 'e1' }] } };
    expect(await claimVisitNotification(ROW, 'en_route')).toBe('owner');
    expect(db.__rawCalls[0][1]).toEqual(['visit.stop', 'p1:2026-08-30']);
    const ins = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'insert');
    expect(ins.values).toMatchObject({ visit_id: 'v1', effect_type: 'tracker_en_route', dedupe_key: 'v1:tracker_en_route', status: 'claimed', attempts: 0 });
    // a `failed` row is RECLAIMED (the retry); sent/suppressed/claimed are taken
    const merge = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'merge');
    expect(merge.values).toMatchObject({ status: 'claimed' });
    // no row won: a terminal (sent/suppressed) row ⇒ taken; a LIVE claimed row ⇒ in_flight (lease, r8)
    db.__script.visit_effects = { returning: () => [], first: () => ({ status: 'sent' }) };
    expect(await claimVisitNotification(ROW, 'on_site')).toBe('taken');
    db.__script.visit_effects = { returning: () => [], first: () => ({ status: 'claimed' }) };
    expect(await claimVisitNotification(ROW, 'on_site')).toBe('in_flight');
  });
  test('a row a split just detached (or a visit no longer open) never claims', async () => {
    db.__script = { service_visits: { first: () => VISIT }, scheduled_services: { first: () => ({ id: 'p', visit_id: 'v2' }) }, visit_effects: { returning: () => [{ id: 'e1' }] } };
    expect(await claimVisitNotification(ROW, 'en_route')).toBe('detached');
    expect(db.__calls.some((c) => c.table === 'visit_effects')).toBe(false);
    db.__script = { service_visits: { first: () => ({ ...VISIT, status: 'closing' }) } };
    expect(await claimVisitNotification(ROW, 'en_route')).toBe('detached');
  });
  test('an unknown claim state is error (never sends) and no visit means no claim', async () => {
    db.__script = { service_visits: { first: () => { throw new Error('db down'); } } };
    expect(await claimVisitNotification(ROW, 'en_route')).toBe('error');
    expect(await claimVisitNotification({ id: 'p', visit_id: null }, 'en_route')).toBe(null);
  });
});

describe('finalizeVisitNotification', () => {
  test('advances the claimed row only for an actual attempt; never downgrades sent', async () => {
    db.__script = {};
    const fin = await finalizeVisitNotification('v1', 'en_route', 'retry');
    expect(fin).toMatchObject({ ok: true, effectType: 'tracker_en_route', status: 'failed' });
    const merge = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'merge');
    expect(merge.values).toMatchObject({ status: 'failed', attempts: { sql: '?? + 1' } });
    db.__calls.length = 0;
    expect(await finalizeVisitNotification('v1', 'en_route', 'already_handled')).toMatchObject({ ok: true, skipped: true });
    expect(db.__calls.length).toBe(0);
  });
  test('a finalize failure is reported (the row stays claimed for the office)', async () => {
    const origDb = db.getMockImplementation();
    db.mockImplementation((table) => { if (table === 'visit_effects') throw new Error('ledger down'); return origDb(table); });
    const fin = await finalizeVisitNotification('v1', 'on_site', 'sent');
    db.mockImplementation(origDb);
    expect(fin).toMatchObject({ ok: false, status: 'sent' });
    expect(fin.reason).toContain('ledger down');
  });
  test('fan-out reports a finalize failure as an incomplete stop', async () => {
    db.__script = { service_visits: { first: () => VISIT }, scheduled_services: { first: lockedPrimary(), select: () => [] } };
    const origDb = db.getMockImplementation();
    db.mockImplementation((table) => { if (table === 'visit_effects') throw new Error('ledger down'); return origDb(table); });
    const out = await fanOutLiveTransition({ primary: PRIMARY, kind: 'en_route', smsOutcome: 'sent', notificationOwner: true });
    db.mockImplementation(origDb);
    expect(out.ok).toBe(false);
    expect(out.effect).toBe(null);
    expect(out.trackerFailures[0]).toMatchObject({ id: 'effect_finalize' });
  });
});
