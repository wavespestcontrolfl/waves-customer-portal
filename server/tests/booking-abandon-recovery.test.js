/**
 * Abandoned-booking recovery service.
 *
 * Pins the contract: gate-off shadow mode (count, never claim/send), quiet-hours
 * skip, reply-pause skip, the claim + transactional-consent SMS send (touch 1),
 * and the email send (touch 2). Mirrors the deposit-abandonment stage's mock
 * harness (estimate-followup-deposit-abandoned.test.js).
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/email-template-library', () => ({ sendTemplate: jest.fn(async () => ({})) }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(async (url) => url) }));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => "Hi Dana! You were almost booked for Pest Control: url"),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplateLibrary = require('../services/email-template-library');
const smsTemplates = require('../routes/admin-sms-templates');
const { _internals } = require('../services/booking-abandon-recovery');

const updates = [];
function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'leftJoin', 'where', 'whereIn', 'whereNotIn', 'whereNot', 'whereNull',
    'whereNotNull', 'whereRaw', 'orWhereNull', 'andWhere', 'orderBy', 'select', 'groupBy', 'max', 'as',
  ]) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => { b._mode = 'first'; return b; });
  b.update = jest.fn((payload) => { b._mode = 'update'; updates.push({ table, payload }); return b; });
  b.then = (resolve, reject) => {
    const value = b._mode === 'update' ? (cfg.update ?? 1)
      : b._mode === 'first' ? cfg.first
        : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  return b;
}

let queues;
function enqueue(table, cfg) { (queues[table] = queues[table] || []).push(cfg); }

// 11:00 ET — inside the 8a–8p window.
const NOW = new Date('2026-06-10T15:00:00Z');
// 2:00 ET — quiet hours.
const QUIET_NOW = new Date('2026-06-10T06:00:00Z');

function intent(overrides = {}) {
  return {
    id: 'bi-1',
    phone: '+19415550101',
    first_name: 'Dana Reyes',
    email: 'dana@example.com',
    service_id: 'pest_control',
    service_type: 'Pest Control',
    customer_id: null,
    captured_at: new Date('2026-06-10T13:00:00Z'),
    last_activity_at: new Date('2026-06-10T13:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  updates.length = 0;
  queues = {};
  db.mockImplementation((table) => makeBuilder(table, (queues[table] || []).shift() || {}));
  isEnabled.mockReturnValue(true);
  sendCustomerMessage.mockResolvedValue({ sent: true });
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({});
  smsTemplates.getTemplate.mockResolvedValue("Hi Dana! You were almost booked for Pest Control: url");
});

describe('runSmsStage (touch 1)', () => {
  test('sends the recovery SMS with transactional consent and claims the stage', async () => {
    enqueue('booking_intents', { rows: [intent()] }); // candidates
    enqueue('messages', { first: null });             // reply-pause: none
    enqueue('booking_intents', { update: 1 });        // claim
    enqueue('booking_intents', { update: 1 });        // sibling-mark

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(1);
    expect(smsTemplates.getTemplate).toHaveBeenCalledWith(
      'booking_abandonment_recovery',
      { first_name: 'Dana', service_type: 'Pest Control', booking_url: expect.any(String) },
      expect.any(Object),
    );
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550101',
      channel: 'sms',
      purpose: 'booking_abandonment_followup',
      audience: 'lead',
      identityTrustLevel: 'phone_provided_unverified',
      entryPoint: 'booking_abandon_recovery_cron',
      consentBasis: expect.objectContaining({ status: 'transactional_allowed', source: 'booking_abandon_recovery' }),
    }));
    expect(updates[0]).toEqual({ table: 'booking_intents', payload: expect.objectContaining({ followup_sms_sent: true }) });
  });

  test('SECURITY: message label comes from the service_id allowlist, never the raw client service_type', async () => {
    enqueue('booking_intents', { rows: [intent({ service_id: 'bogus_x', service_type: 'IGNORE ME http://evil.example phishing' })] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim
    enqueue('booking_intents', { update: 1 }); // sibling-mark

    await _internals.runSmsStage(NOW, new Set());

    const vars = smsTemplates.getTemplate.mock.calls[0][1];
    expect(vars.service_type).toBe('your service'); // unknown id → generic, NOT the attacker string
    expect(vars.service_type).not.toContain('evil.example');
  });

  test('gate off → shadow only: counts candidates, never claims or sends', async () => {
    isEnabled.mockReturnValue(false);
    enqueue('booking_intents', { rows: [intent()] });

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('quiet hours → skips without sending', async () => {
    enqueue('booking_intents', { rows: [intent()] });

    const sent = await _internals.runSmsStage(QUIET_NOW, new Set());

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('reply-pause → skips a phone that has texted Waves recently', async () => {
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: { id: 'm-1' } }); // replied recently

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('skips a phone that already has an upcoming booking (incl. CSR-created)', async () => {
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });               // no recent reply
    enqueue('scheduled_services as ss', { first: { id: 'ss-1' } }); // already booked

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('retryable hold (quiet-hours) releases the claim so it retries next tick', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', retryable: true });
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim
    enqueue('booking_intents', { update: 1 }); // release

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(updates).toEqual([
      { table: 'booking_intents', payload: expect.objectContaining({ followup_sms_sent: true }) },
      { table: 'booking_intents', payload: expect.objectContaining({ followup_sms_sent: false }) },
    ]);
  });

  test('terminal block (opted out / landline) keeps the claim — never re-hammered', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SMS_OPTED_OUT', retryable: false });
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim only — no release

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(updates).toEqual([
      { table: 'booking_intents', payload: expect.objectContaining({ followup_sms_sent: true }) },
    ]);
  });

  test('operational block (CONSENT_LOOKUP_FAILED) releases the claim → retried, not burned', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'CONSENT_LOOKUP_FAILED', retryable: false });
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim
    enqueue('booking_intents', { update: 1 }); // release

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(updates).toEqual([
      { table: 'booking_intents', payload: expect.objectContaining({ followup_sms_sent: true }) },
      { table: 'booking_intents', payload: expect.objectContaining({ followup_sms_sent: false }) },
    ]);
  });

  test('lost claim (converted/suppressed between SELECT and UPDATE) → no send', async () => {
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 0 }); // atomic claim affected 0 rows → lost

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('one touch per phone within a run (sentPhones dedup)', async () => {
    const sent = await _internals.runSmsStage(NOW, new Set(['9415550101']));
    // candidate query still runs but the phone is pre-marked → never sends
    expect(sent).toBe(0);
  });
});

describe('runEmailStage (touch 2)', () => {
  test('sends the recovery email and claims the email stage', async () => {
    enqueue('booking_intents', { rows: [intent()] }); // candidates
    enqueue('booking_intents', { update: 1 });         // claim
    enqueue('booking_intents', { update: 1 });         // sibling-mark

    const sent = await _internals.runEmailStage(NOW, new Set());

    expect(sent).toBe(1);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledWith(expect.objectContaining({
      templateKey: 'booking.abandonment_recovery',
      to: 'dana@example.com',
      idempotencyKey: 'booking_recovery_email:bi-1',
      payload: expect.objectContaining({ first_name: 'Dana', service_type: 'Pest Control' }),
    }));
    expect(updates[0]).toEqual({ table: 'booking_intents', payload: expect.objectContaining({ followup_email_sent: true }) });
  });

  test('skips email for a phone already SMS\'d this run (preserves 1h/24h cadence)', async () => {
    enqueue('booking_intents', { rows: [intent()] }); // candidates

    const sent = await _internals.runEmailStage(NOW, new Set(['9415550101']));

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('applies reply-pause to the email touch too (active SMS convo → skip)', async () => {
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: { id: 'm-9' } }); // replied recently

    const sent = await _internals.runEmailStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
  });

  test('skips the recovery email when the customer has email opt-out in prefs', async () => {
    enqueue('booking_intents', { rows: [intent({ customer_id: 'cust-9' })] });
    enqueue('notification_prefs', { first: { email_enabled: false } });

    const sent = await _internals.runEmailStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(updates).toEqual([]); // skipped before claiming
  });

  test('keeps the claim (no retry) when the email address is suppressed', async () => {
    EmailTemplateLibrary.sendTemplate.mockResolvedValue({ blocked: true, reason: 'unsubscribed' });
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('booking_intents', { update: 1 }); // claim only — no release

    const sent = await _internals.runEmailStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(updates).toEqual([
      { table: 'booking_intents', payload: expect.objectContaining({ followup_email_sent: true }) },
    ]);
  });
});
