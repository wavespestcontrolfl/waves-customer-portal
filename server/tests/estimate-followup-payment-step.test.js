/**
 * Estimate follow-up stage 6: reached the save-a-card step but never
 * accepted (payment_step_abandoned).
 *
 * Pins the contract: gate-off shadow mode (count, never claim, never send),
 * the fail-closed "card still required" policy re-check (recurring vs
 * card-hold lane routed by the event's kind), email-only delivery (never
 * SMS), the estimate_followup_sends ledger row as the atomic claim with
 * delete-on-failure release, and the notification_prefs opt-out skip.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((expr) => expr);
  mockDb.fn = { now: jest.fn(() => 'NOW()') };
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true })),
  redactEmailAddresses: (s) => String(s || ''),
}));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async (url) => url),
}));
jest.mock('../routes/admin-sms-templates', () => ({
  getTemplate: jest.fn(async () => null),
}));
jest.mock('../services/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../services/estimate-service-lines', () => ({
  inferEstimateServiceInterest: jest.fn(() => ''),
}));
jest.mock('../services/estimate-deposits', () => ({
  assessDepositFollowUpEligibility: jest.fn(async () => ({ eligible: false })),
  DEPOSIT_FOLLOWUP_WINDOW: { minAgeHours: 2, maxAgeHours: 72 },
}));
jest.mock('../services/estimate-conversion-guard', () => ({
  customerConvertedSince: jest.fn(async () => ({ converted: false })),
}));
jest.mock('../services/estimate-lead-linkage', () => ({
  leadIdForEstimate: jest.fn(async () => null),
}));
// Lazy-required inside paymentStepStillRequiresCard — mocking the route
// module keeps the 15k-line router out of the test process entirely.
jest.mock('../routes/estimate-public', () => ({
  isEstimateAcceptActive: jest.fn(() => true),
  isStructuralOneTimeOnlyEstimate: jest.fn(() => false),
  resolveEstimateInvoiceMode: jest.fn(() => false),
}));
jest.mock('../services/recurring-card-on-file', () => ({
  resolveRecurringCardPolicyForEstimate: jest.fn(async () => ({ required: true })),
}));
jest.mock('../services/estimate-card-holds', () => ({
  resolveCardHoldPolicy: jest.fn(() => ({ required: true })),
}));
jest.mock('../services/estimate-membership-context', () => ({
  buildEstimateMembershipContext: jest.fn(async () => ({})),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailTemplateLibrary = require('../services/email-template-library');
const logger = require('../services/logger');
const estimatePublic = require('../routes/estimate-public');
const { resolveRecurringCardPolicyForEstimate } = require('../services/recurring-card-on-file');
const { resolveCardHoldPolicy } = require('../services/estimate-card-holds');
const { _private } = require('../services/estimate-follow-up');

// Chainable knex-builder stub. Chain methods return the builder; awaiting it
// resolves by mode: insert → cfg.insert (claim result rows), del → cfg.del,
// update → cfg.update, first → cfg.first, else cfg.rows. Inserts/updates/
// deletes are recorded for assertions.
const writes = [];
function makeBuilder(table, cfg = {}) {
  const b = {};
  for (const m of [
    'join', 'whereIn', 'whereNotIn', 'whereNotNull', 'whereNull', 'whereNot',
    'where', 'select', 'groupBy', 'max', 'as', 'orderBy', 'orWhereNull',
    'andWhere', 'distinctOn', 'whereNotExists', 'whereRaw', 'whereBetween',
    'onConflict', 'ignore', 'merge', 'returning',
  ]) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(() => {
    b._mode = 'first';
    return b;
  });
  b.insert = jest.fn((payload) => {
    b._mode = 'insert';
    writes.push({ table, op: 'insert', payload });
    return b;
  });
  b.update = jest.fn((payload) => {
    b._mode = 'update';
    writes.push({ table, op: 'update', payload });
    return b;
  });
  b.del = jest.fn(() => {
    b._mode = 'del';
    writes.push({ table, op: 'del' });
    return b;
  });
  b.then = (resolve, reject) => {
    const value =
      b._mode === 'insert' ? (cfg.insert ?? [{ id: 'send-1' }])
        : b._mode === 'del' ? (cfg.del ?? 1)
          : b._mode === 'update' ? (cfg.update ?? 1)
            : b._mode === 'first' ? cfg.first
              : (cfg.rows ?? []);
    return Promise.resolve(value).then(resolve, reject);
  };
  return b;
}

let queues;
function enqueue(table, cfg) {
  (queues[table] = queues[table] || []).push(cfg);
}

const NOW = new Date('2026-06-10T15:00:00Z');

function baseEstimate(overrides = {}) {
  return {
    id: 'est-1',
    status: 'viewed',
    customer_id: 'cust-1',
    customer_name: 'Taylor Doe',
    customer_phone: null,
    customer_email: 'taylor@example.com',
    token: 'tok-xyz',
    viewed_at: new Date('2026-06-09T10:00:00Z'),
    last_viewed_at: new Date('2026-06-09T10:00:00Z'),
    created_at: new Date('2026-06-08T15:00:00Z'),
    checkout_kind: 'recurring_card',
    checkout_last_touch_at: new Date('2026-06-10T09:00:00Z'),
    ...overrides,
  };
}

// Standard happy-path queue: checkout-events subquery builder (never
// awaited — it's passed to join), candidate list, prefs lookup, success
// bump. The estimate_followup_sends claim insert resolves via the builder's
// insert default ([one row] = claim won) unless overridden.
function enqueueHappyPath(est) {
  enqueue('estimate_checkout_events', {}); // distinctOn subquery
  enqueue('estimates', { rows: [est] });
  enqueue('notification_prefs', { first: { email_enabled: true } });
  enqueue('estimates', { update: 1 }); // follow_up_count bump
}

beforeEach(() => {
  jest.clearAllMocks();
  writes.length = 0;
  queues = {};
  db.mockImplementation((table) =>
    makeBuilder(table, (queues[table] || []).shift() || {}),
  );
  isEnabled.mockReturnValue(true);
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
  estimatePublic.isEstimateAcceptActive.mockReturnValue(true);
  estimatePublic.isStructuralOneTimeOnlyEstimate.mockReturnValue(false);
  resolveRecurringCardPolicyForEstimate.mockResolvedValue({ required: true });
  resolveCardHoldPolicy.mockReturnValue({ required: true });
});

describe('checkPaymentStepAbandoned', () => {
  test('sends the email, claims via the sends ledger, never sends SMS', async () => {
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(1);
    expect(isEnabled).toHaveBeenCalledWith('paymentStepFollowup');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledTimes(1);
    expect(EmailTemplateLibrary.sendTemplate).toHaveBeenCalledWith(
      expect.objectContaining({
        templateKey: 'estimate.payment_step_abandoned',
        to: 'taylor@example.com',
        idempotencyKey: 'estimate_followup_payment_step:est-1',
        categories: ['estimate_followup', 'estimate_followup_payment_step'],
        payload: expect.objectContaining({
          first_name: 'Taylor',
          estimate_url: 'https://portal.wavespestcontrol.com/estimate/tok-xyz',
        }),
      }),
    );
    // Claim row carries the trigger snapshot; success bumps the counters and
    // the ledger row stays (no delete).
    const claim = writes.find((w) => w.table === 'estimate_followup_sends' && w.op === 'insert');
    expect(claim.payload).toEqual(
      expect.objectContaining({
        estimate_id: 'est-1',
        rule_key: 'payment_step_abandoned',
        template_key: 'estimate.payment_step_abandoned',
      }),
    );
    expect(JSON.parse(claim.payload.trigger)).toEqual(
      expect.objectContaining({ kind: 'recurring_card' }),
    );
    expect(writes.some((w) => w.table === 'estimate_followup_sends' && w.op === 'del')).toBe(false);
    expect(writes.some((w) => w.table === 'estimates' && w.op === 'update')).toBe(true);
  });

  test('gate off = shadow: counts candidates, never claims or sends', async () => {
    isEnabled.mockReturnValue(false);
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Payment-step shadow: 1 candidate(s)'),
    );
  });

  test('skips without claiming when the recurring policy no longer requires a card', async () => {
    resolveRecurringCardPolicyForEstimate.mockResolvedValue({ required: false });
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(writes.some((w) => w.table === 'estimate_followup_sends')).toBe(false);
  });

  test('card_hold events re-check the HOLD policy, not the recurring one', async () => {
    enqueueHappyPath(baseEstimate({ checkout_kind: 'card_hold' }));

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(1);
    expect(resolveCardHoldPolicy).toHaveBeenCalledWith(
      expect.objectContaining({ treatAsOneTime: true }),
    );
    expect(resolveRecurringCardPolicyForEstimate).not.toHaveBeenCalled();
  });

  test('inactive (expired) estimates skip without claiming', async () => {
    estimatePublic.isEstimateAcceptActive.mockReturnValue(false);
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(writes.some((w) => w.table === 'estimate_followup_sends')).toBe(false);
  });

  test('policy re-check failure fails CLOSED (no send, no claim)', async () => {
    resolveRecurringCardPolicyForEstimate.mockRejectedValue(new Error('boom'));
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(writes.some((w) => w.table === 'estimate_followup_sends')).toBe(false);
  });

  test('lost claim (conflict on the ledger) skips the send', async () => {
    enqueue('estimate_checkout_events', {});
    enqueue('estimates', { rows: [baseEstimate()] });
    enqueue('notification_prefs', { first: { email_enabled: true } });
    enqueue('estimate_followup_sends', { insert: [] }); // conflict: another cron won
    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('send failure releases the claim so the next tick retries', async () => {
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(new Error('sendgrid down'));
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(writes.some((w) => w.table === 'estimate_followup_sends' && w.op === 'insert')).toBe(true);
    expect(writes.some((w) => w.table === 'estimate_followup_sends' && w.op === 'del')).toBe(true);
    // No success bump.
    expect(writes.some((w) => w.table === 'estimates' && w.op === 'update')).toBe(false);
  });

  test('portal email opt-out skips without claiming (email is the only leg)', async () => {
    enqueue('estimate_checkout_events', {});
    enqueue('estimates', { rows: [baseEstimate()] });
    enqueue('notification_prefs', { first: { email_enabled: false } });

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(writes.some((w) => w.table === 'estimate_followup_sends')).toBe(false);
  });

  test('recently-opened estimates are deferred by the safety gate', async () => {
    enqueue('estimate_checkout_events', {});
    enqueue('estimates', {
      rows: [baseEstimate({ last_viewed_at: new Date(NOW.getTime() - 30 * 60000) })],
    });

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(writes.some((w) => w.table === 'estimate_followup_sends')).toBe(false);
  });
});
