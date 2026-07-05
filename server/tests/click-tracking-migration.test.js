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
    expect(sql).toContain("CHECK (status IN ('pending','drafted','dismissed','converted','expired'))");
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

describe('20260705010010 message_drafts guard exemption', () => {
  test('up: pending click_followup inserts pass the trigger with the legacy flag OFF', async () => {
    const knex = fakeKnex();
    await guardExempt.up(knex);

    const sql = knex.state.raw.join('\n');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.block_message_drafts_when_disabled()');
    // House-voice shadow exemption retained verbatim.
    expect(sql).toContain("NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow'");
    // New owner-review allowlist: pending + click_followup skips the legacy
    // kill-switch check entirely (insert succeeds with the flag off).
    expect(sql).toContain("NEW.status = 'pending' and NEW.intent = any (ARRAY['click_followup']::text[])");
    // Three-valued-logic guard: a NULL intent must NOT satisfy the allowlist.
    expect(sql).toMatch(/not coalesce\(\s*NEW\.status = 'pending'/);
    // Legacy path still enforced.
    expect(sql).toContain("raise exception 'legacy_ai_drafts_disabled'");
  });

  test('down: restores the house-voice-only guard (no click_followup exemption)', async () => {
    const knex = fakeKnex();
    await guardExempt.down(knex);

    const sql = knex.state.raw.join('\n');
    expect(sql).toContain("NEW.drafter is distinct from 'house_voice' or NEW.status is distinct from 'shadow'");
    expect(sql).not.toContain('click_followup');
    expect(sql).toContain("raise exception 'legacy_ai_drafts_disabled'");
  });
});
