/**
 * services/zelle-notice.js — the helpers that remain after the Capital One
 * email-notice route was removed (2026-11-26): the invoice-number memo reader
 * and the Authentication-Results clause splitter inbox hygiene shares. The
 * bank-feed line parser is covered in zelle-bank-reconciler.test.js.
 */
const { memoInvoiceNumbers, authResultClauses } = require('../services/zelle-notice');

describe('memoInvoiceNumbers', () => {
  test('finds WPC invoice numbers case-insensitively, de-duplicated and upper-cased', () => {
    expect(memoInvoiceNumbers('Invoice WPC-2026-0412 & wpc-2026-0413, again WPC-2026-0412')).toEqual(['WPC-2026-0412', 'WPC-2026-0413']);
    expect(memoInvoiceNumbers('Quarterly Service Pat D')).toEqual([]);
    expect(memoInvoiceNumbers(null)).toEqual([]);
  });
});

describe('authResultClauses', () => {
  test('splits top-level clauses and drops comments and quoted strings', () => {
    const header = 'mx.google.com; dkim=pass header.i=@example.com header.s=s1; spf=pass (google.com: domain of a@b) smtp.mailfrom="a;b@c.com"';
    expect(authResultClauses(header)).toEqual([
      'mx.google.com',
      'dkim=pass header.i=@example.com header.s=s1',
      'spf=pass smtp.mailfrom=',
    ]);
  });

  test('a comment carrying a quote or backslash fails closed with no clauses', () => {
    expect(authResultClauses('mx.google.com; spf=pass (x"; dkim=pass header.i=@evil.example)')).toEqual([]);
    expect(authResultClauses('mx.google.com; spf=pass (x\\); dkim=pass header.i=@evil.example)')).toEqual([]);
  });

  test('an unterminated comment fails closed', () => {
    expect(authResultClauses('mx.google.com; spf=pass (unterminated; dkim=pass header.i=@example.com')).toEqual([]);
  });

  test('empty input yields no clauses', () => {
    expect(authResultClauses(null)).toEqual([]);
  });
});
