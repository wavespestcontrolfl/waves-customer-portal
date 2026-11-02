/**
 * Receipt PDF: the credit card surcharge is its own row (Visa Core Rules, Oct 2026: a surcharge "must be shown separately on
 * the front of the receipt in the same type and size of font as other wording"). The stored invoice total already includes the
 * surcharge after a single-invoice card payment, so the old receipt read "Subtotal $16.00 ... TOTAL $16.46" with no line for
 * the $0.46. The row comes from the payment row's own surcharge: a combined payment stamps it on the anchor invoice only.
 */

const PDFDocument = require('pdfkit');
const {
  buildInvoicePDFBuffer,
  buildReceiptPDFBuffer,
} = require('../services/pdf/invoice-pdf');

function invoice(overrides = {}) {
  return {
    invoice_number: 'WPC-TEST-SURCH',
    status: 'paid',
    subtotal: 16,
    discount_amount: 0,
    tax_amount: 0,
    total: 16.46,
    amount_paid: 0,
    credit_applied: 0,
    created_at: new Date('2026-11-01T12:00:00Z'),
    paid_at: new Date('2026-11-01T13:00:00Z'),
    due_date: '2026-11-15',
    line_items: [{ description: 'Quarterly Pest Control Service', quantity: 1, unit_price: 16, amount: 16 }],
    customer: {
      first_name: 'Pat', last_name: 'Doe', address_line1: '1 Test St', city: 'Bradenton', state: 'FL', zip: '34209',
      property_type: 'residential',
    },
    ...overrides,
  };
}

function payment(overrides = {}) {
  return {
    amount: 16.46,
    refund_amount: 0,
    card_brand: 'visa',
    card_last_four: '4242',
    base_amount_cents: 1600,
    surcharge_amount_cents: 46,
    surcharge_rate_bps: 290,
    metadata: { invoice_id: 'inv-1' },
    ...overrides,
  };
}

// Every text() call, with the font size and font name in force when it was drawn.
async function renderedRows(build) {
  const calls = [];
  let pageCount = 0;
  const realAddPage = PDFDocument.prototype.addPage;
  const pages = jest.spyOn(PDFDocument.prototype, 'addPage').mockImplementation(function recordPage(...args) {
    pageCount += 1;
    return realAddPage.apply(this, args);
  });
  const written = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function recordText(...args) {
    calls.push({ text: String(args[0]), size: this._fontSize, font: this._font && this._font.name, page: pageCount });
    return this;
  });
  try {
    const buffer = await build();
    expect(buffer.subarray(0, 4).toString()).toBe('%PDF');
    return calls;
  } finally {
    written.mockRestore();
    pages.mockRestore();
  }
}

const texts = (rows) => rows.map((r) => r.text);
const valueAfter = (rows, label) => {
  const at = texts(rows).lastIndexOf(label);
  return at === -1 ? undefined : rows[at + 1].text;
};
const SURCHARGE_LABEL = /^Credit card surcharge/;

