#!/usr/bin/env node
/**
 * Sync prod → local pricing config.
 *
 * Copies `pricing_config` + `lawn_pricing_brackets` from prod to this local DB
 * so LOCAL-mode regression (`LOCAL=1 npx jest server/tests/pricing-engine.regression.test.js`)
 * runs byte-identical to HTTP mode.
 *
 * Requires PROD_DATABASE_URL in env. Grab it from Railway:
 *
 *   export PROD_DATABASE_URL="$(railway variables --kv --service Postgres \
 *     | awk -F= '/^DATABASE_PUBLIC_URL=/ { sub(/^DATABASE_PUBLIC_URL=/,""); print }')"
 *
 * Usage:
 *   node server/scripts/sync-prod-pricing-config.js           # dry run (show diff)
 *   node server/scripts/sync-prod-pricing-config.js --apply   # write changes
 *
 * After --apply: restart the dev server so db-bridge re-hydrates its 60s cache.
 */

const knexFactory = require('knex');
const localDb = require('../models/db');

const APPLY = process.argv.includes('--apply');

function fail(msg) {
  console.error(`\n✖ ${msg}\n`);
  process.exit(1);
}

function connectProd() {
  const url = process.env.PROD_DATABASE_URL;
  if (!url) {
    fail(
      'PROD_DATABASE_URL is not set.\n\n' +
      'Grab it from Railway:\n' +
      '  export PROD_DATABASE_URL="$(railway variables --kv --service Postgres \\\n' +
      '    | awk -F= \'/^DATABASE_PUBLIC_URL=/ { sub(/^DATABASE_PUBLIC_URL=/,""); print }\')"\n'
    );
  }
  const looksLocal = /(127\.0\.0\.1|localhost|::1)/.test(url);
  if (looksLocal) {
    fail(`PROD_DATABASE_URL looks local (${url}). Refusing — this script pulls FROM prod.`);
  }
  return knexFactory({
    client: 'pg',
    connection: { connectionString: url, ssl: { rejectUnauthorized: false } },
    pool: { min: 0, max: 2 },
  });
}

function norm(val) {
  if (val == null) return null;
  return typeof val === 'string' ? val : JSON.stringify(val);
}

async function diffPricingConfig(prodDb) {
  const [prod, local] = await Promise.all([
    prodDb('pricing_config').select('config_key', 'name', 'category', 'data', 'description', 'sort_order'),
    localDb('pricing_config').select('config_key', 'name', 'category', 'data', 'description', 'sort_order'),
  ]);

  const localMap = new Map(local.map(r => [r.config_key, r]));
  const prodMap = new Map(prod.map(r => [r.config_key, r]));

  const adds = [];
  const updates = [];
  const unchanged = [];
  const stale = [];

  for (const row of prod) {
    const l = localMap.get(row.config_key);
    if (!l) { adds.push(row); continue; }
    const changed =
      norm(row.data) !== norm(l.data) ||
      row.name !== l.name ||
      row.category !== l.category ||
      row.description !== l.description ||
      row.sort_order !== l.sort_order;
    if (changed) updates.push(row); else unchanged.push(row);
  }
  for (const row of local) {
    if (!prodMap.has(row.config_key)) stale.push(row);
  }
  return { adds, updates, unchanged, stale, prodCount: prod.length, localCount: local.length };
}

async function diffLawnBrackets(prodDb) {
  const [prod, local] = await Promise.all([
    prodDb('lawn_pricing_brackets').select('grass_track', 'sqft_bracket', 'tier', 'monthly_price'),
    localDb('lawn_pricing_brackets').select('grass_track', 'sqft_bracket', 'tier', 'monthly_price'),
  ]);

  const key = r => `${r.grass_track}|${r.sqft_bracket}|${r.tier}`;
  const localMap = new Map(local.map(r => [key(r), r]));
  const prodMap = new Map(prod.map(r => [key(r), r]));

  const adds = [];
  const updates = [];
  const unchanged = [];
  const stale = [];

  for (const row of prod) {
    const l = localMap.get(key(row));
    if (!l) { adds.push(row); continue; }
    if (Number(l.monthly_price) !== Number(row.monthly_price)) updates.push({ row, from: l.monthly_price, to: row.monthly_price });
    else unchanged.push(row);
  }
  for (const row of local) {
    if (!prodMap.has(key(row))) stale.push(row);
  }
  return { adds, updates, unchanged, stale, prodCount: prod.length, localCount: local.length };
}

