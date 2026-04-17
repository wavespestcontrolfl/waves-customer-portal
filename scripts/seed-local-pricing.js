#!/usr/bin/env node
/**
 * seed-local-pricing.js — hydrate local pricing_config from prod
 *
 * Reason: LOCAL=1 regression harness needs a prod-mirrored pricing_config so
 *         LOCAL results can be compared byte-for-byte to HTTP results. Local
 *         DB drifted from prod (pre-Session-8.5 state). This script pulls
 *         pricing_config only — no customer data, no invoices, no vendors.
 *
 * Usage:
 *   PROD_DATABASE_URL=postgresql://... node scripts/seed-local-pricing.js
 *   # or
 *   npm run seed:pricing
 *
 * Env:
 *   PROD_DATABASE_URL   (required) — prod source (fetch via `railway variables --kv --service Postgres`)
 *   LOCAL_DATABASE_URL  (optional) — overrides DATABASE_URL for local target
 *   DATABASE_URL        (fallback local target — loaded from .env)
 *
 * Safety:
 *   - Refuses if local URL equals prod URL
 *   - Refuses if local URL looks like a prod host (railway.app, rds.amazonaws)
 *   - Writes only to local; reads only from prod
 *   - Operates only on `pricing_config` (full mirror) and
 *     `discounts WHERE is_waveguard_tier_discount = true` (upsert by discount_key)
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Client } = require('pg');

const PROD_URL = process.env.PROD_DATABASE_URL;
const LOCAL_URL = process.env.LOCAL_DATABASE_URL || process.env.DATABASE_URL;

function assertUrls() {
  if (!PROD_URL) {
    throw new Error('PROD_DATABASE_URL is required. Fetch with: railway variables --kv --service Postgres | grep DATABASE_PUBLIC_URL');
  }
  if (!LOCAL_URL) {
    throw new Error('LOCAL_DATABASE_URL or DATABASE_URL must be set for the local target');
  }
  if (LOCAL_URL === PROD_URL) {
    throw new Error('Refusing to seed: LOCAL_DATABASE_URL matches PROD_DATABASE_URL');
  }
  const prodHostSignals = ['railway.app', 'rds.amazonaws.com', 'supabase.co', 'neon.tech'];
  for (const sig of prodHostSignals) {
    if (LOCAL_URL.includes(sig)) {
      throw new Error(`Refusing to seed: LOCAL_DATABASE_URL contains '${sig}' — looks like a prod host`);
    }
  }
}

function summarizeUrl(url) {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username}:***@${u.hostname}:${u.port}${u.pathname}`;
  } catch {
    return '(unparseable)';
  }
}

async function main() {
  assertUrls();

  console.log('[seed-local-pricing] source (prod):', summarizeUrl(PROD_URL));
  console.log('[seed-local-pricing] target (local):', summarizeUrl(LOCAL_URL));

  const prodSsl = PROD_URL.includes('localhost') ? false : { rejectUnauthorized: false };
  const localSsl = LOCAL_URL.includes('localhost') ? false : { rejectUnauthorized: false };

  const prod = new Client({ connectionString: PROD_URL, ssl: prodSsl });
  const local = new Client({ connectionString: LOCAL_URL, ssl: localSsl });

  await prod.connect();
  await local.connect();

  try {
    // ── 1. pricing_config (full-table mirror) ─────────────────────────────
    const { rows } = await prod.query(
      'SELECT config_key, name, category, data, description, updated_at FROM pricing_config ORDER BY config_key'
    );

    if (rows.length === 0) {
      throw new Error('Prod pricing_config returned 0 rows — refusing to wipe local');
    }

    console.log(`[seed-local-pricing] fetched ${rows.length} pricing_config rows from prod:`);
    for (const r of rows) {
      console.log(`  - ${r.config_key.padEnd(22)} updated_at=${r.updated_at.toISOString()}`);
    }

    await local.query('BEGIN');
    await local.query('TRUNCATE TABLE pricing_config');
    for (const r of rows) {
      await local.query(
        `INSERT INTO pricing_config (config_key, name, category, data, description, updated_at)
         VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [r.config_key, r.name, r.category, JSON.stringify(r.data), r.description, r.updated_at]
      );
    }
    await local.query('COMMIT');

    const { rows: verify } = await local.query('SELECT COUNT(*)::int AS n FROM pricing_config');
    if (verify[0].n !== rows.length) {
      throw new Error(`pricing_config post-insert mismatch: expected ${rows.length}, got ${verify[0].n}`);
    }
    console.log(`[seed-local-pricing] ✓ pricing_config: ${verify[0].n} rows mirrored`);

    // ── 2. discounts (WaveGuard tier rows only — upsert by discount_key) ──
    // Scope: only is_waveguard_tier_discount=true rows. Non-tier discounts
    // on local are left untouched. The engine reads these via
    // DiscountEngine.getDiscountForTier() with a silent `|| 0` fallback,
    // so an empty set here produces zero-discount Silver/Gold/Platinum
    // results without any thrown error.
    const { rows: discRows } = await prod.query(
      `SELECT * FROM discounts
       WHERE is_waveguard_tier_discount = true
       ORDER BY requires_waveguard_tier`
    );
    if (discRows.length === 0) {
      throw new Error('Prod discounts returned 0 WaveGuard tier rows — refusing to proceed (prod looks wrong)');
    }

    console.log(`[seed-local-pricing] fetched ${discRows.length} WaveGuard tier discount rows from prod:`);
    for (const r of discRows) {
      console.log(`  - ${String(r.requires_waveguard_tier).padEnd(10)} amount=${r.amount} is_active=${r.is_active}`);
    }

    const cols = Object.keys(discRows[0]);
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(', ');
    const updateAssigns = cols.filter(c => c !== 'id' && c !== 'discount_key')
      .map(c => `"${c}" = EXCLUDED."${c}"`).join(', ');

    await local.query('BEGIN');
    for (const r of discRows) {
      const values = cols.map(c => r[c]);
      await local.query(
        `INSERT INTO discounts (${cols.map(c => `"${c}"`).join(', ')})
         VALUES (${placeholders})
         ON CONFLICT (discount_key) DO UPDATE SET ${updateAssigns}`,
        values
      );
    }
    await local.query('COMMIT');

    const { rows: discVerify } = await local.query(
      'SELECT COUNT(*)::int AS n FROM discounts WHERE is_waveguard_tier_discount = true'
    );
    if (discVerify[0].n < discRows.length) {
      throw new Error(`discounts post-upsert mismatch: expected >=${discRows.length} tier rows, got ${discVerify[0].n}`);
    }
    console.log(`[seed-local-pricing] ✓ discounts: ${discVerify[0].n} WaveGuard tier rows present`);

    console.log('[seed-local-pricing] ✓ local reference data mirrored from prod');
  } catch (err) {
    try { await local.query('ROLLBACK'); } catch {}
    throw err;
  } finally {
    await prod.end();
    await local.end();
  }
}

main().catch((err) => {
  console.error('[seed-local-pricing] FAILED:', err.message);
  process.exit(1);
});
