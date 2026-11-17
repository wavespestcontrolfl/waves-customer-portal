/**
 * Conference ring service (GATE_CALL_CONFERENCE_PATH): admission, the conditional claims on
 * call_log.metadata.conference_path, and the Twilio calls each step makes. The call_log fake below
 * applies the service's own jsonb_set paths and IS [NOT] NULL conditions, so a claim that two
 * requests race is decided by the same predicates the database runs.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ callConferencePathMode: jest.fn(() => 'off') }));

const mockTw = { api: null };
jest.mock('twilio', () => {
  const actual = jest.requireActual('twilio');
  const factory = jest.fn(() => mockTw.api);
  factory.twiml = actual.twiml;
  return factory;
});

const db = require('../models/db');
const gates = require('../config/feature-gates');
const cp = require('../services/call-conference-path');

const SID = `CA${'a'.repeat(32)}`;
const LEG0 = `CA${'0'.repeat(31)}1`;
const LEG1 = `CA${'0'.repeat(31)}2`;

function fakeCallLog(metadata = {}, { exists = true } = {}) {
  const row = { exists, metadata: JSON.parse(JSON.stringify(metadata)) };
  const at = (obj, parts) => parts.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const holds = (sql) => {
    let m = sql.match(/^\(metadata -> 'conference_path'\) IS (NOT )?NULL$/);
    if (m) return (row.metadata?.conference_path != null) === Boolean(m[1]);
    m = sql.match(/^\(metadata #>> '\{([^}]*)\}'\) IS (NOT )?NULL$/);
    if (m) return (at(row.metadata, m[1].split(',')) != null) === Boolean(m[2]);
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
      first: jest.fn(async () => (row.exists ? { metadata: JSON.parse(JSON.stringify(row.metadata)) } : undefined)),
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
  });

  test('a network error never rings twice; the leg is stamped failed', async () => {
    const row = fakeCallLog({ conference_path: { leg_count: 1, legs: { 0: {} } } });
    fakeTwilio();
    mockTw.api.calls.create.mockRejectedValueOnce(new Error('socket hang up'));
    const placed = await cp.placeStaffLegs({ callSid: SID, numbers: ['+19415550001'], ringTimeoutSec: 30, callerFrom: '+19415550100', wavesLine: '+19415550000', callToken: 'tok' });
    expect(placed).toEqual([]);
    expect(mockTw.api.calls.create).toHaveBeenCalledTimes(1);
    expect(row.metadata.conference_path.legs[0]).toEqual({ status: 'failed' });
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
    expect(await cp.conferenceDialOutcome(SID, undefined)).toEqual({ status: 'completed', duration: 42 });
    expect(await cp.conferenceDialOutcome(SID, 'no-answer')).toEqual({ status: 'no-answer', duration: 0 });
    expect(await cp.conferenceDialOutcome(SID, 'canceled')).toEqual({ status: 'completed', duration: 42 });
  });

  test('no press 1 and no redirect (a join error): no-answer, and the ring stops', async () => {
    const row = fakeCallLog(ringing());
    const log = fakeTwilio();
    expect(await cp.conferenceDialOutcome(SID, undefined)).toEqual({ status: 'no-answer', duration: 0 });
    expect(row.metadata.conference_path.voicemail_at).toEqual(expect.any(String));
    expect(log.updates).toEqual([{ sid: LEG0, status: 'completed' }, { sid: LEG1, status: 'completed' }]);
  });
});
