/**
 * Star-key hold service (GATE_CALL_HOLD): the single claim on conference_path.hold, the Twilio calls
 * startHold / endHold make and their order, and the failure answers. The call_log fake applies the
 * service's own jsonb_set paths and its SQL conditions, so a claim two requests race is decided by
 * the same predicates the database runs.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ callConferencePathMode: jest.fn(() => 'on'), callHoldLive: jest.fn(() => true) }));

const mockTw = { api: null };
jest.mock('twilio', () => {
  const actual = jest.requireActual('twilio');
  const factory = jest.fn(() => mockTw.api);
  factory.twiml = actual.twiml;
  return factory;
});

const db = require('../models/db');
const logger = require('../services/logger');
const hold = require('../services/call-hold');

const SID = `CA${'a'.repeat(32)}`;
const LEG = `CA${'0'.repeat(31)}1`;
const ROOM = `CF${'d'.repeat(32)}`;

function fakeCallLog(metadata) {
  const row = { metadata: JSON.parse(JSON.stringify(metadata)) };
  const at = (obj, parts) => parts.reduce((o, k) => (o == null ? undefined : o[k]), obj);
  const holds = (sql) => {
    let m = sql.match(/^\(metadata -> 'conference_path'\) IS (NOT )?NULL$/);
    if (m) return (row.metadata?.conference_path != null) === Boolean(m[1]);
    m = sql.match(/^\(metadata #>> '\{([^}]*)\}'\) IS (NOT )?NULL$/);
    if (m) return (at(row.metadata, m[1].split(',')) != null) === Boolean(m[2]);
    m = sql.match(/^\(metadata #>> '\{([^}]*)\}'\) = '([^']*)'$/);
    if (m) return String(at(row.metadata, m[1].split(','))) === m[2];
    m = sql.match(/^COALESCE\(metadata #>> '\{([^}]*)\}', '([^']*)'\) <> '([^']*)'$/);
    if (m) return String(at(row.metadata, m[1].split(',')) ?? m[2]) !== m[3];
    throw new Error(`unknown condition: ${sql}`);
  };
  const apply = ({ sql, bindings }) => {
    [...sql.matchAll(/'\{([^}]*)\}', \?::jsonb/g)].forEach((m, i) => {
      const parts = m[1].split(',');
      const parent = at(row.metadata, parts.slice(0, -1));
      if (parent && typeof parent === 'object') parent[parts[parts.length - 1]] = JSON.parse(bindings[i]);
    });
  };
  db.mockImplementation(() => {
    const conditions = [];
    const chain = {
      where: jest.fn(() => chain),
      whereRaw: jest.fn((sql) => { conditions.push(sql); return chain; }),
      first: jest.fn(async () => ({ metadata: JSON.parse(JSON.stringify(row.metadata)) })),
      update: jest.fn(async (data) => {
        if (!conditions.every(holds)) return 0;
        apply(data.metadata);
        return 1;
      }),
    };
    return chain;
  });
  db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
  return row;
}

// Every Twilio call lands in `events` in order. `fail` maps an event name to an error to throw.
function fakeTwilio({ rooms = [{ sid: ROOM }], fail = {} } = {}) {
  const events = [];
  const step = async (name, params) => {
    events.push({ name, ...params });
    if (fail[name]) throw fail[name];
  };
  const participants = jest.fn((sid) => ({ update: (params) => step('participant', { sid, ...params }) }));
  const conferences = jest.fn((sid) => ({ participants: (callSid) => participants(callSid), roomSid: sid }));
  conferences.list = jest.fn(async (params) => { events.push({ name: 'list', ...params }); return rooms; });
  const calls = jest.fn((sid) => ({
    recordings: jest.fn((which) => ({ update: (params) => step('recording', { sid, which, ...params }) })),
  }));
  mockTw.api = { calls, conferences };
  return events;
}

const room = () => ({ conference_path: { room: `waves-${SID}`, accepted_leg_sid: LEG } });
const err404 = () => Object.assign(new Error('not found'), { status: 404, code: 20404 });
const stateOf = (row) => row.metadata.conference_path.hold;

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SERVER_DOMAIN;
});

describe('startHold', () => {
  test('claims, puts the caller on hold with the facts URL, then pauses the recording', async () => {
    const row = fakeCallLog(room());
    const events = fakeTwilio();
    expect(await hold.startHold(SID, { by: 'star', legSid: LEG })).toBe('held');
    expect(events.map((e) => e.name)).toEqual(['list', 'participant', 'recording']);
    expect(events[0]).toMatchObject({ friendlyName: `waves-${SID}`, status: 'in-progress', limit: 5 });
    expect(events[1]).toMatchObject({
      sid: SID,
      hold: true,
      holdUrl: `https://portal.wavespestcontrol.com/api/webhooks/twilio/conference-hold-facts?parent=${SID}&step=0`,
      holdMethod: 'POST',
    });
    expect(events[2]).toMatchObject({ sid: SID, which: 'Twilio.CURRENT', status: 'paused', pauseBehavior: 'silence' });
    expect(stateOf(row)).toMatchObject({ open: true, by: 'star', leg_sid: LEG, count: 1, total_sec: 0 });
    expect(Number.isNaN(Date.parse(stateOf(row).open_at))).toBe(false);
  });

  test('a second star while a hold is open does not claim twice and touches nothing', async () => {
    const row = fakeCallLog(room());
    const events = fakeTwilio();
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
    const before = events.length;
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
    expect(events).toHaveLength(before);
    expect(stateOf(row).count).toBe(1);
  });

  test('a closed call is not claimed: no_room, and Twilio is not called', async () => {
    const row = fakeCallLog({ conference_path: { ...room().conference_path, closed_at: '2026-11-16T12:00:00Z' } });
    const events = fakeTwilio();
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('no_room');
    expect(events).toHaveLength(0);
    expect(row.metadata.conference_path.hold).toBeUndefined();
  });

  test('no open room releases the claim: no_room', async () => {
    const row = fakeCallLog(room());
    fakeTwilio({ rooms: [] });
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('no_room');
    expect(stateOf(row)).toMatchObject({ open: false, count: 0 });
  });

  test('a 404 on the participant releases the claim: no_room', async () => {
    const row = fakeCallLog(room());
    fakeTwilio({ fail: { participant: err404() } });
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('no_room');
    expect(stateOf(row).open).toBe(false);
  });

  test('any other REST error releases the claim: failed, and a retry can claim again', async () => {
    const row = fakeCallLog(room());
    fakeTwilio({ fail: { participant: Object.assign(new Error('boom +19415550100'), { status: 500, code: 51000 }) } });
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('failed');
    expect(stateOf(row).open).toBe(false);
    // The error message (it can carry a number) is never logged; the code is.
    const logged = JSON.stringify([...logger.warn.mock.calls, ...logger.error.mock.calls]);
    expect(logged).not.toContain('+19415550100');
    expect(logged).toContain('51000');
    fakeTwilio();
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
  });

  test('a recording pause error is logged and the hold stays', async () => {
    const row = fakeCallLog(room());
    fakeTwilio({ fail: { recording: Object.assign(new Error('x'), { status: 500, code: 20500 }) } });
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('held');
    expect(stateOf(row).open).toBe(true);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('20500'));
  });

  test('a call with no conference state is failed, never a throw', async () => {
    fakeCallLog({});
    fakeTwilio();
    expect(await hold.startHold(SID, { legSid: LEG })).toBe('failed');
  });
});

describe('endHold', () => {
  test('takes the caller off hold first, then closes the claim, then resumes the recording', async () => {
    const row = fakeCallLog(room());
    const events = fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    events.length = 0;
    // The claim is still open when the unhold request is made.
    const unhold = jest.fn(() => expect(stateOf(row).open).toBe(true));
    mockTw.api.conferences = Object.assign(jest.fn((sid) => ({
      participants: (callSid) => ({ update: async (params) => { unhold(); events.push({ name: 'participant', sid: callSid, ...params }); } }),
      sid,
    })), { list: async () => [{ sid: ROOM }] });
    mockTw.api.calls = jest.fn((sid) => ({
      recordings: (which) => ({
        update: async (params) => {
          expect(stateOf(row).open).toBe(false); // closed before the resume
          events.push({ name: 'recording', sid, which, ...params });
        },
      }),
    }));
    expect(await hold.endHold(SID)).toBe('returned');
    expect(events.map((e) => e.name)).toEqual(['participant', 'recording']);
    expect(events[0]).toMatchObject({ sid: SID, hold: false });
    expect(events[1]).toMatchObject({ which: 'Twilio.CURRENT', status: 'in-progress' });
    expect(unhold).toHaveBeenCalledTimes(1);
  });

  test('a resume error is logged at error level; the caller is still returned', async () => {
    fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    fakeTwilio({ fail: { recording: Object.assign(new Error('x'), { status: 500, code: 20500 }) } });
    expect(await hold.endHold(SID)).toBe('returned');
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('NOT resumed'));
  });

  test('a 404 closes the claim and answers no_room; no recording call is made', async () => {
    const row = fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    const events = fakeTwilio({ fail: { participant: err404() } });
    expect(await hold.endHold(SID)).toBe('no_room');
    expect(stateOf(row).open).toBe(false);
    expect(events.some((e) => e.name === 'recording')).toBe(false);
  });

  test('no room closes the claim: no_room', async () => {
    const row = fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    fakeTwilio({ rooms: [] });
    expect(await hold.endHold(SID)).toBe('no_room');
    expect(stateOf(row).open).toBe(false);
  });

  test('any other REST error keeps the claim open: failed', async () => {
    const row = fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    fakeTwilio({ fail: { participant: Object.assign(new Error('x'), { status: 503 }) } });
    expect(await hold.endHold(SID)).toBe('failed');
    expect(stateOf(row).open).toBe(true);
  });

  test('total_sec adds up across two holds', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-11-16T15:00:00Z'));
      const row = fakeCallLog(room());
      fakeTwilio();
      await hold.startHold(SID, { legSid: LEG });
      jest.setSystemTime(new Date('2026-11-16T15:00:30Z'));
      await hold.endHold(SID);
      expect(stateOf(row)).toMatchObject({ open: false, count: 1, total_sec: 30 });
      jest.setSystemTime(new Date('2026-11-16T15:05:00Z'));
      await hold.startHold(SID, { legSid: LEG });
      jest.setSystemTime(new Date('2026-11-16T15:05:45Z'));
      await hold.endHold(SID);
      expect(stateOf(row)).toMatchObject({ open: false, count: 2, total_sec: 75 });
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('holdState + gate', () => {
  test('reports open, closed and found; a read error answers open', async () => {
    const row = fakeCallLog(room());
    expect(await hold.holdState(SID)).toMatchObject({ found: true, open: false, closed: false });
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    expect((await hold.holdState(SID)).open).toBe(true);
    row.metadata.conference_path.closed_at = '2026-11-16T12:00:00Z';
    expect((await hold.holdState(SID)).closed).toBe(true);
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await hold.holdState(SID)).toMatchObject({ open: true, error: true });
  });

  test('roomIsOpen: a lookup error answers true so the staff rejoin', async () => {
    fakeTwilio({ rooms: [] });
    expect(await hold.roomIsOpen(SID)).toBe(false);
    mockTw.api.conferences.list = jest.fn(async () => { throw new Error('x'); });
    expect(await hold.roomIsOpen(SID)).toBe(true);
  });

  test('isEnabled reads the gate at call time', () => {
    const gates = require('../config/feature-gates');
    gates.callHoldLive.mockReturnValueOnce(false);
    expect(hold.isEnabled()).toBe(false);
    expect(hold.isEnabled()).toBe(true);
  });
});
