// The no-show detector reads call promises from BOTH call-move actions with
// `action IN (...)`; the single-action partial indexes could not serve that.
// The replacement indexes are partial on both actions, idempotent, plain
// transactional CREATE INDEX, and down restores the old pair.
const migration = require('../models/migrations/20261022140000_activity_log_call_move_indexes');

const ACTIONS = "WHERE action IN ('call_reschedule_applied', 'call_makeup_move_applied')";

function fakeKnex({ hasTable = true } = {}) {
  const sql = [];
  return { sql, schema: { hasTable: async () => hasTable }, raw: async (q) => { sql.push(q); } };
}

test('up builds both expression indexes on both actions, then drops the single-action pair', async () => {
  const k = fakeKnex();
  await migration.up(k);
  expect(k.sql).toHaveLength(4);
  expect(k.sql[0]).toMatch(/CREATE INDEX IF NOT EXISTS activity_log_call_move_visit_idx\s+ON activity_log \(\(metadata->>'scheduled_service_id'\)\)/);
  expect(k.sql[1]).toMatch(/CREATE INDEX IF NOT EXISTS activity_log_call_move_window_idx\s+ON activity_log \(\(metadata->'to'->>'date'\)\)/);
  for (const q of k.sql.slice(0, 2)) expect(q).toContain(ACTIONS);
  expect(k.sql.slice(2)).toEqual([
    'DROP INDEX IF EXISTS activity_log_applied_reschedule_visit_idx',
    'DROP INDEX IF EXISTS activity_log_applied_window_idx',
  ]);
  expect(k.sql.join('\n')).not.toMatch(/CONCURRENTLY/);
  expect(migration.config?.transaction).not.toBe(false);
});

test('the index predicate names exactly the actions the detector reads', () => {
  const detector = require('fs').readFileSync(require.resolve('../services/no-show-detector'), 'utf8');
  expect(detector).toContain("const CALL_MOVE_ACTIONS = ['call_reschedule_applied', 'call_makeup_move_applied'];");
});

test('down restores the single-action indexes; both directions are no-ops without the table', async () => {
  const k = fakeKnex();
  await migration.down(k);
  expect(k.sql[0]).toMatch(/CREATE INDEX IF NOT EXISTS activity_log_applied_reschedule_visit_idx[\s\S]*WHERE action = 'call_reschedule_applied'/);
  expect(k.sql[1]).toMatch(/CREATE INDEX IF NOT EXISTS activity_log_applied_window_idx[\s\S]*WHERE action = 'call_reschedule_applied'/);
  expect(k.sql.slice(2)).toEqual(['DROP INDEX IF EXISTS activity_log_call_move_window_idx', 'DROP INDEX IF EXISTS activity_log_call_move_visit_idx']);
  for (const fn of [migration.up, migration.down]) {
    const none = fakeKnex({ hasTable: false });
    await fn(none);
    expect(none.sql).toEqual([]);
  }
});
