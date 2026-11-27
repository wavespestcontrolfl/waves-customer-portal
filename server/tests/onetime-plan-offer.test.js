/**
 * One-time job to plan offer (services/onetime-plan-offer.js, GATE_ONETIME_PLAN_OFFER=shadow|live).
 *
 * Shadow's promise: it prices real cases and emails SAMPLES to the office, and no customer gets anything.
 * This suite pins the decisions around that promise with a recording fake database and stub collaborators:
 * the gate values, which send rule holds a job and under which reason (and in which order the rules run),
 * what goes to the office to price by hand, the two sample sends (recipient, test send, once per job), that
 * one bad job never stops the others, and the one admin notification for a morning the price settings stopped.
 * A sample means that the customer would get the offer today.
 * Live's promise (the last describe blocks): the same judging and pricing, then the customer's own estimate through
 * the mint and the offer email through the email division's ledger, once, to a customer who pays after each visit,
 * and nothing at all until the offer template is published. Shadow and off never reach the mint or the ledger.
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
      if (typeof source === 'function') return source(query);
      // The estimates read for a quote the customer ended (a status filter) answers only the rows in that status.
      const statuses = table === 'estimates' ? (query.calls.find(([method, column]) => method === 'whereIn' && column === 'status') || [])[2] : null;
      return (source || []).filter((row) => !statuses?.includes('declined') || statuses.includes(row.status));
    };
    const builder = {
      first: async (...columns) => { query.calls.push(['first', ...columns]); return rows()[0]; },
      select: async () => rows(),
    };
    const recorded = [
      'where', 'orWhere', 'whereNot', 'whereIn', 'orWhereIn', 'whereNotIn', 'whereNull', 'whereNotNull', 'whereRaw', 'orWhereRaw',
      'whereBetween', 'forShare', 'leftJoin', 'join', 'joinRaw', 'orderBy', 'orderByRaw', 'limit',
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
// `jobs` is the first page of due jobs (a later page is empty). `reminderJobs` is the first page of the live
// reminder pass (the read that asks for an accepted offer email): none unless the test says so.
const isReminderPageRead = (query) => query.calls.some(([method, sql]) => method === 'whereRaw' && String(sql).startsWith('EXISTS (SELECT 1 FROM email_messages m'));
function world({ tables = {}, jobs = [JOB], reminderJobs = [], ...deps } = {}) {
  return {
    db: fakeDb({
      'scheduled_services as s': (query) => {
        if (isLaterPageRead(query)) return [];
        return isReminderPageRead(query) ? reminderJobs : jobs;
      },
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
    // Live mode's collaborators. A published offer template, a mint that answers with a quote, a customer on the
    // card rail, and a ledger that sends.
    resolveTemplateForSend: jest.fn(async () => ({ template: { status: 'active' }, version: { status: 'active' } })),
    mintPlanStartEstimate: jest.fn(async () => ({ estimateId: 'est-1', token: 'tok-1', url: '/estimate/tok-1', reused: false })),
    buildEstimateMembershipContext: jest.fn(async () => null),
    resolveRecurringCardPolicyForEstimate: jest.fn(async () => ({ enforced: true, required: true, exemptReason: null })),
    payAfterFirstVisitCardRail: jest.fn(() => true),
    sendWithLedger: jest.fn(async () => ({ ok: true, sent: true, reason: null, row: { id: 'led-1' }, duplicate: false })),
    settleStaleReservations: jest.fn(async () => 0),
    writeOfferDelivery: jest.fn(async () => true),
    isAutopayPaused: jest.fn(() => false),
    explicitAutopayDisable: jest.fn(async () => false),
    unsubscribeUrl: (token) => `https://unsub.test/${token}`,
    raisePriceSettingsAlert: jest.fn(async () => ({ id: 'alert-1' })),
    closePriceSettingsAlert: jest.fn(async () => 0),
    raiseOfficeItem: jest.fn(async () => ({ id: 'n-office' })),
    planStartAcceptRefusal: jest.fn(async () => null),
    assertPlanStartAcceptEligible: jest.fn(async () => undefined),
    planStartBlocker: jest.fn(async () => null),
    closeOfficeItem: jest.fn(async () => 1),
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
  test.each([
    [undefined], [''], ['true'], ['on'], ['false'], ['Shadow'], ['SHADOW'], [' shadow '], ['shadow '], ['Live'], ['LIVE'], [' live'], ['live '],
  ])('value %p is off: the job reads nothing and sends nothing', async (value) => {
    if (value === undefined) delete process.env.GATE_ONETIME_PLAN_OFFER;
    else process.env.GATE_ONETIME_PLAN_OFFER = value;
    const deps = world({ db: jest.fn(() => { throw new Error('the job read the database with the gate off'); }) });
    expect(await run(deps)).toMatchObject({ mode: 'off', jobs: 0, ...NONE });
    expect(deps.db).not.toHaveBeenCalled();
    expect(deps.sendTemplate).not.toHaveBeenCalled();
    expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
    expect(deps.sendWithLedger).not.toHaveBeenCalled();
  });

  test("exactly 'shadow' runs the job", async () => {
    process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
    expect((await run(world())).mode).toBe('shadow');
  });

  // The reader is what the scheduler and the job both ask: the value is compared as written.
  test.each([['shadow', 'shadow'], ['live', 'live'], ['true', 'off'], ['Live', 'off'], [' live ', 'off'], [undefined, 'off']])('the reader answers %p with %p', (value, mode) => {
    if (value === undefined) delete process.env.GATE_ONETIME_PLAN_OFFER;
    else process.env.GATE_ONETIME_PLAN_OFFER = value;
    expect(require('../config/feature-gates').onetimePlanOfferMode()).toBe(mode);
  });

  // Live behavior can never run under shadow: the mint and the ledger are not reached, and the office gets the samples.
  test('shadow never makes an estimate and never sends through the ledger: the two samples go to the office and nothing else', async () => {
    const deps = world();
    const summary = await run(deps);
    expect(summary).not.toHaveProperty('sent');
    expect(summary).not.toHaveProperty('words_not_approved');
    expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
    expect(deps.sendWithLedger).not.toHaveBeenCalled();
    expect(deps.resolveTemplateForSend).not.toHaveBeenCalled();
    expect(deps.sendTemplate).toHaveBeenCalledTimes(2);
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
    const read = deps.db.queriesOf('estimates').find((query) => called(query, 'whereNull', 'archived_at'));
    expect(read).toBeDefined();
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
    ['the pricer reads the property as a business', { option: null, reason: 'commercial' }, { held: 1 }, 'commercial'],
    ['the pricer reads the account as not live', { option: null, reason: 'not_live' }, { held: 1 }, 'not_live'],
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
      "if (!['shadow', 'live'].includes(require('../config/feature-gates').onetimePlanOfferMode?.())) return;",
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
      // Live mode: the library's own send resolution, the ledger, the mint, and the estimate page's card-rail functions.
      'resolveTemplateForSend', 'sendWithLedger', 'settleStaleReservations', 'mintPlanStartEstimate', 'buildEstimateMembershipContext',
      'resolveRecurringCardPolicyForEstimate', 'payAfterFirstVisitCardRail', 'isAutopayPaused', 'explicitAutopayDisable', 'writeOfferDelivery',
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
      endsAt: new Date('2026-12-11T04:59:59.999Z'),
      firstVisitFrom: '2027-01-26',
      firstVisitTo: '2027-02-09',
    });
  });

  test('the end instant follows the ET clock across the March clock change', () => {
    // The last day is Sunday, March 14, 2027, the day the clocks go forward: the next day starts at 04:00 UTC.
    const terms = offerTerms('2027-02-12');
    expect(terms.lastDay).toBe('2027-03-14');
    expect(terms.endsAt).toEqual(new Date('2027-03-15T03:59:59.999Z'));
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

// ---- Live mode (owner 2026-11-20, "i want auto"): the customer's estimate, then the customer's email. ----
describe('GATE_ONETIME_PLAN_OFFER=live', () => {
  const { portalUrl } = require('../utils/portal-url');
  const LIVE_OPTION = { id: 'pest-quarterly', monthly: 34.83, perVisit: 104.5, dueAtStart: 0, oneTime: 0, setupFee: 99 };
  // The offer stamp of an estimate, as the mint stores it (plan-offer-estimate.js planOfferOf). The dates are the
  // ones of JOB's offer day, March 5: good through April 4 (it ends when April 5 starts in ET), next visit from May 21.
  const stamp = (jobId, dates = {}) => ({ planStart: { offer: { jobId, endsAt: '2030-04-05T03:59:59.999Z', firstVisitFrom: '2030-05-21', ...dates } } });
  // The estimate the mint answers with: this job's offer quote, with the dates of the day the run listed the job on.
  const mintedFor = (jobId, dates) => ({ id: 'est-1', customer_id: 'cust-1', source: 'plan_start', status: 'sent', estimate_data: stamp(jobId, dates) });
  const MINTED_ROW = mintedFor('job-1');
  // The estimates table answers two reads: the minted row by its id (the date check and the card-rail check), and
  // the live-estimate rule (the rows the customer already has). The test says which rows the customer has.
  // A quote the customer ended is another read (a final-status filter): none, unless the test says so.
  const estimates = (existing = [], minted = MINTED_ROW) => (query) => {
    if (called(query, 'where', { id: 'est-1' })) return [minted];
    return called(query, 'whereIn', 'status', ['declined', 'accepted']) ? [] : existing;
  };
  const liveWorld = ({ tables = {}, existing = [], minted, ...deps } = {}) => world({
    buildStartOffer: jest.fn(async () => ({ option: { ...LIVE_OPTION }, reason: null })),
    tables: { estimates: estimates(existing, minted), ...tables },
    ...deps,
  });
  const liveCounts = (summary) => ({ ...counts(summary), sent: summary.sent });
  const ZERO = { ...NONE, sent: 0 };
  const sendOf = (deps) => deps.sendWithLedger.mock.calls[0][0];

  beforeEach(() => {
    process.env.GATE_ONETIME_PLAN_OFFER = 'live';
  });

  describe('the words gate: nothing happens until the offer template is published', () => {
    test.each([
      ['a draft template (the library refuses a real send)', 'EMAIL_TEMPLATE_DISABLED'],
      ['a template with no active version, or none at all', 'EMAIL_TEMPLATE_UNAVAILABLE'],
    ])('%s: the run reads no job, makes no estimate and sends nothing', async (_name, code) => {
      const deps = liveWorld({ resolveTemplateForSend: jest.fn(async () => { throw Object.assign(new Error('no words'), { code }); }) });
      expect(await run(deps)).toEqual({
        mode: 'live', jobs: 0, ...ZERO, reasons: {}, words_not_approved: true,
      });
      // No job is read. The one read is the office items' close, which runs before the words gate.
      expect(deps.db.queries.map((query) => query.table)).toEqual(['notifications']);
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
      expect(deps.sendTemplate).not.toHaveBeenCalled();
    });

    test('the library is asked about the offer template, the way a real send asks it; a published template runs the job', async () => {
      const deps = liveWorld();
      const summary = await run(deps);
      // The offer template first; the reminder pass asks about its own template after the offers.
      expect(deps.resolveTemplateForSend).toHaveBeenCalledTimes(2);
      expect(deps.resolveTemplateForSend.mock.calls[0][0]).toEqual({ templateKey: OFFER_TEMPLATE, database: deps.db });
      expect(deps.resolveTemplateForSend.mock.calls[1][0]).toEqual({ templateKey: REMINDER_TEMPLATE, database: deps.db });
      expect(summary).not.toHaveProperty('words_not_approved');
      expect(summary.sent).toBe(1);
    });

    test('a failed read of the template is an outage, not "not approved": the run throws and the scheduler logs it', async () => {
      const deps = liveWorld({ resolveTemplateForSend: jest.fn(async () => { throw Object.assign(new Error('db down'), { code: 'ECONNRESET' }); }) });
      await expect(run(deps)).rejects.toThrow('db down');
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });
  });

  describe('a job that passes every send rule and prices', () => {
    test('the run counts one offer sent, sends no office sample, and keeps the summary keys', async () => {
      const deps = liveWorld();
      expect(await run(deps)).toEqual({
        mode: 'live', jobs: 1, ...ZERO, sent: 1, reasons: {}, reminder: { jobs: 0, sent: 0, held: 0, done: 0, failed: 0, reasons: {} },
      });
      expect(deps.sendTemplate).not.toHaveBeenCalled();
      expect(deps.db.queriesOf('email_template_versions as v')).toHaveLength(0);
    });

    test('the estimate is made first, with the job and nothing else about the dates, and the email is sent after it', async () => {
      const order = [];
      const deps = liveWorld({
        mintPlanStartEstimate: jest.fn(async () => { order.push('mint'); return { estimateId: 'est-1', token: 'tok-1', url: '/estimate/tok-1', reused: false }; }),
        payAfterFirstVisitCardRail: jest.fn(() => { order.push('rail'); return true; }),
        sendWithLedger: jest.fn(async () => { order.push('send'); return { ok: true, sent: true, row: { id: 'led-1' }, duplicate: false }; }),
      });
      await run(deps);
      // The card rail is asked about the account before the home is priced, and again about the estimate.
      expect(order).toEqual(['rail', 'mint', 'rail', 'send']);
      expect(deps.mintPlanStartEstimate).toHaveBeenCalledTimes(1);
      const [args] = deps.mintPlanStartEstimate.mock.calls[0];
      // The caller names the job only: the mint proves the job and takes both dates from offerTerms.
      expect(args).toEqual({
        customer: expect.objectContaining({ id: 'cust-1' }),
        serviceKey: 'pest_control',
        optionId: 'pest-quarterly',
        shown: { monthly: 34.83, perVisit: 104.5, dueAtStart: 0, oneTime: 0, setupFee: 0 },
        offer: { jobId: 'job-1' },
        now: expect.any(Function),
      });
      expect(args.offer).not.toHaveProperty('endsAt');
      expect(args.offer).not.toHaveProperty('firstVisitFrom');
      // The mint's clock is the run's clock, so the dates are the ones the run's own day gives.
      expect(args.now()).toEqual(NOW);
    });

    test('the email goes through the ledger: nurture stream, marketing class, one key per job, the address the payload was built for', async () => {
      const deps = liveWorld();
      await run(deps);
      expect(deps.sendWithLedger).toHaveBeenCalledTimes(1);
      const call = sendOf(deps);
      expect(call).toEqual({
        customerId: 'cust-1',
        stream: 'nurture',
        marketingClass: 'marketing',
        emailKey: OFFER_TEMPLATE,
        idempotencyKey: 'onetime-plan-offer:offer:job-1',
        now: NOW,
        expectedRecipientEmail: 'jordan@example.test',
        guard: expect.any(Function),
        boundaryGuard: expect.any(Function),
        template: {
          templateKey: OFFER_TEMPLATE, payload: expect.any(Object), categories: ['onetime_plan_offer'], linkEstimateId: 'est-1',
        },
      });
      expect(_test.offerKey('job-1')).toBe('onetime-plan-offer:offer:job-1');
      // The payload carries exactly the template's variables, with the price and the dates of the offer.
      expect(Object.keys(call.template.payload)).toEqual(TEMPLATE_VARIABLES[OFFER_TEMPLATE]);
      expect(call.template.payload).toEqual({
        first_name: 'Jordan',
        visit_weekday: 'Tuesday',
        visit_date_short: 'Mar 5',
        address_short: '12 Example Test Ln',
        price_per_application: '$104.50',
        setup_fee: '$99',
        next_visit_window: 'May 21 to Jun 4',
        offer_end_date: 'April 4',
        estimate_url: portalUrl('/estimate/tok-1'),
      });
    });

    test("the button's link is the quote this run's mint answered with, never a stored one (a moved offer day mints a new quote)", async () => {
      const deps = liveWorld({
        mintPlanStartEstimate: jest.fn(async () => ({ estimateId: 'est-1', token: 'tok-new', url: '/estimate/tok-new', reused: false })),
      });
      await run(deps);
      expect(sendOf(deps).template.payload.estimate_url).toBe(portalUrl('/estimate/tok-new'));
      expect(sendOf(deps).template.payload.estimate_url).not.toMatch(/sample/);
    });

    test('the email states the same days the mint stores, on a run the day after the clocks go forward', async () => {
      // 2030 clocks go forward on Sunday, March 10. This run is Monday, March 11 at 10:13 AM ET (14:13 UTC).
      const dstNow = new Date('2030-03-11T14:13:00Z');
      const deps = liveWorld({
        jobs: [{ ...JOB, service_day: '2030-02-08', job_day: '2030-02-08' }],
        minted: mintedFor('job-1', { endsAt: '2030-03-11T03:59:59.999Z', firstVisitFrom: '2030-04-26' }),
      });
      const summary = await runOnetimePlanOfferJob({ now: dstNow, deps });
      expect(summary.sent).toBe(1);
      const [due] = deps.db.queriesOf('scheduled_services as s');
      // 14 days back from March 11 is February 25, and 3 days back is March 8, by the Eastern calendar.
      expect(called(due, 'whereRaw', `${OFFER_DAY} BETWEEN ?::date AND ?::date`, ['2030-02-25', '2030-03-08'])).toBe(true);
      expect(sendOf(deps).now).toEqual(dstNow);
      expect(sendOf(deps).template.payload).toMatchObject({
        visit_date_short: 'Feb 8', offer_end_date: 'March 10', next_visit_window: 'Apr 26 to May 10',
      });
      // offerTerms is the one place the dates come from: the last day is March 10, and the offer ends when the
      // next Eastern day starts, which is 04:00 UTC because the clocks have already changed.
      expect(offerTerms('2030-02-08')).toMatchObject({ lastDay: '2030-03-10', endsAt: new Date('2030-03-11T03:59:59.999Z') });
      expect(deps.mintPlanStartEstimate.mock.calls[0][0].now()).toEqual(dstNow);
    });
  });

  describe('already offered', () => {
    test('an offer email that was sent, or may have been, is done: no rule, no price, no estimate, no send', async () => {
      const deps = liveWorld({ tables: { email_messages: [{ id: 'm-1' }] } });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, done: 1 });
      const [read] = deps.db.queriesOf('email_messages');
      expect(called(read, 'where', { idempotency_key: 'onetime-plan-offer:offer:job-1' })).toBe(true);
      // Sent, or handed to the provider with the answer lost (the ledger's own "accepted or uncertain").
      expect(called(read, 'whereNotNull', 'sent_at')).toBe(true);
      expect(called(read, 'orWhere', 'provider_handoff_phase', 'started')).toBe(true);
      expect(deps.db.queriesOf('customers')).toHaveLength(0);
      expect(deps.buildStartOffer).not.toHaveBeenCalled();
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test('a row that never reached the provider is not an offer: the job goes on and the same key is tried again', async () => {
      // The database answers the "sent or uncertain" read with no row, as it does for a failed or rejected one.
      const deps = liveWorld({ tables: { email_messages: [] } });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, sent: 1 });
      expect(sendOf(deps).idempotencyKey).toBe('onetime-plan-offer:offer:job-1');
    });
  });

  describe('a send rule or the price keeps the customer out: no estimate and no email', () => {
    test.each([
      ['offers are turned off', { tables: { notification_prefs: [{ marketing_offers: false }] } }, { held: 1 }, 'offers_off'],
      ['another visit is booked', { tables: { 'scheduled_services as o': [{ id: 'job-2' }] } }, { held: 1 }, 'another_visit'],
      ['the email division says no', emailVerdict('CAP_SAME_DAY'), { held: 1 }, 'cap_same_day'],
      ['the customer already has a plan', { buildStartOffer: jest.fn(async () => ({ option: null, reason: 'has_plan' })) }, { held: 1 }, 'has_plan'],
      ['the app cannot price the home', { buildStartOffer: jest.fn(async () => ({ option: null, reason: 'not_priced' })) }, { office: 1 }, 'not_priced'],
      ['a plan visit costs as much as the job', { buildStartOffer: jest.fn(async () => ({ option: { ...LIVE_OPTION, perVisit: 225 }, reason: null })) }, { office: 1 }, 'plan_not_below_job'],
    ])('%s', async (_name, change, expected, reason) => {
      const deps = liveWorld(change);
      const summary = await run(deps);
      expect(liveCounts(summary)).toEqual({ ...ZERO, ...expected });
      expect(summary.reasons).toEqual({ [reason]: 1 });
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test('a morning that prices a home closes an open price-settings notification, as in shadow', async () => {
      const deps = liveWorld();
      await run(deps);
      expect(deps.closePriceSettingsAlert).toHaveBeenCalledTimes(1);
    });
  });

  describe("the job's own offer quote does not hold the job; every other estimate does (both modes)", () => {
    const own = { id: 'est-own', estimate_data: stamp('job-1') };
    const ownAsText = { id: 'est-own', estimate_data: JSON.stringify(stamp('job-1')) };
    const another = { id: 'est-other', estimate_data: stamp('job-9') };
    const plain = { id: 'est-plain', estimate_data: {} };

    test.each([
      ['the job\'s own offer quote (a denied send left it on file)', [own], 1],
      ['the job\'s own offer quote, stored as text', [ownAsText], 1],
    ])('live: %s is reused and the email goes', async (_name, existing, sent) => {
      const deps = liveWorld({ existing });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, sent });
      expect(deps.mintPlanStartEstimate).toHaveBeenCalledTimes(1);
    });

    test.each([
      ['the offer quote of another job', [another]],
      ['an ordinary open estimate', [plain]],
      ["the job's own quote and an ordinary open estimate", [own, plain]],
      ["the job's own quote and the offer quote of another job", [own, another]],
    ])('live: %s holds the job', async (_name, existing) => {
      const deps = liveWorld({ existing });
      const summary = await run(deps);
      expect(liveCounts(summary)).toEqual({ ...ZERO, held: 1 });
      expect(summary.reasons).toEqual({ open_estimate: 1 });
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test('shadow reads the same rule: its own offer quote does not hold, another one does', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      expect(counts(await run(liveWorld({ existing: [own] })))).toEqual({ ...NONE, sample: 1 });
      const held = await run(liveWorld({ existing: [another] }));
      expect(counts(held)).toEqual({ ...NONE, held: 1 });
      expect(held.reasons).toEqual({ open_estimate: 1 });
    });
  });

  describe('one offer per customer per 12 months', () => {
    test('the rule reads the ledger: real offer sends or reservations for ANOTHER job in the last 365 days', async () => {
      const deps = liveWorld({ tables: { marketing_email_ledger: [] } });
      await run(deps);
      const [read] = deps.db.queriesOf('marketing_email_ledger');
      expect(called(read, 'where', { customer_id: 'cust-1', email_key: OFFER_TEMPLATE })).toBe(true);
      expect(called(read, 'whereIn', 'status', ['sent', 'reserved'])).toBe(true);
      // This job's own key never counts, and the window is 365 days back from the run.
      expect(called(read, 'whereNot', 'idempotency_key', 'onetime-plan-offer:offer:job-1')).toBe(true);
      expect(called(read, 'whereRaw', 'COALESCE(sent_at, reserved_at) > ?', [new Date(NOW.getTime() - 365 * 24 * HOUR)])).toBe(true);
    });

    test.each([['live'], ['shadow']])('%s: an offer to the customer for another job holds the job as offered_before; no estimate, no email', async (mode) => {
      process.env.GATE_ONETIME_PLAN_OFFER = mode;
      const deps = liveWorld({ tables: { marketing_email_ledger: [{ id: 'led-0' }] } });
      const summary = await run(deps);
      expect(summary.reasons).toEqual({ offered_before: 1 });
      expect(summary.held).toBe(1);
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
      expect(deps.sendTemplate).not.toHaveBeenCalled();
    });

    // The ledger settles a `failed` row from email_messages for 30 days only. Across the whole year, a failed row
    // whose email the provider took (or whose handoff started) is an offer that went out, or may have.
    describe('a failed ledger row counts when its email went out, or may have', () => {
      const failedRow = { id: 'led-f', idempotency_key: 'onetime-plan-offer:offer:job-0' };
      const ledgerOf = (failed) => (query) => (called(query, 'where', { status: 'failed' }) ? failed : []);
      const world3 = (message, failed = [failedRow]) => liveWorld({
        tables: { marketing_email_ledger: ledgerOf(failed), email_messages: (query) => (called(query, 'where', { idempotency_key: failedRow.idempotency_key }) ? message : []) },
      });

      test.each([
        ['the provider accepted it', [{ id: 'm-0', sent_at: '2030-01-01T00:00:00Z' }], 'offered_before'],
        ['the handoff started and the answer was lost', [{ id: 'm-0', provider_handoff_phase: 'started', updated_at: '2030-01-01T00:00:00Z' }], 'offered_before'],
      ])('%s: holds the job', async (_name, message, reason) => {
        const deps = world3(message);
        expect((await run(deps)).reasons).toEqual({ [reason]: 1 });
        expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      });

      test.each([
        ['no message at all', []],
        ['a message the provider refused', [{ id: 'm-0', provider_handoff_phase: 'rejected', status: 'failed' }]],
      ])('%s: not an offer, the job goes on', async (_name, message) => {
        expect(liveCounts(await run(world3(message)))).toEqual({ ...ZERO, sent: 1 });
      });

      test('the year runs from the handoff, not the reservation: an older message does not count', async () => {
        for (const message of [[{ id: 'm-0', sent_at: '2029-03-01T00:00:00Z' }], [{ id: 'm-0', provider_handoff_phase: 'started', updated_at: '2029-03-01T00:00:00Z' }]]) {
          expect(liveCounts(await run(world3(message)))).toEqual({ ...ZERO, sent: 1 });
        }
      });

      test('the failed rows read are the customer\'s other offers, whatever the reservation\'s age', async () => {
        const deps = world3([]);
        await run(deps);
        const read = deps.db.queriesOf('marketing_email_ledger').find((query) => called(query, 'where', { status: 'failed' }));
        expect(called(read, 'where', { customer_id: 'cust-1', email_key: OFFER_TEMPLATE })).toBe(true);
        expect(called(read, 'whereNot', 'idempotency_key', 'onetime-plan-offer:offer:job-1')).toBe(true);
      });

      test('the reservation\'s guard counts it too, on the reservation\'s transaction', async () => {
        const deps = liveWorld();
        await run(deps);
        const { guard } = sendOf(deps);
        const trx = fakeDb({
          marketing_email_ledger: ledgerOf([failedRow]), email_messages: [{ id: 'm-0', sent_at: '2030-01-01T00:00:00Z' }],
        });
        expect(await guard(trx)).toEqual({ reason: 'OFFERED_BEFORE' });
        expect(trx.queriesOf('email_messages')).toHaveLength(1);
      });
    });

    test('the rule runs right after the opt-outs and before the money rules', async () => {
      const heldBy = async (change) => (await run(liveWorld({ tables: { marketing_email_ledger: [{ id: 'led-0' }] }, ...change }))).reasons;
      expect(await heldBy({ tables: { marketing_email_ledger: [{ id: 'led-0' }], notification_prefs: [{ marketing_offers: false }] } })).toEqual({ offers_off: 1 });
      expect(await heldBy({ tables: { marketing_email_ledger: [{ id: 'led-0' }], 'invoices as i': [] } })).toEqual({ offered_before: 1 });
    });

    test('stale reserved rows are settled by the ledger before the rule counts them', async () => {
      const order = [];
      const deps = liveWorld({
        tables: { marketing_email_ledger: () => { order.push('read'); return []; } },
        settleStaleReservations: jest.fn(async () => { order.push('settle'); return 0; }),
      });
      await run(deps);
      expect(deps.settleStaleReservations).toHaveBeenCalledWith('cust-1', NOW);
      expect(order.slice(0, 2)).toEqual(['settle', 'read']);
    });

    test("the ledger's guard repeats the rule inside the reservation, on the reservation's own transaction", async () => {
      const deps = liveWorld();
      await run(deps);
      const { guard } = sendOf(deps);
      const trx = fakeDb({ marketing_email_ledger: [{ id: 'led-0' }] });
      // The guard contract of the one existing caller: null to go on, { reason } to deny.
      expect(await guard(trx)).toEqual({ reason: 'OFFERED_BEFORE' });
      expect(called(trx.queriesOf('marketing_email_ledger')[0], 'whereNot', 'idempotency_key', 'onetime-plan-offer:offer:job-1')).toBe(true);
      expect(await guard(fakeDb({ marketing_email_ledger: [] }))).toBeNull();
    });
  });

  // The job's opt-out check runs before the home is priced and the estimate is made. The division's own checks
  // for this stream do not read these three, so the ledger is handed them: inside the reservation and again at
  // the provider handoff, each on the ledger's own transaction.
  describe('an opt-out after the job\'s own check: asked again inside the reservation and at the provider handoff', () => {
    const guardsOf = async () => {
      const deps = liveWorld();
      await run(deps);
      return { deps, ...sendOf(deps) };
    };

    test.each([
      ['offers turned off in the app', { notification_prefs: [{ marketing_offers: false }] }, 'OFFERS_OFF'],
      ['marketing by text only', { notification_prefs: [{ marketing_channel: 'sms' }] }, 'OFFERS_BY_TEXT_ONLY'],
    ])('%s denies both, in the ledger\'s spelling', async (_name, tables, reason) => {
      const { guard, boundaryGuard } = await guardsOf();
      expect(await guard(fakeDb({ marketing_email_ledger: [], ...tables }))).toEqual({ reason });
      expect(await boundaryGuard(fakeDb({ estimates: [MINTED_ROW], customers: [CUSTOMER], ...tables }))).toEqual({ reason });
    });

    test('a suppression of the marketing group denies both, read for the address the email was built for, on that transaction', async () => {
      const { deps, guard, boundaryGuard } = await guardsOf();
      deps.activeSuppressionsFor.mockResolvedValue([{ id: 'sup-1' }]);
      const reserving = fakeDb({ marketing_email_ledger: [] });
      const handoff = fakeDb({ estimates: [MINTED_ROW], customers: [CUSTOMER] });
      expect(await guard(reserving)).toEqual({ reason: 'EMAIL_SUPPRESSED' });
      expect(await boundaryGuard(handoff)).toEqual({ reason: 'EMAIL_SUPPRESSED' });
      expect(deps.activeSuppressionsFor).toHaveBeenCalledWith(null, 'jordan@example.test', 'marketing_newsletter', reserving);
      expect(deps.activeSuppressionsFor).toHaveBeenLastCalledWith(null, 'jordan@example.test', 'marketing_newsletter', handoff);
    });

    test('no opt-out: both answer null, and the handoff guard reads the customer\'s preferences on its own transaction', async () => {
      const { guard, boundaryGuard } = await guardsOf();
      expect(await guard(fakeDb({ marketing_email_ledger: [] }))).toBeNull();
      const handoff = fakeDb({ estimates: [MINTED_ROW], customers: [CUSTOMER] });
      expect(await boundaryGuard(handoff)).toBeNull();
      expect(called(handoff.queriesOf('notification_prefs')[0], 'where', { customer_id: 'cust-1' })).toBe(true);
      // The 12-month rule is the reservation's: the handoff does not read the ledger again.
      expect(handoff.queriesOf('marketing_email_ledger')).toHaveLength(0);
    });

    test('inside the reservation the 12-month rule answers first', async () => {
      const { guard } = await guardsOf();
      const trx = fakeDb({ marketing_email_ledger: [{ id: 'led-0' }], notification_prefs: [{ marketing_offers: false }] });
      expect(await guard(trx)).toEqual({ reason: 'OFFERED_BEFORE' });
    });
  });

  // The email's button opens the estimate this run minted. The customer's next plan-start mint (a tap on another
  // plan option) archives it, so the handoff reads it again, under the customer-comms lock the mint takes.
  describe('the offer estimate at the provider handoff', () => {
    const handoffOf = async (change = {}) => {
      const deps = liveWorld();
      await run(deps);
      const trx = fakeDb({ estimates: [{ ...MINTED_ROW, ...change }], customers: [CUSTOMER] });
      return { boundaryGuard: sendOf(deps).boundaryGuard, trx };
    };
    const GONE = { reason: 'OFFER_ESTIMATE_GONE', retryable: true };

    test('a live estimate of this customer that carries this job\'s stamp lets the email go; read FOR SHARE after the lock', async () => {
      const { boundaryGuard, trx } = await handoffOf();
      expect(await boundaryGuard(trx)).toBeNull();
      const [read] = trx.queriesOf('estimates');
      expect(called(read, 'where', { id: 'est-1' })).toBe(true);
      expect(called(read, 'forShare')).toBe(true);
    });

    test.each([
      ['archived by the next mint', { archived_at: new Date('2030-03-13T03:31:00Z') }],
      ['expired', { expires_at: new Date(NOW.getTime() - 1000) }],
      ['another customer\'s', { customer_id: 'cust-2' }],
      ['carrying another job\'s stamp', { estimate_data: stamp('job-9') }],
      ['without a stamp', { estimate_data: {} }],
    ])('%s: the email does not leave, and the reservation settles retryable', async (_name, change) => {
      const { boundaryGuard, trx } = await handoffOf(change);
      expect(await boundaryGuard(trx)).toEqual(GONE);
    });

    test.each([['declined'], ['accepted']])('%s by the customer: final, never retried on a later morning', async (status) => {
      const { boundaryGuard, trx } = await handoffOf({ status });
      expect(await boundaryGuard(trx)).toEqual({ reason: 'OFFER_ESTIMATE_GONE', retryable: false });
    });

    test('a row that no longer exists: the same answer', async () => {
      const deps = liveWorld();
      await run(deps);
      expect(await sendOf(deps).boundaryGuard(fakeDb({ estimates: [] }))).toEqual(GONE);
    });

    test('the estimate is judged before the opt-outs, so a customer who opted out meanwhile is still read after the wait', async () => {
      const { boundaryGuard, trx } = await handoffOf({ archived_at: new Date(NOW) });
      expect(await boundaryGuard(trx)).toEqual(GONE);
      expect(trx.queriesOf('notification_prefs')).toHaveLength(0);
    });

    test('the ledger\'s refusal is a held job, not a failure; the next morning mints again', async () => {
      const deps = liveWorld({
        sendWithLedger: jest.fn(async () => ({ ok: false, sent: false, reason: 'OFFER_ESTIMATE_GONE', row: { id: 'led-1' }, duplicate: false })),
      });
      const summary = await run(deps);
      expect(summary).toMatchObject({ held: 1, failed: 0, sent: 0 });
      expect(summary.reasons).toEqual({ offer_estimate_gone: 1 });
    });
  });

  // The card policy alone does not refuse every customer who said no to Auto Pay (a paused one rides the rail
  // under GATE_PAF_EXISTING_CUSTOMERS; the resolver reads an explicit turn-off for plan members only).
  describe('Auto Pay paused or turned off on the account', () => {
    test.each([
      ['live', 'paused', { isAutopayPaused: jest.fn(() => true) }, 'autopay_paused'],
      ['live', 'turned off', { explicitAutopayDisable: jest.fn(async () => true) }, 'autopay_off'],
      ['shadow', 'paused', { isAutopayPaused: jest.fn(() => true) }, 'autopay_paused'],
      ['shadow', 'turned off', { explicitAutopayDisable: jest.fn(async () => true) }, 'autopay_off'],
    ])('%s, Auto Pay %s: held before the home is priced; no estimate, no email, no sample', async (mode, _state, change, reason) => {
      process.env.GATE_ONETIME_PLAN_OFFER = mode;
      const deps = liveWorld(change);
      const summary = await run(deps);
      expect(summary.reasons).toEqual({ [reason]: 1 });
      expect(summary.held).toBe(1);
      expect(deps.buildStartOffer).not.toHaveBeenCalled();
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
      expect(deps.sendTemplate).not.toHaveBeenCalled();
    });

    test('the card lane\'s own readers are asked about this customer, on the job\'s connection, with the run\'s clock', async () => {
      const deps = liveWorld();
      await run(deps);
      expect(deps.isAutopayPaused).toHaveBeenCalledWith(CUSTOMER, NOW);
      expect(deps.explicitAutopayDisable).toHaveBeenCalledWith(CUSTOMER, deps.db);
    });

    test('the rule runs after the card rail rule', async () => {
      const deps = liveWorld({
        isAutopayPaused: jest.fn(() => true),
        payAfterFirstVisitCardRail: jest.fn(() => false),
      });
      expect((await run(deps)).reasons).toEqual({ not_pay_after_visit: 1 });
    });

    test('a failed read fails the job, never "Auto Pay is on"', async () => {
      const deps = liveWorld({ explicitAutopayDisable: jest.fn(async () => { throw new Error('read failed'); }) });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, failed: 1 });
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
    });
  });

  // A failed send leaves the quote open; the customer can decline it before the next morning's retry.
  describe('the customer ended this job\'s offer estimate: the next morning never mints over it', () => {
    const ended = (rows) => (query) => (called(query, 'whereIn', 'status', ['declined', 'accepted']) ? rows : []);

    test.each([['live'], ['shadow']])('%s: a declined or accepted quote carrying this job\'s stamp holds the job', async (mode) => {
      process.env.GATE_ONETIME_PLAN_OFFER = mode;
      const deps = liveWorld({ tables: { estimates: ended([{ id: 'est-0' }]) } });
      const summary = await run(deps);
      expect(summary.reasons).toEqual({ offer_ended: 1 });
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test('the read: this customer\'s plan_start quotes in a final status, by the stamp\'s job id', async () => {
      const deps = liveWorld({ tables: { estimates: ended([]) } });
      await run(deps);
      const read = deps.db.queriesOf('estimates').find((query) => called(query, 'whereIn', 'status', ['declined', 'accepted']));
      expect(called(read, 'where', { customer_id: 'cust-1', source: 'plan_start' })).toBe(true);
      expect(called(read, 'whereRaw', "estimate_data->'planStart'->'offer'->>'jobId' = ?", ['job-1'])).toBe(true);
    });

    test('the mint asks again under the customer\'s locks: heldByOpenEstimate answers true for it', async () => {
      const { heldByOpenEstimate } = require('../services/onetime-plan-offer');
      const asked = { customerId: 'cust-1', jobId: 'job-1', now: NOW };
      expect(await heldByOpenEstimate(fakeDb({ estimates: ended([{ id: 'est-0' }]) }), asked)).toBe(true);
      expect(await heldByOpenEstimate(fakeDb({ estimates: ended([]) }), asked)).toBe(false);
    });
  });

  // GATE_ONETIME_PLAN_OFFER is the kill switch: a batch that began live stops when the owner turns it off.
  describe('the gate turned off during a live batch', () => {
    const JOB_2 = { ...JOB, id: 'job-2' };

    test('the next job is held and nothing more is minted or sent', async () => {
      const mint = jest.fn(async () => {
        process.env.GATE_ONETIME_PLAN_OFFER = 'off';
        return { estimateId: 'est-1', token: 'tok-1', url: '/estimate/tok-1', reused: false };
      });
      const deps = liveWorld({ jobs: [JOB, JOB_2], mintPlanStartEstimate: mint });
      const summary = await run(deps);
      expect(mint).toHaveBeenCalledTimes(1);
      expect(summary).toMatchObject({ jobs: 2, held: 1, failed: 0 });
      expect(summary.reasons).toEqual({ offer_gate_off: 1 });
    });

    test('the handoff reads the gate once more, the last read before the email leaves', async () => {
      const deps = liveWorld();
      await run(deps);
      const { boundaryGuard } = sendOf(deps);
      expect(await boundaryGuard(fakeDb({ estimates: [MINTED_ROW], customers: [CUSTOMER] }))).toBeNull();
      for (const value of ['off', 'shadow', undefined]) {
        if (value === undefined) delete process.env.GATE_ONETIME_PLAN_OFFER;
        else process.env.GATE_ONETIME_PLAN_OFFER = value;
        const trx = fakeDb({ estimates: [MINTED_ROW] });
        expect(await boundaryGuard(trx)).toEqual({ reason: 'OFFER_GATE_OFF', retryable: true });
        // The gate is read before anything is locked or read.
        expect(trx.queriesOf('estimates')).toHaveLength(0);
      }
    });

    test('the ledger\'s refusal is a held job, not a failure', async () => {
      const deps = liveWorld({
        sendWithLedger: jest.fn(async () => ({ ok: false, sent: false, reason: 'OFFER_GATE_OFF', row: { id: 'led-1' }, duplicate: false })),
      });
      const summary = await run(deps);
      expect(summary).toMatchObject({ held: 1, failed: 0, sent: 0 });
      expect(summary.reasons).toEqual({ offer_gate_off: 1 });
    });
  });

  // The customer can pause or turn off Auto Pay during the mint; the card policy asked about the estimate does not
  // refuse either, so the handoff asks the account again, on its own transaction.
  describe('Auto Pay at the provider handoff', () => {
    const handoffOf = async (change = {}) => {
      const deps = liveWorld(change);
      await run(deps);
      return { deps, boundaryGuard: sendOf(deps).boundaryGuard, trx: fakeDb({ estimates: [MINTED_ROW], customers: [CUSTOMER] }) };
    };

    test.each([
      ['paused', { isAutopayPaused: jest.fn((_account, _now) => false) }, 'AUTOPAY_PAUSED'],
      ['turned off', { explicitAutopayDisable: jest.fn(async () => false) }, 'AUTOPAY_OFF'],
    ])('Auto Pay %s since the job\'s own check: the email does not leave; retryable', async (_name, change, reason) => {
      const { deps, boundaryGuard, trx } = await handoffOf(change);
      // Same answers as the job's check (off), then the customer changes it before the handoff.
      if (reason === 'AUTOPAY_PAUSED') deps.isAutopayPaused.mockReturnValue(true);
      else deps.explicitAutopayDisable.mockResolvedValue(true);
      expect(await boundaryGuard(trx)).toEqual({ reason, retryable: true });
      expect(deps.isAutopayPaused).toHaveBeenLastCalledWith(CUSTOMER, NOW);
      expect(deps.explicitAutopayDisable).toHaveBeenLastCalledWith(CUSTOMER, reason === 'AUTOPAY_OFF' ? trx : expect.anything());
    });

    test('Auto Pay on: the handoff goes on; the account is read on the handoff transaction', async () => {
      const { deps, boundaryGuard, trx } = await handoffOf();
      expect(await boundaryGuard(trx)).toBeNull();
      expect(called(trx.queriesOf('customers')[0], 'where', { id: 'cust-1' })).toBe(true);
      // Read FOR SHARE: a pause that commits later waits for the end of the handoff transaction.
      expect(called(trx.queriesOf('customers')[0], 'forShare')).toBe(true);
      expect(deps.explicitAutopayDisable).toHaveBeenLastCalledWith(CUSTOMER, trx);
    });

    test('the estimate answers first, the opt-outs last', async () => {
      const { deps, boundaryGuard } = await handoffOf();
      deps.isAutopayPaused.mockReturnValue(true);
      deps.activeSuppressionsFor.mockResolvedValue([{ id: 'sup-1' }]);
      expect(await boundaryGuard(fakeDb({ estimates: [], customers: [CUSTOMER] }))).toMatchObject({ reason: 'OFFER_ESTIMATE_GONE' });
      expect(await boundaryGuard(fakeDb({ estimates: [MINTED_ROW], customers: [CUSTOMER] }))).toMatchObject({ reason: 'AUTOPAY_PAUSED' });
    });

    test('the ledger\'s refusal is a held job, not a failure', async () => {
      const deps = liveWorld({
        sendWithLedger: jest.fn(async () => ({ ok: false, sent: false, reason: 'AUTOPAY_OFF', row: { id: 'led-1' }, duplicate: false })),
      });
      const summary = await run(deps);
      expect(summary).toMatchObject({ held: 1, failed: 0, sent: 0 });
      expect(summary.reasons).toEqual({ autopay_off: 1 });
    });
  });

  // The confirmed send is recorded on the offer estimate (deliveryState), the stamp staff views and reports read.
  describe('the confirmed send on the estimate', () => {
    // The offer message is read twice in a live run: the job's own "already offered" check (nothing yet), then after
    // the send, for the provider's acceptance time.
    const MAIL_SENT_AT = '2030-03-13T03:31:00.000Z';
    const mailAfterSend = (row) => {
      let reads = 0;
      return () => { reads += 1; return reads === 1 ? [] : [row]; };
    };

    test('the receipt read asks for the estimate the message linked', async () => {
      const deps = liveWorld({ tables: { email_messages: mailAfterSend({ id: 'm-1', sent_at: MAIL_SENT_AT, estimate_id: 'est-1' }) } });
      await run(deps);
      const [alreadyOfferedRead] = deps.db.queriesOf('email_messages');
      expect(called(alreadyOfferedRead, 'first', 'id', 'sent_at', 'estimate_id')).toBe(true);
    });

    test('a send the provider took: recorded on the minted estimate, with the provider\'s acceptance time', async () => {
      const deps = liveWorld({ tables: { email_messages: mailAfterSend({ id: 'm-1', sent_at: MAIL_SENT_AT, estimate_id: 'est-1' }) } });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, sent: 1 });
      expect(deps.writeOfferDelivery).toHaveBeenCalledTimes(1);
      expect(deps.writeOfferDelivery).toHaveBeenCalledWith(deps.db, {
        customerId: 'cust-1', jobId: 'job-1', estimateId: 'est-1', deliveredAt: new Date(MAIL_SENT_AT),
      });
    });

    test('a send an earlier attempt owns and the ledger settled sent: recorded only when unstamped', async () => {
      const deps = liveWorld({
        tables: { email_messages: mailAfterSend({ id: 'm-1', sent_at: MAIL_SENT_AT, estimate_id: 'est-1' }) },
        sendWithLedger: jest.fn(async () => ({ ok: true, sent: false, reason: 'duplicate', row: { id: 'led-1', status: 'sent' }, duplicate: true })),
      });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, done: 1 });
      expect(deps.writeOfferDelivery).toHaveBeenCalledWith(deps.db, expect.objectContaining({ estimateId: 'est-1' }));
    });

    test('the estimate is the one the accepted message linked (an earlier attempt\'s), not this run\'s; a message with no link records nothing', async () => {
      const duplicate = jest.fn(async () => ({ ok: true, sent: false, reason: 'duplicate', row: { id: 'led-1', status: 'sent' }, duplicate: true }));
      const earlier = liveWorld({
        tables: { email_messages: mailAfterSend({ id: 'm-1', sent_at: MAIL_SENT_AT, estimate_id: 'est-0' }) }, sendWithLedger: duplicate,
      });
      await run(earlier);
      expect(earlier.writeOfferDelivery).toHaveBeenCalledWith(earlier.db, expect.objectContaining({ estimateId: 'est-0' }));
      const unlinked = liveWorld({ tables: { email_messages: mailAfterSend({ id: 'm-1', sent_at: MAIL_SENT_AT }) }, sendWithLedger: duplicate });
      await run(unlinked);
      expect(unlinked.writeOfferDelivery).not.toHaveBeenCalled();
    });

    test('a handoff that started and was lost (no acceptance time) is no confirmed delivery: nothing is recorded', async () => {
      const deps = liveWorld({
        tables: { email_messages: mailAfterSend({ id: 'm-1', provider_handoff_phase: 'started' }) },
        sendWithLedger: jest.fn(async () => ({ ok: true, sent: false, reason: 'duplicate', row: { id: 'led-1', status: 'sent' }, duplicate: true })),
      });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, done: 1 });
      expect(deps.writeOfferDelivery).not.toHaveBeenCalled();
    });

    test.each([
      ['a denied send', { sendWithLedger: jest.fn(async () => ({ ok: false, sent: false, reason: 'CAP_SAME_DAY', row: null, duplicate: false })) }],
      ['a duplicate still in flight', { sendWithLedger: jest.fn(async () => ({ ok: true, sent: false, reason: 'duplicate', row: { id: 'led-1', status: 'reserved' }, duplicate: true })) }],
    ])('%s: nothing is recorded', async (_name, change) => {
      const deps = liveWorld(change);
      await run(deps);
      expect(deps.writeOfferDelivery).not.toHaveBeenCalled();
    });

    test('a failed record never fails the job: the email is out', async () => {
      const deps = liveWorld({
        tables: { email_messages: mailAfterSend({ id: 'm-1', sent_at: MAIL_SENT_AT, estimate_id: 'est-1' }) },
        writeOfferDelivery: jest.fn(async () => { throw new Error('write failed'); }),
      });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, sent: 1 });
      expect(deps.writeOfferDelivery).toHaveBeenCalledTimes(1);
    });

    test('a failed read of the receipt never fails the job: the email is out', async () => {
      let reads = 0;
      const deps = liveWorld({ tables: { email_messages: () => { reads += 1; if (reads > 1) throw new Error('read failed'); return []; } } });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, sent: 1 });
      expect(deps.writeOfferDelivery).not.toHaveBeenCalled();
    });

    // The sweep: accepted offers whose estimate does not carry the delivery, whatever the job's own window says.
    describe('the daily sweep of accepted offers the estimate does not carry yet', () => {
      const SENT_AT = '2030-03-06T15:00:00.000Z';
      const message = (change = {}) => ({
        estimate_id: 'est-1', sent_at: SENT_AT, customer_id: 'cust-1', estimate_data: stamp('job-1'), ...change,
      });
      const sweepWorld = (rows, change = {}) => liveWorld({ jobs: [], tables: { 'email_messages as m': rows }, ...change });

      test('an accepted offer the estimate lacks is recorded on the estimate the email linked, with no job due', async () => {
        const deps = sweepWorld([message()]);
        expect((await run(deps)).jobs).toBe(0);
        expect(deps.writeOfferDelivery).toHaveBeenCalledWith(deps.db, {
          customerId: 'cust-1', jobId: 'job-1', estimateId: 'est-1', deliveredAt: new Date(SENT_AT),
        });
        expect(deps.sendWithLedger).not.toHaveBeenCalled();
        expect(deps.sendTemplate).not.toHaveBeenCalled();
      });

      test.each([
        ['already in the estimate\'s history', { estimate_data: { ...stamp('job-1'), deliveryState: { deliveredAt: [SENT_AT] } } }],
        ['an estimate with no offer stamp', { estimate_data: {} }],
      ])('%s: nothing is written', async (_name, change) => {
        const deps = sweepWorld([message(change)]);
        await run(deps);
        expect(deps.writeOfferDelivery).not.toHaveBeenCalled();
      });

      test('the read is bounded: this template, an accepted time inside 30 days, newest first, 200 at most, linked estimates only', async () => {
        const deps = sweepWorld([]);
        await run(deps);
        const [read] = deps.db.queriesOf('email_messages as m');
        expect(called(read, 'join', 'estimates as e', 'e.id', 'm.estimate_id')).toBe(true);
        expect(called(read, 'where', 'm.template_key', OFFER_TEMPLATE)).toBe(true);
        expect(called(read, 'whereNotNull', 'm.sent_at')).toBe(true);
        expect(called(read, 'where', 'm.sent_at', '>', new Date(NOW.getTime() - 30 * 24 * HOUR))).toBe(true);
        // Rows already recorded are filtered in SQL, before the limit.
        expect(read.calls.some(([method, sql]) => method === 'whereRaw' && String(sql).includes('jsonb_exists'))).toBe(true);
        expect(called(read, 'orderBy', 'm.sent_at', 'desc')).toBe(true);
        expect(called(read, 'limit', 200)).toBe(true);
      });

      test('shadow never runs it; a failed read never fails the run', async () => {
        process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
        const shadow = sweepWorld([message()]);
        await run(shadow);
        expect(shadow.db.queriesOf('email_messages as m')).toHaveLength(0);
        process.env.GATE_ONETIME_PLAN_OFFER = 'live';
        const failing = sweepWorld(() => { throw new Error('read failed'); });
        expect(await run(failing)).toMatchObject({ failed: 0 });
      });
    });

    test('an uncertain handoff (no accepted time) is not a confirmed delivery: nothing is recorded', async () => {
      const deps = liveWorld({ tables: { email_messages: [{ id: 'm-1', provider_handoff_phase: 'started' }] } });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, done: 1 });
      expect(deps.writeOfferDelivery).not.toHaveBeenCalled();
    });
  });

  // The email states the offer's dates from the day the run listed the job on. The mint reads the day again
  // under the customer's locks, and the estimate carries the mint's dates.
  describe('the estimate carries other dates than the email would state', () => {
    test.each([
      ['a later end date (a follow-up was completed in between)', { endsAt: '2030-04-07T03:59:59.999Z' }],
      ['another first visit day', { firstVisitFrom: '2030-05-23' }],
      ['no offer stamp at all', null],
    ])('%s: no email; the job is held, and the card rail is not asked about that estimate', async (_name, dates) => {
      const minted = dates ? mintedFor('job-1', dates) : { ...MINTED_ROW, estimate_data: {} };
      const deps = liveWorld({ minted });
      const summary = await run(deps);
      expect(liveCounts(summary)).toEqual({ ...ZERO, held: 1 });
      expect(summary.reasons).toEqual({ offer_day_moved: 1 });
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
      expect(deps.buildEstimateMembershipContext).not.toHaveBeenCalled();
    });

    test('the quote of another job is never this job\'s offer', async () => {
      const deps = liveWorld({ minted: mintedFor('job-9') });
      expect((await run(deps)).reasons).toEqual({ offer_day_moved: 1 });
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test('the same dates, stored as text: the email goes', async () => {
      const deps = liveWorld({ minted: { ...MINTED_ROW, estimate_data: JSON.stringify(stamp('job-1')) } });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, sent: 1 });
    });
  });

  describe('the mint refuses', () => {
    const refusal = (code) => Object.assign(new Error(`refused ${code}`), { code, restartUnavailable: true });
    test.each([
      ['pricing_unavailable', { office: 1 }, 'mint_pricing_unavailable'],
      ['not_eligible', { held: 1 }, 'not_eligible'],
      ['offer_changed', { held: 1 }, 'offer_changed'],
      ['busy', { held: 1 }, 'busy'],
      ['delivery_in_flight', { held: 1 }, 'delivery_in_flight'],
      // Another estimate opened between the job's own check and the mint's locks: the mint retires nothing.
      ['open_estimate', { held: 1 }, 'open_estimate'],
    ])('%s: counted and held under its own reason, no email', async (code, expected, reason) => {
      const deps = liveWorld({ mintPlanStartEstimate: jest.fn(async () => { throw refusal(code); }) });
      const summary = await run(deps);
      expect(liveCounts(summary)).toEqual({ ...ZERO, ...expected });
      expect(summary.reasons).toEqual({ [reason]: 1 });
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test.each([
      ['a refusal code the job does not know', refusal('a_code_added_later'), 'a_code_added_later'],
      // The mint throws a plain Error when the job is not this customer's due job: a bug in this job.
      ['a plain error (the mint says the job is not this customer\'s due job)', new Error('mintPlanStartEstimate offer needs a completed one-time pest job of this customer that is due its offer for 12 Example Test Ln'), 'none'],
      ['a database error', Object.assign(new Error('connection lost'), { code: 'ECONNRESET' }), 'ECONNRESET'],
    ])('%s fails the job: counted, logged by id and code only, read again the next morning', async (_name, error, code) => {
      // The first job's mint throws. The second job's mint answers.
      const mint = jest.fn()
        .mockRejectedValueOnce(error)
        .mockResolvedValue({ estimateId: 'est-1', token: 'tok-1', url: '/estimate/tok-1', reused: false });
      const deps = liveWorld({ jobs: [JOB, { ...JOB, id: 'job-2', customer_id: 'cust-2' }], mintPlanStartEstimate: mint, minted: mintedFor('job-2') });
      const summary = await run(deps);
      expect(liveCounts(summary)).toEqual({ ...ZERO, failed: 1, sent: 1 });
      // Only the second job's offer went out.
      expect(deps.sendWithLedger.mock.calls.map(([call]) => call.idempotencyKey)).toEqual(['onetime-plan-offer:offer:job-2']);
      expect(logger.warn.mock.calls[0][0]).toContain('job-1');
      expect(logger.warn.mock.calls[0][0]).toContain(`code=${code}`);
      expect(logger.warn.mock.calls[0][0]).not.toContain('Example Test Ln');
    });
  });

  describe('the email says "you pay after each visit": only for a customer on the card rail', () => {
    const ON_RAIL = { enforced: true, required: true, exemptReason: null };
    // The account alone, before any estimate exists: the customer the estimate will land on, no linked visit.
    const ACCOUNT_ASK = {
      estimate: { customer_id: 'cust-1' }, membership: null, useLinkedFallback: false, treatAsOneTime: false, billByInvoice: false, paymentMethodPreference: null,
    };

    test("the estimate page's own two functions are asked about the account first, then about the minted estimate row with the membership it derives", async () => {
      const membership = { isExistingCustomer: false };
      const deps = liveWorld({ buildEstimateMembershipContext: jest.fn(async () => membership) });
      await run(deps);
      expect(deps.resolveRecurringCardPolicyForEstimate.mock.calls.map(([ask]) => ask)).toEqual([
        ACCOUNT_ASK,
        { estimate: MINTED_ROW, membership, treatAsOneTime: false, billByInvoice: false, paymentMethodPreference: null },
      ]);
      expect(deps.buildEstimateMembershipContext).toHaveBeenCalledTimes(1);
      expect(deps.buildEstimateMembershipContext).toHaveBeenCalledWith(MINTED_ROW);
      expect(deps.payAfterFirstVisitCardRail.mock.calls).toEqual([[ON_RAIL], [ON_RAIL]]);
    });

    test.each([
      ['a payer-billed account', { enforced: true, required: false, exemptReason: 'payer_billed' }],
      ['Auto Pay paused', { enforced: true, required: false, exemptReason: 'autopay_paused' }],
      ['the card lane or the pay-after gate off', { enforced: false, required: false, exemptReason: 'feature_disabled' }],
    ])('%s: held before the home is priced: no estimate and no email', async (_name, policy) => {
      // The answer of the real rail function for that policy: only a captured or enrolled card is on the rail.
      const deps = liveWorld({
        resolveRecurringCardPolicyForEstimate: jest.fn(async () => policy),
        payAfterFirstVisitCardRail: jest.fn(() => false),
      });
      const summary = await run(deps);
      expect(liveCounts(summary)).toEqual({ ...ZERO, held: 1 });
      expect(summary.reasons).toEqual({ not_pay_after_visit: 1 });
      expect(deps.buildStartOffer).not.toHaveBeenCalled();
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    // Shadow holds the same customers: a sample tells the office "this customer would get the offer today".
    test('shadow asks the same question about the account: off the rail is held and no sample goes to the office', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      const deps = liveWorld({ payAfterFirstVisitCardRail: jest.fn(() => false) });
      const summary = await run(deps);
      expect(counts(summary)).toEqual({ ...NONE, held: 1 });
      expect(summary.reasons).toEqual({ not_pay_after_visit: 1 });
      expect(deps.resolveRecurringCardPolicyForEstimate).toHaveBeenCalledWith(ACCOUNT_ASK);
      expect(deps.sendTemplate).not.toHaveBeenCalled();
      // On the rail, the sample goes as before, and shadow never asks about an estimate (it makes none).
      const onRail = liveWorld();
      expect(counts(await run(onRail))).toEqual({ ...NONE, sample: 1 });
      expect(onRail.resolveRecurringCardPolicyForEstimate).toHaveBeenCalledTimes(1);
    });

    test('the rule runs with the money rules: after "the job is paid", before the review ask', async () => {
      const offRail = { payAfterFirstVisitCardRail: jest.fn(() => false) };
      expect((await run(liveWorld({ ...offRail, tables: { 'invoices as i': [] } }))).reasons).not.toHaveProperty('not_pay_after_visit');
      expect((await run(liveWorld({ ...offRail, reviewAskOnItsWay: jest.fn(async () => true) }))).reasons).toEqual({ not_pay_after_visit: 1 });
    });

    test('on the rail as an account, off it as the estimate (a visit linked to the estimate is billed to a payer): the quote stays, no email', async () => {
      const deps = liveWorld({ payAfterFirstVisitCardRail: jest.fn().mockReturnValueOnce(true).mockReturnValue(false) });
      const summary = await run(deps);
      expect(liveCounts(summary)).toEqual({ ...ZERO, held: 1 });
      expect(summary.reasons).toEqual({ not_pay_after_visit: 1 });
      expect(deps.mintPlanStartEstimate).toHaveBeenCalledTimes(1);
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test('the rail function must say exactly true: any other answer is no email', async () => {
      const deps = liveWorld({ payAfterFirstVisitCardRail: jest.fn(() => undefined) });
      expect((await run(deps)).reasons).toEqual({ not_pay_after_visit: 1 });
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test.each([
      ['the policy read throws', { resolveRecurringCardPolicyForEstimate: jest.fn(async () => { throw Object.assign(new Error('read failed'), { code: 'POLICY_DOWN' }); }) }, 'POLICY_DOWN'],
      ['the policy read throws for the estimate', {
        resolveRecurringCardPolicyForEstimate: jest.fn().mockResolvedValueOnce(ON_RAIL).mockRejectedValue(Object.assign(new Error('read failed'), { code: 'POLICY_DOWN_2' })),
      }, 'POLICY_DOWN_2'],
      ['the membership read throws', { buildEstimateMembershipContext: jest.fn(async () => { throw Object.assign(new Error('read failed'), { code: 'MEMBERSHIP_DOWN' }); }) }, 'MEMBERSHIP_DOWN'],
      ['the minted estimate cannot be read', { tables: { estimates: [] } }, 'ESTIMATE_MISSING'],
    ])('%s: the job fails, never "not on the card rail"', async (_name, change, code) => {
      const deps = liveWorld(change);
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, failed: 1 });
      expect(logger.warn.mock.calls[0][0]).toContain(`code=${code}`);
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });
  });

  describe('what the ledger answers', () => {
    const answer = (out, ledgerRow) => liveWorld({
      sendWithLedger: jest.fn(async () => out),
      // The one-per-12-months rule reads this table too, and finds nothing. The settled status is read by id.
      ...(ledgerRow ? { tables: { marketing_email_ledger: (query) => (called(query, 'where', { id: ledgerRow.id }) ? [ledgerRow] : []) } } : {}),
    });

    test.each([
      ['sent', { ok: true, sent: true, reason: null, row: { id: 'led-1' }, duplicate: false }, { sent: 1 }, null],
      ['duplicate: an earlier attempt owns the send', { ok: true, sent: false, reason: 'duplicate', row: { id: 'led-1' }, duplicate: true }, { done: 1 }, null],
      ['duplicate of a sent row: the offer went out on an earlier morning', { ok: true, sent: false, reason: 'duplicate', row: { id: 'led-1', status: 'sent' }, duplicate: true }, { done: 1 }, null],
      // The ledger never sends a skipped key again. Counting it "done" would report an offer that no one got.
      ['duplicate of a skipped row: no offer went out, and none will', { ok: true, sent: false, reason: 'duplicate', row: { id: 'led-1', status: 'skipped' }, duplicate: true }, { held: 1 }, 'send_dropped'],
      ['duplicate of a reserved row: a send in flight, or one a crash left', { ok: true, sent: false, reason: 'duplicate', row: { id: 'led-1', status: 'reserved' }, duplicate: true }, { held: 1 }, 'send_in_flight'],
      ['denied: the same-day cap', { ok: false, sent: false, reason: 'CAP_SAME_DAY', row: null, duplicate: false }, { held: 1 }, 'cap_same_day'],
      ['denied: the customer opted out since', { ok: false, sent: false, reason: 'EMAIL_SUPPRESSED_GROUP', row: null, duplicate: false }, { held: 1 }, 'email_suppressed_group'],
      ['denied: the address changed', { ok: false, sent: false, reason: 'RECIPIENT_CHANGED', row: null, duplicate: false }, { held: 1 }, 'recipient_changed'],
      ['denied: the one-per-12-months guard', { ok: false, sent: false, reason: 'OFFERED_BEFORE', row: null, duplicate: false }, { held: 1 }, 'offered_before'],
      ['denied with no reason', { ok: false, sent: false, reason: undefined, row: null, duplicate: false }, { held: 1 }, 'email_not_allowed'],
    ])('%s', async (_name, out, expected, reason) => {
      const summary = await run(answer(out));
      expect(liveCounts(summary)).toEqual({ ...ZERO, ...expected });
      expect(summary.reasons).toEqual(reason ? { [reason]: 1 } : {});
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test('a denial is never thrown, and the quote is not undone: the mint ran once and nothing else was written', async () => {
      const deps = answer({ ok: false, sent: false, reason: 'CAP_SAME_DAY', row: null, duplicate: false });
      await run(deps);
      expect(deps.mintPlanStartEstimate).toHaveBeenCalledTimes(1);
    });

    test('the division could not read: an outage, not a rule: the job fails', async () => {
      const summary = await run(answer({ ok: false, sent: false, reason: 'LOOKUP_FAILED', row: null, duplicate: false }));
      expect(liveCounts(summary)).toEqual({ ...ZERO, failed: 1 });
      expect(logger.warn.mock.calls[0][0]).toContain('code=LOOKUP_FAILED');
    });

    test.each([
      // A reservation was made. Its settled status says what happened (the executor reads it the same way).
      ['a provider or library failure the ledger settled failed', { ok: false, sent: false, reason: 'dispatch_failed', row: { id: 'led-1' }, duplicate: false, error: new Error('provider down') }, { id: 'led-1', status: 'failed' }, { failed: 1 }, null],
      ['an abort before the provider, settled failed', { ok: false, sent: false, reason: 'aborted', row: { id: 'led-1' }, duplicate: false }, { id: 'led-1', status: 'failed' }, { failed: 1 }, null],
      ['an email the provider took, or may have (the ledger completed the row as sent)', { ok: false, sent: false, reason: 'ALREADY_DISPATCHED', row: { id: 'led-1' }, duplicate: false }, { id: 'led-1', status: 'sent' }, { done: 1 }, null],
      ['a refusal at the provider boundary, settled skipped', { ok: false, sent: false, reason: 'EMAIL_SWITCH_OFF', row: { id: 'led-1' }, duplicate: false }, { id: 'led-1', status: 'skipped' }, { held: 1 }, 'email_switch_off'],
      ["the job's own opt-out guard at the provider boundary, settled skipped", { ok: false, sent: false, reason: 'OFFERS_OFF', row: { id: 'led-1' }, duplicate: false }, { id: 'led-1', status: 'skipped' }, { held: 1 }, 'offers_off'],
    ])('%s', async (_name, out, ledgerRow, expected, reason) => {
      const summary = await run(answer(out, ledgerRow));
      expect(liveCounts(summary)).toEqual({ ...ZERO, ...expected });
      expect(summary.reasons).toEqual(reason ? { [reason]: 1 } : {});
    });

    test('a failed send is read again the next morning under the same key, with the same quote reused', async () => {
      const failed = { ok: false, sent: false, reason: 'dispatch_failed', row: { id: 'led-1' }, duplicate: false, error: new Error('provider down') };
      const first = answer(failed, { id: 'led-1', status: 'failed' });
      expect(liveCounts(await run(first))).toEqual({ ...ZERO, failed: 1 });
      // The next morning: the job's own quote is on file (it does not hold the job), and the key is the same.
      const second = liveWorld({ existing: [{ id: 'est-1', estimate_data: stamp('job-1') }] });
      expect(liveCounts(await run(second))).toEqual({ ...ZERO, sent: 1 });
      expect(sendOf(second).idempotencyKey).toBe(sendOf(first).idempotencyKey);
    });
  });

  test('a job that throws never stops the next one: the second customer still gets the offer', async () => {
    const deps = liveWorld({
      jobs: [JOB, { ...JOB, id: 'job-2', customer_id: 'cust-2' }],
      minted: mintedFor('job-2'),
      buildStartOffer: jest.fn(async (customerId) => {
        if (customerId === 'cust-1') throw Object.assign(new Error('no parcel for 12 Example Test Ln'), { code: 'PRICING_UNAVAILABLE' });
        return { option: { ...LIVE_OPTION }, reason: null };
      }),
    });
    const summary = await run(deps);
    expect(liveCounts(summary)).toEqual({ ...ZERO, failed: 1, sent: 1 });
    expect(deps.sendWithLedger.mock.calls.map(([call]) => call.idempotencyKey)).toEqual(['onetime-plan-offer:offer:job-2']);
  });

  describe('a home the app cannot price: one office item (live only)', () => {
    test('the office item names the job, the customer, the offer day and the reason; no estimate and no email', async () => {
      const deps = liveWorld({ buildStartOffer: jest.fn(async () => ({ option: null, reason: 'not_priced' })) });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, office: 1 });
      expect(deps.raiseOfficeItem).toHaveBeenCalledTimes(1);
      expect(deps.raiseOfficeItem).toHaveBeenCalledWith({
        job: expect.objectContaining({ id: 'job-1' }), customer: expect.objectContaining({ id: 'cust-1' }), offerDay: '2030-03-05', reason: 'not_priced',
      });
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test.each([['commercial'], ['not_live'], ['has_plan']])('the pricer answers premises for a %s account: held, no item', async (blocker) => {
      const deps = liveWorld({
        buildStartOffer: jest.fn(async () => ({ option: null, reason: 'premises' })),
        planStartBlocker: jest.fn(async () => blocker),
      });
      const summary = await run(deps);
      expect(liveCounts(summary)).toEqual({ ...ZERO, held: 1 });
      expect(summary.reasons).toEqual({ [blocker]: 1 });
      expect(deps.raiseOfficeItem).not.toHaveBeenCalled();
    });

    test.each([['commercial'], ['has_plan']])('the pricer answers %s on a rerun: the job\'s earlier office item closes', async (reason) => {
      const deps = liveWorld({ buildStartOffer: jest.fn(async () => ({ option: null, reason })) });
      await run(deps);
      expect(deps.closeOfficeItem.mock.calls.map(([arg]) => [arg.jobId, arg.resolution]))
        .toEqual([[JOB.id, reason === 'commercial' ? 'The account reads as commercial' : 'The customer has a plan now']]);
      expect(deps.raiseOfficeItem).not.toHaveBeenCalled();
    });

    test('shadow reads premises as live does: an account the proof refuses is held, not counted for the office', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      const deps = liveWorld({
        buildStartOffer: jest.fn(async () => ({ option: null, reason: 'premises' })),
        planStartBlocker: jest.fn(async () => 'commercial'),
      });
      const summary = await run(deps);
      expect(summary.office).toBe(0);
      expect(summary.reasons).toEqual({ commercial: 1 });
    });

    test('premises for an address the app cannot prove: the office item, with its own words', async () => {
      const deps = liveWorld({ buildStartOffer: jest.fn(async () => ({ option: null, reason: 'premises' })) });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, office: 1 });
      expect(deps.planStartBlocker).toHaveBeenCalledWith(deps.db, 'cust-1');
      expect(deps.raiseOfficeItem.mock.calls[0][0].reason).toBe('premises');
    });

    test('a mint that cannot price the estimate on the server raises it too', async () => {
      const deps = liveWorld({
        mintPlanStartEstimate: jest.fn(async () => { throw Object.assign(new Error('hand'), { restartUnavailable: true, code: 'pricing_unavailable' }); }),
      });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, office: 1 });
      expect(deps.raiseOfficeItem.mock.calls[0][0].reason).toBe('mint_pricing_unavailable');
    });

    test('a held job and a sent offer raise none', async () => {
      const held = liveWorld({ tables: { notification_prefs: [{ marketing_offers: false }] } });
      await run(held);
      const sent = liveWorld();
      await run(sent);
      expect(held.raiseOfficeItem).not.toHaveBeenCalled();
      expect(sent.raiseOfficeItem).not.toHaveBeenCalled();
    });

    test('a failed write fails the job, so the next morning raises it again', async () => {
      const deps = liveWorld({
        buildStartOffer: jest.fn(async () => ({ option: null, reason: 'not_priced' })),
        raiseOfficeItem: jest.fn(async () => { throw Object.assign(new Error('db'), { code: 'ECONNRESET' }); }),
      });
      expect(liveCounts(await run(deps))).toEqual({ ...ZERO, failed: 1 });
    });

    test('shadow raises none: the office gets no item, as before', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      const deps = liveWorld({ buildStartOffer: jest.fn(async () => ({ option: null, reason: 'not_priced' })) });
      expect(counts(await run(deps))).toEqual({ ...NONE, office: 1 });
      expect(deps.raiseOfficeItem).not.toHaveBeenCalled();
    });
  });

  describe('the office item itself', () => {
    let notifyAdmin;
    beforeEach(() => {
      notifyAdmin = jest.spyOn(require('../services/notification-service'), 'notifyAdmin').mockResolvedValue({ id: 'n-1' });
    });
    afterEach(() => notifyAdmin.mockRestore());

    test('one row per job for a person: who, what to do, the customer link, the offer\'s last day', async () => {
      await _test.defaultDeps().raiseOfficeItem({ job: JOB, customer: CUSTOMER, offerDay: '2030-03-05', reason: 'plan_not_below_job' });
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      const [category, headline, why, options] = notifyAdmin.mock.calls[0];
      expect([category, headline]).toEqual(['estimate', 'Estimates — quote Jordan Example the plan by hand']);
      expect(why).toBe('Their one-time pest job was done Tue, Mar 5, and the app cannot price the plan offer.');
      expect(options).toMatchObject({
        link: '/admin/estimates?tab=new&customerId=cust-1',
        dedupeKey: _test.officeItemKey('job-1'),
        bell: true,
        metadata: {
          source: 'onetime-plan-offer', kind: 'plan_offer_office', customerId: 'cust-1', jobId: 'job-1', lastDay: '2030-04-04',
          reason: 'plan_not_below_job', area: 'Estimates', severity: 'needs-you', who: 'person', doneWhen: 'plan_offer_quoted',
          subject: { type: 'customer', id: 'cust-1' },
        },
      });
      // Raised once per job: a done row keeps its key, so a later morning never raises a second one. A later morning
      // with other terms (a moved offer day) rewrites the one row quietly.
      expect(options).not.toHaveProperty('dedupeOpenOnly');
      expect(options.refreshOnDedupe).toBe(true);
      expect(options.ringOnRefresh()).toBe(false);
      expect(options.detail).toContain('not below what the one-time job cost');
      expect(options.detail).toContain('good through Thu, Apr 4');
      expect(options.detail).toContain('No email went to the customer.');
    });

    test.each([
      ['premises', 'Check the account first'],
      ['not_priced', 'no saved home size'],
      ['some_new_reason', 'no saved home size'],
    ])('reason %s: its own words in the detail', async (reason, words) => {
      await _test.defaultDeps().raiseOfficeItem({ job: JOB, customer: CUSTOMER, offerDay: '2030-03-05', reason });
      expect(notifyAdmin.mock.calls[0][3].detail).toContain(words);
    });

    test('a write that returns no row throws', async () => {
      notifyAdmin.mockResolvedValue(null);
      await expect(_test.defaultDeps().raiseOfficeItem({ job: JOB, customer: CUSTOMER, offerDay: '2030-03-05', reason: 'not_priced' }))
        .rejects.toMatchObject({ code: 'OFFICE_ITEM_FAILED' });
    });
  });

  describe('the office item closes by itself', () => {
    let closeKeys;
    beforeEach(() => {
      closeKeys = jest.spyOn(require('../services/admin-alert-episodes'), 'closeAdminAlertKeys').mockResolvedValue(1);
    });
    afterEach(() => closeKeys.mockRestore());
    const item = (jobId, meta) => ({
      id: `n-${jobId}`, created_at: '2030-03-08T14:00:00Z', metadata: { dedupeKey: _test.officeItemKey(jobId), customerId: 'cust-1', ...meta },
    });

    test('when the offer has ended, or the customer has an estimate made after the item; otherwise it stays', async () => {
      const deps = liveWorld({
        jobs: [],
        tables: {
          notifications: [item('ended', { lastDay: '2030-03-11' }), item('quoted', { lastDay: '2030-04-04', customerId: 'cust-q' }), item('open', { lastDay: '2030-04-04' })],
          estimates: (query) => (called(query, 'where', { customer_id: 'cust-q' }) ? [{ id: 'est-new' }] : []),
        },
      });
      await run(deps);
      expect(closeKeys.mock.calls.map(([, keys, reason, opts]) => [keys, reason, opts.resolution])).toEqual([
        [[_test.officeItemKey('ended')], 'plan_offer_quoted', 'The plan offer ended'],
        [[_test.officeItemKey('quoted')], 'plan_offer_quoted', 'The customer has a new estimate'],
      ]);
      const [read] = deps.db.queriesOf('estimates');
      expect(called(read, 'where', 'created_at', '>', '2030-03-08T14:00:00Z')).toBe(true);
    });

    test.each([
      ['turned off offers', { notification_prefs: [{ marketing_offers: false }] }, 'The customer turned off offers'],
      ['is no longer a customer', { customers: [] }, 'The customer is no longer active'],
      ['was made inactive', { customers: [{ ...CUSTOMER, active: false }] }, 'The customer is no longer active'],
    ])('the customer %s: the instruction is withdrawn', async (_name, change, resolution) => {
      const deps = liveWorld({
        jobs: [],
        tables: { notifications: [item('open', { lastDay: '2030-04-04' })], estimates: [], ...change },
      });
      await run(deps);
      expect(closeKeys.mock.calls.map(([, keys, , opts]) => [keys, opts.resolution])).toEqual([[[_test.officeItemKey('open')], resolution]]);
    });

    test.each([
      ['staff do-not-contact', 'STAFF_DNC'],
      ['email turned off for the customer', 'EMAIL_SWITCH_OFF'],
      ['a suppression of the address', 'EMAIL_SUPPRESSED_GLOBAL'],
    ])('the email division says %s: the instruction is withdrawn', async (_name, reason) => {
      // The item's job still qualifies (the run also holds it today, by the same verdict).
      const deps = liveWorld({
        tables: { notifications: [item('open', { lastDay: '2030-04-04', jobId: 'job-1' })], estimates: [] },
        ...emailVerdict(reason),
      });
      await run(deps);
      expect(closeKeys.mock.calls.map(([, keys, , opts]) => [keys, opts.resolution])).toEqual([[[_test.officeItemKey('open')], 'The customer may not be contacted']]);
      expect(deps.eligibleForEmail).toHaveBeenCalledWith(expect.objectContaining({ customerId: 'cust-1', emailKey: OFFER_TEMPLATE, completedVisitId: 'job-1' }));
    });

    test.each([['the same-day cap', 'CAP_SAME_DAY'], ['a failed read', 'LOOKUP_FAILED']])('%s is "not today": the item stays', async (_name, reason) => {
      const deps = liveWorld({
        jobs: [],
        tables: { notifications: [item('open', { lastDay: '2030-04-04' })], estimates: [] },
        ...emailVerdict(reason),
      });
      await run(deps);
      expect(closeKeys).not.toHaveBeenCalled();
    });

    test.each([
      ['in shadow', 'shadow', {}],
      ['while the offer template is not published', 'live', { resolveTemplateForSend: jest.fn(async () => { throw Object.assign(new Error('draft'), { code: 'EMAIL_TEMPLATE_DISABLED' }); }) }],
    ])('the close runs %s too', async (_name, mode, change) => {
      process.env.GATE_ONETIME_PLAN_OFFER = mode;
      const deps = liveWorld({ jobs: [], tables: { notifications: [item('ended', { lastDay: '2030-03-11' })] }, ...change });
      await run(deps);
      expect(closeKeys.mock.calls.map(([, keys]) => keys)).toEqual([[_test.officeItemKey('ended')]]);
    });

    test('a live run closes after its jobs: a home priced today is not judged on yesterday', async () => {
      const order = [];
      closeKeys.mockImplementation(async () => { order.push('close'); return 1; });
      const deps = liveWorld({
        tables: { notifications: [item('ended', { lastDay: '2030-03-11' })] },
        sendWithLedger: jest.fn(async () => { order.push('send'); return { ok: true, sent: true, row: { id: 'led-1' }, duplicate: false }; }),
      });
      await run(deps);
      expect(order).toEqual(['send', 'close']);
    });

    test('a job whose offer day moved refreshes its item before the close reads the last day', async () => {
      const order = [];
      closeKeys.mockImplementation(async () => { order.push('close'); return 1; });
      const deps = liveWorld({
        buildStartOffer: jest.fn(async () => ({ option: null, reason: 'not_priced' })),
        raiseOfficeItem: jest.fn(async () => { order.push('raise'); return { id: 'n-1' }; }),
        tables: { notifications: [item('ended', { lastDay: '2030-03-11' })] },
      });
      await run(deps);
      expect(order).toEqual(['raise', 'close']);
    });

    test.each([
      ['a follow-up moved the offer day: the stored day has passed, the current one has not', '2030-03-05', 0],
      ['the current day has passed too', '2030-02-01', 1],
    ])('the last day is the job\'s current one: %s', async (_name, serviceDay, closes) => {
      const deps = liveWorld({
        jobs: [{ ...JOB, service_day: serviceDay }],
        buildStartOffer: jest.fn(async () => ({ option: null, reason: 'has_plan' })),
        tables: { notifications: [item('job-1', { lastDay: '2030-03-01', jobId: 'job-1' })], estimates: [] },
      });
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      await run(deps);
      expect(closeKeys).toHaveBeenCalledTimes(closes);
      const read = deps.db.queriesOf('scheduled_services as s').find((query) => called(query, 'where', 's.id', 'job-1'));
      expect(read).toBeDefined();
    });

    test('an item that stays open with a moved offer day is rewritten with the current terms, quietly', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      const deps = liveWorld({
        buildStartOffer: jest.fn(async () => ({ option: null, reason: 'has_plan' })),
        tables: { notifications: [item('job-1', { lastDay: '2030-03-20', jobId: 'job-1', reason: 'not_priced' })], estimates: [] },
      });
      await run(deps);
      expect(closeKeys).not.toHaveBeenCalled();
      expect(deps.raiseOfficeItem).toHaveBeenCalledWith({
        job: { id: 'job-1' }, customer: expect.objectContaining({ id: 'cust-1', first_name: 'Jordan' }), offerDay: '2030-03-05', reason: 'not_priced',
      });
    });

    test('the customer has a plan now: the item is withdrawn, never rewritten with a later deadline', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      const deps = liveWorld({
        buildStartOffer: jest.fn(async () => ({ option: null, reason: 'has_plan' })),
        planStartBlocker: jest.fn(async () => 'has_plan'),
        tables: { notifications: [item('job-1', { lastDay: '2030-03-20', jobId: 'job-1', reason: 'not_priced' })], estimates: [] },
      });
      await run(deps);
      expect(closeKeys.mock.calls.map(([, keys, , opts]) => [keys, opts.resolution])).toEqual([[[_test.officeItemKey('job-1')], 'The customer has a plan now']]);
      expect(deps.raiseOfficeItem).not.toHaveBeenCalled();
    });

    test.each([
      ['commercial', 'The account reads as commercial'],
      ['not_live', 'The customer is no longer active'],
    ])('the pricer\'s account proof answers %s: the item is withdrawn', async (blocker, resolution) => {
      const deps = liveWorld({
        planStartBlocker: jest.fn(async () => blocker),
        tables: { notifications: [item('job-1', { lastDay: '2030-04-04', jobId: 'job-1' })], estimates: [] },
      });
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      await run(deps);
      expect(closeKeys.mock.calls.map(([, , , opts]) => opts.resolution)).toEqual([resolution]);
      expect(deps.planStartBlocker).toHaveBeenCalledWith(deps.db, 'cust-1');
    });

    test('the default proof is the pricer\'s own planStartBlocker', async () => {
      const eligibility = require('../services/plan-start-eligibility');
      const spy = jest.spyOn(eligibility, 'planStartBlocker').mockResolvedValue('has_plan');
      try {
        expect(await _test.defaultDeps().planStartBlocker('db', 'cust-1')).toBe('has_plan');
        expect(spy).toHaveBeenCalledWith('db', 'cust-1');
      } finally {
        spy.mockRestore();
      }
    });

    test('an opt-out closes the item even when the plan proof fails', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      const deps = liveWorld({
        planStartBlocker: jest.fn(async () => { throw new Error('bad json'); }),
        ...emailVerdict('STAFF_DNC'),
        tables: { notifications: [item('job-1', { lastDay: '2030-04-04', jobId: 'job-1' })], estimates: [] },
      });
      await run(deps);
      expect(closeKeys.mock.calls.map(([, , , opts]) => opts.resolution)).toEqual(['The customer may not be contacted']);
      expect(deps.planStartBlocker).not.toHaveBeenCalled();
    });

    test('one item that fails never stops the others', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      const deps = liveWorld({
        planStartBlocker: jest.fn(async (_db, customerId) => {
          if (customerId === 'cust-bad') throw new Error('db');
          return 'has_plan';
        }),
        tables: {
          notifications: [item('bad', { lastDay: '2030-04-04', customerId: 'cust-bad' }), item('good', { lastDay: '2030-04-04' })],
          estimates: [],
        },
      });
      await run(deps);
      expect(closeKeys.mock.calls.map(([, keys]) => keys)).toEqual([[_test.officeItemKey('good')]]);
    });

    test('an item whose terms are current is not rewritten', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      const deps = liveWorld({
        buildStartOffer: jest.fn(async () => ({ option: null, reason: 'has_plan' })),
        tables: { notifications: [item('job-1', { lastDay: '2030-04-04', jobId: 'job-1' })], estimates: [] },
      });
      await run(deps);
      expect(deps.raiseOfficeItem).not.toHaveBeenCalled();
    });

    test('the job no longer qualifies for this customer: the item is withdrawn', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      const deps = liveWorld({
        tables: {
          'scheduled_services as s': (query) => (called(query, 'where', 's.id', 'job-1') ? [] : [JOB]),
          notifications: [item('job-1', { lastDay: '2030-04-04', jobId: 'job-1' })],
          estimates: [],
        },
      });
      await run(deps);
      expect(closeKeys.mock.calls.map(([, keys, , opts]) => [keys, opts.resolution]))
        .toEqual([[[_test.officeItemKey('job-1')], 'The one-time job no longer qualifies for the offer']]);
      const read = deps.db.queriesOf('scheduled_services as s').find((query) => called(query, 'where', 's.id', 'job-1'));
      expect(called(read, 'where', 's.customer_id', 'cust-1')).toBe(true);
    });

    test('off reads nothing', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'off';
      const deps = liveWorld({ tables: { notifications: [item('ended', { lastDay: '2030-03-11' })] } });
      await run(deps);
      expect(deps.db.queries).toHaveLength(0);
      expect(closeKeys).not.toHaveBeenCalled();
    });

    test('a failed read never fails the run', async () => {
      const deps = liveWorld({ tables: { notifications: () => { throw new Error('db'); } } });
      expect((await run(deps)).sent).toBe(1);
    });
  });

  describe('the day-21 reminder', () => {
    // Offer day February 19: day 21 is March 12, the run's ET day. Good through March 21 (it ends when March 22
    // starts in ET, after the clocks went forward), next visit from May 7.
    const RJOB = { id: 'job-r', customer_id: 'cust-1', service_day: '2030-02-19', job_day: '2030-02-19' };
    const OFFER_ROW = { estimate_id: 'est-r', payload_snapshot: { price_per_application: '$104.50', estimate_url: 'https://old.test' } };
    const ESTIMATE = {
      id: 'est-r', customer_id: 'cust-1', source: 'plan_start', status: 'viewed', token: 'tok-r', archived_at: null, expires_at: null,
      estimate_data: stamp('job-r', { endsAt: '2030-03-22T03:59:59.999Z', firstVisitFrom: '2030-05-07' }),
    };
    const messages = ({ reminded = [], offered = [OFFER_ROW] } = {}) => (query) => (
      called(query, 'where', { idempotency_key: _test.reminderKey('job-r') }) ? reminded
        : called(query, 'where', { idempotency_key: 'onetime-plan-offer:offer:job-r' }) ? offered : []);
    const reminderEstimates = (row = ESTIMATE) => (query) => {
      if (called(query, 'where', { id: 'est-r' })) return [row];
      return called(query, 'whereIn', 'status', ['declined', 'accepted']) ? [] : [row];
    };
    const remindWorld = ({ estimate = ESTIMATE, mail = {}, tables = {}, ...deps } = {}) => liveWorld({
      jobs: [],
      reminderJobs: [RJOB],
      tables: { email_messages: messages(mail), estimates: reminderEstimates(estimate), ...tables },
      ...deps,
    });
    const reminderOf = (summary) => summary.reminder;
    const R0 = { jobs: 1, sent: 0, held: 0, done: 0, failed: 0 };

    test('sends one reminder through the ledger: its own key, the offer\'s estimate, the price the offer stated', async () => {
      const deps = remindWorld();
      const summary = await run(deps);
      expect(reminderOf(summary)).toEqual({ ...R0, sent: 1, reasons: {} });
      expect(deps.sendWithLedger).toHaveBeenCalledTimes(1);
      const call = sendOf(deps);
      expect(call).toEqual({
        customerId: 'cust-1',
        stream: 'nurture',
        marketingClass: 'marketing',
        emailKey: REMINDER_TEMPLATE,
        idempotencyKey: 'onetime-plan-offer:reminder:job-r',
        now: NOW,
        expectedRecipientEmail: 'jordan@example.test',
        guard: expect.any(Function),
        boundaryGuard: expect.any(Function),
        template: {
          templateKey: REMINDER_TEMPLATE, payload: expect.any(Object), categories: ['onetime_plan_offer_reminder'], linkEstimateId: 'est-r',
        },
      });
      expect(Object.keys(call.template.payload)).toEqual(TEMPLATE_VARIABLES[REMINDER_TEMPLATE]);
      // The link is the estimate's own, never the snapshot's.
      expect(call.template.payload).toEqual({
        first_name: 'Jordan', price_per_application: '$104.50', offer_end_date: 'March 21', estimate_url: portalUrl('/estimate/tok-r'),
      });
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      // The email division is asked about the reminder's own key.
      expect(deps.eligibleForEmail).toHaveBeenCalledWith(expect.objectContaining({ emailKey: REMINDER_TEMPLATE, completedVisitId: 'job-r' }));
    });

    test('reads the jobs 21 to 27 days after the offer day whose offer email the provider accepted', async () => {
      const deps = remindWorld();
      await run(deps);
      const page = deps.db.queriesOf('scheduled_services as s').find(isReminderPageRead);
      expect(called(page, 'whereRaw', `${OFFER_DAY} BETWEEN ?::date AND ?::date`, ['2030-02-13', '2030-02-19'])).toBe(true);
      const exists = page.calls.find(([method, sql]) => method === 'whereRaw' && String(sql).startsWith('EXISTS'))[1];
      expect(exists).toContain("m.idempotency_key = 'onetime-plan-offer:offer:' || s.id::text");
      expect(exists).toContain('m.sent_at IS NOT NULL AND m.estimate_id IS NOT NULL');
    });

    test('a reminder that went out, or may have, is done', async () => {
      const deps = remindWorld({ mail: { reminded: [{ id: 'm-r' }] } });
      expect(reminderOf(await run(deps))).toEqual({ ...R0, done: 1, reasons: {} });
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test.each([
      ['the customer accepted the offer', { ...ESTIMATE, status: 'accepted' }, 'offer_ended'],
      ['the customer declined it', { ...ESTIMATE, status: 'declined' }, 'offer_ended'],
      ['the estimate was archived', { ...ESTIMATE, archived_at: '2030-03-01T00:00:00Z' }, 'offer_estimate_gone'],
      ['the estimate has ended', { ...ESTIMATE, expires_at: '2030-03-10T00:00:00Z' }, 'offer_estimate_gone'],
      // Another job's quote the customer can open holds by the open-estimate rule, before the estimate is read.
      ['the estimate is another job\'s quote', { ...ESTIMATE, estimate_data: stamp('job-x') }, 'open_estimate'],
      ['the offer day moved', { ...ESTIMATE, estimate_data: stamp('job-r', { endsAt: '2030-03-23T03:59:59.999Z', firstVisitFrom: '2030-05-08' }) }, 'offer_day_moved'],
    ])('%s: no reminder', async (_name, estimate, reason) => {
      const deps = remindWorld({ estimate });
      expect(reminderOf(await run(deps))).toEqual({ ...R0, held: 1, reasons: { [reason]: 1 } });
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test.each([
      ['offers turned off', { tables: { notification_prefs: [{ marketing_offers: false }] } }, 'offers_off'],
      ['another visit booked', { tables: { 'scheduled_services as o': [{ id: 'job-2' }] } }, 'another_visit'],
      ['Auto Pay paused', { isAutopayPaused: jest.fn(() => true) }, 'autopay_paused'],
      ['off the card rail', { payAfterFirstVisitCardRail: jest.fn(() => false) }, 'not_pay_after_visit'],
      ['the email division says no', emailVerdict('CAP_SAME_DAY'), 'cap_same_day'],
    ])('%s: held', async (_name, change, reason) => {
      const deps = remindWorld(change);
      expect(reminderOf(await run(deps))).toEqual({ ...R0, held: 1, reasons: { [reason]: 1 } });
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test('the plan-start accept would refuse the quote (a plan since the offer, or another home): held', async () => {
      const deps = remindWorld({ planStartAcceptRefusal: jest.fn(async () => 'account_changed') });
      expect(reminderOf(await run(deps))).toEqual({ ...R0, held: 1, reasons: { account_changed: 1 } });
      expect(deps.planStartAcceptRefusal).toHaveBeenCalledWith(deps.db, expect.objectContaining({ id: 'est-r', customer_id: 'cust-1' }));
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test('the accept check itself: a refusal is account_changed; a failed read fails the job', async () => {
      const restart = require('../services/cancellation-resolution/restart');
      const db = { transaction: (fn) => fn('trx') };
      const spy = jest.spyOn(restart, 'assertPlanStartAcceptEligible');
      try {
        spy.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'PLAN_START_STATE_CHANGED' }));
        expect(await _test.defaultDeps().planStartAcceptRefusal(db, { id: 'est-r' })).toBe('account_changed');
        spy.mockRejectedValueOnce(Object.assign(new Error('retry'), { code: 'PLAN_START_RECHECK_RETRY' }));
        await expect(_test.defaultDeps().planStartAcceptRefusal(db, { id: 'est-r' })).rejects.toMatchObject({ code: 'PLAN_START_RECHECK_RETRY' });
        spy.mockResolvedValueOnce(undefined);
        expect(await _test.defaultDeps().planStartAcceptRefusal(db, { id: 'est-r' })).toBeNull();
        expect(spy).toHaveBeenLastCalledWith('trx', { id: 'est-r' });
      } finally {
        spy.mockRestore();
      }
    });

    test('the 12-month rule is not asked: the reminder is the same offer', async () => {
      const deps = remindWorld();
      await run(deps);
      expect(deps.settleStaleReservations).not.toHaveBeenCalled();
      expect(deps.db.queriesOf('marketing_email_ledger')).toHaveLength(0);
    });

    test('an offer record with no price fails the reminder, and nothing is sent', async () => {
      const deps = remindWorld({ mail: { offered: [{ ...OFFER_ROW, payload_snapshot: {} }] } });
      expect(reminderOf(await run(deps))).toEqual({ ...R0, failed: 1, reasons: {} });
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
    });

    test('the reminder template not published: no reminder is read, and the offers still run', async () => {
      const deps = remindWorld({
        jobs: [JOB],
        // The offer's mint answers with its own quote; the customer has no other estimate.
        tables: { estimates: (query) => (called(query, 'where', { id: 'est-1' }) ? [MINTED_ROW] : []) },
        resolveTemplateForSend: jest.fn(async ({ templateKey }) => {
          if (templateKey === REMINDER_TEMPLATE) throw Object.assign(new Error('draft'), { code: 'EMAIL_TEMPLATE_DISABLED' });
          return {};
        }),
      });
      const summary = await run(deps);
      expect(summary.sent).toBe(1);
      expect(summary.reminder).toEqual({ jobs: 0, sent: 0, held: 0, done: 0, failed: 0, reasons: {}, words_not_approved: true });
      expect(deps.db.queriesOf('scheduled_services as s').some(isReminderPageRead)).toBe(false);
    });

    describe('the accept check again at the provider handoff', () => {
      const handoff = async (deps, estimate = ESTIMATE) => {
        await run(deps);
        const trx = fakeDb({ estimates: [estimate], customers: [CUSTOMER] });
        return { verdict: await sendOf(deps).boundaryGuard(trx), trx };
      };

      test('on the handoff transaction, after the estimate is read: an account that still passes lets the email go', async () => {
        const deps = remindWorld();
        const { verdict, trx } = await handoff(deps);
        expect(verdict).toBeNull();
        expect(deps.assertPlanStartAcceptEligible).toHaveBeenCalledWith(trx, expect.objectContaining({ id: 'est-r' }));
      });

      test('a plan added after the morning check: held, retryable', async () => {
        const deps = remindWorld({
          assertPlanStartAcceptEligible: jest.fn(async () => { throw Object.assign(new Error('changed'), { code: 'PLAN_START_STATE_CHANGED' }); }),
        });
        expect((await handoff(deps)).verdict).toEqual({ reason: 'ACCOUNT_CHANGED', retryable: true });
      });

      test('a failed read: retryable, so the reservation settles failed and the next morning asks again', async () => {
        const deps = remindWorld({
          assertPlanStartAcceptEligible: jest.fn(async () => { throw Object.assign(new Error('busy'), { code: 'PLAN_START_RECHECK_RETRY' }); }),
        });
        expect((await handoff(deps)).verdict).toEqual({ reason: 'ACCOUNT_RECHECK_FAILED', retryable: true });
      });

      test('an estimate gone at the handoff answers first; the account is not read', async () => {
        const deps = remindWorld();
        expect((await handoff(deps, { ...ESTIMATE, archived_at: '2030-03-12T00:00:00Z' })).verdict).toEqual({ reason: 'OFFER_ESTIMATE_GONE', retryable: true });
        expect(deps.assertPlanStartAcceptEligible).not.toHaveBeenCalled();
      });

      test('the ledger reports the refusal: the reminder is held', async () => {
        const deps = remindWorld({
          sendWithLedger: jest.fn(async () => ({ ok: false, sent: false, reason: 'ACCOUNT_CHANGED', row: { id: 'led-r' }, duplicate: false })),
        });
        expect(reminderOf(await run(deps))).toEqual({ ...R0, held: 1, reasons: { account_changed: 1 } });
      });

      test('the offer email has no account guard at its handoff', async () => {
        const deps = liveWorld();
        await run(deps);
        await sendOf(deps).boundaryGuard(fakeDb({ estimates: [MINTED_ROW], customers: [CUSTOMER] }));
        expect(deps.assertPlanStartAcceptEligible).not.toHaveBeenCalled();
      });
    });

    test('the provider handoff refuses an estimate the customer can no longer open: held', async () => {
      const deps = remindWorld({
        sendWithLedger: jest.fn(async () => ({ ok: false, sent: false, reason: 'OFFER_ESTIMATE_GONE', row: { id: 'led-r' }, duplicate: false })),
      });
      expect(reminderOf(await run(deps))).toEqual({ ...R0, held: 1, reasons: { offer_estimate_gone: 1 } });
    });

    test('shadow has no reminder pass', async () => {
      process.env.GATE_ONETIME_PLAN_OFFER = 'shadow';
      const summary = await run(remindWorld());
      expect(summary).not.toHaveProperty('reminder');
    });
  });

  describe('1-click office prefill metadata & GATE_ONETIME_PLAN_EXPANDED_SERVICES (2026-11-27)', () => {
    const savedExpanded = process.env.GATE_ONETIME_PLAN_EXPANDED_SERVICES;
    let notifyAdmin;

    beforeEach(() => {
      notifyAdmin = jest.spyOn(require('../services/notification-service'), 'notifyAdmin').mockResolvedValue({ id: 'n-exp' });
    });

    afterEach(() => {
      notifyAdmin.mockRestore();
      if (savedExpanded === undefined) delete process.env.GATE_ONETIME_PLAN_EXPANDED_SERVICES;
      else process.env.GATE_ONETIME_PLAN_EXPANDED_SERVICES = savedExpanded;
    });

    test('raiseOfficeItem links directly to the prefilled Estimate Tool with service-appropriate copy', async () => {
      await _test.defaultDeps().raiseOfficeItem({
        job: { ...JOB, service_key: 'lawn_inspection' },
        customer: CUSTOMER,
        offerDay: '2030-03-05',
        reason: 'expanded_service_review',
      });
      expect(notifyAdmin).toHaveBeenCalledTimes(1);
      const [, , why, options] = notifyAdmin.mock.calls[0];
      expect(why).toBe('Their Waves assessment was done Tue, Mar 5 and qualifies for a plan offer.');
      expect(options.link).toBe('/admin/estimates?tab=new&customerId=cust-1');
      expect(options.metadata).toMatchObject({
        estimateUrl: '/admin/estimates?tab=new&customerId=cust-1',
        offerEndDate: '2030-04-04',
        serviceKey: 'lawn_inspection',
        reason: 'expanded_service_review',
      });
      expect(options.detail).toContain('Pest or Lawn plan');
      expect(options.detail).not.toContain('Quarterly Pest Control Service');

      notifyAdmin.mockClear();
      await _test.defaultDeps().raiseOfficeItem({
        job: { ...JOB, service_key: 'one_time_pest_control' },
        customer: CUSTOMER,
        offerDay: '2030-03-05',
        reason: 'not_priced',
      });
      const [, , , pestOpts] = notifyAdmin.mock.calls[0];
      expect(pestOpts.link).toBe('/admin/estimates?tab=new&customerId=cust-1');
      expect(pestOpts.detail).toContain('Quarterly Pest Control Service');
    });

    test('gate OFF queries only the 2 pest/roach keys; gate ON queries all 6 keys, requires free assessment to be $0, and keeps dueOfferOfJob restricted', async () => {
      const { dueOfferOfJob } = require('../services/onetime-plan-offer');
      process.env.GATE_ONETIME_PLAN_OFFER = 'live';

      // Gate OFF: published template lets the sweep run and query scheduled_services with ONLY the 2 pest/roach keys.
      delete process.env.GATE_ONETIME_PLAN_EXPANDED_SERVICES;
      const offDeps = liveWorld({
        tables: {
          'scheduled_services as s': [],
          customers: [CUSTOMER],
          invoices: [],
        },
        planStartBlocker: jest.fn(async () => null),
      });
      await runOnetimePlanOfferJob({ now: NOW, deps: offDeps });
      const offQueries = offDeps.db.queriesOf('scheduled_services as s');
      expect(offQueries.length).toBeGreaterThan(0);
      const offWhereIn = offQueries[0].calls.find(([m]) => m === 'whereIn');
      expect(offWhereIn[2]).toEqual(['one_time_pest_control', 'cockroach_control']);

      // Gate ON in live mode: sweep widens to all 6 keys; $0 unconverted Waves Assessment passes jobPaid & routes to office item.
      process.env.GATE_ONETIME_PLAN_EXPANDED_SERVICES = 'true';
      const assessmentJob = {
        id: 'job-assess',
        customer_id: 'cust-1',
        service_day: '2030-03-05',
        job_day: '2030-03-05',
        service_key: 'lawn_inspection',
        estimated_price: 0,
        primary_line_price: 0,
        prepaid_amount: 0,
      };
      const deps = liveWorld({
        tables: {
          'scheduled_services as s': [assessmentJob],
          customers: [CUSTOMER],
          'invoices as i': [],
        },
        planStartBlocker: jest.fn(async () => null),
      });
      const summary = await runOnetimePlanOfferJob({ now: NOW, deps });
      const onQueries = deps.db.queriesOf('scheduled_services as s');
      const onWhereIn = onQueries[0].calls.find(([m]) => m === 'whereIn');
      expect(onWhereIn[2]).toEqual([
        'one_time_pest_control',
        'cockroach_control',
        'wdo_inspection',
        'rodent_trapping',
        'bee_wasp_removal',
        'lawn_inspection',
      ]);
      expect(summary.office).toBe(1);
      expect(summary.sent).toBe(0);
      expect(summary.reasons.expanded_service_review).toBe(1);
      expect(deps.mintPlanStartEstimate).not.toHaveBeenCalled();
      expect(deps.sendWithLedger).not.toHaveBeenCalled();
      expect(deps.raiseOfficeItem).toHaveBeenCalledWith(expect.objectContaining({
        job: assessmentJob,
        reason: 'expanded_service_review',
      }));

      // A priced or prepaid lawn_inspection with no invoice MUST hold as no_invoice (never bypass paid-invoice rule).
      for (const pricedPatch of [{ estimated_price: 49 }, { estimated_price: null, primary_line_price: 49 }, { prepaid_amount: 25 }]) {
        const pricedDeps = liveWorld({
          tables: {
            'scheduled_services as s': [{ ...assessmentJob, ...pricedPatch }],
            customers: [CUSTOMER],
            'invoices as i': [],
          },
          planStartBlocker: jest.fn(async () => null),
        });
        const pricedSummary = await runOnetimePlanOfferJob({ now: NOW, deps: pricedDeps });
        expect(pricedSummary.held).toBe(1);
        expect(pricedSummary.reasons.no_invoice).toBe(1);
        expect(pricedDeps.raiseOfficeItem).not.toHaveBeenCalled();
      }

      // Expanded service with has_plan blocker is held (not sent to office).
      const blockerDeps = liveWorld({
        tables: {
          'scheduled_services as s': [assessmentJob],
          customers: [CUSTOMER],
          'invoices as i': [],
        },
        planStartBlocker: jest.fn(async () => 'has_plan'),
      });
      const blockedSummary = await runOnetimePlanOfferJob({ now: NOW, deps: blockerDeps });
      expect(blockedSummary.held).toBe(1);
      expect(blockedSummary.reasons.has_plan).toBe(1);
      expect(blockerDeps.raiseOfficeItem).not.toHaveBeenCalled();

      // dueOfferOfJob still queries ONLY JOB_SERVICE_KEYS (never auto-minting pest-only offer for an inspection).
      const dueDb = fakeDb({ 'scheduled_services as s': [] });
      await dueOfferOfJob(dueDb, { jobId: '11111111-1111-4111-8111-111111111111', customerId: 'cust-1', now: NOW });
      const whereIns = dueDb.queriesOf('scheduled_services as s')[0].calls.filter(([m]) => m === 'whereIn');
      expect(whereIns.some(([, , vals]) => Array.isArray(vals) && vals.length === 2 && vals.includes('one_time_pest_control'))).toBe(true);
    });
  });
});
