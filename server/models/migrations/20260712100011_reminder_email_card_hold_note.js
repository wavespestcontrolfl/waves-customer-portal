'use strict';

/**
 * Card-on-file spec Phase 1, email leg (Codex #2677 rounds 1–2): the 72h/24h
 * reminder EMAILS must carry the same card-hold fee-policy disclosure as
 * the SMS — the email channel replaces or supplements the text for
 * email/both customers, and the undelivered-SMS fallback lands here too.
 *
 * Appends a `callout` block containing only {{card_hold_policy_note}} to
 * EVERY version of appointment.reminder_72h / appointment.reminder_24h —
 * not just the active one, so a saved draft promoted later can't silently
 * drop the disclosure (round-2). Versions with a custom text_body get the
 * placeholder appended there too: renderTemplate prefers text_body over
 * block-generated text, and a text-only client must still see the
 * disclosure (round-2). The variable is registered in BOTH allowed_variables
 * (the admin publish path validates against it — round-2) and
 * optional_variables.
 *
 * renderBlocks skips a callout whose rendered content is empty, and an
 * empty variable in text_body renders as nothing, so non-card-hold
 * reminders are unchanged. The sender
 * (appointment-email.sendAppointmentReminderEmail) always supplies the
 * variable ('' when no held card).
 *
 * Read-modify-write, admin-edit preserving (posture of 20260706000030):
 * skips any version already referencing the variable; down removes only
 * the exact block/append this migration adds.
 */

const TEMPLATE_KEYS = ['appointment.reminder_72h', 'appointment.reminder_24h'];
const VAR_NAME = 'card_hold_policy_note';
const BLOCK_CONTENT = `{{${VAR_NAME}}}`;
const TEXT_APPEND = `\n\n{{${VAR_NAME}}}`;

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

async function eachTemplate(knex, fn) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;
  for (const key of TEMPLATE_KEYS) {
    const template = await knex('email_templates').where({ template_key: key }).first();
    if (!template) continue;
    const versions = await knex('email_template_versions').where({ template_id: template.id });
    await fn(template, versions);
  }
}

exports.up = async function up(knex) {
  const now = new Date();
  await eachTemplate(knex, async (template, versions) => {
    await knex('email_templates').where({ id: template.id }).update({
      allowed_variables: JSON.stringify(withVariable(template.allowed_variables)),
      optional_variables: JSON.stringify(withVariable(template.optional_variables)),
      updated_at: now,
    });
    for (const version of versions) {
      const update = {};
      const blocks = asArray(version.blocks);
      if (!blocks.some((b) => b && typeof b.content === 'string' && b.content.includes(VAR_NAME))) {
        // Before the signature when one exists, so the notice reads inside
        // the message body; else appended.
        const sigIdx = blocks.findIndex((b) => b && b.type === 'signature');
        const insertAt = sigIdx === -1 ? blocks.length : sigIdx;
        const next = [...blocks];
        next.splice(insertAt, 0, { type: 'callout', content: BLOCK_CONTENT });
        update.blocks = JSON.stringify(next);
      }
      if (typeof version.text_body === 'string' && version.text_body.trim() !== ''
        && !version.text_body.includes(VAR_NAME)) {
        update.text_body = `${version.text_body}${TEXT_APPEND}`;
      }
      if (Object.keys(update).length) {
        update.updated_at = now;
        await knex('email_template_versions').where({ id: version.id }).update(update);
      }
    }
  });
};

exports.down = async function down(knex) {
  const now = new Date();
  await eachTemplate(knex, async (template, versions) => {
    await knex('email_templates').where({ id: template.id }).update({
      allowed_variables: JSON.stringify(withoutVariable(template.allowed_variables)),
      optional_variables: JSON.stringify(withoutVariable(template.optional_variables)),
      updated_at: now,
    });
    for (const version of versions) {
      const update = {};
      const blocks = asArray(version.blocks);
      const next = blocks.filter((b) => !(b && b.type === 'callout' && b.content === BLOCK_CONTENT));
      if (next.length !== blocks.length) update.blocks = JSON.stringify(next);
      if (typeof version.text_body === 'string' && version.text_body.includes(TEXT_APPEND)) {
        update.text_body = version.text_body.split(TEXT_APPEND).join('');
      }
      if (Object.keys(update).length) {
        update.updated_at = now;
        await knex('email_template_versions').where({ id: version.id }).update(update);
      }
    }
  });
};
