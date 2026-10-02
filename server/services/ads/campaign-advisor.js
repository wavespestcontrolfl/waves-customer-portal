const db = require('../../models/db');
const logger = require('../logger');
const BudgetManager = require('./budget-manager');
const MODELS = require('../../config/models');
const { etDateString, addETDays } = require('../../utils/datetime-et');
const { publicPortalUrl } = require('../../utils/portal-url');
const { dispatchWithFallback } = require('../llm/call');

// The SDK path ran on its 10-minute default request timeout; keep that as the
// shared two-leg ceiling.
const ADVISOR_TIMEOUT_MS = 10 * 60 * 1000;
// Fable always thinks; thinking tokens count against max_tokens (call.js floors
// it at 8192 for such models). Leave room for the thinking AND the full JSON
// report so a thorough day is not truncated into a rejected leg.
const ADVISOR_MAX_TOKENS = 16000;
// Search terms with spend, passed to the model so waste detection is complete
// (bounded: the query below also caps the rows it reads).
const ADVISOR_MAX_SEARCH_TERMS = 100;


let TwilioService;
try { TwilioService = require('../twilio'); } catch { TwilioService = null; }

let SearchConsole;
try { SearchConsole = require('../seo/search-console-v2'); } catch { SearchConsole = null; }

// Lazy: whether the Google Ads client can actually push. Apply buttons on
// LINKED campaigns are stripped when it can't — both locked manager paths
// throw live_push_unavailable for linked rows without a configured client,
// so the button would deterministically fail (preview envs, credential
// outages).
let _adsClient;
function adsClientConfigured() {
  try {
    if (!_adsClient) _adsClient = require('./google-ads');
    return Boolean(_adsClient.isConfigured());
  } catch { return false; }
}

// storeReport writes `grade` with no fallback (an undefined value there is
// an undefined DB binding — Knex throws, storeReport's own try/catch
// swallows it, and the daily report is silently never persisted) and the
// list fields feed `.length` / iteration in storeReport and
// normalizeRecommendations; the SMS summary reads grade and
// overall_assessment straight off the object. The old validate only checked
// "object, not array" — a reply like `{}` passed it and produced exactly
// that silent no-op. Every item the Ads page and SMS render must also be
// usable as given, so an off-contract answer fails its leg (the next
// provider gets a turn) instead of being rewritten or trimmed after it was
// accepted (Codex r14 + review on #4884):
//  - a recommendation needs a non-empty `action`, a priority of high/medium/
//    low (any case — the page groups by exact priority, so anything else
//    would never be shown), and text-only rendered fields (the page renders
//    them as React children, where an object throws; a {} rec was texted as
//    "• undefined");
//  - each secondary-list item needs its label and text-only rendered fields,
//    and each insight must be non-empty text.
// Same shape as seo-advisor.js's isUsableSeoReport.
const ADS_REPORT_OBJECT_LISTS = ['recommendations', 'waste_alerts', 'scaling_opportunities', 'capacity_warnings', 'seo_insights'];
const ADS_PRIORITIES = new Set(['high', 'medium', 'low']);
const isRenderable = (v) => v == null || typeof v === 'string' || typeof v === 'number';
const canonicalGrade = (v) => {
  const g = typeof v === 'string' ? v.trim().toUpperCase() : '';
  return /^[ABCDF][+-]?$/.test(g) ? g : null;
};
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const canonicalPriority = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
// [label, ...other rendered fields] per secondary list.
const ADS_LIST_FIELDS = {
  waste_alerts: ['search_term', 'spend', 'conversions', 'action'],
  scaling_opportunities: ['campaign', 'current_budget', 'suggested_budget', 'headroom_reason'],
  capacity_warnings: ['area', 'utilization', 'recommendation'],
  seo_insights: ['detail', 'type', 'action'],
};
// Owner ruling 2026-10-01 applies to secondary findings too: each must rest
// on numbers, so a placeholder row ("Update metadata") fails the leg and the
// backup provider runs instead. Numeric fields may arrive as numeric strings.
const isNumberLike = (v) => (typeof v === 'number' || (typeof v === 'string' && v.trim() !== ''))
  && Number.isFinite(Number(v));
