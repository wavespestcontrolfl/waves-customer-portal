const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');

class AIOverviewTracker {
  async trackDaily() {
    const keywords = await db('seo_target_keywords').where('priority', 1).limit(20);
    logger.info(`AI Overview tracker: checking ${keywords.length} keywords`);

    let checked = 0, cited = 0;

    for (const kw of keywords) {
      try {
        const location = kw.primary_city ? `${kw.primary_city},Florida,United States` : 'Bradenton,Florida,United States';
        const data = await dataforseo.serpOrganic(kw.keyword, location);
        const items = data?.tasks?.[0]?.result?.[0]?.items || [];
        const aio = items.find(i => i.type === 'ai_overview');

        if (aio) {
          const sources = (aio.items || []).map(s => ({ domain: s.domain, snippet: (s.description || '').substring(0, 200) }));
          const wavesCited = sources.some(s => (s.domain || '').includes('wavespestcontrol'));
          if (wavesCited) cited++;

          await db('seo_rank_history')
            .where('keyword_id', kw.id)
            .orderBy('check_date', 'desc')
            .first()
            .then(async (latest) => {
              if (latest) {
                await db('seo_rank_history').where('id', latest.id).update({
                  ai_overview_cited: wavesCited,
                  ai_overview_sources: JSON.stringify(sources),
                });
              }
            });
        }
        checked++;
      } catch (err) {
        logger.error(`AIO check failed for "${kw.keyword}": ${err.message}`);
      }
    }

    logger.info(`AI Overview: ${checked} checked, ${cited} citing Waves`);
    return { checked, cited };
  }

  async getDashboard() {
    const keywords = await db('seo_target_keywords').where('priority', 1);
    const results = [];

    for (const kw of keywords) {
      const latest = await db('seo_rank_history')
        .where('keyword_id', kw.id)
        .orderBy('check_date', 'desc')
        .first();

      results.push({
        keyword: kw.keyword,
        city: kw.primary_city,
        aioPresent: !!(latest?.ai_overview_sources && JSON.parse(latest.ai_overview_sources || '[]').length > 0),
        wavesCited: latest?.ai_overview_cited || false,
        sources: latest?.ai_overview_sources ? JSON.parse(latest.ai_overview_sources) : [],
      });
    }

    const total = results.length;
    const withAIO = results.filter(r => r.aioPresent).length;
    const wavesCited = results.filter(r => r.wavesCited).length;

    // Competitor citation counts
    const citationCounts = {};
    results.forEach(r => {
      r.sources.forEach(s => {
        const d = s.domain || 'unknown';
        citationCounts[d] = (citationCounts[d] || 0) + 1;
      });
    });

    const quickWins = results.filter(r => r.aioPresent && !r.wavesCited);

    return { total, withAIO, wavesCited, geoScore: total > 0 ? Math.round(wavesCited / total * 100) : 0, results, citationCounts, quickWins };
  }
}

module.exports = new AIOverviewTracker();
