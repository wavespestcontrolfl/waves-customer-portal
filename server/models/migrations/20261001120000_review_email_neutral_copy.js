/**
 * Neutral review-request email copy (owner rulings 2026-09-30 / 10-01: no
 * "if we earned it", never steer a customer to reply instead of reviewing,
 * every ask names a Google review). The cadence email's intro is already
 * payload-driven ({{intro_paragraph}}, 20260806002000); this fixes the three
 * fixed pieces around it on the active version:
 *   - preview text: drops "If we earned it" and "mean the world";
 *   - closing paragraph: drops "If anything fell short, just reply to this
 *     email and we'll make it right";
 *   - CTA label: "Leave a quick review" → "Leave a Google review".
 *
 * Same posture as 20260806002000: read-modify-write on the active version,
 * exact-match only (an operator-edited field is left untouched), idempotent,
 * and down restores the prior copy only where this migration's copy is still
 * in place.
 */

const TEMPLATE_KEY = 'review_request_email';
const OLD_PREVIEW = 'If we earned it, a 15-second Google review would mean the world to our small family business.';
const NEW_PREVIEW = 'A 15-second Google review helps our small family business a lot.';
const OLD_CLOSING = "It genuinely makes our day — and helps other local families decide who to trust with their home. If anything fell short, just reply to this email and we'll make it right.";
const NEW_CLOSING = 'It genuinely makes our day — and helps other local families decide who to trust with their home.';
const OLD_CTA = 'Leave a quick review';
const NEW_CTA = 'Leave a Google review';

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

async function swap(knex, { preview, closing, cta }) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_versions'))) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template) return;
  if (String(template.default_cta_label || '').trim() === cta[0]) {
    await knex('email_templates').where({ id: template.id }).update({ default_cta_label: cta[1], updated_at: new Date() });
  }
  if (!template.active_version_id) return;
  const version = await knex('email_template_versions').where({ id: template.active_version_id }).first();
  if (!version) return;

  const update = {};
  if (String(version.preview_text || '').trim() === preview[0]) update.preview_text = preview[1];

  const blocks = parseJson(version.blocks, []);
  if (Array.isArray(blocks)) {
    let dirty = false;
    const next = blocks.map((b) => {
      if (b?.type === 'paragraph' && String(b.content || '').trim() === closing[0]) {
        dirty = true;
        return { ...b, content: closing[1] };
      }
      if (b?.type === 'cta' && String(b.label || '').trim() === cta[0]) {
        dirty = true;
        return { ...b, label: cta[1] };
      }
      return b;
    });
    if (dirty) update.blocks = JSON.stringify(next);
  }

  if (Object.keys(update).length) {
    await knex('email_template_versions').where({ id: version.id }).update({ ...update, updated_at: new Date() });
  }
}

exports.up = async function up(knex) {
  await swap(knex, { preview: [OLD_PREVIEW, NEW_PREVIEW], closing: [OLD_CLOSING, NEW_CLOSING], cta: [OLD_CTA, NEW_CTA] });
};

exports.down = async function down(knex) {
  await swap(knex, { preview: [NEW_PREVIEW, OLD_PREVIEW], closing: [NEW_CLOSING, OLD_CLOSING], cta: [NEW_CTA, OLD_CTA] });
};
