// Shared "From Estimate" provenance card. Renders the blue quoted-vs-current
// reference (originally inline in MobileAppointmentDetailSheet) plus the
// deposit posture for an accepted estimate, so the New Appointment modal and
// the appointment detail sheet show the same thing.
//
// Deliberately styled with plain inline styles (no Tailwind classes, no `D`
// palette import) so it drops cleanly into both the Tier-1 (Tailwind) detail
// sheet and the Tier-2 (inline/`D`) CreateAppointmentModal without mixing
// either file's style system.
//
// Props:
//   quotedTotal  number  — estimate's quoted total (monthly + annual + one-time)
//   currentPrice number  — this visit's current price, used only for the
//                          "current price vs quoted" note; null hides that note.
//                          Pass null when lines span multiple cadences (no single
//                          per-visit charge). Deliberately NOT used to compute a
//                          per-visit "charge less deposit" figure: a deposit
//                          credits the estimate's first invoice (not any one
//                          visit, and never a payer-billed one), so the credit is
//                          shown as an estimate-level note on the deposit row.
//   deposit      object  — summarizeEstimateDeposit() payload from the server:
//                          { enforced, oneTime, policyAmount, required,
//                            exemptReason, paid, creditRemaining, payerBilled }
//   style        object  — optional outer wrapper style (margins, etc.)

const BLUE = { bg: '#F0F9FF', border: '#BAE6FD', ink: '#0369A1' };
// Amber caution used for the "billed to a third party — don't collect from the
// customer" banner. Deliberately NOT the admin alert red: this is an
// operational heads-up, not a system error.
const WARN = { bg: '#FFFBEB', border: '#FDE68A', ink: '#92400E' };
const MUTED = '#64748B';
const INK = '#0F172A';
const GREEN = '#166534';

const EXEMPT_LABEL = {
  prepay_annual: 'paid annually at acceptance',
  existing_plan_customer: 'existing plan customer',
  payer_billed: 'billed to third party',
};

function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

// Resolve the single deposit row: label, value, and a small sub-note. Returns
// null when there's nothing meaningful to show.
//
// Paid deposits are always surfaced (the ledger is authoritative). The
// would-be / per-policy projection and any exemption label are shown ONLY when
// deposits are actually enforced (ESTIMATE_DEPOSIT_REQUIRED on). While the flag
// is dark the projection can't be resolved reliably — existing-plan exemptions
// and customer-chosen one-time amounts aren't recoverable post-accept — so we
// deliberately show nothing rather than a figure that could send an operator
// chasing money that isn't owed.
function depositRow(deposit) {
  if (!deposit) return null;
  const paid = Number(deposit.paid) || 0;
  const creditRemaining = Number(deposit.creditRemaining) || 0;
  const policyAmount = Number(deposit.policyAmount) || 0;
  const exempt = deposit.exemptReason && deposit.exemptReason !== 'feature_disabled';

  if (paid > 0) {
    // A homeowner deposit credits the FIRST invoice for the estimate — never a
    // specific visit and never a payer-billed invoice (the invoice path skips
    // deposit credit when a third party is billed). So we state the credit as an
    // estimate-level fact rather than deducting it from any one visit's charge.
    if (deposit.exemptReason === 'payer_billed') {
      return {
        label: 'Deposit paid',
        value: money(paid),
        sub: 'Already paid — not applied here (third party is billed)',
        tone: 'paid',
      };
    }
    return {
      label: 'Deposit paid',
      value: money(paid),
      sub: creditRemaining > 0
        ? `Already paid — ${money(creditRemaining)} comes off the first invoice`
        : 'Already paid — comes off the first invoice',
      tone: 'paid',
    };
  }
  // Dark flag: only ledger-backed deposits are trustworthy — suppress the rest.
  if (!deposit.enforced) return null;
  if (exempt) {
    return {
      label: 'Deposit',
      value: 'None',
      sub: EXEMPT_LABEL[deposit.exemptReason] || 'not required',
      tone: 'muted',
    };
  }
  if (policyAmount > 0) {
    const klass = deposit.oneTime ? 'one-time job' : 'recurring plan';
    return {
      label: 'Deposit due',
      value: money(policyAmount),
      sub: klass,
      tone: 'muted',
    };
  }
  return null;
}

export default function EstimateProvenanceCard({ quotedTotal, currentPrice, deposit, style }) {
  const quoted = Number(quotedTotal) || 0;
  const price = currentPrice != null ? Number(currentPrice) : null;
  const dep = depositRow(deposit);
  // Whole-visit third-party billing: surfaced as its own prominent banner so a
  // tech scanning on a phone can't miss it and ask the homeowner for money.
  // Backed by summary.payerBilled (always resolved, gate-independent); fall back
  // to the deposit exemptReason for older payloads.
  const payerBilled = !!(deposit && (deposit.payerBilled || deposit.exemptReason === 'payer_billed'));
  const showVsQuoted = price != null && quoted > 0 && price > 0 && Math.abs(quoted - price) > 0.01;
  const deltaPct = showVsQuoted ? Math.round(((price - quoted) / quoted) * 100) : 0;

  const lineStyle = {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 10,
    padding: '6px 0',
  };

  return (
    <div style={style}>
      <div style={{ background: BLUE.bg, border: `1px solid ${BLUE.border}`, borderRadius: 4, padding: '10px 12px' }}>
        {/* Header: FROM ESTIMATE · Quoted $X */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 11, fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase', color: BLUE.ink }}>
            From Estimate
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 12, fontWeight: 600, color: BLUE.ink, fontVariantNumeric: 'tabular-nums' }}>
            Quoted {money(quoted)}
          </span>
        </div>

        {payerBilled && (
          <div
            role="alert"
            style={{
              marginTop: 8,
              background: WARN.bg,
              border: `1px solid ${WARN.border}`,
              borderRadius: 4,
              padding: '8px 10px',
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
            }}
          >
            <span aria-hidden style={{ fontSize: 14, lineHeight: '18px' }}>⚠</span>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: WARN.ink }}>
                Billed to a third party
              </div>
              <div style={{ fontSize: 12, color: WARN.ink, marginTop: 1 }}>
                Do not collect payment from the customer — this visit invoices to the billing party on file.
              </div>
            </div>
          </div>
        )}

        {dep && (
          <div style={{ marginTop: 8, borderTop: `1px solid ${BLUE.border}`, paddingTop: 4 }}>
            <div style={lineStyle}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 500, color: INK }}>{dep.label}</div>
                {dep.sub && <div style={{ fontSize: 11, color: MUTED, marginTop: 1 }}>{dep.sub}</div>}
              </div>
              <div style={{ fontSize: 13, fontWeight: 600, color: dep.tone === 'paid' ? GREEN : INK, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                {dep.value}
              </div>
            </div>
          </div>
        )}
      </div>

      {showVsQuoted && (
        <div style={{ fontSize: 11, color: MUTED, marginTop: 4, paddingLeft: 2 }}>
          Current price {money(price)} ({deltaPct > 0 ? '+' : ''}{deltaPct}% vs quoted)
        </div>
      )}
    </div>
  );
}