const ADS_LIST_EVIDENCE = {
  waste_alerts: (item) => isNumberLike(item.spend) && isNumberLike(item.conversions),
  scaling_opportunities: (item) => isNumberLike(item.current_budget) && isNumberLike(item.suggested_budget),
  capacity_warnings: (item) => isNumberLike(item.utilization),
  seo_insights: (item) => hasNumericEvidence(item.detail),
};
// apply_action / manual_action feed `.replace()` on the page's manual-action
// hint, so a non-string one crashed the view (Codex r20 on #4884).
// Owner ruling 2026-10-01: every recommendation must rest on the numbers
// given, so `reasoning` is required text carrying at least one figure — an
// unsupported rec (which may carry a one-click budget Apply) fails the leg.
const hasNumericEvidence = (v) => isText(v) && /\d/.test(v);
function isUsableRecommendation(rec) {
  return isText(rec.action) && ADS_PRIORITIES.has(canonicalPriority(rec.priority))
    && hasNumericEvidence(rec.reasoning)
    && ['campaign', 'reasoning', 'estimated_impact', 'apply_value', 'campaign_id'].every((k) => isRenderable(rec[k]))
    && ['apply_action', 'manual_action'].every((k) => rec[k] == null || typeof rec[k] === 'string');
}
function isUsableAdsReport(advice) {
  if (!advice || typeof advice !== 'object' || Array.isArray(advice)) return false;
  // The documented A/B/C/D/F (a +/- is kept): the pages colour a grade by
  // its first letter, so " A " or "Excellent" showed the wrong status (Codex r21).
  if (!canonicalGrade(advice.grade)) return false;
  if (typeof advice.overall_assessment !== 'string' || !advice.overall_assessment.trim()) return false;
  if (advice.insights != null && !(Array.isArray(advice.insights) && advice.insights.every(isText))) return false;
  const listsOk = ADS_REPORT_OBJECT_LISTS.every((key) => advice[key] == null || (Array.isArray(advice[key]) && advice[key].every((v) => v && typeof v === 'object' && !Array.isArray(v))));
  if (!listsOk) return false;
  // Required (may be empty): an omitted list is an off-contract answer, not a
  // deliberate "nothing to change" — it must not be texted as one.
  if (!Array.isArray(advice.recommendations) || !advice.recommendations.every(isUsableRecommendation)) return false;
  // Same for every action-bearing secondary list: a missing one is an
  // incomplete answer, and the SMS summary / empty state would otherwise read
  // it as "nothing flagged".
  if (!Object.keys(ADS_LIST_FIELDS).every((key) => Array.isArray(advice[key]))) return false;
  return Object.entries(ADS_LIST_FIELDS).every(([key, [label, ...fields]]) => advice[key] == null
    || advice[key].every((item) => isText(item[label]) && fields.every((f) => isRenderable(item[f]))
      && ADS_LIST_EVIDENCE[key](item)));
}

// After the leg was accepted: the only rewrite is the case of a priority the
// check already accepted ("High" → "high"), so the page's exact grouping
// shows it.
function normalizeAdsReport(advice) {
  advice.grade = canonicalGrade(advice.grade) || advice.grade;
  if (Array.isArray(advice.recommendations)) {
    for (const rec of advice.recommendations) rec.priority = canonicalPriority(rec.priority);
  }
  return advice;
}

// Hard cap on budget-change rows put in the prompt. The prompt tells the model
// this list is what changed in the 7-day window, so it carries every row in the
// window up to this bound (a note says so when the window held more).
const ADVISOR_MAX_BUDGET_CHANGES = 200;
// Search-term rows not refreshed within this window fell out of the latest sync.
const ADVISOR_SEARCH_TERM_FRESH_MS = 48 * 60 * 60 * 1000;
// Written by google-ads.syncSearchTerms (same key, exported there as SEARCH_TERMS_SYNCED_KEY).
const SEARCH_TERMS_SYNCED_KEY = 'ads.search_terms.last_synced_at';

// Secondary lists an SMS summary falls back to when there are no recommendations.
const SUMMARY_SECONDARY_LISTS = [
  ['waste_alerts', 'Waste alerts'],
  ['scaling_opportunities', 'Scaling opportunities'],
  ['capacity_warnings', 'Capacity warnings'],
  ['seo_insights', 'SEO insights'],
];

async function loadGscSummary() {
  try {
    if (!SearchConsole) return null;
    const gsc = await SearchConsole.getPerformanceSummary(28);
    if (!(gsc.current.clicks > 0)) return null;
    return {
      totalClicks: gsc.current.clicks,
      totalImpressions: gsc.current.impressions,
      ctr: (gsc.current.ctr * 100).toFixed(2) + '%',
      brandedClicks: gsc.current.brandedClicks,
      nonbrandClicks: gsc.current.nonbrandClicks,
      clicksChange: gsc.change.clicks + '%',
      nonbrandChange: gsc.change.nonbrandClicks + '%',
      topNonBrandQueries: (gsc.topQueries || []).filter(q => !q.is_branded).slice(0, 10).map(q => ({
        query: q.query, clicks: parseInt(q.clicks), impressions: parseInt(q.impressions),
        position: parseFloat(q.avg_position).toFixed(1), service: q.service_category,
      })),
      page2Opportunities: (gsc.opportunities || []).slice(0, 10).map(q => ({
        query: q.query, impressions: parseInt(q.impressions), position: parseFloat(q.avg_position).toFixed(1),
      })),
      decliningQueries: (gsc.declining || []).slice(0, 5),
    };
  } catch (err) {
    logger.warn(`GSC data for advisor: ${err.message}`);
    return null;
  }
}

