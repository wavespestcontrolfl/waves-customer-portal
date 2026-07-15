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
  matchAcceptCustomerByPhone: jest.fn(async () => ({ match: null })),
  buildPricingBundle: jest.fn(async () => ({})),
  resolveEstimateQuoteRequirement: jest.fn(() => ({ quoteRequired: false })),
  estimateTrenchingReviewRequired: jest.fn(() => false),
  reconcileFrozenMembershipSnapshot: jest.fn(async () => {}),
  resolveAcceptOneTimeTotal: jest.fn(() => 149),
  commercialAcceptDepositExempt: jest.fn(() => false),
  isCommercialAutoAcceptEstimate: jest.fn(() => false),
}));
jest.mock('../services/estimate-delivery-options', () => ({
  commercialLowConfidenceRange: jest.fn(() => ({ hasLowConfidence: false, forceSiteQuote: false })),
}));
jest.mock('../services/payment-method-consents', () => ({
  findConsentedChargeableCard: jest.fn(async () => null),
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
const { findConsentedChargeableCard } = require('../services/payment-method-consents');
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

// The sends-ledger claim is a raw INSERT ... SELECT gated on
// estimates.archived_at. Claims are recorded here; results come from
// claimResults (default = claim won). Non-claim db.raw calls (COALESCE
// expressions, EXISTS probes) stay pass-through and are never awaited.
const rawClaims = [];
let claimResults;
// Atomic post-send counter bumps (WITH counted AS ... UPDATE estimates).
const rawBumps = [];

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
    show_one_time_option: true,
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
// bump. The raw sends-ledger claim resolves via claimResults (default =
// claim won) unless overridden.
function enqueueHappyPath(est) {
  enqueue('estimate_checkout_events', {}); // distinctOn subquery
  enqueue('estimates', { rows: [est] });
  enqueue('notification_prefs', { first: { email_enabled: true } });
  enqueue('estimates', { update: 1 }); // follow_up_count bump
}

beforeEach(() => {
  jest.clearAllMocks();
  writes.length = 0;
  rawClaims.length = 0;
  rawBumps.length = 0;
  claimResults = [];
  queues = {};
  db.mockImplementation((table) =>
    makeBuilder(table, (queues[table] || []).shift() || {}),
  );
  db.raw.mockImplementation((sql, bindings) => {
    if (typeof sql === 'string' && sql.includes('INSERT INTO estimate_followup_sends')) {
      rawClaims.push({ sql, bindings });
      return Promise.resolve({ rows: claimResults.shift() ?? [{ id: 'send-1' }] });
    }
    if (typeof sql === 'string' && sql.includes('WITH counted AS')) {
      rawBumps.push({ sql, bindings });
      return Promise.resolve({ rowCount: 1 });
    }
    return sql;
  });
  isEnabled.mockReturnValue(true);
  EmailTemplateLibrary.sendTemplate.mockResolvedValue({ sent: true });
  estimatePublic.isEstimateAcceptActive.mockReturnValue(true);
  estimatePublic.isStructuralOneTimeOnlyEstimate.mockReturnValue(false);
  estimatePublic.matchAcceptCustomerByPhone.mockResolvedValue({ match: null });
  estimatePublic.buildPricingBundle.mockResolvedValue({});
  estimatePublic.resolveEstimateQuoteRequirement.mockReturnValue({ quoteRequired: false });
  estimatePublic.estimateTrenchingReviewRequired.mockReturnValue(false);
  estimatePublic.reconcileFrozenMembershipSnapshot.mockResolvedValue(undefined);
  estimatePublic.resolveAcceptOneTimeTotal.mockReturnValue(149);
  estimatePublic.commercialAcceptDepositExempt.mockReturnValue(false);
  estimatePublic.isCommercialAutoAcceptEstimate.mockReturnValue(false);
  findConsentedChargeableCard.mockResolvedValue(null);
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
    // Claim is the raw INSERT ... SELECT gated on archived_at; it carries the
    // trigger snapshot. Success bumps the counters and the ledger row stays
    // (no delete).
    expect(rawClaims).toHaveLength(1);
    expect(rawClaims[0].sql).toContain('archived_at IS NULL');
    // The claim is the final race-closer (codex 2736 r7): an accept flips
    // status without archiving, and expiry can lapse mid-tick — both must
    // block the insert in the same statement.
    expect(rawClaims[0].sql).toContain("status IN ('sent', 'viewed')");
    expect(rawClaims[0].sql).toContain('expires_at IS NULL OR expires_at > now()');
    expect(rawClaims[0].sql).toContain('ON CONFLICT (estimate_id, rule_key) DO NOTHING');
    const [ruleKey, templateKey, triggerJson, estimateId] = rawClaims[0].bindings;
    expect(ruleKey).toBe('payment_step_abandoned');
    expect(templateKey).toBe('estimate.payment_step_abandoned');
    expect(estimateId).toBe('est-1');
    expect(JSON.parse(triggerJson)).toEqual(
      expect.objectContaining({ kind: 'recurring_card' }),
    );
    expect(writes.some((w) => w.table === 'estimate_followup_sends' && w.op === 'del')).toBe(false);
    expect(rawBumps).toHaveLength(1);
    expect(rawBumps[0].bindings).toEqual(['est-1', 'payment_step_abandoned', 'est-1']);
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
    expect(rawClaims).toHaveLength(0);
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

  test('card_hold with a consented saved card skips — the hold is auto-satisfied', async () => {
    findConsentedChargeableCard.mockResolvedValue({ stripe_payment_method_id: 'pm_123' });
    enqueueHappyPath(baseEstimate({ checkout_kind: 'card_hold' }));

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(findConsentedChargeableCard).toHaveBeenCalledWith('cust-1');
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(rawClaims).toHaveLength(0);
  });

  test('card_hold on a customerless estimate resolves the customer by phone before the saved-card check', async () => {
    estimatePublic.matchAcceptCustomerByPhone.mockResolvedValue({ match: { id: 'cust-9' } });
    findConsentedChargeableCard.mockResolvedValue({ stripe_payment_method_id: 'pm_456' });
    enqueueHappyPath(baseEstimate({
      checkout_kind: 'card_hold',
      customer_id: null,
      customer_phone: '+19415550100',
    }));

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(findConsentedChargeableCard).toHaveBeenCalledWith('cust-9');
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('quote-required estimates skip — accept no longer allows self-serve', async () => {
    estimatePublic.resolveEstimateQuoteRequirement.mockReturnValue({ quoteRequired: true });
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(rawClaims).toHaveLength(0);
  });

  test('trenching-review estimates skip — the intent endpoints 409 them', async () => {
    estimatePublic.estimateTrenchingReviewRequired.mockReturnValue(true);
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(rawClaims).toHaveLength(0);
  });

  test('recurring events with no linked customer and no phone skip — accept is phone-keyed', async () => {
    enqueueHappyPath(baseEstimate({ customer_id: null, customer_phone: null }));

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(resolveRecurringCardPolicyForEstimate).not.toHaveBeenCalled();
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(rawClaims).toHaveLength(0);
  });

  test('reconciles the frozen membership snapshot before the policy read, like the endpoints', async () => {
    enqueueHappyPath(baseEstimate());

    await _private.checkPaymentStepAbandoned(NOW);

    expect(estimatePublic.reconcileFrozenMembershipSnapshot).toHaveBeenCalledTimes(1);
    const reconcileOrder = estimatePublic.reconcileFrozenMembershipSnapshot.mock.invocationCallOrder[0];
    const policyOrder = resolveRecurringCardPolicyForEstimate.mock.invocationCallOrder[0];
    expect(reconcileOrder).toBeLessThan(policyOrder);
  });

  test('card_hold on a mixed estimate whose one-time option is gone skips — the endpoint 400s it', async () => {
    enqueueHappyPath(baseEstimate({ checkout_kind: 'card_hold', show_one_time_option: false }));

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(resolveCardHoldPolicy).not.toHaveBeenCalled();
    expect(rawClaims).toHaveLength(0);
  });

  test('card_hold with an unpriced one-time choice skips too', async () => {
    estimatePublic.resolveAcceptOneTimeTotal.mockReturnValue(0);
    enqueueHappyPath(baseEstimate({ checkout_kind: 'card_hold' }));

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(rawClaims).toHaveLength(0);
  });

  test('card_hold with no linked customer and no phone skips — accept cannot bind the booking', async () => {
    enqueueHappyPath(baseEstimate({
      checkout_kind: 'card_hold',
      customer_id: null,
      customer_phone: null,
    }));

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(resolveCardHoldPolicy).not.toHaveBeenCalled();
    expect(rawClaims).toHaveLength(0);
  });

  test('commercial manual-billing exemption skips the recurring nudge', async () => {
    estimatePublic.commercialAcceptDepositExempt.mockReturnValue(true);
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(resolveRecurringCardPolicyForEstimate).not.toHaveBeenCalled();
    expect(rawClaims).toHaveLength(0);
  });

  test('inactive (expired) estimates skip without claiming', async () => {
    estimatePublic.isEstimateAcceptActive.mockReturnValue(false);
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(rawClaims).toHaveLength(0);
  });

  test('policy re-check failure fails CLOSED (no send, no claim)', async () => {
    resolveRecurringCardPolicyForEstimate.mockRejectedValue(new Error('boom'));
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(rawClaims).toHaveLength(0);
  });

  test('lost claim (conflict on the ledger) skips the send', async () => {
    enqueue('estimate_checkout_events', {});
    enqueue('estimates', { rows: [baseEstimate()] });
    enqueue('notification_prefs', { first: { email_enabled: true } });
    claimResults.push([]); // conflict or archived-away: claim returns no row
    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
  });

  test('send failure releases the claim so the next tick retries', async () => {
    EmailTemplateLibrary.sendTemplate.mockRejectedValue(new Error('sendgrid down'));
    enqueueHappyPath(baseEstimate());

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(rawClaims).toHaveLength(1);
    expect(writes.some((w) => w.table === 'estimate_followup_sends' && w.op === 'del')).toBe(true);
    // No success bump.
    expect(rawBumps).toHaveLength(0);
  });

  test('portal email opt-out skips without claiming (email is the only leg)', async () => {
    enqueue('estimate_checkout_events', {});
    enqueue('estimates', { rows: [baseEstimate()] });
    enqueue('notification_prefs', { first: { email_enabled: false } });

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(EmailTemplateLibrary.sendTemplate).not.toHaveBeenCalled();
    expect(rawClaims).toHaveLength(0);
  });

  test('recently-opened estimates are deferred by the safety gate', async () => {
    enqueue('estimate_checkout_events', {});
    enqueue('estimates', {
      rows: [baseEstimate({ last_viewed_at: new Date(NOW.getTime() - 30 * 60000) })],
    });

    const sent = await _private.checkPaymentStepAbandoned(NOW);

    expect(sent).toBe(0);
    expect(rawClaims).toHaveLength(0);
  });
});
