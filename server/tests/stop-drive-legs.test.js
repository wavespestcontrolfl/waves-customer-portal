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
});
