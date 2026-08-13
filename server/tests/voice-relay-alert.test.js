/**
 * Voice-relay Phase E item 2 — URGENT/HOT-LEAD INTERNAL OWNER ALERT.
 *
 * Matrix:
 *   - gate off → no alert, no sender loaded
 *   - lead_quality 'hot' → ONE internal alert, through the SAME sender the
 *     self-booking confirm path uses (TwilioService.sendSMS to ADAM_PHONE with
 *     messageType 'internal_alert')
 *   - cold / warm / spam / no quality → no alert
 *   - idempotent: one per CALL, never per turn (two capture_lead calls, one alert)
 *   - fail-open: an alert failure never breaks the call OR the lead write
 *   - NEVER customer-facing: the customer-send spies must be un-called on
 *     every path (sendCustomerMessage, appointment reminders, email)
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/lead-from-extraction', () => ({ createLeadFromExtraction: jest.fn() }));
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
// The internal-alert sender (services/twilio.js redirects owner-phone
// internal_alert sends to the admin bell/push before Twilio is ever touched).
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn(async () => ({ success: true, sid: 'internal-admin-notification' })) }));
// CUSTOMER-FACING spies — none of these may EVER fire from the voice agent.
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/email', () => ({ send: jest.fn() }));
jest.mock('../services/appointment-reminders', () => ({ registerAppointment: jest.fn(), sendConfirmation: jest.fn() }));

const TwilioService = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailService = require('../services/email');
const AppointmentReminders = require('../services/appointment-reminders');
const { createLeadFromExtraction } = require('../services/lead-from-extraction');
const logger = require('../services/logger');

const relayAlert = require('../services/voice-agent/relay-alert');
const { executeTool } = require('../services/voice-agent/relay-tools');

// Synthetic fixtures only — 555 numbers, example.com.
const OWNER = '+19415550199';
const CALLER = '+19415550142';
const HOT_LEAD = {
  first_name: 'Pat', last_name: 'Rivera', phone: CALLER, city: 'Bradenton',
  requested_service: 'termites swarming in the living room',
  urgency_reason: 'swarming termites right now',
  call_summary: 'Swarming termites in the living room, wants someone today.',
  lead_quality: 'hot',
};

function assertNeverCustomerFacing() {
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(EmailService.send).not.toHaveBeenCalled();
  expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  expect(AppointmentReminders.sendConfirmation).not.toHaveBeenCalled();
  // Every sendSMS the agent can make is an internal_alert to the owner phone.
  for (const call of TwilioService.sendSMS.mock.calls) {
    expect(call[0]).toBe(OWNER);
    expect(call[2]).toMatchObject({ messageType: 'internal_alert' });
  }
}

const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
const savedPhone = process.env.ADAM_PHONE;
afterAll(() => {
  if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
  if (savedPhone === undefined) delete process.env.ADAM_PHONE;
  else process.env.ADAM_PHONE = savedPhone;
});

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
  process.env.ADAM_PHONE = OWNER;
  createLeadFromExtraction.mockResolvedValue({ leadId: 'l-1', customerId: null, created: true });
  TwilioService.sendSMS.mockResolvedValue({ success: true, sid: 'internal-admin-notification' });
});

describe('GATE OFF — dark', () => {
  test('a hot lead fires NOTHING while the context gate is off', async () => {
    expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, { callSid: 'CA1' })).toBe(false);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    assertNeverCustomerFacing();
  });

  test('gate values other than the literal "true" stay dark', async () => {
    for (const v of ['1', 'on', 'TRUE ', 'yes']) {
      process.env.VOICE_RELAY_CONTEXT_ENABLED = v;
      expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, {})).toBe(false);
    }
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });
});

// ⭐ ONE PAGE PER CALL, DURABLY. The session latch is per RelayConversation,
// and a legitimate reconnect (fresh token, same CallSid) builds a NEW
// conversation with the latch clear — so the receipt lives on the call's own
// call_log row (metadata.relay_hot_alert_at, one atomic winner), released on a
// failed send so the retry rail stays open, and fail-OPEN on a claim error: a
// rare duplicate page is safer than a missed swarm call.
describe('GATE ON — the durable one-page-per-CALL receipt', () => {
  const db = require('../models/db');

  function primeClaimDb({ claimWins, metadata = { relay_hot_alert_at: 't1', relay_hot_alert_sent_at: 't2' }, deliveredRow = null }) {
    const builder = {};
    for (const m of ['where', 'whereRaw']) builder[m] = jest.fn(() => builder);
    builder.update = jest.fn(() => ({ returning: jest.fn(async () => (claimWins ? [{ id: 'cl-1' }] : [])) }));
    // The row exists; `metadata` is what the loser's state read sees.
    builder.first = jest.fn(async () => ({ id: 'cl-1', metadata }));
    // The DELIVERY-evidence probe reads the notifications table by title —
    // its own builder, empty unless a test primes deliveredRow.
    const notif = {};
    for (const m of ['where', 'whereRaw']) notif[m] = jest.fn(() => notif);
    notif.first = jest.fn(async () => deliveredRow);
    notif.update = jest.fn(() => ({ returning: jest.fn(async () => []) }));
    db.mockImplementation((table) => (table === 'notifications' ? notif : builder));
    db.raw = jest.fn((sql) => ({ __raw: sql }));
    return builder;
  }

  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('a reconnected session (fresh latch, same CallSid) does NOT page twice', async () => {
    // An earlier session burned the claim AND wrote the delivery receipt.
    primeClaimDb({ claimWins: false });
    const ctx = { callSid: 'CA-reconnect', markOwnerAlerted: jest.fn() };
    const out = await relayAlert.alertOwnerHotLead(HOT_LEAD, ctx);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    // …and the session is told the call IS covered: latch set, promise stands.
    expect(ctx.markOwnerAlerted).toHaveBeenCalled();
    expect(out).toBe(true);
  });

  // ⭐ CLAIMED IS NOT DELIVERED. A claim with no SENT receipt means the winner
  // is still in flight (or about to fail): the loser neither pages (no
  // duplicate) nor confirms (no false promise), and crucially does NOT latch —
  // a later attempt on this session can still page if the winner released.
  test('a claim with NO delivery receipt is not coverage — no page, no latch, false', async () => {
    primeClaimDb({ claimWins: false, metadata: { relay_hot_alert_at: 't1' } }); // claimed, never sent
    const ctx = { callSid: 'CA-inflight', markOwnerAlerted: jest.fn() };
    const out = await relayAlert.alertOwnerHotLead(HOT_LEAD, ctx);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(ctx.markOwnerAlerted).not.toHaveBeenCalled();
    expect(out).toBe(false);
  }, 15000);

  test('a claim RELEASED mid-wait (the winner failed) is taken over and paged', async () => {
    // First claim attempt loses; the state read then shows the key gone
    // (winner released); the takeover claim wins.
    const builder = {};
    for (const m of ['where', 'whereRaw']) builder[m] = jest.fn(() => builder);
    let claims = 0;
    builder.update = jest.fn(() => ({
      returning: jest.fn(async () => {
        claims += 1;
        return claims >= 2 ? [{ id: 'cl-1' }] : []; // lose, then win the takeover
      }),
    }));
    builder.first = jest.fn(async () => ({ id: 'cl-1', metadata: {} })); // released, no receipt
    const notif = {};
    for (const m of ['where', 'whereRaw']) notif[m] = jest.fn(() => notif);
    notif.first = jest.fn(async () => null); // no delivery evidence
    db.mockImplementation((table) => (table === 'notifications' ? notif : builder));
    db.raw = jest.fn((sql) => ({ __raw: sql }));
    const ctx = { callSid: 'CA-takeover', markOwnerAlerted: jest.fn() };
    const out = await relayAlert.alertOwnerHotLead(HOT_LEAD, ctx);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    expect(out).toBe(true);
  }, 15000);

  test('a FAILED send releases the durable claim so a retry can still page', async () => {
    const builder = primeClaimDb({ claimWins: true });
    TwilioService.sendSMS.mockResolvedValueOnce({ success: true, notificationUndelivered: true });
    const out = await relayAlert.alertOwnerHotLead(HOT_LEAD, { callSid: 'CA-release', markOwnerAlerted: jest.fn() });
    expect(out).toBe(false);
    // Two updates: the claim burn, then the release (metadata minus the key).
    const updates = builder.update.mock.calls.map(([payload]) => String((payload.metadata || {}).__raw || ''));
    expect(updates.some((sql) => sql.includes("- 'relay_hot_alert_at'"))).toBe(true);
  });

  // ⭐ THE CLAIM IS A LEASE, NOT A TOMBSTONE. A process that dies between the
  // claim and the send leaves claimed-with-no-receipt forever — and every later
  // session would refuse to page for the rest of time. The claim UPDATE's own
  // predicate lets a stale unsent claim be re-burned atomically.
  test('the claim predicate reclaims a stale UNSENT claim (expirable lease)', async () => {
    const builder = primeClaimDb({ claimWins: true });
    await relayAlert.alertOwnerHotLead(HOT_LEAD, { callSid: 'CA-lease', markOwnerAlerted: jest.fn() });
    const predicates = builder.whereRaw.mock.calls.map(([sql]) => String(sql));
    const claimPredicate = predicates.find((sql) => sql.includes('relay_hot_alert_at'));
    expect(claimPredicate).toContain("interval '2 minutes'"); // stale-claim reclaim window
    expect(claimPredicate).toContain('relay_hot_alert_sent_at'); // …only when never sent
  });

  // ⭐ THE SWEEP KEYS ON THE RELAY'S OWN OBLIGATION MARKER — never lead urgency
  // (the recorded-call pipeline marks human-call leads urgent too, and a reused
  // lead's stale twilio_call_sid hid genuine relay ones). capture_lead stamps
  // call_log.metadata.relay_hot_alert_needed + relay_lead_id before the page
  // attempt; the sweep resolves the lead through that exact linkage.
  test('the sweep keys on relay_hot_alert_needed and resolves the lead by relay_lead_id', async () => {
    const callRows = [{
      twilio_call_sid: 'CA-swept-1',
      metadata: { relay_hot_alert_needed: 'true', relay_lead_id: 'lead-9' },
    }];
    const callBuilder = {};
    for (const m of ['where', 'whereRaw', 'orderBy', 'limit']) callBuilder[m] = jest.fn(() => callBuilder);
    callBuilder.select = jest.fn(async () => callRows);
    callBuilder.update = jest.fn(() => ({ returning: jest.fn(async () => [{ id: 'cl-1' }]) }));
    callBuilder.first = jest.fn(async () => null);
    const leadsBuilder = {};
    for (const m of ['where', 'whereNull']) leadsBuilder[m] = jest.fn(() => leadsBuilder);
    leadsBuilder.first = jest.fn(async () => ({
      first_name: 'Pat', last_name: 'Rivera', phone: CALLER, city: 'Bradenton',
      transcript_summary: 'Swarming termites in the living room.',
    }));
    const notifBuilder = {};
    for (const m of ['where', 'whereRaw']) notifBuilder[m] = jest.fn(() => notifBuilder);
    notifBuilder.first = jest.fn(async () => null);
    db.mockImplementation((table) => {
      if (table === 'leads') return leadsBuilder;
      if (table === 'notifications') return notifBuilder;
      return callBuilder;
    });
    db.raw = jest.fn((sql) => ({ __raw: sql }));
    process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true';

    const paged = await relayAlert.sweepAbandonedHotAlerts();
    expect(paged).toBe(1);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    expect(leadsBuilder.where).toHaveBeenCalledWith({ id: 'lead-9' }); // exact linkage, not urgency
    const raws = callBuilder.whereRaw.mock.calls.map(([sql]) => String(sql));
    expect(raws.some((sql) => sql.includes('relay_hot_alert_needed'))).toBe(true);
    expect(raws.some((sql) => sql.includes('relay_hot_alert_sent_at'))).toBe(true);
  });

  test('a claim ERROR pages anyway (fail-open: a duplicate beats a missed swarm)', async () => {
    db.mockImplementation(() => { throw new Error('db down'); });
    const out = await relayAlert.alertOwnerHotLead(HOT_LEAD, { callSid: 'CA-db-down', markOwnerAlerted: jest.fn() });
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    expect(out).toBe(true);
  });
});

describe('GATE ON — the alert', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('hot lead → ONE internal alert via the self-booking confirm path\'s exact sender', async () => {
    const ctx = { callSid: 'CA-hot', markOwnerAlerted: jest.fn() };
    expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, ctx)).toBe(true);

    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    const [to, body, opts] = TwilioService.sendSMS.mock.calls[0];
    expect(to).toBe(OWNER);
    expect(opts).toMatchObject({ messageType: 'internal_alert' }); // hot path adds the per-call dedupe title
    expect(body).toMatch(/URGENT lead/i);
    expect(body).toContain('Pat Rivera');
    expect(body).toContain(CALLER); // the owner needs a number to call back
    expect(body).toContain('swarming termites right now');
    expect(ctx.markOwnerAlerted).toHaveBeenCalledTimes(1);
    assertNeverCustomerFacing();
  });

  test('a matched existing customer is flagged as such in the alert', async () => {
    await relayAlert.alertOwnerHotLead(HOT_LEAD, { customerId: 'c-1', callSid: 'CA-x' });
    expect(TwilioService.sendSMS.mock.calls[0][1]).toMatch(/EXISTING CUSTOMER/);
  });

  test('cold / warm / spam / missing quality → NO alert', async () => {
    for (const quality of ['cold', 'warm', 'spam', null, undefined, 'HOT ']) {
      expect(await relayAlert.alertOwnerHotLead({ ...HOT_LEAD, lead_quality: quality }, {})).toBe(false);
    }
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    assertNeverCustomerFacing();
  });

  test('IDEMPOTENT — one alert per CALL even when capture_lead runs twice', async () => {
    let alerted = false;
    const ctx = { callSid: 'CA-twice', isOwnerAlerted: () => alerted, markOwnerAlerted: () => { alerted = true; } };
    expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, ctx)).toBe(true);
    expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, ctx)).toBe(false);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  });

  test('a plain ownerAlerted boolean is honoured too (simple ctx)', async () => {
    expect(await relayAlert.alertOwnerHotLead(HOT_LEAD, { ownerAlerted: true })).toBe(false);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('FAIL-OPEN — a send failure is logged loudly and never thrown', async () => {
    TwilioService.sendSMS.mockRejectedValue(new Error('notification trigger down'));
    await expect(relayAlert.alertOwnerHotLead(HOT_LEAD, { callSid: 'CA-fail' })).resolves.toBe(false);
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/hot-lead owner alert FAILED/i));
  });

  test('no ADAM_PHONE configured → no alert, warned, nothing thrown', async () => {
    delete process.env.ADAM_PHONE;
    await expect(relayAlert.alertOwnerHotLead(HOT_LEAD, {})).resolves.toBe(false);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/ADAM_PHONE is unset/i));
  });

  test('the alert body never leaks the caller phone into LOGS (masked there only)', async () => {
    await relayAlert.alertOwnerHotLead(HOT_LEAD, { callSid: 'CA-mask' });
    const logged = [...logger.info.mock.calls, ...logger.warn.mock.calls, ...logger.error.mock.calls].flat().join(' ');
    expect(logged).not.toContain(CALLER);
    expect(logged).toMatch(/hot-lead owner alert sent/);
  });
});

// ⭐ THE LATCH IS SET AFTER A SUCCESSFUL SEND. Marking it first meant a
// transient failure PERMANENTLY consumed the one-per-call budget — the retry saw
// `alreadyAlerted` and returned quietly, and the hot lead was never paged at all.
describe('the one-per-call latch survives a failed send', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; process.env.ADAM_PHONE = OWNER; });

  function latchCtx() {
    let alerted = false;
    return {
      callSid: 'CA-latch',
      isOwnerAlerted: () => alerted,
      markOwnerAlerted: () => { alerted = true; },
      _alerted: () => alerted,
    };
  }

  const HOT = { lead_quality: 'hot', first_name: 'Pat', phone: CALLER, urgency_reason: 'swarming termites' };

  test('a failed send leaves the latch OPEN so the retry can still page', async () => {
    const ctx = latchCtx();
    TwilioService.sendSMS.mockRejectedValueOnce(new Error('twilio down'));
    expect(await relayAlert.alertOwnerHotLead(HOT, ctx)).toBe(false);
    expect(ctx._alerted()).toBe(false); // NOT consumed

    TwilioService.sendSMS.mockResolvedValueOnce({ success: true });
    expect(await relayAlert.alertOwnerHotLead(HOT, ctx)).toBe(true);
    expect(ctx._alerted()).toBe(true);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(2);
  });

  test('a SUCCESSFUL send still closes the latch — never two pages per call', async () => {
    const ctx = latchCtx();
    expect(await relayAlert.alertOwnerHotLead(HOT, ctx)).toBe(true);
    expect(await relayAlert.alertOwnerHotLead(HOT, ctx)).toBe(false);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
  });

  // ⭐ `success: true` IS NOT DELIVERY HERE. services/twilio.js suppresses the
  // owner SMS and redirects internal_alert sends to the bell/push path — and
  // that redirect still returns success:true when the notification write itself
  // failed (notificationUndelivered / notificationError). Latching on that
  // burned the one-per-call budget for a page nobody ever saw.
  test('an UNDELIVERED notification redirect does not close the latch', async () => {
    for (const failure of [
      { success: true, sid: 'internal-admin-notification-undelivered', suppressed: true, notificationRedirected: false, notificationUndelivered: true },
      { success: true, sid: 'internal-admin-notification-error', suppressed: true, notificationRedirected: false, notificationError: true },
      { success: false },
    ]) {
      const ctx = latchCtx();
      TwilioService.sendSMS.mockResolvedValueOnce(failure);
      expect(await relayAlert.alertOwnerHotLead(HOT, ctx)).toBe(false);
      expect(ctx._alerted()).toBe(false); // budget NOT consumed — the retry can still page
      expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/hot-lead owner alert NOT delivered/i));
    }
  });

  test('a delivered redirect (notificationRedirected) still closes the latch', async () => {
    const ctx = latchCtx();
    TwilioService.sendSMS.mockResolvedValueOnce({ success: true, sid: 'internal-admin-notification', suppressed: true, notificationRedirected: true });
    expect(await relayAlert.alertOwnerHotLead(HOT, ctx)).toBe(true);
    expect(ctx._alerted()).toBe(true);
  });
});

// ⭐ OWNER-RULED: the ticket queue is "a proven black hole — 14 requests, zero
// resolved", and the agent cannot use the streamline's booking half (it fires
// customer comms). So every voice-filed re-service ALSO pages the owner through
// the existing internal sender — no new notification mechanism.
describe('re-service owner alert (owner ruling)', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; process.env.ADAM_PHONE = OWNER; });

  const REQ = { lane: 'pest', category: 'pest_issue', urgency: 'urgent', issue: 'ants back in the kitchen', subject: 'Re-service request (phone assistant): ants back in the kitchen', covered: true, requestId: 'req-1', customerId: 'c-1' };

  test('sends through the SAME internal sender, to the owner, internal_alert only', async () => {
    expect(await relayAlert.alertOwnerReservice(REQ, { callSid: 'CA-rs' })).toBe(true);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    const [to, body, opts] = TwilioService.sendSMS.mock.calls[0];
    expect(to).toBe(OWNER);
    expect(opts).toMatchObject({ messageType: 'internal_alert' }); // hot path adds the per-call dedupe title
    expect(body).toMatch(/URGENT/);
    expect(body).toContain('ants back in the kitchen');
    expect(body).toMatch(/do not leave this in the request queue/i);
    // Never customer-facing.
    expect(sendCustomerMessage).not.toHaveBeenCalled();
    expect(EmailService.send).not.toHaveBeenCalled();
    expect(AppointmentReminders.registerAppointment).not.toHaveBeenCalled();
  });

  test('gate off → no alert, no sender touched', async () => {
    delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    expect(await relayAlert.alertOwnerReservice(REQ, {})).toBe(false);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });

  test('fail-open: a send failure never throws (the ticket is already durable)', async () => {
    TwilioService.sendSMS.mockRejectedValueOnce(new Error('twilio down'));
    await expect(relayAlert.alertOwnerReservice(REQ, {})).resolves.toBe(false);
  });

  test('the body is bounded', () => {
    const body = relayAlert.buildReserviceAlert({ ...REQ, issue: 'x'.repeat(5000), subject: 'y'.repeat(5000) });
    expect(body.length).toBeLessThanOrEqual(relayAlert.MAX_ALERT_BODY);
  });

  // ⭐ A REDACTED-TIER (contact-slot) requester pages the owner about someone
  // ELSE's account. The warning is the SECOND line so neither the
  // MAX_ALERT_BODY slice nor the bell/push render can truncate it away.
  test('an unverified requester puts the warning on the alert\'s second line', async () => {
    const note = 'UNVERIFIED third-party requester — verify identity before confirming. The caller on ***0142 '
      + 'matched this account only on a secondary contact number (spouse, tenant, or a previous occupant), '
      + 'NOT the account holder\'s own number.';
    await relayAlert.alertOwnerReservice({ ...REQ, unverifiedRequester: true, unverifiedNote: note }, { callSid: 'CA-rs' });
    const body = TwilioService.sendSMS.mock.calls[0][1];
    expect(body.split('\n')[1]).toMatch(/^⚠️ UNVERIFIED third-party requester — verify identity before confirming\./);
    expect(body).toContain('***0142');
    expect(body).not.toContain('9415550142');
  });

  test('an unverified requester with no note still gets a warning line; a verified one gets none', () => {
    const fallback = relayAlert.buildReserviceAlert({ ...REQ, unverifiedRequester: true });
    expect(fallback.split('\n')[1]).toMatch(/UNVERIFIED third-party requester/);
    expect(relayAlert.buildReserviceAlert(REQ)).not.toMatch(/UNVERIFIED/);
  });

  test('the body stays bounded even with a long unverified note', () => {
    const body = relayAlert.buildReserviceAlert({
      ...REQ, issue: 'x'.repeat(5000), subject: 'y'.repeat(5000),
      unverifiedRequester: true, unverifiedNote: 'z'.repeat(5000),
    });
    expect(body.length).toBeLessThanOrEqual(relayAlert.MAX_ALERT_BODY);
    expect(body).toMatch(/UNVERIFIED|⚠️/);
  });
});

describe('capture_lead → alert wiring (the live path)', () => {
  beforeEach(() => { process.env.VOICE_RELAY_CONTEXT_ENABLED = 'true'; });

  test('hot capture_lead writes the lead FIRST, then alerts — never customer-facing', async () => {
    const out = await executeTool('capture_lead', {
      first_name: 'Pat', last_name: 'Rivera', call_summary: 'Swarming termites, urgent.',
      requested_service: 'termites', lead_quality: 'hot', urgency_reason: 'swarming right now',
    }, { from: CALLER, callSid: 'CA-live', markCaptured: jest.fn(), markOwnerAlerted: jest.fn() });

    expect(out).toMatch(/Lead saved successfully/);
    expect(createLeadFromExtraction).toHaveBeenCalledTimes(1);
    expect(TwilioService.sendSMS).toHaveBeenCalledTimes(1);
    assertNeverCustomerFacing();
  });

  test('an alert failure NEVER loses the lead or fails the tool', async () => {
    TwilioService.sendSMS.mockRejectedValue(new Error('bell down'));
    const out = await executeTool('capture_lead', {
      call_summary: 'Angry about a missed visit.', lead_quality: 'hot',
    }, { from: CALLER, callSid: 'CA-live-2', markCaptured: jest.fn() });
    expect(out).toMatch(/Lead saved successfully/);
    expect(createLeadFromExtraction).toHaveBeenCalledTimes(1);
  });

  // ⭐ THE MODEL ONLY PROMISES A PAGE THAT WENT OUT. The prompt lets her tell a
  // hot caller "a team member is being notified right away"; when the page did
  // not go out, the tool result is where she learns not to say it.
  test('a hot lead whose page FAILED gets the promise withdrawn in the tool result', async () => {
    TwilioService.sendSMS.mockRejectedValue(new Error('bell down'));
    const out = await executeTool('capture_lead', {
      call_summary: 'Angry about a missed visit.', lead_quality: 'hot',
    }, { from: CALLER, callSid: 'CA-live-3', markCaptured: jest.fn() });
    expect(out).toMatch(/could NOT be confirmed/i);
    expect(out).toMatch(/do NOT tell the caller a team member is being notified right away/i);
  });

  test('a DELIVERED page keeps the promise, and an already-paged call keeps it too', async () => {
    const delivered = await executeTool('capture_lead', {
      call_summary: 'Swarming termites.', lead_quality: 'hot',
    }, { from: CALLER, callSid: 'CA-live-4', markCaptured: jest.fn(), markOwnerAlerted: jest.fn() });
    expect(delivered).not.toMatch(/could NOT be confirmed/i);
    // Second capture on the SAME call: alertOwnerHotLead stands down on the
    // latch (returns false), but the earlier page was real — no withdrawal.
    const again = await executeTool('capture_lead', {
      call_summary: 'Swarming termites, more detail.', lead_quality: 'hot',
    }, { from: CALLER, callSid: 'CA-live-4', markCaptured: jest.fn(), isOwnerAlerted: () => true });
    expect(again).not.toMatch(/could NOT be confirmed/i);
  });

  test('a non-hot lead never carries the withdrawal (there was no promise)', async () => {
    TwilioService.sendSMS.mockRejectedValue(new Error('down'));
    const out = await executeTool('capture_lead', {
      call_summary: 'Just price shopping.', lead_quality: 'warm',
    }, { from: CALLER, callSid: 'CA-live-5', markCaptured: jest.fn() });
    expect(out).not.toMatch(/could NOT be confirmed/i);
  });

  test('a COLD capture_lead alerts nobody', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Just price shopping.', lead_quality: 'cold',
    }, { from: CALLER, callSid: 'CA-cold', markCaptured: jest.fn() });
    expect(createLeadFromExtraction).toHaveBeenCalledTimes(1);
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
    assertNeverCustomerFacing();
  });

  test('a SPAM capture_lead writes nothing and alerts nobody', async () => {
    const out = await executeTool('capture_lead', {
      call_summary: 'Robocall.', lead_quality: 'spam',
    }, { from: CALLER, callSid: 'CA-spam', markCaptured: jest.fn() });
    expect(out).toMatch(/Marked as spam/i);
    expect(createLeadFromExtraction).not.toHaveBeenCalled();
    expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  });
});
