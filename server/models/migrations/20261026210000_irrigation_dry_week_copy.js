'use strict';

/**
 * Monday irrigation email: two phrases that read oddly (owner 2026-10-26,
 * "FIX THIS"):
 *
 *  1. A dry week opened with "About 0" of rain fell near your home last week"
 *     and the inbox preview said "About 0" of rain near your home — …". The
 *     sender now builds both as whole sentences, {{rain_sentence}} and
 *     {{rain_preview}} ("No measurable rain fell near your home last week." /
 *     "About 0.42" of rain fell near your home last week."), so the template
 *     only places them.
 *  2. With no grass type on file the details row read "Weekly target for
 *     lawn". The row now reads "Weekly target for your {{grass_label}}"
 *     ("your St. Augustine", "your lawn"), the same phrasing the body already
 *     uses ("your {{grass_label}} needs roughly …").
 *
 * WHERE THE COPY LIVES. The bodies are email_template_versions rows (seeded
 * by migration, edited by migration and by the office editor). Each changed
 * template gets a new active version, exactly as the mowing-crew note
 * (20261022190000) did: template row locked FOR UPDATE first and everything
 * read under the lock (an office edit made before the lock wins); the prior
 * version is archived, never overwritten; one audit_log row per published
 * template, same transaction.
 *
 * Exact-match edits only. Each change applies only where the active version
 * still carries the seeded wording, so a staff rewording is left alone and a
 * re-run finds nothing to do (no new version):
 *  - preview_text starting `About {{rain_last_week}}" of rain near your home — `
 *    → `{{rain_preview}} ` + the rest, first letter capitalised;
 *  - a paragraph block starting
 *    `About {{rain_last_week}}" of rain fell near your home last week. `
 *    → `{{rain_sentence}} ` + the rest;
 *  - a details row labelled `Weekly target for {{grass_label}}` → the new label;
 *  - a staff-authored text body gets the same sentence and label edits (it wins
 *    over block-derived text at render time).
 *
 * The two new variables are OPTIONAL (allowed, never required), the
 * 20260825000001 precedent: this migration runs before the new app version
 * serves, and the old sender does not supply them. An empty optional variable
 * renders as nothing, so in that window the dry-week sentence is simply absent
 * and the preview reads "Here's how that compares to what your lawn needs."
 * — never a refused send. An EMPTY allowed_variables list means "no
 * restriction" to the library, so it is left empty rather than turned into a
 * one-entry allowlist that would reject every other variable.
 *
 * Nothing else changes: subject, other blocks, send conditions, recipients.
 * No send is triggered. down() is a documented no-op: the superseded versions
 * stay archived in email_template_versions and can be re-published from the
 * template editor.
 */

const MIGRATION_ID = '20261026210000_irrigation_dry_week_copy';
const MIGRATION_MARKER = 'migration:20261026210000';
const AUDIT_ACTION = 'email_template.publish';

const TEMPLATE_KEYS = [
  'irrigation.weekly_on_track',
  'irrigation.weekly_cut_back',
  'irrigation.weekly_add_water',
  'irrigation.weekly_setup_schedule',
  'irrigation.weekly_setup_system',
  'irrigation.weekly_rain_report',
  'irrigation.weekly_confirm_schedule',
  'irrigation.weekly_plan',
];

const PREVIEW_PREFIX = 'About {{rain_last_week}}" of rain near your home — ';
const SENTENCE_PREFIX = 'About {{rain_last_week}}" of rain fell near your home last week. ';
const TARGET_LABEL = 'Weekly target for {{grass_label}}';
const TARGET_LABEL_NEW = 'Weekly target for your {{grass_label}}';
const RAIN_SENTENCE_VAR = 'rain_sentence';
const RAIN_PREVIEW_VAR = 'rain_preview';

// Editor preview values for the template fixtures (a sample week, never a customer's).
const FIXTURE_VALUES = {
  [RAIN_SENTENCE_VAR]: 'About 0.42" of rain fell near your home last week.',
  [RAIN_PREVIEW_VAR]: 'About 0.42" of rain near your home.',
};

const json = (v) => JSON.stringify(v);
const parseList = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') { try { const p = JSON.parse(v); return Array.isArray(p) ? p : null; } catch { return null; } }
  return null;
};

