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
 * template gets a new active version, as the mowing-crew note
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

const MIGRATION_ID = '20261026230000_irrigation_dry_week_copy';
const MIGRATION_MARKER = 'migration:20261026230000';
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
const RAIN_PREVIEW_VAR = 'rain_preview';
const RAIN_SENTENCE_VAR = 'rain_sentence';
const NEW_VARS = [RAIN_PREVIEW_VAR, RAIN_SENTENCE_VAR];

// Editor preview values for the template fixtures (a sample week, never a customer's).
const FIXTURE_VALUES = {
  [RAIN_PREVIEW_VAR]: 'About 0.42" of rain near your home.',
  [RAIN_SENTENCE_VAR]: 'About 0.42" of rain fell near your home last week.',
};

const json = (v) => JSON.stringify(v);
// A jsonb list as read (pg hands back the array, a test double the JSON text); anything else is [].
const parseList = (v) => {
  if (Array.isArray(v)) return v;
  try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
};

/** Pure: the preview with the amount moved into {{rain_preview}}; any other preview comes back as is. */
function withPreview(preview) {
  const p = String(preview);
  if (!p.startsWith(PREVIEW_PREFIX)) return preview;
  const rest = p.slice(PREVIEW_PREFIX.length);
  return `{{${RAIN_PREVIEW_VAR}}} ${rest.charAt(0).toUpperCase()}${rest.slice(1)}`;
}

/** Pure: the blocks with the opening sentence and the target row edited; every other block as is. */
function withBlocks(blocks) {
  return blocks.map((b) => {
    if (b?.type === 'paragraph' && typeof b.content === 'string' && b.content.startsWith(SENTENCE_PREFIX)) {
      return { ...b, content: `{{${RAIN_SENTENCE_VAR}}} ${b.content.slice(SENTENCE_PREFIX.length)}` };
    }
    if (b?.type !== 'details' || !Array.isArray(b.rows)) return b;
    return { ...b, rows: b.rows.map((r) => (r?.label === TARGET_LABEL ? { ...r, label: TARGET_LABEL_NEW } : r)) };
  });
}

/** Pure: a staff-authored plain-text body with the same edits (no body, or no match, comes back as is). */
function withText(text) {
  if (typeof text !== 'string') return text;
  return text.split(SENTENCE_PREFIX).join(`{{${RAIN_SENTENCE_VAR}}} `).split(TARGET_LABEL).join(TARGET_LABEL_NEW);
}

/**
 * Publish the new version of one template inside one transaction, template
 * row locked first. Returns 'published', 'already' or 'missing'.
 */
async function publishCopy(knex, key) {
  return knex.transaction(async (trx) => {
    // 1. Lock the template row FIRST; everything below is read under the lock.
    const template = await trx('email_templates').where({ template_key: key }).forUpdate().first();
    const prior = template && await trx('email_template_versions').where({ id: template.active_version_id }).first();
    if (!prior) return 'missing';
    const before = { preview_text: prior.preview_text, blocks: parseList(prior.blocks), text_body: prior.text_body };
    const after = { preview_text: withPreview(before.preview_text), blocks: withBlocks(before.blocks), text_body: withText(before.text_body) };
    const changedFields = Object.keys(before).filter((field) => json(before[field]) !== json(after[field]));
    if (!changedFields.length) return 'already';
    // The new variables this version places. Send-time validation rejects a referenced variable
    // missing from a non-empty allowlist, so they are allowed, and optional, never required.
    const vars = NEW_VARS.filter((name) => json(after).includes(`{{${name}}}`));

    const latest = await trx('email_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'desc')
      .first();
    const now = new Date();
    // 2. Insert the new version (every writer of numbers takes the template
    //    row lock first, so the number is safe).
    const [created] = await trx('email_template_versions').insert({
      template_id: template.id,
      version_number: latest.version_number + 1,
      status: 'active',
      subject: prior.subject,
      preview_text: after.preview_text,
      blocks: json(after.blocks),
      text_body: after.text_body,
      validation_snapshot: json({
        ok: true,
        source: MIGRATION_MARKER,
        supersedes_version: prior.version_number,
        referenced_variables: vars,
        disallowed_variables: [],
        missing_required_in_template: [],
      }),
      published_at: now,
    }).returning('*');
    // 3. Move the pointer (held by the row lock since step 1) and allow the new
    //    variables. An EMPTY allowlist means "no restriction" and stays empty.
    const allowed = parseList(template.allowed_variables);
    await trx('email_templates').where({ id: template.id }).update({
      active_version_id: created.id,
      allowed_variables: json(allowed.length ? [...new Set([...allowed, ...vars])] : allowed),
      optional_variables: json([...new Set([...parseList(template.optional_variables), ...vars])]),
      last_published_at: now,
      updated_at: now,
    });
    // 4. Retire only the version this one replaces.
    await trx('email_template_versions')
      .where({ id: prior.id, status: 'active' })
      .update({ status: 'archived', updated_at: now });
    // 5. Editor preview values for the new variables; a value a fixture already has wins.
    const sample = Object.fromEntries(vars.map((name) => [name, FIXTURE_VALUES[name]]));
    const fixtures = await trx('email_template_fixtures').where({ template_id: template.id }).select('id', 'payload');
    for (const f of fixtures) {
      await trx('email_template_fixtures').where({ id: f.id }).update({ payload: json({ ...sample, ...f.payload }) });
    }
    // 6. Audit, same transaction (required lazily so loading this file pulls
    //    in nothing).
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
        changes: Object.fromEntries(changedFields.map((field) => [field, { before: before[field], after: after[field] }])),
        added_variables: vars,
      },
    });
    return 'published';
  });
}

// The template tables (fixtures included) come from 20260518000001; audit_log
// (20260419000005) is older, so both exist wherever email_templates does.
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  for (const key of TEMPLATE_KEYS) await publishCopy(knex, key);
};

// Intentionally a no-op: see the header.
exports.down = async function down() {};

exports.__private = {
  TEMPLATE_KEYS, FIXTURE_VALUES, withPreview, withBlocks, withText, publishCopy,
};
