/**
 * message_drafts insert guard — exempt campaign drafts (campaign lane V1).
 *
 * Production carries a BEFORE INSERT trigger on message_drafts
 * (message_drafts_disabled_guard → block_message_drafts_when_disabled) that
 * raises 'legacy_ai_drafts_disabled' unless system_config.
 * legacy_ai_drafts_enabled = 'true'. Migration 20260613000010 narrowed it to
 * exempt the house-voice shadow lane (drafter='house_voice' AND
 * status='shadow'); everything else — including the campaign lane's
 * status='pending' rows — still raises. Without this exemption every campaign
 * draft insert (seasonal-reactivation, upsell generator) would throw in prod
 * and the feature would be dead on arrival.
 *
 * Campaign drafts are an independently-gated system (GATE_CAMPAIGN_DRAFTS +
 * explicit owner approval per send); the legacy approval-queue kill switch was
 * never meant to govern them. Legacy writers never set campaign_type, so
 * requiring `NEW.campaign_type IS NULL` for the guard to fire leaves the
 * legacy lane fully kill-switched.
 *
 * PATTERN — parenthesize-and-append (shared with the sibling click-followup
 * exemption PR so the two stack cleanly in either merge order): we do NOT
 * install a hardcoded function body. We read the CURRENT definition
 * (pg_get_functiondef), locate the guard's `if <condition> then` via the
 * 'house_voice' anchor (present verbatim in every installed shape, including
 * a sibling-extended one), wrap the ENTIRE captured condition in parentheses,
 * and append ` and NEW.campaign_type is null`. Parenthesizing first matters:
 * prod's live condition is UNPARENTHESIZED (`A or B`), and SQL gives AND
 * precedence over OR — a bare append would parse as `A or (B and <ours>)`,
 * leaving A true for campaign inserts (drafter NULL) and the exemption
 * silently dead. `(A or B) and NEW.campaign_type is null` is precedence-safe,
 * and repeated wraps compose associatively:
 *   ((A or B) and not <click>) and NEW.campaign_type is null
 * works identically to
 *   ((A or B) and NEW.campaign_type is null) and not <click>.
 *
 * Idempotent on re-run (campaign_type marker check); fails loudly — never
 * silently skips — if the guard's shape is unrecognizable; down() strips only
 * the appended campaign clause. 20260613000010 is not edited (it has run in
 * prod). Only if the function is missing entirely (never true on a DB that
 * replayed 20260613000010) do we create the canonical guard from scratch.
 */

const EXEMPTION_MARKER = 'campaign_type';
const CAMPAIGN_CLAUSE = ' and NEW.campaign_type is null';
const GUARD_ANCHOR = "NEW.drafter is distinct from 'house_voice'";

// Fallback body if the function somehow doesn't exist (canonical
// 20260613000010 shape with the campaign clause applied the same way).
const FALLBACK_FUNCTION_SQL = `
    CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    declare
      enabled boolean;
    begin
      if (NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow')${CAMPAIGN_CLAUSE} then
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

async function currentGuardDef(knex) {
  const result = await knex.raw(`
    SELECT pg_get_functiondef(p.oid) AS def
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE p.proname = 'block_message_drafts_when_disabled'
      AND n.nspname = 'public'
  `);
  return result?.rows?.[0]?.def || null;
}

/**
 * Locate the guard `if <condition> then` via the house_voice anchor (immune
 * to comment lines above the if and to a sibling exemption already wrapped
 * around the condition), parenthesize the captured condition, and append the
 * campaign clause. Returns null when the shape is unrecognizable.
 */
function spliceExemption(def) {
  const anchorIdx = def.indexOf(GUARD_ANCHOR);
  if (anchorIdx === -1) return null;

  // Nearest `if` token BEFORE the anchor (the guard's if — the condition
  // itself contains no `if`, and comments sit above the if, not inside it).
  let ifMatch = null;
  for (const m of def.slice(0, anchorIdx).matchAll(/\bif\b/gi)) ifMatch = m;
  if (!ifMatch) return null;

  // Nearest `then` token AFTER the anchor.
  const thenMatch = /\bthen\b/i.exec(def.slice(anchorIdx));
  if (!thenMatch) return null;

  const condStart = ifMatch.index + ifMatch[0].length;
  const condEnd = anchorIdx + thenMatch.index;
  const condition = def.slice(condStart, condEnd).trim();
  if (!condition) return null;

  return (
    def.slice(0, ifMatch.index) +
    `if (${condition})${CAMPAIGN_CLAUSE} ` +
    def.slice(condEnd)
  );
}

exports.up = async function (knex) {
  const def = await currentGuardDef(knex);

  if (!def) {
    // Never expected on a DB that replayed 20260613000010 — defensive only.
    await knex.raw(FALLBACK_FUNCTION_SQL);
    await knex.raw('DROP TRIGGER IF EXISTS message_drafts_disabled_guard ON public.message_drafts');
    await knex.raw(`
      CREATE TRIGGER message_drafts_disabled_guard
        BEFORE INSERT ON public.message_drafts
        FOR EACH ROW EXECUTE FUNCTION block_message_drafts_when_disabled()
    `);
    return;
  }

  // Already exempted (re-run, or a superset landed via another path).
  if (def.includes(EXEMPTION_MARKER)) return;

  const extended = spliceExemption(def);
  if (!extended) {
    throw new Error(
      'message_drafts_guard_exempt_campaigns: could not locate the guard ' +
      "if-condition (house_voice anchor) in block_message_drafts_when_disabled " +
      '— guard shape changed; extend manually'
    );
  }
  await knex.raw(extended);
};

exports.down = async function (knex) {
  // Remove exactly the appended campaign clause, preserving any other lane's
  // exemptions and the (now-parenthesized) original condition — the added
  // parentheses are semantically inert, so they stay.
  const def = await currentGuardDef(knex);
  if (!def || !def.includes(EXEMPTION_MARKER)) return;
  if (!def.includes(CAMPAIGN_CLAUSE)) return;

  await knex.raw(def.replace(CAMPAIGN_CLAUSE, ''));
};
