/**
 * Billing type + per-application fee edits from the Intelligence Bar
 * (owner ruling D5, 2026-10-06: "switch Garcia to per-application at $147").
 *
 * A small extension of update_customer, dark behind GATE_IB_BILLING_MODE_EDIT
 * (strict 'true'). Off, billing_mode and per_application_fee stay refused as
 * unsupported fields, exactly as before.
 *
 * On:
 *   - The two fields go on their own card (no other field in the same edit),
 *     never owner-direct (owner-direct.js DIRECT_CUSTOMER_FIELDS lacks them).
 *   - The billing type is checked with the SAME rules the customer page's
 *     save applies (services/billing-mode-rules.js, shared with
 *     PUT /api/admin/customers/:id): monthly membership needs a monthly rate,
 *     per application needs a fee (the one on file or the one on this card),
 *     per visit / one time need every upcoming billable visit priced.
 *   - Refused here although the customer page allows them, because the bar
 *     would have to reproduce what that page or the annual-prepay flow does:
 *       * annual prepay, to or from, or while a live annual-prepay term covers
 *         today (the lane follows the paid annual invoice and its term);
 *       * clearing the billing type to "Not set";
 *       * a change that turns a customer into a member, where the customer
 *         page sends the membership welcome email (the bar sends no message);
 *       * any edit for a customer with a Bill-To payer (on the customer or on
 *         an upcoming visit);
 *       * a move to monthly membership for a customer the dues run would not
 *         charge (monthly-dues-eligibility.js, the cron's own cohort and
 *         guards: Auto Pay off or paused, inactive or service-paused, annual
 *         prepay covering or pending, no chargeable saved method);
 *       * leaving monthly membership while a failed MONTHLY dues payment's
 *         retry is armed (the retry ladder stops for a non-monthly lane), or
 *         while this month's dues charge has an unsettled Stripe outcome
 *         (retry-collectibility.js hasUnresolvedSiblingStripeOutcome).
 *   - Refused too: a customer whose completed visit is still finalizing its billing
 *     (billing_completion_pending: the completion attempt row is the durable fence),
 *     and any live upcoming visit that carries a price, a prepayment,
 *     create-invoice-on-complete or an invoice of any kind (billing_visits_priced).
 *     The card does not predict per-visit charges (price, tax, surcharge,
 *     prepayment, invoices and dues coverage all move completion's amount); the
 *     customer page shows each visit's charge.
 *   - The card shows the billing type and fee before -> after in words, the
 *     rule the new lane applies (no amounts), the saved method future charges
 *     go to by tender family, and that no customer message is sent.
 *   - Pinned with the customer version: the billing fields, payer and Auto Pay
 *     state, each upcoming visit's billing columns and invoices, the count of
 *     visits that carry billing, the saved method's family / last four / id,
 *     and the call-time state of the gates the wording reads. At commit, under
 *     the customer row lock, a changed pin or a rule that no longer holds
 *     refuses as preview_changed. The commit also holds the customer's
 *     billing-collection claim (customer-billing-lock.js, the key the dues cron
 *     and the retry sweep hold while they collect) and locks the upcoming
 *     visits FOR UPDATE (the Schedule save's own row lock), so no collector and
 *     no visit edit lands between the final check and the write.
 *
 * The write is the two columns only. The customer page's save also writes a
 * sensitive-field audit row for billing_mode and may send the membership
 * welcome email; neither is needed for the billing to be right (the bar keeps
 * its own action record), and the email case is refused above.
 */
const db = require('../../models/db');
const BillingModeRules = require('../billing-mode-rules');
const { resolveBillingLane } = require('../billing-lane');

const BILLING_EDIT_FIELDS = ['billing_mode', 'per_application_fee'];
// decimal(10,2) — migration 20260709000010.
const FEE_MAX = 99999999.99;

const LANE_WORDS = {
  monthly_membership: 'billed by monthly membership (dues each month)',
  per_application: 'billed per application (each visit)',
  per_visit: "billed per visit (each visit's own price)",
  one_time: "one-time job (each visit's own price)",
  annual_prepay: 'annual prepay (paid up front for the year)',
};

const GATE_OFF = 'Changing the billing type or per-application fee from the bar is turned off (GATE_IB_BILLING_MODE_EDIT). Nothing was changed.';

function billingEditLive() {
  return require('../../config/feature-gates').ibBillingModeEditLive();
}

function money(n) {
  return `$${Number(n || 0).toFixed(2)}`;
}

function hasBillingEdit(updates) {
  return !!updates && typeof updates === 'object' && BILLING_EDIT_FIELDS.some((k) => k in updates);
}

