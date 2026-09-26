/**
 * purchase-receipts/siteone-invoices.js — which emails are SiteOne invoices,
 * the invoice number the email itself names, and the reconciliation that
 * decides whether the invoice pipeline's AI-extracted lines may move stock.
 * The numbers are a real invoice's; its identifiers are synthetic.
 */
const {
  isSiteOneInvoiceEmail, emailInvoiceNumber, verificationProblem, readSiteOneInvoice,
} = require('../services/purchase-receipts/siteone-invoices');

const INVOICE = '900000001-001';
const extracted = () => ({
  invoice_number: INVOICE, subtotal: 198.34, tax: 13.88, total: 212.22,
  line_items: [
    { description: 'CSI-Pest Taurus SC Broad Spectrum Liquid Concentrate Termiticide/Insecticide 78 fl oz. Bottle (QGCY) UOM:EA', quantity: 1, unit_price: 95, total: 95 },
    { description: 'Control Solutions Cyper TC Contact Liquid Concentrate Insecticide/Termiticide 1 gal. Jug', quantity: 1, unit_price: 82.345, total: 82.35 },
    { description: 'Flowzone Cyclone 3 Variable Pressure 18V Battery Powered Sprayer (4-Gallon)', quantity: 1, unit_price: 269.99, total: 269.99 },
    { description: 'LESCO 18V Variable Flow Zero Pump 4 gal. Battery Powered Backpack Sprayer (Credit Reason: Does Not Want)', quantity: -1, unit_price: 249, total: -249 },
  ],
});
const storeEmail = { id: 'e-store', from_address: 'AB00000@siteone.com', subject: `SiteOne Confirmation : Invoice #${INVOICE}`, received_at: new Date('2026-09-27T12:00:00Z') };
const billingEmail = {
  id: 'e-bill', from_address: 'siteoneus@billtrust.com', subject: 'Acct No. 0000000: Your Invoice From SiteOne Landscape Supply, LLC is Attached',
  body_text: '', body_html: `<td><U>AMOUNT</U></td></tr><tr><td>&nbsp;</td><td align=center>${INVOICE}</td><td align=center></td><td>$212.22</td>`,
  received_at: new Date('2026-09-28T04:39:00Z'),
};

describe('isSiteOneInvoiceEmail', () => {
  test.each([
    ['the store invoice email', storeEmail, true],
    ['the billing copy', billingEmail, true],
    ['a store order summary (not an invoice)', { ...storeEmail, subject: 'SiteOne Confirmation : Order Summary - Master Order #M000000000' }, false],
    ['marketing from a SiteOne subdomain', { ...storeEmail, from_address: 'marketing@grow.siteone.com' }, false],
    ['another billtrust client', { ...billingEmail, subject: 'Your Invoice From Another Supplier is Attached' }, false],
  ])('%s -> %s', (_label, email, expected) => {
    expect(isSiteOneInvoiceEmail(email)).toBe(expected);
  });
});

describe('emailInvoiceNumber', () => {
  test('the store email names it in the subject; the billing email in its HTML body', () => {
    expect(emailInvoiceNumber(storeEmail)).toBe(INVOICE);
    expect(emailInvoiceNumber(billingEmail)).toBe(INVOICE);
    expect(emailInvoiceNumber({ subject: 'Invoice', body_html: 'no number here' })).toBeNull();
  });
});

describe('verificationProblem', () => {
  test('a real invoice reconciles (unit prices carry a third decimal: 82.345 -> 82.35)', () => {
    expect(verificationProblem(extracted(), INVOICE)).toBeNull();
  });

  test('an absent tax is 0, and numeric text counts as a number', () => {
    const data = { ...extracted(), tax: undefined, total: '198.34' };
    expect(verificationProblem(data, INVOICE)).toBeNull();
  });

  test.each([
    ['a different invoice number than the email names', (d) => { d.invoice_number = '900000002-001'; }, 'invoice_number'],
    ['a quantity that disagrees with its line total (ordered 2, charged for 1)', (d) => { d.line_items[0].quantity = 2; }, 'line_math'],
    ['lines that don\'t sum to the subtotal', (d) => { d.subtotal = 298.34; }, 'subtotal'],
    ['a subtotal plus tax that isn\'t the total', (d) => { d.total = 222.22; }, 'total'],
    ['an unreadable quantity', (d) => { d.line_items[1].quantity = 'one'; }, 'missing_amounts'],
    ['every amount missing (null would read as 0 and reconcile)', (d) => {
      d.line_items = [{ description: 'Taurus SC 78 fl oz. UOM:EA', quantity: 2, unit_price: null, total: null }];
      Object.assign(d, { subtotal: null, tax: null, total: null });
    }, 'missing_amounts'],
    ['a blank subtotal', (d) => { d.subtotal = ''; }, 'missing_amounts'],
    ['a tax that isn\'t a number', (d) => { d.tax = 'n/a'; }, 'missing_amounts'],
  ])('%s -> %s', (_label, mutate, problem) => {
    const data = extracted();
    mutate(data);
    expect(verificationProblem(data, INVOICE)).toBe(problem);
  });
});

describe('readSiteOneInvoice', () => {
  // email_attachments lookup: .where().whereNotNull().first() -> the stored extraction.
  const conn = (extractedData) => () => {
    const q = { where: () => q, whereNotNull: () => q, first: async () => (extractedData === undefined ? undefined : { extracted_data: extractedData }) };
    return q;
  };
  const now = new Date('2026-09-27T13:00:00Z').getTime(); // an hour after the store email

  test('not read into lines yet: pending inside the 2-hour grace, then one unreadable placeholder', async () => {
    expect(await readSiteOneInvoice(storeEmail, now, conn(undefined))).toEqual({ pending: true });
    expect(await readSiteOneInvoice(storeEmail, now + 2 * 3600e3, conn(undefined))).toEqual({ number: INVOICE, problem: 'unreadable', lines: [] });
  });

  test('a read invoice yields its lines in invoice order (both copies key a line the same way)', async () => {
    const invoice = await readSiteOneInvoice(storeEmail, now, conn(JSON.stringify(extracted())));
    expect(invoice.problem).toBeNull();
    expect(invoice.lines.map(({ quantity, lineNo }) => [quantity, lineNo])).toEqual([[1, 1], [1, 2], [1, 3], [-1, 4]]);
  });

  test('each line\'s unit of measure: the extracted field, else a "UOM:EA" in its description, else null', async () => {
    const data = extracted();
    data.line_items[1].uom = 'cs';
    const invoice = await readSiteOneInvoice(storeEmail, now, conn(data));
    expect(invoice.lines.map(({ uom }) => uom)).toEqual(['EA', 'CS', null, null]);
  });

  test.each([
    ['empty', []],
    ['not a list', { description: 'Taurus SC' }],
    ['missing a quantity', [{ description: 'Taurus SC 78 fl oz. UOM:EA', quantity: null, unit_price: 95, total: 95 }]],
    ['a blank quantity', [{ description: 'Taurus SC 78 fl oz. UOM:EA', quantity: '', unit_price: 95, total: 95 }]],
  ])('read, but its lines are %s: one unreadable placeholder, never a crash or a silent 0', async (_label, lineItems) => {
    expect(await readSiteOneInvoice(storeEmail, now, conn({ ...extracted(), line_items: lineItems })))
      .toEqual({ number: INVOICE, problem: 'unreadable', lines: [] });
  });

  test('an email that names no invoice number is not keyed at all', async () => {
    expect(await readSiteOneInvoice({ ...billingEmail, body_html: '' }, now, conn(extracted()))).toBeNull();
  });
});
