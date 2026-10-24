/**
 * services/lead-call-text-followup.js (GATE_LEAD_CALL_TEXT_FOLLOWUP): the
 * owner's approved texts (2026-10-24), the time reader, and the day a night
 * ask is for. The claim and slot rules run against PostgreSQL in
 * lead-call-text-followup-postgres.test.js.
 */
jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../config/feature-gates', () => ({ isEnabled: jest.fn(() => false) }));

const { isEnabled } = require('../config/feature-gates');
const db = require('../models/db');
const {
  handleLeadReply, parseCallTime, TEXT_REPLY_BODY, NIGHT_CALL_BODY, ENTRY_POINT, _test,
} = require('../services/lead-call-text-followup');

const at = (h, m = 0) => ({ minutes: h * 60 + m });

test('the texts are the owner-approved words, and none says closed', () => {
  expect(TEXT_REPLY_BODY).toBe('Great, we can handle it by text! What service(s) are you interested in?');
  expect(NIGHT_CALL_BODY).toBe('Got it! What time tomorrow works best for us to call you?');
  expect(`${TEXT_REPLY_BODY} ${NIGHT_CALL_BODY}`).not.toMatch(/closed/i);
});

test('the night texts go out at any hour: the entry point is a customer action', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'services', 'messaging', 'validators', 'send-window.js'), 'utf8');
  expect(src).toContain(`'${ENTRY_POINT}'`);
});

test.each([
  ['10am', at(10)],
  ['10 AM', at(10)],
  ['10:30am', at(10, 30)],
  ['10:30', at(10, 30)],
  ['10', at(10)],
  ['2', at(14)],
  ['2pm', at(14)],
  ['2 p.m.', at(14)],
  ['7:45 pm', at(19, 45)],
  ['noon', at(12)],
  ['12', at(12)],
  ['10am works', at(10)],
  ['Around 2 please', at(14)],
  ['tomorrow at 9', at(9)],
  ['9 in the morning', at(9)],
  ['3 in the afternoon', at(15)],
  ['10 o\'clock', at(10)],
  ['6am', at(6)],
  ['9pm', at(21)],
])('"%s" reads as one time', (text, expected) => {
  expect(parseCallTime(text)).toEqual(expected);
});

test.each([
  'whenever',
  'anytime',
  'after 10',
  '7 tonight',
  'by 10am',
  'call by 10',
  'before noon',
  'between 10 and 12',
  '10-11',
  '10 or 11',
  'after work',
  'ants in my kitchen',
  'morning',
  '13',
  '10:75',
  '',
])('"%s" is not one plain time', (text) => {
  expect(parseCallTime(text)).toBeNull();
});

test('a night ask after 8 PM is for the next day; one after midnight is for that morning', () => {
  // 9 PM EDT on Oct 20 → Oct 21; 1 AM EDT on Oct 21 → Oct 21.
  expect(_test.targetDateFor(new Date('2026-10-21T01:00:00Z'))).toBe('2026-10-21');
  expect(_test.targetDateFor(new Date('2026-10-21T05:00:00Z'))).toBe('2026-10-21');
  expect(_test.targetDateFor(new Date('2026-10-20T23:30:00Z'))).toBe('2026-10-20');
});

test('a DATE read back as midnight UTC keeps its calendar day', () => {
  // pg parses a DATE column as local midnight; Railway runs UTC, so this is
  // what a target_date of Oct 25 looks like there.
  expect(_test.dateText(new Date('2026-10-25T00:00:00Z'))).toBe('2026-10-25');
  expect(_test.dateText('2026-10-25')).toBe('2026-10-25');
});

test('a slot is the ET wall time on the target day', () => {
  expect(_test.slotInstant('2026-10-21', 10 * 60).toISOString()).toBe('2026-10-21T14:00:00.000Z');
  expect(_test.slotInstant('2026-12-01', 10 * 60).toISOString()).toBe('2026-12-01T15:00:00.000Z');
});

test('gate off: nothing is read or sent', async () => {
  isEnabled.mockReturnValue(false);
  await expect(handleLeadReply({ customer: { id: 'c1' }, body: 'text', fromPhone: '+19415550100' }))
    .resolves.toEqual({ action: 'none', reason: 'gate_off' });
  expect(db).not.toHaveBeenCalled();
});

test('a foreign number is never handled', async () => {
  isEnabled.mockReturnValue(true);
  await expect(handleLeadReply({ customer: { id: 'c1' }, body: 'text', fromPhone: '+449415550100' }))
    .resolves.toEqual({ action: 'none', reason: 'bad_phone' });
  expect(db).not.toHaveBeenCalled();
});
