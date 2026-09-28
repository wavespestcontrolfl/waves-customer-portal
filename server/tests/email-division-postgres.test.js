// Email division — DB-backed reads against real migrated Postgres, synthetic
// data only, rolled back per test. Skipped without DATABASE_URL; guarded to
// this worktree's own waves_qa_emaildiv_visitdata or CI's waves_test. The
// literal `const SKIP = !process.env.DATABASE_URL` line is the exact marker
// the CI "DB-gated suites" step greps for (.github/workflows/tests.yml) to
// discover and run this file — without it CI silently skips it forever.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && url.pathname === '/waves_qa_emaildiv_visitdata';
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Email division Postgres tests require this worktree\'s own waves_qa_emaildiv_visitdata or CI\'s waves_test.');
  }
}
const suite = SKIP ? describe.skip : describe;

jest.setTimeout(60000);
const { randomUUID } = require('crypto');
const knex = require('knex');
const { readVisitProducts, readVisitSummary, getActivityRatingAverages } = require('../services/email-division/visit-products');
const { computeAreaIntel, getAreaIntelSentence } = require('../services/email-division/area-intel');

suite('email division against real Postgres', () => {
  let database;
  let trx;

  beforeAll(() => { database = knex({ client: 'pg', connection: testUrl, pool: { min: 0, max: 2 } }); });
  afterAll(async () => { await database?.destroy(); });
  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { await trx.rollback(); });

  async function makeCustomer(overrides = {}) {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Fixture', phone: `qa-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city: 'Parrish', zip: '34219', active: true, ...overrides,
    });
    return id;
  }
  async function makeVisit(customerId, overrides = {}) {
    const id = randomUUID();
    await trx('service_records').insert({
      id, customer_id: customerId, service_date: '2026-09-10', service_type: 'Pest Control',
      technician_notes: 'WHAT WE DID: treated the perimeter.', status: 'completed', ...overrides,
    });
    return id;
  }
  async function makeVisits(customerId, count, overrides = {}) {
    for (let i = 0; i < count; i++) await makeVisit(customerId, overrides);
  }
  // A visit booked/serviced at a property whose stamped city differs from
  // the customer's own (current) city — a rental or second property.
  async function makeVisitAtCity(customerId, serviceAddressCity, overrides = {}) {
    const scheduledServiceId = randomUUID();
    await trx('scheduled_services').insert({
      id: scheduledServiceId, customer_id: customerId, scheduled_date: '2026-09-10',
      service_type: 'Pest Control', status: 'completed', service_address_city: serviceAddressCity,
    });
    return makeVisit(customerId, { scheduled_service_id: scheduledServiceId, ...overrides });
  }

  test('readVisitProducts: classifies, ranks primary/secondary, hides the adjuvant, and lists an unknown product as "other"', async () => {
    const customerId = await makeCustomer();
    const visitId = await makeVisit(customerId);
    const unknownVisitId = await makeVisit(customerId);
    await trx('service_products').insert([
      { id: randomUUID(), service_record_id: visitId, product_name: 'Talstar P', active_ingredient: 'bifenthrin', applied_at: new Date('2026-09-10T10:00:00Z') },
      { id: randomUUID(), service_record_id: visitId, product_name: 'Taurus SC', active_ingredient: 'fipronil', applied_at: new Date('2026-09-10T10:05:00Z') },
      { id: randomUUID(), service_record_id: visitId, product_name: 'LESCO 90/10 nonionic surfactant', active_ingredient: 'nonionic surfactant', applied_at: new Date('2026-09-10T10:10:00Z') },
      { id: randomUUID(), service_record_id: unknownVisitId, product_name: 'Mystery Blend 42', active_ingredient: 'unobtanium' },
      { id: randomUUID(), service_record_id: unknownVisitId, product_name: 'Generic IGR', active_ingredient: 'pyriproxyfen' },
    ]);
    const { products, primary, secondary } = await readVisitProducts(visitId, { conn: trx });
    expect(products).toHaveLength(3);
    expect(products.map((p) => p.family)).toEqual(expect.arrayContaining(['contact_residual', 'non_repellent', 'adjuvant']));
    expect(primary.family).toBe('non_repellent');
    expect(secondary.family).toBe('contact_residual');
    expect(products.find((p) => p.family === 'adjuvant').customerVisible).toBe(false);
    const unknown = await readVisitProducts(unknownVisitId, { conn: trx });
    expect(unknown.products.find((p) => p.productName === 'Mystery Blend 42').family).toBe('other');
    // Same family as Gentrol, but the 120-day claim is hydroprene-specific.
    const pyriproxyfen = unknown.products.find((p) => p.productName === 'Generic IGR');
    expect(pyriproxyfen).toMatchObject({ family: 'igr', verified: false, notes: [] });
  });

  test('readVisitProducts: scopes bifenthrin/Talstar-P label facts to bifenthrin products only, never Delta Dust or Demand CS', async () => {
    const customerId = await makeCustomer();
    const visitId = await makeVisit(customerId);
    await trx('service_products').insert([
      { id: randomUUID(), service_record_id: visitId, product_name: 'Talstar P', active_ingredient: 'bifenthrin', applied_at: new Date('2026-09-10T10:00:00Z') },
      { id: randomUUID(), service_record_id: visitId, product_name: 'Delta Dust', active_ingredient: 'deltamethrin', applied_at: new Date('2026-09-10T10:15:00Z') },
      { id: randomUUID(), service_record_id: visitId, product_name: 'Demand CS', active_ingredient: 'lambda-cyhalothrin', applied_at: new Date('2026-09-10T10:20:00Z') },
    ]);
    const { products } = await readVisitProducts(visitId, { conn: trx });
    const talstar = products.find((p) => p.productName === 'Talstar P');
    expect(talstar).toMatchObject({ family: 'contact_residual', verified: true });
    expect(talstar.dryRule?.hours).toBe(24);
    expect(talstar.factSlugs.length).toBeGreaterThan(0);
    for (const name of ['Delta Dust', 'Demand CS']) {
      const p = products.find((prod) => prod.productName === name);
      // Same family (still shown, still ranked as contact_residual) but the
      // Talstar-P-specific "spray has dried" rain instruction and its fact
      // slugs never ride along on a dust or a different active ingredient.
      expect(p).toMatchObject({ family: 'contact_residual', verified: false, dryRule: null, notes: [], factSlugs: [] });
    }
  });

  test('readVisitSummary: structured fields, advisory/conditions keys, and pests named', async () => {
    const customerId = await makeCustomer();
    const visitId = await makeVisit(customerId, {
      service_line: 'pest', visit_number: 3, client_pest_rating: 4,
      technician_notes: 'WHAT WE DID: treated for ghost, big-headed, and crazy ants along the foundation.',
      structured_notes: { areasTreated: ['exterior', 'garage'] },
      advisory: { pet_advisory: 'Keep pets off treated areas until dry.', exterior_reentry_min: 30, interior_reentry_min: 0, irrigation_hold_hr: 24 },
      conditions: { temp_f: 88, rain_24h_in: 0.1 },
    });
    // An abandoned 'rescheduled' row dated EARLIER than the live replacement
    // — including it would wrongly return the obsolete date as "next".
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: '2026-11-01', service_type: 'Pest Control', status: 'rescheduled',
    });
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: '2026-12-10', service_type: 'Pest Control', status: 'confirmed',
    });
    const summary = await readVisitSummary(visitId, { conn: trx });
    expect(summary.customerId).toBe(customerId);
    expect(summary.serviceLine).toBe('pest');
    expect(summary.areasTreated).toEqual(['exterior', 'garage']);
    expect(summary.pestsNamed).toEqual(expect.arrayContaining(['ghost ants', 'big-headed ants', 'crazy ants']));
    expect(summary.activityRating).toBe(4);
    expect(summary.advisory).toEqual({ petAdvisory: 'Keep pets off treated areas until dry.', exteriorReentryMin: 30, interiorReentryMin: 0, irrigationHoldHr: 24 });
    expect(summary.conditions).toEqual({ tempF: 88, rain24hIn: 0.1 });
    const nextDate = summary.nextVisitDate instanceof Date
      ? summary.nextVisitDate.toISOString().slice(0, 10) : String(summary.nextVisitDate).slice(0, 10);
    expect(nextDate).toBe('2026-12-10'); // never the earlier, abandoned 'rescheduled' row
  });

  test('getActivityRatingAverages: partitions by service_line and omits a cohort with fewer than 20 rated visits', async () => {
    const customerId = await makeCustomer();
    // Pest visit #1: 25 ratings of 5 (>= 20 -> included).
    await makeVisits(customerId, 25, { visit_number: 1, service_line: 'pest', client_pest_rating: 5, service_date: '2026-09-01' });
    // Pest visit #2: only 3 ratings (< 20 -> omitted).
    await makeVisits(customerId, 3, { visit_number: 2, service_line: 'pest', client_pest_rating: 1, service_date: '2026-09-02' });
    // Mosquito visit #1: 15 ratings of 2 — same visit_number (1) as the pest
    // cohort above but a DIFFERENT program. 15 + 25 would clear the 20-visit
    // floor if wrongly combined; each service_line must clear it on its own,
    // so this cohort alone (15 < 20) stays omitted and never drags the pest
    // #1 average toward it.
    await makeVisits(customerId, 15, { visit_number: 1, service_line: 'mosquito', client_pest_rating: 2, service_date: '2026-09-03' });
    const { byVisit, counts } = await getActivityRatingAverages({ conn: trx });
    expect(byVisit.pest[1]).toBe(5);
    expect(counts.pest[1]).toBe(25);
    expect(byVisit.pest[2]).toBeUndefined();
    expect(byVisit.mosquito?.[1]).toBeUndefined();
  });

  // Four cities, one recompute: Ellenton (4 visits, below the 5-visit floor
  // -> no rows), Parrish (54 visits, 35 (~65%) name big-headed ants -> the
  // worked-example sentence), Nocatee (10 visits, 100% flea mentions but
  // below minVisits -> null), Bradenton (25 visits, only 1 (4%) names a
  // pest, below the 10% floor -> null).
  test('computeAreaIntel + getAreaIntelSentence: 5-visit floor, minVisits, 10% floor, exact wording', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    const sentenceMonth = new Date('2026-09-20T12:00:00Z');
    const ellenton = await makeCustomer({ city: 'Ellenton' });
    await makeVisits(ellenton, 4, { service_date: '2026-09-05', technician_notes: 'WHAT WE DID: treated for fire ants.' });
    const parrish = await makeCustomer({ city: 'Parrish' });
    await makeVisits(parrish, 35, { service_date: '2026-09-05', technician_notes: 'WHAT WE DID: treated for big-headed ants.' });
    await makeVisits(parrish, 19, { service_date: '2026-09-06', technician_notes: 'WHAT WE DID: general perimeter treatment, no activity found.' });
    const nocatee = await makeCustomer({ city: 'Nocatee' });
    await makeVisits(nocatee, 10, { service_date: '2026-09-05', technician_notes: 'WHAT WE DID: treated for fleas.' });
    const bradenton = await makeCustomer({ city: 'Bradenton' });
    await makeVisits(bradenton, 24, { service_date: '2026-09-05', technician_notes: 'WHAT WE DID: general perimeter treatment, no activity found.' });
    await makeVisit(bradenton, { service_date: '2026-09-06', technician_notes: 'WHAT WE DID: treated for a single wasp nest.' });
    // Stale row from a prior recompute; must not survive a fresh one.
    await trx('email_area_intel_monthly').insert({ month: '2026-09-01', city: 'venice', visits: 40, pest_key: 'fleas', visits_with_pest: 30 });
    const result = await computeAreaIntel({ month, conn: trx });
    expect(await trx('email_area_intel_monthly').where({ city: 'venice' })).toHaveLength(0);
    expect(result.citiesProcessed).toBe(3); // Ellenton never gets a row
    expect(await trx('email_area_intel_monthly').where({ city: 'ellenton' })).toHaveLength(0);
    const parrishRows = await trx('email_area_intel_monthly').where({ city: 'parrish' });
    expect(parrishRows.find((r) => r.pest_key === 'big-headed ants').visits_with_pest).toBe(35);
    expect(parrishRows[0].visits).toBe(54);
    await expect(getAreaIntelSentence({ city: 'Parrish', month: sentenceMonth, conn: trx })).resolves
      .toBe('In September our technicians treated big-headed ants at 65% of our 54 visits in Parrish.');
    await expect(getAreaIntelSentence({ city: 'Nocatee', month: sentenceMonth, minVisits: 20, conn: trx })).resolves.toBeNull();
    await expect(getAreaIntelSentence({ city: 'Bradenton', month: sentenceMonth, conn: trx })).resolves.toBeNull();
  });

  test('computeAreaIntel: excludes non-performed (incomplete) service records from both counts', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    const customerId = await makeCustomer({ city: 'Oneco' });
    await makeVisits(customerId, 5, { service_date: '2026-09-05', technician_notes: 'WHAT WE DID: treated for fleas.', status: 'completed' });
    // An office-handoff closeout for a visit that did NOT happen — must not
    // inflate the denominator or seed a pest count of its own.
    await makeVisits(customerId, 3, { service_date: '2026-09-06', technician_notes: 'WHAT WE DID: treated for ticks.', status: 'incomplete' });
    await computeAreaIntel({ month, conn: trx });
    const rows = await trx('email_area_intel_monthly').where({ city: 'oneco' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visits: 5, pest_key: 'fleas', visits_with_pest: 5 });
    expect(rows.find((r) => r.pest_key === 'ticks')).toBeUndefined();
  });

  test('computeAreaIntel: attributes a visit to the booked service_address_city, not the customer\'s own city', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    // The account's primary/current city is Bradenton, but every visit was
    // booked and serviced at a Venice rental — the immutable booking-time
    // stamp, not the account's mirror address, decides the city.
    const customerId = await makeCustomer({ city: 'Bradenton' });
    for (let i = 0; i < 5; i++) {
      await makeVisitAtCity(customerId, 'Venice', { service_date: '2026-09-05', technician_notes: 'WHAT WE DID: treated for fleas.' });
    }
    await computeAreaIntel({ month, conn: trx });
    expect(await trx('email_area_intel_monthly').where({ city: 'bradenton' })).toHaveLength(0);
    const veniceRows = await trx('email_area_intel_monthly').where({ city: 'venice' });
    expect(veniceRows).toMatchObject([{ visits: 5, pest_key: 'fleas', visits_with_pest: 5 }]);
  });

  test('getAreaIntelSentence: applies the 10% floor to the unrounded ratio, not the rounded percentage', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    const sentenceMonth = new Date('2026-09-20T12:00:00Z');
    // 2/21 = 9.52% — rounds to "10%" but must still fail the floor.
    const customerId = await makeCustomer({ city: 'Palmetto' });
    await makeVisits(customerId, 2, { service_date: '2026-09-05', technician_notes: 'WHAT WE DID: treated for fleas.' });
    await makeVisits(customerId, 19, { service_date: '2026-09-06', technician_notes: 'WHAT WE DID: general perimeter treatment, no activity found.' });
    await computeAreaIntel({ month, conn: trx });
    const rows = await trx('email_area_intel_monthly').where({ city: 'palmetto' });
    expect(rows).toMatchObject([{ visits: 21, pest_key: 'fleas', visits_with_pest: 2 }]);
    await expect(getAreaIntelSentence({ city: 'Palmetto', month: sentenceMonth, minVisits: 5, conn: trx })).resolves.toBeNull();
  });
});