async function loadGbpSummary(d30) {
  try {
    const gbp = await db('gbp_performance_daily').where('date', '>=', d30);
    if (gbp.length === 0) return null;
    const byLoc = {};
    for (const r of gbp) {
      const loc = r.location_name || 'unknown';
      if (!byLoc[loc]) byLoc[loc] = { calls: 0, websiteClicks: 0, directionRequests: 0 };
      byLoc[loc].calls += r.calls || 0;
      byLoc[loc].websiteClicks += r.website_clicks || 0;
      byLoc[loc].directionRequests += r.direction_requests || 0;
    }
    return byLoc;
  } catch (err) {
    logger.warn(`GBP data for advisor: ${err.message}`);
    return null;
  }
}

const numOrNull = (v) => (v == null ? null : Number(v));


function budgetChangesSection(budgetLog) {
  const rows = budgetLog.slice(0, ADVISOR_MAX_BUDGET_CHANGES).map(b => ({
    campaign: b.campaign_name, campaign_id: b.campaign_id, at: b.created_at, from: b.previous_mode, to: b.new_mode,
    budget_from: numOrNull(b.previous_budget),
    budget_to: numOrNull(b.new_budget),
    trigger: b.trigger, reason: b.reason,
  }));
  const note = budgetLog.length > ADVISOR_MAX_BUDGET_CHANGES
    ? `\n(Only the ${ADVISOR_MAX_BUDGET_CHANGES} most recent changes are listed; older changes in the 7-day window are omitted.)`
    : '';
  return JSON.stringify(rows) + note;
}

function searchTermsSection(searchTerms, available = true) {
  // No row refreshed within the freshness window means the sync is down or
  // unconfigured: say the data is missing so an outage never reads as zero spend.
  if (!available) {
    return `(UNAVAILABLE: no complete search-term sync in the last ${ADVISOR_SEARCH_TERM_FRESH_MS / 3600000} hours. Search-term data is missing, not zero; draw no conclusions about search-term waste.)`;
  }
  const spent = searchTerms.filter((t) => Number(t.cost) > 0);
  const rows = JSON.stringify(spent.slice(0, ADVISOR_MAX_SEARCH_TERMS).map(t => ({
    term: t.search_term, clicks: t.clicks, spend: Number(t.cost),
    conversions: Number(t.conversions), convValue: Number(t.conversion_value), roas: Number(t.roas),
  })), null, 2);
  // The query reads one row past the cap so a truncated list is disclosed
  // rather than presented as every term that cost money.
  return spent.length > ADVISOR_MAX_SEARCH_TERMS
    ? `${rows}\n(TRUNCATED: only the ${ADVISOR_MAX_SEARCH_TERMS} highest-spend terms are listed; more terms had spend. Do not conclude there is no other waste.)`
    : rows;
}

function gscSection(gscSummary) {
  if (!gscSummary) return '(No GSC data available)';
  return `
GOOGLE SEARCH CONSOLE (organic search, last 28 days):
Total organic clicks: ${gscSummary.totalClicks} (${gscSummary.clicksChange} vs prev)
Non-brand clicks: ${gscSummary.nonbrandClicks} (${gscSummary.nonbrandChange} vs prev)
Branded clicks: ${gscSummary.brandedClicks}
CTR: ${gscSummary.ctr}

Top non-brand queries:
${JSON.stringify(gscSummary.topNonBrandQueries, null, 2)}

Page 2 opportunities (positions 4-15):
${JSON.stringify(gscSummary.page2Opportunities, null, 2)}

Declining queries:
${JSON.stringify(gscSummary.decliningQueries, null, 2)}
`;
}

function gbpSection(gbpSummary) {
  if (!gbpSummary) return '(No GBP data available)';
  return `
GOOGLE BUSINESS PROFILE (last 30 days):
${JSON.stringify(gbpSummary, null, 2)}
`;
}

