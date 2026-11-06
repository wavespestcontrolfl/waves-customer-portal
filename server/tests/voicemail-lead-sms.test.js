/**
 * Voicemail lead text-back (services/voicemail-lead-sms.js).
 *
 * Pins the send-gate ladder in order: feature gate (fails closed), one-text-
 * per-phone-ever sms_log dedupe (read failure = fail closed), the atomic
 * per-lead claim, the landline pre-check (fails open on lookup errors), the
 * no-token-secret fail-closed, the template kill switch, and the three
 * sendCustomerMessage outcomes (sent / retryable re-queue onto the
 * scheduled-SMS rail / terminal block keeps the claim). Mirrors the
 * booking-abandon-recovery mock harness.
 */

jest.mock('../models/db', () => {
  const mockDb = jest.fn();
  mockDb.raw = jest.fn((sql, bindings) => ({ __raw: sql, bindings }));
  return mockDb;
});
jest.mock('../config/feature-gates', () => ({
  isEnabled: jest.fn(() => true),
  voicemailTextCallerOnlyLive: jest.fn(() => false),
}));
jest.mock('../config/twilio-numbers', () => ({
  getOutboundNumber: jest.fn(() => '+19415550000'),
  isInternalNumber: jest.fn((n) => String(n).endsWith('5550000')),
}));
jest.mock('../services/messaging/send-customer-message', () => ({
  sendCustomerMessage: jest.fn(async () => ({ sent: true, providerMessageId: 'SM0123456789abcdef0123456789abcdef' })),
}));
jest.mock('../services/sms-template-renderer', () => ({
  renderSmsTemplate: jest.fn(async (key, vars) => `Hi ${vars.first_name} — ${vars.service_label}: ${vars.quote_url}`),
}));
jest.mock('../services/messaging/validators/line-type', () => ({
  readCachedLineType: jest.fn(async () => ({ state: 'miss' })),
  cacheLineType: jest.fn(async () => {}),
  lookupLineType: jest.fn(async () => 'mobile'),
  NON_SMS_LINE_TYPES: new Set(['landline', 'fixedVoip']),
}));
jest.mock('../utils/lead-prefill-token', () => ({
  mintLeadPrefillToken: jest.fn(() => '1760000000.test-signature'),
}));
// createShortCode, not shortenOrPassthrough — the service must fail CLOSED
// when the shortener can't mint a code (the long URL carries the bearer
// token and must never reach an SMS body / sms_log).
const SHORT_URL = 'https://portal.wavespestcontrol.com/l/k3j9x';
jest.mock('../services/short-url', () => ({
  createShortCode: jest.fn(async () => ({ code: 'k3j9x', shortUrl: 'https://portal.wavespestcontrol.com/l/k3j9x' })),
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
// The shared "never auto-text this number" holds are pinned against a real
// schema in auto-text-holds-postgres.test.js; here only their wiring.
jest.mock('../services/messaging/auto-text-holds', () => ({
  autoTextHoldReason: jest.fn(async () => null),
}));

const db = require('../models/db');
const { isEnabled, voicemailTextCallerOnlyLive } = require('../config/feature-gates');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const { renderSmsTemplate } = require('../services/sms-template-renderer');
const lineType = require('../services/messaging/validators/line-type');
const { mintLeadPrefillToken } = require('../utils/lead-prefill-token');
const { createShortCode } = require('../services/short-url');
const { autoTextHoldReason } = require('../services/messaging/auto-text-holds');
const { sendVoicemailQuoteLink, MESSAGE_TYPE } = require('../services/voicemail-lead-sms');

const LEAD_ID = '3f2f7b9c-1111-4222-8333-abcdefabcdef';
const PHONE = '+19415550101';

// Per-table scripting: firstResults queue feeds .first(), updateResults queue
// feeds .update() (claim = affected-row count), insertResults queue feeds
// awaited inserts (the phone claim's onConflict().ignore().returning() chain
// resolves through the builder thenable). Inserts/updates/deletes recorded.
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
  state = { firstResults: {}, updateResults: {}, insertResults: {}, updates: [], inserts: [], deletes: [], insertError: {} };
  db.mockImplementation((table) => makeBuilder(table));
  db.raw.mockImplementation((sql, bindings) => ({ __raw: sql, bindings }));
  isEnabled.mockReturnValue(true);
  voicemailTextCallerOnlyLive.mockReturnValue(false);
  // clearAllMocks does NOT reset mockResolvedValue implementations — restore
  // every default so a per-test override can't leak into the next test.
  lineType.readCachedLineType.mockResolvedValue({ state: 'miss' });
  lineType.lookupLineType.mockResolvedValue('mobile');
  lineType.cacheLineType.mockResolvedValue(undefined);
  mintLeadPrefillToken.mockReturnValue('1760000000.test-signature');
  createShortCode.mockResolvedValue({ code: 'k3j9x', shortUrl: SHORT_URL });
  renderSmsTemplate.mockImplementation(async (key, vars) => `Hi ${vars.first_name} — ${vars.service_label}: ${vars.quote_url}`);
  // A REAL provider id — sent:true alone is a suppression sentinel (isRealProviderSend).
  sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'SM0123456789abcdef0123456789abcdef' });
  autoTextHoldReason.mockResolvedValue(null);
});

