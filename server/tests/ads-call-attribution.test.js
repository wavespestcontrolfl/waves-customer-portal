// Tests services/ads/call-attribution.js — recording inbound paid call leads in
// the PPC funnel (ad_service_attribution), keyed by lead_id.

let firstByTable = {};
const insertCalls = [];
const updateCalls = [];

const mockDb = jest.fn((table) => {
  const b = {};
  const self = () => b;
  ['where', 'whereNot', 'select', 'orderBy', 'limit', 'onConflict', 'ignore', 'merge'].forEach((m) => { b[m] = jest.fn(self); });
  b.first = jest.fn(() => Promise.resolve(firstByTable[table]));
  b.insert = jest.fn((row) => { insertCalls.push({ table, row }); return b; });
  b.update = jest.fn((row) => { updateCalls.push({ table, row }); return Promise.resolve(1); });
  // Makes an awaited insert(...).onConflict(...).ignore() chain resolve.
  b.then = (res, rej) => Promise.resolve([1]).then(res, rej);
  return b;
});

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({
  etDateString: (d) => (d ? new Date(d).toISOString().slice(0, 10) : '2026-06-26'),
}));

const CallAttribution = require('../services/ads/call-attribution');
const { resolveCampaignId } = CallAttribution._private;
const { inferServiceLine, inferSpecificService, inferServiceBucket } = require('../utils/service-line-infer');

beforeEach(() => {
  jest.clearAllMocks();
  firstByTable = {};
  insertCalls.length = 0;
  updateCalls.length = 0;
});

describe('shared service-line inference (utils/service-line-infer)', () => {
  test('maps interest to line / specific / bucket', () => {
    expect(inferServiceLine('Lawn Care')).toBe('lawn');
    expect(inferServiceLine('mosquito treatment')).toBe('mosquito');
    expect(inferServiceLine('rat exclusion')).toBe('rodent');
    expect(inferSpecificService('rat exclusion')).toBe('rodent_exclusion');
    expect(inferServiceBucket('rat exclusion')).toBe('high_ticket_specialty');
    expect(inferSpecificService('mosquito treatment')).toBe('mosquito_program');
    expect(inferServiceBucket('mosquito treatment')).toBe('recurring');
  });

  test('unknown/empty interest falls back to the same defaults as web leads', () => {
    expect(inferServiceLine('')).toBe('pest');
    expect(inferSpecificService('')).toBe('quarterly_pest');
    expect(inferServiceBucket('')).toBe('recurring');
  });
});

describe('resolveCampaignId', () => {
  test('returns null without a google campaign id', async () => {
    expect(await resolveCampaignId(null)).toBeNull();
  });
  test('maps a Google campaign id to the local ad_campaigns id', async () => {
    firstByTable.ad_campaigns = { id: 'local-1' };
    expect(await resolveCampaignId('22594274874')).toBe('local-1');
  });
  test('returns null when no local campaign matches', async () => {
    firstByTable.ad_campaigns = undefined;
    expect(await resolveCampaignId('999')).toBeNull();
  });
});

