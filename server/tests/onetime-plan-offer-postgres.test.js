// One-time job to plan offer, shadow and live, against real PostgreSQL (one rolled-back transaction per test),
// behind GATE_ONETIME_PLAN_OFFER=shadow|live (owner 2026-11-19, "build"; live: 2026-11-20, "i want auto"). The unit suite pins the decisions with
// stubs; this one proves what only a database can: the job's own SQL (which visits are due, the offer day, each
// send rule's read), the real collaborators on real tables (open balance, review-ask history, suppressions, the
// email division's verdict, the offer pricing with the real engine, its plan records and its proof of the
// job's home), and that the two DRAFT templates
// the migration seeds render and send as test sends through the real template library, and the one admin
// notification for a morning the price settings stopped (a real row, refreshed, closed and opened again). The last
// describe runs LIVE with the REAL mint (mintPlanStartEstimate) and the REAL ledger (sendWithLedger, the real
// template library and the real eligibility): the customer's estimate row, the one email row, the second morning,
// a denied send and a failed send that leave the quote, and the 12-month rule inside the reservation. Only
// the email transport, the property lookup and the phone banner of an admin notification are stubs (no network,
// no spend, nothing sent). All names and addresses are synthetic.
// CI runs a DB suite only when it carries this exact line (tests.yml greps for it).
const SKIP = !process.env.DATABASE_URL;
const postgres = SKIP ? describe.skip : describe;
let mockConnection;
// The template library marks a provider handoff on its own connection. Here it must see the test transaction.
jest.mock('../models/marker-db', () => () => require('../models/db'));
// The app's connection is the test transaction, so every read and write of the job rolls back. The job passes
// that connection to the offer pricing, whose strict price refuses a transaction: in production the job holds
// none. So the stand-in answers "not a transaction", and reads through the test's transaction.
jest.mock('../models/db', () => new Proxy((...args) => mockConnection(...args), {
  get(_target, key) {
    if (key === 'isTransaction') return false;
    const value = mockConnection?.[key];
    return typeof value === 'function' ? value.bind(mockConnection) : value;
  },
}));
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../routes/property-lookup-v2', () => ({ ...jest.requireActual('../routes/property-lookup-v2'), performPropertyLookup: jest.fn() }));
// A new admin notification asks for a banner on the admin phones. The row is what this suite reads.
jest.mock('../services/bell-banners', () => ({ ...jest.requireActual('../services/bell-banners'), bannerAfterWrite: jest.fn() }));
jest.mock('../services/sendgrid-mail', () => ({
  ...jest.requireActual('../services/sendgrid-mail'),
  isConfigured: jest.fn(() => true),
  sendOne: jest.fn(async () => ({ messageId: 'sg-sample' })),
}));

// The review cadence gate is read once, when feature-gates loads. Production has it on (read 2026-11-20).
const savedReviewGate = process.env.GATE_REVIEW_SEQUENCES;
process.env.GATE_REVIEW_SEQUENCES = 'true';

const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { formatDateOnly } = require('../utils/date-only');

const NOW = new Date();
const HOUR = 3600000;
const OFFICE = 'contact@wavespestcontrol.com';
const OFFER = 'nurture.plan_offer';
const REMINDER = 'nurture.plan_offer_reminder';
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
// The ET calendar day n days from today: the job's own day arithmetic.
const day = (n) => etDateString(addETDays(NOW, n));
const sampleKey = (templateKey, jobId) => `onetime-plan-offer:sample:${templateKey}:${jobId}`;
// The review cadence of a one-time job: the day-0 ask, the day-4 reminder, the day-7 nudge. Each carries the review link.
const { DEFAULT_SEQUENCE_PLAN } = require('../services/review-outreach-templates');
const ASK_PLAN = JSON.stringify(DEFAULT_SEQUENCE_PLAN);
// A cadence whose last step is a private check-in: no review link.
const CHECKIN_LAST_PLAN = JSON.stringify([DEFAULT_SEQUENCE_PLAN[0], { day: 5, channel: 'sms', templateKey: 'satisfaction_confirm' }]);

