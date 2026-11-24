/**
 * "Add a card" reminder email (owner 2026-11-24, "go with your recs"; dark behind GATE_CARD_ON_FILE_REMINDER).
 *
 * A customer whose last usable payment method was removed, or whose card passed its expiry month, gets ONE email 3
 * days later, only while every send-time rule still holds:
 *   (a) the customer has NO usable payment method now (same predicate the charge path uses: stripe id present, card not
 *       expired, bank not blocked). A card added before day 3 ends it. A customer who turned Auto Pay off on purpose
 *       and kept a usable card fails here, so that customer is never emailed;
 *   (b) a visit billed to the customer is still scheduled or a self-pay invoice is open (a visit billed to a
 *       third-party payer does not count: its payer is resolved per visit, like the invoice that visit will create);
 *   (c) the customer is active (not deleted, not churned or dormant, not inactive), is not on a collections dispute
 *       hold, and is not on an annual prepay with nothing due;
 *   (d) an expired card does not trigger the email when the customer had turned Auto Pay off on purpose (the last
 *       autopay event is a toggle off with no removal source);
 *   (e) at most one such email per customer per 30 days;
 *   (f) the billing email is valid, the customer's billing channels allow email, and no active suppression blocks it.
 *
 * Triggers (read-only, no hook in the removal paths):
 *   removed  a payment.method_removed email row for the customer (the notice the removal paths already send, so this
 *            needs GATE_PAYMENT_METHOD_CHANGE_EMAILS on). A removal that also turned Auto Pay off sends
 *            payment.autopay_disabled too, so method_removed alone covers it.
 *   expired  a stripe card whose expiry month ended 3 to 10 days ago. Needs no other gate.
 * The email is due 3 days after the event's ET calendar day and still sent up to 10 days after it, so a missed daily
 * pass or a restart window loses nothing. An older event never fires: flipping the gate does not mail old history.
 * The trigger is the customer's NEWEST loss of a usable method in the last 10 days: a card removed 5 days ago and the
 * last card removed yesterday waits until the day after tomorrow, never 2 days early on the older event.
 *
 * Modes (cardOnFileReminderMode): 'shadow' decides and writes one card_on_file_reminders row (outcome shadow) per
 * customer who WOULD get the email, sends nothing; 'true' sends and writes outcome sent. Shadow rows never block the
 * live send of the same event. Off = no query. Runs inside the daily 10:05 AM lifecycle sweep
 * (lifecycle-email-sweeps.js runDailySweeps): no new cron.
 *
 * The send re-runs every live check right before the provider request (sendCardOnFileReminder's
 * beforeProviderHandoff), and the customer's own notification and dispute-hold checks run again inside
 * sendLifecycleTemplate.
 *
 * Adding the card from the email never turns Auto Pay on: card_url opens the billing tab's Add card form in save-only
 * mode (add_card=1), which mints the SetupIntent with enroll_autopay=false (routes/billing-v2.js, the portal_add_method
 * webhook in routes/stripe-webhook.js).
 */

const db = require('../models/db');
const logger = require('./logger');
const { etDateString } = require('../utils/datetime-et');
const { dateOnlyString } = require('../utils/date-only');
const { propertyDisplayLabel } = require('../utils/property-display');
const { isExpiredCardMethod, isBankMethodType } = require('./autopay-eligibility');

const TEMPLATE_KEY = 'payment.card_on_file_reminder';
const TRANSACTIONAL_GROUP = 'transactional_required';
const DUE_AFTER_DAYS = 3;
// Still sent this long after the event (missed passes, restarts); an older event is history and never fires.
const GRACE_DAYS = 7;
const REPEAT_DAYS = 30;
const SENT_ISH = ['sent', 'delivered', 'opened', 'clicked'];
const DAY_MS = 86400000;

function plusDays(dateStr, days) {
  const base = new Date(`${dateStr}T00:00:00Z`);
  return new Date(base.getTime() + days * DAY_MS).toISOString().slice(0, 10);
}

function isEmailLike(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || '').trim());
}

function asObject(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
}

