/**
 * The irrigation weekly email footer told recipients to "Turn off Seasonal
 * Lawn Tips under Notification Preferences in your portal" — but that toggle
 * was removed from the customer portal's notification list (owner ruling
 * 2026-07-09, same PR). Following the instruction now lands on a list with
 * no Seasonal Tips control (Codex P2 on PR #2523).
 *
 * These emails ride the service_operational stream, which renders NO visible
 * unsubscribe link (that's marketing-stream only), so the reply path is the
 * one honest opt-out left to advertise: a reply reaches the office, who flip
 * notification_prefs.seasonal_tips — still honored by the sender's
 * `seasonal_tips IS DISTINCT FROM false` filter.
 *
 * Surgical + idempotent, mirroring 20260529000007_fix_email_template_copy_em_dash:
 * only the currently active version of the three irrigation.weekly_* templates
 * is touched, only the exact seeded sentence is replaced (admin-edited copy
 * without the sentence is left alone), and a corrected version is published
 * only when the sentence is actually present. Re-running is a no-op.
 */

const TEMPLATE_KEYS = [
  'irrigation.weekly_on_track',
  'irrigation.weekly_cut_back',
  'irrigation.weekly_add_water',
];

const OLD_SENTENCE = 'Prefer not to get these weekly check-ins? Turn off Seasonal Lawn Tips under Notification Preferences in your portal, or just reply and we\'ll take care of it.';
const NEW_SENTENCE = 'Prefer not to get these weekly check-ins? Just reply to this email and we\'ll turn them off for you.';

function applyReplacement(value) {
  if (typeof value !== 'string') return value;
  return value.split(OLD_SENTENCE).join(NEW_SENTENCE);
}

// Recursively rewrite every string leaf in the parsed blocks JSON. The seeded
// sentence is distinctive enough that a blanket walk stays surgical.
function rewriteJson(node) {
  if (typeof node === 'string') return applyReplacement(node);
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

  const templates = await knex('email_templates').whereIn('template_key', TEMPLATE_KEYS);

  for (const template of templates) {
    if (!template.active_version_id) continue;
    const version = await knex('email_template_versions')
      .where({ id: template.active_version_id })
      .first();
    if (!version) continue;

    const blocks = parseBlocks(version.blocks);
    const newBlocks = rewriteJson(blocks);
    if (JSON.stringify(newBlocks) === JSON.stringify(blocks)) continue;

    const latest = await knex('email_template_versions')
      .where({ template_id: template.id })
      .orderBy('version_number', 'desc')
      .first();

    const [published] = await knex('email_template_versions').insert({
      template_id: template.id,
      version_number: (latest?.version_number || 0) + 1,
      status: 'active',
      subject: version.subject,
      preview_text: version.preview_text,
      blocks: JSON.stringify(newBlocks),
      text_body: version.text_body,
      validation_snapshot: version.validation_snapshot,
      published_at: new Date(),
    }).returning('*');

    await knex('email_template_versions')
      .where({ template_id: template.id })
      .whereNot({ id: published.id })
      .where({ status: 'active' })
      .update({ status: 'archived', updated_at: new Date() });

    await knex('email_templates').where({ id: template.id }).update({
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

exports.__private = { TEMPLATE_KEYS, OLD_SENTENCE, NEW_SENTENCE, rewriteJson, parseBlocks };
