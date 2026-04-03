const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');

const TRACKED_COMPETITORS = ['turnerpest.com', 'hoskinspest.com', 'hometeampestdefense.com', 'orkin.com', 'terminix.com', 'trulynolen.com', 'nozzlenolen.com'];

class RankTracker {
  /**
   * Run daily rank check for priority-1 keywords (or all if weekly).
   */
  async trackRanks(priorityFilter = null) {
    const today = new Date().toISOString().split('T')[0];
    const dayOfWeek = new Date().getDay();

    let query = db('seo_target_keywords');
    if (priorityFilter) {
      query = query.where('priority', priorityFilter);
    } else {
      // Daily: priority 1. Sunday: all.
      query = dayOfWeek === 0 ? query : query.where('priority', 1);
    }

    const keywords = await query;
    logger.info(`Rank tracker: checking ${keywords.length} keywords`);

    let tracked = 0, alerts = [];

    for (const kw of keywords) {
      try {
        const result = await this.checkKeyword(kw, today);
        tracked++;

        // Check for rank drop alert (3+ position drop on priority 1)
        if (kw.priority === 1 && result.previousPosition && result.organicPosition) {
          const delta = result.organicPosition - result.previousPosition;
          if (delta >= 3) {
            alerts.push({ keyword: kw.keyword, city: kw.primary_city, from: result.previousPosition, to: result.organicPosition, delta });
          }
        }
      } catch (err) {
        logger.error(`Rank check failed for "${kw.keyword}": ${err.message}`);
      }
    }

    // Send SMS alerts for rank drops
    if (alerts.length > 0) {
      try {
        const TwilioService = require('../twilio');
        if (process.env.ADAM_PHONE) {
          const alertText = alerts.slice(0, 3).map(a => `"${a.keyword}" ${a.from}→${a.to} (↓${a.delta})`).join('\n');
          await TwilioService.sendSMS(process.env.ADAM_PHONE,
            `📉 SEO Rank Drops:\n${alertText}${alerts.length > 3 ? `\n+${alerts.length - 3} more` : ''}\n\nCheck: /admin/ads → SEO`,
            { messageType: 'internal_alert' }
          );
        }
      } catch { /* best effort */ }
    }

    logger.info(`Rank tracker: ${tracked} checked, ${alerts.length} alerts`);
    return { tracked, alerts };
  }

  async checkKeyword(kw, date) {
    // Get previous position for delta calculation
    const prev = await db('seo_rank_history')
      .where('keyword_id', kw.id)
      .orderBy('check_date', 'desc')
      .first();

    let organicPosition = null;
    let mapPackPosition = null;
    let serpFeatures = {};
    let competitorPositions = [];
    let aiOverviewCited = false;
    let aiOverviewSources = [];

    // Try DataForSEO
    if (dataforseo.configured) {
      const location = kw.primary_city ? `${kw.primary_city},Florida,United States` : 'Bradenton,Florida,United States';
      const serpData = await dataforseo.serpOrganic(kw.keyword, location);

      if (serpData?.tasks?.[0]?.result?.[0]) {
        const result = serpData.tasks[0].result[0];
        const items = result.items || [];

        // Find Waves position
        const wavesResult = items.find(i => i.type === 'organic' && (i.domain || '').includes('wavespestcontrol'));
        if (wavesResult) organicPosition = wavesResult.rank_absolute;

        // Find competitor positions
        competitorPositions = TRACKED_COMPETITORS.map(domain => {
          const comp = items.find(i => i.type === 'organic' && (i.domain || '').includes(domain.replace('.com', '')));
          return { domain, position: comp?.rank_absolute || null };
        }).filter(c => c.position);

        // Detect SERP features
        serpFeatures = {
          faq: items.some(i => i.type === 'faq'),
          paa: items.some(i => i.type === 'people_also_ask'),
          ai_overview: items.some(i => i.type === 'ai_overview'),
          local_pack: items.some(i => i.type === 'maps' || i.type === 'local_pack'),
          video: items.some(i => i.type === 'video'),
          featured_snippet: items.some(i => i.type === 'featured_snippet'),
        };

        // Check AI Overview
        const aio = items.find(i => i.type === 'ai_overview');
        if (aio) {
          aiOverviewSources = (aio.items || []).map(s => ({ domain: s.domain, snippet: s.description?.substring(0, 200) }));
          aiOverviewCited = aiOverviewSources.some(s => (s.domain || '').includes('wavespestcontrol'));
        }
      }
    } else {
      // Fallback: use GSC data if available
      try {
        const gsc = await db('gsc_queries')
          .where('query', kw.keyword)
          .orderBy('date', 'desc')
          .first();
        if (gsc) organicPosition = Math.round(parseFloat(gsc.position));
      } catch { /* GSC might not have this keyword */ }
    }

    // Store
    await db('seo_rank_history').insert({
      keyword_id: kw.id,
      check_date: date,
      organic_position: organicPosition,
      map_pack_position: mapPackPosition,
      serp_features: JSON.stringify(serpFeatures),
      ai_overview_cited: aiOverviewCited,
      ai_overview_sources: JSON.stringify(aiOverviewSources),
      competitor_positions: JSON.stringify(competitorPositions),
    }).onConflict(['keyword_id', 'check_date']).merge();

    return { organicPosition, previousPosition: prev?.organic_position, mapPackPosition, serpFeatures };
  }

  /**
   * Get rankings dashboard data.
   */
  async getDashboard(days = 7) {
    const since = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

    const keywords = await db('seo_target_keywords').orderBy('priority').orderBy('keyword');

    const rankings = [];
    for (const kw of keywords) {
      const history = await db('seo_rank_history')
        .where('keyword_id', kw.id)
        .where('check_date', '>=', since)
        .orderBy('check_date', 'desc');

      const latest = history[0];
      const oldest = history[history.length - 1];
      const delta = latest && oldest && latest.organic_position && oldest.organic_position
        ? oldest.organic_position - latest.organic_position // positive = improved
        : 0;

      rankings.push({
        ...kw,
        currentPosition: latest?.organic_position,
        mapPackPosition: latest?.map_pack_position,
        delta,
        trend: delta > 0 ? 'improving' : delta < 0 ? 'declining' : 'stable',
        serpFeatures: latest?.serp_features,
        aiOverviewCited: latest?.ai_overview_cited,
        competitorPositions: latest?.competitor_positions,
        history: history.map(h => ({ date: h.check_date, position: h.organic_position })),
      });
    }

    const improving = rankings.filter(r => r.delta > 0).length;
    const declining = rankings.filter(r => r.delta < 0).length;
    const inMapPack = rankings.filter(r => r.mapPackPosition).length;

    return { rankings, summary: { total: rankings.length, improving, declining, stable: rankings.length - improving - declining, inMapPack } };
  }
}

module.exports = new RankTracker();
