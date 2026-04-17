/**
 * SEO Advisor — weekly AI analysis of GSC + GBP + organic performance.
 *
 * Runs every Monday at 7 AM. Analyzes:
 *  - GSC query/page performance (branded vs non-branded)
 *  - City page rankings
 *  - Service page performance
 *  - Mobile vs desktop
 *  - Page 2 opportunities (positions 4–15)
 *  - Declining queries/pages
 *  - Core Web Vitals
 *  - GBP performance by location
 *  - Indexing issues
 */

const db = require('../../models/db');
const logger = require('../logger');
const SearchConsole = require('./search-console');
const MODELS = require('../../config/models');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

let TwilioService;
try { TwilioService = require('../twilio'); } catch { TwilioService = null; }

class SEOAdvisor {
  async generateWeeklyReport() {
    logger.info('Running weekly SEO Advisor...');

    // Pull all the data
    const gsc = await SearchConsole.getPerformanceSummary(28);

    const gbp = await db('gbp_performance_daily')
      .where('date', '>=', new Date(Date.now() - 28 * 86400000).toISOString().split('T')[0])
      .orderBy('date', 'desc');

    // GBP by location
    const gbpByLocation = {};
    for (const row of gbp) {
      const loc = row.location_name || row.location_id;
      if (!gbpByLocation[loc]) gbpByLocation[loc] = { calls: 0, websiteClicks: 0, directionRequests: 0, searchViews: 0, mapsViews: 0 };
      gbpByLocation[loc].calls += row.calls || 0;
      gbpByLocation[loc].websiteClicks += row.website_clicks || 0;
      gbpByLocation[loc].directionRequests += row.direction_requests || 0;
      gbpByLocation[loc].searchViews += row.search_views || 0;
      gbpByLocation[loc].mapsViews += row.maps_views || 0;
    }

    const hasData = gsc.current.clicks > 0 || gsc.topQueries.length > 0 || gbp.length > 0;

    if (!hasData) {
      const emptyReport = {
        date: new Date().toISOString().split('T')[0],
        grade: 'N/A',
        overall_assessment: 'No GSC or GBP data available yet. Connect Google Search Console and sync data to enable SEO analysis.',
        recommendations: [],
        opportunities: [],
        alerts: [],
      };
      await this.storeReport(emptyReport);
      return emptyReport;
    }

    // Build the analysis prompt data
    const analysisData = {
      sitewide: {
        clicks: gsc.current.clicks,
        impressions: gsc.current.impressions,
        ctr: (gsc.current.ctr * 100).toFixed(2) + '%',
        brandedClicks: gsc.current.brandedClicks,
        nonbrandClicks: gsc.current.nonbrandClicks,
        changes: gsc.change,
      },
      topNonBrandQueries: gsc.topQueries
        .filter(q => !q.is_branded)
        .slice(0, 20)
        .map(q => ({
          query: q.query, clicks: parseInt(q.clicks), impressions: parseInt(q.impressions),
          position: parseFloat(q.avg_position).toFixed(1), service: q.service_category, city: q.city_target,
        })),
      topBrandedQueries: gsc.topQueries
        .filter(q => q.is_branded)
        .slice(0, 10)
        .map(q => ({ query: q.query, clicks: parseInt(q.clicks), impressions: parseInt(q.impressions) })),
      topPages: gsc.topPages.slice(0, 15).map(p => ({
        url: p.page_url, clicks: parseInt(p.clicks), impressions: parseInt(p.impressions),
        position: parseFloat(p.avg_position).toFixed(1), type: p.page_type,
      })),
      page2Opportunities: gsc.opportunities.map(q => ({
        query: q.query, impressions: parseInt(q.impressions), position: parseFloat(q.avg_position).toFixed(1),
        service: q.service_category, city: q.city_target,
      })),
      decliningQueries: gsc.declining,
      devices: gsc.devices.map(d => ({
        device: d.device, clicks: parseInt(d.clicks), impressions: parseInt(d.impressions),
      })),
      cwv: gsc.cwv.slice(0, 5).map(c => ({
        page: c.page_url, device: c.device, lcp: c.lcp_p75, inp: c.inp_p75, cls: c.cls_p75, overall: c.overall_status,
      })),
      indexingIssues: gsc.indexIssues.slice(0, 10).map(i => ({
        url: i.page_url, issue: i.issue_type, status: i.status,
      })),
      gbpByLocation,
    };

    // If no Anthropic, return data-only
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      const fallback = this.generateFallbackReport(analysisData);
      await this.storeReport(fallback);
      return fallback;
    }

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const response = await anthropic.messages.create({
        model: MODELS.FLAGSHIP,
        max_tokens: 4000,
        system: `You are an SEO analyst specializing in local service businesses (pest control, lawn care) in Southwest Florida. You review Google Search Console, Google Business Profile, and web performance data weekly and provide specific, actionable SEO recommendations.

BUSINESS CONTEXT:
- Waves Pest Control: 4 locations in SWFL — Lakewood Ranch, Parrish, Sarasota, Venice
- Main site: wavespestcontrol.com
- 9 domain-specific microsites (bradentonflexterminator.com, sarasotaflpestcontrol.com, etc.)
- Services: pest control, termite, rodent exclusion, mosquito program, lawn care, tree & shrub
- Competes with Turner, Nozzle Nolen, HomeTeam in SWFL market
- Key revenue services: quarterly pest (volume), rodent exclusion ($750 ticket), mosquito program (recurring)

ANALYSIS PRIORITIES:
1. Non-branded organic growth — this is real market capture, not people already searching your name
2. City + service queries ("pest control bradenton", "termite treatment sarasota") — these are money queries
3. Page 2 opportunities (positions 4–15) — easiest wins to push onto page 1
4. Declining queries — catch drops before they become costly
5. Mobile performance — critical for local service searches
6. GBP performance by location — calls, clicks, directions per location
7. Core Web Vitals — especially mobile on city/service pages
8. Indexing issues — important pages must be indexed

RULES:
- Be specific. Don't say "improve content" — say "add 300 words of unique FAQ content to the Bradenton pest control page targeting 'pest control bradenton fl' (position 6.2, 180 impressions/week)"
- Prioritize by revenue impact: high-ticket service pages and high-volume city pages first
- Distinguish between branded demand growth (good, but not SEO improvement) and non-branded capture (real SEO wins)
- For mobile issues, specify exactly which pages and what the problem likely is
- For GBP, recommend specific actions per location

Return JSON: {
  "date": "YYYY-MM-DD",
  "period": "Last 28 days",
  "grade": "A/B/C/D/F",
  "overall_assessment": "2-3 sentence summary",
  "key_metrics": { "totalClicks": 0, "nonbrandClicks": 0, "clicksChange": "+X%", "impressionsChange": "+X%", "avgPosition": 0 },
  "wins": ["win1", "win2"],
  "recommendations": [{"priority": "high/medium/low", "category": "content/technical/gbp/links/local", "action": "specific action", "page_or_query": "target", "reasoning": "why", "estimated_impact": "potential click/traffic gain"}],
  "page2_opportunities": [{"query": "", "position": 0, "impressions": 0, "action": "what to do to push to page 1"}],
  "declining_alerts": [{"query": "", "drop_pct": 0, "action": "what to investigate/fix"}],
  "gbp_insights": [{"location": "", "metric": "", "recommendation": ""}],
  "technical_issues": [{"issue": "", "severity": "high/medium/low", "fix": ""}],
  "mobile_insights": [{"finding": "", "action": ""}]
}`,

        messages: [{
          role: 'user',
          content: `Weekly SEO review for ${new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}:

SITEWIDE PERFORMANCE (last 28 days):
${JSON.stringify(analysisData.sitewide, null, 2)}

TOP NON-BRAND QUERIES:
${JSON.stringify(analysisData.topNonBrandQueries, null, 2)}

TOP BRANDED QUERIES:
${JSON.stringify(analysisData.topBrandedQueries, null, 2)}

TOP PAGES:
${JSON.stringify(analysisData.topPages, null, 2)}

PAGE 2 OPPORTUNITIES (positions 4-15, non-branded):
${JSON.stringify(analysisData.page2Opportunities, null, 2)}

DECLINING QUERIES (vs previous 28 days):
${JSON.stringify(analysisData.decliningQueries, null, 2)}

DEVICE BREAKDOWN:
${JSON.stringify(analysisData.devices, null, 2)}

CORE WEB VITALS:
${JSON.stringify(analysisData.cwv, null, 2)}

INDEXING ISSUES:
${JSON.stringify(analysisData.indexingIssues, null, 2)}

GBP PERFORMANCE BY LOCATION (last 28 days):
${JSON.stringify(analysisData.gbpByLocation, null, 2)}

Analyze and provide specific, prioritized recommendations.`
        }]
      });

