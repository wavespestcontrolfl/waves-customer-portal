// Day 60/90 ladder steps (GATE_DUNNING_LADDER_90) inherit the legacy
// balance-reminder's at-risk pipeline-stage stamp for the same debt-age
// tiers (Codex P2, dunning unification 2026-09-28): retiring the legacy
// cron under GATE_BALANCE_REMINDER_LEGACY_OFF must not silently drop that
// side effect. invoice-followups.js's fireTouch calls the SAME shared
// helper (markAtRiskForLongOverdue, also used by balance-reminder.js's own
// 60/90-day branches and late-payment-checker.js's tiers) right after a Day
// 60 or Day 90 step confirms delivery — fresh OR deduped (round-2 review:
// a replay that only re-confirms an already-delivered leg must not lose the
// stamp either), and BEFORE the freshDelivery early return, not after.
// Round-2 review also found the stamp must never overwrite a churned/
// archived customer's stage (Codex P1) — markAtRiskForLongOverdue itself
// restricts the update to active, non-former-customer-stage rows.
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/billing-channel-email-authority', () => ({
  loadBillingEmailContext: jest.fn(),
  dispatchUnderBillingEmailAuthority: jest.fn(),
}));
jest.mock('../services/collections/contact-ledger', () => ({
  recordContact: jest.fn(async () => ({ id: 'led-1', metadata: {} })),
  markSendFailed: jest.fn(async () => true),
  markDelivered: jest.fn(async () => true),
  claimAttempt: jest.fn(async () => ({ allowed: true })),
}));
jest.mock('../services/customer-credit', () => ({
  autoApplyAccountCreditIfEnabled: jest.fn(async () => ({ applied: 0 })),
  reverseAppliedCredit: jest.fn(async () => ({ reversed: 0 })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../routes/admin-sms-templates', () => ({ getTemplate: jest.fn(async () => 'invoice follow-up sms') }));
jest.mock('../services/short-url', () => ({
  shortenOrPassthrough: jest.fn(async () => 'https://portal.wavespestcontrol.com/l/inv123'),
  invoiceShortCodePrefix: jest.fn(() => 'INV'),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, blocked: false, deliveryOutcome: 'accepted', providerMessageId: 'sms-1' })),
}));
jest.mock('../services/email-template-library', () => ({
  sendTemplate: jest.fn(async () => ({ sent: true, message: { provider_message_id: 'sg-1', sent_at: '2026-05-26T14:00:00.000Z' } })),
}));
jest.mock('../services/customer-contact', () => ({
  getInvoiceEmailRecipients: jest.fn(() => [{ email: 'billing@example.com', name: 'Taylor' }]),
}));
// Controlled directly (rather than left real, gate-off-permissive) so the
// "undelivered" pin can force a clean, documented early exit — the
// collections-policy-denies-every-selected-channel branch — without having
// to fight the real rail guard's own dependency chain.
jest.mock('../services/collections/rail-guard', () => ({
  collectionsChannelPermitted: jest.fn(async () => ({ allowed: true })),
}));

const db = require('../models/db');
const BillingEmailAuthority = require('../services/billing-channel-email-authority');
const RailGuard = require('../services/collections/rail-guard');
const InvoiceFollowUps = require('../services/invoice-followups');

function chain({ result = [], first } = {}) {
  const q = {};
  ['join', 'where', 'whereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereNotExists', 'select', 'orderBy', 'forUpdate']
    .forEach((method) => { q[method] = jest.fn(() => q); });
  q.insert = jest.fn(() => q);
  q.update = jest.fn(() => q);
  q.first = jest.fn(async () => first);
  q.returning = jest.fn(async () => []);
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  q.catch = (reject) => Promise.resolve(result).catch(reject);
  return q;
}

function setDbQueues(queues) {
  const tableQueues = new Map(Object.entries(queues));
  db.mockImplementation((table) => {
    const queue = tableQueues.get(table);
    if ((!queue || !queue.length) && table === 'notification_prefs') return chain({ first: undefined });
    if ((!queue || !queue.length) && table === 'collections_contact_ledger') return chain({ result: [] });
    if (!queue || !queue.length) throw new Error(`Unexpected db table ${table}`);
    return queue.shift();
  });
}

function followupRow(overrides = {}) {
  return {
    id: 'seq-1', invoice_id: 'inv-1', customer_id: 'cust-1', step_index: 0,
    next_touch_at: '2026-05-26T13:00:00.000Z', touches_sent: 0, token: 'token-1',
    title: 'Quarterly Pest Control', total: '129.00', status: 'active',
    service_date: '2026-05-12', due_date: '2026-05-19', invoice_number: 'WPC-2026-1042',
    invoice_created_at: '2026-05-20T12:00:00.000Z', invoice_payer_id: null, invoice_send_error: null,
    ...overrides,
  };
}

function customer(overrides = {}) {
  return { id: 'cust-1', first_name: 'Taylor', last_name: 'Morgan', email: 'taylor@example.com', phone: '+19415550101', ...overrides };
}

function invoice(overrides = {}) {
  return {
    id: 'inv-1', customer_id: 'cust-1', invoice_number: 'WPC-2026-1042', status: 'sent',
    title: 'Quarterly Pest Control', total: '129.00', due_date: '2026-05-19', service_date: '2026-05-12', token: 'token-1',
    ...overrides,
  };
}

const AT_RISK_UPDATE = { pipeline_stage: 'at_risk', pipeline_stage_changed_at: expect.any(Date) };

beforeEach(() => {
  jest.useFakeTimers().setSystemTime(new Date('2026-05-26T14:00:00.000Z'));
  jest.clearAllMocks();
  process.env.GATE_DUNNING_LADDER_90 = 'true';
  process.env.GATE_BALANCE_REMINDER_LEGACY_OFF = 'true';
  RailGuard.collectionsChannelPermitted.mockResolvedValue({ allowed: true });
  BillingEmailAuthority.loadBillingEmailContext.mockResolvedValue({
    category: 'invoice', recipient: { email: 'billing@example.com', name: 'Taylor' }, recipientEmail: 'billing@example.com',
  });
  BillingEmailAuthority.dispatchUnderBillingEmailAuthority.mockImplementation(async ({ dispatch, state }) => {
    state.handoffStarted = true;
    await dispatch('authority-trx');
    state.providerAccepted = true;
    return { ok: true };
  });
  db.transaction = jest.fn(async (fn) => fn(db));
  db.fn = { now: jest.fn(() => 'CURRENT_TIMESTAMP') };
});

afterEach(() => {
  jest.useRealTimers();
  delete process.env.GATE_DUNNING_LADDER_90;
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
});

test('a delivered Day 60 touch stamps at_risk exactly as the legacy path would', async () => {
  const atRiskChain = chain();
  const sequenceUpdate = chain();
  setDbQueues({
    'invoice_followup_sequences as s': [chain({ result: [] }), chain({ result: [followupRow({ step_index: 4, next_touch_at: '2030-01-01T14:00:00.000Z' })] })],
    customers: [chain({ first: customer() }), atRiskChain],
    invoices: Array.from({ length: 6 }, () => chain({ first: invoice() })),
    notification_prefs: [chain({ first: { email_enabled: true } })],
    customer_interactions: [chain(), chain()],
    invoice_followup_sequences: [
      chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 4, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
      chain({ result: 1 }),
      sequenceUpdate,
      chain({ result: 1 }),
    ],
  });

  const result = await InvoiceFollowUps.runPending();

  expect(result).toEqual({ sent: 1, skipped: 0 });
  expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 5 }));
  expect(atRiskChain.update).toHaveBeenCalledWith(AT_RISK_UPDATE);
  // The churned-customer guard (Codex P1, round 2): the update is restricted
  // to active, non-former-customer-stage rows — never an unconditional
  // where({ id }).
  expect(atRiskChain.where).toHaveBeenCalledWith({ id: 'cust-1' });
  expect(atRiskChain.where).toHaveBeenCalledWith('active', true);
  // Only live customer stages move (or NULL, a legacy row): a lead, a lost
  // record and a former customer never become at_risk here.
  const stageGuard = atRiskChain.where.mock.calls.find(([arg]) => typeof arg === 'function')?.[0];
  expect(stageGuard).toBeInstanceOf(Function);
  const builder = { whereNull: jest.fn(() => builder), orWhereIn: jest.fn(() => builder) };
  stageGuard.call(builder);
  expect(builder.whereNull).toHaveBeenCalledWith('pipeline_stage');
  expect(builder.orWhereIn).toHaveBeenCalledWith(
    'pipeline_stage', ['active_customer', 'won', 'at_risk'],
  );
});

