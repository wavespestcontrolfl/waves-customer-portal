const migration = require('../models/migrations/20261126130000_newsletter_calendar_thursday_anchor');
const phaseMigration = require('../models/migrations/20261126130100_newsletter_sends_audience_phase');

function transactionHarness({ unexpected = null } = {}) {
  const raw = jest.fn(async () => undefined);
  const query = {
    whereRaw: jest.fn(() => query),
    first: jest.fn(async () => unexpected),
  };
  const trx = jest.fn(() => query);
  trx.raw = raw;
  const knex = {
    transaction: jest.fn(async (work) => work(trx)),
  };
  return { knex, raw, query };
}

describe('newsletter calendar Thursday-anchor migration', () => {
  test('swaps the Tuesday CHECK for the Thursday one and moves each Tuesday row two days forward', async () => {
    const { knex, raw, query } = transactionHarness();
    await migration.up(knex);

    const statements = raw.mock.calls.map(([statement]) => statement);
    const sql = statements.join('\n');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_calendar_week_of_tuesday');
    expect(sql).toContain("week_of + INTERVAL '2 days'");
    expect(sql).toContain('ADD CONSTRAINT chk_calendar_week_of_thursday');
    expect(sql).toContain('EXTRACT(ISODOW FROM week_of) = 4');
    expect(query.whereRaw).toHaveBeenCalledWith('EXTRACT(ISODOW FROM week_of) <> 4');
    // the old CHECK goes before any row moves, and the new one is added last
    const at = (needle) => statements.findIndex((statement) => statement.includes(needle));
    expect(at('DROP CONSTRAINT IF EXISTS chk_calendar_week_of_tuesday')).toBe(0);
    expect(at('ADD CONSTRAINT chk_calendar_week_of_thursday')).toBe(statements.length - 1);
  });

  test('re-times what is still ahead to 06:00 New York time on its Thursday (DST-safe)', async () => {
    const { knex, raw } = transactionHarness();
    await migration.up(knex);
    const sql = raw.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain("TIME '06:00'");
    expect(sql).toContain("AT TIME ZONE 'America/New_York'");
    expect(sql).toContain("status IN ('planned', 'drafted', 'scheduled')");
    expect(sql).toContain("week_of >= (NOW() AT TIME ZONE 'America/New_York')::date");
  });

  test('an unsent draft or queued send for a week not yet over is unqueued and unlinked, before the rows move', async () => {
    const { knex, raw } = transactionHarness();
    await migration.up(knex);
    const statements = raw.mock.calls.map(([statement]) => statement);
    const unqueue = statements.findIndex((statement) => statement.includes('UPDATE newsletter_sends s'));
    const unlink = statements.findIndex((statement) => statement.includes("SET status = 'planned'"));
    const move = statements.findIndex((statement) => statement.includes("SET week_of = (week_of + INTERVAL '2 days')"));
    expect(unqueue).toBeGreaterThan(0);
    expect(unqueue).toBeLessThan(unlink);
    expect(unlink).toBeLessThan(move);
    // a queued send goes back to a draft with its approval cleared; only draft/scheduled sends are touched
    expect(statements[unqueue]).toContain("status = 'draft'");
    expect(statements[unqueue]).toContain('proof_approved_at = NULL');
    expect(statements[unqueue]).toContain("s.status = 'scheduled'");
    expect(statements[unlink]).toContain('send_id = NULL');
    expect(statements[unlink]).toContain("s.status = 'draft'");
    // sent / skipped / sending weeks only change week_of: the statements never name them
    expect(statements.join('\n')).not.toMatch(/status = 'sent'|status IN \([^)]*'sent'/);
  });

  test('fails closed when a drifted row is not Thursday after conversion', async () => {
    const { knex } = transactionHarness({ unexpected: { id: 'bad-row', week_of: '2026-07-21' } });
    await expect(migration.up(knex)).rejects.toThrow(/bad-row.*non-Thursday/);
  });

  test('down moves Thursday rows back two days and restores the Tuesday CHECK', async () => {
    const { knex, raw } = transactionHarness();
    await migration.down(knex);
    const sql = raw.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_calendar_week_of_thursday');
    expect(sql).toContain("week_of - INTERVAL '2 days'");
    expect(sql).toContain('ADD CONSTRAINT chk_calendar_week_of_tuesday');
  });
});

describe('newsletter_sends.audience_phase migration', () => {
  function schemaHarness({ hasColumn }) {
    const added = [];
    const alterTable = jest.fn(async (_table, build) => build({ text: (name) => ({ nullable: () => added.push(name) }), dropColumn: (name) => added.push(`drop:${name}`) }));
    const knex = { schema: { hasColumn: jest.fn(async () => hasColumn), alterTable }, raw: jest.fn(async () => undefined) };
    return { knex, added };
  }

  test('adds a nullable text column and a warm/all CHECK, once', async () => {
    const { knex, added } = schemaHarness({ hasColumn: false });
    await phaseMigration.up(knex);
    expect(added).toEqual(['audience_phase']);
    const sql = knex.raw.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain("audience_phase IS NULL OR audience_phase IN ('warm', 'all')");
  });

  test('is idempotent when the column exists, and down removes only what it added', async () => {
    const up = schemaHarness({ hasColumn: true });
    await phaseMigration.up(up.knex);
    expect(up.added).toEqual([]);
    const down = schemaHarness({ hasColumn: true });
    await phaseMigration.down(down.knex);
    expect(down.added).toEqual(['drop:audience_phase']);
  });
});
