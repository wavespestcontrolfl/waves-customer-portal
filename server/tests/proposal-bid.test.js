jest.mock('../models/db', () => {
  const db = jest.fn(() => { throw new Error('This unit test must not access a database'); });
  db.raw = jest.fn(); db.fn = { now: jest.fn() };
  return db;
});
const { PDFDocument } = require('pdf-lib');
const { normalizeProposal, computeProposalTotals } = require('../services/estimate-proposal');
const { buildProposalFirstInvoice } = require('../services/proposal-win');
const { estimateExpiresAt } = require('../services/admin-estimate-persistence');
const { proposalExpiry, assertBidSendDate, validateBidFields, normalizeProjectCosting } = require('../services/proposal-bid');
const { computeProjectCosts } = require('../../shared/proposal-bid.cjs');
const { mapFormPrices, buildProposalBidForm } = require('../services/pdf/proposal-bid-form');

const line = (id, quantity, unitPrice, unit = 'acre') => ({ id, description: `Synthetic ${id}`, quantity, unitPrice, unit, frequency: 'one_time' });
const estimate = (lines, extra = {}) => ({ estimate_data: { proposal: { enabled: true, validThrough: '2026-12-21', buildings: [{ name: 'Synthetic property', lineItems: lines }], ...extra }, proposalCosting: { privateMarker: 'PRIVATE_COST_DO_NOT_RENDER' } } });
const normalized = (lines, extra) => normalizeProposal(estimate(lines, extra));

describe('bid quantity and costing authority', () => {
  test('unknown or incomplete costs do not imply a zero-cost project and 100% margin', () => {
    expect(computeProjectCosts({ rows: [] }, { oneTime: 10000 })).toMatchObject({ profit: null, marginPercent: null, costsComplete: false });
    expect(computeProjectCosts({ rows: [{ description: 'Awaiting supplier price', quantity: 1, unitCost: '', occurrences: 1 }] }, { oneTime: 10000 })).toMatchObject({ profit: null, marginPercent: null });
  });
  test('keeps fractional acres, sub-cent square-foot rates, and per-line cent rounding through reload and invoice billing', () => {
    const proposal = normalized([line('acre', 25.8, 100), line('slab', 14768, 0.0755, 'sqft'), line('fraction', 0.125, 1.08, 'gal')]);
    expect(proposal.buildings[0].lineItems.map((row) => row.amount)).toEqual([2580, 1114.98, 0.14]);
    expect(proposal.buildings[0].lineItems[0].quantity).toBe(25.8);
    expect(proposal.buildings[0].lineItems[1].unitPrice).toBe(0.0755);
    const reloaded = normalizeProposal({ estimate_data: JSON.stringify({ proposal }) });
    expect(reloaded).toEqual(proposal);
    expect(computeProposalTotals(reloaded).oneTime).toBe(3695.12);
    const invoice = buildProposalFirstInvoice(reloaded);
    expect(invoice.subtotal).toBe(3695.12);
    expect(invoice.lineItems.reduce((sum, item) => sum + item.quantity * item.unit_price, 0)).toBeCloseTo(invoice.subtotal, 2);
    expect(invoice.lineItems[0].description).toContain('25.8 acres × $100.00');
    expect(invoice.lineItems[1].description).toContain('14,768 sq ft × $0.0755');
    expect(JSON.stringify(proposal)).not.toContain('PRIVATE_COST_DO_NOT_RENDER');
  });
  test.each([0, -1, Infinity, NaN, null, true, '', 0.00001, 25.12345])('rejects invalid quantity %s before normalization', (quantity) => {
    expect(validateBidFields({ buildings: [{ lineItems: [line('a', quantity, 10)] }] })).toMatch(/quantit/i);
  });
  test.each([null, true, Infinity, '', 1.23456])('rejects invalid unit price %s before normalization', (unitPrice) => {
    expect(validateBidFields({ buildings: [{ lineItems: [line('a', 1, unitPrice)] }] })).toMatch(/Unit prices/);
  });
  test('costs all crew hours, trips, and warranty occurrences without engine caps or invented allowances', () => {
    const costing = { revenueYears: 1, rows: [
      { category: 'labor', phase: 'Phase A', description: 'Crew hours', quantity: 40, unit: 'hour', unitCost: 35, occurrences: 4 },
      { category: 'travel', phase: 'All phases', description: 'Travel', quantity: 1, unit: 'trip', unitCost: 85, occurrences: 4 },
      { category: 'warranty', phase: 'Five-year obligation', description: 'Warranty allowance', quantity: 1, unit: 'each', unitCost: 120, occurrences: 5 },
    ] };
    expect(validateBidFields({}, costing)).toBeNull();
    expect(computeProjectCosts(normalizeProjectCosting(costing), { oneTime: 10000 })).toMatchObject({ cost: 6540, revenue: 10000, profit: 3460, marginPercent: 34.6 });
    expect(computeProjectCosts({ ...costing, revenueYears: 5 }, { oneTime: 10000, annualRecurring: 500 }).revenue).toBe(12500);
    expect(validateBidFields({}, { ...costing, rows: [{ ...costing.rows[0], occurrences: 1.5 }] })).toMatch(/occurrences/);
  });
});

