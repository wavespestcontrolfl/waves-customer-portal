/**
 * Windowless pre-closed placeholder migration — content pins.
 *
 * The app half (appointment-reminders.js) makes closeReminderWindows insert
 * placeholders with suppressed_by_sibling=true + windows_preclosed=true; the
 * ownership exclusion falls out of the existing suppressed filters. The DB
 * half lives in this migration's function bodies, so pin the load-bearing
 * SQL:
 *   - promotion skips windows_preclosed candidates (a placeholder is never
 *     promoted into an armed 08:00 sender when a real owner leaves the slot);
 *   - the sync trigger HOLDS placeholder semantics while the service stays
 *     windowless (suppressed + windows closed across date-only moves) and
 *     clears the marker the moment a real window arrives;
 *   - down() restores the #2808 bodies (which never reference the column)
 *     BEFORE dropping the column, so a rollback can't leave functions
 *     referencing a dropped column.
 */
const migration = require('../models/migrations/20260720000000_windowless_preclosed_reminder_placeholders');

function harness({ hasColumn = false, hasTable = true } = {}) {
  const raw = jest.fn(async () => undefined);
  const columnCalls = [];
  const alterTable = jest.fn(async (table, cb) => {
    const columnBuilder = {
      notNullable: jest.fn(() => columnBuilder),
      defaultTo: jest.fn(() => columnBuilder),
    };
    const t = {
      boolean: jest.fn((name) => { columnCalls.push(['boolean', name]); return columnBuilder; }),
      dropColumn: jest.fn((name) => { columnCalls.push(['dropColumn', name]); }),
    };
    cb(t);
  });
  const knex = {
    raw,
    schema: {
      hasTable: jest.fn(async () => hasTable),
      hasColumn: jest.fn(async () => hasColumn),
      alterTable,
    },
  };
  return { knex, raw, alterTable, columnCalls };
}

describe('windowless pre-closed placeholder migration', () => {
  test('up adds the durable marker column and installs marker-aware function bodies', async () => {
    const { knex, raw, alterTable, columnCalls } = harness();
    await migration.up(knex);

    expect(alterTable).toHaveBeenCalledWith('appointment_reminders', expect.any(Function));
    expect(columnCalls).toContainEqual(['boolean', 'windows_preclosed']);

    const sql = raw.mock.calls.map(([statement]) => statement).join('\n');
    // Both #2808 functions are replaced (same signatures — no drops needed).
    expect(sql).toContain('CREATE OR REPLACE FUNCTION promote_suppressed_reminder_sibling');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION sync_appointment_reminder_on_service_change');
    // Promotion candidates exclude placeholders — never promoted into an
    // armed 08:00 sender on slot departure.
    expect(sql).toContain('AND ar2.windows_preclosed = false');
    // The trigger holds placeholder semantics while the service stays
    // windowless (stays suppressed, both windows stay closed on date-only
    // moves and terminal→active bounces)…
    expect(sql).toContain('WHEN windows_preclosed AND NEW.window_start IS NULL THEN true');
    // …and clears the marker the moment a real window arrives, converting
    // the row into an ordinary registration.
    expect(sql).toContain('windows_preclosed = (windows_preclosed AND NEW.window_start IS NULL)');
    // The #2808 ownership/arrival machinery is retained, not rewritten:
    // owner checks still exclude suppressed rows, and departures still
    // promote through the shared advisory-lock protocol.
    expect(sql).toContain('AND ar2.suppressed_by_sibling = false');
    expect(sql).toContain('AND ar3.suppressed_by_sibling = false');
    expect(sql).toContain('pg_advisory_xact_lock(reminder_slot_lock_key(NEW.customer_id, old_appt_time))');
  });

  test('up is idempotent on the column (re-run skips alterTable but still replaces the bodies)', async () => {
    const { knex, raw, alterTable } = harness({ hasColumn: true });
    await migration.up(knex);

    expect(alterTable).not.toHaveBeenCalled();
    const sql = raw.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION promote_suppressed_reminder_sibling');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION sync_appointment_reminder_on_service_change');
  });

  test('up no-ops when the reminder tables are absent (fresh-schema guard)', async () => {
    const { knex, raw, alterTable } = harness({ hasTable: false });
    await migration.up(knex);
    expect(raw).not.toHaveBeenCalled();
    expect(alterTable).not.toHaveBeenCalled();
  });

  test('down restores the #2808 bodies (no marker references) BEFORE dropping the column', async () => {
    const { knex, raw, alterTable, columnCalls } = harness({ hasColumn: true });
    await migration.down(knex);

    const sql = raw.mock.calls.map(([statement]) => statement).join('\n');
    // The restored bodies must never reference the column this down() drops.
    expect(sql).toContain('CREATE OR REPLACE FUNCTION promote_suppressed_reminder_sibling');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION sync_appointment_reminder_on_service_change');
    expect(sql).not.toContain('windows_preclosed');
    expect(columnCalls).toContainEqual(['dropColumn', 'windows_preclosed']);
    // Ordering: BOTH function restores strictly precede the column drop.
    const lastRawOrder = Math.max(...raw.mock.invocationCallOrder);
    const alterOrder = Math.min(...alterTable.mock.invocationCallOrder);
    expect(lastRawOrder).toBeLessThan(alterOrder);
  });
});
