/**
 * The effects of a manual "Mark accepted" (estimate-manual-acceptance.js).
 *
 * One list, produced by the same code that does the accept. The accept's
 * steps record what they write into an effect log; a dry run
 * (markEstimateManuallyAccepted({ dryRun: true })) runs every step inside the
 * accept's own transaction, returns the log and rolls the transaction back.
 * The Intelligence Bar card (intelligence-bar/estimate-accept-tools.js) is
 * rendered from that list, and the approved list is pinned: the real run
 * builds its own list under the same locks and refuses as preview_changed
 * when the two differ (effectsFingerprint).
 *
 * What commits is never decided twice. planPostCommit() is the ONE pure
 * function that decides the work after the commit (group follow-up transfer,
 * property link, lead won, membership email, welcome text, termite agreement,
 * admin bells); the dry run lists its steps and the real run executes them
 * (runPostCommit).
 *
 * Effects carry no clocks and no generated ids, so two runs over the same
 * state give the same list.
 */
const crypto = require('crypto');
const logger = require('./logger');

// Thrown at the end of a dry run to roll the accept's transaction back. It
// carries the accept's result so the caller can return the effect list.
class DryRunRollback extends Error {
  constructor(result) {
    super('dry run: accept rolled back');
    this.name = 'DryRunRollback';
    this.result = result;
  }
}

function createEffectLog(enabled) {
  const list = [];
  return {
    enabled: enabled === true,
    add(effect) { if (enabled === true && effect) list.push(effect); },
    list: () => list.slice(),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonical(value[key]);
    }
    return out;
  }
  return value;
}

function effectsFingerprint(effects) {
  return crypto.createHash('sha256').update(JSON.stringify(canonical(effects || []))).digest('hex');
}

const round2 = (n) => Math.round(Number(n || 0) * 100) / 100;
const money = (n) => `$${round2(n).toFixed(2)}`;
const UNITEMIZED_TOLERANCE = 0.01;
const orNull = (v) => (v == null ? null : v);

// ── State snapshots: what the conversion changes, read inside the accept ──

const CUSTOMER_EFFECT_FIELDS = ['monthly_rate', 'billing_mode', 'waveguard_tier', 'pipeline_stage', 'property_type', 'per_application_fee'];

// The customer rows the conversion writes, read through the accept's
// transaction. The lawn size lives in THREE places (the turf profile, the
// primary property, the customer row; lawn-size-sync.writeLawnSqft compares
// all three), so all three are read.
async function snapshotAcceptState(trx, customerId) {
  const PlanRateLedger = require('./plan-rate-ledger');
  const customer = await trx('customers').where({ id: customerId }).first();
  const turf = await trx('customer_turf_profiles').where({ customer_id: customerId }).first('grass_type', 'lawn_sqft');
  const primary = await trx('customer_properties').where({ customer_id: customerId, is_primary: true, active: true }).first('id', 'property_sqft');
  const components = await PlanRateLedger.loadComponents(trx, customerId);
  // Copies: the "before" state must not move when the conversion writes.
  const copy = (row) => (row ? { ...row } : null);
  return { customer: copy(customer), turf: copy(turf), primary: copy(primary), components: (components || []).map((c) => ({ ...c })) };
}

function customerFields(customer) {
  const out = {};
  for (const key of CUSTOMER_EFFECT_FIELDS) out[key] = customer && customer[key] != null ? String(customer[key]) : null;
  return out;
}

function lawnFields(state) {
  return {
    grass_type: orNull(state.turf?.grass_type),
    turf_lawn_sqft: orNull(state.turf?.lawn_sqft),
    primary_property_sqft: orNull(state.primary?.property_sqft),
    customer_property_sqft: orNull(state.customer?.property_sqft),
  };
}

// The bill by service, as the ledger sees it. When the lines do not add up to
// the stored monthly rate (the ledger gate is off and the table is advisory),
// the stored rate is the bill and it shows as one line.
function billOf(state) {
  const PlanRateLedger = require('./plan-rate-ledger');
  const scalar = round2(state.customer?.monthly_rate);
  let lines = PlanRateLedger.billLines(state.components, scalar);
  const sum = [...lines.values()].reduce((s, v) => round2(s + v), 0);
  if (round2(sum) !== scalar) lines = new Map(scalar > 0 ? [[PlanRateLedger.UNATTRIBUTED, scalar]] : []);
  const out = {};
  for (const family of [...lines.keys()].sort()) out[family] = lines.get(family);
  return { scalar, lines: out };
}

