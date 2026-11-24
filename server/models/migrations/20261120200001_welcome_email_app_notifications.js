'use strict';

// welcome.new_recurring gains the app notification steps (owner 2026-11-20):
// allow notifications on first open, then the phone settings to check when
// alerts do not show, for iPhone and Android. The full versions are the
// howto.alerts_iphone / howto.alerts_android emails (20261120200000).
//
// Same discipline as 20260907000090: publish a NEW version from the active
// one, so staff edits and older versions stay. Unlike it, a missing anchor
// does not throw: the two paragraphs fall back to sitting above the first
// button, then above the signature. A welcome email that staff reworded
// still gets the steps, and no deploy fails on it.
// Data-only rollback is a no-op: staff can republish a prior version.
const { recordAuditEvent } = require('../../services/audit-log');
const { validationFor } = require('../../services/email-template-library');

const MIGRATION = '20261120200001';
const TEMPLATE_KEY = 'welcome.new_recurring';
const ALLOW_COPY = 'Turn on notifications to get visit reminders and on-the-way alerts on your phone. If your phone asks when you first open the app, allow notifications.';
const SETTINGS_COPY = 'Not seeing alerts? On an iPhone, open Settings, tap Notifications, then tap Waves and turn on Allow Notifications, Banners and Sounds. On an Android phone, press and hold the Waves app icon, tap App info, then Notifications, and turn on Allow notifications.';

function json(value, fallback) {
  if (value == null) return fallback;
  return typeof value === 'string' ? JSON.parse(value) : value;
}

// After the sign-in help paragraph 20260907000090 wrote; else above the
// first button; else above the signature; else at the end.
function addNotificationSteps(blocks) {
  if (blocks.some((b) => b.content === ALLOW_COPY)) return blocks;
  const help = blocks.findIndex((b) => b.type === 'paragraph' && String(b.content || '').startsWith('If your sign-in code does not arrive'));
  const cta = blocks.findIndex((b) => b.type === 'cta');
  const signature = blocks.findIndex((b) => b.type === 'signature');
  const at = help >= 0 ? help + 1 : cta >= 0 ? cta : signature >= 0 ? signature : blocks.length;
  blocks.splice(at, 0, { type: 'paragraph', content: ALLOW_COPY }, { type: 'paragraph', content: SETTINGS_COPY });
  return blocks;
}

function buildVersion(active) {
  const blocks = addNotificationSteps(structuredClone(json(active.blocks, [])));
  // A custom plaintext body is staff-written: append, never replace.
  const textBody = active.text_body ? `${active.text_body}\n\n${ALLOW_COPY}\n\n${SETTINGS_COPY}` : null;
  return {
    subject: active.subject,
    preview_text: active.preview_text,
    blocks: JSON.stringify(blocks),
    text_body: textBody,
  };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const template = await trx('email_templates').where({ template_key: TEMPLATE_KEY }).forUpdate().first();
    if (!template?.active_version_id) return;
    const prior = await trx('email_template_versions').where({ template_id: template.id })
      .whereRaw("validation_snapshot->>'migration' = ?", [MIGRATION]).first('id');
    if (prior) return;
    const active = await trx('email_template_versions').where({ id: template.active_version_id, template_id: template.id }).first();
    if (!active) return;
    const versionFields = buildVersion(active);
    if (versionFields.blocks === JSON.stringify(json(active.blocks, []))) return;
    const validation = validationFor(template, versionFields);
    versionFields.validation_snapshot = JSON.stringify({ ...validation, migration: MIGRATION });
    const latest = await trx('email_template_versions').where({ template_id: template.id }).max('version_number as max').first();
    const [version] = await trx('email_template_versions').insert({
      ...versionFields, template_id: template.id, version_number: Number(latest?.max || 0) + 1,
      status: 'active', published_at: new Date(),
    }).returning('id');
    await trx('email_templates').where({ id: template.id }).update({
      active_version_id: version.id, last_published_at: new Date(), updated_at: new Date(),
    });
    await recordAuditEvent({
      actor_type: 'system', action: `migration:${MIGRATION}:publish`,
      resource_type: 'email_template', resource_id: template.id,
      metadata: { template_key: TEMPLATE_KEY, prior_version_id: active.id, version_id: version.id },
      critical: true, trx,
    });
  });
};

exports.down = async function down() {
  // No destructive rollback of a staff-editable template version or its audit.
};

exports.addNotificationSteps = addNotificationSteps;
exports.buildVersion = buildVersion;
exports.__private = { ALLOW_COPY, SETTINGS_COPY, TEMPLATE_KEY };
