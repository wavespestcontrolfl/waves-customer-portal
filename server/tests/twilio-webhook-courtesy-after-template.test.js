/**
 * GATE_SMS_COURTESY_AFTER_TEMPLATE (owner 2026-10-14).
 *
 * A bare courtesy reply ("Ok", "Thanks", a thumbs-up) to an AUTOMATED visit text
 * (confirmation, reminder, en route, arrival, completion) must not ring the admin
 * bell. Gate off: a template with a "reply"/"confirm" line still counts as a
 * question, as before. A person's text ('manual') keeps counting as a question.
 * The webhook computes courtesyOnly as
 *   isCourtesyOnly(Body, { awaitingAnswer: await lastOutboundAskedQuestion(From, To) })
 * so these tests run that exact composition against a mocked sms_log read.
 * All names and numbers are synthetic.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockState = { last: null, throwOnRead: false, wheres: [] };

jest.mock('../models/db', () => {
  const build = () => {
    const query = {};
    for (const method of ['where', 'whereIn', 'whereNot', 'orWhereNull', 'orderBy']) {
      query[method] = (...args) => { mockState.wheres.push([method, ...args]); return query; };
    }
    query.first = async (...cols) => {
      mockState.wheres.push(['first', ...cols]);
      if (mockState.throwOnRead) throw new Error('lookup failed');
      return mockState.last;
    };
    return query;
  };
  const db = jest.fn(() => build());
  db.raw = jest.fn((sql) => ({ sql }));
  return db;
});

const { lastOutboundAskedQuestion } = require('../routes/twilio-webhook')._internals;
const { isCourtesyOnly } = require('../services/sms-intent');

const GATE = 'GATE_SMS_COURTESY_AFTER_TEMPLATE';
const CUSTOMER = '+19415550100';
const WAVES = '+19415550199';

const CONFIRMATION = 'Hi Dana, your Lawn Care Service is booked for October 12, between 5:00 PM and 7:00 PM. View and confirm your appointment: https://wav.es/ab12c';
const REMINDER = 'Reminder: your service is tomorrow between 8 and 10 AM. Reply C to confirm or reschedule here: https://wav.es/ab12c';
const PERSON_ASK = 'Does 8 AM work for you?';

// What the webhook does for a courtesy candidate.
async function wouldBeCourtesy(body) {
  if (!isCourtesyOnly(body, { awaitingAnswer: false })) return false;
  return isCourtesyOnly(body, { awaitingAnswer: await lastOutboundAskedQuestion(CUSTOMER, WAVES) });
}

let savedGate;
beforeEach(() => {
  jest.clearAllMocks();
  savedGate = process.env[GATE];
  delete process.env[GATE];
  mockState.last = null;
  mockState.throwOnRead = false;
  mockState.wheres = [];
});
afterEach(() => {
  if (savedGate === undefined) delete process.env[GATE]; else process.env[GATE] = savedGate;
});

describe('gate off: today\'s behavior exactly', () => {
  test('"Ok" after a confirmation template is NOT courtesy (the template asks to confirm)', async () => {
    mockState.last = { message_type: 'confirmation', message_body: CONFIRMATION };
    expect(await wouldBeCourtesy('Ok')).toBe(false);
    expect(await lastOutboundAskedQuestion(CUSTOMER, WAVES)).toBe(true);
  });

  test('a gate value other than exactly "true" stays off', async () => {
    mockState.last = { message_type: 'confirmation', message_body: CONFIRMATION };
    for (const v of ['1', 'on', 'TRUE', 'false', '']) {
      process.env[GATE] = v;
      expect([v, await wouldBeCourtesy('Ok')]).toEqual([v, false]);
    }
  });

  test('a statement-only template stays quiet, as before', async () => {
    mockState.last = { message_type: 'tech_en_route', message_body: 'Sam is on the way and will arrive soon.' };
    expect(await wouldBeCourtesy('Thanks!')).toBe(true);
  });
});

describe('gate on', () => {
  beforeEach(() => { process.env[GATE] = 'true'; });

  test('"Ok" and friends after an automated visit text are courtesy', async () => {
    for (const type of ['confirmation', 'appointment_confirmation', 'appointment_reminder', 'appointment_reminder_72h', 'reminder_72h', 'reminder_24h', 'tech_en_route', 'tech_arrived', 'service_complete']) {
      mockState.last = { message_type: type, message_body: type === 'confirmation' ? CONFIRMATION : REMINDER };
      for (const body of ['Ok', 'Okay', 'Thanks', 'Great thank you', '👍', 'Ok 👍']) {
        expect([type, body, await wouldBeCourtesy(body)]).toEqual([type, body, true]);
      }
    }
  });

  test('the type match ignores case', async () => {
    mockState.last = { message_type: 'Confirmation', message_body: CONFIRMATION };
    expect(await wouldBeCourtesy('Ok')).toBe(true);
  });

  test('"Great thank you" after a person\'s question still rings', async () => {
    mockState.last = { message_type: 'manual', message_body: PERSON_ASK };
    expect(await wouldBeCourtesy('Great thank you')).toBe(false);
    expect(await wouldBeCourtesy('Ok')).toBe(false);
    expect(await wouldBeCourtesy('👍')).toBe(false);
  });

  test('every other type keeps the question check (AI drafts, billing, review ask, untyped)', async () => {
    for (const type of ['ai_approved', 'ai_revised', 'ai_assistant', 'invoice', 'review_request', 'appointment_cancelled', 'recipient_optin_request', null]) {
      mockState.last = { message_type: type, message_body: 'Can you let us know which day works?' };
      expect([type, await wouldBeCourtesy('Ok')]).toEqual([type, false]);
    }
  });

  test('anything that is not a bare closer still rings after an automated text', async () => {
    mockState.last = { message_type: 'appointment_reminder', message_body: REMINDER };
    for (const body of ['can you come at 9?', 'No', 'Yes', 'Cancel', 'STOP', 'Can we reschedule', 'Thursday works', 'Ok see you at 9', 'Thanks, but you missed the backyard', 'Ok?', '❓']) {
      expect([body, await wouldBeCourtesy(body)]).toEqual([body, false]);
    }
  });

  test('no recent outbound text, or a failed lookup, fails closed (awaiting an answer)', async () => {
    mockState.last = null;
    expect(await wouldBeCourtesy('Ok')).toBe(false);
    mockState.last = { message_type: 'confirmation', message_body: CONFIRMATION };
    mockState.throwOnRead = true;
    expect(await wouldBeCourtesy('Ok')).toBe(false);
  });

  test('the thread lookup is unchanged: same Waves number, 24 hours, delivered/sent/queued, not internal_alert', async () => {
    mockState.last = { message_type: 'confirmation', message_body: CONFIRMATION };
    await lastOutboundAskedQuestion(CUSTOMER, WAVES);
    const calls = mockState.wheres;
    expect(calls).toContainEqual(['where', { direction: 'outbound', to_phone: CUSTOMER, from_phone: WAVES }]);
    expect(calls).toContainEqual(['whereIn', 'status', ['queued', 'sent', 'delivered']]);
    expect(calls.some(([m, col]) => m === 'where' && col === 'created_at')).toBe(true);
    expect(calls).toContainEqual(['first', 'message_body', 'message_type']);
  });
});
