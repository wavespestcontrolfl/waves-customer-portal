/**
 * Pre-slab usage-based price steps + inventory-price link (owner decision
 * 2026-07-10).
 *
 * Pricing is DB-authoritative: db-bridge.syncConstantsFromDB loads
 * `pricing_config.onetime_preslab` over the in-code constants, so the
 * constants.js changes in this PR are inert in any env carrying the row
 * unless the row is updated too. This migration:
 *
 * 1. pricing_config.onetime_preslab — adds `usage_step_sqft: 100` (quoted
 *    price floors at the cost-plus of the slab rounded UP to the next 100
 *    sqft; 0 disables = kill switch), `link_container_costs_to_catalog: true`
 *    (db-bridge overrides container costs from the inventory catalog's
 *    approved best price each sync; false = kill switch), and
 *    `catalog_product_name` per product so the link knows which
 *    products_catalog row backs each pre-slab product.
 *
 * 2. products_catalog "Termidor SC" — corrects unit_size_oz 20 → 78. The
 *    row's price has always been the 78 oz agency bottle (its vendor_pricing
 *    row says quantity '78 oz'; the 20 oz DIY bottle retails ~$70), so a 20 oz
 *    unit size made every per-oz computation ~4x off and would poison the
 *    inventory link.
 *
 * 3. vendor_pricing "Termidor SC" — the existing SiteOne $152.10 row is a
 *    manual seed with no product URL that contradicts the owner-stated real
 *    cost ($174.72/78 oz, which is Intermountain Turf's listed price). It is
 *    deactivated (not deleted) and an Intermountain Turf row at $174.72/78 oz
 *    is inserted and cached as the catalog best price, so the inventory link
 *    prices from what the owner actually pays.
 */
const MIGRATION_TAG = 'migration:20260710000020';
const UP_REASON = 'Pre-slab usage steps (100 sqft) + inventory-price link enabled (owner decision 2026-07-10)';
const DOWN_REASON = 'Rollback: disable pre-slab usage steps + inventory-price link';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.6',
  version_to: 'v4.6',
  changed_by: 'claude-2026-07-10',
  category: 'rule',
  summary: 'Pre-slab: usage-based 100-sqft price steps + inventory-price link.',
};

const USAGE_STEP_SQFT = 100;
const CATALOG_NAME_BY_PRODUCT = {
  termidor_sc: 'Termidor SC',
  taurus_sc: 'Taurus SC',
  bifen_it: 'Bifen I/T',
  talstar_p: 'Talstar P',
};
const TERMIDOR_REAL_COST = 174.72;
const TERMIDOR_CONTAINER_OZ = 78;
const STALE_SITEONE_PRICE = 152.10;
const INTERMOUNTAIN_URL = 'https://www.intermountainturf.com/products/termidor-sc-78-oz-bottle';

async function loadPreslabConfig(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'onetime_preslab' }).first();
  if (!row) return null;
  const data = typeof row.data === 'string' ? JSON.parse(row.data) : row.data;
  if (!data || typeof data !== 'object') return null;
  return data;
}

async function savePreslabConfig(knex, oldData, newData, reason) {
  await knex('pricing_config')
    .where({ config_key: 'onetime_preslab' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'onetime_preslab',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason,
    });
  }
}

