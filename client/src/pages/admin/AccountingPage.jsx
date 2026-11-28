import React, { useState, useEffect, useCallback } from "react";
import {
  ActionFeedback,
  Badge,
  Card,
  CardHeader,
  CardTitle,
  CardBody,
  Tabs,
  TabList,
  Tab,
  TabPanel,
  UiSurface,
} from "../../components/ui";
import { getJson, formatCents } from "./accounting/api";
import ReportsTab from "./accounting/ReportsTab";
import ChartOfAccountsTab from "./accounting/ChartOfAccountsTab";
import JournalEntriesTab from "./accounting/JournalEntriesTab";
import ReconcileTab from "./accounting/ReconcileTab";
import VendorsAndPeriodsTab from "./accounting/VendorsAndPeriodsTab";

export default function AccountingPage() {
  const [status, setStatus] = useState({ loading: true, enabled: false });
  const [overview, setOverview] = useState(null);
  const [tab, setTab] = useState("reports");
  const [error, setError] = useState("");

  const loadOverview = useCallback(async () => {
    try {
      const data = await getJson("/overview");
      setOverview(data);
    } catch (err) {
      setError(err.message || "Could not load accounting overview.");
    }
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const s = await getJson("/status");
        if (!active) return;
        setStatus({ loading: false, enabled: Boolean(s.enabled) });
        if (s.enabled) await loadOverview();
      } catch (err) {
        if (!active) return;
        setStatus({ loading: false, enabled: false });
        setError(err.message || "Could not check accounting status.");
      }
    })();
    return () => { active = false; };
  }, [loadOverview]);

  if (status.loading) {
    return (
      <UiSurface density="comfortable" className="p-4 sm:p-6 max-w-7xl mx-auto">
        <div className="text-14 text-zinc-500">Loading General Ledger...</div>
      </UiSurface>
    );
  }

  if (!status.enabled) {
    return (
      <UiSurface density="comfortable" className="p-4 sm:p-6 max-w-4xl mx-auto space-y-4">
        <Card>
          <CardHeader>
            <CardTitle>General Ledger (Double-Entry Accounting)</CardTitle>
          </CardHeader>
          <CardBody className="space-y-3 text-14 text-zinc-700">
            <p>
              The double-entry General Ledger is installed and dark behind <span className="font-mono">GATE_ACCOUNTING_GL=true</span>.
            </p>
            <p>
              Enable <span className="font-mono">GATE_ACCOUNTING_GL=true</span> in Settings or Railway environment variables to unlock Chart of Accounts, Balanced Journal Entries, Statement Reconciliation, Period Locks, and Accrual/Cash Financial Statements.
            </p>
            {error ? <ActionFeedback error>{error}</ActionFeedback> : null}
          </CardBody>
        </Card>
      </UiSurface>
    );
  }

  const kpis = overview ? [
    { label: "Cash & Clearing", value: formatCents(overview.cash_total_cents) },
    { label: "Accounts Receivable", value: formatCents(overview.accounts_receivable_cents) },
    { label: "Sales Tax Payable", value: formatCents(overview.sales_tax_payable_cents) },
    { label: "Unearned Revenue", value: formatCents(overview.unearned_revenue_cents) },
    { label: "YTD Net Income", value: formatCents(overview.ytd?.net_income_cents || 0) },
  ] : [];

  return (
    <UiSurface density="comfortable" className="p-4 sm:p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-20 font-semibold text-zinc-900">General Ledger</h1>
          <p className="text-14 text-zinc-600 mt-0.5">
            Double-entry Chart of Accounts, balanced journals, statement reconciliation, and financial statements.
          </p>
        </div>
        {overview ? (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={overview.trial_balance_ok && overview.balance_sheet_ok ? "strong" : "alert"}>
              {overview.trial_balance_ok && overview.balance_sheet_ok ? "Books Balanced" : "Ledger Out of Balance"}
            </Badge>
            <Badge tone="neutral">
              {overview.locked_through ? `Locked through ${overview.locked_through}` : "No Locked Periods"}
            </Badge>
          </div>
        ) : null}
      </div>

      {error ? <ActionFeedback error>{error}</ActionFeedback> : null}
      {kpis.length > 0 ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          {kpis.map((item) => (
            <Card key={item.label}>
              <CardBody className="py-3 px-4">
                <div className="text-14 text-zinc-600">{item.label}</div>
                <div className="text-18 font-semibold font-mono text-zinc-900 mt-1">{item.value}</div>
              </CardBody>
            </Card>
          ))}
        </div>
      ) : null}

      <Tabs value={tab} onValueChange={setTab}>
        <TabList scrollable>
          <Tab value="reports">Financial Statements</Tab>
          <Tab value="coa">Chart of Accounts</Tab>
          <Tab value="journal">Journal Entries</Tab>
          <Tab value="reconcile">Reconcile</Tab>
          <Tab value="close">Vendors &amp; Close Books</Tab>
        </TabList>

        <TabPanel value="reports" className="pt-4">
          <ReportsTab />
        </TabPanel>
        <TabPanel value="coa" className="pt-4">
          <ChartOfAccountsTab onChanged={loadOverview} />
        </TabPanel>
        <TabPanel value="journal" className="pt-4">
          <JournalEntriesTab onChanged={loadOverview} />
        </TabPanel>
        <TabPanel value="reconcile" className="pt-4">
          <ReconcileTab onChanged={loadOverview} />
        </TabPanel>
        <TabPanel value="close" className="pt-4">
          <VendorsAndPeriodsTab onChanged={loadOverview} />
        </TabPanel>
      </Tabs>
    </UiSurface>
  );
}
