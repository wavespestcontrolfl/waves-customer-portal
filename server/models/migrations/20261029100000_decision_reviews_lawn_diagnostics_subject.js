/**
 * decision_reviews takes a further subject type, 'lawn_diagnostics' (uuid ids,
 * like the others): the lawn diagnosis whose model-written customer summary a
 * lawn_result_timing.v1 answer judged
 * (services/service-report/lawn-jev-timing-check.js). Expand only: the server
 * this deploy replaces keeps writing the types it knows.
 *
 * The subject_type CHECK is rebuilt from the values it holds NOW plus the new
 * one, never from a fixed list, so this file and any other migration adding a
 * subject type the same way can run in either order without dropping the
 * other's value.
 *
 * down removes only this value and refuses (naming the table) while a row
 * uses it: dropping review evidence is never a rollback's silent side effect.
 */
const TABLE = 'decision_reviews';
const CHECK = 'decision_reviews_subject_type_check';
const VALUE = 'lawn_diagnostics';
const BASE = ['call_log', 'sms_log'];

// The quoted values in the live CHECK; the table's original two when the
// constraint is missing.
async function currentValues(knex) {
  const { rows } = await knex.raw(
    `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c WHERE c.conname = ? AND c.conrelid = ?::regclass`,
    [CHECK, TABLE],
  );
  const found = rows.length ? [...rows[0].def.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : [];
  return found.length ? [...new Set(found)] : [...BASE];
}

async function replaceCheck(knex, values) {
  const list = values.map((v) => `'${v}'`).join(',');
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CHECK}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CHECK} CHECK (subject_type IN (${list}))`);
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const values = await currentValues(knex);
  if (values.includes(VALUE)) return;
  await replaceCheck(knex, [...values, VALUE]);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await knex.raw(`LOCK TABLE ${TABLE} IN ACCESS EXCLUSIVE MODE`);
  const used = await knex(TABLE).where({ subject_type: VALUE }).first('id');
  if (used) throw new Error(`${TABLE} holds ${VALUE} rows: export or delete them before rolling this migration back`);
  const values = (await currentValues(knex)).filter((v) => v !== VALUE);
  await replaceCheck(knex, values.length ? values : BASE);
};