exports.up = async function (knex) {
  // ── 1. pricing_config: usage step + link flags ──────────────────────────
  const data = await loadPreslabConfig(knex);
  if (data) {
    // An admin-set usage_step_sqft (any number, incl. 0 = intentionally off)
    // is left alone; only absence turns the feature on.
    const alreadyConfigured = Number.isFinite(Number(data.usage_step_sqft));
    if (!alreadyConfigured) {
      const newData = {
        ...data,
        usage_step_sqft: USAGE_STEP_SQFT,
        link_container_costs_to_catalog: data.link_container_costs_to_catalog === false ? false : true,
        products: { ...(data.products || {}) },
      };
      for (const [key, catalogName] of Object.entries(CATALOG_NAME_BY_PRODUCT)) {
        newData.products[key] = {
          ...(newData.products[key] || {}),
          catalog_product_name: newData.products[key]?.catalog_product_name || catalogName,
        };
      }
      await savePreslabConfig(knex, data, newData, UP_REASON);

      if (await knex.schema.hasTable('pricing_changelog')) {
        const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
        if (!existing) {
          await knex('pricing_changelog').insert({
            ...CHANGELOG_IDENTITY,
            affected_services: JSON.stringify(['pre_slab_termiticide', 'pre_slab_termidor']),
            before_value: JSON.stringify({ usage_step_sqft: null, link_container_costs_to_catalog: null }),
            after_value: JSON.stringify({ usage_step_sqft: USAGE_STEP_SQFT, link_container_costs_to_catalog: true }),
            rationale: 'Owner decision 2026-07-10: pre-slab quotes flat-lined across the wide contextual-minimum buckets (82 sqft and 191 sqft both $191). Price now floors at the cost-plus of the slab rounded UP to the next 100 sqft, so it climbs with real product usage per the registered oz/10 sqft rates and container costs, and keeps stepping past the last bucket (owner: extend to 10,000+ sqft). Contextual minimums remain the value floor, so no product ever prices below the old schedule. Container costs additionally sync from the inventory catalog best price (approved rows only, 0.5x-2x per-oz sanity band). Kills: usage_step_sqft=0 / link_container_costs_to_catalog=false.',
          });
        }
      }
    }
  }

  // ── 2. products_catalog: Termidor SC unit size → 78 oz ──────────────────
  // Prod carries 20; fresh/preview DBs carry NULL (the 2026-04-17 product
  // seed predates the unit_size_oz column) — both are wrong for a row whose
  // price is the 78 oz agency bottle, and both would keep the inventory
  // link from ever engaging for Termidor (codex r1).
  if (await knex.schema.hasTable('products_catalog')) {
    await knex('products_catalog')
      .where({ name: 'Termidor SC' })
      .where(function () {
        this.where('unit_size_oz', 20).orWhereNull('unit_size_oz');
      })
      .update({ unit_size_oz: TERMIDOR_CONTAINER_OZ, updated_at: knex.fn.now() });

    // ── 3. vendor_pricing: retire stale SiteOne seed, assert owner-real cost ─
    // The SiteOne retirement + catalog recache run whether or not an
    // Intermountain row already exists — a pre-existing row must not no-op
    // the correction and leave the stale $152.10 cached as best price
    // (codex r1). An existing Intermountain row is updated in place to the
    // owner-stated cost instead of inserting a duplicate.
    if (await knex.schema.hasTable('vendor_pricing') && await knex.schema.hasTable('vendors')) {
      const termidor = await knex('products_catalog').where({ name: 'Termidor SC' }).first('id');
      const intermountain = await knex('vendors').where({ name: 'Intermountain Turf' }).first('id');
      if (termidor && intermountain) {
        await knex('vendor_pricing')
          .where({ product_id: termidor.id })
          .whereNull('vendor_product_url')
          .where('price', STALE_SITEONE_PRICE)
          .update({ is_active: false, is_best_price: false, updated_at: knex.fn.now() });

        const ownerRealValues = {
          price: TERMIDOR_REAL_COST,
          price_amount: TERMIDOR_REAL_COST,
          currency: 'USD',
          quantity: '78 oz',
          unit: 'oz',
          unit_normalized: 'oz',
          price_per_oz: Math.round((TERMIDOR_REAL_COST / TERMIDOR_CONTAINER_OZ) * 10000) / 10000,
          approval_status: 'approved',
          is_best_price: true,
          is_active: true,
          last_checked_at: knex.fn.now(),
        };
        const existing = await knex('vendor_pricing')
          .where({ product_id: termidor.id, vendor_id: intermountain.id })
          .first('id');
        let bestRowId;
        if (existing) {
          await knex('vendor_pricing')
            .where({ id: existing.id })
            .update({ ...ownerRealValues, updated_at: knex.fn.now() });
          await knex('vendor_pricing')
            .where({ id: existing.id })
            .whereNull('vendor_product_url')
            .update({ vendor_product_url: INTERMOUNTAIN_URL });
          bestRowId = existing.id;
        } else {
          const [inserted] = await knex('vendor_pricing')
            .insert({
              product_id: termidor.id,
              vendor_id: intermountain.id,
              ...ownerRealValues,
              vendor_product_url: INTERMOUNTAIN_URL,
              source_type: 'manual_seed',
              price_type: 'manual',
              confidence_score: 0.9,
            })
            .returning('id');
          bestRowId = inserted?.id || inserted;
        }

        await knex('products_catalog').where({ id: termidor.id }).update({
          best_vendor_pricing_id: bestRowId,
          best_price: TERMIDOR_REAL_COST,
          best_price_amount_cached: TERMIDOR_REAL_COST,
          best_price_vendor_id_cached: intermountain.id,
          best_vendor: 'Intermountain Turf',
          best_price_updated_at: knex.fn.now(),
          best_price_status: 'current',
          needs_pricing: false,
          updated_at: knex.fn.now(),
        });
      }
    }
  }
};

