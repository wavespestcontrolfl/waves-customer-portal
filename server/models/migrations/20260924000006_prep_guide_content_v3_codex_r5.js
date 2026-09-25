'use strict';

/**
 * Prep guide content v3 — Codex round-5 corrections (PR #4790).
 *
 * 20260924000005 ran on the PR's preview database after round 4, so it is
 * frozen (applied-migration guard). Same supersession pattern: exact-match
 * text patches over 000005's effective TEMPLATES (a missing or duplicated
 * `from` throws), published as a NEW active version of every prep.*
 * template. Sequence step-0 bodies (000005) are not touched.
 *
 *  P1  Flea: "bird cages go outside" put a bird in the exterior harborage
 *      zone when the yard add-on is part of the package. Birds now go to an
 *      untreated indoor room or off the property; never outside.
 *  P2  Termite: prep.termite is also selected for termite inspections and
 *      pre-treatment certificates (project-email.js) and reaches one-time
 *      spot/foam/trench visits via service matching, so "a long-term
 *      protection plan" and the annual-renewal line over-claimed for those
 *      recipients. Both are now conditional on the booked plan.
 *
 * The docs/public-route-contracts.md P0 from the same round is a doc
 * change, not a migration.
 */

const base = require('./20260924000005_prep_guide_content_v3_codex_r4');

const json = (v) => JSON.stringify(v);

const MIGRATION_MARKER = 'migration:20260924000006';

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

// Exact-match text patches over the 000005 content. `from` must occur
// exactly once across the named template's text fields.
const PATCHES = [
  {
    key: 'prep.flea',
    from: 'Cover or remove fish tanks: turn off the air pump and lay a towel over the tank. Bird cages go outside or into an untreated room with the door closed.',
    to: 'Cover or remove fish tanks: turn off the air pump and lay a towel over the tank. Birds are especially sensitive: move the cage to an untreated indoor room with the door closed, or take the bird off the property for the day. Never set a cage outside, since exterior areas may be treated too.',
  },
  {
    key: 'prep.termite',
    from: 'This guide explains what we do, what the day sounds like, and what the years after look like, because a termite treatment is a long-term protection plan, not a one-time spray.',
    to: 'This guide covers liquid soil treatments, bait systems, inspections and one-time spot treatments alike: what we do, what the day sounds like, and what comes after. The renewal and station-check parts apply only when your service includes an ongoing protection plan.',
  },
  {
    key: 'prep.termite',
    from: 'Keep your annual inspection. Renewals and station checks are what keep the protection valid year after year.',
    to: 'If your service includes a protection plan or bait monitoring, keep the annual inspection: renewals and station checks are what keep that protection valid year after year. A one-time spot treatment or an inspection does not carry a renewal unless your estimate says so.',
  },
];

function patchText(text, from, to, hits) {
  if (typeof text !== 'string' || !text.includes(from)) return text;
  hits.count += text.split(from).length - 1;
  return text.split(from).join(to);
}

function applyPatch(template, patch) {
  const hits = { count: 0 };
  const next = { ...template };
  if (patch.field === 'preview' || patch.field === 'subject') {
    next[patch.field] = patchText(next[patch.field], patch.from, patch.to, hits);
  } else {
    next.blocks = template.blocks.map((block) => {
      const b = { ...block };
      if (patch.field !== 'label' && typeof b.content === 'string') {
        b.content = patchText(b.content, patch.from, patch.to, hits);
      }
      if (patch.field !== 'label' && Array.isArray(b.items)) {
        b.items = b.items.map((item) => patchText(item, patch.from, patch.to, hits));
      }
      if (Array.isArray(b.rows)) {
        b.rows = b.rows.map((row) => ({
          ...row,
          label: patch.field === 'label' ? patchText(row.label, patch.from, patch.to, hits) : row.label,
          value: patch.field !== 'label' ? patchText(row.value, patch.from, patch.to, hits) : row.value,
        }));
      }
      return b;
    });
  }
  if (hits.count !== 1) {
    throw new Error(`20260924000006: patch for ${patch.key} matched ${hits.count} times (expected 1): ${patch.from.slice(0, 60)}…`);
  }
  return next;
}

function buildTemplates() {
  return base.TEMPLATES.map((t) => {
    let template = { ...t, blocks: t.blocks.map((b) => ({ ...b })) };
    for (const patch of PATCHES.filter((p) => p.key === t.key)) {
      template = applyPatch(template, patch);
    }
    return template;
  });
}

const TEMPLATES = buildTemplates();

async function publishVersion(knex, t) {
  const template = await knex('email_templates').where({ template_key: t.key }).first();
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
    subject: t.subject || prior?.subject || null,
    preview_text: t.preview || prior?.preview_text || null,
    blocks: json(t.blocks),
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
    await publishVersion(knex, t);
  }
};

exports.down = async function down(knex) {
  // Re-activate the version this migration displaced (the 000005 one);
  // only a version THIS migration created is rolled back.
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
