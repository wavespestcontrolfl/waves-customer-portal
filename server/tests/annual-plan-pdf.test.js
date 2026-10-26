const PDFDocument = require('pdfkit');
const { renderAnnualPlanPdf, _private } = require('../services/pdf/annual-plan-pdf');

test('a missing saved amount is not rendered as a zero-dollar plan', () => {
  expect(_private.currency(null)).toBe('Not available');
  expect(_private.currency('')).toBe('Not available');
});

test('renders the Field-standard informational PDF without inventing renewal facts or exposing a provisional date', async () => {
  const seen = [];
  const original = PDFDocument.prototype.text;
  const spy = jest.spyOn(PDFDocument.prototype, 'text').mockImplementation(function text(value, ...args) {
    seen.push(String(value));
    return original.call(this, value, ...args);
  });
  try {
    const buffer = await renderAnnualPlanPdf({
      title: 'Annual plan renewal',
      facts: {
        propertyLabel: '300 Fixture Court, Sarasota, FL 34236',
        currentPlanAmount: 525,
        currentTermEnds: null,
        awaitsInstallation: true,
        declined: true,
        unpaid: true,
      },
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1500);
  } finally {
    spy.mockRestore();
  }

  const copy = seen.join('\n');
  expect(copy).toContain('Annual plan renewal');
  expect(copy).toContain('Renewal details');
  expect(copy).toContain('CURRENT PLAN AMOUNT');
  expect(copy).toContain('CURRENT TERM ENDS');
  expect(copy).toContain('$525.00');
  expect(copy).toContain('Not yet set — awaiting installation');
  expect(copy).toContain('Declined — nonrenewal is on file');
  expect(copy).toContain('Payment pending — not shown as paid');
  expect(copy).not.toMatch(/proposed renewal|cancellation deadline|coverage continues|coverage guarantee/i);
  expect(copy).not.toContain('2027-10-25');
});
