/**
 * /api/tech/line — a technician's own line from the tech portal. The
 * customer is always the VISIT's customer (never a client-supplied number);
 * techs reach only visits assigned to them.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../middleware/admin-auth', () => ({
  adminAuthenticate: (_req, _res, next) => next(),
  requireTechOrAdmin: (_req, _res, next) => next(),
}));
jest.mock('../services/tech-line', () => ({ techLineContext: jest.fn() }));
jest.mock('../services/call-bridge', () => ({
  placeBridgeCall: jest.fn(async () => ({ callSid: 'CA-1', callLogId: 'log-1' })),
  activeBridgeCall: jest.fn(async () => null),
}));
jest.mock('../services/lead-estimate-link', () => ({ stampFirstResponseByContact: jest.fn(async () => 1) }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM-real' })) }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/sms-suggest-mode', () => ({
  reserveHumanReply: jest.fn(async () => ({ parkedDecisionIds: ['dec-1'], reservationId: 'resv-1', autoSendInFlight: false })),
  settleHumanReply: jest.fn(async () => undefined),
}));
jest.mock('../services/twilio-failure-alerts', () => ({ alertTwilioFailure: jest.fn(async () => undefined) }));

const db = require('../models/db');
const { techLineContext } = require('../services/tech-line');
const { placeBridgeCall, activeBridgeCall } = require('../services/call-bridge');
const { stampFirstResponseByContact } = require('../services/lead-estimate-link');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { isEnabled } = require('../config/feature-gates');
const { reserveHumanReply, settleHumanReply } = require('../services/sms-suggest-mode');
const { alertTwilioFailure } = require('../services/twilio-failure-alerts');
const router = require('../routes/tech-line');

const VISIT = '11111111-1111-4111-8111-111111111111';
const LINE = { number: '+19413529161', formatted: '(941) 352-9161', label: 'Tech line 1' };
const CTX = { line: LINE, cell: '+19415550101', technicianName: 'Jordan' };

function handlerFor(method, path) {
  const layer = router.stack.find((l) => l.route && l.route.path === path && l.route.methods[method]);
  return layer.route.stack[0].handle;
}
function res() {
  const r = { statusCode: 200, body: null };
  r.status = jest.fn((c) => { r.statusCode = c; return r; });
  r.json = jest.fn((b) => { r.body = b; return r; });
  return r;
}
async function call(method, path, req) {
  const r = res(); const next = jest.fn();
  await handlerFor(method, path)({ technicianId: 'tech-1', techRole: 'technician', body: {}, ...req }, r, next);
  if (next.mock.calls[0]?.[0]) throw next.mock.calls[0][0];
  return r;
}
const chains = {};
const CLAIM_SQL = /INSERT INTO sms_send_claims/;
function primeVisit({ visit = { id: VISIT, customer_id: 'c1', technician_id: 'tech-1' }, customer = { id: 'c1', first_name: 'Pat', last_name: 'Sample', phone: '(941) 555-0100' } } = {}) {
  for (const k of Object.keys(chains)) delete chains[k];
  db.mockImplementation((table) => {
    const chain = {};
    chain.where = jest.fn(() => chain);
    chain.whereNull = jest.fn(() => chain);
    chain.first = jest.fn(async () => (table === 'scheduled_services' ? visit : customer));
    chain.del = jest.fn(async () => 1);
    chain.catch = jest.fn(() => undefined);
    chains[table] = chain;
    return chain;
  });
  // The durable text claim answers through db.raw (a row = claim acquired).
  db.raw = jest.fn((sql) => (CLAIM_SQL.test(String(sql)) ? Promise.resolve({ rows: [{ id: 1 }] }) : sql));
}

// Both send routes gate on a durable sms_send_claims claim taken on the
// pool (db.raw; a row = claim acquired) — never an advisory-lock
// transaction (codex #4072 r15 P2).
beforeEach(() => {
  jest.clearAllMocks();
  techLineContext.mockResolvedValue(CTX);
  isEnabled.mockReturnValue(true);
});

describe('GET /', () => {
  test('reports the line and whether calls can bridge', async () => {
    const r = await call('get', '/', {});
    expect(r.body).toEqual({ line: LINE, canCall: true });
    techLineContext.mockResolvedValue({ ...CTX, cell: null });
    expect((await call('get', '/', {})).body).toEqual({ line: LINE, canCall: false });
    techLineContext.mockResolvedValue(null);
    expect((await call('get', '/', {})).body).toEqual({ line: null });
  });

  test('a lookup failure is a 503 the client keeps as "unknown" — never a { line: null } that shows the personal phone', async () => {
    techLineContext.mockRejectedValueOnce(new Error('select * from technicians where id = tech-1 — pg down'));
    const r = await call('get', '/', {});
    expect(r.statusCode).toBe(503);
    expect(r.body).toEqual({ error: 'Your line could not be checked', code: 'LINE_LOOKUP_FAILED' });
    expect(techLineContext).toHaveBeenCalledWith('tech-1', { strict: true });
  });
});

describe('POST /sms', () => {
  test('texts the visit customer from the line as a HUMAN (manual) reply, parking and settling the thread', async () => {
    primeVisit();
    const r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: '  On my way.  ' } });
    expect(r.statusCode).toBe(200);
    expect(reserveHumanReply).toHaveBeenCalledWith({ to: '+19415550100', customerId: 'c1', fromNumber: '+19413529161', body: 'On my way.', adminUserId: 'tech-1' });
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: '+19415550100', body: 'On my way.', channel: 'sms', audience: 'customer', purpose: 'conversational',
      customerId: 'c1', identityTrustLevel: 'phone_matches_customer', entryPoint: 'tech_line_text',
      metadata: expect.objectContaining({ original_message_type: 'manual', tech_line: true, scheduled_service_id: VISIT, adminUserId: 'tech-1', fromNumber: '+19413529161', parkedDecisionIds: ['dec-1'] }),
    }));
    expect(settleHumanReply).toHaveBeenCalledWith(expect.objectContaining({ parkedDecisionIds: ['dec-1'], reservationId: 'resv-1', sent: true, reviewedBy: 'tech-1' }));
    expect(r.body).toEqual({ success: true, from: LINE });
  });

  test('a live claim on (customer, body) refuses the text under the per-customer lock — a double submit from two PWAs never reaches Twilio (codex #4072 r10 + r11 P2)', async () => {
    primeVisit();
    db.raw.mockImplementationOnce(async () => ({ rows: [] })); // claim held by the other request
    const r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('DUPLICATE_TEXT');
    const [claimSql, claimBindings] = db.raw.mock.calls.find((c) => CLAIM_SQL.test(String(c[0])));
    // The provider's retry horizon for an ambiguous outcome (codex r19 P2).
    expect(claimSql).toContain("interval '5 minutes'");
    expect(claimBindings[0]).toMatch(/^tech-line-text:c1:[0-9a-f]{64}$/);
    expect(reserveHumanReply).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(chains.sms_send_claims).toBeUndefined(); // a claim we never held is never released
    // Claim acquired — committed on its own statement BEFORE the send, so it
    // survives an accepted send whatever happens afterwards (codex r13 P2)
    // — and no transaction pins a pool connection meanwhile (r15 P2).
    primeVisit();
    const ok = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } });
    expect(ok.statusCode).toBe(200);
    const claimCall = db.raw.mock.calls.findIndex((c) => CLAIM_SQL.test(String(c[0])));
    expect(db.raw.mock.invocationCallOrder[claimCall]).toBeLessThan(sendCustomerMessage.mock.invocationCallOrder[0]);
    expect(db.transaction).toBeUndefined();
    // Kept: the only claims write after a delivered text is the daily prune, never a release by key.
    expect(chains.sms_send_claims.where).not.toHaveBeenCalledWith({ claim_key: expect.any(String) });
  });

  test('a text that never left (gate-off sentinel) releases its claim so a real retry can send', async () => {
    primeVisit();
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'gate-blocked' });
    const r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } });
    expect(r.statusCode).toBe(409);
    expect(db).toHaveBeenCalledWith('sms_send_claims');
    expect(chains.sms_send_claims.where).toHaveBeenCalledWith({ claim_key: expect.stringMatching(/^tech-line-text:c1:/) });
    expect(chains.sms_send_claims.del).toHaveBeenCalled();
  });

  test('an ambiguous provider outcome (retryable / deferred, not accepted, not blocked) keeps the claim AND the parked suggestions — the carrier may hold the text (codex #4072 r15 P2)', async () => {
    primeVisit();
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, retryable: true, code: 'PROVIDER_TIMEOUT', reason: 'Twilio timed out' });
    let r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } });
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ code: 'PROVIDER_TIMEOUT', mayHaveSent: true });
    expect(chains.sms_send_claims).toBeUndefined(); // claim kept
    // Reservation row cleared, parked suggestions neither reopened nor ignored.
    expect(settleHumanReply).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'resv-1', parkedDecisionIds: [], sent: false }));
    // A validator block is definitive even when flagged retryable: released + reopened.
    primeVisit(); settleHumanReply.mockClear();
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, retryable: true, code: 'QUIET_HOURS', reason: 'Quiet hours' });
    r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } });
    expect(r.statusCode).toBe(409);
    expect(r.body.mayHaveSent).toBeUndefined();
    expect(chains.sms_send_claims.del).toHaveBeenCalled();
    expect(settleHumanReply).toHaveBeenCalledWith(expect.objectContaining({ parkedDecisionIds: ['dec-1'], sent: false }));
    // An ambiguous THROW (audit failed after a timeout) keeps the claim too.
    primeVisit(); settleHumanReply.mockClear();
    sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('audit failed'), { providerOutcome: { sent: false, retryable: true } }));
    await expect(call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } })).rejects.toMatchObject({ statusCode: 500 });
    expect(chains.sms_send_claims).toBeUndefined();
    expect(settleHumanReply).toHaveBeenCalledWith(expect.objectContaining({ parkedDecisionIds: [], sent: false }));
    // Canonical uncertainty is authoritative even without legacy retry flags.
    primeVisit(); settleHumanReply.mockClear();
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_UNKNOWN' });
    r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } });
    expect(r.body).toMatchObject({ mayHaveSent: true });
    expect(chains.sms_send_claims).toBeUndefined();
    // A proven 429 rejection is retryable but definitively did not send.
    primeVisit(); settleHumanReply.mockClear();
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, deliveryOutcome: 'not_sent', retryable: true, code: '20429' });
    r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } });
    expect(r.body.mayHaveSent).toBeUndefined();
    expect(chains.sms_send_claims.del).toHaveBeenCalled();
  });

  test('a delivered text stamps the first response on any open lead with this phone — a suppressed send does not (codex #4072 r8 P2)', async () => {
    primeVisit();
    let r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } });
    expect(r.statusCode).toBe(200);
    expect(stampFirstResponseByContact).toHaveBeenCalledWith({ phone: '+19415550100', performedBy: 'tech:tech-1' });
    // Fail-soft: a stamp failure never turns a sent text into an error.
    stampFirstResponseByContact.mockRejectedValueOnce(new Error('leads down'));
    r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } });
    expect(r.statusCode).toBe(200);
    // The SMS-gate-off sentinel (sent:true, no provider id) never stamps.
    stampFirstResponseByContact.mockClear();
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'gate-blocked' });
    r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'On my way' } });
    expect(r.statusCode).toBe(409);
    expect(stampFirstResponseByContact).not.toHaveBeenCalled();
  });

  test('an autonomous reply mid-send backs the tech off (409), nothing sent', async () => {
    primeVisit();
    reserveHumanReply.mockResolvedValueOnce({ parkedDecisionIds: [], reservationId: null, autoSendInFlight: true });
    const r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('AUTO_REPLY_IN_FLIGHT');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a reply reservation failure aborts before the provider', async () => {
    primeVisit();
    reserveHumanReply.mockRejectedValueOnce(new Error('reservation unavailable'));
    await expect(call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } }))
      .rejects.toMatchObject({ isOperational: true, statusCode: 500, message: 'Tech line text failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a customer row holding a Waves number is refused (never re-enter /voice)', async () => {
    primeVisit({ customer: { id: 'c1', first_name: 'Pat', phone: '+19413187612' } });
    const r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } });
    expect(r.statusCode).toBe(409);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('a provider/DB throw settles the thread as unanswered and reaches the error middleware sanitized', async () => {
    primeVisit();
    sendCustomerMessage.mockRejectedValueOnce(new Error('insert into sms_log (to_phone, message_body) values (+19415550100, gate code 4412) — pg down'));
    await expect(call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'gate code 4412' } })).rejects.toMatchObject({
      isOperational: true, statusCode: 500, message: 'Tech line text failed',
    });
    expect(settleHumanReply).toHaveBeenCalledWith(expect.objectContaining({ sent: false }));
    // Nothing left → the claim is released so a real retry can send (codex r13 P2).
    expect(chains.sms_send_claims.del).toHaveBeenCalled();
  });

  test('a throw AFTER Twilio accepted settles the thread as answered and reports Sent — never a retry invitation', async () => {
    primeVisit();
    sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('insert into messaging_audit_log — pg down'), { providerOutcome: { sent: true, providerMessageId: 'SM-real' } }));
    const r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } });
    expect(r.statusCode).toBe(200);
    expect(r.body).toEqual({ success: true, from: LINE });
    expect(settleHumanReply).toHaveBeenCalledWith(expect.objectContaining({ sent: true, reviewedBy: 'tech-1' }));
    // The customer has the text: first response stamped, claim kept (codex r13 P2).
    expect(stampFirstResponseByContact).toHaveBeenCalledWith({ phone: '+19415550100', performedBy: 'tech:tech-1' });
    expect(chains.sms_send_claims.where).not.toHaveBeenCalledWith({ claim_key: expect.any(String) });
  });

  test('a throw after a SUPPRESSED accept (sentinel id) is still a failure — nothing left', async () => {
    primeVisit();
    sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('audit down'), { providerOutcome: { sent: true, providerMessageId: 'gate-blocked' } }));
    await expect(call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } })).rejects.toMatchObject({ statusCode: 500 });
    expect(settleHumanReply).toHaveBeenCalledWith(expect.objectContaining({ sent: false }));
  });

  test('a visit on another tech\'s route is refused; an admin may text any visit', async () => {
    primeVisit({ visit: { id: VISIT, customer_id: 'c1', technician_id: 'tech-2' } });
    expect((await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } })).statusCode).toBe(403);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect((await call('post', '/sms', { techRole: 'admin', body: { scheduledServiceId: VISIT, body: 'hi' } })).statusCode).toBe(200);
  });

  test('no line → 409 NO_TECH_LINE; empty / oversize body → 400; bad visit id → 400; unknown → 404; no phone → 409', async () => {
    primeVisit();
    expect((await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: '   ' } })).statusCode).toBe(400);
    expect((await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'x'.repeat(601) } })).statusCode).toBe(400);
    techLineContext.mockResolvedValueOnce(null);
    expect((await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } })).body.code).toBe('NO_TECH_LINE');
    expect((await call('post', '/sms', { body: { scheduledServiceId: 'nope', body: 'hi' } })).statusCode).toBe(400);
    primeVisit({ visit: null });
    expect((await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } })).statusCode).toBe(404);
    primeVisit({ customer: { id: 'c1', phone: null } });
    expect((await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } })).statusCode).toBe(409);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the SMS-gate-off sentinel (sent:true, no provider id) is a 409, never "Sent."', async () => {
    primeVisit();
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'gate-blocked' });
    const r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('SMS_GATE_OFF');
  });

  test('a guard refusal is a 409 carrying the reason, never a silent 200; parked suggestions reopen', async () => {
    primeVisit();
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'QUIET_HOURS_HOLD', reason: 'Quiet hours', deferred: true });
    const r = await call('post', '/sms', { body: { scheduledServiceId: VISIT, body: 'hi' } });
    expect(r.statusCode).toBe(409);
    expect(r.body).toEqual({ error: 'Quiet hours', code: 'QUIET_HOURS_HOLD', deferred: true });
    expect(settleHumanReply).toHaveBeenCalledWith(expect.objectContaining({ sent: false }));
  });
});

describe('POST /call', () => {
  test('bridges the tech\'s cell to the visit customer with the line as caller ID', async () => {
    primeVisit();
    const r = await call('post', '/call', { body: { scheduledServiceId: VISIT } });
    expect(r.statusCode).toBe(200);
    expect(placeBridgeCall).toHaveBeenCalledWith({
      to: '+19415550100', bridgePhone: '+19415550101', from: '+19413529161',
      customer: expect.objectContaining({ id: 'c1' }), source: 'tech-click', adminUserId: 'tech-1',
      metadata: { scheduledServiceId: VISIT }, leadName: 'Pat Sample',
    });
    expect(r.body).toEqual({ success: true, callSid: 'CA-1', callLogId: 'log-1', from: LINE });
    // Row check → durable claim → bridge; no transaction pins a pool
    // connection across the Twilio call (codex #4072 r8 / r9 / r15 P2).
    // Scoped to the customer AND the tech's line; the claim is per line (codex r20 P2).
    expect(activeBridgeCall).toHaveBeenCalledWith({ source: 'tech-click', customerId: 'c1', fromPhone: '+19413529161' });
    const claimIdx = db.raw.mock.calls.findIndex((c) => CLAIM_SQL.test(String(c[0])));
    expect(db.raw.mock.calls[claimIdx][1]).toEqual(['tech-bridge:+19413529161']);
    expect(activeBridgeCall.mock.invocationCallOrder[0]).toBeLessThan(db.raw.mock.invocationCallOrder[claimIdx]);
    expect(db.raw.mock.invocationCallOrder[claimIdx]).toBeLessThan(placeBridgeCall.mock.invocationCallOrder[0]);
    expect(db.transaction).toBeUndefined();
    expect(chains.sms_send_claims).toBeUndefined(); // kept
  });

  test('a bridge still ringing or connected → 409 CALL_IN_FLIGHT, no second Twilio call (codex #4072 r8 P2)', async () => {
    primeVisit();
    activeBridgeCall.mockResolvedValueOnce({ id: 'log-0', status: 'ringing' });
    let r = await call('post', '/call', { body: { scheduledServiceId: VISIT } });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('CALL_IN_FLIGHT');
    expect(placeBridgeCall).not.toHaveBeenCalled();
    // Two taps racing the first row's insert: the claim decides (r9 P2).
    primeVisit();
    db.raw.mockImplementationOnce(async () => ({ rows: [] }));
    r = await call('post', '/call', { body: { scheduledServiceId: VISIT } });
    expect(r.statusCode).toBe(409);
    expect(r.body.code).toBe('CALL_IN_FLIGHT');
    expect(placeBridgeCall).not.toHaveBeenCalled();
  });

  test('voice gate off, no line, or no usable cell → 409 with a code; another tech\'s visit → 403', async () => {
    primeVisit();
    isEnabled.mockReturnValueOnce(false);
    expect((await call('post', '/call', { body: { scheduledServiceId: VISIT } })).body.code).toBe('VOICE_GATE_OFF');
    techLineContext.mockResolvedValueOnce(null);
    expect((await call('post', '/call', { body: { scheduledServiceId: VISIT } })).body.code).toBe('NO_TECH_LINE');
    techLineContext.mockResolvedValueOnce({ ...CTX, cell: null });
    expect((await call('post', '/call', { body: { scheduledServiceId: VISIT } })).body.code).toBe('NO_CELL');
    primeVisit({ visit: { id: VISIT, customer_id: 'c1', technician_id: 'tech-2' } });
    expect((await call('post', '/call', { body: { scheduledServiceId: VISIT } })).statusCode).toBe(403);
    expect(placeBridgeCall).not.toHaveBeenCalled();
  });

  test('a rejected Twilio create raises the operator failure bell and surfaces sanitized', async () => {
    primeVisit();
    placeBridgeCall.mockRejectedValueOnce(Object.assign(new Error('Unable to create record: The number +19415550100 is unverified'), { code: 21219 }));
    await expect(call('post', '/call', { body: { scheduledServiceId: VISIT } })).rejects.toMatchObject({ isOperational: true, statusCode: 500, message: 'Tech line call failed' });
    expect(alertTwilioFailure).toHaveBeenCalledWith(expect.objectContaining({ channel: 'voice', direction: 'outbound', phase: 'send_api', status: 'failed', from: '+19413529161', to: '+19415550101' }));
    // No call was placed: the bridge claim goes back so the tech can retry now.
    expect(chains.sms_send_claims.del).toHaveBeenCalled();
  });

  test('an ambiguous transport failure on the create keeps the claim and the row — the call may be ringing — and answers 409, still raising the bell (codex #4072 r16 P2)', async () => {
    primeVisit();
    placeBridgeCall.mockRejectedValueOnce(Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT', bridgeAmbiguous: true }));
    const r = await call('post', '/call', { body: { scheduledServiceId: VISIT } });
    expect(r.statusCode).toBe(409);
    expect(r.body).toMatchObject({ code: 'CALL_IN_FLIGHT', mayHaveStarted: true });
    expect(chains.sms_send_claims).toBeUndefined(); // claim kept
    expect(alertTwilioFailure).toHaveBeenCalledWith(expect.objectContaining({ channel: 'voice', phase: 'send_api' }));
  });
});

describe('tech-click calls take the processor\'s tech follow-up seam (codex #4072 r1–r8)', () => {
  // The processor finalizes a tech's own-line call at ONE seam above the
  // lead pipeline (isTechFollowUpCall) — pin the source string the route
  // sends to the one the seam matches, and keep the seam the only place
  // the source is special-cased so a rename cannot re-open a branch.
  test('the route\'s bridge source is exactly the one the processor short-circuits on', () => {
    const fs = require('fs');
    const path = require('path');
    const proc = fs.readFileSync(path.join(__dirname, '../services/call-recording-processor.js'), 'utf8');
    expect(proc).toContain("return call?.source === 'tech-click';");
    expect(proc.indexOf('if (isTechFollowUpCall(call)) {')).toBeLessThan(proc.indexOf('// ── Voicemail routing ──'));
    expect(proc).not.toContain("call.source !== 'tech-click'");
    const route = fs.readFileSync(path.join(__dirname, '../routes/tech-line.js'), 'utf8');
    expect(route).toContain("source: 'tech-click'");
  });
});
