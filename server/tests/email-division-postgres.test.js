// Email division — DB-backed reads against real migrated Postgres, synthetic
// data only, rolled back per test. Skipped without DATABASE_URL; guarded to
// this worktree's own waves_qa_emaildiv_visitdata, a sibling worktree's own
// waves_qa_rating_default clone (owner ruling 2026-09-29, first-visit
// default-flag lane), or CI's waves_test. The literal
// `const SKIP = !process.env.DATABASE_URL` line is the exact marker the CI
// "DB-gated suites" step greps for (.github/workflows/tests.yml) to
// discover and run this file — without it CI silently skips it forever.
const SKIP = !process.env.DATABASE_URL;
const testUrl = process.env.DATABASE_URL;
if (testUrl) {
  const url = new URL(testUrl);
  const localHost = ['localhost', '127.0.0.1'].includes(url.hostname);
  const ownedQA = localHost && ['/waves_qa_emaildiv_visitdata', '/waves_qa_rating_default'].includes(url.pathname);
  const ci = localHost && process.env.CI === 'true' && url.pathname === '/waves_test';
  if (!ownedQA && !ci) {
    throw new Error('Email division Postgres tests require this worktree\'s own waves_qa_emaildiv_visitdata or waves_qa_rating_default, or CI\'s waves_test.');
  }
}
const suite = SKIP ? describe.skip : describe;

jest.setTimeout(60000);
const { randomUUID } = require('crypto');
const knex = require('knex');
const { readVisitProducts, readVisitSummary, getActivityRatingAverages } = require('../services/email-division/visit-products');
const { computeAreaIntel, getAreaIntelSentence } = require('../services/email-division/area-intel');
const { etDateString, addETDays } = require('../utils/datetime-et');

