/**
 * One-time job to plan offer, shadow step (services/onetime-plan-offer.js, GATE_ONETIME_PLAN_OFFER=shadow).
 *
 * The job's promise: it prices real cases and emails SAMPLES to the office, and no customer gets anything.
 * This suite pins the decisions around that promise with a recording fake database and stub collaborators:
 * the gate values, who the offer is not for and under which reason, what goes to the office to price by hand,
 * the two sample sends (recipient, test send, once per job), that one bad job never stops the others, and the
 * one admin notification for a morning the price settings stopped.
 * This step does not judge the state of the account on the day (invoices, other visits, review asks,
 * complaints, estimates, the email division's checks for the day of the send): those send rules come with
 * the customer email.
 * The SQL itself, the real collaborators and the seeded templates run against PostgreSQL in
 * onetime-plan-offer-postgres.test.js.
 */

jest.mock('../models/db', () => jest.fn());
jest.mock('../services/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const fs = require('fs');
const path = require('path');
const logger = require('../services/logger');
const { runOnetimePlanOfferJob, TEMPLATE_VARIABLES, OFFER_TEMPLATE, REMINDER_TEMPLATE, _test } = require('../services/onetime-plan-offer');
const { CUSTOMER_STAGES } = require('../services/customer-stages');

// 11:30 PM ET on March 12 (already March 13 in UTC): the day window must come from the ET day.
const NOW = new Date('2030-03-13T03:30:00Z');
const JOB = { id: 'job-1', customer_id: 'cust-1', scheduled_date: '2030-03-05' };
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
      'whereBetween', 'leftJoin', 'join', 'orderBy', 'limit',
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
// A page of due jobs behind the first one carries the (date, id) of the last job read.
const isLaterPageRead = (query) => query.calls.some(([method, sql]) => method === 'whereRaw' && String(sql).startsWith('(s.scheduled_date, s.id) >'));

// A world where job-1 is in the offer's audience and prices. Each test changes one thing.
// `jobs` is the first page of due jobs (a later page is empty).
function world({ tables = {}, jobs = [JOB], ...deps } = {}) {
  return {
    db: fakeDb({
      'scheduled_services as s': (query) => (isLaterPageRead(query) ? [] : jobs),
      customers: [CUSTOMER],
      'email_template_versions as v': (query) => [{ id: `ver:${whereValue(query, 't.template_key')}` }],
      ...tables,
    }),
    buildStartOffer: jest.fn(async () => ({ option: { ...OPTION }, reason: null })),
    isInternalTestContact: jest.fn(() => false),
    activeSuppressionsFor: jest.fn(async () => []),
    eligibleForEmail: jest.fn(async () => ({ ok: true, reason: null, checks: {} })),
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

describe("a job in the offer's audience that prices", () => {
  test('one sample of the offer and one of the reminder go to the office inbox as test sends, keyed once per job', async () => {
    const deps = world();
    const summary = await run(deps);
    expect(summary).toEqual({ mode: 'shadow', jobs: 1, ...NONE, sample: 1, reasons: {} });

    const note = 'Sample only. No estimate was saved and the customer got no email. This step does not check the account'
      + ' (open balance, other visits, review asks), so this customer may not get the offer. Job job-1.';
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

  test('the price is the pest plan for this customer, asked with the job', async () => {
    const deps = world();
    await run(deps);
    // The pricer gets the job, so it can prove the job was at the home it prices.
    expect(deps.buildStartOffer).toHaveBeenCalledWith('cust-1', deps.db, 'pest_control', { visitId: 'job-1' });
  });

  test('the jobs read are completed one-time pest and cockroach jobs, 3 to 14 days old on the ET calendar', async () => {
    const deps = world();
    await run(deps);
    const [due] = deps.db.queriesOf('scheduled_services as s');
    expect(called(due, 'where', 's.status', 'completed')).toBe(true);
    // March 12 in ET (March 13 in UTC): 14 days back is February 26, 3 days back is March 9.
    expect(called(due, 'whereBetween', 's.scheduled_date', ['2030-02-26', '2030-03-09'])).toBe(true);
    expect(called(due, 'whereIn', { sql: 'COALESCE(s.service_key_snapshot, sv.service_key)' }, ['one_time_pest_control', 'cockroach_control'])).toBe(true);
    expect(called(due, 'whereNull', 's.recurring_parent_id')).toBe(true);
    // A one-time visit stores no pattern or the 'one_time' marker. Any other pattern is a plan's cadence.
    expect(called(due, 'whereRaw', "COALESCE(s.recurring_pattern, '') IN ('', 'one_time')")).toBe(true);
    expect(called(due, 'whereRaw', 's.followup_included IS DISTINCT FROM true')).toBe(true);
  });

  test('more due jobs than one page holds: the next page starts behind the last job read, and every job is counted', async () => {
    const firstPage = Array.from({ length: 50 }, (_, index) => ({ ...JOB, id: `job-${index + 1}` }));
    const lastPage = [{ ...JOB, id: 'job-51', scheduled_date: '2030-03-06' }];
    const deps = world({ tables: { 'scheduled_services as s': (query) => (isLaterPageRead(query) ? lastPage : firstPage) } });
    const summary = await run(deps);
    expect(summary).toMatchObject({ jobs: 51, sample: 51 });
    const reads = deps.db.queriesOf('scheduled_services as s');
    expect(reads).toHaveLength(2);
    for (const read of reads) expect(called(read, 'limit', 50)).toBe(true);
    expect(isLaterPageRead(reads[0])).toBe(false);
    expect(called(reads[1], 'whereRaw', '(s.scheduled_date, s.id) > (?::date, ?::uuid)', ['2030-03-05', 'job-50'])).toBe(true);
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
      expect(called(query, 'orderBy', 'v.version_number', 'desc')).toBe(true);
    }
  });
});

describe('the offer is not for this customer: no price is computed and nothing is sent', () => {
  test.each([
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
    ['the customer is on the staff do-not-contact list', emailVerdict('STAFF_DNC'), 'staff_dnc'],
    ["the email is unsubscribed from the offer's own group", emailVerdict('EMAIL_SUPPRESSED_GROUP'), 'email_suppressed_group'],
    ['the customer turned email off', emailVerdict('EMAIL_SWITCH_OFF'), 'email_switch_off'],
    // Fail closed: an answer the job does not know holds the job.
    ['the email division gives an answer the job does not know', emailVerdict('A_RULE_ADDED_LATER'), 'a_rule_added_later'],
    ['the email division says no with no reason', emailVerdict(undefined), 'email_not_allowed'],
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
    // The email division's three checks for the day of the send. They come with the customer email. The
    // division runs them last, so each of these answers also says that no standing opt-out exists.
    ['no estimate is on file yet (the customer step saves one)', emailVerdict('RELATIONSHIP_NOT_ELIGIBLE')],
    ['another marketing email went out today', emailVerdict('CAP_SAME_DAY')],
    ['the office and the customer were in touch in the last 3 days', emailVerdict('RECENT_HUMAN_CONTACT')],
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

  test("the email division is asked about the stream both templates use, on the job's clock", async () => {
    const deps = world();
    await run(deps);
    // Stream nurture: its unsubscribe group is marketing_nurture, the group the two templates carry.
    expect(deps.eligibleForEmail.mock.calls).toEqual([[{ customerId: 'cust-1', stream: 'nurture', emailKey: OFFER_TEMPLATE, now: NOW, conn: deps.db }]]);
  });
});

describe('pricing outcomes', () => {
  test.each([
    ['the customer already has a plan', { option: null, reason: 'has_plan' }, { held: 1 }, 'has_plan'],
    ['the app cannot price the home', { option: null, reason: 'not_priced' }, { office: 1 }, 'not_priced'],
    ['the account fails the premises proof', { option: null, reason: 'premises' }, { office: 1 }, 'premises'],
    ['the plan has no setup fee to remove', { option: { ...OPTION, setupFee: null }, reason: null }, { office: 1 }, 'no_setup_fee'],
  ])('%s: no sample', async (_name, priced, expected, reason) => {
    const deps = world({ buildStartOffer: jest.fn(async () => priced) });
    const summary = await run(deps);
    expect(counts(summary)).toEqual({ ...NONE, ...expected });
    expect(summary.reasons).toEqual({ [reason]: 1 });
    expect(deps.sendTemplate).not.toHaveBeenCalled();
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

  test.each([
    ['the library did not send the sample', { sendTemplate: jest.fn(async () => ({ sent: false, aborted: true })) }, 'SAMPLE_NOT_SENT'],
    ['a template has no version to sample', { tables: { 'email_template_versions as v': [] } }, 'TEMPLATE_MISSING'],
    // The division turns a failed read into a verdict. For the job it is an outage, never "not for this customer".
    ['the email division could not read', emailVerdict('LOOKUP_FAILED'), 'LOOKUP_FAILED'],
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
  const payload = (overrides = {}) => _test.offerPayload({ customer: CUSTOMER, jobDate: '2030-11-18', option: OPTION, ...overrides });

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
      'buildStartOffer', 'channelFor', 'eligibleForEmail', 'isInternalTestContact', 'activeSuppressionsFor', 'sendTemplate', 'unsubscribeUrl',
      'raisePriceSettingsAlert', 'closePriceSettingsAlert',
    ]) {
      expect([name, typeof deps[name]]).toEqual([name, 'function']);
    }
  });

  test('the sample recipient is an internal address', () => {
    expect(require('../utils/internal-email-recipients').isInternalEmailRecipient(OFFICE)).toBe(true);
  });
});
