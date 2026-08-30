/**
 * 20260830000020 — Backlink Manager v2 step 2 (bulk intake) migration.
 * Source-reading + fake-knex: the frozen enum literals equal the service enums
 * (drift ⇒ a NEW migration, never an edit here), seo_link_intake_items carries
 * the exact §3.4d columns with item_key UNIQUE + the (state, next_retry_at)
 * claim index + CHECKs on source/state/drop_reason, seo_link_placement_backlinks
 * keeps backlink_id UNIQUE, and down() drops both tables.
 */
const fs = require('fs');
const path = require('path');

const MIG = path.join(__dirname, '..', 'models/migrations/20260830000021_backlink_intake_step2.js');
const migration = require(MIG);
const R = require('../services/seo/link-registry');

function fakeKnex({ existing = [], pathColumns = {} } = {}) {
  const raws = [];
  const created = {};
  const altered = {};
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
  const knex = Object.assign(jest.fn((name) => ({ columnInfo: async () => (name === 'seo_link_acquisition_paths' ? pathColumns : {}) })), {
    raw: jest.fn(async (sql) => { raws.push(String(sql)); return {}; }),
    fn: { now: () => 'now()' },
    schema: {
      hasTable: jest.fn(async (name) => existing.includes(name)),
      createTable: jest.fn(async (name, cb) => { created[name] = table(cb); }),
      alterTable: jest.fn(async (name, cb) => { altered[name] = table(cb); }),
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

const colOf = (cols, name) => cols.find((c) => c.args[0] === name);
const hasMod = (col, mod, args) => col.mods.some(([m, a]) => m === mod && (args === undefined || JSON.stringify(a) === JSON.stringify(args)));

describe('frozen enum literals == services/seo/link-registry.js', () => {
  test.each([['LINK_SOURCES'], ['INTAKE_ITEM_STATES'], ['INTAKE_DROP_REASONS']])('%s', (name) => {
    expect(literal(name)).toEqual([...R[name]]);
  });
  test('the migration requires no service enum (literals are frozen at migration time)', () => {
    expect(src).not.toMatch(/require\(['"][^'"]*link-registry['"]\)/);
  });
});

describe('up()', () => {
  test('seo_link_intake_items: exactly the §3.4d columns, item_key UNIQUE, (state, next_retry_at) claim index, CHECKs on source/state/drop_reason', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(Object.keys(knex._created).sort()).toEqual(['seo_link_intake_items', 'seo_link_placement_backlinks']);
    const items = knex._created.seo_link_intake_items;
    const columns = items.filter((c) => !['unique', 'index'].includes(c.method)).map((c) => [c.method, c.args[0]]);
    expect(columns).toEqual([
      ['uuid', 'id'], ['string', 'source'], ['text', 'source_detail'], ['uuid', 'source_ref'],
      ['text', 'raw_url'], ['text', 'item_key'], ['string', 'state'], ['integer', 'attempts'],
      ['timestamp', 'next_retry_at'], ['text', 'last_error'], ['text', 'resolved_url'], ['text', 'resolved_host'],
      ['uuid', 'domain_id'], ['uuid', 'source_row_id'], ['string', 'drop_reason'], ['jsonb', 'pending_touches'], ['jsonb', 'pending_touches'], ['jsonb', 'pending_touches'],
      ['timestamp', 'first_seen_at'], ['timestamp', 'last_seen_at'],
    ]);
    expect(hasMod(colOf(items, 'id'), 'primary')).toBe(true);
    for (const n of ['source', 'raw_url', 'item_key', 'state', 'attempts', 'first_seen_at', 'last_seen_at']) {
      expect({ n, notNull: hasMod(colOf(items, n), 'notNullable') }).toEqual({ n, notNull: true });
    }
    expect(hasMod(colOf(items, 'state'), 'defaultTo', ['pending'])).toBe(true);
    expect(hasMod(colOf(items, 'attempts'), 'defaultTo', [0])).toBe(true);
    expect(hasMod(colOf(items, 'pending_touches'), 'notNullable')).toBe(true);
    expect(hasMod(colOf(items, 'pending_touches'), 'defaultTo', ['[]'])).toBe(true);
    expect(hasMod(colOf(items, 'pending_touches'), 'notNullable')).toBe(true);
    expect(hasMod(colOf(items, 'pending_touches'), 'defaultTo', ['[]'])).toBe(true);
    expect(hasMod(colOf(items, 'pending_touches'), 'notNullable')).toBe(true);
    expect(hasMod(colOf(items, 'pending_touches'), 'defaultTo', ['[]'])).toBe(true);
    expect(hasMod(colOf(items, 'first_seen_at'), 'defaultTo', ['now()'])).toBe(true);
    expect(hasMod(colOf(items, 'last_seen_at'), 'defaultTo', ['now()'])).toBe(true);
    // source_row_id → the seo_link_domain_sources touch a resolution landed on, SET NULL
    const sourceRow = colOf(items, 'source_row_id');
    expect(hasMod(sourceRow, 'inTable', ['seo_link_domain_sources'])).toBe(true);
    expect(hasMod(sourceRow, 'onDelete', ['SET NULL'])).toBe(true);
    // domain_id → seo_link_domains, SET NULL (a deleted registry row never deletes the audit of what was fed)
    const domainId = colOf(items, 'domain_id');
    expect(hasMod(domainId, 'inTable', ['seo_link_domains'])).toBe(true);
    expect(hasMod(domainId, 'onDelete', ['SET NULL'])).toBe(true);
    // identity + claim index
    expect(items.filter((c) => c.method === 'unique').map((c) => c.args[0])).toEqual([['item_key']]);
    const indexes = items.filter((c) => c.method === 'index').map((c) => c.args[0]);
    expect(indexes).toEqual(expect.arrayContaining([['state', 'next_retry_at'], ['domain_id']]));
    // CHECKs pinned to the service enums
    const raws = knex._raws.join('\n');
    expect(raws).toMatch(/seo_link_intake_items_source_check CHECK \(source IN \('owner_seed', 'list_import'.*'legacy_unknown'\)\)/);
    expect(raws).toContain("seo_link_intake_items_state_check CHECK (state IN ('pending', 'unresolved', 'resolved', 'dropped'))");
    expect(raws).toContain("seo_link_intake_items_drop_reason_check CHECK (drop_reason IS NULL OR drop_reason IN ('never_a_target', 'retry_exhausted', 'invalid_url', 'own_domain'))");
  });

  test('seo_link_placement_backlinks: prospect_id/backlink_id NOT NULL cascading FKs, backlink_id UNIQUE, prospect_id index', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    const map = knex._created.seo_link_placement_backlinks;
    expect(map.filter((c) => !['unique', 'index'].includes(c.method)).map((c) => [c.method, c.args[0]])).toEqual([
      ['uuid', 'id'], ['uuid', 'prospect_id'], ['uuid', 'backlink_id'], ['timestamp', 'created_at'],
    ]);
    const prospect = colOf(map, 'prospect_id');
    expect(hasMod(prospect, 'notNullable')).toBe(true);
    expect(hasMod(prospect, 'inTable', ['seo_link_prospects'])).toBe(true);
    expect(hasMod(prospect, 'onDelete', ['CASCADE'])).toBe(true);
    const backlink = colOf(map, 'backlink_id'); // seo_backlinks.id is uuid (20260401000042)
    expect(hasMod(backlink, 'notNullable')).toBe(true);
    expect(hasMod(backlink, 'inTable', ['seo_backlinks'])).toBe(true);
    expect(hasMod(backlink, 'onDelete', ['CASCADE'])).toBe(true);
    expect(map.filter((c) => c.method === 'unique').map((c) => c.args[0])).toEqual([['backlink_id']]);
    expect(map.filter((c) => c.method === 'index').map((c) => c.args[0])).toEqual([['prospect_id']]);
    expect(knex._raws.some((r) => /seo_link_placement_backlinks/.test(r))).toBe(false); // no CHECKs needed
  });

  test('seo_link_acquisition_paths.terms_accepted_by_send: boolean NOT NULL DEFAULT false (the baseline path row writes it)', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    const cols = knex._altered.seo_link_acquisition_paths;
    expect(cols.map((c) => [c.method, c.args[0]])).toEqual([['boolean', 'terms_accepted_by_send']]);
    expect(hasMod(cols[0], 'notNullable')).toBe(true);
    expect(hasMod(cols[0], 'defaultTo', [false])).toBe(true);
    const baseline = fs.readFileSync(path.join(__dirname, '..', 'services/seo/link-registry-baseline.js'), 'utf8');
    expect(baseline).toMatch(/terms_accepted_by_send: false/);
  });

  test('idempotent: existing tables are not re-created, the column is not re-added and no CHECK is re-added', async () => {
    const knex = fakeKnex({ existing: ['seo_link_intake_items', 'seo_link_placement_backlinks'], pathColumns: { terms_accepted_by_send: {} } });
    await migration.up(knex);
    expect(knex.schema.createTable).not.toHaveBeenCalled();
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
    expect(knex._raws.filter((r) => !/^UPDATE seo_link_prospects p SET location_key/.test(r))).toEqual(['ALTER TABLE seo_link_prospects DROP CONSTRAINT IF EXISTS seo_link_prospects_target_domain_target_page_unique']);
  });

  test('CONTRACT: drops the legacy UNIQUE (target_domain, target_page) that step 1 kept through its rolling deploy (IF EXISTS: re-runs are safe)', async () => {
    const knex = fakeKnex();
    await migration.up(knex);
    expect(knex._raws[knex._raws.length - 1]).toBe('ALTER TABLE seo_link_prospects DROP CONSTRAINT IF EXISTS seo_link_prospects_target_domain_target_page_unique');
    // step 1's location_key backfill is re-run right before the drop, guarded against the wider key
    const backfill = knex._raws[knex._raws.length - 2];
    expect(backfill).toMatch(/^UPDATE seo_link_prospects p SET location_key = p\.quality_signals->>'location'/);
    expect(backfill).toMatch(/p\.location_key = '-' AND COALESCE\(p\.quality_signals->>'location', ''\) NOT IN \('', 'default'\)/);
    expect(backfill).toMatch(/NOT EXISTS \(SELECT 1 FROM seo_link_prospects o WHERE o\.target_domain = p\.target_domain AND o\.target_page = p\.target_page AND o\.location_key = p\.quality_signals->>'location'\)/);
    // no prospect writer may name that constraint as an ON CONFLICT target
    const routes = fs.readFileSync(path.join(__dirname, '..', 'routes/admin-backlink-agent-v2.js'), 'utf8');
    expect(routes).not.toMatch(/onConflict\(\[/);
  });
});

describe('down()', () => {
  test('drops both tables, mapping first', async () => {
    const knex = fakeKnex();
    await migration.down(knex);
    expect(knex.schema.dropTableIfExists.mock.calls.map((c) => c[0])).toEqual(['seo_link_placement_backlinks', 'seo_link_intake_items']);
  });
  test('restores the legacy 2-column key only when no per-location duplicates exist (never strands the rollback)', async () => {
    const knex = fakeKnex();
    await migration.down(knex);
    expect(knex._raws).toHaveLength(2);
    expect(knex._raws[0]).toBe('ALTER TABLE seo_link_acquisition_paths DROP COLUMN IF EXISTS terms_accepted_by_send');
    const sql = knex._raws[1];
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'seo_link_prospects_target_domain_target_page_unique'\)/);
    expect(sql).toMatch(/AND NOT EXISTS \(SELECT 1 FROM seo_link_prospects GROUP BY target_domain, target_page HAVING COUNT\(\*\) > 1\)/);
    expect(sql).toContain('ADD CONSTRAINT seo_link_prospects_target_domain_target_page_unique UNIQUE (target_domain, target_page)');
  });
});
