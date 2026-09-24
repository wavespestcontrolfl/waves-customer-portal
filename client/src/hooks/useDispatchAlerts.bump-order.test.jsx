// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bumpOrderTieBreak } from './useDispatchAlerts';

describe('bumpOrderTieBreak (tech-out batch ordering)', () => {
  const at = (bump) => ({ created_at: '2026-09-24T12:00:00Z', payload: bump == null ? {} : { bump_order: bump } });

  it('orders a same-timestamp batch by bump_order ascending (#1 first)', () => {
    const rows = [at(3), at(1), at(2)];
    const sorted = [...rows].sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || bumpOrderTieBreak(a, b));
    expect(sorted.map((r) => r.payload.bump_order)).toEqual([1, 2, 3]);
  });

  it('puts rows with a bump_order before same-timestamp rows without one and leaves plain rows equal', () => {
    expect(bumpOrderTieBreak(at(2), at(null))).toBeLessThan(0);
    expect(bumpOrderTieBreak(at(null), at(2))).toBeGreaterThan(0);
    expect(bumpOrderTieBreak(at(null), at(null))).toBe(0);
  });

  it('never outranks recency: a newer plain alert still sorts above an older batch', () => {
    const older = { created_at: '2026-09-24T11:00:00Z', payload: { bump_order: 1 } };
    const newer = { created_at: '2026-09-24T12:00:00Z', payload: {} };
    const sorted = [older, newer].sort((a, b) => (new Date(b.created_at) - new Date(a.created_at)) || bumpOrderTieBreak(a, b));
    expect(sorted[0]).toBe(newer);
  });
});
