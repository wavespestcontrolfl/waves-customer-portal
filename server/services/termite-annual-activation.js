'use strict';

// ============================================================
// termite-annual-activation.js — completes the deferred half of "sign
// before pay" for the Subterranean Termite Protection annual plan (slice
// 3a, owner ruling 2026-09-24, dark behind GATE_TERMITE_ANNUAL_PLAN).
//
// estimate-converter.js defers the annual-fee invoice + annual_prepay_terms
// row on accept until the customer e-signs the annual agreement — this
// module runs that deferred work once contracts-public.js's sign route
// commits a signature on that exact agreement template.
//
// Idempotent by construction: everything happens under a FOR UPDATE lock on
// the source estimate row, gated on
// estimates.annual_plan_activation_status === 'awaiting_signature'. A
// double-sign, a webhook replay, or a retry after a prior partial failure
// all land on the same check and no-op once the estimate reads 'activated'.
//
// Fail-closed, never throws out of the caller: any failure rings the admin
// bell and leaves the estimate 'awaiting_signature' so it can be retried —
// by a re-drive of this function, or by the slice-3b reconciliation sweep
// (TODO: not built in this slice — see estimate-converter.js's deferral
// comment for the same TODO).
// ============================================================

const db = require('../models/db');
const logger = require('./logger');

const ANNUAL_TEMPLATE_KEY = 'service_agreement.termite_annual_protection';
const DEFAULT_ANNUAL_PLAN_VERSION = 'v3';
// The annual plan is one inspection per year (gate comment on
// GATE_TERMITE_ANNUAL_PLAN, feature-gates.js) — fixed coverage shape, not
// derived per-estimate the way the generic multi-program prepay path does.
const COVERAGE_SERVICE_TYPE = 'Termite Bait';
const COVERAGE_VISIT_COUNT = 1;
const COVERAGE_CADENCE = 'annual';

function parseJsonish(raw) {
  if (!raw) return null;
  if (typeof raw === 'object') return raw;
  try { return JSON.parse(raw); } catch { return null; }
}

// The termite program agreement (termite-program-agreement.js) has always
// snapshotted its source estimate at document_variables_snapshot.estimate.id
// — reused here rather than adding a new customer_contracts column, per the
// slice's own design note. Slice 2 (the v3 annual template, PR #4811, not
// yet merged) builds its render context the same way; if that ever
// diverges, sourceEstimateId comes back null and this function fails
// closed below rather than guessing.
function sourceEstimateIdFromContract(contract) {
  const snapshot = parseJsonish(contract?.document_variables_snapshot);
  const id = snapshot?.estimate?.id;
  return id ? String(id) : null;
}

// Codex P1-2: activation must bill EXACTLY what estimate-converter.js's
// prepay_annual branch decided to bill at accept time (annualAmount post
// WaveGuard discount, the rodent-bait setup line, the resolved tax rate,
// the exact line-item descriptions) — never re-derive it from
// selectedTermiteAnnualPlanRows here. Re-deriving would silently drop the
// setup-fee line (setup rows carry no `.annual` field) and could disagree
// with the accepted amount if pricing config, a WaveGuard tier discount, or
// a tax rate changed between acceptance and signature — the estimate
// converter is the ONLY place that ever prices this invoice; this module
// only replays its decision.
function validDeferredInvoiceSnapshot(raw) {
  const snapshot = parseJsonish(raw);
  if (!snapshot || typeof snapshot !== 'object') return null;
  if (!Array.isArray(snapshot.lines) || snapshot.lines.length === 0) return null;
  if (!snapshot.lines.every((line) => line && Number(line.unit_price) > 0)) return null;
  if (!(Number(snapshot.amountCents) > 0)) return null;
  return snapshot;
}

// Codex P1 (2 of the last round): one stable key per estimate + failure
// kind, so a sweep that re-drives the SAME stuck estimate every tick (or a
// caller that retries inline) rings exactly once per distinct problem — not
// once per attempt. Uses notifyAdmin's own built-in dedupeKey mechanism
// (notification-service.js: opt-in, advisory-locked, no dedupeKey = today's
// unchanged behavior for every other caller) rather than hand-rolling a
// second dedupe path — falls back to the contract id when no estimate id is
// known yet (a failure before sourceEstimateIdFromContract resolves one).
function bellDedupeKey(estimateId, contractId, kind) {
  const subject = estimateId || (contractId ? `contract-${contractId}` : null);
  return subject ? `termite-annual-activation:${subject}:${kind}` : undefined;
}

