/**
 * One-time job to plan offer, shadow step (services/onetime-plan-offer.js, GATE_ONETIME_PLAN_OFFER=shadow).
 *
 * The job's promise: it prices real cases and emails SAMPLES to the office, and no customer gets anything.
 * This suite pins the decisions around that promise with a recording fake database and stub collaborators:
 * the gate values, which send rule holds a job and under which reason (and in which order the rules run),
 * what goes to the office to price by hand, the two sample sends (recipient, test send, once per job), that
 * one bad job never stops the others, and the one admin notification for a morning the price settings stopped.
 * A sample means that the customer would get the offer today.
 * The SQL itself, the real collaborators and the seeded templates run against PostgreSQL in
 * onetime-plan-offer-postgres.test.js.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');
const {
  runOnetimePlanOfferJob, dueOfferOfJob, offerTerms, TEMPLATE_VARIABLES, OFFER_TEMPLATE, REMINDER_TEMPLATE, _test,
} = require('../services/onetime-plan-offer');
const { CUSTOMER_STAGES } = require('../services/customer-stages');

// 11:30 PM ET on March 12 (already March 13 in UTC): the day window must come from the ET day.
const NOW = new Date('2030-03-13T03:30:00Z');
const HOUR = 3600000;
// `service_day` is the offer day and `job_day` is the day the job itself was done, both from service records
// (the job's own SQL). With no included follow-up done, the two are the same day.
const JOB = { id: 'job-1', customer_id: 'cust-1', service_day: '2030-03-05', job_day: '2030-03-05' };
const CUSTOMER = {
  id: 'cust-1', first_name: 'Jordan', last_name: 'Example', email: 'jordan@example.test', phone: '+19415550100',
  address_line1: '12 Example Test Ln', active: true,
};
const OPTION = { id: 'pest-quarterly', perVisit: 104.5, setupFee: 99 };
const OFFICE = 'contact@wavespestcontrol.com';

// A knex stand-in that records each query's calls and answers with the rows the test put on that table.
// A condition given as a callback is recorded on the same query. A table may be a function of the recorded
// query, for a table that two rules read in different ways, or whose answer follows the job that is read.
function fakeDb(tables = {}) {
  const queries = [];
  const db = (table) => {
    const query = { table, calls: [] };
    queries.push(query);
    const rows = () => {
      const source = tables[table];
      return typeof source === 'function' ? source(query) : (source || []);
    };
    const builder = {
      first: async () => rows()[0],
      select: async () => rows(),
    };
    const recorded = [
      'where', 'orWhere', 'whereNot', 'whereIn', 'orWhereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw',
      'whereBetween', 'leftJoin', 'join', 'joinRaw', 'orderBy', 'orderByRaw', 'limit',
    ];
    for (const method of recorded) {
      builder[method] = (...args) => {
        query.calls.push([method, ...args]);
        for (const arg of args) if (typeof arg === 'function') arg(builder);
        return builder;
      };
    }
    return builder;
  };
  db.raw = (sql) => ({ sql });
  db.queries = queries;
  db.queriesOf = (table) => queries.filter((query) => query.table === table);
  return db;
}

const called = (query, method, ...args) => query.calls.some((call) => JSON.stringify(call) === JSON.stringify([method, ...args]));
const whereValue = (query, column) => (query.calls.find(([method, first]) => method === 'where' && first === column) || [])[2];
// The live-customer read is the one that filters on the customer stages (whereLiveCustomer in customer-stages.js).
const isLiveCustomerRead = (query) => called(query, 'whereIn', 'pipeline_stage', CUSTOMER_STAGES);
// The offer day: the follow-up's performed day when the job's included follow-up was done, else the job's own.
const OFFER_DAY = 'GREATEST(done.service_day, COALESCE(follow.service_day, done.service_day))';
// A page of due jobs behind the first one carries the (offer day, id) of the last job read.
const isLaterPageRead = (query) => query.calls.some(([method, sql]) => method === 'whereRaw' && String(sql).startsWith(`(${OFFER_DAY}, s.id) >`));
// A part-paid invoice of the customer with $60 still to pay: owed, but not in the balance the Waves app counts.
const PART_PAID = { id: 'inv-2', customer_id: 'cust-1', status: 'partially_paid', total: '100.00', amount_paid: '40.00' };
const partPaid = (change = {}) => ({ tables: { invoices: [{ ...PART_PAID, ...change }] } });
// A job's invoice as the job reads it: paid, with no line that names a visit. By default it sits under the job
// that is read (ownInvoice).
const INVOICE = { id: 'inv-1', status: 'paid', total: '225.00', scheduled_service_id: 'job-1', line_items: [] };
const ownInvoice = (query) => [{ ...INVOICE, scheduled_service_id: whereValue(query, 'i.scheduled_service_id') }];

// A world where job-1 passes every send rule and prices. Each test changes one thing.
// `jobs` is the first page of due jobs (a later page is empty).
function world({ tables = {}, jobs = [JOB], ...deps } = {}) {
  return {
    db: fakeDb({
      'scheduled_services as s': (query) => (isLaterPageRead(query) ? [] : jobs),
      customers: [CUSTOMER],
      'invoices as i': ownInvoice,
      'email_template_versions as v': (query) => [{ id: `ver:${whereValue(query, 't.template_key')}` }],
      ...tables,
    }),
    buildStartOffer: jest.fn(async () => ({ option: { ...OPTION }, reason: null })),
    isInternalTestContact: jest.fn(() => false),
    activeSuppressionsFor: jest.fn(async () => []),
    eligibleForEmail: jest.fn(async () => ({ ok: true, reason: null, checks: {} })),
    reviewAskOnItsWay: jest.fn(async () => false),
    combinedFirstInvoiceOf: jest.fn(async () => null),
    lastDeliveredAskAt: jest.fn(async () => null),
    lastManualAskAt: jest.fn(async () => null),
    askSpacingMs: 72 * HOUR,
    liveEstimateStatuses: ['sending', 'sent', 'viewed'],
    repricePendingAbsentSql: "COALESCE(estimate_data->'estimatorEngine'->>'reprice_pending_at', '') = ''",
    openBalanceExists: jest.fn(async () => false),
    partiallyPaidStatus: 'partially_paid',
    isUncountedPartialDue: jest.fn((invoice) => Number(invoice.total) - Number(invoice.amount_paid) > 0 && !invoice.scheduled_send_error),
    invoicePayerOwnership: jest.fn(async () => null),
    itemizedMemberIds: jest.fn((lines) => (typeof lines === 'string' ? JSON.parse(lines) : lines || [])
      .map((line) => /^scheduled_(.+?)_(primary|addon_.+)$/.exec(line.client_id || '')?.[1]).filter(Boolean)),
    openRequestTerminalStatuses: ['resolved', 'closed', 'cancelled'],
    sendTemplate: jest.fn(async () => ({ sent: true })),
    unsubscribeUrl: (token) => `https://unsub.test/${token}`,
    raisePriceSettingsAlert: jest.fn(async () => ({ id: 'alert-1' })),
    closePriceSettingsAlert: jest.fn(async () => 0),
    ...deps,
  };
}

// The email division's answer "no", with its reason.
const emailVerdict = (reason) => ({ eligibleForEmail: jest.fn(async () => ({ ok: false, reason, checks: {} })) });

const run = (deps) => runOnetimePlanOfferJob({ now: NOW, deps });
const counts = (summary) => ({ sample: summary.sample, office: summary.office, held: summary.held, done: summary.done, failed: summary.failed });
const NONE = { sample: 0, office: 0, held: 0, done: 0, failed: 0 };

let savedGate;
beforeEach(() => {
  savedGate = process.env.GATE_ONETIME_PLAN_OFFER;
  process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
  jest.clearAllMocks();
});
afterEach(() => {
  if (savedGate === undefined) delete process.env.GATE_ONETIME_PLAN_OFFER;
  else process.env.GATE_ONETIME_PLAN_OFFER = savedGate;
});

describe('GATE_ONETIME_PLAN_OFFER', () => {
  // 'true' is the value that will one day email customers. Until that step is built it must do nothing.
  // The value is compared as written: another case or a padded value is off, as the gate's paragraph says.
  test.each([[undefined], [''], ['true'], ['on'], ['live'], ['false'], ['Shadow'], ['SHADOW'], [' shadow '], ['shadow ']])('value %p is off: the job reads nothing and sends nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_ONETIME_PLAN_OFFER;
    else process.env.GATE_ONETIME_PLAN_OFFER = value;
    const deps = world({ db: jest.fn(() => { throw new Error('the job read the database with the gate off'); }) });
    expect(await run(deps)).toMatchObject({ mode: 'off', jobs: 0, ...NONE });
    expect(deps.db).not.toHaveBeenCalled();
    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  test("exactly 'shadow' runs the job", async () => {
    process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
    expect((await run(world())).mode).toBe('shadow');
  });
});

describe('a job that passes every send rule and prices', () => {
  test('one sample of the offer and one of the reminder go to the office inbox as test sends, keyed once per job', async () => {
    const deps = world();
    const summary = await run(deps);
    expect(summary).toEqual({ mode: 'shadow', jobs: 1, ...NONE, sample: 1, reasons: {} });

    const note = 'Sample only. No estimate was saved and the customer got no email. This account passed the send rules today,'
      + ' so this customer would get the offer. Job job-1.';
    const sends = deps.sendTemplate.mock.calls.map(([send]) => send);
    expect(sends).toEqual([OFFER_TEMPLATE, REMINDER_TEMPLATE].map((key) => ({
      versionId: `ver:${key}`,
      to: OFFICE,
      unsubscribeUrl: `https://unsub.test/test-ver:${key}`,
      payload: expect.any(Object),
      test: true,
      idempotencyKey: `onetime-plan-offer:sample:${key}:job-1`,
      categories: ['onetime_plan_offer_sample'],
      bodyAppend: { html: note, text: note },
    })));
    // Each payload carries exactly the variables its template requires: no more, no fewer.
    expect(Object.keys(sends[0].payload)).toEqual(TEMPLATE_VARIABLES[OFFER_TEMPLATE]);
    expect(Object.keys(sends[1].payload)).toEqual(TEMPLATE_VARIABLES[REMINDER_TEMPLATE]);
    expect(sends[0].payload).toEqual({
      first_name: 'Jordan',
      visit_weekday: 'Tuesday',
      visit_date_short: 'Mar 5',
      address_short: '12 Example Test Ln',
      price_per_application: '$104.50',
      setup_fee: '$99',
      next_visit_window: 'May 21 to Jun 4',
      offer_end_date: 'April 4',
      estimate_url: expect.stringMatching(/\/estimate\/sample$/),
    });
  });

  test('the price is the pest plan for this customer, asked with the job; the email verdict is asked for the nurture stream', async () => {
    const deps = world();
    await run(deps);
    // The pricer gets the job, so it can prove the job was at the home it prices.
    expect(deps.buildStartOffer).toHaveBeenCalledWith('cust-1', deps.db, 'pest_control', { visitId: 'job-1' });
    // The job names its completed visit: the email division reads that row as the relationship, so the caps and
    // the human-contact check run for a customer with no estimate on file yet. Stream nurture: its unsubscribe
    // group is marketing_nurture, the group the two templates carry.
    expect(deps.eligibleForEmail.mock.calls).toEqual([[{
      customerId: 'cust-1', stream: 'nurture', emailKey: OFFER_TEMPLATE, now: NOW, conn: deps.db, completedVisitId: 'job-1',
    }]]);
  });

  test('the jobs read are completed one-time pest and cockroach jobs whose service was done 3 to 14 days ago on the ET calendar', async () => {
    const deps = world();
    await run(deps);
    const [due] = deps.db.queriesOf('scheduled_services as s');
    expect(called(due, 'where', 's.status', 'completed')).toBe(true);
    // The day is the service day of a service record that says the service was performed. The outcomes that
    // say "nothing was performed" are the shared list, bound in its order.
    const [[, joinSql, joinBindings], [, followSql, followBindings]] = due.calls.filter(([method]) => method === 'joinRaw');
    expect(joinSql).toContain('SELECT MAX(r.service_date) AS service_day');
    expect(joinSql).toContain("r.status = 'completed'");
    // A record of another customer that names this visit is not this visit's record.
    expect(joinSql).toContain('r.scheduled_service_id = s.id\n      AND r.customer_id = s.customer_id');
    expect(joinSql).toContain("COALESCE(r.structured_notes->>'visitOutcome', '') NOT IN (?, ?, ?)");
    const notPerformed = require('../services/pest-pressure/first-visit').NON_PERFORMED_VISIT_OUTCOMES;
    expect(joinBindings).toEqual(notPerformed);
    // The included follow-up: the same customer's row, linked to the job, completed, with a performed record.
    expect(followSql).toContain('LEFT JOIN LATERAL');
    expect(followSql).toContain('f.customer_id = s.customer_id');
    expect(followSql).toContain('f.followup_included IS TRUE');
    expect(followSql).toContain('(f.followup_source_service_id = s.id OR f.parent_service_id = s.id)');
    expect(followSql).toContain("f.status = 'completed'");
    expect(followSql).toContain('r.customer_id = f.customer_id');
    expect(followSql).toContain("COALESCE(r.structured_notes->>'visitOutcome', '') NOT IN (?, ?, ?)");
    expect(followBindings).toEqual(notPerformed);
    // GREATEST skips a NULL: a job with no performed record is kept out by its own test.
    expect(called(due, 'whereRaw', 'done.service_day IS NOT NULL')).toBe(true);
    // March 12 in ET (March 13 in UTC): 14 days back is February 26, 3 days back is March 9. The window, the
    // order and the page cursor all use the offer day.
    expect(called(due, 'whereRaw', `${OFFER_DAY} BETWEEN ?::date AND ?::date`, ['2030-02-26', '2030-03-09'])).toBe(true);
    expect(called(due, 'orderByRaw', `${OFFER_DAY} ASC`)).toBe(true);
    expect(called(due, 'whereIn', { sql: 'COALESCE(s.service_key_snapshot, sv.service_key)' }, ['one_time_pest_control', 'cockroach_control'])).toBe(true);
    expect(called(due, 'whereNull', 's.recurring_parent_id')).toBe(true);
    // A one-time visit stores no pattern or the 'one_time' marker. Any other pattern is a plan's cadence.
    expect(called(due, 'whereRaw', "COALESCE(s.recurring_pattern, '') IN ('', 'one_time')")).toBe(true);
    expect(called(due, 'whereRaw', 's.followup_included IS DISTINCT FROM true')).toBe(true);
  });

  test('more due jobs than one page holds: the next page starts behind the last job read, and every job is counted', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({ ...JOB, id: `job-${index + 1}` }));
    const lastPage = [{ ...JOB, id: 'job-51', service_day: '2030-03-06', job_day: '2030-03-06' }];
    const deps = world({ tables: { 'scheduled_services as s': (query) => (isLaterPageRead(query) ? lastPage : firstPage) } });
    const summary = await run(deps);
    expect(summary).toMatchObject({ jobs: 51, sample: 51 });
    const reads = deps.db.queriesOf('scheduled_services as s');
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(called(read, 'limit', 50)).toBe(true);
    expect(isLaterPageRead(reads[0])).toBe(false);
    expect(called(reads[1], 'whereRaw', `(${OFFER_DAY}, s.id) > (?::date, ?::uuid)`, ['2030-03-05', 'job-50'])).toBe(true);
  });

  test('a last page that is exactly full costs one more read, which finds nothing', async () => {
    const fullPage = Array.from({ length: 50 }, (_, index) => ({ ...JOB, id: `job-${index + 1}` }));
    const deps = world({ jobs: fullPage });
    expect((await run(deps)).jobs).toBe(50);
    expect(deps.db.queriesOf('scheduled_services as s')).toHaveLength(2);
  });

  test('the sampled words are the newest draft or active version of each template', async () => {
    const deps = world();
    await run(deps);
    const reads = deps.db.queriesOf('email_template_versions as v');
    expect(reads.map((query) => whereValue(query, 't.template_key'))).toEqual([OFFER_TEMPLATE, REMINDER_TEMPLATE]);
    for (const query of reads) {
      expect(called(query, 'whereIn', 'v.status', ['draft', 'active'])).toBe(true);
      // A template the owner paused or archived in the editor is not sampled.
      expect(called(query, 'whereIn', 't.status', ['draft', 'active'])).toBe(true);
      expect(called(query, 'orderBy', 'v.version_number', 'desc')).toBe(true);
    }
  });
});

describe('a send rule holds the job: no price is computed and nothing is sent', () => {
  const invoice = (change) => ({ tables: { 'invoices as i': [{ ...INVOICE, ...change }] } });

  test.each([
    ['another visit is booked or was done after the job', { tables: { 'scheduled_services as o': [{ id: 'job-2' }] } }, 'another_visit'],
    ['the customer row is gone', { tables: { customers: [] } }, 'no_customer'],
    ['the customer is inactive', { tables: { customers: [{ ...CUSTOMER, active: false }] } }, 'inactive'],
    // The account row is there and active, and the shared live-customer read finds nothing: a lead stage or a
    // former-customer stage. The table answers the stage read alone with no row, as the database would.
    ['the customer is not in a customer stage', { tables: { customers: (query) => (isLiveCustomerRead(query) ? [] : [CUSTOMER]) } }, 'not_a_live_customer'],
    ['the customer has no email', { tables: { customers: [{ ...CUSTOMER, email: '  ' }] } }, 'no_email'],
    ['the customer is an internal test contact', { isInternalTestContact: jest.fn(() => true) }, 'test_customer'],
    ['offers are turned off in the Waves app', { tables: { notification_prefs: [{ marketing_offers: false }] } }, 'offers_off'],
    ['the customer chose marketing by text only', { tables: { notification_prefs: [{ marketing_offers: true, marketing_channel: 'sms' }] } }, 'offers_by_text_only'],
    ['the email is unsubscribed from Waves marketing', { activeSuppressionsFor: jest.fn(async () => [{ id: 's-1' }]) }, 'email_suppressed'],
    // The email division's standing answers, under its own reason names.
    ['the job has no invoice', { tables: { 'invoices as i': [] } }, 'no_invoice'],
    ['the invoice is not paid', invoice({ status: 'sent' }), 'invoice_not_paid'],
    // An invoice that also bills another visit: its total is not the price of this job.
    ['the paid invoice sits under another visit', invoice({ scheduled_service_id: 'job-9' }), 'combined_invoice'],
    ['the service record of the paid invoice belongs to another visit', invoice({ scheduled_service_id: null, record_visit_id: 'job-9', line_items: [{ client_id: 'scheduled_job-1_primary' }] }), 'combined_invoice'],
    ['a line of the paid invoice names another visit', invoice({ line_items: [{ client_id: 'scheduled_job-1_primary' }, { client_id: 'scheduled_job-9_primary' }] }), 'combined_invoice'],
    ['the completion packet of the paid invoice links another visit', { tables: { visit_completion_packet_items: [{ id: 'item-2' }] } }, 'combined_invoice'],
    ["the job is a member of an estimate's combined first invoice", { combinedFirstInvoiceOf: jest.fn(async () => 'inv-9') }, 'combined_invoice'],
    ['Billing Recovery recorded a visit as billed elsewhere on the paid invoice', { tables: { visit_billing_dispositions: [{ id: 'disp-1' }] } }, 'combined_invoice'],
    ['another balance is open', { openBalanceExists: jest.fn(async () => true) }, 'open_balance'],
    ['a part-paid invoice of the customer has an amount due', partPaid(), 'open_balance'],
    ['a review ask is still on its way (queued, being sent, or a cadence with touches to come)', { reviewAskOnItsWay: jest.fn(async () => true) }, 'review_ask'],
    ['a review ask went out 71 hours ago', { lastDeliveredAskAt: jest.fn(async () => new Date(NOW.getTime() - 71 * HOUR)) }, 'review_ask'],
    ['the office typed a review ask 71 hours ago', { lastManualAskAt: jest.fn(async () => new Date(NOW.getTime() - 71 * HOUR)) }, 'review_ask'],
    ['the customer rated the job under 7', { tables: { review_requests: [{ id: 'rating-1' }] } }, 'low_rating'],
    ['a complaint was logged since the job', { tables: { customer_interactions: [{ id: 'c-1' }] } }, 'complaint'],
    ['a service request is open', { tables: { service_requests: [{ id: 'r-1' }] } }, 'open_request'],
    ['an estimate is open', { tables: { estimates: [{ id: 'e-1' }] } }, 'open_estimate'],
    ['the customer is on the staff do-not-contact list', emailVerdict('STAFF_DNC'), 'staff_dnc'],
    ["the email is unsubscribed from the offer's own group", emailVerdict('EMAIL_SUPPRESSED_GROUP'), 'email_suppressed_group'],
    ['the customer turned email off', emailVerdict('EMAIL_SWITCH_OFF'), 'email_switch_off'],
    // Fail closed: an answer the job does not know holds the job.
    ['the email division gives an answer the job does not know', emailVerdict('A_RULE_ADDED_LATER'), 'a_rule_added_later'],
    ['the email division says no with no reason', emailVerdict(undefined), 'email_not_allowed'],
    // The division's three checks for the day of the send now hold the job: a sample means "would get it today".
    // The division finds no relationship when the named visit is not a completed visit of this customer.
    ['the email division finds no relationship', emailVerdict('RELATIONSHIP_NOT_ELIGIBLE'), 'relationship_not_eligible'],
    ['another marketing email went out today', emailVerdict('CAP_SAME_DAY'), 'cap_same_day'],
    ['the office and the customer were in touch in the last 3 days', emailVerdict('RECENT_HUMAN_CONTACT'), 'recent_human_contact'],
  ])('%s', async (_name, change, reason) => {
    const deps = world(change);
    const summary = await run(deps);
    expect(counts(summary)).toEqual({ ...NONE, held: 1 });
    expect(summary.reasons).toEqual({ [reason]: 1 });
    expect(deps.buildStartOffer).not.toHaveBeenCalled();
    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  test.each([
    // The owner chose "all": a customer who never set the offers switch still gets the offer.
    ['the offers switch was never set', { tables: { notification_prefs: [{ marketing_offers: null }] } }],
    ['the customer chose marketing by text and email', { tables: { notification_prefs: [{ marketing_offers: true, marketing_channel: 'both' }] } }],
    ['the last review ask is exactly 72 hours old', { lastDeliveredAskAt: jest.fn(async () => new Date(NOW.getTime() - 72 * HOUR)) }],
    ['the office typed a review ask exactly 72 hours ago', { lastManualAskAt: jest.fn(async () => new Date(NOW.getTime() - 72 * HOUR)) }],
    ["a part-paid invoice with an amount due is a payer's debt", { ...partPaid(), invoicePayerOwnership: jest.fn(async () => 'payer_owned') }],
    ['a part-paid invoice has nothing left to pay', partPaid({ amount_paid: '100.00' })],
    ['a part-paid invoice was withdrawn to a payer', partPaid({ scheduled_send_error: 'payer_billed:7' })],
    ['the lines of the paid invoice name this job only', { tables: { 'invoices as i': [{ ...INVOICE, line_items: JSON.stringify([{ client_id: 'scheduled_job-1_primary' }, { client_id: 'scheduled_job-1_addon_a1' }]) }] } }],
  ])('not a hold: %s', async (_name, change) => {
    const deps = world(change);
    expect(counts(await run(deps))).toEqual({ ...NONE, sample: 1 });
    expect(deps.sendTemplate).toHaveBeenCalledTimes(2);
  });

  test('the live-customer read is the shared rule: this account, active, not deleted, in a customer stage', async () => {
    const deps = world();
    await run(deps);
    const read = deps.db.queriesOf('customers').find(isLiveCustomerRead);
    expect(read).toBeTruthy();
    expect(called(read, 'where', { id: JOB.customer_id })).toBe(true);
    expect(called(read, 'where', 'active', true)).toBe(true);
    expect(called(read, 'whereNull', 'deleted_at')).toBe(true);
    expect(CUSTOMER_STAGES).toEqual(['active_customer', 'won', 'at_risk']);
  });

  test('the suppression read is by the customer email, for the Waves marketing group', async () => {
    const deps = world();
    await run(deps);
    expect(deps.activeSuppressionsFor).toHaveBeenCalledWith(null, 'jordan@example.test', 'marketing_newsletter', deps.db);
  });

  // The rules run in this order, and the first one that fails names the hold. Each row adds a failure that the
  // rows above it do not have: a world with every failure from row N down must answer with row N's reason.
  test('the rules run in order: another visit, the customer, opt-outs, the job invoice, review asks, complaints, estimates, the email division', async () => {
    const ordered = [
      ['another_visit', { tables: { 'scheduled_services as o': [{ id: 'job-2' }] } }],
      ['no_email', { tables: { customers: [{ ...CUSTOMER, email: null }] } }],
      ['offers_off', { tables: { notification_prefs: [{ marketing_offers: false }] } }],
      ['no_invoice', { tables: { 'invoices as i': [] } }],
      ['review_ask', { reviewAskOnItsWay: jest.fn(async () => true) }],
      ['low_rating', { tables: { review_requests: [{ id: 'rating-1' }] } }],
      ['open_estimate', { tables: { estimates: [{ id: 'e-1' }] } }],
      ['cap_same_day', emailVerdict('CAP_SAME_DAY')],
    ];
    for (let row = 0; row < ordered.length; row += 1) {
      const change = ordered.slice(row).reduce((all, [, one]) => ({ ...all, ...one, tables: { ...all.tables, ...one.tables } }), { tables: {} });
      const summary = await run(world(change));
      expect(summary.reasons).toEqual({ [ordered[row][0]]: 1 });
    }
  });

  test('the last-visit rule orders visits in the database: the job is joined as its own row, never bound as a value', async () => {
    const deps = world();
    await run(deps);
    const [read] = deps.db.queriesOf('scheduled_services as o');
    expect(called(read, 'join', 'scheduled_services as j', 'j.customer_id', 'o.customer_id')).toBe(true);
    expect(called(read, 'where', 'j.id', 'job-1')).toBe(true);
    expect(called(read, 'whereNot', 'o.id', 'job-1')).toBe(true);
  });

  test("a visit completed after the job holds it, except the job's own included follow-up, which only a completed one is excused", async () => {
    const deps = world();
    await run(deps);
    const [read] = deps.db.queriesOf('scheduled_services as o');
    const later = read.calls.filter(([method, sql]) => method === 'whereRaw' && String(sql).includes('<') === false);
    expect(later.map(([, sql]) => sql)).toEqual(expect.arrayContaining([
      expect.stringContaining("(o.scheduled_date, COALESCE(o.completed_at, 'epoch'::timestamptz), o.id)"),
      // NULL-safe: a follow-up row with no link ids is not excused, and a NULL never drops the row.
      'NOT (o.followup_included IS TRUE AND (COALESCE(o.followup_source_service_id = j.id, FALSE) OR COALESCE(o.parent_service_id = j.id, FALSE)))',
    ]));
    // The excuse is on the completed-later arm alone: the open and parked arms carry no such test.
    const completedArm = read.calls.findIndex(([method, column, value]) => method === 'where' && column === 'o.status' && value === 'completed');
    const excuse = read.calls.findIndex(([method, sql]) => method === 'whereRaw' && String(sql).startsWith('NOT (o.followup_included'));
    expect(completedArm).toBeGreaterThan(-1);
    expect(excuse).toBeGreaterThan(completedArm);
    expect(read.calls.filter(([method, sql]) => method === 'whereRaw' && String(sql).startsWith('NOT (o.followup_included'))).toHaveLength(1);
  });

  test('the packet read of the paid invoices looks for a visit other than the job', async () => {
    const deps = world();
    await run(deps);
    // The table is read twice: inside the invoice read (the job's own packet items), then for the other visits.
    const read = deps.db.queriesOf('visit_completion_packet_items').find((query) => called(query, 'whereIn', 'invoice_id', ['inv-1']));
    expect(read).toBeDefined();
    expect(called(read, 'whereNot', { scheduled_service_id: 'job-1' })).toBe(true);
    expect(deps.combinedFirstInvoiceOf).toHaveBeenCalledWith(JOB, deps.db);
  });

  test('the estimate read covers an estimate that is being sent, and one on the send queue', async () => {
    const deps = world();
    await run(deps);
    const [read] = deps.db.queriesOf('estimates');
    expect(called(read, 'whereNull', 'archived_at')).toBe(true);
    // Open now: the public estimate page's list, with its expiry test.
    expect(called(read, 'whereIn', 'status', ['sending', 'sent', 'viewed'])).toBe(true);
    expect(called(read, 'orWhere', 'expires_at', '>', NOW)).toBe(true);
    // On its way: the scheduler's queue test, which has no expiry.
    expect(called(read, 'where', 'status', 'scheduled')).toBe(true);
    expect(called(read, 'whereNotNull', 'scheduled_at')).toBe(true);
    expect(called(read, 'whereRaw', "COALESCE(estimate_data->'estimatorEngine'->>'reprice_pending_at', '') = ''")).toBe(true);
  });

  test('a visit parked for a new day is open work from today on, by the Eastern day', async () => {
    const deps = world();
    await run(deps);
    const [read] = deps.db.queriesOf('scheduled_services as o');
    expect(called(read, 'whereNotIn', 'o.status', ['cancelled', 'completed', 'skipped', 'no_show', 'rescheduled'])).toBe(true);
    expect(called(read, 'where', 'o.status', 'rescheduled')).toBe(true);
    // NOT IN is never true for a row with no status, so that row is read on its own.
    expect(called(read, 'whereNull', 'o.status')).toBe(true);
    // NOW is 11:30 PM Eastern on March 12. The UTC day is already March 13.
    expect(called(read, 'where', 'o.scheduled_date', '>=', '2030-03-12')).toBe(true);
  });

  test("the invoice read follows the invoice's service record to its visit", async () => {
    const deps = world();
    await run(deps);
    const [read] = deps.db.queriesOf('invoices as i');
    expect(called(read, 'leftJoin', 'service_records as r', 'r.id', 'i.service_record_id')).toBe(true);
    expect(called(read, 'orWhere', 'r.scheduled_service_id', 'job-1')).toBe(true);
  });

  test('Billing Recovery links are read both ways: an invoice that covers the job, and any visit billed elsewhere on a paid invoice', async () => {
    const deps = world();
    await run(deps);
    const reads = deps.db.queriesOf('visit_billing_dispositions');
    // Inside the invoice read: an invoice made for other work that Billing Recovery recorded for this job.
    expect(reads.some((query) => called(query, 'where', { scheduled_service_id: 'job-1', disposition: 'billed_elsewhere' }))).toBe(true);
    // On the paid invoices: a record for ANY visit, the job included, means the total is not the job's price.
    const onPaid = reads.find((query) => called(query, 'whereIn', 'invoice_id', ['inv-1']));
    expect(onPaid).toBeDefined();
    expect(called(onPaid, 'where', { disposition: 'billed_elsewhere' })).toBe(true);
    expect(called(onPaid, 'whereNot', { scheduled_service_id: 'job-1' })).toBe(false);
  });

  test("the typed review ask is read over the same 72 hours, by the job's customer", async () => {
    const deps = world();
    await run(deps);
    expect(deps.lastManualAskAt).toHaveBeenCalledWith('cust-1', { since: new Date(NOW.getTime() - 72 * HOUR) });
  });

  test('the low-rating and complaint rules look only at the time since the job, from midnight Eastern on its day', async () => {
    const deps = world();
    await run(deps);
    // March 5, 2030 is on standard time: midnight Eastern is 05:00 UTC. Midnight UTC is 7 PM on March 4.
    const since = new Date('2030-03-05T05:00:00Z');
    expect(called(deps.db.queriesOf('review_requests')[0], 'where', 'rated_at', '>=', since)).toBe(true);
    expect(called(deps.db.queriesOf('customer_interactions')[0], 'where', 'created_at', '>=', since)).toBe(true);
  });

  // The offer day is the follow-up's day, so the emails and the 30 days start there. The complaint check still
  // starts at the job's own day: a signal that came between the job and its follow-up counts.
  test('a job whose follow-up was done: the emails name the offer day, and the complaint check starts at the job day', async () => {
    const deps = world({ jobs: [{ ...JOB, service_day: '2030-03-08', job_day: '2030-03-02' }] });
    await run(deps);
    const [offer] = deps.sendTemplate.mock.calls.map(([send]) => send);
    expect(offer.payload).toMatchObject({
      visit_weekday: 'Friday', visit_date_short: 'Mar 8', next_visit_window: 'May 24 to Jun 7', offer_end_date: 'April 7',
    });
    // March 2, 2030 is on standard time: midnight Eastern is 05:00 UTC.
    const since = new Date('2030-03-02T05:00:00Z');
    expect(called(deps.db.queriesOf('review_requests')[0], 'where', 'rated_at', '>=', since)).toBe(true);
    expect(called(deps.db.queriesOf('customer_interactions')[0], 'where', 'created_at', '>=', since)).toBe(true);
  });
});

describe('pricing outcomes', () => {
  test.each([
    ['the customer already has a plan', { option: null, reason: 'has_plan' }, { held: 1 }, 'has_plan'],
    ['the app cannot price the home', { option: null, reason: 'not_priced' }, { office: 1 }, 'not_priced'],
    ['the account fails the premises proof', { option: null, reason: 'premises' }, { office: 1 }, 'premises'],
    ['the plan has no setup fee to remove', { option: { ...OPTION, setupFee: null }, reason: null }, { office: 1 }, 'no_setup_fee'],
    ['a plan visit costs as much as the job did', { option: { ...OPTION, perVisit: 225 }, reason: null }, { office: 1 }, 'plan_not_below_job'],
  ])('%s: no sample', async (_name, priced, expected, reason) => {
    const deps = world({ buildStartOffer: jest.fn(async () => priced) });
    const summary = await run(deps);
    expect(counts(summary)).toEqual({ ...NONE, ...expected });
    expect(summary.reasons).toEqual({ [reason]: 1 });
    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });
});

describe('the job price', () => {
  test('is the largest PAID invoice of the job; a void or open one never counts', async () => {
    const invoices = (...rows) => ({ tables: { 'invoices as i': rows.map(([status, total], index) => ({ ...INVOICE, id: `inv-${index + 1}`, status, total })) } });
    const paidAbove = world(invoices(['paid', '60.00'], ['paid', '150.00'], ['void', '500.00']));
    expect(counts(await run(paidAbove))).toEqual({ ...NONE, sample: 1 });
    const paidBelow = world(invoices(['paid', '60.00'], ['paid', '90.00'], ['void', '500.00']));
    const summary = await run(paidBelow);
    expect(counts(summary)).toEqual({ ...NONE, office: 1 });
    expect(summary.reasons).toEqual({ plan_not_below_job: 1 });
  });

  test('a plan price above the job price does not count as a priced home with a sample: the price settings still loaded', async () => {
    const deps = world({ buildStartOffer: jest.fn(async () => ({ option: { ...OPTION, perVisit: 300 }, reason: null })) });
    await run(deps);
    expect(deps.closePriceSettingsAlert).toHaveBeenCalledTimes(1);
  });
});

describe('once per job, and one bad job never stops the others', () => {
  test('a job sampled on an earlier morning is done: no rule runs, no price, no send', async () => {
    const deps = world({ tables: { email_messages: [{ id: 'm-1' }] } });
    expect(counts(await run(deps))).toEqual({ ...NONE, done: 1 });
    const [read] = deps.db.queriesOf('email_messages');
    // Done means the SECOND email went out: a run that died between the two sends finishes the pair.
    expect(called(read, 'where', { idempotency_key: `onetime-plan-offer:sample:${REMINDER_TEMPLATE}:job-1` })).toBe(true);
    expect(called(read, 'whereNotNull', 'sent_at')).toBe(true);
    expect(deps.db.queriesOf('customers')).toHaveLength(0);
    expect(deps.buildStartOffer).not.toHaveBeenCalled();
    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  // An earlier morning sent the offer and failed on the reminder. The home is priced again today, and a price
  // setting changed in between: the reminder repeats the values of the offer the office already has.
  test('a morning after a partial send: the reminder carries the values of the offer already sent, not the new price', async () => {
    const offerKey = `onetime-plan-offer:sample:${OFFER_TEMPLATE}:job-1`;
    const isOfferRead = (query) => called(query, 'where', { idempotency_key: offerKey });
    const sent = { first_name: 'Jordan', price_per_application: '$104.50', offer_end_date: 'April 4', estimate_url: 'https://first.test/e' };
    const deps = world({
      tables: { email_messages: (query) => (isOfferRead(query) ? [{ payload_snapshot: { ...sent, setup_fee: '$99' } }] : []) },
      buildStartOffer: jest.fn(async () => ({ option: { ...OPTION, perVisit: 131 }, reason: null })),
    });
    expect(counts(await run(deps))).toEqual({ ...NONE, sample: 1 });
    const [offer, reminder] = deps.sendTemplate.mock.calls.map(([send]) => send);
    expect(reminder.idempotencyKey).toBe(`onetime-plan-offer:sample:${REMINDER_TEMPLATE}:job-1`);
    expect(reminder.payload).toEqual(sent);
    // The library answers the offer's key with the first send. Its values here are the stored ones too.
    expect(offer.payload).toMatchObject({ price_per_application: '$104.50', setup_fee: '$99' });
    // Only an offer that WAS sent fixes the values.
    const stored = deps.db.queriesOf('email_messages').find(isOfferRead);
    expect(called(stored, 'whereNotNull', 'sent_at')).toBe(true);
  });

  test('no offer sent before: both samples carry the price of this morning', async () => {
    const deps = world({ buildStartOffer: jest.fn(async () => ({ option: { ...OPTION, perVisit: 131 }, reason: null })) });
    await run(deps);
    expect(deps.sendTemplate.mock.calls.map(([send]) => send.payload.price_per_application)).toEqual(['$131', '$131']);
  });

  test('a job that throws is counted and logged by id and code only; the next job is still sampled', async () => {
    const deps = world({
      jobs: [JOB, { ...JOB, id: 'job-2', customer_id: 'cust-2' }],
      buildStartOffer: jest.fn(async (customerId) => {
        if (customerId === 'cust-1') throw Object.assign(new Error('no parcel for 12 Example Test Ln'), { code: 'PRICING_UNAVAILABLE' });
        return { option: { ...OPTION }, reason: null };
      }),
    });
    const summary = await run(deps);
    expect(summary.jobs).toBe(2);
    expect(counts(summary)).toEqual({ ...NONE, failed: 1, sample: 1 });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [line] = logger.warn.mock.calls[0];
    expect(line).toContain('job-1');
    expect(line).toContain('code=PRICING_UNAVAILABLE');
    // An error message can carry a street address. It never reaches the log.
    expect(line).not.toContain('Example Test Ln');
    expect(deps.sendTemplate.mock.calls.map(([send]) => send.idempotencyKey)).toEqual([
      `onetime-plan-offer:sample:${OFFER_TEMPLATE}:job-2`, `onetime-plan-offer:sample:${REMINDER_TEMPLATE}:job-2`,
    ]);
  });

  // Both versions are read before the first send, so a job never gets the offer sample alone for this reason.
  test('the reminder template has no version to sample: the offer sample is not sent either', async () => {
    const versions = (query) => (whereValue(query, 't.template_key') === REMINDER_TEMPLATE ? [] : [{ id: 'ver:offer' }]);
    const deps = world({ tables: { 'email_template_versions as v': versions } });
    expect(counts(await run(deps))).toEqual({ ...NONE, failed: 1 });
    expect(deps.sendTemplate).not.toHaveBeenCalled();
    expect(logger.warn.mock.calls[0][0]).toContain('code=TEMPLATE_MISSING');
  });

  test.each([
    ['the library did not send the sample', { sendTemplate: jest.fn(async () => ({ sent: false, aborted: true })) }, 'SAMPLE_NOT_SENT'],
    ['a template has no version to sample', { tables: { 'email_template_versions as v': [] } }, 'TEMPLATE_MISSING'],
    // The division turns a failed read into a verdict. For the job it is an outage, never "not for this customer".
    ['the email division could not read', emailVerdict('LOOKUP_FAILED'), 'LOOKUP_FAILED'],
    // openBalanceExists answers null when it could not decide. Only an explicit "no" lets the job go on.
    ['the open-balance check could not decide', { openBalanceExists: jest.fn(async () => null) }, 'OPEN_BALANCE_UNKNOWN'],
    ['whose debt a part-paid invoice is could not be decided', { ...partPaid(), invoicePayerOwnership: jest.fn(async () => 'payer_unverifiable') }, 'OPEN_BALANCE_UNKNOWN'],
  ])('%s: the job fails and is read again the next morning', async (_name, change, code) => {
    const summary = await run(world(change));
    expect(counts(summary)).toEqual({ ...NONE, failed: 1 });
    expect(summary.reasons).toEqual({});
    expect(logger.warn.mock.calls[0][0]).toContain(`code=${code}`);
  });
});

// The pricer refuses to price on price settings it cannot load whole (PRICING_CONFIG_UNAVAILABLE). The job counts
// that as a failure, like any other outage. A morning with such a refusal and no home priced is an outage that
// lasts, and no page shows it: that morning raises one admin notification, and a morning that prices closes it.
describe('the price settings', () => {
  const refused = () => Object.assign(new Error('the pest price settings are not complete in their rows'), { code: 'PRICING_CONFIG_UNAVAILABLE' });
  const TWO_JOBS = [JOB, { ...JOB, id: 'job-2', customer_id: 'cust-2' }];
  // The pricer refuses the settings for the named customers and prices every other one.
  const refusingFor = (...customerIds) => jest.fn(async (customerId) => {
    if (customerIds.includes(customerId)) throw refused();
    return { option: { ...OPTION }, reason: null };
  });
  const notified = (deps) => ({ raised: deps.raisePriceSettingsAlert.mock.calls, closed: deps.closePriceSettingsAlert.mock.calls });

  test('every job refused on the settings and no home priced: one notification with the count; the jobs are read again', async () => {
    const deps = world({ jobs: TWO_JOBS, buildStartOffer: refusingFor('cust-1', 'cust-2') });
    expect(counts(await run(deps))).toEqual({ ...NONE, failed: 2 });
    expect(notified(deps)).toEqual({ raised: [[{ refused: 2 }]], closed: [] });
    expect(deps.sendTemplate).not.toHaveBeenCalled();
  });

  test('one job refused and another priced the same morning is a moment: no notification, and an open one is closed', async () => {
    const deps = world({ jobs: TWO_JOBS, buildStartOffer: refusingFor('cust-1') });
    expect(counts(await run(deps))).toEqual({ ...NONE, failed: 1, sample: 1 });
    expect(notified(deps)).toEqual({ raised: [], closed: [[{ database: deps.db, now: NOW }]] });
  });

  test.each([
    ['a sampled job', {}, { sample: 1 }],
    // A price with no setup fee goes to the office, and it is still a price: the settings loaded whole.
    ['a price with no setup fee', { buildStartOffer: jest.fn(async () => ({ option: { ...OPTION, setupFee: 0 }, reason: null })) }, { office: 1 }],
    // The price came back before the send failed.
    ['a priced job whose sample was not sent', { sendTemplate: jest.fn(async () => ({ sent: false })) }, { failed: 1 }],
  ])('%s proves the settings load: an open notification is closed, once for the morning', async (_name, change, outcome) => {
    const deps = world({ jobs: TWO_JOBS, ...change });
    const doubled = Object.fromEntries(Object.entries(outcome).map(([verdict, n]) => [verdict, n * 2]));
    expect(counts(await run(deps))).toEqual({ ...NONE, ...doubled });
    expect(notified(deps)).toEqual({ raised: [], closed: [[{ database: deps.db, now: NOW }]] });
  });

  test.each([
    ['no due job', { jobs: [] }],
    ['a job the offer is not for', { tables: { customers: [{ ...CUSTOMER, email: null }] } }],
    ['a home the pricer could not price', { buildStartOffer: jest.fn(async () => ({ option: null, reason: 'not_priced' })) }],
    ['a customer who has a plan', { buildStartOffer: jest.fn(async () => ({ option: null, reason: 'has_plan' })) }],
    ['a failure that is not the price settings', { buildStartOffer: jest.fn(async () => { throw Object.assign(new Error('down'), { code: 'PRICING_UNAVAILABLE' }); }) }],
  ])('%s says nothing about the settings: nothing is raised and nothing is closed', async (_name, change) => {
    const deps = world(change);
    await run(deps);
    expect(notified(deps)).toEqual({ raised: [], closed: [] });
  });

  test.each([
    ['raised', { buildStartOffer: refusingFor('cust-1'), raisePriceSettingsAlert: jest.fn(async () => { throw Object.assign(new Error('write failed for 12 Example Test Ln'), { code: 'ALERT_DOWN' }); }) }, { failed: 1 }],
    ['closed', { closePriceSettingsAlert: jest.fn(async () => { throw Object.assign(new Error('write failed for 12 Example Test Ln'), { code: 'ALERT_DOWN' }); }) }, { sample: 1 }],
  ])('a notification that cannot be %s never fails the run; the log has the code only', async (_name, change, outcome) => {
    const deps = world(change);
    expect(counts(await run(deps))).toEqual({ ...NONE, ...outcome });
    const line = logger.warn.mock.calls.map(([text]) => text).find((text) => text.includes('price settings notification failed'));
    expect(line).toContain('code=ALERT_DOWN');
    expect(line).not.toContain('Example Test Ln');
  });

  test('with the gate off nothing is raised and nothing is closed', async () => {
    process.env.GATE_ONETIME_PLAN_OFFER = 'true';
    const deps = world({ buildStartOffer: refusingFor('cust-1') });
    await run(deps);
    expect(notified(deps)).toEqual({ raised: [], closed: [] });
  });
});

// The real emitter through the real composer, which throws in a test on any break of docs/admin-notifications.md.
// The row itself (written, refreshed, closed, opened again) is proven on PostgreSQL.
describe('the price settings notification itself', () => {
  const KEY = _test.PRICE_SETTINGS_ALERT_KEY;
  let notifyAdmin;
  beforeEach(() => {
    notifyAdmin = jest.spyOn(require('../services/notification-service'), 'notifyAdmin').mockResolvedValue({ id: 'n-1' });
  });
  afterEach(() => notifyAdmin.mockRestore());

  test('one keyed row for the Pricing Logic page, for a person to act on; a later morning rewrites it and does not ring again', async () => {
    await _test.defaultDeps().raisePriceSettingsAlert({ refused: 2 });
    expect(notifyAdmin).toHaveBeenCalledTimes(1);
    const [category, headline, why, options] = notifyAdmin.mock.calls[0];
    expect([category, headline]).toEqual(['system', 'Estimates — check the pest price settings']);
    expect(why).toBe('No plan offer could be priced this morning because a pest price setting is missing or did not load.');
    expect(options).toMatchObject({
      link: '/admin/pricing-logic', dedupeKey: KEY, dedupeOpenOnly: true, refreshOnDedupe: true,
      metadata: {
        source: 'onetime-plan-offer', refused: 2, area: 'Estimates', severity: 'needs-you', who: 'either',
        doneWhen: 'plan_offer_priced', subject: { type: 'check', id: KEY },
      },
    });
    expect(options.ringOnRefresh()).toBe(false);
    expect(options.detail).toContain('could not price 2 one-time jobs this morning');
  });

  test('one refused job reads as one job', async () => {
    await _test.defaultDeps().raisePriceSettingsAlert({ refused: 1 });
    expect(notifyAdmin.mock.calls[0][3].detail).toContain('could not price 1 one-time job this morning');
  });
});

describe('the sample payload', () => {
  const payload = (overrides = {}) => _test.offerPayload({ customer: CUSTOMER, offerDay: '2030-11-18', option: OPTION, ...overrides });

  test('dates cross a year end without a year in the words', () => {
    expect(payload()).toMatchObject({
      visit_weekday: 'Monday', visit_date_short: 'Nov 18', next_visit_window: 'Feb 3 to Feb 17', offer_end_date: 'December 18',
    });
  });

  test('a whole-dollar price drops the cents; any other keeps two places', () => {
    expect(payload({ option: { perVisit: 100, setupFee: 99 } })).toMatchObject({ price_per_application: '$100', setup_fee: '$99' });
    expect(payload({ option: { perVisit: 104.5, setupFee: 99 } }).price_per_application).toBe('$104.50');
  });

  test('a customer with no first name is greeted without the surname', () => {
    expect(payload({ customer: { ...CUSTOMER, first_name: null } }).first_name).toBe('there');
  });
});

describe('the daily cron', () => {
  // The scheduler is the job's only caller. A registration that is dropped, doubled, moved off the gate or off
  // its lease would fail no other test: the job would not run, or two processes would price the same morning.
  test('is registered once, at 10:13 AM ET: the gate is read on each tick before any work, and the job runs inside a try under its lease', () => {
    const src = fs.readFileSync(path.join(__dirname, '../services/scheduler.js'), 'utf8');
    expect(src.match(/cron\.schedule\('13 10 \* \* \*'/g)).toHaveLength(1);
    const at = src.indexOf("cron.schedule('13 10 * * *'");
    const block = src.slice(at, src.indexOf("{ timezone: 'America/New_York' });", at) + 34);
    expect(block.length).toBeLessThan(700);
    const order = [
      "if (require('../config/feature-gates').onetimePlanOfferMode?.() !== 'shadow') return;",
      'try {',
      "await runExclusive('onetime-plan-offer', async () => {",
      "await require('./onetime-plan-offer').runOnetimePlanOfferJob();",
      '} catch (err) {',
      "{ timezone: 'America/New_York' });",
    ].map((piece) => block.indexOf(piece));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});

describe('the default wiring', () => {
  // The job runs once a day in production. A wrong require path or a renamed export would first fail there.
  test('every collaborator the job needs resolves from its real module', () => {
    const deps = _test.defaultDeps();
    for (const name of [
      'buildStartOffer', 'channelFor', 'eligibleForEmail', 'reviewAskOnItsWay', 'lastDeliveredAskAt', 'lastManualAskAt',
      'openBalanceExists', 'isUncountedPartialDue', 'invoicePayerOwnership', 'itemizedMemberIds', 'combinedFirstInvoiceOf',
      'isInternalTestContact', 'activeSuppressionsFor', 'sendTemplate', 'unsubscribeUrl', 'raisePriceSettingsAlert', 'closePriceSettingsAlert',
    ]) {
      expect([name, typeof deps[name]]).toEqual([name, 'function']);
    }
    expect(deps.askSpacingMs).toBe(72 * HOUR);
    expect(deps.partiallyPaidStatus).toBe('partially_paid');
    // The public estimate page's own list of the estimates a customer can open.
    expect(deps.liveEstimateStatuses).toEqual(['sending', 'sent', 'viewed']);
    // The scheduler's own test for an estimate held for a new price.
    expect(deps.repricePendingAbsentSql).toContain('reprice_pending_at');
    expect(deps.openRequestTerminalStatuses).toEqual(expect.arrayContaining(['resolved', 'closed', 'cancelled']));
  });

  test('the sample recipient is an internal address', () => {
    expect(require('../utils/internal-email-recipients').isInternalEmailRecipient(OFFICE)).toBe(true);
  });
});

// The offer's dates, counted in ET calendar days from the offer day. The email states them and the offer estimate
// stores them, from this one function.
describe('offerTerms', () => {
  test('good through day 30, ends at the start of the next ET day, next visit from day 77 to day 91', () => {
    expect(offerTerms('2026-11-10')).toEqual({
      offerDay: '2026-11-10',
      lastDay: '2026-12-10',
      endsAt: new Date('2026-12-11T05:00:00.000Z'),
      firstVisitFrom: '2027-01-26',
      firstVisitTo: '2027-02-09',
    });
  });

  test('the end instant follows the ET clock across the March clock change', () => {
    // The last day is Sunday, March 14, 2027, the day the clocks go forward: the next day starts at 04:00 UTC.
    const terms = offerTerms('2027-02-12');
    expect(terms.lastDay).toBe('2027-03-14');
    expect(terms.endsAt).toEqual(new Date('2027-03-15T04:00:00.000Z'));
  });

  test('the email states the same days', () => {
    const payload = _test.offerPayload({
      customer: { first_name: 'Jordan', last_name: 'Example', address_line1: '12 Sample Way' },
      offerDay: '2026-11-10',
      option: { perVisit: 123, setupFee: 0 },
    });
    expect(payload.offer_end_date).toBe('December 10');
    expect(payload.next_visit_window).toBe('Jan 26 to Feb 9');
  });
});

// The mint of the offer estimate asks this before it waives the setup fee. The query itself runs on real Postgres
// (plan-offer-mint-postgres.test.js); here, what never reaches the database.
describe('dueOfferOfJob', () => {
  const NOW = new Date('2026-11-22T15:00:00Z');
  test.each([
    ['an id that is not a uuid', { jobId: 'job-1', customerId: 'c1', now: NOW }],
    ['no job id', { jobId: '', customerId: 'c1', now: NOW }],
    ['no customer', { jobId: '3f0c8a52-6f0e-4d5e-9a57-0d2a1c3b4e5f', customerId: null, now: NOW }],
    ['no clock', { jobId: '3f0c8a52-6f0e-4d5e-9a57-0d2a1c3b4e5f', customerId: 'c1' }],
  ])('%s is no offer, and nothing is read', async (_label, args) => {
    const database = jest.fn(() => { throw new Error('must not be read'); });
    expect(await dueOfferOfJob(database, args)).toBe(null);
    expect(database).not.toHaveBeenCalled();
  });
});
