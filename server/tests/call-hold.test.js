/**
 * Star-key hold service (GATE_CALL_HOLD): ONE decision point for every hold event, and ONE sender for Twilio.
 *
 * Planner table: every event against every state (pure). Service: the Twilio steps and their order, the
 * failure answers, the alert. Scenarios: every interleaving the audit rounds found (press 1 against the
 * voicemail, the staff hanging up during a press 1 or while the hold is placed, a late pause after the
 * voicemail's resume, a redelivered star during a return in flight, a stale step landing after a newer hold, a
 * star whose wait ends as another sender confirms its hold, a sender that stalled past its lease).
 * Two server processes sharing one database: the decisions and the sender lease.
 *
 * The call_log fake holds one row, applies the service's own jsonb_set write, and takes a real per-key advisory
 * lock for the length of a transaction. Reads and writes yield a tick so two unlocked transactions would interleave.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ callConferencePathMode: jest.fn(() => 'on'), callHoldLive: jest.fn(() => true) }));
jest.mock('../services/admin-alert-compose', () => ({ ...jest.requireActual('../services/admin-alert-compose'), raiseAdminAlert: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/admin-alert-names', () => ({
  ...jest.requireActual('../services/admin-alert-names'),
  realName: jest.fn((row) => ([row?.first_name, row?.last_name].filter(Boolean).join(' ') || null)),
  nameOnFileForPhone: jest.fn(async () => null),
}));

// The card pause (live-call-card-pause.js) owns the recording while its window is open. By default it lets the hold's
// resume through; a test sets mockCard.answer to an answer (or a function giving one, or throwing) to hold it back.
const mockCard = { answer: null };
jest.mock('../services/live-call-card-pause', () => ({
  TERMINAL_RESUME_CODES: new Set(['16108', '21220', '20404']),
  resumeOutsideCardWindow: jest.fn(async (_sid, resume) => {
    const answer = typeof mockCard.answer === 'function' ? await mockCard.answer() : mockCard.answer;
    return answer || { sent: true, ...(await resume()) };
  }),
}));

const mockTw = { api: null, clientArgs: [] };
jest.mock('twilio', () => {
  const actual = jest.requireActual('twilio');
  const factory = jest.fn((...args) => { mockTw.clientArgs.push(args); return mockTw.api; });
  factory.twiml = actual.twiml;
  return factory;
});

jest.mock('../models/db', () => {
  const state = { row: null, locks: new Map(), openTx: 0, txCount: 0, failReads: 0, failWrites: 0, failSweep: 0, customerId: null, writes: [], modifyCalls: [], sweeps: 0 };
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  function chainFor(table) {
    const conditions = [];
    const q = {};
    let modified = false;
    q.where = jest.fn(() => q);
    q.whereRaw = jest.fn((sql) => { conditions.push(sql); return q; });
    // The sweep's reads: modify runs the caller's guard against a recorder (the sandbox rows are then filtered out
    // like the real SQL does); select answers the one row when the query's own pending condition holds.
    q.modify = jest.fn((fn) => {
      modified = true;
      const recorder = { whereRaw: (sql, bindings) => { state.modifyCalls.push({ sql, bindings }); return recorder; } };
      fn(recorder);
      return q;
    });
    q.orderBy = jest.fn(() => q);
    q.limit = jest.fn(() => q);
    q.select = jest.fn(async () => {
      await tick();
      state.sweeps += 1;
      if (state.failSweep > 0) { state.failSweep -= 1; throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); }
      const row = state.row;
      const h = row?.metadata?.conference_path?.hold;
      const sandbox = modified && state.modifyCalls.some((c) => (c.bindings || []).includes(row?.source));
      if (!row || sandbox || !(h?.rec_pending === true || h?.alert_pending === true)) return [];
      return [{
        twilio_call_sid: row.sid, status: row.status || null, ended_at: row.metadata.ended_at || null,
        rec_pending: h.rec_pending === true ? 'true' : null, alert_pending: h.alert_pending === true ? 'true' : null,
      }];
    });
    q.first = jest.fn(async () => {
      await tick();
      if (state.failReads > 0) { state.failReads -= 1; throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); }
      if (table === 'customers') return { first_name: 'Test', last_name: 'Customer' };
      return state.row ? { id: 77, customer_id: state.customerId, from_phone: '+19415550100', metadata: clone(state.row.metadata) } : undefined;
    });
    q.update = jest.fn(async (patch) => {
      await tick();
      if (state.failWrites > 0) { state.failWrites -= 1; throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); }
      conditions.forEach((sql) => { if (!/^\(metadata -> 'conference_path'\) IS NOT NULL$|^\(status IS NULL OR status NOT IN/.test(sql)) throw new Error(`unknown condition: ${sql}`); });
      if (!state.row?.metadata?.conference_path) return 0;
      // Apply each jsonb_set path the SQL names, in order, like Postgres (the last path element may be created).
      [...patch.metadata.sql.matchAll(/'\{([^}]*)\}', \?::jsonb/g)].forEach((m, i) => {
        const parts = m[1].split(',');
        const parent = parts.slice(0, -1).reduce((o, k) => (o == null ? undefined : o[k]), state.row.metadata);
        if (parent && typeof parent === 'object') parent[parts[parts.length - 1]] = JSON.parse(patch.metadata.bindings[i]);
        if (m[1] === 'conference_path,hold') state.writes.push(clone(parent.hold));
      });
      return 1;
    });
    return q;
  }
  const db = jest.fn((table) => chainFor(table));
  db.transaction = jest.fn(async (fn) => {
    state.openTx += 1;
    state.txCount += 1;
    const held = [];
    const trx = jest.fn((table) => chainFor(table));
    trx.raw = (sql, bindings) => {
      if (!String(sql).includes('pg_advisory_xact_lock')) return { sql, bindings };
      const key = bindings[0];
      return (async () => {
        while (state.locks.get(key)) await state.locks.get(key);
        let release;
        state.locks.set(key, new Promise((resolve) => { release = resolve; }));
        held.push(() => { state.locks.delete(key); release(); });
      })();
    };
    try {
      return await fn(trx);
    } finally {
      held.forEach((unlock) => unlock());
      state.openTx -= 1;
    }
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  db.__state = state;
  return db;
});

const db = require('../models/db');
const logger = require('../services/logger');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const { nameOnFileForPhone } = require('../services/admin-alert-names');
const hold = require('../services/call-hold');
const cp = require('../services/call-conference-path');
const { VOICE_RELAY_SANDBOX_SOURCE } = require('../services/voice-agent/relay-protocol');

const SID = `CA${'a'.repeat(32)}`;
const LEG = `CA${'0'.repeat(31)}1`;
const ROOM = `CF${'d'.repeat(32)}`;
const NOW = new Date('2026-11-17T15:00:00Z');
const iso = (offsetSec) => new Date(NOW.getTime() + offsetSec * 1000).toISOString();
const err = (status, code) => Object.assign(new Error('x +19415550100'), { status, code });
const err404 = () => err(404, 20404);
const err500 = () => err(500, 51000);

const flush = async () => { for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
async function advance(ms) {
  await jest.advanceTimersByTimeAsync(ms);
  await flush();
}

// A hold as the planner writes it. Defaults: the first hold, on hold at Twilio, 10 s old.
const heldHold = (o = {}) => ({
  gen: 1, phase: 'held', applied: 'held', ret_by: null, open_at: iso(-10), by: 'star', leg_sid: LEG, count: 1, total_sec: 0,
  reminded_at: null, voicemail_at: null, voicemail_reason: null, vm_failed: false, gone: false, sender: null, ...o,
});
function seed(holdState, extra = {}) {
  db.__state.row = { sid: SID, status: null, metadata: { conference_path: { room: `waves-${SID}`, accepted_leg_sid: LEG, legs: { 0: { sid: LEG } }, ...(holdState ? { hold: holdState } : {}), ...extra } } };
  return db.__state.row;
}
const holdOf = () => db.__state.row.metadata.conference_path.hold;
const once = (fn) => { let fired = false; return async () => { if (!fired) { fired = true; await fn(); } }; };
const names = (events) => events.map((e) => e.name);
const statuses = (events) => events.filter((e) => e.name === 'recording').map((e) => e.status);

// Every Twilio call lands in `events` in order. `fail` maps an event name to an error, or to a function of the call
// number (1, 2, ...) that returns one. `during` maps an event name to a function run while that call is in flight.
function fakeTwilio({ rooms = [{ sid: ROOM }], fail = {}, during = {} } = {}) {
  const events = [];
  const counts = {};
  const step = async (name, params) => {
    counts[name] = (counts[name] || 0) + 1;
    events.push({ name, ...params });
    if (during[name]) await during[name](counts[name]);
    const failure = typeof fail[name] === 'function' ? fail[name](counts[name]) : fail[name];
    if (failure) throw failure;
  };
  const participants = jest.fn((sid) => ({ update: (params) => step('participant', { sid, ...params }) }));
  const conferences = jest.fn((sid) => ({
    participants: (callSid) => participants(callSid),
    roomSid: sid,
    update: (params) => step('room', { sid, ...params }),
  }));
  conferences.list = jest.fn(async (params) => { events.push({ name: 'list', ...params }); return rooms; });
  const calls = jest.fn((sid) => ({
    recordings: jest.fn((which) => ({ update: (params) => step('recording', { sid, which, ...params }) })),
    update: (params) => step('call', { sid, ...params }),
  }));
  mockTw.api = { calls, conferences };
  return events;
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SERVER_DOMAIN;
  const s = db.__state;
  s.row = null; s.locks = new Map(); s.openTx = 0; s.txCount = 0; s.failReads = 0; s.failWrites = 0; s.failSweep = 0; s.customerId = null; s.writes = []; s.modifyCalls = []; s.sweeps = 0;
  mockTw.clientArgs = [];
  hold._test.resumeRetries.clear();
  mockCard.answer = null;
  jest.useFakeTimers({ now: NOW, doNotFake: ['setImmediate', 'nextTick'] });
});
afterEach(() => jest.useRealTimers());

// ---------------------------------------------------------------------------------------------------------
describe('planner: every event against every state (pure)', () => {
  const { planEvent, nextStep, planClaim } = hold._test;
  const T = NOW.getTime();
  const STATES = {
    none: () => null,
    heldUnconfirmed: () => heldHold({ applied: null }),
    held: () => heldHold(),
    heldReminded: () => heldHold({ open_at: iso(-200), reminded_at: iso(-20) }),
    held200: () => heldHold({ open_at: iso(-200) }),
    held301: () => heldHold({ open_at: iso(-301) }),
    returnedInFlight: () => heldHold({ phase: 'returned', ret_by: 'press1', applied: 'held' }),
    returnedDone: () => heldHold({ phase: 'returned', ret_by: 'press1', applied: 'returned' }),
    aborted: () => heldHold({ phase: 'returned', ret_by: 'abort', applied: null }),
    voicemailUnconfirmed: () => heldHold({ phase: 'voicemail', voicemail_reason: 'timeout', voicemail_at: iso(-1) }),
    voicemailDone: () => heldHold({ phase: 'voicemail', voicemail_reason: 'timeout', voicemail_at: iso(-1), applied: 'voicemail' }),
  };
  const run = (stateName, ev, closed = false) => planEvent(STATES[stateName](), ev, T, closed);
  const phaseOf = (out) => out.next?.phase ?? null;

  test.each([
    // [state, expected next phase, expected gen, answer]
    ['none', 'held', 1, 'start'],
    ['heldUnconfirmed', 'held', 1, 'held'], // a duplicate star: nothing changes
    ['held', 'held', 1, 'held'],
    ['returnedInFlight', 'returned', 1, 'held'], // a star while a press 1 return is in flight replaces nothing
    ['returnedDone', 'held', 2, 'start'],
    ['aborted', 'held', 2, 'start'], // a failed star left no hold behind
    ['voicemailUnconfirmed', 'voicemail', 1, 'no_room'],
    ['voicemailDone', 'voicemail', 1, 'no_room'],
  ])('star on %s -> %s gen %s (%s)', (state, phase, gen, answer) => {
    const out = run(state, { type: 'star', legSid: LEG });
    expect([phaseOf(out), out.next.gen, out.answer]).toEqual([phase, gen, answer]);
  });

  test('a star on a closed call is no_room and writes nothing', () => {
    const before = STATES.held();
    expect(planEvent(before, { type: 'star' }, T, true)).toEqual({ next: before, answer: 'no_room' });
  });

  test('a new star keeps count and total_sec running and starts a fresh timer, reminder and applied state', () => {
    const out = planEvent(heldHold({ phase: 'returned', applied: 'returned', ret_by: 'press1', count: 2, total_sec: 75, reminded_at: iso(-300) }), { type: 'star', by: 'star', legSid: LEG }, T, false);
    expect(out.next).toMatchObject({ gen: 2, phase: 'held', applied: null, count: 3, total_sec: 75, open_at: iso(0), reminded_at: null, vm_failed: false });
  });

  test.each([
    ['none', 'closed', null],
    ['heldUnconfirmed', 'return', 'returned'],
    ['held', 'return', 'returned'],
    ['returnedInFlight', 'return', 'returned'], // a second press 1 waits for the first
    ['returnedDone', 'closed', 'returned'],
    ['aborted', 'closed', 'returned'],
    ['voicemailUnconfirmed', 'voicemail', 'voicemail'], // the voicemail was decided first
    ['voicemailDone', 'voicemail', 'voicemail'],
  ])('press 1 on %s answers %s', (state, answer, phase) => {
    const out = run(state, { type: 'press1' });
    expect([out.answer, out.next?.phase ?? null]).toEqual([answer, phase]);
  });

  test('press 1 adds the held seconds to total_sec once', () => {
    const out = planEvent(heldHold({ open_at: iso(-30) }), { type: 'press1' }, T, false);
    expect(out.next).toMatchObject({ phase: 'returned', ret_by: 'press1', total_sec: 30 });
    expect(planEvent(out.next, { type: 'press1' }, T + 5000, false).next.total_sec).toBe(30);
  });

  test.each([
    ['none', { remind: true }, null, false],
    ['held', { remind: true }, 'held', false], // 10 s old
    ['held200', { remind: false }, 'held', false], // the staff menu asks for the reminder, the facts loop does not
    ['held200', { remind: true }, 'held', true],
    ['heldReminded', { remind: true }, 'held', false], // said once per hold
    ['held301', { remind: true }, 'voicemail', false], // the limit wins over the reminder
    ['held301', {}, 'voicemail', false],
    ['returnedInFlight', { remind: true }, 'returned', false], // a decided return means the staff are there: no limit
    ['returnedDone', {}, 'returned', false],
    ['aborted', {}, 'returned', false],
    ['voicemailUnconfirmed', { remind: true }, 'voicemail', false],
  ])('check on %s %j -> %s, remind %s', (state, ev, phase, remind) => {
    const out = run(state, { type: 'check', ...ev });
    expect([out.next?.phase ?? null, out.answer.remind]).toEqual([phase, remind]);
    if (out.next && out.next.phase === 'voicemail' && state === 'held301') expect(out.next).toMatchObject({ voicemail_reason: 'timeout', total_sec: 301 });
  });

  test.each([
    ['none', 'ordinary', null],
    ['heldUnconfirmed', 'voicemail', 'voicemail'],
    ['held', 'voicemail', 'voicemail'],
    ['returnedInFlight', 'voicemail', 'voicemail'], // the staff hung up while the press 1 return was in flight
    ['returnedDone', 'ordinary', 'returned'], // they rejoined and then hung up: today's room end
    ['aborted', 'ordinary', 'returned'],
    ['voicemailUnconfirmed', 'voicemail', 'voicemail'],
    ['voicemailDone', 'voicemail', 'voicemail'],
  ])('staff hang-up on %s answers %s', (state, answer, phase) => {
    const out = run(state, { type: 'staff_left' });
    expect([out.answer, out.next?.phase ?? null]).toEqual([answer, phase]);
    if (answer === 'voicemail' && state !== 'voicemailUnconfirmed' && state !== 'voicemailDone') expect(out.next).toMatchObject({ voicemail_reason: 'staff_left' });
  });

  test('a staff hang-up on a closed call is ordinary', () => {
    expect(planEvent(STATES.held(), { type: 'staff_left' }, T, true).answer).toBe('ordinary');
  });

  test('step outcomes bind to the generation: an old one is a no-op', () => {
    const current = heldHold({ gen: 2, applied: null });
    expect(planEvent(current, { type: 'step_done', gen: 1, step: 'hold' }, T, false).next).toBe(current);
    expect(planEvent(current, { type: 'step_failed', gen: 1, step: 'hold' }, T, false).next).toBe(current);
    expect(planEvent(current, { type: 'abort', gen: 1 }, T, false).next).toBe(current);
    expect(planEvent(current, { type: 'step_done', gen: 2, step: 'hold' }, T, false).next).toMatchObject({ applied: 'held' });
  });

  test('an abort of a hold another sender already confirmed changes nothing and answers held; an unconfirmed one aborts', () => {
    const confirmed = STATES.held();
    expect(planEvent(confirmed, { type: 'abort', gen: 1 }, T, false)).toEqual({ next: confirmed, answer: 'held' });
    expect(planEvent(STATES.heldUnconfirmed(), { type: 'abort', gen: 1 }, T, false))
      .toMatchObject({ next: { phase: 'returned', ret_by: 'abort' }, answer: 'aborted' });
  });

  test('a failed hold step aborts the hold; a failed voicemail step marks vm_failed only when the caller is not held', () => {
    expect(planEvent(heldHold({ applied: null }), { type: 'step_failed', gen: 1, step: 'hold', code: '500' }, T, false).next)
      .toMatchObject({ phase: 'returned', ret_by: 'abort', last_error_code: '500' });
    expect(planEvent(heldHold({ phase: 'voicemail', applied: 'returned' }), { type: 'step_failed', gen: 1, step: 'voicemail' }, T, false).next.vm_failed).toBe(true);
    expect(planEvent(heldHold({ phase: 'voicemail', applied: 'held' }), { type: 'step_failed', gen: 1, step: 'voicemail' }, T, false).next.vm_failed).toBe(false);
  });

  test.each([
    ['heldUnconfirmed', 'hold'], ['held', null], ['returnedInFlight', 'return'], ['returnedDone', null], ['aborted', 'return'],
    ['voicemailUnconfirmed', 'voicemail'], ['voicemailDone', null], ['none', null],
  ])('the step wanted on %s is %s', (state, step) => {
    expect(nextStep(STATES[state]())).toBe(step);
  });

  test('a voicemail whose step failed with the caller not held wants a re-hold first', () => {
    expect(nextStep(heldHold({ phase: 'voicemail', applied: 'returned', vm_failed: true }))).toBe('rehold');
    expect(nextStep(heldHold({ phase: 'voicemail', applied: 'held', vm_failed: true }))).toBe('voicemail');
  });

  test('the claim takes the lease with the step; a live lease of another sender is busy; an expired one is taken over', () => {
    const step = planClaim(heldHold({ applied: null }), 'me', T, false);
    expect(step.res).toMatchObject({ send: 'hold', gen: 1 });
    expect(step.next.sender).toEqual({ token: 'me', until: T + hold.LEASE_MS });
    expect(planClaim(heldHold({ applied: null, sender: { token: 'other', until: T + 1000 } }), 'me', T, false).res).toEqual({ send: null, busy: true });
    expect(planClaim(heldHold({ applied: null, sender: { token: 'other', until: T - 1 } }), 'me', T, false).res.send).toBe('hold');
    // Nothing to send (or a closed call) clears my own lease and nobody else's.
    expect(planClaim(heldHold({ sender: { token: 'me', until: T + 1000 } }), 'me', T, false).next.sender).toBeNull();
    expect(planClaim(heldHold({ sender: { token: 'other', until: T + 1000 } }), 'me', T, false).next.sender.token).toBe('other');
    expect(planClaim(heldHold({ applied: null }), 'me', T, true).res.send).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('startHold', () => {
  test('decides, then puts the caller on hold with the facts URL, then pauses the recording', async () => {
    seed();
    const events = fakeTwilio();
    expect(await hold.startHold(SID, { by: 'star', legSid: LEG })).toBe('held');
    expect(names(events)).toEqual(['list', 'participant', 'recording']);
    expect(events[0]).toMatchObject({ friendlyName: `waves-${SID}`, status: 'in-progress', limit: 5 });
    expect(events[1]).toMatchObject({
      sid: SID,
      hold: true,
      holdUrl: `https://portal.wavespestcontrol.com/api/webhooks/twilio/conference-hold-facts?parent=${SID}&step=0`,
      holdMethod: 'POST',
    });
    expect(events[2]).toMatchObject({ sid: SID, which: 'Twilio.CURRENT', status: 'paused', pauseBehavior: 'silence' });
    expect(holdOf()).toMatchObject({ gen: 1, phase: 'held', applied: 'held', by: 'star', leg_sid: LEG, count: 1, total_sec: 0, sender: null });
    expect(Number.isNaN(Date.parse(holdOf().open_at))).toBe(false);
  });

  test('a second star while a hold is open is a no-op: nothing is claimed twice and Twilio is not touched', async () => {
    seed();
    const events = fakeTwilio();
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
    const before = events.length;
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
    expect(events).toHaveLength(before);
    expect(holdOf()).toMatchObject({ gen: 1, count: 1 });
  });

  test('a closed call is not held: no_room, and Twilio is not called', async () => {
    seed(null, { closed_at: '2026-11-16T12:00:00Z' });
    const events = fakeTwilio();
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('no_room');
    expect(events).toHaveLength(0);
    expect(holdOf()).toBeUndefined();
  });

  test('no open room: the hold is aborted, no_room', async () => {
    seed();
    fakeTwilio({ rooms: [] });
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('no_room');
    expect(holdOf()).toMatchObject({ phase: 'returned', ret_by: 'abort', gone: true });
  });

  test('a 404 on the participant aborts the hold: no_room', async () => {
    seed();
    fakeTwilio({ fail: { participant: err404() } });
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('no_room');
    expect(holdOf()).toMatchObject({ phase: 'returned', ret_by: 'abort' });
  });

  test('any other REST error aborts the hold: failed, and a later star can start a new one (generation 2)', async () => {
    seed();
    fakeTwilio({ fail: { participant: err(503) } });
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('failed');
    expect(holdOf()).toMatchObject({ gen: 1, phase: 'returned', ret_by: 'abort' });
    const events = fakeTwilio();
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
    expect(holdOf()).toMatchObject({ gen: 2, phase: 'held', applied: 'held', count: 2 });
    expect(names(events)).toEqual(['list', 'participant', 'recording']);
  });

  test('a recording pause error is logged and the hold stays', async () => {
    seed();
    fakeTwilio({ fail: { recording: err500() } });
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not paused'));
    expect(holdOf()).toMatchObject({ phase: 'held', applied: 'held' });
  });

  test('a call with no conference state is failed, never a throw', async () => {
    db.__state.row = { metadata: {} };
    fakeTwilio();
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('failed');
  });

  test('a database error is failed, never a throw, and Twilio is never touched', async () => {
    seed();
    const events = fakeTwilio();
    db.__state.failReads = 1;
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('failed');
    expect(events).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('(ECONNRESET)'));
  });

  test('no database connection is open while a Twilio request is in flight, and the client has a request timeout under the lease', async () => {
    seed();
    const open = [];
    fakeTwilio({ during: { participant: async () => { open.push(db.__state.openTx); }, list: undefined } });
    mockTw.api.conferences.list = jest.fn(async () => { open.push(db.__state.openTx); return [{ sid: ROOM }]; });
    await hold.startHold(SID, { legSid: LEG });
    expect(open).toEqual([0, 0]);
    const options = mockTw.clientArgs[0][2];
    expect(options.httpClient.defaultTimeout).toBeLessThan(hold.LEASE_MS / 3);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('endHold (press 1)', () => {
  test('takes the caller off hold, then resumes the recording, and answers returned only once that is confirmed', async () => {
    seed(heldHold({ open_at: iso(-30) }));
    const events = fakeTwilio({ during: { participant: () => expect(holdOf()).toMatchObject({ phase: 'returned', applied: 'held' }) } });
    expect(await hold.endHold(SID)).toBe('returned');
    expect(names(events)).toEqual(['list', 'participant', 'recording']);
    expect(events[1]).toMatchObject({ sid: SID, hold: false });
    expect(events[2]).toMatchObject({ which: 'Twilio.CURRENT', status: 'in-progress' });
    expect(holdOf()).toMatchObject({ phase: 'returned', applied: 'returned', ret_by: 'press1', total_sec: 30 });
  });

  test('a resume error is logged at error level; the caller is still returned', async () => {
    seed(heldHold());
    fakeTwilio({ fail: { recording: err500() } });
    expect(await hold.endHold(SID)).toBe('returned');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('NOT resumed'));
  });

  test('a 404 or no room: no_room, no recording call', async () => {
    seed(heldHold());
    const events = fakeTwilio({ fail: { participant: err404() } });
    expect(await hold.endHold(SID)).toBe('no_room');
    expect(statuses(events)).toEqual([]);
    seed(heldHold());
    fakeTwilio({ rooms: [] });
    expect(await hold.endHold(SID)).toBe('no_room');
  });

  test('any other REST error: failed (the staff stay on the menu); the wanted return stays and the next try finishes it', async () => {
    seed(heldHold());
    fakeTwilio({ fail: { participant: err(503) } });
    expect(await hold.endHold(SID)).toBe('failed');
    expect(holdOf()).toMatchObject({ phase: 'returned', applied: 'held', last_error_code: '503' });
    const events = fakeTwilio();
    const out = await hold.checkHold(SID, { remind: true }); // the staff menu loop
    expect(names(events)).toEqual(['list', 'participant', 'recording']);
    expect(out).toMatchObject({ phase: 'returned', applied: 'returned' });
  });

  test('a duplicate press 1 on a hold that is already back: returned, and Twilio is not touched', async () => {
    seed(heldHold({ phase: 'returned', ret_by: 'press1', applied: 'returned' }));
    const events = fakeTwilio();
    expect(await hold.endHold(SID)).toBe('returned');
    expect(events).toHaveLength(0);
  });

  test('a database error: failed, never a throw, and the caller is not unheld', async () => {
    seed(heldHold());
    const events = fakeTwilio();
    db.__state.failReads = 1;
    expect(await hold.endHold(SID)).toBe('failed');
    expect(events).toHaveLength(0);
  });

  test('total_sec adds up across two holds', async () => {
    seed();
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    await advance(30 * 1000);
    await hold.endHold(SID);
    expect(holdOf()).toMatchObject({ phase: 'returned', count: 1, total_sec: 30 });
    await advance(270 * 1000);
    await hold.startHold(SID, { legSid: LEG });
    await advance(45 * 1000);
    await hold.endHold(SID);
    expect(holdOf()).toMatchObject({ gen: 2, count: 2, total_sec: 75 });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('holdState + gate', () => {
  test('reports phase, applied, closed and found; a read error answers held with error', async () => {
    const row = seed();
    expect(await hold.holdState(SID)).toMatchObject({ found: true, phase: null, open: false, closed: false });
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    expect(await hold.holdState(SID)).toMatchObject({ open: true, phase: 'held', applied: 'held', gen: 1, voicemailAt: null });
    expect(Number.isNaN(Date.parse((await hold.holdState(SID)).openAt))).toBe(false);
    row.metadata.conference_path.closed_at = '2026-11-16T12:00:00Z';
    expect((await hold.holdState(SID)).closed).toBe(true);
    db.__state.failReads = 1;
    expect(await hold.holdState(SID)).toMatchObject({ open: true, error: true });
  });

  test('roomIsOpen: a lookup error answers true so the staff rejoin', async () => {
    fakeTwilio({ rooms: [] });
    expect(await hold.roomIsOpen(SID)).toBe(false);
    fakeTwilio();
    mockTw.api.conferences.list = jest.fn(async () => { throw err500(); });
    expect(await hold.roomIsOpen(SID)).toBe(true);
  });

  test('isEnabled reads the gate at call time', () => {
    const gates = require('../config/feature-gates');
    gates.callHoldLive.mockReturnValue(false);
    expect(hold.isEnabled()).toBe(false);
    gates.callHoldLive.mockReturnValue(true);
    expect(hold.isEnabled()).toBe(true);
  });

  test('heldSeconds counts from open_at while the hold is held, and is 0 otherwise', () => {
    expect(hold.heldSeconds({ phase: 'held', openAt: iso(-42) })).toBe(42);
    expect(hold.heldSeconds({ phase: 'returned', openAt: iso(-42) })).toBe(0);
    expect(hold.heldSeconds({ phase: 'held', openAt: null })).toBe(0);
    expect(hold.heldSeconds(null)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('checkHold (the loops): limit, reminder, one try, never a wait', () => {
  test('the reminder is answered to one fetch only, and a young hold sends nothing', async () => {
    seed(heldHold({ open_at: iso(-200) }));
    const events = fakeTwilio();
    expect(await hold.checkHold(SID, { remind: true })).toMatchObject({ phase: 'held', remind: true });
    expect(await hold.checkHold(SID, { remind: true })).toMatchObject({ remind: false });
    expect(events).toHaveLength(0);
  });

  test('at 5 minutes the caller goes to voicemail: the decision, then the room end, then one alert', async () => {
    seed(heldHold({ open_at: iso(-300) }), { });
    db.__state.customerId = 12;
    const events = fakeTwilio();
    expect(await hold.checkHold(SID)).toMatchObject({ phase: 'voicemail', applied: 'voicemail' });
    expect(names(events)).toEqual(['list', 'room']);
    expect(events[1]).toMatchObject({ sid: ROOM, status: 'completed' });
    expect(holdOf()).toMatchObject({ phase: 'voicemail', voicemail_reason: 'timeout', total_sec: 300 });
    expect(Number.isNaN(Date.parse(holdOf().voicemail_at))).toBe(false);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('a loop fetch never waits for another sender: with the lease busy it sends nothing and answers at once', async () => {
    seed(heldHold({ open_at: iso(-301), applied: 'held', sender: { token: 'other', until: NOW.getTime() + 5000 } }));
    const events = fakeTwilio();
    expect(await hold.checkHold(SID)).toMatchObject({ phase: 'voicemail', applied: 'held' });
    expect(events).toHaveLength(0);
  });

  test('a database error answers error (the staff stay, the caller keeps the script) and never throws', async () => {
    seed(heldHold());
    db.__state.failReads = 1;
    expect(await hold.checkHold(SID)).toMatchObject({ error: true, phase: 'held' });
  });

  test('a call with no hold or no state reads as nothing wanted', async () => {
    seed();
    expect(await hold.checkHold(SID)).toMatchObject({ found: true, phase: null });
    db.__state.row = { metadata: {} };
    expect(await hold.checkHold(SID)).toMatchObject({ found: false, phase: null });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('voicemail: the room end, the alert, and what a failure leaves', () => {
  const limit = () => seed(heldHold({ open_at: iso(-300) }));

  test('every open room is ended', async () => {
    limit();
    const events = fakeTwilio({ rooms: [{ sid: ROOM }, { sid: `CF${'e'.repeat(32)}` }] });
    await hold.checkHold(SID);
    expect(events.filter((e) => e.name === 'room').map((e) => e.sid)).toEqual([ROOM, `CF${'e'.repeat(32)}`]);
  });

  test('one of two rooms already gone (404): the other is ended, the voicemail starts', async () => {
    limit();
    const events = fakeTwilio({ rooms: [{ sid: ROOM }, { sid: `CF${'e'.repeat(32)}` }], fail: { room: (n) => (n === 1 ? err404() : null) } });
    await hold.checkHold(SID);
    expect(events.filter((e) => e.name === 'room')).toHaveLength(2);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(holdOf()).toMatchObject({ applied: 'voicemail', gone: false });
  });

  test('no open room: the voicemail is settled (caller gone) and no alert rings', async () => {
    limit();
    fakeTwilio({ rooms: [] });
    expect(await hold.checkHold(SID)).toMatchObject({ phase: 'voicemail', applied: 'voicemail', gone: true });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a 404 on the room end is caller gone too', async () => {
    limit();
    fakeTwilio({ fail: { room: err404() } });
    expect(await hold.checkHold(SID)).toMatchObject({ applied: 'voicemail', gone: true });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a REST error leaves the voicemail wanted and the caller held: no alert, and the next loop fetch ends the room', async () => {
    limit();
    const first = fakeTwilio({ fail: { room: (n) => (n === 1 ? err(500, 51000) : null) } });
    expect(await hold.checkHold(SID)).toMatchObject({ phase: 'voicemail', applied: 'held' });
    expect(names(first)).toEqual(['list', 'room']); // one try per pass: the caller is held, so the facts loop retries it
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('51000');
    expect(logged).not.toContain('+19415550100');
    const events = fakeTwilio();
    expect(await hold.checkHold(SID)).toMatchObject({ applied: 'voicemail' });
    expect(names(events)).toEqual(['list', 'room']);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('the alert: needs-you, Comms, the customer on the call, the call link, one dedupe key', async () => {
    limit();
    db.__state.customerId = 12;
    fakeTwilio();
    await hold.checkHold(SID);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [kind, payload, options] = raiseAdminAlert.mock.calls[0];
    expect(kind).toBe('voicemail_callback');
    expect(payload).toMatchObject({
      area: 'Comms', action: 'call Test Customer back', severity: 'needs-you', doneWhen: 'caller_reached', who: 'person',
      why: 'Waited 5 minutes on hold, then went to voicemail.',
      link: '/admin/communications#tab=calls&call=77', subject: { type: 'call', id: '77' },
    });
    expect(options).toMatchObject({ bell: true, dedupeKey: `call-hold-voicemail:${SID}`, metadata: { callLogId: 77, reason: 'timeout' } });
  });

  test('staff_left why; no customer on the call uses the name on file for the number, else a plain wording', async () => {
    seed(heldHold());
    fakeTwilio();
    expect(await hold.staffLeft(SID)).toBe('voicemail');
    expect(raiseAdminAlert.mock.calls[0][1]).toMatchObject({ why: 'The staff phone hung up during a hold; the caller went to voicemail.', action: 'call back an unknown caller' });
    expect(raiseAdminAlert.mock.calls[0][2].metadata.reason).toBe('staff_left');
    raiseAdminAlert.mockClear();
    nameOnFileForPhone.mockResolvedValueOnce('Pat Doe');
    seed(heldHold({ open_at: iso(-300) }));
    fakeTwilio();
    await hold.checkHold(SID);
    expect(raiseAdminAlert.mock.calls[0][1].action).toBe('call Pat Doe back');
  });

  test('an alert failure is logged by code and the voicemail still stands', async () => {
    limit();
    raiseAdminAlert.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EBELL' }));
    fakeTwilio();
    expect(await hold.checkHold(SID)).toMatchObject({ applied: 'voicemail' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('(EBELL)'));
  });

  test('the staff hang-up with no hold, or with a hold that is over, is ordinary (today\'s room end)', async () => {
    seed();
    expect(await hold.staffLeft(SID)).toBe('ordinary');
    seed(heldHold({ phase: 'returned', ret_by: 'press1', applied: 'returned' }));
    expect(await hold.staffLeft(SID)).toBe('ordinary');
    seed(null, { closed_at: '2026-11-17T12:00:00Z' });
    expect(await hold.staffLeft(SID)).toBe('ordinary');
  });
});

// ---------------------------------------------------------------------------------------------------------
// Every interleaving the audit rounds found. Each runs the second request WHILE the first one's Twilio call is in
// flight, so the two really interleave. 'hold_voicemail' is what the staff-leg status callback answers.
describe('scenarios: every earlier finding', () => {
  const staffGone = () => cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG, status: 'completed' });

  test('1a. press 1 first, then the 5 minute limit while the unhold is in flight: the limit is a no-op, no room is ended', async () => {
    seed(heldHold({ open_at: iso(-310) }));
    const seen = {};
    const events = fakeTwilio({ during: { participant: once(async () => { seen.check = await hold.checkHold(SID); }) } });
    expect(await hold.endHold(SID)).toBe('returned');
    expect(seen.check).toMatchObject({ phase: 'returned' });
    expect(names(events)).toEqual(['list', 'participant', 'recording']);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(holdOf().voicemail_at).toBeNull();
  });

  test('1b. the voicemail first, then press 1 while the room is ending: press 1 answers voicemail and never unholds or rejoins', async () => {
    seed(heldHold({ open_at: iso(-310) }));
    const seen = {};
    const events = fakeTwilio({ during: { room: once(async () => { seen.ret = await hold.endHold(SID); }) } });
    expect(await hold.checkHold(SID)).toMatchObject({ phase: 'voicemail', applied: 'voicemail' });
    expect(seen.ret).toBe('voicemail');
    expect(names(events)).toEqual(['list', 'room']);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('1c. press 1 after the voicemail is decided and done: voicemail, no Twilio call', async () => {
    seed(heldHold({ phase: 'voicemail', voicemail_reason: 'timeout', voicemail_at: iso(-5), applied: 'voicemail' }));
    const events = fakeTwilio();
    expect(await hold.endHold(SID)).toBe('voicemail');
    expect(events).toHaveLength(0);
  });

  test('1d. press 1 won but the unhold fails: the limit still does nothing (the staff are there) and the menu loop finishes the return', async () => {
    seed(heldHold({ open_at: iso(-310) }));
    fakeTwilio({ fail: { participant: (n) => (n === 1 ? err500() : null) } });
    expect(await hold.endHold(SID)).toBe('failed');
    expect(await hold.checkHold(SID)).toMatchObject({ phase: 'returned' }); // the loop's try is the retry: it succeeds now
    expect(holdOf()).toMatchObject({ phase: 'returned', applied: 'returned', voicemail_at: null });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('1e. the voicemail won but ending the room fails: the caller stays held and the facts loop ends the room next; press 1 in between answers voicemail', async () => {
    seed(heldHold({ open_at: iso(-310) }));
    fakeTwilio({ fail: { room: (n) => (n === 1 ? err500() : null) } });
    expect(await hold.checkHold(SID)).toMatchObject({ phase: 'voicemail', applied: 'held' });
    expect(await hold.endHold(SID)).toBe('voicemail');
    expect(holdOf()).toMatchObject({ phase: 'voicemail', applied: 'voicemail' });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('2a. the staff hang up while a press 1 unhold is in flight: the voicemail goes after the unhold, in order, and press 1 answers voicemail', async () => {
    seed(heldHold());
    const seen = {};
    const events = fakeTwilio({ during: { participant: once(async () => { seen.staff = await staffGone(); }) } });
    expect(await hold.endHold(SID)).toBe('voicemail');
    expect(seen.staff).toBe('hold_voicemail');
    // unhold + resume, then the room end: one sender, decision order.
    expect(names(events)).toEqual(['list', 'participant', 'recording', 'list', 'room']);
    expect(holdOf()).toMatchObject({ phase: 'voicemail', voicemail_reason: 'staff_left', applied: 'voicemail' });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('2b. the press 1 finishes before the hang-up: returned, and the hang-up then gets today\'s room end', async () => {
    seed(heldHold());
    const events = fakeTwilio();
    expect(await hold.endHold(SID)).toBe('returned');
    expect(await staffGone()).toBe('room_ended');
    expect(names(events)).toEqual(['list', 'participant', 'recording', 'list', 'room']);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(holdOf().voicemail_at).toBeNull();
  });

  test('2c. the voicemail step fails after the return went through: the same pass re-holds the caller so a loop exists, and the next fetch ends the room', async () => {
    seed(heldHold());
    const events = fakeTwilio({
      during: { participant: once(async () => { await staffGone(); }) },
      fail: { room: (n) => (n === 1 ? err500() : null) },
    });
    expect(await hold.endHold(SID)).toBe('voicemail');
    // The staff are gone and the caller is unheld and alone in the room, so no loop would run: the pass that failed
    // the room end re-holds the caller at once, and the facts loop exists again.
    expect(names(events)).toEqual(['list', 'participant', 'recording', 'list', 'room', 'list', 'participant']);
    expect(events[events.length - 1]).toMatchObject({ hold: true, holdMethod: 'POST' });
    expect(statuses(events)).toEqual(['in-progress']); // no new recording pause: the voicemail resumes it
    expect(holdOf()).toMatchObject({ phase: 'voicemail', applied: 'held', vm_failed: false });
    const last = fakeTwilio();
    expect(await hold.checkHold(SID)).toMatchObject({ applied: 'voicemail' });
    expect(names(last)).toEqual(['list', 'room']);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(events.length).toBeGreaterThan(0);
  });

  test('3a. the staff hang up while the participant hold is in flight: the pause lands BEFORE the room end, the route\'s resume is last', async () => {
    seed();
    const events = fakeTwilio({ during: { participant: once(async () => { await staffGone(); }) } });
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
    expect(names(events)).toEqual(['list', 'participant', 'recording', 'list', 'room']);
    expect(statuses(events)).toEqual(['paused']);
    await hold.resumeRecording(SID); // /call-complete?conf=1
    expect(statuses(events)).toEqual(['paused', 'in-progress']);
    expect(holdOf()).toMatchObject({ phase: 'voicemail', voicemail_reason: 'staff_left', applied: 'voicemail' });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('3b. the staff hang up while the recording pause is in flight: same order', async () => {
    seed();
    const events = fakeTwilio({ during: { recording: once(async () => { await staffGone(); }) } });
    await hold.startHold(SID, { legSid: LEG });
    expect(names(events)).toEqual(['list', 'participant', 'recording', 'list', 'room']);
  });

  test('4. a redelivered star during a press 1 return in flight replaces nothing: no new hold, no second hold request, the return completes', async () => {
    seed(heldHold());
    const seen = {};
    const events = fakeTwilio({ during: { participant: once(async () => { seen.dup = await hold.startHold(SID, { legSid: LEG }); }) } });
    expect(await hold.endHold(SID)).toBe('returned');
    expect(seen.dup).toBe('held');
    expect(names(events)).toEqual(['list', 'participant', 'recording']);
    expect(events[1]).toMatchObject({ hold: false });
    expect(holdOf()).toMatchObject({ gen: 1, count: 1, phase: 'returned', applied: 'returned' });
    // A real star afterwards starts generation 2.
    fakeTwilio();
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
    expect(holdOf()).toMatchObject({ gen: 2, count: 2, phase: 'held', applied: 'held' });
  });

  test('5a. a step of an old generation that lands after a newer hold began changes nothing of the newer hold (generation binding)', async () => {
    // Generation 1 was aborted; process B is unholding the caller (the recovery step) when a new star arrives.
    seed(heldHold({ phase: 'returned', ret_by: 'abort', applied: null }));
    let land;
    const events = fakeTwilio({ during: { participant: once(() => new Promise((resolve) => { land = resolve; })) } });
    const recovery = hold.checkHold(SID);
    await flush();
    expect(names(events)).toEqual(['list', 'participant']);
    const star = hold.startHold(SID, { legSid: LEG }); // generation 2, decided while the old step is in flight
    await flush();
    expect(holdOf()).toMatchObject({ gen: 2, phase: 'held', applied: null, count: 2 });
    land();
    await flush();
    await advance(500);
    await recovery;
    expect(await star).toBe('held');
    // The old step's outcome was bound to generation 1 (ignored); the same sender then sent generation 2's hold, after it.
    expect(names(events)).toEqual(['list', 'participant', 'recording', 'list', 'participant', 'recording']);
    expect(events.filter((e) => e.name === 'participant').map((e) => e.hold)).toEqual([false, true]);
    expect(statuses(events)).toEqual(['in-progress', 'paused']);
    expect(holdOf()).toMatchObject({ gen: 2, phase: 'held', applied: 'held', count: 2 });
  });

  test('5c. an old generation\'s hold request that answers late never marks the newer hold as placed', async () => {
    seed(heldHold({ gen: 2, applied: null, count: 2 }));
    await hold._test.decide(SID, { type: 'step_done', gen: 1, step: 'hold' }); // generation 1's request, answering late
    expect(holdOf()).toMatchObject({ gen: 2, phase: 'held', applied: null });
    const events = fakeTwilio();
    expect(await hold.checkHold(SID)).toMatchObject({ applied: 'held' }); // generation 2 still gets its own hold request
    expect(names(events)).toEqual(['list', 'participant', 'recording']);
  });

  test('5b. a star that cannot get its hold request out in time aborts its hold: failed, and the caller is unheld by a later sender', async () => {
    seed(heldHold({ phase: 'returned', ret_by: 'abort', applied: null, sender: { token: 'other', until: NOW.getTime() + 60 * 1000 } }));
    const events = fakeTwilio();
    const star = hold.startHold(SID, { legSid: LEG });
    await flush();
    await advance(7000);
    expect(await star).toBe('failed');
    expect(events).toHaveLength(0); // the other sender's lease was live the whole time
    expect(holdOf()).toMatchObject({ gen: 2, phase: 'returned', ret_by: 'abort' });
  });

  test('5d. a star whose wait ends just as another sender confirms the hold answers held, and the hold is not aborted', async () => {
    seed(heldHold({ phase: 'returned', ret_by: 'abort', applied: null, sender: { token: 'other', until: NOW.getTime() + 60 * 1000 } }));
    const events = fakeTwilio();
    const star = hold.startHold(SID, { legSid: LEG });
    await flush();
    expect(holdOf()).toMatchObject({ gen: 2, phase: 'held', applied: null });
    // The other sender's hold request lands; this star's next claim and read fail, so its wait ends without seeing it.
    await hold._test.decide(SID, { type: 'step_done', gen: 2, step: 'hold' });
    db.__state.failReads = 2;
    await advance(300);
    expect(await star).toBe('held');
    expect(holdOf()).toMatchObject({ gen: 2, phase: 'held', applied: 'held', ret_by: null });
    expect(events).toHaveLength(0);
  });

  test('6a. a sender that stalled past its lease and was taken over sends nothing more and records nothing', async () => {
    seed(heldHold({ applied: null }));
    // While its hold request is in flight, another sender takes the lease over (this one stalled past LEASE_MS).
    const events = fakeTwilio({
      during: { participant: once(async () => { holdOf().sender = { token: 'other', until: Date.now() + 60 * 1000 }; }) },
    });
    expect(await hold.checkHold(SID)).toMatchObject({ phase: 'held', applied: null });
    expect(names(events)).toEqual(['list', 'participant']); // the recording pause never went out
    expect(holdOf()).toMatchObject({ applied: null, sender: { token: 'other' } });
  });

  test('6b. the fence extends the lease right before each request', async () => {
    seed(heldHold({ applied: null }));
    const seen = [];
    const events = fakeTwilio({
      during: {
        participant: once(async () => { jest.setSystemTime(new Date(NOW.getTime() + 3000)); }),
        recording: once(async () => { seen.push(holdOf().sender.until); }),
      },
    });
    await hold.checkHold(SID);
    expect(names(events)).toEqual(['list', 'participant', 'recording']);
    expect(seen).toEqual([NOW.getTime() + 3000 + hold.LEASE_MS]);
  });

  test('6c. a voicemail step is fenced too: a sender taken over before the room end ends no room', async () => {
    seed(heldHold({ phase: 'voicemail', voicemail_reason: 'timeout', voicemail_at: iso(-1) }));
    const events = fakeTwilio();
    const list = mockTw.api.conferences.list;
    mockTw.api.conferences.list = jest.fn(async (params) => {
      const rooms = await list(params);
      holdOf().sender = { token: 'other', until: Date.now() + 60 * 1000 };
      return rooms;
    });
    await hold.checkHold(SID);
    expect(names(events)).toEqual(['list']);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(holdOf()).toMatchObject({ phase: 'voicemail', applied: 'held' });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('two server processes sharing one database', () => {
  const instances = [];
  function loadInstance() {
    let inst;
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => db);
      inst = require('../services/call-hold');
    });
    instances.push(inst);
    return inst;
  }

  test('a press 1 on one process and the 5 minute limit on the other decide at once: exactly one wins, in either order', async () => {
    for (const order of ['press1 first', 'limit first']) {
      seed(heldHold({ open_at: iso(-300) }));
      db.__state.writes = [];
      const a = loadInstance();
      const b = loadInstance();
      const events = fakeTwilio();
      const runs = order === 'press1 first' ? [a.endHold(SID), b.checkHold(SID)] : [b.checkHold(SID), a.endHold(SID)];
      const results = await Promise.all(runs);
      const press = order === 'press1 first' ? results[0] : results[1];
      if (order === 'press1 first') {
        expect(press).toBe('returned');
        expect(names(events)).toEqual(['list', 'participant', 'recording']);
        expect(holdOf()).toMatchObject({ phase: 'returned', applied: 'returned', voicemail_at: null });
      } else {
        expect(press).toBe('voicemail');
        expect(names(events)).toEqual(['list', 'room']);
        expect(holdOf()).toMatchObject({ phase: 'voicemail', applied: 'voicemail' });
      }
    }
  });

  test('a step in flight on one process: the other sends nothing until it lands, then its own newer step goes out after it', async () => {
    seed();
    const a = loadInstance();
    const b = loadInstance();
    let land;
    const events = fakeTwilio({ during: { participant: once(() => new Promise((resolve) => { land = resolve; })) } });
    const star = a.startHold(SID, { legSid: LEG }); // a new hold: A decides it and sends the hold request
    await flush();
    expect(names(events)).toEqual(['list', 'participant']);
    // B decides the voicemail (the staff hung up) and tries: the lease is live, so it sends nothing.
    await expect(b.staffLeft(SID)).resolves.toBe('voicemail');
    expect(names(events)).toEqual(['list', 'participant']);
    land();
    await flush();
    await advance(500);
    await star;
    // The hold request landed first; then A's pass re-read the newer decision and ended the room.
    expect(names(events)).toEqual(['list', 'participant', 'recording', 'list', 'room']);
    expect(holdOf()).toMatchObject({ phase: 'voicemail', applied: 'voicemail', sender: null });
  });

  test('an expired lease (a crashed sender) is taken over by the next fetch', async () => {
    seed(heldHold({ applied: null, phase: 'held', sender: { token: 'crashed', until: NOW.getTime() - 1 } }));
    const b = loadInstance();
    const events = fakeTwilio();
    expect(await b.checkHold(SID)).toMatchObject({ phase: 'held', applied: 'held' });
    expect(names(events)).toEqual(['list', 'participant', 'recording']);
    expect(holdOf().sender).toBeNull();
  });

  test('a live lease of another sender is respected by every loop fetch', async () => {
    seed(heldHold({ applied: null, phase: 'held', sender: { token: 'busy', until: NOW.getTime() + 5000 } }));
    const b = loadInstance();
    const events = fakeTwilio();
    expect(await b.checkHold(SID)).toMatchObject({ phase: 'held', applied: null });
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------
// The two pending states: a recording resume that was not confirmed after a press 1 (rec_pending, step 'resume') and a
// voicemail callback bell that was not written (alert_pending, step 'alert').
const returnedPending = (o = {}) => heldHold({ phase: 'returned', ret_by: 'press1', applied: 'returned', rec_pending: true, ...o });
const voicemailPending = (o = {}) => heldHold({ phase: 'voicemail', voicemail_reason: 'timeout', voicemail_at: iso(-1), applied: 'voicemail', alert_pending: true, ...o });

describe('planner: pending resume and pending bell (pure)', () => {
  const { planEvent, nextStep, planClaim } = hold._test;
  const T = NOW.getTime();
  const plan = (h, ev, closed = false) => planEvent(h, ev, T, closed);

  test.each([
    ['a return not confirmed', 'return', heldHold({ phase: 'returned', ret_by: 'press1', applied: 'held', rec_pending: true })],
    ['a confirmed return with the resume pending', 'resume', returnedPending()],
    ['a confirmed return, resume confirmed', null, returnedPending({ rec_pending: false })],
    ['an aborted star', 'return', heldHold({ phase: 'returned', ret_by: 'abort', applied: null })],
    ['a stale flag on a held hold', null, heldHold({ rec_pending: true })],
    ['a confirmed voicemail with the bell pending', 'alert', voicemailPending()],
    ['a confirmed voicemail, bell delivered', null, voicemailPending({ alert_pending: false, alerted_at: iso(0) })],
    ['a voicemail not yet confirmed', 'voicemail', voicemailPending({ applied: 'held' })],
    ['a voicemail whose step failed (re-hold first)', 'rehold', voicemailPending({ applied: 'returned', vm_failed: true })],
  ])('the step wanted on %s is %s', (_name, step, state) => {
    expect(nextStep(state)).toBe(step);
  });

  test('a confirmed return records whether the resume was confirmed; only a confirmed unhold is applied either way', () => {
    const inFlight = heldHold({ phase: 'returned', ret_by: 'press1', applied: 'held' });
    expect(plan(inFlight, { type: 'step_done', gen: 1, step: 'return', resumed: false }).next).toMatchObject({ applied: 'returned', rec_pending: true });
    expect(plan(inFlight, { type: 'step_done', gen: 1, step: 'return', resumed: true }).next).toMatchObject({ applied: 'returned', rec_pending: false });
    // A room that was gone has nothing to resume; a voicemail decided meanwhile resumes the recording itself.
    expect(plan(inFlight, { type: 'step_done', gen: 1, step: 'return', gone: true }).next.rec_pending).toBe(false);
    const voiced = heldHold({ phase: 'voicemail', applied: 'held', voicemail_reason: 'staff_left' });
    expect(plan(voiced, { type: 'step_done', gen: 1, step: 'return', resumed: false }).next.rec_pending).toBe(false);
  });

  test('a resume confirmed clears rec_pending; the terminal codes clear it; any other failure keeps it', () => {
    expect(plan(returnedPending({ last_error_code: '500' }), { type: 'step_done', gen: 1, step: 'resume' }).next)
      .toMatchObject({ rec_pending: false, applied: 'returned', last_error_code: null });
    ['16108', '21220', '20404'].forEach((code) => {
      expect(plan(returnedPending(), { type: 'step_failed', gen: 1, step: 'resume', code }).next).toMatchObject({ rec_pending: false, last_error_code: code });
    });
    expect(plan(returnedPending(), { type: 'step_failed', gen: 1, step: 'resume', code: '51000' }).next).toMatchObject({ rec_pending: true, applied: 'returned', last_error_code: '51000' });
    expect(plan(returnedPending(), { type: 'step_failed', gen: 1, step: 'resume', code: 'ECONNRESET' }).next.rec_pending).toBe(true);
  });

  test('the voicemail step records alert_pending in the same write that confirms it; a gone caller has no bell', () => {
    const unconfirmed = heldHold({ phase: 'voicemail', voicemail_reason: 'timeout' });
    expect(plan(unconfirmed, { type: 'step_done', gen: 1, step: 'voicemail', gone: false }).next).toMatchObject({ applied: 'voicemail', alert_pending: true });
    expect(plan(unconfirmed, { type: 'step_done', gen: 1, step: 'voicemail', gone: true }).next).toMatchObject({ applied: 'voicemail', alert_pending: false });
  });

  test('a delivered bell clears alert_pending and stamps alerted_at; an undelivered one keeps it', () => {
    expect(plan(voicemailPending(), { type: 'step_done', gen: 1, step: 'alert' }).next).toMatchObject({ alert_pending: false, alerted_at: iso(0), applied: 'voicemail', phase: 'voicemail' });
    expect(plan(voicemailPending(), { type: 'step_failed', gen: 1, step: 'alert', code: 'alert' }).next).toMatchObject({ alert_pending: true, applied: 'voicemail', last_error_code: 'alert' });
    const settled = voicemailPending({ alert_pending: false, alerted_at: iso(-30) });
    expect(plan(settled, { type: 'step_done', gen: 1, step: 'alert' }).next).toBe(settled); // a late duplicate rewrites nothing
  });

  test('both step outcomes bind to the generation, and resume_over clears only a pending resume', () => {
    const current = returnedPending({ gen: 2 });
    expect(plan(current, { type: 'step_done', gen: 1, step: 'resume' }).next).toBe(current);
    expect(plan(current, { type: 'step_failed', gen: 1, step: 'resume', code: '21220' }).next).toBe(current);
    expect(plan(voicemailPending({ gen: 2 }), { type: 'step_done', gen: 1, step: 'alert' }).next.alert_pending).toBe(true);
    expect(plan(current, { type: 'resume_over' }).next).toMatchObject({ rec_pending: false, applied: 'returned' });
    const none = heldHold({ phase: 'returned', ret_by: 'press1', applied: 'returned' });
    expect(plan(none, { type: 'resume_over' }).next).toBe(none);
    expect(plan(null, { type: 'resume_over' }).next).toBeNull();
  });

  test('a pending resume or bell never blocks a new decision: star, press 1 and the staff hang-up answer as without it', () => {
    expect(plan(returnedPending(), { type: 'press1' })).toMatchObject({ answer: 'closed' });
    expect(plan(returnedPending(), { type: 'staff_left' })).toMatchObject({ answer: 'ordinary' });
    expect(plan(returnedPending(), { type: 'check' }).answer).toEqual({ remind: false });
    expect(plan(voicemailPending(), { type: 'star' })).toMatchObject({ answer: 'no_room' });
    expect(plan(voicemailPending(), { type: 'press1' })).toMatchObject({ answer: 'voicemail' });
    expect(plan(voicemailPending(), { type: 'staff_left' })).toMatchObject({ answer: 'voicemail' });
  });

  test('a new generation starts with no pending resume and no pending bell', () => {
    const out = plan(returnedPending({ alert_pending: true }), { type: 'star', legSid: LEG });
    expect(out).toMatchObject({ answer: 'start', next: { gen: 2, phase: 'held', applied: null, rec_pending: false, alert_pending: false } });
  });

  test('the claim: a closed call sends no resume (the flag is cleared at once) but still raises its bell; a live lease is busy', () => {
    const closedResume = planClaim(returnedPending({ sender: { token: 'me', until: T + 1000 } }), 'me', T, true);
    expect(closedResume.res).toEqual({ send: null });
    expect(closedResume.next).toMatchObject({ rec_pending: false, sender: null });
    expect(planClaim(voicemailPending(), 'me', T, true).res).toMatchObject({ send: 'alert', gen: 1, reason: 'timeout' });
    expect(planClaim(returnedPending(), 'me', T, false)).toMatchObject({ res: { send: 'resume', gen: 1 }, next: { sender: { token: 'me', until: T + hold.LEASE_MS } } });
    expect(planClaim(returnedPending({ sender: { token: 'other', until: T + 1000 } }), 'me', T, false).res).toEqual({ send: null, busy: true });
    expect(planClaim(voicemailPending({ sender: { token: 'other', until: T + 1000 } }), 'me', T, false).res).toEqual({ send: null, busy: true });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('a recording resume that fails after a press 1', () => {
  const instances = [];
  function loadInstance() {
    let inst;
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => db);
      inst = require('../services/call-hold');
    });
    instances.push(inst);
    return inst;
  }
  const recordings = (events) => events.filter((e) => e.name === 'recording');
  const alwaysFail = () => err500();

  test('press 1 still answers returned and the staff rejoin; the pass tries the resume once more; rec_pending stays', async () => {
    seed(heldHold({ open_at: iso(-30) }));
    const events = fakeTwilio({ fail: { recording: alwaysFail } });
    expect(await hold.endHold(SID)).toBe('returned');
    expect(names(events)).toEqual(['list', 'participant', 'recording', 'recording']);
    expect(events[1]).toMatchObject({ hold: false });
    expect(holdOf()).toMatchObject({ phase: 'returned', applied: 'returned', ret_by: 'press1', rec_pending: true, last_error_code: '51000', sender: null });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('NOT resumed'));
  });

  test('a confirmed resume leaves nothing pending and no timer', async () => {
    seed(heldHold());
    const events = fakeTwilio();
    expect(await hold.endHold(SID)).toBe('returned');
    expect(recordings(events)).toHaveLength(1);
    expect(holdOf().rec_pending).toBe(false);
    expect(hold._test.resumeRetries.size).toBe(0);
  });

  test('the backoff retries after 2 s and resumes; the retry is a fenced resume request only (no room lookup, no unhold)', async () => {
    seed(heldHold());
    const events = fakeTwilio({ fail: { recording: (n) => (n <= 2 ? err500() : null) } });
    expect(await hold.endHold(SID)).toBe('returned');
    expect(holdOf().rec_pending).toBe(true);
    expect(hold._test.resumeRetries.size).toBe(1);
    await advance(1999);
    expect(recordings(events)).toHaveLength(2);
    await advance(1);
    expect(names(events)).toEqual(['list', 'participant', 'recording', 'recording', 'recording']);
    expect(holdOf()).toMatchObject({ rec_pending: false, applied: 'returned', last_error_code: null, sender: null });
    await advance(60000);
    expect(recordings(events)).toHaveLength(3);
    expect(hold._test.resumeRetries.size).toBe(0);
  });

  test('the backoff waits 2, 4, 8 and 16 s and stops after the fourth try; the state stays pending for the sweep', async () => {
    seed(heldHold());
    const events = fakeTwilio({ fail: { recording: alwaysFail } });
    await hold.endHold(SID);
    expect(recordings(events)).toHaveLength(2);
    const seen = [];
    for (const wait of [2000, 4000, 8000, 16000]) {
      await advance(wait - 1);
      seen.push(recordings(events).length);
      await advance(1);
      seen.push(recordings(events).length);
    }
    expect(seen).toEqual([2, 3, 3, 4, 4, 5, 5, 6]);
    await advance(120000);
    expect(recordings(events)).toHaveLength(6);
    expect(hold._test.resumeRetries.size).toBe(0);
    expect(holdOf()).toMatchObject({ rec_pending: true, applied: 'returned' });
  });

  test('a retry chain is one per call: a second failed resume does not stack a second timer', async () => {
    seed(returnedPending());
    const events = fakeTwilio({ fail: { recording: alwaysFail } });
    await hold.checkHold(SID);
    await advance(1000);
    await hold.checkHold(SID); // a second failed pass while the first retry is waiting
    expect(hold._test.resumeRetries.size).toBe(1);
    expect(recordings(events)).toHaveLength(2);
    await advance(1000); // the first chain's 2 s retry
    expect(recordings(events)).toHaveLength(3);
    await advance(1000); // a stacked second timer would have fired here
    expect(recordings(events)).toHaveLength(3);
  });

  test.each(['16108', '21220', '20404'])('Twilio code %s cannot be retried: the pending state is cleared with a log, and nothing is retried', async (code) => {
    seed(heldHold());
    const events = fakeTwilio({ fail: { recording: () => err(400, Number(code)) } });
    expect(await hold.endHold(SID)).toBe('returned');
    expect(recordings(events)).toHaveLength(2);
    expect(holdOf()).toMatchObject({ rec_pending: false, applied: 'returned', last_error_code: code });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(`code ${code} cannot be retried`));
    expect(hold._test.resumeRetries.size).toBe(0);
    await advance(60000);
    expect(recordings(events)).toHaveLength(2);
  });

  test('a pending resume never blocks: a duplicate press 1 answers returned with no Twilio call, the staff hang-up gets the ordinary room end', async () => {
    seed(returnedPending());
    const events = fakeTwilio();
    expect(await hold.endHold(SID)).toBe('returned');
    expect(events).toHaveLength(0);
    expect(await hold.staffLeft(SID)).toBe('ordinary');
    expect(events).toHaveLength(0);
  });

  test('a new star clears it (its own hold pauses the recording again): no resume goes out, and a late resume of the old generation is ignored', async () => {
    seed(returnedPending());
    const events = fakeTwilio();
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
    expect(statuses(events)).toEqual(['paused']);
    expect(holdOf()).toMatchObject({ gen: 2, phase: 'held', applied: 'held', rec_pending: false });
    await hold._test.decide(SID, { type: 'step_done', gen: 1, step: 'resume' });
    expect(holdOf()).toMatchObject({ gen: 2, rec_pending: false, applied: 'held' });
  });

  test('a star arriving while the retry resume is in flight: the resume lands first (one sender), then the new hold pauses', async () => {
    seed(returnedPending());
    let land;
    const events = fakeTwilio({ during: { recording: once(() => new Promise((resolve) => { land = resolve; })) } });
    const retry = hold.checkHold(SID);
    await flush();
    expect(statuses(events)).toEqual(['in-progress']);
    const star = hold.startHold(SID, { legSid: LEG });
    await flush();
    expect(holdOf()).toMatchObject({ gen: 2, phase: 'held', applied: null });
    land();
    await flush();
    await advance(500);
    await retry;
    expect(await star).toBe('held');
    expect(statuses(events)).toEqual(['in-progress', 'paused']);
    expect(holdOf()).toMatchObject({ gen: 2, applied: 'held', rec_pending: false });
  });

  test('the sweep resumes it after a restart (a fresh module instance, no timers), once, with no retry timer of its own', async () => {
    seed(returnedPending());
    const fresh = loadInstance();
    expect(fresh._test.resumeRetries.size).toBe(0);
    const events = fakeTwilio();
    expect(await fresh.recoverPendingHolds()).toMatchObject({ action: 'swept', open: 1 });
    expect(names(events)).toEqual(['recording']);
    expect(events[0]).toMatchObject({ sid: SID, which: 'Twilio.CURRENT', status: 'in-progress' });
    expect(holdOf()).toMatchObject({ rec_pending: false, sender: null });
    expect(await fresh.recoverPendingHolds()).toMatchObject({ open: 0 });
    expect(events).toHaveLength(1);
  });

  test('a sweep whose resume fails leaves it pending, tries once per minute, and starts no backoff chain', async () => {
    seed(returnedPending());
    const fresh = loadInstance();
    const events = fakeTwilio({ fail: { recording: alwaysFail } });
    await fresh.recoverPendingHolds();
    await fresh.recoverPendingHolds();
    expect(recordings(events)).toHaveLength(2);
    expect(fresh._test.resumeRetries.size).toBe(0);
    expect(holdOf().rec_pending).toBe(true);
  });

  test('an ended call (a terminal status) is cleared with no Twilio request', async () => {
    seed(returnedPending());
    db.__state.row.status = 'completed';
    const events = fakeTwilio();
    expect(await hold.recoverPendingHolds()).toMatchObject({ action: 'swept', open: 1 });
    expect(events).toHaveLength(0);
    expect(holdOf()).toMatchObject({ rec_pending: false, applied: 'returned' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('the call is over'));
  });

  test('an ended call (metadata.ended_at, or a closed room) is cleared with no Twilio request', async () => {
    seed(returnedPending());
    db.__state.row.metadata.ended_at = '2026-11-17T14:59:00Z';
    const events = fakeTwilio();
    await hold.recoverPendingHolds();
    expect(events).toHaveLength(0);
    expect(holdOf().rec_pending).toBe(false);
    seed(returnedPending(), { closed_at: '2026-11-17T14:59:00Z' });
    await hold.checkHold(SID); // a loop fetch on a closed call: the claim clears it, nothing is sent
    expect(events).toHaveLength(0);
    expect(holdOf().rec_pending).toBe(false);
  });

  test('two server processes sweeping at once send one resume', async () => {
    seed(returnedPending());
    const a = loadInstance();
    const b = loadInstance();
    const events = fakeTwilio();
    await Promise.all([a.recoverPendingHolds(), b.recoverPendingHolds()]);
    expect(recordings(events)).toHaveLength(1);
    expect(holdOf().rec_pending).toBe(false);
  });

  test('a sweep against a live lease (a resume in flight on another process) sends nothing', async () => {
    seed(returnedPending({ sender: { token: 'other', until: NOW.getTime() + 5000 } }));
    const events = fakeTwilio();
    await hold.recoverPendingHolds();
    expect(events).toHaveLength(0);
    expect(holdOf()).toMatchObject({ rec_pending: true, sender: { token: 'other' } });
  });

  test('a sender that stalled past its lease sends no resume (fenced) and records nothing', async () => {
    seed(returnedPending());
    const events = fakeTwilio();
    // Another sender takes the lease over between this pass's claim and its request (the fence's transaction).
    const original = db.transaction;
    let stolen = false;
    db.transaction = jest.fn(async (fn) => {
      if (!stolen && holdOf()?.sender) { stolen = true; holdOf().sender = { token: 'other', until: Date.now() + 60000 }; }
      return original(fn);
    });
    await hold.checkHold(SID);
    db.transaction = original;
    expect(events).toHaveLength(0);
    expect(holdOf()).toMatchObject({ rec_pending: true, sender: { token: 'other' } });
  });
});

// ---------------------------------------------------------------------------------------------------------
describe('the voicemail answer wants the bell (a room end whose answer was lost)', () => {
  const limit = () => seed(heldHold({ open_at: iso(-300) }));
  // The room end lands but its answer is lost: the room is gone, and the step reads a timeout.
  const lostEnd = (rooms) => ({
    rooms,
    fail: { room: (n) => { if (n !== 1) return null; rooms.length = 0; return Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }); } },
  });

  test('the planner: wanted once; a late retry that reads no room keeps it wanted; a new hold starts with none', () => {
    const { planEvent } = hold._test;
    const T = NOW.getTime();
    const vm = heldHold({ phase: 'voicemail', voicemail_at: iso(0), voicemail_reason: 'timeout' });
    const answered = planEvent(vm, { type: 'vm_answered' }, T, false);
    expect(answered).toMatchObject({ answer: 'alert', next: { applied: 'voicemail', alert_pending: true, vm_answered_at: NOW.toISOString() } });
    expect(planEvent(answered.next, { type: 'step_done', gen: 1, step: 'voicemail', gone: true }, T, false).next).toMatchObject({ alert_pending: true, gone: true });
    expect(planEvent(answered.next, { type: 'vm_answered' }, T, false)).toEqual({ next: answered.next, answer: 'alert' });
    const delivered = { ...answered.next, alert_pending: false, alerted_at: iso(1) };
    expect(planEvent(delivered, { type: 'vm_answered' }, T, false)).toEqual({ next: delivered, answer: null });
    expect(planEvent(delivered, { type: 'step_done', gen: 1, step: 'voicemail', gone: false }, T, false).next.alert_pending).toBe(false);
    for (const h of [heldHold(), heldHold({ phase: 'returned', applied: 'returned' }), null]) {
      expect(planEvent(h, { type: 'vm_answered' }, T, false)).toEqual({ next: h, answer: null });
    }
    // A star never starts a hold over a voicemail; a new generation (after a return) starts with no voicemail answer.
    expect(planEvent(delivered, { type: 'star', by: 'star', legSid: LEG }, T, false).next).toBe(delivered);
    const stale = heldHold({ phase: 'returned', applied: 'returned', ret_by: 'press1', vm_answered_at: iso(-60) });
    expect(planEvent(stale, { type: 'star', by: 'star', legSid: LEG }, T, false).next).toMatchObject({ gen: 2, phase: 'held', alert_pending: false, vm_answered_at: null });
  });

  test('the voicemail answer arrives first: one bell, and no room end is tried again', async () => {
    limit();
    const events = fakeTwilio(lostEnd([{ sid: ROOM }]));
    expect(await hold.checkHold(SID)).toMatchObject({ phase: 'voicemail', applied: 'held' });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    await hold.voicemailAnswered(SID);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(holdOf()).toMatchObject({ applied: 'voicemail', alert_pending: false, alerted_at: expect.any(String), vm_answered_at: expect.any(String) });
    await hold.checkHold(SID);
    expect(names(events)).toEqual(['list', 'room']);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('the retry reads no room first (caller gone): the voicemail answer still raises the one bell, once', async () => {
    limit();
    fakeTwilio(lostEnd([{ sid: ROOM }]));
    await hold.checkHold(SID);
    expect(await hold.checkHold(SID)).toMatchObject({ applied: 'voicemail', gone: true });
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    await hold.voicemailAnswered(SID);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    await hold.voicemailAnswered(SID);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('a voicemail answer for a hold not in voicemail changes nothing, and a database error is only logged', async () => {
    seed(heldHold());
    fakeTwilio();
    await hold.voicemailAnswered(SID);
    expect(holdOf()).toMatchObject({ phase: 'held', applied: 'held' });
    expect(holdOf().vm_answered_at).toBeFalsy();
    limit();
    db.__state.failReads = 1;
    await expect(hold.voicemailAnswered(SID)).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('voicemail answer not recorded'));
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });
});

describe('a card-pause window holds the recording (live-call-card-pause.js)', () => {
  const cardPause = require('../services/live-call-card-pause');

  test('a press 1 inside an open card-pause window sends no resume and leaves nothing pending: the window end resumes it', async () => {
    seed(heldHold());
    const events = fakeTwilio();
    mockCard.answer = { sent: false, reason: 'card_window' };
    expect(await hold.endHold(SID)).toBe('returned');
    expect(names(events)).toEqual(['list', 'participant']);
    expect(holdOf()).toMatchObject({ phase: 'returned', applied: 'returned', rec_pending: false, sender: null });
    expect(cardPause.resumeOutsideCardWindow).toHaveBeenCalledTimes(1);
    expect(cardPause.resumeOutsideCardWindow).toHaveBeenCalledWith(SID, expect.any(Function));
    expect(hold._test.resumeRetries.size).toBe(0);
  });

  test('a card-pause request in flight keeps the resume pending, and the backoff sends it once the card pause lets it through', async () => {
    seed(heldHold());
    const events = fakeTwilio();
    let n = 0;
    mockCard.answer = () => { n += 1; return n <= 2 ? { sent: false, reason: 'busy' } : null; };
    expect(await hold.endHold(SID)).toBe('returned');
    expect(statuses(events)).toEqual([]);
    expect(holdOf()).toMatchObject({ rec_pending: true, last_error_code: 'card_busy' });
    await advance(2000);
    expect(statuses(events)).toEqual(['in-progress']);
    expect(holdOf()).toMatchObject({ rec_pending: false, last_error_code: null });
  });

  test('a card-pause check that fails sends nothing and leaves the resume pending (never resumed blind)', async () => {
    seed(heldHold());
    const events = fakeTwilio();
    mockCard.answer = () => { throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); };
    expect(await hold.endHold(SID)).toBe('returned');
    expect(statuses(events)).toEqual([]);
    expect(holdOf()).toMatchObject({ rec_pending: true, last_error_code: 'card_check' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('the card-pause check failed (ECONNRESET)'));
  });

  test('a resume the card pause refuses because a newer hold holds the caller (hold_held) counts as done: that hold\'s return resumes it', async () => {
    seed(heldHold());
    const events = fakeTwilio();
    mockCard.answer = { sent: false, reason: 'hold_held' };
    expect(await hold.endHold(SID)).toBe('returned');
    expect(statuses(events)).toEqual([]);
    expect(holdOf()).toMatchObject({ phase: 'returned', applied: 'returned', rec_pending: false });
    expect(hold._test.resumeRetries.size).toBe(0);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('a newer hold holds the caller'));
  });

  test('the voicemail resume inside an open card-pause window answers false and sends nothing, so no message is invited', async () => {
    seed(null);
    const events = fakeTwilio();
    mockCard.answer = { sent: false, reason: 'card_window' };
    expect(await hold.resumeRecording(SID)).toBe(false);
    expect(statuses(events)).toEqual([]);
    mockCard.answer = null;
    expect(await hold.resumeRecording(SID)).toBe(true);
    expect(statuses(events)).toEqual(['in-progress']);
  });
});

describe('a voicemail callback bell that is not delivered', () => {
  const instances = [];
  function loadInstance() {
    let inst;
    jest.isolateModules(() => {
      jest.doMock('../models/db', () => db);
      inst = require('../services/call-hold');
    });
    instances.push(inst);
    return inst;
  }
  const limit = () => seed(heldHold({ open_at: iso(-300) }));

  test('the voicemail is confirmed and the bell is pending in the same record; the pass then raises the bell and clears it', async () => {
    limit();
    fakeTwilio();
    await hold.checkHold(SID);
    const writes = db.__state.writes;
    const confirmed = writes.findIndex((w) => w.applied === 'voicemail');
    expect(writes[confirmed]).toMatchObject({ applied: 'voicemail', alert_pending: true });
    expect(writes.slice(0, confirmed).every((w) => w.alert_pending !== true)).toBe(true);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(holdOf()).toMatchObject({ applied: 'voicemail', alert_pending: false, alerted_at: NOW.toISOString(), sender: null });
  });

  test('a null answer (notifyAdmin resolves null on a database failure) is not delivered: alert_pending stays, the room end stands', async () => {
    limit();
    raiseAdminAlert.mockResolvedValueOnce(null);
    const events = fakeTwilio();
    expect(await hold.checkHold(SID)).toMatchObject({ phase: 'voicemail', applied: 'voicemail' });
    expect(names(events)).toEqual(['list', 'room']);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1); // one try per pass
    expect(holdOf()).toMatchObject({ applied: 'voicemail', alert_pending: true, sender: null });
    expect(holdOf().alerted_at).toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not written'));
  });

  test('a throw is not delivered either: alert_pending stays, logged by code', async () => {
    limit();
    raiseAdminAlert.mockRejectedValueOnce(Object.assign(new Error('x'), { code: 'EBELL' }));
    fakeTwilio();
    await hold.checkHold(SID);
    expect(holdOf()).toMatchObject({ applied: 'voicemail', alert_pending: true });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('(EBELL)'));
  });

  test.each([
    ['a row with an id', { id: 'n9' }, false],
    ['an intentional suppression', { id: null, suppressed: true, reason: 'fyi' }, false],
    ['an answer with neither', {}, true],
    ['undefined', undefined, true],
    ['a null id with no suppression', { id: null }, true],
  ])('%s: pending stays %s', async (_name, answer, pending) => {
    limit();
    raiseAdminAlert.mockResolvedValueOnce(answer);
    fakeTwilio();
    await hold.checkHold(SID);
    expect(holdOf().alert_pending).toBe(pending);
    expect(holdOf().alerted_at === undefined).toBe(pending);
  });

  test('a dedupe hit (the first bell was written, only its answer was lost) is delivered: the key is the same on every retry', async () => {
    limit();
    raiseAdminAlert.mockResolvedValueOnce(null);
    fakeTwilio();
    await hold.checkHold(SID);
    raiseAdminAlert.mockResolvedValueOnce({ id: 'n1', deduped: true });
    await hold.recoverPendingHolds();
    expect(raiseAdminAlert.mock.calls.map((c) => c[2].dedupeKey)).toEqual([`call-hold-voicemail:${SID}`, `call-hold-voicemail:${SID}`]);
    expect(holdOf().alert_pending).toBe(false);
  });

  test('the sweep delivers it once, and an idle sweep afterwards raises nothing more', async () => {
    limit();
    raiseAdminAlert.mockResolvedValueOnce(null);
    const events = fakeTwilio();
    await hold.checkHold(SID);
    expect(holdOf().alert_pending).toBe(true);
    expect(await hold.recoverPendingHolds()).toMatchObject({ action: 'swept', open: 1 });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(2);
    expect(holdOf()).toMatchObject({ alert_pending: false, alerted_at: NOW.toISOString() });
    expect(await hold.recoverPendingHolds()).toMatchObject({ open: 0 });
    expect(raiseAdminAlert).toHaveBeenCalledTimes(2);
    expect(names(events)).toEqual(['list', 'room']); // the bell needs no Twilio request, and the room is not ended twice
  });

  test('a failing sweep pass keeps it pending for the next minute, once per sweep', async () => {
    seed(voicemailPending());
    raiseAdminAlert.mockResolvedValue(null);
    await hold.recoverPendingHolds();
    await hold.recoverPendingHolds();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(2);
    expect(holdOf().alert_pending).toBe(true);
    raiseAdminAlert.mockResolvedValue({ id: 'n1' });
    await hold.recoverPendingHolds();
    expect(holdOf().alert_pending).toBe(false);
  });

  test('the bell is raised for a call that has already ended (the caller left a message and hung up)', async () => {
    seed(voicemailPending(), { closed_at: '2026-11-17T14:59:00Z' });
    db.__state.row.status = 'completed';
    const events = fakeTwilio();
    await hold.recoverPendingHolds();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    expect(events).toHaveLength(0);
    expect(holdOf().alert_pending).toBe(false);
  });

  test('two server processes sweeping at once raise one bell', async () => {
    seed(voicemailPending());
    const a = loadInstance();
    const b = loadInstance();
    fakeTwilio();
    await Promise.all([a.recoverPendingHolds(), b.recoverPendingHolds()]);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1); // the mock is shared by both module instances
    expect(holdOf().alert_pending).toBe(false);
  });

  test('a sender that stalled past its lease raises no bell (fenced): the new lease holder owns it', async () => {
    seed(voicemailPending());
    const original = db.transaction;
    let stolen = false;
    db.transaction = jest.fn(async (fn) => {
      if (!stolen && holdOf()?.sender) { stolen = true; holdOf().sender = { token: 'other', until: Date.now() + 60000 }; }
      return original(fn);
    });
    await hold.recoverPendingHolds();
    db.transaction = original;
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(holdOf()).toMatchObject({ alert_pending: true, sender: { token: 'other' } });
  });

  test('a live lease of another sender is respected: nothing is raised', async () => {
    seed(voicemailPending({ sender: { token: 'other', until: NOW.getTime() + 5000 } }));
    await hold.recoverPendingHolds();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(holdOf().alert_pending).toBe(true);
  });

  test('the sweep ignores the gate: with GATE_CALL_HOLD off it still finishes both pending states', async () => {
    const gates = require('../config/feature-gates');
    gates.callHoldLive.mockReturnValue(false);
    seed(voicemailPending());
    await hold.recoverPendingHolds();
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    seed(returnedPending());
    const events = fakeTwilio();
    await hold.recoverPendingHolds();
    expect(statuses(events)).toEqual(['in-progress']);
    gates.callHoldLive.mockReturnValue(true);
  });

  test('a sandbox call is never read: the sweep applies the shared sandbox guard', async () => {
    seed(voicemailPending());
    db.__state.row.source = VOICE_RELAY_SANDBOX_SOURCE;
    expect(await hold.recoverPendingHolds()).toMatchObject({ action: 'swept', open: 0 });
    expect(db.__state.modifyCalls.map((c) => c.bindings)).toEqual([['source', VOICE_RELAY_SANDBOX_SOURCE], ['source', 'tech_voice']]);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    expect(holdOf().alert_pending).toBe(true);
  });

  test('an idle sweep is one read: no transaction, no Twilio request, no bell', async () => {
    seed(heldHold({ phase: 'returned', ret_by: 'press1', applied: 'returned' }));
    const events = fakeTwilio();
    expect(await hold.recoverPendingHolds()).toEqual({ action: 'swept', open: 0 });
    expect(db.__state.sweeps).toBe(1);
    expect(db.__state.txCount).toBe(0);
    expect(events).toHaveLength(0);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a database error in the sweep is contained: logged by code, never thrown, and the next sweep runs', async () => {
    seed(voicemailPending());
    db.__state.failSweep = 1;
    await expect(hold.recoverPendingHolds()).resolves.toEqual({ action: 'error' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sweep read failed (ECONNRESET)'));
    expect(await hold.recoverPendingHolds()).toMatchObject({ action: 'swept', open: 1 });
    expect(holdOf().alert_pending).toBe(false);
  });

  test('a failure on one row is contained: the sweep logs it and finishes', async () => {
    seed(returnedPending());
    db.__state.row.status = 'completed';
    db.__state.failReads = 1; // the clear's transaction fails
    await expect(hold.recoverPendingHolds()).resolves.toMatchObject({ action: 'swept', open: 1 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('sweep failed for'));
    expect(holdOf().rec_pending).toBe(true);
  });
});

describe('the Hold button: holdForPanel and requestHold', () => {
  const featureGates = require('../config/feature-gates');
  const MOVED_TO = `https://portal.wavespestcontrol.com/api/webhooks/twilio/conference-staff-left?parent=${SID}&by=button`;
  const NONE = { can_hold: false, on_hold: false, since: null };
  const CAN = { can_hold: true, on_hold: false, since: null };

  test('holdForPanel: null off the conference ring and before a press 1; Hold only while answered, open and idle', () => {
    expect(hold.holdForPanel(null)).toBeNull();
    expect(hold.holdForPanel({ room: `waves-${SID}` })).toBeNull();
    const answered = { accepted_leg_sid: LEG };
    expect(hold.holdForPanel(answered)).toEqual(CAN);
    // A hold that is over: the caller is back, or the star was aborted.
    expect(hold.holdForPanel({ ...answered, hold: heldHold({ phase: 'returned', applied: 'returned', ret_by: 'press1' }) })).toEqual(CAN);
    expect(hold.holdForPanel({ ...answered, hold: heldHold({ phase: 'returned', applied: null, ret_by: 'abort' }) })).toEqual(CAN);
    // Held, or a press 1 return Twilio has not confirmed: on hold since the star.
    expect(hold.holdForPanel({ ...answered, hold: heldHold() })).toEqual({ can_hold: false, on_hold: true, since: iso(-10) });
    expect(hold.holdForPanel({ ...answered, hold: heldHold({ phase: 'returned', applied: 'held', ret_by: 'press1' }) }))
      .toEqual({ can_hold: false, on_hold: true, since: iso(-10) });
    // A hold voicemail, the ring's voicemail, or a closed room: no hold and no button.
    expect(hold.holdForPanel({ ...answered, hold: heldHold({ phase: 'voicemail', applied: 'voicemail' }) })).toEqual(NONE);
    expect(hold.holdForPanel({ ...answered, voicemail_at: iso(-5) })).toEqual(NONE);
    expect(hold.holdForPanel({ ...answered, closed_at: iso(-5) })).toEqual(NONE);
  });

  test("an answered call: the winning staff leg is moved by REST to the star route with by=button, and nothing is decided here", async () => {
    seed(null);
    const events = fakeTwilio();
    await expect(hold.requestHold(SID, { by: 'button' })).resolves.toBe('requested');
    expect(events).toEqual([{ name: 'call', sid: LEG, url: MOVED_TO, method: 'POST' }]);
    // The star route decides the hold: no hold is written here and no lock is taken.
    expect(holdOf()).toBeUndefined();
    expect(db.__state.writes).toEqual([]);
    expect(db.__state.txCount).toBe(0);
  });

  test("after a hold that is over, a new press moves the leg again; the URL names this server's own domain", async () => {
    process.env.SERVER_DOMAIN = 'staging.example.com';
    seed(heldHold({ phase: 'returned', applied: 'returned', ret_by: 'press1' }));
    const events = fakeTwilio();
    await expect(hold.requestHold(SID, { by: 'button' })).resolves.toBe('requested');
    expect(events[0].url).toBe(`https://staging.example.com/api/webhooks/twilio/conference-staff-left?parent=${SID}&by=button`);
  });

  test("by 'voice' (the spoken \"please hold\") is accepted too: the leg moves with by=voice in the URL", async () => {
    seed(null);
    const events = fakeTwilio();
    await expect(hold.requestHold(SID, { by: 'voice' })).resolves.toBe('requested');
    expect(events).toEqual([{ name: 'call', sid: LEG, url: MOVED_TO.replace('by=button', 'by=voice'), method: 'POST' }]);
    expect(holdOf()).toBeUndefined();
    expect(db.__state.writes).toEqual([]);
  });

  test('a hold already open, or a return in flight: on_hold, and nothing is moved', async () => {
    const events = fakeTwilio();
    for (const h of [heldHold(), heldHold({ applied: null }), heldHold({ phase: 'returned', applied: 'held', ret_by: 'press1' })]) {
      seed(h);
      await expect(hold.requestHold(SID, { by: 'button' })).resolves.toBe('on_hold');
    }
    expect(events).toEqual([]);
  });

  test('unavailable with no Twilio request: gate off, another asker, a bad SID, no conference ring, no press 1, a voicemail, a closed room', async () => {
    const events = fakeTwilio();
    seed(null);
    featureGates.callHoldLive.mockReturnValueOnce(false);
    await expect(hold.requestHold(SID, { by: 'button' })).resolves.toBe('unavailable');
    await expect(hold.requestHold(SID, { by: 'star' })).resolves.toBe('unavailable');
    await expect(hold.requestHold(SID)).resolves.toBe('unavailable');
    await expect(hold.requestHold('CA123', { by: 'button' })).resolves.toBe('unavailable');
    for (const setup of [
      () => { db.__state.row = null; },
      () => seed(null, { accepted_leg_sid: null }),
      () => seed(heldHold({ phase: 'voicemail', applied: 'voicemail' })),
      () => seed(null, { voicemail_at: iso(-5) }),
      () => seed(null, { closed_at: iso(-5) }),
    ]) {
      setup();
      await expect(hold.requestHold(SID, { by: 'button' })).resolves.toBe('unavailable');
    }
    expect(events).toEqual([]);
  });

  test('Twilio refuses the move (the staff leg already hung up): failed, nothing written, the log has the code only', async () => {
    seed(null);
    const events = fakeTwilio({ fail: { call: err(400, 21220) } });
    await expect(hold.requestHold(SID, { by: 'button' })).resolves.toBe('failed');
    expect(names(events)).toEqual(['call']);
    expect(db.__state.writes).toEqual([]);
    const logged = logger.warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(logged).toContain('21220');
    expect(logged).not.toContain(SID);
    expect(logged).not.toContain('+1941');
  });

  test('a database read error: failed, and no Twilio request', async () => {
    seed(null);
    db.__state.failReads = 1;
    const events = fakeTwilio();
    await expect(hold.requestHold(SID, { by: 'button' })).resolves.toBe('failed');
    expect(events).toEqual([]);
  });
});
