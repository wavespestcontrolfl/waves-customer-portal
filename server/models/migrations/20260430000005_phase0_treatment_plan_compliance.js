// Phase 0 of the WaveGuard treatment-plan rollout — compliance + audit
// foundation only. No UI, no routes, no plan-engine logic. Lays the
// schema groundwork so subsequent phases (turf profile, equipment
// calibration, plan engine, MobileCompleteServiceSheet integration) can
// build on a known-correct compliance model.
//
// Three concerns in one migration:
//
// 1. products_catalog gains label/compliance fields. The plan engine
//    needs to know NPK content, slow-release N percentage, label max
//    rate + interval + annual cap, soil-test gating, RUP designation,
//    approved turf types, and a pointer back to the source label so
//    auditors can verify the values we're enforcing came from the
//    actual product label.
//
// 2. municipality_ordinances is a new table that stores the FL
//    fertilizer rules per jurisdiction. NOT a simple "blackout date
//    range" — Sarasota / North Port / Manatee differ on which
//    nutrients are restricted, whether turf vs landscape are treated
//    differently, whether soil tests can unlock phosphorus, slow-
//    release requirements, and annual N caps. Every ordinance row
//    carries source_url + source_name + source_checked_at so we can
//    audit "why is the system blocking this product?" six months from
//    now and trace it back to the actual ordinance text.
//
// 3. service_products gains plan-vs-actual fields (planned_amount +
//    treatment_plan_item_id). Lets us measure variance for audits,
//    callbacks, product efficacy, and tech coaching once the plan
//    engine lands. The FK on treatment_plan_item_id is deferred to a
//    later migration when treatment_plan_items exists — for now it's
//    a plain uuid column.
//
// Seed data: three jurisdictions (Sarasota County, North Port,
// Manatee County). Sources cited inline in the seed block so anyone
// can re-verify the rule. Effective dates set per published ordinance;
// source_checked_at = today's migration date so we know how fresh
// each rule was when seeded.

