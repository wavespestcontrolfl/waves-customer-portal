/**
 * Completion full-balance Auto Pay sweep (owner ruling 2026-08-08: after a
 * visit's auto-charge, "take everything they owe").
 *
 * Runs ONLY after the completion rail's own auto-charge on the visit's
 * invoice SETTLED to 'paid' — the freshest possible proof the method is live
 * and Auto Pay is active. An ACH debit still 'processing' is money merely in
 * flight, NOT proof (pre-push r2 P0): it can still fail, and fanning out
 * further debits behind it would stack unauthorized attempts stop-on-failure
 * can't see — so ACH-tender completions never trigger the sweep (their old
 * invoices stay on the ordinary dunning rails; a webhook-triggered
 * post-settlement sweep is a possible follow-up, deliberately out of scope).
 * It then collects the
 * customer's OTHER open, already-DELIVERED self-pay invoices (open-balance.js
 * selection: sent/viewed/overdue, payer-free, statement-free, positive
 * remainder), oldest first, one chargeInvoiceWithSavedCard call per invoice.
 *
 * Per-invoice charges by design — never one inflated PaymentIntent:
 *   - every existing rail applies unchanged per invoice (durable charge
 *     claim, single surcharge authority, credit interplay, ledger row,
 *     receipt delivery), so the customer gets an itemized receipt for each
 *     invoice actually collected;
 *   - the cap passed per charge is that invoice's OWN current pre-tax
 *     subtotal net of discounts — re-enforced by the charge service against
 *     the LOCKED row, so an edit racing the sweep refuses instead of
 *     collecting an amount nobody saw;
 *   - requireAutopayForCustomerId re-verifies, under the customer row lock
 *     and per charge, that Auto Pay is still active and the supplied method
 *     is still the active default (a pause/opt-out mid-sweep stops it);
 *   - requireSelfPayScheduledServiceId re-verifies self-pay under lock for
 *     invoices that carry a visit (payer assigned mid-sweep → refuse).
 *
 * STOP-ON-FAILURE: any failure ends the sweep. A decline will decline again
 * on the next invoice; an ambiguous/orphaned outcome means money state is
 * unclear and nothing further may move; a guard refusal means account state
 * changed under us. Un-swept invoices keep their pay links and their own
 * dunning clocks exactly as today (oldest-invoice escalation — ruling #2).
 *
 * Invoices whose follow-up sequence an admin explicitly STOPPED are skipped:
 * "stop dunning" (customer mailing a check, disputed bill) must also mean
 * "don't silently collect it off-session" — same signal previsit-balance
 * honors. The preflight here is only a cheap skip; the binding check runs
 * INSIDE the charge transaction (refuseWhenDunningStopped: FOR UPDATE on the
 * sequence row, serialized with the stop writer — pre-push P0), so a stop
 * committing mid-sweep refuses instead of colliding.
 *
 * Durability model — deliberately an OPPORTUNISTIC ACCELERATOR, not a
 * durable job: the sweep is detached (completion latency must not carry N
 * Stripe round-trips) and a crash/deploy between completion and sweep loses
 * nothing durable, because collection of these invoices never depended on
 * it — each stays open on its own pay link and its own dunning/late-payment
 * ladder exactly as today, and the customer's NEXT completion auto-charge
 * re-runs the sweep over whatever is still open. A durable replay queue
 * would also be the wrong shape for money movement here: a deferred replay
 * would charge off a stale eligibility snapshot, while re-running from a
 * fresh completion re-verifies everything live.
 *
 * Dark behind GATE_COMPLETION_BALANCE_SWEEP (fail-closed in every
 * environment); every outcome lands in autopay_log under
 * source 'completion_balance_sweep'.
 */

const db = require('../models/db');
const logger = require('./logger');
const { isEnabled } = require('../config/feature-gates');
const { openBalanceInvoices } = require('./open-balance');
const { invoiceAmountDue } = require('./invoice-helpers');
const { logAutopay } = require('./autopay-log');

const SWEEP_SOURCE = 'completion_balance_sweep';

// Invoices an admin told the dunning engines to leave alone.
async function dunningStoppedInvoiceIds(invoiceIds, { database = db } = {}) {
  if (!invoiceIds.length) return new Set();
  const rows = await database('invoice_followup_sequences')
    .whereIn('invoice_id', invoiceIds)
    .where({ status: 'stopped' })
    .select('invoice_id');
  return new Set(rows.map((r) => String(r.invoice_id)));
}

