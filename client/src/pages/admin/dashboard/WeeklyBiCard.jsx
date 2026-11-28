import { useState } from "react";
import { UiSurface } from "../../../components/ui";
import { EmptyState } from "../../../components/dashboard/charts";

// Weekly Monday BI Briefing summary card — surfaces the latest report stored in
// weekly_bi_reports (/api/admin/dashboard-ops/bi/reports?limit=1).
function formatReportDate(report) {
  if (report?.week_of) return `Week of ${String(report.week_of).slice(0, 10)}`;
  if (!report?.created_at) return "Latest briefing";
  return new Date(report.created_at).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "America/New_York",
  });
}

function parseActionLines(raw) {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
  return String(raw)
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

export default function WeeklyBiCard({ data }) {
  const [expanded, setExpanded] = useState(false);
  const report = Array.isArray(data?.reports) ? data.reports[0] : null;
  if (!report) return <EmptyState>No weekly BI briefing generated yet</EmptyState>;

  const actions = parseActionLines(report.action_items);
  const anomalies = String(report.anomalies_section || "").trim();

  return (
    <UiSurface>
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <span className="text-ui-caption font-medium text-ink-secondary">{formatReportDate(report)}</span>
        {(actions.length > 0 || anomalies) && (
          <button
            type="button"
            onClick={() => setExpanded((prev) => !prev)}
            className="text-ui-caption font-medium text-ink-secondary hover:text-ink-primary underline-offset-2 hover:underline"
          >
            {expanded ? "Hide action items" : `View ${actions.length || 1} action item${actions.length === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
      <p className="text-ui-body text-ink-primary leading-relaxed whitespace-pre-line">
        {String(report.summary || "Summary unavailable.").trim()}
      </p>
      {expanded && (
        <div className="mt-3 pt-3 border-t border-hairline border-zinc-200 space-y-2.5">
          {actions.length > 0 && (
            <div>
              <div className="text-ui-caption font-medium text-ink-secondary mb-1">Recommended actions</div>
              <ul className="list-disc pl-5 space-y-1 text-ui-caption text-ink-primary">
                {actions.map((item, idx) => (
                  <li key={`${idx}-${item.slice(0, 24)}`}>{item}</li>
                ))}
              </ul>
            </div>
          )}
          {anomalies && (
            <div>
              <div className="text-ui-caption font-medium text-ink-secondary mb-1">Anomalies noted</div>
              <p className="text-ui-caption text-ink-secondary whitespace-pre-line">{anomalies}</p>
            </div>
          )}
        </div>
      )}
    </UiSurface>
  );
}