/** Pure: the new preview, or null when it does not start with the seeded wording. */
function withPreview(preview) {
  const p = String(preview || '');
  if (!p.startsWith(PREVIEW_PREFIX)) return null;
  const rest = p.slice(PREVIEW_PREFIX.length);
  return `{{${RAIN_PREVIEW_VAR}}} ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

/**
 * Pure: { blocks, uses } — the edited block list (null when nothing changed or
 * the list is unusable) and which new variables it references.
 */
function withBlocks(blocksValue) {
  const blocks = parseList(blocksValue);
  if (!blocks || !blocks.length) return { blocks: null, uses: [] };
  let changed = false;
  const uses = new Set();
  const next = blocks.map((b) => {
    if (b && b.type === 'paragraph' && typeof b.content === 'string' && b.content.startsWith(SENTENCE_PREFIX)) {
      changed = true;
      uses.add(RAIN_SENTENCE_VAR);
      return { ...b, content: `{{${RAIN_SENTENCE_VAR}}} ${b.content.slice(SENTENCE_PREFIX.length)}` };
    }
    if (b && b.type === 'details' && Array.isArray(b.rows) && b.rows.some((r) => r && r.label === TARGET_LABEL)) {
      changed = true;
      return { ...b, rows: b.rows.map((r) => (r && r.label === TARGET_LABEL ? { ...r, label: TARGET_LABEL_NEW } : r)) };
    }
    return b;
  });
  return { blocks: changed ? next : null, uses: [...uses] };
}

/** Pure: a staff-authored plain-text body with the same edits (unchanged text comes back as is). */
function withText(text) {
  return String(text || '')
    .split(SENTENCE_PREFIX).join(`{{${RAIN_SENTENCE_VAR}}} `)
    .split(TARGET_LABEL).join(TARGET_LABEL_NEW);
}

/** Pure: the list with `name` added, or the list unchanged when it is empty (empty = no restriction) or has it. */
function withAllowed(listValue, name) {
  const list = parseList(listValue) || [];
  if (!list.length || list.includes(name)) return list;
  return [...list, name];
}

/** Pure: an optional-variables list with `name` added (an empty list is a list here, not "everything"). */
function withOptional(listValue, name) {
  const list = parseList(listValue) || [];
  return list.includes(name) ? list : [...list, name];
}

/**
 * Publish the new version of one template inside one transaction, template
 * row locked first. Returns 'published', 'already' or 'missing'.
 */
async function publishCopy(knex, key, { audit = true, fixtures = true } = {}) {
  return knex.transaction(async (trx) => {
    // 1. Lock the template row FIRST.
    const template = await trx('email_templates').where({ template_key: key }).forUpdate().first();
    if (!template?.active_version_id) return 'missing';
    // 2. Everything below is read under the lock.
    const prior = await trx('email_template_versions').where({ id: template.active_version_id }).first();
    if (!prior) return 'missing';
    const preview = withPreview(prior.preview_text);
    const { blocks, uses } = withBlocks(prior.blocks);
    const hasText = prior.text_body != null && String(prior.text_body).trim() !== '';
    const text = hasText ? withText(prior.text_body) : null;
    const textChanged = hasText && text !== prior.text_body;
    if (preview == null && blocks == null && !textChanged) return 'already';

    const vars = new Set(uses);
    if (preview != null) vars.add(RAIN_PREVIEW_VAR);
    if (textChanged && text.includes(`{{${RAIN_SENTENCE_VAR}}}`)) vars.add(RAIN_SENTENCE_VAR);

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
      preview_text: preview != null ? preview : prior.preview_text,
      blocks: json(blocks != null ? blocks : (parseList(prior.blocks) || [])),
      text_body: hasText ? text : prior.text_body,
      validation_snapshot: json({
        ok: true,
        source: MIGRATION_MARKER,
        supersedes_version: prior.version_number,
        referenced_variables: [...vars].sort(),
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
    // 6. The new variables are allowed (send-time validation rejects a referenced
    //    variable missing from a non-empty allowlist) and optional, never required.
    if (vars.size) {
      let allowed = parseList(template.allowed_variables) || [];
      let optional = parseList(template.optional_variables) || [];
      for (const name of vars) {
        allowed = withAllowed(allowed, name);
        optional = withOptional(optional, name);
      }
      await trx('email_templates').where({ id: template.id })
        .update({ allowed_variables: json(allowed), optional_variables: json(optional), updated_at: now });
      if (fixtures) {
        const rows = await trx('email_template_fixtures').where({ template_id: template.id }).select('id', 'payload');
        for (const f of rows) {
          const payload = typeof f.payload === 'string' ? JSON.parse(f.payload || '{}') : (f.payload || {});
          let touched = false;
          for (const name of vars) {
            if (payload[name] === undefined) { payload[name] = FIXTURE_VALUES[name]; touched = true; }
          }
          if (touched) await trx('email_template_fixtures').where({ id: f.id }).update({ payload: json(payload) });
        }
      }
    }
    // 7. Audit, same transaction (required lazily so loading this file pulls
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
          reason: 'Monday irrigation email: "No measurable rain" on a dry week and "Weekly target for your …" (owner 2026-10-26)',
          added_variables: [...vars].sort(),
          edits: {
            preview: preview != null ? { before: prior.preview_text, after: preview } : null,
            opening_sentence: uses.includes(RAIN_SENTENCE_VAR) ? { before: SENTENCE_PREFIX.trim(), after: `{{${RAIN_SENTENCE_VAR}}}` } : null,
            target_label: blocks != null && json(blocks).includes(TARGET_LABEL_NEW) && !json(parseList(prior.blocks) || []).includes(TARGET_LABEL_NEW)
              ? { before: TARGET_LABEL, after: TARGET_LABEL_NEW } : null,
            text_body: textChanged,
          },
        },
      });
    }
    return 'published';
  });
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const audit = await knex.schema.hasTable('audit_log');
  const fixtures = await knex.schema.hasTable('email_template_fixtures');
  for (const key of TEMPLATE_KEYS) await publishCopy(knex, key, { audit, fixtures });
};

// Intentionally a no-op: see the header.
exports.down = async function down() {};

exports.__private = {
  TEMPLATE_KEYS, PREVIEW_PREFIX, SENTENCE_PREFIX, TARGET_LABEL, TARGET_LABEL_NEW, RAIN_SENTENCE_VAR, RAIN_PREVIEW_VAR,
  FIXTURE_VALUES, MIGRATION_MARKER, withPreview, withBlocks, withText, withAllowed, withOptional, publishCopy,
};
