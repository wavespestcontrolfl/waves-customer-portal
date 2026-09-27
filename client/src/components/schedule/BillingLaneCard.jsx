import { siblingCoverageCopy } from '../../lib/siblingInvoiceCoverage';

// Billing-lane card for the appointment detail sheet: shows HOW this
// customer pays and exactly what completing this visit will do to their
// wallet — BEFORE the visit runs, so a phantom invoice (or a silently free
// visit) is visible on the schedule instead of discovered in the customer's
// inbox. Server-computed (services/billing-lane.js rides the same predicates
// the completion path uses); this component only renders the payload.
//
// Same visual family as EstimateProvenanceCard: neutral card, amber
// operational heads-up (never the admin alert red).

const NEUTRAL = { bg: '#F8FAFC', border: '#E2E8F0', ink: '#0F172A' };
const WARN = { bg: '#FFFBEB', border: '#FDE68A', ink: '#92400E' };
// Genuine alert red (billing hold = service is paused; running the visit
// anyway is a real mistake) — distinct from the amber operational notes.
const HOLD = { bg: '#FEF2F2', border: '#FECACA', ink: '#B91C1C' };
const GREEN = '#166534';
const MUTED = '#64748B';

const LANE_LABEL = {
  monthly_membership: 'Monthly membership',
  per_visit: 'Pays per visit',
  per_application: 'Per application',
  annual_prepay: 'Annual prepay',
  one_time: 'One-time customer',
};

function money(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '$0.00';
  return `$${v.toFixed(2)}`;
}

function predictionLine(prediction, siblingCoverage) {
  if (!prediction) return null;
  switch (prediction.kind) {
    case 'covered_membership':
      return { color: GREEN, text: 'On completion: no invoice — covered by membership dues.' };
    case 'covered_annual':
      return { color: GREEN, text: 'On completion: no invoice — covered by the annual prepay plan.' };
    case 'prepaid':
      return { color: GREEN, text: `On completion: no new charge — ${money(prediction.amount)} already paid for this visit.` };
    case 'payer':
      return { color: MUTED, text: 'On completion: invoices the third-party billing party — do not collect from the customer.' };
    case 'auto_charge':
      return { color: NEUTRAL.ink, text: `On completion: auto-charges the saved payment method ${money(prediction.amount)}.` };
    case 'invoice':
      return { color: NEUTRAL.ink, text: `On completion: sends the customer a ${money(prediction.amount)} invoice.` };
    case 'covered_sibling_invoice': {
      const sibling = prediction.siblingServiceType ? ` on the ${prediction.siblingServiceType} visit` : '';
      const invoiceRef = prediction.invoiceNumber ? ` invoice ${prediction.invoiceNumber}` : ' an invoice';
      // The server's own siblingCoverage verdict (billing-lane.js
      // siblingCoverageForSchedule) decides settled vs. collectible —
      // "no charge" either way let a technician walk off a job whose
      // combined-trip invoice was still outstanding. siblingCoverageCopy is
      // pure copy formatting of that verdict, never its own classifier.
      const coverage = siblingCoverageCopy(siblingCoverage, { siblingServiceType: prediction.siblingServiceType });
      if (coverage?.collectible) {
        const due = coverage.amountDue != null ? ` ${money(coverage.amountDue)}` : '';
        return {
          color: WARN.ink,
          text: `On completion: no NEW invoice for this visit —${invoiceRef} already covers it${sibling} (same trip), but${due} is still due on that invoice. Collect there, not here.`,
        };
      }
      return { color: GREEN, text: `On completion: no charge —${invoiceRef} already covers this${sibling} (same trip).` };
    }
    // Codex round 5 P2: the same-trip sibling invoice this visit would
    // otherwise defer to is refunded/terminal (or the lookup itself
    // failed) — resolveScheduledServiceCharge refuses to charge this visit
    // either way, so this must read as "go resolve it," never as a $ amount
    // due or a false "covered."
    case 'sibling_needs_review':
      return { color: WARN.ink, text: 'On completion: this visit’s combined-trip invoice needs review before charging — resolve it on Customer 360.' };
    case 'no_charge':
      return { color: MUTED, text: 'On completion: nothing bills for this visit.' };
    default:
      return null;
  }
}

// "Includes X $Y (same trip)" lines for a combined first-application
// invoice — either the RESERVED row explaining what its own invoice total
// is made of, or the sibling-covered row's OWN line (already named in the
// prediction text above, so its own entry is skipped there). See
// billing-lane.js sameTripFirstApplicationBreakdown.
function breakdownLines(prediction) {
  if (!Array.isArray(prediction?.breakdown)) return [];
  return prediction.breakdown
    .filter((item) => item && item.amount != null && item.serviceType)
    .map((item) => `${item.serviceType} ${money(item.amount)}`);
}