function laneWords(customer) {
  const { mode, source } = resolveBillingLane(customer);
  return source === 'inferred' ? `not set (treated as ${LANE_WORDS[mode]})` : LANE_WORDS[mode];
}

function feeWords(fee) {
  return Number(fee) > 0 ? money(fee) : 'none on file';
}

const refuse = (error, code) => ({ error, code });

// The per-application fee the card would write: a positive dollar amount with
// at most two decimals that fits the column. Anything else is refused.
function parseFee(value) {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[$,\s]/g, ''));
  if (value === null || value === '' || !Number.isFinite(n) || n <= 0 || n > FEE_MAX) return null;
  return Math.abs(n * 100 - Math.round(n * 100)) < 1e-6 ? Math.round(n * 100) / 100 : null;
}

const MODE_REFUSALS = {
  annual_prepay: ['Annual prepay is set by the paid annual invoice and its term, not from the bar. Nothing was proposed.', 'annual_prepay_lane'],
  '': ['Clearing the billing type ("Not set") is done on the customer page. Pick per_application, per_visit, one_time or monthly_membership. Nothing was proposed.', 'billing_mode_clear'],
};

/**
 * Read the two fields off the model's updates. Returns { fields } or a
 * refusal ({ error, code }). Shared by the proposal and the executor.
 */
function parseBillingEdit(updates) {
  const keys = Object.keys(updates || {});
  if (keys.some((k) => !BILLING_EDIT_FIELDS.includes(k))) {
    return refuse('Change the billing type or per-application fee on its own card: send only billing_mode and per_application_fee, then make the other changes in a separate update_customer call. Nothing was proposed.', 'billing_edit_alone');
  }
  const fields = {};
  if ('billing_mode' in updates) {
    const mode = updates.billing_mode == null ? '' : String(updates.billing_mode);
    if (MODE_REFUSALS[mode]) return refuse(...MODE_REFUSALS[mode]);
    if (!LANE_WORDS[mode]) return refuse(BillingModeRules.INVALID_BILLING_MODE, 'invalid_billing_mode');
    fields.billing_mode = mode;
  }
  if ('per_application_fee' in updates) {
    const fee = parseFee(updates.per_application_fee);
    if (fee === null) return refuse('per_application_fee must be a dollar amount above $0 with at most two decimals (for example 147 or 147.50). Nothing was proposed.', 'invalid_per_application_fee');
    fields.per_application_fee = fee;
  }
  return { fields };
}

// What the card was built from, compared under the row lock at commit: the
// billing fields, the Bill-To payer and the Auto Pay state the rules read.
function billingPin(row) {
  return JSON.stringify([
    row?.billing_mode || null,
    Number(row?.per_application_fee) > 0 ? Number(row.per_application_fee).toFixed(2) : null,
    Number(row?.monthly_rate || 0).toFixed(2),
    row?.waveguard_tier || null,
    row?.waveguard_tier_source || null,
    row?.payer_id == null ? null : String(row.payer_id),
    row?.autopay_enabled === false ? false : (row?.autopay_enabled ?? null),
    row?.autopay_paused_until == null ? null : String(row.autopay_paused_until instanceof Date
      ? row.autopay_paused_until.toISOString() : row.autopay_paused_until).slice(0, 10),
  ]);
}

// The upcoming visits the card's projection and the payer check read, in a
// stable order. Their billing fields are pinned (visitsPin) with the card.
const VISIT_COLUMNS = ['id', 'status', 'scheduled_date', 'estimated_price', 'primary_line_price',
  'prepaid_amount', 'prepaid_method', 'is_callback', 'service_type', 'payer_id', 'is_recurring',
  'create_invoice_on_complete', 'source_estimate_id'];

// No cut on the card or the pin: every live visit is projected, pinned and
// locked, so a visit past any page size still counts for the payer rule and the
// totals. Past this many the card is refused instead of read in part.
const VISIT_HARD_LIMIT = 2000;

