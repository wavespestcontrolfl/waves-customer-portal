const migration = require('../models/migrations/20260716150000_newsletter_calendar_tuesday_anchor');

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

describe('newsletter calendar Tuesday-anchor migration', () => {
  test('converts legacy Thursday anchors before installing the Tuesday CHECK', async () => {
    const { knex, raw, query } = transactionHarness();
    await migration.up(knex);

    const sql = raw.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain('DROP CONSTRAINT IF EXISTS chk_calendar_week_of_thursday');
    expect(sql).toContain("week_of - INTERVAL '2 days'");
    expect(sql).toContain("TIME '06:00'");
    expect(sql).toContain("AT TIME ZONE 'America/New_York'");
    expect(sql).toContain("status IN ('planned', 'drafted')");
    expect(sql).toContain('target_send_at > NOW()');
    expect(sql).toContain('ADD CONSTRAINT chk_calendar_week_of_tuesday');
    expect(sql).toContain('EXTRACT(ISODOW FROM week_of) = 2');
    expect(query.whereRaw).toHaveBeenCalledWith('EXTRACT(ISODOW FROM week_of) <> 2');
  });

  test('fails closed when a drifted row is not Tuesday after conversion', async () => {
    const { knex } = transactionHarness({ unexpected: { id: 'bad-row', week_of: '2026-07-15' } });
    await expect(migration.up(knex)).rejects.toThrow(/bad-row.*non-Tuesday/);
  });
});
