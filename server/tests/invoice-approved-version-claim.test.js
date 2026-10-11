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
// The closeout target pin is an audit row written inside the claim (its own tests cover the writer).
jest.mock('../services/invoice-issued-closeout', () => ({ recordApprovedCloseoutTarget: jest.fn(async () => undefined) }));

const db = require('../models/db');
const { approvedInvoiceVersionDigest } = require('../services/invoice-helpers');
const InvoiceService = require('../services/invoice');
const { claimInvoiceForSend } = InvoiceService;
const { recordApprovedCloseoutTarget } = require('../services/invoice-issued-closeout');

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

  test('who owes the invoice is asked again on the claimed row: a customer passes, a payer or an unreadable answer hands the claim back with its own text', async () => {
    const row = baseRow();
    const seen = [];
    const withOwner = (verifyOwner) => ({ ...approved(row), verifyOwner });
    makeDb(row);
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: withOwner(async (claimed) => { seen.push(claimed.status); return null; }) }))
      .resolves.toMatchObject({ claimed: true });
    expect(seen).toEqual(['sent']);
    const payer = makeDb(row);
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: withOwner(async () => 'This invoice is billed to a payer, not the customer.') }))
      .rejects.toMatchObject({ code: 'approved_version_changed', message: 'This invoice is billed to a payer, not the customer.' });
    expect(payer.currentRow().status).toBe('sent');
    expect(payer.currentRow().send_claim_token).toBeNull();
    // A check that throws fails closed: the claim is handed back with the "could not verify" text.
    const broken = makeDb(row);
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: withOwner(async () => { throw new Error('read failed'); }) }))
      .rejects.toMatchObject({ code: 'approved_version_changed', message: expect.stringMatching(/could not verify who owes this invoice/) });
    expect(broken.currentRow().status).toBe('sent');
  });

  test('the approved closeout target is written inside the claim; a pin that cannot be written hands the claim back; no target writes nothing', async () => {
    const row = baseRow();
    makeDb(row);
    // The pin carries the claim's own token (it binds the pin to this send) and names the confirming admin.
    const claimed = await claimInvoiceForSend(INVOICE_ID, { expectedVersion: { ...approved(row), closeoutTarget: 'none', actorTechnicianId: 'admin-1' } });
    expect(recordApprovedCloseoutTarget).toHaveBeenLastCalledWith(INVOICE_ID, 'none', expect.objectContaining({ claimToken: claimed.invoice.send_claim_token, actorTechnicianId: 'admin-1' }));
    recordApprovedCloseoutTarget.mockClear();
    makeDb(row);
    await claimInvoiceForSend(INVOICE_ID, { expectedVersion: approved(row) });
    expect(recordApprovedCloseoutTarget).not.toHaveBeenCalled();
    recordApprovedCloseoutTarget.mockRejectedValueOnce(new Error('audit insert failed'));
    const failed = makeDb(row);
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: { ...approved(row), closeoutTarget: 'visit-9' } }))
      .rejects.toMatchObject({ code: 'approved_version_changed' });
    expect(failed.currentRow().status).toBe('sent');
    expect(failed.currentRow().send_claim_token).toBeNull();
  });

  test('round 8: the bar\'s claim holds the customer row FOR SHARE before it judges the owner, inside one transaction; the lock is gone before any provider call', async () => {
    const row = baseRow({ customer_id: 'cust-1' });
    const log = [];
    makeDb(row);
    const invoicesImpl = db.getMockImplementation();
    const customers = { where: jest.fn(() => customers), forShare: jest.fn(() => { log.push('customer FOR SHARE'); return customers; }), first: jest.fn(async () => ({ id: 'cust-1' })) };
    db.mockImplementation((table) => (table === 'customers' ? customers : invoicesImpl(table)));
    db.transaction.mockClear();
    const verifyOwner = jest.fn(async () => { log.push('verifyOwner'); return null; });
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: { ...approved(row), verifyOwner } })).resolves.toMatchObject({ claimed: true });
    expect(db.transaction).toHaveBeenCalledTimes(1);
    expect(log).toEqual(['customer FOR SHARE', 'verifyOwner']);
    // A caller with no owner check takes no transaction and no lock.
    makeDb(row);
    db.transaction.mockClear();
    await claimInvoiceForSend(INVOICE_ID, { expectedVersion: approved(row) });
    expect(db.transaction).not.toHaveBeenCalled();
  });

  test('round 8: an attachment upload that reserved the invoice and has not inserted yet refuses the bar\'s send claim; a card with no attachment list is unaffected', async () => {
    const helpers = require('../services/invoice-helpers');
    const row = baseRow();
    const inFlight = jest.spyOn(helpers, 'attachmentUploadInFlight');
    inFlight.mockResolvedValueOnce(true);
    const blocked = makeDb(row);
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: { ...approved(row), attachments: 'digest' } }))
      .rejects.toMatchObject({ code: 'approved_version_changed', message: expect.stringMatching(/attachment upload is still in progress/) });
    expect(blocked.currentRow().status).toBe('sent');
    expect(blocked.currentRow().send_claim_token).toBeNull();
    // A read that fails is treated as an upload in flight (fail closed).
    inFlight.mockRejectedValueOnce(new Error('audit read failed'));
    makeDb(row);
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: { ...approved(row), attachments: 'digest' } })).rejects.toMatchObject({ code: 'approved_version_changed' });
    // No reservation: the claim stands.
    inFlight.mockResolvedValueOnce(false);
    makeDb(row);
    await expect(claimInvoiceForSend(INVOICE_ID, { expectedVersion: { ...approved(row), attachments: 'digest' } })).resolves.toMatchObject({ claimed: true });
    inFlight.mockClear();
    makeDb(row);
    await claimInvoiceForSend(INVOICE_ID, { expectedVersion: approved(row) });
    expect(inFlight).not.toHaveBeenCalled();
    inFlight.mockRestore();
  });

  test('round 8: the lead conversion after delivery keeps to the leads the card named: none converts nothing, a pinned set converts only that set, a drifted set is skipped and audited', async () => {
    const LeadLink = require('../services/lead-estimate-link');
    const audit = require('../services/audit-log');
    const convert = jest.spyOn(LeadLink, 'convertLeadFromEvent');
    const record = jest.spyOn(audit, 'recordAuditEvent').mockResolvedValue(true);
    const send = (approvedLeadSet) => InvoiceService._convertLeadOnInvoiceSent({ invoiceId: INVOICE_ID, customerId: 'cust-1', priorStatus: 'draft', approvedLeadSet });
    // "none": the call is not made at all, even if a lead exists now.
    await send('none');
    expect(convert).not.toHaveBeenCalled();
    // A pinned set is handed to the conversion, which converts that set only.
    convert.mockResolvedValueOnce({ converted: true, count: 1 });
    await send('set-digest');
    expect(convert).toHaveBeenLastCalledWith({ source: 'invoice_sent', customerId: 'cust-1', expectedLeadSet: 'set-digest' });
    expect(record).not.toHaveBeenCalled();
    // Drift: skipped and audited on the invoice.
    convert.mockResolvedValueOnce({ converted: false, reason: 'approved_leads_changed' });
    await send('set-digest');
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      action: 'invoice.send_lead_conversion_skipped', resource_type: 'invoices', resource_id: INVOICE_ID,
      metadata: expect.objectContaining({ approvedLeadSet: 'set-digest', reason: 'approved_leads_changed' }),
    }));
    // No pin (the Invoices page): unchanged, resolved by customer as before.
    convert.mockResolvedValueOnce({ converted: false, reason: 'no_open_lead' });
    await send(null);
    expect(convert).toHaveBeenLastCalledWith({ source: 'invoice_sent', customerId: 'cust-1' });
    convert.mockRestore();
    record.mockRestore();
  });

  describe('round 8: the text leg\'s provider-boundary check asks the live owner verifier on the locked handle', () => {
    const helpers = require('../services/invoice-helpers');
    const hold = require('../services/collections/collection-hold');
    const current = { id: INVOICE_ID, customer_id: 'cust-1', status: 'sending', send_claim_token: 'tok', payer_id: null, total: '129.00', credit_applied: '0.00', line_items: JSON.stringify(LINES) };
    const handle = jest.fn();
    beforeEach(() => {
      jest.spyOn(helpers, 'visitRefusesSettlement').mockResolvedValue(null);
      jest.spyOn(helpers, 'selfPayAtDispatch').mockReturnValue(async () => ({ ok: true }));
      jest.spyOn(hold, 'messagingHeldByCollectionHold').mockResolvedValue({ held: false });
    });
    afterEach(() => jest.restoreAllMocks());
    const check = (verifyOwner) => InvoiceService._checkInvoiceDeliveryPreconditions(handle, current, { sendClaimToken: 'tok', sendInvoice: current, verifyOwner });

    test('a payer who now owns the invoice stops the text before the provider call; a verifier that throws fails closed; a customer passes', async () => {
      const verifyOwner = jest.fn(async () => 'This invoice is billed to a payer, not the customer.');
      await expect(check(verifyOwner)).resolves.toMatchObject({ sent: false, blocked: true, deliveryOutcome: 'not_sent', code: 'approved_version_changed', reason: 'This invoice is billed to a payer, not the customer.' });
      expect(verifyOwner).toHaveBeenCalledWith(expect.objectContaining({ id: INVOICE_ID }), handle);
      await expect(check(async () => { throw new Error('resolver down'); })).resolves.toMatchObject({ blocked: true, code: 'approved_version_changed' });
      await expect(check(async () => null)).resolves.toEqual({ ok: true });
      // No verifier (every other sender): unchanged.
      await expect(check(null)).resolves.toEqual({ ok: true });
    });

    test('source contract: both legs of the bar\'s send hand the verifier to their provider boundary', () => {
      const source = require('fs').readFileSync(require('path').join(__dirname, '../services/invoice.js'), 'utf8');
      // The text leg: the shared precondition check is given it on both of its routes (the locked handoff and the email authority's pre-send check).
      expect(source.match(/sendClaimToken: invoice\.send_claim_token, sendInvoice, holdExempt, verifyOwner,/g)).toHaveLength(2);
      // The wrapper passes the version's verifier to the text leg and to the email leg.
      expect(source.match(/\.\.\.\(expectedVersion\?\.verifyOwner \? \{ verifyOwner: expectedVersion\.verifyOwner \} : \{\}\),/g)).toHaveLength(2);
    });
  });

  test('round 8 (source contract): the confirming admin rides the version into the claim\'s pin, and the delivery row is written before the send\'s own closeout', () => {
    const source = require('fs').readFileSync(require('path').join(__dirname, '../services/invoice.js'), 'utf8');
    expect(source).toMatch(/if \(expectedVersion && actorTechnicianId && expectedVersion\.actorTechnicianId === undefined\) \{\s*expectedVersion = \{ \.\.\.expectedVersion, actorTechnicianId \};/);
    expect(source).toMatch(/claimToken: freshClaimToken, actorTechnicianId: expectedVersion\.actorTechnicianId \|\| null/);
    const delivery = source.indexOf('recordApprovedCloseoutDelivery(invoiceId, claim.invoice.send_claim_token');
    const closeout = source.indexOf('issuedCloseout = await closeOutVisitForIssuedInvoice({ invoiceId, trigger: "sent"');
    expect(delivery).toBeGreaterThan(0);
    expect(closeout).toBeGreaterThan(delivery);
  });

  test('a caller that passes no version is unchanged', async () => {
    const row = baseRow();
    makeDb({ ...row, updated_at: new Date('2099-02-02T00:00:00Z'), credit_applied: '25.00' });
    await expect(claimInvoiceForSend(INVOICE_ID, {})).resolves.toMatchObject({ claimed: true });
  });
});
