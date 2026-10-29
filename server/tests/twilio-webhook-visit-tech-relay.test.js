// GATE_CUSTOMER_TEXT_TO_VISIT_TECH, M3 (census 2026-10-25): a known customer's text to an office line
// also goes to services/visit-tech-relay.js, which picks the visit's technician (tested against Postgres
// in visit-tech-relay-postgres.test.js, so it is stubbed here). Same harness as tech-staff-guards-sms.test.js
// (real webhook, mocked persistence and providers; nothing is sent).
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
  customerTextToVisitTechLive: () => process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH === 'true',
  smsBareYesReplyLive: () => process.env.GATE_SMS_BARE_YES_REPLY === 'true',
}));
jest.mock('../services/messaging/bare-yes-reply', () => ({ bareYesIsReply: jest.fn(async () => true) }));
jest.mock('../services/visit-tech-relay', () => ({ relayCustomerTextToVisitTech: jest.fn(async () => 1), errorTag: (e) => String((e && (e.code || e.name)) || 'error') }));
jest.mock('../services/reschedule-sms', () => ({ handleRescheduleReply: jest.fn(async () => ({ handled: false })) }));
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
const CUSTOMER_CELL = '+12025550101';
const OFFICE_LINE = numbers.locations.parrish.number;
const TECH_LINE = numbers.fieldTech[0] && numbers.fieldTech[0].number;

async function receive(body, { from = TECH_CELL, to = OFFICE_LINE, sid = 'SM-synthetic-staff-guard' } = {}) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; res.emit('finish'); return res; };
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
  delete process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH;
  delete process.env.GATE_SMS_BARE_YES_REPLY;
});
afterAll(() => {
  if (savedOwner === undefined) delete process.env.ADAM_PHONE;
  else process.env.ADAM_PHONE = savedOwner;
  delete process.env.GATE_SMS_BARE_YES_REPLY;
});


const { relayCustomerTextToVisitTech } = require('../services/visit-tech-relay');
const KNOWN = { id: 'customer-1', first_name: 'Synthetic', last_name: 'Customer', phone: CUSTOMER_CELL };

describe('a known customer\'s text to an office line (GATE_CUSTOMER_TEXT_TO_VISIT_TECH)', () => {
  test('gate on: the text goes to the visit tech relay with the customer, sender and body', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    mockCustomersRows = [KNOWN];

    const res = await receive('The gate is open', { from: CUSTOMER_CELL });

    expect(res.statusCode).toBe(200);
    expect(relayCustomerTextToVisitTech).toHaveBeenCalledTimes(1);
    expect(relayCustomerTextToVisitTech).toHaveBeenCalledWith({ from: CUSTOMER_CELL, body: 'The gate is open', mediaCount: 0 });
    // The office path is unchanged: the inbox row is still written.
    expect(recordTouchpoint).toHaveBeenCalledTimes(1);
  });

  test('gate on: a reply a reschedule offer consumes still reaches the relay (Codex #6760 r1)', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    mockCustomersRows = [KNOWN];
    const { handleRescheduleReply } = require('../services/reschedule-sms');
    handleRescheduleReply.mockResolvedValueOnce({ handled: true, action: 'call_requested' });

    const res = await receive('Please call before entering, the dog is outside', { from: CUSTOMER_CELL });

    expect(res.statusCode).toBe(200);
    expect(handleRescheduleReply).toHaveBeenCalledTimes(1);
    expect(relayCustomerTextToVisitTech).toHaveBeenCalledTimes(1);
    expect(relayCustomerTextToVisitTech).toHaveBeenCalledWith(expect.objectContaining({ body: 'Please call before entering, the dog is outside' }));
  });

  test('gate on: a saved service contact (no primary-phone match) goes to the relay, which resolves the customer (Codex #6760 r1)', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    findKnownCallerCustomer.mockResolvedValue({ id: 'customer-1', first_name: 'Synthetic', last_name: 'Customer' });

    await receive('The gate is open', { from: '+12025550133' });

    expect(relayCustomerTextToVisitTech).toHaveBeenCalledTimes(1);
    expect(relayCustomerTextToVisitTech).toHaveBeenCalledWith(expect.objectContaining({ from: '+12025550133' }));
  });

  test('gate off: no relay', async () => {
    mockCustomersRows = [KNOWN];
    await receive('The gate is open', { from: CUSTOMER_CELL });
    expect(relayCustomerTextToVisitTech).not.toHaveBeenCalled();
  });

  test('gate on: an unknown sender is not relayed', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    await receive('Who is this?', { from: '+12025550188' });
    expect(relayCustomerTextToVisitTech).not.toHaveBeenCalled();
  });

  test('gate on: a text to the AI customer-chat line is not relayed (Codex #6760 security review)', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    mockCustomersRows = [KNOWN];
    await receive('The gate is open', { from: CUSTOMER_CELL, to: numbers.tollFree.number });
    expect(relayCustomerTextToVisitTech).not.toHaveBeenCalled();
  });

  test('gate on: a STOP keyword is not relayed', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    mockCustomersRows = [KNOWN];
    await receive('STOP', { from: CUSTOMER_CELL });
    expect(relayCustomerTextToVisitTech).not.toHaveBeenCalled();
  });

  test('gate on: a bare YES is START and not relayed while GATE_SMS_BARE_YES_REPLY is off', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    mockCustomersRows = [KNOWN];
    await receive('Yes', { from: CUSTOMER_CELL });
    expect(relayCustomerTextToVisitTech).not.toHaveBeenCalled();
  });

  test('gate on: a bare YES that GATE_SMS_BARE_YES_REPLY calls a reply reaches the relay (an answer to the technician)', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    process.env.GATE_SMS_BARE_YES_REPLY = 'true';
    mockCustomersRows = [KNOWN];
    const res = await receive('Yes', { from: CUSTOMER_CELL });
    expect(res.statusCode).toBe(200);
    expect(relayCustomerTextToVisitTech).toHaveBeenCalledWith({ from: CUSTOMER_CELL, body: 'Yes', mediaCount: 0 });
  });

  test('gate on: a staff sender is not relayed', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    mockCustomersRows = [KNOWN];
    isStaffTechSender.mockResolvedValue(true);
    await receive('Running late to the next stop', { from: TECH_CELL });
    expect(relayCustomerTextToVisitTech).not.toHaveBeenCalled();
  });

  // A registry tech line is a technician line only while GATE_TECH_LINES is on; off, it is
  // an office (location) line and is relayed like one (twilio-numbers.js).
  (TECH_LINE ? test : test.skip)('gate on: a text to a live technician line is left to tech-line.js', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    process.env.GATE_TECH_LINES = 'true';
    mockCustomersRows = [KNOWN];
    try {
      await receive('The gate is open', { from: CUSTOMER_CELL, to: TECH_LINE });
    } finally {
      delete process.env.GATE_TECH_LINES;
    }
    expect(relayCustomerTextToVisitTech).not.toHaveBeenCalled();
    expect(require('../services/tech-line').notifyTechLineText).toHaveBeenCalledTimes(1);
  });

  test('gate on: a relay failure is logged and the webhook still answers 200', async () => {
    process.env.GATE_CUSTOMER_TEXT_TO_VISIT_TECH = 'true';
    mockCustomersRows = [KNOWN];
    relayCustomerTextToVisitTech.mockRejectedValueOnce(new Error('synthetic relay failure'));

    const res = await receive('The dog is out', { from: CUSTOMER_CELL });

    expect(res.statusCode).toBe(200);
    expect(recordTouchpoint).toHaveBeenCalledTimes(1);
  });
});
