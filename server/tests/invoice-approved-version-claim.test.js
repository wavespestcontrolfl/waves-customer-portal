// claimInvoiceForSend with an approved version (Intelligence Bar send_invoice,
// PR #6117 round-1 P1): an edit or partial credit after the confirm card was
// shown cannot be claimed, even when the gross total is unchanged.
//   - the edit time is a predicate of the claim's own locked UPDATE;
//   - the amount due / lines digest is checked on the row that UPDATE returned,
//     and a mismatch hands the claim back (the invoice returns to its status);
//   - a live claim by another request stays the in-progress error, never "changed";
//   - callers that pass no version are unchanged.

jest.mock('../models/db', () => {
  const fn = jest.fn();
  fn.raw = jest.fn((sql) => sql);
  fn.fn = { now: jest.fn(() => 'now()') };
  fn.transaction = jest.fn(async (callback) => callback(fn));
  return fn;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/estimate-deposits', () => ({
  assertInvoiceDepositSettlementReady: jest.fn(async () => undefined),
}));
jest.mock('../services/review-request', () => ({ enrollForPaidInvoice: jest.fn() }));

const db = require('../models/db');
const { approvedInvoiceVersionDigest } = require('../services/invoice-helpers');
const InvoiceService = require('../services/invoice');
const { claimInvoiceForSend } = InvoiceService;

const INVOICE_ID = 'aaaaaaaa-2222-4222-8222-222222222222';
const EDITED_AT = new Date('2099-01-01T12:00:00.123Z');
const LINES = [{ description: 'Quarterly Pest Control', amount: 99 }, { description: 'Mosquito add-on', amount: 30 }];

function baseRow(overrides = {}) {
  return {
    id: INVOICE_ID, status: 'sent', total: '129.00', credit_applied: '0.00', line_items: JSON.stringify(LINES),
    sent_at: new Date('2099-01-01T00:00:00Z'), send_claim_token: null, scheduled_send_at: null, scheduled_send_error: null,
    updated_at: EDITED_AT, ...overrides,
  };
}

// One shared mutable invoices row. Each db('invoices') call is a fresh builder; the
// claim's UPDATE evaluates its where-family predicates (object, null, and the
// (column, op, value) form the version predicate uses) against the CURRENT row.
function makeDb(initial, { mutateAfterFirstRead = null } = {}) {
  let row = { ...initial };
  let reads = 0;
  const updates = [];
  function invoices() {
    const predicates = [];
    const q = {};
    q.where = jest.fn((a, op, value) => {
      if (a && typeof a === 'object') predicates.push((r) => Object.entries(a).every(([k, v]) => r[k] === v));
      else if (op === '>=') predicates.push((r) => r[a] != null && new Date(r[a]).getTime() >= value.getTime());
      else if (op === '<') predicates.push((r) => r[a] != null && new Date(r[a]).getTime() < value.getTime());
      return q;
    });
    q.whereNull = jest.fn((col) => { predicates.push((r) => r[col] == null); return q; });
    q.whereNotNull = jest.fn((col) => { predicates.push((r) => r[col] != null); return q; });
    q.whereRaw = jest.fn(() => q); // the review-hold predicate: not under test here
    q.forUpdate = jest.fn(() => q);
    q.first = jest.fn(async () => {
      reads += 1;
      const snapshot = { ...row };
      if (reads === 1 && mutateAfterFirstRead) row = { ...row, ...mutateAfterFirstRead };
      return snapshot;
    });
    q.update = jest.fn((payload) => {
      updates.push(payload);
      q.matched = predicates.every((p) => p(row));
      if (q.matched) row = { ...row, ...payload };
      return q;
    });
    q.returning = jest.fn(async () => (q.matched ? [{ ...row }] : []));
    return q;
  }
  const sms = { whereRaw: jest.fn(() => sms), first: jest.fn(async () => null) };
  db.mockImplementation((table) => (table === 'invoices' ? invoices() : sms));
  return { updates, currentRow: () => row };
}

const approved = (row) => ({ updatedAtMs: new Date(row.updated_at).getTime(), digest: approvedInvoiceVersionDigest(row) });

