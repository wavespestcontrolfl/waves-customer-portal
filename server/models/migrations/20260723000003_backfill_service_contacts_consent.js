// Grandfather backfill (owner-authorized 2026-07-22): every customer row
// that already stores an on-location contact phone predates the consent
// artifact (#2948), so those slots would otherwise sit with NULL stamps
// forever. Stamp them with an explicit grandfather source — NOT the
// portal_account_holder attestation — so the artifact never claims an
// attestation that didn't happen, and any future fanout gate on the
// consent columns is a no-op for pre-existing recipients instead of
// muting them.
const GRANDFATHER_SOURCE = 'legacy_grandfathered_backfill';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'service_contacts_consent_at'))) return;
  await knex('customers')
    .where(function whereAnyPhone() {
      this.whereRaw("coalesce(service_contact_phone, '') <> ''")
        .orWhereRaw("coalesce(service_contact2_phone, '') <> ''")
        .orWhereRaw("coalesce(service_contact3_phone, '') <> ''");
    })
    .whereNull('service_contacts_consent_at')
    .update({
      service_contacts_consent_at: knex.fn.now(),
      service_contacts_consent_source: GRANDFATHER_SOURCE,
      service_contacts_consent_text_version: 'pre-2948-grandfathered',
    });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('customers'))) return;
  if (!(await knex.schema.hasColumn('customers', 'service_contacts_consent_at'))) return;
  // Only unwind rows this backfill stamped — real attestations keep theirs.
  await knex('customers')
    .where({ service_contacts_consent_source: GRANDFATHER_SOURCE })
    .update({
      service_contacts_consent_at: null,
      service_contacts_consent_source: null,
      service_contacts_consent_text_version: null,
    });
};
