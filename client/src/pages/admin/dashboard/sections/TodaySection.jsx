import {
  ChartCard,
  CompletionGauge,
  EmptyState,
} from "../../../../components/dashboard/charts";
import DashboardSection from "../DashboardSection";
import ActionInbox from "../ActionInbox";
import { KpiStrip, KpiTile } from "../KpiTile";
import Verdict from "../Verdict";
import { completionVerdict } from "../scorecard-metrics";

// TODAY — what needs attention right now: the ranked Action Inbox, today's
// schedule completion, and the period's service-execution tiles.
export default function TodaySection({
  alerts,
  alertsStale,
  today,
  kpis,
  kpisLoading,
  kpisError,
  kpiTargets,
  kpiHistory,
}) {
  return (
    <DashboardSection
      id="today"
      title="Today"
      caption="What needs attention right now"
      about="Live operations for the current day: the Action Inbox ranks what to fix first (stale leads, expiring estimates, at-risk recurring revenue), Today's Completion tracks the schedule as it happens, and the tiles show service execution for the selected period. Start here each morning — clear the inbox, then check the other tabs."
    >
      <ActionInbox alerts={alerts} stale={alertsStale} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <ChartCard
          title="Today's Completion"
          sub={
            // today.date is an ET calendar date (YYYY-MM-DD). Anchor at UTC
            // noon and format in UTC so the weekday can't drift in a viewer
            // timezone far from ET (browser-local parsing would).
            today?.date
              ? new Date(today.date + "T12:00:00Z").toLocaleDateString(
                  "en-US",
                  { weekday: "long", timeZone: "UTC" },
                )
              : ""
          }
        >
          {today ? (
            <>
              <CompletionGauge
                completed={today.completed}
                total={today.total}
                remaining={today.remaining}
                cancelled={today.cancelled}
                noShow={today.noShow}
              />
              <Verdict verdict={completionVerdict(today)} />
            </>
          ) : (
            <EmptyState>Loading…</EmptyState>
          )}
        </ChartCard>
        <div className="md:col-span-2">
          <KpiStrip
            loading={kpisLoading}
            error={kpisError}
            ready={!!kpis}
            gridClassName="grid grid-cols-1 sm:grid-cols-2 gap-3"
          >
            {kpis && (
              <>
                {/* Targets/tones come from the kpi_targets store via metricKey
                    (DEFAULT_KPI_TARGETS preserves the old thresholds as the
                    fallback), so tiles no longer hardcode alert conditions. */}
                <KpiTile
                  label="Service Completion"
                  metricKey="completion_rate"
                  targets={kpiTargets}
                  history={kpiHistory}
                  value={
                    kpis.service.completionRate != null
                      ? `${kpis.service.completionRate}%`
                      : "—"
                  }
                  sub={`${kpis.service.completed}/${kpis.service.scheduled} jobs`}
                  chart={{ kind: "gauge", value: kpis.service.completionRate, max: 100 }}
                />
                <KpiTile
                  label="Callback Rate"
                  metricKey="callback_rate"
                  targets={kpiTargets}
                  history={kpiHistory}
                  value={
                    kpis.service.callbackRate != null
                      ? `${kpis.service.callbackRate}%`
                      : "—"
                  }
                  sub={`${kpis.service.callbacks} callbacks`}
                  chart={{ kind: "gauge", value: kpis.service.callbackRate, max: 12 }}
                />
              </>
            )}
          </KpiStrip>
        </div>
      </div>
    </DashboardSection>
  );
}
