import { cn } from "../../../components/ui";
import { confidenceTier } from "./scorecard-metrics";

// Visible small-sample pill — the warning itself, never a tooltip. Renders
// nothing at a confident sample (n ≥ MIN_CONFIDENT_N); below that it says
// "Low sample · n=N" in amber, and "No data yet" in zinc when there's nothing.
export default function SampleBadge({ n, className }) {
  const { tier, label } = confidenceTier(n);
  if (tier === "ok") return null;
  return (
    <span
      className={cn(
        "inline-block text-11 px-1.5 py-0.5 rounded-sm border whitespace-nowrap align-middle",
        tier === "low"
          ? "text-amber-700 border-amber-300 bg-amber-50"
          : "text-ink-tertiary border-zinc-200 bg-surface-sunken",
        className,
      )}
    >
      {label}
    </span>
  );
}