async function applyPricingConfig(rows) {
  if (!rows.length) return;
  for (const row of rows) {
    await localDb('pricing_config')
      .insert({
        config_key: row.config_key,
        name: row.name,
        category: row.category,
        data: row.data, // knex handles JSONB serialization
        description: row.description,
        sort_order: row.sort_order,
      })
      .onConflict('config_key')
      .merge(['name', 'category', 'data', 'description', 'sort_order', 'updated_at']);
  }
}

async function applyLawnBrackets(rows) {
  if (!rows.length) return;
  for (const row of rows) {
    await localDb('lawn_pricing_brackets')
      .insert({
        grass_track: row.grass_track,
        sqft_bracket: row.sqft_bracket,
        tier: row.tier,
        monthly_price: row.monthly_price,
      })
      .onConflict(['grass_track', 'sqft_bracket', 'tier'])
      .merge(['monthly_price', 'updated_at']);
  }
}

async function run() {
  const prodDb = connectProd();
  console.log(`\n[sync-prod-pricing] Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}\n`);

  // ── pricing_config ──────────────────────────────────────────────────
  const cfg = await diffPricingConfig(prodDb);
  console.log(`pricing_config   prod=${cfg.prodCount}  local=${cfg.localCount}`);
  console.log(`  + add:       ${cfg.adds.length}`);
  console.log(`  ↻ update:    ${cfg.updates.length}`);
  console.log(`  = unchanged: ${cfg.unchanged.length}`);
  console.log(`  ! local-only: ${cfg.stale.length}${cfg.stale.length ? ' (NOT deleted — inspect manually)' : ''}`);
  if (cfg.adds.length)    cfg.adds.forEach(r => console.log(`    + ${r.config_key}`));
  if (cfg.updates.length) cfg.updates.forEach(r => console.log(`    ↻ ${r.config_key}`));
  if (cfg.stale.length)   cfg.stale.forEach(r => console.log(`    ! ${r.config_key} (in local, not in prod)`));

  // ── lawn_pricing_brackets ──────────────────────────────────────────
  const lawn = await diffLawnBrackets(prodDb);
  console.log(`\nlawn_pricing_brackets  prod=${lawn.prodCount}  local=${lawn.localCount}`);
  console.log(`  + add:       ${lawn.adds.length}`);
  console.log(`  ↻ update:    ${lawn.updates.length}`);
  console.log(`  = unchanged: ${lawn.unchanged.length}`);
  console.log(`  ! local-only: ${lawn.stale.length}${lawn.stale.length ? ' (NOT deleted — inspect manually)' : ''}`);
  if (lawn.updates.length) {
    lawn.updates.slice(0, 20).forEach(({ row, from, to }) =>
      console.log(`    ↻ ${row.grass_track}/${row.sqft_bracket}/${row.tier}: $${from} → $${to}`)
    );
    if (lawn.updates.length > 20) console.log(`    … (${lawn.updates.length - 20} more)`);
  }

  const totalChanges = cfg.adds.length + cfg.updates.length + lawn.adds.length + lawn.updates.length;
  if (totalChanges === 0) {
    console.log(`\n✓ Local is already in sync with prod. Nothing to do.\n`);
    await prodDb.destroy();
    return;
  }

  if (!APPLY) {
    console.log(`\n→ ${totalChanges} row change(s) would be written. Re-run with --apply to commit.\n`);
    await prodDb.destroy();
    return;
  }

  console.log(`\nApplying ${cfg.adds.length + cfg.updates.length} pricing_config + ${lawn.adds.length + lawn.updates.length} lawn_pricing_brackets upserts…`);
  await applyPricingConfig([...cfg.adds, ...cfg.updates]);
  await applyLawnBrackets([...lawn.adds, ...lawn.updates]);
  console.log(`✓ Done.\n`);
  console.log(`NEXT: restart the dev server so db-bridge re-hydrates its 60s cache.\n`);

  await prodDb.destroy();
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch(err => { console.error('[sync-prod-pricing] FATAL:', err); process.exit(1); });
}

module.exports = { run };