function advisorSystemPrompt(techCount, targets) {
  return `You are a digital marketing performance analyst specializing in pest control and lawn care businesses in Southwest Florida. You review Google Ads, Google Search Console (organic SEO), and Google Business Profile data daily and provide specific, actionable recommendations across BOTH paid and organic channels.

RECOMMENDATION QUALITY RULES (these override everything below):
- Recommend ONLY changes that are real, supported by the numbers in this data, and worth doing at THIS account's scale. Judge the account by its actual spend and conversion volume, not by generic best practice.
- There is no quota. Zero recommendations is a valid and often correct answer (return "recommendations": []); one strong recommendation beats six weak ones. Never pad the list, never add filler, and never add a generic best-practice tip that the numbers do not support.
- Every recommendation MUST cite the specific numbers it rests on (spend, clicks, conversions, CPA/ROAS, impression share, budget) in its "reasoning".
- When data volume is too small to conclude anything (a handful of conversions, a few dollars of spend, a short window), say so plainly in overall_assessment and do not recommend a change that only makes sense with more data.
- Do NOT recommend something that has already been done: RECENT BUDGET CHANGES lists what was changed in the last 7 days — never repeat or reverse a change made there without new evidence.
- The secondary lists (waste_alerts, scaling_opportunities, capacity_warnings, seo_insights) follow the same rule: leave them as empty arrays unless there is a real, number-backed item (spend/conversions, budgets, utilization, and figures in an SEO detail are required). Never emit placeholder or template rows. insights are short factual observations; leave the array empty rather than pad it.

PAID ADS RULES:
- Be specific with numbers. Don't say "consider increasing budget" — say "increase Pest Bradenton budget from $20 to $30/day based on 7.0x ROAS and 25% lost IS (budget)"
- Distinguish between recurring services (judge on LTV, not first-month ROAS) and one-time services (judge on immediate ROAS)
- NEVER recommend pausing campaigns. Use the three-mode system: Base (full budget), Spent (cap at today's spend), Stop (1% budget). Pausing destroys Quality Score.
- Flag search terms that are wasting spend (high cost, 0 conversions)
- Flag campaigns where ROAS is declining week-over-week
- Identify opportunities where impression share is being lost on profitable campaigns
- Consider capacity — don't recommend scaling ads in areas that are already at 90%+ utilization
- For an auto-applicable action (increase_budget/decrease_budget/change_mode), the target MUST be a platform "google_ads" campaign — other platforms are managed in their own Ads Manager and can only be advised on, never auto-applied. Set "campaign" to the EXACT campaign_name AND "campaign_id" to the EXACT id from CAMPAIGN PERFORMANCE (names are not unique; the id is what gets applied), and set "apply_value" so the change can be applied with one click: for increase_budget/decrease_budget it is the new daily budget in dollars (a number, e.g. 30); for change_mode it is one of "base"|"spent"|"stop". Omit apply_action (or use a non-budget action) when you can't tie the recommendation to a specific google_ads campaign and value.

SEO/GSC RULES:
- Distinguish branded (people already searching "Waves") from non-branded (real organic market capture)
- Prioritize city + service queries ("pest control bradenton", "termite treatment sarasota") — these are money queries
- Flag page 2 opportunities (positions 4–15) — easiest wins to push onto page 1
- Flag declining queries — catch drops before they become costly
- Watch mobile performance — critical for local service searches
- For low CTR with decent positions, recommend title tag / meta description improvements
- For GBP, recommend specific actions per location (photos, posts, review responses)

BUSINESS CONTEXT:
- Waves Pest Control, SWFL (Manatee / Sarasota / Charlotte counties), 5 staffed offices (Bradenton, Sarasota, Venice, Parrish, Lakewood Ranch)
- Main site: wavespestcontrol.com + a 15-site hub-and-spoke network
- ${techCount} field technician${techCount === 1 ? '' : 's'} on the dispatch roster, max ~${targets?.max_services_per_tech || 8} services per tech per day — capacity is tight, so weigh scaling recommendations against it
- WaveGuard membership tiers: Bronze/Silver/Gold/Platinum with 0/10/15/20% discounts
- Recurring lawn services use $35/hr loaded labor cost and a 45% fully loaded floor
- Current performance targets: ROAS > ${targets?.min_roas || 4.0}, CPA < $${targets?.max_cpa || 40}, CVR > ${((targets?.min_conversion_rate || 0.03) * 100).toFixed(0)}%, AOV > $${targets?.target_aov || 120}
- Competes with Turner, Nozzle Nolen, HomeTeam in SWFL market

Return JSON: { "date": "YYYY-MM-DD", "overall_assessment": "2-3 sentence summary covering both paid and organic", "grade": "A/B/C/D/F", "recommendations": [{"priority": "high/medium/low", "campaign": "EXACT campaign_name for budget/mode actions, else page/query", "campaign_id": "EXACT id from CAMPAIGN PERFORMANCE — REQUIRED for budget/mode actions; omit otherwise", "action": "specific action", "reasoning": "why", "estimated_impact": "$X/week or X% improvement", "apply_action": "increase_budget|decrease_budget|add_negative|change_mode|adjust_bid|review_landing_page|expand_keywords|optimize_content|update_meta|add_schema|gbp_action", "apply_value": "REQUIRED for increase_budget/decrease_budget (new daily budget in dollars, a number) and change_mode (base|spent|stop); omit otherwise"}], "waste_alerts": [{"search_term": "", "spend": 0, "conversions": 0, "action": "add_negative"}], "scaling_opportunities": [{"campaign": "", "current_budget": 0, "suggested_budget": 0, "headroom_reason": ""}], "capacity_warnings": [{"area": "", "utilization": 0, "recommendation": ""}], "insights": ["insight1", "insight2"], "seo_insights": [{"type": "opportunity|decline|technical|gbp", "detail": "specific finding", "action": "what to do"}] }`;
}

