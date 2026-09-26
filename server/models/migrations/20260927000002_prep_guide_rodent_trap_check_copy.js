'use strict';

/**
 * prep.rodent copy: trap checks are no longer open-ended (owner ruling
 * 2026-09-26 — the $350 trapping plan covers the setup visit plus ONE trap
 * check; further checks are billed separately).
 *
 * The v3 guide (20260924000001) says "Follow-up visits to check, reset and
 * reposition traps are part of the service." That line is replaced; nothing
 * else in the guide changes. Mechanics mirror 20260924000001: the active
 * version is cloned into a NEW active version (prior archived, never
 * edited), stamped with MIGRATION_MARKER so down() restores exactly the
 * version it displaced. Value-guarded: only an active version that still
 * carries the exact v3 line is touched — an admin rewrite is left alone.
 * No dollar amount and no "per visit" wording (guide compliance rules).
 */

const MIGRATION_MARKER = 'migration:20260927000002';
const TEMPLATE_KEY = 'prep.rodent';

const OLD_LINE = 'Follow-up visits to check, reset and reposition traps are part of the service. Rodents are wary of new objects, so placement often gets adjusted on the second visit.';
const NEW_LINE = 'Your trapping service includes a follow-up visit to check, reset and reposition traps. Rodents are wary of new objects, so placement often gets adjusted on that second visit. If the job needs more trap checks after that, they are billed separately, and your technician will talk it through with you before booking one.';

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

exports.OLD_LINE = OLD_LINE;
exports.NEW_LINE = NEW_LINE;
exports.MIGRATION_MARKER = MIGRATION_MARKER;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template?.active_version_id) return;
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return;
  const blocksJson = typeof prior.blocks === 'string' ? prior.blocks : JSON.stringify(prior.blocks);
  const oldJson = JSON.stringify(OLD_LINE);
  if (!blocksJson.includes(oldJson)) return;
  const newBlocks = blocksJson.split(oldJson).join(JSON.stringify(NEW_LINE));

  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const now = new Date();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: prior.subject,
    preview_text: prior.preview_text,
    blocks: newBlocks,
    text_body: prior.text_body ?? null,
    validation_snapshot: JSON.stringify({
      ok: true,
      source: MIGRATION_MARKER,
      referenced_variables: [],
      disallowed_variables: [],
      missing_required_in_template: [],
    }),
    published_at: now,
  }).returning('*');
  await knex('email_template_versions')
    .where({ template_id: template.id })
    .whereNot({ id: version.id })
    .where({ status: 'active' })
    .update({ status: 'archived', updated_at: now });
  await knex('email_templates').where({ id: template.id }).update({
    active_version_id: version.id,
    last_published_at: now,
    updated_at: now,
  });
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template?.active_version_id) return;
  const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!current || snapshotSource(current) !== MIGRATION_MARKER) return;
  const prior = await knex('email_template_versions')
    .where({ template_id: template.id, status: 'archived' })
    .where('version_number', '<', current.version_number)
    .orderBy('version_number', 'desc')
    .first();
  if (!prior) return;
  const now = new Date();
  await knex('email_template_versions').where({ id: prior.id }).update({ status: 'active', updated_at: now });
  await knex('email_template_versions').where({ id: current.id }).update({ status: 'archived', updated_at: now });
  await knex('email_templates').where({ id: template.id }).update({ active_version_id: prior.id, updated_at: now });
};
