/**
 * customer_properties.occupancy_type gains 'family_occupied'.
 *
 * Owner ruling 2026-09-08: a home the customer owns or pays for that a
 * FAMILY MEMBER lives in is neither owner-occupied nor a rental, and the
 * office records that as the property's occupancy (not only as the
 * relationship `family_home`).
 *
 * 20260629000001 created the column with knex `t.enu(...)`, which on
 * Postgres is a CHECK constraint (`customer_properties_occupancy_type_check`,
 * verified against prod 2026-09-08: six values, column type text). The
 * service vocabulary (customer-properties.js OCCUPANCY_TYPES) and the admin
 * UI now offer the seventh value, so the CHECK must be widened or every
 * POST/PATCH carrying it fails at the database (pre-push codex P1).
 *
 * The value list is a frozen snapshot on purpose — a migration must mean the
 * same thing in every environment it runs in, so it does not import the
 * live OCCUPANCY_TYPES; the unit test pins the two together at PR time.
 *
 * DROP + ADD run in ONE ALTER TABLE statement, so no window exists where the
 * column is unconstrained. Idempotent: re-running up() re-installs the same
 * constraint.
 *
 * down() deliberately REFUSES while any row carries 'family_occupied': a
 * rollback must never coerce office-recorded occupancy to shrink a CHECK
 * (same doctrine as 20260907000021). Re-point those rows first, then roll
 * back.
 */
const TABLE = 'customer_properties';
const CONSTRAINT = 'customer_properties_occupancy_type_check';
const ORIGINAL = ['owner_occupied', 'rental_investment', 'commercial', 'seasonal', 'vacant', 'unknown'];
const WIDENED = ['owner_occupied', 'family_occupied', 'rental_investment', 'commercial', 'seasonal', 'vacant', 'unknown'];

function replaceConstraint(knex, values) {
  const list = values.map((v) => `'${v}'`).join(', ');
  return knex.raw(
    `ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}, `
    + `ADD CONSTRAINT ${CONSTRAINT} CHECK (occupancy_type IN (${list}))`,
  );
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  await replaceConstraint(knex, WIDENED);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable(TABLE))) return;
  const held = await knex(TABLE).where({ occupancy_type: 'family_occupied' }).first('id');
  if (held) {
    throw new Error(`${TABLE} rows carry occupancy_type 'family_occupied'; re-point them before narrowing the CHECK`);
  }
  await replaceConstraint(knex, ORIGINAL);
};

exports.ORIGINAL_OCCUPANCY_TYPES = ORIGINAL;
exports.WIDENED_OCCUPANCY_TYPES = WIDENED;
