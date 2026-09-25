'use strict';

/**
 * Prep guide content v3 — Codex round-3 corrections (PR #4790).
 *
 * 20260924000003 ran on the PR's preview database after round 2, so it is
 * frozen (applied-migration guard). Same supersession pattern: exact-match
 * text patches over 000003's effective TEMPLATES (a missing or duplicated
 * `from` throws), published as a NEW active version of every prep.*
 * template. The migration test reads THIS file's TEMPLATES as the content
 * customers receive.
 *
 *  P1  Bed bug: electronics were grouped with items that may go in a hot
 *      dryer. Electronics now get their own device-safe isolation step
 *      (bag, flashlight-inspect, leave for the technician) and are excluded
 *      from the dryer/freezer alternatives.
 *  P1  Lawn: the fungus tip prescribed watering 2–3 times a week, but the
 *      checked-in restriction policy (server/config/irrigation-restrictions.js,
 *      Modified Phase III) caps lawn watering at one day per week and the
 *      personalized watering plan enforces it. The copy now defers to the
 *      customer's allowed day(s) under the current county restriction.
 */

const base = require('./20260924000003_prep_guide_content_v3_codex_r2');

const json = (v) => JSON.stringify(v);

const MIGRATION_MARKER = 'migration:20260924000004';

function snapshotSource(version) {
  try {
    const snap = typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
    return snap?.source || null;
  } catch { return null; }
}

// Exact-match text patches over the 000003 content. `from` must occur
// exactly once across the named template's text fields.
const PATCHES = [
  {
    key: 'prep.bed_bug',
    from: 'Items that cannot be washed (shoes, books, electronics, delicate fabric): bag them, and either run them through the dryer on high for 30 minutes if the item can take it, or seal them in a freezer at 0°F for at least 4 full days, longer for bulky items so the center reaches temperature. Dry cleaning also works; tell the cleaner they came from a bed bug room.',
    to: 'Items that cannot be washed (shoes, books, delicate fabric): bag them, and either run them through the dryer on high for 30 minutes if the item can take it, or seal them in a freezer at 0°F for at least 4 full days, longer for bulky items so the center reaches temperature. Dry cleaning also works; tell the cleaner they came from a bed bug room.',
  },
  {
    key: 'prep.bed_bug',
    from: 'Unplug lamps, chargers and small electronics in the room and leave them on the bed so we can inspect them.',
    to: 'Electronics (phones, laptops, chargers, clocks, game consoles) never go in a dryer or freezer. Unplug them, check vents and seams with a flashlight, seal each device in its own bag, and leave the bagged devices on the bed so your technician can inspect them.',
  },
  {
    key: 'prep.lawn',
    from: 'Fungus in summer (brown patch, gray leaf spot) is usually a watering problem first. Water early morning, 2 to 3 times a week deeply, never in the evening. Nightly light watering is the single most common thing we see killing Lakewood Ranch lawns.',
    to: 'Fungus in summer (brown patch, gray leaf spot) is usually a watering problem first. Water early morning, deeply, and only on the day or days your county restriction currently allows, never in the evening. Frequent light watering is the single most common thing we see killing Lakewood Ranch lawns.',
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
    throw new Error(`20260924000004: patch for ${patch.key} matched ${hits.count} times (expected 1): ${patch.from.slice(0, 60)}…`);
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
  // Re-activate the version this migration displaced (the 000003 one);
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
