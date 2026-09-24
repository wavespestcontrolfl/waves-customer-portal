const migration = require('../models/migrations/20260924000120_tree_shrub_identifications');
const pestMigration = require('../models/migrations/20260707000030_prospect_photo_assessments');
const dropUnused = require('../models/migrations/20260924010100_tree_shrub_identifications_drop_unused');

// Records every column/index a createTable callback declares so the two
// migrations' table shapes can be compared column by column.
function recordingTable() {
  const columns = {};
  const indexes = [];
  const column = (name, type) => {
    const col = { type, modifiers: [] };
    columns[name] = col;
    const chain = new Proxy({}, {
      get: (_target, prop) => (...args) => { col.modifiers.push([prop, ...args]); return chain; },
    });
    return chain;
  };
  const t = new Proxy({}, {
    get: (_target, prop) => {
      if (prop === 'index') return (cols) => { indexes.push(cols); };
      if (prop === 'timestamps') return () => { columns.created_at = { type: 'timestamp' }; columns.updated_at = { type: 'timestamp' }; };
      return (name) => column(name, prop);
    },
  });
  return { t, columns, indexes };
}

function buildKnex({ existingTables = [] } = {}) {
  const state = { created: {}, dropped: [], raw: [] };
  const knex = jest.fn();
  knex.raw = jest.fn((sql) => { state.raw.push(String(sql).replace(/\s+/g, ' ').trim()); return sql; });
  knex.schema = {
    hasTable: jest.fn(async (name) => existingTables.includes(name) || name in state.created),
    hasColumn: jest.fn(async () => true),
    alterTable: jest.fn(async () => {}),
    createTable: jest.fn(async (name, fn) => {
      const rec = recordingTable();
      fn(rec.t);
      state.created[name] = rec;
    }),
    dropTable: jest.fn(async (name) => { state.dropped.push(name); }),
    dropTableIfExists: jest.fn(async (name) => { state.dropped.push(name); }),
  };
  return { knex, state };
}

describe('tree_shrub_identifications migration', () => {
  test('up creates both tables with the pest_identifications lifecycle shape and indexes', async () => {
    const { knex, state } = buildKnex();
    await migration.up(knex);
    expect(Object.keys(state.created)).toEqual(['tree_shrub_identifications', 'tree_shrub_identification_photos']);

    const ts = state.created.tree_shrub_identifications;
    for (const col of [
      'id', 'mode', 'status', 'source', 'lead_id', 'customer_id', 'contact_snapshot', 'address_snapshot',
      'ai_analysis', 'report_contract', 'ai_summary', 'report_token', 'report_expires_at', 'claim_token',
      'claimed_at', 'report_first_viewed_at', 'pricing_snapshot', 'last_sent_at', 'archived_at',
      'overall_score', 'worst_signal', 'created_at', 'updated_at',
    ]) {
      expect(ts.columns).toHaveProperty(col);
    }
    expect(ts.indexes).toEqual([['mode', 'status'], ['lead_id'], ['source', 'created_at']]);
    expect(state.raw.join('\n')).toContain("tree_shrub_identifications_mode_check CHECK (mode IN ('internal', 'prospect'))");
    expect(state.raw.join('\n')).toContain("tree_shrub_identifications_status_check CHECK (status IN ('draft', 'analyzed', 'sent', 'archived'))");

    const photos = state.created.tree_shrub_identification_photos;
    expect(photos.indexes).toEqual([['identification_id', 'photo_index']]);
    const fk = photos.columns.identification_id.modifiers;
    expect(fk).toContainEqual(['inTable', 'tree_shrub_identifications']);
    expect(fk).toContainEqual(['onDelete', 'CASCADE']);
  });

  test('photo table mirrors pest_identification_photos column for column', async () => {
    const tree = buildKnex();
    await migration.up(tree.knex);
    // No lawn_diagnostics table in this fake → the pest migration only
    // creates its two pest tables.
    const pest = buildKnex();
    await pestMigration.up(pest.knex);
    expect(Object.keys(tree.state.created.tree_shrub_identification_photos.columns).sort())
      .toEqual(Object.keys(pest.state.created.pest_identification_photos.columns).sort());
  });

  test('up is idempotent when both tables already exist', async () => {
    const { knex, state } = buildKnex({ existingTables: ['tree_shrub_identifications', 'tree_shrub_identification_photos'] });
    await migration.up(knex);
    expect(state.created).toEqual({});
    expect(state.raw).toEqual([]);
  });

  test('down drops the photo table first, then the constraints and the parent table', async () => {
    const { knex, state } = buildKnex({ existingTables: ['tree_shrub_identifications'] });
    await migration.down(knex);
    expect(state.dropped).toEqual(['tree_shrub_identification_photos', 'tree_shrub_identifications']);
    expect(state.raw).toEqual([
      'ALTER TABLE tree_shrub_identifications DROP CONSTRAINT IF EXISTS tree_shrub_identifications_status_check',
      'ALTER TABLE tree_shrub_identifications DROP CONSTRAINT IF EXISTS tree_shrub_identifications_mode_check',
    ]);
  });
});

