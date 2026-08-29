/**
 * residential_unit_pricing — bedroom-band per-visit pricing for interior
 * general pest on RESIDENTIAL-UNIT scoped estimates (owner ruling
 * 2026-08-11 #3; dollar values approved by Adam 2026-08-11 "ok go";
 * PR2 of the unit-scope lane — PR1 #3369 shipped the scope model).
 *
 * A dedicated table, NOT a pricing_config key, by the ruling's own shape:
 * effective-dated rows so future band changes append rather than mutate.
 * service_code carries the ENGINE service keys verbatim ('pest',
 * 'oneTimePest') so the resolver validates exact keys — a mapping layer is
 * where skip-and-warn bugs live (lawn-seeding P0 doctrine).
 *
 * Restricted by service ON PURPOSE: ordinary interior general pest
 * recurring/one-time ONLY. German roach, bed bug, rodent, termite, flea,
 * exterior and common-area programs keep their own service-specific rules
 * and must never resolve from this table.
 *
 * Pricing rules the seed encodes (approved 2026-08-11):
 *   - Per-visit bands: studio $79 · 1BR $85 · 2BR $92 · 3BR $99 · 4+ $109.
 *   - quarterly and bi_monthly carry the SAME per-visit price; monthly is
 *     deliberately ABSENT (a monthly ask in an apartment ≈ german roach /
 *     flea — excluded programs; the resolver parks it).
 *   - initial visit price = recurring price (matches current recurring pest).
 *   - one-time standalone = the existing one-time rule applied to the band:
 *     2.2 × band with a $199 floor — seeded as explicit values because the
 *     table is DB-authoritative: 199 / 199 / 202.40 / 217.80 / 239.80.
 *   - oversize_sqft_threshold 2200: a unit KNOWN to be larger prices off
 *     the standard measured ladder / manual review, never a band.
 */

// Self-identifying tag for the audit row (must match this file's timestamp).
const MIGRATION_TAG = '20260828000010';
const BANDS = [
  ['studio', 79.0],
  ['one_bedroom', 85.0],
  ['two_bedroom', 92.0],
  ['three_bedroom', 99.0],
  ['four_plus', 109.0],
];
const ONE_TIME_FLOOR = 199.0;
const ONE_TIME_MULTIPLIER = 2.2;
const OVERSIZE_SQFT_THRESHOLD = 2200;
const EFFECTIVE_DATE = '2026-08-13';
const INCLUDED_SCOPE = 'interior_unit_general_pest';

exports.up = async function up(knex) {
  // This migration OWNS the table: create it unconditionally so `down`
  // can drop it without ever destroying a table it didn't make (a
  // hasTable-guarded create paired with an unconditional drop would).
  {
    await knex.schema.createTable('residential_unit_pricing', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      // Engine service key, verbatim ('pest' | 'oneTimePest').
      t.string('service_code', 40).notNullable();
      // 'quarterly' | 'bi_monthly' | 'one_time' — monthly deliberately absent.
      t.string('frequency', 20).notNullable();
      // 'studio' | 'one_bedroom' | 'two_bedroom' | 'three_bedroom' | 'four_plus'
      t.string('unit_band', 20).notNullable();
      t.decimal('initial_price', 8, 2).notNullable();
      t.decimal('recurring_price', 8, 2).notNullable();
      // What the price covers — the quote's explicit scope-exclusion
      // language keys off this (ruling #5: green interior-only unit quotes
      // carry explicit exclusions).
      t.string('included_scope', 60).notNullable();
      // A unit KNOWN larger than this never band-prices.
      t.integer('oversize_sqft_threshold').notNullable();
      t.date('effective_date').notNullable();
      t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      t.unique(['service_code', 'frequency', 'unit_band', 'effective_date'],
        'uq_residential_unit_pricing_key');
      t.index(['service_code', 'effective_date'], 'idx_residential_unit_pricing_lookup');
    });
  }

  // Seed is idempotent PER ROW: every band × frequency inserts against the
  // composite unique key and an existing row is left untouched, so a
  // partially seeded table (a prior aborted run, a hand-inserted band)
  // still ends up with the full 15-row set — a single pre-existing row
  // must never suppress the rest.
  {
    const rows = [];
    for (const [band, perVisit] of BANDS) {
      for (const frequency of ['quarterly', 'bi_monthly']) {
        rows.push({
          service_code: 'pest',
          frequency,
          unit_band: band,
          initial_price: perVisit,
          recurring_price: perVisit,
          included_scope: INCLUDED_SCOPE,
          oversize_sqft_threshold: OVERSIZE_SQFT_THRESHOLD,
          effective_date: EFFECTIVE_DATE,
        });
      }
      const oneTime = Math.max(ONE_TIME_FLOOR,
        Math.round(perVisit * ONE_TIME_MULTIPLIER * 100) / 100);
      rows.push({
        service_code: 'oneTimePest',
        frequency: 'one_time',
        unit_band: band,
        initial_price: oneTime,
        recurring_price: oneTime,
        included_scope: INCLUDED_SCOPE,
        oversize_sqft_threshold: OVERSIZE_SQFT_THRESHOLD,
        effective_date: EFFECTIVE_DATE,
      });
    }
    await knex('residential_unit_pricing')
      .insert(rows)
      .onConflict(['service_code', 'frequency', 'unit_band', 'effective_date'])
      .ignore();
  }

  // Audit trail, matching the pricing_config discipline: a new pricing
  // surface gets an audit row naming the authority and the derivation.
  // No catch: knex runs this migration in ONE transaction, so a failed
  // INSERT would leave the trx aborted and a swallowed error could not
  // "fail soft" — it must surface and roll the seed back with it.
  const hasAudit = await knex.schema.hasTable('pricing_config_audit');
  if (hasAudit) {
    await knex('pricing_config_audit').insert({
      config_key: 'residential_unit_pricing',
      changed_by: `migration:${MIGRATION_TAG}`,
      reason: 'Seed bedroom-band unit pricing (owner-approved 2026-08-11): '
        + 'per-visit studio 79 / 1BR 85 / 2BR 92 / 3BR 99 / 4+ 109, quarterly '
        + 'and bi_monthly same price, initial = recurring, one-time = 2.2x '
        + 'band with 199 floor (199/199/202.40/217.80/239.80), oversize '
        + 'threshold 2200 sqft. Interior general pest only.',
      old_value: JSON.stringify(null),
      new_value: JSON.stringify({
        table: 'residential_unit_pricing',
        effective_date: EFFECTIVE_DATE,
        bands: Object.fromEntries(BANDS),
        one_time_rule: { multiplier: ONE_TIME_MULTIPLIER, floor: ONE_TIME_FLOOR },
        oversize_sqft_threshold: OVERSIZE_SQFT_THRESHOLD,
      }),
    });
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTable('residential_unit_pricing');
};
