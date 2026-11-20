/**
 * The phone-yes bell without a database (call-phone-yes-bell.js; GATE_CALL_PHONE_YES_ACCEPT, owner 2026-11-18 "ok go",
 * step 1): when time runs short on a card, which key the card rings, and words that pass the admin alert rules in every
 * card state. The rows, the ring-once and the close run against PostgreSQL in call-phone-yes-bell.db.test.js.
 * Synthetic names only.
 */
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { composeAdminAlert } = require('../services/admin-alert-compose');
const Bell = require('../services/call-phone-yes-bell');

const { dueReason, keyToRing, standingKey, textFor, visitStart } = Bell._private;

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

  // Between rings: the open row a quiet rewrite keeps current.
  test.each([
    ['the time-short row while open', [[DUE, true], [FILED, false]], DUE],
    ['the filed row while the time-short row is closed', [[DUE, false], [FILED, true]], FILED],
    ['the filed row when time never ran short', [[FILED, true]], FILED],
    ['none when every row is closed', [[DUE, false], [FILED, false]], null],
    ['none before anything rang', [], null],
  ])('standing row: %s', (_label, written, want) => {
    expect(standingKey('c-1', new Map(written))).toBe(want);
  });
});

test('the link opens the Triage tab, which the Communications page reads from the hash', () => {
  expect(Bell.LINK).toBe('/admin/communications#tab=triage');
});

describe('the words, by card state', () => {
  const WORDS = "Let's do the quarterly plan, just bill me each time you come out.";
  // Tue, Nov 24.
  const VISIT = { scheduled_date: '2026-11-24', window_start: '15:00:00' };
  const card = (payload) => ({ id: 'c-1', payload, summary: 'The card says this.' });
  const passesRules = (text) => composeAdminAlert({
    area: 'Estimates', action: text.action, why: text.why, severity: 'needs-you', link: Bell.LINK,
    subject: { type: 'call', id: 'call-1' }, doneWhen: Bell.DONE_WHEN, who: 'person',
  });

  test.each([
    ['a yes', { yes_heard: true, caller_words: WORDS }, VISIT,
      "accept Pat Sampleton's estimate", 'The caller said yes to pay per application on a call, and the visit is Tue, Nov 24.'],
    ['a yes and no visit on the calendar', { yes_heard: true, caller_words: WORDS }, null,
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

  // The why reaches a phone's lock screen, and no screen catches every form of a code (the first case passes the access
  // code redactor): the caller's words never reach the bell, in any state. The card in Triage shows them.
  test.each([
    ['a gate code in number words with no code word', 'Yes, use four five four five at the gate. Bill me per application.', /four five/],
    ['a gate code in digits', 'Yes, bill me each time, the gate code is 4545. Thanks.', /4545/],
    ['a card number', 'Yes, and charge my card 4111 1111 1111 1111 each time.', /4111|1111/],
  ])("%s: the caller's words never reach the bell", (_label, words, secret) => {
    for (const payload of [{ yes_heard: true, caller_words: words }, { yes_heard: true, caller_words: words, estimate_accepted: true }]) {
      for (const due of [null, 'visit_soon']) {
        const text = JSON.stringify(textFor({ name: 'Pat Sampleton', card: card(payload), visit: VISIT, due }));
        expect(text).not.toMatch(secret);
        expect(text).not.toMatch(/[“”]/);
      }
    }
  });

  test("the detail is the card's summary and where to see the card, and the caller's words while it carries a yes", () => {
    const { detail } = textFor({ name: 'Pat Sampleton', card: card({ yes_heard: true, caller_words: WORDS }), visit: VISIT });
    expect(detail).toBe("The card says this. Open Communications, then Triage, to see the card and the caller's words.");
    // A card whose estimate was accepted still carries the yes.
    expect(textFor({ name: 'Pat Sampleton', card: card({ yes_heard: true, caller_words: WORDS, estimate_accepted: true }), visit: VISIT }).detail)
      .toBe(detail);
    expect(textFor({ name: 'Pat Sampleton', card: card({ yes_heard: false }), visit: VISIT }).detail)
      .toBe('The card says this. Open Communications, then Triage, to see the card.');
  });
});