test('legacy retirement off: a delivered Day 60 touch leaves the stage alone (the legacy cron still owns the stamp)', async () => {
  delete process.env.GATE_BALANCE_REMINDER_LEGACY_OFF;
  const sequenceUpdate = chain();
  const atRiskChain = chain();
  setDbQueues({
    'invoice_followup_sequences as s': [chain({ result: [] }), chain({ result: [followupRow({ step_index: 4, next_touch_at: '2030-01-01T14:00:00.000Z' })] })],
    customers: [chain({ first: customer() }), atRiskChain],
    invoices: Array.from({ length: 6 }, () => chain({ first: invoice() })),
    notification_prefs: [chain({ first: { email_enabled: true } })],
    customer_interactions: [chain(), chain()],
    invoice_followup_sequences: [
      chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 4, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
      chain({ result: 1 }),
      sequenceUpdate,
      chain({ result: 1 }),
    ],
  });

  const result = await InvoiceFollowUps.runPending();

  expect(result).toEqual({ sent: 1, skipped: 0 });
  expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 5 }));
  expect(atRiskChain.update).not.toHaveBeenCalled();
});

test('a Day 60 touch diverted to the bank-verification nudge (pending microdeposits) never stamps at_risk', async () => {
  const StripeService = require('../services/stripe');
  const mdSpy = jest.spyOn(StripeService, 'isInvoiceAwaitingMicrodepositVerification').mockResolvedValue(true);
  try {
    const atRiskChain = chain();
    setDbQueues({
      'invoice_followup_sequences as s': [chain({ result: [] }), chain({ result: [followupRow({ step_index: 4, next_touch_at: '2030-01-01T14:00:00.000Z' })] })],
      customers: [chain({ first: customer() }), atRiskChain],
      invoices: Array.from({ length: 6 }, () => chain({ first: invoice() })),
      notification_prefs: [chain({ first: { email_enabled: true } })],
      customer_interactions: [chain(), chain()],
      invoice_followup_sequences: [
        chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 4, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
        chain({ result: 1 }),
        chain(),
        chain({ result: 1 }),
      ],
    });

    await InvoiceFollowUps.runPending();

    expect(mdSpy).toHaveBeenCalled();
    expect(atRiskChain.update).not.toHaveBeenCalled();
  } finally {
    mdSpy.mockRestore();
  }
});

