const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const { etParts, etDateString, addETDays } = require('../../utils/datetime-et');

const TRACKED_COMPETITORS = ['turnerpest.com', 'hoskinspest.com', 'hometeampestdefense.com', 'orkin.com', 'terminix.com', 'trulynolen.com', 'nozzlenolen.com'];

// What one result page held, stored with each rank row (serp_features.page). Counts and public result
// domains only. From 2026-11-06 no check found Waves or a tracked rival, also with DataForSEO's
// poisoned-page repair on (GATE_DATAFORSEO_RESOLVE_POISONED), and the row did not say why: a page with
// no organic results, with unrelated results, or with repaired ones. `repaired` counts organic results
// DataForSEO read again from the live web (their `checks` value names `from_web`).
// DataForSEO marks a repaired result with the entry `from_web` in its `checks` list. An object form counts
// only when it says true: `{ from_web: false }` is a result that was not repaired.
function repairedFromWeb(checks) {
  if (Array.isArray(checks)) return checks.includes('from_web');
  return Boolean(checks) && typeof checks === 'object' && checks.from_web === true;
}

// The site a result links to, read from its URL: the host, or the target of a Google redirect link
// (google.<tld>/url?q=<target> or ?url=<target>). From 2026-11-22 every repaired result carried the
// domain google.com, so `domain` alone cannot say which site the result is (Claude queue 5060dbe3).
function resultHost(url) {
  let parsed;
  try { parsed = new URL(String(url || '')); } catch { return ''; }
  const host = parsed.hostname.toLowerCase();
  if (/(^|\.)google\.[a-z.]+$/.test(host)) {
    const target = parsed.searchParams.get('q') || parsed.searchParams.get('url');
    if (target) {
      try { return `${host}>${new URL(target).hostname.toLowerCase()}`.slice(0, 80); } catch { /* not a URL */ }
    }
  }
  return host.slice(0, 80);
}

function pageFacts(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const types = {};
  for (const item of list) {
    const type = String(item.type || 'unknown').slice(0, 40);
    types[type] = (types[type] || 0) + 1;
  }
  const organic = list.filter(i => i.type === 'organic');
  return {
    items: list.length,
    types,
    organic: organic.length,
    repaired: organic.filter(i => repairedFromWeb(i.checks)).length,
    top_domains: organic.slice(0, 5).map(i => String(i.domain || '').toLowerCase().slice(0, 80)),
    top_hosts: organic.slice(0, 5).map(i => resultHost(i.url)),
  };
}

class RankTracker {
  /**
   * Run daily rank check for priority-1 keywords (or all if weekly).
   */
  async trackRanks(priorityFilter = null) {
    // Read ET — server runs UTC; Sunday-scan fired one day early at 8 PM ET Sat.
    const now = new Date();
    const today = etDateString(now);
    const dayOfWeek = etParts(now).dayOfWeek;

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

    // Rank drops leave an owner alert (was an internal text to the owner's
    // phone, silenced since 2026-09; services/owner-alerts.js). One row per day.
    if (alerts.length > 0) {
      const alertText = alerts.slice(0, 3).map(a => `"${a.keyword}" ${a.from}→${a.to} (↓${a.delta})`).join('\n');
      await require('../owner-alerts').recordOwnerAlert('seo-rank-drops', {
        action: 'check SEO rank drops',
        why: `${alerts.length} priority keyword${alerts.length === 1 ? '' : 's'} fell 3 or more places today.`,
        subject: { type: 'check', id: 'seo-rank-drops' },
        text: `SEO Rank Drops:\n${alertText}${alerts.length > 3 ? `\n+${alerts.length - 3} more` : ''}\n\nCheck: /admin/ads → SEO`,
        link: '/admin/ads',
        dedupeKey: `owner-alert:seo-rank-drops:${today}`,
      });
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
        serpFeatures.page = pageFacts(items);

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
    const since = etDateString(addETDays(new Date(), -days));

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
module.exports._private = { pageFacts, resultHost };
