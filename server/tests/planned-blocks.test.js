const { attachPlannedBlocks } = require('../services/scheduling/planned-blocks');
const { driveMin } = require('../services/auto-dispatch/geo');

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

// An early departure: the first drive is inside the workday, not before it.
const EARLY = { departureMin: 5 * 60 };

describe('attachPlannedBlocks', () => {
  it('plans each stop at its route arrival for its planned on-site minutes', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const services = [row('a', '08:00', A), row('b', '10:00', B)];
    attachPlannedBlocks(services, EARLY);
    const [a, b] = services;
    // Recurring pest plans 35 minutes, not the booked hour.
    expect(a).toMatchObject({ plannedArrivalMin: 8 * 60, plannedMinutes: 35 });
    // 08:00 + 35 min + the drive A to B is before 10:00: the van waits for the window.
    expect(b).toMatchObject({ plannedArrivalMin: 10 * 60, plannedMinutes: 35 });
  });

  it('runs the first drive from the departure: an 08:00 van to an 08:00 stop lands after the drive', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const home = { lat: 27.0, lng: -82.45 };
    const lead = Math.max(1, driveMin(home, A));
    expect(lead).toBeGreaterThan(20);
    const services = [row('a', '08:00', A)];
    attachPlannedBlocks(services, { departureMin: 8 * 60, home });
    expect(services[0].plannedArrivalMin).toBe(8 * 60 + lead);
    // The default start point is the office and the default departure 08:00.
    const plain = [row('a', '08:00', A)];
    attachPlannedBlocks(plain);
    expect(plain[0].plannedArrivalMin).toBeGreaterThanOrEqual(8 * 60);
    // A different start point gives a different first arrival.
    const far = [row('a', '08:00', A)];
    attachPlannedBlocks(far, { departureMin: 8 * 60, home: { lat: 26.5, lng: -82.0 } });
    expect(far[0].plannedArrivalMin).toBeGreaterThan(services[0].plannedArrivalMin);
  });

  it('carries delay forward and lands a late stop past its start', () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    // Gate off: the booked hour is the work, so 08:00 ends 09:00 and the
    // 08:30 stop starts after the drive, past its own start.
    const services = [row('a', '08:00', A), row('b', '08:30', B)];
    attachPlannedBlocks(services, EARLY);
    const [a, b] = services;
    expect(a).toMatchObject({ plannedArrivalMin: 8 * 60, plannedMinutes: 60 });
    expect(b.plannedArrivalMin).toBeGreaterThan(9 * 60);
    expect(b.plannedMinutes).toBe(60);
  });

  it('follows the displayed order (tie-proximity displayOrder) over window start', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const services = [row('late', '09:00', B, { displayOrder: 1 }), row('early', '09:30', A, { displayOrder: 0 })];
    attachPlannedBlocks(services, EARLY);
    const [late, early] = services;
    expect(early.plannedArrivalMin).toBe(9 * 60 + 30);
    expect(late.plannedArrivalMin).toBeGreaterThan(early.plannedArrivalMin);
  });

  it('is null for rows the model cannot place', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const services = [
      row('done', '08:00', A, { status: 'completed' }),
      row('cx', '08:00', A, { status: 'cancelled' }),
      row('sk', '08:00', A, { status: 'skipped' }),
      row('ns', '08:00', A, { status: 'no_show' }),
      row('untimed', null, A, { windowStart: null, windowEnd: null }),
      row('ok', '11:00', B),
    ];
    attachPlannedBlocks(services, EARLY);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    for (const id of ['done', 'cx', 'sk', 'ns', 'untimed']) {
      expect(by[id]).toMatchObject({ plannedArrivalMin: null, plannedMinutes: null });
    }
    expect(by.ok).toMatchObject({ plannedArrivalMin: 11 * 60, plannedMinutes: 35 });
  });

  it('leaves a stop with no pin, and every stop after the unmeasurable leg, unplanned', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const services = [row('a', '08:00', A), row('nopin', '10:00', null), row('after', '11:00', B)];
    attachPlannedBlocks(services, EARLY);
    expect(services[0]).toMatchObject({ plannedArrivalMin: 8 * 60, plannedMinutes: 35 });
    expect(services[1]).toMatchObject({ plannedArrivalMin: null, plannedMinutes: null });
    expect(services[2]).toMatchObject({ plannedArrivalMin: null, plannedMinutes: null });
    const lone = [row('x', '09:00', null)];
    attachPlannedBlocks(lone, EARLY);
    expect(lone[0].plannedArrivalMin).toBeNull();
  });

  it('plans one stop for the rows of a visit group, which share its arrival and minutes', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const services = [
      row('g1', '10:00', A, { visitId: 'v1' }),
      row('g2', '10:00', A, { visitId: 'v1', serviceTypeRaw: 'Lawn Care' }),
    ];
    attachPlannedBlocks(services, EARLY);
    expect(services[0]).toMatchObject({ plannedArrivalMin: 10 * 60, plannedMinutes: 70 });
    expect(services[1]).toMatchObject({ plannedArrivalMin: 10 * 60, plannedMinutes: 70 });
  });

  it('does not add a return trip for a visit group whose members are not next to each other', () => {
    process.env.GATE_SCHEDULING_CAPACITY = 'plan';
    const services = [
      row('g1', '08:00', A, { visitId: 'v1' }),
      row('mid', '09:00', B),
      row('g2', '08:00', A, { visitId: 'v1', serviceTypeRaw: 'Lawn Care' }),
    ];
    attachPlannedBlocks(services, EARLY);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    expect(by.g1.plannedArrivalMin).toBe(8 * 60);
    expect(by.g2.plannedArrivalMin).toBe(8 * 60);
    // The group is worked once (08:00 + 70), then one drive to the other stop.
    expect(by.mid.plannedArrivalMin).toBe(8 * 60 + 70 + Math.max(1, driveMin(A, B)));
  });

  it('counts a same-customer co-visit once: one stop, its work not doubled', () => {
    delete process.env.GATE_SCHEDULING_CAPACITY;
    const premise = { line1: '1 Test St', line2: null, city: 'Bradenton', zip: '34205' };
    const co = { customerId: 'c1', premise, rawEstimateMinutes: null, estimatedDuration: 60 };
    const services = [row('p', '10:00', A, co), row('l', '10:00', A, { ...co, serviceTypeRaw: 'Lawn Care' }), row('next', '11:00', B)];
    attachPlannedBlocks(services, EARLY);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    expect(by.p).toMatchObject({ plannedArrivalMin: 10 * 60, plannedMinutes: 60 });
    expect(by.l).toMatchObject({ plannedArrivalMin: 10 * 60, plannedMinutes: 60 });
    // One hour at the stop, then the drive; a doubled hour would land past 12:00.
    expect(by.next.plannedArrivalMin).toBe(10 * 60 + 60 + Math.max(1, driveMin(A, B)));
  });

  it('stamps nulls on every row of an empty or unplaceable day', () => {
    const services = [row('a', '08:00', A, { status: 'cancelled' })];
    attachPlannedBlocks(services);
    expect(services[0]).toMatchObject({ plannedArrivalMin: null, plannedMinutes: null });
    expect(() => attachPlannedBlocks([])).not.toThrow();
    expect(() => attachPlannedBlocks(undefined)).not.toThrow();
  });
});

describe('attachPlannedBlocks — a model error never fails the day feed', () => {
  it('leaves null fields when the simulation throws', () => {
    jest.isolateModules(() => {
      jest.doMock('../services/route-reorder-window-fit', () => ({
        ...jest.requireActual('../services/route-reorder-window-fit'),
        simulateArrivalRoute: () => { throw new Error('boom'); },
      }));
      const { attachPlannedBlocks: attach } = require('../services/scheduling/planned-blocks');
      const rows = [{ id: 'x1', status: 'pending', windowStart: '08:00', windowEnd: '09:00', lat: 27.1, lng: -82.4, serviceType: 'Quarterly Pest Control' }];
      expect(() => attach(rows)).not.toThrow();
      expect(rows[0]).toMatchObject({ plannedArrivalMin: null, plannedMinutes: null });
    });
  });
});
