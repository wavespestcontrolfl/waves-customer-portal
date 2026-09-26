/**
 * Rodent trapping visit allowance (owner ruling 2026-09-26): $350 covers
 * the setup visit + 1 trap check; visit 3+ is the $95 "Rodent Trap Check -
 * Additional" row. Jobs sold before 2026-09-27 are grandfathered. The
 * booking modal reads trappingJobStatus to advise the office.
 */
const {
  isGrandfathered,
  trappingJobStatus,
  TRAP_CHECK_FEE_EFFECTIVE_DATE,
  INCLUDED_TRAPPING_VISITS,
  TRAP_CHECK_ADDITIONAL_PRICE,
} = require('../services/rodent-trap-check');
const { RODENT } = require('../services/pricing-engine/constants');

// Returns the given rows for any query; the SQL filters (customer, window,
// keys, active statuses) are the database's job — this pins the job slicing
// and grandfathering that run on the returned rows.
function fakeDb(rows) {
  const q = {
    join: () => q, leftJoin: () => q, where: () => q, whereIn: () => q, whereNotIn: () => q, orderBy: () => q,
    select: async () => rows,
  };
  return () => q;
}

describe('rodent trap check allowance', () => {
  test('the $95 row price matches the engine copy constant', () => {
    expect(TRAP_CHECK_ADDITIONAL_PRICE).toBe(RODENT.trapping.additionalCheckPrice);
    expect(INCLUDED_TRAPPING_VISITS).toBe(1 + RODENT.trapping.includedFollowUps);
  });

  test('grandfathering keys off the estimate acceptance, else the opener date', () => {
    expect(TRAP_CHECK_FEE_EFFECTIVE_DATE).toBe('2026-09-27');
    expect(isGrandfathered({ acceptedAt: '2026-09-20T15:00:00Z', openerDate: '2026-10-01' })).toBe(true);
    expect(isGrandfathered({ acceptedAt: '2026-09-28T15:00:00Z', openerDate: '2026-09-20' })).toBe(false);
    expect(isGrandfathered({ acceptedAt: null, openerDate: '2026-09-26' })).toBe(true);
    expect(isGrandfathered({ acceptedAt: null, openerDate: '2026-09-27' })).toBe(false);
    expect(isGrandfathered({})).toBe(false);
  });

  test('setup + 1 check are included; the next visit is billable', async () => {
    const rows = [
      { id: 'a', scheduled_date: '2026-10-01', service_key: 'rodent_trapping', accepted_at: '2026-09-29T12:00:00Z' },
      { id: 'b', scheduled_date: '2026-10-08', service_key: 'rodent_trapping_followup', accepted_at: null },
    ];
    const one = await trappingJobStatus(fakeDb(rows.slice(0, 1)), 'c', { today: '2026-10-05' });
    expect(one).toMatchObject({ hasJob: true, visitCount: 1, nextVisitBillable: false, grandfathered: false });
    const two = await trappingJobStatus(fakeDb(rows), 'c', { today: '2026-10-09' });
    expect(two).toMatchObject({ visitCount: 2, nextVisitBillable: true, additionalCheckPrice: 95 });
  });

  test('a grandfathered job never suggests the paid check', async () => {
    const rows = [
      { id: 'a', scheduled_date: '2026-09-20', service_key: 'rodent_trapping', accepted_at: '2026-09-18T12:00:00Z' },
      { id: 'b', scheduled_date: '2026-09-27', service_key: 'rodent_trapping_followup', accepted_at: null },
      { id: 'c', scheduled_date: '2026-10-04', service_key: 'rodent_trapping_followup', accepted_at: null },
    ];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { today: '2026-10-05' });
    expect(status).toMatchObject({ visitCount: 3, grandfathered: true, nextVisitBillable: false });
  });

  test('a newer opener starts a fresh job count', async () => {
    const rows = [
      { id: 'a', scheduled_date: '2026-09-01', service_key: 'rodent_trapping', accepted_at: '2026-08-30T12:00:00Z' },
      { id: 'b', scheduled_date: '2026-09-08', service_key: 'rodent_trapping_followup', accepted_at: null },
      { id: 'c', scheduled_date: '2026-10-10', service_key: 'rodent_trapping_exclusion', accepted_at: '2026-10-08T12:00:00Z' },
    ];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { today: '2026-10-12' });
    expect(status).toMatchObject({ openerDate: '2026-10-10', visitCount: 1, grandfathered: false, nextVisitBillable: false });
  });

  test('no trapping visits means no job', async () => {
    const status = await trappingJobStatus(fakeDb([]), 'c', { today: '2026-10-12' });
    expect(status).toMatchObject({ hasJob: false, visitCount: 0, nextVisitBillable: false });
  });
});
