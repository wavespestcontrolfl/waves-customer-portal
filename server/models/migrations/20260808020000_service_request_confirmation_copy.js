/**
 * Re-service request streamline (owner ruling 2026-08-08) — stop promising a
 * text that never sends.
 *
 * service_request_confirmation has told every requester "We'll text you once
 * it's assigned to a technician." That promise was made 14 times and kept
 * ~never (the 2026-08-08 audit: 14 service_requests rows, 14 still 'new',
 * zero ever resolved — no assignment flow exists to fire such a text). The
 * honest copy is the review promise the EOD unworked-comms digest now
 * actually enforces.
 *
 * Second attempt on purpose: 20260715220000_service_request_followup_copy
 * tried this with a WHOLE-BODY equality guard, but its OLD_BODY ("We received
 * your {category} request… We'll text you when it has been assigned…") never
 * matched the live row ("We got your {category} request… We'll text you once
 * it's assigned…"), so the guard skipped and the broken promise survived —
 * prod-verified 2026-08-08. This swap targets the exact SENTENCE instead, so
 * surrounding owner wording can't defeat it again.
 *
 * Data-only, idempotent both ways: up swaps the exact broken sentence when
 * present (an owner-customized body without it is left alone); down restores
 * it. Variables are unchanged — no placeholder is added or removed, so there
 * is no expand/contract deploy-window hazard here.
 */

const KEY = 'service_request_confirmation';
const OLD_SENTENCE = "We'll text you once it's assigned to a technician.";
const NEW_SENTENCE = "We'll follow up as soon as we've reviewed it.";

async function swapSentence(knex, from, to) {
  if (!(await knex.schema.hasTable('sms_templates'))) return;
  const row = await knex('sms_templates').where({ template_key: KEY }).first();
  if (!row || typeof row.body !== 'string' || !row.body.includes(from)) return;
  await knex('sms_templates').where({ id: row.id }).update({
    body: row.body.split(from).join(to),
    updated_at: knex.fn.now(),
  });
  // A/B variant bodies render IN PLACE OF the base body (getTemplate prefers
  // variant.body), so any variant carrying the promise gets the same swap.
  if (await knex.schema.hasTable('sms_template_variants')) {
    const variants = await knex('sms_template_variants').where({ template_key: KEY });
    for (const v of variants) {
      if (typeof v.body !== 'string' || !v.body.includes(from)) continue;
      await knex('sms_template_variants').where({ id: v.id }).update({
        body: v.body.split(from).join(to),
        updated_at: knex.fn.now(),
      });
    }
  }
}

exports.up = async function up(knex) {
  await swapSentence(knex, OLD_SENTENCE, NEW_SENTENCE);
};

exports.down = async function down(knex) {
  await swapSentence(knex, NEW_SENTENCE, OLD_SENTENCE);
};

// Exported for tests (same pattern as the reschedule-link template migration).
exports.KEY = KEY;
exports.OLD_SENTENCE = OLD_SENTENCE;
exports.NEW_SENTENCE = NEW_SENTENCE;
