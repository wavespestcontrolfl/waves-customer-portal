import { Badge, Card, CardBody, CardHeader, CardTitle, UiSurface, cn } from "../../../components/ui";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { RowLink } from "./RowLink";
import { fmtMoneyCompact } from "../../../components/dashboard/charts";

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
// alerts === null means the fetch never succeeded — render an explicit
// unavailable state; claiming "all clear" on a failed load would hide any
// critical alarms behind a green checkmark. `stale` means the LATEST fetch
// failed and `alerts` is a kept-previous value: a non-empty list still shows
// (labeled stale — old items beat no items), but an empty one must not read
// as a confirmed all-clear.
export default function ActionInbox({ alerts, stale = false }) {
  const loaded = Array.isArray(alerts);
  const items = loaded ? [...alerts].sort((a, b) => rank(a) - rank(b)) : [];
  const criticalCount = items.filter((a) => a.severity === "critical").length;
  const allClear = loaded && !stale && items.length === 0;

  if (!loaded || (stale && items.length === 0)) {
    return (
      <UiSurface as={Card} className="mb-4">
        <CardHeader className="flex items-center gap-2.5">
          <CardTitle>Action inbox</CardTitle>
          <Badge tone="neutral">unavailable</Badge>
        </CardHeader>
        <CardBody>
          <div className="py-2 text-ui-body text-ink-secondary">
            {loaded
              ? "Alerts couldn't be refreshed — refresh to retry."
              : "Alerts couldn't be loaded — refresh to retry."}
          </div>
        </CardBody>
      </UiSurface>
    );
  }

  return (
    <UiSurface as={Card} className="mb-4">
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <CardTitle>Action inbox</CardTitle>
          {allClear ? (
            <Badge tone="neutral">
              <CheckCircle2 size={14} aria-hidden />
              All clear
            </Badge>
          ) : (
            <span
              className={cn(
                "text-ui-caption",
                criticalCount > 0 ? "text-alert-fg" : "text-ink-secondary",
              )}
            >
              {criticalCount > 0
                ? `${criticalCount} critical`
                : `${items.length} open`}
              {stale ? " · refresh failed, showing last loaded" : ""}
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
          <div className="py-2 text-ui-body text-ink-secondary">
            Nothing needs you right now.
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {items.map((item) => (
              <RowLink
                key={item.id}
                href={item.href}
                className="flex min-h-11 items-center justify-between gap-3 rounded-sm border-hairline border-zinc-200 bg-surface-sunken px-3 py-2 text-ui-body text-zinc-900 hover:bg-white u-focus-ring"
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
                    <span className="u-nums text-ui-caption text-ink-secondary">
                      {fmtMoneyCompact(item.amount)}
                    </span>
                  )}
                  <ArrowRight size={16} aria-hidden className="text-ink-tertiary" />
                </span>
              </RowLink>
            ))}
          </div>
        )}
      </CardBody>
    </UiSurface>
  );
}
