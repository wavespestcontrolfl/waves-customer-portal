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

// A fake knex: ad_service_attribution rows, ad_campaigns, and system_settings (the try times).
function fakeConn({ leads, campaigns, tried = {} }) {
  const updates = [];
  const settings = { 'ads.campaign_link.tried': JSON.stringify(tried) };
  const conn = jest.fn((table) => {
    const q = {
      _where: {},
      whereNotNull() { return q; },
      whereNull() { return q; },
      orderBy() { return q; },
      limit() { return q; },
      where(a, b) {
        if (typeof a === 'object') q._where = a;
        if (a === 'lead_source') q._source = b;
        if (table === 'ad_campaigns' && a === 'platform') return { select: async () => campaigns };
        return q;
      },
      first: async () => (settings[q._where.key] != null ? { value: settings[q._where.key] } : undefined),
      select: async () => leads.filter((l) => !q._source || (l.lead_source || 'google_ads') === q._source),
      update: async (patch) => { updates.push({ id: q._where.id, ...patch }); return 1; },
      insert: (row) => ({ onConflict: () => ({ merge: async () => { settings[row.key] = row.value; } }) }),
    };
    return q;
  });
  conn.fn = { now: () => 'now()' };
  conn.updates = updates;
  conn.settings = settings;
  return conn;
}

// Google: click_view answers by gclid.
function googleAdsWith(answers) {
  const query = jest.fn(async (gaql) => {
    return Object.entries(answers).filter(([gclid]) => gaql.includes(`'${gclid}'`))
      .map(([gclid, id]) => ({ click_view: { gclid }, campaign: { id } }));
  });
  return { getCustomer: () => ({ query }), query };
}

const campaigns = [{ id: 'local-gbp', platform_campaign_id: '22594274874' }, { id: 'local-pest', platform_campaign_id: '24535212391' }];

test('a recent click is linked from Google\'s click record, read-only, with its basis', async () => {
  const conn = fakeConn({ leads: [{ id: 'a1', gclid: GCLID_NEW, lead_date: '2026-11-10' }], campaigns });
  const g = googleAdsWith({ [GCLID_NEW]: 24535212391 });
  const out = await linkCampaigns({ now: NOW, conn, googleAds: g });
  expect(out).toEqual({ checked: 1, linked: { gclid_click_view: 1 }, unlinked: 0 });
  expect(conn.updates).toEqual([{ id: 'a1', campaign_id: 'local-pest', campaign_link_basis: 'gclid_click_view', updated_at: 'now()' }]);
  expect(g.query.mock.calls[0][0]).toMatch(/FROM click_view WHERE segments.date = '2026-11-10'/);
});

test('a recent click Google has no record of yet stays unlinked for the next run', async () => {
  const conn = fakeConn({ leads: [{ id: 'a1', gclid: GCLID_NEW, lead_date: '2026-11-22' }], campaigns, spendCampaignIds: ['local-gbp'] });
  const g = googleAdsWith({});
  const out = await linkCampaigns({ now: NOW, conn, googleAds: g });
  expect(out.unlinked).toBe(1);
  expect(conn.updates).toEqual([]);
  expect(g.query).toHaveBeenCalledTimes(90); // every day Google still keeps, back from the lead day
});

test('a lead older than Google keeps clicks is never linked or guessed from spend, and costs no query', async () => {
  const conn = fakeConn({ leads: [{ id: 'b1', gclid: GCLID_OLD, lead_date: '2026-07-01' }], campaigns });
  const g = googleAdsWith({});
  expect(await linkCampaigns({ now: NOW, conn, googleAds: g })).toEqual({ checked: 0, linked: { gclid_click_view: 0 }, unlinked: 0 });
  expect(g.query).not.toHaveBeenCalled();
  expect(conn.updates).toEqual([]);
});

test('a lead day still inside the 90-day window is looked up exactly, even when the day before has left it', async () => {
  const conn = fakeConn({ leads: [{ id: 'd1', gclid: GCLID_NEW, lead_date: '2026-08-25' }], campaigns });
  const g = googleAdsWith({});
  const out = await linkCampaigns({ now: NOW, conn, googleAds: g });
  expect(out.unlinked).toBe(1); // no click record: waits, never guesses from spend
  expect(g.query).toHaveBeenCalledTimes(1);
  expect(g.query.mock.calls[0][0]).toMatch(/FROM click_view WHERE segments.date = '2026-08-25'/);
});

