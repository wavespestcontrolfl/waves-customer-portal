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

// Returns the given rows per table; the SQL filters (customer, keys,
// active statuses) are the database's job — this pins the job slicing and
// grandfathering that run on the returned rows.
function fakeDb(rows, records = [], addons = null) {
  const make = (result) => {
    const q = {
      join: () => q, leftJoin: () => q, where: () => q, whereIn: () => q, whereNotIn: () => q,
      orderBy: () => q, limit: () => q,
      select: async () => result,
    };
    return q;
  };
  const db = (table) => {
    if (table === 'service_records') return make(records);
    // Add-on query returns the same visits by default — dedupe must hold.
    if (String(table).startsWith('scheduled_service_addons')) return make(addons ?? rows);
    return make(rows);
  };
  db.raw = (sql) => sql;
  return db;
}

const everyPremise = () => true;
const report = (type) => ({ typedReportSnapshot: { values: { trap_visit_type: type } } });

describe('rodent trap check allowance', () => {
  test('the $95 row price matches the engine copy constant', () => {
    expect(TRAP_CHECK_ADDITIONAL_PRICE).toBe(RODENT.trapping.additionalCheckPrice);
    expect(INCLUDED_TRAPPING_VISITS).toBe(1 + RODENT.trapping.includedFollowUps);
  });

  test('grandfathering keys off the estimate acceptance, else the opener date', () => {
    expect(TRAP_CHECK_FEE_EFFECTIVE_DATE).toBe('2026-09-27');
    expect(isGrandfathered({ acceptedAt: '2026-09-20', openerDate: '2026-10-01' })).toBe(true);
    expect(isGrandfathered({ acceptedAt: '2026-09-28', openerDate: '2026-09-20' })).toBe(false);
    expect(isGrandfathered({ acceptedAt: null, openerDate: '2026-09-26' })).toBe(true);
    expect(isGrandfathered({ acceptedAt: null, openerDate: '2026-09-27' })).toBe(false);
    expect(isGrandfathered({})).toBe(false);
  });

  test('dates come back from SQL as ET calendar text, never a host-zone Date', async () => {
    const seen = [];
    const q = fakeDb([])('scheduled_services');
    q.select = async (...cols) => { seen.push(...cols); return []; };
    await trappingJobStatus(Object.assign(() => q, { raw: (sql) => sql }), 'c', { premiseMatcher: everyPremise, today: '2026-10-05' });
    expect(seen).toContain("to_char(ss.scheduled_date, 'YYYY-MM-DD') as scheduled_day");
    expect(seen).toContain("to_char(e.accepted_at AT TIME ZONE 'America/New_York', 'YYYY-MM-DD') as accepted_day");
  });

  test('a job opened ON the effective date is not grandfathered', async () => {
    const rows = [{ id: 'a', scheduled_day: '2026-09-27', service_key: 'rodent_trapping', accepted_day: null }];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, today: '2026-09-28' });
    expect(status).toMatchObject({ grandfathered: false, openerDate: '2026-09-27' });
  });

  test('setup + 1 check are included; the next visit is billable', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-10-01', service_key: 'rodent_trapping', accepted_day: '2026-09-29' },
      { id: 'b', scheduled_day: '2026-10-08', service_key: 'rodent_trapping_followup', accepted_day: null },
    ];
    const one = await trappingJobStatus(fakeDb(rows.slice(0, 1)), 'c', { premiseMatcher: everyPremise, today: '2026-10-05' });
    expect(one).toMatchObject({ hasJob: true, visitCount: 1, nextVisitBillable: false, grandfathered: false });
    const two = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, today: '2026-10-09' });
    expect(two).toMatchObject({ visitCount: 2, nextVisitBillable: true, additionalCheckPrice: 95 });
  });

  test('a grandfathered job never suggests the paid check', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-09-20', service_key: 'rodent_trapping', accepted_day: '2026-09-18' },
      { id: 'b', scheduled_day: '2026-09-27', service_key: 'rodent_trapping_followup', accepted_day: null },
      { id: 'c', scheduled_day: '2026-10-04', service_key: 'rodent_trapping_followup', accepted_day: null },
    ];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, today: '2026-10-05' });
    expect(status).toMatchObject({ visitCount: 3, grandfathered: true, nextVisitBillable: false });
  });

  test('a plain rodent_trapping row booked as a check does not reset the job', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-09-20', service_key: 'rodent_trapping', accepted_day: '2026-09-18', source_estimate_id: 'e1' },
      // Same SKU, same estimate — a check, not a new sale.
      { id: 'b', scheduled_day: '2026-09-28', service_key: 'rodent_trapping', accepted_day: '2026-09-18', source_estimate_id: 'e1' },
      // Dispatched follow-up link.
      { id: 'c', scheduled_day: '2026-10-05', service_key: 'rodent_trapping', accepted_day: null, followup_source_service_id: 'b' },
    ];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, today: '2026-10-06' });
    expect(status).toMatchObject({ openerDate: '2026-09-20', visitCount: 3, grandfathered: true, nextVisitBillable: false });
  });

  test('a tech-declared "Follow-up check" on plain rodent_trapping stays in the job', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-10-01', service_key: 'rodent_trapping', accepted_day: '2026-09-29', source_estimate_id: 'e1' },
      { id: 'b', scheduled_day: '2026-10-08', service_key: 'rodent_trapping', accepted_day: null, source_estimate_id: 'e2' },
    ];
    const records = [{ scheduled_service_id: 'b', service_data: JSON.stringify(report('Follow-up check')) }];
    const status = await trappingJobStatus(fakeDb(rows, records), 'c', { premiseMatcher: everyPremise, today: '2026-10-09' });
    expect(status).toMatchObject({ openerDate: '2026-10-01', visitCount: 2, nextVisitBillable: true });
  });

  test('a declared "Initial setup" or a new estimate opens a fresh job', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-09-01', service_key: 'rodent_trapping', accepted_day: '2026-08-30', source_estimate_id: 'e1' },
      { id: 'b', scheduled_day: '2026-09-08', service_key: 'rodent_trapping_followup', accepted_day: null },
      { id: 'c', scheduled_day: '2026-10-01', service_key: 'rodent_trapping', accepted_day: '2026-09-29', source_estimate_id: 'e2' },
    ];
    const byEstimate = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, today: '2026-10-02' });
    expect(byEstimate).toMatchObject({ openerDate: '2026-10-01', visitCount: 1, grandfathered: false });
    const noEstimate = rows.map((r) => ({ ...r, source_estimate_id: null, accepted_day: null }));
    const records = [{ scheduled_service_id: 'c', service_data: report('Initial setup') }];
    const byDeclared = await trappingJobStatus(fakeDb(noEstimate, records), 'c', { premiseMatcher: everyPremise, today: '2026-10-02' });
    expect(byDeclared).toMatchObject({ openerDate: '2026-10-01', visitCount: 1 });
  });

  test('an estimate-linked setup after an office-booked job (no estimate) opens a fresh job', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-09-01', service_key: 'rodent_trapping', accepted_day: null, source_estimate_id: null },
      { id: 'b', scheduled_day: '2026-09-08', service_key: 'rodent_trapping_followup', accepted_day: null },
      { id: 'c', scheduled_day: '2026-10-01', service_key: 'rodent_trapping', accepted_day: '2026-09-29', source_estimate_id: 'e9' },
    ];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, today: '2026-10-02' });
    expect(status).toMatchObject({ openerDate: '2026-10-01', visitCount: 1, grandfathered: false, nextVisitBillable: false });
  });

  test('a combo package opens a fresh job', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-09-01', service_key: 'rodent_trapping', accepted_day: '2026-08-30' },
      { id: 'b', scheduled_day: '2026-09-08', service_key: 'rodent_trapping_followup', accepted_day: null },
      { id: 'c', scheduled_day: '2026-10-10', service_key: 'rodent_trapping_exclusion', accepted_day: '2026-10-08' },
    ];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, today: '2026-10-12' });
    expect(status).toMatchObject({ openerDate: '2026-10-10', visitCount: 1, grandfathered: false, nextVisitBillable: false });
  });

  test('an old grandfathered opener still anchors its job (no lookback window)', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-08-01', service_key: 'rodent_trapping', accepted_day: '2026-07-30' },
      { id: 'b', scheduled_day: '2026-09-15', service_key: 'rodent_trapping_followup', accepted_day: null },
      { id: 'c', scheduled_day: '2026-11-01', service_key: 'rodent_trapping_followup', accepted_day: null },
      { id: 'd', scheduled_day: '2026-12-20', service_key: 'rodent_trapping_followup', accepted_day: null },
    ];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, today: '2026-12-22' });
    expect(status).toMatchObject({ openerDate: '2026-08-01', visitCount: 4, grandfathered: true, nextVisitBillable: false });
  });

  test('checks with no identifiable opener are openerUnknown, never billable', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-10-01', service_key: 'rodent_trapping', accepted_day: '2026-09-29' },
      // 90-day gap — a new run of checks with no setup visit on file.
      { id: 'b', scheduled_day: '2026-12-30', service_key: 'rodent_trapping_followup', accepted_day: null },
      { id: 'c', scheduled_day: '2027-01-06', service_key: 'rodent_trapping_followup', accepted_day: null },
    ];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, today: '2027-01-07' });
    expect(status).toMatchObject({ hasJob: true, openerUnknown: true, visitCount: 2, grandfathered: false, nextVisitBillable: false });
  });

  test('a job whose last visit is past the gap is closed', async () => {
    const rows = [{ id: 'a', scheduled_day: '2026-10-01', service_key: 'rodent_trapping', accepted_day: '2026-09-29' }];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, today: '2026-12-15' });
    expect(status).toMatchObject({ hasJob: false, visitCount: 0 });
  });

  test('visits at another premise never spend this property\'s allowance', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-10-01', service_key: 'rodent_trapping', accepted_day: '2026-09-29', property_id: 'p1' },
      { id: 'b', scheduled_day: '2026-10-08', service_key: 'rodent_trapping_followup', accepted_day: null, property_id: 'p1' },
      { id: 'c', scheduled_day: '2026-10-09', service_key: 'rodent_trapping', accepted_day: '2026-10-07', property_id: 'p2' },
    ];
    const onlyP2 = (r) => r.property_id === 'p2';
    const status = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: onlyP2, today: '2026-10-10' });
    expect(status).toMatchObject({ openerDate: '2026-10-09', visitCount: 1, nextVisitBillable: false });
  });

  test('a trapping line booked as an add-on is a visit', async () => {
    const primaries = [
      { id: 'a', scheduled_day: '2026-10-01', service_key: 'rodent_trapping', accepted_day: '2026-09-29' },
    ];
    const addons = [
      { id: 'b', scheduled_day: '2026-10-08', service_key: 'rodent_trapping_followup', accepted_day: null },
    ];
    const status = await trappingJobStatus(fakeDb(primaries, [], addons), 'c', { premiseMatcher: everyPremise, today: '2026-10-09' });
    expect(status).toMatchObject({ visitCount: 2, nextVisitBillable: true });
  });

  test('the job is resolved as of the booking date, not the latest booking', async () => {
    const rows = [
      { id: 'a', scheduled_day: '2026-10-01', service_key: 'rodent_trapping', accepted_day: '2026-09-29' },
      { id: 'b', scheduled_day: '2026-10-08', service_key: 'rodent_trapping_followup', accepted_day: null },
      // A later, already-booked new setup must not replace the current job.
      { id: 'c', scheduled_day: '2026-11-20', service_key: 'rodent_trapping_exclusion', accepted_day: '2026-11-15' },
    ];
    const status = await trappingJobStatus(fakeDb(rows), 'c', { premiseMatcher: everyPremise, date: '2026-10-15' });
    expect(status).toMatchObject({ openerDate: '2026-10-01', visitCount: 2, nextVisitBillable: true });
  });

  test('the $95 check is excluded from every % discount', () => {
    const { serviceExcludedFromPercentDiscount } = require('../services/pricing-engine/discount-engine');
    expect(serviceExcludedFromPercentDiscount('rodent_trap_check_additional')).toBe(true);
  });

  test('no trapping visits means no job', async () => {
    const status = await trappingJobStatus(fakeDb([]), 'c', { premiseMatcher: everyPremise, today: '2026-10-12' });
    expect(status).toMatchObject({ hasJob: false, visitCount: 0, nextVisitBillable: false });
  });
});
