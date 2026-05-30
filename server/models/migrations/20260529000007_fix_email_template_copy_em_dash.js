/**
 * Replace ASCII spaced-hyphen ` - ` with a proper em dash ` — ` in a handful
 * of customer-facing email template strings that were seeded with the wrong
 * punctuation (ACH "processing" acknowledgment + the late-payment "no further
 * action is needed" reassurance line). The body copy elsewhere uses real em
 * dashes, so these read as inconsistent in the inbox.
 *
 * Surgical + idempotent: we only touch the *currently active* version of each
 * template, replace a small set of exact phrases (so no unrelated copy or
 * admin edits are disturbed), and publish a corrected version only when a
 * phrase is actually present. Re-running is a no-op once every active version
 * is clean. Mirrors the publish-new-active-version convention used by the
 * `deepen_*_email_templates` migrations.
 */

const REPLACEMENTS = [
  ['bank payment - processing', 'bank payment — processing'],
  ['Thank you - we received your bank payment', 'Thank you — we received your bank payment'],
  ['thank you - no further action is needed', 'thank you — no further action is needed'],
];

function applyReplacements(value) {
  if (typeof value !== 'string') return value;
  return REPLACEMENTS.reduce((acc, [find, replace]) => acc.split(find).join(replace), value);
}

// Recursively rewrite every string leaf in the parsed blocks JSON. The phrases
// are distinctive enough that a blanket walk is safe and stays surgical.
function rewriteJson(node) {
  if (typeof node === 'string') return applyReplacements(node);
  if (Array.isArray(node)) return node.map(rewriteJson);
  if (node && typeof node === 'object') {
    const out = {};
    for (const [key, val] of Object.entries(node)) out[key] = rewriteJson(val);
    return out;
  }
  return node;
}

function parseBlocks(blocks) {
  if (blocks == null) return [];
  if (typeof blocks === 'string') {
    try { return JSON.parse(blocks); } catch { return []; }
  }
  return blocks;
}

exports.up = async function up(knex) {
  const hasTables = await knex.schema.hasTable('email_templates')
    && await knex.schema.hasTable('email_template_versions');
  if (!hasTables) return;

  const activeVersions = await knex('email_template_versions').where({ status: 'active' });

  for (const version of activeVersions) {
    const blocks = parseBlocks(version.blocks);
    const newSubject = applyReplacements(version.subject);
    const newPreview = applyReplacements(version.preview_text);
    const newBlocks = rewriteJson(blocks);

    const subjectChanged = newSubject !== version.subject;
    const previewChanged = newPreview !== version.preview_text;
    const blocksChanged = JSON.stringify(newBlocks) !== JSON.stringify(blocks);
    if (!subjectChanged && !previewChanged && !blocksChanged) continue;

    const latest = await knex('email_template_versions')
      .where({ template_id: version.template_id })
      .orderBy('version_number', 'desc')
      .first();

    const [published] = await knex('email_template_versions').insert({
      template_id: version.template_id,
      version_number: (latest?.version_number || 0) + 1,
      status: 'active',
      subject: newSubject,
      preview_text: newPreview,
      blocks: JSON.stringify(newBlocks),
      text_body: version.text_body,
      validation_snapshot: version.validation_snapshot,
      published_at: new Date(),
    }).returning('*');

    await knex('email_template_versions')
      .where({ template_id: version.template_id })
      .whereNot({ id: published.id })
      .where({ status: 'active' })
      .update({ status: 'archived', updated_at: new Date() });

    await knex('email_templates').where({ id: version.template_id }).update({
      active_version_id: published.id,
      last_published_at: new Date(),
      updated_at: new Date(),
    });
  }
};

exports.down = async function down() {
  // Historical template versions are intentionally retained; the corrected
  // copy stays active. No-op.
};
