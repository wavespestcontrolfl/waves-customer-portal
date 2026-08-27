/**
 * Completion charge verdict — the completion route's charge-lane admission and
 * hard-cap resolution as side-effect-free functions.
 *
 * Moved VERBATIM out of routes/admin-dispatch.js (the /:serviceId/complete
 * handler) so the route and the card-expiry exemption evaluate the SAME rules:
 *   - resolveAppointmentCardLane: the appointment-card one-time lane
 *     (GATE_APPT_CARD_COMPLETION_CHARGE) — consent row, hold exclusion, frozen
 *     accepted_amount cap;
 *   - resolveExtendedLane: the extended Auto Pay lane
 *     (GATE_COMPLETION_AUTOPAY_CHARGE) — admission, hold exclusion, PRE-CREDIT
 *     anchor and over-cap;
 *   - resolveCompletionChargeCap: the above-quote hard cap — accepted per-visit
 *     amount, setup-fee allowance provenance, cap ceiling.
 *
 * Everything here is READ-ONLY (no writes, no Stripe, no notifications). The
 * route keeps every side effect: review alerts, the account-credit apply, and
 * the charge itself — whose in-transaction guards re-assert all of this under
 * locks (stripe.js chargeInvoiceWithSavedCard, customer-credit.js).
 */
const db = require('../models/db');
const logger = require('./logger');
const { completionInvoiceAmount } = require('./billing-lane');
const { isAlwaysFreeServiceType } = require('./no-cost-visit-types');

async function resolveAppointmentCardLane({
  svc, invoice, alreadyPaid, visitPerformed, perApplicationBilling, annualPrepayBilling, explicitMembershipLane,
}) {
  let apptCardOneTimeCharge = false;
  let apptCardAcceptedAmount = null;
  let apptCardOverCap = false;
  let apptCardLaneUnresolved = false;
  // Lane + cap detection is deliberately INDEPENDENT of current Auto Pay
  // state (Codex #3153 r11 P1): a secured customer who pauses Auto Pay or
  // drops their method before completion still owns a capped lane invoice
  // — the credit fence below must see it. customerAutopayActive gates
  // ONLY the Stripe charge (the composite charge condition further down).
  if (!perApplicationBilling && !annualPrepayBilling && !explicitMembershipLane
    && svc.is_recurring !== true
    && visitPerformed && invoice?.id && !alreadyPaid && !invoice.payer_id) {
    try {
      if (require('../config/feature-gates').isEnabled('apptCardCompletionCharge')) {
        const laneRow = await db('appointment_card_requests')
          .where({ scheduled_service_id: svc.id })
          .whereIn('status', ['completed', 'satisfied'])
          .first('id', 'customer_id', 'accepted_amount');
        const holdRow = laneRow ? await db('estimate_card_holds')
          .where({ scheduled_service_id: svc.id })
          .first('id') : null;
        // The consent row must belong to the visit's CURRENT customer
        // (Codex #3153 r19 P0) — a reassigned visit never rides a prior
        // customer's consent into automatic collection.
        apptCardOneTimeCharge = !!laneRow && !holdRow
          && String(laneRow.customer_id) === String(svc.customer_id);
        // The lane's cap is the amount FROZEN at consent (Codex #3153 r1
        // P1) — appointment editors rewrite estimated_price, so the live
        // value is not what the customer accepted. NULL (pre-migration
        // row, unstamped render) → acceptedPerVisit stays null → the
        // no-accepted-amount skip below routes to office review.
        if (apptCardOneTimeCharge) {
          apptCardAcceptedAmount = laneRow.accepted_amount != null && Number(laneRow.accepted_amount) > 0
            ? Number(laneRow.accepted_amount) : null;
          const preCreditSubtotal = invoice.subtotal != null ? Number(invoice.subtotal) : Number(invoice.total || 0);
          const preCreditNet = Math.round((preCreditSubtotal - Math.max(0, Number(invoice.discount_amount) || 0)) * 100) / 100;
          apptCardOverCap = apptCardAcceptedAmount == null || preCreditNet > apptCardAcceptedAmount + 0.005;
        }
      }
    } catch (e) {
      // Lane state UNVERIFIABLE (Codex #3153 r10 P1): fail closed for
      // credit too — an over-cap lane invoice we couldn't detect must
      // not consume credit or flip prepaid past a never-evaluated cap.
      // The charge lane already fails toward the pay link.
      apptCardLaneUnresolved = true;
      logger.warn(`[dispatch] appointment-card completion-lane check failed for visit ${svc.id} — no auto-charge, credit auto-apply suppressed: ${e.message}`);
    }
  }
  return { apptCardOneTimeCharge, apptCardAcceptedAmount, apptCardOverCap, apptCardLaneUnresolved };
}