// The conversion's writes as effects: the customer's billing fields, the bill
// by service, the lawn profile (all three places).
function stateDiffEffects(before, after) {
  const billBefore = billOf(before);
  const billAfter = billOf(after);
  return [
    { kind: 'customer', before: customerFields(before.customer), after: customerFields(after.customer) },
    { kind: 'plan_rate_ledger', before: billBefore.lines, after: billAfter.lines, total_before: billBefore.scalar, total_after: billAfter.scalar },
    { kind: 'lawn_profile', before: lawnFields(before), after: lawnFields(after) },
  ];
}

function conversionEffect(conversion) {
  return {
    kind: 'conversion',
    recurring: conversion?.serviceMode === 'recurring',
    service_count: orNull(conversion?.serviceCount),
    billing_lane: orNull(conversion?.membershipEmail?.billingLane),
    per_application_amount: conversion?.membershipEmail?.perApplicationAmount == null ? null : round2(conversion.membershipEmail.perApplicationAmount),
    manual_recurring_scheduling: conversion?.requiresManualRecurringScheduling === true,
  };
}

// ── The sold one-time lines ──

// What the customer pays for the line: the operator-approved net
// (manualFinalOneTime) when the line carries one, else the amount AFTER the
// estimate's discount (the field the engine totals from), else the list price.
// The first field that holds a number decides, so a line discounted to $0
// reads $0 and is not listed at its list price.
// An explicit $0 (manualFinalOneTime: 0, priceAfterDiscount: 0) is comped
// work the customer was promised: it is listed at $0 with its own
// consequence, so staff still schedule it. A NEGATIVE amount is one of the
// engine's adjustment rows (a bundle discount the mapper keeps among the
// items): it is listed as a discount to take off when invoicing, never as
// work to schedule. A line with no amount at all is not listed.
const ONE_TIME_AMOUNT_FIELDS = ['manualFinalOneTime', 'priceAfterDiscount', 'amountAfterDiscount', 'totalAfterDiscount', 'price', 'amount', 'total'];
function lineAmount(item) {
  for (const key of ONE_TIME_AMOUNT_FIELDS) {
    if (item?.[key] == null || item[key] === '') continue;
    const n = Number(item[key]);
    if (Number.isFinite(n)) return round2(n);
  }
  return null;
}
function lineConsequence(amount) {
  if (amount > 0) return 'schedule_and_invoice_by_hand';
  if (amount < 0) return 'subtract_when_invoicing';
  return 'schedule_by_hand_comped';
}

function parseData(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try { return JSON.parse(value) || {}; } catch { return {}; }
  }
  return typeof value === 'object' ? value : {};
}

