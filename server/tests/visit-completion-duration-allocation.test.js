const { buildVisitDurationAllocation } = require('../services/visit-completion-packets');

const T0 = '2026-09-12T14:00:00.000Z';
const T59 = '2026-09-12T14:59:00.000Z';

function member(id, estimate, extra = {}) {
  return { id, estimated_duration_minutes: estimate, status: 'on_site', ...extra };
}

function item(serviceId, body = {}) {
  return { serviceId, body };
}

describe('visit closeout duration allocation', () => {
  test('splits the measured integer total by estimate using deterministic largest remainders', () => {
    const result = buildVisitDurationAllocation({
      visit: { arrived_at: T0 },
      members: [member('b', 30), member('a', 60)],
      items: [item('b'), item('a')],
      actor: { techRole: 'technician' },
      completedAt: T59,
    });

    expect(result).toMatchObject({ source: 'visit_arrived_at', totalMinutes: 59, explicitMinutes: 0 });
    expect(result.items).toEqual([
      { serviceId: 'a', estimatedMinutes: 60, allocatedMinutes: 39 },
      { serviceId: 'b', estimatedMinutes: 30, allocatedMinutes: 20 },
    ]);
    expect(result.items.reduce((sum, row) => sum + row.allocatedMinutes, 0)).toBe(59);
  });

  test('breaks equal fractional ties by service id', () => {
    const result = buildVisitDurationAllocation({
      visit: { arrived_at: T0 },
      members: [member('b', 30), member('a', 30)],
      items: [item('b'), item('a')],
      actor: {}, completedAt: '2026-09-12T14:01:00.000Z',
    });
    expect(result.items.map((row) => [row.serviceId, row.allocatedMinutes]))
      .toEqual([['a', 1], ['b', 0]]);
  });

  test('gives missing estimates zero beside known weights and splits equally when every estimate is missing', () => {
    const partlyKnown = buildVisitDurationAllocation({
      visit: { arrived_at: T0 },
      members: [member('a', null), member('b', 30)],
      items: [item('a'), item('b')], actor: {}, completedAt: T59,
    });
    expect(partlyKnown.items.map((row) => row.allocatedMinutes)).toEqual([0, 59]);

    const allMissing = buildVisitDurationAllocation({
      visit: { arrived_at: T0 },
      members: [member('a', null), member('b', 0)],
      items: [item('a'), item('b')], actor: {}, completedAt: T59,
    });
    expect(allMissing.items.map((row) => row.allocatedMinutes)).toEqual([30, 29]);
  });

  test('freezes unknown without a live-member start and ignores retained history as a timing anchor', () => {
    const result = buildVisitDurationAllocation({
      visit: {},
      members: [
        member('live', 30),
        member('historical', 30, { arrived_at: T0 }),
        member('retained', 30, { status: 'cancelled', arrived_at: T0 }),
      ],
      items: [item('live'), item('historical', { backfill: true, timeOnSite: 30 })],
      actor: { techRole: 'admin' }, completedAt: T59,
    });
    expect(result).toMatchObject({ source: 'unavailable', startedAt: null, totalMinutes: null });
    expect(result.items).toEqual([{ serviceId: 'live', estimatedMinutes: 30, allocatedMinutes: null }]);
  });

  test('rounds a positive sub-minute visit to a real zero allocation', () => {
    const result = buildVisitDurationAllocation({
      visit: { arrived_at: T0 }, members: [member('a', 30)], items: [item('a')], actor: {},
      completedAt: '2026-09-12T14:00:20.000Z',
    });
    expect(result.totalMinutes).toBe(0);
    expect(result.items[0].allocatedMinutes).toBe(0);
  });

  test('preserves valid admin overrides and allocates only the measured remainder', () => {
    const result = buildVisitDurationAllocation({
      visit: { arrived_at: T0 },
      members: [member('a', 30), member('b', 30)],
      items: [item('a', { timeOnSite: 20 }), item('b')],
      actor: { techRole: 'admin' }, completedAt: T59,
    });
    expect(result).toMatchObject({ totalMinutes: 59, explicitMinutes: 20 });
    expect(result.items).toEqual([{ serviceId: 'b', estimatedMinutes: 30, allocatedMinutes: 39 }]);
  });

  test('uses the reliable existing end for a recordless status-only completion', () => {
    const result = buildVisitDurationAllocation({
      visit: { arrived_at: T0 },
      members: [
        member('a', 30, { status: 'completed', actual_end_time: '2026-09-12T14:20:00.000Z' }),
        member('b', 30, { status: 'completed', completed_at: '2026-09-12T14:30:00.000Z' }),
      ],
      items: [item('a'), item('b')], actor: {}, completedAt: T59,
    });
    expect(result).toMatchObject({
      completedAtSource: 'existing_member_ends',
      completedAt: '2026-09-12T14:30:00.000Z', totalMinutes: 30,
    });
  });
});
