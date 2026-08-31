// The Customer 360 "Record collected annual prepay" prefill: which estimate
// suggests, and that the suggested amount is EXACTLY what the estimate's own
// accept-as-prepay lane would invoice (shared resolver — no local math).

const {
  buildAnnualPrepayEstimateSuggestion,
  pickAnnualPrepayEstimate,
  shortEstimateRef,
} = require('../services/annual-prepay-estimate-suggestion');
const { resolveAnnualPrepayInvoiceTotal } = require('../services/estimate-converter');

const PEST_LINE = { service: 'pest', name: 'Quarterly Pest Control Service', frequency: 'quarterly' };

// Minimal knex-ish stub: no open deposits, clean call rows, empty otherwise.
function stubDb({ deposits = [], callRow } = {}) {
  const chain = (result) => ({
    where: () => chain(result),
    whereIn: () => chain(result),
    whereNotNull: () => chain(result),
    first: async () => result,
    select: async () => [],
  });
  return (table) => {
    if (table === 'estimate_deposits') return chain(deposits[0] || null);
    if (table === 'call_log') return chain(callRow);
    return chain(null);
  };
}

function buildSuggestion(estimates, overrides = {}) {
  return buildAnnualPrepayEstimateSuggestion(estimates, {
    resolveLineCadence: (line) => line?.frequency || null,
    db: stubDb(),
    ...overrides,
  });
}

function pestEstimate(overrides = {}) {
  return {
    id: '5a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d',
    status: 'viewed',
    monthly_total: 32,
    annual_total: null,
    onetime_total: null,
    archived_at: null,
    created_at: '2026-08-01T00:00:00Z',
    sent_at: '2026-08-02T00:00:00Z',
    viewed_at: '2026-08-20T00:00:00Z',
    estimate_data: { result: { recurring: { services: [PEST_LINE] } } },
    ...overrides,
  };
}

