// Cancellation vs. a live send claim (GitHub r11 P1 #4131).
//
// The office picker links an invoice to an open visit and sends it; the send
// claims the row by flipping it to 'sending' before it hands anything to the
// provider. If the visit is cancelled inside that window, the two writers
// need a SHARED FENCE — the post-claim visit recheck in claimInvoiceForSend
// is a point-in-time read, so a cancellation landing after it used to be
// skipped by the void sweep (which excluded 'sending') and the sender then
// finalized 'sent', leaving the customer a collectible pay link for a visit
// that never ran.
//
// The fence is the INVOICE ROW: the sweep voids under SELECT … FOR UPDATE,
// and every writer that could undo the void is a status CAS that excludes
// 'void'. The source contracts below assert the CAS shapes (they run with no
// database); the PostgreSQL block drives the real rows through both orders.
const fs = require('fs');
const path = require('path');

describe('cancellation/send fence — source contracts', () => {
  const source = fs.readFileSync(path.join(__dirname, '../services/invoice.js'), 'utf8');

  test("the cancellation void sweep claims 'sending' rows — the fence, not a skip", () => {
    const list = source.slice(
      source.indexOf('const CANCELLED_SERVICE_VOIDABLE_STATUSES = ['),
      source.indexOf('const PI_MONEY_IN_FLIGHT_STATUSES'),
    );
    expect(list).toMatch(/^\s*"sending",$/m);
    // The transaction's re-check reads the SAME list under the row lock, so a
    // row that reached 'sending' only after the candidate scan is caught too.
    expect(source).toMatch(/\.forUpdate\(\)\s*\n\s*\.first\(\);[\s\S]{0,200}?if \(!CANCELLED_SERVICE_VOIDABLE_STATUSES\.includes\(locked\.status\)\)/);
  });

  test("no finalize, restore or stale-claim recovery can move a voided row: every one of them is a status CAS that excludes 'void'", () => {
    // SEND_FINALIZABLE_STATUSES is what all three delivery finalizes gate on:
    // the claimable set plus 'sending', and 'void' is in neither.
    const finalizable = source.slice(
      source.indexOf('const SEND_CLAIMABLE_STATUSES = ['),
      source.indexOf('// Statuses the generic admin edit'),
    );
    expect(finalizable).toMatch(/const SEND_FINALIZABLE_STATUSES = \[\.\.\.SEND_CLAIMABLE_STATUSES, "sending"\];/);
    expect(finalizable).not.toMatch(/void/);
    // sendViaSMS, sendViaSMSAndEmail and markDeliverySent — three finalizes,
    // each guarded by the same whereIn.
    expect(source.match(/\.whereIn\("status", SEND_FINALIZABLE_STATUSES\)\s*\n\s*\.update\(/g)).toHaveLength(3);
    expect(source.match(/CASE WHEN status IN \('draft', 'scheduled', 'sending'\) THEN 'sent' ELSE status END/g)).toHaveLength(3);
    // The claim give-back and the 10-minute stale-claim recovery both key on
    // 'sending', so a voided claim is never re-armed or restored.
    const restoreStart = source.indexOf('async function restoreSendClaim(');
    const restoreClaim = source.slice(restoreStart, source.indexOf('\n}', restoreStart) + 2);
    expect(restoreClaim).toMatch(/\.where\(\{ id: invoiceId, status: "sending" \}\)/);
    expect(source).toMatch(/await db\("invoices"\)\s*\n\s*\.where\(\{ status: "sending" \}\)\s*\n\s*\.where\("updated_at", "<", db\.raw\("NOW\(\) - INTERVAL '10 minutes'"\)\)/);
  });
});

// ── Real rows ────────────────────────────────────────────────────────────
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  return db;
});
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
// Nothing in this suite may reach a customer or Stripe.
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/stripe', () => ({
  retrievePaymentIntent: jest.fn(async () => null),
  cancelPaymentIntent: jest.fn(async () => ({})),
  chargeInvoiceWithSavedCard: jest.fn(),
}));
jest.mock('../services/review-request', () => ({ enrollPostService: jest.fn(async () => null) }));
// The invoice-issued closeout is a separate contract with its own suites and
// ships dark; keep it out of this one.
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const { randomUUID } = require('node:crypto');
const InvoiceService = require('../services/invoice');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');

jest.setTimeout(60000);

