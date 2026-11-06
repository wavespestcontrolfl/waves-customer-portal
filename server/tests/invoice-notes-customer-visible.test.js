/**
 * Walk 2026-11-05: the pay page showed "Auto-generated from accepted estimate
 * #<uuid>. Customer selected pay per application — …" under NOTES. The text is
 * a machine marker other code matches, so the write stays; the customer reads
 * leave it out through one matcher (services/invoice-notes.js).
 */
const fs = require('fs');
const path = require('path');
const { ACCEPT_MINT_NOTE_RE, isAcceptMintNote, customerVisibleInvoiceNotes } = require('../services/invoice-notes');

const UUID = '11111111-2222-3333-4444-555555555555';

describe('customerVisibleInvoiceNotes', () => {
  test.each([
    `Auto-generated from accepted estimate #${UUID}. Customer selected pay per application — first application only.`,
    `Auto-generated from accepted estimate #${UUID} (invoice-mode one-time).`,
    `Auto-generated from accepted estimate #${UUID} (invoice-mode recurring). Monthly equivalent: $45.00/mo.`,
    `Auto-generated from accepted estimate #${UUID}. Customer selected "Pay the year upfront" for the lawn plan.`,
    `  Auto-generated from accepted estimate #${UUID}. Customer selected pay per application — $99.00 setup fee only.`,
  ])('hides the machine marker note: %s', (note) => {
    expect(isAcceptMintNote(note)).toBe(true);
    expect(customerVisibleInvoiceNotes(note)).toBeNull();
  });

  test.each([
    'We treated the exterior perimeter and checked the garage.',
    'Please use the side gate.',
    '',
    null,
    undefined,
  ])('keeps every other note exactly as it was: %p', (note) => {
    expect(isAcceptMintNote(note)).toBe(false);
    expect(customerVisibleInvoiceNotes(note)).toBe(note);
  });

  test('a note that only mentions the marker mid-text is a staff note and stays', () => {
    const note = 'Re: Auto-generated from accepted estimate #abc, call the office.';
    expect(customerVisibleInvoiceNotes(note)).toBe(note);
  });

  test('the completion-charge verdict reads the same marker from this home', () => {
    expect(ACCEPT_MINT_NOTE_RE.test(`x Auto-generated from accepted estimate #${UUID}`)).toBe(true);
    const verdict = fs.readFileSync(path.join(__dirname, '../services/completion-charge-verdict.js'), 'utf8');
    expect(verdict).toMatch(/ACCEPT_MINT_NOTE_RE\.test\(/);
    expect(verdict).not.toMatch(/\/Auto-generated from accepted estimate #\//);
  });
});

describe('every customer read of invoices.notes goes through the matcher', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test.each([
    ['routes/pay-v2.js', /notes: customerVisibleInvoiceNotes\(data\.notes\)/],
    ['routes/receipt-v2.js', /notes: customerVisibleInvoiceNotes\(data\.notes\)/],
    ['services/pdf/invoice-pdf.js', /customerVisibleInvoiceNotes\(invoice\.notes\)/],
    ['services/invoice-email.js', /customerVisibleInvoiceNotes\(invoice\.notes\)/],
  ])('%s', (rel, pattern) => {
    expect(read(rel)).toMatch(pattern);
  });

  test('no customer file sends the raw notes column to the client', () => {
    expect(read('routes/pay-v2.js')).not.toMatch(/notes: data\.notes/);
    expect(read('routes/receipt-v2.js')).not.toMatch(/notes: data\.notes/);
    expect(read('services/pdf/invoice-pdf.js')).not.toMatch(/\.text\(invoice\.notes/);
  });
});