export default function BillingLaneCard({ billingLane, style, onSendCardLink, sendingCardLink }) {
  if (!billingLane || !billingLane.mode) return null;
  const laneLabel = LANE_LABEL[billingLane.mode] || billingLane.mode;
  const rate = Number(billingLane.monthlyRate);
  const isMember = billingLane.mode === 'monthly_membership';
  const showRate = isMember && Number.isFinite(rate) && rate > 0;
  const line = predictionLine(billingLane.prediction, billingLane.siblingCoverage);
  const conflict = !!billingLane.prediction?.conflictStampedPrice;
  const breakdown = breakdownLines(billingLane.prediction);
  // Present-tense money state: dues status for members, open balance for
  // everyone. duesPaidThisMonth null = unknown (older payloads) — show
  // nothing rather than guessing.
  const duesLine = isMember && billingLane.duesPaidThisMonth === true
    ? { color: GREEN, text: "This month's dues: collected." }
    : isMember && billingLane.duesPaidThisMonth === false
      ? { color: MUTED, text: "This month's dues: not collected yet." }
      : null;
  const autopayOff = isMember && billingLane.autopayActive === false;
  const balance = Number(billingLane.openBalance);
  const invoiceCount = Number(billingLane.openInvoiceCount);
  const showBalance = Number.isFinite(balance) && balance > 0 && invoiceCount > 0;

  const onHold = !!billingLane.servicePausedAt;
  // Money gap — this visit bills nothing and nothing about it says it
  // should. Amber, not alert red: the owner ruled 2026-08-31 that this
  // warns and never blocks completion, so it must not read as a stop sign
  // (the BILLING HOLD block above is the only genuine stop here).
  const gap = billingLane.unbilledGap;

  return (
    <div style={style}>
      <div style={{ background: NEUTRAL.bg, border: `1px solid ${NEUTRAL.border}`, borderRadius: 4, padding: '10px 12px' }}>
        {onHold && (
          <div
            role="alert"
            style={{
              marginBottom: 8,
              background: HOLD.bg,
              border: `1px solid ${HOLD.border}`,
              borderRadius: 4,
              padding: '8px 10px',
              fontSize: 13,
              fontWeight: 500,
              color: HOLD.ink,
            }}
          >
            BILLING HOLD — service is paused after failed dues collection. Resolve billing before running this visit.
          </div>
        )}
        {gap && (
          <div
            role="note"
            style={{
              marginBottom: 8,
              background: WARN.bg,
              border: `1px solid ${WARN.border}`,
              borderRadius: 4,
              padding: '8px 10px',
              color: WARN.ink,
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 500 }}>
              Nothing will bill for this visit.
            </div>
            <div style={{ fontSize: 12, marginTop: 2 }}>
              {gap.reason === 'no_invoice_will_mint'
                ? (gap.noPaymentMethod === true
                  ? 'This visit is priced, but no invoice will be created on completion — and there is no card on file.'
                  : 'This visit is priced, but no invoice will be created on completion.')
                : gap.noPaymentMethod === true
                  ? 'No rate or price is set, and there is no card on file.'
                  : 'No rate or price is set on this account.'}
            </div>
            {onSendCardLink && gap.noPaymentMethod === true && (
              <button
                type="button"
                onClick={onSendCardLink}
                disabled={sendingCardLink}
                style={{
                  marginTop: 8,
                  width: '100%',
                  padding: '9px 12px',
                  fontSize: 13,
                  fontWeight: 500,
                  color: WARN.ink,
                  background: '#FFFFFF',
                  border: `1px solid ${WARN.border}`,
                  borderRadius: 4,
                  opacity: sendingCardLink ? 0.6 : 1,
                }}
              >
                {sendingCardLink ? 'Sending...' : 'Text card / Auto Pay link'}
              </button>
            )}
          </div>
        )}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 500, letterSpacing: '0.06em', textTransform: 'uppercase', color: MUTED, whiteSpace: 'nowrap' }}>
            Billing
          </span>
          <span style={{ fontSize: 13, fontWeight: 500, color: NEUTRAL.ink }}>
            {laneLabel}
            {showRate && (
              <span style={{ fontWeight: 400, color: MUTED }}> · {money(rate)}/mo dues</span>
            )}
          </span>
          {billingLane.source === 'inferred' && (
            <span style={{ fontSize: 11, color: MUTED }}>(inferred — set it on the customer profile)</span>
          )}
        </div>
        {/* The gap note already says "nothing will bill", and says it with the
            reason — the muted prediction line under it would repeat the same
            sentence in weaker words. */}
        {line && !gap && (
          <div style={{ fontSize: 13, color: line.color, marginTop: 6 }}>
            {line.text}
          </div>
        )}
        {/* Only the RESERVED row's own line needs this spelled out — the
            sibling-covered row's line above already names the other
            service and says "same trip". */}
        {breakdown.length > 0 && billingLane.prediction?.kind !== 'covered_sibling_invoice' && (
          <div style={{ fontSize: 14, color: MUTED, marginTop: 4 }}>
            Includes {breakdown.join(' + ')} (same trip).
          </div>
        )}
        {duesLine && (
          <div style={{ fontSize: 13, color: duesLine.color, marginTop: 4 }}>
            {duesLine.text}
          </div>
        )}
        {showBalance && (
          <div style={{ fontSize: 13, color: billingLane.hasOverdue ? WARN.ink : MUTED, marginTop: 4 }}>
            Open balance: {money(balance)} across {invoiceCount} unpaid invoice{invoiceCount === 1 ? '' : 's'}
            {billingLane.hasOverdue ? ' — includes overdue' : ''}.
          </div>
        )}
        {autopayOff && (
          <div
            role="note"
            style={{
              marginTop: 8,
              background: WARN.bg,
              border: `1px solid ${WARN.border}`,
              borderRadius: 4,
              padding: '8px 10px',
              fontSize: 12,
              color: WARN.ink,
            }}
          >
            Membership autopay is not active — dues cannot collect, so visits will bill instead of being covered.
          </div>
        )}
        {conflict && (
          <div
            role="note"
            style={{
              marginTop: 8,
              background: WARN.bg,
              border: `1px solid ${WARN.border}`,
              borderRadius: 4,
              padding: '8px 10px',
              fontSize: 12,
              color: WARN.ink,
            }}
          >
            This visit carries a stamped per-visit price, but membership dues cover it — the stamp will be ignored, not billed.
          </div>
        )}
      </div>
    </div>
  );
}
