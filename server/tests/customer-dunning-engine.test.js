// Customer-level overdue reminders (dunning consolidation PR 2): the engine's
// send path, driven through the REAL billing-reminder-delivery
// (sendReminderChannels / reminderProgress) over an in-memory contact ledger,
// with the rails (SMS sender, email template library + billing authority),
// the set authority and the schedule store faked. One test (or table row) per
// class in the #5188/#5270 failure catalogue — finding ids are in the names.
//
// All ids are synthetic. The SQL of the schedule store is proven on a real
// PostgreSQL in customer-dunning-schedule-postgres.test.js.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn() }));
jest.mock('../services/sms-template-renderer', () => ({ renderSmsTemplate: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ gates: {}, dunningCustomerScheduleAllowlist: () => null }));
jest.mock('../services/stripe', () => ({}));
jest.mock('../services/microdeposit-verification-email', () => ({ sendMicrodepositVerificationEmail: jest.fn() }));
jest.mock('../utils/portal-url', () => ({ publicPortalUrl: () => 'https://portal.example.test' }));
jest.mock('../services/email-template', () => ({ currency: (n) => `$${Number(n).toFixed(2)}` }));
jest.mock('../utils/date-only', () => ({ formatDateOnly: (v) => (v ? String(v) : '') }));

const mockShorten = jest.fn(async (url) => `https://short.example.test/${Buffer.from(url).toString('hex').slice(-6)}`);
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: (...a) => mockShorten(...a),
  invoiceShortCodePrefix: () => 'W-1-0801',
}));
const mockSendMessage = jest.fn();
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: (...a) => mockSendMessage(...a) }));
const mockOnAutopay = jest.fn();
jest.mock('../services/autopay-eligibility', () => ({ customerOnAutopay: (...a) => mockOnAutopay(...a) }));
const mockSendTemplate = jest.fn();
const mockLoadTemplate = jest.fn();
jest.mock('../services/email-template-library', () => ({
  sendTemplate: (...a) => mockSendTemplate(...a),
  loadTemplateByKey: (...a) => mockLoadTemplate(...a),
}));

// The billing email authority: models what the real one does around the
// handoff — runs the caller's preSendCheck on ITS transaction, then dispatches.
const MOCK_TRX = { isTransaction: true, tag: 'authority-trx' };
const mockLoadContext = jest.fn();
const mockBlocked = (code, reason, { retryable = false } = {}) => ({
  sent: false, provider: 'email', providerMessageId: null, deliveryOutcome: 'not_sent', blocked: true, code, reason,
  ...(retryable ? { retryable: true } : {}),
});
jest.mock('../services/billing-channel-email-authority', () => ({
  blocked: (...a) => mockBlocked(...a),
  loadBillingEmailContext: (...a) => mockLoadContext(...a),
  dispatchUnderBillingEmailAuthority: jest.fn(async ({ preSendCheck, dispatch, state }) => {
    const verdict = await preSendCheck({ channel: 'email', database: MOCK_TRX, providerBoundary: false });
    if (verdict?.ok !== true) {
      state.boundaryBlock = mockBlocked(verdict.code, verdict.reason, { retryable: verdict.retryable === true });
      return { ok: false };
    }
    state.handoffStarted = true;
    await dispatch(MOCK_TRX, async () => ({ ok: true }));
    state.providerAccepted = true;
    return { ok: true };
  }),
}));
jest.mock('../utils/customer-comms-lock', () => ({
  withCustomerCommsLock: jest.fn(async (_db, _id, fn) => fn(MOCK_TRX)),
}));
jest.mock('../services/billing-email-reservation', () => ({ repairAcceptedBillingEmailReservations: jest.fn(async () => new Set()) }));

// In-memory collections_contact_ledger.
const mockLedger = [];
jest.mock('../services/collections/contact-ledger', () => {
  const merge = (row, extra) => { row.metadata = { ...(row.metadata || {}), ...extra }; };
  return {
    recordContact: jest.fn(async ({ customerId, channel, purpose, invoiceIds = [], source, metadata = null, occurredAt = new Date(), idempotencyKey = null }) => {
      const existing = idempotencyKey && mockLedger.find((r) => r.idempotency_key === idempotencyKey);
      if (existing) return { id: existing.id, metadata: { ...existing.metadata }, reused: true, occurred_at: existing.occurred_at };
      const row = {
        id: `led-${mockLedger.length + 1}`, customer_id: customerId, channel, purpose, invoice_ids: [...invoiceIds],
        occurred_at: occurredAt, source, metadata: { ...(metadata || {}) }, idempotency_key: idempotencyKey,
      };
      mockLedger.push(row);
      return { id: row.id, metadata: { ...row.metadata } };
    }),
    claimAttempt: jest.fn(async (entry, refresh = null) => {
      if (entry.metadata?.delivered === true) return { allowed: false, delivered: true };
      if (entry.metadata?.resolved === true) return { allowed: false, resolved: true };
      if (!entry.reused) return { allowed: true };
      const row = mockLedger.find((r) => r.id === entry.id);
      if (row.metadata.send_failed !== true) return { allowed: false, held: true };
      const snap = { ...(refresh?.metadata || {}) };
      ['delivered', 'resolved', 'resolution', 'send_failed'].forEach((k) => delete snap[k]);
      merge(row, { ...snap, send_failed: false });
      if (Array.isArray(refresh?.invoiceIds)) row.invoice_ids = [...refresh.invoiceIds];
      return { allowed: true };
    }),
    markDelivered: jest.fn(async (entry, { occurredAt } = {}) => {
      const row = mockLedger.find((r) => r.id === entry.id);
      merge(row, { delivered: true });
      if (occurredAt) row.occurred_at = occurredAt;
      return true;
    }),
    markSendFailed: jest.fn(async (entry, extra = {}) => {
      merge(mockLedger.find((r) => r.id === entry.id), { send_failed: true, ...extra });
      return true;
    }),
  };
});
jest.mock('../models/db', () => {
  const fake = jest.fn((table) => {
    fake.tables.push(table);
    let target = null;
    const chain = {
      where(cond) { if (cond && cond.id) target = cond.id; return chain; },
      whereIn() { return chain; },
      whereRaw() { return chain; },
      update: async (patch) => {
        // the only ledger UPDATE this engine issues itself: clearing a stale never_contacted stamp
        if (table === 'collections_contact_ledger' && String(patch?.metadata?.__raw || '').includes("- 'never_contacted'")) {
          const row = mockLedger.find((r) => r.id === target);
          if (row) delete row.metadata.never_contacted;
        }
        return 1;
      },
      first: async () => undefined,
      then: (resolve) => resolve(table === 'collections_contact_ledger' ? mockLedger : []),
    };
    return chain;
  });
  fake.tables = [];
  fake.raw = jest.fn((sql) => ({ __raw: sql }));
  fake.fn = { now: () => 'now' };
  return fake;
});

