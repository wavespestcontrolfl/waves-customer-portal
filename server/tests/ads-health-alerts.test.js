// Ads health alerts (services/ads/ads-health-alerts.js, GATE_ADS_HEALTH_ALERTS, owner 2026-11-05 "ALERT"): which
// Google problems count, the copy passes the admin notification rule, the Google bell rings only when a campaign or
// ad joins and closes itself at zero, upload faults go to Claude's queue and retire on a clean run, a source that
// cannot be read (or a row that cannot be written) changes nothing and fails the tick, and shadow writes no alert.
// The 2-hour cron is in scheduler-ads-budget-job.test.js.
const mockTables = {};
jest.mock('../models/db', () => {
  const builder = (table) => {
    const q = {};
    for (const method of ['where', 'whereIn', 'orderBy', 'limit']) q[method] = jest.fn(() => q);
    q.select = jest.fn(async () => mockTables[table] || []);
    q.first = jest.fn(async () => mockTables[table]);
    return q;
  };
  const db = jest.fn((table) => builder(table));
  db.transaction = jest.fn(async (work) => work({ raw: jest.fn(async () => ({})) }));
  db.raw = jest.fn();
  db.fn = { now: jest.fn() };
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ adsHealthAlertsMode: jest.fn(() => 'off'), alertEpisodesLive: jest.fn(() => true) }));
jest.mock('../services/ads/google-ads', () => ({ getCustomer: jest.fn() }));
jest.mock('../services/ads/ads-health', () => ({
  servingSection: jest.fn(),
  uploadCheckSection: jest.fn(),
  words: (name) => {
    const text = String(name || '').toLowerCase().replace(/_/g, ' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  },
}));
jest.mock('../services/admin-alert-episodes', () => ({
  raiseAdminAlertWithReopen: jest.fn(async () => ({ id: 'n1', deduped: false })),
  closeAdminAlertKeys: jest.fn(async () => 1),
}));
jest.mock('../services/ops-digest', () => ({
  ...jest.requireActual('../services/ops-digest'),
  deliverOpsDigest: jest.fn(async () => ({ ok: true, channel: 'in_app', id: 'd1' })),
}));
jest.mock('../services/ops-digest-fall-off', () => ({ retireIfClean: jest.fn(async () => 1) }));
jest.mock('../services/audit-log', () => ({ recordAuditEvent: jest.fn(async () => {}) }));

const db = require('../models/db');
const gates = require('../config/feature-gates');
const { getCustomer } = require('../services/ads/google-ads');
const Health = require('../services/ads/ads-health');
const Episodes = require('../services/admin-alert-episodes');
const OpsDigest = require('../services/ops-digest');
const FallOff = require('../services/ops-digest-fall-off');
const AuditLog = require('../services/audit-log');
const { composeAdminAlert } = require('../services/admin-alert-compose');
const { runAdsHealthAlerts, _private } = require('../services/ads/ads-health-alerts');

const { readGoogle, googleProblems, composeGoogle } = _private;
const NOW = new Date('2026-11-05T15:20:00Z');
const campaign = (over = {}) => ({
  id: '111', name: 'Test Search Campaign', status: 'ENABLED', primaryStatus: 'ELIGIBLE', reasons: [], dailyBudget: 5, ...over,
});
const ad = (over = {}) => ({ campaign: 'Test Search Campaign', adGroup: 'Pests', adId: '901', topics: ['DESTINATION_NOT_WORKING'], ...over });
// The row shape the Google Ads client returns for the disapproved-ads query.
const gaqlRow = (a) => ({
  campaign: { name: a.campaign },
  ad_group: { name: a.adGroup },
  ad_group_ad: { ad: { id: a.adId }, policy_summary: { policy_topic_entries: a.topics.map((topic) => ({ topic, type: 2 })) } },
});
const uploadRow = (over = {}) => ({
  id: 'g1', conversion_type: 'qualified_lead', status: 'failed', error_message: 'Synthetic upload error',
  updated_at: new Date('2026-11-05T11:40:00Z'), ...over,
});

let mockCustomer;
function google({ campaigns = [], ads = [] } = {}) {
  Health.servingSection.mockResolvedValue({ campaigns });
  mockCustomer.query.mockResolvedValue(ads.map(gaqlRow));
}
function uploads({ googleRows = [], metaRows = [], actions = [] } = {}) {
  mockTables.google_ads_conversion_uploads = googleRows;
  mockTables.meta_conversion_uploads = metaRows;
  Health.uploadCheckSection.mockResolvedValue({ actions });
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const key of Object.keys(mockTables)) delete mockTables[key];
  mockCustomer = { query: jest.fn() };
  getCustomer.mockReturnValue(mockCustomer);
  google();
  uploads();
});