// The SMS body's actions block: the top recommendations, else (an empty list is
// a valid "nothing worth changing" report) a count of whatever secondary items
// the report still flags, else the no-change line.
function summaryActionsBlock(advice) {
  const topRecs = (advice.recommendations || []).slice(0, 3).map(r => `• ${r.action}`).join('\n');
  if (topRecs) return `Top actions:\n${topRecs}`;
  const flagged = SUMMARY_SECONDARY_LISTS
    .filter(([key]) => Array.isArray(advice[key]) && advice[key].length > 0)
    .map(([key, label]) => {
      const items = advice[key];
      const first = String(items[0][ADS_LIST_FIELDS[key][0]]).trim().slice(0, 80);
      return `• ${label}: ${items.length} (e.g. ${first})`;
    });
  if (flagged.length === 0) return 'No changes recommended today.';
  return `No campaign changes recommended, but flagged:\n${flagged.join('\n')}`;
}

class CampaignAdvisor {
  async generateDailyAdvice() {
    logger.info('Running AI Campaign Advisor...');

    const campaigns = await db('ad_campaigns')
      .where('status', '!=', 'removed')
      .select('*');

    if (campaigns.length === 0) {
      logger.info('No campaigns to advise on');
      return { grade: 'N/A', overall_assessment: 'No campaigns configured yet.', recommendations: [] };
    }

    const now = new Date();
    const inputs = await this.loadAdvisorInputs(now);
    const campaignSummaries = this.buildCampaignSummaries(campaigns, inputs.last7days, inputs.last30days);

    // With no provider key at all, return a data-only summary
    if (!process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) {
      return this.storeFallbackAdvice(campaignSummaries);
    }

    try {
      const res = await this.dispatchAdvice(
        advisorSystemPrompt(inputs.techCount, inputs.targets),
        this.buildAdvisorText(now, inputs, campaignSummaries),
      );
      const advice = normalizeAdsReport(res.json);
      this.stampProvenance(advice, res, now);
      this.normalizeRecommendations(advice, campaigns, inputs.recentlyChangedIds);
      await this.storeReport(advice);
      await this.sendSummary(advice);

      return advice;
    } catch (err) {
      logger.error(`AI Advisor failed: ${err.message}`);
      return this.storeFallbackAdvice(campaignSummaries);
    }
  }

  // An outage never replaces a real report: if today already has one (an
  // earlier run or regeneration), it is kept and the caller is told so. One
  // insert-or-skip on the unique date, so a report saved concurrently is never
  // overwritten either.
  async storeFallbackAdvice(campaignSummaries) {
    const fallback = this.generateFallbackAdvice(campaignSummaries);
    try {
      const inserted = await db('ad_advisor_reports')
        .insert({
          date: fallback.date,
          report_data: JSON.stringify(fallback),
          grade: fallback.grade,
          recommendation_count: 0,
          waste_alert_count: 0,
        })
        .onConflict('date')
        .ignore()
        .returning('date');
      if (!inserted || inserted.length === 0) fallback.kept_existing_report = true;
    } catch (err) {
      logger.error(`Store fallback advisor report failed: ${err.message}`);
    }
    return fallback;
  }

  async loadAdvisorInputs(now) {
    const d7 = etDateString(addETDays(now, -7));
    const d30 = etDateString(addETDays(now, -30));

    const last7days = await db('ad_performance_daily').where('date', '>=', d7);
    const last30days = await db('ad_performance_daily').where('date', '>=', d30);

    // Search terms count as current only when a COMPLETE sync ran recently:
    // syncSearchTerms records that per run (an empty snapshot included) and
    // rolls back a run with rows it couldn't store. The record is read FIRST
    // and the rows bound to it: a complete run restamps every row (terms that
    // left Google's window are zeroed), so rows at or after the recorded run
    // are that snapshot, or a newer complete one that committed in between.
    const freshCutoff = new Date(now - ADVISOR_SEARCH_TERM_FRESH_MS);
    const syncMark = await db('system_settings').where({ key: SEARCH_TERMS_SYNCED_KEY }).first();
    const syncedAt = syncMark?.value ? new Date(syncMark.value) : null;
    const searchTermsAvailable = Boolean(syncedAt) && syncedAt >= freshCutoff;
    const searchTerms = searchTermsAvailable
      ? await db('ad_search_terms')
        .where('updated_at', '>=', syncedAt)
        .where('cost', '>', 0)
        .orderBy('cost', 'desc')
        .limit(ADVISOR_MAX_SEARCH_TERMS + 1)
      : [];

    const serviceAttribution = await db('ad_service_attribution')
      .where('lead_date', '>=', d30);

    const capacity = await this.getWeekCapacity();
    const targets = await db('ad_targets').first();
    // Same live assignable count the budget manager uses for capacity.
    const techCount = await BudgetManager.getTechCountForArea();

    // One past the cap, so a window that held more than the cap is detectable.
    const budgetLog = await db('ad_budget_log')
      .where('created_at', '>=', new Date(now - 7 * 86400000))
      .orderBy('created_at', 'desc')
      .limit(ADVISOR_MAX_BUDGET_CHANGES + 1);
    // Every campaign changed in the window, uncapped: Apply is withheld on
    // these so a model that ignores the no-repeat rule can't put a one-click
    // repeat or reversal on the page.
    const recentlyChangedIds = new Set((await db('ad_budget_log')
      .where('created_at', '>=', new Date(now - 7 * 86400000))
      .distinct('campaign_id'))
      .map((r) => String(r.campaign_id)));

    // GSC/SEO data for combined analysis, then GBP data
    const gscSummary = await loadGscSummary();
    const gbpSummary = await loadGbpSummary(d30);

    return { last7days, last30days, searchTerms, searchTermsAvailable, serviceAttribution, capacity, targets, techCount, budgetLog, recentlyChangedIds, gscSummary, gbpSummary };
  }

