const db = require('../../models/db');
const logger = require('../logger');
const { etDateString, addETDays } = require('../../utils/datetime-et');

class CannibalizationDetector {
  async detect(domain) {
    logger.info('Cannibalization detection running...');
    const since = etDateString(addETDays(new Date(), -28));

    // Use gsc_query_page_map for real query→page relationships
    let baseQuery = db('gsc_query_page_map')
      .where('date_from', '>=', since);
    if (domain) baseQuery = baseQuery.where('domain', domain);

    // Find queries with multiple pages getting impressions
    const queries = await baseQuery.clone()
      .select('query', 'domain')
      .count('distinct page_url as page_count')
      .sum('impressions as total_impressions')
      .groupBy('query', 'domain')
      .having(db.raw('count(distinct page_url) >= 2'))
      .having(db.raw('sum(impressions) > 20'));

    let flagged = 0;
    for (const q of queries) {
      // Get all pages for this query
      const pages = await db('gsc_query_page_map')
        .where('query', q.query)
        .where('domain', q.domain)
        .where('date_from', '>=', since)
        .select('page_url')
        .sum('impressions as impressions')
        .sum('clicks as clicks')
        .groupBy('page_url')
        .having(db.raw('sum(impressions) > 10'))
        .orderBy('impressions', 'desc')
        .limit(5);

      if (pages.length < 2) continue;

      const impressionsSplit = {};
      const clicksSplit = {};
      pages.forEach((p) => {
        impressionsSplit[p.page_url] = parseInt(p.impressions);
        clicksSplit[p.page_url] = parseInt(p.clicks);
      });

      const totalImpr = Object.values(impressionsSplit).reduce((s, v) => s + v, 0);
      const maxShare = Math.max(...Object.values(impressionsSplit)) / totalImpr;

      if (maxShare < 0.7) {
        // Winner = page with most clicks
        const winner = pages.reduce((best, p) => parseInt(p.clicks) > parseInt(best.clicks) ? p : best, pages[0]);
        const wasteImpressions = totalImpr - parseInt(winner.impressions);
        const urls = pages.map((p) => p.page_url);

        await db('seo_cannibalization_flags')
          .insert({
            query: q.query,
            urls: JSON.stringify(urls),
            impressions_split: JSON.stringify(impressionsSplit),
            clicks_split: JSON.stringify(clicksSplit),
            recommendation: `Consolidate content — ${urls.length} URLs splitting impressions for "${q.query}". Winner: ${winner.page_url}`,
            winner_url: winner.page_url,
            winner_clicks: parseInt(winner.clicks),
            winner_impressions: parseInt(winner.impressions),
            total_waste_impressions: wasteImpressions,
            domain: q.domain,
            status: 'open',
          })
          .onConflict(db.raw('(query) WHERE status = \'open\''))
          .merge();
        flagged++;
      }
    }

    logger.info(`Cannibalization: ${flagged} new flags`);
    return { flagged };
  }

  async getDashboard() {
    const flags = await db('seo_cannibalization_flags').orderBy('created_at', 'desc');
    return {
      total: flags.length,
      open: flags.filter(f => f.status === 'open').length,
      resolved: flags.filter(f => f.status === 'resolved').length,
      flags: flags.map(f => ({
        ...f,
        urls: typeof f.urls === 'string' ? JSON.parse(f.urls) : f.urls,
        impressions_split: typeof f.impressions_split === 'string' ? JSON.parse(f.impressions_split) : f.impressions_split,
      })),
    };
  }
}

module.exports = new CannibalizationDetector();
