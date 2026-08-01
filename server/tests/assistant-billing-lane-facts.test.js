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
const {
  resolveBillingLaneFacts,
  resolveMonthlyDuesFact,
  resolveDuesCollectionState,
  authorizedDuesCents,
} = require('../services/context-aggregator');

const drafter = fs.readFileSync(path.join(__dirname, '../services/sms-shadow-drafter.js'), 'utf8');
const scheduler = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
const agent = fs.readFileSync(path.join(__dirname, '../services/ai-assistant/managed-agent-config.js'), 'utf8');

const CREDIT_CARD = { method_type: 'card', card_funding: 'credit' };
const DEBIT_CARD = { method_type: 'card', card_funding: 'debit' };
const UNRESOLVED_CARD = { method_type: 'card', card_funding: null };
const BANK = { method_type: 'us_bank_account', card_funding: null };

const duesFor = (methods, monthlyRate = 98.5) =>
  resolveMonthlyDuesFact({ monthlyRate, collection: 'active', methods });
const factsFor = (billingLane) => buildFactsBlock({ customer: { billingLane } });

describe('the monthly dues fact is what the account is actually charged', () => {
  test('a confirmed-credit card carries BOTH the dues and the surcharged total', () => {
    // chargeMonthly hands monthly_rate to stripe.charge, where
    // computeChargeAmount adds the credit-card surcharge — quoting the base
    // as the charge contradicted the PaymentIntent and the payment row.
    const dues = duesFor([CREDIT_CARD]);
    expect(dues.base).toBe(98.5);
    expect(dues.surcharged).toBe(true);
    // 2.90% of $98.50, floored to the cent by the pricing authority.
    expect(dues.surcharge).toBe(2.85);
    expect(dues.total).toBe(101.35);
  });

  test('debit and bank methods pay the dues exactly — no surcharge', () => {
    for (const method of [DEBIT_CARD, BANK]) {
      const dues = duesFor([method]);
      expect(dues.surcharged).toBe(false);
      expect(dues.total).toBe(98.5);
      expect(dues.basis).toBe('no_surcharge');
    }
  });

  test('a card whose funding was never resolved states NO total', () => {
    // stripe.charge backfills card_funding from Stripe at charge time and
    // surcharges if it comes back credit — the total is genuinely unknown
    // here, so the fact withholds it rather than implying dues == charge.
    const dues = duesFor([UNRESOLVED_CARD]);
    expect(dues.base).toBe(98.5);
    expect(dues.total).toBeNull();
    expect(dues.surcharged).toBe(false);
    expect(dues.basis).toBe('unknown_funding');
  });

  test('candidates that price differently withhold the total entirely', () => {
    // stripe.charge honors the enrollment pointer first and falls back to the
    // default row, so pricing one of them could publish a total the other
    // never charges. Agreement is the only safe answer.
    const dues = duesFor([CREDIT_CARD, DEBIT_CARD]);
    expect(dues.base).toBe(98.5);
    expect(dues.total).toBeNull();
    expect(dues.basis).toBe('method_ambiguous');
    // Candidates that AGREE still publish — a pointer that merely duplicates
    // the default row is the ordinary case and must not withhold.
    expect(duesFor([CREDIT_CARD, { ...CREDIT_CARD, id: 'other' }]).total).toBe(101.35);
    expect(duesFor([DEBIT_CARD, BANK]).total).toBe(98.5);
  });

  test('no candidate method at all withholds the total', () => {
    for (const methods of [[], null, undefined]) {
      const dues = duesFor(methods);
      expect(dues.total).toBeNull();
      expect(dues.basis).toBe('method_unknown');
    }
  });

  test('a suppressed collection publishes the dues and no charge', () => {
    // Each of these is a population the monthly cron skips — the dues are
    // still the plan price, but no charge is running to describe.
    for (const collection of [
      'autopay_off', 'autopay_paused', 'service_paused', 'account_inactive',
      'annual_prepay_covered', 'annual_prepay_pending', 'unknown',
    ]) {
      const dues = resolveMonthlyDuesFact({ monthlyRate: 45, collection, methods: [CREDIT_CARD] });
      expect(dues.base).toBe(45);
      expect(dues.total).toBeNull();
      expect(dues.surcharged).toBe(false);
      expect(dues.basis).toBe(collection);
    }
  });

  test('an unpriced rate produces no dues fact at all', () => {
    for (const monthlyRate of [0, null, undefined, -5]) {
      expect(resolveMonthlyDuesFact({ monthlyRate, collection: 'active', methods: [CREDIT_CARD] })).toBeNull();
    }
  });
});

