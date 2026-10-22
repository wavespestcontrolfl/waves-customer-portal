'use strict';

/**
 * ESTIMATE FOLLOW-UP AVERAGE: RESTORE THE FIXTURE PRICE ON TEMPLATES THE NOTE MIGRATION SKIPPED
 * (codex #6395 r2). Data only, no schema, no template version.
 *
 * 20261021020000 rewrote the preview fixtures' `price_summary` from "$89/mo" to the live
 * single-service average row for all four follow-up templates. But a template that
 * 20261021010000 left whole (custom plain-text body, price block removed, publish race)
 * does not show the average at all (the follow-up sender skips it), so its preview
 * should show what the real email shows: the old sample. For each of
 *
 *   estimate.unviewed_followup, estimate.viewed_followup,
 *   estimate.followup_final, estimate.expiring_notice
 *
 * whose ACTIVE version does not carry BOTH {{price_summary}} and {{estimate_average_note}}
 * in its blocks (and, when its plain-text body is non-blank, in that body too, the same
 * test the sender uses), a fixture whose price_summary is still EXACTLY the
 * 20261021020000 value goes back to "$89/mo". An admin-edited value is kept; supported
 * templates keep the new value. The strings are literal copies on purpose. `down` is a
 * documented no-op.
 */

const MIGRATION = '20261021030000';
const MARKER = `migration:${MIGRATION}`;

const AVERAGE_PRICE = '$94.00 per application · $31.33 a month';
const SEEDED_PRICE = '$89/mo';
const TOKENS = ['{{price_summary}}', '{{estimate_average_note}}'];

const KEYS = [
  'estimate.unviewed_followup',
  'estimate.viewed_followup',
  'estimate.followup_final',
  'estimate.expiring_notice',
];

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

// Pure: does this active version show the average (the sender's own test)?
function versionShowsAverage(version) {
  if (!version) return false;
  const blocks = typeof version.blocks === 'string' ? version.blocks : JSON.stringify(version.blocks || []);
  if (!TOKENS.every((token) => blocks.includes(token))) return false;
  const text = version.text_body;
  return text == null || !String(text).trim() || TOKENS.every((token) => String(text).includes(token));
}

// Pure: the payload with the average sample put back, or null when nothing to do.
function restoreSeededPrice(payloadIn) {
  const payload = json(payloadIn, null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.price_summary !== AVERAGE_PRICE) return null;
  return { ...payload, price_summary: SEEDED_PRICE };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates'))
    || !(await knex.schema.hasTable('email_template_versions'))
    || !(await knex.schema.hasTable('email_template_fixtures'))) return;
  await knex.transaction(async (trx) => {
    const results = {};
    const templates = await trx('email_templates').whereIn('template_key', KEYS).select('id', 'template_key', 'active_version_id');
    for (const template of templates) {
      const version = template.active_version_id
        ? await trx('email_template_versions').where({ id: template.active_version_id }).first()
        : null;
      if (versionShowsAverage(version)) { results[template.template_key] = { supported: true, restored: 0 }; continue; }
      let restored = 0;
      const fixtures = await trx('email_template_fixtures').where({ template_id: template.id }).forUpdate();
      for (const fixture of fixtures) {
        const next = restoreSeededPrice(fixture.payload);
        if (!next) continue;
        // Guarded on the value read, so an edit landing in between is never overwritten.
        const changed = await trx('email_template_fixtures')
          .where({ id: fixture.id })
          .whereRaw("payload->>'price_summary' = ?", [AVERAGE_PRICE])
          .update({ payload: JSON.stringify(next), updated_at: new Date() });
        restored += Number(changed) > 0 ? 1 : 0;
      }
      results[template.template_key] = { supported: false, restored };
    }
    console.log(`[${MARKER}] ${JSON.stringify(results)}`);
    if (await trx.schema.hasTable('audit_log')) {
      const { recordAuditEvent } = require('../../services/audit-log');
      await recordAuditEvent({
        actor_type: 'system',
        action: `${MARKER}:fixtures`,
        resource_type: 'email_template',
        resource_id: null,
        metadata: { results },
        critical: true,
        trx,
      });
    }
  });
};

exports.down = async function down() {
  // Data-only: the samples are preview conveniences; staff can edit them in the fixture editor.
};

exports._private = { versionShowsAverage, restoreSeededPrice, KEYS, AVERAGE_PRICE, SEEDED_PRICE };
