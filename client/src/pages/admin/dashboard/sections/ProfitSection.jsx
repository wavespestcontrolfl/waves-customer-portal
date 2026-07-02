import {
  ChartCard,
  ServiceMixDonut,
  TechLeaderboardBars,
  fmtMoney,
} from "../../../../components/dashboard/charts";
import DashboardSection from "../DashboardSection";
import MobileFold from "../MobileFold";
import { KpiStrip, KpiTile } from "../KpiTile";

// PROFIT — what's helping or hurting margin: fully-burdened gross margin,
// labor productivity, the completed-service mix, and per-tech economics.
export default function ProfitSection({
  kpis,
  kpisLoading,
  kpisError,
  mix,
  isMobile,
}) {
  return (
    <DashboardSection
      id="profit"
      title="Profit"
      caption="What's helping or hurting margin?"
    >
      <div className="mb-4 md:mb-5">
        <KpiStrip loading={kpisLoading} error={kpisError} ready={!!kpis}>
          {kpis && (
            <>
              <KpiTile
                label="Gross Margin"
                value={
                  kpis.financial.grossMarginWeighted != null
                    ? `${Math.round(kpis.financial.grossMarginWeighted)}%`
                    : "—"
                }
                sub={
                  kpis.financial.grossMarginAvg != null
                    ? `per-job avg ${Math.round(kpis.financial.grossMarginAvg)}%`
                    : "revenue-weighted"
                }
                alert={
                  kpis.financial.grossMarginWeighted != null &&
                  kpis.financial.grossMarginWeighted < 40
                }
                chart={{ kind: "gauge", value: kpis.financial.grossMarginWeighted, max: 100, target: 40 }}
              />
              <KpiTile
                label="Revenue / Man-Hour"
                value={
                  kpis.financial.rpmh != null
                    ? fmtMoney(kpis.financial.rpmh)
                    : "—"
                }
                sub="target $120"
                alert={
                  kpis.financial.rpmh != null && kpis.financial.rpmh < 90
                }
                chart={{ kind: "bullet", value: kpis.financial.rpmh, target: 120 }}
              />
              <KpiTile
                label="Revenue / Job"
                value={
                  kpis.financial.revPerJob != null
                    ? fmtMoney(kpis.financial.revPerJob)
                    : "—"
                }
                sub={`${kpis.financial.jobsDone} completed`}
              />
            </>
          )}
        </KpiStrip>
      </div>

      {/* Service mix — which services the completed revenue comes from */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 md:mb-5">
        <ChartCard
          title="Service Mix"
          sub={`${mix?.total_services || 0} completed services this month`}
        >
          <ServiceMixDonut mix={mix?.mix || []} />
        </ChartCard>
      </div>

      {/* Tech leaderboard — bar variant */}
      {kpis?.leaderboard?.length > 0 &&
        (isMobile ? (
          <MobileFold title="Tech Leaderboard" sub={kpis.periodLabel}>
            <ChartCard title="Tech Leaderboard" sub={kpis.periodLabel}>
              <TechLeaderboardBars leaderboard={kpis.leaderboard} />
            </ChartCard>
          </MobileFold>
        ) : (
          <ChartCard title="Tech Leaderboard" sub={kpis.periodLabel}>
            <TechLeaderboardBars leaderboard={kpis.leaderboard} />
          </ChartCard>
        ))}
    </DashboardSection>
  );
}
