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
    expect(rows[0].metadata).toMatchObject({ manual_send_reservation: true, manual_wrapper_reservation: true, provider_outcome_uncertain: true });

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
