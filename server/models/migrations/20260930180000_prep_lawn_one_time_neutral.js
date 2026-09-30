'use strict';

/**
 * prep.lawn — one-time-neutral wording (follow-up to #5441, its Codex r1 P2).
 *
 * prep.lawn also serves one-time lawn treatment visits (project-email.js), so
 * "Before your first visit", "we'll read it on the first visit", and "the
 * rulebook for each visit" imply later visits a one-time customer does not
 * have. Exact-match patches over 20260930170000's TEMPLATES (a missing or
 * duplicated `from` throws at load), published as a NEW active version with
 * the same concurrency-safe mechanics: template row locked first (the
 * editor's lock order), savepoint insert, pointer CAS, CAS-guarded down().
 */

const base = require('./20260930170000_prep_lawn_guide_revision');

const json = (v) => JSON.stringify(v);

const MIGRATION_MARKER = 'migration:20260930180000';

const PATCHES = [
  { key: 'prep.lawn', from: 'Before your first visit', to: 'What we need from you' },
  { key: 'prep.lawn', from: 'we’ll read it on the first visit', to: 'we’ll read it when we arrive' },
  { key: 'prep.lawn', from: 'Your service report is the rulebook for each visit.', to: 'Your service report is the rulebook for your service.' },
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

function parseSnapshot(version) {
  try {
    return typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
  } catch { return null; }
}

async function publishVersion(knex, key, blocks) {
  // Template row lock first — the editor's lock order (see header).
  const template = await knex('email_templates').where({ template_key: key }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';
  const latest = await knex('email_template_versions')
    .where({ template_id: template.id })
    .orderBy('version_number', 'desc')
    .first();
  const now = new Date();
  // Savepoint: the admin editor allocates draft version numbers the same way
  // (max + 1, no lock), so a draft created mid-deploy can take this number.
  // A unique-violation then leaves the template as-is instead of aborting the
  // whole migration transaction.
  let created;
  try {
    created = await knex.transaction(async (sp) => {
      const [row] = await sp('email_template_versions').insert({
        template_id: template.id,
        version_number: (latest?.version_number || 0) + 1,
        status: 'active',
        subject: prior.subject || null,
        preview_text: prior.preview_text || null,
        blocks: json(blocks),
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
  // CAS on the version this one replaces, BEFORE touching any other
  // version's status: a concurrent admin publish wins and stays active.
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

exports.TEMPLATES = TEMPLATES;
exports.PATCHES = PATCHES;
exports.MIGRATION_MARKER = MIGRATION_MARKER;
exports.SUPERSEDES = base.MIGRATION_MARKER;
exports._publishVersion = publishVersion;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  for (const t of TEMPLATES) await publishVersion(knex, t.key, t.blocks);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const now = new Date();
  for (const t of TEMPLATES) {
    const template = await knex('email_templates').where({ template_key: t.key }).first();
    if (!template?.active_version_id) continue;
    const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
    const snap = current && parseSnapshot(current);
    if (snap?.source !== MIGRATION_MARKER) continue; // an admin published since; leave it
    const prior = await knex('email_template_versions')
      .where({ template_id: template.id, version_number: snap.supersedes_version })
      .first();
    if (!prior) continue;
    // Pointer CAS first, as in up(): an admin publish that lands after the
    // marker check wins, and no version statuses change.
    const moved = await knex('email_templates')
      .where({ id: template.id, active_version_id: current.id })
      .update({ active_version_id: prior.id, updated_at: now });
    if (!moved) continue;
    await knex('email_template_versions').where({ id: prior.id }).update({ status: 'active', updated_at: now });
    await knex('email_template_versions').where({ id: current.id, status: 'active' }).update({ status: 'archived', updated_at: now });
  }
};
