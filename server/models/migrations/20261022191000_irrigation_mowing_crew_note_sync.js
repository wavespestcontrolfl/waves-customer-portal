'use strict';

/**
 * Follow-up to 20261022190000_irrigation_mowing_crew_note (Codex P2 on #6485).
 *
 * 190000 treated a template as done when the post URL appeared in EITHER the
 * blocks or the custom plain-text body. The renderer uses a custom text_body
 * instead of block-derived text, so a version that carried the line in only
 * one of the two left that audience (text readers, or HTML readers) without
 * it. 190000 is already applied and frozen; this migration checks each
 * representation independently and adds the line only where it is missing:
 *
 *   blocks    lack the URL            -> add the paragraph block
 *   text_body is custom and lacks it  -> add the text line
 *
 * A null/blank text_body is not a representation of its own (the text part
 * is derived from the blocks), so it is left null. A version that already has
 * the line everywhere is left whole: nothing is published. Same row-first
 * lock order, archive-never-overwrite and per-template audit row as 190000.
 * down() is a no-op.
 */

const { withNote, withNoteText, TEMPLATE_KEYS, NOTE_TEXT, MOWING_CREW_URL } = require('./20261022190000_irrigation_mowing_crew_note').__private;

const MIGRATION_ID = '20261022191000_irrigation_mowing_crew_note_sync';
const MIGRATION_MARKER = 'migration:20261022191000';
const AUDIT_ACTION = 'email_template.publish';

const json = (v) => JSON.stringify(v);
const parseBlocks = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; } }
  return null;
};

/**
 * Pure: what each representation of a version needs. `blocks` / `text` are the
 * replacement values, or null when that representation needs no change.
 */
function planSync(version) {
  const hasText = version.text_body != null && String(version.text_body).trim() !== '';
  const blocksLack = !json(parseBlocks(version.blocks) || []).includes(MOWING_CREW_URL);
  const textLacks = hasText && !String(version.text_body).includes(MOWING_CREW_URL);
  return {
    blocks: blocksLack ? withNote(version.blocks) : null,
    text: textLacks ? withNoteText(version.text_body) : null,
  };
}

/** Returns 'published', 'already', 'missing' or 'skipped'. */
async function syncNote(knex, key, { audit = true } = {}) {
  return knex.transaction(async (trx) => {
    // 1. Lock the template row FIRST, then read everything under the lock.
    const template = await trx('email_templates').where({ template_key: key }).forUpdate().first();
    if (!template?.active_version_id) return 'missing';
    const prior = await trx('email_template_versions').where({ id: template.active_version_id }).first();
    if (!prior) return 'missing';
    const { blocks, text } = planSync(prior);
    if (blocks == null && text == null) {
      // Nothing to add. Blocks that lack the URL but are unusable cannot be
      // fixed here; say so rather than reporting the template complete.
      const unusable = !json(parseBlocks(prior.blocks) || []).includes(MOWING_CREW_URL);
      if (unusable) {
        console.warn(`[${MIGRATION_MARKER}] ${key}: active version has no usable blocks; template left as-is`);
        return 'skipped';
      }
      return 'already';
    }
    const latest = await trx('email_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'desc')
      .first();
    const now = new Date();
    const [created] = await trx('email_template_versions').insert({
      template_id: template.id,
      version_number: (latest?.version_number || 0) + 1,
      status: 'active',
      subject: prior.subject,
      preview_text: prior.preview_text,
      blocks: blocks != null ? json(blocks) : (typeof prior.blocks === 'string' ? prior.blocks : json(prior.blocks)),
      text_body: text != null ? text : prior.text_body,
      validation_snapshot: json({
        ok: true,
        source: MIGRATION_MARKER,
        supersedes_version: prior.version_number,
        referenced_variables: [],
        disallowed_variables: [],
        missing_required_in_template: [],
      }),
      published_at: now,
    }).returning('*');
    const moved = await trx('email_templates')
      .where({ id: template.id, active_version_id: prior.id })
      .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
    if (!moved) throw new Error(`[${MIGRATION_MARKER}] ${key}: active pointer moved under the row lock`);
    await trx('email_template_versions')
      .where({ id: prior.id, status: 'active' })
      .update({ status: 'archived', updated_at: now });
    if (audit) {
      const { recordAuditEvent } = require('../../services/audit-log');
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
          reason: 'Mowing-crew note: add the line to the representation (blocks or custom text) that lacked it (Codex P2 on #6485)',
          added_to: [blocks != null ? 'blocks' : null, text != null ? 'text_body' : null].filter(Boolean),
          added_line: NOTE_TEXT,
        },
      });
    }
    return 'published';
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const audit = await knex.schema.hasTable('audit_log');
  for (const key of TEMPLATE_KEYS) await syncNote(knex, key, { audit });
};

// Intentionally a no-op: the superseded version stays archived.
exports.down = async function down() {};

exports.__private = { planSync, syncNote };
