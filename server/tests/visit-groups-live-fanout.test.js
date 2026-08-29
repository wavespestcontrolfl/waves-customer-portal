/**
 * liveTransitionSiblings / afterLiveTransition — one En Route / On Site tap
 * moves the whole stop (visit-group-scope.md §3). Fake transaction: each
 * table answers from a script; the shared status writer and tracker
 * writers are mocked so the contract under test is the fan-out itself.
 */
jest.mock('../models/db', () => {
  const calls = [];
  const db = jest.fn((table) => makeChain(table, db.__script, calls));
  db.__calls = calls;
  db.__script = {};
  function makeChain(table, script, log) {
    const chain = {
      _table: table, _ops: [],
      where() { chain._ops.push(['where', ...arguments]); return chain; },
      whereIn() { chain._ops.push(['whereIn', ...arguments]); return chain; },
      whereNot() { chain._ops.push(['whereNot', ...arguments]); return chain; },
      whereNotIn() { chain._ops.push(['whereNotIn', ...arguments]); return chain; },
      whereNull() { chain._ops.push(['whereNull', ...arguments]); return chain; },
      forUpdate() { chain._ops.push(['forUpdate']); return chain; },
      first(...cols) { log.push({ table, op: 'first', ops: chain._ops, cols }); return Promise.resolve((script[table] && script[table].first) ? script[table].first(chain._ops) : null); },
      select(...cols) { log.push({ table, op: 'select', ops: chain._ops, cols }); return Promise.resolve((script[table] && script[table].select) ? script[table].select(chain._ops) : []); },
      update(values) { log.push({ table, op: 'update', ops: chain._ops, values }); return Promise.resolve(1); },
      insert(values) { chain._insert = values; log.push({ table, op: 'insert', values }); return chain; },
      onConflict() { return chain; },
      ignore() { return Promise.resolve([]); },
      then(res, rej) { return Promise.resolve([]).then(res, rej); },
    };
    return chain;
  }
  db.__makeChain = (table) => makeChain(table, db.__script, calls);
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/job-status', () => ({ transitionJobStatus: jest.fn().mockResolvedValue({}) }));
jest.mock('../services/track-transitions', () => ({
  markEnRoute: jest.fn().mockResolvedValue({ ok: true }),
  markOnProperty: jest.fn().mockResolvedValue({ ok: true }),
}));

const db = require('../models/db');
const { transitionJobStatus } = require('../services/job-status');
const trackTransitions = require('../services/track-transitions');
const { liveTransitionSiblings, afterLiveTransition } = require('../services/visit-groups');

function fakeTrx(script) {
  const trx = jest.fn((table) => { db.__script = script; return db.__makeChain(table); });
  trx.raw = jest.fn().mockResolvedValue({ rows: [] });
  trx.isTransaction = true;
  return trx;
}

beforeEach(() => { db.__calls.length = 0; jest.clearAllMocks(); });

describe('liveTransitionSiblings', () => {
  test('ungrouped primary (no visit id on the caller row) issues NO query', async () => {
    const trx = fakeTrx({});
    const out = await liveTransitionSiblings({ trx, primaryId: 'p', primaryVisitId: null, toStatus: 'en_route', transitionedBy: 't1' });
    expect(out).toEqual({ visitId: null, siblingIds: [], skippedIds: [] });
    expect(trx).not.toHaveBeenCalled();
  });

  test('moves eligible same-tech siblings through the shared status writer, skips the rest, stamps the visit', async () => {
    const trx = fakeTrx({
      scheduled_services: {
        first: () => ({ id: 'p', visit_id: 'v1', technician_id: 't1' }),
        select: () => [
          { id: 's1', status: 'confirmed', technician_id: 't1' },
          { id: 's2', status: 'on_site', technician_id: 't1' },       // not eligible for en_route
          { id: 's3', status: 'pending', technician_id: 't2' },       // other tech
          { id: 's4', status: 'en_route', technician_id: 't1' },      // already there
        ],
      },
      service_visits: { first: () => ({ id: 'v1', status: 'open', stop_base_key: 'p1:2026-08-30' }) },
    });
    const out = await liveTransitionSiblings({ trx, primaryId: 'p', primaryVisitId: 'v1', toStatus: 'en_route', transitionedBy: 't1' });
    expect(out.visitId).toBe('v1');
    expect(out.siblingIds).toEqual(['s1']);
    expect(out.skippedIds).toEqual(['s2', 's3']);
    expect(transitionJobStatus).toHaveBeenCalledTimes(1);
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({ jobId: 's1', fromStatus: 'confirmed', toStatus: 'en_route', trx }));
    // stop advisory lock taken before the sibling row locks
    expect(trx.raw).toHaveBeenCalledWith(expect.stringContaining('pg_advisory_xact_lock'), ['visit.stop', 'p1:2026-08-30']);
    const visitStamp = db.__calls.find((c) => c.table === 'service_visits' && c.op === 'update');
    expect(visitStamp.values).toHaveProperty('en_route_at');
    expect(visitStamp.ops).toEqual(expect.arrayContaining([['whereNull', 'en_route_at']]));
  });

  test('on_site writes the arrival lifecycle columns on each moved sibling', async () => {
    const trx = fakeTrx({
      scheduled_services: {
        first: () => ({ id: 'p', visit_id: 'v1', technician_id: 't1' }),
        select: () => [{ id: 's1', status: 'en_route', technician_id: 't1' }],
      },
      service_visits: { first: () => ({ id: 'v1', status: 'open', stop_base_key: 'k' }) },
    });
    const at = new Date('2026-08-30T13:05:00Z');
    const out = await liveTransitionSiblings({ trx, primaryId: 'p', primaryVisitId: 'v1', toStatus: 'on_site', transitionedBy: 't1', lifecycleAt: at });
    expect(out.siblingIds).toEqual(['s1']);
    const lifecycle = db.__calls.find((c) => c.table === 'scheduled_services' && c.op === 'update');
    expect(lifecycle.values).toMatchObject({ arrived_at: at, check_in_time: at, actual_start_time: at });
    expect(transitionJobStatus).toHaveBeenCalledWith(expect.objectContaining({ jobId: 's1', fromStatus: 'en_route', toStatus: 'on_site' }));
  });

  test('a visit that is not open never fans out', async () => {
    const trx = fakeTrx({
      scheduled_services: { first: () => ({ id: 'p', visit_id: 'v1', technician_id: 't1' }), select: () => [{ id: 's1', status: 'pending' }] },
      service_visits: { first: () => ({ id: 'v1', status: 'closing', stop_base_key: 'k' }) },
    });
    const out = await liveTransitionSiblings({ trx, primaryId: 'p', primaryVisitId: 'v1', toStatus: 'en_route', transitionedBy: 't1' });
    expect(out.visitId).toBe(null);
    expect(transitionJobStatus).not.toHaveBeenCalled();
  });
});

describe('afterLiveTransition', () => {
  test('en_route: siblings tracked with the customer text suppressed, stamped covered, one visit_effects row', async () => {
    db.__script = { scheduled_services: { first: () => ({ track_sms_sent_at: new Date() }) } };
    const out = await afterLiveTransition({ visitId: 'v1', kind: 'en_route', primaryId: 'p', siblingIds: ['s1', 's2'], actorType: 'tech', actorId: 't1' });
    expect(trackTransitions.markEnRoute).toHaveBeenCalledTimes(2);
    expect(trackTransitions.markEnRoute).toHaveBeenCalledWith('s1', expect.objectContaining({ suppressCustomerSms: true, actorType: 'tech', actorId: 't1' }));
    const covered = db.__calls.find((c) => c.table === 'scheduled_services' && c.op === 'update');
    expect(covered.ops).toEqual(expect.arrayContaining([['whereIn', 'id', ['s1', 's2']], ['whereNull', 'track_sms_sent_at']]));
    expect(covered.values).toHaveProperty('track_sms_sent_at');
    const effect = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'insert');
    expect(effect.values).toMatchObject({ visit_id: 'v1', effect_type: 'tracker_en_route', dedupe_key: 'v1:tracker_en_route', status: 'sent' });
    expect(out).toEqual({ effectType: 'tracker_en_route', status: 'sent' });
  });

  test('on_site: arrival text suppressed on siblings; effect suppressed when the primary never texted', async () => {
    db.__script = { scheduled_services: { first: () => ({ arrival_sms_sent_at: null }) } };
    const out = await afterLiveTransition({ visitId: 'v1', kind: 'on_site', primaryId: 'p', siblingIds: ['s1'], actorType: 'tech', actorId: 't1' });
    expect(trackTransitions.markOnProperty).toHaveBeenCalledWith('s1', expect.objectContaining({ suppressArrivalSms: true, actingTechId: 't1' }));
    const effect = db.__calls.find((c) => c.table === 'visit_effects' && c.op === 'insert');
    expect(effect.values).toMatchObject({ effect_type: 'tracker_arrived', status: 'suppressed', sent_at: null });
    expect(out.status).toBe('suppressed');
  });

  test('no visit id → no-op', async () => {
    const out = await afterLiveTransition({ visitId: null, kind: 'en_route', siblingIds: ['s1'] });
    expect(out).toBe(null);
    expect(trackTransitions.markEnRoute).not.toHaveBeenCalled();
  });
});
