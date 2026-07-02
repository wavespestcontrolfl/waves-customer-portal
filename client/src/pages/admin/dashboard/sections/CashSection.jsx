import {
  AgingBar,
  ChartCard,
  fmtMoneyCompact,
} from "../../../../components/dashboard/charts";
import DashboardSection from "../DashboardSection";
import MobileFold from "../MobileFold";
import BillingHealthPanel from "../BillingHealthPanel";
import { KpiStrip, KpiTile } from "../KpiTile";

// CASH — are we collecting what we earned? Collections, AR aging, and the
// autopay/billing machinery that turns MRR into money.
export default function CashSection({
  kpis,
  kpisLoading,
  kpisError,
  aging,
  billing,
  isMobile,
}) {
  return (
    <DashboardSection
      id="cash"
      title="Cash"
      caption="Are we collecting what we earned?"
    >
      <div className="mb-4 md:mb-5">
        <KpiStrip loading={kpisLoading} error={kpisError} ready={!!kpis}>
          {kpis && (
            <>
              <KpiTile
                label="Collection Rate"
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
                alert={
                  kpis.billing?.collectionRate != null &&
                  kpis.billing.issuedCount >= 5 &&
                  kpis.billing.collectionRate < 70
                }
                chart={{ kind: "gauge", value: kpis.billing?.collectionRate, max: 100, target: 70 }}
              />
              <KpiTile
                label="AR Days"
                value={kpis.ar.days != null ? `${kpis.ar.days}d` : "—"}
                sub={`${fmtMoneyCompact(kpis.ar.open)} open · ${kpis.ar.overdueCount} overdue`}
                alert={kpis.ar.days != null && kpis.ar.days > 30}
                chart={{ kind: "bullet", value: kpis.ar.days, target: 30, lowerIsBetter: true }}
              />
              <KpiTile
                label="Autopay Coverage"
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
