// Tests services/ads/call-attribution.js — recording inbound paid call leads in
// the PPC funnel (ad_service_attribution), keyed by lead_id.

let firstByTable = {};
let listQueueByTable = {};
const insertCalls = [];
const updateCalls = [];

const mockDb = jest.fn((table) => {
  const b = {};
  const self = () => b;
  ['where', 'whereNot', 'whereRaw', 'whereNull', 'forUpdate', 'select', 'orderBy', 'limit', 'onConflict', 'ignore', 'merge'].forEach((m) => { b[m] = jest.fn(self); });
  b.first = jest.fn(() => Promise.resolve(firstByTable[table]));
  b.insert = jest.fn((row) => { insertCalls.push({ table, row }); return b; });
  b.update = jest.fn((row) => { updateCalls.push({ table, row }); return Promise.resolve(1); });
  // Awaited list queries consume a per-table queue when one is set (the
  // backfill's sid/stamp candidate reads); an awaited
  // insert(...).onConflict(...).ignore() chain still resolves [1].
  b.then = (res, rej) => {
    const q = listQueueByTable[table];
    const val = (q && q.length) ? q.shift() : [1];
    return Promise.resolve(val).then(res, rej);
  };
  return b;
});
mockDb.transaction = jest.fn(async (fn) => fn(mockDb));

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
  listQueueByTable = {};
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
    // Ask Waves gate-input services (2026-07-05): palm and lawn-pest must not
    // fall through to pest / quarterly_pest.
    expect(inferServiceLine('Palm Injections')).toBe('tree_shrub');
    expect(inferSpecificService('Palm Injections')).toBe('palm_injection');
    expect(inferServiceBucket('Palm Injections')).toBe('high_ticket_specialty');
    expect(inferServiceLine('Lawn Pest Control')).toBe('lawn');
    expect(inferSpecificService('Lawn Pest Control')).toBe('lawn_pest_control');
    expect(inferServiceBucket('Lawn Pest Control')).toBe('one_time_entry');
  });

  test('palmetto bugs are a PEST term, not a palm match (codex rd3)', () => {
    for (const interest of ['Palmetto Bugs', 'palmetto bug treatment']) {
      expect(inferServiceLine(interest)).toBe('pest');
      expect(inferSpecificService(interest)).toBe('quarterly_pest');
      expect(inferServiceBucket(interest)).toBe('recurring');
    }
    // Real palm phrasings still classify as palm.
    expect(inferSpecificService('palm tree injections')).toBe('palm_injection');
    expect(inferServiceLine('palms looking sick')).toBe('tree_shrub');
  });

  test("'+ Roach Knockdown' add-on suffix never reclassifies a recurring pest quote (codex rd3)", () => {
    for (const interest of [
      'Quarterly Pest Control + Roach Knockdown',
      'Quarterly Pest + Roach Knockdown', // compact label
      'Bi-Monthly Pest Control + Roach Knockdown',
    ]) {
      expect(inferServiceLine(interest)).toBe('pest');
      expect(inferSpecificService(interest)).toBe('quarterly_pest');
      expect(inferServiceBucket(interest)).toBe('recurring');
    }
    // A PRIMARY roach interest still classifies as cockroach.
    expect(inferSpecificService('Cockroach Treatment')).toBe('cockroach');
    expect(inferSpecificService('german roach cleanout')).toBe('cockroach');
  });

  test('renamed + per-species roach suffixes never reclassify a recurring pest quote (codex #3078 r3)', () => {
    // The suffix now carries the per-species configured display name — the
    // German default and any admin rename must strip like the legacy marker.
    for (const interest of [
      'Quarterly Pest Control + Cockroach Treatment',
      'Quarterly Pest Control + German Cockroach Treatment',
      'Monthly Pest + Roach', // compact label
      'Bi-Monthly Pest + German Roach', // compact label
    ]) {
      expect(inferServiceLine(interest)).toBe('pest');
      expect(inferSpecificService(interest)).toBe('quarterly_pest');
      expect(inferServiceBucket(interest)).toBe('recurring');
    }
    // An admin rename in the live display config strips at runtime too.
    const { PEST } = require('../services/pricing-engine/constants');
    const original = PEST.pestInitialRoach.display.regular;
    PEST.pestInitialRoach.display.regular = { name: 'Roach Rescue Visit', treatments: 1 };
    try {
      expect(inferSpecificService('Quarterly Pest Control + Roach Rescue Visit')).toBe('quarterly_pest');
      expect(inferServiceBucket('Quarterly Pest Control + Roach Rescue Visit')).toBe('recurring');
    } finally {
      PEST.pestInitialRoach.display.regular = original;
    }
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

describe('attributionForSourceType', () => {
  test('paid tracking numbers stay paid, mapped to their own channel', () => {
    expect(CallAttribution.attributionForSourceType('google_ads')).toEqual({ leadSource: 'google_ads', isPaid: true });
    expect(CallAttribution.attributionForSourceType('facebook')).toEqual({ leadSource: 'facebook', isPaid: true });
  });
  test('organic marketing sources map to their funnel channel, is_paid=false', () => {
    expect(CallAttribution.attributionForSourceType('spoke_site')).toEqual({ leadSource: 'domain_website', isPaid: false });
    expect(CallAttribution.attributionForSourceType('main_site')).toEqual({ leadSource: 'waves_website', isPaid: false });
    expect(CallAttribution.attributionForSourceType('gbp')).toEqual({ leadSource: 'google_business', isPaid: false });
    expect(CallAttribution.attributionForSourceType('website_organic')).toEqual({ leadSource: 'google_business', isPaid: false });
    // Van wrap: offline advertising on a dedicated number → its own no-spend channel
    // (is_paid=false; the wrap's amortized cost lives in channel_fixed_costs).
    expect(CallAttribution.attributionForSourceType('vehicle')).toEqual({ leadSource: 'van_wrap', isPaid: false });
    // Referral: its cost is the per-conversion reward (applied in fetchChannelAttribution).
    expect(CallAttribution.attributionForSourceType('referral')).toEqual({ leadSource: 'referral', isPaid: false });
    // NB: main_site maps to waves_website, but the caller suppresses the single
    // shared bridge-target number via google-call-bridge.isBridgeTargetNumber (so
    // paid Google calls on that line aren't pre-locked organic). The other
    // main_site city-page numbers attribute organic normally.
  });
  test('offline / unknown sources are not attributed (null)', () => {
    for (const t of ['walk_in', 'tollfree', 'direct', 'marketplace', 'unknown', undefined, null]) {
      expect(CallAttribution.attributionForSourceType(t)).toBeNull();
    }
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
      source_call_id: null,
      specific_service: 'mosquito_program',
      service_bucket: 'recurring',
      lead_date: '2026-03-15',
      lead_source: 'google_ads',
      lead_source_detail: 'Waves - GBP Search',
      funnel_stage: 'lead',
      is_paid: true, // call-sourced rows are inherently paid (paid tracking number)
    });
  });

  test('records a Facebook paid call with lead_source=facebook and a null campaign (Meta has no call→campaign reporting)', async () => {
    firstByTable.ad_service_attribution = undefined; // no existing row for this lead
    firstByTable.ad_campaigns = undefined; // no campaign lookup for Facebook calls

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C9',
      leadId: 'L9',
      leadSource: 'facebook',
      leadSourceDetail: 'Facebook Ads — Pest (call-extension)',
      serviceInterest: 'Lawn Care',
      leadDate: new Date('2026-06-28T18:00:00Z'),
    });

    expect(res).toEqual({ recorded: true, campaignId: null });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].row).toMatchObject({
      campaign_id: null,
      customer_id: 'C9',
      lead_id: 'L9',
      lead_source: 'facebook',
      lead_source_detail: 'Facebook Ads — Pest (call-extension)',
      service_line: 'lawn',
      funnel_stage: 'lead',
      // Facebook calls carry no fbclid/_fbc, so is_paid is what keeps them in the
      // PAID Meta bucket (channel-attribution / ad-cost-allocation).
      is_paid: true,
    });
  });

  test('records an ORGANIC marketing call (spoke domain) with is_paid=false so it stays out of the paid ratio', async () => {
    firstByTable.ad_service_attribution = undefined; // no existing row for this lead
    firstByTable.ad_campaigns = undefined; // organic call — no campaign

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C7',
      leadId: 'L7',
      leadSource: 'domain_website', // spoke_site → domain_website
      isPaid: false,
      leadSourceDetail: 'Spoke Pest — bradentonflpestcontrol.com',
      serviceInterest: 'Pest Control',
      leadDate: new Date('2026-06-20T18:00:00Z'),
    });

    expect(res).toEqual({ recorded: true, campaignId: null });
    expect(insertCalls).toHaveLength(1);
    expect(insertCalls[0].row).toMatchObject({
      customer_id: 'C7',
      lead_id: 'L7',
      lead_source: 'domain_website',
      lead_source_detail: 'Spoke Pest — bradentonflpestcontrol.com',
      funnel_stage: 'lead',
      is_paid: false, // organic call → its own no-spend channel, not the paid LTV:CAC blend
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
    firstByTable.ad_service_attribution = { id: 'row-y', lead_source: 'google_ads', customer_id: 'C1', campaign_id: 'local-existing', lead_source_detail: 'Old Campaign', service_line: 'pest', specific_service: 'quarterly_pest', service_bucket: 'recurring' };
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

    expect(res).toEqual({ recorded: false, reason: 'web_attributed' });
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });

  test('leaves a UTM-only web row (no click id) untouched too', async () => {
    firstByTable.ad_service_attribution = { id: 'web2', lead_source: 'google_ads', gclid: null, utm_campaign: 'spring_lawn', campaign_id: null, lead_source_detail: 'web detail' };
    firstByTable.ad_campaigns = { id: 'local-9' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', leadSource: 'google_ads', googleCampaignId: '22594274874', leadSourceDetail: 'Call Campaign',
    });

    expect(res).toEqual({ recorded: false, reason: 'web_attributed' });
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });

  test('leaves a Meta web first-touch row (fbclid) untouched when a Facebook call arrives', async () => {
    // A facebook WEB lead: same source, no campaign_id, but it has an fbclid.
    firstByTable.ad_service_attribution = { id: 'fbweb', lead_source: 'facebook', fbclid: 'fb.click.1', campaign_id: null, lead_source_detail: 'web detail', service_line: 'lawn' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', leadSource: 'facebook', leadSourceDetail: 'Facebook Ads — call-extension',
    });

    expect(res).toEqual({ recorded: false, reason: 'web_attributed' });
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });

  test('leaves a Meta web first-touch row (_fbc cookie, no fbclid) untouched too', async () => {
    firstByTable.ad_service_attribution = { id: 'fbweb2', lead_source: 'facebook', fbclid: null, fbc: 'fb.1.1700000000.abc', campaign_id: null, lead_source_detail: 'web detail' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', leadSource: 'facebook', leadSourceDetail: 'Facebook Ads — call-extension',
    });

    expect(res).toEqual({ recorded: false, reason: 'web_attributed' });
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
    firstByTable.ad_service_attribution = { id: 'row-2', customer_id: 'C1', campaign_id: 'local-existing', lead_source_detail: 'x', service_line: 'pest', specific_service: 'quarterly_pest', service_bucket: 'recurring' };
    firstByTable.ad_campaigns = { id: 'local-9' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', googleCampaignId: '22594274874', leadSourceDetail: 'y',
    });

    expect(res).toEqual({ recorded: false, reason: 'already_recorded' });
    expect(updateCalls).toHaveLength(0);
    expect(insertCalls).toHaveLength(0);
  });
});

