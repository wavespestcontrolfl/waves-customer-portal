/**
 * Shape tests for the click-tracking migrations:
 *   20260705000110 — short_codes linkage columns + short_code_clicks
 *   20260705000120 — click_followup_actions (queue + partial unique claims)
 *   20260705010010 — message_drafts insert-guard exemption for the
 *                    click-followup owner-review queue
 *
 * Fake-knex recorder in the style of the other migration shape tests — pins
 * column names/types, FK targets + on-delete behavior, the status CHECK, the
 * one-open-action-per-contact partial unique indexes, and idempotent re-runs.
 */

const partA = require('../models/migrations/20260705000110_short_codes_click_tracking');
const partB = require('../models/migrations/20260705000120_click_followup_actions');
const guardExempt = require('../models/migrations/20260705010010_message_drafts_guard_exempt_click_followup');

function tableRecorder(record) {
  const col = (type) => (name, ...args) => {
    const entry = { type, name, args };
    record.columns.push(entry);
    const chain = {
      primary: () => { entry.primary = true; return chain; },
      notNullable: () => { entry.notNullable = true; return chain; },
      nullable: () => chain,
      defaultTo: (v) => { entry.defaultTo = v; return chain; },
      references: (c) => { entry.references = c; return chain; },
      inTable: (t) => { entry.inTable = t; return chain; },
      onDelete: (a) => { entry.onDelete = a; return chain; },
      unique: () => { entry.unique = true; return chain; },
    };
    return chain;
  };
  return {
    uuid: col('uuid'),
    string: col('string'),
    text: col('text'),
    boolean: col('boolean'),
    timestamp: col('timestamp'),
    timestamps: (...args) => record.columns.push({ type: 'timestamps', name: 'timestamps', args }),
    index: (cols, name) => record.indexes.push({ cols, name }),
  };
}

function fakeKnex({ existingColumns = {}, existingTables = [] } = {}) {
  const state = {
    raw: [],
    alters: {},   // table -> { columns, indexes }
    creates: {},  // table -> { columns, indexes }
  };
  const knex = jest.fn(() => ({
    columnInfo: jest.fn(async () => existingColumns),
  }));
  knex.fn = { now: jest.fn(() => 'NOW()') };
  knex.raw = jest.fn((sql) => { state.raw.push(String(sql)); return String(sql); });
  knex.schema = {
    hasTable: jest.fn(async (t) => existingTables.includes(t)),
    createTable: jest.fn(async (t, cb) => {
      const record = { columns: [], indexes: [] };
      state.creates[t] = record;
      cb(tableRecorder(record));
    }),
    alterTable: jest.fn(async (t, cb) => {
      const record = { columns: [], indexes: [] };
      state.alters[t] = record;
      cb(tableRecorder(record));
    }),
    dropTableIfExists: jest.fn(async () => undefined),
  };
  knex.state = state;
  return knex;
}

const byName = (record, name) => record.columns.find((c) => c.name === name);

describe('20260705000110 short_codes click tracking', () => {
  test('adds the linkage columns to short_codes with FK + index on lead_id', async () => {
    const knex = fakeKnex();
    await partA.up(knex);

    const alter = knex.state.alters.short_codes;
    const leadId = byName(alter, 'lead_id');
    expect(leadId).toMatchObject({ type: 'uuid', references: 'id', inTable: 'leads', onDelete: 'SET NULL' });
    expect(alter.indexes).toEqual(expect.arrayContaining([expect.objectContaining({ cols: ['lead_id'] })]));

    expect(byName(alter, 'channel')).toMatchObject({ type: 'string', args: [20] });
    expect(byName(alter, 'purpose')).toMatchObject({ type: 'string', args: [40] });
    expect(byName(alter, 'message_ref')).toMatchObject({ type: 'string', args: [60] });
  });

  test('creates short_code_clicks: per-click rows with hashed IP, never raw', async () => {
    const knex = fakeKnex();
    await partA.up(knex);

    const create = knex.state.creates.short_code_clicks;
    expect(create).toBeDefined();
    expect(byName(create, 'short_code_id')).toMatchObject({
      type: 'uuid', notNullable: true, references: 'id', inTable: 'short_codes', onDelete: 'CASCADE',
    });
    expect(byName(create, 'clicked_at')).toMatchObject({ type: 'timestamp', notNullable: true });
    // sha256 hex is 64 chars; there must be NO raw-ip column on the click row.
    expect(byName(create, 'ip_hash')).toMatchObject({ type: 'string', args: [64] });
    expect(byName(create, 'ip')).toBeUndefined();
    expect(byName(create, 'user_agent')).toMatchObject({ type: 'text' });
    const isBot = byName(create, 'is_bot');
    expect(isBot).toMatchObject({ type: 'boolean', notNullable: true, defaultTo: false });
    expect(create.indexes).toEqual(expect.arrayContaining([
      expect.objectContaining({ cols: ['short_code_id'] }),
      expect.objectContaining({ cols: ['clicked_at'] }),
    ]));
  });

  test('idempotent: existing columns + table are left alone on re-run', async () => {
    const knex = fakeKnex({
      existingColumns: { lead_id: {}, channel: {}, purpose: {}, message_ref: {} },
      existingTables: ['short_code_clicks'],
    });
    await partA.up(knex);

    expect(knex.state.alters.short_codes.columns).toEqual([]);
    expect(knex.schema.createTable).not.toHaveBeenCalled();
  });
});

