// GATE_TECH_STAFF_GUARDS, M12 (census 2026-10-25): an inbound text from an active technician's own cell
// to an office line is a staff sender. The office still sees it (inbox row, legacy log row, activity row,
// the owner's unknown-sender text forward, unread); only the customer and lead side is skipped (spam
// screen, estimator draft and agent, AI auto-reply and drafts, new-prospect bells). Same harness as twilio-webhook-solicitation.test.js (real webhook, mocked
// persistence and providers; nothing is sent). The phone set itself is tested against Postgres in
// staff-sender-phones-postgres.test.js, so it is stubbed here.
const mockWrites = [];
const mockWhereRawCalls = [];
// The repeat-sender alert-quota check's own db('sms_log')...first() call —
// queueing a row here simulates "a prior sms_log row exists" for THAT check
// only. Distinguished from the compliance outbound-history check's OWN
// sms_log/messages/messaging_suppression first() calls (below) by whether
// the query chain used `.whereIn` — only the outbound-history query does
// (codex round 3 design fix, 2026-09-11: relationship resolution, including
// this query, now runs BEFORE the repeat-sender check, so both are
// genuinely reachable and must not share one queue).
const mockSmsLogFirstQueue = [];
// queryOutboundHistory's own sms_log / messages / messaging_suppression
// first() calls, consumed in that query order — empty (the default) means
// "no outbound history", i.e. NOT compliance-eligible via this path.
let mockHistoryResults = [];
// Records each table queryOutboundHistory actually reached (its `.first()`
// call) — used to assert the query was SKIPPED entirely (codex P1 restored
// `||` short-circuit, 2026-09-11) when the AI line or a known caller record
// already resolves eligibility on its own.
const mockOutboundHistoryCalls = [];
// findSingleCustomerByPhone runs a raw db('customers')... query — set this
// to simulate a matched customer for the sender (null/[] = no match).
let mockCustomersRows = null;
const mockOptoutReceipts = new Map();
function mockDb(table) {
  const query = { rows: table === 'customers' && mockCustomersRows ? mockCustomersRows : [] };
  for (const method of ['where', 'whereNull', 'whereNot', 'whereNotIn', 'orWhereNull', 'orderBy', 'limit']) {
    query[method] = () => query;
  }
  query.where = (filter) => { query.filter = filter; return query; };
  query.whereIn = () => { query.usedWhereIn = true; return query; };
  // Only queryOutboundHistory's `messages` branch joins — the unrelated
  // read-state checks elsewhere in the handler (`db('messages').where({...
  // twilio_sid}).first('is_read')`) never do, so this flag alone tells them
  // apart for `mockOutboundHistoryCalls` below.
  query.join = () => { query.usedJoin = true; return query; };
  query.whereRaw = (...args) => { mockWhereRawCalls.push({ table, args }); return query; };
  query.insert = (row) => {
    if (table === 'inbound_sms_optout_receipts') mockOptoutReceipts.set(row.message_sid, row);
    mockWrites.push({ table, row });
    query.rows = [{ id: '00000000-0000-4000-8000-000000000001', created_at: new Date(), ...row }];
    // notification_prefs upsert (opt-out prefs write) chains onConflict().merge().
    query.onConflict = () => query;
    query.merge = async () => query.rows;
    return query;
  };
  query.first = async () => {
    if (table === 'inbound_sms_optout_receipts') return mockOptoutReceipts.get(query.filter.message_sid) || null;
    if (table === 'messages' && query.usedJoin) {
      mockOutboundHistoryCalls.push(table);
      return mockHistoryResults.length ? mockHistoryResults.shift() : null;
    }
    if (table === 'messaging_suppression') {
      mockOutboundHistoryCalls.push(table);
      return mockHistoryResults.length ? mockHistoryResults.shift() : null;
    }
    if (table === 'sms_log' && query.usedWhereIn) {
      mockOutboundHistoryCalls.push(table);
      return mockHistoryResults.length ? mockHistoryResults.shift() : null;
    }
    if (table === 'messages') return null; // unrelated is_read lookups
    return table === 'sms_log' && mockSmsLogFirstQueue.length ? mockSmsLogFirstQueue.shift() : null;
  };
  query.returning = async () => query.rows;
  query.then = (resolve, reject) => Promise.resolve(query.rows).then(resolve, reject);
  query.catch = (reject) => Promise.resolve(query.rows).catch(reject);
  return query;
}
mockDb.raw = jest.fn((sql, bindings) => ({ rows: [], sql, bindings }));
mockDb.transaction = async (fn) => fn(mockDb);
// Recruiting reply classification is exercised in recruiting-inbound.test.js; these
// doubles cannot run it (no job_applications table shape), so stub it inert.
jest.mock('../utils/recruiting-thread-scope', () => { const real = jest.requireActual('../utils/recruiting-thread-scope'); return { ...real, isRecruitingPhone: jest.fn(async () => false) }; });
jest.mock('../services/recruiting-inbound', () => ({ matchApplicantReply: jest.fn(async () => null), recordApplicantReply: jest.fn(async () => ({ persisted: true, duplicate: false })) }));
jest.mock('../models/db', () => mockDb);
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => gate === 'webhooks'),
  gateEnvValue: (gate) => process.env[gate] === 'true',
  smsCourtesyAfterTemplateLive: () => process.env.GATE_SMS_COURTESY_AFTER_TEMPLATE === 'true',
}));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn() }));
jest.mock('../config/models', () => ({ TEXT_POLICIES: { fastStructured: 'test-policy' } }));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({})), isKnownOwnerPhone: jest.fn(() => false) }));
jest.mock('../services/messaging/validators/suppression', () => ({
  recordSuppression: jest.fn(async () => ({})), clearSuppression: jest.fn(async () => ({})),
}));
jest.mock('../services/messaging/inbound-dedupe', () => ({
  tryClaimInboundWebhook: jest.fn(async () => ({ processable: true, owned: true })),
  releaseInboundWebhook: jest.fn(async () => ({})),
}));
jest.mock('../services/conversations', () => ({
  recordTouchpoint: jest.fn(async () => ({ message: { id: 'saved-inbound-message' } })),
  updateByTwilioSid: jest.fn(async () => ({ id: 'saved-inbound-message' })),
}));
jest.mock('../services/sms-media', () => ({ uploadTwilioMedia: jest.fn(async () => []) }));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => ({})), isFailureStatus: jest.fn() }));
jest.mock('../services/sms-intent', () => ({
  hasSchedulingIntent: jest.fn(() => false), isSmsReaction: jest.fn(() => false),
  isQuietSmsReaction: jest.fn(() => false), isCourtesyOnly: jest.fn(() => false),
  hasRescheduleOrAwayIntent: jest.fn(() => false),
}));
jest.mock('../middleware/spam-block', () => ({ checkInboundBlock: jest.fn(async () => ({ blocked: false })) }));
jest.mock('../services/contact-correction', () => ({ detectContactCorrectionIntent: jest.fn(() => false) }));
jest.mock('../services/contact-correction-queue', () => ({}));
jest.mock('../services/recipient-optin', () => ({ markRecipientOptin: jest.fn(async () => true) }));
jest.mock('../utils/known-caller-phone', () => ({
  // The single relationship lookup twilio-webhook.js now uses for both the
  // STOP/HELP/START compliance gate AND the classifier's own eligibility
  // gate (codex round 3 design fix, 2026-09-11 — see the "Consent-before-
  // classification" section of the PR body).
  findKnownCallerCustomer: jest.fn(async () => null),
}));
jest.mock('../services/estimate-clarify-asks', () => ({ handleClarifyReply: jest.fn(async () => ({ handled: false })) }));
jest.mock('../services/estimator-engine/sms-thread', () => ({ smsThreadDraftsEnabled: () => true, startSmsThreadDraft: jest.fn(async () => ({})) }));
jest.mock('../services/estimate-conversion-agent', () => ({ processInboundSms: jest.fn(async () => ({})) }));
jest.mock('../services/tech-line', () => ({ notifyTechLineText: jest.fn(async () => ({})) }));
jest.mock('../services/notification-triggers', () => ({ triggerNotification: jest.fn(async () => ({})), __private: { redactSensitiveText: (t) => t } }));
jest.mock('../services/ai-assistant/assistant', () => ({ processMessage: jest.fn(async () => ({ reply: 'Hi there', escalated: false, conversationId: 'c1' })) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true })) }));
jest.mock('../services/staff-sender-phones', () => ({ isStaffTechSender: jest.fn(async () => false) }));

