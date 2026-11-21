// One-time job to plan offer, shadow step, against real PostgreSQL (one rolled-back transaction per test),
// behind GATE_ONETIME_PLAN_OFFER=shadow (owner 2026-11-19, "build"). The unit suite pins the decisions with
// stubs; this one proves what only a database can: the job's own SQL (which visits are due, who the offer is
// for), the real collaborators on real tables (suppressions, the email division's verdict, the offer pricing
// with the real engine, its plan records and its proof of the job's home), and that the two DRAFT templates
// the migration seeds render and send as test sends through the real template library, and the one admin
// notification for a morning the price settings stopped (a real row, refreshed, closed and opened again). Only
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

const crypto = require('crypto');
const { etDateString, addETDays } = require('../utils/datetime-et');

const NOW = new Date();
const HOUR = 3600000;
const OFFICE = 'contact@wavespestcontrol.com';
const OFFER = 'nurture.plan_offer';
const REMINDER = 'nurture.plan_offer_reminder';
const hex = (bytes) => crypto.randomBytes(bytes).toString('hex');
// The ET calendar day n days from today: the job's own day arithmetic.
const day = (n) => etDateString(addETDays(NOW, n));
const sampleKey = (templateKey, jobId) => `onetime-plan-offer:sample:${templateKey}:${jobId}`;

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
    await database?.destroy();
  });

  beforeEach(async () => {
    process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
    jest.clearAllMocks();
    Lookup.performPropertyLookup.mockResolvedValue(null);
    trx = await database.transaction();
    mockConnection = trx;
  });

  afterEach(async () => {
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

  // A completed one-time job. `daysAgo` counts ET calendar days.
  async function seedJob({ daysAgo = 5, customer = null, ...visit } = {}) {
    const owner = customer || await seedCustomer();
    const [job] = await trx('scheduled_services').insert({
      customer_id: owner.id, scheduled_date: day(-daysAgo), service_type: 'One-Time Pest Control', status: 'completed',
      service_key_snapshot: 'one_time_pest_control', ...visit,
    }).returning('*');
    return { customer: owner, job };
  }

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

  test('a one-time job sends both samples to the office through the real template library, once, and saves no estimate', async () => {
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
      expect(row.html_snapshot).toContain(`so this customer may not get the offer. Job ${job.id}.`);
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
    // The email division's standing answers (the real eligibleForEmail, stream nurture), under its reason names.
    // No seeded customer has an estimate on file, so each case also proves that the division reads these
    // before its checks for the day of the send.
    ["the email is unsubscribed from the nurture group, the offer templates' own", async ({ customer }) => {
      await trx('email_suppressions').insert({ email: customer.email, suppression_type: 'unsubscribe', group_key: 'marketing_nurture', status: 'active' });
    }, 'email_suppressed_group'],
    ['the customer turned email off', async ({ customer }) => {
      await trx('notification_prefs').insert({ customer_id: customer.id, email_enabled: false });
    }, 'email_switch_off'],
    ['the customer is on the staff do-not-contact list', async ({ customer }) => {
      await trx('messaging_suppression').insert({ phone: customer.phone, reason: 'manual_dnc', active: true });
    }, 'staff_dnc'],
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
    // This step shows the words. The state of the account on the day is judged with the customer email, in
    // the next step: a booked visit, an open invoice and a queued review ask do not stop a sample.
    ['a booked visit, an open invoice and a queued review ask (not judged in this step)', async ({ customer }) => {
      await trx('scheduled_services').insert({ customer_id: customer.id, scheduled_date: day(4), service_type: 'Cockroach Control', status: 'pending' });
      await trx('invoices').insert({ token: hex(16), invoice_number: `TEST-${hex(4)}`, customer_id: customer.id, subtotal: 80, total: 80, status: 'sent' });
      await trx('review_requests').insert({ token: hex(16), customer_id: customer.id, status: 'pending', scheduled_for: new Date(NOW.getTime() + 24 * HOUR) });
    }],
  ])('not a hold: %s', async (_name, arrange) => {
    const seeded = await seedJob();
    await arrange(seeded);
    expect(await run()).toMatchObject({ sample: 1, held: 0, failed: 0 });
  });

  // The email division's three checks for the day of the send come with the customer email. Each case seeds
  // the real rows, asks the division itself what it answers, and then runs the job.
  test.each([
    ['RELATIONSHIP_NOT_ELIGIBLE', 'no estimate is on file yet', async () => {}],
    ['CAP_SAME_DAY', 'another marketing email went out today', async ({ customer }) => {
      await trx('estimates').insert({ customer_id: customer.id, status: 'sent', expires_at: new Date(NOW.getTime() + 72 * HOUR) });
      await trx('marketing_email_ledger').insert({
        customer_id: customer.id, stream: 'broadcast', marketing_class: 'marketing', email_key: 'newsletter.sample',
        idempotency_key: `test:${hex(8)}`, recipient_email: customer.email, status: 'sent', sent_at: NOW,
      });
    }],
    ['RECENT_HUMAN_CONTACT', 'the office texted the customer yesterday', async ({ customer }) => {
      await trx('estimates').insert({ customer_id: customer.id, status: 'sent', expires_at: new Date(NOW.getTime() + 72 * HOUR) });
      await trx('sms_log').insert({
        customer_id: customer.id, direction: 'outbound', from_phone: '+19415550199', to_phone: customer.phone,
        message_type: 'manual', status: 'delivered', message_body: 'Thanks for choosing Waves.', created_at: new Date(NOW.getTime() - 24 * HOUR),
      });
    }],
  ])('not a hold: the email division answers %s (%s), a check for the day of the send', async (verdict, _name, arrange) => {
    const seeded = await seedJob();
    await arrange(seeded);
    const { eligibleForEmail } = require('../services/email-division/eligibility');
    await expect(eligibleForEmail({ customerId: seeded.customer.id, stream: 'nurture', emailKey: OFFER, now: NOW }))
      .resolves.toMatchObject({ ok: false, reason: verdict });
    expect(await run()).toMatchObject({ sample: 1, held: 0, failed: 0 });
  });

  test('more due jobs than one page: every job is read once, in pages, across the days of the window', async () => {
    // 51 jobs is one full page and one more. No email on file ends each job at the first rule, with no send.
    const customers = await trx('customers').insert(Array.from({ length: 51 }, (_, index) => ({
      first_name: 'Paging', last_name: 'Example', phone: `+1941556${String(index).padStart(4, '0')}`, active: true,
    }))).returning('id');
    await trx('scheduled_services').insert(customers.map((customer, index) => ({
      customer_id: customer.id, scheduled_date: day(-3 - (index % 12)), service_type: 'One-Time Pest Control', status: 'completed',
      service_key_snapshot: 'one_time_pest_control',
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
    ['a recurring palm injection visit, which maps to no offer family', async (customer) => trx('scheduled_services').insert({
      customer_id: customer.id, scheduled_date: day(30), service_type: 'Palm Injection', status: 'pending', is_recurring: true, recurring_pattern: 'quarterly',
    })],
    ['an annual prepay whose paid coverage is live', async (customer) => seedPrepayTerm(customer, 'active', 'paid')],
    ['an annual prepay invoice that is still payable', async (customer) => seedPrepayTerm(customer, 'payment_pending', 'sent')],
  ])('the real offer pricing: %s means the customer has a plan, so no price and no sample', async (_name, arrange) => {
    const { customer } = await seedJob();
    await arrange(customer);
    Lookup.performPropertyLookup.mockResolvedValue({ enriched: { homeSqFt: 2400, lotSqFt: 8000, stories: 1 }, propertyRecord: {} });
    const summary = await run({});
    expect(summary).toMatchObject({ sample: 0, office: 0, held: 1, failed: 0 });
    expect(summary.reasons).toEqual({ has_plan: 1 });
    expect(Sendgrid.sendOne).not.toHaveBeenCalled();
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

  test('with the gate at true (the future customer value) the job does nothing', async () => {
    process.env.GATE_ONETIME_PLAN_OFFER = 'true';
    const { job } = await seedJob();
    expect(await run()).toMatchObject({ mode: 'off', jobs: 0, sample: 0 });
    expect(await sampleRows(job.id)).toHaveLength(0);
  });
});
