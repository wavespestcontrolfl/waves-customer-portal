/**
 * Returning-visitor projection (GATE_ESTIMATE_RETURN_VISIT). Invariants:
 *   - a first visit yields nothing (the strip never renders on open #1);
 *   - visitNumber is the SESSION count (five clicks in a sitting are one);
 *   - lastVisitAt is the END of the previous session, and only stamps AFTER
 *     it count as changes;
 *   - a change is only ever named from a durable stamp — no updated_at guess.
 */
const { buildReturnVisitPayload } = require('../services/estimate-return-visit');

const s = (start, end = start) => ({ startedAt: new Date(start), endedAt: new Date(end), viewCount: 1 });

describe('buildReturnVisitPayload', () => {
  test('first visit → null', () => {
    expect(buildReturnVisitPayload({ sessions: [s('2026-09-01T12:00:00Z')], estimateData: {} })).toBeNull();
    expect(buildReturnVisitPayload({ sessions: [], estimateData: {} })).toBeNull();
    expect(buildReturnVisitPayload({})).toBeNull();
  });

  test('visitNumber counts sessions and lastVisitAt is the previous session END', () => {
    const out = buildReturnVisitPayload({
      sessions: [s('2026-08-30T10:00:00Z', '2026-08-30T10:20:00Z'), s('2026-08-31T09:00:00Z', '2026-08-31T09:05:00Z'), s('2026-09-01T12:00:00Z')],
      estimateData: {},
    });
    expect(out).toEqual({ visitNumber: 3, lastVisitAt: '2026-08-31T09:05:00.000Z', changes: [] });
  });

  test('an extension granted after the previous visit is named, ordered by time', () => {
    const out = buildReturnVisitPayload({
      sessions: [s('2026-08-30T10:00:00Z'), s('2026-09-01T12:00:00Z')],
      estimateData: { serviceOptOut: { events: [{ serviceKey: 'mosquito', label: 'Mosquito', included: false, actor: 'customer', at: '2026-08-31T09:00:00Z' }] } },
      extensionAutoGrantedAt: '2026-08-31T08:00:00Z',
    });
    // Opt-out events are not a change source in this PR (customer taps only);
    // the extension grant is.
    expect(out.changes.map((c) => c.kind)).toEqual(['extension_granted']);
    expect(out.changes[0].label).toBe('The expiration date was extended.');
  });

  test('an extension granted BEFORE the previous visit is not a change', () => {
    const out = buildReturnVisitPayload({
      sessions: [s('2026-08-30T10:00:00Z'), s('2026-09-01T12:00:00Z')],
      estimateData: {},
      extensionAutoGrantedAt: '2026-08-29T08:00:00Z',
    });
    expect(out.changes).toEqual([]);
  });

  test('never infers a change from anything but a named stamp', () => {
    const out = buildReturnVisitPayload({
      sessions: [s('2026-08-30T10:00:00Z'), s('2026-09-01T12:00:00Z')],
      estimateData: { updated_at: '2026-08-31T08:00:00Z', preferences: { interior_spray: false }, baseMonthly: 40 },
    });
    expect(out.changes).toEqual([]);
  });

  test('an extension granted inside the post-visit gap is still named (it is not a sitting mutation)', () => {
    const out = buildReturnVisitPayload({
      sessions: [s('2026-08-30T10:00:00Z', '2026-08-30T10:20:00Z'), s('2026-09-01T12:00:00Z')],
      estimateData: {},
      extensionAutoGrantedAt: '2026-08-30T10:30:00Z',
    });
    expect(out.changes.map((c) => c.kind)).toEqual(['extension_granted']);
  });

  test('malformed sessions and events are dropped, not thrown', () => {
    const out = buildReturnVisitPayload({
      sessions: [s('2026-08-30T10:00:00Z'), null, { endedAt: 'garbage' }, s('2026-09-01T12:00:00Z')],
      estimateData: { serviceOptOut: { events: [null, { serviceKey: 'lawn_care', included: false, at: 'nope' }] } },
    });
    expect(out.visitNumber).toBe(2);
    expect(out.changes).toEqual([]);
  });
});