const mockPolicy = jest.fn();
jest.mock('../services/collections/rail-guard', () => ({ collectionsChannelPermitted: (...a) => mockPolicy(...a) }));

const mockResolve = jest.fn();
const mockApplyCredit = jest.fn();
jest.mock('../services/customer-dunning/balance-set', () => ({
  resolveDunnableSet: (...a) => mockResolve(...a),
  applyCreditBeforeResolve: (...a) => mockApplyCredit(...a),
}));
const mockReverse = jest.fn();
jest.mock('../services/customer-credit', () => ({ reverseAppliedCredit: (...a) => mockReverse(...a) }));
const mockNotify = jest.fn(async () => ({}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));

// The schedule store: pure cadence/classification functions stay REAL; every
// writer is a spy (its SQL has its own PostgreSQL suite).
jest.mock('../services/customer-dunning/schedule', () => {
  const actual = jest.requireActual('../services/customer-dunning/schedule');
  return {
    ...actual,
    claim: jest.fn(), releaseClaim: jest.fn(), activeMemberRows: jest.fn(), advance: jest.fn(), completeFinal: jest.fn(),
    close: jest.fn(), markHeld: jest.fn(), markPaused: jest.fn(), markTold: jest.fn(), markAutopayHold: jest.fn(),
    writeStage: jest.fn(), alertStaff: jest.fn(), promotionCandidates: jest.fn(),
    inReadOnlyTransaction: jest.fn(async (database, fn) => fn(database)),
  };
});

const Followups = require('../services/invoice-followups');
const Schedule = require('../services/customer-dunning/schedule');
const Runner = require('../services/customer-dunning/runner');
const Boundary = require('../services/customer-dunning/boundary');
const smsTemplates = require('../routes/admin-sms-templates');
const ContactLedger = require('../services/collections/contact-ledger');

const NOW = new Date('2026-10-06T14:16:00Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (d) => new Date(NOW.getTime() - d * DAY);
const CUSTOMER_ID = 'cust-0000-synthetic';
const SCHEDULE_ID = 'sched-0000-synthetic';

let customer;
let prefs;
let fakeDb;
let interactions;
let live;      // the set the "pay page" resolves right now
let schedule;
let memberSeqRows;
let smsTemplateRow;

const invoiceCents = { 'inv-a': 12900, 'inv-b': 12900, 'inv-c': 12900 };
function makeSet(ids = ['inv-a', 'inv-b', 'inv-c'], over = {}) {
  const members = ids.map((id) => ({ invoice_id: id, cents: invoiceCents[id] || 12900, seqStatus: 'active', quiet: false }));
  return {
    kind: ids.length >= 2 ? 'multi' : 'single', reason: null,
    anchor: { id: ids[0], token: `tok-${ids[0]}`, invoice_number: 'W-1', title: 'Quarterly Pest', service_date: '2026-08-01', due_date: '2026-08-15' },
    members, totalCents: members.reduce((s, m) => s + m.cents, 0), digest: `dig-${ids.join('+')}-${members.reduce((s, m) => s + m.cents, 0)}`,
    activeCount: members.length, excluded: { stopped: [], md: [] }, ...over,
  };
}

function rowsFor(ids, sentDaysAgo = 60, stepIndex = 4) {
  return ids.map((id, i) => ({
    id: `seq-${id}`, invoice_id: id, customer_id: CUSTOMER_ID, status: 'active', step_index: stepIndex, touches_sent: stepIndex,
    invoice_sent_at: ago(sentDaysAgo - i), next_touch_at: ago(0), last_touch_at: null,
  }));
}

function setup({ stepIndex = 4, sentDaysAgo = 60, ids = ['inv-a', 'inv-b', 'inv-c'] } = {}) {
  customer = { id: CUSTOMER_ID, first_name: 'Pat', email: 'pat@example.test', phone: '+19415550100', deleted_at: null };
  prefs = undefined; // legacy: no explicit billing channels
  smsTemplateRow = { is_active: true };
  interactions = [];
  fakeDb = jest.fn((table) => {
    const q = { insertedRow: null };
    q.where = () => q;
    q.first = async () => (table === 'customers' ? customer : table === 'notification_prefs' ? prefs : table === 'sms_templates' ? smsTemplateRow : undefined);
    q.insert = async (row) => { if (table === 'customer_interactions') interactions.push(row); };
    return q;
  });
  schedule = {
    id: SCHEDULE_ID, customer_id: CUSTOMER_ID, episode: 1, status: 'active', step_index: stepIndex,
    next_touch_at: ago(0), touches_sent: stepIndex, held_since: null, hold_alerted_at: null, link_digest: null, link_url: null,
  };
  memberSeqRows = rowsFor(ids, sentDaysAgo, stepIndex);
  live = makeSet(ids);
  Schedule.claim.mockResolvedValue({ schedule: { ...schedule }, claimStamp: NOW, memberSeqIds: [] });
  Schedule.activeMemberRows.mockImplementation(async () => memberSeqRows);
  Schedule.advance.mockResolvedValue(true);
  Schedule.completeFinal.mockResolvedValue({ completed: true, landed: [] });
  Schedule.close.mockResolvedValue({ closed: true, landed: [] });
  Schedule.markHeld.mockResolvedValue(true);
  Schedule.markPaused.mockResolvedValue(true);
  Schedule.markTold.mockResolvedValue(true);
  Schedule.markAutopayHold.mockResolvedValue(true);
  Schedule.writeStage.mockResolvedValue(true);
  mockResolve.mockImplementation(async () => live);
}

// Rails: SMS accepted unless a test overrides it; boundary hooks run the way
// the real sender runs them (pre-dispatch with { channel }, pre-send with a
// database only on the legs that hold a transaction).
function acceptingSms(overrides = {}) {
  mockSendMessage.mockImplementation(async (input) => {
    const pre = await input.preDispatchCheck({ channel: input.channel });
    if (pre?.ok !== true) return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: pre.code, retryable: pre.retryable === true };
    const send = await input.preSendCheck({ channel: input.channel, ...(input.channel === 'push' ? { database: MOCK_TRX } : {}) });
    if (send?.ok !== true) return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: send.code, retryable: send.retryable === true };
    return { sent: true, blocked: false, deliveryOutcome: 'accepted', ...overrides };
  });
}
function acceptingEmail() {
  mockSendTemplate.mockImplementation(async ({ withProviderHandoff }) => {
    let dispatched = false;
    await withProviderHandoff(async () => { dispatched = true; });
    return dispatched ? { sent: true, message: { id: 'em-1' } } : { sent: false, blocked: true, reason: 'aborted_by_caller_before_dispatch' };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLedger.length = 0;
  process.env.GATE_DUNNING_LADDER_90 = 'true';
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
  setup();
  mockApplyCredit.mockResolvedValue([]);
  mockOnAutopay.mockResolvedValue(false);
  mockPolicy.mockResolvedValue({ allowed: true });
  mockLoadContext.mockResolvedValue({ recipient: { name: 'Pat Q', email: 'pat@example.test' }, recipientEmail: 'pat@example.test' });
  smsTemplates.getTemplate.mockImplementation(async (key, vars) => `SMS[${key}] ${vars.invoice_count || ''} ${vars.total_due || vars.amount || ''} ${vars.pay_url}`);
  mockLoadTemplate.mockResolvedValue({ template: { status: 'active' }, activeVersion: { id: 'v1' } });
  acceptingSms();
  acceptingEmail();
  mockShorten.mockClear();
});
afterAll(() => { delete process.env.GATE_DUNNING_LADDER_90; });

const run = (opts = {}) => Runner.processSchedule(SCHEDULE_ID, NOW, { database: fakeDb, ...opts });
const ledgerKeys = () => mockLedger.map((r) => r.idempotency_key);
const rowFor = (channel) => mockLedger.find((r) => r.channel === channel);

describe('happy path: one touch, one advance', () => {
  test('multi at Day 60: one email + one text through keyed reservations, one advance, one interaction row, at-risk not stamped without the gate pair', async () => {
    const out = await run();
    expect(out.outcome).toBe('advanced');
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendTemplate.mock.calls[0][0]).toMatchObject({
      templateKey: 'invoice.followup_combined_60_day',
      payload: { invoice_count: '3', total_due: '$387.00', first_name: 'Pat' },
      recipientType: 'customer', suppressionGroupKey: 'transactional_required',
    });
    expect(mockSendMessage.mock.calls[0][0].body).toContain('SMS[invoice_followup_combined_60day] 3 387.00');
    expect(Schedule.advance).toHaveBeenCalledTimes(1);
    expect(interactions).toHaveLength(1);
    expect(interactions[0].interaction_type).toBe('sms_outbound');
    expect(Schedule.releaseClaim).toHaveBeenCalledTimes(1);
  });

  test('claim refused (not due / in flight): nothing runs', async () => {
    Schedule.claim.mockResolvedValue(null);
    expect((await run()).outcome).toBe('skipped');
    expect(mockResolve).not.toHaveBeenCalled();
    expect(Schedule.releaseClaim).not.toHaveBeenCalled();
  });

  test('the claim is always released, even when the send throws', async () => {
    mockResolve.mockRejectedValue(new Error('boom'));
    await expect(run()).rejects.toThrow('boom');
    expect(Schedule.releaseClaim).toHaveBeenCalledTimes(1);
  });
});