  // Aggregate per campaign
  buildCampaignSummaries(campaigns, last7days, last30days) {
    return campaigns.map(c => {
      const perf7d = last7days.filter(p => p.campaign_id === c.id);
      const perf30d = last30days.filter(p => p.campaign_id === c.id);

      return {
        id: c.id,
        name: c.campaign_name,
        platform: c.platform,
        status: c.status,
        linked: Boolean(c.platform_campaign_id),
        type: c.campaign_type,
        area: c.target_area,
        serviceLine: c.service_line,
        serviceCategory: c.service_category,
        budgetMode: c.budget_mode,
        dailyBudgetBase: c.daily_budget_base,
        dailyBudgetCurrent: c.daily_budget_current,
        last7d: this.aggregatePerformance(perf7d),
        last30d: this.aggregatePerformance(perf30d),
        trending: this.getTrend(perf7d, perf30d),
      };
    });
  }

  buildAdvisorText(now, inputs, campaignSummaries) {
    const { targets } = inputs;
    return `Daily ads review for ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}:

CAMPAIGN PERFORMANCE:
${JSON.stringify(campaignSummaries, null, 2)}

SEARCH TERMS WITH SPEND (by spend, up to ${ADVISOR_MAX_SEARCH_TERMS}, last 30 days — every term that cost money unless marked TRUNCATED or UNAVAILABLE below):
${searchTermsSection(inputs.searchTerms, inputs.searchTermsAvailable)}

SERVICE-LINE ATTRIBUTION (last 30 days):
${JSON.stringify(this.groupByService(inputs.serviceAttribution))}

CAPACITY THIS WEEK:
${JSON.stringify(inputs.capacity)}

TARGETS: ROAS > ${targets?.min_roas || 4.0}, CPA < $${targets?.max_cpa || 40}

RECENT BUDGET CHANGES:
${budgetChangesSection(inputs.budgetLog)}
${gscSection(inputs.gscSummary)}
${gbpSection(inputs.gbpSummary)}

Analyze BOTH paid ads and organic SEO performance. Recommend only what is real, number-backed, and worth doing at this account's scale; an empty recommendations list is a valid answer.`;
  }

  // Fable (adsAdvisor policy, owner ruling 2026-10-01) first, Sol on a miss.
  // timeoutMs keeps the SDK's old 10-minute ceiling as the shared budget across
  // both legs — a verbose day's report needs more than the dispatcher's
  // 2-minute-per-leg default. An unparseable or wrongly shaped answer is a
  // rejected leg inside the dispatcher (the next provider gets a turn); a
  // two-leg miss throws here and the caller stores the deterministic fallback.
  async dispatchAdvice(system, text) {
    const res = await dispatchWithFallback(MODELS.TEXT_POLICIES.adsAdvisor, {
      laneId: 'ads_advisor',
      maxTokens: ADVISOR_MAX_TOKENS,
      jsonMode: true,
      timeoutMs: ADVISOR_TIMEOUT_MS,
      system,
      text,
    }, {
      // Split the 10-minute budget across legs: without this an explicit
      // timeoutMs goes entirely to the Fable leg, so a slow primary miss near
      // the deadline would leave the OpenAI backup no time to run.
      reserveFallbackBudget: true,
      // The dispatcher's loose parse accepts any JSON value; the old
      // utils/llm-json parser accepted only a non-array object. Keep that
      // contract: a wrongly shaped answer is a rejected leg, not a stored
      // row. Beyond shape, every field storeReport/sendSummary actually
      // read must be present and usable (isUsableAdsReport) — see its
      // comment.
      validate: (result) => {
        if (!result.json || typeof result.json !== 'object' || Array.isArray(result.json)) return 'not_an_object';
        return isUsableAdsReport(result.json) ? null : 'schema_invalid';
      },
    });
    if (!res.ok) throw new Error(`advice dispatch failed: ${res.reason}`);
    return res;
  }

