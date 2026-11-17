/**
 * Star-key hold service (GATE_CALL_HOLD): the single claim on conference_path.hold, the Twilio calls
 * startHold / endHold make and their order, and the failure answers. The call_log fake applies the
 * service's own jsonb_set paths and its SQL conditions, so a claim two requests race is decided by
 * the same predicates the database runs.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../config/feature-gates', () => ({ callConferencePathMode: jest.fn(() => 'on'), callHoldLive: jest.fn(() => true) }));
jest.mock('../services/admin-alert-compose', () => ({ ...jest.requireActual('../services/admin-alert-compose'), raiseAdminAlert: jest.fn(async () => ({ id: 'n1' })) }));
jest.mock('../services/admin-alert-names', () => ({
  ...jest.requireActual('../services/admin-alert-names'),
  realName: jest.fn((row) => ([row?.first_name, row?.last_name].filter(Boolean).join(' ') || null)),
  nameOnFileForPhone: jest.fn(async () => null),
}));

const mockTw = { api: null };
jest.mock('twilio', () => {
  const actual = jest.requireActual('twilio');
  const factory = jest.fn(() => mockTw.api);
  factory.twiml = actual.twiml;
  return factory;
});

const db = require('../models/db');
const logger = require('../services/logger');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const { nameOnFileForPhone } = require('../services/admin-alert-names');
const hold = require('../services/call-hold');

const SID = `CA${'a'.repeat(32)}`;
const LEG = `CA${'0'.repeat(31)}1`;
const ROOM = `CF${'d'.repeat(32)}`;

function fakeCallLog(metadata, extra = {}) {
  const row = { metadata: JSON.parse(JSON.stringify(metadata)), ...extra };
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
  db.mockImplementation((table) => {
    const conditions = [];
    const chain = {
      where: jest.fn(() => chain),
      whereRaw: jest.fn((sql) => { conditions.push(sql); return chain; }),
      first: jest.fn(async () => (table === 'customers'
        ? { first_name: 'Test', last_name: 'Customer' }
        : { id: 77, customer_id: row.customerId || null, from_phone: '+19415550100', metadata: JSON.parse(JSON.stringify(row.metadata)) })),
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
  const conferences = jest.fn((sid) => ({
    participants: (callSid) => participants(callSid),
    roomSid: sid,
    update: (params) => step('room', { sid, ...params }),
  }));
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

  // A database write that fails after Twilio took the caller off hold must not strand the caller alone
  // in the room while the staff stay on the menu.
  const failWrites = () => {
    const working = db.getMockImplementation();
    db.mockImplementation((...args) => {
      const chain = working(...args);
      chain.update = jest.fn(async () => { throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); });
      return chain;
    });
  };

  test('the claim write fails after the unhold: returned, and the recording still resumes', async () => {
    const row = fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    const events = fakeTwilio();
    failWrites();
    expect(await hold.endHold(SID)).toBe('returned');
    expect(events.map((e) => e.name)).toEqual(['list', 'participant', 'recording']);
    expect(events[2]).toMatchObject({ which: 'Twilio.CURRENT', status: 'in-progress' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('(ECONNRESET)'));
    expect(stateOf(row).open).toBe(true);
  });

  test('no room and the claim write fails: still no_room', async () => {
    fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    fakeTwilio({ rooms: [] });
    failWrites();
    expect(await hold.endHold(SID)).toBe('no_room');
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
    expect(Number.isNaN(Date.parse((await hold.holdState(SID)).openAt))).toBe(false);
    expect((await hold.holdState(SID)).voicemailAt).toBeNull();
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

describe('startHoldVoicemail', () => {
  const heldCall = async (extra) => {
    const row = fakeCallLog(room(), extra);
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    jest.clearAllMocks();
    return row;
  };

  test('claims once with the whole hold object, ends the room, then raises one alert', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-11-17T15:00:00Z'));
      const row = fakeCallLog(room());
      fakeTwilio();
      await hold.startHold(SID, { legSid: LEG });
      jest.setSystemTime(new Date('2026-11-17T15:05:00Z'));
      const events = fakeTwilio();
      expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('started');
      expect(events.map((e) => e.name)).toEqual(['list', 'room']);
      expect(events[0]).toMatchObject({ friendlyName: `waves-${SID}`, status: 'in-progress', limit: 5 });
      expect(events[1]).toMatchObject({ sid: ROOM, status: 'completed' });
      expect(stateOf(row)).toMatchObject({
        open: false, count: 1, total_sec: 300, voicemail_reason: 'timeout', voicemail_at: '2026-11-17T15:05:00.000Z', by: 'star', leg_sid: LEG,
      });
      // The claim is gone: a second request (the facts loop and the menu race) is not needed, and touches nothing.
      events.length = 0;
      expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('not_needed');
      expect(events).toHaveLength(0);
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('every open room is ended', async () => {
    const row = fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    const events = fakeTwilio({ rooms: [{ sid: ROOM }, { sid: `CF${'e'.repeat(32)}` }] });
    expect(await hold.startHoldVoicemail(SID, 'staff_left')).toBe('started');
    expect(events.filter((e) => e.name === 'room').map((e) => e.sid)).toEqual([ROOM, `CF${'e'.repeat(32)}`]);
    expect(stateOf(row).voicemail_reason).toBe('staff_left');
  });

  test('one of two rooms already gone (404): the other is ended, the voicemail starts', async () => {
    fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    const events = fakeTwilio({ rooms: [{ sid: ROOM }, { sid: `CF${'e'.repeat(32)}` }] });
    const update = mockTw.api.conferences.getMockImplementation();
    mockTw.api.conferences.mockImplementation((sid) => ({
      ...update(sid),
      update: async (params) => {
        events.push({ name: 'room', sid, ...params });
        if (sid === ROOM) throw err404();
      },
    }));
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('started');
    expect(events.filter((e) => e.name === 'room')).toHaveLength(2);
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
  });

  test('no open room: caller_gone, the claim stays, no alert', async () => {
    const row = fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    fakeTwilio({ rooms: [] });
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('caller_gone');
    expect(stateOf(row)).toMatchObject({ open: false, voicemail_reason: 'timeout' });
    expect(stateOf(row).voicemail_at).toBeTruthy();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('a 404 on the room end is caller_gone too', async () => {
    fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    fakeTwilio({ fail: { room: err404() } });
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('caller_gone');
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('any other REST error restores the hold as it was: failed, no alert, and the next loop can claim', async () => {
    const row = fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    const before = JSON.parse(JSON.stringify(stateOf(row)));
    fakeTwilio({ fail: { room: Object.assign(new Error('boom +19415550100'), { status: 500, code: 51000 }) } });
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('failed');
    expect(stateOf(row)).toEqual(before);
    expect(raiseAdminAlert).not.toHaveBeenCalled();
    const logged = JSON.stringify(logger.warn.mock.calls);
    expect(logged).toContain('51000');
    expect(logged).not.toContain('+19415550100');
    fakeTwilio();
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('started');
  });

  test('a restore never overwrites a voicemail stamp that is not ours', async () => {
    const row = fakeCallLog(room());
    fakeTwilio();
    await hold.startHold(SID, { legSid: LEG });
    fakeTwilio({ fail: { room: Object.assign(new Error('x'), { status: 500 }) } });
    mockTw.api.conferences.list = jest.fn(async () => {
      stateOf(row).voicemail_at = '2026-11-17T09:00:00.000Z'; // another request stamped it meanwhile
      return [{ sid: ROOM }];
    });
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('failed');
    expect(stateOf(row).voicemail_at).toBe('2026-11-17T09:00:00.000Z');
  });

  test('not needed: no hold open, a closed call, or a state read that throws', async () => {
    const row = fakeCallLog(room());
    const events = fakeTwilio();
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('not_needed');
    await hold.startHold(SID, { legSid: LEG });
    row.metadata.conference_path.closed_at = '2026-11-17T12:00:00Z';
    events.length = 0;
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('not_needed');
    expect(events).toHaveLength(0);
    db.mockImplementation(() => { throw new Error('db down'); });
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('failed');
  });

  test('the alert: needs-you, Comms, the customer on the call, the call link, one dedupe key', async () => {
    await heldCall({ customerId: 'cust-1' });
    fakeTwilio();
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('started');
    expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
    const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
    expect(category).toBe('voicemail_callback');
    expect(spec).toEqual({
      area: 'Comms',
      action: 'call Test Customer back',
      why: 'Waited 5 minutes on hold, then went to voicemail.',
      severity: 'needs-you',
      link: '/admin/communications#tab=calls&call=77',
      subject: { type: 'call', id: '77' },
      doneWhen: 'caller_reached',
      who: 'person',
    });
    expect(opts).toMatchObject({ bell: true, dedupeKey: `call-hold-voicemail:${SID}`, metadata: { callLogId: 77, reason: 'timeout' } });
    expect(JSON.stringify(raiseAdminAlert.mock.calls)).not.toMatch(/\+1\d{10}/);
  });

  test('staff_left why; no customer on the call uses the name on file for the number, else a plain wording', async () => {
    await heldCall();
    fakeTwilio();
    nameOnFileForPhone.mockResolvedValueOnce('Pat Sample');
    await hold.startHoldVoicemail(SID, 'staff_left');
    expect(raiseAdminAlert.mock.calls[0][1]).toMatchObject({
      action: 'call Pat Sample back',
      why: 'The staff phone hung up during a hold; the caller went to voicemail.',
    });
    expect(nameOnFileForPhone).toHaveBeenCalledWith(expect.anything(), '+19415550100');

    jest.clearAllMocks();
    await heldCall();
    fakeTwilio();
    await hold.startHoldVoicemail(SID, 'timeout');
    expect(raiseAdminAlert.mock.calls[0][1].action).toBe('call back an unknown caller');
  });

  test('an alert failure is logged by code and the voicemail still starts', async () => {
    const row = await heldCall();
    fakeTwilio();
    raiseAdminAlert.mockRejectedValueOnce(Object.assign(new Error('boom +19415550100'), { code: 'ALERT1' }));
    expect(await hold.startHoldVoicemail(SID, 'timeout')).toBe('started');
    expect(stateOf(row).voicemail_at).toBeTruthy();
    const logged = JSON.stringify(logger.error.mock.calls);
    expect(logged).toContain('ALERT1');
    expect(logged).not.toContain('+19415550100');
  });

  test('heldSeconds counts from open_at while the hold is open, and is 0 otherwise', () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-11-17T15:03:00Z'));
      expect(hold.heldSeconds({ open: true, openAt: '2026-11-17T15:00:00Z' })).toBe(180);
      expect(hold.heldSeconds({ open: false, openAt: '2026-11-17T15:00:00Z' })).toBe(0);
      expect(hold.heldSeconds({ open: true, openAt: null })).toBe(0);
      expect([hold.HOLD_REMINDER_SEC, hold.HOLD_LIMIT_SEC]).toEqual([180, 300]);
    } finally {
      jest.useRealTimers();
    }
  });
});
