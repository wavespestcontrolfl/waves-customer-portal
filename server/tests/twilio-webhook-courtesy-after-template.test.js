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

const fs = require('fs');
const path = require('path');
const { lastOutboundAskedQuestion, isAffirmativeReactionToAutomatedText, AUTOMATED_VISIT_TEXT_TYPES } = require('../routes/twilio-webhook')._internals;
const { isCourtesyOnly, isQuietSmsReaction } = require('../services/sms-intent');

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

describe('tapbacks on an automated visit text', () => {
  const ZW = '\u200b';
  const android = (emoji, target) => ` ${ZW}${emoji}${ZW} to \u201c ${target} \u201d `;
  // What the webhook does for a reaction.
  const quiet = async (body) => isQuietSmsReaction(body) || isAffirmativeReactionToAutomatedText(body, CUSTOMER, WAVES);

  test('the confirmation template asks for a reply, so a plain tapback on it rings today', async () => {
    mockState.last = { message_type: 'confirmation', message_body: CONFIRMATION };
    expect(isQuietSmsReaction(android('👍', CONFIRMATION))).toBe(false);
    process.env[GATE] = 'true';
    expect(isQuietSmsReaction(android('👍', CONFIRMATION))).toBe(false); // the recognizer itself is unchanged
  });

  test('gate off: unchanged (loud)', async () => {
    mockState.last = { message_type: 'confirmation', message_body: CONFIRMATION };
    expect(await quiet(android('👍', CONFIRMATION))).toBe(false);
    expect(mockState.wheres).toEqual([]); // no thread read at all
  });

  test('gate on: an affirmative tapback is quiet when the last Waves text was automated', async () => {
    process.env[GATE] = 'true';
    mockState.last = { message_type: 'confirmation', message_body: CONFIRMATION };
    expect(await quiet(android('👍', CONFIRMATION))).toBe(true);
    mockState.last = { message_type: 'appointment_reminder', message_body: REMINDER };
    expect(await quiet(`Liked \u201c${REMINDER}\u201d`)).toBe(true);
    expect(await quiet(`Reacted ❤️ to "${REMINDER}"`)).toBe(true);
  });

  test('gate on: a tapback on an EARLIER staff question stays loud when a reminder went out after it', async () => {
    process.env[GATE] = 'true';
    mockState.last = { message_type: 'appointment_reminder', message_body: REMINDER };
    expect(await quiet(android('👍', PERSON_ASK))).toBe(false);
    expect(await quiet(android('👍', 'Can you do Thursday morning instead? Reply with a time.'))).toBe(false);
  });

  test('gate on: a staff clause that also sits mid-text in the newest reminder stays loud (codex #6331 r3)', async () => {
    process.env[GATE] = 'true';
    mockState.last = { message_type: 'appointment_reminder', message_body: REMINDER }; // contains "Reply C to confirm"
    expect(REMINDER).toContain('Reply C to confirm');
    expect(await quiet(android('👍', 'Reply C to confirm'))).toBe(false);
    expect(await quiet(android('👍', 'Reply C to confirm or reschedule here'))).toBe(false);
    expect(await quiet('Reacted 👍 to "Reply C to confirm"')).toBe(false);
  });

  test('gate on: an earlier staff text that is itself a prefix of the newest reminder stays loud (codex #6331 r4)', async () => {
    process.env[GATE] = 'true';
    const staff = 'Reply C to confirm your Thursday visit between 8 and 10 AM';
    mockState.last = { message_type: 'appointment_reminder', message_body: `${staff}, or reschedule: https://wav.es/ab12c` };
    expect(staff.length).toBeGreaterThan(20);
    expect(await quiet(android('👍', staff))).toBe(false);
  });

  test('gate on: only the whole text counts; a truncated quote rings, whitespace and case differences do not matter', async () => {
    process.env[GATE] = 'true';
    const body = 'Reply C to confirm your Thursday visit between 8 and 10 AM, or reschedule: https://wav.es/ab12c';
    mockState.last = { message_type: 'appointment_reminder', message_body: body };
    expect(isQuietSmsReaction(android('👍', body))).toBe(false); // asks for a reply, so the recognizer alone rings
    expect(await quiet(android('👍', body))).toBe(true);
    expect(await quiet(android('👍', `  ${body.toUpperCase().replace(/ /g, '  ')} `))).toBe(true);
    expect(await quiet(android('👍', body.slice(0, 60)))).toBe(false);
    expect(await quiet(android('👍', body.slice(0, body.length - 1)))).toBe(false);
    expect(await quiet(android('👍', `${body} extra`))).toBe(false);
  });

  test('gate on: ❓ / 👎 / disliked stay loud even after an automated text', async () => {
    process.env[GATE] = 'true';
    mockState.last = { message_type: 'confirmation', message_body: CONFIRMATION };
    for (const body of [android('❓', CONFIRMATION), android('👎', CONFIRMATION), android('🚨', CONFIRMATION), `Disliked \u201c${REMINDER}\u201d`, `Questioned \u201c${REMINDER}\u201d`]) {
      expect([body, await quiet(body)]).toEqual([body, false]);
    }
  });

  test('gate on: after a person\'s text, or with no row or a failed read, a tapback on a reply-asking text rings', async () => {
    process.env[GATE] = 'true';
    mockState.last = { message_type: 'manual', message_body: PERSON_ASK };
    expect(await quiet(android('👍', 'Reply YES to confirm Thursday'))).toBe(false);
    mockState.last = null;
    expect(await quiet(android('👍', CONFIRMATION))).toBe(false);
    mockState.last = { message_type: 'confirmation', message_body: CONFIRMATION };
    mockState.throwOnRead = true;
    expect(await quiet(android('👍', CONFIRMATION))).toBe(false);
  });
});

