import { useCustomerSms } from "../../components/admin/customer360/CustomerSmsPanel";
import React, { useState, useEffect, useCallback, useRef, useMemo, useId } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Trash2, Search, SlidersHorizontal } from "lucide-react";
import useModalFocus from "../../hooks/useModalFocus";
import { callViaBridge } from "../../components/admin/CallBridgeLink";
import AuthenticatedCallAudio from "../../components/admin/AuthenticatedCallAudio";
import useIsMobile from "../../hooks/useIsMobile";
import { createPortal } from "react-dom";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const ROBOTO = "'Roboto', Arial, sans-serif";

// leads.address may hold either a street-only line or a fully composed
// "street, City, FL zip" string depending on which intake path wrote the row —
// only append the standalone city/zip columns when the stored address doesn't
// already carry them, so "…, Palmetto, FL 34221, Palmetto" can never render.
// Containment is segment-wise, not substring: a city sharing the street name
// ("123 Palmetto Rd" + city Palmetto) must still get its city appended.
function formatLeadAddress(lead) {
  const address = String(lead?.address || "").trim();
  const city = String(lead?.city || "").trim();
  const zip = String(lead?.zip || "").trim();
  if (!address) return [city, zip].filter(Boolean).join(", ");
  const segments = address
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const parts = [address];
  if (city && !segments.includes(city.toLowerCase())) parts.push(city);
  if (zip && !segments.some((seg) => seg.split(/\s+/).includes(zip))) parts.push(zip);
  return parts.join(", ");
}

// Extra properties the visitor asked to have covered — the call-extraction
// pipeline's extracted_data.additional_properties shape (address_line1/
// address_line2/city/state/zip), which the quote-funnel web capture also
// writes. Capture-only; each one is follow-up-quoted manually.
// extracted_data arrives as jsonb or a string depending on the endpoint, so
// parse defensively.
function leadAdditionalProperties(lead) {
  let data = lead?.extracted_data;
  if (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      return [];
    }
  }
  const list = data?.additional_properties;
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => {
      if (typeof p === "string") return p.trim();
      if (!p || !String(p.address_line1 || "").trim()) return "";
      const region = [p.state, p.zip]
        .map((v) => String(v || "").trim())
        .filter(Boolean)
        .join(" ");
      return [p.address_line1, p.address_line2, p.city, region]
        .map((v) => String(v || "").trim())
        .filter(Boolean)
        .join(", ");
    })
    .filter(Boolean);
}

