// Ad health card data (services/ads/ads-health.js, GATE_ADS_HEALTH_CARD): one read-only payload from Google Ads and
// portal tables. Pins the timeline (Google changes made outside the API, the API's campaign changes = the portal's
// Pause / Enable, the budget log, lifted holds, negative keyword decisions; newest first; at most 60), the ET window
// sent to Google and to Postgres, the Google section shapes, and that one failed source never hides the others.

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
jest.mock('../services/logger', () => mockLogger);

const mockGetCustomer = jest.fn();
jest.mock('../services/ads/google-ads', () => ({ getCustomer: (...args) => mockGetCustomer(...args) }));

const mockTool = jest.fn();
jest.mock('../services/intelligence-bar/google-ads-ops-tools', () => ({
  executeGoogleAdsOpsTool: (...args) => mockTool(...args),
}));

// db(table) → a chainable builder that records its calls and resolves to that table's rows (or rejects).
let mockTables = {};
const mockCalls = [];
const mockDb = jest.fn((table) => {
  const calls = [];
  mockCalls.push({ table, calls });
  const builder = {};
  for (const method of ['where', 'orderBy', 'limit', 'select', 'joinRaw', 'whereRaw', 'groupBy']) {
    builder[method] = jest.fn((...args) => { calls.push([method, ...args]); return builder; });
  }
  builder.then = (resolve, reject) => {
    const rows = mockTables[table];
    return (rows instanceof Error ? Promise.reject(rows) : Promise.resolve(rows || [])).then(resolve, reject);
  };
  return builder;
});
let mockNegativeRows = [];
// db.raw(sql) inside a select is a marker; db.raw(sql, bindings) is the negative keyword query.
mockDb.raw = jest.fn((sql, bindings) => (bindings ? Promise.resolve({ rows: mockNegativeRows }) : { raw: sql }));
jest.mock('../models/db', () => mockDb);

const { errors } = require('google-ads-api');
const { buildAdsHealth } = require('../services/ads/ads-health');

// 2026-11-05 00:40 EST. The window is today plus the 29 days before: Oct 7 00:00 EDT = 04:00Z.
const NOW = new Date('2026-11-05T05:40:00.000Z');
const SINCE = new Date('2026-10-07T04:00:00.000Z');

function change({ at, client, type = 5, paths = ['status'], before = 2, after = 3, email = 'owner@example.test' }) {
  return {
    change_event: {
      change_date_time: at,
      user_email: email,
      client_type: client,
      change_resource_type: type,
      resource_change_operation: 3,
      changed_fields: { paths },
      old_resource: { campaign: { status: before } },
      new_resource: { campaign: { status: after } },
      campaign: 'customers/100/campaigns/111',
    },
  };
}

let gaql;
function customer({ others = [], portal = [], uploads = [], fail = {} } = {}) {
  gaql = [];
  return {
    query: jest.fn(async (text) => {
      gaql.push(text);
      if (text.includes('FROM offline_conversion_upload_conversion_action_summary')) {
        if (fail.uploads) throw fail.uploads;
        return uploads;
      }
      if (fail.changes) throw fail.changes;
      return text.includes("client_type != 'GOOGLE_ADS_API'") ? others : portal;
    }),
  };
}

const SERVING = {
  campaigns: [{
    id: '111', name: 'Test Search', status: 'PAUSED', primary_status: 'PAUSED',
    primary_status_reasons: ['CAMPAIGN_PAUSED'], daily_budget: 5,
  }],
  total: 1,
};
const NO_DISAPPROVALS = { ads: [], total: 0, truncated: false };

function budgetRow(over = {}) {
  return {
    created_at: new Date('2026-11-02T06:57:56.492Z'), campaign_name: 'Test Search', previous_mode: 'stop', new_mode: 'base',
    previous_budget: '0.05', new_budget: '5.00', reason: 'Hold: base until 2026-11-08 (set in the portal)', trigger: 'manual',
    ...over,
  };
}

const callsFor = (table) => mockCalls.filter((c) => c.table === table).map((c) => c.calls);

