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
 *       * a move to monthly membership while Auto Pay is off or paused (the
 *         dues run skips them);
 *       * leaving monthly membership while a failed payment's retry is armed
 *         (the retry ladder stops for a non-monthly lane).
 *   - The card shows the billing type and fee before -> after in words, what
 *     the next visits are charged (billing-lane.js completion rules), and that
 *     no customer message is sent.
 *   - Pinned with the customer version: the billing fields, payer and Auto Pay
 *     state, and each upcoming visit's billing fields (the projection). At
 *     commit, under the customer row lock, a changed pin or a rule that no
 *     longer holds refuses as preview_changed.
 *
 * The write is the two columns only. The customer page's save also writes a
 * sensitive-field audit row for billing_mode and may send the membership
 * welcome email; neither is needed for the billing to be right (the bar keeps
 * its own action record), and the email case is refused above.
 */
const db = require('../../models/db');
const BillingModeRules = require('../billing-mode-rules');
const { resolveBillingLane, predictCompletionBilling } = require('../billing-lane');

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
  'prepaid_amount', 'prepaid_method', 'is_callback', 'service_type', 'payer_id'];

async function upcomingVisits(dbh, customerId) {
  const { etDateString } = require('../../utils/datetime-et');
  return dbh('scheduled_services')
    .where({ customer_id: customerId })
    .whereIn('status', ['pending', 'confirmed'])
    .where('scheduled_date', '>=', etDateString())
    .select(VISIT_COLUMNS)
    .orderBy('scheduled_date', 'asc')
    .orderBy('id', 'asc')
    .limit(200);
}

function visitsPin(visits) {
  return JSON.stringify((visits || []).map((v) => VISIT_COLUMNS.map((c) => {
    const value = v[c];
    if (value == null) return null;
    return value instanceof Date ? value.toISOString().slice(0, 10) : String(value);
  })));
}

function cardPin(row, visits) {
  return `${billingPin(row)}|${visitsPin(visits)}`;
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
  // The monthly dues run skips a customer with Auto Pay off or paused
  // (billing-cron.js GUARD 1 / GUARD 2, autopay-eligibility.js isPaused).
  ({ row, laneAfter, laneBefore }) => {
    if (laneAfter !== 'monthly_membership' || laneBefore === 'monthly_membership') return null;
    const { isPaused } = require('../autopay-eligibility');
    return row.autopay_enabled === false || isPaused(row)
      ? refuse('Turn on Auto Pay first; the monthly dues run skips customers without it. Nothing was proposed.', 'autopay_off') : null;
  },
  // Leaving the monthly lane stops the retry ladder of a failed dues charge
  // (billing-cron.js LANE_NOT_MONTHLY). An armed retry (retry-collectibility.js
  // armedRetryQuery, the sweep's own selection) is resolved first.
  async ({ dbh, customerId, laneBefore, laneAfter }) => {
    if (laneBefore !== 'monthly_membership' || laneAfter === 'monthly_membership') return null;
    const { armedRetryQuery } = require('../retry-collectibility');
    const armed = await armedRetryQuery(dbh, { customerIds: [customerId] }).first('id');
    return armed ? refuse('This customer has a dues retry scheduled — resolve it on the billing page first. Nothing was proposed.', 'dues_retry_armed') : null;
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
    loadUnpricedFutureVisits: () => BillingModeRules.unpricedFutureBillableVisits(dbh, customerId),
  });
  return message ? refuse(`${message}${message.endsWith('.') ? '' : '.'} Nothing was proposed.`, 'billing_mode_rule') : null;
}

/**
 * The refusal for applying `fields` to the customer `row`, or null. Runs at
 * proposal and again at commit under the row lock (dbh = that transaction).
 * `visits` is upcomingVisits() read on the same handle.
 */
