// The ONE new-sod verdict (lawn-new-sod-visit.js): the visit's own day and a POSITIVE
// proof that the visit is at the customer's primary home, shared by the report, the Fast
// Complete context and preview, the job card and the watering text. Synthetic data only.

const { resolveNewSodVerdict, newSodVisitDay } = require('../services/service-report/lawn-new-sod-visit');
const { newSodMode } = require('../services/service-report/lawn-new-sod');
const { HOME, visitFacts, fakeKnex } = require('./helpers/new-sod-fake-knex');

const run = (over = {}, args = {}) => resolveNewSodVerdict(fakeKnex(visitFacts(over)), { customerId: 'c1', serviceRecordId: 'sr-1', ...args });
const stampedAt = (over) => ({ appointment: { ...visitFacts().appointment, ...over } });
const unstamped = (over = {}) => ({
  appointment: { ...visitFacts().appointment, service_address_line1: null, service_address_city: null, service_address_zip: null, ...over },
});

describe('newSodVisitDay: one rule', () => {
  test('the service record day wins, then the appointment day, read as an ET calendar day', () => {
    expect(newSodVisitDay({ serviceDate: '2026-10-22', scheduledDate: '2026-10-25' })).toBe('2026-10-22');
    expect(newSodVisitDay({ serviceDate: null, scheduledDate: new Date('2026-10-25T00:00:00Z') })).toBe('2026-10-25');
    expect(newSodVisitDay({})).toBeNull();
  });
});

describe('resolveNewSodVerdict: active only on a PROVEN primary-home visit inside the window', () => {
  test('a visit stamped with the primary address (unit-aware match) is active, with the visit day on the answer', async () => {
    expect(await run({ record: { ...visitFacts().record, service_date: '2026-10-22' } })).toEqual({
      active: true, laidOn: '2026-10-01', dayNumber: 21, visitDay: '2026-10-22', reason: 'active',
    });
  });

  test('no date: inactive with no visit query spent', async () => {
    const knex = fakeKnex(visitFacts({ prefs: { sod_laid_on: null } }));
    expect(await resolveNewSodVerdict(knex, { customerId: 'c1', serviceRecordId: 'sr-1' })).toMatchObject({ active: false, reason: 'no_date' });
    expect(knex.calls).toEqual(['property_preferences']);
  });

  test('a caller that already holds the preference row is not made to read it again', async () => {
    const knex = fakeKnex(visitFacts());
    const out = await resolveNewSodVerdict(knex, { customerId: 'c1', prefs: { sod_laid_on: '2026-10-01' }, serviceRecordId: 'sr-1' });
    expect(out.active).toBe(true);
    expect(knex.calls).not.toContain('property_preferences');
  });

  test('outside the window is inactive', async () => {
    expect(await run({ record: { ...visitFacts().record, service_date: '2026-10-23' } })).toMatchObject({ active: false, reason: 'outside_window' });
  });
});

describe('the property proof: not demonstrably elsewhere is NOT proof', () => {
  test('a stamp at another address is another property', async () => {
    expect(await run(stampedAt({ service_address_line1: '200 Sample Lane', service_address_zip: '34202' }))).toMatchObject({ active: false, reason: 'other_property' });
  });

  test('the same street with a different unit is another property (the unit counts)', async () => {
    expect(await run({
      customer: { ...HOME, address_line2: 'Apt 4', has_multi_home: false },
      ...stampedAt({ service_address_line2: 'Apt 7' }),
    })).toMatchObject({ active: false, reason: 'other_property' });
    // And the same unit matches.
    expect(await run({
      customer: { ...HOME, address_line2: 'Apt 4', has_multi_home: false },
      ...stampedAt({ service_address_line2: 'Apt 4' }),
    })).toMatchObject({ active: true });
  });

  test('an UNSTAMPED appointment linked by property_id to a secondary property is not the primary', async () => {
    const out = await run({
      ...unstamped({ property_id: 'p2' }),
      propertyById: { p2: { address_line1: '200 Sample Lane', address_line2: null, city: 'Bradenton', zip: '34202' } },
    });
    expect(out).toMatchObject({ active: false, reason: 'other_property' });
  });

  test('an UNSTAMPED appointment linked by property_id to the primary property IS the primary', async () => {
    const out = await run({
      ...unstamped({ property_id: 'p1' }),
      propertyById: { p1: { address_line1: HOME.address_line1, address_line2: null, city: HOME.city, zip: HOME.zip } },
    });
    expect(out).toMatchObject({ active: true });
  });

  test('an UNSTAMPED appointment created from an estimate for a secondary address is not the primary', async () => {
    const out = await run({
      ...unstamped({ source_estimate_id: 'e2' }),
      estimateById: { e2: { address: '200 Sample Lane, Bradenton, FL 34202' } },
    });
    expect(out).toMatchObject({ active: false, reason: 'other_property' });
  });

  test('a link that resolves to nothing (gone property, estimate with no address) is unproven', async () => {
    expect(await run({ ...unstamped({ property_id: 'gone' }) })).toMatchObject({ active: false, reason: 'unproven_property' });
    expect(await run({ ...unstamped({ source_estimate_id: 'e9' }), estimateById: { e9: { address: null } } })).toMatchObject({ active: false, reason: 'unproven_property' });
  });

  test('a stamp with no locality (street only) is unproven', async () => {
    expect(await run(stampedAt({ service_address_city: null, service_address_zip: null }))).toMatchObject({ active: false, reason: 'unproven_property' });
  });

  test('an unstamped, unlinked appointment is the primary ONLY on a proven single-premises account', async () => {
    expect(await run(unstamped())).toMatchObject({ active: true });
    // A second property on file (even inactive) means the visit cannot be placed.
    expect(await run({
      ...unstamped(),
      properties: [
        { address_line1: HOME.address_line1, address_line2: null, city: HOME.city, zip: HOME.zip },
        { address_line1: '200 Sample Lane', address_line2: null, city: 'Bradenton', zip: '34202' },
      ],
    })).toMatchObject({ active: false, reason: 'unproven_property' });
    // The multi-home flag.
    expect(await run({ ...unstamped(), customer: { ...HOME, has_multi_home: true } })).toMatchObject({ active: false, reason: 'unproven_property' });
    // Another visit on the account stamped elsewhere.
    expect(await run({
      ...unstamped(),
      otherAppointments: [{ service_address_line1: '200 Sample Lane', service_address_line2: null, service_address_city: 'Bradenton', service_address_zip: '34202', property_id: null, source_estimate_id: null }],
    })).toMatchObject({ active: false, reason: 'unproven_property' });
  });

  test('a primary address with no locality cannot be compared: unproven', async () => {
    expect(await run({ customer: { ...HOME, city: null, zip: null, has_multi_home: false } })).toMatchObject({ active: false, reason: 'unproven_property' });
  });
});

