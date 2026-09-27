// CI's existing DB-gated pass runs this against PostgreSQL. All fixture data
// lives in a unique schema that is removed after the suite; delivery
// (sendCustomerMessage / renderSmsTemplate) is mocked — this suite pins the
// claim/lease/one-per-number-ever DB behavior, not the SMS pipeline itself.
// The sendCustomerMessage stand-in (`pipeline`) runs the lane's
// providerPreSendCheck exactly where Twilio's final dispatch would, so the
// provider-boundary recheck and claim run for real against this schema.
//
// The module reads Date.now() directly (never bare `new Date()`) for every
// time-sensitive decision, so `jest.spyOn(Date, 'now')` pins "now" to a
// fixed, known-in-hours ET instant without touching real timers — safe
// alongside a real Postgres connection (no fake setTimeout to hang a pool
// acquisition on).
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
jest.mock('../config/twilio-numbers', () => ({
  // A staff forward / CSR cell for the internal-caller test.
  isInternalNumber: (n) => n === '+19415550999',
  isTechLine: (n) => n === '+19413529161',
  tollFree: { number: '+18559260203' },
  findByNumber: jest.fn((n) => (n === '+19412975749' ? { id: 'main' } : null)),
  getOutboundNumber: () => '+19412975749',
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(),
}));
// Provider-side reconciliation of an orphaned claim (findOutboundMessageSince).
jest.mock('../services/twilio', () => ({
  findOutboundMessageSince: jest.fn(async () => ({ unavailable: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (key, vars) => `Hi there, it's Waves. Sorry we missed your call. Text us here with what you need, or call back anytime${vars.callback_clause}.`),
}));

const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const TwilioService = require('../services/twilio');
const {
  textBackIfMissed, sweepMissedCallTextBacks, CLAIM,
  _private: { reconcileOrphanedClaims },
} = require('../services/missed-call-text-back');

const PHONE = '+19415550100';
const REAL_SEND = { sent: true, providerMessageId: 'SM_real_sid', deliveryOutcome: 'accepted' };

// sendCustomerMessage stand-in: optional work in flight before the handoff
// (`before` — a staff text landing, the clock moving), then the lane's own
// providerPreSendCheck where Twilio runs it, then the provider `outcome`
// (a value, or a function that may throw).
function pipeline(outcome = REAL_SEND, { before } = {}) {
  return async (input) => {
    if (before) await before(input);
    const verdict = await input.providerPreSendCheck({ channel: 'sms' });
    if (!verdict || verdict.ok !== true) {
      return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: verdict?.code, retryable: verdict?.retryable === true };
    }
    return typeof outcome === 'function' ? outcome(input) : outcome;
  };
}

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('missed-call text-back on PostgreSQL', () => {
  let database;
  const schema = `missed_call_text_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'customers', 'sms_log', 'voicemail_sms_claims', 'blocked_numbers', 'blocked_call_attempts'];
  // 2026-09-08T15:00Z = 11:00 ET (EDT) — inside the 8am–8pm send window.
  const NOW = Date.parse('2026-09-08T15:00:00Z');
  let nowSpy;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    // CREATE TABLE ... AS SELECT copies columns only, never constraints —
    // the shared one-per-number-EVER claim needs its real primary key for
    // `ON CONFLICT (phone) DO NOTHING`.
    await database.raw('ALTER TABLE ??.?? ADD PRIMARY KEY (phone)', [schema, 'voicemail_sms_claims']);
    await database.raw('ALTER TABLE ??.?? ALTER COLUMN created_at SET DEFAULT now()', [schema, 'voicemail_sms_claims']);
    mockConn = database;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation(() => true);
    sendCustomerMessage.mockImplementation(pipeline());
    renderSmsTemplate.mockImplementation(async (key, vars) => `Hi there, it's Waves. Sorry we missed your call. Text us here with what you need, or call back anytime${vars.callback_clause}.`);
    TwilioService.findOutboundMessageSince.mockImplementation(async () => ({ unavailable: true }));
    nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW);
  });
  afterEach(async () => {
    nowSpy.mockRestore();
    for (const table of tables) await database.raw('TRUNCATE TABLE ??.?? CASCADE', [schema, table]);
  });
  afterAll(async () => {
    await database.raw('DROP SCHEMA ?? CASCADE', [schema]);
    await database.destroy();
  });

  // A missed call `minutesAgo` minutes before NOW — created_at and
  // updated_at (its terminal status update) both land there unless a test
  // overrides one specifically (e.g. the stale-lease test).
  function call(minutesAgo, extra = {}) {
    const at = new Date(NOW - minutesAgo * 60 * 1000);
    return {
      id: randomUUID(),
      twilio_call_sid: `CA${randomUUID().replaceAll('-', '')}`,
      direction: 'inbound',
      from_phone: PHONE,
      to_phone: '+19412975749',
      customer_id: null,
      status: 'no-answer',
      answered_by: 'missed',
      duration_seconds: 40,
      metadata: {},
      created_at: at,
      updated_at: at,
      ...extra,
    };
  }
  // Past the 5-minute voicemail-landing grace, comfortably in-hours, fresh
  // enough to be well inside the call's 30-minute send slot.
  const READY_MINUTES_AGO = 6;
  const claimRow = (phone = PHONE) => database('voicemail_sms_claims').where({ phone }).first();
  const stored = (row) => database('call_log').where({ id: row.id }).first();

  test('gate off is a no-op before any query', async () => {
    isEnabled.mockImplementation(() => false);
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'gate_off' });
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 0, offered: 0 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await stored(row)).metadata).toEqual({});
  });

  test('an eligible unknown caller inside the send window gets exactly one text, sent from the dialed line', async () => {
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const sendInput = sendCustomerMessage.mock.calls[0][0];
    expect(sendInput.to).toBe(PHONE);
    expect(sendInput.metadata.fromNumber).toBe('+19412975749');
    expect(sendInput.purpose).toBe('missed_call_followup');
    expect(typeof sendInput.providerPreSendCheck).toBe('function');
    expect(sendInput.body).not.toMatch(/reply stop/i);
    // The callback number is required at render (an edit/variant without it never sends).
    expect(renderSmsTemplate.mock.calls[0][3]).toEqual({ requiredVars: ['callback_clause'] });
    const after = await stored(row);
    expect(after.metadata.missed_call_text_settled_at).toBeTruthy();
    expect(after.metadata.missed_call_text_outcome).toBe('sent');
    // The shared one-shot row: this lane's (no lead), marked sent.
    expect(await claimRow()).toMatchObject({ lead_id: null, outcome: CLAIM.SENT });
  });

  test('one text per phone number EVER — a second missed call from the same number is skipped even on a fresh call_log row', async () => {
    const first = call(READY_MINUTES_AGO);
    await database('call_log').insert(first);
    expect(await textBackIfMissed(first.twilio_call_sid)).toEqual({ outcome: 'sent' });

    const second = call(READY_MINUTES_AGO);
    await database('call_log').insert(second);
    expect(await textBackIfMissed(second.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_sent_to_phone' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect((await stored(second)).metadata.missed_call_text_outcome).toBe('skipped:already_sent_to_phone');
  });

  test('the claim is shared with the voicemail lane: once this lane texts a number, the voicemail lane\'s own atomic claim loses', async () => {
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
    const voicemailLane = require('../services/voicemail-lead-sms');
    expect(await voicemailLane.sendVoicemailQuoteLink({ leadId: randomUUID(), phone: PHONE }))
      .toEqual({ sent: false, skipped: 'already_sent_to_phone' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('the voicemail lane\'s release and stamp never touch this lane\'s claim row', async () => {
    await database('voicemail_sms_claims').insert({ phone: PHONE, lead_id: null, outcome: CLAIM.SENT });
    const { _deferredClaims } = require('../services/voicemail-lead-sms');
    await _deferredClaims.releasePhoneClaim(PHONE);
    await _deferredClaims.stampPhoneClaim(PHONE, 'sent');
    expect(await claimRow()).toMatchObject({ lead_id: null, outcome: CLAIM.SENT });
  });

  test('a voicemail-lane claim still in flight (not sent yet) leaves this call waiting, and it is texted once that claim is released', async () => {
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    await database('voicemail_sms_claims').insert({ phone: PHONE, lead_id: randomUUID(), outcome: 'claimed' });
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'pending', reason: 'claim_in_flight' });
    const waiting = await stored(row);
    expect(waiting.metadata.missed_call_text_settled_at).toBeUndefined();
    expect(waiting.metadata.missed_call_text_leased_at).toBeUndefined();
    // The voicemail lane's send failed without consuming the one-shot.
    await require('../services/voicemail-lead-sms')._deferredClaims.releasePhoneClaim(PHONE);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
  });

  test('already texted by the voicemail-lead lane (its row in the shared claim table) is skipped', async () => {
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    await database('voicemail_sms_claims').insert({ phone: PHONE, lead_id: randomUUID(), outcome: 'sent' });
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'voicemail_lead_texted' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a KNOWN customer (customer_id set) is untouched — that call belongs to the bell, not this lane', async () => {
    const customerId = randomUUID();
    await database('customers').insert({ id: customerId, first_name: 'Test', phone: '+19415550199' });
    const row = call(READY_MINUTES_AGO, { customer_id: customerId });
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'not_missed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a phone matching a customer on file skips even when call_log.customer_id is null', async () => {
    await database('customers').insert({ id: randomUUID(), first_name: 'Test', phone: PHONE });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'existing_customer' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.missed_call_text_outcome).toBe('skipped:existing_customer');
  });

  test('a number a customer record knows through a secondary or service-contact phone is skipped', async () => {
    await database('customers').insert({ id: randomUUID(), first_name: 'Test', phone: '+19415550111', secondary_phone: '(941) 555-0100' });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'existing_customer' });

    await database('customers').del();
    await database('customers').insert({ id: randomUUID(), first_name: 'Test', phone: '+19415550122', service_contact_phone: '9415550101' });
    const second = call(READY_MINUTES_AGO, { from_phone: '+19415550101' });
    await database('call_log').insert(second);
    expect(await textBackIfMissed(second.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'existing_customer' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('two customer records sharing the number (so call_log never linked either) still count as known', async () => {
    await database('customers').insert([
      { id: randomUUID(), first_name: 'One', phone: PHONE },
      { id: randomUUID(), first_name: 'Two', phone: '941-555-0100' },
    ]);
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'existing_customer' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a staff forward / Waves-owned caller ID is never texted', async () => {
    const row = call(READY_MINUTES_AGO, { from_phone: '+19415550999' });
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'internal_number' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.missed_call_text_outcome).toBe('skipped:internal_number');
  });

  test('a dialed line we do not text from (tech line here) is skipped, not silently rerouted', async () => {
    const row = call(READY_MINUTES_AGO, { to_phone: '+19413529161' });
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'unsupported_line' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('still within the 5-minute voicemail-landing grace: neither sent nor settled yet', async () => {
    const row = call(1); // only 1 minute old
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'pending', reason: 'voicemail_grace' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.missed_call_text_settled_at).toBeUndefined();
  });

  test('outside 8am-8pm ET the call is deferred, not sent, and the durable sweep sends it once the window reopens', async () => {
    // 2026-09-09T02:00Z = 22:00 ET the prior evening.
    const outOfWindow = Date.parse('2026-09-09T02:00:00Z');
    nowSpy.mockReturnValue(outOfWindow);
    const row = call(0, { created_at: new Date(outOfWindow), updated_at: new Date(outOfWindow) });
    await database('call_log').insert(row);
    expect((await textBackIfMissed(row.twilio_call_sid)).outcome).toBe('deferred');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.missed_call_text_settled_at).toBeUndefined();

    nowSpy.mockReturnValue(Date.parse('2026-09-09T12:05:00Z')); // ~8:05am ET
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 1, offered: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect((await stored(row)).metadata.missed_call_text_outcome).toBe('sent');
  });

  test('too old for a first-time text (past the 14h belt) settles skipped without sending', async () => {
    const row = call(15 * 60); // 15 hours ago
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'too_old' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.missed_call_text_outcome).toBe('skipped:too_old');
  });

  test('a stale lease (crashed worker) is reclaimed by a later attempt', async () => {
    const staleToken = new Date(NOW - 11 * 60 * 1000).toISOString(); // > 10-minute lease
    const row = call(READY_MINUTES_AGO, { metadata: { missed_call_text_leased_at: staleToken } });
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('a live lease from another worker is not reclaimed', async () => {
    const liveToken = new Date(NOW - 1000).toISOString(); // well within the 10-minute lease
    const row = call(READY_MINUTES_AGO, { metadata: { missed_call_text_leased_at: liveToken } });
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'lease_lost' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('already contacted since the missed call (an outbound callback landed first) is skipped, not texted', async () => {
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    await database('call_log').insert(call(1, {
      direction: 'outbound', from_phone: '+19412975749', to_phone: PHONE,
      status: 'completed', answered_by: 'human',
    }));
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_contacted' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a later call from the same number that someone answered counts as contact', async () => {
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    await database('call_log').insert(call(2, { status: 'completed', answered_by: 'human' }));
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_contacted' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a later call from the same number that left a voicemail counts as contact (the voicemail lane owns them now)', async () => {
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    await database('call_log').insert(call(2, { answered_by: 'voicemail', recording_url: 'https://example.invalid/r' }));
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_contacted' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a later call from the same number that also went unanswered does not block the text', async () => {
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    await database('call_log').insert(call(2));
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
  });

  test('an earlier text-back in sms_log blocks a second one even with no claim row (belt under the claim)', async () => {
    await database('sms_log').insert({
      direction: 'outbound', from_phone: '+19412975749', to_phone: PHONE,
      message_body: 'earlier', status: 'sent', message_type: 'missed_call_text_back',
      created_at: new Date(NOW - 3 * 24 * 60 * 60 * 1000),
    });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_sent_to_phone' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  describe('provider boundary (providerPreSendCheck) — rechecked immediately before the handoff', () => {
    test('a voicemail recording that attaches to the original call during provider preparation stops the send; the claim stays free for the voicemail lane', async () => {
      const row = call(READY_MINUTES_AGO);
      sendCustomerMessage.mockImplementationOnce(pipeline(REAL_SEND, {
        before: () => database('call_log').where({ id: row.id }).update({ recording_url: 'https://example.invalid/late-recording' }),
      }));
      await database('call_log').insert(row);
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'not_missed' });
      expect(await claimRow()).toBeUndefined();
      expect((await stored(row)).metadata.missed_call_text_outcome).toBe('skipped:not_missed');
    });

    test('a staff text that lands after the lease stops the send at the boundary; no claim is taken', async () => {
      sendCustomerMessage.mockImplementationOnce(pipeline(REAL_SEND, {
        before: () => database('sms_log').insert({
          direction: 'outbound', from_phone: '+19412975749', to_phone: PHONE,
          message_body: 'staff reply', status: 'sent', message_type: 'manual', created_at: new Date(NOW),
        }),
      }));
      const row = call(READY_MINUTES_AGO);
      await database('call_log').insert(row);
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_contacted' });
      expect(await claimRow()).toBeUndefined();
      expect((await stored(row)).metadata.missed_call_text_outcome).toBe('skipped:already_contacted');
    });

    test('the window closing mid-send holds it (no claim, lease released) and the 8 AM sweep sends it', async () => {
      const endedAt = new Date(Date.parse('2026-09-08T23:50:00Z')); // 19:50 ET — slot runs past 20:00, so it may move to 8 AM
      const row = call(0, { created_at: endedAt, updated_at: endedAt });
      await database('call_log').insert(row);
      nowSpy.mockReturnValue(Date.parse('2026-09-08T23:56:00Z')); // 19:56 ET
      sendCustomerMessage.mockImplementationOnce(pipeline(REAL_SEND, {
        before: () => { nowSpy.mockReturnValue(Date.parse('2026-09-09T00:00:30Z')); }, // 20:00:30 ET at the handoff
      }));
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'error', reason: 'MISSED_CALL_WINDOW_CLOSED' });
      expect(await claimRow()).toBeUndefined();
      const held = await stored(row);
      expect(held.metadata.missed_call_text_settled_at).toBeUndefined();
      expect(held.metadata.missed_call_text_leased_at).toBeUndefined();

      nowSpy.mockReturnValue(Date.parse('2026-09-09T12:04:00Z')); // 08:04 ET
      expect(await sweepMissedCallTextBacks()).toEqual({ sent: 1, offered: 1 });
    });

    test('the send slot closing mid-send settles too_old without a claim', async () => {
      const row = call(34); // slot closes 35 minutes after the terminal update
      await database('call_log').insert(row);
      sendCustomerMessage.mockImplementationOnce(pipeline(REAL_SEND, {
        before: () => { nowSpy.mockReturnValue(NOW + 2 * 60 * 1000); },
      }));
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'too_old' });
      expect(await claimRow()).toBeUndefined();
    });

    test('a concurrent send mid-handoff holds the number: this call stays unsettled for a retry and leaves that claim alone', async () => {
      sendCustomerMessage.mockImplementationOnce(pipeline(REAL_SEND, {
        before: () => database('voicemail_sms_claims').insert({ phone: PHONE, lead_id: randomUUID(), outcome: 'claimed' }),
      }));
      const row = call(READY_MINUTES_AGO);
      await database('call_log').insert(row);
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'error', reason: 'MISSED_CALL_CLAIM_IN_FLIGHT' });
      expect(await claimRow()).toMatchObject({ outcome: 'claimed' });
      expect((await stored(row)).metadata.missed_call_text_settled_at).toBeUndefined();
    });

    test('a concurrent send that already consumed the number wins; this call settles', async () => {
      sendCustomerMessage.mockImplementationOnce(pipeline(REAL_SEND, {
        before: () => database('voicemail_sms_claims').insert({ phone: PHONE, lead_id: null, outcome: CLAIM.SENT }),
      }));
      const row = call(READY_MINUTES_AGO);
      await database('call_log').insert(row);
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_sent_to_phone' });
      expect(await claimRow()).toMatchObject({ outcome: CLAIM.SENT });
    });

    describe('a claim left behind by an attempt that died past the boundary', () => {
      const orphan = (minutesOld) => database('voicemail_sms_claims').insert({
        phone: PHONE, lead_id: null, outcome: CLAIM.DISPATCHING, created_at: new Date(NOW - minutesOld * 60 * 1000),
      });

      test('the provider has no message to the number since the claim → the orphan is released and this call is texted', async () => {
        await orphan(60);
        TwilioService.findOutboundMessageSince.mockResolvedValueOnce({ found: false });
        const row = call(READY_MINUTES_AGO);
        await database('call_log').insert(row);
        expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
        expect(TwilioService.findOutboundMessageSince).toHaveBeenCalledWith(expect.objectContaining({ to: PHONE }));
        expect(await claimRow()).toMatchObject({ lead_id: null, outcome: CLAIM.SENT });
      });

      test('the provider shows a message since the claim → it was delivered; stamped sent, never texted twice', async () => {
        await orphan(60);
        TwilioService.findOutboundMessageSince.mockResolvedValueOnce({ found: true });
        const row = call(READY_MINUTES_AGO);
        await database('call_log').insert(row);
        expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_sent_to_phone' });
        expect(sendCustomerMessage).not.toHaveBeenCalled();
        expect(await claimRow()).toMatchObject({ outcome: CLAIM.SENT });
      });

      test('no answer from the provider keeps the claim (possibly delivered, never texted twice); the call waits unsettled', async () => {
        await orphan(60);
        const row = call(READY_MINUTES_AGO);
        await database('call_log').insert(row);
        expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'pending', reason: 'claim_in_flight' });
        expect(sendCustomerMessage).not.toHaveBeenCalled();
        expect(await claimRow()).toMatchObject({ outcome: CLAIM.DISPATCHING });
        expect((await stored(row)).metadata.missed_call_text_settled_at).toBeUndefined();
      });

      test('a claim still inside one provider round trip is another attempt in flight — no reconciliation, the call waits', async () => {
        await orphan(1);
        const row = call(READY_MINUTES_AGO);
        await database('call_log').insert(row);
        expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'pending', reason: 'claim_in_flight' });
        expect(TwilioService.findOutboundMessageSince).not.toHaveBeenCalled();
      });

      test('every sweep pass reconciles orphans on its own — no eligible call needed, gate off included', async () => {
        isEnabled.mockImplementation(() => false);
        await orphan(60);
        await database('voicemail_sms_claims').insert({ phone: '+19415550103', lead_id: null, outcome: CLAIM.DISPATCHING, created_at: new Date(NOW - 45 * 60 * 1000) });
        TwilioService.findOutboundMessageSince.mockImplementation(async ({ to }) => ({ found: to === '+19415550103' }));
        expect(await sweepMissedCallTextBacks()).toEqual({ sent: 0, offered: 0 });
        expect(await claimRow()).toBeUndefined(); // no message since the claim: released for either lane
        expect(await claimRow('+19415550103')).toMatchObject({ outcome: CLAIM.SENT }); // it went out
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      });

      test('the orphan pass never touches a voicemail-lane claim or a fresh claim', async () => {
        await database('voicemail_sms_claims').insert([
          { phone: PHONE, lead_id: randomUUID(), outcome: 'claimed', created_at: new Date(NOW - 60 * 60 * 1000) },
          { phone: '+19415550104', lead_id: null, outcome: CLAIM.DISPATCHING, created_at: new Date(NOW - 60 * 1000) },
        ]);
        TwilioService.findOutboundMessageSince.mockResolvedValue({ found: false });
        expect(await reconcileOrphanedClaims()).toBe(0);
        expect(await claimRow()).toMatchObject({ outcome: 'claimed' });
        expect(await claimRow('+19415550104')).toMatchObject({ outcome: CLAIM.DISPATCHING });
        expect(TwilioService.findOutboundMessageSince).not.toHaveBeenCalled();
      });
    });

    test('a crash BEFORE the boundary leaves no claim, so the retry sends', async () => {
      sendCustomerMessage.mockImplementationOnce(async () => { throw new Error('worker died before the provider'); });
      const row = call(READY_MINUTES_AGO);
      await database('call_log').insert(row);
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'error' });
      expect(await claimRow()).toBeUndefined();
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
    });

    test('a throw after the boundary took the claim keeps it as uncertain and settles', async () => {
      sendCustomerMessage.mockImplementationOnce(pipeline(() => { throw new Error('lost the provider response'); }));
      const row = call(READY_MINUTES_AGO);
      await database('call_log').insert(row);
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'provider_uncertain' });
      expect(await claimRow()).toMatchObject({ lead_id: null, outcome: CLAIM.UNCERTAIN });
    });

    test('an uncertain provider outcome keeps the claim and settles', async () => {
      sendCustomerMessage.mockImplementationOnce(pipeline({ sent: false, deliveryOutcome: 'uncertain' }));
      const row = call(READY_MINUTES_AGO);
      await database('call_log').insert(row);
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'provider_uncertain' });
      expect(await claimRow()).toMatchObject({ outcome: CLAIM.UNCERTAIN });
      expect((await stored(row)).metadata.missed_call_text_outcome).toBe('skipped:provider_uncertain');
    });

    test('a permanent provider rejection keeps the claim as blocked and settles — the number is not retried', async () => {
      sendCustomerMessage.mockImplementationOnce(pipeline({
        sent: false, blocked: false, deliveryOutcome: 'not_sent', code: 'PROVIDER_FAILURE', retryable: false, terminal: true,
      }));
      const row = call(READY_MINUTES_AGO);
      await database('call_log').insert(row);
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'PROVIDER_FAILURE' });
      expect(await claimRow()).toMatchObject({ outcome: CLAIM.BLOCKED });
      expect((await stored(row)).metadata.missed_call_text_outcome).toBe('skipped:PROVIDER_FAILURE');
    });

    test('a non-terminal provider failure releases the claim and the lease for a retry', async () => {
      sendCustomerMessage.mockImplementationOnce(pipeline({
        sent: false, blocked: false, deliveryOutcome: 'not_sent', code: 'PROVIDER_FAILURE', retryable: false, terminal: false,
      }));
      const row = call(READY_MINUTES_AGO);
      await database('call_log').insert(row);
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'error', reason: 'PROVIDER_FAILURE' });
      expect(await claimRow()).toBeUndefined();
      expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
    });
  });

  test('a suppression sentinel never consumes the one-shot — nothing claimed, call left for a later retry', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'template-disabled' });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'error', reason: 'send_suppressed' });
    expect(await claimRow()).toBeUndefined();
    expect((await stored(row)).metadata.missed_call_text_settled_at).toBeUndefined();
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
  });

  test('a pipeline policy block before the boundary (e.g. STOP) settles the call without taking the claim', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'OPTED_OUT' });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'OPTED_OUT' });
    expect(await claimRow()).toBeUndefined();
    expect((await stored(row)).metadata.missed_call_text_outcome).toBe('skipped:OPTED_OUT');
  });

  test('a retryable pipeline hold before the boundary leaves the call for a retry', async () => {
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CALLBACK_NUMBER_HOLD', retryable: true,
    });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'error', reason: 'CALLBACK_NUMBER_HOLD' });
    const held = await stored(row);
    expect(held.metadata.missed_call_text_settled_at).toBeUndefined();
    expect(held.metadata.missed_call_text_leased_at).toBeUndefined();
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
  });

  test('missing/disabled template settles nothing, so a later re-enable can retry', async () => {
    renderSmsTemplate.mockResolvedValueOnce(undefined);
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'template_disabled' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(await claimRow()).toBeUndefined();
    expect((await stored(row)).metadata.missed_call_text_settled_at).toBeUndefined();
  });

  test('the missed-call bell ringing and settling the same call first does not stop the text (unknown-caller bell is ON in prod)', async () => {
    const bellAt = new Date(NOW - 60 * 1000).toISOString();
    const row = call(READY_MINUTES_AGO, { metadata: { missed_call_notified_at: bellAt, missed_call_settled_at: bellAt } });
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 0, offered: 0 }); // settled now
    const after = await stored(row);
    expect(after.metadata.missed_call_settled_at).toBe(bellAt); // the bell's own keys untouched
    expect(after.metadata.missed_call_text_outcome).toBe('sent');
  });

  test('the same bell-settled call is also picked up by the durable sweep', async () => {
    const bellAt = new Date(NOW - 60 * 1000).toISOString();
    const row = call(READY_MINUTES_AGO, { metadata: { missed_call_notified_at: bellAt, missed_call_settled_at: bellAt } });
    await database('call_log').insert(row);
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 1, offered: 1 });
  });

  test('a late status callback that rewrote updated_at on an hours-old call does not give it a fresh slot', async () => {
    const row = call(3 * 60, { updated_at: new Date(NOW - 6 * 60 * 1000) }); // ended ~3h ago, row touched 6 minutes ago
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'too_old' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('an in-hours call past its 30-minute send slot settles too_old without sending', async () => {
    const row = call(40); // terminal 40 minutes ago: ready at 35, slot closed at 5 minutes ago
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'too_old' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('flipping the gate on mid-morning never texts last night\'s calls', async () => {
    const lastNight = new Date(Date.parse('2026-09-09T02:00:00Z')); // 22:00 ET
    const row = call(0, { created_at: lastNight, updated_at: lastNight });
    await database('call_log').insert(row);
    nowSpy.mockReturnValue(Date.parse('2026-09-09T14:00:00Z')); // 10:00 ET
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 0, offered: 1 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await stored(row)).metadata.missed_call_text_outcome).toBe('skipped:too_old');
  });

  test('a call that clears its voicemail grace after 8 PM ET is deferred and goes out at 8 AM', async () => {
    const endedAt = new Date(Date.parse('2026-09-08T23:57:00Z')); // 19:57 ET
    const row = call(0, { created_at: endedAt, updated_at: endedAt });
    await database('call_log').insert(row);
    nowSpy.mockReturnValue(Date.parse('2026-09-09T00:02:30Z')); // 20:02:30 ET — the post-call hook
    expect((await textBackIfMissed(row.twilio_call_sid)).outcome).toBe('deferred');
    nowSpy.mockReturnValue(Date.parse('2026-09-09T12:04:00Z')); // 08:04 ET
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 1, offered: 1 });
  });

  test('the sweep judges each row by a fresh clock — a pass that runs past 8 PM ET holds the later rows', async () => {
    const endedAt = new Date(Date.parse('2026-09-08T23:40:00Z')); // 19:40 ET
    const first = call(0, { created_at: endedAt, updated_at: endedAt });
    const second = call(0, { created_at: new Date(endedAt.getTime() + 1000), updated_at: endedAt, from_phone: '+19415550102' });
    await database('call_log').insert([first, second]);
    nowSpy.mockReturnValue(Date.parse('2026-09-08T23:59:30Z')); // 19:59:30 ET
    sendCustomerMessage.mockImplementationOnce(pipeline(() => {
      nowSpy.mockReturnValue(Date.parse('2026-09-09T00:00:10Z')); // the first send finishes at 20:00:10 ET
      return REAL_SEND;
    }));
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 1, offered: 2 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect((await stored(second)).metadata.missed_call_text_settled_at).toBeUndefined();
    expect(await claimRow('+19415550102')).toBeUndefined();
  });

  test('never-textable rows (withheld caller ID) never eat the sweep budget', async () => {
    const withheld = Array.from({ length: 3 }, () => call(READY_MINUTES_AGO + 2, { from_phone: 'anonymous' }));
    const eligible = call(READY_MINUTES_AGO);
    await database('call_log').insert([...withheld, eligible]);
    expect(await sweepMissedCallTextBacks({ limit: 2 })).toEqual({ sent: 1, offered: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('the sweep pages past ineligible rows and finds the one eligible call', async () => {
    // Other callers' answered calls (a same-number answered call would count
    // as contact — covered separately above).
    const ineligible = Array.from({ length: 5 }, (_, i) => call(READY_MINUTES_AGO, { from_phone: `+1941555020${i}`, answered_by: 'human', status: 'completed' }));
    const eligible = call(READY_MINUTES_AGO);
    await database('call_log').insert([...ineligible, eligible]);
    expect(await sweepMissedCallTextBacks({ limit: 50 })).toEqual({ sent: 1, offered: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });
});