const { EventEmitter } = require('node:events');
const { recordTouchpoint, updateByTwilioSid } = require('../services/conversations');
const { handleClarifyReply } = require('../services/estimate-clarify-asks');
const { startSmsThreadDraft } = require('../services/estimator-engine/sms-thread');
const { processInboundSms } = require('../services/estimate-conversion-agent');
const { sendSMS } = require('../services/twilio');
const { uploadTwilioMedia } = require('../services/sms-media');
const { findKnownCallerCustomer } = require('../utils/known-caller-phone');
const numbers = require('../config/twilio-numbers');
const router = require('../routes/twilio-webhook');
const handler = router.stack.find((layer) => layer.route?.path === '/sms').route.stack[0].handle;

const { isStaffTechSender } = require('../services/staff-sender-phones');
const savedOwner = process.env.ADAM_PHONE;
const TECH_CELL = '+19415550142';
const OFFICE_LINE = numbers.locations.parrish.number;
const TECH_LINE = numbers.fieldTech[0] && numbers.fieldTech[0].number;

async function receive(body, { from = TECH_CELL, to = OFFICE_LINE, sid = 'SM-synthetic-staff-guard' } = {}) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: { From: from, To: to, Body: body, MessageSid: sid } }, res);
  await new Promise(setImmediate);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWrites.length = 0;
  mockWhereRawCalls.length = 0;
  mockSmsLogFirstQueue.length = 0;
  mockHistoryResults = [];
  mockOutboundHistoryCalls.length = 0;
  mockCustomersRows = null;
  mockOptoutReceipts.clear();
  process.env.ADAM_PHONE = '+12025550199';
  findKnownCallerCustomer.mockResolvedValue(null);
  isStaffTechSender.mockResolvedValue(false);
});
afterAll(() => {
  if (savedOwner === undefined) delete process.env.ADAM_PHONE;
  else process.env.ADAM_PHONE = savedOwner;
});

