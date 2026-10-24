/**
 * Misting PR 2c, item 3: a refill on one occurrence of a misting series is billed ONCE, on that occurrence, and never multiplied across
 * the prepaid term or counted as coverage money.
 *
 *  - the refill is a visit add-on row (never on the prepay invoice), so the term's per-visit coverage basis (seededVisitPriceForTerm)
 *    reads the prepay invoice's coverage line and nothing else;
 *  - the occurrence that carries it invoices it as its own line, named with the sold solution; the others invoice nothing for it;
 *  - on an annual-prepay COVERED occurrence the refill is the add-on owed on top of the coverage (annual-prepay-addon-billing), found
 *    by the same client ids the invoice builder gives it, and an unpriced one is owed-but-unpriced, never silently free;
 *  - the series booking that would multiply it (prepay on book = per-visit price x planned visits) is refused up front.
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret';
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const InvoiceService = require('../services/invoice');
const prepayBilling = require('../services/annual-prepay-addon-billing');
const renewals = require('../services/annual-prepay-renewals');
const misting = require('../utils/mosquito-misting-system');
const refill = require('../services/misting-refill');

const REFILL_NAME = 'Mosquito Misting System Refill - Natural (botanical)';
const OCCURRENCES = ['occ-1', 'occ-2', 'occ-3'];
const REFILL_ROW = { id: 'row-9', scheduled_service_id: 'occ-2', service_name: REFILL_NAME, service_key_snapshot: 'mosquito_misting_refill', base_price: 219, estimated_price: 219, created_at: 1 };

// A connection scripted for the reads these services make; any other table throws so a stray read is a failure.
function fakeConn({ visits, addons, invoices = [] }) {
  const conn = (table) => {
    const allowed = { scheduled_services: visits, scheduled_service_addons: addons, invoices };
    if (!(table in allowed)) throw new Error(`unexpected read of ${table}`);
    let rows = allowed[table];
    const q = {
      where(cond) { rows = rows.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v)); return q; },
      orderBy() { return Object.assign(Promise.resolve(rows), { select: async () => rows }); },
      first: async () => rows[0],
      select: async () => rows,
    };
    return q;
  };
  return conn;
}
const visit = (id) => ({ id, service_type: 'Mosquito Misting Service Plan', estimated_price: id === 'occ-2' ? 278 : 59, primary_line_price: 59 });
const world = (over = {}) => ({ visits: OCCURRENCES.map(visit), addons: [REFILL_ROW], ...over });

describe('monthly path: the occurrence that carries the refill invoices it once, the others do not', () => {
  const lines = async (id, conn = fakeConn(world())) => (await InvoiceService.buildLineItemsForScheduledService(id, { database: conn, strictReads: true })).lineItems;

  test('the carrying occurrence bills the plan price and the refill line, named with the solution', async () => {
    const out = await lines('occ-2');
    expect(out.map((l) => [l.description, l.amount])).toEqual([['Mosquito Misting Service Plan', 59], [REFILL_NAME, 219]]);
    expect(out[1]).toMatchObject({ service_key: 'mosquito_misting_refill', quantity: 1, unit_price: 219 });
    expect(out.reduce((sum, l) => sum + l.amount, 0)).toBe(278);
  });

  test('the other occurrences of the series bill only the plan price', async () => {
    for (const id of ['occ-1', 'occ-3']) {
      const out = await lines(id);
      expect(out.map((l) => [l.description, l.amount])).toEqual([['Mosquito Misting Service Plan', 59]]);
    }
  });
});

describe('annual prepay path: coverage money is the prepay invoice\'s coverage line, never a refill', () => {
  const prepayInvoice = (lineItems) => ({ id: 'inv-prepay', subtotal: 708 + 2400, total: 3108, line_items: lineItems });
  const coverage = { description: 'Mosquito Misting Service Plan - 12 months prepaid', quantity: 1, unit_price: 708, kind: 'annual_prepay_coverage' };
  const install = misting.mistingInstallLine({ description: 'Smart system (tankless + app) Installation', amount: 2400 });

  test('the per-visit basis is the coverage line over the sold visits (59), whatever refills the visits carry', async () => {
    // Only the prepay invoice may be read: a read of the visits' add-on rows would throw.
    const conn = fakeConn({ visits: [], addons: [], invoices: [prepayInvoice([coverage, install])].map((i) => ({ ...i })) });
    const price = await renewals.seededVisitPriceForTerm({ prepay_invoice_id: undefined }, conn, 12);
    expect(price).toBeNull(); // no invoice id on the term: nothing derivable
    const withInvoice = fakeConn({ visits: [], addons: [], invoices: [prepayInvoice([coverage, install])] });
    expect(await renewals.seededVisitPriceForTerm({ prepay_invoice_id: 'inv-prepay' }, withInvoice, 12)).toBe(59);
  });

  test('the refill is not coverage: a prepay invoice that somehow carried one still counts only the coverage line', async () => {
    const stray = { description: REFILL_NAME, quantity: 1, unit_price: 219 };
    const conn = fakeConn({ visits: [], addons: [], invoices: [prepayInvoice([coverage, install, stray])] });
    expect(await renewals.seededVisitPriceForTerm({ prepay_invoice_id: 'inv-prepay' }, conn, 12)).toBe(59);
  });

  test('a covered occurrence owes the refill on top of the coverage, found by the invoice builder\'s own client id', async () => {
    const conn = fakeConn(world());
    const owed = await prepayBilling.annualPrepayAddonRows({ id: 'occ-2' }, conn);
    expect(owed).toMatchObject({ owed: true, priced: true, unpriced: false });
    const { lineItems } = await InvoiceService.buildLineItemsForScheduledService('occ-2', { database: conn, strictReads: true });
    const refillLine = lineItems.find((l) => l.description === REFILL_NAME);
    expect(owed.clientIds.has(refillLine.client_id)).toBe(true);
    expect(owed.owedClientIds.has(refillLine.client_id)).toBe(true);
    // the covered base line is not an add-on line, so it is never billed again here
    expect(owed.clientIds.has(lineItems.find((l) => l.description === 'Mosquito Misting Service Plan').client_id)).toBe(false);
  });

  test('the other covered occurrences owe nothing for it', async () => {
    for (const id of ['occ-1', 'occ-3']) {
      expect(await prepayBilling.annualPrepayAddonRows({ id }, fakeConn(world()))).toMatchObject({ owed: false, priced: false, unpriced: false });
    }
  });

  test('a refill row with no price is owed but unpriced (the office prices it), never free', async () => {
    const unpriced = { ...REFILL_ROW, base_price: null, estimated_price: null };
    expect(await prepayBilling.annualPrepayAddonRows({ id: 'occ-2' }, fakeConn(world({ addons: [unpriced] })))).toMatchObject({ owed: true, priced: false, unpriced: true });
  });

  test('an issued occurrence invoice that bills only the refill is kept (its charge stays owed); the refill is never read as the covered base application', async () => {
    const conn = fakeConn(world());
    const owed = await prepayBilling.annualPrepayAddonRows({ id: 'occ-2' }, conn);
    const { lineItems } = await InvoiceService.buildLineItemsForScheduledService('occ-2', { database: conn, strictReads: true });
    const refillOnly = lineItems.filter((l) => l.description === REFILL_NAME);
    expect(prepayBilling.classifyCoveredVisitInvoice({ line_items: refillOnly }, owed)).toEqual({ billsOnlyAddons: true, otherCharges: true });
    expect(prepayBilling.classifyCoveredVisitInvoice({ line_items: lineItems }, owed)).toMatchObject({ billsOnlyAddons: false, otherCharges: true });
  });
});

describe('prepay on book: the per-visit price x planned visits can never include a refill', () => {
  test('a series booking carrying a refill is refused before any prepay total is computed', async () => {
    const result = await refill.resolveRefillAttachment({ customerId: 'c', propertyId: 'p', parentServiceKey: 'mosquito_misting_service', isRecurring: true }, () => { throw new Error('no read'); });
    expect(result).toMatchObject({ ok: false, code: 'MISTING_REFILL_ON_SERIES', status: 400 });
    expect(result.message).toMatch(/billed on one visit/);
  });

  test('one source pin: the booking pricing builder passes the series flag to the resolver, and so does POST /preview', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin-schedule.js'), 'utf8');
    expect((src.match(/isRecurring: !!isRecurring \}/g) || []).length).toBeGreaterThanOrEqual(2);
    expect(src).toContain('isRecurring: !!refillContext?.isRecurring');
  });
});