// Each priced one-time line the estimate sells. A manual accept books and
// invoices none of them (skipAutoSchedule + skipSetupInvoice), so each one
// says the work is scheduled and billed by hand.
//
// The WaveGuard membership fee is the one component the engine counts in
// oneTime.total but keeps OUT of oneTime.items (v1-legacy-mapper), so it is
// listed as its own line from the fee field; a line sum that still falls
// short of the aggregate is refused by unitemizedOneTimeRefusal below.
const MEMBERSHIP_FEE_PATHS = [
  ['oneTime', 'membershipFee'], ['result', 'oneTime', 'membershipFee'], ['results', 'oneTime', 'membershipFee'],
  ['result', 'results', 'oneTime', 'membershipFee'], ['engineResult', 'oneTime', 'membershipFee'],
];
const readPath = (data, path) => path.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), data);
function membershipFeeLine(data) {
  for (const path of MEMBERSHIP_FEE_PATHS) {
    const n = Number(readPath(data, path));
    if (Number.isFinite(n) && n > 0) return { kind: 'one_time_line', name: 'WaveGuard membership fee', amount: round2(n), consequence: 'invoice_by_hand' };
  }
  return null;
}
// The parser reads `result` (or the document itself), never `engineResult`:
// an estimate stored with only an engineResult container, or with a mapped
// `result` beside a separate engineResult, keeps those rows invisible unless
// the container is wrapped, exactly as estimate-proposal-generate does. The
// same row mirrored across containers is collapsed by content identity.
function oneTimeItemsAcrossContainers(data, converter) {
  const read = (doc) => converter.estimateOneTimeItemsFromData(doc, { collapseMirrored: true });
  const engine = data?.engineResult && typeof data.engineResult === 'object' && data.engineResult !== data.result ? data.engineResult : null;
  const rows = [...read(data), ...(engine ? read({ result: engine }) : [])];
  const seen = new Set();
  return rows.filter((item) => {
    const key = [String(item.service || '').toLowerCase(), String(item.name || item.label || '').trim().toLowerCase(), lineAmount(item)].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function oneTimeLineEffects(estimate, converter) {
  if (typeof converter?.estimateOneTimeItemsFromData !== 'function') return [];
  const data = parseData(estimate.estimate_data);
  const items = oneTimeItemsAcrossContainers(data, converter);
  const lines = items
    .map((item) => ({ name: String(item.name || item.label || item.service || 'One-time service').trim(), amount: lineAmount(item) }))
    .filter((line) => line.amount != null)
    .map((line) => ({ kind: 'one_time_line', ...line, consequence: lineConsequence(line.amount) }));
  const fee = membershipFeeLine(data);
  const listed = fee ? [...lines, fee] : lines;
  const discount = pooledDiscountLine(estimate, listed);
  return discount ? [...listed, discount] : listed;
}

// A legacy estimate can hold a manual discount only in the aggregate
// (oneTime.total) while its items stay gross (v1-legacy-mapper). The card
// must not tell staff to invoice the gross lines, so the pooled discount is
// listed as its own negative line and the lines then add up to the total.
function pooledDiscountLine(estimate, lines) {
  const total = oneTimeAggregateTotal(estimate);
  if (total == null || !lines.length) return null;
  const listed = round2(lines.reduce((sum, line) => sum + Number(line.amount || 0), 0));
  const pooled = round2(listed - total);
  if (pooled <= UNITEMIZED_TOLERANCE) return null;
  return { kind: 'one_time_line', name: 'Discount applied to the one-time total', amount: -pooled, consequence: 'subtract_when_invoicing' };
}

// The one-time total the estimate carries as a plain number: the row's
// onetime_total or the engine's aggregate, whichever is positive first. A
// legacy estimate can carry only this aggregate and no priced item, so the
// lines above are empty while the customer still owes the amount.
const ONE_TIME_AGGREGATE_PATHS = [
  ['onetime_total'], ['oneTime', 'total'], ['results', 'oneTime', 'total'], ['result', 'oneTime', 'total'],
  ['result', 'results', 'oneTime', 'total'], ['engineResult', 'oneTime', 'total'],
];
//
// An explicit zero is authoritative: the mapper lets a positive item be
// discounted to an aggregate of exactly $0, and the customer accepted $0.
// The first field that holds a number decides; null only when none does.
function oneTimeAggregateTotal(estimate) {
  const data = parseData(estimate.estimate_data);
  const candidates = [estimate.onetime_total, ...ONE_TIME_AGGREGATE_PATHS.map((path) => readPath(data, path))];
  for (const value of candidates) {
    if (value == null || value === '') continue;
    const n = Number(value);
    if (Number.isFinite(n)) return n > 0 ? round2(n) : 0;
  }
  return null;
}

// A carded accept refuses when the estimate carries a positive one-time
// total that no line itemizes: the card could show only an amount, not the
// work staff must schedule and invoice by hand after the accept. Returns the
// refusal, or null when every one-time dollar is on a listed line.
//
// Partial itemization refuses too: when the listed lines (items, the
// membership fee and the pooled discount line) do not add up to the
// aggregate, the card header would say one amount and the lines another,
// and staff would invoice the lines. A sum above the total is reconciled by
// the pooled discount line, so after it the only mismatch left is a sum
// short of the total, and that refuses.
function unitemizedOneTimeRefusal(estimate, lines) {
  const total = oneTimeAggregateTotal(estimate);
  if (total == null) return null;
  const listed = round2(lines.filter((line) => line.kind === 'one_time_line').reduce((sum, line) => sum + Number(line.amount || 0), 0));
  const missing = round2(total - listed);
  if (Math.abs(missing) <= UNITEMIZED_TOLERANCE) return null;
  if (missing < 0) {
    return { message: `This estimate's listed one-time services add up to ${money(listed)} but its one-time total is ${money(total)}, so the bar cannot say what to invoice. Accept it from the estimate page.`, statusCode: 409, code: 'one_time_unitemized', total, listed, missing };
  }
  const message = listed > 0
    ? `This estimate carries a ${money(total)} one-time charge, but its listed services add up to ${money(listed)}: ${money(missing)} is not itemized, so the bar cannot say what to schedule and invoice after the accept. Accept it from the estimate page.`
    : `This estimate carries a ${money(total)} one-time charge with no itemized service, so the bar cannot say what to schedule and invoice after the accept. Accept it from the estimate page.`;
  return { message, statusCode: 409, code: 'one_time_unitemized', total, listed, missing };
}

// ── The side-effect gate: one context for everything outside the transaction ──
//
// The converter and the accept steps do a few things a rollback cannot undo:
// a customer email or text, an admin bell, a tech notification, a reminder
// row written through another pool, an invoice send. A dry run must never do
// any of them. The accept hands the converter ONE optional context
// (opts.sideEffects); every such call in the converter goes through
// gate.run(). The page button passes no context, so run() just calls the
// function and nothing changes for it.
//
//   dry run          : record the effect, do NOT call the function
//   carded real run  : record the effect (the same list the card pinned), call it
//   no context       : call it
//
// A side effect added later WITHOUT the gate still runs for the page, and is
// not listed by the dry run. The paths below cannot be gated, because they
// reach deep helpers that take no context; the gate REFUSES a carded accept
// that would enter them (assertCardedPath), so the dry run cannot reach them
// either. Those helpers: the recurring-visit seeder and its shortfall bell,
// visit grouping and reminder rows, the inspection-credit hooks, the palm
// catalog bell, the invoice and deposit service (Stripe, delivery, deposit
// alerts), and the annual prepay term and renewal mint.

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `***${digits.slice(-2)}` : null;
}

class CardedPathRefusal extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CardedPathRefusal';
    this.isOperational = true;
    this.statusCode = 422;
    this.status = 422;
    this.code = code;
  }
}

