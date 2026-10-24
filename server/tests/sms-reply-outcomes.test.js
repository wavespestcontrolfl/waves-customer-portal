// Pure checks for reply outcome signals (no database): the word lists, the
// signal classifier, phone matching, and that the gate and cron are wired dark.
const fs = require('fs');
const path = require('path');

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

const outcomes = require('../services/sms-reply-outcomes');

const { confusionReason, classifyFollowUps, _private } = outcomes;
const REPLY_AT = new Date('2026-09-01T15:00:00Z');
const after = (minutes) => new Date(REPLY_AT.getTime() + minutes * 60_000);
const row = (body, minutes, type = 'inbound') => ({ message_type: type, message_body: body, created_at: after(minutes) });
const classify = (followUps, extra = {}) => classifyFollowUps({
  replyAt: REPLY_AT, followUps, answeredBody: 'How much is quarterly pest control for a three bedroom house?', calledBack: false, ...extra,
});

describe('confusionReason', () => {
  test.each(['?', '??', 'What?', 'huh', 'Huh?', 'what do you mean', "I don't understand", 'I dont get it', 'Can you explain that?', 'come again?', 'Sorry?'])(
    'reads %p as confusion', (body) => expect(confusionReason(body, null)).toBe('confusion_phrase'),
  );
  test.each(['Thursday works for us', 'What time will the technician arrive on Thursday?', 'Thanks!', '', null, 'ok'])(
    'does not read %p as confusion', (body) => expect(confusionReason(body, null)).toBeNull(),
  );
  test('the same question again is a repeat', () => {
    const prior = 'How much is quarterly pest control for a three bedroom house?';
    expect(confusionReason('How much is quarterly pest control for a 3 bedroom house?', prior)).toBe('repeat');
    expect(confusionReason('how much is quarterly pest control for a three bedroom house', prior)).toBe('repeat');
    expect(confusionReason('Can you come Thursday afternoon instead of Friday morning?', prior)).toBeNull();
  });
  test('a short prior text never counts as a repeat', () => {
    expect(confusionReason('Price?', 'Price?')).toBeNull();
  });
});

describe('classifyFollowUps', () => {
  test('no follow-up at all is silence', () => {
    expect(classify([])).toMatchObject({ silent: true, confused: false, opted_out: false, called_back: false, positive_close: false, first_inbound_at: null });
  });
  test('a call back alone is not silence', () => {
    expect(classify([], { calledBack: true })).toMatchObject({ called_back: true, silent: false });
  });
  test('confusion only counts inside 30 minutes', () => {
    expect(classify([row('huh?', 29)])).toMatchObject({ confused: true, confusion_reason: 'confusion_phrase', first_inbound_seconds: 29 * 60 });
    expect(classify([row('huh?', 31)])).toMatchObject({ confused: false });
  });
  test('an opt-out inside 72 hours counts, a STOP-type text with no row type too', () => {
    expect(classify([row('STOP', 60 * 60, 'opt_out')])).toMatchObject({ opted_out: true, silent: false });
    expect(classify([row('STOP', 120)])).toMatchObject({ opted_out: true });
    expect(classify([row('Please stop texting me', 120)])).toMatchObject({ opted_out: true });
  });
  test('positive close is the first text, inside four hours', () => {
    expect(classify([row('Thanks!', 20)]).positive_close).toBe(true);
    expect(classify([row('👍', 5)]).positive_close).toBe(true);
    expect(classify([row('Can you do Friday instead?', 5), row('Thanks!', 8)]).positive_close).toBe(false);
    expect(classify([row('Thanks!', 241)]).positive_close).toBe(false);
  });
  test('a tapback like counts, a removed like does not', () => {
    expect(classify([row('Liked “See you Tuesday”', 3, 'sms_reaction')]).positive_close).toBe(true);
    expect(classify([row('Removed a like from “See you Tuesday”', 3, 'sms_reaction')]).positive_close).toBe(false);
  });
  test('help and opt-in rows are not follow-ups', () => {
    // readFollowUps leaves them out; a stray row of another type is ignored here too
    expect(classify([row('HELP', 5, 'help_request')]).silent).toBe(true);
  });
});

describe('phone matching', () => {
  test('US numbers match on full digits, with or without the 1', () => {
    expect(_private.nanpDigits('+19415550123')).toMatchObject({ full: '19415550123', ten: '9415550123' });
    expect(_private.nanpDigits('9415550123')).toMatchObject({ full: '19415550123', ten: '9415550123' });
    expect(_private.nanpDigits('(941) 555-0123')).toMatchObject({ ten: '9415550123' });
  });
  test('international numbers never become a US number', () => {
    expect(_private.nanpDigits('+449415550123')).toBeNull();
    expect(_private.nanpDigits('+4915550123456')).toBeNull();
    expect(_private.nanpDigits('+9415550123')).toBeNull();
  });
});

describe('measurement only, dark by default', () => {
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  test('the settle time covers the longest window', () => {
    expect(outcomes.SETTLE_HOURS).toBe(72);
  });
  test('the gate is registered and off unless exactly true', () => {
    expect(read('config/feature-gates.js')).toContain("smsReplyOutcomes: process.env.GATE_SMS_REPLY_OUTCOMES === 'true'");
  });
  test('the cron returns before taking its lock when the gate is off', () => {
    const src = read('services/scheduler.js');
    const at = src.indexOf("runExclusive('sms-reply-outcomes'");
    expect(at).toBeGreaterThan(0);
    const block = src.slice(src.lastIndexOf('cron.schedule(', at), at);
    expect(block).toContain("if (!isEnabled('smsReplyOutcomes')) return;");
  });
  test('the service never sends and writes only its own table', () => {
    const src = read('services/sms-reply-outcomes.js');
    expect(src).not.toMatch(/require\([^)]*(send-customer-message|send-manual|twilio|notification|sms-auto-send)/i);
    const writes = [...src.matchAll(/dbh\('([a-z_]+)'\)\s*\.(insert|update|del|delete)\(/g)].map((m) => m[1]);
    expect(new Set(writes)).toEqual(new Set(['sms_reply_outcomes']));
  });
});