// A visit that already carries an invoice is not minted a new one, whatever the
// invoice's state: the card refuses it (pricedVisitCount) rather than predict
// completion's reuse / park outcome. Detection is completion's own: the
// invoices attached to the visit (completionInvoicesOnVisits) and the sibling
// first-application invoice of the same estimate and day
// (estimate-first-application-invoice.js, the lookup completion asks, which also
// finds a combined invoice another visit of the estimate carries). Each visit
// gets invoice_id / sibling_invoice_id, which are pinned with the card.
async function withVisitInvoices(dbh, visits, customerId, { lock = false } = {}) {
  const { completionInvoicesOnVisits } = require('../completion-invoice-candidate');
  const { findFirstApplicationInvoiceForEstimateService } = require('../estimate-first-application-invoice');
  const rows = await completionInvoicesOnVisits(dbh, visits.map((v) => v.id), { lock });
  const own = new Map();
  for (const r of rows) if (!own.has(String(r.scheduled_service_id))) own.set(String(r.scheduled_service_id), r.id);
  const out = [];
  for (const v of visits) {
    const row = { ...v, invoice_id: own.get(String(v.id)) ?? null, sibling_invoice_id: null };
    // Only a visit from an accepted estimate can have a sibling invoice, and one
    // that carries nothing yet is the only one that needs the lookup.
    if (v.source_estimate_id && !hasOwnBilling(row)) {
      const prior = await findFirstApplicationInvoiceForEstimateService({ ...v, customer_id: customerId }, dbh, lock ? { lockRows: true, noWait: true } : {});
      row.sibling_invoice_id = [prior.invoice, prior.liveBeside, prior.canceledSetupFee].find(Boolean)?.id ?? null;
    }
    out.push(row);
  }
  return out;
}

const positive = (x) => x != null && x !== '' && Number(x) > 0;

// A visit's own money, read off its row: a price (or the base price a discount
// froze to $0), a deliberate $0 stamp, a prepayment, an invoice created on
// completion, or an invoice already attached.
function hasOwnBilling(v) {
  const stampedZero = v.estimated_price != null && v.estimated_price !== '' && Number(v.estimated_price) === 0 && !v.is_callback;
  return positive(v.estimated_price) || positive(v.primary_line_price) || stampedZero || positive(v.prepaid_amount)
    || v.create_invoice_on_complete === true || !!v.invoice_id;
}

// Upcoming visits that carry a price, a prepayment or an invoice of any kind.
const pricedVisitCount = (visits) => (visits || []).filter((v) => hasOwnBilling(v) || v.sibling_invoice_id).length;

async function upcomingVisits(dbh, customerId, { lock = false } = {}) {
  const { etDateString } = require('../../utils/datetime-et');
  // Every live visit that can still complete against the new lane: the
  // lifecycle guard's own clause (en_route / on_site included), the same one
  // billing-mode-rules.js uses for the unpriced-visit check.
  const { whereVisitRowLive } = require('../customer-lifecycle-guard');
  const today = etDateString();
  const base = () => dbh('scheduled_services')
    .where({ customer_id: customerId })
    .where(function live() { whereVisitRowLive(this, today); })
    .select(VISIT_COLUMNS);
  const ordered = async () => withVisitInvoices(dbh, await base().orderBy('scheduled_date', 'asc').orderBy('id', 'asc').limit(VISIT_HARD_LIMIT + 1), customerId, { lock });
  if (!lock) return ordered();
  // At commit: lock every candidate visit FOR UPDATE, the row lock the
  // Schedule save takes (admin-schedule.js PUT /:id/update-details: customer
  // row first, then the visit row), in id order so two writers locking more
  // than one visit never cross. The projection is read AFTER the locks, with
  // the card's own ordering and cut: a save that committed first is seen, and
  // one that has not is held off until this transaction ends. The visits'
  // invoices are then locked too (withVisitInvoices), last: customers -> claim
  // -> visits -> invoices, with NOWAIT on the invoices.
  await base().orderBy('id', 'asc').limit(VISIT_HARD_LIMIT + 1).forUpdate();
  return ordered();
}

const PIN_COLUMNS = [...VISIT_COLUMNS, 'invoice_id', 'sibling_invoice_id'];

function visitsPin(visits) {
  return JSON.stringify((visits || []).map((v) => PIN_COLUMNS.map((c) => {
    const value = v[c];
    if (value == null) return null;
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  })));
}

// The collection context the card words and pins: Auto Pay chargeable (the
// saved-method walk the dues run and charge() use), the tender family, last four
// and id of the method that walk picks (card or bank/ACH), and the call-time
// state of every gate the card's wording depends on: GATE_COMPLETION_AUTOPAY_CHARGE
// (whether a per-visit lane charges the saved method at completion) and
// GATE_STAMPED_ZERO_FREE (billing-lane.js, how a stamped $0 reads). Enumerated
// from billing-lane.js and monthly-dues-eligibility.js, which read no other gate.
const NO_CHARGE_CONTEXT = { autopayActive: false, gate: false, stampedZero: false, family: null, last4: null, methodId: null };

const AUTOPAY_UNVERIFIED = 'Could not verify Auto Pay eligibility. Try again in a moment. Nothing was changed.';

