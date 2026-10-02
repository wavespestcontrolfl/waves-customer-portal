// The one-tap correction reason (AI acceleration scope idea D, PR 2): one
// closed list, read the same way by both review routes, mirrored on the client,
// pinned by the migration's CHECK, and projected by the corrections view.
const fs = require('fs');
const path = require('path');
const { CORRECTION_REASONS, readCorrectionReason } = require('../services/correction-reasons');
const migration = require('../models/migrations/20261002170000_correction_reason');

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

describe('migration 20261002170000 (the eleventh cut plus reason)', () => {
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
    // six sources, each ending on its reason; the CTEs (counted decisions, linked person sends, canonical reply text) ride along unchanged
    const reasonTails = state.raw[2].match(/(d\.correction_reason::text AS reason|\(r\.label ->> 'reason'\)::text|NULL::text)\n {4}FROM /g);
    expect(reasonTails).toHaveLength(6);
    for (const piece of ['counted_decision', 'human_authored', 'reply_training', 'parked_decision_ids', 'subject_hash', 'review_verdict', 'regexp_replace']) expect(state.raw[2]).toContain(piece);
    expect(state.raw[2]).toMatch(/AS reason\n/);
  });
  test('up with the column already present never re-adds it', async () => {
    const { knex, state } = buildKnex({ column: true });
    await migration.up(knex);
    expect(state.ops).toEqual([]);
  });
  test('down drops the view, then the CHECK and the column, and only then restores the eleventh cut (its d.* would bind the column)', async () => {
    const { knex, state } = buildKnex({ column: true });
    await migration.down(knex);
    expect(state.raw[0]).toBe('DROP VIEW IF EXISTS corrections');
    expect(state.raw[1]).toBe('ALTER TABLE agent_decisions DROP CONSTRAINT IF EXISTS agent_decisions_correction_reason_check');
    expect(state.ops).toEqual([['dropColumn', 'correction_reason']]);
    expect(state.raw[2]).toMatch(/^\s*CREATE OR REPLACE VIEW corrections AS/);
    expect(state.raw[2]).not.toMatch(/AS reason/);
  });
  test('up names the decision columns instead of d.*, so the view never binds a column it does not read', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(state.raw[2]).not.toMatch(/SELECT d\.\*/);
  });
});
