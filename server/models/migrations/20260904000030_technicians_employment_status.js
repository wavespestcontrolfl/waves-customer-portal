/**
 * Employment status + field eligibility on the technicians table.
 *
 * Three questions the single `active` flag used to answer at once are now
 * distinct (Field Team Program, Phase 0 item 1):
 *   - can this person sign in?            → employment_status = 'active'
 *   - can they receive a field assignment? → employment_status = 'active'
 *                                             AND field_dispatchable = true
 *   - can they be paid?                    → an obligation; rows are never
 *                                             deleted, so history survives.
 *
 * `prospective` is a placeholder for a hire that has not started (Tech #1,
 * #2, #3): no login, no slots, no capacity, never on a customer surface.
 *
 * Backfill is a behavioral no-op: every existing row keeps its current
 * access (active → 'active', else 'inactive'; nobody becomes prospective)
 * and field_dispatchable is true ONLY for rows that already hold at least
 * one scheduled_services assignment — an office-only admin or a UI-verify
 * account never held one and stays out of the dispatch pool. The resulting
 * mapping is logged so the deploy log shows exactly who ended up where.
 *
 * `active` stays as the compatibility column; technician-eligibility.js
 * (employmentPatch) is the one place that writes the pair together.
 */
const STATUSES = ['prospective', 'active', 'inactive'];

exports.up = async function (knex) {
  if (!(await knex.schema.hasColumn('technicians', 'employment_status'))) {
    await knex.schema.alterTable('technicians', (t) => {
      t.string('employment_status', 20).notNullable().defaultTo('active');
    });
    await knex.raw(`
      ALTER TABLE technicians
      ADD CONSTRAINT technicians_employment_status_check
      CHECK (employment_status IN (${STATUSES.map((s) => `'${s}'`).join(', ')}))
    `);
    // Legacy `active` is nullable: NULL was never accepted by login, so it
    // maps to inactive too (active=true → active, else inactive).
    await knex('technicians')
      .where(function () { this.where({ active: false }).orWhereNull('active'); })
      .update({ employment_status: 'inactive' });
  }
  if (!(await knex.schema.hasColumn('technicians', 'field_dispatchable'))) {
    await knex.schema.alterTable('technicians', (t) => {
      t.boolean('field_dispatchable').notNullable().defaultTo(false);
    });
    await knex.raw(`
      UPDATE technicians t
      SET field_dispatchable = TRUE
      WHERE EXISTS (SELECT 1 FROM scheduled_services s WHERE s.technician_id = t.id)
    `);
  }

  const rows = await knex('technicians')
    .select('id', 'name', 'role', 'employment_status', 'field_dispatchable')
    .orderBy('name');
  for (const r of rows) {
    // Names are staff, not customer PII; the deploy log is the audit trail
    // the PR body's expected mapping is checked against.
    console.log(`[migrate:technicians_employment_status] ${r.name} (${r.role}) → ${r.employment_status}, field_dispatchable=${r.field_dispatchable}`);
  }
};

exports.down = async function (knex) {
  if (await knex.schema.hasColumn('technicians', 'field_dispatchable')) {
    await knex.schema.alterTable('technicians', (t) => t.dropColumn('field_dispatchable'));
  }
  if (await knex.schema.hasColumn('technicians', 'employment_status')) {
    await knex.raw('ALTER TABLE technicians DROP CONSTRAINT IF EXISTS technicians_employment_status_check');
    await knex.schema.alterTable('technicians', (t) => t.dropColumn('employment_status'));
  }
};
