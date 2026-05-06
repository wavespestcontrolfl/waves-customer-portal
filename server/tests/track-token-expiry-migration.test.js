const migration = require('../models/migrations/20260505000001_refresh_track_token_expiry_on_reschedule');

function fakeKnex() {
  const statements = [];
  return {
    statements,
    raw: jest.fn(async (sql) => {
      statements.push(sql);
    }),
  };
}

describe('track token expiry reschedule migration', () => {
  test('up trigger recomputes expiry when schedule date or window end changes', async () => {
    const knex = fakeKnex();

    await migration.up(knex);

    const sql = knex.statements.join('\n');
    expect(sql).toContain('BEFORE INSERT OR UPDATE OF scheduled_date, window_end ON scheduled_services');
    expect(sql).toContain("TG_OP = 'UPDATE'");
    expect(sql).toContain("NEW.track_state IN ('scheduled', 'en_route', 'on_property')");
    expect(sql).toContain('NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date');
    expect(sql).toContain('NEW.window_end IS DISTINCT FROM OLD.window_end');
    expect(sql).toContain("NEW.scheduled_date + COALESCE(NEW.window_end, TIME '23:59:59')");
    expect(sql).toContain("scheduled_date + COALESCE(window_end, TIME '23:59:59')");
    expect(sql).not.toContain('scheduled_date::timestamp + COALESCE');
    expect(sql).toContain("AT TIME ZONE 'America/New_York'");
    expect(sql).toContain("track_state IN ('scheduled', 'en_route', 'on_property')");
  });

  test('down restores insert-only trigger behavior', async () => {
    const knex = fakeKnex();

    await migration.down(knex);

    const sql = knex.statements.join('\n');
    expect(sql).toContain('BEFORE INSERT ON scheduled_services');
    expect(sql).not.toContain('UPDATE OF scheduled_date, window_end');
    expect(sql).toContain('NEW.track_token_expires_at IS NULL');
  });
});
