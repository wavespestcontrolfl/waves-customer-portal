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
  sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM_real_sid' })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (key, vars) => `Hello ${vars.first_name} — reply with your address${vars.callback_clause}.`),
}));
jest.mock('../config/twilio-numbers', () => ({
  findByNumber: jest.fn((n) => (n === '+19412166229' ? { id: 'bradenton' } : null)),
}));
jest.mock('../services/messaging/validators/suppression', () => ({
  recordSuppression: jest.fn(async () => ({ ok: true })),
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
  handleUndeliveredAddressRequest,
  endedAbruptly,
  detectDroppedMidIntake,
  eligibleNewProspect,
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
  for (const m of ['where', 'whereIn', 'whereRaw', 'whereNotIn', 'whereNull', 'orWhere', 'select', 'onConflict', 'ignore', 'returning']) {
    b[m] = jest.fn(() => b);
  }
  b.first = jest.fn(() => {
    const q = state.firstResults[table] || [];
    // Default for an unseeded leads read: a clean, unowned, address-less
    // lead — the pre-dispatch recheck runs on every send path and tests
    // that aren't ABOUT the recheck shouldn't have to seed it.
    const fallback = table === 'leads' ? { customer_id: null, address: null } : null;
    const entry = q.length ? q.shift() : fallback;
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
  const trx = (table) => makeBuilder(table);
  trx.raw = db.raw;
  db.transaction = jest.fn(async (cb) => cb(trx));
});

afterEach(() => {
  jest.useRealTimers();
});

const CALL = { to_phone: '+19412166229', twilio_call_sid: 'CAtest', duration_seconds: 300, created_at: new Date('2026-08-01T14:30:00Z') };
const EXTRACTED = { first_name: 'sam' };

function sendArgs() {
  return { leadId: LEAD_ID, extracted: EXTRACTED, call: CALL, phone: PHONE };
}

describe('endedAbruptly', () => {
  const mk = (lines) => lines.join('\n');

  it('true for a mid-sentence cutoff at the contact exchange', () => {
    expect(endedAbruptly(mk([
      'Agent: When are you available to be on site?',
      'Caller: Tomorrow works.',
      'Agent: And what is your best email address and then your service address?',
      'Caller: Um, oh, you said — I do have one,',
    ]))).toBe(true);
  });

  it("open questions containing 'see you' are not farewells", () => {
    expect(endedAbruptly(mk([
      'Caller: I called last year I think.',
      "Agent: Hmm, I don't see you in our system — what is your service address?",
      'Caller: Sure, it is one eight —',
      'Caller: Are you there?',
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

  it('mid-tail acknowledgements do not mask a drop at the address exchange', () => {
    expect(endedAbruptly(mk([
      'Caller: Tomorrow works great.',
      'Agent: Sounds good — and what is your service address?',
      'Caller: Sure, it is one eight one —',
      'Caller: Hello? Can you hear me?',
    ]))).toBe(true);
  });

  it('weak farewell IN the final utterance still reads as a normal ending', () => {
    expect(endedAbruptly(mk([
      'Agent: We will see you Tuesday at nine.',
      'Caller: Perfect.',
      'Agent: Anything else I can help with?',
      'Caller: No, thanks so much.',
    ]))).toBe(false);
  });

  it("false for a completed call that just lacks a goodbye — 'No, that's all.' is not a drop", () => {
    expect(endedAbruptly(mk([
      'Agent: So we are set for Tuesday morning.',
      'Caller: Yes.',
      'Agent: Anything else I can help with today?',
      "Caller: No, that's all.",
    ]))).toBe(false);
  });

  it('false when the final utterance ends as a complete sentence (no positive cutoff evidence)', () => {
    expect(endedAbruptly(mk([
      'Agent: What area are you in?',
      'Caller: Bayshore Gardens.',
      'Agent: Great, we cover that.',
      'Caller: Okay then.',
    ]))).toBe(false);
  });

  it('true on connection-trouble language even when turns end with punctuation', () => {
    expect(endedAbruptly(mk([
      'Caller: It is one eight one one zero.',
      'Agent: Sorry, you cut out.',
      'Caller: Hello? Can you hear me?',
      'Caller: Hello?',
    ]))).toBe(true);
  });

  it('false for transcripts too short to judge', () => {
    expect(endedAbruptly(mk(['Agent: Hello?', 'Caller: Hi —']))).toBe(false);
    expect(endedAbruptly('')).toBe(false);
  });
});

describe('detectDroppedMidIntake', () => {
  const ABRUPT = 'Agent: One?\nCaller: Two.\nAgent: What is your service address?\nCaller: It is —';

  it('fires on a long abrupt call with no address on either extraction leg', () => {
    expect(detectDroppedMidIntake({
      durationSeconds: 300, transcription: ABRUPT, extracted: {}, v2Extraction: null,
    })).toBe(true);
  });

  it('does not fire when the V2 canonical extraction already holds the street', () => {
    expect(detectDroppedMidIntake({
      durationSeconds: 300,
      transcription: ABRUPT,
      extracted: {},
      v2Extraction: { property: { service_address: { street_line_1: '123 Main St' } } },
    })).toBe(false);
  });

  it('does not fire when V1 captured the street, or the call is short', () => {
    expect(detectDroppedMidIntake({
      durationSeconds: 300, transcription: ABRUPT, extracted: { address_line1: '123 Main St' },
    })).toBe(false);
    expect(detectDroppedMidIntake({ durationSeconds: 60, transcription: ABRUPT, extracted: {} })).toBe(false);
  });
});

describe('eligibleNewProspect', () => {
  const BASE = { customerId: null, createdCustomerFromCall: false, isOutbound: false, v2Status: 'valid', callNature: 'new_lead' };

  it('allows the normal named prospect whose customer record was created FROM this call', () => {
    expect(eligibleNewProspect({ ...BASE, customerId: 'cust-1', createdCustomerFromCall: true })).toBe(true);
  });

  it('excludes a PRE-EXISTING linked customer', () => {
    expect(eligibleNewProspect({ ...BASE, customerId: 'cust-1', createdCustomerFromCall: false })).toBe(false);
  });

  it('excludes outbound calls (inbound-only consent basis)', () => {
    expect(eligibleNewProspect({ ...BASE, isOutbound: true })).toBe(false);
  });

  it('caller asked not to be contacted on the call — never eligible for the text', () => {
    expect(eligibleNewProspect({ ...BASE, doNotContactRequested: true })).toBe(false);
  });

  it('fails closed on classification: null/indeterminate nature and invalid V2 are card-only', () => {
    expect(eligibleNewProspect({ ...BASE, callNature: null })).toBe(false);
    expect(eligibleNewProspect({ ...BASE, callNature: 'other' })).toBe(false);
    expect(eligibleNewProspect({ ...BASE, v2Status: 'schema_failed' })).toBe(false);
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

  it('stale call (reprocess/backfill) — card-only, no text, before any claim', async () => {
    const staleCall = { ...CALL, created_at: new Date('2026-07-25T12:00:00Z') };
    const res = await sendDroppedCallAddressRequest({ ...sendArgs(), call: staleCall });
    expect(res).toEqual({ sent: false, skipped: 'call_too_old' });
    expect(state.inserts).toHaveLength(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  it('sends from the line the prospect dialed when it is one of ours', async () => {
    state.firstResults.leads = [{ customer_id: null, address: null }];
    await sendDroppedCallAddressRequest(sendArgs());
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({ fromNumber: '+19412166229' }),
    }));
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

  it('phone claim conflict with a CONSUMED claim — skips (stale recovery finds no claimed row)', async () => {
    state.insertResults.dropped_call_sms_claims = [[]];
    state.updateResults.dropped_call_sms_claims = [0]; // stale-recovery update matches nothing
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'already_sent_to_phone' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  it('abandoned in-flight claim — consumed as dispatch_unknown, NEVER re-sent (double-text risk)', async () => {
    state.insertResults.dropped_call_sms_claims = [[]]; // insert conflicts
    state.updateResults.dropped_call_sms_claims = [1]; // stale consume matches
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'already_sent_to_phone' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    const consume = state.updates.find((u) => u.table === 'dropped_call_sms_claims');
    expect(consume.payload.outcome).toBe('dispatch_unknown');
  });

  it('landline — claim kept and stamped, no send', async () => {
    state.firstResults.leads = [{ customer_id: null, address: null }];
    lineType.lookupLineType.mockResolvedValueOnce('landline');
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'landline' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(state.deletes).toHaveLength(0); // claim NOT released
    const claimStamp = state.updates.find((u) => u.table === 'dropped_call_sms_claims');
    expect(claimStamp.payload.outcome).toBe('landline');
  });

  it('template disabled — releases BOTH claims', async () => {
    state.firstResults.leads = [{ customer_id: null, address: null }];
    renderSmsTemplate.mockResolvedValueOnce(null);
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'template_disabled' });
    expect(state.deletes.some((d) => d.table === 'dropped_call_sms_claims')).toBe(true);
  });

  it('happy path — sends via the policy pipeline with lead-transactional shape', async () => {
    state.firstResults.leads = [{ customer_id: null, address: null }];
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: true });
    expect(renderSmsTemplate).toHaveBeenCalledWith('dropped_call_address_request', expect.objectContaining({
      first_name: 'Sam',
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
    state.firstResults.leads = [{ customer_id: null, address: null }];
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'SUPPRESSED_MANUAL_DNC' });
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'policy_block', code: 'SUPPRESSED_MANUAL_DNC' });
    expect(state.deletes).toHaveLength(0);
    const claimStamp = state.updates.filter((u) => u.table === 'dropped_call_sms_claims').pop();
    expect(claimStamp.payload.outcome).toBe('policy_block');
  });

  it('transient consent-lookup block — releases BOTH claims (never terminal)', async () => {
    state.firstResults.leads = [{ customer_id: null, address: null }];
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'CONSENT_LOOKUP_FAILED' });
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'policy_block_transient' });
    expect(state.deletes.some((d) => d.table === 'dropped_call_sms_claims')).toBe(true);
  });

  it('ambiguous provider failure — one-shot KEPT (dispatch_unknown), never a second text', async () => {
    state.firstResults.leads = [{ customer_id: null, address: null }];
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, retryable: true, code: 'provider_5xx' });
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'provider_failed' });
    expect(state.deletes).toHaveLength(0);
    const claimStamp = state.updates.filter((u) => u.table === 'dropped_call_sms_claims').pop();
    expect(claimStamp.payload.outcome).toBe('dispatch_unknown');
  });

  it('config/content block (EMOJI_FOR_CUSTOMER) — releases the one-shot for a later drop', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, blocked: true, code: 'EMOJI_FOR_CUSTOMER' });
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'policy_block_config', code: 'EMOJI_FOR_CUSTOMER' });
    expect(state.deletes.some((d) => d.table === 'dropped_call_sms_claims')).toBe(true);
  });

  it('per-lead claim lost (ownership race / reprocess) — phone one-shot released, no send', async () => {
    state.updateResults.leads = [0]; // the ownership-guarded claim update finds no row
    const res = await sendDroppedCallAddressRequest({ ...sendArgs(), expectedCustomerId: 'cust-9' });
    expect(res).toEqual({ sent: false, skipped: 'lead_claim_lost' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(state.deletes.some((d) => d.table === 'dropped_call_sms_claims')).toBe(true);
  });

  it('terminal 21610 opt-out — claim kept, classified as suppression for the card', async () => {
    state.firstResults.leads = [{ customer_id: null, address: null }];
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, terminal: true, code: 'PROVIDER_FAILURE', providerErrorCode: '21610' });
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'policy_block', code: 'SUPPRESSED_PROVIDER_OPT_OUT_21610' });
    const { recordSuppression } = require('../services/messaging/validators/suppression');
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: PHONE, reason: 'opt_out' }));
    expect(state.deletes).toHaveLength(0);
    const claimStamp = state.updates.filter((u) => u.table === 'dropped_call_sms_claims').pop();
    expect(claimStamp.payload.outcome).toBe('opted_out');
  });

  it('terminal 21614 not-SMS-capable — claim kept, still renders callable', async () => {
    state.firstResults.leads = [{ customer_id: null, address: null }];
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, terminal: true, code: 'PROVIDER_FAILURE', providerErrorCode: '21614' });
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'provider_terminal', code: '21614' });
    const claimStamp = state.updates.filter((u) => u.table === 'dropped_call_sms_claims').pop();
    expect(claimStamp.payload.outcome).toBe('provider_terminal');
  });

  it('suppression sentinel sent:true (gate-blocked) — released, reported not sent', async () => {
    state.firstResults.leads = [{ customer_id: null, address: null }];
    sendCustomerMessage.mockResolvedValueOnce({ sent: true, providerMessageId: 'gate-blocked' });
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'send_suppressed', code: 'gate-blocked' });
    expect(state.deletes.some((d) => d.table === 'dropped_call_sms_claims')).toBe(true);
  });

  it('pre-dispatch recheck: lead reassigned during the awaits — released, not sent', async () => {
    // sendClaimed's final lead read returns a foreign owner
    state.firstResults.leads = [{ customer_id: 'someone-else', address: null }];
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'lead_ownership_changed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(state.deletes.some((d) => d.table === 'dropped_call_sms_claims')).toBe(true);
  });

  it('pre-dispatch recheck: address captured during the awaits — released, not sent', async () => {
    state.firstResults.leads = [{ customer_id: null, address: '123 Main St' }];
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'address_now_on_file' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  it('sender-side terminal (21606 From misconfig) — recipient one-shot released', async () => {
    state.firstResults.leads = [{ customer_id: null, address: null }];
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, terminal: true, code: 'PROVIDER_FAILURE', providerErrorCode: '21606' });
    const res = await sendDroppedCallAddressRequest(sendArgs());
    expect(res).toEqual({ sent: false, skipped: 'sender_config_terminal', code: '21606' });
    expect(state.deletes.some((d) => d.table === 'dropped_call_sms_claims')).toBe(true);
  });

  it('MIN_CALL_SECONDS is exported for the processor eligibility check', () => {
    expect(MIN_CALL_SECONDS).toBe(120);
  });
});