describe('a visit that cannot be found is unknown, and a thrown read is read_failed', () => {
  test.each([
    ['no such service record', { record: null }],
    ['a record of another customer', { record: { ...visitFacts().record, customer_id: 'c2' } }],
    ['an appointment of another customer', { appointment: { ...visitFacts().appointment, customer_id: 'c2' } }],
    ['no customer row', { customer: null }],
  ])('%s', async (_name, over) => {
    expect(await run(over)).toMatchObject({ active: false, reason: 'unknown_visit' });
  });

  test('no visit id at all, or no usable day', async () => {
    expect(await run({}, { serviceRecordId: null, scheduledServiceId: null })).toMatchObject({ reason: 'unknown_visit' });
    expect(await run({ record: { service_date: null, scheduled_service_id: 'ss-1', customer_id: 'c1' }, appointment: { ...visitFacts().appointment, scheduled_date: null } })).toMatchObject({ reason: 'unknown_visit' });
  });

  test.each(['property_preferences', 'service_records as sr', 'scheduled_services as ss', 'customers as c', 'customer_properties'])('a throw reading %s', async (table) => {
    const out = await run({ ...unstamped(), throwOn: table });
    expect(out).toMatchObject({ active: false, reason: 'read_failed' });
  });

  test('a failed property_id lookup is read_failed, not "another property"', async () => {
    expect(await run({ ...unstamped({ property_id: 'p1' }), throwOn: 'customer_properties' })).toMatchObject({ reason: 'read_failed' });
  });

  test('an appointment-only caller (no record yet) uses the scheduled date', async () => {
    const facts = visitFacts({ record: null });
    const knex = fakeKnex(facts);
    expect(await resolveNewSodVerdict(knex, { customerId: 'c1', scheduledServiceId: 'ss-1' })).toMatchObject({ active: true, visitDay: '2026-10-05' });
    expect(knex.calls).not.toContain('service_records as sr');
  });
});

describe('every surface agrees at the day 21 / day 22 boundary, and a redo cannot move it', () => {
  const ways = [
    ['report', { serviceRecordId: 'sr-1' }],
    ['fast complete + job card', { scheduledServiceId: 'ss-1' }],
    ['watering text', { serviceRecordId: 'sr-1', scheduledServiceId: 'ss-1' }],
  ];
  const factsFor = (way, day) => (way.serviceRecordId
    ? visitFacts({ record: { service_date: day, scheduled_service_id: 'ss-1', customer_id: 'c1' }, appointment: { ...visitFacts().appointment, scheduled_date: day } })
    : visitFacts({ record: null, appointment: { ...visitFacts().appointment, scheduled_date: day } }));

  test.each([
    ['2026-10-22', true],
    ['2026-10-23', false],
    ['2026-10-01', true],
    ['2026-09-30', false],
  ])('sod laid 2026-10-01, visit %s: active=%s on every surface', async (day, expected) => {
    for (const [name, way] of ways) {
      const out = await resolveNewSodVerdict(fakeKnex(factsFor(way, day)), { customerId: 'c1', ...way });
      expect([name, out.active]).toEqual([name, expected]);
      expect(out.active).toBe(newSodMode({ sod_laid_on: '2026-10-01' }, day).active);
    }
  });

  test('the verdict depends only on the visit: no assessment date and no clock is an input', async () => {
    const args = { customerId: 'c1', serviceRecordId: 'sr-1' };
    const first = await resolveNewSodVerdict(fakeKnex(visitFacts()), args);
    jest.useFakeTimers().setSystemTime(new Date('2027-03-01T12:00:00Z'));
    try {
      expect(await resolveNewSodVerdict(fakeKnex(visitFacts()), args)).toEqual(first);
    } finally {
      jest.useRealTimers();
    }
  });
});