async function billingEditRefusal(dbh, customerId, row, fields, visits) {
  if (row.billing_mode === 'annual_prepay') return refuse('This customer is on annual prepay; that lane follows the annual invoice and its term, so it is not changed from the bar. Nothing was proposed.', 'annual_prepay_lane');
  if (unchangedEdit(row, fields)) return refuse('The billing type and per-application fee are already set that way. Nothing was proposed.', 'no_change');
  if (await BillingModeRules.liveAnnualPrepayTerm(dbh, customerId)) {
    return refuse('This customer has an annual prepay term covering today, so the billing type is not changed from the bar. Nothing was proposed.', 'live_annual_prepay_term');
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

// Upcoming visits under the per-application rule, each predicted with the
// completion path's own rules (billing-lane.js predictCompletionBilling, the
// per_application lane with the card's fee): a visit's own price wins, else
// the fee; a prepayment is netted and covers the visit only when it covers the
// whole amount; callbacks, free visit types and $0 bill nothing.
function perApplicationVisitCounts(rows, fee) {
  const counts = { fee: 0, own: 0, partly: 0, prepaid: 0, none: 0 };
  for (const r of rows) {
    const p = predictCompletionBilling({
      lane: 'per_application', billingMode: 'per_application', perApplicationFee: fee, monthlyRate: 0,
      estimatedPrice: r.estimated_price, primaryLinePrice: r.primary_line_price, isCallback: !!r.is_callback,
      serviceType: r.service_type, prepaidAmount: r.prepaid_amount, prepaidMethod: r.prepaid_method,
    });
    if (p.kind === 'prepaid') counts.prepaid += 1;
    else if (!(p.amount > 0)) counts.none += 1;
    else if (p.grossAmount > p.amount) counts.partly += 1;
    else if (Number(r.estimated_price) > 0) counts.own += 1;
    else counts.fee += 1;
  }
  return counts;
}

function plural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function nextVisitLines(row, fields, visits) {
  const after = { ...row, ...fields };
  const laneBefore = resolveBillingLane(row).mode;
  const laneAfter = resolveBillingLane(after).mode;
  if (!('billing_mode' in fields) && laneAfter !== 'per_application') {
    // A fee-only edit on a customer not billed per application.
    return [`The fee is used only while the customer is billed per application. This customer stays ${laneWords(row)}, so their next visits are charged the same as today.`];
  }
  const lines = [];
  if (laneAfter === 'per_application') {
    lines.push(`Each completed visit is charged its own scheduled price, or ${money(after.per_application_fee)} when it has none — auto-charged to the saved card when Auto Pay is on, invoiced otherwise. Callbacks and free visit types bill nothing. No monthly dues charge.`);
    const c = perApplicationVisitCounts(visits, after.per_application_fee);
    const parts = [
      c.fee && `${plural(c.fee, 'visit', 'visits')} at ${money(after.per_application_fee)}`,
      c.own && `${plural(c.own, 'visit', 'visits')} at its own price`,
      c.partly && `${plural(c.partly, 'visit is', 'visits are')} partly prepaid (the rest is charged)`,
      c.none && `${plural(c.none, 'visit bills', 'visits bill')} nothing`,
      c.prepaid && `${plural(c.prepaid, 'visit is', 'visits are')} fully prepaid`,
    ].filter(Boolean);
    lines.push(parts.length ? `Upcoming visits now on the schedule: ${parts.join(', ')}.` : 'No upcoming visits are on the schedule.');
  } else if (laneAfter === 'monthly_membership') {
    lines.push(`The ${money(after.monthly_rate)} monthly rate is charged each month by the dues run. Recurring plan visits are covered while Auto Pay is on or that month's dues are paid; a one-off visit with its own price still bills that price.`);
  } else {
    lines.push('Each completed visit is invoiced at its own scheduled price. No monthly dues charge.');
  }
  if (laneBefore === 'monthly_membership' && laneAfter !== 'monthly_membership') {
    lines.push('Monthly dues stop: the monthly dues charge and any retry of a failed dues charge no longer run. Dues already paid for this month are not refunded.');
  }
  return lines;
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
  return {
    pin: cardPin(row, visits),
    version: row.version,
    display: {
      ...('billing_mode' in parsed.fields ? { billing_type: { before: laneWords(row), after: laneWords(after) } } : {}),
      ...('per_application_fee' in parsed.fields ? { fee: { before: feeWords(row.per_application_fee), after: money(after.per_application_fee) } } : {}),
      next_visits: nextVisitLines(row, parsed.fields, visits),
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
 * Commit, inside update_customer's transaction after its row lock and version
 * check: the billing fields must still read as the card showed, and the rules
 * must still hold. Throws a previewChanged error otherwise.
 */
async function assertBillingEditUnderLock(trx, customerId, lockedBefore, fields, pin) {
  if (!Object.keys(fields).length) return;
  const changed = (message) => Object.assign(new Error(message), { previewChanged: true });
  // The customer's billing fields, payer and Auto Pay state, plus every
  // upcoming visit's billing fields the card's projection was built from.
  const visits = await upcomingVisits(trx, customerId);
  if (cardPin(lockedBefore, visits) !== pin) {
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
  money,
};
