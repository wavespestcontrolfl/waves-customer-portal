import { describe, expect, it } from 'vitest';
import {
  ASKED_TIME_CHECKED_HINT, DAY_PROMISE_CUTOFF_HOURS, PHONE_SCRIPT_HINT, askedTimeCreateFields, askedTimeHint, askedTimeMoveFields,
  dayScriptApplies, reminderAnswerFor, rescheduleHintSlot, startsBeyondCutoff, toldBadgeText,
} from './dayOnlyPromise';

describe('day-only promise words and request fields', () => {
  // 2026-11-10 9:00 AM ET (14:00Z) is "now"; Nov is EST, so the ET wall clock is UTC-5.
  const NOW = new Date('2026-11-10T14:00:00Z');
  const OK = { date: '2026-11-12', start: '09:00', reminder24hOn: true };

  it('the cutoff is the server\'s 24.25 hours', () => {
    expect(DAY_PROMISE_CUTOFF_HOURS).toBe(24.25);
  });

  it('the helper line is the phone script only while the box is off, the slot is beyond the cutoff and the reminder will go out', () => {
    expect(askedTimeHint(false, OK, NOW)).toBe(PHONE_SCRIPT_HINT);
    expect(askedTimeHint(undefined, OK, NOW)).toBe(PHONE_SCRIPT_HINT);
    expect(askedTimeHint(true, OK, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(PHONE_SCRIPT_HINT).toBe("Promise the day only: 'We'll text your arrival window the day before.'");
    expect(ASKED_TIME_CHECKED_HINT).toBe('Tell the customer this time.');
  });

  it('inside the cutoff, with the reminder off, with an unknown answer, or with no slot: "Tell the customer this time."', () => {
    // 24.25 h after NOW is Wed 11-11 9:15 AM ET: 9:15 is not beyond it (the server uses <=), 9:30 is.
    expect(askedTimeHint(false, { ...OK, date: '2026-11-11', start: '09:15' }, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, { ...OK, date: '2026-11-11', start: '09:30' }, NOW)).toBe(PHONE_SCRIPT_HINT);
    expect(askedTimeHint(false, { ...OK, date: '2026-11-10', start: '15:00' }, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, { ...OK, reminder24hOn: false }, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, { ...OK, reminder24hOn: undefined }, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, { ...OK, reminder24hOn: null }, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, { ...OK, start: '' }, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, { ...OK, date: '' }, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, { ...OK, timeChosen: false }, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, undefined, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(startsBeyondCutoff(undefined, NOW)).toBe(false);
    expect(dayScriptApplies(null, NOW)).toBe(false);
  });

  it('a MOVE hint follows dayOnlyMoveDecision: a same-date re-time names the window, only a change of date can be the day', () => {
    const move = { ...OK, originalDate: '2026-11-12' }; // beyond the cutoff, reminder on, same date as the visit already has
    expect(askedTimeHint(false, move, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, { ...move, originalDate: '2026-11-12T00:00:00.000Z' }, NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, { ...move, originalDate: '2026-11-11' }, NOW)).toBe(PHONE_SCRIPT_HINT);
    expect(askedTimeHint(false, { ...move, originalDate: undefined }, NOW)).toBe(PHONE_SCRIPT_HINT); // the booking window has none
  });

  it('the reschedule window: a suggestion on the visit\'s own date makes the hint the second line', () => {
    const options = [
      { date: '2026-11-13', suggestedWindow: { start: '08:00' } },
      { date: '2026-11-12', suggestedWindow: { start: '10:00' } },
    ];
    const base = { options, showManual: false, manualDate: '', manualTime: '08:00', reminder24hOn: true };
    expect(rescheduleHintSlot({ ...base, originalDate: '2026-11-12' })).toEqual({ date: '2026-11-12', start: '10:00', reminder24hOn: true, originalDate: '2026-11-12' });
    expect(askedTimeHint(false, rescheduleHintSlot({ ...base, originalDate: '2026-11-12' }), NOW)).toBe(ASKED_TIME_CHECKED_HINT);
    expect(askedTimeHint(false, rescheduleHintSlot({ ...base, originalDate: '2026-11-20' }), NOW)).toBe(PHONE_SCRIPT_HINT);
    expect(askedTimeHint(false, rescheduleHintSlot({ ...base, showManual: true, manualDate: '2026-11-12', manualTime: '11:00', originalDate: '2026-11-12' }), NOW)).toBe(ASKED_TIME_CHECKED_HINT);
  });

  it('the cutoff is judged on the ET wall clock across a DST change', () => {
    // 2026-11-01 01:30 ET fell back; a visit on 11-03 at 10:00 ET from 11-02 08:00 ET is 26+ hours out (EST), beyond the cutoff.
    expect(startsBeyondCutoff({ date: '2026-11-03', start: '10:00' }, new Date('2026-11-02T13:00:00Z'))).toBe(true);
  });

  it('the reschedule window judges the custom slot while that picker is open, else the earliest suggestion', () => {
    const options = [
      { date: '2026-11-13', suggestedWindow: { start: '08:00' } },
      { date: '2026-11-11', suggestedWindow: { start: '09:00' } },
    ];
    expect(rescheduleHintSlot({ options, showManual: false, manualDate: '', manualTime: '08:00', reminder24hOn: true }))
      .toEqual({ date: '2026-11-11', start: '09:00', reminder24hOn: true, originalDate: undefined });
    expect(rescheduleHintSlot({ options, showManual: true, manualDate: '2026-11-20', manualTime: '10:00', reminder24hOn: true }))
      .toEqual({ date: '2026-11-20', start: '10:00', reminder24hOn: true, originalDate: undefined });
    expect(rescheduleHintSlot({ options: [], showManual: false, manualDate: '', manualTime: '08:00' })).toEqual({ date: '', start: '', reminder24hOn: undefined, originalDate: undefined });
  });

  it('the booking window: no customer yet reads on; another customer\'s or a missing answer reads off', () => {
    expect(reminderAnswerFor(null, null)).toBe(true);
    expect(reminderAnswerFor(null, { id: 'c1' })).toBe(false);
    expect(reminderAnswerFor({ id: 'c1', on: true }, { id: 'c1' })).toBe(true);
    expect(reminderAnswerFor({ id: 'c1', on: true }, { id: 'c2' })).toBe(false);
    expect(reminderAnswerFor({ id: 'c1', on: false }, { id: 'c1' })).toBe(false);
  });

  it('the booking window under enforced property texts: the property it books decides, else the customer row', () => {
    const answer = { id: 'c1', on: true, byProperty: { 'p-rental': false, 'p-home': true } };
    expect(reminderAnswerFor(answer, { id: 'c1' }, 'p-rental')).toBe(false);
    expect(reminderAnswerFor(answer, { id: 'c1' }, 'p-home')).toBe(true);
    expect(reminderAnswerFor(answer, { id: 'c1' }, '')).toBe(true);
    expect(reminderAnswerFor(answer, { id: 'c1' }, 'p-primary')).toBe(true);
    expect(reminderAnswerFor({ id: 'c1', on: false, byProperty: { 'p-home': true } }, { id: 'c1' }, '')).toBe(false);
    expect(reminderAnswerFor({ id: 'c1', on: false, byProperty: { 'p-home': true } }, { id: 'c1' }, 'p-home')).toBe(true);
    expect(reminderAnswerFor({ id: 'c1', on: true, byProperty: {} }, { id: 'c1' }, 'p-home')).toBe(true);
  });

  it('the create request carries customerAskedTime only with the gate on AND the box checked', () => {
    expect(askedTimeCreateFields(true, true)).toEqual({ customerAskedTime: true });
    expect(askedTimeCreateFields(true, false)).toEqual({});
    expect(askedTimeCreateFields(false, true)).toEqual({});
    expect(askedTimeCreateFields(undefined, undefined)).toEqual({});
  });

  it('a move request carries true or false with the gate on, nothing with it off', () => {
    expect(askedTimeMoveFields(true, true)).toEqual({ customerAskedTime: true });
    expect(askedTimeMoveFields(true, false)).toEqual({ customerAskedTime: false });
    expect(askedTimeMoveFields(true, undefined)).toEqual({ customerAskedTime: false });
    expect(askedTimeMoveFields(false, true)).toEqual({});
  });

  it('levels day / hour / none map to the badge text, from the promise not the visit\'s window', () => {
    expect(toldBadgeText({ level: 'day', dayOnly: true, date: null, window: null }, '2026-11-10')).toBe('Told: day only');
    expect(toldBadgeText({ level: 'hour', dayOnly: false, date: '2026-11-10', window: '9:00 AM - 11:00 AM' }, '2026-11-10')).toBe('Told: 9:00 AM - 11:00 AM');
    expect(toldBadgeText({ level: 'hour', dayOnly: false, date: null, window: null }, '2026-11-10')).toBe('Told: time not recorded');
    expect(toldBadgeText({ level: 'none', dayOnly: false }, '2026-11-10')).toBe('');
    expect(toldBadgeText(undefined, '2026-11-10')).toBe('');
    expect(toldBadgeText(null, 'x')).toBe('');
  });

  it('a promised date that differs from the visit\'s current date leads the text (a silent move)', () => {
    const told = { level: 'hour', dayOnly: false, date: '2026-11-10', window: '9:00 AM - 11:00 AM' };
    expect(toldBadgeText(told, '2026-11-12')).toBe('Told: Tue, Nov 10, 9:00 AM - 11:00 AM');
    expect(toldBadgeText(told, '2026-11-12T00:00:00.000Z')).toBe('Told: Tue, Nov 10, 9:00 AM - 11:00 AM');
    expect(toldBadgeText(told, '2026-11-10T00:00:00.000Z')).toBe('Told: 9:00 AM - 11:00 AM');
    expect(toldBadgeText({ level: 'day', dayOnly: true, date: '2026-11-10', window: null }, '2026-11-12')).toBe('Told: Tue, Nov 10, day only');
    expect(toldBadgeText({ level: 'day', dayOnly: true, date: '2026-11-10', window: null }, '2026-11-10')).toBe('Told: day only');
  });
});
