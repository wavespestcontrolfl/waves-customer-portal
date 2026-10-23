'use strict';

/**
 * Monday irrigation email: one line linking the "note for your mowing crew"
 * blog post (owner 2026-10-22: "this should be a blog post, attached to the
 * irrigation email").
 *
 * Copy (customer copy, owner-approved, do not reword):
 *   Who mows your lawn? Forward them this short note so every cut helps your
 *   grass: A note for whoever mows your lawn
 * where the last phrase is the link text.
 *
 * WHERE THE LINE LIVES. The bodies of every weekly irrigation email are
 * email_template_versions rows (seeded by migration, edited by migration and
 * by the office editor), not code. The line is therefore added the way the
 * blog-link (20260803000000), guide-resource (20260907000010) and
 * longer-runs (20261009171000) changes were: publish a new active version of
 * each template with one extra `paragraph` block. That one block reaches
 * every variant because it is added to every template the sweep can pick:
 *
 *   irrigation.weekly_cut_back / _add_water / _on_track   (pre-plan advice)
 *   irrigation.weekly_setup_schedule / _setup_system       (setup asks)
 *   irrigation.weekly_confirm_schedule                     (tech-recorded)
 *   irrigation.weekly_plan                                 (week plan email;
 *       renderWeekPlanEmail only fills its variables, the body is this row)
 *
 * Placement: after the main advice, as the last link of the "Helpful guides
 * from the Waves blog" section and ahead of the standing footer note (the
 * "This tip is based on..." small print). A paragraph block renders with the same inline
 * styles and 15px size as the guide links beside it; the link goes through
 * the library's markdown-link renderer, which escapes the label and the
 * href, and the plain-text part renders "label (url)".
 *
 * Safety, same as the sibling migrations:
 *  - the template row is locked FOR UPDATE first, then everything is read
 *    under the lock (the order the editor's publisher uses), so an office
 *    edit made before the lock is seen and wins;
 *  - a template whose active version already carries the URL anywhere (a
 *    staff-added link, or a re-run) is left whole: exactly-once;
 *  - a staff-authored plain-text body gets the line appended in text form
 *    (it wins over block-derived text at render time);
 *  - the superseded version is archived, never overwritten, and one
 *    audit_log row is written per published template, in the same
 *    transaction.
 *
 * Nothing else changes: subject, preview, other blocks, variables, send
 * conditions, schedule, recipients. No send is triggered by this migration.
 * A template already sent this week is unaffected: weekly dedupe is keyed
 * on the customer-week message record and the plan snapshot's decision hash,
 * neither of which reads template content.
 *
 * down() is a documented no-op: the superseded version stays archived in
 * email_template_versions and can be re-published from the template editor
 * if the post is ever withdrawn.
 */

const MIGRATION_ID = '20261022190000_irrigation_mowing_crew_note';
const MIGRATION_MARKER = 'migration:20261022190000';
const AUDIT_ACTION = 'email_template.publish';

const WEBSITE_ORIGIN = 'https://www.wavespestcontrol.com';
// The ONE place the post's URL is written.
const MOWING_CREW_URL = `${WEBSITE_ORIGIN}/lawn-care/note-for-your-mowing-crew/`;
const LEAD = 'Who mows your lawn? Forward them this short note so every cut helps your grass:';
const LINK_LABEL = 'A note for whoever mows your lawn';

const NOTE_BLOCK = {
  type: 'paragraph',
  content: `${LEAD} [${LINK_LABEL}](${MOWING_CREW_URL})`,
};
// Plain-text form (library renders markdown links as "label (url)").
const NOTE_TEXT = `${LEAD} ${LINK_LABEL} (${MOWING_CREW_URL})`;

const TEMPLATE_KEYS = [
  'irrigation.weekly_on_track',
  'irrigation.weekly_cut_back',
  'irrigation.weekly_add_water',
  'irrigation.weekly_setup_schedule',
  'irrigation.weekly_setup_system',
  'irrigation.weekly_confirm_schedule',
  'irrigation.weekly_plan',
];

const json = (v) => JSON.stringify(v);
const parse = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; } }
  return null;
};

// A "Helpful guides from the Waves blog" link paragraph, as the guide-resource
// migration (20260907000010) writes them: "[label](https://www.wavespestcontrol.com/...)".
const GUIDE_LINK_BLOCK = new RegExp(`^\\[[^\\]\\n]+\\]\\(${WEBSITE_ORIGIN.replace(/[.]/g, '\\.')}/\\S+\\)$`);
const GUIDE_LINK_TEXT = new RegExp(`\\(${WEBSITE_ORIGIN.replace(/[.]/g, '\\.')}/\\S+\\)\\s*$`);

