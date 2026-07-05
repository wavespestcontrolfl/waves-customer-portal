/**
 * Migration 20260705000502 — message_drafts guard: campaign-draft exemption.
 *
 * The prod BEFORE INSERT trigger (block_message_drafts_when_disabled) raises
 * 'legacy_ai_drafts_disabled' on message_drafts inserts unless
 * system_config.legacy_ai_drafts_enabled='true' (house-voice shadow rows
 * exempted by 20260613000010). Campaign drafts insert status='pending' rows,
 * so without this exemption the lane is dead on arrival in prod.
 *
 * PRECEDENCE PIN: prod's live condition is UNPARENTHESIZED
 * (`if A or B then`, with SQL comment lines above the if). SQL gives AND
 * precedence over OR, so a bare `... and <clause>` append would parse as
 * `A or (B and <clause>)` — A stays true for campaign inserts (drafter NULL)
 * and the exemption silently does nothing. The migration must wrap the
 * captured condition in parentheses BEFORE appending. The fixture below is
 * the verbatim unparenthesized prod shape so a parenthesized-only fixture
 * can't mask that bug.
 *
 * Pins (structural — plpgsql doesn't execute in jest; live raise/succeed
 * behavior gets read-only prod verification before merge):
 *  - the captured condition is parenthesized, then ` and NEW.campaign_type is
 *    null` appended → guard skips campaign rows, still raises for plain
 *    legacy inserts when the flag is absent/false
 *  - composition with the sibling click-followup exemption
 *    (parenthesize-and-append pattern) holds in BOTH merge orders
 *  - idempotence: re-running up() against an already-exempted function no-ops
 *  - fallback: a function-less DB gets the canonical guard + trigger
 *  - unrecognized shape fails loudly instead of silently skipping
 *  - down() strips only the campaign clause, preserving sibling exemptions
 */

const migration = require('../models/migrations/20260705000502_message_drafts_guard_exempt_campaigns');

// VERBATIM prod shape (20260613000010): SQL comment lines above the if,
// UNPARENTHESIZED `A or B` condition — as pg_get_functiondef returns it.
const PROD_UNPARENTHESIZED_DEF = `CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
    declare
      enabled boolean;
    begin
      -- Exempt ONLY the brand-voice loop's unsendable shape:
      -- drafter='house_voice' AND status='shadow'. Every legitimate
      -- house-voice insert (live shadow drafter + backfill) is status
      -- 'shadow'; 'suggested' only ever arises via a later UPDATE, which
      -- this BEFORE INSERT trigger doesn't gate. Requiring 'shadow' keeps
      -- the kill switch effective against a future/buggy house-voice insert
      -- with a sendable status (e.g. 'pending'), which admin-drafts would
      -- otherwise pick up. Everything else (legacy NULL-drafter path) stays
      -- subject to the flag.
      if NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow' then
        select lower(value) = 'true' into enabled
          from system_config where key = 'legacy_ai_drafts_enabled';
        if coalesce(enabled, false) is not true then
          raise exception 'legacy_ai_drafts_disabled' using errcode = 'P0001';
        end if;
      end if;
      return new;
    end;
    $function$`;

// The sibling click-tracking PR's exemption applied FIRST, in its reworked
// parenthesize-and-append form.
const CLICK_FIRST_DEF = PROD_UNPARENTHESIZED_DEF.replace(
  "if NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow' then",
  "if (NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow') and not (NEW.intent is not distinct from 'click_followup') then"
);

// Simulate the sibling's parenthesize-and-append transform (what its
// migration does when it runs AFTER ours): capture the guard condition via
// the same house_voice anchor, wrap, append.
function applySiblingClickTransform(def) {
  const anchorIdx = def.indexOf("NEW.drafter is distinct from 'house_voice'");
  let ifMatch = null;
  for (const m of def.slice(0, anchorIdx).matchAll(/\bif\b/gi)) ifMatch = m;
  const thenMatch = /\bthen\b/i.exec(def.slice(anchorIdx));
  const condStart = ifMatch.index + ifMatch[0].length;
  const condEnd = anchorIdx + thenMatch.index;
  const condition = def.slice(condStart, condEnd).trim();
  return (
    def.slice(0, ifMatch.index) +
    `if (${condition}) and not (NEW.intent is not distinct from 'click_followup') ` +
    def.slice(condEnd)
  );
}

function makeKnex({ def } = {}) {
  const rawCalls = [];
  const knex = {
    raw: jest.fn(async (sql) => {
      rawCalls.push(sql);
      if (/pg_get_functiondef/.test(sql)) {
        return { rows: def ? [{ def }] : [] };
      }
      return { rows: [] };
    }),
  };
  return { knex, rawCalls };
}

// DDL statements only (the pg_get_functiondef lookup is a read).
function ddl(rawCalls) {
  return rawCalls.filter((sql) => !/pg_get_functiondef/.test(sql));
}

