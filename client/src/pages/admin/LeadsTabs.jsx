import React, { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Trash2 } from "lucide-react";
import { callViaBridge } from "../../components/admin/CallBridgeLink";
import useIsMobile from "../../hooks/useIsMobile";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const ROBOTO = "'Roboto', Arial, sans-serif";

function adminFetch(path, opts = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...opts.headers,
    },
    body: opts.body
      ? typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body)
      : undefined,
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const C = {
  bg: "#F4F4F5",
  card: "#FFFFFF",
  cardHover: "#FAFAFA",
  border: "#E4E4E7",
  text: "#27272A",
  muted: "#71717A",
  teal: "#18181B",
  green: "#3F3F46",
  amber: "#52525B",
  red: "#991B1B",
  purple: "#18181B",
  white: "#FFFFFF",
  heading: "#09090B",
  input: "#FFFFFF",
  inputBorder: "#D4D4D8",
};
const mono = { fontFamily: ROBOTO };

const STATUS_COLORS = {
  new: "#18181B",
  contacted: "#52525B",
  estimate_sent: "#3F3F46",
  estimate_viewed: "#52525B",
  won: "#18181B",
  lost: "#991B1B",
  unresponsive: "#A1A1AA",
  disqualified: "#991B1B",
  duplicate: "#A1A1AA",
};
const STATUSES = [
  "new",
  "contacted",
  "estimate_sent",
  "estimate_viewed",
  "won",
  "lost",
  "unresponsive",
  "disqualified",
  "duplicate",
];
const CLOSED_STATUSES = [
  "won",
  "lost",
  "unresponsive",
  "disqualified",
  "duplicate",
];
const BOARD_STAGES = [
  "new",
  "contacted",
  "estimate_sent",
  "won",
  "lost",
];
const LEAD_TYPES = [
  "inbound_call",
  "inbound_sms",
  "form_submission",
  "chat_widget",
  "walk_in",
  "referral",
  "ai_agent",
  "voicemail",
  "email_inquiry",
];
const LEADS_REFRESH_MS = 10_000;
const PIPELINE_SUMMARY_REFRESH_MS = 30_000;
const EXPANDED_LEAD_REFRESH_MS = 15_000;

function isPageVisible() {
  return typeof document === "undefined" || document.visibilityState !== "hidden";
}

function daysSinceContact(lead) {
  if (!lead.first_contact_at) return null;
  const ms = Date.now() - new Date(lead.first_contact_at).getTime();
  return Math.floor(ms / 86400000);
}

function leadEstimateParams(lead) {
  const params = new URLSearchParams({ tab: "new" });
  const customerName = [lead.first_name, lead.last_name]
    .filter(Boolean)
    .join(" ")
    .trim();
  if (lead.id) params.set("leadId", lead.id);
  if (customerName) params.set("customerName", customerName);
  if (lead.phone) params.set("customerPhone", lead.phone);
  if (lead.email) params.set("customerEmail", lead.email);
  if (lead.address) params.set("address", lead.address);
  if (lead.service_interest)
    params.set("serviceInterest", lead.service_interest);
  return params;
}

function Badge({ label, color, style }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 9999,
        fontSize: 11,
        fontWeight: 600,
        backgroundColor: color + "22",
        color,
        border: `1px solid ${color}44`,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {label}
    </span>
  );
}

function AgingBadge({ lead }) {
  if (CLOSED_STATUSES.includes(lead.status)) return null;
  const days = daysSinceContact(lead);
  if (days == null) return null;
  const color =
    days < 1 ? C.heading : days < 3 ? C.muted : days < 7 ? C.amber : C.red;
  const label = days < 1 ? "today" : days === 1 ? "1d" : `${days}d`;
  return <Badge label={label} color={color} />;
}

function Card({ children, style, onClick }) {
  return (
    <div
      onClick={onClick}
      style={{
        backgroundColor: C.card,
        borderRadius: 12,
        border: `1px solid ${C.border}`,
        padding: 20,
        cursor: onClick ? "pointer" : undefined,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

function MetricCard({ label, value, sub, color }) {
  return (
    <Card style={{ flex: "1 1 180px", minWidth: 160 }}>
      {" "}
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>
        {label}
      </div>{" "}
      <div
        style={{
          fontSize: 26,
          fontWeight: 700,
          color: color || C.heading,
          ...mono,
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>{sub}</div>
      )}
    </Card>
  );
}

function PipelineStatusCard({ label, value }) {
  return (
    <div
      style={{
        flex: "1 1 140px",
        minWidth: 140,
        background: C.card,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        padding: 14,
        textAlign: "left",
        fontFamily: ROBOTO,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          marginBottom: 4,
        }}
      >
        <span
          style={{
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
            letterSpacing: 0,
            color: C.muted,
          }}
        >
          {label}
        </span>
      </div>
      <div style={{ fontSize: 22, fontWeight: 500, color: C.heading, ...mono }}>
        {value}
      </div>
    </div>
  );
}

function LeadsWorkspaceNav({ active, onChange, counts }) {
  const tabs = [
    {
      key: "pipeline",
      label: "Pipeline",
      count: counts.pipeline,
    },
    {
      key: "sources",
      label: "Sources",
      count: counts.sources,
    },
    {
      key: "analytics",
      label: "ROI Analytics",
      count: counts.analytics,
    },
  ];
  return (
    <div
      style={{
        marginBottom: 24,
        border: `1px solid ${C.border}`,
        borderRadius: 6,
        background: C.card,
        overflow: "hidden",
      }}
    >
      {" "}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
          gap: 0,
        }}
      >
        {tabs.map((t) => {
          const isActive = active === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onChange(t.key)}
              style={{
                minHeight: 48,
                padding: "12px 14px",
                border: "none",
                borderRight:
                  t.key === "analytics" ? "none" : `1px solid ${C.border}`,
                borderBottom: isActive
                  ? `3px solid ${C.heading}`
                  : "3px solid transparent",
                background: isActive ? C.bg : C.card,
                color: isActive ? C.heading : C.text,
                cursor: "pointer",
                textAlign: "left",
                fontFamily: ROBOTO,
              }}
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: 10,
                }}
              >
                {" "}
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    letterSpacing: "0.06em",
                    textTransform: "uppercase",
                  }}
                >
                  {t.label}
                </span>{" "}
                <span
                  style={{
                    ...mono,
                    fontSize: 11,
                    color: isActive ? C.heading : C.muted,
                  }}
                >
                  {t.count ?? 0}
                </span>{" "}
              </div>{" "}
            </button>
          );
        })}
      </div>{" "}
    </div>
  );
}

function Btn({ children, onClick, color, small, style, disabled }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: small ? "4px 12px" : "8px 16px",
        borderRadius: 8,
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        backgroundColor: color || C.teal,
        color: "#fff",
        fontSize: small ? 12 : 13,
        fontWeight: 600,
        opacity: disabled ? 0.5 : 1,
        transition: "opacity 0.2s",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function Input({ label, value, onChange, type, placeholder, style, options }) {
  const base = {
    backgroundColor: C.input,
    border: `1px solid ${C.inputBorder}`,
    borderRadius: 8,
    padding: "8px 12px",
    color: C.text,
    fontSize: 13,
    width: "100%",
    outline: "none",
    boxSizing: "border-box",
    ...style,
  };
  return (
    <div style={{ marginBottom: 12 }}>
      {label && (
        <label
          style={{
            fontSize: 12,
            color: C.muted,
            display: "block",
            marginBottom: 4,
          }}
        >
          {label}
        </label>
      )}
      {options ? (
        <select
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          style={base}
        >
          {" "}
          <option value="">-- Select --</option>
          {options.map((o) => (
            <option key={o.value || o} value={o.value || o}>
              {o.label || o}
            </option>
          ))}
        </select>
      ) : (
        <input
          type={type || "text"}
          value={value || ""}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          style={base}
        />
      )}
    </div>
  );
}

function Modal({ title, onClose, children }) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      {" "}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: C.card,
          borderRadius: 16,
          border: `1px solid ${C.border}`,
          padding: 24,
          maxWidth: 520,
          width: "90%",
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        {" "}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          {" "}
          <h3 style={{ margin: 0, color: C.heading, fontSize: 18 }}>
            {title}
          </h3>{" "}
          <button
            onClick={onClose}
            style={{
              background: "none",
              border: "none",
              color: C.muted,
              cursor: "pointer",
              fontSize: 20,
            }}
          >
            x
          </button>{" "}
        </div>
        {children}
      </div>{" "}
    </div>
  );
}

function fmtMoney(v) {
  return v != null
    ? "$" +
        Number(v).toLocaleString("en-US", {
          minimumFractionDigits: 0,
          maximumFractionDigits: 0,
        })
    : "--";
}
function fmtPct(v) {
  return v != null ? v.toFixed(1) + "%" : "--";
}
function fmtTime(min) {
  if (min == null) return "--";
  const numericMinutes = Number(min);
  if (!Number.isFinite(numericMinutes)) return "--";
  const totalSeconds = Math.max(0, Math.round(numericMinutes * 60));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, "0"))
    .join(":");
}
function roiColor(roi) {
  return roi >= 0 ? C.heading : C.red;
}

// ═══════════════════════════════════════════════════════════════════════════
// SPEED-TO-LEAD TIMER
// ═══════════════════════════════════════════════════════════════════════════

// Inject pulse keyframe once
if (
  typeof document !== "undefined" &&
  !document.getElementById("speed-to-lead-pulse")
) {
  const style = document.createElement("style");
  style.id = "speed-to-lead-pulse";
  style.textContent = `@keyframes stlPulse { 0%,100%{opacity:1} 50%{opacity:0.4} }`;
  document.head.appendChild(style);
}

function SpeedToLeadTimer({ firstContactAt }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!firstContactAt) return;
    const start = new Date(firstContactAt).getTime();
    const tick = () => setElapsed(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [firstContactAt]);

  const mins = Math.floor(elapsed / 60);
  const hours = Math.floor(elapsed / 3600);
  const displayMinutes = Math.floor((elapsed % 3600) / 60);
  const secs = elapsed % 60;
  const hh = String(hours).padStart(2, "0");
  const mm = String(displayMinutes).padStart(2, "0");
  const ss = String(secs).padStart(2, "0");
  const color = mins < 5 ? C.green : mins < 15 ? C.amber : C.red;
  const shouldPulse = mins >= 5;

  return (
    <span
      style={{
        ...mono,
        fontSize: 13,
        color,
        fontWeight: 600,
        animation: shouldPulse ? "stlPulse 1.5s ease-in-out infinite" : "none",
      }}
    >
      {hh}:{mm}:{ss}
    </span>
  );
}

const LOST_REASONS = [
  { value: "price", label: "Price too high" },
  { value: "competitor", label: "Chose competitor" },
  { value: "diy", label: "DIY / self-treating" },
  { value: "not_ready", label: "Not ready yet" },
  { value: "no_response", label: "No response" },
  { value: "out_of_area", label: "Out of service area" },
  { value: "no_need", label: "No longer needed" },
  { value: "other", label: "Other" },
];

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
// Read the dashboard "drill into source" params off the URL once, so the leads
// filters can be initialized from them on the very first render — the initial
// pipeline load is then already scoped, avoiding an unfiltered first fetch that
// (with no stale-response guard) could resolve last and overwrite the results.
function readSourceDrillParams() {
  if (typeof window === "undefined") return null;
  const sp = new URLSearchParams(window.location.search);
  const sourceName = sp.get("source_name");
  if (!sourceName) return null;
  return {
    source_name: sourceName,
    start_date: sp.get("from") || "",
    end_date: sp.get("to") || "",
    period_label: sp.get("period_label") || "",
  };
}

