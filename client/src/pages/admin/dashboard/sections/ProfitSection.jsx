import {
  ChartCard,
  ServiceMixDonut,
  TechLeaderboardBars,
  fmtMoney,
} from "../../../../components/dashboard/charts";
import DashboardSection from "../DashboardSection";
import MobileFold from "../MobileFold";
import { KpiStrip, KpiTile } from "../KpiTile";
import EbitdaBridgeCard from "../EbitdaBridgeCard";

// PROFIT — what's helping or hurting margin: fully-burdened gross margin,
// labor productivity, the adjusted-EBITDA bridge (company-level, kept in its
// own card NEXT TO but never mixed with the job-level gross margin), the
// completed-service mix, and per-tech economics.
export default function ProfitSection({
  kpis,
  kpisLoading,
  kpisError,
  kpiTargets,
  kpiHistory,
  mix,
  ebitda,
  isMobile,
}) {
  return (
    <DashboardSection
      id="profit"
      title="Profit"
      caption="What's helping or hurting margin?"
      about="Two different questions, two cards: gross margin asks whether JOBS are profitable after labor, materials, and drive time; the adjusted-EBITDA bridge asks whether the COMPANY is profitable after marketing and operating overhead. They sit side by side but never mix — a healthy gross margin with a thin EBITDA means overhead or marketing is eating the job profit."
    >
      <div className="mb-4 md:mb-5">
        <KpiStrip loading={kpisLoading} error={kpisError} ready={!!kpis}>
          {kpis && (
            <>
              {/* Threshold tones come from the kpi_targets store via
                  metricKey (defaults preserve the old hardcoded values). */}
              <KpiTile
                label="Gross Margin"
                metricKey="gross_margin"
                targets={kpiTargets}
                history={kpiHistory}
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
                chart={{ kind: "gauge", value: kpis.financial.grossMarginWeighted, max: 100 }}
              />
              <KpiTile
                label="Revenue / Man-Hour"
                metricKey="revenue_per_man_hour"
                targets={kpiTargets}
                history={kpiHistory}
                value={
                  kpis.financial.rpmh != null
                    ? fmtMoney(kpis.financial.rpmh)
                    : "—"
                }
                sub={`target $${kpiTargets?.revenue_per_man_hour?.target ?? 120}`}
                chart={{ kind: "bullet", value: kpis.financial.rpmh }}
              />
              <KpiTile
                label="Revenue / Job"
                metricKey="revenue_per_job"
                metricValue={kpis.financial.revPerJob}
                targets={kpiTargets}
                history={kpiHistory}
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

      {/* Adjusted-EBITDA bridge + service mix. The bridge is company-level
          profitability (after marketing + overhead) and deliberately its own
          card — gross margin above answers "are jobs profitable after COGS?",
          this answers "is the company profitable after operating expenses?" */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 md:mb-5">
        <ChartCard
          title="Adjusted EBITDA Bridge"
          sub={
            ebitda?.period
              ? `month to date · ${ebitda.period.elapsedDays} of ${ebitda.period.daysInMonth} days`
              : "month to date"
          }
        >
          <EbitdaBridgeCard bridge={ebitda} />
        </ChartCard>
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
            <div className="px-1 pt-1">
              <TechLeaderboardBars leaderboard={kpis.leaderboard} />
            </div>
          </MobileFold>
        ) : (
          <ChartCard title="Tech Leaderboard" sub={kpis.periodLabel}>
            <TechLeaderboardBars leaderboard={kpis.leaderboard} />
          </ChartCard>
        ))}
    </DashboardSection>
  );
}
