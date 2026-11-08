// A bill from a won commercial proposal on Net terms is due 30 or 60 days after its visit (proposal-win.js
// proposalTermsDueDate). The reminder ladder used to start on the day the bill went out, so a Net 60 customer got
// "7 days past due", "14 days past due" and "30 days past due" texts before the bill was due. Its ladder now starts on
// the due date (owner 2026-11-01, commercial audit fix 1), stored as the row's anchor_at so every later step, a void
// re-arm and the customer schedule keep it. Every other bill still starts when it went out.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/invoice-helpers', () => ({
  invoiceAmountDue: jest.fn(),
  invoiceWithdrawnFromCustomer: (invoice) => /^payer_billed:/.test(String(invoice?.scheduled_send_error || '')),
}));
jest.mock('../routes/admin-sms-templates', () => ({}));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  gates: {},
  estimateDueFirstVisitLive: () => process.env.GATE_ESTIMATE_DUE_FIRST_VISIT === 'true',
}));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/microdeposit-verification-email', () => ({ sendMicrodepositVerificationEmail: jest.fn() }));
jest.mock('../services/short-url', () => ({ shortenOrPassthrough: jest.fn(), invoiceShortCodePrefix: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: jest.fn() }));
jest.mock('../services/email-template-library', () => ({}));
jest.mock('../services/customer-contact', () => ({ getInvoiceEmailRecipients: jest.fn() }));
jest.mock('../services/email-template', () => ({ currency: jest.fn() }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: jest.fn() }));

const db = require('../models/db');
const logger = require('../services/logger');
const { customerOnAutopay } = require('../services/autopay-eligibility');
const { scheduleForInvoice, planFollowupSequence } = require('../services/invoice-followups');

// Tuesday 2026-11-03 10:00 AM EST, inside the Tue-Fri send window.
const NOW = new Date('2026-11-03T15:00:00Z');
const tenAmEST = (day) => new Date(`${day}T15:00:00Z`);

const proposal = (paymentTerms) => ({
  enabled: true,
  title: 'Bayview Office Proposal',
  buildings: [{ name: 'Main building', lineItems: [{ description: 'Monthly pest', quantity: 1, unitPrice: 120, frequency: 'monthly', taxable: true, amount: 120 }] }],
  commercialTerms: { paymentTerms },
});

// Synthetic estimate ids: the accept stamp names a uuid.
const ACCEPTED_ID = '0b6a1f2e-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const OPEN_ID = '9e8d7c6b-5a49-4b38-8c27-1d0e9f8a7b6c';

const baseTables = () => ({
  invoices: [],
  payment_plans: [],
  customers: [{ id: 'c-1' }],
  invoice_followup_sequences: [],
  service_records: [{ id: 'rec-1', scheduled_service_id: 'ss-net30' }],
  scheduled_services: [
    { id: 'ss-net30', source_estimate_id: 'est-net30' },
    { id: 'ss-autopay', source_estimate_id: 'est-autopay' },
    { id: 'ss-sent', source_estimate_id: 'est-sent' },
    { id: 'ss-home', source_estimate_id: 'est-home' },
    { id: 'ss-none', source_estimate_id: null },
    // GATE_ESTIMATE_DUE_FIRST_VISIT: the first visit an accept booked for Nov 9, since moved to Nov 12.
    { id: 'ss-first', source_estimate_id: ACCEPTED_ID, scheduled_date: '2026-11-12' },
  ],
  estimates: [
    { id: 'est-net30', status: 'accepted', bill_by_invoice: true, estimate_data: { proposal: proposal('net30') } },
    { id: 'est-autopay', status: 'accepted', bill_by_invoice: false, estimate_data: { proposal: proposal('autopay') } },
    { id: 'est-sent', status: 'sent', bill_by_invoice: true, estimate_data: { proposal: proposal('net30') } },
    { id: 'est-home', status: 'accepted', bill_by_invoice: false, estimate_data: { services: [] } },
    { id: ACCEPTED_ID, status: 'accepted', bill_by_invoice: false, estimate_data: { services: [] } },
    { id: OPEN_ID, status: 'sent', bill_by_invoice: false, estimate_data: { services: [] } },
  ],
});