describe('automated type list matches what the code persists', () => {
  const read = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  test('every completion message type written by complete-scheduled-service.js / delivery.js is classified', () => {
    const completion = read('services/complete-scheduled-service.js');
    const delivery = read('services/service-report/delivery.js');
    const written = new Set([
      ...[...completion.matchAll(/sentSmsType = '([a-z0-9_]+)'/g)].map((m) => m[1]),
      ...[...delivery.matchAll(/\? '(service_report_v1[a-z0-9_]*)' : '(service_report_v1[a-z0-9_]*)'/g)].flatMap((m) => [m[1], m[2]]),
    ]);
    expect(written.size).toBeGreaterThanOrEqual(8); // the scan itself found the family
    const missing = [...written].filter((t) => !AUTOMATED_VISIT_TEXT_TYPES.has(t));
    expect(missing).toEqual([]);
  });

  test('the visit-notice types from the purpose map are classified', () => {
    const { mapPurposeToMessageType } = require('../services/messaging/providers/twilio-sms');
    for (const purpose of ['appointment', 'appointment_reminder_72h', 'appointment_reminder_24h', 'appointment_confirmation', 'tech_en_route', 'tech_arrived', 'service_completion']) {
      expect([purpose, AUTOMATED_VISIT_TEXT_TYPES.has(mapPurposeToMessageType(purpose))]).toEqual([purpose, true]);
    }
  });

  test('a completion text with an invoice or receipt is courtesy-eligible after the gate', async () => {
    process.env[GATE] = 'true';
    for (const type of ['service_complete_with_invoice', 'service_complete_paid_receipt', 'service_complete_prepaid', 'service_complete_annual_prepay', 'service_complete_annual_prepay_after_first_visit', 'service_report_v1', 'service_report_v1_with_invoice']) {
      mockState.last = { message_type: type, message_body: 'Your report is ready. Pay here: https://wav.es/ab12c' };
      expect([type, await wouldBeCourtesy('Thanks')]).toEqual([type, true]);
    }
  });
});
