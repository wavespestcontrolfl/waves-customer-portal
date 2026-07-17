const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { buildChannelAttribution, splitFacebookByPaid } = require('../services/channel-attribution');
const { rankCapitalAllocation } = require('../services/capital-allocation');

// Lazy-load heavy Google Ads modules (~87MB) — only loaded on first request
let _BudgetManager, _CampaignAdvisor, _googleAds;
function getBudgetManager() { return _BudgetManager || (_BudgetManager = require('../services/ads/budget-manager')); }
function getCampaignAdvisor() { return _CampaignAdvisor || (_CampaignAdvisor = require('../services/ads/campaign-advisor')); }
function getGoogleAds() { return _googleAds || (_googleAds = require('../services/ads/google-ads')); }
let _metaAds;
function getMetaAds() { return _metaAds || (_metaAds = require('../services/ads/meta-ads')); }
let _GoogleCallBridge;
function getGoogleCallBridge() {
  return _GoogleCallBridge || (_GoogleCallBridge = require('../services/ads/google-call-bridge'));
}

// All ads endpoints require a signed-in staff member; the individual
// spend-mutating endpoints below additionally require `requireAdmin` (see each
// route). Reads stay tech-or-admin.
router.use(adminAuthenticate, requireTechOrAdmin);

// --- Write-body sanitizers -------------------------------------------------
// POST/PUT /campaigns and PUT /targets previously mass-assigned req.body
// straight into knex, so any column was settable. The canonical spend/identity
// fields (budget_mode, daily_budget_*, platform, platform_campaign_id, status)
// have dedicated endpoints that carry their own validation, audit log, and live
// Google sync — the generic create/update must never write them, so we reject
// them outright rather than silently drop, and validate the rest strictly.

// Strict numeric parse: rejects trailing garbage ('50junk') and blank strings
// that Number() would coerce to 0. Returns NaN on anything non-numeric.
function toFiniteNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  }
  return NaN;
}

// Known ad platforms (google_lsa + facebook are ingested read-only; only
// google_ads is remotely budget-controllable — that guard lives in setBudget/
// setMode). Matches ad_campaigns.platform's documented set.
const CAMPAIGN_PLATFORMS = ['google_ads', 'google_lsa', 'facebook'];
// Managed by /budget, /mode, /pause, /enable, /sync — never the generic writes.
const CAMPAIGN_MANAGED_FIELDS = ['budget_mode', 'daily_budget_base', 'daily_budget_current'];
// Settable only at creation (identity); an update must not repoint them.
const CAMPAIGN_CREATE_ONLY_FIELDS = ['platform', 'platform_campaign_id'];
// Free-form metadata columns editable via either create or update.
const CAMPAIGN_META_FIELDS = [
  'campaign_name', 'campaign_type', 'target_area', 'service_category',
  'target_services', 'intent_type', 'is_branded', 'service_line',
  'monthly_budget', 'metadata',
];

// Returns { ok:true, value } or { ok:false, error }.
function sanitizeCampaignWrite(body, isUpdate) {
  const forbidden = isUpdate
    ? [...CAMPAIGN_MANAGED_FIELDS, ...CAMPAIGN_CREATE_ONLY_FIELDS, 'status']
    : CAMPAIGN_MANAGED_FIELDS;
  for (const f of forbidden) {
    if (body[f] !== undefined) {
      return { ok: false, error: `${f} can't be set here — use the dedicated budget/mode/pause/enable/sync endpoints.` };
    }
  }

  const allow = isUpdate ? CAMPAIGN_META_FIELDS : [...CAMPAIGN_CREATE_ONLY_FIELDS, ...CAMPAIGN_META_FIELDS];
  const out = {};
  for (const key of allow) {
    if (body[key] === undefined) continue;
    out[key] = body[key];
  }

  if (!isUpdate) {
    if (out.platform !== undefined && !CAMPAIGN_PLATFORMS.includes(out.platform)) {
      return { ok: false, error: `platform must be one of: ${CAMPAIGN_PLATFORMS.join(', ')}` };
    }
    // External campaign IDs are numeric; a non-digit value would reach the
    // interpolated GAQL `WHERE campaign.id = ...` in google-ads.js.
    if (out.platform_campaign_id !== undefined && out.platform_campaign_id !== null
        && !/^\d+$/.test(String(out.platform_campaign_id))) {
      return { ok: false, error: 'platform_campaign_id must be digits only' };
    }
  }

  if (out.monthly_budget !== undefined && out.monthly_budget !== null) {
    const n = toFiniteNumber(out.monthly_budget);
    if (!(n >= 0)) return { ok: false, error: 'monthly_budget must be a number ≥ 0' };
    out.monthly_budget = n;
  }

  return { ok: true, value: out };
}

// ad_targets thresholds drive the autonomous capacity→budget cron, so they must
// stay ordered green < yellow < orange within 0–100 and the money/count fields
// must be sane; a mass-assigned capacity_green_max of 200 would read every
// campaign as green and hold budgets at full base regardless of real capacity.
const TARGET_WRITABLE = [
  'min_roas', 'max_cpa', 'min_conversion_rate', 'target_aov',
  'capacity_green_max', 'capacity_yellow_max', 'capacity_orange_max',
  'max_services_per_tech', 'metadata',
];
const TARGET_NONNEG = ['min_roas', 'max_cpa', 'min_conversion_rate', 'target_aov'];
const TARGET_PCT = ['capacity_green_max', 'capacity_yellow_max', 'capacity_orange_max'];

