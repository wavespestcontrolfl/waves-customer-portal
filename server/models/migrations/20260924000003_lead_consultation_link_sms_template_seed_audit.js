'use strict';

// 20260923000020_lead_consultation_link_sms_template seeds lead_consultation_link
// but never recorded the sms_template.seeded audit event for it (a review-round
// fix that would have added the event was reverted instead of shipped as a new
// migration — 0020 already ran on the PR's preview branch, so editing it in
// place is a silent no-op there; see waves-db skill §4). Record it once here
// for any database whose template has no such entry, same pattern as
// 20260908000010_visit_summary_email_seed_audit.
const KEY = 'lead_consultation_link';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const template = await knex('sms_templates').where({ template_key: KEY }).first('id');
  if (!template) return;
  const recorded = await knex('audit_log')
    .where({ action: 'sms_template.seeded', resource_type: 'sms_template', resource_id: template.id })
    .first('id');
  if (recorded) return;
  await require('../../services/audit-log').recordAuditEvent({
    actor_type: 'system', action: 'sms_template.seeded', resource_type: 'sms_template',
    resource_id: template.id,
    metadata: { templateKey: KEY, migration: '20260924000003_lead_consultation_link_sms_template_seed_audit' },
    trx: knex, critical: true,
  });
};

// Audit history is append-only.
exports.down = async function down() {};
