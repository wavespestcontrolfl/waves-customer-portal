'use strict';

/**
 * Lawn prep guide revision — round-2 corrections (PR #5420).
 *
 * 20260930120001 is frozen (it ran on the PR preview database on push). Same
 * supersession pattern: exact-match text patches over 000001's effective
 * TEMPLATES, published as a NEW active version of prep.lawn. The migration
 * test reads THIS file's TEMPLATES as the content customers receive.
 *
 *  prep.lawn also goes to one-time lawn treatment visits
 *  (prep-guide-sender.js sends it for every lawn service but dethatching,
 *  plugging, top dressing and inspections), and a one-time treatment carries
 *  no re-service and no next visit. The aftercare line and the "how fast"
 *  answer drop those recurring-program promises.
 *  Codex r2 P1: EPA registration covers pesticides, not fertilizer (the
 *  catalog records LESCO 24-0-11 as not EPA-registered) — the claim now
 *  names pesticides.
 */

const base = require('./20260930120001_prep_lawn_guide_revision_codex_r1');

const json = (v) => JSON.stringify(v);

const MIGRATION_MARKER = 'migration:20260930120002';

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

// Exact-match text patches over the 000001 content. `from` must occur
// exactly once across the named template's text fields.
const PATCHES = [
  {
    key: 'prep.lawn',
    from: 'That is an immediate look, not wait-and-see, and there is no waiting period for a re-service.',
    to: 'That is an immediate look, not wait-and-see.',
  },
  {
    key: 'prep.lawn',
    from: 'Every product we apply is EPA-registered and used by its label,',
    to: 'Every pesticide we apply is EPA-registered, and every product is used by its label,',
  },
  {
    key: 'prep.lawn',
    from: 'Your technician tells you which case you have and what to watch for by the next visit.',
    to: 'Your technician tells you which case you have and what to watch for.',
  },
];

function patchText(text, from, to, hits) {
  if (typeof text !== 'string' || !text.includes(from)) return text;
  hits.count += text.split(from).length - 1;
  return text.split(from).join(to);
}

function applyPatch(template, patch) {
  const hits = { count: 0 };
  const blocks = template.blocks.map((block) => {
    const b = { ...block };
    if (typeof b.content === 'string') b.content = patchText(b.content, patch.from, patch.to, hits);
    if (Array.isArray(b.rows)) {
      b.rows = b.rows.map((row) => ({
        ...row,
        label: patchText(row.label, patch.from, patch.to, hits),
        value: patchText(row.value, patch.from, patch.to, hits),
      }));
    }
    return b;
  });
  if (hits.count !== 1) {
    throw new Error(`${MIGRATION_MARKER}: patch for ${patch.key} matched ${hits.count} times (expected 1): ${patch.from.slice(0, 60)}`);
  }
  return { ...template, blocks };
}

const TEMPLATES = base.TEMPLATES.map((template) => PATCHES
  .filter((patch) => patch.key === template.key)
  .reduce((acc, patch) => applyPatch(acc, patch), template));

async function publishVersion(knex, key, blocks) {
  const template = await knex('email_templates').where({ template_key: key }).first();
  if (!template) return;
  const prior = template.active_version_id
    ? await knex('email_template_versions').where({ id: template.active_version_id }).first()
    : null;
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const now = new Date();
  const [version] = await knex('email_template_versions').insert({
    template_id: template.id,
    version_number: (latest?.version_number || 0) + 1,
    status: 'active',
    subject: prior?.subject || null,
    preview_text: prior?.preview_text || null,
    blocks: json(blocks),
    text_body: null,
    validation_snapshot: json({
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

exports.TEMPLATES = TEMPLATES;
exports.PATCHES = PATCHES;
exports.MIGRATION_MARKER = MIGRATION_MARKER;
exports.SUPERSEDES = base.MIGRATION_MARKER;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const t of TEMPLATES) {
    await publishVersion(knex, t.key, t.blocks);
  }
};

exports.down = async function down(knex) {
  // Re-activate the prior version; this migration's version is archived
  // (versions are retained, never deleted). Only a version THIS migration
  // created (snapshot marker) is rolled back.
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const t of TEMPLATES) {
    const template = await knex('email_templates').where({ template_key: t.key }).first();
    if (!template?.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
    if (!current || snapshotSource(current) !== MIGRATION_MARKER) continue;
    const prior = await knex('email_template_versions')
      .where({ template_id: template.id, status: 'archived' })
      .where('version_number', '<', current.version_number)
      .orderBy('version_number', 'desc')
      .first();
    if (!prior) continue;
    const now = new Date();
    await knex('email_template_versions').where({ id: prior.id }).update({ status: 'active', updated_at: now });
    await knex('email_template_versions').where({ id: current.id }).update({ status: 'archived', updated_at: now });
    await knex('email_templates').where({ id: template.id }).update({ active_version_id: prior.id, updated_at: now });
  }
};
