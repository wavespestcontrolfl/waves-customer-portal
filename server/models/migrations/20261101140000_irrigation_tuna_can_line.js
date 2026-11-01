'use strict';

/**
 * Monday irrigation email: one line that teaches the customer to measure
 * their sprinkler output with tuna cans (owner 2026-11-01).
 *
 * Copy (customer copy, owner-approved, do not reword):
 *   Not sure how much your sprinklers put down? Set a few empty tuna cans in
 *   one zone, run it for 15 minutes, and measure the water in the cans with a
 *   ruler. Reply with that number and how long you run each zone, and we'll
 *   set up your weekly amount.
 *
 * ONE template: irrigation.weekly_setup_schedule, the email to a recurring
 * lawn customer whose file shows a sprinkler system but no watering amount.
 * No other template changes (not setup_system, plan, rain_report, confirm or
 * the three advice emails).
 *
 * WHERE THE LINE LIVES. The body is an email_template_versions row (seeded by
 * migration, edited by migration and by the office editor). A fresh database
 * replays the seed and then this migration, so a fresh and the live database
 * render the same line. The line is one extra `paragraph` block, placed
 * directly after the template's setup callout (the block that asks for the
 * watering schedule) and ahead of the forecast line and the button. A
 * paragraph matches the style of the blocks around it; the callout is the ask
 * itself. No new variable: the line is plain text, so allowed/optional
 * variables and the editor fixtures are untouched.
 *
 * Same discipline as the sibling migrations (20261022190000, 20261026230000):
 *  - the template row is locked FOR UPDATE first and everything is read under
 *    the lock, so an office edit made before the lock wins;
 *  - a version that already carries the line is left whole (exactly once);
 *  - the prior version is archived, never overwritten; one audit_log row, same
 *    transaction, with the before/after of each changed field;
 *  - a staff-authored plain-text body wins over block-derived text at render
 *    time, so it gets the line too (after the paragraph holding the schedule
 *    ask); when it has no such paragraph the whole version is left alone, so
 *    HTML and text never disagree.
 *
 * Nothing else changes: subject, preview, other blocks, send conditions,
 * recipients. No send is triggered. down() is a documented no-op: the
 * superseded version stays archived and can be re-published from the editor.
 */

const MIGRATION_ID = '20261101140000_irrigation_tuna_can_line';
const MIGRATION_MARKER = 'migration:20261101140000';
// audit_log.action is varchar(96).
const AUDIT_ACTION = 'email_template.publish';

const TEMPLATE_KEY = 'irrigation.weekly_setup_schedule';

const TUNA_CAN_LINE = 'Not sure how much your sprinklers put down? Set a few empty tuna cans in one zone, run it for 15 minutes, and measure the water in the cans with a ruler. Reply with that number and how long you run each zone, and we\'ll set up your weekly amount.';
const TUNA_CAN_BLOCK = { type: 'paragraph', content: TUNA_CAN_LINE };

const json = (v) => JSON.stringify(v);
const parseList = (v) => {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; }
};

/** Pure: the blocks with the line right after the setup callout; null when already there or no callout. */
function withLine(blocksValue) {
  const blocks = parseList(blocksValue);
  if (!blocks || json(blocks).includes(TUNA_CAN_LINE)) return null;
  const at = blocks.findIndex((b) => b?.type === 'callout');
  if (at < 0) return null;
  return [...blocks.slice(0, at + 1), TUNA_CAN_BLOCK, ...blocks.slice(at + 1)];
}

/**
 * Pure: a staff-authored plain-text body with the line after the paragraph that
 * holds the schedule ask. No body: the body comes back as is (nothing to edit).
 * Already there, or no such paragraph: false (the version must be left whole).
 */
function withLineText(text) {
  if (typeof text !== 'string' || !text.trim()) return text;
  if (text.includes(TUNA_CAN_LINE)) return false;
  const paragraphs = text.replace(/\s+$/, '').split(/\n{2,}/);
  const at = paragraphs.findIndex((p) => p.includes('{{schedule_ask}}'));
  if (at < 0) return false;
  return [...paragraphs.slice(0, at + 1), TUNA_CAN_LINE, ...paragraphs.slice(at + 1)].join('\n\n');
}

/** Pure: the new { blocks, text_body } for a version, or null when nothing should change. */
function nextBody(version) {
  const blocks = withLine(version.blocks);
  const text = withLineText(version.text_body);
  if (!blocks || text === false) return null;
  return { blocks, text_body: text };
}

/** Publish the new version inside one transaction, template row locked first. Returns 'published', 'already', 'skipped' or 'missing'. */
async function publishLine(knex, key = TEMPLATE_KEY) {
  return knex.transaction(async (trx) => {
    const template = await trx('email_templates').where({ template_key: key }).forUpdate().first();
    const prior = template && await trx('email_template_versions').where({ id: template.active_version_id }).first();
    if (!prior) return 'missing';
    if (json(parseList(prior.blocks) || []).includes(TUNA_CAN_LINE)) return 'already';
    const next = nextBody(prior);
    if (!next) return 'skipped';

    const latest = await trx('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
    const now = new Date();
    const [created] = await trx('email_template_versions').insert({
      template_id: template.id,
      version_number: latest.version_number + 1,
      status: 'active',
      subject: prior.subject,
      preview_text: prior.preview_text,
      blocks: json(next.blocks),
      text_body: next.text_body,
      validation_snapshot: json({
        ok: true, source: MIGRATION_MARKER, supersedes_version: prior.version_number,
        referenced_variables: [], disallowed_variables: [], missing_required_in_template: [],
      }),
      published_at: now,
    }).returning('*');
    await trx('email_templates').where({ id: template.id }).update({ active_version_id: created.id, last_published_at: now, updated_at: now });
    await trx('email_template_versions').where({ id: prior.id, status: 'active' }).update({ status: 'archived', updated_at: now });

    const { recordAuditEvent } = require('../../services/audit-log');
    const changes = { blocks: { before: parseList(prior.blocks), after: next.blocks } };
    if (next.text_body !== prior.text_body) changes.text_body = { before: prior.text_body, after: next.text_body };
    await recordAuditEvent({
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
        reason: 'Weekly irrigation setup email: tuna-can line to measure sprinkler output (owner 2026-11-01)',
        changes,
      },
    });
    return 'published';
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  await publishLine(knex);
};

// Intentionally a no-op: see the header.
exports.down = async function down() {};

exports.__private = {
  TEMPLATE_KEY, AUDIT_ACTION, TUNA_CAN_LINE, withLine, withLineText, publishLine,
};
