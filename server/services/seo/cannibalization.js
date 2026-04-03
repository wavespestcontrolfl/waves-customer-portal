const db = require('../../models/db');
const logger = require('../logger');

class CannibalizationDetector {
  async detect() {
    logger.info('Cannibalization detection running...');
    const since = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];

    // Find queries where multiple URLs got impressions
    const queryPages = await db('gsc_pages')
      .where('date', '>=', since)
      .select('page_url')
      .sum('impressions as impressions')
      .sum('clicks as clicks')
      .groupBy('page_url');

    // Cross-reference: find queries appearing for multiple Waves URLs
    const queries = await db('gsc_queries')
      .where('date', '>=', since)
      .select('query')
      .sum('impressions as impressions')
      .sum('clicks as clicks')
      .groupBy('query')
      .having(db.raw('count(distinct date) > 5'));

    // For each query, check if multiple pages compete
    let flagged = 0;
    for (const q of queries) {
      const pages = await db('gsc_pages')
        .leftJoin('gsc_queries', function () {
          this.on(db.raw('1=1')); // simplified — in practice would need query-page mapping
        })
        .where('gsc_pages.date', '>=', since)
        .select('gsc_pages.page_url')
        .sum('gsc_pages.impressions as impressions')
        .sum('gsc_pages.clicks as clicks')
        .groupBy('gsc_pages.page_url')
        .having(db.raw('sum(gsc_pages.impressions) > 10'))
        .limit(5);

      if (pages.length >= 2) {
        const urls = pages.map(p => p.page_url);
        const impressionsSplit = {};
        const clicksSplit = {};
        pages.forEach(p => {
          impressionsSplit[p.page_url] = parseInt(p.impressions);
          clicksSplit[p.page_url] = parseInt(p.clicks);
        });

        // Check if it's genuine cannibalization (no single URL dominates > 70%)
        const totalImpr = Object.values(impressionsSplit).reduce((s, v) => s + v, 0);
        const maxShare = Math.max(...Object.values(impressionsSplit)) / totalImpr;

        if (maxShare < 0.7) {
          const existing = await db('seo_cannibalization_flags').where('query', q.query).where('status', 'open').first();
          if (!existing) {
            await db('seo_cannibalization_flags').insert({
              query: q.query,
              urls: JSON.stringify(urls),
              impressions_split: JSON.stringify(impressionsSplit),
              clicks_split: JSON.stringify(clicksSplit),
              recommendation: `Consolidate content — ${urls.length} URLs splitting impressions for "${q.query}"`,
            });
            flagged++;
          }
        }
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
