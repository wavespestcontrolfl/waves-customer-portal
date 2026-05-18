// Re-syncs the tech_en_route SMS template body to the canonical form so any
// manual edits in the admin UI that introduced extra blank lines (the gap
// between the "Track live:" URL and "Questions or requests?" was rendering
// as 3+ blank lines instead of 1) are normalized.
const CANONICAL_BODY =
  'Hello {first_name}! {tech_name} is on the way.\n\n{eta_line}{track_clause}Questions or requests? Reply here. Reply STOP to opt out.';
const CANONICAL_VARIABLES = ['first_name', 'tech_name', 'eta_line', 'track_clause'];

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const existing = await knex('sms_templates')
    .where({ template_key: 'tech_en_route' })
    .first();
  if (!existing) return;
  const cols = await knex('sms_templates').columnInfo();
  await knex('sms_templates')
    .where({ template_key: 'tech_en_route' })
    .update({
      body: CANONICAL_BODY,
      variables: JSON.stringify(CANONICAL_VARIABLES),
      ...(cols.updated_at ? { updated_at: new Date() } : {}),
    });
};

exports.down = async function down() {};
