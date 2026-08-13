/**
 * Voice-relay Phase E item 5 — CONSENT / CONTACT-PREFERENCE CAPTURE.
 *
 * The rule being tested: a caller's stated instruction ("call my husband
 * instead, not me", "email only") must LAND in the capture, and the agent must
 * NOT act on it — routing preferences are a human's call.
 *
 * ⭐ ONE EXCEPTION, ADDED AFTER REVIEW: an EXPLICIT do-not-contact request
 * ("stop texting me", "take me off your list") is honoured immediately,
 * through `recordSuppression` — the same canonical writer the inbound STOP
 * webhook uses. Consent is withdrawn the moment the caller says it, and every
 * automated SMS path between the call and whenever a human opens the lead
 * would otherwise still treat them as contactable. That write is
 * one-directional: it can only STOP messages, never start them.
 *
 * Matrix:
 *   - the capture_lead schema carries the field trio, using the SAME
 *     vocabulary as the existing call-extraction schemas
 *   - a stated preference persists into the lead (extracted_data + the
 *     ai_triage activity metadata)
 *   - saying nothing about contact preference writes nothing (a later
 *     preference-free call can never erase a recorded instruction)
 *   - the LEAD PIPELINE still writes no suppression / opt-out / messaging-
 *     preference state of its own (the tool layer owns the one exception)
 *   - no customer-facing comms
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../utils/lead-service-interest', () => ({ composeServiceInterest: jest.fn(() => null) }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/email', () => ({ send: jest.fn() }));
// The INTERNAL admin feed an existing customer's stated instruction lands on
// (the same NotificationService the re-service lane files to). Internal only —
// it is a bell/push entry for a human, never a customer-facing send.
jest.mock('../services/notification-service', () => ({ notifyAdmin: jest.fn(async () => ({ id: 'n-1' })) }));
// The canonical suppression writer (the inbound STOP webhook's own).
jest.mock('../services/messaging/validators/suppression', () => ({ recordSuppression: jest.fn(async () => ({ ok: true })) }));
// capture_lead's internal owner alert — covered by voice-relay-alert.test.js.
jest.mock('../services/voice-agent/relay-alert', () => ({ alertOwnerHotLead: jest.fn(async () => false) }));

const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailService = require('../services/email');

const { recordSuppression } = require('../services/messaging/validators/suppression');

const { createLeadFromExtraction, contactPreferenceFields } = require('../services/lead-from-extraction');
const { TOOLS, executeTool } = require('../services/voice-agent/relay-tools');

// Synthetic fixtures only.
const CALLER = '+19415550142';
const LEAD_ID = 'lead-777';

// Columns/tables that would mean the agent ACTED on a preference rather than
// capturing it. Any write touching one of these fails the test.
const SUPPRESSION_TABLES = ['sms_opt_outs', 'suppressions', 'communication_preferences', 'contact_preferences', 'waves_consent'];
const SUPPRESSION_COLUMNS = [
  'sms_opt_out', 'sms_opt_in', 'do_not_contact', 'do_not_text', 'do_not_email',
  'email_opt_out', 'unsubscribed', 'unsubscribed_at', 'marketing_opt_out',
  'preferred_contact_method', 'quiet_hours_start', 'quiet_hours_end', 'sms_consent',
];

const writes = [];
function makeBuilder(table, rows) {
  const b = {};
  for (const m of ['where', 'whereNull', 'whereIn', 'whereNot', 'orderBy', 'select', 'limit', 'whereRaw', 'orWhereRaw']) b[m] = jest.fn(() => b);
  b.first = jest.fn(() => Promise.resolve(rows[0] || null));
  b.then = (resolve, reject) => Promise.resolve(rows).then(resolve, reject);
  b.insert = jest.fn((payload) => { writes.push({ table, verb: 'insert', payload }); return b; });
  b.update = jest.fn((payload) => { writes.push({ table, verb: 'update', payload }); return Promise.resolve(1); });
  b.returning = jest.fn(() => Promise.resolve([{ id: LEAD_ID }]));
  b.del = jest.fn(() => { writes.push({ table, verb: 'del' }); return Promise.resolve(1); });
  b.catch = (fn) => Promise.resolve(rows).catch(fn);
  return b;
}

let tables;
// An existing lead for this phone number — the merge tests set it so the
// "second capture_lead" (or a call next week, since leads resolve BY PHONE)
// path is exercised rather than the fresh-insert path.
let existingLead = null;
function primeDb() {
  writes.length = 0;
  tables = {
    customers: makeBuilder('customers', []),
    leads: makeBuilder('leads', existingLead ? [existingLead] : []),
    lead_activities: makeBuilder('lead_activities', []),
    lead_sources: makeBuilder('lead_sources', []),
  };
  db.mockImplementation((table) => {
    if (!tables[table]) tables[table] = makeBuilder(table, []);
    return tables[table];
  });
}

function assertNoSuppressionWrite() {
  for (const w of writes) {
    expect(SUPPRESSION_TABLES).not.toContain(w.table);
    const keys = Object.keys(w.payload || {});
    for (const col of SUPPRESSION_COLUMNS) expect(keys).not.toContain(col);
  }
  expect(TwilioService.sendSMS).not.toHaveBeenCalled();
  expect(sendCustomerMessage).not.toHaveBeenCalled();
  expect(EmailService.send).not.toHaveBeenCalled();
}

function leadUpdate() {
  const w = writes.find((x) => x.table === 'leads' && x.verb === 'update');
  return w ? w.payload : null;
}

beforeEach(() => {
  jest.clearAllMocks();
  existingLead = null;
  primeDb();
});

describe('capture_lead schema — the field trio, in the existing vocabulary', () => {
  const schema = TOOLS.find((t) => t.name === 'capture_lead').input_schema;

  test('carries contact_preference / preferred_contact_method / do_not_contact_request', () => {
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining([
      'contact_preference', 'preferred_contact_method', 'do_not_contact_request',
    ]));
    expect(schema.properties.do_not_contact_request.type).toBe('boolean');
    // Same enum as caller.preferred_contact_method in the call-extraction schemas.
    expect(schema.properties.preferred_contact_method.enum).toEqual(['phone', 'sms', 'email', 'unspecified']);
  });

  test('the schema tells the model to capture verbatim and NOT to act', () => {
    expect(schema.properties.contact_preference.description).toMatch(/own words/i);
    expect(schema.properties.do_not_contact_request.description).toMatch(/do not act on this yourself/i);
    // The field trio stays OPTIONAL — a caller who says nothing is normal.
    expect(schema.required).toEqual(['call_summary']);
  });

  test('the field names match the call-extraction schemas\' existing consent shape', () => {
    const modelOutput = require('../schemas/call-extraction.model-output.schema.json');
    const persisted = require('../schemas/call-extraction.persisted.schema.json');
    for (const doc of [modelOutput, persisted]) {
      expect(doc.properties.consent.properties).toHaveProperty('do_not_contact_request');
      expect(doc.properties.caller.properties).toHaveProperty('preferred_contact_method');
    }
    // …and those schemas are NOT extended by this lane (a new key there bumps
    // the extraction contract hash and re-cohorts the promotion gate).
    expect(modelOutput.properties.caller.properties).not.toHaveProperty('contact_preference');
    expect(persisted.properties.caller.properties).not.toHaveProperty('contact_preference');
  });
});

describe('normalization', () => {
  test('nothing stated → null (a later payload can never blank a recorded instruction)', () => {
    expect(contactPreferenceFields({})).toBeNull();
    expect(contactPreferenceFields({ contact_preference: '   ', preferred_contact_method: 'carrier pigeon' })).toBeNull();
    expect(contactPreferenceFields({ do_not_contact_request: false })).toBeNull();
  });

  test('a stated preference normalizes; an unrecognized method degrades to null, not garbage', () => {
    expect(contactPreferenceFields({
      contact_preference: '  Stop texting me, call the house line  ',
      preferred_contact_method: 'PHONE',
      do_not_contact_request: false,
    })).toEqual({
      contact_preference: 'Stop texting me, call the house line',
      preferred_contact_method: 'phone',
      do_not_contact_request: false,
    });
    expect(contactPreferenceFields({ contact_preference: 'email only', preferred_contact_method: 'pigeon' }))
      .toEqual({ contact_preference: 'email only', preferred_contact_method: null, do_not_contact_request: false });
  });

  test('a do-not-contact request alone is enough to record', () => {
    expect(contactPreferenceFields({ do_not_contact_request: true })).toMatchObject({ do_not_contact_request: true });
  });

  test('a long instruction is bounded', () => {
    const out = contactPreferenceFields({ contact_preference: 'x'.repeat(1000) });
    expect(out.contact_preference.length).toBe(300);
  });
});

// ⭐ "UNCLAIMED" IS NOT "OURS". Leads resolve by phone; on an authenticated
// call the phone may be an ALTERNATE callback number, and a customer_id-NULL
// lead on that number is the record of whoever owns it calling in as their own
// prospect. Reusing it would assign it to the authenticated caller and
// overwrite its rolling fields. The caller's OWN ANI keeps its history.
describe('authenticated caller + alternate callback number — lead reuse boundary', () => {
  const ANI = '+19415550142';
  const ALTERNATE = '+19415550777';

  test('an unclaimed lead on an ALTERNATE number is NOT reused — a fresh lead is created', async () => {
    existingLead = { id: 'lead-spouse', phone: ALTERNATE, customer_id: null, first_name: 'Dana' };
    primeDb();
    // The authenticated identity must RESOLVE for the guard to be in play.
    tables.customers = makeBuilder('customers', [{ id: 'c-777', pipeline_stage: 'new_lead', first_name: 'Pat' }]);
    await createLeadFromExtraction(
      { call_summary: 'Booked; callback on spouse line.' },
      { phone: ALTERNATE, aniPhone: ANI, identityCustomerId: 'c-777', callSid: 'CA-alt-1' },
    );
    // A SEPARATE lead was inserted — Dana's was explicitly not reused. (The
    // update that follows targets the FRESH row: linking the caller's own new
    // lead to their own account is the point; the flat builder just cannot
    // show which row an update aimed at, so the reuse refusal is pinned by the
    // insert + the guard's own log line.)
    expect(writes.find((w) => w.table === 'leads' && w.verb === 'insert')).toBeTruthy();
    const logger = require('../services/logger');
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/not reusing it for the authenticated caller/i));
  });

  test('an unclaimed lead on the caller\'s OWN ANI is still reused (their pre-customer history)', async () => {
    existingLead = { id: 'lead-own', phone: ANI, customer_id: null, first_name: null };
    primeDb();
    tables.customers = makeBuilder('customers', [{ id: 'c-777', pipeline_stage: 'new_lead', first_name: 'Pat' }]);
    await createLeadFromExtraction(
      { call_summary: 'Existing prospect calling back.' },
      { phone: ANI, aniPhone: ANI, identityCustomerId: 'c-777', callSid: 'CA-own-1' },
    );
    expect(writes.find((w) => w.table === 'leads' && w.verb === 'insert')).toBeFalsy();
    expect(leadUpdate()).toBeTruthy(); // reused + updated in place
  });
});

describe('persistence through the lead pipeline', () => {
  test('a stated preference lands in extracted_data AND the ai_triage activity — no suppression write', async () => {
    await createLeadFromExtraction({
      first_name: 'Pat', call_summary: 'Wants a quote; asked us to stop texting.',
      contact_preference: 'Stop texting me — call my husband Dave instead, not me',
      preferred_contact_method: 'phone',
      do_not_contact_request: false,
    }, { phone: CALLER, callSid: 'CA-consent-1' });

    const extracted = JSON.parse(leadUpdate().extracted_data);
    expect(extracted).toMatchObject({
      source: 'voice_agent',
      contact_preference: 'Stop texting me — call my husband Dave instead, not me',
      preferred_contact_method: 'phone',
      do_not_contact_request: false,
    });

    const activity = writes.find((w) => w.table === 'lead_activities' && w.verb === 'insert');
    expect(JSON.parse(activity.payload.metadata)).toMatchObject({
      contact_preference: 'Stop texting me — call my husband Dave instead, not me',
    });

    assertNoSuppressionWrite();
  });

  test('an explicit do-not-contact request is RECORDED, never actioned', async () => {
    await createLeadFromExtraction({
      call_summary: 'Asked to be taken off the list.',
      contact_preference: 'take me off your list, do not contact me again',
      do_not_contact_request: true,
    }, { phone: CALLER });

    expect(JSON.parse(leadUpdate().extracted_data)).toMatchObject({ do_not_contact_request: true });
    // The ONLY customer-row write this module makes stays the language hint.
    for (const w of writes.filter((x) => x.table === 'customers')) {
      expect(Object.keys(w.payload)).toEqual(['preferred_language']);
    }
    assertNoSuppressionWrite();
  });

  test('no preference stated → the keys are absent, and the legacy payload is unchanged', async () => {
    await createLeadFromExtraction({
      call_summary: 'General pest question.', pain_points: 'ants', preferred_date_time: 'next Tuesday',
    }, { phone: CALLER, language: 'en' });

    const extracted = JSON.parse(leadUpdate().extracted_data);
    expect(extracted).toEqual({
      pain_points: 'ants', preferred_date_time: 'next Tuesday', source: 'voice_agent', language: 'en',
    });
    expect(extracted).not.toHaveProperty('contact_preference');
    expect(extracted).not.toHaveProperty('do_not_contact_request');
    assertNoSuppressionWrite();
  });
});

// ⭐ A STATED INSTRUCTION MUST SURVIVE THE NEXT capture_lead. The lead is
// resolved BY PHONE, so "the next payload" is not only the second tool call on
// this call — it is also a call NEXT WEEK from the same number.
describe('extracted_data is MERGED, not replaced', () => {
  test('a second, preference-free capture does not erase the recorded instruction', async () => {
    existingLead = {
      id: LEAD_ID,
      extracted_data: JSON.stringify({
        source: 'voice_agent',
        pain_points: 'ants',
        contact_preference: 'stop texting me',
        preferred_contact_method: 'phone',
        do_not_contact_request: true,
      }),
    };
    primeDb();
    await createLeadFromExtraction(
      { call_summary: 'Called back about scheduling.' },
      { phone: CALLER, callSid: 'CA-consent-merge' },
    );
    const extracted = JSON.parse(leadUpdate().extracted_data);
    expect(extracted).toMatchObject({
      contact_preference: 'stop texting me',
      preferred_contact_method: 'phone',
      do_not_contact_request: true,
      pain_points: 'ants', // fill-forward, not nulled out
    });
    assertNoSuppressionWrite();
  });

  test('do_not_contact_request is STICKY-ON — a later payload may set it, never clear it', async () => {
    existingLead = { id: LEAD_ID, extracted_data: JSON.stringify({ do_not_contact_request: true }) };
    primeDb();
    await createLeadFromExtraction(
      { call_summary: 'Wants a quote.', preferred_contact_method: 'email' },
      { phone: CALLER },
    );
    const extracted = JSON.parse(leadUpdate().extracted_data);
    expect(extracted.do_not_contact_request).toBe(true);
    expect(extracted.preferred_contact_method).toBe('email'); // new detail still lands
  });

  test('a first capture with no prior data still records the explicit false', async () => {
    existingLead = null;
    await createLeadFromExtraction(
      { call_summary: 'Quote.', contact_preference: 'email only', preferred_contact_method: 'email' },
      { phone: CALLER },
    );
    expect(JSON.parse(leadUpdate().extracted_data).do_not_contact_request).toBe(false);
  });

  test('unparseable / non-object prior extracted_data degrades to an empty merge base', async () => {
    existingLead = { id: LEAD_ID, extracted_data: 'not json at all' };
    primeDb();
    await createLeadFromExtraction({ call_summary: 'Quote.' }, { phone: CALLER });
    expect(() => JSON.parse(leadUpdate().extracted_data)).not.toThrow();
    expect(JSON.parse(leadUpdate().extracted_data)).toMatchObject({ source: 'voice_agent' });
  });
});

// ⭐ AN EXISTING LIFECYCLE CUSTOMER HAS NO LEAD TO RECORD IT ON. The writer
// returns early for them (an ordinary support call must not reopen a won
// customer as a lead), which took the whole captured instruction with it — a
// caller who said "stop texting me" was answered "saved" and nothing was kept.
// Nothing here writes consent or suppression state; the instruction is
// SURFACED to a human on the same internal admin feed the re-service lane uses.
describe('existing-customer contact instructions still reach a human', () => {
  const NotificationService = require('../services/notification-service');
  const LIFECYCLE = { id: 'c-777', pipeline_stage: 'active_customer', first_name: 'Pat' };

  beforeEach(() => {
    primeDb();
    tables.customers = makeBuilder('customers', [LIFECYCLE]);
    NotificationService.notifyAdmin.mockClear();
    NotificationService.notifyAdmin.mockResolvedValue({ id: 'n-1' });
  });

  test('a DO-NOT-CONTACT request from a lifecycle customer is surfaced, not dropped', async () => {
    const out = await createLeadFromExtraction(
      { call_summary: 'Asked us to stop texting.', do_not_contact_request: true },
      { phone: CALLER, callSid: 'CA-dnc-1' },
    );
    expect(out).toMatchObject({ leadId: null, customerId: 'c-777' }); // still no lead work
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, title, body, opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toMatch(/DO-NOT-CONTACT request/i);
    expect(body).toMatch(/Nothing was changed automatically/i);
    expect(opts.metadata).toMatchObject({ customerId: 'c-777', do_not_contact_request: true, source: 'voice_agent' });
    expect(opts.link).toContain('c-777');
    // Still no suppression/consent write anywhere, and nothing customer-facing.
    assertNoSuppressionWrite();
  });

  // ⭐ THE ALERT TELLS THE TRUTH ABOUT WHAT ALREADY HAPPENED. The agent applies
  // an explicit verified SMS opt-out itself; telling staff "nothing was
  // changed" over a suppression that already landed reports a false compliance
  // state in the exact place they check it.
  test('when the SMS opt-out already landed, the alert says so — not "nothing was changed"', async () => {
    await createLeadFromExtraction(
      { call_summary: 'Asked us to stop texting.', do_not_contact_request: true },
      { phone: CALLER, callSid: 'CA-dnc-applied', smsSuppressionApplied: true },
    );
    const [, , body] = NotificationService.notifyAdmin.mock.calls[0];
    expect(body).toMatch(/ALREADY STOPPED/i);
    expect(body).not.toMatch(/Nothing was changed automatically/i);
    expect(body).toMatch(/still needs a human/i); // the email half stays theirs
  });

  test('when no suppression landed, the alert still says nothing was changed', async () => {
    await createLeadFromExtraction(
      { call_summary: 'Asked us to stop contacting them.', do_not_contact_request: true },
      { phone: CALLER, callSid: 'CA-dnc-unapplied', smsSuppressionApplied: false },
    );
    const [, , body] = NotificationService.notifyAdmin.mock.calls[0];
    expect(body).toMatch(/Nothing was changed automatically/i);
    expect(body).not.toMatch(/ALREADY STOPPED/i);
  });

  // ⭐ THE ROW IS THE ONLY ARTIFACT, SO IT MUST BEAT THE BELL POLICY. The admin
  // bell policy silences the 'service' category by default when it is on, and
  // its suppression sentinel is TRUTHY (`{ id: null, suppressed: true }`) —
  // read at face value, a lifecycle customer's "email only" would vanish
  // without a sound and this function would log it as surfaced.
  test('the feed row carries bell:true — a consent instruction is never policy-silenced', async () => {
    await createLeadFromExtraction(
      { call_summary: 'Asked us to stop texting.', do_not_contact_request: true },
      { phone: CALLER, callSid: 'CA-dnc-2' },
    );
    const [, , , opts] = NotificationService.notifyAdmin.mock.calls[0];
    expect(opts.bell).toBe(true);
  });

  test('a truthy SUPPRESSED sentinel is treated as not-persisted, not success', async () => {
    const logger = require('../services/logger');
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true, reason: 'bell_policy' });
    await createLeadFromExtraction(
      { call_summary: 'Asked us to stop texting.', do_not_contact_request: true },
      { phone: CALLER, callSid: 'CA-dnc-3' },
    );
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/did NOT persist to the admin feed/i));
  });

  test('a lifecycle customer who stated NO preference triggers no notification', async () => {
    await createLeadFromExtraction({ call_summary: 'Just asking about the last visit.' }, { phone: CALLER });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
  });

  // ⭐ A FAILED COMPLIANCE ARTIFACT GETS A RETRY RAIL. The feed row is the ONLY
  // structured artifact on this no-lead path — when it fails to persist, a
  // durable obligation marker lands on the call's own call_log row so the
  // hourly sweep can re-file it; success stamps nothing.
  const stampWrites = () => writes.filter((w) => w.table === 'call_log' && w.verb === 'update'
    && JSON.stringify((w.payload && w.payload.metadata && w.payload.metadata.bindings) || '').includes('relay_contact_instruction_needed'));

  const clearWrites = () => writes.filter((w) => w.table === 'call_log' && w.verb === 'update'
    && String((w.payload && w.payload.metadata && w.payload.metadata.sql) || '').includes("- 'relay_contact_instruction_needed'"));

  // ⭐ OBLIGATIONS BEFORE COMMITS (the hot-alert doctrine): the marker lands
  // BEFORE the fallible notifyAdmin attempt, so a stall or process exit
  // mid-attempt still leaves the sweep something to find.
  test('the obligation marker is stamped BEFORE the delivery attempt and retained on failure', async () => {
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    let stampsAtNotifyTime = -1;
    NotificationService.notifyAdmin.mockImplementation(async () => {
      stampsAtNotifyTime = stampWrites().length;
      throw new Error('bell down');
    });
    await createLeadFromExtraction(
      { call_summary: 'Asked us to stop texting.', do_not_contact_request: true },
      { phone: CALLER, callSid: 'CA-dnc-stamp', smsSuppressionApplied: true },
    );
    expect(stampsAtNotifyTime).toBe(1); // already durable when delivery ran
    const stamps = stampWrites();
    expect(stamps).toHaveLength(1);
    const payload = JSON.parse(stamps[0].payload.metadata.bindings[0]);
    expect(payload.relay_contact_instruction_needed).toBe('true');
    expect(payload.relay_contact_instruction).toMatchObject({
      customerId: 'c-777', do_not_contact_request: true, smsSuppressionApplied: true,
    });
    expect(clearWrites()).toHaveLength(0); // failure keeps the marker
  });

  test('the suppressed sentinel clears the pre-stamped marker — deliberate zero-artifact', async () => {
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true, reason: 'internal_test' });
    await createLeadFromExtraction(
      { call_summary: 'Asked us to stop texting.', do_not_contact_request: true },
      { phone: CALLER, callSid: 'CA-dnc-stamp2' },
    );
    expect(stampWrites()).toHaveLength(1);
    expect(clearWrites()).toHaveLength(1);
  });

  test('a SUCCESSFUL feed write clears its pre-stamped marker', async () => {
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    await createLeadFromExtraction(
      { call_summary: 'Asked us to stop texting.', do_not_contact_request: true },
      { phone: CALLER, callSid: 'CA-dnc-ok' },
    );
    expect(stampWrites()).toHaveLength(1);
    expect(clearWrites()).toHaveLength(1);
  });

  test('the hourly sweep re-files the instruction and clears the marker on success', async () => {
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    const { sweepUnsurfacedContactInstructions } = require('../services/lead-from-extraction');
    tables.call_log = makeBuilder('call_log', [{
      id: 'cl-9', twilio_call_sid: 'CA-dnc-swept',
      metadata: {
        relay_contact_instruction_needed: 'true',
        relay_contact_instruction: { customerId: 'c-777', do_not_contact_request: true, smsSuppressionApplied: false },
      },
    }]);
    const out = await sweepUnsurfacedContactInstructions();
    expect(out).toMatchObject({ scanned: 1, recovered: 1 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1);
    const [, title] = NotificationService.notifyAdmin.mock.calls[0];
    expect(title).toMatch(/DO-NOT-CONTACT request/i);
    // Cleared via the jsonb key-removal raw — and NOT re-stamped.
    const clears = writes.filter((w) => w.table === 'call_log' && w.verb === 'update'
      && String((w.payload && w.payload.metadata && w.payload.metadata.sql) || '').includes("- 'relay_contact_instruction_needed'"));
    expect(clears).toHaveLength(1);
    expect(stampWrites()).toHaveLength(0);
  });

  // ⭐ THE MARKER OUTLIVES ANY OUTAGE — no attempt cap ever clears it. A high
  // attempt count keeps retrying; only success or a deliberate suppression
  // (or a deleted customer) clears the obligation.
  test('a marker with hundreds of failed attempts is retained and retried, never discarded', async () => {
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    NotificationService.notifyAdmin.mockRejectedValue(new Error('still down'));
    const { sweepUnsurfacedContactInstructions } = require('../services/lead-from-extraction');
    tables.call_log = makeBuilder('call_log', [{
      id: 'cl-9', twilio_call_sid: 'CA-dnc-swept',
      metadata: {
        relay_contact_instruction_needed: 'true',
        relay_contact_instruction: { customerId: 'c-777', do_not_contact_request: true },
        relay_contact_instruction_attempts: 480,
      },
    }]);
    const out = await sweepUnsurfacedContactInstructions();
    expect(out).toMatchObject({ scanned: 1, recovered: 0 });
    expect(NotificationService.notifyAdmin).toHaveBeenCalledTimes(1); // still trying
    const clears = writes.filter((w) => w.table === 'call_log' && w.verb === 'update'
      && String((w.payload && w.payload.metadata && w.payload.metadata.sql) || '').includes("- 'relay_contact_instruction_needed'"));
    expect(clears).toHaveLength(0); // never discarded
  });

  test('a sweep retry suppressed by policy clears the marker — deliberate, not a give-up', async () => {
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    NotificationService.notifyAdmin.mockResolvedValue({ id: null, suppressed: true, reason: 'internal_test' });
    const { sweepUnsurfacedContactInstructions } = require('../services/lead-from-extraction');
    tables.call_log = makeBuilder('call_log', [{
      id: 'cl-9', twilio_call_sid: 'CA-dnc-swept',
      metadata: {
        relay_contact_instruction_needed: 'true',
        relay_contact_instruction: { customerId: 'c-777', do_not_contact_request: true },
      },
    }]);
    const out = await sweepUnsurfacedContactInstructions();
    expect(out).toMatchObject({ scanned: 1, recovered: 0 });
    const clears = writes.filter((w) => w.table === 'call_log' && w.verb === 'update'
      && String((w.payload && w.payload.metadata && w.payload.metadata.sql) || '').includes("- 'relay_contact_instruction_needed'"));
    expect(clears).toHaveLength(1);
  });

  test('a sweep retry that fails again bumps the attempt count instead of re-stamping', async () => {
    db.raw = jest.fn((sql, bindings) => ({ sql, bindings }));
    NotificationService.notifyAdmin.mockRejectedValue(new Error('still down'));
    const { sweepUnsurfacedContactInstructions } = require('../services/lead-from-extraction');
    tables.call_log = makeBuilder('call_log', [{
      id: 'cl-9', twilio_call_sid: 'CA-dnc-swept',
      metadata: {
        relay_contact_instruction_needed: 'true',
        relay_contact_instruction: { customerId: 'c-777', do_not_contact_request: true },
      },
    }]);
    const out = await sweepUnsurfacedContactInstructions();
    expect(out).toMatchObject({ scanned: 1, recovered: 0 });
    expect(stampWrites()).toHaveLength(0);
    const bumps = writes.filter((w) => w.table === 'call_log' && w.verb === 'update'
      && JSON.stringify((w.payload && w.payload.metadata && w.payload.metadata.bindings) || '').includes('relay_contact_instruction_attempts'));
    expect(bumps).toHaveLength(1);
  });

  test('a notification failure never surfaces to the caller (fail-open)', async () => {
    NotificationService.notifyAdmin.mockRejectedValue(new Error('bell down'));
    await expect(createLeadFromExtraction(
      { call_summary: 'Stop texting me.', do_not_contact_request: true },
      { phone: CALLER },
    )).resolves.toMatchObject({ leadId: null });
  });
});

describe('the prompt says capture, not act', () => {
  const { buildBasePrompt } = require('../services/voice-agent/relay-conversation');

  test('gate-on prompt: capture everything; confirm ONLY a tool-confirmed SMS stop', () => {
    const p = buildBasePrompt(true);
    expect(p).toContain('contact_preference');
    // The one system-applied change is the verified SMS stop — and only when
    // the tool result SAYS it applied; everything else stays a human's.
    expect(p).toMatch(/ONLY when the capture_lead result explicitly says/i);
    expect(p).toMatch(/If it does not say so.*you cannot change it/is);
    expect(p).toMatch(/made a note of that for the team/i);
  });
});

// ⭐ THE ONE CONSENT WRITE THE AGENT MAKES. A verbal "stop texting me" is a
// withdrawal of consent the moment it is said; filing it in a JSON blob for a
// human to notice later leaves every automated SMS path treating the caller as
// contactable in the meantime. It goes through recordSuppression — the same
// writer the inbound STOP webhook uses — and only ever in the stop direction.
describe('capture_lead honours an explicit do-not-contact request', () => {
  const savedGate = process.env.VOICE_RELAY_CONTEXT_ENABLED;
  afterAll(() => {
    if (savedGate === undefined) delete process.env.VOICE_RELAY_CONTEXT_ENABLED;
    else process.env.VOICE_RELAY_CONTEXT_ENABLED = savedGate;
  });

  // callerVerified: the setup-frame ANI matched the signature-verified /voice
  // call_log row. Suppression is the one write keyed on the calling number
  // alone, so it requires that boundary (an unverified test below proves it).
  const CTX = { callSid: 'CA-consent-tool', from: CALLER, to: '+19415559999', callerVerified: true };

  test('do_not_contact_request true → suppression recorded for the CALLER\'s number', async () => {
    await executeTool('capture_lead', {
      first_name: 'Pat',
      call_summary: 'Asked to be taken off the list.',
      contact_preference: 'take me off your list, do not contact me again',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({
      phone: CALLER,
      reason: 'opt_out_natural_language',
      source: 'voice_agent',
    }));
  });

  // ⭐ THE NUMBER THAT OPTED OUT, NOT THE CALLBACK. The lead's callback_phone
  // is the number to REACH them on — the schema's own example is "stop texting
  // me, call my husband instead" — so suppressing it would silence the husband
  // and leave the caller's own texts running.
  test('a callback_phone override never becomes the suppressed number', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Stop texting me; call my husband instead.',
      contact_preference: 'stop texting me, call my husband Dave',
      callback_phone: '+19415557777',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
    expect(recordSuppression).not.toHaveBeenCalledWith(expect.objectContaining({ phone: '+19415557777' }));
  });

  // ⭐ ROUTED BY CHANNEL. The write is phone-keyed — it stops TEXTS. Applying it
  // to "stop emailing me" would silence appointment reminders the caller never
  // asked to stop, while the email they DID ask about kept sending.
  test('an EMAIL-ONLY opt-out writes no SMS suppression and is left for a human', async () => {
    const logger = require('../services/logger');
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop emailing.',
      contact_preference: 'stop emailing me, I get too many',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/NOT an unambiguous SMS stop/));
  });

  test('a GENERAL "stop contacting me" still takes the SMS suppression, email half flagged', async () => {
    const logger = require('../services/logger');
    await executeTool('capture_lead', {
      call_summary: 'Asked to be left alone entirely.',
      contact_preference: 'stop contacting me — no calls, no texts, no email',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/SMS suppression recorded/));
    expect(logger.info).toHaveBeenCalledWith(expect.stringMatching(/EMAIL: that opt-out is NOT applied here/));
  });

  // ⭐ NEVER THE CHANNEL THEY ASKED FOR. "Stop emailing me; text me instead"
  // names SMS as the WANTED channel — suppressing it silences exactly what the
  // caller chose.
  // ⭐ MORE THAN ONE STOP CLAUSE. The SMS withdrawal can be the SECOND one.
  test('"don\'t email me, don\'t text me" suppresses SMS (both clauses are read)', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Wants no contact at all.',
      contact_preference: "don't email me, don't text me",
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  test('"stop emailing me, text me instead" never suppresses SMS', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Prefers texts.',
      contact_preference: 'stop emailing me, contact me by text instead',
      preferred_contact_method: 'sms',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  // ⭐ THE MIRROR CASE. Same words, different clauses, opposite meanings — an
  // explicit text withdrawal must survive whatever replacement channel follows.
  // ⭐ DESCRIPTIVE ABSENCE IS NOT A WITHDRAWAL. "I received no texts" is a
  // complaint that reminders did NOT arrive — suppressing on it would disable
  // the very texts the caller wants.
  test('complaints about ABSENT texts never suppress', async () => {
    for (const words of [
      'I received no texts about the appointment',
      'no text messages came through yesterday',
      'there were no texts, can you check',
      // never/no-longer + a RECEIPT verb = a delivery complaint, not a stop.
      'I never received your text',
      'I no longer receive texts from you',
    ]) {
      jest.clearAllMocks();
      await executeTool('capture_lead', {
        call_summary: 'Says reminders are not arriving.',
        contact_preference: words,
        do_not_contact_request: false,
      }, CTX);
      expect(recordSuppression).not.toHaveBeenCalled();
    }
  });

  test('"no calls, text me instead" negates the CALL channel only — no suppression', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Prefers texts.',
      contact_preference: 'no calls, text me instead',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  test('"stop texting me; call my husband instead" DOES suppress SMS', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting and call the husband.',
      contact_preference: 'stop texting me; call my husband Dave instead',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  // ⭐ THE CALLER'S WORDS ARE THE TRIGGER, NOT A BOX THE MODEL TICKS.
  // `do_not_contact_request` is an optional field filled in at the model's
  // discretion; a caller who says "stop texting me" has withdrawn consent
  // whether or not it remembered, and TCPA does not care which field the
  // transcriber preferred.
  test('an explicit verbal stop suppresses even with do_not_contact_request MISSING', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting.',
      contact_preference: 'stop texting me',
      // no do_not_contact_request at all
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  test('an explicit verbal stop suppresses even with the flag explicitly FALSE', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting.',
      contact_preference: 'never text me again',
      do_not_contact_request: false,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  // ⭐ AND THE RECORD AGREES WITH THE ACTION. The classifier is the trigger, so
  // the persisted lead data must say what actually happened — a caller whose
  // "stop texting me" was honoured must never be filed with
  // do_not_contact_request:false while the canonical suppression is live.
  test('the honoured opt-out is persisted as do_not_contact_request:true, not the model\'s false', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting.',
      contact_preference: 'stop texting me',
      do_not_contact_request: false,
    }, CTX);
    const update = leadUpdate();
    expect(update).toBeTruthy();
    expect(JSON.parse(update.extracted_data)).toMatchObject({ do_not_contact_request: true });
  });

  test('an explicitly STATED "stop texting me" does suppress SMS', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting.',
      contact_preference: 'stop texting me please',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  test('"remove my number" / "don\'t bother me anymore" / "leave me alone" are total stops too', async () => {
    // "leave me alone" was recognised by the total-stop test and could never
    // REACH it — clauses only exist where a stop verb matches, and it was not
    // one. The plainest total opt-out in the list recorded nothing.
    // "remove my PHONE NUMBER" is the same request with one more word — and a
    // bare \bphone\b veto read that word as call-channel scoping and left the
    // texts running. "Phone" only scopes a stop to CALLS when it is not the
    // noun-phrase "phone number".
    for (const words of [
      'remove my number from your system', "don't bother me anymore", 'leave me alone', 'just leave us alone',
      'remove my phone number from your list', 'take my phone number off your list',
      // The formal registers of the same total withdrawal.
      'stop all communications', 'do not communicate with me',
    ]) {
      jest.clearAllMocks();
      await executeTool('capture_lead', {
        call_summary: 'Asked to be left alone.',
        contact_preference: words,
        do_not_contact_request: true,
      }, CTX);
      expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
    }
  });

  // ⭐ THE PHRASING PEOPLE BORROW FROM THE MESSAGES THEMSELVES. "Opt me out"
  // and "no longer" are as explicit a withdrawal as "stop", and matched no stop
  // verb at all — so the request read as "no channel named" and the texts the
  // caller had just withdrawn kept sending.
  test('"opt me out of texts" / "no longer want texts" / "never text me" suppress SMS', async () => {
    for (const words of [
      'opt me out of texts',
      'please opt out of your text messages',
      'I no longer want texts',
      'never text me again',
      // Bare channel negation — no stop verb at all (imperative position).
      'no texts',
      'no text messages please',
      'no SMS to this number',
      'please no more texts',
    ]) {
      jest.clearAllMocks();
      await executeTool('capture_lead', {
        call_summary: 'Asked to be taken off texts.',
        contact_preference: words,
        do_not_contact_request: true,
      }, CTX);
      expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
    }
  });

  // ⭐ A NEGATED STOP IS A REQUEST TO CONTINUE. "Don't stop texting me" begins
  // with a stop verb and contains a texting word — read naively it classified
  // as an SMS withdrawal and silenced exactly the channel the caller asked to
  // KEEP. The negation pair is neutralized before clause extraction, so
  // neither the outer nor the inner verb can seed a stop clause.
  test('"don\'t stop texting me" / "never stop the reminders" never suppress', async () => {
    for (const words of [
      "don't stop texting me",
      'never stop texting me, I like the reminders',
      'do not stop the text reminders',
      "don't ever stop texting me",
    ]) {
      jest.clearAllMocks();
      await executeTool('capture_lead', {
        call_summary: 'Wants to KEEP the texts.',
        contact_preference: words,
        do_not_contact_request: false,
      }, CTX);
      expect(recordSuppression).not.toHaveBeenCalled();
    }
  });

  // ⭐ THE NEGATION CAN SIT INTENT WORDS AWAY FROM THE VERB. "I don't WANT TO
  // stop receiving texts" negates the stop as surely as "don't stop texting
  // me" — the un-neutralized inner "stop … texts" classified as a withdrawal
  // of the channel the caller explicitly asked to keep.
  test('a negated opt-in with intent words ("don\'t want to stop…") never suppresses', async () => {
    for (const words of [
      "I don't want to stop receiving texts",
      'I do not wish to stop the reminders',
      "we don't want to opt out of texts",
      "I never intended to stop the text reminders",
    ]) {
      jest.clearAllMocks();
      await executeTool('capture_lead', {
        call_summary: 'Wants to KEEP the texts.',
        contact_preference: words,
        do_not_contact_request: false,
      }, CTX);
      expect(recordSuppression).not.toHaveBeenCalled();
    }
  });

  test('…while an un-negated "I want to stop receiving texts" is still a real stop', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting.',
      contact_preference: 'I want to stop receiving texts',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  // ⭐ "DON'T FORGET TO TEXT ME" IS A REQUEST FOR TEXTS, and "I don't receive
  // texts" is a delivery complaint — neither withdraws anything.
  test('positive-intent and complaint "don\'t" phrases never suppress', async () => {
    for (const words of [
      "don't forget to text me",
      "please don't hesitate to text me",
      "I don't receive texts",
      "I don't get your texts anymore",
    ]) {
      jest.clearAllMocks();
      await executeTool('capture_lead', {
        call_summary: 'Wants or is missing texts.',
        contact_preference: words,
        do_not_contact_request: false,
      }, CTX);
      expect(recordSuppression).not.toHaveBeenCalled();
    }
  });

  // ⭐ A PLAIN "and" CAN INTRODUCE THE REPLACEMENT. Without punctuation the
  // clause boundary must still end before "and text me" — the caller CHOSE
  // texts.
  test('"stop emailing me and text me instead" keeps texts running', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Email opt-out, prefers text.',
      contact_preference: 'stop emailing me and text me instead',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  test('…while "stop texting and calling me" is still one stop clause that suppresses SMS', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting and calling.',
      contact_preference: 'stop texting and calling me',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  // ⭐ WHOSE TEXTS? The suppression is keyed to the CALLER's ANI — a stop
  // about somebody else must never silence the caller's own reminders.
  test('a third-party stop ("stop texting my tenant") records but never suppresses the caller', async () => {
    for (const words of [
      'stop texting my tenant',
      "please don't message her",
      'take my tenant off your list',
      "stop texting my husband's number",
    ]) {
      jest.clearAllMocks();
      await executeTool('capture_lead', {
        call_summary: 'Instruction about another recipient.',
        contact_preference: words,
        do_not_contact_request: true,
      }, CTX);
      expect(recordSuppression).not.toHaveBeenCalled();
    }
  });

  test('…but a stop that includes the caller ("stop texting me and my husband") still suppresses', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting them both.',
      contact_preference: 'stop texting me and my husband',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  test('…while a lone "don\'t text me" is still a real stop', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting.',
      contact_preference: "don't text me",
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  // ⭐ THE INVERSE MISTAKE. A carve-out names the channel the caller KEPT, and
  // it sits inside the stop clause — reading the clause as one string turned
  // "text me and nothing else" into a text withdrawal, silencing the only way
  // in they left open.
  test('a texty carve-out never suppresses the channel the caller kept', async () => {
    for (const words of [
      'do not contact me except by text',
      'stop contacting me, except by text message',
      'do not reach me at all, only text me',
    ]) {
      jest.clearAllMocks();
      await executeTool('capture_lead', {
        call_summary: 'Texts only from here on.',
        contact_preference: words,
        do_not_contact_request: true,
      }, CTX);
      expect(recordSuppression).not.toHaveBeenCalled();
    }
  });

  // …and the same carve-out naming a NON-texty channel is still a real SMS
  // withdrawal: email is the only way in they left open.
  test('"do not contact me except by email" still suppresses SMS', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Email only from here on.',
      contact_preference: 'do not contact me except by email',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  test('"do not contact me by email" is scoped too — the idiom is clause-checked', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Email opt-out.',
      contact_preference: 'do not contact me by email',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  test('"don\'t reach me by phone" is still call-scoped — no SMS suppression', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Phone opt-out.',
      contact_preference: "don't reach me by phone, text me instead",
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  test('"don\'t reach me by email" is scoped to email — no SMS suppression', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Email opt-out.',
      contact_preference: "don't reach me by email",
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  test('the caller\'s own words are never written to the log', async () => {
    const logger = require('../services/logger');
    await executeTool('capture_lead', {
      call_summary: 'Email opt-out.',
      contact_preference: "don't email me at pat.whitfield@example.com or call 941-555-0142",
      do_not_contact_request: true,
    }, CTX);
    for (const call of [...logger.warn.mock.calls, ...logger.info.mock.calls, ...logger.error.mock.calls]) {
      const line = String(call[0] || '');
      expect(line).not.toContain('pat.whitfield@example.com');
      expect(line).not.toContain('941-555-0142');
    }
  });

  // ⭐ A BARE FLAG NAMES NO CHANNEL. `contact_preference` is optional, so the
  // boolean alone can be the model's shorthand for "stop emailing me" just as
  // easily as for "stop everything" — and guessing costs the caller reminders
  // they never withdrew. No words ⇒ no write, recorded for a human.
  test('a bare flag with no words at all writes NOTHING (ambiguous → human)', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked to be left alone.',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  // ⭐ AN UNVERIFIED SESSION CANNOT SILENCE ANYONE'S TEXTS. Suppression is
  // destructive in the quiet direction, so a leaked-key session that merely
  // DECLARES a number must not reach it.
  test('an UNVERIFIED session records the request but writes no suppression', async () => {
    const logger = require('../services/logger');
    const out = await executeTool('capture_lead', {
      call_summary: 'Asked to stop texting.',
      contact_preference: 'stop texting me',
      do_not_contact_request: true,
    }, { ...CTX, callerVerified: false });
    expect(recordSuppression).not.toHaveBeenCalled();
    expect(out).toMatch(/Lead saved successfully|no new lead was created/i);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/UNVERIFIED session/i));
  });

  test('a preference that is NOT an opt-out records nothing', async () => {
    await executeTool('capture_lead', {
      first_name: 'Pat',
      call_summary: 'Prefers a call.',
      contact_preference: 'call my husband Dave instead',
      preferred_contact_method: 'phone',
      do_not_contact_request: false,
    }, CTX);
    expect(recordSuppression).not.toHaveBeenCalled();
  });

  test('a failed suppression write never loses the lead', async () => {
    recordSuppression.mockRejectedValueOnce(new Error('table gone'));
    const out = await executeTool('capture_lead', {
      call_summary: 'Stop texting me.',
      contact_preference: 'stop texting me',
      do_not_contact_request: true,
    }, CTX);
    expect(out).toMatch(/Lead saved successfully/i);
  });

  // ⭐ recordSuppression RESOLVES ON FAILURE — it catches its own DB errors and
  // returns { ok: false }. An un-inspected await would log "honoured" over a
  // caller whose texts are still enabled, which is the whole failure this write
  // exists to prevent.
  test('a resolved { ok: false } is treated as a FAILURE, not a success', async () => {
    const logger = require('../services/logger');
    recordSuppression.mockResolvedValueOnce({ ok: false, error: 'relation does not exist' });
    const out = await executeTool('capture_lead', {
      call_summary: 'Stop texting me.',
      contact_preference: 'stop texting me',
      do_not_contact_request: true,
    }, CTX);
    expect(out).toMatch(/Lead saved successfully/i); // the lead still lands…
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/do-not-contact NOT recorded/i));
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringMatching(/do-not-contact honoured/i));
  });
});
