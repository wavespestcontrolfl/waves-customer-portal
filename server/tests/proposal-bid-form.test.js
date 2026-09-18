jest.mock('../models/db', () => { const db = jest.fn(() => { throw new Error('No database access'); }); db.raw = jest.fn(); return db; });
const { PDFDocument, PDFName } = require('pdf-lib');
const { normalizeProposal } = require('../services/estimate-proposal');
const { mapFormPrices, buildProposalBidForm } = require('../services/pdf/proposal-bid-form');
beforeAll(() => jest.useFakeTimers({ toFake: ['Date'], now: new Date('2026-09-09T16:00:00Z') }));
afterAll(() => jest.useRealTimers());
const line = (id, quantity, unitPrice, unit = 'acre') => ({ id, description: `Synthetic ${id}`, quantity, unitPrice, unit, frequency: 'one_time' });
const estimate = (lines, extra = {}) => ({ estimate_data: { proposal: { enabled: true, validThrough: '2026-12-21', buildings: [{ name: 'Synthetic property', lineItems: lines }], ...extra } } });
const normalized = (lines, extra) => normalizeProposal(estimate(lines, extra));
describe('required bid form price mapping', () => {
  test('export preserves other-page field appearances rather than rebuilding them', async () => {
    const form = require('../services/pdf/bid-form-original');
    const savedProfile = form.FORM_PAGE_FINGERPRINTS.north_port_pr27_02;
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([612, 792]); page.drawText('Synthetic form');
    const other = pdf.addPage([612, 792]);
    const field = pdf.getForm().createTextField('Synthetic bidder');
    field.addToPage(other, { x: 50, y: 50, width: 100, height: 20 });
    field.acroField.getWidgets()[0].dict.delete(PDFName.of('AP'));
    const sourcePdf = Buffer.from(await pdf.save({ updateFieldAppearances: false }));
    const original = await PDFDocument.load(sourcePdf);
    form.FORM_PAGE_FINGERPRINTS.north_port_pr27_02 = { ...form.pageFingerprint(original, original.getPage(0)), packet: form.packetFingerprint(original, 0) };
    try {
      const output = await buildProposalBidForm({ estimate: estimate([line('p', 500, 2, 'lb'), line('a', 25.8, 100)]), sourcePdf, template: 'north_port_pr27_02', pageNumber: 1, mapping: { p: 'product', a: 'application' } });
      const result = await PDFDocument.load(output);
      expect(form.packetFingerprint(result, 0)).toBe(form.packetFingerprint(original, 0));
      expect(result.getForm().getField('Synthetic bidder').acroField.getWidgets()[0].dict.get(PDFName.of('AP'))).toBeUndefined();
    } finally { form.FORM_PAGE_FINGERPRINTS.north_port_pr27_02 = savedProfile; }
  });
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
    const result = mapFormPrices(proposal, 'cove_termite', { a: 'apartments', b: 'clubhouse', c: 'garages' }, { submissionDate: '2026-09-22' });
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
    const result = mapFormPrices(proposal, 'cove_termite', { a: 'apartments', b: 'clubhouse', c: 'garages' }, { submissionDate: '2026-09-22' });
    expect(result.total).toBe(0.12);
    expect(result.amounts.apartments).toBeGreaterThanOrEqual(0.05);
    expect(result.amounts.clubhouse).toBeGreaterThanOrEqual(0.05);
    expect(result.amounts.garages).toBeGreaterThanOrEqual(0.01);
    expect(Object.values(result.amounts).reduce((sum, value) => sum + value, 0)).toBeCloseTo(0.12, 2);
  });
});


test('Cove requires an explicit calendar submission date and the full 90-day hold', () => {
  const lines = ['a', 'b', 'c'].map((id) => line(id, 1000, 0.1, 'sqft'));
  const mapping = { a: 'apartments', b: 'clubhouse', c: 'garages' };
  for (const submissionDate of [undefined, '', '2026-02-30']) {
    expect(() => mapFormPrices(normalized(lines), 'cove_termite', mapping, { submissionDate })).toThrow(/submission date/);
  }
  expect(() => mapFormPrices(normalized(lines, { validThrough: '2026-12-20' }), 'cove_termite', mapping, { submissionDate: '2026-09-22' })).toThrow(/90-day price hold/);
  expect(() => mapFormPrices(normalized(lines, { validThrough: '2026-12-21' }), 'cove_termite', mapping, { submissionDate: '2026-09-22' })).not.toThrow();
  expect(() => mapFormPrices(normalized(lines, { validThrough: '2027-03-01' }), 'cove_termite', mapping, { submissionDate: '2026-12-01' })).not.toThrow();
});