describe('an inbound text from an active technician\'s phone', () => {
  const asStaff = () => isStaffTechSender.mockImplementation(async (phone) => phone === TECH_CELL);
  const writesTo = (table) => mockWrites.filter((w) => w.table === table);
  const TEXT = 'Gate is locked at the next stop, can the office call the owner?';

  test('stays in the office inbox as an unread unknown-sender thread, exactly as today', async () => {
    asStaff();
    const res = await receive(TEXT);
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('<Response></Response>');
    expect(recordTouchpoint).toHaveBeenCalledTimes(1);
    const touch = recordTouchpoint.mock.calls[0][0];
    expect(touch).toMatchObject({ channel: 'sms', contactPhone: TECH_CELL, direction: 'inbound', body: TEXT, ourEndpointId: OFFICE_LINE });
    expect(touch.customerId).toBeUndefined();     // the unknown-sender thread, no customer
    expect(touch.isRead).toBe(false);             // unread, so the inbox dot and count show it
    const log = writesTo('sms_log');
    expect(log).toHaveLength(1);
    expect(log[0].row).toMatchObject({ customer_id: null, direction: 'inbound', from_phone: TECH_CELL, message_body: TEXT, message_type: 'inbound' });
    expect(log[0].row.is_read).toBeUndefined();
    expect(writesTo('activity_log')).toHaveLength(1);
  });

  test('raises the normal unknown-sender alert: one owner text forward', async () => {
    asStaff();
    await receive(TEXT);
    expect(sendSMS).toHaveBeenCalledTimes(1);
    expect(sendSMS.mock.calls[0][0]).toBe('+12025550199');
    expect(sendSMS.mock.calls[0][2]).toEqual({ messageType: 'internal_alert' });
  });

  test('skips the customer and lead side: no screen, estimator draft, agent, auto-reply or new-prospect bell', async () => {
    asStaff();
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
    const res = await receive('We have exclusive pest leads for you.');
    expect(res.statusCode).toBe(200);
    delete process.env.GATE_SMS_SPAM_CLASSIFIER;
    // Not screened as a solicitation: no verdict stored, never silenced.
    expect(recordTouchpoint.mock.calls[0][0].isRead).toBe(false);
    expect(JSON.parse(writesTo('sms_log')[0].row.metadata).spam_verdict).toBeUndefined();
    expect(updateByTwilioSid).not.toHaveBeenCalled();
    expect(handleClarifyReply).not.toHaveBeenCalled();
    expect(startSmsThreadDraft).not.toHaveBeenCalled();
    expect(processInboundSms).not.toHaveBeenCalled();
    expect(writesTo('customers')).toEqual([]);
    expect(writesTo('leads')).toEqual([]);
    expect(writesTo('message_drafts')).toEqual([]);
    expect(require('../services/notification-triggers').triggerNotification).not.toHaveBeenCalled();
    expect(require('../services/ai-assistant/assistant').processMessage).not.toHaveBeenCalled();
    expect(require('../services/messaging/send-customer-message').sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('control: the same pitch from a stranger IS screened, so the staff skip above is real', async () => {
    process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
    await receive('We have exclusive pest leads for you.');
    delete process.env.GATE_SMS_SPAM_CLASSIFIER;
    expect(JSON.parse(writesTo('sms_log')[0].row.metadata).spam_verdict).toBeDefined();
  });

  test('on the AI line it is not auto-replied to (a customer there is)', async () => {
    const gates = require('../config/feature-gates');
    gates.isEnabled.mockImplementation((gate) => gate === 'webhooks' || gate === 'aiAssistantAutoReply');
    const { processMessage } = require('../services/ai-assistant/assistant');
    try {
      await receive(TEXT, { to: numbers.tollFree.number });
      expect(processMessage).toHaveBeenCalledTimes(1);   // control: an ordinary sender is answered
      processMessage.mockClear();
      asStaff();
      await receive(TEXT, { to: numbers.tollFree.number, sid: 'SM-synthetic-staff-guard-2' });
      expect(processMessage).not.toHaveBeenCalled();
      expect(require('../services/messaging/send-customer-message').sendCustomerMessage).toHaveBeenCalledTimes(1);
    } finally {
      gates.isEnabled.mockImplementation((gate) => gate === 'webhooks');
    }
  });

  test('any other sender (or the gate off) is handled as today: the same inbox row, plus the estimator draft', async () => {
    const res = await receive(TEXT);
    expect(res.statusCode).toBe(200);
    expect(recordTouchpoint).toHaveBeenCalledTimes(1);
    expect(handleClarifyReply).toHaveBeenCalledTimes(1);
    expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
    expect(processInboundSms).toHaveBeenCalledTimes(1);
    expect(sendSMS).toHaveBeenCalledTimes(1);
  });

  test('a STOP keyword keeps its normal consent handling', async () => {
    asStaff();
    await receive('STOP');
    expect(recordTouchpoint).toHaveBeenCalledTimes(1);
    // Not treated as staff: the ordinary customer/lead side still sees it, as today.
    expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
  });

  (TECH_LINE ? test : test.skip)('a text to a technician line keeps its own conversation', async () => {
    asStaff();
    await receive('On my way', { to: TECH_LINE });
    expect(recordTouchpoint).toHaveBeenCalledTimes(1);
    expect(startSmsThreadDraft).toHaveBeenCalledTimes(1);
  });
});
