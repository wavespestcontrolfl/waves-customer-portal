/**
 * Guard-splice regexes for 20260924000020 (photo_triage exemption). The
 * fixture is the guard shape after 20260718400000 (click_followup +
 * estimate_clarify intents, campaign clause); a local migrate:latest +
 * down/up round trip verified the live splice against a real database.
 */

const {
  _private: { ARRAY_WITH_CLICK_FOLLOWUP_RE, PHOTO_TRIAGE_ENTRY_RE },
} = require('../models/migrations/20260924000020_photo_triage_drafts');

const FIXTURE = `
CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    declare
      enabled boolean;
    begin
      if (NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow')
         and not coalesce(
           NEW.status = 'pending' and NEW.intent = any (ARRAY['click_followup', 'estimate_clarify']::text[]),
           false
         ) and NEW.campaign_type is null then
        select lower(value) = 'true' into enabled
          from system_config where key = 'legacy_ai_drafts_enabled';
        if coalesce(enabled, false) is not true then
          raise exception 'legacy_ai_drafts_disabled' using errcode = 'P0001';
        end if;
      end if;
      return new;
    end;
    $function$
`;

test('appends photo_triage to the existing intent array, touching nothing else, and reverses cleanly', () => {
  expect(ARRAY_WITH_CLICK_FOLLOWUP_RE.test(FIXTURE)).toBe(true);
  const patched = FIXTURE.replace(ARRAY_WITH_CLICK_FOLLOWUP_RE, "$1, 'photo_triage']::text[]");
  expect(patched).toContain("ARRAY['click_followup', 'estimate_clarify', 'photo_triage']::text[]");
  expect(patched).toContain("NEW.drafter is distinct from 'house_voice'");
  expect(patched).toContain('NEW.campaign_type is null');
  expect(patched).toContain("raise exception 'legacy_ai_drafts_disabled'");
  expect(PHOTO_TRIAGE_ENTRY_RE.test(patched)).toBe(true);
  expect(patched.replace(PHOTO_TRIAGE_ENTRY_RE, '')).toBe(FIXTURE);
});

test('a wholesale-rewritten function without the intent array is NOT matched (up() fails loudly)', () => {
  const rewritten = FIXTURE.replace(/ARRAY\['click_followup', 'estimate_clarify'\]::text\[\]/, 'some_other_predicate()');
  expect(ARRAY_WITH_CLICK_FOLLOWUP_RE.test(rewritten)).toBe(false);
});
