/**
 * Short progress-visit SMS for typed specialty reports (contract §7,
 * deferred from PR 2 to the cutover PR).
 *
 * Sent instead of service_report_v1 when the completed visit's
 * typedReportSnapshot has visitSequence > 1 — i.e. trend-type progress
 * visits (Phase 1b+). {progress_headline} is the snapshot's generated
 * Today's Result headline (immutable, versioned, banned-words-safe),
 * so the text matches the report it links to. Falls back to the plain
 * service_report_v1 template when the headline is missing.
 */

const TEMPLATE = {
  template_key: 'service_report_v1_progress',
  name: 'Service Report V1 - Progress Visit',
  category: 'service',
  body: 'Hello {first_name}! {progress_headline} Full progress report: {report_url}{reentry_line}\n\nQuestions or requests? Reply here.',
  variables: ['first_name', 'progress_headline', 'report_url', 'reentry_line'],
  sort_order: 10,
};

exports.up = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;

  const existing = await knex('sms_templates')
    .where({ template_key: TEMPLATE.template_key })
    .first();
  if (existing) return;

  await knex('sms_templates').insert({
    template_key: TEMPLATE.template_key,
    name: TEMPLATE.name,
    category: TEMPLATE.category,
    body: TEMPLATE.body,
    variables: JSON.stringify(TEMPLATE.variables),
    sort_order: TEMPLATE.sort_order,
    is_active: true,
  });
};

exports.down = async function (knex) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  await knex('sms_templates').where({ template_key: TEMPLATE.template_key }).del();
};