describe('recordCallPpcAttribution', () => {
  test('skips when there is no customer', async () => {
    const res = await CallAttribution.recordCallPpcAttribution({ customerId: null, leadId: 'L1' });
    expect(res).toEqual({ recorded: false, reason: 'no_customer' });
    expect(insertCalls).toHaveLength(0);
  });

  test('skips when there is no lead (existing-customer call that matched no lead)', async () => {
    const res = await CallAttribution.recordCallPpcAttribution({ customerId: 'C1', leadId: null });
    expect(res).toEqual({ recorded: false, reason: 'no_lead' });
    expect(insertCalls).toHaveLength(0);
  });

  test('inserts a lead-keyed row with resolved campaign + full service fields', async () => {
    firstByTable.ad_service_attribution = undefined; // no existing row for this lead
    firstByTable.ad_campaigns = { id: 'local-7' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1',
      leadId: 'L1',
      leadSourceDetail: 'Waves - GBP Search',
      googleCampaignId: '22594274874',
      serviceInterest: 'Mosquito Control',
      leadDate: new Date('2026-03-15T18:00:00Z'),
    });

    expect(res).toEqual({ recorded: true, campaignId: 'local-7' });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].row).toEqual({
      campaign_id: 'local-7',
      customer_id: 'C1',
      lead_id: 'L1',
      service_line: 'mosquito',
      specific_service: 'mosquito_program',
      service_bucket: 'recurring',
      lead_date: '2026-03-15',
      lead_source: 'google_ads',
      lead_source_detail: 'Waves - GBP Search',
      funnel_stage: 'lead',
    });
  });

  test('falls back to the lead service_interest when none is passed', async () => {
    firstByTable.ad_service_attribution = undefined;
    firstByTable.leads = { service_interest: 'Lawn Care' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C2', leadId: 'L2', leadSourceDetail: 'tracking line',
    });

    expect(res).toEqual({ recorded: true, campaignId: null });
    expect(insertCalls[0].row).toMatchObject({
      lead_id: 'L2', service_line: 'lawn', campaign_id: null, funnel_stage: 'lead',
    });
  });

  test('backfills campaign on an existing lead row instead of skipping', async () => {
    firstByTable.ad_service_attribution = { id: 'row-1', campaign_id: null, lead_source_detail: null, service_line: 'pest', specific_service: 'quarterly_pest', service_bucket: 'recurring' };
    firstByTable.ad_campaigns = { id: 'local-9' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', leadSourceDetail: 'Search - Bradenton', googleCampaignId: '22594274874',
    });

    expect(res).toEqual({ recorded: true, updated: true, campaignId: 'local-9' });
    expect(insertCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].row).toMatchObject({ campaign_id: 'local-9', lead_source_detail: 'Search - Bradenton' });
  });

  test('upgrades a placeholder detail + default service when the bridge later brings campaign + a known service', async () => {
    // dedicated-number path recorded this first: null campaign, generic detail, default service.
    firstByTable.ad_service_attribution = {
      id: 'row-x', lead_source: 'google_ads', campaign_id: null,
      lead_source_detail: 'inbound call', service_line: 'pest', specific_service: 'quarterly_pest', service_bucket: 'recurring',
    };
    firstByTable.ad_campaigns = { id: 'local-7' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', leadSource: 'google_ads',
      leadSourceDetail: 'Search - Mosquito', googleCampaignId: '22594274874',
      serviceInterest: 'Mosquito Control',
    });

    expect(res).toEqual({ recorded: true, updated: true, campaignId: 'local-7' });
    expect(updateCalls[0].row).toMatchObject({
      campaign_id: 'local-7',
      lead_source_detail: 'Search - Mosquito', // generic "inbound call" replaced
      service_line: 'mosquito',                // default "pest" upgraded
      specific_service: 'mosquito_program',
    });
  });

  test('does not overwrite an already-set campaign with a different one (first-touch wins)', async () => {
    firstByTable.ad_service_attribution = { id: 'row-y', lead_source: 'google_ads', campaign_id: 'local-existing', lead_source_detail: 'Old Campaign', service_line: 'pest', specific_service: 'quarterly_pest', service_bucket: 'recurring' };
    firstByTable.ad_campaigns = { id: 'local-9' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', googleCampaignId: '22594274874', leadSourceDetail: 'New Campaign',
    });

    expect(res).toEqual({ recorded: false, reason: 'already_recorded' });
    expect(updateCalls).toHaveLength(0);
  });

  test('leaves a click-attributed (web) row untouched so first-touch campaign survives', async () => {
    // A google_ads WEB lead: same source, no campaign_id, but it has a gclid.
    firstByTable.ad_service_attribution = { id: 'web', lead_source: 'google_ads', gclid: 'abc123', campaign_id: null, lead_source_detail: 'web detail', service_line: 'lawn' };
    firstByTable.ad_campaigns = { id: 'local-9' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', leadSource: 'google_ads', googleCampaignId: '22594274874', leadSourceDetail: 'Call Campaign',
    });

    expect(res).toEqual({ recorded: false, reason: 'click_attributed' });
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });

  test('does not duplicate or override when the lead already has a different-source row (reused web lead)', async () => {
    firstByTable.ad_service_attribution = { id: 'web-row', lead_source: 'domain_website', campaign_id: null, service_line: 'pest' };
    firstByTable.ad_campaigns = { id: 'local-9' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', googleCampaignId: '22594274874', leadSourceDetail: 'Search',
    });

    expect(res).toEqual({ recorded: false, reason: 'other_source' });
    expect(insertCalls).toHaveLength(0);
    expect(updateCalls).toHaveLength(0);
  });

  test('does not touch an existing lead row that already has its campaign', async () => {
    firstByTable.ad_service_attribution = { id: 'row-2', campaign_id: 'local-existing', lead_source_detail: 'x', service_line: 'pest', specific_service: 'quarterly_pest', service_bucket: 'recurring' };
    firstByTable.ad_campaigns = { id: 'local-9' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', googleCampaignId: '22594274874', leadSourceDetail: 'y',
    });

    expect(res).toEqual({ recorded: false, reason: 'already_recorded' });
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });
});
