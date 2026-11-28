/**
 * Billing audit B-39:
 *  1. Invoice PDF overdue badge uses ET calendar-day comparison (due_date < today ET),
 *     so Day-0 bills and bills viewed after 7/8 PM ET the evening before the due date
 *     render DUE rather than red OVERDUE.
 *  2. Long wrapped discount labels in totalsBlock advance y by their measured wrapped
 *     height and reserve that wrapped height in extraDiscountRowsHeight so rows and
 *     the TOTAL rule never overlap or run off the page.
 */

const PDFDocument = require('pdfkit');
const { buildInvoicePDFBuffer } = require('../services/pdf/invoice-pdf');
const { PDF_TYPE } = require('../services/pdf/pdf-tokens');

function invoice(overrides = {}) {
  return {
    invoice_number: 'WPC-B39-001',
    status: 'sent',
    subtotal: 200,
    discount_amount: 0,
    tax_amount: 0,
    total: 200,
    amount_paid: 0,
    credit_applied: 0,
    created_at: new Date('2026-07-18T14:00:00Z'),
    due_date: '2026-07-19',
    line_items: [{ description: 'Quarterly Pest Control', quantity: 1, unit_price: 200, amount: 200 }],
    customer: {
      first_name: 'Pat',
      last_name: 'Sample',
      address_line1: '1 Test Way',
      city: 'Bradenton',
      state: 'FL',
      zip: '34209',
      property_type: 'residential',
    },
    ...overrides,
  };
}

async function captureCalls(build) {
  const texts = [];
  let page = 1;
  const realAddPage = PDFDocument.prototype.addPage;
  const addPageSpy = jest.spyOn(PDFDocument.prototype, 'addPage').mockImplementation(function recordPage(...args) {
    page += 1;
    return realAddPage.apply(this, args);
  });
  const realText = PDFDocument.prototype.text;
  const textSpy = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function recordText(text, x, y, opts) {
    texts.push({ text: String(text), x, y, opts, page });
    return realText.apply(this, arguments);
  });
  try {
    const buffer = await build();
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    return texts;
  } finally {
    textSpy.mockRestore();
    addPageSpy.mockRestore();
  }
}

describe('invoice PDF ET due-date overdue boundary (B-39)', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  test('renders DUE (not OVERDUE) on the evening before due_date after UTC midnight', async () => {
    // 2026-07-18 9:00 PM EDT = 2026-07-19T01:00:00Z (past UTC midnight for 2026-07-19).
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-07-19T01:00:00Z'));

    const callsStr = await captureCalls(() => buildInvoicePDFBuffer(invoice({ due_date: '2026-07-19' })));
    expect(callsStr.map((c) => c.text)).toContain('DUE');
    expect(callsStr.map((c) => c.text)).not.toContain('OVERDUE');

    const callsDate = await captureCalls(() => buildInvoicePDFBuffer(invoice({ due_date: new Date('2026-07-19T00:00:00.000Z') })));
    expect(callsDate.map((c) => c.text)).toContain('DUE');
    expect(callsDate.map((c) => c.text)).not.toContain('OVERDUE');
  });

  test('renders DUE (not OVERDUE) when due_date is today in ET', async () => {
    // 2026-07-19 12:00 PM EDT = 2026-07-19T16:00:00Z.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-07-19T16:00:00Z'));

    const calls = await captureCalls(() => buildInvoicePDFBuffer(invoice({ due_date: '2026-07-19' })));
    expect(calls.map((c) => c.text)).toContain('DUE');
    expect(calls.map((c) => c.text)).not.toContain('OVERDUE');
  });

  test('renders OVERDUE once ET calendar day passes due_date', async () => {
    // 2026-07-20 12:05 AM EDT = 2026-07-20T04:05:00Z.
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-07-20T04:05:00Z'));

    const calls = await captureCalls(() => buildInvoicePDFBuffer(invoice({ due_date: '2026-07-19' })));
    expect(calls.map((c) => c.text)).toContain('OVERDUE');
  });

  test('keeps PAID and PREPAID badges even when due_date is in the past', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
    jest.setSystemTime(new Date('2026-07-25T16:00:00Z'));

    const paidCalls = await captureCalls(() => buildInvoicePDFBuffer(invoice({ status: 'paid', due_date: '2026-07-19' })));
    expect(paidCalls.map((c) => c.text)).toContain('PAID');
    expect(paidCalls.map((c) => c.text)).not.toContain('OVERDUE');

    const prepaidCalls = await captureCalls(() => buildInvoicePDFBuffer(invoice({ status: 'prepaid', due_date: '2026-07-19' })));
    expect(prepaidCalls.map((c) => c.text)).toContain('PREPAID');
    expect(prepaidCalls.map((c) => c.text)).not.toContain('OVERDUE');
  });
});

