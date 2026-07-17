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

function predictionLine(prediction) {
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
    case 'no_charge':
      return { color: MUTED, text: 'On completion: nothing bills for this visit.' };
    default:
      return null;
  }
}

export default function BillingLaneCard({ billingLane, style }) {
  if (!billingLane || !billingLane.mode) return null;
  const laneLabel = LANE_LABEL[billingLane.mode] || billingLane.mode;
  const rate = Number(billingLane.monthlyRate);
  const isMember = billingLane.mode === 'monthly_membership';
  const showRate = isMember && Number.isFinite(rate) && rate > 0;
  const line = predictionLine(billingLane.prediction);
  const conflict = !!billingLane.prediction?.conflictStampedPrice;
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

  return (
    <div style={style}>
      <div style={{ background: NEUTRAL.bg, border: `1px solid ${NEUTRAL.border}`, borderRadius: 4, padding: '10px 12px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: MUTED, whiteSpace: 'nowrap' }}>
            Billing
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, color: NEUTRAL.ink }}>
            {laneLabel}
            {showRate && (
              <span style={{ fontWeight: 400, color: MUTED }}> · {money(rate)}/mo dues</span>
            )}
          </span>
          {billingLane.source === 'inferred' && (
            <span style={{ fontSize: 11, color: MUTED }}>(inferred — set it on the customer profile)</span>
          )}
        </div>
        {line && (
          <div style={{ fontSize: 13, color: line.color, marginTop: 6 }}>
            {line.text}
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
