import {
  AttributionScorecard,
  CapitalAllocationCard,
  CaptureGauge,
  ChartCard,
  EstimateFunnel,
  KpiSparklineTile,
  RevenueByCity,
  RevenueTrendArea,
  fmtInt,
  fmtMoney,
  fmtMoneyCompact,
} from "../../../../components/dashboard/charts";
import DashboardSection from "../DashboardSection";
import MobileFold from "../MobileFold";
import { KpiStrip, KpiTile } from "../KpiTile";
import Verdict from "../Verdict";
import FunnelBySource from "../FunnelBySource";
import {
  capitalVerdict,
  captureVerdict,
  funnelVerdict,
} from "../scorecard-metrics";

// Build a daily-revenue sparkline series from the array of { date, total }
// returned by /admin/dashboard. Pad to at least 2 points so the sparkline
// renders even on day 1 of the month.
function sparkSeries(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return [];
  if (daily.length === 1) return [0, daily[0].total];
  return daily.map((d) => Number(d.total) || 0);
}

// GROWTH — is the business growing? Revenue capture, hero KPIs, lead-to-booked
// conversion, the estimate funnel, and where the leads/dollars come from.
export default function GrowthSection({
  data,
  compare,
  salesCapture,
  kpis,
  kpisLoading,
  kpisError,
  kpiTargets,
  kpiHistory,
  funnel,
  revenueByCity,
  capAlloc,
  callsBySource,
  leadsBySource,
  channelMix,
  leadFunnel,
  attributionLoading,
  attributionError,
  onDrillSource,
  isMobile,
}) {
  const k = data.kpis;
  const dailySpark = sparkSeries(data.revenueChart?.daily);
  const sales = kpis?.sales || {};
  const salesUnavailable = !!sales.error;

  // Hero KPI tiles. Google Rating tile intentionally removed. Review Index
  // uses /rate/:token submissions and is not a standard NPS calculation.
  const HERO = [
    {
      label: "Revenue MTD",
      value: fmtMoney(k.revenueMTD),
      delta: compare?.deltas?.revenue ?? k.revenueChangePercent,
      deltaSuffix: "% vs same days last month",
      series: dailySpark,
    },
    {
      label: "Active Customers",
      value: fmtInt(k.activeCustomers),
      sub: `+${fmtInt(k.newCustomersThisMonth)} new MTD`,
    },
    {
      label: "MRR",
      value: fmtMoney(data.mrr),
      // Headline MRR counts every recurring account, but paused-autopay and
      // overdue accounts aren't actually going to bill. When any MRR is at
      // risk, surface the committed-vs-at-risk split instead of ARR so the
      // headline doesn't silently overstate the run-rate.
      sub:
        data.mrrBreakdown?.atRisk > 0
          ? `${fmtMoneyCompact(data.mrrBreakdown.committed)} committed · ${fmtMoneyCompact(data.mrrBreakdown.atRisk)} at risk`
          : `ARR ${fmtMoneyCompact(data.mrr * 12)}`,
    },
    {
      label: "Review Index",
      value: kpis?.quality?.nps != null ? String(kpis.quality.nps) : "—",
      sub: kpis?.quality?.csatResponses
        ? `${kpis.quality.csatResponses} responses · ${kpis.quality.csatAvg}/10 avg`
        : "awaiting rate-page submissions",
      alert: kpis?.quality?.nps != null && kpis.quality.nps < 30,
    },
  ];

  return (
    <DashboardSection
      id="growth"
      title="Growth"
      caption="Is the business growing?"
      about="Top of the funnel to closed revenue: how much estimated work you're capturing, revenue vs the same days last month, lead-to-booked conversion, and where customers actually come from. The ad-dollars card banding is 12-month gross-profit LTV against all-in acquisition cost — 3:1 is the floor; cut what's below it, feed what's far above it."
    >
      {/* Sales Capture gauge + Revenue trend — capture rate next to the
          revenue it drives. */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 md:mb-5">
        {salesCapture && (
          <ChartCard
            title="Sales Capture"
            sub={`${fmtMoney(salesCapture.captured)} captured of ${fmtMoney(
              (salesCapture.captured || 0) + (salesCapture.missed || 0),
            )} estimated · MTD`}
          >
            <CaptureGauge
              captureRate={salesCapture.captureRate}
              captured={salesCapture.captured}
              missed={salesCapture.missed}
              wonCount={salesCapture.wonCount}
              lostCount={salesCapture.lostCount}
            />
            <Verdict verdict={captureVerdict(salesCapture)} />
          </ChartCard>
        )}
        <ChartCard
          title={`Revenue — ${new Date().toLocaleDateString("en-US", { month: "long", year: "numeric", timeZone: "America/New_York" })}`}
          sub={
            compare?.deltas?.revenue != null
              ? `${compare.deltas.revenue >= 0 ? "↑" : "↓"} ${Math.abs(compare.deltas.revenue)}% vs ${compare.against?.label?.toLowerCase() || "prior period"}`
              : "vs same days last month"
          }
          action={
            <span className="text-12 text-ink-secondary">
              MRR{" "}
              <span className="u-nums font-medium text-zinc-900 ml-1">
                {fmtMoney(data.mrr)}
              </span>
            </span>
          }
        >
          <RevenueTrendArea
            current={compare?.period?.series || data.revenueChart?.daily || []}
            prior={compare?.against?.series || []}
          />
        </ChartCard>
      </div>

      {/* Hero KPI row — sparkline + delta */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4 md:mb-5">
        {HERO.map((h) => (
          <KpiSparklineTile key={h.label} {...h} />
        ))}
      </div>

      {/* Lead-conversion tiles for the selected period */}
      <div className="mb-4 md:mb-5">
        <KpiStrip loading={kpisLoading} error={kpisError} ready={!!kpis}>
          {kpis && (
            <>
              {/* Threshold tones come from the kpi_targets store via
                  metricKey; `alert` keeps only the unavailable-data red. */}
              <KpiTile
                label="Lead → Booked"
                metricKey="lead_conversion"
                targets={kpiTargets}
                history={kpiHistory}
                value={
                  !salesUnavailable && sales.conversion != null
                    ? `${sales.conversion}%`
                    : "—"
                }
                sub={
                  salesUnavailable
                    ? "lead metrics unavailable"
                    : `${sales.booked ?? 0}/${sales.leads ?? 0} leads`
                }
                alert={salesUnavailable}
                chart={{ kind: "gauge", value: salesUnavailable ? null : sales.conversion, max: 100 }}
              />
              <KpiTile
                label="Response Speed"
                metricKey="response_speed_min"
                targets={kpiTargets}
                history={kpiHistory}
                value={
                  !salesUnavailable && sales.avgResponseMin != null
                    ? `${sales.avgResponseMin}m`
                    : "—"
                }
                sub={
                  salesUnavailable
                    ? "lead metrics unavailable"
                    : "lead → first contact"
                }
                alert={salesUnavailable}
                chart={{ kind: "bullet", value: salesUnavailable ? null : sales.avgResponseMin }}
              />
              <KpiTile
                label="Call → Booking"
                value={
                  !salesUnavailable && sales.callToBooking != null
                    ? `${sales.callToBooking}%`
                    : "—"
                }
                sub={
                  salesUnavailable
                    ? "lead metrics unavailable"
                    : `${sales.booked ?? 0} booked / ${sales.inboundCalls ?? 0} calls`
                }
                chart={{ kind: "gauge", value: salesUnavailable ? null : sales.callToBooking, max: 100 }}
              />
              <KpiTile
                label="Memberships Sold"
                value={
                  kpis.membershipsSold != null
                    ? fmtInt(kpis.membershipsSold)
                    : "—"
                }
                sub="new WaveGuard members"
              />
            </>
          )}
        </KpiStrip>
      </div>

      {/* Estimate funnel + revenue by city */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4 md:mb-5">
        <ChartCard
          title="Estimate Funnel"
          sub={
            funnel?.period ? `${funnel.period.from} → ${funnel.period.to}` : ""
          }
        >
          <EstimateFunnel
            funnel={funnel?.funnel || {}}
            rates={funnel?.rates || {}}
            totalAcceptedValue={funnel?.total_accepted_value}
            byService={funnel?.by_service}
          />
          <Verdict verdict={funnelVerdict(funnel)} />
        </ChartCard>
        {revenueByCity ? (
          <ChartCard
            title="Revenue by City"
            sub={`${fmtMoney(revenueByCity.total || 0)} · MTD`}
          >
            <RevenueByCity
              cities={revenueByCity.cities || []}
              total={revenueByCity.total || 0}
            />
          </ChartCard>
        ) : (
          <div />
        )}
      </div>

      {/* Capital allocation — acquisition channels banded by LTV:CAC. Basis
          (stated on the card itself): 12-mo lifetime GROSS PROFIT ÷ all-in
          marketing cost (ad spend + retainers + referral rewards) — see
          server/services/capital-allocation.js. Trailing 90 days. */}
      {isMobile ? (
        <MobileFold
          title="Where to Put Ad Dollars"
          sub="gross-profit LTV : all-in CAC · 90 days"
        >
          {/* No inner ChartCard — the fold's summary already carries the
              title/sub, and repeating them read as a rendering bug. */}
          <div className="px-1 pt-1">
            <CapitalAllocationCard data={capAlloc} />
            <Verdict verdict={capitalVerdict(capAlloc)} />
          </div>
        </MobileFold>
      ) : (
        <div className="mb-5">
          <ChartCard
            title="Where to Put Ad Dollars"
            sub="acquisition channels by gross-profit LTV : all-in CAC · last 90 days"
          >
            <CapitalAllocationCard data={capAlloc} />
            <Verdict verdict={capitalVerdict(capAlloc)} />
          </ChartCard>
        </div>
      )}

      {/* Upstream lead-attribution row.
          - Calls by Source: call_log JOIN lead_sources by dialed number
          - Leads by Source: leads GROUP BY lead_source_id
          - Channel Mix:     leads.first_contact_channel breakdown
          Uses the same period selector as the KPI tiles. */}
      {isMobile ? (
        <MobileFold
          title="Marketing Attribution"
          sub={
            callsBySource?.period?.label || kpis?.periodLabel || "Month to Date"
          }
        >
          <AttributionScorecard
            callsBySource={callsBySource}
            leadsBySource={leadsBySource}
            channelMix={channelMix}
            loading={attributionLoading}
            error={attributionError}
            onDrillSource={onDrillSource}
          />
        </MobileFold>
      ) : (
        <ChartCard
          title="Marketing Attribution"
          sub={
            callsBySource?.period?.label || kpis?.periodLabel || "Month to Date"
          }
        >
          <AttributionScorecard
            callsBySource={callsBySource}
            leadsBySource={leadsBySource}
            channelMix={channelMix}
            loading={attributionLoading}
            error={attributionError}
            onDrillSource={onDrillSource}
          />
        </ChartCard>
      )}

      {/* Lead funnel by source — how far each channel's leads actually get
          (attribution-row basis, stated on the card; same period selector). */}
      {isMobile ? (
        <MobileFold
          title="Lead Funnel by Source"
          sub={leadFunnel?.period?.label || kpis?.periodLabel || "Month to Date"}
        >
          <div className="px-1 pt-1">
            <FunnelBySource
              data={leadFunnel}
              loading={attributionLoading}
              error={attributionError}
              onDrillSource={onDrillSource}
            />
          </div>
        </MobileFold>
      ) : (
        <div className="mt-4">
          <ChartCard
            title="Lead Funnel by Source"
            sub={leadFunnel?.period?.label || kpis?.periodLabel || "Month to Date"}
          >
            <FunnelBySource
              data={leadFunnel}
              loading={attributionLoading}
              error={attributionError}
              onDrillSource={onDrillSource}
            />
          </ChartCard>
        </div>
      )}
    </DashboardSection>
  );
}
