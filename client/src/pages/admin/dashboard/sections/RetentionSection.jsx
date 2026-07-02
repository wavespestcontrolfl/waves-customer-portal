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

// RETENTION — are customers staying? Net recurring-revenue momentum, the MRR
// trend, signup-cohort retention, and the customer-quality signals behind it.
export default function RetentionSection({
  kpis,
  kpisLoading,
  kpisError,
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
                  <KpiTile
                    label="Net MRR"
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
                value={
                  kpis.retention.pct != null ? `${kpis.retention.pct}%` : "—"
                }
                sub={`${kpis.retention.lost} lost`}
                alert={kpis.retention.pct != null && kpis.retention.pct < 85}
                chart={{ kind: "gauge", value: kpis.retention.pct, max: 100, target: 85 }}
              />
              <KpiTile
                label="CSAT"
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
                alert={
                  kpis.quality.csatAvg != null &&
                  parseFloat(kpis.quality.csatAvg) < 8
                }
                chart={{
                  kind: "gauge",
                  value: kpis.quality.csatAvg != null ? parseFloat(kpis.quality.csatAvg) : null,
                  max: 10,
                  target: 8,
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
          </ChartCard>
        </MobileFold>
      ) : (
        <div className="mb-5">
          <ChartCard title="MRR Trend" sub={mrrTrendSub}>
            <MrrTrendChart trend={mrrTrend?.trend || []} />
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
