/**
 * 20260928050000 — supersedes 20260928020000_sms_preview_photo_content_signature.js
 * (frozen: already pushed, the preview database already ran it, and knex
 * tracks by filename — waves-db SKILL.md §4). The MMS-thumbnail feature
 * that was going to use `photo_content_signature` was pulled out of
 * feat/report-photos-20260928 (owner decision 2026-09-28); nothing reads or
 * writes the column any more, so this drops it, reversibly.
 */
const migration = require('../models/migrations/20260928050000_drop_sms_preview_photo_content_signature');

function buildKnex({ hasTable = true, hasColumn = true } = {}) {
  const state = { dropped: [], added: [] };
  const table = {
    dropColumn: (col) => state.dropped.push(col),
    text: (col) => state.added.push(col),
  };
  const knex = {
    schema: {
      hasTable: jest.fn(async () => hasTable),
      hasColumn: jest.fn(async () => hasColumn),
      alterTable: jest.fn(async (_name, fn) => fn(table)),
    },
  };
  return { knex, state };
}

describe('drop service_report_notification_assets.photo_content_signature', () => {
  test('up() drops the column when present', async () => {
    const { knex, state } = buildKnex({ hasColumn: true });
    await migration.up(knex);
    expect(state.dropped).toEqual(['photo_content_signature']);
  });

  test('up() is a no-op when the column is already gone (re-run safety)', async () => {
    const { knex, state } = buildKnex({ hasColumn: false });
    await migration.up(knex);
    expect(state.dropped).toEqual([]);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('up() is a no-op when the table itself is absent', async () => {
    const { knex, state } = buildKnex({ hasTable: false, hasColumn: true });
    await migration.up(knex);
    expect(state.dropped).toEqual([]);
    expect(knex.schema.hasColumn).not.toHaveBeenCalled();
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('down() restores the column, nullable, when it is absent', async () => {
    const { knex, state } = buildKnex({ hasColumn: false });
    await migration.down(knex);
    expect(state.added).toEqual(['photo_content_signature']);
  });

  test('down() is a no-op when the column already exists', async () => {
    const { knex, state } = buildKnex({ hasColumn: true });
    await migration.down(knex);
    expect(state.added).toEqual([]);
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });

  test('down() is a no-op when the table itself is absent', async () => {
    const { knex, state } = buildKnex({ hasTable: false, hasColumn: false });
    await migration.down(knex);
    expect(state.added).toEqual([]);
    expect(knex.schema.hasColumn).not.toHaveBeenCalled();
    expect(knex.schema.alterTable).not.toHaveBeenCalled();
  });
});
