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
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (req, _res, next) => { req.technicianId = 'admin-1'; req.techRole = 'admin'; next(); },
  requireTechOrAdmin: (_req, _res, next) => next(),
  requireAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const db = require('../models/db');
const router = require('../routes/admin-tax');
const TaxCalculator = require('../services/tax-calculator');
const { etDateString, addETDays } = require('../utils/datetime-et');

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
  let insertedRateId;

  beforeAll(async () => {
    before = await db('tax_rates').where({ county: 'Sarasota' }).orderBy('effective_date');
    await db('customers').insert({
      id: customerId, first_name: 'TaxRepro', last_name: 'Commercial', phone: '9415550199',
      email: `tax-repro-${customerId}@example.com`, zip: '34236', property_type: 'commercial',
    });
  });

  afterAll(async () => {
    await db('customers').where({ id: customerId }).del();
    // Delete the fixture rate this test inserted (codex round-1 P2) — the
    // baseline Sarasota row is left alone, only the FUTURE row this test
    // created.
    if (insertedRateId) await db('tax_rates').where({ id: insertedRateId }).del();
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
    insertedRateId = future.id;

    // EXPECTED: an invoice minted TODAY is still taxed at 7%, not 7.5%.
    const r = await TaxCalculator.calculateTax(customerId, 'nonresidential_pest_control', 100);
    expect(r.rate).toBeCloseTo(0.07, 6);
    expect(r.amount).toBe(7);
  });

  test('GET /rates labels the two rows current vs staged, not both active (codex round-3 P1)', async () => {
    const { status, body } = await withServer((base) => fetch(`${base}/admin/tax/rates`)
      .then(async (r) => ({ status: r.status, body: await r.json() })));
    expect(status).toBe(200);
    const sarasota = body.rates.filter((r) => r.county === 'Sarasota');
    const current = sarasota.find((r) => r.status === 'current');
    const staged = sarasota.find((r) => r.status === 'staged');
    // EXPECTED: exactly one 'current' row (both rows carry active:true on
    // the raw column, so a UI reading `active` directly would show both).
    expect(sarasota.filter((r) => r.status === 'current')).toHaveLength(1);
    expect(parseFloat(current.combinedRate)).toBeCloseTo(0.07, 6);
    expect(staged).toBeDefined();
    expect(parseFloat(staged.combinedRate)).toBeCloseTo(0.075, 6);
  });
});

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('backfilling a historical rate must not touch a later rate already in force (codex round-1 P1)', () => {
  const county = 'Manatee';
  const customerId = randomUUID();
  // "July" — already posted and in force — and "March", an earlier
  // historical correction backfilled AFTER July. Both computed relative to
  // today (never a fixed calendar date) so the test never goes stale.
  const laterDate = etDateString(addETDays(new Date(), -30));
  const backfillDate = etDateString(addETDays(new Date(), -90));

  beforeAll(async () => {
    await db('customers').insert({
      id: customerId, first_name: 'TaxBackfill', last_name: 'Commercial', phone: '9415550197',
      email: `tax-backfill-${customerId}@example.com`, zip: '34201', property_type: 'commercial',
    });
  });

  afterAll(async () => {
    await db('customers').where({ id: customerId }).del();
    await db('tax_rates').where({ county, effective_date: laterDate }).del();
    await db('tax_rates').where({ county, effective_date: backfillDate }).del();
  });

  test('a March backfill posted after a July rate leaves July in force for later invoices', async () => {
    const laterPost = await withServer((base) => fetch(`${base}/admin/tax/rates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ county, stateRate: 0.06, countySurtax: 0.015, effectiveDate: laterDate, notes: 'later (July) rate' }),
    }).then((r) => r.json()));
    expect(laterPost.success).toBe(true);

    const afterLater = await TaxCalculator.calculateTax(customerId, 'nonresidential_pest_control', 100);
    expect(afterLater.rate).toBeCloseTo(0.075, 6);

    const backfillPost = await withServer((base) => fetch(`${base}/admin/tax/rates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ county, stateRate: 0.06, countySurtax: 0.005, effectiveDate: backfillDate, notes: 'historical (March) correction' }),
    }).then((r) => r.json()));
    expect(backfillPost.success).toBe(true);

    const laterRow = await db('tax_rates').where({ county, effective_date: laterDate }).first();
    // EXPECTED: the backfill never touched the later (July) rate.
    expect(laterRow.active).toBe(true);
    expect(laterRow.expiry_date).toBeNull();

    // EXPECTED: today's tax calculation still resolves to the later rate,
    // not the historical backfill (codex round-1 P1 — this previously
    // retired the later rate too, since the old query matched every active
    // row with effective_date <= today instead of only the true
    // predecessor at the submitted date).
    const afterBackfill = await TaxCalculator.calculateTax(customerId, 'nonresidential_pest_control', 100);
    expect(afterBackfill.rate).toBeCloseTo(0.075, 6);
  });
});

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('compatibility with rates staged by the OLD (pre-fix) route shape (codex round-1 P1)', () => {
  const county = 'Charlotte';
  const customerId = randomUUID();
  // Old-shape rows the PRE-FIX route used to write when staging a future
  // rate: the predecessor demoted to active=false with its expiry_date set
  // to the future effective date, and the successor inserted active=true
  // but not yet effective.
  const predecessorEffective = etDateString(addETDays(new Date(), -100));
  const staged = etDateString(addETDays(new Date(), 30));

  beforeAll(async () => {
    await db('customers').insert({
      id: customerId, first_name: 'TaxOldShape', last_name: 'Commercial', phone: '9415550196',
      email: `tax-oldshape-${customerId}@example.com`, zip: '33947', property_type: 'commercial',
    });
    await db('tax_rates').where({ county, active: true }).update({ active: false, expiry_date: predecessorEffective });
    await db('tax_rates').insert({
      county, state: 'FL', state_rate: 0.06, county_surtax: 0.01, combined_rate: 0.07,
      effective_date: predecessorEffective, expiry_date: staged, active: false,
    });
    await db('tax_rates').insert({
      county, state: 'FL', state_rate: 0.06, county_surtax: 0.02, combined_rate: 0.08,
      effective_date: staged, expiry_date: null, active: true,
    });
  });

  afterAll(async () => {
    await db('customers').where({ id: customerId }).del();
    await db('tax_rates').where({ county, effective_date: predecessorEffective }).del();
    await db('tax_rates').where({ county, effective_date: staged }).del();
  });

  test('an old-shape predecessor (active=false, expiry in the future) is still honored until its expiry', async () => {
    const r = await TaxCalculator.calculateTax(customerId, 'nonresidential_pest_control', 100);
    // EXPECTED: the predecessor's 7% rate, not the successor's 8% (not yet
    // effective) and not the hardcoded 7% default-by-coincidence fallback
    // that would mask this bug — pin the exact reason string too.
    expect(r.rate).toBeCloseTo(0.07, 6);
    expect(r.reason).toContain('Charlotte');
  });

  test('the tax advisor also honors the old-shape predecessor instead of dropping the county (codex round-2 P1)', async () => {
    const TaxAdvisor = require('../services/tax-advisor');
    const rates = await TaxAdvisor.getCurrentTaxRates();
    const charlotteRows = rates.filter((r) => r.county === county);
    // EXPECTED: exactly one row for Charlotte (the still-in-force
    // predecessor), not zero (dropped because neither row satisfied the
    // active=true bound during the staged gap) and not the not-yet-
    // effective successor.
    expect(charlotteRows).toHaveLength(1);
    expect(parseFloat(charlotteRows[0].combined_rate)).toBeCloseTo(0.07, 6);
  });
});

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('a historical backfill must not outrank a later, still-effective old-shape legacy rate (codex round-5 P0)', () => {
  const county = 'Collier';
  const customerId = randomUUID();
  // "July" — an old-shape legacy row still genuinely in force (expiry in
  // the future) — and "January", a historical backfill posted well after
  // it, both computed relative to today.
  const legacyEffective = etDateString(addETDays(new Date(), -60));
  const legacyExpiry = etDateString(addETDays(new Date(), 30));
  const backfillDate = etDateString(addETDays(new Date(), -200));

  beforeAll(async () => {
    await db('customers').insert({
      id: customerId, first_name: 'TaxLegacyPrecedence', last_name: 'Commercial', phone: '9415550195',
      email: `tax-legacy-precedence-${customerId}@example.com`, zip: '34102', property_type: 'commercial',
    });
    // The old-shape legacy row: active=false, but its window still covers
    // today.
    await db('tax_rates').insert({
      county, state: 'FL', state_rate: 0.06, county_surtax: 0.015, combined_rate: 0.075,
      effective_date: legacyEffective, expiry_date: legacyExpiry, active: false,
    });
  });

  afterAll(async () => {
    await db('customers').where({ id: customerId }).del();
    await db('tax_rates').where({ county, effective_date: legacyEffective }).del();
    await db('tax_rates').where({ county, effective_date: backfillDate }).del();
  });

  test('a January backfill posted after the fact does not outrank the still-current July legacy rate', async () => {
    const backfillPost = await withServer((base) => fetch(`${base}/admin/tax/rates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ county, stateRate: 0.06, countySurtax: 0.005, effectiveDate: backfillDate, notes: 'historical (January) backfill' }),
    }).then((r) => r.json()));
    expect(backfillPost.success).toBe(true);

    // EXPECTED: the legacy row's 7.5% still wins — it is the newer
    // effective_date whose window covers today, even though it is
    // active:false and the backfill is active:true.
    const r = await TaxCalculator.calculateTax(customerId, 'nonresidential_pest_control', 100);
    expect(r.rate).toBeCloseTo(0.075, 6);

    const TaxAdvisor = require('../services/tax-advisor');
    const rates = await TaxAdvisor.getCurrentTaxRates();
    const collierRows = rates.filter((row) => row.county === county);
    expect(collierRows).toHaveLength(1);
    expect(parseFloat(collierRows[0].combined_rate)).toBeCloseTo(0.075, 6);
  });
});

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('correcting a staged future rate must not show the discarded draft as upcoming too (codex round-4 P1)', () => {
  const county = 'Lee';
  const staged = etDateString(addETDays(new Date(), 45));

  afterAll(async () => {
    await db('tax_rates').where({ county, effective_date: staged }).del();
  });

  test('GET /rates labels the replaced draft superseded, not a second staged row', async () => {
    const first = await withServer((base) => fetch(`${base}/admin/tax/rates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ county, stateRate: 0.06, countySurtax: 0.01, effectiveDate: staged, notes: 'draft' }),
    }).then((r) => r.json()));
    expect(first.success).toBe(true);

    const second = await withServer((base) => fetch(`${base}/admin/tax/rates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ county, stateRate: 0.06, countySurtax: 0.02, effectiveDate: staged, notes: 'corrected' }),
    }).then((r) => r.json()));
    expect(second.success).toBe(true);

    const { body } = await withServer((base) => fetch(`${base}/admin/tax/rates`)
      .then(async (r) => ({ status: r.status, body: await r.json() })));
    const leeRows = body.rates.filter((r) => r.county === county && r.effectiveDate && String(r.effectiveDate).slice(0, 10) === staged);
    // EXPECTED: only the corrected (0.08 combined) draft is 'staged'; the
    // discarded first draft (0.07 combined, now active:false) is
    // 'superseded', not shown a second time as an upcoming rate.
    const stagedRows = leeRows.filter((r) => r.status === 'staged');
    expect(stagedRows).toHaveLength(1);
    expect(parseFloat(stagedRows[0].combinedRate)).toBeCloseTo(0.08, 6);
    const supersededDraft = leeRows.find((r) => r.status === 'superseded');
    expect(supersededDraft).toBeDefined();
    expect(parseFloat(supersededDraft.combinedRate)).toBeCloseTo(0.07, 6);
  });

  test('correcting TODAY\'S rate for the same effective date actually changes what invoices are taxed (codex round-6 P0)', async () => {
    // Distinct from the UI-label case above: this asserts the CALCULATED
    // rate, not just how GET /rates displays it. Readers no longer gate
    // eligibility on `active` at all (round-5 P0 fix), so a same-date
    // replace that only flipped `active` — without also expiring the
    // discarded row — tied it against its replacement with an identical
    // effective_date and no reliable ordering; calculateTax could still
    // return the discarded 7% instead of the corrected 8%.
    const customerId = randomUUID();
    const today = etDateString();
    await db('customers').insert({
      id: customerId, first_name: 'TaxSameDateCorrection', last_name: 'Commercial', phone: '9415550194',
      email: `tax-samedate-${customerId}@example.com`, zip: '33901', property_type: 'commercial',
    });
    try {
      const first = await withServer((base) => fetch(`${base}/admin/tax/rates`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ county, stateRate: 0.06, countySurtax: 0.01, effectiveDate: today, notes: 'first post' }),
      }).then((r) => r.json()));
      expect(first.success).toBe(true);

      const second = await withServer((base) => fetch(`${base}/admin/tax/rates`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ county, stateRate: 0.06, countySurtax: 0.02, effectiveDate: today, notes: 'same-date correction' }),
      }).then((r) => r.json()));
      expect(second.success).toBe(true);

      const r = await TaxCalculator.calculateTax(customerId, 'nonresidential_pest_control', 100);
      expect(r.rate).toBeCloseTo(0.08, 6);
      expect(r.amount).toBe(8);
    } finally {
      await db('customers').where({ id: customerId }).del();
      await db('tax_rates').where({ county, effective_date: today }).del();
    }
  });
});

(process.env.DATABASE_URL?.includes('waves_audit_') ? describe : describe.skip)('correcting an old-shape legacy row for its own exact effective date must not tie against it (codex round-7 P0)', () => {
  const county = 'Charlotte';
  const customerId = randomUUID();
  const legacyEffective = etDateString(addETDays(new Date(), -150));
  const legacyExpiry = etDateString(addETDays(new Date(), 60));

  beforeAll(async () => {
    await db('customers').insert({
      id: customerId, first_name: 'TaxLegacySameDate', last_name: 'Commercial', phone: '9415550193',
      email: `tax-legacy-samedate-${customerId}@example.com`, zip: '33947', property_type: 'commercial',
    });
    // An old-shape legacy row: active=false, but still genuinely eligible
    // (its window covers today).
    await db('tax_rates').insert({
      county, state: 'FL', state_rate: 0.06, county_surtax: 0.01, combined_rate: 0.07,
      effective_date: legacyEffective, expiry_date: legacyExpiry, active: false,
    });
  });

  afterAll(async () => {
    await db('customers').where({ id: customerId }).del();
    await db('tax_rates').where({ county, effective_date: legacyEffective }).del();
  });

  test('a correction posted for the legacy row\'s exact effective date wins, not a tie with the discarded legacy row', async () => {
    const correction = await withServer((base) => fetch(`${base}/admin/tax/rates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ county, stateRate: 0.06, countySurtax: 0.02, effectiveDate: legacyEffective, notes: 'correcting the legacy row' }),
    }).then((r) => r.json()));
    expect(correction.success).toBe(true);

    const rows = await db('tax_rates').where({ county, effective_date: legacyEffective }).orderBy('combined_rate');
    const legacyRow = rows.find((row) => parseFloat(row.combined_rate) === 0.07);
    // EXPECTED: the legacy row is expired at the moment of correction,
    // regardless of having been active:false all along.
    expect(legacyRow.active).toBe(false);
    expect(legacyRow.expiry_date).not.toBeNull();

    const r = await TaxCalculator.calculateTax(customerId, 'nonresidential_pest_control', 100);
    expect(r.rate).toBeCloseTo(0.08, 6);
  });
});

// No database needed: validation runs (and rejects) before the route ever
// touches tax_rates, so this runs unconditionally.
describe('POST /admin/tax/rates rejects malformed rate strings before retiring anything (codex round-1 P1)', () => {
  test.each([
    ['a percent-sign string', { stateRate: 0.06, countySurtax: '6%' }],
    ['a non-numeric suffix', { stateRate: '0.06oops', countySurtax: 0.01 }],
    ['a value outside the 0-1 decimal-fraction convention', { stateRate: 6, countySurtax: 1 }],
  ])('%s is rejected with 400', async (_label, overrides) => {
    const res = await withServer((base) => fetch(`${base}/admin/tax/rates`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ county: 'Lee', effectiveDate: etDateString(), ...overrides }),
    }).then(async (r) => ({ status: r.status, body: await r.json() })));
    expect(res.status).toBe(400);
  });
});

// Single teardown for the whole file's shared knex connection, run once
// after every describe block above (each block's own afterAll only cleans
// up the ROWS it created — calling db.destroy() more than once in one file
// would break whichever block runs after the first destroy).
afterAll(async () => { await db.destroy(); });
