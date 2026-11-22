'use strict';

/**
 * Rodent EXCLUSION becomes its own capability category and service line (owner
 * 2026-11-21: the second technician takes all pest work, rodent trapping included;
 * the owner keeps rodent exclusion). Until now sealing and trapping shared the one
 * 'rodent' value, so they could only go to the same technician.
 *
 *  1. technician_capabilities.service_category and service_line_techs.service_category
 *     accept 'exclusion'.
 *  2. Every technician's 'rodent' capability row is copied to an 'exclusion' row with
 *     the same level, the same On / Off state and the same verifier: exclusion was part
 *     of 'rodent' until today, so nobody gains or loses a job type by this migration.
 *     A technician with no rodent row gets no exclusion row (it reads 'unset', which
 *     blocks nothing, exactly like the rodent row it has not got).
 *  3. service_line_techs gets no row: an unset line adds no rule
 *     (services/scheduling/line-technician.js).
 *
 * Vocabularies are inlined on purpose: a migration must not change meaning when
 * application code changes later. Idempotent.
 */
const BEFORE = ['general', 'mosquito', 'lawn', 'rodent', 'termite'];
const AFTER = ['general', 'mosquito', 'lawn', 'rodent', 'exclusion', 'termite'];
const CAPABILITY_CHECK = 'technician_capabilities_category_check';
const LINE_CHECK = 'service_line_techs_category_check';
const COPY_NOTE = 'Copied from the rodent row: exclusion was part of the rodent category until 2026-11-21.';

const quoted = (list) => list.map((v) => `'${v}'`).join(', ');

/** Replace `check` on `table` with one that allows `values`; skipped (and logged) while a row holds another value. */
async function setCategoryCheck(knex, table, check, values) {
  if (!(await knex.schema.hasTable(table))) return;
  const [{ count }] = await knex(table).whereNotIn('service_category', values).count({ count: '*' });
  if (Number(count) > 0) {
    console.log(`[migrate:exclusion_service_line] ${count} ${table} row(s) carry a service_category outside ${values.join('/')}; ${check} left as it is`);
    return;
  }
  await knex.raw(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${check}`);
  await knex.raw(`ALTER TABLE ${table} ADD CONSTRAINT ${check} CHECK (service_category IN (${quoted(values)}))`);
}

exports.up = async function up(knex) {
  await setCategoryCheck(knex, 'technician_capabilities', CAPABILITY_CHECK, AFTER);
  await setCategoryCheck(knex, 'service_line_techs', LINE_CHECK, AFTER);

  if (!(await knex.schema.hasTable('technician_capabilities'))) return;
  await knex.raw(`
    INSERT INTO technician_capabilities
      (technician_id, service_category, capability_level, source, notes, active, verified_by, verified_at, updated_at)
    SELECT technician_id, 'exclusion', capability_level, source, ?, active, verified_by, verified_at, now()
      FROM technician_capabilities
     WHERE service_category = 'rodent'
    ON CONFLICT (technician_id, service_category) DO NOTHING
  `, [COPY_NOTE]);
};

exports.down = async function down(knex) {
  for (const table of ['technician_capabilities', 'service_line_techs']) {
    if (await knex.schema.hasTable(table)) await knex(table).where({ service_category: 'exclusion' }).del();
  }
  await setCategoryCheck(knex, 'technician_capabilities', CAPABILITY_CHECK, BEFORE);
  await setCategoryCheck(knex, 'service_line_techs', LINE_CHECK, BEFORE);
};