describe("call provenance protects another call's row (PR #3303)", () => {
  test('a different call never patches a provenanced row', async () => {
    firstByTable.ad_service_attribution = {
      id: 'row-p', lead_source: 'google_ads', customer_id: null,
      campaign_id: null, lead_source_detail: 'inbound call', source_call_id: 'call-A',
    };
    firstByTable.ad_campaigns = { id: 'local-9' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', googleCampaignId: '22594274874',
      leadSourceDetail: 'New Campaign', sourceCallId: 'call-B',
    });

    expect(res).toEqual({ recorded: false, reason: 'other_call' });
    expect(updateCalls).toHaveLength(0);
  });

  test('a lead-centric backfill (no call identity) still repairs the row', async () => {
    firstByTable.ad_service_attribution = {
      id: 'row-p', lead_source: 'google_ads', customer_id: null,
      campaign_id: null, lead_source_detail: 'inbound call', source_call_id: 'call-A',
    };
    firstByTable.ad_campaigns = { id: 'local-9' };

    const res = await CallAttribution.recordCallPpcAttribution({
      customerId: 'C1', leadId: 'L1', googleCampaignId: '22594274874', leadSourceDetail: 'New Campaign',
    });

    expect(res).toMatchObject({ recorded: true, updated: true });
    expect(updateCalls[0].row).toMatchObject({ customer_id: 'C1', campaign_id: 'local-9' });
  });
});