// Open promises on this lead's calls (call_commitments) — same data the
// Communications → Owed tab works from, rendered in this file's own inline
// style system. Renders nothing when nothing is owed.
// A failed load keeps the last rows it had and says so (an empty rollup
// must mean nothing is owed, never that the request failed); a failed
// action is shown beside the controls. The rollup shows up to
// LEAD_OWED_LIMIT rows and says when more are owed (the Owed tab is the
// full queue) instead of silently truncating.
const LEAD_OWED_LIMIT = 10;
function LeadOwedPromises({ leadId }) {
  const et = (v) => (v ? new Date(v).toLocaleString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const [rows, setRows] = useState([]);
  const [enabled, setEnabled] = useState(true);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const load = useCallback(async () => {
    if (!leadId) return;
    try {
      const data = await adminFetch(`/admin/call-recordings/commitments/open?lead_id=${encodeURIComponent(leadId)}&limit=${LEAD_OWED_LIMIT + 1}`);
      setRows(data.commitments || []);
      setEnabled(data.enabled !== false);
      setError(null);
    } catch (err) {
      setError(err.message || "Could not load what is owed on this lead.");
    }
  }, [leadId]);
  useEffect(() => { setRows([]); setError(null); load(); }, [load]);
  const act = async (row, action) => {
    if (busyId) return;
    setBusyId(row.id);
    try {
      await adminFetch(`/admin/call-recordings/commitments/${encodeURIComponent(row.id)}`, { method: "PATCH", body: JSON.stringify({ action }) });
      await load();
    } catch (err) {
      setError(err.message || "That change did not save.");
    } finally {
      setBusyId(null);
    }
  };
  if (!rows.length && !error) return null;
  return (
    <div style={{ marginTop: 12 }} data-testid="lead-owed">
      <h4 style={{ margin: "0 0 8px", color: C.heading, fontSize: 14 }}>Owed on this lead</h4>
      {error && (
        <div role="alert" style={{ color: C.red, fontSize: 14, marginBottom: 8 }}>
          {error}{" "}
          <button type="button" onClick={load} style={{ minHeight: 32, padding: "4px 10px", border: `1px solid ${C.border}`, borderRadius: 6, background: "transparent", color: C.text, cursor: "pointer", font: "inherit", fontSize: 12 }}>
            Retry
          </button>
        </div>
      )}
      {rows.slice(0, LEAD_OWED_LIMIT).map((row) => (
        <div key={row.id} style={{ border: `1px solid ${row.overdue ? C.red : C.border}`, borderRadius: 8, padding: 10, marginBottom: 8, fontSize: 14, color: C.text }}>
          <div style={{ marginBottom: 4 }}>
            <strong>{row.party === "waves" ? "Waves promised" : "Customer agreed"}:</strong> {row.description}
          </div>
          <div style={{ color: row.overdue ? C.red : C.muted, marginBottom: 6 }}>
            {row.overdue ? "Overdue" : row.due_at ? `Due ${et(row.due_at)} ET` : "No due time"}
            {" · call "}{et(row.call_started_at)} ET
          </div>
          {enabled && (
            <>
              <button type="button" disabled={busyId === row.id} onClick={() => act(row, "fulfill")} style={{ marginRight: 8, minHeight: 32, padding: "4px 10px", border: `1px solid ${C.border}`, borderRadius: 6, background: "transparent", color: C.text, cursor: "pointer", font: "inherit", fontSize: 12 }}>
                Mark done
              </button>
              <button type="button" disabled={busyId === row.id} onClick={() => act(row, "dismiss")} style={{ minHeight: 32, padding: "4px 10px", border: "none", background: "transparent", color: C.muted, cursor: "pointer", font: "inherit", fontSize: 12 }}>
                Dismiss
              </button>
            </>
          )}
        </div>
      ))}
      {rows.length > LEAD_OWED_LIMIT && (
        <div style={{ color: C.muted, fontSize: 12 }}>
          More promises are owed on this lead — <a href="/admin/communications#tab=owed" style={{ color: C.text }}>open the Owed tab</a> for the full queue.
        </div>
      )}
    </div>
  );
}

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
  }).then(async (r) => {
    if (!r.ok) {
      // Surface the server's error/code/match so callers can branch on
      // structured 409s (e.g. EMAIL_MATCH_CONFIRM) instead of status alone.
      let body = null;
      try {
        body = await r.clone().json();
      } catch {
        body = null;
      }
      const err = new Error(body?.error || `HTTP ${r.status}`);
      err.status = r.status;
      err.code = body?.code || null;
      err.match = body?.match || null;
      err.candidates = body?.candidates || null;
      throw err;
    }
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
// Mirrors the server's expansion of the virtual `open` filter (admin-leads
// OPEN_LEAD_STATUSES) — needed to know whether a given lead would survive
// the table's current status filter.
const OPEN_FILTER_STATUSES = ["new", "contacted", "estimate_sent", "estimate_viewed"];
const leadMatchesStatusFilter = (lead, status) =>
  !status ||
  (status === "open"
    ? OPEN_FILTER_STATUSES.includes(lead.status)
    : lead.status === status);
const BOARD_STAGES = STATUSES;
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

// leads.extracted_data arrives as jsonb (object) or a JSON string depending on
// which pipeline wrote it — parse defensively, never crash the row on bad data.
function parseLeadExtractedData(raw) {
  if (!raw) return {};
  try {
    const data = typeof raw === "string" ? JSON.parse(raw) : raw;
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

// Declared "when do you want this handled?" from the marketing-site quote
// forms (extracted_data.timeline, server/services/lead-timeline.js). The
// urgency badge already reflects it; this is the customer's own wording.
const TIMELINE_LABELS = {
  now: "Today / ASAP",
  this_week: "This week",
  this_month: "This month",
  browsing: "Just pricing it out",
};

// preferred_date_time is an ET wall-clock string with NO timezone
// ("2026-04-20T14:00" — the call extraction stores Eastern local time).
// Don't route it through new Date(): a non-Eastern browser would reinterpret
// the zone. Format the stated wall clock directly and label it ET.
function fmtPreferredDateTime(value) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value));
  if (!m) return String(value);
  const [, y, mo, d, h, min] = m;
  const hour = Number(h);
  const h12 = hour % 12 || 12;
  const ampm = hour >= 12 ? "PM" : "AM";
  return `${Number(mo)}/${Number(d)}/${y}, ${h12}:${min} ${ampm} ET`;
}

function fmtCallDuration(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function Badge({ label, color, style }) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "2px 10px",
        borderRadius: 9999,
        fontSize: 14,
        fontWeight: 500,
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
      <div style={{ fontSize: 14, color: C.muted, marginBottom: 4 }}>
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
        <div style={{ fontSize: 14, color: C.muted, marginTop: 2 }}>{sub}</div>
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
            fontSize: 14,
            fontWeight: 500,
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

function LeadsWorkspaceNav({ active, onChange }) {
  return <nav aria-label="Lead tools" style={{ display: "flex", gap: 16, marginBottom: 12 }}>
    {[{ key: "pipeline", label: "Work queue" }, { key: "sources", label: "Sources" }, { key: "analytics", label: "Analytics" }].map(({ key, label }) => (
      <button key={key} type="button" onClick={() => onChange(key)} aria-current={active === key ? "page" : undefined}
        style={{ minHeight: 44, padding: 0, border: "none", background: "transparent", color: active === key ? C.heading : C.muted, fontFamily: ROBOTO, fontSize: 14, fontWeight: 500, cursor: "pointer", textDecoration: active === key ? "underline" : "none", textUnderlineOffset: 7 }}>
        {label}
      </button>
    ))}
  </nav>;
}

function Btn({ children, onClick, color, small, style, disabled, ...rest }) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      {...rest}
      style={{
        padding: small ? "4px 12px" : "8px 16px",
        borderRadius: 8,
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        backgroundColor: color || C.teal,
        color: "#fff",
        fontSize: 14,
        minHeight: 44,
        fontWeight: 500,
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
  const id = useId();
  const base = {
    backgroundColor: C.input,
    border: `1px solid ${C.inputBorder}`,
    borderRadius: 8,
    padding: "8px 12px",
    color: C.text,
    fontSize: 16,
    width: "100%",
    minHeight: 44,
    boxSizing: "border-box",
    ...style,
  };
  return (
    <div style={{ marginBottom: 12 }}>
      {label && (
        <label htmlFor={id}
          style={{
            fontSize: 14,
            color: C.muted,
            display: "block",
            marginBottom: 4,
          }}
        >
          {label}
        </label>
      )}
      {options ? (
        <select id={id}
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
        <input id={id}
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
  const isMobile = useIsMobile();
  const panelRef = useModalFocus(true, onClose);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: "fixed",
        inset: 0,
        backgroundColor: "rgba(0,0,0,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
        boxSizing: "border-box",
        paddingTop: "max(16px, env(safe-area-inset-top, 0px))",
        paddingRight: "max(16px, env(safe-area-inset-right, 0px))",
        paddingBottom: "max(16px, env(safe-area-inset-bottom, 0px))",
        paddingLeft: "max(16px, env(safe-area-inset-left, 0px))",
        ...(isMobile ? { padding: 0 } : {}),
      }}
      onClick={onClose}
    >
      {" "}
      <div ref={panelRef} tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          backgroundColor: C.card,
          borderRadius: 16,
          border: `1px solid ${C.border}`,
          padding: "clamp(16px, 4vw, 24px)",
          maxWidth: 520,
          width: "100%",
          maxHeight: "100%",
          overflowY: "auto",
          boxSizing: "border-box",
          overscrollBehavior: "contain",
          ...(isMobile
            ? {
                width: "100%",
                maxWidth: "none",
                height: "100%",
                maxHeight: "none",
                borderRadius: 0,
                boxSizing: "border-box",
                overflowY: "auto",
                paddingTop: "calc(clamp(16px, 4vw, 24px) + env(safe-area-inset-top, 0px))",
                paddingBottom: "calc(clamp(16px, 4vw, 24px) + env(safe-area-inset-bottom, 0px))",
                paddingLeft: "calc(clamp(16px, 4vw, 24px) + env(safe-area-inset-left, 0px))",
                paddingRight: "calc(clamp(16px, 4vw, 24px) + env(safe-area-inset-right, 0px))",
              }
            : {}),
        }}
      >
        {" "}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          {" "}
          <h3 style={{ margin: 0, color: C.heading, fontSize: 18 }}>
            {title}
          </h3>{" "}
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              background: "none",
              border: "none",
              color: C.muted,
              cursor: "pointer",
              fontSize: 20,
              width: 44,
              height: 44,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 8,
            }}
          >
            x
          </button>{" "}
        </div>
        {children}
      </div>{" "}
    </div>,
    document.body,
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
// Like fmtMoney but preserves cents — use for exact per-lead figures
// (e.g. monthly value) where whole-dollar rounding would misstate the amount.
function fmtMoneyExact(v) {
  return v != null
    ? "$" +
        Number(v).toLocaleString("en-US", {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
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
// Short "M/D" for the Speed-to-Lead fresh-start baseline label. Pinned to ET:
// speedToLeadSince is an ET-midnight cutoff, so a non-ET browser would otherwise
// render 2026-07-01 as 6/30 (ET wall-clock discipline).
function fmtShortDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    timeZone: "America/New_York",
  });
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
        fontSize: 14,
        color,
        fontWeight: 500,
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
function readSourceDrillParams(sp = new URLSearchParams(window.location.search)) {
  const sourceName = sp.get("source_name");
  if (!sourceName) return null;
  return {
    source_name: sourceName,
    start_date: sp.get("from") || "",
    end_date: sp.get("to") || "",
    period_label: sp.get("period_label") || "",
    // An explicitly passed status wins over the table's "open" default; a
    // drill without one shows ALL statuses so the rows match the panel count
    // the operator clicked (dashboard panels count won/lost leads too).
    status: sp.get("status") || "",
  };
}

const LEAD_FILTER_KEYS = { status: "leadStatus", search: "leadSearch", sort: "leadSort", page: "leadPage", source_name: "source_name", start_date: "start_date", end_date: "end_date", builder_warranty: "builder_warranty" };
function leadFiltersFromParams(params) {
  const drill = readSourceDrillParams(params);
  const status = params.get("leadStatus");
  return {
    status: status === "all" ? "" : ["open", ...STATUSES].includes(status) ? status : params.has("lead") ? "" : drill?.status ?? "open",
    search: params.get("leadSearch") || "",
    sort: params.get("leadSort") || "first_contact_at",
    page: Math.max(1, Number.parseInt(params.get("leadPage"), 10) || 1),
    source_name: params.get("source_name") || "", start_date: params.get("start_date") || drill?.start_date || "", end_date: params.get("end_date") || drill?.end_date || "",
    builder_warranty: params.get("builder_warranty") === "expiring" ? "expiring" : "",
  };
}

export function LeadsSection({ newLeadRequest = 0 }) {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const isMobile = useIsMobile();
  const agentEstimateEnabled = useFeatureFlag("agent_estimate", false);
  const compactQueue = useIsMobile(1280);
  const [tab, setTab] = useState("pipeline");
  const openMessages = useCustomerSms();
  const messageLead = (lead, initialDraft = "") => openMessages?.({
    id: lead.customer_id, firstName: lead.first_name, lastName: lead.last_name, phone: lead.phone,
  }, { initialDraft, onSent: () => { loadLeads(); expandLead(lead); } });
  const [callbackForm, setCallbackForm] = useState(null); // { leadId, date, time, notes }
  const [apptForm, setApptForm] = useState(null); // { leadId, date, time, serviceId, serviceType, technicianId, notes }
  const [apptSaving, setApptSaving] = useState(false);
  const [services, setServices] = useState([]);
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
  // Monotonic id of the newest loadLeads request — stale responses bail.
  const leadsRequestRef = useRef(0);
  const [leadActivities, setLeadActivities] = useState([]);
  const [leadActivitiesLoading, setLeadActivitiesLoading] = useState(false);
  const [leadActivitiesError, setLeadActivitiesError] = useState(null);
  const [leadCalls, setLeadCalls] = useState([]);
  const [showModal, setShowModal] = useState(null);
  const [formData, setFormData] = useState({});
  const [contactMatches, setContactMatches] = useState(null);
  useEffect(() => {
    setContactMatches(null);
    if (showModal !== "newLead" || (!formData.phone && !formData.email)) return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const query = new URLSearchParams({ phone: formData.phone || "", email: formData.email || "" });
        const data = await adminFetch(`/admin/leads/contact-matches?${query}`);
        if (!cancelled) setContactMatches(data);
      } catch { if (!cancelled) setContactMatches({ error: true }); }
    }, 300);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [showModal, formData.phone, formData.email]);
  const filters = useMemo(() => leadFiltersFromParams(searchParams), [searchParams]);
  const linkedLeadId = searchParams.get("lead");
  const setFilters = useCallback((updater) => {
    setSearchParams((params) => {
      const current = leadFiltersFromParams(params);
      const next = typeof updater === "function" ? updater(current) : updater;
      const updated = new URLSearchParams(params);
      ["from", "to", "status", "lead"].forEach((key) => updated.delete(key));
      if (!next.source_name) updated.delete("period_label");
      for (const [key, param] of Object.entries(LEAD_FILTER_KEYS)) {
        if (key === "status") updated.set(param, next[key] || "all");
        else if (next[key] && !(key === "page" && next[key] === 1)) updated.set(param, String(next[key]));
        else updated.delete(param);
      }
      return updated;
    }, { replace: true });
  }, [setSearchParams]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [debouncedSearch, setDebouncedSearch] = useState(filters.search);
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(filters.search), 250);
    return () => clearTimeout(timer);
  }, [filters.search]);
  // Human label for the active source-drill chip (e.g. "This month").
  const [sourcePeriodLabel, setSourcePeriodLabel] = useState(
    () => readSourceDrillParams()?.period_label || "",
  );
  const pipelineView = searchParams.get("leadView") === "board" ? "board" : "table";
  const setPipelineView = useCallback((view) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      if (view === "board") next.set("leadView", "board"); else next.delete("leadView");
      return next;
    }, { replace: true });
  }, [setSearchParams]);
  const [draggingLeadId, setDraggingLeadId] = useState(null);
  const [deletingLeadId, setDeletingLeadId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState(null);
  const [techs, setTechs] = useState([]);

  useEffect(() => {
    if (!newLeadRequest) return;
    setFormData({});
    setShowModal("newLead");
  }, [newLeadRequest]);

  const setActiveLead = useCallback((leadId) => {
    expandedLeadRef.current = leadId;
    setExpandedLead(leadId);
  }, []);

  const loadLeads = useCallback(async ({ silent = false } = {}) => {
    // The requested scope depends on the view + filters, so a slow response
    // from a superseded request (quick Table↔Board toggle, filter change)
    // must never overwrite the current view's rows — only the newest
    // request commits.
    const requestId = ++leadsRequestRef.current;
    try {
      if (!silent) setLoadError(null);
      const params = new URLSearchParams();
      if (linkedLeadId) params.set("id", linkedLeadId);
      // List and board apply the same server-side filters and pagination.
      const status = filters.status;
      if (status) params.set("status", status);
      if (debouncedSearch.trim()) params.set("search", debouncedSearch.trim());
      if (filters.source_name) params.set("source_name", filters.source_name);
      if (filters.builder_warranty) params.set("builder_warranty", filters.builder_warranty);
      if (filters.start_date) params.set("start_date", filters.start_date);
      if (filters.end_date) params.set("end_date", filters.end_date);
      params.set("sort", filters.sort);
      params.set("order", filters.sort === "name" ? "asc" : "desc");
      params.set("page", filters.page);
      params.set("limit", "50");
      const data = await adminFetch(`/admin/leads?${params}`);
      if (requestId !== leadsRequestRef.current) return; // superseded
      setLeads(data.leads || []);
      setLeadsTotal(data.total || 0);
    } catch (e) {
      if (requestId !== leadsRequestRef.current) return; // superseded
      console.error("loadLeads", e);
      if (!silent) setLoadError(e);
    }
  }, [linkedLeadId, filters.status, filters.sort, filters.page, filters.source_name, filters.start_date, filters.end_date, filters.builder_warranty, debouncedSearch]);

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

  useEffect(() => { if (tab === "pipeline") void loadLeads(); }, [tab, loadLeads]);
  useEffect(() => {
    void loadSources();
    if (tab === "sources") void loadSourceROI();
    if (tab === "analytics") void loadAnalytics();
  }, [tab, loadSources, loadSourceROI, loadAnalytics]);
  useEffect(() => {
    if (tab !== "pipeline") return undefined;
    const id = window.setInterval(() => { if (isPageVisible()) void loadLeads({ silent: true }); }, LEADS_REFRESH_MS);
    return () => { window.clearInterval(id); leadsRequestRef.current += 1; };
  }, [tab, loadLeads]);

  const loadLeadActivities = useCallback(
    async (leadId, { silent = false } = {}) => {
      if (!leadId) return;
      const requestedLeadId = String(leadId);
      if (!silent) {
        setLeadActivities([]);
        setLeadCalls([]);
        setLeadActivitiesError(null);
        setLeadActivitiesLoading(true);
      }
      try {
        const data = await adminFetch(`/admin/leads/${leadId}`);
        if (String(expandedLeadRef.current || "") !== requestedLeadId) return;
        setLeadActivities(data.activities || []);
        setLeadCalls(data.calls || []);
        if (!silent) setLeadActivitiesError(null);
      } catch (e) {
        console.error("loadLeadActivities", e);
        if (String(expandedLeadRef.current || "") !== requestedLeadId) return;
        if (!silent) {
          setLeadActivities([]);
          setLeadCalls([]);
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

  // Notifications and duplicate matches use the same exact-record filter,
  // including records outside the first page. Ordinary filters clear it.
  useEffect(() => {
    if (!linkedLeadId) return;
    setTab("pipeline");
    setPipelineView("table");
    setActiveLead(linkedLeadId);
    loadLeadActivities(linkedLeadId);
  }, [linkedLeadId, setActiveLead, loadLeadActivities, setPipelineView]);

  // Drill-down from the dashboard Marketing Attribution panel:
  // /admin/leads?source_name=<name>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>&period_label=<label>
  // filters the pipeline table to that source for the panel's period window.
  // Initial filters already use these params; keep the cohort in the URL.
  const sourceDeepLinkDone = useRef(false);
  useEffect(() => {
    if (sourceDeepLinkDone.current) return;
    sourceDeepLinkDone.current = true;
    const sp = new URLSearchParams(window.location.search);
    if (!sp.get("source_name")) return;
    setTab("pipeline");
    setPipelineView("table");
    // Keep the scoped filters in the URL so Back and refresh preserve the
    // exact reporting cohort. Ordinary filter changes normalize legacy keys.
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
        `Delete ${label} from the lead pipeline?\n\nThis removes the lead from the pipeline (an admin can recover it). The activity timeline is kept, and existing estimates stay in Estimates.`,
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
      } else if (showModal === "builderWarranty") {
        await adminFetch(`/admin/leads/${formData.leadId}`, {
          method: "PUT",
          body: {
            builder_warranty_provider: formData.builder_warranty_provider || "",
            builder_warranty_expires_on:
              formData.builder_warranty_expires_on || "",
          },
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
        <div style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: "1 1 180px", minWidth: 0 }}>
              <Search size={18} aria-hidden style={{ position: "absolute", left: 12, top: 13, color: C.muted }} />
              <input type="search" aria-label="Search leads" placeholder="Search leads" value={filters.search}
                onChange={(event) => setFilters((f) => ({ ...f, search: event.target.value, page: 1 }))}
                style={{ width: "100%", boxSizing: "border-box", height: 44, border: `1px solid ${C.inputBorder}`, borderRadius: 6, padding: "8px 12px 8px 38px", background: C.input, color: C.text, fontSize: 16 }} />
            </div>
            <Btn onClick={() => setFiltersOpen((open) => !open)} aria-expanded={filtersOpen} aria-controls="lead-queue-filters"
              style={{ display: "inline-flex", gap: 6, alignItems: "center", background: C.white, color: C.text, border: `1px solid ${C.border}` }}>
              <SlidersHorizontal size={18} aria-hidden /> Filters
              {(filters.status !== "open" || filters.source_name || filters.builder_warranty || filters.sort !== "first_contact_at") && <span aria-label="Active filters" style={{ width: 6, height: 6, borderRadius: "50%", background: C.heading }} />}
            </Btn>
            {!isMobile && <div role="group" aria-label="Lead view" style={{ display: "flex", gap: 4 }}>
              {["table", "board"].map((view) => <Btn key={view} onClick={() => setPipelineView(view)} aria-pressed={pipelineView === view}
                style={{ background: pipelineView === view ? C.heading : C.white, color: pipelineView === view ? C.white : C.text, border: `1px solid ${C.border}` }}>{view === "table" ? "List" : "Board"}</Btn>)}
            </div>}
          </div>
          {(filtersOpen || !isMobile) && <div id="lead-queue-filters" style={{ display: "flex", flexWrap: "wrap", alignItems: "end", gap: 12, marginTop: 12 }}>
            <Input label="Stage" value={filters.status || "all"} onChange={(value) => setFilters((f) => ({ ...f, status: value === "all" ? "" : value, page: 1 }))}
              options={[{ value: "open", label: "Open leads" }, { value: "all", label: "All stages" }, ...STATUSES.map((value) => ({ value, label: value.replace(/_/g, " ") }))]} />
            <Input label="Sort" value={filters.sort} onChange={(sort) => setFilters((f) => ({ ...f, sort, page: 1 }))}
              options={[{ value: "first_contact_at", label: "Newest first" }, { value: "name", label: "Name A–Z" }, { value: "status", label: "Stage" }, { value: "response_time", label: "Response time" }, { value: "monthly_value", label: "Monthly value" }]} />
            {isMobile && <Input label="View" value={pipelineView} onChange={setPipelineView} options={[{ value: "table", label: "List" }, { value: "board", label: "Board" }]} />}
            {(filters.source_name || filters.builder_warranty) && <p style={{ fontSize: 14 }}>{[filters.source_name, sourcePeriodLabel, filters.builder_warranty && "Builder warranty expiring"].filter(Boolean).join(" · ")}</p>}
            <Btn onClick={() => { setFilters({ status: "open", search: "", sort: "first_contact_at", page: 1 }); setSourcePeriodLabel(""); }} style={{ marginBottom: 12, background: "transparent", color: C.text }}>Reset filters</Btn>
          </div>}
          <div role="status" aria-live="polite" style={{ marginTop: 12, color: C.muted, fontSize: 14 }}>
            {leadsTotal === 0 ? "No matching leads" : `${(filters.page - 1) * 50 + 1}–${Math.min(filters.page * 50, leadsTotal)} of ${leadsTotal} matching leads`}
            {pipelineView === "board" ? " · column counts show this page" : ""}
          </div>
        </div>
        {pipelineView === "table" && (
          <>
            {/* Leads Table */}
            <Card style={{ padding: 0 }}>
              {" "}
              <table className="lead-queue-table" style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
                {!compactQueue && <colgroup>{[26, 13, 19, 8, 18, 10, 6].map((width, index) => <col key={index} style={{ width: `${width}%` }} />)}</colgroup>}
                <thead style={compactQueue ? { display: "none" } : undefined}>
                  <tr style={{ borderBottom: `1px solid ${C.border}` }}>
                    {(compactQueue
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
                          fontSize: 14,
                          color: C.muted,
                          fontWeight: 500,
                          textTransform: "uppercase",
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {leads.map((lead) => {
                    const isExpanded = expandedLead === lead.id;
                    return (
                      <React.Fragment key={lead.id}>
                        <tr className="lead-queue-record"
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
                          <td style={{ padding: "12px 16px" }}>
                            {" "}
                            <div
                              style={{
                                display: "flex",
                                flexWrap: "wrap",
                                alignItems: "center",
                                gap: 8,
                              }}
                            >
                              {" "}
                              <button type="button" onClick={(event) => { event.stopPropagation(); expandLead(lead); }} aria-expanded={isExpanded}
                                style={{
                                  border: "none", background: "transparent", padding: 0, minHeight: 44, textAlign: "left", cursor: "pointer", fontFamily: "inherit",
                                  color: C.heading,
                                  fontSize: 14,
                                  fontWeight: 500,
                                }}
                              >
                                {[lead.first_name, lead.last_name]
                                  .filter(Boolean)
                                  .join(" ") || "Unknown"}
                              </button>{" "}
                              <AgingBadge lead={lead} />{" "}
                            </div>{" "}
                            <div
                              style={{ color: C.muted, fontSize: 14, ...mono }}
                            >
                              {lead.phone || lead.email || "--"}
                            </div>{" "}
                            {compactQueue && lead.service_interest && (
                              <div style={{ color: C.text, fontSize: 14 }}>
                                {lead.service_interest}
                              </div>
                            )}{" "}
                            {lead.estimate_id && <div style={{ fontSize: 14, color: C.muted }}>Estimate: {lead.estimate_status || "linked"}</div>}
                            <div style={{ fontSize: 14, color: C.muted }}>
                              {lead.next_follow_up_at ? `Follow up ${fmtShortDate(lead.next_follow_up_at)}` : `Added ${fmtShortDate(lead.first_contact_at)}`}
                            </div>
                          </td>
                          {!compactQueue && (
                            <>
                              <td style={{ padding: "12px 16px" }}>
                                {lead.source_name ? (
                                  <Badge
                                    label={
                                      lead.source_name
                                    }
                                    color={C.teal}
                                  />
                                ) : (
                                  <span
                                    style={{ color: C.muted, fontSize: 14 }}
                                  >
                                    --
                                  </span>
                                )}
                              </td>
                              <td
                                style={{
                                  padding: "12px 16px",
                                  color: C.text,
                                  fontSize: 14,
                                }}
                              >
                                {lead.service_interest || "--"}
                                {lead.builder_warranty_expires_on && (
                                  <Badge
                                    label={`warranty exp ${String(
                                      lead.builder_warranty_expires_on,
                                    ).slice(0, 10)}`}
                                    color={C.amber}
                                    style={{ marginLeft: 6 }}
                                  />
                                )}
                              </td>
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
                              </td>
                            </>
                          )}
                          <td
                            style={{ padding: "12px 16px" }}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {" "}
                            <select aria-label={`Stage for ${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "lead"}`}
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
                                fontSize: 14,
                                cursor: "pointer",
                              }}
                            >
                              {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {s.replace(/_/g, " ")}
                                </option>
                              ))}
                            </select>{" "}
                          </td>
                          {!compactQueue && (
                            <>
                              <td
                                style={{
                                  padding: "12px 16px",
                                  ...mono,
                                  fontSize: 14,
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
                              </td>
                              <td
                                style={{ padding: "12px 16px" }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <Btn small onClick={() => expandLead(lead)} aria-expanded={isExpanded} style={{ background: "transparent", color: C.text, paddingInline: 4, whiteSpace: "nowrap" }}>Open</Btn>
                              </td>
                            </>
                          )}
                        </tr>
                        {isExpanded && (
                          <tr>
                            <td
                              colSpan={compactQueue ? 2 : 7}
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
                                        fontSize: 14,
                                        color: C.muted,
                                        lineHeight: 1.8,
                                      }}
                                    >
                                      {" "}
                                      <div>
                                        Service:{" "}
                                        <span
                                          style={{
                                            color: C.heading,
                                            fontWeight: 500,
                                          }}
                                        >
                                          {lead.service_interest || "--"}
                                        </span>
                                      </div>{" "}
                                      <div>
                                        Email:{" "}
                                        <span style={{ color: C.text }}>
                                          {lead.email || "--"}
                                        </span>
                                      </div>{" "}
                                      <div>
                                        Address:{" "}
                                        <span style={{ color: C.text }}>
                                          {formatLeadAddress(lead) || "--"}
                                        </span>
                                      </div>{" "}
                                      {leadAdditionalProperties(lead).length >
                                        0 && (
                                        <div>
                                          Also cover:{" "}
                                          <span style={{ color: C.text }}>
                                            {leadAdditionalProperties(
                                              lead,
                                            ).join(" · ")}
                                          </span>
                                        </div>
                                      )}{" "}
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
                                      <div>
                                        Builder Warranty:{" "}
                                        <span style={{ color: C.text }}>
                                          {lead.builder_warranty_provider ||
                                          lead.builder_warranty_expires_on
                                            ? [
                                                lead.builder_warranty_provider,
                                                lead.builder_warranty_expires_on
                                                  ? // DATE column arrives as an
                                                    // ISO string; slice the date
                                                    // part instead of new Date()
                                                    // (UTC midnight renders as
                                                    // the previous ET day)
                                                    `expires ${String(
                                                      lead.builder_warranty_expires_on,
                                                    ).slice(0, 10)}`
                                                  : null,
                                              ]
                                                .filter(Boolean)
                                                .join(" — ")
                                            : "--"}
                                        </span>{" "}
                                        <Btn
                                          small
                                          onClick={() => {
                                            setFormData({
                                              leadId: lead.id,
                                              builder_warranty_provider:
                                                lead.builder_warranty_provider ||
                                                "",
                                              builder_warranty_expires_on:
                                                String(
                                                  lead.builder_warranty_expires_on ||
                                                    "",
                                                ).slice(0, 10),
                                            });
                                            setShowModal("builderWarranty");
                                          }}
                                        >
                                          {lead.builder_warranty_provider ||
                                          lead.builder_warranty_expires_on
                                            ? "Edit"
                                            : "Set"}
                                        </Btn>
                                      </div>
                                      {lead.monthly_value && (
                                        <div>
                                          Monthly Value:{" "}
                                          <span
                                            style={{ color: C.green, ...mono }}
                                          >
                                            {fmtMoneyExact(lead.monthly_value)}
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
                                      {(() => {
                                        const ex = parseLeadExtractedData(
                                          lead.extracted_data,
                                        );
                                        const quoteFlags = [
                                          ex.quote_requested &&
                                            "Quote requested on call",
                                          ex.quote_promised &&
                                            "Quote promised to caller",
                                        ].filter(Boolean);
                                        const timelineLabel =
                                          TIMELINE_LABELS[ex.timeline];
                                        if (
                                          !ex.pain_points &&
                                          !ex.preferred_date_time &&
                                          !timelineLabel &&
                                          quoteFlags.length === 0
                                        )
                                          return null;
                                        return (
                                          <>
                                            {timelineLabel && (
                                              <div>
                                                Wants service:{" "}
                                                <span
                                                  style={{ color: C.text }}
                                                >
                                                  {timelineLabel}
                                                </span>
                                              </div>
                                            )}
                                            {ex.pain_points && (
                                              <div>
                                                Concerns:{" "}
                                                <span
                                                  style={{ color: C.text }}
                                                >
                                                  {ex.pain_points}
                                                </span>
                                              </div>
                                            )}
                                            {ex.preferred_date_time && (
                                              <div>
                                                Preferred Time:{" "}
                                                <span
                                                  style={{ color: C.text }}
                                                >
                                                  {fmtPreferredDateTime(
                                                    ex.preferred_date_time,
                                                  )}
                                                </span>
                                              </div>
                                            )}
                                            {quoteFlags.length > 0 && (
                                              <div style={{ marginTop: 4 }}>
                                                {quoteFlags.map((f) => (
                                                  <Badge
                                                    key={f}
                                                    label={f}
                                                    color={C.amber}
                                                    style={{
                                                      marginRight: 6,
                                                    }}
                                                  />
                                                ))}
                                              </div>
                                            )}
                                          </>
                                        );
                                      })()}
                                    </div>{" "}
                                    <LeadOwedPromises leadId={lead.id} />
                                    {leadCalls.length > 0 && (
                                      <div style={{ marginTop: 12 }}>
                                        <h4
                                          style={{
                                            margin: "0 0 8px",
                                            color: C.heading,
                                            fontSize: 14,
                                          }}
                                        >
                                          Calls
                                        </h4>
                                        {leadCalls.map((call) => (
                                          <div
                                            key={call.id}
                                            style={{
                                              border: `1px solid ${C.border}`,
                                              borderRadius: 8,
                                              padding: 10,
                                              marginBottom: 8,
                                              fontSize: 14,
                                              color: C.muted,
                                            }}
                                          >
                                            <div style={{ marginBottom: 6 }}>
                                              {new Date(
                                                call.created_at,
                                              ).toLocaleString()}
                                              {call.duration_seconds
                                                ? ` — ${fmtCallDuration(call.duration_seconds)}`
                                                : ""}
                                              {call.direction === "outbound"
                                                ? " (outbound)"
                                                : ""}
                                            </div>
                                            {call.has_recording && (
                                              <AuthenticatedCallAudio
                                                recordingId={
                                                  call.recording_sid || call.id
                                                }
                                                style={{
                                                  marginBottom: 6,
                                                  color: C.text,
                                                }}
                                              />
                                            )}
                                            {call.transcription && (
                                              <details>
                                                <summary
                                                  style={{
                                                    cursor: "pointer",
                                                    color: C.teal,
                                                    fontSize: 14,
                                                  }}
                                                >
                                                  View transcript
                                                </summary>
                                                <div
                                                  style={{
                                                    marginTop: 6,
                                                    maxHeight: 180,
                                                    overflowY: "auto",
                                                    whiteSpace: "pre-wrap",
                                                    color: C.text,
                                                    fontSize: 14,
                                                    lineHeight: 1.5,
                                                  }}
                                                >
                                                  {call.transcription}
                                                </div>
                                              </details>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    )}
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
                                            fontSize: 14,
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
                                              fontSize: 14,
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
                                              fontSize: 14,
                                            }}
                                          >
                                            No activities logged
                                          </div>
                                        )}
                                      {leadActivities.map((a) => (
                                        <div
                                          key={a.id}
                                          style={{
                                            fontSize: 14,
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
                                          {(() => {
                                            if (
                                              a.activity_type !== "ai_triage" ||
                                              !a.metadata
                                            )
                                              return null;
                                            let meta = {};
                                            try {
                                              meta =
                                                typeof a.metadata === "string"
                                                  ? JSON.parse(a.metadata)
                                                  : a.metadata;
                                            } catch (e) {}
                                            const lines = [
                                              meta.call_summary,
                                              meta.pain_points &&
                                                `Concerns: ${meta.pain_points}`,
                                            ].filter(Boolean);
                                            if (!lines.length) return null;
                                            return (
                                              <div
                                                style={{
                                                  marginTop: 2,
                                                  color: C.text,
                                                }}
                                              >
                                                {lines.join(" — ")}
                                              </div>
                                            );
                                          })()}
                                          <div
                                            style={{
                                              fontSize: 14,
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
                                          fontSize: 14,
                                          color: C.teal,
                                          fontWeight: 500,
                                          marginBottom: 6,
                                        }}
                                      >
                                        AI Suggested Reply
                                      </div>{" "}
                                      <div
                                        style={{
                                          fontSize: 14,
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
                                          onClick={() => messageLead(lead, meta.suggestedReply)}
                                        >
                                          Review reply
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
                                      messageLead(lead);
                                    }}
                                  >
                                    Message
                                  </Btn>{" "}
                                  <Btn
                                    small
                                    color={C.purple}
                                    onClick={() => {
                                      const next = new URLSearchParams(searchParams);
                                      for (const [key, value] of leadEstimateParams(lead)) next.set(key, value);
                                      next.set("tab", "new");
                                      navigate(`/admin/pipeline?${next}`);
                                    }}
                                  >
                                    Create Estimate
                                  </Btn>{" "}
                                  {agentEstimateEnabled && OPEN_FILTER_STATUSES.includes(lead.status) && (
                                    <Btn
                                      small
                                      color={C.purple}
                                      onClick={() => navigate(`/admin/agent-estimate?leadId=${encodeURIComponent(lead.id)}`)}
                                    >
                                      Agent Estimate
                                    </Btn>
                                  )}{" "}
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
                                  <details style={{ flexBasis: "100%" }}>
                                    <summary style={{ cursor: "pointer", minHeight: 44, padding: "12px 0", fontSize: 14, fontWeight: 500 }}>More actions</summary>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, paddingBottom: 8 }}>
                                  <Btn
                                    small
                                    color={C.green}
                                    onClick={() => {
                                      // Multi-service call leads persist a
                                      // composed label ("A + B + C") whose
                                      // PRIMARY may itself be a catalog row
                                      // containing " + " ("Lawn + Tree &
                                      // Shrub"). Try the longest prefix
                                      // first, shedding one " + " segment at
                                      // a time, so a plus-named combo row
                                      // still matches before falling back to
                                      // the bare first segment.
                                      const segs = (lead.service_interest || "")
                                        .split(" + ")
                                        .map((s) => s.trim())
                                        .filter(Boolean);
                                      const candidates = segs.map((_, i) =>
                                        segs
                                          .slice(0, segs.length - i)
                                          .join(" + ")
                                          .toLowerCase(),
                                      );
                                      let match = null;
                                      for (const cand of candidates) {
                                        match = services.find((s) =>
                                          [s.name, s.short_name, s.service_key]
                                            .filter(Boolean)
                                            .some((v) => {
                                              const name = v.toLowerCase();
                                              // Two-way containment: stored
                                              // labels can be LONGER than the
                                              // catalog row ("Bee / Wasp Nest
                                              // Removal Service" vs seeded
                                              // "Bee / Wasp Nest Removal") —
                                              // but reverse containment only
                                              // on SINGLE-segment candidates,
                                              // or a composite would match a
                                              // secondary's row before the
                                              // loop sheds to the primary.
                                              return (
                                                name.includes(cand) ||
                                                (!cand.includes(" + ") &&
                                                  name.length >= 8 &&
                                                  cand.includes(name))
                                              );
                                            }),
                                        );
                                        if (match) break;
                                      }
                                      setApptForm({
                                        leadId: lead.id,
                                        date: "",
                                        time: "",
                                        serviceId: match ? match.id : "",
                                        // No catalog match: prefill the
                                        // primary by stripping only KNOWN
                                        // composed tails (mirror of
                                        // primaryServiceInterest in
                                        // server/utils/lead-service-interest)
                                        // — a bare " + " split would chop a
                                        // plus-named primary like "Lawn +
                                        // Tree & Shrub" down to "Lawn".
                                        serviceType: match
                                          ? match.name
                                          : (() => {
                                              const tails = new Set([
                                                "pest control service",
                                                "lawn care service",
                                                "tree & shrub care service",
                                                "mosquito control service",
                                                "termite service",
                                                "termite inspection",
                                                "rodent control service",
                                                "wildlife control service",
                                                "wdo inspection service",
                                                "bed bug treatment",
                                                "palm injection",
                                                "bee / wasp nest removal service",
                                                "rodent exclusion",
                                                "flea control service",
                                              ]);
                                              let label = (
                                                lead.service_interest || ""
                                              ).trim();
                                              for (;;) {
                                                const at =
                                                  label.lastIndexOf(" + ");
                                                if (at === -1) break;
                                                const tail = label
                                                  .slice(at + 3)
                                                  .trim()
                                                  .toLowerCase();
                                                if (!tails.has(tail)) break;
                                                label = label
                                                  .slice(0, at)
                                                  .trim();
                                              }
                                              return label;
                                            })(),
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
                                  </details>
                                </div>
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
                                          fontSize: 14,
                                          color: C.amber,
                                          fontWeight: 500,
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
                                            fontSize: 14,
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
                                            fontSize: 14,
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
                                          fontSize: 14,
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
                                        fontSize: 14,
                                        color: C.green,
                                        fontWeight: 500,
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
                                          fontSize: 14,
                                        }}
                                      />
                                      {/* Windows start on the hour (owner rule) — an
                                          hourly select, not a free time input; the
                                          server rejects non-HH:00 anyway. */}
                                      <select
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
                                          fontSize: 14,
                                        }}
                                      >
                                        <option value="">Time…</option>
                                        {/* All 24 hours, mirroring the shared
                                            CreateAppointmentModal's HOURLY_TIME_OPTIONS —
                                            the endpoint accepts any HH:00. */}
                                        {Array.from({ length: 24 }, (_, h) => {
                                          const value = `${String(h).padStart(2, "0")}:00`;
                                          const hour12 = h % 12 || 12;
                                          const label = `${hour12}:00 ${h >= 12 ? "PM" : "AM"}`;
                                          return (
                                            <option key={value} value={value}>
                                              {label}
                                            </option>
                                          );
                                        })}
                                      </select>
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
                                          fontSize: 14,
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
                                          fontSize: 14,
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
                                        fontSize: 14,
                                        resize: "vertical",
                                        boxSizing: "border-box",
                                        marginBottom: 8,
                                      }}
                                    />
                                    <div
                                      style={{
                                        fontSize: 14,
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
                                            const submitAppt = (extra) =>
                                              adminFetch(
                                                `/admin/leads/${lead.id}/schedule-appointment`,
                                                {
                                                  method: "POST",
                                                  body: {
                                                    ...extra,
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
                                                  // Card already shows a CONVERTED
                                                  // lead → explicit repeat booking.
                                                  // converted_at ALONE: the public
                                                  // quote flow links customer_id
                                                  // without converting, and that
                                                  // lead's first submit must not
                                                  // send this (server 409s retries
                                                  // on converted leads).
                                                  rebook: Boolean(lead.converted_at),
                                                  },
                                                },
                                              );
                                            // Response of whichever submit
                                            // succeeded — carries advisory
                                            // schedule-overlap warnings.
                                            let booked = null;
                                            try {
                                              booked = await submitAppt({});
                                            } catch (e) {
                                              // Email matches an existing customer:
                                              // attaching is an explicit admin
                                              // choice, never implicit (email is
                                              // not proof of account ownership).
                                              if (
                                                e?.code ===
                                                "EMAIL_MATCH_ADMIN_REQUIRED"
                                              ) {
                                                // Technician: show and stop —
                                                // no attach/create choice.
                                                alert(e.message);
                                                setApptSaving(false);
                                                return;
                                              }
                                              if (
                                                e?.code !== "EMAIL_MATCH_CONFIRM" &&
                                                e?.code !== "EMAIL_MATCH_AMBIGUOUS"
                                              )
                                                throw e;
                                              const ambiguous =
                                                e.code === "EMAIL_MATCH_AMBIGUOUS";
                                              if (ambiguous) {
                                                // Several accounts share this
                                                // email: list them; attaching
                                                // is done from the customer's
                                                // own record, not here.
                                                const list = (e.candidates || [])
                                                  .map(
                                                    (c) =>
                                                      `${c.name || "(unnamed)"} (${c.emailMasked || "email hidden"})`,
                                                  )
                                                  .join("\n");
                                                alert(
                                                  `This lead's email matches customers in several accounts:\n${list}`,
                                                );
                                              }
                                              const m = e.match || {};
                                              const attach =
                                                !ambiguous &&
                                                window.confirm(
                                                  `This lead's email matches existing customer ${m.name || "(unnamed)"} (${m.emailMasked || "email hidden"}). Attach this booking as an additional property on their account?`,
                                                );
                                              if (attach) {
                                                booked = await submitAppt({
                                                  attachToAccountId: m.accountId,
                                                });
                                              } else if (
                                                // Cancel/Escape on the first prompt
                                                // must NOT create anything — a
                                                // separate customer is its own
                                                // explicit OK.
                                                window.confirm(
                                                  ambiguous
                                                    ? "Create a SEPARATE new customer instead? (Cancel = nothing booked; to attach to one of them, book from that customer's record)"
                                                    : "Create a SEPARATE new customer for this lead instead? (Cancel = do nothing, lead stays unbooked)",
                                                )
                                              ) {
                                                try {
                                                  booked = await submitAppt({
                                                    attachToAccountId: null,
                                                    createSeparateAccount: true,
                                                  });
                                                } catch (e2) {
                                                  if (
                                                    e2?.code !==
                                                    "PHONE_MATCH_CONFIRM"
                                                  )
                                                    throw e2;
                                                  const pm = e2.match || {};
                                                  // Third confirm: a live phone
                                                  // match exists — separate
                                                  // customer anyway?
                                                  if (
                                                    window.confirm(
                                                      `A customer with this phone already exists (${pm.name || "(unnamed)"}, ${pm.phoneMasked || "phone hidden"}) — create a separate customer anyway? (Cancel = do nothing, lead stays unbooked)`,
                                                    )
                                                  ) {
                                                    booked = await submitAppt({
                                                      attachToAccountId: null,
                                                      createSeparateAccount: true,
                                                      ignorePhoneMatch: true,
                                                    });
                                                  } else {
                                                    alert(
                                                      "Nothing was booked — the lead is unchanged.",
                                                    );
                                                    setApptSaving(false);
                                                    return;
                                                  }
                                                }
                                              } else {
                                                alert(
                                                  "Nothing was booked — the lead is unchanged.",
                                                );
                                                setApptSaving(false);
                                                return;
                                              }
                                            }
                                            // Advisory schedule-overlap notes
                                            // — the booking committed
                                            // (conflicts no longer block
                                            // staff saves); say what stacks.
                                            if (
                                              Array.isArray(booked?.warnings) &&
                                              booked.warnings.length
                                            ) {
                                              alert(
                                                `Appointment booked.\n\n${booked.warnings.join("\n\n")}`,
                                              );
                                            }
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
                        colSpan={compactQueue ? 2 : 7}
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
                </tbody>
              </table>{" "}
            </Card>
          </>
        )}

        {pipelineView === "board" && (
          <div role="region" aria-label="Lead board" tabIndex={0}
            style={{
              maxWidth: "100%",
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
                        fontSize: 14,
                        fontWeight: 700,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        flex: 1,
                      }}
                    >
                      {stage.replace(/_/g, " ")}
                    </span>{" "}
                    <span style={{ color: C.muted, fontSize: 14, ...mono }}>
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
                        draggable role="button" tabIndex={0}
                        onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setPipelineView("table"); expandLead(lead); } }}
                        onDragStart={(e) => {
                          e.dataTransfer.setData("text/plain", String(lead.id));
                          setDraggingLeadId(lead.id);
                        }}
                        onDragEnd={() => setDraggingLeadId(null)}
                        onClick={() => {
                          // The expanded detail row only renders in the table,
                          // and the table's status filter (default `open`)
                          // would hide a closed lead's row entirely — widen
                          // the filter when this card wouldn't pass it.
                          setPipelineView("table");
                          if (!leadMatchesStatusFilter(lead, filters.status)) {
                            setFilters((f) => ({ ...f, status: "", page: 1 }));
                          }
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
                              fontSize: 14,
                              fontWeight: 500,
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
                            fontSize: 14,
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
                            fontSize: 14,
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
                            fontSize: 14,
                            fontWeight: 500,
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
                          fontSize: 14,
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
                    fontSize: 14,
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
              fontSize: 14,
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
            <thead>
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
                      fontSize: 14,
                      color: C.muted,
                      fontWeight: 500,
                      textTransform: "uppercase",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
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
                      <td style={{ padding: "12px 14px" }}>
                        {" "}
                        <div
                          style={{
                            color: C.heading,
                            fontSize: 14,
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
                      </td>
                      <td style={{ padding: "12px 14px" }}>
                        <Badge
                          label={src.source_type?.replace(/_/g, " ")}
                          color={C.teal}
                        />
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          color: C.text,
                          fontSize: 14,
                        }}
                      >
                        {src.channel || "--"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 14,
                          color: C.text,
                        }}
                      >
                        {fmtMoney(mc)}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 14,
                          color: C.heading,
                        }}
                      >
                        {monthLeads}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 14,
                          color: C.green,
                        }}
                      >
                        {monthConv}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 14,
                          color:
                            convRate > 20
                              ? C.green
                              : convRate > 10
                                ? C.amber
                                : C.muted,
                        }}
                      >
                        {fmtPct(convRate)}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 14,
                          color: C.text,
                        }}
                      >
                        {cpl > 0 ? fmtMoney(cpl) : "--"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 14,
                          color: C.text,
                        }}
                      >
                        {cpa > 0 ? fmtMoney(cpa) : "--"}
                      </td>
                      <td
                        style={{
                          padding: "12px 14px",
                          ...mono,
                          fontSize: 14,
                          fontWeight: 500,
                          color: roiColor(roi || 0),
                        }}
                      >
                        {hasRoiSignal ? fmtPct(roi) : "--"}
                      </td>
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
            </tbody>
          </table>{" "}
        </Card>{" "}
      </>
    );
  };

  // ═════════════════════════════════════════════════════════════════════════
  // ROI ANALYTICS TAB
  // ═════════════════════════════════════════════════════════════════════════
  const renderAnalytics = () => {
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
            sub={(() => {
              const since = ov.speedToLeadSince
                ? ` since ${fmtShortDate(ov.speedToLeadSince)}`
                : "";
              if (ov.avgSpeedToLead == null) return `None waiting${since}`;
              const quality =
                ov.avgSpeedToLead < 5
                  ? "Great!"
                  : ov.avgSpeedToLead < 15
                    ? "Good"
                    : "Needs work";
              return `${ov.openUnansweredCount} waiting${since} · ${quality}`;
            })()}
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
              fontSize: 14,
              fontWeight: 500,
              fontFamily: ROBOTO,
              letterSpacing: "0.02em",
            }}
          >
            Pipeline status
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
        {/* Channel Comparison */}
        <Card style={{ marginBottom: 24 }}>
          {" "}
          <h2
            style={{
              margin: "0 0 16px",
              color: C.heading,
              fontSize: 14,
              fontWeight: 500,
              fontFamily: ROBOTO,
              letterSpacing: "0.02em",
            }}
          >
            Channel comparison
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
                  fontSize: 14,
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
                  fontSize: 14,
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
              fontSize: 14,
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
              fontSize: 14,
              fontWeight: 500,
              fontFamily: ROBOTO,
              letterSpacing: "0.02em",
            }}
          >
            Source ROI matrix
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
                fontSize: 14,
                fontWeight: 500,
                fontFamily: ROBOTO,
                letterSpacing: "0.02em",
              }}
            >
              Response time vs conversion
            </h2>
            <div
              style={{
                margin: "-12px 0 14px",
                color: C.muted,
                fontSize: 14,
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
                          fontSize: 14,
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
                      <div style={{ fontSize: 14, color: C.muted, ...mono }}>
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
                fontSize: 14,
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
                fontSize: 14,
                fontWeight: 500,
                fontFamily: ROBOTO,
                letterSpacing: "0.02em",
              }}
            >
              Lost lead reasons
            </h2>
            <div
              style={{
                margin: "-12px 0 14px",
                color: C.muted,
                fontSize: 14,
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
                        fontSize: 14,
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
                fontSize: 14,
                fontWeight: 500,
                fontFamily: ROBOTO,
                letterSpacing: "0.02em",
              }}
            >
              Phone number ROI
            </h2>{" "}
          </div>{" "}
          <table
            style={{ width: "100%", borderCollapse: "collapse", minWidth: 700 }}
          >
            <thead>
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
                      fontSize: 14,
                      color: C.muted,
                      fontWeight: 500,
                      textTransform: "uppercase",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {phoneROI.map((s, i) => (
                <tr key={i} style={{ borderBottom: `1px solid ${C.border}` }}>
                  <td
                    style={{
                      padding: "10px 14px",
                      color: C.teal,
                      ...mono,
                      fontSize: 14,
                    }}
                  >
                    {s.source?.twilio_phone_number}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      color: C.text,
                      fontSize: 14,
                    }}
                  >
                    {s.source?.name?.slice(0, 30)}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      ...mono,
                      fontSize: 14,
                      color: C.text,
                    }}
                  >
                    {fmtMoney(s.totalCost)}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      ...mono,
                      fontSize: 14,
                      color: C.heading,
                    }}
                  >
                    {s.totalLeads}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      ...mono,
                      fontSize: 14,
                      color: C.green,
                    }}
                  >
                    {s.conversions}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      ...mono,
                      fontSize: 14,
                      color: C.green,
                    }}
                  >
                    {fmtMoney(s.totalRevenue)}
                  </td>
                  <td
                    style={{
                      padding: "10px 14px",
                      ...mono,
                      fontSize: 14,
                      fontWeight: 500,
                      color: roiColor(s.roi),
                    }}
                  >
                    {s.roi > 0 ? fmtPct(s.roi) : "--"}
                  </td>
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
            </tbody>
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
        <Modal title="New lead" onClose={() => setShowModal(null)}>
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
          {contactMatches?.total > 0 && <div style={{ padding: 12, marginBottom: 12, border: `1px solid ${C.border}`, borderRadius: 8 }}>
            <p style={{ fontSize: 14, margin: "0 0 8px" }}>Possible existing leads with this contact ({contactMatches.total}). Review before creating another record.</p>
            {contactMatches.matches.map((match) => <Btn key={match.id} small onClick={() => {
              setShowModal(null);
              navigate(`/admin/pipeline?lead=${match.id}`);
            }}>{[match.first_name, match.last_name].filter(Boolean).join(" ") || "Open lead"} · {match.status}</Btn>)}
          </div>}
          {contactMatches?.error && <p role="status" style={{ fontSize: 14 }}>Existing-contact check unavailable. Search the queue before creating another record.</p>}
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
          <Input label="Notes" value={formData.notes} onChange={(notes) => setFormData((f) => ({ ...f, notes }))} />
          <details style={{ marginBottom: 16 }}>
            <summary style={{ minHeight: 44, cursor: "pointer", fontSize: 14 }}>Property and intake details (optional)</summary>
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
          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            {" "}
            <div style={{ flex: "1 1 55%" }}>
              <Input
                label="Builder Termite Warranty (provider)"
                value={formData.builder_warranty_provider}
                onChange={(v) =>
                  setFormData((f) => ({ ...f, builder_warranty_provider: v }))
                }
                placeholder="who covers the home today"
              />
            </div>{" "}
            <div style={{ flex: "1 1 35%" }}>
              <Input
                label="Warranty Expires"
                type="date"
                value={formData.builder_warranty_expires_on}
                onChange={(v) =>
                  setFormData((f) => ({ ...f, builder_warranty_expires_on: v }))
                }
              />
            </div>{" "}
          </div>{" "}
          </details>
          <Btn onClick={submitForm} disabled={loading}>
            {loading ? "Saving..." : "Create Lead"}
          </Btn>{" "}
        </Modal>
      );

    if (showModal === "builderWarranty")
      return (
        <Modal
          title="Builder termite warranty"
          onClose={() => setShowModal(null)}
        >
          {" "}
          <Input
            label="Provider"
            value={formData.builder_warranty_provider}
            onChange={(v) =>
              setFormData((f) => ({ ...f, builder_warranty_provider: v }))
            }
            placeholder="who covers the home today"
          />{" "}
          <Input
            label="Expires"
            type="date"
            value={formData.builder_warranty_expires_on}
            onChange={(v) =>
              setFormData((f) => ({ ...f, builder_warranty_expires_on: v }))
            }
          />{" "}
          <div style={{ fontSize: 14, color: C.muted, marginBottom: 12 }}>
            Clearing both fields removes the warranty from this lead.
          </div>{" "}
          <Btn onClick={submitForm} disabled={loading}>
            {loading ? "Saving..." : "Save"}
          </Btn>{" "}
        </Modal>
      );

    if (showModal === "convert")
      return (
        <Modal title="Convert to customer" onClose={() => setShowModal(null)}>
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
        <Modal title="Mark lead lost" onClose={() => setShowModal(null)}>
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
                fontSize: 14,
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
                fontSize: 14,
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
        <Modal title="Assign lead" onClose={() => setShowModal(null)}>
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
        <Modal title="Add lead source" onClose={() => setShowModal(null)}>
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
        <Modal title="Log source cost" onClose={() => setShowModal(null)}>
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
        padding: 0,
        minWidth: 0,
        maxWidth: 1400,
        margin: "0 auto",
        color: C.text,
        fontFamily: ROBOTO,
      }}
    >
      {" "}
      <style>{`
        .lead-queue-table td { overflow-wrap: anywhere; }
        .lead-queue-table :is(td, th) { padding-inline: 8px !important; }
        .lead-queue-table :is(input, textarea) { min-width: 0; min-height: 44px; font-size: 16px !important; }
        .lead-queue-table select { width: 100%; min-height: 44px; font-size: 16px !important; max-width: 100%; background: white !important; color: #27272a !important; }
        @media (max-width: 1279px) {
          .lead-queue-table, .lead-queue-table > tbody, .lead-queue-table > tbody > tr, .lead-queue-table > tbody > tr > td { display: block; width: 100%; }
          .lead-queue-record { display: grid; grid-template-columns: minmax(0, 1fr); padding: 12px 16px; }
          .lead-queue-table :is(button, input, select, textarea) { scroll-margin-block: 90px; }
          .lead-queue-record > td { padding: 0 !important; }
          .lead-queue-record > td:last-child { padding-top: 8px !important; }
          .lead-queue-record select { width: 100%; }
          .lead-queue-table > tbody > tr:not(.lead-queue-record) > td > div { padding: 16px !important; }
        }
      `}</style>
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
            fontSize: 14,
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
              fontSize: 14,
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
