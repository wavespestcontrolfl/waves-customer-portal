/**
 * Ad lead campaign links (services/ads/campaign-link.js): a lead with a Google click id gets its campaign from
 * Google's click record inside the 90-day window, or, for an older click, from the one campaign with spend that day.
 * It writes only campaign_id + campaign_link_basis, and only where campaign_id is still empty.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { linkCampaigns, _internals } = require('../services/ads/campaign-link');

const NOW = new Date('2026-11-23T15:00:00Z');
const GCLID_NEW = 'Cj0KCQiA_recentClick123';
const GCLID_OLD = 'Cj0KCQiA_olderClick4567';

// A fake knex: ad_service_attribution rows, ad_campaigns, and spend rows for the older-click rule.
function fakeConn({ leads, campaigns, spendCampaignIds = [] }) {
  const updates = [];
  const conn = jest.fn((table) => {
    const q = {
      _where: {},
      whereNotNull() { return q; },
      whereNull() { return q; },
      orderBy() { return q; },
      limit() { return q; },
      join() { return q; },
      whereIn() { return q; },
      distinct: async () => spendCampaignIds.map((id) => ({ id })),
      where(a, b, c) {
        if (typeof a === 'object') q._where = a;
        if (table === 'ad_campaigns' && a === 'platform') return { select: async () => campaigns };
        return q;
      },
      select: async () => leads,
      update: async (patch) => { updates.push({ id: q._where.id, ...patch }); return 1; },
    };
    return q;
  });
  conn.fn = { now: () => 'now()' };
  conn.updates = updates;
  return conn;
}

function googleAdsWith(answers) {
  const query = jest.fn(async (gaql) => {
    const hit = Object.entries(answers).find(([gclid]) => gaql.includes(gclid));
    return hit ? [{ campaign: { id: hit[1] } }] : [];
  });
  return { getCustomer: () => ({ query }), query };
}

const campaigns = [{ id: 'local-gbp', platform_campaign_id: '22594274874' }, { id: 'local-pest', platform_campaign_id: '24535212391' }];

test('a recent click is linked from Google\'s click record, read-only, with its basis', async () => {
  const conn = fakeConn({ leads: [{ id: 'a1', gclid: GCLID_NEW, lead_date: '2026-11-10' }], campaigns });
  const g = googleAdsWith({ [GCLID_NEW]: 24535212391 });
  const out = await linkCampaigns({ now: NOW, conn, googleAds: g });
  expect(out).toEqual({ checked: 1, linked: { gclid_click_view: 1, only_campaign_with_spend: 0 }, unlinked: 0 });
  expect(conn.updates).toEqual([{ id: 'a1', campaign_id: 'local-pest', campaign_link_basis: 'gclid_click_view', updated_at: 'now()' }]);
  expect(g.query.mock.calls[0][0]).toMatch(/FROM click_view WHERE segments.date = '2026-11-10'/);
});

test('a recent click Google has no record of yet stays unlinked for the next run', async () => {
  const conn = fakeConn({ leads: [{ id: 'a1', gclid: GCLID_NEW, lead_date: '2026-11-22' }], campaigns, spendCampaignIds: ['local-gbp'] });
  const g = googleAdsWith({});
  const out = await linkCampaigns({ now: NOW, conn, googleAds: g });
  expect(out.unlinked).toBe(1);
  expect(conn.updates).toEqual([]);
  expect(g.query).toHaveBeenCalledTimes(2); // the lead day and the day before
});

test('an older click takes the one campaign with spend that day; two campaigns = unlinked', async () => {
  const lead = { id: 'b1', gclid: GCLID_OLD, lead_date: '2026-07-01' };
  const one = fakeConn({ leads: [lead], campaigns, spendCampaignIds: ['local-gbp'] });
  const g = googleAdsWith({});
  expect((await linkCampaigns({ now: NOW, conn: one, googleAds: g })).linked.only_campaign_with_spend).toBe(1);
  expect(one.updates[0]).toMatchObject({ campaign_id: 'local-gbp', campaign_link_basis: 'only_campaign_with_spend' });
  expect(g.query).not.toHaveBeenCalled();

  const two = fakeConn({ leads: [lead], campaigns, spendCampaignIds: ['local-gbp', 'local-pest'] });
  expect((await linkCampaigns({ now: NOW, conn: two, googleAds: g })).unlinked).toBe(1);
  expect(two.updates).toEqual([]);
});

test('a campaign Google names that is not in ad_campaigns, or a malformed click id, is never written', async () => {
  const conn = fakeConn({
    leads: [{ id: 'c1', gclid: GCLID_NEW, lead_date: '2026-11-10' }, { id: 'c2', gclid: "x' OR 1=1 --", lead_date: '2026-11-10' }],
    campaigns,
  });
  const g = googleAdsWith({ [GCLID_NEW]: 999 });
  const out = await linkCampaigns({ now: NOW, conn, googleAds: g });
  expect(out.unlinked).toBe(2);
  expect(conn.updates).toEqual([]);
  expect(g.query.mock.calls.every(([q]) => !q.includes('OR 1=1'))).toBe(true);
  expect(_internals.GCLID_RE.test("x' OR 1=1 --")).toBe(false);
});

test('a Google refusal fails the run with its reason', async () => {
  const conn = fakeConn({ leads: [{ id: 'a1', gclid: GCLID_NEW, lead_date: '2026-11-10' }], campaigns });
  const g = { getCustomer: () => ({ query: jest.fn().mockRejectedValue(new Error('PERMISSION_DENIED')) }) };
  await expect(linkCampaigns({ now: NOW, conn, googleAds: g })).rejects.toThrow('PERMISSION_DENIED');
});