describe('backfillCallLeadAttribution — provenance resolved and written under ONE lock (PR #3303 r5)', () => {
  const LEAD = {
    id: 'lead-1',
    lead_source_id: 'src-1',
    service_interest: 'pest control',
    created_at: '2026-08-01T12:00:00.000Z',
    twilio_call_sid: null,
  };
  const SOURCE = { id: 'src-1', source_type: 'google_ads', name: 'Tracked Line' };

  test('a single sid-linked call verified settled UNDER LOCK becomes provenance; the funnel write rides the same transaction', async () => {
    firstByTable.leads = { ...LEAD, twilio_call_sid: 'CAx' };
    firstByTable.lead_sources = SOURCE;
    listQueueByTable.call_log = [[{ id: 'call-1' }]];
    firstByTable.call_log = { id: 'call-1', processing_token: null, processing_status: 'processed', metadata: '{}' };

    const res = await CallAttribution.backfillCallLeadAttribution({ leadId: 'lead-1', customerId: 'cust-1' });

    expect(res.recorded).toBe(true);
    expect(mockDb.transaction).toHaveBeenCalledTimes(1);
    const insert = insertCalls.find((c) => c.table === 'ad_service_attribution');
    expect(insert.row.source_call_id).toBe('call-1');
  });

  test('a sid candidate whose LOCKED re-read shows an in-flight reprocess refuses — the retired row never resurrects', async () => {
    firstByTable.leads = { ...LEAD, twilio_call_sid: 'CAx' };
    firstByTable.lead_sources = SOURCE;
    listQueueByTable.call_log = [[{ id: 'call-1' }]];
    firstByTable.call_log = { id: 'call-1', processing_token: 'tok-live', processing_status: 'processing', metadata: '{}' };

    const res = await CallAttribution.backfillCallLeadAttribution({ leadId: 'lead-1', customerId: 'cust-1' });

    expect(res).toEqual({ recorded: false, reason: 'call_rejected' });
    expect(insertCalls.filter((c) => c.table === 'ad_service_attribution')).toHaveLength(0);
  });

  test('TWO settled stamped calls leave provenance NULL — never newest-wins (codex P1 r5)', async () => {
    firstByTable.leads = { ...LEAD };
    firstByTable.lead_sources = SOURCE;
    listQueueByTable.call_log = [[{ id: 's1' }, { id: 's2' }]];

    const res = await CallAttribution.backfillCallLeadAttribution({ leadId: 'lead-1', customerId: 'cust-1' });

    expect(res.recorded).toBe(true);
    const insert = insertCalls.find((c) => c.table === 'ad_service_attribution');
    expect(insert.row.source_call_id).toBeNull();
  });

  test('exactly ONE settled stamped call becomes provenance after its locked re-check', async () => {
    firstByTable.leads = { ...LEAD };
    firstByTable.lead_sources = SOURCE;
    listQueueByTable.call_log = [[{ id: 's1' }]];
    firstByTable.call_log = { id: 's1', processing_token: null, processing_status: 'processed', metadata: '{}' };

    const res = await CallAttribution.backfillCallLeadAttribution({ leadId: 'lead-1', customerId: 'cust-1' });

    expect(res.recorded).toBe(true);
    expect(insertCalls.find((c) => c.table === 'ad_service_attribution').row.source_call_id).toBe('s1');
  });

  test('a stamped candidate that turns in-flight under the lock refuses with call_unsettled (retryable, no NULL-provenance row)', async () => {
    firstByTable.leads = { ...LEAD };
    firstByTable.lead_sources = SOURCE;
    listQueueByTable.call_log = [[{ id: 's1' }]];
    firstByTable.call_log = { id: 's1', processing_token: 'tok-live', processing_status: 'processing', metadata: '{}' };

    const res = await CallAttribution.backfillCallLeadAttribution({ leadId: 'lead-1', customerId: 'cust-1' });

    expect(res).toEqual({ recorded: false, reason: 'call_unsettled' });
    expect(insertCalls.filter((c) => c.table === 'ad_service_attribution')).toHaveLength(0);
  });
});