function args(overrides = {}) {
  return {
    leadId: LEAD_ID,
    extracted: { first_name: 'dana', matched_service: 'termite' },
    call: { twilio_call_sid: 'CA-test-1' },
    phone: PHONE,
    ...overrides,
  };
}

function stampsFor(table = 'leads') {
  return state.updates
    .filter((u) => u.table === table && u.payload.extracted_data?.bindings)
    .map((u) => u.payload.extracted_data.bindings[0]);
}

function phoneClaimReleased() {
  return state.deletes.some((d) => d.table === 'voicemail_sms_claims');
}

// A release path must also reset the per-lead one-shot marker (jsonb key
// removal) or the reused lead row wedges the retry as already_claimed.
function leadClaimCleared() {
  return state.updates.some((u) => u.table === 'leads'
    && String(u.payload.extracted_data?.__raw || '').includes("- 'quote_link_sms_status'"));
}

function phoneClaimOutcomes() {
  return state.updates
    .filter((u) => u.table === 'voicemail_sms_claims')
    .map((u) => u.payload.outcome);
}

describe('voicemail lead text-back gates', () => {
  test('feature gate off — skipped before any db touch (fails closed everywhere)', async () => {
    isEnabled.mockReturnValue(false);
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'gate_off' });
    expect(db).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('missing lead or phone — skipped', async () => {
    expect(await sendVoicemailQuoteLink(args({ leadId: null }))).toEqual({ sent: false, skipped: 'missing_input' });
    expect(await sendVoicemailQuoteLink(args({ phone: null }))).toEqual({ sent: false, skipped: 'missing_input' });
  });

  test('one text per phone number ever — a prior sms_log row skips before the claim', async () => {
    state.firstResults.sms_log = [{ id: 'prior-sms' }];
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'already_sent_to_phone' });
    // No claim attempted — the leads table was never touched.
    expect(state.updates.filter((u) => u.table === 'leads')).toHaveLength(0);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('every prior quote-link row counts, whatever its status — a replay that ended blocked cannot be proven unsent (a retry-exhausted timeout ends blocked too)', async () => {
    state.firstResults.sms_log = [{ id: 'blocked-replay' }];
    expect(await sendVoicemailQuoteLink(args())).toEqual({ sent: false, skipped: 'already_sent_to_phone' });
    const history = db.mock.results[db.mock.calls.findIndex(([table]) => table === 'sms_log')].value;
    // The history read filters on the phone and the type only, never on status.
    expect(history.where).toHaveBeenCalledTimes(1);
    expect(history.where).toHaveBeenCalledWith({ to_phone: PHONE, message_type: MESSAGE_TYPE });
    expect(history.whereNotIn).not.toHaveBeenCalled();
  });

  test('dedupe read failure fails CLOSED — never risk a duplicate automated text', async () => {
    state.firstResults.sms_log = [new Error('db down')];
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'dedupe_read_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  describe('who never gets the quote-link text (owner rulings 2026-09-27)', () => {
    const claimTaken = () => state.inserts.some((i) => i.table === 'voicemail_sms_claims');

    test('a voicemail that itself asks not to be contacted is held before any claim', async () => {
      const result = await sendVoicemailQuoteLink(args({ doNotContactRequested: true }));
      expect(result).toEqual({ sent: false, skipped: 'asked_not_to_be_contacted' });
      expect(claimTaken()).toBe(false);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });

    test.each(['quote_on_file', 'lead_assigned', 'asked_not_to_be_contacted', 'not_a_prospect', 'recent_conversation'])(
      'a %s hold skips the text without consuming the one-shot',
      async (hold) => {
        autoTextHoldReason.mockResolvedValueOnce(hold);
        const result = await sendVoicemailQuoteLink(args());
        expect(result).toEqual({ sent: false, skipped: hold });
        expect(claimTaken()).toBe(false);
        expect(sendCustomerMessage).not.toHaveBeenCalled();
      },
    );

    test('the hold check runs for this number from this voicemail\'s time — its own call read by id, whatever number it came from — ignoring the lane\'s own texts', async () => {
      const at = new Date('2026-09-26T15:00:00Z');
      await sendVoicemailQuoteLink(args({ call: { id: 'call-9', twilio_call_sid: 'CA-test-1', created_at: at } }));
      expect(autoTextHoldReason).toHaveBeenCalledWith(PHONE, { callAt: at, originCallId: 'call-9', excludeMessageTypes: [MESSAGE_TYPE] });
    });

    // sendCustomerMessage stand-in that runs the lane's providerPreSendCheck
    // where Twilio does (after every other await, right before its request)
    // and maps a refusal the way the real pipeline does.
    const throughProviderBoundary = () => sendCustomerMessage.mockImplementationOnce(async (input) => {
      const verdict = await input.providerPreSendCheck({ channel: 'sms', dbi: 'handoff-conn' });
      if (!verdict || verdict.ok !== true) {
        return { sent: false, blocked: true, deliveryOutcome: 'not_sent', code: verdict?.code, reason: verdict?.reason };
      }
      return { sent: true, providerMessageId: 'SM0123456789abcdef0123456789abcdef' };
    });

    test('a hold that appears while the claims, lookup, render and pipeline run is caught at the provider boundary — both claims released', async () => {
      throughProviderBoundary();
      autoTextHoldReason.mockResolvedValueOnce(null).mockResolvedValueOnce('recent_conversation');
      const result = await sendVoicemailQuoteLink(args());
      expect(result).toEqual({ sent: false, skipped: 'recent_conversation' });
      expect(autoTextHoldReason).toHaveBeenCalledTimes(2);
      // The boundary recheck reads on the connection Twilio hands it.
      expect(autoTextHoldReason).toHaveBeenLastCalledWith(PHONE, expect.objectContaining({ dbi: 'handoff-conn' }));
      expect(phoneClaimReleased()).toBe(true);
      expect(leadClaimCleared()).toBe(true);
      expect(stampsFor()).not.toContain('sent');
    });

    test('an unreadable provider-boundary recheck fails CLOSED and releases both claims', async () => {
      throughProviderBoundary();
      autoTextHoldReason.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('db down'));
      const result = await sendVoicemailQuoteLink(args());
      expect(result).toEqual({ sent: false, skipped: 'hold_check_failed' });
      expect(phoneClaimReleased()).toBe(true);
      expect(leadClaimCleared()).toBe(true);
    });

    test('no hold at the provider boundary: the text goes out', async () => {
      throughProviderBoundary();
      expect(await sendVoicemailQuoteLink(args())).toEqual({ sent: true });
      expect(autoTextHoldReason).toHaveBeenCalledTimes(2);
    });

    test('an unreadable hold check fails CLOSED', async () => {
      autoTextHoldReason.mockRejectedValueOnce(new Error('db down'));
      const result = await sendVoicemailQuoteLink(args());
      expect(result).toEqual({ sent: false, skipped: 'hold_check_failed' });
      expect(claimTaken()).toBe(false);
      expect(sendCustomerMessage).not.toHaveBeenCalled();
    });
  });

  test('phone claim conflict — of two concurrent voicemails from one phone, the loser skips atomically', async () => {
    // ON CONFLICT DO NOTHING returns no row for the loser.
    state.insertResults.voicemail_sms_claims = [[]];
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'already_sent_to_phone' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // The loser never touches the winner's claim.
    expect(phoneClaimReleased()).toBe(false);
  });

  test('phone claim insert failure fails CLOSED', async () => {
    state.insertError.voicemail_sms_claims = new Error('claims table unavailable');
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'claim_insert_failed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('per-lead claim lost (0 rows) — this lead already ran; the phone claim is kept', async () => {
    state.updateResults.leads = [0];
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'already_claimed' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(phoneClaimReleased()).toBe(false);
  });

  test('landline pre-check blocks the send and stamps the lead', async () => {
    lineType.readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'landline' });
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'landline' });
    expect(lineType.lookupLineType).not.toHaveBeenCalled(); // cache hit = no paid Lookup
    expect(stampsFor()).toContain('blocked');
    // A landline stays a landline — the phone claim is consumed, not released.
    expect(phoneClaimReleased()).toBe(false);
    expect(phoneClaimOutcomes()).toContain('landline');
    const notes = state.inserts.filter((i) => i.table === 'lead_activities');
    expect(notes).toHaveLength(1);
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('fixedVoip pre-check blocks the send but RELEASES both one-shot claims (reversible block)', async () => {
    lineType.readCachedLineType.mockResolvedValue({ state: 'hit', lineType: 'fixedVoip' });
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'fixedVoip' });
    expect(lineType.lookupLineType).not.toHaveBeenCalled();
    // Released, not consumed: a rollback of LINETYPE_BLOCK_FIXED_VOIP must let
    // a future voicemail from this phone re-evaluate under the current set —
    // no 'blocked' lead stamp (it would wedge the reused lead at the claim
    // predicate), lead marker removed, phone claim deleted.
    expect(stampsFor()).not.toContain('blocked');
    expect(leadClaimCleared()).toBe(true);
    expect(phoneClaimReleased()).toBe(true);
    expect(phoneClaimOutcomes()).not.toContain('fixedVoip');
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('cache miss does one paid Lookup and caches it; mobile proceeds', async () => {
    lineType.readCachedLineType.mockResolvedValue({ state: 'miss' });
    lineType.lookupLineType.mockResolvedValue('mobile');
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: true });
    expect(lineType.lookupLineType).toHaveBeenCalledWith(PHONE);
    expect(lineType.cacheLineType).toHaveBeenCalledWith(PHONE, 'mobile');
  });

  test('line-type pre-check failure fails OPEN — the reactive 30006 suppression is the backstop', async () => {
    lineType.readCachedLineType.mockRejectedValue(new Error('lookup exploded'));
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: true });
  });

  test('no prefill-token secret — fails closed instead of texting a broken link', async () => {
    mintLeadPrefillToken.mockReturnValue(null);
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'no_token_secret' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Config failure never consumed the one-shot — BOTH claims release so a
    // later voicemail (usually reusing this lead row) can retry.
    expect(phoneClaimReleased()).toBe(true);
    expect(leadClaimCleared()).toBe(true);
  });

  test('template missing or admin-disabled — kill switch respected', async () => {
    renderSmsTemplate.mockResolvedValue(undefined);
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'template_disabled' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Re-enabling the template should let a LATER voicemail get its text —
    // both the phone claim and the per-lead marker must reset together.
    expect(phoneClaimReleased()).toBe(true);
    expect(leadClaimCleared()).toBe(true);
  });

  test('shortener failure fails CLOSED — the bearer long URL never reaches an SMS body', async () => {
    createShortCode.mockRejectedValue(new Error('db down'));
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'short_link_failed' });
    // Nothing rendered, nothing sent — no surface (sms_log, audit previews,
    // Twilio) ever sees a URL containing the prefill token.
    expect(renderSmsTemplate).not.toHaveBeenCalled();
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    // Transient failure never consumed the one-shot — BOTH claims release so
    // a later voicemail (usually reusing this lead row) can retry.
    expect(phoneClaimReleased()).toBe(true);
    expect(leadClaimCleared()).toBe(true);
  });
});

