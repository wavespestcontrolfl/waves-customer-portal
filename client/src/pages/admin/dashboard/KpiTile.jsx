import { cn } from "../../../components/ui";
import {
  EmptyState,
  KpiBullet,
  KpiDivergingBar,
  KpiRing,
  Sparkline,
} from "../../../components/dashboard/charts";
import { kpiTargetTone, resolveTargetDef } from "./kpi-targets";

// Below this sample size a rate is noise, not signal — fade the tile and say
// so. Mirrors capital-allocation's MIN_CONFIDENT_CUSTOMERS small-N fade.
const MIN_CONFIDENT_N = 5;

export function pct(n) {
  return n == null ? "—" : `${n}%`;
}

// Signed display for net-momentum tiles: explicit + on gains, a true minus
// glyph on losses, bare 0 at flat. Magnitude is formatted by `fmt`.
export function signed(n, fmt) {
  if (n == null) return "—";
  const v = Number(n);
  if (v === 0) return fmt(0);
  return `${v > 0 ? "+" : "−"}${fmt(Math.abs(v))}`;
}

export function KpiGrid({ children, className = "grid grid-cols-2 md:grid-cols-4 gap-3" }) {
  return <div className={className}>{children}</div>;
}

// Shared loading/error/empty shell for the per-section KPI strips. Callers must
// short-circuit tile JSX on `kpis &&` themselves — children are evaluated
// eagerly, so this component can't guard property access for them.
export function KpiStrip({ loading, error, ready, gridClassName, children }) {
  if (loading) return <EmptyState>Loading KPIs…</EmptyState>;
  if (error) return <EmptyState>Failed to load KPIs for this period</EmptyState>;
  if (!ready) return <EmptyState>No KPI data for this period</EmptyState>;
  return <KpiGrid className={gridClassName}>{children}</KpiGrid>;
}

// `metricKey` opts a tile into the target store + sparkline history:
// targets/history are the metric-keyed maps DashboardPageV2 fetches in wave3
// (falling back to DEFAULT_KPI_TARGETS / no sparkline while unfetched). The
// resolved target drives red/amber/green; a caller-passed `alert` only
// applies when no target resolves. `metricValue` supplies the numeric for
// target evaluation when the tile has no usable `chart.value` (no chart, or
// a diverging chart that only carries positive/negative parts) — without it
// an owner-set target for those metrics would silently do nothing. `n` fades
// a small-sample rate (< 5) and says so, mirroring the capital-allocation
// small-N treatment.
export function KpiTile({ label, value, sub, alert, chart, metricKey, metricValue, targets, history, n }) {
  const targetDef = resolveTargetDef(metricKey, targets);
  const lowConfidence = n != null && Number.isFinite(Number(n)) && Number(n) < MIN_CONFIDENT_N;
  // A small-sample rate never paints red/amber/green — noise isn't a verdict
  // (the old Collection Rate tile's issuedCount >= 5 alert guard, generalized).
  const toneValue = metricValue !== undefined ? metricValue : chart?.value;
  const tone = lowConfidence ? null : kpiTargetTone(toneValue, targetDef);
  const alertResolved = tone ? tone === "bad" : !lowConfidence && !!alert;
  const warn = tone === "warn";
  const series = metricKey ? history?.[metricKey] : null;
  const subText = lowConfidence ? (
    <>
      {sub}
      {sub ? " · " : ""}n={n} — low sample
    </>
  ) : sub;
  // The store's target/direction override the JSX chart's (the JSX values are
  // only the pre-store fallbacks, kept in DEFAULT_KPI_TARGETS). While the
  // sample is too small for a verdict, the target is withheld from the chart
  // too — otherwise KpiRing/KpiBullet would recompute a green "meets target"
  // from 1-4 favorable samples right next to the "low sample" note.
  const chartTarget = lowConfidence
    ? null
    : targetDef?.target != null ? Number(targetDef.target) : chart?.target;
  const chartLower = targetDef ? !!targetDef.lowerIsBetter : chart?.lowerIsBetter;

  // Gauge tiles let the ring BE the value (number in the center), with the
  // sub beside it — no duplicate big number.
  if (chart?.kind === "gauge") {
    return (
      <div className={cn("bg-surface-sunken border-hairline border-zinc-200 rounded-sm p-3", lowConfidence && "opacity-70")}>
        <div className="u-label text-ink-secondary">{label}</div>
        <div className="flex items-center gap-3 mt-2">
          <KpiRing
            value={chart.value}
            max={chart.max}
            target={chartTarget}
            lowerIsBetter={chartLower}
            alert={alertResolved}
            warn={warn}
            display={value}
          />
          {subText && <div className="text-11 text-ink-secondary min-w-0">{subText}</div>}
        </div>
        {series && (
          <div className="mt-2">
            <Sparkline series={series} />
          </div>
        )}
      </div>
    );
  }
  // Bullet / diverging tiles keep the big number, with the bar beneath.
  return (
    <div className={cn("bg-surface-sunken border-hairline border-zinc-200 rounded-sm p-3", lowConfidence && "opacity-70")}>
      <div className="u-label text-ink-secondary">{label}</div>
      {/* Diverging/no-chart tiles have no ring or bar to carry the tone, so
          the number itself shows the full red/amber/green verdict (red stays
          alert-only; untargeted tiles keep the neutral zinc). */}
      <div
        className={cn(
          "u-nums text-22 font-medium tracking-tight mt-2 leading-none",
          alertResolved
            ? "text-alert-fg"
            : warn
              ? "text-amber-600"
              : tone === "good"
                ? "text-emerald-600"
                : "text-zinc-900",
        )}
      >
        {value}
      </div>
      {subText && <div className="mt-1 text-11 text-ink-secondary">{subText}</div>}
      {chart?.kind === "bullet" && (
        <div className="mt-2">
          <KpiBullet
            value={chart.value}
            target={chartTarget}
            max={chart.max}
            lowerIsBetter={chartLower}
            alert={alertResolved}
            warn={warn}
          />
        </div>
      )}
      {chart?.kind === "diverging" && (
        <div className="mt-2">
          <KpiDivergingBar positive={chart.positive} negative={chart.negative} />
        </div>
      )}
      {series && (
        <div className="mt-2">
          <Sparkline series={series} />
        </div>
      )}
    </div>
  );
}
