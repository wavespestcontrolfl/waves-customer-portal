#!/usr/bin/env node
/**
 * Check live URL status for content_registry rows.
 *
 * Default is a dry-run over high-risk reconciliation buckets. Commit mode
 * updates only registry mirror fields: http/live status, redirect target,
 * canonical target, noindex, and sitemap presence. It never edits content,
 * blog_posts, Astro files, or publishing state.
 */

const db = require('../models/db');
const liveStatus = require('../services/content/content-registry-live-status');

function parseArgs(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      out[arg] = true;
      continue;
    }
    const raw = arg.slice(2);
    const eq = raw.indexOf('=');
    if (eq !== -1) {
      out[raw.slice(0, eq)] = raw.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[raw] = next;
      i += 1;
    } else {
      out[raw] = true;
    }
  }
  return out;
}

function boolFlag(value) {
  if (value === true) return true;
  return /^(1|true|yes|on)$/i.test(String(value || ''));
}

function printSummary(result) {
  const s = result.summary || {};
  console.log('');
  console.log(`Mode:             ${result.mode}`);
  console.log(`Status filters:   ${result.statuses ? result.statuses.join(', ') : 'all'}`);
  console.log(`Base URL:         ${result.base_url}`);
  if (result.sitemap_error) console.log(`Sitemap warning:  ${result.sitemap_error}`);
  console.log(`Rows checked:     ${s.checked_count || 0}`);
  console.log(`Rows updated:     ${s.updated_count || 0}`);
  console.log(`Errors:           ${s.error_count || 0}`);
  console.log('Live statuses:');
  for (const [status, count] of Object.entries(s.by_live_status || {})) {
    console.log(`  ${status}: ${count}`);
  }
  if (result.mode === 'dry_run') {
    console.log('');
    console.log('Dry-run only. Re-run with --commit to update registry mirror fields.');
  }
}

async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const commit = boolFlag(args.commit);
  const json = boolFlag(args.json);
  const statuses = Object.prototype.hasOwnProperty.call(args, 'status')
    ? liveStatus.normalizeStatuses(args.status)
    : liveStatus.DEFAULT_STATUSES;
  const result = await liveStatus.runContentRegistryLiveStatusCheck({
    database: db,
    commit,
    statuses,
    limit: args.limit || liveStatus.DEFAULT_LIMIT,
    concurrency: args.concurrency || liveStatus.DEFAULT_CONCURRENCY,
    baseUrl: args['base-url'] || process.env.CONTENT_REGISTRY_PUBLIC_BASE_URL || liveStatus.DEFAULT_BASE_URL,
    sitemapUrl: args['sitemap-url'] || null,
    useSitemap: !boolFlag(args['no-sitemap']),
    timeoutMs: args['timeout-ms'] || liveStatus.DEFAULT_TIMEOUT_MS,
  });

  if (json) console.log(JSON.stringify(result, null, 2));
  else printSummary(result);

  await db.destroy();
  if (!result.ok) process.exit(1);
}

if (require.main === module) {
  main().catch(async (err) => {
    console.error(err.stack || err.message);
    await db.destroy().catch(() => {});
    process.exit(1);
  });
}

module.exports = {
  parseArgs,
  boolFlag,
  printSummary,
  main,
};
