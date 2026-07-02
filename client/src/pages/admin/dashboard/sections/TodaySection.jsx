import {
  ChartCard,
  CompletionGauge,
  EmptyState,
} from "../../../../components/dashboard/charts";
import DashboardSection from "../DashboardSection";
import DashboardAlertsBanner from "../DashboardAlertsBanner";
import { KpiStrip, KpiTile } from "../KpiTile";

// TODAY — what needs attention right now: operational alerts, today's schedule
// completion, and the period's service-execution tiles.
export default function TodaySection({
  alerts,
  today,
  kpis,
  kpisLoading,
  kpisError,
}) {
  return (
    <DashboardSection id="today" title="Today" caption="What needs attention right now">
      {alerts.length > 0 && <DashboardAlertsBanner alerts={alerts} />}
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
            <CompletionGauge
              completed={today.completed}
              total={today.total}
              remaining={today.remaining}
              cancelled={today.cancelled}
              noShow={today.noShow}
            />
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
                <KpiTile
                  label="Service Completion"
                  value={
                    kpis.service.completionRate != null
                      ? `${kpis.service.completionRate}%`
                      : "—"
                  }
                  sub={`${kpis.service.completed}/${kpis.service.scheduled} jobs`}
                  alert={
                    kpis.service.completionRate != null &&
                    kpis.service.completionRate < 85
                  }
                  chart={{ kind: "gauge", value: kpis.service.completionRate, max: 100, target: 85 }}
                />
                <KpiTile
                  label="Callback Rate"
                  value={
                    kpis.service.callbackRate != null
                      ? `${kpis.service.callbackRate}%`
                      : "—"
                  }
                  sub={`${kpis.service.callbacks} callbacks`}
                  alert={
                    kpis.service.callbackRate != null &&
                    kpis.service.callbackRate >= 6
                  }
                  chart={{ kind: "gauge", value: kpis.service.callbackRate, max: 12, target: 6, lowerIsBetter: true }}
                />
              </>
            )}
          </KpiStrip>
        </div>
      </div>
    </DashboardSection>
  );
}
