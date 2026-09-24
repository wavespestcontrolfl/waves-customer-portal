/**
 * AUDIT REPRO r1-billing-1 — POST /admin/tax/rates with a FUTURE effectiveDate
 * expires the current county rate immediately and inserts the new row as
 * active/unexpired, so TaxCalculator.calculateTax (no effective_date <= today
 * bound) applies the future rate to commercial invoices minted before that date.
 *
 * Real Postgres (clone of waves_audit_tpl via DATABASE_URL). Written to assert
 * the EXPECTED behaviour (current rate stays in force until the effective date),
 * so it FAILS on current code if the bug is real.
 */
const { randomUUID } = require('crypto');
jest.mock('../../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const db = require('../../models/db');
const router = require('../../routes/admin-tax');
const TaxCalculator = require('../../services/tax-calculator');
const { etDateString } = require('../../utils/datetime-et');

jest.setTimeout(30000);

async function withServer(fn) {
  const app = express();
  app.use(express.json());
  app.use('/admin/tax', router);
  app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.message }));
  const server = app.listen(0);
  try { return await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}

// Always at least 5 ET years past today, never a fixed calendar year (codex
// P1, round 3): a hardcoded '2027-01-01' would itself become "today or
// earlier" once 2027 arrives, silently flipping this test's own scenario
// from staged-future to immediate.
const FUTURE_YEAR = Number(etDateString().slice(0, 4)) + 5;
const FUTURE = `${FUTURE_YEAR}-01-01`;

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('future-dated county tax rate (real PG)', () => {
  const customerId = randomUUID();
  let before;

  beforeAll(async () => {
    before = await db('tax_rates').where({ county: 'Sarasota' }).orderBy('effective_date');
    await db('customers').insert({
      id: customerId, first_name: 'TaxRepro', last_name: 'Commercial', phone: '9415550199',
      email: `tax-repro-${customerId}@example.com`, zip: '34236', property_type: 'commercial',
    });
  });

  afterAll(async () => {
    await db('customers').where({ id: customerId }).del();
    await db.destroy();
  });

  test('seed sanity: one active Sarasota row at 7% and the calculator uses it', async () => {
    expect(before).toHaveLength(1);
    expect(before[0].active).toBe(true);
    expect(before[0].expiry_date).toBeNull();
    expect(parseFloat(before[0].combined_rate)).toBeCloseTo(0.07, 6);
    const r = await TaxCalculator.calculateTax(customerId, 'nonresidential_pest_control', 100);
    expect(r.county).toBe('Sarasota');
    expect(r.rate).toBeCloseTo(0.07, 6);
    expect(r.amount).toBe(7);
  });

  test('POST /rates with a future effectiveDate must NOT change the rate charged today', async () => {
    const res = await withServer((base) => fetch(`${base}/admin/tax/rates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ county: 'Sarasota', stateRate: 0.06, countySurtax: 0.015, effectiveDate: FUTURE, notes: 'surtax change next year' }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })));
    expect(res.status).toBe(200);

    const rows = await db('tax_rates').where({ county: 'Sarasota' }).orderBy('effective_date');
    const yr = (d) => (d instanceof Date ? d.getFullYear() : Number(String(d).slice(0, 4)));
    const current = rows.find((r) => yr(r.effective_date) === 2025);
    const future = rows.find((r) => yr(r.effective_date) === FUTURE_YEAR);
    // Diagnostic dump so the failure output shows exactly what the route wrote.

    console.log('tax_rates(Sarasota) after POST:', rows.map((r) => ({ eff: yr(r.effective_date), exp: r.expiry_date && yr(r.expiry_date), active: r.active, rate: r.combined_rate })));

    // EXPECTED: the 2025 row is still the active, unexpired row until the future date.
    expect(current.active).toBe(true);
    expect(current.expiry_date).toBeNull();
    expect(future).toBeDefined();

    // EXPECTED: an invoice minted TODAY is still taxed at 7%, not 7.5%.
    const r = await TaxCalculator.calculateTax(customerId, 'nonresidential_pest_control', 100);
    expect(r.rate).toBeCloseTo(0.07, 6);
    expect(r.amount).toBe(7);
  });
});
