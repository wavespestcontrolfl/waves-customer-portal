const mockState = {
  gratitudeGate: true,
  generalGate: false,
  activation: null,
  draft: null,
  inbound: null,
  history: [],
  customers: [],
  activeClaim: false,
  pendingDecision: false,
  openRequest: false,
  openCallCommitment: false,
  openSmsCommitment: false,
  openTriage: false,
  openOperatorItem: false,
  intentMode: 'auto_send',
  threadAdvanced: false,
  decisionCustomerScope: false,
  decisionThreadScope: false,
  aliasFirsts: 0,
};

jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = {};
    let operation = null;
    for (const method of [
      'whereNull', 'whereNotNull', 'whereRaw', 'whereNotIn', 'whereIn',
      'leftJoin', 'join', 'orderBy', 'limit', 'onConflict', 'ignore',
    ]) q[method] = jest.fn(() => q);
    q.where = jest.fn((...args) => {
      if (typeof args[0] === 'function') args[0].call(q);
      if (table === 'agent_decisions as ad' && args[0] === 'ad.customer_id') mockState.decisionCustomerScope = true;
      return q;
    });
    q.orWhereRaw = jest.fn(() => {
      if (table === 'agent_decisions as ad') mockState.decisionThreadScope = true;
      return q;
    });
    q.orWhere = jest.fn(() => q);
    let excludesId = false;
    q.whereNot = jest.fn(() => { excludesId = true; return q; });
    q.first = jest.fn(async () => {
      if (table === 'message_drafts') return mockState.draft;
      if (table === 'sms_log') return excludesId
        ? (mockState.threadAdvanced ? { id: 'later-thread-row' } : null)
        : mockState.inbound;
      if (table === 'sms_intent_modes') return { mode: mockState.intentMode };
      if (table === 'service_requests') return mockState.openRequest ? { id: 'request-1' } : null;
      if (table === 'call_commitments as cc') return mockState.openCallCommitment ? { id: 'call-commitment-1' } : null;
      if (table === 'call_commitments as cc_sms') return mockState.openSmsCommitment ? { id: 'sms-commitment-1' } : null;
      if (table === 'triage_items as ti') return mockState.openTriage ? { id: 'triage-1' } : null;
      if (table === 'operator_inbox_items as oi') return mockState.openOperatorItem ? { id: 'operator-item-1' } : null;
      if (table === 'agent_decisions as ad') {
        mockState.aliasFirsts += 1;
        return mockState.aliasFirsts === 1
          ? (mockState.activeClaim ? { id: 'active-claim' } : null)
          : (mockState.pendingDecision ? { id: 'pending-decision' } : null);
      }
      return null;
    });
    q.select = jest.fn(async () => {
      if (table === 'customers') return mockState.customers;
      if (table === 'sms_log') return mockState.history;
      return [];
    });
    q.insert = jest.fn(() => { operation = 'insert'; return q; });
    q.returning = jest.fn(async () => operation === 'insert' ? [{ id: 'claim-1' }] : []);
    q.update = jest.fn(async () => 1);
    q.del = jest.fn(async () => 1);
    return q;
  });
  db.transaction = jest.fn(async (work) => work(db));
  db.raw = jest.fn(() => ({}));
  return db;
});

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => gate === 'smsGratitudeReplies' ? mockState.gratitudeGate : gate === 'smsAutoSend' ? mockState.generalGate : false),
  gateEnvTimestamp: jest.fn(() => mockState.activation),
}));
jest.mock('../services/sms-suggest-mode', () => ({
  suggestionEligible: jest.fn(() => true),
  getIntentMode: jest.fn(async () => 'auto_send'),
  hasRedactionPlaceholder: jest.fn(() => false),
  hasPriceQuote: jest.fn(() => false),
  lockSuggestThread: jest.fn(async () => {}),
  threadHasLiveAnswer: jest.fn(async () => null),
  createReplyHoldingReservation: jest.fn(async () => 'reservation-1'),
  settleReplyHoldingReservation: jest.fn(async () => true),
  reopenScheduledSuggestions: jest.fn(async () => 0),
  ignoreParkedSuggestions: jest.fn(async () => 0),
}));
jest.mock('../services/sms-shadow-drafter', () => ({
  PROMPT_VERSION: 'house_voice_v11',
  resolveEffectiveVoiceProfile: jest.fn(async () => ({ version: null })),
}));
jest.mock('../services/sms-graduation', () => ({
  evaluateAutoSendEligibility: jest.fn(async () => ({ eligible: true, blockers: [] })),
}));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));

