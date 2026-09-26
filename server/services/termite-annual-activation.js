'use strict';

// ============================================================
// termite-annual-activation.js — completes the deferred half of "sign
// before pay" for the Subterranean Termite Protection annual plan (slice
// 3a, restructured 2026-09-25 per round-2 review of #4819).
//
// estimate-converter.js's convertEstimate() PARKS a termite annual-plan
// accept before any tier/pipeline/invoice/term work runs (see its
// parkTermiteAnnualPlanAccept helper) — this module completes that
// deferred work once contracts-public.js's sign route commits a signature
// on that exact agreement template, by calling convertEstimate AGAIN with
// activationRun: true. convertEstimate's ORDINARY prepay_annual branch then
// owns every due-date / setup-line / tax / service-seeding decision (billing
// the price frozen at accept), exactly as it would for any other
// prepay_annual accept — this module never re-implements any of that. It
// adds only the shared per-customer annual-prepay overlap lock, the
// post-commit side effects, and the signature-time collection (charge the
// enrolled method, else the pay link). The
// parallel "snapshot billing minter" this replaces kept drifting from that
// branch on every review round (due date, the overlap lock, the setup
// line, tax, delivery statuses) precisely because it was a second
// implementation of the same decision.
//
// Idempotent by construction: everything happens under a FOR UPDATE lock on
// the source estimate row, gated on
// estimates.annual_plan_activation_status === 'awaiting_signature'. A
// double-sign, a webhook replay, or a retry after a prior partial failure
// all land on the same check and no-op once the estimate reads 'activated'.
//
// Fail-closed, never throws out of the caller: any failure rings the admin
// bell and leaves the estimate 'awaiting_signature' so it can be retried —
// by a re-drive of this function, or by reconcileTermiteAnnualActivations
// below.
// ============================================================

const db = require('../models/db');
const logger = require('./logger');
const { INVOICE_UNCOLLECTIBLE_STATUSES } = require('./invoice-helpers');
const { etDateString } = require('../utils/datetime-et');
const { addMonthsSameDay, dateOnlyString } = require('../utils/date-only');

const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';
const DEFAULT_ANNUAL_PLAN_VERSION = 'v3';