// The chargeable saved method's tender family and last four. The same walk
// completion's auto-charge uses (autopay-eligibility getChargeableAutopayMethod,
// bank = isBankMethodType, the rule charge() classifies by), read fail-closed.
async function savedMethodFacts(dbh, customerId) {
  const { getChargeableAutopayMethod, isBankMethodType } = require('../autopay-eligibility');
  const method = await getChargeableAutopayMethod({ id: customerId }, dbh, { rethrow: true });
  if (!method) return { family: null, last4: null, methodId: null };
  const detail = await dbh('payment_methods').where({ id: method.id }).first('last_four', 'bank_last_four');
  const bank = isBankMethodType(method.method_type);
  const last4 = (bank ? detail?.bank_last_four || detail?.last_four : detail?.last_four) || null;
  return { family: bank ? 'bank' : 'card', last4: last4 ? String(last4) : null, methodId: String(method.id) };
}

// The lookup runs fail-closed (customerOnAutopay failClosed: a broken read
// throws instead of reading as "no saved method"), so the card never says
// "invoiced" while completion may still charge the saved method. An unreadable
// lookup throws an error carrying `billingUnverified` ({ message, code }).
async function chargeContext(dbh, customerId, row) {
  const gates = require('../../config/feature-gates');
  let autopayActive;
  let method = { family: null, last4: null, methodId: null };
  try {
    autopayActive = await require('../autopay-eligibility').customerOnAutopay({
      id: customerId, autopay_enabled: row.autopay_enabled, autopay_paused_until: row.autopay_paused_until,
    }, { db: dbh, failClosed: true });
    if (autopayActive) method = await savedMethodFacts(dbh, customerId);
  } catch (e) {
    throw Object.assign(new Error(AUTOPAY_UNVERIFIED), { billingUnverified: { message: AUTOPAY_UNVERIFIED, code: 'billing_autopay_unverified' }, cause: e });
  }
  return {
    autopayActive: !!autopayActive,
    gate: !!gates.isEnabled('completionAutopayCharge'),
    stampedZero: !!gates.stampedZeroFreeLive(),
    ...method,
  };
}

// What the card was built from, as one string compared under the lock at commit:
// the billing fields, every upcoming visit's billing columns and invoices, the
// count of visits that carry billing (always 0 on a card that was shown), the
// collection context, and the open membership-dues invoices.
function cardPin(row, visits, fields = {}, charge = NO_CHARGE_CONTEXT, openDues = []) {
  const dues = openDues.map((d) => [String(d.id), d.total == null ? null : String(d.total), d.status]);
  const method = [charge.family || '', charge.last4 || '', charge.methodId || ''];
  const gates = `${+charge.autopayActive}${+charge.gate}${+charge.stampedZero}`;
  return `${billingPin(row)}|${visitsPin(visits)}|${pricedVisitCount(visits)}|${gates}|${JSON.stringify(method)}|${JSON.stringify(dues)}`;
}

// The customer page's save sends the membership welcome email when an edit
// turns a non-member into a member (admin-customers.js PUT, the
// !beforeHasMembership && afterHasMembership branch). The bar sends no message,
// so that edit is refused here.
function startsMembership(before, after) {
  const { hasMembership } = require('../membership-state');
  const { isAutoDerivedTierLabelRow } = require('../self-booking-plan-sync');
  const member = (row) => hasMembership(row) && !isAutoDerivedTierLabelRow(row);
  return !member(before) && member(after);
}