async function ringActivationBell(NotificationService, {
  estimateId, contractId, reason, kind = 'activation_error',
}) {
  try {
    await NotificationService.notifyAdmin(
      'estimate',
      'Termite annual plan activation needs manual follow-up',
      `Signed annual termite agreement (contract #${contractId}${estimateId ? `, estimate #${estimateId}` : ''}) could not activate automatically: ${reason}. The estimate stays "awaiting signature" — recheck after fixing, or activate by hand.`,
      {
        icon: '⚠️',
        link: estimateId ? `/admin/estimates?estimateId=${estimateId}` : undefined,
        bell: true,
        dedupeKey: bellDedupeKey(estimateId, contractId, kind),
        metadata: { estimateId, contractId, reason },
      },
    );
  } catch (bellErr) {
    logger.error(`[termite-annual-activation] admin bell failed for contract ${contractId}: ${bellErr.message}`);
  }
}

// Codex P1 (1 of the last round): a delivery failure used to be silent and
// unretried — the estimate reads 'activated' (money is real) but nobody
// hears about it. Rings its OWN deduped bell (distinct 'delivery_failed'
// kind from the activation-failure bell above) and reports ok:false so the
// caller can decide what to do; it never throws. Shared by both the
// immediate post-activation attempt and the reconciliation sweep's retry
// pass, so both paths bell and report identically.
async function deliverAnnualInvoiceOrBell({
  estimateId, contractId = null, invoiceId, termId,
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
    const invoiceDelivery = await InvoiceService.sendViaSMSAndEmail(invoiceId, {
      payUrlParams: {
        source: 'estimate',
        saveCard: '1',
        saveRequired: '1',
        billingTerm: 'prepay_annual',
      },
    });
    // sendViaSMSAndEmail can resolve a failure descriptor WITHOUT throwing
    // (a claim fence, a suppressed send, a missing template) — treat that
    // exactly like a thrown error: bell + report not-ok so the sweep
    // retries, rather than only catching the throw case.
    if (!invoiceDelivery || invoiceDelivery.ok === false) {
      const NotificationService = require('./notification-service');
      await ringActivationBell(NotificationService, {
        estimateId, contractId, kind: 'delivery_failed', reason: invoiceDelivery?.error || 'delivery reported not ok',
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
        estimateId, contractId, kind: 'delivery_failed', reason: deliveryErr.message,
      });
    } catch (bellErr) {
      logger.error(`[termite-annual-activation] delivery-failure bell failed for estimate ${estimateId}: ${bellErr.message}`);
    }
    return { ok: false, invoiceDelivery };
  }
}

