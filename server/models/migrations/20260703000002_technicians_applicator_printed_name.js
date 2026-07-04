/**
 * technicians.applicator_printed_name (owner request 2026-07-03).
 *
 * Compliance certificates print the licensed applicator's FULL legal name,
 * but technicians.name is the casual display name used across customer
 * comms ("your technician Adam") — renaming it would reformalize every
 * surface. This dedicated column feeds only the applicator picker
 * (GET /api/admin/projects/applicators), falling back to name when unset.
 *
 * Seeds the sole active tech ("Adam" → "Adam Benetti", owner-stated legal
 * name); other environments loud-skip the seed.
 */

exports.up = async function up(knex) {
  const hasCol = await knex.schema.hasColumn('technicians', 'applicator_printed_name');
  if (!hasCol) {
    await knex.schema.alterTable('technicians', (t) => {
      t.string('applicator_printed_name').nullable();
    });
  }

  const seeded = await knex('technicians')
    .where({ name: 'Adam', active: true })
    .whereNull('applicator_printed_name')
    .update({ applicator_printed_name: 'Adam Benetti', updated_at: knex.fn.now() });
  if (!seeded) {
    console.log('[migration] no active "Adam" technician row without a printed name — seed skipped');
  }
};

exports.down = async function down(knex) {
  const hasCol = await knex.schema.hasColumn('technicians', 'applicator_printed_name');
  if (hasCol) {
    await knex.schema.alterTable('technicians', (t) => {
      t.dropColumn('applicator_printed_name');
    });
  }
};