      let report;
      try {
        report = JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim());
      } catch {
        report = { raw: response.content[0].text, parse_error: true, grade: '?', overall_assessment: 'Report generated but could not parse.' };
      }

      report.date = new Date().toISOString().split('T')[0];
      await this.storeReport(report);
      await this.sendSummary(report);

      return report;
    } catch (err) {
      logger.error(`SEO Advisor failed: ${err.message}`);
      const fallback = this.generateFallbackReport(analysisData);
      await this.storeReport(fallback);
      return fallback;
    }
  }

  generateFallbackReport(data) {
    const recommendations = [];
    const opportunities = [];

    // Auto-detect page 2 opportunities
    for (const q of (data.page2Opportunities || [])) {
      opportunities.push({
        query: q.query, position: q.position, impressions: q.impressions,
        action: `Optimize page content for "${q.query}" — currently at position ${q.position} with ${q.impressions} impressions`,
      });
    }

    // Auto-detect declining queries
    for (const q of (data.decliningQueries || [])) {
      recommendations.push({
        priority: 'high', category: 'content',
        action: `Investigate decline for "${q.query}": ${q.changePct}% drop (${q.previousClicks} → ${q.currentClicks} clicks)`,
        reasoning: 'Traffic declining — check for ranking loss or SERP changes',
      });
    }

    // Check for indexing issues
    if (data.indexingIssues?.length > 0) {
      recommendations.push({
        priority: 'high', category: 'technical',
        action: `Fix ${data.indexingIssues.length} indexing issues — important pages may not appear in search`,
        reasoning: 'Pages with indexing errors cannot rank',
      });
    }

    return {
      date: new Date().toISOString().split('T')[0],
      period: 'Last 28 days',
      grade: recommendations.length === 0 ? 'B' : 'C',
      overall_assessment: `Auto-generated SEO report. ${data.sitewide?.clicks || 0} total clicks, ${(data.page2Opportunities || []).length} page-2 opportunities found, ${(data.decliningQueries || []).length} declining queries detected.`,
      recommendations,
      page2_opportunities: opportunities,
      declining_alerts: (data.decliningQueries || []).map(q => ({ query: q.query, drop_pct: q.changePct })),
      wins: [],
      gbp_insights: [],
      technical_issues: [],
      mobile_insights: [],
      key_metrics: {
        totalClicks: data.sitewide?.clicks || 0,
        nonbrandClicks: data.sitewide?.nonbrandClicks || 0,
        clicksChange: `${data.sitewide?.changes?.clicks || 0}%`,
        impressionsChange: `${data.sitewide?.changes?.impressions || 0}%`,
      },
    };
  }

  async storeReport(report) {
    try {
      await db('seo_advisor_reports').insert({
        date: report.date || new Date().toISOString().split('T')[0],
        period_type: 'weekly',
        report_data: JSON.stringify(report),
        grade: report.grade,
        recommendation_count: report.recommendations?.length || 0,
        opportunity_count: report.page2_opportunities?.length || 0,
        alert_count: report.declining_alerts?.length || 0,
      });
    } catch (err) {
      logger.error(`Store SEO report failed: ${err.message}`);
    }
  }

  async sendSummary(report) {
    if (!TwilioService || !process.env.ADAM_PHONE) return;
    try {
      const topRecs = (report.recommendations || []).slice(0, 3).map(r => `• ${r.action}`).join('\n');
      const opps = (report.page2_opportunities || []).length;
      await TwilioService.sendSMS(process.env.ADAM_PHONE,
        `🔍 Weekly SEO Report — Grade: ${report.grade || '?'}\n${report.overall_assessment || ''}\n\n${opps} page-2 opportunities\n\nTop actions:\n${topRecs}\n\nFull report: ${process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com'}/admin/ads`,
        { messageType: 'internal_alert' }
      );
    } catch (err) {
      logger.error(`SEO Advisor SMS failed: ${err.message}`);
    }
  }
}

module.exports = new SEOAdvisor();
