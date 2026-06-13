jest.mock('../models/db', () => jest.fn());
jest.mock('../services/analytics/google-analytics', () => ({ getGbpUtmTraffic: jest.fn() }));

const {
  acceptedEstimateRevenue,
  addDateStringDays,
  contentFromLead,
  isGbpUtmCampaign,
  mergeEstimateFields,
} = require('../services/analytics/local-performance')._internals;

describe('local performance helpers', () => {
  test('annualizes accepted estimate revenue without double-counting annual total', () => {
    expect(acceptedEstimateRevenue({
      estimate_status: 'accepted',
      estimate_monthly: '125',
      estimate_annual: '1500',
      estimate_onetime: '99',
    })).toBe(1599);
    expect(acceptedEstimateRevenue({
      estimate_status: 'accepted',
      estimate_monthly: null,
      estimate_annual: '900',
      estimate_onetime: '50',
    })).toBe(950);
    expect(acceptedEstimateRevenue({ estimate_status: 'sent', estimate_monthly: '125' })).toBe(0);
  });

  test('resolves profile content from GBP source rows and nested attribution JSON', () => {
    expect(contentFromLead({ gbp_location_id: '2262372053807555721' })).toBe('sarasota-profile');
    expect(contentFromLead({
      extracted_data: JSON.stringify({
        attribution: { utm: { content: 'venice_profile' } },
      }),
    })).toBe('venice_profile');
  });

  test('classifies existing and alternate GBP UTM traffic', () => {
    expect(isGbpUtmCampaign({ source: 'gbp', medium: 'organic', campaign: 'website-link' })).toBe(true);
    expect(isGbpUtmCampaign({ source: 'google', medium: 'organic', campaign: 'gbp' })).toBe(true);
    expect(isGbpUtmCampaign({ source: 'google', medium: 'cpc', campaign: 'gbp' })).toBe(false);
  });

  test('adds date-string days for exclusive report end bounds', () => {
    expect(addDateStringDays('2026-06-12', 1)).toBe('2026-06-13');
    expect(addDateStringDays('2026-06-01T13:00:00Z', 7)).toBe('2026-06-08');
  });

  test('merges accepted quote-wizard estimates by JSON lead id before revenue totals', () => {
    const rows = [
      { id: 'lead-1', estimate_id: null },
      { id: 'lead-2', estimate_id: 'estimate-direct' },
    ];
    const estimates = [
      {
        id: 'estimate-qw-1',
        status: 'accepted',
        source: 'quote_wizard',
        estimate_data: JSON.stringify({ lead_id: 'lead-1' }),
        monthly_total: '100',
        annual_total: null,
        onetime_total: '50',
        accepted_at: '2026-06-10T14:00:00Z',
      },
      {
        id: 'estimate-direct',
        status: 'sent',
        source: 'manual',
        estimate_data: null,
        monthly_total: '200',
        annual_total: null,
        onetime_total: '0',
        updated_at: '2026-06-09T14:00:00Z',
      },
      {
        id: 'estimate-qw-2',
        status: 'accepted',
        source: 'quote_wizard',
        estimate_data: { lead_id: 'lead-2' },
        monthly_total: '125',
        annual_total: null,
        onetime_total: '25',
        accepted_at: '2026-06-11T14:00:00Z',
      },
    ];

    const merged = mergeEstimateFields(rows, estimates);

    expect(merged[0]).toEqual(expect.objectContaining({
      estimate_status: 'accepted',
      estimate_monthly: '100',
      estimate_onetime: '50',
    }));
    expect(acceptedEstimateRevenue(merged[0])).toBe(1250);
    expect(merged[1]).toEqual(expect.objectContaining({
      estimate_status: 'accepted',
      estimate_monthly: '125',
      estimate_onetime: '25',
    }));
    expect(acceptedEstimateRevenue(merged[1])).toBe(1525);
  });
});
