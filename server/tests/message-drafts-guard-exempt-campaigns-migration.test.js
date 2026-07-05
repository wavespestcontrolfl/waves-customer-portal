/**
 * Migration 20260705000502 — message_drafts guard: campaign-draft exemption.
 *
 * The prod BEFORE INSERT trigger (block_message_drafts_when_disabled) raises
 * 'legacy_ai_drafts_disabled' on message_drafts inserts unless
 * system_config.legacy_ai_drafts_enabled='true' (house-voice shadow rows
 * exempted by 20260613000010). Campaign drafts insert status='pending' rows,
 * so without this exemption the lane is dead on arrival in prod.
 *
 * Pins (structural — plpgsql doesn't execute in jest; the live raise/succeed
 * behavior gets read-only prod verification before merge):
 *  - the extended function early-returns (allows) campaign_type IS NOT NULL
 *    inserts BEFORE the legacy kill-switch check, with the check + raise
 *    retained verbatim → a plain legacy insert (campaign_type NULL) still
 *    raises when the flag is absent/false
 *  - order-independence: an already-extended function from the sibling
 *    click-followup PR is preserved verbatim, in either merge order
 *  - idempotence: re-running up() against an already-exempted function is a
 *    no-op
 *  - fallback: a function-less DB gets the canonical guard + trigger
 */

const migration = require('../models/migrations/20260705000502_message_drafts_guard_exempt_campaigns');

// The exact function 20260613000010 installs (house-voice-only exemption) as
// pg_get_functiondef would return it.
const HOUSE_VOICE_DEF = `CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
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
    $function$`;

// What the sibling click-tracking PR's exemption could look like if its
// migration runs first — ours must preserve it verbatim.
const CLICK_EXTENDED_DEF = HOUSE_VOICE_DEF.replace(
  'begin\n',
  `begin
      if NEW.intent is not distinct from 'click_followup' then
        return NEW;
      end if;
`
);

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

describe('up — campaign exemption splice', () => {
  test('pending campaign inserts are exempted BEFORE the legacy check; plain legacy inserts still hit the raise', async () => {
    const { knex, rawCalls } = makeKnex({ def: HOUSE_VOICE_DEF });

    await migration.up(knex);

    const installed = ddl(rawCalls);
    expect(installed).toHaveLength(1);
    const fn = installed[0];

    // Early-return exemption for campaign rows…
    const exemptionIdx = fn.indexOf('if NEW.campaign_type is not null');
    expect(exemptionIdx).toBeGreaterThan(-1);
    expect(fn.slice(exemptionIdx)).toMatch(/campaign_type is not null then\s*\n\s*return NEW;/);

    // …placed after BEGIN and before the legacy kill-switch check…
    const beginIdx = fn.indexOf('begin');
    const legacyCheckIdx = fn.indexOf("if NEW.drafter is distinct from 'house_voice'");
    expect(beginIdx).toBeLessThan(exemptionIdx);
    expect(exemptionIdx).toBeLessThan(legacyCheckIdx);

    // …with the legacy check + raise retained verbatim, so a NULL-campaign_type
    // legacy insert still raises when legacy_ai_drafts_enabled is absent/false.
    expect(fn).toContain("select lower(value) = 'true' into enabled");
    expect(fn).toContain("raise exception 'legacy_ai_drafts_disabled'");
    expect(fn).toContain('coalesce(enabled, false) is not true');

    // House-voice shadow exemption untouched.
    expect(fn).toContain("NEW.status is distinct from 'shadow'");
  });

  test('preserves the sibling click-followup exemption verbatim (either merge order)', async () => {
    const { knex, rawCalls } = makeKnex({ def: CLICK_EXTENDED_DEF });

    await migration.up(knex);

    const fn = ddl(rawCalls)[0];
    expect(fn).toContain("if NEW.intent is not distinct from 'click_followup'");
    expect(fn).toContain('if NEW.campaign_type is not null');
    expect(fn).toContain("raise exception 'legacy_ai_drafts_disabled'");
  });

  test('idempotent: an already-exempted function is left alone', async () => {
    const { knex, rawCalls } = makeKnex({ def: HOUSE_VOICE_DEF });
    await migration.up(knex);
    const extendedDef = ddl(rawCalls)[0]
      .replace(/^CREATE OR REPLACE FUNCTION/, 'CREATE OR REPLACE FUNCTION');

    const second = makeKnex({ def: extendedDef });
    await migration.up(second.knex);

    expect(ddl(second.rawCalls)).toHaveLength(0);
  });

  test('fallback: function missing → canonical guard + trigger created', async () => {
    const { knex, rawCalls } = makeKnex({ def: null });

    await migration.up(knex);

    const installed = ddl(rawCalls);
    expect(installed.some((s) => /CREATE OR REPLACE FUNCTION public\.block_message_drafts_when_disabled/.test(s))).toBe(true);
    expect(installed.some((s) => /DROP TRIGGER IF EXISTS message_drafts_disabled_guard/.test(s))).toBe(true);
    expect(installed.some((s) => /CREATE TRIGGER message_drafts_disabled_guard/.test(s))).toBe(true);
    const fn = installed.find((s) => /CREATE OR REPLACE FUNCTION/.test(s));
    expect(fn).toContain('if NEW.campaign_type is not null');
    expect(fn).toContain("raise exception 'legacy_ai_drafts_disabled'");
  });

  test('unrecognized guard shape fails loudly instead of silently skipping', async () => {
    const { knex } = makeKnex({ def: 'CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled() RETURNS trigger LANGUAGE sql AS $x$ select 1 $x$' });

    await expect(migration.up(knex)).rejects.toThrow(/could not locate BEGIN/);
  });
});

describe('down — strips only the campaign exemption', () => {
  test('removes the campaign block, preserves other exemptions and the raise', async () => {
    // Build the extended def by running up() against the click-extended shape.
    const first = makeKnex({ def: CLICK_EXTENDED_DEF });
    await migration.up(first.knex);
    const extendedDef = ddl(first.rawCalls)[0];

    const second = makeKnex({ def: extendedDef });
    await migration.down(second.knex);

    const restored = ddl(second.rawCalls)[0];
    expect(restored).not.toContain('campaign_type');
    expect(restored).toContain("if NEW.intent is not distinct from 'click_followup'");
    expect(restored).toContain("NEW.drafter is distinct from 'house_voice'");
    expect(restored).toContain("raise exception 'legacy_ai_drafts_disabled'");
  });

  test('no-op when the exemption is not installed', async () => {
    const { knex, rawCalls } = makeKnex({ def: HOUSE_VOICE_DEF });

    await migration.down(knex);

    expect(ddl(rawCalls)).toHaveLength(0);
  });
});