  stampProvenance(advice, res, now) {
    advice.date = etDateString(now);
    // Which model actually wrote this report (primary or backup leg) — the
    // PPC page shows it. Stored inside report_data, so no migration.
    // servedModel is what the provider reports it actually ran; the route
    // model is only what was requested (an alias can resolve differently).
    if (res.servedModel || res.model) advice.model = res.servedModel || res.model;
    if (res.provider) advice.provider = res.provider;
  }

  // Model recommendations are stored verbatim and drive real Apply buttons,
  // so their apply fields must pass the same executability guards
  // /advisor/apply enforces (google_ads + active + concrete value + base
  // mode + within the 3× bound + not a no-op). A rec failing any of them
  // keeps its advice text but loses apply_action/apply_value — the client
  // shows the "Manual action" hint instead of a button that
  // deterministically 422s. The resolved row's id is stamped back on as the
  // stable campaign_id the route prefers.
  normalizeRecommendations(advice, campaigns, recentlyChangedIds = new Set()) {
    if (!advice || !Array.isArray(advice.recommendations)) return advice;
    const AUTO = new Set(['increase_budget', 'decrease_budget', 'change_mode']);
    const adsConfigured = adsClientConfigured();
    const byId = new Map(campaigns.map((c) => [String(c.id), c]));
    const byName = new Map();
    for (const c of campaigns) {
      const key = String(c.campaign_name || '').toLowerCase();
      byName.set(key, byName.has(key) ? null : c); // null = ambiguous name
    }
    for (const rec of advice.recommendations) {
      if (!rec || !AUTO.has(rec.apply_action)) continue;
      // Keep the intended action as a marker when stripping automation, so
      // the client can still render its "Manual action" hint — otherwise the
      // rec silently loses the indicator the advisor promised.
      const strip = () => { rec.manual_action = rec.apply_action; delete rec.apply_action; delete rec.apply_value; delete rec.campaign_id; };
      // The card shows the NAME and the confirm dialog repeats it — a rec
      // with only a hidden id would let the admin approve a spend change
      // without seeing which campaign it targets.
      if (!String(rec.campaign || '').trim()) { strip(); continue; }
      const campaign = byId.get(String(rec.campaign_id || ''))
        || byName.get(String(rec.campaign || '').toLowerCase())
        || null;
      if (!campaign || campaign.platform !== 'google_ads' || campaign.status !== 'active') { strip(); continue; }
      // Changed in the last 7 days: advice text stays, the one-click button doesn't.
      if (recentlyChangedIds.has(String(campaign.id))) { strip(); continue; }
      // A linked campaign needs a live push the unconfigured client can't run.
      if (campaign.platform_campaign_id && !adsConfigured) { strip(); continue; }
      // An id resolving to a different campaign than the displayed name is
      // exactly the mislabel the route rejects.
      if (String(campaign.campaign_name).toLowerCase() !== String(rec.campaign).toLowerCase()) { strip(); continue; }
      if (rec.apply_action === 'change_mode') {
        if (!['base', 'spent', 'stop'].includes(rec.apply_value) || rec.apply_value === campaign.budget_mode) { strip(); continue; }
        // A LINKED campaign with no base budget can't take a live mode push
        // (setMode throws live_push_unavailable) — advisory only.
        if (campaign.platform_campaign_id && campaign.daily_budget_base == null) { strip(); continue; }
      } else {
        const amount = Number(rec.apply_value);
        const baseBudget = Number(campaign.daily_budget_base);
        const boundRef = Number.isFinite(baseBudget) && baseBudget > 0 ? baseBudget : Number(campaign.daily_budget_current);
        const throttled = Boolean(campaign.budget_mode) && campaign.budget_mode !== 'base';
        const noop = amount === baseBudget && amount === Number(campaign.daily_budget_current);
        if (!Number.isFinite(amount) || amount <= 0 || throttled || !(boundRef > 0)
          || amount > boundRef * 3 || amount < boundRef / 3 || noop) { strip(); continue; }
      }
      rec.campaign_id = campaign.id;
    }
    return advice;
  }

  // Owner ruling 2026-10-01: recommend only real, evidence-backed changes.
  // The fixed ROAS / lost-IS rules this fallback used to apply can't judge
  // data volume or recent changes, so when no AI report is available it now
  // reports the numbers and recommends nothing (no Apply buttons, no prose).
  generateFallbackAdvice(summaries) {
    const totals = summaries.reduce((acc, c) => ({
      spend: acc.spend + (Number(c.last7d?.spend) || 0),
      conversions: acc.conversions + (Number(c.last7d?.conversions) || 0),
    }), { spend: 0, conversions: 0 });
    return {
      date: etDateString(),
      grade: 'N/A',
      overall_assessment: `AI advisor unavailable — no recommendations generated. Last 7 days across ${summaries.length} campaign${summaries.length === 1 ? '' : 's'}: $${totals.spend.toFixed(2)} spend, ${totals.conversions} conversion${totals.conversions === 1 ? '' : 's'}. Regenerate later for an analysed report.`,
      recommendations: [],
      waste_alerts: [],
      scaling_opportunities: [],
      capacity_warnings: [],
      seo_insights: [],
      insights: ['AI advisor not available — no recommendations were generated.'],
    };
  }


