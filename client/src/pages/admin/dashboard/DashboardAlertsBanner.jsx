import { Badge, Card, CardBody, cn } from "../../../components/ui";
import { fmtMoneyCompact } from "../../../components/dashboard/charts";

// Operational Alerts banner — server-computed alerts (/admin/dashboard/alerts),
// top 4 shown. Superseded by the Action Inbox in a later phase.
export default function DashboardAlertsBanner({ alerts }) {
  const visible = alerts.slice(0, 4);
  const criticalCount = alerts.filter((a) => a.severity === "critical").length;
  return (
    <Card className="mb-4 max-md:border-0 max-md:shadow-sm max-md:rounded-xl">
      <CardBody className="p-4">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="u-label text-ink-secondary">
              Operational Alerts
            </div>
            <div className="mt-1 text-13 text-zinc-900">
              {criticalCount > 0
                ? `${criticalCount} critical alert${criticalCount === 1 ? "" : "s"}`
                : `${alerts.length} active alert${alerts.length === 1 ? "" : "s"}`}
            </div>
          </div>
          <Badge tone={criticalCount > 0 ? "alert" : "neutral"}>
            {alerts.length}
          </Badge>
        </div>
        <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-2">
          {visible.map((alert) => (
            <a
              key={alert.id}
              href={alert.href || "#"}
              className="flex items-center justify-between gap-3 rounded-sm border-hairline border-zinc-200 bg-surface-sunken px-3 py-2 text-13 text-zinc-900 hover:bg-white"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span
                  className={cn(
                    "h-2 w-2 rounded-full flex-shrink-0",
                    alert.severity === "critical"
                      ? "bg-alert-fg"
                      : "bg-amber-500",
                  )}
                />
                <span className="truncate">{alert.label}</span>
              </span>
              {alert.amount != null && (
                <span className="u-nums text-12 text-ink-secondary flex-shrink-0">
                  {fmtMoneyCompact(alert.amount)}
                </span>
              )}
            </a>
          ))}
        </div>
      </CardBody>
    </Card>
  );
}