test('off: reads nothing and writes nothing', async () => {
  gates.adsHealthAlertsMode.mockReturnValue('off');
  await expect(runAdsHealthAlerts({ now: NOW })).resolves.toEqual({ skipped: 'off' });
  expect(Health.servingSection).not.toHaveBeenCalled();
  expect(mockCustomer.query).not.toHaveBeenCalled();
  expect(db).not.toHaveBeenCalled();
});

test('only an enabled campaign Google says cannot serve counts; a pause or an end date never does', () => {
  const problems = googleProblems({
    serving: { campaigns: [
      campaign({ id: '1', name: 'Not Eligible One', primaryStatus: 'NOT_ELIGIBLE', reasons: ['HAS_ADS_DISAPPROVED'] }),
      campaign({ id: '2', name: 'Misconfigured One', primaryStatus: 'MISCONFIGURED' }),
      campaign({ id: '3', name: 'Ad Groups Paused', primaryStatus: 'PAUSED', reasons: ['AD_GROUPS_PAUSED'] }),
      campaign({ id: '4', name: 'Ended One', primaryStatus: 'ENDED' }),
      campaign({ id: '5', name: 'Owner Paused', status: 'PAUSED', primaryStatus: 'PAUSED', reasons: ['CAMPAIGN_PAUSED'] }),
      campaign({ id: '6', name: 'Limited One', primaryStatus: 'LIMITED', reasons: ['BUDGET_CONSTRAINED'] }),
    ] },
    disapproved: { ads: [], capped: false },
  });
  expect(problems.campaigns.map((c) => c.id)).toEqual(['1', '2']);
});

test('Google is asked for exactly the disapproved ads that would serve: ad, ad group and campaign enabled, campaign not ended', async () => {
  google({ ads: [ad()] });
  const { disapproved } = await readGoogle();
  const gaql = mockCustomer.query.mock.calls[0][0].replace(/\s+/g, ' ');
  // An ended campaign keeps status ENABLED, so its disapproved ads are left out by primary status, before the limit.
  for (const filter of ["ad_group_ad.policy_summary.approval_status = 'DISAPPROVED'", "ad_group_ad.status = 'ENABLED'",
    "ad_group.status = 'ENABLED'", "campaign.status = 'ENABLED'", "campaign.primary_status != 'ENDED' LIMIT 201"]) {
    expect(gaql).toContain(filter);
  }
  expect(disapproved).toEqual({ capped: false, ads: [{ campaign: 'Test Search Campaign', adGroup: 'Pests', adId: '901', topics: ['DESTINATION_NOT_WORKING'] }] });
});

test('past 200 disapproved ads the set counts as one item, so a shift in the first page never rings', async () => {
  google({ ads: Array.from({ length: 201 }, (_, i) => ad({ adId: String(1000 + i) })) });
  const composed = composeGoogle(googleProblems(await readGoogle()));
  expect(composed.itemKeys).toEqual(['ad:over-200']);
  expect(composed.detail).toContain('more than 200');
  expect(() => composeAdminAlert(composed.spec)).not.toThrow();
});

describe('the Google bell copy passes the admin notification rule', () => {
  const cases = [
    ['one campaign', { campaigns: [campaign({ primaryStatus: 'NOT_ELIGIBLE', reasons: ['HAS_ADS_DISAPPROVED'] })], ads: [] },
      'Leads — fix Test Search Campaign in Google Ads', 'Test Search Campaign cannot serve: Has ads disapproved.', ['campaign:111']],
    ['two campaigns', { campaigns: [campaign({ primaryStatus: 'MISCONFIGURED' }), campaign({ id: '112', primaryStatus: 'NOT_ELIGIBLE' })], ads: [] },
      'Leads — fix 2 Google Ads campaigns that cannot serve', 'Test Search Campaign cannot serve: Misconfigured.', ['campaign:111', 'campaign:112']],
    ['one ad', { campaigns: [], ads: [ad()] },
      'Leads — fix a disapproved Google ad', 'Google disapproved an ad in Pests (Test Search Campaign): Destination not working.', ['ad:901']],
    ['a campaign and two ads', { campaigns: [campaign({ primaryStatus: 'NOT_ELIGIBLE' })], ads: [ad(), ad({ adId: '902', topics: [] })] },
      'Leads — fix 1 Google Ads campaign and 2 disapproved ads', 'Test Search Campaign cannot serve: Not eligible.', ['ad:901', 'ad:902', 'campaign:111']],
    ['a name that would break the rule', { campaigns: [campaign({ name: '[Search] Pest Main', primaryStatus: 'MISCONFIGURED' })], ads: [] },
      'Leads — fix a Google Ads campaign that cannot serve', 'Google says 1 campaign cannot serve; the full text names it.', ['campaign:111']],
  ];
  test.each(cases)('%s', (_label, problems, headline, why, itemKeys) => {
    const composed = composeGoogle(problems);
    const alert = composeAdminAlert(composed.spec); // throws under NODE_ENV=test when a rule is broken
    expect(alert.headline).toBe(headline);
    expect(alert.why).toBe(why);
    expect(alert.link).toBe('/admin/ppc');
    expect(alert.metadata).toMatchObject({
      area: 'Leads', severity: 'needs-you', who: 'person', doneWhen: 'count_zero', subject: { type: 'check', id: 'ads-health:google' },
    });
    expect(composed.itemKeys).toEqual(itemKeys);
    for (const c of problems.campaigns) expect(composed.detail).toContain(c.name);
  });
});

