/**
 * leads.heard_about_prompt — optional follow-up to leads.heard_about. When the
 * visitor picks ChatGPT or another AI assistant on the Astro quote form's
 * "How did you hear about us?" question, a single-line "What did you ask it?"
 * input appears; whatever they typed lands here so staff can see the search
 * that led them to us.
 *
 * Only ever written for heard_about = chatgpt / other_ai (lead-webhook.js
 * sanitizeHeardAboutPrompt), whitespace-collapsed and capped at 500 chars.
 * Stored as typed — no redaction. NULL = not asked / not answered.
 *
 * First-class column (not extracted_data jsonb) for the same reason as
 * heard_about (20260928020000_leads_heard_about.js): the webhook lane's AI
 * triage REPLACES extracted_data wholesale on fresh form leads.
 *
 * Idempotent (hasTable + hasColumn); no backfill.
 */
exports.up = async function up(knex) {
  const hasTable = await knex.schema.hasTable('leads');
  if (!hasTable) return;

  const hasColumn = await knex.schema.hasColumn('leads', 'heard_about_prompt');
  if (!hasColumn) {
    await knex.schema.alterTable('leads', (t) => {
      t.string('heard_about_prompt', 500).nullable().defaultTo(null);
    });
  }
};

exports.down = async function down(knex) {
  const hasTable = await knex.schema.hasTable('leads');
  if (!hasTable) return;

  if (await knex.schema.hasColumn('leads', 'heard_about_prompt')) {
    await knex.schema.alterTable('leads', (t) => { t.dropColumn('heard_about_prompt'); });
  }
};