test('every waiting lead gets a turn: least recently tried first', async () => {
  const leads = Array.from({ length: 55 }, (_, i) => ({ id: `r${i}`, gclid: `${GCLID_NEW}${i}`, lead_date: '2026-11-10' }));
  const tried = Object.fromEntries(leads.slice(0, 50).map((l) => [l.id, { at: '2026-11-22T11:00:00.000Z' }]));
  const conn = fakeConn({ leads, campaigns, tried });
  const g = googleAdsWith({});
  await linkCampaigns({ now: NOW, conn, googleAds: g });
  const queried = new Set(g.query.mock.calls.flatMap(([q]) => [...q.matchAll(/'(Cj0[^']+)'/g)].map((m) => m[1])));
  for (let i = 50; i < 55; i += 1) expect(queried.has(`${GCLID_NEW}${i}`)).toBe(true);
  expect(JSON.parse(conn.settings['ads.campaign_link.tried']).r50).toEqual({ at: NOW.toISOString() });
});

test('a campaign Google names that is not in ad_campaigns, or a malformed click id, is never written', async () => {
  const conn = fakeConn({
    leads: [
      { id: 'c1', gclid: GCLID_NEW, lead_date: '2026-11-10' },
      { id: 'c2', gclid: "x' OR 1=1 --", lead_date: '2026-11-10' },
      { id: 'c3', gclid: 'n/a', lead_date: '2026-06-01' },
    ],
    campaigns,
  });
  const g = googleAdsWith({ [GCLID_NEW]: 999 });
  const out = await linkCampaigns({ now: NOW, conn, googleAds: g });
  expect(out.checked).toBe(1); // the malformed and the placeholder never enter, old or new
  expect(out.unlinked).toBe(1);
  expect(conn.updates).toEqual([]);
  expect(g.query.mock.calls.every(([q]) => !q.includes('OR 1=1'))).toBe(true);
  expect(_internals.GCLID_RE.test("x' OR 1=1 --")).toBe(false);
});

test('a Google refusal fails the run with its reason', async () => {
  const conn = fakeConn({ leads: [{ id: 'a1', gclid: GCLID_NEW, lead_date: '2026-11-10' }], campaigns });
  const g = { getCustomer: () => ({ query: jest.fn().mockRejectedValue(new Error('PERMISSION_DENIED')) }) };
  await expect(linkCampaigns({ now: NOW, conn, googleAds: g })).rejects.toThrow('PERMISSION_DENIED');
});

test('a click days before the form is found; an organic lead that kept a gclid is never linked', async () => {
  const conn = fakeConn({
    leads: [
      { id: 'e1', gclid: GCLID_NEW, lead_date: '2026-11-13' },
      { id: 'e2', gclid: GCLID_OLD, lead_date: '2026-11-13', lead_source: 'google_business' },
    ],
    campaigns,
  });
  const query = jest.fn(async (gaql) => (gaql.includes("'2026-11-10'") && gaql.includes(GCLID_NEW) ? [{ click_view: { gclid: GCLID_NEW }, campaign: { id: 22594274874 } }] : []));
  const out = await linkCampaigns({ now: NOW, conn, googleAds: { getCustomer: () => ({ query }) } });
  expect(out).toMatchObject({ checked: 1, linked: { gclid_click_view: 1 } });
  expect(conn.updates).toEqual([{ id: 'e1', campaign_id: 'local-gbp', campaign_link_basis: 'gclid_click_view', updated_at: 'now()' }]);
  expect(query.mock.calls.some(([q]) => q.includes(GCLID_OLD))).toBe(false);
});

test('a campaign Google names that is not local yet is kept, and linked next run without asking Google again', async () => {
  const lead = { id: 'h1', gclid: GCLID_NEW, lead_date: '2026-11-10' };
  const first = fakeConn({ leads: [lead], campaigns: [] });
  const g = googleAdsWith({ [GCLID_NEW]: 24535212391 });
  expect((await linkCampaigns({ now: NOW, conn: first, googleAds: g })).unlinked).toBe(1);
  const saved = JSON.parse(first.settings['ads.campaign_link.tried']);
  expect(saved.h1.google_campaign_id).toBe('24535212391');

  const next = fakeConn({ leads: [lead], campaigns, tried: saved });
  const g2 = googleAdsWith({});
  expect((await linkCampaigns({ now: NOW, conn: next, googleAds: g2 })).linked.gclid_click_view).toBe(1);
  expect(next.updates[0]).toMatchObject({ campaign_id: 'local-pest', campaign_link_basis: 'gclid_click_view' });
  expect(g2.query).not.toHaveBeenCalled();
});

test('a Google failure mid-run still saves the tries made so far', async () => {
  const leads = [{ id: 'g1', gclid: `${GCLID_NEW}a`, lead_date: '2026-11-10' }, { id: 'g2', gclid: `${GCLID_NEW}b`, lead_date: '2026-11-09' }];
  const conn = fakeConn({ leads, campaigns });
  const query = jest.fn(async (q) => { if (q.includes(`${GCLID_NEW}b`)) throw new Error('RESOURCE_EXHAUSTED'); return []; });
  await expect(linkCampaigns({ now: NOW, conn, googleAds: { getCustomer: () => ({ query }) } })).rejects.toThrow('RESOURCE_EXHAUSTED');
  const saved = JSON.parse(conn.settings['ads.campaign_link.tried']);
  expect(saved.g1).toEqual({ at: NOW.toISOString() });
  expect(saved.g2.at).toBe(NOW.toISOString());
});

test('one click_view query per day covers every lead of the run', async () => {
  const leads = Array.from({ length: 10 }, (_, i) => ({ id: `k${i}`, gclid: `${GCLID_NEW}k${i}`, lead_date: '2026-11-22' }));
  const conn = fakeConn({ leads, campaigns });
  const g = googleAdsWith({});
  await linkCampaigns({ now: NOW, conn, googleAds: g });
  expect(g.query).toHaveBeenCalledTimes(90); // days, not leads x days
  expect(g.query.mock.calls[0][0]).toContain(`IN ('${GCLID_NEW}k0', '${GCLID_NEW}k1'`);
});

test('an exact match found before a later day fails is kept for the next run', async () => {
  const leads = [{ id: 'm1', gclid: `${GCLID_NEW}m1`, lead_date: '2026-11-20' }, { id: 'm2', gclid: `${GCLID_NEW}m2`, lead_date: '2026-11-19' }];
  const conn = fakeConn({ leads, campaigns: [] });
  const query = jest.fn(async (q) => {
    if (q.includes("'2026-11-20'")) return [{ click_view: { gclid: `${GCLID_NEW}m1` }, campaign: { id: 24535212391 } }];
    throw new Error('RESOURCE_EXHAUSTED');
  });
  await expect(linkCampaigns({ now: NOW, conn, googleAds: { getCustomer: () => ({ query }) } })).rejects.toThrow('RESOURCE_EXHAUSTED');
  const saved = JSON.parse(conn.settings['ads.campaign_link.tried']);
  expect(saved.m1).toEqual({ at: NOW.toISOString(), google_campaign_id: '24535212391' });
  expect(saved.m2).toEqual({ at: NOW.toISOString() });
});

test('a campaign Google already named still links after the lead leaves the click window', async () => {
  const conn = fakeConn({
    leads: [{ id: 'n1', gclid: GCLID_OLD, lead_date: '2026-07-01' }],
    campaigns,
    tried: { n1: { at: '2026-11-22T11:00:00.000Z', google_campaign_id: '22594274874' } },
  });
  const g = googleAdsWith({});
  expect((await linkCampaigns({ now: NOW, conn, googleAds: g })).linked.gclid_click_view).toBe(1);
  expect(conn.updates[0]).toMatchObject({ id: 'n1', campaign_id: 'local-gbp' });
  expect(g.query).not.toHaveBeenCalled();
});

test('a saved match links even when another lead\'s lookup fails, then the step fails', async () => {
  const conn = fakeConn({
    leads: [{ id: 'p1', gclid: `${GCLID_NEW}p1`, lead_date: '2026-11-20' }, { id: 'p2', gclid: `${GCLID_NEW}p2`, lead_date: '2026-11-20' }],
    campaigns,
    tried: { p1: { at: '2026-11-22T11:00:00.000Z', google_campaign_id: '22594274874' } },
  });
  const query = jest.fn(async () => { throw new Error('RESOURCE_EXHAUSTED'); });
  await expect(linkCampaigns({ now: NOW, conn, googleAds: { getCustomer: () => ({ query }) } })).rejects.toThrow('RESOURCE_EXHAUSTED');
  expect(conn.updates).toEqual([{ id: 'p1', campaign_id: 'local-gbp', campaign_link_basis: 'gclid_click_view', updated_at: 'now()' }]);
});

test('two leads sharing a gclid: a click goes only to the lead whose days hold it', async () => {
  const conn = fakeConn({
    leads: [{ id: 's-new', gclid: GCLID_NEW, lead_date: '2026-11-20' }, { id: 's-old', gclid: GCLID_NEW, lead_date: '2026-11-05' }],
    campaigns,
  });
  const query = jest.fn(async (q) => (q.includes("'2026-11-10'") ? [{ click_view: { gclid: GCLID_NEW }, campaign: { id: 22594274874 } }] : []));
  await linkCampaigns({ now: NOW, conn, googleAds: { getCustomer: () => ({ query }) } });
  expect(conn.updates.map((u) => u.id)).toEqual(['s-new']);
  expect(query.mock.calls.some(([q]) => q.includes("'2026-08-25'"))).toBe(true); // the older lead keeps searching to the window start
});

test('never-tried leads: the oldest goes first, its click expires soonest', async () => {
  const leads = Array.from({ length: 11 }, (_, i) => ({ id: `o${i}`, gclid: `${GCLID_NEW}o${i}`, lead_date: `2026-11-${String(22 - i).padStart(2, '0')}` }));
  const conn = fakeConn({ leads, campaigns });
  await linkCampaigns({ now: NOW, conn, googleAds: googleAdsWith({}) });
  const saved = JSON.parse(conn.settings['ads.campaign_link.tried']);
  expect(saved.o10).toBeDefined(); // the oldest (11-12) got a turn
  expect(saved.o0).toBeUndefined(); // the newest (11-22) waits for the next run
});