describe('invoice PDF wrapped discount labels in totalsBlock (B-39)', () => {
  test('advances y by wrapped height of long discount labels so rows and TOTAL never overlap', async () => {
    const label1 = 'WaveGuard Platinum Multi-Service Loyalty Promotional Discount (15%)';
    const label2 = 'First-Time Seasonal Bundle Customer Appreciation Promotional Credit';
    const inv = invoice({
      subtotal: 200,
      discount_amount: 50,
      discount_label: `${label1} + ${label2}`,
      total: 150,
      line_items: [
        { description: 'Quarterly Pest Control', quantity: 1, unit_price: 200, amount: 200 },
        { _kind: 'discount', description: label1, quantity: 1, unit_price: -30, amount: -30 },
        { _kind: 'discount', description: label2, quantity: 1, unit_price: -20, amount: -20 },
      ],
    });

    const probe = new PDFDocument({ size: 'LETTER', margin: 40 });
    probe.fontSize(PDF_TYPE.body).font('Helvetica');
    const expectedH1 = Math.max(14, Math.ceil(probe.heightOfString(label1, { width: 160 })) + 4);
    const expectedH2 = Math.max(14, Math.ceil(probe.heightOfString(label2, { width: 160 })) + 4);
    expect(expectedH1).toBeGreaterThan(14);
    expect(expectedH2).toBeGreaterThan(14);

    const calls = await captureCalls(() => buildInvoicePDFBuffer(inv));
    const row1 = calls.find((c) => c.text === label1);
    const row2 = calls.find((c) => c.text === label2);
    const totalRow = calls.find((c) => c.text === 'TOTAL');

    expect(row1).toBeDefined();
    expect(row2).toBeDefined();
    expect(totalRow).toBeDefined();
    expect(row2.y - row1.y).toBe(expectedH1);
    // TOTAL sits 10pt below the last pre-total row (2pt + 8pt around the rule).
    expect(totalRow.y - row2.y).toBe(expectedH2 + 10);
  });

  test('reserves wrapped discount height on multi-property invoices so TOTAL stays on the same page', async () => {
    const longLabel = 'WaveGuard Platinum Multi-Property Loyalty Promotional Discount Applied To This Account';
    const lines = [];
    for (let p = 0; p < 2; p += 1) {
      const property_address = { address_line1: `${p + 1} Test Way`, city: 'Bradenton', state: 'FL', zip: '34209' };
      for (let i = 0; i < 12; i += 1) {
        lines.push({
          description: `Service ${p}-${i}`,
          quantity: 1,
          unit_price: 10,
          amount: 10,
          property_id: `prop-${p}`,
          property_address,
        });
      }
    }
    // Document-wide discounts (no property_id) render in totalsBlock.
    lines.push({ _kind: 'discount', description: `${longLabel} #1`, quantity: 1, unit_price: -10, amount: -10 });
    lines.push({ _kind: 'discount', description: `${longLabel} #2`, quantity: 1, unit_price: -10, amount: -10 });

    const calls = await captureCalls(() => buildInvoicePDFBuffer(invoice({
      subtotal: 240,
      discount_amount: 20,
      total: 220,
      line_items: lines,
    })));
    const firstDiscount = calls.find((c) => c.text === `${longLabel} #1`);
    const totalRow = calls.find((c) => c.text === 'TOTAL');
    expect(firstDiscount).toBeDefined();
    expect(totalRow).toBeDefined();
    expect(firstDiscount.page).toBe(totalRow.page);
    expect(totalRow.y).toBeLessThanOrEqual(730);
  });
});