// First ET day the card no longer works: its expiry month is good through the month's last day (cardExpiryOutlook).
function expiredOnDate(method) {
  const month = Number(method.exp_month);
  const rawYear = Number(method.exp_year);
  const year = Number.isFinite(rawYear) && rawYear > 0 && rawYear < 100 ? rawYear + 2000 : rawYear;
  if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year)) return null;
  const nextYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  return `${nextYear}-${String(nextMonth).padStart(2, '0')}-01`;
}

// The (year, month) expiry months whose cards can have an event inside today's 0..10 day window (a card that lapsed
// in the last 2 days is not due yet, but it is still the customer's newest loss and postpones an older event).
function expiryMonthsInWindow(today) {
  const pairs = new Map();
  for (let age = 0; age <= DUE_AFTER_DAYS + GRACE_DAYS; age += 1) {
    const expiredOn = plusDays(today, -age);
    const [year, month] = plusDays(expiredOn, -1).split('-').map(Number);
    pairs.set(`${year}-${month}`, { year, month });
  }
  return [...pairs.values()];
}

// The customer's NEWEST event inside the 10-day window, kept only when that event is due (3 or more days old).
// Newer events are read too: they decide whether an older one has waited long enough. Map<customerId, { kind, key, on }>.
// `customerIds` scopes the read to those customers (the handoff re-check, the Postgres test's own rows).
async function collectEvents(today, now, customerIds = null) {
  const dueBy = plusDays(today, -DUE_AFTER_DAYS);
  const oldest = plusDays(today, -(DUE_AFTER_DAYS + GRACE_DAYS));
  const newest = new Map();
  const consider = (customerId, event) => {
    if (!customerId || event.on > today || event.on < oldest) return;
    const known = newest.get(String(customerId));
    if (!known || event.on > known.on) newest.set(String(customerId), event);
  };

  const removalQuery = db('email_messages')
    .where({ template_key: 'payment.method_removed', recipient_type: 'customer' })
    // A superset of the ET window: the exact day test is made on the ET calendar day below.
    .where('created_at', '>=', new Date(now.getTime() - (DUE_AFTER_DAYS + GRACE_DAYS + 2) * DAY_MS));
  if (customerIds) removalQuery.whereIn('recipient_id', customerIds.map(String));
  const removals = await removalQuery.select('id', 'recipient_id', 'created_at');
  for (const row of removals) {
    consider(row.recipient_id, { kind: 'removed', key: `removed:${row.id}`, on: etDateString(new Date(row.created_at)) });
  }

  const months = expiryMonthsInWindow(today);
  const cardQuery = db('payment_methods')
    .whereNotNull('stripe_payment_method_id')
    .where((qb) => {
      // exp_month and exp_year are text columns: Stripe saves '01'..'09', older rows hold '1'..'9' and 2-digit years.
      for (const { year, month } of months) {
        qb.orWhere((inner) => inner
          .whereIn('exp_year', [String(year), String(year - 2000)])
          .whereIn('exp_month', [String(month), String(month).padStart(2, '0')]));
      }
    });
  if (customerIds) cardQuery.whereIn('customer_id', customerIds);
  const cards = await cardQuery.select('id', 'customer_id', 'method_type', 'exp_month', 'exp_year');
  for (const card of cards) {
    if (isBankMethodType(card.method_type)) continue;
    const on = expiredOnDate(card);
    if (on) consider(card.customer_id, { kind: 'expired', key: `expired:${card.id}`, on });
  }
  const due = new Map();
  for (const [customerId, event] of newest) if (event.on <= dueBy) due.set(customerId, event);
  return due;
}

// Mirrors the charge path's methodEligibleForCharge (stripe.js): the method a charge could use.
function methodUsable(method, customer, now) {
  if (!method.stripe_payment_method_id) return false;
  if (isExpiredCardMethod(method, now)) return false;
  if (isBankMethodType(method.method_type)) {
    if (customer.ach_status && customer.ach_status !== 'active') return false;
    if (['pending_verification', 'verification_failed'].includes(method.ach_status)) return false;
  }
  return true;
}

