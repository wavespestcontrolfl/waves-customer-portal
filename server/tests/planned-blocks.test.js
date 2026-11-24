const { attachPlannedBlocks } = require('../services/scheduling/planned-blocks');

const A = { lat: 27.52, lng: -82.45 };
const B = { lat: 27.40, lng: -82.50 };

const SAVED = process.env.GATE_SCHEDULING_CAPACITY;
afterEach(() => {
  if (SAVED === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
  else process.env.GATE_SCHEDULING_CAPACITY = SAVED;
});

// A day-feed row: a booked one-hour window, the way the board holds a visit.
function row(id, windowStart, geo, extra = {}) {
  const startH = windowStart ? Number(windowStart.slice(0, 2)) : 0;
  return {
    id, windowStart, windowEnd: `${String(startH + 1).padStart(2, '0')}:${windowStart ? windowStart.slice(3) : '00'}`, status: 'confirmed',
    lat: geo ? geo.lat : null, lng: geo ? geo.lng : null,
    estimatedDuration: 60, rawEstimateMinutes: null, serviceTypeRaw: 'Pest Control', isRecurring: true,
    ...extra,
  };
}

describe('attachPlannedBlocks', () => {
  it('plans each stop at its route arrival for its planned on-site minutes', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const services = [row('a', '08:00', A), row('b', '10:00', B)];
    attachPlannedBlocks(services);
    const [a, b] = services;
    // Recurring pest plans 35 minutes, not the booked hour.
    expect(a).toMatchObject({ plannedArrivalMin: 8 * 60, plannedMinutes: 35 });
    // 08:00 + 35 min + the drive A to B is before 10:00: the van waits for the window.
    expect(b).toMatchObject({ plannedArrivalMin: 10 * 60, plannedMinutes: 35 });
  });

  it('carries delay forward and lands a late stop past its start', () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    // Gate off: the booked hour is the work, so 08:00 ends 09:00 and the
    // 08:30 stop starts after the drive, past its own start.
    const services = [row('a', '08:00', A), row('b', '08:30', B)];
    attachPlannedBlocks(services);
    const [a, b] = services;
    expect(a).toMatchObject({ plannedArrivalMin: 8 * 60, plannedMinutes: 60 });
    expect(b.plannedArrivalMin).toBeGreaterThan(9 * 60);
    expect(b.plannedMinutes).toBe(60);
  });

  it('follows the displayed order (tie-proximity displayOrder) over window start', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const services = [row('late', '09:00', B, { displayOrder: 1 }), row('early', '09:30', A, { displayOrder: 0 })];
    attachPlannedBlocks(services);
    const [late, early] = services;
    expect(early.plannedArrivalMin).toBe(9 * 60 + 30);
    expect(late.plannedArrivalMin).toBeGreaterThan(early.plannedArrivalMin);
  });

  it('is null for rows the model cannot place and never moves the clock for them', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const services = [
      row('done', '08:00', A, { status: 'completed' }),
      row('cx', '08:00', A, { status: 'cancelled' }),
      row('sk', '08:00', A, { status: 'skipped' }),
      row('ns', '08:00', A, { status: 'no_show' }),
      row('untimed', null, A, { windowStart: null, windowEnd: null }),
      row('nopin', '10:00', null),
      row('ok', '11:00', B),
    ];
    attachPlannedBlocks(services);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    for (const id of ['done', 'cx', 'sk', 'ns', 'untimed', 'nopin']) {
      expect(by[id]).toMatchObject({ plannedArrivalMin: null, plannedMinutes: null });
    }
    expect(by.ok).toMatchObject({ plannedArrivalMin: 11 * 60, plannedMinutes: 35 });
  });

  it('stacks the rows of one visit group one after another at the same pin', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const services = [
      row('g1', '10:00', A, { visitId: 'v1' }),
      row('g2', '10:00', A, { visitId: 'v1', serviceTypeRaw: 'Lawn Care' }),
    ];
    attachPlannedBlocks(services);
    expect(services[0]).toMatchObject({ plannedArrivalMin: 10 * 60, plannedMinutes: 35 });
    expect(services[1]).toMatchObject({ plannedArrivalMin: 10 * 60 + 35, plannedMinutes: 35 });
  });

  it('stamps nulls on every row of an empty or unplaceable day', () => {
    const services = [row('a', '08:00', A, { status: 'cancelled' })];
    attachPlannedBlocks(services);
    expect(services[0]).toMatchObject({ plannedArrivalMin: null, plannedMinutes: null });
    expect(() => attachPlannedBlocks([])).not.toThrow();
    expect(() => attachPlannedBlocks(undefined)).not.toThrow();
  });
});