// descriptor: { type, target, recipient?, detail? }. Only stable facts: no
// clocks, no generated ids, no unmasked contact details.
function sideEffectEffect(descriptor) {
  return {
    kind: 'side_effect',
    type: descriptor.type,
    target: orNull(descriptor.target),
    recipient: orNull(descriptor.recipient),
    detail: orNull(descriptor.detail),
  };
}

function createSideEffectGate({ dryRun = false, log = null } = {}) {
  return {
    dryRun: dryRun === true,
    carded: true,
    run(descriptor, fn, dryValue) {
      if (log && typeof log.add === 'function') log.add(sideEffectEffect(descriptor));
      if (dryRun === true) return dryValue;
      return fn();
    },
  };
}

const PASS_THROUGH_GATE = Object.freeze({ dryRun: false, carded: false, run: (_descriptor, fn) => fn() });

function gateFrom(opts) {
  const gate = opts && opts.sideEffects;
  return gate && typeof gate.run === 'function' ? gate : PASS_THROUGH_GATE;
}

// The conversion paths that reach un-gateable helpers. A carded accept (dry or
// real) takes the manual Mark Won shape only: nothing auto-scheduled, no
// invoice minted, no annual prepay term. Anything else is refused with a
// reason BEFORE the conversion writes, on the dry run and the real run alike.
function assertCardedPath(gate, { skipAutoSchedule, skipSetupInvoice, billingTerm }) {
  if (!gate || gate.carded !== true) return;
  if (!skipAutoSchedule) {
    throw new CardedPathRefusal('This accept would book visits, and the bar cannot show or hold that yet. Accept it from the estimate page.', 'carded_path_schedules_visits');
  }
  if (!skipSetupInvoice) {
    throw new CardedPathRefusal('This accept would create an invoice, and the bar cannot show or hold that yet. Accept it from the estimate page.', 'carded_path_creates_invoice');
  }
  if (billingTerm === 'prepay_annual') {
    throw new CardedPathRefusal('Annual prepay is not offered from the bar. Accept it from the estimate page.', 'carded_path_annual_prepay');
  }
}

// ── The post-commit plan ──

const BELLS = [
  ['commercial_schedule', 'commercialScheduleNotification'],
  ['per_application_fee', 'perApplicationFeeNotification'],
  ['tier_upgrade', 'tierUpgradeNotification'],
  ['plan_rate_review', 'planRateReviewNotification'],
];

// A short, stable key of the approved recipient. The plan carries it (not the
// address), the sender compares it with the address on file at the moment of
// delivery, and a changed address means no email.
function recipientKey(address) {
  return crypto.createHash('sha256').update(String(address || '').trim().toLowerCase()).digest('hex').slice(0, 24);
}

function maskEmail(address) {
  const [local, domain] = String(address || '').trim().split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : null;
}

// The recipient facts the membership email needs, read inside the accept
// (notification_prefs through a savepoint, so an unreadable table cannot
// poison the transaction).
async function readEmailInputs(trx, customerId) {
  const customer = await trx('customers').where({ id: customerId }).first();
  const email = String(require('./customer-contact').getPrimaryContact(customer || {}).email || '').trim();
  let prefs = null;
  let prefsReadable = true;
  try {
    // Inside the accept's transaction the read runs in a savepoint; on the pool it is a plain read.
    prefs = trx.isTransaction
      ? await trx.transaction((sp) => sp('notification_prefs').where({ customer_id: customerId }).first())
      : await trx('notification_prefs').where({ customer_id: customerId }).first();
  } catch {
    prefsReadable = false;
  }
  return { email, emailOn: !(prefs && prefs.email_enabled === false), prefsReadable };
}