// '2026-10' -> 'October 2026'.
const monthLabel = (key) => new Date(`${key}-01T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// Refusals where the bar would have to reproduce what another flow does.
// Each check gets { dbh, customerId, row, after, fields, visits, laneBefore,
// laneAfter } and returns a refusal or null; the first refusal wins.
const SIDE_FLOW_CHECKS = [
  // Payer-billed visits go to the Bill-To payer's AP invoice
  // (payer.js resolveForInvoice reads customers.payer_id and each visit's own
  // scheduled_services.payer_id): a payer on the customer or on any upcoming
  // visit keeps billing changes on the customer page.
  ({ row, visits }) => (row.payer_id || visits.some((v) => v.payer_id)
    ? refuse('This customer has a Bill-To payer — change billing on the customer page. Nothing was proposed.', 'bill_to_payer') : null),
  // A move INTO monthly membership needs a customer the dues run would really
  // charge: the cron's own cohort and guards plus a chargeable saved method
  // (monthly-dues-eligibility.js, shared with billing-cron.js). Any reason the
  // run would skip them refuses; the card never promises a charge the run
  // will not make.
  async ({ dbh, customerId, fields, laneAfter, laneBefore }) => {
    if (laneAfter !== 'monthly_membership' || laneBefore === 'monthly_membership') return null;
    const verdict = await require('../monthly-dues-eligibility')
      .monthlyDuesVerdict(dbh, customerId, { overrides: fields });
    if (verdict.eligible) return null;
    return ['skipped_disabled', 'skipped_paused'].includes(verdict.reason)
      ? refuse('Turn on Auto Pay first; the monthly dues run skips customers without it. Nothing was proposed.', 'autopay_off')
      : refuse(`${verdict.message} Fix that first. Nothing was proposed.`, 'dues_not_collectible');
  },
  // Leaving the monthly lane stops the retry ladder of a failed MONTHLY dues
  // charge (billing-cron.js LANE_NOT_MONTHLY). The sweep's own selection
  // (retry-collectibility.js armedRetryQuery) narrowed by its own monthly
  // classifier (isMonthlyObligationRow): a failed one-time or per-application
  // charge keeps retrying whatever the lane, so it does not block the change.
  // It also waits for a dues charge whose Stripe outcome is not settled: the
  // cron's own verdict (retry-collectibility.js hasUnresolvedSiblingStripeOutcome)
  // for this ET month's dues, which covers an unresolved invoice-less
  // stripe_orphan_charges row and a failed dues attempt parked with
  // metadata.ambiguous_outcome.
  async ({ dbh, customerId, laneBefore, laneAfter }) => {
    if (laneBefore !== 'monthly_membership' || laneAfter === 'monthly_membership') return null;
    const { armedRetryQuery, isMonthlyObligationRow, hasUnresolvedSiblingStripeOutcome } = require('../retry-collectibility');
    const armed = await armedRetryQuery(dbh, { customerIds: [customerId] }).select('id', 'description');
    if ((armed || []).some(isMonthlyObligationRow)) {
      return refuse('This customer has a dues retry scheduled — resolve it on the billing page first. Nothing was proposed.', 'dues_retry_armed');
    }
    const monthKey = require('../../utils/datetime-et').etDateString().slice(0, 7);
    const outcome = await hasUnresolvedSiblingStripeOutcome(customerId, monthKey, dbh);
    return outcome.blocked
      ? refuse(`A dues charge for ${monthLabel(monthKey)} is still being reconciled with Stripe; try again after it settles. Nothing was proposed.`, 'dues_outcome_unresolved') : null;
  },
  // The customer page's save sends the membership welcome email when an edit
  // turns a non-member into a member (admin-customers.js PUT, the
  // !beforeHasMembership && afterHasMembership branch). The bar sends no message.
  ({ row, after }) => (startsMembership(row, after)
    ? refuse('This change would make the customer a member. The customer page sends the membership welcome email for that, so make this change there. Nothing was proposed.', 'starts_membership') : null),
];

function unchangedEdit(row, fields) {
  return BILLING_EDIT_FIELDS.every((k) => !(k in fields)
    || (k === 'per_application_fee' ? Number(row[k] || 0).toFixed(2) === Number(fields[k]).toFixed(2) : row[k] === fields[k]));
}

// The customer page's own billing-type rules (billing-mode-rules.js).
async function customerPageRefusal(dbh, customerId, row, fields) {
  if (fields.billing_mode === undefined) return null;
  const message = await BillingModeRules.billingModeRefusal(fields.billing_mode, {
    requestedMonthlyRate: undefined,
    requestedPerApplicationFee: fields.per_application_fee,
    loadRates: async () => row,
    loadLiveAnnualTerm: () => BillingModeRules.liveAnnualPrepayTerm(dbh, customerId),
    loadUnpricedFutureVisits: (customerOverride) => BillingModeRules.unpricedFutureBillableVisits(dbh, customerId, { customerOverride }),
  });
  return message ? refuse(`${message}${message.endsWith('.') ? '' : '.'} Nothing was proposed.`, 'billing_mode_rule') : null;
}

/**
 * The refusal for applying `fields` to the customer `row`, or null. Runs at
 * proposal and again at commit under the row lock (dbh = that transaction).
 * `visits` is upcomingVisits() read on the same handle.
 */
async function billingEditRefusal(dbh, customerId, row, fields, visits) {
  if (visits.length > VISIT_HARD_LIMIT) return refuse('This customer has too many upcoming visits to confirm from the bar; change it on the customer page. Nothing was proposed.', 'too_many_visits');
  if (row.billing_mode === 'annual_prepay') return refuse('This customer is on annual prepay; that lane follows the annual invoice and its term, so it is not changed from the bar. Nothing was proposed.', 'annual_prepay_lane');
  if (unchangedEdit(row, fields)) return refuse('The billing type and per-application fee are already set that way. Nothing was proposed.', 'no_change');
  if (await BillingModeRules.liveAnnualPrepayTerm(dbh, customerId)) {
    return refuse('This customer has an annual prepay term covering today, so the billing type is not changed from the bar. Nothing was proposed.', 'live_annual_prepay_term');
  }
  // A completion that committed its record but has not finished billing still
  // holds the billing type it read at entry (and its visit is completed, so no
  // visit check sees it): the durable attempt row is the fence
  // (completion-attempts.js customerHasCompletionInFlight). Under the commit's
  // customer lock no new completion can reach that state, so a clear read holds.
  if (await require('../completion-attempts').customerHasCompletionInFlight(customerId, dbh)) {
    return refuse('A visit for this customer was just completed and its billing is still being finalized. Try again in a few minutes. Nothing was proposed.', 'billing_completion_pending');
  }
  // The card does not predict per-visit charges (price, tax, surcharge,
  // prepayment, invoices, dues coverage all move completion's amount): a visit
  // that carries any of them keeps the change on the customer page, which shows
  // each visit's charge.
  const priced = pricedVisitCount(visits);
  if (priced > 0) {
    return refuse(`This customer has ${plural(priced, 'upcoming visit', 'upcoming visits')} with a price, a prepayment or an invoice. The bar changes the billing type only when no upcoming visit carries one; change it on the customer page, which shows each visit's charge. Nothing was changed.`, 'billing_visits_priced');
  }
  const pageRefusal = await customerPageRefusal(dbh, customerId, row, fields);
  if (pageRefusal) return pageRefusal;
  const after = { ...row, ...fields };
  const ctx = {
    dbh, customerId, row, after, fields, visits,
    laneBefore: resolveBillingLane(row).mode, laneAfter: resolveBillingLane(after).mode,
  };
  for (const check of SIDE_FLOW_CHECKS) {
    const refusal = await check(ctx);
    if (refusal) return refusal;
  }
  return null;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One renderer for every lane. Data, not branches: the line each lane opens