describe('fixed bid validity', () => {
  test.each([
    ['2026-09-22', '2026-09-23T03:59:59.999Z'],
    ['2026-12-21', '2026-12-22T04:59:59.999Z'],
    ['2026-03-07', '2026-03-08T04:59:59.999Z'],
    ['2026-03-08', '2026-03-09T03:59:59.999Z'],
    ['2026-11-01', '2026-11-02T04:59:59.999Z'],
  ])('honors the full Eastern calendar day %s, including DST', (validThrough, expected) => {
    const row = estimate([line('a', 25.8, 100)], { validThrough });
    expect(proposalExpiry(row).toISOString()).toBe(expected);
    expect(estimateExpiresAt(() => new Date('2026-09-01T12:00:00Z'), row).toISOString()).toBe(expected);
    expect(estimateExpiresAt(() => new Date('2026-09-20T12:00:00Z'), row).toISOString()).toBe(expected);
  });
  test('retains the seven-day legacy send window and rejects expired or impossible bid dates', () => {
    expect(estimateExpiresAt(() => new Date('2026-09-01T12:00:00Z')).toISOString()).toBe('2026-09-08T12:00:00.000Z');
    const row = estimate([line('a', 1, 10)], { validThrough: '2026-09-22' });
    expect(() => assertBidSendDate(row, new Date('2026-09-23T04:00:00Z'))).toThrow(/validity date has passed/);
    expect(() => assertBidSendDate(row, new Date('2026-09-23T03:59:59Z'))).not.toThrow();
    expect(validateBidFields({ validThrough: '2026-02-30' })).toMatch(/calendar date/);
  });
});

describe('required bid form price mapping', () => {
  const lines = [line('product', 500, 2, 'lb'), line('apply', 25.8, 100), line('freight', 1, 80, 'lump_sum')];
  const mapping = { product: 'product', apply: 'application', freight: 'freight' };
  test('quotes North Port with exact product units, acres and freight, reconciling to the proposal', () => {
    expect(mapFormPrices(normalized(lines), 'north_port_pr27_02', mapping)).toMatchObject({ amounts: { product: 1000, application: 2580, freight: 80, other: 0 }, total: 3660 });
  });
  test('requires a fixed date and enforces the 90-day North Port hold after the amended deadline', () => {
    expect(() => mapFormPrices(normalized(lines, { validThrough: null }), 'north_port_pr27_02', mapping)).toThrow(/explicit Valid through/);
    expect(() => mapFormPrices(normalized(lines, { validThrough: '2026-12-20' }), 'north_port_pr27_02', mapping)).toThrow(/90-day price hold/);
    expect(() => mapFormPrices(normalized(lines, { validThrough: '2026-12-21' }), 'north_port_pr27_02', mapping)).not.toThrow();
  });
  test('refuses omitted, removed, wrongly classified and over-cap lines', () => {
    expect(() => mapFormPrices(normalized(lines), 'north_port_pr27_02', { product: 'product' })).toThrow(/Every quoted line/);
    expect(() => mapFormPrices(normalized(lines), 'north_port_pr27_02', { ...mapping, removed: 'other' })).toThrow(/removed line/);
    expect(() => mapFormPrices(normalized([lines[0], { ...lines[1], unit: 'sqft' }, lines[2]]), 'north_port_pr27_02', mapping)).toThrow(/acre/);
    expect(() => mapFormPrices(normalized([line('product', 500, 2, 'lb'), line('apply', 25.8, 1500), lines[2]]), 'north_port_pr27_02', mapping)).toThrow(/34,999.99/);
  });
  test('groups Cove SF and prices while reconciling included tax to the cent', () => {
    const proposal = normalized([line('a', 1000, 0.1001, 'sqft'), line('b', 1000, 0.1001, 'sqft'), line('c', 1000, 0.1001, 'sqft')].map((row) => ({ ...row, taxable: true })), { taxRate: 0.07 });
    const result = mapFormPrices(proposal, 'cove_termite', { a: 'apartments', b: 'clubhouse', c: 'garages' });
    expect(result.total).toBe(321.32);
    expect(Object.values(result.amounts).reduce((sum, value) => sum + value, 0)).toBeCloseTo(321.32, 2);
  });
  test('refuses a PDF with the wrong layout even when prices and page size are valid', async () => {
    const pdf = await PDFDocument.create(); const page = pdf.addPage([612, 792]); page.drawText('Synthetic wrong form');
    await expect(buildProposalBidForm({ estimate: estimate(lines), sourcePdf: Buffer.from(await pdf.save()), template: 'north_port_pr27_02', pageNumber: 1, mapping })).rejects.toThrow(/does not match/);
  });
  test('tax rounding never reduces an individual Cove base-bid row', () => {
    const proposal = normalized([line('a', 1, 0.05, 'sqft'), line('b', 1, 0.05, 'sqft'), line('c', 1, 0.01, 'sqft')].map((row) => ({ ...row, taxable: true })), { taxRate: 0.1 });
    const result = mapFormPrices(proposal, 'cove_termite', { a: 'apartments', b: 'clubhouse', c: 'garages' });
    expect(result.total).toBe(0.12);
    expect(result.amounts.apartments).toBeGreaterThanOrEqual(0.05);
    expect(result.amounts.clubhouse).toBeGreaterThanOrEqual(0.05);
    expect(result.amounts.garages).toBeGreaterThanOrEqual(0.01);
    expect(Object.values(result.amounts).reduce((sum, value) => sum + value, 0)).toBeCloseTo(0.12, 2);
  });
});
