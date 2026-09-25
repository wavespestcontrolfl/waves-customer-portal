'use strict';

/**
 * Prep guide content v3 — Codex round-6 corrections (PR #4790).
 *
 * 20260924000006 ran on the PR's preview database after round 5, so it is
 * frozen (applied-migration guard). Same supersession pattern over
 * 000006's effective TEMPLATES; adds one patch kind, `remove_row`, which
 * drops a details/FAQ row by exact label (must match exactly once).
 *
 *  P2  Rodent FAQ recommended insulation removal/replacement. Insulation
 *      content is prohibited (.claude/skills/waves-content/SKILL.md) and the
 *      sanitation contract (estimate-one-time-copy.json) promises cleanup
 *      and disinfection without insulation replacement. Row removed.
 *  P2  Mosquito FAQ called the misting system "set-and-forget"; the
 *      protocol (wiki/protocols/mosquito-misting-systems.md) requires the
 *      customer to pause via the app before going outside plus monthly /
 *      quarterly / annual servicing. Now "automatically scheduled,
 *      professionally maintained".
 *
 * The page blank-list-item filter and the heading-link contract narrowing
 * from the same round are code/doc changes, not migrations.
 */

const base = require('./20260924000006_prep_guide_content_v3_codex_r5');

const json = (v) => JSON.stringify(v);

const MIGRATION_MARKER = 'migration:20260924000007';

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

// Exact-match patches over the 000006 content.
const PATCHES = [
  {
    key: 'prep.rodent',
    field: 'remove_row',
    from: 'Should I clean the attic insulation?',
    to: '',
  },
  {
    key: 'prep.mosquito',
    from: 'Waves also offers a misting system for lanais and pool decks if you want set-and-forget coverage; ask your technician.',
    to: 'Waves also offers an automatically scheduled, professionally maintained misting system for lanais and pool decks; ask your technician.',
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
  if (patch.field === 'remove_row') {
    next.blocks = template.blocks.map((block) => {
      if (!Array.isArray(block.rows)) return { ...block };
      const rows = block.rows.filter((row) => {
        const match = row.label === patch.from;
        if (match) hits.count += 1;
        return !match;
      });
      return { ...block, rows };
    });
  } else if (patch.field === 'preview' || patch.field === 'subject') {
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
    throw new Error(`20260924000007: patch for ${patch.key} matched ${hits.count} times (expected 1): ${patch.from.slice(0, 60)}…`);
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
  // Re-activate the version this migration displaced (the 000006 one);
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
