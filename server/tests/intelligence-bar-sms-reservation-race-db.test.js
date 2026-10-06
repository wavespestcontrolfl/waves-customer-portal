/**
 * IB send_sms: the send reservation is atomic (private Postgres).
 *
 * Two cards for the same number and the same words, confirmed at the same moment, must produce one
 * provider call and one refusal, not two texts. The reservation uses the manual-send wrapper's own
 * mechanism (the shared per-thread advisory transaction lock and createReplyHoldingReservation), so
 * these tests run the real lock and the real rows; only the provider-facing sender is a stub (no text
 * is ever sent). Run with IB_TEST_DATABASE_URL naming a waves_ib_workflow_* or waves_ib_platform_* database.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/twilio', () => ({ deriveOutboundNumber: jest.fn(async () => '+19413529161') }));
jest.mock('../services/messaging/send-manual-customer-sms', () => ({
  sendManualCustomerSms: jest.fn(),
  manualSmsDeliveryState: (value) => value?.manualSmsInterlock?.deliveryState || null,
}));

const crypto = require('crypto');

const databaseUrl = process.env.IB_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
jest.setTimeout(60000);

suite('send_sms reservation on isolated Postgres', () => {
  let db; let executeCommsTool; let sendManualCustomerSms;
  const bodies = [];
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const newBody = (label) => { const body = `Synthetic race ${label} ${crypto.randomUUID()}`; bodies.push(body); return body; };
  const newPhone = () => `+1941555${String(Math.floor(Math.random() * 10000)).padStart(4, '0')}`;
  const heldRows = (body) => db('sms_log').where({ message_body: body, direction: 'outbound' }).select('id', 'status', 'metadata');
  const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const accepted = () => ({ sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'b'.repeat(32)}`, manualSmsInterlock: { deliveryState: 'accepted' } });

  beforeAll(() => {
    const parsed = new URL(databaseUrl);
    if (!/^\/waves_ib_(workflow|platform)_[a-z0-9_]+$/.test(parsed.pathname)) throw new Error('An isolated IB development database is required');
    process.env.DATABASE_URL = databaseUrl;
    process.env.NODE_ENV = 'test';
    db = require('../models/db');
    ({ executeCommsTool } = require('../services/intelligence-bar/comms-tools'));
    ({ sendManualCustomerSms } = require('../services/messaging/send-manual-customer-sms'));
  });

  beforeEach(() => { sendManualCustomerSms.mockReset(); });

  afterAll(async () => {
    if (db) {
      if (bodies.length) await db('sms_log').whereIn('message_body', bodies).del();
      await db.destroy();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  test('concurrent confirms of the same number and text: exactly one provider call, the rest refused (several rounds)', async () => {
    for (let round = 0; round < 5; round += 1) {
      const phone = newPhone();
      const message = newBody(`round${round}`);
      sendManualCustomerSms.mockReset();
      // The provider call takes long enough that every other confirm arrives while it is in flight.
      sendManualCustomerSms.mockImplementation(async () => { await delay(400); return accepted(); });

      const results = await Promise.all(Array.from({ length: 6 }, () => executeCommsTool('send_sms', { phone, message, message_type: 'manual' })));

      expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
      expect(results.filter((r) => r.success === true)).toHaveLength(1);
      const refused = results.filter((r) => r.code === 'SMS_PRIOR_OUTCOME_UNRECONCILED');
      expect(refused).toHaveLength(5);
      refused.forEach((r) => expect(r).toMatchObject({ success: false, blocked: true, mayHaveSent: true }));
      // The accepted send released its reservation; the real row is the provider path's, not ours.
      expect(await heldRows(message)).toHaveLength(0);
    }
  });

  test('a different text to the same number is not blocked by an in-flight send', async () => {
    const phone = newPhone();
    const first = newBody('first');
    const second = newBody('second');
    sendManualCustomerSms.mockImplementation(async () => { await delay(200); return accepted(); });

    const results = await Promise.all([first, second].map((message) => executeCommsTool('send_sms', { phone, message, message_type: 'manual' })));

    expect(sendManualCustomerSms).toHaveBeenCalledTimes(2);
    expect(results.every((r) => r.success === true)).toBe(true);
  });

  test('a definite failure releases the reservation, so a later send of the same text works', async () => {
    const phone = newPhone();
    const message = newBody('failure');
    sendManualCustomerSms.mockResolvedValueOnce({ sent: false, blocked: false, deliveryOutcome: 'not_sent', code: 'PROVIDER_FAILURE', reason: 'rejected', manualSmsInterlock: { deliveryState: 'not_sent' } });

    const failed = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(failed).toMatchObject({ success: false, code: 'PROVIDER_FAILURE' });
    expect(await heldRows(message)).toHaveLength(0);

    sendManualCustomerSms.mockResolvedValueOnce(accepted());
    const later = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(later).toMatchObject({ success: true, state: 'provider_accepted' });
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(2);
  });

  test('an unknown outcome leaves the held row, and a repeat is refused with no provider call', async () => {
    const phone = newPhone();
    const message = newBody('unknown');
    sendManualCustomerSms.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE', reason: 'timeout', manualSmsInterlock: { deliveryState: 'uncertain' } });

    const first = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(first).toMatchObject({ success: false, outcome_unknown: true });

    const rows = await heldRows(message);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('sending');
    expect(rows[0].metadata).toMatchObject({ manual_send_reservation: true, manual_wrapper_reservation: true, provider_handoff_reservation: true, provider_outcome_uncertain: true });

    const again = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(again).toMatchObject({ success: false, blocked: true, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED' });
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
    expect(await heldRows(message)).toHaveLength(1);
  });

  test('a thrown unknown outcome leaves the held row too', async () => {
    const phone = newPhone();
    const message = newBody('thrown');
    sendManualCustomerSms.mockRejectedValueOnce(Object.assign(new Error('receipt unavailable'), {
      code: 'SMS_DELIVERY_UNCERTAIN', providerOutcome: { sent: false, deliveryOutcome: 'uncertain' },
    }));

    const first = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(first).toMatchObject({ success: false, outcome_unknown: true });
    expect(await heldRows(message)).toHaveLength(1);
  });

  test('a send that fails to start leaves no reservation behind when the wrapper refuses it', async () => {
    const phone = newPhone();
    const message = newBody('interlock');
    sendManualCustomerSms.mockResolvedValueOnce({ sent: false, blocked: true, code: 'MANUAL_REPLY_OUTCOME_UNRESOLVED', manualSmsInterlock: { deliveryState: 'uncertain' } });

    await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });

    expect(await heldRows(message)).toHaveLength(0);
  });

  test('a crash after the handoff and before settlement: the row survives the 30-minute reservation sweep, still blocks a resend, and is released after the 24-hour hold', async () => {
    const guard = require('../services/intelligence-bar/sms-outcome-guard');
    const { reconcileAutoSendClaims } = require('../services/sms-auto-send');
    const phone = newPhone();
    const message = newBody('crash');
    // Acquire and never settle: the process died between the provider handoff and the settle.
    const reservation = await guard.acquireSendReservation({ phone, body: message });
    expect(reservation.id).toBeTruthy();
    const rows = await heldRows(message);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ manual_send_reservation: true, provider_handoff_reservation: true, provider_outcome_uncertain: true });
    expect(rows[0].metadata.manual_wrapper_reservation).toBeUndefined();

    // 31 minutes later the ungated five-minute scheduler runs the reservation sweep.
    const thirtyOne = new Date(Date.now() - 31 * 60 * 1000);
    await db('sms_log').where({ id: reservation.id }).update({ created_at: thirtyOne, updated_at: thirtyOne });
    await reconcileAutoSendClaims();
    expect(await heldRows(message)).toHaveLength(1);
    const again = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(again).toMatchObject({ success: false, blocked: true, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED' });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();

    // Past the 24-hour hold the same sweep releases it, and the text can be sent again.
    const dayAgo = new Date(Date.now() - (24 * 60 + 1) * 60 * 1000);
    await db('sms_log').where({ id: reservation.id }).update({ created_at: dayAgo, updated_at: dayAgo });
    await reconcileAutoSendClaims();
    expect(await heldRows(message)).toHaveLength(0);
    sendManualCustomerSms.mockResolvedValueOnce(accepted());
    const later = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(later).toMatchObject({ success: true, state: 'provider_accepted' });
  });

  test('with a manual-reply lifecycle active, the wrapper interlock does not refuse the send because of our in-flight row (sends once)', async () => {
    const phone = newPhone();
    const message = newBody('lifecycle');
    // While our row is in flight, the wrapper's own interlock lookup finds nothing: the in-flight row
    // carries provider_handoff_reservation but not manual_wrapper_reservation.
    sendManualCustomerSms.mockImplementationOnce(async () => {
      const identity = require('../utils/phone').phoneIdentityKey(phone);
      const live = await db('sms_log').where({ direction: 'outbound', status: 'sending' })
        .whereRaw("metadata->>'manual_send_reservation' = 'true'")
        .whereRaw("metadata->>'manual_wrapper_reservation' = 'true'")
        .whereRaw(`${require('../services/sms-response-policy').phoneIdentitySql("BTRIM(COALESCE(to_phone, ''))")} = ?`, [identity])
        .first('id');
      expect(live).toBeUndefined();
      return accepted();
    });
    const result = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(result).toMatchObject({ success: true });
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
    expect(await heldRows(message)).toHaveLength(0);
  });

  test.each([
    ['curly vs straight apostrophe', 'We’ll be there Tuesday at 9.', "We'll be there Tuesday at 9."],
    ['em dash vs hyphen', 'Visit moved — Friday at 11.', 'Visit moved - Friday at 11.'],
    ['with vs without https://', 'Pay here: https://waves.example/pay/abc', 'Pay here: waves.example/pay/abc'],
  ])('a second send that differs only by %s is the same text to the provider: refused', async (_label, first, second) => {
    const phone = newPhone();
    bodies.push(first, second, require('../services/messaging/send-customer-message').canonicalSmsBody(first));
    sendManualCustomerSms.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE', reason: 'timeout', manualSmsInterlock: { deliveryState: 'uncertain' } });
    const unknown = await executeCommsTool('send_sms', { phone, message: first, message_type: 'manual' });
    expect(unknown).toMatchObject({ outcome_unknown: true });

    const again = await executeCommsTool('send_sms', { phone, message: second, message_type: 'manual' });
    expect(again).toMatchObject({ success: false, blocked: true, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED' });
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
  });

  test('a genuinely different text to the same number is still allowed while another is held', async () => {
    const phone = newPhone();
    const held = newBody('held');
    const other = newBody('other');
    sendManualCustomerSms.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE', manualSmsInterlock: { deliveryState: 'uncertain' } });
    await executeCommsTool('send_sms', { phone, message: held, message_type: 'manual' });
    sendManualCustomerSms.mockResolvedValueOnce(accepted());
    const result = await executeCommsTool('send_sms', { phone, message: other, message_type: 'manual' });
    expect(result).toMatchObject({ success: true });
  });

  test('horizon: a manual held row 25 hours old no longer blocks; a review-ask reservation 48 hours old still does', async () => {
    const phone = newPhone();
    const message = newBody('horizon');
    const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);
    // A scheduled review ask held after an ambiguous attempt (scheduled-sms-delivery.js), 48 hours old.
    const [ask] = await db('sms_log').insert({
      direction: 'outbound', from_phone: '+19413529161', to_phone: phone, message_body: message, status: 'scheduled', message_type: 'review_request',
      scheduled_for: new Date(Date.now() + 3600000), metadata: JSON.stringify({ review_ask_reservation: true }), created_at: hoursAgo(48), updated_at: hoursAgo(48),
    }).returning('id');
    const refused = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(refused).toMatchObject({ success: false, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED' });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
    await db('sms_log').where({ id: ask.id }).del();

    // A manual held row 25 hours old is past the wrapper window.
    await db('sms_log').insert({
      direction: 'outbound', from_phone: '+19413529161', to_phone: phone, message_body: message, status: 'sending', message_type: 'manual',
      metadata: JSON.stringify({ manual_send_reservation: true, manual_wrapper_reservation: true, provider_outcome_uncertain: true }), created_at: hoursAgo(25), updated_at: hoursAgo(25),
    });
    sendManualCustomerSms.mockResolvedValueOnce(accepted());
    const allowed = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(allowed).toMatchObject({ success: true });
  });

  test('a failed review-ask reservation 10 hours old (stale-claim recovery kept its marker) still refuses a same-body send', async () => {
    const phone = newPhone();
    const message = newBody('failed-ask');
    const tenHoursAgo = new Date(Date.now() - 10 * 60 * 60 * 1000);
    await db('sms_log').insert({
      direction: 'outbound', from_phone: '+19413529161', to_phone: phone, message_body: message, status: 'failed', message_type: 'review_request',
      scheduled_for: tenHoursAgo, metadata: JSON.stringify({ review_ask_reservation: true, scheduled_sms_recovered_at: tenHoursAgo.toISOString() }),
      created_at: tenHoursAgo, updated_at: tenHoursAgo,
    });
    const refused = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(refused).toMatchObject({ success: false, blocked: true, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED' });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
  });

  test('a result with sent: true but deliveryOutcome uncertain is ambiguous: the row is held and a retry is refused', async () => {
    const phone = newPhone();
    const message = newBody('sent-uncertain');
    sendManualCustomerSms.mockResolvedValueOnce({ sent: true, deliveryOutcome: 'uncertain', providerMessageId: null, manualSmsInterlock: { deliveryState: 'uncertain' } });
    const first = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(first).toMatchObject({ success: false, outcome_unknown: true });
    const rows = await heldRows(message);
    expect(rows).toHaveLength(1);
    expect(rows[0].metadata).toMatchObject({ provider_outcome_uncertain: true, manual_wrapper_reservation: true });
    const again = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(again).toMatchObject({ success: false, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED' });
    expect(sendManualCustomerSms).toHaveBeenCalledTimes(1);
  });

  test('a queued row stored with a curly apostrophe, requeued after an uncertain attempt, blocks the straight-apostrophe retry', async () => {
    const phone = newPhone();
    const stored = `We’ll be there Tuesday at 9. ${crypto.randomUUID()}`;
    const typed = stored.replace('’', "'");
    bodies.push(stored, typed);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db('sms_log').insert({
      direction: 'outbound', from_phone: '+19413529161', to_phone: phone, message_body: stored, status: 'scheduled', message_type: 'manual',
      scheduled_for: new Date(Date.now() + 5 * 60 * 1000), metadata: JSON.stringify({ provider_retry_at: hourAgo.toISOString(), provider_retry_code: 'PROVIDER_FAILURE', provider_outcome_uncertain: true, provider_outcome_uncertain_at: hourAgo.toISOString() }),
      created_at: hourAgo, updated_at: hourAgo,
    });
    const refused = await executeCommsTool('send_sms', { phone, message: typed, message_type: 'manual' });
    expect(refused).toMatchObject({ success: false, blocked: true, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED' });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
  });

  test('a text queued 5 days ago ages from its uncertain attempt: requeued uncertain 10 hours ago blocks the retry, 30 hours ago does not', async () => {
    const phone = newPhone();
    const message = newBody('aged');
    const hoursAgo = (h) => new Date(Date.now() - h * 60 * 60 * 1000);
    const [queued] = await db('sms_log').insert({
      direction: 'outbound', from_phone: '+19413529161', to_phone: phone, message_body: message, status: 'scheduled', message_type: 'manual',
      scheduled_for: hoursAgo(10), metadata: JSON.stringify({ scheduled_sms_claimed_at: hoursAgo(10).toISOString(), provider_outcome_uncertain: true, provider_outcome_uncertain_at: hoursAgo(10).toISOString() }),
      created_at: hoursAgo(5 * 24), updated_at: hoursAgo(10),
    }).returning('id');
    const refused = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(refused).toMatchObject({ success: false, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED' });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();

    await db('sms_log').where({ id: queued.id }).update({
      metadata: JSON.stringify({ scheduled_sms_claimed_at: hoursAgo(30).toISOString(), provider_outcome_uncertain: true, provider_outcome_uncertain_at: hoursAgo(30).toISOString() }), updated_at: hoursAgo(30),
    });
    sendManualCustomerSms.mockResolvedValueOnce(accepted());
    const allowed = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(allowed).toMatchObject({ success: true });
  });

  test.each([
    ['blocked', 'the final retry ended with an unknown outcome'],
    ['failed', 'an exception after a possible handoff'],
  ])('a %s row carrying provider_outcome_uncertain 1 hour old blocks the retry (%s)', async (status) => {
    const phone = newPhone();
    const message = newBody(`marker-${status}`);
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db('sms_log').insert({
      direction: 'outbound', from_phone: '+19413529161', to_phone: phone, message_body: message, status, message_type: 'manual',
      scheduled_for: hourAgo, metadata: JSON.stringify({ terminal_pending: false, provider_outcome_uncertain: true, provider_outcome_uncertain_at: hourAgo.toISOString() }),
      created_at: new Date(Date.now() - 3 * 60 * 60 * 1000), updated_at: hourAgo,
    });
    const refused = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(refused).toMatchObject({ success: false, blocked: true, code: 'SMS_PRIOR_OUTCOME_UNRECONCILED' });
    expect(sendManualCustomerSms).not.toHaveBeenCalled();
  });

  test('a scheduled row requeued after QUIET_HOURS_HOLD, with only a claim marker, does NOT block: the carrier was never contacted', async () => {
    const phone = newPhone();
    const message = newBody('quiet-hours');
    const hourAgo = new Date(Date.now() - 60 * 60 * 1000);
    await db('sms_log').insert({
      direction: 'outbound', from_phone: '+19413529161', to_phone: phone, message_body: message, status: 'scheduled', message_type: 'manual',
      scheduled_for: new Date(Date.now() + 8 * 60 * 60 * 1000), metadata: JSON.stringify({ scheduled_sms_claimed_at: hourAgo.toISOString(), original_block_code: 'QUIET_HOURS_HOLD', scheduled_sms_attempts: 0 }),
      created_at: hourAgo, updated_at: hourAgo,
    });
    sendManualCustomerSms.mockResolvedValueOnce(accepted());
    const allowed = await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });
    expect(allowed).toMatchObject({ success: true });
  });

  test('a wrapper-held row for the same text (its own reservation) makes ours redundant, not doubled', async () => {
    const phone = newPhone();
    const message = newBody('wrapper');
    sendManualCustomerSms.mockImplementationOnce(async () => {
      // With a manual-reply lifecycle active the wrapper takes its own reservation and leaves it held.
      await db('sms_log').insert({
        direction: 'outbound', from_phone: '+19413529161', to_phone: phone, message_body: message, status: 'sending', message_type: 'manual',
        metadata: JSON.stringify({ manual_send_reservation: true, manual_wrapper_reservation: true, provider_outcome_uncertain: true }),
      });
      return { sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_FAILURE', manualSmsInterlock: { deliveryState: 'uncertain' } };
    });

    await executeCommsTool('send_sms', { phone, message, message_type: 'manual' });

    expect(await heldRows(message)).toHaveLength(1);
  });
});
