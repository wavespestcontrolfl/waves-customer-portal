import React, { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { BadgeCheck, ClipboardList, FileText, Gauge, ShieldCheck } from "lucide-react";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import {
  ActionFeedback, Badge, Button, Card, CardBody, CardHeader, CardTitle,
  Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle, Field, Input, Select, Textarea,
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
  const { data: nitrogenData, loading: nitrogenLoading, error: nitrogenError, reload: reloadNitrogen } = useFetch(`${API}/nitrogen-status`, token);
  if (error) return <ErrorState onRetry={reload} className="min-h-20">Couldn't load the dashboard — {error}</ErrorState>;
  if (loading || !data) return <ActionFeedback className="min-h-20">Loading dashboard…</ActionFeedback>;
  const blackoutActive = nitrogenData?.activeBlackoutCount > 0;
  // A failed or pending read is unknown, never "no blackout".
  const nitrogenTitle = nitrogenError ? "Nitrogen Blackout Status Unknown"
    : nitrogenLoading || !nitrogenData ? "Checking Nitrogen Blackout…"
      : blackoutActive ? "Nitrogen Blackout Active" : "No Active Nitrogen Blackout";
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
        {nitrogenTitle}
      </CardTitle></CardHeader>
      <CardBody className="space-y-1 text-ui-body text-ink-secondary">
        {nitrogenError && <ErrorState onRetry={reloadNitrogen}>Couldn't load nitrogen status — {nitrogenError}</ErrorState>}
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
const ALERT_STATUSES = ["exceeded", "blackout_active", "expired", "overdue"];
const WARN_STATUSES = ["warning", "expiring_soon", "due_soon"];
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
  const [lookupError, setLookupError] = useState(null);
  // Only the latest Check Limits may land: an older, slower lookup must not
  // show another customer's limits as current.
  const lookupSeq = useRef(0);
  const { data: nitrogenData, loading: nitrogenLoading, error: nitrogenError, reload: reloadNitrogen } = useFetch(`${API}/nitrogen-status`, token);
  const lookup = async () => {
    if (!customerId) return;
    const seq = ++lookupSeq.current;
    setLoading(true);
    setResult(null);
    setLookupError(null);
    try {
      const response = await fetch(`${API}/product-limits?customer_id=${customerId}`, {
        headers: headers(token),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      if (seq === lookupSeq.current) setResult(body);
    } catch (requestError) {
      console.error(requestError);
      if (seq === lookupSeq.current) setLookupError(`Couldn't check limits for customer ${customerId} — ${requestError.message || "request failed"}`);
    }
    if (seq === lookupSeq.current) setLoading(false);
  };
  return <div className="space-y-6">
    <Card><CardBody className="flex flex-col gap-3 sm:flex-row sm:items-end">
      <Field label="Customer ID" className="w-full max-w-md"><Input placeholder="Customer ID…" value={customerId} onChange={(event) => setCustomerId(event.target.value)} /></Field>
      <Button onClick={lookup}>Check Limits</Button>
    </CardBody></Card>
    {loading && <ActionFeedback>Checking…</ActionFeedback>}
    {lookupError && <ErrorState onRetry={lookup}>{lookupError}</ErrorState>}
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
        {nitrogenError ? <ErrorState onRetry={reloadNitrogen}>Couldn't load nitrogen status — {nitrogenError}</ErrorState>
          : nitrogenLoading && !nitrogenData ? <ActionFeedback>Loading lawn customers…</ActionFeedback>
            : nitrogenData?.customers?.length ? <Table layout="records">
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

// ID card and training (GATE_TECH_TRAINING_DATES, dark). The server sends these blocks only for a technician with a hire date
// and only with the gate on; without them the Licenses tab is unchanged. F.S. 482.091 and rule 5E-14.1421.
const TRAINING_CATEGORIES = ["GHP", "L&O", "Termite/WDO", "Fumigation"];
const EMPTY_TRAINING_DAY = { training_date: "", hours: "8", category: "GHP", topics: "", trainer_name: "", materials: "" };
const escapeHtml = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function TrainingCell({ technician }) {
  const { idCard, training, classroom, renewalTraining } = technician;
  if (!idCard) return <span className="text-ink-secondary">—</span>;
  const line = "flex flex-wrap items-center gap-x-2 gap-y-1";
  return <div className="space-y-1.5 text-ui-body">
    <div className={line}><span className="font-medium text-zinc-900">ID card</span>
      <span className="u-nums text-ink-secondary">{idCard.appliedOn ? `applied ${fmtDay(idCard.appliedOn)}` : `apply by ${fmtDay(idCard.applicationDueOn)}`}{idCard.issuedOn ? `, issued ${fmtDay(idCard.issuedOn)}` : ""}</span>
      {idCard.status && <StatusBadge status={idCard.status} />}</div>
    <div className={line}><span className="font-medium text-zinc-900">Training</span>
      <span className="u-nums text-ink-secondary">{training.days} {training.days === 1 ? "day" : "days"}, {training.hours} h</span>
      <Badge tone={training.fiveDaysDone ? "neutral" : "warn"}>{training.fiveDaysDone ? "5-day check met" : "5-day check open"}</Badge></div>
    <div className={line}><span className="font-medium text-zinc-900">Classroom</span>
      <span className="u-nums text-ink-secondary">{classroom.doneOn ? `done ${fmtDay(classroom.doneOn)}` : classroom.dueOn ? `due ${fmtDay(classroom.dueOn)}` : "starts when the card is issued"}</span>
      {classroom.status && <StatusBadge status={classroom.status} />}</div>
    {renewalTraining.dueBy && <div className={line}><span className="font-medium text-zinc-900">Renewal training</span>
      <span className="u-nums text-ink-secondary">by {fmtDay(renewalTraining.dueBy)}</span>
      {renewalTraining.status && <StatusBadge status={renewalTraining.status} />}</div>}
  </div>;
}

function TrainingLogDialog({ token, technician, onClose }) {
  const url = `${API}/licenses/${technician.id}/training-days`;
  const { data, loading, error, reload } = useFetch(url, token);
  const [form, setForm] = useState(EMPTY_TRAINING_DAY);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const set = (field) => (event) => setForm((current) => ({ ...current, [field]: event.target.value }));
  const send = async (target, init, failure) => {
    if (savingRef.current) return false;
    savingRef.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(target, { headers: headers(token), ...init });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body?.error || `HTTP ${response.status}`);
      }
      dirtyRef.current = true;
      reload();
      return true;
    } catch (requestError) {
      setSaveError(`${failure} — ${requestError?.message || "Request failed"}`);
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const addDay = async (event) => {
    event.preventDefault();
    const added = await send(url, { method: "POST", body: JSON.stringify({ ...form, hours: Number(form.hours), materials: form.materials || null }) }, "Couldn't add the day");
    if (added) setForm((current) => ({ ...EMPTY_TRAINING_DAY, category: current.category, trainer_name: current.trainer_name }));
  };
  const removeDay = (day) => send(`${url}/${day.id}`, { method: "DELETE" }, "Couldn't remove the day");
  const summary = data?.summary;
  // The license list reloads when the log closes (not on each change), so the open dialog is not unmounted by its loading state.
  const close = () => { if (!savingRef.current) onClose(dirtyRef.current); };
  return <Dialog open onClose={close} size="lg">
    <DialogHeader><DialogTitle>Training log</DialogTitle></DialogHeader>
    <DialogBody className="space-y-4">
      <p className="text-ui-body font-medium text-zinc-900">{technician.name}</p>
      {error ? <ErrorState onRetry={reload}>Couldn't load the training log — {error}</ErrorState>
        : loading || !data ? <ActionFeedback>Loading…</ActionFeedback>
          : <>
            <p className="text-ui-body text-ink-secondary">{summary.days} {summary.days === 1 ? "day" : "days"}, {summary.hours} of 40 hours. {summary.fiveDaysDone ? "5 days in one category are logged." : "5 days in one category are not logged yet."}</p>
            {data.days.length > 0 && <Table layout="records">
              <THead><TR>{["Date", "Hours", "Category", "Topics", "Trainer", ""].map((heading) => <TH key={heading} scope="col">{heading}</TH>)}</TR></THead>
              <TBody>{data.days.map((day) => <TR key={day.id}>
                <TD className="u-nums">{fmtDay(day.trainingDate)}</TD>
                <TD data-label="Hours" nums>{day.hours}</TD>
                <TD data-label="Category">{day.category}</TD>
                <TD data-label="Topics" className="text-ink-secondary">{day.topics}{day.materials ? ` (materials: ${day.materials})` : ""}</TD>
                <TD data-label="Trainer" className="text-ink-secondary">{day.trainerName}</TD>
                <TD className="text-right"><Button variant="secondary" disabled={saving} onClick={() => removeDay(day)}>Remove</Button></TD>
              </TR>)}</TBody>
            </Table>}
          </>}
      <form onSubmit={addDay} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Date" required><Input type="date" value={form.training_date} onChange={set("training_date")} required /></Field>
          <Field label="Hours" required><Input type="number" step="0.25" min="0.25" max="16" value={form.hours} onChange={set("hours")} required /></Field>
          <Field label="Category" required><Select value={form.category} onChange={set("category")}>{TRAINING_CATEGORIES.map((category) => <option key={category} value={category}>{category}</option>)}</Select></Field>
        </div>
        <Field label="Topics covered" required><Textarea rows={2} value={form.topics} onChange={set("topics")} required /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Trainer (certified operator)" required><Input value={form.trainer_name} onChange={set("trainer_name")} required /></Field>
          <Field label="Materials used"><Input value={form.materials} onChange={set("materials")} /></Field>
        </div>
        {saveError && <ActionFeedback error>{saveError}</ActionFeedback>}
        <Button type="submit" loading={saving}>Add day</Button>
      </form>
    </DialogBody>
    <DialogFooter><Button variant="secondary" onClick={close} disabled={saving}>Close</Button></DialogFooter>
  </Dialog>;
}

// The 40-hour record as a printable page (rule 5E-14.1421: keep it 2 years). The note is typed here and is not saved.
function recordHtml(record, note) {
  const rows = record.days.map((day) => `<tr><td>${escapeHtml(fmtDay(day.trainingDate))}</td><td>${escapeHtml(day.hours)}</td><td>${escapeHtml(day.category)}</td><td>${escapeHtml(day.topics)}</td><td>${escapeHtml(day.trainerName)}</td><td>${escapeHtml(day.materials || "")}</td></tr>`).join("");
  const signatures = record.signatures.map((block) => `<h2>${escapeHtml(block.role)}</h2>${block.lines.map((label) => `<p class="sig">${escapeHtml(label)}: ______________________________</p>`).join("")}`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(record.heading)}</title><style>
body{font:14px/1.45 system-ui,sans-serif;color:#111;margin:32px}h1{font-size:20px;margin:0 0 4px}h2{font-size:15px;margin:24px 0 8px}p{margin:4px 0}
table{border-collapse:collapse;width:100%;margin-top:12px}th,td{border:1px solid #888;padding:6px 8px;text-align:left;vertical-align:top}.sig{margin:14px 0}
</style></head><body><h1>${escapeHtml(record.heading)}</h1><p>${escapeHtml(record.authority)}. ${escapeHtml(record.retention)}</p>
<p>Employee: <strong>${escapeHtml(record.technician.name)}</strong>${record.technician.hireDate ? `, hired ${escapeHtml(fmtDay(record.technician.hireDate))}` : ""}</p>
<table><thead><tr><th>Date</th><th>Hours</th><th>Category</th><th>Topics covered</th><th>Trainer</th><th>Materials</th></tr></thead><tbody>${rows}</tbody></table>
<p><strong>Total: ${escapeHtml(record.totals.days)} days, ${escapeHtml(record.totals.hours)} hours.</strong></p>
${note ? `<h2>Course syllabus and notes</h2><p>${escapeHtml(note).replace(/\n/g, "<br>")}</p>` : ""}${signatures}</body></html>`;
}

function TrainingRecordDialog({ token, technician, onClose }) {
  const { data, loading, error, reload } = useFetch(`${API}/licenses/${technician.id}/training-record`, token);
  const [note, setNote] = useState("");
  const print = () => {
    const win = window.open("", "_blank");
    if (!win) return;
    win.document.open();
    win.document.write(recordHtml(data, note));
    win.document.close();
    win.focus();
    win.print();
  };
  return <Dialog open onClose={onClose} size="lg">
    <DialogHeader><DialogTitle>Print record</DialogTitle></DialogHeader>
    <DialogBody className="space-y-4">
      {error ? <ErrorState onRetry={reload}>Couldn't load the record — {error}</ErrorState>
        : loading || !data ? <ActionFeedback>Loading…</ActionFeedback>
          : <>
            <div>
              <p className="text-ui-body font-medium text-zinc-900">{data.heading}</p>
              <p className="text-ui-body text-ink-secondary">{data.authority}. {data.retention}</p>
              <p className="text-ui-body text-ink-secondary">{data.technician.name}: {data.totals.days} {data.totals.days === 1 ? "day" : "days"}, {data.totals.hours} of 40 hours.</p>
            </div>
            <Field label="Course syllabus and notes (printed, not saved)" help="Add the written course syllabus here when the daily topics do not cover it."><Textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></Field>
          </>}
    </DialogBody>
    <DialogFooter><Button variant="secondary" onClick={onClose}>Close</Button><Button onClick={print} disabled={!data}>Print</Button></DialogFooter>
  </Dialog>;
}

function LicensesTab({ token }) {
  const { data, loading, error, reload } = useFetch(`${API}/licenses`, token);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [logFor, setLogFor] = useState(null);
  const [recordFor, setRecordFor] = useState(null);
  const savingRef = useRef(false);
  const startEdit = (event, technician) => {
    event.currentTarget.focus({ preventScroll: true });
    setEditing(technician.id);
    setSaveError(null);
    setForm({
      fl_applicator_license: technician.license || "", license_expiry: technician.licenseExpiry || "", license_categories: technician.licenseCategories || [],
      ...(technician.idCard ? {
        id_card_applied_on: technician.idCard.appliedOn || "",
        id_card_issued_on: technician.idCard.issuedOn || "",
        classroom_hours_done_on: technician.classroom.doneOn || "",
        renewal_training_done_on: technician.renewalTraining.doneOn || "",
      } : {}),
    });
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
  const trainingOn = Boolean(data?.technicians?.some((technician) => technician.idCard));
  const dateField = (label, field) => <Field label={label}><Input type="date" value={form[field] || ""} onChange={(event) => setForm((current) => ({ ...current, [field]: event.target.value }))} /></Field>;
  return <>
    <Card><CardBody className="p-0"><Table layout="records">
      <THead><TR>{["Technician", "License #", "Expiry", "Categories", "Status", ...(trainingOn ? ["ID card and training"] : []), ""].map((heading) => <TH key={heading} scope="col">{heading}</TH>)}</TR></THead>
      <TBody>{data?.technicians?.map((technician) => <TR key={technician.id}>
        <TD className="font-medium text-zinc-900">{technician.name}</TD>
        <TD data-label="License #" className="u-nums">{technician.license || "—"}</TD>
        <TD data-label="Expiry" className="u-nums">{fmtDay(technician.licenseExpiry) || "—"}</TD>
        <TD data-label="Categories" className="text-ink-secondary">{Array.isArray(technician.licenseCategories) ? technician.licenseCategories.join(", ") : "—"}</TD>
        <TD data-label="Status"><StatusBadge status={technician.licenseStatus} /></TD>
        {trainingOn && <TD data-label="ID card and training"><TrainingCell technician={technician} /></TD>}
        <TD className="text-right"><div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={(event) => startEdit(event, technician)}>Edit</Button>
          {technician.idCard && <Button variant="secondary" onClick={() => setLogFor(technician)}>Training log</Button>}
          {technician.idCard && <Button variant="secondary" onClick={() => setRecordFor(technician)}>Print record</Button>}
        </div></TD>
      </TR>)}</TBody>
    </Table></CardBody></Card>
    <Dialog open={editing !== null} onClose={closeEditor} size="sm">
      <DialogHeader><DialogTitle>Edit license</DialogTitle></DialogHeader>
      <form onSubmit={save} className="flex min-h-0 flex-col">
        <DialogBody className="space-y-4">
          <p className="text-ui-body font-medium text-zinc-900">{editingTechnician?.name}</p>
          <Field label="License #"><Input value={form.fl_applicator_license || ""} onChange={(event) => setForm((current) => ({ ...current, fl_applicator_license: event.target.value }))} /></Field>
          <Field label="Expiry"><Input type="date" value={form.license_expiry || ""} onChange={(event) => setForm((current) => ({ ...current, license_expiry: event.target.value }))} /></Field>
          {editingTechnician?.idCard && <>
            {dateField("ID card applied", "id_card_applied_on")}
            {dateField("ID card issued (date printed on the card)", "id_card_issued_on")}
            {dateField("4 classroom hours done", "classroom_hours_done_on")}
            {dateField("Renewal training done (2 hours)", "renewal_training_done_on")}
          </>}
          {saveError && <ActionFeedback error>{saveError}</ActionFeedback>}
        </DialogBody>
        <DialogFooter><Button variant="secondary" onClick={closeEditor} disabled={saving}>Cancel</Button><Button type="submit" loading={saving}>Save</Button></DialogFooter>
      </form>
    </Dialog>
    {logFor && <TrainingLogDialog token={token} technician={logFor} onClose={(changed) => { setLogFor(null); if (changed) reload(); }} />}
    {recordFor && <TrainingRecordDialog token={token} technician={recordFor} onClose={() => setRecordFor(null)} />}
  </>;
}

const COMPLIANCE_TABS = [
  { key: "dashboard", label: "Dashboard", Icon: Gauge },
  { key: "log", label: "Applications", Icon: ClipboardList },
  { key: "limits", label: "Limits", Icon: ShieldCheck },
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
