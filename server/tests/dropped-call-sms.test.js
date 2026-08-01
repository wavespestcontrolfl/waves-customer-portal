/**
 * Dropped-call address-request text (services/dropped-call-sms.js).
 *
 * Pins the detector heuristic (endedAbruptly over the transcript tail) and
 * the send-gate ladder in order: feature gate (fails closed), quiet hours
 * (skip BEFORE any claim — one-shot not consumed), one-text-per-phone-ever
 * sms_log dedupe (read failure = fail closed), the atomic per-phone +
 * per-lead claims, the landline pre-check (claim kept — a landline stays a
 * landline), the template kill switch (claims released), and the three
 * sendCustomerMessage outcomes (sent / policy block keeps the claim /
 * provider failure releases it). Mirrors the voicemail-lead-sms harness.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => true) }));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (key, vars) => `Hello ${vars.first_name} — reply with your address${vars.callback_clause}.`),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'miss' })),
  cacheLineType: jest.fn(async () => {}),
  lookupLineType: jest.fn(async () => 'mobile'),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const db = require('../models/db');
const { isEnabled } = require('../config/feature-gates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const lineType = require('../services/messaging/validators/line-type');
const {
  sendDroppedCallAddressRequest,
  endedAbruptly,
  MIN_CALL_SECONDS,
  _private,
} = require('../services/dropped-call-sms');

const LEAD_ID = '3f2f7b9c-4444-4222-8333-abcdefabcdef';
const PHONE = '+19415550101';
// 2026-08-01T15:00Z = 11:00 ET (EDT) — inside the 8am–8pm send window.
const IN_WINDOW = new Date('2026-08-01T15:00:00Z');
// 2026-08-02T02:00Z = 22:00 ET the prior evening — outside the window.
const OUT_OF_WINDOW = new Date('2026-08-02T02:00:00Z');

let state;

function makeBuilder(table) {
  const b = {};
  for (const m of ['where', 'whereRaw', 'whereNotIn', 'whereNull', 'select', 'onConflict', 'ignore', 'returning']) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(() => {
    const q = state.firstResults[table] || [];
    const entry = q.length ? q.shift() : null;
    if (entry instanceof Error) return Promise.reject(entry);
    return Promise.resolve(entry);
  });
  b.update = jest.fn((payload) => {
    state.updates.push({ table, payload });
    const q = state.updateResults[table] || [];
    return Promise.resolve(q.length ? q.shift() : 1);
  });
  b.del = jest.fn(() => {
    state.deletes.push({ table });
    return Promise.resolve(1);
  });
  b.insert = jest.fn((payload) => {
    state.inserts.push({ table, payload });
    return b;
  });
  b.then = (resolve, reject) => {
    if (state.insertError[table]) return Promise.reject(state.insertError[table]).then(resolve, reject);
    const q = state.insertResults[table] || [];
    const val = q.length ? q.shift() : [{ id: 'row-1', phone: PHONE }];
    return Promise.resolve(val).then(resolve, reject);
  };
  return b;
}

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(IN_WINDOW);
  state = { firstResults: {}, updateResults: {}, insertResults: {}, insertError: {}, inserts: [], updates: [], deletes: [] };
  db.mockImplementation((table) => makeBuilder(table));
});

afterEach(() => {
  jest.useRealTimers();
});

const CALL = { to_phone: '+19412166229', twilio_call_sid: 'CAtest', duration_seconds: 300 };
const EXTRACTED = { first_name: 'juan' };

function sendArgs() {
  return { leadId: LEAD_ID, extracted: EXTRACTED, call: CALL, phone: PHONE };
}

describe('endedAbruptly', () => {
  const mk = (lines) => lines.join('\n');

  it('true for a Juan-style mid-sentence cutoff', () => {
    expect(endedAbruptly(mk([
      'Agent: When are you available to be on site?',
      'Caller: Tomorrow works.',
      'Agent: And what is your best email address and then your service address?',
      'Caller: Um, oh, you said — I do have one,',
    ]))).toBe(true);
  });

  it('false when the tail carries a farewell', () => {
    expect(endedAbruptly(mk([
      'Caller: That all sounds right.',
      'Agent: Great, see you Tuesday.',
      'Caller: Thank you.',
      'Agent: Bye-bye.',
    ]))).toBe(false);
  });

  it('false when the tail thanks without a literal bye', () => {
    expect(endedAbruptly(mk([
      'Agent: We will get that quote over today.',
      'Caller: Perfect.',
      'Caller: Appreciate it.',
      'Agent: Talk soon.',
    ]))).toBe(false);
  });

  it('false for transcripts too short to judge', () => {
    expect(endedAbruptly(mk(['Agent: Hello?', 'Caller: Hi —']))).toBe(false);
    expect(endedAbruptly('')).toBe(false);
  });
});

describe('callbackClause / window helpers', () => {
  it('formats the dialed 10/11-digit line and rejects garbage', () => {
    expect(_private.callbackClause('+19412166229')).toBe(' at (941) 216-6229');
    expect(_private.callbackClause('9412166229')).toBe(' at (941) 216-6229');
    expect(_private.callbackClause('anonymous')).toBe('');
    expect(_private.callbackClause(null)).toBe('');
  });

  it('window check follows ET hours', () => {
    expect(_private.withinSendWindowET(IN_WINDOW)).toBe(true);
    expect(_private.withinSendWindowET(OUT_OF_WINDOW)).toBe(false);
  });
});

describe('sendDroppedCallAddressRequest gate ladder', () => {
  it('feature gate off — fails closed before any DB touch', async () => {
    isEnabled.mockReturnValueOnce(false);
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  it('quiet hours — skips BEFORE any claim, one-shot not consumed', async () => {
    jest.setSystemTime(OUT_OF_WINDOW);
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'quiet_hours' });
    expect(state.inserts).toHaveLength(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  it('sms_log dedupe read failure — fails closed', async () => {
    state.firstResults.sms_log = [new Error('db down')];
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'dedupe_read_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  it('prior text to the phone — skips', async () => {
    state.firstResults.sms_log = [{ id: 'prior' }];
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'already_sent_to_phone' });
  });

  it('phone claim conflict (concurrent winner) — skips', async () => {
    state.insertResults.dropped_call_sms_claims = [[]];
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'already_sent_to_phone' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  it('landline — claim kept and stamped, no send', async () => {
    lineType.lookupLineType.mockResolvedValueOnce('landline');
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'landline' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(state.deletes).toHaveLength(0); // claim NOT released
    const claimStamp = state.updates.find((u) => u.table === 'dropped_call_sms_claims');
    expect(claimStamp.payload.outcome).toBe('landline');
  });

  it('template disabled — releases BOTH claims', async () => {
    renderSmsTemplate.mockResolvedValueOnce(null);
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'template_disabled' });
    expect(state.deletes.some((d) => d.table === 'dropped_call_sms_claims')).toBe(true);
  });

  it('happy path — sends via the policy pipeline with lead-transactional shape', async () => {
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: true });
    expect(renderSmsTemplate).toHaveBeenCalledWith('dropped_call_address_request', expect.objectContaining({
      first_name: 'Juan',
      callback_clause: ' at (941) 216-6229',
    }), expect.any(Object));
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: PHONE,
      channel: 'sms',
      audience: 'lead',
      purpose: 'missed_call_followup',
      leadId: LEAD_ID,
      identityTrustLevel: 'phone_provided_unverified',
      consentBasis: { status: 'transactional_allowed', source: 'dropped_call_text_back' },
      entryPoint: 'dropped_call_sms',
    }));
    const claimStamp = state.updates.filter((u) => u.table === 'dropped_call_sms_claims').pop();
    expect(claimStamp.payload.outcome).toBe('sent');
  });

  it('policy block — claim kept (never retry a suppressed number)', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'suppressed' });
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'policy_block' });
    expect(state.deletes).toHaveLength(0);
    const claimStamp = state.updates.filter((u) => u.table === 'dropped_call_sms_claims').pop();
    expect(claimStamp.payload.outcome).toBe('policy_block');
  });

  it('transient provider failure — releases BOTH claims for a later drop', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, retryable: true, code: 'provider_5xx' });
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'provider_failed' });
    expect(state.deletes.some((d) => d.table === 'dropped_call_sms_claims')).toBe(true);
  });

  it('MIN_CALL_SECONDS is exported for the processor eligibility check', () => {
    expect(MIN_CALL_SECONDS).toBe(120);
  });
});