describe('20260705000120 click_followup_actions', () => {
  test('creates the queue table with contact FKs and the draft back-pointer', async () => {
    const knex = fakeKnex();
    await partB.up(knex);

    const create = knex.state.creates.click_followup_actions;
    expect(create).toBeDefined();
    expect(byName(create, 'short_code_id')).toMatchObject({
      type: 'uuid', notNullable: true, references: 'id', inTable: 'short_codes',
    });
    // Per-CLICK anchor for the cron's candidate anti-join: a terminal action
    // for an old click must not shadow a fresh re-click of the same code.
    expect(byName(create, 'short_code_click_id')).toMatchObject({
      type: 'uuid', references: 'id', inTable: 'short_code_clicks', onDelete: 'SET NULL',
    });
    expect(byName(create, 'customer_id')).toMatchObject({ references: 'id', inTable: 'customers', onDelete: 'SET NULL' });
    expect(byName(create, 'lead_id')).toMatchObject({ references: 'id', inTable: 'leads', onDelete: 'SET NULL' });
    // Persisted last-10 phone - cross-tick dedupe key for contactless clicks.
    expect(byName(create, 'contact_phone')).toMatchObject({ type: 'string', args: [20] });
    expect(byName(create, 'entity_type')).toMatchObject({ type: 'string' });
    expect(byName(create, 'entity_id')).toMatchObject({ type: 'uuid' });
    expect(byName(create, 'clicked_at')).toMatchObject({ type: 'timestamp' });
    expect(byName(create, 'status')).toMatchObject({ type: 'string', notNullable: true, defaultTo: 'pending' });
    expect(byName(create, 'draft_id')).toMatchObject({ references: 'id', inTable: 'message_drafts', onDelete: 'SET NULL' });
    expect(byName(create, 'converted_at')).toMatchObject({ type: 'timestamp' });
  });

  test('status CHECK + one-open-action-per-contact partial unique guards', async () => {
    const knex = fakeKnex();
    await partB.up(knex);

    const sql = knex.state.raw.join('\n');
    // 'sent' (owner approved, nudge went out) is a terminal outcome status —
    // allowed by the CHECK, but deliberately OUTSIDE the open-claim partial
    // uniques below so a sent nudge never blocks a future re-click.
    expect(sql).toContain("CHECK (status IN ('pending','drafted','sent','dismissed','converted','expired'))");
    // Partial: only OPEN rows contend — terminal rows never block future actions.
    expect(sql).toContain('CREATE UNIQUE INDEX click_followup_actions_open_customer_uniq');
    expect(sql).toContain("WHERE customer_id IS NOT NULL AND status IN ('pending','drafted')");
    expect(sql).toContain('CREATE UNIQUE INDEX click_followup_actions_open_lead_uniq');
    expect(sql).toContain("WHERE lead_id IS NOT NULL AND status IN ('pending','drafted')");
    expect(sql).toContain('CREATE UNIQUE INDEX click_followup_actions_open_phone_uniq');
    expect(sql).toContain("WHERE contact_phone IS NOT NULL AND status IN ('pending','drafted')");
  });

  test('idempotent: skips entirely when the table already exists', async () => {
    const knex = fakeKnex({ existingTables: ['click_followup_actions'] });
    await partB.up(knex);
    expect(knex.schema.createTable).not.toHaveBeenCalled();
    expect(knex.state.raw).toEqual([]);
  });
});

