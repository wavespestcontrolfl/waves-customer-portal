/**
 * 20260903000020 — Backlink Manager v2 step 4b (authority bridge schema).
 * Source-reading + fake-knex: the frozen enum literals equal the service enums
 * (drift ⇒ a NEW migration), the two tables land with every §3.6b / §6.3 1b
 * CHECK, the authority rows gain the §3.3b instance columns + FKs + the
 * one-open-instance partial UNIQUE, placements gain payment_group_id,
 * idempotence, and down() mirrors up().
 */
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'models/migrations/20260903000020_link_authority_bridge_step4b.js');
const migration = require(MIG);
const R = require('../services/seo/link-registry');

const src = fs.readFileSync(MIG, 'utf8');
const literal = (name) => {
  const m = src.match(new RegExp(`^const ${name} = (\\[[^\\n]*\\]);`, 'm'));
  if (!m) throw new Error(`no literal for ${name}`);
  return JSON.parse(m[1].replace(/'/g, '"'));
};

function fakeKnex({ existing = [], columns = {} } = {}) {
  const raws = [];
  const created = {};
  const altered = {};
  const dropped = [];
  const table = (cb) => {
    const cols = [];
    const t = new Proxy({}, {
      get: (_, method) => (...args) => {
        const col = { method, args, mods: [] };
        cols.push(col);
        const chain = new Proxy({}, { get: (__, mod) => (...margs) => { col.mods.push([mod, margs]); return chain; } });
        return chain;
      },
    });
    cb(t);
    return cols;
  };
  const knex = Object.assign(jest.fn(), {
    raw: jest.fn(async (sql) => { raws.push(String(sql)); return {}; }),
    fn: { now: () => 'now()' },
    schema: {
      hasTable: jest.fn(async (name) => existing.includes(name)),
      hasColumn: jest.fn(async (t, c) => (columns[t] || []).includes(c)),
      createTable: jest.fn(async (name, cb) => { created[name] = table(cb); }),
      alterTable: jest.fn(async (name, cb) => { altered[name] = [...(altered[name] || []), ...table(cb)]; }),
      dropTableIfExists: jest.fn(async (name) => { dropped.push(name); }),
    },
  });
  Object.assign(knex, { _raws: raws, _created: created, _altered: altered, _dropped: dropped });
  return knex;
}

describe('frozen enum literals == service enums', () => {
  test.each([
    ['AUTHORITY_DIMENSIONS', R.AUTHORITY_DIMENSIONS], ['APPROVAL_DECISIONS', R.APPROVAL_DECISIONS], ['APPROVAL_ACTIONS', R.APPROVAL_ACTIONS],
    ['APPROVABLE_LEVELS', R.APPROVABLE_LEVELS], ['SATISFIED_REASONS', R.SATISFIED_REASONS], ['END_OUTCOMES', R.END_OUTCOMES],
  ])('%s', (name, expected) => { expect(literal(name)).toEqual([...expected]); });
  test('APPROVABLE_LEVELS are OWNER_* levels minus OVERRIDE / MANUAL_PAYMENT / INPUT_REQUIRED', () => {
    for (const l of R.APPROVABLE_LEVELS) { expect(l.startsWith('OWNER_')).toBe(true); expect(R.AUTHORITY_LEVELS).toContain(l); }
    expect(R.APPROVABLE_LEVELS).not.toContain('OWNER_MANUAL_PAYMENT');
    expect(R.APPROVABLE_LEVELS).not.toContain('OWNER_INPUT_REQUIRED');
  });
  test('ACTIONS_BY_DIMENSION partitions APPROVAL_ACTIONS', () => {
    expect(Object.values(R.ACTIONS_BY_DIMENSION).flat().sort()).toEqual([...R.APPROVAL_ACTIONS].sort());
  });
  test('the migration requires no service module', () => { expect(src).not.toMatch(/require\(/); });
});

describe('up()', () => {
  test('creates waivers + approvals with their CHECKs, the instance columns, FKs, the partial unique, payment_group_id', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    const waivers = knex._created.seo_link_floor_waivers.map((c) => c.args[0]);
    expect(waivers).toEqual(expect.arrayContaining(['domain_id', 'path_id', 'overridden_floors', 'decision_inputs_hash', 'approved_by', 'approved_at', 'invalidated_at']));
    expect(knex._raws.some((r) => r.includes('seo_link_floor_waivers_active_idx') && r.includes('WHERE invalidated_at IS NULL'))).toBe(true);
    const approvals = knex._created.seo_link_approvals.map((c) => c.args[0]);
    expect(approvals).toEqual(expect.arrayContaining(['prospect_id', 'path_id', 'path_revision', 'decision_inputs_hash', 'money_action', 'decision', 'authority', 'approved_amount_cents', 'max_payable_cents', 'terms_snapshot', 'dimension', 'action', 'instance_key', 'action_hash', 'approved_by', 'approved_at', 'invalidated_at', 'consumed_at']));
    for (const name of ['decision_check', 'authority_check', 'dimension_check', 'action_check', 'dimension_action_check', 'money_action_check', 'money_terms_check']) {
      expect(knex._raws.some((r) => r.includes(`seo_link_approvals_${name}`))).toBe(true);
    }
    expect(knex._raws.find((r) => r.includes('seo_link_approvals_money_action_check'))).toContain("money_action = (dimension = 'payment')");
    expect(knex._raws.find((r) => r.includes('seo_link_approvals_money_terms_check'))).toContain('max_payable_cents >= approved_amount_cents');
    const auth = knex._altered.seo_link_placement_authorities.map((c) => c.args[0]);
    expect(auth).toEqual(['instance_kind', 'reason', 'satisfied_reason', 'ended_at', 'end_outcome', 'accepted_terms_hash']);
    expect(knex._raws.some((r) => r.includes("split_part(instance_key, ':', 1)"))).toBe(true);
    for (const name of ['satisfied_check', 'satisfied_reason_check', 'ended_check', 'end_outcome_check', 'accepted_terms_check', 'approval_id_fkey', 'floor_waiver_id_fkey']) {
      expect(knex._raws.some((r) => r.includes(`seo_link_placement_authorities_${name}`))).toBe(true);
    }
    expect(knex._raws.find((r) => r.includes('seo_link_placement_authorities_satisfied_check'))).toContain('(satisfied_at IS NULL) = (satisfied_reason IS NULL)');
    expect(knex._raws.some((r) => r.includes('CREATE UNIQUE INDEX IF NOT EXISTS seo_link_placement_authorities_open_instance_uniq') && r.includes('(prospect_id, dimension, instance_kind) WHERE ended_at IS NULL'))).toBe(true);
    expect(knex._altered.seo_link_prospects.map((c) => c.args[0])).toEqual(['payment_group_id', ['payment_group_id']]);
  });
  test('idempotent: existing tables/columns are left alone, the partial unique is still asserted', async () => {
    const knex = fakeKnex({ existing: ['seo_link_floor_waivers', 'seo_link_approvals'], columns: { seo_link_placement_authorities: ['instance_kind'], seo_link_prospects: ['payment_group_id'] } });
    await migration.up(knex);
    expect(knex.schema.createTable).not.toHaveBeenCalled();
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
    expect(knex._raws.filter((r) => r.includes('ADD CONSTRAINT'))).toHaveLength(0);
    expect(knex._raws.some((r) => r.includes('seo_link_placement_authorities_open_instance_uniq'))).toBe(true);
  });
});

describe('down()', () => {
  test('drops payment_group_id, the partial unique, the instance columns + constraints, both tables', async () => {
    const knex = fakeKnex({ columns: { seo_link_placement_authorities: ['instance_kind'], seo_link_prospects: ['payment_group_id'] } });
    await migration.down(knex);
    expect(knex._altered.seo_link_prospects.map((c) => c.args[0])).toEqual(['payment_group_id']);
    expect(knex._raws.some((r) => r.includes('DROP INDEX IF EXISTS seo_link_placement_authorities_open_instance_uniq'))).toBe(true);
    expect(knex._raws.filter((r) => r.includes('DROP CONSTRAINT IF EXISTS seo_link_placement_authorities_'))).toHaveLength(7);
    expect(knex._altered.seo_link_placement_authorities.map((c) => c.args[0])).toEqual(['instance_kind', 'reason', 'satisfied_reason', 'ended_at', 'end_outcome', 'accepted_terms_hash']);
    expect(knex._dropped).toEqual(['seo_link_approvals', 'seo_link_floor_waivers']);
  });
  test('down on a never-migrated schema drops only what exists', async () => {
    const knex = fakeKnex();
    await migration.down(knex);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
    expect(knex._dropped).toEqual(['seo_link_approvals', 'seo_link_floor_waivers']);
  });
});
