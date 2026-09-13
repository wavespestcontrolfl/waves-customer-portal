'use strict';

// Supersedes 20260908000010_visit_summary_email_seed_audit, which the
// branch's preview deploys have already run and so cannot be edited: that
// backfill recorded `email_template.seeded` under the system actor for any
// service.visit_summary template without a prior seed event — including an
// administrator-created one, which the retained seed never wrote and which
// keeps its own audit history. Audit history is append-only, so the
// misattribution is corrected by appending a retraction that names the event
// it retracts; a seed-created template (no created_by) keeps its event.
const KEY = 'service.visit_summary';
const BACKFILL = '20260908000010_visit_summary_email_seed_audit';
const STAMP = '20260908000030_visit_summary_email_seed_audit_owner';
const RETRACTION = 'email_template.seed_audit_retracted';

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('audit_log'))) return;
  const template = await knex('email_templates').where({ template_key: KEY }).first('id', 'created_by');
  if (!template || !template.created_by) return;
  const seeded = await knex('audit_log')
    .where({ action: 'email_template.seeded', resource_type: 'email_template', resource_id: template.id, actor_type: 'system' })
    .select('id', 'metadata');
  const misattributed = seeded.find((event) => {
    const metadata = typeof event.metadata === 'string' ? JSON.parse(event.metadata) : event.metadata;
    return metadata?.migration === BACKFILL;
  });
  if (!misattributed) return;
  const retracted = await knex('audit_log')
    .where({ action: RETRACTION, resource_type: 'email_template', resource_id: template.id })
    .first('id');
  if (retracted) return;
  await require('../../services/audit-log').recordAuditEvent({
    actor_type: 'system', action: RETRACTION, resource_type: 'email_template', resource_id: template.id,
    metadata: { templateKey: KEY, retractsAuditId: misattributed.id, migration: STAMP,
      reason: 'template was created by an administrator; the seed backfill did not apply' },
    trx: knex, critical: true,
  });
};

// Audit history is append-only.
exports.down = async function down() {};

exports.BACKFILL = BACKFILL;
exports.RETRACTION = RETRACTION;
