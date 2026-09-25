'use strict';

/**
 * Prep guide content v3 — Codex round-1 corrections (PR #4790).
 *
 * 20260924000001 already ran on the PR's preview database, so it is frozen
 * (applied-migration guard; .claude/skills/waves-db/SKILL.md §4). This file
 * supersedes it: it takes that migration's TEMPLATES, applies the four
 * review corrections below as exact-match text patches, and publishes the
 * result as a NEW active version of every prep.* template (prior version —
 * the 000001 one — archived, never edited). A patch whose `from` text is
 * missing THROWS, so the content can never silently drift from what the
 * test suite (prep-guide-content-v3-migration.test.js, which reads THIS
 * file's TEMPLATES as the effective content) verified.
 *
 *  P1  prep.flea framed the service as one treatment with an optional
 *      callback. Flea is sold ONLY as the two-visit Flea Elimination Package
 *      (initial + follow-up ~14 days later at the egg-hatch window —
 *      intent-composer.js, 20260903000060). The copy now describes both
 *      visits and the FAQ is "Why two visits?".
 *  P2  prep.cockroach prevention called early German roach treatment a
 *      "one-visit job" while the same guide requires the 10–14 day
 *      follow-up (German Roach Cleanout is a multi-visit program).
 *  P2  Signature: 20260721100020 retired every company-name sign-off in
 *      favour of the owner-approved "— The Waves Team"; the footer already
 *      carries the office lines, so the phone lines go too.
 *  P2  The Seresto dog link pointed at an Amazon marketplace listing in the
 *      same sentence that warns about marketplace counterfeits; it now
 *      points at the manufacturer page.
 */

const base = require('./20260924000001_prep_guide_content_v3');

const json = (v) => JSON.stringify(v);

const MIGRATION_MARKER = 'migration:20260924000002';

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

const SIGNATURE = '— The Waves Team';

// Exact-match text patches over the 000001 content. `from` must occur
// exactly once across the named template's text fields.
const PATCHES = [
  // ── P2: Seresto seller ──
  {
    key: 'prep.flea',
    from: '[Seresto for dogs](https://www.amazon.com/Seresto-Vet-Recommended-Treatment-Prevention-Collar/dp/B00B8CG602)',
    to: '[Seresto for dogs](https://yourpetandyou.elanco.com/us/our-products/seresto/seresto-dogs)',
  },
  {
    key: 'prep.flea',
    from: 'gives up to 8 months of protection. Buy from a vet or Chewy; counterfeit Seresto collars are common on marketplace sites.',
    to: 'gives up to 8 months of protection. Buy from your vet, Chewy or the manufacturer; counterfeit Seresto collars are common on marketplace sites.',
  },
  // ── P1: two-visit flea package ──
  {
    key: 'prep.flea',
    from: 'This guide is longer than our usual prep email on purpose: follow it and one treatment usually does the job. Skip it and the fleas come back in three weeks no matter who treats the house.',
    to: 'Your flea service is a two-visit elimination package: the initial treatment, then a follow-up visit about 14 days later timed to the egg-hatch window. This guide is longer than our usual prep email on purpose: follow it and the two visits finish the job. Skip it and the fleas come back no matter who treats the house.',
  },
  {
    key: 'prep.flea',
    from: 'Still seeing more than a handful of fleas at day 21? Reply to this email or text us with the room, and we will schedule a follow-up look.',
    to: 'Your follow-up visit, about 14 days after the first, is part of the package and catches the pupae that hatched after the initial treatment. Repeat the vacuuming and pet steps before it, and tell your technician which rooms still show activity. Still seeing more than a handful of fleas a week after the follow-up? Reply to this email or text us with the room.',
  },
  {
    key: 'prep.flea',
    field: 'label',
    from: 'Will one treatment do it?',
    to: 'Why two visits?',
  },
  {
    key: 'prep.flea',
    from: 'Usually, when the pets are treated the same day and the vacuuming schedule is followed. Pupae that were already in the carpet keep hatching for a few weeks and die on the treated floor. If activity is not clearly dropping by week three, tell us and we will come back out.',
    to: 'Pupae already in the carpet are protected in their cocoons and keep hatching for a few weeks after the first treatment. The follow-up visit about 14 days later, timed to that hatch, is what finishes the job, which is why flea service is sold as the two-visit package and never a single visit. Both visits need the pets treated and the floors vacuumed.',
  },
  // ── P2: German roach one-visit claim ──
  {
    key: 'prep.cockroach',
    from: 'Interior German roach activity is a separate, follow-up-driven treatment, and catching it early keeps it a one-visit job.',
    to: 'Interior German roach activity is a separate cleanout program, the initial visit plus the 10 to 14 day follow-up, and catching it early keeps that program short.',
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
    const next = { ...block };
    if (patch.field !== 'label' && typeof next.content === 'string') {
      next.content = patchText(next.content, patch.from, patch.to, hits);
    }
    if (patch.field !== 'label' && Array.isArray(next.items)) {
      next.items = next.items.map((item) => patchText(item, patch.from, patch.to, hits));
    }
    if (Array.isArray(next.rows)) {
      next.rows = next.rows.map((row) => ({
        ...row,
        label: patch.field === 'label' ? patchText(row.label, patch.from, patch.to, hits) : row.label,
        value: patch.field !== 'label' ? patchText(row.value, patch.from, patch.to, hits) : row.value,
      }));
    }
    return next;
  });
  if (hits.count !== 1) {
    throw new Error(`20260924000002: patch for ${patch.key} matched ${hits.count} times (expected 1): ${patch.from.slice(0, 60)}…`);
  }
  return { ...template, blocks };
}

function buildTemplates() {
  return base.TEMPLATES.map((t) => {
    let template = { ...t, blocks: t.blocks.map((b) => ({ ...b })) };
    for (const patch of PATCHES.filter((p) => p.key === t.key)) {
      template = applyPatch(template, patch);
    }
    // P2: approved sign-off on every guide.
    template.blocks = template.blocks.map((b) => (b.type === 'signature' ? { type: 'signature', content: SIGNATURE } : b));
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
  // Re-activate the version this migration displaced (the 000001 one);
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