function sanitizeTargetsWrite(body, existing) {
  const out = {};
  for (const key of TARGET_WRITABLE) {
    if (body[key] === undefined) continue;
    out[key] = body[key];
  }
  for (const f of [...TARGET_NONNEG, ...TARGET_PCT]) {
    if (out[f] === undefined || out[f] === null) continue;
    const n = toFiniteNumber(out[f]);
    if (!(n >= 0)) return { ok: false, error: `${f} must be a number ≥ 0` };
    out[f] = n;
  }
  for (const f of TARGET_PCT) {
    if (out[f] !== undefined && out[f] > 100) return { ok: false, error: `${f} must be ≤ 100` };
  }
  if (out.max_services_per_tech !== undefined && out.max_services_per_tech !== null) {
    const n = toFiniteNumber(out.max_services_per_tech);
    if (!Number.isInteger(n) || n < 1) return { ok: false, error: 'max_services_per_tech must be an integer ≥ 1' };
    out.max_services_per_tech = n;
  }
  // Resolve the effective thresholds against what's already stored, then enforce
  // strict green < yellow < orange ordering on the merged result.
  const g = out.capacity_green_max ?? parseFloat(existing?.capacity_green_max ?? 70);
  const y = out.capacity_yellow_max ?? parseFloat(existing?.capacity_yellow_max ?? 85);
  const o = out.capacity_orange_max ?? parseFloat(existing?.capacity_orange_max ?? 95);
  if (!(g < y && y < o)) {
    return { ok: false, error: 'capacity thresholds must satisfy green < yellow < orange' };
  }
  return { ok: true, value: out };
}

// =========================================================================
// CAMPAIGNS CRUD
// =========================================================================

// GET /api/admin/ads/campaigns
router.get('/campaigns', async (req, res, next) => {
  try {
    const campaigns = await db('ad_campaigns')
      .where('status', '!=', 'removed')
      .orderBy('campaign_name');

    // Attach 7d & 30d perf summaries
    const d7 = etDateString(addETDays(new Date(), -7));
    const d30 = etDateString(addETDays(new Date(), -30));
    const perf7 = await db('ad_performance_daily').where('date', '>=', d7);
    const perf30 = await db('ad_performance_daily').where('date', '>=', d30);

    const enriched = campaigns.map(c => {
      const p7 = perf7.filter(p => p.campaign_id === c.id);
      const p30 = perf30.filter(p => p.campaign_id === c.id);
      return {
        ...c,
        last7d: aggregate(p7),
        last30d: aggregate(p30),
      };
    });

    res.json({ campaigns: enriched });
  } catch (err) { next(err); }
});

// POST /api/admin/ads/campaigns
router.post('/campaigns', requireAdmin, async (req, res, next) => {
  try {
    const clean = sanitizeCampaignWrite(req.body, false);
    if (!clean.ok) return res.status(400).json({ error: clean.error });
    const [campaign] = await db('ad_campaigns').insert(clean.value).returning('*');
    res.json({ campaign });
  } catch (err) { next(err); }
});

// PUT /api/admin/ads/campaigns/:id
router.put('/campaigns/:id', requireAdmin, async (req, res, next) => {
  try {
    const clean = sanitizeCampaignWrite(req.body, true);
    if (!clean.ok) return res.status(400).json({ error: clean.error });
    const [campaign] = await db('ad_campaigns')
      .where({ id: req.params.id })
      .update({ ...clean.value, updated_at: new Date() })
      .returning('*');
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    res.json({ campaign });
  } catch (err) { next(err); }
});

