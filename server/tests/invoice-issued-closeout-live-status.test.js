// isLiveVisitStatus — the ONE null-tolerant predicate for "is this visit
// still live/open" (Codex round 16 P2 #4131), shared by
// resolveVisitForIssuedInvoice (invoice-issued-closeout.js) and the locked
// closeout recheck (complete-scheduled-service.js), which used to accept
// only the string statuses and threw issued_visit_in_progress on a legacy
// NULL-status visit the resolver had just admitted. No mocks needed — pure
// function, same OPEN_VISIT_STATUSES source both call sites derive from.
const { isLiveVisitStatus, isArrivedVisitStatus, OPEN_VISIT_STATUSES, ARRIVED_VISIT_STATUSES } = require('../services/invoice-issued-closeout');

describe('isLiveVisitStatus', () => {
  test('a NULL (or undefined) status is live — the repository\'s legacy live-visit convention', () => {
    expect(isLiveVisitStatus(null)).toBe(true);
    expect(isLiveVisitStatus(undefined)).toBe(true);
  });

  test('every OPEN_VISIT_STATUSES entry is live', () => {
    for (const status of OPEN_VISIT_STATUSES) {
      expect(isLiveVisitStatus(status)).toBe(true);
    }
  });

  test('a terminal/in-progress status is not live', () => {
    for (const status of ['completed', 'cancelled', 'canceled', 'en_route', 'on_site', 'no_show']) {
      expect(isLiveVisitStatus(status)).toBe(false);
    }
  });
});

describe('isArrivedVisitStatus', () => {
  test('on_site is the only arrived status — en_route has not reached the property (owner 2026-10-04)', () => {
    expect(ARRIVED_VISIT_STATUSES).toEqual(['on_site']);
    expect(isArrivedVisitStatus('on_site')).toBe(true);
    for (const status of [null, undefined, 'pending', 'confirmed', 'en_route', 'completed', 'cancelled']) {
      expect(isArrivedVisitStatus(status)).toBe(false);
    }
  });

  test('no status is both unstarted and arrived', () => {
    for (const status of [...OPEN_VISIT_STATUSES, ...ARRIVED_VISIT_STATUSES]) {
      expect(isLiveVisitStatus(status) && isArrivedVisitStatus(status)).toBe(false);
    }
  });
});
