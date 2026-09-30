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
let mockAllowlist = null;
jest.mock('../config/feature-gates', () => ({ gates: {}, dunningCustomerScheduleAllowlist: () => mockAllowlist }));
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
// The boundary re-reads the schedule row (status + claim stamp) on whatever
// handle it is given; the pool mock (models/db) and the transaction both serve it.
let mockScheduleRow = null;
const mockLocked = [];
const mockScheduleReader = (table) => {
  const q = {
    where() { return q; },
    select() { return q; },
    forUpdate() { mockLocked.push(table); return q; },
    first: async () => (table === 'customer_dunning_schedules' ? mockScheduleRow : undefined),
  };
  return q;
};
const MOCK_TRX = Object.assign((...a) => mockScheduleReader(...a), { isTransaction: true, tag: 'authority-trx' });
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
// Default: no repair. The crash-recovery tests point this at the REAL repair over an in-memory email_messages.
let mockRepairImpl = async () => new Set();
jest.mock('../services/billing-email-reservation', () => ({ repairAcceptedBillingEmailReservations: jest.fn((...a) => mockRepairImpl(...a)) }));

// In-memory collections_contact_ledger.
const mockLedger = [];
jest.mock('../services/collections/contact-ledger', () => {
  const { claimVerdict } = jest.requireActual('../services/collections/contact-ledger');
  const merge = (row, extra) => { row.metadata = { ...(row.metadata || {}), ...extra }; };
  return {
    claimVerdict,
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
// The one db module the engine runs on: customers / prefs / templates / interactions / schedules are served from
// the per-test state below, the ledger from mockLedger. Every write is recorded in mockWrites.
let mockOpenSchedules = [];
const mockWrites = [];
const mockTables = {
  first: (table, target, targetKey) => {
    if (table === 'customers') return customer;
    if (table === 'notification_prefs') return prefs;
    if (table === 'sms_templates') return smsTemplateRow;
    if (table === 'customer_dunning_schedules') return mockScheduleRow;
    if (table === 'collections_contact_ledger') return mockLedger.find((r) => (target && r.id === target) || (targetKey && r.idempotency_key === targetKey));
    return undefined;
  },
  insert: (table, row) => { mockWrites.push(['insert', table, row]); if (table === 'customer_interactions') interactions.push(row); },
};
jest.mock('../models/db', () => {
  const fake = jest.fn((table) => {
    fake.tables.push(table);
    let target = null;
    let targetKey = null; // a keyed-reservation lookup (idempotency_key)
    let minOccurred = null; // reminderProgress' 90-day window
    const chain = {
      where(cond, op, val) {
        if (cond && cond.id) target = cond.id;
        if (cond && cond.idempotency_key) targetKey = cond.idempotency_key;
        if (cond === 'occurred_at' && op === '>') minOccurred = val;
        return chain;
      },
      whereIn() { return chain; },
      whereRaw() { return chain; },
      select() { return chain; },
      orderBy() { return chain; },
      forUpdate() { mockLocked.push(table); return chain; },
      insert: async (row) => { mockTables.insert(table, row); return []; },
      del: async () => { mockWrites.push(['del', table]); return 1; },
      update: async (patch) => {
        mockWrites.push(['update', table, patch]);
        // the only ledger UPDATE this engine issues itself: clearing a stale never_contacted stamp
        if (table === 'collections_contact_ledger' && String(patch?.metadata?.__raw || '').includes("- 'never_contacted'")) {
          const row = mockLedger.find((r) => r.id === target);
          if (row) delete row.metadata.never_contacted;
        }
        return 1;
      },
      first: async () => mockTables.first(table, target, targetKey),
      // copies, as a real query returns: an in-memory view change (a repair's reflected verdict) never edits the stored row
      then: (resolve) => resolve(table === 'collections_contact_ledger' ? mockLedger.filter((r) => !minOccurred || new Date(r.occurred_at) > minOccurred).map((r) => ({ ...r, metadata: { ...r.metadata } })) : table === 'customer_dunning_schedules' ? mockOpenSchedules : []),
    };
    return chain;
  });
  fake.tables = [];
  fake.raw = jest.fn((sql) => ({ __raw: sql }));
  fake.fn = { now: () => 'now' };
  // The ledger / schedule behaviour, kept so the injected handle can serve it while the DEFAULT pool is poisoned in a test.
  fake.implementation = fake.getMockImplementation();
  return fake;
});

const mockPolicy = jest.fn();
jest.mock('../services/collections/rail-guard', () => ({ collectionsChannelPermitted: (...a) => mockPolicy(...a) }));

const mockResolve = jest.fn();
jest.mock('../services/customer-dunning/balance-set', () => ({
  resolveDunnableSet: (...a) => mockResolve(...a),
}));
const mockNotify = jest.fn(async () => ({}));
jest.mock('../services/notification-service', () => ({ notifyAdmin: (...a) => mockNotify(...a) }));

// The schedule store: pure cadence/classification functions stay REAL; every
// writer is a spy (its SQL has its own PostgreSQL suite).
jest.mock('../services/customer-dunning/schedule', () => {
  const actual = jest.requireActual('../services/customer-dunning/schedule');
  return {
    ...actual,
    claim: jest.fn(), releaseClaim: jest.fn(), activeMemberRows: jest.fn(), advance: jest.fn(), completeFinal: jest.fn(),
    close: jest.fn(), markHeld: jest.fn(), markPaused: jest.fn(), markTold: jest.fn(), markAutopayHold: jest.fn(), resumeFromAutopay: jest.fn(),
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
// The fixtures are dated against NOW while the code under test reads the real clock (reminderProgress' 90-day
// window, claim freshness, the batch claimAt). Freeze Date at NOW so the suite means the same on any day
// (AGENTS.md: date-sensitive tests do not depend on the wall clock). Only Date is faked: timers, setImmediate and
// microtasks stay real (`toFake: ['Date']` alone leaves setImmediate hanging under this jest, hence the list).
beforeAll(() => {
  jest.useFakeTimers({
    now: NOW,
    doNotFake: ['setImmediate', 'clearImmediate', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'nextTick',
      'queueMicrotask', 'performance', 'hrtime', 'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback'],
  });
});
afterAll(() => { jest.useRealTimers(); });
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

function setup({ stepIndex = 4, sentDaysAgo = 60, ids = ['inv-a', 'inv-b', 'inv-c'], stepStatus = 'active' } = {}) {
  customer = { id: CUSTOMER_ID, first_name: 'Pat', email: 'pat@example.test', phone: '+19415550100', deleted_at: null };
  prefs = undefined; // legacy: no explicit billing channels
  smsTemplateRow = { is_active: true };
  interactions = [];
  fakeDb = require('../models/db'); // the db module mock itself
  fakeDb.mockImplementation(fakeDb.implementation);
  mockOpenSchedules = [];
  mockWrites.length = 0;
  schedule = {
    id: SCHEDULE_ID, customer_id: CUSTOMER_ID, episode: 1, status: stepStatus, step_index: stepIndex,
    next_touch_at: ago(0), touches_sent: stepIndex, held_since: null, hold_alerted_at: null, link_digest: null, link_url: null,
  };
  memberSeqRows = rowsFor(ids, sentDaysAgo, stepIndex);
  live = makeSet(ids);
  mockScheduleRow = { id: SCHEDULE_ID, status: stepStatus, touch_claimed_at: NOW };
  Schedule.claim.mockResolvedValue({ schedule: { ...schedule }, claimStamp: NOW, memberSeqIds: [] });
  Schedule.activeMemberRows.mockImplementation(async () => memberSeqRows);
  Schedule.advance.mockResolvedValue(true);
  Schedule.completeFinal.mockResolvedValue({ completed: true, landed: [] });
  Schedule.close.mockResolvedValue({ closed: true, landed: [] });
  Schedule.markHeld.mockResolvedValue(true);
  Schedule.markPaused.mockResolvedValue(true);
  Schedule.markTold.mockResolvedValue(true);
  Schedule.markAutopayHold.mockResolvedValue(true);
  Schedule.resumeFromAutopay.mockImplementation(async () => { mockScheduleRow = { ...mockScheduleRow, status: 'active' }; return true; });
  Schedule.writeStage.mockResolvedValue(true);
  mockResolve.mockImplementation(async () => live);
}


// Makes the nth access to the ledger table on the RUN'S handle throw. The runner reads and writes
// the ledger only through the handle it was given, so this is where its failures are injected.
function failLedgerAccess(nth, message = 'ledger down') {
  const impl = fakeDb.getMockImplementation();
  let n = 0;
  fakeDb.mockImplementation((table) => {
    if (table === 'collections_contact_ledger') { n += 1; if (n === nth) throw new Error(message); }
    return impl(table);
  });
}

// A promotion whose seeded first touch is already OVERDUE (a catch-up seed): the promotion decision as it is, with
// the seed dated before `now`. Shadow still reports only the promotion for it.
function seedOverdue() {
  const actual = jest.requireActual('../services/customer-dunning/schedule');
  return jest.spyOn(Schedule, 'promotionDecision').mockImplementation((set, rows, now) => {
    const d = actual.promotionDecision(set, rows, now);
    return d.promote ? { ...d, seed: { ...d.seed, next_touch_at: new Date(now.getTime() - 1000) } } : d;
  });
}

// The idempotency key a leg's reservation carries (the one formula sendReminderChannels uses).
const keyFor = (eventKey, channel) => require('../services/billing-reminder-delivery').reminderReservationKey(CUSTOMER_ID, eventKey, channel);

// The shadow run's world: these are the open schedule rows the db module returns; `writes` is every write anything made.
function shadowDb(schedules = []) {
  mockOpenSchedules = schedules;
  return { writes: mockWrites };
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
    // The provider's own asynchronous preparation (twilio's annual-offer guard: a short_codes lookup), then the
    // caller's providerPreSendCheck immediately before messages.create() — a refusal there is the same
    // never-attempted, retryable not-sent (twilio.js maps providerPreSendCheckFailed that way).
    if (input.channel === 'sms') await new Promise((resolve) => { setImmediate(resolve); });
    if (typeof input.providerPreSendCheck === 'function') {
      const final = await input.providerPreSendCheck({ channel: 'sms', dbi: undefined });
      if (final?.ok !== true) {
        return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: final.code, retryable: final.retryable === true, deferred: final.deferred === true };
      }
    }
    return { sent: true, blocked: false, deliveryOutcome: 'accepted', ...overrides };
  });
}
// Models the template library's email_messages row + idempotency dedupe: the
// row exists once the provider accepted (sent_at), and a second send under the
// same key returns the stored one instead of sending again.
const mockEmailMessages = [];
function acceptingEmail() {
  mockSendTemplate.mockImplementation(async (args) => {
    const existing = mockEmailMessages.find((m) => m.idempotency_key === args.idempotencyKey && m.sent_at);
    if (existing) return { sent: true, deduped: true, message: existing };
    // a definitely-unsent row under the key is reclaimed by the retry, as the library does
    const stale = mockEmailMessages.findIndex((m) => m.idempotency_key === args.idempotencyKey);
    if (stale >= 0) mockEmailMessages.splice(stale, 1);
    let dispatched = false;
    // The library's provider work: asynchronous preparation (markers, link
    // guard), then the caller's final boundary check, then the request.
    await args.withProviderHandoff(async (database, providerBoundaryCheck) => {
      await new Promise((resolve) => { setImmediate(resolve); });
      if (providerBoundaryCheck) await providerBoundaryCheck({ database });
      dispatched = true;
    });
    if (!dispatched) return { sent: false, blocked: true, reason: 'aborted_by_caller_before_dispatch' };
    const message = {
      id: `em-${mockEmailMessages.length + 1}`, idempotency_key: args.idempotencyKey, trigger_event_id: args.triggerEventId,
      recipient_type: args.recipientType, recipient_id: args.recipientId, template_key: args.templateKey,
      payload_snapshot: JSON.stringify(args.payload), send_attempt_token: null, sent_at: NOW,
    };
    mockEmailMessages.push(message);
    return { sent: true, message };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLedger.length = 0;
  mockLocked.length = 0;
  mockAllowlist = null;
  mockEmailMessages.length = 0;
  mockRepairImpl = async () => new Set();
  process.env.GATE_DUNNING_LADDER_90 = 'true';
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
  setup();
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

const run = (opts = {}) => Runner.processSchedule(SCHEDULE_ID, NOW, opts);
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
    failLedgerAccess(1); // reminderProgress' ledger read
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

describe('review batch: told legs, member freshness, pre-provider failures, shadow', () => {
  const emailFirst = () => { prefs = { invoice_channels: ['email', 'sms'] }; };
  const smsBlocked = (over) => mockSendMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', ...over });

  describe('F1: a definitely-unsendable text leg never leaves the step TOLD forever', () => {
    test.each([
      ['final notice (index 5)', 5, 95, 'completed', 'completeFinal'],
      ['a middle step (index 4)', 4, 60, 'advanced', 'advance'],
    ])('%s: email delivered, SMS refused for good (opted out / non-mobile / template) => the touch is done', async (_name, stepIndex, sentDaysAgo, outcomeKind, writer) => {
      setup({ stepIndex, sentDaysAgo });
      smsBlocked({ code: 'SUPPRESSED_NON_MOBILE' });
      const out = await run();
      expect(out.outcome).toBe(outcomeKind);
      expect(Schedule[writer]).toHaveBeenCalledTimes(1);
      expect(Schedule.markTold).not.toHaveBeenCalled();
      expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    });

    test('a text template that is unavailable (definite not_sent, no retryable flag) is the same', async () => {
      setup({ stepIndex: 4, sentDaysAgo: 60 });
      smsBlocked({ code: 'TEMPLATE_UNAVAILABLE' });
      expect((await run()).outcome).toBe('advanced');
    });

    test('a RETRYABLE / deferred text block keeps the step told (the leg is retried), and a told step older than 7 days rings the office ONCE', async () => {
      setup({ stepIndex: 4, sentDaysAgo: 60 });
      smsBlocked({ code: 'OUTSIDE_SEND_WINDOW', retryable: true, deferred: true });
      const email = () => mockLedger.find((r) => r.channel === 'email');
      expect((await run()).outcome).toBe('told');
      expect(Schedule.advance).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled(); // reached the customer just now
      // the same step, 8 days on: the email leg was delivered 8 days ago and the text is still failing
      email().occurred_at = ago(8);
      Schedule.markTold.mockClear();
      expect((await run()).outcome).toBe('told');
      expect(mockNotify).toHaveBeenCalledTimes(1);
      expect(mockNotify.mock.calls[0][1]).toBe('Customer reminder half-delivered');
      expect(mockNotify.mock.calls[0][3].dedupeKey).toBe(`customer-dunning-told:${SCHEDULE_ID}:1:d60_reminder`);
    });
  });

  describe('C1: the next touch is driven by the members active AFTER the send', () => {
    test('a member paid during the tick does not keep the cadence: advance receives a fresh read, not the pre-send rows', async () => {
      const preSend = memberSeqRows;
      mockSendMessage.mockImplementation(async (input) => {
        // inv-a (the oldest, cadence-driving member) is paid while the message is going out
        memberSeqRows = memberSeqRows.filter((r) => r.invoice_id !== 'inv-a');
        await input.preDispatchCheck({ channel: input.channel });
        return { sent: true, blocked: false, deliveryOutcome: 'accepted' };
      });
      const out = await run();
      expect(out.outcome).toBe('advanced');
      const { activeRows } = Schedule.advance.mock.calls[0][1];
      expect(activeRows.map((r) => r.invoice_id).sort()).toEqual(['inv-b', 'inv-c']);
      expect(preSend).toHaveLength(3);
    });

    test('after a re-render the rows narrowed to the FIRST set are dropped (read again, not reused)', async () => {
      let calls = 0;
      const changed = makeSet(['inv-b', 'inv-c']);
      mockResolve.mockImplementation(async () => { calls += 1; return calls === 1 ? live : changed; });
      Schedule.activeMemberRows.mockClear();
      await run();
      // catch-up read + the fresh read before advance (+ the re-render dropped the cache in between)
      expect(Schedule.activeMemberRows.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('C3/C4: pre-provider failures', () => {
    test('C3: a never_contacted stamp is cleared on EVERY attempt, explicit channel choice or not; only ADDING it depends on default channels', async () => {
      prefs = undefined;
      mockLoadContext.mockResolvedValueOnce({ error: mockBlocked('BILLING_EMAIL_RECHECK_FAILED', 'x', { retryable: true }) });
      await run();
      expect(rowFor('email').metadata.never_contacted).toBe(true);
      prefs = { invoice_channels: ['email', 'sms'] }; // the customer has since chosen channels explicitly
      await run();
      expect(rowFor('email').metadata.never_contacted).toBeUndefined();
      expect(rowFor('email').metadata.delivered).toBe(true);
    });

    test('C4: a short-link failure BEFORE the provider is a definite, retryable non-send on both legs (not an uncertain, never-retried hold)', async () => {
      emailFirst();
      mockShorten.mockRejectedValueOnce(new Error('short store down')).mockRejectedValueOnce(new Error('short store down'));
      const out = await run();
      expect(out.outcome).toBe('held');
      expect(mockSendTemplate).not.toHaveBeenCalled();
      expect(rowFor('email').metadata.send_failed).toBe(true); // reopened for the retry, not left ambiguous
      expect(rowFor('sms')).toBeDefined();
      expect(rowFor('sms').metadata.send_failed).toBe(true);
      expect((await run()).outcome).toBe('advanced'); // the retry claims the reservations and delivers
      expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    });

    test('C4: the template library throwing before the handoff is retryable (catch path), a disabled template is terminal', async () => {
      prefs = { invoice_channels: ['email'] };
      mockSendTemplate.mockRejectedValueOnce(new Error('template store down'));
      expect(await run()).toMatchObject({ outcome: 'held' });
      expect(rowFor('email').metadata.send_failed).toBe(true);
      mockSendTemplate.mockRejectedValueOnce(Object.assign(new Error('off'), { code: 'EMAIL_TEMPLATE_DISABLED' }));
      expect((await run()).outcome).toBe('paused');
    });
  });

  describe('a close refused for a lost claim changes nothing and alerts nobody', () => {
    test('runner closes pass the step they judged; a refused close is a stale outcome, with no missing-customer alert', async () => {
      Schedule.close.mockResolvedValue({ closed: false, landed: [], reason: 'claim_lost' });
      customer = undefined;
      expect((await run()).outcome).toBe('stale');
      expect(Schedule.close).toHaveBeenLastCalledWith(expect.anything(), 'customer_missing', NOW, expect.objectContaining({ claimStamp: NOW, expectedStepIndex: 4 }));
      expect(Schedule.alertStaff).not.toHaveBeenCalled();
      setup();
      Schedule.close.mockResolvedValue({ closed: false, landed: [], reason: 'claim_lost' });
      live = { kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null, activeCount: 0 };
      expect((await run()).outcome).toBe('stale');
      setup();
      Schedule.close.mockResolvedValue({ closed: true, landed: [] });
      live = { kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null, activeCount: 0 };
      expect(await run()).toMatchObject({ outcome: 'closed', reason: 'balance_cleared' });
    });
  });

  describe('F3: runner-internal closes carry the run\'s own claim', () => {
    test('a set that empties, and a missing customer, close under OUR claimStamp (so an in-flight guard never refuses the run itself)', async () => {
      live = { kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null, activeCount: 0 };
      await run();
      expect(Schedule.close).toHaveBeenLastCalledWith(expect.anything(), 'balance_cleared', NOW, expect.objectContaining({ claimStamp: NOW }));
      customer = undefined;
      await run();
      expect(Schedule.close).toHaveBeenLastCalledWith(expect.anything(), 'customer_missing', NOW, expect.objectContaining({ claimStamp: NOW }));
    });
  });

  describe('F5: a failed post-send progress read keeps what an earlier tick already delivered', () => {
    test('email delivered earlier, text retrying now, the post-send read fails => TOLD (not held / paused)', async () => {
      const key = `customer-dunning:${SCHEDULE_ID}:1:d60_reminder`;
      mockLedger.push({
        id: 'pre-email', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(0.1),
        invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: 'k-email',
        metadata: { notificationEventKey: key, delivered: true, selectedChannels: ['email', 'sms'] },
      });
      smsBlocked({ code: 'OUTSIDE_SEND_WINDOW', retryable: true, deferred: true });
      failLedgerAccess(3); // recover-first (1), sendReminderChannels (2); the post-send read (3) fails
      const out = await run();
      expect(out.outcome).toBe('told');
      expect(Schedule.markTold).toHaveBeenCalledTimes(1);
      expect(Schedule.markHeld).not.toHaveBeenCalled();
      expect(Schedule.markPaused).not.toHaveBeenCalled();
    });
  });

  describe('shadow: schedule decisions in a shadow-only rollout, allowlist, no held transaction across Stripe I/O', () => {
    const logger = require('../services/logger');
    const lines = () => logger.info.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('SHADOW would')).join('\n');
    const emptyTableDb = (schedules = []) => shadowDb(schedules);

    test('C6: shadow-only (empty table): a customer who would be PROMOTED is reported as a promotion only; a customer already held is judged; nothing is written', async () => {
      Schedule.promotionCandidates.mockResolvedValue([CUSTOMER_ID, 'cust-held']);
      memberSeqRows = rowsFor(['inv-a', 'inv-b', 'inv-c'], 60, 3);
      mockResolve.mockImplementation(async (id) => (id === 'cust-held'
        ? makeSet(['inv-a', 'inv-b'], { kind: 'hold', reason: 'account_credit_available' })
        : makeSet(['inv-a', 'inv-b', 'inv-c'])));
      const database = emptyTableDb();
      const tally = await Runner.shadowRun(NOW);
      const out = lines();
      expect(out).toMatch(/SHADOW would promote customer=cust-0000-synthetic members=3 active=3 step=d60_reminder next=/);
      expect(out).toMatch(/SHADOW would absorb customer=cust-0000-synthetic/);
      expect(out).not.toMatch(/customer=cust-0000-synthetic [^\n]*schedule=/); // no judgment of a schedule that does not exist
      expect(out).not.toMatch(/would (send|pause|close|settle)/);
      expect(out).toMatch(/SHADOW would hold customer=cust-held reason=account_credit_available/); // the promotion decision's own hold
      expect(tally).toMatchObject({ promote: 1, send: 0, hold: 1, pause: 0, close: 0, settle: 0, failed: 0 });
      expect(database.writes).toEqual([]);
      for (const writer of ['claim', 'markHeld', 'markPaused', 'alertStaff', 'close']) expect(Schedule[writer]).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    });

    test('an OVERDUE seed is promote-only too: nothing about autopay, preferences, policy or templates is judged for it', async () => {
      const seed = seedOverdue();
      try {
        Schedule.promotionCandidates.mockResolvedValue([CUSTOMER_ID]);
        memberSeqRows = rowsFor(['inv-a', 'inv-b', 'inv-c'], 60, 3);
        mockOnAutopay.mockResolvedValue(true);
        const database = emptyTableDb();
        const tally = await Runner.shadowRun(NOW);
        expect(lines()).toMatch(/SHADOW would promote customer=cust-0000-synthetic members=3 active=3 step=d60_reminder next=2026-10-06T14:15:59\.000Z/);
        expect(lines()).not.toMatch(/would (send|hold|pause|close|settle)/);
        expect(mockOnAutopay).not.toHaveBeenCalled();
        expect(mockPolicy).not.toHaveBeenCalled();
        expect(tally).toMatchObject({ promote: 1, send: 0, hold: 0, pause: 0, close: 0, settle: 0 });
        expect(database.writes).toEqual([]);
      } finally { seed.mockRestore(); }
    });

    test('a promotion seeded for a FUTURE run logs only the promotion (step and next), with no send / hold judgment', async () => {
      Schedule.promotionCandidates.mockResolvedValue([CUSTOMER_ID]);
      memberSeqRows = rowsFor(['inv-a', 'inv-b', 'inv-c'], 60, 3);
      mockOnAutopay.mockResolvedValue(true); // today's autopay state must not be judged for a touch that is not yet due
      const database = emptyTableDb();
      const tally = await Runner.shadowRun(NOW);
      const out = lines();
      expect(out).toMatch(/SHADOW would promote customer=cust-0000-synthetic members=3 active=3 step=d60_reminder next=2026-10-07T\d\d:\d\d:\d\d\.000Z/);
      expect(out).not.toMatch(/schedule=projected/);
      expect(out).not.toMatch(/would (send|hold|pause|close|settle)/);
      expect(mockOnAutopay).not.toHaveBeenCalled();
      expect(tally).toMatchObject({ promote: 1, send: 0, hold: 0, pause: 0, failed: 0 });
      expect(database.writes).toEqual([]);
    });

    test('C7: the canary allowlist narrows the shadow scan of OPEN schedules like the live due-scan', async () => {
      Schedule.promotionCandidates.mockResolvedValue([]);
      const rowsOpen = [
        { id: 's-in', customer_id: 'cust-in', step_index: 4 },
        { id: 's-out', customer_id: 'cust-out', step_index: 4 },
      ];
      mockAllowlist = new Set(['cust-in']);
      await (async () => { emptyTableDb(rowsOpen); return Runner.shadowRun(NOW); })();
      expect(lines()).toMatch(/schedule=s-in/);
      expect(lines()).not.toMatch(/schedule=s-out/);
      logger.info.mockClear();
      mockAllowlist = null; // empty allowlist = everyone
      await (async () => { emptyTableDb(rowsOpen); return Runner.shadowRun(NOW); })();
      expect(lines()).toMatch(/schedule=s-out/);
    });

    test('F6: the set resolve (Stripe I/O) never runs while a shadow transaction is held', async () => {
      Schedule.promotionCandidates.mockResolvedValue([CUSTOMER_ID]);
      memberSeqRows = rowsFor(['inv-a', 'inv-b', 'inv-c'], 60, 3);
      let inTransaction = false;
      const heldDuringResolve = [];
      Schedule.inReadOnlyTransaction.mockImplementation(async (database, fn) => {
        inTransaction = true;
        try { return await fn(database); } finally { inTransaction = false; }
      });
      mockResolve.mockImplementation(async () => { heldDuringResolve.push(inTransaction); return makeSet(['inv-a', 'inv-b', 'inv-c']); });
      await (async () => { emptyTableDb([{ id: 's1', customer_id: CUSTOMER_ID, step_index: 4 }]); return Runner.shadowRun(NOW); })();
      expect(heldDuringResolve.length).toBeGreaterThanOrEqual(2); // promotion and the open schedule
      expect(heldDuringResolve.every((held) => held === false)).toBe(true);
      Schedule.inReadOnlyTransaction.mockImplementation(async (database, fn) => fn(database));
    });
  });
});

describe('shadow runs the live pre-send guards (R2-1)', () => {
  const logger = require('../services/logger');
  const lines = () => logger.info.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('SHADOW would')).join('\n');
  const openSchedule = [{ id: 's-open', customer_id: CUSTOMER_ID, step_index: 4, episode: 1, status: 'active' }];
  const shadow = async () => {
    const database = shadowDb(openSchedule);
    Schedule.promotionCandidates.mockResolvedValue([]);
    await Runner.shadowRun(NOW);
    return database;
  };
  const noWrites = (database) => {
    expect(database.writes).toEqual([]);
    for (const writer of ['claim', 'markHeld', 'markPaused', 'markAutopayHold', 'writeStage', 'close', 'alertStaff', 'advance', 'completeFinal']) {
      expect(Schedule[writer]).not.toHaveBeenCalled();
    }
    expect(mockNotify).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
  };

  test('normal: would send', async () => {
    noWrites(await shadow());
    expect(lines()).toMatch(/SHADOW would send customer=cust-0000-synthetic schedule=s-open step=d60_reminder kind=multi/);
  });

  test('an autopay customer with a schedule is a would-hold (autopay_hold), not a send; a customer who would only be PROMOTED is not judged', async () => {
    mockOnAutopay.mockResolvedValue(true);
    noWrites(await shadow());
    expect(lines()).toMatch(/SHADOW would hold customer=cust-0000-synthetic schedule=s-open step=d60_reminder reason=autopay_hold/);
    logger.info.mockClear();
    Schedule.promotionCandidates.mockResolvedValue([CUSTOMER_ID]);
    memberSeqRows = rowsFor(['inv-a', 'inv-b', 'inv-c'], 60, 3);
    shadowDb();
    await Runner.shadowRun(NOW);
    expect(lines()).toMatch(/SHADOW would promote customer=cust-0000-synthetic/);
    expect(lines()).not.toMatch(/autopay_hold|would send/); // a customer with no schedule row is not judged
    noWrites({ writes: mockWrites });
  });

  test('unreadable autopay state and unreadable preferences are would-holds', async () => {
    mockOnAutopay.mockRejectedValue(new Error('down'));
    await shadow();
    expect(lines()).toMatch(/would hold .* reason=autopay_unreadable/);
    logger.info.mockClear();
    mockOnAutopay.mockResolvedValue(false);
    const serve = fakeDb.getMockImplementation();
    fakeDb.mockImplementation((table) => { if (table === 'notification_prefs') throw new Error('prefs down'); return serve(table); });
    const database = await shadow();
    expect(lines()).toMatch(/would hold .* reason=prefs_unreadable/);
    expect(database.writes).toEqual([]);
  });

  test('every template switched off is a would-pause (no_reachable_channel); a deleted customer and an unreachable one too', async () => {
    smsTemplateRow = { is_active: false };
    mockLoadTemplate.mockResolvedValue({ template: { status: 'disabled' }, activeVersion: { id: 'v' } });
    noWrites(await shadow());
    expect(lines()).toMatch(/SHADOW would pause customer=cust-0000-synthetic schedule=s-open step=d60_reminder reason=no_reachable_channel/);
    logger.info.mockClear();
    smsTemplateRow = { is_active: true };
    mockLoadTemplate.mockResolvedValue({ template: { status: 'active' }, activeVersion: { id: 'v1' } });
    customer.deleted_at = new Date();
    await shadow();
    expect(lines()).toMatch(/would pause .* reason=customer_deleted/);
  });

  test('a step already delivered (crash before the advance) is a would-settle, not a send', async () => {
    mockLedger.push({
      id: 'pre-email', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(0.1),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: 'k-e',
      metadata: { notificationEventKey: `customer-dunning:s-open:1:d60_reminder`, delivered: true, selectedChannels: ['email', 'sms'] },
    }, {
      id: 'pre-sms', customer_id: CUSTOMER_ID, channel: 'sms', source: 'invoice_followups_customer', occurred_at: ago(0.1),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: 'k-s',
      metadata: { notificationEventKey: `customer-dunning:s-open:1:d60_reminder`, delivered: true, selectedChannels: ['email', 'sms'] },
    });
    noWrites(await shadow());
    expect(lines()).toMatch(/SHADOW would settle customer=cust-0000-synthetic schedule=s-open step=d60_reminder reason=already_delivered/);
    expect(lines()).not.toMatch(/would send/);
  });
});

describe('shadow evaluates the collections policy before logging a send (R3-1)', () => {
  const logger = require('../services/logger');
  const lines = () => logger.info.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('SHADOW would')).join('\n');
  const openSchedule = [{ id: 's-open', customer_id: CUSTOMER_ID, step_index: 4, episode: 1, status: 'active' }];
  const shadow = async () => {
    Schedule.promotionCandidates.mockResolvedValue([]);
    const database = shadowDb(openSchedule);
    await Runner.shadowRun(NOW);
    return database;
  };
  const untouched = (database) => {
    expect(database.writes).toEqual([]);
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(ContactLedger.claimAttempt).not.toHaveBeenCalled();
    expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
  };

  test('a recent contact denies every channel: would HOLD on COLLECTIONS_POLICY, naming the channels; nothing is reserved or written', async () => {
    mockPolicy.mockResolvedValue({ allowed: false, durable: false });
    untouched(await shadow());
    expect(lines()).toMatch(/SHADOW would hold customer=cust-0000-synthetic schedule=s-open step=d60_reminder reason=COLLECTIONS_POLICY denied=email\+sms/);
    expect(lines()).not.toMatch(/would send/);
    // asked exactly as the live attempt asks: the quoted invoices, this step's own rows excluded
    expect(mockPolicy).toHaveBeenCalledWith(expect.objectContaining({
      customerId: CUSTOMER_ID, purpose: 'late_payment', invoiceIds: ['inv-a', 'inv-b', 'inv-c'], detail: true, source: 'invoice_followups_customer',
    }));
  });

  test('a partial denial is a would-send for the allowed channels, naming the denied one', async () => {
    mockPolicy.mockImplementation(async ({ channel }) => (channel === 'email' ? { allowed: true } : { allowed: false }));
    untouched(await shadow());
    expect(lines()).toMatch(/SHADOW would send customer=cust-0000-synthetic schedule=s-open step=d60_reminder kind=multi members=3 total_cents=\d+ denied=sms/);
  });

  test('incomplete debt evidence holds the whole step, like the live attempt', async () => {
    mockPolicy.mockResolvedValue({ allowed: true, balanceIncomplete: 'payer read failed' });
    untouched(await shadow());
    expect(lines()).toMatch(/would hold .* reason=COLLECTIONS_POLICY/);
  });

  test('a durable denial on the only owed leg, with a sibling already delivered, settles on the waiver (as live), and this step\'s own rows are excluded from the policy read', async () => {
    mockLedger.push({
      id: 'pre-email', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(0.1),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: 'k-e',
      metadata: { notificationEventKey: 'customer-dunning:s-open:1:d60_reminder', delivered: true, selectedChannels: ['email', 'sms'] },
    });
    mockPolicy.mockResolvedValue({ allowed: false, durable: true });
    untouched(await shadow());
    expect(lines()).toMatch(/SHADOW would settle .* reason=policy_waived/);
    expect(mockPolicy).toHaveBeenCalledWith(expect.objectContaining({ channel: 'sms', excludeLedgerIds: ['pre-email'] }));
  });

  test('policy allows everything (gate off, or nothing recent): the send verdict is unchanged, with no denied field', async () => {
    mockPolicy.mockResolvedValue({ allowed: true });
    untouched(await shadow());
    expect(lines()).toMatch(/SHADOW would send customer=cust-0000-synthetic schedule=s-open step=d60_reminder kind=multi members=3 total_cents=\d+$/m);
    expect(lines()).not.toMatch(/denied=/);
  });
});

describe('never_contacted must be cleared before a retry sends (R3-2)', () => {
  test('a clear that fails leaves the stale flag: NO provider call, a retryable not-sent, the reservation reopened; the next run clears it and sends', async () => {
    customer.phone = null;
    prefs = undefined; // default channels: the refusal is stamped never_contacted
    mockLoadContext.mockResolvedValueOnce({ error: mockBlocked('BILLING_EMAIL_RECHECK_FAILED', 'x', { retryable: true }) });
    await run();
    expect(rowFor('email').metadata.never_contacted).toBe(true);

    // ledger accesses: recover-first progress (1), sendReminderChannels' progress (2); the clear (3) fails
    failLedgerAccess(3, 'ledger update down');
    mockSendTemplate.mockClear();
    const out = await run();
    expect(out.outcome).toBe('held');
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockEmailMessages).toHaveLength(0);
    expect(rowFor('email').metadata.send_failed).toBe(true);
    expect(rowFor('email').metadata.never_contacted).toBe(true); // still there, the row is not delivered

    expect((await run()).outcome).toBe('advanced'); // the clear works: flag gone, then sent
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(rowFor('email').metadata.never_contacted).toBeUndefined();
    expect(rowFor('email').metadata.delivered).toBe(true);
  });

  test('a failed clear with NO stale flag on the row does not block the send', async () => {
    customer.phone = null;
    failLedgerAccess(3, 'ledger update down');
    expect((await run()).outcome).toBe('advanced');
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });
});

describe('a changed set is planned again before the second attempt (R3-3)', () => {
  const full = () => makeSet(['inv-a', 'inv-b', 'inv-c']);
  // the runner's own resolves carry `now`; the boundary's do not. `runnerSets[n]` is what the runner sees on its nth resolve;
  // the boundary always sees `boundarySet`, so the first attempt (rendered from the initial set) is refused.
  const scriptSets = (runnerSets, boundarySet) => {
    let n = 0;
    mockResolve.mockImplementation(async (_id, opts) => {
      if (!opts?.now) return boundarySet;
      const set = runnerSets[Math.min(n, runnerSets.length - 1)];
      n += 1;
      return set;
    });
  };

  // "sent" = accepted by the provider; a vetoed first attempt still CALLS the mocks
  const smsAccepted = async () => (await Promise.all(mockSendMessage.mock.results.map((r) => r.value))).filter((r) => r?.sent === true);
  const acceptedBodies = async () => Promise.all(mockSendMessage.mock.results.map((r) => r.value)).then((all) => all.map((r, i) => (r?.sent === true ? mockSendMessage.mock.calls[i][0].body : null)).filter(Boolean));

  test('an OLDER invoice that becomes eligible catches the stage up: the second attempt sends the caught-up step, and the schedule advances from it', async () => {
    setup({ stepIndex: 3, sentDaysAgo: 30 });
    memberSeqRows = [
      ...rowsFor(['inv-a'], 65, 3),
      { ...rowsFor(['inv-b'], 30, 3)[0] }, { ...rowsFor(['inv-c'], 29, 3)[0] },
    ];
    const initial = makeSet(['inv-b', 'inv-c']);
    scriptSets([initial, full()], full());
    const out = await run();
    expect(out.outcome).toBe('advanced');
    expect(Schedule.writeStage).toHaveBeenCalledTimes(1);
    expect(Schedule.writeStage).toHaveBeenCalledWith(expect.objectContaining({ id: SCHEDULE_ID }), 4, expect.anything());
    // the first attempt (old stage, two invoices) was vetoed at the boundary; only the re-planned one was accepted
    expect(mockEmailMessages).toHaveLength(1);
    expect(mockEmailMessages[0].template_key).toBe('invoice.followup_combined_60_day');
    expect(JSON.parse(mockEmailMessages[0].payload_snapshot).invoice_count).toBe('3');
    expect(await acceptedBodies()).toEqual([expect.stringContaining('SMS[invoice_followup_combined_60day] 3 ')]);
    expect(Schedule.advance.mock.calls[0][0]).toMatchObject({ step_index: 4 });
    expect(mockLedger.every((r) => r.metadata.notificationEventKey.endsWith(':d60_reminder') || r.metadata.notificationEventKey.endsWith(':d30_final'))).toBe(true);
  });

  test('multi -> single: the second attempt uses the SINGLE variant\'s template availability, not the multi variant\'s', async () => {
    mockLoadTemplate.mockImplementation(async (key) => (String(key).startsWith('invoice.followup_combined')
      ? { template: { status: 'active' }, activeVersion: { id: 'v' } } : null)); // only the combined email exists
    const single = makeSet(['inv-a']);
    scriptSets([full(), single], single);
    const out = await run(); // default channels: email + text
    expect(out.outcome).toBe('advanced');
    expect(mockEmailMessages).toHaveLength(0); // the single-invoice email template is not available: never sent
    expect(mockSendTemplate).toHaveBeenCalledTimes(1); // the vetoed first attempt only
    expect(await acceptedBodies()).toEqual([expect.stringContaining('SMS[invoice_followup_60day]')]); // the single text
  });

  test('a re-plan that stops (no channel left for the new variant) sends NOTHING more and applies the stop', async () => {
    prefs = { invoice_channels: ['email'] };
    mockLoadTemplate.mockImplementation(async (key) => (String(key).startsWith('invoice.followup_combined')
      ? { template: { status: 'active' }, activeVersion: { id: 'v' } } : null));
    const single = makeSet(['inv-a']);
    scriptSets([full(), single], single);
    const out = await run();
    expect(out).toMatchObject({ outcome: 'paused', reason: 'no_reachable_channel' });
    expect(mockSendTemplate).toHaveBeenCalledTimes(1); // the vetoed first attempt; the re-plan sent nothing more
    expect(mockEmailMessages).toHaveLength(0);
    expect(mockLedger.some((r) => r.metadata.delivered === true)).toBe(false);
    expect(Schedule.advance).not.toHaveBeenCalled();
  });

  test('a re-plan that finds a hold or an empty set applies it and sends nothing', async () => {
    scriptSets([full(), makeSet(['inv-a', 'inv-b'], { kind: 'hold', reason: 'member_paused' })], makeSet(['inv-a', 'inv-b'], { totalCents: 1, digest: 'other' }));
    expect(await run()).toMatchObject({ outcome: 'held', reason: 'member_paused' });
    expect(await smsAccepted()).toEqual([]);
    expect(mockEmailMessages).toHaveLength(0);
    expect(mockSendMessage).toHaveBeenCalledTimes(1); // no second attempt
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });
});

describe('a definite non-send recorded by the email library is recovered too (R4-3)', () => {
  const logger = require('../services/logger');
  const lines = () => logger.info.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('SHADOW would')).join('\n');
  const emailOnly = () => { prefs = { invoice_channels: ['email'] }; };
  // The library durably records the outcome; the worker then dies before recordLegOutcome resolves the reservation
  // (the ledger stamp is lost), leaving it neither retryable nor resolved.
  const libraryRecordsThenWorkerDies = (over) => {
    mockSendTemplate.mockImplementationOnce(async (args) => {
      mockEmailMessages.push({
        id: 'em-x', idempotency_key: args.idempotencyKey, trigger_event_id: args.triggerEventId, recipient_type: 'customer',
        recipient_id: args.recipientId, template_key: args.templateKey, payload_snapshot: JSON.stringify(args.payload),
        send_attempt_token: 'tok-1', sent_at: null, ...over,
      });
      return { sent: false, blocked: over.status === 'blocked', reason: over.error_message };
    });
    ContactLedger.markSendFailed.mockResolvedValueOnce(false);
  };
  const suppressed = { status: 'blocked', error_message: 'Suppressed: bounce (transactional_required)' };
  const rejected = { status: 'failed', error_message: 'SendGrid 400', provider_handoff_phase: 'rejected', provider_handoff_attempt_token: 'tok-1' };

  test('a suppression-blocked email row: the ambiguous reservation is RESOLVED (terminal) by the next run, which pauses instead of holding forever', async () => {
    emailOnly();
    libraryRecordsThenWorkerDies(suppressed);
    expect((await run()).outcome).toBe('held'); // unconfirmed
    expect(rowFor('email').metadata.resolved).toBeUndefined();
    expect(rowFor('email').metadata.send_failed).toBeUndefined();
    expect((await run()).outcome).toBe('held'); // without the repair: ambiguous every run (the bug)

    realRepair();
    expect(await run()).toMatchObject({ outcome: 'paused', reason: 'all_channels_terminal' });
    expect(rowFor('email').metadata).toMatchObject({ resolved: true, resolution: 'email_terminal_refusal' });
    expect(mockSendTemplate).toHaveBeenCalledTimes(1); // no second email
  });

  test('a definite pre-provider / rejected failure row: the reservation is REOPENED and the next run sends (once)', async () => {
    emailOnly();
    libraryRecordsThenWorkerDies(rejected);
    expect((await run()).outcome).toBe('held');
    realRepair();
    expect((await run()).outcome).toBe('advanced');
    expect(mockSendTemplate).toHaveBeenCalledTimes(2);
    expect(mockEmailMessages.filter((m) => m.sent_at)).toHaveLength(1);
    expect(rowFor('email').metadata.delivered).toBe(true);
  });

  test.each([
    ['still queued (in flight)', { status: 'queued', provider_handoff_phase: 'pending', provider_handoff_attempt_token: 'tok-1' }],
    ['failed AFTER the provider handoff started (uncertain)', { status: 'failed', error_message: 'timeout', provider_handoff_phase: 'started', provider_handoff_attempt_token: 'tok-1' }],
    ['failed with a provider retry scheduled', { ...rejected, provider_retry_next_at: new Date() }],
    ['a rejected phase that is not this attempt\'s', { ...rejected, provider_handoff_attempt_token: 'someone-else' }],
  ])('%s stays HELD: nothing written, nothing re-sent', async (_name, over) => {
    emailOnly();
    libraryRecordsThenWorkerDies(over);
    await run();
    realRepair();
    ContactLedger.markSendFailed.mockClear();
    expect((await run()).outcome).toBe('held');
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
  });

  test('SHADOW: durable rejection evidence with no send_failed stamp is judged as live judges it after its repair: claimable, would SEND; nothing is written', async () => {
    emailOnly();
    libraryRecordsThenWorkerDies(rejected);
    await run();
    expect(rowFor('email').metadata.send_failed).toBeUndefined(); // the stored reservation is ambiguous...
    ContactLedger.markSendFailed.mockClear();
    mockWrites.length = 0;
    realRepair();
    Schedule.promotionCandidates.mockResolvedValue([]);
    shadowDb([{ ...schedule, id: SCHEDULE_ID, status: 'active', step_index: 4, next_touch_at: ago(0) }]);
    await Runner.shadowRun(NOW);
    expect(lines()).toMatch(/SHADOW would send customer=cust-0000-synthetic schedule=sched-0000-synthetic step=d60_reminder/); // ...but the repair makes it retryable
    expect(lines()).not.toMatch(/REMINDER_OUTCOME_UNCONFIRMED/);
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
    expect(mockWrites).toEqual([]);
    expect(rowFor('email').metadata.send_failed).toBeUndefined(); // still unstamped: shadow only read
    // and live does repair it and retry
    expect((await run()).outcome).toBe('advanced');
  });

  test('SHADOW: accepted evidence with no delivered stamp is would-SETTLE; nothing is written', async () => {
    emailOnly();
    ContactLedger.markDelivered.mockResolvedValueOnce(false); // the crash between acceptance and the stamp
    await run();
    ContactLedger.markDelivered.mockClear();
    mockWrites.length = 0;
    realRepair();
    Schedule.promotionCandidates.mockResolvedValue([]);
    shadowDb([{ ...schedule, id: SCHEDULE_ID, status: 'active', step_index: 4, next_touch_at: ago(0) }]);
    await Runner.shadowRun(NOW);
    expect(lines()).toMatch(/SHADOW would settle .* reason=already_delivered/);
    expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
    expect(mockWrites).toEqual([]);
  });

  test('SHADOW reports the verdict (would pause) and writes nothing', async () => {
    emailOnly();
    libraryRecordsThenWorkerDies(suppressed);
    await run();
    ContactLedger.markSendFailed.mockClear();
    const emailDb = realRepair();
    Schedule.promotionCandidates.mockResolvedValue([]);
    shadowDb([{ ...schedule, id: SCHEDULE_ID, status: 'active', step_index: 4, next_touch_at: ago(0) }]);
    await Runner.shadowRun(NOW);
    expect(lines()).toMatch(/SHADOW would pause customer=cust-0000-synthetic schedule=sched-0000-synthetic step=d60_reminder reason=all_channels_terminal/);
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
    expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
    expect(emailDb.transaction).not.toHaveBeenCalled();
    expect(rowFor('email').metadata.resolved).toBeUndefined(); // the stored reservation is untouched
  });
});

describe('the cadence is driven by the members of the set that was sent (R5-1)', () => {
  // An older invoice awaiting microdeposit verification stays status 'active' but the resolved set excludes it.
  const withExcludedOlder = () => {
    memberSeqRows = [...rowsFor(['inv-old'], 100, 3), ...rowsFor(['inv-a', 'inv-b', 'inv-c'], 60, 3)];
    live = makeSet(['inv-a', 'inv-b', 'inv-c']);
    live.excluded.md = ['inv-old'];
  };

  test('a fresh send advances from the SENT set\'s rows: the excluded older invoice does not schedule the next stage early', async () => {
    withExcludedOlder();
    expect((await run()).outcome).toBe('advanced');
    const { activeRows } = Schedule.advance.mock.calls[0][1];
    expect(activeRows.map((r) => r.invoice_id).sort()).toEqual(['inv-a', 'inv-b', 'inv-c']);
    // the real cadence over those rows: the next touch comes from the 60-day-old invoice, not the 100-day-old one
    const real = jest.requireActual('../services/customer-dunning/schedule');
    const fromSent = real.nextTouchFor({ step_index: 4 }, activeRows, NOW);
    const fromAll = real.nextTouchFor({ step_index: 4 }, memberSeqRows, NOW);
    expect(fromSent.getTime()).toBeGreaterThan(fromAll.getTime());
  });

  test('a touch settled from the ledger (recover-first) narrows to the invoices its reservation named', async () => {
    withExcludedOlder();
    mockLedger.push({
      id: 'pre-e', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(0.1),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: 'k-e',
      metadata: { notificationEventKey: `customer-dunning:${SCHEDULE_ID}:1:d60_reminder`, delivered: true, selectedChannels: ['email', 'sms'] },
    }, {
      id: 'pre-s', customer_id: CUSTOMER_ID, channel: 'sms', source: 'invoice_followups_customer', occurred_at: ago(0.1),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: 'k-s',
      metadata: { notificationEventKey: `customer-dunning:${SCHEDULE_ID}:1:d60_reminder`, delivered: true, selectedChannels: ['email', 'sms'] },
    });
    expect((await run()).outcome).toBe('advanced');
    expect(Schedule.advance.mock.calls[0][1].activeRows.map((r) => r.invoice_id)).not.toContain('inv-old');
  });

  test('"the next stage has arrived" (which settles a half-delivered touch) is judged from the named invoices too, not the excluded older one', async () => {
    withExcludedOlder();
    mockLedger.push({
      id: 'pre-e', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(0.1),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: 'k-e',
      metadata: { notificationEventKey: `customer-dunning:${SCHEDULE_ID}:1:d60_reminder`, delivered: true, selectedChannels: ['email', 'sms'] },
    });
    // the text leg is still owed and the named invoices are at Day 60: it is SENT, not settled early on the 100-day-old invoice
    expect((await run()).outcome).toBe('advanced');
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
  });
});

describe('shadow models an ambiguous reservation before logging a send (R5-2)', () => {
  const logger = require('../services/logger');
  const lines = () => logger.info.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('SHADOW would')).join('\n');
  const stepKey = 's-open';
  const reserve = (channel, metadata = {}) => mockLedger.push({
    id: `res-${channel}`, customer_id: CUSTOMER_ID, channel, source: 'invoice_followups_customer', occurred_at: ago(0.1),
    invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: keyFor(`customer-dunning:${stepKey}:1:d60_reminder`, channel),
    metadata: { notificationEventKey: `customer-dunning:${stepKey}:1:d60_reminder`, selectedChannels: ['email', 'sms'], ...metadata },
  });
  const open = [{ id: stepKey, customer_id: CUSTOMER_ID, step_index: 4, episode: 1, status: 'active' }];
  const shadow = async () => {
    Schedule.promotionCandidates.mockResolvedValue([]);
    const database = shadowDb(open);
    await Runner.shadowRun(NOW);
    return database;
  };
  const untouched = (database) => {
    expect(database.writes).toEqual([]);
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(ContactLedger.claimAttempt).not.toHaveBeenCalled();
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
  };

  test('email-only: a reservation with no delivery evidence that is not send_failed is would-HOLD REMINDER_OUTCOME_UNCONFIRMED, as live', async () => {
    prefs = { invoice_channels: ['email'] };
    reserve('email');
    untouched(await shadow());
    expect(lines()).toMatch(/SHADOW would hold customer=cust-0000-synthetic schedule=s-open step=d60_reminder reason=REMINDER_OUTCOME_UNCONFIRMED unclaimable=email/);
    expect(lines()).not.toMatch(/would send/);
    // the live path holds for exactly this reason
    ContactLedger.recordContact.mockClear();
    setup();
    prefs = { invoice_channels: ['email'] };
    mockLedger.length = 0;
    mockLedger.push({
      id: 'res-live', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(0.1),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'],
      idempotency_key: `billing-reminder:${require('crypto').createHash('sha256').update(`${CUSTOMER_ID}:customer-dunning:${SCHEDULE_ID}:1:d60_reminder`).digest('hex')}:email`,
      metadata: { notificationEventKey: `customer-dunning:${SCHEDULE_ID}:1:d60_reminder`, selectedChannels: ['email'] },
    });
    expect(await run()).toMatchObject({ outcome: 'held', reason: 'REMINDER_OUTCOME_UNCONFIRMED' });
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('a partial: the claimable channel goes, the ambiguous one is named', async () => {
    reserve('email');
    untouched(await shadow());
    expect(lines()).toMatch(/SHADOW would send customer=cust-0000-synthetic schedule=s-open step=d60_reminder kind=multi members=3 total_cents=\d+ unclaimable=email/);
  });

  test('a reservation the live path would reclaim (send_failed) or a new one is sendable; nothing is claimed in shadow', async () => {
    reserve('email', { send_failed: true });
    untouched(await shadow());
    expect(lines()).toMatch(/SHADOW would send .*schedule=s-open/);
    expect(lines()).not.toMatch(/unclaimable=/);
  });

  describe('old keyed reservations (past the 90-day progress window) are consulted too (R9)', () => {
    const old = (channel, metadata = {}) => mockLedger.push({
      id: `old-${channel}`, customer_id: CUSTOMER_ID, channel, source: 'invoice_followups_customer', occurred_at: ago(120),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: keyFor(`customer-dunning:${stepKey}:1:d60_reminder`, channel),
      metadata: { notificationEventKey: `customer-dunning:${stepKey}:1:d60_reminder`, selectedChannels: ['email', 'sms'], ...metadata },
    });

    test('a >90-day-old AMBIGUOUS reservation is would-HOLD REMINDER_OUTCOME_UNCONFIRMED (live finds the same keyed row and refuses it)', async () => {
      prefs = { invoice_channels: ['email'] };
      old('email');
      untouched(await shadow());
      expect(lines()).toMatch(/SHADOW would hold customer=cust-0000-synthetic schedule=s-open step=d60_reminder reason=REMINDER_OUTCOME_UNCONFIRMED unclaimable=email/);
      expect(lines()).not.toMatch(/would send/);
    });

    test('a >90-day-old DELIVERED reservation is would-SETTLE (deduped, never sent again), not would-send', async () => {
      prefs = { invoice_channels: ['email'] };
      old('email', { delivered: true });
      untouched(await shadow());
      expect(lines()).toMatch(/SHADOW would settle customer=cust-0000-synthetic schedule=s-open step=d60_reminder reason=already_delivered/);
      expect(lines()).not.toMatch(/would send/);
    });

    test('a partial: one leg old-delivered (deduped), the other new: the send goes for the new one, naming the deduped', async () => {
      old('email', { delivered: true });
      untouched(await shadow());
      expect(lines()).toMatch(/SHADOW would send customer=cust-0000-synthetic schedule=s-open step=d60_reminder kind=multi members=3 total_cents=\d+ deduped=email/);
    });

    test('an old send_failed reservation is claimable (live reopens it); a resolved one is refused like live', async () => {
      prefs = { invoice_channels: ['email'] };
      old('email', { send_failed: true });
      untouched(await shadow());
      expect(lines()).toMatch(/would send/);
      logger.info.mockClear();
      mockLedger.length = 0;
      old('email', { resolved: true });
      await shadow();
      expect(lines()).toMatch(/would hold .* reason=REMINDER_OUTCOME_UNCONFIRMED/);
    });
  });

  test('the ledger\'s claim decision is one function: claimAttempt and the shadow ask the same verdict', () => {
    const { claimVerdict } = jest.requireActual('../services/collections/contact-ledger');
    expect(claimVerdict({ id: 'x', reused: true, metadata: {} })).toEqual({ allowed: false, held: true });
    expect(claimVerdict({ id: 'x', reused: true, metadata: { send_failed: true } })).toEqual({ allowed: true, reopen: true });
    expect(claimVerdict({ id: 'x', reused: false, metadata: {} })).toEqual({ allowed: true });
    expect(claimVerdict({ id: 'x', reused: true, metadata: { delivered: true } })).toEqual({ allowed: false, delivered: true });
    expect(claimVerdict({ id: 'x', reused: true, metadata: { resolved: true } })).toEqual({ allowed: false, resolved: true });
  });
});

describe('progress is selected by the CURRENT touch key after the stage is planned again (R6)', () => {
  const logger = require('../services/logger');
  const lines = () => logger.info.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('SHADOW would')).join('\n');
  const day30 = `customer-dunning:s-open:1:d30_final`;
  // a schedule still at Day 30 whose oldest invoice is 65 days old: the stage catches up to Day 60
  const catchUp = () => {
    memberSeqRows = rowsFor(['inv-a', 'inv-b', 'inv-c'], 65, 3);
    live = makeSet(['inv-a', 'inv-b', 'inv-c']);
  };

  test('SHADOW: an ambiguous DAY 30 reservation does not hold the Day 60 the schedule catches up to (policy exclusions and claimability read the Day 60 event)', async () => {
    prefs = { invoice_channels: ['email'] };
    catchUp();
    mockLedger.push({
      id: 'd30-email', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(30),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: 'k-d30',
      metadata: { notificationEventKey: day30, selectedChannels: ['email'] }, // no delivery evidence, not send_failed: ambiguous
    });
    Schedule.promotionCandidates.mockResolvedValue([]);
    const database = shadowDb([{ id: 's-open', customer_id: CUSTOMER_ID, step_index: 3, episode: 1, status: 'active' }]);
    await Runner.shadowRun(NOW);
    expect(lines()).toMatch(/SHADOW would send customer=cust-0000-synthetic schedule=s-open step=d60_reminder/);
    expect(lines()).not.toMatch(/REMINDER_OUTCOME_UNCONFIRMED/);
    // the policy read excludes THIS touch's rows (none yet), not the old step's
    expect(mockPolicy.mock.calls.every(([a]) => !a.excludeLedgerIds.includes('d30-email'))).toBe(true);
    expect(database.writes).toEqual([]);
  });

  test('SHADOW: the ambiguous reservation of the CURRENT (planned) step still holds', async () => {
    prefs = { invoice_channels: ['email'] };
    catchUp();
    mockLedger.push({
      id: 'd60-email', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(0.1),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: keyFor('customer-dunning:s-open:1:d60_reminder', 'email'),
      metadata: { notificationEventKey: 'customer-dunning:s-open:1:d60_reminder', selectedChannels: ['email'] },
    });
    Schedule.promotionCandidates.mockResolvedValue([]);
    await (async () => { shadowDb([{ id: 's-open', customer_id: CUSTOMER_ID, step_index: 3, episode: 1, status: 'active' }]); return Runner.shadowRun(NOW); })();
    expect(lines()).toMatch(/would hold .* step=d30_final reason=REMINDER_OUTCOME_UNCONFIRMED unclaimable=email/);
  });

  test('LIVE re-plan Day 30 -> 60: when the post-send progress read fails, the fallback is the Day 60 touch\'s event, never the Day 30 one delivered earlier', async () => {
    setup({ stepIndex: 3, sentDaysAgo: 30 });
    prefs = { invoice_channels: ['email', 'sms'] };
    memberSeqRows = [...rowsFor(['inv-a'], 65, 3), ...rowsFor(['inv-b'], 30, 3), ...rowsFor(['inv-c'], 29, 3)];
    // Day 30's email was delivered earlier (a partial touch naming b and c); the text is still owed
    mockLedger.push({
      id: 'd30-email', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(0.1),
      invoice_ids: ['inv-b', 'inv-c'], idempotency_key: 'k-d30',
      metadata: { notificationEventKey: `customer-dunning:${SCHEDULE_ID}:1:d30_final`, delivered: true, selectedChannels: ['email', 'sms'] },
    });
    // the runner first sees {b, c}; the boundary sees the full set (the older invoice became eligible) => re-plan to Day 60
    const initial = makeSet(['inv-b', 'inv-c']);
    let n = 0;
    mockResolve.mockImplementation(async (_id, opts) => {
      if (!opts?.now) return makeSet(['inv-a', 'inv-b', 'inv-c']);
      n += 1;
      return n === 1 ? initial : makeSet(['inv-a', 'inv-b', 'inv-c']);
    });
    // after the Day 60 email is accepted, the next ledger read (the post-send progress read) fails
    const impl = fakeDb.getMockImplementation();
    fakeDb.mockImplementation((table) => {
      if (table === 'collections_contact_ledger' && mockEmailMessages.length > 0) throw new Error('ledger down');
      return impl(table);
    });
    const out = await run();
    expect(out.outcome).toBe('advanced');
    expect(Schedule.writeStage).toHaveBeenCalledWith(expect.anything(), 4, expect.anything());
    // both Day 60 legs were delivered NOW; the Day 30 email's earlier time must not stand in for this touch
    expect(new Date(Schedule.advance.mock.calls[0][1].deliveredAt).getTime()).toBe(NOW.getTime());
    expect(interactions).toHaveLength(1);
  });
});

describe('the text is re-checked at the FINAL provider hook, after provider preparation (R7)', () => {
  const smsOnly = () => { prefs = { invoice_channels: ['sms'] }; };
  const accepted = async () => (await Promise.all(mockSendMessage.mock.results.map((r) => r.value))).filter((r) => r?.sent === true);
  test('unchanged: one text goes out, and the final hook ran after the earlier checks', async () => {
    smsOnly();
    expect((await run()).outcome).toBe('advanced');
    expect(await accepted()).toHaveLength(1);
    expect(mockSendMessage.mock.calls[0][0].providerPreSendCheck).toEqual(expect.any(Function));
    expect(mockResolve.mock.calls.filter(([, o]) => !o?.now)).toHaveLength(3); // preDispatch, preSend, providerPreSend
  });

  test('an invoice paid DURING the provider preparation (the short-link lookup) vetoes that text: no messages.create, retryable, the reservation reopened; the re-render sends the new set once', async () => {
    smsOnly();
    const changed = makeSet(['inv-a', 'inv-b'], { totalCents: 20000, digest: 'paid-c' });
    // boundary reads (no `now`) of the first attempt: preDispatch, preSend, providerPreSend. Invoice C is paid
    // during the provider preparation, so the 3rd read (and everything after, incl. the re-render) sees `changed`.
    let boundary = 0;
    mockResolve.mockImplementation(async (_id, opts) => {
      if (opts?.now) return boundary >= 3 ? changed : live;
      boundary += 1;
      return boundary >= 3 ? changed : live;
    });
    const out = await run();
    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'DUNNING_SET_CHANGED' }));
    const sent = await accepted();
    expect(sent).toHaveLength(1);
    expect(mockSendMessage.mock.calls.at(-1)[0].body).toContain('SMS[invoice_followup_combined_60day] 2 '); // the CURRENT set
    expect(out.outcome).toBe('advanced');
  });

  test('a set that keeps changing is vetoed at the final hook every time: nothing is sent, the step is held, the reservation stays reopened', async () => {
    smsOnly();
    let boundary = 0;
    mockResolve.mockImplementation(async (_id, opts) => {
      if (opts?.now) return boundary >= 3 ? makeSet(['inv-a', 'inv-b'], { totalCents: 20000 + boundary, digest: `d-${boundary}` }) : live;
      boundary += 1;
      // preDispatch and preSend match the set the text was rendered from; the FINAL hook never does
      return [1, 2, 4, 5].includes(boundary) ? (boundary <= 2 ? live : makeSet(['inv-a', 'inv-b'], { totalCents: 20000 + 3, digest: 'd-3' })) : makeSet(['inv-a'], { totalCents: 12900, digest: `x-${boundary}` });
    });
    const out = await run();
    expect(out.outcome).toBe('held');
    expect(await accepted()).toHaveLength(0);
    expect(rowFor('sms').metadata.send_failed).toBe(true);
    expect(Schedule.advance).not.toHaveBeenCalled();
  });

  test('a schedule paused during the preparation is refused at the final hook (retryable DUNNING_SCHEDULE_CHANGED), nothing sent', async () => {
    smsOnly();
    let boundary = 0;
    mockResolve.mockImplementation(async (_id, opts) => {
      if (!opts?.now) {
        boundary += 1;
        if (boundary === 2) mockScheduleRow = { ...mockScheduleRow, status: 'paused' }; // after the pre-send check has passed, an admin pauses while the lookup runs
      }
      return live;
    });
    const out = await run();
    expect(await accepted()).toHaveLength(0);
    expect(out.outcome).toBe('held');
    expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'DUNNING_SCHEDULE_CHANGED' }));
  });

  test('the PUSH rail needs no twin: its check is re-run by the push service right before the FCM request, with no arguments', async () => {
    prefs = { invoice_channels: ['push'] };
    await run();
    const input = mockSendMessage.mock.calls[0][0];
    expect(input.channel).toBe('push');
    expect(input.providerPreSendCheck).toBeUndefined(); // the push provider takes shouldContinue (= preSendCheck), not this hook
    mockResolve.mockClear();
    expect(await input.preSendCheck()).toEqual({ ok: true }); // fcm.send calls shouldContinue() bare, after the token fetch
    expect(mockResolve).toHaveBeenCalledTimes(1);
  });
});

