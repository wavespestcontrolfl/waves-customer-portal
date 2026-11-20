/**
 * The phone-yes bell without a database (call-phone-yes-bell.js; GATE_CALL_PHONE_YES_ACCEPT, owner 2026-11-18 "ok go",
 * step 1): when time runs short on a card, which key the card rings, and words that pass the admin alert rules in every
 * card state. The rows, the ring-once and the close run against PostgreSQL in call-phone-yes-bell.db.test.js.
 * Synthetic names only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { composeAdminAlert } = require('../services/admin-alert-compose');
const Bell = require('../services/call-phone-yes-bell');

const { dueReason, keyToRing, textFor, visitStart } = Bell._private;

// Mon, Nov 23, 2026, 10:00 AM Eastern (EST).
const NOW = new Date('2026-11-23T15:00:00Z');
const HOUR = 3600000;
const at = (hours) => new Date(NOW.getTime() + hours * HOUR);

describe('when time runs short', () => {
  test.each([
    ['an estimate that expires in 23 hours', { expiresAt: at(23) }, 'estimate_expires'],
    ['an estimate that expires in 25 hours', { expiresAt: at(25) }, null],
    ['an estimate that already expired', { expiresAt: at(-1) }, null],
    // Wed, Nov 25 at 9:00 AM Eastern is 47 hours away; 11:00 AM is 49.
    ['a visit that starts in 47 hours', { visit: { scheduled_date: '2026-11-25', window_start: '09:00:00' } }, 'visit_soon'],
    ['a visit that starts in 49 hours', { visit: { scheduled_date: '2026-11-25', window_start: '11:00:00' } }, null],
    ['a visit with no start, counted from the start of its day (38 hours)', { visit: { scheduled_date: '2026-11-25', window_start: null } }, 'visit_soon'],
    ['a visit that already started', { visit: { scheduled_date: '2026-11-23', window_start: '08:00:00' } }, null],
    ['no estimate expiry and no visit', {}, null],
  ])('%s', (_label, facts, want) => {
    expect(dueReason({ expiresAt: null, visit: null, now: NOW, ...facts })).toBe(want);
  });

  test('when both are short, the estimate is the reason', () => {
    expect(dueReason({ expiresAt: at(5), visit: { scheduled_date: '2026-11-24', window_start: '09:00:00' }, now: NOW }))
      .toBe('estimate_expires');
  });

  test('the visit starts at its Eastern wall-clock time on either side of the daylight-saving change', () => {
    expect(visitStart({ scheduled_date: '2026-10-30', window_start: '09:00:00' })).toEqual(new Date('2026-10-30T13:00:00Z'));
    expect(visitStart({ scheduled_date: '2026-11-02', window_start: '09:00:00' })).toEqual(new Date('2026-11-02T14:00:00Z'));
    // A DATE column read as a Date at UTC midnight is the same day.
    expect(visitStart({ scheduled_date: new Date('2026-11-02T00:00:00Z'), window_start: '09:00' })).toEqual(new Date('2026-11-02T14:00:00Z'));
    expect(visitStart(null)).toBeNull();
  });
});

describe('which key a card rings', () => {
  const FILED = 'call-phone-yes:c-1';
  const DUE = 'call-phone-yes-due:c-1';
  test.each([
    ['a new card rings its filed key', null, [], FILED],
    ['a card whose filed key rang rings nothing more while time is not short', null, [FILED], null],
    ['time runs short: the time-short key', 'visit_soon', [FILED], DUE],
    ['a card filed when time is already short rings the time-short key alone', 'estimate_expires', [], DUE],
    ['after the time-short key nothing rings while time stays short', 'visit_soon', [FILED, DUE], null],
    ['after the time-short key nothing rings when time is no longer short', null, [DUE], null],
  ])('%s', (_label, due, rung, want) => {
    expect(keyToRing({ cardId: 'c-1', due, rung: new Set(rung) })).toBe(want);
  });
});

describe('the words, by card state', () => {
  const WORDS = "Let's do the quarterly plan, just bill me each time you come out.";
  // Tue, Nov 24.
  const VISIT = { scheduled_date: '2026-11-24', window_start: '15:00:00' };
  const card = (payload) => ({ id: 'c-1', payload, summary: 'The card says this.' });
  const passesRules = (text) => composeAdminAlert({
    area: 'Estimates', action: text.action, why: text.why, severity: 'needs-you', link: '/admin/communications?tab=triage',
    subject: { type: 'call', id: 'call-1' }, doneWhen: Bell.DONE_WHEN, who: 'person',
  });

  test.each([
    ['a yes: the first words, cut to fit', { yes_heard: true, caller_words: WORDS }, VISIT,
      "accept Pat Sampleton's estimate",
      "The caller said “Let's do the quarterly plan, just bill me each…” on a call, and the visit is Tue, Nov 24."],
    ['a yes: the first sentence of two, without its full stop', { yes_heard: true, caller_words: 'Sounds good. Bill me each visit.' }, VISIT,
      "accept Pat Sampleton's estimate", 'The caller said “Sounds good” on a call, and the visit is Tue, Nov 24.'],
    ['a yes with an exclamation mark: plain words', { yes_heard: true, caller_words: 'Yes! Put me on the plan.' }, VISIT,
      "accept Pat Sampleton's estimate", 'The caller said yes to pay per application on a call, and the visit is Tue, Nov 24.'],
    ['a yes whose words carry a date: plain words', { yes_heard: true, caller_words: 'Yes, start 2026-11-24 and bill each time' }, VISIT,
      "accept Pat Sampleton's estimate", 'The caller said yes to pay per application on a call, and the visit is Tue, Nov 24.'],
    ['a yes with no words and no visit', { yes_heard: true }, null,
      "accept Pat Sampleton's estimate", 'The caller said yes to pay per application on a call.'],
    ['no yes heard', { yes_heard: false }, VISIT,
      "check Pat Sampleton's estimate", 'A call booked a pest visit for Tue, Nov 24 while an estimate is open; no yes was heard.'],
    ['no yes heard and no visit on the calendar', { yes_heard: false }, null,
      "check Pat Sampleton's estimate", 'A call booked a pest visit while an estimate is open; no yes was heard.'],
    ['the yes read again', { yes_heard: false, yes_rechecking: true }, VISIT,
      "check Pat Sampleton's estimate", 'A call booked a pest visit for Tue, Nov 24 while an estimate is open; its yes is being read again.'],
    ['an estimate accepted, the visit not linked', { yes_heard: true, caller_words: WORDS, estimate_accepted: true }, VISIT,
      "check Pat Sampleton's booked visit", 'An estimate was accepted, but the visit the call booked for Tue, Nov 24 is not linked to it yet.'],
  ])('%s', (_label, payload, visit, action, why) => {
    const text = textFor({ name: 'Pat Sampleton', card: card(payload), visit });
    expect(text).toMatchObject({ action, why });
    expect(() => passesRules(text)).not.toThrow();
  });

  test.each([
    ['the estimate expires', { due: 'estimate_expires', expiresAt: at(20) }, 'The estimate expires Tue, Nov 24 and is not accepted yet.'],
    ['one of several estimates expires', { due: 'estimate_expires', expiresAt: at(20), several: true },
      'An open estimate on the card expires Tue, Nov 24 and is not accepted yet.'],
    ['the visit is soon', { due: 'visit_soon' }, 'The visit the call booked is Tue, Nov 24, and its card in Triage is still open.'],
  ])('time short: %s', (_label, facts, why) => {
    const text = textFor({ name: 'Pat Sampleton', card: card({ yes_heard: true, caller_words: WORDS }), visit: VISIT, ...facts });
    expect(text).toMatchObject({ action: "accept Pat Sampleton's estimate", why });
    expect(() => passesRules(text)).not.toThrow();
  });

  test('a long name is cut to fit the headline', () => {
    const text = textFor({ name: 'Bartholomew Maximilian Featherstonehaugh Worthington', card: card({ yes_heard: false }), visit: VISIT });
    expect(text.action).toMatch(/^check Bartholomew .*…'s estimate$/);
    expect(passesRules(text).headline.length).toBeLessThanOrEqual(60);
  });

  test("the detail is the card's summary, the caller's whole words and where the card is", () => {
    const { detail } = textFor({ name: 'Pat Sampleton', card: card({ yes_heard: true, caller_words: WORDS }), visit: VISIT });
    expect(detail).toBe(`The card says this. The caller's words: “${WORDS}”. Open Communications, then Triage, to see the card.`);
    expect(textFor({ name: 'Pat Sampleton', card: card({ yes_heard: false }), visit: VISIT }).detail)
      .toBe('The card says this. Open Communications, then Triage, to see the card.');
  });
});
