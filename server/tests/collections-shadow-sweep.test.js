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
  ['where', 'whereIn', 'whereNotIn', 'whereNull', 'whereRaw', 'orderBy', 'distinct', 'select', 'limit']
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
  db.raw = jest.fn((expr) => expr);
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
      collection_cases: [chain({ result: [] }), chain({ first: undefined }), caseInsert, chain({ result: [] })],
      notifications: [chain({ result: 1 }), chain({ first: null })],
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
    expect(result).toEqual({ skipped: false, considered: 1, casesCreated: 1, casesUpdated: 0, cardsFiled: 1, casesLapsed: 0 });
  });

  test('the card masks the phone, names the invoice/balance/age/consent, and speaks open-balance language', async () => {
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ result: [] }), chain({ first: undefined }), chain({ returning: [{ id: 'case-1', case_version: 1, eligible_balance_snapshot: 12800 }, chain({ result: [] })] })],
      notifications: [chain({ result: 1 }), chain({ first: null })],
    });
    await ShadowSweep.runShadowSweep({ now: NOW });

    const [category, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(category).toBe('billing'); // existing bell-allowlisted category — GATE_ADMIN_BELL_POLICY is ON in prod; a novel category would be silently suppressed
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
    expect(result).toEqual({ skipped: false, considered: 1, casesCreated: 0, casesUpdated: 0, cardsFiled: 0, casesLapsed: 0 });
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
      collection_cases: [chain({ result: [] }), chain({ first: EXISTING_CASE }), chain({ result: [] })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: false, considered: 1, casesCreated: 0, casesUpdated: 0, cardsFiled: 0, casesLapsed: 0 });
  });

  test('a balance change bumps case_version, rotates the idempotency key, and files a fresh card', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ ...ALLOWED_VERDICT, eligibleBalanceCents: 15300 });
    const caseUpdate = chain({ returning: [{ id: 'case-1', case_version: 2, eligible_balance_snapshot: 15300 }] });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ result: [] }), chain({ first: EXISTING_CASE }), caseUpdate, chain({ result: [] })],
      notifications: [chain({ result: 1 }), chain({ first: null })],
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
    expect(result).toEqual({ skipped: false, considered: 1, casesCreated: 0, casesUpdated: 1, cardsFiled: 1, casesLapsed: 0 });
  });

  test('an already-filed card (same dedupe key) is not re-filed even when the case row is rewritten', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ ...ALLOWED_VERDICT, eligibleBalanceCents: 15300 });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [
        chain({ first: EXISTING_CASE }),
        chain({ returning: [{ id: 'case-1', case_version: 2, eligible_balance_snapshot: 15300 }, chain({ result: [] })] }),
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
      collection_cases: [chain({ result: [] }), chain({ first: EXISTING_CASE }), chain({ returning: [, chain({ result: [] })] })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: false, considered: 1, casesCreated: 0, casesUpdated: 0, cardsFiled: 0, casesLapsed: 0 });
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
      collection_cases: [chain({ result: [] }), chain({ first: undefined }), chain({ returning: [{ id: 'case-1', case_version: 1 }, chain({ result: [] })] })],
      notifications: [chain({ result: 1 }), chain({ first: null })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(result).toEqual({ skipped: false, considered: 2, casesCreated: 1, casesUpdated: 0, cardsFiled: 1, casesLapsed: 0 });
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

// gh-r1 (2026-08-14): the card is the case's ONLY surface — a failed
// notifyAdmin insert must not read as filed, and an unchanged case whose
// card is missing re-files it (probe-notifications pattern).
describe('card durability', () => {
  const EXISTING_CASE = {
    id: 'case-1', case_version: 1, current_state: 'shadow', eligible_balance_snapshot: 12800,
    eligible_invoice_ids: JSON.stringify(['inv-1']), idempotency_key: 'collections:cust-1:1:14',
  };

  test('a failed notifyAdmin insert is NOT counted as a filed card', async () => {
    NotificationService.notifyAdmin.mockResolvedValueOnce(null);
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ result: [] }), chain({ first: undefined }), chain({ returning: [{ id: 'case-1', case_version: 1, eligible_balance_snapshot: 12800 }, chain({ result: [] })] })],
      notifications: [chain({ result: 1 }), chain({ first: null })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(result.cardsFiled).toBe(0);
    expect(result.casesCreated).toBe(1);
  });

  test('an unchanged case with NO standing card re-files it; with a card it stays a pure no-op', async () => {
    // Missing card ⇒ refile (probe null, then fileProposalCard's own probe null).
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ result: [] }), chain({ first: EXISTING_CASE }), chain({ result: [] })],
      notifications: [chain({ first: null }), chain({ first: null })],
    });
    const refiled = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    expect(refiled).toEqual({ skipped: false, considered: 1, casesCreated: 0, casesUpdated: 0, cardsFiled: 1, casesLapsed: 0 });

    // Standing card ⇒ untouched no-op.
    jest.clearAllMocks();
    ContactPolicy.evaluate.mockResolvedValue(ALLOWED_VERDICT);
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'notif-1' });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ result: [] }), chain({ first: EXISTING_CASE }), chain({ result: [] })],
      notifications: [chain({ first: { id: 'notif-1' } })],
    });
    const noop = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
    expect(noop.cardsFiled).toBe(0);
  });
});