// POST /api/admin/ads/campaigns/:id/mode
router.post('/campaigns/:id/mode', requireAdmin, async (req, res, next) => {
  try {
    const { mode, reason } = req.body;
    // Mode rewrites budget_mode + daily_budget_current and pushes the new
    // budget to Google Ads when the campaign is linked; refuse Meta
    // (read-only) so the dashboard can't drift from Ads Manager.
    const campaign = await db('ad_campaigns').where({ id: req.params.id }).first();
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.platform !== 'google_ads') {
      return res.status(400).json({ error: `Budget mode isn't supported for ${campaign.platform} campaigns — manage them in their native Ads Manager.` });
    }
    const result = await getBudgetManager().setMode(req.params.id, mode, reason || 'manual');
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/ads/campaigns/:id/budget
router.post('/campaigns/:id/budget', requireAdmin, async (req, res, next) => {
  try {
    // Validate the amount here for a clean 400 (setBudget also validates as the
    // source-level backstop for its other caller, /advisor/apply). A daily
    // budget must be strictly positive — use mode 'stop' to throttle, not $0.
    const budget = toFiniteNumber(req.body.budget);
    if (!(budget > 0)) {
      return res.status(400).json({ error: 'budget must be a number > 0' });
    }
    // Only Google campaigns have remote control here — refuse Meta (read-only,
    // managed in Ads Manager) BEFORE mutating local budget, so the local row
    // can't drift from the real campaign.
    const campaign = await db('ad_campaigns').where({ id: req.params.id }).first();
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.platform !== 'google_ads') {
      return res.status(400).json({ error: `Budget control isn't supported for ${campaign.platform} campaigns — manage them in their native Ads Manager.` });
    }
    // setBudget now performs the mode-aware Google push itself (editing the base
    // while a campaign is throttled must not blast the raw new base live), so the
    // route no longer pushes separately with the raw value.
    const result = await getBudgetManager().setBudget(req.params.id, budget, req.body.reason || 'manual');
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/ads/campaigns/:id/pause
router.post('/campaigns/:id/pause', requireAdmin, async (req, res, next) => {
  try {
    const campaign = await db('ad_campaigns').where({ id: req.params.id }).first();
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.platform !== 'google_ads') {
      return res.status(400).json({ error: `Pause isn't supported for ${campaign.platform} campaigns — manage them in their native Ads Manager.` });
    }

    // Pause on Google Ads if linked
    let googleAdsResult = null;
    if (campaign.platform_campaign_id && getGoogleAds().isConfigured()) {
      googleAdsResult = await getGoogleAds().pauseCampaign(campaign.platform_campaign_id);
    }

    // Update local DB
    const [updated] = await db('ad_campaigns')
      .where({ id: req.params.id })
      .update({ status: 'paused', updated_at: new Date() })
      .returning('*');

    res.json({ campaign: updated, googleAdsUpdated: !!googleAdsResult });
  } catch (err) { next(err); }
});

// POST /api/admin/ads/campaigns/:id/enable
router.post('/campaigns/:id/enable', requireAdmin, async (req, res, next) => {
  try {
    const campaign = await db('ad_campaigns').where({ id: req.params.id }).first();
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
    if (campaign.platform !== 'google_ads') {
      return res.status(400).json({ error: `Enable isn't supported for ${campaign.platform} campaigns — manage them in their native Ads Manager.` });
    }

    // Enable on Google Ads if linked
    let googleAdsResult = null;
    if (campaign.platform_campaign_id && getGoogleAds().isConfigured()) {
      googleAdsResult = await getGoogleAds().enableCampaign(campaign.platform_campaign_id);
    }

    // Update local DB
    const [updated] = await db('ad_campaigns')
      .where({ id: req.params.id })
      .update({ status: 'active', updated_at: new Date() })
      .returning('*');

    res.json({ campaign: updated, googleAdsUpdated: !!googleAdsResult });
  } catch (err) { next(err); }
});

// POST /api/admin/ads/sync — trigger full Google Ads sync
router.post('/sync', requireAdmin, async (req, res, next) => {
  try {
    if (!getGoogleAds().isConfigured()) {
      return res.status(400).json({ error: 'Google Ads API not configured. Set GOOGLE_ADS_* environment variables.' });
    }

    const campaigns = await getGoogleAds().syncCampaigns();
    const performance = await getGoogleAds().syncDailyPerformance(7);
    const searchTerms = await getGoogleAds().syncSearchTerms(30);

    res.json({
      success: true,
      synced: {
        campaigns: campaigns.length,
        performanceRows: performance.length,
        searchTerms: searchTerms.length,
      },
    });
  } catch (err) { next(err); }
});

// POST /api/admin/ads/sync/meta — pull Meta (Facebook/Instagram) campaigns +
// daily insights into ad_campaigns/ad_performance_daily (platform='facebook').
router.post('/sync/meta', requireAdmin, async (req, res, next) => {
  try {
    if (!getMetaAds().isConfigured()) {
      return res.status(400).json({ error: 'Meta Ads API not configured. Set META_ADS_ACCESS_TOKEN + META_ADS_ACCOUNT_ID.' });
    }
    const campaigns = await getMetaAds().syncCampaigns();
    const performance = await getMetaAds().syncDailyPerformance(7);
    res.json({
      success: true,
      synced: { campaigns: campaigns.length, performanceRows: performance.length },
    });
  } catch (err) { next(err); }
});

// =========================================================================
// GOOGLE ADS CALL REPORTING BRIDGE
// =========================================================================

// GET /api/admin/ads/call-bridge?period=30d
router.get('/call-bridge', async (req, res, next) => {
  try {
    const periodDays = parseInt(String(req.query.period || '30d').replace('d', ''), 10) || 30;
    const limit = parseInt(req.query.limit, 10) || 200;
    const result = await getGoogleCallBridge().previewBridge({ days: periodDays, limit });
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/ads/call-bridge/apply
// Serialized with the 6:20 cron (bridge claim + unclaimed→organic fallback)
// under the SAME lease: a manual apply repoints leads.lead_source_id before it
// writes the paid funnel row, and the fallback sweeping concurrently off a
// stale selection could insert an organic row the paid write can't flip.
// try-lock semantics: if the cron holds the lease, the manual apply returns
// 409 rather than waiting — re-run it a minute later.
router.post('/call-bridge/apply', requireAdmin, async (req, res, next) => {
  try {
    const { runExclusive } = require('../utils/cron-lock');
    const periodDays = parseInt(String(req.body.period || '30d').replace('d', ''), 10) || 30;
    const limit = parseInt(req.body.limit, 10) || 200;
    const result = await runExclusive('google-call-bridge-organic', () => (
      getGoogleCallBridge().applyBridge({ days: periodDays, limit })
    ));
    if (result?.skipped && result?.reason) {
      return res.status(409).json({ error: 'Call bridge is currently running (daily cron or another apply) — try again in a minute.' });
    }
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// SERVICE-LINE ANALYTICS
// =========================================================================

// GET /api/admin/ads/service-lines?period=30d
router.get('/service-lines', async (req, res, next) => {
  try {
    const periodDays = parseInt(req.query.period?.replace('d', '') || 30);
    const since = etDateString(addETDays(new Date(), -periodDays));

    const attributions = await db('ad_service_attribution').where('lead_date', '>=', since);

    // By bucket
    const buckets = {};
    const byService = {};

    for (const a of attributions) {
      const bucket = a.service_bucket || 'unknown';
      const svc = a.specific_service || a.service_line || 'unknown';

      // Bucket aggregation
      if (!buckets[bucket]) {
        buckets[bucket] = { bucket, services: new Set(), leads: 0, booked: 0, completed: 0, adSpend: 0, bookedRevenue: 0, completedRevenue: 0, grossProfit: 0, ltvTotal: 0, recurringCount: 0 };
      }
      const b = buckets[bucket];
      b.services.add(formatServiceName(svc));
      b.leads++;
      if (['booked', 'completed'].includes(a.funnel_stage)) { b.booked++; b.bookedRevenue += parseFloat(a.booked_amount || 0); }
      if (a.funnel_stage === 'completed') { b.completed++; b.completedRevenue += parseFloat(a.completed_revenue || 0); b.grossProfit += parseFloat(a.gross_profit || 0); }
      b.adSpend += parseFloat(a.ad_cost || 0);
      if (a.is_recurring && a.projected_ltv_12mo) { b.ltvTotal += parseFloat(a.projected_ltv_12mo); b.recurringCount++; }

      // Per-service aggregation
      if (!byService[svc]) {
        byService[svc] = { service: formatServiceName(svc), leads: 0, booked: 0, completed: 0, adSpend: 0, completedRevenue: 0, ltvTotal: 0, recurringCount: 0, marginTotal: 0, marginCount: 0 };
      }
      const s = byService[svc];
      s.leads++;
      if (['booked', 'completed'].includes(a.funnel_stage)) s.booked++;
      if (a.funnel_stage === 'completed') { s.completed++; s.completedRevenue += parseFloat(a.completed_revenue || 0); }
      s.adSpend += parseFloat(a.ad_cost || 0);
      if (a.is_recurring && a.projected_ltv_12mo) { s.ltvTotal += parseFloat(a.projected_ltv_12mo); s.recurringCount++; }
      if (a.gross_margin_pct) { s.marginTotal += parseFloat(a.gross_margin_pct); s.marginCount++; }
    }

    // Format bucket output
    const byBucket = Object.values(buckets).map(b => {
      const leadToBookRate = b.leads > 0 ? round(b.booked / b.leads * 100, 1) : 0;
      const bookToCompleteRate = b.booked > 0 ? round(b.completed / b.booked * 100, 1) : 0;
      const costPerLead = b.leads > 0 ? round(b.adSpend / b.leads, 2) : 0;
      const costPerBookedJob = b.booked > 0 ? round(b.adSpend / b.booked, 2) : 0;
      const roas = b.adSpend > 0 ? round(b.completedRevenue / b.adSpend, 1) : 0;
      const avgTicket = b.completed > 0 ? round(b.completedRevenue / b.completed, 0) : 0;
      const grossMargin = b.completedRevenue > 0 ? round(b.grossProfit / b.completedRevenue * 100, 1) : 0;
      const projectedLTV12mo = b.ltvTotal;
      const ltvToCAC = b.recurringCount > 0 && costPerBookedJob > 0 ? round((b.ltvTotal / b.recurringCount) / costPerBookedJob, 1) : null;

      let verdict;
      if (b.bucket === 'recurring') verdict = ltvToCAC > 10 ? 'Strong — high LTV justifies higher acquisition cost' : 'Monitor — LTV:CAC could improve';
      else if (b.bucket === 'one_time_entry') verdict = roas >= 3 ? 'Good — fast close, decent margin. Push WaveGuard conversion.' : 'Marginal — review CPA and close rate';
      else if (b.bucket === 'high_ticket_specialty') verdict = roas >= 4 ? 'High value — fewer leads but massive ticket. Worth the higher CPA.' : 'Low volume — expand keyword coverage';
      else if (b.bucket === 'lawn_seasonal') verdict = roas >= 2 ? 'Seasonal opportunity — time-limited upside' : 'Marginal — better as upsell to existing customers than standalone ad target.';
      else verdict = '';

      return {
        bucket: b.bucket, services: Array.from(b.services), leads: b.leads, booked: b.booked, completed: b.completed,
        leadToBookRate, bookToCompleteRate, adSpend: round(b.adSpend, 2), costPerLead, costPerBookedJob,
        bookedRevenue: round(b.bookedRevenue, 2), completedRevenue: round(b.completedRevenue, 2),
        roas, avgTicket, grossMargin, projectedLTV12mo: round(projectedLTV12mo, 0), ltvToCAC, verdict,
      };
    }).sort((a, b) => b.completedRevenue - a.completedRevenue);

    // Format per-service output
    const bySpecificService = Object.values(byService).map(s => {
      const closeRate = s.leads > 0 ? round(s.booked / s.leads * 100, 1) : 0;
      const avgTicket = s.completed > 0 ? round(s.completedRevenue / s.completed, 0) : 0;
      const cpa = s.booked > 0 ? round(s.adSpend / s.booked, 2) : 0;
      const roas = s.adSpend > 0 ? round(s.completedRevenue / s.adSpend, 1) : 0;
      const margin = s.marginCount > 0 ? round(s.marginTotal / s.marginCount, 0) : null;
      const ltv12mo = s.recurringCount > 0 ? round(s.ltvTotal / s.recurringCount, 0) : null;
      const ltvROAS = ltv12mo && s.adSpend > 0 ? round(s.ltvTotal / s.adSpend, 1) : null;

      return {
        service: s.service, leads: s.leads, booked: s.booked, closeRate, avgTicket,
        adSpend: round(s.adSpend, 2), cpa, roas, margin, ltv12mo, ltvROAS,
      };
    }).sort((a, b) => b.leads - a.leads);

    res.json({ byBucket, bySpecificService, period: `${periodDays}d`, totalLeads: attributions.length });
  } catch (err) { next(err); }
});

// GET /api/admin/ads/funnel?service=rodent_exclusion
router.get('/funnel', async (req, res, next) => {
  try {
    const { service, bucket, period } = req.query;
    const periodDays = parseInt((period || '90d').replace('d', ''));
    const since = etDateString(addETDays(new Date(), -periodDays));

    let query = db('ad_service_attribution').where('lead_date', '>=', since);
    if (service) query = query.where('specific_service', service);
    if (bucket) query = query.where('service_bucket', bucket);

    const records = await query.orderBy('lead_date', 'desc');

    const stages = { lead: 0, contacted: 0, estimate_sent: 0, estimate_viewed: 0, booked: 0, completed: 0, lost: 0 };
    let totalSpend = 0, totalRevenue = 0, totalProfit = 0;

    for (const r of records) {
      stages[r.funnel_stage] = (stages[r.funnel_stage] || 0) + 1;
      totalSpend += parseFloat(r.ad_cost || 0);
      totalRevenue += parseFloat(r.completed_revenue || 0);
      totalProfit += parseFloat(r.gross_profit || 0);
    }

    res.json({
      funnel: stages,
      totalLeads: records.length,
      totalSpend: round(totalSpend, 2),
      totalRevenue: round(totalRevenue, 2),
      totalProfit: round(totalProfit, 2),
      roas: totalSpend > 0 ? round(totalRevenue / totalSpend, 1) : 0,
      records: records.slice(0, 50),
    });
  } catch (err) { next(err); }
});

// =========================================================================
// AI ADVISOR
// =========================================================================

// GET /api/admin/ads/advisor — latest report
router.get('/advisor', async (req, res, next) => {
  try {
    const report = await db('ad_advisor_reports').orderBy('date', 'desc').first();
    if (!report) return res.json({ report: null });
    res.json({ report: { ...report, report_data: typeof report.report_data === 'string' ? JSON.parse(report.report_data) : report.report_data } });
  } catch (err) { next(err); }
});

// GET /api/admin/ads/advisor/history
router.get('/advisor/history', async (req, res, next) => {
  try {
    const reports = await db('ad_advisor_reports')
      .orderBy('date', 'desc')
      .limit(30)
      .select('id', 'date', 'grade', 'recommendation_count', 'waste_alert_count', 'applied_count', 'created_at');
    res.json({ reports });
  } catch (err) { next(err); }
});

// POST /api/admin/ads/advisor/generate — manually trigger
router.post('/advisor/generate', requireAdmin, async (req, res, next) => {
  try {
    const advice = await getCampaignAdvisor().generateDailyAdvice();
    res.json({ report: advice });
  } catch (err) { next(err); }
});

// POST /api/admin/ads/advisor/apply — apply a recommendation
// Only budget/mode recommendations map to an automated change; everything else
// (add_negative, bid/keyword/SEO/GBP actions) is advisory and returns
// applied:false so the UI never claims an action it didn't take. Applies only
// when the campaign resolves and a concrete value is present; increments the
// day's applied_count only on a genuine apply.
// Runs a budget-manager call made with requireLivePush and maps its typed
// failures onto the honest applied:false contract ('live_push_unavailable' →
// 422, 'live_push_failed' → 502). Push-first means NOTHING was persisted on
// either failure — the reconcile cron has no recorded intent to retry later.
const APPLY_FAILED = Symbol('apply-failed');
async function applyLive(fn, res) {
  try {
    return await fn();
  } catch (err) {
    if (err.code === 'live_push_unavailable') {
      res.status(422).json({ applied: false, error: err.message });
      return APPLY_FAILED;
    }
    if (err.code === 'live_push_failed' || err.code === 'live_push_rolled_back' || err.code === 'live_push_ambiguous') {
      res.status(502).json({ applied: false, error: err.message });
      return APPLY_FAILED;
    }
    if (err.code === 'mode_conflict') {
      res.status(409).json({ applied: false, error: err.message });
      return APPLY_FAILED;
    }
    if (err.code === 'campaign_inactive') {
      res.status(422).json({ applied: false, error: err.message });
      return APPLY_FAILED;
    }
    throw err;
  }
}

router.post('/advisor/apply', requireAdmin, async (req, res, next) => {
  try {
    const { action, campaignId, campaignName, value, reason } = req.body;

    const isBudgetAction = action === 'increase_budget' || action === 'decrease_budget';
    if (!isBudgetAction && action !== 'change_mode') {
      // add_negative / adjust_bid / SEO / GBP / etc. — no automated action yet.
      return res.json({ applied: false, manual: true, note: 'This recommendation needs a manual change (no automated action for it yet).' });
    }

    // Prefer the stable id the advisor now carries; a bare name is a fallback
    // for older stored reports. campaign_name is NOT unique (Google vs Meta
    // rows, duplicated experiments), so a name matching more than one row is
    // rejected rather than mutating whichever row Postgres returns first.
    // The id is model output: a malformed one (not UUID-shaped) would 22P02
    // the uuid column into a 500, so it's ignored in favor of the name.
    const usableId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(campaignId || ''))
      ? campaignId : null;
    let campaign = null;
    if (usableId) {
      campaign = await db('ad_campaigns').where({ id: usableId }).first();
    } else if (campaignName) {
      const matches = await db('ad_campaigns')
        .whereRaw('lower(campaign_name) = ?', [String(campaignName).toLowerCase()])
        .select('*');
      if (matches.length > 1) {
        return res.status(422).json({ applied: false, error: `More than one campaign is named "${campaignName}" — apply this manually to the right one.` });
      }
      campaign = matches[0] || null;
    }
    if (!campaign) {
      return res.status(422).json({ applied: false, error: `Couldn't find a campaign named "${campaignName || ''}" to apply this to — adjust it manually.` });
    }
    // The advisor sees every platform's rows, but only Google campaigns are
    // remotely controllable (the budget manager throws on the rest — that
    // must surface as an honest "can't", not a 500).
    if (campaign.platform !== 'google_ads') {
      return res.status(422).json({ applied: false, manual: true, error: `"${campaign.campaign_name}" is a ${campaign.platform} campaign managed outside this dashboard — apply this in its own Ads Manager.` });
    }
    // The advisor sees every non-removed status; a paused campaign must not
    // take a budget/mode change that would silently revive it later with an
    // advisor-selected value.
    if (campaign.status !== 'active') {
      return res.status(422).json({ applied: false, error: `"${campaign.campaign_name}" is ${campaign.status || 'not active'} — re-enable it before applying advisor changes.` });
    }
    // The id is model output too: a rec can carry campaign A's id under
    // campaign B's name. The card shows the NAME, so a mismatch means the
    // click would mutate a different campaign than the admin approved.
    if (usableId && campaignName
      && String(campaign.campaign_name).toLowerCase() !== String(campaignName).toLowerCase()) {
      return res.status(422).json({ applied: false, error: `This recommendation's campaign id resolves to "${campaign.campaign_name}", not "${campaignName}" — the advisor mislabeled it. Apply the change manually.` });
    }

    let result;
    if (isBudgetAction) {
      const amount = toFiniteNumber(value);
      if (!(amount > 0)) {
        return res.status(422).json({ applied: false, error: 'This recommendation has no concrete target budget — set the budget manually.' });
      }
      // A throttled campaign ('spent'/'stop') deliberately runs a mode-derived
      // budget (frozen current / 1% of base), so setBudget would record the
      // new BASE but push the throttled amount — not the target this rec
      // claims. Applying it would report "$X/day set" while Google keeps the
      // cap. Mode changes go through change_mode recs; budget edits on a
      // throttled campaign are a manual, eyes-open action.
      if (campaign.budget_mode && campaign.budget_mode !== 'base') {
        return res.status(422).json({ applied: false, error: `"${campaign.campaign_name}" is throttled in "${campaign.budget_mode}" mode, so a new daily budget wouldn't take effect. Apply a change_mode recommendation (or set the mode to base) first, or edit the budget manually.` });
      }
      // Safety bound on AI-supplied budgets: apply_value is unvalidated model
      // output, and the card's prose can say "$30" while the value is 3000.
      // One click moves a budget at most 3× in either direction from the
      // campaign's known base (falling back to the current daily budget);
      // with NO recorded budget there is nothing trustworthy to bound an AI
      // number against, so the change is manual-only. Anything larger goes
      // through the manual budget editor, where the number is typed by hand.
      const baseBudget = toFiniteNumber(campaign.daily_budget_base);
      const boundRef = baseBudget > 0 ? baseBudget : toFiniteNumber(campaign.daily_budget_current);
      if (!(boundRef > 0)) {
        return res.status(422).json({ applied: false, error: 'This campaign has no recorded daily budget to sanity-check an AI-suggested amount against — set the budget manually in the campaign editor.' });
      }
      if (amount > boundRef * 3 || amount < boundRef / 3) {
        return res.status(422).json({ applied: false, error: `Refusing to one-click a budget change from $${boundRef}/day to $${amount}/day (more than a 3× move) — if that's really intended, set it in the campaign's budget editor.` });
      }
      // Known no-op (stale report / re-apply after success): base AND current
      // already match the target — counting it as applied would be the same
      // false green. A same-base apply with DRIFTED current stays allowed:
      // that push reconciles the live budget back to the recorded base.
      if (amount === baseBudget && amount === toFiniteNumber(campaign.daily_budget_current)) {
        return res.status(422).json({ applied: false, error: `"${campaign.campaign_name}" is already at $${amount}/day — nothing to apply.` });
      }
      result = await applyLive(() => getBudgetManager().setBudget(campaign.id, amount, reason || `Advisor: ${action}`, { requireLivePush: true, requireBaseMode: true, requireActive: true, trigger: 'advisor' }), res);
      if (result === APPLY_FAILED) return undefined;
    } else {
      if (!['base', 'spent', 'stop'].includes(value)) {
        return res.status(422).json({ applied: false, error: 'This recommendation has no concrete mode (base/spent/stop) — set the mode manually.' });
      }
      // A rec targeting the mode the campaign is already in is a no-op — the
      // fallback advisor emits STOP for every low-ROAS campaign without
      // checking, and reporting "applied" for zero state change is the same
      // false green this endpoint exists to prevent.
      if (value === campaign.budget_mode) {
        return res.status(422).json({ applied: false, error: `"${campaign.campaign_name}" is already in ${value} mode — nothing to apply.` });
      }
      result = await applyLive(() => getBudgetManager().setMode(campaign.id, value, reason || `Advisor: set ${value}`, { requireLivePush: true, requireActive: true, trigger: 'advisor' }), res);
      if (result === APPLY_FAILED) return undefined;
    }

    // Count only genuinely-applied actions against today's report. Reporting
    // only: the live mutation is already done, so a transient failure here
    // must not flip the response to "not applied" (the admin would retry and
    // push the same change live twice).
    try {
      await db('ad_advisor_reports')
        .where({ date: etDateString() })
        .increment('applied_count', 1);
    } catch (err) {
      logger.warn(`[ads] advisor apply succeeded but applied_count increment failed: ${err.message}`);
    }

    res.json({ applied: true, result });
  } catch (err) { next(err); }
});

// =========================================================================
// CAPACITY HEATMAP
// =========================================================================

// GET /api/admin/ads/capacity-heatmap
router.get('/capacity-heatmap', async (req, res, next) => {
  try {
    const result = await getBudgetManager().getWeeklyHeatmap(req.query.week);
    res.json(result);
  } catch (err) { next(err); }
});

// =========================================================================
// AD ATTRIBUTION FOR REVENUE PAGE
// =========================================================================

// Optional row exclusions for fetchChannelAttribution, mirroring the dashboard
// lead-funnel handler's parity rules (soft-deleted leads drop out; internal/test
// names excluded via the linked lead OR customer — both joins LEFT and the name
// expressions COALESCE to '', so unlinked rows are never silently dropped). Only
// the dashboard's /channel-roi passes this; without it the ads routes' existing
// behavior is unchanged (aligning them is a separate owner decision).
function applyAttributionExclusions(qb, exclude) {
  if (!exclude) return qb;
  qb.leftJoin('leads as l', 'l.id', 'asa.lead_id')
    .leftJoin('customers as c', 'c.id', 'asa.customer_id');
  if (exclude.deletedLeads) qb.whereRaw('(asa.lead_id IS NULL OR l.deleted_at IS NULL)');
  const names = exclude.internalNames || [];
  if (names.length) {
    const marks = names.map(() => '?').join(',');
    qb.whereRaw(
      `LOWER(COALESCE(l.first_name, '') || ' ' || COALESCE(l.last_name, '')) NOT IN (${marks})`,
      names,
    ).whereRaw(
      `LOWER(COALESCE(c.first_name, '') || ' ' || COALESCE(c.last_name, '')) NOT IN (${marks})`,
      names,
    );
  }
  return qb;
}

// Shared channel attribution: completed-lead revenue/GP/customers + TRUE platform
// spend (ad_performance_daily by platform, so a paid channel-month with spend but
// zero tracked leads still surfaces, with no cent-rounding drift). Platform values
// equal the paid lead_source keys (google_ads / google_lsa / facebook).
async function fetchChannelAttribution(since, months = 1, exclude = null) {
  const completedRaw = await applyAttributionExclusions(
    db('ad_service_attribution as asa')
      .where('asa.lead_date', '>=', since)
      .where('asa.funnel_stage', 'completed')
      .select(
        'asa.lead_source', 'asa.completed_revenue', 'asa.gross_profit', 'asa.projected_ltv_12mo',
        'asa.is_recurring', 'asa.customer_id', 'asa.fbclid', 'asa.fbc', 'asa.is_paid',
        // lead_date/created_at feed the builder's first-touch pick so a
        // customer's completed-visit count lands on the same row the
        // attribution sync wrote their realized revenue to.
        'asa.lead_date', 'asa.created_at',
      ),
    exclude,
  );
  // Split organic Facebook off the paid Meta bucket so organic-social completions
  // don't inflate the paid ratio (organic facebook still shows as its own channel).
  const completed = splitFacebookByPaid(completedRaw);

  // Jobs = completed COSTED VISITS credited to the channel — the same job_costs
  // ⨝ completed scheduled_services set ad-attribution-sync's customerRealized
  // sums the realized revenue from, bounded by each customer's first-touch
  // lead_date so pre-lead history stays uncredited here too. NOT a count of
  // attribution rows: the sync writes a customer's whole realized total onto
  // ONE primary row, so row-counting would call a 5-visit repeat customer one
  // "job" and inflate cost/job. Guarded like customerRealized — a pre-costing
  // environment just reports zero jobs.
  const jobsByCustomer = {};
  try {
    const jobRows = await db('job_costs as jc')
      .join('scheduled_services as ss', 'ss.id', 'jc.scheduled_service_id')
      .join(
        db('ad_service_attribution')
          .select('customer_id')
          .min({ lead_date: 'lead_date' })
          .where('funnel_stage', 'completed')
          .where('lead_date', '>=', since)
          .whereNotNull('customer_id')
          .groupBy('customer_id')
          .as('first'),
        'first.customer_id',
        'jc.customer_id',
      )
      .where('ss.status', 'completed')
      .whereRaw('jc.service_date >= first.lead_date')
      .groupBy('jc.customer_id')
      .select('jc.customer_id', db.raw('COUNT(*) as visits'));
    for (const r of jobRows) jobsByCustomer[r.customer_id] = Number(r.visits) || 0;
  } catch { /* job_costs / service_date not present — jobs stay 0, like the sync no-op */ }

  const spendRows = await db('ad_performance_daily as apd')
    .join('ad_campaigns as ac', 'ac.id', 'apd.campaign_id')
    .where('apd.date', '>=', since)
    .groupBy('ac.platform')
    .select('ac.platform', db.raw('SUM(apd.cost) as spend'));
  const platformSpendBySource = {};
  for (const r of spendRows) platformSpendBySource[r.platform] = parseFloat(r.spend) || 0;

  // Fixed per-channel costs (SEO retainer, ad-management fees) over the window =
  // monthly_amount × months. The non-ad-platform side of all-in CAC. Guarded so a
  // missing table (pre-migration) is a no-op.
  const fixedCostBySource = {};
  try {
    const fixedRows = await db('channel_fixed_costs').select('channel', 'monthly_amount');
    for (const r of fixedRows) {
      const amt = round((parseFloat(r.monthly_amount) || 0) * months, 2);
      if (amt > 0) fixedCostBySource[r.channel] = amt;
    }
  } catch { /* channel_fixed_costs not present yet */ }

  // Referral cost is PER-CONVERSION (referrer reward + referee discount), not a flat
  // monthly fee. Read the CURRENT reward from referral_program_settings via the
  // referral engine's getSettings (same defaults) so the card auto-tracks a reward
  // change instead of pinning to a stale figure — then cost the channel at that ×
  // its converted (completed) referral customers in the window, so the card divides
  // by the same count → a true CAC (default $25 + $25 = $50). Guarded / no-op.
  try {
    let perConversion = 50; // fallback ONLY if the settings row can't be read
    try {
      const s = await require('../services/referral-engine').getSettings();
      // Trust the configured reward even when it's a deliberate $0 (incentives off) —
      // that's free acquisition, not "no settings". Only the catch (unreadable
      // settings) keeps the $25+$25 default.
      perConversion = ((Number(s?.referrer_reward_cents) || 0) + (Number(s?.referee_discount_cents) || 0)) / 100;
    } catch { /* settings unreadable — keep the default */ }
    // Same exclusions as the completed rows — an excluded internal/deleted
    // "conversion" must not add reward cost the card's rows don't show.
    const [{ n }] = await applyAttributionExclusions(
      db('ad_service_attribution as asa')
        .where({ 'asa.lead_source': 'referral', 'asa.funnel_stage': 'completed' })
        .where('asa.lead_date', '>=', since),
      exclude,
    ).countDistinct({ n: 'asa.customer_id' });
    const refCost = round((Number(n) || 0) * perConversion, 2);
    if (refCost > 0) fixedCostBySource.referral = (fixedCostBySource.referral || 0) + refCost;
  } catch { /* ad_service_attribution shape / no referrals — no-op */ }

  const { sources, ...totals } = buildChannelAttribution(completed, platformSpendBySource, fixedCostBySource, jobsByCustomer);
  return { sources: sources.map((s) => ({ source: formatSourceName(s.sourceKey), ...s })), ...totals };
}

function periodWindow(period) {
  const periodDays = period === 'quarter' ? 90 : period === 'ytd' ? 365 : 30;
  // months = the actual span of THIS window (avg month = 30.44 days), so fixed
  // costs (monthly_amount × months) are prorated to exactly the window the ad
  // spend covers — never a full year on a shorter window. ('ytd' here is a
  // trailing-365 window, matching the rest of this endpoint's period handling.)
  return {
    since: etDateString(addETDays(new Date(), -periodDays)),
    months: periodDays / 30.44,
  };
}

// GET /api/admin/ads/revenue-attribution?period=month
router.get('/revenue-attribution', async (req, res, next) => {
  try {
    const { since, months } = periodWindow(req.query.period);
    res.json(await fetchChannelAttribution(since, months));
  } catch (err) { next(err); }
});

// GET /api/admin/ads/fixed-costs — per-channel monthly fixed acquisition costs.
router.get('/fixed-costs', async (req, res, next) => {
  try {
    const rows = await db('channel_fixed_costs').orderBy('channel')
      .select('channel', 'monthly_amount', 'note', 'updated_at')
      .catch(() => []);
    res.json({
      fixedCosts: rows.map((r) => ({
        channel: r.channel,
        source: formatSourceName(r.channel),
        monthlyAmount: parseFloat(r.monthly_amount) || 0,
        note: r.note || null,
        updatedAt: r.updated_at,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/ads/fixed-costs — upsert a channel's monthly fixed cost.
// { channel, monthlyAmount, note } — channel is the lead_source key (organic / google_ads / …).
router.post('/fixed-costs', requireAdmin, async (req, res, next) => {
  try {
    const channel = String(req.body.channel || '').trim();
    if (!channel) return res.status(400).json({ error: 'channel is required' });
    // Require a finite amount ≥ 0. Don't coerce a missing/NaN value to 0 — that
    // would silently wipe a configured retainer/fee (0 IS valid for clearing one).
    const raw = req.body.monthlyAmount;
    const monthly_amount = typeof raw === 'number' ? raw : parseFloat(raw);
    if (!Number.isFinite(monthly_amount) || monthly_amount < 0) {
      return res.status(400).json({ error: 'monthlyAmount must be a number ≥ 0' });
    }
    const note = req.body.note != null ? String(req.body.note).slice(0, 500) : null;
    await db('channel_fixed_costs')
      .insert({ channel, monthly_amount, note, created_at: new Date(), updated_at: new Date() })
      .onConflict('channel')
      .merge({ monthly_amount, note, updated_at: new Date() });
    res.json({ success: true, channel, monthlyAmount: monthly_amount });
  } catch (err) { next(err); }
});

// GET /api/admin/ads/capital-allocation?period=quarter
// Channels banded by LTV:CAC into a "where to dump cash" decision surface.
// Paid/organic Facebook is split in fetchChannelAttribution (splitFacebookByPaid)
// so organic-social completions don't inflate the paid Meta ratio. Residual: a paid
// Meta click whose fbclid/_fbc was stripped but that carried utm_medium=cpc is the
// one case still missed (utm_medium isn't persisted) — minor + no live impact while
// Meta is dark (META_ADS_* unprovisioned).
router.get('/capital-allocation', async (req, res, next) => {
  try {
    const { since, months } = periodWindow(req.query.period);
    const attribution = await fetchChannelAttribution(since, months);
    res.json(rankCapitalAllocation(attribution));
  } catch (err) { next(err); }
});

// =========================================================================
// BUDGET LOG
// =========================================================================

// GET /api/admin/ads/budget-log
router.get('/budget-log', async (req, res, next) => {
  try {
    const log = await db('ad_budget_log').orderBy('created_at', 'desc').limit(50);
    res.json({ log });
  } catch (err) { next(err); }
});

// =========================================================================
// TARGETS
// =========================================================================

// GET /api/admin/ads/targets
router.get('/targets', async (req, res, next) => {
  try {
    const targets = await db('ad_targets').first();
    res.json({ targets });
  } catch (err) { next(err); }
});

// PUT /api/admin/ads/targets
router.put('/targets', requireAdmin, async (req, res, next) => {
  try {
    const targets = await db('ad_targets').first();
    const clean = sanitizeTargetsWrite(req.body, targets);
    if (!clean.ok) return res.status(400).json({ error: clean.error });
    if (targets) {
      await db('ad_targets').where({ id: targets.id }).update({ ...clean.value, updated_at: new Date() });
    } else {
      await db('ad_targets').insert(clean.value);
    }
    res.json({ success: true });
  } catch (err) { next(err); }
});

// =========================================================================
// HELPERS
// =========================================================================

function round(n, decimals) {
  const f = Math.pow(10, decimals);
  return Math.round((n || 0) * f) / f;
}

function formatServiceName(key) {
  if (!key) return 'Unknown';
  return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Canonical map now lives in services/source-names.js (shared with the
// dashboard lead-funnel card) — same one-copy rule as classifyServiceLine.
const { formatSourceName } = require('../services/source-names');

function aggregate(rows) {
  const spend = rows.reduce((s, r) => s + parseFloat(r.cost || 0), 0);
  const value = rows.reduce((s, r) => s + parseFloat(r.conversion_value || 0), 0);
  const conv = rows.reduce((s, r) => s + parseFloat(r.conversions || 0), 0);
  const clicks = rows.reduce((s, r) => s + (parseInt(r.clicks) || 0), 0);
  const imps = rows.reduce((s, r) => s + (parseInt(r.impressions) || 0), 0);
  return {
    spend: round(spend, 2), conversionValue: round(value, 2),
    roas: spend > 0 ? round(value / spend, 1) : 0,
    conversions: round(conv, 1), clicks, impressions: imps,
    cpa: conv > 0 ? round(spend / conv, 2) : 0,
    ctr: imps > 0 ? round(clicks / imps * 100, 2) : 0,
  };
}

module.exports = router;
// Shared with the dashboard's Channel ROI card (routes/admin-dashboard.js
// /channel-roi) so both surfaces read ONE attribution/spend basis — the
// dashboard only swaps in its own window semantics (ET calendar periods +
// attribution fresh-start floor) for this file's trailing-days windows.
module.exports.fetchChannelAttribution = fetchChannelAttribution;
