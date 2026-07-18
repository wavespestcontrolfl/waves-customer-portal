/**
 * Clarify-ask drafts: guard exemption + atomic open-draft dedupe.
 *
 * 1) message_drafts insert guard — prod's BEFORE INSERT trigger
 *    (block_message_drafts_when_disabled) raises 'legacy_ai_drafts_disabled'
 *    unless the row matches an allowlisted shape. 20260705010010 injected an
 *    intent allowlist for the owner-review queue —
 *    ARRAY['click_followup']::text[] — and documents extension as "append
 *    intents to the ARRAY in a later splice migration". This migration does
 *    exactly that for 'estimate_clarify' (services/estimate-clarify-asks.js,
 *    pending owner-approval drafts, independently gated by
 *    GATE_ESTIMATE_CLARIFY_ASKS): without it every clarify insert raises,
 *    the fail-soft writer swallows the error, and the feature is silently
 *    dead in prod.
 *
 *    SPLICE, DON'T CLOBBER — same read-modify-write contract as
 *    20260705010010: read the LIVE definition via pg_get_functiondef,
 *    append ONLY to the existing intent array, preserve every other clause
 *    (the campaign exemption is `and NEW.campaign_type is null`, array-free,
 *    so the intent ARRAY is the only ARRAY[...]::text[] in the function).
 *    Unrecognized shape → fail loudly rather than guess. A fresh replay
 *    (function absent) can only happen before 20260613000010 by timestamp
 *    ordering — impossible in practice — but degrades to a no-op so replays
 *    on empty databases don't explode; 20260705010010's static fallback owns
 *    fresh-replay creation and this migration re-runs idempotently after.
 *
 * 2) Open-clarify dedupe index — the writer's check-then-insert is racy
 *    (concurrent webhook + retry producers can both observe no row). The
 *    partial unique index makes "one OPEN clarify per phone" a database
 *    invariant: the writer treats 23505 as the deduped outcome. Scoped to
 *    open statuses so a sent/rejected clarify frees the slot for a later
 *    independent ask (the 7-day sent cooldown stays advisory in code).
 */

const ARRAY_WITH_CLICK_FOLLOWUP_RE = /(ARRAY\[[^\]]*'click_followup'[^\]]*)\]::text\[\]/i;
const CLARIFY_ENTRY_RE = /,\s*'estimate_clarify'/i;

async function readLiveDefinition(knex) {
  const result = await knex.raw(`
    SELECT pg_get_functiondef(oid) AS def
    FROM pg_proc
    WHERE proname = 'block_message_drafts_when_disabled'
      AND pronamespace = 'public'::regnamespace
  `);
  const rows = result && result.rows ? result.rows : [];
  return rows.length ? rows[0].def : null;
}

exports.up = async function up(knex) {
  const current = await readLiveDefinition(knex);
  if (current) {
    if (!current.includes("'estimate_clarify'")) {
      if (!ARRAY_WITH_CLICK_FOLLOWUP_RE.test(current)) {
        // The intent allowlist lost its recognizable shape (wholesale
        // rewrite). Fail loudly — a guess here could clobber another PR's
        // exemption or silently fail to exempt ours.
        throw new Error(
          'block_message_drafts_when_disabled has no recognizable intent allowlist '
          + "(ARRAY[...'click_followup'...]::text[]) to extend; resolve manually",
        );
      }
      const patched = current.replace(
        ARRAY_WITH_CLICK_FOLLOWUP_RE,
        "$1, 'estimate_clarify']::text[]",
      );
      await knex.raw(patched);
    }
  }
  // else: function absent (fresh replay ordering puts 20260705010010 first,
  // which creates it; nothing to splice here yet — idempotent re-run covers).

  await knex.raw(`
    CREATE UNIQUE INDEX IF NOT EXISTS message_drafts_clarify_open_uniq
      ON message_drafts (source_ref)
      WHERE intent = 'estimate_clarify' AND status IN ('pending', 'approved', 'revised')
  `);
};

exports.down = async function down(knex) {
  await knex.raw('DROP INDEX IF EXISTS message_drafts_clarify_open_uniq');
  const current = await readLiveDefinition(knex);
  if (current && CLARIFY_ENTRY_RE.test(current)) {
    await knex.raw(current.replace(CLARIFY_ENTRY_RE, ''));
  }
};

exports._private = { ARRAY_WITH_CLICK_FOLLOWUP_RE, CLARIFY_ENTRY_RE };