describe('approvedInvoiceVersionDigest', () => {
  test('moves with the amount due, the credit, the lines and the customer-facing words (email message, notes), not with unrelated columns', () => {
    const row = baseRow();
    const digest = approvedInvoiceVersionDigest(row);
    expect(approvedInvoiceVersionDigest({ ...row, service_type: 'Other', updated_at: new Date() })).toBe(digest);
    expect(approvedInvoiceVersionDigest({ ...row, notes: 'x' })).not.toBe(digest);
    expect(approvedInvoiceVersionDigest({ ...row, email_message: 'x' })).not.toBe(digest);
    expect(approvedInvoiceVersionDigest({ ...row, credit_applied: '10.00' })).not.toBe(digest);
    expect(approvedInvoiceVersionDigest({ ...row, line_items: JSON.stringify([{ description: 'Quarterly Pest Control', amount: 129 }]) })).not.toBe(digest);
    // The same lines as an already parsed array (jsonb) read the same.
    expect(approvedInvoiceVersionDigest({ ...row, line_items: LINES })).toBe(digest);
  });
});

describe('claimInvoiceForSend with an approved version', () => {
  beforeEach(() => jest.clearAllMocks());

  test('the unchanged row claims', async () => {
    const row = baseRow();
    makeDb(row);
    const result = await claimInvoiceForSend(INVOICE_ID, { expectedVersion: approved(row) });
    expect(result).toMatchObject({ claimed: true, previousStatus: 'sent' });
    expect(result.invoice.status).toBe('sending');
  });

  test('an edit that lands between the read and the claim flip (edit time moved) is not claimed, nothing flips', async () => {
    const row = baseRow();
    const { updates, currentRow } = makeDb(row, { mutateAfterFirstRead: { updated_at: new Date('2099-01-01T12:00:05Z') } });
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: approved(row) }))
      .rejects.toMatchObject({ code: 'approved_version_changed' });
    expect(currentRow().status).toBe('sent');
    expect(updates.some((u) => u.status === 'sending')).toBe(true); // attempted, but matched no row
    expect(currentRow().send_claim_token).toBeNull();
  });

  test('same total and same edit time but a partial credit moved the amount due: the claim is handed back', async () => {
    const row = baseRow();
    const expectedVersion = approved(row);
    // A credit applied without stamping updated_at: gross total equal, amount due lower.
    const { currentRow } = makeDb({ ...row, credit_applied: '25.00' });
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion }))
      .rejects.toMatchObject({ code: 'approved_version_changed' });
    // The claim was released: the invoice is back at its prior status with no claim token.
    expect(currentRow().status).toBe('sent');
    expect(currentRow().send_claim_token).toBeNull();
  });

  test('different line items with the same total and edit time are refused too', async () => {
    const row = baseRow();
    const expectedVersion = approved(row);
    makeDb({ ...row, line_items: JSON.stringify([{ description: 'Quarterly Pest Control', amount: 129 }]) });
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion })).rejects.toMatchObject({ code: 'approved_version_changed' });
  });

  test('another request holding the live claim stays the in-progress error, not a changed invoice', async () => {
    const row = baseRow();
    makeDb(row, { mutateAfterFirstRead: { status: 'sending', send_claim_token: 'other-claim', updated_at: new Date('2099-01-01T12:00:09Z') } });
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: approved(row) }))
      .rejects.toThrow('Invoice send already in progress');
  });

  test('the Intelligence Bar\'s effects check runs on the claimed row with its pre-claim status; a different list, or one that cannot be read, hands the claim back', async () => {
    const row = baseRow();
    const seen = [];
    const withEffects = (verifyEffects) => ({ ...approved(row), verifyEffects });
    // Same list: the claim stands, and the check saw the pre-claim status ('sent'), not 'sending'.
    makeDb(row);
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: withEffects(async (claimed) => { seen.push(claimed.status); return true; }) }))
      .resolves.toMatchObject({ claimed: true });
    expect(seen).toEqual(['sent']);
    // A different list: nothing is sent; the invoice returns to its status with no claim token.
    const changed = makeDb(row);
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: withEffects(async () => false) })).rejects.toMatchObject({ code: 'approved_version_changed' });
    expect(changed.currentRow().status).toBe('sent');
    expect(changed.currentRow().send_claim_token).toBeNull();
    // A check that throws fails closed the same way.
    const broken = makeDb(row);
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: withEffects(async () => { throw new Error('read failed'); }) })).rejects.toMatchObject({ code: 'approved_version_changed' });
    expect(broken.currentRow().status).toBe('sent');
  });

  test('a caller that passes no version is unchanged', async () => {
    const row = baseRow();
    makeDb({ ...row, updated_at: new Date('2099-02-02T00:00:00Z'), credit_applied: '25.00' });
    await expect(claimInvoiceForSend(INVOICE_ID, {})).resolves.toMatchObject({ claimed: true });
  });
});
