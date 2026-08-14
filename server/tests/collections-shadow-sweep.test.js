/**
 * collections/shadow-sweep.js — observation only, by construction.
 *
 * Pins: dark unless GATE_COLLECTIONS_SHADOW === 'true'; creates a shadow
 * collection_cases row + ONE deduped admin card per passing customer; a
 * re-run with an unchanged eligible set/balance is a no-op; a balance change
 * bumps case_version and rotates the idempotency key; card copy uses
 * "open balance"/"billing follow-up" language (never "collections"/
 * "delinquent", no emojis) and masks the phone; and the sweep NEVER touches
 * any messaging surface (send-customer-message / Twilio / SMS renderer spies
 * asserted untouched after every test).
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/collections/contact-policy', () => ({
  evaluate: jest.fn(async () => ({ allowed: false, denialReasons: ['no_eligible_balance'] })),
}));
jest.mock('../services/notification-service', () => ({
  notifyAdmin: jest.fn(async () => ({ id: 'notif-1' })),
}));
// Messaging spies — the sweep must NEVER reach any of these.
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => { throw new Error('shadow sweep must never send'); }),
}));
jest.mock('../services/twilio', () => ({
  sendSMS: jest.fn(async () => { throw new Error('shadow sweep must never text'); }),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async () => { throw new Error('shadow sweep must never render SMS'); }),
}));

const db = require('../models/db');
const ContactPolicy = require('../services/collections/contact-policy');
const NotificationService = require('../services/notification-service');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const TwilioService = require('../services/twilio');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const ShadowSweep = require('../services/collections/shadow-sweep');

const NOW = new Date('2026-08-12T15:00:00Z'); // Wed Aug 12, 11:00 ET

function chain({ result = [], first, returning } = {}) {
  const q = {};
  ['where', 'whereIn', 'whereNull', 'whereRaw', 'orderBy', 'distinct', 'select', 'limit']
    .forEach((m) => { q[m] = jest.fn(() => q); });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => returning || []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

const CUSTOMER = { id: 'cust-1', first_name: 'Sandy', phone: '+19415550100' };
// $128.00, due 2026-07-22 → 21 days overdue on Aug 12 → tier 14.
const INVOICE = {
  id: 'inv-1',
  invoice_number: 'WPC-2026-1100',
  title: 'Quarterly Pest Control',
  total: '128.00',
  credit_applied: 0,
  due_date: '2026-07-22',
  created_at: '2026-07-01T12:00:00.000Z',
};
const ALLOWED_VERDICT = {
  allowed: true,
  denialReasons: [],
  eligibleInvoiceIds: ['inv-1'],
  eligibleBalanceCents: 12800,
  consentEvidence: { source: 'inbound_sms', evidenceRef: 'sms-9', evidenceAt: '2026-08-01T12:00:00.000Z' },
};

const savedGate = process.env.GATE_COLLECTIONS_SHADOW;
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_COLLECTIONS_SHADOW;
  else process.env.GATE_COLLECTIONS_SHADOW = savedGate;
});

beforeEach(() => {
  jest.clearAllMocks();
  process.env.GATE_COLLECTIONS_SHADOW = 'true';
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
  ContactPolicy.evaluate.mockResolvedValue(ALLOWED_VERDICT);
  NotificationService.notifyAdmin.mockResolvedValue({ id: 'notif-1' });
});

afterEach(() => {
  // THE hard line of this PR: no run, in any state, touches messaging.
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  expect(renderSmsTemplate).not.toHaveBeenCalled();
});

describe('gate', () => {
  test("unset ⇒ inert: no reads, no writes, no cards", async () => {
    delete process.env.GATE_COLLECTIONS_SHADOW;
    setDbQueues({});
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(result).toEqual({ skipped: true, reason: 'gated_off' });
    expect(db).not.toHaveBeenCalled();
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  test("'false' ⇒ inert", async () => {
    process.env.GATE_COLLECTIONS_SHADOW = 'false';
    setDbQueues({});
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(result).toEqual({ skipped: true, reason: 'gated_off' });
  });
});

describe('case + card creation', () => {
  test('a passing customer gets a version-1 shadow case and one proposal card', async () => {
    const caseInsert = chain({ returning: [{ id: 'case-1', case_version: 1, eligible_balance_snapshot: 12800 }] });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ first: undefined }), caseInsert],
      notifications: [chain({ first: null })],
    });

    const result = await ShadowSweep.runShadowSweep({ now: NOW });

    expect(ContactPolicy.evaluate).toHaveBeenCalledWith('cust-1', {
      channel: 'voice', purpose: 'late_payment', now: NOW,
    });
    expect(caseInsert.insert).toHaveBeenCalledWith(expect.objectContaining({
      customer_id: 'cust-1',
      eligible_invoice_ids: JSON.stringify(['inv-1']),
      eligible_balance_snapshot: 12800,
      earliest_due_date: '2026-07-22',
      case_version: 1,
      current_state: 'shadow',
      idempotency_key: 'collections:cust-1:1:14',
      proposal_created_at: NOW,
      consent_evidence: JSON.stringify({
        source: 'inbound_sms', evidence_ref: 'sms-9', evidence_at: '2026-08-01T12:00:00.000Z',
      }),
    }));
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ skipped: false, considered: 1, casesCreated: 1, casesUpdated: 0, cardsFiled: 1 });
  });

  test('the card masks the phone, names the invoice/balance/age/consent, and speaks open-balance language', async () => {
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ first: undefined }), chain({ returning: [{ id: 'case-1', case_version: 1, eligible_balance_snapshot: 12800 }] })],
      notifications: [chain({ first: null })],
    });
    await ShadowSweep.runShadowSweep({ now: NOW });

    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('billing_followup');
    expect(title).toContain('Billing follow-up proposal');
    expect(title).toContain('$128.00');
    expect(body).toContain('***-***-0100');
    expect(body).not.toContain('+19415550100');
    expect(body).toContain('WPC-2026-1100');
    expect(body).toContain('21 days past due');
    expect(body).toContain('inbound_sms');
    expect(body).toContain('Waves Pest Control');
    expect(body).toContain('open balance');
    expect(body).toContain('no call will be placed');
    // Language rules: never "collections"/"delinquent", no emojis.
    expect(`${title}\n${body}`).not.toMatch(/collection|delinquen/i);
    expect(`${title}\n${body}`).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    expect(opts).toMatchObject({
      link: '/admin/customers/cust-1',
      metadata: expect.objectContaining({ dedupeKey: 'collections:cust-1:1:14', customerId: 'cust-1' }),
    });
  });

  test('a denied customer produces no case and no card', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: false, denialReasons: ['outside_call_window'] });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: false, considered: 1, casesCreated: 0, casesUpdated: 0, cardsFiled: 0 });
  });
});

describe('idempotency + versioning', () => {
  const EXISTING_CASE = {
    id: 'case-1',
    customer_id: 'cust-1',
    case_version: 1,
    eligible_balance_snapshot: 12800,
    eligible_invoice_ids: '["inv-1"]',
    current_state: 'shadow',
    idempotency_key: 'collections:cust-1:1:14',
  };

  test('re-run with an unchanged eligible set/balance is a no-op (no new row, no new card)', async () => {
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ first: EXISTING_CASE })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: false, considered: 1, casesCreated: 0, casesUpdated: 0, cardsFiled: 0 });
  });

  test('a balance change bumps case_version, rotates the idempotency key, and files a fresh card', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ ...ALLOWED_VERDICT, eligibleBalanceCents: 15300 });
    const caseUpdate = chain({ returning: [{ id: 'case-1', case_version: 2, eligible_balance_snapshot: 15300 }] });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ first: EXISTING_CASE }), caseUpdate],
      notifications: [chain({ first: null })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });

    expect(caseUpdate.where).toHaveBeenCalledWith({ id: 'case-1', case_version: 1 });
    expect(caseUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      case_version: 2,
      eligible_balance_snapshot: 15300,
      idempotency_key: 'collections:cust-1:2:14',
    }));
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(NotificationService.notifyAdmin.mock.calls[0][3].metadata.dedupeKey).toBe('collections:cust-1:2:14');
    expect(result).toEqual({ skipped: false, considered: 1, casesCreated: 0, casesUpdated: 1, cardsFiled: 1 });
  });

  test('an already-filed card (same dedupe key) is not re-filed even when the case row is rewritten', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ ...ALLOWED_VERDICT, eligibleBalanceCents: 15300 });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [
        chain({ first: EXISTING_CASE }),
        chain({ returning: [{ id: 'case-1', case_version: 2, eligible_balance_snapshot: 15300 }] }),
      ],
      notifications: [chain({ first: { id: 'notif-existing' } })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(result.cardsFiled).toBe(0);
  });

  test('a version-guard miss (concurrent sweep already bumped) skips without a card', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ ...ALLOWED_VERDICT, eligibleBalanceCents: 15300 });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ first: EXISTING_CASE }), chain({ returning: [] })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: false, considered: 1, casesCreated: 0, casesUpdated: 0, cardsFiled: 0 });
  });
});

describe('resilience', () => {
  test('one failing customer never kills the sweep for the rest', async () => {
    ContactPolicy.evaluate
      .mockRejectedValueOnce(new Error('policy exploded'))
      .mockResolvedValueOnce(ALLOWED_VERDICT);
    setDbQueues({
      invoices: [
        chain({ result: [{ customer_id: 'cust-err' }, { customer_id: 'cust-1' }] }),
        chain({ first: INVOICE }),
      ],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ first: undefined }), chain({ returning: [{ id: 'case-1', case_version: 1 }] })],
      notifications: [chain({ first: null })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(result).toEqual({ skipped: false, considered: 2, casesCreated: 1, casesUpdated: 0, cardsFiled: 1 });
  });
});

describe('script text', () => {
  test('the predicted opening uses billing-follow-up language and the exact company name', () => {
    const script = ShadowSweep.predictedOpeningScript({
      firstName: 'Sandy', amountDollars: '128.00', invoiceTitle: 'Quarterly Pest Control',
    });
    expect(script).toContain('Waves Pest Control');
    expect(script).toContain('billing follow-up');
    expect(script).toContain('open balance of $128.00');
    expect(script).not.toMatch(/collection|delinquen/i);
    expect(script).not.toMatch(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
  });
});