async function resolveExtendedLane({
  svc, invoice, alreadyPaid, visitPerformed, perApplicationBilling, apptCardOneTimeCharge, apptCardLaneUnresolved, customerAutopayActive,
}) {
  // Extended completion auto-charge lane (owner rulings 2026-08-26/27;
  // GATE_COMPLETION_AUTOPAY_CHARGE): ANY autopay customer's collectible
  // self-pay completion invoice auto-charges — not just per-application
  // and the appointment-card lane. Lane + PRE-CREDIT anchor derived HERE,
  // before the account-credit apply (pre-push P1: an over-cap or
  // anchor-less invoice routes to office review, and review must see the
  // bill exactly as minted — credit must not be consumed for it, nor may
  // it flip the invoice prepaid past a never-evaluated cap). Anchor = the
  // SAME resolution the completion mint prices from (the visit's stamped
  // accepted price, else the membership dues rate via the shared
  // completionInvoiceAmount precedence — owner cap ruling: those ARE the
  // agreed price). The charge block below consumes these values and the
  // charge service re-asserts the anchor under its own locks.
  const extendedAutopayCharge = !perApplicationBilling && !apptCardOneTimeCharge
    && require('../config/feature-gates').gates.completionAutopayCharge === true;
  // Callbacks / re-treats and always-free service types (appointment,
  // estimate, re-service, follow-up) never auto-charge (manual-audit P0):
  // shouldAutoInvoiceCompletion treats them as free, but a reused or
  // pre-minted collectible invoice with a stale estimated_price would
  // otherwise pass the anchor — the same exclusions every explicit lane
  // applies, revalidated again under the locked visit row inside
  // verifyExtendedCompletionAnchor.
  // The hold rail owns estimate-flow one-time bookings (GitHub r2 P1):
  // a live estimate_card_holds row means the customer consented to THAT
  // card at THAT amount — the extended lane must not charge the default
  // Auto Pay method beside (or instead of) it. Fail closed when the
  // lookup errors; re-checked under the money locks in the shared
  // verdict.
  let extendedHoldExcluded = false;
  if (extendedAutopayCharge) {
    try {
      extendedHoldExcluded = !!(await db('estimate_card_holds')
        .where({ scheduled_service_id: svc.id })
        .whereNotIn('status', ['released', 'cancelled', 'failed'])
        .first('id'));
    } catch (e) {
      extendedHoldExcluded = true;
      logger.warn(`[dispatch] extended-lane hold lookup failed for visit ${svc.id} — lane closed: ${e.message}`);
    }
  }
  // An UNRESOLVED appointment-card lane fails the extended lane closed
  // too (pre-push P0): apptCardOneTimeCharge=false because the lookup
  // ERRORED is not "no consent row" — charging the mutable visit price
  // could exceed a frozen accepted_amount we couldn't read. The money
  // boundary additionally excludes any consent row under the visit lock
  // (requireNoAppointmentCardLane on the charge below).
  const extendedChargeCandidate = extendedAutopayCharge && visitPerformed
    && !apptCardLaneUnresolved && !extendedHoldExcluded
    && !svc.is_callback && !isAlwaysFreeServiceType(svc.service_type)
    && !!invoice?.id && !alreadyPaid && !invoice.payer_id && customerAutopayActive;
  let extendedLaneAnchor = null;
  let extendedLaneOverCap = false;
  if (extendedChargeCandidate) {
    const duesAnchor = completionInvoiceAmount({
      estimatedPrice: null,
      isCallback: !!svc.is_callback,
      perApplicationBilling: false,
      perApplicationFee: null,
      monthlyRate: svc.cust_monthly_rate,
      billingMode: svc.cust_billing_mode,
    });
    const anchor = svc.estimated_price != null && Number(svc.estimated_price) > 0
      ? Number(svc.estimated_price)
      : (Number(duesAnchor) > 0 ? Number(duesAnchor) : null);
    extendedLaneAnchor = anchor;
    const preCreditSubtotal = invoice.subtotal != null ? Number(invoice.subtotal) : Number(invoice.total || 0);
    const preCreditNet = Math.round((preCreditSubtotal - Math.max(0, Number(invoice.discount_amount) || 0)) * 100) / 100;
    extendedLaneOverCap = extendedLaneAnchor == null || preCreditNet > extendedLaneAnchor + 0.005;
  }
  return { extendedAutopayCharge, extendedHoldExcluded, extendedChargeCandidate, extendedLaneAnchor, extendedLaneOverCap };
}

