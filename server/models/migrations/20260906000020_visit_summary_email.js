'use strict';

const KEY = 'service.visit_summary';

exports.up = async function up(knex) {
  if (await knex('email_templates').where({ template_key: KEY }).first('id')) return;
  const [template] = await knex('email_templates').insert({
    template_key: KEY, name: 'Visit summary ready', mode: 'service', purpose: 'report',
    description: 'One summary for a saved combined service visit, including partial outcomes.',
    legal_classification: 'transactional_relationship', audience: 'customer',
    content_sensitivity: 'property_sensitive', send_stream: 'service_operational',
    suppression_group_key: 'service_operational', status: 'active',
    allowed_variables: JSON.stringify(['first_name', 'summary_url']),
    required_variables: JSON.stringify(['first_name', 'summary_url']),
    default_cta_label: 'View visit summary', default_cta_url_variable: 'summary_url',
  }).returning('id');
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id, version_number: 1, status: 'active',
    subject: 'Your Waves visit summary is ready',
    preview_text: 'Review each service and its individual report.',
    blocks: JSON.stringify([
      { type: 'paragraph', content: 'Hi {{first_name}}, your visit summary is ready.' },
      { type: 'paragraph', content: 'Review the outcome of each service and open its report for treatment details and next steps.' },
      { type: 'cta', label: 'View visit summary', url_variable: 'summary_url' },
    ]), published_at: knex.fn.now(),
  }).returning('id');
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id, last_published_at: knex.fn.now(),
  });
  await knex('email_template_fixtures').insert({ template_id: template.id, name: 'Combined visit', is_default: true,
    payload: JSON.stringify({ first_name: 'Fixture', summary_url: `https://portal.wavespestcontrol.com/visit/${'a'.repeat(64)}` }),
  });
};

exports.down = async function down(knex) {
  await knex('email_templates').where({ template_key: KEY }).del();
};
