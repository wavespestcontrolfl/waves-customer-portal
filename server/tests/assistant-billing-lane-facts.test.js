/**
 * The billing-lane FACT the customer-facing assistant surfaces depend on.
 *
 * The house voice permits a monthly amount only when the account facts say the
 * lane is monthly membership — a rule that was enforced for a long time
 * without anything ever producing that fact, so the exception it protects was
 * unreachable and every genuine monthly member was deferred to the office.
 *
 * These pin the three halves that have to agree: the fact must CARRY the
 * amount it authorizes (the MONEY rule forbids computing or inventing
 * figures, so a lane that says "state it plainly" without the number just
 * produces a deferral), that amount must be what the account is ACTUALLY
 * charged (the raw rate is only the base — a confirmed-credit card on file
 * pays that base plus the surcharge stripe.charge adds), and no surface may
 * still restrict the exception to an explicitly owner-set lane —
 * resolveBillingLane's NULL-mode inference is the same rule MONTHLY_LANE_SQL
 * uses to select who the dues cron charges.
 */

const fs = require('fs');
const path = require('path');

const { buildFactsBlock } = require('../services/sms-shadow-drafter');
const { resolveBillingLaneFacts, resolveMonthlyDuesFact } = require('../services/context-aggregator');

const drafter = fs.readFileSync(path.join(__dirname, '../services/sms-shadow-drafter.js'), 'utf8');
const agent = fs.readFileSync(path.join(__dirname, '../services/ai-assistant/managed-agent-config.js'), 'utf8');

const CREDIT_CARD = { method_type: 'card', card_funding: 'credit' };
const DEBIT_CARD = { method_type: 'card', card_funding: 'debit' };
const UNRESOLVED_CARD = { method_type: 'card', card_funding: null };
const BANK = { method_type: 'us_bank_account', card_funding: null };

const factsFor = (billingLane) => buildFactsBlock({ customer: { billingLane } });

describe('the monthly dues fact is what the account is actually charged', () => {
  test('a confirmed-credit card carries BOTH the dues and the surcharged total', () => {
    // chargeMonthly hands monthly_rate to stripe.charge, where
    // computeChargeAmount adds the credit-card surcharge — quoting the base
    // as the charge contradicted the PaymentIntent and the payment row.
    const dues = resolveMonthlyDuesFact({ monthlyRate: 98.5, autopayOn: true, method: CREDIT_CARD });
    expect(dues.base).toBe(98.5);
    expect(dues.surcharged).toBe(true);
    // 2.90% of $98.50, floored to the cent by the pricing authority.
    expect(dues.surcharge).toBe(2.85);
    expect(dues.total).toBe(101.35);
  });

  test('debit and bank methods pay the dues exactly — no surcharge', () => {
    for (const method of [DEBIT_CARD, BANK]) {
      const dues = resolveMonthlyDuesFact({ monthlyRate: 98.5, autopayOn: true, method });
      expect(dues.surcharged).toBe(false);
      expect(dues.total).toBe(98.5);
      expect(dues.basis).toBe('no_surcharge');
    }
  });

  test('a card whose funding was never resolved states NO total', () => {
    // stripe.charge backfills card_funding from Stripe at charge time and
    // surcharges if it comes back credit — the total is genuinely unknown
    // here, so the fact withholds it rather than implying dues == charge.
    const dues = resolveMonthlyDuesFact({ monthlyRate: 98.5, autopayOn: true, method: UNRESOLVED_CARD });
    expect(dues.base).toBe(98.5);
    expect(dues.total).toBeNull();
    expect(dues.surcharged).toBe(false);
    expect(dues.basis).toBe('unknown_funding');
  });

  test('without active autopay nothing auto-charges, but the dues are still real', () => {
    // billing-cron GUARD 1 skips the account entirely; the office bills it.
    for (const args of [{ autopayOn: false, method: CREDIT_CARD }, { autopayOn: true, method: null }]) {
      const dues = resolveMonthlyDuesFact({ monthlyRate: 45, ...args });
      expect(dues.base).toBe(45);
      expect(dues.total).toBeNull();
      expect(dues.basis).toBe('no_autopay');
    }
  });

  test('an unpriced rate produces no dues fact at all', () => {
    for (const monthlyRate of [0, null, undefined, -5]) {
      expect(resolveMonthlyDuesFact({ monthlyRate, autopayOn: true, method: CREDIT_CARD })).toBeNull();
    }
  });
});