// ET calendar date `days` from today — readVisitSummary's next-visit lower
// bound is max(today ET, service date), so next-visit fixtures must move
// with the real clock; a fixed near-future literal silently expires.
const etDaysFromToday = (days) => etDateString(addETDays(new Date(), days));

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
  // `targets` (optional) records one applied product carrying those
  // structured targets — area intel's only treatment evidence.
  async function makeVisit(customerId, { targets, product = { product_name: 'Bifen I/T', active_ingredient: 'bifenthrin' }, ...overrides } = {}) {
    const id = randomUUID();
    await trx('service_records').insert({
      id, customer_id: customerId, service_date: '2026-09-10', service_type: 'Pest Control',
      technician_notes: 'WHAT WE DID: treated the perimeter.', status: 'completed', ...overrides,
    });
    if (targets) {
      await trx('service_products').insert({ id: randomUUID(), service_record_id: id, ...product, targets });
    }
    return id;
  }
  async function makeVisits(customerId, count, overrides = {}) {
    for (let i = 0; i < count; i++) await makeVisit(customerId, overrides);
  }
  async function makeTechRatedVisits(customerId, count, overrides = {}) {
    return makeVisits(customerId, count, { client_pest_rating_source: 'technician', ...overrides });
  }
  // A visit booked/serviced at a property whose stamped city differs from
  // the customer's own (current) city — a rental or second property. This
  // is the ONLY thing area-intel now reads for city attribution (codex
  // round 10 P2 on #5164) — never customers.city, the mutable primary-
  // property mirror.
  async function makeVisitAtCity(customerId, serviceAddressCity, overrides = {}) {
    const scheduledServiceId = randomUUID();
    await trx('scheduled_services').insert({
      id: scheduledServiceId, customer_id: customerId, scheduled_date: '2026-09-10',
      service_type: 'Pest Control', status: 'completed', service_address_city: serviceAddressCity,
    });
    return makeVisit(customerId, { scheduled_service_id: scheduledServiceId, ...overrides });
  }
  // `count` DISTINCT customers, each with exactly one visit STAMPED at
  // `city` via its own scheduled_services row — the privacy floor is
  // distinct customers, so area-intel tests must never qualify a city from
  // one customer's repeated visits.
  async function makeCityVisits(city, count, overrides = {}) {
    for (let i = 0; i < count; i++) {
      const customerId = await makeCustomer({ city });
      await makeVisitAtCity(customerId, city, overrides);
    }
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

  test('readVisitProducts: scopes the Talak 7.9 F label facts to the Talak bottle only, never Delta Dust or Demand CS', async () => {
    const customerId = await makeCustomer();
    const visitId = await makeVisit(customerId);
    await trx('service_products').insert([
      { id: randomUUID(), service_record_id: visitId, product_name: 'Talstar P', active_ingredient: 'bifenthrin', applied_at: new Date('2026-09-10T10:00:00Z') },
      { id: randomUUID(), service_record_id: visitId, product_name: 'Delta Dust', active_ingredient: 'deltamethrin', applied_at: new Date('2026-09-10T10:15:00Z') },
      { id: randomUUID(), service_record_id: visitId, product_name: 'Demand CS', active_ingredient: 'lambda-cyhalothrin', applied_at: new Date('2026-09-10T10:20:00Z') },
    ]);
    const { products } = await readVisitProducts(visitId, { conn: trx });
    const talstar = products.find((p) => p.productName === 'Talstar P');
    // Owner ruling 2026-09-11: "Talstar P" in the job logs is the Talak 7.9 F bottle.
    expect(talstar).toMatchObject({
      family: 'contact_residual', verified: true, source: 'Talak 7.9 F label (EPA 91234-145)',
      phrase: 'an insecticide', factSlugs: ['fact-bifenthrin-talak-label'],
    });
    expect(talstar.dryRule?.hours).toBe(24);
    for (const name of ['Delta Dust', 'Demand CS']) {
      const p = products.find((prod) => prod.productName === name);
      // Same family (still shown, still ranked as contact_residual) but the
      // Talak-label "spray has dried" rain instruction, its fact
      // slugs, AND the "sprayed on" phrase (inaccurate for a dust) never
      // ride along on a dust or a different active ingredient — the
      // neutral class name is used instead.
      expect(p).toMatchObject({
        family: 'contact_residual', verified: false, dryRule: null, notes: [], factSlugs: [],
        phrase: 'an insecticide',
      });
    }
  });

  test('readVisitProducts: scopes the Taurus SC label claims to Taurus SC itself, never Alpine WSG or another fipronil product', async () => {
    const customerId = await makeCustomer();
    const visitId = await makeVisit(customerId);
    await trx('service_products').insert([
      { id: randomUUID(), service_record_id: visitId, product_name: 'Taurus SC', active_ingredient: 'fipronil', applied_at: new Date('2026-09-10T10:00:00Z') },
      { id: randomUUID(), service_record_id: visitId, product_name: 'Alpine WSG', active_ingredient: 'dinotefuran', applied_at: new Date('2026-09-10T10:15:00Z') },
      // pricing.csv row 137 — granular fipronil for fire ants, a different label.
      { id: randomUUID(), service_record_id: visitId, product_name: 'Topchoice Granular Insecticide', active_ingredient: 'Fipronil 0.0143%', targets: ['Fire ants'], applied_at: new Date('2026-09-10T10:20:00Z') },
    ]);
    const { products } = await readVisitProducts(visitId, { conn: trx });
    const taurus = products.find((p) => p.productName === 'Taurus SC');
    expect(taurus).toMatchObject({ family: 'non_repellent', verified: true });
    expect(taurus.notes).toEqual([]); // the manufacturer states nothing about how long ants stay visible
    expect(taurus.factSlugs).toContain('fact-taurus-sc-non-repellent');
    // Same family, still shown — but the Taurus-SC-sourced phrase, note and
    // fact slug never ride along on a different product, even one sharing
    // its active ingredient. No unsourced dry instruction is invented either.
    for (const name of ['Alpine WSG', 'Topchoice Granular Insecticide']) {
      expect(products.find((p) => p.productName === name)).toMatchObject({
        family: 'non_repellent', verified: false, notes: [], factSlugs: [], dryRule: null, phrase: 'an insecticide',
      });
    }
    expect(products.find((p) => p.productName.startsWith('Topchoice')).targets).toEqual(['Fire ants']);
  });

  test('readVisitProducts: a catalogued wetting agent (joined by product_id) is internal and never primary', async () => {
    const customerId = await makeCustomer();
    const visitId = await makeVisit(customerId);
    const catalogId = randomUUID();
    await trx('products_catalog').insert({ id: catalogId, name: 'Synthetic Soil Aid', category: 'soil_surfactant', product_type: 'wetting_agent', active_ingredient: 'Alkoxylated polyols + glucoethers' });
    await trx('service_products').insert([
      // Neither name nor AI text says "surfactant" — only the catalog row does.
      { id: randomUUID(), service_record_id: visitId, product_id: catalogId, product_name: 'Synthetic Soil Aid', active_ingredient: 'Alkoxylated polyols + glucoethers', applied_at: new Date('2026-09-10T10:00:00Z') },
      { id: randomUUID(), service_record_id: visitId, product_name: 'LESCO Chelated Iron Plus', active_ingredient: 'Nitrogen + iron + manganese', applied_at: new Date('2026-09-10T10:05:00Z') },
    ]);
    const { products, primary, secondary } = await readVisitProducts(visitId, { conn: trx });
    expect(products.find((p) => p.productName === 'Synthetic Soil Aid')).toMatchObject({ family: 'adjuvant', customerVisible: false, phrase: null });
    expect(primary).toMatchObject({ productName: 'LESCO Chelated Iron Plus', phrase: 'a nutrition product with nitrogen, iron and manganese' });
    expect(secondary).toBeNull();
  });

  test('readVisitProducts: a recorded active ingredient decides source scope — Gentrol Complete (pyriproxyfen) never gets the hydroprene claim', async () => {
    const customerId = await makeCustomer();
    const visitId = await makeVisit(customerId);
    await trx('service_products').insert([
      // Exact row from server/data/pricing.csv — the Gentrol name matches,
      // but the recorded chemistry is not hydroprene.
      { id: randomUUID(), service_record_id: visitId, product_name: 'ZOECON 10578 Gentrol Complete EC3 Insecticide and Growth Regulator', active_ingredient: 'Nylar (pyriproxyfen) + Permethrin + Tetramethrin', applied_at: new Date('2026-09-10T10:00:00Z') },
      { id: randomUUID(), service_record_id: visitId, product_name: 'Gentrol IGR', active_ingredient: 'hydroprene', applied_at: new Date('2026-09-10T10:05:00Z') },
      // No active ingredient recorded — the name is the only evidence left.
      { id: randomUUID(), service_record_id: visitId, product_name: 'Gentrol IGR Concentrate', active_ingredient: null, applied_at: new Date('2026-09-10T10:10:00Z') },
      // Same chemistry, different label — the Gentrol IGR claim never transfers.
      { id: randomUUID(), service_record_id: visitId, product_name: 'Gentrol Point Source', active_ingredient: 'hydroprene', applied_at: new Date('2026-09-10T10:15:00Z') },
    ]);
    const { products } = await readVisitProducts(visitId, { conn: trx });
    const complete = products.find((p) => p.productName.startsWith('ZOECON 10578'));
    expect(complete).toMatchObject({ family: 'igr', verified: false, notes: [], factSlugs: [] });
    const hydroprene = products.find((p) => p.productName === 'Gentrol IGR');
    expect(hydroprene).toMatchObject({ family: 'igr', verified: true, factSlugs: ['fact-gentrol-igr-hydroprene'] });
    // Label-quoted phrase only; no efficacy-timeline note (owner ruling 2026-09-28).
    expect(hydroprene).toMatchObject({ phrase: 'an insect growth regulator: cockroaches exposed to it become adults that cannot reproduce', notes: [], noTimeline: true });
    const nameOnly = products.find((p) => p.productName === 'Gentrol IGR Concentrate');
    expect(nameOnly).toMatchObject({ family: 'igr', verified: true, factSlugs: ['fact-gentrol-igr-hydroprene'] });
    const pointSource = products.find((p) => p.productName === 'Gentrol Point Source');
    expect(pointSource).toMatchObject({ family: 'igr', verified: false, notes: [], factSlugs: [], phrase: 'an insect growth regulator' });
  });

  test('readVisitProducts: a stable secondary tie-breaker on tied applied_at (codex round 8 P2) — repeated reads always agree', async () => {
    const customerId = await makeCustomer();
    const visitId = await makeVisit(customerId);
    // Completion inserts never set applied_at, so it defaults to the
    // transaction timestamp and every product written in one completion
    // ties — reproduced here with the SAME explicit timestamp. Both products
    // are the same customer-primacy rank (non_repellent), so which one is
    // primary depends entirely on the tie-breaker.
    const tiedAt = new Date('2026-09-10T10:00:00Z');
    const [smallerId, largerId] = [randomUUID(), randomUUID()].sort();
    // Insert with the LARGER id first, so a plain "insertion order" or
    // "first row wins" tie-breaker would pick the wrong product.
    await trx('service_products').insert([
      { id: largerId, service_record_id: visitId, product_name: 'Alpine WSG', active_ingredient: 'dinotefuran', applied_at: tiedAt },
      { id: smallerId, service_record_id: visitId, product_name: 'Taurus SC', active_ingredient: 'fipronil', applied_at: tiedAt },
    ]);
    // ORDER BY sp.id ASC puts the smaller id first, so it wins primary — and
    // every repeated read must agree.
    for (let i = 0; i < 3; i++) {
      const { primary, secondary } = await readVisitProducts(visitId, { conn: trx });
      expect(primary.productName).toBe('Taurus SC');
      expect(secondary.productName).toBe('Alpine WSG');
    }
  });

  test('readVisitSummary: structured fields, advisory/conditions keys, and pests named', async () => {
    const customerId = await makeCustomer();
    const visitId = await makeVisit(customerId, {
      service_date: etDaysFromToday(0), service_line: 'pest', visit_number: 3, client_pest_rating: 4,
      technician_notes: 'WHAT WE DID: treated for ghost, big-headed, and crazy ants along the foundation.',
      structured_notes: { areasTreated: ['exterior', 'garage'] },
      advisory: { pet_advisory: 'Keep pets off treated areas until dry.', exterior_reentry_min: 30, interior_reentry_min: 0, irrigation_hold_hr: 24 },
      conditions: { temp_f: 88, rain_24h_in: 0.1 },
    });
    // An abandoned 'rescheduled' row dated EARLIER than the live replacement
    // — including it would wrongly return the obsolete date as "next".
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: etDaysFromToday(30), service_type: 'Pest Control', status: 'rescheduled',
    });
    const liveNextDate = etDaysFromToday(60);
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: liveNextDate, service_type: 'Pest Control', status: 'confirmed',
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
    expect(nextDate).toBe(liveNextDate); // never the earlier, abandoned 'rescheduled' row
  });

  test('readVisitSummary: normalizes re-entry guidance at read time, matching the report (codex round 10 P2) — an interior-only visit suppresses the stored exterior default', async () => {
    const customerId = await makeCustomer();
    // Interior-only signal, no exterior evidence anywhere — the report's
    // own read-time normalizer (normalizeAdvisoryForTreatmentScope) zeroes
    // exterior_reentry_min here; this reader must reuse it, not return the
    // stored write-time value verbatim.
    const interiorOnly = await makeVisit(customerId, {
      structured_notes: { areasTreated: ['Kitchen'] },
      advisory: { pet_advisory: 'Keep pets off treated areas until dry.', exterior_reentry_min: 30, interior_reentry_min: 0, irrigation_hold_hr: 24 },
    });
    const summary = await readVisitSummary(interiorOnly, { conn: trx });
    expect(summary.advisory).toEqual({
      petAdvisory: 'Keep pets off treated areas until dry.', exteriorReentryMin: 0, interiorReentryMin: 0, irrigationHoldHr: 24,
    });

    // A visit with BOTH interior and exterior evidence keeps the stored
    // exterior default (the same "exterior" + "garage" mix the existing
    // structured-fields test above proves the report itself preserves).
    const both = await makeVisit(customerId, {
      structured_notes: { areasTreated: ['exterior', 'garage'] },
      advisory: { exterior_reentry_min: 30, interior_reentry_min: 0 },
    });
    expect((await readVisitSummary(both, { conn: trx })).advisory).toMatchObject({ exteriorReentryMin: 30, interiorReentryMin: 0 });
  });

  test('readVisitSummary: areasTreated unions every persisted area field (areas_serviced, areasServiced, areasTreated, typed snapshot)', async () => {
    const customerId = await makeCustomer();
    const legacyOnly = await makeVisit(customerId, { areas_serviced: JSON.stringify(['Perimeter', 'Lanai']) });
    const altOnly = await makeVisit(customerId, { structured_notes: { areasServiced: ['Front yard'] } });
    const everything = await makeVisit(customerId, {
      areas_serviced: JSON.stringify(['Perimeter']),
      structured_notes: { areasServiced: ['perimeter', 'Garage'], areasTreated: ['Kitchen'] },
      service_data: { typedReportSnapshot: { values: { areas_treated: 'Kitchen, Attic', spot_treatment_areas: 'Bathroom' } } },
    });
    expect((await readVisitSummary(legacyOnly, { conn: trx })).areasTreated).toEqual(['Perimeter', 'Lanai']);
    expect((await readVisitSummary(altOnly, { conn: trx })).areasTreated).toEqual(['Front yard']);
    expect((await readVisitSummary(everything, { conn: trx })).areasTreated).toEqual(['Perimeter', 'Garage', 'Kitchen', 'Attic', 'Bathroom']);
  });

  test('readVisitSummary: merges service_products.application_area into areasTreated (codex round 8 P2) — same union the canonical scope reader runs, case-insensitively deduped against the service-level fields', async () => {
    const customerId = await makeCustomer();
    // No service-level area field at all — application_area is the ONLY scope.
    const productAreaOnly = await makeVisit(customerId);
    // Explicit, distinct applied_at — readVisitProducts' own row order (which
    // areasTreated preserves) must not depend on the products' random ids.
    await trx('service_products').insert([
      { id: randomUUID(), service_record_id: productAreaOnly, product_name: 'Talstar P', active_ingredient: 'bifenthrin', application_area: 'Perimeter', applied_at: new Date('2026-09-10T10:00:00Z') },
      { id: randomUUID(), service_record_id: productAreaOnly, product_name: 'Taurus SC', active_ingredient: 'fipronil', application_area: 'Garage', applied_at: new Date('2026-09-10T10:05:00Z') },
    ]);
    expect((await readVisitSummary(productAreaOnly, { conn: trx })).areasTreated).toEqual(['Perimeter', 'Garage']);

    // A service-level area and a product's own application_area overlap
    // case-insensitively — the shared value appears once, first spelling kept.
    const mixed = await makeVisit(customerId, { structured_notes: { areasTreated: ['Kitchen'] } });
    await trx('service_products').insert([
      { id: randomUUID(), service_record_id: mixed, product_name: 'Talstar P', active_ingredient: 'bifenthrin', application_area: 'kitchen', applied_at: new Date('2026-09-10T10:00:00Z') },
      { id: randomUUID(), service_record_id: mixed, product_name: 'Taurus SC', active_ingredient: 'fipronil', application_area: 'Attic', applied_at: new Date('2026-09-10T10:05:00Z') },
    ]);
    expect((await readVisitSummary(mixed, { conn: trx })).areasTreated).toEqual(['Kitchen', 'Attic']);

    // No application_area recorded at all -> unaffected, still just the
    // service-level field.
    const noProductArea = await makeVisit(customerId, { areas_serviced: JSON.stringify(['Lanai']) });
    await trx('service_products').insert({ id: randomUUID(), service_record_id: noProductArea, product_name: 'Talstar P', active_ingredient: 'bifenthrin' });
    expect((await readVisitSummary(noProductArea, { conn: trx })).areasTreated).toEqual(['Lanai']);
  });

  test('readVisitSummary: excludes a past appointment between the service date and today from "next visit"', async () => {
    const customerId = await makeCustomer();
    const visitId = await makeVisit(customerId, { service_date: etDaysFromToday(-120) });
    // Still 'pending' in the database, but its date has long since passed —
    // reading this summary well after the visit must not surface a stale
    // appointment as "next" just because it postdates the completed visit.
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: etDaysFromToday(-60), service_type: 'Pest Control', status: 'pending',
    });
    const liveNextDate = etDaysFromToday(45);
    await trx('scheduled_services').insert({
      id: randomUUID(), customer_id: customerId, scheduled_date: liveNextDate, service_type: 'Pest Control', status: 'confirmed',
    });
    const summary = await readVisitSummary(visitId, { conn: trx });
    const nextDate = summary.nextVisitDate instanceof Date
      ? summary.nextVisitDate.toISOString().slice(0, 10) : String(summary.nextVisitDate).slice(0, 10);
    expect(nextDate).toBe(liveNextDate);
  });

  test('getActivityRatingAverages: partitions by service_line and omits a cohort with fewer than 20 rated visits', async () => {
    const customerId = await makeCustomer();
    // Every rating below is technician-entered (our measured data), so only
    // the cohort/performed/visible predicates decide what is excluded here.
    // Pest visit #1: 25 ratings of 5 (>= 20 -> included).
    await makeTechRatedVisits(customerId, 25, { visit_number: 1, service_line: 'pest', client_pest_rating: 5, service_date: '2026-09-01' });
    // Pest visit #2: only 3 ratings (< 20 -> omitted).
    await makeTechRatedVisits(customerId, 3, { visit_number: 2, service_line: 'pest', client_pest_rating: 1, service_date: '2026-09-02' });
    // Mosquito visit #1: 15 ratings of 2 — same visit_number (1) as the pest
    // cohort above but a DIFFERENT program. 15 + 25 would clear the 20-visit
    // floor if wrongly combined; each service_line must clear it on its own,
    // so this cohort alone (15 < 20) stays omitted and never drags the pest
    // #1 average toward it.
    await makeTechRatedVisits(customerId, 15, { visit_number: 1, service_line: 'mosquito', client_pest_rating: 2, service_date: '2026-09-03' });
    // Non-performed/non-visible rows that carry a rating but must never
    // enter the pest #1 average or count — same predicate Pest Pressure's
    // first-visit history uses (server/services/pest-pressure/first-visit.js
    // + history-filter.js): 'incomplete' status, a completed-but-declined
    // visitOutcome, and a report-suppressed (not auto_send) closeout.
    await makeTechRatedVisits(customerId, 5, { visit_number: 1, service_line: 'pest', client_pest_rating: 1, service_date: '2026-09-04', status: 'incomplete' });
    await makeTechRatedVisits(customerId, 5, { visit_number: 1, service_line: 'pest', client_pest_rating: 1, service_date: '2026-09-05', structured_notes: { visitOutcome: 'customer_declined' } });
    await makeTechRatedVisits(customerId, 5, { visit_number: 1, service_line: 'pest', client_pest_rating: 1, service_date: '2026-09-06', structured_notes: { typedReportDelivery: 'manual_review' } });
    const { byVisit, counts } = await getActivityRatingAverages({ conn: trx });
    expect(byVisit.pest[1]).toBe(5); // unmoved by the 15 excluded low ratings
    expect(counts.pest[1]).toBe(25); // still exactly the performed, visible visits
    expect(byVisit.pest[2]).toBeUndefined();
    expect(byVisit.mosquito?.[1]).toBeUndefined();
  });

  test('getActivityRatingAverages: counts technician-entered ratings only — never customer-submitted or unsourced ones — and floors the filtered set', async () => {
    const customerId = await makeCustomer();
    // 20 technician ratings of 4 -> exactly the floor.
    await makeTechRatedVisits(customerId, 20, { visit_number: 1, service_line: 'pest', client_pest_rating: 4, service_date: '2026-09-01' });
    // Customer-submitted (reports-public.js) and legacy unsourced ratings of
    // 0: excluded — they would drag the average and pad the count.
    await makeVisits(customerId, 10, { visit_number: 1, service_line: 'pest', client_pest_rating: 0, client_pest_rating_source: 'customer', service_date: '2026-09-02' });
    await makeVisits(customerId, 10, { visit_number: 1, service_line: 'pest', client_pest_rating: 0, service_date: '2026-09-03' });
    // Visit #2: 19 technician + 10 customer ratings — 29 raw, but only 19
    // of ours, so it stays below the floor.
    await makeTechRatedVisits(customerId, 19, { visit_number: 2, service_line: 'pest', client_pest_rating: 3, service_date: '2026-09-04' });
    await makeVisits(customerId, 10, { visit_number: 2, service_line: 'pest', client_pest_rating: 3, client_pest_rating_source: 'customer', service_date: '2026-09-05' });
    const { byVisit, counts } = await getActivityRatingAverages({ conn: trx });
    expect(byVisit.pest[1]).toBe(4);
    expect(counts.pest[1]).toBe(20);
    expect(byVisit.pest[2]).toBeUndefined();
  });

  // Owner ruling 2026-09-29: the untouched first-visit default rating (owner
  // ruling 2026-09-24) must not count here — only a rating the technician
  // actually chose does.
  test('getActivityRatingAverages: excludes the untouched first-visit default (client_pest_rating_defaulted = true), keeps a technician-chosen rating of the same value', async () => {
    const customerId = await makeCustomer();
    // Chosen: the tech's own 5 — counts.
    await makeTechRatedVisits(customerId, 25, {
      visit_number: 1, service_line: 'pest', client_pest_rating: 5, client_pest_rating_defaulted: false, service_date: '2026-09-25',
    });
    // Defaulted: the untouched first-visit prefill, stamped 1 (a value that
    // would visibly drag the average if it leaked in) — excluded outright.
    await makeTechRatedVisits(customerId, 25, {
      visit_number: 1, service_line: 'pest', client_pest_rating: 1, client_pest_rating_defaulted: true, service_date: '2026-09-25',
    });
    const { byVisit, counts } = await getActivityRatingAverages({ conn: trx });
    expect(byVisit.pest[1]).toBe(5); // unmoved by the excluded defaults
    expect(counts.pest[1]).toBe(25); // only the chosen ratings
  });

  // Legacy rows (written before the client_pest_rating_defaulted column
  // existed, 2026-09-29) carry NULL. One could be the untouched default only
  // if it is a customer's FIRST PERFORMED visit on the line (the default's
  // own history rule — not visit_number, which also counts inspection-only,
  // declined, incomplete and internal closeouts; codex round 1 on #5330),
  // rated exactly 5 and dated at/after the default's 2026-09-24T10:21:12Z
  // ship instant. Only such a row is excluded on suspicion. Each fixture
  // customer gets explicit created_at values: inside one test transaction
  // now() is constant, and "prior" means a record that existed first.
  async function legacyCohort(count, { line, ratingAt, prior = null, visit }) {
    for (let i = 0; i < count; i++) {
      const customerId = await makeCustomer();
      if (prior) {
        await makeVisit(customerId, { service_line: line, created_at: '2026-09-20T12:00:00Z', ...prior });
      }
      await makeTechRatedVisits(customerId, 1, {
        service_line: line, client_pest_rating: 5, client_pest_rating_at: ratingAt, created_at: ratingAt, ...visit,
      });
    }
  }

  test('getActivityRatingAverages: a legacy NULL-flag 5 on a customer\'s first performed visit, dated AFTER the default shipped, is excluded on suspicion', async () => {
    await legacyCohort(25, { line: 'mosquito', ratingAt: '2026-09-25T12:00:00Z', visit: { visit_number: 1 } });
    const { byVisit } = await getActivityRatingAverages({ conn: trx });
    expect(byVisit.mosquito?.[1]).toBeUndefined();
  });

  test('getActivityRatingAverages: the first PERFORMED visit is judged by the default\'s history rule, not visit_number — a 5 on visit 2 after an inspection-only closeout is excluded', async () => {
    await legacyCohort(25, {
      line: 'mosquito',
      ratingAt: '2026-09-25T12:00:00Z',
      prior: { visit_number: 1, structured_notes: { visitOutcome: 'inspection_only' } },
      visit: { visit_number: 2 },
    });
    const { byVisit } = await getActivityRatingAverages({ conn: trx });
    expect(byVisit.mosquito?.[2]).toBeUndefined();
  });

  test('getActivityRatingAverages: a legacy NULL-flag 5 on a LATER performed visit (a performed visit came first) is kept — the default never applies there', async () => {
    await legacyCohort(25, {
      line: 'mosquito',
      ratingAt: '2026-09-25T12:00:00Z',
      prior: { visit_number: 1, client_pest_rating: 2, client_pest_rating_source: 'technician', service_date: '2026-09-15' },
      visit: { visit_number: 2 },
    });
    const { byVisit, counts } = await getActivityRatingAverages({ conn: trx });
    expect(byVisit.mosquito[2]).toBe(5);
    expect(counts.mosquito[2]).toBe(25);
  });

  test('getActivityRatingAverages: a legacy NULL-flag first-visit rating of 5 dated BEFORE the default shipped is kept — no default existed yet', async () => {
    const customerId = await makeCustomer();
    // No client_pest_rating_at (falls back to service_date), which predates
    // the 2026-09-24 ship instant.
    await makeTechRatedVisits(customerId, 25, {
      visit_number: 1, service_line: 'rodent', client_pest_rating: 5, service_date: '2026-09-01',
    });
    const { byVisit, counts } = await getActivityRatingAverages({ conn: trx });
    expect(byVisit.rodent[1]).toBe(5);
    expect(counts.rodent[1]).toBe(25);
  });

  // Four cities, one recompute: Ellenton (4 visits, below the 5-visit floor
  // -> no rows), Parrish (54 visits, 35 (~65%) target big-headed ants, counted
  // as the ants family -> the worked-example sentence), Nocatee (10 visits, 100% flea targets but
  // below minVisits -> null), Bradenton (25 visits, only 1 (4%) targets a
  // pest, below the 10% floor -> null).
  test('computeAreaIntel + getAreaIntelSentence: 5-customer floor, minVisits, 10% floor, exact wording', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    const sentenceMonth = new Date('2026-09-20T12:00:00Z');
    await makeCityVisits('Ellenton', 4, { service_date: '2026-09-05', targets: ['Fire ants'] });
    await makeCityVisits('Parrish', 35, { service_date: '2026-09-05', targets: ['Big-headed ants'] });
    await makeCityVisits('Parrish', 19, { service_date: '2026-09-06', technician_notes: 'WHAT WE DID: general perimeter treatment, no activity found.' });
    await makeCityVisits('Nocatee', 10, { service_date: '2026-09-05', targets: ['Fleas'] });
    await makeCityVisits('Bradenton', 24, { service_date: '2026-09-05', technician_notes: 'WHAT WE DID: general perimeter treatment, no activity found.' });
    await makeCityVisits('Bradenton', 1, { service_date: '2026-09-06', targets: ['Paper wasps'] });
    // Stale row from a prior recompute; must not survive a fresh one.
    await trx('email_area_intel_monthly').insert({ month: '2026-09-01', city: 'venice', visits: 40, pest_key: 'fleas', visits_with_pest: 30 });
    const result = await computeAreaIntel({ month, conn: trx });
    expect(await trx('email_area_intel_monthly').where({ city: 'venice' })).toHaveLength(0);
    expect(result.citiesProcessed).toBe(3); // Ellenton never gets a row
    expect(await trx('email_area_intel_monthly').where({ city: 'ellenton' })).toHaveLength(0);
    const parrishRows = await trx('email_area_intel_monthly').where({ city: 'parrish' });
    expect(parrishRows.find((r) => r.pest_key === 'ants').visits_with_pest).toBe(35);
    expect(parrishRows[0].visits).toBe(54);
    await expect(getAreaIntelSentence({ city: 'Parrish', month: sentenceMonth, conn: trx })).resolves
      .toBe('In September our technicians treated ants at 65% of our 54 visits in Parrish.');
    await expect(getAreaIntelSentence({ city: 'Nocatee', month: sentenceMonth, minVisits: 20, conn: trx })).resolves.toBeNull();
    await expect(getAreaIntelSentence({ city: 'Bradenton', month: sentenceMonth, conn: trx })).resolves.toBeNull();
  });

  test('computeAreaIntel: excludes non-performed and report-suppressed service records from both counts', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    await makeCityVisits('Oneco', 5, { service_date: '2026-09-05', targets: ['Fleas'], status: 'completed' });
    // An office-handoff closeout for a visit that did NOT happen — must not
    // inflate the denominator or seed a pest count of its own.
    await makeCityVisits('Oneco', 3, { service_date: '2026-09-06', targets: ['Ticks'], status: 'incomplete' });
    // status='completed' alone is not enough — a completed row can still
    // carry a non-performed visitOutcome (tech showed up, nothing treated).
    await makeCityVisits('Oneco', 3, {
      service_date: '2026-09-07', targets: ['Paper wasps'],
      structured_notes: { visitOutcome: 'customer_declined' },
    });
    // Report-suppressed (not shown to the customer) — excluded the same way
    // Pest Pressure's own first-visit history excludes it.
    await makeCityVisits('Oneco', 3, {
      service_date: '2026-09-08', targets: ['Wolf spiders'],
      structured_notes: { typedReportDelivery: 'manual_review' },
    });
    await computeAreaIntel({ month, conn: trx });
    const rows = await trx('email_area_intel_monthly').where({ city: 'oneco' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ visits: 5, pest_key: 'fleas', visits_with_pest: 5 });
    expect(rows.find((r) => r.pest_key === 'ticks')).toBeUndefined();
    expect(rows.find((r) => r.pest_key === 'wasps')).toBeUndefined();
    expect(rows.find((r) => r.pest_key === 'spiders')).toBeUndefined();
  });

  test('computeAreaIntel: one customer with 5+ completed visits never alone clears the privacy floor', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    const customerId = await makeCustomer({ city: 'Wimauma' });
    // Several service lines/callbacks for the SAME household, each
    // properly stamped at the SAME city — a real scenario, but distinct
    // CUSTOMERS is the privacy floor, not raw visits.
    for (let i = 0; i < 6; i++) {
      await makeVisitAtCity(customerId, 'Wimauma', { service_date: '2026-09-05', targets: ['Fleas'] });
    }
    await computeAreaIntel({ month, conn: trx });
    expect(await trx('email_area_intel_monthly').where({ city: 'wimauma' })).toHaveLength(0);
  });

  test('computeAreaIntel: counts recorded application targets only — a note that observes or negates a pest is never a treatment', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    await makeCityVisits('Ruskin', 2, { service_date: '2026-09-05', targets: ['Fire ants'] });
    await makeCityVisits('Ruskin', 1, { service_date: '2026-09-05', technician_notes: 'WHAT WE DID: sprayed the perimeter and saw a few fire ants outside.' });
    await makeCityVisits('Ruskin', 1, { service_date: '2026-09-05', technician_notes: 'Inspected the yard, no fire ants found.' });
    // A fertilizer's chip is the feeding goal, not a pest.
    await makeCityVisits('Ruskin', 1, {
      service_date: '2026-09-05', technician_notes: 'Fleas mentioned by customer.', targets: ['Nitrogen green-up'],
      product: { product_name: 'LESCO K-Flow 0-0-25', active_ingredient: 'Potassium 0-0-25 + sulfur' },
    });
    // A canonical picker species no keyword list named is still counted.
    await makeCityVisits('Ruskin', 1, { service_date: '2026-09-05', targets: ['Bed bugs'] });
    await computeAreaIntel({ month, conn: trx });
    const rows = await trx('email_area_intel_monthly').where({ city: 'ruskin' }).orderBy('pest_key');
    expect(rows).toMatchObject([
      { visits: 6, pest_key: 'ants', visits_with_pest: 2 },
      { visits: 6, pest_key: 'bed bugs', visits_with_pest: 1 },
    ]);
  });

  // Owner ruling 2026-09-30: species chips count toward their family, one
  // count per visit per family however many species it treated. A hand-typed
  // chip outside the vocabulary never rolls up into a family.
  test('computeAreaIntel: species chips roll up to their family, once per visit', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    await makeCityVisits('Palmetto', 2, { service_date: '2026-09-05', targets: ['Wolf spiders'] });
    await makeCityVisits('Palmetto', 1, { service_date: '2026-09-05', targets: ['Widow spiders', 'Jumping spiders'] });
    await makeCityVisits('Palmetto', 1, { service_date: '2026-09-05', targets: ['German cockroaches', 'Smokybrown cockroaches'] });
    await makeCityVisits('Palmetto', 1, { service_date: '2026-09-05', targets: ['Roof rats', 'house mice'] });
    await makeCityVisits('Palmetto', 1, { service_date: '2026-09-05', targets: ['sugar ants seen near the door'] });
    await computeAreaIntel({ month, conn: trx });
    const rows = await trx('email_area_intel_monthly').where({ city: 'palmetto' }).orderBy('pest_key');
    expect(rows.map((r) => [r.pest_key, r.visits_with_pest])).toEqual([
      ['rats and mice', 1],
      ['roaches', 1],
      ['spiders', 3],
    ]);
  });

  test('computeAreaIntel: a completed visit with no recorded targets still counts toward the visit denominator', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    await makeCityVisits('Terra', 3, { service_date: '2026-09-05', targets: ['Fleas'] });
    // A completed visit with no notes and no targets still happened — it
    // must add to `visits` (the denominator behind the percentage
    // sentence), just not to any pest's numerator.
    await makeCityVisits('Terra', 2, { service_date: '2026-09-06', technician_notes: null });
    await computeAreaIntel({ month, conn: trx });
    const rows = await trx('email_area_intel_monthly').where({ city: 'terra' });
    expect(rows).toMatchObject([{ visits: 5, pest_key: 'fleas', visits_with_pest: 3 }]);
  });

  test('computeAreaIntel: attributes a visit to the booked service_address_city, not the customer\'s own city', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    // Five DISTINCT customers whose primary/current city is Bradenton, but
    // every visit was booked and serviced at a Venice rental/second
    // property — the immutable booking-time stamp, not the account's
    // mirror address, decides the city.
    for (let i = 0; i < 5; i++) {
      const customerId = await makeCustomer({ city: 'Bradenton' });
      await makeVisitAtCity(customerId, 'Venice', { service_date: '2026-09-05', targets: ['Fleas'] });
    }
    await computeAreaIntel({ month, conn: trx });
    expect(await trx('email_area_intel_monthly').where({ city: 'bradenton' })).toHaveLength(0);
    const veniceRows = await trx('email_area_intel_monthly').where({ city: 'venice' });
    expect(veniceRows).toMatchObject([{ visits: 5, pest_key: 'fleas', visits_with_pest: 5 }]);
  });

  test('computeAreaIntel: never attributes an unstamped visit to the mutable customers.city mirror — a stamped visit keeps its OWN city even after a later primary-property flip rewrites that mirror (codex round 10 P2)', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    // Five distinct customers, each with a visit stamped Parrish — then
    // simulate property-role-proposals.js's primary-flip transaction
    // rewriting every one of their `customers.city` mirrors to Sarasota
    // AFTER the visit happened. The visit must still count as Parrish.
    const customerIds = [];
    for (let i = 0; i < 5; i++) {
      const customerId = await makeCustomer({ city: 'Parrish' });
      customerIds.push(customerId);
      await makeVisitAtCity(customerId, 'Parrish', { service_date: '2026-09-05', targets: ['Fleas'] });
    }
    await trx('customers').whereIn('id', customerIds).update({ city: 'Sarasota' });

    // Five MORE distinct customers whose visits were never stamped at all
    // (no scheduled_services row — a legacy or unlinked service record).
    // Their current `customers.city` (Wesley Chapel) must never be guessed.
    for (let i = 0; i < 5; i++) {
      const customerId = await makeCustomer({ city: 'Wesley Chapel' });
      await makeVisit(customerId, { service_date: '2026-09-05', targets: ['Fleas'] });
    }

    await computeAreaIntel({ month, conn: trx });
    expect(await trx('email_area_intel_monthly').where({ city: 'sarasota' })).toHaveLength(0);
    expect(await trx('email_area_intel_monthly').where({ city: 'wesley chapel' })).toHaveLength(0);
    const parrishRows = await trx('email_area_intel_monthly').where({ city: 'parrish' });
    expect(parrishRows).toMatchObject([{ visits: 5, pest_key: 'fleas', visits_with_pest: 5 }]);
  });

  test('getAreaIntelSentence: applies the 10% floor to the unrounded ratio, not the rounded percentage', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    const sentenceMonth = new Date('2026-09-20T12:00:00Z');
    // 2/21 = 9.52% — rounds to "10%" but must still fail the floor.
    await makeCityVisits('Palmetto', 2, { service_date: '2026-09-05', targets: ['Fleas'] });
    await makeCityVisits('Palmetto', 19, { service_date: '2026-09-06', technician_notes: 'WHAT WE DID: general perimeter treatment, no activity found.' });
    await computeAreaIntel({ month, conn: trx });
    const rows = await trx('email_area_intel_monthly').where({ city: 'palmetto' });
    expect(rows).toMatchObject([{ visits: 21, pest_key: 'fleas', visits_with_pest: 2 }]);
    await expect(getAreaIntelSentence({ city: 'Palmetto', month: sentenceMonth, minVisits: 5, conn: trx })).resolves.toBeNull();
  });

  test('computeAreaIntel: a free-text chip the completion picker also accepts never becomes the sentence, even at 100% of visits — a canonical target in the same month still does (codex round 9 P2)', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    const sentenceMonth = new Date('2026-09-20T12:00:00Z');
    // A hand-typed chip (SchedulePage.jsx's free-text datalist input), well
    // past both the 5-customer and 20-visit/10% floors.
    await makeCityVisits('Duette', 25, { service_date: '2026-09-05', targets: ['technicians treated no pests - prevention'] });
    // A canonical target in the SAME city-month, so both compete for "top".
    await makeCityVisits('Duette', 25, { service_date: '2026-09-06', targets: ['Fire ants'] });
    await computeAreaIntel({ month, conn: trx });
    const rows = await trx('email_area_intel_monthly').where({ city: 'duette' });
    // The free-text chip never reaches the table at all — only the
    // canonical target does, even though it tied the chip's own count.
    expect(rows).toMatchObject([{ visits: 50, pest_key: 'ants', visits_with_pest: 25 }]);
    await expect(getAreaIntelSentence({ city: 'Duette', month: sentenceMonth, conn: trx })).resolves
      .toBe('In September our technicians treated ants at 50% of our 50 visits in Duette.');
  });

  test('computeAreaIntel: a catalogued herbicide caught only by category (round 8 P2) still counts its canonical weed targets (round 9 P2) — exact Stonewall row', async () => {
    const month = new Date('2026-09-15T12:00:00Z');
    const sentenceMonth = new Date('2026-09-20T12:00:00Z');
    // pricing.csv:146 — neither name nor active ingredient is in any
    // FAMILIES list; only the recorded category says herbicide. Its AI text
    // ALSO contains the nutrition family's generic '0-0-' NPK pattern, which
    // would misclassify it 'nutrition' (excluded from target-counting)
    // without the round 8/9 precedence fix.
    await makeCityVisits('Myakka', 21, {
      service_date: '2026-09-05',
      product: { product_name: 'LESCO Stonewall 0.43% 0-0-7', active_ingredient: 'Prodiamine 0.43% + 0-0-7', product_category: 'Herbicide' },
      targets: ['Crabgrass'],
    });
    await computeAreaIntel({ month, conn: trx });
    const rows = await trx('email_area_intel_monthly').where({ city: 'myakka' });
    expect(rows).toMatchObject([{ visits: 21, pest_key: 'crabgrass', visits_with_pest: 21 }]);
    await expect(getAreaIntelSentence({ city: 'Myakka', month: sentenceMonth, conn: trx })).resolves
      .toBe('In September our technicians treated crabgrass at 100% of our 21 visits in Myakka.');
  });
});