exports.up = async (knex) => {
  // ── 1. products_catalog: label/compliance extension ────────────────────
  await knex.schema.alterTable('products_catalog', (t) => {
    // NPK percentages (whole numbers; e.g. a 16-4-8 product = 16/4/8).
    // Numeric so a 2.5%-N micronutrient blend can be expressed too.
    t.decimal('nitrogen_pct', 5, 2).nullable();
    t.decimal('phosphorus_pct', 5, 2).nullable();
    t.decimal('potassium_pct', 5, 2).nullable();
    // FL urban-fertilizer rules require ≥50% slow-release N during the
    // restricted season for products that can be applied. This stores
    // the % of the total N that is slow-release / controlled-release.
    t.decimal('slow_release_n_pct', 5, 2).nullable();

    // Label-derived application caps. The plan engine refuses to plan
    // anything that would exceed these.
    t.decimal('label_max_rate', 10, 4).nullable();
    t.string('label_max_rate_unit', 30).nullable();
    t.integer('label_min_interval_days').nullable();
    t.decimal('label_annual_max_per_1000', 10, 4).nullable();
    t.string('label_annual_max_unit', 30).nullable();

    // Compliance flags.
    t.boolean('requires_soil_test').notNullable().defaultTo(false);
    t.boolean('restricted_use_pesticide').notNullable().defaultTo(false);

    // Approved turf types — JSON array of grass species the label
    // permits ("st_augustine" / "bahia" / "zoysia" / "bermuda" / etc.).
    // Empty/null means "no turf restriction" (e.g. soil drench).
    t.jsonb('approved_for_turf_types').nullable();

    // Resistance-management group codes — strings because they're
    // alphanumeric ("3A" / "M3" / "11"). Used by the plan engine to
    // enforce rotation in monthly protocols.
    t.string('frac_group', 10).nullable();
    t.string('irac_group', 10).nullable();

    // Source-label provenance so future auditors can verify the
    // numbers we encoded came from the actual current label.
    t.string('product_label_url', 500).nullable();
    t.date('label_revision_date').nullable();
    t.timestamp('label_checked_at', { useTz: true }).nullable();
  });

  // ── 2. municipality_ordinances ──────────────────────────────────────────
  await knex.schema.createTable('municipality_ordinances', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Identity. jurisdiction_type lets us model both county-wide rules
    // and city overlays (city rules can be stricter than county rules,
    // and the plan engine will need to apply BOTH layered).
    t.string('jurisdiction_name', 120).notNullable();
    t.string('jurisdiction_type', 20).notNullable(); // 'county' | 'city' | 'state'
    t.string('county', 60).nullable();   // for cities, which county they sit in
    t.string('city', 80).nullable();
    t.string('state', 2).notNullable().defaultTo('FL');

    // Restricted-season window. Stored as month/day pairs so the rule
    // is year-agnostic — Sarasota's "June 1 – Sept 30" applies every
    // year without needing yearly seed updates.
    t.smallint('restricted_start_month').nullable();
    t.smallint('restricted_start_day').nullable();
    t.smallint('restricted_end_month').nullable();
    t.smallint('restricted_end_day').nullable();

    // What the season actually restricts. NOT all ordinances restrict
    // both N and P; some only restrict N. Boolean flags let the plan
    // engine reason about each nutrient independently.
    t.boolean('restricted_nitrogen').notNullable().defaultTo(false);
    t.boolean('restricted_phosphorus').notNullable().defaultTo(false);

    // Scope: turf vs landscape beds. Some ordinances ban N/P on turf
    // year-round in season but permit limited landscape applications
    // (North Port's wording, for example).
    t.boolean('applies_to_turf').notNullable().defaultTo(true);
    t.boolean('applies_to_landscape').notNullable().defaultTo(false);

    // Conditional unlocks. "Phosphorus prohibited UNLESS a soil test
    // shows deficiency" is a Manatee+Sarasota pattern. Capturing the
    // unlock so the plan engine can flag a customer for soil testing
    // instead of just refusing to plan P.
    t.boolean('phosphorus_requires_soil_test').notNullable().defaultTo(false);

    // Slow-release N gate (≥50% slow-release N is the typical FL
    // standard outside the blackout). null = no requirement.
    t.decimal('slow_release_required_pct', 5, 2).nullable();

    // Annual nitrogen cap (lb N per 1,000 sqft per year). Per the
    // Florida-Friendly Landscaping rule of 4 lb N / 1,000 sqft / year
    // for warm-season turf. Some jurisdictions adopt different caps;
    // null defers to label.
    t.decimal('annual_n_limit_per_1000', 6, 3).nullable();

    // Provenance — the audit trail. Without this we can't defend a
    // blocked treatment in front of the customer.
    t.string('source_url', 500).notNullable();
    t.string('source_name', 200).notNullable();
    t.date('source_checked_at').notNullable();

    // Ordinance effective dates (when the rule was enacted / last
    // amended). source_checked_at is OUR review date.
    t.date('effective_date').nullable();
    t.date('amended_date').nullable();

    // Free-form notes for nuances that don't fit a column (e.g. "no
    // application within 10 ft of any water body").
    t.text('notes').nullable();

    t.boolean('active').notNullable().defaultTo(true);
    t.timestamps(true, true);

    // A jurisdiction can have multiple rules over time (history) but
    // only one active rule at a time per (jurisdiction_name + jurisdiction_type).
    t.index(['jurisdiction_type', 'jurisdiction_name'], 'idx_munord_juris');
    t.index('county', 'idx_munord_county');
    t.index('city', 'idx_munord_city');
  });

  // Partial unique index — only one ACTIVE rule per jurisdiction. Lets
  // us soft-deactivate old rules (active=false) without violating
  // uniqueness when a new rule supersedes them.
  await knex.raw(`
    CREATE UNIQUE INDEX idx_munord_one_active_per_juris
    ON municipality_ordinances (jurisdiction_type, jurisdiction_name)
    WHERE active = true
  `);

  // ── 3. service_products: plan-vs-actual ─────────────────────────────────
  await knex.schema.alterTable('service_products', (t) => {
    // Planned amount (from treatment_plan_items). NULL when the row
    // was applied without a plan (legacy completion path).
    t.decimal('planned_amount', 10, 4).nullable();
    t.string('planned_unit', 30).nullable();

    // FK target lives in a future migration (treatment_plan_items).
    // Storing the uuid now lets the plan engine wire this column
    // immediately when the items table lands without a backfill
    // dance. No FK constraint until then — treated as opaque.
    t.uuid('treatment_plan_item_id').nullable();
    t.index('treatment_plan_item_id', 'idx_service_products_plan_item');

    // Tech-supplied reason when the actual diverges materially from
    // plan (skipped, increased, substituted, unplanned addition).
    // Free-form for now; plan-engine phase will add an enum option set.
    t.text('variance_reason').nullable();
  });

  // ── Seed: FL fertilizer ordinances (Sarasota / North Port / Manatee) ───
  // Source URLs and effective dates are best-effort current-as-of the
  // migration date. They WILL drift; that's why source_checked_at is
  // mandatory and the columns are designed for re-verification.
  const today = new Date().toISOString().slice(0, 10);
  await knex('municipality_ordinances').insert([
    {
      jurisdiction_name: 'Sarasota County',
      jurisdiction_type: 'county',
      county: 'Sarasota',
      city: null,
      state: 'FL',
      restricted_start_month: 6,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
      restricted_nitrogen: true,
      restricted_phosphorus: true,
      applies_to_turf: true,
      applies_to_landscape: true,
      phosphorus_requires_soil_test: true,
      slow_release_required_pct: 50.00,
      annual_n_limit_per_1000: 4.000,
      source_url: 'https://www.scgov.net/government/utilities/water-quality/fertilizer-ordinance',
      source_name: 'Sarasota County Fertilizer Ordinance',
      source_checked_at: today,
      effective_date: '2007-04-01',
      notes: 'Restricted season prohibits any fertilizer containing nitrogen or phosphorus. Outside the season, slow-release N ≥ 50% required, no application within 10 ft of any water body.',
      active: true,
    },
    {
      jurisdiction_name: 'North Port',
      jurisdiction_type: 'city',
      county: 'Sarasota',
      city: 'North Port',
      state: 'FL',
      restricted_start_month: 4,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
      restricted_nitrogen: true,
      restricted_phosphorus: true,
      applies_to_turf: true,
      applies_to_landscape: false,
      phosphorus_requires_soil_test: true,
      slow_release_required_pct: 50.00,
      annual_n_limit_per_1000: 4.000,
      source_url: 'https://www.cityofnorthport.com/government/departments/public-works/stormwater/fertilizer-ordinance',
      source_name: 'City of North Port Fertilizer Ordinance',
      source_checked_at: today,
      effective_date: '2014-06-09',
      notes: 'Apr 1 – Sept 30 restricted period prohibits N/P fertilizer on turf. Landscape plants may receive limited treatment under separate rules. North Port restricted period is BROADER than the surrounding county season — city rule wins where it overlaps.',
      active: true,
    },
    {
      jurisdiction_name: 'Manatee County',
      jurisdiction_type: 'county',
      county: 'Manatee',
      city: null,
      state: 'FL',
      restricted_start_month: 6,
      restricted_start_day: 1,
      restricted_end_month: 9,
      restricted_end_day: 30,
      restricted_nitrogen: true,
      restricted_phosphorus: true,
      applies_to_turf: true,
      applies_to_landscape: true,
      phosphorus_requires_soil_test: true,
      slow_release_required_pct: 50.00,
      annual_n_limit_per_1000: 4.000,
      source_url: 'https://www.mymanatee.org/departments/natural_resources/water_quality/fertilizer_ordinance',
      source_name: 'Manatee County Fertilizer Ordinance',
      source_checked_at: today,
      effective_date: '2011-10-25',
      notes: 'Jun 1 – Sept 30 restricted: N/P prohibited. Year-round: phosphorus prohibited unless a soil test indicates deficiency. Slow-release N ≥ 50% outside the restricted season.',
      active: true,
    },
  ]);
};

