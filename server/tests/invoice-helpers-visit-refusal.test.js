/**
 * visitRefusesSettlement is unchanged by the extraction of its pure half (neverRanVisitStatus): the same statuses
 * refuse, the same value is returned, a missing visit or id refuses nothing. No database.
 */
const { visitRefusesSettlement, neverRanVisitStatus, VISIT_NEVER_RAN_STATUSES } = require('../services/invoice-helpers');

const trxReturning = (visit) => {
  const chain = { where: () => chain, forUpdate: () => chain, noWait: () => chain, first: async () => visit };
  return () => chain;
};

describe('visitRefusesSettlement and its pure half', () => {
  test('the never-ran statuses refuse and return the normalized status', async () => {
    for (const status of ['cancelled', 'canceled', 'no_show', 'skipped', ' Cancelled ', 'SKIPPED']) {
      expect(await visitRefusesSettlement(trxReturning({ id: 'v', status }), 'v')).toBe(status.trim().toLowerCase());
      expect(neverRanVisitStatus(status)).toBe(status.trim().toLowerCase());
    }
  });

  test('every other status, a missing visit and a missing id refuse nothing', async () => {
    for (const status of ['pending', 'confirmed', 'completed', 'rescheduled', 'en_route', 'on_site', null, undefined, '']) {
      expect(await visitRefusesSettlement(trxReturning({ id: 'v', status }), 'v')).toBeNull();
      expect(neverRanVisitStatus(status)).toBeNull();
    }
    expect(await visitRefusesSettlement(trxReturning(undefined), 'v')).toBeNull();
    expect(await visitRefusesSettlement(trxReturning({ status: 'cancelled' }), null)).toBeNull();
  });

  test('the pure predicate is built on the very list the settlement paths use', () => {
    expect(VISIT_NEVER_RAN_STATUSES).toEqual(['cancelled', 'canceled', 'no_show', 'skipped']);
    for (const status of VISIT_NEVER_RAN_STATUSES) expect(neverRanVisitStatus(status)).toBe(status);
  });
});
