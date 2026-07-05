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
 * exempting `NEW.campaign_type IS NOT NULL` leaves the legacy lane fully
 * gated.
 *
 * ORDER-INDEPENDENT EXTENSION: a sibling PR extends the SAME function for its
 * own lane (intent='click_followup', migration range 202607050100xx). To
 * compose in either merge order we do NOT install a hardcoded function body.
 * Instead we read the CURRENT function definition (pg_get_functiondef) and
 * splice an early-return campaign exemption in right after BEGIN — preserving
 * verbatim whatever exemptions are already installed (house_voice shadow,
 * click_followup, ...). Re-runs and an already-extended function are detected
 * and skipped. Only if the function is missing entirely (never true on a
 * DB that replayed 20260613000010) do we create the canonical guard from
 * scratch.
 */

const EXEMPTION_MARKER = 'campaign_type';

// Spliced in immediately after the function's BEGIN. Early return = exempt.
const CAMPAIGN_EXEMPTION_SNIPPET = `
      -- Campaign drafts V1 (GATE_CAMPAIGN_DRAFTS lane): campaign rows are
      -- owner-approval drafts from an independently-gated system - the legacy
      -- approval-queue kill switch does not govern them. Legacy inserts never
      -- set campaign_type, so they stay fully gated below.
      if NEW.campaign_type is not null then
        return NEW;
      end if;
`;

// Fallback body if the function somehow doesn't exist (canonical
// 20260613000010 shape + the campaign exemption).
const FALLBACK_FUNCTION_SQL = `
    CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    declare
      enabled boolean;
    begin
${CAMPAIGN_EXEMPTION_SNIPPET}
      if NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow' then
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

// Insert the snippet right after the body's BEGIN (the first `begin` token
// after the $function$ delimiter — the guard's known shapes keep comments
// inside the body, after BEGIN).
function spliceExemption(def) {
  const bodyStart = def.indexOf('$function$');
  if (bodyStart === -1) return null;
  const beginMatch = /\bbegin\b/i.exec(def.slice(bodyStart));
  if (!beginMatch) return null;
  const insertAt = bodyStart + beginMatch.index + beginMatch[0].length;
  return def.slice(0, insertAt) + '\n' + CAMPAIGN_EXEMPTION_SNIPPET + def.slice(insertAt);
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
      'message_drafts_guard_exempt_campaigns: could not locate BEGIN in ' +
      'block_message_drafts_when_disabled — guard shape changed; extend manually'
    );
  }
  await knex.raw(extended);
};

exports.down = async function (knex) {
  // Remove exactly the spliced exemption block, preserving any other lane's
  // exemptions. If the block isn't present (e.g. up() took the fallback path
  // on a function-less DB), fall back to stripping via marker-free no-op.
  const def = await currentGuardDef(knex);
  if (!def || !def.includes(EXEMPTION_MARKER)) return;

  const start = def.indexOf('-- Campaign drafts V1');
  const endToken = 'end if;';
  if (start === -1) return;
  const end = def.indexOf(endToken, start);
  if (end === -1) return;
  const stripped = def.slice(0, start) + def.slice(end + endToken.length);
  await knex.raw(stripped);
};
