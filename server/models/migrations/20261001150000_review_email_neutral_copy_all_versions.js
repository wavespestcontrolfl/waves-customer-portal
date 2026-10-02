/**
 * 20261001120000 neutralized only the ACTIVE review_request_email version. A
 * draft or archived version still carrying the old copy ("If we earned it",
 * the reply-instead-of-review closing, the CTA without Google) could be
 * published later from the template editor and bring it back. This applies
 * the same exact-match rewrite to EVERY version (the active one too: it may
 * carry the older intro / "tell us privately" closing 120000 doesn't match),
 * turns the old seeded intro ("If your recent service hit the mark...") into
 * {{intro_paragraph}}, as 20260806002000 did for the then-active version.
 *
 * Exact-match, compare-and-swap on the value read (an admin edit made in
 * between is never overwritten), an audit_log event per changed row (waves-db
 * rule for admin-editable rows), idempotent, documented no-op down.
 */

const MIGRATION = '20261001150000_review_email_neutral_copy_all_versions';
const TEMPLATE_KEY = 'review_request_email';
const OLD_PREVIEW = 'If we earned it, a 15-second Google review would mean the world to our small family business.';
const NEW_PREVIEW = 'A 15-second Google review helps our small family business a lot.';
const OLD_CLOSINGS = [
  "It genuinely makes our day — and helps other local families decide who to trust with their home. If anything fell short, just reply to this email and we'll make it right.",
  'It genuinely makes our day — and helps other local families decide who to trust with their home. If anything fell short, the same link lets you tell us privately first so we can make it right.',
];
const NEW_CLOSING = 'It genuinely makes our day — and helps other local families decide who to trust with their home.';
const OLD_CTA = 'Leave a quick review';
// The seeded intro 20260806002000 turned into {{intro_paragraph}} on the then
// active version only; an older version can still carry it.
const SEEDED_INTRO = "We're a small, family-owned pest and lawn company here in Southwest Florida, and word of mouth is how neighbors find us. If your recent service hit the mark, would you take 15 seconds to share a quick review?";
const INTRO_VARIABLE = '{{intro_paragraph}}';
const NEW_CTA = 'Leave a Google review';

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_versions'))) return;
  const hasAudit = await knex.schema.hasTable('audit_log');
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template) return;
  const versions = await knex('email_template_versions').where({ template_id: template.id })
    .select('id', 'preview_text', 'blocks');

  for (const version of versions) {
    const update = {};
    const before = {};
    if (String(version.preview_text || '').trim() === OLD_PREVIEW) {
      update.preview_text = NEW_PREVIEW;
      before.preview_text = version.preview_text;
    }
    const blocks = parseJson(version.blocks, null);
    if (Array.isArray(blocks)) {
      let dirty = false;
      const next = blocks.map((b) => {
        if (b?.type === 'paragraph' && String(b.content || '').trim() === SEEDED_INTRO) {
          dirty = true;
          return { ...b, content: INTRO_VARIABLE };
        }
        if (b?.type === 'paragraph' && OLD_CLOSINGS.includes(String(b.content || '').trim())) {
          dirty = true;
          return { ...b, content: NEW_CLOSING };
        }
        if (b?.type === 'cta' && String(b.label || '').trim() === OLD_CTA) {
          dirty = true;
          return { ...b, label: NEW_CTA };
        }
        return b;
      });
      if (dirty) {
        update.blocks = JSON.stringify(next);
        before.blocks = version.blocks;
      }
    }
    if (!Object.keys(update).length) continue;

    // Compare-and-swap: write only if the row still holds what was read.
    // blocks is jsonb and pg returns it parsed, so it is compared as JSON
    // (passing the array itself would serialize as a Postgres array literal).
    const q = knex('email_template_versions').where({ id: version.id });
    if ('preview_text' in before) q.where('preview_text', version.preview_text);
    if ('blocks' in before) q.whereRaw('blocks = ?::jsonb', [JSON.stringify(blocks)]);
    const changed = await q.update({ ...update, updated_at: new Date() });
    if (changed && hasAudit) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system', action: 'email_template.neutral_review_copy',
        resource_type: 'email_template_versions', resource_id: String(version.id),
        metadata: { migration: MIGRATION, template_key: TEMPLATE_KEY, before, after: update },
        critical: true, trx: knex,
      });
    }
  }
};

// Documented no-op (waves-db rule for data corrections that keep admin
// edits): matching the new copy does not prove this migration wrote it. The
// audit_log events keep the before/after copy.
exports.down = async function down() {};
