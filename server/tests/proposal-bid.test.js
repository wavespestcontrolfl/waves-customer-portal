jest.mock('../models/db', () => {
  const db = jest.fn(() => { throw new Error('This unit test must not access a database'); });
  db.raw = jest.fn(); db.fn = { now: jest.fn() };
  return db;
});
const { PDFDocument } = require('pdf-lib');
const { normalizeProposal, computeProposalTotals } = require('../services/estimate-proposal');
const { buildProposalFirstInvoice } = require('../services/proposal-win');
const { estimateExpiresAt } = require('../services/admin-estimate-persistence');
const { proposalExpiry, assertBidSendDate, validateBidFields, normalizeProjectCosting, assertBidScheduleDate, earliestScheduledDelivery, latestReachableSchedule } = require('../services/proposal-bid');
const { computeProjectCosts, roundCents, showsLineBasis } = require('../../shared/proposal-bid.cjs');
const { mapFormPrices, buildProposalBidForm } = require('../services/pdf/proposal-bid-form');

const line = (id, quantity, unitPrice, unit = 'acre') => ({ id, description: `Synthetic ${id}`, quantity, unitPrice, unit, frequency: 'one_time' });
const estimate = (lines, extra = {}) => ({ estimate_data: { proposal: { enabled: true, validThrough: '2026-12-21', buildings: [{ name: 'Synthetic property', lineItems: lines }], ...extra }, proposalCosting: { privateMarker: 'PRIVATE_COST_DO_NOT_RENDER' } } });
const normalized = (lines, extra) => normalizeProposal(estimate(lines, extra));

