import {
  ChartCard,
  MrrTrendChart,
  RetentionCohortGrid,
  ReviewTrendChart,
  fmtInt,
  fmtMoney,
  fmtMoneyCompact,
} from "../../../../components/dashboard/charts";
import DashboardSection from "../DashboardSection";
import MobileFold from "../MobileFold";
import { KpiStrip, KpiTile, signed } from "../KpiTile";
import Verdict from "../Verdict";
import { mrrVerdict } from "../scorecard-metrics";

// RETENTION — are customers staying? Net recurring-revenue momentum, the MRR
// trend, signup-cohort retention, and the customer-quality signals behind it.
export default function RetentionSection({
  kpis,
  kpisLoading,
  kpisError,
  kpiTargets,
  kpiHistory,
  mrrTrend,
  cohort,
  reviewTrend,
  isMobile,
}) {
  const mrrTrendSub =
    mrrTrend?.avg_growth_pct != null
      ? `${mrrTrend.avg_growth_pct >= 0 ? "↑" : "↓"} ${Math.abs(mrrTrend.avg_growth_pct)}% avg monthly growth`
      : "last 12 months";

  return (
    <DashboardSection
      id="retention"
      title="Retention"
      caption="Are customers staying?"
    >
      <div className="mb-4 md:mb-5">
        <KpiStrip loading={kpisLoading} error={kpisError} ready={!!kpis}>
          {kpis && (
            <>
              {kpis.momentum && (
                <>
                  {/* Net tiles keep their sign-based red; metricKey adds the
                      sparkline (no default target for momentum metrics). */}
                  <KpiTile
                    label="Net MRR"
                    metricKey="net_mrr"
                    metricValue={kpis.momentum.mrr?.net}
                    targets={kpiTargets}
                    history={kpiHistory}
                    value={signed(kpis.momentum.mrr?.net, fmtMoney)}
                    sub={`+${fmtMoneyCompact(kpis.momentum.mrr?.new ?? 0)} new · ${fmtMoneyCompact(kpis.momentum.mrr?.churned ?? 0)} lost`}
                    alert={kpis.momentum.mrr?.net < 0}
                    chart={{
                      kind: "diverging",
                      positive: kpis.momentum.mrr?.new ?? 0,
                      negative: kpis.momentum.mrr?.churned ?? 0,
                    }}
                  />
                  <KpiTile
                    label="Net Customers"
                    metricKey="net_customers"
                    metricValue={kpis.momentum.customers?.net}
                    targets={kpiTargets}
                    history={kpiHistory}
                    value={signed(kpis.momentum.customers?.net, fmtInt)}
                    sub={`+${fmtInt(kpis.momentum.customers?.new ?? 0)} new · ${fmtInt(kpis.momentum.customers?.lost ?? 0)} lost`}
                    alert={kpis.momentum.customers?.net < 0}
                    chart={{
                      kind: "diverging",
                      positive: kpis.momentum.customers?.new ?? 0,
                      negative: kpis.momentum.customers?.lost ?? 0,
                    }}
                  />
                </>
              )}
              <KpiTile
                label="Retention"
                metricKey="retention_pct"
                targets={kpiTargets}
                history={kpiHistory}
                value={
                  kpis.retention.pct != null ? `${kpis.retention.pct}%` : "—"
                }
                sub={`${kpis.retention.lost} lost`}
                chart={{ kind: "gauge", value: kpis.retention.pct, max: 100 }}
              />
              <KpiTile
                label="CSAT"
                metricKey="csat_avg"
                targets={kpiTargets}
                history={kpiHistory}
                n={kpis.quality.csatResponses || null}
                value={
                  kpis.quality.csatAvg != null
                    ? `${kpis.quality.csatAvg}/10`
                    : "—"
                }
                sub={
                  kpis.quality.csatResponses
                    ? `${kpis.quality.csatResponses} rate-page responses`
                    : "no responses yet"
                }
                chart={{
                  kind: "gauge",
                  value: kpis.quality.csatAvg != null ? parseFloat(kpis.quality.csatAvg) : null,
                  max: 10,
                }}
              />
            </>
          )}
        </KpiStrip>
      </div>

      {/* MRR trend */}
      {isMobile ? (
        <MobileFold title="MRR Trend" sub={mrrTrendSub}>
          <ChartCard title="MRR Trend" sub={mrrTrendSub}>
            <MrrTrendChart trend={mrrTrend?.trend || []} />
            <Verdict verdict={mrrVerdict(kpis?.momentum?.mrr)} />
          </ChartCard>
        </MobileFold>
      ) : (
        <div className="mb-5">
          <ChartCard title="MRR Trend" sub={mrrTrendSub}>
            <MrrTrendChart trend={mrrTrend?.trend || []} />
            <Verdict verdict={mrrVerdict(kpis?.momentum?.mrr)} />
          </ChartCard>
        </div>
      )}

      {/* Retention by signup cohort — % of each month's new customers still
          active over the months since they joined. */}
      {isMobile ? (
        <MobileFold
          title="Retention by Cohort"
          sub="% still active by signup month"
        >
          <ChartCard
            title="Retention by Cohort"
            sub="% still active by signup month"
          >
            <RetentionCohortGrid
              cohorts={cohort?.cohorts || []}
              maxOffset={cohort?.maxOffset || 0}
            />
          </ChartCard>
        </MobileFold>
      ) : (
        <div className="mb-5">
          <ChartCard
            title="Retention by Cohort"
            sub="% of each signup month still active"
          >
            <RetentionCohortGrid
              cohorts={cohort?.cohorts || []}
              maxOffset={cohort?.maxOffset || 0}
            />
          </ChartCard>
        </div>
      )}

      {/* Reviews trend — reputation compounds retention and referrals */}
      <ChartCard
        title="Reviews"
        sub={`${reviewTrend?.total ?? 0} reviews · ${reviewTrend?.avgRating ?? "—"}★ avg`}
        action={
          kpis?.quality?.nps != null ? (
            <span className="text-12 text-ink-secondary">
              Index{" "}
              <span className="u-nums font-medium text-zinc-900 ml-1">
                {kpis.quality.nps}
              </span>
            </span>
          ) : null
        }
      >
        <ReviewTrendChart trend={reviewTrend?.trend || []} />
      </ChartCard>
    </DashboardSection>
  );
}