exports.down = async (knex) => {
  // service_products
  await knex.schema.alterTable('service_products', (t) => {
    t.dropColumn('planned_amount');
    t.dropColumn('planned_unit');
    t.dropColumn('treatment_plan_item_id');
    t.dropColumn('variance_reason');
  });

  // municipality_ordinances
  await knex.raw('DROP INDEX IF EXISTS idx_munord_one_active_per_juris');
  await knex.schema.dropTableIfExists('municipality_ordinances');

  // products_catalog
  await knex.schema.alterTable('products_catalog', (t) => {
    t.dropColumn('nitrogen_pct');
    t.dropColumn('phosphorus_pct');
    t.dropColumn('potassium_pct');
    t.dropColumn('slow_release_n_pct');
    t.dropColumn('label_max_rate');
    t.dropColumn('label_max_rate_unit');
    t.dropColumn('label_min_interval_days');
    t.dropColumn('label_annual_max_per_1000');
    t.dropColumn('label_annual_max_unit');
    t.dropColumn('requires_soil_test');
    t.dropColumn('restricted_use_pesticide');
    t.dropColumn('approved_for_turf_types');
    t.dropColumn('frac_group');
    t.dropColumn('irac_group');
    t.dropColumn('product_label_url');
    t.dropColumn('label_revision_date');
    t.dropColumn('label_checked_at');
  });
};