// r3: shadow cases retire when eligibility disappears, and a tier crossing
// is a CHANGED proposal (new version/key/card).
describe('retirement + tier rotation', () => {
  test('a customer denied this sweep has their case lapsed AND its unread card retired', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: false, denialReasons: ['flag_collection_hold'] });
    const selectChain = chain({ result: [{ id: 'case-1', idempotency_key: 'collections:cust-1:1:14' }] });
    const updateChain = chain({ result: 1 });
    const cardChain = chain({ result: 1 });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] })],
      collection_cases: [selectChain, updateChain],
      notifications: [cardChain],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(result.casesLapsed).toBe(1);
    expect(selectChain.whereNotIn).toHaveBeenCalledWith('customer_id', []);
    expect(updateChain.update).toHaveBeenCalledWith(expect.objectContaining({ current_state: 'lapsed' }));
    // The proposal card retires WITH the case (codex r5) — via the bell's
    // own read_at mechanism, never a delete.
    expect(cardChain.update).toHaveBeenCalledWith(expect.objectContaining({ read_at: expect.anything() }));
  });

  test('an unchanged balance that crossed a dunning tier rotates the version and files a fresh card', async () => {
    // Same invoice set + balance, but the standing key is the 14-day tier
    // while the invoice is now 35 days overdue (tier 30) ⇒ NOT unchanged.
    const existing = {
      id: 'case-1', case_version: 1, eligible_balance_snapshot: 12800,
      eligible_invoice_ids: JSON.stringify(['inv-1']), idempotency_key: 'collections:cust-1:1:14',
    };
    const caseUpdate = chain({ returning: [{ id: 'case-1', case_version: 2, eligible_balance_snapshot: 12800 }] });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: { ...INVOICE, due_date: '2026-07-08' } })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ result: [] }), chain({ first: existing }), caseUpdate, chain({ result: [] })],
      notifications: [chain({ result: 1 }), chain({ first: null })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(caseUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      case_version: 2,
      idempotency_key: 'collections:cust-1:2:30',
    }));
    expect(result.cardsFiled).toBe(1);
  });
});

// r4: the broad phase serves legacy 'unpaid' too, and a lapsed case
// reactivates by advancing its version, never by colliding at version 1.
describe('r4: unpaid candidates + lapsed reactivation', () => {
  test('the candidate pool includes legacy unpaid invoices', async () => {
    const candChain = chain({ result: [] });
    setDbQueues({ invoices: [candChain], collection_cases: [chain({ result: [] }), chain({ result: [] })] });
    await ShadowSweep.runShadowSweep({ now: NOW });
    expect(candChain.whereIn).toHaveBeenCalledWith('status', ['sent', 'viewed', 'overdue', 'unpaid']);
  });

  test('a requalifying LAPSED case advances the version and returns to shadow with a fresh card', async () => {
    const lapsed = {
      id: 'case-1', case_version: 3, current_state: 'lapsed',
      eligible_balance_snapshot: 12800, eligible_invoice_ids: JSON.stringify(['inv-1']),
      idempotency_key: 'collections:cust-1:3:14',
    };
    const caseUpdate = chain({ returning: [{ id: 'case-1', case_version: 4, eligible_balance_snapshot: 12800 }] });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [chain({ result: [] }), chain({ first: lapsed }), caseUpdate, chain({ result: [] })],
      notifications: [chain({ result: 1 }), chain({ first: null })],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(caseUpdate.update).toHaveBeenCalledWith(expect.objectContaining({
      case_version: 4,
      current_state: 'shadow',
      idempotency_key: 'collections:cust-1:4:14',
    }));
    expect(result.cardsFiled).toBe(1);
  });
});

