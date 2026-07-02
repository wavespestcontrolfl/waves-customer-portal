import { Badge, Card, CardBody, CardHeader, CardTitle, cn } from "../../../components/ui";
import { CHART_SUCCESS, fmtMoneyCompact } from "../../../components/dashboard/charts";

// Rank: what to do first. Critical before warn; within a severity, do-this-now
// actions before watch-state alarms (kind comes from the server generators).
const SEVERITY_RANK = { critical: 0, warn: 1 };
const KIND_RANK = { action: 0, alert: 1 };
function rank(a) {
  return (
    (SEVERITY_RANK[a.severity] ?? 2) * 10 + (KIND_RANK[a.kind] ?? 1)
  );
}

// The TODAY section's ranked "do this now" list — server-computed operational
// alerts + action items (/admin/dashboard/alerts), deep-linked to the surface
// where each one gets fixed. Replaces the old top-4 alerts banner: every item
// shows, ordered by urgency, and a clean day says so instead of hiding.
export default function ActionInbox({ alerts }) {
  const items = [...(alerts || [])].sort((a, b) => rank(a) - rank(b));
  const criticalCount = items.filter((a) => a.severity === "critical").length;
  const allClear = items.length === 0;

  return (
    <Card className="mb-4 max-md:border-0 max-md:shadow-sm max-md:rounded-xl">
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <CardTitle>Action Inbox</CardTitle>
          {allClear ? (
            <span
              className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-11 font-medium whitespace-nowrap"
              style={{ color: CHART_SUCCESS, background: "rgba(16,185,129,0.10)" }}
            >
              ✓ All clear
            </span>
          ) : (
            <span
              className={cn(
                "text-12",
                criticalCount > 0 ? "text-alert-fg" : "text-ink-secondary",
              )}
            >
              {criticalCount > 0
                ? `${criticalCount} critical`
                : `${items.length} open`}
            </span>
          )}
        </div>
        {!allClear && (
          <Badge tone={criticalCount > 0 ? "alert" : "neutral"}>
            {items.length}
          </Badge>
        )}
      </CardHeader>
      <CardBody>
        {allClear ? (
          <div className="text-13 text-ink-secondary py-2">
            Nothing needs you right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {items.map((item) => (
              <a
                key={item.id}
                href={item.href || "#"}
                className="flex items-center justify-between gap-3 rounded-sm border-hairline border-zinc-200 bg-surface-sunken px-3 py-2 text-13 text-zinc-900 hover:bg-white"
              >
                <span className="flex items-center gap-2 min-w-0">
                  <span
                    className={cn(
                      "h-2 w-2 rounded-full flex-shrink-0",
                      item.severity === "critical"
                        ? "bg-alert-fg"
                        : "bg-amber-500",
                    )}
                  />
                  <span className="truncate">{item.label}</span>
                </span>
                <span className="flex items-center gap-2 flex-shrink-0">
                  {item.amount != null && (
                    <span className="u-nums text-12 text-ink-secondary">
                      {fmtMoneyCompact(item.amount)}
                    </span>
                  )}
                  <span aria-hidden="true" className="text-ink-tertiary">
                    →
                  </span>
                </span>
              </a>
            ))}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