describe('resolveSourceCallProvenanceLocked — settled dissenting stamp (GH P1 r6)', () => {
  const LEAD2 = {
    id: 'lead-old',
    lead_source_id: 'src-1',
    service_interest: 'pest control',
    created_at: '2026-08-01T12:00:00.000Z',
    twilio_call_sid: 'CAy',
  };

  test('a sid candidate whose SETTLED stamp points at a DIFFERENT lead refuses — the repoint is authoritative', async () => {
    firstByTable.leads = { ...LEAD2 };
    firstByTable.lead_sources = { id: 'src-1', source_type: 'google_ads', name: 'Tracked Line' };
    listQueueByTable.call_log = [[{ id: 'call-9' }]];
    firstByTable.call_log = {
      id: 'call-9',
      processing_token: null,
      processing_status: 'processed',
      metadata: JSON.stringify({ lead_id: 'lead-new' }),
    };

    const res = await CallAttribution.backfillCallLeadAttribution({ leadId: 'lead-old', customerId: 'cust-1' });

    expect(res).toEqual({ recorded: false, reason: 'call_repointed' });
    expect(insertCalls.filter((c) => c.table === 'ad_service_attribution')).toHaveLength(0);
  });

  test('a sid candidate whose settled stamp AGREES with the lead still becomes provenance', async () => {
    firstByTable.leads = { ...LEAD2 };
    firstByTable.lead_sources = { id: 'src-1', source_type: 'google_ads', name: 'Tracked Line' };
    listQueueByTable.call_log = [[{ id: 'call-9' }]];
    firstByTable.call_log = {
      id: 'call-9',
      processing_token: null,
      processing_status: 'processed',
      metadata: JSON.stringify({ lead_id: 'lead-old' }),
    };

    const res = await CallAttribution.backfillCallLeadAttribution({ leadId: 'lead-old', customerId: 'cust-1' });

    expect(res.recorded).toBe(true);
    expect(insertCalls.find((c) => c.table === 'ad_service_attribution').row.source_call_id).toBe('call-9');
  });
});