// A knex-style fake: where(object) and whereIn(column, values) filter rows (other where forms are ignored), first/select
// resolve the matches, insert(...).returning() records the row. `fail` names a table whose read rejects.
function setupDb(tables, { fail = null } = {}) {
  const inserts = [];
  const conn = (table) => {
    const filters = {};
    const inFilters = {};
    const rows = () => {
      if (fail === table) return Promise.reject(new Error(`${table} read failed`));
      if (table === 'ach_failure_log') return Promise.resolve([{ cnt: 0 }]);
      return Promise.resolve((tables[table] || []).filter((row) => Object.entries(filters)
        .every(([key, value]) => String(row[key]) === String(value))
        && Object.entries(inFilters).every(([key, values]) => values.includes(String(row[key])))));
    };
    const q = {
      where(filter) { if (filter && typeof filter === 'object') Object.assign(filters, filter); return q; },
      whereIn(column, values) { inFilters[column] = values.map(String); return q; },
      forUpdate() { return q; },
      count() { return q; },
      first: () => rows().then((found) => found[0] || null),
      select: () => rows(),
      insert(payload) {
        inserts.push(payload);
        return { returning: async () => [{ id: `seq-${inserts.length}`, ...payload }] };
      },
    };
    return q;
  };
  db.mockImplementation(conn);
  conn.raw = jest.fn(async () => ({}));
  conn.fn = { now: () => 'now()' };
  db.raw = conn.raw;
  db.fn = conn.fn;
  db.transaction = jest.fn(async (fn) => fn(conn));
  return { conn, inserts };
}

const bill = (overrides = {}) => ({
  id: 'inv-1', customer_id: 'c-1', status: 'sent', payer_id: null, scheduled_send_error: null,
  sent_at: NOW, sms_sent_at: null, created_at: NOW, due_date: '2026-12-03',
  scheduled_service_id: 'ss-net30', service_record_id: null,
  ...overrides,
});

beforeEach(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] });
  jest.setSystemTime(NOW);
  jest.clearAllMocks();
  process.env.GATE_DUNNING_LADDER_90 = 'true';
  customerOnAutopay.mockResolvedValue(false);
});
afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_DUNNING_LADDER_90;
  delete process.env.GATE_ESTIMATE_DUE_FIRST_VISIT;
});