// Stateful fake for the superseding drop migration: the table starts with
// exactly the columns 20260924000120 created (recorded by running its up()),
// and alterTable applies dropColumn / column adds to that live set.
async function tableAfterOriginal() {
  const { knex, state } = buildKnex();
  await migration.up(knex);
  const original = state.created.tree_shrub_identifications.columns;
  const columns = { ...original };
  const alterKnex = jest.fn();
  alterKnex.schema = {
    hasTable: jest.fn(async (name) => name === 'tree_shrub_identifications'),
    hasColumn: jest.fn(async (_table, column) => column in columns),
    alterTable: jest.fn(async (_name, fn) => {
      const rec = recordingTable();
      const t = new Proxy(rec.t, {
        get: (target, prop) => (prop === 'dropColumn' ? (column) => { delete columns[column]; } : target[prop]),
      });
      fn(t);
      Object.assign(columns, rec.columns);
    }),
  };
  return { knex: alterKnex, columns, original };
}

describe('20260924010100 — drop the unused report/claim/funnel columns (superseding migration)', () => {
  const UNUSED = [
    'report_token', 'report_expires_at', 'claim_token', 'claimed_at',
    'report_first_viewed_at', 'pricing_snapshot', 'last_sent_at',
  ];

  test('drops exactly the unused columns and keeps everything the admin lane uses', async () => {
    expect([...dropUnused.DROPPED_COLUMNS].sort()).toEqual([...UNUSED].sort());
    const { knex, columns } = await tableAfterOriginal();
    await dropUnused.up(knex);
    for (const column of UNUSED) expect(columns).not.toHaveProperty(column);
    for (const column of [
      'id', 'mode', 'status', 'source', 'lead_id', 'customer_id', 'contact_snapshot', 'address_snapshot',
      'created_by_technician_id', 'ai_analysis', 'report_contract', 'overall_score', 'worst_signal',
      'ai_summary', 'archived_at', 'created_at', 'updated_at',
    ]) {
      expect(columns).toHaveProperty(column);
    }
  });

  test('down re-adds every dropped column with its original definition (type + modifiers, incl. UNIQUE)', async () => {
    const { knex, columns, original } = await tableAfterOriginal();
    await dropUnused.up(knex);
    await dropUnused.down(knex);
    for (const column of UNUSED) expect(columns[column]).toEqual(original[column]);
    expect(columns.report_token.modifiers).toContainEqual(['unique']);
    expect(columns.claim_token.modifiers).toContainEqual(['unique']);
  });

  test('up and down are idempotent, and a missing table is a no-op', async () => {
    const { knex, columns } = await tableAfterOriginal();
    await dropUnused.up(knex);
    await dropUnused.up(knex);
    for (const column of UNUSED) expect(columns).not.toHaveProperty(column);
    await dropUnused.down(knex);
    const afterDown = JSON.stringify(columns);
    await dropUnused.down(knex);
    expect(JSON.stringify(columns)).toBe(afterDown);

    const noTable = jest.fn();
    noTable.schema = { hasTable: jest.fn(async () => false), hasColumn: jest.fn(), alterTable: jest.fn() };
    await dropUnused.up(noTable);
    await dropUnused.down(noTable);
    expect(noTable.schema.alterTable).not.toHaveBeenCalled();
  });
});