describe('recover first (B-10, B-12, B-20, A-8)', () => {
  const seedDelivered = (channels, { occurredAt = ago(0.1) } = {}) => {
    const key = `customer-dunning:${SCHEDULE_ID}:1:d60_reminder`;
    for (const channel of channels) {
      mockLedger.push({
        id: `pre-${channel}`, customer_id: CUSTOMER_ID, channel, source: 'invoice_followups_customer', occurred_at: occurredAt,
        invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: `k-${channel}`,
        metadata: { notificationEventKey: key, delivered: true, selectedChannels: ['email', 'sms'] },
      });
    }
  };

  test('B-10/B-12/A-8: both legs already delivered (a crash before the advance): advance with the ORIGINAL delivery time; no render, no set read, no send, no interaction row', async () => {
    seedDelivered(['email', 'sms'], { occurredAt: ago(0.25) });
    const out = await run();
    expect(out).toMatchObject({ outcome: 'advanced', recovered: true });
    expect(Schedule.advance.mock.calls[0][1].deliveredAt).toEqual(ago(0.25));
    expect(mockResolve).not.toHaveBeenCalled();
    expect(mockApplyCredit).not.toHaveBeenCalled();
    expect(smsTemplates.getTemplate).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockShorten).not.toHaveBeenCalled();
    expect(interactions).toHaveLength(0);
  });

  test('B-20: recovery does not depend on the current set read (it would fail / hold) — it is never reached', async () => {
    seedDelivered(['email', 'sms']);
    mockResolve.mockRejectedValue(new Error('pay page unreadable'));
    expect((await run()).outcome).toBe('advanced');
  });

  test('B-7 settle: one leg delivered, the pending leg is still owed, but the NEXT stage has arrived: settle and advance without sending', async () => {
    // Anchor old enough that Day 90 (the step after Day 60) has arrived.
    setup({ stepIndex: 4, sentDaysAgo: 95 });
    seedDelivered(['email'], { occurredAt: ago(3) });
    const out = await run();
    expect(out).toMatchObject({ outcome: 'advanced', recovered: true });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('B-7 pending leg: one leg delivered, next stage NOT yet due: only the pending leg is sent (the delivered leg is never re-sent)', async () => {
    seedDelivered(['email']);
    const out = await run();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(out.outcome).toBe('advanced');
  });

  test('a transient failure reading delivery progress holds the schedule; it never re-routes to a fresh send', async () => {
    const db = require('../models/db');
    db.mockImplementationOnce(() => { throw new Error('ledger down'); }); // reminderProgress' ledger read
    const out = await run();
    expect(out).toMatchObject({ outcome: 'held', reason: 'progress_unreadable' });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(Schedule.advance).not.toHaveBeenCalled();
  });
});

describe('keyed reservations and key lengths (B-19, A-4, B-17)', () => {
  test('B-19: a LEGACY customer (no explicit billing channels) still gets a keyed reservation per channel that can recover the set', async () => {
    prefs = undefined;
    await run();
    expect(ledgerKeys()).toHaveLength(2);
    for (const key of ledgerKeys()) expect(key).toMatch(/^billing-reminder:[0-9a-f]{64}:(email|sms)$/);
    expect(mockLedger.every((r) => r.metadata.notificationEventKey === `customer-dunning:${SCHEDULE_ID}:1:d60_reminder`)).toBe(true);
    expect(rowFor('email').invoice_ids).toEqual(['inv-a', 'inv-b', 'inv-c']);
    expect(rowFor('email').metadata).toMatchObject({ variant: 'multi', total_cents: 38700, set_digest: live.digest, anchor_invoice_id: 'inv-a' });
  });

  test('A-4: every key is fixed-length no matter how many invoices the set names (ledger <= 120, email idempotency <= 120, trigger event id <= 260)', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `inv-${String(i).padStart(3, '0')}`);
    setup({ ids });
    await run();
    for (const key of ledgerKeys()) expect(key.length).toBeLessThanOrEqual(120);
    const call = mockSendTemplate.mock.calls[0][0];
    expect(call.idempotencyKey.length).toBeLessThanOrEqual(120);
    expect(call.triggerEventId.length).toBeLessThanOrEqual(260);
    expect(call.idempotencyKey).toBe(`customer_dunning_email:${SCHEDULE_ID}:1:d60_reminder`);
    expect(call.triggerEventId).toBe(`customer_dunning:${SCHEDULE_ID}:1:d60_reminder`);
  });

  test('B-17/B-19: delivery evidence stays bound to the touch: the set changes between the email and the retry — the email is never re-sent, identity is unchanged', async () => {
    mockSendMessage.mockResolvedValueOnce({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, code: 'OUTSIDE_SEND_WINDOW', deferred: true });
    await run(); // tick 1: email delivered, text held (quiet hours)
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    live = makeSet(['inv-a', 'inv-c']); // tick 2: invoice B was paid, set is now A+C
    acceptingSms();
    await run();
    expect(mockSendTemplate).toHaveBeenCalledTimes(1); // the delivered email leg dedupes on the reservation
    expect(ledgerKeys()).toHaveLength(2); // still exactly one reservation per channel
    expect(mockLedger.filter((r) => r.channel === 'sms')[0].invoice_ids).toEqual(['inv-a', 'inv-c']); // re-quoted snapshot on the retried leg
  });
});

