/**
 * message_drafts insert guard — exempt owner-review queue intents.
 *
 * Prod carries the BEFORE INSERT trigger message_drafts_disabled_guard →
 * block_message_drafts_when_disabled (converged into migration control by
 * 20260613000010), which raises 'legacy_ai_drafts_disabled' on every insert
 * unless system_config.legacy_ai_drafts_enabled = 'true'. 20260613000010
 * carved out exactly one shape: drafter='house_voice' AND status='shadow'
 * (structurally unsendable telemetry rows).
 *
 * The click-followup queue (services/click-followup.js) inserts
 * status='pending' drafts with intent='click_followup' for OWNER approval in
 * /admin/drafts — without an exemption every candidate insert raises, the
 * cron's finally releases the claim, and the feature is silently dead in
 * prod. These rows are not the legacy AI reply queue the kill switch exists
 * for: they're deterministic templates from an independently-gated cron
 * (GATE_CLICK_FOLLOWUP), and 'pending' is exactly the intended shape (the
 * owner must review them).
 *
 * Exemption shape = a status='pending' + intent ALLOWLIST, so future
 * owner-review draft lanes (e.g. campaign drafts) extend it by appending
 * their intent in a later CREATE OR REPLACE migration instead of inventing a
 * new predicate. The allowlist is wrapped in coalesce(..., false) so a
 * NULL intent (every legacy insert) stays subject to the kill switch —
 * three-valued logic must never fail open here.
 *
 * CREATE OR REPLACE only — the trigger itself already exists (prod) or is
 * created by 20260613000010 (fresh replay), and that migration has run in
 * prod so it must not be edited.
 */
exports.up = async function (knex) {
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    declare
      enabled boolean;
    begin
      -- Exempt shapes:
      --  1. Brand-voice loop telemetry: drafter='house_voice' AND
      --     status='shadow' (unsendable; see 20260613000010).
      --  2. Owner-review queue lanes: status='pending' AND intent in the
      --     allowlist below. These are deterministic drafts a human must
      --     approve in /admin/drafts — not the legacy AI reply queue.
      --     Extend by appending intents in a later CREATE OR REPLACE.
      -- coalesce(..., false): a NULL intent must never satisfy the
      -- allowlist (legacy inserts carry NULL intent until classification).
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
  `);
};

exports.down = async function (knex) {
  // Restore the house-voice-only form from 20260613000010.
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    declare
      enabled boolean;
    begin
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
  `);
};
