// CI's existing DB-gated pass runs this against PostgreSQL. All fixture data
// lives in a unique schema that is removed after the suite; delivery
// (sendCustomerMessage / renderSmsTemplate) is mocked — this suite pins the
// claim/lease/one-per-number-ever DB behavior, not the SMS pipeline itself.
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
  isInternalNumber: () => false,
  isTechLine: (n) => n === '+19413529161',
  tollFree: { number: '+18559260203' },
  findByNumber: jest.fn((n) => (n === '+19412975749' ? { id: 'main' } : null)),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM_real_sid' })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (key, vars) => `Hi there, it's Waves. Sorry we missed your call. Text us here with what you need, or call back anytime${vars.callback_clause}.`),
}));

const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const {
  textBackIfMissed, sweepMissedCallTextBacks, CLAIM_PREFIX,
} = require('../services/missed-call-text-back');

jest.setTimeout(30000);
(SKIP ? describe.skip : describe)('missed-call text-back on PostgreSQL', () => {
  let database;
  const schema = `missed_call_text_${randomUUID().replaceAll('-', '')}`;
  const tables = ['call_log', 'customers', 'sms_log', 'sms_send_claims', 'voicemail_sms_claims', 'blocked_numbers', 'blocked_call_attempts'];
  // 2026-09-08T15:00Z = 11:00 ET (EDT) — inside the 8am–8pm send window.
  const NOW = Date.parse('2026-09-08T15:00:00Z');
  let nowSpy;

  beforeAll(async () => {
    database = knex({ client: 'pg', connection: process.env.DATABASE_URL, searchPath: [schema], pool: { min: 0, max: 3 } });
    await database.raw('CREATE SCHEMA ??', [schema]);
    for (const table of tables) await database.raw('CREATE TABLE ??.?? AS SELECT * FROM public.?? WITH NO DATA', [schema, table, table]);
    // CREATE TABLE ... AS SELECT copies columns only, never constraints —
    // the module's one-per-number-EVER claim needs a real unique target for
    // its `ON CONFLICT (claim_key) DO NOTHING`.
    await database.raw('ALTER TABLE ??.?? ADD UNIQUE (claim_key)', [schema, 'sms_send_claims']);
    mockConn = database;
  });
  beforeEach(() => {
    jest.clearAllMocks();
    isEnabled.mockImplementation(() => true);
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM_real_sid' });
    renderSmsTemplate.mockImplementation(async (key, vars) => `Hi there, it's Waves. Sorry we missed your call. Text us here with what you need, or call back anytime${vars.callback_clause}.`);
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
      from_phone: '+19415550100',
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
  // enough not to trip the 30-minute in-hours staleness rule.
  const READY_MINUTES_AGO = 6;

  test('gate off is a no-op before any query', async () => {
    isEnabled.mockImplementation(() => false);
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'gate_off' });
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 0, offered: 0 });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata).toEqual({});
  });

  test('an eligible unknown caller inside the send window gets exactly one text, sent from the dialed line', async () => {
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const sendInput = sendCustomerMessage.mock.calls[0][0];
    expect(sendInput.to).toBe('+19415550100');
    expect(sendInput.metadata.fromNumber).toBe('+19412975749');
    expect(sendInput.purpose).toBe('missed_call_followup');
    expect(sendInput.body).not.toMatch(/reply stop/i);
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_settled_at).toBeTruthy();
    expect(stored.metadata.missed_call_text_outcome).toBe('sent');
    const claim = await database('sms_send_claims').where({ claim_key: `${CLAIM_PREFIX}+19415550100` }).first();
    expect(claim).toBeTruthy();
  });

  test('one text per phone number EVER — a second missed call from the same number is skipped even on a fresh call_log row', async () => {
    const first = call(READY_MINUTES_AGO);
    await database('call_log').insert(first);
    expect(await textBackIfMissed(first.twilio_call_sid)).toEqual({ outcome: 'sent' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);

    const second = call(READY_MINUTES_AGO);
    await database('call_log').insert(second);
    expect(await textBackIfMissed(second.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_sent_to_phone' });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const stored = await database('call_log').where({ id: second.id }).first();
    expect(stored.metadata.missed_call_text_outcome).toBe('skipped:already_sent_to_phone');
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
    const customerId = randomUUID();
    await database('customers').insert({ id: customerId, first_name: 'Test', phone: '+19415550100' });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'existing_customer' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_outcome).toBe('skipped:existing_customer');
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
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_settled_at).toBeUndefined();
  });

  test('outside 8am-8pm ET the call is deferred, not sent, and the durable sweep sends it once the window reopens', async () => {
    // 2026-09-09T02:00Z = 22:00 ET the prior evening.
    const outOfWindow = Date.parse('2026-09-09T02:00:00Z');
    nowSpy.mockReturnValue(outOfWindow);
    const row = call(0, { created_at: new Date(outOfWindow), updated_at: new Date(outOfWindow) });
    await database('call_log').insert(row);
    const result = await textBackIfMissed(row.twilio_call_sid);
    expect(result.outcome).toBe('deferred');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    let stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_settled_at).toBeUndefined();

    // The next morning the sweep finds it and sends.
    const nextMorning = Date.parse('2026-09-09T12:05:00Z'); // ~8:05am ET
    nowSpy.mockReturnValue(nextMorning);
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 1, offered: 1 });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_outcome).toBe('sent');
  });

  test('too old for a first-time text (past the 14h bounded catch-up) settles skipped without sending', async () => {
    const row = call(15 * 60); // 15 hours ago
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'too_old' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_outcome).toBe('skipped:too_old');
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
      direction: 'outbound', from_phone: '+19412975749', to_phone: '+19415550100',
      status: 'completed', answered_by: 'human',
    }));
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_contacted' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('already texted by the voicemail-lead-sms lane (its own claim table) is skipped', async () => {
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    await database('voicemail_sms_claims').insert({ phone: '+19415550100', lead_id: randomUUID(), outcome: 'sent' });
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'voicemail_lead_texted' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a suppression sentinel never consumes the one-shot — the claim is released for a later retry', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'template-disabled' });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'error', reason: 'send_suppressed' });
    const claim = await database('sms_send_claims').where({ claim_key: `${CLAIM_PREFIX}+19415550100` }).first();
    expect(claim).toBeUndefined();
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_settled_at).toBeUndefined();

    // A retry now succeeds.
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'SM_real_sid' });
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
  });

  test('a terminal policy block (e.g. STOP) keeps the claim — the number is never retried', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'OPTED_OUT' });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'OPTED_OUT' });
    const claim = await database('sms_send_claims').where({ claim_key: `${CLAIM_PREFIX}+19415550100` }).first();
    expect(claim).toBeTruthy();
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_outcome).toBe('skipped:OPTED_OUT');
  });

  test('missing/disabled template releases the claim and settles nothing, so a later re-enable can retry', async () => {
    renderSmsTemplate.mockResolvedValueOnce(undefined);
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'template_disabled' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const claim = await database('sms_send_claims').where({ claim_key: `${CLAIM_PREFIX}+19415550100` }).first();
    expect(claim).toBeUndefined();
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_settled_at).toBeUndefined();
  });

  test('the missed-call bell ringing and settling the same call first does not stop the text (unknown-caller bell is ON in prod)', async () => {
    const bellAt = new Date(NOW - 60 * 1000).toISOString();
    const row = call(READY_MINUTES_AGO, { metadata: { missed_call_notified_at: bellAt, missed_call_settled_at: bellAt } });
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 0, offered: 0 }); // settled now
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_settled_at).toBe(bellAt); // the bell's own keys untouched
    expect(stored.metadata.missed_call_text_outcome).toBe('sent');
  });

  test('the same bell-settled call is also picked up by the durable sweep', async () => {
    const bellAt = new Date(NOW - 60 * 1000).toISOString();
    const row = call(READY_MINUTES_AGO, { metadata: { missed_call_notified_at: bellAt, missed_call_settled_at: bellAt } });
    await database('call_log').insert(row);
    expect(await sweepMissedCallTextBacks()).toEqual({ sent: 1, offered: 1 });
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
      { id: randomUUID(), first_name: 'One', phone: '+19415550100' },
      { id: randomUUID(), first_name: 'Two', phone: '941-555-0100' },
    ]);
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'existing_customer' });
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
      direction: 'outbound', from_phone: '+19412975749', to_phone: '+19415550100',
      message_body: 'earlier', status: 'sent', message_type: 'missed_call_text_back',
      created_at: new Date(NOW - 3 * 24 * 60 * 60 * 1000),
    });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'already_sent_to_phone' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a retryable pipeline hold never consumes the one-shot — claim released, call left for a retry', async () => {
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'CALLBACK_NUMBER_HOLD', retryable: true,
    });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'error', reason: 'CALLBACK_NUMBER_HOLD' });
    expect(await database('sms_send_claims').where({ claim_key: `${CLAIM_PREFIX}+19415550100` }).first()).toBeUndefined();
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_settled_at).toBeUndefined();
    expect(stored.metadata.missed_call_text_leased_at).toBeUndefined();

    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
  });

  test('a permanent provider rejection keeps the claim and settles — the number is not retried', async () => {
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: false, deliveryOutcome: 'not_sent', code: 'PROVIDER_FAILURE', retryable: false, terminal: true,
    });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'skipped', reason: 'PROVIDER_FAILURE' });
    expect(await database('sms_send_claims').where({ claim_key: `${CLAIM_PREFIX}+19415550100` }).first()).toBeTruthy();
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_outcome).toBe('skipped:PROVIDER_FAILURE');
  });

  test('a non-terminal provider failure releases the claim and the lease for a retry', async () => {
    sendCustomerMessage.mockResolvedValueOnce({
      sent: false, blocked: false, deliveryOutcome: 'not_sent', code: 'PROVIDER_FAILURE', retryable: false, terminal: false,
    });
    const row = call(READY_MINUTES_AGO);
    await database('call_log').insert(row);
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'error', reason: 'PROVIDER_FAILURE' });
    expect(await database('sms_send_claims').where({ claim_key: `${CLAIM_PREFIX}+19415550100` }).first()).toBeUndefined();
    expect(await textBackIfMissed(row.twilio_call_sid)).toEqual({ outcome: 'sent' });
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
    const stored = await database('call_log').where({ id: row.id }).first();
    expect(stored.metadata.missed_call_text_outcome).toBe('skipped:too_old');
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