describe('the boundary check at every rail (A-1, A-6, A-12, A-13, B-15, B-16, A-17)', () => {
  // The live set the pay page resolves AFTER the message was rendered, per
  // change of state named in the catalogue.
  const original = () => makeSet(['inv-a', 'inv-b', 'inv-c']);
  const CHANGES = [
    ['A-12 paid', () => makeSet(['inv-a', 'inv-b'])],
    ['A-12 processing', () => makeSet(['inv-a', 'inv-b'])],
    ['A-12 void', () => makeSet(['inv-a', 'inv-c'])],
    ['A-12 draft', () => makeSet(['inv-b', 'inv-c'], { digest: 'other' })],
    ['A-6 credit applied (cents change)', () => makeSet(['inv-a', 'inv-b', 'inv-c'], { totalCents: 30000, digest: 'dig-credit' })],
    ['A-13 new live PaymentIntent drops a member', () => makeSet(['inv-a', 'inv-b'])],
    ['B-16 payer statement', () => makeSet(['inv-a'], { kind: 'hold', reason: 'payer_anchor' })],
    ['A-1 third-party payer', () => makeSet(['inv-a'], { kind: 'hold', reason: 'payer_anchor' })],
    ['A-13 dunning stop', () => makeSet(['inv-a', 'inv-b'])],
    ['B-15 pause', () => makeSet(['inv-a', 'inv-b', 'inv-c'], { kind: 'hold', reason: 'member_paused' })],
    ['B-15 autopay hold', () => makeSet(['inv-a', 'inv-b', 'inv-c'], { kind: 'hold', reason: 'member_autopay_hold' })],
    ['customer merge (set empties)', () => ({ kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null })],
  ];
  const snapshot = () => Boundary.snapshotOf(CUSTOMER_ID, original());

  test('control: an unchanged set passes on all three rails', async () => {
    mockResolve.mockResolvedValue(original());
    const check = Boundary.check(snapshot());
    expect(await check({})).toEqual({ ok: true });
    expect(await check({ database: MOCK_TRX })).toEqual({ ok: true });
  });

  test.each(CHANGES)('%s: DUNNING_SET_CHANGED (retryable) at SMS preDispatchCheck, push preSendCheck({database}) and email preSendCheck({database: trx})', async (_name, liveSet) => {
    mockResolve.mockResolvedValue(liveSet());
    const check = Boundary.check(snapshot());
    for (const args of [{ channel: 'sms' }, { channel: 'push', database: MOCK_TRX }, { channel: 'email', database: MOCK_TRX }]) {
      expect(await check(args)).toMatchObject({ ok: false, code: 'DUNNING_SET_CHANGED', retryable: true });
    }
  });

  test('a throw while re-resolving is the same retryable refusal (never a send)', async () => {
    mockResolve.mockRejectedValue(new Error('stripe timeout'));
    expect(await Boundary.check(snapshot())({})).toMatchObject({ ok: false, code: 'DUNNING_SET_CHANGED', retryable: true });
  });

  test('A-17: the email/push boundary reads on the handed handle; the SMS hook (no transaction held) reads through the pool', async () => {
    mockResolve.mockResolvedValue(original());
    const check = Boundary.check(snapshot());
    await check({ database: MOCK_TRX });
    expect(mockResolve).toHaveBeenLastCalledWith(CUSTOMER_ID, { database: MOCK_TRX });
    await check({});
    expect(mockResolve.mock.calls.at(-1)[1].database).not.toBe(MOCK_TRX);
  });

  test('email leg: the set changes after render — the authority hook refuses, NO email goes out, the runner re-renders ONCE, then holds (never a partial send)', async () => {
    let calls = 0;
    // 1: initial resolve. 2..: boundary + re-resolve all see a NEW set each time.
    mockResolve.mockImplementation(async () => {
      calls += 1;
      return calls === 1 ? live : makeSet(['inv-a', 'inv-b'], { totalCents: 20000 + calls, digest: `changed-${calls}` });
    });
    const out = await run();
    expect(out).toMatchObject({ outcome: 'held' });
    expect(mockSendTemplate.mock.calls.every(([a]) => a.payload)).toBe(true);
    // every attempt's dispatch was vetoed: nothing accepted
    expect(mockLedger.some((r) => r.metadata.delivered === true)).toBe(false);
    expect(Schedule.advance).not.toHaveBeenCalled();
    expect(Schedule.markHeld).toHaveBeenCalledTimes(1);
    // second attempt only: at most two send attempts per leg in one tick
    expect(mockSendTemplate.mock.calls.length).toBeLessThanOrEqual(2);
  });

  test('a change seen at the boundary that settles by the re-render sends the NEW set once (one re-render)', async () => {
    let calls = 0;
    const changed = makeSet(['inv-a', 'inv-b']);
    mockResolve.mockImplementation(async () => {
      calls += 1;
      if (calls === 1) return live;      // initial
      if (calls <= 3) return changed;    // 2 = SMS boundary read, 3 = email boundary read (mismatch vs original snapshot)
      return changed;                    // re-resolve and its boundary reads see the stable changed set
    });
    const out = await run();
    expect(out.outcome).toBe('advanced');
    const payload = mockSendTemplate.mock.calls.at(-1)[0].payload;
    expect(payload.invoice_count).toBe('2');
  });
});

