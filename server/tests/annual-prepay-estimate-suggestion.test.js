// The Customer 360 "Record collected annual prepay" prefill: which estimate
// suggests, and that the suggested amount is EXACTLY what the estimate's own
// accept-as-prepay lane would invoice (shared resolver — no local math).

const {
  buildAnnualPrepayEstimateSuggestion,
  pickAnnualPrepayEstimate,
  shortEstimateRef,
  suggestionServiceMatches,
} = require('../services/annual-prepay-estimate-suggestion');
const { resolveAnnualPrepayInvoiceTotal } = require('../services/estimate-converter');

const PEST_LINE = { service: 'pest', name: 'Quarterly Pest Control Service' };

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
  test('latest activity wins regardless of status; draft/declined/expired/archived never suggest', () => {
    const oldAccepted = pestEstimate({ id: '11111111-1111-4111-8111-111111111111', status: 'accepted', accepted_at: '2025-09-01T00:00:00Z' });
    const freshViewed = pestEstimate({ id: '22222222-2222-4222-8222-222222222222', viewed_at: '2026-08-25T00:00:00Z' });
    const staleSent = pestEstimate({ id: '33333333-3333-4333-8333-333333333333', status: 'sent', viewed_at: null, sent_at: '2026-07-01T00:00:00Z' });
    const draft = pestEstimate({ id: '44444444-4444-4444-8444-444444444444', status: 'draft' });
    const declined = pestEstimate({ id: '55555555-5555-4555-8555-555555555555', status: 'declined' });
    const archived = pestEstimate({ id: '66666666-6666-4666-8666-666666666666', archived_at: '2026-08-21T00:00:00Z' });

    // A year-old accepted estimate must not outrank the re-quote the customer
    // just looked at (re-quotes follow price changes).
    expect(pickAnnualPrepayEstimate([oldAccepted, freshViewed, staleSent]).id).toBe(freshViewed.id);
    expect(pickAnnualPrepayEstimate([draft, staleSent]).id).toBe(staleSent.id);
    expect(pickAnnualPrepayEstimate([draft, declined, archived])).toBeNull();
    expect(pickAnnualPrepayEstimate([])).toBeNull();
  });

  test('exact-timestamp ties break by status: accepted > viewed > sent', () => {
    const t = '2026-08-25T00:00:00Z';
    const accepted = pestEstimate({ id: '11111111-1111-4111-8111-111111111111', status: 'accepted', accepted_at: t });
    const viewed = pestEstimate({ id: '22222222-2222-4222-8222-222222222222', viewed_at: t });
    const sent = pestEstimate({ id: '33333333-3333-4333-8333-333333333333', status: 'sent', viewed_at: null, sent_at: t });
    expect(pickAnnualPrepayEstimate([sent, viewed, accepted]).id).toBe(accepted.id);
    expect(pickAnnualPrepayEstimate([sent, viewed]).id).toBe(viewed.id);
  });

  test('past-due sent/viewed estimates are excluded; accepted ones do not expire', () => {
    const expiredViewed = pestEstimate({ id: '11111111-1111-4111-8111-111111111111', viewed_at: '2026-08-25T00:00:00Z', expires_at: '2026-08-26T00:00:00Z' });
    const olderLive = pestEstimate({ id: '22222222-2222-4222-8222-222222222222', viewed_at: '2026-08-10T00:00:00Z', expires_at: '2099-01-01T00:00:00Z' });
    const expiredAccepted = pestEstimate({ id: '33333333-3333-4333-8333-333333333333', status: 'accepted', accepted_at: '2026-08-01T00:00:00Z', expires_at: '2026-08-02T00:00:00Z' });

    expect(pickAnnualPrepayEstimate([expiredViewed, olderLive]).id).toBe(olderLive.id);
    expect(pickAnnualPrepayEstimate([expiredViewed])).toBeNull();
    expect(pickAnnualPrepayEstimate([expiredAccepted]).id).toBe(expiredAccepted.id);
  });

  test('estimates already consumed by a term are excluded', () => {
    const consumed = pestEstimate({ id: '11111111-1111-4111-8111-111111111111', status: 'accepted', accepted_at: '2026-08-29T00:00:00Z' });
    const open = pestEstimate({ id: '22222222-2222-4222-8222-222222222222', viewed_at: '2026-08-20T00:00:00Z' });
    expect(pickAnnualPrepayEstimate([consumed, open], { excludeIds: [consumed.id] }).id).toBe(open.id);
    expect(pickAnnualPrepayEstimate([consumed], { excludeIds: [consumed.id] })).toBeNull();
  });
});

describe('buildAnnualPrepayEstimateSuggestion', () => {
  test('single-recurring-line pest estimate suggests the resolver amount off monthly × 12', async () => {
    const estimate = pestEstimate();
    const suggestion = await buildAnnualPrepayEstimateSuggestion([estimate]);
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
  });

  test('stored annual_total wins over monthly × 12', async () => {
    const suggestion = await buildAnnualPrepayEstimateSuggestion([pestEstimate({ annual_total: 400 })]);
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
    const suggestion = await buildAnnualPrepayEstimateSuggestion([bundle]);
    expect(suggestion.blocked).toBe(true);
    expect(suggestion.amount).toBeUndefined();
    expect(suggestion.shortRef).toBe(shortEstimateRef(bundle.id));
  });

  test('one-time-only estimates return the ref with no amount', async () => {
    const oneTime = pestEstimate({
      monthly_total: null,
      onetime_total: 368,
      estimate_data: { result: { oneTime: { items: [{ service: 'cockroach', name: 'German Roach Cleanout', price: 368 }] } } },
    });
    const suggestion = await buildAnnualPrepayEstimateSuggestion([oneTime]);
    expect(suggestion.blocked).toBe(true);
    expect(suggestion.amount).toBeUndefined();
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
    const suggestion = await buildAnnualPrepayEstimateSuggestion([managerApproval]);
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
    const suggestion = await buildAnnualPrepayEstimateSuggestion([existing]);
    expect(suggestion.blocked).toBe(true);
    expect(suggestion.amount).toBeUndefined();
  });

  test('no credible estimate → null (modal renders exactly as before)', async () => {
    expect(await buildAnnualPrepayEstimateSuggestion([])).toBeNull();
    expect(await buildAnnualPrepayEstimateSuggestion([pestEstimate({ status: 'draft' })])).toBeNull();
  });
});

describe('suggestionServiceMatches', () => {
  test('exact identity after cadence/filler stripping — never substring', () => {
    expect(suggestionServiceMatches('Quarterly Pest Control Service', 'Quarterly Pest Control')).toBe(true);
    expect(suggestionServiceMatches('Quarterly Pest Control Service', 'Monthly Pest Control Plan')).toBe(true);
    // "Pest Control" must NOT match "Commercial Pest Control" on money.
    expect(suggestionServiceMatches('Quarterly Pest Control', 'Commercial Pest Control')).toBe(false);
    expect(suggestionServiceMatches('Quarterly Pest Control', 'Quarterly Mosquito Service')).toBe(false);
    // Empty keys fail closed.
    expect(suggestionServiceMatches('', 'Quarterly Pest Control')).toBe(false);
    expect(suggestionServiceMatches('Quarterly Pest Control', '')).toBe(false);
  });
});

describe('shortEstimateRef', () => {
  test('matches the EstimatesPageV2 display token (last 6 alphanumerics, uppercased)', () => {
    expect(shortEstimateRef('5a0b1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d')).toBe('0B1C2D');
    expect(shortEstimateRef(null)).toBe('—');
  });
});
