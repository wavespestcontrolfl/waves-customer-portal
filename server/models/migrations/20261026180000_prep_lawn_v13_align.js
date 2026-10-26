'use strict';

/**
 * prep.lawn — match the live v13 lawn protocol on mowing and water-in.
 *
 * Three paragraphs of the prep.lawn guide contradicted v13 (same fix as the
 * lawn Service Details guide, PR #6860): no mowing 2 days before or after a
 * weed spray; a pre-emergent barrier needs about 1/2 inch of rain or
 * irrigation within 14 days to activate, and regular watering counts; other
 * liquid applications wait 1 day. This migration changes only those three
 * paragraphs.
 *
 * Follows 20260930190000_prep_lawn_one_time_neutral.js: the replacements are
 * applied to the LIVE active version's blocks (an administrator may have
 * published a newer version since 2026-09-30), by exact block-content
 * equality, so every other block, admin edits included, is kept as it is.
 * A paragraph whose old text is no longer present is left alone. If none of
 * the three is present, or the version carries a custom plain-text body, the
 * template is left as-is. Otherwise one NEW active version is published with
 * the same concurrency-safe mechanics: template row locked first (the
 * editor's lock order), savepoint insert, pointer compare-and-swap on the
 * version this one replaces BEFORE any status change, MIGRATION_MARKER in
 * validation_snapshot.source, and a CAS-guarded down() that reverses only
 * this migration's own version.
 */

const json = (v) => JSON.stringify(v);

// Stamped into validation_snapshot.source on the version this migration
// publishes so down() can identify its OWN version exactly.
const MIGRATION_MARKER = 'migration:20261026180000';

const TEMPLATE_KEY = 'prep.lawn';

const PATCHES = [
  {
    from: 'Mow at least 24 hours before if mowing is due, and don’t mow the day of. We need leaf surface to treat, and fresh cuts bleed product.',
    to: 'Mow at least 2 days before if mowing is due, and wait 2 days after. Weed sprays need leaf surface to soak in, and their labels ask for two uncut days on each side.',
  },
  {
    from: 'Watering: your service report says one of water in today (granular fertilizer, most insect granules), keep dry for the stated hours (liquid weed control, fungicide), or resume your normal schedule. Don’t run the sprinklers after a visit unless the report says to.',
    to: 'Watering: your service report says one of water in today (granular fertilizer, most insect granules), keep dry for the stated hours (liquid weed control, fungicide), or resume your normal schedule. A weed barrier needs about ½ inch of rain or irrigation within 14 days to activate; your regular watering counts.',
  },
  {
    from: 'Mowing: wait 1–2 days after liquid applications, longer if the report says so. Never mow a wet application.',
    to: 'Mowing: wait 2 days after a weed spray and 1 day after other liquid applications, longer if the report says so. Never mow a wet application.',
  },
];

// Replace each old paragraph present in the live blocks, by exact content
// equality. Returns { blocks, replaced } where replaced is the count.
function patchLiveBlocks(blocks) {
  let replaced = 0;
  const out = blocks.map((block) => {
    const patch = block && typeof block.content === 'string'
      ? PATCHES.find((p) => p.from === block.content)
      : null;
    if (!patch) return block;
    replaced += 1;
    return { ...block, content: patch.to };
  });
  return { blocks: out, replaced };
}

function parseSnapshot(version) {
  try {
    return typeof version.validation_snapshot === 'string'
      ? JSON.parse(version.validation_snapshot)
      : version.validation_snapshot;
  } catch { return null; }
}

async function publishVersion(knex, key) {
  // Template row lock first — the editor's lock order (see header).
  const template = await knex('email_templates').where({ template_key: key }).forUpdate().first();
  if (!template?.active_version_id) return 'missing';
  const prior = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!prior) return 'missing';
  // A custom plain-text body would be replaced by the renderer's generated
  // text (text_body: null below): leave such a version whole.
  if (prior.text_body != null && String(prior.text_body).trim()) {
    console.warn(`[${MIGRATION_MARKER}] ${key}: custom plain-text body present; template left as-is`);
    return 'skipped';
  }
  let liveBlocks = prior.blocks;
  if (typeof liveBlocks === 'string') {
    try { liveBlocks = JSON.parse(liveBlocks); } catch { liveBlocks = null; }
  }
  if (!Array.isArray(liveBlocks)) {
    console.warn(`[${MIGRATION_MARKER}] ${key}: live blocks unreadable; template left as-is`);
    return 'skipped';
  }
  const { blocks, replaced } = patchLiveBlocks(liveBlocks);
  if (!replaced) {
    console.log(`[${MIGRATION_MARKER}] ${key}: none of the three v13 paragraphs is present in the live version; nothing to change`);
    return 'skipped';
  }
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

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.PATCHES = PATCHES;
exports.MIGRATION_MARKER = MIGRATION_MARKER;
exports._patchLiveBlocks = patchLiveBlocks;
exports._publishVersion = publishVersion;

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  await publishVersion(knex, TEMPLATE_KEY);
};

exports.down = async function down(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_versions'))) return;
  const now = new Date();
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template?.active_version_id) return;
  const current = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  const snap = current && parseSnapshot(current);
  if (snap?.source !== MIGRATION_MARKER) return; // an admin published since; leave it
  const prior = await knex('email_template_versions')
    .where({ template_id: template.id, version_number: snap.supersedes_version })
    .first();
  if (!prior) return;
  // Pointer CAS first, as in up(): an admin publish that lands after the
  // marker check wins, and no version statuses change.
  const moved = await knex('email_templates')
    .where({ id: template.id, active_version_id: current.id })
    .update({ active_version_id: prior.id, updated_at: now });
  if (!moved) return;
  await knex('email_template_versions').where({ id: prior.id }).update({ status: 'active', updated_at: now });
  await knex('email_template_versions').where({ id: current.id, status: 'active' }).update({ status: 'archived', updated_at: now });
};
