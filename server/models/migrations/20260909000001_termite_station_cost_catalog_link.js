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
 * service_product_usage "Termite Bait": every row still carrying the seeded
 * "1 per 10 linear ft" note (both the older "Trelona ATBS" product row and
 * the "Trelona ATBS Bait Station" row) is corrected to the 15-ft label default
 * (owner 2026-07-28). NO replacement-cartridge usage row is added: the usage
 * registry's consumers cost usage_amount as a fixed per-visit quantity and
 * never scale it by station count (product-costing.js, estimate-pricing-audit),
 * so a per-station cartridge rate there would understate COGS ~15x. The
 * per-station cartridge economics live in the engine's station-aware cost
 * model instead (priceTermiteBait → costs.cartridgeReplacementAnnual).
 *
 * The termite_install read-modify-write locks the row (FOR UPDATE) so the
 * admin PUT handler, which relies on migrations serializing against it,
 * cannot interleave a save between the read and the write while the previous
 * deploy still serves traffic.
 *
 * down(): restores the audited pre-migration termite_install data only if
 * the row still carries exactly what up() wrote (an admin-tuned row survives
 * a rollback/re-apply cycle). The service_product_usage note correction is a
 * DOCUMENTED NO-OP on rollback: it is admin-editable seed data, and seed
 * rollbacks are never destructive (waves-db skill).
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

const USAGE_SERVICE_TYPE = 'Termite Bait';
const OLD_STATION_NOTE = 'Bait station — 1 per 10 linear ft perimeter';
const NEW_STATION_NOTE = 'Loaded station (2 cartridges included) — 1 per 15 linear ft perimeter (Trelona label default; engine spacingFt). Replacement cartridges are costed per station by the pricing engine, not here.';

function parseData(row) {
  return typeof row.data === 'string' ? JSON.parse(row.data) : (row.data || {});
}

function near(a, b) {
  return Number.isFinite(Number(a)) && Math.abs(Number(a) - b) < 0.005;
}

async function recordTermiteInstallChange(knex, oldData, newData) {
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'termite_install',
      old_value: JSON.stringify(oldData),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_TAG,
      reason: UP_REASON,
    });
  }
  if (!(await knex.schema.hasTable('pricing_changelog'))) return;
  const existing = await knex('pricing_changelog').where(CHANGELOG_IDENTITY).first('id');
  if (existing) return;
  await knex('pricing_changelog').insert({
    ...CHANGELOG_IDENTITY,
    affected_services: JSON.stringify(['termite_bait', 'termite_station_rental']),
    before_value: JSON.stringify({ termite_install: oldData }),
    after_value: JSON.stringify({ termite_install: newData }),
    rationale: 'Owner-verified supplier pricing (2026-09-02): the Trelona ATBS 16-station box is $384.00 = $24.00/station, not the April $352.80 = $22.05; the catalog row already carried $24 while the engine priced off the stale literal. Station and cartridge cost now follow the inventory catalog (approved vendor price, sanity-banded, kill switch link_station_costs_to_catalog) with $24.00 as the fresh-env fallback, so the next vendor change reaches quotes without a code deploy. Install moves $610 → $653 at 15 stations; the rental uplift, which amortizes that install, moves with it. Cartridge replacement (2 per station, 33% per annual service at the 25-pack rate) and an assumed 0.25 follow-up visit reserve enter the REPORT-ONLY cost model so monitoring margin is finally computed against real consumables — no monitoring price changes in this migration.',
  });
}

async function applyTermiteInstallRow(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return;
  const row = await knex('pricing_config').where({ config_key: 'termite_install' }).forUpdate().first();
  if (!row) return;
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
  if (JSON.stringify(newData) === JSON.stringify(oldData)) return;
  await knex('pricing_config')
    .where({ config_key: 'termite_install' })
    .update({ data: JSON.stringify(newData), updated_at: knex.fn.now() });
  await recordTermiteInstallChange(knex, oldData, newData);
}

exports.up = async function up(knex) {
  await applyTermiteInstallRow(knex);

  if (!(await knex.schema.hasTable('service_product_usage'))) return;
  // Every legacy Termite Bait usage row, whichever Trelona product it points
  // at (codex #4313 r1 P2) — matched on the seeded note so an admin-edited
  // note is left alone.
  await knex('service_product_usage')
    .where({ service_type: USAGE_SERVICE_TYPE, notes: OLD_STATION_NOTE })
    .update({ notes: NEW_STATION_NOTE, updated_at: knex.fn.now() });
};

exports.down = async function down(knex) {
  if (await knex.schema.hasTable('pricing_config') && await knex.schema.hasTable('pricing_config_audit')) {
    const audit = await knex('pricing_config_audit')
      .where({ config_key: 'termite_install', changed_by: MIGRATION_TAG })
      .orderBy('id', 'desc')
      .first();
    const row = audit ? await knex('pricing_config').where({ config_key: 'termite_install' }).forUpdate().first() : null;
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
        // The changelog row this migration owns must not advertise a change
        // that was just undone, and a re-apply must be free to record the
        // event again (codex #4313 r5 P2).
        if (await knex.schema.hasTable('pricing_changelog')) {
          await knex('pricing_changelog').where(CHANGELOG_IDENTITY).del();
        }
      }
    }
  }

  // service_product_usage note correction: documented NO-OP (see header) —
  // admin-editable seed data is never reverted on rollback.
};