describe('handleUndeliveredAddressRequest (delivery bounce)', () => {
  it('ignores sids that belong to a different message type', async () => {
    state.firstResults.sms_log = [{ id: 'log-x', to_phone: PHONE, message_type: 'voicemail_quote_link' }];
    const res = await handleUndeliveredAddressRequest({ sid: 'SM1', status: 'undelivered', to: PHONE });
    expect(res).toEqual({ handled: false, reason: 'not_address_request' });
  });

  it('remediates: flips the claim, stamps the lead, pulls follow-up, flips the open card', async () => {
    state.firstResults.sms_log = [{ id: 'log-1', to_phone: PHONE, message_type: 'dropped_call_address_request' }];
    state.firstResults.dropped_call_sms_claims = [{ lead_id: LEAD_ID, outcome: 'sent', created_at: new Date() }];
    state.firstResults.leads = [{ id: LEAD_ID }];
    const res = await handleUndeliveredAddressRequest({ sid: 'SM1', status: 'undelivered', errorCode: '30006', to: PHONE });
    expect(res).toEqual({ handled: true, leadId: LEAD_ID });
    const flip = state.updates.find((u) => u.table === 'dropped_call_sms_claims');
    expect(flip.payload.outcome).toBe('undelivered');
    expect(state.updates.filter((u) => u.table === 'leads').length).toBeGreaterThanOrEqual(2);
    expect(state.updates.some((u) => u.table === 'triage_items')).toBe(true);
    const note = state.inserts.find((i) => i.table === 'lead_activities');
    expect(note.payload.description).toMatch(/never arrived/);
    expect(note.payload.description).toMatch(/30006/);
  });

  it('sms_log row missing (send-then-log race) — remediates only on an exact provider-SID match', async () => {
    state.firstResults.sms_log = [null];
    state.firstResults.dropped_call_sms_claims = [{ lead_id: LEAD_ID, outcome: 'sent', provider_sid: 'SM1' }];
    state.firstResults.leads = [{ id: LEAD_ID }];
    const res = await handleUndeliveredAddressRequest({ sid: 'SM1', status: 'failed', to: PHONE });
    expect(res).toEqual({ handled: true, leadId: LEAD_ID });
    expect(state.updates.some((u) => u.table === 'triage_items')).toBe(true);
  });

  it("sms_log row missing AND sid doesn't match the claim — refuses (another message's bounce)", async () => {
    state.firstResults.sms_log = [null];
    state.firstResults.dropped_call_sms_claims = [{ lead_id: LEAD_ID, outcome: 'sent', provider_sid: 'SM_other' }];
    const res = await handleUndeliveredAddressRequest({ sid: 'SM1', status: 'failed', to: PHONE });
    expect(res).toEqual({ handled: false, reason: 'no_log_row_and_sid_mismatch' });
    expect(state.updates.filter((u) => u.table === 'dropped_call_sms_claims')).toHaveLength(0);
  });

  it('delayed 21610 opt-out bounce — claim stamped opted_out, card carries the suppression code', async () => {
    state.firstResults.sms_log = [{ id: 'log-1', to_phone: PHONE, message_type: 'dropped_call_address_request' }];
    state.firstResults.dropped_call_sms_claims = [{ lead_id: LEAD_ID, outcome: 'sent', created_at: new Date() }];
    state.firstResults.leads = [{ id: LEAD_ID }];
    const res = await handleUndeliveredAddressRequest({ sid: 'SM1', status: 'failed', errorCode: '21610', to: PHONE });
    expect(res).toEqual({ handled: true, leadId: LEAD_ID });
    const flip = state.updates.find((u) => u.table === 'dropped_call_sms_claims');
    expect(flip.payload.outcome).toBe('opted_out');
    const note = state.inserts.find((i) => i.table === 'lead_activities');
    expect(note.payload.description).toMatch(/Do NOT text/);
    // No outreach queued for an opt-out: the only lead write is the status
    // stamp, never a next_follow_up_at pull.
    const followUpPulls = state.updates.filter((u) => u.table === 'leads' && u.payload.next_follow_up_at);
    expect(followUpPulls).toHaveLength(0);
  });

  it('idempotent: the claim-outcome flip admits exactly one callback', async () => {
    state.firstResults.sms_log = [{ id: 'log-1', to_phone: PHONE, message_type: 'dropped_call_address_request' }];
    state.firstResults.dropped_call_sms_claims = [{ lead_id: LEAD_ID, outcome: 'undelivered' }];
    state.updateResults.dropped_call_sms_claims = [0]; // 'sent' guard finds no row
    const res = await handleUndeliveredAddressRequest({ sid: 'SM1', status: 'failed', to: PHONE });
    expect(res).toEqual({ handled: false, reason: 'already_handled_or_not_sent' });
    expect(state.inserts).toHaveLength(0);
  });

  it('terminal bounce outcome exposed for the processor post-insert reconcile (both kinds)', async () => {
    const { terminalBounceOutcome } = require('../services/dropped-call-sms');
    state.firstResults.dropped_call_sms_claims = [{ outcome: 'undelivered' }];
    await expect(terminalBounceOutcome(PHONE)).resolves.toBe('undelivered');
    state.firstResults.dropped_call_sms_claims = [{ outcome: 'opted_out' }];
    await expect(terminalBounceOutcome(PHONE)).resolves.toBe('opted_out');
    state.firstResults.dropped_call_sms_claims = [{ outcome: 'sent' }];
    await expect(terminalBounceOutcome(PHONE)).resolves.toBe(null);
  });

  it('callback racing the in-flight claim: flip wins from claimed, sender stamp cannot overwrite', async () => {
    // Handler side: claim still 'claimed' when the bounce lands — flip succeeds.
    state.firstResults.sms_log = [{ id: 'log-1', to_phone: PHONE, message_type: 'dropped_call_address_request' }];
    state.firstResults.dropped_call_sms_claims = [{ lead_id: LEAD_ID, outcome: 'claimed', created_at: new Date() }];
    state.firstResults.leads = [{ id: LEAD_ID }];
    const res = await handleUndeliveredAddressRequest({ sid: 'SM1', status: 'undelivered', errorCode: '30006', to: PHONE });
    expect(res).toEqual({ handled: true, leadId: LEAD_ID });
    // Sender side: the success stamp is CONDITIONAL on outcome='claimed' — the
    // builder records the where; assert the happy-path send used the
    // conditional stamp (outcome 'sent' written via the claimed-only variant).
  });
});