describe('receipt PDF surcharge row', () => {
  test('a surcharged card payment prints the row, so Subtotal + surcharge reconciles to TOTAL', async () => {
    const rows = await renderedRows(() => buildReceiptPDFBuffer(invoice(), payment()));
    expect(texts(rows)).toContain('Credit card surcharge (2.9%)');
    expect(valueAfter(rows, 'Credit card surcharge (2.9%)')).toBe('$0.46');
    expect(valueAfter(rows, 'Subtotal')).toBe('$16.00');
    expect(valueAfter(rows, 'TOTAL')).toBe('$16.46');
    expect(16.00 + 0.46).toBeCloseTo(16.46, 2);
    // Between the pre-total rows and TOTAL.
    const order = texts(rows);
    expect(order.indexOf('Subtotal')).toBeLessThan(order.indexOf('Credit card surcharge (2.9%)'));
    expect(order.indexOf('Credit card surcharge (2.9%)')).toBeLessThan(order.lastIndexOf('TOTAL'));
  });

  test('the row uses the same font and size as the Subtotal row', async () => {
    const rows = await renderedRows(() => buildReceiptPDFBuffer(invoice(), payment()));
    const sub = rows.find((r) => r.text === 'Subtotal');
    const sur = rows.find((r) => SURCHARGE_LABEL.test(r.text));
    expect(sub.size).toBeGreaterThan(0);
    expect(sur.size).toBe(sub.size);
    expect(sur.font).toBe(sub.font);
    const surValue = rows[rows.indexOf(sur) + 1];
    expect(surValue.size).toBe(sub.size);
  });

  test('the rate label drops the percent when the rate is missing or 0', async () => {
    const rows = await renderedRows(() => buildReceiptPDFBuffer(invoice(), payment({ surcharge_rate_bps: 0 })));
    expect(texts(rows)).toContain('Credit card surcharge');
    const rows2 = await renderedRows(() => buildReceiptPDFBuffer(invoice(), payment({ surcharge_rate_bps: null })));
    expect(texts(rows2)).toContain('Credit card surcharge');
    const rows3 = await renderedRows(() => buildReceiptPDFBuffer(invoice(), payment({ surcharge_rate_bps: 325 })));
    expect(texts(rows3)).toContain('Credit card surcharge (3.25%)');
  });

  test('no surcharge on the payment: no row (zero, null, missing column, or no payment row)', async () => {
    const inv = invoice({ total: 16 });
    for (const p of [payment({ surcharge_amount_cents: 0, amount: 16 }), payment({ surcharge_amount_cents: null }), null, undefined]) {
      const rows = await renderedRows(() => buildReceiptPDFBuffer(inv, p));
      expect(texts(rows).some((t) => SURCHARGE_LABEL.test(t))).toBe(false);
      expect(valueAfter(rows, 'TOTAL')).toBe('$16.00');
    }
  });

  test('combined payment: the anchor prints its surcharge and TOTAL adds it to the stored base total', async () => {
    // pay-combined leaves invoice.total at the base; the surcharge lives only on the anchor payment row.
    const anchorPay = payment({ amount: 16.46, metadata: JSON.stringify({ invoice_id: 'a', combined_payment: true }) });
    const rows = await renderedRows(() => buildReceiptPDFBuffer(invoice({ total: 16 }), anchorPay));
    expect(valueAfter(rows, 'Credit card surcharge (2.9%)')).toBe('$0.46');
    expect(valueAfter(rows, 'TOTAL')).toBe('$16.46');
  });

  test('combined payment: a sibling with a 0 surcharge prints no row and keeps its own total', async () => {
    const siblingPay = payment({
      amount: 20, surcharge_amount_cents: 0, surcharge_rate_bps: 0, metadata: { invoice_id: 'b', combined_payment: true },
    });
    const rows = await renderedRows(() => buildReceiptPDFBuffer(invoice({ subtotal: 20, total: 20 }), siblingPay));
    expect(texts(rows).some((t) => SURCHARGE_LABEL.test(t))).toBe(false);
    expect(valueAfter(rows, 'TOTAL')).toBe('$20.00');
  });

  test('a surcharged receipt with a partial refund still shows the row and the refund rows', async () => {
    const rows = await renderedRows(() => buildReceiptPDFBuffer(invoice(), payment({ refund_amount: 5 })));
    expect(valueAfter(rows, 'Credit card surcharge (2.9%)')).toBe('$0.46');
    expect(valueAfter(rows, 'Net paid')).toBe('$11.46');
  });

  test('a long multi-property receipt keeps TOTAL on the same page as its surcharge row', async () => {
    const lines = [];
    for (let p = 0; p < 2; p += 1) {
      const property_address = { address_line1: `${p + 1} Test St`, city: 'Bradenton', state: 'FL', zip: '34209' };
      for (let i = 0; i < 14; i += 1) {
        lines.push({
          description: `Service ${p}-${i}`, quantity: 1, unit_price: 10, amount: 10, property_id: `prop-${p}`, property_address,
        });
      }
    }
    const rows = await renderedRows(() => buildReceiptPDFBuffer(
      invoice({ line_items: lines, subtotal: 280, total: 288.12 }),
      payment({ amount: 288.12, surcharge_amount_cents: 812 }),
    ));
    expect(valueAfter(rows, 'Credit card surcharge (2.9%)')).toBe('$8.12');
    expect(valueAfter(rows, 'TOTAL')).toBe('$288.12');
    const sur = rows.find((r) => SURCHARGE_LABEL.test(r.text));
    const total = rows.find((r) => r.text === 'TOTAL');
    expect(sur.page).toBe(total.page);
    expect(rows.some((r) => /Test St subtotal/.test(r.text))).toBe(true);
    expect(total.page).toBeGreaterThan(1);
  });
});

describe('invoice PDF is unchanged', () => {
  test('an invoice never prints a surcharge row, whatever extra fields it carries', async () => {
    const inv = invoice({ status: 'sent', total: 16, surcharge_amount_cents: 46, surcharge_rate_bps: 290 });
    const rows = await renderedRows(() => buildInvoicePDFBuffer(inv));
    expect(texts(rows).some((t) => SURCHARGE_LABEL.test(t))).toBe(false);
    expect(valueAfter(rows, 'TOTAL')).toBe('$16.00');
  });
});
