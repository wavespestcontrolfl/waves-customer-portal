/**
 * Migration shape — message_drafts campaign dimension
 * (20260705000501_message_drafts_campaign.js).
 *
 * Pins: campaign_type / purpose / source_ref added only when missing,
 * (campaign_type, status) index created, and down() reverses cleanly.
 */

const migration = require('../models/migrations/20260705000501_message_drafts_campaign');

function makeKnex({ existingCols = {} } = {}) {
  const added = [];
  const dropped = [];
  const rawCalls = [];

  const knex = jest.fn((table) => {
    expect(table).toBe('message_drafts');
    return {
      columnInfo: jest.fn(async () => existingCols),
    };
  });
  knex.schema = {
    alterTable: jest.fn(async (table, cb) => {
      expect(table).toBe('message_drafts');
      const t = {
        string: jest.fn((name, len) => { added.push({ name, len }); }),
        dropColumn: jest.fn((name) => { dropped.push(name); }),
      };
      cb(t);
    }),
  };
  knex.raw = jest.fn(async (sql) => { rawCalls.push(sql); });

  return { knex, added, dropped, rawCalls };
}

describe('message_drafts campaign migration', () => {
  test('up adds campaign_type, purpose, source_ref and the (campaign_type, status) index', async () => {
    const { knex, added, rawCalls } = makeKnex();

    await migration.up(knex);

    expect(added.map((c) => c.name)).toEqual(['campaign_type', 'purpose', 'source_ref']);
    const indexSql = rawCalls.find((s) => /CREATE INDEX/i.test(s));
    expect(indexSql).toMatch(/IF NOT EXISTS/i);
    expect(indexSql).toMatch(/message_drafts\s*\(campaign_type,\s*status\)/);
  });

  test('up is idempotent: existing columns are not re-added', async () => {
    const { knex, added } = makeKnex({
      existingCols: { campaign_type: {}, purpose: {}, source_ref: {} },
    });

    await migration.up(knex);

    expect(added).toEqual([]);
  });

  test('down drops the index and the three columns', async () => {
    const { knex, dropped, rawCalls } = makeKnex({
      existingCols: { campaign_type: {}, purpose: {}, source_ref: {} },
    });

    await migration.down(knex);

    expect(rawCalls.find((s) => /DROP INDEX IF EXISTS message_drafts_campaign_status_idx/i.test(s))).toBeTruthy();
    expect(dropped.sort()).toEqual(['campaign_type', 'purpose', 'source_ref']);
  });

  test('down tolerates already-missing columns', async () => {
    const { knex, dropped } = makeKnex({ existingCols: {} });

    await migration.down(knex);

    expect(dropped).toEqual([]);
  });
});