postgres('a cancellation and a live send claim contend on the invoice row (migrated PostgreSQL)', () => {
  let database;
  let trx;
  let customerId;
  const DAY = '2040-03-04';

  beforeAll(() => {
    const url = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(url.pathname);
    if (!privateQa && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Use a verified task-private QA database or disposable local/CI database');
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    require('../models/db').connection = database;
  });
  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    require('../models/db').connection = trx;
    customerId = randomUUID();
    await trx('customers').insert({
      id: customerId, first_name: 'Synthetic', last_name: 'Fence',
      email: `${customerId}@example.invalid`, phone: `fixture-${customerId.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Test City', zip: '00000', active: true, pipeline_stage: 'active_customer',
    });
  });
  afterEach(async () => { await trx.rollback(); require('../models/db').connection = database; });
  afterAll(async () => { await database.destroy(); });

  // A visit the office billed before the tech arrived, then cancelled, with
  // its invoice sitting under a live send claim.
  async function claimedInvoiceOnCancelledVisit({ status = 'sending', ...invoiceCols } = {}) {
    const visitId = randomUUID();
    const invoiceId = randomUUID();
    await trx('scheduled_services').insert({
      id: visitId, customer_id: customerId, scheduled_date: DAY,
      service_type: 'Quarterly Pest Control Service', status: 'cancelled',
    });
    await trx('invoices').insert({
      id: invoiceId, customer_id: customerId, scheduled_service_id: visitId,
      invoice_number: `TST-${invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''),
      status, total: 117, subtotal: 117, service_date: DAY, service_type: 'Quarterly Pest Control Service',
      line_items: JSON.stringify([{ description: 'Quarterly Pest Control Service', amount: 117, quantity: 1, unit_price: 117 }]),
      ...invoiceCols,
    });
    return { visitId, invoiceId };
  }
  const read = (id) => trx('invoices').where({ id }).first();
  // The sweep returns its voided ids as an array that also carries an
  // `inspectionCreditReversal` property (see voidOpenInvoicesForCancelledService);
  // compare the ids alone.
  const voidedIds = (result) => Array.from(result);

  test('the sweep voids a row held under a live send claim, and the sender can no longer finalize it to sent', async () => {
    const { visitId, invoiceId } = await claimedInvoiceOnCancelledVisit();

    expect(voidedIds(await InvoiceService.voidOpenInvoicesForCancelledService(visitId))).toEqual([invoiceId]);
    expect((await read(invoiceId)).status).toBe('void');

    // The sender's provider call already went out; its finalize now finds a
    // void row and writes nothing. The pay link it texted is dead — a void
    // invoice is not collectible — instead of a live bill for a dead visit.
    await InvoiceService.markDeliverySent(invoiceId, { sms: true, source: 'test_send' });
    const after = await read(invoiceId);
    expect(after.status).toBe('void');
    expect(after.sent_at).toBeNull();
    expect(after.sms_sent_at).toBeNull();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the other order is safe too: a finalize that wins the race leaves sent, which the sweep voids on the ordinary path', async () => {
    const { visitId, invoiceId } = await claimedInvoiceOnCancelledVisit();

    await InvoiceService.markDeliverySent(invoiceId, { sms: true, source: 'test_send' });
    expect((await read(invoiceId)).status).toBe('sent');

    expect(voidedIds(await InvoiceService.voidOpenInvoicesForCancelledService(visitId))).toEqual([invoiceId]);
    expect((await read(invoiceId)).status).toBe('void');
  });

  test('the money guards are unchanged under a claim: a payment already recorded is skipped, never voided mid-send', async () => {
    const { visitId, invoiceId } = await claimedInvoiceOnCancelledVisit({ payment_recorded_at: new Date() });

    expect(voidedIds(await InvoiceService.voidOpenInvoicesForCancelledService(visitId))).toEqual([]);
    expect((await read(invoiceId)).status).toBe('sending');
  });

  test('a cancelled visit whose invoice is NOT under a claim still voids exactly as before (draft and sent alike)', async () => {
    const draft = await claimedInvoiceOnCancelledVisit({ status: 'draft' });
    expect(voidedIds(await InvoiceService.voidOpenInvoicesForCancelledService(draft.visitId))).toEqual([draft.invoiceId]);
    expect((await read(draft.invoiceId)).status).toBe('void');

    const sent = await claimedInvoiceOnCancelledVisit({ status: 'sent', sent_at: new Date() });
    expect(voidedIds(await InvoiceService.voidOpenInvoicesForCancelledService(sent.visitId))).toEqual([sent.invoiceId]);
    expect((await read(sent.invoiceId)).status).toBe('void');
  });
});
