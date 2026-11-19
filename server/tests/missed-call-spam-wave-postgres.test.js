// CI's DB-gated pass runs this against PostgreSQL. Fixtures live in a unique
// schema removed after the suite; the bell delivery (triggerNotification) is
// mocked. Pins the robodialer-wave rule of the missed-call bell (owner
// 2026-10-20 "yes"): a GBP line, under 30 s, no voicemail, 3+ unknown numbers
// from one 6-digit block in 14 days. Gate on = bell row written, push quiet;
// gate off = the bell rings as before and the call is stamped for the shadow read.
const SKIP = !process.env.DATABASE_URL;
const knex = require('knex');
const { randomUUID } = require('crypto');
let mockConn;
jest.mock('../models/db', () => {
  const proxy = (...args) => mockConn(...args);
  proxy.raw = (...args) => mockConn.raw(...args);
  proxy.transaction = (...args) => mockConn.transaction(...args);
  return proxy;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
const GBP_LINE = '+19413840224';
const OFFICE_LINE = '+19412975749';
const SECOND_GBP_LINE = '+19412590111';
jest.mock('../config/twilio-numbers', () => {
  const gbp = { '+19413840224': 'GBP — Parrish', '+19412590111': 'GBP — Venice' };
  return {
    findByNumber: jest.fn((n) => (gbp[n] ? { type: 'gbp_tracking', label: gbp[n] } : { type: 'location', label: 'Office' })),
    isInternalNumber: jest.fn(() => false),
    gbpTracking: { parrish: { number: '+19413840224', label: 'GBP — Parrish' }, venice: { number: '+19412590111', label: 'GBP — Venice' } },
  };
});
jest.mock('../services/notification-triggers', () => ({
  // Like the real trigger, reports the bell result through onBell before the push.
  triggerNotification: jest.fn(async (key, payload, opts) => { opts?.onBell?.(true); return { bellWritten: true }; }),
}));
jest.mock('../services/notification-service', () => ({ supersedeMissedCallAdmin: jest.fn(async () => {}) }));
jest.mock('../services/admin-alert-compose', () => ({ raiseAdminAlert: jest.fn(async () => {}) }));

const { isEnabled } = require('../config/feature-gates');
const { triggerNotification } = require('../services/notification-triggers');
const { raiseAdminAlert } = require('../services/admin-alert-compose');
const { ringMissedCallIfUnanswered, isRobodialerWave, isRobodialerBurst, isRepeatSilentCaller, exchangeHangupScreenHit } = require('../services/missed-call-bell');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('missed-call bell: robodialer wave on PostgreSQL', () => {
  let database;
  const schema = `missed_call_wave_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'scheduled_services', 'invoices', 'customers', 'leads', 'notifications', 'blocked_numbers', 'blocked_call_attempts', 'sms_log', 'technicians'];

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    // call_log keeps its column defaults: the repeat rule's silent shape must
    // pass a row the database fills in, so a column added later with a
    // non-NULL default fails the positive cases here (pre-push audit r10).
    for (const table of tables) {
      if (table === 'call_log') await database.raw('CREATE TABLE ??.?? (LIKE public.?? INCLUDING DEFAULTS)', [schema, table, table]);
      else await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    }
    mockConn = database;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation(() => true);
  });
  afterEach(async () => {
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  // An unanswered inbound call `minutesAgo` minutes ago, past the voicemail grace.
  function call(fromPhone, minutesAgo, extra = {}) {
    const at = new Date(Date.now() - minutesAgo * 60 * 1000);
    return {
      id: randomUUID(),
      twilio_call_sid: `CA${randomUUID().replaceAll('-', '')}`,
      direction: 'inbound',
      from_phone: fromPhone,
      to_phone: GBP_LINE,
      customer_id: null,
      status: 'completed',
      answered_by: 'voicemail',
      duration_seconds: 24,
      metadata: {},
      created_at: at,
      updated_at: at,
      ...extra,
    };
  }
  // Two earlier unknown numbers from the same 941-555 block: the third makes a wave.
  async function earlierWave(block = '+1941555') {
    await database('call_log').insert([call(`${block}0101`, 60 * 24 * 3), call(`${block}0202`, 60 * 24)]);
  }
  const stored = (row) => database('call_log').where({ id: row.id }).first();
  // The next trigger call reports `stats`, and whether it wrote the bell row, as the real one does.
  const reports = (stats, written = stats.bellWritten) => triggerNotification.mockImplementationOnce(async (key, payload, opts) => { opts?.onBell?.(written); return stats; });

  test('gate on: the third number of a block on a GBP line keeps its bell row, sends no push, and settles', async () => {
    await earlierWave();
    const row = call('+19415550303', 10);
    await database('call_log').insert(row);
    // What the real trigger reports when beforePush stops the push after the bell row is written.
    reports({ bellWritten: true, push: { sent: 0, skipped: 'superseded_before_push' } });
    expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const { beforePush } = triggerNotification.mock.calls[0][2];
    expect(await beforePush({ dispatching: false })).toBe(false);
    expect(await beforePush({ dispatching: true })).toBe(false);
    const { metadata } = await stored(row);
    expect(metadata.missed_call_spam_wave).toBe('block_quiet');
    expect(metadata.missed_call_settled_at).toEqual(expect.any(String));
    // Gate D (push check) reads a skipped push as deliberate: no retry, no daily alert.
    expect(metadata.missed_call_push_retries).toBeUndefined();
    expect(raiseAdminAlert).not.toHaveBeenCalled();
  });

  test('quiet only after a bell row exists: no row written this pass (every admin has the bell off) lets the push go (Codex #6392 r3)', async () => {
    await earlierWave();
    const row = call('+19415550303', 10);
    await database('call_log').insert(row);
    reports({ bellWritten: false, push: { sent: 1, subscriptions: 1 } }, false);
    await ringMissedCallIfUnanswered(row.twilio_call_sid);
    const { beforePush } = triggerNotification.mock.calls[0][2];
    // The ordinary supersession check decides, as for any call: still missed, so the push goes.
    expect(await beforePush({ dispatching: false })).toBe(true);
    expect((await stored(row)).metadata.missed_call_spam_wave).toBe('block_quiet');
  });

  test('a quiet stamp that fails or updates no row fails open: the push goes (Codex #6392 r3)', async () => {
    await earlierWave();
    const row = call('+19415550303', 10);
    await database('call_log').insert(row);
    // The stamp UPDATE is the only write whose SQL is `metadata || $1::jsonb`: make it match 0 rows.
    const original = mockConn;
    mockConn = Object.assign((...args) => {
      const qb = original(...args);
      const update = qb.update.bind(qb);
      qb.update = (value, ...rest) => (String(value?.metadata?.sql || '').startsWith('metadata || ') ? Promise.resolve(0) : update(value, ...rest));
      return qb;
    }, { raw: (...a) => original.raw(...a), transaction: (...a) => original.transaction(...a) });
    try {
      await ringMissedCallIfUnanswered(row.twilio_call_sid);
      const { beforePush } = triggerNotification.mock.calls[0][2];
      expect(await beforePush({ dispatching: false })).toBe(true);
    } finally {
      mockConn = original;
    }
    expect((await stored(row)).metadata.missed_call_spam_wave).toBeUndefined();
  });

  test('a block wave and a burst together, both gates on, are stamped block_quiet', async () => {
    const gbp = { to_phone: GBP_LINE, duration_seconds: 24 };
    await database('call_log').insert([call('+19415550101', 120, gbp), call('+19415550202', 90, gbp)]);
    const row = call('+19415550303', 10, gbp);
    await database('call_log').insert(row);
    expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
    expect(await triggerNotification.mock.calls[0][2].beforePush({ dispatching: false })).toBe(false);
    expect((await stored(row)).metadata.missed_call_spam_wave).toBe('block_quiet');
  });

  test('gate off: the wave call still rings, stamped for the shadow read', async () => {
    isEnabled.mockImplementation((name) => name !== 'missedCallSpamWave' && name !== 'missedCallSpamBurst');
    await earlierWave();
    const row = call('+19415550303', 10);
    await database('call_log').insert(row);
    expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    const { metadata } = await stored(row);
    expect(metadata.missed_call_spam_wave_shadow).toBe(true);
    expect(metadata.missed_call_spam_wave).toBeUndefined();
  });

  test('not a wave: two numbers in the block, an office line, 30 s or more, an older block call, or a customer phone slot', async () => {
    // The call being judged is stored first, as it always is in production.
    const row = call('+19415550303', 10);
    await database('call_log').insert(row);
    const third = (extra) => ({ ...row, ...extra });
    // Only one earlier number.
    await database('call_log').insert(call('+19415550101', 60));
    expect(await isRobodialerWave(third())).toBe(false);
    await database('call_log').insert(call('+19415550202', 60));
    expect(await isRobodialerWave(third())).toBe(true);
    // A non-GBP line, or a call of 30 s or more.
    expect(await isRobodialerWave(third({ to_phone: OFFICE_LINE }))).toBe(false);
    expect(await isRobodialerWave(third({ duration_seconds: 30 }))).toBe(false);
    // The number is on a customer's spouse slot: never a wave.
    await database('customers').insert({ id: randomUUID(), first_name: 'Sample', last_name: 'Person', phone: '+19415559999', service_contact_phone: '(941) 555-0303' });
    expect(await isRobodialerWave(third())).toBe(false);
  });

  test('an earlier block number that is on a customer record does not count toward the wave (pre-push audit)', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row, call('+19415550101', 60), call('+19415550202', 60)]);
    expect(await isRobodialerWave(row)).toBe(true);
    await database('customers').insert({ id: randomUUID(), first_name: 'Sample', last_name: 'Person', phone: '+19415550202' });
    expect(await isRobodialerWave(row)).toBe(false);
  });

  test('the call counts itself even when its stored time carries microseconds (pre-push audit)', async () => {
    const row = call('+19415550303', 0);
    await database('call_log').insert([call('+19415550101', 60), call('+19415550202', 60)]);
    await database.raw("INSERT INTO call_log (id, twilio_call_sid, direction, from_phone, to_phone, status, answered_by, duration_seconds, metadata, created_at, updated_at) VALUES (?, ?, 'inbound', ?, ?, 'completed', 'voicemail', 24, '{}', now(), now())", [row.id, row.twilio_call_sid, row.from_phone, row.to_phone]);
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(await isRobodialerWave(stored)).toBe(true);
  });

  test('a number on a customer secondary_phone, and a non-North-American caller, are never a wave (Codex #6379 r1)', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row, call('+19415550101', 60), call('+19415550202', 60)]);
    expect(await isRobodialerWave(row)).toBe(true);
    const intl = call('+449415550303', 10);
    await database('call_log').insert([intl, call('+449415550404', 60)]);
    expect(await isRobodialerWave(intl)).toBe(false);
    await database('customers').insert({ id: randomUUID(), first_name: 'Sample', last_name: 'Person', phone: '+19415559999', secondary_phone: '941-555-0303' });
    expect(await isRobodialerWave(row)).toBe(false);
  });

  test('a soft-deleted customer record does not make a number known (Codex #6379 r2)', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row, call('+19415550101', 60), call('+19415550202', 60)]);
    await database('customers').insert([
      { id: randomUUID(), first_name: 'Sample', last_name: 'Gone', phone: '+19415550303', deleted_at: new Date() },
      { id: randomUUID(), first_name: 'Sample', last_name: 'Gone', phone: '+19415550202', deleted_at: new Date() },
    ]);
    expect(await isRobodialerWave(row)).toBe(true);
  });

  test('only wave-like block calls count: answered, long, voicemail or office-line history does not (Codex #6379 r3)', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row,
      call('+19415550101', 60, { answered_by: 'human', duration_seconds: 120 }),
      call('+19415550202', 60, { duration_seconds: 45 }),
      call('+19415550404', 60, { recording_sid: 'RE_sample' }),
      call('+19415550505', 60, { to_phone: OFFICE_LINE }),
    ]);
    expect(await isRobodialerWave(row)).toBe(false);
    await database('call_log').insert([call('+19415550606', 60), call('+19415550707', 60)]);
    expect(await isRobodialerWave(row)).toBe(true);
  });

  test('an international customer slot sharing the last ten digits does not make a +1 caller known (Codex #6379 r3)', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row, call('+19415550101', 60), call('+19415550202', 60)]);
    await database('customers').insert({ id: randomUUID(), first_name: 'Sample', last_name: 'Abroad', phone: '+449415550303' });
    expect(await isRobodialerWave(row)).toBe(true);
  });

  test('history with no outcome, or handled by the AI agent, is no wave member (Codex #6379 r4)', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row,
      call('+19415550101', 60, { answered_by: null, status: 'completed' }),
      call('+19415550202', 60, { call_outcome: 'ai_handled' }),
    ]);
    expect(await isRobodialerWave(row)).toBe(false);
  });

  test('a wave check that errors rings the bell as usual (Codex #6379 r4)', async () => {
    await earlierWave();
    const row = call('+19415550303', 10);
    await database('call_log').insert(row);
    const numbers = require('../config/twilio-numbers');
    const original = numbers.findByNumber.getMockImplementation();
    numbers.findByNumber.mockImplementation(() => { throw new Error('config down'); });
    try {
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    } finally {
      numbers.findByNumber.mockImplementation(original);
    }
  });

  test('a block member whose caller later got through does not count (Codex #6379 r6)', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row, call('+19415550101', 120), call('+19415550202', 120),
      call('+19415550202', 90, { answered_by: 'human', status: 'completed', duration_seconds: 140 })]);
    expect(await isRobodialerWave(row)).toBe(false);
  });

  test('a plus-prefixed international number with ten digits is not North American (Codex #6379 r6)', async () => {
    const row = call('+4922123456', 10);
    await database('call_log').insert([row, call('+4922123457', 60), call('+4922123458', 60)]);
    expect(await isRobodialerWave(row)).toBe(false);
  });

  test('the judged call must itself be a wave member: an empty-voicemail caller beside three block numbers is no wave, and rings', async () => {
    await database('call_log').insert([call('+19415550101', 60), call('+19415550202', 60), call('+19415550404', 60)]);
    const row = call('+19415550303', 10, { recording_sid: 'RE_sample', recording_url: 'https://example.invalid/r', transcription_status: 'rejected', transcription: '[NO SPEECH]' });
    await database('call_log').insert(row);
    expect(await isRobodialerWave(row)).toBe(false);
    // The same call with no recording is the fourth block number: a wave.
    await database('call_log').where({ id: row.id }).update({ recording_sid: null, recording_url: null });
    expect(await isRobodialerWave(row)).toBe(true);
    // Handled by the AI agent, or answered by a person: not a member either.
    await database('call_log').where({ id: row.id }).update({ call_outcome: 'ai_handled' });
    expect(await isRobodialerWave(row)).toBe(false);
    await database('call_log').where({ id: row.id }).update({ call_outcome: null, answered_by: 'human' });
    expect(await isRobodialerWave(row)).toBe(false);
  });

  test('block calls older than 14 days do not count', async () => {
    const row = call('+19415550303', 10);
    await database('call_log').insert([row, call('+19415550101', 60 * 24 * 15), call('+19415550202', 60 * 24 * 16)]);
    expect(await isRobodialerWave(row)).toBe(false);
  });

  test('a customer on file always rings, even inside a wave', async () => {
    await earlierWave();
    const customerId = randomUUID();
    await database('customers').insert({ id: customerId, first_name: 'Sample', last_name: 'Person', phone: '+19415550303' });
    const row = call('+19415550303', 10, { customer_id: customerId });
    await database('call_log').insert(row);
    expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect((await stored(row)).metadata.missed_call_spam_wave_shadow).toBeUndefined();
  });
  // Burst: rotating prefixes, so no 6-digit block repeats. Three different
  // first-time unknown numbers on one line inside 24 h, 15 s or more, within 1 s.
  describe('robodialer burst (GATE_MISSED_CALL_SPAM_BURST)', () => {
    const burstCall = (fromPhone, minutesAgo, extra = {}) => call(fromPhone, minutesAgo, { to_phone: OFFICE_LINE, duration_seconds: 53, ...extra });
    // Two earlier members from different blocks, then the call judged.
    async function twoMembers(extra = {}) {
      await database('call_log').insert([burstCall('+19415550101', 120, extra), burstCall('+17275550202', 90, extra)]);
    }
    const burstRow = (extra = {}) => burstCall('+13525550303', 10, extra);
    const onlyBurst = (name) => name === 'missedCallSpamBurst' || name === 'missedCallUnknownCallers';

    test('gate on: the third first-time number on a line, 53 s each, keeps its bell row, sends no push, and settles', async () => {
      await twoMembers();
      const row = burstRow();
      await database('call_log').insert(row);
      // What the real trigger reports when beforePush stops the push after the bell row is written.
      reports({ bellWritten: true, push: { sent: 0, skipped: 'superseded_before_push' } });
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      const { beforePush } = triggerNotification.mock.calls[0][2];
      expect(await beforePush({ dispatching: false })).toBe(false);
      expect(await beforePush({ dispatching: true })).toBe(false);
      const { metadata } = await stored(row);
      expect(metadata.missed_call_spam_wave).toBe('burst_quiet');
      expect(metadata.missed_call_settled_at).toEqual(expect.any(String));
      // Gate D (push check) reads a skipped push as deliberate: no retry, no daily alert.
      expect(metadata.missed_call_push_retries).toBeUndefined();
      expect(metadata.missed_call_notified_at).toBeDefined();
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('a burst with no push attempt at all (no push-enabled admin) settles too, with no retry', async () => {
      await twoMembers();
      const row = burstRow();
      await database('call_log').insert(row);
      reports({ bellWritten: true, push: null });
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      const { metadata } = await stored(row);
      expect(metadata.missed_call_settled_at).toEqual(expect.any(String));
      expect(metadata.missed_call_push_retries).toBeUndefined();
    });

    test('an ordinary call still gets the normal supersession check as its beforePush', async () => {
      const row = call('+19415550303', 10, { to_phone: OFFICE_LINE });
      await database('call_log').insert(row);
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      const { beforePush } = triggerNotification.mock.calls[0][2];
      expect(await beforePush({ dispatching: false })).toBe(true);
    });

    test('gate off: the burst call still rings, stamped missed_call_spam_burst_shadow only', async () => {
      isEnabled.mockImplementation((name) => name !== 'missedCallSpamBurst');
      await twoMembers();
      const row = burstRow();
      await database('call_log').insert(row);
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      const { metadata } = await stored(row);
      expect(metadata.missed_call_spam_burst_shadow).toBe(true);
      expect(metadata.missed_call_spam_wave_shadow).toBeUndefined();
      expect(metadata.missed_call_spam_wave).toBeUndefined();
      expect(await triggerNotification.mock.calls[0][2].beforePush({ dispatching: false })).toBe(true);
    });

    test('the burst gate alone quiets a call that is also a block wave; the block shadow is stamped', async () => {
      isEnabled.mockImplementation(onlyBurst);
      const gbp = { to_phone: GBP_LINE, duration_seconds: 24 };
      await database('call_log').insert([burstCall('+19415550101', 120, gbp), burstCall('+19415550202', 90, gbp)]);
      const row = burstCall('+19415550303', 10, gbp);
      await database('call_log').insert(row);
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      expect(await triggerNotification.mock.calls[0][2].beforePush({ dispatching: false })).toBe(false);
      const { metadata } = await stored(row);
      expect(metadata.missed_call_spam_wave).toBe('burst_quiet');
      expect(metadata.missed_call_spam_wave_shadow).toBe(true);
    });

    test('only the call itself and earlier members count: two members is no burst, the third makes one', async () => {
      const row = burstRow();
      await database('call_log').insert([row, burstCall('+19415550101', 120)]);
      expect(await isRobodialerBurst(row)).toBe(false);
      await database('call_log').insert(burstCall('+17275550202', 90));
      expect(await isRobodialerBurst(row)).toBe(true);
    });

    test('durations must be within 1 s of this call and at least 15 s', async () => {
      const row = burstRow();
      await database('call_log').insert([row, burstCall('+19415550101', 120, { duration_seconds: 54 }), burstCall('+17275550202', 90, { duration_seconds: 52 })]);
      expect(await isRobodialerBurst(row)).toBe(true);
      await database('call_log').where({ from_phone: '+17275550202' }).update({ duration_seconds: 51 });
      expect(await isRobodialerBurst(row)).toBe(false);
      // Short calls never form a burst, even all alike.
      const short = burstCall('+13525550404', 5, { duration_seconds: 14 });
      await database('call_log').insert([short, burstCall('+19415550606', 60, { duration_seconds: 14 }), burstCall('+19415550707', 60, { duration_seconds: 14 })]);
      expect(await isRobodialerBurst(short)).toBe(false);
    });

    test('same line only: members on another line do not count', async () => {
      const row = burstRow();
      await database('call_log').insert([row, burstCall('+19415550101', 120), burstCall('+17275550202', 90, { to_phone: GBP_LINE })]);
      expect(await isRobodialerBurst(row)).toBe(false);
    });

    test('24 h window: a member older than a day does not count', async () => {
      const row = burstRow();
      await database('call_log').insert([row, burstCall('+19415550101', 120), burstCall('+17275550202', 60 * 25)]);
      expect(await isRobodialerBurst(row)).toBe(false);
    });

    test('first call ever only: a member, or this caller, that called before is no burst member', async () => {
      const row = burstRow();
      await database('call_log').insert([row, burstCall('+19415550101', 120), burstCall('+17275550202', 90)]);
      expect(await isRobodialerBurst(row)).toBe(true);
      // An earlier member had called days ago: it is a repeat caller, not a member.
      await database('call_log').insert(burstCall('+17275550202', 60 * 24 * 5, { duration_seconds: 3 }));
      expect(await isRobodialerBurst(row)).toBe(false);
      // The judged call itself has a history: no burst.
      await database('call_log').where({ from_phone: '+17275550202' }).del();
      await database('call_log').insert([burstCall('+17275550202', 90), burstCall('+13525550303', 60 * 24 * 3, { duration_seconds: 3 })]);
      expect(await isRobodialerBurst(row)).toBe(false);
    });

    test('a member whose caller later got through is excluded', async () => {
      const row = burstRow();
      await database('call_log').insert([row, burstCall('+19415550101', 120), burstCall('+17275550202', 90),
        burstCall('+17275550202', 60, { answered_by: 'human', duration_seconds: 140 })]);
      // The later answered call also voids the first-call rule for that number's second row.
      expect(await isRobodialerBurst(row)).toBe(false);
    });

    test('a member with a voicemail, AI handling or no outcome is excluded', async () => {
      const row = burstRow();
      await database('call_log').insert([row, burstCall('+19415550101', 120), burstCall('+17275550202', 90, { recording_sid: 'RE_sample' })]);
      expect(await isRobodialerBurst(row)).toBe(false);
      await database('call_log').where({ from_phone: '+17275550202' }).update({ recording_sid: null, call_outcome: 'ai_handled' });
      expect(await isRobodialerBurst(row)).toBe(false);
    });

    test('a number on a customer slot is no member; neither is a linked call', async () => {
      const row = burstRow();
      await database('call_log').insert([row, burstCall('+19415550101', 120), burstCall('+17275550202', 90)]);
      expect(await isRobodialerBurst(row)).toBe(true);
      await database('customers').insert({ id: randomUUID(), first_name: 'Sample', last_name: 'Person', phone: '+19415559999', secondary_phone: '(727) 555-0202' });
      expect(await isRobodialerBurst(row)).toBe(false);
      // The judged call's own number on a slot: never a burst.
      await database('customers').where({ phone: '+19415559999' }).del();
      await database('customers').insert({ id: randomUUID(), first_name: 'Sample', last_name: 'Other', phone: '+13525550303' });
      expect(await isRobodialerBurst(row)).toBe(false);
      expect(await isRobodialerBurst({ ...row, customer_id: randomUUID() })).toBe(false);
    });

    test('a non-North-American caller never forms a burst', async () => {
      const row = burstCall('+4922123456', 10);
      await database('call_log').insert([row, burstCall('+4922123457', 60), burstCall('+4922123458', 60)]);
      expect(await isRobodialerBurst(row)).toBe(false);
    });

    test('a burst check that errors rings the bell as usual', async () => {
      await twoMembers();
      const row = burstRow();
      await database('call_log').insert(row);
      const original = mockConn;
      // Fail only the burst query: it is the one that selects bool_or.
      mockConn = Object.assign((...args) => original(...args), {
        raw: (sql, ...rest) => {
          if (String(sql).includes('bool_or')) throw new Error('db down');
          return original.raw(sql, ...rest);
        },
        transaction: (...args) => original.transaction(...args),
      });
      try {
        expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
        expect(triggerNotification).toHaveBeenCalledTimes(1);
        expect((await stored(row)).metadata.missed_call_spam_wave).toBeUndefined();
      } finally {
        mockConn = original;
      }
    });
  });

  // The press-1 screen's exchange trigger and the failed-screen push quiet
  // (GATE_CALL_SCREEN_EXCHANGE_HISTORY, owner 2026-11-16 "build").
  describe('press-1 screen exchange trigger', () => {
    const CALLER = '+19412360303';
    const officeCall = (fromPhone, minutesAgo, extra = {}) => call(fromPhone, minutesAgo, { to_phone: OFFICE_LINE, ...extra });
    const hit = () => exchangeHangupScreenHit(CALLER, new Date());
    const lead = (phone, extra = {}) => database('leads').insert({ id: randomUUID(), phone, created_at: new Date(), ...extra });

    test('two OTHER unknown numbers from the exchange that hung up with no message make a candidate; one does not', async () => {
      await database('call_log').insert(officeCall('+19412360101', 60 * 24 * 3));
      expect(await hit()).toBe(false);
      await database('call_log').insert(officeCall('+19412360202', 60 * 24));
      expect(await hit()).toBe(true);
    });

    test('a failed screen counts despite its silent recording; an answered call, a message, the same number and another exchange do not', async () => {
      await database('call_log').insert([
        officeCall('+19412360101', 60, { recording_duration_seconds: 6, recording_sid: 'RE1', metadata: { preconnect_screen: 'failed' } }),
        officeCall('+19412360202', 60, { answered_by: 'human' }),
        officeCall('+19412360404', 60, { recording_duration_seconds: 20, recording_sid: 'RE2' }),
        officeCall(CALLER, 60),
        officeCall('+19412370505', 60),
      ]);
      expect(await hit()).toBe(false);
      await database('call_log').insert(officeCall('+19412360606', 30));
      expect(await hit()).toBe(true);
    });

    test('no message is proven, never assumed: a recording without a length, a recording-less call inside the voicemail grace, or a failed screen with a real message does not count (Codex #7893 r1)', async () => {
      const twoMinutesAgo = new Date(Date.now() - 2 * 60 * 1000);
      await database('call_log').insert([
        officeCall('+19412360101', 60),
        officeCall('+19412360202', 60, { recording_sid: 'RE3', recording_duration_seconds: null }),
        officeCall('+19412360404', 2, { updated_at: twoMinutesAgo }),
        officeCall('+19412360505', 60, { recording_sid: 'RE4', recording_duration_seconds: 58, metadata: { preconnect_screen: 'failed' } }),
      ]);
      expect(await hit()).toBe(false);
      await database('call_log').where({ from_phone: '+19412360202' }).update({ recording_duration_seconds: 2 });
      expect(await hit()).toBe(true);
    });

    test('only the last 14 days count', async () => {
      await database('call_log').insert([officeCall('+19412360101', 60 * 24 * 15), officeCall('+19412360202', 60)]);
      expect(await hit()).toBe(false);
    });

    test('a member on a live lead or a customer slot, or one that got through later, is a real caller and does not count', async () => {
      await database('call_log').insert([officeCall('+19412360101', 120), officeCall('+19412360202', 120), officeCall('+19412360404', 120)]);
      await lead('(941) 236-0101');
      await database('customers').insert({ id: randomUUID(), first_name: 'Test', service_contact_phone: '941-236-0202', created_at: new Date(), updated_at: new Date() });
      expect(await hit()).toBe(false);
      await database('call_log').insert(officeCall('+19412360707', 90));
      expect(await hit()).toBe(true);
      await database('call_log').insert(officeCall('+19412360707', 30, { answered_by: 'human' }));
      expect(await hit()).toBe(false);
    });

    test('a caller on a live lead is never a candidate; a deleted lead does not count', async () => {
      await database('call_log').insert([officeCall('+19412360101', 120), officeCall('+19412360202', 120)]);
      await lead('+19412360303', { deleted_at: new Date() });
      expect(await hit()).toBe(true);
      await lead('941.236.0303');
      expect(await hit()).toBe(false);
    });

    test('a non-North-American caller is never a candidate', async () => {
      await database('call_log').insert([officeCall('+4922123401', 120), officeCall('+4922123402', 120)]);
      expect(await exchangeHangupScreenHit('+4922123403', new Date())).toBe(false);
    });

    test('gate on: an unknown caller who failed the screen keeps the bell row, sends no push, and is stamped screen_quiet', async () => {
      const row = officeCall('+15125550101', 10, { metadata: { preconnect_screen: 'failed' } });
      await database('call_log').insert(row);
      reports({ bellWritten: true, push: { sent: 0, skipped: 'superseded_before_push' } });
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      const { beforePush } = triggerNotification.mock.calls[0][2];
      expect(await beforePush({ dispatching: true })).toBe(false);
      expect((await stored(row)).metadata.missed_call_spam_wave).toBe('screen_quiet');
    });

    test('gate off: the failed-screen call pushes as before and is stamped for the shadow read', async () => {
      isEnabled.mockImplementation((name) => name !== 'callScreenExchangeHistory');
      const row = officeCall('+15125550101', 10, { metadata: { preconnect_screen: 'failed' } });
      await database('call_log').insert(row);
      reports({ bellWritten: true, push: { sent: 1, subscriptions: 1 } });
      await ringMissedCallIfUnanswered(row.twilio_call_sid);
      const { beforePush } = triggerNotification.mock.calls[0][2];
      expect(await beforePush({ dispatching: true })).toBe(true);
      const { metadata } = await stored(row);
      expect(metadata.missed_call_spam_wave).toBeUndefined();
      expect(metadata.missed_call_screen_quiet_shadow).toBe(true);
    });

    test('a caller who passed the screen is never quieted', async () => {
      const row = officeCall('+15125550101', 10, { metadata: { preconnect_screen: 'passed' } });
      await database('call_log').insert(row);
      reports({ bellWritten: true, push: { sent: 1, subscriptions: 1 } });
      await ringMissedCallIfUnanswered(row.twilio_call_sid);
      const { metadata } = await stored(row);
      expect(metadata.missed_call_spam_wave).toBeUndefined();
      expect(metadata.missed_call_screen_quiet_shadow).toBeUndefined();
    });
  });
  describe('repeat silent caller (GATE_MISSED_CALL_SPAM_REPEAT)', () => {
    const CALLER = '+17275550611';
    const repeat = (row) => isRepeatSilentCaller(row);
    const lead = (phone, extra = {}) => database('leads').insert({ id: randomUUID(), phone, created_at: new Date(), ...extra });
    // The call judged: the caller's latest silent hang-up on the Parrish GBP line
    // (the webhook stores the line's label as metadata.location; the bell names it).
    const judged = (extra = {}) => call(CALLER, 10, { metadata: { location: 'GBP — Parrish' }, ...extra });
    // History the carrier fully attested (what the webhook stores as metadata.stir_verstat).
    const prior = (phone, minutesAgo, extra = {}) => call(phone, minutesAgo, { metadata: { stir_verstat: 'TN-Validation-Passed-A' }, ...extra });

    test('gate on: the third silent call from one number keeps its bell row, sends no push, is titled likely robocall, and settles', async () => {
      isEnabled.mockImplementation((name) => name === 'missedCallSpamRepeat' || name === 'missedCallUnknownCallers');
      await database('call_log').insert([prior(CALLER, 60 * 24 * 3), prior(CALLER, 60 * 24)]);
      const row = judged();
      await database('call_log').insert(row);
      reports({ bellWritten: true, push: { sent: 0, skipped: 'superseded_before_push' } });
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      const [, payload, opts] = triggerNotification.mock.calls[0];
      expect(payload.name).toBe('likely robocall (GBP — Parrish)');
      expect(await opts.beforePush({ dispatching: true })).toBe(false);
      const { metadata } = await stored(row);
      expect(metadata.missed_call_spam_wave).toBe('repeat_quiet');
      expect(metadata.missed_call_settled_at).toEqual(expect.any(String));
      expect(metadata.missed_call_push_retries).toBeUndefined();
    });

    test('gate off: the call rings as before, titled unknown caller, stamped for the shadow read', async () => {
      isEnabled.mockImplementation((name) => name === 'missedCallUnknownCallers');
      await database('call_log').insert([prior(CALLER, 60 * 24 * 3), prior(CALLER, 60 * 24)]);
      const row = judged();
      await database('call_log').insert(row);
      reports({ bellWritten: true, push: { sent: 1, subscriptions: 1 } });
      await ringMissedCallIfUnanswered(row.twilio_call_sid);
      const [, payload, opts] = triggerNotification.mock.calls[0];
      expect(payload.name).toBe('unknown caller (GBP — Parrish)');
      expect(await opts.beforePush({ dispatching: true })).toBe(true);
      const { metadata } = await stored(row);
      expect(metadata.missed_call_spam_wave).toBeUndefined();
      expect(metadata.missed_call_spam_repeat_shadow).toBe(true);
    });

    test('one earlier silent call on another GBP line is a repeat; one on the same line is not; the first call never is', async () => {
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(false);
      await database('call_log').insert(prior(CALLER, 60 * 24));
      expect(await repeat(row)).toBe(false);
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      expect(await repeat(row)).toBe(true);
    });

    test('a redial one minute after a hang-up on another GBP line counts once that hang-up is past the voicemail grace at check time (pre-push audit)', async () => {
      // The first call ended 1 minute before the judged call began; the check runs 10 minutes after the judged call.
      await database('call_log').insert(prior(CALLER, 11, { to_phone: SECOND_GBP_LINE }));
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(true);
      // A hang-up that ended inside the grace at check time may still get its voicemail: it does not count.
      const fresh = prior('+17275550613', 2);
      const redial = call('+17275550613', 1);
      await database('call_log').insert([{ ...fresh, to_phone: SECOND_GBP_LINE }, redial]);
      expect(await repeat(redial)).toBe(false);
      // Nor with a known recording length of 0 (the shared read's short-recording
      // branch skips the grace), nor while the call is still in progress (pre-push audit r7).
      const zeroLength = prior('+17275550615', 2, { to_phone: SECOND_GBP_LINE, recording_duration_seconds: 0 });
      const zeroRedial = call('+17275550615', 1);
      const live = prior('+17275550616', 60 * 24, { to_phone: SECOND_GBP_LINE, status: 'in-progress', recording_duration_seconds: 0 });
      const liveRedial = call('+17275550616', 1);
      await database('call_log').insert([zeroLength, zeroRedial, live, liveRedial]);
      expect(await repeat(zeroRedial)).toBe(false);
      expect(await repeat(liveRedial)).toBe(false);
    });

    test('only fully attested history counts: B, a failed check or no attestation could be a spoofed number (pre-push audit)', async () => {
      const unattested = (minutesAgo, stir) => call(CALLER, minutesAgo, { to_phone: SECOND_GBP_LINE, metadata: stir ? { stir_verstat: stir } : {} });
      await database('call_log').insert([unattested(60 * 24, 'TN-Validation-Passed-B'), unattested(60 * 24 * 2, 'TN-Validation-Failed-A'), unattested(60 * 24 * 3, null)]);
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(false);
      await database('call_log').insert(prior(CALLER, 60 * 24 * 4, { to_phone: SECOND_GBP_LINE }));
      expect(await repeat(row)).toBe(true);
    });

    test.each(['passed', 'gated', 'failed'])('gate on: a call the press-1 screen touched (%s) is never quieted by this rule, and such history never counts (pre-push audit)', async (screen) => {
      isEnabled.mockImplementation((name) => name === 'missedCallSpamRepeat' || name === 'missedCallUnknownCallers');
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged({ metadata: { location: 'GBP — Parrish', preconnect_screen: screen } });
      await database('call_log').insert(row);
      reports({ bellWritten: true, push: { sent: 1, subscriptions: 1 } });
      await ringMissedCallIfUnanswered(row.twilio_call_sid);
      expect((await stored(row)).metadata.missed_call_spam_repeat_shadow).toBeUndefined();
      expect((await stored(row)).metadata.missed_call_spam_wave).not.toBe('repeat_quiet');
      // History: a call the screen touched on the other line is no silent hang-up for this rule.
      const next = call('+17275550614', 10);
      await database('call_log').insert([prior('+17275550614', 60 * 24, { to_phone: SECOND_GBP_LINE, metadata: { stir_verstat: 'TN-Validation-Passed-A', preconnect_screen: screen } }), next]);
      expect(await repeat(next)).toBe(false);
    });

    test('two earlier silent calls on any line make a repeat, but only a call on a GBP line is judged', async () => {
      await database('call_log').insert([prior(CALLER, 60 * 24 * 3, { to_phone: OFFICE_LINE }), prior(CALLER, 60 * 24, { to_phone: OFFICE_LINE })]);
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(true);
      expect(await repeat({ ...row, to_phone: OFFICE_LINE })).toBe(false);
    });

    test('only silent hang-ups of the last 14 days by the same number count', async () => {
      await database('call_log').insert([
        prior(CALLER, 60 * 24 * 15, { to_phone: SECOND_GBP_LINE }),
        prior('+17275550612', 60 * 24, { to_phone: SECOND_GBP_LINE }),
        prior('+17275550612', 60 * 24 * 2),
      ]);
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(false);
      await database('call_log').insert(prior(CALLER, 60 * 24, { to_phone: SECOND_GBP_LINE }));
      expect(await repeat(row)).toBe(true);
    });

    // A sign of a person anywhere on the number in the window, even on a call
    // the history never counts and before the counted hang-up (pre-push audit).
    test.each([
      ['a call linked to a customer', { customer_id: randomUUID() }],
      ['a call that reached staff', { answered_by: 'human' }],
      ['a call Sandy answered', { answered_by: 'ai_agent' }],
      ['a call Sandy handed to a person', { answered_by: null, call_outcome: 'ai_transferred' }],
      ["Sandy's session on a call that fell back to voicemail", { metadata: { relay_session_claimed_at: '2026-11-14T15:00:00.000Z' } }],
      ['a 2-second recording', { recording_sid: 'RE6', recording_duration_seconds: 2 }],
      // Empty main recording columns (pre-push audit r6): the audio sits in a metadata list.
      ['a recording parked on the row', { metadata: { additional_recordings: [{ recording_sid: 'RE7', recording_url: 'https://api.twilio.com/RE7' }] } }],
      ['a recording a replacement superseded', { metadata: { superseded_recordings: [{ recording_sid: 'RE8' }] } }],
      ['a recording length with no link yet', { recording_duration_seconds: 12 }],
      ['a transcript with no recording', { transcription: 'call me back about a quote' }],
      ["Sandy's transcript kept in metadata", { metadata: { relay_transcript: { text: 'caller: I need a quote' } } }],
      ['a call the voicemail lane rang for', { voicemail_callback_alerted_at: new Date() }],
      ['a press-1 pass', { metadata: { preconnect_screen: 'passed' } }],
      ['a challenge whose result was never saved', { metadata: { preconnect_screen: 'gated' } }],
      // Staff pressed 1 to accept, then the completion write was late or lost (pre-push audit r8):
      // by its columns the call looks unanswered.
      ['a staff acceptance whose completion was never saved', { answered_by: null, status: 'no-answer', metadata: { stir_verstat: 'TN-Validation-Passed-A', forward_acceptance: { accepted: true } } }],
      ['a conference leg staff accepted', { answered_by: null, status: 'no-answer', metadata: { stir_verstat: 'TN-Validation-Passed-A', conference_path: { accepted_leg_sid: 'CA0123456789abcdef0123456789abcdef' } } }],
      // Anything a silent hang-up never carries, named or not.
      ['a metadata key no silent hang-up carries', { metadata: { stir_verstat: 'TN-Validation-Passed-A', some_later_marker: true } }],
      ['a staff note', { metadata: { stir_verstat: 'TN-Validation-Passed-A' }, notes: 'asked about a quote' }],
      ['an inbound call that was bridged', { metadata: { stir_verstat: 'TN-Validation-Passed-A' }, bridged_at: new Date() }],
      // The settled-silent test is NULL here; IS NOT TRUE still counts the call as no silent hang-up.
      ['a call whose status was never saved', { answered_by: null, status: null, metadata: { stir_verstat: 'TN-Validation-Passed-A' } }],
      // A recording callback wrote the length, long settled (pre-push audit r9).
      ['a recorded length of 0 s', { metadata: { stir_verstat: 'TN-Validation-Passed-A' }, recording_duration_seconds: 0 }],
      // Values, not only keys (pre-push audit r11).
      ['an answer that is neither the voicemail nor unset', { answered_by: 'unknown', status: 'completed', metadata: { stir_verstat: 'TN-Validation-Passed-A' } }],
      ['a human-contact outcome', { call_outcome: 'info_given', metadata: { stir_verstat: 'TN-Validation-Passed-A' } }],
      ['a text-back skipped for a staff number', { metadata: { stir_verstat: 'TN-Validation-Passed-A', missed_call_text_outcome: 'skipped:internal_number' } }],
      ['a text-back skipped because the number was already contacted', { metadata: { stir_verstat: 'TN-Validation-Passed-A', missed_call_text_outcome: 'skipped:already_contacted' } }],
      ['a text-back held for an opt-out', { metadata: { stir_verstat: 'TN-Validation-Passed-A', missed_call_text_outcome: 'skipped:SUPPRESSED_OPT_OUT' } }],
    ])('a number with %s in the last 14 days is never a repeat (pre-push audit)', async (label, sign) => {
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(true);
      await database('call_log').insert(call(CALLER, 60 * 24 * 5, sign));
      expect(await repeat(row)).toBe(false);
    });

    // A staff call to the number before the counted hang-up, where "got through
    // later" cannot see it (pre-push audit r6, r7): any call to it is no silent hang-up.
    test.each([
      ['rang out', { status: 'no-answer', metadata: { customer_leg: { status: 'no-answer', duration_seconds: 0 } } }],
      ['reached the caller but lost its bridge stamp', { status: 'completed', metadata: { customer_leg: { status: 'completed', duration_seconds: 95 } } }],
    ])('a staff call to the number that %s means it is never a repeat', async (label, shape) => {
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(true);
      await database('call_log').insert(call(GBP_LINE, 60 * 24 * 4, { direction: 'outbound', to_phone: CALLER, answered_by: null, ...shape }));
      expect(await repeat(row)).toBe(false);
    });

    test('calls after the judged call, up to the check, count too: a staff callback blocks, a settled silent redial does not (pre-push audit r9)', async () => {
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged();
      await database('call_log').insert(row);
      // Two minutes after the judged call, over and past the voicemail grace at check time.
      await database('call_log').insert(prior(CALLER, 8));
      expect(await repeat(row)).toBe(true);
      // Staff called the number back before the bell was checked; it rang out.
      await database('call_log').insert(call(GBP_LINE, 6, { direction: 'outbound', to_phone: CALLER, answered_by: null, status: 'no-answer' }));
      expect(await repeat(row)).toBe(false);
    });

    // The bell read the call as missed; a late write changed it before the check (pre-push audit r10).
    test.each([
      ['answered by staff', { answered_by: 'human' }],
      ['handled by Sandy', { call_outcome: 'ai_handled' }],
      ['back in progress', { answered_by: null, status: 'in-progress' }],
    ])('a judged call %s after the bell read it is never quieted', async (label, late) => {
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(true);
      await database('call_log').where({ id: row.id }).update(late);
      expect(await repeat(row)).toBe(false);
    });

    test.each(['sent', 'skipped:NON_MOBILE_SMS_RECIPIENT', 'skipped:SUPPRESSED_NON_MOBILE', 'skipped:already_sent_to_phone'])('a silent hang-up with every call-setup and bookkeeping key production stores still counts (text-back %s)', async (textOutcome) => {
      const at = new Date(Date.now() - 60 * 24 * 2 * 60 * 1000).toISOString();
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, {
        to_phone: SECOND_GBP_LINE,
        call_outcome: 'voicemail',
        call_recording_consent_disclaimer_played: true,
        metadata: {
          stir_verstat: 'TN-Validation-Passed-A', addons: { status: 'successful' }, domain: 'example.test', location: 'GBP — Venice', numberType: 'mobile',
          screen_caller_name: 'WIRELESS CALLER', promise_chaser_eligible: true, ended_at: at,
          missed_call_notified_at: at, missed_call_settled_at: at, missed_call_text_leased_at: at, missed_call_text_settled_at: at,
          missed_call_text_outcome: textOutcome, missed_call_text_body: 'Sorry we missed your call', missed_call_spam_wave: 'repeat_quiet',
          missed_call_spam_repeat_shadow: true, repeat_caller_alerted_at: at,
        },
      }));
      const row = judged({ call_outcome: 'voicemail', call_recording_consent_disclaimer_played: true, metadata: { location: 'GBP — Parrish', stir_verstat: 'TN-Validation-Passed-B', missed_call_notified_at: at } });
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(true);
    });

    test.each([
      ['a staff acceptance', { metadata: { location: 'GBP — Parrish', forward_acceptance: { accepted: true } } }],
      ['a staff note', { notes: 'called back, it was a person' }],
    ])('the judged call with %s, more than a silent hang-up carries, is never quieted', async (label, extra) => {
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged(extra);
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(false);
      await database('call_log').where({ id: row.id }).update({ metadata: { location: 'GBP — Parrish' }, notes: null });
      expect(await repeat(row)).toBe(true);
    });

    // Texts like calls: only our own text-back leaves the number a repeat; an
    // older sign of a person (15 days) is outside the window (pre-push audit r11).
    test.each([
      ['our own text-back to it', true, { direction: 'outbound', from_phone: GBP_LINE, to_phone: CALLER, message_type: 'missed_call_text_back', message_body: 'Sorry we missed your call' }],
      ['a staff text to it', false, { direction: 'outbound', from_phone: GBP_LINE, to_phone: CALLER, message_type: 'manual', message_body: 'Hi, Waves returning your call' }],
      ['a text from it', false, { direction: 'inbound', from_phone: '(727) 555-0611', to_phone: GBP_LINE, message_body: 'please call me back', status: 'received' }],
    ])('a number with %s in the last 14 days is a repeat: %s', async (label, stillRepeat, sms) => {
      await database('call_log').insert([prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }), call(CALLER, 60 * 24 * 15, { answered_by: 'human' })]);
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(true);
      await database('sms_log').insert({ id: randomUUID(), status: 'delivered', created_at: new Date(Date.now() - 30 * 60 * 1000), ...sms });
      expect(await repeat(row)).toBe(stillRepeat);
    });

    test('one of our own lines or a staff forward is never a repeat (pre-push audit r11)', async () => {
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(true);
      const numbers = require('../config/twilio-numbers');
      numbers.isInternalNumber.mockReturnValueOnce(true);
      expect(await repeat(row)).toBe(false);
      expect(numbers.isInternalNumber).toHaveBeenCalledWith('+17275550611');
    });

    // The staff table itself, with no gate and no cache: the cached
    // staff-sender list answers "not staff" when it cannot tell (pre-push audit r12).
    test.each([
      ['an active technician', { role: 'technician', employment_status: 'active' }],
      ['a former technician', { role: 'technician', employment_status: 'inactive' }],
      ['a prospective hire', { role: 'technician', employment_status: 'prospective' }],
      ['an admin', { role: 'admin', employment_status: 'active' }],
    ])('the phone of %s, written another way, is never a repeat (pre-push audit r12)', async (label, staffRow) => {
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(true);
      await database('technicians').insert({ id: randomUUID(), name: 'Staff Test', phone: '727.555.0611', ...staffRow });
      expect(await repeat(row)).toBe(false);
    });

    test('a staff read that fails throws, so the bell pushes (pre-push audit r12)', async () => {
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged();
      await database('call_log').insert(row);
      await database('technicians').insert({ id: randomUUID(), name: 'Staff Test', phone: '(941) 555-0199', role: 'technician', employment_status: 'active' });
      expect(await repeat(row)).toBe(true);
      await database.raw('ALTER TABLE ??.?? RENAME TO ??', [schema, 'technicians', 'technicians_away']);
      try {
        await expect(repeat(row)).rejects.toThrow(/technicians/);
      } finally {
        await database.raw('ALTER TABLE ??.?? RENAME TO ??', [schema, 'technicians_away', 'technicians']);
      }
    });

    test('a caller who got through later, is on a live lead or on a customer slot is a real caller', async () => {
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged();
      await database('call_log').insert(row);
      expect(await repeat(row)).toBe(true);
      await lead('(727) 555-0611', { deleted_at: new Date() });
      expect(await repeat(row)).toBe(true);
      await lead('727.555.0611');
      expect(await repeat(row)).toBe(false);
      await database('leads').del();
      await database('customers').insert({ id: randomUUID(), first_name: 'Test', service_contact_phone: '727-555-0611', created_at: new Date(), updated_at: new Date() });
      expect(await repeat(row)).toBe(false);
      await database('customers').del();
      await database('call_log').insert(call(CALLER, 60 * 24, { answered_by: 'human' }));
      expect(await repeat(row)).toBe(false);
    });

    test('a call linked to a customer, or from a non-North-American number, is never a repeat', async () => {
      await database('call_log').insert([prior('+4922123401', 120, { to_phone: SECOND_GBP_LINE }), prior(CALLER, 120, { to_phone: SECOND_GBP_LINE })]);
      expect(await repeat(call('+4922123401', 10))).toBe(false);
      expect(await repeat(judged({ customer_id: randomUUID() }))).toBe(false);
    });

    test('a repeat check that errors pushes as usual', async () => {
      isEnabled.mockImplementation((name) => name === 'missedCallSpamRepeat' || name === 'missedCallUnknownCallers');
      await database('call_log').insert(prior(CALLER, 60 * 24 * 2, { to_phone: SECOND_GBP_LINE }));
      const row = judged();
      await database('call_log').insert(row);
      const numbers = require('../config/twilio-numbers');
      const original = numbers.findByNumber.getMockImplementation();
      numbers.findByNumber.mockImplementation(() => { throw new Error('config down'); });
      try {
        reports({ bellWritten: true, push: { sent: 1, subscriptions: 1 } });
        expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
        expect(await triggerNotification.mock.calls[0][2].beforePush({ dispatching: true })).toBe(true);
      } finally {
        numbers.findByNumber.mockImplementation(original);
      }
      expect((await stored(row)).metadata.missed_call_spam_wave).toBeUndefined();
    });
  });
});
