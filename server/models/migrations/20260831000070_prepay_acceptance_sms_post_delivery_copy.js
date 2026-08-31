/**
 * estimate_accepted_annual_prepay — copy for the post-delivery send.
 *
 * The revived annual-prepay acceptance text (estimate-public.js accept, owner
 * ruling 2026-08-31) now sends AFTER InvoiceService.sendViaSMSAndEmail has
 * confirmed the invoice went out, quoting the post-credit amount due. The
 * seeded body still promised the invoice in the future tense ("We'll review
 * and send your annual prepay invoice"), which read as a contradiction
 * arriving seconds after the invoice text (pre-push Codex P1). It also
 * rendered "{tier} WaveGuard", against the 2026-08-30 ruling that customer
 * surfaces say "WaveGuard <Tier>".
 *
 * Admin-edit guard in the UPDATE predicate (house-voice-sweep pattern): the
 * rewrite matches ONLY the exact seeded body; an edited row is left alone.
 * down() restores the prior body the same way. is_active is never touched.
 */

const TEMPLATE_KEY = 'estimate_accepted_annual_prepay';

// Body as left by 20260801000001_sms_house_voice_sweep.
const PREVIOUS_BODY = "Hello {first_name}! Your {waveguard_tier} WaveGuard plan is approved. We'll review and send your annual prepay invoice{amount_text}.";

// {amount_text} renders as " for $X" (or empty) — the amount is the FINAL due
// re-read after credit application. One GSM-7 segment with a long name.
// Channel-neutral on purpose (GH Codex P2 r4): invoiceLinkDelivered is true
// when EITHER the invoice SMS or the email went out (quiet hours queue the
// text until 8 AM), so the copy must not claim both channels delivered.
const NEXT_BODY = 'Hello {first_name}! Your WaveGuard {waveguard_tier} annual plan is approved. Your invoice{amount_text} is on the way.';

async function rewrite(knex, { from, to }) {
  if (!(await knex.schema.hasTable('sms_templates'))) return 0;
  const cols = await knex('sms_templates').columnInfo();
  if (!cols.body) return 0;
  const patch = { body: to };
  if (cols.updated_at) patch.updated_at = new Date();
  const matched = await knex('sms_templates')
    .where({ template_key: TEMPLATE_KEY, body: from })
    .update(patch);
  console.log(`[prepay-acceptance-sms-copy] ${TEMPLATE_KEY}: ${matched ? 'rewritten' : 'skipped (edited since seed or missing)'}`);
  return matched;
}

exports.up = async function up(knex) {
  await rewrite(knex, { from: PREVIOUS_BODY, to: NEXT_BODY });
};

exports.down = async function down(knex) {
  await rewrite(knex, { from: NEXT_BODY, to: PREVIOUS_BODY });
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.PREVIOUS_BODY = PREVIOUS_BODY;
exports.NEXT_BODY = NEXT_BODY;
