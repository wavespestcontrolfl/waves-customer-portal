'use strict';

/**
 * ESTIMATE PDF NOTE: PREVIEW FIXTURES GET THE CURRENT, MODE-NEUTRAL COPY (codex #6343 r7).
 * Data only, no schema, no template version.
 *
 * Migration 20261019200000 seeded a sample `estimate_pdf_note` into the preview
 * fixtures of the open-estimate templates. The live copy was reworded to be
 * mode-neutral (it also goes to existing-appointment, invoice-only and
 * office-only estimates, so it promises no first visit and no start date), but
 * the seeded samples still show the old wording in admin previews and test
 * sends' preview. This replaces each seeded sample with the current text:
 *
 *   estimate.delivery                        old delivery sample -> current delivery text
 *   the 12 follow-up / engagement / extension-email templates
 *                                            old follow-up sample -> current follow-up text
 *
 * A fixture is touched only while its value is still EXACTLY the old seeded
 * string (an admin-edited value is kept; a value already current or blanked is
 * left). estimate.extension_notice is excluded: 20261019220000 blanked its
 * sample because the auto-renew notice carries no file. The strings below are
 * literal copies on purpose: a data migration must not change meaning when the
 * app's copy changes again. `down` is a documented no-op.
 */

const MIGRATION = '20261019230000';
const MARKER = `migration:${MIGRATION}`;

const OLD_DELIVERY = "Can't open the link? A PDF copy of this estimate is attached. To go ahead, reply to this email or call (941) 297-5749 and we'll set your first visit.";
const NEW_DELIVERY = "Can't open the link? A PDF copy of this estimate is attached. Reply to this email or call (941) 297-5749 with any questions or to go ahead.";
const OLD_FOLLOW_UP = "Your estimate is attached as a PDF if the link won't open. Reply or call (941) 297-5749 to get started.";
const NEW_FOLLOW_UP = "Your estimate is attached as a PDF if the link won't open. Reply or call (941) 297-5749 with any questions.";

const FOLLOW_UP_KEYS = [
  'estimate.unviewed_followup',
  'estimate.viewed_followup',
  'estimate.followup_final',
  'estimate.expiring_notice',
  'estimate.engage_unopened',
  'estimate.engage_gone_quiet',
  'estimate.engage_expiring',
  'estimate.engage_expiring_unseen',
  'estimate.engage_high_intent',
  'estimate.engage_return_visit',
  'estimate.engage_return_after_dark',
  'estimate.extended',
];

const PLANS = [
  { keys: ['estimate.delivery'], from: OLD_DELIVERY, to: NEW_DELIVERY },
  { keys: FOLLOW_UP_KEYS, from: OLD_FOLLOW_UP, to: NEW_FOLLOW_UP },
];

function json(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
}

// Pure: the payload with the old seeded sample replaced, or null when nothing to do.
function replaceSeededNote(payloadIn, from, to) {
  const payload = json(payloadIn, null);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.estimate_pdf_note !== from) return null;
  return { ...payload, estimate_pdf_note: to };
}

exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('email_templates')) || !(await knex.schema.hasTable('email_template_fixtures'))) return;
  await knex.transaction(async (trx) => {
    const results = {};
    for (const plan of PLANS) {
      const templates = await trx('email_templates').whereIn('template_key', plan.keys).select('id', 'template_key');
      for (const template of templates) {
        const counts = { replaced: 0, kept: 0 };
        const fixtures = await trx('email_template_fixtures').where({ template_id: template.id }).forUpdate();
        for (const fixture of fixtures) {
          const next = replaceSeededNote(fixture.payload, plan.from, plan.to);
          if (!next) { counts.kept += 1; continue; }
          // Guarded on the value read, so an edit landing in between is never overwritten.
          const changed = await trx('email_template_fixtures')
            .where({ id: fixture.id })
            .whereRaw("payload->>'estimate_pdf_note' = ?", [plan.from])
            .update({ payload: JSON.stringify(next), updated_at: new Date() });
          counts.replaced += Number(changed) > 0 ? 1 : 0;
        }
        results[template.template_key] = counts;
      }
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

exports._private = { replaceSeededNote, PLANS, OLD_DELIVERY, NEW_DELIVERY, OLD_FOLLOW_UP, NEW_FOLLOW_UP, FOLLOW_UP_KEYS };