exports.down = async function (knex) {
  // Only unwind the config keys if this migration's up() set them (keyed off
  // the audit row) so later admin edits survive rollback.
  if (await knex.schema.hasTable('pricing_config_audit')) {
    const ownUp = await knex('pricing_config_audit')
      .where({ config_key: 'onetime_preslab', changed_by: MIGRATION_TAG, reason: UP_REASON })
      .first('id');
    if (ownUp) {
      const data = await loadPreslabConfig(knex);
      if (data) {
        const newData = { ...data, products: { ...(data.products || {}) } };
        delete newData.usage_step_sqft;
        delete newData.link_container_costs_to_catalog;
        for (const key of Object.keys(CATALOG_NAME_BY_PRODUCT)) {
          if (newData.products[key]) {
            newData.products[key] = { ...newData.products[key] };
            delete newData.products[key].catalog_product_name;
          }
        }
        await savePreslabConfig(knex, data, newData, DOWN_REASON);
      }
    }
  }
  if (await knex.schema.hasTable('pricing_changelog')) {
    await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
  }

  // Catalog corrections: best-effort. Removes the Intermountain row keyed by
  // this migration's URL (if up() updated a pre-existing URL-less row rather
  // than inserting, that row is removed too — acceptable for a rollback that
  // also revives the SiteOne seed as best price). unit_size_oz stays 78 —
  // 20/NULL was a data bug, not a prior state worth restoring.
  if (await knex.schema.hasTable('products_catalog') && await knex.schema.hasTable('vendor_pricing')) {
    const termidor = await knex('products_catalog').where({ name: 'Termidor SC' }).first('id');
    if (termidor) {
      const inserted = await knex('vendor_pricing')
        .where({ product_id: termidor.id, vendor_product_url: INTERMOUNTAIN_URL })
        .first('id');
      if (inserted) {
        await knex('products_catalog').where({ id: termidor.id }).update({
          best_vendor_pricing_id: null,
          best_price: STALE_SITEONE_PRICE,
          best_price_amount_cached: STALE_SITEONE_PRICE,
          best_price_vendor_id_cached: null,
          best_vendor: 'SiteOne',
          needs_pricing: false,
          updated_at: knex.fn.now(),
        });
        await knex('vendor_pricing').where({ id: inserted.id }).del();
        await knex('vendor_pricing')
          .where({ product_id: termidor.id })
          .whereNull('vendor_product_url')
          .where('price', STALE_SITEONE_PRICE)
          .update({ is_active: true, is_best_price: true, updated_at: knex.fn.now() });
      }
    }
  }
};