function parseJsonish(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// The termite program agreement (termite-program-agreement.js) has always
// snapshotted its source estimate at document_variables_snapshot.estimate.id
// — reused here rather than adding a new customer_contracts column, per the
// slice's own design note.
function sourceEstimateIdFromContract(contract) {
  const snapshot = parseJsonish(contract?.document_variables_snapshot);
  const id = snapshot?.estimate?.id;
  return id ? String(id) : null;
}

// Parses the accept-context estimate-converter.js's parkTermiteAnnualPlanAccept
// persisted at accept time — the whitelisted opts convertEstimate needs to
// replay the FULL conversion it deferred (billing term inputs, selected
// coverage options, the caller's booked-date override, etc), plus the
// frozen accepted price. The converter itself fails closed when that
// frozen price is missing or malformed (codex round 3: never reprice), so
// a broken context bells and stays awaiting instead of billing.
function acceptContextFromEstimate(estimate) {
  const context = parseJsonish(estimate?.annual_plan_deferred_invoice);
  return context && typeof context === 'object' ? context : {};
}

// The accept-time opts the park persisted, replayed verbatim; an absent
// (null) value is left out so the converter applies its own default.
const REPLAYED_ACCEPT_OPTS = [
  'prepayInvoiceAmount', 'firstApplicationAmount', 'manualDiscountItemization', 'adoptedExistingAppointmentId',
  'annualPrepayTermStart', 'coverageServiceType', 'coverageVisitCount', 'coverageCadence',
];
function replayedAcceptOpts(acceptContext) {
  return Object.fromEntries(REPLAYED_ACCEPT_OPTS
    .filter((key) => acceptContext[key] != null)
    .map((key) => [key, acceptContext[key]]));
}

// One stable key per estimate + failure kind, so a sweep that re-drives the
// SAME stuck estimate every tick (or a caller that retries inline) rings
// exactly once per distinct problem — not once per attempt. Uses
// notifyAdmin's own built-in dedupeKey mechanism rather than hand-rolling a
// second dedupe path — falls back to the contract id when no estimate id is
// known yet (a failure before sourceEstimateIdFromContract resolves one).
function bellDedupeKey(estimateId, contractId, kind) {
  const subject = estimateId || (contractId ? `contract-${contractId}` : null);
  return subject ? `termite-annual-activation:${subject}:${kind}` : undefined;
}

// A delivery failure happens AFTER the activation transaction already
// committed the invoice, term, and 'activated' status — the money is real.
// Reusing the activation-failure copy ("stays awaiting signature — activate
// by hand") told an operator to activate something that was already
// activated, risking a SECOND invoice/term. Delivery failures get their own
// copy: activation succeeded, only the customer-facing send needs a retry,
// naming the invoice.
function bellCopyFor(kind, {
  contractId, estimateId, invoiceId, reason,
}) {
  if (kind === 'delivery_failed') {
    return {
      title: 'Termite annual plan invoice not delivered',
      body: `The signed annual termite agreement (contract #${contractId}${estimateId ? `, estimate #${estimateId}` : ''}) is fully ACTIVATED — invoice #${invoiceId || '?'} and its annual prepay term already exist. Only delivering the invoice to the customer failed: ${reason}. Do NOT create a new invoice or term — resend this exact invoice (the reconciliation sweep will also retry automatically), or send it by hand from the estimate.`,
    };
  }
  if (kind === 'schedule_first_visit') {
    return {
      title: 'Signed termite annual plan — schedule the installation',
      body: `The annual termite agreement (contract #${contractId}${estimateId ? `, estimate #${estimateId}` : ''}) is signed and the plan is active. No visit is on the calendar yet — nothing is booked before signature. ${reason} Book the station installation from the customer's schedule.`,
    };
  }
  if (kind === 'anchor_overlap') {
    return {
      title: 'Termite annual plan — coverage not moved to the installation date',
      body: `The station installation for the signed annual termite plan${estimateId ? ` (estimate #${estimateId})` : ''} is complete, but its coverage year could not be re-anchored to the installation: ${reason}. The term still runs from the signing date — fix the overlapping term, and the daily sweep will anchor it.`,
    };
  }
  if (kind === 'no_source_estimate') {
    return {
      title: 'Termite annual agreement has no linked estimate',
      body: `Signed annual termite agreement (contract #${contractId}) could not be matched back to its source estimate: ${reason}. Nothing was billed — find and activate the correct estimate by hand.`,
    };
  }
  return {
    title: 'Termite annual plan activation needs manual follow-up',
    body: `Signed annual termite agreement (contract #${contractId}${estimateId ? `, estimate #${estimateId}` : ''}) could not activate automatically: ${reason}. The estimate stays "awaiting signature" — recheck after fixing, or activate by hand.`,
  };
}

// Returns notifyAdmin's result — the persisted (or already-persisted,
// deduped) notification row, or null when nothing durable landed — so the
// install handoff below can stamp only a bell that really exists.
async function ringActivationBell(NotificationService, {
  estimateId, contractId, reason, kind = 'activation_error', invoiceId = null,
}) {
  try {
    const { title, body } = bellCopyFor(kind, {
      contractId, estimateId, invoiceId, reason,
    });
    return await NotificationService.notifyAdmin(
      'estimate',
      title,
      body,
      {
        icon: '⚠️',
        link: estimateId ? `/admin/estimates?estimateId=${estimateId}` : undefined,
        bell: true,
        dedupeKey: bellDedupeKey(estimateId, contractId, kind),
        metadata: {
          estimateId, contractId, invoiceId, reason,
        },
      },
    );
  } catch (bellErr) {
    logger.error(`[termite-annual-activation] admin bell failed for contract ${contractId}: ${bellErr.message}`);
    return null;
  }
}

// Codex round-4 P1: activation books no visit, so this staff bell is the
// ONLY handoff that gets the station installation scheduled. It counts as
// handed off only once notifyAdmin durably records it — then
// estimates.annual_plan_install_handoff_at is stamped; until then the
// daily reconciliation re-rings it (the bell's own dedupeKey makes a
// retry after a lost stamp land on the existing row, never a second bell).
//
// Codex round-5 P1: staff who accept while booking (admin-schedule's
// accept-on-book → markEstimateManuallyAccepted) already created the
// installation and linked it to the estimate by source_estimate_id. That
// booking IS the handoff — ringing "nothing is booked" would invite a
// duplicate installation — so it is stamped without a bell. Codex round 6:
// "booked" uses the same plan-scoped installation rule as the anchor
// (whereInstallationVisitForPlan), so a term-linked or same-property booking
// counts too and another property's bait visit never does. A failed lookup
// falls through to the bell (a spurious bell beats a lost handoff).
const DEAD_VISIT_STATUSES = ['cancelled', 'rescheduled'];
async function hasBookedInstallationVisit(conn, estimateId) {
  try {
    const plan = await installationPlanForEstimate(conn, estimateId);
    if (!plan) return false;
    const row = await whereInstallationVisitForPlan(
      conn('scheduled_services as ss').whereNotIn('ss.status', DEAD_VISIT_STATUSES),
      plan,
    ).first('ss.id');
    return Boolean(row);
  } catch (err) {
    logger.warn(`[termite-annual-activation] booked-installation lookup failed for estimate ${estimateId}: ${err.message}`);
    return false;
  }
}

async function ringInstallHandoff({
  estimateId, contractId = null, requestedFirstVisit = null, conn = db,
}) {
  const alreadyBooked = await hasBookedInstallationVisit(conn, estimateId);
  const delivered = alreadyBooked || await ringActivationBell(require('./notification-service'), {
    estimateId, contractId, kind: 'schedule_first_visit', reason: requestedFirstVisitNote(requestedFirstVisit),
  });
  if (!delivered) {
    logger.warn(`[termite-annual-activation] install scheduling handoff not recorded for estimate ${estimateId} — the reconciliation sweep will retry`);
    return false;
  }
  try {
    await conn('estimates')
      .where({ id: estimateId })
      .whereNull('annual_plan_install_handoff_at')
      .update({ annual_plan_install_handoff_at: new Date() });
    return true;
  } catch (stampErr) {
    logger.warn(`[termite-annual-activation] install handoff stamp failed for estimate ${estimateId}: ${stampErr.message}`);
    return false;
  }
}

// Shared by both the immediate post-activation attempt and the
// reconciliation sweep's retry pass, so both paths bell and report
// identically. Never throws.
async function deliverAnnualInvoiceOrBell({
  estimateId, contractId = null, invoiceId, termId, conn = db,
}) {
  try {
    const InvoiceService = require('./invoice');
    const { canAutoSendDraftInvoice } = require('./estimate-converter');
    if (!canAutoSendDraftInvoice({ billingTerm: 'prepay_annual', annualPrepayTermId: termId })) {
      // Shouldn't happen once a term exists (canAutoSendDraftInvoice for
      // prepay_annual is just !!annualPrepayTermId) — fail-soft rather than
      // silently pretending success.
      return { ok: false, invoiceDelivery: { ok: false, error: 'delivery gate refused (no term)' } };
    }
    // Stamp the ATTEMPT before sending, success or failure — the
    // reconciliation sweep's undelivered-invoice scan (below) skips a row
    // already attempted today, so a permanently-failing invoice (no
    // deliverable channel on file, say) gets exactly one attempt per ET
    // calendar day instead of occupying every batch ahead of genuinely
    // retryable rows. Best-effort: a stamp failure must not block the
    // actual delivery attempt.
    try {
      await conn('invoices').where({ id: invoiceId }).update({ annual_delivery_attempted_at: new Date() });
    } catch (stampErr) {
      logger.warn(`[termite-annual-activation] delivery-attempt stamp failed for invoice ${invoiceId}: ${stampErr.message}`);
    }
    const invoiceDelivery = await InvoiceService.sendViaSMSAndEmail(invoiceId, {
      payUrlParams: {
        source: 'estimate',
        saveCard: '1',
        saveRequired: '1',
        billingTerm: 'prepay_annual',
      },
    });
    // Codex P2 (quiet hours): sendViaSMSAndEmail can resolve
    // { ok: false, sms: { scheduled: true } } for a phone-only after-hours
    // send queued for the 8 AM window open — delivery IN PROGRESS, not a
    // failure. estimate-public.js treats the identical shape the same way
    // (invoiceSmsQueued counts as delivered, never bells) — mirrored here
    // so the queued cohort doesn't ring a false-alarm bell every sweep tick
    // until the queue actually flushes.
    const deliveryQueued = invoiceDelivery?.sms?.scheduled === true;
    if (!invoiceDelivery || (invoiceDelivery.ok === false && !deliveryQueued)) {
      const NotificationService = require('./notification-service');
      await ringActivationBell(NotificationService, {
        estimateId, contractId, invoiceId, kind: 'delivery_failed', reason: invoiceDelivery?.error || 'delivery reported not ok',
      });
      return { ok: false, invoiceDelivery };
    }
    return { ok: true, invoiceDelivery };
  } catch (deliveryErr) {
    logger.error(`[termite-annual-activation] invoice delivery failed for estimate ${estimateId} (invoice ${invoiceId}): ${deliveryErr.message}`);
    const invoiceDelivery = {
      ok: false, sms: { ok: false }, email: { ok: false }, error: deliveryErr.message,
    };
    try {
      const NotificationService = require('./notification-service');
      await ringActivationBell(NotificationService, {
        estimateId, contractId, invoiceId, kind: 'delivery_failed', reason: deliveryErr.message,
      });
    } catch (bellErr) {
      logger.error(`[termite-annual-activation] delivery-failure bell failed for estimate ${estimateId}: ${bellErr.message}`);
    }
    return { ok: false, invoiceDelivery };
  }
}

/**
 * Runs the deferred conversion for a just-signed termite annual agreement.
 * Call this AFTER the sign transaction has committed.
 *
 * @param {object} params
 * @param {string|number} params.contractId - the just-signed customer_contracts.id
 * @param {import('knex').Knex} [params.conn] - defaults to the shared db handle
 * @returns {Promise<{activated: boolean}|{skipped: string, [key: string]: any}>}
 */
async function activateTermiteAnnualPlanForSignedContract({ contractId, conn = db, trigger = 'sweep' }) {
  if (!contractId) return { skipped: 'no_contract_id' };
  let estimateId = null;
  try {
    // Unlocked peek, only to resolve the source estimate and stamp the
    // attempt BEFORE the conversion transaction opens (codex round-3 P2):
    // a stamp written inside that transaction rolled back with every
    // failed conversion, so a permanently failing row stayed "never
    // attempted" and kept starving the sweep. Everything is re-read under
    // lock below.
    const peek = await conn('customer_contracts').where({ id: contractId }).first();
    if (!peek) return { skipped: 'contract_not_found' };
    if (peek.document_template_key !== ANNUAL_TEMPLATE_KEY) return { skipped: 'not_annual_template' };
    if (peek.status !== 'signed') return { skipped: 'not_signed' };
    estimateId = sourceEstimateIdFromContract(peek);
    if (!estimateId) {
      // A signed v3 agreement with no resolvable source estimate is an
      // anomaly (slice 2's context builder always stamps
      // document_variables_snapshot.estimate.id) — a human finds and
      // activates the right estimate, so bell rather than vanish.
      await ringActivationBell(require('./notification-service'), {
        estimateId: null, contractId, kind: 'no_source_estimate', reason: 'the signed agreement has no resolvable source estimate id in its snapshot',
      });
      return { skipped: 'no_source_estimate' };
    }
    try {
      await conn('estimates')
        .where({ id: estimateId, annual_plan_activation_status: 'awaiting_signature' })
        .update({ annual_plan_activation_attempted_at: new Date() });
    } catch (stampErr) {
      logger.warn(`[termite-annual-activation] activation-attempt stamp failed for estimate ${estimateId}: ${stampErr.message}`);
    }

    const result = await conn.transaction(async (trx) => {
      const contract = await trx('customer_contracts').where({ id: contractId }).first();
      if (!contract || contract.status !== 'signed') return { skipped: 'not_signed' };

      const estimate = await trx('estimates').where({ id: estimateId }).forUpdate().first();
      if (!estimate) return { skipped: 'estimate_not_found' };
      // Idempotent: already activated (double-sign / replay / a retried
      // call), or never deferred in the first place — never re-run the
      // money side, and never overwrite a terminal 'activated' stamp.
      if (estimate.annual_plan_activation_status !== 'awaiting_signature') {
        return { skipped: estimate.annual_plan_activation_status || 'not_awaiting_signature' };
      }
      const acceptContext = acceptContextFromEstimate(estimate);

      // Codex round-3 P1: the per-customer annual-prepay advisory lock +
      // overlap recheck every other annual-prepay writer takes, held for
      // the rest of this transaction — coverage created for this customer
      // while the agreement was out (an admin annual prepay, another
      // accept) must fail this activation CLOSED (bell, estimate stays
      // awaiting, no invoice) rather than mint a second year.
      const { lockAndAssertNoAnnualPrepayOverlap } = require('../routes/admin-customers')._private;
      try {
        await lockAndAssertNoAnnualPrepayOverlap(
          trx,
          estimate.customer_id,
          acceptContext.annualPrepayTermStart || etDateString(),
          false,
          'Customer already has an annual prepay term through',
          estimateId,
        );
      } catch (overlapErr) {
        if (overlapErr?.annualPrepayOverlap) {
          throw new Error(`overlapping annual coverage — ${overlapErr.annualPrepayOverlap.error}`);
        }
        throw overlapErr;
      }

      // Codex P1 (round 2): the ordinary prepay_annual path owns invoice
      // creation, dueDate, the setup line, tax, and service seeding —
      // activation only REPLAYS the accept-time opts with activationRun
      // (bills the frozen accepted price; see estimate-converter.js).
      // Post-commit side effects are always deferred here (this runs in a
      // caller transaction) and dispatched below once it commits.
      const EstimateConverter = require('./estimate-converter');
      const conversion = await EstimateConverter.convertEstimate(estimateId, {
        database: trx,
        activationRun: true,
        billingTerm: 'prepay_annual',
        skipAutoSchedule: true,
        autoSendInvoice: false,
        ...replayedAcceptOpts(acceptContext),
        allowFirstApplicationFallback: acceptContext.allowFirstApplicationFallback,
        deferFollowUpReminderRegistration: true,
        deferCommercialScheduleNotification: true,
        // Annual prepay sends no membership email on any accept path.
        skipMembershipEmail: true,
        skipWelcomeSms: acceptContext.skipWelcomeSms === true,
        annualPlanVersion: contract.annual_plan_version || DEFAULT_ANNUAL_PLAN_VERSION,
      });

      // Defense in depth: convertEstimate either throws or returns
      // 'activated' with both ids — never report success otherwise.
      if (conversion?.annualPlanActivationStatus !== 'activated'
        || !conversion?.draftInvoiceId || !conversion?.annualPrepayTermId) {
        throw new Error(`Termite annual activation did not complete conversion for estimate ${estimateId} (status=${conversion?.annualPlanActivationStatus || 'unknown'})`);
      }

      // Ruling A-13: the signed v3 annual agreement IS the auto-charge
      // consent — stamp it on the term the moment that signature commits.
      await trx('annual_prepay_terms').where({ id: conversion.annualPrepayTermId }).update({
        annual_plan_version: contract.annual_plan_version || DEFAULT_ANNUAL_PLAN_VERSION,
        renewal_charge_consent_at: contract.signed_at || new Date(),
      });

      return {
        activated: true,
        termId: conversion.annualPrepayTermId,
        invoiceId: conversion.draftInvoiceId,
        customerId: estimate.customer_id,
        conversion,
        requestedFirstVisit: acceptContext.requestedFirstVisit || null,
      };
    });

    // Everything below runs AFTER the activation transaction committed — a
    // failure here never undoes the money side.
    if (result?.activated) {
      const { conversion, requestedFirstVisit, customerId } = result;
      delete result.conversion;
      delete result.requestedFirstVisit;
      delete result.customerId;
      await dispatchDeferredConversionEffects({ estimateId, customerId, conversion });
      await ringInstallHandoff({
        estimateId, contractId, requestedFirstVisit, conn,
      });
      const collection = await collectOrDeliverAnnualInvoice({
        estimateId, contractId, invoiceId: result.invoiceId, termId: result.termId, conn, trigger,
      });
      result.signatureCharge = collection.charge;
      result.invoiceDelivery = collection.invoiceDelivery;
    }

    return result;
  } catch (err) {
    logger.error(`[termite-annual-activation] activation failed for contract ${contractId}${estimateId ? ` (estimate ${estimateId})` : ''}: ${err.message}`);
    try {
      const NotificationService = require('./notification-service');
      await ringActivationBell(NotificationService, { estimateId, contractId, reason: err.message });
    } catch (bellSetupErr) {
      logger.error(`[termite-annual-activation] bell setup failed for contract ${contractId}: ${bellSetupErr.message}`);
    }
    return { skipped: 'error', error: err.message };
  }
}

// Codex round-3 P3/item 3: nothing is booked before signature, so the
// customer's accept-time pick is only a preference for staff.
function requestedFirstVisitNote(requested) {
  if (!requested?.date) return 'The customer did not pick a time when accepting.';
  const window = requested.windowStart ? ` (${String(requested.windowStart).slice(0, 5)} window)` : '';
  return `When accepting, the customer asked for ${requested.date}${window} — that time was NOT held; confirm availability with them.`;
}

// Codex round-3 P1: the activation-time conversion runs inside this
// module's transaction, so the converter hands back — instead of sending —
// its seeded follow-up reminder rows, the new-recurring welcome SMS, and
// the deferred admin notifications. Dispatched here after commit, exactly
// as estimate-public.js's accept route does for its own conversion.
async function dispatchDeferredConversionEffects({ estimateId, customerId, conversion }) {
  const reminderRows = Array.isArray(conversion?.deferredFollowUpReminderRows) ? conversion.deferredFollowUpReminderRows : [];
  if (reminderRows.length) {
    const { registerAcceptedEstimateAppointmentReminder } = require('../routes/estimate-public');
    for (const appointment of reminderRows) {
      try {
        await registerAcceptedEstimateAppointmentReminder({ appointment, customerId, serviceType: appointment.service_type });
      } catch (err) {
        logger.error(`[termite-annual-activation] follow-up reminder registration failed for ${appointment.id} (estimate ${estimateId}): ${err.message}`);
      }
    }
  }
  if (conversion?.welcomeSms) {
    try {
      const { sendNewRecurringWelcome } = require('./new-recurring-welcome-sms');
      void sendNewRecurringWelcome(conversion.welcomeSms)
        .catch((err) => logger.error(`[termite-annual-activation] welcome SMS failed for estimate ${estimateId}: ${err.message}`));
    } catch (err) {
      logger.error(`[termite-annual-activation] welcome SMS setup failed for estimate ${estimateId}: ${err.message}`);
    }
  }
  const NotificationService = require('./notification-service');
  for (const key of ['commercialScheduleNotification', 'perApplicationFeeNotification', 'tierUpgradeNotification', 'planRateReviewNotification']) {
    const n = conversion?.[key];
    if (!n) continue;
    try {
      void NotificationService.notifyAdmin(n.type, n.title, n.body, n.options)
        .catch((err) => logger.error(`[termite-annual-activation] deferred ${key} failed for estimate ${estimateId}: ${err.message}`));
    } catch (err) {
      logger.error(`[termite-annual-activation] deferred ${key} setup failed for estimate ${estimateId}: ${err.message}`);
    }
  }
}

// Owner ruling 2026-09-25: at signature, charge the saved (enrolled)
// payment method once; the pay link goes out only when there is no such
// method, the charge definitively failed, or charging is off. Never both a
// pay link and a charge that may be moving. Never throws.
async function collectOrDeliverAnnualInvoice({
  estimateId, contractId = null, invoiceId, termId, conn = db, trigger = 'sweep',
}) {
  const { chargeAnnualInvoiceAtSignature } = require('./termite-annual-signature-charge');
  const charge = await chargeAnnualInvoiceAtSignature({
    estimateId, contractId, invoiceId, conn, trigger,
  });
  if (!charge.deliverPayLink) return { charge, invoiceDelivery: null, ok: true };
  const delivery = await deliverAnnualInvoiceOrBell({
    estimateId, contractId, invoiceId, termId, conn,
  });
  return { charge, invoiceDelivery: delivery.invoiceDelivery, ok: delivery.ok };
}

// The daily sweep (6:10am cron), four independent bounded passes — one
// pass's failure never stops the next:
//   1. retryAwaitingActivations — re-drives a signed-but-unactivated plan
//   2. retryUndeliveredInvoices — collects / delivers an activated invoice
//      that never went out
//   3. anchorInstalledTerms — re-anchors coverage to the completed
//      installation (codex round 4)
//   4. retryInstallHandoffs — re-rings a scheduling handoff that never
//      durably landed (codex round 4)
async function reconcileTermiteAnnualActivations({ conn = db, limit = 200 } = {}) {
  const counts = {
    scanned: 0, activated: 0, skipped: 0, failed: 0,
    deliveryScanned: 0, delivered: 0, deliveryFailed: 0, charged: 0, collectionHeld: 0,
    anchorScanned: 0, anchored: 0, anchorFailed: 0,
    handoffScanned: 0, handedOff: 0, handoffFailed: 0,
    countersignScanned: 0, countersignReminded: 0,
  };
  await retryAwaitingActivations({ conn, limit, counts });
  await retryUndeliveredInvoices({ conn, limit, counts });
  // Anchor BEFORE the handoff retry: a term whose installation already
  // happened needs no "schedule the installation" bell.
  await anchorInstalledTerms({ conn, limit, counts });
  await retryInstallHandoffs({ conn, limit, counts });
  await remindPendingCountersignatures({ conn, limit, counts });
  return counts;
}

// The admin bell is one shared, recipient-less feed with a single read
// state, so any admin opening the sign-time "countersign needed" prompt, or
// using Mark all read, consumes it before the certified operator (the only
// account POST /countersign accepts) sees it. The durable prompt is this
// daily reminder: while a signed annual agreement stays un-countersigned
// past a day, it re-rings at most once per rolling day (codex #4842 r2 P2).
// Oldest signature first, bounded. Countersigning is a record step, so this
// never touches activation, billing, or scheduling.
const COUNTERSIGN_REMINDER_WINDOW_MS = 23 * 60 * 60 * 1000;

async function remindPendingCountersignatures({ conn, limit, counts }) {
  try {
    const pending = await conn('customer_contracts')
      .where({ document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed' })
      .whereNull('countersigned_at')
      .whereRaw("signed_at < now() - interval '1 day'")
      .orderBy('signed_at', 'asc')
      .select('id', 'customer_id', 'signed_name', 'signed_at')
      .limit(limit);
    counts.countersignScanned = pending.length;
    const NotificationService = require('./notification-service');
    for (const row of pending) {
      try {
        const bell = await NotificationService.notifyAdmin(
          'customer',
          'Termite annual agreement still needs your countersignature',
          `${row.signed_name || 'The customer'} signed the Waves Subterranean Termite Protection annual agreement on ${row.signed_at ? etDateString(new Date(row.signed_at)) : 'an earlier day'}; it has not been countersigned yet. Only the certified operator in charge can countersign, on the Contracts page.`,
          {
            link: '/admin/contracts?tab=requests&status=signed',
            bell: true,
            dedupeKey: `termite-annual-countersign-reminder:${row.id}`,
            dedupeWindowMs: COUNTERSIGN_REMINDER_WINDOW_MS,
            metadata: { customerId: row.customer_id, contractId: row.id },
          },
        );
        if (bell && !bell.deduped) counts.countersignReminded += 1;
      } catch (err) {
        logger.warn(`[termite-annual-activation] countersign reminder failed for contract ${row.id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-activation] countersign reminder scan failed: ${err.message}`);
    counts.countersignScanError = err.message;
  }
}

// The minimal retry for a failed activation. Signing burns the contract's
// share token, so there is no "sign again" path once
// activateTermiteAnnualPlanForSignedContract bells and leaves an estimate
// 'awaiting_signature' — this pass re-drives it for exactly that stuck
// case. Idempotent by construction, bounded batch, and a single row's
// failure never stops the rest. Abandoned-signature EXPIRY (an estimate
// that never gets signed at all) stays out of scope for this slice.
//
// Query direction: driven from SIGNED CONTRACTS (bounded + ordered by
// signed_at), not from awaiting estimates — an unlucky page of awaiting-but-
// unsigned estimates can never crowd out a genuinely signed one, and every
// row this query returns is immediately actionable.
async function retryAwaitingActivations({ conn, limit, counts }) {
  try {
    const actionable = await conn('customer_contracts as cc')
      // Matched the same way activateTermiteAnnualPlanForSignedContract
      // resolves its own source estimate — document_variables_snapshot's
      // JSONB estimate.id, never a new column (see the module header).
      .join('estimates as e', conn.raw("e.id::text = cc.document_variables_snapshot -> 'estimate' ->> 'id'"))
      .where('cc.document_template_key', ANNUAL_TEMPLATE_KEY)
      .where('cc.status', 'signed')
      .where('e.annual_plan_activation_status', 'awaiting_signature')
      // Codex P2 (starvation): a permanently-failing activation (e.g. a
      // structurally broken accept-context, or a coverage guard that will
      // never resolve without a human) retains its attempt stamp from
      // TODAY and is skipped rather than re-drawn every tick, so it can't
      // monopolize the bounded batch ahead of genuinely retryable rows —
      // same ET-calendar-day throttle as the delivery scan below.
      .where((builder) => {
        builder.whereNull('e.annual_plan_activation_attempted_at')
          .orWhereRaw("(e.annual_plan_activation_attempted_at AT TIME ZONE 'America/New_York')::date < (now() AT TIME ZONE 'America/New_York')::date");
      })
      // Never-attempted rows first, then the LEAST recently attempted
      // (codex round-3 P2: NULLS FIRST is explicit — Postgres sorts NULLs
      // last on ASC), then oldest signed_at — so failing rows rotate to
      // the back of the queue across daily runs instead of re-occupying
      // the front of every batch.
      .orderBy('e.annual_plan_activation_attempted_at', 'asc', 'first')
      .orderBy('cc.signed_at', 'asc')
      .select('cc.id as contract_id')
      .limit(limit);
    counts.scanned = actionable.length;

    for (const row of actionable) {
      try {
        // Never throws by construction, but this loop guards anyway so one
        // truly unexpected failure can't take the rest of the batch down.
        const result = await activateTermiteAnnualPlanForSignedContract({ contractId: row.contract_id, conn, trigger: 'sweep' });
        if (result?.activated) counts.activated += 1;
        // An explicit { skipped: 'error' } result means
        // activateTermiteAnnualPlanForSignedContract caught a real failure
        // (it already bells) — count it as failed, not a routine skip, so
        // a tick where every signed activation fails still reports
        // failures (and the scheduler's summary log line, gated on
        // `activated || failed`, actually fires).
        else if (result?.skipped === 'error') counts.failed += 1;
        else counts.skipped += 1;
      } catch (err) {
        counts.failed += 1;
        logger.error(`[termite-annual-activation] reconciliation activation errored for contract ${row.contract_id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-activation] reconciliation activation scan failed: ${err.message}`);
    counts.activationScanError = err.message;
  }

}

async function retryUndeliveredInvoices({ conn, limit, counts }) {
  // The sweep's second job — an already-ACTIVATED estimate whose invoice
  // never got delivered (a prior sendViaSMSAndEmail failure, or the
  // process dying between activation and delivery). Found via the
  // invoice's own existing links — no new column: annual_prepay_terms.
  // source_estimate_id -> the estimate, annual_prepay_terms.
  // prepay_invoice_id -> the invoice, and invoices.sent_at IS NULL is the
  // same "never delivered" signal sendViaSMSAndEmail itself stamps on
  // success. Only ever matches a termite-annual term: source_estimate_id
  // only points at an estimate carrying annual_plan_activation_status at
  // all for this program.
  try {
    const undelivered = await conn('estimates as e')
      .join('annual_prepay_terms as apt', conn.raw('apt.source_estimate_id = e.id'))
      .join('invoices as inv', conn.raw('inv.id = apt.prepay_invoice_id'))
      .where('e.annual_plan_activation_status', 'activated')
      // Only the ORIGINAL activation term (a renewal successor carries
      // renewed_from_term_id and owns its own invoice workflow), and only a
      // still-collectable invoice — the canonical uncollectible-status set
      // InvoiceService's own callers already share (codex P2: this used to
      // be an ad hoc list missing 'prepaid' and carrying a 'voided' typo
      // not in the real status vocabulary), never re-send a settled one.
      // "Never delivered" on EVERY channel: sent_at is the combined stamp,
      // sms_sent_at / email_sent_at are the per-channel durable stamps
      // invoice.js also writes.
      .whereNull('apt.renewed_from_term_id')
      .whereNotIn('inv.status', INVOICE_UNCOLLECTIBLE_STATUSES)
      .whereNull('inv.sent_at')
      .whereNull('inv.sms_sent_at')
      .whereNull('inv.email_sent_at')
      // A permanently-failing row (e.g. no deliverable channel on file)
      // retains all three NULL delivery stamps forever — without this, it
      // would keep sorting to the front and monopolizing the LIMIT batch,
      // starving genuinely retryable invoices behind it. Skip anything
      // already attempted TODAY (ET calendar day; the sweep runs once
      // daily), and order oldest-invoice-first so the longest-waiting
      // customers are attempted first among what's left.
      .where((builder) => {
        builder.whereNull('inv.annual_delivery_attempted_at')
          .orWhereRaw("(inv.annual_delivery_attempted_at AT TIME ZONE 'America/New_York')::date < (now() AT TIME ZONE 'America/New_York')::date");
      })
      // Signature-charge state (owner ruling 2026-09-25): only rows whose
      // charge was never claimed (a crash before the attempt, or a released
      // claim), or whose charge definitively ended in the pay-link lane,
      // plus a claim stuck unresolved for over an hour (so staff get the
      // reconciliation bell). Paid / processing / ambiguous / deferred rows
      // are settled or staff-owned — never a pay link.
      .where((builder) => {
        builder.whereNull('e.annual_plan_signature_charge')
          .orWhereRaw("e.annual_plan_signature_charge ->> 'status' IN ('declined', 'skipped')")
          .orWhereRaw("e.annual_plan_signature_charge ->> 'status' = 'claimed' AND (e.annual_plan_signature_charge ->> 'claimed_at')::timestamptz < now() - interval '1 hour'");
      })
      // Least-recently-attempted first, never-attempted ahead of all
      // (codex round-3 P2), then oldest invoice — a failing backlog larger
      // than the limit rotates instead of re-selecting the same rows daily.
      .orderBy('inv.annual_delivery_attempted_at', 'asc', 'first')
      .orderBy('inv.created_at', 'asc')
      .select('e.id as estimate_id', 'apt.id as term_id', 'inv.id as invoice_id')
      .limit(limit);
    counts.deliveryScanned = undelivered.length;

    for (const row of undelivered) {
      try {
        // Stamp the attempt for every row this pass touches — including
        // one the charge step settles or holds for staff without a send —
        // so the per-day throttle and rotation cover it too.
        try {
          await conn('invoices').where({ id: row.invoice_id }).update({ annual_delivery_attempted_at: new Date() });
        } catch (stampErr) {
          logger.warn(`[termite-annual-activation] delivery-attempt stamp failed for invoice ${row.invoice_id}: ${stampErr.message}`);
        }
        const outcome = await collectOrDeliverAnnualInvoice({
          estimateId: row.estimate_id, invoiceId: row.invoice_id, termId: row.term_id, conn, trigger: 'sweep',
        });
        if (outcome.invoiceDelivery && outcome.ok) counts.delivered += 1;
        else if (outcome.invoiceDelivery) counts.deliveryFailed += 1;
        else if (outcome.charge?.status === 'paid' || outcome.charge?.status === 'processing') counts.charged += 1;
        else counts.collectionHeld += 1;
      } catch (err) {
        // deliverAnnualInvoiceOrBell never throws by construction; guarded
        // anyway for the same reason as the activation loop above.
        counts.deliveryFailed += 1;
        logger.error(`[termite-annual-activation] reconciliation delivery errored for estimate ${row.estimate_id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-activation] reconciliation delivery scan failed: ${err.message}`);
    counts.deliveryScanError = err.message;
  }

}


// ---- installation anchor (codex round-4 P1) --------------------------
// The signed agreement says coverage starts at installation, but activation
// books no visit, so createTermForAnnualPrepay mints the term with a
// PROVISIONAL start on the signature day (kept so the term exists for the
// invoice). Once the termite installation visit is COMPLETED, the original
// term is re-anchored to that visit's date + 12 months — exactly once
// (annual_prepay_terms.installation_anchored_at), and never after a renewal
// exists or was decided.
//
// Driven from this daily sweep over completed visits rather than a hook
// inside completeScheduledService: visits complete through several writers
// (the tech/admin closeout, the invoice-issued closeout, backfill), and the
// repo's existing termite term anchor — lifecycle-email-sweeps.js's
// termite-bond sync — reads completed visits the same way, so every
// completion path is covered by one reader. The re-anchor is at most a day
// behind the installation; renewal notices sit weeks out.
//
// The window moves through createTermForAnnualPrepay's own edit path (the
// same one an admin window edit uses): it detaches out-of-window visits,
// re-runs coverage, and re-syncs customers.waveguard_renewal_date — so
// renewal notices (which read term_end / last_scheduled_service_date) see
// the anchored dates.
const ANCHORABLE_TERM_STATUSES = ['payment_pending', 'active'];

// The termite program's installation visit, by the same service-type rule
// termite-program-agreement.js's scheduledStartDate uses to find the
// program start: a termite service naming the bait or the stations.
// The schedule's own installation service is "Termite Installation Setup"
// (admin-schedule.js, key termite_installation_setup), which names neither
// bait nor stations; "Termite Bora-Care Install" is a liquid treatment and
// never matches.
function whereTermiteInstallationServiceType(builder, alias) {
  return builder
    .whereRaw(`LOWER(${alias}.service_type) LIKE '%termite%'`)
    .whereRaw(`(LOWER(${alias}.service_type) LIKE '%bait%' OR LOWER(${alias}.service_type) LIKE '%station%'
      OR LOWER(${alias}.service_type) LIKE '%installation setup%')`);
}

// An installation can't precede the plan it installs: only visits on or
// after the earlier of the provisional start and the activation day count
// (an older bait program on the same account never anchors this term).
function installationFloorFor(term) {
  const provisionalStart = dateOnlyString(term.term_start);
  const activatedOn = term.created_at ? etDateString(new Date(term.created_at)) : provisionalStart;
  return activatedOn && activatedOn < provisionalStart ? activatedOn : provisionalStart;
}

// Codex round-6 P1: THE rule for "this visit is this plan's installation",
// shared by the anchor, its candidate scan and the install handoff. A termite
// bait/station visit of the plan's customer, on or after the plan's floor,
// that belongs to THIS plan:
//   - booked from the plan's estimate (source_estimate_id), or
//   - linked to the plan's term (annual_prepay_term_id) and not recorded at
//     a different property than the estimate, or
//   - recorded at the estimate's property (property_id), or
//   - the customer has at most one property on file (no other site exists).
// A multi-property customer's visit with no link and no matching property
// never qualifies — a bait visit at property B must never anchor, or stand
// in as booked for, property A's plan. `plan` values are literals, or
// knex refs when the caller correlates against apt / e (the candidate scan).
function whereInstallationVisitForPlan(builder, plan) {
  whereTermiteInstallationServiceType(builder, 'ss').where('ss.customer_id', plan.customerId);
  if (plan.floor) builder.whereRaw('ss.scheduled_date >= ?', [plan.floor]);
  return builder.where(function belongsToPlan() {
    this.whereRaw('ss.source_estimate_id = ?', [plan.estimateId])
      .orWhereRaw('(ss.annual_prepay_term_id = ? AND COALESCE(ss.property_id = ?, TRUE))', [plan.termId, plan.estimatePropertyId])
      .orWhereRaw('ss.property_id = ?', [plan.estimatePropertyId])
      .orWhereRaw('(SELECT COUNT(*) FROM customer_properties cp WHERE cp.customer_id = ?) <= 1', [plan.customerId]);
  });
}

function installationPlanFor(term, estimate) {
  return {
    customerId: term.customer_id,
    estimateId: term.source_estimate_id || null,
    estimatePropertyId: estimate?.property_id || null,
    termId: term.id,
    floor: installationFloorFor(term),
  };
}

// The plan behind an estimate: its original (non-renewal) term + property.
async function installationPlanForEstimate(conn, estimateId) {
  const estimate = await conn('estimates').where({ id: estimateId }).first('id', 'customer_id', 'property_id');
  if (!estimate) return null;
  const term = await conn('annual_prepay_terms')
    .where({ source_estimate_id: estimateId })
    .whereNull('renewed_from_term_id')
    .orderBy('created_at', 'asc')
    .first('id', 'customer_id', 'source_estimate_id', 'term_start', 'created_at');
  if (!term) {
    return {
      customerId: estimate.customer_id, estimateId: estimate.id, estimatePropertyId: estimate.property_id || null, termId: null, floor: null,
    };
  }
  return installationPlanFor(term, estimate);
}

async function anchorTermToInstallation({ termId, conn = db }) {
  return conn.transaction(async (trx) => {
    const peek = await trx('annual_prepay_terms').where({ id: termId }).first('customer_id');
    if (!peek) return { skipped: 'term_not_found' };
    // The per-customer annual-prepay advisory lock every term writer holds
    // (allowOverlap=true: lock only — the moved window is checked below).
    const { lockAndAssertNoAnnualPrepayOverlap, annualPrepayOverlapStatusClause } = require('../routes/admin-customers')._private;
    await lockAndAssertNoAnnualPrepayOverlap(trx, peek.customer_id, null, true, '');
    const term = await trx('annual_prepay_terms').where({ id: termId }).forUpdate().first();
    if (!term || term.installation_anchored_at) return { skipped: 'already_anchored' };
    if (term.renewed_from_term_id || term.renewal_decision || !ANCHORABLE_TERM_STATUSES.includes(term.status)) {
      return { skipped: 'not_original_term' };
    }
    if (await trx('annual_prepay_terms').where({ renewed_from_term_id: term.id }).first('id')) return { skipped: 'renewed' };

    const estimate = term.source_estimate_id
      ? await trx('estimates').where({ id: term.source_estimate_id }).first('property_id')
      : null;
    const installation = await whereInstallationVisitForPlan(
      trx('scheduled_services as ss').where('ss.status', 'completed'),
      installationPlanFor(term, estimate),
    ).orderBy('ss.scheduled_date', 'asc').first('ss.id', 'ss.scheduled_date');
    if (!installation) return { skipped: 'no_completed_installation' };

    const termStart = dateOnlyString(installation.scheduled_date);
    const termEnd = addMonthsSameDay(termStart, 12);
    const clash = await trx('annual_prepay_terms')
      .where({ customer_id: term.customer_id })
      .whereNot({ id: term.id })
      .where(annualPrepayOverlapStatusClause())
      .where('term_start', '<=', termEnd)
      .where('term_end', '>=', termStart)
      .first('id');
    if (clash) return { skipped: 'overlap', clashTermId: clash.id, termStart };

    // Stamp the anchor FIRST: coverage seeding is deferred until it exists
    // (annual-prepay-renewals.js coverageAwaitsInstallation), so the refresh
    // below must already see it — then the coverage year's visit is resolved
    // against the anchored window, with the installation itself counting as
    // that year's visit (installation_anchor_visit_id), never a second seed.
    await trx('annual_prepay_terms').where({ id: term.id }).update({
      installation_anchored_at: new Date(),
      installation_anchor_visit_id: installation.id,
      updated_at: new Date(),
    });
    const moved = termStart !== dateOnlyString(term.term_start) || termEnd !== dateOnlyString(term.term_end);
    const AnnualPrepayRenewals = require('./annual-prepay-renewals');
    if (moved) {
      await AnnualPrepayRenewals.createTermForAnnualPrepay({
        customerId: term.customer_id,
        sourceEstimateId: term.source_estimate_id,
        prepayInvoiceId: term.prepay_invoice_id,
        planLabel: term.plan_label,
        termStart,
        termEnd,
        conn: trx,
      });
    } else {
      await AnnualPrepayRenewals.refreshTermSnapshot(term.id, trx);
    }
    return {
      anchored: true, termId: term.id, termStart, termEnd, moved,
    };
  });
}

async function anchorInstalledTerms({ conn, limit, counts }) {
  try {
    const candidates = await conn('annual_prepay_terms as apt')
      .join('estimates as e', 'e.id', 'apt.source_estimate_id')
      .where('e.annual_plan_activation_status', 'activated')
      .whereNull('apt.installation_anchored_at')
      .whereNull('apt.renewed_from_term_id')
      .whereNull('apt.renewal_decision')
      .whereIn('apt.status', ANCHORABLE_TERM_STATUSES)
      .whereExists(function completedInstallation() {
        whereInstallationVisitForPlan(
          this.select(conn.raw('1')).from('scheduled_services as ss').where('ss.status', 'completed'),
          {
            customerId: conn.ref('apt.customer_id'),
            estimateId: conn.ref('e.id'),
            estimatePropertyId: conn.ref('e.property_id'),
            termId: conn.ref('apt.id'),
            floor: conn.raw("LEAST(apt.term_start, (apt.created_at AT TIME ZONE 'America/New_York')::date)"),
          },
        );
      })
      // Least-recently-attempted first, never-attempted ahead of all, then
      // oldest term (codex #4819 r7 P2) — a backlog of permanently failing
      // anchors (overlap, thrown error) larger than the limit rotates
      // instead of re-selecting the same oldest batch every day and
      // starving newer completed installations.
      .orderBy('apt.installation_anchor_attempted_at', 'asc', 'first')
      .orderBy('apt.created_at', 'asc')
      .select('apt.id as term_id', 'e.id as estimate_id')
      .limit(limit);
    counts.anchorScanned = candidates.length;
    for (const row of candidates) {
      // Stamped before the attempt and outside its transaction, so a
      // failure (thrown or overlap) still rotates the row to the back.
      try {
        await conn('annual_prepay_terms').where({ id: row.term_id })
          .update({ installation_anchor_attempted_at: new Date() });
      } catch (stampErr) {
        logger.warn(`[termite-annual-activation] anchor-attempt stamp failed for term ${row.term_id}: ${stampErr.message}`);
      }
      try {
        const result = await anchorTermToInstallation({ termId: row.term_id, conn });
        if (result?.anchored) {
          counts.anchored += 1;
          logger.info(`[termite-annual-activation] term ${row.term_id} anchored to installation: ${result.termStart} → ${result.termEnd}${result.moved ? '' : ' (unchanged)'}`);
        } else if (result?.skipped === 'overlap') {
          counts.anchorFailed += 1;
          await ringActivationBell(require('./notification-service'), {
            estimateId: row.estimate_id,
            contractId: null,
            kind: 'anchor_overlap',
            reason: `anchoring coverage to the installation on ${result.termStart} would overlap annual prepay term ${result.clashTermId}`,
          });
        }
      } catch (err) {
        counts.anchorFailed += 1;
        logger.error(`[termite-annual-activation] installation anchor failed for term ${row.term_id}: ${err.message}`);
      }
    }
  } catch (err) {
    logger.error(`[termite-annual-activation] installation anchor scan failed: ${err.message}`);
    counts.anchorScanError = err.message;
  }
}

// Re-rings the install-scheduling handoff for activated plans whose bell
// never durably landed (see ringInstallHandoff). A term already anchored to
// its completed installation needs no scheduling, and a cancelled term
// none either. Oldest activation first, never-stamped activation times
// ahead of all, bounded.
async function retryInstallHandoffs({ conn, limit, counts }) {
  try {
    const pending = await conn('annual_prepay_terms as apt')
      .join('estimates as e', 'e.id', 'apt.source_estimate_id')
      .where('e.annual_plan_activation_status', 'activated')
      .whereNull('e.annual_plan_install_handoff_at')
      .whereNull('apt.renewed_from_term_id')
      .whereNull('apt.installation_anchored_at')
      .whereIn('apt.status', ANCHORABLE_TERM_STATUSES)
      .orderBy('e.annual_plan_activated_at', 'asc', 'first')
      .select('e.id as estimate_id', 'e.annual_plan_deferred_invoice')
      .limit(limit);
    counts.handoffScanned = pending.length;
    for (const row of pending) {
      const contract = await conn('customer_contracts')
        .where({ document_template_key: ANNUAL_TEMPLATE_KEY, status: 'signed' })
        .whereRaw("document_variables_snapshot -> 'estimate' ->> 'id' = ?", [String(row.estimate_id)])
        .orderBy('signed_at', 'desc')
        .first('id')
        .catch(() => null);
      const handedOff = await ringInstallHandoff({
        estimateId: row.estimate_id,
        contractId: contract?.id || null,
        requestedFirstVisit: acceptContextFromEstimate(row).requestedFirstVisit || null,
        conn,
      });
      if (handedOff) counts.handedOff += 1;
      else counts.handoffFailed += 1;
    }
  } catch (err) {
    logger.error(`[termite-annual-activation] install handoff scan failed: ${err.message}`);
    counts.handoffScanError = err.message;
  }
}

module.exports = {
  activateTermiteAnnualPlanForSignedContract,
  anchorTermToInstallation,
  reconcileTermiteAnnualActivations,
  ANNUAL_TEMPLATE_KEY,
};
