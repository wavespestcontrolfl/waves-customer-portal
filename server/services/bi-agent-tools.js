/**
 * Weekly BI Agent — Tool Executor
 * Aggregates data from every corner of the portal.
 */

const db = require('../models/db');
const logger = require('./logger');

function som() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0]; }
function today() { return new Date().toISOString().split('T')[0]; }
function daysAgo(n) { return new Date(Date.now() - n * 86400000).toISOString().split('T')[0]; }
function mondayThisWeek() { const d = new Date(); const day = d.getDay(); const diff = d.getDate() - day + (day === 0 ? -6 : 1); return new Date(d.getFullYear(), d.getMonth(), diff).toISOString().split('T')[0]; }

async function executeBITool(toolName, input) {
  switch (toolName) {

    case 'get_revenue_snapshot': {
      const somDate = som();
      const todayDate = today();
      const lastMonthStart = (() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0]; })();
      const lastMonthEnd = new Date(new Date().getFullYear(), new Date().getMonth(), 0).toISOString().split('T')[0];

      const [revMTD, revLastMonth, mrr, oneTime, overdue, tierRevenue] = await Promise.all([
        db('payments').where({ status: 'paid' }).where('payment_date', '>=', somDate).sum('amount as total').first(),
        db('payments').where({ status: 'paid' }).where('payment_date', '>=', lastMonthStart).where('payment_date', '<=', lastMonthEnd).sum('amount as total').first(),
        db('customers').where({ active: true }).where('monthly_rate', '>', 0).sum('monthly_rate as total').count('* as count').first(),
        db('payments').where({ status: 'paid' }).where('payment_date', '>=', somDate).where('description', 'not ilike', '%monthly%').where('description', 'not ilike', '%waveguard%').sum('amount as total').first(),
        db('payments').whereIn('status', ['failed', 'overdue']).sum('amount as total').first(),
        db('customers').where({ active: true }).select('waveguard_tier').count('* as count').sum('monthly_rate as revenue').groupBy('waveguard_tier'),
      ]);

      const mrrVal = parseFloat(mrr?.total || 0);
      const revMTDVal = parseFloat(revMTD?.total || 0);
      const revLMVal = parseFloat(revLastMonth?.total || 0);

      return {
        mrr: mrrVal,
        arr: mrrVal * 12,
        recurringCustomers: parseInt(mrr?.count || 0),
        revenueMTD: revMTDVal,
        revenueLastMonth: revLMVal,
        revenueChange: revLMVal > 0 ? Math.round((revMTDVal - revLMVal) / revLMVal * 100) : 0,
        oneTimeRevenueMTD: parseFloat(oneTime?.total || 0),
        outstandingAR: parseFloat(overdue?.total || 0),
        byTier: tierRevenue.map(t => ({ tier: t.waveguard_tier || 'None', count: parseInt(t.count), monthly: parseFloat(t.revenue || 0) })),
      };
    }

    case 'get_customer_snapshot': {
      const somDate = som();

      const [active, newThisMonth, churned, pipeline, atRisk] = await Promise.all([
        db('customers').where({ active: true }).count('* as count').first(),
        db('customers').where({ active: true }).where('created_at', '>=', somDate).count('* as count').first(),
        db('customers').where('pipeline_stage', 'churned').where('pipeline_stage_changed_at', '>=', somDate).count('* as count').first(),
        db('leads').where('first_contact_at', '>=', somDate).select('status').count('* as count').groupBy('status'),
        // Top 5 at-risk by value
        db('customer_health_scores as h')
          .innerJoin(db.raw(`(SELECT customer_id, MAX(scored_at) as max_date FROM customer_health_scores GROUP BY customer_id) as latest`),
            function () { this.on('h.customer_id', 'latest.customer_id').andOn('h.scored_at', 'latest.max_date'); })
          .innerJoin('customers as c', 'h.customer_id', 'c.id')
          .whereIn('h.churn_risk', ['critical', 'at_risk'])
          .where('c.active', true)
          .select('c.first_name', 'c.last_name', 'c.waveguard_tier', 'c.monthly_rate', 'h.overall_score', 'h.churn_risk', 'h.churn_signals')
          .orderBy('c.monthly_rate', 'desc')
          .limit(5),
      ]);

      const pipelineMap = {};
      pipeline.forEach(p => { pipelineMap[p.status] = parseInt(p.count); });
      const totalLeads = Object.values(pipelineMap).reduce((s, v) => s + v, 0);
      const won = pipelineMap.won || 0;

      const criticalCount = atRisk.filter(c => c.churn_risk === 'critical').length;
      const atRiskCount = atRisk.length;

      return {
        active: parseInt(active?.count || 0),
        newThisMonth: parseInt(newThisMonth?.count || 0),
        churnedThisMonth: parseInt(churned?.count || 0),
        netChange: parseInt(newThisMonth?.count || 0) - parseInt(churned?.count || 0),
        pipeline: pipelineMap,
        totalLeads,
        closeRate: totalLeads > 0 ? Math.round(won / totalLeads * 100) : 0,
        atRiskTotal: atRiskCount,
        criticalCount,
        topAtRisk: atRisk.map(c => ({
          name: `${c.first_name} ${c.last_name}`,
          tier: c.waveguard_tier,
          monthlyRate: parseFloat(c.monthly_rate || 0),
          health: c.overall_score,
          risk: c.churn_risk,
          topFactor: (typeof c.churn_signals === 'string' ? JSON.parse(c.churn_signals) : (c.churn_signals || []))[0]?.signal || 'unknown',
        })),
      };
    }

    case 'get_operations_snapshot': {
      const monday = mondayThisWeek();
      const todayDate = today();
      const tomorrowDate = new Date(Date.now() + 86400000).toISOString().split('T')[0];

      const [weekServices, todayServices, unassigned] = await Promise.all([
        db('scheduled_services').where('scheduled_date', '>=', monday).where('scheduled_date', '<=', todayDate)
          .select(db.raw("COUNT(*) as total"), db.raw("COUNT(*) FILTER (WHERE status = 'completed') as completed")).first(),
        db('scheduled_services').where('scheduled_date', todayDate).count('* as count').first(),
        db('scheduled_services').where('scheduled_date', '>=', todayDate).whereNull('technician_id').whereIn('status', ['pending', 'confirmed']).count('* as count').first(),
      ]);

      // Tomorrow's weather
      let tomorrowForecast = null;
      try {
        const ForecastAnalyzer = require('./forecast-analyzer');
        tomorrowForecast = await ForecastAnalyzer.analyzeTomorrow();
      } catch { /* non-critical */ }

      const total = parseInt(weekServices?.total || 0);
      const completed = parseInt(weekServices?.completed || 0);

      return {
        servicesThisWeek: total,
        completedThisWeek: completed,
        completionRate: total > 0 ? Math.round(completed / total * 100) : 0,
        servicesToday: parseInt(todayServices?.count || 0),
        unassigned: parseInt(unassigned?.count || 0),
        tomorrowRescheduleCount: tomorrowForecast?.needsReschedule?.length || 0,
        tomorrowWeather: tomorrowForecast?.needsReschedule?.length > 0 ? 'Weather impact expected' : 'Clear',
      };
    }

    case 'get_ads_performance': {
      const monday = mondayThisWeek();
      const somDate = som();

      const [weekPerf, monthPerf, advisor] = await Promise.all([
        db('ad_performance_daily').where('date', '>=', monday)
          .select(db.raw('SUM(cost) as spend'), db.raw('SUM(clicks) as clicks'), db.raw('SUM(conversions) as conversions'), db.raw('SUM(impressions) as impressions')).first(),
        db('ad_performance_daily').where('date', '>=', somDate)
          .select(db.raw('SUM(cost) as spend'), db.raw('SUM(conversions) as conversions')).first(),
        db('ai_audits').where('audit_type', 'campaign_advisor').orderBy('audit_date', 'desc').first(),
      ]);

      const weekSpend = parseFloat(weekPerf?.spend || 0);
      const weekConversions = parseInt(weekPerf?.conversions || 0);
      const monthSpend = parseFloat(monthPerf?.spend || 0);
      const monthConversions = parseInt(monthPerf?.conversions || 0);

      let advisorGrade = null;
      try {
        const data = typeof advisor?.report_data === 'string' ? JSON.parse(advisor.report_data) : advisor?.report_data;
        advisorGrade = data?.grade || null;
      } catch {}

      return {
        weekSpend,
        weekClicks: parseInt(weekPerf?.clicks || 0),
        weekConversions,
        weekCPA: weekConversions > 0 ? Math.round(weekSpend / weekConversions) : null,
        monthSpend,
        monthConversions,
        monthCPA: monthConversions > 0 ? Math.round(monthSpend / monthConversions) : null,
        advisorGrade,
      };
    }

    case 'get_review_snapshot': {
      const weekAgo = daysAgo(7);

      const [stats, thisWeek, unresponded] = await Promise.all([
        (async () => {
          try {
            const statsRows = await db('google_reviews').where({ reviewer_name: '_stats' });
            let total = 0, ratingSum = 0, cnt = 0;
            for (const row of statsRows) {
              try { const p = JSON.parse(row.review_text); total += p.totalReviews || 0; if (p.rating) { ratingSum += p.rating; cnt++; } } catch {}
            }
            if (total > 0) return { total, rating: cnt > 0 ? (ratingSum / cnt).toFixed(1) : '5.0' };
            const fallback = await db('google_reviews').where('reviewer_name', '!=', '_stats')
              .select(db.raw('COUNT(*) as total'), db.raw('ROUND(AVG(star_rating)::numeric, 1) as rating')).first();
            return { total: parseInt(fallback?.total || 0), rating: fallback?.rating || '0' };
          } catch { return { total: 0, rating: '0' }; }
        })(),
        db('google_reviews').where('reviewer_name', '!=', '_stats').where('created_at', '>=', weekAgo).count('* as count').first(),
        db('google_reviews').where('reviewer_name', '!=', '_stats').whereNull('review_reply').whereNotNull('review_text')
          .select('reviewer_name', 'star_rating').limit(5),
      ]);

      return {
        rating: stats.rating,
        totalReviews: stats.total,
        newThisWeek: parseInt(thisWeek?.count || 0),
        unrespondedCount: unresponded.length,
        unresponded: unresponded.map(r => ({ name: r.reviewer_name, stars: r.star_rating })),
      };
    }

    case 'get_content_seo_snapshot': {
      const weekAgo = daysAgo(7);

      const [publishedThisWeek, totalPublished, decayAlerts, gscSummary, backlinks] = await Promise.all([
        db('blog_posts').where('status', 'published').where('publish_date', '>=', weekAgo).count('* as count').first(),
        db('blog_posts').where('status', 'published').count('* as count').first(),
        db('seo_content_decay_alerts').where('status', 'open').count('* as count').first(),
        (async () => {
          try {
            const current = await db('gsc_performance_daily').where('date', '>=', weekAgo)
              .select(db.raw('SUM(clicks) as clicks'), db.raw('SUM(impressions) as impressions')).first();
            const previous = await db('gsc_performance_daily').where('date', '>=', daysAgo(14)).where('date', '<', weekAgo)
              .select(db.raw('SUM(clicks) as clicks'), db.raw('SUM(impressions) as impressions')).first();
            return {
              clicksThisWeek: parseInt(current?.clicks || 0),
              clicksLastWeek: parseInt(previous?.clicks || 0),
              impressionsThisWeek: parseInt(current?.impressions || 0),
            };
          } catch { return { clicksThisWeek: 0, clicksLastWeek: 0, impressionsThisWeek: 0 }; }
        })(),
        (async () => {
          try {
            const total = await db('seo_backlinks').where('status', 'active').count('* as count').first();
            const newThisWeek = await db('seo_backlinks').where('first_seen', '>=', weekAgo).count('* as count').first();
            return { total: parseInt(total?.count || 0), newThisWeek: parseInt(newThisWeek?.count || 0) };
          } catch { return { total: 0, newThisWeek: 0 }; }
        })(),
      ]);

      const clickChange = (gscSummary.clicksLastWeek || 0) > 0
        ? Math.round(((gscSummary.clicksThisWeek - gscSummary.clicksLastWeek) / gscSummary.clicksLastWeek) * 100) : 0;

      return {
        publishedThisWeek: parseInt(publishedThisWeek?.count || 0),
        totalPublished: parseInt(totalPublished?.count || 0),
        decayAlerts: parseInt(decayAlerts?.count || 0),
        gsc: { clicks: gscSummary.clicksThisWeek, clickChange, impressions: gscSummary.impressionsThisWeek },
        backlinks: { total: backlinks.total, newThisWeek: backlinks.newThisWeek },
      };
    }

    case 'get_anomalies': {
      const anomalies = [];
      const weekAgo = daysAgo(7);
      const twoWeeksAgo = daysAgo(14);

      // Payment failure spike
      try {
        const thisWeek = await db('payments').where('status', 'failed').where('payment_date', '>=', weekAgo).count('* as count').first();
        const lastWeek = await db('payments').where('status', 'failed').where('payment_date', '>=', twoWeeksAgo).where('payment_date', '<', weekAgo).count('* as count').first();
        const tw = parseInt(thisWeek?.count || 0), lw = parseInt(lastWeek?.count || 0);
        if (tw > lw * 1.5 && tw > 2) anomalies.push({ type: 'payment_failures', severity: 'warning', detail: `${tw} failed payments this week (was ${lw} last week)` });
      } catch {}

      // Service cancellation spike
      try {
        const cancelled = await db('scheduled_services').where('status', 'cancelled').where('updated_at', '>=', weekAgo).count('* as count').first();
        if (parseInt(cancelled?.count || 0) > 5) anomalies.push({ type: 'cancellations', severity: 'warning', detail: `${cancelled.count} services cancelled this week` });
      } catch {}

      // New critical health scores
      try {
        const newCritical = await db('customer_health_scores')
          .where('churn_risk', 'critical')
          .where('scored_at', '>=', weekAgo)
          .innerJoin('customers', 'customer_health_scores.customer_id', 'customers.id')
          .select('customers.first_name', 'customers.last_name', 'customers.monthly_rate')
          .limit(5);
        if (newCritical.length > 0) {
          anomalies.push({
            type: 'churn_risk',
            severity: 'critical',
            detail: `${newCritical.length} new critical-risk customers: ${newCritical.map(c => `${c.first_name} $${c.monthly_rate}/mo`).join(', ')}`,
          });
        }
      } catch {}

      // Unresponded reviews > 48 hours
      try {
        const old = await db('google_reviews').where('reviewer_name', '!=', '_stats')
          .whereNull('review_reply').whereNotNull('review_text')
          .where('created_at', '<', new Date(Date.now() - 48 * 3600000))
          .count('* as count').first();
        if (parseInt(old?.count || 0) > 0) anomalies.push({ type: 'reviews', severity: 'warning', detail: `${old.count} review(s) unresponded >48 hours` });
      } catch {}

      return { anomalies, total: anomalies.length };
    }

    case 'send_briefing_sms': {
      const TwilioService = require('./twilio');
      if (!process.env.ADAM_PHONE) return { error: 'ADAM_PHONE not set' };

      await TwilioService.sendSMS(process.env.ADAM_PHONE, input.message, { messageType: 'bi_briefing' });
      logger.info(`[bi-agent] Monday briefing SMS sent`);
      return { sent: true };
    }

    case 'save_weekly_report': {
      const [report] = await db('weekly_bi_reports').insert({
        summary: input.summary,
        revenue_section: input.revenue_section,
        customer_section: input.customer_section,
        operations_section: input.operations_section,
        ads_section: input.ads_section,
        reviews_section: input.reviews_section,
        content_seo_section: input.content_seo_section,
        anomalies_section: input.anomalies_section,
        action_items: input.action_items,
        created_at: new Date(),
      }).returning('*');

      logger.info(`[bi-agent] Weekly report saved: ${report.id}`);
      return { saved: true, reportId: report.id };
    }

    default:
      return { error: `Unknown BI tool: ${toolName}` };
  }
}

module.exports = { executeBITool };
