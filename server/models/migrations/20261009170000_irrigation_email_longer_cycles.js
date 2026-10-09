'use strict';

/**
 * Monday irrigation email: the two legacy callout lines pushed the wrong way
 * (owner 2026-10-09, "fix the email").
 *
 * Waves' watering advice is deep and infrequent: fewer, longer runs on the
 * days the order allows (the week-plan email, the report tip library and the
 * irrigation runtime all say so). Two lines in the pre-plan advice templates
 * said the opposite:
 *
 *   irrigation.weekly_cut_back  (surplus):
 *     "...skip a watering day or trim a few minutes off each zone."
 *       -> trimming minutes makes runs SHORTER.
 *   irrigation.weekly_add_water (deficit / dry week ahead):
 *     "...add a few minutes per zone, or one extra watering day if your
 *      county's restrictions allow it."
 *       -> an extra day is MORE days, and under the SWFWMD one-day order it
 *          can put a customer over the limit.
 *
 * These templates send only while the week plan cannot (no restriction policy
 * covers the customer's county, a late Monday retry, a plan fallback), so the
 * fix is two exact-match text patches over each template's CURRENT active
 * version, published as a new active version (the 20260926120100 pattern; its
 * applyPatches is reused as is). A patch that does not match exactly once (an
 * administrator edited the line in the template editor) leaves that template
 * whole and logs it; the office-edited copy is never overwritten. Nothing
 * else changes: not the subject, the preview, the other blocks, the send
 * conditions, the schedule or the recipients.
 *
 * Idempotent and compatible with the hand-run SQL twin
 * (~/irrigation-email-lines.sql): a template that already holds the new text
 * is left alone.
 *
 * down() restores the version this migration superseded, but only while this
 * migration's version is still the active one (a later administrator publish
 * wins and is left alone).
 */

const { applyPatches } = require('./20260926120100_customer_copy_audit_email');

const MIGRATION_MARKER = 'migration:20261009170000';

const PATCHES = [
  {
    key: 'irrigation.weekly_cut_back',
    field: 'content',
    from: 'This week: skip a watering day or trim a few minutes off each zone.',
    to: 'This week: skip a watering day. Don\'t shorten the runs on your other days — longer runs reach the roots better than short ones.',
  },
  {
    key: 'irrigation.weekly_add_water',
    field: 'content',
    from: 'This week: add a few minutes per zone, or one extra watering day if your county\'s restrictions allow it.',
    to: 'This week: add a few minutes per zone on your allowed watering days. Longer runs reach the roots better than short ones.',
  },
];

const KEYS = [...new Set(PATCHES.map((p) => p.key))];

const json = (v) => JSON.stringify(v);
const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

function blocksText(blocks) {
  return (blocks || []).flatMap((b) => [b.content, ...(b.items || []), ...(b.rows || []).map((r) => r.value)])
    .filter((s) => typeof s === 'string').join('\n');
}

async function publishPatched(knex, key) {
  const template = await knex('email_templates').where({ template_key: key }).first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';
  const patches = PATCHES.filter((p) => p.key === key);
  // Already holds the new text (this migration ran, or the SQL twin did).
  if (patches.every((p) => blocksText(parse(prior.blocks)).includes(p.to))) return 'already';
  // A staff-authored plain-text body would be replaced by the renderer's
  // generated text (text_body: null below); leave such a template whole.
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MIGRATION_MARKER}] ${key}: custom plain-text body present; template left as-is`);
    return 'skipped';
  }
  const { version, misses } = applyPatches(prior, patches);
  if (misses.length) {
    console.warn(`[${MIGRATION_MARKER}] ${key}: ${misses.length} patch(es) no longer match; template left as-is`);
    return 'skipped';
  }
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const now = new Date();
  // Savepoint: the admin editor allocates draft version numbers the same way
  // (max + 1, no lock), so a draft created mid-deploy can take this number.
  // A unique-violation then skips this template instead of aborting the whole
  // migration transaction.
  let created;
  try {
    created = await knex.transaction(async (sp) => {
      const [row] = await sp('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: version.subject,
        preview_text: version.preview_text,
        blocks: json(version.blocks),
        text_body: null,
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
      return row;
    });
  } catch (err) {
    if (err?.code !== '23505') throw err;
    console.warn(`[${MIGRATION_MARKER}] ${key}: version number taken by a concurrent draft; template left as-is`);
    return 'raced';
  }
  // CAS on the version we patched, BEFORE touching any other version's
  // status: a concurrent admin publish wins and its version stays active.
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: prior.id })
    .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
  if (!moved) {
    await knex('email_template_versions').where({ id: created.id }).update({ status: 'archived', updated_at: now });
    return 'raced';
  }
  // Won: retire only the version this one replaces.
  await knex('email_template_versions')
    .where({ id: prior.id, status: 'active' })
    .update({ status: 'archived', updated_at: now });
  return 'published';
}

exports.PATCHES = PATCHES;
exports.KEYS = KEYS;
exports.MIGRATION_MARKER = MIGRATION_MARKER;
exports._publishPatched = publishPatched;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const key of KEYS) await publishPatched(knex, key);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  const now = new Date();
  for (const key of KEYS) {
    const template = await knex('email_templates').where({ template_key: key }).first();
    if (!template?.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
    const snap = current && parse(current.validation_snapshot);
    if (snap?.source !== MIGRATION_MARKER) continue; // an admin published since; leave it
    const prior = await knex('email_template_versions')
      .where({ template_id: template.id, version_number: snap.supersedes_version })
      .first();
    if (!prior) continue;
    // Pointer CAS first, as in up(): an administrator publish that lands
    // after the marker check wins, and no version statuses change.
    const moved = await knex('email_templates')
      .where({ id: template.id, active_version_id: current.id })
      .update({ active_version_id: prior.id, updated_at: now });
    if (!moved) continue;
    await knex('email_template_versions').where({ id: prior.id }).update({ status: 'active', updated_at: now });
    await knex('email_template_versions').where({ id: current.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  }
};