describe('pickAnnualPrepayEstimate', () => {
  test('latest activity wins; accepted/draft/declined/expired/archived never suggest', () => {
    // Accepted estimates already ran conversion/billing through the estimate
    // lane — pricing a manual cash record off one risks duplicating
    // obligations, so they are excluded outright.
    const oldAccepted = pestEstimate({ id: '11111111-1111-4111-8111-111111111111', status: 'accepted', accepted_at: '2025-09-01T00:00:00Z' });
    const freshViewed = pestEstimate({ id: '22222222-2222-4222-8222-222222222222', viewed_at: '2026-08-25T00:00:00Z' });
    const staleSent = pestEstimate({ id: '33333333-3333-4333-8333-333333333333', status: 'sent', viewed_at: null, sent_at: '2026-07-01T00:00:00Z' });
    const draft = pestEstimate({ id: '44444444-4444-4444-8444-444444444444', status: 'draft' });
    const declined = pestEstimate({ id: '55555555-5555-4555-8555-555555555555', status: 'declined' });
    const archived = pestEstimate({ id: '66666666-6666-4666-8666-666666666666', archived_at: '2026-08-21T00:00:00Z' });

    expect(pickAnnualPrepayEstimate([oldAccepted, freshViewed, staleSent]).id).toBe(freshViewed.id);
    expect(pickAnnualPrepayEstimate([staleSent, freshViewed]).id).toBe(freshViewed.id);
    expect(pickAnnualPrepayEstimate([draft, staleSent]).id).toBe(staleSent.id);
    expect(pickAnnualPrepayEstimate([oldAccepted])).toBeNull();
    expect(pickAnnualPrepayEstimate([draft, declined, archived])).toBeNull();
    expect(pickAnnualPrepayEstimate([])).toBeNull();
  });

  test('exact-timestamp ties break by status: viewed > sent', () => {
    const t = '2026-08-25T00:00:00Z';
    const viewed = pestEstimate({ id: '22222222-2222-4222-8222-222222222222', viewed_at: t });
    const sent = pestEstimate({ id: '33333333-3333-4333-8333-333333333333', status: 'sent', viewed_at: null, sent_at: t });
    expect(pickAnnualPrepayEstimate([sent, viewed]).id).toBe(viewed.id);
  });

  test('a freshly RESENT viewed estimate outranks an older candidate', () => {
    // The send flow refreshes sent_at while preserving viewed_at/status —
    // ranking must use the LATEST activity stamp, not viewed_at first.
    const resent = pestEstimate({ id: '11111111-1111-4111-8111-111111111111', viewed_at: '2026-07-01T00:00:00Z', sent_at: '2026-08-29T00:00:00Z' });
    const midAge = pestEstimate({ id: '22222222-2222-4222-8222-222222222222', viewed_at: '2026-08-10T00:00:00Z', sent_at: '2026-08-01T00:00:00Z' });
    expect(pickAnnualPrepayEstimate([midAge, resent]).id).toBe(resent.id);
  });

  test('price-locked estimates never suggest (money already committed)', () => {
    const locked = pestEstimate({ id: '11111111-1111-4111-8111-111111111111', viewed_at: '2026-08-29T00:00:00Z', price_locked_at: '2026-08-29T01:00:00Z' });
    const open = pestEstimate({ id: '22222222-2222-4222-8222-222222222222', viewed_at: '2026-08-10T00:00:00Z' });
    expect(pickAnnualPrepayEstimate([locked, open]).id).toBe(open.id);
    expect(pickAnnualPrepayEstimate([locked])).toBeNull();
  });

  test('past-due sent/viewed estimates are excluded', () => {
    const expiredViewed = pestEstimate({ id: '11111111-1111-4111-8111-111111111111', viewed_at: '2026-08-25T00:00:00Z', expires_at: '2026-08-26T00:00:00Z' });
    const olderLive = pestEstimate({ id: '22222222-2222-4222-8222-222222222222', viewed_at: '2026-08-10T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' });

    expect(pickAnnualPrepayEstimate([expiredViewed, olderLive]).id).toBe(olderLive.id);
    expect(pickAnnualPrepayEstimate([expiredViewed])).toBeNull();
  });

  test('estimates already consumed by a term are excluded', () => {
    const consumed = pestEstimate({ id: '11111111-1111-4111-8111-111111111111', viewed_at: '2026-08-29T00:00:00Z' });
    const open = pestEstimate({ id: '22222222-2222-4222-8222-222222222222', viewed_at: '2026-08-20T00:00:00Z' });
    expect(pickAnnualPrepayEstimate([consumed, open], { excludeIds: [consumed.id] }).id).toBe(open.id);
    expect(pickAnnualPrepayEstimate([consumed], { excludeIds: [consumed.id] })).toBeNull();
  });
});

