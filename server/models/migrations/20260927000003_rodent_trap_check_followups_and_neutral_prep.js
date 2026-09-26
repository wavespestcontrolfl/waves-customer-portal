'use strict';

/**
 * Follow-up to 20260927000001 / 20260927000002 (PR #4932 Codex review;
 * both files are already published, so this supersedes rather than edits):
 *
 *  1. pricing_config.rodent_trapping: 000001 only moved 'unlimited' → 1.
 *     Any OTHER included_followups value (an admin-typed number) would keep
 *     the engine promising that many included checks while the booking
 *     advisory enforces one. Every non-1 value becomes 1 here
 *     (read-modify-write, audit row; down() restores the recorded prior).
 *  2. prep.rodent: 000002's line said further checks "are billed
 *     separately", but the guide is one active version for every rodent
 *     job, including grandfathered jobs whose checks are all included. The
 *     line becomes version-neutral. The version mechanics mirror 000002
 *     (clone to a new active version, prior archived, marker-stamped).
 *     Value-guarded: only the exact 000002 line is replaced. No dollar
 *     amount and no "per visit" wording (guide compliance rules).
 */

const MIGRATION_MARKER = 'migration:20260927000003';
const STATE_KEY = 'migration.20260927000003.state';
const TEMPLATE_KEY = 'prep.rodent';
const UP_REASON = 'Rodent trapping: every included_followups value → 1 (setup + 1 trap check; owner ruling 2026-09-26)';

const PRIOR_LINE = require('./20260927000002_prep_guide_rodent_trap_check_copy').NEW_LINE;
const NEUTRAL_LINE = 'Your trapping service includes a follow-up visit to check, reset and reposition traps. Rodents are wary of new objects, so placement often gets adjusted on that visit. If the job may need more trap checks than your service includes, your technician will talk it through with you before booking one.';

function parseData(row) {
  if (!row) return null;
  try { return typeof row.data === 'string' ? JSON.parse(row.data) : row.data; } catch { return null; }
}

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

async function loadState(knex) {
  if (!(await knex.schema.hasTable('system_settings'))) return null;
  const row = await knex('system_settings').where({ key: STATE_KEY }).first();
  if (!row) return null;
  try { return JSON.parse(row.value); } catch { return null; }
}

async function saveState(knex, state) {
  if (!(await knex.schema.hasTable('system_settings'))) return;
  const value = JSON.stringify(state);
  const updated = await knex('system_settings').where({ key: STATE_KEY }).update({ value });
  if (!updated) await knex('system_settings').insert({ key: STATE_KEY, value });
}

async function upPricing(knex) {
  if (!(await knex.schema.hasTable('pricing_config'))) return null;
  const row = await knex('pricing_config').where({ config_key: 'rodent_trapping' }).first();
  const data = parseData(row);
  if (!data || typeof data !== 'object') return null;
  if (data.included_followups == null || Number(data.included_followups) === 1) return null;
  const newData = { ...data, included_followups: 1 };
  await knex('pricing_config').where({ config_key: 'rodent_trapping' }).update({
    data: JSON.stringify(newData),
    updated_at: knex.fn.now(),
  });
  if (await knex.schema.hasTable('pricing_config_audit')) {
    await knex('pricing_config_audit').insert({
      config_key: 'rodent_trapping',
      old_value: JSON.stringify(data),
      new_value: JSON.stringify(newData),
      changed_by: MIGRATION_MARKER,
      reason: UP_REASON,
    });
  }
  return { priorIncludedFollowups: data.included_followups };
}

async function upPrep(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template?.active_version_id) return;
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return;
  const blocksJson = typeof prior.blocks === 'string' ? prior.blocks : JSON.stringify(prior.blocks);
  const oldJson = JSON.stringify(PRIOR_LINE);
  if (!blocksJson.includes(oldJson)) return;
  const newBlocks = blocksJson.split(oldJson).join(JSON.stringify(NEUTRAL_LINE));

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
}

exports.PRIOR_LINE = PRIOR_LINE;
exports.NEUTRAL_LINE = NEUTRAL_LINE;
exports.MIGRATION_MARKER = MIGRATION_MARKER;

exports.up = async function up(knex) {
  if (!(await loadState(knex))) {
    const pricing = await upPricing(knex);
    await saveState(knex, { tag: MIGRATION_MARKER, pricing });
  }
  await upPrep(knex);
};

exports.down = async function down(knex) {
  const state = await loadState(knex);
  if (state?.pricing && await knex.schema.hasTable('pricing_config')) {
    const row = await knex('pricing_config').where({ config_key: 'rodent_trapping' }).first();
    const data = parseData(row);
    if (data && Number(data.included_followups) === 1) {
      const restored = { ...data, included_followups: state.pricing.priorIncludedFollowups };
      await knex('pricing_config').where({ config_key: 'rodent_trapping' }).update({
        data: JSON.stringify(restored),
        updated_at: knex.fn.now(),
      });
      if (await knex.schema.hasTable('pricing_config_audit')) {
        await knex('pricing_config_audit').insert({
          config_key: 'rodent_trapping',
          old_value: JSON.stringify(data),
          new_value: JSON.stringify(restored),
          changed_by: MIGRATION_MARKER,
          reason: 'Rollback: restore the prior included_followups (20260927000003)',
        });
      }
    }
  }
  if (state && await knex.schema.hasTable('system_settings')) {
    await knex('system_settings').where({ key: STATE_KEY }).del();
  }

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