describe('active autopay is not proof a dues charge is running', () => {
  const ON = { on: true, paused: false };

  test('a service-paused account is never even loaded by the cron', async () => {
    expect(await resolveDuesCollectionState({ id: 'c1', active: true, service_paused_at: new Date() }, ON))
      .toBe('service_paused');
  });

  test('inactive and deleted accounts are outside the cron SELECT too', async () => {
    // active: true and deleted_at IS NULL are part of the same WHERE as the
    // pause columns, and this context can resolve a row that fails either.
    expect(await resolveDuesCollectionState({ id: 'c1', active: false }, ON)).toBe('account_inactive');
    expect(await resolveDuesCollectionState({ id: 'c1', active: true, deleted_at: new Date() }, ON)).toBe('account_inactive');
  });

  test('a NULL active column is outside it as well', async () => {
    // customers.active is nullable and the cron matches `active = true`, so a
    // legacy import with NULL there is never charged — testing === false let
    // exactly those rows publish a charge (codex #3141 r4).
    expect(await resolveDuesCollectionState({ id: 'c1', active: null }, ON)).toBe('account_inactive');
    expect(await resolveDuesCollectionState({ id: 'c1' }, ON)).toBe('account_inactive');
  });

  test('a paused autopay is its own state, not "the office bills it"', async () => {
    // The cron logs skipped_paused and moves on: nothing is invoiced, and
    // collection resumes on its own when the pause lifts.
    expect(await resolveDuesCollectionState({ id: 'c1', active: true }, { on: false, paused: true }))
      .toBe('autopay_paused');
  });

  test('autopay off is distinct from paused', async () => {
    expect(await resolveDuesCollectionState({ id: 'c1', active: true }, { on: false, paused: false }))
      .toBe('autopay_off');
  });

  test('an unreadable autopay state never claims a collection', async () => {
    // Ahead of every account gate: eligibility itself could not be read.
    expect(await resolveDuesCollectionState({ id: 'c1', active: true }, null)).toBe('unknown');
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

describe('"already paid for the year" is a claim about coverage, not the lane', () => {
  const annualLane = (annualCoverage) =>
    resolveBillingLaneFacts({ billing_mode: 'annual_prepay', waveguard_tier: 'Gold', monthly_rate: 90 }, annualCoverage);

  test('only live coverage supports the paid-up claim', () => {
    const lane = annualLane('covered');
    expect(lane.label).toMatch(/already paid up front for the year/i);
    expect(lane.annualCoverage).toBe('covered');
  });

  test('an expired or renewal-pending term never claims the year is paid', () => {
    // The customer keeps billing_mode 'annual_prepay' after a term ends
    // naturally — the renewal flow owns collection from there — so the lane
    // alone cannot support the claim, and an open renewal invoice sits in the
    // very same facts block.
    const lane = annualLane('not_covered');
    expect(lane.label).not.toMatch(/already paid/i);
    expect(lane.label).toMatch(/COVERAGE NOT CURRENT/);
    expect(lane.monthlyBilled).toBe(false);
  });

  test('unconfirmed coverage fails closed to the same no-claim wording', () => {
    for (const coverage of ['unknown', undefined, 'nonsense']) {
      const lane = annualLane(coverage);
      expect(lane.label).not.toMatch(/already paid/i);
      expect(lane.label).toMatch(/never say they are paid up for the year/i);
    }
  });

  test('the coverage marker is only carried on the annual lane', () => {
    expect(resolveBillingLaneFacts({ billing_mode: 'per_application' }, 'covered').annualCoverage).toBeNull();
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

  test('a suppressed collection names its own reason, never an office bill', () => {
    // "the office bills these dues" was a promise nobody keeps: the cron logs
    // skipped_paused and moves on, and no invoice is cut.
    const paused = factsFor({
      monthlyBilled: true,
      label: 'MONTHLY MEMBERSHIP — dues are charged monthly',
      monthlyDues: { base: 98.5, surcharge: 0, total: null, surcharged: false, basis: 'autopay_paused' },
    });
    expect(paused).toContain('Monthly dues: $98.50 per month');
    expect(paused).toMatch(/Autopay is paused/);
    expect(paused).not.toMatch(/office bills/);
    for (const [basis, phrase] of [
      ['service_paused', /Billing on this account is paused/],
      ['account_inactive', /account is not active/],
      ['annual_prepay_pending', /annual-prepay invoice is open/],
      ['annual_prepay_covered', /Annual prepay coverage is active/],
      ['method_ambiguous', /More than one saved method/],
      ['unknown', /could not be confirmed/],
    ]) {
      const facts = factsFor({
        monthlyBilled: true,
        label: 'MONTHLY MEMBERSHIP — dues are charged monthly',
        monthlyDues: { base: 98.5, surcharge: 0, total: null, surcharged: false, basis },
      });
      expect(facts).toMatch(phrase);
      expect(facts).toMatch(/never a charge total/i);
    }
  });

  test('a non-monthly lane and an unpriced membership publish no dues line', () => {
    // For every other lane the stored rate is an artifact nobody is charged.
    expect(factsFor({ monthlyBilled: false, label: 'PER APPLICATION', monthlyDues: null }))
      .not.toMatch(/Monthly dues/);
    // Even a stray dues object cannot leak through a lane that isn't monthly.
    expect(factsFor({
      monthlyBilled: false,
      label: 'MONTHLY MEMBERSHIP BUT UNPRICED',
      monthlyDues: { base: 98.5, surcharge: 0, total: null, surcharged: false, basis: 'autopay_off' },
    })).not.toMatch(/Monthly dues/);
  });

  test('a caller with no lane fact at all still fails closed', () => {
    const facts = buildFactsBlock({});
    expect(facts).toMatch(/Billing lane: not stated/);
    expect(facts).not.toMatch(/Monthly dues/);
  });
});

describe('the amounts the facts publish are the amounts the guards authorize', () => {
  const laneWith = (monthlyDues) => ({ customer: { billingLane: { monthlyBilled: true, monthlyDues } } });

  test('the dues base is authorized whenever dues were published', () => {
    // Built from balances, invoices and payments only, the whitelist marked
    // the dues figure the facts block had just published as ungrounded and
    // held every monthly-lane draft in shadow — making the exception this
    // fact exists to reach unreachable on the suggestion/auto-send path.
    expect(authorizedDuesCents(laneWith({ base: 98.5, surcharge: 0, total: null, surcharged: false, basis: 'unknown_funding' })))
      .toEqual([9850]);
  });

  test('the broken-out fee is authorized alongside the total, never without it', () => {
    // The facts publish all three figures, so a draft that accurately repeats
    // "the $2.85 credit-card fee" must not parse as an ungrounded amount and
    // hold the whole draft in shadow.
    expect(authorizedDuesCents(laneWith({ base: 98.5, surcharge: 2.85, total: 101.35, surcharged: true, basis: 'credit_card_surcharge' })))
      .toEqual([9850, 10135, 285]);
  });

  test('a lane that published no dues authorizes nothing', () => {
    expect(authorizedDuesCents(laneWith(null))).toEqual([]);
    expect(authorizedDuesCents({ customer: { billingLane: { monthlyBilled: false, monthlyDues: { base: 98.5 } } } })).toEqual([]);
    expect(authorizedDuesCents({})).toEqual([]);
    expect(authorizedDuesCents(undefined)).toEqual([]);
  });

  test('BOTH amount guards ask the same definition', () => {
    // The draft-time guard and the scheduler's fire-time revalidation had
    // already drifted: a reviewed dues reply that an operator scheduled was
    // retired as a stale amount, so the lane could be approved but never sent.
    expect(drafter).toContain("require('./context-aggregator').authorizedDuesCents(context)");
    expect(scheduler).toContain('ContextAggregator.authorizedDuesCents(ctx)');
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
