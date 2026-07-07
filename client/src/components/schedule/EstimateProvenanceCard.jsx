// Shared "From Estimate" provenance card. Renders the blue quoted-vs-current
// reference (originally inline in MobileAppointmentDetailSheet) plus the
// customer's exact payment posture for an accepted estimate — annual prepay
// (paid / pending, to the cent), the pay-per-application setup-fee invoice,
// and the deposit — so the New Appointment modal and the appointment detail
// sheet show the same thing and nobody has to re-open the estimate.
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
//   payment      object  — buildEstimatePaymentContext() payload from the server:
//                          { billingTerm, paymentPreference, annualPrepay,
//                            acceptanceInvoice }. Amounts are the persisted
//                          invoice/term figures (exact), never recomputed.
//   lines        array   — scheduleLinesFromEstimate() rows from the server
//                          ({ name, estimateLabel, cadence, ... }) — the
//                          service mix the customer accepted, shown as
//                          "Lawn Care · Monthly" / "Pest Control · Quarterly"
//                          so nobody re-opens the estimate to answer "what
//                          did they sign up for". Optional; omitted → hidden.
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
  prepay_annual: 'not required — annual prepay',
  existing_plan_customer: 'existing plan customer',
  payer_billed: 'billed to third party',
};

// Cadence keys as produced by the server's cadenceFromEstimateLine().
// Unknown keys fall back to the raw value with underscores humanized rather
// than hiding the row — the service name is still worth showing.
const CADENCE_LABEL = {
  monthly: 'Monthly',
  bimonthly: 'Every other month',
  quarterly: 'Quarterly',
  triannual: '3x per year',
  semiannual: 'Twice a year',
  annual: 'Annual',
  one_time: 'One-time',
};

function cadenceLabel(cadence, intervalDays) {
  if (!cadence) return '';
  // The scheduler represents every-6-weeks as custom/42 — show the human
  // cadence, not "custom".
  if (cadence === 'custom' && Number(intervalDays) === 42) return 'Every 6 weeks';
  if (cadence === 'custom' && Number(intervalDays) > 0) return `Every ${Number(intervalDays)} days`;
  return CADENCE_LABEL[cadence] || String(cadence).replace(/_/g, ' ');
}

function money(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

// Calendar-date label for date-only values (term boundaries). Formats off the
// YYYY-MM-DD prefix at UTC noon so a timestamptz stored at UTC midnight can't
// slip a day when rendered in ET.
function fmtDate(value) {
  if (!value) return '';
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(
    value instanceof Date ? value.toISOString() : String(value),
  );
  if (!match) return '';
  return new Date(`${match[1]}T12:00:00Z`).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
}

// Payment timestamps (invoice paid_at) are full UTC instants — format them in
// ET so an evening payment after midnight UTC doesn't display as the next
// calendar day. Bare YYYY-MM-DD values take the date-only path instead (a
// UTC-parsed midnight would slip a day the OTHER way).
function fmtPaidDate(value) {
  if (!value) return '';
  const str = value instanceof Date ? value.toISOString() : String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return fmtDate(str);
  const d = new Date(str);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'America/New_York',
  });
}

// Unpaid-invoice wording keyed off the invoice's real status — a draft prepay
// left for the office to send (manual-acceptance path sets autoSendInvoice
// false) must not claim "Invoice sent". Unknown statuses make no delivery
// claim at all.
function invoicePendingNote(status) {
  const s = String(status || '').toLowerCase();
  if (['draft', 'scheduled', 'sending'].includes(s)) return 'Invoice drafted — not sent to the customer yet';
  if (s === 'processing') return 'Payment processing — not settled yet';
  if (s === 'sent' || s === 'overdue') return 'Invoice sent, payment not received yet';
  return 'Payment not received yet';
}

