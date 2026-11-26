/**
 * leads.previous_company / switch_reason / not_booked_reason / why_filled_at —
 * "record why on every lead" (owner ruling 2026-11-25, option A).
 *
 * previous_company is the rival the caller is LEAVING (e.g. a prior pest
 * provider). It is NOT leads.lost_to_competitor (20260401000095), which names
 * the rival that WON a lost lead — the opposite direction — so it gets its own
 * column. All three "why" fields are plain nullable strings: the nightly
 * lead-why-fill job writes values from fixed lists (services/lead-why-fill.js),
 * the office can overwrite any of them, and the job never overwrites a value
 * that is already set. why_filled_at stamps the last time the job wrote a field.
 *
 * Idempotent (hasTable + hasColumn); no backfill — the job fills history.
 */
const COLUMNS = {
  previous_company: (t) => t.string('previous_company', 60).nullable(),
  switch_reason: (t) => t.string('switch_reason', 40).nullable(),
  not_booked_reason: (t) => t.string('not_booked_reason', 40).nullable(),
  why_filled_at: (t) => t.timestamp('why_filled_at').nullable(),
};

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('leads'))) return;
  for (const [name, add] of Object.entries(COLUMNS)) {
    if (!(await knex.schema.hasColumn('leads', name))) {
      await knex.schema.alterTable('leads', (t) => { add(t); });
    }
  }
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('leads'))) return;
  for (const name of Object.keys(COLUMNS)) {
    if (await knex.schema.hasColumn('leads', name)) {
      await knex.schema.alterTable('leads', (t) => { t.dropColumn(name); });
    }
  }
};
