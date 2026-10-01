// Real migrated PostgreSQL, synthetic records, rolled back after every test.
// Runs in the existing DB-gated CI step or the owning worktree's private QA DB.
//
// report-near-you.test.js pins the conditions and the counting with a fake;
// this suite proves loadNearYouLawnPest's SQL filters against the real schema:
// the city rule (the visit's frozen report city, else its stamped service
// city, else the customer's),
// the 30-ET-day window, lawn-only, performed and customer-visible records,
// the viewer's own customer left out, and the closeout form snapshot
// (structured_notes.formObservations) as the only pest source.
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;

const { randomUUID } = require('node:crypto');
const lawnCatalog = require('../../shared/lawn-condition-findings.json');
const { loadNearYouLawnPest } = require('../services/service-report/report-data');
const { etDateString, addETDays } = require('../utils/datetime-et');

const statementFor = (label) => lawnCatalog.groups
  .flatMap(({ findings }) => findings)
  .find((finding) => finding.label === label).statement;
const CHINCH_OBSERVATION = `${statementFor('Chinch bugs — observed')} Location: Front yard.`;
const daysAgo = (n) => etDateString(addETDays(new Date(), -n));

postgres('loadNearYouLawnPest against migrated PostgreSQL', () => {
  let database;
  let trx;

  beforeAll(() => {
    const connection = process.env.DATABASE_URL;
    const url = new URL(connection);
    const localCI = ['localhost', '127.0.0.1'].includes(url.hostname);
    const ownedQA = process.env.WAVES_LOCAL_DEV === '1'
      && url.pathname === `/waves_qa_${String(process.env.WAVES_WORKTREE_ID || '').replaceAll('-', '')}`;
    if (!localCI && !ownedQA) throw new Error('Use disposable CI or this worktree\'s private QA database');
    database = require('knex')({ client: 'pg', connection, pool: { min: 0, max: 2 } });
  });

  beforeEach(async () => { trx = await database.transaction(); });
  afterEach(async () => { if (trx) await trx.rollback(); });
  afterAll(async () => { await database?.destroy(); });

  async function customer(city = 'Parrish') {
    const id = randomUUID();
    await trx('customers').insert({
      id, first_name: 'Synthetic', last_name: 'Fixture',
      email: `${id}@example.invalid`, phone: `fixture-${id.slice(0, 8)}`,
      address_line1: '100 Test Lane', city, zip: '00000',
      active: true, pipeline_stage: 'active_customer', monthly_rate: 0,
    });
    return id;
  }

  // A completed lawn visit whose closeout form recorded chinch bugs.
  // `stampedCity` models a visit whose booking stamps a different service
  // address city.
  async function lawnFinding(customerId, {
    date = daysAgo(5), line = 'lawn', status = 'completed', stampedCity = null, notes = {},
    formObservations = [CHINCH_OBSERVATION], serviceData = {},
  } = {}) {
    const [sched] = await trx('scheduled_services').insert({
      customer_id: customerId, scheduled_date: date, service_type: 'Lawn Care Visit', status: 'completed',
      service_address_city: stampedCity,
    }).returning('*');
    const [rec] = await trx('service_records').insert({
      customer_id: customerId, service_date: date, service_type: 'Lawn Care Visit', status,
      scheduled_service_id: sched.id, service_line: line,
      structured_notes: JSON.stringify({ ...notes, formObservations }),
      service_data: JSON.stringify(serviceData),
    }).returning('*');
    return rec;
  }

  test('three other customers in the city name the pest; the viewer, other cities and stamped-away visits do not count', async () => {
    const viewer = await customer();
    await lawnFinding(viewer); // the viewer's own finding never counts
    for (let i = 0; i < 2; i += 1) await lawnFinding(await customer());
    // Lives in Parrish, but this visit's booking stamps another city.
    await lawnFinding(await customer(), { stampedCity: 'Bradenton' });
    await lawnFinding(await customer('Bradenton')); // another city
    expect(await loadNearYouLawnPest(trx, { customerId: viewer, city: 'Parrish' })).toBeNull();

    // A third Parrish customer — here through the stamp, with a customer city
    // elsewhere — meets the floor; the city compares trimmed and case-blind.
    await lawnFinding(await customer('Sarasota'), { stampedCity: 'parrish' });
    expect(await loadNearYouLawnPest(trx, { customerId: viewer, city: ' PARRISH ' }))
      .toEqual({ city: 'PARRISH', pest: 'chinch bugs' });
  });

  test("a visit counts in the city its frozen report shows, not the customer's current address (codex P2 on #5177)", async () => {
    const viewer = await customer();
    const frozenIn = (city) => ({ reportIdentitySnapshot: { version: 1, address: { city } } });
    await lawnFinding(await customer());
    await lawnFinding(await customer());
    // Lives in Parrish now; the visit happened in Bradenton.
    await lawnFinding(await customer(), { serviceData: frozenIn('Bradenton') });
    expect(await loadNearYouLawnPest(trx, { customerId: viewer, city: 'Parrish' })).toBeNull();

    // Has since moved to Sarasota; the visit happened in Parrish.
    await lawnFinding(await customer('Sarasota'), { serviceData: frozenIn('Parrish') });
    expect(await loadNearYouLawnPest(trx, { customerId: viewer, city: 'Parrish' }))
      .toEqual({ city: 'Parrish', pest: 'chinch bugs' });
  });

  test('outside the 30-day window, non-lawn, not performed, not completed, internal-only and free-typed findings do not count', async () => {
    const viewer = await customer();
    await lawnFinding(await customer()); // one that counts
    await lawnFinding(await customer()); // two that count
    await lawnFinding(await customer(), { date: daysAgo(30) }); // just past the window
    await lawnFinding(await customer(), { line: 'pest' });
    await lawnFinding(await customer(), { notes: { visitOutcome: 'customer_declined' } });
    await lawnFinding(await customer(), { status: 'incomplete' });
    await lawnFinding(await customer(), { notes: { typedReportDelivery: 'internal_only' } });
    // The same words typed as a title-only finding, with no closeout form
    // pick, prove nothing (codex P0 on #5177).
    const typed = await lawnFinding(await customer(), { formObservations: [] });
    await trx('service_findings').insert({
      service_record_id: typed.id, category: 'observation', severity: 'medium', title: CHINCH_OBSERVATION,
    });
    expect(await loadNearYouLawnPest(trx, { customerId: viewer, city: 'Parrish' })).toBeNull();

    await lawnFinding(await customer(), { date: daysAgo(29) }); // the window's first day counts
    expect(await loadNearYouLawnPest(trx, { customerId: viewer, city: 'Parrish' }))
      .toEqual({ city: 'Parrish', pest: 'chinch bugs' });
  });
});
