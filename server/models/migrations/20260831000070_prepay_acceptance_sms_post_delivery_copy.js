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

const MIGRATION_MARKER = '20260831000070_prepay_acceptance_sms_post_delivery_copy';

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

// Variants (GH Codex P2 r5): getTemplate may pick an active
// sms_template_variants row over the migrated base body, and any variant of
// this key still carries the retired future-tense/"{tier} WaveGuard"
// semantics of the pre-#1520 dead branch. Rewrite variants that match the
// seeded body exactly; RETIRE every other active variant of the key with a
// metadata marker so down() can recognise and restore exactly the rows this
// migration touched (pattern: 20260830000030_cancellation_confirmation_truth).
async function rewriteVariants(knex, { from, to }) {
  if (!(await knex.schema.hasTable('sms_template_variants'))) return;
  const vcols = await knex('sms_template_variants').columnInfo();
  if (!vcols.body) return;
  const vpatch = { body: to };
  if (vcols.updated_at) vpatch.updated_at = new Date();
  await knex('sms_template_variants')
    .where({ template_key: TEMPLATE_KEY, body: from })
    .update(vpatch);
}

async function retireStaleVariants(knex) {
  if (!(await knex.schema.hasTable('sms_template_variants'))) return;
  const vcols = await knex('sms_template_variants').columnInfo();
  if (!vcols.body || !vcols.status) return;
  const stale = await knex('sms_template_variants')
    .where({ template_key: TEMPLATE_KEY, status: 'active' })
    .whereNot({ body: NEXT_BODY })
    .select('id', 'metadata');
  for (const row of stale) {
    let meta = {};
    try { meta = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata || {}); } catch { meta = {}; }
    const rpatch = { status: 'retired' };
    if (vcols.metadata) rpatch.metadata = JSON.stringify({ ...meta, retired_by: MIGRATION_MARKER });
    if (vcols.updated_at) rpatch.updated_at = new Date();
    await knex('sms_template_variants').where({ id: row.id }).update(rpatch);
  }
  if (stale.length) console.log(`[prepay-acceptance-sms-copy] retired ${stale.length} stale active variant(s) of ${TEMPLATE_KEY}`);
}

async function restoreRetiredVariants(knex) {
  if (!(await knex.schema.hasTable('sms_template_variants'))) return;
  const vcols = await knex('sms_template_variants').columnInfo();
  if (!vcols.status || !vcols.metadata) return;
  await knex('sms_template_variants')
    .where({ template_key: TEMPLATE_KEY, status: 'retired' })
    .whereRaw("metadata->>'retired_by' = ?", [MIGRATION_MARKER])
    .update({ status: 'active', ...(vcols.updated_at ? { updated_at: new Date() } : {}) });
}

exports.up = async function up(knex) {
  await rewrite(knex, { from: PREVIOUS_BODY, to: NEXT_BODY });
  await rewriteVariants(knex, { from: PREVIOUS_BODY, to: NEXT_BODY });
  await retireStaleVariants(knex);
};

exports.down = async function down(knex) {
  await rewrite(knex, { from: NEXT_BODY, to: PREVIOUS_BODY });
  await rewriteVariants(knex, { from: NEXT_BODY, to: PREVIOUS_BODY });
  await restoreRetiredVariants(knex);
};

exports.TEMPLATE_KEY = TEMPLATE_KEY;
exports.PREVIOUS_BODY = PREVIOUS_BODY;
exports.NEXT_BODY = NEXT_BODY;
