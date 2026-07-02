import { cn } from "../../../components/ui";
import {
  EmptyState,
  KpiBullet,
  KpiDivergingBar,
  KpiRing,
} from "../../../components/dashboard/charts";

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

export function KpiTile({ label, value, sub, alert, chart }) {
  // Gauge tiles let the ring BE the value (number in the center), with the
  // sub beside it — no duplicate big number.
  if (chart?.kind === "gauge") {
    return (
      <div className="bg-surface-sunken border-hairline border-zinc-200 rounded-sm p-3">
        <div className="u-label text-ink-secondary">{label}</div>
        <div className="flex items-center gap-3 mt-2">
          <KpiRing
            value={chart.value}
            max={chart.max}
            target={chart.target}
            lowerIsBetter={chart.lowerIsBetter}
            alert={alert}
            display={value}
          />
          {sub && <div className="text-11 text-ink-secondary min-w-0">{sub}</div>}
        </div>
      </div>
    );
  }
  // Bullet / diverging tiles keep the big number, with the bar beneath.
  return (
    <div className="bg-surface-sunken border-hairline border-zinc-200 rounded-sm p-3">
      <div className="u-label text-ink-secondary">{label}</div>
      <div
        className={cn(
          "u-nums text-22 font-medium tracking-tight mt-2 leading-none",
          alert ? "text-alert-fg" : "text-zinc-900",
        )}
      >
        {value}
      </div>
      {sub && <div className="mt-1 text-11 text-ink-secondary">{sub}</div>}
      {chart?.kind === "bullet" && (
        <div className="mt-2">
          <KpiBullet
            value={chart.value}
            target={chart.target}
            max={chart.max}
            lowerIsBetter={chart.lowerIsBetter}
            alert={alert}
          />
        </div>
      )}
      {chart?.kind === "diverging" && (
        <div className="mt-2">
          <KpiDivergingBar positive={chart.positive} negative={chart.negative} />
        </div>
      )}
    </div>
  );
}