// Will the membership email go out? The same predicates the sender applies
// (account-membership-email: the one_time lane gate, a usable address, the
// portal-wide email switch). `attempt` is the page's own condition for
// calling the sender; `will_send` is the delivery it expects, or null when
// the recipient facts were not read.
function membershipEmailStep({ conversion, billingTerm, emailInputs }) {
  const planned = conversion?.membershipEmail;
  const refused = (reason, attempt) => ({ step: 'membership_email', attempt, will_send: false, reason, to: null });
  if (!planned) return refused('not_converted', false);
  if (billingTerm === 'prepay_annual') return refused('prepay', false);
  const { BILLING_MODES, resolveBillingLane } = require('./billing-lane');
  const lane = BILLING_MODES.includes(planned.billingLane) ? planned.billingLane : resolveBillingLane({}).mode;
  if (lane === 'one_time') return refused('one_time_lane', true);
  if (!emailInputs) return { step: 'membership_email', attempt: true, will_send: null, reason: 'unknown', to: null };
  if (!emailInputs.prefsReadable) return refused('prefs_unreadable', true);
  if (!emailInputs.email) return refused('no_address', true);
  if (!require('./account-membership-email').isEmailLike(emailInputs.email)) return refused('invalid_address', true);
  if (!emailInputs.emailOn) return refused('email_off', true);
  return {
    step: 'membership_email', attempt: true, will_send: true, reason: null, to: maskEmail(emailInputs.email),
  };
}

// The work after the commit, as an ordered list of steps (pure). Inputs are
// the committed-state facts: the accepted row, the conversion result and the
// recipient facts. A step is listed whenever the page attempts it.
function planPostCommit({
  billingTerm, acceptedEstimate, conversion, proposalCustomer = null, emailInputs = null, termiteProgram = null,
}) {
  const customerId = acceptedEstimate.customer_id || proposalCustomer?.id || null;
  const steps = [
    { step: 'group_followup_transfer', grouped: !!acceptedEstimate.estimate_group_id },
    ...(customerId ? [{ step: 'property_link' }, { step: 'multi_home' }] : []),
    { step: 'lead_won' },
  ];
  if (billingTerm !== 'prepay_annual' && conversion?.membershipEmail) steps.push(membershipEmailStep({ conversion, billingTerm, emailInputs }));
  if (conversion?.welcomeSms) steps.push({ step: 'welcome_sms' });
  if (customerId) steps.push({ step: 'termite_agreement', applies: termiteProgram });
  for (const [bell, field] of BELLS) {
    if (conversion?.[field]) steps.push({ step: 'admin_bell', bell, title: String(conversion[field].title || '') });
  }
  return steps;
}

// ── Running the plan ──

// The card promised the bell, so the post is awaited through the converter's
// own emitter (the same one its non-deferred accepts use); a failure, or a
// post that wrote no row, is a result warning the office finishes by hand
// (the accept is terminal and the plan never re-runs). True when posted.
async function fireAdminBell(payload, estimateId, label) {
  try {
    const row = await require('./estimate-converter').sendAcceptBell(payload, `${label} notify for estimate ${estimateId}`);
    return !!row;
  } catch (err) {
    logger.warn(`[estimate-manual-acceptance] ${label} notify failed for estimate ${estimateId}: ${err.message}`);
    return false;
  }
}

const BELL_LABELS = {
  commercial_schedule: 'commercial-schedule admin',
  per_application_fee: 'per-application fee admin',
  tier_upgrade: 'tier-upgrade admin',
  plan_rate_review: 'plan-rate review',
};

// ── The rule for every step: a pinned target ──
//
// Each step names the concrete thing it acts on, `resolveTarget(database,
// facts)`. The dry run resolves it inside the accept's transaction and the
// plan carries it (step.target) into the approved list. runPostCommit
// resolves it again at run time, and when the answer differs from the pinned
// target the step is SKIPPED with a logged `target_changed` reason; a step
// never picks a new target on its own. `run(step, ctx)` acts only on
// step.target. A plan with no targets (the page's own accept, which has no
// card) runs each step as it always did.

const customerIdOf = ({ acceptedEstimate, proposalCustomer }) => acceptedEstimate.customer_id || proposalCustomer?.id || null;
const idText = (v) => (v == null ? null : String(v));

