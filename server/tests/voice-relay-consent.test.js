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

  test('a lifecycle customer who stated NO preference triggers no notification', async () => {
    await createLeadFromExtraction({ call_summary: 'Just asking about the last visit.' }, { phone: CALLER });
    expect(NotificationService.notifyAdmin).not.toHaveBeenCalled();
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

  test('gate-on prompt tells her to capture it and explicitly not to promise a change', () => {
    const p = buildBasePrompt(true);
    expect(p).toContain('IF THEY TELL YOU HOW TO CONTACT THEM');
    expect(p).toContain('contact_preference');
    expect(p).toMatch(/cannot change anything about how Waves contacts them/i);
    expect(p).toMatch(/Never promise they will stop receiving messages/i);
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
  test('"stop texting me; call my husband instead" DOES suppress SMS', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting and call the husband.',
      contact_preference: 'stop texting me; call my husband Dave instead',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  test('an explicitly STATED "stop texting me" does suppress SMS', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Asked us to stop texting.',
      contact_preference: 'stop texting me please',
      do_not_contact_request: true,
    }, CTX);
    expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
  });

  test('"remove my number" and "don\'t bother me anymore" are total stops too', async () => {
    for (const words of ['remove my number from your system', "don't bother me anymore"]) {
      jest.clearAllMocks();
      await executeTool('capture_lead', {
        call_summary: 'Asked to be left alone.',
        contact_preference: words,
        do_not_contact_request: true,
      }, CTX);
      expect(recordSuppression).toHaveBeenCalledWith(expect.objectContaining({ phone: CALLER }));
    }
  });

  test('"do not contact me by email" is scoped too — the idiom is clause-checked', async () => {
    await executeTool('capture_lead', {
      call_summary: 'Email opt-out.',
      contact_preference: 'do not contact me by email',
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