const suggest = require('../services/sms-suggest-mode');
const graduation = require('../services/sms-graduation');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const db = require('../models/db');
const {
  GRATITUDE_INTENT,
  GRATITUDE_POLICY_VERSION,
  buildGratitudeReply,
} = require('../services/sms-gratitude');
const autoSend = require('../services/sms-auto-send');
const gratitudeContext = require('../services/sms-gratitude-context');
const actualSuggestMode = jest.requireActual('../services/sms-suggest-mode');

const ID = {
  draft: '00000000-0000-4000-8000-000000000001',
  inbound: '00000000-0000-4000-8000-000000000002',
  customer: '00000000-0000-4000-8000-000000000003',
  outbound: '00000000-0000-4000-8000-000000000004',
};

function metadata(overrides = {}) {
  return {
    actions: [{ type: 'none' }],
    verify: { passes: 1, converged: true },
    voice_profile_version: null,
    gratitude: {
      source: 'live_webhook', policy_version: GRATITUDE_POLICY_VERSION,
      actions_verified_safe: true, verifier_enabled: true,
    },
    ...overrides,
  };
}

function resetFixture() {
  const received = new Date(Date.now() - 3 * 60 * 1000);
  mockState.gratitudeGate = true;
  mockState.generalGate = false;
  mockState.activation = new Date(received.getTime() - 60 * 1000);
  mockState.aliasFirsts = 0;
  mockState.activeClaim = false;
  mockState.pendingDecision = false;
  mockState.openRequest = false;
  mockState.openCallCommitment = false;
  mockState.openSmsCommitment = false;
  mockState.openTriage = false;
  mockState.openOperatorItem = false;
  mockState.intentMode = 'auto_send';
  mockState.threadAdvanced = false;
  mockState.decisionCustomerScope = false;
  mockState.decisionThreadScope = false;
  mockState.customers = [{ id: ID.customer, first_name: 'Dana', phone: '+19415550100' }];
  mockState.inbound = {
    id: ID.inbound, customer_id: ID.customer, direction: 'inbound',
    from_phone: '+19415550100', to_phone: '+19413529161', message_body: 'Thank you!',
    metadata: { media: [] }, created_at: received,
  };
  mockState.draft = {
    id: ID.draft, sms_log_id: ID.inbound, customer_id: ID.customer,
    inbound_message: 'Thank you!', draft_response: buildGratitudeReply('Dana'),
    intent: GRATITUDE_INTENT, status: 'shadow', model: 'gpt-test',
    prompt_version: 'house_voice_v11', intended_actions: metadata(),
    flags: [], scheduling_intent: false, created_at: new Date(received.getTime() + 1000),
  };
  mockState.history = [
    { id: ID.inbound, direction: 'inbound', message_body: 'Thank you!', message_type: 'inbound', status: 'received', metadata: { media: [] }, created_at: received },
    { id: ID.outbound, direction: 'outbound', message_body: 'Your service report: https://portal.example/report', message_type: 'service_report', status: 'delivered', metadata: { media: [] }, created_at: new Date(received.getTime() - 60 * 1000) },
  ];
  sendCustomerMessage.mockResolvedValue({
    sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'a'.repeat(32)}`,
  });
}

function attempt(overrides = {}) {
  return autoSend.maybeAutoSend({
    draftId: ID.draft,
    customer: { id: ID.customer },
    smsLogId: ID.inbound,
    inboundMessage: 'Thank you!',
    reply: buildGratitudeReply('Dana'),
    intent: GRATITUDE_INTENT,
    intendedActions: [{ type: 'none' }],
    actionsVerifiedSafe: true,
    confidence: 1,
    model: 'gpt-test',
    promptVersion: 'house_voice_v11',
    voiceProfileVersion: null,
    schedulingIntent: false,
    ...overrides,
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  resetFixture();
});

test('gratitude gate is independent: gate off blocks even when general auto-send is on', async () => {
  mockState.gratitudeGate = false;
  mockState.generalGate = true;
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'gate_off' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('dark gratitude delivery resolution remains shadow and never falls back to a human card', async () => {
  mockState.gratitudeGate = false;
  mockState.generalGate = true;
  await expect(actualSuggestMode.resolveDeliveryMode({
    reply: buildGratitudeReply('Dana'), customerId: ID.customer, smsLogId: ID.inbound,
    intent: GRATITUDE_INTENT, schedulingIntent: false,
  })).resolves.toBe('shadow');
  mockState.gratitudeGate = true;
  mockState.intentMode = 'suggest';
  await expect(actualSuggestMode.resolveDeliveryMode({
    reply: buildGratitudeReply('Dana'), customerId: ID.customer, smsLogId: ID.inbound,
    intent: GRATITUDE_INTENT, schedulingIntent: false,
  })).resolves.toBe('shadow');
});

test.each([
  ['before activation', -1, null, 'before_activation'],
  ['future inbound', null, 1, 'future_inbound'],
  ['under two minutes', null, null, 'quiet_window'],
  ['older than ten minutes', null, null, 'stale_inbound'],
])('%s is denied by the immutable source clock', async (_label, activationOffset, futureOffset, expected) => {
  const now = new Date();
  if (futureOffset) mockState.inbound.created_at = new Date(now.getTime() + futureOffset * 60 * 1000);
  else if (expected === 'quiet_window') mockState.inbound.created_at = new Date(now.getTime() - 60 * 1000);
  else if (expected === 'stale_inbound') mockState.inbound.created_at = new Date(now.getTime() - 11 * 60 * 1000);
  if (activationOffset) mockState.activation = new Date(mockState.inbound.created_at.getTime() + 60 * 1000);
  else mockState.activation = new Date(mockState.inbound.created_at.getTime() - 60 * 1000);
  mockState.draft.inbound_message = mockState.inbound.message_body;
  const result = await gratitudeContext.readGratitudeContext({
    draftId: ID.draft, smsLogId: ID.inbound, now, activatedAt: mockState.activation, dbh: db, expectedPromptVersion: 'house_voice_v11',
  });
  expect(result).toMatchObject({ ok: false, reason: expected });
});

test('unset/malformed activation and replay provenance fail closed', async () => {
  expect((await gratitudeContext.readGratitudeContext({ draftId: ID.draft, smsLogId: ID.inbound, activatedAt: null, dbh: db, expectedPromptVersion: 'house_voice_v11' })))
    .toMatchObject({ ok: false, reason: 'activation_unset' });
  mockState.draft.intended_actions = metadata({ gratitude: {
    source: 'historical_replay', policy_version: GRATITUDE_POLICY_VERSION,
    actions_verified_safe: true, verifier_enabled: true,
  } });
  expect((await gratitudeContext.readGratitudeContext({ draftId: ID.draft, smsLogId: ID.inbound, activatedAt: mockState.activation, dbh: db, expectedPromptVersion: 'house_voice_v11' })))
    .toMatchObject({ ok: false, reason: 'invalid_gratitude_provenance' });
});

test('edited reply and truncated 24-hour context are denied', async () => {
  mockState.draft.draft_response = 'You are welcome!';
  expect((await gratitudeContext.readGratitudeContext({ draftId: ID.draft, smsLogId: ID.inbound, activatedAt: mockState.activation, dbh: db, expectedPromptVersion: 'house_voice_v11' })))
    .toMatchObject({ ok: false, reason: 'edited_draft' });
  resetFixture();
  mockState.history = Array.from({ length: 201 }, (_, i) => ({
    id: `row-${i}`, direction: 'outbound', message_body: 'Delivered report https://portal.example/r',
    message_type: 'report', status: 'delivered', metadata: { media: [] },
    created_at: new Date(mockState.inbound.created_at.getTime() - i * 1000),
  }));
  expect((await gratitudeContext.readGratitudeContext({ draftId: ID.draft, smsLogId: ID.inbound, activatedAt: mockState.activation, dbh: db, expectedPromptVersion: 'house_voice_v11' })))
    .toMatchObject({ ok: false, reason: 'context_truncated' });
});

test('persisted raw safety proof is mandatory; empty or explicit-none normalized actions are accepted', () => {
  const args = { expectedReply: buildGratitudeReply('Dana'), expectedPromptVersion: 'house_voice_v11' };
  mockState.draft.intended_actions = metadata({ actions: [] });
  expect(gratitudeContext.validateGratitudeDraftContract(mockState.draft, args)).toBeNull();
  mockState.draft.intended_actions = metadata({ actions: [{ type: 'none' }] });
  expect(gratitudeContext.validateGratitudeDraftContract(mockState.draft, args)).toBeNull();
  mockState.draft.intended_actions = metadata({ gratitude: {
    source: 'live_webhook', policy_version: GRATITUDE_POLICY_VERSION,
    actions_verified_safe: false, verifier_enabled: true,
  } });
  expect(gratitudeContext.validateGratitudeDraftContract(mockState.draft, args)).toBe('actions_not_verified_safe');
  mockState.draft.intended_actions = metadata({ missing_info: 'Need the invoice number' });
  expect(gratitudeContext.validateGratitudeDraftContract(mockState.draft, args)).toBe('missing_info');
  mockState.draft.intended_actions = metadata();
  mockState.draft.flags = [{ type: 'comms_lint:sms_segments', severity: 'warn' }];
  expect(gratitudeContext.validateGratitudeDraftContract(mockState.draft, args)).toBe('unsafe_flags');
});

test('a later automated reminder/payment/report advances the exact endpoint thread', async () => {
  mockState.threadAdvanced = true;
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'thread_advanced' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('activity landing while the reservation is armed aborts before provider entry', async () => {
  suggest.settleReplyHoldingReservation.mockImplementationOnce(async ({ uncertain }) => {
    if (uncertain) mockState.threadAdvanced = true;
    return true;
  });
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'thread_advanced' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(suggest.settleReplyHoldingReservation).toHaveBeenLastCalledWith({ reservationId: 'reservation-1' });
});

test('new inbound/human answer, duplicate claim, and every operational work queue guard provider entry', async () => {
  suggest.threadHasLiveAnswer.mockResolvedValueOnce('newer_inbound');
  expect((await attempt()).sent).toBe(false);
  mockState.aliasFirsts = 0;
  mockState.activeClaim = true;
  expect((await attempt()).sent).toBe(false);
  mockState.aliasFirsts = 0;
  mockState.activeClaim = false;
  mockState.pendingDecision = true;
  expect((await attempt()).sent).toBe(false);
  expect(mockState.decisionCustomerScope).toBe(true);
  expect(mockState.decisionThreadScope).toBe(true);
  mockState.aliasFirsts = 0;
  mockState.pendingDecision = false;
  mockState.openRequest = true;
  expect((await attempt()).sent).toBe(false);
  mockState.aliasFirsts = 0;
  mockState.openRequest = false;
  mockState.openCallCommitment = true;
  expect((await attempt()).sent).toBe(false);
  mockState.aliasFirsts = 0;
  mockState.openCallCommitment = false;
  mockState.openSmsCommitment = true;
  expect((await attempt()).sent).toBe(false);
  mockState.aliasFirsts = 0;
  mockState.openSmsCommitment = false;
  mockState.openTriage = true;
  expect((await attempt()).sent).toBe(false);
  mockState.aliasFirsts = 0;
  mockState.openTriage = false;
  mockState.openOperatorItem = true;
  expect((await attempt()).sent).toBe(false);
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('qualified live gratitude preserves mode/graduation checks and reaches only the mocked sender', async () => {
  await expect(attempt()).resolves.toMatchObject({ sent: true, providerMessageId: expect.stringMatching(/^SM/) });
  expect(suggest.getIntentMode).toHaveBeenCalledWith(GRATITUDE_INTENT);
  expect(graduation.evaluateAutoSendEligibility).toHaveBeenCalledWith(expect.objectContaining({ intent: GRATITUDE_INTENT }));
  expect(suggest.createReplyHoldingReservation).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
    parkedDecisionIds: [], body: buildGratitudeReply('Dana'), reservationKind: 'auto',
  }));
  expect(suggest.ignoreParkedSuggestions).not.toHaveBeenCalled();
  expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
    to: '+19415550100', body: buildGratitudeReply('Dana'),
    metadata: expect.objectContaining({ original_message_type: 'ai_gratitude', gratitude_policy_version: GRATITUDE_POLICY_VERSION }),
  }));
});

// Simulate the canonical sender doing its own awaited work before handoff.
// The provider mock is reached only after the caller's boundary verdict.
test.each([
  ['new inbound', () => { mockState.threadAdvanced = true; }, 'thread_advanced'],
  ['gate disabled', () => { mockState.gratitudeGate = false; }, 'gate_off'],
  ['cutoff advanced', () => { mockState.activation = new Date(); }, 'before_activation'],
  ['reply expired', () => { jest.setSystemTime(Date.now() + 8 * 60 * 1000); }, 'stale_inbound'],
])('%s during the sender pipeline blocks the provider handoff', async (_label, change, reason) => {
  jest.useFakeTimers();
  const provider = jest.fn();
  sendCustomerMessage.mockImplementationOnce(async ({ preSendCheck }) => {
    await Promise.resolve();
    change();
    const verdict = await preSendCheck();
    if (!verdict.ok) return { sent: false, deliveryOutcome: 'not_sent', code: verdict.code };
    provider();
    return { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'b'.repeat(32)}` };
  });
  try {
    await expect(attempt()).resolves.toMatchObject({ sent: false, reason });
    expect(provider).not.toHaveBeenCalled();
    expect(suggest.settleReplyHoldingReservation).toHaveBeenLastCalledWith({ reservationId: 'reservation-1' });
  } finally {
    jest.useRealTimers();
  }
});

test('a boundary query failure before provider entry clears the armed reservation', async () => {
  suggest.settleReplyHoldingReservation.mockImplementationOnce(async () => {
    mockState.threadAdvanced = false;
    const implementation = db.getMockImplementation();
    db.mockImplementation((table) => {
      const query = implementation(table);
      if (table === 'sms_log') query.first = jest.fn(async () => { throw new Error('boundary read failed'); });
      return query;
    });
    return true;
  });
  const implementation = db.getMockImplementation();
  try {
    await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'send_error' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(suggest.settleReplyHoldingReservation).toHaveBeenLastCalledWith({ reservationId: 'reservation-1' });
    const claimQueries = db.mock.results.filter((_, i) => db.mock.calls[i][0] === 'agent_decisions');
    expect(claimQueries.some(({ value }) => value.update.mock.calls.some(([change]) => change.status === 'auto_send_failed'))).toBe(true);
  } finally {
    db.mockImplementation(implementation);
  }
});
