/**
 * The review_request_email admin preview / test-send fixture still carries the
 * old intro ("If your recent service hit the mark, ...") that
 * 20260806002000 seeded, while sends now use the neutral fallback
 * (review-outreach-templates.js GENERIC_EMAIL_INTRO, owner rulings
 * 2026-09-30 / 10-01). Previews should show what is delivered.
 *
 * Exact-match only on the default fixture's payload.intro_paragraph (an
 * operator-edited payload is untouched), idempotent, an audit_log event for
 * the row it changes (waves-db rule for admin-editable rows), and down is a
 * documented no-op.
 */

const MIGRATION = '20261001130000_review_email_fixture_neutral_intro';
const TEMPLATE_KEY = 'review_request_email';
const OLD_INTRO = "We're a small, family-owned pest and lawn company here in Southwest Florida, and word of mouth is how neighbors find us. If your recent service hit the mark, would you take 15 seconds to share a quick review?";
const NEW_INTRO = "We're a small, family-owned pest and lawn company here in Southwest Florida, and word of mouth is how neighbors find us. Would you take 15 seconds to share a quick Google review of your recent service?";

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value !== 'string') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))) return;
  if (!(await knex.schema.hasTable('email_template_fixtures'))) return;
  const template = await knex('email_templates').where({ template_key: TEMPLATE_KEY }).first();
  if (!template) return;
  const fixture = await knex('email_template_fixtures').where({ template_id: template.id, is_default: true }).first();
  if (!fixture) return;
  const payload = parseJson(fixture.payload, null);
  if (!payload || typeof payload !== 'object' || String(payload.intro_paragraph || '').trim() !== OLD_INTRO) return;

  await knex('email_template_fixtures').where({ id: fixture.id }).update({
    payload: JSON.stringify({ ...payload, intro_paragraph: NEW_INTRO }),
    updated_at: new Date(),
  });
  if (await knex.schema.hasTable('audit_log')) {
    const { recordAuditEvent } = require('../../services/audit-log');
    await recordAuditEvent({
      actor_type: 'system', action: 'email_template.neutral_review_fixture',
      resource_type: 'email_template_fixtures', resource_id: String(fixture.id),
      metadata: { migration: MIGRATION, template_key: TEMPLATE_KEY, before: { intro_paragraph: OLD_INTRO }, after: { intro_paragraph: NEW_INTRO } },
      critical: true, trx: knex,
    });
  }
};

// Documented no-op (waves-db rule for data corrections that keep admin
// edits): matching the new intro does not prove this migration wrote it, so a
// revert could erase an operator's identical edit. The audit_log event keeps
// the before/after for a person to restore if ever needed.
exports.down = async function down() {};