describe('voicemail lead text-back send outcomes', () => {
  test('happy path — sends under the missed_call_followup policy with the prefill link', async () => {
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: true });

    expect(renderSmsTemplate).toHaveBeenCalledWith(MESSAGE_TYPE, expect.objectContaining({
      first_name: 'Dana', // capitalized
      service_label: 'termite',
      // The SMS body carries ONLY the opaque short code — the tokenized long
      // URL exists solely as the short code's redirect target.
      quote_url: SHORT_URL,
    }), expect.any(Object));
    expect(renderSmsTemplate.mock.calls[0][1].quote_url).not.toContain('vt=');
    // Token rides the redirect target's FRAGMENT — never a query string a
    // server would log.
    const longUrl = createShortCode.mock.calls[0][0];
    expect(longUrl).toContain(`/quote#vlead=${encodeURIComponent(LEAD_ID)}`);
    expect(longUrl).toContain('vt=');
    expect(longUrl).not.toContain('?vlead');

    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: PHONE,
      audience: 'lead',
      purpose: 'missed_call_followup',
      identityTrustLevel: 'phone_provided_unverified',
      consentBasis: expect.objectContaining({ status: 'transactional_allowed' }),
    }));

    expect(stampsFor()).toContain('sent');
    const activity = state.inserts.find((i) => i.table === 'lead_activities');
    expect(activity.payload.activity_type).toBe('sms_sent');
    // PII discipline: the activity masks the phone.
    expect(activity.payload.description).not.toContain(PHONE);
    expect(activity.payload.description).toContain('***0101');
  });

  test('a 10-digit extracted callback normalizes to E.164 before claiming and sending', async () => {
    const result = await sendVoicemailQuoteLink(args({ phone: '(941) 555-0101' }));
    expect(result).toEqual({ sent: true });
    const claim = state.inserts.find((i) => i.table === 'voicemail_sms_claims');
    expect(claim.payload.phone).toBe(PHONE); // +19415550101 — same key as Twilio caller-ID form
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: PHONE }));
  });

  test('missing name/service falls back to "there" + "pest control"', async () => {
    await sendVoicemailQuoteLink(args({ extracted: {} }));
    expect(renderSmsTemplate).toHaveBeenCalledWith(MESSAGE_TYPE, expect.objectContaining({
      first_name: 'there',
      service_label: 'pest control',
    }), expect.any(Object));
  });

  test('suppression sentinel (sent:true, gate-blocked sid) is NOT a send — claims released, lead not stamped texted', async () => {
    // twilio.js returns success with a sentinel sid while the SMS gate is
    // off / template disabled; stamping 'sent' here would wedge the lead as
    // "texted" forever. Same handling as the dropped-call lane.
    sendCustomerMessage.mockResolvedValue({ sent: true, providerMessageId: 'gate-blocked' });
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'send_suppressed', code: 'gate-blocked' });

    expect(stampsFor()).not.toContain('sent');
    expect(phoneClaimOutcomes()).not.toContain('sent');
    expect(leadClaimCleared()).toBe(true);
    expect(phoneClaimReleased()).toBe(true);
    expect(state.inserts.find((i) => i.table === 'lead_activities')).toBeUndefined();
  });

  test('retryable provider failure re-queues onto the scheduled-SMS rail for the next allowed time', async () => {
    const nextAllowedAt = '2026-07-02T12:00:00.000Z';
    sendCustomerMessage.mockResolvedValue({
      sent: false, blocked: false, retryable: true, code: 'PROVIDER_FAILURE', nextAllowedAt,
    });
    const callAt = new Date('2026-07-01T23:30:00Z');
    const result = await sendVoicemailQuoteLink(args({ call: { id: 'call-7', twilio_call_sid: 'CA-test-1', created_at: callAt } }));
    expect(result).toEqual({ sent: false, scheduled: true, nextAllowedAt });

    const queued = state.inserts.find((i) => i.table === 'sms_log');
    expect(queued.payload).toEqual(expect.objectContaining({
      status: 'scheduled',
      message_type: MESSAGE_TYPE,
      to_phone: PHONE,
      scheduled_for: new Date(nextAllowedAt),
    }));
    // The scheduled-SMS cron replays through sendCustomerMessage — the
    // transactional consent basis must ride in the row's metadata or the
    // anonymous-lead replay blocks as NO_CONSENT_RECORD (pre-push Codex P1).
    const meta = JSON.parse(queued.payload.metadata);
    expect(meta.consent_basis).toEqual(expect.objectContaining({ status: 'transactional_allowed' }));
    expect(meta.lead_id).toBe(LEAD_ID);
    // The replay re-runs the holds against the originating call (read by
    // id) from its time.
    expect(meta.call_log_id).toBe('call-7');
    expect(new Date(meta.call_created_at)).toEqual(callAt);
    expect(stampsFor()).toContain('scheduled');
    expect(phoneClaimOutcomes()).toContain('scheduled');
    expect(phoneClaimReleased()).toBe(false);
  });

  test('re-queue insert failure downgrades to failed (never throws into call processing)', async () => {
    sendCustomerMessage.mockResolvedValue({
      sent: false, blocked: false, retryable: true, code: 'PROVIDER_FAILURE', nextAllowedAt: '2026-07-02T12:00:00.000Z',
    });
    state.insertError.sms_log = new Error('insert failed');
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'requeue_failed' });
    // Transient failure — the one-shot was not consumed; both claims reset.
    expect(phoneClaimReleased()).toBe(true);
    expect(leadClaimCleared()).toBe(true);
  });

  test('terminal block (STOP suppression etc.) keeps the claim — a blocked prospect is never retried', async () => {
    sendCustomerMessage.mockResolvedValue({ sent: false, blocked: true, code: 'SUPPRESSED', reason: 'STOP on file' });
    const result = await sendVoicemailQuoteLink(args());
    expect(result).toEqual({ sent: false, skipped: 'SUPPRESSED' });
    expect(stampsFor()).toContain('blocked');
    // No re-queue row, and the phone claim is consumed with the block code.
    expect(state.inserts.filter((i) => i.table === 'sms_log')).toHaveLength(0);
    expect(phoneClaimReleased()).toBe(false);
    expect(phoneClaimOutcomes()).toContain('SUPPRESSED');
  });
});

