/**
 * message_drafts insert guard — exempt owner-review queue intents.
 *
 * Prod carries the BEFORE INSERT trigger message_drafts_disabled_guard →
 * block_message_drafts_when_disabled (converged into migration control by
 * 20260613000010), which raises 'legacy_ai_drafts_disabled' on every insert
 * unless system_config.legacy_ai_drafts_enabled = 'true'. 20260613000010
 * carved out exactly one shape: drafter='house_voice' AND status='shadow'.
 *
 * The click-followup queue (services/click-followup.js) inserts
 * status='pending' drafts with intent='click_followup' for OWNER approval in
 * /admin/drafts — without an exemption every candidate insert raises, the
 * cron releases its claim, and the feature is silently dead in prod. These
 * rows are not the legacy AI reply queue the kill switch exists for: they're
 * deterministic templates from an independently-gated cron
 * (GATE_CLICK_FOLLOWUP), and 'pending' is exactly the intended shape.
 *
 * SPLICE, DON'T CLOBBER: this migration reads the LIVE function body via
 * pg_get_functiondef and injects the allowlist clause into the existing
 * guard condition, preserving everything else in the function. PR #2357
 * modifies the SAME function (a campaign-drafts exemption) with the same
 * read-modify-write pattern — a static CREATE OR REPLACE here would clobber
 * their clause whenever this migration runs second. Whichever of the two
 * migrations runs last now preserves the other's exemption. The static
 * definition below is only the fresh-replay fallback (a database where the
 * function doesn't exist yet — 20260613000010 always runs first by
 * timestamp, so in practice the splice path is taken).
 *
 * The allowlist is wrapped in coalesce(..., false) so a NULL intent (every
 * legacy insert) stays subject to the kill switch — three-valued logic must
 * never fail open. Extend by appending intents to the ARRAY in a later
 * splice migration.
 *
 * 20260613000010 has run in prod and is NOT edited.
 */

// Injected into the guard's IF condition, right before its THEN.
const ALLOWLIST_CLAUSE = `
         and not coalesce(
           NEW.status = 'pending' and NEW.intent = any (ARRAY['click_followup']::text[]),
           false
         )`;

// Matches the injected clause (whitespace-tolerant) for idempotency + down().
const ALLOWLIST_CLAUSE_RE = /\s*and not coalesce\(\s*NEW\.status = 'pending' and NEW\.intent = any \(ARRAY\['click_followup'\]::text\[\]\),\s*false\s*\)/i;

// Fresh-replay fallback: the full guard as 20260613000010 defines it, plus
// our allowlist. Only used when the function does not exist at migrate time.
const STATIC_DEFINITION = `
    CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    declare
      enabled boolean;
    begin
      if (NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow')
         and not coalesce(
           NEW.status = 'pending' and NEW.intent = any (ARRAY['click_followup']::text[]),
           false
         ) then
        select lower(value) = 'true' into enabled
          from system_config where key = 'legacy_ai_drafts_enabled';
        if coalesce(enabled, false) is not true then
          raise exception 'legacy_ai_drafts_disabled' using errcode = 'P0001';
        end if;
      end if;
      return new;
    end;
    $function$;
`;

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

// Inject the allowlist into the guard condition: anchor on the house-voice
// check (present in every historical shape of this function, and preserved
// by #2357's splice), then splice right before the THEN that closes that IF.
function injectAllowlist(def) {
  const anchor = def.indexOf("NEW.drafter is distinct from 'house_voice'");
  if (anchor === -1) return null;
  const thenMatch = /\bthen\b/i.exec(def.slice(anchor));
  if (!thenMatch) return null;
  const insertAt = anchor + thenMatch.index;
  return `${def.slice(0, insertAt)}${ALLOWLIST_CLAUSE}\n      ${def.slice(insertAt)}`;
}

exports.up = async function (knex) {
  const current = await readLiveDefinition(knex);
  if (!current) {
    // Fresh replay before the function exists — define the full guard shape.
    await knex.raw(STATIC_DEFINITION);
    return;
  }
  if (ALLOWLIST_CLAUSE_RE.test(current) || current.includes("ARRAY['click_followup']")) {
    return; // already exempted — idempotent re-run
  }
  const patched = injectAllowlist(current);
  if (!patched) {
    // The live function lost its recognizable guard shape (someone rewrote
    // it wholesale). Fail loudly rather than guessing — a silent fallback to
    // the static definition would clobber whatever replaced it.
    throw new Error(
      'block_message_drafts_when_disabled has an unrecognized shape - splice point '
      + "(NEW.drafter is distinct from 'house_voice' ... then) not found; resolve manually",
    );
  }
  // pg_get_functiondef returns a complete CREATE OR REPLACE FUNCTION
  // statement, so the patched text is directly executable.
  await knex.raw(patched);
};

exports.down = async function (knex) {
  // Splice-remove ONLY our clause, preserving any other exemptions that
  // landed before or after this migration.
  const current = await readLiveDefinition(knex);
  if (!current || !ALLOWLIST_CLAUSE_RE.test(current)) return;
  await knex.raw(current.replace(ALLOWLIST_CLAUSE_RE, ''));
};
