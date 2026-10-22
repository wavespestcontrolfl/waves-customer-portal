'use strict';

/**
 * ESTIMATE EXTENSION NOTICE: PREVIEW FIXTURE NO LONGER CLAIMS A PDF (codex #6343 r6).
 * Data only, no schema, no template version.
 *
 * Migration 20261019200000 seeded a sample `estimate_pdf_note` into the preview
 * fixtures of 14 templates, `estimate.extension_notice` among them. That
 * template's sender (auto-renew) later dropped the PDF copy, so the email never
 * carries a file; an admin test send or preview built from the fixture would say
 * a PDF is attached when none is. This blanks the sample in that template's
 * fixtures only. A fixture is touched only while its value is still EXACTLY the
 * text 20261019200000 seeded (an admin-edited value is kept), and the key stays
 * present as '' so 20261019200000's "only when undefined" seeding never re-adds
 * it. The template's published version is not touched: its note block renders
 * nothing while the variable is blank. `down` is a documented no-op.
 */

const MIGRATION = '20261019220000';
const MARKER = `migration:${MIGRATION}`;
const TEMPLATE_KEY = 'estimate.extension_notice';
// What 20261019200000 wrote into the fixtures of the follow-up templates.
const SEEDED_NOTE = "Your estimate is attached as a PDF if the link won't open. Reply or call (941) 297-5749 to get started.";

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

// Pure: the payload with the seeded sample blanked, or null when nothing to do.
function blankSeededNote(payloadIn) {
  const payload = json(payloadIn, null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.estimate_pdf_note !== SEEDED_NOTE) return null;
  return { ...payload, estimate_pdf_note: '' };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_fixtures'))) return;
  await knex.transaction(async (trx) => {
    const template = await trx('email_templates').where({ template_key: TEMPLATE_KEY }).first('id');
    const results = { template: template ? 'found' : 'missing', fixturesBlanked: 0, fixturesKept: 0 };
    if (template) {
      const fixtures = await trx('email_template_fixtures').where({ template_id: template.id }).forUpdate();
      for (const fixture of fixtures) {
        const next = blankSeededNote(fixture.payload);
        if (!next) { results.fixturesKept += 1; continue; }
        // Guarded on the value read, so an edit landing in between is never overwritten.
        const changed = await trx('email_template_fixtures')
          .where({ id: fixture.id })
          .whereRaw("payload->>'estimate_pdf_note' = ?", [SEEDED_NOTE])
          .update({ payload: JSON.stringify(next), updated_at: new Date() });
        results.fixturesBlanked += Number(changed) > 0 ? 1 : 0;
      }
    }
    console.log(`[${MARKER}] ${TEMPLATE_KEY}: ${JSON.stringify(results)}`);
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
  // Data-only: the sample was a preview convenience; staff can re-add it in the fixture editor.
};

exports._private = { blankSeededNote, SEEDED_NOTE, TEMPLATE_KEY };
