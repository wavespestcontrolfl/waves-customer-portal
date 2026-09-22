/**
 * Discount-stacking pricing provenance — REAL Postgres round trip.
 *
 * GitHub Codex round 1 on #4642 (PRRT_kwDOR3YQi86kllyE): the mocked unit
 * suite (admin-schedule-discount-stack-restack.test.js) could not catch
 * that the marker's ORIGINAL design reused `scheduled_services.metadata`,
 * a column that never existed on this table — every stamp silently
 * no-opped in production because a hand-typed mock connection has no
 * concept of "this column doesn't exist," while a real INSERT/SELECT
 * would have failed loudly (or, worse here, just dropped the value on an
 * unrecognized/extra field, exactly as it did). This suite runs the same
 * mechanism (stampPricingRegimeMarker / hasPricingRegimeMarker /
 * restackStoredVisitFinancials) against a migrated database so the
 * migration itself, and the JSONB round trip through the REAL pg driver,
 * are proof — not just the mocked shape.
 */
const knex = require('knex');
const { randomUUID } = require('crypto');
const {
  stampPricingRegimeMarker,
  hasPricingRegimeMarker,
} = require('../services/booking/visit-financial-stamps');
const adminScheduleRouter = require('../routes/admin-schedule');
const { restackStoredVisitFinancials } = adminScheduleRouter._test;

const connection = process.env.DISCOUNT_STACK_PROVENANCE_TEST_DATABASE_URL;
const postgres = connection ? describe : describe.skip;
let database;
let mockPg; // the per-test transaction while a test runs; the pool between tests

postgres('discount-stacking pricing_provenance — real Postgres round trip (PostgreSQL)', () => {
  beforeAll(async () => {
    const url = new URL(connection);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    const ciTest = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(url.hostname) && url.pathname === '/waves_test';
    if (!privateQa && !ciTest) throw new Error('Use a verified, task-private QA database or the isolated CI database');
    database = knex({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    mockPg = database;
  });
  // Every fixture row lives inside one transaction that is rolled back —
  // nothing this suite writes outlives it.
  beforeEach(async () => { mockPg = await database.transaction(); });
  afterEach(async () => { const trx = mockPg; mockPg = database; await trx.rollback(); });
  afterAll(async () => { if (database) await database.destroy(); });

  test('migration 20260921000002 actually ran: pricing_provenance exists on scheduled_services, metadata never did', async () => {
    const cols = await mockPg('scheduled_services').columnInfo();
    expect(cols.pricing_provenance).toBeDefined();
    expect(cols.pricing_provenance.type).toBe('jsonb');
    // The exact bug this migration fixes: the ORIGINAL design's column
    // genuinely never existed on this table.
    expect(cols.metadata).toBeUndefined();
  });

  test('a stamped marker + frozen caps snapshot round-trips through a REAL INSERT/SELECT as JSONB, not a hand-typed mock', async () => {
    const id = randomUUID();
    const lineDiscountId = randomUUID();
    const addonDiscountId = randomUUID();
    const target = {
      scheduled_date: '2099-01-15',
      service_type: 'Fixture Quarterly Pest Control Service',
      primary_line_price: 100,
      line_discount_id: lineDiscountId,
      line_discount_type: 'percentage',
      line_discount_amount: 50,
    };
    stampPricingRegimeMarker(target, { pricing_provenance: true }, { line: 10, addons: { [addonDiscountId]: 25 } });
    await mockPg('scheduled_services').insert({ id, ...target });

    const row = await mockPg('scheduled_services').where({ id }).first();
    expect(hasPricingRegimeMarker(row)).toBe(true);
    expect(row.pricing_provenance).toEqual({
      pricing_regime: 'discount_stack_v1',
      engine_version: 1,
      caps: { line: 10, addons: { [addonDiscountId]: 25 } },
    });
  });

  // The coordinator's exact pinned combination, end to end through a real
  // database: a row is CREATED (inserted with a frozen $10 line cap),
  // read back through a REAL Postgres round trip exactly as an extension
  // writer's resolveSeriesExtensionPriceTemplate would (same connection,
  // same SELECT), and restacked as that EXTENSION against a live catalog
  // cap that has since been raised to $20 — the frozen $10 must still win.
  test('creation to extension: a $10 cap frozen at insert survives a real Postgres round trip and still wins over a catalog raised to $20', async () => {
    const id = randomUUID();
    const lineDiscountId = randomUUID();
    const created = {
      scheduled_date: '2099-02-15',
      service_type: 'Fixture Quarterly Pest Control Service',
      primary_line_price: 100,
      line_discount_id: lineDiscountId,
      line_discount_type: 'percentage',
      line_discount_amount: 50, // uncapped, 50% of $100 would be $50 off
    };
    stampPricingRegimeMarker(created, { pricing_provenance: true }, { line: 10, addons: {} });
    await mockPg('scheduled_services').insert({ id, ...created });

    // "Extension": the row read back through the SAME kind of query an
    // extension writer's resolveSeriesExtensionPriceTemplate runs.
    const parentAsReadByExtension = await mockPg('scheduled_services').where({ id }).first();
    expect(hasPricingRegimeMarker(parentAsReadByExtension)).toBe(true);
    const catalogRaisedTo20 = new Map([[lineDiscountId, 20]]);
    const result = restackStoredVisitFinancials(parentAsReadByExtension, [], null, catalogRaisedTo20);
    expect(result.primaryLineDiscountDollars).toBe(10); // frozen, never the raised $20 (or the uncapped $50)
    expect(result.price).toBe(90);
    expect(result.capsSnapshot.line).toBe(10); // the NEXT extension inherits the same frozen $10
  });

  test('an unmarked (legacy) row read from Postgres has a real NULL pricing_provenance — never the string "null" or an empty object', async () => {
    const id = randomUUID();
    await mockPg('scheduled_services').insert({
      id, scheduled_date: '2099-03-15', service_type: 'Fixture Legacy Service', primary_line_price: 100,
    });
    const row = await mockPg('scheduled_services').where({ id }).first();
    expect(row.pricing_provenance).toBeNull();
    expect(hasPricingRegimeMarker(row)).toBe(false);
    // And restacks with LIVE caps, exactly as before this fix.
    const liveCaps = new Map();
    const result = restackStoredVisitFinancials(row, [], null, liveCaps);
    expect(result.capsSnapshot).toEqual({ line: null, addons: {} });
  });

  test('gate-off parity: a row inserted with no pricing_provenance stays NULL — nothing this migration adds is written unconditionally', async () => {
    const id = randomUUID();
    await mockPg('scheduled_services').insert({
      id, scheduled_date: '2099-04-15', service_type: 'Fixture Gate-Off Service', primary_line_price: 50,
    });
    const row = await mockPg('scheduled_services').where({ id }).first();
    expect(row.pricing_provenance).toBeNull();
  });
});
