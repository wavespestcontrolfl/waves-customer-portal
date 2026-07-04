/**
 * Seed Adam's FL applicator ID-card number (owner-provided 2026-07-03:
 * JE362022 — the individual FDACS ID card, distinct from the business
 * license that prints in the certificate header).
 *
 * The certificate applicator picker (GET /api/admin/projects/applicators)
 * auto-fills applicator_fdacs_id from technicians.fl_applicator_license;
 * the column was empty, so every certificate's ID number was hand-typed.
 * No license_expiry is set (none provided) — the picker treats a missing
 * expiry as active, and the owner can add the expiry date on the tech
 * profile so expired numbers get withheld.
 *
 * Guarded: only the active Adam row, and only while the column is blank —
 * a hand-corrected number is never clobbered. down() clears only this
 * exact seeded value.
 */

const LICENSE = 'JE362022';

function adamRow(knex) {
  return knex('technicians')
    .where({ active: true })
    .where(function adamByEitherName() {
      this.where({ name: 'Adam' }).orWhere({ applicator_printed_name: 'Adam Benetti' });
    });
}

exports.up = async function up(knex) {
  const updated = await adamRow(knex)
    .where(function licenseBlank() {
      this.whereNull('fl_applicator_license').orWhere('fl_applicator_license', '');
    })
    .update({ fl_applicator_license: LICENSE, updated_at: knex.fn.now() });
  if (!updated) {
    console.log('[migration] no active Adam row with a blank applicator license — seed skipped');
  }
};

exports.down = async function down(knex) {
  await adamRow(knex)
    .where({ fl_applicator_license: LICENSE })
    .update({ fl_applicator_license: null, updated_at: knex.fn.now() });
};