describe('credit before the reminder, reversed if nothing delivered (B-1, D9)', () => {
  test('credit is applied BEFORE the set is resolved, so the total is net of credit', async () => {
    const order = [];
    mockApplyCredit.mockImplementation(async () => { order.push('credit'); return [{ invoiceId: 'inv-a', amount: 25 }]; });
    mockResolve.mockImplementation(async () => { order.push('resolve'); return live; });
    await run();
    expect(order.slice(0, 2)).toEqual(['credit', 'resolve']);
    expect(mockReverse).not.toHaveBeenCalled(); // delivered => the draw stands
  });

  test('nothing delivered => this run\'s draw is reversed', async () => {
    mockApplyCredit.mockResolvedValue([{ invoiceId: 'inv-a', amount: 25 }]);
    mockSendMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, code: 'OUTSIDE_SEND_WINDOW' });
    mockSendTemplate.mockResolvedValue({ sent: false, blocked: true, reason: 'x' });
    const out = await run();
    expect(out.outcome).toBe('held');
    expect(mockReverse).toHaveBeenCalledWith({ invoiceId: 'inv-a', amount: 25, createdBy: 'system:dun_undelivered' });
  });

  test('a hold from the set (paused member) also reverses the draw', async () => {
    mockApplyCredit.mockResolvedValue([{ invoiceId: 'inv-b', amount: 10 }]);
    live = makeSet(['inv-a', 'inv-b'], { kind: 'hold', reason: 'member_paused' });
    expect(await run()).toMatchObject({ outcome: 'held', reason: 'member_paused' });
    expect(mockReverse).toHaveBeenCalledTimes(1);
  });

  test('an account-credit failure never blocks the reminder', async () => {
    mockApplyCredit.mockRejectedValue(new Error('credit down'));
    expect((await run()).outcome).toBe('advanced');
  });
});

describe('policy and disposition (A-7, A-10, A-15, B-7, terminal paths)', () => {
  test('A-10: balanceIncomplete on any leg holds the WHOLE touch — no leg is sent, no reservation is written', async () => {
    mockPolicy.mockResolvedValue({ allowed: true, balanceIncomplete: 'payer read failed' });
    const out = await run();
    expect(out).toMatchObject({ outcome: 'held', reason: 'COLLECTIONS_POLICY' });
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockLedger).toHaveLength(0);
  });

  test('B-11: the policy is consulted per leg with the EXACT set the message names', async () => {
    await run();
    for (const [args] of mockPolicy.mock.calls) {
      expect(args).toMatchObject({ customerId: CUSTOMER_ID, purpose: 'late_payment', source: 'invoice_followups_customer', invoiceIds: ['inv-a', 'inv-b', 'inv-c'], detail: true });
    }
  });

  test('A-7/A-15: every leg policy-denied => HELD (retimed by markHeld to the next-day floor), never left due, never stale-skipped', async () => {
    mockPolicy.mockResolvedValue({ allowed: false, durable: false });
    const out = await run();
    expect(out).toMatchObject({ outcome: 'held', reason: 'COLLECTIONS_POLICY' });
    expect(Schedule.markHeld).toHaveBeenCalledWith(expect.objectContaining({ id: SCHEDULE_ID }), 'COLLECTIONS_POLICY', expect.objectContaining({ claimStamp: NOW }));
    expect(Schedule.advance).not.toHaveBeenCalled();
    expect(Schedule.writeStage).not.toHaveBeenCalled();
    expect(Schedule.markPaused).not.toHaveBeenCalled();
  });

  test('B-7: a partial delivery (email delivered, text held) counts as TOLD: last_touch stamped, step not advanced, one interaction row, credit kept', async () => {
    mockApplyCredit.mockResolvedValue([{ invoiceId: 'inv-a', amount: 5 }]);
    mockSendMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, code: 'OUTSIDE_SEND_WINDOW', deferred: true });
    const out = await run();
    expect(out.outcome).toBe('told');
    expect(Schedule.markTold).toHaveBeenCalledTimes(1);
    expect(Schedule.markTold.mock.calls[0][1].deliveredAt).toBeInstanceOf(Date);
    expect(Schedule.advance).not.toHaveBeenCalled();
    expect(interactions).toHaveLength(1);
    expect(interactions[0].interaction_type).toBe('email_outbound');
    expect(mockReverse).not.toHaveBeenCalled();
  });

  test('every leg terminal (email suppressed, no phone) => PAUSED with the reason and an alert path; nothing delivered, credit reversed', async () => {
    customer.phone = null;
    mockApplyCredit.mockResolvedValue([{ invoiceId: 'inv-a', amount: 5 }]);
    mockLoadContext.mockResolvedValue({ error: mockBlocked('NO_EMAIL_RECIPIENT', 'No billing email recipient is available') });
    const out = await run();
    expect(out).toMatchObject({ outcome: 'paused', reason: 'all_channels_terminal' });
    expect(Schedule.markPaused).toHaveBeenCalledWith(expect.anything(), 'all_channels_terminal', expect.anything());
    expect(mockReverse).toHaveBeenCalledTimes(1);
  });

  test('no reachable channel: explicit text-only choice and no phone => paused, nothing reserved', async () => {
    prefs = { invoice_channels: ['sms'] };
    customer.phone = null;
    expect(await run()).toMatchObject({ outcome: 'paused', reason: 'no_reachable_channel' });
    expect(mockLedger).toHaveLength(0);
  });

  test('template probe: an inactive email template drops that channel BEFORE any reservation (never another template)', async () => {
    mockLoadTemplate.mockResolvedValue({ template: { status: 'draft' }, activeVersion: { id: 'v' } });
    const out = await run();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockLedger.map((r) => r.channel)).toEqual(['sms']); // only the text leg was reserved
    expect(out.outcome).toBe('advanced');
  });

  test('template probe: an SMS template switched off drops the text leg; both off => paused no_reachable_channel and the draw is reversed', async () => {
    smsTemplateRow = { is_active: false };
    await run();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockLedger.map((r) => r.channel)).toEqual(['email']);
    mockLedger.length = 0;
    mockApplyCredit.mockResolvedValue([{ invoiceId: 'inv-a', amount: 5 }]);
    mockLoadTemplate.mockResolvedValue({ template: { status: 'disabled' }, activeVersion: { id: 'v' } });
    expect(await run()).toMatchObject({ outcome: 'paused', reason: 'no_reachable_channel' });
    expect(mockLedger).toHaveLength(0);
    expect(mockReverse).toHaveBeenCalledTimes(1);
  });

  test('autopay customer: schedule goes autopay_hold (next touch cleared), nothing is sent; unreadable autopay state holds', async () => {
    mockOnAutopay.mockResolvedValue(true);
    expect((await run()).outcome).toBe('autopay_hold');
    expect(Schedule.markAutopayHold).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).not.toHaveBeenCalled();
    mockOnAutopay.mockRejectedValue(new Error('down'));
    expect(await run()).toMatchObject({ outcome: 'held', reason: 'autopay_unreadable' });
  });

  test('missing customer closes the schedule (customer_missing); a deleted one pauses it', async () => {
    customer = undefined;
    expect((await run()).outcome).toBe('closed');
    expect(Schedule.close).toHaveBeenCalledWith(expect.anything(), 'customer_missing', NOW, expect.anything());
    customer = { id: CUSTOMER_ID, deleted_at: new Date(), phone: '+1' };
    expect(await run()).toMatchObject({ outcome: 'paused', reason: 'customer_deleted' });
  });

  test('a set that is EMPTY closes the schedule (balance_cleared) and reverses the draw; no send', async () => {
    mockApplyCredit.mockResolvedValue([{ invoiceId: 'inv-a', amount: 5 }]);
    live = { kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null, activeCount: 0 };
    expect(await run()).toMatchObject({ outcome: 'closed', reason: 'balance_cleared' });
    expect(Schedule.close).toHaveBeenCalledWith(expect.anything(), 'balance_cleared', NOW, expect.anything());
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockReverse).toHaveBeenCalledTimes(1);
  });

  test('a set with only quiet members (no cadence driver) closes with no_active_member', async () => {
    live = makeSet(['inv-a', 'inv-b'], { activeCount: 0 });
    expect(await run()).toMatchObject({ outcome: 'closed', reason: 'no_active_member' });
  });

  test('a set-level hold (payer unresolved) holds with that reason; a paused member holds and is an office hold', async () => {
    live = makeSet(['inv-a'], { kind: 'hold', reason: 'payer_unresolved' });
    expect(await run()).toMatchObject({ outcome: 'held', reason: 'payer_unresolved' });
  });
});

