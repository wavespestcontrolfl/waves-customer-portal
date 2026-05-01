// PR 1.3 of the WaveGuard treatment-plan rollout.
//
// Extends products_catalog with the label/rate/compliance metadata
// the WaveGuard plan engine and mix calculator will read in PR 2.x.
// Purely additive — no existing column is touched. Audit before this
// migration showed 38 columns already present (active, name, category,
// active_ingredient, moa_group, default_rate as varchar, default_unit,
// sku, formulation, rei_hours, signal_word, restricted_use, etc.), so
// only fields that don't already exist are added here.
//
// Three categories of new columns:
//
// 1. Fertilizer analysis + slow-release. analysis_n/p/k expressed as
//    whole-number percentages (16-4-8 → 16/4/8). slow_release_n_pct
//    is the % of the total N that is slow-release / controlled-
//    release — FL urban-fertilizer rules require ≥50% slow-release N
//    during the restricted season for products that can be applied.
//
// 2. Resistance-management group codes. moa_group already exists as
//    a generic string; the plan engine's rotation logic needs the
//    specific FRAC / IRAC / HRAC group(s) per product. Strings
//    (alphanumeric — "3A" / "M3" / "11"), nullable for products that
//    don't carry a code (fertilizer, bare-ground products).
//
// 3. Numeric rate columns. The legacy default_rate and
//    maximum_annual_rate are varchar — fine for display, useless for
//    math. New columns store decimals so the mix calculator can
//    multiply rate × treated_units without parsing strings. rate_unit
//    pins the canonical unit ('fl_oz' / 'lb' / 'oz' / 'gal'); the
//    legacy default_unit varchar stays in place for back-compat.
//
// 4. Reentry / rainfast / irrigation lifecycle. rei_hours already
//    exists as integer; reentry_text holds the label's verbatim
//    reentry sentence (often more nuanced than just hours).
//    rainfast_minutes is in minutes because most labels quote
//    fractional hours (e.g. "30 minutes"); legacy rain_free_hours
//    stays for back-compat.
//
// 5. Turf species + tank-mix incompatibility. JSONB so a label with
//    multiple species can be stored as an array; do_not_tank_mix_with
//    can hold structured product references.
//
// 6. Audit trail (label_verified_at/by/source_note). The plan engine
//    will refuse to plan against unverified label values; capturing
//    when/who/why we trust each row is the only way that policy can
//    be defensibly enforced six months from now when an auditor
//    asks "where did 0.46 fl oz / 1,000 sq ft come from?".
//
// CHECK constraint pins mixing_order_category to the APPLES tank-
// order taxonomy so a typo can't silently break the mix calculator.

const NEW_COLUMNS = [
  // [knex method, name, optional config (length / precision)]
  // ── 1. Fertilizer analysis ───────────────────────────────────
  ['decimal',  'analysis_n',                [5, 2]],
  ['decimal',  'analysis_p',                [5, 2]],
  ['decimal',  'analysis_k',                [5, 2]],
  ['decimal',  'slow_release_n_pct',        [5, 2]],

  // ── 2. EPA + resistance-management codes ─────────────────────
  ['string',   'epa_reg_number',            [40]],
  ['string',   'frac_group',                [10]],
  ['string',   'irac_group',                [10]],
  ['string',   'hrac_group',                [10]],
  ['string',   'hrac_group_secondary',      [10]],

  // ── 3. Mix-order taxonomy + numeric rates ────────────────────
  ['string',   'mixing_order_category',     [40]],
  ['decimal',  'default_rate_per_1000',     [10, 4]],
  ['decimal',  'min_label_rate_per_1000',   [10, 4]],
  ['decimal',  'max_label_rate_per_1000',   [10, 4]],
  ['decimal',  'max_annual_per_1000',       [10, 4]],
  ['string',   'rate_unit',                 [20]],

  // ── 4. Reentry / rainfast / irrigation ───────────────────────
  ['text',     'reentry_text'],
  ['integer',  'rainfast_minutes'],
  ['boolean',  'irrigation_required'],

  // ── 5. Turf species + tank-mix incompatibility ───────────────
  ['jsonb',    'labeled_turf_species'],
  ['jsonb',    'excluded_turf_species'],
  ['boolean',  'requires_surfactant'],
  ['boolean',  'allows_surfactant'],
  ['jsonb',    'do_not_tank_mix_with'],
  ['jsonb',    'rate_notes'],

  // ── 6. Sourcing + provenance ─────────────────────────────────
  ['string',   'label_url',                 [500]],
  ['string',   'sds_url',                   [500]],
  ['string',   'siteone_sku',               [50]],
  ['timestamp', 'label_verified_at',        [{ useTz: true }]],
  ['string',   'label_verified_by',         [200]],
  ['text',     'label_source_note'],
];

const MIX_ORDER_CATEGORIES = [
  'water_conditioner',
  'dry_wg_wdg_wp_df',
  'liquid_flowable_sc',
  'ec_ew',
  'solution_sl',
  'liquid_fertilizer',
  'adjuvant_last',
];

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  for (const [method, name, args] of NEW_COLUMNS) {
    if (await knex.schema.hasColumn('products_catalog', name)) continue;
    await knex.schema.alterTable('products_catalog', (t) => {
      if (args && args.length === 1 && typeof args[0] === 'object') {
        // timestamp with { useTz } options
        t[method](name, args[0]);
      } else if (args && args.length) {
        t[method](name, ...args);
      } else {
        t[method](name);
      }
    });
  }

  // Pin mixing_order_category to the closed APPLES taxonomy. Lets a
  // typo in a seed or admin upsert fail loudly instead of silently
  // breaking the future mix calculator.
  await knex.raw(`
    ALTER TABLE products_catalog
    ADD CONSTRAINT products_catalog_mixing_order_category_check
    CHECK (
      mixing_order_category IS NULL
      OR mixing_order_category IN (${MIX_ORDER_CATEGORIES.map((s) => `'${s}'`).join(', ')})
    )
  `);
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('products_catalog'))) return;

  await knex.raw(`
    ALTER TABLE products_catalog
    DROP CONSTRAINT IF EXISTS products_catalog_mixing_order_category_check
  `);

  // Drop in reverse so any column with downstream dependencies (none
  // for now, but defensive) drops cleanly.
  for (const [, name] of [...NEW_COLUMNS].reverse()) {
    if (await knex.schema.hasColumn('products_catalog', name)) {
      await knex.schema.alterTable('products_catalog', (t) => {
        t.dropColumn(name);
      });
    }
  }
};
