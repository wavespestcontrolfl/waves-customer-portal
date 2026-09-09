/**
 * Termite bait — station cost basis and inventory link (plan
 * docs/estimator-pricing-plan-2026-09-03.md §A3, PR A1; owner 2026-09-02/03).
 *
 * Pricing is DB-authoritative: db-bridge loads pricing_config.termite_install
 * over the constants, so the constants.js change in this PR is inert in prod
 * without this rewrite. One deliberate price move:
 *
 *   trelona_bait / trelona_station_cost  22.05 → 24.00  ($384.00 / 16-station
 *   box, the approved supplier price; the April $352.80 box is retired)
 *   → install at 15 stations $610 → $653 (× 1.45 on hardware + $6/station).
 *
 * New REPORT-ONLY cost inputs (none changes a price; they feed the termite
 * line's costs block and the margin audit):
 *   link_station_costs_to_catalog  true   — kill switch for the catalog link
 *   cartridge_cost                 6.83   — Trelona Compressed Termite Bait,
 *                                           25-pack $170.75
 *   cartridges_per_station         2      — BASF FAQ PSS 26-1201
 *   cartridge_replacement_rate     0.33   — planning input until the
 *                                           /complete product ledger measures it
 *   follow_up_visit_reserve        0.25   — ASSUMED extra activity visits/yr
 *
 * Read-modify-write: an admin-tuned station cost (anything other than the
 * retired 22.05) is preserved; cost inputs are only added where absent.
 *
 * service_product_usage "Termite Bait" (Trelona ATBS Bait Station): the note
 * said 1 station per 10 LF — the engine and the label default is 15 ft
 * (owner 2026-07-28). A second BOM row records replacement cartridges
 * (2 per station × 33% = 0.67 per station per year) against the cartridge
 * catalog row, which this migration seeds with needs_pricing = true when it
 * does not exist — the owner enters the vendor price in the inventory UI,
 * and the catalog link picks it up once that price is approved.
 *
 * down() restores the audited pre-migration termite_install data only if the
 * row still carries exactly what up() wrote (an admin-tuned row survives a
 * rollback/re-apply cycle), reverts the usage notes, and removes the BOM row
 * it added. The seeded catalog product is left in place (it may have been
 * priced by hand since).
 */
const MIGRATION_TAG = 'migration:20260909000001';
const OLD_STATION_COST = 22.05;
const NEW_STATION_COST = 24.00;
const COST_INPUT_DEFAULTS = {
  link_station_costs_to_catalog: true,
  cartridge_cost: 6.83,
  cartridges_per_station: 2,
  cartridge_replacement_rate: 0.33,
  follow_up_visit_reserve: 0.25,
};
const UP_REASON = 'Trelona station cost 22.05 → 24.00 ($384/16 approved supplier box; owner 2026-09-02) + catalog link switch and report-only cartridge cost inputs (plan 2026-09-03 §A1)';
const CHANGELOG_IDENTITY = {
  version_from: 'v4.8',
  version_to: 'v4.9',
  changed_by: 'claude-2026-09-09',
  category: 'rule',
  summary: 'Termite bait station cost follows the inventory catalog ($24.00/station fallback); cartridge replacement enters the cost model.',
};

const STATION_PRODUCT = 'Trelona ATBS Bait Station';
const CARTRIDGE_PRODUCT = 'Trelona Compressed Termite Bait (25-pack)';
const USAGE_SERVICE_TYPE = 'Termite Bait';
const OLD_STATION_NOTE = 'Bait station — 1 per 10 linear ft perimeter';
const NEW_STATION_NOTE = 'Loaded station (2 cartridges included) — 1 per 15 linear ft perimeter (Trelona label default; engine spacingFt)';
const CARTRIDGE_NOTE = 'Replacement cartridges — 2 per station × 33% label-driven replacement per annual service (planning rate until the completion ledger measures it)';

function parseData(row) {
  return typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
}

function near(a, b) {
  return Number.isFinite(Number(a)) && Math.abs(Number(a) - b) < 0.005;
}