describe('stage catch-up: the final step is never passed over (A-7 family)', () => {
  test('a schedule behind the calendar catches up to the latest arrived stage (logged, no interaction row) and sends THAT stage', async () => {
    setup({ stepIndex: 2, sentDaysAgo: 65 });
    const out = await run();
    expect(Schedule.writeStage).toHaveBeenCalledWith(expect.objectContaining({ id: SCHEDULE_ID }), 4, expect.anything());
    expect(mockSendTemplate.mock.calls[0][0].templateKey).toBe('invoice.followup_combined_60_day');
    expect(out.outcome).toBe('advanced');
  });

  test('the cap is the FINAL step: however old the debt, stage never exceeds it, and at the final step nothing is skipped', async () => {
    setup({ stepIndex: 1, sentDaysAgo: 400 });
    await run();
    expect(Schedule.writeStage).toHaveBeenCalledWith(expect.anything(), 5, expect.anything());
    expect(mockSendTemplate.mock.calls[0][0].templateKey).toBe('invoice.followup_combined_90_day');
    const S = require('../services/customer-dunning/schedule');
    expect(S.stageFor(new Date('2020-01-01'), NOW, 0)).toBe(5);
    expect(S.stageFor(new Date('2020-01-01'), NOW, 5)).toBe(5);
  });

  test('an invalid step index (cadence unavailable) releases the schedule instead of throwing', async () => {
    setup({ stepIndex: 9 });
    expect(await run()).toMatchObject({ outcome: 'closed', reason: 'no_step' });
    expect(Schedule.close).toHaveBeenCalledWith(expect.anything(), 'released_prereq_off', NOW, expect.anything());
  });
});

describe('mint once, after policy and claim, cached by digest (B-6, B-13, B-4)', () => {
  test('B-13: a leg the policy denies never mints a short link', async () => {
    mockPolicy.mockResolvedValue({ allowed: false });
    await run();
    expect(mockShorten).not.toHaveBeenCalled();
  });

  test('B-13: a reservation that cannot be claimed (unconfirmed prior attempt) never mints', async () => {
    await run(); // tick 1 writes reservations, delivered
    mockShorten.mockClear();
    for (const r of mockLedger) { r.metadata.delivered = false; r.metadata.send_failed = false; } // ambiguous reused reservation
    Schedule.claim.mockResolvedValue({ schedule: { ...schedule }, claimStamp: NOW, memberSeqIds: [] });
    await run();
    expect(mockShorten).not.toHaveBeenCalled();
  });

  test('B-6: ONE mint serves both legs of a touch (a single code for the anchor only)', async () => {
    await run();
    expect(mockShorten).toHaveBeenCalledTimes(1);
    expect(mockShorten.mock.calls[0][0]).toBe('https://portal.example.test/pay/tok-inv-a');
    expect(mockShorten.mock.calls[0][1]).toMatchObject({ entityId: 'inv-a', customerId: CUSTOMER_ID, purpose: 'customer_dunning', channel: 'sms' });
  });

  test('B-6: a cached link for the SAME digest is reused (retry), no mint', async () => {
    Schedule.claim.mockResolvedValue({ schedule: { ...schedule, link_digest: live.digest, link_url: 'https://short.example.test/cached' }, claimStamp: NOW, memberSeqIds: [] });
    await run();
    expect(mockShorten).not.toHaveBeenCalled();
    expect(mockSendMessage.mock.calls[0][0].body).toContain('https://short.example.test/cached');
  });

  test('B-6/B-13: a digest change mints once more (for the new set) and the old code is simply unused', async () => {
    Schedule.claim.mockResolvedValue({ schedule: { ...schedule, link_digest: 'old-digest', link_url: 'https://short.example.test/old' }, claimStamp: NOW, memberSeqIds: [] });
    await run();
    expect(mockShorten).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0][0].body).not.toContain('/old');
  });

  test('B-4: combined copy is never queued for a later replay — a quiet-hours block leaves the leg held for a FRESH render next tick (no sms_log write)', async () => {
    const db = require('../models/db');
    mockSendMessage.mockResolvedValueOnce({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, deferred: true, code: 'OUTSIDE_SEND_WINDOW', nextAllowedAt: '2026-10-07T12:00:00Z' });
    const t1 = await run();
    expect(t1.outcome).toBe('told');
    expect(db.tables).not.toContain('sms_log');
    expect(fakeDb.mock.calls.map(([t]) => t)).not.toContain('sms_log');
    // tick 2: the total moved; the body is rendered from the CURRENT set
    live = makeSet(['inv-a', 'inv-b']);
    smsTemplates.getTemplate.mockClear();
    await run();
    const vars = smsTemplates.getTemplate.mock.calls.at(-1)[1];
    expect(vars).toMatchObject({ invoice_count: '2', total_due: '258.00' });
  });
});

