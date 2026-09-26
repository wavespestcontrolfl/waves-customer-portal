// Codex r10 on #4884: a PDF-parse reply like {"total":"unknown",...} is a
// non-null, truthy string that slipped past the old `total == null` check,
// then won `amount = parsedInvoice?.total || parseFloat(...) || 0` — the
// string "unknown" is truthy, so `amount > 0` was just false and the
// expense was silently never created ("no_amount"), while the call was
// recorded a ledger success. `total`, when present, must be usable as a
// number — a plain finite number, or a strict numeric string (the only
// string shape `amount > 0` and the numeric `expenses.amount` column
// downstream actually coerce correctly).
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const { isUsableInvoiceTotal } = require('../services/email/invoice-processor');

describe('isUsableInvoiceTotal', () => {
  test('absent (null/undefined) total is usable — invoice_number alone can still justify the expense', () => {
    expect(isUsableInvoiceTotal(null)).toBe(true);
    expect(isUsableInvoiceTotal(undefined)).toBe(true);
  });

  test('a finite number is usable', () => {
    expect(isUsableInvoiceTotal(150)).toBe(true);
    expect(isUsableInvoiceTotal(0)).toBe(true);
    expect(isUsableInvoiceTotal(-12.5)).toBe(true);
  });

  test('a non-finite number is not usable', () => {
    expect(isUsableInvoiceTotal(NaN)).toBe(false);
    expect(isUsableInvoiceTotal(Infinity)).toBe(false);
  });

  test('a strict numeric string is usable (the shape amount > 0 and the numeric column both coerce correctly)', () => {
    expect(isUsableInvoiceTotal('150.00')).toBe(true);
    expect(isUsableInvoiceTotal('0')).toBe(true);
    expect(isUsableInvoiceTotal('-12.5')).toBe(true);
  });

  test('the exact regression: {"total":"unknown"} is not usable', () => {
    expect(isUsableInvoiceTotal('unknown')).toBe(false);
  });

  test('other non-numeric strings, and a non-string/number type, are not usable', () => {
    expect(isUsableInvoiceTotal('')).toBe(false);
    expect(isUsableInvoiceTotal('  ')).toBe(false);
    expect(isUsableInvoiceTotal('$150.00')).toBe(false);
    expect(isUsableInvoiceTotal({})).toBe(false);
    expect(isUsableInvoiceTotal([])).toBe(false);
    expect(isUsableInvoiceTotal(true)).toBe(false);
  });
});

// Everything downstream reads these values, never the raw reply: an invalid
// invoice_date used to become today's date, and an object invoice_number was
// written into the expense description as "#[object Object]".
describe('readParsedInvoice', () => {
  const { readParsedInvoice } = require('../services/email/invoice-processor');

  test('a clean extraction is used as-is and not degraded', () => {
    const { invoice, degraded } = readParsedInvoice({ invoice_number: 'INV-12', invoice_date: '2026-09-01', total: '1250.50', line_items: [{ description: 'Termidor' }], vendor_name: 'Acme' });
    expect(degraded).toBe(false);
    expect(invoice).toMatchObject({ invoice_number: 'INV-12', invoice_date: '2026-09-01', total: 1250.5, vendor_name: 'Acme' });
  });

  test.each([
    ['an impossible invoice_date', { invoice_number: 'A1', invoice_date: '2026-13-45', total: 10 }, 'invoice_date'],
    ['a numeric invoice_date', { invoice_number: 'A1', invoice_date: 20260101, total: 10 }, 'invoice_date'],
    ['an object invoice_number', { invoice_number: {}, total: 10 }, 'invoice_number'],
    ['a word total', { invoice_number: 'A1', total: 'unknown' }, 'total'],
  ])('%s is dropped to null (the classifier figure is used) and degrades the answer', (_label, raw, field) => {
    const { invoice, degraded } = readParsedInvoice(raw);
    expect(invoice[field]).toBeNull();
    expect(degraded).toBe(true);
  });

  test('non-object line items are dropped and degrade; a zero or negative total (credit memo) is a real value', () => {
    const a = readParsedInvoice({ invoice_number: 'A1', total: 5, line_items: [{ description: 'x' }, 'y', null] });
    expect(a.invoice.line_items).toEqual([{ description: 'x' }]);
    expect(a.degraded).toBe(true);
    const b = readParsedInvoice({ invoice_number: 'CM-1', total: -42.1 });
    expect(b.invoice.total).toBe(-42.1);
    expect(b.degraded).toBe(false);
  });

  test('neither a total nor an invoice number answers nothing', () => {
    expect(readParsedInvoice({ vendor_name: 'Acme' }).degraded).toBe(true);
    expect(readParsedInvoice([]).invoice).toBeNull();
  });
});

// Codex r19 on #4884: an OCR run-on invoice number long enough to push the
// expense description past varchar(300) failed the insert after acceptance.
describe('readParsedInvoice — invoice number length', () => {
  const { readParsedInvoice } = require('../services/email/invoice-processor');
  test('a run-on invoice number is dropped (classifier figure used) and degrades', () => {
    const { invoice, degraded } = readParsedInvoice({ invoice_number: 'X'.repeat(300), total: 10 });
    expect(invoice.invoice_number).toBeNull();
    expect(degraded).toBe(true);
  });
  test('a normal-length invoice number is kept', () => {
    expect(readParsedInvoice({ invoice_number: 'INV-2026-000123', total: 10 }).invoice.invoice_number).toBe('INV-2026-000123');
  });
});
