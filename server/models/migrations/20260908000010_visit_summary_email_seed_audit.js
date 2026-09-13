'use strict';

// The retained seed (20260906000020) creates service.visit_summary before
// 20260907000011 runs, so that later seed returns at its existing-template
// guard without recording the email_template.seeded audit event. Record it
// once here for any database whose template has no such entry.
const KEY = 'service.visit_summary';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const template = await knex('email_templates').where({ template_key: KEY }).first('id');
  if (!template) return;
  const recorded = await knex('audit_log')
    .where({ action: 'email_template.seeded', resource_type: 'email_template', resource_id: template.id })
    .first('id');
  if (recorded) return;
  await require('../../services/audit-log').recordAuditEvent({
    actor_type: 'system', action: 'email_template.seeded', resource_type: 'email_template',
    resource_id: template.id,
    metadata: { templateKey: KEY, migration: '20260908000010_visit_summary_email_seed_audit' },
    trx: knex, critical: true,
  });
};

// Audit history is append-only.
exports.down = async function down() {};