// r6: outage safety + merge hygiene.
describe('r6: evaluation errors preserve, duplicate live cases self-heal', () => {
  test('a policy_evaluation_error (transient outage) does NOT lapse the standing case', async () => {
    ContactPolicy.evaluate.mockResolvedValue({ allowed: false, denialReasons: ['policy_evaluation_error'] });
    const retireSelect = chain({ result: [] });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] })],
      collection_cases: [retireSelect],
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(result.casesLapsed).toBe(0);
    // The erroring customer stays in the still-eligible set: the retirement
    // whereNotIn carries them, so their case survives the outage.
    expect(retireSelect.whereNotIn).toHaveBeenCalledWith('customer_id', ['cust-1']);
  });

  test('two live shadow cases (customer merge) self-heal: newest kept, extra lapsed + its card retired', async () => {
    const healSelect = chain({
      result: [
        { id: 'case-new', idempotency_key: 'collections:cust-1:2:14' },
        { id: 'case-old', idempotency_key: 'collections:cust-9:1:14' },
      ],
    });
    const healUpdate = chain({ result: 1 });
    const healCard = chain({ result: 1 });
    setDbQueues({
      invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
      customers: [chain({ first: CUSTOMER })],
      collection_cases: [
        healSelect,
        healUpdate,
        chain({ first: { id: 'case-new', case_version: 2, current_state: 'shadow', eligible_balance_snapshot: 12800, eligible_invoice_ids: JSON.stringify(['inv-1']), idempotency_key: 'collections:cust-1:2:14' } }),
        chain({ result: [] }),
      ],
      notifications: [healCard, chain({ first: { id: 'notif-1' } })], // heal retire + unchanged-case card probe
    });
    const result = await ShadowSweep.runShadowSweep({ now: NOW });
    expect(healUpdate.whereIn).toHaveBeenCalledWith('id', ['case-old']);
    expect(healUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ current_state: 'lapsed' }));
    expect(healCard.update).toHaveBeenCalledWith(expect.objectContaining({ read_at: expect.anything() }));
    // The surviving case reads unchanged with a standing card ⇒ pure no-op.
    expect(result.cardsFiled).toBe(0);
  });
});

// r8: a version rotation retires the SUPERSEDED card — the old copy shows
// stale amount/tier and points at mutated case data.
test('rotating the case version retires the previous version card', async () => {
  const existing = {
    id: 'case-1', case_version: 1, current_state: 'shadow',
    eligible_balance_snapshot: 9999, // balance changed ⇒ rotation
    eligible_invoice_ids: JSON.stringify(['inv-1']), idempotency_key: 'collections:cust-1:1:14',
  };
  const retireOld = chain({ result: 1 });
  setDbQueues({
    invoices: [chain({ result: [{ customer_id: 'cust-1' }] }), chain({ first: INVOICE })],
    customers: [chain({ first: CUSTOMER })],
    collection_cases: [
      chain({ result: [{ id: 'case-1', idempotency_key: 'collections:cust-1:1:14' }] }), // self-heal read (single row)
      chain({ first: existing }),
      chain({ returning: [{ id: 'case-1', case_version: 2, eligible_balance_snapshot: 12800 }] }),
      chain({ result: [] }),
    ],
    notifications: [retireOld, chain({ first: null })],
  });
  const result = await ShadowSweep.runShadowSweep({ now: NOW });
  expect(retireOld.whereRaw).toHaveBeenCalledWith("metadata->>'dedupeKey' = ?", ['collections:cust-1:1:14']);
  expect(retireOld.update).toHaveBeenCalledWith(expect.objectContaining({ read_at: expect.anything() }));
  expect(result.cardsFiled).toBe(1);
});
