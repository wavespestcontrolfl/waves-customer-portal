/**
 * 20260828000040 — Backlink Manager v2 step 1 migration.
 * Source-reading + fake-knex: the frozen enum literals equal the service enums
 * (drift ⇒ a NEW migration, never an edit here), every §3 table is created with
 * its CHECKs/partial-unique indexes, the placements key widens to
 * (target_domain, target_page, location_key) AFTER location_key is backfilled,
 * both backfills run inside up(), and down() mirrors the whole thing.
 */
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'models/migrations/20260828000040_backlink_registry_step1.js');
const migration = require(MIG);
const R = require('../services/seo/link-registry');

jest.mock('../services/seo/link-registry-backfill', () => ({
  backfillLegacyAttempts: jest.fn(async () => ({ copied: 0, scanned: 0 })),
  backfillLegacyBoard: jest.fn(async () => ({})),
}));
const backfill = require('../services/seo/link-registry-backfill');

function fakeKnex({ existing = [] } = {}) {
  const raws = [];
  const created = {};
  const altered = {};
  const table = (cb, name) => {
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
  const knex = Object.assign(jest.fn(() => ({ columnInfo: async () => ({}) })), {
    raw: jest.fn(async (sql) => { raws.push(String(sql)); return {}; }),
    fn: { now: () => 'now()' },
    schema: {
      hasTable: jest.fn(async (name) => existing.includes(name)),
      createTable: jest.fn(async (name, cb) => { created[name] = table(cb, name); }),
      alterTable: jest.fn(async (name, cb) => { altered[name] = table(cb, name); }),
      dropTableIfExists: jest.fn(async () => {}),
    },
  });
  knex._raws = raws; knex._created = created; knex._altered = altered;
  return knex;
}

const src = fs.readFileSync(MIG, 'utf8');
const literal = (name) => {
  const m = src.match(new RegExp(`^const ${name} = (\\[[^\\n]*\\]);`, 'm'));
  if (!m) throw new Error(`no literal for ${name}`);
  return JSON.parse(m[1].replace(/'/g, '"'));
};

describe('frozen enum literals == services/seo/link-registry.js', () => {
  test.each([
    ['LINK_SOURCES'], ['AGENT_STATES'], ['DISCOVERY_PRIORITIES'], ['ACQUISITION_TYPES'], ['EXPECTED_REL'], ['EXPECTED_INDEXABILITY'],
    ['EXPECTED_PERSISTENCE'], ['RENEWAL_PERIODS'], ['PATH_LINK_TYPES'], ['ATTEMPT_PROVIDERS'], ['ATTEMPT_ACTIONS'], ['ATTEMPT_OUTCOMES'],
    ['AUTHORITY_DIMENSIONS'], ['AUTHORITY_LEVELS'],
  ])('%s', (name) => {
    expect(literal(name)).toEqual([...R[name]]);
  });
  test('the migration requires no service enum (literals are frozen at migration time)', () => {
    expect(src).not.toMatch(/require\(['"][^'"]*link-registry['"]\)/);
  });
});

describe('up()', () => {
  test('creates the five §3 tables with CHECKs, partial-unique indexes, and the deferred best_path_id FK', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(Object.keys(knex._created).sort()).toEqual(['seo_link_acquisition_paths', 'seo_link_attempts', 'seo_link_domain_sources', 'seo_link_domains', 'seo_link_placement_authorities']);
    const raws = knex._raws.join('\n');
    // CHECKs on every enum column
    for (const c of ['seo_link_domains_source_check', 'seo_link_domains_agent_state_check', 'seo_link_domains_discovery_priority_check',
      'seo_link_acquisition_paths_type_check', 'seo_link_acquisition_paths_link_type_check', 'seo_link_acquisition_paths_expected_rel_check',
      'seo_link_acquisition_paths_renewal_period_check', 'seo_link_acquisition_paths_provider_override_check', 'seo_link_acquisition_paths_confidence_check',
      'seo_link_domain_sources_source_check', 'seo_link_placement_authorities_dimension_check', 'seo_link_placement_authorities_level_check',
      'seo_link_attempts_provider_check', 'seo_link_attempts_action_check', 'seo_link_attempts_outcome_check']) {
      expect(raws).toContain(`ADD CONSTRAINT ${c} CHECK`);
    }
    expect(raws).toMatch(/seo_link_domains_source_check CHECK \(source IN \('owner_seed', 'list_import'.*'legacy_unknown'\)\)/);
    expect(raws).toMatch(/seo_link_placement_authorities_level_check CHECK \(level IN \((?!.*OWNER_OVERRIDE).*'INVALID'\)\)/);
    expect(raws).toMatch(/seo_link_acquisition_paths_link_type_check CHECK \(link_type IN \('editorial', 'resource', 'guest_post', 'haro', 'directory', 'citation', 'social'\)\)/);
    // nullable enums allow NULL
    expect(raws).toMatch(/expected_rel_check CHECK \(expected_rel IS NULL OR expected_rel IN/);
    // partial unique indexes (Postgres UNIQUE treats NULLs as distinct — the plan's identity rules need these)
    expect(raws).toContain('CREATE UNIQUE INDEX IF NOT EXISTS seo_link_acquisition_paths_active_key_uniq ON seo_link_acquisition_paths (domain_id, path_key) WHERE superseded_by IS NULL');
    expect(raws).toContain('CREATE UNIQUE INDEX IF NOT EXISTS seo_link_attempts_legacy_attempt_id_uniq ON seo_link_attempts (legacy_attempt_id) WHERE legacy_attempt_id IS NOT NULL');
    expect(raws).toContain('ALTER TABLE seo_link_domains ADD CONSTRAINT seo_link_domains_best_path_id_foreign FOREIGN KEY (best_path_id) REFERENCES seo_link_acquisition_paths(id) ON DELETE SET NULL');
    // §3.2: every authority-relevant boolean NOT NULL; path_key NOT NULL; the four revision counters
    const paths = knex._created.seo_link_acquisition_paths;
    const notNull = (name) => paths.some((c) => c.args[0] === name && c.mods.some(([m]) => m === 'notNullable'));
    for (const b of ['account_required', 'email_verification', 'payment_required', 'legal_attestation', 'agent_completable', 'baseline', 'link_type', 'path_key', 'revision', 'revision_payment', 'revision_communication', 'revision_execution']) {
      expect({ b, notNull: notNull(b) }).toEqual({ b, notNull: true });
    }
    // §3.3b unique per (prospect, dimension, instance_key); §3.4b unique per (domain, touch_key)
    expect(knex._created.seo_link_placement_authorities.find((c) => c.method === 'unique').args[0]).toEqual(['prospect_id', 'dimension', 'instance_key']);
    expect(knex._created.seo_link_domain_sources.find((c) => c.method === 'unique').args[0]).toEqual(['domain_id', 'touch_key']);
    // §3.4 slot cap index
    expect(knex._created.seo_link_attempts.some((c) => c.method === 'index' && JSON.stringify(c.args[0]) === JSON.stringify(['slot_day', 'outcome']))).toBe(true);
  });

  test('§3.3 placements: additive columns, location_key backfilled from quality_signals BEFORE the wider key is added; the legacy 2-col unique is KEPT (expand only — old pods still ON CONFLICT on it during the rolling deploy)', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    const added = knex._altered.seo_link_prospects.map((c) => c.args[0]);
    expect(added).toEqual(expect.arrayContaining(['domain_id', 'path_id', 'pending_path_id', 'parked_from_status', 'credential_id', 'location_key', 'authority', 'source_detail', 'paid_through', 'renews_at', 'recurring_merchant']));
    const locationKey = knex._altered.seo_link_prospects.find((c) => c.args[0] === 'location_key');
    expect(locationKey.mods).toEqual(expect.arrayContaining([['notNullable', []], ['defaultTo', ['-']]]));
    const raws = knex._raws;
    const iBackfill = raws.findIndex((r) => /UPDATE seo_link_prospects SET location_key = quality_signals->>'location'/.test(r));
    const iNew = raws.findIndex((r) => r === 'CREATE UNIQUE INDEX IF NOT EXISTS seo_link_prospects_target_domain_target_page_location_key_unique ON seo_link_prospects (target_domain, target_page, location_key)');
    expect(iBackfill).toBeGreaterThan(-1);
    expect(iNew).toBeGreaterThan(iBackfill);
    expect(raws.some((r) => /seo_link_prospects_target_domain_target_page_unique/.test(r))).toBe(false); // never dropped here
    expect(src).toMatch(/step 2's migration CONTRACTS by dropping the legacy/);
    // 'default' and '' never become a location_key (they are '-')
    expect(raws[iBackfill]).toMatch(/NOT IN \('', 'default'\)/);
  });

  test('runs the legacy board backfill and then the attempts backfill, with the migration knex', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(backfill.backfillLegacyBoard).toHaveBeenCalledWith(knex);
    expect(backfill.backfillLegacyAttempts).toHaveBeenCalledWith(knex);
    const order = [backfill.backfillLegacyBoard.mock.invocationCallOrder[0], backfill.backfillLegacyAttempts.mock.invocationCallOrder[0]];
    expect(order[0]).toBeLessThan(order[1]);
  });

  test('idempotent: existing tables are not re-created; existing columns not re-added', async () => {
    const knex = fakeKnex({ existing: ['seo_link_domains', 'seo_link_acquisition_paths', 'seo_link_domain_sources', 'seo_link_placement_authorities', 'seo_link_attempts'] });
    knex.mockImplementation(() => ({ columnInfo: async () => ({ domain_id: {}, path_id: {}, pending_path_id: {}, parked_from_status: {}, credential_id: {}, location_key: {}, authority: {}, source_detail: {}, paid_through: {}, renews_at: {}, recurring_merchant: {} }) }));
    await migration.up(knex);
    expect(knex.schema.createTable).not.toHaveBeenCalled();
    expect(knex._altered.seo_link_prospects).toEqual([]);
    expect(knex._raws.filter((r) => /ADD CONSTRAINT .*_check/.test(r))).toEqual([]);
  });
});

describe('down()', () => {
  test('drops the new tables in FK order, the wide unique, and the new columns (the legacy 2-col unique was never touched)', async () => {
    const knex = fakeKnex({ existing: ['seo_link_prospects', 'seo_link_domains'] });
    knex.mockImplementation(() => ({ columnInfo: async () => ({ domain_id: {}, path_id: {}, location_key: {}, target_domain: {} }) }));
    await migration.down(knex);
    const drops = knex.schema.dropTableIfExists.mock.calls.map((c) => c[0]);
    expect(drops).toEqual(['seo_link_attempts', 'seo_link_placement_authorities', 'seo_link_domain_sources', 'seo_link_acquisition_paths', 'seo_link_domains']);
    expect(knex._raws).toContain('DROP INDEX IF EXISTS seo_link_prospects_target_domain_target_page_location_key_unique');
    expect(knex._raws.some((r) => /ADD CONSTRAINT seo_link_prospects_target_domain_target_page_unique/.test(r))).toBe(false); // it was never dropped
    expect(knex._raws).toContain('ALTER TABLE seo_link_domains DROP CONSTRAINT IF EXISTS seo_link_domains_best_path_id_foreign');
    const dropped = knex._altered.seo_link_prospects.map((c) => c.args[0]);
    expect(dropped).toEqual(['domain_id', 'path_id', 'location_key']); // only columns that exist
    expect(dropped).not.toContain('target_domain');
  });
});