// Only meaningful once the route's composite charge condition holds (a
// collectible, self-pay, performed-visit invoice on a charging lane); the
// route calls it inside that block and acts on the verdict.
async function resolveCompletionChargeCap({
  svc, invoice, perApplicationBilling, apptCardOneTimeCharge, apptCardAcceptedAmount, extendedLaneAnchor, secureSetupFee,
}) {
  // Above-quote guardrail (card-on-file spec §3.6, owner default = HARD
  // CAP): an auto-charge may only collect what the customer accepted —
  // the per-visit amount stamped at acceptance (visit price, else the
  // per-application fee) plus its disclosed tax/surcharge. tax_amount
  // rides the invoice and the surcharge is added by the single
  // surcharge authority inside chargeInvoiceWithSavedCard, so the
  // pre-tax SUBTOTAL is the comparator. An over-quote invoice routes to
  // office review and the customer keeps the normal pay-link flow —
  // never an unauthorized amount off-session.
  // The appointment-card lane caps STRICTLY at the accepted_amount
  // FROZEN on the lane row at consent (Codex #3153 r1 P1) — never the
  // live visit price, which appointment editors rewrite. The
  // per-application acceptance-fee fallback and the setup-fee
  // allowances below are per-application concepts and never widen this
  // lane's cap.
  // Extended-lane anchor (owner cap ruling 2026-08-27: the accepted
  // membership/estimate amount or the customer's normal rate ARE the
  // agreed price) was derived PRE-CREDIT above — the visit's stamped
  // estimated_price first, else the same completionInvoiceAmount
  // resolution the mint prices membership invoices from. null → office
  // review, exactly the uncapped posture below; the charge service
  // re-asserts the anchor under its own locks
  // (requireExtendedCompletionAnchor).
  const acceptedPerVisit = apptCardOneTimeCharge
    ? apptCardAcceptedAmount
    : (svc.estimated_price != null && Number(svc.estimated_price) > 0
      ? Number(svc.estimated_price)
      : (perApplicationBilling && svc.cust_per_application_fee != null && Number(svc.cust_per_application_fee) > 0
        ? Number(svc.cust_per_application_fee) : extendedLaneAnchor));
  const invoiceSubtotal = invoice.subtotal != null ? Number(invoice.subtotal) : Number(invoice.total || 0);
  // Manual-discount accepts gross the service line up and bring it back
  // with a negative discount line — invoices.subtotal is the PRE-discount
  // gross (positive lines only), so the cap comparator is subtotal net of
  // the recorded discount. Deposit credits are prior payment, never part
  // of discount_amount, so they don't relax the cap (Codex #2680 r3).
  const invoiceDiscount = Math.max(0, Number(invoice.discount_amount) || 0);
  const netInvoiceSubtotal = Math.round((invoiceSubtotal - invoiceDiscount) * 100) / 100;
  // The setup/first-application invoice minted INSIDE the accept
  // transaction legitimately exceeds the per-visit amount (setup fee),
  // but a notes-marker EXEMPTION would survive office edits that
  // retotal the draft upward (Codex #2680 r2) — so accept-minted
  // invoices get a bounded ALLOWANCE instead of a free pass, and only
  // when the invoice actually carries the setup-fee line (a
  // first-application-only accept invoice gets NO allowance — r3);
  // everything still fails closed when no accepted amount exists.
  const acceptMintedInvoice = /Auto-generated from accepted estimate #/.test(String(invoice.notes || ''));
  // Secure plan-choice setup fee: a per-application selection on the
  // series parent legitimately adds the $99 line to the first
  // completion invoice (owner decision 2026-07-24) — same bounded
  // allowance, keyed on the DURABLE selection row (not a notes marker,
  // and not the in-request claim variable, so a resumed completion that
  // reuses an already-minted invoice still gets the allowance). Lookup
  // failure fails toward office review, like everything else here.
  let planChoiceSetupFeeSelected = false;
  if (perApplicationBilling && !acceptMintedInvoice) {
    try {
      // The selection row lives on WHICHEVER series visit the card
      // link was sent for (parent or child — Codex #2980 r2), so the
      // allowance must search the whole series, not just the parent.
      const allowanceParentId = svc.recurring_parent_id || svc.id;
      planChoiceSetupFeeSelected = !!(await db('appointment_card_requests')
        .whereIn('scheduled_service_id', db('scheduled_services').select('id').where(function series() {
          this.where({ id: allowanceParentId }).orWhere({ recurring_parent_id: allowanceParentId });
        }))
        .where({ selected_plan: 'per_application' })
        .first('id'));
    } catch (e) { /* fail toward review */ }
  }
  // The shared converter constant — the disclosure, the invoice line,
  // and this cap must move together if the fee ever changes (Codex
  // #2980). Fallback to the historical $99 only if the converter
  // module can't load (never widen the cap on a require failure).
  let WAVEGUARD_SETUP_FEE_ALLOWANCE = 99;
  try {
    const sharedFee = Number(require('./estimate-converter').WAVEGUARD_SETUP_FEE);
    if (Number.isFinite(sharedFee) && sharedFee > 0) WAVEGUARD_SETUP_FEE_ALLOWANCE = sharedFee;
  } catch (e) { /* keep the conservative literal */ }
  // The frozen quote-time fee outranks the live constant: an invoice
  // minted from a quote that froze a different amount is VALID at that
  // amount, and capping it at a since-lowered constant would misroute a
  // correct Auto Pay charge to manual review (Codex #3489). The frozen
  // resolver validates shape; require a linked source estimate.
  let wizardFrozenFeeLinked = false;
  try {
    if (svc.source_estimate_id) {
      const srcEst = await db('estimates').where({ id: svc.source_estimate_id }).first('estimate_data');
      if (srcEst) {
        const srcData = typeof srcEst.estimate_data === 'string'
          ? JSON.parse(srcEst.estimate_data)
          : (srcEst.estimate_data || {});
        const frozenObligation = Number(srcData?.acceptedSetupFeeAmount ?? srcData?.setupFeeQuote?.amount);
        if (Number.isFinite(frozenObligation) && frozenObligation > 0) {
          // Amount CAP only — never the allowance PREDICATE: every
          // seeded child keeps source_estimate_id, so estimate-derived
          // authorization would outlive the one-time obligation and let
          // a later duplicated/office-added setup line auto-charge.
          // The predicate comes solely from the ACTIVE claim below.
          WAVEGUARD_SETUP_FEE_ALLOWANCE = frozenObligation;
        }
      }
    }
  } catch (e) { /* keep the shared/live cap (fail toward review) */ }
  // SINGLE-USE wizard allowance: authorized only by the durable claim
  // THIS completion consumed (secureSetupFee — nulled when the fee did
  // not ride this invoice), at exactly its amount. The durable stamp
  // outranks the estimate JSON (a post-booking /calculate re-run
  // rewrites the draft to a zero-waiver while the visit keeps its
  // positive pending_setup_fee), and once the obligation is billed the
  // claim is retired — a later invoice with a duplicated or
  // office-added setup line earns NO wizard allowance and routes to
  // manual review (Codex #3489).
  if (secureSetupFee && Number(secureSetupFee.amount) > 0) {
    WAVEGUARD_SETUP_FEE_ALLOWANCE = Number(secureSetupFee.amount);
    wizardFrozenFeeLinked = true;
  }
  let setupFeeAllowance = 0;
  try {
    const rawLines = invoice.line_items;
    const lines = typeof rawLines === 'string' ? JSON.parse(rawLines) : (rawLines || []);
    const setupLine = (Array.isArray(lines) ? lines : []).find((li) => (
      /one-time setup fee/i.test(String(li?.description || ''))
      && Number(li?.amount ?? ((Number(li?.quantity) || 1) * (Number(li?.unit_price) || 0))) > 0
    ));
    // The secure_claim marker on the mint's own line stays PROVENANCE
    // ONLY — editable line JSON never authorizes (predicate or
    // ceiling). Crash-resume authorization comes from the IMMUTABLE
    // setup_fee_claims record the mint wrote (server-only writes),
    // matched on this invoice's id AND exact cents against the line:
    // an edited line mismatches and the charge routes to manual
    // review; a matching record restores both the predicate and the
    // ceiling at the recorded amount.
    if (!wizardFrozenFeeLinked && setupLine) {
      try {
        const claimRecord = await db('setup_fee_claims')
          .where({ invoice_id: invoice.id })
          .first('amount');
        if (claimRecord) {
          const lineCents = Math.round((Number(setupLine.amount
            ?? ((Number(setupLine.quantity) || 1) * (Number(setupLine.unit_price) || 0))) || 0) * 100);
          const recordCents = Math.round(Number(claimRecord.amount) * 100);
          if (recordCents > 0 && recordCents === lineCents) {
            wizardFrozenFeeLinked = true;
            WAVEGUARD_SETUP_FEE_ALLOWANCE = recordCents / 100;
          }
        }
      } catch (e) { /* record unreadable -> fail toward review */ }
    }
    if (perApplicationBilling
      && (acceptMintedInvoice || planChoiceSetupFeeSelected || wizardFrozenFeeLinked)
      && setupLine) {
      const lineAmt = Number(setupLine.amount ?? ((Number(setupLine.quantity) || 1) * (Number(setupLine.unit_price) || 0))) || 0;
      // Cap at the real fee: an office-inflated setup line must not
      // widen the allowance.
      setupFeeAllowance = Math.min(lineAmt, WAVEGUARD_SETUP_FEE_ALLOWANCE);
    }
  } catch (e) { /* unparseable lines -> no allowance (fail toward review) */ }
  const capCeiling = acceptedPerVisit != null
    ? acceptedPerVisit + setupFeeAllowance
    : null;
  const verdict = acceptedPerVisit == null
    ? 'no_accepted_amount'
    : (netInvoiceSubtotal > capCeiling + 0.005 ? 'above_cap' : 'ok');
  return { acceptedPerVisit, invoiceSubtotal, netInvoiceSubtotal, setupFeeAllowance, capCeiling, verdict };
}

module.exports = { resolveAppointmentCardLane, resolveExtendedLane, resolveCompletionChargeCap };
