// The one-tap correction reason (AI acceleration scope idea D, PR 2): one
// closed list, read the same way by both review routes, mirrored on the client,
// pinned by the migration's CHECK, and projected by the corrections view.
const fs = require('fs');
const path = require('path');
const { CORRECTION_REASONS, readCorrectionReason } = require('../services/correction-reasons');
const migration = require('../models/migrations/20261002140000_correction_reason');

describe('readCorrectionReason', () => {
  test('absent or blank is no reason, never an error', () => {
    for (const v of [undefined, null, '']) expect(readCorrectionReason(v)).toEqual({ reason: null });
  });
  test('each of the five is accepted as itself (trimmed)', () => {
    for (const r of CORRECTION_REASONS) expect(readCorrectionReason(` ${r} `)).toEqual({ reason: r });
  });
  test('anything else is an error naming the five', () => {
    const out = readCorrectionReason('bad_vibes');
    expect(out.error).toMatch(/reason must be one of wrong_fact, wrong_tone, missing_promise, should_have_escalated, other/);
    expect(readCorrectionReason({ x: 1 }).error).toBeTruthy();
  });
  test('the client mirror gives every reason a label', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'constants', 'correctionReasons.js'), 'utf8');
    for (const r of CORRECTION_REASONS) expect(src).toMatch(new RegExp(`value: "${r}", label: "[A-Z][^"]+"`));
  });
});

describe('the list is the same everywhere', () => {
  test('the client mirror lists the same values in the same order', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', 'constants', 'correctionReasons.js'), 'utf8');
    const values = [...src.matchAll(/value: "([a-z_]+)"/g)].map((m) => m[1]);
    expect(values).toEqual(CORRECTION_REASONS);
  });
  test('the migration CHECK pins the same five (a literal on purpose: a migration never follows a live constant)', () => {
    expect(migration.REASONS).toEqual(CORRECTION_REASONS);
  });
});

describe('migration 20261002140000', () => {
  function buildKnex({ column = false } = {}) {
    const state = { raw: [], ops: [] };
    const t = { string: jest.fn((...a) => { state.ops.push(['string', ...a]); }), dropColumn: jest.fn((...a) => { state.ops.push(['dropColumn', ...a]); }) };
    const knex = {
      schema: { hasColumn: jest.fn(async () => column), alterTable: jest.fn(async (_n, fn) => fn(t)) },
      raw: jest.fn(async (sql) => { state.raw.push(sql); }),
    };
    return { knex, state };
  }
  test('up adds the nullable column once, the closed CHECK, then restates the view with reason as the last column of every branch', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.ops).toEqual([['string', 'correction_reason', 32]]);
    expect(state.raw[0]).toBe('ALTER TABLE agent_decisions DROP CONSTRAINT IF EXISTS agent_decisions_correction_reason_check');
    expect(state.raw[1]).toBe("ALTER TABLE agent_decisions ADD CONSTRAINT agent_decisions_correction_reason_check CHECK (correction_reason IS NULL OR correction_reason IN ('wrong_fact', 'wrong_tone', 'missing_promise', 'should_have_escalated', 'other'))");
    expect(state.raw[2]).toMatch(/^\s*CREATE OR REPLACE VIEW corrections AS/);
    const branches = state.raw[2].match(/\n {4}FROM /g);
    expect(branches).toHaveLength(5);
    const reasonTails = state.raw[2].match(/(d\.correction_reason::text AS reason|\(r\.label ->> 'reason'\)::text|NULL::text)\n {4}FROM /g);
    expect(reasonTails).toHaveLength(5);
    expect(state.raw[2]).toMatch(/AS reason\n/);
  });
  test('up with the column already present never re-adds it', async () => {
    const { knex, state } = buildKnex({ column: true });
    await migration.up(knex);
    expect(state.ops).toEqual([]);
  });
  test('down drops the view, restores the fourth cut, then drops the CHECK and the column', async () => {
    const { knex, state } = buildKnex({ column: true });
    await migration.down(knex);
    expect(state.raw[0]).toBe('DROP VIEW IF EXISTS corrections');
    expect(state.raw[1]).toMatch(/^\s*CREATE OR REPLACE VIEW corrections AS/);
    expect(state.raw[1]).not.toMatch(/AS reason/);
    expect(state.raw[2]).toBe('ALTER TABLE agent_decisions DROP CONSTRAINT IF EXISTS agent_decisions_correction_reason_check');
    expect(state.ops).toEqual([['dropColumn', 'correction_reason']]);
  });
});

describe('migration 20261002150000 (the fifth cut plus reason; 140000 is frozen against the fourth)', () => {
  const sixth = require('../models/migrations/20261002150000_correction_reason_view');
  function buildKnex() {
    const state = { raw: [], ops: [] };
    const t = { string: jest.fn((...a) => { state.ops.push(['string', ...a]); }), dropColumn: jest.fn((...a) => { state.ops.push(['dropColumn', ...a]); }) };
    const knex = { schema: { hasColumn: jest.fn(async () => true), alterTable: jest.fn(async (_n, fn) => fn(t)) }, raw: jest.fn(async (sql) => { state.raw.push(sql); }) };
    return { knex, state };
  }
  test('up restates the view with all six sources and reason as the last column of every branch', async () => {
    const { knex, state } = buildKnex();
    await sixth.up(knex);
    expect(state.raw).toHaveLength(1);
    expect(state.raw[0]).toMatch(/^\s*CREATE OR REPLACE VIEW corrections AS/);
    expect(state.raw[0].match(/\n {4}FROM /g)).toHaveLength(6);
    expect(state.raw[0].match(/(d\.correction_reason::text AS reason|\(r\.label ->> 'reason'\)::text|NULL::text)\n {4}FROM /g)).toHaveLength(6);
    for (const source of ['reply_training', 'parked_decision_ids', 'subject_hash', 'review_verdict']) expect(state.raw[0]).toContain(source);
    expect(state.ops).toEqual([]);
  });
  test('down drops the view and restores the fourth cut plus reason (140000) without touching the column', async () => {
    const { knex, state } = buildKnex();
    await sixth.down(knex);
    expect(state.raw[0]).toBe('DROP VIEW IF EXISTS corrections');
    const view = state.raw.find((q) => /CREATE OR REPLACE VIEW corrections AS/.test(q));
    expect(view.match(/\n {4}FROM /g)).toHaveLength(5);
    expect(view).toMatch(/AS reason\n/);
    expect(state.ops).toEqual([]); // the column exists already: 140000's up never re-adds it
  });
});

