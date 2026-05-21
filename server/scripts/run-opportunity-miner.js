#!/usr/bin/env node
/**
 * run-opportunity-miner.js — manual invocation wrapper for
 * gsc-opportunity-miner. Lets Adam verify miner output before any
 * cron / route wires it.
 *
 * Read-only against gsc_* (writes only to opportunity_queue, which is
 * the miner's own table). Safe to run against prod once the migration
 * has been applied there.
 *
 * Usage:
 *   node server/scripts/run-opportunity-miner.js
 *   node server/scripts/run-opportunity-miner.js --period=28 --no-persist
 *   node server/scripts/run-opportunity-miner.js --period=14 --json
 *
 * For prod data:
 *   railway run -s Postgres -- bash -c '
 *     DATABASE_URL=$DATABASE_PUBLIC_URL \
 *       node server/scripts/run-opportunity-miner.js --no-persist
 *   '
 */

const db = require('../models/db');
const miner = require('../services/seo/gsc-opportunity-miner');

const ARGS = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    if (!a.startsWith('--')) return [a, true];
    const [k, v] = a.slice(2).split('=');
    return [k, v === undefined ? true : v];
  })
);

const PERIOD = parseInt(ARGS.period || 28, 10);
const PERSIST = !ARGS['no-persist'];
const JSON_OUT = !!ARGS.json;

(async function main() {
  const t0 = Date.now();
  try {
    const result = await miner.mineAll({ periodDays: PERIOD, persist: PERSIST });
    const ms = Date.now() - t0;

    if (JSON_OUT) {
      process.stdout.write(JSON.stringify(result, null, 2));
      await db.destroy();
      return;
    }

    console.log(`\n── Opportunity Mine Result (${PERIOD}d, ${ms}ms) ──`);
    console.log(`Persisted: ${result.persisted} row(s)\n`);

    console.log('Per-bucket counts:');
    for (const [bucket, n] of Object.entries(result.counts)) {
      const err = result.errors[bucket] ? `  ⚠ ${result.errors[bucket]}` : '';
      console.log(`  ${bucket.padEnd(22)} ${String(n).padStart(4)}${err}`);
    }

    console.log('\nTop 10 by score:');
    const top = [...result.opportunities].sort((a, b) => b.score - a.score).slice(0, 10);
    for (const o of top) {
      const target = o.query || o.page_url || '—';
      const cityService = `[${o.service || '?'}/${o.city || '?'}]`;
      console.log(
        `  ${String(o.score).padStart(4)}  ${o.bucket.padEnd(22)} ${cityService.padEnd(28)} → ${o.action_type.padEnd(40)}  ${target.slice(0, 60)}`
      );
    }
    console.log('');
    await db.destroy();
  } catch (err) {
    console.error('Miner failed:', err);
    await db.destroy().catch(() => {});
    process.exit(1);
  }
})();
