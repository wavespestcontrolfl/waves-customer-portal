/**
 * Renew the expiry date for Adam's FL applicator ID card (owner-provided
 * 2026-07-10: renewed through May 31, 2027, same card number JE362022 —
 * companion to 20260703000004, which seeded the number, and
 * 20260704000004, which seeded the prior May 31, 2026 expiry).
 *
 * With the 2026-05-31 date on file the certificate applicator picker
 * (GET /api/admin/projects/applicators) has been withholding Adam's number
 * since June 1 — by design, an expired ID never auto-fills onto a state
 * compliance certificate. Recording the renewal restores the auto-fill
 * while keeping that expired-number protection engaged for the next cycle.
 *
 * Guarded: only the active Adam row, only while it still carries the seeded
 * card number JE362022, and only while license_expiry is exactly the
 * previously seeded 2026-05-31 — a hand-edited number or date is never
 * clobbered. down() restores the prior seeded date from that same row.
 */

const LICENSE = 'JE362022';
const PRIOR_EXPIRY = '2026-05-31';
const RENEWED_EXPIRY = '2027-05-31';

function adamSeededLicenseRow(knex) {
  return knex('technicians')
    .where({ active: true, fl_applicator_license: LICENSE })
    .where(function adamByEitherName() {
      this.where({ name: 'Adam' }).orWhere({ applicator_printed_name: 'Adam Benetti' });
    });
}

exports.up = async function up(knex) {
  const updated = await adamSeededLicenseRow(knex)
    .where({ license_expiry: PRIOR_EXPIRY })
    .update({ license_expiry: RENEWED_EXPIRY, updated_at: knex.fn.now() });
  if (!updated) {
    console.log('[migration] no active Adam row with license JE362022 and the seeded 2026-05-31 expiry — renewal skipped');
  }
};

exports.down = async function down(knex) {
  await adamSeededLicenseRow(knex)
    .where({ license_expiry: RENEWED_EXPIRY })
    .update({ license_expiry: PRIOR_EXPIRY, updated_at: knex.fn.now() });
};