async function runUp(def) {
  const { knex, rawCalls } = makeKnex({ def });
  await migration.up(knex);
  return { installed: ddl(rawCalls), rawCalls };
}

describe('up — precedence-safe parenthesize-and-append', () => {
  test('wraps the UNPARENTHESIZED prod condition in parens before appending the campaign clause', async () => {
    const { installed } = await runUp(PROD_UNPARENTHESIZED_DEF);

    expect(installed).toHaveLength(1);
    const fn = installed[0];

    // The whole original OR-condition is parenthesized, THEN our AND clause
    // appended — `(A or B) and campaign_type is null`, never `A or (B and …)`.
    expect(fn).toContain(
      "if (NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow') and NEW.campaign_type is null then"
    );
    // No bare-append form anywhere (the precedence-bug shape).
    expect(fn).not.toMatch(/'shadow'\s+and NEW\.campaign_type is null/);

    // Kill switch intact for legacy (campaign_type NULL) inserts.
    expect(fn).toContain("select lower(value) = 'true' into enabled");
    expect(fn).toContain("raise exception 'legacy_ai_drafts_disabled'");
    expect(fn).toContain('coalesce(enabled, false) is not true');

    // Prod's comment lines above the if survive untouched.
    expect(fn).toContain("-- Exempt ONLY the brand-voice loop's unsendable shape:");
  });

  test('composition — sibling click exemption FIRST, ours second: both clauses on one guard', async () => {
    const { installed } = await runUp(CLICK_FIRST_DEF);

    const fn = installed[0];
    expect(fn).toContain(
      "if ((NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow') and not (NEW.intent is not distinct from 'click_followup')) and NEW.campaign_type is null then"
    );
    expect(fn).toContain("raise exception 'legacy_ai_drafts_disabled'");
  });

  test('composition — ours FIRST, sibling second: sibling transform stacks cleanly on our output', async () => {
    const { installed } = await runUp(PROD_UNPARENTHESIZED_DEF);
    const afterOurs = installed[0];

    const afterBoth = applySiblingClickTransform(afterOurs);

    expect(afterBoth).toContain(
      "if ((NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow') and NEW.campaign_type is null) and not (NEW.intent is not distinct from 'click_followup') then"
    );
    expect(afterBoth).toContain('NEW.campaign_type is null');
    expect(afterBoth).toContain('click_followup');
    expect(afterBoth).toContain("raise exception 'legacy_ai_drafts_disabled'");
  });

  test('idempotent: an already-exempted function is left alone', async () => {
    const { installed } = await runUp(PROD_UNPARENTHESIZED_DEF);
    const second = await runUp(installed[0]);

    expect(second.installed).toHaveLength(0);
  });

  test('fallback: function missing → canonical guard + trigger created, precedence-safe', async () => {
    const { installed } = await runUp(null);

    expect(installed.some((s) => /CREATE OR REPLACE FUNCTION public\.block_message_drafts_when_disabled/.test(s))).toBe(true);
    expect(installed.some((s) => /DROP TRIGGER IF EXISTS message_drafts_disabled_guard/.test(s))).toBe(true);
    expect(installed.some((s) => /CREATE TRIGGER message_drafts_disabled_guard/.test(s))).toBe(true);
    const fn = installed.find((s) => /CREATE OR REPLACE FUNCTION/.test(s));
    expect(fn).toContain(
      "if (NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow') and NEW.campaign_type is null then"
    );
    expect(fn).toContain("raise exception 'legacy_ai_drafts_disabled'");
  });

  test('unrecognized guard shape fails loudly instead of silently skipping', async () => {
    const { knex } = makeKnex({
      def: 'CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled() RETURNS trigger LANGUAGE sql AS $x$ select 1 $x$',
    });

    await expect(migration.up(knex)).rejects.toThrow(/could not locate the guard/);
  });
});

describe('down — strips only the campaign clause', () => {
  test('removes our appended clause, preserves the sibling exemption and the raise', async () => {
    const { installed } = await runUp(CLICK_FIRST_DEF);
    const extendedDef = installed[0];

    const second = makeKnex({ def: extendedDef });
    await migration.down(second.knex);

    const restored = ddl(second.rawCalls)[0];
    expect(restored).not.toContain('campaign_type');
    expect(restored).toContain("and not (NEW.intent is not distinct from 'click_followup')");
    expect(restored).toContain("NEW.drafter is distinct from 'house_voice'");
    expect(restored).toContain("raise exception 'legacy_ai_drafts_disabled'");
  });

  test('no-op when the exemption is not installed', async () => {
    const { knex, rawCalls } = makeKnex({ def: PROD_UNPARENTHESIZED_DEF });

    await migration.down(knex);

    expect(ddl(rawCalls)).toHaveLength(0);
  });
});
