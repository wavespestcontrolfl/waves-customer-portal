/**
 * Voice-relay Phase E item 5 — CONSENT / CONTACT-PREFERENCE CAPTURE.
 *
 * The rule being tested: a caller's stated instruction ("stop texting me",
 * "call my husband instead, not me", "email only") must LAND in the capture —
 * and the agent must NOT act on it. Capturing is the whole job; suppression
 * and messaging-preference changes are a human's.
 *
 * Matrix:
 *   - the capture_lead schema carries the field trio, using the SAME
 *     vocabulary as the existing call-extraction schemas
 *   - a stated preference persists into the lead (extracted_data + the
 *     ai_triage activity metadata)
 *   - saying nothing about contact preference writes nothing (a later
 *     preference-free call can never erase a recorded instruction)
 *   - NO suppression / opt-out / messaging-preference write happens anywhere
 *   - no customer-facing comms
 */

jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/conversations', () => ({ syncVoiceMessageForCall: jest.fn() }));
jest.mock('../utils/lead-service-interest', () => ({ composeServiceInterest: jest.fn(() => null) }));
jest.mock('../services/twilio', () => ({ sendSMS: jest.fn() }));
jest.mock('../services/messaging/send-customer-message', () => ({ sendCustomerMessage: jest.fn() }));
jest.mock('../services/email', () => ({ send: jest.fn() }));

const db = require('../models/db');
const TwilioService = require('../services/twilio');
const { sendCustomerMessage } = require('../services/messaging/send-customer-message');
const EmailService = require('../services/email');

const { createLeadFromExtraction, contactPreferenceFields } = require('../services/lead-from-extraction');
const { TOOLS } = require('../services/voice-agent/relay-tools');

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
