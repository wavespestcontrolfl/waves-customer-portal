/**
 * Link Prospect Indexer (Backlink Manager M1)
 *
 * Answers "link status on Google" for each LIVE prospect:
 *   - indexing_status: is the EXTERNAL page hosting our link in Google's index?
 *     (an unindexed linking page passes ~no equity). Checked via DataForSEO `site:`
 *     SERP — GSC URL Inspection CANNOT see third-party URLs.
 *   - quality_signals.target_indexed: is OUR linked-to money page indexed? Checked via
 *     GSC URL Inspection (works only on our own verified property). Cached per target
 *     page within a run to conserve quota.
 *
 * Credit discipline: capped per run, oldest-checked-first. Aligns with seoIntelligence gate.
 */
const db = require('../../models/db');
const logger = require('../logger');
const dataforseo = require('./dataforseo');
const SearchConsole = require('./search-console');

async function indexProspects(prospects, targetCache = new Map()) {
  if (prospects.length === 0) return { checked: 0, indexed: 0 };

  // GSC target-page indexation — inspect each unique target page once per run.
  async function targetIndexed(targetPage) {
    if (!targetPage) return null;
    if (targetCache.has(targetPage)) return targetCache.get(targetPage);
    const r = await SearchConsole.inspectUrl(targetPage);
    const val = r.ok ? r.indexed : null;
    targetCache.set(targetPage, val);
    return val;
  }

  let indexed = 0, checked = 0;
  const now = new Date();

  for (const p of prospects) {
    try {
      const linkIdx = await dataforseo.checkIndexed(p.live_url); // indexed|not_indexed|unknown
      const tgt = await targetIndexed(p.target_page);

      const quality = { ...(p.quality_signals || {}) };
      if (tgt !== null) quality.target_indexed = tgt;

      const patch = {
        last_index_check: now,
        quality_signals: JSON.stringify(quality),
        updated_at: now,
      };

      if (linkIdx !== 'unknown') {
        patch.indexing_status = linkIdx; // 'indexed' | 'not_indexed'
        if (linkIdx === 'indexed') { patch.status = 'indexed'; indexed++; }
        else if (p.status === 'indexed') patch.status = 'live'; // regressed out of the index
      }

      await db('seo_link_prospects').where({ id: p.id }).update(patch);
      checked++;
    } catch (err) {
      logger.error(`[link-indexer] ${p.id} (${p.target_domain}) failed: ${err.message}`);
    }
  }

  return { checked, indexed };
}

async function run({ limit = 50 } = {}) {
  // Only check links we believe are live; oldest index-check first.
  const prospects = await db('seo_link_prospects')
    .whereIn('status', ['live', 'indexed'])
    .whereNotNull('live_url')
    .orderByRaw('last_index_check NULLS FIRST')
    .limit(limit);

  if (prospects.length === 0) {
    logger.info('[link-indexer] no live prospects to check');
    return { checked: 0, indexed: 0 };
  }

  const { checked, indexed } = await indexProspects(prospects);

  logger.info(`[link-indexer] checked ${checked}/${prospects.length}, ${indexed} indexed`);
  return { checked, indexed };
}

async function runOne(prospectOrId) {
  const prospect = typeof prospectOrId === 'object'
    ? prospectOrId
    : await db('seo_link_prospects').where({ id: prospectOrId }).first();
  if (!prospect || !prospect.live_url || !['live', 'indexed'].includes(prospect.status)) {
    return { checked: 0, indexed: 0 };
  }
  const result = await indexProspects([prospect]);
  logger.info(`[link-indexer] checked selected prospect ${prospect.id}: ${result.indexed} indexed`);
  return result;
}

module.exports = { run, runOne };
