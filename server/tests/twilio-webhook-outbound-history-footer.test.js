// Codex P0 chokepoint fix, 2026-09-11: an unlinked prospect with no
// customer record and no service-contact match, but a genuine accepted
// outbound sms_log/messages row on file, is `complianceEligible` for
// STOP/HELP/START handling — and their own "Reply STOP to stop messages"
// must not be silently stripped as if it were a vendor's spoofed footer.
// A separate scenario: when the outbound-history lookup itself fails, the
// relationship is UNRESOLVED, and the established fail-direction for the
// footer-stripping guard (distinct from the eligibility fail-open) is to
// fail toward stripping — an unresolved relationship must never let a
// spoofed vendor footer through. See docs/public-route-contracts.md:210-251
// and the comment above `knownRelationship` in twilio-webhook.js.
//
// This file uses its own DB mock (rather than extending the shared one in
// twilio-webhook-solicitation.test.js) because it needs `whereIn`/`join`
// support for the real outbound-history query chain — the shared mock
// deliberately omits those so its own single reachable `sms_log`.first()
// call (the repeat-sender alert-quota check) stays unambiguous.
const mockWrites = [];
// Consumed in the exact order queryOutboundHistory queries sms_log,
// messages, then messaging_suppression — a match on any of the eligible
// tables short-circuits the rest. The repeat-sender alert-quota check (a
// later, separate db('sms_log').first() call) also draws from this same
// table set; leaving it empty after the outbound-history checks run is the
// correct neutral default for that unrelated check.
let mockHistoryResults = [];
let mockHistoryShouldFail = false;
const HISTORY_TABLES = ['sms_log', 'messages', 'messaging_suppression'];

function mockDb(table) {
  const query = { rows: [] };
  for (const method of ['where', 'whereNull', 'whereNot', 'whereIn', 'whereNotIn', 'orWhereNull', 'orderBy', 'limit', 'join']) {
    query[method] = () => query;
  }
  query.whereRaw = () => query;
  query.insert = (row) => {
    mockWrites.push({ table, row });
    query.rows = [{ id: '00000000-0000-4000-8000-000000000002', created_at: new Date(), ...row }];
    query.onConflict = () => query;
    query.merge = async () => query.rows;
    return query;
  };
  query.first = async () => {
    if (!HISTORY_TABLES.includes(table)) return null;
    if (mockHistoryShouldFail) throw Object.assign(new Error('outbound-history query failed'), { code: '08006' });
    return mockHistoryResults.shift() ?? null;
  };
  query.returning = async () => query.rows;
  query.then = (resolve, reject) => Promise.resolve(query.rows).then(resolve, reject);
  query.catch = (reject) => Promise.resolve(query.rows).catch(reject);
  return query;
}
mockDb.raw = jest.fn((sql, bindings) => ({ rows: [], sql, bindings }));
mockDb.transaction = async (fn) => fn(mockDb);
jest.mock('../models/db', () => mockDb);
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn((gate) => gate === 'webhooks'),
  gateEnvValue: (gate) => process.env[gate] === 'true',
}));
jest.mock('../services/llm/call', () => ({ dispatchWithFallback: jest.fn(async () => ({ ok: true, json: { solicitation: false, confidence: 0 } })) }));
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
  knownCallerPhoneExists: jest.fn(async () => false),
  findKnownCallerCustomer: jest.fn(async () => null),
}));
jest.mock('../services/estimate-clarify-asks', () => ({ handleClarifyReply: jest.fn(async () => ({ handled: false })) }));
jest.mock('../services/estimator-engine/sms-thread', () => ({ smsThreadDraftsEnabled: () => true, startSmsThreadDraft: jest.fn(async () => ({})) }));
jest.mock('../services/estimate-conversion-agent', () => ({ processInboundSms: jest.fn(async () => ({})) }));
jest.mock('../services/tech-line', () => ({ notifyTechLineText: jest.fn(async () => ({})) }));

const { EventEmitter } = require('node:events');
const { recordSuppression } = require('../services/messaging/validators/suppression');
const numbers = require('../config/twilio-numbers');
const router = require('../routes/twilio-webhook');
const handler = router.stack.find((layer) => layer.route?.path === '/sms').route.stack[0].handle;
const savedGate = process.env.GATE_SMS_SPAM_CLASSIFIER;

async function receive(body) {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.status = (code) => { res.statusCode = code; return res; };
  res.type = () => res;
  res.send = (value) => { res.body = value; return res; };
  await handler({ body: {
    From: '+12025550188', To: numbers.locations.parrish.number,
    Body: body, MessageSid: 'SM-synthetic-outbound-history',
  } }, res);
  await new Promise(setImmediate);
  expect(res.statusCode).toBe(200);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockWrites.length = 0;
  mockHistoryResults = [];
  mockHistoryShouldFail = false;
  process.env.GATE_SMS_SPAM_CLASSIFIER = 'true';
});
afterAll(() => {
  if (savedGate === undefined) delete process.env.GATE_SMS_SPAM_CLASSIFIER;
  else process.env.GATE_SMS_SPAM_CLASSIFIER = savedGate;
});

test('an unlinked prospect with real outbound history keeps their own opt-out intact in enforcement mode', async () => {
  // A provider-accepted outbound sms_log row is enough — queryOutboundHistory's
  // FIRST query (sms_log) returns a match and short-circuits.
  mockHistoryResults = [{ id: 'sms-1' }];
  const res = await receive('Reply STOP to stop messages');
  expect(res.body).toContain('unsubscribed');
  expect(recordSuppression).toHaveBeenCalledTimes(1);
  expect(mockWrites.find(({ table }) => table === 'sms_log').row.message_type).toBe('opt_out');
});

// The established fail-direction (see the file-header comment): the
// eligibility gate itself (`complianceEligible`) still fails OPEN on this
// same lookup error (a real bare STOP is never silently refused), but the
// footer-stripping guard (`knownRelationship`) does not inherit that
// fail-open — an unresolved relationship fails toward stripping, so a
// vendor's spoofed reply-instruction footer can never slip through during
// a DB hiccup. This deliberately reads OPPOSITE of a literal "lookup error
// never strips" rule; the reasoning is in the file-header comment.
test('an outbound-history lookup error strips the footer instead of trusting it', async () => {
  mockHistoryShouldFail = true;
  const res = await receive('Reply STOP to stop messages');
  expect(res.body).not.toContain('unsubscribed');
  expect(recordSuppression).not.toHaveBeenCalled();
  const row = mockWrites.find(({ table }) => table === 'sms_log').row;
  expect(row.message_type).not.toBe('opt_out');
});