beforeEach(() => {
  jest.clearAllMocks();
  mockCalls.length = 0;
  mockTables = {};
  mockNegativeRows = [];
  mockTool.mockImplementation(async (name) => (name === 'get_google_ads_serving_status' ? SERVING : NO_DISAPPROVALS));
});

describe('buildAdsHealth', () => {
  test('joins Google and portal changes newest first, over the ET 30-day window', async () => {
    mockGetCustomer.mockReturnValue(customer({
      // The owner's Nov 2 pause from the Google Ads phone app (client 8), in account time (ET, EST after Nov 1).
      others: [change({ at: '2026-11-02 11:49:56.098059', client: 8 })],
      // The portal's Enable button: an API campaign change (client 6) with no portal log.
      portal: [change({ at: '2026-11-03 09:00:00', client: 6, before: 3, after: 2 })],
    }));
    mockTables.ad_budget_log = [
      budgetRow(),
      budgetRow({
        created_at: new Date('2026-10-27T18:00:06.027Z'), previous_mode: 'spent', new_mode: 'stop', previous_budget: '0.05',
        new_budget: '0.05', reason: 'Capacity 100% for general on 2026-10-28 — pushed to Google Ads', trigger: 'auto',
      }),
    ];

    const out = await buildAdsHealth(NOW);

    expect(out.timeline).toEqual([
      {
        at: '2026-11-03T14:00:00.000Z', source: 'google', who: 'Waves portal', via: 'Google Ads API',
        campaign: 'Test Search', what: 'Status Paused → Enabled', detail: null,
      },
      {
        at: '2026-11-02T16:49:56.000Z', source: 'google', who: 'owner@example.test', via: 'Google Ads mobile app',
        campaign: 'Test Search', what: 'Status Enabled → Paused', detail: null,
      },
      {
        at: '2026-11-02T06:57:56.492Z', source: 'waves', who: 'Admin', via: 'Waves portal', campaign: 'Test Search',
        what: 'Budget $0.05 → $5.00 (stop → base)', detail: 'Hold: base until 2026-11-08 (set in the portal)',
      },
      {
        at: '2026-10-27T18:00:06.027Z', source: 'waves', who: 'Budget job', via: 'Waves portal', campaign: 'Test Search',
        what: 'Budget $0.05 → $0.05 (spent → stop)', detail: 'Capacity 100% for general on 2026-10-28 — pushed to Google Ads',
      },
    ]);
    expect(out.notes).toEqual([]);

    // Google: ET dates (its history reaches 30 days back), the API excluded except its campaign rows.
    const changeQueries = gaql.filter((q) => q.includes('FROM change_event'));
    expect(changeQueries).toHaveLength(2);
    for (const q of changeQueries) {
      expect(q).toContain("change_event.change_date_time >= '2026-10-07' AND change_event.change_date_time <= '2026-11-06'");
      expect(q).toContain('LIMIT 60');
    }
    expect(changeQueries[0]).toContain("change_event.client_type != 'GOOGLE_ADS_API'");
    expect(changeQueries[1]).toContain("change_event.client_type = 'GOOGLE_ADS_API' AND change_event.change_resource_type = 'CAMPAIGN'");
    // Postgres: the same window as a real instant, never a naive string.
    expect(callsFor('ad_budget_log')[0]).toContainEqual(['where', 'created_at', '>=', SINCE]);
    expect(mockDb.raw).toHaveBeenCalledWith(expect.stringContaining('FROM ad_negative_keywords k'), [SINCE, SINCE, SINCE]);
  });

  test('a budget change made in Google reads as before → after, and other changes name their fields', async () => {
    mockGetCustomer.mockReturnValue(customer({
      others: [
        {
          change_event: {
            change_date_time: '2026-11-04 10:00:00', user_email: 'owner@example.test', client_type: 2,
            change_resource_type: 6, resource_change_operation: 3, changed_fields: { paths: ['amount_micros'] },
            old_resource: { campaign_budget: { amount_micros: 5000000 } }, new_resource: { campaign_budget: { amount_micros: 12500000 } },
            campaign: null,
          },
        },
        change({ at: '2026-11-04 09:00:00', client: 2, paths: ['name', 'end_date'] }),
      ],
    }));

    const { timeline } = await buildAdsHealth(NOW);

    expect(timeline[0]).toMatchObject({ via: 'Google Ads web client', campaign: null, what: 'Budget $5.00 → $12.50', detail: null });
    expect(timeline[1]).toMatchObject({ what: 'Update campaign', detail: 'Changed: name, end_date' });
  });

  test('maps serving, disapprovals, Google\'s upload check and the portal upload counts', async () => {
    const gclid = errors.ConversionUploadErrorEnum.ConversionUploadError.UNPARSEABLE_GCLID;
    mockGetCustomer.mockReturnValue(customer({
      uploads: [{
        offline_conversion_upload_conversion_action_summary: {
          conversion_action_name: 'Test - Qualified Lead',
          status: 2,
          last_upload_date_time: '2026-11-03 06:40:01.95645',
          daily_summaries: [{ successful_count: 2 }, { successful_count: 3, failed_count: 1 }, { successful_count: 5, pending_count: 2 }],
          alerts: [{ error: { conversion_upload_error: gclid }, error_percentage: 0.125 }],
        },
      }],
    }));
    mockTool.mockImplementation(async (name) => (name === 'get_google_ads_serving_status' ? SERVING : {
      ads: [{
        campaign: 'Test Search', ad_group: 'Pests', ad_id: '9', status: 'ENABLED', approval_status: 'DISAPPROVED',
        policy_topics: [{ topic: 'DESTINATION_NOT_WORKING', type: 'PROHIBITED' }, { topic: null, type: 'UNKNOWN' }],
      }],
      total: 1,
      truncated: false,
    }));
    mockTables.google_ads_conversion_uploads = [{ status: 'sent', n: 99 }, { status: 'pending', n: 7 }, { status: 'validated', n: 1 }];
    mockTables.meta_conversion_uploads = [{ status: 'sent', n: 103 }, { status: 'failed', n: 2 }];

    const out = await buildAdsHealth(NOW);

    expect(out.google).toEqual({
      configured: true,
      serving: {
        campaigns: [{ id: '111', name: 'Test Search', status: 'PAUSED', primaryStatus: 'PAUSED', reasons: ['CAMPAIGN_PAUSED'], dailyBudget: 5 }],
      },
      disapprovals: {
        total: 1,
        truncated: false,
        ads: [{ campaign: 'Test Search', adGroup: 'Pests', adId: '9', status: 'ENABLED', approvalStatus: 'DISAPPROVED', topics: ['DESTINATION_NOT_WORKING'] }],
      },
      uploadCheck: {
        actions: [{
          name: 'Test - Qualified Lead', status: 'EXCELLENT', lastUploadAt: '2026-11-03T11:40:01.000Z',
          accepted: 10, failed: 1, pending: 2, uploadDays: 3, alerts: [{ error: 'UNPARSEABLE_GCLID', percent: 12.5 }],
        }],
      },
    });
    expect(out.uploads).toEqual({ google: { sent: 99, pending: 7, failed: 0 }, meta: { sent: 103, pending: 0, failed: 2 } });
    // Meta test events are not real uploads.
    expect(callsFor('meta_conversion_uploads')[0]).toContainEqual(['where', 'test_mode', false]);
    expect(callsFor('google_ads_conversion_uploads')[0]).toContainEqual(['where', 'created_at', '>=', SINCE]);
  });

  test('one failed source never hides the others', async () => {
    mockGetCustomer.mockReturnValue(customer({
      others: [change({ at: '2026-11-02 11:49:56', client: 8 })],
      fail: { uploads: Object.assign(new Error('wrapper'), { errors: [{ message: 'The caller does not have permission' }] }) },
    }));
    mockTool.mockImplementation(async (name) => (name === 'get_google_ads_serving_status' ? { error: 'PERMISSION_DENIED' } : NO_DISAPPROVALS));
    mockTables.ad_budget_log = new Error('relation "ad_budget_log" does not exist');
    mockTables.google_ads_conversion_uploads = [{ status: 'sent', n: 4 }];

    const out = await buildAdsHealth(NOW);

    expect(out.google.serving).toEqual({ error: 'PERMISSION_DENIED' });
    expect(out.google.disapprovals).toEqual({ total: 0, truncated: false, ads: [] });
    expect(out.google.uploadCheck).toEqual({ error: "Google's upload check could not be read: The caller does not have permission" });
    // With no live campaign list, a Google row names the campaign by its id.
    expect(out.timeline).toEqual([expect.objectContaining({ what: 'Status Enabled → Paused', campaign: 'Campaign 111' })]);
    expect(out.notes).toEqual(['The budget log could not be read: relation "ad_budget_log" does not exist']);
    expect(out.uploads.google).toEqual({ sent: 4, pending: 0, failed: 0 });
  });

  test('a failed change history is a note; the portal rows still show', async () => {
    mockGetCustomer.mockReturnValue(customer({ fail: { changes: new Error('An internal error has occurred.') } }));
    mockTables.ad_budget_log = [budgetRow()];

    const out = await buildAdsHealth(NOW);

    expect(out.notes).toEqual(['Google change history could not be read: An internal error has occurred.']);
    expect(out.timeline).toEqual([expect.objectContaining({ what: 'Budget $0.05 → $5.00 (stop → base)' })]);
  });

  test('Google Ads not connected: no Google call, the portal parts still show', async () => {
    mockGetCustomer.mockReturnValue(null);
    mockTables.ad_budget_log = [budgetRow()];

    const out = await buildAdsHealth(NOW);

    expect(out.google).toEqual({ configured: false, serving: null, disapprovals: null, uploadCheck: null });
    expect(mockTool).not.toHaveBeenCalled();
    expect(out.timeline).toHaveLength(1);
  });

  test('negative keyword decisions and lifted holds join the timeline, one line per batch', async () => {
    mockGetCustomer.mockReturnValue(null);
    mockNegativeRows = [
      { kind: 'blocked', at: new Date('2026-11-02T17:41:00.000Z'), campaign_name: 'Test Search', who: 'starter-list', n: 16, words: 'ant bait, cheap' },
      { kind: 'declined', at: new Date('2026-11-03T13:05:00.000Z'), campaign_name: 'Test Search', who: 'Pat Owner', n: 1, words: 'free' },
    ];
    mockTables['ad_campaigns as c'] = [{
      campaign_name: 'Test Search', who: null,
      cleared: { at: '2026-11-04T15:00:00.000Z', by: 'staff-1', mode: 'base', until: '2026-11-08' },
    }];

    const { timeline } = await buildAdsHealth(NOW);

    expect(timeline).toEqual([
      {
        at: '2026-11-04T15:00:00.000Z', source: 'waves', who: 'Admin', via: 'Waves portal', campaign: 'Test Search',
        what: 'Hold lifted', detail: 'It held the ad at base until 2026-11-08.',
      },
      {
        at: '2026-11-03T13:05:00.000Z', source: 'waves', who: 'Pat Owner', via: 'Waves portal', campaign: 'Test Search',
        what: 'Declined negative keyword', detail: 'free',
      },
      {
        at: '2026-11-02T17:41:00.000Z', source: 'waves', who: 'starter-list', via: 'Waves portal', campaign: 'Test Search',
        what: 'Blocked 16 negative keywords', detail: 'ant bait, cheap',
      },
    ]);
    const holdQuery = callsFor('ad_campaigns as c')[0];
    expect(holdQuery).toContainEqual(['where', 'c.platform', 'google_ads']);
    expect(holdQuery).toContainEqual(['whereRaw', expect.stringContaining("'budget_hold_cleared' ->> 'at'"), [SINCE]]);
  });

  test('the timeline keeps the newest 60 rows', async () => {
    mockGetCustomer.mockReturnValue(null);
    mockTables.ad_budget_log = Array.from({ length: 70 }, (_, i) => budgetRow({ created_at: new Date(Date.UTC(2026, 9, 10, 0, i)) }));

    const { timeline } = await buildAdsHealth(NOW);

    expect(timeline).toHaveLength(60);
    expect(timeline[0].at).toBe('2026-10-10T01:09:00.000Z');
    expect(timeline[59].at).toBe('2026-10-10T00:10:00.000Z');
  });
});