// What the operator reads when a step the card promised did not run. The
// accept is committed and the idempotent path never re-runs the plan, so the
// result must say which effect still needs a hand.
const STEP_LABELS = {
  group_followup_transfer: 'The follow-up messages were not moved to the other estimate in the group',
  property_link: 'The property was not linked to the accepted services',
  multi_home: 'The other homes on this account were not marked',
  lead_won: 'The linked lead was not marked won',
  membership_email: 'The membership email was not sent',
  welcome_sms: 'The welcome text was not sent',
  termite_agreement: 'The termite agreement was not created',
  admin_bell: 'The office notification was not posted',
};
const SKIPPED_STEP_SUFFIX = ': what it acts on changed after the accept. Complete it by hand.';

// The sender's own vetoes (an opt-out, an address that changed since the
// card, no address, no customer) are the card's promise NOT to send: the
// receipt says the email was suppressed and must not be sent by hand. Only a
// failure to deliver (provider refusal, transient prefs/database error) asks
// for a hand send.
const EMAIL_VETO_TEXT = {
  email_opted_out: 'the customer has email turned off',
  recipient_changed: 'the address on file changed after the card',
  missing_email: 'the customer has no email address',
  customer_not_found: 'the customer record was not found',
};
function membershipEmailWarning(result, reason) {
  const veto = EMAIL_VETO_TEXT[reason] || (result?.skipped === true || result?.blocked === true ? reason : null);
  if (veto) return `The membership email was suppressed: ${veto}. Do not send it by hand.`;
  return `${STEP_LABELS.membership_email} (${reason}). Send it by hand.`;
}

async function warnLeadsNotWon(step, ctx) {
  const ids = step.target.lead_ids;
  let rows;
  try {
    rows = await ctx.database('leads').whereIn('id', ids).select('id', 'status', 'deleted_at');
  } catch (err) {
    logger.warn(`[estimate-manual-acceptance] lead_won verify unreadable for estimate ${ctx.acceptedEstimate.id}: ${err.message}`);
    ctx.warnings?.push(`The linked lead could not be verified as won${SKIPPED_STEP_SUFFIX}`);
    return;
  }
  const won = new Set(rows.filter((r) => r.status === 'won' && !r.deleted_at).map((r) => String(r.id)));
  const notWon = ids.filter((id) => !won.has(String(id)));
  if (!notWon.length) return;
  logger.warn(`[estimate-manual-acceptance] lead_won skipped ${notWon.length} lead(s) for estimate ${ctx.acceptedEstimate.id}: not won after conversion`, { notWon });
  ctx.warnings?.push(`${STEP_LABELS.lead_won}${SKIPPED_STEP_SUFFIX}`);
}

