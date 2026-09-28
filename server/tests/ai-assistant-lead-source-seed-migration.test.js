/**
 * Migration 20260928030000 — seed the 'AI Assistant Referrals' lead_sources
 * row (codex pre-push P1 on 20260928020000: an ai_assistant-classified lead
 * had no lead_sources row to resolve, so lead_source_id stayed NULL forever).
 *
 * Companion "route wiring" block pins the lead-webhook.js lookup branch that
 * reads this exact seed (source_type='ai_assistant', is_active=true) — the
 * two must never drift apart.
 */
const fs = require('fs');
const path = require('path');

const migration = require('../models/migrations/20260928030000_ai_assistant_lead_source');

// Minimal fake knex covering hasTable + a `where().first()` / `insert()`
// chain on ONE table, matching the shape this migration actually calls.
function makeTableKnex({ hasTable = true, existingRow = null } = {}) {
  const calls = { where: [], inserted: null };
  const builder = {
    where: (cond) => { calls.where.push(cond); return builder; },
    first: async () => existingRow,
  };
  const knex = (table) => {
    calls.table = table;
    return {
      where: builder.where,
      first: builder.first,
      insert: async (row) => { calls.inserted = row; return [{ id: 'new-id', ...row }]; },
    };
  };
  knex.schema = { hasTable: async () => hasTable };
  knex._calls = calls;
  return knex;
}

describe('migration 20260928030000 — ai_assistant lead_sources seed', () => {
  test('inserts the AI Assistant Referrals row when absent', async () => {
    const knex = makeTableKnex({ existingRow: null });
    await migration.up(knex);
    expect(knex._calls.table).toBe('lead_sources');
    expect(knex._calls.where).toEqual([{ source_type: 'ai_assistant' }]);
    expect(knex._calls.inserted).toMatchObject({
      source_type: 'ai_assistant',
      channel: 'organic',
      is_active: true,
    });
    expect(knex._calls.inserted.name).toBeTruthy();
  });

  test('idempotent — no insert when a row already exists (never stomps an admin edit)', async () => {
    const knex = makeTableKnex({ existingRow: { id: 'existing', source_type: 'ai_assistant', name: 'Renamed by office' } });
    await migration.up(knex);
    expect(knex._calls.inserted).toBeNull();
  });

  test('no-ops when the lead_sources table is absent', async () => {
    const knex = makeTableKnex({ hasTable: false });
    await migration.up(knex);
    expect(knex._calls.table).toBeUndefined();
  });

  test('down() is a documented no-op — seed rollbacks are never destructive', async () => {
    await expect(migration.down()).resolves.toBeUndefined();
  });
});

describe('lead-webhook.js — ai_assistant lead_sources lookup wiring', () => {
  const src = fs.readFileSync(path.join(__dirname, '../routes/lead-webhook.js'), 'utf8');

  test('resolves lead_source_id for ai_assistant against the exact seeded row shape', () => {
    const marker = "leadSource.source === 'ai_assistant'";
    expect(src).toContain(marker);
    const block = src.slice(src.indexOf(marker), src.indexOf(marker) + 300);
    expect(block).toMatch(/source_type',\s*'ai_assistant'/);
    expect(block).toMatch(/is_active',\s*true/);
  });
});
