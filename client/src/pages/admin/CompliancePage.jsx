import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BadgeCheck, ClipboardList, FileText, Gauge, ShieldCheck } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Badge, Button, Card, CardBody, CardHeader, CardTitle,
  Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, Field, Input,
  Table, TBody, TD, TH, THead, TR, UiSurface,
} from "../../components/ui";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import { getAdminAuthToken, getAdminUser } from "../../lib/adminAuth";
import { formatETDateOnly } from "../../lib/timezone";
import CredentialsPage from "./CredentialsPage";

const API = "/api/admin/compliance-v2";
const APPLICATION_PAGE_SIZE = 25;
const titleCaseCounty = (value) => String(value || "").split("_").filter(Boolean)
  .map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
const fmtDay = (value) => formatETDateOnly(value) || value || "";
const headers = (token) => ({ Authorization: `Bearer ${token}`, "Content-Type": "application/json" });

function useFetch(url, token, deps = []) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const reload = useCallback(() => {
    setLoading(true);
    setError(null);
    fetch(url, { headers: headers(token) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then(setData)
      .catch((requestError) => {
        console.error(requestError);
        setData(null);
        setError(requestError?.message || "Request failed");
      })
      .finally(() => setLoading(false));
  }, [url, token]);
  useEffect(() => { reload(); }, [reload, ...deps]);
  return { data, loading, error, reload };
}

function ErrorState({ children, onRetry, className = "" }) {
  return <div className={`flex flex-wrap items-center gap-3 ${className}`}>
    <ActionFeedback error>{children}</ActionFeedback>
    <Button variant="secondary" onClick={onRetry}>Retry</Button>
  </div>;
}

// tone follows main's accent: amber for the nonblocking warning counts, red only
// where main used D.red. A boolean "alert" flag collapsed both into reserved red.
const STAT_TONES = {
  alert: { border: "border-alert-fg", value: "text-alert-fg", sub: "text-alert-fg" },
  warn: { border: "border-warn-fg", value: "text-warn-fg", sub: "text-warn-fg" },
  neutral: { border: undefined, value: "text-zinc-900", sub: "text-ink-secondary" },
};

function StatCard({ label, value, sub, tone = "neutral" }) {
  const { border, value: valueTone, sub: subTone } = STAT_TONES[tone] || STAT_TONES.neutral;
  return <Card className={border}>
    <CardBody>
      <div className="text-ui-caption font-medium text-ink-secondary">{label}</div>
      <div className={`mt-1 text-28 font-medium u-nums ${valueTone}`}>{value ?? "—"}</div>
      {sub && <div className={`mt-1 text-ui-caption ${subTone}`}>{sub}</div>}
    </CardBody>
  </Card>;
}

function DashboardTab({ token }) {
  const { data, loading, error, reload } = useFetch(`${API}/dashboard`, token);
  const { data: nitrogenData } = useFetch(`${API}/nitrogen-status`, token);
  if (error) return <ErrorState onRetry={reload} className="min-h-20">Couldn't load the dashboard — {error}</ErrorState>;
  if (loading || !data) return <ActionFeedback className="min-h-20">Loading dashboard…</ActionFeedback>;
  const blackoutActive = nitrogenData?.activeBlackoutCount > 0;
  return <div className="space-y-5">
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
      <StatCard label="YTD Applications" value={data.ytdApplications} />
      <StatCard label="Unique Products" value={data.uniqueProducts} />
      <StatCard label="Warnings" value={data.warningCount} tone={data.warningCount > 0 ? "warn" : "neutral"} />
      <StatCard label="Licensed Techs" value={data.licensedTechs}
        sub={data.expiringLicenses > 0 ? `${data.expiringLicenses} expiring soon` : "All current"}
        tone={data.expiringLicenses > 0 ? "warn" : "neutral"} />
      <StatCard label="Restricted Use Apps" value={data.restrictedUseApps} />
    </div>
    <Card className={blackoutActive ? "border-alert-fg" : undefined}>
      <CardHeader><CardTitle className={blackoutActive ? "text-alert-fg" : undefined}>
        {blackoutActive ? "Nitrogen Blackout Active" : "No Active Nitrogen Blackout"}
      </CardTitle></CardHeader>
      <CardBody className="space-y-1 text-ui-body text-ink-secondary">
        {nitrogenData?.blackoutPeriods?.map((blackout, index) => <div key={index} className="u-nums">
          {titleCaseCounty(blackout.jurisdiction)}: {fmtDay(blackout.start)} to {fmtDay(blackout.end)}
        </div>)}
      </CardBody>
    </Card>
    <Card>
      <CardHeader><CardTitle>Recent Applications</CardTitle></CardHeader>
      <CardBody className="p-0"><Table layout="records">
        <THead><TR><TH scope="col">Date</TH><TH scope="col">Product</TH><TH scope="col">Customer</TH><TH scope="col">Technician</TH></TR></THead>
        <TBody>
          {data.recentApplications?.map((application) => <TR key={application.id}>
            <TD className="font-medium text-zinc-900 u-nums">{fmtDay(application.date)}</TD>
            <TD data-label="Product">{application.product || "—"}</TD>
            <TD data-label="Customer">{application.customer || "—"}</TD>
            <TD data-label="Technician">{application.tech || "—"}</TD>
          </TR>)}
          {!data.recentApplications?.length && <TR><TD colSpan={4} className="py-8 text-center text-ink-secondary">No applications recorded yet</TD></TR>}
        </TBody>
      </Table></CardBody>
    </Card>
  </div>;
}

function limitSeverityTone(severity) {
  if (!severity) return "neutral";
  return severity === "hard_block" ? "alert" : "warn";
}

function ApplicationLogTab({ token }) {
  const [filters, setFilters] = useState({ startDate: "", endDate: "", productName: "", page: 0 });
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState("");
  const exportInFlight = useRef(false);
  const qs = new URLSearchParams({
    ...(filters.startDate && { startDate: filters.startDate }),
    ...(filters.endDate && { endDate: filters.endDate }),
    ...(filters.productName && { productName: filters.productName }),
    limit: String(APPLICATION_PAGE_SIZE), offset: String(filters.page * APPLICATION_PAGE_SIZE),
  }).toString();
  const { data, loading, error, reload } = useFetch(`${API}/applications?${qs}`, token, [qs]);
  const exportCSV = async () => {
    if (exportInFlight.current) return;
    exportInFlight.current = true;
    setExporting(true);
    setExportError("");
    try {
      const params = new URLSearchParams({
        ...(filters.startDate && { startDate: filters.startDate }),
        ...(filters.endDate && { endDate: filters.endDate }),
      }).toString();
      const response = await fetch(`${API}/report/export?${params}`, {
        headers: headers(token),
      });
      if (!response.ok) throw new Error(`Export failed (HTTP ${response.status}). Please try again.`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "dacs-report.csv";
      try { anchor.click(); } finally { URL.revokeObjectURL(url); }
    } catch (requestError) {
      setExportError(requestError.message || "Export failed. Please try again.");
    } finally {
      exportInFlight.current = false;
      setExporting(false);
    }
  };
  return <div className="space-y-4">
    <Card><CardBody className="grid gap-3 md:grid-cols-2 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(220px,1.5fr)_auto] xl:items-end">
      <Field label="Start date"><Input type="date" value={filters.startDate} onChange={(event) => setFilters((current) => ({ ...current, startDate: event.target.value, page: 0 }))} /></Field>
      <Field label="End date"><Input type="date" value={filters.endDate} onChange={(event) => setFilters((current) => ({ ...current, endDate: event.target.value, page: 0 }))} /></Field>
      <Field label="Product name"><Input placeholder="Product name…" value={filters.productName} onChange={(event) => setFilters((current) => ({ ...current, productName: event.target.value, page: 0 }))} /></Field>
      <Button onClick={exportCSV} loading={exporting}>Export for DACS</Button>
    </CardBody></Card>
    {exportError && <ActionFeedback error>{exportError}</ActionFeedback>}
    {error ? <ErrorState onRetry={reload}>Couldn't load applications — {error}</ErrorState> : loading ? <ActionFeedback className="min-h-16">Loading…</ActionFeedback> : <>
      <Card><CardBody className="p-0"><Table className="min-w-[900px]">
        <THead><TR>{["Date", "Product", "Active Ingredient", "EPA Reg #", "Rate", "Customer", "Tech", "Method"].map((heading) => <TH key={heading} scope="col">{heading}</TH>)}</TR></THead>
        <TBody>
          {data?.applications?.map((application) => <TR key={application.id}>
            <TD className="whitespace-nowrap u-nums">{application.applicationDate}</TD>
            <TD className="font-medium text-zinc-900">{application.productName}</TD>
            <TD className="text-ink-secondary">{application.activeIngredient || "—"}</TD>
            <TD className="text-ink-secondary u-nums">{application.epaRegNumber || "—"}</TD>
            <TD className="u-nums">{application.applicationRate ? `${application.applicationRate} ${application.rateUnit || ""}` : "—"}</TD>
            <TD>{application.customerName || "—"}</TD><TD>{application.techName || "—"}</TD>
            <TD className="text-ink-secondary">{application.applicationMethod || "—"}</TD>
          </TR>)}
          {!data?.applications?.length && <TR><TD colSpan={8} className="py-8 text-center text-ink-secondary">No applications found</TD></TR>}
        </TBody>
      </Table></CardBody></Card>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-ui-caption text-ink-secondary u-nums">{data?.total || 0} total records</span>
        <div className="ui-record-actions">
          <Button variant="secondary" disabled={filters.page === 0} onClick={() => setFilters((current) => ({ ...current, page: current.page - 1 }))}>Prev</Button>
          <Button variant="secondary" disabled={(data?.applications?.length || 0) < APPLICATION_PAGE_SIZE} onClick={() => setFilters((current) => ({ ...current, page: current.page + 1 }))}>Next</Button>
        </div>
      </div>
    </>}
  </div>;
}

// Same class as the severity badge: main painted exceeded / blackout_active /
// expired red and warning / expiring_soon amber, so collapsing all five into
// alert put reserved red on two warning states.
const ALERT_STATUSES = ["exceeded", "blackout_active", "expired"];
const WARN_STATUSES = ["warning", "expiring_soon"];
function statusTone(status) {
  if (ALERT_STATUSES.includes(status)) return "alert";
  return WARN_STATUSES.includes(status) ? "warn" : "neutral";
}
function StatusBadge({ status }) {
  return <Badge tone={statusTone(status)}>{status?.replace(/_/g, " ")}</Badge>;
}

function ProductLimitsTab({ token }) {
  const [customerId, setCustomerId] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const { data: nitrogenData } = useFetch(`${API}/nitrogen-status`, token);
  const lookup = async () => {
    if (!customerId) return;
    setLoading(true);
    try {
      const response = await fetch(`${API}/product-limits?customer_id=${customerId}`, {
        headers: headers(token),
      });
      setResult(await response.json());
    } catch (requestError) { console.error(requestError); }
    setLoading(false);
  };
  return <div className="space-y-6">
    <Card><CardBody className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <Field label="Customer ID" className="w-full max-w-md"><Input placeholder="Customer ID…" value={customerId} onChange={(event) => setCustomerId(event.target.value)} /></Field>
      <Button onClick={lookup}>Check Limits</Button>
    </CardBody></Card>
    {loading && <ActionFeedback>Checking…</ActionFeedback>}
    {result?.limits && <Card>
      <CardHeader><CardTitle>{result.customerName}</CardTitle></CardHeader>
      <CardBody className="p-0"><Table layout="records">
        <THead><TR>{["Type", "Limit", "Current", "Status", "Severity", "Description"].map((heading) => <TH key={heading} scope="col">{heading}</TH>)}</TR></THead>
        <TBody>{result.limits.map((limit, index) => <TR key={index}>
          <TD className="font-medium text-zinc-900">{limit.limitType?.replace(/_/g, " ")}</TD>
          <TD data-label="Limit" nums>{limit.limitValue}</TD><TD data-label="Current" nums>{limit.currentUsage}</TD>
          <TD data-label="Status"><StatusBadge status={limit.status} /></TD>
          {/* Only hard_block is a genuine alert. compliance.js paints everything
              else amber, and the truthiness check was giving an informational
              rule the reserved red treatment. */}
          <TD data-label="Severity"><Badge tone={limitSeverityTone(limit.severity)}>{limit.severity}</Badge></TD>
          <TD data-label="Description" className="text-ink-secondary">{limit.description}</TD>
        </TR>)}</TBody>
      </Table></CardBody>
    </Card>}
    <Card>
      <CardHeader><CardTitle>Nitrogen Status — All Lawn Customers</CardTitle></CardHeader>
      <CardBody className={nitrogenData?.customers?.length ? "p-0" : undefined}>
        {nitrogenData?.customers?.length ? <Table layout="records">
          <THead><TR>{["Customer", "City", "County", "Lawn Type", "N Apps YTD", "Blackout"].map((heading) => <TH key={heading} scope="col">{heading}</TH>)}</TR></THead>
          <TBody>{nitrogenData.customers.map((customer) => <TR key={customer.customerId}>
            <TD className="font-medium text-zinc-900">{customer.customerName}</TD>
            <TD data-label="City" className="text-ink-secondary">{customer.city}</TD>
            <TD data-label="County" className="text-ink-secondary">{titleCaseCounty(customer.county)}</TD>
            <TD data-label="Lawn Type" className="text-ink-secondary">{customer.lawnType}</TD>
            <TD data-label="N Apps YTD" nums>{customer.nitrogenAppsYTD}</TD>
            <TD data-label="Blackout"><Badge tone={customer.blackoutActive ? "alert" : "neutral"}>{customer.blackoutActive ? "Active" : "Clear"}</Badge></TD>
          </TR>)}</TBody>
        </Table> : <p className="text-ui-body text-ink-secondary">No lawn customers found</p>}
      </CardBody>
    </Card>
  </div>;
}

function LicensesTab({ token }) {
  const { data, loading, error, reload } = useFetch(`${API}/licenses`, token);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const savingRef = useRef(false);
  const startEdit = (event, technician) => {
    event.currentTarget.focus({ preventScroll: true });
    setEditing(technician.id);
    setSaveError(null);
    setForm({ fl_applicator_license: technician.license || "", license_expiry: technician.licenseExpiry || "", license_categories: technician.licenseCategories || [] });
  };
  const closeEditor = () => {
    if (!savingRef.current) {
      setEditing(null);
      setSaveError(null);
    }
  };
  const save = async (event) => {
    event.preventDefault();
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(`${API}/licenses/${editing}`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify(form),
    });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      setEditing(null);
      reload();
    } catch (requestError) {
      setSaveError(`Couldn't save the license — ${requestError?.message || "Request failed"}`);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  if (error) return <ErrorState onRetry={reload} className="min-h-20">Couldn't load licenses — {error}</ErrorState>;
  if (loading) return <ActionFeedback className="min-h-20">Loading…</ActionFeedback>;
  const editingTechnician = data?.technicians?.find((technician) => technician.id === editing);
  return <>
    <Card><CardBody className="p-0"><Table layout="records">
      <THead><TR>{["Technician", "License #", "Expiry", "Categories", "Status", ""].map((heading) => <TH key={heading} scope="col">{heading}</TH>)}</TR></THead>
      <TBody>{data?.technicians?.map((technician) => <TR key={technician.id}>
        <TD className="font-medium text-zinc-900">{technician.name}</TD>
        <TD data-label="License #" className="u-nums">{technician.license || "—"}</TD>
        <TD data-label="Expiry" className="u-nums">{technician.licenseExpiry || "—"}</TD>
        <TD data-label="Categories" className="text-ink-secondary">{Array.isArray(technician.licenseCategories) ? technician.licenseCategories.join(", ") : "—"}</TD>
        <TD data-label="Status"><StatusBadge status={technician.licenseStatus} /></TD>
        <TD className="text-right"><Button variant="secondary" onClick={(event) => startEdit(event, technician)}>Edit</Button></TD>
      </TR>)}</TBody>
    </Table></CardBody></Card>
    <Dialog open={editing !== null} onClose={closeEditor} size="sm">
      <DialogHeader><DialogTitle>Edit license</DialogTitle></DialogHeader>
      <form onSubmit={save} className="flex min-h-0 flex-col">
        <DialogBody className="space-y-4">
          <p className="text-ui-body font-medium text-zinc-900">{editingTechnician?.name}</p>
          <Field label="License #"><Input value={form.fl_applicator_license || ""} onChange={(event) => setForm((current) => ({ ...current, fl_applicator_license: event.target.value }))} /></Field>
          <Field label="Expiry"><Input type="date" value={form.license_expiry || ""} onChange={(event) => setForm((current) => ({ ...current, license_expiry: event.target.value }))} /></Field>
          {saveError && <ActionFeedback error>{saveError}</ActionFeedback>}
        </DialogBody>
        <DialogFooter><Button variant="secondary" onClick={closeEditor} disabled={saving}>Cancel</Button><Button type="submit" loading={saving}>Save</Button></DialogFooter>
      </form>
    </Dialog>
  </>;
}

const COMPLIANCE_TABS = [
  { key: "dashboard", label: "Dashboard", Icon: Gauge },
  { key: "log", label: "Application Log", Icon: ClipboardList },
  { key: "limits", label: "Product Limits", Icon: ShieldCheck },
  { key: "licenses", label: "Licenses", Icon: FileText },
  { key: "credentials", label: "Credentials", Icon: BadgeCheck, adminOnly: true },
];

export default function CompliancePage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const isAdmin = getAdminUser()?.role === "admin";
  const visibleTabs = COMPLIANCE_TABS.filter(({ adminOnly }) => !adminOnly || isAdmin);
  const visibleTabKeys = new Set(visibleTabs.map(({ key }) => key));
  const requestedTab = searchParams.get("tab");
  const tab = visibleTabKeys.has(requestedTab) ? requestedTab : "dashboard";
  const token = getAdminAuthToken();
  useRenderedTabBeacon("/admin/compliance", tab, [searchParams]);
  const selectTab = (nextTab) => {
    if (nextTab === tab) return;
    const nextParams = new URLSearchParams(searchParams);
    if (nextTab === "dashboard") nextParams.delete("tab"); else nextParams.set("tab", nextTab);
    setSearchParams(nextParams);
  };
  return <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
    <AdminCommandHeader variant="workspace" title="Compliance" icon={ShieldCheck} sections={visibleTabs}
      activeKey={tab} onSectionChange={selectTab} ariaLabel="Compliance section"
      navGridClassName={isAdmin ? "grid-cols-2 lg:grid-cols-5" : "grid-cols-2 lg:grid-cols-4"} />
    {tab === "dashboard" && <DashboardTab token={token} />}
    {tab === "log" && <ApplicationLogTab token={token} />}
    {tab === "limits" && <ProductLimitsTab token={token} />}
    {tab === "licenses" && <LicensesTab token={token} />}
    {tab === "credentials" && isAdmin && <CredentialsPage embedded />}
  </UiSurface>;
}
