import { Badge, Card, CardBody, CardHeader, CardTitle } from "../../../components/ui";

// TODAY-section exception card: past-dated visits still sitting in an open
// status (pending/confirmed/en_route/on_site) — the backlog the day-scoped
// Action Inbox alerts never see. Fed by /admin/command-center/stale-visits;
// each row deep-links to the dispatch Day view for its scheduled date so the
// operator lands on the day that still shows the visit as open. Hides itself
// entirely when the backlog is empty (or the feed hasn't loaded) — an
// all-clear needs no card, matching the dashboard's exception surfaces.
export default function StaleVisitsCard({ data }) {
  const visits = Array.isArray(data?.visits) ? data.visits : [];
  if (!visits.length) return null;
  const total = Number(data?.total || visits.length);

  return (
    <Card className="mb-4 max-md:border-0 max-md:shadow-sm max-md:rounded-xl">
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <CardTitle>Stale Visits</CardTitle>
          <span className="text-12 text-ink-secondary">
            past their date, still open
          </span>
        </div>
        <Badge tone="neutral">{total}</Badge>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {visits.map((item) => (
            <a
              key={item.id}
              href={item.href || "#"}
              className="flex items-center justify-between gap-3 rounded-sm border-hairline border-zinc-200 bg-surface-sunken px-3 py-2 text-13 text-zinc-900 hover:bg-white"
            >
              <span className="flex items-center gap-2 min-w-0">
                <span className="h-2 w-2 rounded-full flex-shrink-0 bg-amber-500" />
                <span className="truncate">
                  {item.customer?.name || "Unknown customer"} ·{" "}
                  {item.metadata?.serviceType || "Scheduled service"}
                </span>
              </span>
              <span className="flex items-center gap-2 flex-shrink-0 text-12 text-ink-secondary">
                <span className="u-nums">{item.metadata?.scheduledDate}</span>
                <span>
                  {String(item.metadata?.status || "").replace("_", " ")} ·{" "}
                  {item.metadata?.daysOverdue}d overdue
                </span>
                <span aria-hidden="true" className="text-ink-tertiary">
                  →
                </span>
              </span>
            </a>
          ))}
        </div>
        {total > visits.length && (
          <div className="text-12 text-ink-tertiary mt-2">
            Showing the oldest {visits.length} of {total}.
          </div>
        )}
      </CardBody>
    </Card>
  );
}
