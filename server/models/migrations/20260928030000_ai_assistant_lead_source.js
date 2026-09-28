/**
 * Seed the 'AI Assistant Referrals' lead_sources row so AI-referred web leads
 * (lead-source-classify.js's new ai_assistant branch, 20260928020000) resolve
 * a lead_source_id instead of always reading NULL.
 *
 * Codex pre-push P1 on 20260928020000/lead-source-classify.js: returning
 * `source: 'ai_assistant'` fixed the funnel display name (SOURCE_NAMES) but
 * lead-webhook.js's lead_sources lookup only matches known source types —
 * with none seeded, every AI-referred form lead kept lead_source_id NULL,
 * losing the admin source badge/filter and tripping the unattributed-leads
 * alert. Fixed here (seed) + lead-webhook.js (added match branch, mirroring
 * the existing nextdoor/domain_website branches).
 *
 * No phone number to upsert by (mirrors the non-phone Nextdoor/Yelp/Customer
 * Referral rows in 20260401000096_seed_lead_sources.js) — matched by
 * source_type, which no other seed uses. Insert-if-absent only: never
 * overwrites an admin edit to the row (name/cost/active) once it exists, and
 * the down() is a documented no-op for the same reason (seed rollbacks are
 * never destructive).
 */
exports.up = async function up(knex) {
  if (!(await knex.schema.hasTable('lead_sources'))) return;

  const existing = await knex('lead_sources').where({ source_type: 'ai_assistant' }).first();
  if (existing) return;

  await knex('lead_sources').insert({
    name: 'AI Assistant Referrals',
    source_type: 'ai_assistant',
    channel: 'organic',
    cost_type: 'free',
    monthly_cost: 0,
    is_active: true,
    notes: 'ChatGPT, Perplexity, Gemini, Copilot, Claude, etc. — a visitor who asked an AI assistant and followed its citation link (lead-source-classify.js). Owner-approved 2026-09-27.',
  });
};

// Seed rollback — never destructive. Deleting this row would silently strand
// every future AI-referred lead at lead_source_id NULL again, and if the
// office has since edited the row (renamed it, marked it inactive), a delete
// would erase that edit too.
exports.down = async function down() {};