export function LeadsSection() {
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();
  const [tab, setTab] = useState("pipeline");
  const [smsCompose, setSmsCompose] = useState(null); // { leadId, message }
  const [callbackForm, setCallbackForm] = useState(null); // { leadId, date, time, notes }
  const [apptForm, setApptForm] = useState(null); // { leadId, date, time, serviceId, serviceType, technicianId, notes }
  const [apptSaving, setApptSaving] = useState(false);
  const [services, setServices] = useState([]);
  const [smsSending, setSmsSending] = useState(false);
  const [leads, setLeads] = useState([]);
  const [leadsTotal, setLeadsTotal] = useState(0);
  const [sources, setSources] = useState([]);
  const [overview, setOverview] = useState(null);
  const [funnel, setFunnel] = useState([]);
  const [bySource, setBySource] = useState([]);
  // Sources-table ROI is kept separate from `bySource`: it includes inactive
  // sources and is fetched only on the Sources tab, so a late-resolving response
  // can never overwrite the Analytics tab's active-only `bySource`.
  const [sourcesRoi, setSourcesRoi] = useState([]);
  const [byChannel, setByChannel] = useState([]);
  const [responseBuckets, setResponseBuckets] = useState([]);
  const [lostReasons, setLostReasons] = useState([]);
  const [expandedLead, setExpandedLead] = useState(null);
  const expandedLeadRef = useRef(null);
  const [leadActivities, setLeadActivities] = useState([]);
  const [leadActivitiesLoading, setLeadActivitiesLoading] = useState(false);
  const [leadActivitiesError, setLeadActivitiesError] = useState(null);
  const [showModal, setShowModal] = useState(null);
  const [formData, setFormData] = useState({});
  const [filters, setFilters] = useState(() => {
    // Drill-down from the dashboard Marketing Attribution panel: filter to a
    // single source name, scoped to the period window the panel was showing.
    // Initialized from the URL so the first load is already scoped.
    const drill = readSourceDrillParams();
    return {
      status: "",
      search: "",
      sort: "first_contact_at",
      page: 1,
      source_name: drill?.source_name || "",
      start_date: drill?.start_date || "",
      end_date: drill?.end_date || "",
    };
  });
  // Human label for the active source-drill chip (e.g. "This month").
  const [sourcePeriodLabel, setSourcePeriodLabel] = useState(
    () => readSourceDrillParams()?.period_label || "",
  );
  const [pipelineView, setPipelineView] = useState("table");
  const [draggingLeadId, setDraggingLeadId] = useState(null);
  const [deletingLeadId, setDeletingLeadId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [techs, setTechs] = useState([]);

  const setActiveLead = useCallback((leadId) => {
    expandedLeadRef.current = leadId;
    setExpandedLead(leadId);
  }, []);

  const loadLeads = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoadError(null);
      const params = new URLSearchParams();
      if (filters.status) params.set("status", filters.status);
      if (filters.search) params.set("search", filters.search);
      if (filters.source_name) params.set("source_name", filters.source_name);
      if (filters.start_date) params.set("start_date", filters.start_date);
      if (filters.end_date) params.set("end_date", filters.end_date);
      params.set("sort", filters.sort);
      params.set("page", filters.page);
      params.set("limit", "50");
      const data = await adminFetch(`/admin/leads?${params}`);
      setLeads(data.leads || []);
      setLeadsTotal(data.total || 0);
    } catch (e) {
      console.error("loadLeads", e);
      if (!silent) setLoadError(e);
    }
  }, [filters]);

  const loadSources = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoadError(null);
      const data = await adminFetch("/admin/leads/sources");
      setSources(data.sources || []);
    } catch (e) {
      console.error("loadSources", e);
      if (!silent) setLoadError(e);
    }
  }, []);

  // Real revenue-based ROI for the Sources table (same backend as Analytics).
  // Loaded only on the Sources tab — the Pipeline/Analytics tabs already get
  // `bySource` via loadAnalytics, so this avoids double-running the expensive
  // calculateAllSourceROI on those tabs.
  const loadSourceROI = useCallback(async () => {
    try {
      // include_inactive: the Sources table lists inactive sources too and needs
      // their ROI. The Analytics tab (loadAnalytics) calls without it, so its
      // ROI Matrix / Phone / Channel panels stay active-only and consistent.
      const bs = await adminFetch(
        "/admin/leads/analytics/by-source?include_inactive=1",
      );
      setSourcesRoi(bs.sources || []);
    } catch (e) {
      console.error("loadSourceROI", e);
    }
  }, []);

  const loadAnalytics = useCallback(async ({ silent = false } = {}) => {
    try {
      if (!silent) setLoadError(null);
      const [ov, fn, bs, bc, rb, lr] = await Promise.all([
        adminFetch("/admin/leads/analytics/overview"),
        adminFetch("/admin/leads/analytics/funnel"),
        adminFetch("/admin/leads/analytics/by-source"),
        adminFetch("/admin/leads/analytics/by-channel"),
        adminFetch("/admin/leads/analytics/response"),
        adminFetch("/admin/leads/analytics/lost"),
      ]);
      setOverview(ov);
      setFunnel(fn.funnel || []);
      setBySource(bs.sources || []);
      setByChannel(bc.channels || []);
      setResponseBuckets(rb.buckets || []);
      setLostReasons(lr.reasons || []);
    } catch (e) {
      console.error("loadAnalytics", e);
      if (!silent) setLoadError(e);
    }
  }, []);

  const loadTechs = useCallback(async () => {
    try {
      const data = await adminFetch("/admin/customers?limit=1");
      // Try fetching technicians directly
      const t = await adminFetch("/admin/dispatch/technicians").catch(() => ({
        technicians: [],
      }));
      setTechs(t.technicians || []);
    } catch (e) {
      setTechs([]);
    }
  }, []);

  const loadServices = useCallback(async () => {
    try {
      const data = await adminFetch(
        "/admin/services?is_active=true&limit=200",
      ).catch(() => ({ services: [] }));
      setServices(data.services || []);
    } catch (e) {
      setServices([]);
    }
  }, []);

  useEffect(() => {
    loadTechs();
    loadServices();
  }, [loadTechs, loadServices]);

  useEffect(() => {
    if (tab === "pipeline") {
      loadLeads();
      loadAnalytics();
      loadSources();
    }
    if (tab === "sources") {
      loadSources();
      loadSourceROI();
    }
    if (tab === "analytics") loadAnalytics();
  }, [tab, loadLeads, loadSources, loadSourceROI, loadAnalytics]);

  useEffect(() => {
    if (tab !== "pipeline") return undefined;
    const id = window.setInterval(() => {
      if (!isPageVisible()) return;
      loadLeads({ silent: true });
    }, LEADS_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [tab, loadLeads]);

  useEffect(() => {
    if (tab !== "pipeline") return undefined;
    const id = window.setInterval(() => {
      if (!isPageVisible()) return;
      loadAnalytics({ silent: true });
      loadSources({ silent: true });
    }, PIPELINE_SUMMARY_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [tab, loadAnalytics, loadSources]);

  const loadLeadActivities = useCallback(
    async (leadId, { silent = false } = {}) => {
      if (!leadId) return;
      const requestedLeadId = String(leadId);
      if (!silent) {
        setLeadActivities([]);
        setLeadActivitiesError(null);
        setLeadActivitiesLoading(true);
      }
      try {
        const data = await adminFetch(`/admin/leads/${leadId}`);
        if (String(expandedLeadRef.current || "") !== requestedLeadId) return;
        setLeadActivities(data.activities || []);
        if (!silent) setLeadActivitiesError(null);
      } catch (e) {
        console.error("loadLeadActivities", e);
        if (String(expandedLeadRef.current || "") !== requestedLeadId) return;
        if (!silent) {
          setLeadActivities([]);
          setLeadActivitiesError(e);
        }
      } finally {
        if (
          !silent &&
          String(expandedLeadRef.current || "") === requestedLeadId
        ) {
          setLeadActivitiesLoading(false);
        }
      }
    },
    [],
  );

  useEffect(() => {
    if (tab !== "pipeline" || !expandedLead) return undefined;
    const id = window.setInterval(() => {
      if (!isPageVisible()) return;
      loadLeadActivities(expandedLead, { silent: true });
    }, EXPANDED_LEAD_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [tab, expandedLead, loadLeadActivities]);

  // Deep-link from a notification: /admin/leads?lead=<leadId> opens the pipeline
  // and expands that lead's detail row (new_lead notification). The expanded row
  // only renders in the pipeline table view, so snap there first. Runs once.
  const leadDeepLinkDone = useRef(false);
  useEffect(() => {
    if (leadDeepLinkDone.current) return;
    leadDeepLinkDone.current = true;
    const leadId = new URLSearchParams(window.location.search).get("lead");
    if (!leadId) return;
    setTab("pipeline");
    setPipelineView("table");
    setActiveLead(leadId);
    loadLeadActivities(leadId);
  }, [setActiveLead, loadLeadActivities]);

  // Drill-down from the dashboard Marketing Attribution panel:
  // /admin/leads?source_name=<name>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>&period_label=<label>
  // filters the pipeline table to that source for the panel's period window.
  // Runs once, then strips the drill params so the chip (state) is the single
  // source of truth and a refresh/share keeps the URL clean.
  // The `filters` + chip label were already initialized from these params (lazy
  // useState above), so the first pipeline load is correctly scoped. This effect
  // just snaps to the table view and strips the drill params, leaving the chip
  // state as the single source of truth (clean URL on refresh/share).
  const sourceDeepLinkDone = useRef(false);
  useEffect(() => {
    if (sourceDeepLinkDone.current) return;
    sourceDeepLinkDone.current = true;
    const sp = new URLSearchParams(window.location.search);
    if (!sp.get("source_name")) return;
    setTab("pipeline");
    setPipelineView("table");
    ["source_name", "from", "to", "period_label"].forEach((k) => sp.delete(k));
    setSearchParams(sp, { replace: true });
  }, [setSearchParams]);

  const expandLead = async (lead) => {
    if (expandedLead === lead.id) {
      setActiveLead(null);
      return;
    }
    setActiveLead(lead.id);
    loadLeadActivities(lead.id);
  };

  const updateLeadStatus = async (leadId, status) => {
    try {
      await adminFetch(`/admin/leads/${leadId}`, {
        method: "PUT",
        body: { status },
      });
      loadLeads();
    } catch (e) {
      alert("Status update failed: " + e.message);
    }
  };

  const deleteLead = async (lead) => {
    const label =
      [lead.first_name, lead.last_name].filter(Boolean).join(" ").trim() ||
      lead.phone ||
      lead.email ||
      "this lead";
    if (
      !window.confirm(
        `Delete ${label} from the lead pipeline?\n\nThis removes the lead and its activity timeline. Existing estimates stay in Estimates.`,
      )
    ) {
      return;
    }

    setDeletingLeadId(lead.id);
    try {
      await adminFetch(`/admin/leads/${lead.id}`, { method: "DELETE" });
      setLeads((rows) => rows.filter((row) => row.id !== lead.id));
      setLeadsTotal((total) => Math.max(0, total - 1));
      if (expandedLead === lead.id) {
        setActiveLead(null);
        setLeadActivities([]);
      }
      loadAnalytics();
      loadSources();
    } catch (e) {
      alert("Delete failed: " + e.message);
    } finally {
      setDeletingLeadId(null);
    }
  };

  const retryCurrentTab = () => {
    setLoadError(null);
    if (tab === "pipeline") {
      loadLeads();
      loadAnalytics();
      loadSources();
    }
    if (tab === "sources") {
      loadSources();
      loadSourceROI();
    }
    if (tab === "analytics") loadAnalytics();
  };

  const submitForm = async () => {
    setLoading(true);
    try {
      if (showModal === "newLead") {
        await adminFetch("/admin/leads", { method: "POST", body: formData });
        loadLeads();
      } else if (showModal === "newSource") {
        await adminFetch("/admin/leads/sources", {
          method: "POST",
          body: formData,
        });
        loadSources();
      } else if (showModal === "convert") {
        if (!formData.customer_id) {
          alert("Customer ID is required to convert a lead.");
          setLoading(false);
          return;
        }
        await adminFetch(`/admin/leads/${formData.leadId}/convert`, {
          method: "POST",
          body: formData,
        });
        loadLeads();
      } else if (showModal === "lost") {
        await adminFetch(`/admin/leads/${formData.leadId}/lost`, {
          method: "POST",
          body: formData,
        });
        loadLeads();
      } else if (showModal === "assign") {
        await adminFetch(`/admin/leads/${formData.leadId}/assign`, {
          method: "POST",
          body: { technician_id: formData.technician_id },
        });
        loadLeads();
      } else if (showModal === "logCost") {
        await adminFetch(`/admin/leads/sources/${formData.sourceId}/cost`, {
          method: "POST",
          body: formData,
        });
        loadSources();
        // Cost/ROI columns AND the expanded detail row both render from this
        // attributed payload now, so refreshing it reflects the just-logged cost
        // immediately (no tab reload, no separate /sources/:id refresh needed).
        loadSourceROI();
      }
      setShowModal(null);
      setFormData({});
    } catch (e) {
      alert("Error: " + e.message);
    }
    setLoading(false);
  };

  // ═════════════════════════════════════════════════════════════════════════
  // PIPELINE TAB
  // ═════════════════════════════════════════════════════════════════════════
  const renderPipeline = () => {
    const ov = overview || {};
    const funnelByStage = new Map(funnel.map((f) => [f.stage, f]));
    const countStages = (stages) =>
      stages.reduce(
        (sum, stage) => sum + Number(funnelByStage.get(stage)?.count || 0),
        0,
      );
    const pipelineOrder = [
      { stage: "new", label: "New Leads", count: countStages(["new"]) },
      {
        stage: "contacted",
        label: "Contacted",
        count: countStages(["contacted"]),
      },
      {
        stage: "estimate_sent",
        label: "Estimate Sent",
        count: countStages(["estimate_sent", "estimate_viewed", "negotiating"]),
      },
      { stage: "won", label: "Won", count: countStages(["won"]) },
      {
        stage: "lost",
        label: "Lost",
        count: countStages(["lost", "unresponsive", "disqualified", "duplicate"]),
      },
    ];
    const funnelData = pipelineOrder;
    const draggingLead = draggingLeadId
      ? leads.find((lead) => lead.id === draggingLeadId)
      : null;
    const handleBoardDrop = (event, stage) => {
      event.preventDefault();
      const droppedId = event.dataTransfer.getData("text/plain");
      const lead = leads.find((item) => String(item.id) === droppedId);
      if (lead && lead.status !== stage) updateLeadStatus(lead.id, stage);
      setDraggingLeadId(null);
    };

    return (
      <>
        {/* Metric Cards */}
        <div
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 24,
          }}
        >
          {" "}
          <MetricCard
            label="New Leads (Month)"
            value={ov.total || 0}
            color={C.teal}
          />{" "}
          <MetricCard
            label="Conversion Rate"
            value={fmtPct(ov.conversionRate)}
            color={C.green}
          />{" "}
          <MetricCard
            label="Median Response Time"
            value={fmtTime(ov.medianResponseTime)}
            sub={
              ov.recentMedianResponseTime != null
                ? `7-day: ${fmtTime(ov.recentMedianResponseTime)}`
                : undefined
            }
            color={C.amber}
          />{" "}
          <MetricCard
            label="Cost per Acquisition"
            value={fmtMoney(ov.cpa)}
            color={C.purple}
          />{" "}
          <MetricCard
            label="Avg Speed to Lead"
            value={ov.avgSpeedToLead != null ? fmtTime(ov.avgSpeedToLead) : "--"}
            sub={
              ov.avgSpeedToLead == null
                ? "None waiting"
                : `${ov.openUnansweredCount} waiting · ${
                    ov.avgSpeedToLead < 5
                      ? "Great!"
                      : ov.avgSpeedToLead < 15
                        ? "Good"
                        : "Needs work"
                  }`
            }
            color={
              ov.avgSpeedToLead == null
                ? C.green
                : ov.avgSpeedToLead < 5
                  ? C.green
                  : ov.avgSpeedToLead < 15
                    ? C.amber
                    : C.red
            }
          />{" "}
          <MetricCard
            label="Monthly ROI"
            value={ov.roi != null ? fmtPct(ov.roi) : "--"}
            color={roiColor(ov.roi || 0)}
          />{" "}
        </div>
        {/* Pipeline status */}
        <div style={{ marginBottom: 10 }}>
          <h2
            style={{
              margin: "0 0 6px",
              color: C.heading,
              fontSize: 12,
              fontWeight: 500,
              fontFamily: ROBOTO,
              letterSpacing: "0.02em",
            }}
          >
            Pipeline Status
          </h2>
          <div style={{ margin: 0, color: C.muted, fontSize: 12 }}>
            Current lead counts by status for the selected month.
          </div>
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 16,
            flexWrap: "wrap",
          }}
        >
          {funnelData.map((f) => (
            <PipelineStatusCard
              key={f.stage}
              label={f.label || f.stage.replace(/_/g, " ")}
              value={f.count}
            />
          ))}
        </div>
        {/* Filters + Actions */}
        <div
          style={{
            display: "flex",
            gap: 12,
            marginBottom: 16,
            flexWrap: "wrap",
            alignItems: "center",
          }}
        >
          {" "}
          <div
            style={{
              display: "flex",
              background: "#F4F4F5",
              borderRadius: 8,
              padding: 3,
              border: `1px solid ${C.border}`,
            }}
          >
            {["table", "board"].map((view) => (
              <button
                key={view}
                type="button"
                onClick={() => {
                  setPipelineView(view);
                  if (view === "board")
                    setFilters((f) => ({ ...f, status: "", page: 1 }));
                }}
                style={{
                  background: pipelineView === view ? C.heading : "transparent",
                  color: pipelineView === view ? C.white : C.muted,
                  padding: "5px 14px",
                  borderRadius: 6,
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 600,
                  textTransform: "capitalize",
                  fontFamily: ROBOTO,
                }}
              >
                {view}
              </button>
            ))}
          </div>
          {pipelineView === "table" && (
            <select
              value={filters.status}
              onChange={(e) =>
                setFilters((f) => ({ ...f, status: e.target.value, page: 1 }))
              }
              style={{
                backgroundColor: C.input,
                border: `1px solid ${C.inputBorder}`,
                borderRadius: 8,
                padding: "6px 12px",
                color: C.text,
                fontSize: 13,
              }}
            >
              {" "}
              <option value="">All Statuses</option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s.replace(/_/g, " ")}
                </option>
              ))}
            </select>
          )}
          <input
            placeholder="Search by name, phone, email"
            value={filters.search}
            onChange={(e) =>
              setFilters((f) => ({ ...f, search: e.target.value, page: 1 }))
            }
            style={{
              backgroundColor: C.input,
              border: `1px solid ${C.inputBorder}`,
              borderRadius: 8,
              padding: "8px 12px",
              color: C.text,
              fontSize: 14,
              minWidth: 200,
            }}
          />
          {pipelineView === "table" && (
            <select
              value={filters.sort}
              onChange={(e) =>
                setFilters((f) => ({ ...f, sort: e.target.value }))
              }
              style={{
                backgroundColor: C.input,
                border: `1px solid ${C.inputBorder}`,
                borderRadius: 8,
                padding: "6px 12px",
                color: C.text,
                fontSize: 13,
              }}
            >
              {" "}
              <option value="first_contact_at">Newest First</option>{" "}
              <option value="name">Name</option>{" "}
              <option value="status">Status</option>{" "}
              <option value="response_time">Response Time</option>{" "}
              <option value="monthly_value">Value</option>{" "}
            </select>
          )}
          {filters.source_name && (
            <div
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                backgroundColor: C.bg,
                border: `1px solid ${C.border}`,
                borderRadius: 999,
                padding: "5px 6px 5px 12px",
                fontSize: 13,
                color: C.text,
                fontFamily: ROBOTO,
              }}
            >
              <span style={{ color: C.muted }}>Source:</span>
              <span style={{ fontWeight: 600 }}>{filters.source_name}</span>
              {sourcePeriodLabel && (
                <span style={{ color: C.muted }}>· {sourcePeriodLabel}</span>
              )}
              <button
                type="button"
                aria-label="Clear source filter"
                title="Clear source filter"
                onClick={() => {
                  setFilters((f) => ({
                    ...f,
                    source_name: "",
                    start_date: "",
                    end_date: "",
                    page: 1,
                  }));
                  setSourcePeriodLabel("");
                }}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: 18,
                  height: 18,
                  borderRadius: 999,
                  border: "none",
                  background: "transparent",
                  color: C.muted,
                  cursor: "pointer",
                  fontSize: 14,
                  lineHeight: 1,
                }}
              >
                ×
              </button>
            </div>
          )}
          <div style={{ flex: 1 }} />{" "}
          <Btn
            onClick={() => {
              if (sources.length === 0) loadSources();
              setFormData({});
              setShowModal("newLead");
            }}
          >
            + New Lead
          </Btn>{" "}
        </div>
        {pipelineView === "table" && (
          <>
            {/* Leads Table */}
            <Card style={{ padding: 0, overflow: "hidden" }}>
              {" "}
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                {" "}
                <thead>
                  {" "}
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {(isMobile
                      ? ["Name / Phone", "Status"]
                      : [
                          "Name / Phone",
                          "Source",
                          "Service",
                          "Urgency",
                          "Status",
                          "Response",
                          "Actions",
                        ]
                    ).map((h) => (
                      <th
                        key={h}
                        style={{
                          padding: "12px 16px",
                          textAlign: "left",
                          fontSize: 11,
                          color: C.muted,
                          fontWeight: 600,
                          textTransform: "uppercase",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>{" "}
                </thead>{" "}
                <tbody>
                  {leads.map((lead) => {
                    const isExpanded = expandedLead === lead.id;
                    return (
                      <React.Fragment key={lead.id}>
                        {" "}
                        <tr
                          onClick={() => expandLead(lead)}
                          style={{
                            borderBottom: `1px solid ${C.border}`,
                            cursor: "pointer",
                            backgroundColor: isExpanded
                              ? C.cardHover
                              : "transparent",
                            transition: "background 0.15s",
                          }}
                        >
                          {" "}
                          <td style={{ padding: "12px 16px" }}>
                            {" "}
                            <div
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              {" "}
                              <span
                                style={{
                                  color: C.heading,
                                  fontSize: 14,
                                  fontWeight: 500,
                                }}
                              >
                                {[lead.first_name, lead.last_name]
                                  .filter(Boolean)
                                  .join(" ") || "Unknown"}
                              </span>{" "}
                              <AgingBadge lead={lead} />{" "}
                            </div>{" "}
                            <div
                              style={{ color: C.muted, fontSize: 12, ...mono }}
                            >
                              {lead.phone || lead.email || "--"}
                            </div>{" "}
                          </td>{" "}
                          {!isMobile && (
                            <>
                              <td style={{ padding: "12px 16px" }}>
                                {lead.source_name ? (
                                  <Badge
                                    label={
                                      lead.source_name.length > 25
                                        ? lead.source_name.slice(0, 22) + "..."
                                        : lead.source_name
                                    }
                                    color={C.teal}
                                  />
                                ) : (
                                  <span
                                    style={{ color: C.muted, fontSize: 12 }}
                                  >
                                    --
                                  </span>
                                )}
                              </td>{" "}
                              <td
                                style={{
                                  padding: "12px 16px",
                                  color: C.text,
                                  fontSize: 13,
                                }}
                              >
                                {lead.service_interest || "--"}
                              </td>{" "}
                              <td style={{ padding: "12px 16px" }}>
                                {" "}
                                <Badge
                                  label={lead.urgency || "normal"}
                                  color={
                                    lead.urgency === "urgent"
                                      ? C.red
                                      : lead.urgency === "high"
                                        ? C.amber
                                        : C.muted
                                  }
                                />{" "}
                              </td>{" "}
                            </>
                          )}
                          <td
                            style={{ padding: "12px 16px" }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {" "}
                            <select
                              value={lead.status}
                              onChange={(e) =>
                                updateLeadStatus(lead.id, e.target.value)
                              }
                              style={{
                                backgroundColor:
                                  STATUS_COLORS[lead.status] + "22",
                                border: `1px solid ${STATUS_COLORS[lead.status] || C.border}44`,
                                borderRadius: 6,
                                padding: "4px 8px",
                                color: STATUS_COLORS[lead.status] || C.text,
                                fontSize: 12,
                                cursor: "pointer",
                              }}
                            >
                              {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {s.replace(/_/g, " ")}
                                </option>
                              ))}
                            </select>{" "}
                          </td>{" "}
                          {!isMobile && (
                            <>
                              <td
                                style={{
                                  padding: "12px 16px",
                                  ...mono,
                                  fontSize: 13,
                                  color:
                                    lead.response_time_minutes != null
                                      ? lead.response_time_minutes < 15
                                        ? C.green
                                        : lead.response_time_minutes < 60
                                          ? C.amber
                                          : C.red
                                      : C.muted,
                                }}
                              >
                                {lead.status === "new" &&
                                lead.response_time_minutes == null &&
                                lead.first_contact_at ? (
                                  <SpeedToLeadTimer
                                    firstContactAt={lead.first_contact_at}
                                  />
                                ) : (
                                  fmtTime(lead.response_time_minutes)
                                )}
                              </td>{" "}
                              <td
                                style={{ padding: "12px 16px" }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <button
                                  type="button"
                                  aria-label={`Delete lead for ${
                                    [lead.first_name, lead.last_name]
                                      .filter(Boolean)
                                      .join(" ") || "unknown"
                                  }`}
                                  title="Delete lead"
                                  disabled={deletingLeadId === lead.id}
                                  onClick={() => deleteLead(lead)}
                                  style={{
                                    display: "inline-flex",
                                    alignItems: "center",
                                    gap: 6,
                                    border: `1px solid ${C.red}33`,
                                    borderRadius: 6,
                                    padding: "5px 8px",
                                    background: C.white,
                                    color: C.red,
                                    fontSize: 12,
                                    fontWeight: 600,
                                    cursor:
                                      deletingLeadId === lead.id
                                        ? "not-allowed"
                                        : "pointer",
                                    opacity:
                                      deletingLeadId === lead.id ? 0.5 : 1,
                                  }}
                                >
                                  <Trash2 size={14} strokeWidth={1.8} />
                                  {deletingLeadId === lead.id
                                    ? "Deleting"
                                    : "Delete"}
                                </button>
                              </td>{" "}
                            </>
                          )}
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td
                              colSpan={isMobile ? 2 : 7}
                              style={{ padding: 0 }}
                            >
                              {" "}
                              <div
                                style={{
                                  padding: "16px 24px",
                                  backgroundColor: C.bg,
                                  borderBottom: `1px solid ${C.border}`,
                                }}
                              >
                                {" "}
                                <div
                                  style={{
                                    display: "flex",
                                    gap: 16,
                                    flexWrap: "wrap",
                                    marginBottom: 16,
                                  }}
                                >
                                  {" "}
                                  <div style={{ flex: "1 1 300px" }}>
                                    {" "}
                                    <h4
                                      style={{
                                        margin: "0 0 8px",
                                        color: C.heading,
                                        fontSize: 14,
                                      }}
                                    >
                                      Details
                                    </h4>{" "}
                                    <div
                                      style={{
                                        fontSize: 13,
                                        color: C.muted,
                                        lineHeight: 1.8,
                                      }}
                                    >
                                      {" "}
                                      <div>
                                        Email:{" "}
                                        <span style={{ color: C.text }}>
                                          {lead.email || "--"}
                                        </span>
                                      </div>{" "}
                                      <div>
                                        Address:{" "}
                                        <span style={{ color: C.text }}>
                                          {[lead.address, lead.city, lead.zip]
                                            .filter(Boolean)
                                            .join(", ") || "--"}
                                        </span>
                                      </div>{" "}
                                      <div>
                                        Type:{" "}
                                        <span style={{ color: C.text }}>
                                          {lead.lead_type?.replace(/_/g, " ") ||
                                            "--"}
                                        </span>
                                      </div>{" "}
                                      <div>
                                        First Contact:{" "}
                                        <span style={{ color: C.text }}>
                                          {lead.first_contact_at
                                            ? new Date(
                                                lead.first_contact_at,
                                              ).toLocaleString()
                                            : "--"}
                                        </span>
                                      </div>
                                      {lead.monthly_value && (
                                        <div>
                                          Monthly Value:{" "}
                                          <span
                                            style={{ color: C.green, ...mono }}
                                          >
                                            {fmtMoney(lead.monthly_value)}
                                          </span>
                                        </div>
                                      )}
                                      {lead.transcript_summary && (
                                        <div>
                                          Notes:{" "}
                                          <span style={{ color: C.text }}>
                                            {lead.transcript_summary}
                                          </span>
                                        </div>
                                      )}
                                    </div>{" "}
                                  </div>{" "}
                                  <div style={{ flex: "1 1 300px" }}>
                                    {" "}
                                    <h4
                                      style={{
                                        margin: "0 0 8px",
                                        color: C.heading,
                                        fontSize: 14,
                                      }}
                                    >
                                      Activity Timeline
                                    </h4>{" "}
                                    <div
                                      style={{
                                        maxHeight: 200,
                                        overflowY: "auto",
                                      }}
                                    >
                                      {leadActivitiesLoading && (
                                        <div
                                          style={{
                                            color: C.muted,
                                            fontSize: 12,
                                          }}
                                        >
                                          Loading activities...
                                        </div>
                                      )}
                                      {!leadActivitiesLoading &&
                                        leadActivitiesError && (
                                          <div
                                            style={{
                                              color: C.red,
                                              fontSize: 12,
                                            }}
                                          >
                                            Activity failed to load:{" "}
                                            {leadActivitiesError.message ||
                                              String(leadActivitiesError)}
                                          </div>
                                        )}
                                      {!leadActivitiesLoading &&
                                        !leadActivitiesError &&
                                        leadActivities.length === 0 && (
                                          <div
                                            style={{
                                              color: C.muted,
                                              fontSize: 12,
                                            }}
                                          >
                                            No activities logged
                                          </div>
                                        )}
                                      {leadActivities.map((a) => (
                                        <div
                                          key={a.id}
                                          style={{
                                            fontSize: 12,
                                            color: C.muted,
                                            padding: "4px 0",
                                            borderLeft: `2px solid ${C.border}`,
                                            paddingLeft: 12,
                                            marginLeft: 4,
                                            marginBottom: 4,
                                          }}
                                        >
                                          {" "}
                                          <Badge
                                            label={a.activity_type}
                                            color={C.teal}
                                            style={{ marginRight: 8 }}
                                          />{" "}
                                          <span style={{ color: C.text }}>
                                            {a.description}
                                          </span>{" "}
                                          <div
                                            style={{
                                              fontSize: 10,
                                              marginTop: 2,
                                            }}
                                          >
                                            {a.performed_by} -{" "}
                                            {new Date(
                                              a.created_at,
                                            ).toLocaleString()}
                                          </div>{" "}
                                        </div>
                                      ))}
                                    </div>{" "}
                                  </div>{" "}
                                </div>
                                {/* AI Suggested Reply */}
                                {(() => {
                                  const triageActivity = leadActivities.find(
                                    (a) =>
                                      a.activity_type === "ai_triage" &&
                                      a.metadata,
                                  );
                                  if (!triageActivity) return null;
                                  let meta = {};
                                  try {
                                    meta =
                                      typeof triageActivity.metadata ===
                                      "string"
                                        ? JSON.parse(triageActivity.metadata)
                                        : triageActivity.metadata;
                                  } catch (e) {}
                                  if (!meta.suggestedReply) return null;
                                  return (
                                    <div
                                      style={{
                                        border: `1px solid ${C.teal}44`,
                                        borderRadius: 10,
                                        padding: 14,
                                        marginBottom: 14,
                                        backgroundColor: C.teal + "0a",
                                      }}
                                    >
                                      {" "}
                                      <div
                                        style={{
                                          fontSize: 12,
                                          color: C.teal,
                                          fontWeight: 600,
                                          marginBottom: 6,
                                        }}
                                      >
                                        AI Suggested Reply
                                      </div>{" "}
                                      <div
                                        style={{
                                          fontSize: 13,
                                          color: C.text,
                                          marginBottom: 8,
                                          lineHeight: 1.5,
                                        }}
                                      >
                                        {meta.suggestedReply}
                                      </div>
                                      {meta.serviceInterest && (
                                        <Badge
                                          label={meta.serviceInterest}
                                          color={C.teal}
                                          style={{ marginRight: 6 }}
                                        />
                                      )}
                                      {meta.urgency &&
                                        meta.urgency !== "normal" && (
                                          <Badge
                                            label={meta.urgency}
                                            color={
                                              meta.urgency === "urgent"
                                                ? C.red
                                                : C.amber
                                            }
                                            style={{ marginRight: 6 }}
                                          />
                                        )}
                                      <div style={{ marginTop: 10 }}>
                                        {" "}
                                        <Btn
                                          small
                                          color={C.teal}
                                          disabled={smsSending}
                                          onClick={async () => {
                                            setSmsSending(true);
                                            try {
                                              await adminFetch(
                                                `/admin/leads/${lead.id}/send-sms`,
                                                {
                                                  method: "POST",
                                                  body: {
                                                    message:
                                                      meta.suggestedReply,
                                                  },
                                                },
                                              );
                                              loadLeads();
                                              expandLead(lead);
                                            } catch (e) {
                                              alert(
                                                "Send failed: " + e.message,
                                              );
                                            }
                                            setSmsSending(false);
                                          }}
                                        >
                                          {smsSending
                                            ? "Sending..."
                                            : "Send This Reply"}
                                        </Btn>{" "}
                                      </div>{" "}
                                    </div>
                                  );
                                })()}
                                {/* Quick Actions */}
                                <div
                                  style={{
                                    display: "flex",
                                    gap: 8,
                                    flexWrap: "wrap",
                                    marginBottom: 12,
                                  }}
                                >
                                  {" "}
                                  <Btn
                                    small
                                    color={C.teal}
                                    onClick={() => {
                                      const name = lead.first_name || "there";
                                      const svc =
                                        lead.service_interest || "pest control";
                                      setSmsCompose({
                                        leadId: lead.id,
                                        message: "",
                                        suggestions: [
                                          `Hi ${name}! This is Adam from Waves Pest Control. I saw your inquiry about ${svc} — I'd love to help. When's a good time to chat?`,
                                          `Hey ${name}! Thanks for reaching out about ${svc}. We can usually get you on the schedule within a day or two. Want me to set up an estimate?`,
                                        ],
                                      });
                                    }}
                                  >
                                    Send Text
                                  </Btn>{" "}
                                  <Btn
                                    small
                                    color={C.purple}
                                    onClick={() => {
                                      navigate(
                                        `/admin/estimates?${leadEstimateParams(lead).toString()}`,
                                      );
                                    }}
                                  >
                                    Create Estimate
                                  </Btn>{" "}
                                  <Btn
                                    small
                                    color={C.amber}
                                    onClick={() =>
                                      setCallbackForm({
                                        leadId: lead.id,
                                        date: "",
                                        time: "",
                                        notes: "",
                                      })
                                    }
                                  >
                                    Schedule Callback
                                  </Btn>{" "}
                                  <Btn
                                    small
                                    color={C.green}
                                    onClick={() => {
                                      const interest = (
                                        lead.service_interest || ""
                                      )
                                        .trim()
                                        .toLowerCase();
                                      const match = interest
                                        ? services.find((s) =>
                                            [s.name, s.short_name, s.service_key]
                                              .filter(Boolean)
                                              .some((v) =>
                                                v
                                                  .toLowerCase()
                                                  .includes(interest),
                                              ),
                                          )
                                        : null;
                                      setApptForm({
                                        leadId: lead.id,
                                        date: "",
                                        time: "",
                                        serviceId: match ? match.id : "",
                                        serviceType: match
                                          ? match.name
                                          : lead.service_interest || "",
                                        technicianId: "",
                                        notes: "",
                                      });
                                    }}
                                  >
                                    Add Appt
                                  </Btn>
                                  {lead.phone && (
                                    <Btn
                                      small
                                      color={C.green}
                                      onClick={() =>
                                        callViaBridge(
                                          lead.phone,
                                          `${lead.first_name || ""} ${lead.last_name || ""}`.trim(),
                                        )
                                      }
                                    >
                                      Call Now
                                    </Btn>
                                  )}
                                  <Btn
                                    small
                                    color={C.green}
                                    onClick={() => {
                                      setFormData({ leadId: lead.id });
                                      setShowModal("convert");
                                    }}
                                  >
                                    Convert to Customer
                                  </Btn>{" "}
                                  <Btn
                                    small
                                    color={C.red}
                                    onClick={() => {
                                      setFormData({ leadId: lead.id });
                                      setShowModal("lost");
                                    }}
                                  >
                                    Mark Lost
                                  </Btn>{" "}
                                  <Btn
                                    small
                                    color={C.purple}
                                    onClick={() => {
                                      setFormData({ leadId: lead.id });
                                      setShowModal("assign");
                                    }}
                                  >
                                    Assign
                                  </Btn>{" "}
                                  <Btn
                                    small
                                    color={C.red}
                                    disabled={deletingLeadId === lead.id}
                                    style={{
                                      display: "inline-flex",
                                      alignItems: "center",
                                      gap: 6,
                                    }}
                                    onClick={() => deleteLead(lead)}
                                  >
                                    <Trash2 size={14} strokeWidth={1.8} />
                                    {deletingLeadId === lead.id
                                      ? "Deleting"
                                      : "Delete Lead"}
                                  </Btn>{" "}
                                </div>
                                {/* Inline SMS Compose */}
                                {smsCompose &&
                                  smsCompose.leadId === lead.id && (
                                    <div
                                      style={{
                                        border: `1px solid ${C.border}`,
                                        borderRadius: 10,
                                        padding: 14,
                                        marginBottom: 12,
                                        backgroundColor: C.card,
                                      }}
                                    >
                                      {" "}
                                      <div
                                        style={{
                                          fontSize: 12,
                                          color: C.teal,
                                          fontWeight: 600,
                                          marginBottom: 8,
                                        }}
                                      >
                                        Send SMS to {lead.first_name || "Lead"}
                                      </div>
                                      {smsCompose.suggestions &&
                                        smsCompose.suggestions.map((s, i) => (
                                          <div
                                            key={i}
                                            onClick={() =>
                                              setSmsCompose((prev) => ({
                                                ...prev,
                                                message: s,
                                              }))
                                            }
                                            style={{
                                              fontSize: 12,
                                              color: C.text,
                                              padding: "8px 10px",
                                              borderRadius: 6,
                                              border: `1px solid ${C.border}`,
                                              marginBottom: 6,
                                              cursor: "pointer",
                                              backgroundColor:
                                                smsCompose.message === s
                                                  ? C.teal + "22"
                                                  : "transparent",
                                              transition: "background 0.15s",
                                            }}
                                          >
                                            {s}
                                          </div>
                                        ))}
                                      <textarea
                                        value={smsCompose.message}
                                        onChange={(e) =>
                                          setSmsCompose((prev) => ({
                                            ...prev,
                                            message: e.target.value,
                                          }))
                                        }
                                        placeholder="Type your message..."
                                        style={{
                                          width: "100%",
                                          minHeight: 60,
                                          backgroundColor: C.input,
                                          border: `1px solid ${C.inputBorder}`,
                                          borderRadius: 8,
                                          padding: "8px 12px",
                                          color: C.text,
                                          fontSize: 13,
                                          resize: "vertical",
                                          boxSizing: "border-box",
                                          marginBottom: 8,
                                        }}
                                      />{" "}
                                      <div style={{ display: "flex", gap: 8 }}>
                                        {" "}
                                        <Btn
                                          small
                                          color={C.teal}
                                          disabled={
                                            smsSending || !smsCompose.message
                                          }
                                          onClick={async () => {
                                            setSmsSending(true);
                                            try {
                                              await adminFetch(
                                                `/admin/leads/${lead.id}/send-sms`,
                                                {
                                                  method: "POST",
                                                  body: {
                                                    message: smsCompose.message,
                                                  },
                                                },
                                              );
                                              setSmsCompose(null);
                                              loadLeads();
                                              expandLead(lead);
                                            } catch (e) {
                                              alert(
                                                "Send failed: " + e.message,
                                              );
                                            }
                                            setSmsSending(false);
                                          }}
                                        >
                                          {smsSending ? "Sending..." : "Send"}
                                        </Btn>{" "}
                                        <Btn
                                          small
                                          color={C.muted}
                                          onClick={() => setSmsCompose(null)}
                                        >
                                          Cancel
                                        </Btn>{" "}
                                      </div>{" "}
                                    </div>
                                  )}
                                {/* Inline Schedule Callback */}
                                {callbackForm &&
                                  callbackForm.leadId === lead.id && (
                                    <div
                                      style={{
                                        border: `1px solid ${C.border}`,
                                        borderRadius: 10,
                                        padding: 14,
                                        marginBottom: 12,
                                        backgroundColor: C.card,
                                      }}
                                    >
                                      {" "}
                                      <div
                                        style={{
                                          fontSize: 12,
                                          color: C.amber,
                                          fontWeight: 600,
                                          marginBottom: 8,
                                        }}
                                      >
                                        Schedule Callback
                                      </div>{" "}
                                      <div
                                        style={{
                                          display: "flex",
                                          gap: 8,
                                          marginBottom: 8,
                                        }}
                                      >
                                        {" "}
                                        <input
                                          type="date"
                                          value={callbackForm.date}
                                          onChange={(e) =>
                                            setCallbackForm((prev) => ({
                                              ...prev,
                                              date: e.target.value,
                                            }))
                                          }
                                          style={{
                                            flex: 1,
                                            backgroundColor: C.input,
                                            border: `1px solid ${C.inputBorder}`,
                                            borderRadius: 8,
                                            padding: "6px 10px",
                                            color: C.text,
                                            fontSize: 13,
                                          }}
                                        />{" "}
                                        <input
                                          type="time"
                                          value={callbackForm.time}
                                          onChange={(e) =>
                                            setCallbackForm((prev) => ({
                                              ...prev,
                                              time: e.target.value,
                                            }))
                                          }
                                          style={{
                                            flex: 1,
                                            backgroundColor: C.input,
                                            border: `1px solid ${C.inputBorder}`,
                                            borderRadius: 8,
                                            padding: "6px 10px",
                                            color: C.text,
                                            fontSize: 13,
                                          }}
                                        />{" "}
                                      </div>{" "}
                                      <textarea
                                        value={callbackForm.notes || ""}
                                        onChange={(e) =>
                                          setCallbackForm((prev) => ({
                                            ...prev,
                                            notes: e.target.value,
                                          }))
                                        }
                                        placeholder="Notes..."
                                        style={{
                                          width: "100%",
                                          minHeight: 40,
                                          backgroundColor: C.input,
                                          border: `1px solid ${C.inputBorder}`,
                                          borderRadius: 8,
                                          padding: "8px 12px",
                                          color: C.text,
                                          fontSize: 13,
                                          resize: "vertical",
                                          boxSizing: "border-box",
                                          marginBottom: 8,
                                        }}
                                      />{" "}
                                      <div style={{ display: "flex", gap: 8 }}>
                                        {" "}
                                        <Btn
                                          small
                                          color={C.amber}
                                          disabled={
                                            !callbackForm.date ||
                                            !callbackForm.time
                                          }
                                          onClick={async () => {
                                            try {
                                              await adminFetch(
                                                `/admin/leads/${lead.id}/schedule-callback`,
                                                {
                                                  method: "POST",
                                                  body: {
                                                    date: callbackForm.date,
                                                    time: callbackForm.time,
                                                    notes: callbackForm.notes,
                                                  },
                                                },
                                              );
                                              setCallbackForm(null);
                                              loadLeads();
                                              expandLead(lead);
                                            } catch (e) {
                                              alert("Failed: " + e.message);
                                            }
                                          }}
                                        >
                                          Save
                                        </Btn>{" "}
                                        <Btn
                                          small
                                          color={C.muted}
                                          onClick={() => setCallbackForm(null)}
                                        >
                                          Cancel
                                        </Btn>{" "}
                                      </div>{" "}
                                    </div>
                                  )}
                                {/* Inline Add Appointment */}
                                {apptForm && apptForm.leadId === lead.id && (
                                  <div
                                    style={{
                                      border: `1px solid ${C.border}`,
                                      borderRadius: 10,
                                      padding: 14,
                                      marginBottom: 12,
                                      backgroundColor: C.card,
                                    }}
                                  >
                                    <div
                                      style={{
                                        fontSize: 12,
                                        color: C.green,
                                        fontWeight: 600,
                                        marginBottom: 8,
                                      }}
                                    >
                                      Add Appointment
                                    </div>
                                    <div
                                      style={{
                                        display: "flex",
                                        gap: 8,
                                        marginBottom: 8,
                                      }}
                                    >
                                      <input
                                        type="date"
                                        value={apptForm.date}
                                        onChange={(e) =>
                                          setApptForm((prev) => ({
                                            ...prev,
                                            date: e.target.value,
                                          }))
                                        }
                                        style={{
                                          flex: 1,
                                          backgroundColor: C.input,
                                          border: `1px solid ${C.inputBorder}`,
                                          borderRadius: 8,
                                          padding: "6px 10px",
                                          color: C.text,
                                          fontSize: 13,
                                        }}
                                      />
                                      <input
                                        type="time"
                                        value={apptForm.time}
                                        onChange={(e) =>
                                          setApptForm((prev) => ({
                                            ...prev,
                                            time: e.target.value,
                                          }))
                                        }
                                        style={{
                                          flex: 1,
                                          backgroundColor: C.input,
                                          border: `1px solid ${C.inputBorder}`,
                                          borderRadius: 8,
                                          padding: "6px 10px",
                                          color: C.text,
                                          fontSize: 13,
                                        }}
                                      />
                                    </div>
                                    <div
                                      style={{
                                        display: "flex",
                                        gap: 8,
                                        marginBottom: 8,
                                      }}
                                    >
                                      <select
                                        value={apptForm.serviceId}
                                        onChange={(e) => {
                                          const sid = e.target.value;
                                          const svc = services.find(
                                            (s) => String(s.id) === sid,
                                          );
                                          setApptForm((prev) => ({
                                            ...prev,
                                            serviceId: sid,
                                            serviceType: svc
                                              ? svc.name
                                              : lead.service_interest || "",
                                          }));
                                        }}
                                        style={{
                                          flex: 2,
                                          backgroundColor: C.input,
                                          border: `1px solid ${C.inputBorder}`,
                                          borderRadius: 8,
                                          padding: "6px 10px",
                                          color: C.text,
                                          fontSize: 13,
                                        }}
                                      >
                                        <option value="">
                                          {lead.service_interest
                                            ? `${lead.service_interest} (from lead)`
                                            : "— Select a service —"}
                                        </option>
                                        {services.map((s) => (
                                          <option key={s.id} value={s.id}>
                                            {s.name}
                                          </option>
                                        ))}
                                      </select>
                                      <select
                                        value={apptForm.technicianId}
                                        onChange={(e) =>
                                          setApptForm((prev) => ({
                                            ...prev,
                                            technicianId: e.target.value,
                                          }))
                                        }
                                        style={{
                                          flex: 1,
                                          backgroundColor: C.input,
                                          border: `1px solid ${C.inputBorder}`,
                                          borderRadius: 8,
                                          padding: "6px 10px",
                                          color: C.text,
                                          fontSize: 13,
                                        }}
                                      >
                                        <option value="">— Unassigned —</option>
                                        {techs.map((t) => (
                                          <option key={t.id} value={t.id}>
                                            {t.first_name} {t.last_name || ""}
                                          </option>
                                        ))}
                                      </select>
                                    </div>
                                    <textarea
                                      value={apptForm.notes || ""}
                                      onChange={(e) =>
                                        setApptForm((prev) => ({
                                          ...prev,
                                          notes: e.target.value,
                                        }))
                                      }
                                      placeholder="Notes for this appointment..."
                                      style={{
                                        width: "100%",
                                        minHeight: 40,
                                        backgroundColor: C.input,
                                        border: `1px solid ${C.inputBorder}`,
                                        borderRadius: 8,
                                        padding: "8px 12px",
                                        color: C.text,
                                        fontSize: 13,
                                        resize: "vertical",
                                        boxSizing: "border-box",
                                        marginBottom: 8,
                                      }}
                                    />
                                    <div
                                      style={{
                                        fontSize: 11,
                                        color: C.muted,
                                        marginBottom: 8,
                                      }}
                                    >
                                      Saving creates a customer from this lead
                                      (if not already linked) and marks the lead
                                      won.
                                    </div>
                                    <div style={{ display: "flex", gap: 8 }}>
                                      <Btn
                                        small
                                        color={C.green}
                                        disabled={
                                          apptSaving ||
                                          !apptForm.date ||
                                          !apptForm.time ||
                                          !(apptForm.serviceType || "").trim()
                                        }
                                        onClick={async () => {
                                          setApptSaving(true);
                                          try {
                                            await adminFetch(
                                              `/admin/leads/${lead.id}/schedule-appointment`,
                                              {
                                                method: "POST",
                                                body: {
                                                  date: apptForm.date,
                                                  time: apptForm.time,
                                                  serviceType:
                                                    apptForm.serviceType,
                                                  serviceId:
                                                    apptForm.serviceId || null,
                                                  technicianId:
                                                    apptForm.technicianId ||
                                                    null,
                                                  notes: apptForm.notes,
                                                },
                                              },
                                            );
                                            setApptForm(null);
                                            loadLeads();
                                            expandLead(lead);
                                          } catch (e) {
                                            alert("Failed: " + e.message);
                                          }
                                          setApptSaving(false);
                                        }}
                                      >
                                        {apptSaving ? "Saving..." : "Save"}
                                      </Btn>
                                      <Btn
                                        small
                                        color={C.muted}
                                        onClick={() => setApptForm(null)}
                                      >
                                        Cancel
                                      </Btn>
                                    </div>
                                  </div>
                                )}
                              </div>{" "}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {leads.length === 0 && (
                    <tr>
                      <td
                        colSpan={isMobile ? 2 : 7}
                        style={{
                          padding: 40,
                          textAlign: "center",
                          color: C.muted,
                        }}
                      >
                        No leads found
                      </td>
                    </tr>
                  )}
                </tbody>{" "}
              </table>{" "}
            </Card>
            {/* Pagination */}
            {leadsTotal > 50 && (
              <div
                style={{
                  display: "flex",
                  justifyContent: "center",
                  gap: 8,
                  marginTop: 16,
                }}
              >
                {" "}
                <Btn
                  small
                  disabled={filters.page <= 1}
                  onClick={() =>
                    setFilters((f) => ({ ...f, page: f.page - 1 }))
                  }
                >
                  Prev
                </Btn>{" "}
                <span
                  style={{
                    color: C.muted,
                    fontSize: 13,
                    alignSelf: "center",
                    ...mono,
                  }}
                >
                  Page {filters.page} of {Math.ceil(leadsTotal / 50)}
                </span>{" "}
                <Btn
                  small
                  disabled={filters.page >= Math.ceil(leadsTotal / 50)}
                  onClick={() =>
                    setFilters((f) => ({ ...f, page: f.page + 1 }))
                  }
                >
                  Next
                </Btn>{" "}
              </div>
            )}
          </>
        )}

        {pipelineView === "board" && (
          <div
            style={{
              display: "flex",
              gap: 12,
              overflowX: "auto",
              paddingBottom: 8,
            }}
          >
            {BOARD_STAGES.map((stage) => {
              const stageLeads = leads.filter((lead) => lead.status === stage);
              const isDropTarget =
                draggingLead && draggingLead.status !== stage;
              return (
                <div
                  key={stage}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => handleBoardDrop(e, stage)}
                  style={{
                    flex: "0 0 260px",
                    minWidth: 240,
                    backgroundColor: C.bg,
                    border: `1px solid ${isDropTarget ? STATUS_COLORS[stage] : C.border}`,
                    borderRadius: 10,
                    padding: 10,
                  }}
                >
                  {" "}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 10,
                    }}
                  >
                    {" "}
                    <span
                      style={{
                        width: 9,
                        height: 9,
                        borderRadius: 9999,
                        backgroundColor: STATUS_COLORS[stage] || C.muted,
                        display: "inline-block",
                      }}
                    />{" "}
                    <span
                      style={{
                        color: C.heading,
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        flex: 1,
                      }}
                    >
                      {stage.replace(/_/g, " ")}
                    </span>{" "}
                    <span style={{ color: C.muted, fontSize: 12, ...mono }}>
                      {stageLeads.length}
                    </span>{" "}
                  </div>{" "}
                  <div
                    style={{
                      maxHeight: "70vh",
                      overflowY: "auto",
                      display: "flex",
                      flexDirection: "column",
                      gap: 8,
                    }}
                  >
                    {stageLeads.map((lead) => (
                      <div
                        key={lead.id}
                        draggable
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", String(lead.id));
                          setDraggingLeadId(lead.id);
                        }}
                        onDragEnd={() => setDraggingLeadId(null)}
                        onClick={() => {
                          setPipelineView("table");
                          expandLead(lead);
                        }}
                        style={{
                          backgroundColor: C.card,
                          border: `1px solid ${C.border}`,
                          borderRadius: 8,
                          padding: 10,
                          cursor: "grab",
                          opacity: draggingLeadId === lead.id ? 0.4 : 1,
                        }}
                      >
                        {" "}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            marginBottom: 6,
                          }}
                        >
                          {" "}
                          <div
                            style={{
                              color: C.heading,
                              fontSize: 13,
                              fontWeight: 600,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                              flex: 1,
                            }}
                          >
                            {[lead.first_name, lead.last_name]
                              .filter(Boolean)
                              .join(" ") || "Unknown"}
                          </div>{" "}
                          <AgingBadge lead={lead} />{" "}
                        </div>{" "}
                        <div
                          style={{
                            color: C.muted,
                            fontSize: 12,
                            ...mono,
                            marginBottom: 5,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {lead.phone || lead.email || "--"}
                        </div>{" "}
                        <div
                          style={{
                            color: C.text,
                            fontSize: 12,
                            marginBottom: 8,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                        >
                          {lead.service_interest || "--"}
                        </div>{" "}
                        <div
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 6,
                            flexWrap: "wrap",
                          }}
                        >
                          {lead.source_name && (
                            <Badge
                              label={
                                lead.source_name.length > 16
                                  ? lead.source_name.slice(0, 13) + "..."
                                  : lead.source_name
                              }
                              color={C.teal}
                            />
                          )}
                          {lead.urgency && lead.urgency !== "normal" && (
                            <Badge
                              label={lead.urgency}
                              color={
                                lead.urgency === "urgent" ? C.red : C.amber
                              }
                            />
                          )}
                        </div>{" "}
                        <button
                          type="button"
                          aria-label={`Delete lead for ${
                            [lead.first_name, lead.last_name]
                              .filter(Boolean)
                              .join(" ") || "unknown"
                          }`}
                          title="Delete lead"
                          disabled={deletingLeadId === lead.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteLead(lead);
                          }}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            gap: 5,
                            marginTop: 10,
                            border: `1px solid ${C.red}33`,
                            borderRadius: 6,
                            padding: "4px 7px",
                            background: C.white,
                            color: C.red,
                            fontSize: 11,
                            fontWeight: 600,
                            cursor:
                              deletingLeadId === lead.id
                                ? "not-allowed"
                                : "pointer",
                            opacity: deletingLeadId === lead.id ? 0.5 : 1,
                          }}
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                          {deletingLeadId === lead.id ? "Deleting" : "Delete"}
                        </button>
                      </div>
                    ))}
                    {stageLeads.length === 0 && (
                      <div
                        style={{
                          color: C.muted,
                          fontSize: 12,
                          fontStyle: "italic",
                          padding: "12px 4px",
                          textAlign: "center",
                        }}
                      >
                        Drop here
                      </div>
                    )}
                  </div>{" "}
                </div>
              );
            })}
          </div>
        )}
      </>
    );
  };

  // ═════════════════════════════════════════════════════════════════════════
  // SOURCES TAB
  // ═════════════════════════════════════════════════════════════════════════
  const [expandedSource, setExpandedSource] = useState(null);
  const [sourceROI, setSourceROI] = useState(null);

  const expandSource = async (source) => {
    if (expandedSource === source.id) {
      setExpandedSource(null);
      return;
    }
    setExpandedSource(source.id);
    try {
      const data = await adminFetch(`/admin/leads/sources/${source.id}`);
      setSourceROI(data);
    } catch (e) {
      setSourceROI(null);
    }
  };

  const renderSources = () => {
    // Real revenue-based ROI per source from /analytics/by-source (same backend
    // as Channel Comparison / ROI Matrix / Phone Number ROI), keyed by id.
    const roiBySourceId = new Map(sourcesRoi.map((b) => [b.source?.id, b]));
    return (
      <>
        {" "}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 16,
          }}
        >
          {" "}
          <h2
            style={{
              margin: 0,
              color: C.heading,
              fontSize: 12,
              fontWeight: 500,
              fontFamily: ROBOTO,
              letterSpacing: "0.02em",
            }}
          >
            Lead Sources ({sources.length})
          </h2>{" "}
          <div style={{ display: "flex", gap: 8 }}>
            {" "}
            <Btn
              small
              onClick={() => {
                setFormData({
                  source_type: "phone_tracking",
                  cost_type: "per_month",
                });
                setShowModal("newSource");
              }}
            >
              + Add Source
            </Btn>{" "}
          </div>{" "}
        </div>{" "}
        <Card style={{ padding: 0, overflow: "auto" }}>
          {" "}
          <table
            style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}
          >
            {" "}
            <thead>
              {" "}
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {[
                  "Source",
                  "Type",
                  "Channel",
                  "Monthly Cost",
                  "Leads (Mo)",
                  "Conversions",
                  "Conv %",
                  "Cost/Lead",
                  "Cost/Acq",
                  "ROI %",
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "12px 14px",
                      textAlign: "left",
                      fontSize: 11,
                      color: C.muted,
                      fontWeight: 600,
                      textTransform: "uppercase",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {sources.map((src) => {
                const monthLeads = parseInt(src.month_leads || 0);
                const monthConv = parseInt(src.month_conversions || 0);
                const convRate =
                  monthLeads > 0 ? (monthConv / monthLeads) * 100 : 0;
                const mc = parseFloat(src.monthly_cost || 0);
                // Real revenue-based cost + ROI from the analytics backend when
                // the source is active; fall back to the configured monthly cost
                // for inactive sources that have no ROI row.
                const r = roiBySourceId.get(src.id);
                const cpl = r
                  ? r.costPerLead
                  : monthLeads > 0
                    ? mc / monthLeads
                    : 0;
                const cpa = r
                  ? r.costPerAcquisition
                  : monthConv > 0
                    ? mc / monthConv
                    : 0;
                const roi = r ? r.roi : null;
                // Negative ROI (spend, no revenue) is meaningful — only blank it
                // when the source had no cost AND no revenue in range.
                const hasRoiSignal =
                  !!r && (r.totalCost > 0 || r.totalRevenue > 0);
                // Expanded-row totals come from the globally-attributed table row
                // (r) so they agree with the row above; /sources/:id (sourceROI)
                // has no winner map and would show un-attributed revenue.
                const detail = r || sourceROI;
                const isExp = expandedSource === src.id;

                return (
                  <React.Fragment key={src.id}>
                    {" "}
                    <tr
                      onClick={() => expandSource(src)}
                      style={{
                        borderBottom: `1px solid ${C.border}`,
                        cursor: "pointer",
                        backgroundColor: isExp ? C.cardHover : "transparent",
                        opacity: src.is_active ? 1 : 0.5,
                      }}
                    >
                      {" "}
                      <td style={{ padding: "12px 14px" }}>
                        {" "}
                        <div
                          style={{
                            color: C.heading,
                            fontSize: 13,
                            fontWeight: 500,
                          }}
                        >
                          {src.name}
                        </div>
                        {src.domain && (
                          <div style={{ color: C.muted, fontSize: 11 }}>
                            {src.domain}
                          </div>
                        )}
                      </td>{" "}
                      <td style={{ padding: "12px 14px" }}>
                        <Badge
                          label={src.source_type?.replace(/_/g, " ")}
                          color={C.teal}
                        />
                      </td>{" "}
                      <td
                        style={{
                          padding: "12px 14px",
                          color: C.text,
                          fontSize: 13,
                        }}
                      >
                        {src.channel || "--"}
                      </td>{" "}
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 13,
                          color: C.text,
                        }}
                      >
                        {fmtMoney(mc)}
                      </td>{" "}
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 13,
                          color: C.heading,
                        }}
                      >
                        {monthLeads}
                      </td>{" "}
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 13,
                          color: C.green,
                        }}
                      >
                        {monthConv}
                      </td>{" "}
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 13,
                          color:
                            convRate > 20
                              ? C.green
                              : convRate > 10
                                ? C.amber
                                : C.muted,
                        }}
                      >
                        {fmtPct(convRate)}
                      </td>{" "}
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 13,
                          color: C.text,
                        }}
                      >
                        {cpl > 0 ? fmtMoney(cpl) : "--"}
                      </td>{" "}
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 13,
                          color: C.text,
                        }}
                      >
                        {cpa > 0 ? fmtMoney(cpa) : "--"}
                      </td>{" "}
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 13,
                          fontWeight: 600,
                          color: roiColor(roi || 0),
                        }}
                      >
                        {hasRoiSignal ? fmtPct(roi) : "--"}
                      </td>{" "}
                    </tr>
                    {isExp && detail && (
                      <tr>
                        <td colSpan={10} style={{ padding: 0 }}>
                          {" "}
                          <div
                            style={{
                              padding: "16px 24px",
                              backgroundColor: C.bg,
                              borderBottom: `1px solid ${C.border}`,
                            }}
                          >
                            {" "}
                            <div
                              style={{
                                display: "flex",
                                gap: 24,
                                flexWrap: "wrap",
                                marginBottom: 12,
                              }}
                            >
                              {" "}
                              <div>
                                <span style={{ color: C.muted, fontSize: 12 }}>
                                  Total Leads:{" "}
                                </span>
                                <span style={{ color: C.heading, ...mono }}>
                                  {detail.totalLeads}
                                </span>
                              </div>{" "}
                              <div>
                                <span style={{ color: C.muted, fontSize: 12 }}>
                                  Conversions:{" "}
                                </span>
                                <span style={{ color: C.green, ...mono }}>
                                  {detail.conversions}
                                </span>
                              </div>{" "}
                              <div>
                                <span style={{ color: C.muted, fontSize: 12 }}>
                                  Total Cost:{" "}
                                </span>
                                <span style={{ color: C.text, ...mono }}>
                                  {fmtMoney(detail.totalCost)}
                                </span>
                              </div>{" "}
                              <div>
                                <span style={{ color: C.muted, fontSize: 12 }}>
                                  Total Revenue:{" "}
                                </span>
                                <span style={{ color: C.green, ...mono }}>
                                  {fmtMoney(detail.totalRevenue)}
                                </span>
                              </div>{" "}
                              <div>
                                <span style={{ color: C.muted, fontSize: 12 }}>
                                  ROI:{" "}
                                </span>
                                <span
                                  style={{
                                    ...mono,
                                    color: roiColor(detail.roi),
                                  }}
                                >
                                  {fmtPct(detail.roi)}
                                </span>
                              </div>{" "}
                              <div>
                                <span style={{ color: C.muted, fontSize: 12 }}>
                                  Avg Response:{" "}
                                </span>
                                <span style={{ color: C.text, ...mono }}>
                                  {fmtTime(detail.avgResponseTime)}
                                </span>
                              </div>{" "}
                            </div>{" "}
                            <Btn
                              small
                              color={C.amber}
                              onClick={() => {
                                setFormData({
                                  sourceId: src.id,
                                  cost_category: "monthly_fee",
                                });
                                setShowModal("logCost");
                              }}
                            >
                              Log Cost
                            </Btn>{" "}
                          </div>{" "}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>{" "}
          </table>{" "}
        </Card>{" "}
      </>
    );
  };

  // ═════════════════════════════════════════════════════════════════════════
  // ROI ANALYTICS TAB
  // ═════════════════════════════════════════════════════════════════════════
  const renderAnalytics = () => {
    const maxChannelVal = Math.max(
      ...byChannel.map((c) => Math.max(c.totalCost, c.totalRevenue)),
      1,
    );

    // Scatter plot data
    const scatterSources = bySource.filter((s) => s.totalLeads > 0);
    const maxCost = Math.max(...scatterSources.map((s) => s.totalCost), 1);
    const maxRev = Math.max(...scatterSources.map((s) => s.totalRevenue), 1);
    const maxLeads = Math.max(...scatterSources.map((s) => s.totalLeads), 1);

    // Response time data
    const maxResp = Math.max(...responseBuckets.map((b) => b.total), 1);

    // Lost reasons pie
    const totalLost = lostReasons.reduce((s, r) => s + r.count, 0);
    const pieColors = [
      C.red,
      C.heading,
      C.text,
      C.green,
      C.amber,
      C.muted,
      "#A1A1AA",
    ];

    // Phone number ROI
    const phoneROI = bySource.filter((s) => s.source?.twilio_phone_number);

    return (
      <>
        {/* Channel Comparison */}
        <Card style={{ marginBottom: 24 }}>
          {" "}
          <h2
            style={{
              margin: "0 0 16px",
              color: C.heading,
              fontSize: 12,
              fontWeight: 500,
              fontFamily: ROBOTO,
              letterSpacing: "0.02em",
            }}
          >
            Channel Comparison
          </h2>
          {byChannel.length === 0 && (
            <div style={{ color: C.muted, fontSize: 13 }}>
              No channel data available yet
            </div>
          )}
          {byChannel.map((ch) => (
            <div key={ch.channel} style={{ marginBottom: 12 }}>
              {" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  fontSize: 12,
                  marginBottom: 4,
                }}
              >
                {" "}
                <span style={{ color: C.text, fontWeight: 500 }}>
                  {ch.channel}
                </span>{" "}
                <span style={{ color: C.muted, ...mono }}>
                  Leads: {ch.totalLeads} | Conv: {ch.conversions} | ROI:{" "}
                  {fmtPct(ch.roi)}
                </span>{" "}
              </div>{" "}
              <div style={{ display: "flex", gap: 2, height: 16 }}>
                {" "}
                <div
                  style={{
                    width: `${(ch.totalCost / maxChannelVal) * 100}%`,
                    height: "100%",
                    backgroundColor: C.red + "88",
                    borderRadius: "3px 0 0 3px",
                    minWidth: ch.totalCost > 0 ? 2 : 0,
                  }}
                />{" "}
                <div
                  style={{
                    width: `${(ch.totalRevenue / maxChannelVal) * 100}%`,
                    height: "100%",
                    backgroundColor: C.green + "88",
                    borderRadius: "0 3px 3px 0",
                    minWidth: ch.totalRevenue > 0 ? 2 : 0,
                  }}
                />{" "}
              </div>{" "}
              <div
                style={{
                  display: "flex",
                  gap: 16,
                  fontSize: 10,
                  color: C.muted,
                  marginTop: 2,
                }}
              >
                {" "}
                <span>Cost: {fmtMoney(ch.totalCost)}</span>{" "}
                <span>Revenue: {fmtMoney(ch.totalRevenue)}</span>{" "}
              </div>{" "}
            </div>
          ))}
          <div
            style={{
              display: "flex",
              gap: 16,
              fontSize: 11,
              color: C.muted,
              marginTop: 8,
            }}
          >
            {" "}
            <span>
              <span
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 12,
                  backgroundColor: C.red + "88",
                  borderRadius: 2,
                  verticalAlign: "middle",
                  marginRight: 4,
                }}
              />
              Cost
            </span>{" "}
            <span>
              <span
                style={{
                  display: "inline-block",
                  width: 12,
                  height: 12,
                  backgroundColor: C.green + "88",
                  borderRadius: 2,
                  verticalAlign: "middle",
                  marginRight: 4,
                }}
              />
              Revenue
            </span>{" "}
          </div>{" "}
        </Card>
        {/* Source ROI Matrix */}
        <Card style={{ marginBottom: 24 }}>
          {" "}
          <h2
            style={{
              margin: "0 0 16px",
              color: C.heading,
              fontSize: 12,
              fontWeight: 500,
              fontFamily: ROBOTO,
              letterSpacing: "0.02em",
            }}
          >
            Source ROI Matrix
          </h2>
          {scatterSources.length === 0 ? (
            <div style={{ color: C.muted, fontSize: 13 }}>
              No source data with leads yet
            </div>
          ) : (
            <svg
              viewBox="0 0 400 300"
              style={{ width: "100%", maxWidth: 600, height: "auto" }}
            >
              {/* Quadrant lines */}
              <line
                x1="200"
                y1="10"
                x2="200"
                y2="280"
                stroke={C.border}
                strokeDasharray="4"
              />{" "}
              <line
                x1="20"
                y1="145"
                x2="380"
                y2="145"
                stroke={C.border}
                strokeDasharray="4"
              />
              {/* Quadrant labels */}
              <text
                x="110"
                y="80"
                fill={C.muted}
                fontSize="9"
                textAnchor="middle"
              >
                Question Marks
              </text>{" "}
              <text
                x="300"
                y="80"
                fill={C.heading}
                fontSize="9"
                textAnchor="middle"
              >
                Stars
              </text>{" "}
              <text
                x="110"
                y="230"
                fill={C.muted}
                fontSize="9"
                textAnchor="middle"
              >
                Dogs
              </text>{" "}
              <text
                x="300"
                y="230"
                fill={C.text}
                fontSize="9"
                textAnchor="middle"
              >
                Cash Cows
              </text>
              {/* Axes */}
              <text
                x="200"
                y="296"
                fill={C.muted}
                fontSize="9"
                textAnchor="middle"
              >
                Revenue --&gt;
              </text>{" "}
              <text
                x="12"
                y="145"
                fill={C.muted}
                fontSize="9"
                textAnchor="middle"
                transform="rotate(-90 12 145)"
              >
                Cost --&gt;
              </text>
              {/* Dots */}
              {scatterSources.map((s, i) => {
                const x = 30 + (s.totalRevenue / maxRev) * 340;
                const y = 270 - (s.totalCost / maxCost) * 250;
                const r = Math.max(
                  4,
                  Math.min(20, (s.totalLeads / maxLeads) * 18),
                );
                const c =
                  s.roi > 200
                    ? C.heading
                    : s.roi > 50
                      ? C.green
                      : s.roi > 0
                        ? C.amber
                        : C.red;
                return (
                  <g key={i}>
                    {" "}
                    <circle cx={x} cy={y} r={r} fill={c} opacity={0.7} />{" "}
                    <title>
                      {s.source?.name}: Cost {fmtMoney(s.totalCost)}, Rev{" "}
                      {fmtMoney(s.totalRevenue)}, {s.totalLeads} leads, ROI{" "}
                      {fmtPct(s.roi)}
                    </title>{" "}
                  </g>
                );
              })}
            </svg>
          )}
        </Card>{" "}
        <div
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            marginBottom: 24,
          }}
        >
          {/* Response Time vs Conversion */}
          <Card style={{ flex: "1 1 400px" }}>
            {" "}
            <h2
              style={{
                margin: "0 0 16px",
                color: C.heading,
                fontSize: 12,
                fontWeight: 500,
                fontFamily: ROBOTO,
                letterSpacing: "0.02em",
              }}
            >
              Response Time vs Conversion
            </h2>
            <div
              style={{
                margin: "-12px 0 14px",
                color: C.muted,
                fontSize: 11,
                fontFamily: ROBOTO,
              }}
            >
              Year to date
            </div>
            {responseBuckets.length === 0 ? (
              <div style={{ color: C.muted, fontSize: 13 }}>
                No response data yet
              </div>
            ) : (
              <div
                style={{
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 6,
                  height: 140,
                }}
              >
                {responseBuckets.map((b, i) => {
                  const h = Math.max(8, (b.total / maxResp) * 120);
                  const wonH = b.total > 0 ? (b.won / b.total) * h : 0;
                  return (
                    <div key={i} style={{ flex: 1, textAlign: "center" }}>
                      {" "}
                      <div
                        style={{
                          fontSize: 11,
                          color: C.heading,
                          ...mono,
                          marginBottom: 4,
                        }}
                      >
                        {b.conversionRate}%
                      </div>{" "}
                      <div
                        style={{
                          position: "relative",
                          height: h,
                          margin: "0 auto",
                          width: "80%",
                          minWidth: 16,
                        }}
                      >
                        {" "}
                        <div
                          style={{
                            position: "absolute",
                            bottom: 0,
                            width: "100%",
                            height: h,
                            backgroundColor: C.border,
                            borderRadius: "4px 4px 0 0",
                          }}
                        />{" "}
                        <div
                          style={{
                            position: "absolute",
                            bottom: 0,
                            width: "100%",
                            height: wonH,
                            backgroundColor: C.green,
                            borderRadius: wonH >= h ? "4px 4px 0 0" : "0 0 0 0",
                          }}
                        />{" "}
                      </div>{" "}
                      <div
                        style={{
                          fontSize: 9,
                          color: C.muted,
                          marginTop: 6,
                          lineHeight: 1.2,
                        }}
                      >
                        {b.label}
                      </div>{" "}
                      <div style={{ fontSize: 10, color: C.muted, ...mono }}>
                        {b.total}
                      </div>{" "}
                    </div>
                  );
                })}
              </div>
            )}
            <div
              style={{
                display: "flex",
                gap: 12,
                fontSize: 11,
                color: C.muted,
                marginTop: 12,
              }}
            >
              {" "}
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    backgroundColor: C.border,
                    borderRadius: 2,
                    verticalAlign: "middle",
                    marginRight: 4,
                  }}
                />
                Total
              </span>{" "}
              <span>
                <span
                  style={{
                    display: "inline-block",
                    width: 10,
                    height: 10,
                    backgroundColor: C.green,
                    borderRadius: 2,
                    verticalAlign: "middle",
                    marginRight: 4,
                  }}
                />
                Won
              </span>{" "}
            </div>{" "}
          </Card>
          {/* Lost Lead Analysis */}
          <Card style={{ flex: "1 1 300px" }}>
            {" "}
            <h2
              style={{
                margin: "0 0 16px",
                color: C.heading,
                fontSize: 12,
                fontWeight: 500,
                fontFamily: ROBOTO,
                letterSpacing: "0.02em",
              }}
            >
              Lost Lead Reasons
            </h2>
            <div
              style={{
                margin: "-12px 0 14px",
                color: C.muted,
                fontSize: 11,
                fontFamily: ROBOTO,
              }}
            >
              Year to date
            </div>
            {totalLost === 0 ? (
              <div style={{ color: C.muted, fontSize: 13 }}>
                No lost leads yet
              </div>
            ) : (
              <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                {" "}
                <svg
                  viewBox="0 0 100 100"
                  style={{ width: 120, height: 120, flexShrink: 0 }}
                >
                  {(() => {
                    let cumAngle = 0;
                    return lostReasons.slice(0, 7).map((r, i) => {
                      const pct = r.count / totalLost;
                      const angle = pct * 360;
                      const startAngle = cumAngle;
                      cumAngle += angle;
                      const startRad = ((startAngle - 90) * Math.PI) / 180;
                      const endRad = ((cumAngle - 90) * Math.PI) / 180;
                      const largeArc = angle > 180 ? 1 : 0;
                      const x1 = 50 + 45 * Math.cos(startRad);
                      const y1 = 50 + 45 * Math.sin(startRad);
                      const x2 = 50 + 45 * Math.cos(endRad);
                      const y2 = 50 + 45 * Math.sin(endRad);
                      if (lostReasons.length === 1) {
                        return (
                          <circle
                            key={i}
                            cx="50"
                            cy="50"
                            r="45"
                            fill={pieColors[i % pieColors.length]}
                          />
                        );
                      }
                      return (
                        <path
                          key={i}
                          d={`M50,50 L${x1},${y1} A45,45 0 ${largeArc},1 ${x2},${y2} Z`}
                          fill={pieColors[i % pieColors.length]}
                        />
                      );
                    });
                  })()}
                </svg>{" "}
                <div>
                  {lostReasons.slice(0, 7).map((r, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: 12,
                        marginBottom: 4,
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                      }}
                    >
                      {" "}
                      <span
                        style={{
                          display: "inline-block",
                          width: 10,
                          height: 10,
                          borderRadius: 2,
                          backgroundColor: pieColors[i % pieColors.length],
                          flexShrink: 0,
                        }}
                      />{" "}
                      <span style={{ color: C.text }}>{r.reason}</span>{" "}
                      <span style={{ color: C.muted, ...mono }}>
                        {r.count}
                      </span>{" "}
                    </div>
                  ))}
                </div>{" "}
              </div>
            )}
          </Card>{" "}
        </div>
        {/* Phone Number ROI Table */}
        <Card style={{ padding: 0, overflow: "auto" }}>
          {" "}
          <div
            style={{
              padding: "16px 20px",
              borderBottom: `1px solid ${C.border}`,
            }}
          >
            {" "}
            <h2
              style={{
                margin: 0,
                color: C.heading,
                fontSize: 12,
                fontWeight: 500,
                fontFamily: ROBOTO,
                letterSpacing: "0.02em",
              }}
            >
              Phone Number ROI
            </h2>{" "}
          </div>{" "}
          <table
            style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}
          >
            {" "}
            <thead>
              {" "}
              <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                {[
                  "Number",
                  "Source",
                  "Cost",
                  "Leads",
                  "Conversions",
                  "Revenue",
                  "ROI %",
                ].map((h) => (
                  <th
                    key={h}
                    style={{
                      padding: "10px 14px",
                      textAlign: "left",
                      fontSize: 11,
                      color: C.muted,
                      fontWeight: 600,
                      textTransform: "uppercase",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>{" "}
            </thead>{" "}
            <tbody>
              {phoneROI.map((s, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  {" "}
                  <td
                    style={{
                      padding: "10px 14px",
                      color: C.teal,
                      ...mono,
                      fontSize: 13,
                    }}
                  >
                    {s.source?.twilio_phone_number}
                  </td>{" "}
                  <td
                    style={{
                      padding: "10px 14px",
                      color: C.text,
                      fontSize: 13,
                    }}
                  >
                    {s.source?.name?.slice(0, 30)}
                  </td>{" "}
                  <td
                    style={{
                      padding: "10px 14px",
                      ...mono,
                      fontSize: 13,
                      color: C.text,
                    }}
                  >
                    {fmtMoney(s.totalCost)}
                  </td>{" "}
                  <td
                    style={{
                      padding: "10px 14px",
                      ...mono,
                      fontSize: 13,
                      color: C.heading,
                    }}
                  >
                    {s.totalLeads}
                  </td>{" "}
                  <td
                    style={{
                      padding: "10px 14px",
                      ...mono,
                      fontSize: 13,
                      color: C.green,
                    }}
                  >
                    {s.conversions}
                  </td>{" "}
                  <td
                    style={{
                      padding: "10px 14px",
                      ...mono,
                      fontSize: 13,
                      color: C.green,
                    }}
                  >
                    {fmtMoney(s.totalRevenue)}
                  </td>{" "}
                  <td
                    style={{
                      padding: "10px 14px",
                      ...mono,
                      fontSize: 13,
                      fontWeight: 600,
                      color: roiColor(s.roi),
                    }}
                  >
                    {s.roi > 0 ? fmtPct(s.roi) : "--"}
                  </td>{" "}
                </tr>
              ))}
              {phoneROI.length === 0 && (
                <tr>
                  <td
                    colSpan={7}
                    style={{ padding: 30, textAlign: "center", color: C.muted }}
                  >
                    No phone source data yet
                  </td>
                </tr>
              )}
            </tbody>{" "}
          </table>{" "}
        </Card>{" "}
      </>
    );
  };

  // ═════════════════════════════════════════════════════════════════════════
  // MODALS
  // ═════════════════════════════════════════════════════════════════════════
  const renderModal = () => {
    if (!showModal) return null;

    if (showModal === "newLead")
      return (
        <Modal title="New Lead" onClose={() => setShowModal(null)}>
          {" "}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {" "}
            <div style={{ flex: "1 1 45%" }}>
              <Input
                label="First Name"
                value={formData.first_name}
                onChange={(v) => setFormData((f) => ({ ...f, first_name: v }))}
              />
            </div>{" "}
            <div style={{ flex: "1 1 45%" }}>
              <Input
                label="Last Name"
                value={formData.last_name}
                onChange={(v) => setFormData((f) => ({ ...f, last_name: v }))}
              />
            </div>{" "}
          </div>{" "}
          <Input
            label="Phone"
            value={formData.phone}
            onChange={(v) => setFormData((f) => ({ ...f, phone: v }))}
          />{" "}
          <Input
            label="Email"
            value={formData.email}
            onChange={(v) => setFormData((f) => ({ ...f, email: v }))}
          />{" "}
          <Input
            label="Address"
            value={formData.address}
            onChange={(v) => setFormData((f) => ({ ...f, address: v }))}
          />{" "}
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {" "}
            <div style={{ flex: "1 1 60%" }}>
              <Input
                label="City"
                value={formData.city}
                onChange={(v) => setFormData((f) => ({ ...f, city: v }))}
              />
            </div>{" "}
            <div style={{ flex: "1 1 30%" }}>
              <Input
                label="ZIP"
                value={formData.zip}
                onChange={(v) => setFormData((f) => ({ ...f, zip: v }))}
              />
            </div>{" "}
          </div>{" "}
          <Input
            label="Lead Type"
            value={formData.lead_type}
            onChange={(v) => setFormData((f) => ({ ...f, lead_type: v }))}
            options={LEAD_TYPES.map((t) => ({
              value: t,
              label: t.replace(/_/g, " "),
            }))}
          />{" "}
          <Input
            label="Service Interest"
            value={formData.service_interest}
            onChange={(v) =>
              setFormData((f) => ({ ...f, service_interest: v }))
            }
            placeholder="e.g. General Pest, Lawn Care, Termite"
          />{" "}
          <Input
            label="Lead Source"
            value={formData.lead_source_id}
            onChange={(v) => setFormData((f) => ({ ...f, lead_source_id: v }))}
            options={sources.map((s) => ({ value: s.id, label: s.name }))}
          />{" "}
          <Btn onClick={submitForm} disabled={loading}>
            {loading ? "Saving..." : "Create Lead"}
          </Btn>{" "}
        </Modal>
      );

    if (showModal === "convert")
      return (
        <Modal title="Convert to Customer" onClose={() => setShowModal(null)}>
          {" "}
          <Input
            label="Customer ID (required)"
            value={formData.customer_id}
            onChange={(v) => setFormData((f) => ({ ...f, customer_id: v }))}
            placeholder="Existing customer UUID"
          />{" "}
          <Input
            label="Monthly Value ($)"
            value={formData.monthly_value}
            onChange={(v) => setFormData((f) => ({ ...f, monthly_value: v }))}
            type="number"
          />{" "}
          <Input
            label="Initial Service Value ($)"
            value={formData.initial_service_value}
            onChange={(v) =>
              setFormData((f) => ({ ...f, initial_service_value: v }))
            }
            type="number"
          />{" "}
          <Input
            label="WaveGuard Tier"
            value={formData.waveguard_tier}
            onChange={(v) => setFormData((f) => ({ ...f, waveguard_tier: v }))}
            options={["Platinum", "Gold", "Silver", "Bronze", "One-Time"]}
          />{" "}
          <Btn onClick={submitForm} disabled={loading} color={C.green}>
            {loading ? "Converting..." : "Convert"}
          </Btn>{" "}
        </Modal>
      );

    if (showModal === "lost")
      return (
        <Modal title="Mark Lead Lost" onClose={() => setShowModal(null)}>
          {" "}
          <Input
            label="Reason"
            value={formData.reason}
            onChange={(v) => setFormData((f) => ({ ...f, reason: v }))}
            options={LOST_REASONS}
          />
          {formData.reason === "competitor" && (
            <Input
              label="Competitor Name"
              value={formData.competitor}
              onChange={(v) => setFormData((f) => ({ ...f, competitor: v }))}
              placeholder="e.g. Terminix, Orkin, HomeTeam"
            />
          )}
          <div style={{ marginBottom: 12 }}>
            {" "}
            <label
              style={{
                fontSize: 12,
                color: C.muted,
                display: "block",
                marginBottom: 4,
              }}
            >
              Notes
            </label>{" "}
            <textarea
              value={formData.notes || ""}
              onChange={(e) =>
                setFormData((f) => ({ ...f, notes: e.target.value }))
              }
              placeholder="Additional context about why this lead was lost..."
              style={{
                width: "100%",
                minHeight: 80,
                backgroundColor: C.input,
                border: `1px solid ${C.inputBorder}`,
                borderRadius: 8,
                padding: "8px 12px",
                color: C.text,
                fontSize: 13,
                resize: "vertical",
                boxSizing: "border-box",
              }}
            />{" "}
          </div>{" "}
          <Btn onClick={submitForm} disabled={loading} color={C.red}>
            {loading ? "Saving..." : "Mark Lost"}
          </Btn>{" "}
        </Modal>
      );

    if (showModal === "assign")
      return (
        <Modal title="Assign Lead" onClose={() => setShowModal(null)}>
          {" "}
          <Input
            label="Technician"
            value={formData.technician_id}
            onChange={(v) => setFormData((f) => ({ ...f, technician_id: v }))}
            options={techs.map((t) => ({
              value: t.id,
              label: `${t.first_name} ${t.last_name || ""}`,
            }))}
          />{" "}
          <Btn onClick={submitForm} disabled={loading} color={C.purple}>
            {loading ? "Assigning..." : "Assign"}
          </Btn>{" "}
        </Modal>
      );

    if (showModal === "newSource")
      return (
        <Modal title="Add Lead Source" onClose={() => setShowModal(null)}>
          {" "}
          <Input
            label="Name"
            value={formData.name}
            onChange={(v) => setFormData((f) => ({ ...f, name: v }))}
          />{" "}
          <Input
            label="Source Type"
            value={formData.source_type}
            onChange={(v) => setFormData((f) => ({ ...f, source_type: v }))}
            options={[
              "phone_tracking",
              "website_organic",
              "website_paid",
              "social_organic",
              "social_paid",
              "referral",
              "direct",
              "walk_in",
              "marketplace",
              "other",
            ].map((t) => ({ value: t, label: t.replace(/_/g, " ") }))}
          />{" "}
          <Input
            label="Channel"
            value={formData.channel}
            onChange={(v) => setFormData((f) => ({ ...f, channel: v }))}
            placeholder="e.g. google, facebook, referral"
          />{" "}
          <Input
            label="Twilio Phone Number"
            value={formData.twilio_phone_number}
            onChange={(v) =>
              setFormData((f) => ({ ...f, twilio_phone_number: v }))
            }
            placeholder="+1XXXXXXXXXX"
          />{" "}
          <Input
            label="Domain"
            value={formData.domain}
            onChange={(v) => setFormData((f) => ({ ...f, domain: v }))}
            placeholder="example.com"
          />{" "}
          <Input
            label="Cost Type"
            value={formData.cost_type}
            onChange={(v) => setFormData((f) => ({ ...f, cost_type: v }))}
            options={["free", "fixed", "per_lead", "per_month", "one_time"]}
          />{" "}
          <Input
            label="Monthly Cost ($)"
            value={formData.monthly_cost}
            onChange={(v) => setFormData((f) => ({ ...f, monthly_cost: v }))}
            type="number"
          />{" "}
          <Btn onClick={submitForm} disabled={loading}>
            {loading ? "Creating..." : "Create Source"}
          </Btn>{" "}
        </Modal>
      );

    if (showModal === "logCost")
      return (
        <Modal title="Log Source Cost" onClose={() => setShowModal(null)}>
          {" "}
          <Input
            label="Month"
            value={formData.month}
            onChange={(v) => setFormData((f) => ({ ...f, month: v }))}
            type="date"
          />{" "}
          <Input
            label="Cost Amount ($)"
            value={formData.cost_amount}
            onChange={(v) => setFormData((f) => ({ ...f, cost_amount: v }))}
            type="number"
          />{" "}
          <Input
            label="Category"
            value={formData.cost_category}
            onChange={(v) => setFormData((f) => ({ ...f, cost_category: v }))}
            options={[
              "monthly_fee",
              "domain_renewal",
              "ad_spend",
              "setup",
              "content",
              "other",
            ]}
          />{" "}
          <Input
            label="Notes"
            value={formData.notes}
            onChange={(v) => setFormData((f) => ({ ...f, notes: v }))}
          />{" "}
          <Btn onClick={submitForm} disabled={loading} color={C.amber}>
            {loading ? "Logging..." : "Log Cost"}
          </Btn>{" "}
        </Modal>
      );

    return null;
  };

  // ═════════════════════════════════════════════════════════════════════════
  // MAIN RENDER
  // ═════════════════════════════════════════════════════════════════════════
  return (
    <div
      style={{
        padding: 24,
        maxWidth: 1400,
        margin: "0 auto",
        color: C.text,
        fontFamily: ROBOTO,
      }}
    >
      {" "}
      <LeadsWorkspaceNav
        active={tab}
        onChange={setTab}
        counts={{
          pipeline: leadsTotal || leads.length,
          sources: sources.length,
          analytics: bySource.length || byChannel.length,
        }}
      />
      {loadError && (
        <div
          style={{
            border: `1px solid ${C.red}44`,
            backgroundColor: C.red + "0f",
            color: C.red,
            borderRadius: 8,
            padding: "10px 12px",
            fontSize: 13,
            marginBottom: 16,
          }}
        >
          Pipeline data failed to load: {loadError.message || String(loadError)}
          <button
            type="button"
            onClick={retryCurrentTab}
            style={{
              marginLeft: 10,
              border: `1px solid ${C.red}66`,
              background: "transparent",
              color: C.red,
              borderRadius: 6,
              padding: "3px 8px",
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            Retry
          </button>{" "}
        </div>
      )}
      {tab === "pipeline" && renderPipeline()}
      {tab === "sources" && renderSources()}
      {tab === "analytics" && renderAnalytics()}
      {renderModal()}
    </div>
  );
}
