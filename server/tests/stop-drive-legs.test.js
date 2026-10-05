const { attachDriveLegs } = require('../services/scheduling/stop-drive-legs');
const { driveMin } = require('../services/auto-dispatch/geo');

const A = { lat: 27.52, lng: -82.45 };
const B = { lat: 27.40, lng: -82.50 };
const C = { lat: 27.30, lng: -82.40 };

function stop(id, windowStart, geo, extra = {}) {
  return { id, windowStart, status: 'confirmed', lat: geo ? geo.lat : null, lng: geo ? geo.lng : null, ...extra };
}

describe('attachDriveLegs', () => {
  it('gives each stop its leg in and out in day order, first and last marked', () => {
    const services = [stop('c', '13:00', C), stop('a', '08:00', A), stop('b', '10:00', B)];
    attachDriveLegs(services);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    expect(by.a).toMatchObject({ firstStop: true, lastStop: false, driveFromPrevMin: null, driveToNextMin: driveMin(A, B) });
    expect(by.b).toMatchObject({ driveFromPrevMin: driveMin(A, B), driveToNextMin: driveMin(B, C) });
    expect(by.c).toMatchObject({ firstStop: false, lastStop: true, driveFromPrevMin: driveMin(B, C), driveToNextMin: null });
    expect(driveMin(A, B)).toBeGreaterThan(0);
  });

  it('shares legs across one physical stop and skips cancelled rows', () => {
    const services = [
      stop('a', '08:00', A),
      stop('b1', '10:00', B, { visitId: 'v1' }),
      stop('b2', '10:00', B, { visitId: 'v1' }),
      stop('x', '11:00', A, { status: 'cancelled' }),
      stop('ns', '12:00', A, { status: 'no_show' }),
      stop('c', '13:00', C),
    ];
    attachDriveLegs(services);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    // The group's legs ride on its first card only.
    expect(by.b1).toMatchObject({ driveFromPrevMin: driveMin(A, B), driveToNextMin: driveMin(B, C) });
    expect(by.b2).toMatchObject({ driveFromPrevMin: null, driveToNextMin: null, firstStop: false, lastStop: false });
    expect(by.x).toMatchObject({ driveFromPrevMin: null, driveToNextMin: null, firstStop: false, lastStop: false });
    expect(by.ns).toMatchObject({ driveFromPrevMin: null, driveToNextMin: null, firstStop: false, lastStop: false });
  });

  it('leaves a leg null, never 0, when a stop has no coordinates', () => {
    const services = [stop('a', '08:00', A), stop('b', '10:00', null), stop('c', '13:00', C)];
    attachDriveLegs(services);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    expect(by.a.driveToNextMin).toBeNull();
    expect(by.b).toMatchObject({ driveFromPrevMin: null, driveToNextMin: null });
    expect(by.c.driveFromPrevMin).toBeNull();
  });

  it('follows the tie-proximity display order over window start', () => {
    const services = [
      stop('nine', '09:00', B, { displayOrder: 1 }),
      stop('nine-thirty', '09:30', A, { displayOrder: 0 }),
      stop('noon', '12:00', C, { displayOrder: 2 }),
    ];
    attachDriveLegs(services);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    expect(by['nine-thirty']).toMatchObject({ firstStop: true, driveToNextMin: driveMin(A, B) });
    expect(by.nine).toMatchObject({ firstStop: false, driveFromPrevMin: driveMin(A, B), driveToNextMin: driveMin(B, C) });
    expect(by.noon.lastStop).toBe(true);
  });

  it('keeps a visit group one stop even when another visit sorts between its rows', () => {
    const services = [
      stop('g1', '08:00', A, { visitId: 'v1' }),
      stop('mid', '09:00', B),
      stop('g2', '10:00', A, { visitId: 'v1' }),
      stop('c', '13:00', C),
    ];
    attachDriveLegs(services);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    expect(by.g1).toMatchObject({ firstStop: true, driveToNextMin: driveMin(A, B) });
    // The later member's card claims nothing, so nothing points backwards.
    expect(by.g2).toMatchObject({ firstStop: false, lastStop: false, driveFromPrevMin: null, driveToNextMin: null });
    expect(by.mid).toMatchObject({ driveFromPrevMin: driveMin(A, B), driveToNextMin: driveMin(B, C) });
  });

  it('treats a 0/0 pin as no location', () => {
    const services = [stop('a', '08:00', A), stop('zero', '10:00', { lat: 0, lng: 0 })];
    attachDriveLegs(services);
    expect(services[0].driveToNextMin).toBeNull();
    expect(services[1].driveFromPrevMin).toBeNull();
  });

  it('locates a group by a member with a pin, skips all-day stops, and floors a short hop at 1 min', () => {
    const near = { lat: A.lat + 0.0001, lng: A.lng };
    const services = [
      stop('g1', '08:00', null, { visitId: 'v1' }),
      stop('g2', '08:00', A, { visitId: 'v1' }),
      stop('allday', null, C),
      stop('n', '10:00', near),
    ];
    attachDriveLegs(services);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    expect(by.g1.driveToNextMin).toBe(Math.max(1, driveMin(A, near)));
    expect(by.g1.driveToNextMin).toBeGreaterThanOrEqual(1);
    expect(by.allday).toMatchObject({ driveFromPrevMin: null, driveToNextMin: null, firstStop: false, lastStop: false });
    expect(by.n).toMatchObject({ lastStop: true, driveFromPrevMin: by.g1.driveToNextMin });
  });

  it('stamps each leg once with the stop it comes from', () => {
    const services = [
      stop('a', '08:00', A, { customerName: 'Sample A' }),
      stop('b1', '10:00', B, { visitId: 'v1', customerName: 'Sample B' }),
      stop('b2', '10:00', B, { visitId: 'v1', customerName: 'Sample B' }),
      stop('c', '13:00', C, { customerName: 'Sample C' }),
    ];
    attachDriveLegs(services);
    const by = Object.fromEntries(services.map((s) => [s.id, s]));
    expect(by.a).toMatchObject({ driveInShown: false, drivePrevName: null });
    expect(by.b1).toMatchObject({ driveInShown: true, drivePrevName: 'Sample A', drivePrevIds: ['a'] });
    expect(by.b2).toMatchObject({ driveInShown: false, drivePrevName: null });
    expect(by.c).toMatchObject({ driveInShown: true, drivePrevName: 'Sample B' });
  });

  it('flags late only past the 2-hour arrival window, not the start time', () => {
    const leg = Math.max(1, driveMin(A, C));
    // Previous work ends at 12:00. A stop starting at 12:30 has a window to
    // 14:30, so a leg that lands after 12:30 but before 14:30 is on time.
    const onTime = [stop('a', '11:00', A, { windowEnd: '12:00' }), stop('c', '12:30', C)];
    attachDriveLegs(onTime);
    expect(leg).toBeGreaterThan(0);
    expect(onTime[1].driveLateMin).toBeNull();
    // The work ends late enough that the same leg misses the window.
    const late = [stop('a', '11:00', A, { windowEnd: '14:25' }), stop('c', '12:30', C)];
    attachDriveLegs(late);
    expect(late[1].driveLateMin).toBe(14 * 60 + 25 + leg - (12 * 60 + 30 + 120));
    // A visit the tech already reached is never flagged.
    const reached = [stop('a', '11:00', A, { windowEnd: '14:25' }), stop('c', '12:30', C, { status: 'in_progress' })];
    attachDriveLegs(reached);
    expect(reached[1].driveLateMin).toBeNull();
  });

  it('uses duration, else one hour, when the previous stop has no window end', () => {
    const services = [stop('a', '08:00', A, { estimatedDuration: 180 }), stop('c', '09:00', C)];
    attachDriveLegs(services);
    const leg = services[1].driveFromPrevMin;
    expect(services[1].driveLateMin).toBe(8 * 60 + 180 + leg - (9 * 60 + 120));
  });

  it('runs a group\'s rows one after another before the next drive', () => {
    const services = [
      stop('g1', '09:00', A, { visitId: 'v1', windowEnd: '10:00' }),
      stop('g2', '09:00', A, { visitId: 'v1', windowEnd: '10:00' }),
      stop('c', '09:00', C),
    ];
    attachDriveLegs(services);
    const leg = services[2].driveFromPrevMin;
    // Two 60-minute rows leave at 11:00, not 10:00.
    expect(services[2].driveLateMin).toBe(11 * 60 + leg - (9 * 60 + 120));
  });

  it('keeps ungrouped rows at one pin on their own planned end (no phantom hour)', () => {
    const same = { customerId: 'cust-1', address: '1 Sample St, Parrish, FL 34219' };
    const services = [
      stop('r1', '09:00', A, { windowEnd: '10:00', ...same }),
      stop('r2', '09:00', A, { windowEnd: '10:00', ...same }),
      stop('c', '09:00', C),
    ];
    attachDriveLegs(services);
    const leg = services[2].driveFromPrevMin;
    const late = 10 * 60 + leg - (9 * 60 + 120);
    expect(services[2].driveLateMin).toBe(late > 0 ? late : null);
  });

  it('marks a leg it cannot measure', () => {
    const services = [stop('a', '08:00', A), stop('b', '10:00', null), stop('c', '13:00', C)];
    attachDriveLegs(services);
    expect(services.map((s) => s.driveLegUnknown)).toEqual([false, true, true]);
  });

  it('sums real estimates of ungrouped rows at one pin', () => {
    const same = { customerId: 'cust-1', address: '1 Sample St, Parrish, FL 34219' };
    const services = [
      stop('r1', '09:00', A, { estimatedDuration: 90, ...same }),
      stop('r2', '09:00', A, { estimatedDuration: 90, ...same }),
      stop('c', '10:00', C),
    ];
    attachDriveLegs(services);
    const leg = services[2].driveFromPrevMin;
    // Two 90-minute jobs leave at 12:00; the 10:00 window closes at 12:00.
    expect(services[2].driveLateMin).toBe(12 * 60 + leg - (10 * 60 + 120));
  });

  it('counts a real 60-minute estimate but not the feed\'s 60 fill', () => {
    const same = { customerId: 'cust-1', address: '1 Sample St, Parrish, FL 34219' };
    const real = [
      stop('r1', '09:00', A, { estimatedDuration: 60, rawEstimateMinutes: 60, windowEnd: '09:30', ...same }),
      stop('r2', '09:00', A, { estimatedDuration: 60, rawEstimateMinutes: 60, windowEnd: '09:30', ...same }),
      stop('c', '09:00', C),
    ];
    attachDriveLegs(real);
    const leg = real[2].driveFromPrevMin;
    const lateReal = 11 * 60 + leg - (9 * 60 + 120);
    expect(real[2].driveLateMin).toBe(lateReal > 0 ? lateReal : null);
    const filled = [
      stop('r1', '09:00', A, { estimatedDuration: 60, rawEstimateMinutes: null, windowEnd: '09:30', ...same }),
      stop('r2', '09:00', A, { estimatedDuration: 60, rawEstimateMinutes: null, windowEnd: '09:30', ...same }),
      stop('c', '09:00', C),
    ];
    attachDriveLegs(filled);
    const lateFilled = 9 * 60 + 30 + leg - (9 * 60 + 120);
    expect(filled[2].driveLateMin).toBe(lateFilled > 0 ? lateFilled : null);
  });

  it('adds up two visit groups and a loose row that share one pin', () => {
    const services = [
      stop('g1', '09:00', A, { visitId: 'v1', windowEnd: '09:30' }),
      stop('h1', '09:00', A, { visitId: 'v2', windowEnd: '09:30' }),
      stop('x', '09:00', A, { windowEnd: '09:30' }),
      stop('c', '09:00', C),
    ];
    attachDriveLegs(services);
    const leg = services[3].driveFromPrevMin;
    // 30 + 30 + 30 minutes of work from 09:00: the tech leaves at 10:30.
    const late = 10 * 60 + 30 + leg - (9 * 60 + 120);
    expect(services[3].driveLateMin).toBe(late > 0 ? late : null);
  });

  it('carries a delay forward to every later stop', () => {
    const services = [
      stop('a', '08:00', A, { windowEnd: '11:00' }),
      stop('b', '09:00', B, { windowEnd: '10:00' }),
      stop('c', '10:00', C, { windowEnd: '11:00' }),
    ];
    attachDriveLegs(services);
    const [ab, bc] = [services[1].driveFromPrevMin, services[2].driveFromPrevMin];
    const arriveB = 11 * 60 + ab;
    expect(services[1].driveLateMin).toBe(arriveB - (9 * 60 + 120));
    // b cannot leave before its late arrival plus its hour of work.
    expect(services[2].driveLateMin).toBe(arriveB + 60 + bc - (10 * 60 + 120));
  });

  it('plans recognized services at owner planning minutes under the capacity gate', () => {
    const before = process.env.GATE_SCHEDULING_CAPACITY;
    process.env.GATE_SCHEDULING_CAPACITY = 'true';
    try {
      const services = [
        stop('a', '08:00', A, { windowEnd: '11:00', serviceTypeRaw: 'Quarterly Pest Control', isRecurring: true }),
        stop('c', '08:00', C),
      ];
      attachDriveLegs(services);
      // Recurring pest plans at 25 minutes, not the 3-hour window span.
      expect(services[1].driveLateMin).toBeNull();
      process.env.GATE_SCHEDULING_CAPACITY = 'false';
      attachDriveLegs(services);
      expect(services[1].driveLateMin).toBe(11 * 60 + services[1].driveFromPrevMin - (8 * 60 + 120));
    } finally {
      if (before === undefined) delete process.env.GATE_SCHEDULING_CAPACITY;
      else process.env.GATE_SCHEDULING_CAPACITY = before;
    }
  });

  it('stops predicting lateness after a leg it cannot measure', () => {
    const services = [
      stop('a', '08:00', A, { windowEnd: '12:00' }),
      stop('x', '09:00', null),
      stop('c', '09:00', C),
    ];
    attachDriveLegs(services);
    expect(services[2].driveLateMin).toBeNull();
  });

  it('adds up rows at one pin that are not one customer\'s co-visit', () => {
    const services = [
      stop('u1', '09:00', A, { windowEnd: '10:00', customerId: 'cust-1', address: '1 Sample St, Unit 1' }),
      stop('u2', '09:00', A, { windowEnd: '10:00', customerId: 'cust-2', address: '1 Sample St, Unit 2' }),
      stop('c', '09:00', C),
    ];
    attachDriveLegs(services);
    // Two customers in one building: two hours of work, leaving at 11:00.
    expect(services[2].driveLateMin).toBe(11 * 60 + services[2].driveFromPrevMin - (9 * 60 + 120));
  });

  it('keeps a later window at the same pin: the tech waits for it', () => {
    const services = [
      stop('m', '09:00', A, { windowEnd: '10:00', customerId: 'cust-1', address: '1 Sample St', displayOrder: 0 }),
      stop('pm', '13:00', A, { windowEnd: '14:00', customerId: 'cust-1', address: '1 Sample St', displayOrder: 1 }),
      stop('c', '11:00', C, { displayOrder: 2 }),
    ];
    attachDriveLegs(services);
    const leg = services[2].driveFromPrevMin;
    // The 13:00 visit cannot start at 10:00: the tech leaves the pin at 14:00.
    expect(services[2].driveLateMin).toBe(14 * 60 + leg - (11 * 60 + 120));
  });

  it('keeps each member promise of a staggered visit group', () => {
    const services = [
      stop('g1', '09:00', A, { visitId: 'v1', windowEnd: '10:00' }),
      stop('g2', '11:00', A, { visitId: 'v1', windowEnd: '12:00' }),
      stop('c', '10:00', C, { displayOrder: 2 }),
    ];
    services[0].displayOrder = 0;
    services[1].displayOrder = 1;
    attachDriveLegs(services);
    const leg = services[2].driveFromPrevMin;
    // Arrive 10:00 so the 11:00 member starts on time; leave at 12:00.
    expect(services[2].driveLateMin).toBe(12 * 60 + leg - (10 * 60 + 120));
  });

  it('waits for a group member whose window no single arrival can keep', () => {
    const services = [
      stop('g1', '09:00', A, { visitId: 'v1', windowEnd: '10:00', displayOrder: 0 }),
      stop('g2', '13:00', A, { visitId: 'v1', windowEnd: '14:00', displayOrder: 1 }),
      stop('c', '11:00', C, { displayOrder: 2 }),
    ];
    attachDriveLegs(services);
    const leg = services[2].driveFromPrevMin;
    // The tech waits for the 13:00 member and leaves at 14:00.
    expect(services[2].driveLateMin).toBe(14 * 60 + leg - (11 * 60 + 120));
  });
});
