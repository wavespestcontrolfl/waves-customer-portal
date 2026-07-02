import {
  Badge,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  cn,
} from "../../../components/ui";
import { CHART_SUCCESS } from "../../../components/dashboard/charts";

export default function BillingHealthPanel({ summary: h, embedded = false }) {
  const billable = h.total_billable || 0;
  const autopayActive = h.autopay_active || 0; // enabled minus paused
  const paused = h.autopay_paused || 0;
  const enabled = autopayActive + paused; // all autopay-enabled accounts
  // Autopay-off accounts (billed manually). The backend reports this directly;
  // fall back to billable − enabled (every billable row is enabled or disabled).
  const manual = h.autopay_disabled != null ? h.autopay_disabled : Math.max(billable - enabled, 0);
  const autopayPct = billable > 0 ? Math.round((enabled / billable) * 100) : 0;
  const seg = (n) => (billable > 0 ? (n / billable) * 100 : 0);

  // Every state that means an account WON'T be billed cleanly — not just charge
  // failures. `no_payment_method` is autopay-enabled-with-no-card (so autopay
  // silently can't run) and `paused` autopay is skipped by the billing cron;
  // both belong in the verdict, not hidden. Verdict is healthy only when all clear.
  const attention = [
    { label: "No card", value: h.no_payment_method || 0 },
    { label: "Paused", value: paused },
    { label: "Failed", value: h.failed_last_30_days || 0 },
    { label: "In retry", value: h.in_retry_queue || 0 },
    { label: "Escalated", value: h.escalated_last_30_days || 0 },
    // 60-day window (incl. already-expired) — labelled so it isn't read as a 30d event.
    { label: "Cards expiring (60d)", value: h.expiring_cards_60_days || 0 },
  ];
  const healthy = attention.every((a) => a.value === 0);

  // Autopay-enabled vs manual — sums to the billable base, no inference. (We do
  // NOT split out "has a saved method" because the backend only reports the
  // no-card count within autopay-enabled accounts, so it can't be derived here.)
  const coverage = [
    { label: "Autopay", value: enabled, color: CHART_SUCCESS, suffix: ` (${autopayPct}%)` },
    { label: "Manual", value: manual, color: "#D4D4D8" },
  ];

  // Status-first verdict — green only when every won't-bill state is clear.
  const verdict = (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium whitespace-nowrap",
        !healthy && "text-alert-fg bg-alert-bg",
      )}
      style={healthy ? { color: CHART_SUCCESS, background: "rgba(16,185,129,0.10)" } : undefined}
    >
      {healthy ? "✓ Healthy" : "⚠ Needs attention"}
    </span>
  );

  const body = (
    <>
      {/* Autopay coverage — enabled vs manual; sums to the billable base. */}
      <div className="u-label text-ink-tertiary mb-2">Autopay coverage</div>
      <div className="flex h-2.5 rounded-sm overflow-hidden bg-surface-sunken mb-2">
        {coverage.map((r) => (
          <div
            key={r.label}
            style={{ width: `${seg(r.value)}%`, background: r.color }}
            title={`${r.label}: ${r.value}`}
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-12">
        {coverage.map((r) => (
          <span key={r.label} className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: r.color }} />
            <span className="text-ink-secondary">{r.label}</span>
            <span className="u-nums font-medium">{r.value}</span>
            {r.suffix && <span className="u-nums text-ink-tertiary">{r.suffix}</span>}
          </span>
        ))}
      </div>

      {/* Won't-bill / needs-attention — chips, green-✓ when clear, alert when not */}
      <div className="mt-4 pt-3 border-t border-hairline border-zinc-100">
        <div className="flex items-center justify-between gap-2 mb-2">
          <span className="u-label text-ink-tertiary">Won't bill / needs attention</span>
          <span className="u-nums text-12 text-ink-tertiary whitespace-nowrap">
            {h.charged_this_month || 0} charged this month
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          {attention.map((a) => {
            const bad = a.value > 0;
            return (
              <span
                key={a.label}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 text-12",
                  bad
                    ? "text-alert-fg bg-alert-bg border-alert-fg/30"
                    : "text-ink-secondary bg-surface-sunken border-zinc-200",
                )}
              >
                {!bad && <span style={{ color: CHART_SUCCESS }}>✓</span>}
                <span>{a.label}</span>
                <span className="u-nums font-medium">{a.value}</span>
              </span>
            );
          })}
        </div>
      </div>
    </>
  );

  // Embedded inside a MobileFold that already shows the "Billing Health" title +
  // billable count — render just the verdict + body (no duplicate Card/header/badge).
  if (embedded) {
    return (
      <div>
        <div className="mb-3">{verdict}</div>
        {body}
      </div>
    );
  }

  return (
    <Card className="mb-5 max-md:border-0 max-md:shadow-sm max-md:rounded-xl">
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <CardTitle>Billing Health</CardTitle>
          {verdict}
        </div>
        <Badge>{billable} billable</Badge>
      </CardHeader>
      <CardBody>{body}</CardBody>
    </Card>
  );
}