const POST_COMMIT_STEPS = {
  group_followup_transfer: {
    // The sibling that takes over the group's follow-up messages.
    async resolveTarget(database, facts) {
      const owner = await require('../routes/estimate-public').groupFollowupOwnerId(database, facts.acceptedEstimate);
      return { estimate_id: idText(facts.acceptedEstimate.id), owner_id: idText(owner) };
    },
    async run(step, ctx) {
      try {
        await require('../routes/estimate-public').transferGroupFollowupOwnership(
          ctx.acceptedEstimate, step.target ? { ownerId: step.target.owner_id } : undefined,
        );
      } catch (e) {
        logger.warn(`[manual-acceptance] follow-up ownership transfer failed for estimate ${ctx.acceptedEstimate.id}: ${e.message}`);
      }
    },
  },
  property_link: {
    // The customer and the property the estimate is already linked to.
    async resolveTarget(database, facts) {
      const Linkage = require('./estimate-property-linkage');
      const customerId = customerIdOf(facts);
      const property = Linkage.customerPropertiesGateOn() ? await Linkage.linkedAcceptPropertyId(database, facts.acceptedEstimate, customerId) : null;
      return { customer_id: idText(customerId), property_id: idText(property) };
    },
    async run(step, ctx) {
      await require('./estimate-property-linkage').linkAcceptedEstimateProperty({
        estimateId: ctx.acceptedEstimate.id,
        customerId: step.target ? step.target.customer_id : customerIdOf(ctx),
        // A pinned plan runs the has_multi_home flip as its own pinned step.
        refreshMultiHome: !step.target,
        // The card path approved NO visit (the card pins "no linked visit"), so
        // the link touches none: a visit linked after the converter's last
        // check is logged target_changed and left alone.
        ...(step.target ? { approvedServiceIds: [] } : {}),
      });
    },
  },
  multi_home: {
    // Whether the customer is flipped to multi-home (two active properties).
    async resolveTarget(database, facts) {
      const customerId = customerIdOf(facts);
      return { customer_id: idText(customerId), flips: await require('./estimate-property-linkage').multiHomeFlipPending(database, customerId) };
    },
    async run(step, ctx) {
      if (!step.target || step.target.flips !== true) return;
      try {
        await require('./estimate-property-linkage').refreshHasMultiHome(step.target.customer_id, ctx.database);
      } catch (err) {
        logger.warn(`[estimate-manual-acceptance] multi-home refresh failed for estimate ${ctx.acceptedEstimate.id}: ${err.message}`);
        ctx.warnings?.push(`${STEP_LABELS.multi_home}: the flip failed after the accept. Complete it by hand.`);
      }
    },
  },
  lead_won: {
    // The lead(s) markLinkedLeadEstimateAccepted would mark won.
    async resolveTarget(database, facts) {
      const resolve = facts.leadLinkService?.resolveLinkedLeadWon;
      const ids = resolve ? await resolve({ estimateId: facts.acceptedEstimate.id, customerId: facts.acceptedEstimate.customer_id || null, database }) : [];
      return { estimate_id: idText(facts.acceptedEstimate.id), lead_ids: ids.map(String) };
    },
    async run(step, ctx) {
      const { acceptedEstimate } = ctx;
      try {
        await ctx.leadLinkService.markLinkedLeadEstimateAccepted({
          estimateId: acceptedEstimate.id,
          customerId: acceptedEstimate.customer_id || null,
          monthlyValue: ctx.asMoneyOrNull(acceptedEstimate.monthly_total),
          initialServiceValue: ctx.asMoneyOrNull(acceptedEstimate.onetime_total),
          waveguardTier: acceptedEstimate.waveguard_tier || null,
          ...(step.target ? { onlyLeadIds: step.target.lead_ids } : {}),
        });
      } catch (err) {
        logger.warn(`[estimate-manual-acceptance] linked lead conversion failed for estimate ${acceptedEstimate.id}: ${err.message}`);
        ctx.warnings.push('Linked lead was not marked won automatically.');
        return;
      }
      // The helper skips a lead that closed or was deleted between the
      // target check and its own read, without throwing. The card promised
      // these leads, so the rows are read back and any one not won is a
      // warning the operator finishes by hand.
      if (step.target?.lead_ids?.length) await warnLeadsNotWon(step, ctx);
    },
  },
  membership_email: {
    // The customer and a key of the address on file (never the address).
    async resolveTarget(database, facts) {
      const customerId = facts.conversion?.membershipEmail?.customerId || customerIdOf(facts);
      const inputs = await readEmailInputs(database, customerId);
      return { customer_id: idText(customerId), recipient_key: inputs.email ? recipientKey(inputs.email) : null };
    },
    async run(step, ctx) {
      // The card approved "no email" (opted out, no address): that decision
      // rides through delivery. A fresh opt-out still vetoes a planned send in
      // the sender itself.
      if (ctx.approvedEmail === 'skip') return;
      const AccountMembershipEmail = require('./account-membership-email');
      // The approved recipient rides through delivery: the sender compares it
      // with the address on file when it sends, and sends nothing if the
      // address changed since the card (a fresh opt-out still vetoes there too).
      const key = step.target?.recipient_key;
      const payload = key ? { ...ctx.conversion.membershipEmail, recipientKey: key } : ctx.conversion.membershipEmail;
      // The card promised the email, so the send is awaited and anything but
      // a sent result (provider refusal, transient prefs/database failure, a
      // fresh opt-out) is a result warning the operator finishes by hand.
      let result;
      try {
        result = await AccountMembershipEmail.sendMembershipStarted(payload);
      } catch (err) {
        logger.warn(`[estimate-manual-acceptance] membership.started email failed for estimate ${ctx.acceptedEstimate.id}: ${err.message}`);
        result = { ok: false, error: err.message };
      }
      if (result?.ok === true || result?.sent === true) return;
      const reason = result?.reason || result?.error || 'not_sent';
      logger.warn(`[estimate-manual-acceptance] membership.started email not sent for estimate ${ctx.acceptedEstimate.id}: ${reason}`);
      ctx.warnings?.push(membershipEmailWarning(result, reason));
    },
  },
  welcome_sms: {
    // The customer and a key of the phone on file (never the number).
    async resolveTarget(database, facts) {
      const customerId = facts.conversion?.welcomeSms?.customer?.id || customerIdOf(facts);
      const row = customerId ? await database('customers').where({ id: customerId }).first('phone') : null;
      return { customer_id: idText(customerId), phone_key: row?.phone ? recipientKey(row.phone) : null };
    },
    async run(_step, ctx) {
      // Conversion runs inside the accept transaction, so the converter defers
      // the new-recurring welcome SMS. Idempotent.
      const { sendNewRecurringWelcome } = require('./new-recurring-welcome-sms');
      void sendNewRecurringWelcome(ctx.conversion.welcomeSms)
        .catch((err) => logger.warn(`[estimate-manual-acceptance] welcome SMS failed for estimate ${ctx.acceptedEstimate.id}: ${err.message}`));
    },
  },
  termite_agreement: {
    // The estimate and customer the agreement is prepared for.
    async resolveTarget(_database, facts) {
      return { estimate_id: idText(facts.acceptedEstimate.id), customer_id: idText(customerIdOf(facts)) };
    },
    async run(step, ctx) {
      const { acceptedEstimate } = ctx;
      const agreementCustomerId = step.target ? step.target.customer_id : customerIdOf(ctx);
      try {
        const { maybeCreateTermiteProgramAgreement } = require('./termite-program-agreement');
        const { formatDisplayDate } = require('../utils/date-only');
        const agreementStartLabel = ctx.agreementStartDate ? (formatDisplayDate(ctx.agreementStartDate, { fallback: '' }) || null) : null;
        void maybeCreateTermiteProgramAgreement({
          estimate: acceptedEstimate, customerId: agreementCustomerId, billingTerm: ctx.billingTerm,
          startDateLabel: agreementStartLabel, startDateRaw: ctx.agreementStartDate,
        }).catch((err) => logger.warn(`[estimate-manual-acceptance] termite agreement prep failed for estimate ${acceptedEstimate.id}: ${err.message}`));
      } catch (err) {
        logger.warn(`[estimate-manual-acceptance] termite agreement prep setup failed for estimate ${acceptedEstimate.id}: ${err.message}`);
      }
    },
  },
  admin_bell: {
    // The estimate and the bell.
    async resolveTarget(_database, facts) {
      return { estimate_id: idText(facts.acceptedEstimate.id), bell: facts.step.bell };
    },
    async run(step, ctx) {
      const field = BELLS.find(([bell]) => bell === step.bell)[1];
      const posted = await fireAdminBell(ctx.conversion[field], ctx.acceptedEstimate.id, BELL_LABELS[step.bell]);
      if (!posted) ctx.warnings?.push(`${STEP_LABELS.admin_bell} ("${String(ctx.conversion[field]?.title || step.bell)}"): the post failed after the accept. Tell the office by hand.`);
    },
  },
};