// Payment-posture rows: what the customer actually paid (or still owes) at
// acceptance, from persisted invoice/term figures. Same row shape as
// depositRow so all money facts render in one list.
function paymentRows(payment) {
  if (!payment) return [];
  const rows = [];
  const ap = payment.annualPrepay;

  if (ap) {
    const amount = money(ap.prepayAmount != null ? ap.prepayAmount : ap.invoiceTotal);
    const status = String(ap.status || '').toLowerCase();
    // "visit 2 of 4 Quarterly Pest Control · 2 left" when this appointment is
    // one of the covered visits; "1 of 4 used · 3 left" when it isn't linked
    // (coverage gap) but the term still has usage; plain "covers 4 visits"
    // when no visits are linked at all.
    const svc = ap.coverageServiceType ? ` ${ap.coverageServiceType}` : '';
    let usage = '';
    if (ap.visitNumber && ap.totalVisits) {
      usage = ` · visit ${ap.visitNumber} of ${ap.totalVisits}${svc}`;
    } else if (ap.totalVisits) {
      usage = ` · ${ap.visitsUsed || 0} of ${ap.totalVisits}${svc} used`;
    } else if (ap.coverageVisitCount > 0) {
      usage = ` · covers ${ap.coverageVisitCount}${svc} visit${ap.coverageVisitCount === 1 ? '' : 's'}`;
    }
    const left = ap.totalVisits && ap.visitsRemaining != null
      ? ` · ${ap.visitsRemaining} left`
      : '';
    const through = ap.termEnd ? ` through ${fmtDate(ap.termEnd)}` : '';
    if (ap.paid) {
      const paidOn = fmtPaidDate(ap.invoicePaidAt);
      // "Do not collect" only when the visit-level billing gate confirms THIS
      // visit is covered (coversThisVisit true). false = the prepay is real
      // but this visit isn't covered (detached/unstamped/service mismatch) and
      // completion billing WILL bill it — say so instead of contradicting the
      // invoice. null = no visit context (pre-booking); make no claim.
      const collect = ap.coversThisVisit === true
        ? ' — do not collect at the visit'
        : ap.coversThisVisit === false
          ? ' — not applied to this visit; it bills normally'
          : '';
      rows.push({
        label: 'Annual prepay — paid',
        value: amount,
        sub: `Paid${paidOn ? ` ${paidOn}` : ''}${usage}${left}${through}${collect}`,
        tone: 'paid',
      });
    } else if (ap.refunded || ['cancelled', 'canceled', 'refunded'].includes(status)) {
      // ap.refunded covers the drift case: invoice still looks paid but the
      // payment was fully refunded (term status may not have flipped yet).
      rows.push({
        label: 'Annual prepay',
        value: amount,
        sub: `${ap.refunded ? 'refunded' : status} — bill normally`,
        tone: 'muted',
      });
    } else {
      rows.push({
        label: 'Annual prepay — pending',
        value: amount,
        sub: `${invoicePendingNote(ap.invoiceStatus)}${usage}${left}${through}`,
        tone: 'muted',
      });
    }
    return rows;
  }

  if (payment.billingTerm === 'prepay_annual') {
    // Prepay was chosen at acceptance but no term row exists (older accept or
    // manual billing) — say what's known rather than inventing an amount.
    rows.push({
      label: 'Annual prepay',
      value: '—',
      sub: 'selected at acceptance — no prepay record on file',
      tone: 'muted',
    });
    return rows;
  }

  if (payment.billingTerm === 'standard') {
    rows.push({ label: 'Billing', value: 'Per application', sub: null, tone: 'muted' });
    const inv = payment.acceptanceInvoice;
    if (inv) {
      const paidSub = inv.paid
        ? `Paid${fmtPaidDate(inv.paidAt) ? ` ${fmtPaidDate(inv.paidAt)}` : ''}`
        : invoicePendingNote(inv.status);
      const paidTone = inv.paid ? 'paid' : 'muted';
      if (inv.setupFeeAmount != null) {
        rows.push({ label: 'WaveGuard setup fee', value: money(inv.setupFeeAmount), sub: paidSub, tone: paidTone });
      }
      if (inv.firstApplicationAmount != null) {
        rows.push({ label: 'First application', value: money(inv.firstApplicationAmount), sub: paidSub, tone: paidTone });
      }
      // A manually built acceptance invoice may carry neither recognizable
      // line — still show the exact invoiced total rather than nothing.
      if (inv.setupFeeAmount == null && inv.firstApplicationAmount == null && inv.total != null) {
        rows.push({ label: inv.title || 'Acceptance invoice', value: money(inv.total), sub: paidSub, tone: paidTone });
      }
    }
  }
  return rows;
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

export default function EstimateProvenanceCard({ quotedTotal, currentPrice, deposit, payment, lines, style }) {
  const quoted = Number(quotedTotal) || 0;
  const price = currentPrice != null ? Number(currentPrice) : null;
  // Accepted service mix — prefer the estimate's own wording (estimateLabel)
  // over the catalog-matched name so the card reads like the quote did.
  const serviceLines = (Array.isArray(lines) ? lines : [])
    .map((line) => ({
      name: String(line?.estimateLabel || line?.name || '').trim(),
      cadence: cadenceLabel(line?.cadence, line?.intervalDays),
    }))
    .filter((line) => line.name);
  const rows = paymentRows(payment);
  const dep = depositRow(deposit);
  if (dep) rows.push(dep);
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

        {serviceLines.length > 0 && (
          <div style={{ marginTop: 8, borderTop: `1px solid ${BLUE.border}`, paddingTop: 4 }}>
            {serviceLines.map((line, i) => (
              <div key={`${line.name}-${i}`} style={lineStyle}>
                <div style={{ fontSize: 13, fontWeight: 500, color: INK, minWidth: 0 }}>{line.name}</div>
                {line.cadence && (
                  <div style={{ fontSize: 12, fontWeight: 600, color: BLUE.ink, whiteSpace: 'nowrap' }}>
                    {line.cadence}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {rows.length > 0 && (
          <div style={{ marginTop: 8, borderTop: `1px solid ${BLUE.border}`, paddingTop: 4 }}>
            {rows.map((row, i) => (
              <div key={`${row.label}-${i}`} style={lineStyle}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: row.tone === 'paid' ? GREEN : INK }}>{row.label}</div>
                  {row.sub && <div style={{ fontSize: 11, color: row.tone === 'paid' ? GREEN : MUTED, marginTop: 1 }}>{row.sub}</div>}
                </div>
                <div style={{ fontSize: 13, fontWeight: 600, color: row.tone === 'paid' ? GREEN : INK, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
                  {row.value}
                </div>
              </div>
            ))}
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
