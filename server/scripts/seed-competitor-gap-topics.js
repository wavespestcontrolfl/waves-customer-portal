#!/usr/bin/env node
/**
 * Seed the curated competitor-gap audit topics
 * (server/data/competitor-gap-topics-v1.json) into opportunity_queue as
 * 'competitor_gap' rows — the same row shape the quarterly
 * competitor-gap-miner produces, so a later miner run upserts these keys
 * instead of duplicating them (and once a topic publishes, the miner's
 * sitemap-coverage check drops it permanently).
 *
 * Usage:
 *   node server/scripts/seed-competitor-gap-topics.js --dry-run   # print, no writes
 *   node server/scripts/seed-competitor-gap-topics.js             # upsert all
 *   node server/scripts/seed-competitor-gap-topics.js --file=path # alternate manifest
 *
 * Idempotent: dedupe_key competitor_gap::<service>::_::<query> +
 * ON CONFLICT DO UPDATE; claimed/done/pending_review rows are never reset.
 *
 * Rows are NOT operator-pinned: scores carry the audit's priority order, but
 * SERP profiling / decision routing / quality gates all run normally — these
 * are mined topics with human curation, not operator-authored briefs.
 */

const fs = require('fs');
const path = require('path');
const miner = require('../services/seo/competitor-gap-miner');

const { dedupeKeyFor } = miner._internals;
const DEFAULT_MANIFEST = path.join(__dirname, '../data/competitor-gap-topics-v1.json');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const stripped = a.slice(2);
    const eq = stripped.indexOf('=');
    if (eq === -1) return [stripped, true];
    return [stripped.slice(0, eq), stripped.slice(eq + 1)];
  })
);

const dryRun = !!(ARGS['dry-run'] || ARGS.dryrun);
const file = ARGS.file ? String(ARGS.file) : DEFAULT_MANIFEST;

function rowsFromManifest(manifest) {
  if (!Array.isArray(manifest.topics) || !manifest.topics.length) {
    throw new Error('manifest has no topics');
  }
  return manifest.topics.map((t) => {
    if (!t.query || !t.score || !t.competitor_domain || t.competitor_position == null || t.search_volume == null) {
      throw new Error(`manifest topic missing required fields: ${JSON.stringify(t).slice(0, 120)}`);
    }
    return {
      bucket: 'competitor_gap',
      action_type: 'new_supporting_blog',
      query: t.query,
      page_url: null,
      service: t.service || 'pest',
      city: null,
      score: t.score,
      score_breakdown: { base: t.score, operator_priority: `audit manifest ${manifest.set}/${manifest.version}` },
      signal_metadata: {
        source: 'competitor-gap-audit-2026-06-11',
        search_volume: t.search_volume,
        volume_note: t.volume_note || null,
        competitor_domain: t.competitor_domain,
        competitor_position: t.competitor_position,
        competitor_url: t.competitor_url || null,
        geo_bucket: 'generic',
        audit_angle: t.angle || null,
      },
      dedupe_key: dedupeKeyFor(t.query),
    };
  });
}

(async function main() {
  try {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = rowsFromManifest(manifest);
    for (const row of rows) {
      console.log(`${dryRun ? '[dry-run] ' : ''}${row.dedupe_key}  score=${row.score}  vol=${row.signal_metadata.search_volume}  via ${row.signal_metadata.competitor_domain}@${row.signal_metadata.competitor_position}`);
    }
    if (dryRun) {
      console.log(`[dry-run] would seed ${rows.length} competitor-gap topic(s).`);
      process.exit(0);
    }
    const count = await miner.persistAll(rows);
    console.log(`Seeded ${count}/${rows.length} competitor-gap topic(s) from ${path.basename(file)}.`);
    process.exit(0);
  } catch (err) {
    console.error(`seed-competitor-gap-topics failed: ${err.message}`);
    process.exit(1);
  }
})();
