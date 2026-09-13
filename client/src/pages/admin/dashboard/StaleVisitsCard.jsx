import { Badge, Card, CardBody, CardHeader, CardTitle, UiSurface } from "../../../components/ui";
import { ArrowRight } from "lucide-react";
import { RowLink } from "./RowLink";

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
    <UiSurface as={Card} className="mb-4">
      <CardHeader className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <CardTitle>Stale visits</CardTitle>
          <span className="text-ui-caption text-ink-secondary">
            past their date, still open
          </span>
        </div>
        <Badge tone="neutral">{total}</Badge>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          {visits.map((item) => (
            <RowLink
              key={item.id}
              href={item.href}
              className="flex min-h-11 flex-col items-start gap-1 rounded-sm border-hairline border-zinc-200 bg-surface-sunken px-3 py-2 text-ui-body text-zinc-900 hover:bg-white u-focus-ring xl:flex-row xl:items-center xl:justify-between xl:gap-3"
            >
              <span className="flex items-center gap-2 min-w-0 w-full xl:w-auto">
                <span className="h-2 w-2 rounded-full flex-shrink-0 bg-amber-500" />
                <span className="truncate">
                  {item.customer?.name || "Unknown customer"} ·{" "}
                  {item.metadata?.serviceType || "Scheduled service"}
                </span>
              </span>
              <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-4 text-ui-caption text-ink-secondary xl:flex-shrink-0 xl:pl-0">
                <span className="u-nums whitespace-nowrap">{item.metadata?.scheduledDate}</span>
                <span>
                  {String(item.metadata?.status || "").replace("_", " ")} ·{" "}
                  {item.metadata?.daysOverdue}d overdue
                </span>
                <ArrowRight size={16} aria-hidden className="text-ink-tertiary" />
              </span>
            </RowLink>
          ))}
        </div>
        {total > visits.length && (
          <div className="mt-2 text-ui-caption text-ink-secondary">
            Showing the oldest {visits.length} of {total}.
          </div>
        )}
      </CardBody>
    </UiSurface>
  );
}