// Customer turned Auto Pay off with the toggle (an autopay_disabled event with no removal or card-swap source), and
// nothing turned it back on.
async function autopayTurnedOffOnPurpose(customer) {
  if (customer.autopay_enabled !== false) return false;
  const last = await db('autopay_log')
    .where({ customer_id: customer.id })
    .whereIn('event_type', ['autopay_enabled', 'autopay_disabled'])
    .orderBy('created_at', 'desc')
    .first('event_type', 'details');
  return last?.event_type === 'autopay_disabled' && !asObject(last.details).source;
}

// Upcoming visits are read in pages, in a stable order, until one bills the customer or they run out. A customer with
// more than VISIT_PAGES pages is not judged either way: the read throws and the customer fails closed.
const VISIT_PAGE = 25;
const VISIT_PAGES = 16;

// The soonest upcoming visit that bills the CUSTOMER: each visit's payer is resolved with its own id, because a
// third-party Bill-To can be set on one visit alone. { visit, payerBilled }: payerBilled says visits existed and every
// one of them bills someone else. A payer lookup failure throws (the caller fails closed).
async function nextSelfPayVisit(customerId, today) {
  const { whereVisitRowLive } = require('./customer-lifecycle-guard');
  const payerService = require('./payer');
  let seen = 0;
  for (let page = 0; page < VISIT_PAGES; page += 1) {
    const visits = await db('scheduled_services')
      .where({ customer_id: customerId })
      .where(function liveVisit() { whereVisitRowLive(this, today); })
      .where('scheduled_date', '>=', today)
      .orderBy([{ column: 'scheduled_date', order: 'asc' }, { column: 'id', order: 'asc' }])
      .limit(VISIT_PAGE)
      .offset(page * VISIT_PAGE)
      .select('id', 'scheduled_date', 'service_address_line1', 'service_address_line2', 'service_address_city', 'service_address_state', 'service_address_zip');
    for (const visit of visits) {
      const payer = await payerService.resolveForInvoice({ customerId, scheduledServiceId: visit.id, throwOnError: true });
      if (!payer?.payerId) return { visit, payerBilled: false };
    }
    seen += visits.length;
    if (visits.length < VISIT_PAGE) return { visit: null, payerBilled: seen > 0 };
  }
  throw new Error(`more than ${VISIT_PAGE * VISIT_PAGES} upcoming visits`);
}

// Where the email says the visits are: the visit's own address when the booking stamped one (a secondary saved
// property), else the customer's profile address.
function visitPropertyLabel(customer, visit) {
  if (visit?.service_address_line1) {
    return propertyDisplayLabel({
      address_line1: visit.service_address_line1,
      address_line2: visit.service_address_line2,
      city: visit.service_address_city,
      state: visit.service_address_state,
      zip: visit.service_address_zip,
    });
  }
  return propertyDisplayLabel(customer);
}

// The billing email the lifecycle sender would use, and whether anything blocks it (rule f).
async function emailVerdict(customer) {
  const { getInvoiceEmailRecipients } = require('./customer-contact');
  const { billingChannelAllowed } = require('./billing-delivery-channels');
  const EmailTemplateLibrary = require('./email-template-library');
  let prefs;
  try {
    prefs = await db('notification_prefs').where({ customer_id: customer.id }).first();
  } catch (err) {
    logger.warn(`[card-on-file-reminder] notification_prefs lookup failed for ${customer.id}: ${err.message}`);
    return { ok: false, reason: 'prefs_unavailable' };
  }
  if (billingChannelAllowed(prefs || {}, 'billing', 'email') === false) return { ok: false, reason: 'billing_email_not_selected' };
  const [recipient] = getInvoiceEmailRecipients(customer, prefs || {}).filter((entry) => isEmailLike(entry.email));
  if (!recipient) return { ok: false, reason: 'missing_email' };
  const loaded = await EmailTemplateLibrary.loadTemplateByKey(TEMPLATE_KEY);
  if (!loaded?.template || loaded.template.status !== 'active' || !loaded.activeVersion) return { ok: false, reason: 'template_inactive' };
  const suppression = await EmailTemplateLibrary.activeSuppressionFor(loaded.template, recipient.email, TRANSACTIONAL_GROUP);
  if (suppression) return { ok: false, reason: 'email_suppressed' };
  return { ok: true };
}