describe('true', () => {
  beforeEach(() => { gates.adsHealthAlertsMode.mockReturnValue('true'); });

  test('a problem raises one standing bell that rings again only when a campaign or ad joins', async () => {
    google({ campaigns: [campaign({ primaryStatus: 'NOT_ELIGIBLE', reasons: ['HAS_ADS_DISAPPROVED'] })] });
    const result = await runAdsHealthAlerts({ now: NOW });
    expect(Episodes.raiseAdminAlertWithReopen).toHaveBeenCalledTimes(1);
    const [category, headline, why, opts] = Episodes.raiseAdminAlertWithReopen.mock.calls[0];
    expect([category, headline, why]).toEqual(['system', 'Leads — fix Test Search Campaign in Google Ads', 'Test Search Campaign cannot serve: Has ads disapproved.']);
    expect(opts).toMatchObject({
      dedupeKey: 'ads-health:google', bell: true, refreshOnDedupe: true, bumpOnRefresh: true, link: '/admin/ppc',
      metadata: { itemKeys: ['campaign:111'], count: 1, area: 'Leads', severity: 'needs-you', who: 'person' },
    });
    expect(opts.ringOnRefresh(null, { itemKeys: ['campaign:111'] })).toBe(false);
    expect(opts.ringOnRefresh(null, { itemKeys: ['campaign:111', 'ad:901'] })).toBe(false);
    expect(opts.ringOnRefresh(null, { itemKeys: ['ad:901'] })).toBe(true);
    expect(Episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(result.google).toEqual({ count: 1, outcome: 'raised' });
  });

  test('no problem closes the bell', async () => {
    google({ campaigns: [campaign()] });
    const result = await runAdsHealthAlerts({ now: NOW });
    expect(Episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(Episodes.closeAdminAlertKeys).toHaveBeenCalledWith(expect.anything(), ['ads-health:google'], 'count_zero',
      expect.objectContaining({ now: NOW, resolution: expect.stringMatching(/^Cleared: /) }));
    expect(result.google).toEqual({ count: 0, outcome: 'closed' });
  });

  test.each([
    ['the serving read', () => Health.servingSection.mockResolvedValue({ error: 'Google serving check failed' }), 'Google serving check failed'],
    ['the disapproved-ads query', () => mockCustomer.query.mockRejectedValue(new Error('synthetic query failure')), 'synthetic query failure'],
  ])('a Google read that fails (%s) leaves the bell as it is and fails the tick, after the upload row ran', async (_label, fail, message) => {
    fail();
    uploads({ googleRows: [uploadRow()] });
    await expect(runAdsHealthAlerts({ now: NOW })).rejects.toThrow(`ads health alerts: Google Ads read: ${message}`);
    expect(Episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(Episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(OpsDigest.deliverOpsDigest).toHaveBeenCalledTimes(1);
  });

  test("failed uploads and a Needs attention check go to Claude's queue as one engineering row", async () => {
    uploads({
      googleRows: [uploadRow({ id: 'g2' }), uploadRow({ id: 'g1', status: 'partial_success' })],
      metaRows: [uploadRow({ id: 'm1', conversion_type: 'completed_job_revenue' })],
      actions: [
        { name: 'Test - Qualified Lead', status: 'NEEDS_ATTENTION', alerts: [{ error: 'UNPARSEABLE_GCLID', percent: 12.5 }] },
        { name: 'Test - Job Revenue', status: 'EXCELLENT', alerts: [] },
      ],
    });
    const result = await runAdsHealthAlerts({ now: NOW });
    expect(OpsDigest.deliverOpsDigest).toHaveBeenCalledTimes(1);
    const args = OpsDigest.deliverOpsDigest.mock.calls[0][0];
    expect(args).toMatchObject({
      key: 'ads-upload-health', dedupeKey: 'ads-upload-health', audience: 'engineering', refreshOnDedupe: true, fallOff: true,
      link: '/admin/ppc', count: 4, itemKeys: ['check:Test - Qualified Lead', 'google:g1', 'google:g2', 'meta:m1'],
      headline: 'System — fix the ad conversion uploads',
      summary: 'Failed uploads in 2 days: Google 2 (1 partly refused), Meta 1; Google flags 1 action as Needs attention.',
      metadata: { area: 'System', severity: 'broken', who: 'claude', doneWhen: 'count_zero', subject: { type: 'check', id: 'ads-upload-health' } },
    });
    expect(args.subject).toMatch(/^FIX: /);
    expect(args.text).toContain('Unparseable gclid (12.5%)');
    expect(args.text).toContain('last try Thu, Nov 5 at 6:40 AM: Synthetic upload error');
    await expect(args.sendEmail()).resolves.toMatchObject({ ok: false });
    expect(FallOff.retireIfClean).not.toHaveBeenCalled();
    expect(result.uploads).toEqual({ count: 4, outcome: 'recorded' });
  });

  test('an upload row the Activity feed did not take fails the tick', async () => {
    uploads({ metaRows: [uploadRow({ id: 'm1' })] });
    OpsDigest.deliverOpsDigest.mockResolvedValueOnce({ ok: false, channel: 'email', fallback: true });
    await expect(runAdsHealthAlerts({ now: NOW })).rejects.toThrow('ads health alerts: upload alert: the upload alert row was not written');
  });

  test('a clean run retires the upload row', async () => {
    uploads({ actions: [{ name: 'Test - Qualified Lead', status: 'EXCELLENT', alerts: [] }] });
    const result = await runAdsHealthAlerts({ now: NOW });
    expect(OpsDigest.deliverOpsDigest).not.toHaveBeenCalled();
    expect(FallOff.retireIfClean).toHaveBeenCalledWith('ads-upload-health', { resolvedBy: 'ads-health-alerts:clean-run' });
    expect(result.uploads).toEqual({ count: 0, outcome: 'retired' });
  });

  test('an upload check Google refused leaves the upload row as it is; the bell still updates', async () => {
    Health.uploadCheckSection.mockResolvedValue({ error: "Google's upload check could not be read: synthetic" });
    await expect(runAdsHealthAlerts({ now: NOW })).rejects.toThrow('upload read');
    expect(OpsDigest.deliverOpsDigest).not.toHaveBeenCalled();
    expect(FallOff.retireIfClean).not.toHaveBeenCalled();
    expect(Episodes.closeAdminAlertKeys).toHaveBeenCalledTimes(1);
  });

  test('Google Ads not set up: the Google bell is skipped and the portal uploads are still checked', async () => {
    getCustomer.mockReturnValue(null);
    uploads({ metaRows: [uploadRow({ id: 'm1' })] });
    const result = await runAdsHealthAlerts({ now: NOW });
    expect(Health.servingSection).not.toHaveBeenCalled();
    expect(Health.uploadCheckSection).not.toHaveBeenCalled();
    expect(Episodes.raiseAdminAlertWithReopen).not.toHaveBeenCalled();
    expect(Episodes.closeAdminAlertKeys).not.toHaveBeenCalled();
    expect(OpsDigest.deliverOpsDigest.mock.calls[0][0].itemKeys).toEqual(['meta:m1']);
    expect(result.google).toBeNull();
  });
});

test('shadow writes no alert, and one audit row only when the problems change', async () => {
  gates.adsHealthAlertsMode.mockReturnValue('shadow');
  google({ campaigns: [campaign({ primaryStatus: 'MISCONFIGURED' })] });
  await expect(runAdsHealthAlerts({ now: NOW })).resolves.toMatchObject({ mode: 'shadow', recorded: true, google: 1, uploads: 0 });
  expect(AuditLog.recordAuditEvent).toHaveBeenCalledTimes(1);
  const first = AuditLog.recordAuditEvent.mock.calls[0][0];
  expect(first).toMatchObject({ actor_type: 'system', action: 'ads_health_alert.shadow', resource_type: 'notifications' });
  expect(first.metadata.google).toMatchObject({ itemKeys: ['campaign:111'], joined: ['campaign:111'], emptied: false });

  mockTables.audit_log = { metadata: first.metadata };
  await expect(runAdsHealthAlerts({ now: NOW })).resolves.toMatchObject({ recorded: false });
  expect(AuditLog.recordAuditEvent).toHaveBeenCalledTimes(1);

  google({ campaigns: [campaign()] });
  await runAdsHealthAlerts({ now: NOW });
  expect(AuditLog.recordAuditEvent).toHaveBeenCalledTimes(2);
  expect(AuditLog.recordAuditEvent.mock.calls[1][0].metadata.google).toMatchObject({ itemKeys: [], joined: [], emptied: true });

  for (const write of [Episodes.raiseAdminAlertWithReopen, Episodes.closeAdminAlertKeys, OpsDigest.deliverOpsDigest, FallOff.retireIfClean]) {
    expect(write).not.toHaveBeenCalled();
  }
});
