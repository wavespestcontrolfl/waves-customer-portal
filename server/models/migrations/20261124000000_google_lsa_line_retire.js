/**
 * Turn off the lead_sources row for +19412135010, the Google Local Services
 * line seeded by 20261123170000. Google forbids a tracking number as the Local
 * Services business phone (support.google.com/localservices/answer/7435507),
 * so the line never went on the profile and the owner released it
 * (2026-11-23, "do the rec"). Local Services calls are matched to the office
 * line from Google's own lead list instead.
 *
 * Only the seeded row is touched (source_type google_lsa, still active), and
 * only its active flag: it is kept, not deleted, and its notes are left as the
 * office has them, so a lead that points at it stays intact.
 */
const NUMBER_FORMATS = ['+19412135010', '9412135010', '19412135010', '(941) 213-5010'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;
  await knex('lead_sources')
    .whereIn('twilio_phone_number', NUMBER_FORMATS)
    .where({ source_type: 'google_lsa', is_active: true })
    .update({ is_active: false, updated_at: knex.fn.now() });
};

// Never turns the row back on: the number is no longer ours.
exports.down = async function down() {};
