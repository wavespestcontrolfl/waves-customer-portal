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
  candidateRows: [],
  candidateOrderBys: [],
  candidateExclusions: [],
  candidateCursors: [],
};

jest.mock('../models/db', () => {
  const db = jest.fn((table) => {
    const q = {};
    let operation = null;
    for (const method of [
      'whereNull', 'whereNotNull', 'whereNotIn', 'whereIn',
      'leftJoin', 'join', 'onConflict', 'ignore',
    ]) q[method] = jest.fn(() => q);
    let candidateCursor = null;
    q.whereRaw = jest.fn((sql, bindings) => {
      if (table === 'message_drafts as md' && String(sql).startsWith('(s.created_at, s.id) >')) {
        candidateCursor = bindings[1];
        mockState.candidateCursors.push(candidateCursor);
      }
      return q;
    });
    const orderBys = [];
    let queryLimit = null;
    q.orderBy = jest.fn((column, direction) => {
      orderBys.push([column, direction]);
      if (table === 'message_drafts as md') mockState.candidateOrderBys.push([column, direction]);
      return q;
    });
    q.limit = jest.fn((value) => { queryLimit = value; return q; });
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
    q.whereNotExists = jest.fn((callback) => {
      const subquery = { raws: [] };
      subquery.select = jest.fn(() => subquery);
      subquery.from = jest.fn((from) => { subquery.fromTable = from; return subquery; });
      subquery.whereRaw = jest.fn((sql, bindings) => { subquery.raws.push([sql, bindings]); return subquery; });
      callback.call(subquery);
      if (table === 'message_drafts as md') mockState.candidateExclusions.push(subquery);
      return q;
    });
    q.orWhereExists = jest.fn((callback) => {
      const subquery = {};
      for (const method of ['select', 'from', 'where', 'whereRaw']) {
        subquery[method] = jest.fn(() => subquery);
      }
      callback.call(subquery);
      return q;
    });
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
      if (table === 'message_drafts as md') {
        const valueFor = (row, column) => column === 's.created_at'
          ? row.inbound_created_at
          : column === 's.id' ? row.sms_log_id
          : column === 'md.created_at' ? row.created_at : row.id;
        const anchor = candidateCursor && mockState.candidateRows.find(row => row.sms_log_id === candidateCursor);
        const after = row => !anchor
          || row.inbound_created_at > anchor.inbound_created_at
          || (row.inbound_created_at.getTime() === anchor.inbound_created_at.getTime()
            && row.sms_log_id > anchor.sms_log_id);
        const rows = mockState.candidateRows.filter(after).sort((left, right) => {
          for (const [column, direction] of orderBys) {
            const a = valueFor(left, column);
            const b = valueFor(right, column);
            const compared = a instanceof Date && b instanceof Date
              ? a.getTime() - b.getTime()
              : String(a).localeCompare(String(b));
            if (compared) return direction === 'desc' ? -compared : compared;
          }
          return 0;
        });
        return queryLimit === null ? rows : rows.slice(0, queryLimit);
      }
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
  // gratitudeFinalState: every open-work source and thread advancement in
  // one statement, answered from the same fixture flags.
  db.first = jest.fn(async () => ({
    pending_work: [
      mockState.openRequest, mockState.openCallCommitment, mockState.openSmsCommitment,
      mockState.openTriage, mockState.openOperatorItem, mockState.pendingDecision,
    ].some(Boolean),
    thread_advanced: mockState.threadAdvanced,
    customers: mockState.customers.slice(0, 2),
  }));
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
  mockState.candidateRows = [];
  mockState.candidateOrderBys = [];
  mockState.candidateExclusions = [];
  mockState.candidateCursors = [];
  mockState.customers = [{ id: ID.customer, first_name: 'Dana', phone: '+19415550100' }];
  mockState.inbound = {
    id: ID.inbound, customer_id: ID.customer, direction: 'inbound',
    from_phone: '+19415550100', to_phone: '+19413187612', message_body: 'Thank you!',
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

let uptime;
beforeEach(() => {
  jest.clearAllMocks();
  resetFixture();
  // Past the rollout-settle window unless a test says otherwise.
  uptime = jest.spyOn(process, 'uptime').mockReturnValue(60 * 60);
});
afterEach(() => uptime.mockRestore());

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

test('candidate sweep drains the oldest inbound before more than 25 newer rejected drafts', async () => {
  const now = new Date();
  const oldestInboundAt = new Date(now.getTime() - 9 * 60 * 1000);
  const newestDraftForOldestInbound = new Date(oldestInboundAt.getTime() + 2000);
  mockState.activation = new Date(oldestInboundAt.getTime() - 60 * 1000);
  mockState.inbound.created_at = oldestInboundAt;
  mockState.draft.created_at = newestDraftForOldestInbound;
  mockState.history[0].created_at = oldestInboundAt;
  mockState.history[1].created_at = new Date(oldestInboundAt.getTime() - 60 * 1000);

  const candidate = (overrides = {}) => ({
    id: ID.draft,
    sms_log_id: ID.inbound,
    customer_id: ID.customer,
    inbound_message: mockState.inbound.message_body,
    draft_response: mockState.draft.draft_response,
    intent: GRATITUDE_INTENT,
    intent_confidence: 1,
    model: 'gpt-test',
    prompt_version: 'house_voice_v11',
    intended_actions: metadata(),
    scheduling_intent: false,
    inbound_created_at: oldestInboundAt,
    created_at: newestDraftForOldestInbound,
    ...overrides,
  });
  const olderDuplicate = candidate({
    id: '00000000-0000-4000-8000-000000000099',
    intended_actions: metadata({ actions: null }),
    created_at: new Date(oldestInboundAt.getTime() + 1000),
  });
  const newerRejected = Array.from({ length: 30 }, (_, index) => {
    const inboundAt = new Date(now.getTime() - (8 * 60 * 1000) + index * 1000);
    return candidate({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      sms_log_id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      intended_actions: metadata({ actions: null }),
      inbound_created_at: inboundAt,
      created_at: new Date(inboundAt.getTime() + 1000),
    });
  });
  mockState.candidateRows = [olderDuplicate, candidate(), ...newerRejected];

  await expect(autoSend.processGratitudeAutoSendCandidates({ now }))
    .resolves.toEqual({ scanned: 32, attempted: 1, sent: 1 });
  expect(mockState.candidateOrderBys).toEqual([
    ['s.created_at', 'asc'],
    ['s.id', 'asc'],
    ['md.created_at', 'desc'],
    ['md.id', 'asc'],
  ]);
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

function sweepCandidate(overrides = {}) {
  return {
    id: ID.draft,
    sms_log_id: ID.inbound,
    customer_id: ID.customer,
    inbound_message: mockState.inbound.message_body,
    draft_response: mockState.draft.draft_response,
    intent: GRATITUDE_INTENT,
    intent_confidence: 1,
    model: 'gpt-test',
    prompt_version: 'house_voice_v11',
    intended_actions: metadata(),
    scheduling_intent: false,
    inbound_created_at: mockState.inbound.created_at,
    created_at: mockState.draft.created_at,
    ...overrides,
  };
}

test('candidate sweep skips inbounds that already hold a send-once claim', async () => {
  mockState.candidateRows = [sweepCandidate()];
  await autoSend.processGratitudeAutoSendCandidates({ now: new Date() });
  expect(mockState.candidateExclusions).toHaveLength(1);
  const [exclusion] = mockState.candidateExclusions;
  expect(exclusion.fromTable).toBe('agent_decisions as prior');
  expect(exclusion.raws).toEqual([[
    'prior.idempotency_key = ? || s.id::text',
    ['sms_house_voice_auto_send:inbound:'],
  ]]);
});

test('older candidates refused after the prefilter cannot starve a valid newer one', async () => {
  const now = new Date();
  const refused = Array.from({ length: 30 }, (_, index) => {
    const inboundAt = new Date(now.getTime() - (9 * 60 * 1000) + index * 1000);
    return sweepCandidate({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      sms_log_id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      // Reaches the executor, then fails its durable-row comparison.
      draft_response: 'Not the approved reply',
      inbound_created_at: inboundAt,
      created_at: new Date(inboundAt.getTime() + 1000),
    });
  });
  mockState.candidateRows = [...refused, sweepCandidate()];

  await expect(autoSend.processGratitudeAutoSendCandidates({ now }))
    .resolves.toEqual({ scanned: 31, attempted: 31, sent: 1 });
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

test('the sweep pages past a full page of refused older candidates to reach a valid one', async () => {
  const now = new Date();
  const refused = Array.from({ length: 5 }, (_, index) => {
    const inboundAt = new Date(now.getTime() - (9 * 60 * 1000) + index * 1000);
    return sweepCandidate({
      id: `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      sms_log_id: `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      draft_response: 'Not the approved reply',
      inbound_created_at: inboundAt,
      created_at: new Date(inboundAt.getTime() + 1000),
    });
  });
  mockState.candidateRows = [...refused, sweepCandidate()];

  await expect(autoSend.processGratitudeAutoSendCandidates({ now, pageSize: 2 }))
    .resolves.toEqual({ scanned: 6, attempted: 6, sent: 1 });
  expect(mockState.candidateCursors).toEqual([
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000003',
    ID.inbound,
  ]);
  expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
});

test('a sweep-wide refusal stops the sweep after one attempt', async () => {
  mockState.intentMode = 'suggest';
  suggest.getIntentMode.mockResolvedValueOnce('suggest');
  mockState.candidateRows = [
    sweepCandidate({ id: '10000000-0000-4000-8000-000000000001', sms_log_id: '20000000-0000-4000-8000-000000000001' }),
    sweepCandidate(),
  ];
  await expect(autoSend.processGratitudeAutoSendCandidates({ now: new Date() }))
    .resolves.toEqual({ scanned: 2, attempted: 1, sent: 0 });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('one sweep hashes the pinned sources once and hands the digest to every candidate', async () => {
  const qualification = require('../services/sms-gratitude-qualification');
  const digest = jest.spyOn(qualification, 'sourceSha256').mockReturnValue('f'.repeat(64));
  try {
    mockState.candidateRows = [
      sweepCandidate({ id: '10000000-0000-4000-8000-000000000001', sms_log_id: '20000000-0000-4000-8000-000000000001', draft_response: 'Not the approved reply' }),
      sweepCandidate(),
    ];
    await autoSend.processGratitudeAutoSendCandidates({ now: new Date() });
    expect(digest).toHaveBeenCalledTimes(1);
    expect(graduation.evaluateAutoSendEligibility).toHaveBeenCalledWith(expect.objectContaining({
      intent: GRATITUDE_INTENT, gratitudeSourceDigest: 'f'.repeat(64),
    }));
  } finally {
    digest.mockRestore();
  }
});

test.each([
  ['a new qualification run', { eligible: false, blockers: ['Gratitude qualification blocked: running.'] }],
  ['a newly activated voice profile', { eligible: false, blockers: ['Gratitude qualification blocked: voice profile changed.'] }],
])('%s during provider preparation blocks the final handoff', async (_label, verdict) => {
  sendCustomerMessage.mockImplementationOnce(async ({ providerPreSendCheck }) => {
    graduation.evaluateAutoSendEligibility.mockResolvedValueOnce(verdict);
    const check = await providerPreSendCheck({ dbi: db });
    return check.ok
      ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'f'.repeat(32)}` }
      : { sent: false, deliveryOutcome: 'not_sent', code: check.code };
  });
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'not_eligible' });
  expect(graduation.evaluateAutoSendEligibility).toHaveBeenLastCalledWith(expect.objectContaining({
    intent: GRATITUDE_INTENT, dbi: db, voiceProfileVersion: null,
  }));
});

test.each([
  ['deactivated', () => { mockState.customers = []; }],
  ['renamed', () => { mockState.customers = [{ ...mockState.customers[0], first_name: 'Morgan' }]; }],
  ['phone moved to another customer', () => { mockState.customers = [{ ...mockState.customers[0], id: '00000000-0000-4000-8000-0000000000ff' }]; }],
  ['phone now shared', () => { mockState.customers = [mockState.customers[0], { ...mockState.customers[0], id: '00000000-0000-4000-8000-0000000000fe' }]; }],
])('a customer %s during provider preparation blocks the final handoff', async (_label, change) => {
  const provider = jest.fn();
  sendCustomerMessage.mockImplementationOnce(async ({ providerPreSendCheck }) => {
    change();
    const verdict = await providerPreSendCheck({ dbi: db });
    if (!verdict.ok) return { sent: false, deliveryOutcome: 'not_sent', code: verdict.code };
    provider();
    return { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'2'.repeat(32)}` };
  });
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'customer_changed' });
  expect(provider).not.toHaveBeenCalled();
});

test('gratitude lends its claim reservation to the provider layer as an ai_gratitude handle', async () => {
  const reservationId = '55555555-5555-4555-8555-555555555555';
  suggest.createReplyHoldingReservation.mockResolvedValueOnce(reservationId);
  await expect(attempt()).resolves.toMatchObject({ sent: true });
  const [input] = sendCustomerMessage.mock.calls.at(-1);
  const providerCoordination = require('../services/messaging/provider-handoff-reservation');
  expect(providerCoordination.isProviderHandoffHandle(input.providerHandoffReservation)).toBe(true);
  expect(input.providerHandoffReservation).toMatchObject({
    reservationId, callerOwned: true,
    context: expect.objectContaining({ messageType: 'ai_gratitude', body: buildGratitudeReply('Dana') }),
  });
  // Ownership still comes from the trusted gratitude input, so the canonical
  // router borrows this handle instead of preparing a second reservation.
  expect(providerCoordination.trustedGratitudeOwnsReservation(input, input)).toBe(true);
});

test('thanks sent to a technician line are refused instead of rerouted to the location line', async () => {
  const techLine = require('../config/twilio-numbers').fieldTech[0].number;
  mockState.inbound.to_phone = techLine;
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'tech_line_thread' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('a freshly started instance makes no gratitude claim until the rollout settles', async () => {
  uptime.mockReturnValue(14 * 60);
  mockState.candidateRows = [sweepCandidate()];
  await expect(autoSend.processGratitudeAutoSendCandidates({ now: new Date() }))
    .resolves.toEqual({ scanned: 0, attempted: 0, sent: 0, reason: 'rollout_settling' });
  // The claim itself enforces the same window for any other caller.
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'guarded_or_claimed' });
  expect(sendCustomerMessage).not.toHaveBeenCalled();
});

test('a new inbound landing during the boundary eligibility read still blocks the handoff', async () => {
  sendCustomerMessage.mockImplementationOnce(async ({ providerPreSendCheck }) => {
    graduation.evaluateAutoSendEligibility.mockImplementationOnce(async () => {
      mockState.threadAdvanced = true;
      return { eligible: true, blockers: [] };
    });
    const check = await providerPreSendCheck({ dbi: db });
    return check.ok
      ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'1'.repeat(32)}` }
      : { sent: false, deliveryOutcome: 'not_sent', code: check.code };
  });
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'thread_advanced' });
});

test('demoting the intent during provider preparation blocks the final handoff', async () => {
  sendCustomerMessage.mockImplementationOnce(async ({ providerPreSendCheck }) => {
    mockState.intentMode = 'shadow';
    const verdict = await providerPreSendCheck({ dbi: db });
    return verdict.ok
      ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'e'.repeat(32)}` }
      : { sent: false, deliveryOutcome: 'not_sent', code: verdict.code };
  });
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'mode_not_autosend' });
});

// Simulate provider preparation before the distinct final SMS predicate.
// The provider mock is reached only after the caller's boundary verdict.
test.each([false, true])('the final thread lock covers the SDK and observes publication while waiting (%s)', async (publishWhileWaiting) => {
  const originalTransaction = db.transaction.getMockImplementation();
  const originalLock = suggest.lockSuggestThread.getMockImplementation();
  let held = false;
  let lockCount = 0;
  const provider = jest.fn(() => { expect(held).toBe(true); });
  db.transaction.mockImplementation(async (work) => {
    held = true;
    try { return await work(db); } finally { held = false; }
  });
  suggest.lockSuggestThread.mockImplementation(async (_trx, key) => {
    expect(key).toBe('9415550100');
    lockCount += 1;
    if (lockCount === 2 && publishWhileWaiting) mockState.threadAdvanced = true;
  });
  sendCustomerMessage.mockImplementationOnce(async ({ withSmsHandoff, providerPreSendCheck }) => {
    let result;
    await withSmsHandoff(async (trx) => {
      expect(held).toBe(true);
      expect(trx).toBe(db);
      const verdict = await providerPreSendCheck({ dbi: trx });
      if (!verdict.ok) {
        result = { sent: false, deliveryOutcome: 'not_sent', code: verdict.code };
        return;
      }
      provider();
      result = { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'d'.repeat(32)}` };
    });
    return result;
  });
  try {
    await expect(attempt()).resolves.toMatchObject(publishWhileWaiting
      ? { sent: false, reason: 'thread_advanced' } : { sent: true });
    expect(lockCount).toBe(2);
    expect(provider).toHaveBeenCalledTimes(publishWhileWaiting ? 0 : 1);
    expect(held).toBe(false);
  } finally {
    db.transaction.mockImplementation(originalTransaction);
    suggest.lockSuggestThread.mockImplementation(originalLock);
  }
});

test.each([
  ['new inbound', () => { mockState.threadAdvanced = true; }, 'thread_advanced'],
  ['gate disabled', () => { mockState.gratitudeGate = false; }, 'gate_off'],
  ['cutoff advanced', () => { mockState.activation = new Date(); }, 'before_activation'],
  ['reply expired', () => { jest.setSystemTime(Date.now() + 8 * 60 * 1000); }, 'stale_inbound'],
])('%s during the sender pipeline blocks the provider handoff', async (_label, change, reason) => {
  jest.useFakeTimers();
  const provider = jest.fn();
  sendCustomerMessage.mockImplementationOnce(async ({ providerPreSendCheck }) => {
    await Promise.resolve();
    change();
    const verdict = await providerPreSendCheck();
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

test.each([
  ['service request', () => { mockState.openRequest = true; }, 'service_requests'],
  ['call commitment', () => { mockState.openCallCommitment = true; }, 'call_commitments as cc'],
  ['SMS commitment', () => { mockState.openSmsCommitment = true; }, 'call_commitments as cc_sms'],
  ['triage item', () => { mockState.openTriage = true; }, 'triage_items as ti'],
  ['operator inbox item', () => { mockState.openOperatorItem = true; }, 'operator_inbox_items as oi'],
  ['review decision', () => { mockState.pendingDecision = true; }, 'agent_decisions as ad'],
])('a %s opened during provider preparation blocks the final handoff', async (_label, openWork, table) => {
  const provider = jest.fn();
  const heldDbi = jest.fn((...args) => db(...args));
  heldDbi.raw = (...args) => db.raw(...args);
  heldDbi.first = (...args) => db.first(...args);
  sendCustomerMessage.mockImplementationOnce(async ({ providerPreSendCheck }) => {
    openWork();
    const verdict = await providerPreSendCheck({ dbi: heldDbi });
    if (!verdict.ok) return { sent: false, deliveryOutcome: 'not_sent', code: verdict.code };
    provider();
    return { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'c'.repeat(32)}` };
  });

  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'pending_work' });
  expect(provider).not.toHaveBeenCalled();
  expect(heldDbi.mock.calls.some(([queriedTable]) => queriedTable === table)).toBe(true);
  expect(suggest.settleReplyHoldingReservation).toHaveBeenLastCalledWith({ reservationId: 'reservation-1' });
});

test('open work and thread advancement are read in ONE statement, after shared readiness', async () => {
  const order = [];
  const heldDbi = jest.fn((...args) => db(...args));
  heldDbi.raw = (...args) => db.raw(...args);
  heldDbi.first = jest.fn(async (...args) => { order.push('final_state'); return db.first(...args); });
  graduation.evaluateAutoSendEligibility.mockImplementation(async () => {
    order.push('eligibility');
    return { eligible: true, blockers: [] };
  });
  sendCustomerMessage.mockImplementationOnce(async ({ providerPreSendCheck }) => {
    const verdict = await providerPreSendCheck({ dbi: heldDbi });
    return verdict.ok
      ? { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'d'.repeat(32)}` }
      : { sent: false, deliveryOutcome: 'not_sent', code: verdict.code };
  });
  try {
    await expect(attempt()).resolves.toMatchObject({ sent: true });
    expect(heldDbi.first).toHaveBeenCalledTimes(1);
    expect(order.slice(-2)).toEqual(['eligibility', 'final_state']);
  } finally {
    graduation.evaluateAutoSendEligibility.mockImplementation(async () => ({ eligible: true, blockers: [] }));
  }
});

test('gate disable landing during the final-state read is caught by the synchronous gate check', async () => {
  const heldDbi = jest.fn((...args) => db(...args));
  heldDbi.raw = (...args) => db.raw(...args);
  heldDbi.first = jest.fn(async (...args) => {
    const row = await db.first(...args);
    mockState.gratitudeGate = false;
    return row;
  });
  const provider = jest.fn();
  sendCustomerMessage.mockImplementationOnce(async ({ providerPreSendCheck }) => {
    const verdict = await providerPreSendCheck({ dbi: heldDbi });
    if (!verdict.ok) return { sent: false, deliveryOutcome: 'not_sent', code: verdict.code };
    provider();
    return { sent: true, deliveryOutcome: 'accepted', providerMessageId: `SM${'d'.repeat(32)}` };
  });
  await expect(attempt()).resolves.toMatchObject({ sent: false, reason: 'gate_off' });
  expect(provider).not.toHaveBeenCalled();
});

test('a boundary query failure before provider entry clears the armed reservation', async () => {
  suggest.settleReplyHoldingReservation.mockImplementationOnce(async () => {
    mockState.threadAdvanced = false;
    db.first.mockImplementationOnce(async () => { throw new Error('boundary read failed'); });
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