describe('GATE_VOICEMAIL_TEXT_CALLER_ONLY — the text goes only to the number that called (audit run 3, C2)', () => {
  const CALLER = '+19415550100';
  const SPOKEN = '+18135550199';
  const callerCall = (over = {}) => ({
    id: 'call-dummy-1', twilio_call_sid: 'CA-dummy-1', direction: 'inbound', from_phone: CALLER,
    created_at: new Date('2026-11-05T07:30:00Z'), ...over,
  });
  const callerArgs = (over = {}) => args({ phone: SPOKEN, call: callerCall(), ...over });
  const vars = () => renderSmsTemplate.mock.calls[0][1];

  beforeEach(() => {
    voicemailTextCallerOnlyLive.mockReturnValue(true);
  });

  test('gate off: a spoken callback number is still texted with the extracted words (unchanged)', async () => {
    voicemailTextCallerOnlyLive.mockReturnValue(false);
    const result = await sendVoicemailQuoteLink(callerArgs({
      extracted: { first_name: 'mike, visit example.test', requested_service: 'your refund at example.test' },
    }));
    expect(result).toEqual({ sent: true });
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: SPOKEN }));
    expect(vars()).toEqual(expect.objectContaining({
      first_name: 'Mike, visit example.test',
      service_label: 'your refund at example.test',
    }));
  });

  test('a spoken callback number that is not the caller ID is never texted; the caller ID is', async () => {
    const result = await sendVoicemailQuoteLink(callerArgs());
    expect(result).toEqual({ sent: true });
    expect(sendCustomerMessage).toHaveBeenCalledTimes(1);
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({
      to: CALLER, entryPoint: 'voicemail_lead_sms', identityTrustLevel: 'phone_provided_unverified',
    }));
    // Every per-number check runs on the number that is texted.
    expect(autoTextHoldReason).toHaveBeenCalledWith(CALLER, expect.objectContaining({ originCallId: 'call-dummy-1' }));
    expect(autoTextHoldReason).not.toHaveBeenCalledWith(SPOKEN, expect.anything());
    expect(state.inserts.find((i) => i.table === 'voicemail_sms_claims').payload.phone).toBe(CALLER);
    expect(lineType.readCachedLineType).toHaveBeenCalledWith(CALLER);
  });

  test('the spoken number stays for staff: a timeline note names both numbers masked, and the full numbers appear nowhere', async () => {
    await sendVoicemailQuoteLink(callerArgs());
    const note = state.inserts.find((i) => i.table === 'lead_activities' && i.payload.activity_type === 'note');
    expect(note.payload.description).toContain('***0100');
    expect(note.payload.description).toContain('***0199');
    expect(note.payload.description).not.toContain(SPOKEN);
    expect(JSON.parse(note.payload.metadata).reason).toBe('spoken_number_not_caller');
  });

  test('a spoken number equal to the caller ID (any format) adds no note and texts the caller', async () => {
    const result = await sendVoicemailQuoteLink(callerArgs({ phone: '(941) 555-0100' }));
    expect(result).toEqual({ sent: true });
    expect(sendCustomerMessage).toHaveBeenCalledWith(expect.objectContaining({ to: CALLER }));
    expect(state.inserts.some((i) => i.table === 'lead_activities' && i.payload.activity_type === 'note')).toBe(false);
  });

  test.each([
    ['an outbound call row', { direction: 'outbound-api' }],
    ['a withheld caller ID', { from_phone: 'anonymous' }],
    ['no caller ID', { from_phone: null }],
    ['an impossible area code', { from_phone: '+11735550100' }],
    ['one of our own lines', { from_phone: '+19415550000' }],
  ])('%s: no text goes to the spoken number, and nothing is claimed', async (_label, over) => {
    const result = await sendVoicemailQuoteLink(callerArgs({ call: callerCall(over) }));
    expect(result).toEqual({ sent: false, skipped: 'no_caller_number' });
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(state.inserts.some((i) => i.table === 'voicemail_sms_claims')).toBe(false);
  });

  test('a missing lead id still reads as missing input', async () => {
    expect(await sendVoicemailQuoteLink(callerArgs({ leadId: null }))).toEqual({ sent: false, skipped: 'missing_input' });
  });

  test.each([
    ['a name with a link', 'mike, visit example.test'],
    ['a name with digits', 'mike2'],
    ['a sentence over 30 characters', 'Alexandria Maximilian Wolfeschlegel'],
    ['a name with markup', '<b>Dana</b>'],
    ['a name that starts with a hyphen', '-dana'],
  ])('%s gets the no-name greeting', async (_label, first_name) => {
    await sendVoicemailQuoteLink(callerArgs({ extracted: { first_name, matched_service: 'termite' } }));
    expect(vars().first_name).toBe('there');
  });

  test.each([
    ['dana', 'Dana'],
    ["o'brien", "O'brien"],
    ['mary-ann', 'Mary-ann'],
    ['  jo   ann ', 'Jo ann'],
    ['zoë', 'Zoë'],
  ])('a plain first name (%s) is kept', async (first_name, expected) => {
    await sendVoicemailQuoteLink(callerArgs({ extracted: { first_name } }));
    expect(vars().first_name).toBe(expected);
  });

  test.each([
    [{ requested_service: 'your refund at example.test' }, 'pest control'],
    [{ matched_service: 'Call 941-555-0123 now' }, 'pest control'],
    [{}, 'pest control'],
    [{ matched_service: 'termite' }, 'Termite Inspection'],
    [{ matched_service: 'Mosquito Control' }, 'Mosquito Control'],
    [{ requested_service: 'my lawn is dying, visit example.test' }, 'Lawn Care'],
    [{ requested_service: 'rats in the attic' }, 'Rodent Control'],
    [{ matched_service: 'palm trees' }, 'Tree & Shrub'],
    [{ matched_service: 'General Pest Control' }, 'Pest Control'],
    [{ matched_service: 'something odd', requested_service: 'ants' }, 'Pest Control'],
  ])('the service words for %j come from the allow-list: %s', async (extracted, expected) => {
    await sendVoicemailQuoteLink(callerArgs({ extracted }));
    expect(vars().service_label).toBe(expected);
  });

  test('the spoken text never reaches the body, even when it holds a link', async () => {
    await sendVoicemailQuoteLink(callerArgs({
      extracted: { first_name: 'mike, visit example.test', requested_service: 'your refund at example.test' },
    }));
    expect(sendCustomerMessage.mock.calls[0][0].body).not.toContain('example.test');
    expect(vars()).toEqual(expect.objectContaining({ first_name: 'there', service_label: 'pest control' }));
  });

  test('the existing checks still apply to the caller number: a hold skips the text', async () => {
    autoTextHoldReason.mockResolvedValueOnce('quote_on_file');
    expect(await sendVoicemailQuoteLink(callerArgs())).toEqual({ sent: false, skipped: 'quote_on_file' });
    expect(autoTextHoldReason).toHaveBeenCalledWith(CALLER, expect.any(Object));
    expect(sendCustomerMessage).not.toHaveBeenCalled();
  });

  test('the deferred row carries the caller number, not the spoken one', async () => {
    sendCustomerMessage.mockResolvedValueOnce({ sent: false, retryable: true, nextAllowedAt: '2026-11-05T13:00:00Z', code: 'SEND_WINDOW' });
    const result = await sendVoicemailQuoteLink(callerArgs());
    expect(result.scheduled).toBe(true);
    const queued = state.inserts.find((i) => i.table === 'sms_log');
    expect(queued.payload.to_phone).toBe(CALLER);
    expect(JSON.parse(queued.payload.metadata).voicemail_phone).toBe(CALLER);
  });
});
