'use strict';

/**
 * Portal reply email: the subject says "Waves" (owner 2026-11-12, "Just do waves").
 *
 * The reply email (template_key 'portal_reply', seeded by 20261105000000, sent only with
 * GATE_PORTAL_MESSAGES on) had the subject "Your answer from Waves Pest Control". Our texts say "Waves"
 * since 2026-11-04; the Messages page and this email now do too.
 *
 * Copy (customer copy, owner-approved): subject "Your answer from Waves". Nothing else changes: the preview
 * line, the blocks, a plain-text body, the sender name, the variables, who it goes to. No send is triggered.
 *
 * Same discipline as the irrigation copy migrations (20261101140000):
 *  - the template row is locked FOR UPDATE first and everything is read under the lock, the order the
 *    editor's own publish takes;
 *  - only an active version whose subject is still exactly the seeded one is superseded, so a subject the
 *    office rewrote is never overwritten ('skipped'); a version that already says it is left whole
 *    ('already'); an open draft is the office's own and is left alone;
 *  - the new version is the prior one with the new subject, checked by the editor's own variable validation;
 *  - the prior version is archived, never overwritten; one audit_log row in the same transaction.
 * down() is a documented no-op: the superseded version stays archived and can be re-published from the
 * editor.
 */

const MIGRATION_ID = '20261112020000_portal_reply_subject_waves';
const MIGRATION_MARKER = 'migration:20261112020000';
// audit_log.action is varchar(96).
const AUDIT_ACTION = 'email_template.publish';

const TEMPLATE_KEY = 'portal_reply';
const SEEDED_SUBJECT = 'Your answer from Waves Pest Control';
const SUBJECT = 'Your answer from Waves';

const parse = (value, fallback) => {
  if (typeof value !== 'string') return value ?? fallback;
  try { return JSON.parse(value); } catch { return fallback; }
};

/** Publish the new subject inside one transaction, template row locked first. Returns 'published', 'already', 'skipped' or 'missing'. */
async function publishSubject(knex, key = TEMPLATE_KEY) {
  return knex.transaction(async (trx) => {
    const template = await trx('email_templates').where({ template_key: key }).forUpdate().first();
    const prior = template?.active_version_id
      ? await trx('email_template_versions').where({ id: template.active_version_id }).first()
      : null;
    if (!prior) return 'missing';
    if (prior.subject === SUBJECT) return 'already';
    if (prior.subject !== SEEDED_SUBJECT) return 'skipped';

    const blocks = parse(prior.blocks, []);
    const next = { subject: SUBJECT, preview_text: prior.preview_text, blocks, text_body: prior.text_body };
    const validation = require('../../services/email-template-library').validationFor(template, next);
    // The editor's publish refuses such a version; so does this.
    if (!validation.ok) return 'skipped';

    const latest = await trx('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
    const now = new Date();
    const [created] = await trx('email_template_versions').insert({
      template_id: template.id,
      version_number: latest.version_number + 1,
      status: 'active',
      subject: next.subject,
      preview_text: next.preview_text,
      blocks: JSON.stringify(blocks),
      text_body: next.text_body,
      validation_snapshot: JSON.stringify({ ...validation, source: MIGRATION_MARKER, supersedes_version: prior.version_number }),
      published_at: now,
    }).returning('*');
    await trx('email_templates').where({ id: template.id }).update({ active_version_id: created.id, last_published_at: now, updated_at: now });
    await trx('email_template_versions').where({ id: prior.id, status: 'active' }).update({ status: 'archived', updated_at: now });

    await require('../../services/audit-log').recordAuditEvent({
      actor_type: 'system:migration',
      action: AUDIT_ACTION,
      resource_type: 'email_template',
      resource_id: template.id,
      critical: true,
      trx,
      metadata: {
        via: MIGRATION_MARKER,
        migration: MIGRATION_ID,
        template_key: key,
        from_version_id: prior.id,
        from_version_number: prior.version_number,
        to_version_id: created.id,
        to_version_number: created.version_number,
        reason: 'Portal reply email subject says "Waves" (owner 2026-11-12)',
        changes: { subject: { before: prior.subject, after: SUBJECT } },
      },
    });
    return 'published';
  });
}

exports.up = async function up(knex) {
  for (const table of ['email_templates', 'email_template_versions']) {
    if (!(await knex.schema.hasTable(table))) return;
  }
  // The outcome goes to the deploy log, so a 'skipped' (the office rewrote the subject) is visible.
  const outcome = await publishSubject(knex);
  console.log(`[${MIGRATION_ID}] ${TEMPLATE_KEY}: ${outcome}`);
};

// Intentionally a no-op: see the header.
exports.down = async function down() {};

exports.__private = { TEMPLATE_KEY, AUDIT_ACTION, SEEDED_SUBJECT, SUBJECT, publishSubject };
