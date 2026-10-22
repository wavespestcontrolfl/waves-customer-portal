// GATE_MISSED_CALL_VISIT_UNDERWAY (owner 2026-10-21) on PostgreSQL: a customer on file
// called, nobody answered, then the customer's visit moved (en route, arrived or
// completed) or an invoice was paid, after the call on the same ET day. The
// missed-call bell is retired, never rings, and is never re-pushed.
// Admin bell and admin push only; delivery is mocked and nothing can reach a customer.
// CI's DATABASE_URL pass runs this; fixture rows live in a unique schema that is
// removed after the suite. Synthetic data only.
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
jest.mock('../services/notification-triggers', () => ({
  ...jest.requireActual('../services/notification-triggers'),
  triggerNotification: jest.fn(),
}));
jest.mock('../services/notification-bell-policy', () => ({
  isBellPolicyEnabled: jest.fn(() => false),
  bellAllowed: jest.fn(async () => true),
}));
jest.mock('../services/push-notifications', () => ({
  sendToAdminUsers: jest.fn(async (ids, build, opts = {}) => {
    if (opts.beforeDispatch && (await opts.beforeDispatch()) === false) return { sent: 0, superseded: true };
    ids.forEach((id) => build(id));
    return { sent: ids.length, subscriptions: ids.length };
  }),
}));

const { triggerNotification } = require('../services/notification-triggers');
const PushService = require('../services/push-notifications');
const { gates } = require('../config/feature-gates');
const missedCallBell = require('../services/missed-call-bell');
const { sweepMissedCallRepush } = require('../services/missed-call-repush');

