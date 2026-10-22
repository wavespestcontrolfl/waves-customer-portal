'use strict';

/**
 * ESTIMATE FOLLOW-UP AVERAGE: PREVIEW FIXTURES SHOW THE AVERAGE PRICE ROW (codex #6395 r1).
 * Data only, no schema, no template version.
 *
 * Migration 20261021010000 added the context paragraph {{estimate_average_note}} to
 * the four follow-up templates and seeded a sample note into their preview fixtures.
 * Their default fixtures still carry the price sample 20260526000008 seeded,
 * `price_summary: "$89/mo"`, so an admin preview or test send showed "$89/mo" next to
 * "Averaged over the year. You pay after each application." (a monthly price standing
 * as the price, which the live emails never do). This replaces that sample with the
 * live single-service copy:
 *
 *   estimate.unviewed_followup, estimate.viewed_followup,
 *   estimate.followup_final, estimate.expiring_notice
 *
 * A fixture is touched only while its price_summary is still EXACTLY the old seeded
 * string (an admin-edited, blank, already-current or missing value is left). The
 * strings are literal copies on purpose: a data migration must not change meaning when
 * the app's copy changes. `down` is a documented no-op.
 */

const MIGRATION = '20261021020000';
const MARKER = `migration:${MIGRATION}`;

const OLD_PRICE = '$89/mo';
const NEW_PRICE = '$94.00 per application · $31.33 a month';

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

// Pure: the payload with the old seeded price replaced, or null when nothing to do.
function replaceSeededPrice(payloadIn) {
  const payload = json(payloadIn, null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.price_summary !== OLD_PRICE) return null;
  return { ...payload, price_summary: NEW_PRICE };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_fixtures'))) return;
  await knex.transaction(async (trx) => {
    const results = {};
    const templates = await trx('email_templates').whereIn('template_key', KEYS).select('id', 'template_key');
    for (const template of templates) {
      const counts = { replaced: 0, kept: 0 };
      const fixtures = await trx('email_template_fixtures').where({ template_id: template.id }).forUpdate();
      for (const fixture of fixtures) {
        const next = replaceSeededPrice(fixture.payload);
        if (!next) { counts.kept += 1; continue; }
        // Guarded on the value read, so an edit landing in between is never overwritten.
        const changed = await trx('email_template_fixtures')
          .where({ id: fixture.id })
          .whereRaw("payload->>'price_summary' = ?", [OLD_PRICE])
          .update({ payload: JSON.stringify(next), updated_at: new Date() });
        counts.replaced += Number(changed) > 0 ? 1 : 0;
      }
      results[template.template_key] = counts;
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

exports._private = { replaceSeededPrice, KEYS, OLD_PRICE, NEW_PRICE };
