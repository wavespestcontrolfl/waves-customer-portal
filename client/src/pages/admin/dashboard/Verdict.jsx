import { cn } from "../../../components/ui";

// Traffic-light dots reuse the documented Customers-surface triage palette —
// the dashboard's color exception (same constants as charts.jsx CAP_TONE_COLOR).
const TONE_DOT = {
  good: "#10B981",
  warn: "#F59E0B",
  bad: "#C8312F",
  neutral: "#9CA3AF",
};

// The card-footer answer to "What happened?" and "What should I do?" — every
// major dashboard card renders one. `verdict` comes from a pure builder in
// scorecard-metrics.js ({ happened, action, tone, caveat? }); null hides the
// block entirely (the card's own empty state covers the nothing-to-judge case).
export default function Verdict({ verdict, className }) {
  if (!verdict) return null;
  return (
    <div className={cn("mt-3 pt-3 border-t border-hairline border-zinc-200", className)}>
      <div className="flex items-start gap-2">
        <span
          className="w-2 h-2 rounded-full mt-1 shrink-0"
          style={{ background: TONE_DOT[verdict.tone] || TONE_DOT.neutral }}
          aria-hidden="true"
        />
        <div className="min-w-0 text-12 leading-snug">
          <p className="text-ink-secondary">{verdict.happened}</p>
          <p className="mt-1 text-zinc-900 font-medium">Do next: {verdict.action}</p>
          {verdict.caveat && <p className="mt-1 text-ink-tertiary">{verdict.caveat}</p>}
        </div>
      </div>
    </div>
  );
}