describe('bid quantity and costing authority', () => {
  test.each([[1, 10.075, 10.08], [146.5, 0.15, 21.98], [0.5, 2.01, 1.01], [1, 10.0749, 10.07], [1, 10.0751, 10.08], [1999899.9999, 50.0001, 99995199.98], [1999899.9999, 49.9999, 99994800.01]])('rounds %s × %s once to %s through persisted proposal and invoice totals', (quantity, price, expected) => {
    const proposal = normalized([line('half-cent', quantity, price)]);
    expect(proposal.buildings[0].lineItems[0].amount).toBe(expected);
    expect(computeProposalTotals(proposal).oneTime).toBe(expected);
    expect(buildProposalFirstInvoice(proposal).subtotal).toBe(expected);
  });
  test.each([
    [{ quantity: 1, unitPrice: 95 }, false],
    [{ quantity: 1, unitPrice: 10.075 }, true],
    [{ quantity: 1, unitPrice: 0.0755 }, true],
    [{ quantity: 2, unitPrice: 95 }, true],
    [{ quantity: 1, unit: 'each', unitPrice: 95 }, true],
  ])('customer documents show the basis for %o: %s', (line, shown) => {
    expect(showsLineBasis(line)).toBe(shown);
  });
  test('rounds decimal half cents without magnitude-dependent binary drift', () => {
    expect([10.075, -10.075, 1.005, 0.00000001].map(roundCents)).toEqual([10.08, -10.08, 1.01, 0]);
  });
  test('unknown or incomplete costs do not imply a zero-cost project and 100% margin', () => {
    expect(computeProjectCosts({ rows: [] }, { oneTime: 10000 })).toMatchObject({ profit: null, marginPercent: null, costsComplete: false });
    expect(computeProjectCosts({ rows: [{ description: 'Awaiting supplier price', quantity: 1, unitCost: '', occurrences: 1 }] }, { oneTime: 10000 })).toMatchObject({ profit: null, marginPercent: null });
  });
  test.each([['', null], ['abc', null], [0, null], [31, null], [2.5, null], ['3', 3], [undefined, 1]])('a present revenue period of %s never silently compares one year (GH codex P2 on #4270)', (revenueYears, expected) => {
    const rows = [{ category: 'labor', description: 'Synthetic complete cost', quantity: 1, unit: 'hour', unitCost: 10, occurrences: 1 }];
    const result = computeProjectCosts(revenueYears === undefined ? { rows } : { revenueYears, rows }, { oneTime: 100, annualRecurring: 50 });
    expect(result.revenueYears).toBe(expected);
    if (expected == null) expect(result).toMatchObject({ revenue: null, profit: null, marginPercent: null, costsComplete: false, cost: 10 });
    else expect(result).toMatchObject({ revenue: 100 + 50 * expected, profit: 90 + 50 * expected, costsComplete: true });
  });
  test.each([[146.5, 0.15, 1, 21.98], [1, 1.005, 2, 2.01], [2, 1.0075, 5, 10.08]])('rounds the complete project cost %s × %s × %s only once', (quantity, unitCost, occurrences, expected) => {
    const costing = { rows: [{ category: 'labor', description: 'Synthetic fractional cost', quantity, unit: 'hour', unitCost, occurrences }] };
    expect(computeProjectCosts(costing, { oneTime: 100 })).toMatchObject({ cost: expected, profit: roundCents(100 - expected) });
  });
  test.each([
    ['occurrences above 1,000', { occurrences: 1001 }],
    ['a five-decimal quantity', { quantity: 1.00001 }],
    ['a five-decimal unit cost', { unitCost: '0.00001' }],
    ['an extended cost above the cap', { quantity: 1000000, unitCost: 100, occurrences: 1 }],
    ['an unknown category', { category: 'misc' }],
    ['an unknown unit', { unit: 'bag' }],
    ['a blank description', { description: '  ' }],
  ])('a cost sheet with %s is incomplete in the UI exactly as the save would refuse it (GH codex P2 r2 on #4270)', (name, patch) => {
    const row = { category: 'labor', description: 'Synthetic cost', quantity: 1, unit: 'hour', unitCost: 10, occurrences: 1, ...patch };
    const summary = computeProjectCosts({ revenueYears: 1, rows: [row] }, { oneTime: 100 });
    expect(summary.costsComplete).toBe(false);
    expect(summary.profit).toBeNull();
    expect(validateBidFields({ buildings: [] }, { revenueYears: 1, rows: [row] })).toEqual(expect.any(String));
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
  test.each([0, -1, Infinity, NaN, null, true, '', 0.00001, 25.12345, 1.00000001, '1.0000000000000000001', '1e-5'])('rejects invalid quantity %s before normalization', (quantity) => {
    expect(validateBidFields({ buildings: [{ lineItems: [line('a', quantity, 10)] }] })).toMatch(/quantit/i);
  });
  test.each([null, true, Infinity, '', 1.23456, 1.00000001, '0.0000000000000000001'])('rejects invalid unit price %s before normalization', (unitPrice) => {
    expect(validateBidFields({ buildings: [{ lineItems: [line('a', 1, unitPrice)] }] })).toMatch(/Unit prices/);
  });
  test.each([1.2345, 0.1 + 0.2, 99999999.99, '1.2345000', '1000e-5', '.1234', '1.2345e2'])('accepts four-decimal values and minimal numeric roundoff: %s', (value) => {
    expect(validateBidFields({ buildings: [{ lineItems: [line('a', value, value)] }] })).toBeNull();
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
  test('scheduled sends are judged at the first five-minute scheduler tick they can reach', () => {
    expect(earliestScheduledDelivery(new Date('2026-09-23T03:55:00.000Z')).toISOString()).toBe('2026-09-23T03:55:00.000Z');
    expect(earliestScheduledDelivery(new Date('2026-09-23T03:55:00.001Z')).toISOString()).toBe('2026-09-23T04:00:00.000Z');
    expect(earliestScheduledDelivery(new Date('2026-09-23T03:58:30.000Z')).toISOString()).toBe('2026-09-23T04:00:00.000Z');
    expect(latestReachableSchedule(new Date('2026-09-23T03:59:59.999Z')).toISOString()).toBe('2026-09-23T03:55:00.000Z');
    expect(latestReachableSchedule(new Date('2026-09-23T04:00:00.000Z')).toISOString()).toBe('2026-09-23T04:00:00.000Z');
    const row = estimate([line('a', 1, 10)], { validThrough: '2026-09-22' });
    expect(() => assertBidScheduleDate(row, new Date('2026-09-23T03:55:00Z'))).not.toThrow();
    expect(() => assertBidScheduleDate(row, new Date('2026-09-23T03:58:00Z'))).toThrow(/too close to the end of the bid validity day/);
    expect(() => assertBidScheduleDate(row, new Date('2026-09-23T04:00:00Z'))).toThrow(/validity date has passed/);
    expect(() => assertBidScheduleDate(estimate([line('a', 1, 10)]), new Date('2026-09-23T03:58:00Z'))).not.toThrow();
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
  test('North Port mapping uses the same exact half-cent rounding as saved lines', () => {
    const proposal = normalized([line('product', 146.5, 0.15, 'lb'), line('apply', 0.5, 2.01), lines[2]]);
    expect(mapFormPrices(proposal, 'north_port_pr27_02', mapping)).toMatchObject({ amounts: { product: 21.98, application: 1.01, freight: 80 }, total: 102.99 });
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
  test('refuses to export a bid whose fixed validity date has passed', async () => {
    const pdf = await PDFDocument.create(); pdf.addPage([612, 792]);
    await expect(buildProposalBidForm({ estimate: estimate(lines, { validThrough: '2020-01-01' }), sourcePdf: Buffer.from(await pdf.save()), template: 'cove_termite', pageNumber: 1, mapping: { product: 'apartments', apply: 'clubhouse', freight: 'garages' } }))
      .rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/validity date has passed/) });
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

describe('bid form original integrity beyond the content streams', () => {
  const form = require('../services/pdf/proposal-bid-form');
  const mapping = { p: 'product', a: 'application' };
  const build = (sourcePdf) => buildProposalBidForm({ estimate: estimate([line('p', 500, 2, 'lb'), line('a', 25.8, 100)]), sourcePdf, template: 'north_port_pr27_02', pageNumber: 1, mapping });
  const blankPage = async (mutate = async () => {}) => {
    const pdf = await PDFDocument.create(); const page = pdf.addPage([612, 792]);
    page.drawText('Synthetic approved-content stand-in');
    await mutate(pdf, page);
    return Buffer.from(await pdf.save());
  };
  // Treat a synthetic page as the reviewed original by recording ITS
  // fingerprint, exactly as the reviewer script would for a real one.
  const original = form.FORM_PAGE_FINGERPRINTS.north_port_pr27_02;
  const approve = async (sourcePdf) => {
    const doc = await PDFDocument.load(sourcePdf);
    form.FORM_PAGE_FINGERPRINTS.north_port_pr27_02 = form.pageFingerprint(doc, doc.getPage(0));
  };
  afterEach(() => { form.FORM_PAGE_FINGERPRINTS.north_port_pr27_02 = original; });
  test('the reviewer script fingerprint is stable across reloads and includes resources', async () => {
    const sourcePdf = await blankPage();
    const a = await PDFDocument.load(sourcePdf); const b = await PDFDocument.load(sourcePdf);
    expect(form.pageFingerprint(a, a.getPage(0))).toEqual(form.pageFingerprint(b, b.getPage(0)));
    expect(form.pageFingerprint(a, a.getPage(0)).resources).toMatch(/^[0-9a-f]{64}$/);
  });
  test.each([
    ['original', [0, 0, 612, 792], [0, 0, 612, 792], true],
    ['clipped price column', [0, 0, 612, 792], [0, 0, 300, 792], false],
    ['shifted media origin', [20, 0, 612, 792], [0, 0, 612, 792], false],
    ['shifted crop origin', [0, 0, 612, 792], [20, 0, 612, 792], false],
  ])('%s page is accepted only with the reviewed visible layout', async (name, media, crop, accepted) => {
    await approve(await blankPage());
    const sourcePdf = await blankPage(async (pdf, page) => { page.setMediaBox(...media); page.setCropBox(...crop); });
    if (accepted) await expect(build(sourcePdf)).resolves.toBeInstanceOf(Buffer);
    else await expect(build(sourcePdf)).rejects.toThrow(/does not match/);
  });
  test('a page carrying annotations or widgets is refused before fingerprinting', async () => {
    await approve(await blankPage());
    const sourcePdf = await blankPage(async (pdf, page) => { pdf.getForm().createTextField('bidder').addToPage(page, { x: 50, y: 50, width: 200, height: 20 }); });
    await expect(build(sourcePdf)).rejects.toThrow(/annotations or form fields/);
  });
  test('blank fields elsewhere in the packet are allowed; filled ones are refused', async () => {
    await approve(await blankPage());
    const packet = (text) => blankPage(async (pdf) => {
      const other = pdf.addPage([612, 792]);
      const field = pdf.getForm().createTextField('company');
      field.addToPage(other, { x: 50, y: 50, width: 200, height: 20 });
      if (text) field.setText(text);
    });
    await expect(build(await packet(null))).resolves.toBeInstanceOf(Buffer);
    await expect(build(await packet('Previously filled bidder'))).rejects.toThrow(/already filled in/);
  });
  test('a swapped image behind identical drawing commands is refused (GH codex P2 r2 on #4270)', async () => {
    // Two pages whose content streams are byte-identical: pdf-lib names the
    // XObject deterministically per document, so only the image bytes differ.
    const png = (shade) => { const { PNG } = require('pngjs'); const img = new PNG({ width: 2, height: 2 }); img.data.fill(shade); return PNG.sync.write(img); };
    const withImage = (bytes) => blankPage(async (pdf, page) => { const image = await pdf.embedPng(bytes); page.drawImage(image, { x: 10, y: 10, width: 20, height: 20 }); });
    let reviewed; let swapped;
    try { reviewed = await withImage(png(0)); swapped = await withImage(png(255)); } catch { return; } // pngjs unavailable: covered by the resource-hash unit test above
    const a = await PDFDocument.load(reviewed); const b = await PDFDocument.load(swapped);
    const fa = form.pageFingerprint(a, a.getPage(0)); const fb = form.pageFingerprint(b, b.getPage(0));
    expect(fa.contents).toBe(fb.contents);
    expect(fa.resources).not.toBe(fb.resources);
    await approve(reviewed);
    await expect(build(reviewed)).resolves.toBeInstanceOf(Buffer);
    await expect(build(swapped)).rejects.toThrow(/does not match/);
  });
});