describe('scheduleForInvoice: where a new sequence starts', () => {
  test('a won Net 30 proposal bill sent before its due date starts on the due date, stored as anchor_at', async () => {
    const tables = baseTables();
    tables.invoices = [bill()];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1');

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ status: 'active', step_index: 0, anchor_at: new Date('2026-12-03T12:00:00Z') });
    // Day 3 counts from the due date, at 10:00 New York.
    expect(inserts[0].next_touch_at).toEqual(tenAmEST('2026-12-06'));
  });

  test('a bill that names its visit only through its service record is found the same way', async () => {
    const tables = baseTables();
    tables.invoices = [bill({ scheduled_service_id: null, service_record_id: 'rec-1' })];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1');

    expect(inserts[0].anchor_at).toEqual(new Date('2026-12-03T12:00:00Z'));
  });

  test('a won Auto Pay proposal bill with a later due date starts there too (any billing mode)', async () => {
    const tables = baseTables();
    tables.invoices = [bill({ scheduled_service_id: 'ss-autopay' })];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1');

    expect(inserts[0].anchor_at).toEqual(new Date('2026-12-03T12:00:00Z'));
  });

  test.each([
    ['due the day it went out', { due_date: '2026-11-03' }],
    ['due before it went out', { due_date: '2026-10-20' }],
    ['no due date', { due_date: null }],
    ['a proposal that is not won', { scheduled_service_id: 'ss-sent' }],
    ['a visit from an estimate that is not a proposal', { scheduled_service_id: 'ss-home' }],
    ['a visit with no source estimate', { scheduled_service_id: 'ss-none' }],
    ['no visit at all', { scheduled_service_id: null }],
  ])('%s: starts when it went out, no anchor_at', async (_label, overrides) => {
    const tables = baseTables();
    tables.invoices = [bill(overrides)];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1');

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).not.toHaveProperty('anchor_at');
    expect(inserts[0].next_touch_at).toEqual(tenAmEST('2026-11-06'));
  });

  test('an unreadable proposal arms nothing on a direct send and leaves the bill to the adoption sweep', async () => {
    const tables = baseTables();
    tables.invoices = [bill()];
    const { inserts } = setupDb(tables, { fail: 'estimates' });

    await expect(scheduleForInvoice('inv-1')).resolves.toBeNull();

    expect(inserts).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('left for adoption'));
  });

  test('adoption fails closed on an unreadable proposal: the transaction throws and the next sweep retries', async () => {
    const tables = baseTables();
    tables.invoices = [bill({ sent_at: new Date('2026-10-24T14:00:00Z'), due_date: '2026-11-23' })];
    const { inserts } = setupDb(tables, { fail: 'estimates' });

    await expect(scheduleForInvoice('inv-1', { adoption: true })).rejects.toThrow('estimates read failed');
    expect(inserts).toHaveLength(0);
  });

  test('adoption of a Net-terms bill sent 10 days ago lands on Day 3 after its due date, not on a send-day step', async () => {
    const tables = baseTables();
    tables.invoices = [bill({ sent_at: new Date('2026-10-24T14:00:00Z'), due_date: '2026-11-23' })];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1', { adoption: true });

    expect(inserts[0]).toMatchObject({ step_index: 0, anchor_at: new Date('2026-11-23T12:00:00Z') });
    expect(inserts[0].next_touch_at).toEqual(tenAmEST('2026-11-26'));
  });

  test('an Auto Pay hold keeps the due-date start for when the hold releases', async () => {
    customerOnAutopay.mockResolvedValue(true);
    const tables = baseTables();
    tables.invoices = [bill({ scheduled_service_id: 'ss-autopay' })];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1');

    expect(inserts[0]).toMatchObject({ status: 'autopay_hold', next_touch_at: null, anchor_at: new Date('2026-12-03T12:00:00Z') });
  });
});

describe('planFollowupSequence: the send card says where the reminders start', () => {
  test('a Net-terms bill reports its due date as startsOn', async () => {
    const tables = baseTables();
    const { conn } = setupDb(tables);

    const plan = await planFollowupSequence(bill(), conn, { id: 'c-1' });

    expect(plan).toMatchObject({ arms: true, state: 'active', startsOn: '2026-12-03' });
  });

  test('a bill that starts when it goes out reports no startsOn', async () => {
    const tables = baseTables();
    const { conn } = setupDb(tables);

    const plan = await planFollowupSequence(bill({ due_date: '2026-11-03' }), conn, { id: 'c-1' });

    expect(plan).toMatchObject({ arms: true, state: 'active' });
    expect(plan).not.toHaveProperty('startsOn');
  });

  test('an unreadable start reads as the send arming nothing', async () => {
    const tables = baseTables();
    const { conn } = setupDb(tables, { fail: 'estimates' });

    const plan = await planFollowupSequence(bill(), conn, { id: 'c-1' });

    expect(plan).toMatchObject({ arms: false, state: 'start_unreadable' });
  });
});

