const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const logger = require('../services/logger');
const { etDateString } = require('../utils/datetime-et');

// Lazy-load heavy Google Ads modules (~87MB) — only loaded on first request
let _BudgetManager, _CampaignAdvisor, _googleAds;
function getBudgetManager() { return _BudgetManager || (_BudgetManager = require('../services/ads/budget-manager')); }
function getCampaignAdvisor() { return _CampaignAdvisor || (_CampaignAdvisor = require('../services/ads/campaign-advisor')); }
function getGoogleAds() { return _googleAds || (_googleAds = require('../services/ads/google-ads')); }

router.use(adminAuthenticate, requireTechOrAdmin);

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
    const d7 = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
    const d30 = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
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
router.post('/campaigns', async (req, res, next) => {
  try {
    const [campaign] = await db('ad_campaigns').insert(req.body).returning('*');
    res.json({ campaign });
  } catch (err) { next(err); }
});

// PUT /api/admin/ads/campaigns/:id
router.put('/campaigns/:id', async (req, res, next) => {
  try {
    const [campaign] = await db('ad_campaigns').where({ id: req.params.id }).update({ ...req.body, updated_at: new Date() }).returning('*');
    res.json({ campaign });
  } catch (err) { next(err); }
});

// POST /api/admin/ads/campaigns/:id/mode
router.post('/campaigns/:id/mode', async (req, res, next) => {
  try {
    const { mode, reason } = req.body;
    const result = await getBudgetManager().setMode(req.params.id, mode, reason || 'manual');
    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/ads/campaigns/:id/budget
router.post('/campaigns/:id/budget', async (req, res, next) => {
  try {
    const { budget, reason } = req.body;
    const result = await getBudgetManager().setBudget(req.params.id, budget, reason || 'manual');

    // Also update on Google Ads if campaign is linked
    const campaign = await db('ad_campaigns').where({ id: req.params.id }).first();
    if (campaign && campaign.platform_campaign_id && getGoogleAds().isConfigured()) {
      const gResult = await getGoogleAds().updateBudget(campaign.platform_campaign_id, budget);
      if (gResult) result.googleAdsUpdated = true;
    }

    res.json(result);
  } catch (err) { next(err); }
});

// POST /api/admin/ads/campaigns/:id/pause
router.post('/campaigns/:id/pause', async (req, res, next) => {
  try {
    const campaign = await db('ad_campaigns').where({ id: req.params.id }).first();
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

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
router.post('/campaigns/:id/enable', async (req, res, next) => {
  try {
    const campaign = await db('ad_campaigns').where({ id: req.params.id }).first();
    if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

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
router.post('/sync', async (req, res, next) => {
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

// =========================================================================
// SERVICE-LINE ANALYTICS
// =========================================================================

// GET /api/admin/ads/service-lines?period=30d
router.get('/service-lines', async (req, res, next) => {
  try {
    const periodDays = parseInt(req.query.period?.replace('d', '') || 30);
    const since = new Date(Date.now() - periodDays * 86400000).toISOString().split('T')[0];

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
    const since = new Date(Date.now() - periodDays * 86400000).toISOString().split('T')[0];

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
router.post('/advisor/generate', async (req, res, next) => {
  try {
    const advice = await getCampaignAdvisor().generateDailyAdvice();
    res.json({ report: advice });
  } catch (err) { next(err); }
});

// POST /api/admin/ads/advisor/apply — apply a recommendation
router.post('/advisor/apply', async (req, res, next) => {
  try {
    const { action, campaignId, campaignName, value, reason } = req.body;

    let result;
    switch (action) {
      case 'increase_budget':
      case 'decrease_budget':
        result = await getBudgetManager().setBudget(campaignId, value, reason || `Advisor: ${action}`);
        break;
      case 'change_mode':
        result = await getBudgetManager().setMode(campaignId, value, reason || `Advisor: set ${value}`);
        break;
      case 'add_negative':
        // Store the negative keyword request (actual Google Ads API integration later)
        result = { action: 'add_negative', terms: value, status: 'queued', note: 'Add these as negative keywords in Google Ads' };
        break;
      default:
        result = { action, status: 'noted', note: 'Manual action required' };
    }

    // Increment applied count for today's report
    await db('ad_advisor_reports')
      .where({ date: etDateString() })
      .increment('applied_count', 1);

    res.json({ success: true, result });
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

// GET /api/admin/ads/revenue-attribution?period=month
router.get('/revenue-attribution', async (req, res, next) => {
  try {
    const periodDays = req.query.period === 'quarter' ? 90 : req.query.period === 'ytd' ? 365 : 30;
    const since = new Date(Date.now() - periodDays * 86400000).toISOString().split('T')[0];

    const attributions = await db('ad_service_attribution')
      .where('lead_date', '>=', since)
      .where('funnel_stage', 'completed');

    const bySource = {};
    for (const a of attributions) {
      const src = a.lead_source || 'unknown';
      if (!bySource[src]) bySource[src] = { source: src, revenue: 0, adSpend: 0, customers: new Set() };
      bySource[src].revenue += parseFloat(a.completed_revenue || 0);
      bySource[src].adSpend += parseFloat(a.ad_cost || 0);
      if (a.customer_id) bySource[src].customers.add(a.customer_id);
    }

    const sources = Object.values(bySource).map(s => ({
      source: formatSourceName(s.source),
      sourceKey: s.source,
      revenue: round(s.revenue, 2),
      adSpend: round(s.adSpend, 2),
      roas: s.adSpend > 0 ? round(s.revenue / s.adSpend, 1) : null,
      customers: s.customers.size,
      cac: s.customers.size > 0 && s.adSpend > 0 ? round(s.adSpend / s.customers.size, 0) : 0,
    })).sort((a, b) => b.revenue - a.revenue);

    const totalRevenue = sources.reduce((s, r) => s + r.revenue, 0);
    const totalSpend = sources.reduce((s, r) => s + r.adSpend, 0);

    res.json({
      sources,
      totalRevenue: round(totalRevenue, 2),
      totalAdSpend: round(totalSpend, 2),
      blendedROAS: totalSpend > 0 ? round(totalRevenue / totalSpend, 1) : null,
    });
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
router.put('/targets', async (req, res, next) => {
  try {
    const targets = await db('ad_targets').first();
    if (targets) {
      await db('ad_targets').where({ id: targets.id }).update({ ...req.body, updated_at: new Date() });
    } else {
      await db('ad_targets').insert(req.body);
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

function formatSourceName(key) {
  const names = {
    google_ads: 'Google Ads',
    google_lsa: 'Google LSA',
    organic: 'Organic',
    referral: 'Referral',
    domain_website: 'Domain Sites',
    waves_website: 'Waves Website',
    google_business: 'Google Business',
    facebook: 'Facebook',
    nextdoor: 'Nextdoor',
  };
  return names[key] || formatServiceName(key);
}

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
