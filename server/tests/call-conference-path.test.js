/**
 * Conference ring service (GATE_CALL_CONFERENCE_PATH): admission, the conditional claims on
 * call_log.metadata.conference_path, and the Twilio calls each step makes. The call_log fake below
 * applies the service's own jsonb_set paths and IS [NOT] NULL conditions, so a claim that two
 * requests race is decided by the same predicates the database runs.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ callConferencePathMode: jest.fn(() => 'off') }));
jest.mock('../services/call-hold', () => ({ staffLeft: jest.fn(), endTransfer: jest.fn() }));

const mockTw = { api: null };
jest.mock('twilio', () => {
  const actual = jest.requireActual('twilio');
  const factory = jest.fn(() => mockTw.api);
  factory.twiml = actual.twiml;
  return factory;
});

const db = require('../models/db');
const logger = require('../services/logger');
const gates = require('../config/feature-gates');
const cp = require('../services/call-conference-path');
const callHold = require('../services/call-hold');

const SID = `CA${'a'.repeat(32)}`;
const LEG0 = `CA${'0'.repeat(31)}1`;
const LEG1 = `CA${'0'.repeat(31)}2`;

function fakeCallLog(metadata = {}, { exists = true, status = 'in-progress' } = {}) {
  const row = { exists, status, metadata: JSON.parse(JSON.stringify(metadata)) };
  const at = (obj, parts) => parts.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const holds = (sql) => {
    let m = sql.match(/^\(metadata -> 'conference_path'\) IS (NOT )?NULL$/);
    if (m) return (row.metadata?.conference_path != null) === Boolean(m[1]);
    m = sql.match(/^\(metadata #>> '\{([^}]*)\}'\) IS (NOT )?NULL$/);
    if (m) return (at(row.metadata, m[1].split(',')) != null) === Boolean(m[2]);
    m = sql.match(/^\(status IS NULL OR status NOT IN \((.*)\)\)$/);
    if (m) return row.status == null || !m[1].split(', ').map((s) => s.replace(/'/g, '')).includes(row.status);
    throw new Error(`unknown condition: ${sql}`);
  };
  const apply = ({ sql, bindings }) => {
    row.metadata = row.metadata || {};
    [...sql.matchAll(/'\{([^}]*)\}', \?::jsonb/g)].forEach((m, i) => {
      const parts = m[1].split(',');
      const parent = at(row.metadata, parts.slice(0, -1));
      // jsonb_set creates only the last path element, like Postgres.
      if (parent && typeof parent === 'object') parent[parts[parts.length - 1]] = JSON.parse(bindings[i]);
    });
  };
  db.mockImplementation(() => {
    const conditions = [];
    const chain = {
      where: jest.fn(() => chain),
      whereRaw: jest.fn((sql) => { conditions.push(sql); return chain; }),
      modify: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      // The staff-end sweep's read: the row when every condition holds.
      select: jest.fn(async () => (row.exists && conditions.every(holds) ? [{ twilio_call_sid: SID, metadata: JSON.parse(JSON.stringify(row.metadata)) }] : [])),
      first: jest.fn(async () => (row.exists ? { status: row.status, metadata: JSON.parse(JSON.stringify(row.metadata)) } : undefined)),
      update: jest.fn(async (data) => {
        if (!row.exists || !conditions.every(holds)) return 0;
        apply(data.metadata);
        return 1;
      }),
    };
    return chain;
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return row;
}

function fakeTwilio({ callStatus = 'in-progress', rooms = [] } = {}) {
  const log = { created: [], updates: [], recordings: [], roomUpdates: [] };
  const calls = jest.fn((sid) => ({
    update: jest.fn(async (params) => { log.updates.push({ sid, ...params }); return { sid }; }),
    fetch: jest.fn(async () => ({ sid, status: typeof callStatus === 'function' ? callStatus(sid) : callStatus })),
    recordings: { create: jest.fn(async (params) => { log.recordings.push({ sid, ...params }); return { sid: 'RE1' }; }) },
  }));
  calls.create = jest.fn(async (params) => { log.created.push(params); return { sid: [LEG0, LEG1][log.created.length - 1] || LEG1 }; });
  const conferences = jest.fn((sid) => ({ update: jest.fn(async (params) => { log.roomUpdates.push({ sid, ...params }); }) }));
  conferences.list = jest.fn(async () => rooms);
  mockTw.api = { calls, conferences };
  return log;
}

const ringing = () => ({
  conference_path: { room: `waves-${SID}`, leg_count: 2, legs: { 0: { sid: LEG0 }, 1: { sid: LEG1 } } },
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.useRealTimers();
  gates.callConferencePathMode.mockReturnValue('off');
  delete process.env.CALL_CONFERENCE_TEST_CALLERS;
  delete process.env.SERVER_DOMAIN;
  cp._test.callTokens.clear();
});

describe('admission', () => {
  test('off admits nobody; true admits everyone; test admits only the listed callers', () => {
    expect(cp.admitsConferencePath({ from: '+19415550100' })).toBe(false);
    gates.callConferencePathMode.mockReturnValue('on');
    expect(cp.admitsConferencePath({ from: '+19415550100' })).toBe(true);
    gates.callConferencePathMode.mockReturnValue('test');
    process.env.CALL_CONFERENCE_TEST_CALLERS = '(941) 555-0199, +19415550198';
    expect(cp.admitsConferencePath({ from: '+19415550199' })).toBe(true);
    expect(cp.admitsConferencePath({ from: '9415550198' })).toBe(true);
    expect(cp.admitsConferencePath({ from: '+19415550100' })).toBe(false);
    expect(cp.admitsConferencePath({ from: null })).toBe(false);
  });

  test('the gate reader: test, true, and everything else off', () => {
    const { callConferencePathMode } = jest.requireActual('../config/feature-gates');
    const before = process.env.GATE_CALL_CONFERENCE_PATH;
    try {
      for (const [value, mode] of [['test', 'test'], [' TRUE ', 'on'], ['1', 'off'], ['on', 'off'], ['', 'off']]) {
        process.env.GATE_CALL_CONFERENCE_PATH = value;
        expect(callConferencePathMode()).toBe(mode);
      }
    } finally {
      if (before === undefined) delete process.env.GATE_CALL_CONFERENCE_PATH;
      else process.env.GATE_CALL_CONFERENCE_PATH = before;
    }
  });

  test('a CallToken is taken once and expires after two minutes', () => {
    jest.useFakeTimers({ now: 1_000_000 });
    cp.stashCallToken(SID, 'tok');
    expect(cp.takeCallToken(SID)).toBe('tok');
    expect(cp.takeCallToken(SID)).toBeNull();
    cp.stashCallToken(SID, 'tok');
    jest.setSystemTime(1_000_000 + 2 * 60 * 1000 + 1);
    expect(cp.takeCallToken(SID)).toBeNull();
  });
});

describe('claimStart + placeStaffLegs', () => {
  test('first claim seeds one empty slot per leg; a second claim is a retry; no row is no_row', async () => {
    const row = fakeCallLog({ caller_language: 'en' });
    gates.callConferencePathMode.mockReturnValue('test');
    const first = await cp.claimStart(SID, { legCount: 2, ringTimeoutSec: 30 });
    expect(first.claim).toBe('claimed');
    expect(row.metadata.caller_language).toBe('en');
    expect(row.metadata.conference_path).toMatchObject({ room: `waves-${SID}`, mode: 'test', ring_timeout_sec: 30, leg_count: 2, legs: { 0: {}, 1: {} } });
    expect((await cp.claimStart(SID, { legCount: 2, ringTimeoutSec: 30 })).claim).toBe('retry');
    fakeCallLog({}, { exists: false });
    expect((await cp.claimStart(SID, { legCount: 2, ringTimeoutSec: 30 })).claim).toBe('no_row');
    // The caller hung up first: its terminal status refuses the claim, so no staff phone rings.
    const ended = fakeCallLog({}, { status: 'completed' });
    expect((await cp.claimStart(SID, { legCount: 2, ringTimeoutSec: 30 })).claim).toBe('ended');
    expect(ended.metadata.conference_path).toBeUndefined();
  });

  test('legs ring the press-1 screen; the CallToken shows the caller, a refusal falls back to the Waves line', async () => {
    const row = fakeCallLog({ conference_path: { leg_count: 2, legs: { 0: {}, 1: {} } } });
    const log = fakeTwilio();
    mockTw.api.calls.create
      .mockImplementationOnce(async (p) => { log.created.push(p); return { sid: LEG0 }; })
      .mockImplementationOnce(async (p) => { log.created.push(p); throw Object.assign(new Error('bad From'), { status: 400, code: 21212 }); })
      .mockImplementationOnce(async (p) => { log.created.push(p); return { sid: LEG1 }; });
    const placed = await cp.placeStaffLegs({
      callSid: SID, numbers: ['+19415550001', '+19415550002'], ringTimeoutSec: 25,
      callerFrom: '+19415550100', wavesLine: '+19415550000', callToken: 'tok',
    });
    expect(placed.sort()).toEqual([LEG0, LEG1].sort());
    const [a, b, c] = log.created;
    expect(a).toMatchObject({
      to: '+19415550001', from: '+19415550100', callToken: 'tok', timeout: 25, method: 'POST',
      url: `https://portal.wavespestcontrol.com/api/webhooks/twilio/conference-staff-screen?parent=${SID}`,
      statusCallback: `https://portal.wavespestcontrol.com/api/webhooks/twilio/conference-staff-status?parent=${SID}&leg=0`,
      statusCallbackEvent: ['completed'],
    });
    expect(b).toMatchObject({ to: '+19415550002', from: '+19415550100', callToken: 'tok' });
    expect(c).toMatchObject({ to: '+19415550002', from: '+19415550000' });
    expect(c.callToken).toBeUndefined();
    expect(row.metadata.conference_path.legs).toEqual({ 0: { sid: LEG0 }, 1: { sid: LEG1 } });
    expect(log.updates).toEqual([]);
  });

  test('a leg placed after the call settled is ended at once: the caller left, or another leg won', async () => {
    for (const settle of [{ closed_at: 'x' }, { accepted_leg_sid: LEG1 }]) {
      const row = fakeCallLog({ conference_path: { leg_count: 1, legs: { 0: {} } } });
      const log = fakeTwilio();
      mockTw.api.calls.create.mockImplementationOnce(async (p) => {
        log.created.push(p);
        Object.assign(row.metadata.conference_path, settle); // the clean-up ran while Twilio placed the call
        return { sid: LEG0 };
      });
      await cp.placeStaffLegs({ callSid: SID, numbers: ['+19415550001'], ringTimeoutSec: 30, callerFrom: null, wavesLine: '+19415550000', callToken: null });
      expect(log.updates).toEqual([{ sid: LEG0, status: 'completed' }]);
    }
  });

  test('a network error never rings twice; the leg is stamped failed', async () => {
    const row = fakeCallLog({ conference_path: { leg_count: 1, legs: { 0: {} } } });
    fakeTwilio();
    mockTw.api.calls.create.mockRejectedValueOnce(Object.assign(new Error('socket hang up calling +19415550001'), { code: 'ECONNRESET' }));
    const placed = await cp.placeStaffLegs({ callSid: SID, numbers: ['+19415550001'], ringTimeoutSec: 30, callerFrom: '+19415550100', wavesLine: '+19415550000', callToken: 'tok' });
    expect(placed).toEqual([]);
    expect(mockTw.api.calls.create).toHaveBeenCalledTimes(1);
    expect(row.metadata.conference_path.legs[0]).toEqual({ status: 'failed' });
    // The provider's message can carry the phone number: only its code is logged.
    const logged = [...logger.error.mock.calls, ...logger.warn.mock.calls].flat().join(' ');
    expect(logged).toContain('ECONNRESET');
    expect(logged).not.toContain('5550001');
  });
});

describe('press 1', () => {
  test('the first accept wins; its redelivery is won but not first; a second staff loses', async () => {
    const row = fakeCallLog(ringing());
    expect(await cp.claimAccept(SID, LEG0)).toEqual({ won: true, first: true });
    expect(row.metadata.conference_path.accepted_leg_sid).toBe(LEG0);
    expect(await cp.claimAccept(SID, LEG0)).toEqual({ won: true, first: false });
    expect(await cp.claimAccept(SID, LEG1)).toEqual({ won: false, first: false });
  });

  test('no accept after the voicemail claim or after the caller left', async () => {
    fakeCallLog({ conference_path: { ...ringing().conference_path, voicemail_at: 'x' } });
    expect((await cp.claimAccept(SID, LEG0)).won).toBe(false);
    fakeCallLog({ conference_path: { ...ringing().conference_path, closed_at: 'x' } });
    expect((await cp.claimAccept(SID, LEG0)).won).toBe(false);
  });

  test('the recording starts on the caller call, dual channel, with the usual callback', async () => {
    const log = fakeTwilio();
    expect(await cp.startCallerRecording(SID)).toBe('started');
    expect(log.recordings).toEqual([expect.objectContaining({
      sid: SID, recordingChannels: 'dual', recordingTrack: 'both', recordingStatusCallbackEvent: ['completed'],
      recordingStatusCallback: 'https://portal.wavespestcontrol.com/api/webhooks/twilio/recording-status',
    })]);
    mockTw.api.calls.mockImplementation((sid) => ({
      recordings: { create: jest.fn().mockRejectedValue(new Error('not in progress')) },
      fetch: jest.fn(async () => ({ sid, status: 'completed' })),
    }));
    expect(await cp.startCallerRecording(SID)).toBe('caller_gone');
  });
});

describe('staff leg status', () => {
  test('one leg over while another rings: wait; the last leg over: voicemail once', async () => {
    const row = fakeCallLog(ringing());
    const log = fakeTwilio();
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG0, status: 'no-answer' })).toBe('waiting');
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 1, legSid: LEG1, status: 'busy' })).toBe('voicemail');
    expect(row.metadata.conference_path.voicemail_at).toEqual(expect.any(String));
    expect(log.updates).toEqual([{ sid: SID, method: 'POST', url: `https://portal.wavespestcontrol.com/api/webhooks/twilio/call-complete?conf=1&conf_status=no-answer` }]);
    // A redelivered callback after the claim: no second redirect.
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 1, legSid: LEG1, status: 'busy' })).toBe('settled');
    expect(log.updates).toHaveLength(1);
  });

  test('a failed voicemail redirect releases the claim and tries again in 10 s, three tries at most', async () => {
    jest.useFakeTimers();
    const row = fakeCallLog(ringing());
    fakeTwilio();
    const redirect = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('Call to +19415550100 failed'), { status: 503, code: 20503 }))
      .mockResolvedValue({ sid: SID });
    const legCalls = mockTw.api.calls.getMockImplementation();
    mockTw.api.calls.mockImplementation((sid) => (sid === SID ? { update: redirect } : legCalls(sid)));
    expect(await cp.sendCallerToVoicemail(SID, 'busy')).toBe('redirect_failed');
    expect(row.metadata.conference_path.voicemail_at).toBeNull();
    expect(logger.warn.mock.calls.flat().join(' ')).not.toContain('5550100');
    await jest.advanceTimersByTimeAsync(10_000);
    expect(redirect).toHaveBeenCalledTimes(2);
    expect(redirect).toHaveBeenLastCalledWith({ method: 'POST', url: 'https://portal.wavespestcontrol.com/api/webhooks/twilio/call-complete?conf=1&conf_status=busy' });
    expect(row.metadata.conference_path.voicemail_at).toEqual(expect.any(String));

    fakeCallLog(ringing());
    fakeTwilio();
    const down = jest.fn().mockRejectedValue(Object.assign(new Error('down'), { status: 503 }));
    const legCalls2 = mockTw.api.calls.getMockImplementation();
    mockTw.api.calls.mockImplementation((sid) => (sid === SID ? { update: down } : legCalls2(sid)));
    await cp.sendCallerToVoicemail(SID, 'no-answer');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(down).toHaveBeenCalledTimes(3);
  });

  test('every leg busy or failed reports busy; a non-terminal status is ignored', async () => {
    fakeCallLog(ringing());
    const log = fakeTwilio();
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG0, status: 'ringing' })).toBe('ignored');
    await cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG0, status: 'failed' });
    await cp.onStaffLegStatus({ callSid: SID, index: 1, legSid: LEG1, status: 'busy' });
    expect(log.updates[0].url).toContain('conf_status=busy');
  });
});

describe('the winning staff call ends', () => {
  const accepted = (extra = {}) => ({ conference_path: { ...ringing().conference_path, accepted_leg_sid: LEG0, ...extra } });

  test('the open room is ended, so the caller <Dial> action runs /call-complete', async () => {
    fakeCallLog(accepted());
    const log = fakeTwilio({ rooms: [{ sid: 'CF0', status: 'completed' }, { sid: 'CF1', status: 'in-progress' }] });
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG0, status: 'completed' })).toBe('room_ended');
    expect(mockTw.api.conferences.list).toHaveBeenCalledWith({ friendlyName: `waves-${SID}`, limit: 5 });
    expect(log.roomUpdates).toEqual([{ sid: 'CF1', status: 'completed' }]);
    expect(log.updates).toEqual([]);
  });

  test('no open room: the caller call is ended instead', async () => {
    fakeCallLog(accepted());
    const log = fakeTwilio({ rooms: [{ sid: 'CF0', status: 'completed' }] });
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG0, status: 'completed' })).toBe('caller_hung_up');
    expect(log.updates).toEqual([{ sid: SID, status: 'completed' }]);
  });

  test('the caller already left, or another leg ended: no Twilio call', async () => {
    fakeCallLog(accepted({ closed_at: 'x' }));
    const gone = fakeTwilio({ rooms: [{ sid: 'CF1', status: 'in-progress' }] });
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG0, status: 'completed' })).toBe('caller_gone');
    expect(mockTw.api.conferences.list).not.toHaveBeenCalled();
    expect(gone.updates).toEqual([]);
    fakeCallLog(accepted());
    const log = fakeTwilio({ rooms: [{ sid: 'CF1', status: 'in-progress' }] });
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 1, legSid: LEG1, status: 'canceled' })).toBe('accepted');
    expect(mockTw.api.conferences.list).not.toHaveBeenCalled();
    expect(log.updates).toEqual([]);
  });
});

describe('the winning staff call ends during a star-key hold', () => {
  const held = (hold) => ({ conference_path: { ...ringing().conference_path, accepted_leg_sid: LEG0, hold } });
  const ended = () => cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG0, status: 'completed' });
  const rooms = [{ sid: 'CF1', status: 'in-progress' }];

  beforeEach(() => callHold.staffLeft.mockReset());

  test('the hold decides the caller goes to voicemail: no room end and no hang-up here (the hold\'s sender does the room end)', async () => {
    fakeCallLog(held({ phase: 'held' }));
    callHold.staffLeft.mockResolvedValue('voicemail');
    const log = fakeTwilio({ rooms });
    expect(await ended()).toBe('hold_voicemail');
    expect(callHold.staffLeft).toHaveBeenCalledWith(SID);
    expect(mockTw.api.conferences.list).not.toHaveBeenCalled();
    expect(mockTw.api.calls).not.toHaveBeenCalled();
    expect(log.roomUpdates).toEqual([]);
    expect(log.updates).toEqual([]);
  });

  test('no hold in the way (none, a hold that is over, or a closed call): today\'s room end, in every shape', async () => {
    fakeCallLog(held({ phase: 'returned', applied: 'returned' }));
    callHold.staffLeft.mockResolvedValue('ordinary');
    const log = fakeTwilio({ rooms });
    expect(await ended()).toBe('room_ended');
    expect(log.roomUpdates).toEqual([{ sid: 'CF1', status: 'completed' }]);
  });

  test('no open room and an ordinary hang-up: the caller is hung up, as today', async () => {
    fakeCallLog(held(undefined));
    callHold.staffLeft.mockResolvedValue('ordinary');
    const log = fakeTwilio({ rooms: [] });
    expect(await ended()).toBe('caller_hung_up');
    expect(log.updates).toEqual([{ sid: SID, status: 'completed' }]);
  });

  test('the hold cannot decide (a database error): nothing is ended blind, and the end is tried again until it is handled', async () => {
    jest.useFakeTimers();
    // A press 1 return that finished before the retry: the caller would be alone in the room without it.
    fakeCallLog(held({ phase: 'returned', applied: 'returned' }));
    callHold.staffLeft.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down')).mockResolvedValue('ordinary');
    const log = fakeTwilio({ rooms });
    expect(await ended()).toBe('retry');
    expect(log.roomUpdates).toEqual([]);
    expect(log.updates).toEqual([]);
    await jest.advanceTimersByTimeAsync(2000);
    expect(callHold.staffLeft).toHaveBeenCalledTimes(2);
    expect(log.roomUpdates).toEqual([]);
    await jest.advanceTimersByTimeAsync(5000);
    expect(callHold.staffLeft).toHaveBeenCalledTimes(3);
    expect(log.roomUpdates).toEqual([{ sid: 'CF1', status: 'completed' }]);
    await jest.advanceTimersByTimeAsync(120000);
    expect(callHold.staffLeft).toHaveBeenCalledTimes(3);
  });

  test('a database that stays down: five retries, then an error log (the minute sweep finishes it)', async () => {
    jest.useFakeTimers();
    fakeCallLog(held({ phase: 'held' }));
    callHold.staffLeft.mockRejectedValue(new Error('db down'));
    const log = fakeTwilio({ rooms });
    expect(await ended()).toBe('retry');
    await jest.advanceTimersByTimeAsync(cp._test.STAFF_END_RETRY_MS.reduce((a, b) => a + b, 0) + 1000);
    expect(callHold.staffLeft).toHaveBeenCalledTimes(6);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not handled after 6 tries (Error)'));
    expect(log.roomUpdates).toEqual([]);
    expect(log.updates).toEqual([]);
  });
});

describe('a staff leg end the database cannot stamp', () => {
  test('the leg stamp throws: the retry stamps it and ends the room', async () => {
    jest.useFakeTimers();
    const row = fakeCallLog({ conference_path: { ...ringing().conference_path, accepted_leg_sid: LEG0 } });
    callHold.staffLeft.mockReset().mockResolvedValue('ordinary');
    const normal = db.getMockImplementation();
    db.mockImplementationOnce(() => ({ ...normal(), where: jest.fn(function where() { return this; }), whereRaw: jest.fn(function whereRaw() { return this; }), update: jest.fn(async () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }) }));
    const log = fakeTwilio({ rooms: [{ sid: 'CF1', status: 'in-progress' }] });
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG0, status: 'completed' })).toBe('retry');
    expect(callHold.staffLeft).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('not handled (ECONNRESET); try 2 in 2 s'));
    await jest.advanceTimersByTimeAsync(2000);
    expect(row.metadata.conference_path.legs[0].status).toBe('completed');
    expect(log.roomUpdates).toEqual([{ sid: 'CF1', status: 'completed' }]);
  });
});

describe('the minute staff-end sweep (recoverStaffEnds)', () => {
  const answered = (extra = {}) => ({ conference_path: { ...ringing().conference_path, accepted_leg_sid: LEG0, ...extra } });
  const open = [{ sid: 'CF1', status: 'in-progress' }];

  beforeEach(() => callHold.staffLeft.mockReset().mockResolvedValue('ordinary'));

  test('a winning leg that is over with the room still open: the sweep ends the room, as the status callback would', async () => {
    fakeCallLog(answered({ hold: { phase: 'returned', applied: 'returned' } }));
    const log = fakeTwilio({ callStatus: 'completed', rooms: open });
    expect(await cp.recoverStaffEnds()).toEqual({ action: 'swept', open: 1, handled: 1 });
    expect(mockTw.api.calls).toHaveBeenCalledWith(LEG0);
    expect(callHold.staffLeft).toHaveBeenCalledWith(SID);
    expect(log.roomUpdates).toEqual([{ sid: 'CF1', status: 'completed' }]);
    expect(log.updates).toEqual([]);
  });

  test('a hold in the way: the hold decides (voicemail), and the sweep ends nothing itself', async () => {
    fakeCallLog(answered({ hold: { phase: 'held' } }));
    callHold.staffLeft.mockResolvedValue('voicemail');
    const log = fakeTwilio({ callStatus: 'completed', rooms: open });
    expect(await cp.recoverStaffEnds()).toEqual({ action: 'swept', open: 1, handled: 1 });
    expect(callHold.staffLeft).toHaveBeenCalledWith(SID);
    expect(log.roomUpdates).toEqual([]);
    expect(log.updates).toEqual([]);
  });

  test('the staff still on the call, or no open room: nothing is done', async () => {
    fakeCallLog(answered());
    fakeTwilio({ callStatus: 'in-progress', rooms: open });
    expect(await cp.recoverStaffEnds()).toEqual({ action: 'swept', open: 1, handled: 0 });
    expect(mockTw.api.conferences.list).not.toHaveBeenCalled();
    const log = fakeTwilio({ callStatus: 'completed', rooms: [{ sid: 'CF1', status: 'completed' }] });
    expect(await cp.recoverStaffEnds()).toEqual({ action: 'swept', open: 1, handled: 0 });
    expect(callHold.staffLeft).not.toHaveBeenCalled();
    expect(log.roomUpdates).toEqual([]);
    expect(log.updates).toEqual([]);
  });

  test('only an answered call whose caller is still on the line is read: no press 1, a closed or an ended call give none', async () => {
    for (const [metadata, opts] of [
      [ringing(), {}],
      [answered({ closed_at: '2026-11-17T15:00:00Z' }), {}],
      [{ ...answered(), ended_at: '2026-11-17T15:00:00Z' }, {}],
      [answered(), { status: 'completed' }],
    ]) {
      fakeCallLog(metadata, opts);
      fakeTwilio({ callStatus: 'completed', rooms: open });
      expect(await cp.recoverStaffEnds()).toEqual({ action: 'swept', open: 0, handled: 0 });
      expect(mockTw.api.calls).not.toHaveBeenCalled();
    }
  });

  test('a Twilio error on one call is only logged; a read error answers error', async () => {
    fakeCallLog(answered());
    fakeTwilio({ rooms: open });
    mockTw.api.calls = jest.fn(() => ({ fetch: jest.fn(async () => { throw Object.assign(new Error('x'), { status: 503 }); }) }));
    expect(await cp.recoverStaffEnds()).toEqual({ action: 'swept', open: 1, handled: 0 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('staff-end sweep failed for'));
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await cp.recoverStaffEnds()).toEqual({ action: 'error' });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('staff-end sweep read failed (Error)'));
  });
});

describe('caller end and backstop', () => {
  test('caller ended: close once, end every leg still up, the winner too', async () => {
    const row = fakeCallLog({ conference_path: { leg_count: 3, accepted_leg_sid: LEG0, legs: { 0: { sid: LEG0 }, 1: { sid: LEG1 }, 2: { sid: 'CA3', status: 'no-answer' } } } });
    const log = fakeTwilio();
    expect(await cp.closeForCallerEnd(SID)).toBe(2);
    expect(log.updates).toEqual([{ sid: LEG0, status: 'completed' }, { sid: LEG1, status: 'completed' }]);
    expect(row.metadata.conference_path.closed_at).toEqual(expect.any(String));
    expect(await cp.closeForCallerEnd(SID)).toBe(0);
  });

  test('the backstop sends an unanswered caller to voicemail; a press 1 first makes it a no-op', async () => {
    jest.useFakeTimers();
    fakeCallLog(ringing());
    let log = fakeTwilio();
    cp.scheduleNoAnswerBackstop(SID, 30);
    await jest.advanceTimersByTimeAsync(49_000);
    expect(log.updates).toEqual([]);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(log.updates.map((u) => u.sid)).toEqual([LEG0, LEG1, SID]);
    fakeCallLog({ conference_path: { ...ringing().conference_path, accepted_leg_sid: LEG0 } });
    log = fakeTwilio();
    cp.scheduleNoAnswerBackstop(SID, 30);
    await jest.advanceTimersByTimeAsync(50_000);
    expect(log.updates).toEqual([]);
  });
});

describe('/call-complete outcome', () => {
  test('answered: completed, talk time from the press 1; a voicemail redirect keeps its status', async () => {
    jest.useFakeTimers({ now: Date.parse('2026-11-17T15:00:42Z') });
    fakeCallLog({ conference_path: { accepted_at: '2026-11-17T15:00:00Z' } });
    expect(await cp.conferenceDialOutcome(SID, undefined)).toEqual({ status: 'completed', duration: 42, accepted: true });
    expect(await cp.conferenceDialOutcome(SID, 'no-answer')).toEqual({ status: 'no-answer', duration: 0, accepted: false });
    expect(await cp.conferenceDialOutcome(SID, 'canceled')).toEqual({ status: 'completed', duration: 42, accepted: true });
  });

  test('no press 1 and no redirect (a join error): no-answer, and the ring stops', async () => {
    const row = fakeCallLog(ringing());
    const log = fakeTwilio();
    expect(await cp.conferenceDialOutcome(SID, undefined)).toEqual({ status: 'no-answer', duration: 0, accepted: false });
    expect(row.metadata.conference_path.voicemail_at).toEqual(expect.any(String));
    expect(log.updates).toEqual([{ sid: LEG0, status: 'completed' }, { sid: LEG1, status: 'completed' }]);
  });
});

describe('the warm transfer: the owner call ends (onTransferLegStatus)', () => {
  const TLEG = `CA${'7'.repeat(32)}`;
  const base = () => ({ ...ringing().conference_path, accepted_leg_sid: LEG0 });
  const ended = (extra = {}) => cp.onTransferLegStatus({ callSid: SID, n: 1, legSid: TLEG, status: 'no-answer', ...extra });
  const rooms = [{ sid: 'CF1', status: 'in-progress' }];

  beforeEach(() => { callHold.staffLeft.mockReset(); callHold.endTransfer.mockReset().mockResolvedValue('failed'); });

  test('a call nobody took: the hold decides (endTransfer, with the status as its reason); no room is ended here', async () => {
    fakeCallLog({ conference_path: base() });
    const log = fakeTwilio({ rooms });
    for (const status of ['completed', 'busy', 'no-answer', 'failed', 'canceled']) {
      callHold.endTransfer.mockClear();
      expect(await ended({ status })).toBe('failed');
      expect(callHold.endTransfer).toHaveBeenCalledWith(SID, { n: 1, legSid: TLEG, reason: status });
    }
    expect(callHold.staffLeft).not.toHaveBeenCalled();
    expect(log.roomUpdates).toEqual([]);
    expect(log.updates).toEqual([]);
  });

  test('the call he took is the winning leg: its end is the winner end (the room ends, as for any staff)', async () => {
    fakeCallLog({ conference_path: { ...base(), accepted_leg_sid: TLEG } });
    callHold.staffLeft.mockResolvedValue('ordinary');
    const log = fakeTwilio({ rooms });
    expect(await ended({ status: 'completed' })).toBe('room_ended');
    expect(callHold.staffLeft).toHaveBeenCalledWith(SID);
    expect(callHold.endTransfer).not.toHaveBeenCalled();
    expect(log.roomUpdates).toEqual([{ sid: 'CF1', status: 'completed' }]);
  });

  test('the winner end during a hold of his own is the hold\'s voicemail, as for any staff', async () => {
    fakeCallLog({ conference_path: { ...base(), accepted_leg_sid: TLEG } });
    callHold.staffLeft.mockResolvedValue('voicemail');
    expect(await ended({ status: 'completed' })).toBe('hold_voicemail');
  });

  test('a transfer still ringing for the held caller: onWinnerLegEnded ends no room and starts no voicemail', async () => {
    fakeCallLog({ conference_path: base() });
    callHold.staffLeft.mockResolvedValue('transfer_pending');
    const log = fakeTwilio({ rooms });
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG0, status: 'completed' })).toBe('transfer_pending');
    expect(mockTw.api.conferences.list).not.toHaveBeenCalled();
    expect(mockTw.api.calls).not.toHaveBeenCalled();
    expect(log.roomUpdates).toEqual([]);
    expect(log.updates).toEqual([]);
  });

  test('the staff sweep does the same for it: nothing is ended until the transfer is decided', async () => {
    fakeCallLog({ conference_path: base() });
    callHold.staffLeft.mockResolvedValue('transfer_pending');
    const log = fakeTwilio({ callStatus: 'completed', rooms });
    expect(await cp.recoverStaffEnds()).toEqual({ action: 'swept', open: 1, handled: 1 });
    expect(log.roomUpdates).toEqual([]);
    expect(log.updates).toEqual([]);
  });

  test('a staff leg ending after he took the call is not the winner any more: no room end', async () => {
    fakeCallLog({ conference_path: { ...base(), accepted_leg_sid: TLEG } });
    const log = fakeTwilio({ rooms });
    expect(await cp.onStaffLegStatus({ callSid: SID, index: 0, legSid: LEG0, status: 'completed' })).toBe('accepted');
    expect(callHold.staffLeft).not.toHaveBeenCalled();
    expect(log.roomUpdates).toEqual([]);
  });

  test('a status that is not terminal, a missing leg or n, and a call with no state are ignored without a hold decision', async () => {
    fakeCallLog({ conference_path: base() });
    fakeTwilio();
    expect(await ended({ status: 'ringing' })).toBe('ignored');
    expect(await ended({ legSid: null })).toBe('ignored');
    expect(await ended({ n: NaN })).toBe('ignored');
    expect(await ended({ n: undefined })).toBe('ignored');
    fakeCallLog({}, { exists: false });
    expect(await ended()).toBe('no_state');
    expect(callHold.endTransfer).not.toHaveBeenCalled();
  });

  test('the hold cannot decide (a database error): the end is tried again, as a staff leg end is, until it is handled', async () => {
    jest.useFakeTimers();
    fakeCallLog({ conference_path: base() });
    callHold.endTransfer.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('db down')).mockResolvedValue('voicemail');
    fakeTwilio({ rooms });
    expect(await ended()).toBe('retry');
    await jest.advanceTimersByTimeAsync(2000);
    expect(callHold.endTransfer).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(5000);
    expect(callHold.endTransfer).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(120000);
    expect(callHold.endTransfer).toHaveBeenCalledTimes(3);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('transfer leg end for'));
  });

  test('a database that stays down: five retries, then an error log', async () => {
    jest.useFakeTimers();
    fakeCallLog({ conference_path: base() });
    callHold.endTransfer.mockRejectedValue(new Error('db down'));
    fakeTwilio({ rooms });
    expect(await ended()).toBe('retry');
    await jest.advanceTimersByTimeAsync(cp._test.STAFF_END_RETRY_MS.reduce((a, b) => a + b, 0) + 1000);
    expect(callHold.endTransfer).toHaveBeenCalledTimes(6);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('transfer leg end for'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('not handled after 6 tries'));
  });
});

describe('the warm transfer: the caller hangs up while it rings', () => {
  const TLEG = `CA${'7'.repeat(32)}`;
  const withHold = (transfer) => ({ conference_path: { leg_count: 1, accepted_leg_sid: LEG0, legs: { 0: { sid: LEG0 } }, hold: { gen: 1, phase: 'held', transfer } } });

  test('the ringing owner call is ended with the staff legs, and counted', async () => {
    fakeCallLog(withHold({ n: 1, status: 'ringing', leg_sid: TLEG }));
    const log = fakeTwilio();
    expect(await cp.closeForCallerEnd(SID)).toBe(2);
    expect(log.updates).toEqual([{ sid: LEG0, status: 'completed' }, { sid: TLEG, status: 'completed' }]);
  });

  test('no call to end: a transfer not placed yet, one that ended, one that was taken (the room end does that), or none', async () => {
    for (const transfer of [{ n: 1, status: 'ringing', leg_sid: null }, { n: 1, status: 'failed', leg_sid: TLEG }, { n: 1, status: 'accepted', leg_sid: TLEG }, undefined]) {
      fakeCallLog(withHold(transfer));
      const log = fakeTwilio();
      expect(await cp.closeForCallerEnd(SID)).toBe(1);
      expect(log.updates).toEqual([{ sid: LEG0, status: 'completed' }]);
    }
  });

  test('an owner call that will not end is only logged: the close still counts the legs', async () => {
    fakeCallLog(withHold({ n: 1, status: 'ringing', leg_sid: TLEG }));
    fakeTwilio();
    const update = jest.fn(async (params) => { if (params.status && mockTw.api.calls.mock.calls.at(-1)[0] === TLEG) throw Object.assign(new Error('x'), { status: 404 }); });
    const calls = jest.fn(() => ({ update }));
    mockTw.api = { ...mockTw.api, calls };
    expect(await cp.closeForCallerEnd(SID)).toBe(1);
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('transfer leg'));
  });
});