  async storeReport(advice) {
    try {
      await db('ad_advisor_reports').insert({
        date: advice.date || etDateString(),
        report_data: JSON.stringify(advice),
        grade: advice.grade,
        recommendation_count: advice.recommendations?.length || 0,
        waste_alert_count: advice.waste_alerts?.length || 0,
      });
    } catch (err) {
      // Unique constraint on date — update instead
      if (err.code === '23505') {
        await db('ad_advisor_reports').where({ date: advice.date }).update({
          report_data: JSON.stringify(advice),
          grade: advice.grade,
          recommendation_count: advice.recommendations?.length || 0,
          waste_alert_count: advice.waste_alerts?.length || 0,
          updated_at: new Date(),
        });
      } else {
        logger.error(`Store advisor report failed: ${err.message}`);
      }
    }
  }

  async sendSummary(advice) {
    if (!TwilioService || !process.env.ADAM_PHONE) return;
    try {
      const actionsBlock = summaryActionsBlock(advice);
      await TwilioService.sendSMS(process.env.ADAM_PHONE,
        `📊 Daily Ads Report — Grade: ${advice.grade || '?'}\n${advice.overall_assessment || ''}\n\n${actionsBlock}\n\nFull report: ${publicPortalUrl()}/admin/ads`,
        { messageType: 'internal_alert' }
      );
    } catch (err) {
      logger.error(`Advisor SMS failed: ${err.message}`);
    }
  }

  getTrend(perf7d, perf30d) {
    const sum7 = this.aggregatePerformance(perf7d);
    const sum30 = this.aggregatePerformance(perf30d);
    if (sum7.roas > sum30.roas * 1.05) return 'improving';
    if (sum7.roas < sum30.roas * 0.8) return 'declining';
    return 'stable';
  }

  aggregatePerformance(rows) {
    const spend = rows.reduce((s, r) => s + parseFloat(r.cost || 0), 0);
    const value = rows.reduce((s, r) => s + parseFloat(r.conversion_value || 0), 0);
    const conv = rows.reduce((s, r) => s + parseFloat(r.conversions || 0), 0);
    const clicks = rows.reduce((s, r) => s + (parseInt(r.clicks) || 0), 0);
    const imps = rows.reduce((s, r) => s + (parseInt(r.impressions) || 0), 0);
    const avgIS = rows.length > 0 ? rows.reduce((s, r) => s + (parseFloat(r.impression_share) || 0), 0) / rows.length : 0;
    const avgLostBudget = rows.length > 0 ? rows.reduce((s, r) => s + (parseFloat(r.lost_is_budget) || 0), 0) / rows.length : 0;

    return {
      spend: Math.round(spend * 100) / 100,
      conversionValue: Math.round(value * 100) / 100,
      roas: spend > 0 ? Math.round(value / spend * 10) / 10 : 0,
      conversions: Math.round(conv * 10) / 10,
      cpa: conv > 0 ? Math.round(spend / conv * 100) / 100 : 0,
      clicks,
      impressions: imps,
      ctr: imps > 0 ? Math.round(clicks / imps * 10000) / 100 : 0,
      avgCpc: clicks > 0 ? Math.round(spend / clicks * 100) / 100 : 0,
      aov: conv > 0 ? Math.round(value / conv * 100) / 100 : 0,
      impressionShare: Math.round(avgIS * 1000) / 10,
      lostISBudget: Math.round(avgLostBudget * 1000) / 10,
    };
  }

  groupByService(attributions) {
    const groups = {};
    for (const a of attributions) {
      const key = a.specific_service || a.service_line || 'unknown';
      if (!groups[key]) groups[key] = { leads: 0, booked: 0, completed: 0, revenue: 0 };
      groups[key].leads++;
      if (['booked', 'completed'].includes(a.funnel_stage)) groups[key].booked++;
      if (a.funnel_stage === 'completed') {
        groups[key].completed++;
        groups[key].revenue += parseFloat(a.completed_revenue || 0);
      }
    }
    return groups;
  }

  async getWeekCapacity() {
    const days = [];
    for (let d = 0; d < 7; d++) {
      const date = new Date(Date.now() + d * 86400000);
      const cap = await BudgetManager.getCapacityForArea('general', date.toISOString().split('T')[0]);
      days.push({
        day: date.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/New_York' }),
        date: date.toISOString().split('T')[0],
        ...cap,
      });
    }
    return days;
  }
}

module.exports = new CampaignAdvisor();
module.exports.isUsableAdsReport = isUsableAdsReport;
module.exports.normalizeAdsReport = normalizeAdsReport;