describe('an unpriced membership is never described as monthly-billed', () => {
  test('explicit monthly_membership with no rate reads as unpriced, not as dues', () => {
    // The dues cron selects monthly_rate > 0 and chargeMonthly refuses a
    // non-positive rate, so NO monthly charge can run for this row.
    const lane = resolveBillingLaneFacts({ billing_mode: 'monthly_membership', monthly_rate: 0 });
    expect(lane.monthlyBilled).toBe(false);
    expect(lane.label).toMatch(/UNPRICED/);
    expect(lane.label).toMatch(/never state a monthly amount/i);
    expect(resolveBillingLaneFacts({ billing_mode: 'monthly_membership', monthly_rate: null }).monthlyBilled).toBe(false);
  });

  test('a priced membership is still monthly-billed', () => {
    const lane = resolveBillingLaneFacts({ billing_mode: 'monthly_membership', monthly_rate: 98.5 });
    expect(lane.monthlyBilled).toBe(true);
    expect(lane.shortLabel).toBe('monthly membership');
  });

  test('the lane fact never derives the amount itself', () => {
    // What a member is actually charged depends on the method the charge will
    // run against, which needs a query — a sync caller must fail closed to no
    // amount rather than reaching for the raw rate.
    expect(resolveBillingLaneFacts({ billing_mode: 'monthly_membership', monthly_rate: 98.5 }).monthlyDues).toBeNull();
  });
});

describe('the drafter facts block publishes only what was resolved', () => {
  test('a surcharged member gets both exact figures and is told not to add them', () => {
    const facts = factsFor({
      monthlyBilled: true,
      label: 'MONTHLY MEMBERSHIP — dues are charged monthly',
      monthlyDues: { base: 98.5, surcharge: 2.85, total: 101.35, surcharged: true, basis: 'credit_card_surcharge' },
    });
    expect(facts).toContain('Monthly dues: $98.50 per month');
    expect(facts).toContain('$101.35');
    expect(facts).toMatch(/never add them up yourself/i);
  });

  test('an unresolved funding publishes the dues and forbids a charge total', () => {
    const facts = factsFor({
      monthlyBilled: true,
      label: 'MONTHLY MEMBERSHIP — dues are charged monthly',
      monthlyDues: { base: 98.5, surcharge: 0, total: null, surcharged: false, basis: 'unknown_funding' },
    });
    expect(facts).toContain('Monthly dues: $98.50 per month');
    expect(facts).toMatch(/never a charge total/i);
    // No invented total anywhere in the block.
    expect(facts).not.toMatch(/\$10[0-9]\.\d{2}/);
  });

  test('a non-monthly lane and an unpriced membership publish no dues line', () => {
    // For every other lane the stored rate is an artifact nobody is charged.
    expect(factsFor({ monthlyBilled: false, label: 'PER APPLICATION', monthlyDues: null }))
      .not.toMatch(/Monthly dues/);
    // Even a stray dues object cannot leak through a lane that isn't monthly.
    expect(factsFor({
      monthlyBilled: false,
      label: 'MONTHLY MEMBERSHIP BUT UNPRICED',
      monthlyDues: { base: 98.5, surcharge: 0, total: null, surcharged: false, basis: 'no_autopay' },
    })).not.toMatch(/Monthly dues/);
  });

  test('a caller with no lane fact at all still fails closed', () => {
    const facts = buildFactsBlock({});
    expect(facts).toMatch(/Billing lane: not stated/);
    expect(facts).not.toMatch(/Monthly dues/);
  });
});

describe('the amounts the facts publish are the amounts the guard authorizes', () => {
  test('the deterministic whitelist admits the dues published above it', () => {
    // Built from balances, invoices and payments only, the whitelist marked
    // the dues figure the facts block had just published as ungrounded and
    // held every monthly-lane draft in shadow — making the exception this
    // fact exists to reach unreachable on the suggestion/auto-send path.
    expect(drafter).toContain('context.customer?.billingLane?.monthlyBilled');
    expect(drafter).toContain('laneDues ? centsOf(laneDues.base) : null');
    expect(drafter).toContain('laneDues?.surcharged && laneDues.total != null ? centsOf(laneDues.total) : null');
  });

  test('the published dues come from the priced fact, never the raw rate', () => {
    expect(drafter).toContain('const dues = lane?.monthlyBilled ? lane.monthlyDues : null');
    expect(drafter).not.toContain('context.customer.monthlyRate).toFixed');
  });
});

describe('no surface still restricts the exception to an EXPLICIT lane', () => {
  test('the house voice and both tool descriptions agree', () => {
    // The house voice and BOTH tool descriptions have to agree, or the model
    // is told to withhold a real price the account fact just authorized. This
    // pins the AGREEMENT rather than the individual call sites: a third
    // description added later that reintroduced the qualifier fails here.
    expect(agent).not.toMatch(/explicit monthly-membership/);
    const toolDescriptions = agent.match(/description: `[^`]*monthly rate[^`]*`/g) || [];
    expect(toolDescriptions.length).toBe(2);
    for (const desc of toolDescriptions) {
      expect(desc).toMatch(/Billing lane/);
      expect(desc).toMatch(/owner-set or inferred/);
    }
  });
});