// with. No per-visit amount is projected (see billingEditRefusal): the card
// states the rule, and a customer with any priced, prepaid or invoiced upcoming
// visit never reaches it.
const SALES_TAX = 'Sales tax is added where it applies.';
const LANE_HEAD = {
  per_application: ({ after }) => `Each completed visit is charged the ${money(after.per_application_fee)} per-application fee. Callbacks and free visit types bill nothing. No monthly dues charge. ${SALES_TAX}`,
  monthly_membership: ({ after, dues, visits }) => (dues && !dues.eligible
    // Promised only when the dues run really charges this customer
    // (monthly-dues-eligibility.js); a move into monthly is refused unless
    // they are collectible, a customer already monthly is checked here.
    ? `The ${money(after.monthly_rate)} monthly rate is NOT charged by the dues run right now. ${dues.message} Recurring plan visits are not covered by dues until that is fixed.`
    // No upcoming visit carries a price here, and Auto Pay (pinned) is on, so
    // billing-lane.js membershipDuesCoverVisit covers every one of them.
    : `The ${money(after.monthly_rate)} monthly rate is charged each month by the dues run.${visits.length ? ` ${plural(visits.length, 'upcoming visit has', 'upcoming visits have')} no price today and ${visits.length === 1 ? 'is' : 'are'} covered by dues.` : ''}`),
  per_visit: () => `Each completed visit is charged its own scheduled price. No monthly dues charge. ${SALES_TAX}`,
};

// Who gets the charges, and how: the saved method Auto Pay would use, by tender
// family, with no amount. Dues always go to the saved method; a per-application
// charge goes there while Auto Pay is on, a per-visit charge only with
// GATE_COMPLETION_AUTOPAY_CHARGE; otherwise charges are invoiced.
const TENDER_WORDS = {
  card: (end) => `the saved card${end}`,
  bank: (end) => `the saved bank account${end} (ACH)`,
};
const CARD_SURCHARGE = 'Credit-card charges carry the configured card surcharge.';

function tenderLines(laneAfter, charge) {
  const toSavedMethod = charge.autopayActive && charge.family
    && (laneAfter === 'monthly_membership' || laneAfter === 'per_application' || charge.gate);
  if (!toSavedMethod) return laneAfter === 'monthly_membership' ? [] : ['Future charges under this type are invoiced.'];
  const end = charge.last4 ? ` ending ${charge.last4}` : '';
  return [`Future charges under this type go to ${TENDER_WORDS[charge.family](end)}.`, ...(charge.family === 'card' ? [CARD_SURCHARGE] : [])];
}

