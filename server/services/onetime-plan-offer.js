'use strict';

/**
 * One-time job to plan offer (owner 2026-11-19, "build"). Two modes of one gate, GATE_ONETIME_PLAN_OFFER:
 * `shadow` = the office gets samples and no customer gets anything; `live` = the customer gets the offer.
 *
 * The offer: a customer with no plan had a one-time general pest or cockroach job. That job counts as the
 * first visit of the Quarterly Pest Control Service plan, so the setup fee is $0 when the plan starts within
 * 30 days. The offer email goes out from day 3 after the job with the plan price, and one reminder on day 21.
 *
 * SHADOW sends NO customer anything. Its purpose is the WORDS. Each morning it
 * reads the jobs whose service was done 3 to 14 days ago, judges each customer by the offer's send rules,
 * prices the plan through the start offer pricing (service-report/cross-sell.js buildStartOffer: saved property
 * data only, no paid lookup, the price settings read whole for each price; it also answers "has a plan" and
 * "not a home the app may price"), and emails one sample of each email to the office inbox as a template-library
 * TEST send. It saves no estimate and writes no row of its own: the sample's idempotency key in email_messages
 * is the once-per-job record. It raises one office item, and only for an outage: a morning on which the price
 * settings stopped every price (reportPriceSettings).
 *
 * The send rules (SEND_RULES, in order) hold the job when any of these is true: another visit is booked, or was
 * done after the job; the customer is not a live customer with an email, or is a test contact; the customer
 * opted out of the offer; the job has no paid invoice of its own, or any money is owed; a review ask is on its
 * way or was sent in the last 72 hours; a low rating or a complaint came in since the job, or a service request
 * is open; an estimate is open or on its way; or the email division says no to the email (staff do-not-contact
 * list, suppressions, the email switch, the same-day cap, recent human contact). A job that passes the rules
 * and whose home the app can price, with a setup fee above $0 and a plan visit price below the job's price,
 * gets its two samples. So a sample means that this customer would get the offer today.
 *
 * LIVE (owner 2026-11-20, "i want auto": no person taps Send) does the same judging and pricing, sends no office
 * sample, and for each job that passes: mints the customer's plan-start estimate for the quarterly plan with the
 * setup fee at $0 (mintPlanStartEstimate with `offer: { jobId }`; the mint proves the job and takes both dates
 * from offerTerms), then sends the customer the offer email through the email division's ledger
 * (sendWithLedger: eligibility, the same-day cap, one reservation per job, the consent check at the provider).
 * Words gate: the offer template must be published, and the owner's publish is his approval of the words;
 * until then a live run does nothing. One offer per customer per 12 months (notOfferedBefore). The email says
 * "You pay after each visit. Nothing is charged today.", which the estimate page says only for a customer on
 * the card rail: the job asks the page's own two functions and sends nothing to any other customer (the quote
 * stays on file and the next morning asks again). The day-21 reminder is a later step.
 *
 * An answer of "not today" is not final. The job is read again each morning until day 14, so a home whose
 * property data is saved on day 5 gets its sample on day 5.
 *
 * The days count from the day the service was DONE, which the visit's service record states. A visit can be
 * done days after its scheduled day, and a visit closed without the service (inspection only, declined by the
 * customer, incomplete) keeps status 'completed'. So a job is due only when a service record says the service
 * was performed. A cockroach job often includes one free follow-up visit (a scheduled_services row with
 * followup_included, linked to the job). When that follow-up was DONE, the days count from its performed day:
 * the window, the day the emails name, the 30 days of the offer and the next visit window (the offer day).
 * A follow-up that is still open keeps the offer waiting (anotherVisit). A follow-up that was cancelled, or
 * closed without the service, does not count: the days count from the job.
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString, addETDays, parseETDateTime } = require('../utils/datetime-et');
const { dateOnlyString, formatDateOnly } = require('../utils/date-only');
const { greetingFirstName } = require('../utils/greeting-first-name');
const { portalUrl } = require('../utils/portal-url');
const { lockCustomerComms } = require('../utils/customer-comms-lock');
const { assertInternalEmailRecipient } = require('../utils/internal-email-recipients');
const { REASONS: EMAIL_VERDICT } = require('./email-division/eligibility');
const { whereLiveCustomer } = require('./customer-stages');
const { NON_PERFORMED_VISIT_OUTCOMES } = require('./pest-pressure/first-visit');
const { planOfferOf, samePlanOffer } = require('./plan-offer-estimate');

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

// The executor's APPOINTMENT_CLOSED_STATUSES. A 'rescheduled' row is in that list, and it is judged by its day:
// see PARKED_VISIT_STATUS. A row with no status is not closed: the column's default is pending.
const CLOSED_VISIT_STATUSES = ['cancelled', 'completed', 'skipped', 'no_show', 'rescheduled'];
// A visit parked for a new day keeps its old day until the office moves it. Dated today or later, it is still
// to come. Once its day has passed it is history: a booking that was cancelled and made again leaves such a
// row behind for good (customer-properties.js propertyRemovalDependents reads it the same way). A customer's
// own request to move a visit stays an open service request until the office closes it, and that is a hold of
// its own (open_request).
const PARKED_VISIT_STATUS = 'rescheduled';
// An estimate on the scheduler's send queue (scheduler.js claims it at its time): on its way, not yet open.
const SCHEDULED_ESTIMATE_STATUS = 'scheduled';
// Billing Recovery's record that an invoice made for other work also covers a visit (admin-billing-recovery.js).
const BILLED_ELSEWHERE = 'billed_elsewhere';
// The review flow's promoter line (review-request.js): 7 or more goes to Google. Below it, no offer.
const PROMOTER_RATING = 7;

const OFFER_TEMPLATE = 'nurture.plan_offer';
const REMINDER_TEMPLATE = 'nurture.plan_offer_reminder';
// The two samples of a job, in the order they are sent.
const SAMPLE_TEMPLATES = [OFFER_TEMPLATE, REMINDER_TEMPLATE];
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
const OFFER_CATEGORY = 'onetime_plan_offer';
// One offer per customer per 12 months (owner 2026-11-19, "build"). The guard's reason inside the ledger's
// reservation; lower-cased it is the send rule's reason too.
const OFFER_WINDOW_MS = 365 * 24 * 60 * 60 * 1000;
const OFFERED_BEFORE = 'OFFERED_BEFORE';
// The estimate's job is not the customer's due one-time job, or the home is not for the plan: the mint's own
// answers (restart.js RestartUnavailableError codes) and the verdict each one gets in a live run.
const MINT_REFUSALS = Object.freeze({
  pricing_unavailable: { verdict: 'office', reason: 'mint_pricing_unavailable' },
  not_eligible: { verdict: 'held', reason: 'not_eligible' },
  offer_changed: { verdict: 'held', reason: 'offer_changed' },
  busy: { verdict: 'held', reason: 'busy' },
  delivery_in_flight: { verdict: 'held', reason: 'delivery_in_flight' },
  // Another estimate opened between the job's own check and the mint's locks (heldByOpenEstimate).
  open_estimate: { verdict: 'held', reason: 'open_estimate' },
});

function defaultDeps() {
  return {
    db,
    buildStartOffer: require('./service-report/cross-sell').buildStartOffer,
    channelFor: require('./email-division/eligibility').channelFor,
    eligibleForEmail: require('./email-division/eligibility').eligibleForEmail,
    reviewAskOnItsWay: (customerId) => require('./review-request').reviewAskOnItsWay(customerId),
    lastDeliveredAskAt: require('./review-ask-history').lastDeliveredAskAt,
    lastManualAskAt: require('./review-ask-history').lastManualAskAt,
    askSpacingMs: require('./review-ask-history').ASK_SPACING_MS,
    liveEstimateStatuses: require('./pricing-authority-gate').LINK_VISIBLE_LIVE_STATUSES,
    repricePendingAbsentSql: require('../utils/estimate-claim-sql').REPRICE_PENDING_ABSENT_SQL,
    openBalanceExists: require('./open-balance').openBalanceExists,
    partiallyPaidStatus: require('./invoice-helpers').PARTIALLY_PAID_STATUS,
    isUncountedPartialDue: require('./invoice-helpers').isUncountedPartialDueInvoice,
    invoicePayerOwnership: require('./invoice-payer-ownership').invoicePayerOwnership,
    itemizedMemberIds: require('./estimate-first-application-invoice').itemizedMemberIdsFromInvoiceLines,
    combinedFirstInvoiceOf: (job, database) => require('./estimate-first-application-invoice').readFirstApplicationStamp(job, database),
    openRequestTerminalStatuses: require('./estimate-add-service-request').OPEN_REQUEST_TERMINAL_STATUSES,
    isInternalTestContact: require('./internal-test-customers').isInternalTestContact,
    activeSuppressionsFor: require('./email-template-library').activeSuppressionsFor,
    sendTemplate: require('./email-template-library').sendTemplate,
    resolveTemplateForSend: require('./email-template-library').resolveTemplateForSend,
    sendWithLedger: (...args) => require('./email-division/ledger').sendWithLedger(...args),
    settleStaleReservations: (...args) => require('./email-division/ledger').settleStaleReservations(...args),
    mintPlanStartEstimate: (...args) => require('./cancellation-resolution/restart').mintPlanStartEstimate(...args),
    // The estimate page's own two functions for "is this customer on the card rail" (estimate-public.js, the
    // pay-after-first-visit wording), and the membership context it hands the first one.
    buildEstimateMembershipContext: (...args) => require('./estimate-membership-context').buildEstimateMembershipContext(...args),
    resolveRecurringCardPolicyForEstimate: (...args) => require('./recurring-card-on-file').resolveRecurringCardPolicyForEstimate(...args),
    payAfterFirstVisitCardRail: (...args) => require('./recurring-card-on-file').payAfterFirstVisitCardRail(...args),
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

// The idempotency key of the customer's offer email: once per job, in the ledger and in email_messages.
function offerKey(jobId) {
  return `onetime-plan-offer:offer:${jobId}`;
}

// The day the service of a visit was done: the service day of the visit's service record that says the service
// was performed (status completed, and an outcome that is not one of the shared "nothing was performed" outcomes
// of pest-pressure/first-visit.js: inspection only, declined by the customer, incomplete). The newest one, if a
// visit has two. The record must be of the visit's own customer, as in visit-completion-packets.js: a record of
// another customer that names this visit proves nothing here. A visit with no such record has no day, so it is
// never due: the offer says "that job is plan visit one", and only a record of the service proves there was one.
const PERFORMED_RECORD_SQL = `r.customer_id = %VISIT%.customer_id
      AND r.status = 'completed'
      AND COALESCE(r.structured_notes->>'visitOutcome', '') NOT IN (${NON_PERFORMED_VISIT_OUTCOMES.map(() => '?').join(', ')})`;
const PERFORMED_DAY_JOIN = `JOIN LATERAL (
    SELECT MAX(r.service_date) AS service_day
    FROM service_records r
    WHERE r.scheduled_service_id = s.id
      AND ${PERFORMED_RECORD_SQL.replace(/%VISIT%/g, 's')}
  ) AS done ON TRUE`;

// The day the job's included follow-up was done, if it was: a follow-up row of the same customer, linked to the
// job by followup_source_service_id or parent_service_id (package-followup-booking.js sets both), closed
// 'completed' with a service record that says the service was performed (the same test as PERFORMED_DAY_JOIN).
// A cancelled follow-up, one closed without the service, one still open and a row of another customer or of
// another job give no day. An open follow-up holds the job in anotherVisit, not here.
const FOLLOWUP_DAY_JOIN = `LEFT JOIN LATERAL (
    SELECT MAX(r.service_date) AS service_day
    FROM scheduled_services f
    JOIN service_records r ON r.scheduled_service_id = f.id
    WHERE f.customer_id = s.customer_id
      AND f.followup_included IS TRUE
      AND (f.followup_source_service_id = s.id OR f.parent_service_id = s.id)
      AND f.status = 'completed'
      AND ${PERFORMED_RECORD_SQL.replace(/%VISIT%/g, 'f')}
  ) AS follow ON TRUE`;

// The offer day: the day the days count from. The follow-up's performed day when the job's included follow-up
// was done, else the job's own performed day. GREATEST skips a NULL, so a job with no performed record must be
// kept out by its own test (done.service_day IS NOT NULL in dueJobsPage), never by this expression.
const OFFER_DAY_SQL = 'GREATEST(done.service_day, COALESCE(follow.service_day, done.service_day))';

// The jobs the offer can follow, on any day: a completed one-time pest or cockroach visit with the record that
// its service was performed. dueJobsPage adds the day window; planOfferJobOf asks about one job.
function qualifyingJobs(database) {
  return database('scheduled_services as s')
    .leftJoin('services as sv', 's.service_id', 'sv.id')
    .joinRaw(PERFORMED_DAY_JOIN, [...NON_PERFORMED_VISIT_OUTCOMES])
    .joinRaw(FOLLOWUP_DAY_JOIN, [...NON_PERFORMED_VISIT_OUTCOMES])
    .where('s.status', 'completed')
    .whereRaw('done.service_day IS NOT NULL')
    .whereIn(database.raw('COALESCE(s.service_key_snapshot, sv.service_key)'), JOB_SERVICE_KEYS)
    .whereRaw('s.is_recurring IS DISTINCT FROM true')
    .whereNull('s.recurring_parent_id')
    .whereRaw("COALESCE(s.recurring_pattern, '') IN ('', 'one_time')")
    .whereRaw('s.is_callback IS DISTINCT FROM true')
    .whereRaw('s.followup_included IS DISTINCT FROM true');
}

// The qualifying jobs that are due their offer today: the offer day was FIRST_DAY to LAST_DAY days ago (ET).
function dueJobs(database, today) {
  return qualifyingJobs(database)
    .whereRaw(`${OFFER_DAY_SQL} BETWEEN ?::date AND ?::date`, [shiftDay(today, -LAST_DAY), shiftDay(today, -FIRST_DAY)]);
}

// The offer's dates, counted in ET calendar days from its offer day. The email states them (offerPayload) and
// the offer estimate stores them (restart.js mintPlanStartEstimate `offer`): one function, so the estimate can
// never end, or take a first visit, on another day than the email says.
//   lastDay                         the last day the offer is good ("good through")
//   endsAt                          the instant it ends: the last millisecond of lastDay in ET, so every
//                                   page that shows the estimate's expires_at as a day shows lastDay
//   firstVisitFrom / firstVisitTo   the window of the next plan visit
function offerTerms(offerDay) {
  const lastDay = shiftDay(offerDay, OFFER_DAYS);
  return {
    offerDay,
    lastDay,
    endsAt: new Date(parseETDateTime(`${lastDay}T23:59:59`).getTime() + 999),
    firstVisitFrom: shiftDay(offerDay, NEXT_VISIT_FROM_DAYS),
    firstVisitTo: shiftDay(offerDay, NEXT_VISIT_TO_DAYS),
  };
}

// The offer this job is due today, with its dates, or null. The offer estimate's mint asks it under the
// customer's locks before it waives the setup fee: the waiver stands on "that job was plan visit one", and the
// estimate's end date and first visit date count from the day that service was performed. So the job must be a
// qualifying job of THIS customer whose offer day is in today's window (the same rows as dueJobsPage), and the
// dates are read here, never taken from the caller. A job of another customer, a cancelled one, a plan visit, a
// visit with no performed record, or one whose window is not open or is over, has no offer. An id that is not
// a uuid is no job.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function dueOfferOfJob(database, { jobId, customerId, now }) {
  if (!UUID.test(String(jobId || '')) || !customerId || !(now instanceof Date)) return null;
  const row = await dueJobs(database, etDateString(now))
    .where('s.id', jobId)
    .where('s.customer_id', customerId)
    .first('s.id', database.raw(`${OFFER_DAY_SQL} AS service_day`));
  // The id as the database spells it: the estimate stores it and a retry compares it (samePlanOffer), so a
  // caller's other spelling of the same uuid (upper case) must not read as another job.
  return row ? { jobId: String(row.id), ...offerTerms(dateOnlyString(row.service_day)) } : null;
}

// One page of the completed one-time jobs whose offer day was FIRST_DAY to LAST_DAY days ago (ET), oldest first.
// `after` is the last job of the page before: the next page starts behind it in the same (offer day, id) order.
// The row's service_day is the offer day; job_day is the day the job itself was done.
// The catalog identity is the row's own snapshot, else its services row: a text label alone is never a match.
// One-time is read from the row by the repository's rule (the reverse of rate-review's PLAN_ROW_SQL, plus no
// series parent): never a plan visit, a series extra, a free re-service or an included follow-up. A one-time
// visit stores no pattern, or the 'one_time' marker.
function dueJobsPage(database, today, after) {
  const page = dueJobs(database, today)
    .orderByRaw(`${OFFER_DAY_SQL} ASC`)
    .orderBy('s.id', 'asc')
    .limit(PAGE_SIZE);
  if (after) page.whereRaw(`(${OFFER_DAY_SQL}, s.id) > (?::date, ?::uuid)`, [dateOnlyString(after.service_day), after.id]);
  return page.select('s.id', 's.customer_id', database.raw(`${OFFER_DAY_SQL} AS service_day`), 'done.service_day as job_day');
}

// ---- Send rules. Each answers the reason the offer does not go today, or null. They run in order. ----

// A visit `o` that comes after the job `j` in the customer's order of work: the service day first, then the
// completion time, then the id (it settles a tie or a missing time). Both rows are compared in the database,
// at the stored precision.
const LATER_THAN_JOB_SQL = "(o.scheduled_date, COALESCE(o.completed_at, 'epoch'::timestamptz), o.id)"
  + " > (j.scheduled_date, COALESCE(j.completed_at, 'epoch'::timestamptz), j.id)";

// The job's own included follow-up (the links FOLLOWUP_DAY_JOIN reads). Each link is NULL-safe: a row that
// carries the flag and no link to the job is some other visit, and a NULL must never drop it from the test.
const NOT_OWN_FOLLOWUP_SQL = 'NOT (o.followup_included IS TRUE AND (COALESCE(o.followup_source_service_id = j.id, FALSE)'
  + ' OR COALESCE(o.parent_service_id = j.id, FALSE)))';

// More work is booked, or a visit of any kind was completed after the job: the job is not the customer's last
// visit. A re-service counts, also one later the same day. Of two one-time jobs on one day, only the last goes on.
// The job's own included follow-up is the one exception, and only once it is completed: it is not "more work",
// the offer day moves to it (FOLLOWUP_DAY_JOIN). While it is open or parked for a later day it holds the job
// like any other visit. A follow-up closed without the service, or cancelled, is no hold either.
async function anotherVisit({ job, now, deps }) {
  const row = await deps.db('scheduled_services as o')
    .join('scheduled_services as j', 'j.customer_id', 'o.customer_id')
    .where('j.id', job.id)
    .whereNot('o.id', job.id)
    .where((q) => q.whereNotIn('o.status', CLOSED_VISIT_STATUSES)
      .orWhere((unset) => unset.whereNull('o.status'))
      .orWhere((parked) => parked.where('o.status', PARKED_VISIT_STATUS).where('o.scheduled_date', '>=', etDateString(now)))
      .orWhere((later) => later.where('o.status', 'completed').whereRaw(LATER_THAN_JOB_SQL).whereRaw(NOT_OWN_FOLLOWUP_SQL)))
    .first('o.id');
  return row ? 'another_visit' : null;
}

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
// beside the ones the email division reads for this stream (emailAllowed): offers turned off in the
// Waves app, marketing asked for by text only, and any active suppression that covers the Waves marketing
// group (an unsubscribe, a bounce, a spam complaint).
// One read, on the handle it is given: the job's own check (notOptedOut), and in a live run the same read
// again inside the ledger's reservation and at the provider handoff (optedOutGuard).
async function optOutReason(database, { customerId, email, deps }) {
  const prefs = await database('notification_prefs').where({ customer_id: customerId })
    .first('marketing_offers', 'marketing_channel');
  if (prefs?.marketing_offers === false) return 'offers_off';
  if (deps.channelFor(prefs, 'marketing_channel') === 'sms') return 'offers_by_text_only';
  const suppressed = await deps.activeSuppressionsFor(null, email, 'marketing_newsletter', database);
  return suppressed.length ? 'email_suppressed' : null;
}

function notOptedOut({ job, customer, deps }) {
  return optOutReason(deps.db, { customerId: job.customer_id, email: customer.email, deps });
}

// One offer per customer per 12 months (owner 2026-11-19, "build"): a real offer email for ANOTHER job, sent or
// reserved within the last 365 days, holds this job. The email division's ledger is the record: only real
// customer sends reserve there (the office samples are test sends and never do), and it is the same table the
// reservation's guard reads under the customer's lock (offeredBeforeGuard), so the rule and the guard cannot
// disagree. This job's own key never counts: its own send is not "before".
function offeredBefore(database, { customerId, jobId, now }) {
  return database('marketing_email_ledger')
    .where({ customer_id: customerId, email_key: OFFER_TEMPLATE })
    .whereIn('status', ['sent', 'reserved'])
    .whereNot('idempotency_key', offerKey(jobId))
    .whereRaw('COALESCE(sent_at, reserved_at) > ?', [new Date(now.getTime() - OFFER_WINDOW_MS)])
    .first('id');
}

// A worker that crashed after it reserved leaves a `reserved` row. The ledger settles it when it is older than
// RESERVATION_LIFETIME_MS (and completes it as sent when the provider took the message), but only inside a
// reservation. Settle first, so a dead row does not hold the customer for 365 days.
async function notOfferedBefore({ job, now, deps }) {
  await deps.settleStaleReservations(job.customer_id, now);
  const earlier = await offeredBefore(deps.db, { customerId: job.customer_id, jobId: job.id, now });
  return earlier ? OFFERED_BEFORE.toLowerCase() : null;
}

// The invoices that bill the job, by the links invoice.js assertNoOtherLiveVisitInvoice lists for "one visit,
// one live bill". An invoice belongs to a visit directly, or through its service record (invoice.js
// linkedScheduledServiceId). One stop billed together keeps ONE invoice under the first billed visit and links
// every billed visit through its completion-packet items. Billing Recovery can record that an invoice made for
// other work covers the visit ("billed elsewhere"). And a line of any invoice names the visit it bills
// (client_id scheduled_<visit>_primary, written by every service mint). The fifth link of that list, the
// stamp of an estimate's combined first invoice, is read in sharesAnInvoice.
function jobInvoices(database, job) {
  const ownLine = JSON.stringify([{ client_id: `scheduled_${job.id}_primary` }]);
  return database('invoices as i')
    .leftJoin('service_records as r', 'r.id', 'i.service_record_id')
    .where('i.customer_id', job.customer_id)
    .where((q) => q.where('i.scheduled_service_id', job.id)
      .orWhere('r.scheduled_service_id', job.id)
      .orWhereIn('i.id', database('visit_completion_packet_items')
        .where({ scheduled_service_id: job.id }).whereNotNull('invoice_id').select('invoice_id'))
      .orWhereIn('i.id', database('visit_billing_dispositions')
        .where({ scheduled_service_id: job.id, disposition: BILLED_ELSEWHERE }).whereNotNull('invoice_id').select('invoice_id'))
      .orWhereRaw("CASE WHEN jsonb_typeof(i.line_items) = 'array' THEN i.line_items ELSE '[]'::jsonb END @> ?::jsonb", [ownLine]))
    .select('i.id', 'i.status', 'i.total', 'i.scheduled_service_id', 'i.line_items', 'r.scheduled_service_id as record_visit_id');
}

// True when a paid invoice of the job also bills other work. Its total is then not the price of this job.
// The repository links more work to an invoice six ways: the job is a member of an estimate's combined first
// invoice (its accept stamp; such a group is always two visits or more), the invoice sits under another visit,
// its service record belongs to another visit, one of its lines names another visit, its completion packet
// links another visit, or Billing Recovery recorded a visit as "billed elsewhere" on it. That record means the
// invoice was made for other work: when it names another visit, the job's invoice pays for two; when it names
// the job, the total is more than the job.
async function sharesAnInvoice({ job, deps }, paid) {
  if (await deps.combinedFirstInvoiceOf(job, deps.db)) return true;
  // Each link is read on its own: an invoice found by a line that names the job can sit under another visit,
  // or carry another visit's service record.
  const namesAnother = (invoice) => [invoice.scheduled_service_id, invoice.record_visit_id, ...deps.itemizedMemberIds(invoice.line_items)]
    .some((visitId) => visitId && visitId !== job.id);
  if (paid.some(namesAnother)) return true;
  const paidIds = paid.map((invoice) => invoice.id);
  const inAnotherPacket = await deps.db('visit_completion_packet_items')
    .whereIn('invoice_id', paidIds)
    .whereNot({ scheduled_service_id: job.id })
    .first('id');
  if (inAnotherPacket) return true;
  const billedElsewhere = await deps.db('visit_billing_dispositions')
    .whereIn('invoice_id', paidIds)
    .where({ disposition: BILLED_ELSEWHERE })
    .first('id');
  return Boolean(billedElsewhere);
}

function balanceUnknown() {
  return Object.assign(new Error('open balance could not be confirmed'), { code: 'OPEN_BALANCE_UNKNOWN' });
}

// What the customer still owes on an invoice of their own. open-balance.js answers for the invoices the Waves
// app counts as the balance (sent, viewed, overdue). A part-paid invoice with an amount due is owed too, but
// that balance does not count it (invoice-helpers isUncountedPartialDueInvoice), so it is read here, with the
// pay page's live answer for whose debt it is (invoice-payer-ownership: a payer's invoice is not the
// customer's). Only a plain "no" from each check lets the job go on. An answer that could not be decided (a
// payer read failed) is an outage, not a rule: the job fails and the next morning reads it again.
async function owesMoney({ job, deps }) {
  const counted = await deps.openBalanceExists(job.customer_id, { database: deps.db });
  if (counted === true) return true;
  if (counted !== false) throw balanceUnknown();
  const partPaid = await deps.db('invoices')
    .where({ customer_id: job.customer_id, status: deps.partiallyPaidStatus })
    .select('id', 'customer_id', 'status', 'total', 'credit_applied', 'amount_paid', 'payer_id', 'payer_statement_id',
      'scheduled_send_error', 'scheduled_service_id', 'service_record_id');
  for (const invoice of partPaid.filter((row) => deps.isUncountedPartialDue(row))) {
    const owner = await deps.invoicePayerOwnership(invoice, deps.db);
    if (owner === null) return true;
    if (owner !== 'payer_owned') throw balanceUnknown();
  }
  return false;
}

// The job is paid, its price can be read, and nothing else is owed.
async function jobPaid(ctx) {
  const invoices = await jobInvoices(ctx.deps.db, ctx.job);
  if (!invoices.length) return 'no_invoice';
  const paid = invoices.filter((invoice) => invoice.status === 'paid');
  if (!paid.length) return 'invoice_not_paid';
  // No rule splits a shared total by visit, so the job's own price is not known: hold, never compare the total.
  if (await sharesAnInvoice(ctx, paid)) return 'combined_invoice';
  if (await owesMoney(ctx)) return 'open_balance';
  // The largest paid invoice, not the sum: the lower figure is the harder test for "the plan costs less".
  ctx.jobPrice = Math.max(...paid.map((invoice) => Number(invoice.total)));
  return null;
}

// No offer while a review ask is still on its way (the review service's own answer: an ask queued, being sent
// or left with no send result, a cadence with an ask still to come, or a follow-up text still to come; a
// private check-in is not an ask), and 72 hours between a review ask and the offer. The two history readers
// are the ones the review flow spaces its own asks with: the asks it sent, and an ask the office typed by hand.
async function reviewAskClear({ job, now, deps }) {
  if (await deps.reviewAskOnItsWay(job.customer_id)) return 'review_ask';
  const [sentAt, typedAt] = await Promise.all([
    deps.lastDeliveredAskAt(job.customer_id),
    deps.lastManualAskAt(job.customer_id, { since: new Date(now.getTime() - deps.askSpacingMs) }),
  ]);
  const lastAskMs = Math.max(sentAt?.getTime() || 0, typedAt?.getTime() || 0);
  return lastAskMs && now.getTime() - lastAskMs < deps.askSpacingMs ? 'review_ask' : null;
}

// Signs of an unhappy customer since the job: a rating below the promoter line, a logged complaint, an open request.
async function noComplaint({ job, jobDay, deps }) {
  // "Since the job" starts at midnight Eastern on the day the job itself was done (not the offer day: a signal
  // that came before the follow-up still counts), not at midnight UTC (7 or 8 PM the evening before).
  const since = parseETDateTime(`${jobDay}T00:00:00`);
  const lowRating = await deps.db('review_requests')
    .where({ customer_id: job.customer_id })
    .where('rating', '<', PROMOTER_RATING)
    .where('rated_at', '>=', since)
    .first('id');
  if (lowRating) return 'low_rating';
  const complaint = await deps.db('customer_interactions')
    .where({ customer_id: job.customer_id, interaction_type: 'complaint' })
    .where('created_at', '>=', since)
    .first('id');
  if (complaint) return 'complaint';
  const openRequest = await deps.db('service_requests')
    .where({ customer_id: job.customer_id })
    .whereNotIn('status', deps.openRequestTerminalStatuses)
    .first('id');
  return openRequest ? 'open_request' : null;
}

// Never a second price beside an estimate the customer can open now, or one that is on its way. Each kind has
// its own test. "Can open now" is the public estimate page's rule (pricing-authority-gate
// LINK_VISIBLE_LIVE_STATUSES: sending, sent or viewed, not archived, not expired; a row that is being sent can
// have no expiry yet). "On its way" is the scheduler's queue test (scheduler.js claimDueScheduledEstimates:
// scheduled, with a send time, not archived, not held for a new price). That test has no expiry: an estimate
// whose send was late can carry a past expiry and still go out. An estimate held for a new price never goes
// out as it is (estimate-clarify-asks repricePendingActive): its replacement is a row of its own. A draft may
// never go out, so it is not a hold.
// The one estimate that does not hold the job is the job's OWN offer quote (live mode mints it before it sends):
// a send the email division denied, or one that failed, leaves that quote on file, and the next morning must
// get past it and reuse it. Every other estimate holds, an offer quote of another job included.
// The mint asks this same question again under the customer's locks (heldByOpenEstimate), before it retires a row.
async function openEstimateBesidesOffer(database, { customerId, jobId, now }, rule) {
  const live = await database('estimates')
    .where({ customer_id: customerId })
    .whereNull('archived_at')
    .where((q) => q
      .where((open) => open.whereIn('status', rule.liveEstimateStatuses)
        .where((unexpired) => unexpired.whereNull('expires_at').orWhere('expires_at', '>', now)))
      .orWhere((queued) => queued.where('status', SCHEDULED_ESTIMATE_STATUS).whereNotNull('scheduled_at')
        .whereRaw(rule.repricePendingAbsentSql)))
    .select('id', 'estimate_data');
  return live.some((row) => planOfferOf(row.estimate_data)?.jobId !== String(jobId));
}

async function noLiveEstimate({ job, now, deps }) {
  return (await openEstimateBesidesOffer(deps.db, { customerId: job.customer_id, jobId: job.id, now }, deps)) ? 'open_estimate' : null;
}

// The rule above for the offer estimate's mint (restart.js mintPlanStartEstimate), which asks it under the
// customer's locks before it prices, retires or mints. The job's own check ran before those locks: a quote the
// customer opened in between (a portal tap takes the same locks, so it has committed by then) would be
// archived by the mint's lineage retire, and its link and slot hold with it. With this answer the mint refuses
// (`open_estimate`), retires nothing, and the job is held for the morning.
function heldByOpenEstimate(database, { customerId, jobId, now }) {
  const { liveEstimateStatuses, repricePendingAbsentSql } = defaultDeps();
  return openEstimateBesidesOffer(database, { customerId, jobId, now }, { liveEstimateStatuses, repricePendingAbsentSql });
}

// The email division's own verdict for a marketing email on the nurture stream (unsubscribe, do-not-contact,
// the same-day cap, recent human contact). The nurture stream wants an estimate on file, and the offer's
// estimate is saved only after this verdict. So the job names its completed visit, and the division reads that
// row as the relationship. Every check behind it runs as it will for the real send.
async function emailAllowed({ job, now, deps }) {
  const verdict = await deps.eligibleForEmail({
    customerId: job.customer_id, stream: OFFER_STREAM, emailKey: OFFER_TEMPLATE, now, conn: deps.db, completedVisitId: job.id,
  });
  if (verdict.ok) return null;
  // eligibleForEmail turns a failed read into this verdict. Here it is an outage, not a rule: fail the job.
  if (verdict.reason === EMAIL_VERDICT.LOOKUP_FAILED) {
    throw Object.assign(new Error('email eligibility read failed'), { code: 'LOOKUP_FAILED' });
  }
  return String(verdict.reason || 'email_not_allowed').toLowerCase();
}

// The money sentence of the email ("You pay after each visit. Nothing is charged today.") is true only for a
// customer on the card rail. The estimate page asks two functions about the estimate before it prints that
// wording (estimate-public.js): the recurring card policy, then payAfterFirstVisitCardRail. This rule asks them
// about the account before any estimate exists, so a shadow sample and a live send hold the same customers:
// payer-billed, Auto Pay paused or off, or the page's gate or the card lane off. The policy reads the estimate
// for the customer it will land on (its customer_id) and for a visit already linked to it; an offer estimate
// that is not made yet has no such visit. A plan member who is off the rail is held here; one on Auto Pay goes
// on, and the pricer holds it (`has_plan`). A live run asks again about the estimate it made (onCardRail). A
// failed read throws, and the job fails for the morning.
async function cardRailOf(deps, estimate, more) {
  const policy = await deps.resolveRecurringCardPolicyForEstimate({
    estimate, treatAsOneTime: false, billByInvoice: false, paymentMethodPreference: null, ...more,
  });
  return deps.payAfterFirstVisitCardRail(policy) === true;
}

async function paysAfterVisit({ job, deps }) {
  const onRail = await cardRailOf(deps, { customer_id: job.customer_id }, { membership: null, useLinkedFallback: false });
  return onRail ? null : 'not_pay_after_visit';
}

const SEND_RULES = [
  anotherVisit, customerReachable, notOptedOut, notOfferedBefore, jobPaid, paysAfterVisit, reviewAskClear, noComplaint,
  noLiveEstimate, emailAllowed,
];

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
  // The offer's two claims must be true for this home: there is a setup fee to remove, and a plan visit costs
  // less than the one-time job did.
  if (!(Number(option.setupFee) > 0)) return { verdict: 'office', reason: 'no_setup_fee' };
  if (!(Number(option.perVisit) < ctx.jobPrice)) return { verdict: 'office', reason: 'plan_not_below_job' };
  return { verdict: 'sample', reason: null, option };
}

async function evaluateJob(ctx) {
  for (const rule of SEND_RULES) {
    const reason = await rule(ctx);
    if (reason) return { verdict: 'held', reason };
  }
  return pricePlan(ctx);
}

// `estimateUrl` is the button's link: the sample page in shadow, the customer's own estimate in live.
function offerPayload({ customer, offerDay, option, estimateUrl }) {
  const noYear = { year: undefined };
  const shortDay = (ymd) => formatDateOnly(ymd, { ...noYear, month: 'short' });
  const terms = offerTerms(offerDay);
  return {
    first_name: greetingFirstName({
      customerName: [customer.first_name, customer.last_name].filter(Boolean).join(' '), customer,
    }),
    visit_weekday: formatDateOnly(offerDay, { ...noYear, month: undefined, day: undefined, weekday: 'long' }),
    visit_date_short: shortDay(offerDay),
    address_short: String(customer.address_line1 || '').trim(),
    price_per_application: money(option.perVisit),
    setup_fee: money(option.setupFee),
    next_visit_window: `${shortDay(terms.firstVisitFrom)} to ${shortDay(terms.firstVisitTo)}`,
    offer_end_date: formatDateOnly(terms.lastDay, noYear),
    estimate_url: estimateUrl,
  };
}

function pick(payload, keys) {
  return Object.fromEntries(keys.map((key) => [key, payload[key]]));
}

// The words under review: the template's newest version that is not archived. The owner edits the draft in the
// template editor and the next sample carries it. A customer send (a later PR) uses only the published version.
// The template itself must be a draft or active too. The owner can pause or archive a template in the editor,
// and the library does not check that status on a test send, so this read is where a sample honors it.
const SAMPLED_STATUSES = ['draft', 'active'];
async function sampleVersionId(database, templateKey) {
  const row = await database('email_template_versions as v')
    .join('email_templates as t', 'v.template_id', 't.id')
    .where('t.template_key', templateKey)
    .whereIn('t.status', SAMPLED_STATUSES)
    .whereIn('v.status', SAMPLED_STATUSES)
    .orderBy('v.version_number', 'desc')
    .first('v.id');
  if (!row) throw Object.assign(new Error(`${templateKey} has no version to sample`), { code: 'TEMPLATE_MISSING' });
  return row.id;
}

// The values of the offer sample that this job sent on an earlier morning, if it sent one. A morning can send
// the offer and fail on the reminder. The morning after prices the home again, and a price setting can change in
// between. The reminder then repeats the values of the offer the office already has, so the two samples of one
// job never show two prices.
async function sentOfferValues(database, jobId) {
  const row = await database('email_messages')
    .where({ idempotency_key: sampleKey(OFFER_TEMPLATE, jobId) })
    .whereNotNull('sent_at')
    .first('payload_snapshot');
  return row?.payload_snapshot || {};
}

// Both emails as TEST sends to the office inbox. The idempotency key makes each one a once-per-job send.
// The footer's unsubscribe link is a dead test link, as in the template editor's test send: a click on a
// sample must not unsubscribe the office inbox from Waves marketing email.
async function sendSamples(ctx, option) {
  assertInternalEmailRecipient(SAMPLE_RECIPIENT);
  const payload = {
    // No estimate exists in shadow, so the button opens the estimate page's "not found" answer.
    ...offerPayload({ customer: ctx.customer, offerDay: ctx.offerDay, option, estimateUrl: portalUrl('/estimate/sample') }),
    ...await sentOfferValues(ctx.deps.db, ctx.job.id),
  };
  const note = 'Sample only. No estimate was saved and the customer got no email. This account passed the send rules today,'
    + ` so this customer would get the offer. Job ${ctx.job.id}.`;
  // Both versions are read before the first send: a job never gets the offer sample when the reminder's
  // template has no version to sample.
  const versionIds = {};
  for (const templateKey of SAMPLE_TEMPLATES) versionIds[templateKey] = await sampleVersionId(ctx.deps.db, templateKey);
  for (const templateKey of SAMPLE_TEMPLATES) {
    const versionId = versionIds[templateKey];
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
  // The emails name the offer day, and the offer's 30 days start there. The complaint check starts at the
  // job's own day, the earlier one.
  const ctx = {
    job, now, deps, priceSettings, offerDay: dateOnlyString(job.service_day), jobDay: dateOnlyString(job.job_day),
  };
  const outcome = await evaluateJob(ctx);
  if (outcome.verdict === 'sample') await sendSamples(ctx, outcome.option);
  return outcome;
}

// ---- Live: the customer's estimate and the customer's email (owner 2026-11-20, "i want auto"). ----

// The words gate. A real send uses the template's active version on an active template, and the owner's publish
// is his approval of the words (the seed migration leaves both templates drafts). The library decides it
// (resolveTemplateForSend, the first step of every sendTemplate): its refusal codes mean "no published words",
// and any other error is an outage and fails the run. A run that reads no job also reserves nothing.
const WORDS_MISSING_CODES = ['EMAIL_TEMPLATE_DISABLED', 'EMAIL_TEMPLATE_UNAVAILABLE'];
async function offerWordsPublished(deps) {
  try {
    await deps.resolveTemplateForSend({ templateKey: OFFER_TEMPLATE, database: deps.db });
    return true;
  } catch (err) {
    if (WORDS_MISSING_CODES.includes(err?.code)) return false;
    throw err;
  }
}

// The offer email went out, or may have: the delivery authority (email_messages) shows the provider accepted it,
// or the handoff started and the answer is unknown. A row that definitely never reached the provider is not an
// offer: the same key is tried again (the ledger reopens its failed row). Mirrors email-division/ledger.js
// messageStateFor: sent_at set = accepted, provider_handoff_phase 'started' = uncertain.
async function alreadyOffered(database, jobId) {
  const row = await database('email_messages')
    .where({ idempotency_key: offerKey(jobId) })
    .where((sent) => sent.whereNotNull('sent_at').orWhere('provider_handoff_phase', 'started'))
    .first('id');
  return Boolean(row);
}

// The estimate the mint answered with, read once for the two checks below.
async function mintedEstimate(estimateId, { deps }) {
  const estimate = await deps.db('estimates').where({ id: estimateId }).first();
  if (!estimate) throw Object.assign(new Error('the minted estimate could not be read'), { code: 'ESTIMATE_MISSING' });
  return estimate;
}

// The email states the offer's last day and the next visit's window from the offer day this run read when it
// listed the job. The mint reads the offer day again under the customer's locks (dueOfferOfJob), and the
// estimate carries the mint's dates. They differ when the service record changed in between (staff corrected
// the performed day, a follow-up was completed). An email whose dates are not its estimate's is never sent:
// the job is held, and the next morning lists the job with the day the estimate now carries.
function sameDatesAsEmail(estimate, { job, offerDay }) {
  const { endsAt, firstVisitFrom } = offerTerms(offerDay);
  return samePlanOffer(planOfferOf(estimate.estimate_data), { jobId: String(job.id), endsAt, firstVisitFrom });
}

// The card rail again (paysAfterVisit), now as the estimate page asks it: about the estimate row itself, with
// its membership context and any visit linked to it.
async function onCardRail(estimate, { deps }) {
  return cardRailOf(deps, estimate, { membership: await deps.buildEstimateMembershipContext(estimate) });
}

// The one-per-12-months rule again, inside the ledger's reservation, under the customer's advisory lock: two
// runs cannot both pass it. The ledger's guard contract: null to go on, { reason } to deny.
async function offeredBeforeGuard(trx, { customerId, jobId, now }) {
  return (await offeredBefore(trx, { customerId, jobId, now })) ? { reason: OFFERED_BEFORE } : null;
}

// The offer's own estimate, at the provider handoff: the email's button opens it, so the email never leaves
// for an estimate the customer cannot open. The same customer's next plan-start mint (a tap on another plan
// option) archives this lineage, and that mint holds the customer-comms advisory lock, so this guard takes
// that lock first (a mint in flight finishes before the read; a new one waits for this transaction's end) and
// reads the row with a share lock (staff archiving it waits too). "Can open" is the public estimate page's
// rule, as in openEstimateBesidesOffer. Retryable: the ledger settles the reservation `failed`, so the next
// morning's run mints again under the same key.
const OFFER_ESTIMATE_GONE = 'OFFER_ESTIMATE_GONE';
async function offerEstimateGuard(trx, { customer, jobId, estimateId, now, deps }) {
  await lockCustomerComms(trx, customer.id);
  const estimate = await trx('estimates').where({ id: estimateId }).forShare()
    .first('customer_id', 'status', 'archived_at', 'expires_at', 'estimate_data');
  const open = estimate && estimate.customer_id === customer.id && !estimate.archived_at
    && deps.liveEstimateStatuses.includes(estimate.status)
    && (!estimate.expires_at || new Date(estimate.expires_at) > now)
    && planOfferOf(estimate.estimate_data)?.jobId === String(jobId);
  return open ? null : { reason: OFFER_ESTIMATE_GONE, retryable: true };
}

// The opt-outs of Waves marketing again (notOptedOut), on the ledger's own transaction. The division's checks
// for this stream do not read them: offers turned off in the app, marketing by text only, a suppression of the
// marketing group. The job's check ran before the home was priced and the estimate was made, so a customer
// who opts out in between is caught here: once inside the reservation (a denial there leaves no row), and
// once more at the provider handoff, the last read before the email leaves (the ledger settles that
// reservation `skipped`). The reason goes to the ledger in its own spelling, upper case.
async function optedOutGuard(trx, { customer, deps }) {
  const reason = await optOutReason(trx, { customerId: customer.id, email: customer.email, deps });
  return reason ? { reason: reason.toUpperCase() } : null;
}

// A send the ledger did not complete. A denial that left no reservation is a verdict about this customer today:
// the job is held under the division's own reason, and the quote stays for the next morning. A reservation that
// settled `sent` went out, or may have (handoff started, answer lost): done, never tried again. One that
// settled `failed` is an outage (the provider, the library, the template): the job fails, and the next morning
// sends again under the same key. One that settled `skipped` is a refusal at the provider boundary (consent
// changed, address changed): held.
// A duplicate is an earlier attempt's row under this job's key, and its status is the answer. `skipped` is the
// ledger's permanent drop: no offer went out and the key is never sent again, so the job reads held on every
// later morning, never "offered". `reserved` is a send in flight, or one a crash left: the ledger settles it on
// a later morning. Any other row (sent) is the offer.
const EARLIER_ATTEMPT = Object.freeze({ skipped: 'send_dropped', reserved: 'send_in_flight' });
async function settleOfferSend(out, { deps }) {
  if (out.reason === OFFER_ESTIMATE_GONE) return { verdict: 'held', reason: 'offer_estimate_gone' };
  if (out.sent) return { verdict: 'sent', reason: null };
  if (out.duplicate) {
    const reason = EARLIER_ATTEMPT[out.row?.status];
    return reason ? { verdict: 'held', reason } : { verdict: 'done', reason: null };
  }
  if (out.row) {
    const settled = await deps.db('marketing_email_ledger').where({ id: out.row.id }).first('status');
    if (settled?.status === 'sent') return { verdict: 'done', reason: null };
    if (settled?.status === 'failed') throw Object.assign(new Error('offer email was not sent'), { code: 'OFFER_NOT_SENT' });
  } else if (out.reason === EMAIL_VERDICT.LOOKUP_FAILED) {
    throw Object.assign(new Error('email division read failed'), { code: 'LOOKUP_FAILED' });
  }
  return { verdict: 'held', reason: String(out.reason || 'email_not_allowed').toLowerCase() };
}

// Priced and allowed: mint first (the nurture stream wants an estimate on file, and the quote is the button's
// target), then check the estimate's dates against the email's and the money sentence, then send. The mint is
// told the job and nothing else. It proves the job and takes both dates from offerTerms (dueOfferOfJob), the
// same function the email's words come from. It reuses this job's quote when one is live with the same dates,
// so a denied send leaves a quote that the next morning reuses, and the link in the email is always the one
// the mint answered with on THIS run. It never replaces another estimate the customer can open (open_estimate).
async function mintAndSend(ctx, option) {
  const { job, now, deps, customer } = ctx;
  let minted;
  try {
    minted = await deps.mintPlanStartEstimate({
      customer,
      serviceKey: 'pest_control',
      optionId: option.id,
      shown: {
        monthly: option.monthly, perVisit: option.perVisit, dueAtStart: option.dueAtStart, oneTime: option.oneTime, setupFee: 0,
      },
      offer: { jobId: String(job.id) },
      now: () => now,
    });
  } catch (err) {
    // A refusal is the customer's or the home's answer. Any other error is a bug in this job (the mint throws a
    // plain Error for a job that is not this customer's due job) or an outage: it fails the job.
    const refusal = err?.restartUnavailable === true ? MINT_REFUSALS[err.code] : null;
    if (refusal) return { ...refusal };
    throw err;
  }
  const estimate = await mintedEstimate(minted.estimateId, ctx);
  if (!sameDatesAsEmail(estimate, ctx)) return { verdict: 'held', reason: 'offer_day_moved' };
  if (!(await onCardRail(estimate, ctx))) return { verdict: 'held', reason: 'not_pay_after_visit' };

  const payload = pick(
    offerPayload({ customer, offerDay: ctx.offerDay, option, estimateUrl: portalUrl(minted.url) }),
    TEMPLATE_VARIABLES[OFFER_TEMPLATE],
  );
  const out = await deps.sendWithLedger({
    customerId: customer.id,
    stream: OFFER_STREAM,
    marketingClass: 'marketing',
    emailKey: OFFER_TEMPLATE,
    idempotencyKey: offerKey(job.id),
    now,
    // The address the payload was built for: the ledger refuses the send if the customer's address changed.
    expectedRecipientEmail: customer.email,
    guard: async (trx) => (await offeredBeforeGuard(trx, { customerId: customer.id, jobId: job.id, now }))
      || optedOutGuard(trx, { customer, deps }),
    boundaryGuard: async (trx) => (await offerEstimateGuard(trx, {
      customer, jobId: job.id, estimateId: minted.estimateId, now, deps,
    })) || optedOutGuard(trx, { customer, deps }),
    template: { templateKey: OFFER_TEMPLATE, payload, categories: [OFFER_CATEGORY] },
  });
  return settleOfferSend(out, ctx);
}

async function liveJob(job, { now, deps, priceSettings }) {
  if (await alreadyOffered(deps.db, job.id)) return { verdict: 'done', reason: null };
  const ctx = {
    job, now, deps, priceSettings, offerDay: dateOnlyString(job.service_day), jobDay: dateOnlyString(job.job_day),
  };
  const outcome = await evaluateJob(ctx);
  // 'sample' is the shared verdict for "priced and allowed". Live turns it into the customer's offer.
  return outcome.verdict === 'sample' ? mintAndSend(ctx, outcome.option) : outcome;
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
    const { verdict, reason } = await (run.mode === 'live' ? liveJob : shadowJob)(job, run);
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
 * The daily job. Returns counts only: { mode, jobs, sample, office, held, done, failed, reasons }, and in live
 * mode also `sent`, or `words_not_approved: true` when the offer template is not published (nothing is read).
 *   sample = both sample emails went to the office today (shadow).   sent = the customer got the offer today (live).
 *   office = the app cannot price this home.   held = the offer is not for this customer today.
 *   done   = sampled (shadow) or offered (live) on an earlier morning.
 * One job's failure never stops the others; it is counted and read again the next morning.
 * A morning in which the price settings refused a job and no home was priced raises one admin notification
 * (reportPriceSettings).
 */
async function runOnetimePlanOfferJob({ now = new Date(), deps: overrides = {} } = {}) {
  const mode = require('../config/feature-gates').onetimePlanOfferMode?.() || 'off';
  const summary = { mode, jobs: 0, sample: 0, office: 0, held: 0, done: 0, failed: 0, reasons: {} };
  if (mode !== 'shadow' && mode !== 'live') return summary;
  const deps = { ...defaultDeps(), ...overrides };
  if (mode === 'live') {
    summary.sent = 0;
    // The owner's publish of the offer template is his approval of the words. Until then no job is read.
    if (!(await offerWordsPublished(deps))) return { ...summary, words_not_approved: true };
  }
  const run = { mode, now, deps, priceSettings: { refused: 0, priced: 0 } };
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
  dueOfferOfJob,
  heldByOpenEstimate,
  offerTerms,
  JOB_SERVICE_KEYS,
  OFFER_TEMPLATE,
  REMINDER_TEMPLATE,
  TEMPLATE_VARIABLES,
  _test: { defaultDeps, offerPayload, sampleKey, offerKey, PRICE_SETTINGS_ALERT_KEY },
};