describe('20260705010010 message_drafts guard exemption (splice, not clobber, precedence-safe)', () => {
  // Parenthesized shape: 20260613000010's guard + an unrelated pre-existing
  // exemption (PR #2357's campaign clause) — the merge-order hazard fixture.
  const PAREN_WITH_CAMPAIGN = `CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    declare
      enabled boolean;
    begin
      if (NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow')
         and not coalesce(NEW.campaign_type is not null and NEW.status = 'pending', false) then
        select lower(value) = 'true' into enabled
          from system_config where key = 'legacy_ai_drafts_enabled';
        if coalesce(enabled, false) is not true then
          raise exception 'legacy_ai_drafts_disabled' using errcode = 'P0001';
        end if;
      end if;
      return new;
    end;
    $function$;`;

  // VERBATIM prod shape (pulled via pg_get_functiondef during prod
  // verification): the guard condition is UNPARENTHESIZED, and comment lines
  // sit above the IF — one contains both 'pending' and the word 'if' to pin
  // that the splice never anchors into comments. This shape is what caught
  // the precedence bug: appending `and not C` before THEN parses as
  // `A or (B and not C)`, leaving the exemption dead.
  const PROD_VERBATIM = `CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $function$
    declare
      enabled boolean;
    begin
      -- Exempt house-voice shadow telemetry; decide if legacy 'pending'
      -- drafts may insert via the system_config kill switch below.
      if NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow' then
        select lower(value) = 'true' into enabled
          from system_config where key = 'legacy_ai_drafts_enabled';
        if coalesce(enabled, false) is not true then
          raise exception 'legacy_ai_drafts_disabled' using errcode = 'P0001';
        end if;
      end if;
      return new;
    end;
    $function$;`;

  // Unparenthesized prod shape AFTER another PR's clause landed on it.
  const UNPAREN_WITH_CAMPAIGN = PROD_VERBATIM.replace(
    "is distinct from 'shadow' then",
    "is distinct from 'shadow' and not coalesce(NEW.campaign_type is not null and NEW.status = 'pending', false) then",
  );

  // LIVE post-#2357 prod text (verbatim pg_get_functiondef, pulled 2026-07-05
  // AFTER #2357 merged + deployed): its campaign migration
  // (20260705000502_message_drafts_guard_exempt_campaigns) ran FIRST in prod,
  // wrapping the whole condition and appending ` and NEW.campaign_type is
  // null` — NOT the coalesce shape the two fixtures above guessed pre-merge.
  // This is the exact text 20260705010010 meets when it runs in prod, so the
  // composed splice must keep BOTH exemptions live. (The guessed-shape
  // fixtures stay for anchor-robustness coverage.)
  const PROD_LIVE_AFTER_2357 = `CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()
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
      if (NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow') and NEW.campaign_type is null then
        select lower(value) = 'true' into enabled
          from system_config where key = 'legacy_ai_drafts_enabled';
        if coalesce(enabled, false) is not true then
          raise exception 'legacy_ai_drafts_disabled' using errcode = 'P0001';
        end if;
      end if;
      return new;
    end;
    $function$`;

  // Fake knex for the splice migration: the pg_get_functiondef SELECT returns
  // the configured live definition; every other raw() is recorded as executed.
  function spliceKnex(liveDef) {
    const executed = [];
    const knex = {
      executed,
      raw: jest.fn(async (sql) => {
        if (/pg_get_functiondef/.test(String(sql))) {
          return { rows: liveDef == null ? [] : [{ def: liveDef }] };
        }
        executed.push(String(sql));
        return { rows: [] };
      }),
    };
    return knex;
  }

  // ── Semantic evaluator ────────────────────────────────────────────────
  // Extracts the guard's IF condition (comment-aware, same anchor rules as
  // the migration) and evaluates it for a given NEW row with SQL precedence
  // (JS && binds tighter than ||, same as SQL AND/OR; parens preserved).
  // Condition TRUE → the legacy-flag check runs → the insert RAISES with the
  // flag off. This is what actually catches the precedence bug: the buggy
  // unwrapped splice yields `A or (B and not C)` = true for a click-followup
  // insert, and this evaluator faithfully reproduces that.
  function ownedGuardCondition(sql) {
    const anchor = sql.indexOf("NEW.drafter is distinct from 'house_voice'");
    expect(anchor).toBeGreaterThan(-1);
    const head = sql.slice(0, anchor);
    let owningIf = null;
    for (const m of head.matchAll(/\bif\b/gi)) {
      const lineStart = head.lastIndexOf('\n', m.index) + 1;
      if (!head.slice(lineStart, m.index).includes('--')) owningIf = m;
    }
    expect(owningIf).not.toBeNull();
    const thenMatch = /\bthen\b/i.exec(sql.slice(anchor));
    expect(thenMatch).not.toBeNull();
    return sql.slice(owningIf.index + owningIf[0].length, anchor + thenMatch.index);
  }

  function raisesWithFlagOff(sql, NEW) {
    const lit = (v) => (v === null ? 'null' : JSON.stringify(v));
    const expr = ownedGuardCondition(sql)
      .replace(/NEW\.drafter is distinct from 'house_voice'/gi, lit(NEW.drafter !== 'house_voice'))
      .replace(/NEW\.status is distinct from 'shadow'/gi, lit(NEW.status !== 'shadow'))
      .replace(/NEW\.status = 'pending'/gi, lit(NEW.status === 'pending'))
      .replace(/NEW\.intent = any \(ARRAY\['click_followup'\]::text\[\]\)/gi,
        NEW.intent == null ? 'null' : lit(NEW.intent === 'click_followup'))
      .replace(/NEW\.campaign_type is not null/gi, lit(NEW.campaign_type != null))
      .replace(/NEW\.campaign_type is null/gi, lit(NEW.campaign_type == null))
      .replace(/\bcoalesce\b/gi, 'COALESCE')
      .replace(/\band\b/gi, '&&')
      .replace(/\bor\b/gi, '||')
      .replace(/\bnot\b/gi, '!');
    // eslint-disable-next-line no-new-func
    const value = new Function('COALESCE', `return (${expr});`)(
      (v, d) => (v === null || v === undefined ? d : v),
    );
    return value === true;
  }

  const CLICK_INSERT = { drafter: null, status: 'pending', intent: 'click_followup' };
  const HOUSE_VOICE_SHADOW = { drafter: 'house_voice', status: 'shadow', intent: null };
  const NULL_INTENT_PENDING = { drafter: null, status: 'pending', intent: null };
  const PLAIN_LEGACY = { drafter: null, status: 'sent', intent: null };
  const CAMPAIGN_INSERT = { drafter: null, status: 'pending', intent: null, campaign_type: 'upsell' };

  // The full splice table runs against every starting shape that carries a
  // sibling campaign clause: the two pre-merge guesses (parenthesized 20260613
  // form + verbatim UNPARENTHESIZED prod form, coalesce-style clause) and the
  // LIVE post-#2357 prod text (parenthesize-and-append clause, as actually
  // deployed). Third column: the campaign-clause text that must survive.
  // Fourth: whether a campaign insert raises with the flag off — TRUE only
  // for the UNPAREN fixture, whose bare-appended sibling clause is
  // semantically dead by the same OR/AND precedence bug this suite pins (our
  // splice must PRESERVE it textually, not resurrect it); in the fixtures
  // whose campaign clause is live it must STAY live through our splice.
  const SHAPES = [
    ['parenthesized 20260613 shape + campaign clause', PAREN_WITH_CAMPAIGN, 'NEW.campaign_type is not null', false],
    ['VERBATIM unparenthesized prod shape + campaign clause', UNPAREN_WITH_CAMPAIGN, 'NEW.campaign_type is not null', true],
    ['LIVE post-#2357 prod shape (campaign exemption deployed first)', PROD_LIVE_AFTER_2357, 'NEW.campaign_type is null', false],
  ];

  for (const [label, fixture, campaignMarker, campaignInsertRaises] of SHAPES) {
    describe(label, () => {
      test('up splices precedence-safely and preserves every other clause', async () => {
        const knex = spliceKnex(fixture);
        await guardExempt.up(knex);

        expect(knex.executed).toHaveLength(1);
        const sql = knex.executed[0];
        // Textual preservation.
        expect(sql).toContain("NEW.status = 'pending' and NEW.intent = any (ARRAY['click_followup']::text[])");
        expect(sql).toContain(campaignMarker);
        expect(sql).toContain("NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow'");
        expect(sql).toContain("raise exception 'legacy_ai_drafts_disabled'");
        // Semantic pins with the legacy flag OFF (the precedence bug made
        // the first assertion fail on the unparenthesized shape):
        expect(raisesWithFlagOff(sql, CLICK_INSERT)).toBe(false);       // exemption WORKS
        // Sibling campaign exemption keeps ITS semantics (live stays live,
        // the dead bare-append fixture stays dead — never resurrected).
        expect(raisesWithFlagOff(sql, CAMPAIGN_INSERT)).toBe(campaignInsertRaises);
        expect(raisesWithFlagOff(sql, HOUSE_VOICE_SHADOW)).toBe(false); // still exempt
        expect(raisesWithFlagOff(sql, NULL_INTENT_PENDING)).toBe(true); // NULL intent still blocked
        expect(raisesWithFlagOff(sql, PLAIN_LEGACY)).toBe(true);        // legacy queue still blocked
      });

      test('up is idempotent on its own output', async () => {
        const first = spliceKnex(fixture);
        await guardExempt.up(first);
        const second = spliceKnex(first.executed[0]);
        await guardExempt.up(second);
        expect(second.executed).toHaveLength(0);
      });

      test("down splice-removes ONLY our clause, restoring pre-splice semantics and keeping the other PR's clause", async () => {
        const up = spliceKnex(fixture);
        await guardExempt.up(up);
        const down = spliceKnex(up.executed[0]);
        await guardExempt.down(down);

        expect(down.executed).toHaveLength(1);
        const sql = down.executed[0];
        expect(sql).not.toContain('click_followup');
        expect(sql).toContain(campaignMarker);
        expect(sql).toContain("raise exception 'legacy_ai_drafts_disabled'");
        // Semantics revert: click-followup inserts raise again; house-voice
        // shadow stays exempt and the sibling campaign clause keeps its
        // pre-splice semantics.
        expect(raisesWithFlagOff(sql, CLICK_INSERT)).toBe(true);
        expect(raisesWithFlagOff(sql, CAMPAIGN_INSERT)).toBe(campaignInsertRaises);
        expect(raisesWithFlagOff(sql, HOUSE_VOICE_SHADOW)).toBe(false);
      });
    });
  }

  test('splice never anchors into the comment lines above the guard (prod carries them)', async () => {
    const knex = spliceKnex(PROD_VERBATIM);
    await guardExempt.up(knex);

    const sql = knex.executed[0];
    // Comments (containing both 'pending' and the word 'if') are untouched…
    expect(sql).toContain("-- Exempt house-voice shadow telemetry; decide if legacy 'pending'");
    expect(sql).toContain('-- drafts may insert via the system_config kill switch below.');
    // …and the wrap starts at the REAL if: the whole original condition is
    // parenthesized with our clause ANDed outside it.
    expect(sql).toMatch(/\bif \(NEW\.drafter is distinct from 'house_voice' or NEW\.status is distinct from 'shadow'\)/);
    // Semantic pins on the bare prod shape too.
    expect(raisesWithFlagOff(sql, CLICK_INSERT)).toBe(false);
    expect(raisesWithFlagOff(sql, HOUSE_VOICE_SHADOW)).toBe(false);
    expect(raisesWithFlagOff(sql, NULL_INTENT_PENDING)).toBe(true);
    expect(raisesWithFlagOff(sql, PLAIN_LEGACY)).toBe(true);
  });

  test('up fresh-replay fallback: no live function → full static guard (house-voice + allowlist + kill switch)', async () => {
    const knex = spliceKnex(null);
    await guardExempt.up(knex);

    expect(knex.executed).toHaveLength(1);
    const sql = knex.executed[0];
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()');
    expect(sql).toContain("ARRAY['click_followup']");
    expect(raisesWithFlagOff(sql, CLICK_INSERT)).toBe(false);
    expect(raisesWithFlagOff(sql, HOUSE_VOICE_SHADOW)).toBe(false);
    expect(raisesWithFlagOff(sql, NULL_INTENT_PENDING)).toBe(true);
    expect(raisesWithFlagOff(sql, PLAIN_LEGACY)).toBe(true);
  });

  test('up fails loudly on an unrecognized function shape instead of clobbering it', async () => {
    const knex = spliceKnex('CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled() ... totally rewritten ...');
    await expect(guardExempt.up(knex)).rejects.toThrow(/unrecognized shape/);
    expect(knex.executed).toHaveLength(0);
  });

  test('down is a no-op when the clause is absent', async () => {
    const knex = spliceKnex(PROD_VERBATIM);
    await guardExempt.down(knex);
    expect(knex.executed).toHaveLength(0);
  });
});