const { ringMissedCallIfUnanswered, retireCalledBackMissedCalls, visitUnderwaySql } = missedCallBell;

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('missed-call bell, visit underway, on PostgreSQL', () => {
  let database;
  const schema = `call_visit_${randomUUID().replaceAll('-', '')}`;
  const tables = [
    'call_log', 'scheduled_services', 'invoices', 'customers', 'notifications', 'blocked_numbers',
    'blocked_call_attempts', 'notification_preferences', 'technicians', 'schedule_blackout_dates', 'system_settings',
  ];
  const gateNames = ['missedCallVisitUnderway', 'missedCallRepush', 'callbackNeedsAnswer', 'missedCallUnknownCallers'];
  const savedGates = Object.fromEntries(gateNames.map((key) => [key, gates[key]]));
  const setGates = (on) => gateNames.forEach((key) => { gates[key] = on.includes(key); });

  // Tue 2026-10-20: the call came in at 1:05 PM ET (17:05Z, EDT).
  const CALL_AT = new Date('2026-10-20T17:05:00Z');
  const at = (hhmmEt, day = '2026-10-20') => new Date(`${day}T${hhmmEt}:00-04:00`);
  // Repush clock: Tue 2026-10-20 3:00 PM ET, inside Mon-Sat 8:00-18:00.
  const REPUSH_NOW = new Date('2026-10-20T19:00:00Z');
  const HOURS = { startMin: 8 * 60, endMin: 18 * 60 };
  const RETIRE_REASON = "The customer's visit went ahead after the call";
  let customerId;
  let adminId;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    mockConn = database;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    setGates(['missedCallVisitUnderway']);
    triggerNotification.mockResolvedValue({ bellWritten: true });
    customerId = randomUUID();
    adminId = randomUUID();
    await database('customers').insert({ id: customerId, first_name: 'Pat', last_name: 'Synthetic', phone: '+19415550100' });
    await database('technicians').insert({ id: adminId, name: 'Synthetic Admin', active: true, role: 'admin', created_at: CALL_AT, updated_at: CALL_AT });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
    Object.assign(gates, savedGates);
  });

  const sid = () => `CA${randomUUID().replaceAll('-', '')}`;
  async function missedCall(extra = {}) {
    const row = {
      id: randomUUID(), twilio_call_sid: sid(), direction: 'inbound', from_phone: '+19415550100', to_phone: '+19412975749',
      customer_id: customerId, status: 'no-answer', answered_by: 'missed', duration_seconds: 0, metadata: {},
      created_at: CALL_AT, updated_at: CALL_AT, ...extra,
    };
    await database('call_log').insert(row);
    return row;
  }
  // The bell the call rang. created_at is wall-clock: the retire pass looks back 7 days from now.
  async function bell(call, { createdAt = new Date(), extra = {} } = {}) {
    const row = {
      id: randomUUID(), recipient_type: 'admin', category: 'missed_call', title: 'Missed call - Pat Synthetic',
      body: '(941) 555-0100 called and did not leave a voicemail.', link: `/admin/communications#tab=calls&call=${call.id}`,
      metadata: { triggerKey: 'customer_missed_call', payload: { callLogId: call.id, phone: '(941) 555-0100' } },
      created_at: createdAt, ...extra,
    };
    await database('notifications').insert(row);
    return row;
  }
  const stored = (row) => database('notifications').where({ id: row.id }).first();
  const visit = (cols, cid = customerId) => database('scheduled_services').insert({ id: randomUUID(), customer_id: cid, ...cols });
  const invoice = (cols, cid = customerId) => database('invoices').insert({ id: randomUUID(), customer_id: cid, ...cols });

  describe('retire sweep, gate on', () => {
    test.each([
      ['en route', { en_route_at: at('13:46') }],
      ['arrived', { arrived_at: at('13:59') }],
      ['completed', { completed_at: at('14:20') }],
    ])('a visit that went %s after the call retires the bell with its own reason', async (_label, cols) => {
      const call = await missedCall();
      const row = await bell(call);
      await visit(cols);
      expect(await retireCalledBackMissedCalls()).toBe(1);
      const after = await stored(row);
      expect(after.done_at).not.toBeNull();
      expect(JSON.stringify(after)).toContain(RETIRE_REASON);
    });

    test('an invoice paid after the call retires the bell', async () => {
      const call = await missedCall();
      const row = await bell(call);
      await invoice({ status: 'paid', paid_at: at('14:32') });
      expect(await retireCalledBackMissedCalls()).toBe(1);
      expect((await stored(row)).done_at).not.toBeNull();
    });

    test('the owner case: called 1:05, en route 1:46, arrived 1:59, paid 2:32', async () => {
      const call = await missedCall();
      const row = await bell(call);
      await visit({ en_route_at: at('13:46'), arrived_at: at('13:59'), completed_at: at('14:25') });
      await invoice({ status: 'paid', paid_at: at('14:32') });
      expect(await retireCalledBackMissedCalls()).toBe(1);
      expect((await stored(row)).done_at).not.toBeNull();
    });

    test('a visit that moved BEFORE the call does not retire the bell', async () => {
      const call = await missedCall();
      const row = await bell(call);
      await visit({ en_route_at: at('12:10'), arrived_at: at('12:30'), completed_at: at('13:00') });
      await invoice({ status: 'paid', paid_at: at('12:45') });
      expect(await retireCalledBackMissedCalls()).toBe(0);
      expect((await stored(row)).done_at).toBeNull();
    });

    test('a visit on another ET day does not retire the bell', async () => {
      const call = await missedCall();
      const row = await bell(call);
      await visit({ en_route_at: at('09:00', '2026-10-21'), completed_at: at('10:00', '2026-10-21') });
      await invoice({ status: 'paid', paid_at: at('11:00', '2026-10-21') });
      expect(await retireCalledBackMissedCalls()).toBe(0);
      expect((await stored(row)).done_at).toBeNull();
    });

    test('the ET day, not the UTC day, decides: 9 PM ET call and a 1 AM ET visit stay apart', async () => {
      // 21:00 ET Tue is 01:00Z Wed; 01:00 ET Wed is 05:00Z Wed. Same UTC day, different ET days.
      const call = await missedCall({ created_at: at('21:00'), updated_at: at('21:00') });
      const row = await bell(call);
      await visit({ en_route_at: at('01:00', '2026-10-21') });
      expect(await retireCalledBackMissedCalls()).toBe(0);
      expect((await stored(row)).done_at).toBeNull();
    });

    test('another customer\'s visit does not retire the bell', async () => {
      const call = await missedCall();
      const row = await bell(call);
      await visit({ en_route_at: at('13:46') }, randomUUID());
      await invoice({ status: 'paid', paid_at: at('14:32') }, randomUUID());
      expect(await retireCalledBackMissedCalls()).toBe(0);
      expect((await stored(row)).done_at).toBeNull();
    });

    test('an unpaid invoice does not retire the bell', async () => {
      const call = await missedCall();
      const row = await bell(call);
      await invoice({ status: 'sent', paid_at: null });
      expect(await retireCalledBackMissedCalls()).toBe(0);
      expect((await stored(row)).done_at).toBeNull();
    });

    test('an unknown caller (no customer on the call) is unaffected', async () => {
      const call = await missedCall({ customer_id: null, duration_seconds: 30 });
      const row = await bell(call);
      await visit({ en_route_at: at('13:46') });
      await invoice({ status: 'paid', paid_at: at('14:32') });
      expect(await retireCalledBackMissedCalls()).toBe(0);
      expect((await stored(row)).done_at).toBeNull();
    });

    test('the called-back reason is unchanged when a later call got through', async () => {
      const call = await missedCall();
      const row = await bell(call);
      await missedCall({ status: 'completed', answered_by: 'human', duration_seconds: 90, created_at: at('13:30'), updated_at: at('13:30') });
      expect(await retireCalledBackMissedCalls()).toBe(1);
      expect(JSON.stringify(await stored(row))).toContain('The caller got through on a later call');
    });
  });

  describe('a bell that has not rung yet, gate on', () => {
    test.each([
      ['en route', { en_route_at: at('13:46') }],
      ['arrived', { arrived_at: at('13:59') }],
      ['completed', { completed_at: at('14:20') }],
    ])('does not ring when the visit already went %s', async (_label, cols) => {
      const call = await missedCall();
      await visit(cols);
      expect(await ringMissedCallIfUnanswered(call.twilio_call_sid)).toBe(false);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('does not ring when an invoice was paid after the call', async () => {
      const call = await missedCall();
      await invoice({ status: 'paid', paid_at: at('14:32') });
      expect(await ringMissedCallIfUnanswered(call.twilio_call_sid)).toBe(false);
      expect(triggerNotification).not.toHaveBeenCalled();
    });

    test('still rings when the visit moved before the call', async () => {
      const call = await missedCall();
      await visit({ en_route_at: at('12:10'), completed_at: at('12:50') });
      expect(await ringMissedCallIfUnanswered(call.twilio_call_sid)).toBe(true);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('still rings when the only visit is another day', async () => {
      const call = await missedCall();
      await visit({ en_route_at: at('09:00', '2026-10-21') });
      expect(await ringMissedCallIfUnanswered(call.twilio_call_sid)).toBe(true);
    });

    // The bell write lands, then the visit moves before the post-delivery check.
    function bellThenVisitMoves(call, cols) {
      triggerNotification.mockImplementation(async () => {
        await bell(call);
        await visit(cols);
        return { bellWritten: true };
      });
    }

    test('a visit that moves after the bell is written closes it with the visit wording', async () => {
      const call = await missedCall();
      bellThenVisitMoves(call, { en_route_at: at('13:46') });
      expect(await ringMissedCallIfUnanswered(call.twilio_call_sid)).toBe(true);
      const after = await database('notifications').where({ category: 'missed_call' }).first();
      expect(after.done_at).not.toBeNull();
      expect(JSON.stringify(after)).toContain(RETIRE_REASON);
    });

    test('a voicemail that also landed keeps the default wording at the post-check', async () => {
      const call = await missedCall();
      triggerNotification.mockImplementation(async () => {
        await bell(call);
        await visit({ en_route_at: at('13:46') });
        await database('call_log').where({ id: call.id }).update({ recording_sid: 'RE_synthetic', recording_duration_seconds: 20 });
        return { bellWritten: true };
      });
      expect(await ringMissedCallIfUnanswered(call.twilio_call_sid)).toBe(true);
      const after = await database('notifications').where({ category: 'missed_call' }).first();
      expect(after.done_at).not.toBeNull();
      expect(JSON.stringify(after)).not.toContain(RETIRE_REASON);
    });

    test('gate off: a visit that moves after the bell is written leaves it open', async () => {
      setGates([]);
      const call = await missedCall();
      bellThenVisitMoves(call, { en_route_at: at('13:46') });
      expect(await ringMissedCallIfUnanswered(call.twilio_call_sid)).toBe(true);
      const after = await database('notifications').where({ category: 'missed_call' }).first();
      expect(after.done_at).toBeNull();
    });

    test('an unknown caller rings as before', async () => {
      gates.missedCallUnknownCallers = true;
      const call = await missedCall({ customer_id: null, duration_seconds: 30 });
      await visit({ en_route_at: at('13:46') });
      expect(await ringMissedCallIfUnanswered(call.twilio_call_sid)).toBe(true);
    });
  });

  describe('re-push, gate on', () => {
    const run = (opts = {}) => sweepMissedCallRepush({ hours: HOURS, clock: () => REPUSH_NOW, now: REPUSH_NOW, ...opts });
    // A bell that rang 45 minutes before the clock, for a call at 1:05 PM ET.
    const repushBell = (call) => bell(call, { createdAt: new Date(REPUSH_NOW.getTime() - 45 * 60 * 1000) });

    beforeEach(() => {
      gates.missedCallRepush = true;
      // The retire pass has its own tests above; here the re-push check stands alone.
      jest.spyOn(missedCallBell, 'retireCalledBackMissedCalls').mockResolvedValue(0);
    });

    test('a bell whose visit moved after the call is not re-pushed', async () => {
      const call = await missedCall();
      const row = await repushBell(call);
      await visit({ en_route_at: at('13:46') });
      expect(await run()).toBe(0);
      expect(PushService.sendToAdminUsers).toHaveBeenCalledTimes(1); // reached the claim, which refused
      expect((await stored(row)).metadata.repushed_at).toBeUndefined();
    });

    test('a paid invoice after the call stops the re-push', async () => {
      const call = await missedCall();
      const row = await repushBell(call);
      await invoice({ status: 'paid', paid_at: at('14:32') });
      expect(await run()).toBe(0);
      expect((await stored(row)).metadata.repushed_at).toBeUndefined();
    });

    test('a bell with no visit underway is re-pushed', async () => {
      const call = await missedCall();
      const row = await repushBell(call);
      await visit({ en_route_at: at('12:10') });
      expect(await run()).toBe(1);
      expect((await stored(row)).metadata.repushed_at).toBeDefined();
    });
  });

  describe('gate off', () => {
    beforeEach(() => setGates([]));

    test('visitUnderwaySql is null, so no clause is added anywhere', () => {
      expect(visitUnderwaySql()).toBeNull();
    });

    test('the retire sweep leaves a bell whose visit moved alone', async () => {
      const call = await missedCall();
      const row = await bell(call);
      await visit({ en_route_at: at('13:46'), arrived_at: at('13:59'), completed_at: at('14:20') });
      await invoice({ status: 'paid', paid_at: at('14:32') });
      expect(await retireCalledBackMissedCalls()).toBe(0);
      expect((await stored(row)).done_at).toBeNull();
    });

    test('the bell rings as before', async () => {
      const call = await missedCall();
      await visit({ en_route_at: at('13:46') });
      expect(await ringMissedCallIfUnanswered(call.twilio_call_sid)).toBe(true);
      expect(triggerNotification).toHaveBeenCalledTimes(1);
    });

    test('the re-push still goes', async () => {
      gates.missedCallRepush = true;
      jest.spyOn(missedCallBell, 'retireCalledBackMissedCalls').mockResolvedValue(0);
      const call = await missedCall();
      await bell(call, { createdAt: new Date(REPUSH_NOW.getTime() - 45 * 60 * 1000) });
      await visit({ en_route_at: at('13:46') });
      expect(await sweepMissedCallRepush({ hours: HOURS, clock: () => REPUSH_NOW, now: REPUSH_NOW })).toBe(1);
    });
  });
});