describe('interaction rows and audit fidelity (A-9, B-18, A-14, A-11)', () => {
  test('A-9: a push-only customer is recorded as app_outbound, not sms_outbound', async () => {
    prefs = { invoice_channels: ['push'] };
    await run();
    expect(mockSendMessage.mock.calls[0][0]).toMatchObject({ channel: 'push', to: null });
    expect(mockSendMessage.mock.calls[0][0].metadata).toMatchObject({ appOnly: true, billingDeliveryLeg: 'push' });
    expect(interactions[0].interaction_type).toBe('app_outbound');
  });

  test('B-18: a leg delivered on an EARLIER attempt (recovered) still labels the interaction sms_outbound when the email delivers now', async () => {
    const key = `customer-dunning:${SCHEDULE_ID}:1:d60_reminder`;
    mockLedger.push({ id: 'pre-sms', customer_id: CUSTOMER_ID, channel: 'sms', source: 'invoice_followups_customer', occurred_at: ago(0.2), invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: 'k-sms', metadata: { notificationEventKey: key, delivered: true } });
    await run();
    expect(interactions).toHaveLength(1);
    expect(interactions[0].interaction_type).toBe('sms_outbound');
    expect(mockSendMessage).not.toHaveBeenCalled(); // the recovered leg is not re-sent
  });

  test('A-14: the audit row carries the amounts that were QUOTED (the reservation snapshot), never a later read', async () => {
    await run();
    const meta = JSON.parse(interactions[0].metadata);
    // the row equals the snapshot the reservation itself recorded
    expect(meta.total_cents).toBe(rowFor('sms').metadata.total_cents);
    expect(meta.quoted).toEqual(rowFor('sms').metadata.quoted);
    expect(meta).toMatchObject({ schedule_id: SCHEDULE_ID, episode: 1, step_id: 'd60_reminder', variant: 'multi', total_cents: 38700 });
    expect(meta.quoted).toEqual([{ invoice_id: 'inv-a', cents: 12900 }, { invoice_id: 'inv-b', cents: 12900 }, { invoice_id: 'inv-c', cents: 12900 }]);
    expect(interactions[0].body).toContain('$387.00');
  });

  test('A-8: a deduped/recovered retry writes NO interaction row (covered above) and a fresh delivery writes exactly one', async () => {
    await run();
    expect(interactions).toHaveLength(1);
  });

  test('A-11: an email on DEFAULT channels refused before the provider keeps never_contacted; an EXPLICIT selection does not; the flag is cleared on the next attempt', async () => {
    mockLoadContext.mockResolvedValueOnce({ error: mockBlocked('BILLING_EMAIL_RECHECK_FAILED', 'x', { retryable: true }) });
    await run();
    expect(rowFor('email').metadata.never_contacted).toBe(true);
    // explicit selection: same refusal, no flag
    mockLedger.length = 0;
    prefs = { invoice_channels: ['email', 'sms'] };
    mockLoadContext.mockResolvedValueOnce({ error: mockBlocked('BILLING_EMAIL_RECHECK_FAILED', 'x', { retryable: true }) });
    await run();
    expect(rowFor('email').metadata.never_contacted).toBeUndefined();
    // default channels again, the retry attempt clears the stamp before it sends
    mockLedger.length = 0; prefs = undefined;
    mockLoadContext.mockResolvedValueOnce({ error: mockBlocked('BILLING_EMAIL_RECHECK_FAILED', 'x', { retryable: true }) });
    await run();
    expect(rowFor('email').metadata.never_contacted).toBe(true);
    await run();
    expect(rowFor('email').metadata.never_contacted).toBeUndefined();
    expect(rowFor('email').metadata.delivered).toBe(true);
  });
});

describe('final notice, D2/D4/D5/D11', () => {
  test('D2: the final notice (step d90) completes exactly the invoices the reservation named, via completeFinal (not advance)', async () => {
    setup({ stepIndex: 5, sentDaysAgo: 95 });
    live = makeSet(['inv-a', 'inv-b']); // inv-c is microdeposit-pending: excluded, so NOT named
    live.excluded.md = ['inv-c'];
    const out = await run();
    expect(out.outcome).toBe('completed');
    expect(Schedule.advance).not.toHaveBeenCalled();
    expect(Schedule.completeFinal).toHaveBeenCalledTimes(1);
    expect(Schedule.completeFinal.mock.calls[0][1].namedInvoiceIds.sort()).toEqual(['inv-a', 'inv-b']);
    expect(mockSendTemplate.mock.calls[0][0].templateKey).toBe('invoice.followup_combined_90_day');
    expect(mockSendMessage.mock.calls[0][0].body).toContain('invoice_followup_combined_90day');
  });

  test('D2: a recovered final notice completes the ids on the DELIVERED reservation, not a fresh read', async () => {
    setup({ stepIndex: 5, sentDaysAgo: 95 });
    const key = `customer-dunning:${SCHEDULE_ID}:1:d90_final_notice`;
    for (const channel of ['email', 'sms']) {
      mockLedger.push({ id: `p-${channel}`, customer_id: CUSTOMER_ID, channel, source: 'invoice_followups_customer', occurred_at: ago(0.1), invoice_ids: ['inv-a', 'inv-c'], idempotency_key: `k-${channel}`, metadata: { notificationEventKey: key, delivered: true } });
    }
    await run();
    expect(Schedule.completeFinal.mock.calls[0][1].namedInvoiceIds.sort()).toEqual(['inv-a', 'inv-c']);
    expect(mockResolve).not.toHaveBeenCalled();
  });

  test('a failed final notice alerts at once (paused on the final step) — markPaused carries the alert', async () => {
    setup({ stepIndex: 5, sentDaysAgo: 95 });
    mockLoadContext.mockResolvedValue({ error: mockBlocked('NO_EMAIL_RECIPIENT', 'none') });
    customer.phone = null;
    expect((await run()).outcome).toBe('paused');
    expect(Schedule.markPaused.mock.calls[0][0].step_index).toBe(5);
  });

  test('at-risk stamp: Day 60/90 under the gate pair only, on an advance', async () => {
    const spy = jest.spyOn(Followups, 'markAtRiskForLongOverdue').mockResolvedValue();
    await run();
    expect(spy).not.toHaveBeenCalled(); // GATE_BALANCE_REMINDER_LEGACY_OFF unset
    process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
    mockLedger.length = 0;
    await run();
    expect(spy).toHaveBeenCalledWith(CUSTOMER_ID);
    spy.mockRestore();
  });

  test('D4: a NEW invoice going overdue mid-episode joins the next reminder at the CURRENT stage (no reset)', async () => {
    setup({ stepIndex: 2, sentDaysAgo: 20, ids: ['inv-a', 'inv-b', 'inv-c'] });
    live = makeSet(['inv-a', 'inv-b', 'inv-c']); // inv-c is brand new (its own row is at step 0, frozen)
    await run();
    expect(mockSendTemplate.mock.calls[0][0].templateKey).toBe('invoice.followup_combined_17_day');
    expect(mockSendTemplate.mock.calls[0][0].payload.invoice_count).toBe('3');
    expect(Schedule.advance.mock.calls[0][0].step_index).toBe(2);
  });

  test('D5/single: when the set drops to ONE invoice the message uses the single-invoice template at the schedule\'s stage', async () => {
    live = makeSet(['inv-a']);
    await run();
    expect(mockSendTemplate.mock.calls[0][0].templateKey).toBe('invoice.followup_60_day');
    expect(mockSendTemplate.mock.calls[0][0].payload).toMatchObject({ invoice_title: 'Quarterly Pest', invoice_number: 'W-1', amount_due: '$129.00' });
    expect(smsTemplates.getTemplate.mock.calls[0][0]).toBe('invoice_followup_60day');
    expect(smsTemplates.getTemplate.mock.calls[0][1]).toMatchObject({ amount: '129.00', invoice_title: 'Quarterly Pest' });
  });

  test('D1/D7: the combined SMS and email copy pass count + the page total, never a per-invoice list', async () => {
    await run();
    const vars = smsTemplates.getTemplate.mock.calls[0][1];
    expect(Object.keys(vars).sort()).toEqual(['first_name', 'invoice_count', 'pay_url', 'total_due']);
    expect(Object.keys(mockSendTemplate.mock.calls[0][0].payload).sort()).toEqual(['customer_portal_url', 'first_name', 'invoice_count', 'pay_url', 'total_due']);
  });
});

