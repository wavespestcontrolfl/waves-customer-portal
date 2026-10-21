// Missed-call alert gaps (owner 2026-10-20, "ALL"). Four dark gates, admin bell only:
//   A GATE_MISSED_CALL_EMPTY_VM_CUSTOMER   B GATE_MISSED_CALL_NO_OUTCOME_CUSTOMER
//   C GATE_CALLBACK_NEEDS_ANSWER           D GATE_MISSED_CALL_PUSH_CHECK
// CI's DATABASE_URL pass runs this on PostgreSQL. Fixture data lives in a unique
// schema that is removed after the suite; delivery is mocked. Synthetic phones only.
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
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn() }));
jest.mock('../services/admin-alert-compose', () => ({
  ...jest.requireActual('../services/admin-alert-compose'),
  raiseAdminAlert: jest.fn(async () => ({ id: 'alert-1' })),
}));
const { triggerNotification } = require('../services/notification-triggers');
const { raiseAdminAlert, composeAdminAlert } = require('../services/admin-alert-compose');
const logger = require('../services/logger');
const { gates } = require('../config/feature-gates');
const { phoneKeySql } = require('../middleware/spam-block');
const { etDateString } = require('../utils/datetime-et');
const {
  ringMissedCallIfUnanswered, sweepMissedCalls, retireCalledBackMissedCalls, calledBackSql, CALLED_BACK_SQL,
} = require('../services/missed-call-bell');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('missed-call alert gaps on PostgreSQL', () => {
  let database;
  const schema = `call_gaps_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'scheduled_services', 'customers', 'notifications', 'blocked_numbers', 'blocked_call_attempts'];
  let now;
  const gateNames = ['missedCallUnknownCallers', 'missedCallEmptyVmCustomer', 'missedCallNoOutcomeCustomer', 'callbackNeedsAnswer', 'missedCallPushCheck'];
  const savedGates = Object.fromEntries(gateNames.map((key) => [key, gates[key]]));
  const setGates = (on) => gateNames.forEach((key) => { gates[key] = on.includes(key); });

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
  });
  beforeEach(() => {
    now = Date.now();
    jest.clearAllMocks();
    setGates([]);
    triggerNotification.mockResolvedValue({ bellWritten: true });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.??', [schema, table]);
    expect(logger.warn.mock.calls).toEqual([]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
    Object.assign(gates, savedGates);
  });

  const sid = () => `CA${randomUUID().replaceAll('-', '')}`;
  function call(minsAgo, extra = {}) {
    return {
      id: randomUUID(), twilio_call_sid: sid(),
      direction: 'inbound', from_phone: '+19415550100', customer_id: null,
      status: 'no-answer', answered_by: 'missed', duration_seconds: 40, metadata: {},
      created_at: new Date(now - minsAgo * 60000), updated_at: new Date(now - minsAgo * 60000),
      ...extra,
    };
  }
  const meta = async (id) => (await database('call_log').where({ id }).first()).metadata;
  // A customer who reached voicemail and left an empty recording.
  const emptyVm = (minsAgo, extra = {}) => call(minsAgo, {
    customer_id: randomUUID(), status: 'completed', answered_by: 'voicemail', recording_sid: `RE${randomUUID().replaceAll('-', '')}`,
    transcription_status: 'rejected', transcription: '', ...extra,
  });
  // A completed call the status-callback fallback wrote: no answered_by, no recording.
  const noOutcome = (minsAgo, extra = {}) => call(minsAgo, { customer_id: randomUUID(), status: 'completed', answered_by: null, ...extra });

  describe('A: a customer\'s empty voicemail', () => {
    test('off: no bell, and the sweep stamps the shadow once; unknown callers and real voicemails are not stamped', async () => {
      setGates(['missedCallUnknownCallers']);
      const row = emptyVm(10);
      const real = emptyVm(10, { from_phone: '+19415550102', transcription_status: 'completed', transcription: 'Hi, please call me about my lawn.' });
      const unknown = emptyVm(10, { customer_id: null, from_phone: '+19415550103' });
      await database('call_log').insert([row, real, unknown]);
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(false);
      expect(await sweepMissedCalls()).toBe(0);
      expect(await sweepMissedCalls()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();
      expect((await meta(row.id)).missed_call_gap_shadow).toBe('empty_vm_customer');
      expect((await meta(real.id)).missed_call_gap_shadow).toBeUndefined();
      expect((await meta(unknown.id)).missed_call_gap_shadow).toBeUndefined();
    });

    test('on: the customer rings once from the post-call hook and settles; the sweep does not ring it again', async () => {
      setGates(['missedCallEmptyVmCustomer']);
      const row = emptyVm(10);
      await database('call_log').insert(row);
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
      expect(triggerNotification.mock.calls[0][1]).toMatchObject({ callLogId: row.id, customerId: row.customer_id });
      expect((await meta(row.id)).missed_call_settled_at).toBeTruthy();
      expect((await meta(row.id)).missed_call_gap_shadow).toBeUndefined();
      expect(await sweepMissedCalls()).toBe(0);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('on: the sweep finds it, including a markers-only transcript', async () => {
      setGates(['missedCallEmptyVmCustomer']);
      const rejected = emptyVm(10);
      const markers = emptyVm(10, { from_phone: '+19415550104', transcription_status: 'completed', transcription: '[NO SPEECH]' });
      await database('call_log').insert([rejected, markers]);
      expect(await sweepMissedCalls()).toBe(2);
      expect(triggerNotification.mock.calls.map((c) => c[1].callLogId).sort()).toEqual([rejected.id, markers.id].sort());
    });

    test('on: a real message, a transcript still pending, an alerted voicemail and an unknown caller stay quiet', async () => {
      setGates(['missedCallEmptyVmCustomer', 'missedCallUnknownCallers']);
      const rows = [
        emptyVm(10, { transcription_status: 'completed', transcription: 'Please call me back about the wasps.' }),
        emptyVm(10, { from_phone: '+19415550105', transcription_status: 'pending', transcription: null }),
        emptyVm(10, { from_phone: '+19415550106', voicemail_callback_alerted_at: new Date(now) }),
        emptyVm(10, { from_phone: '+19415550107', customer_id: null }),
      ];
      await database('call_log').insert(rows);
      expect(await sweepMissedCalls()).toBe(0);
      for (const r of rows) expect(await ringMissedCallIfUnanswered(r.twilio_call_sid)).toBe(false);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('on: a recording replaced while the bell is delivered loses the push', async () => {
      setGates(['missedCallEmptyVmCustomer']);
      const row = emptyVm(10);
      await database('call_log').insert(row);
      const verdicts = {};
      triggerNotification.mockImplementationOnce(async (_key, _payload, opts) => {
        verdicts.before = await opts.beforePush({ dispatching: false });
        await database('call_log').where({ id: row.id }).update({ recording_sid: 'REreplacedrecording' });
        verdicts.after = await opts.beforePush({ dispatching: true });
        return { bellWritten: true };
      });
      await ringMissedCallIfUnanswered(row.twilio_call_sid);
      expect(verdicts).toEqual({ before: true, after: false });
    });

    test('on: a customer with an ordinary missed call and an unknown 15 s caller still behave as before', async () => {
      setGates(['missedCallEmptyVmCustomer', 'missedCallUnknownCallers']);
      const customer = call(10, { customer_id: randomUUID(), from_phone: '+19415550108' });
      const unknown = call(10, { from_phone: '+19415550109', duration_seconds: 15 });
      const quick = call(10, { from_phone: '+19415550110', duration_seconds: 14 });
      await database('call_log').insert([customer, unknown, quick]);
      expect(await sweepMissedCalls()).toBe(2);
      expect(triggerNotification.mock.calls.map((c) => c[1].callLogId).sort()).toEqual([customer.id, unknown.id].sort());
    });
  });

  describe('B: a customer call that ended with no outcome', () => {
    test('off: no bell; the sweep stamps the shadow once, and only for a customer', async () => {
      setGates(['missedCallUnknownCallers']);
      const row = noOutcome(10);
      const unknown = noOutcome(10, { customer_id: null, from_phone: '+19415550111', duration_seconds: 30 });
      await database('call_log').insert([row, unknown]);
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(false);
      expect(await sweepMissedCalls()).toBe(0);
      expect(triggerNotification).not.toHaveBeenCalled();
      expect((await meta(row.id)).missed_call_gap_shadow).toBe('no_outcome_customer');
      expect((await meta(unknown.id)).missed_call_gap_shadow).toBeUndefined();
    });

    test('on: the customer rings; the sweep finds it too', async () => {
      setGates(['missedCallNoOutcomeCustomer']);
      const viaHook = noOutcome(10);
      const viaSweep = noOutcome(10, { from_phone: '+19415550112' });
      await database('call_log').insert([viaHook, viaSweep]);
      expect(await ringMissedCallIfUnanswered(viaHook.twilio_call_sid)).toBe(true);
      expect(await sweepMissedCalls()).toBe(1);
      expect(triggerNotification.mock.calls.map((c) => c[1].callLogId).sort()).toEqual([viaHook.id, viaSweep.id].sort());
    });

    test('on: Sandy-handled, answered, recorded, unknown-caller and call-back-answered calls stay quiet', async () => {
      setGates(['missedCallNoOutcomeCustomer', 'missedCallUnknownCallers']);
      const customer = randomUUID();
      const backed = noOutcome(20, { customer_id: customer, from_phone: '+19415550117' });
      const rows = [
        noOutcome(10, { from_phone: '+19415550113', call_outcome: 'ai_handled' }),
        noOutcome(10, { from_phone: '+19415550114', call_outcome: 'ai_transferred' }),
        noOutcome(10, { from_phone: '+19415550115', answered_by: 'human' }),
        noOutcome(10, { from_phone: '+19415550116', recording_sid: `RE${randomUUID().replaceAll('-', '')}`, transcription_status: 'completed', transcription: 'A real message.' }),
        noOutcome(10, { from_phone: '+19415550118', customer_id: null, duration_seconds: 60 }),
        backed,
      ];
      await database('call_log').insert([...rows, call(2, { customer_id: customer, from_phone: '+19415550117', status: 'completed', answered_by: 'human' })]);
      expect(await sweepMissedCalls()).toBe(0);
      for (const r of rows) expect(await ringMissedCallIfUnanswered(r.twilio_call_sid)).toBe(false);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('on: a no-answer customer call and an unknown 15 s caller ring exactly as before', async () => {
      setGates(['missedCallNoOutcomeCustomer', 'missedCallUnknownCallers']);
      const customer = call(10, { customer_id: randomUUID(), from_phone: '+19415550119' });
      const unknown = call(10, { from_phone: '+19415550120', status: 'completed', answered_by: 'voicemail', duration_seconds: 20 });
      await database('call_log').insert([customer, unknown]);
      expect(await sweepMissedCalls()).toBe(2);
    });
  });

  describe('C: a callback counts only when the customer answered', () => {
    const CALLER = '+19415550100';
    // The callback is dialed 8 minutes ago; bridgedMin says when the staff leg pressed 1.
    const outbound = (extra = {}, bridgedMin = 7) => call(8, {
      direction: 'outbound', from_phone: '+19415559999', to_phone: CALLER, status: 'completed', answered_by: null,
      duration_seconds: 40, bridged_at: bridgedMin == null ? null : new Date(now - bridgedMin * 60000), ...extra,
    });
    const legs = [
      ['a rang-out callback with no customer leg and no recording', () => outbound(), 'quiet', 'rings'],
      ['a callback whose customer leg completed with seconds', () => outbound({ metadata: { customer_leg: { status: 'completed', duration_seconds: 25 } } }), 'quiet', 'quiet'],
      ['a callback whose customer leg completed with zero seconds', () => outbound({ metadata: { customer_leg: { status: 'completed', duration_seconds: 0 } } }), 'quiet', 'rings'],
      ['a callback whose customer leg rang out', () => outbound({ metadata: { customer_leg: { status: 'no-answer', duration_seconds: 0 } } }), 'quiet', 'rings'],
      ['a callback with no customer leg and a recording', () => outbound({ recording_sid: 'REcallbackrecording1', recording_duration_seconds: 20 }), 'quiet', 'quiet'],
      ['a callback with a zero-second recording', () => outbound({ recording_sid: 'REcallbackrecording2', recording_duration_seconds: 0 }), 'quiet', 'rings'],
      ['a bridged callback still in flight', () => outbound({ status: 'bridged', duration_seconds: 0 }, 2), 'quiet', 'quiet'],
      ['a bridged callback stuck for 30 minutes', () => outbound({ status: 'bridged', duration_seconds: 0 }, 30), 'quiet', 'rings'],
      ['a callback that was never bridged', () => outbound({}, null), 'rings', 'rings'],
    ];
    for (const [label, build, off, on] of legs) {
      for (const [state, expected] of [['off', off], ['on', on]]) {
        test(`${state}: ${label} -> ${expected}`, async () => {
          setGates(state === 'on' ? ['callbackNeedsAnswer'] : []);
          const missed = call(40, { customer_id: randomUUID() });
          await database('call_log').insert([missed, build()]);
          expect(await sweepMissedCalls()).toBe(expected === 'rings' ? 1 : 0);
          expect(triggerNotification).toHaveBeenCalledTimes(expected === 'rings' ? 1 : 0);
        });
      }
    }

    test('an answered inbound redial still counts with the gate on', async () => {
      setGates(['callbackNeedsAnswer']);
      const customer = randomUUID();
      await database('call_log').insert([call(30, { customer_id: customer }), call(2, { customer_id: customer, status: 'completed', answered_by: 'human' })]);
      expect(await sweepMissedCalls()).toBe(0);
    });

    test('gate off: the SQL is the original, byte for byte; on: it adds the answer proof and no question mark', () => {
      const original = 'NOT EXISTS (SELECT 1 FROM call_log later'
        + ' WHERE later.id <> call_log.id AND later.created_at >= call_log.created_at'
        + " AND COALESCE(later.source, '') <> 'voice_relay_sandbox'"
        + ` AND ((later.direction = 'outbound' AND later.bridged_at IS NOT NULL AND ${phoneKeySql('later.to_phone')} = ${phoneKeySql('call_log.from_phone')})`
        + ` OR (later.direction = 'inbound' AND ${phoneKeySql('later.from_phone')} = ${phoneKeySql('call_log.from_phone')}`
        + " AND (later.answered_by IN ('human', 'ai_agent') OR later.call_outcome IN ('ai_handled', 'ai_transferred')"
        + ' OR later.voicemail_callback_alerted_at IS NOT NULL))))';
      setGates([]);
      expect(calledBackSql()).toBe(original);
      expect(CALLED_BACK_SQL).toBe(original);
      setGates(['callbackNeedsAnswer']);
      expect(calledBackSql()).not.toBe(original);
      expect(calledBackSql()).toContain('customer_leg');
      expect(calledBackSql()).not.toContain('?');
    });

    test('retire: a rang-out callback keeps the bell open with the gate on, an answered one retires it', async () => {
      const customer = randomUUID();
      const missed = call(30, { customer_id: customer });
      const bell = { id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'Missed call',
        metadata: { triggerKey: 'customer_missed_call', payload: { callLogId: missed.id } }, created_at: new Date(now - 5 * 60000) };
      await database('call_log').insert([missed, outbound()]);
      await database('notifications').insert(bell);
      setGates(['callbackNeedsAnswer']);
      expect(await retireCalledBackMissedCalls()).toBe(0);
      await database('call_log').where({ direction: 'outbound' }).update({ metadata: { customer_leg: { status: 'completed', duration_seconds: 90 } } });
      expect(await retireCalledBackMissedCalls()).toBe(1);
    });

    test('retire: gate off keeps the old rule (a bridged callback retires the bell)', async () => {
      const missed = call(30, { customer_id: randomUUID() });
      const bell = { id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'Missed call',
        metadata: { triggerKey: 'customer_missed_call', payload: { callLogId: missed.id } }, created_at: new Date(now - 5 * 60000) };
      await database('call_log').insert([missed, outbound()]);
      await database('notifications').insert(bell);
      expect(await retireCalledBackMissedCalls()).toBe(1);
    });
  });

  describe('D: a missed-call push that reached no phone', () => {
    const deadPush = { bellWritten: true, push: { subscriptions: 2, sent: 0, expired: 0, failed: 2, skipped: 0, results: [] } };
    const okPush = { bellWritten: true, push: { subscriptions: 2, sent: 2, expired: 0, failed: 0, skipped: 0, results: [] } };

    test('on: pass 1 holds the call and counts one retry; pass 2 sends push only, settles, and raises the alert once with an ET-day key', async () => {
      setGates(['missedCallPushCheck']);
      const row = call(10, { customer_id: randomUUID() });
      await database('call_log').insert(row);
      triggerNotification.mockResolvedValue(deadPush);
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      let m = await meta(row.id);
      expect(m.missed_call_settled_at).toBeUndefined();
      expect(m.missed_call_notified_at).toBeUndefined();
      expect(m.missed_call_push_retries).toBe(1);
      expect(triggerNotification.mock.calls[0][2].pushOnly).toBeUndefined();
      expect(raiseAdminAlert).not.toHaveBeenCalled();

      expect(await sweepMissedCalls()).toBe(1);
      expect(triggerNotification).toHaveBeenCalledTimes(2);
      expect(triggerNotification.mock.calls[1][2].pushOnly).toBe(true);
      m = await meta(row.id);
      expect(m.missed_call_settled_at).toBeTruthy();
      expect(raiseAdminAlert).toHaveBeenCalledTimes(1);
      const [category, spec, opts] = raiseAdminAlert.mock.calls[0];
      expect(category).toBe('alert');
      expect(opts.dedupeKey).toBe(`missed-call-push-no-phone:${etDateString()}`);
      expect(() => composeAdminAlert(spec)).not.toThrow();
      expect(composeAdminAlert(spec).headline).toBe('System — Missed-call push reached no phone');
      expect(await sweepMissedCalls()).toBe(0);
      expect(triggerNotification).toHaveBeenCalledTimes(2);
    });

    test('on: a second dead call the same day raises with the same key, so the bell dedupes to one per ET day', async () => {
      setGates(['missedCallPushCheck']);
      const rows = [call(10, { customer_id: randomUUID() }), call(10, { customer_id: randomUUID(), from_phone: '+19415550121' })];
      await database('call_log').insert(rows);
      triggerNotification.mockResolvedValue(deadPush);
      await sweepMissedCalls();
      await sweepMissedCalls();
      expect(raiseAdminAlert).toHaveBeenCalledTimes(2);
      expect(new Set(raiseAdminAlert.mock.calls.map((c) => c[2].dedupeKey)).size).toBe(1);
    });

    test('on: the retry that reaches a phone settles with no alert', async () => {
      setGates(['missedCallPushCheck']);
      const row = call(10, { customer_id: randomUUID() });
      await database('call_log').insert(row);
      triggerNotification.mockResolvedValueOnce(deadPush).mockResolvedValueOnce({ bellWritten: false, push: okPush.push });
      await ringMissedCallIfUnanswered(row.twilio_call_sid);
      await sweepMissedCalls();
      expect((await meta(row.id)).missed_call_settled_at).toBeTruthy();
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('on: no subscription, a skipped push, a good push and a suppressed bell settle at once with no retry', async () => {
      setGates(['missedCallPushCheck']);
      const cases = [
        { bellWritten: true, push: { subscriptions: 0, sent: 0, expired: 0, failed: 0, skipped: 0, results: [] } },
        { bellWritten: true, push: { subscriptions: 1, sent: 0, expired: 0, failed: 0, skipped: 1, results: [] } },
        { bellWritten: true, push: { sent: 0, skipped: 'superseded_before_push' } },
        okPush,
      ];
      for (const stats of cases) {
        const row = call(10, { customer_id: randomUUID() });
        await database('call_log').insert(row);
        triggerNotification.mockResolvedValueOnce(stats);
        await ringMissedCallIfUnanswered(row.twilio_call_sid);
        const m = await meta(row.id);
        expect(m.missed_call_settled_at).toBeTruthy();
        expect(m.missed_call_push_retries).toBeUndefined();
      }
      expect(raiseAdminAlert).not.toHaveBeenCalled();
    });

    test('off: a dead push settles at once, with no counter and no alert', async () => {
      const row = call(10, { customer_id: randomUUID() });
      await database('call_log').insert(row);
      triggerNotification.mockResolvedValue(deadPush);
      expect(await ringMissedCallIfUnanswered(row.twilio_call_sid)).toBe(true);
      const m = await meta(row.id);
      expect(m.missed_call_settled_at).toBeTruthy();
      expect(m.missed_call_push_retries).toBeUndefined();
      expect(raiseAdminAlert).not.toHaveBeenCalled();
      expect(await sweepMissedCalls()).toBe(0);
    });

    test('a gate turned off between the passes still retries push only: never a second bell', async () => {
      const row = call(10, { customer_id: randomUUID(), metadata: { missed_call_push_retries: 1 } });
      await database('call_log').insert(row);
      triggerNotification.mockResolvedValue({ bellWritten: false, push: okPush.push });
      expect(await sweepMissedCalls()).toBe(1);
      expect(triggerNotification.mock.calls[0][2].pushOnly).toBe(true);
      expect((await meta(row.id)).missed_call_settled_at).toBeTruthy();
    });

    test('the retry still stops when the caller got through meanwhile', async () => {
      setGates(['missedCallPushCheck']);
      const customer = randomUUID();
      const row = call(10, { customer_id: customer });
      await database('call_log').insert(row);
      triggerNotification.mockResolvedValueOnce(deadPush);
      await ringMissedCallIfUnanswered(row.twilio_call_sid);
      await database('call_log').insert(call(1, { customer_id: customer, status: 'completed', answered_by: 'human' }));
      expect(await sweepMissedCalls()).toBe(0);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });
  });

  test('all four gates on: a plain missed customer call rings once and settles', async () => {
    setGates(gateNames);
    const row = call(10, { customer_id: randomUUID() });
    await database('call_log').insert(row);
    expect(await sweepMissedCalls()).toBe(1);
    expect(await sweepMissedCalls()).toBe(0);
    expect(triggerNotification).toHaveBeenCalledTimes(1);
    expect((await meta(row.id)).missed_call_settled_at).toBeTruthy();
  });
});
