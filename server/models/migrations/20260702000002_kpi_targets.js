// Editable KPI-target store — replaces the hardcoded red/green thresholds in
// the dashboard tile JSX (DashboardPageV2 sections) with owner-editable rows.
//
// `metric` is the PK and matches the stable SNAPSHOT_METRICS keys in
// services/kpi-snapshot.js (the same keys kpi_snapshots.metric uses), so a
// target, its tile, and its sparkline series all join on one key.
//
// `amber_band_pct` widens the miss into a warn zone: a value on the wrong
// side of `target` but within this percentage of it renders amber, beyond it
// red. `lower_is_better` flips the comparison (callback rate, AR days,
// response speed).
//
// Seeds mirror the tile thresholds that were hardcoded on the dashboard the
// day this shipped — the client keeps the same values as its fallback, so an
// empty/unfetched store changes nothing. Metrics without a seeded row
// (utilization, stops/hr, revenue/job, autopay %, net customers, net MRR)
// simply have no target until the owner sets one.

const SEED_TARGETS = [
  // [metric, target, lower_is_better, amber_band_pct]
  ['completion_rate', 85, false, 10],
  ['callback_rate', 6, true, 10],
  ['lead_conversion', 20, false, 10],
  ['response_speed_min', 60, true, 10],
  ['gross_margin', 40, false, 10],
  // The old tile went red only below $90 against a $120 target — a deliberate
  // two-threshold design, translated as a 25% amber band.
  ['revenue_per_man_hour', 120, false, 25],
  ['retention_pct', 85, false, 10],
  ['csat_avg', 8, false, 10],
  ['collection_rate', 70, false, 10],
  ['ar_days', 30, true, 10],
];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('kpi_targets'))) {
    await knex.schema.createTable('kpi_targets', (t) => {
      t.string('metric', 64).primary();            // SNAPSHOT_METRICS key
      t.decimal('target', 14, 4).notNullable();
      t.decimal('amber_band_pct', 6, 2).notNullable().defaultTo(10);
      t.boolean('lower_is_better').notNullable().defaultTo(false);
      t.string('updated_by', 120);                 // admin display name/email
      t.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  for (const [metric, target, lowerIsBetter, amberBandPct] of SEED_TARGETS) {
    await knex('kpi_targets')
      .insert({ metric, target, lower_is_better: lowerIsBetter, amber_band_pct: amberBandPct })
      .onConflict('metric')
      .ignore(); // never clobber an owner-edited row on re-run
  }
};

exports.down = async function down(knex) {
  await knex.schema.dropTableIfExists('kpi_targets');
};