test('a deduped Day 60 replay (every leg already delivered — freshDelivery false) still stamps at_risk', async () => {
  const ContactLedger = require('../services/collections/contact-ledger');
  ContactLedger.claimAttempt.mockResolvedValue({ delivered: true, allowed: true });
  const atRiskChain = chain();
  const sequenceUpdate = chain();
  setDbQueues({
    'invoice_followup_sequences as s': [chain({ result: [] }), chain({ result: [followupRow({ step_index: 4, next_touch_at: '2030-01-01T14:00:00.000Z' })] })],
    customers: [chain({ first: customer() }), atRiskChain],
    invoices: Array.from({ length: 6 }, () => chain({ first: invoice() })),
    notification_prefs: [chain({ first: { email_enabled: true } })],
    customer_interactions: [chain(), chain()],
    invoice_followup_sequences: [
      chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 4, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
      chain({ result: 1 }),
      sequenceUpdate,
      chain({ result: 1 }),
    ],
  });

  const result = await InvoiceFollowUps.runPending();

  expect(result).toEqual({ sent: 1, skipped: 0 });
  // The step still advances (a fully deduped touch is not undelivered)...
  expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 5 }));
  // ...and, unlike before this fix, the dedupe/replay path does not lose
  // the at-risk transition just because nothing NEW went out this run.
  expect(atRiskChain.update).toHaveBeenCalledWith(AT_RISK_UPDATE);
});

