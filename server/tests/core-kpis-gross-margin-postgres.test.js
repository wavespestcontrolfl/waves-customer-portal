// Runs with the existing CI PostgreSQL pass; never a production connection.
// computeCoreKpis' Gross Margin against real Postgres: a free ($0-revenue)
// visit still costs labor and drive, and the aggregate margin must count it.
// The old revenue-weighted formula (SUM(revenue * gross_margin_pct) /
// SUM(revenue)) gave a free visit zero weight, so October 2026 read 61.5%
// against a true 52.4%. A private schema keeps CI's migrated tables and every
// other fixture run untouched.
const SKIP = !process.env.DATABASE_URL;
const { randomUUID } = require('crypto');

const mockSchema = `core_kpis_margin_${randomUUID().replaceAll('-', '')}`;
jest.mock('../models/db', () => {
  const knex = require('knex');
  return knex({
    client: 'pg',
    connection: process.env.DATABASE_URL,
    searchPath: [mockSchema],
    pool: { min: 0, max: 2 },
  });
});
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

(SKIP ? describe.skip : describe)('computeCoreKpis gross margin (live Postgres)', () => {
  let db;
  let computeCoreKpis;

  beforeAll(async () => {
    db = require('../models/db');
    await db.raw('CREATE SCHEMA ??', [mockSchema]);
    // Only the columns computeCoreKpis' two unwrapped queries read (completion
    // rate, then the service_records callback + financial roll-ups); every
    // other query it runs is wrapped and degrades on the missing tables.
    await db.schema.withSchema(mockSchema).createTable('scheduled_services', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.date('scheduled_date').notNullable();
      t.string('status');
    });
    await db.schema.withSchema(mockSchema).createTable('service_records', (t) => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.date('service_date').notNullable();
      t.boolean('is_callback').defaultTo(false);
      t.decimal('revenue', 10, 2);
      t.decimal('labor_hours', 6, 2);
      t.decimal('revenue_per_man_hour', 10, 2);
      t.decimal('gross_margin_pct', 7, 2);
      t.decimal('gross_profit', 10, 2);
    });
    ({ computeCoreKpis } = require('../routes/admin-dashboard'));
  });

  afterAll(async () => {
    if (!db) return;
    await db.raw('DROP SCHEMA IF EXISTS ?? CASCADE', [mockSchema]);
    await db.destroy();
  });

  test("a free visit's cost counts against the margin", async () => {
    await db('service_records').insert([
      // Paid visit: $100 revenue, $40 of cost.
      {
        service_date: '2001-01-15', revenue: 100, labor_hours: 1, revenue_per_man_hour: 100,
        gross_margin_pct: 60, gross_profit: 60,
      },
      // Free re-service: $0 revenue, $20 of labor and drive, no margin of its own.
      {
        service_date: '2001-01-16', revenue: 0, labor_hours: 0.5, revenue_per_man_hour: null,
        gross_margin_pct: null, gross_profit: -20,
      },
    ]);
    const kpis = await computeCoreKpis('mtd', { from: '2001-01-01', to: '2001-01-31' });
    // (60 − 20) / 100 — the revenue-weighted formula read 60.
    expect(kpis.financial.grossMarginWeighted).toBeCloseTo(40, 5);
    expect(kpis.financial.grossMargin).toBeCloseTo(40, 5);
  });
});
