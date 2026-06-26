// Tests services/ads/call-attribution.js — recording inbound paid call leads in
// the PPC funnel (ad_service_attribution).

let firstByTable = {};
const insertCalls = [];

const mockDb = jest.fn((table) => {
  const b = {};
  const self = () => b;
  ['where', 'whereNot', 'select', 'orderBy', 'limit'].forEach((m) => { b[m] = jest.fn(self); });
  b.first = jest.fn(() => Promise.resolve(firstByTable[table]));
  b.insert = jest.fn((row) => { insertCalls.push({ table, row }); return Promise.resolve([1]); });
  return b;
});

jest.mock('../models/db', () => mockDb);
jest.mock('../services/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));
jest.mock('../utils/datetime-et', () => ({ etDateString: () => '2026-06-26' }));

const CallAttribution = require('../services/ads/call-attribution');
const { inferServiceLine, resolveCampaignId } = CallAttribution._private;

beforeEach(() => {
  jest.clearAllMocks();
  firstByTable = {};
  insertCalls.length = 0;
});

describe('inferServiceLine', () => {
  test('maps service interest keywords to a service line', () => {
    expect(inferServiceLine('Lawn Care')).toBe('lawn');
    expect(inferServiceLine('mosquito treatment')).toBe('mosquito');
    expect(inferServiceLine('termite / WDO inspection')).toBe('termite');
    expect(inferServiceLine('rat exclusion')).toBe('rodent');
    expect(inferServiceLine('palm & shrub')).toBe('tree_shrub');
    expect(inferServiceLine('general pest control')).toBe('pest');
    expect(inferServiceLine('')).toBeNull();
    expect(inferServiceLine(null)).toBeNull();
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
    const res = await CallAttribution.recordCallPpcAttribution({ customerId: null });
    expect(res).toEqual({ recorded: false, reason: 'no_customer' });
    expect(insertCalls).toHaveLength(0);
  });

  test('is idempotent — skips when a row already exists for customer/source/day', async () => {
    firstByTable.ad_service_attribution = { id: 'existing' };
    const res = await CallAttribution.recordCallPpcAttribution({ customerId: 'C1' });
    expect(res).toEqual({ recorded: false, reason: 'already_recorded' });
    expect(insertCalls).toHaveLength(0);
  });

  test('inserts a google_ads lead row with resolved campaign + inferred service line', async () => {
    firstByTable.ad_service_attribution = undefined; // no existing row
    firstByTable.leads = { service_interest: 'Mosquito Control' };
    firstByTable.ad_campaigns = { id: 'local-7' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1',
      leadId: 'L1',
      leadSourceDetail: 'Waves - GBP Search',
      googleCampaignId: '22594274874',
    });

    expect(res).toEqual({ recorded: true, campaignId: 'local-7' });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].table).toBe('ad_service_attribution');
    expect(insertCalls[0].row).toEqual({
      campaign_id: 'local-7',
      customer_id: 'C1',
      service_line: 'mosquito',
      lead_date: '2026-06-26',
      lead_source: 'google_ads',
      lead_source_detail: 'Waves - GBP Search',
      funnel_stage: 'lead',
    });
  });

  test('records with a null campaign (single-number bucket) when no campaign id is known', async () => {
    firstByTable.ad_service_attribution = undefined;
    firstByTable.leads = { service_interest: null };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C2',
      leadId: 'L2',
      leadSourceDetail: 'Google Ads (tracking line)',
    });

    expect(res).toEqual({ recorded: true, campaignId: null });
    expect(insertCalls[0].row).toMatchObject({
      campaign_id: null,
      lead_source: 'google_ads',
      service_line: null,
      funnel_stage: 'lead',
    });
  });
});
