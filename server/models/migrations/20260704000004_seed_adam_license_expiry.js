/**
 * Seed the expiry date for Adam's FL applicator ID card (owner-provided
 * 2026-07-04: May 31, 2026 — companion to 20260703000004, which seeded the
 * card number JE362022 with no expiry because none had been provided yet).
 *
 * The certificate applicator picker (GET /api/admin/projects/applicators)
 * withholds an applicator whose license_expiry is in the past, but treats a
 * missing expiry as active — so until this date is on file the expired-number
 * protection never engages.
 *
 * Guarded: only the active Adam row, only while it still carries the seeded
 * card number JE362022 (a hand-corrected number means this expiry may not
 * apply to it), and only while license_expiry is blank — a hand-entered date
 * is never clobbered. down() clears only this exact seeded date from that
 * same row.
 */

const LICENSE = 'JE362022';
const EXPIRY = '2026-05-31';

function adamSeededLicenseRow(knex) {
  return knex('technicians')
    .where({ active: true, fl_applicator_license: LICENSE })
    .where(function adamByEitherName() {
      this.where({ name: 'Adam' }).orWhere({ applicator_printed_name: 'Adam Benetti' });
    });
}

exports.up = async function up(knex) {
  const updated = await adamSeededLicenseRow(knex)
    .whereNull('license_expiry')
    .update({ license_expiry: EXPIRY, updated_at: knex.fn.now() });
  if (!updated) {
    console.log('[migration] no active Adam row with license JE362022 and a blank expiry — seed skipped');
  }
};

exports.down = async function down(knex) {
  await adamSeededLicenseRow(knex)
    .where({ license_expiry: EXPIRY })
    .update({ license_expiry: null, updated_at: knex.fn.now() });
};