const DUES_STOP = 'Monthly dues stop: the monthly dues charge and any retry of a failed dues charge no longer run. Dues already paid for this month are not refunded.';

// An open membership-dues invoice (a completion-minted one on an already
// completed visit, or a cron one) stays collectible after the lane moves, so the
// flat "dues stop" promise names it instead.
const duesStopLine = (openDues) => {
  if (!openDues.length) return DUES_STOP;
  const total = openDues.reduce((n, d) => n + (Number(d.total) || 0), 0);
  return `Monthly dues stop: no new monthly dues charge runs. ${plural(openDues.length, 'open membership-dues invoice', 'open membership-dues invoices')} (${money(total)}) stay${openDues.length === 1 ? 's' : ''} collectible: their pay links and follow-ups continue. Dues already paid for this month are not refunded.`;
};

function nextVisitLines(row, fields, visits, dues = null, charge = NO_CHARGE_CONTEXT, openDues = []) {
  const after = { ...row, ...fields };
  const laneBefore = resolveBillingLane(row).mode;
  // one_time and any other explicit lane bill like per_visit.
  const laneAfter = resolveBillingLane(after).mode;
  if (!('billing_mode' in fields) && laneAfter !== 'per_application') {
    // A fee-only edit on a customer not billed per application.
    return [`The fee is used only while the customer is billed per application. This customer stays ${laneWords(row)}, so their next visits are charged the same as today.`];
  }
  const head = LANE_HEAD[LANE_HEAD[laneAfter] ? laneAfter : 'per_visit']({ after, dues, visits });
  return [
    head,
    ...tenderLines(laneAfter, charge),
    ...(laneBefore === 'monthly_membership' && laneAfter !== 'monthly_membership' ? [duesStopLine(openDues)] : []),
  ];
}

/**
 * Proposal: the card display and the pin, or a refusal. `updates` is the
 * model's updates map (already known to carry a billing field).
 */
async function billingEditProposal(customerId, updates, dbh = db) {
  if (!billingEditLive()) return refuse(GATE_OFF, 'gate_off');
  const parsed = parseBillingEdit(updates);
  if (parsed.error) return parsed;
  const row = await dbh('customers').where('id', customerId).whereNull('deleted_at')
    .first('billing_mode', 'per_application_fee', 'monthly_rate', 'waveguard_tier', 'waveguard_tier_source',
      'payer_id', 'autopay_enabled', 'autopay_paused_until', dbh.raw('updated_at::text AS version'));
  if (!row) return refuse('No customer matches that id — nothing was proposed.', 'customer_not_found');
  const visits = await upcomingVisits(dbh, customerId);
  const refusal = await billingEditRefusal(dbh, customerId, row, parsed.fields, visits);
  if (refusal) return refusal;
  const after = { ...row, ...parsed.fields };
  // Already monthly: the move-in check above did not run, so ask the dues
  // run's own eligibility whether the rate is really collected.
  const dues = resolveBillingLane(after).mode === 'monthly_membership' && resolveBillingLane(row).mode === 'monthly_membership'
    ? await require('../monthly-dues-eligibility').monthlyDuesVerdict(dbh, customerId, { overrides: parsed.fields })
    : null;
  let charge;
  try {
    charge = await chargeContext(dbh, customerId, row);
  } catch (e) {
    if (e && e.billingUnverified) return refuse(e.billingUnverified.message, e.billingUnverified.code);
    throw e;
  }
  const openDues = await require('../billing-lane').openStampedDuesInvoices(dbh, customerId);
  return {
    pin: cardPin(row, visits, parsed.fields, charge, openDues),
    version: row.version,
    display: {
      ...('billing_mode' in parsed.fields ? { billing_type: { before: laneWords(row), after: laneWords(after) } } : {}),
      ...('per_application_fee' in parsed.fields ? { fee: { before: feeWords(row.per_application_fee), after: money(after.per_application_fee) } } : {}),
      next_visits: nextVisitLines(row, parsed.fields, visits, dues, charge, openDues),
    },
  };
}

/**
 * Executor, before any write: the fields to set ({ fields: {} } when the edit
 * has none), or a refusal. Fails closed without the card's pin.
 */
function executorBillingEdit(updates, pin) {
  if (!hasBillingEdit(updates)) return { fields: {} };
  if (!billingEditLive()) return { error: GATE_OFF, preview_changed: true };
  if (!pin) return { error: 'This card has no billing check on it. Ask again for a fresh card. Nothing was changed.', preview_changed: true };
  const parsed = parseBillingEdit(updates);
  return parsed.error ? { error: parsed.error, preview_changed: true } : parsed;
}