/**
 * Charge the customer's other open invoices with the SAME saved method the
 * completion charge just succeeded on. Serial + oldest first; stops on the
 * first failure. Never throws — the completion response must not depend on
 * the sweep, and every outcome is logged.
 *
 * @param {string} customerId
 * @param {string} excludeInvoiceId — the visit's own invoice (just collected)
 * @param {string} paymentMethodId — payment_methods.id the completion charge used
 * @returns {{ charged: number, failed: number, skipped: number, considered: number }}
 */
async function runCompletionBalanceSweep({ customerId, excludeInvoiceId, paymentMethodId, triggerScheduledServiceId = null }) {
  const summary = { charged: 0, failed: 0, skipped: 0, considered: 0 };
  if (!isEnabled('completionBalanceSweep')) return { ...summary, gateOff: true };
  if (!customerId || !paymentMethodId) return summary;

  let candidates = [];
  try {
    candidates = await openBalanceInvoices(customerId, { excludeInvoiceId });
    summary.considered = candidates.length;
    if (!candidates.length) return summary;
    const stopped = await dunningStoppedInvoiceIds(candidates.map((inv) => inv.id));
    if (stopped.size) {
      summary.skipped += candidates.filter((inv) => stopped.has(String(inv.id))).length;
      candidates = candidates.filter((inv) => !stopped.has(String(inv.id)));
    }
  } catch (err) {
    logger.error(`[balance-sweep] candidate lookup failed for customer ${customerId}: ${err.message}`);
    return summary;
  }

  const StripeService = require('./stripe');
  for (const inv of candidates) {
    // This invoice's own current amount is the ceiling — the same pre-tax
    // subtotal-net-of-discount comparator the completion rail caps with,
    // re-checked by the charge service against the LOCKED row so a
    // concurrent upward edit refuses instead of charging.
    const subtotalCents = Math.round(Number(inv.subtotal != null ? inv.subtotal : inv.total || 0) * 100);
    const discountCents = Math.max(0, Math.round(Number(inv.discount_amount || 0) * 100));
    const maxAuthorizedSubtotal = Math.max(0, subtotalCents - discountCents) / 100;
    try {
      await StripeService.chargeInvoiceWithSavedCard(inv.id, paymentMethodId, {
        maxAuthorizedSubtotal,
        // Full charge-base ceiling in cents (pre-push r2 P0): the subtotal
        // cap can't see tax/total retotals or a reversed credit — the locked
        // amount due must not exceed this snapshot's.
        maxAuthorizedChargeCents: Math.round(invoiceAmountDue(inv) * 100),
        requireAutopayForCustomerId: customerId,
        requireSelfPayScheduledServiceId: inv.scheduled_service_id || null,
        // Binding default-payer check for ad-hoc invoices with no visit —
        // the visit-keyed guard has nothing to key on there (pre-push r2 P0).
        requireSelfPayCustomerId: customerId,
        // Binding stopped-dunning check under the charge locks — the
        // preflight above is only a cheap skip (pre-push P0).
        refuseWhenDunningStopped: true,
      });
      summary.charged += 1;
      try {
        await logAutopay(customerId, 'charge_success', {
          details: {
            source: SWEEP_SOURCE,
            invoice_id: inv.id,
            invoice_number: inv.invoice_number,
            trigger_scheduled_service_id: triggerScheduledServiceId,
          },
        });
      } catch (e) { /* log-only */ }
    } catch (err) {
      summary.failed += 1;
      const fenced = StripeService.savedCardChargeSuppressesAlternateCollection(err);
      logger.warn(`[balance-sweep] charge ${fenced ? 'fenced' : 'failed'} for invoice ${inv.invoice_number} (customer ${customerId}) — sweep stopped: ${err.message}`);
      try {
        await logAutopay(customerId, 'charge_failed', {
          details: {
            source: SWEEP_SOURCE,
            invoice_id: inv.id,
            invoice_number: inv.invoice_number,
            trigger_scheduled_service_id: triggerScheduledServiceId,
            collection_fenced: fenced,
            reconciliation_required: !!StripeService.savedCardChargeNeedsReconciliation(err),
            error: String(err.message || '').slice(0, 300),
          },
        });
      } catch (e) { /* log-only */ }
      break; // stop-on-failure: remaining invoices keep pay links + dunning
    }
  }
  logger.info(`[balance-sweep] customer ${customerId}: ${summary.charged} charged, ${summary.failed} failed, ${summary.skipped} skipped of ${summary.considered} open`);
  return summary;
}

module.exports = { runCompletionBalanceSweep, dunningStoppedInvoiceIds, SWEEP_SOURCE };