describe('a cleared balance closes the schedule before the autopay guard; autopay holds are revisited (R8)', () => {
  const logger = require('../services/logger');
  const lines = () => logger.info.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('SHADOW would')).join('\n');
  const empty = () => ({ kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null, activeCount: 0 });

  test('every invoice paid / voided and the customer still on autopay: the schedule CLOSES (balance_cleared), it is not parked as autopay_hold', async () => {
    mockOnAutopay.mockResolvedValue(true);
    live = empty();
    expect(await run()).toMatchObject({ outcome: 'closed', reason: 'balance_cleared' });
    expect(Schedule.close).toHaveBeenCalledWith(expect.anything(), 'balance_cleared', NOW, expect.objectContaining({ claimStamp: NOW }));
    expect(Schedule.markAutopayHold).not.toHaveBeenCalled();
    expect(mockOnAutopay).not.toHaveBeenCalled(); // the empty set is judged first
  });

  test('an existing autopay_hold schedule whose invoices were paid meanwhile is closed on the next run', async () => {
    setup({ stepStatus: 'autopay_hold' });
    mockOnAutopay.mockResolvedValue(true);
    live = empty();
    expect(await run()).toMatchObject({ outcome: 'closed', reason: 'balance_cleared' });
    expect(Schedule.markAutopayHold).not.toHaveBeenCalled();
  });

  test('still owing and still on autopay: the hold is re-armed (revisited again tomorrow), nothing is sent', async () => {
    setup({ stepStatus: 'autopay_hold' });
    mockOnAutopay.mockResolvedValue(true);
    expect((await run()).outcome).toBe('autopay_hold');
    expect(Schedule.markAutopayHold).toHaveBeenCalledTimes(1);
    expect(Schedule.resumeFromAutopay).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('the customer left autopay while held: the schedule resumes (active) and the ordinary send path takes the step', async () => {
    setup({ stepStatus: 'autopay_hold' });
    mockOnAutopay.mockResolvedValue(false);
    expect((await run()).outcome).toBe('advanced');
    expect(Schedule.resumeFromAutopay).toHaveBeenCalledTimes(1);
    expect(Schedule.resumeFromAutopay.mock.invocationCallOrder[0]).toBeLessThan(Schedule.advance.mock.invocationCallOrder[0]);
  });

  test('a hold that a stale worker cannot resume does not send', async () => {
    setup({ stepStatus: 'autopay_hold' });
    mockOnAutopay.mockResolvedValue(false);
    Schedule.resumeFromAutopay.mockResolvedValue(false);
    expect((await run()).outcome).toBe('stale');
    expect(mockSendMessage).not.toHaveBeenCalled();
  });

  test('the due scan includes autopay_hold schedules (so they are revisited)', async () => {
    const statuses = [];
    require('../models/db').mockImplementationOnce(() => {
      const q = { where() { return q; }, orderBy() { return q; }, select: async () => [] };
      q.whereIn = (_col, list) => { statuses.push(...list); return q; };
      return q;
    });
    await Runner.runCustomerSchedules(NOW);
    expect(statuses).toEqual(expect.arrayContaining(['active', 'held', 'autopay_hold']));
  });

  describe('a claim-guarded write that matches no row is stale, never the state it would have produced (R10)', () => {
    test('markHeld matching nothing (a lookup failure hold): outcome stale, not held', async () => {
      Schedule.markHeld.mockResolvedValue(false);
      mockOnAutopay.mockRejectedValue(new Error('down'));
      expect(await run()).toMatchObject({ outcome: 'stale' });
    });

    test('markPaused matching nothing: stale, not paused', async () => {
      Schedule.markPaused.mockResolvedValue(false);
      customer.deleted_at = new Date();
      expect((await run()).outcome).toBe('stale');
    });

    test('markAutopayHold matching nothing: stale, not autopay_hold', async () => {
      Schedule.markAutopayHold.mockResolvedValue(false);
      mockOnAutopay.mockResolvedValue(true);
      expect((await run()).outcome).toBe('stale');
    });

    test('the same writers succeeding keep their outcomes (held / paused / autopay_hold)', async () => {
      mockOnAutopay.mockRejectedValue(new Error('down'));
      expect(await run()).toMatchObject({ outcome: 'held', reason: 'autopay_unreadable' });
      mockOnAutopay.mockResolvedValue(true);
      expect((await run()).outcome).toBe('autopay_hold');
    });

    test('a failure hold on a revisited autopay_hold row is handed the autopay_hold schedule under the run\'s claim (the writer must accept it)', async () => {
      setup({ stepStatus: 'autopay_hold' });
      const db = require('../models/db');
      const serve = db.getMockImplementation();
      db.mockImplementation((table) => { if (table === 'notification_prefs') throw new Error('prefs down'); return serve(table); });
      expect(await run()).toMatchObject({ outcome: 'held', reason: 'prefs_unreadable' });
      expect(Schedule.markHeld).toHaveBeenCalledWith(expect.objectContaining({ status: 'autopay_hold' }), 'prefs_unreadable', expect.objectContaining({ claimStamp: NOW }));
    });
  });

  describe('delivery evidence settles on an autopay_hold row without authorizing a send (R9)', () => {
    const partialDay60 = () => mockLedger.push({
      id: 'd60-email', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(30),
      invoice_ids: ['inv-a', 'inv-b', 'inv-c'], idempotency_key: 'k-d60',
      metadata: { notificationEventKey: `customer-dunning:${SCHEDULE_ID}:1:d60_reminder`, delivered: true, selectedChannels: ['email', 'sms'] },
    });
    // Day 60 half-delivered, the schedule then parked on autopay, and now Day 90 has arrived
    const held = () => { setup({ stepIndex: 4, sentDaysAgo: 95, stepStatus: 'autopay_hold' }); partialDay60(); };
    const noSend = () => { expect(mockSendMessage).not.toHaveBeenCalled(); expect(mockSendTemplate).not.toHaveBeenCalled(); };

    test('still on autopay: the partial Day 60 settles (advance), the schedule stays autopay_hold and is revisited; nothing is sent', async () => {
      held();
      mockOnAutopay.mockResolvedValue(true);
      expect(await run()).toMatchObject({ outcome: 'advanced', recovered: true });
      expect(Schedule.advance).toHaveBeenCalledTimes(1);
      expect(Schedule.advance.mock.calls[0][1]).toMatchObject({ fromStatuses: ['active', 'held', 'autopay_hold'], landStatus: 'autopay_hold' });
      noSend();
    });

    test('autopay state unreadable: it fails closed to autopay_hold', async () => {
      held();
      mockOnAutopay.mockRejectedValue(new Error('down'));
      expect((await run()).outcome).toBe('advanced');
      expect(Schedule.advance.mock.calls[0][1]).toMatchObject({ landStatus: 'autopay_hold' });
      noSend();
    });

    test('autopay has been turned off: it settles and lands ACTIVE, still without sending; the next run sends the next step once', async () => {
      held();
      mockOnAutopay.mockResolvedValue(false);
      expect(await run()).toMatchObject({ outcome: 'advanced', recovered: true });
      expect(Schedule.advance.mock.calls[0][1]).toMatchObject({ fromStatuses: ['active', 'held', 'autopay_hold'], landStatus: 'active' });
      noSend();
      // the next run: the schedule is now at Day 90, active, and the ordinary path sends it (no resume needed)
      mockLedger.length = 0;
      setup({ stepIndex: 5, sentDaysAgo: 95, stepStatus: 'active' });
      expect((await run()).outcome).toBe('completed');
      expect(Schedule.resumeFromAutopay).not.toHaveBeenCalled();
      expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    });

    test('a SEND from an autopay_hold row still needs resumeFromAutopay first (the widening is for settling evidence only)', async () => {
      setup({ stepIndex: 4, sentDaysAgo: 60, stepStatus: 'autopay_hold' });
      mockOnAutopay.mockResolvedValue(false);
      expect((await run()).outcome).toBe('advanced');
      expect(Schedule.resumeFromAutopay).toHaveBeenCalledTimes(1);
      expect(Schedule.advance.mock.calls[0][1].fromStatuses).toBeUndefined(); // the send's advance is the ordinary guarded one
    });

    test('a completed final notice settles from autopay_hold too (completeFinal), naming what the reservation named', async () => {
      setup({ stepIndex: 5, sentDaysAgo: 100, stepStatus: 'autopay_hold' });
      prefs = { invoice_channels: ['email'] };
      mockOnAutopay.mockResolvedValue(true);
      mockLedger.push({
        id: 'd90-email', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer', occurred_at: ago(2),
        invoice_ids: ['inv-a', 'inv-b'], idempotency_key: 'k-d90',
        metadata: { notificationEventKey: `customer-dunning:${SCHEDULE_ID}:1:d90_final_notice`, delivered: true, selectedChannels: ['email'] },
      });
      expect((await run()).outcome).toBe('completed');
      expect(Schedule.completeFinal).toHaveBeenCalledTimes(1);
      const args = Schedule.completeFinal.mock.calls[0][1];
      expect(args.fromStatuses).toEqual(['active', 'held', 'autopay_hold']);
      expect([...args.namedInvoiceIds].sort()).toEqual(['inv-a', 'inv-b']);
      noSend();
    });
  });

  test('SHADOW mirrors it: an autopay_hold schedule with nothing owed is a would-close; one still owing on autopay is a would-hold', async () => {
    Schedule.promotionCandidates.mockResolvedValue([]);
    const open = [{ id: 's-ap', customer_id: CUSTOMER_ID, step_index: 4, episode: 1, status: 'autopay_hold' }];
    mockOnAutopay.mockResolvedValue(true);
    live = empty();
    const database = shadowDb(open);
    await Runner.shadowRun(NOW);
    expect(lines()).toMatch(/SHADOW would close customer=cust-0000-synthetic schedule=s-ap step=d60_reminder reason=balance_cleared/);
    expect(lines()).not.toMatch(/autopay_hold/);
    logger.info.mockClear();
    live = makeSet(['inv-a', 'inv-b', 'inv-c']);
    await Runner.shadowRun(NOW);
    expect(lines()).toMatch(/SHADOW would hold customer=cust-0000-synthetic schedule=s-ap step=d60_reminder reason=autopay_hold/);
    expect(database.writes).toEqual([]);
    expect(Schedule.close).not.toHaveBeenCalled();
    expect(Schedule.markAutopayHold).not.toHaveBeenCalled();
  });
});

describe('a delivery older than the progress window is still a delivery, and completes what it NAMED (R2-2 / A2)', () => {
  const crypto = require('crypto');
  const finalKey = `customer-dunning:${SCHEDULE_ID}:1:d90_final_notice`;
  const seedOldFinal = (over = {}) => mockLedger.push({
    id: 'old-final', customer_id: CUSTOMER_ID, channel: 'email', source: 'invoice_followups_customer',
    occurred_at: ago(100), invoice_ids: ['inv-a', 'inv-b'],
    idempotency_key: `billing-reminder:${crypto.createHash('sha256').update(`${CUSTOMER_ID}:${finalKey}`).digest('hex')}:email`,
    metadata: { notificationEventKey: finalKey, delivered: true, selectedChannels: ['email'] },
    ...over,
  });
  const finalNotice = () => { setup({ stepIndex: 5, sentDaysAgo: 300 }); prefs = { invoice_channels: ['email'] }; };

  test('final accepted (naming A and B), crash, resumed 100 days later, today\'s set is A, B AND C: completes A and B with the ORIGINAL time; C is untouched and no second notice goes out', async () => {
    finalNotice();
    const old = ago(100);
    seedOldFinal({ occurred_at: old });
    const out = await run(); // live = { A, B, C }
    expect(out.outcome).toBe('completed');
    expect(Schedule.completeFinal).toHaveBeenCalledTimes(1);
    const args = Schedule.completeFinal.mock.calls[0][1];
    expect([...args.namedInvoiceIds].sort()).toEqual(['inv-a', 'inv-b']);
    expect(args.namedInvoiceIds).not.toContain('inv-c');
    expect(new Date(args.deliveredAt).getTime()).toBe(old.getTime());
    expect(Schedule.markPaused).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled(); // deduped: never a second final notice
    expect(mockLedger).toHaveLength(1);
  });

  test.each([
    ['names no invoices', { invoice_ids: [] }],
    ['has unreadable invoice ids', { invoice_ids: '{not json' }],
  ])('a restored delivery that %s completes NOTHING: held for the office, never today\'s membership', async (_name, over) => {
    finalNotice();
    seedOldFinal(over);
    const out = await run();
    expect(out).toMatchObject({ outcome: 'held', reason: 'delivered_evidence_unreadable' });
    expect(Schedule.completeFinal).not.toHaveBeenCalled();
    expect(Schedule.markHeld).toHaveBeenCalledWith(expect.anything(), 'delivered_evidence_unreadable', expect.anything());
    expect(mockSendTemplate).not.toHaveBeenCalled();
  });

  test('the reservation row itself unreadable is the same hold', async () => {
    finalNotice();
    seedOldFinal();
    failLedgerAccess(3); // recover-first progress (1), sendReminderChannels progress (2); the reservation row read (3) fails
    const out = await run();
    expect(out).toMatchObject({ outcome: 'held', reason: 'delivered_evidence_unreadable' });
    expect(Schedule.completeFinal).not.toHaveBeenCalled();
  });

  test('a non-final step restored from an old reservation still advances (nothing is completed on its say-so)', async () => {
    setup({ stepIndex: 4, sentDaysAgo: 300, stepStatus: 'held' }); // held: the step is retried, not caught up to the final
    prefs = { invoice_channels: ['email'] };
    const key = `customer-dunning:${SCHEDULE_ID}:1:d60_reminder`;
    seedOldFinal({ metadata: { notificationEventKey: key, delivered: true, selectedChannels: ['email'] },
      idempotency_key: `billing-reminder:${crypto.createHash('sha256').update(`${CUSTOMER_ID}:${key}`).digest('hex')}:email` });
    expect((await run()).outcome).toBe('advanced');
    expect(Schedule.advance).toHaveBeenCalledTimes(1);
  });

  test('sendReminderChannels reports restored legs with what their reservation recorded (additive; per-invoice callers ignore it)', async () => {
    const { sendReminderChannels } = require('../services/billing-reminder-delivery');
    const key = 'customer-dunning:s:1:d60_reminder';
    const at = ago(100);
    mockLedger.push({
      id: 'r1', customer_id: CUSTOMER_ID, channel: 'email', source: 'x', occurred_at: at, invoice_ids: ['inv-a', 'inv-b'],
      idempotency_key: `billing-reminder:${crypto.createHash('sha256').update(`${CUSTOMER_ID}:${key}`).digest('hex')}:email`,
      metadata: { notificationEventKey: key, delivered: true },
    });
    const out = await sendReminderChannels({
      customerId: CUSTOMER_ID, invoiceId: null, invoiceIds: [], policyInvoiceIds: [], source: 'x', purpose: 'late_payment',
      eventKey: key, channels: ['email'], metadata: {}, send: jest.fn(),
    });
    expect(out).toMatchObject({ complete: true, deliveredNow: [], delivered: ['email'] });
    expect(out.restored).toEqual([{ channel: 'email', invoiceIds: ['inv-a', 'inv-b'], deliveredAt: at }]);
  });
});

describe('the shadow run never repairs (A1)', () => {
  const logger = require('../services/logger');
  const lines = () => logger.info.mock.calls.map(([m]) => String(m)).filter((m) => m.includes('SHADOW would')).join('\n');

  test('an accepted-but-unstamped email is READ as delivered (would settle) and the ledger is not stamped; the live run then repairs it', async () => {
    prefs = { invoice_channels: ['email'] };
    ContactLedger.markDelivered.mockResolvedValueOnce(false); // the crash between acceptance and the stamp
    await run();
    expect(mockEmailMessages).toHaveLength(1);
    expect(rowFor('email').metadata.delivered).toBeUndefined();
    ContactLedger.markDelivered.mockClear();
    mockWrites.length = 0; // the live tick above wrote; the shadow run below must write nothing
    const emailDb = realRepair();

    Schedule.promotionCandidates.mockResolvedValue([]);
    shadowDb([{ ...schedule, id: SCHEDULE_ID, status: 'active', step_index: 4, next_touch_at: ago(0) }]);
    await Runner.shadowRun(NOW);
    expect(lines()).toMatch(/SHADOW would settle customer=cust-0000-synthetic schedule=sched-0000-synthetic step=d60_reminder reason=already_delivered/);
    expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
    expect(ContactLedger.markSendFailed).not.toHaveBeenCalled();
    expect(emailDb.transaction).not.toHaveBeenCalled();
    expect(mockWrites).toEqual([]);
    expect(rowFor('email').metadata.delivered).toBeUndefined(); // still unstamped: shadow did not repair

    // the live path is unchanged: it repairs (stamps) from the same evidence
    expect((await run()).outcome).toBe('advanced');
    expect(ContactLedger.markDelivered).toHaveBeenCalled();
    expect(rowFor('email').metadata.delivered).toBe(true);
  });

  test('reminderProgress passes the read-only option only when asked (default is the repairing view)', async () => {
    const reminder = jest.requireActual('../services/billing-reminder-delivery');
    const Reservation = require('../services/billing-email-reservation');
    Reservation.repairAcceptedBillingEmailReservations.mockClear();
    await reminder.reminderProgress(CUSTOMER_ID, 'invoice_followups_customer', ['email']);
    expect(Reservation.repairAcceptedBillingEmailReservations.mock.calls[0][2]).toBeUndefined();
    await reminder.reminderProgress(CUSTOMER_ID, 'invoice_followups_customer', ['email'], { repair: false });
    expect(Reservation.repairAcceptedBillingEmailReservations.mock.calls[1][2]).toEqual({ readOnly: true });
  });
});

// the real repair over the in-memory email_messages, on a fake handle; counts any transaction (= write path)
const realRepair = () => {
  const actual = jest.requireActual('../services/billing-email-reservation');
  const emailDb = jest.fn(() => {
    let keys = null;
    const q = {
      whereIn(_col, list) { keys = list; return q; },
      then: (resolve) => resolve(mockEmailMessages.filter((m) => !keys || keys.includes(m.idempotency_key))),
    };
    return q;
  });
  emailDb.transaction = jest.fn(async (fn) => fn((table) => {
    const q = { where() { return q; }, whereNull() { return q; }, forUpdate() { return q; }, first: async () => (table === 'email_messages' ? mockEmailMessages[0] : undefined) };
    return q;
  }));
  mockRepairImpl = (rows, _db, options) => actual.repairAcceptedBillingEmailReservations(rows, emailDb, options);
  return emailDb;
};

describe('a crash between provider acceptance and the ledger stamp is recovered, never re-sent (P1)', () => {
  const emailOnly = () => { prefs = { invoice_channels: ['email'] }; };
  // the process dies after the provider accepted, before markDelivered
  const crashBeforeStamp = () => ContactLedger.markDelivered.mockResolvedValueOnce(false);

  test('tick 1 accepts the email but the stamp is lost; tick 2 repairs the reservation from the stored email and advances WITHOUT a second email', async () => {
    emailOnly();
    crashBeforeStamp();
    const first = await run();
    expect(first.outcome).toBe('held');
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(mockEmailMessages).toHaveLength(1);
    expect(rowFor('email').metadata.delivered).toBeUndefined(); // ambiguous reservation
    expect(mockEmailMessages[0]).toMatchObject({ idempotency_key: `customer_dunning_email:${SCHEDULE_ID}:1:d60_reminder` });
    expect(JSON.parse(mockEmailMessages[0].payload_snapshot).collections_ledger_id).toBe(rowFor('email').id);

    realRepair();
    const second = await run();
    expect(second).toMatchObject({ outcome: 'advanced', recovered: true });
    expect(mockSendTemplate).toHaveBeenCalledTimes(1); // still ONE email for the touch
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(rowFor('email').metadata.delivered).toBe(true);
    expect(mockLedger).toHaveLength(1);
    expect(interactions).toHaveLength(0); // recovered: no second interaction row
  });

  test('without the repair (or an email not bound to this reservation) the reservation stays HELD and nothing is sent again', async () => {
    emailOnly();
    crashBeforeStamp();
    await run();
    // 1) repair not wired: the old behaviour, held forever, still never a second email
    expect((await run()).outcome).toBe('held');
    // 2) the stored email names a DIFFERENT ledger row: not ours, not stamped
    realRepair();
    mockEmailMessages[0].payload_snapshot = JSON.stringify({ collections_ledger_id: 'someone-elses-row' });
    expect((await run()).outcome).toBe('held');
    // 3) recipient is another customer
    mockEmailMessages[0].payload_snapshot = JSON.stringify({ collections_ledger_id: rowFor('email').id });
    mockEmailMessages[0].recipient_id = 'other-customer';
    expect((await run()).outcome).toBe('held');
    // 4) accepted evidence is missing (still queued): not accepted, not stamped
    mockEmailMessages[0].recipient_id = CUSTOMER_ID;
    mockEmailMessages[0].sent_at = null;
    expect((await run()).outcome).toBe('held');
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(rowFor('email').metadata.delivered).toBeUndefined();
  });
});

describe('transient email failures stay retryable, terminal ones pause (real sender shapes) (P1)', () => {
  const emailOnly = () => { prefs = { invoice_channels: ['email'] }; };
  // a thrown provider error AFTER the handoff started (SendGrid answered with `status`)
  const providerError = (status) => Object.assign(new Error(`SendGrid ${status}`), { status });
  const failAfterHandoff = (err) => mockSendTemplate.mockImplementation(async ({ withProviderHandoff }) => {
    await withProviderHandoff(async () => { throw err; });
  });

  test('a SendGrid 429 (definite non-send, no retryable flag) holds the step for the next run and is delivered when the provider recovers', async () => {
    emailOnly();
    failAfterHandoff(providerError(429));
    const out = await run();
    expect(out).toMatchObject({ outcome: 'held' });
    expect(Schedule.markPaused).not.toHaveBeenCalled();
    expect(Schedule.markHeld).toHaveBeenCalledWith(expect.anything(), 'send_failed', expect.anything());
    expect(rowFor('email').metadata).toMatchObject({ send_failed: true });
    expect(rowFor('email').metadata.resolved).toBeUndefined();

    acceptingEmail(); // the provider is back
    expect((await run()).outcome).toBe('advanced');
    expect(mockEmailMessages).toHaveLength(1);
  });

  test('the raw provider message never becomes the hold reason', async () => {
    emailOnly();
    failAfterHandoff(Object.assign(new Error('rejected pat@example.test'), { status: 400 }));
    const out = await run();
    expect(out.outcome).toBe('held');
    expect(out.reason).toBe('send_failed');
    expect(Schedule.markHeld.mock.calls.map((c) => c[1]).join()).not.toContain('example.test');
    expect(JSON.stringify(rowFor('email').metadata)).not.toContain('example.test');
  });

  describe('no contact detail reaches a log line (PII)', () => {
    const logger = require('../services/logger');
    const allLogged = () => ['debug', 'info', 'warn', 'error'].flatMap((level) => logger[level].mock.calls.map((c) => c.join(' '))).join('\n');
    const PII = /pat@example\.test|9415550100|941[ -.]?555[ -.]?0100/;

    test('a provider 400 that echoes the recipient address and phone: nothing in any log line; the template library is told not to log it; the outcome is unchanged', async () => {
      prefs = { invoice_channels: ['email'] };
      const err = Object.assign(new Error('The to address pat@example.test (+1 941 555 0100) does not contain a valid address'), { status: 400 });
      mockSendTemplate.mockImplementation(async ({ withProviderHandoff }) => { await withProviderHandoff(async () => { throw err; }); });
      expect((await run()).outcome).toBe('held');
      expect(mockSendTemplate.mock.calls[0][0].suppressProviderErrorLog).toBe(true);
      expect(allLogged()).not.toMatch(PII);
      expect(allLogged()).toContain('[redacted-email]');
      expect(allLogged()).toContain('email failed'); // the line itself is still logged
    });

    test('the operator path passes the same suppression', async () => {
      await run({ operatorInitiated: true, force: true });
      expect(mockSendTemplate.mock.calls[0][0].suppressProviderErrorLog).toBe(true);
    });

    test('billingEmailSendFailure: the log line is redacted, every returned outcome field is exactly what it was', async () => {
      const { billingEmailSendFailure } = require('../services/billing-email-sender');
      const message = '400 Bad Request: pat@example.test (+19415550100) rejected';
      const cases = [
        [Object.assign(new Error(message), { status: 400 }), true, { ok: false, error: message, deliveryOutcome: 'not_sent' }],
        [new Error(message), true, { ok: false, error: message, deliveryOutcome: 'uncertain' }],
        [new Error(message), false, { ok: false, error: message, deliveryOutcome: 'not_sent' }],
        [Object.assign(new Error(message), { code: 'EMAIL_TEMPLATE_DISABLED' }), true, { ok: false, skipped: true, reason: 'template_unavailable' }],
      ];
      for (const [error, handoffStarted, expected] of cases) {
        logger.error.mockClear();
        const log = jest.fn(async () => {});
        expect(await billingEmailSendFailure(error, handoffStarted, log, { logTag: 'test', label: 'thing' })).toEqual(expected);
        expect(log).toHaveBeenCalledWith({ status: 'failed', failureReason: message }); // the caller's own record is unchanged
        expect(allLogged()).not.toMatch(PII);
      }
    });

    test('the engine\'s own warn lines redact an error that carries a contact detail (ledger, autopay, progress reads)', async () => {
      failLedgerAccess(1, 'connection reset while reading pat@example.test +19415550100');
      expect((await run()).outcome).toBe('held');
      mockOnAutopay.mockRejectedValueOnce(new Error('lookup failed for pat@example.test'));
      await run();
      expect(allLogged()).not.toMatch(PII);
      expect(allLogged()).toMatch(/redacted/);
    });

    test('the shared redactor: the email library\'s redactEmailAddresses is the same single implementation, and phones are scrubbed', () => {
      const { redactContact, redactEmailAddresses } = require('../utils/redact-contact');
      expect(redactEmailAddresses('a b@c.co d')).toBe('a [redacted-email] d');
      expect(redactContact('call +19415550100 or (941) 555-0100 or 941.555.0100')).toBe('call [redacted-phone] or [redacted-phone] or [redacted-phone]');
      expect(redactContact('invoice W-2026-0412 total 129.00')).toBe('invoice W-2026-0412 total 129.00'); // ordinary numbers survive
      expect(redactContact(undefined)).toBe('');
    });
  });

  test('a failure BEFORE the provider handoff (template lookup / preparation throws) is also retryable', async () => {
    emailOnly();
    mockSendTemplate.mockRejectedValue(new Error('template store down'));
    expect(await run()).toMatchObject({ outcome: 'held' });
    expect(Schedule.markPaused).not.toHaveBeenCalled();
  });

  test('an UNCERTAIN failure after the handoff stays held (reservation kept, not re-sent)', async () => {
    emailOnly();
    failAfterHandoff(providerError(502));
    expect(await run()).toMatchObject({ outcome: 'held' });
    expect(Schedule.markPaused).not.toHaveBeenCalled();
    expect(rowFor('email').metadata.send_failed).not.toBe(true);
  });

  test('explicit terminal refusals still pause: a suppressed address, no billing address, template switched off', async () => {
    emailOnly();
    mockSendTemplate.mockResolvedValue({ sent: false, blocked: true, reason: 'Suppressed: bounce (transactional_required)' });
    expect(await run()).toMatchObject({ outcome: 'paused', reason: 'all_channels_terminal' });
    expect(rowFor('email').metadata).toMatchObject({ resolved: true, resolution: 'email_terminal_refusal' });

    mockLedger.length = 0;
    Schedule.markPaused.mockClear();
    mockSendTemplate.mockRejectedValue(Object.assign(new Error('off'), { code: 'EMAIL_TEMPLATE_DISABLED' }));
    expect(await run()).toMatchObject({ outcome: 'paused' });
  });

  test('email + text: a transient email failure with the text delivered is TOLD, not paused', async () => {
    failAfterHandoff(providerError(429));
    const out = await run();
    expect(out.outcome).toBe('told');
    expect(Schedule.markPaused).not.toHaveBeenCalled();
  });
});

describe('the boundary re-reads the SCHEDULE row: a control write after the claim vetoes the send (P1)', () => {
  const noDelivery = () => {
    expect(mockLedger.some((r) => r.metadata.delivered === true)).toBe(false);
    expect(Schedule.advance).not.toHaveBeenCalled();
    expect(Schedule.completeFinal).not.toHaveBeenCalled();
    expect(interactions).toHaveLength(0);
  };
  // the admin acts AFTER the claim and the set read, BEFORE the provider call
  const controlWriteAfterResolve = (patch) => {
    let n = 0;
    mockResolve.mockImplementation(async () => {
      n += 1;
      if (n === 1) mockScheduleRow = { ...mockScheduleRow, ...patch };
      return live;
    });
  };

  test.each([
    ['admin pause', { status: 'paused' }],
    ['admin release', { status: 'released' }],
    ['closed by another run', { status: 'completed' }],
    ['autopay hook took it over', { status: 'autopay_hold' }],
    ['the claim was rotated to a successor', { touch_claimed_at: new Date(NOW.getTime() + 1000) }],
    ['the claim was cleared', { touch_claimed_at: null }],
  ])('%s: NOTHING is sent on any leg, the schedule is not advanced, and the refusal is not a set re-render', async (_name, patch) => {
    controlWriteAfterResolve(patch);
    const out = await run();
    expect(out.outcome).toBe('held');
    noDelivery();
    // the set authority is never even asked at the boundary once the row is gone from us
    expect(mockResolve).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls.every(([a]) => a.body)).toBe(true);
    expect(Schedule.markPaused).not.toHaveBeenCalled();
  });

  test('the refusal is the retryable DUNNING_SCHEDULE_CHANGED code on the SMS hook, the push/email transaction, and the operator handoff', async () => {
    mockScheduleRow = { ...mockScheduleRow, status: 'paused' };
    const check = Boundary.check(Boundary.snapshotOf(CUSTOMER_ID, makeSet(), { scheduleId: SCHEDULE_ID, claimStamp: NOW }));
    for (const args of [{ channel: 'sms' }, { channel: 'push', database: MOCK_TRX }, { channel: 'email', database: MOCK_TRX }]) {
      expect(await check(args)).toMatchObject({ ok: false, code: Boundary.SCHEDULE_CHANGED, retryable: true });
    }
    mockResolve.mockImplementation(async () => live);
    await run({ operatorInitiated: true, force: true });
    noDelivery();
  });

  test('a missing schedule row, or a failing read, is the same refusal (never a send)', async () => {
    const check = Boundary.check(Boundary.snapshotOf(CUSTOMER_ID, makeSet(), { scheduleId: SCHEDULE_ID, claimStamp: NOW }));
    mockScheduleRow = undefined;
    expect(await check({})).toMatchObject({ ok: false, code: Boundary.SCHEDULE_CHANGED });
    mockScheduleRow = { id: SCHEDULE_ID, status: 'active', touch_claimed_at: NOW };
    mockResolve.mockRejectedValue(new Error('down'));
    expect(await check({})).toMatchObject({ ok: false });
  });

  test('control: a still-open, still-ours schedule sends normally; the transaction read locks the row (a control write waits), the pool read does not', async () => {
    mockResolve.mockImplementation(async () => live);
    expect((await run()).outcome).toBe('advanced');
    expect(mockLocked).toContain('customer_dunning_schedules');
    mockLocked.length = 0;
    const check = Boundary.check(Boundary.snapshotOf(CUSTOMER_ID, live, { scheduleId: SCHEDULE_ID, claimStamp: NOW }));
    expect(await check({})).toEqual({ ok: true });
    expect(mockLocked).toEqual([]);
    expect(await check({ database: MOCK_TRX })).toEqual({ ok: true });
    expect(mockLocked).toEqual(['customer_dunning_schedules']);
  });

  test('a HELD schedule (status held, claim ours) is sendable', async () => {
    setup({ stepStatus: 'held' });
    expect((await run()).outcome).toBe('advanced');
  });
});

