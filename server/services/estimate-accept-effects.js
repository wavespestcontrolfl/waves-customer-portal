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

function positiveAmount(item) {
  for (const key of ['price', 'amount', 'total', 'priceAfterDiscount', 'totalAfterDiscount']) {
    const n = Number(item?.[key]);
    if (Number.isFinite(n) && n > 0) return round2(n);
  }
  return null;
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
function oneTimeLineEffects(estimate, converter) {
  if (typeof converter?.estimateOneTimeItemsFromData !== 'function') return [];
  const items = converter.estimateOneTimeItemsFromData(parseData(estimate.estimate_data), { collapseMirrored: true });
  return items
    .map((item) => ({ name: String(item.name || item.label || item.service || 'One-time service').trim(), amount: positiveAmount(item) }))
    .filter((line) => line.amount != null)
    .map((line) => ({ kind: 'one_time_line', ...line, consequence: 'schedule_and_invoice_by_hand' }));
}

// ── The post-commit plan ──

const BELLS = [
  ['commercial_schedule', 'commercialScheduleNotification'],
  ['per_application_fee', 'perApplicationFeeNotification'],
  ['tier_upgrade', 'tierUpgradeNotification'],
  ['plan_rate_review', 'planRateReviewNotification'],
];

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
    prefs = await trx.transaction((sp) => sp('notification_prefs').where({ customer_id: customerId }).first());
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
  return { step: 'membership_email', attempt: true, will_send: true, reason: null, to: maskEmail(emailInputs.email) };
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
    ...(customerId ? [{ step: 'property_link' }] : []),
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

function fireAdminBell(payload, estimateId, label) {
  try {
    const NotificationService = require('./notification-service');
    void NotificationService.notifyAdmin(payload.type, payload.title, payload.body, payload.options)
      .catch((err) => logger.warn(`[estimate-manual-acceptance] ${label} notify failed for estimate ${estimateId}: ${err.message}`));
  } catch (err) {
    logger.warn(`[estimate-manual-acceptance] ${label} notify setup failed for estimate ${estimateId}: ${err.message}`);
  }
}

const BELL_LABELS = {
  commercial_schedule: 'commercial-schedule admin',
  per_application_fee: 'per-application fee admin',
  tier_upgrade: 'tier-upgrade admin',
  plan_rate_review: 'plan-rate review',
};

const POST_COMMIT_RUNNERS = {
  async group_followup_transfer(_step, ctx) {
    try {
      await require('../routes/estimate-public').transferGroupFollowupOwnership(ctx.acceptedEstimate);
    } catch (e) {
      logger.warn(`[manual-acceptance] follow-up ownership transfer failed for estimate ${ctx.acceptedEstimate.id}: ${e.message}`);
    }
  },
  async property_link(_step, ctx) {
    await require('./estimate-property-linkage').linkAcceptedEstimateProperty({
      estimateId: ctx.acceptedEstimate.id,
      customerId: ctx.acceptedEstimate.customer_id || ctx.proposalCustomer?.id || null,
    });
  },
  async lead_won(_step, ctx) {
    const { acceptedEstimate } = ctx;
    try {
      await ctx.leadLinkService.markLinkedLeadEstimateAccepted({
        estimateId: acceptedEstimate.id,
        customerId: acceptedEstimate.customer_id || null,
        monthlyValue: ctx.asMoneyOrNull(acceptedEstimate.monthly_total),
        initialServiceValue: ctx.asMoneyOrNull(acceptedEstimate.onetime_total),
        waveguardTier: acceptedEstimate.waveguard_tier || null,
      });
    } catch (err) {
      logger.warn(`[estimate-manual-acceptance] linked lead conversion failed for estimate ${acceptedEstimate.id}: ${err.message}`);
      ctx.warnings.push('Linked lead was not marked won automatically.');
    }
  },
  async membership_email(_step, ctx) {
    // The card approved "no email" (opted out, no address): that decision
    // rides through delivery. A fresh opt-out still vetoes a planned send in
    // the sender itself.
    if (ctx.approvedEmail === 'skip') return;
    const AccountMembershipEmail = require('./account-membership-email');
    void AccountMembershipEmail.sendMembershipStarted(ctx.conversion.membershipEmail)
      .catch((err) => logger.warn(`[estimate-manual-acceptance] membership.started email failed for estimate ${ctx.acceptedEstimate.id}: ${err.message}`));
  },
  async welcome_sms(_step, ctx) {
    // Conversion runs inside the accept transaction, so the converter defers
    // the new-recurring welcome SMS. Idempotent.
    const { sendNewRecurringWelcome } = require('./new-recurring-welcome-sms');
    void sendNewRecurringWelcome(ctx.conversion.welcomeSms)
      .catch((err) => logger.warn(`[estimate-manual-acceptance] welcome SMS failed for estimate ${ctx.acceptedEstimate.id}: ${err.message}`));
  },
  async termite_agreement(_step, ctx) {
    const { acceptedEstimate } = ctx;
    const agreementCustomerId = acceptedEstimate.customer_id || ctx.proposalCustomer?.id || null;
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
  async admin_bell(step, ctx) {
    const field = BELLS.find(([bell]) => bell === step.bell)[1];
    fireAdminBell(ctx.conversion[field], ctx.acceptedEstimate.id, BELL_LABELS[step.bell]);
  },
};

// Execute the plan in order. `ctx` carries the committed accept (acceptedEstimate,
// conversion, proposalCustomer), the page's inputs and `approvedEmail`
// ('skip' when the approved card said no email).
async function runPostCommit(plan, ctx) {
  for (const step of plan) await POST_COMMIT_RUNNERS[step.step](step, ctx);
}

module.exports = {
  DryRunRollback,
  createEffectLog,
  effectsFingerprint,
  snapshotAcceptState,
  stateDiffEffects,
  conversionEffect,
  oneTimeLineEffects,
  readEmailInputs,
  membershipEmailStep,
  planPostCommit,
  runPostCommit,
  maskEmail,
};
