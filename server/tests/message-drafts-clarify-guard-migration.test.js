/**
 * Guard-splice regexes for 20260718400000 (estimate_clarify exemption).
 *
 * The fixture reproduces the live guard shape as recorded by its own
 * migrations: 20260705010010's static definition (house-voice carve-out +
 * intent allowlist ARRAY['click_followup']) plus 20260705000502's campaign
 * clause. Prod-verbatim simulation needs authorized read access this
 * sandbox doesn't have — the fixture derives from the migrations that
 * define every live clause, and the up() fails loudly on any unrecognized
 * shape instead of guessing.
 */

const {
  _private: { ARRAY_WITH_CLICK_FOLLOWUP_RE, CLARIFY_ENTRY_RE },
} = require('../models/migrations/20260718400000_message_drafts_clarify_guard_and_dedupe');

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
           NEW.status = 'pending' and NEW.intent = any (ARRAY['click_followup']::text[]),
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

describe('estimate_clarify guard splice', () => {
  test('appends estimate_clarify to the existing intent array, touching nothing else', () => {
    expect(ARRAY_WITH_CLICK_FOLLOWUP_RE.test(FIXTURE)).toBe(true);
    const patched = FIXTURE.replace(ARRAY_WITH_CLICK_FOLLOWUP_RE, "$1, 'estimate_clarify']::text[]");
    expect(patched).toContain("ARRAY['click_followup', 'estimate_clarify']::text[]");
    // Every other clause survives byte-identical.
    expect(patched).toContain("NEW.drafter is distinct from 'house_voice'");
    expect(patched).toContain('NEW.campaign_type is null');
    expect(patched).toContain("raise exception 'legacy_ai_drafts_disabled'");
    // And the splice is idempotency-detectable + reversible.
    expect(patched.includes("'estimate_clarify'")).toBe(true);
    expect(CLARIFY_ENTRY_RE.test(patched)).toBe(true);
    expect(patched.replace(CLARIFY_ENTRY_RE, '')).toBe(FIXTURE);
  });

  test('a wholesale-rewritten function without the intent array is NOT matched (up() fails loudly)', () => {
    const rewritten = FIXTURE.replace(/ARRAY\['click_followup'\]::text\[\]/, 'some_other_predicate()');
    expect(ARRAY_WITH_CLICK_FOLLOWUP_RE.test(rewritten)).toBe(false);
  });
});
