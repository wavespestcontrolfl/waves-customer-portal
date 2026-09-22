/**
 * Discount-stacking provenance (#4405 slice 3, GitHub Codex round 1 on
 * #4642, PRRT_kwDOR3YQi86kllyE): `scheduled_services` has no `metadata`
 * column — the pricing-regime marker visit-financial-stamps.js wrote there
 * (stampPricingRegimeMarker) silently no-ops in production. Every
 * repository migration was searched; none defines a `metadata` column on
 * this table.
 *
 * `pricing_provenance` (nullable JSONB) replaces that marker with a real,
 * persisted column: `{ pricing_regime, engine_version, caps: { line,
 * addons: { [discount_id]: cap|null } } }`. The FROZEN caps snapshot (the
 * same round's OTHER P1, admin-schedule.js:1833) rides in the same column —
 * restackStoredVisitFinancials must restack a marked row from its own
 * frozen caps, never the live catalog row: a later PUT /api/admin/
 * discounts/:id cap change must not reprice a contracted recurring visit.
 *
 * Additive and reversible; no CHECK constraint, matching this table's
 * convention for its other JSON-shaped columns.
 */
const TABLE = 'scheduled_services';
const COL = 'pricing_provenance';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasColumn(TABLE, COL))) {
    await knex.schema.alterTable(TABLE, (t) => {
      t.jsonb(COL).nullable();
    });
  }
};

exports.down = async function down(knex) {
  if (await knex.schema.hasColumn(TABLE, COL)) {
    await knex.schema.alterTable(TABLE, (t) => { t.dropColumn(COL); });
  }
};
