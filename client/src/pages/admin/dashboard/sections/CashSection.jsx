import {
  AgingBar,
  ChartCard,
  fmtMoneyCompact,
} from "../../../../components/dashboard/charts";
import DashboardSection from "../DashboardSection";
import MobileFold from "../MobileFold";
import BillingHealthPanel from "../BillingHealthPanel";
import { KpiStrip, KpiTile } from "../KpiTile";
import Verdict from "../Verdict";
import { agingVerdict } from "../scorecard-metrics";

// CASH — are we collecting what we earned? Collections, AR aging, and the
// autopay/billing machinery that turns MRR into money.
export default function CashSection({
  kpis,
  kpisLoading,
  kpisError,
  kpiTargets,
  kpiHistory,
  aging,
  billing,
  isMobile,
}) {
  return (
    <DashboardSection
      id="cash"
      title="Cash"
      caption="Are we collecting what we earned?"
      about="Earned revenue isn't cash until it's collected. Collection rate shows how much billed work actually got paid, AR aging shows what's outstanding and for how long (chase the 90+ buckets first — collectability falls off a cliff), and Billing Health shows the autopay coverage that prevents AR from forming at all."
    >
      <div className="mb-4 md:mb-5">
        <KpiStrip loading={kpisLoading} error={kpisError} ready={!!kpis}>
          {kpis && (
            <>
              {/* Threshold tones come from the kpi_targets store via
                  metricKey; Collection Rate's old issuedCount>=5 alert guard
                  is now the tile's generic small-N fade (`n`). */}
              <KpiTile
                label="Collection Rate"
                metricKey="collection_rate"
                targets={kpiTargets}
                history={kpiHistory}
                n={kpis.billing?.issuedCount || null}
                value={
                  kpis.billing?.collectionRate != null
                    ? `${kpis.billing.collectionRate}%`
                    : "—"
                }
                sub={
                  kpis.billing?.issuedCount
                    ? `${fmtMoneyCompact(kpis.billing.collected)} / ${fmtMoneyCompact(kpis.billing.billed)} · ${kpis.billing.collectedCount}/${kpis.billing.issuedCount} paid`
                    : "no invoices issued"
                }
                chart={{ kind: "gauge", value: kpis.billing?.collectionRate, max: 100 }}
              />
              <KpiTile
                label="AR Days"
                metricKey="ar_days"
                targets={kpiTargets}
                history={kpiHistory}
                value={kpis.ar.days != null ? `${kpis.ar.days}d` : "—"}
                sub={`${fmtMoneyCompact(kpis.ar.open)} open · ${kpis.ar.overdueCount} overdue`}
                chart={{ kind: "bullet", value: kpis.ar.days }}
              />
              <KpiTile
                label="Autopay Coverage"
                metricKey="autopay_pct"
                targets={kpiTargets}
                history={kpiHistory}
                value={
                  kpis.billing?.autopayPct != null
                    ? `${kpis.billing.autopayPct}%`
                    : "—"
                }
                sub={
                  kpis.billing?.customerBase
                    ? `${kpis.billing.autopayCount} of ${kpis.billing.customerBase} customers`
                    : "no customers"
                }
                chart={{ kind: "gauge", value: kpis.billing?.autopayPct, max: 100 }}
              />
            </>
          )}
        </KpiStrip>
      </div>

      {/* AR aging — the 90+ buckets are the only place alert-fg */}
      <div className="mb-5">
        <ChartCard
          title="Accounts Receivable Aging"
          sub={
            aging?.invoice_count != null
              ? `${aging.invoice_count} open invoices`
              : ""
          }
        >
          <AgingBar
            aging={aging?.aging || {}}
            totalOutstanding={aging?.total_outstanding}
            totalOverdue={aging?.total_overdue}
          />
          <Verdict verdict={agingVerdict(aging)} />
        </ChartCard>
      </div>

      {/* Billing Health — autopay coverage + won't-bill states */}
      {billing &&
        (isMobile ? (
          <MobileFold
            title="Billing Health"
            sub={`${billing.total_billable} billable`}
          >
            <BillingHealthPanel summary={billing} embedded />
          </MobileFold>
        ) : (
          <BillingHealthPanel summary={billing} />
        ))}
    </DashboardSection>
  );
}
