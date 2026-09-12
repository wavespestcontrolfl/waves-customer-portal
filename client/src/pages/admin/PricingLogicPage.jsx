import React, { useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Calculator, ClipboardList, Download, Gauge, Percent, RefreshCw, Scale, SlidersHorizontal } from "lucide-react";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import PricingLogicPanel from "../../components/admin/PricingLogicPanel";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import PricingRealityCheckPage from "./PricingRealityCheckPage";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  CardTitle,
  Field,
  Input,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  UiSurface,
} from "../../components/ui";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const PRICING_SECTIONS = [
  { key: "margins", label: "Margins", Icon: Percent },
  { key: "calibration", label: "Calibration", Icon: Gauge },
  { key: "specs", label: "Service specs", Icon: ClipboardList },
  { key: "logic", label: "Logic rules", Icon: SlidersHorizontal },
  { key: "reality", label: "Audit", Icon: Scale },
];

function sectionFromSearchParams(searchParams) {
  const section = searchParams.get("section");
  return PRICING_SECTIONS.some((item) => item.key === section) ? section : "margins";
}

function scrollToPricingSection(key) {
  const scroll = () => document.getElementById(`pricing-${key}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(scroll);
  else scroll();
}

const af = (p, o = {}) =>
  fetch(`${API_BASE}${p}`, {
    ...o,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...o.headers,
    },
  }).then(async (r) => {
    // A 401/429/500 JSON body is not data — throw so the callers' catch
    // blocks render their error state instead of a blank table.
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(body.error || `HTTP ${r.status}`);
    return body;
  });

function adminRawFetch(p, o = {}) {
  return fetch(`${API_BASE}${p}`, {
    ...o,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      ...o.headers,
    },
  });
}

function isoDateOffset(daysBack) {
  const date = new Date();
  date.setDate(date.getDate() - daysBack);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

const formatMinutes = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? `${number > 0 ? "+" : ""}${number.toFixed(1)} min` : "0.0 min";
};

export function MarginCalculator() {
  const [lotSqFt, setLotSqFt] = useState(10000);
  const [homeSqFt, setHomeSqFt] = useState(2000);
  const [lawnSqFt, setLawnSqFt] = useState(5000);
  const [bedArea, setBedArea] = useState(1500);
  const [tier, setTier] = useState("gold");
  const [margins, setMargins] = useState(null);
  const [loading, setLoading] = useState(false);

  const fetchMargins = async () => {
    setLoading(true);
    try {
      const data = await af("/admin/pricing-config/margin-check", {
        method: "POST",
        body: JSON.stringify({
          lotSqFt,
          homeSqFt,
          lawnSqFt,
          bedArea,
          waveguardTier: tier,
        }),
      });
      setMargins(data);
    } catch (error) {
      // af() throws the server's message on a non-2xx; discarding it made an
      // expired session or a 500 look like "no results" with no explanation.
      setMargins({ error: error.message || "Margin check failed" });
    }
    setLoading(false);
  };
  useEffect(() => { fetchMargins(); }, []);

  const costSourceLabel = (source) => source === "inventory_cost_per_unit" || source === "inventory_best_price_unit_size" ? "Inventory" : "Fallback";
  // A fallback cost is an estimate, not a measured one — main flagged it amber.
  const costSourceTone = (source) => costSourceLabel(source) === "Fallback" ? "warn" : "neutral";
  // Three bands, three tones, as on main: healthy green, the 0.35-0.45
  // "Acceptable" band amber so a drifting margin is still visible, below-floor
  // red. Collapsing the middle band to neutral removed the only warning.
  const marginTone = (margin) => margin < 0.35 ? "alert" : margin >= 0.45 ? "strong" : "warn";
  const marginLabel = (margin) => margin >= 0.45 ? "Healthy" : margin >= 0.35 ? "Acceptable" : "Below floor";

  return (
    // EstimatesPageV2.jsx:4192 renders this export directly on its Pricing tab
    // and provides no UiSurface, so the density boundary belongs here rather
    // than only around PricingLogicPage's returns — otherwise these fields drop
    // to the legacy 13px on that caller.
    <UiSurface as={Card} density="comfortable" className="mb-5">
      <CardHeader className="flex flex-wrap items-start justify-between gap-3"><CardTitle className="text-16">Margin calculator</CardTitle><Button onClick={fetchMargins} loading={loading}>{loading ? "Calculating..." : "Calculate"}</Button></CardHeader>
      <CardBody className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Lot SqFt"><Input type="number" value={lotSqFt} onChange={(event) => setLotSqFt(Number(event.target.value))} className="u-nums" /></Field>
          <Field label="Home SqFt"><Input type="number" value={homeSqFt} onChange={(event) => setHomeSqFt(Number(event.target.value))} className="u-nums" /></Field>
          <Field label="Lawn SqFt"><Input type="number" value={lawnSqFt} onChange={(event) => setLawnSqFt(Number(event.target.value))} className="u-nums" /></Field>
          <Field label="Bed area"><Input type="number" value={bedArea} onChange={(event) => setBedArea(Number(event.target.value))} className="u-nums" /></Field>
          <Field label="WaveGuard"><Select value={tier} onChange={(event) => setTier(event.target.value)}><option value="bronze">Bronze</option><option value="silver">Silver</option><option value="gold">Gold</option><option value="platinum">Platinum</option></Select></Field>
        </div>
        {/* Main painted the mismatch branch amber and the normal status muted;
            one neutral ActionFeedback for both made a tier drift look routine. */}
        {margins?.waveguardTier && <ActionFeedback className={margins.waveguardTierMismatch ? "!text-warn-fg" : undefined}>{margins.waveguardTierMismatch
          ? `Engine priced this bundle as ${margins.waveguardTier.toUpperCase()} (requested ${String(margins.waveguardTierRequested || tier).toUpperCase()}) — tier thresholds are out of line with the engine; margins below are ${margins.waveguardTier.toUpperCase()} margins.`
          : `Margins priced at ${margins.waveguardTier.toUpperCase()} tier discounts.`}</ActionFeedback>}
        {margins?.services && <Table className="min-w-[840px]" aria-label="Service margins"><THead><TR><TH>Service</TH><TH align="right">Annual price</TH><TH align="right">Est. cost</TH><TH>Cost source</TH><TH align="right">After discount</TH><TH align="right">Margin</TH><TH>Status</TH></TR></THead><TBody>{margins.services.map((service) => <TR key={service.service}><TD className="font-medium capitalize">{service.service.replace(/_/g, " ")}</TD><TD align="right" nums>${service.annual?.toLocaleString() || "—"}</TD><TD align="right" nums className="text-ink-secondary">${service.estimatedCost?.toLocaleString() || "—"}</TD><TD><Badge tone={costSourceTone(service.materialCostSource)}>{costSourceLabel(service.materialCostSource)}</Badge>{service.materialPerVisit != null ? <span className="ml-2 text-ui-caption text-ink-secondary u-nums">${Number(service.materialPerVisit).toFixed(2)}/visit</span> : ""}</TD><TD align="right" nums>${service.afterDiscount?.toLocaleString() || "—"}</TD><TD align="right" nums className="font-medium">{service.margin != null ? `${(service.margin * 100).toFixed(1)}%` : "—"}</TD><TD>{service.margin != null && <Badge tone={marginTone(service.margin)}>{marginLabel(service.margin)}</Badge>}</TD></TR>)}</TBody></Table>}
        {margins?.error && <ActionFeedback error>{margins.error}</ActionFeedback>}
      </CardBody>
    </UiSurface>
  );
}

const SPEC_SERVICES = [
  { key: "rodentPlugging", fn: "calculatePluggingPrice", name: "Rodent Plugging", desc: "Entry-point sealing tiered by 1–5 / 6–15 / 16+ pts. $95 standalone, $45 add-on. 65% margin target." },
  { key: "termiteFoam", fn: "calculateFoamPrice", name: "Termite Foam", desc: "Termidor Foam spot treatment per app point + cans (~$30/can). $125 min. 15% bundle discount with liquid barrier." },
  { key: "stingingV2", fn: "calculateStingingPrice", name: "Stinging Insect", desc: "Multiplier stack: nest type × location × urgency / after-hours. Mins: $95 / $125 / $175." },
  { key: "exclusionV2", fn: "calculateExclusionPrice", name: "Exclusion (Full)", desc: "sqft tiers $395 / $595 / $895 / $1,295. Tile roof 1.4×, 2-story 1.3×. multiVisit flag at >4hr." },
  { key: "rodentGuaranteeCombo", fn: "calculateRodentGuaranteeCombo", name: "Rodent Guarantee Combo", desc: "Exclusion + Bait Stations + 12/24-mo guarantee. No bundle discount on the bait component, 15–25% guarantee premium. Min $695 / $995. Bait stations price at the standard footprint bracket (per quarterly application, station allowance by home size) — the post-exclusion modifier was retired 2026-08-29." },
];

function SpecServicesPanel() {
  return (
    <Card><CardHeader className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="text-16">Missing-services pricing spec</CardTitle><p className="mt-1 max-w-3xl text-ui-body text-ink-secondary">These five services are wired into <code className="u-nums">generateEstimate()</code> via the <code className="u-nums">services.&lt;key&gt;</code> input. Spec doc: <code className="u-nums">missing-services-pricing-spec.md</code>.</p></div><Badge tone="strong">Linked to estimator engine</Badge></CardHeader><CardBody className="grid gap-3">{SPEC_SERVICES.map((service) => <div key={service.key} className="grid gap-3 rounded-md border-hairline border-zinc-200 bg-zinc-50 p-3 md:grid-cols-[220px_minmax(0,1fr)]"><div><div className="font-medium text-zinc-900">{service.name}</div><div className="mt-1 text-ui-caption text-ink-secondary u-nums">services.{service.key}</div><div className="text-ui-caption text-ink-secondary u-nums">{service.fn}()</div></div><p className="text-ui-body text-zinc-700">{service.desc}</p></div>)}</CardBody></Card>
  );
}

// Main coloured a sample's miss red at 15+ minutes and amber at 8-14, which is
// how the table is triaged; a single neutral treatment hid the 8-14 band, since
// only the 15+ rows also reach the review queue.
function calibrationDeltaTone(delta) {
  const miss = Math.abs(delta);
  if (miss >= 15) return "text-alert-fg";
  return miss >= 8 ? "text-warn-fg" : undefined;
}

function CalibrationGroup({ title, rows }) {
  return (
    <Card><CardHeader><CardTitle>{title}</CardTitle></CardHeader><CardBody className="divide-y divide-zinc-200">{(rows || []).slice(0, 6).map((row) => <div key={row.key} className="grid grid-cols-[minmax(0,1fr)_50px_80px_80px] gap-2 py-2 text-ui-body"><span className="capitalize">{row.key}</span><span className="text-right text-ink-secondary u-nums">{row.count}</span><span className="text-right u-nums">{formatMinutes(row.avgDelta)}</span><span className="text-right text-ink-secondary u-nums">{formatMinutes(row.avgAbsDelta)}</span></div>)}{(!rows || rows.length === 0) && <p className="text-ink-secondary">No samples yet.</p>}</CardBody></Card>
  );
}

function PestCalibrationPanel() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState("");
  const [startDate, setStartDate] = useState(() => isoDateOffset(90));
  const [endDate, setEndDate] = useState(() => isoDateOffset(0));
  const [limit, setLimit] = useState("150");

  const load = async () => {
    setLoading(true); setError("");
    try {
      const qs = new URLSearchParams({ startDate, endDate, limit });
      setData(
        await af(`/admin/pricing-config/pest-calibration?${qs.toString()}`),
      );
    }
    catch (nextError) { setError(nextError.message || "Failed to load pest calibration"); }
    finally { setLoading(false); }
  };
  const downloadCsv = async () => {
    setDownloading(true); setError("");
    try {
      const qs = new URLSearchParams({ startDate, endDate, limit: "10000", format: "csv" });
      const response = await adminRawFetch(
        `/admin/pricing-config/pest-calibration?${qs.toString()}`,
      );
      if (!response.ok) throw new Error(`CSV export failed (${response.status})`);
      const text = await response.text();
      const url = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      const anchor = document.createElement("a"); anchor.href = url; anchor.download = `pest-production-calibration-${startDate}-to-${endDate}.csv`; document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    } catch (nextError) { setError(nextError.message || "Failed to export pest calibration CSV"); }
    finally { setDownloading(false); }
  };
  useEffect(() => { load(); }, []);

  const summary = data?.summary || {};
  const records = data?.records || [];
  const sampleHealth = data?.sampleHealth || {};
  const reviewQueue = summary.reviewQueue || [];
  const summaryMetrics = [
    { label: "Samples", value: summary.count || 0 },
    // The aggregate stayed amber at every size on main; only an individual 15+
    // minute sample went red, so this must not reuse calibrationDeltaTone().
    { label: "Avg miss", value: formatMinutes(summary.avgDelta || 0), tone: Math.abs(summary.avgDelta || 0) >= 8 ? "text-warn-fg" : undefined },
    { label: "Avg abs miss", value: formatMinutes(summary.avgAbsDelta || 0), tone: (summary.avgAbsDelta || 0) >= 12 ? "text-warn-fg" : undefined },
    { label: "15+ min outliers", value: summary.outlierCount || 0, tone: (summary.outlierCount || 0) > 0 ? "text-alert-fg" : undefined },
  ];
  // A nonzero "missing" count is a sample-quality warning. Main painted the
  // estimate-link and timer gaps amber, but missing diagnostics red — that one
  // is a calibration-data failure, not a warning.
  const missingTone = (count) => (count || 0) > 0 ? "text-warn-fg" : undefined;
  const missingDiagnosticsTone = (count) => (count || 0) > 0 ? "text-alert-fg" : undefined;
  const healthMetrics = [
    { label: "Jobs synced", value: sampleHealth.jobsEvaluated || 0 }, { label: "Materialized", value: sampleHealth.materializedCount || 0 },
    { label: "Fallback matched", value: sampleHealth.fallbackMatchedCount || 0 },
    { label: "No est. link", value: sampleHealth.missingEstimateLinkCount || 0, tone: missingTone(sampleHealth.missingEstimateLinkCount) },
    { label: "No timer", value: sampleHealth.missingTimerCount || 0, tone: missingTone(sampleHealth.missingTimerCount) },
    { label: "No diagnostics", value: sampleHealth.missingDiagnosticsCount || 0, tone: missingDiagnosticsTone(sampleHealth.missingDiagnosticsCount) },
  ];

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-3"><div><CardTitle className="text-16">Pest production calibration</CardTitle><p className="mt-1 text-ui-body text-ink-secondary">Shadow estimator minutes compared with completed job timers from accepted estimates.</p></div><div className="grid items-end gap-2 sm:grid-cols-3 lg:grid-cols-[150px_150px_110px_auto_auto]"><Field label="Start"><Input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} /></Field><Field label="End"><Input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} /></Field><Field label="Rows"><Select value={limit} onChange={(event) => setLimit(event.target.value)}><option value="50">50</option><option value="150">150</option><option value="500">500</option></Select></Field><Button variant="secondary" onClick={load} loading={loading}><RefreshCw size={16} aria-hidden /> {loading ? "Syncing..." : "Sync"}</Button><Button onClick={downloadCsv} loading={downloading} disabled={loading || data?.sync?.unavailable}><Download size={16} aria-hidden /> {downloading ? "Exporting..." : "Export CSV"}</Button></div></CardHeader>
      <CardBody className="space-y-5">
        {error && <ActionFeedback error>{error}</ActionFeedback>}
        {/* Amber on main, and it disables CSV export while active — an
            unavailable calibration system is not routine feedback. */}
        {data?.sync?.unavailable && <ActionFeedback className="!text-warn-fg">Calibration table is not migrated yet. Run database migrations before collecting samples.</ActionFeedback>}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">{summaryMetrics.map((metric) => <Card key={metric.label}><CardBody><div className={`text-18 font-medium u-nums ${metric.tone || "text-zinc-900"}`}>{metric.value}</div><div className="mt-1 text-ui-caption text-ink-secondary">{metric.label}</div></CardBody></Card>)}</div>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">{healthMetrics.map((metric) => <div key={metric.label} className="rounded-md bg-zinc-50 p-3"><div className={`text-16 font-medium u-nums ${metric.tone || "text-zinc-900"}`}>{metric.value}</div><div className="mt-1 text-ui-caption text-ink-secondary">{metric.label}</div></div>)}</div>
        <div className="grid gap-3 lg:grid-cols-2"><CalibrationGroup title="By pool cage size" rows={summary.byPoolCageSize || []} /><CalibrationGroup title="By lot band" rows={summary.byLotBand || []} /></div>
        {reviewQueue.length > 0 && <div><div className="mb-2 flex flex-wrap justify-between gap-2"><h3 className="font-medium text-zinc-900">Needs calibration review</h3><Badge tone="alert">{summary.reviewQueueCount || reviewQueue.length} flagged</Badge></div><Table className="min-w-[720px]" aria-label="Calibration review queue"><THead><TR><TH>Date</TH><TH>Customer</TH><TH align="right">Delta</TH><TH align="right">Pool</TH><TH align="right">Lot</TH><TH>Why</TH></TR></THead><TBody>{reviewQueue.slice(0, 8).map((row) => <TR key={`review-${row.id || row.scheduled_service_id}`}><TD nums>{String(row.service_date || "").slice(0, 10) || "-"}</TD><TD className="font-medium">{row.customer_name || row.address_line1 || "Unknown"}</TD><TD align="right" nums className="text-alert-fg">{formatMinutes(row.delta_minutes || 0)}</TD><TD align="right">{row.pool_cage_size || "-"}</TD><TD align="right" nums>{row.lot_sqft ? Number(row.lot_sqft).toLocaleString() : "-"}</TD><TD className="text-ink-secondary">{Array.isArray(row.calibration_review_reasons) ? row.calibration_review_reasons.join(", ") : "-"}</TD></TR>)}</TBody></Table></div>}
        <Table className="min-w-[900px]" aria-label="Pest calibration samples"><THead><TR><TH>Date</TH><TH>Customer</TH><TH align="right">Pool</TH><TH align="right">Lot</TH><TH align="right">Pred</TH><TH align="right">Actual</TH><TH align="right">Delta</TH><TH align="right">Confidence</TH><TH>Reasons</TH></TR></THead><TBody>{records.slice(0, 50).map((row) => { const reasons = Array.isArray(row.review_reasons) ? row.review_reasons.join(", ") : ""; const delta = Number(row.delta_minutes || 0); return <TR key={row.id || row.scheduled_service_id}><TD nums>{String(row.service_date || "").slice(0, 10) || "-"}</TD><TD className="font-medium">{row.customer_name || row.address_line1 || "Unknown"}</TD><TD align="right">{row.pool_cage_size || "-"}</TD><TD align="right" nums>{row.lot_sqft ? Number(row.lot_sqft).toLocaleString() : "-"}</TD><TD align="right" nums>{Number(row.predicted_minutes || 0).toFixed(1)}</TD><TD align="right" nums>{Number(row.actual_minutes || 0).toFixed(1)}</TD><TD align="right" nums className={calibrationDeltaTone(delta)}>{formatMinutes(delta)}</TD><TD align="right">{row.pricing_confidence || "-"}</TD><TD className="max-w-[220px] truncate text-ink-secondary" title={reasons}>{reasons || "-"}</TD></TR>; })}{!loading && records.length === 0 && <TR><TD colSpan="9" className="py-6 text-center text-ink-secondary">No calibration samples yet. Completed pest jobs need an accepted estimate link and a completed job timer.</TD></TR>}</TBody></Table>
      </CardBody>
    </Card>
  );
}

export default function PricingLogicPage({ embedded = false, onSecondaryNav } = {}) {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedSection = sectionFromSearchParams(searchParams);
  const [activeSection, setActiveSection] = useState(requestedSection);
  useRenderedTabBeacon("/admin/pricing-logic", activeSection, [searchParams]);
  const focusedService = searchParams.get("service");
  const focus = searchParams.get("focus");
  const serviceLabel = focusedService ? focusedService.replace(/_/g, " ") : "";

  useEffect(() => { setActiveSection(requestedSection); if (requestedSection !== "margins") scrollToPricingSection(requestedSection); }, [requestedSection]);
  const handleSectionChange = (key) => {
    setActiveSection(key);
    const nextParams = new URLSearchParams(searchParams); nextParams.set("section", key); setSearchParams(nextParams, { replace: true }); scrollToPricingSection(key);
  };
  const sectionChangeRef = useRef(handleSectionChange); sectionChangeRef.current = handleSectionChange;
  useEffect(() => {
    if (!embedded || !onSecondaryNav) return undefined;
    onSecondaryNav({ sections: PRICING_SECTIONS, activeKey: activeSection, onChange: (key) => sectionChangeRef.current(key), ariaLabel: "Pricing section", navGridClassName: "grid-cols-2 md:grid-cols-5" });
    return () => onSecondaryNav(null);
  }, [embedded, onSecondaryNav, activeSection]);

  const content = (
    <div className="space-y-5">
      {/* A below-floor review prompt from the estimate audit is a warning; main
          painted it amber, and alert red is for request failures. */}
      {focus === "margin" && <ActionFeedback className="!text-warn-fg">Review margin rules{serviceLabel ? ` for ${serviceLabel}` : ""}. The estimate audit flagged this service below the pricing floor.</ActionFeedback>}
      <section id="pricing-margins"><MarginCalculator /></section>
      <section id="pricing-calibration"><PestCalibrationPanel /></section>
      <section id="pricing-specs"><SpecServicesPanel /></section>
      <section id="pricing-logic"><PricingLogicPanel /></section>
      <section id="pricing-reality">{activeSection === "reality" && <PricingRealityCheckPage />}</section>
    </div>
  );
  // Same as Strategy: the routed path is always embedded, and main capped this
  // workspace's content at 1300px.
  if (embedded) return <UiSurface density="comfortable" className="mx-auto max-w-[1300px]">{content}</UiSurface>;
  return (
    <UiSurface density="comfortable" className="mx-auto max-w-[1300px] text-ui-body text-ink-primary">
      <AdminCommandHeader variant="workspace" title="Pricing" icon={Calculator} sections={PRICING_SECTIONS} activeKey={activeSection} onSectionChange={handleSectionChange} navGridClassName="grid-cols-2 md:grid-cols-5" />
      {content}
    </UiSurface>
  );
}