/**
 * Pure: the block list with the note inserted, or null when it is already
 * there / the list is unusable. Placement, first match wins:
 *  1. directly after the last blog-guide link paragraph (the note is one more
 *     blog link, so it joins that section, after the main advice);
 *  2. before the standing footer (the last small_note, when only sign-offs
 *     follow it);
 *  3. before the first signature;
 *  4. at the end.
 * The live templates are not in seed order (a sign-off sits above the CTA and
 * the guide section follows it), which is why rule 1 keys on the guide links
 * rather than on the signature.
 */
function withNote(blocksValue) {
  const blocks = parse(blocksValue);
  if (!blocks || !blocks.length) return null;
  if (json(blocks).includes(MOWING_CREW_URL)) return null;
  const isGuide = (b) => b && b.type === 'paragraph' && typeof b.content === 'string' && GUIDE_LINK_BLOCK.test(b.content.trim());
  let at = -1;
  blocks.forEach((b, i) => { if (isGuide(b)) at = i + 1; });
  if (at < 0) {
    const lastNote = blocks.map((b) => b && b.type).lastIndexOf('small_note');
    const onlySignaturesAfter = lastNote >= 0 && blocks.slice(lastNote + 1).every((b) => b && b.type === 'signature');
    at = onlySignaturesAfter ? lastNote : blocks.findIndex((b) => b && b.type === 'signature');
  }
  if (at < 0) at = blocks.length;
  return [...blocks.slice(0, at), NOTE_BLOCK, ...blocks.slice(at)];
}

/** Pure: a staff-authored plain-text body with the line added in the same place. */
function withNoteText(text) {
  const body = String(text || '');
  if (body.includes(MOWING_CREW_URL)) return body;
  const paragraphs = body.replace(/\s+$/, '').split(/\n{2,}/);
  let at = -1;
  paragraphs.forEach((p, i) => { if (GUIDE_LINK_TEXT.test(p)) at = i + 1; });
  if (at < 0) at = paragraphs.findIndex((p) => /^\s*(This (tip|plan|check-in) is based on|—|-\s*The Waves Team)/.test(p));
  if (at < 0) return `${paragraphs.join('\n\n')}\n\n${NOTE_TEXT}`;
  return [...paragraphs.slice(0, at), NOTE_TEXT, ...paragraphs.slice(at)].join('\n\n');
}

/**
 * Publish the new version of one template inside one transaction, template
 * row locked first. Returns 'published', 'already', 'missing' or 'skipped'.
 */
async function publishNote(knex, key, { audit = true } = {}) {
  return knex.transaction(async (trx) => {
    // 1. Lock the template row FIRST.
    const template = await trx('email_templates').where({ template_key: key }).forUpdate().first();
    if (!template?.active_version_id) return 'missing';
    // 2. Everything below is read under the lock.
    const prior = await trx('email_template_versions').where({ id: template.active_version_id }).first();
    if (!prior) return 'missing';
    const hasText = prior.text_body != null && String(prior.text_body).trim() !== '';
    const blocks = withNote(prior.blocks);
    const priorHasUrl = json(parse(prior.blocks) || []).includes(MOWING_CREW_URL)
      || String(prior.text_body || '').includes(MOWING_CREW_URL);
    if (priorHasUrl) return 'already';
    if (!blocks) {
      console.warn(`[${MIGRATION_MARKER}] ${key}: active version has no usable blocks; template left as-is`);
      return 'skipped';
    }
    const latest = await trx('email_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'desc')
      .first();
    const now = new Date();
    // 3. Insert the new version (every writer of numbers takes the template
    //    row lock first, so the number is safe).
    const [created] = await trx('email_template_versions').insert({
      template_id: template.id,
      version_number: (latest?.version_number || 0) + 1,
      status: 'active',
      subject: prior.subject,
      preview_text: prior.preview_text,
      blocks: json(blocks),
      text_body: hasText ? withNoteText(prior.text_body) : null,
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
    // 4. Move the pointer (under the lock; the where is belt and braces).
    const moved = await trx('email_templates')
      .where({ id: template.id, active_version_id: prior.id })
      .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
    if (!moved) throw new Error(`[${MIGRATION_MARKER}] ${key}: active pointer moved under the row lock`);
    // 5. Retire only the version this one replaces.
    await trx('email_template_versions')
      .where({ id: prior.id, status: 'active' })
      .update({ status: 'archived', updated_at: now });
    // 6. Audit, same transaction (required lazily so loading this file pulls
    //    in nothing).
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
          reason: 'Monday irrigation email: link the note for the customer\'s mowing crew (owner 2026-10-22)',
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
  for (const key of TEMPLATE_KEYS) await publishNote(knex, key, { audit });
};

// Intentionally a no-op: see the header.
exports.down = async function down() {};

exports.__private = {
  TEMPLATE_KEYS, NOTE_BLOCK, NOTE_TEXT, MOWING_CREW_URL, LEAD, LINK_LABEL, MIGRATION_MARKER, withNote, withNoteText, publishNote,
};
