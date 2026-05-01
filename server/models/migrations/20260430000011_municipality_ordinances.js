// PR 1.4 of the WaveGuard treatment-plan rollout.
//
// Foundation table for jurisdictional fertilizer-restriction rules.
// Future plan engine reads this to gate N/P applications during
// restricted seasons, enforce slow-release N requirements, and
// flag soil-test prerequisites for phosphorus.
//
// FL-SWFL ordinances are NOT a simple "blackout date range":
//   - Sarasota County / North Port / Manatee County / Charlotte County
//     each define different windows.
//   - Some restrict both N AND P; some only N; some condition P on a
//     soil test result.
//   - Slow-release N requirements differ outside the restricted season.
//   - North Port's window is BROADER than Sarasota County's — when a
//     city overlay sits inside a county, the stricter rule wins.
//
// This shape captures all of those independently rather than
// flattening to one boolean. The plan engine layers the city overlay
// (if any) on top of the county rule when both apply.
//
// Every row carries source_url + source_name + source_checked_at so
// any blocked treatment can be defended six months from now by
// tracing back to the actual ordinance text. Without this, "the
// system blocked us" becomes unauditable.
//
// Partial unique index on (jurisdiction_type, jurisdiction_name)
// WHERE active = true permits soft-deactivating an old rule when a
// jurisdiction amends — supports rule history without violating
// uniqueness when a new rule supersedes the old.
//
// Year-agnostic window: stored as month/day pairs so Sarasota's
// "Jun 1 – Sep 30" applies every year without yearly seed updates.
//
// Idempotent: re-running on a DB that already has the table just
// upserts the seed rows.

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('municipality_ordinances'))) {
    await knex.schema.createTable('municipality_ordinances', (t) => {
      t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

      // ── Identity ────────────────────────────────────────────────
      // jurisdiction_type lets us model both county-wide rules and
      // city overlays (city rules can be stricter than county rules,
      // and the plan engine applies BOTH layered).
      t.string('jurisdiction_name', 120).notNullable();
      t.string('jurisdiction_type', 20).notNullable(); // 'county' | 'city' | 'state' | 'office_review'
      t.string('county', 60).nullable();   // for cities, which county they sit in
      t.string('city', 80).nullable();
      t.string('state', 2).notNullable().defaultTo('FL');

      // ── Restricted-season window ───────────────────────────────
      // Year-agnostic. Both nullable to support jurisdictions with
      // no seasonal window (e.g. office-review profile).
      t.smallint('restricted_start_month').nullable();
      t.smallint('restricted_start_day').nullable();
      t.smallint('restricted_end_month').nullable();
      t.smallint('restricted_end_day').nullable();

      // ── What the season actually restricts ─────────────────────
      // Independent flags — NOT all ordinances restrict both. Some
      // only restrict N; some only P; some both.
      t.boolean('restricted_nitrogen').notNullable().defaultTo(false);
      t.boolean('restricted_phosphorus').notNullable().defaultTo(false);

      // ── Scope ──────────────────────────────────────────────────
      // Some ordinances ban N/P on turf year-round in season but
      // permit limited landscape applications (North Port wording).
      t.boolean('applies_to_turf').notNullable().defaultTo(true);
      t.boolean('applies_to_landscape').notNullable().defaultTo(false);

      // ── Conditional unlocks ────────────────────────────────────
      // "Phosphorus prohibited UNLESS soil test shows deficiency" is
      // a Manatee+Sarasota pattern. Capturing it lets the plan
      // engine flag the customer for soil testing rather than just
      // refusing to plan P.
      t.boolean('phosphorus_requires_soil_test').notNullable().defaultTo(false);

      // ── Slow-release N gate ────────────────────────────────────
      // ≥50% slow-release N is the typical FL standard outside the
      // blackout. null = no requirement.
      t.decimal('slow_release_required_pct', 5, 2).nullable();

      // ── Annual N cap ───────────────────────────────────────────
      // lb N / 1,000 sqft / year. FFL standard for warm-season turf
      // is 4 lb N / 1,000 sqft / yr. null = defer to label.
      t.decimal('annual_n_limit_per_1000', 6, 3).nullable();

      // ── Provenance ─────────────────────────────────────────────
      // The audit trail. Without this, a blocked treatment is
      // indefensible in front of the customer.
      t.string('source_url', 500).notNullable();
      t.string('source_name', 200).notNullable();
      t.date('source_checked_at').notNullable();

      // ── Ordinance lifecycle ────────────────────────────────────
      // effective_date = when the rule was enacted / last amended.
      // source_checked_at = OUR review date.
      t.date('effective_date').nullable();
      t.date('amended_date').nullable();

      // Free-form notes for nuances that don't fit a column
      // (e.g. "no application within 10 ft of any water body").
      t.text('notes').nullable();

      t.boolean('active').notNullable().defaultTo(true);
      t.timestamps(true, true);

      // A jurisdiction can have multiple rules over time (history).
      t.index(['jurisdiction_type', 'jurisdiction_name'], 'idx_munord_juris');
      t.index('county', 'idx_munord_county');
      t.index('city', 'idx_munord_city');
    });

    // Partial unique — only one ACTIVE rule per jurisdiction. Lets
    // us soft-deactivate old rules (active=false) when a new rule
    // supersedes them, without violating uniqueness.
    await knex.raw(`
      CREATE UNIQUE INDEX idx_munord_one_active_per_juris
      ON municipality_ordinances (jurisdiction_type, jurisdiction_name)
      WHERE active = true
    `);
  }

  // ── Seed: 4 SWFL jurisdictions ─────────────────────────────────
  // source_checked_at is hardcoded to the actual verification date
  // (the day the source URLs were reviewed for this commit), NOT
  // `new Date()`. Using the runtime clock would record the deploy
  // date instead — months later an audit would treat stale data as
  // freshly verified. The whole point of this column is honest
  // provenance; it should reflect when a human read the source.
  // When a future PR re-verifies, it bumps source_checked_at on the
  // affected rows.
  const SOURCES_VERIFIED_AT = '2026-04-30';

  const SEED_ROWS = [
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
      source_checked_at: SOURCES_VERIFIED_AT,
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
      source_checked_at: SOURCES_VERIFIED_AT,
      effective_date: '2014-06-09',
      notes: 'Apr 1 – Sept 30 restricted period prohibits N/P fertilizer on turf. Landscape plants may receive limited treatment under separate rules. North Port window is BROADER than the surrounding Sarasota County season — city rule wins where they overlap.',
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
      source_checked_at: SOURCES_VERIFIED_AT,
      effective_date: '2011-10-25',
      notes: 'Jun 1 – Sept 30 restricted: N/P prohibited. Year-round: phosphorus prohibited unless a soil test indicates deficiency. Slow-release N ≥ 50% outside the restricted season.',
      active: true,
    },
    {
      jurisdiction_name: 'Charlotte County',
      jurisdiction_type: 'county',
      county: 'Charlotte',
      city: null,
      state: 'FL',
      // Charlotte County has historically deferred to FFL guidance
      // without a strict county-level blackout. Rather than
      // hard-coding an aggressive window we don't have a citation
      // for, this row stays as a less-restrictive baseline + an
      // office-review note in the plan-engine policy. If/when
      // Charlotte adopts an explicit blackout, an amended row
      // supersedes via the partial unique index.
      restricted_start_month: null,
      restricted_start_day: null,
      restricted_end_month: null,
      restricted_end_day: null,
      restricted_nitrogen: false,
      restricted_phosphorus: false,
      applies_to_turf: true,
      applies_to_landscape: true,
      phosphorus_requires_soil_test: false,
      slow_release_required_pct: 50.00, // FFL guidance
      annual_n_limit_per_1000: 4.000,   // FFL guidance
      source_url: 'https://www.charlottecountyfl.gov/services/naturalresources/Pages/default.aspx',
      source_name: 'Charlotte County Natural Resources (FFL guidance)',
      source_checked_at: SOURCES_VERIFIED_AT,
      effective_date: null,
      notes: 'No verified county-level blackout window as of source_checked_at. Plan engine should require office review for N/P applications until an explicit county ordinance is confirmed and seeded as an amended row.',
      active: true,
    },
  ];

  // Per-jurisdiction idempotency. The previous all-or-nothing check
  // (count(active)>0 → return) skipped the entire seed if even one
  // jurisdiction already existed — leaving partially-seeded or
  // hand-repaired DBs with incomplete policy coverage. Now each
  // (jurisdiction_type, jurisdiction_name) is checked individually
  // against the partial unique index's space; we insert only the
  // ones missing an active row.
  for (const row of SEED_ROWS) {
    const existing = await knex('municipality_ordinances')
      .where({
        jurisdiction_type: row.jurisdiction_type,
        jurisdiction_name: row.jurisdiction_name,
        active: true,
      })
      .first();
    if (existing) continue;
    await knex('municipality_ordinances').insert(row);
  }
};

exports.down = async function (knex) {
  await knex.raw('DROP INDEX IF EXISTS idx_munord_one_active_per_juris');
  await knex.schema.dropTableIfExists('municipality_ordinances');
};