/**
 * Commit, first: the per-customer annual-prepay advisory lock every term
 * writer takes (admin-customers.js ANNUAL_PREPAY_LOCK_NS, via
 * lockAndAssertNoAnnualPrepayOverlap; the prepay-on-book and termite paths;
 * rate-review-apply's tryAnnualPrepayLock). The TRY form, taken before the
 * customer row lock: the term writers hold this lock and then write the
 * customers row, so waiting here with the row held would be a cycle, and a
 * try never waits. A miss means a prepay term is being created or confirmed
 * for this customer right now: refuse, ask again. Lock order of the whole
 * update: property-preferences advisory, customer comms, annual-prepay (try),
 * customers row, billing-collection claim (try), visit rows by id.
 */
async function lockAnnualPrepayBeforeRow(trx, customerId, fields) {
  if (!Object.keys(fields || {}).length) return;
  const { ANNUAL_PREPAY_LOCK_NS } = require('../../routes/admin-customers')._private;
  const res = await trx.raw('SELECT pg_try_advisory_xact_lock(?, hashtext(?)) AS locked', [ANNUAL_PREPAY_LOCK_NS, String(customerId)]);
  const row = res && res.rows ? res.rows[0] : (Array.isArray(res) ? res[0] : null);
  if (!(row && (row.locked === true || row.locked === 't'))) {
    throw Object.assign(new Error('An annual prepay is being created or confirmed for this customer right now — nothing was updated. Ask again in a minute.'), { previewChanged: true });
  }
}

/**
 * Commit, inside update_customer's transaction after its row lock and version
 * check: the billing fields must still read as the card showed, and the rules
 * must still hold. Throws a previewChanged error otherwise.
 */
async function assertBillingEditUnderLock(trx, customerId, lockedBefore, fields, pin) {
  if (!Object.keys(fields).length) return;
  const changed = (message) => Object.assign(new Error(message), { previewChanged: true });
  // The billing-collection claim: the same per-customer key the dues cron,
  // the retry sweep and Charge now hold while they collect
  // (customer-billing-lock.js). Transaction-scoped and non-blocking, as the
  // invoice writers use it: a collector mid-charge refuses this card instead
  // of this write waiting on Stripe, and while this transaction holds the
  // claim no collector starts, so the retry-armed and eligibility checks
  // below hold through the write.
  const { tryClaimCustomerCollectionInTrx } = require('../../utils/customer-billing-lock');
  if (!(await tryClaimCustomerCollectionInTrx(trx, customerId))) {
    throw changed('A billing collection is running for this customer right now — nothing was updated. Try again in a minute.');
  }
  // The customer's billing fields, payer and Auto Pay state, plus every
  // upcoming visit's billing fields the card's projection was built from,
  // read with the visits locked FOR UPDATE (see upcomingVisits).
  let visits;
  let openDues;
  try {
    visits = await upcomingVisits(trx, customerId, { lock: true });
    // The customer's open membership-dues invoices, locked after the visits' invoices (same NOWAIT rule).
    openDues = await require('../billing-lane').openStampedDuesInvoices(trx, customerId, { lock: true });
  } catch (e) {
    // NOWAIT on an invoice another transaction holds (an edit, void or refund
    // in flight): refuse, never wait with the customer row held.
    if (e && e.code === '55P03') throw changed('An invoice on this customer is being changed right now — nothing was updated. Try again in a minute.');
    throw e;
  }
  let charge;
  try {
    charge = await chargeContext(trx, customerId, lockedBefore);
  } catch (e) {
    if (e && e.billingUnverified) throw changed(e.billingUnverified.message);
    throw e;
  }
  if (cardPin(lockedBefore, visits, fields, charge, openDues) !== pin) {
    throw changed("This customer's billing or upcoming visits changed since the card was shown — nothing was updated. Ask again for a fresh card.");
  }
  const refusal = await billingEditRefusal(trx, customerId, lockedBefore, fields, visits);
  if (refusal) throw changed(refusal.error.replace('Nothing was proposed.', 'Nothing was updated.'));
}

module.exports = {
  BILLING_EDIT_FIELDS,
  LANE_WORDS,
  billingEditLive,
  hasBillingEdit,
  parseBillingEdit,
  billingPin,
  visitsPin,
  cardPin,
  billingEditRefusal,
  billingEditProposal,
  executorBillingEdit,
  assertBillingEditUnderLock,
  lockAnnualPrepayBeforeRow,
  money,
};
