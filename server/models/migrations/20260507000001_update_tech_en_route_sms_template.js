const BODY = 'Hello {first_name}! {tech_name} is on the way.\n\n{eta_line}Track live: {track_url}\n\nQuestions or requests? Reply to this message. Reply STOP to opt out.';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const cols = await knex('sms_templates').columnInfo();
  const now = new Date();
  const row = {
    template_key: 'tech_en_route',
    name: 'Tech En Route',
    category: 'service',
    body: BODY,
    variables: JSON.stringify(['first_name', 'tech_name', 'eta_line', 'track_url']),
    sort_order: 3,
    ...(cols.is_active ? { is_active: true } : {}),
    ...(cols.updated_at ? { updated_at: now } : {}),
  };

  const existing = await knex('sms_templates')
    .where({ template_key: 'tech_en_route' })
    .first();

  if (existing) {
    await knex('sms_templates')
      .where({ template_key: 'tech_en_route' })
      .update(row);
  } else {
    await knex('sms_templates').insert({
      ...row,
      ...(cols.created_at ? { created_at: now } : {}),
    });
  }
};

exports.down = async function down() {};
