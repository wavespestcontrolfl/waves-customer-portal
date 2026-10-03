// The ONE new-sod verdict (lawn-new-sod-visit.js): the visit's own day and the
// visit's own property, shared by the report, the Fast Complete context and preview,
// the job card and the watering text. Table-driven agreement at the day 21 / day 22
// boundary, a redo that does not move the verdict, and the unknown / divergent rules.
// Synthetic data only.

const { resolveNewSodVerdict, newSodVisitDay } = require('../services/service-report/lawn-new-sod-visit');
const { newSodMode } = require('../services/service-report/lawn-new-sod');

// A fake knex answering the preference read and the visit-identity read.
function fakeKnex({ prefs, identity, throwOn = null }) {
  const calls = [];
  const knex = (table) => {
    calls.push(table);
    const q = {};
    for (const m of ['where', 'leftJoin', 'join']) q[m] = () => q;
    q.first = async () => {
      if (throwOn === table) throw new Error('connection reset');
      return table === 'property_preferences' ? prefs : identity;
    };
    return q;
  };
  knex.raw = (sql) => sql;
  knex.calls = calls;
  return knex;
}
const ID = (over = {}) => ({ service_date: '2026-10-22', scheduled_date: '2026-10-22', ss_id: 'ss-1', address_diverges: false, ...over });

describe('newSodVisitDay: one rule', () => {
  test('the service record day wins, then the appointment day, read as an ET calendar day', () => {
    expect(newSodVisitDay({ serviceDate: '2026-10-22', scheduledDate: '2026-10-25' })).toBe('2026-10-22');
    expect(newSodVisitDay({ serviceDate: null, scheduledDate: new Date('2026-10-25T00:00:00Z') })).toBe('2026-10-25');
    expect(newSodVisitDay({})).toBeNull();
  });
});

describe('resolveNewSodVerdict', () => {
  const run = (opts, args = {}) => resolveNewSodVerdict(fakeKnex(opts), { customerId: 'c1', serviceRecordId: 'sr-1', ...args });

  test('active at the home inside the window, with the visit day on the answer', async () => {
    expect(await run({ prefs: { sod_laid_on: '2026-10-01' }, identity: ID() })).toEqual({
      active: true, laidOn: '2026-10-01', dayNumber: 21, visitDay: '2026-10-22', reason: 'active',
    });
  });

  test('no date: inactive with no identity query spent', async () => {
    const knex = fakeKnex({ prefs: { sod_laid_on: null }, identity: ID() });
    expect(await resolveNewSodVerdict(knex, { customerId: 'c1', serviceRecordId: 'sr-1' })).toMatchObject({ active: false, reason: 'no_date' });
    expect(knex.calls).toEqual(['property_preferences']);
  });

  test('a caller that already holds the preference row is not made to read it again', async () => {
    const knex = fakeKnex({ prefs: null, identity: ID() });
    const out = await resolveNewSodVerdict(knex, { customerId: 'c1', prefs: { sod_laid_on: '2026-10-01' }, serviceRecordId: 'sr-1' });
    expect(out.active).toBe(true);
    expect(knex.calls).not.toContain('property_preferences');
  });

  test('another property (divergent stamped address) is never active', async () => {
    expect(await run({ prefs: { sod_laid_on: '2026-10-01' }, identity: ID({ address_diverges: true }) })).toMatchObject({ active: false, reason: 'divergent_address' });
  });

  test.each([
    ['no linked appointment', ID({ ss_id: null })],
    ['an address that cannot be judged', ID({ address_diverges: null })],
    ['no such visit', null],
    ['no usable day', ID({ service_date: null, scheduled_date: null })],
  ])('unknown is never active: %s', async (_name, identity) => {
    expect(await run({ prefs: { sod_laid_on: '2026-10-01' }, identity })).toMatchObject({ active: false, reason: 'unknown_visit' });
  });

  test('no visit id at all is unknown', async () => {
    expect(await run({ prefs: { sod_laid_on: '2026-10-01' }, identity: ID() }, { serviceRecordId: null, scheduledServiceId: null })).toMatchObject({ reason: 'unknown_visit' });
  });

  test('a query that throws is read_failed, never an exception', async () => {
    for (const throwOn of ['property_preferences', 'service_records as sr']) {
      expect(await run({ prefs: { sod_laid_on: '2026-10-01' }, identity: ID(), throwOn })).toMatchObject({ active: false, reason: 'read_failed' });
    }
  });

  test('an appointment-only caller (no record yet) uses the scheduled date', async () => {
    const knex = fakeKnex({ prefs: { sod_laid_on: '2026-10-01' }, identity: { scheduled_date: '2026-10-22', address_diverges: false } });
    expect(await resolveNewSodVerdict(knex, { customerId: 'c1', scheduledServiceId: 'ss-1' })).toMatchObject({ active: true, visitDay: '2026-10-22' });
    expect(knex.calls).toContain('scheduled_services as ss');
  });
});

describe('every surface agrees at the day 21 / day 22 boundary, and a redo cannot move it', () => {
  // The same visit asked four ways: the report (service record id), the Fast Complete
  // context and preview, the job card (appointment id) and the watering text (record id
  // plus appointment id). All of them call the resolver; they differ only in which id
  // they hold. The verdict must be identical for every one.
  const ways = [
    ['report', { serviceRecordId: 'sr-1' }],
    ['fast complete + job card', { scheduledServiceId: 'ss-1' }],
    ['watering text', { serviceRecordId: 'sr-1', scheduledServiceId: 'ss-1' }],
  ];
  const identityFor = (way, day) => (way.serviceRecordId
    ? ID({ service_date: day, scheduled_date: day })
    : { scheduled_date: day, address_diverges: false });

  test.each([
    ['2026-10-22', true],
    ['2026-10-23', false],
    ['2026-10-01', true],
    ['2026-09-30', false],
  ])('sod laid 2026-10-01, visit %s: active=%s on every surface', async (day, expected) => {
    for (const [name, way] of ways) {
      const out = await resolveNewSodVerdict(fakeKnex({ prefs: { sod_laid_on: '2026-10-01' }, identity: identityFor(way, day) }), { customerId: 'c1', ...way });
      expect([name, out.active]).toEqual([name, expected]);
      // And it is exactly the pure window rule applied to the visit's own day.
      expect(out.active).toBe(newSodMode({ sod_laid_on: '2026-10-01' }, day).active);
    }
  });

  test('the verdict depends only on the visit: nothing about an assessment, its capture day or the clock is an input', async () => {
    // The resolver takes no assessment date and reads none. A redo (new capture day) changes
    // nothing it sees, so the same call answers the same on every day.
    const args = { customerId: 'c1', serviceRecordId: 'sr-1' };
    const first = await resolveNewSodVerdict(fakeKnex({ prefs: { sod_laid_on: '2026-10-01' }, identity: ID() }), args);
    jest.useFakeTimers().setSystemTime(new Date('2027-03-01T12:00:00Z'));
    try {
      const later = await resolveNewSodVerdict(fakeKnex({ prefs: { sod_laid_on: '2026-10-01' }, identity: ID() }), args);
      expect(later).toEqual(first);
    } finally {
      jest.useRealTimers();
    }
  });
});
