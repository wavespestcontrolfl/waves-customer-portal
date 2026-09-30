/**
 * Abandoned-booking recovery service.
 *
 * Pins the contract: gate-off shadow mode (count, never claim/send),
 * reply-pause skip, the claim + transactional-consent SMS send (touch 1),
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
// Hermetic experiment mock — the real module keys off GROWTHBOOK_CLIENT_KEY in
// the environment; default here = not-in-experiment (today's behavior).
jest.mock('../services/experimentation/growthbook', () => ({
  assignBookingRecoveryExperiment: jest.fn(async () => ({
    inExperiment: false, value: true, variationId: null, variationKey: null,
  })),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplateLibrary = require('../services/email-template-library');
const smsTemplates = require('../routes/admin-sms-templates');
const Experiments = require('../services/experimentation/growthbook');
const { _internals } = require('../services/booking-abandon-recovery');

const updates = [];
function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'leftJoin', 'where', 'whereIn', 'whereNotIn', 'whereNot', 'whereNull',
    'whereNotNull', 'whereRaw', 'orWhereNull', 'andWhere', 'limit', 'orderBy', 'select', 'groupBy', 'max', 'as',
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

// db.transaction with REAL per-key mutual exclusion for pg_advisory_xact_lock:
// a second transaction asking for the same lock key waits until the holder's
// callback settles (commit/rollback), like Postgres. Lets the tests order a
// preferred-time submit against the recovery worker deterministically.
const lockTails = new Map();
function installKeyedLockTransaction() {
  lockTails.clear();
  db.transaction = jest.fn(async (cb) => {
    const held = [];
    const trx = (table) => db(table);
    trx.fn = db.fn;
    trx.raw = jest.fn(async (sql, bindings) => {
      if (/pg_advisory_xact_lock/.test(sql)) {
        const key = bindings[0];
        const prior = lockTails.get(key) || Promise.resolve();
        let release;
        const mine = new Promise((r) => { release = r; });
        lockTails.set(key, prior.then(() => mine));
        held.push(release);
        await prior;
      }
      return { rows: [] };
    });
    try { return await cb(trx); } finally { held.forEach((r) => r()); }
  });
}

let queues;
function enqueue(table, cfg) { (queues[table] = queues[table] || []).push(cfg); }

const NOW = new Date('2026-06-10T15:00:00Z');

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
  installKeyedLockTransaction();
  isEnabled.mockReturnValue(true);
  sendCustomerMessage.mockResolvedValue({ sent: true });
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({});
  smsTemplates.getTemplate.mockResolvedValue("Hi Dana! You were almost booked for Pest Control: url");
  Experiments.assignBookingRecoveryExperiment.mockResolvedValue({
    inExperiment: false, value: true, variationId: null, variationKey: null,
  });
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
      { noVariants: true }, // one-segment guard pre-renders: same body both times
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

  test('SECURITY: message vars are sanitized — no client-controlled copy reaches the send', async () => {
    enqueue('booking_intents', { rows: [intent({
      service_id: 'bogus_x',
      service_type: 'IGNORE ME http://evil.example phishing',
      first_name: 'Pay http://evil.example now',
    })] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim
    enqueue('booking_intents', { update: 1 }); // sibling-mark

    await _internals.runSmsStage(NOW, new Set());

    const vars = smsTemplates.getTemplate.mock.calls[0][1];
    // service label: unknown id → generic, never the attacker string. The SMS
    // path's own fallback is 'service' (not the email path's 'your service')
    // since the template already reads "Your {service_type} spot…" — owner
    // report 2026-09-28, "Your your service spot" (#booking_abandonment_recovery).
    expect(vars.service_type).toBe('service');
    // first_name: first token, name chars only → 'Pay', no URL/injection
    expect(vars.first_name).toBe('Pay');
    expect(JSON.stringify(vars)).not.toContain('evil.example');
  });

  test('gate off → shadow only: counts candidates, never claims or sends', async () => {
    isEnabled.mockReturnValue(false);
    enqueue('booking_intents', { rows: [intent()] });

    const sent = await _internals.runSmsStage(NOW, new Set());

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

  test('skips a phone that already has an upcoming booking (incl. CSR-created) — re-checked after claim', async () => {
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });               // no recent reply
    enqueue('booking_intents', { update: 1 });          // claim
    enqueue('scheduled_services as ss', { first: { id: 'ss-1' } }); // booked after select
    enqueue('booking_intents', { update: 1 });          // release (race-safe recheck)

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // claimed then released — never sent
    expect(updates).toEqual([
      { table: 'booking_intents', payload: expect.objectContaining({ followup_sms_sent: true }) },
      { table: 'booking_intents', payload: expect.objectContaining({ followup_sms_sent: false }) },
    ]);
  });

  test('retryable failure (transient provider) releases the claim so it retries next tick', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: false, code: 'PROVIDER_FAILURE', retryable: true });
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

// Measured-rollout holdback (GrowthBook booking-abandon-recovery): a control
// assignment means NO touches — both stage flags claimed in one update, no
// followup_sms_sent_at stamp (nothing sent). Any assignment miss/failure fails
// open to today's send behavior.
describe('experiment holdback', () => {
  test('control assignment → no SMS, both stage flags claimed, no sent_at stamp', async () => {
    Experiments.assignBookingRecoveryExperiment.mockResolvedValue({
      inExperiment: true, value: false, variationId: 0, variationKey: 'holdback',
    });
    enqueue('booking_intents', { rows: [intent()] }); // candidates
    enqueue('booking_intents', { update: 1 });        // holdback claim

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([{
      table: 'booking_intents',
      payload: expect.objectContaining({ followup_sms_sent: true, followup_email_sent: true }),
    }]);
    expect(updates[0].payload.followup_sms_sent_at).toBeUndefined();
    expect(Experiments.assignBookingRecoveryExperiment).toHaveBeenCalledWith('9415550101', 'bi-1');
  });

  test('control assignment → email stage held back too', async () => {
    Experiments.assignBookingRecoveryExperiment.mockResolvedValue({
      inExperiment: true, value: false, variationId: 0, variationKey: 'holdback',
    });
    enqueue('booking_intents', { rows: [intent()] }); // candidates
    enqueue('booking_intents', { update: 1 });        // holdback claim

    const sent = await _internals.runEmailStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(updates).toEqual([{
      table: 'booking_intents',
      payload: expect.objectContaining({ followup_sms_sent: true, followup_email_sent: true }),
    }]);
  });

  test('treatment assignment → sends exactly as before', async () => {
    Experiments.assignBookingRecoveryExperiment.mockResolvedValue({
      inExperiment: true, value: true, variationId: 1, variationKey: 'recovery-on',
    });
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim
    enqueue('booking_intents', { update: 1 }); // sibling-mark

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(1);
    expect(sendCustomerMessage).toHaveBeenCalled();
  });

  test('assignment failure → fails open to send (never blocks the program)', async () => {
    Experiments.assignBookingRecoveryExperiment.mockRejectedValue(new Error('growthbook down'));
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim
    enqueue('booking_intents', { update: 1 }); // sibling-mark

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(1);
  });
});

// Quote→book handoff through recovery: an intent captured with an HMAC-verified
// pricing estimate reference must re-carry it on the recovery /book link (so the
// recovered booking still prices pay-at-visit); anything unverified/expired/absent
// must produce the plain link. Real token util (no mock) — mint with a test secret.
describe('bookingUrlFor — quote→book handoff re-carry', () => {
  const { mintEstimateHandoffToken } = require('../utils/estimate-handoff-token');
  const EST_ID = '7b6a4a1e-9d0f-4d61-8c0e-2f4f4a9b1c11';
  let prevSecret;
  beforeAll(() => {
    prevSecret = process.env.ESTIMATE_HANDOFF_SECRET;
    process.env.ESTIMATE_HANDOFF_SECRET = 'test-handoff-secret';
  });
  afterAll(() => {
    if (prevSecret === undefined) delete process.env.ESTIMATE_HANDOFF_SECRET;
    else process.env.ESTIMATE_HANDOFF_SECRET = prevSecret;
  });

  test('valid stored handoff → link carries estimate_id + estimate_token', async () => {
    const token = mintEstimateHandoffToken(EST_ID);
    const url = await _internals.bookingUrlFor(intent({
      pricing_estimate_id: EST_ID, pricing_estimate_token: token,
    }));
    expect(url).toContain(`estimate_id=${EST_ID}`);
    expect(url).toContain(`estimate_token=${encodeURIComponent(token)}`);
    expect(url).toContain('service=pest_control');
  });

  test('no stored handoff → plain recovery link', async () => {
    const url = await _internals.bookingUrlFor(intent());
    expect(url).not.toContain('estimate_id=');
    expect(url).not.toContain('estimate_token=');
  });

  test('EXPIRED token → plain link (never send a dead pricing promise)', async () => {
    // Minted 15 days ago — past the 14-day TTL.
    const expired = mintEstimateHandoffToken(EST_ID, Math.floor(Date.now() / 1000) - 15 * 86400);
    const url = await _internals.bookingUrlFor(intent({
      pricing_estimate_id: EST_ID, pricing_estimate_token: expired,
    }));
    expect(url).not.toContain('estimate_id=');
  });

  test('token bound to a DIFFERENT estimate id → plain link (fail closed)', async () => {
    const otherToken = mintEstimateHandoffToken('00000000-0000-4000-8000-000000000000');
    const url = await _internals.bookingUrlFor(intent({
      pricing_estimate_id: EST_ID, pricing_estimate_token: otherToken,
    }));
    expect(url).not.toContain('estimate_id=');
  });
});

describe('B11 backstop — contact-linked wizard draft linked to an ESTABLISHED customer', () => {
  const linked = () => intent({ pricing_estimate_id: 'pe-victim', pricing_estimate_token: 'tok' });
  const gate = (customersOnly) => isEnabled.mockImplementation((name) => (name === 'bookingCustomersOnly' ? customersOnly : true));

  test('SMS: a failed refusal-path suppression write can never lead to a text (send-time re-check)', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] }); // candidates: the un-suppressed row (its suppression write had failed)
    enqueue('messages', { first: null });
    enqueue('estimates', { first: { customer_id: 'cust-1' } });
    enqueue('customers', { first: { pipeline_stage: 'active_customer' } });
    enqueue('booking_intents', { update: 1 }); // best-effort mark

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([{ table: 'booking_intents', payload: expect.objectContaining({ suppressed: true }) }]);
  });

  test('email: same re-check on the second touch', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('estimates', { first: { customer_id: 'cust-1' } });
    enqueue('customers', { first: { pipeline_stage: 'won' } });
    enqueue('booking_intents', { update: 1 });

    const sent = await _internals.runEmailStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('lookup error fails closed — nothing sent, nothing claimed', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('messages', { first: null });
    db.mockImplementation((table) => {
      if (table === 'estimates') throw new Error('db down');
      return makeBuilder(table, (queues[table] || []).shift() || {});
    });

    const sent = await _internals.runSmsStage(NOW, new Set());

    expect(sent).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates).toEqual([]); // no claim, no suppress: retried next tick
  });

  test('r4: classifier flips to ESTABLISHED after the claim → no SMS, claim released, row suppressed', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('messages', { first: null });
    // pre-claim filter: still a lead
    enqueue('estimates', { first: { customer_id: 'cust-1' } });
    enqueue('customers', { first: { id: 'cust-1', pipeline_stage: 'new_lead' } });
    enqueue('customers', { rows: [] }); // account siblings (shared loader's 2nd read)
    enqueue('booking_intents', { update: 1 }); // claim wins
    // scheduled_services active-booking recheck: none (default)
    // last look before send: promoted meanwhile
    enqueue('estimates', { first: { customer_id: 'cust-1' } });
    enqueue('customers', { first: { id: 'cust-1', pipeline_stage: 'won' } });
    enqueue('customers', { rows: [] });
    enqueue('booking_intents', { update: 1 }); // suppress mark

    expect(await _internals.runSmsStage(NOW, new Set())).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const payloads = updates.map((u) => u.payload);
    expect(payloads[0]).toEqual(expect.objectContaining({ followup_sms_sent: true })); // claimed…
    expect(payloads).toEqual(expect.arrayContaining([expect.objectContaining({ suppressed: true })])); // …then suppressed
    expect(payloads[payloads.length - 1]).toEqual(expect.objectContaining({ followup_sms_sent: false })); // claim released
  });

  test('r4: lookup error after the claim → no SMS (fail closed)', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('messages', { first: null });
    enqueue('estimates', { first: { customer_id: 'cust-1' } });
    enqueue('customers', { first: { id: 'cust-1', pipeline_stage: 'new_lead' } });
    enqueue('customers', { rows: [] }); // account siblings (shared loader's 2nd read)
    enqueue('booking_intents', { update: 1 }); // claim wins
    let estimateReads = 0;
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      if (table === 'estimates') {
        estimateReads += 1;
        if (estimateReads === 2) throw new Error('db blip'); // the post-claim last look
      }
      return base(table);
    });

    expect(await _internals.runSmsStage(NOW, new Set())).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('r4: email — classifier flips to ESTABLISHED after the claim → no email', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('estimates', { first: { customer_id: 'cust-1' } });
    enqueue('customers', { first: { id: 'cust-1', pipeline_stage: 'new_lead' } });
    enqueue('customers', { rows: [] }); // account siblings (shared loader's 2nd read)
    enqueue('booking_intents', { update: 1 }); // claim
    enqueue('estimates', { first: { customer_id: 'cust-1' } });
    enqueue('customers', { first: { id: 'cust-1', pipeline_stage: 'active_customer' } });
    enqueue('customers', { rows: [] });
    enqueue('booking_intents', { update: 1 });

    expect(await _internals.runEmailStage(NOW, new Set())).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(updates.map((u) => u.payload)).toEqual(expect.arrayContaining([expect.objectContaining({ suppressed: true })]));
  });

  test('r4: email — lookup error after the claim → no email', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('estimates', { first: { customer_id: 'cust-1' } });
    enqueue('customers', { first: { id: 'cust-1', pipeline_stage: 'new_lead' } });
    enqueue('customers', { rows: [] }); // account siblings (shared loader's 2nd read)
    enqueue('booking_intents', { update: 1 });
    let estimateReads = 0;
    const base = db.getMockImplementation();
    db.mockImplementation((table) => {
      if (table === 'estimates') {
        estimateReads += 1;
        if (estimateReads === 2) throw new Error('db blip');
      }
      return base(table);
    });

    expect(await _internals.runEmailStage(NOW, new Set())).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('account-wide (r3 P1): a lead root row under an account with an ESTABLISHED sibling property is blocked too', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('messages', { first: null });
    enqueue('estimates', { first: { customer_id: 'cust-lead' } });
    enqueue('customers', { first: { id: 'cust-lead', account_id: 'acct-1', pipeline_stage: 'new_lead' } }); // root
    enqueue('customers', { rows: [{ id: 'cust-sibling', account_id: 'acct-1', pipeline_stage: 'active_customer' }] }); // siblings
    enqueue('booking_intents', { update: 1 });

    expect(await _internals.runSmsStage(NOW, new Set())).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('r5: an ARCHIVED linked customer row blocks (archiving must not unblock the backstop)', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('messages', { first: null });
    enqueue('estimates', { first: { customer_id: 'cust-1' } });
    enqueue('customers', { first: { id: 'cust-1', pipeline_stage: 'new_lead', deleted_at: '2026-09-01T00:00:00Z' } });
    enqueue('customers', { rows: [] });
    enqueue('booking_intents', { update: 1 });

    expect(await _internals.runSmsStage(NOW, new Set())).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('r5: an ARCHIVED sibling on the account blocks', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('messages', { first: null });
    enqueue('estimates', { first: { customer_id: 'cust-1' } });
    enqueue('customers', { first: { id: 'cust-1', account_id: 'acct-1', pipeline_stage: 'new_lead' } });
    enqueue('customers', { rows: [{ id: 'sib', account_id: 'acct-1', pipeline_stage: 'new_lead', deleted_at: '2026-09-01T00:00:00Z' }] });
    enqueue('booking_intents', { update: 1 });

    expect(await _internals.runSmsStage(NOW, new Set())).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('r5: a draft whose customer row is MISSING blocks (fail closed)', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('messages', { first: null });
    enqueue('estimates', { first: { customer_id: 'cust-gone' } });
    enqueue('customers', { first: undefined }); // no such row
    enqueue('booking_intents', { update: 1 });

    expect(await _internals.runSmsStage(NOW, new Set())).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('draft linked to a still-pre-customer lead (the quoter\'s own row) sends as before', async () => {
    gate(true);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('messages', { first: null });
    enqueue('estimates', { first: { customer_id: 'cust-lead' } });
    enqueue('customers', { first: { pipeline_stage: 'new_lead' } });
    enqueue('booking_intents', { update: 1 });
    enqueue('booking_intents', { update: 1 });

    expect(await _internals.runSmsStage(NOW, new Set())).toBe(1);
  });

  test('gate OFF: the flow still books, so recovery is untouched (no lookup at all)', async () => {
    gate(false);
    enqueue('booking_intents', { rows: [linked()] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 });
    enqueue('booking_intents', { update: 1 });

    expect(await _internals.runSmsStage(NOW, new Set())).toBe(1);
    expect(db.mock.calls.map((c) => c[0])).not.toContain('estimates');
  });
});

// A preferred-time submit ("Can't find a time?") and the recovery worker share
// ONE per-phone lock (booking-preferred-time.js). The worker holds it across its
// final preferred-time re-check AND the send, so a submit can never land between
// the last look and the dispatch.
describe('preferred-time submit vs the recovery send (per-phone lock)', () => {
  const { withPreferredTimePhoneLock } = require('../services/booking-preferred-time');
  const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };
  const tick = () => new Promise((r) => setTimeout(r, 15));

  function wireLeadsLookup(state) {
    db.mockImplementation((table) => makeBuilder(table, table === 'leads'
      ? { first: state.leadFiled ? { id: 'lead-1' } : undefined }
      : (queues[table] || []).shift() || {}));
  }

  test('a submit that commits first: the worker\'s final check sees it and sends NOTHING (sms)', async () => {
    const state = { leadFiled: false };
    wireLeadsLookup(state);
    const submitGate = gate();
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim

    // The submit takes the lock, is mid-flight, then commits the lead.
    const submit = withPreferredTimePhoneLock(db, '+19415550101', async () => {
      await submitGate.p;
      state.leadFiled = true; // "commit"
    });
    await tick();
    const worker = _internals.runSmsStage(NOW, new Set());
    await tick();
    expect(sendCustomerMessage).not.toHaveBeenCalled(); // worker is parked on the lock
    submitGate.open();
    await submit;
    expect(await worker).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a worker that is already dispatching: the submit waits for the send to finish, then proceeds (the send counts as already happened)', async () => {
    const state = { leadFiled: false };
    wireLeadsLookup(state);
    const sendGate = gate();
    const order = [];
    sendCustomerMessage.mockImplementation(async () => { order.push('send-start'); await sendGate.p; order.push('send-end'); return { sent: true }; });
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim
    enqueue('booking_intents', { update: 1 }); // sibling mark

    const worker = _internals.runSmsStage(NOW, new Set());
    await tick();
    expect(order).toEqual(['send-start']);
    // The submit arrives mid-send and cannot enter its critical section.
    const submit = withPreferredTimePhoneLock(db, '+19415550101', async () => { order.push('submit'); state.leadFiled = true; });
    await tick();
    expect(order).toEqual(['send-start']);
    sendGate.open();
    expect(await worker).toBe(1);
    await submit;
    expect(order).toEqual(['send-start', 'send-end', 'submit']);
  });

  test('email channel: same lock — a submit that commits first blocks the email', async () => {
    const state = { leadFiled: false };
    wireLeadsLookup(state);
    const submitGate = gate();
    enqueue('booking_intents', { rows: [intent({ last_activity_at: new Date('2026-06-09T13:00:00Z'), captured_at: new Date('2026-06-09T13:00:00Z') })] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim
    const submit = withPreferredTimePhoneLock(db, '+19415550101', async () => { await submitGate.p; state.leadFiled = true; });
    await tick();
    const worker = _internals.runEmailStage(NOW, new Set());
    await tick();
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    submitGate.open();
    await submit;
    expect(await worker).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('a lock/transaction failure means nothing is sent and the claim is released for the next tick', async () => {
    db.transaction = jest.fn(async () => { throw new Error('lock unavailable'); });
    enqueue('booking_intents', { rows: [intent()] });
    enqueue('messages', { first: null });
    enqueue('booking_intents', { update: 1 }); // claim
    enqueue('booking_intents', { update: 1 }); // release
    expect(await _internals.runSmsStage(NOW, new Set())).toBe(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(updates.some((u) => u.payload && u.payload.followup_sms_sent === false)).toBe(true);
  });

  test('the submit path takes the very same lock (one chokepoint, one key)', () => {
    const svc = require('fs').readFileSync(require('path').join(__dirname, '../services/booking-preferred-time.js'), 'utf8');
    expect((svc.match(/book_preferred_time:\$\{phone\}/g) || []).length).toBe(1);
    expect(svc).toMatch(/await lockPhone\(trx, value\.phone\)/);
    expect(svc).toMatch(/await lockPhone\(trx, ten\)/);
  });
});