postgres('one-time job to plan offer, shadow step (live Postgres)', () => {
  // The first test loads the pricing engine and the template library.
  jest.setTimeout(90000);
  let database;
  let trx;
  let Offer;
  let Lookup;
  let Sendgrid;
  let savedGate;

  beforeAll(async () => {
    const target = new URL(process.env.DATABASE_URL);
    const privateQa = /^\/waves_qa_[a-f0-9]{32}$/.test(target.pathname);
    const ci = process.env.CI === 'true' && ['localhost', '127.0.0.1'].includes(target.hostname) && target.pathname === '/waves_test';
    if (!privateQa && !ci) throw new Error('Use a private QA or isolated CI database');
    savedGate = process.env.GATE_ONETIME_PLAN_OFFER;
    database = require('knex')({ client: 'pg', connection: process.env.DATABASE_URL, pool: { min: 0, max: 2 } });
    Offer = require('../services/onetime-plan-offer');
    Lookup = require('../routes/property-lookup-v2');
    Sendgrid = require('../services/sendgrid-mail');
  });

  afterAll(async () => {
    if (savedGate === undefined) delete process.env.GATE_ONETIME_PLAN_OFFER;
    else process.env.GATE_ONETIME_PLAN_OFFER = savedGate;
    if (savedReviewGate === undefined) delete process.env.GATE_REVIEW_SEQUENCES;
    else process.env.GATE_REVIEW_SEQUENCES = savedReviewGate;
    await database?.destroy();
  });

  // The card rail's two switches, on as production has them. The offer is only for a customer whose plan visits
  // are billed after the visit (the email says so), in shadow as in live: with either one off, every job is held.
  const RAIL_ENV = ['RECURRING_CARD_ON_FILE', 'GATE_PAY_AFTER_FIRST_VISIT'];
  let savedRailEnv;

  beforeEach(async () => {
    process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
    savedRailEnv = Object.fromEntries(RAIL_ENV.map((name) => [name, process.env[name]]));
    for (const name of RAIL_ENV) process.env[name] = 'true';
    jest.clearAllMocks();
    Lookup.performPropertyLookup.mockResolvedValue(null);
    trx = await database.transaction();
    mockConnection = trx;
  });

  afterEach(async () => {
    for (const name of RAIL_ENV) {
      if (savedRailEnv[name] === undefined) delete process.env[name];
      else process.env[name] = savedRailEnv[name];
    }
    await trx.rollback();
  });

  // ---- Fixtures: the least each table needs. ----

  async function seedCustomer(overrides = {}) {
    const tag = hex(4);
    const [row] = await trx('customers').insert({
      first_name: 'Jordan', last_name: 'Example', email: `jordan.${tag}@example.test`,
      phone: `+1941${String(parseInt(tag, 16) % 10000000).padStart(7, '0')}`,
      address_line1: `${(parseInt(tag, 16) % 9000) + 100} Example Test Ln`, city: 'Parrish', state: 'FL', zip: '34219',
      active: true, pipeline_stage: 'won', ...overrides,
    }).returning('*');
    return row;
  }

  // The record of a visit's service, as the completion flow saves it: performed, on the given day.
  const seedRecord = (job, overrides = {}) => trx('service_records').insert({
    customer_id: job.customer_id, scheduled_service_id: job.id, service_type: job.service_type, status: 'completed',
    service_date: job.scheduled_date, structured_notes: { visitOutcome: 'completed' }, ...overrides,
  });

  // A completed one-time job with the record of its service and its paid invoice. `daysAgo` counts ET calendar
  // days: the scheduled day and, unless `record` names another, the day the service was done. `record: false`
  // saves no record, and `invoice: null` saves no invoice.
  async function seedJob({ daysAgo = 5, customer = null, record = {}, invoice = { status: 'paid', total: 225 }, ...visit } = {}) {
    const owner = customer || await seedCustomer();
    const [job] = await trx('scheduled_services').insert({
      customer_id: owner.id, scheduled_date: day(-daysAgo), service_type: 'One-Time Pest Control', status: 'completed',
      service_key_snapshot: 'one_time_pest_control', ...visit,
    }).returning('*');
    if (record) await seedRecord(job, { service_date: day(-daysAgo), ...record });
    if (invoice) {
      await trx('invoices').insert({
        token: hex(16), invoice_number: `TEST-${hex(4)}`, customer_id: owner.id, scheduled_service_id: job.id,
        subtotal: invoice.total, total: invoice.total, status: invoice.status,
      });
    }
    return { customer: owner, job };
  }

  // Another completed visit of the same customer on the job's day (5 days ago), finished at `completedAt`.
  async function seedSameDayVisit(customer, completedAt, visit = {}) {
    const [row] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-5), service_type: 'Rodent Inspection', status: 'completed',
      service_key_snapshot: 'rodent_exclusion', completed_at: completedAt, ...visit,
    }).returning('*');
    return row;
  }
  const EARLIER = '2030-01-01 14:00:00+00';
  const LATER = '2030-01-01 16:00:00+00';
  // The job finished between EARLIER and LATER, so a same-day visit can sit on either side of it.
  const jobFinishedAtThree = (job) => trx('scheduled_services').where({ id: job.id }).update({ completed_at: '2030-01-01 15:00:00+00' });

  // One stop billed together: a completion packet links every billed visit to the ONE invoice.
  async function seedPacket(customer, invoiceId, visitIds) {
    const [visit] = await trx('service_visits').insert({
      customer_id: customer.id, scheduled_date: day(-5), stop_base_key: `test-${hex(6)}`, created_by: 'test',
    }).returning('id');
    const [packet] = await trx('visit_completion_packets').insert({
      visit_id: visit.id, idempotency_key: `test-${hex(8)}`, request_hash: hex(16), payload: '{}', status: 'done',
    }).returning('id');
    await trx('visit_completion_packet_items').insert(visitIds.map((scheduled_service_id) => ({
      packet_id: packet.id, scheduled_service_id, derived_idempotency_key: `test-${hex(8)}`, status: 'done', invoice_id: invoiceId,
    })));
  }
  const jobInvoice = (job) => trx('invoices').where({ scheduled_service_id: job.id }).first('id');
  const primaryLine = (visit) => ({ client_id: `scheduled_${visit.id}_primary`, description: 'Service', amount: 100 });

  // A text a person in the office typed to the customer, `hoursAgo` hours before now.
  const seedStaffText = (customer, message_body, hoursAgo) => trx('sms_log').insert({
    customer_id: customer.id, direction: 'outbound', from_phone: '+19415550199', to_phone: customer.phone,
    message_type: 'manual', status: 'delivered', message_body, created_at: new Date(NOW.getTime() - hoursAgo * HOUR),
  });
  // An instant on the Eastern wall clock of an ET calendar day, computed by PostgreSQL (not by the code under test).
  const easternInstant = async (ymd, time) => (await trx.raw("SELECT (?::date + ?::time) AT TIME ZONE 'America/New_York' AS at", [ymd, time])).rows[0].at;

  const priced = () => jest.fn(async () => ({ option: { id: 'pest-quarterly', perVisit: 104.5, setupFee: 99 }, reason: null }));
  // The real job with the real collaborators. Tests of the audience rules stub only the price.
  const run = (deps = { buildStartOffer: priced() }) => Offer.runOnetimePlanOfferJob({ now: NOW, deps });
  const sampleRows = (jobId) => trx('email_messages')
    .whereIn('idempotency_key', [sampleKey(OFFER, jobId), sampleKey(REMINDER, jobId)])
    .orderBy('template_key', 'asc');
  const sampledJobIds = async (jobs) => {
    const rows = await trx('email_messages').whereIn('idempotency_key', jobs.map((job) => sampleKey(REMINDER, job.id))).select('idempotency_key');
    return rows.map((row) => row.idempotency_key.split(':').pop()).sort();
  };

  test('a paid one-time job sends both samples to the office through the real template library, once, and saves no estimate', async () => {
    const { customer, job } = await seedJob();
    const summary = await run();
    expect(summary).toMatchObject({ mode: 'shadow', sample: 1, failed: 0 });

    const rows = await sampleRows(job.id);
    expect(rows.map((row) => row.template_key)).toEqual([OFFER, REMINDER]);
    for (const row of rows) {
      expect(row).toMatchObject({ recipient_email_snapshot: OFFICE, recipient_type: 'test', status: 'sent', provider_message_id: 'sg-sample' });
      expect(row.sent_at).not.toBeNull();
      expect(row.subject_snapshot).toMatch(/^\[TEST\] /);
      expect(row.html_snapshot).toContain('Sample only. No estimate was saved and the customer got no email.');
      expect(row.html_snapshot).toContain(`This account passed the send rules today, so this customer would get the offer. Job ${job.id}.`);
      expect(row.html_snapshot).toContain('$104.50 per application');
      expect(row.html_snapshot).not.toMatch(/\{\{/);
    }
    expect(rows[0].subject_snapshot).toBe('[TEST] Your pest control plan estimate, with no setup fee');
    expect(rows[0].text_snapshot).toContain('Hi Jordan,');
    expect(rows[0].text_snapshot).toContain(customer.address_line1);
    expect(rows[0].text_snapshot).toContain('One-time setup fee: $0 (normally $99)');

    // The transport was handed the office address both times, and the customer's address never.
    expect(Sendgrid.sendOne.mock.calls.map(([mail]) => mail.to)).toEqual([OFFICE, OFFICE]);
    expect(await trx('email_messages').where({ recipient_email_snapshot: customer.email }).first('id')).toBeUndefined();
    expect(await trx('estimates').where({ customer_id: customer.id }).first('id')).toBeUndefined();

    // The next morning reads the same job: nothing is sent again.
    expect(await run()).toMatchObject({ sample: 0, done: 1, failed: 0 });
    expect(Sendgrid.sendOne).toHaveBeenCalledTimes(2);
  });

  test('due jobs are completed one-time pest and cockroach visits, 3 to 14 days old, by catalog key', async () => {
    // The joined-catalog path needs a services row for the key; a migrated database may not carry one.
    const catalog = await trx('services').where({ service_key: 'cockroach_control' }).first('id')
      || (await trx('services').insert({ service_key: 'cockroach_control', name: 'Cockroach Control' }).returning('id'))[0];
    const due = {
      dayThree: await seedJob({ daysAgo: 3 }),
      dayFourteen: await seedJob({ daysAgo: 14 }),
      // No snapshot on the visit: the key comes from its services row.
      joinedKey: await seedJob({ service_key_snapshot: null, service_id: catalog.id, service_type: 'Cockroach Control' }),
      // Waves also saves a one-time visit with this marker in the pattern column.
      oneTimeMarker: await seedJob({ recurring_pattern: 'one_time' }),
    };
    const notDue = {
      dayTwo: await seedJob({ daysAgo: 2 }),
      dayFifteen: await seedJob({ daysAgo: 15 }),
      otherService: await seedJob({ service_key_snapshot: 'rodent_exclusion', service_type: 'Rodent Exclusion' }),
      // The label says pest, the catalog says nothing: a text label alone is never a match.
      labelOnly: await seedJob({ service_key_snapshot: null, service_type: 'One-Time Pest Control' }),
      planVisit: await seedJob({ is_recurring: true }),
      // Not flagged recurring, but it stores a plan's cadence or hangs off a series.
      storedCadence: await seedJob({ recurring_pattern: 'quarterly' }),
      seriesExtra: await seedJob({ recurring_parent_id: crypto.randomUUID() }),
      callback: await seedJob({ is_callback: true }),
      includedFollowUp: await seedJob({ followup_included: true }),
      notDone: await seedJob({ status: 'cancelled' }),
    };
    const summary = await run();
    expect(summary.failed).toBe(0);
    const everyJob = [...Object.values(due), ...Object.values(notDue)].map((seeded) => seeded.job);
    expect(await sampledJobIds(everyJob)).toEqual(Object.values(due).map((seeded) => seeded.job.id).sort());
  });

  // The visit row says 'completed' also when the visit was closed without the service, so the visit's service
  // record must say the service was performed (the shared outcome list of pest-pressure/first-visit.js).
  test.each([
    ['inspection only', { structured_notes: { visitOutcome: 'inspection_only' } }],
    ['declined by the customer', { structured_notes: { visitOutcome: 'customer_declined' } }],
    ['incomplete, by its outcome', { structured_notes: { visitOutcome: 'incomplete' } }],
    ['incomplete, by the status of its record', { status: 'incomplete', structured_notes: {} }],
  ])('not due: the visit was closed as %s', async (_name, record) => {
    const { job } = await seedJob({ record });
    expect(await run()).toMatchObject({ jobs: 0, sample: 0, failed: 0 });
    expect(await sampleRows(job.id)).toHaveLength(0);
  });

  test('not due: a completed visit with no record of its service', async () => {
    const { job } = await seedJob({ record: false });
    expect(await run()).toMatchObject({ jobs: 0, sample: 0, failed: 0 });
    expect(await sampleRows(job.id)).toHaveLength(0);
  });

  test.each([
    ['a record with no outcome saved (an older report)', { structured_notes: {} }],
    ['a record with no notes at all', { structured_notes: null }],
  ])('due: %s is a performed service', async (_name, record) => {
    await seedJob({ record });
    expect(await run()).toMatchObject({ jobs: 1, sample: 1, failed: 0 });
  });

  // A visit can be done on another day than its scheduled day. The days of the offer count from the service.
  test('the window, the email dates and the offer end count from the day the service was done, not from the scheduled day', async () => {
    // Scheduled 5 days ago and done yesterday: too fresh today. Its scheduled day is inside the window.
    const fresh = await seedJob({ daysAgo: 5, record: { service_date: day(-1) } });
    // Scheduled 20 days ago and done 6 days ago: due. Its scheduled day is outside the window.
    const late = await seedJob({ daysAgo: 20, record: { service_date: day(-6) } });
    // Scheduled 6 days ago, with a record of a service done 16 days ago: too old.
    const old = await seedJob({ daysAgo: 6, record: { service_date: day(-16) } });
    expect(await run()).toMatchObject({ jobs: 1, sample: 1, failed: 0 });
    expect(await sampledJobIds([fresh.job, late.job, old.job])).toEqual([late.job.id]);

    // Every date in the words follows the service day (6 days ago): the visit named, the next visit 11 to 13
    // weeks after it, and the last day of the offer 30 days after it. The scheduled day gives none of these.
    const [offer] = await sampleRows(late.job.id);
    const noYear = { year: undefined };
    const short = (n) => formatDateOnly(day(n), { ...noYear, month: 'short' });
    const weekday = formatDateOnly(day(-6), { ...noYear, month: undefined, day: undefined, weekday: 'long' });
    expect(offer.text_snapshot).toContain(`Thanks for having us out on ${weekday}, ${short(-6)}.`);
    expect(offer.text_snapshot).toContain(`we serviced your home on ${short(-6)}.`);
    expect(offer.text_snapshot).toContain(`Next visit: You pick, ${short(71)} to ${short(85)}`);
    expect(offer.text_snapshot).toContain(`This estimate is good through ${formatDateOnly(day(24), noYear)}.`);
  });

  test('a visit with two records is one job, on the day of its newest performed service', async () => {
    // The first attempt was declined 9 days ago; the service was done 4 days ago.
    const { job } = await seedJob({ daysAgo: 9, record: { structured_notes: { visitOutcome: 'customer_declined' } } });
    await seedRecord(job, { service_date: day(-4) });
    // A second performed record of the same visit, one day earlier: still one job.
    await seedRecord(job, { service_date: day(-5) });
    expect(await run()).toMatchObject({ jobs: 1, sample: 1, failed: 0 });
    const [offer] = await sampleRows(job.id);
    expect(offer.text_snapshot).toContain(`we serviced your home on ${formatDateOnly(day(-4), { year: undefined, month: 'short' })}.`);
  });

  // The owner can pause or archive a template in the template editor. Its version stays a draft or active, and
  // the library does not check the template's status on a test send.
  test.each([
    ['the offer template is paused', OFFER, 'paused'],
    ['the reminder template is paused', REMINDER, 'paused'],
    ['the offer template is archived', OFFER, 'archived'],
  ])('%s: the job sends no sample, not the other one either, until the template is a draft again', async (_name, templateKey, status) => {
    const { job } = await seedJob();
    await trx('email_templates').where({ template_key: templateKey }).update({ status });
    expect(await run()).toMatchObject({ jobs: 1, sample: 0, failed: 1 });
    expect(await sampleRows(job.id)).toEqual([]);
    expect(Sendgrid.sendOne).not.toHaveBeenCalled();

    await trx('email_templates').where({ template_key: templateKey }).update({ status: 'draft' });
    expect(await run()).toMatchObject({ jobs: 1, sample: 1, failed: 0 });
    expect((await sampleRows(job.id)).map((row) => row.status)).toEqual(['sent', 'sent']);
  });

  // A service record names its visit and its customer. Only a record of the visit's own customer counts.
  test('a record of another customer that names the visit neither makes the job due nor moves its day', async () => {
    const other = await seedCustomer();
    // No record of its own; another customer's performed record names it, inside the window.
    const bare = await seedJob({ record: false });
    await seedRecord(bare.job, { customer_id: other.id, service_date: day(-5) });
    // Its own service was done 6 days ago; another customer's record names it with a newer day.
    const own = await seedJob({ daysAgo: 6 });
    await seedRecord(own.job, { customer_id: other.id, service_date: day(-4) });
    expect(await run()).toMatchObject({ jobs: 1, sample: 1, failed: 0 });
    expect(await sampledJobIds([bare.job, own.job])).toEqual([own.job.id]);
    const [offer] = await sampleRows(own.job.id);
    expect(offer.text_snapshot).toContain(`we serviced your home on ${formatDateOnly(day(-6), { year: undefined, month: 'short' })}.`);
  });

  // The provider can take the offer and refuse the reminder. The morning after prices the home again. The
  // refusal is a definite one (HTTP 429): the library lets a later send try that message again. After an error
  // with no answer it holds the message, because the first try may have gone out.
  test('a reminder sent on a later morning repeats the price of the offer already sent, after a price change', async () => {
    const { job } = await seedJob();
    const pricedAt = (perVisit) => ({ buildStartOffer: jest.fn(async () => ({ option: { id: 'pest-quarterly', perVisit, setupFee: 99 }, reason: null })) });
    Sendgrid.sendOne.mockResolvedValueOnce({ messageId: 'sg-sample' })
      .mockRejectedValueOnce(Object.assign(new Error('too many requests'), { status: 429 }));
    expect(await run(pricedAt(104.5))).toMatchObject({ jobs: 1, sample: 0, failed: 1 });
    const [first, refused] = await sampleRows(job.id);
    expect(first).toMatchObject({ template_key: OFFER, status: 'sent' });
    expect(first.text_snapshot).toContain('$104.50 per application');
    expect(refused).toMatchObject({ template_key: REMINDER, status: 'failed', sent_at: null });

    // The price setting changed overnight. The offer is not sent again, and the reminder shows the first price.
    expect(await run(pricedAt(131))).toMatchObject({ jobs: 1, sample: 1, failed: 0 });
    const [offer, reminder] = await sampleRows(job.id);
    expect(offer.id).toBe(first.id);
    expect(reminder).toMatchObject({ template_key: REMINDER, status: 'sent' });
    expect(reminder.text_snapshot).toContain('$104.50');
    expect(reminder.text_snapshot).not.toContain('$131');
    expect(Sendgrid.sendOne).toHaveBeenCalledTimes(3);
    expect(await run(pricedAt(131))).toMatchObject({ sample: 0, done: 1, failed: 0 });
  });

  // A live customer is active, not deleted and in a customer stage (whereLiveCustomer in customer-stages.js).
  // `customers.active` is also true for a lead row and for a former customer, so the stage decides here.
  test.each([
    ['a lead stage', { pipeline_stage: 'new_lead' }, 'not_a_live_customer'],
    ['an estimate stage', { pipeline_stage: 'estimate_sent' }, 'not_a_live_customer'],
    ['a former customer (churned)', { pipeline_stage: 'churned' }, 'not_a_live_customer'],
    ['a former customer (past customer)', { pipeline_stage: 'past_customer' }, 'not_a_live_customer'],
    ['no stage at all', { pipeline_stage: null }, 'not_a_live_customer'],
    ['an inactive account in a customer stage', { active: false }, 'inactive'],
    ['a deleted account', { deleted_at: new Date() }, 'no_customer'],
  ])('held: the account is in %s', async (_name, account, reason) => {
    await seedJob({ customer: await seedCustomer(account) });
    const buildStartOffer = priced();
    const summary = await run({ buildStartOffer });
    expect(summary).toMatchObject({ sample: 0, office: 0, failed: 0 });
    expect(summary.reasons).toEqual({ [reason]: 1 });
    expect(buildStartOffer).not.toHaveBeenCalled();
    expect(Sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test.each([['won'], ['active_customer'], ['at_risk']])('not a hold: the account is in the customer stage %s', async (stage) => {
    await seedJob({ customer: await seedCustomer({ pipeline_stage: stage }) });
    expect(await run()).toMatchObject({ sample: 1, held: 0, failed: 0 });
  });

  // Each case seeds the one row its rule reads, on the real table.
  test.each([
    ['offers are turned off in the Waves app', async ({ customer }) => {
      await trx('notification_prefs').insert({ customer_id: customer.id, marketing_offers: false });
    }, 'offers_off'],
    ['the customer chose marketing by text only', async ({ customer }) => {
      await trx('notification_prefs').insert({ customer_id: customer.id, marketing_channel: 'sms' });
    }, 'offers_by_text_only'],
    ['the email is unsubscribed from Waves marketing', async ({ customer }) => {
      await trx('email_suppressions').insert({ email: customer.email, suppression_type: 'unsubscribe', group_key: 'marketing_newsletter', status: 'active' });
    }, 'email_suppressed'],
    ['the email bounced', async ({ customer }) => {
      await trx('email_suppressions').insert({ email: customer.email, suppression_type: 'bounce', status: 'active' });
    }, 'email_suppressed'],
    // The email division's answers (the real eligibleForEmail, stream nurture, with the job as the completed
    // visit that stands for the relationship), under its reason names.
    ["the email is unsubscribed from the nurture group, the offer templates' own", async ({ customer }) => {
      await trx('email_suppressions').insert({ email: customer.email, suppression_type: 'unsubscribe', group_key: 'marketing_nurture', status: 'active' });
    }, 'email_suppressed_group'],
    ['the customer turned email off', async ({ customer }) => {
      await trx('notification_prefs').insert({ customer_id: customer.id, email_enabled: false });
    }, 'email_switch_off'],
    ['the customer is on the staff do-not-contact list', async ({ customer }) => {
      await trx('messaging_suppression').insert({ phone: customer.phone, reason: 'manual_dnc', active: true });
    }, 'staff_dnc'],
    ['another marketing email went out today', async ({ customer }) => {
      await trx('marketing_email_ledger').insert({
        customer_id: customer.id, stream: 'broadcast', marketing_class: 'marketing', email_key: 'newsletter.sample',
        idempotency_key: `test:${hex(8)}`, recipient_email: customer.email, status: 'sent', sent_at: NOW,
      });
    }, 'cap_same_day'],
  ])('held: %s', async (_name, arrange, reason) => {
    const seeded = await seedJob();
    await arrange(seeded);
    const buildStartOffer = priced();
    const summary = await run({ buildStartOffer });
    expect(summary).toMatchObject({ sample: 0, office: 0, failed: 0 });
    expect(summary.reasons).toEqual({ [reason]: 1 });
    expect(buildStartOffer).not.toHaveBeenCalled();
    expect(Sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test.each([
    // The owner chose "all": a customer whose offers switch was never set still gets the offer.
    ['a preferences row with the offers switch unset', async ({ customer }) => {
      await trx('notification_prefs').insert({ customer_id: customer.id, marketing_offers: null });
    }],
  ])('not a hold: %s', async (_name, arrange) => {
    const seeded = await seedJob();
    await arrange(seeded);
    expect(await run()).toMatchObject({ sample: 1, held: 0, failed: 0 });
  });

  // The email division names the job as the customer's completed visit, so the relationship check passes with no
  // estimate on file and the checks behind it are judged. The division says so itself, for the same customer.
  test('with no estimate on file the division finds no relationship without the visit, and the job names it', async () => {
    const { customer } = await seedJob();
    const { eligibleForEmail } = require('../services/email-division/eligibility');
    await expect(eligibleForEmail({ customerId: customer.id, stream: 'nurture', emailKey: OFFER, now: NOW }))
      .resolves.toMatchObject({ ok: false, reason: 'RELATIONSHIP_NOT_ELIGIBLE' });
    expect(await run()).toMatchObject({ sample: 1, held: 0, failed: 0 });
  });

  // Each case seeds the one row its rule reads, on the real table.
  test.each([
    ['a visit is still booked', async ({ customer }) => {
      await trx('scheduled_services').insert({ customer_id: customer.id, scheduled_date: day(4), service_type: 'Cockroach Control', status: 'pending' });
    }, 'another_visit'],
    // A visit the customer asked to move keeps its old day until the office moves it. Today or later, it is still to come.
    ['a visit is parked for a new day, and still carries today as its day', async ({ customer }) => {
      await trx('scheduled_services').insert({ customer_id: customer.id, scheduled_date: day(0), service_type: 'Cockroach Control', status: 'rescheduled' });
    }, 'another_visit'],
    // The column's default is pending: a row with no status is not closed.
    ['a visit row has no status', async ({ customer }) => {
      await trx('scheduled_services').insert({ customer_id: customer.id, scheduled_date: day(4), service_type: 'Cockroach Control', status: null });
    }, 'another_visit'],
    ['a later visit was completed (a re-service)', async ({ customer }) => {
      await trx('scheduled_services').insert({ customer_id: customer.id, scheduled_date: day(-1), service_type: 'Re-Service', status: 'completed' });
    }, 'another_visit'],
    // The same day counts too: the order is the service day, then the completion time.
    ['a re-service was completed later the same day', async ({ customer, job }) => {
      await jobFinishedAtThree(job);
      await seedSameDayVisit(customer, LATER, { service_type: 'Re-Service', service_key_snapshot: 'one_time_pest_control', is_callback: true });
    }, 'another_visit'],
    ['another kind of visit was completed later the same day', async ({ customer, job }) => {
      await jobFinishedAtThree(job);
      await seedSameDayVisit(customer, LATER);
    }, 'another_visit'],
                    ['the invoice is not paid', async ({ job }) => {
      await trx('invoices').where({ scheduled_service_id: job.id }).update({ status: 'sent' });
    }, 'invoice_not_paid'],
    // One stop billed together: the invoice total is not the price of this job, whichever visit it sits under.
    ['the job was billed first on one invoice with another visit', async ({ customer, job }) => {
      await jobFinishedAtThree(job);
      const other = await seedSameDayVisit(customer, EARLIER);
      await seedPacket(customer, (await jobInvoice(job)).id, [job.id, other.id]);
    }, 'combined_invoice'],
    ['the job was billed second: the one invoice sits under the other visit', async ({ customer, job }) => {
      await jobFinishedAtThree(job);
      const other = await seedSameDayVisit(customer, EARLIER);
      const invoice = await jobInvoice(job);
      await trx('invoices').where({ id: invoice.id }).update({ scheduled_service_id: other.id });
      await seedPacket(customer, invoice.id, [other.id, job.id]);
    }, 'combined_invoice'],
    ["a line of the job's invoice names another visit (an estimate's combined first invoice)", async ({ customer, job }) => {
      await jobFinishedAtThree(job);
      const other = await seedSameDayVisit(customer, EARLIER);
      await trx('invoices').where({ scheduled_service_id: job.id }).update({ line_items: JSON.stringify([primaryLine(job), primaryLine(other)]) });
    }, 'combined_invoice'],
    ["the job is named only on a line of another visit's invoice", async ({ customer, job }) => {
      await jobFinishedAtThree(job);
      const other = await seedSameDayVisit(customer, EARLIER);
      await trx('invoices').where({ scheduled_service_id: job.id })
        .update({ scheduled_service_id: other.id, line_items: JSON.stringify([primaryLine(other), primaryLine(job)]) });
    }, 'combined_invoice'],
    ["an invoice names the job on a line, and its service record belongs to another visit", async ({ customer, job }) => {
      await jobFinishedAtThree(job);
      const other = await seedSameDayVisit(customer, EARLIER);
      const [record] = await trx('service_records').insert({
        customer_id: customer.id, scheduled_service_id: other.id, service_date: day(-5), service_type: 'Rodent Inspection',
      }).returning('id');
      await trx('invoices').where({ scheduled_service_id: job.id })
        .update({ scheduled_service_id: null, service_record_id: record.id, line_items: JSON.stringify([primaryLine(job)]) });
    }, 'combined_invoice'],
    ["the job carries the stamp of an estimate's combined first invoice", async ({ job }) => {
      await trx('scheduled_services').where({ id: job.id }).update({ first_application_invoice_id: (await jobInvoice(job)).id });
    }, 'combined_invoice'],
    // Billing Recovery's "billed elsewhere" record: an invoice made for other work also covers a visit.
    ["another visit is recorded as billed elsewhere on the job's invoice", async ({ customer, job }) => {
      await jobFinishedAtThree(job);
      const other = await seedSameDayVisit(customer, EARLIER);
      await trx('visit_billing_dispositions').insert({ scheduled_service_id: other.id, disposition: 'billed_elsewhere', invoice_id: (await jobInvoice(job)).id });
    }, 'combined_invoice'],
    ['the job has no invoice of its own and is recorded as billed elsewhere on another paid invoice', async ({ job }) => {
      // The covering invoice was made by hand: no visit link, no service record, no line that names a visit.
      const invoice = await jobInvoice(job);
      await trx('invoices').where({ id: invoice.id }).update({ scheduled_service_id: null });
      await trx('visit_billing_dispositions').insert({ scheduled_service_id: job.id, disposition: 'billed_elsewhere', invoice_id: invoice.id });
    }, 'combined_invoice'],
    // Owed, but not in the balance the Waves app counts (that balance reads sent, viewed and overdue invoices).
    ['another invoice is part-paid with an amount still due', async ({ customer }) => {
      await trx('invoices').insert({
        token: hex(16), invoice_number: `TEST-${hex(4)}`, customer_id: customer.id, subtotal: 100, total: 100, amount_paid: 40, status: 'partially_paid',
      });
    }, 'open_balance'],
    ['another invoice is open', async ({ customer }) => {
      await trx('invoices').insert({ token: hex(16), invoice_number: `TEST-${hex(4)}`, customer_id: customer.id, subtotal: 80, total: 80, status: 'sent' });
    }, 'open_balance'],
    ['a review ask is queued', async ({ customer }) => {
      await trx('review_requests').insert({ token: hex(16), customer_id: customer.id, status: 'pending', scheduled_for: new Date(NOW.getTime() + 24 * HOUR) });
    }, 'review_ask'],
    ['a review ask is being sent from the composer', async ({ customer }) => {
      await trx('review_requests').insert({ token: hex(16), customer_id: customer.id, status: 'sending', claimed_at: new Date() });
    }, 'review_ask'],
    // Past the 10-minute claim window the row is still not settled: the review service's recovery can release it to send.
    ['a review ask was left `sending` 4 days ago, with no send result', async ({ customer }) => {
      await trx('review_requests').insert({ token: hex(16), customer_id: customer.id, status: 'sending', claimed_at: new Date(NOW.getTime() - 96 * HOUR) });
    }, 'review_ask'],
    // The reminder and the nudge of an active cadence are not queued rows yet. They are still on their way.
    ['a review cadence still has asks to come', async ({ customer }) => {
      await trx('review_sequences').insert({ customer_id: customer.id, plan: ASK_PLAN, status: 'active', current_step: 1 });
    }, 'review_ask'],
    // A cadence parked while its opener is in flight, or behind a bounced visit summary, comes back and sends.
    ['a review cadence is parked while its first ask is being sent', async ({ customer }) => {
      await trx('review_sequences').insert({ customer_id: customer.id, plan: ASK_PLAN, status: 'deferred' });
    }, 'review_ask'],
    ['a review cadence is parked behind a bounced visit summary', async ({ customer }) => {
      await trx('review_sequences').insert({ customer_id: customer.id, plan: ASK_PLAN, status: 'stopped', stop_reason: 'visit_summary_bounced', current_step: 1 });
    }, 'review_ask'],
    // A send whose result was never recorded: the review service itself treats the ask as not yet stopped.
    ['a review ask still holds a send reservation from 4 days ago', async ({ customer }) => {
      const [ask] = await trx('review_requests').insert({ token: hex(16), customer_id: customer.id, status: 'pending' }).returning('id');
      await trx('sms_log').insert({
        customer_id: customer.id, direction: 'outbound', from_phone: '+19415550199', to_phone: customer.phone, message_type: 'review_request',
        status: 'sending', message_body: 'Review ask', created_at: new Date(NOW.getTime() - 96 * HOUR),
        metadata: JSON.stringify({ review_request_id: ask.id, review_ask_reservation: true }),
      });
    }, 'review_ask'],
    // The follow-up runner can defer a reminder or reach its batch limit, so the ask can be older than 72 hours.
    ['a review ask from 4 days ago still has its follow-up text to come', async ({ customer }) => {
      await trx('review_requests').insert({ token: hex(16), customer_id: customer.id, status: 'sent', sms_sent_at: new Date(NOW.getTime() - 96 * HOUR) });
    }, 'review_ask'],
    ['a review ask was delivered yesterday', async ({ customer }) => {
      await trx('review_requests').insert({ token: hex(16), customer_id: customer.id, status: 'sent', sms_sent_at: new Date(NOW.getTime() - 24 * HOUR) });
    }, 'review_ask'],
    // An ask the office typed exists only as a text in sms_log: no review_requests row carries it.
    ['the office typed a review ask yesterday', async ({ customer }) => {
      await seedStaffText(customer, 'Hi Jordan, here is that review link one more time. Thank you!', 24);
    }, 'review_ask'],
    ['the customer rated the job a 4', async ({ customer }) => {
      await trx('review_requests').insert({ token: hex(16), customer_id: customer.id, status: 'rated', rating: 4, rated_at: NOW });
    }, 'low_rating'],
    ['a complaint was logged', async ({ customer }) => {
      await trx('customer_interactions').insert({ customer_id: customer.id, interaction_type: 'complaint', subject: 'Still seeing activity' });
    }, 'complaint'],
    ['a service request is open', async ({ customer }) => {
      await trx('service_requests').insert({ customer_id: customer.id, category: 'pest', subject: 'Follow-up question', status: 'new' });
    }, 'open_request'],
    ['an estimate is open', async ({ customer }) => {
      await trx('estimates').insert({ customer_id: customer.id, status: 'sent', expires_at: new Date(NOW.getTime() + 72 * HOUR) });
    }, 'open_estimate'],
    // The customer can open an estimate while it is being sent. Its end date is written when the send ends.
    ['an estimate is being sent, and its end date is not written yet', async ({ customer }) => {
      await trx('estimates').insert({ customer_id: customer.id, status: 'sending' });
    }, 'open_estimate'],
    // The scheduler's queue test has no end date: a late send still goes out, and the send writes a new end date.
    ['the office scheduled an estimate to send, and its old end date has passed', async ({ customer }) => {
      await trx('estimates').insert({
        customer_id: customer.id, status: 'scheduled', scheduled_at: new Date(NOW.getTime() + HOUR), expires_at: new Date(NOW.getTime() - 24 * HOUR),
      });
    }, 'open_estimate'],
    // This customer has no estimate on file. The division's checks behind that one must still be judged.
    ['the office texted the customer yesterday, and no estimate is on file', async ({ customer }) => {
      await seedStaffText(customer, 'Thanks for choosing Waves. Call the office with any question.', 24);
    }, 'recent_human_contact'],
  ])('held by a send rule: %s', async (_name, arrange, reason) => {
    const seeded = await seedJob();
    await arrange(seeded);
    const buildStartOffer = priced();
    const summary = await run({ buildStartOffer });
    expect(summary).toMatchObject({ sample: 0, office: 0, failed: 0 });
    expect(summary.reasons).toEqual({ [reason]: 1 });
    expect(buildStartOffer).not.toHaveBeenCalled();
    expect(Sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test.each([
    ['an old rating, a closed request, an expired estimate and a 4-day-old review ask', async ({ customer }) => {
      await trx('review_requests').insert({ token: hex(16), customer_id: customer.id, status: 'rated', rating: 3, rated_at: new Date(NOW.getTime() - 30 * 24 * HOUR), sms_sent_at: new Date(NOW.getTime() - 96 * HOUR) });
      await trx('service_requests').insert({ customer_id: customer.id, category: 'pest', subject: 'Old question', status: 'resolved' });
      await trx('estimates').insert({ customer_id: customer.id, status: 'sent', expires_at: new Date(NOW.getTime() - 24 * HOUR) });
    }],
    ['an earlier one-time visit and a cancelled later one', async ({ customer }) => {
      await trx('scheduled_services').insert([
        { customer_id: customer.id, scheduled_date: day(-40), service_type: 'One-Time Pest Control', status: 'completed' },
        { customer_id: customer.id, scheduled_date: day(6), service_type: 'One-Time Pest Control', status: 'cancelled' },
      ]);
    }],
    // 9 PM Eastern the evening before the job is already the job's date in UTC. It is still before the job.
    ['a complaint and a low rating from 9 PM Eastern the evening before the job', async ({ customer }) => {
      const eveningBefore = await easternInstant(day(-6), '21:00');
      await trx('customer_interactions').insert({ customer_id: customer.id, interaction_type: 'complaint', subject: 'Before the visit', created_at: eveningBefore });
      await trx('review_requests').insert({ token: hex(16), customer_id: customer.id, status: 'rated', rating: 2, rated_at: eveningBefore });
    }],
    ['a review ask the office typed 4 days ago', async ({ customer }) => {
      await seedStaffText(customer, 'Hi Jordan, here is that review link one more time. Thank you!', 96);
    }],
    // "Handled" is not "delivered": the runner closed the follow-up yesterday and no text went out.
    ['a 4-day-old review ask whose follow-up was closed with no text', async ({ customer }) => {
      await trx('review_requests').insert({
        token: hex(16), customer_id: customer.id, status: 'sent', sms_sent_at: new Date(NOW.getTime() - 96 * HOUR),
        followup_sent: true, followup_sent_at: new Date(NOW.getTime() - 24 * HOUR),
      });
    }],
    // Billing Recovery's other records are not a shared invoice: the invoice it cut, and a visit marked free.
    ["Billing Recovery cut the job's own invoice, and marked an earlier visit free", async ({ customer, job }) => {
      await jobFinishedAtThree(job);
      const other = await seedSameDayVisit(customer, EARLIER);
      await trx('visit_billing_dispositions').insert([
        { scheduled_service_id: job.id, disposition: 'billed', invoice_id: (await jobInvoice(job)).id },
        { scheduled_service_id: other.id, disposition: 'intentionally_free' },
      ]);
    }],
    ['a part-paid invoice has nothing left to pay', async ({ customer }) => {
      await trx('invoices').insert({
        token: hex(16), invoice_number: `TEST-${hex(4)}`, customer_id: customer.id, subtotal: 100, total: 100, amount_paid: 100, status: 'partially_paid',
      });
    }],
    ['a visit completed earlier the same day, billed on its own', async ({ customer, job }) => {
      await jobFinishedAtThree(job);
      await seedSameDayVisit(customer, EARLIER);
    }],
    // A private check-in carries no review link: it is not a review ask.
    ['a private check-in is queued, and a finished and a stopped review cadence are on file', async ({ customer }) => {
      await trx('review_requests').insert({
        token: hex(16), customer_id: customer.id, status: 'pending', scheduled_for: new Date(NOW.getTime() + 24 * HOUR), template_key: 'satisfaction_confirm',
      });
      await trx('review_sequences').insert([
        { customer_id: customer.id, plan: ASK_PLAN, status: 'completed', current_step: 3 },
        { customer_id: customer.id, plan: ASK_PLAN, status: 'stopped', stop_reason: 'clicked', current_step: 1 },
      ]);
    }],
    // A check-in is not an ask: not while it is being sent, and not when the recovery leaves it `sending` for good.
    ['a private check-in is being sent now, and another was left `sending` 4 days ago', async ({ customer }) => {
      await trx('review_requests').insert([
        { token: hex(16), customer_id: customer.id, status: 'sending', claimed_at: new Date(), template_key: 'satisfaction_confirm' },
        { token: hex(16), customer_id: customer.id, status: 'sending', claimed_at: new Date(NOW.getTime() - 96 * HOUR), template_key: 'resolution_check' },
      ]);
    }],
    // A draft may never go out, and a failed send is the office's to send again.
    ['a draft estimate, and an estimate whose send failed', async ({ customer }) => {
      await trx('estimates').insert([{ customer_id: customer.id, status: 'draft' }, { customer_id: customer.id, status: 'send_failed' }]);
    }],
    // Neither is on the scheduler's send queue: no send time, or held for a new price.
    ['a scheduled estimate with no send time, and one held for a new price', async ({ customer }) => {
      await trx('estimates').insert([
        { customer_id: customer.id, status: 'scheduled' },
        {
          customer_id: customer.id, status: 'scheduled', scheduled_at: new Date(NOW.getTime() + HOUR),
          estimate_data: JSON.stringify({ estimatorEngine: { reprice_pending_at: new Date(NOW.getTime() - HOUR).toISOString() } }),
        },
      ]);
    }],
    // The booking was cancelled and made again: the old row stays parked for good, and its day has passed.
    ['a visit parked for a new day whose day has passed', async ({ customer }) => {
      await trx('scheduled_services').insert({ customer_id: customer.id, scheduled_date: day(-8), service_type: 'One-Time Pest Control', status: 'rescheduled' });
    }],
    // The ask of this cadence went out long ago. Only its private check-in is left, and that is not an ask.
    ['an active review cadence whose only step left is a private check-in', async ({ customer }) => {
      await trx('review_sequences').insert({ customer_id: customer.id, plan: CHECKIN_LAST_PLAN, status: 'active', current_step: 1 });
    }],
    ["the invoice is linked through the job's service record, and its packet holds the job alone", async ({ customer, job }) => {
      const [record] = await trx('service_records').insert({
        customer_id: customer.id, scheduled_service_id: job.id, service_date: day(-5), service_type: 'One-Time Pest Control',
      }).returning('id');
      const invoice = await jobInvoice(job);
      await trx('invoices').where({ id: invoice.id })
        .update({ scheduled_service_id: null, service_record_id: record.id, line_items: JSON.stringify([primaryLine(job)]) });
      await seedPacket(customer, invoice.id, [job.id]);
    }],
  ])('not a hold: %s', async (_name, arrange) => {
    const seeded = await seedJob();
    await arrange(seeded);
    expect(await run()).toMatchObject({ sample: 1, held: 0, failed: 0 });
  });

  // Two one-time jobs on one day would each read as the customer's last visit: two offers to one customer.
  test.each([
    ['the later completion time', ['2030-01-01 15:00:00+00', '2030-01-01 16:00:00+00'], 1],
    ['the later completion time, whatever the order the rows were saved in', ['2030-01-01 16:00:00+00', '2030-01-01 15:00:00+00'], 0],
    // Closer than one millisecond: a comparison made in JavaScript would hold both jobs.
    ['a completion time a few microseconds later', ['2030-01-01 15:00:00.123456+00', '2030-01-01 15:00:00.123999+00'], 1],
    ['a completion time over none', [null, '2030-01-01 15:00:00+00'], 1],
  ])('two one-time jobs on one day: the offer follows %s', async (_name, completedAt, last) => {
    const customer = await seedCustomer();
    const jobs = [];
    for (const completed_at of completedAt) jobs.push((await seedJob({ customer, completed_at })).job);
    const summary = await run();
    expect(summary).toMatchObject({ jobs: 2, sample: 1, held: 1, failed: 0 });
    expect(summary.reasons).toEqual({ another_visit: 1 });
    expect(await sampledJobIds(jobs)).toEqual([jobs[last].id]);
  });

  test('two one-time jobs on one day with no completion time: the id settles it, and exactly one is sampled', async () => {
    const customer = await seedCustomer();
    const jobs = [(await seedJob({ customer })).job, (await seedJob({ customer })).job];
    const summary = await run();
    expect(summary).toMatchObject({ jobs: 2, sample: 1, held: 1, failed: 0 });
    const [highestId] = (await trx.raw('SELECT id FROM scheduled_services WHERE id = ANY(?::uuid[]) ORDER BY id DESC LIMIT 1', [jobs.map((job) => job.id)])).rows;
    expect(await sampledJobIds(jobs)).toEqual([highestId.id]);
  });

  test('more due jobs than one page: every job is read once, in pages, across the days of the window', async () => {
    // 51 jobs is one full page and one more. No email on file ends each job at the first rule, with no send.
    const customers = await trx('customers').insert(Array.from({ length: 51 }, (_, index) => ({
      first_name: 'Paging', last_name: 'Example', phone: `+1941556${String(index).padStart(4, '0')}`, active: true,
    }))).returning('id');
    const visits = await trx('scheduled_services').insert(customers.map((customer, index) => ({
      customer_id: customer.id, scheduled_date: day(-3 - (index % 12)), service_type: 'One-Time Pest Control', status: 'completed',
      service_key_snapshot: 'one_time_pest_control',
    }))).returning(['id', 'customer_id', 'scheduled_date', 'service_type']);
    // Each service was done on its scheduled day, so the pages run in (service day, id) order over 12 days.
    await trx('service_records').insert(visits.map((visit) => ({
      customer_id: visit.customer_id, scheduled_service_id: visit.id, service_type: visit.service_type, status: 'completed',
      service_date: visit.scheduled_date,
    })));
    const summary = await run();
    expect(summary).toMatchObject({ jobs: 51, held: 51, sample: 0, failed: 0 });
    expect(summary.reasons).toEqual({ no_email: 51 });
  });

  // An annual prepay term and its invoice, as the churn guard reads them (customer-lifecycle-guard.js).
  async function seedPrepayTerm(customer, status, invoiceStatus) {
    const [invoice] = await trx('invoices').insert({
      token: hex(16), invoice_number: `TEST-${hex(4)}`, customer_id: customer.id, subtotal: 400, total: 400, status: invoiceStatus,
    }).returning('id');
    await trx('annual_prepay_terms').insert({
      customer_id: customer.id, term_start: day(-30), term_end: day(335), status, prepay_invoice_id: invoice.id,
      coverage_service_type: 'General Pest Control', coverage_visit_count: 4, prepay_amount: 400,
    });
  }

  // A plan has several records, and one alone is enough: the account can say "has a plan" with no recurring
  // visit and no named plan rate, and a plan can be a service the offer ladder has no family for. The offer
  // removes a setup fee from a NEW plan, so such a customer must never be priced as new.
  test.each([
    ['a tier on the account', async (customer) => trx('customers').where({ id: customer.id }).update({ waveguard_tier: 'Gold' })],
    ['a legacy monthly rate with no tier', async (customer) => trx('customers').where({ id: customer.id }).update({ monthly_rate: 45 })],
    ['a billed plan rate the ledger could not name', async (customer) => trx('customer_plan_rates').insert({ customer_id: customer.id, family_key: 'unattributed', monthly_rate: 45 })],
    // Palm injection maps to no offer family: the live recurring row itself is the plan.
    ['an annual prepay whose paid coverage is live', async (customer) => seedPrepayTerm(customer, 'active', 'paid')],
  ])('the real offer pricing: %s means the customer has a plan, so no price and no sample', async (_name, arrange) => {
    const { customer } = await seedJob();
    await arrange(customer);
    Lookup.performPropertyLookup.mockResolvedValue({ enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
    const summary = await run({});
    expect(summary).toMatchObject({ sample: 0, office: 0, held: 1, failed: 0 });
    expect(summary.reasons).toEqual({ has_plan: 1 });
    expect(Sendgrid.sendOne).not.toHaveBeenCalled();
  });

  // These plan records also stop the job at a send rule that runs before the pricer: a booked plan visit is
  // another visit, and a prepay invoice that is still payable is an open balance. So the pricer never sees them.
  test.each([
    ['a recurring palm injection visit, which maps to no offer family', async (customer) => trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(30), service_type: 'Palm Injection', status: 'pending', is_recurring: true, recurring_pattern: 'quarterly',
    }), 'another_visit'],
    ['an annual prepay invoice that is still payable', async (customer) => seedPrepayTerm(customer, 'payment_pending', 'sent'), 'open_balance'],
  ])('a customer with %s is held by a send rule before the pricer', async (_name, arrange, reason) => {
    const { customer } = await seedJob();
    await arrange(customer);
    const buildStartOffer = priced();
    const summary = await run({ buildStartOffer });
    expect(summary).toMatchObject({ sample: 0, office: 0, held: 1, failed: 0 });
    expect(summary.reasons).toEqual({ [reason]: 1 });
    expect(buildStartOffer).not.toHaveBeenCalled();
  });

  test('the plan visit price must be below the price of the job: the office prices it by hand otherwise', async () => {
    const { job } = await seedJob({ invoice: { status: 'paid', total: 104.5 } });
    const summary = await run();
    expect(summary).toMatchObject({ sample: 0, office: 1, held: 0, failed: 0 });
    expect(summary.reasons).toEqual({ plan_not_below_job: 1 });
    expect(await sampleRows(job.id)).toHaveLength(0);
  });

  test('the job price is the largest PAID invoice of the job; a void or open one never counts', async () => {
    const { job } = await seedJob({ invoice: { status: 'paid', total: 60 } });
    const more = (status, total) => trx('invoices').insert({
      token: hex(16), invoice_number: `TEST-${hex(4)}`, customer_id: job.customer_id, scheduled_service_id: job.id, subtotal: total, total, status,
    });
    await more('paid', 150);
    await more('void', 500);
    expect(await run()).toMatchObject({ sample: 1, office: 0, failed: 0 });
  });

  test('the real offer pricing: a home with a saved lookup is sampled at the engine price; the lookup is cache-only', async () => {
    const { job } = await seedJob();
    Lookup.performPropertyLookup.mockResolvedValue({ enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
    const summary = await run({});
    expect(summary).toMatchObject({ sample: 1, office: 0, failed: 0 });
    // No paid lookup can run from this job: every call is a cache read that stores nothing. The reads are
    // strict, so a failed cache read is an outage for the job and never "no saved lookup". These are all the
    // options: the start offer's lookup never asks for the sizing of a business suite.
    expect(Lookup.performPropertyLookup).toHaveBeenCalled();
    for (const [, options] of Lookup.performPropertyLookup.mock.calls) {
      expect(options).toEqual({ cacheOnly: true, persist: false, strictCacheReads: true });
    }
    const [offer] = await sampleRows(job.id);
    expect(offer.text_snapshot).toMatch(/Price: \$\d+(\.\d{2})? per application/);
    expect(offer.text_snapshot).toMatch(/One-time setup fee: \$0 \(normally \$\d+\)/);
  });

  // The price is for the customer's home, so every visit of the account must be at that home. The offer
  // pricing runs the account's single-premises proof in its strict form: a link that cannot be resolved fails it.
  const SAVED_LOOKUP = { enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} };
  const stampedAt = (customer, line1) => ({ service_address_line1: line1, service_address_city: customer.city, service_address_zip: customer.zip });
  const fromEstimate = async (customer, address) => {
    const [estimate] = await trx('estimates').insert({ customer_id: customer.id, status: 'accepted', address }).returning('id');
    return { source_estimate_id: estimate.id };
  };

  test.each([
    ['is stamped at the home', async (customer) => stampedAt(customer, customer.address_line1)],
    ['came from an estimate for the home', async (customer) => fromEstimate(customer, `${customer.address_line1}, ${customer.city}, FL ${customer.zip}`)],
  ])('the real offer pricing: a job that %s is sampled', async (_name, link) => {
    const customer = await seedCustomer();
    await seedJob({ customer, ...(await link(customer)) });
    Lookup.performPropertyLookup.mockResolvedValue(SAVED_LOOKUP);
    expect(await run({})).toMatchObject({ sample: 1, office: 0, held: 0, failed: 0 });
  });

  test.each([
    ['came from an estimate with no address', async (customer) => fromEstimate(customer, null)],
    ['is stamped at another home', async (customer) => stampedAt(customer, '77 Other Test Way')],
    // The job carries no proof of its own, and an older visit of the account could be at a second home.
    ['has no stamp and no link, while an older visit of the account came from an estimate with no address', async (customer) => {
      await trx('scheduled_services').insert({
        customer_id: customer.id, scheduled_date: day(-40), service_type: 'One-Time Pest Control', status: 'completed', ...(await fromEstimate(customer, null)),
      });
      return {};
    }],
  ])('the real offer pricing: a job that %s is not priced at the home; it is counted for the office', async (_name, link) => {
    const customer = await seedCustomer();
    await seedJob({ customer, ...(await link(customer)) });
    Lookup.performPropertyLookup.mockResolvedValue(SAVED_LOOKUP);
    const summary = await run({});
    expect(summary).toMatchObject({ sample: 0, office: 1, held: 0, failed: 0 });
    expect(summary.reasons).toEqual({ premises: 1 });
    expect(Sendgrid.sendOne).not.toHaveBeenCalled();
  });

  test('the real offer pricing: a home with no saved lookup is not sampled; it is counted for the office', async () => {
    await seedJob();
    const summary = await run({});
    expect(summary).toMatchObject({ sample: 0, office: 1, held: 0, failed: 0 });
    expect(summary.reasons).toEqual({ not_priced: 1 });
    expect(Sendgrid.sendOne).not.toHaveBeenCalled();
  });

  // The offer is a residential plan. The job has no rule of its own for a business: the offer pricing asks the
  // shared plan-start proof, which reads the account and every visit of it, the job's own row included.
  test.each([
    ['the account is a business', async (customer) => trx('customers').where({ id: customer.id }).update({ building_use: 'nonresidential' }), {}],
    ['the job itself was a commercial service, under a one-time pest key', async () => {}, { service_type: 'Commercial One-Time Pest Control' }],
  ])('the real offer pricing: %s, so the home is not priced; it is counted for the office', async (_name, arrange, visit) => {
    const { customer } = await seedJob(visit);
    await arrange(customer);
    Lookup.performPropertyLookup.mockResolvedValue(SAVED_LOOKUP);
    const summary = await run({});
    expect(summary).toMatchObject({ sample: 0, office: 1, held: 0, failed: 0 });
    expect(summary.reasons).toEqual({ premises: 1 });
    expect(Sendgrid.sendOne).not.toHaveBeenCalled();
  });

  // ---- The price settings stop. ----
  // The pricer refuses to price while a pest price row is not complete. No page shows that the offers stopped,
  // so the job says it: one admin notification, on the real table, through the real notification writer.
  describe('the price settings notification', () => {
    const KEY = 'onetime-plan-offer:price-settings';
    const alertRows = () => trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [KEY]).orderBy('created_at', 'asc');
    const open = (rows) => rows.filter((row) => row.done_at === null);
    const baseRow = async () => (await trx('pricing_config').where({ config_key: 'pest_base' }).select('*'))[0];
    const removeBaseRow = () => trx('pricing_config').where({ config_key: 'pest_base' }).del();
    const putBack = (row) => trx('pricing_config').insert({ ...row, data: JSON.stringify(row.data) });

    test('no price for a whole morning opens one notification; the next morning refreshes it; a priced morning closes it; a new outage opens a new one', async () => {
      await seedJob();
      await seedJob();
      Lookup.performPropertyLookup.mockResolvedValue(SAVED_LOOKUP);
      const row = await baseRow();
      await removeBaseRow();

      expect(await run({})).toMatchObject({ jobs: 2, failed: 2, sample: 0, office: 0 });
      let rows = await alertRows();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        category: 'system', title: 'Estimates — check the pest price settings', link: '/admin/pricing-logic', done_at: null,
      });
      expect(rows[0].metadata).toMatchObject({ refused: 2, severity: 'needs-you', who: 'either', doneWhen: 'plan_offer_priced' });
      expect(rows[0].detail).toContain('could not price 2 one-time jobs this morning');
      expect(Sendgrid.sendOne).not.toHaveBeenCalled();

      // The next morning one more job is due and the row is still gone: the same notification, with the new count.
      await seedJob();
      expect(await run({})).toMatchObject({ jobs: 3, failed: 3 });
      rows = await alertRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata.refused).toBe(3);
      expect(rows[0].done_at).toBeNull();

      // The row is back: every job is sampled and the notification is closed, with what closed it.
      await putBack(row);
      expect(await run({})).toMatchObject({ jobs: 3, sample: 3, failed: 0 });
      rows = await alertRows();
      expect(rows).toHaveLength(1);
      expect(rows[0].done_at).not.toBeNull();
      expect(rows[0].metadata).toMatchObject({ autoCleared: true, autoClearedReason: 'plan_offer_priced' });
      expect(rows[0].resolution).toBe('The plan offer job priced a home again');

      // A closed notification never hides a new outage.
      await seedJob();
      await removeBaseRow();
      expect(await run({})).toMatchObject({ jobs: 4, done: 3, failed: 1 });
      rows = await alertRows();
      expect(rows).toHaveLength(2);
      expect(open(rows)).toHaveLength(1);
      expect(open(rows)[0].metadata.refused).toBe(1);
    });

    test('a morning that prices with no notification open writes nothing', async () => {
      await seedJob();
      Lookup.performPropertyLookup.mockResolvedValue(SAVED_LOOKUP);
      expect(await run({})).toMatchObject({ sample: 1, failed: 0 });
      expect(await alertRows()).toHaveLength(0);
    });

    test('a home with no saved lookup is not an outage of the settings: no notification', async () => {
      await seedJob();
      expect(await run({})).toMatchObject({ office: 1, failed: 0 });
      expect(await alertRows()).toHaveLength(0);
    });
  });

  // ---- The included follow-up (owner 2026-11-22, "2A"). ----
  // A cockroach job often includes one free follow-up visit: a row with followup_included, linked to the job by
  // followup_source_service_id and parent_service_id (package-followup-booking.js). Once it is done, the days
  // of the offer count from the day it was done.
  const SHORT = { year: undefined, month: 'short' };
  const roach = { service_key_snapshot: 'cockroach_control', service_type: 'Cockroach Control' };
  // The follow-up of `job`: completed and performed `daysAgo` days ago, unless the test says otherwise.
  async function seedFollowUp(job, { daysAgo = 5, status = 'completed', record = {}, ...row } = {}) {
    const [followUp] = await trx('scheduled_services').insert({
      customer_id: job.customer_id, scheduled_date: day(-daysAgo), service_type: 'Cockroach Control Follow-Up', status,
      service_key_snapshot: 'cockroach_control', followup_included: true, followup_source_service_id: job.id, parent_service_id: job.id, ...row,
    }).returning('*');
    if (record) await seedRecord(followUp, { service_date: day(-daysAgo), ...record });
    return followUp;
  }

  test('the follow-up was done 5 days ago and the job 16 days ago: the job is due, and every date follows the follow-up', async () => {
    const { job } = await seedJob({ daysAgo: 16, ...roach });
    await seedFollowUp(job, { daysAgo: 5 });
    expect(await run()).toMatchObject({ jobs: 1, sample: 1, held: 0, failed: 0 });
    // The follow-up is the job's own: a completed follow-up is not "a visit completed after the job".
    const [offer] = await sampleRows(job.id);
    const noYear = { year: undefined };
    const weekday = formatDateOnly(day(-5), { ...noYear, month: undefined, day: undefined, weekday: 'long' });
    expect(offer.text_snapshot).toContain(`Thanks for having us out on ${weekday}, ${formatDateOnly(day(-5), SHORT)}.`);
    expect(offer.text_snapshot).toContain(`we serviced your home on ${formatDateOnly(day(-5), SHORT)}.`);
    expect(offer.text_snapshot).toContain(`Next visit: You pick, ${formatDateOnly(day(72), SHORT)} to ${formatDateOnly(day(86), SHORT)}`);
    expect(offer.text_snapshot).toContain(`This estimate is good through ${formatDateOnly(day(25), noYear)}.`);
    expect(await run()).toMatchObject({ sample: 0, done: 1, failed: 0 });
  });

  test('the window is the offer day: a follow-up done 2 days ago keeps a job of 16 days ago out, and one done 15 days ago leaves a job of 6 days ago out', async () => {
    const tooFresh = await seedJob({ daysAgo: 16, ...roach });
    await seedFollowUp(tooFresh.job, { daysAgo: 2 });
    const tooOld = await seedJob({ daysAgo: 20, ...roach });
    await seedFollowUp(tooOld.job, { daysAgo: 15 });
    // A follow-up done on the day of the job, or before it, never moves the day back.
    const sameDay = await seedJob({ daysAgo: 6, ...roach });
    await seedFollowUp(sameDay.job, { daysAgo: 6 });
    const summary = await run();
    expect(summary).toMatchObject({ jobs: 1, sample: 1, failed: 0 });
    expect(await sampledJobIds([tooFresh.job, tooOld.job, sameDay.job])).toEqual([sameDay.job.id]);
  });

  test('a complaint from between the job and its follow-up still holds: "since the job" starts at the job day', async () => {
    const { customer, job } = await seedJob({ daysAgo: 16, ...roach });
    await seedFollowUp(job, { daysAgo: 5 });
    await trx('customer_interactions').insert({
      customer_id: customer.id, interaction_type: 'complaint', subject: 'Still seeing activity', created_at: await easternInstant(day(-10), '12:00'),
    });
    const summary = await run();
    expect(summary).toMatchObject({ sample: 0, held: 1, failed: 0 });
    expect(summary.reasons).toEqual({ complaint: 1 });
  });

  test('a cancelled follow-up does not count: the days count from the job', async () => {
    const due = await seedJob({ daysAgo: 6, ...roach });
    await seedFollowUp(due.job, { daysAgo: 2, status: 'cancelled', record: false });
    const old = await seedJob({ daysAgo: 16, ...roach });
    await seedFollowUp(old.job, { daysAgo: 5, status: 'cancelled', record: false });
    expect(await run()).toMatchObject({ jobs: 1, sample: 1, held: 0, failed: 0 });
    expect(await sampledJobIds([due.job, old.job])).toEqual([due.job.id]);
    const [offer] = await sampleRows(due.job.id);
    expect(offer.text_snapshot).toContain(`we serviced your home on ${formatDateOnly(day(-6), SHORT)}.`);
  });

  // A follow-up that is still to come keeps the offer waiting, through the rule for another visit.
  test.each([
    ['pending, with a day that has passed', { status: 'pending', daysAgo: 2 }, 'another_visit'],
    ['confirmed for a day to come', { status: 'confirmed', daysAgo: -3 }, 'another_visit'],
    ['parked for a new day, still dated today', { status: 'rescheduled', daysAgo: 0 }, 'another_visit'],
    ['parked for a new day, and its day has passed', { status: 'rescheduled', daysAgo: 2 }, null],
    ['skipped', { status: 'skipped', daysAgo: 2 }, null],
  ])('an open follow-up (%s)', async (_name, followUp, reason) => {
    const { job } = await seedJob({ daysAgo: 6, ...roach });
    await seedFollowUp(job, { ...followUp, record: false });
    const summary = await run();
    if (reason) {
      expect(summary).toMatchObject({ sample: 0, held: 1, failed: 0 });
      expect(summary.reasons).toEqual({ [reason]: 1 });
    } else {
      expect(summary).toMatchObject({ sample: 1, held: 0, failed: 0 });
    }
  });

  // A follow-up closed 'completed' with no performed service (inspection only, declined, incomplete, no record)
  // is not a done follow-up. It does not move the day, and it does not hold.
  test.each([
    ['inspection only', { record: { structured_notes: { visitOutcome: 'inspection_only' } } }],
    ['declined by the customer', { record: { structured_notes: { visitOutcome: 'customer_declined' } } }],
    ['incomplete, by the status of its record', { record: { status: 'incomplete', structured_notes: {} } }],
    ['closed with no service record at all', { record: false }],
    ['a performed record of ANOTHER customer that names the follow-up', { record: { customer_id: 'other' } }],
  ])('a follow-up closed %s: no hold, and the days count from the job', async (_name, followUp) => {
    const due = await seedJob({ daysAgo: 6, ...roach });
    const old = await seedJob({ daysAgo: 16, ...roach });
    const other = await seedCustomer();
    for (const { job } of [due, old]) {
      const record = followUp.record && followUp.record.customer_id === 'other' ? { ...followUp.record, customer_id: other.id } : followUp.record;
      await seedFollowUp(job, { daysAgo: 2, record });
    }
    expect(await run()).toMatchObject({ jobs: 1, sample: 1, held: 0, failed: 0 });
    expect(await sampledJobIds([due.job, old.job])).toEqual([due.job.id]);
    const [offer] = await sampleRows(due.job.id);
    expect(offer.text_snapshot).toContain(`we serviced your home on ${formatDateOnly(day(-6), SHORT)}.`);
  });

  test("a row of another customer, or one linked to another visit, is not the job's follow-up", async () => {
    // Linked to the job, but of another customer: no day for the job, and no hold on it.
    const foreign = await seedJob({ daysAgo: 16, ...roach });
    const stranger = await seedCustomer();
    await seedFollowUp(foreign.job, { daysAgo: 5, customer_id: stranger.id });
    const foreignDue = await seedJob({ daysAgo: 6, ...roach });
    await seedFollowUp(foreignDue.job, { daysAgo: 2, customer_id: (await seedCustomer()).id });
    expect(await run()).toMatchObject({ jobs: 1, sample: 1, held: 0, failed: 0 });
    expect(await sampledJobIds([foreign.job, foreignDue.job])).toEqual([foreignDue.job.id]);
    const [offer] = await sampleRows(foreignDue.job.id);
    expect(offer.text_snapshot).toContain(`we serviced your home on ${formatDateOnly(day(-6), SHORT)}.`);
  });

  test("a completed follow-up row that is not linked to the job moves no day, and it holds the job like any visit done after it", async () => {
    const { customer, job } = await seedJob({ daysAgo: 8, ...roach });
    const [earlier] = await trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(-40), service_type: 'Cockroach Control', status: 'completed', service_key_snapshot: 'cockroach_control',
    }).returning('id');
    // The flag is set, but the links name another visit (or none).
    await seedFollowUp(job, { daysAgo: 5, followup_source_service_id: earlier.id, parent_service_id: null });
    const summary = await run();
    expect(summary).toMatchObject({ jobs: 1, sample: 0, held: 1, failed: 0 });
    expect(summary.reasons).toEqual({ another_visit: 1 });
    // A row with the flag and no links at all is the same.
    const loose = await seedJob({ daysAgo: 9, ...roach });
    await seedFollowUp(loose.job, { daysAgo: 4, followup_source_service_id: null, parent_service_id: null });
    expect(await run()).toMatchObject({ jobs: 2, sample: 0, held: 2, failed: 0 });
  });

  test('another visit completed after the follow-up still holds the job', async () => {
    const { customer, job } = await seedJob({ daysAgo: 16, ...roach });
    await seedFollowUp(job, { daysAgo: 5 });
    await trx('scheduled_services').insert({ customer_id: customer.id, scheduled_date: day(-3), service_type: 'Re-Service', status: 'completed' });
    const summary = await run();
    expect(summary).toMatchObject({ jobs: 1, sample: 0, held: 1, failed: 0 });
    expect(summary.reasons).toEqual({ another_visit: 1 });
  });

  test('a job with no performed record is never due, also when its follow-up was performed (GREATEST skips a NULL)', async () => {
    const none = await seedJob({ daysAgo: 8, record: false, ...roach });
    await seedFollowUp(none.job, { daysAgo: 5 });
    const notPerformed = await seedJob({ daysAgo: 6, record: { structured_notes: { visitOutcome: 'inspection_only' } }, ...roach });
    await seedFollowUp(notPerformed.job, { daysAgo: 4 });
    expect(await run()).toMatchObject({ jobs: 0, sample: 0, held: 0, failed: 0 });
    expect(await sampledJobIds([none.job, notPerformed.job])).toEqual([]);
  });

  test('a follow-up row is never a due job of its own, though it is a roach visit with a performed record', async () => {
    const { job } = await seedJob({ daysAgo: 16, ...roach });
    const followUp = await seedFollowUp(job, { daysAgo: 5 });
    await run();
    expect(await sampledJobIds([followUp])).toEqual([]);
  });

  // Offer days and job days differ, so the order of the pages is the offer-day order. A page cursor on the job
  // day would skip jobs or read some twice.
  test('more due jobs than one page, with follow-up days that reorder them: every job is read once', async () => {
    const customers = await trx('customers').insert(Array.from({ length: 60 }, (_, index) => ({
      first_name: 'Paging', last_name: 'Example', phone: `+1941557${String(index).padStart(4, '0')}`, active: true,
    }))).returning('id');
    const jobs = await trx('scheduled_services').insert(customers.map((customer, index) => ({
      customer_id: customer.id, scheduled_date: day(index % 3 === 0 ? -(3 + (index % 12)) : -(20 + (index % 5))),
      service_type: 'Cockroach Control', status: 'completed', service_key_snapshot: 'cockroach_control',
    }))).returning(['id', 'customer_id', 'scheduled_date', 'service_type']);
    await trx('service_records').insert(jobs.map((job) => ({
      customer_id: job.customer_id, scheduled_service_id: job.id, service_type: job.service_type, status: 'completed', service_date: job.scheduled_date,
    })));
    // Two jobs in three were done long ago and have a follow-up done inside the window, on days that cut across
    // the job days of the other jobs.
    const withFollowUp = jobs.filter((_, index) => index % 3 !== 0);
    const followUps = await trx('scheduled_services').insert(withFollowUp.map((job, index) => ({
      customer_id: job.customer_id, scheduled_date: day(-(3 + ((index * 5) % 12))), service_type: 'Cockroach Control Follow-Up', status: 'completed',
      service_key_snapshot: 'cockroach_control', followup_included: true, followup_source_service_id: job.id, parent_service_id: job.id,
    }))).returning(['id', 'customer_id', 'scheduled_date', 'service_type']);
    await trx('service_records').insert(followUps.map((followUp) => ({
      customer_id: followUp.customer_id, scheduled_service_id: followUp.id, service_type: followUp.service_type, status: 'completed',
      service_date: followUp.scheduled_date,
    })));
    // No email on file ends each job at the first rule it reaches, with no send.
    const summary = await run();
    expect(summary).toMatchObject({ jobs: 60, held: 60, sample: 0, failed: 0 });
    expect(summary.reasons).toEqual({ no_email: 60 });
  });

  test('with the gate at true (the future customer value) the job does nothing', async () => {
    process.env.GATE_ONETIME_PLAN_OFFER = 'true';
    const { job } = await seedJob();
    expect(await run()).toMatchObject({ mode: 'off', jobs: 0, sample: 0 });
    expect(await sampleRows(job.id)).toHaveLength(0);
  });

  // ---- Live (owner 2026-11-20, "i want auto"). ----
  // The REAL mint (mintPlanStartEstimate with `offer`), the REAL card-rail check, the REAL ledger and the REAL
  // template library, on the rows below. Only the provider send (Sendgrid.sendOne) and the property lookup are stubs.
  describe('live', () => {
    // The real send's unsubscribe is the SendGrid ASM group of the marketing stream (the ledger passes no link).
    const cardEnv = ['SENDGRID_ASM_GROUP_NEWSLETTER'];
    let savedCardEnv;
    const readPlan = (value) => (typeof value === 'string' ? JSON.parse(value) : value);

    beforeEach(() => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'live';
      savedCardEnv = Object.fromEntries(cardEnv.map((name) => [name, process.env[name]]));
      for (const name of cardEnv) process.env[name] = '101';
      Lookup.performPropertyLookup.mockResolvedValue({ enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
    });
    afterEach(() => {
      for (const name of cardEnv) {
        if (savedCardEnv[name] === undefined) delete process.env[name];
        else process.env[name] = savedCardEnv[name];
      }
    });

    // The owner's publish of the offer template: an active version on an active template (publishVersion's result).
    async function publishOffer() {
      const template = await trx('email_templates').where({ template_key: OFFER }).first('id');
      const version = await trx('email_template_versions').where({ template_id: template.id }).orderBy('version_number', 'desc').first('id');
      await trx('email_template_versions').where({ id: version.id }).update({ status: 'active' });
      await trx('email_templates').where({ id: template.id }).update({ status: 'active', active_version_id: version.id });
    }

    const offerKey = (jobId) => `onetime-plan-offer:offer:${jobId}`;
    const offerMail = (jobId) => trx('email_messages').where({ idempotency_key: offerKey(jobId) }).first();
    const ledgerRow = (jobId) => trx('marketing_email_ledger').where({ idempotency_key: offerKey(jobId) }).first();
    const estimatesOf = (customer) => trx('estimates').where({ customer_id: customer.id }).orderBy('created_at', 'asc');
    const tomorrow = new Date(NOW.getTime() + 24 * HOUR);
    const runAt = (at) => Offer.runOnetimePlanOfferJob({ now: at, deps: {} });

    // A job's offer terms by hand: the job's service was done `daysAgo` ET days ago.
    const { parseETDateTime } = require('../utils/datetime-et');
    const endsOf = (daysAgo) => new Date(parseETDateTime(`${day(30 - daysAgo)}T23:59:59`).getTime() + 999);

    test('a paid one-time job: the customer gets the real estimate and ONE offer email; the next morning sends nothing more', async () => {
      await publishOffer();
      const { customer, job } = await seedJob();
      const summary = await run({});
      expect(summary).toMatchObject({ mode: 'live', jobs: 1, sent: 1, sample: 0, held: 0, office: 0, done: 0, failed: 0 });
      expect(summary).not.toHaveProperty('words_not_approved');

      // The estimate: a plan-start quote with the offer stamp, no setup fee and its own end date.
      const [estimate, ...others] = await estimatesOf(customer);
      expect(others).toEqual([]);
      expect(estimate).toMatchObject({ source: 'plan_start', status: 'sent' });
      expect(Number(estimate.onetime_total)).toBe(0);
      expect(new Date(estimate.expires_at).getTime()).toBe(endsOf(5).getTime());
      const data = readPlan(estimate.estimate_data);
      expect(data.planStart.offer).toEqual({ jobId: String(job.id), endsAt: endsOf(5).toISOString(), firstVisitFrom: day(72) });
      expect(Offer.offerTerms(day(-5))).toMatchObject({ firstVisitFrom: day(72), endsAt: endsOf(5) });
      expect(data.operatorPriceAdjustment).toMatchObject({ waiveSetupFee: true });

      // One email, to the customer's own address, from the ledger, with the link to THIS estimate.
      const mail = await offerMail(job.id);
      expect(mail).toMatchObject({ template_key: OFFER, status: 'sent', recipient_email_snapshot: customer.email, recipient_type: 'customer', provider_message_id: 'sg-sample' });
      expect(mail.sent_at).not.toBeNull();
      expect(mail.subject_snapshot).toBe('Your pest control plan estimate, with no setup fee');
      expect(mail.html_snapshot).toContain(`/estimate/${estimate.token}`);
      expect(mail.html_snapshot).not.toContain('/estimate/sample');
      expect(mail.html_snapshot).not.toMatch(/\{\{/);
      expect(mail.html_snapshot).not.toContain('Sample only');
      expect(mail.text_snapshot).toContain('Hi Jordan,');
      expect(mail.text_snapshot).toContain('One-time setup fee: $0 (normally $');
      expect(mail.text_snapshot).toContain('Due today: $0');
      expect(mail.text_snapshot).toContain('You pay after each visit. Nothing is charged today.');
      expect(Sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(Sendgrid.sendOne.mock.calls[0][0].to).toBe(customer.email);
      expect(await ledgerRow(job.id)).toMatchObject({
        customer_id: customer.id, stream: 'nurture', marketing_class: 'marketing', email_key: OFFER, status: 'sent', recipient_email: customer.email,
      });
      // No office sample in live, and no reminder.
      expect(await sampleRows(job.id)).toEqual([]);
      expect(await trx('email_messages').where({ template_key: REMINDER }).first('id')).toBeUndefined();

      // The next morning: done. No second email, no second quote.
      expect(await runAt(tomorrow)).toMatchObject({ mode: 'live', jobs: 1, done: 1, sent: 0, failed: 0 });
      expect(Sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(await estimatesOf(customer)).toHaveLength(1);
      expect(await trx('marketing_email_ledger').where({ customer_id: customer.id, email_key: OFFER })).toHaveLength(1);
    });

    test('the offer template is still a draft (as the migration seeds it): the run reads no job, makes no estimate and sends nothing', async () => {
      const { customer } = await seedJob();
      expect(await run({})).toMatchObject({ mode: 'live', jobs: 0, sent: 0, failed: 0, words_not_approved: true });
      expect(await estimatesOf(customer)).toEqual([]);
      expect(Sendgrid.sendOne).not.toHaveBeenCalled();
      expect(await trx('marketing_email_ledger').where({ customer_id: customer.id }).first('id')).toBeUndefined();
      // A template the owner paused or archived after publishing is no published words either.
      await publishOffer();
      await trx('email_templates').where({ template_key: OFFER }).update({ status: 'paused' });
      expect(await run({})).toMatchObject({ jobs: 0, words_not_approved: true });
      expect(Sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test.each([
      ['shadow', { jobs: 1, sample: 1 }],
      ['true', { jobs: 0, sample: 0 }],
      ['Live', { jobs: 0, sample: 0 }],
    ])('the gate at %s never makes an estimate and never sends the customer anything, even with the template published', async (value, expected) => {
      await publishOffer();
      process.env.GATE_ONETIME_PLAN_OFFER = value;
      const { customer, job } = await seedJob();
      expect(await run({})).toMatchObject(expected);
      expect(await estimatesOf(customer)).toEqual([]);
      expect(await offerMail(job.id)).toBeUndefined();
      expect(await ledgerRow(job.id)).toBeUndefined();
      expect(Sendgrid.sendOne.mock.calls.every(([mail]) => mail.to === OFFICE)).toBe(true);
    });

    // A send the division denies AFTER the job's own check passed: the customer turns marketing off in between
    // (here, right after the estimate is made). The quote stays on file. The next morning, with the switch back
    // on, the job gets past its own quote, reuses it (same token) and sends.
    test('a denied send leaves the quote on file; the next morning reuses it and sends the one email', async () => {
      await publishOffer();
      const { customer, job } = await seedJob();
      const real = require('../services/cancellation-resolution/restart').mintPlanStartEstimate;
      const optOutAfterMint = jest.fn(async (args) => {
        const minted = await real(args);
        await trx('notification_prefs').insert({ customer_id: customer.id, email_enabled: false });
        return minted;
      });
      const first = await run({ mintPlanStartEstimate: optOutAfterMint });
      expect(first).toMatchObject({ sent: 0, held: 1, failed: 0 });
      expect(first.reasons).toEqual({ email_switch_off: 1 });
      expect(Sendgrid.sendOne).not.toHaveBeenCalled();
      const [quote, ...rest] = await estimatesOf(customer);
      expect(rest).toEqual([]);
      expect(readPlan(quote.estimate_data).planStart.offer.jobId).toBe(String(job.id));
      expect(await offerMail(job.id)).toBeUndefined();

      await trx('notification_prefs').where({ customer_id: customer.id }).update({ email_enabled: true });
      expect(await runAt(tomorrow)).toMatchObject({ sent: 1, held: 0, failed: 0 });
      const after = await estimatesOf(customer);
      expect(after.map((row) => row.id)).toEqual([quote.id]);
      const mail = await offerMail(job.id);
      expect(mail.html_snapshot).toContain(`/estimate/${quote.token}`);
      expect(Sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(await trx('marketing_email_ledger').where({ customer_id: customer.id, email_key: OFFER })).toHaveLength(1);
    });

    // The provider fails: the ledger settles the row failed and the library's message row never reached it. The job
    // fails for the morning. The next morning sends under the same key and the same quote, and the customer gets one email.
    test('a provider failure leaves the quote on file and the key unsent; the next morning sends once', async () => {
      await publishOffer();
      const { customer, job } = await seedJob();
      Sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('provider down'), { status: 500 }));
      const first = await run({});
      expect(first).toMatchObject({ sent: 0, failed: 1 });
      const [quote] = await estimatesOf(customer);
      expect((await ledgerRow(job.id)).status).toBe('failed');
      const mail = await offerMail(job.id);
      expect(mail?.sent_at ?? null).toBeNull();

      // The library holds a message queued less than 2 minutes ago as in flight. The test's clock is the database's, so
      // age the row by the day the next morning is away.
      await trx('email_messages').where({ idempotency_key: offerKey(job.id) }).update({ queued_at: new Date(Date.now() - 24 * HOUR) });
      const second = await runAt(tomorrow);
      expect(second).toMatchObject({ sent: 1, failed: 0 });
      expect((await estimatesOf(customer)).map((row) => row.id)).toEqual([quote.id]);
      expect((await ledgerRow(job.id)).status).toBe('sent');
      expect((await offerMail(job.id)).sent_at).not.toBeNull();
      expect(await trx('marketing_email_ledger').where({ customer_id: customer.id, email_key: OFFER })).toHaveLength(1);
      expect(Sendgrid.sendOne).toHaveBeenCalledTimes(2);
      // The third morning is done: no third attempt.
      expect(await runAt(new Date(tomorrow.getTime() + 24 * HOUR))).toMatchObject({ done: 1, sent: 0 });
      expect(Sendgrid.sendOne).toHaveBeenCalledTimes(2);
    });

    // The real transport marks the handoff 'started' before the request. A failure after that may have gone out, so the
    // library refuses to retry it and the job counts the offer as sent: never a second email.
    test('a provider failure after the handoff started may have gone out: the next morning is done and sends nothing', async () => {
      await publishOffer();
      const { customer, job } = await seedJob();
      Sendgrid.sendOne.mockRejectedValueOnce(Object.assign(new Error('timed out'), { status: 504 }));
      expect(await run({})).toMatchObject({ sent: 0, failed: 1 });
      await trx('email_messages').where({ idempotency_key: offerKey(job.id) }).update({ provider_handoff_phase: 'started' });
      expect(await runAt(tomorrow)).toMatchObject({ done: 1, sent: 0, failed: 0 });
      expect(Sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(await estimatesOf(customer)).toHaveLength(1);
    });

    describe('one offer per customer per 12 months', () => {
      const earlierOffer = (customer, { daysAgo, status = 'sent', key = `onetime-plan-offer:offer:${crypto.randomUUID()}`, emailKey = OFFER }) => trx('marketing_email_ledger').insert({
        customer_id: customer.id, stream: 'nurture', marketing_class: 'marketing', email_key: emailKey, idempotency_key: key,
        recipient_email: customer.email, status, reserved_at: new Date(NOW.getTime() - daysAgo * 24 * HOUR),
        sent_at: status === 'sent' ? new Date(NOW.getTime() - daysAgo * 24 * HOUR) : null,
      });

      test.each([
        ['sent 200 days ago', { daysAgo: 200 }],
        ['sent 364 days ago', { daysAgo: 364 }],
        ['reserved 1 day ago (an offer still in flight)', { daysAgo: 1, status: 'reserved' }],
      ])('an offer for another job %s holds this job: no estimate, no email', async (_name, earlier) => {
        await publishOffer();
        const { customer, job } = await seedJob();
        await earlierOffer(customer, earlier);
        const summary = await run({});
        expect(summary).toMatchObject({ sent: 0, held: 1, failed: 0 });
        expect(summary.reasons).toEqual({ offered_before: 1 });
        expect(await estimatesOf(customer)).toEqual([]);
        expect(await offerMail(job.id)).toBeUndefined();
        expect(Sendgrid.sendOne).not.toHaveBeenCalled();
      });

      test.each([
        ['one sent 366 days ago', async (customer) => earlierOffer(customer, { daysAgo: 366 })],
        ['one that failed', async (customer) => earlierOffer(customer, { daysAgo: 2, status: 'failed' })],
        ['another template', async (customer) => earlierOffer(customer, { daysAgo: 100, emailKey: 'nurture.expired_1' })],
        // The office sample is a TEST send: it is an email_messages row for the office and no ledger row at all.
        ['the office sample of this very job', async (customer, job) => trx('email_messages').insert({
          template_key: OFFER, idempotency_key: sampleKey(OFFER, job.id), recipient_email_snapshot: OFFICE, recipient_type: 'test', status: 'sent', sent_at: new Date(),
        })],
      ])('not a hold: %s', async (_name, arrange) => {
        await publishOffer();
        const { customer, job } = await seedJob();
        await arrange(customer, job);
        expect(await run({})).toMatchObject({ sent: 1, held: 0, failed: 0 });
      });

      // A worker that died after it reserved and before the provider leaves a `reserved` row. The ledger settles it
      // after RESERVATION_LIFETIME_MS, but only inside a reservation, so the job's own rule settles it first.
      describe('a reservation a crash left behind (older than the ledger\'s lifetime)', () => {
        const STALE_DAYS = 3 / 24;
        const staleKey = `onetime-plan-offer:offer:${crypto.randomUUID()}`;
        const staleOffer = (customer) => earlierOffer(customer, { daysAgo: STALE_DAYS, status: 'reserved', key: staleKey });
        const staleRow = () => trx('marketing_email_ledger').where({ idempotency_key: staleKey }).first();

        test('with no provider message it is written off: it does not hold the job, and the job sends', async () => {
          await publishOffer();
          const { customer } = await seedJob();
          await staleOffer(customer);
          expect(await run({})).toMatchObject({ sent: 1, held: 0, failed: 0 });
          expect(await staleRow()).toMatchObject({ status: 'failed', reason: 'abandoned_reservation' });
        });

        test.each([
          ['the provider accepted it', { status: 'sent', sent_at: new Date() }],
          ['the handoff started and the answer was lost', { status: 'queued', provider_handoff_phase: 'started' }],
        ])('%s: it counts as an offer and still holds the job', async (_name, message) => {
          await publishOffer();
          const { customer, job } = await seedJob();
          await staleOffer(customer);
          await trx('email_messages').insert({
            idempotency_key: staleKey, recipient_email_snapshot: customer.email, recipient_type: 'customer', recipient_id: customer.id,
            template_key: OFFER, ...message,
          });
          const summary = await run({});
          expect(summary).toMatchObject({ sent: 0, held: 1, failed: 0 });
          expect(summary.reasons).toEqual({ offered_before: 1 });
          expect((await staleRow()).status).toBe('sent');
          expect(await offerMail(job.id)).toBeUndefined();
        });
      });

      // The rule's read and the reservation's guard are separate: a concurrent run can pass the rule and lose here.
      // The other job's offer lands between the job's own check and the reservation; the guard, inside the
      // reservation under the customer's lock, denies.
      test("the guard inside the reservation denies an offer that landed after the job's own check; the quote stays", async () => {
        await publishOffer();
        const { customer, job } = await seedJob();
        const real = require('../services/cancellation-resolution/restart').mintPlanStartEstimate;
        const summary = await run({
          mintPlanStartEstimate: async (args) => {
            const minted = await real(args);
            await earlierOffer(customer, { daysAgo: 200 });
            return minted;
          },
        });
        expect(summary).toMatchObject({ sent: 0, held: 1, failed: 0 });
        expect(summary.reasons).toEqual({ offered_before: 1 });
        expect(await estimatesOf(customer)).toHaveLength(1);
        expect(await ledgerRow(job.id)).toBeUndefined();
        expect(Sendgrid.sendOne).not.toHaveBeenCalled();
      });
    });

    describe('the email says "you pay after each visit": only a customer on the card rail gets it', () => {
      test('the estimate page\'s gate or the card lane off: the job is held before the home is priced, so no quote and no email', async () => {
        await publishOffer();
        process.env.GATE_PAY_AFTER_FIRST_VISIT = 'false';
        const { customer, job } = await seedJob();
        const summary = await run({});
        expect(summary).toMatchObject({ sent: 0, held: 1, failed: 0 });
        expect(summary.reasons).toEqual({ not_pay_after_visit: 1 });
        expect(await estimatesOf(customer)).toEqual([]);
        expect(await offerMail(job.id)).toBeUndefined();
        expect(Sendgrid.sendOne).not.toHaveBeenCalled();
        // The gate is back on: the next morning makes the quote and sends.
        process.env.GATE_PAY_AFTER_FIRST_VISIT = 'true';
        expect(await runAt(tomorrow)).toMatchObject({ sent: 1, held: 0 });
        expect(await estimatesOf(customer)).toHaveLength(1);
      });

      test('a customer whose Auto Pay is paused is invoiced before service: no quote, no email', async () => {
        await publishOffer();
        const customer = await seedCustomer({ autopay_paused_until: day(30) });
        const { job } = await seedJob({ customer });
        const summary = await run({});
        expect(summary.reasons).toEqual({ not_pay_after_visit: 1 });
        expect(summary).toMatchObject({ sent: 0, held: 1 });
        expect(await estimatesOf(customer)).toEqual([]);
        expect(await offerMail(job.id)).toBeUndefined();
      });

      // A sample tells the office "this customer would get the offer today", so shadow holds the same customers.
      test.each([
        ['Auto Pay paused', async () => seedCustomer({ autopay_paused_until: day(30) })],
        ['the card lane off', async () => { process.env.RECURRING_CARD_ON_FILE = 'false'; return seedCustomer(); }],
      ])('shadow, %s: the job is held and the office gets no sample', async (_name, arrange) => {
        process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
        const customer = await arrange();
        const { job } = await seedJob({ customer });
        const summary = await run({});
        expect(summary).toMatchObject({ mode: 'shadow', jobs: 1, sample: 0, held: 1, failed: 0 });
        expect(summary.reasons).toEqual({ not_pay_after_visit: 1 });
        expect(await sampleRows(job.id)).toEqual([]);
        expect(Sendgrid.sendOne).not.toHaveBeenCalled();
      });
    });

    // The job's opt-out check runs before the home is priced and the estimate is made, and the division's own
    // checks for this stream do not read "offers off" or "marketing by text only". The customer turns offers off
    // after the reservation, right before the email would leave: the ledger's handoff asks the job's guard.
    test('offers turned off right before the email leaves: the provider is never called, and the key is dropped for good', async () => {
      await publishOffer();
      const { customer, job } = await seedJob();
      const realSend = require('../services/email-division/ledger').sendWithLedger;
      // The real transport runs the ledger's last check right before it builds the provider request
      // (sendgrid-mail.js sendOne). This suite replaces the transport, so the replacement does the same.
      const providerRequest = jest.fn();
      Sendgrid.sendOne.mockImplementationOnce(async ({ database, providerBoundaryCheck }) => {
        await providerBoundaryCheck({ database });
        providerRequest();
        return { messageId: 'sg-sample' };
      });
      const first = await run({
        sendWithLedger: (args) => realSend({
          ...args,
          boundaryGuard: async (handoff) => {
            await handoff('notification_prefs').insert({ customer_id: customer.id, marketing_offers: false });
            return args.boundaryGuard(handoff);
          },
        }),
      });
      expect(first).toMatchObject({ sent: 0, held: 1, failed: 0 });
      expect(first.reasons).toEqual({ offers_off: 1 });
      expect(Sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(providerRequest).not.toHaveBeenCalled();
      expect(await ledgerRow(job.id)).toMatchObject({ status: 'skipped', reason: 'OFFERS_OFF' });
      expect((await offerMail(job.id))?.sent_at ?? null).toBeNull();
      // Still off the next morning: the job's own rule holds it.
      expect((await runAt(tomorrow)).reasons).toEqual({ offers_off: 1 });
      // Back on: the ledger never sends a skipped key again, and the job says so. No email, ever.
      await trx('notification_prefs').where({ customer_id: customer.id }).update({ marketing_offers: true });
      const later = await runAt(new Date(tomorrow.getTime() + 24 * HOUR));
      expect(later).toMatchObject({ sent: 0, held: 1, done: 0, failed: 0 });
      expect(later.reasons).toEqual({ send_dropped: 1 });
      expect(Sendgrid.sendOne).toHaveBeenCalledTimes(1);
      expect(providerRequest).not.toHaveBeenCalled();
    });

    // The customer opens another plan option after this job's mint committed. That mint archives the plan-start
    // lineage, this offer's estimate included, while the email waits for the provider. The email's button would be
    // dead, so the handoff refuses it; the row settles failed (not skipped), and the next morning mints again.
    test('the offer estimate archived by the customer\'s next mint before the email leaves: no email; the next morning mints again and sends', async () => {
      await publishOffer();
      const { customer, job } = await seedJob();
      const realSend = require('../services/email-division/ledger').sendWithLedger;
      const providerRequest = jest.fn();
      Sendgrid.sendOne.mockImplementationOnce(async ({ database, providerBoundaryCheck }) => {
        await providerBoundaryCheck({ database });
        providerRequest();
        return { messageId: 'sg-sample' };
      });
      const first = await run({
        sendWithLedger: (args) => realSend({
          ...args,
          boundaryGuard: async (handoff) => {
            await handoff('estimates').where({ customer_id: customer.id }).update({ archived_at: new Date() });
            return args.boundaryGuard(handoff);
          },
        }),
      });
      expect(first).toMatchObject({ sent: 0, held: 1, failed: 0 });
      expect(first.reasons).toEqual({ offer_estimate_gone: 1 });
      expect(providerRequest).not.toHaveBeenCalled();
      expect(await ledgerRow(job.id)).toMatchObject({ status: 'failed', reason: 'OFFER_ESTIMATE_GONE' });
      expect((await offerMail(job.id))?.sent_at ?? null).toBeNull();

      expect(await runAt(tomorrow)).toMatchObject({ sent: 1, held: 0, failed: 0 });
      const quotes = await estimatesOf(customer);
      expect(quotes).toHaveLength(2);
      expect(quotes[0].archived_at).not.toBeNull();
      expect((await offerMail(job.id)).html_snapshot).toContain(`/estimate/${quotes[1].token}`);
      expect(providerRequest).toHaveBeenCalledTimes(1);
    });

    test('offers turned off after the estimate was made: the reservation is denied and leaves no row; back on, the next morning sends', async () => {
      await publishOffer();
      const { customer, job } = await seedJob();
      const real = require('../services/cancellation-resolution/restart').mintPlanStartEstimate;
      const first = await run({
        mintPlanStartEstimate: async (args) => {
          const minted = await real(args);
          await trx('notification_prefs').insert({ customer_id: customer.id, marketing_offers: false });
          return minted;
        },
      });
      expect(first).toMatchObject({ sent: 0, held: 1, failed: 0 });
      expect(first.reasons).toEqual({ offers_off: 1 });
      expect(await ledgerRow(job.id)).toBeUndefined();
      expect(Sendgrid.sendOne).not.toHaveBeenCalled();
      await trx('notification_prefs').where({ customer_id: customer.id }).update({ marketing_offers: true });
      expect(await runAt(tomorrow)).toMatchObject({ sent: 1, held: 0, failed: 0 });
      expect(await estimatesOf(customer)).toHaveLength(1);
    });

    // The job's "no other open estimate" check runs before the mint takes the customer's locks. The customer taps
    // "See my price and book" on the portal card in between: that quote is a link the customer holds.
    test('a quote the customer opened after the job\'s own check is never retired: the mint refuses, the job is held, no email', async () => {
      await publishOffer();
      const { customer, job } = await seedJob();
      const real = require('../services/cancellation-resolution/restart').mintPlanStartEstimate;
      const realOffer = require('../services/service-report/cross-sell').buildStartOffer;
      let cardFee;
      let tapped;
      const summary = await run({
        buildStartOffer: async (...args) => {
          const out = await realOffer(...args);
          cardFee = out.option?.setupFee;
          return out;
        },
        mintPlanStartEstimate: async (args) => {
          // The portal tap: the same option at the card's amounts, with the standard setup fee and no offer.
          tapped = await real({
            customer: args.customer, serviceKey: args.serviceKey, optionId: args.optionId, shown: { ...args.shown, setupFee: cardFee }, now: args.now,
          });
          return real(args);
        },
      });
      expect(cardFee).toBeGreaterThan(0);
      expect(summary).toMatchObject({ sent: 0, held: 1, failed: 0 });
      expect(summary.reasons).toEqual({ open_estimate: 1 });
      const rows = await estimatesOf(customer);
      expect(rows.map((row) => row.id)).toEqual([tapped.estimateId]);
      expect(rows[0]).toMatchObject({ archived_at: null, status: 'sent' });
      expect(readPlan(rows[0].estimate_data).planStart.offer).toBeUndefined();
      expect(Number(rows[0].onetime_total)).toBe(cardFee);
      expect(await ledgerRow(job.id)).toBeUndefined();
      expect(Sendgrid.sendOne).not.toHaveBeenCalled();
      // The next morning the job's own rule reads that quote: held, and still nothing is retired.
      expect((await runAt(tomorrow)).reasons).toEqual({ open_estimate: 1 });
      expect((await estimatesOf(customer)).map((row) => row.archived_at)).toEqual([null]);
    });

    // The run lists the job with its offer day, and the email's dates count from that day. The mint reads the day
    // again under the customer's locks. Staff correct the day the service was performed in between.
    test('the performed day changed between the list and the mint: no email with dates that are not the estimate\'s; the next morning sends the right ones', async () => {
      await publishOffer();
      const { customer, job } = await seedJob();
      const real = require('../services/cancellation-resolution/restart').mintPlanStartEstimate;
      const first = await run({
        mintPlanStartEstimate: async (args) => {
          await trx('service_records').where({ scheduled_service_id: job.id }).update({ service_date: day(-6) });
          return real(args);
        },
      });
      expect(first).toMatchObject({ sent: 0, held: 1, failed: 0 });
      expect(first.reasons).toEqual({ offer_day_moved: 1 });
      expect(Sendgrid.sendOne).not.toHaveBeenCalled();
      expect(await ledgerRow(job.id)).toBeUndefined();
      // The estimate carries the dates of the corrected day (6 days ago), not of the day the run listed (5 days ago).
      const [quote, ...rest] = await estimatesOf(customer);
      expect(rest).toEqual([]);
      expect(readPlan(quote.estimate_data).planStart.offer).toEqual({ jobId: String(job.id), endsAt: endsOf(6).toISOString(), firstVisitFrom: day(71) });

      // The next morning lists the job with the corrected day: the same quote, and an email with its dates.
      expect(await runAt(tomorrow)).toMatchObject({ sent: 1, held: 0, failed: 0 });
      expect((await estimatesOf(customer)).map((row) => row.id)).toEqual([quote.id]);
      const mail = await offerMail(job.id);
      expect(mail.html_snapshot).toContain(`/estimate/${quote.token}`);
      const { formatDateOnly } = require('../utils/date-only');
      expect(mail.text_snapshot).toContain(formatDateOnly(day(24), { year: undefined }));
      expect(mail.text_snapshot).not.toContain(formatDateOnly(day(25), { year: undefined }));
    });

    test('a business account: the pricer stops it before the mint, so no quote and no email', async () => {
      await publishOffer();
      const customer = await seedCustomer({ building_use: 'nonresidential' });
      await seedJob({ customer });
      const summary = await run({});
      expect(summary).toMatchObject({ sent: 0, office: 1, failed: 0 });
      expect(await estimatesOf(customer)).toEqual([]);
      expect(Sendgrid.sendOne).not.toHaveBeenCalled();
    });

    test('the customer changed their email after the quote was made: the ledger refuses the send, and the old address gets nothing', async () => {
      await publishOffer();
      const { customer, job } = await seedJob();
      const real = require('../services/cancellation-resolution/restart').mintPlanStartEstimate;
      const summary = await run({
        mintPlanStartEstimate: async (args) => {
          const minted = await real(args);
          await trx('customers').where({ id: customer.id }).update({ email: `new.${hex(3)}@example.test` });
          return minted;
        },
      });
      expect(summary).toMatchObject({ sent: 0, held: 1, failed: 0 });
      expect(summary.reasons).toEqual({ recipient_changed: 1 });
      expect(Sendgrid.sendOne).not.toHaveBeenCalled();
      expect(await offerMail(job.id)).toBeUndefined();
    });
  });
});
