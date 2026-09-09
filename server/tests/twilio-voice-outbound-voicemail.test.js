/**
 * Outbound voicemail text-back — webhook side (routes/twilio-voice-webhook.js).
 *
 * Pins: /outbound-connect renders byte-identical TwiML with the gate OFF (no
 * machine detection, no <Dial action>) and adds AMD + the action with the
 * gate ON; /outbound-amd ignores human/unknown verdicts, leaves the customer
 * leg UP when the text cannot go, and on a machine verdict sends the text,
 * stamps the call_log, then hangs up the CHILD leg by REST with the linked
 * customer's first name; /outbound-dial-complete tells the admin only when
 * a voicemail was detected and otherwise hangs up silently.
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/twilio-failure-alerts', () => ({
  alertTwilioFailure: jest.fn(() => Promise.resolve()),
  isFailureStatus: jest.fn(() => false),
}));
jest.mock('../services/conversations', () => ({ recordTouchpoint: jest.fn(), syncVoiceMessageForCall: jest.fn() }));
jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));
jest.mock('../services/outbound-voicemail-sms', () => {
  const actual = jest.requireActual('../services/outbound-voicemail-sms');
  return {
    GATE: actual.GATE,
    isVoicemailAnsweredBy: actual.isVoicemailAnsweredBy,
    sendOutboundVoicemailText: jest.fn(async () => ({ sent: true, providerMessageId: 'SM_sent' })),
  };
});
jest.mock('../services/outbound-call-reason', () => ({
  REASONS: jest.requireActual('../services/outbound-call-reason').REASONS,
  resolveOutboundCallReason: jest.fn(async () => ({ reason: 'generic', evidence: {} })),
}));
jest.mock('twilio', () => {
  const actual = jest.requireActual('twilio');
  const update = jest.fn(async () => ({}));
  const calls = jest.fn(() => ({ update }));
  const client = jest.fn(() => ({ calls }));
  client.twiml = actual.twiml;
  client.__update = update;
  client.__calls = calls;
  return client;
});

const db = require('../models/db');
const logger = require('../services/logger');
const twilio = require('twilio');
const { isEnabled } = require('../config/feature-gates');
const { sendOutboundVoicemailText } = require('../services/outbound-voicemail-sms');
const { resolveOutboundCallReason } = require('../services/outbound-call-reason');
const { alertTwilioFailure } = require('../services/twilio-failure-alerts');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const voiceRouter = require('../routes/twilio-voice-webhook');

const { AMD_MACHINE_DETECTED_KEY, outboundVoicemailTextDialOptions } = voiceRouter._test;

const CALL_LOG_ID = '0b4b7e6a-1111-4222-8333-abcdefabcdef';
const CUSTOMER = '+19415550101';
const MAIN_LINE = '+19412975749';

function handlerFor(path) {
  const layer = voiceRouter.stack.find((l) => l.route && l.route.path === path);
  if (!layer) throw new Error(`no route ${path}`);
  return layer.route.stack[0].handle;
}

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = jest.fn((code) => { res.statusCode = code; return res; });
  res.type = jest.fn(() => res);
  res.send = jest.fn((body) => { res.body = body; return res; });
  res.sendStatus = jest.fn((code) => { res.statusCode = code; return res; });
  return res;
}

// call_log: update() records patches; first() answers from `rows`.
// customers: first() answers from `rows`.
let state;
function installDb(rows = {}) {
  state = { updates: [], rows };
  db.mockImplementation((table) => {
    const b = {};
    b.where = jest.fn(() => b);
    b.first = jest.fn(async () => state.rows[table]);
    b.update = jest.fn(async (patch) => { state.updates.push({ table, patch }); return 1; });
    return b;
  });
}

function metadataPatches() {
  return state.updates
    .filter((u) => u.table === 'call_log' && u.patch.metadata)
    .map((u) => JSON.parse(u.patch.metadata.bindings[0]));
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.SERVER_DOMAIN;
  isEnabled.mockImplementation(() => false);
  sendOutboundVoicemailText.mockImplementation(async () => ({ sent: true, providerMessageId: 'SM_sent', templateKey: 'outbound_voicemail_missed_you' }));
  resolveOutboundCallReason.mockImplementation(async () => ({ reason: 'generic', evidence: {} }));
  installDb();
});

describe('outboundVoicemailTextDialOptions', () => {
  test('gate off → nothing added to <Dial> or <Number>', () => {
    expect(outboundVoicemailTextDialOptions({ callLogId: CALL_LOG_ID, customerNumber: CUSTOMER, callerIdNumber: MAIN_LINE }))
      .toEqual({ dial: {}, number: {} });
  });

  test('gate on → AMD "Enable" on the number + a dial action, both carrying the call context', () => {
    isEnabled.mockImplementation((g) => g === 'outboundVoicemailSms');
    const opts = outboundVoicemailTextDialOptions({ callLogId: CALL_LOG_ID, customerNumber: CUSTOMER, callerIdNumber: MAIN_LINE });
    const qs = `callLogId=${CALL_LOG_ID}&customerNumber=%2B19415550101&callerIdNumber=%2B19412975749`;
    expect(opts.dial).toEqual({ action: `https://portal.wavespestcontrol.com/api/webhooks/twilio/outbound-dial-complete?${qs}`, method: 'POST' });
    expect(opts.number).toEqual({
      machineDetection: 'Enable',
      amdStatusCallback: `https://portal.wavespestcontrol.com/api/webhooks/twilio/outbound-amd?${qs}`,
      amdStatusCallbackMethod: 'POST',
    });
  });

  test('the literal string "undefined" is never forwarded as a callLogId', () => {
    isEnabled.mockImplementation(() => true);
    const opts = outboundVoicemailTextDialOptions({ callLogId: 'undefined', customerNumber: CUSTOMER });
    expect(opts.dial.action).not.toContain('callLogId');
    expect(opts.number.amdStatusCallback).not.toContain('callLogId');
  });
});

describe('POST /outbound-connect', () => {
  const connect = () => handlerFor('/outbound-connect');
  const req = () => ({
    query: { customerNumber: CUSTOMER, callerIdNumber: MAIN_LINE, callLogId: CALL_LOG_ID },
    body: { Digits: '1' },
  });

  test('gate off → TwiML is the pre-lane shape: no machineDetection, no action', async () => {
    const res = mockRes();
    await connect()(req(), res);
    expect(res.body).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response>'
      + `<Dial callerId="${MAIN_LINE}" record="record-from-answer-dual" recordingStatusCallback="/api/webhooks/twilio/recording-status" recordingStatusCallbackEvent="completed">`
      + `<Number>${CUSTOMER}</Number></Dial></Response>`
    );
  });

  test('gate on → <Number> carries AMD and <Dial> carries the completion action', async () => {
    isEnabled.mockImplementation(() => true);
    const res = mockRes();
    await connect()(req(), res);
    expect(res.body).toContain('machineDetection="Enable"');
    expect(res.body).toContain(`amdStatusCallback="https://portal.wavespestcontrol.com/api/webhooks/twilio/outbound-amd?callLogId=${CALL_LOG_ID}&amp;customerNumber=%2B19415550101&amp;callerIdNumber=%2B19412975749"`);
    expect(res.body).toContain(`action="https://portal.wavespestcontrol.com/api/webhooks/twilio/outbound-dial-complete?callLogId=${CALL_LOG_ID}&amp;customerNumber=%2B19415550101&amp;callerIdNumber=%2B19412975749"`);
    expect(res.body).toContain('method="POST"');
    // The existing recording contract is untouched.
    expect(res.body).toContain('record="record-from-answer-dual"');
    expect(res.body).toContain(`<Number machineDetection="Enable"`);
    expect(res.body).toContain(`>${CUSTOMER}</Number>`);
  });

  test('technician-line calls keep their existing TwiML even with the voicemail gate on', async () => {
    const request = req();
    request.query.callerIdNumber = TWILIO_NUMBERS.fieldTech[0].number;
    const dark = mockRes();
    await connect()(request, dark);
    isEnabled.mockImplementation(() => true);
    const enabled = mockRes();
    await connect()(request, enabled);
    expect(enabled.body).toBe(dark.body);
    expect(enabled.body).not.toContain('machineDetection');
    expect(enabled.body).not.toContain('outbound-dial-complete');
  });

  test('a non-1 digit still hangs up without dialing (unchanged)', async () => {
    isEnabled.mockImplementation(() => true);
    const res = mockRes();
    await connect()({ ...req(), body: { Digits: '2' } }, res);
    expect(res.body).not.toContain('<Dial');
    expect(res.body).toContain('<Hangup/>');
  });
});

describe('POST /outbound-amd', () => {
  const amd = () => handlerFor('/outbound-amd');
  const req = (answeredBy, extra = {}) => ({
    query: { callLogId: CALL_LOG_ID, customerNumber: CUSTOMER, callerIdNumber: MAIN_LINE, ...extra.query },
    body: { CallSid: 'CA_child', AnsweredBy: answeredBy, MachineDetectionDuration: '3200', ...extra.body },
  });

  test('human verdict → AMD result stamped, no send, no hangup', async () => {
    const res = mockRes();
    await amd()(req('human'), res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(metadataPatches()).toEqual([
      { amd: { answered_by: 'human', duration_ms: 3200, child_call_sid: 'CA_child', at: expect.any(String) } },
    ]);
    expect(sendOutboundVoicemailText).not.toHaveBeenCalled();
    expect(twilio.__calls).not.toHaveBeenCalled();
  });

  test('unknown verdict is treated like human', async () => {
    await amd()(req('unknown'), mockRes());
    expect(twilio.__calls).not.toHaveBeenCalled();
    expect(sendOutboundVoicemailText).not.toHaveBeenCalled();
  });

  test('machine verdict, text did NOT go (any reason) → customer leg LEFT UP, skip stamped, no detected stamp', async () => {
    sendOutboundVoicemailText.mockResolvedValueOnce({ sent: false, skipped: 'quiet_hours', reason: 'generic' });
    const res = mockRes();
    await amd()(req('machine_start'), res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(twilio.__calls).not.toHaveBeenCalled();
    const patches = metadataPatches();
    expect(patches).toHaveLength(2);
    expect(patches[1]).toEqual({ voicemail_text: { outcome: 'skipped', reason: 'quiet_hours', code: null, call_reason: 'generic' } });
    expect(patches.some((p) => p[AMD_MACHINE_DETECTED_KEY])).toBe(false);
  });

  test('a disabled template or a policy block is discovered BEFORE the hangup — the admin is never told a text went out', async () => {
    for (const outcome of [
      { sent: false, skipped: 'template_disabled', reason: 'generic' },
      { sent: false, skipped: 'policy_block', code: 'SUPPRESSED_STOP', reason: 'generic' },
      { sent: false, skipped: 'send_suppressed', code: 'gate-blocked', reason: 'generic' },
    ]) {
      jest.clearAllMocks();
      installDb({ call_log: { id: CALL_LOG_ID, customer_id: 'cust-9', to_phone: CUSTOMER } });
      sendOutboundVoicemailText.mockResolvedValueOnce(outcome);
      await amd()(req('machine_start'), mockRes());
      expect(twilio.__calls).not.toHaveBeenCalled();
      expect(metadataPatches().some((p) => p[AMD_MACHINE_DETECTED_KEY])).toBe(false);
      expect(metadataPatches()[1].voicemail_text).toMatchObject({ outcome: 'skipped', reason: outcome.skipped });
    }
  });

  test('machine verdict, text SENT → send first, then stamp detected + sent, THEN hang up the CHILD leg', async () => {
    installDb({
      call_log: { id: CALL_LOG_ID, customer_id: 'cust-9', to_phone: CUSTOMER },
      customers: { id: 'cust-9', first_name: 'Maria' },
    });
    const res = mockRes();
    await amd()(req('machine_start'), res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);

    expect(sendOutboundVoicemailText).toHaveBeenCalledWith({
      phone: CUSTOMER,
      customerId: 'cust-9',
      firstName: 'Maria',
      callLogId: CALL_LOG_ID,
      callSid: 'CA_child',
      callerId: MAIN_LINE,
      reason: 'generic',
      relatedCallId: null,
    });
    const patches = metadataPatches();
    expect(patches[1]).toEqual({
      [AMD_MACHINE_DETECTED_KEY]: expect.any(String),
      voicemail_text: { outcome: 'sent', provider_sid: 'SM_sent', reason: 'generic', template_key: 'outbound_voicemail_missed_you', evidence: {} },
    });
    // Order: send → stamp → hangup.
    const sendOrder = sendOutboundVoicemailText.mock.invocationCallOrder[0];
    const hangupOrder = twilio.__update.mock.invocationCallOrder[0];
    const stampUpdate = state.updates.find((u) => u.table === 'call_log' && u.patch.metadata && JSON.parse(u.patch.metadata.bindings[0])[AMD_MACHINE_DETECTED_KEY]);
    expect(stampUpdate).toBeTruthy();
    expect(sendOrder).toBeLessThan(hangupOrder);
    expect(twilio).toHaveBeenCalledWith(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
    expect(twilio.__calls).toHaveBeenCalledWith('CA_child');
    expect(twilio.__update).toHaveBeenCalledWith({ status: 'completed' });
  });

  test('no linked customer → texts the dialed number with no name and no customerId', async () => {
    installDb({ call_log: { id: CALL_LOG_ID, customer_id: null, to_phone: CUSTOMER } });
    await amd()(req('machine_start'), mockRes());
    expect(sendOutboundVoicemailText).toHaveBeenCalledWith(expect.objectContaining({
      phone: CUSTOMER, customerId: null, firstName: '', callLogId: CALL_LOG_ID,
    }));
  });

  test('hangup REST failure after a real send is logged; the text is already out', async () => {
    installDb({ call_log: { id: CALL_LOG_ID, customer_id: null, to_phone: CUSTOMER } });
    twilio.__update.mockRejectedValueOnce(new Error('Call is not in-progress'));
    const res = mockRes();
    await amd()(req('machine_start'), res);
    expect(sendOutboundVoicemailText).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('customer-leg hangup failed'));
    expect(res.sendStatus).toHaveBeenCalledWith(200);
  });

  test('the resolved reason and the callback\'s related call ride into the send and onto the call_log stamp', async () => {
    const row = { id: CALL_LOG_ID, customer_id: 'cust-9', source: 'admin-callback', metadata: { relatedCallId: 'in-1' }, created_at: new Date('2026-09-08T15:00:00Z') };
    installDb({ call_log: row, customers: { id: 'cust-9', first_name: 'Maria' } });
    resolveOutboundCallReason.mockResolvedValueOnce({ reason: 'returning_call', evidence: { related_call_id: 'in-1' } });
    sendOutboundVoicemailText.mockResolvedValueOnce({ sent: true, providerMessageId: 'SM_2', templateKey: 'outbound_voicemail_returning_call' });
    await amd()(req('machine_start'), mockRes());
    expect(resolveOutboundCallReason).toHaveBeenCalledWith({ call: row, phone: CUSTOMER });
    expect(sendOutboundVoicemailText).toHaveBeenCalledWith(expect.objectContaining({ reason: 'returning_call', relatedCallId: 'in-1' }));
    expect(metadataPatches()[1].voicemail_text).toEqual({ outcome: 'sent', provider_sid: 'SM_2', reason: 'returning_call', template_key: 'outbound_voicemail_returning_call', evidence: { related_call_id: 'in-1' } });
  });

  test('auto-bridge row: the text goes to the DIALED number from the query, never call_log.to_phone (the admin cell)', async () => {
    installDb({ call_log: { id: CALL_LOG_ID, customer_id: 'cust-9', source: 'lead-webhook-auto-bridge', to_phone: '+19415993489', metadata: {}, created_at: new Date() }, customers: { id: 'cust-9', first_name: 'Sam' } });
    resolveOutboundCallReason.mockResolvedValueOnce({ reason: 'quote_request', evidence: { source: 'lead-webhook-auto-bridge' } });
    await amd()(req('machine_start'), mockRes());
    const arg = sendOutboundVoicemailText.mock.calls[0][0];
    expect(arg.phone).toBe(CUSTOMER);
    expect(arg.reason).toBe('quote_request');
  });

  test('a thrown error still answers 200 so Twilio does not retry into a double text', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    const res = mockRes();
    await amd()(req('machine_start'), res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('Outbound AMD webhook error'));
  });

  test('a send error reports its code without logging or forwarding a database payload', async () => {
    const privateBody = 'Synthetic private message body';
    sendOutboundVoicemailText.mockRejectedValueOnce(Object.assign(new Error(`insert failed: ${CUSTOMER} ${privateBody}`), { code: 'XX000' }));
    const res = mockRes();
    await amd()(req('machine_start'), res);
    expect(res.sendStatus).toHaveBeenCalledWith(200);
    expect(twilio.__calls).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith('Outbound AMD webhook error: XX000');
    expect(alertTwilioFailure).toHaveBeenCalledWith(expect.objectContaining({ phase: 'outbound_amd_webhook', errorMessage: 'XX000' }));
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(CUSTOMER);
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain(privateBody);
  });
});

describe('POST /outbound-dial-complete', () => {
  const complete = () => handlerFor('/outbound-dial-complete');

  test('voicemail was detected → tells the admin, then hangs up', async () => {
    installDb({ call_log: { metadata: { [AMD_MACHINE_DETECTED_KEY]: '2026-09-08T15:00:00.000Z' } } });
    const res = mockRes();
    await complete()({ query: { callLogId: CALL_LOG_ID }, body: { DialCallStatus: 'completed' } }, res);
    expect(res.type).toHaveBeenCalledWith('text/xml');
    expect(res.body).toContain('Voicemail detected. We sent them a text instead.');
    expect(res.body).toContain('<Hangup/>');
  });

  test('metadata stored as a JSON string is folded the same way', async () => {
    installDb({ call_log: { metadata: JSON.stringify({ [AMD_MACHINE_DETECTED_KEY]: '2026-09-08T15:00:00.000Z' }) } });
    const res = mockRes();
    await complete()({ query: { callLogId: CALL_LOG_ID }, body: {} }, res);
    expect(res.body).toContain('Voicemail detected');
  });

  test('no detection → silent hangup, identical to the pre-lane action-less <Dial>', async () => {
    installDb({ call_log: { metadata: { amd: { answered_by: 'human' } } } });
    const res = mockRes();
    await complete()({ query: { callLogId: CALL_LOG_ID }, body: { DialCallStatus: 'completed' } }, res);
    expect(res.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });

  test('no callLogId → silent hangup without a DB read', async () => {
    const res = mockRes();
    await complete()({ query: {}, body: {} }, res);
    expect(db).not.toHaveBeenCalled();
    expect(res.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>');
  });

  test('a DB error still returns a hangup', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    const res = mockRes();
    await complete()({ query: { callLogId: CALL_LOG_ID }, body: {} }, res);
    expect(res.body).toContain('<Hangup/>');
  });
});