/**
 * Runs the deferred annual-prepay term + invoice for a just-signed termite
 * annual agreement. Call this AFTER the sign transaction has committed.
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
      if (!estimateId) return { skipped: 'no_source_estimate' };

      const estimate = await trx('estimates').where({ id: estimateId }).forUpdate().first();
      if (!estimate) return { skipped: 'estimate_not_found' };
      // Idempotent: already activated (double-sign / replay / a retried
      // call), or never deferred in the first place — never re-run the
      // money side, and never overwrite a terminal 'activated' stamp.
      if (estimate.annual_plan_activation_status !== 'awaiting_signature') {
        return { skipped: estimate.annual_plan_activation_status || 'not_awaiting_signature' };
      }

      // Codex P1-2: bill EXACTLY what was deferred at accept — never
      // re-derive. A missing/malformed snapshot means the accept path
      // failed to record what it was deferring (shouldn't happen — the
      // converter fails the whole accept if it can't write this), so this
      // is an error state: bell for a human, leave 'awaiting_signature' for
      // a retry once the snapshot is fixed, never guess an amount.
      const deferredInvoiceSnapshot = validDeferredInvoiceSnapshot(estimate.annual_plan_deferred_invoice);
      if (!deferredInvoiceSnapshot) {
        // Anomaly, not a routine skip: an estimate reading
        // 'awaiting_signature' with no (or a malformed) deferred-invoice
        // snapshot means the accept path failed to record what it deferred
        // — bell for a human rather than silently doing nothing, since the
        // customer signed and expects to be billed.
        try {
          const NotificationService = require('./notification-service');
          await ringActivationBell(NotificationService, {
            estimateId, contractId, kind: 'no_deferred_snapshot', reason: 'no valid annual_plan_deferred_invoice snapshot on the estimate',
          });
        } catch (bellErr) {
          logger.error(`[termite-annual-activation] bell setup failed for contract ${contractId}: ${bellErr.message}`);
        }
        return { skipped: 'no_deferred_snapshot' };
      }
      const annualAmount = Number(deferredInvoiceSnapshot.amountCents) / 100;

      // Codex P1-3: take the SAME ledger lock the converter takes before
      // reading the deposit balance — without it, a concurrent deposit
      // refund/consumption (e.g. the accept-time flow retrying, or a manual
      // deposit adjustment) could read a balance that changes underneath
      // this invoice mint. Any failure here (lock or read) propagates to
      // the outer catch below — never swallowed — so it bells and leaves
      // the estimate 'awaiting_signature' rather than silently minting the
      // invoice with a stale or zero deposit credit.
      const { acquireEstimateDepositLedgerLock, pendingDepositCredit, consumeDepositCredit } = require('./estimate-deposits');
      const InvoiceService = require('./invoice');
      await acquireEstimateDepositLedgerLock(trx, estimateId);
      const depositCredit = await pendingDepositCredit(estimateId, trx);
      const requestedDepositCredit = depositCredit ? Number(depositCredit.amount) || 0 : 0;
      const invoice = await InvoiceService.create({
        database: trx,
        customerId: estimate.customer_id,
        title: deferredInvoiceSnapshot.title || 'Subterranean Termite Protection — Annual Fee',
        lineItems: deferredInvoiceSnapshot.lines,
        notes: deferredInvoiceSnapshot.notes
          || `Auto-generated on signature of the termite annual agreement (contract #${contractId}, estimate #${estimateId}). Charge was deferred at acceptance until this signature (sign-before-pay).`,
        ...(deferredInvoiceSnapshot.taxRate != null ? { taxRate: deferredInvoiceSnapshot.taxRate } : {}),
        ...(requestedDepositCredit > 0
          ? { depositCredit: { amount: requestedDepositCredit, estimateId } }
          : {}),
      });
      const appliedDepositCredit = Number(invoice?.applied_deposit_credit) || 0;
      if (invoice?.id && appliedDepositCredit > 0) {
        await consumeDepositCredit({
          estimateId, amount: appliedDepositCredit, invoiceId: invoice.id, trx,
        });
      }
      if (!invoice?.id) throw new Error('Annual-fee invoice was not created');

      const AnnualPrepayRenewals = require('./annual-prepay-renewals');
      // GROSS coverage-slicing basis, matching the converter's own prepay
      // accounting: the annual fee alone (amountCents already excludes the
      // setup-fee line — see the converter's deferredInvoiceSnapshot
      // comment), pre-deposit-credit, so renewals split the same figure the
      // customer actually agreed to regardless of any deposit applied here.
      const prepayAmount = annualAmount;
      const term = await AnnualPrepayRenewals.createTermForAnnualPrepay({
        customerId: estimate.customer_id,
        sourceEstimateId: estimateId,
        prepayInvoiceId: invoice.id,
        planLabel: 'Termite Annual Protection',
        monthlyRate: deferredInvoiceSnapshot.monthlyRate != null
          ? Number(deferredInvoiceSnapshot.monthlyRate)
          : Math.round((annualAmount / 12) * 100) / 100,
        prepayAmount,
        coverageServiceType: COVERAGE_SERVICE_TYPE,
        coverageVisitCount: COVERAGE_VISIT_COUNT,
        coverageCadence: COVERAGE_CADENCE,
        conn: trx,
      });
      if (!term?.id) throw new Error('Annual prepay term was not created');

      // Ruling A-13: the signed v3 annual agreement IS the auto-charge
      // consent — stamp it on the term the moment that signature commits.
      await trx('annual_prepay_terms').where({ id: term.id }).update({
        annual_plan_version: contract.annual_plan_version || DEFAULT_ANNUAL_PLAN_VERSION,
        renewal_charge_consent_at: contract.signed_at || new Date(),
      });

      await trx('estimates').where({ id: estimateId }).update({
        annual_plan_activation_status: 'activated',
        annual_plan_activated_at: new Date(),
      });

      return { activated: true, termId: term.id, invoiceId: invoice.id };
    });

    // Codex P1-A: mirror exactly what the ordinary (non-deferred)
    // prepay_annual accept does right after minting its invoice — deliver
    // the pay link via the SAME wrapper (InvoiceService.sendViaSMSAndEmail)
    // and the SAME gate (canAutoSendDraftInvoice), with the SAME
    // payUrlParams shape (estimate-converter.js, step 4). Run AFTER the
    // activation transaction above has committed (safer than the
    // converter's own inline placement, which can run inside a caller's
    // still-open transaction) — a delivery failure never undoes the money
    // side; it only means the customer hears about the charge some other
    // way (the admin bell below, or a manual follow-up). sendViaSMSAndEmail
    // claims the invoice before sending (see invoice.js), so calling this
    // twice on an already-delivered invoice is itself idempotent — but the
    // outer 'already activated' guard means this code only ever runs once
    // per estimate anyway.
    if (result?.activated) {
      // Codex P1 (last round): a delivery failure here used to be silent
      // and unretried. deliverAnnualInvoiceOrBell rings its own deduped
      // bell on failure and reports ok:false — the reconciliation sweep's
      // second pass (below) finds this exact case (an 'activated' estimate
      // whose invoice never got sent_at) and retries it, so nothing is lost
      // even though this attempt doesn't persist a "delivery failed" flag
      // anywhere (estimates.annual_plan_* is frozen; invoices.sent_at IS
      // NULL already IS that flag).
      const { invoiceDelivery } = await deliverAnnualInvoiceOrBell({
        estimateId, contractId, invoiceId: result.invoiceId, termId: result.termId,
      });
      result.invoiceDelivery = invoiceDelivery;
    }

    if (result?.skipped) return result;
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

// Codex P1-B (prior round) + codex P1 (this round, item 3): the minimal
// retry for a failed activation. Signing burns the contract's share token,
// so there is no "sign again" path once activateTermiteAnnualPlanForSignedContract
// bells and leaves an estimate 'awaiting_signature' — this sweep re-drives
// it for exactly that stuck case. Idempotent by construction
// (activateTermiteAnnualPlanForSignedContract itself no-ops on anything not
// 'awaiting_signature'), bounded batch, and a single row's failure never
// stops the rest — mirrors reconcileTermiteProgramAgreements' own shape
// (termite-program-agreement.js). Abandoned-signature EXPIRY (an estimate
// that never gets signed at all) stays out of scope for 3b, same as noted
// throughout this slice.
//
// Query direction (codex P1, this round): drives from SIGNED CONTRACTS
// (bounded + ordered by signed_at), not from awaiting estimates. The
// earlier shape scanned up to `limit` awaiting-signature estimates first,
// unordered — with more than `limit` awaiting estimates outstanding, an
// unlucky page could be ALL unsigned ones, starving a genuinely-signed
// estimate sitting just past the cutoff forever (every tick re-draws the
// same unlucky page). Starting from signed contracts joined to
// still-awaiting estimates, ordered oldest-signed-first, makes every row
// this query returns immediately actionable, and processes the
// longest-waiting customers first.
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

  // Codex P1 (this round, item 1): the sweep's second job — an already-
  // ACTIVATED estimate whose invoice never got delivered (a prior
  // sendViaSMSAndEmail failure, or the process dying between activation and
  // delivery). Found via the invoice's own existing links — no new column:
  // annual_prepay_terms.source_estimate_id -> the estimate,
  // annual_prepay_terms.prepay_invoice_id -> the invoice, and
  // invoices.sent_at IS NULL is the same "never delivered" signal
  // sendViaSMSAndEmail itself stamps on success (invoice.js). Only ever
  // matches a termite-annual term: source_estimate_id only points at an
  // estimate carrying annual_plan_activation_status at all for this program.
  try {
    const undelivered = await conn('estimates as e')
      .join('annual_prepay_terms as apt', conn.raw('apt.source_estimate_id = e.id'))
      .join('invoices as inv', conn.raw('inv.id = apt.prepay_invoice_id'))
      .where('e.annual_plan_activation_status', 'activated')
      // Only the ORIGINAL activation term (a renewal successor carries
      // renewed_from_term_id and owns its own invoice workflow — slice 6),
      // only a still-collectable invoice (never re-send a paid / void /
      // cancelled one), and "never delivered" on EVERY channel: sent_at is
      // the combined stamp, sms_sent_at / email_sent_at are the per-channel
      // durable stamps invoice.js also writes (pre-push P1).
      .whereNull('apt.renewed_from_term_id')
      .whereNotIn('inv.status', ['paid', 'void', 'voided', 'canceled', 'cancelled', 'refunded'])
      .whereNull('inv.sent_at')
      .whereNull('inv.sms_sent_at')
      .whereNull('inv.email_sent_at')
      .select('e.id as estimate_id', 'apt.id as term_id', 'inv.id as invoice_id')
      .limit(limit);
    counts.deliveryScanned = undelivered.length;

    for (const row of undelivered) {
      try {
        const outcome = await deliverAnnualInvoiceOrBell({
          estimateId: row.estimate_id, invoiceId: row.invoice_id, termId: row.term_id,
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
