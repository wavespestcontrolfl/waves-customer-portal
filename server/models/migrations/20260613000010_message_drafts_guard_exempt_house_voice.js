/**
 * message_drafts insert guard — exempt the house-voice brand-voice loop.
 *
 * Production carries a BEFORE INSERT trigger
 * (message_drafts_disabled_guard → block_message_drafts_when_disabled)
 * that raises 'legacy_ai_drafts_disabled' on EVERY message_drafts insert
 * unless system_config.legacy_ai_drafts_enabled = 'true'. It was applied
 * directly to prod with no prior migration — a DB-level kill switch for the
 * LEGACY AI draft approval queue.
 *
 * The trigger grabbed the whole table, so it also blocked the house-voice
 * shadow drafter (Phase B), the shadow judge's only inputs (Phase C),
 * suggest mode (Phase D), and the historical backfill: the entire
 * brand-voice loop was silently inserting ZERO rows in prod since it
 * shipped (confirmed — 0 status='shadow' rows ever, every insert raised
 * 'legacy_ai_drafts_disabled'). House-voice rows are status='shadow'
 * (structurally unsendable) and a separate, independently-gated system; the
 * legacy approval-queue flag was never meant to govern them.
 *
 * This narrows the guard: legacy drafts (drafter IS NULL) stay subject to
 * the kill switch; house-voice rows are always allowed. CREATE OR REPLACE
 * is idempotent — on prod it updates the function the existing trigger
 * already calls; on a fresh DB (no trigger) it creates an unused function,
 * harmless. The trigger itself is left as-is (untracked prod drift, out of
 * scope here).
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
      -- The brand-voice loop (house-voice shadow drafter + backfill) is a
      -- separate, independently-gated system; the legacy approval-queue
      -- flag never governed it. Only legacy drafts (drafter other than
      -- 'house_voice', i.e. the old path's NULL) hit the kill switch.
      if NEW.drafter is distinct from 'house_voice' then
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
  // Restore the all-blocking form (the pre-migration prod state).
  await knex.raw(`
    CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    declare
      enabled boolean;
    begin
      select lower(value) = 'true' into enabled
        from system_config where key = 'legacy_ai_drafts_enabled';
      if coalesce(enabled, false) is not true then
        raise exception 'legacy_ai_drafts_disabled' using errcode = 'P0001';
      end if;
      return new;
    end;
    $function$;
  `);
};
