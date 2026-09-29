/**
 * leads.heard_about — self-reported "How did you hear about us?" answer from
 * the OPTIONAL question on the Astro quote form (owner-approved 2026-09-27,
 * companion lane to the AI-assistant referral classifier in
 * lead-source-classify.js). Validated server-side against a FIXED allowlist
 * (lead-webhook.js's sanitizeHeardAbout) — anything else, including free
 * text, is dropped before it ever reaches this column.
 *
 * Deliberately a SEPARATE column from lead_source_id / the classifier's
 * `source` bucket: this is what the visitor TYPED, never merged with the
 * technically-observed attribution (UTM/referrer/click-id). "Unknown" stays
 * unknown — a lead that skipped the question stores NULL, not a guess.
 *
 * A first-class column rather than extracted_data jsonb, for the same reason
 * anon_id (20260705120000_leads_anon_id.js) and email_confirmed_at
 * (20260925000001_leads_email_confirmed_at.js) are columns: the webhook lane's
 * AI triage REPLACES extracted_data wholesale on fresh form leads, so
 * anything jsonb-only is clobbered minutes after insert.
 *
 * Idempotent (hasTable + hasColumn); no backfill — existing leads predate the
 * question and correctly read as NULL (never asked), not 'other'.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('leads');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('leads', 'heard_about');
  if (!hasColumn) {
    await knex.schema.alterTable('leads', (t) => {
      t.string('heard_about', 40).nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('leads');
  if (!hasTable) return;

  if (await knex.schema.hasColumn('leads', 'heard_about')) {
    await knex.schema.alterTable('leads', (t) => { t.dropColumn('heard_about'); });
  }
};
