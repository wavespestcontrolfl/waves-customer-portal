'use strict';

/**
 * Card-on-file spec Phase 1, email leg (Codex #2677 round-1): the 72h/24h
 * reminder EMAILS must carry the same card-hold fee-policy disclosure as
 * the SMS — the email channel replaces or supplements the text for
 * email/both customers, and the undelivered-SMS fallback lands here too.
 *
 * Appends a `callout` block containing only {{card_hold_policy_note}} to
 * the ACTIVE version of appointment.reminder_72h / appointment.reminder_24h
 * and registers the variable as optional. renderBlocks skips a callout
 * whose rendered content is empty, so non-card-hold reminders are
 * unchanged; card-hold reminders show the disclosure as a highlighted
 * notice. The sender (appointment-email.sendAppointmentReminderEmail)
 * always supplies the variable ('' when no held card).
 *
 * Read-modify-write, admin-edit preserving (posture of 20260706000030):
 * skips any version that already references the variable; down removes
 * only the exact block this migration adds.
 */

const TEMPLATE_KEYS = ['appointment.reminder_72h', 'appointment.reminder_24h'];
const VAR_NAME = 'card_hold_policy_note';
const BLOCK_CONTENT = `{{${VAR_NAME}}}`;

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  }
  return [];
}

function withVariable(list) {
  const arr = asArray(list);
  return arr.includes(VAR_NAME) ? arr : [...arr, VAR_NAME];
}

function withoutVariable(list) {
  return asArray(list).filter((v) => v !== VAR_NAME);
}

async function eachActiveVersion(knex, fn) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  for (const key of TEMPLATE_KEYS) {
    const template = await knex('email_templates').where({ template_key: key }).first();
    if (!template) continue;
    const version = template.active_version_id
      ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
      : null;
    await fn(template, version);
  }
}

exports.up = async function up(knex) {
  const now = new Date();
  await eachActiveVersion(knex, async (template, version) => {
    await knex('email_templates').where({ id: template.id }).update({
      optional_variables: JSON.stringify(withVariable(template.optional_variables)),
      updated_at: now,
    });
    if (!version) return;
    const blocks = asArray(version.blocks);
    if (blocks.some((b) => b && typeof b.content === 'string' && b.content.includes(VAR_NAME))) return;
    // Before the signature when one exists, so the notice reads inside the
    // message body; else appended.
    const sigIdx = blocks.findIndex((b) => b && b.type === 'signature');
    const insertAt = sigIdx === -1 ? blocks.length : sigIdx;
    const next = [...blocks];
    next.splice(insertAt, 0, { type: 'callout', content: BLOCK_CONTENT });
    await knex('email_template_versions').where({ id: version.id }).update({
      blocks: JSON.stringify(next),
      updated_at: now,
    });
  });
};

exports.down = async function down(knex) {
  const now = new Date();
  await eachActiveVersion(knex, async (template, version) => {
    await knex('email_templates').where({ id: template.id }).update({
      optional_variables: JSON.stringify(withoutVariable(template.optional_variables)),
      updated_at: now,
    });
    if (!version) return;
    const blocks = asArray(version.blocks);
    const next = blocks.filter((b) => !(b && b.type === 'callout' && b.content === BLOCK_CONTENT));
    if (next.length === blocks.length) return;
    await knex('email_template_versions').where({ id: version.id }).update({
      blocks: JSON.stringify(next),
      updated_at: now,
    });
  });
};