const sameTarget = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

function skippedStepWarning(ctx, step) {
  if (!Array.isArray(ctx.warnings)) return;
  ctx.warnings.push(`${STEP_LABELS[step.step] || `The ${step.step} step did not run`}${SKIPPED_STEP_SUFFIX}`);
}

// Resolve every step's target (the dry run, inside the accept's transaction)
// and return the plan with each target attached. `facts` carries the
// accepted row, the conversion, the proposal customer and leadLinkService.
async function pinPostCommitTargets(plan, database, facts) {
  const pinned = [];
  for (const step of plan) {
    pinned.push({ ...step, target: await POST_COMMIT_STEPS[step.step].resolveTarget(database, { ...facts, step }) });
  }
  return pinned;
}

// Execute the plan in order. `ctx` carries the committed accept (acceptedEstimate,
// conversion, proposalCustomer), the page's inputs, `database` and
// `approvedEmail` ('skip' when the approved card said no email). A step with a
// pinned target runs only when its target resolves to the pinned one now.
async function runPostCommit(plan, ctx) {
  for (const step of plan) {
    const def = POST_COMMIT_STEPS[step.step];
    if (step.target !== undefined) {
      let current;
      try {
        current = await def.resolveTarget(ctx.database, { ...ctx, step });
      } catch (err) {
        logger.warn(`[estimate-manual-acceptance] ${step.step} skipped for estimate ${ctx.acceptedEstimate.id}: target_changed (target unreadable: ${err.message})`);
        skippedStepWarning(ctx, step);
        continue;
      }
      if (!sameTarget(current, step.target)) {
        logger.warn(`[estimate-manual-acceptance] ${step.step} skipped for estimate ${ctx.acceptedEstimate.id}: target_changed`, { pinned: step.target, current });
        skippedStepWarning(ctx, step);
        continue;
      }
    }
    await def.run(step, ctx);
  }
}

module.exports = {
  DryRunRollback,
  createEffectLog,
  effectsFingerprint,
  snapshotAcceptState,
  stateDiffEffects,
  conversionEffect,
  oneTimeLineEffects,
  oneTimeAggregateTotal,
  unitemizedOneTimeRefusal,
  STEP_LABELS,
  readEmailInputs,
  membershipEmailStep,
  planPostCommit,
  pinPostCommitTargets,
  runPostCommit,
  POST_COMMIT_STEPS,
  maskEmail,
  recipientKey,
  maskPhone,
  CardedPathRefusal,
  createSideEffectGate,
  gateFrom,
  assertCardedPath,
};
