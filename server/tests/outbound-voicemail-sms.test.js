/**
 * Outbound voicemail text-back (services/outbound-voicemail-sms.js).
 *
 * Pins the send-gate ladder in order — feature gate (fails closed), quiet
 * hours, the 24h per-phone sms_log dedupe (read failure = fail closed), the
 * template kill switch — and the sendCustomerMessage outcomes (real send /
 * suppression sentinel / policy block / provider failure), plus the AMD
 * verdict classifier the webhook keys on.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  // db.raw is BOTH the claim statement (awaited → { rows }) and an inline
  // fragment builder elsewhere; the claim is the only await in this module.
  mockDb.raw = jest.fn(async () => ({ rows: [{ id: 1 }] }));
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM_real_sid' })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (key, vars) => `Hi ${vars.first_name}, sorry we missed you${vars.callback_clause}.${vars.optout_clause}`),
}));
jest.mock('../config/twilio-numbers', () => ({
  isInternalNumber: (n) => jest.requireActual('../config/twilio-numbers').isInternalNumber(n),
  isTechLine: (n) => n === '+19415550102',
  tollFree: { number: '+18005550100' },
  findByNumber: jest.fn((n) => (n === '+19412975749' || n === '+18005550100' ? { id: 'main' } : null)),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../services/outbound-call-reason', () => ({
  REASONS: { QUOTE_REQUEST: 'quote_request', RETURNING_CALL: 'returning_call', SAW_TEXT: 'saw_text', GENERIC: 'generic' },
  visitInProgress: jest.fn(async () => false),
  nonServiceCaller: jest.fn(async () => false),
}));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const logger = require('../services/logger');
const { visitInProgress, nonServiceCaller } = require('../services/outbound-call-reason');
const {
  MESSAGE_TYPE,
  GENERIC_TEMPLATE_KEY,
  REASON_TEMPLATE_KEYS,
  CLAIM_PREFIX,
  CLAIM_WINDOW,
  GATE,
  isVoicemailAnsweredBy,
  isAdminPhone,
  precheck,
  sendOutboundVoicemailText,
  _private,
} = require('../services/outbound-voicemail-sms');

const PHONE = '+19415550101';
const MAIN_LINE = '+19412975749';
// 2026-09-08T15:00Z = 11:00 ET (EDT) — inside the 8am–8pm send window.
const IN_WINDOW = new Date('2026-09-08T15:00:00Z');
// 2026-09-09T02:00Z = 22:00 ET the prior evening — outside the window.
const OUT_OF_WINDOW = new Date('2026-09-09T02:00:00Z');

let smsLogFirst;
let claimDel;

function installDb({ priorRow = undefined, firstError = null } = {}) {
  smsLogFirst = jest.fn(async () => {
    if (firstError) throw firstError;
    return priorRow;
  });
  claimDel = jest.fn(async () => 1);
  db.mockImplementation((table) => {
    const b = {};
    b.where = jest.fn(() => b);
    if (table === 'sms_log') { b.first = smsLogFirst; return b; }
    if (table === 'sms_send_claims') { b.del = claimDel; return b; }
    throw new Error(`unexpected table ${table}`);
  });
  db.raw.mockImplementation(async () => ({ rows: [{ id: 1 }] }));
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: IN_WINDOW, doNotFake: ['nextTick', 'setImmediate'] });
  isEnabled.mockImplementation(() => true);
  visitInProgress.mockImplementation(async () => false);
  nonServiceCaller.mockImplementation(async () => false);
  installDb();
});

afterEach(() => {
  jest.useRealTimers();
});

describe('isVoicemailAnsweredBy', () => {
  test('every machine_* verdict is voicemail; human/unknown/fax/empty are not', () => {
    for (const v of ['machine_start', 'machine_end_beep', 'machine_end_silence', 'machine_end_other']) {
      expect(isVoicemailAnsweredBy(v)).toBe(true);
    }
    for (const v of ['human', 'unknown', 'fax', '', null, undefined]) {
      expect(isVoicemailAnsweredBy(v)).toBe(false);
    }
  });
});

describe('precheck — decided before the customer leg is hung up', () => {
  test('gate is the named gate and fails closed', async () => {
    expect(GATE).toBe('outboundVoicemailSms');
    isEnabled.mockImplementation(() => false);
    await expect(precheck({ phone: PHONE })).resolves.toEqual({ ok: false, skipped: 'gate_off' });
    expect(isEnabled).toHaveBeenCalledWith('outboundVoicemailSms');
    expect(smsLogFirst).not.toHaveBeenCalled();
  });

  test('missing phone skips without touching the DB', async () => {
    await expect(precheck({ phone: '' })).resolves.toEqual({ ok: false, skipped: 'missing_input' });
    expect(smsLogFirst).not.toHaveBeenCalled();
  });

  test('the admin bridge phone is never a recipient', async () => {
    const saved = process.env.ADAM_PHONE;
    process.env.ADAM_PHONE = '+19415551234';
    try {
      expect(isAdminPhone('(941) 555-1234')).toBe(true);
      expect(isAdminPhone('+19415993489')).toBe(true); // hard-coded fallback
      expect(isAdminPhone(PHONE)).toBe(false);
      await expect(precheck({ phone: '9415551234' })).resolves.toEqual({ ok: false, skipped: 'admin_phone' });
      expect(smsLogFirst).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.ADAM_PHONE; else process.env.ADAM_PHONE = saved;
    }
  });

  test('outside 8am–8pm ET skips before the dedupe probe', async () => {
    await expect(precheck({ phone: PHONE, now: OUT_OF_WINDOW })).resolves.toEqual({ ok: false, skipped: 'quiet_hours' });
    expect(smsLogFirst).not.toHaveBeenCalled();
  });

  test('configured office staff and owned lines are never recipients', async () => {
    const saved = process.env.VIRGINIA_PHONE;
    process.env.VIRGINIA_PHONE = '+19415550103';
    try {
      for (const phone of ['(941) 555-0103', MAIN_LINE]) {
        await expect(precheck({ phone })).resolves.toEqual({ ok: false, skipped: 'admin_phone' });
      }
      expect(smsLogFirst).not.toHaveBeenCalled();
    } finally {
      if (saved === undefined) delete process.env.VIRGINIA_PHONE; else process.env.VIRGINIA_PHONE = saved;
    }
  });

  test('a technician en route / on site at this customer → no text, decided before the dedupe probe', async () => {
    visitInProgress.mockResolvedValueOnce(true);
    await expect(precheck({ phone: PHONE, customerId: 'cust-1' })).resolves.toEqual({ ok: false, skipped: 'visit_in_progress' });
    expect(visitInProgress).toHaveBeenCalledWith({ customerId: 'cust-1', phone: PHONE, before: IN_WINDOW });
    expect(smsLogFirst).not.toHaveBeenCalled();
  });

  test('returning a non-service call (van complaint, solicitor, applicant, wrong number) → no text', async () => {
    nonServiceCaller.mockResolvedValueOnce(true);
    await expect(precheck({ phone: PHONE, customerId: 'cust-1', relatedCallId: 'in-7' })).resolves.toEqual({ ok: false, skipped: 'non_service_caller' });
    expect(nonServiceCaller).toHaveBeenCalledWith({ customerId: 'cust-1', phone: PHONE, relatedCallId: 'in-7', before: IN_WINDOW });
    expect(smsLogFirst).not.toHaveBeenCalled();
  });

  test('a visit-probe failure fails CLOSED', async () => {
    visitInProgress.mockRejectedValueOnce(Object.assign(new Error('down'), { code: 'ETIMEDOUT' }));
    await expect(precheck({ phone: PHONE, customerId: 'cust-1' })).resolves.toEqual({ ok: false, skipped: 'visit_probe_failed' });
  });

  test('a prior missed-you text to the same phone inside 24h skips', async () => {
    installDb({ priorRow: { id: 'sms1' } });
    await expect(precheck({ phone: '(941) 555-0101' })).resolves.toEqual({ ok: false, skipped: 'already_sent_recently' });
    // The probe is keyed on the normalized E.164 phone + this lane's message_type.
    const builder = db.mock.results[0].value;
    expect(builder.where).toHaveBeenCalledWith({ to_phone: PHONE, message_type: MESSAGE_TYPE });
    expect(builder.where).toHaveBeenCalledWith('created_at', '>=', expect.any(Date));
    const since = builder.where.mock.calls.find((c) => c[0] === 'created_at')[2];
    expect(IN_WINDOW.getTime() - since.getTime()).toBe(24 * 60 * 60 * 1000);
  });

  test('a dedupe read failure fails CLOSED', async () => {
    installDb({ firstError: Object.assign(new Error('boom'), { code: 'ECONN' }) });
    await expect(precheck({ phone: PHONE })).resolves.toEqual({ ok: false, skipped: 'dedupe_read_failed' });
  });

  test('clean path returns ok with the normalized phone', async () => {
    await expect(precheck({ phone: '9415550101' })).resolves.toEqual({ ok: true, phone: PHONE });
  });
});

describe('sendOutboundVoicemailText', () => {
  test('calls from a technician line never auto-text, including an already-issued AMD callback', async () => {
    await expect(sendOutboundVoicemailText({ phone: PHONE, callerId: '(941) 555-0102' }))
      .resolves.toEqual({ sent: false, skipped: 'tech_line', reason: 'generic' });
    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled();
  });

  test('gate off → no template render, no send', async () => {
    isEnabled.mockImplementation(() => false);
    await expect(sendOutboundVoicemailText({ phone: PHONE })).resolves.toEqual({ sent: false, skipped: 'gate_off', reason: 'generic' });
    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('template missing/disabled is the kill switch — nothing sends', async () => {
    renderSmsTemplate.mockResolvedValueOnce(null);
    await expect(sendOutboundVoicemailText({ phone: PHONE, customerId: 'c1' })).resolves.toEqual({ sent: false, skipped: 'template_disabled', reason: 'generic' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(claimDel).toHaveBeenCalledTimes(1); // nothing left → claim released
  });

  test('linked customer: customer audience, phone_matches_customer trust, no STOP footer, callback clause from the caller ID, reply from the main line', async () => {
    const result = await sendOutboundVoicemailText({
      phone: PHONE,
      customerId: 'cust-1',
      firstName: 'maria',
      callLogId: 'cl-1',
      callSid: 'CA_child',
      callerId: MAIN_LINE,
    });
    expect(result).toEqual({ sent: true, providerMessageId: 'SM_real_sid', reason: 'generic', templateKey: GENERIC_TEMPLATE_KEY });

    expect(renderSmsTemplate).toHaveBeenCalledWith(GENERIC_TEMPLATE_KEY, {
      first_name: 'Maria',
      callback_clause: ' at (941) 297-5749',
      optout_clause: '',
    }, { workflow: MESSAGE_TYPE, entity_type: 'customer', entity_id: 'cust-1' }, { requiredVars: ['first_name', 'callback_clause', 'optout_clause'] });

    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input).toMatchObject({
      to: PHONE,
      channel: 'sms',
      audience: 'customer',
      purpose: 'missed_call_followup',
      customerId: 'cust-1',
      identityTrustLevel: 'phone_matches_customer',
      consentBasis: { status: 'transactional_allowed', source: 'outbound_voicemail_text_back' },
      entryPoint: 'outbound_voicemail_sms',
      metadata: {
        original_message_type: MESSAGE_TYPE,
        call_sid: 'CA_child',
        call_log_id: 'cl-1',
        call_reason: 'generic',
        template_key: GENERIC_TEMPLATE_KEY,
        fromNumber: MAIN_LINE,
      },
    });
    expect(input.body).toBe('Hi Maria, sorry we missed you at (941) 297-5749.');
  });

  test('a known reason renders its own template and stamps it on the send metadata', async () => {
    const result = await sendOutboundVoicemailText({ phone: PHONE, customerId: 'cust-1', reason: 'returning_call' });
    expect(result).toEqual({ sent: true, providerMessageId: 'SM_real_sid', reason: 'returning_call', templateKey: 'outbound_voicemail_returning_call' });
    expect(renderSmsTemplate).toHaveBeenCalledTimes(1);
    expect(renderSmsTemplate.mock.calls[0][0]).toBe('outbound_voicemail_returning_call');
    expect(sendCustomerMessage.mock.calls[0][0].metadata).toMatchObject({ call_reason: 'returning_call', template_key: 'outbound_voicemail_returning_call' });
    // The dedupe key stays the lane-wide message_type regardless of reason.
    expect(sendCustomerMessage.mock.calls[0][0].metadata.original_message_type).toBe(MESSAGE_TYPE);
  });

  test('a provider-accepted text still succeeds when the final audit write throws, without leaking the audit payload', async () => {
    const privateBody = 'Synthetic customer message for audit failure';
    sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error(`insert failed: ${PHONE} ${privateBody}`), {
      code: 'XX000',
      providerOutcome: { sent: true, providerMessageId: 'SM_accepted_before_audit' },
    }));
    await expect(sendOutboundVoicemailText({ phone: PHONE, reason: 'returning_call', callLogId: 'cl-1' })).resolves.toEqual({
      sent: true, providerMessageId: 'SM_accepted_before_audit', reason: 'returning_call', templateKey: 'outbound_voicemail_returning_call',
    });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(claimDel).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('XX000'));
    const logs = JSON.stringify([logger.info.mock.calls, logger.warn.mock.calls, logger.error.mock.calls]);
    expect(logs).not.toContain(PHONE);
    expect(logs).not.toContain(privateBody);
  });

  test.each([
    undefined,
    { sent: true, providerMessageId: 'template-disabled' },
    { sent: true, providerMessageId: null },
  ])('an audit error without a real accepted provider send is not converted into success (%j)', async (providerOutcome) => {
    const err = Object.assign(new Error('Synthetic audit failure'), { code: 'XX000', providerOutcome });
    sendCustomerMessage.mockRejectedValueOnce(err);
    await expect(sendOutboundVoicemailText({ phone: PHONE })).rejects.toBe(err);
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
  });

  test('an audit throw with a legacy ambiguous outcome keeps the claim', async () => {
    const providerOutcome = { sent: false, retryable: true, code: 'TWILIO_TIMEOUT' };
    sendCustomerMessage.mockRejectedValueOnce(Object.assign(new Error('Synthetic audit failure'), { providerOutcome }));
    await expect(sendOutboundVoicemailText({ phone: PHONE })).resolves.toMatchObject({
      sent: false, skipped: 'provider_failed', ambiguous: true,
    });
    expect(claimDel).not.toHaveBeenCalled();
  });

  test('every reason maps to a template key; unknown reasons render the generic one', async () => {
    expect(REASON_TEMPLATE_KEYS).toEqual({
      quote_request: 'outbound_voicemail_quote_request',
      returning_call: 'outbound_voicemail_returning_call',
      saw_text: 'outbound_voicemail_saw_text',
      generic: GENERIC_TEMPLATE_KEY,
    });
    await sendOutboundVoicemailText({ phone: PHONE, reason: 'not_a_reason' });
    expect(renderSmsTemplate.mock.calls[0][0]).toBe(GENERIC_TEMPLATE_KEY);
  });

  test('a disabled reason template falls back to the generic template', async () => {
    renderSmsTemplate.mockResolvedValueOnce(null); // reason template off
    const result = await sendOutboundVoicemailText({ phone: PHONE, reason: 'saw_text' });
    expect(renderSmsTemplate.mock.calls.map((c) => c[0])).toEqual(['outbound_voicemail_saw_text', GENERIC_TEMPLATE_KEY]);
    expect(result).toMatchObject({ sent: true, reason: 'saw_text', templateKey: GENERIC_TEMPLATE_KEY });
  });

  test('a disabled generic template is the kill switch even for a known reason', async () => {
    renderSmsTemplate.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    await expect(sendOutboundVoicemailText({ phone: PHONE, reason: 'quote_request' })).resolves.toEqual({ sent: false, skipped: 'template_disabled', reason: 'quote_request' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('no customer record: lead audience, unverified trust, STOP footer, no customerId', async () => {
    await sendOutboundVoicemailText({ phone: PHONE, callerId: '+15551234567' });
    expect(renderSmsTemplate.mock.calls[0][1]).toEqual({
      first_name: 'there',
      callback_clause: ' at (555) 123-4567',
      optout_clause: ' Reply STOP to opt out.',
    });
    const input = sendCustomerMessage.mock.calls[0][0];
    expect(input.audience).toBe('lead');
    expect(input.identityTrustLevel).toBe('phone_provided_unverified');
    expect(input).not.toHaveProperty('customerId');
    // An unmanaged caller ID never becomes the reply-from number.
    expect(input.metadata).not.toHaveProperty('fromNumber');
  });

  test('the AI toll-free line is never the reply-from number', async () => {
    await sendOutboundVoicemailText({ phone: PHONE, callerId: '+18005550100' });
    expect(sendCustomerMessage.mock.calls[0][0].metadata).not.toHaveProperty('fromNumber');
  });

  test.each(['gate-blocked', 'template-disabled'])('a %s sentinel from the pipeline is reported as not sent', async (code) => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: code });
    await expect(sendOutboundVoicemailText({ phone: PHONE })).resolves.toEqual({
      sent: false, skipped: 'send_suppressed', code, reason: 'generic',
    });
    expect(claimDel).toHaveBeenCalledTimes(1); // nothing left → claim released
  });

  test('a policy block (STOP list) is reported with its code', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'SUPPRESSED_STOP' });
    await expect(sendOutboundVoicemailText({ phone: PHONE })).resolves.toEqual({
      sent: false, skipped: 'policy_block', code: 'SUPPRESSED_STOP', reason: 'generic',
    });
    expect(claimDel).toHaveBeenCalledTimes(1);
  });

  test('a provider failure is reported as provider_failed', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: false, code: '30006', reason: 'landline' });
    await expect(sendOutboundVoicemailText({ phone: PHONE })).resolves.toEqual({
      sent: false, skipped: 'provider_failed', code: '30006', reason: 'generic', ambiguous: false,
    });
    expect(claimDel).toHaveBeenCalledTimes(1);
  });

  test('an AMBIGUOUS provider outcome (retryable / deferred) keeps the claim — the provider may still hold the text', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: false, retryable: true, code: 'TWILIO_TIMEOUT' });
    await expect(sendOutboundVoicemailText({ phone: PHONE })).resolves.toMatchObject({ sent: false, skipped: 'provider_failed', ambiguous: true });
    expect(claimDel).not.toHaveBeenCalled();
  });

  test('canonical uncertainty keeps the claim without retry flags; proven retryable non-delivery releases it', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: false, deliveryOutcome: 'uncertain', code: 'PROVIDER_UNKNOWN' });
    await expect(sendOutboundVoicemailText({ phone: PHONE })).resolves.toMatchObject({ ambiguous: true });
    expect(claimDel).not.toHaveBeenCalled();

    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: false, deliveryOutcome: 'not_sent', retryable: true, code: '20429' });
    await expect(sendOutboundVoicemailText({ phone: PHONE })).resolves.toMatchObject({ ambiguous: false });
    expect(claimDel).toHaveBeenCalledTimes(1);
  });

  test('the atomic per-phone claim is taken right before the send and lost claims skip (concurrent callbacks → one text)', async () => {
    await sendOutboundVoicemailText({ phone: '(941) 555-0101' });
    expect(db.raw).toHaveBeenCalledTimes(1);
    const [sql, bindings] = db.raw.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO sms_send_claims/);
    expect(sql).toMatch(/ON CONFLICT \(claim_key\) DO UPDATE/);
    expect(sql).toContain(`interval '${CLAIM_WINDOW}'`);
    expect(bindings).toEqual([`${CLAIM_PREFIX}${PHONE}`]);
    expect(CLAIM_WINDOW).toBe('24 hours');
    // Claim held by a concurrent execution → no render, no send, no release.
    jest.clearAllMocks();
    installDb();
    db.raw.mockImplementation(async () => ({ rows: [] }));
    await expect(sendOutboundVoicemailText({ phone: PHONE, reason: 'saw_text' })).resolves.toEqual({ sent: false, skipped: 'already_sent_recently', reason: 'saw_text' });
    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(claimDel).not.toHaveBeenCalled();
  });

  test('a claim statement failure fails CLOSED', async () => {
    db.raw.mockImplementation(async () => { throw Object.assign(new Error('down'), { code: 'ECONN' }); });
    await expect(sendOutboundVoicemailText({ phone: PHONE })).resolves.toEqual({ sent: false, skipped: 'claim_failed', reason: 'generic' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('re-runs the precheck itself so a direct call is still safe', async () => {
    installDb({ priorRow: { id: 'sms1' } });
    await expect(sendOutboundVoicemailText({ phone: PHONE })).resolves.toEqual({ sent: false, skipped: 'already_sent_recently', reason: 'generic' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(db.raw).not.toHaveBeenCalled(); // the sms_log probe exits before the claim
  });
});

describe('_private helpers', () => {
  test('callbackClause formats a 10/11-digit US number and is empty otherwise', () => {
    expect(_private.callbackClause('+19412975749')).toBe(' at (941) 297-5749');
    expect(_private.callbackClause('9412975749')).toBe(' at (941) 297-5749');
    expect(_private.callbackClause('+441234567890')).toBe('');
    expect(_private.callbackClause('')).toBe('');
    expect(_private.callbackClause(null)).toBe('');
  });

  test('placeholder first names greet as "there"', () => {
    for (const n of ['Unknown', 'unknown', 'UNKNOWN CALLER', 'N/A', 'Customer', '-', '???', '12345', '']) {
      expect(_private.capitalizeName(n)).toBe('');
    }
    expect(_private.capitalizeName('maria')).toBe('Maria');
    expect(_private.capitalizeName("O'Brien")).toBe("O'Brien");
  });

  test('normalizePhoneE164 matches the pipeline shape', () => {
    expect(_private.normalizePhoneE164('941-555-0101')).toBe(PHONE);
    expect(_private.normalizePhoneE164('19415550101')).toBe(PHONE);
    expect(_private.normalizePhoneE164(PHONE)).toBe(PHONE);
    expect(_private.normalizePhoneE164('')).toBeNull();
  });
});
