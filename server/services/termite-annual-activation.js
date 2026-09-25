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
// owns every pricing / due-date / overlap-lock / setup-line / tax /
// service-seeding decision, exactly as it would for any other prepay_annual
// accept — this module never re-implements or re-derives any of that. The
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
// coverage options, the caller's booked-date override, etc). Never required
// to be present or well-formed: convertEstimate's ordinary path falls back
// to its own defaults (e.g. the estimate's own annual_total) for anything
// missing, so a malformed or absent context degrades to "activation
// re-derives pricing from the estimate itself" rather than failing —
// there is no frozen dollar amount here to lose.
function acceptContextFromEstimate(estimate) {
  const context = parseJsonish(estimate?.annual_plan_deferred_invoice);
  return context && typeof context === 'object' ? context : {};
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

async function ringActivationBell(NotificationService, {
  estimateId, contractId, reason, kind = 'activation_error', invoiceId = null,
}) {
  try {
    const { title, body } = bellCopyFor(kind, {
      contractId, estimateId, invoiceId, reason,
    });
    await NotificationService.notifyAdmin(
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
async function activateTermiteAnnualPlanForSignedContract({ contractId, conn = db }) {
  if (!contractId) return { skipped: 'no_contract_id' };
  let estimateId = null;
  try {
    const result = await conn.transaction(async (trx) => {
      const contract = await trx('customer_contracts').where({ id: contractId }).first();
      if (!contract) return { skipped: 'contract_not_found' };
      if (contract.document_template_key !== ANNUAL_TEMPLATE_KEY) return { skipped: 'not_annual_template' };
      if (contract.status !== 'signed') return { skipped: 'not_signed' };

      estimateId = sourceEstimateIdFromContract(contract);
      if (!estimateId) {
        // A signed v3 agreement with no resolvable source estimate is an
        // anomaly (slice 2's context builder should always stamp
        // document_variables_snapshot.estimate.id) — a human needs to find
        // and activate the right estimate by hand, so bell rather than
        // vanish.
        try {
          const NotificationService = require('./notification-service');
          await ringActivationBell(NotificationService, {
            estimateId: null, contractId, kind: 'no_source_estimate', reason: 'the signed agreement has no resolvable source estimate id in its snapshot',
          });
        } catch (bellErr) {
          logger.error(`[termite-annual-activation] bell setup failed for contract ${contractId}: ${bellErr.message}`);
        }
        return { skipped: 'no_source_estimate' };
      }

      const estimate = await trx('estimates').where({ id: estimateId }).forUpdate().first();
      if (!estimate) return { skipped: 'estimate_not_found' };
      // Idempotent: already activated (double-sign / replay / a retried
      // call), or never deferred in the first place — never re-run the
      // money side, and never overwrite a terminal 'activated' stamp.
      if (estimate.annual_plan_activation_status !== 'awaiting_signature') {
        return { skipped: estimate.annual_plan_activation_status || 'not_awaiting_signature' };
      }

      // Codex P2 (starvation): stamp the ATTEMPT before running the
      // conversion, success or failure — the reconciliation sweep's
      // activation scan (below) orders by this and skips a row already
      // attempted today, so a permanently-failing activation can't
      // monopolize the bounded batch ahead of genuinely retryable rows.
      // Best-effort: a stamp failure must not block the actual attempt.
      try {
        await trx('estimates').where({ id: estimateId }).update({ annual_plan_activation_attempted_at: new Date() });
      } catch (stampErr) {
        logger.warn(`[termite-annual-activation] activation-attempt stamp failed for estimate ${estimateId}: ${stampErr.message}`);
      }

      // Codex P1 (round 2): the ordinary prepay_annual path owns invoice
      // creation, dueDate, the per-customer overlap recheck, the setup
      // line, tax, and service seeding — activation only REPLAYS the exact
      // opts the accept parked, with activationRun:true so convertEstimate
      // bypasses the sign-before-pay park (it would otherwise re-park
      // forever) and bills for real. Never re-implement any of that here.
      const acceptContext = acceptContextFromEstimate(estimate);
      const EstimateConverter = require('./estimate-converter');
      const conversion = await EstimateConverter.convertEstimate(estimateId, {
        database: trx,
        activationRun: true,
        billingTerm: 'prepay_annual',
        skipAutoSchedule: true,
        // The activation transaction delivers the invoice itself, below,
        // AFTER this transaction commits — never inline, same as the
        // ordinary accept path's own deferred-delivery convention.
        autoSendInvoice: false,
        prepayInvoiceAmount: acceptContext.prepayInvoiceAmount ?? undefined,
        firstApplicationAmount: acceptContext.firstApplicationAmount ?? undefined,
        allowFirstApplicationFallback: acceptContext.allowFirstApplicationFallback,
        manualDiscountItemization: acceptContext.manualDiscountItemization || undefined,
        adoptedExistingAppointmentId: acceptContext.adoptedExistingAppointmentId || undefined,
        annualPrepayTermStart: acceptContext.annualPrepayTermStart || undefined,
        coverageServiceType: acceptContext.coverageServiceType || undefined,
        coverageVisitCount: acceptContext.coverageVisitCount || undefined,
        coverageCadence: acceptContext.coverageCadence || undefined,
        deferFollowUpReminderRegistration: acceptContext.deferFollowUpReminderRegistration === true,
        deferCommercialScheduleNotification: acceptContext.deferCommercialScheduleNotification === true,
        skipMembershipEmail: acceptContext.skipMembershipEmail === true,
        skipWelcomeSms: acceptContext.skipWelcomeSms === true,
      });

      // Defense in depth: convertEstimate either throws (a coverage guard,
      // the multi-service guard, a term/invoice creation failure — every
      // one of those propagates naturally out of this await and is caught
      // below) or, on success, always returns 'activated' with both ids.
      // This should be unreachable, but never silently report success on a
      // conversion that didn't actually finish.
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

      return { activated: true, termId: conversion.annualPrepayTermId, invoiceId: conversion.draftInvoiceId };
    });

    // Run AFTER the activation transaction above has committed (safer than
    // an inline placement, which can run inside a caller's still-open
    // transaction) — a delivery failure never undoes the money side.
    if (result?.activated) {
      const { invoiceDelivery } = await deliverAnnualInvoiceOrBell({
        estimateId, contractId, invoiceId: result.invoiceId, termId: result.termId, conn,
      });
      result.invoiceDelivery = invoiceDelivery;
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

// The minimal retry for a failed activation. Signing burns the contract's
// share token, so there is no "sign again" path once
// activateTermiteAnnualPlanForSignedContract bells and leaves an estimate
// 'awaiting_signature' — this sweep re-drives it for exactly that stuck
// case. Idempotent by construction, bounded batch, and a single row's
// failure never stops the rest. Abandoned-signature EXPIRY (an estimate
// that never gets signed at all) stays out of scope for this slice.
//
// Query direction: driven from SIGNED CONTRACTS (bounded + ordered by
// signed_at), not from awaiting estimates — an unlucky page of awaiting-but-
// unsigned estimates can never crowd out a genuinely signed one, and every
// row this query returns is immediately actionable.
async function reconcileTermiteAnnualActivations({ conn = db, limit = 200 } = {}) {
  const counts = {
    scanned: 0, activated: 0, skipped: 0, failed: 0,
    deliveryScanned: 0, delivered: 0, deliveryFailed: 0,
  };

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
      // Never-attempted rows first (oldest signed_at among them), then
      // rows attempted on an earlier day — same "oldest actionable first"
      // ordering the delivery scan uses.
      .orderBy('e.annual_plan_activation_attempted_at', 'asc')
      .orderBy('cc.signed_at', 'asc')
      .select('cc.id as contract_id')
      .limit(limit);
    counts.scanned = actionable.length;

    for (const row of actionable) {
      try {
        // Never throws by construction, but this loop guards anyway so one
        // truly unexpected failure can't take the rest of the batch down.
        const result = await activateTermiteAnnualPlanForSignedContract({ contractId: row.contract_id, conn });
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
      .orderBy('inv.created_at', 'asc')
      .select('e.id as estimate_id', 'apt.id as term_id', 'inv.id as invoice_id')
      .limit(limit);
    counts.deliveryScanned = undelivered.length;

    for (const row of undelivered) {
      try {
        const outcome = await deliverAnnualInvoiceOrBell({
          estimateId: row.estimate_id, invoiceId: row.invoice_id, termId: row.term_id, conn,
        });
        if (outcome.ok) counts.delivered += 1;
        else counts.deliveryFailed += 1;
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

  return counts;
}

module.exports = {
  activateTermiteAnnualPlanForSignedContract,
  reconcileTermiteAnnualActivations,
  ANNUAL_TEMPLATE_KEY,
};