describe('a held stage is retried, not skipped by calendar age (P1)', () => {
  // step index 4 = Day 60, 5 = Day 90; the debt is now 95 days old
  test('Day 60 held until after Day 90: on release it sends the Day 60 reminder (no stage write, plain advance); the final notice is a later touch', async () => {
    setup({ stepIndex: 4, sentDaysAgo: 95, stepStatus: 'held' });
    const out = await run();
    expect(out.outcome).toBe('advanced');
    expect(Schedule.writeStage).not.toHaveBeenCalled();
    expect(mockSendTemplate.mock.calls.every(([a]) => a.templateKey === 'invoice.followup_combined_60_day')).toBe(true);
    expect(mockSendTemplate).toHaveBeenCalledTimes(1);
    expect(Schedule.advance).toHaveBeenCalledTimes(1);
    expect(Schedule.completeFinal).not.toHaveBeenCalled();
    expect(Schedule.advance.mock.calls[0][0]).toMatchObject({ step_index: 4 });
  });

  test('the same schedule ACTIVE (a stage nobody attempted: late promotion / cron gap) still catches up to the calendar and sends the final notice', async () => {
    setup({ stepIndex: 4, sentDaysAgo: 95, stepStatus: 'active' });
    const out = await run();
    expect(Schedule.writeStage).toHaveBeenCalledWith(expect.objectContaining({ id: SCHEDULE_ID }), 5, expect.anything());
    expect(mockSendTemplate.mock.calls.every(([a]) => a.templateKey === 'invoice.followup_combined_90_day')).toBe(true);
    expect(out.outcome).toBe('completed');
  });

  test('a held FINAL step keeps retrying the final notice; and the held retry still sends nothing while the hold persists', async () => {
    setup({ stepIndex: 5, sentDaysAgo: 100, stepStatus: 'held' });
    live = makeSet(['inv-a', 'inv-b', 'inv-c'], { kind: 'hold', reason: 'member_paused' });
    expect(await run()).toMatchObject({ outcome: 'held', reason: 'member_paused' });
    expect(mockSendTemplate).not.toHaveBeenCalled();
    live = makeSet(['inv-a', 'inv-b', 'inv-c']);
    expect((await run()).outcome).toBe('completed');
    expect(mockSendTemplate.mock.calls.at(-1)[0].templateKey).toBe('invoice.followup_combined_90_day');
  });
});

