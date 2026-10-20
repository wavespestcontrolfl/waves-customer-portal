'use strict';

/**
 * ESTIMATE PDF NOTE: 13px -> 15px (codex #6343 r4; GATE_ESTIMATE_EMAIL_PDF, dark).
 * Data only, no schema.
 *
 * Migration 20261019200000 added the PDF line ({{estimate_pdf_note}}) to the
 * open-estimate email templates as a `small_note` block, which renders at 13px.
 * Customer copy has a 14px floor, and this line tells a customer who cannot open
 * the link where the estimate is, so it is body text. This publishes ONE new
 * active version of every template whose active blocks carry a `small_note`
 * block whose content is exactly `{{estimate_pdf_note}}`, with that one block's
 * type changed to `paragraph` (15px body text). Nothing else in the blocks
 * changes, and a send with no PDF still drops the block (a paragraph whose
 * content renders blank is dropped too), so a gate-off email stays
 * byte-identical.
 *
 * Found by scanning the live active versions, not from a fixed list, so any
 * template that carries the line is covered. Same publish pattern as
 * 20261019200000: template row locked first, new version published by
 * compare-and-swap on the active version, only the version it replaces
 * archived, an audit_log row. A template whose block is already a paragraph (or
 * has no such block) is left whole; so are templates with unreadable blocks, a
 * custom plain-text body, or a version that no longer validates - each logged,
 * never half-patched. `down` is a documented no-op: a blanket revert would erase
 * admin edits made after this published.
 */

const MIGRATION = '20261019210000';
const MARKER = `migration:${MIGRATION}`;
const VARIABLE = '{{estimate_pdf_note}}';

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

const isNoteBlock = (b) => !!b && typeof b === 'object' && b.content === VARIABLE;

// Pure transform: the note block(s) as paragraphs, everything else untouched.
// Returns { blocks, changed }; the input is never mutated.
function retypeNoteBlocks(blocksIn) {
  let changed = false;
  const blocks = blocksIn.map((b) => {
    if (isNoteBlock(b) && b.type === 'small_note') {
      changed = true;
      return { ...b, type: 'paragraph' };
    }
    return b;
  });
  return { blocks, changed };
}

async function publishTemplate(knex, templateId) {
  const template = await knex('email_templates').where({ id: templateId }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';
  const key = template.template_key;

  const blocks = json(prior.blocks, null);
  if (!Array.isArray(blocks)) {
    console.warn(`[${MARKER}] ${key}: active blocks unreadable; template left as-is`);
    return 'skipped';
  }
  const { blocks: nextBlocks, changed } = retypeNoteBlocks(blocks);
  if (!changed) return 'already';
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MARKER}] ${key}: custom plain-text body present; template left as-is`);
    return 'skipped';
  }

  const now = new Date();
  const { validationFor } = require('../../services/email-template-library');
  const validation = validationFor(template, { ...prior, blocks: nextBlocks });
  if (!validation.ok) {
    console.warn(`[${MARKER}] ${key}: new version failed variable validation; template left as-is`);
    return 'skipped';
  }
  const latest = await knex('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first();
  let created;
  try {
    // Savepoint: the admin editor allocates draft numbers the same way
    // (max + 1, no lock), so a concurrent draft can take this number.
    created = await knex.transaction(async (sp) => {
      const [row] = await sp('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: prior.subject,
        preview_text: prior.preview_text,
        blocks: JSON.stringify(nextBlocks),
        text_body: null,
        validation_snapshot: JSON.stringify({ ...validation, source: MARKER, supersedes_version: prior.version_number }),
        published_at: now,
      }).returning('*');
      return row;
    });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    console.warn(`[${MARKER}] ${key}: version number taken by a concurrent draft; template left as-is`);
    return 'raced';
  }
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  await knex('email_template_versions').where({ id: prior.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  return 'published';
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await knex.transaction(async (trx) => {
    const candidates = await trx('email_templates as t')
      .join('email_template_versions as v', 'v.id', 't.active_version_id')
      .whereRaw('v.blocks::text LIKE ?', [`%${VARIABLE}%`])
      .orderBy('t.template_key')
      .select('t.id', 't.template_key');
    const results = {};
    for (const candidate of candidates) {
      results[candidate.template_key] = await publishTemplate(trx, candidate.id);
    }
    console.log(`[${MARKER}] ${Object.entries(results).map(([k, v]) => `${k}: ${v}`).join('; ') || 'no templates carry the PDF note'}`);
    if (await trx.schema.hasTable('audit_log')) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system',
        action: `${MARKER}:publish`,
        resource_type: 'email_template',
        resource_id: null,
        metadata: { results },
        critical: true,
        trx,
      });
    }
  });
};

exports.down = async function down() {
  // Data-only publish: a blanket revert would erase admin edits made after it.
  // Staff can republish the prior version from the template library.
};

exports._private = { retypeNoteBlocks, isNoteBlock };
