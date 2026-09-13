import { Badge, cn } from "../../../components/ui";
import { confidenceTier } from "./scorecard-metrics";

// Visible small-sample pill — the warning itself, never a tooltip. Renders
// nothing at a confident sample (n ≥ MIN_CONFIDENT_N); below that it says
// "Low sample · n=N" in amber, and "No data yet" in zinc when there's nothing.
export default function SampleBadge({ n, className }) {
  const { tier, label } = confidenceTier(n);
  if (tier === "ok") return null;
  return (
    <Badge
      className={cn("whitespace-nowrap shrink-0", className)}
      tone={tier === "low" ? "warn" : "neutral"}
    >
      {label}
    </Badge>
  );
}