const CUSTOMER_COLUMNS = [
  'id', 'first_name', 'last_name', 'company_name', 'email', 'phone', 'active', 'deleted_at', 'pipeline_stage',
  'autopay_enabled', 'ach_status', 'address_line1', 'address_line2', 'city', 'state', 'zip', 'profile_label',
];

// Every rule that depends on the customer's live state, in cheap-first order. Run before the decision and again right
// before the provider request. { ok: true, customer, nextVisitDate } or { ok: false, reason }.
async function liveVerdict(customerId, event, today, now) {
  const customer = await db('customers').where({ id: customerId }).first(CUSTOMER_COLUMNS);
  if (!customer) return { ok: false, reason: 'customer_not_found' };
  if (customer.deleted_at || customer.active === false || ['churned', 'dormant'].includes(customer.pipeline_stage)) {
    return { ok: false, reason: 'customer_not_active' };
  }
  const methods = await db('payment_methods').where({ customer_id: customerId });
  if (methods.some((method) => methodUsable(method, customer, now))) return { ok: false, reason: 'has_usable_method' };
  if (event.kind === 'expired' && await autopayTurnedOffOnPurpose(customer)) return { ok: false, reason: 'autopay_off_on_purpose' };

  // A collections dispute hold withholds the notice (its link is billing follow-up): decided here, before a shadow row
  // can count the customer, and read again by the sender at the provider boundary. Fails closed.
  const held = await require('./collections/collection-hold').messagingHeldByCollectionHold(customerId);
  if (held.held) return { ok: false, reason: 'collection_hold' };

  let upcoming;
  let openInvoice;
  try {
    [upcoming, openInvoice] = await Promise.all([
      nextSelfPayVisit(customerId, today),
      require('./open-balance').openBalanceExists(customerId),
    ]);
  } catch (err) {
    logger.warn(`[card-on-file-reminder] payer check failed for ${customerId}: ${err.message}`);
    return { ok: false, reason: 'payer_check_failed' };
  }
  const visit = upcoming.visit;
  if (!visit && openInvoice !== true) return { ok: false, reason: upcoming.payerBilled ? 'payer_billed' : 'nothing_upcoming' };
  if (openInvoice !== true && await require('./customer-lifecycle-guard').findActivePrepayTerm(db, customerId)) {
    return { ok: false, reason: 'prepaid_nothing_due' };
  }
  const email = await emailVerdict(customer);
  if (!email.ok) return email;
  return {
    ok: true,
    customer,
    nextVisitDate: visit ? dateOnlyString(visit.scheduled_date) : null,
    propertyLabel: visitPropertyLabel(customer, visit),
  };
}

// Rule (e). Shadow rows count only against shadow runs, so the flip to 'true' still sends what shadow recorded.
async function sentWithinRepeatWindow(customerId, mode, now) {
  const since = new Date(now.getTime() - REPEAT_DAYS * DAY_MS);
  const outcomes = mode === 'true' ? ['sent'] : ['sent', 'shadow'];
  const row = await db('card_on_file_reminders')
    .where({ customer_id: customerId })
    .whereIn('outcome', outcomes)
    .where('created_at', '>=', since)
    .first('id');
  if (row) return true;
  if (mode !== 'true') return false;
  // Belt: a send whose ledger row was lost still blocks a second email.
  const email = await db('email_messages')
    .where({ template_key: TEMPLATE_KEY, recipient_id: String(customerId) })
    .whereIn('status', SENT_ISH)
    .where('sent_at', '>=', since)
    .first('id');
  return !!email;
}

async function record(customerId, event, outcome, { nextVisitDate = null, idempotencyKey = null } = {}) {
  let emailMessageId = null;
  if (idempotencyKey) {
    const message = await db('email_messages').where({ idempotency_key: idempotencyKey }).first('id');
    emailMessageId = message?.id || null;
  }
  await db('card_on_file_reminders')
    .insert({
      customer_id: customerId,
      trigger_kind: event.kind,
      trigger_key: event.key,
      trigger_on: event.on,
      outcome,
      next_visit_date: nextVisitDate,
      email_message_id: emailMessageId,
    })
    .onConflict(['customer_id', 'trigger_key', 'outcome'])
    .ignore();
}

