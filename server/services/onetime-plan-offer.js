'use strict';

/**
 * One-time job to plan offer: the SHADOW step (owner 2026-11-19, "build"; GATE_ONETIME_PLAN_OFFER=shadow).
 *
 * The offer: a customer with no plan had a one-time general pest or cockroach job. That job counts as the
 * first visit of the Quarterly Pest Control Service plan, so the setup fee is $0 when the plan starts within
 * 30 days. The offer email goes out from day 3 after the job with the plan price, and one reminder on day 21.
 *
 * This file is the first step, and it sends NO customer anything. Its purpose is the WORDS. Each morning it
 * reads the jobs that are 3 to 14 days old, keeps the customers the offer is for (a live customer, by the
 * shared rule in customer-stages.js, with an email, who has not opted out: the offer's own opt-outs, and the
 * email division's standing answers, which are the staff do-not-contact list, the suppressions and the email
 * switch), prices the plan through the start offer pricing (service-report/cross-sell.js buildStartOffer:
 * saved property data only, no paid lookup, the price settings read whole for each price; it also answers
 * "has a plan" and "not a home the app may price"), and emails one sample of each email to the office inbox as
 * a template-library TEST send. It saves no estimate and writes no row of its own: the sample's idempotency
 * key in email_messages is the once-per-job record. It raises one office item, and only for an outage: a
 * morning on which the price settings stopped every price (reportPriceSettings).
 *
 * It does NOT judge the state of the account on the day: another visit booked or done since the job, the
 * job's invoice and an open balance, a review ask on its way, a complaint or an open request, an estimate
 * that is open, and the email division's checks for the day of the send (the same-day cap, recent human
 * contact). Those send rules, the real estimate and the customer email are the next step. So a sample does
 * not say that this customer will get the offer.
 *
 * An answer of "not today" is not final. The job is read again each morning until day 14, so a home whose
 * property data is saved on day 5 gets its sample on day 5.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays } = require('../utils/datetime-et');
const { dateOnlyString, formatDateOnly } = require('../utils/date-only');
const { greetingFirstName } = require('../utils/greeting-first-name');
const { portalUrl } = require('../utils/portal-url');
const { assertInternalEmailRecipient } = require('../utils/internal-email-recipients');
const { REASONS: EMAIL_VERDICT } = require('./email-division/eligibility');
const { whereLiveCustomer } = require('./customer-stages');

// The catalog keys of the two one-time jobs the offer follows (owner 2026-11-19: pest and roach only).
const JOB_SERVICE_KEYS = ['one_time_pest_control', 'cockroach_control'];
const PLAN_FAMILY = 'pest_control';
const FIRST_DAY = 3;
const LAST_DAY = 14;
const OFFER_DAYS = 30;
// The job is plan visit one, so the next visit is one quarter later: 11 to 13 weeks after the job.
const NEXT_VISIT_FROM_DAYS = 77;
const NEXT_VISIT_TO_DAYS = 91;
// The due jobs are read a page at a time, so one read stays small and no job is cut off.
const PAGE_SIZE = 50;

const OFFER_TEMPLATE = 'nurture.plan_offer';
const REMINDER_TEMPLATE = 'nurture.plan_offer_reminder';
// The email division's stream for both templates (their unsubscribe group is marketing_nurture).
const OFFER_STREAM = 'nurture';
// The variables each template requires. The seed migration's lists are pinned equal to these by the unit test.
const TEMPLATE_VARIABLES = Object.freeze({
  [OFFER_TEMPLATE]: [
    'first_name', 'visit_weekday', 'visit_date_short', 'address_short', 'price_per_application', 'setup_fee',
    'next_visit_window', 'offer_end_date', 'estimate_url',
  ],
  [REMINDER_TEMPLATE]: ['first_name', 'price_per_application', 'offer_end_date', 'estimate_url'],
});
// Samples carry a real first name, street and price, so they go to the office inbox and nowhere else.
const SAMPLE_RECIPIENT = 'contact@wavespestcontrol.com';
const SAMPLE_CATEGORY = 'onetime_plan_offer_sample';

function defaultDeps() {
  return {
    db,
    buildStartOffer: require('./service-report/cross-sell').buildStartOffer,
    channelFor: require('./email-division/eligibility').channelFor,
    eligibleForEmail: require('./email-division/eligibility').eligibleForEmail,
    isInternalTestContact: require('./internal-test-customers').isInternalTestContact,
    activeSuppressionsFor: require('./email-template-library').activeSuppressionsFor,
    sendTemplate: require('./email-template-library').sendTemplate,
    unsubscribeUrl: require('./sendgrid-mail').unsubscribeUrl,
    raisePriceSettingsAlert,
    closePriceSettingsAlert,
  };
}

function shiftDay(ymd, days) {
  return etDateString(addETDays(new Date(`${ymd}T12:00:00Z`), days));
}

function money(amount) {
  return `$${Number(amount).toFixed(2).replace(/\.00$/, '')}`;
}

function sampleKey(templateKey, jobId) {
  return `onetime-plan-offer:sample:${templateKey}:${jobId}`;
}

// One page of the completed one-time jobs that are FIRST_DAY to LAST_DAY days old today (ET), oldest first.
// `after` is the last job of the page before: the next page starts behind it in the same (date, id) order.
// The catalog identity is the row's own snapshot, else its services row: a text label alone is never a match.
// One-time is read from the row by the repository's rule (the reverse of rate-review's PLAN_ROW_SQL, plus no
// series parent): never a plan visit, a series extra, a free re-service or an included follow-up. A one-time
// visit stores no pattern, or the 'one_time' marker.
function dueJobsPage(database, today, after) {
  const page = database('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .where('s.status', 'completed')
    .whereBetween('s.scheduled_date', [shiftDay(today, -LAST_DAY), shiftDay(today, -FIRST_DAY)])
    .whereIn(database.raw('COALESCE(s.service_key_snapshot, sv.service_key)'), JOB_SERVICE_KEYS)
    .whereRaw('s.is_recurring IS DISTINCT FROM true')
    .whereNull('s.recurring_parent_id')
    .whereRaw("COALESCE(s.recurring_pattern, '') IN ('', 'one_time')")
    .whereRaw('s.is_callback IS DISTINCT FROM true')
    .whereRaw('s.followup_included IS DISTINCT FROM true')
    .orderBy('s.scheduled_date', 'asc')
    .orderBy('s.id', 'asc')
    .limit(PAGE_SIZE);
  if (after) page.whereRaw('(s.scheduled_date, s.id) > (?::date, ?::uuid)', [dateOnlyString(after.scheduled_date), after.id]);
  return page.select('s.id', 's.customer_id', 's.scheduled_date');
}

// ---- Who the offer is for. Each rule answers the reason the offer is not for this customer, or null. ----

async function customerReachable(ctx) {
  const account = () => ctx.deps.db('customers').where({ id: ctx.job.customer_id });
  const customer = await account().whereNull('deleted_at')
    .first('id', 'first_name', 'last_name', 'email', 'phone', 'address_line1', 'active');
  if (!customer) return 'no_customer';
  if (customer.active === false) return 'inactive';
  // A live customer by the one rule every surface counts customers with (whereLiveCustomer in
  // customer-stages.js): active, not deleted and in a customer stage. `active` alone is also true for a lead
  // row and for a former customer, so a job on such an account is held and counted here, never offered.
  if (!(await whereLiveCustomer(account()).first('id'))) return 'not_a_live_customer';
  if (!String(customer.email || '').trim()) return 'no_email';
  const isTest = ctx.deps.isInternalTestContact({
    customerId: customer.id, firstName: customer.first_name, lastName: customer.last_name,
    email: customer.email, phone: customer.phone,
  });
  if (isTest) return 'test_customer';
  ctx.customer = customer;
  return null;
}

// The offer goes on an opt-out basis (owner 2026-11-19, "all"), so the opt-outs of Waves marketing count
// beside the ones the email division reads for this stream (emailDivisionAllows): offers turned off in the
// Waves app, marketing asked for by text only, and any active suppression that covers the Waves marketing
// group (an unsubscribe, a bounce, a spam complaint).
async function notOptedOut({ job, customer, deps }) {
  const prefs = await deps.db('notification_prefs').where({ customer_id: job.customer_id })
    .first('marketing_offers', 'marketing_channel');
  if (prefs?.marketing_offers === false) return 'offers_off';
  if (deps.channelFor(prefs, 'marketing_channel') === 'sms') return 'offers_by_text_only';
  const suppressed = await deps.activeSuppressionsFor(null, customer.email, 'marketing_newsletter', deps.db);
  return suppressed.length ? 'email_suppressed' : null;
}

// The email division decides who may get a Waves email, so the job asks it, for the stream the customer email
// will go out on. The division runs its checks in a fixed order: the customer, the staff do-not-contact list,
// the suppressions of the stream's own unsubscribe group, the customer's email switch, and then three checks
// that only the day of the send can answer (an estimate on file, the same-day cap, recent human contact). So
// an answer from one of those three proves that every standing check passed. The job holds on every other
// answer. The three come with the customer email, which saves the estimate the first one asks for.
const DAY_OF_SEND_VERDICTS = new Set([
  EMAIL_VERDICT.RELATIONSHIP_NOT_ELIGIBLE, EMAIL_VERDICT.CAP_SAME_DAY, EMAIL_VERDICT.RECENT_HUMAN_CONTACT,
]);
async function emailDivisionAllows({ job, now, deps }) {
  const verdict = await deps.eligibleForEmail({
    customerId: job.customer_id, stream: OFFER_STREAM, emailKey: OFFER_TEMPLATE, now, conn: deps.db,
  });
  if (verdict.ok || DAY_OF_SEND_VERDICTS.has(verdict.reason)) return null;
  // eligibleForEmail turns a failed read into this verdict. Here it is an outage, not a rule: fail the job.
  if (verdict.reason === EMAIL_VERDICT.LOOKUP_FAILED) {
    throw Object.assign(new Error('email eligibility read failed'), { code: 'LOOKUP_FAILED' });
  }
  return String(verdict.reason || 'email_not_allowed').toLowerCase();
}

// The offer's audience. The send rules that judge the account on the day come with the customer email.
const AUDIENCE_RULES = [customerReachable, notOptedOut, emailDivisionAllows];

// The plan price, or the reason this home goes to the office to price by hand. The pricer gets the job: it
// answers only for a visit of this customer, on an account whose every visit is at the home it prices. It is
// given the app's own connection, never a transaction: its strict price refuses one. A failed read throws
// (countJob), so an outage never reads as "this home cannot be priced".
async function pricePlan(ctx) {
  const { option, reason } = await ctx.deps.buildStartOffer(ctx.job.customer_id, ctx.deps.db, PLAN_FAMILY, { visitId: ctx.job.id });
  if (reason === 'has_plan') return { verdict: 'held', reason };
  if (!option) return { verdict: 'office', reason };
  // A price came back: the price settings loaded whole this morning (reportPriceSettings).
  ctx.priceSettings.priced += 1;
  // The offer's claim must be true for this home: there is a setup fee to remove.
  if (!(Number(option.setupFee) > 0)) return { verdict: 'office', reason: 'no_setup_fee' };
  return { verdict: 'sample', reason: null, option };
}

async function evaluateJob(ctx) {
  for (const rule of AUDIENCE_RULES) {
    const reason = await rule(ctx);
    if (reason) return { verdict: 'held', reason };
  }
  return pricePlan(ctx);
}

function offerPayload({ customer, jobDate, option }) {
  const noYear = { year: undefined };
  const shortDay = (ymd) => formatDateOnly(ymd, { ...noYear, month: 'short' });
  return {
    first_name: greetingFirstName({
      customerName: [customer.first_name, customer.last_name].filter(Boolean).join(' '), customer,
    }),
    visit_weekday: formatDateOnly(jobDate, { ...noYear, month: undefined, day: undefined, weekday: 'long' }),
    visit_date_short: shortDay(jobDate),
    address_short: String(customer.address_line1 || '').trim(),
    price_per_application: money(option.perVisit),
    setup_fee: money(option.setupFee),
    next_visit_window: `${shortDay(shiftDay(jobDate, NEXT_VISIT_FROM_DAYS))} to ${shortDay(shiftDay(jobDate, NEXT_VISIT_TO_DAYS))}`,
    offer_end_date: formatDateOnly(shiftDay(jobDate, OFFER_DAYS), noYear),
    // No estimate exists in shadow, so the button opens the estimate page's "not found" answer.
    estimate_url: portalUrl('/estimate/sample'),
  };
}

function pick(payload, keys) {
  return Object.fromEntries(keys.map((key) => [key, payload[key]]));
}

// The words under review: the template's newest version that is not archived. The owner edits the draft in the
// template editor and the next sample carries it. A customer send (a later PR) uses only the published version.
async function sampleVersionId(database, templateKey) {
  const row = await database('email_template_versions as v')
    .join('email_templates as t', 'v.template_id', 't.id')
    .where('t.template_key', templateKey)
    .whereIn('v.status', ['draft', 'active'])
    .orderBy('v.version_number', 'desc')
    .first('v.id');
  if (!row) throw Object.assign(new Error(`${templateKey} has no version to sample`), { code: 'TEMPLATE_MISSING' });
  return row.id;
}

// Both emails as TEST sends to the office inbox. The idempotency key makes each one a once-per-job send.
// The footer's unsubscribe link is a dead test link, as in the template editor's test send: a click on a
// sample must not unsubscribe the office inbox from Waves marketing email.
async function sendSamples(ctx, option) {
  assertInternalEmailRecipient(SAMPLE_RECIPIENT);
  const payload = offerPayload({ customer: ctx.customer, jobDate: ctx.jobDate, option });
  const note = 'Sample only. No estimate was saved and the customer got no email. This step does not check the account'
    + ` (open balance, other visits, review asks), so this customer may not get the offer. Job ${ctx.job.id}.`;
  for (const templateKey of [OFFER_TEMPLATE, REMINDER_TEMPLATE]) {
    const versionId = await sampleVersionId(ctx.deps.db, templateKey);
    const result = await ctx.deps.sendTemplate({
      versionId,
      to: SAMPLE_RECIPIENT,
      unsubscribeUrl: ctx.deps.unsubscribeUrl(`test-${versionId}`),
      payload: pick(payload, TEMPLATE_VARIABLES[templateKey]),
      test: true,
      idempotencyKey: sampleKey(templateKey, ctx.job.id),
      categories: [SAMPLE_CATEGORY],
      bodyAppend: { html: note, text: note },
    });
    // Not sent and no throw (a pre-provider abort): count the job as failed so the morning after tries again.
    if (!result?.sent) throw Object.assign(new Error(`${templateKey} sample was not sent`), { code: 'SAMPLE_NOT_SENT' });
  }
}

async function alreadySampled(database, jobId) {
  const row = await database('email_messages')
    .where({ idempotency_key: sampleKey(REMINDER_TEMPLATE, jobId) })
    .whereNotNull('sent_at')
    .first('id');
  return Boolean(row);
}

async function shadowJob(job, { now, deps, priceSettings }) {
  if (await alreadySampled(deps.db, job.id)) return { verdict: 'done', reason: null };
  const ctx = { job, now, deps, priceSettings, jobDate: dateOnlyString(job.scheduled_date) };
  const outcome = await evaluateJob(ctx);
  if (outcome.verdict === 'sample') await sendSamples(ctx, outcome.option);
  return outcome;
}

// ---- The price settings. ----
// The pricer refuses to price on price settings it cannot load whole (PRICING_CONFIG_UNAVAILABLE): a failed
// read, an edit while they loaded, or a pest price row that is not complete (an edit on the Pricing Logic page
// can leave one so). One refused job can be a moment. A morning with a refusal and no home priced is an outage
// that lasts: it stops every offer until the settings are whole again, and no page shows it. That morning
// raises one admin notification. A later morning that prices a home closes it.
const PRICE_SETTINGS_REFUSED = 'PRICING_CONFIG_UNAVAILABLE';
const PRICE_SETTINGS_ALERT_KEY = 'onetime-plan-offer:price-settings';

// One open notification for the outage. A morning after the first one refreshes it and does not ring again.
async function raisePriceSettingsAlert({ refused }) {
  return require('./admin-alert-compose').raiseAdminAlert('system', {
    area: 'Estimates',
    action: 'check the pest price settings',
    why: 'No plan offer could be priced this morning because a pest price setting is missing or did not load.',
    severity: 'needs-you',
    link: '/admin/pricing-logic',
    subject: { type: 'check', id: PRICE_SETTINGS_ALERT_KEY },
    doneWhen: 'plan_offer_priced',
    // Claude finds the row; a price setting is a person's to change (docs/admin-notifications.md, section 5).
    who: 'either',
  }, {
    detail: `The plan offer job could not price ${refused} one-time job${refused === 1 ? '' : 's'} this morning, and it priced none. `
      + 'The pricer refused the price settings: a read failed, or a pest price row is not complete (the base price, footprint, '
      + 'features, property type or WaveGuard tier row on the Pricing Logic page). The job tries again every morning, and '
      + 'this closes by itself on the first morning that prices a home.',
    dedupeKey: PRICE_SETTINGS_ALERT_KEY,
    // A row that a person or a good morning closed never hides a new outage.
    dedupeOpenOnly: true,
    refreshOnDedupe: true,
    ringOnRefresh: () => false,
    metadata: { source: 'onetime-plan-offer', refused },
  });
}

// A home was priced: the settings load whole again. Returns the rows closed.
async function closePriceSettingsAlert({ database, now }) {
  const episodes = require('./admin-alert-episodes');
  if (!(await episodes.openAdminAlertKeys(database, PRICE_SETTINGS_ALERT_KEY)).includes(PRICE_SETTINGS_ALERT_KEY)) return 0;
  return Number(await episodes.closeAdminAlertKeys(database, [PRICE_SETTINGS_ALERT_KEY], 'plan_offer_priced', {
    now, resolution: 'The plan offer job priced a home again',
  })) || 0;
}

// The morning's answer about the price settings. A failed write of the notification never fails the run:
// the counts are logged either way, and the next morning tries again.
async function reportPriceSettings({ now, deps }, { refused, priced }) {
  try {
    if (priced) await deps.closePriceSettingsAlert({ database: deps.db, now });
    else if (refused) await deps.raisePriceSettingsAlert({ refused });
  } catch (err) {
    logger.warn(`[onetime-plan-offer] price settings notification failed (code=${err?.code || 'none'})`);
  }
}

// One job's result into the morning's counts. A failure is counted and the job is read again the next morning.
async function countJob(job, run, summary) {
  summary.jobs += 1;
  try {
    const { verdict, reason } = await shadowJob(job, run);
    summary[verdict] += 1;
    if (reason) summary.reasons[reason] = (summary.reasons[reason] || 0) + 1;
  } catch (err) {
    summary.failed += 1;
    if (err?.code === PRICE_SETTINGS_REFUSED) run.priceSettings.refused += 1;
    // The id and an error code only: a database or property error message can carry a street address.
    logger.warn(`[onetime-plan-offer] job ${job.id} failed (code=${err?.code || 'none'})`);
  }
}

/**
 * The daily job. Returns counts only: { mode, jobs, sample, office, held, done, failed, reasons }.
 *   sample = both sample emails went to the office today.   office = the app cannot price this home.
 *   held   = the offer is not for this customer.            done   = sampled on an earlier morning.
 * One job's failure never stops the others; it is counted and read again the next morning.
 * A morning in which the price settings refused a job and no home was priced raises one admin notification
 * (reportPriceSettings).
 */
async function runOnetimePlanOfferJob({ now = new Date(), deps: overrides = {} } = {}) {
  const mode = require('../config/feature-gates').onetimePlanOfferMode?.() || 'off';
  const summary = { mode, jobs: 0, sample: 0, office: 0, held: 0, done: 0, failed: 0, reasons: {} };
  if (mode !== 'shadow') return summary;
  const deps = { ...defaultDeps(), ...overrides };
  const run = { now, deps, priceSettings: { refused: 0, priced: 0 } };
  const today = etDateString(now);
  let page = await dueJobsPage(deps.db, today, null);
  while (page.length) {
    for (const job of page) await countJob(job, run, summary);
    // A short page is the last one. A full page may have more behind its last job.
    page = page.length < PAGE_SIZE ? [] : await dueJobsPage(deps.db, today, page[page.length - 1]);
  }
  await reportPriceSettings(run, run.priceSettings);
  return summary;
}

module.exports = {
  runOnetimePlanOfferJob,
  JOB_SERVICE_KEYS,
  OFFER_TEMPLATE,
  REMINDER_TEMPLATE,
  TEMPLATE_VARIABLES,
  _test: { defaultDeps, offerPayload, sampleKey, PRICE_SETTINGS_ALERT_KEY },
};
