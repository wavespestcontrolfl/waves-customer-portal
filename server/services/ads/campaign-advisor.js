const db = require('../../models/db');
const logger = require('../logger');
const BudgetManager = require('./budget-manager');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

let TwilioService;
try { TwilioService = require('../twilio'); } catch { TwilioService = null; }

let SearchConsole;
try { SearchConsole = require('../seo/search-console'); } catch { SearchConsole = null; }

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
    const d7 = new Date(now - 7 * 86400000).toISOString().split('T')[0];
    const d30 = new Date(now - 30 * 86400000).toISOString().split('T')[0];

    const last7days = await db('ad_performance_daily').where('date', '>=', d7);
    const last30days = await db('ad_performance_daily').where('date', '>=', d30);

    const searchTerms = await db('ad_search_terms')
      .orderBy('cost', 'desc')
      .limit(100);

    const serviceAttribution = await db('ad_service_attribution')
      .where('lead_date', '>=', d30);

    const capacity = await this.getWeekCapacity();
    const targets = await db('ad_targets').first();

    const budgetLog = await db('ad_budget_log')
      .where('created_at', '>=', new Date(now - 7 * 86400000))
      .orderBy('created_at', 'desc')
      .limit(20);

    // GSC/SEO data for combined analysis
    let gscSummary = null;
    try {
      if (SearchConsole) {
        const gsc = await SearchConsole.getPerformanceSummary(28);
        if (gsc.current.clicks > 0) {
          gscSummary = {
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
        }
      }
    } catch (err) {
      logger.warn(`GSC data for advisor: ${err.message}`);
    }

    // GBP data
    let gbpSummary = null;
    try {
      const gbp = await db('gbp_performance_daily').where('date', '>=', d30);
      if (gbp.length > 0) {
        const byLoc = {};
        for (const r of gbp) {
          const loc = r.location_name || 'unknown';
          if (!byLoc[loc]) byLoc[loc] = { calls: 0, websiteClicks: 0, directionRequests: 0 };
          byLoc[loc].calls += r.calls || 0;
          byLoc[loc].websiteClicks += r.website_clicks || 0;
          byLoc[loc].directionRequests += r.direction_requests || 0;
        }
        gbpSummary = byLoc;
      }
    } catch (err) {
      logger.warn(`GBP data for advisor: ${err.message}`);
    }

    // Aggregate per campaign
    const campaignSummaries = campaigns.map(c => {
      const perf7d = last7days.filter(p => p.campaign_id === c.id);
      const perf30d = last30days.filter(p => p.campaign_id === c.id);

      return {
        name: c.campaign_name,
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

    // If no Anthropic SDK / key, return a data-only summary
    if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
      const fallback = this.generateFallbackAdvice(campaignSummaries, targets);
      await this.storeReport(fallback);
      return fallback;
    }

    try {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        system: `You are a digital marketing performance analyst specializing in pest control and lawn care businesses in Southwest Florida. You review Google Ads, Google Search Console (organic SEO), and Google Business Profile data daily and provide specific, actionable recommendations across BOTH paid and organic channels.

PAID ADS RULES:
- Be specific with numbers. Don't say "consider increasing budget" — say "increase Pest Bradenton budget from $20 to $30/day based on 7.0x ROAS and 25% lost IS (budget)"
- Distinguish between recurring services (judge on LTV, not first-month ROAS) and one-time services (judge on immediate ROAS)
- NEVER recommend pausing campaigns. Use the three-mode system: Base (full budget), Spent (cap at today's spend), Stop (1% budget). Pausing destroys Quality Score.
- Flag search terms that are wasting spend (high cost, 0 conversions)
- Flag campaigns where ROAS is declining week-over-week
- Identify opportunities where impression share is being lost on profitable campaigns
- Consider capacity — don't recommend scaling ads in areas that are already at 90%+ utilization

SEO/GSC RULES:
- Distinguish branded (people already searching "Waves") from non-branded (real organic market capture)
- Prioritize city + service queries ("pest control bradenton", "termite treatment sarasota") — these are money queries
- Flag page 2 opportunities (positions 4–15) — easiest wins to push onto page 1
- Flag declining queries — catch drops before they become costly
- Watch mobile performance — critical for local service searches
- For low CTR with decent positions, recommend title tag / meta description improvements
- For GBP, recommend specific actions per location (photos, posts, review responses)

BUSINESS CONTEXT:
- Waves Pest Control, 4 locations in SWFL (Lakewood Ranch, Parrish, Sarasota, Venice)
- Main site: wavespestcontrol.com + 9 domain-specific microsites
- 3 technicians (Adam, Jose, Jacob), max ~8 services per tech per day
- WaveGuard membership tiers: Bronze/Silver/Gold/Platinum with 0/10/15/20% discounts
- Recurring services have $35/hr loaded labor cost, target 55% gross margin
- Current performance targets: ROAS > ${targets?.min_roas || 4.0}, CPA < $${targets?.max_cpa || 40}, CVR > ${((targets?.min_conversion_rate || 0.03) * 100).toFixed(0)}%, AOV > $${targets?.target_aov || 120}
- Competes with Turner, Nozzle Nolen, HomeTeam in SWFL market

Return JSON: { "date": "YYYY-MM-DD", "overall_assessment": "2-3 sentence summary covering both paid and organic", "grade": "A/B/C/D/F", "recommendations": [{"priority": "high/medium/low", "campaign": "name or page/query", "action": "specific action", "reasoning": "why", "estimated_impact": "$X/week or X% improvement", "apply_action": "increase_budget|decrease_budget|add_negative|change_mode|adjust_bid|review_landing_page|expand_keywords|optimize_content|update_meta|add_schema|gbp_action"}], "waste_alerts": [{"search_term": "", "spend": 0, "conversions": 0, "action": "add_negative"}], "scaling_opportunities": [{"campaign": "", "current_budget": 0, "suggested_budget": 0, "headroom_reason": ""}], "capacity_warnings": [{"area": "", "utilization": 0, "recommendation": ""}], "insights": ["insight1", "insight2"], "seo_insights": [{"type": "opportunity|decline|technical|gbp", "detail": "specific finding", "action": "what to do"}] }`,

        messages: [{
          role: 'user',
          content: `Daily ads review for ${now.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}:

CAMPAIGN PERFORMANCE:
${JSON.stringify(campaignSummaries, null, 2)}

TOP SEARCH TERMS (by spend, last 30 days):
${JSON.stringify(searchTerms.slice(0, 30).map(t => ({
  term: t.search_term, clicks: t.clicks, spend: Number(t.cost),
  conversions: Number(t.conversions), convValue: Number(t.conversion_value), roas: Number(t.roas),
})), null, 2)}

SERVICE-LINE ATTRIBUTION (last 30 days):
${JSON.stringify(this.groupByService(serviceAttribution))}

CAPACITY THIS WEEK:
${JSON.stringify(capacity)}

TARGETS: ROAS > ${targets?.min_roas || 4.0}, CPA < $${targets?.max_cpa || 40}

RECENT BUDGET CHANGES:
${JSON.stringify(budgetLog.slice(0, 10).map(b => ({
  campaign: b.campaign_name, from: b.previous_mode, to: b.new_mode, reason: b.reason,
})))}
${gscSummary ? `
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
` : '(No GSC data available)'}
${gbpSummary ? `
GOOGLE BUSINESS PROFILE (last 30 days):
${JSON.stringify(gbpSummary, null, 2)}
` : '(No GBP data available)'}

Analyze BOTH paid ads and organic SEO performance. Provide specific recommendations for each.`
        }]
      });

      let advice;
      try {
        advice = JSON.parse(response.content[0].text.replace(/```json|```/g, '').trim());
      } catch {
        advice = { raw: response.content[0].text, parse_error: true, grade: '?', overall_assessment: 'Report generated but could not parse structured output.' };
      }

      advice.date = now.toISOString().split('T')[0];
      await this.storeReport(advice);
      await this.sendSummary(advice);

      return advice;
    } catch (err) {
      logger.error(`AI Advisor failed: ${err.message}`);
      const fallback = this.generateFallbackAdvice(campaignSummaries, targets);
      await this.storeReport(fallback);
      return fallback;
    }
  }

  generateFallbackAdvice(summaries, targets) {
    const recommendations = [];
    const minRoas = parseFloat(targets?.min_roas || 4.0);

    for (const c of summaries) {
      if (c.last7d.roas > 0 && c.last7d.roas < minRoas * 0.5) {
        recommendations.push({
          priority: 'high', campaign: c.name,
          action: `Set to STOP mode — 7-day ROAS ${c.last7d.roas}x is less than half of ${minRoas}x target`,
          reasoning: 'Underperforming campaign burning budget',
          apply_action: 'change_mode',
        });
      } else if (c.last7d.lostISBudget > 20 && c.last7d.roas >= minRoas) {
        recommendations.push({
          priority: 'medium', campaign: c.name,
          action: `Increase budget — losing ${c.last7d.lostISBudget}% IS to budget with ${c.last7d.roas}x ROAS`,
          reasoning: 'Profitable campaign with headroom',
          apply_action: 'increase_budget',
        });
      }
    }

    return {
      date: new Date().toISOString().split('T')[0],
      grade: recommendations.length === 0 ? 'B' : 'C',
      overall_assessment: `Auto-generated report: ${summaries.length} campaigns reviewed, ${recommendations.length} actions identified.`,
      recommendations,
      waste_alerts: [],
      scaling_opportunities: [],
      capacity_warnings: [],
      insights: ['AI advisor not available — showing rule-based analysis only.'],
    };
  }

  async storeReport(advice) {
    try {
      await db('ad_advisor_reports').insert({
        date: advice.date || new Date().toISOString().split('T')[0],
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
      const topRecs = (advice.recommendations || []).slice(0, 3).map(r => `• ${r.action}`).join('\n');
      await TwilioService.sendSMS(process.env.ADAM_PHONE,
        `📊 Daily Ads Report — Grade: ${advice.grade || '?'}\n${advice.overall_assessment || ''}\n\nTop actions:\n${topRecs}\n\nFull report: ${process.env.CLIENT_URL || 'https://portal.wavespestcontrol.com'}/admin/ads`,
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
        day: date.toLocaleDateString('en-US', { weekday: 'short' }),
        date: date.toISOString().split('T')[0],
        ...cap,
      });
    }
    return days;
  }
}

module.exports = new CampaignAdvisor();