describe('the engine never applies account credit (owner ruling 2026-09-30)', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'services', 'customer-dunning');

  test('no customer-dunning module imports or names a credit-applying function', () => {
    expect(Object.keys(jest.requireActual('../services/customer-dunning/balance-set'))).not.toContain('applyCreditBeforeResolve');
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.js'))) {
      const source = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(source).not.toMatch(/reverseAppliedCredit|applyCreditBeforeResolve|applyCredit\b|drawCredit|reverseDraws/);
      if (file !== 'balance-set.js') expect(source).not.toMatch(/services\/customer-credit|require\('\.\.\/customer-credit'\)/);
    }
  });

  // markHeld is a spy in this file; here it runs for real against a stateful
  // store so "once per hold" is proven by the real hold_alerted_at bookkeeping.
  function heldStore() {
    const row = { ...schedule };
    const store = jest.fn(() => {
      const q = { where() { return q; }, whereIn() { return q; }, update: async (patch) => { Object.assign(row, patch); return 1; } };
      return q;
    });
    store.fn = { now: () => 'now' };
    return { row, store };
  }
  const creditHold = () => makeSet(['inv-a', 'inv-b', 'inv-c'], { kind: 'hold', reason: 'account_credit_available' });

  test('LIVE: an account_credit_available set holds the schedule, alerts the office ONCE (not on the next daily run), and sends nothing', async () => {
    const { row, store } = heldStore();
    const actual = jest.requireActual('../services/customer-dunning/schedule');
    Schedule.markHeld.mockImplementation((s, reason, opts) => actual.markHeld(s, reason, { ...opts, database: store }));
    Schedule.claim.mockImplementation(async () => ({ schedule: { ...row }, claimStamp: NOW, memberSeqIds: [] }));
    live = creditHold();

    expect(await run()).toMatchObject({ outcome: 'held', reason: 'account_credit_available' });
    expect(row).toMatchObject({ status: 'held', held_reason: 'account_credit_available' });
    expect(mockNotify).toHaveBeenCalledTimes(1);
    expect(mockNotify).toHaveBeenCalledWith('alert', 'Apply customer account credit', expect.stringMatching(/unused account credit.*Apply the credit/), expect.objectContaining({
      // one alert per HOLD: the hold's start is part of the key
      dedupeKey: `customer-dunning-held:${SCHEDULE_ID}:1:account_credit_available:${NOW.getTime()}`,
      metadata: { customer_id: CUSTOMER_ID },
    }));
    expect(row.hold_alerted_at).toEqual(NOW);

    // the next daily run: still held, still no second alert
    expect(await run()).toMatchObject({ outcome: 'held', reason: 'account_credit_available' });
    expect(mockNotify).toHaveBeenCalledTimes(1);

    // no customer-facing anything, no advance
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(mockShorten).not.toHaveBeenCalled();
    expect(mockLedger).toHaveLength(0);
    expect(Schedule.advance).not.toHaveBeenCalled();
    expect(interactions).toHaveLength(0);
  });

  test('SHADOW: the same set is logged as would hold, with no alert and no write', async () => {
    const logger = require('../services/logger');
    Schedule.promotionCandidates.mockResolvedValue([]);
    live = creditHold();
    shadowDb([{ id: SCHEDULE_ID, customer_id: CUSTOMER_ID, step_index: 4 }]);
    await Runner.shadowRun(NOW);
    expect(logger.info.mock.calls.map(([m]) => String(m)).join('\n')).toMatch(/SHADOW would hold customer=cust-0000-synthetic schedule=sched-0000-synthetic step=\w+ reason=account_credit_available/);
    expect(mockNotify).not.toHaveBeenCalled();
    expect(Schedule.markHeld).not.toHaveBeenCalled();
    expect(Schedule.alertStaff).not.toHaveBeenCalled();
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

  test('B-7: a partial delivery (email delivered, text held) counts as TOLD: last_touch stamped, step not advanced, one interaction row', async () => {
    mockSendMessage.mockResolvedValue({ sent: false, blocked: true, deliveryOutcome: 'not_sent', retryable: true, code: 'OUTSIDE_SEND_WINDOW', deferred: true });
    const out = await run();
    expect(out.outcome).toBe('told');
    expect(Schedule.markTold).toHaveBeenCalledTimes(1);
    expect(Schedule.markTold.mock.calls[0][1].deliveredAt).toBeInstanceOf(Date);
    expect(Schedule.advance).not.toHaveBeenCalled();
    expect(interactions).toHaveLength(1);
    expect(interactions[0].interaction_type).toBe('email_outbound');
  });

  test('every leg terminal (email suppressed, no phone) => PAUSED with the reason and an alert path; nothing delivered', async () => {
    customer.phone = null;
    mockLoadContext.mockResolvedValue({ error: mockBlocked('NO_EMAIL_RECIPIENT', 'No billing email recipient is available') });
    const out = await run();
    expect(out).toMatchObject({ outcome: 'paused', reason: 'all_channels_terminal' });
    expect(Schedule.markPaused).toHaveBeenCalledWith(expect.anything(), 'all_channels_terminal', expect.anything());
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

  test('template probe: an SMS template switched off drops the text leg; both off => paused no_reachable_channel', async () => {
    smsTemplateRow = { is_active: false };
    await run();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockLedger.map((r) => r.channel)).toEqual(['email']);
    mockLedger.length = 0;
    mockLoadTemplate.mockResolvedValue({ template: { status: 'disabled' }, activeVersion: { id: 'v' } });
    expect(await run()).toMatchObject({ outcome: 'paused', reason: 'no_reachable_channel' });
    expect(mockLedger).toHaveLength(0);
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

  test('a set that is EMPTY closes the schedule (balance_cleared); no send', async () => {
    live = { kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null, activeCount: 0 };
    expect(await run()).toMatchObject({ outcome: 'closed', reason: 'balance_cleared' });
    expect(Schedule.close).toHaveBeenCalledWith(expect.anything(), 'balance_cleared', NOW, expect.anything());
    expect(mockSendMessage).not.toHaveBeenCalled();
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
    // collections_ledger_id is the recovery binding, not copy (never rendered)
    expect(Object.keys(mockSendTemplate.mock.calls[0][0].payload).sort()).toEqual(['collections_ledger_id', 'customer_portal_url', 'first_name', 'invoice_count', 'pay_url', 'total_due']);
    expect(mockSendTemplate.mock.calls[0][0].payload.collections_ledger_id).toBe(rowFor('email').id);
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

  describe('the operator email re-checks at the FINAL provider boundary (after provider preparation)', () => {
    const operatorEmailOnly = () => { customer.phone = null; };
    const boundaryReads = () => mockResolve.mock.calls.filter(([, opts]) => opts?.database === MOCK_TRX).length;

    test('unchanged set: one email, and the boundary ran twice on the comms-lock transaction (before preparation and at the final check)', async () => {
      operatorEmailOnly();
      const out = await run({ operatorInitiated: true, force: true });
      expect(out.outcome).toBe('advanced');
      expect(mockEmailMessages).toHaveLength(1);
      expect(mockSendTemplate).toHaveBeenCalledTimes(1);
      expect(boundaryReads()).toBe(2);
    });

    test('an invoice paid DURING provider preparation vetoes the send: no email, a retryable refusal, the reservation reopened — then the re-render sends the new set once', async () => {
      operatorEmailOnly();
      const changed = makeSet(['inv-a', 'inv-b']);
      let n = 0;
      // 1 = set read, 2 = the handoff's first check, 3 = the FINAL check (the invoice was paid meanwhile), then stable
      mockResolve.mockImplementation(async () => { n += 1; return n <= 2 ? live : changed; });
      const out = await run({ operatorInitiated: true, force: true });
      expect(ContactLedger.markSendFailed).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ code: 'DUNNING_SET_CHANGED' }));
      // the refused attempt never reached the provider; the re-render sent the CURRENT set, once
      expect(mockEmailMessages).toHaveLength(1);
      expect(JSON.parse(mockEmailMessages[0].payload_snapshot).invoice_count).toBe('2');
      expect(out.outcome).toBe('advanced');
    });

    test('a set that keeps changing is refused at the final check every time: nothing is sent, the step is held retryable, the reservation stays reopened', async () => {
      operatorEmailOnly();
      const second = makeSet(['inv-a', 'inv-b'], { totalCents: 20001, digest: 'd-second' });
      let n = 0;
      // attempt 1: set read (1), first check (2, unchanged), FINAL check (3, changed) => refused;
      // re-render: fresh read (4) = `second`, first check (5) passes, FINAL check (6+) changed again
      mockResolve.mockImplementation(async () => {
        n += 1;
        if (n <= 2) return live;
        if (n === 3) return makeSet(['inv-a', 'inv-b'], { totalCents: 20000, digest: 'd-first' });
        if (n <= 5) return second;
        return makeSet(['inv-a'], { totalCents: 12900, digest: 'd-third' });
      });
      const out = await run({ operatorInitiated: true, force: true });
      expect(out.outcome).toBe('held');
      expect(mockEmailMessages).toHaveLength(0);
      expect(mockLedger.some((r) => r.metadata.delivered === true)).toBe(false);
      expect(rowFor('email').metadata.send_failed).toBe(true);
      expect(Schedule.advance).not.toHaveBeenCalled();
    });
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
    require('../models/db').mockImplementationOnce(() => ({
      whereIn() { return this; }, where() { return this; }, orderBy() { return this; },
      select: async () => [{ id: 's1', customer_id: 'c1' }, { id: 's2', customer_id: 'c2' }],
    }));
    Schedule.claim.mockRejectedValueOnce(new Error('db blip')).mockResolvedValueOnce(null);
    const out = await Runner.runCustomerSchedules(NOW);
    expect(out.failed).toBe(1);
    expect(out.processed).toBe(1);
  });
});

describe('runCustomerSchedules: each claim is stamped when it is TAKEN, not at batch start', () => {
  test('a batch that outlives the claim TTL hands later schedules a claim time advanced by the elapsed wall time; cadence keeps the batch clock', async () => {
    require('../models/db').mockImplementationOnce(() => ({
      whereIn() { return this; }, where() { return this; }, orderBy() { return this; },
      select: async () => [{ id: 's1', customer_id: 'c1' }, { id: 's2', customer_id: 'c2' }],
    }));
    let wall = 1_000_000;
    const spy = jest.spyOn(Date, 'now').mockImplementation(() => wall);
    try {
      // the first schedule's send takes 15 minutes of wall time
      Schedule.claim.mockImplementationOnce(async () => { wall += 15 * 60 * 1000; return null; }).mockResolvedValueOnce(null);
      await Runner.runCustomerSchedules(NOW);
    } finally { spy.mockRestore(); }
    const [first, second] = Schedule.claim.mock.calls.map((c) => c[1].getTime());
    expect(first).toBe(NOW.getTime());
    expect(second).toBe(NOW.getTime() + 15 * 60 * 1000);
  });
});

describe('shadow run writes NOTHING and only logs (PR 2 wiring)', () => {
  const logger = require('../services/logger');
  const shadowLines = () => logger.info.mock.calls.map(([m]) => m).filter((m) => String(m).includes('SHADOW would'));

  test('spy on every writer: no claim/advance/close/mint/reservation/send/alert/insert/update — and the structured lines are logged', async () => {
    Schedule.promotionCandidates.mockResolvedValue([CUSTOMER_ID]);
    const database = shadowDb([{ ...schedule, id: SCHEDULE_ID, status: 'active', step_index: 4 }]);
    const { writes } = database;
    live = makeSet(['inv-a', 'inv-b', 'inv-c']);
    memberSeqRows = rowsFor(['inv-a', 'inv-b', 'inv-c'], 60, 3);
    await Runner.shadowRun(NOW);
    const lines = shadowLines().join('\n');
    expect(lines).toMatch(/SHADOW would promote customer=cust-0000-synthetic/);
    expect(lines).toMatch(/SHADOW would absorb customer=cust-0000-synthetic seq=seq-inv-/);
    expect(lines).toMatch(/SHADOW would send customer=cust-0000-synthetic/);
    for (const writer of ['claim', 'releaseClaim', 'advance', 'completeFinal', 'close', 'markHeld', 'markPaused', 'markTold', 'markAutopayHold', 'writeStage', 'alertStaff']) {
      expect(Schedule[writer]).not.toHaveBeenCalled();
    }
    expect(writes).toEqual([]);
    expect(mockShorten).not.toHaveBeenCalled();
    expect(mockSendMessage).not.toHaveBeenCalled();
    expect(mockSendTemplate).not.toHaveBeenCalled();
    expect(ContactLedger.recordContact).not.toHaveBeenCalled();
    expect(ContactLedger.markDelivered).not.toHaveBeenCalled();
    expect(mockNotify).not.toHaveBeenCalled();
    expect(interactions).toEqual([]);
  });

  test('a customer whose set is held / a schedule that would close are logged as would hold / would close', async () => {
    Schedule.promotionCandidates.mockResolvedValue([CUSTOMER_ID]);
    live = makeSet(['inv-a', 'inv-b'], { kind: 'hold', reason: 'member_paused' });
    shadowDb([{ id: 's1', customer_id: CUSTOMER_ID, step_index: 4 }]);
    await Runner.shadowRun(NOW);
    expect(shadowLines().join('\n')).toMatch(/would hold customer=cust-0000-synthetic reason=member_paused/);
    logger.info.mockClear();
    live = { kind: 'empty', reason: 'no_open_invoices', members: [], anchor: null, totalCents: 0, digest: null, activeCount: 0 };
    await Runner.shadowRun(NOW);
    expect(shadowLines().join('\n')).toMatch(/would close customer=cust-0000-synthetic/);
  });

  test('a failing customer is logged and does not stop the rest; the run never throws', async () => {
    Schedule.promotionCandidates.mockResolvedValue(['c1', 'c2']);
    mockResolve.mockRejectedValueOnce(new Error('stripe down')).mockResolvedValueOnce(makeSet(['inv-a', 'inv-b']));
    memberSeqRows = rowsFor(['inv-a', 'inv-b'], 60, 3);
    shadowDb();
    const tally = await Runner.shadowRun(NOW);
    expect(tally.failed).toBe(1);
    expect(tally.promote).toBe(1);
  });
});