describe('operator send-now', () => {
  test('operatorInitiated uses [email, sms], skips prefs, and the email handoff runs the boundary in a customer-comms transaction (no billing authority)', async () => {
    const auth = require('../services/billing-channel-email-authority');
    prefs = { invoice_channels: ['sms'] }; // an explicit text-only choice: the operator send ignores it
    const out = await run({ operatorInitiated: true, force: true });
    expect(out.outcome).toBe('advanced');
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(auth.dispatchUnderBillingEmailAuthority).not.toHaveBeenCalled();
    expect(mockSendMessage.mock.calls[0][0].operatorInitiated).toBe(true);
    expect(Schedule.claim).toHaveBeenCalledWith(SCHEDULE_ID, NOW, expect.objectContaining({ force: true }));
  });

  test('the operator email handoff refuses (no email) when the set changed, on the comms-lock transaction handle', async () => {
    let n = 0;
    mockResolve.mockImplementation(async () => { n += 1; return n === 1 ? live : makeSet(['inv-a'], { totalCents: 5, digest: `x${n}` }); });
    await run({ operatorInitiated: true, force: true });
    expect(mockLedger.some((r) => r.channel === 'email' && r.metadata.delivered === true)).toBe(false);
    expect(mockResolve.mock.calls.some(([, opts]) => opts?.database === MOCK_TRX)).toBe(true);
  });
});

describe('runCustomerSchedules: one failure never stops the rest', () => {
  test('processes every due schedule and tallies failures', async () => {
    const db = jest.fn(() => ({
      whereIn() { return this; }, where() { return this; }, orderBy() { return this; },
      select: async () => [{ id: 's1', customer_id: 'c1' }, { id: 's2', customer_id: 'c2' }],
    }));
    Schedule.claim.mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce(null);
    const out = await Runner.runCustomerSchedules(NOW, { database: db });
    expect(out.failed).toBe(1);
    expect(out.processed).toBe(1);
  });
});

describe('shadow run writes NOTHING and only logs (PR 2 wiring)', () => {
  const logger = require('../services/logger');
  const shadowLines = () => logger.info.mock.calls.map(([m]) => m).filter((m) => String(m).includes('SHADOW would'));

  test('spy on every writer: no claim/advance/close/mint/reservation/send/credit/alert/insert/update — and the structured lines are logged', async () => {
    Schedule.promotionCandidates.mockResolvedValue([CUSTOMER_ID]);
    const writes = [];
    const database = jest.fn((table) => {
      const q = {
        where() { return q; }, whereIn() { return q; },
        insert: (...a) => { writes.push(['insert', table, a]); return q; },
        update: (...a) => { writes.push(['update', table, a]); return q; },
        del: (...a) => { writes.push(['del', table, a]); return q; },
        then: (resolve) => resolve(table === 'customer_dunning_schedules' ? [{ ...schedule, id: SCHEDULE_ID, status: 'active', step_index: 4 }] : []),
      };
      return q;
    });
    live = makeSet(['inv-a', 'inv-b', 'inv-c']);
    memberSeqRows = rowsFor(['inv-a', 'inv-b', 'inv-c'], 60, 3);
    await Runner.shadowRun(NOW, { database });
    const lines = shadowLines().join('\n');
    expect(lines).toMatch(/SHADOW would promote customer=cust-0000-synthetic/);
    expect(lines).toMatch(/SHADOW would absorb customer=cust-0000-synthetic seq=seq-inv-/);
    expect(lines).toMatch(/SHADOW would send customer=cust-0000-synthetic/);
    for (const writer of ['claim', 'releaseClaim', 'advance', 'completeFinal', 'close', 'markHeld', 'markPaused', 'markTold', 'markAutopayHold', 'writeStage', 'alertStaff']) {
      expect(Schedule[writer]).not.toHaveBeenCalled();
    }
    expect(writes).toEqual([]);
    expect(mockApplyCredit).not.toHaveBeenCalled();
    expect(mockShorten).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockReverse).not.toHaveBeenCalled();
    expect(interactions).toEqual([]);
  });

  test('a customer whose set is held / a schedule that would close are logged as would hold / would close', async () => {
    Schedule.promotionCandidates.mockResolvedValue([CUSTOMER_ID]);
    live = makeSet(['inv-a', 'inv-b'], { kind: 'hold', reason: 'member_paused' });
    const database = jest.fn((table) => { const q = { where() { return q; }, whereIn() { return q; }, then: (r) => r(table === 'customer_dunning_schedules' ? [{ id: 's1', customer_id: CUSTOMER_ID, step_index: 4 }] : []) }; return q; });
    await Runner.shadowRun(NOW, { database });
    expect(shadowLines().join('\n')).toMatch(/would hold customer=cust-0000-synthetic reason=member_paused/);
    logger.info.mockClear();
    live = { kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null, activeCount: 0 };
    await Runner.shadowRun(NOW, { database });
    expect(shadowLines().join('\n')).toMatch(/would close customer=cust-0000-synthetic/);
  });

  test('a failing customer is logged and does not stop the rest; the run never throws', async () => {
    Schedule.promotionCandidates.mockResolvedValue(['c1', 'c2']);
    mockResolve.mockRejectedValueOnce(new Error('stripe down')).mockResolvedValueOnce(makeSet(['inv-a', 'inv-b']));
    memberSeqRows = rowsFor(['inv-a', 'inv-b'], 60, 3);
    const database = jest.fn(() => { const q = { where() { return q; }, whereIn() { return q; }, then: (r) => r([]) }; return q; });
    const tally = await Runner.shadowRun(NOW, { database });
    expect(tally.failed).toBe(1);
    expect(tally.promote).toBe(1);
  });
});