// GATE_ESTIMATE_DUE_FIRST_VISIT (owner 2026-11-06 "walk all"): an estimate-accept invoice is due on its first visit's
// day (estimate-public.js acceptInvoiceVisitDueDate), so its ladder starts there too: no reminder calls it late before
// that day. The bill is the accept's by its notes stamp (invoices carry no estimate_id column), never by the visit's
// current date: a visit moved after the accept keeps the start (Codex pre-push P1). Accepted Tue Nov 3, due Mon Nov 9.
describe('GATE_ESTIMATE_DUE_FIRST_VISIT: an accept bill starts on its due date', () => {
  const stamp = (estimateId) => `Auto-generated from accepted estimate #${estimateId}. Customer selected pay per application — first application only.`;
  const acceptBill = (overrides = {}) => bill({
    due_date: '2026-11-09', scheduled_service_id: 'ss-first', notes: stamp(ACCEPTED_ID), ...overrides,
  });
  const startsOnSendDay = (inserts) => {
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).not.toHaveProperty('anchor_at');
    expect(inserts[0].next_touch_at).toEqual(tenAmEST('2026-11-06'));
  };

  test('gate on, its visit moved to Nov 12 after the accept: still starts on the Nov 9 due date', async () => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = 'true';
    const tables = baseTables();
    tables.invoices = [acceptBill()];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1');

    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({ status: 'active', step_index: 0, anchor_at: new Date('2026-11-09T12:00:00Z') });
    expect(inserts[0].next_touch_at).toEqual(tenAmEST('2026-11-12'));
  });

  test('gate off: the same bill starts when it went out (today\'s behavior)', async () => {
    const tables = baseTables();
    tables.invoices = [acceptBill()];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1');

    startsOnSendDay(inserts);
  });

  test.each([
    ['an unstamped bill with a later due date', { notes: 'Spring aeration, billed ahead.' }],
    ['no notes at all', { notes: null }],
    ['a stamp that is not where the note starts', { notes: `Re-billed. ${stamp(ACCEPTED_ID)}` }],
    ['a stamped bill whose estimate is not accepted', { notes: stamp(OPEN_ID) }],
    ['a stamped bill whose estimate is gone', { notes: stamp('5f4e3d2c-1b0a-4987-a6b5-c4d3e2f1a0b9') }],
    // An annual prepay ("Pay the year upfront") and every gate-off accept keep a due date of today.
    ['a stamped annual prepay due the day it went out', {
      due_date: '2026-11-03', notes: `Auto-generated from accepted estimate #${ACCEPTED_ID}. Customer selected "Pay the year upfront" for the plan.`,
    }],
  ])('gate on, %s: starts when it went out, no anchor_at', async (_label, overrides) => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = 'true';
    const tables = baseTables();
    tables.invoices = [acceptBill(overrides)];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1');

    startsOnSendDay(inserts);
  });

  test('gate on, a won Net 30 proposal bill keeps its due-date start (the proposal rule runs first)', async () => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = 'true';
    const tables = baseTables();
    tables.invoices = [bill()];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1');

    expect(inserts[0]).toMatchObject({ anchor_at: new Date('2026-12-03T12:00:00Z') });
    expect(inserts[0].next_touch_at).toEqual(tenAmEST('2026-12-06'));
  });

  test('gate on, an Auto Pay hold keeps the due-date start for when the hold releases', async () => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = 'true';
    customerOnAutopay.mockResolvedValue(true);
    const tables = baseTables();
    tables.invoices = [acceptBill()];
    const { inserts } = setupDb(tables);

    await scheduleForInvoice('inv-1');

    expect(inserts[0]).toMatchObject({ status: 'autopay_hold', next_touch_at: null, anchor_at: new Date('2026-11-09T12:00:00Z') });
  });

  test('gate on, a bill object without its notes reads them by id: the send card reports the due date as startsOn', async () => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = 'true';
    const tables = baseTables();
    tables.invoices = [acceptBill()];
    const { conn } = setupDb(tables);
    const { notes: _omitted, ...withoutNotes } = acceptBill();

    const plan = await planFollowupSequence(withoutNotes, conn, { id: 'c-1' });

    expect(plan).toMatchObject({ arms: true, state: 'active', startsOn: '2026-11-09' });
  });

  test('gate on, an unreadable estimate arms nothing on a direct send and leaves the bill to the adoption sweep', async () => {
    process.env.GATE_ESTIMATE_DUE_FIRST_VISIT = 'true';
    const tables = baseTables();
    tables.invoices = [acceptBill({ scheduled_service_id: null })];
    const { inserts } = setupDb(tables, { fail: 'estimates' });

    await expect(scheduleForInvoice('inv-1')).resolves.toBeNull();

    expect(inserts).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('left for adoption'));
  });
});
