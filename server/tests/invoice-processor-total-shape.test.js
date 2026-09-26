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
