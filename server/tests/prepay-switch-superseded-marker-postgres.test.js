// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// The Schedule on-site switch and the Intelligence Bar switch share
// runPrepaySwitch (routes/admin-schedule.js). For a customer who accepted an
// estimate as pay-per-application, the switch voids the unsent accept draft
// and writes a superseded-by marker on it, so a later refund of the prepay
// re-mints that invoice. The marker write used concat(coalesce(notes, ?), ?),
// which real Postgres rejects ("could not determine data type of parameter
// $2"): every such switch rolled back. The mocked suites
// (schedule-prepay-switch.test.js, intelligence-bar-prepay-switch.test.js)
// never ran the SQL, so only a real database shows it.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
jest.mock('../models/db', () => {
  const db = (...args) => db.connection(...args);
  db.raw = (...args) => db.connection.raw(...args);
  db.transaction = (...args) => db.connection.transaction(...args);
  Object.defineProperty(db, 'schema', { get: () => db.connection.schema });
  Object.defineProperty(db, 'fn', { get: () => db.connection.fn });
  Object.defineProperty(db, 'client', { get: () => db.connection.client });
  return db;
});
jest.mock('../models/marker-db', () => () => require('../models/db'));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../sockets', () => ({ getIo: jest.fn(() => null) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: false, blocked: true, code: 'test' })),
}));
jest.mock('../services/stripe', () => ({
  assertNoInvoiceChargeReconciliationPending: jest.fn(async () => {}),
  retrievePaymentIntent: jest.fn(async () => ({ status: 'requires_payment_method' })),
  cancelPaymentIntent: jest.fn(async () => null),
}));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({ suppressed: true })) }));
jest.mock('../services/push-notifications', () => ({ sendToAdminUsers: jest.fn(async () => ({ sent: 0 })) }));
jest.mock('../services/account-membership-email', () => ({ sendMembershipStarted: jest.fn(async () => {}), sendMembershipRenewalReminder: jest.fn(async () => {}) }));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(), loadTemplateByKey: jest.fn(async () => null), activeSuppressionFor: jest.fn(async () => null),
}));

const { randomUUID } = require('node:crypto');

jest.setTimeout(120000);

const PER_VISIT = 128;
const SETUP_FEE = 99;

postgres('prepay switch on an accepted per-application plan (real Postgres)', () => {
  let database;
  let trx;
  let runPrepaySwitch;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 4 } });
    require('../models/db').connection = database;
    ({ runPrepaySwitch } = require('../routes/admin-schedule'));
  });

  beforeEach(async () => {
    jest.clearAllMocks();
    trx = await database.transaction();
    require('../models/db').connection = trx;
  });

  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  const { etDateString, addETDays } = require('../utils/datetime-et');
  const day = (offset) => etDateString(addETDays(new Date(), offset));

  // What the estimate converter leaves behind for a per-application accept of
  // quarterly pest control: the year's four visits and one UNSENT draft
  // billing the setup fee and the first application, attached to the first
  // visit, which is still ahead.
  async function acceptedPlan() {
    const f = {
      customerId: randomUUID(), estimateId: randomUUID(), visitId: randomUUID(), invoiceId: randomUUID(),
      laterVisitIds: [randomUUID(), randomUUID(), randomUUID()],
    };
    await trx('customers').insert({ id: f.customerId, first_name: 'Synthetic', last_name: 'Switch', phone: '+12025550142',
      email: `${f.customerId}@example.invalid`, property_type: 'residential', autopay_enabled: false, billing_mode: 'per_application' });
    await trx('estimates').insert({ id: f.estimateId, customer_id: f.customerId, status: 'accepted', accepted_at: new Date() });
    const visit = { customer_id: f.customerId, service_type: 'Quarterly Pest Control', window_start: '09:00', window_end: '10:00',
      estimated_price: PER_VISIT, is_recurring: true, recurring_pattern: 'quarterly', recurring_ongoing: true,
      source_estimate_id: f.estimateId };
    await trx('scheduled_services').insert({ ...visit, id: f.visitId, scheduled_date: day(3), status: 'confirmed' });
    for (const [i, id] of f.laterVisitIds.entries()) {
      await trx('scheduled_services').insert({ ...visit, id, scheduled_date: day(3 + 91 * (i + 1)), status: 'confirmed',
        recurring_parent_id: f.visitId });
    }
    const lines = [
      { description: 'WaveGuard Membership — one-time setup fee', quantity: 1, unit_price: SETUP_FEE, amount: SETUP_FEE },
      { description: 'First service application', quantity: 1, unit_price: PER_VISIT, amount: PER_VISIT },
    ];
    const acceptNote = `Auto-generated from accepted estimate #${f.estimateId}. Customer selected pay per application.`;
    await trx('invoices').insert({ id: f.invoiceId, customer_id: f.customerId, scheduled_service_id: f.visitId,
      invoice_number: `TEST-${f.invoiceId.slice(0, 8)}`, token: randomUUID().replace(/-/g, ''), status: 'draft',
      total: SETUP_FEE + PER_VISIT, subtotal: SETUP_FEE + PER_VISIT, service_date: day(3), line_items: JSON.stringify(lines),
      notes: acceptNote });
    return { ...f, acceptNote };
  }

  const switchVisit = (f) => runPrepaySwitch({
    visitId: f.visitId,
    switchLane: true,
    acknowledgeNoticedAmount: false,
    actor: { id: null, name: null, source: 'test' },
    auditSource: 'postgres test',
  });

  test('the switch commits: the accept draft is voided with its superseded-by marker and one unpaid prepay is minted', async () => {
    const f = await acceptedPlan();
    const out = await switchVisit(f);
    expect(out.httpStatus).toBeUndefined();
    expect(out.invoice).toEqual(expect.objectContaining({ customer_id: f.customerId }));

    const first = await trx('invoices').where({ id: f.invoiceId }).first('status', 'notes');
    expect(first.status).toBe('void');
    // The note keeps the accept stamp and gains, on a new line, the exact
    // marker restoreSwitchSupersededInvoicesForPrepay looks up after a refund.
    const { prepaySwitchSupersededByMarker } = require('../services/invoice');
    expect(first.notes).toBe(`${f.acceptNote}\n${prepaySwitchSupersededByMarker(out.invoice.id)}`);

    const prepay = await trx('invoices').where({ id: out.invoice.id }).first('status', 'annual_prepay_term_id');
    expect(prepay.annual_prepay_term_id).toBeTruthy();
    const term = await trx('annual_prepay_terms').where({ id: prepay.annual_prepay_term_id }).first('status');
    expect(term.status).toBe('payment_pending');
  });
});
