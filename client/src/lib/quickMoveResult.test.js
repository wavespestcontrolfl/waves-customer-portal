import { describe, expect, it } from 'vitest';
import { summarizeQuickMoveResult } from './quickMoveResult';

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