exports.up = async function up(knex) {
  if (await knex.schema.hasTable('pricing_config')) {
    const row = await knex('pricing_config').where({ config_key: 'termite_install' }).first();
    if (row) {
      const oldData = parseData(row);
      const newData = { ...oldData };
      // Both key shapes coexist in prod (short-key + long-key seeders);
      // db-bridge reads trelona_bait ?? trelona_station_cost — move the
      // retired value under BOTH, never an admin-tuned one.
      for (const key of ['trelona_bait', 'trelona_station_cost']) {
        if (key in newData && near(newData[key], OLD_STATION_COST)) newData[key] = NEW_STATION_COST;
      }
      for (const [key, value] of Object.entries(COST_INPUT_DEFAULTS)) {
        if (newData[key] == null) newData[key] = value;
      }
      const changed = JSON.stringify(newData) !== JSON.stringify(oldData);
      if (changed) {
        await knex('pricing_config')
          .where({ config_key: 'termite_install' })
          .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
        if (await knex.schema.hasTable('pricing_config_audit')) {
          await knex('pricing_config_audit').insert({
            config_key: 'termite_install',
            old_value: JSON.stringify(oldData),
            new_value: JSON.stringify(newData),
            changed_by: MIGRATION_TAG,
            reason: UP_REASON,
          });
        }
        if (await knex.schema.hasTable('pricing_changelog')) {
          const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
          if (!existing) {
            await knex('pricing_changelog').insert({
              ...CHANGELOG_IDENTITY,
              affected_services: JSON.stringify(['termite_bait', 'termite_station_rental']),
              before_value: JSON.stringify({ termite_install: oldData }),
              after_value: JSON.stringify({ termite_install: newData }),
              rationale: 'Owner-verified supplier pricing (2026-09-02): the Trelona ATBS 16-station box is $384.00 = $24.00/station, not the April $352.80 = $22.05; the catalog row already carried $24 while the engine priced off the stale literal. Station and cartridge cost now follow the inventory catalog (approved vendor price, sanity-banded, kill switch link_station_costs_to_catalog) with $24.00 as the fresh-env fallback, so the next vendor change reaches quotes without a code deploy. Install moves $610 → $653 at 15 stations; the rental uplift, which amortizes that install, moves with it. Cartridge replacement (2 per station, 33% per annual service at the 25-pack rate) and an assumed 0.25 follow-up visit reserve enter the REPORT-ONLY cost model so monitoring margin is finally computed against real consumables — no monitoring price changes in this migration.',
            });
          }
        }
      }
    }
  }

  if (!(await knex.schema.hasTable('service_product_usage')) || !(await knex.schema.hasTable('products_catalog'))) return;

  const station = await knex('products_catalog').where({ name: STATION_PRODUCT }).first('id');
  if (station) {
    await knex('service_product_usage')
      .where({ service_type: USAGE_SERVICE_TYPE, product_id: station.id, notes: OLD_STATION_NOTE })
      .update({ notes: NEW_STATION_NOTE, updated_at: knex.fn.now() });
  }

  let cartridge = await knex('products_catalog').where({ name: CARTRIDGE_PRODUCT }).first('id');
  if (!cartridge) {
    const [inserted] = await knex('products_catalog')
      .insert({
        name: CARTRIDGE_PRODUCT,
        category: 'termite bait',
        subcategory: 'Bait cartridge',
        formulation: 'bait',
        container_size: '25 cartridges',
        needs_pricing: true,
        active: true,
      })
      .returning('id');
    cartridge = { id: typeof inserted === 'object' ? inserted.id : inserted };
  }
  const existingBom = await knex('service_product_usage')
    .where({ service_type: USAGE_SERVICE_TYPE, product_id: cartridge.id })
    .first('id');
  if (!existingBom) {
    await knex('service_product_usage').insert({
      service_type: USAGE_SERVICE_TYPE,
      product_id: cartridge.id,
      usage_amount: 0.67,
      usage_unit: 'each',
      usage_per_1000sf: null,
      is_primary: false,
      notes: CARTRIDGE_NOTE,
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('pricing_config') && await knex.schema.hasTable('pricing_config_audit')) {
    const audit = await knex('pricing_config_audit')
      .where({ config_key: 'termite_install', changed_by: MIGRATION_TAG })
      .orderBy('id', 'desc')
      .first();
    const row = audit ? await knex('pricing_config').where({ config_key: 'termite_install' }).first() : null;
    if (audit && row) {
      const current = parseData(row);
      const written = typeof audit.new_value === 'string' ? JSON.parse(audit.new_value) : (audit.new_value || {});
      // Undo ONLY if the row still holds exactly what up() wrote — an
      // admin-tuned row is not ours to roll back. Key-by-key: jsonb
      // round-trips reorder keys, so a stringify equality check false-negatives.
      const untouched = Object.keys(written).length === Object.keys(current).length
        && Object.entries(written).every(([k, v]) => String(current[k]) === String(v));
      if (untouched) {
        await knex('pricing_config')
          .where({ config_key: 'termite_install' })
          .update({ data: audit.old_value, updated_at: knex.fn.now() });
        await knex('pricing_config_audit').insert({
          config_key: 'termite_install',
          old_value: audit.new_value,
          new_value: audit.old_value,
          changed_by: `${MIGRATION_TAG}:rollback`,
          reason: 'Rollback of the termite station cost basis migration',
        });
      }
    }
  }

  if (!(await knex.schema.hasTable('service_product_usage')) || !(await knex.schema.hasTable('products_catalog'))) return;
  const station = await knex('products_catalog').where({ name: STATION_PRODUCT }).first('id');
  if (station) {
    await knex('service_product_usage')
      .where({ service_type: USAGE_SERVICE_TYPE, product_id: station.id, notes: NEW_STATION_NOTE })
      .update({ notes: OLD_STATION_NOTE, updated_at: knex.fn.now() });
  }
  const cartridge = await knex('products_catalog').where({ name: CARTRIDGE_PRODUCT }).first('id');
  if (cartridge) {
    await knex('service_product_usage')
      .where({ service_type: USAGE_SERVICE_TYPE, product_id: cartridge.id, notes: CARTRIDGE_NOTE })
      .del();
  }
};
