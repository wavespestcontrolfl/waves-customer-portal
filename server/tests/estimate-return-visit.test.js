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

  test('a removal after the previous visit is named; one before it is not', () => {
    const out = buildReturnVisitPayload({
      sessions: [s('2026-08-30T10:00:00Z', '2026-08-30T10:20:00Z'), s('2026-09-01T12:00:00Z')],
      estimateData: {
        serviceOptOut: {
          events: [
            { serviceKey: 'mosquito', label: 'Mosquito', included: false, at: '2026-08-30T10:10:00Z' },
            { serviceKey: 'lawn_care', label: 'Lawn Care', included: false, at: '2026-08-31T08:00:00Z' },
            { serviceKey: 'lawn_care', label: 'Lawn Care', included: true, at: '2026-08-31T08:30:00Z' },
          ],
        },
      },
    });
    expect(out.changes.map((c) => c.kind)).toEqual(['service_removed', 'service_restored']);
    expect(out.changes[0].label).toBe('You removed Lawn Care; the price below reflects that.');
    expect(out.changes[1].label).toBe('You added Lawn Care back; the price below reflects that.');
  });

  test('labels fall back to the opt-out label map when the event carries none', () => {
    const out = buildReturnVisitPayload({
      sessions: [s('2026-08-30T10:00:00Z'), s('2026-09-01T12:00:00Z')],
      estimateData: { serviceOptOut: { events: [{ serviceKey: 'pest_control', included: false, at: '2026-08-31T08:00:00Z' }] } },
    });
    expect(out.changes[0].label).toContain('Pest Control');
  });

  test('an extension granted after the previous visit is named, ordered by time', () => {
    const out = buildReturnVisitPayload({
      sessions: [s('2026-08-30T10:00:00Z'), s('2026-09-01T12:00:00Z')],
      estimateData: { serviceOptOut: { events: [{ serviceKey: 'mosquito', label: 'Mosquito', included: false, at: '2026-08-31T09:00:00Z' }] } },
      extensionAutoGrantedAt: '2026-08-31T08:00:00Z',
    });
    expect(out.changes.map((c) => c.kind)).toEqual(['extension_granted', 'service_removed']);
    expect(out.changes[0].label).toBe('Your expiration date was extended.');
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

  test('malformed sessions and events are dropped, not thrown', () => {
    const out = buildReturnVisitPayload({
      sessions: [s('2026-08-30T10:00:00Z'), null, { endedAt: 'garbage' }, s('2026-09-01T12:00:00Z')],
      estimateData: { serviceOptOut: { events: [null, { serviceKey: 'lawn_care', included: false, at: 'nope' }] } },
    });
    expect(out.visitNumber).toBe(2);
    expect(out.changes).toEqual([]);
  });
});