async function decideOne(customerId, event, mode, today, now) {
  const verdict = await liveVerdict(customerId, event, today, now);
  if (!verdict.ok) return { result: 'skipped', reason: verdict.reason };
  if (await sentWithinRepeatWindow(customerId, mode, now)) return { result: 'skipped', reason: 'sent_within_30_days' };

  if (mode === 'shadow') {
    await record(customerId, event, 'shadow', { nextVisitDate: verdict.nextVisitDate });
    logger.info(`[card-on-file-reminder] SHADOW would send to customer ${customerId} (${event.kind} ${event.on}, next visit ${verdict.nextVisitDate || 'none'})`);
    return { result: 'shadow' };
  }

  const idempotencyKey = `${TEMPLATE_KEY}:${customerId}:${event.key}`;
  const sent = await require('./payment-lifecycle-email').sendCardOnFileReminder({
    customerId,
    propertyLabel: verdict.propertyLabel,
    nextVisitDate: verdict.nextVisitDate,
    idempotencyKey,
    // The last look, right before the provider request: a card added or an address suppressed in the meantime stops
    // the send, and so does a change to what the email says (a visit moved or cancelled, the address edited): the next
    // daily pass decides again and sends the current facts.
    beforeProviderHandoff: async () => {
      const handoffAt = new Date();
      const handoffToday = etDateString(handoffAt);
      // The customer's newest loss must still be the due event this send was decided on: a card removed after the
      // sweep read its events makes a newer one that is not due yet.
      const current = (await collectEvents(handoffToday, handoffAt, [customerId])).get(String(customerId));
      const again = current?.key === event.key ? await liveVerdict(customerId, event, handoffToday, handoffAt) : null;
      let reason = null;
      if (!again) reason = 'event_changed';
      else if (!again.ok) reason = again.reason;
      else if (again.nextVisitDate !== verdict.nextVisitDate || again.propertyLabel !== verdict.propertyLabel) reason = 'details_changed';
      if (reason) logger.info(`[card-on-file-reminder] send for customer ${customerId} stopped at the provider handoff: ${reason}`);
      return !reason;
    },
  });
  if (!sent.ok) return { result: 'not_sent', reason: sent.reason || 'email_not_sent' };
  await record(customerId, event, 'sent', { nextVisitDate: verdict.nextVisitDate, idempotencyKey });
  return { result: 'sent' };
}

// `customerIds` narrows one run to those customers (the Postgres test's own rows); the daily sweep passes none.
async function runCardOnFileReminderSweep({ now = new Date(), customerIds = null } = {}) {
  const mode = require('../config/feature-gates').cardOnFileReminderMode();
  if (mode === 'off') return { mode, candidates: 0, sent: 0, shadow: 0 };
  const today = etDateString(now);
  const events = await collectEvents(today, now, customerIds);
  const summary = { mode, candidates: events.size, sent: 0, shadow: 0, skipped: {}, failed: 0 };
  for (const [customerId, event] of events) {
    try {
      const outcome = await decideOne(customerId, event, mode, today, now);
      if (outcome.result === 'sent') summary.sent += 1;
      else if (outcome.result === 'shadow') summary.shadow += 1;
      else {
        const reason = outcome.reason || outcome.result;
        summary.skipped[reason] = (summary.skipped[reason] || 0) + 1;
      }
    } catch (err) {
      summary.failed += 1;
      logger.error(`[card-on-file-reminder] customer ${customerId} failed: ${err.message}`);
    }
  }
  logger.info(`[card-on-file-reminder] ${mode}: ${JSON.stringify(summary)}`);
  return summary;
}

module.exports = {
  runCardOnFileReminderSweep,
  TEMPLATE_KEY,
  _private: { collectEvents, liveVerdict, methodUsable, expiredOnDate, expiryMonthsInWindow, plusDays, decideOne, nextSelfPayVisit },
};