test('a delivered Day 90 touch stamps at_risk', async () => {
  const atRiskChain = chain();
  const sequenceUpdate = chain();
  setDbQueues({
    'invoice_followup_sequences as s': [chain({ result: [] }), chain({ result: [followupRow({ step_index: 5, next_touch_at: '2030-01-01T14:00:00.000Z' })] })],
    customers: [chain({ first: customer() }), atRiskChain],
    invoices: Array.from({ length: 6 }, () => chain({ first: invoice() })),
    notification_prefs: [chain({ first: { email_enabled: true } })],
    customer_interactions: [chain(), chain()],
    invoice_followup_sequences: [
      chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 5, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
      chain({ result: 1 }),
      sequenceUpdate,
      chain({ result: 1 }),
    ],
  });

  const result = await InvoiceFollowUps.runPending();

  expect(result).toEqual({ sent: 1, skipped: 0 });
  expect(atRiskChain.update).toHaveBeenCalledWith(AT_RISK_UPDATE);
});

test('a delivered Day 30 touch does not stamp at_risk', async () => {
  const atRiskChain = chain();
  const sequenceUpdate = chain();
  setDbQueues({
    'invoice_followup_sequences as s': [chain({ result: [] }), chain({ result: [followupRow({ step_index: 3, next_touch_at: '2030-01-01T14:00:00.000Z' })] })],
    customers: [chain({ first: customer() }), atRiskChain],
    invoices: Array.from({ length: 6 }, () => chain({ first: invoice() })),
    notification_prefs: [chain({ first: { email_enabled: true } })],
    customer_interactions: [chain(), chain()],
    invoice_followup_sequences: [
      chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 3, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
      chain({ result: 1 }),
      sequenceUpdate,
      chain({ result: 1 }),
    ],
  });

  const result = await InvoiceFollowUps.runPending();

  expect(result).toEqual({ sent: 1, skipped: 0 });
  expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 4 }));
  expect(atRiskChain.update).not.toHaveBeenCalled();
});

test('an undelivered Day 60 touch (every selected channel policy-denied) does not stamp at_risk', async () => {
  RailGuard.collectionsChannelPermitted.mockResolvedValue({ allowed: false, durable: true });
  const atRiskChain = chain();
  setDbQueues({
    'invoice_followup_sequences as s': [chain({ result: [] }), chain({ result: [followupRow({ step_index: 4, next_touch_at: '2030-01-01T14:00:00.000Z' })] })],
    customers: [chain({ first: customer() }), atRiskChain],
    invoices: Array.from({ length: 4 }, () => chain({ first: invoice() })),
    notification_prefs: [chain({ first: {} })],
    invoice_followup_sequences: [
      chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 4, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
      chain({ result: 1 }),
      chain({ result: 1 }),
    ],
  });

  const result = await InvoiceFollowUps.runPending();

  // sent counts "fireStep ran without throwing," not "a message went out" —
  // the policy-denied early return inside fireTouch is not an error, so
  // this is 1 either way; what proves nothing delivered is the assertion
  // below, on the SAME shared helper the delivered-path tests assert on.
  expect(result).toEqual({ sent: 1, skipped: 0 });
  expect(atRiskChain.update).not.toHaveBeenCalled();
});

test('a transient at-risk stamp failure never blocks the touch itself (Codex P1: guarded, not bare-awaited)', async () => {
  const sequenceUpdate = chain();
  const atRiskChain = chain();
  atRiskChain.update = jest.fn(() => { throw new Error('connection reset'); });
  setDbQueues({
    'invoice_followup_sequences as s': [chain({ result: [] }), chain({ result: [followupRow({ step_index: 4, next_touch_at: '2030-01-01T14:00:00.000Z' })] })],
    customers: [chain({ first: customer() }), atRiskChain],
    invoices: Array.from({ length: 6 }, () => chain({ first: invoice() })),
    notification_prefs: [chain({ first: { email_enabled: true } })],
    customer_interactions: [chain(), chain()],
    invoice_followup_sequences: [
      chain({ first: { id: 'seq-1', customer_id: 'cust-1', status: 'active', step_index: 4, next_touch_at: '2026-05-26T13:00:00.000Z', anchor_at: null } }),
      chain({ result: 1 }),
      sequenceUpdate,
      chain({ result: 1 }),
    ],
  });

  const result = await InvoiceFollowUps.runPending();

  // The delivered touch still counts as sent (step advanced, interaction
  // logged) even though the best-effort pipeline_stage stamp threw.
  expect(result).toEqual({ sent: 1, skipped: 0 });
  expect(sequenceUpdate.update).toHaveBeenCalledWith(expect.objectContaining({ step_index: 5 }));
});