describe('buildAnnualPrepayEstimateSuggestion', () => {
  test('single-recurring-line pest estimate suggests the resolver amount off monthly × 12', async () => {
    const estimate = pestEstimate();
    const suggestion = await buildSuggestion([estimate]);
    expect(suggestion.blocked).toBeUndefined();
    expect(suggestion.estimateId).toBe(estimate.id);
    expect(suggestion.baseAnnual).toBe(384);
    expect(suggestion.serviceLabel).toBe('Quarterly Pest Control Service');
    // Parity contract: the suggestion IS what accepting this estimate as
    // annual prepay would invoice — same resolver, same inputs.
    const parity = resolveAnnualPrepayInvoiceTotal({
      baseAnnual: 384,
      recurringServices: [PEST_LINE],
      estimateData: estimate.estimate_data,
    });
    expect(suggestion.amount).toBe(parity.amount);
    expect(suggestion.discount).toBe(parity.discount);
    expect(suggestion.amount).toBeGreaterThan(0);
    // The quoted annual is only valid for the quoted schedule — the
    // suggestion must carry the estimate's own cadence and visit count.
    expect(suggestion.coverageCadence).toBe('quarterly');
    expect(suggestion.coverageVisitCount).toBe(4);
  });

  test('seasonal mosquito (prepay-unsupported schedule) never auto-prices', async () => {
    const seasonal = pestEstimate({
      monthly_total: 55,
      estimate_data: {
        result: { recurring: { services: [{ service: 'mosquito', name: 'Mosquito Service', frequency: 'seasonal_feb_oct', visitsPerYear: 9 }] } },
      },
    });
    const suggestion = await buildSuggestion([seasonal]);
    expect(suggestion.blocked).toBe(true);
    expect(suggestion.amount).toBeUndefined();
  });

  test("the bundle's single option key is the schedule authority when no line reader is given", async () => {
    const suggestion = await buildAnnualPrepayEstimateSuggestion([pestEstimate()], { db: stubDb() });
    expect(suggestion.blocked).toBeUndefined();
    expect(suggestion.coverageCadence).toBe('quarterly');
    expect(suggestion.coverageVisitCount).toBe(4);
  });

  test('an open reservation deposit blocks the prefill; unverifiable deposit state fails closed', async () => {
    const withDeposit = await buildSuggestion([pestEstimate()], {
      db: stubDb({ deposits: [{ id: 'd-1' }] }),
    });
    expect(withDeposit.blocked).toBe(true);
    expect(withDeposit.amount).toBeUndefined();
    // No connection to check deposits against → no amount.
    const noDb = await buildSuggestion([pestEstimate()], { db: null });
    expect(noDb.blocked).toBe(true);
    expect(noDb.amount).toBeUndefined();
  });

  test('a pending engine reprice blocks the prefill (stale fallback dollars)', async () => {
    const repricePending = pestEstimate({
      estimate_data: {
        estimatorEngine: {
          reprice_pending_at: new Date().toISOString(),
        },
        result: { recurring: { services: [PEST_LINE] } },
      },
    });
    const suggestion = await buildSuggestion([repricePending]);
    expect(suggestion.blocked).toBe(true);
    expect(suggestion.amount).toBeUndefined();
  });

  test('rounding residue: display-monthly × 12 re-anchors to the engine annual', async () => {
    // Quarterly $392/yr displays as $32.67/mo; 32.67 × 12 = 392.04. The
    // prefill must equal the accept path's $392.00, not the recompute.
    const drifty = pestEstimate({
      monthly_total: 32.67,
      estimate_data: {
        result: {
          totals: { year2: 392, year2mo: 32.67 },
          recurring: { services: [PEST_LINE] },
        },
      },
    });
    const suggestion = await buildSuggestion([drifty]);
    expect(suggestion.blocked).toBeUndefined();
    expect(suggestion.baseAnnual).toBe(392);
  });

  test('a non-default monthly never inherits the default option anchor', async () => {
    // Mirror of the accept-path guard: anchoring applies only when the
    // option's monthly equals the engine's default monthly.
    const nonDefault = pestEstimate({
      monthly_total: 30,
      estimate_data: {
        result: {
          totals: { year2: 392, year2mo: 32.67 },
          recurring: { services: [PEST_LINE] },
        },
      },
    });
    const suggestion = await buildSuggestion([nonDefault]);
    expect(suggestion.blocked).toBeUndefined();
    expect(suggestion.baseAnnual).toBe(360);
  });

  test('stored annual_total wins over monthly × 12', async () => {
    const suggestion = await buildSuggestion([pestEstimate({ annual_total: 400 })]);
    expect(suggestion.baseAnnual).toBe(400);
  });

  test('bundled recurring lines return the ref with no amount', async () => {
    const bundle = pestEstimate({
      estimate_data: {
        result: {
          recurring: {
            services: [PEST_LINE, { service: 'lawn', name: 'Lawn Care Program' }],
          },
        },
      },
    });
    const suggestion = await buildSuggestion([bundle]);
    expect(suggestion.blocked).toBe(true);
    expect(suggestion.amount).toBeUndefined();
    expect(suggestion.shortRef).toBe(shortEstimateRef(bundle.id));
  });

  test('recurring estimates carrying a BILLABLE one-time charge never suggest', async () => {
    // Claiming the estimate would close the quote while this path invoices
    // only the recurring year — the one-time charge would be silently lost.
    const withOneTime = pestEstimate({
      onetime_total: 368,
      estimate_data: {
        result: {
          recurring: { services: [PEST_LINE] },
          oneTime: { items: [{ service: 'cockroach', name: 'German Roach Cleanout', price: 368 }] },
        },
      },
    });
    const suggestion = await buildSuggestion([withOneTime]);
    expect(suggestion.blocked).toBe(true);
    expect(suggestion.amount).toBeUndefined();
  });

  test('one-time-only estimates return the ref with no amount', async () => {
    const oneTime = pestEstimate({
      monthly_total: null,
      onetime_total: 368,
      estimate_data: { result: { oneTime: { items: [{ service: 'cockroach', name: 'German Roach Cleanout', price: 368 }] } } },
    });
    const suggestion = await buildSuggestion([oneTime]);
    expect(suggestion.blocked).toBe(true);
    expect(suggestion.amount).toBeUndefined();
  });

  test('call-linked engine drafts fail closed unless their linkage verifies clean', async () => {
    const engineDraft = pestEstimate({
      estimate_data: {
        estimatorEngine: { callLogId: 'c-1' },
        result: { recurring: { services: [PEST_LINE] } },
      },
    });
    // No connection to verify against → no amount.
    const noDb = await buildSuggestion([engineDraft]);
    expect(noDb.blocked).toBe(true);
    expect(noDb.amount).toBeUndefined();
    // A durable call-side quarantine verdict → no amount.
    const quarantinedDb = () => ({
      where: () => ({
        first: async () => ({ metadata: { estimator_draft_block: { reason: 'wrong_identity' } } }),
      }),
    });
    const quarantined = await buildAnnualPrepayEstimateSuggestion([engineDraft], {
      resolveLineCadence: (line) => line?.frequency || null,
      db: quarantinedDb,
    });
    expect(quarantined.blocked).toBe(true);
    expect(quarantined.amount).toBeUndefined();
  });

  test('quote-required estimates never auto-price (review-lane guard)', async () => {
    const managerApproval = pestEstimate({
      estimate_data: {
        result: {
          recurring: { services: [PEST_LINE] },
          oneTime: { items: [{ service: 'dethatching', name: 'St. Augustine Dethatching', quoteRequired: true }] },
        },
      },
    });
    const suggestion = await buildSuggestion([managerApproval]);
    expect(suggestion.blocked).toBe(true);
    expect(suggestion.amount).toBeUndefined();
  });

  test('existing-customer estimates are prepay-ineligible and never auto-price', async () => {
    const existing = pestEstimate({
      estimate_data: {
        membershipSnapshot: { isExistingCustomer: true },
        result: { recurring: { services: [PEST_LINE] } },
      },
    });
    const suggestion = await buildSuggestion([existing]);
    expect(suggestion.blocked).toBe(true);
    expect(suggestion.amount).toBeUndefined();
  });

  test('no credible estimate → null (modal renders exactly as before)', async () => {
    expect(await buildAnnualPrepayEstimateSuggestion([])).toBeNull();
    expect(await buildAnnualPrepayEstimateSuggestion([pestEstimate({ status: 'draft' })])).toBeNull();
  });
});

describe('shortEstimateRef', () => {
  test('matches the EstimatesPageV2 display token (last 6 alphanumerics, uppercased)', () => {
    expect(shortEstimateRef('5a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d')).toBe('0B1C2D');
    expect(shortEstimateRef(null)).toBe('—');
  });
});
