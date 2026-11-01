import { describe, expect, it } from 'vitest';
import {
  customerFirstName, customerLastName, pickNotTextedMessage, pickSentMessage,
  summarizeCustomerPickResult, summarizeQuickMoveResult, usablePick,
} from './quickMoveResult';

const display = 'Today, 3:00 PM-4:00 PM';
const ok = (id, extra = {}) => ({ id, ok: true, smsSent: true, ...extra });

describe('summarizeQuickMoveResult', () => {
  it('reads a clean single move as done, with nothing to follow up', () => {
    const r = summarizeQuickMoveResult({ movedCount: 1, results: [ok('a')] }, { notify: true, display });
    expect(r.summary).toBe(`Moved 1 stop to ${display}, customer texted`);
    expect(r.message).toBe(r.summary);
    expect(r.needsAttention).toBe(false);
    expect(r.followUps).toEqual([]);
  });

  it('says nothing about texts when the tech did not ask for one', () => {
    const r = summarizeQuickMoveResult({ movedCount: 2, results: [ok('a', { smsSent: false }), ok('b', { smsSent: false })] }, { notify: false, display });
    expect(r.summary).toBe(`Moved 2 stops to ${display}`);
    expect(r.needsAttention).toBe(false);
  });

  it('flags a partial move and names the stop that was not moved', () => {
    const r = summarizeQuickMoveResult({
      movedCount: 1, failedCount: 1,
      results: [ok('a'), { id: 'b', ok: false, error: 'slot taken' }],
    }, { notify: true, display, stopName: (id) => ({ a: 'Ames', b: 'Baker' }[id]) });
    expect(r.needsAttention).toBe(true);
    expect(r.failedCount).toBe(1);
    expect(r.message).toContain('1 stop could not be moved');
    expect(r.followUps).toEqual([{ id: 'b', name: 'Baker', issues: ['Not moved — review dispatch'] }]);
  });

  it('flags customers who were moved but not texted, and counts texts that really went out', () => {
    const r = summarizeQuickMoveResult({
      movedCount: 3,
      results: [ok('a'), ok('b', { smsSent: false }), ok('c', { smsSent: false })],
    }, { notify: true, display, stopName: (id) => `Stop ${id}` });
    expect(r.notTexted).toBe(true);
    expect(r.summary).toBe(`Moved 3 stops to ${display}, 1/3 texted`);
    expect(r.message).toContain('NOT texted');
    expect(r.followUps.map((f) => f.name)).toEqual(['Stop b', 'Stop c']);
  });

  it('says no customer was texted when none were', () => {
    const r = summarizeQuickMoveResult({ movedCount: 1, results: [ok('a', { smsSent: false })] }, { notify: true, display });
    expect(r.summary).toBe(`Moved 1 stop to ${display}, customer NOT texted`);
    expect(r.followUps[0].name).toBe('A stop on this route');
  });

  it('carries the dated overlap warnings, from the top level or from each stop', () => {
    const top = summarizeQuickMoveResult({
      movedCount: 1, overlapWarnings: ['2099-01-02 overlaps Cole.'], results: [ok('a')],
    }, { notify: true, display });
    expect(top.needsAttention).toBe(true);
    expect(top.overlapCount).toBe(1);
    expect(top.message).toContain('2099-01-02 overlaps Cole. Check the route on that day.');

    const perStop = summarizeQuickMoveResult({
      movedCount: 2, results: [ok('a', { warnings: ['w1'] }), ok('b', { warnings: ['w2'] })],
    }, { notify: true, display, stopName: (id) => id.toUpperCase() });
    expect(perStop.overlapCount).toBe(2);
    expect(perStop.message).toContain('Check the route on those days.');
    expect(perStop.followUps).toEqual([
      { id: 'a', name: 'A', issues: ['w1'] },
      { id: 'b', name: 'B', issues: ['w2'] },
    ]);
  });

  it('does not ask for a text from a stop its visit already carried', () => {
    const r = summarizeQuickMoveResult({
      movedCount: 1, coveredCount: 1,
      results: [ok('a'), { id: 'b', ok: true, coveredByVisit: 'a', smsSent: false }],
    }, { notify: true, display });
    expect(r.needsAttention).toBe(false);
  });
});

describe('customer pick helpers', () => {
  it('reads the first name from the options payload, then the props, then the full name', () => {
    // The field rain-out.js getOptions actually sends wins over every fallback.
    expect(customerFirstName({ service: { customerFirstName: 'Dee', firstName: 'Ada' } }, { customerName: 'Bo Fixture' })).toBe('Dee');
    expect(customerFirstName({ service: { firstName: 'Ada' } }, { customerName: 'Bo Fixture' })).toBe('Ada');
    expect(customerFirstName({}, { first_name: 'Cy', customer_name: 'Bo Fixture' })).toBe('Cy');
    expect(customerFirstName({}, { customer_name: ' Bo  Fixture ' })).toBe('Bo');
    expect(customerFirstName({}, {})).toBe('the customer');
  });

  it('reads the surname for a card heading and keeps a one-word name whole', () => {
    expect(customerLastName({ customerName: 'Bo Van Fixture' })).toBe('Van Fixture');
    expect(customerLastName({ customer_name: 'Fixture' })).toBe('Fixture');
    expect(customerLastName({})).toBe('Customer');
  });

  it('offers the pick only when the payload says so and the reason is not custom', () => {
    const customerPick = { available: true, pickByLabel: 'Wed 8 PM' };
    expect(usablePick({ customerPick }, 'weather_rain')).toBe(customerPick);
    expect(usablePick({ customerPick }, 'custom')).toBeNull();
    expect(usablePick({ customerPick: { available: false } }, 'weather_rain')).toBeFalsy();
    expect(usablePick({}, 'weather_rain')).toBeFalsy();
  });

  it('words the success and the not-texted messages exactly', () => {
    expect(pickSentMessage('Ada', { offRoute: true })).toBe('Texted Ada to pick a day. Stop taken off your route.');
    expect(pickSentMessage('Ada')).toBe('Texted Ada to pick a day.');
    expect(pickNotTextedMessage('Ada')).toBe('Handed off, but Ada was NOT texted — call them so they can pick a time.');
  });
});

describe('summarizeCustomerPickResult', () => {
  it('reads a texted hand-off as clean and parent-compatible', () => {
    const r = summarizeCustomerPickResult({ ok: true, pickBy: '2099-01-03T01:00:00Z', textSent: true }, { first: 'Ada', offRoute: true });
    expect(r).toMatchObject({
      summary: 'Texted Ada to pick a day. Stop taken off your route.', needsAttention: false, notTexted: false,
      movedCount: 1, failedCount: 0, overlapCount: 0, followUps: [], pickBy: '2099-01-03T01:00:00Z',
    });
  });

  it('keeps a hand-off whose text did not go out on screen', () => {
    const r = summarizeCustomerPickResult({ ok: true, textSent: false }, { first: 'Ada' });
    expect(r).toMatchObject({ needsAttention: true, notTexted: true, message: 'Handed off, but Ada was NOT texted — call them so they can pick a time.' });
  });

  it('treats any needsAttention row as follow-up and lists its lines', () => {
    const r = summarizeCustomerPickResult({
      ok: true, textSent: true, needsAttention: ['No phone on file', { issue: 'Template off' }, { issues: ['A', 'B'] }],
    }, { first: 'Ada' });
    expect(r.needsAttention).toBe(true);
    expect(r.followUps).toEqual([{ id: 'customer-pick', name: 'Ada', issues: ['No phone on file', 'Template off', 'A', 'B'] }]);
  });
});
