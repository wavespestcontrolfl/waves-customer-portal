'use strict';

/**
 * Monday irrigation email: longer runs on fewer days, never shorter runs or an
 * extra day (owner 2026-10-09, "fix the email").
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
 * version, published as a new active version. `applyPatches` from the
 * 20260926120100 migration is reused: it is a pure function over a version
 * object and issues no queries, so its lock order is not in play here. (That
 * migration's own publisher inserts its version BEFORE locking the template
 * row; this one does not copy it.)
 *
 * Lock order (the established publisher's, email-template-library.js
 * createDraftVersion / publishVersion): the template row is locked FOR UPDATE
 * FIRST, then the active version and the highest version number are read,
 * then the new version is inserted, then the pointer moves. The admin editor
 * allocates draft numbers under the same row lock, so an administrator
 * draft and this migration can never take the same number or wait on each
 * other in a cycle. Everything after the lock is re-read from under it: an
 * office edit made before the lock is seen, and wins (old sentence no longer
 * present exactly once -> that template is left whole and logged).
 *
 * The library's own publishVersion is NOT reused: it needs an existing draft,
 * runs on the app's separate db handle (it would wait on the row lock this
 * migration holds), archives every active row, and pulls the whole mailer
 * dependency tree into a migration.
 *
 * Each template this migration actually publishes writes one audit_log row
 * (recordAuditEvent, system actor, same transaction, critical so a lost audit
 * write aborts the publish). Skipped templates record nothing.
 *
 * Nothing else changes: not the subject, the preview, the other blocks, the
 * send conditions, the schedule or the recipients. Idempotent, and compatible
 * with the hand-run SQL twin (~/irrigation-email-lines.sql).
 *
 * down() is a documented no-op. Rolling this migration back must never
 * republish "one extra watering day" or "trim a few minutes off each zone".
 * The superseded version stays in email_template_versions (status
 * 'archived'); an operator who really wants the old wording can re-publish it
 * from the template editor.
 */

const { applyPatches } = require('./20260926120100_customer_copy_audit_email');

const MIGRATION_ID = '20261009171000_irrigation_email_longer_runs';
const MIGRATION_MARKER = 'migration:20261009171000';
const AUDIT_ACTION = 'email_template.publish';

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

/**
 * Publish the patched copy of one template inside one transaction, in the
 * established row-first order. Returns 'published', 'already', 'skipped' or
 * 'missing'.
 */
async function publishPatched(knex, key, { audit = true } = {}) {
  const patches = PATCHES.filter((p) => p.key === key);
  return knex.transaction(async (trx) => {
    // 1. Lock the template row FIRST.
    const template = await trx('email_templates').where({ template_key: key }).forUpdate().first();
    if (!template?.active_version_id) return 'missing';
    // 2. Everything below is read under the lock.
    const prior = await trx('email_template_versions').where({ id: template.active_version_id }).first();
    if (!prior) return 'missing';
    // Already holds the new text (this migration ran, or the SQL twin did).
    if (patches.every((p) => blocksText(parse(prior.blocks)).includes(p.to))) return 'already';
    // A staff-authored plain-text body would be replaced by the renderer's
    // generated text (text_body: null below); leave such a template whole.
    if (prior.text_body != null && String(prior.text_body).trim()) {
      console.warn(`[${MIGRATION_MARKER}] ${key}: custom plain-text body present; template left as-is`);
      return 'skipped';
    }
    // Office edit wins: the old sentence must still be there exactly once.
    const { version, misses } = applyPatches(prior, patches);
    if (misses.length) {
      console.warn(`[${MIGRATION_MARKER}] ${key}: ${misses.length} patch(es) no longer match; template left as-is`);
      return 'skipped';
    }
    const latest = await trx('email_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'desc')
      .first();
    const now = new Date();
    // 3. Insert the new version (number is safe: every writer of numbers
    //    takes the template row lock first).
    const [created] = await trx('email_template_versions').insert({
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
    // 4. Move the pointer (still under the lock; the where is belt and braces).
    const moved = await trx('email_templates')
      .where({ id: template.id, active_version_id: prior.id })
      .update({ active_version_id: created.id, last_published_at: now, updated_at: now });
    if (!moved) throw new Error(`[${MIGRATION_MARKER}] ${key}: active pointer moved under the row lock`);
    // 5. Retire only the version this one replaces.
    await trx('email_template_versions')
      .where({ id: prior.id, status: 'active' })
      .update({ status: 'archived', updated_at: now });
    // 6. Audit, same transaction. Required lazily so merely loading this
    //    file (tests, the migration guard) pulls in nothing.
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
          reason: 'Monday irrigation email: longer runs on fewer days, no shorter runs or extra watering day (owner 2026-10-09)',
          replaced_sentence: patches.map((p) => p.from),
          new_sentence: patches.map((p) => p.to),
        },
      });
    }
    return 'published';
  });
}

exports.PATCHES = PATCHES;
exports.KEYS = KEYS;
exports.MIGRATION_ID = MIGRATION_ID;
exports.MIGRATION_MARKER = MIGRATION_MARKER;
exports.AUDIT_ACTION = AUDIT_ACTION;
exports._publishPatched = publishPatched;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const audit = await knex.schema.hasTable('audit_log');
  for (const key of KEYS) await publishPatched(knex, key, { audit });
};

// Intentionally a no-op: see the header. The archived prior version keeps the
// old wording for an operator who needs it; a rollback must not put "one
// extra watering day" back in front of customers.
exports.down = async function down() {};
