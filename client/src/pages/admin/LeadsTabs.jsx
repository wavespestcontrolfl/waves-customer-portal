import { useCustomerSms } from "../../components/admin/customer360/CustomerSmsPanel";
import React, {
  useState,
  useEffect,
  useCallback,
  useRef,
  useMemo,
} from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Trash2, Search, SlidersHorizontal } from "lucide-react";
import { callViaBridge } from "../../components/admin/CallBridgeLink";
import AuthenticatedCallAudio from "../../components/admin/AuthenticatedCallAudio";
import useIsMobile from "../../hooks/useIsMobile";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";
import {
  ActionFeedback,
  Badge,
  Button,
  Card,
  Dialog,
  DialogBody,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  Table,
  TBody,
  TD,
  TH,
  THead,
  TR,
  Textarea,
  UiSurface,
} from "../../components/ui";
const API_BASE = import.meta.env.VITE_API_URL || "/api";

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
  if (zip && !segments.some((seg) => seg.split(/\s+/).includes(zip)))
    parts.push(zip);
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
  const et = (v) =>
    v
      ? new Date(v).toLocaleString("en-US", {
          timeZone: "America/New_York",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        })
      : "";
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
  useEffect(() => {
    setRows([]);
    setError(null);
    load();
  }, [load]);
  const act = async (row, action) => {
    if (busyId) return;
    setBusyId(row.id);
    try {
      await adminFetch(`/admin/call-recordings/commitments/${encodeURIComponent(row.id)}`, { method: "PATCH", body: JSON.stringify({ action, expected_at: row.updated_at }) });
      await load();
    } catch (err) {
      setError(err.message || "That change did not save.");
    } finally {
      setBusyId(null);
    }
  };
  if (!rows.length && !error) return null;
  return (
    <div data-testid="lead-owed" className="mt-[12px]">
      <h4 className="m-0 mb-[8px] text-zinc-900 text-ui-body">Owed on this lead</h4>
      {error && (
        <div role="alert" className="text-alert-fg text-ui-body mb-[8px]">
          {error}{" "}
          <Button
            type="button"
            onClick={load}
            variant="secondary"
            className="min-h-[32px]"
          >
            Retry
          </Button>
        </div>
      )}
      {rows.slice(0, LEAD_OWED_LIMIT).map((row) => (
        <Card
          key={row.id}
          className={`mb-[8px] p-[10px] text-ui-body text-zinc-900 ${row.overdue ? "border-alert-fg" : ""}`}
        >
          <div className="mb-[4px]">
            <strong>
              {row.party === "waves" ? "Waves promised" : "Customer agreed"}:
            </strong>{" "}
            {row.description}
          </div>
          <div
            className={`mb-[6px] ${row.overdue ? "text-alert-fg" : "text-ink-secondary"}`}
          >
            {row.overdue
              ? "Overdue"
              : row.effective_due_at || row.due_at
                ? `Due ${et(row.effective_due_at || row.due_at)} ET`
                : "No due time"}
            {" · call "}
            {et(row.call_started_at)} ET
          </div>
          {enabled && (
            <>
              <Button
                type="button"
                disabled={busyId === row.id}
                onClick={() => act(row, "fulfill")}
                variant="secondary"
                className="mr-[8px] min-h-[32px]"
              >
                Mark done
              </Button>
              <Button
                type="button"
                disabled={busyId === row.id}
                onClick={() => act(row, "dismiss")}
                variant="secondary"
                className="min-h-[32px]"
              >
                Dismiss
              </Button>
            </>
          )}
        </Card>
      ))}
      {rows.length > LEAD_OWED_LIMIT && (
        <div className="text-ink-secondary text-ui-body">
          More promises are owed on this lead —{" "}
          <a href="/admin/communications#tab=owed" className="text-zinc-900">
            open the Owed tab
          </a>{" "}
          for the full queue.
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
const OPEN_FILTER_STATUSES = [
  "new",
  "contacted",
  "estimate_sent",
  "estimate_viewed",
];
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
  return (
    typeof document === "undefined" || document.visibilityState !== "hidden"
  );
}
function daysSinceContact(lead) {
  if (!lead.first_contact_at) return null;
  const ms = Date.now() - new Date(lead.first_contact_at).getTime();
  return Math.floor(ms / 86400000);
}
function leadEstimateParams(lead) {
  const params = new URLSearchParams({
    tab: "new",
  });
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
// Main's roiColor(): positive/zero ROI stays the default heading color,
// negative ROI is a genuine alert (red).
function roiColorClass(roi) {
  return roi < 0 ? "text-alert-fg" : "text-zinc-900";
}
// Main's STATUS_COLORS: only lost/disqualified are a real color (alert
// red); new/won/estimate_sent are zinc-900/900/700, contacted/
// estimate_viewed are zinc-600, unresponsive/duplicate are zinc-400 — a
// weight ladder, not a hue-coded status system. Restored for the stage
// Select and the Kanban dot so lost/disqualified read as genuine alerts
// and the other stages keep their relative weight. Full literal class
// strings per key (not template-interpolated) so Tailwind's static
// content scan can find and generate them.
const STATUS_SELECT_CLASS = {
  new: "!bg-zinc-900/10 !border-zinc-900/25 !text-zinc-900",
  contacted: "!bg-zinc-600/10 !border-zinc-600/25 !text-zinc-600",
  estimate_sent: "!bg-zinc-700/10 !border-zinc-700/25 !text-zinc-700",
  estimate_viewed: "!bg-zinc-600/10 !border-zinc-600/25 !text-zinc-600",
  won: "!bg-zinc-900/10 !border-zinc-900/25 !text-zinc-900",
  lost: "!bg-alert-bg !border-alert-fg/40 !text-alert-fg",
  unresponsive: "!bg-zinc-400/10 !border-zinc-400/25 !text-zinc-400",
  disqualified: "!bg-alert-bg !border-alert-fg/40 !text-alert-fg",
  duplicate: "!bg-zinc-400/10 !border-zinc-400/25 !text-zinc-400",
};
const STATUS_DOT_CLASS = {
  new: "bg-zinc-900",
  contacted: "bg-zinc-600",
  estimate_sent: "bg-zinc-700",
  estimate_viewed: "bg-zinc-600",
  won: "bg-zinc-900",
  lost: "bg-alert-fg",
  unresponsive: "bg-zinc-400",
  disqualified: "bg-alert-fg",
  duplicate: "bg-zinc-400",
};
function statusSelectClass(status) {
  return STATUS_SELECT_CLASS[status] || "";
}
function statusDotClass(status) {
  return STATUS_DOT_CLASS[status] || "bg-zinc-400";
}
function LeadBadge({ label, tone = "neutral", className }) {
  // The old inline-styled badge had whiteSpace: "nowrap"; the shared Badge
  // primitive doesn't supply it, so a multiword label (or one squeezed
  // into a narrow table column) can wrap into a malformed two-line chip.
  return (
    <Badge tone={tone} className={`whitespace-nowrap ${className || ""}`}>
      {label}
    </Badge>
  );
}
function AgingBadge({ lead }) {
  if (CLOSED_STATUSES.includes(lead.status)) return null;
  const days = daysSinceContact(lead);
  if (days == null) return null;
  const label = days < 1 ? "today" : days === 1 ? "1d" : `${days}d`;
  // Main's 4-tier: <1d strong(heading)/1-2d muted/3-6d C.amber(zinc-600, a
  // distinct non-alert step before red)/>=7d C.red(alert). "strong" is
  // already the <1d tier, so the 3-6d mid-age warning can't reuse it
  // without collapsing the two together — restored as an explicit
  // zinc-600 chip, matching main's weight instead.
  if (days >= 1 && days < 3) return <LeadBadge label={label} tone="neutral" />;
  if (days >= 3 && days < 7)
    return (
      <LeadBadge
        label={label}
        tone="neutral"
        className="!bg-zinc-600/15 !text-zinc-600"
      />
    );
  return (
    <LeadBadge label={label} tone={days < 1 ? "strong" : "alert"} />
  );
}
function MetricCard({ label, value, sub, alert = false, valueClassName }) {
  return (
    <Card
      className={`flex-[1_1_180px] min-w-[160px] p-5 ${alert ? "border-alert-fg" : ""}`}
    >
      {" "}
      <div className="text-ui-body text-ink-secondary mb-[4px]">
        {label}
      </div>{" "}
      {/* The old "26" class was not a configured fontSize utility
          (tailwind.config.js only defines 11/12/13/14/16/18/22/28), so it
          silently rendered at the inherited body size instead of main's
          explicit 26px. There is no nearby custom token (22 and 28 both
          drift 2-4px), so this uses the arbitrary-value syntax below for
          an exact match instead. */}
      <div
        className={`text-[26px] font-medium ${alert ? "text-alert-fg" : valueClassName || ""}`}
      >
        {value}
      </div>
      {sub && (
        <div className="text-ui-body text-ink-secondary mt-[2px]">{sub}</div>
      )}
    </Card>
  );
}
function PipelineStatusCard({ label, value }) {
  return (
    <Card className="flex-[1_1_140px] min-w-[140px] p-[14px] text-left">
      <div className="flex items-center gap-[6px] mb-[4px]">
        <span className="text-ui-body font-medium text-ink-secondary">
          {label}
        </span>
      </div>
      <div className="text-[22px] font-medium text-zinc-900">{value}</div>
    </Card>
  );
}
function LeadsWorkspaceNav({ active, onChange }) {
  return (
    <nav aria-label="Lead tools" className="flex gap-[16px] mb-[12px]">
      {[
        {
          key: "pipeline",
          label: "Work queue",
        },
        {
          key: "sources",
          label: "Sources",
        },
        {
          key: "analytics",
          label: "Analytics",
        },
      ].map(({ key, label }) => (
        <Button
          key={key}
          type="button"
          onClick={() => onChange(key)}
          aria-current={active === key ? "page" : undefined}
          variant={active === key ? "primary" : "secondary"}
        >
          {label}
        </Button>
      ))}
    </nav>
  );
}
function LeadField({
  label,
  value,
  onChange,
  type,
  placeholder,
  className,
  options,
}) {
  const control = options ? (
    <Select
      value={value || ""}
      onChange={(event) => onChange(event.target.value)}
      className={className}
    >
      <option value="">-- Select --</option>
      {options.map((option) => (
        <option key={option.value || option} value={option.value || option}>
          {option.label || option}
        </option>
      ))}
    </Select>
  ) : (
    <Input
      type={type || "text"}
      value={value || ""}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className={className}
    />
  );
  return label ? (
    <Field label={label} className="mb-3">
      {control}
    </Field>
  ) : (
    control
  );
}
function LeadDialog({ title, onClose, children }) {
  return (
    <Dialog open onClose={onClose}>
      <DialogHeader className="flex items-center justify-between gap-3">
        <DialogTitle className="m-0">{title}</DialogTitle>
        <Button variant="ghost" onClick={onClose} aria-label="Close">
          ×
        </Button>
      </DialogHeader>
      <DialogBody>{children}</DialogBody>
    </Dialog>
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
// ═══════════════════════════════════════════════════════════════════════════
// SPEED-TO-LEAD TIMER
// ═══════════════════════════════════════════════════════════════════════════

// Inject pulse keyframe once (main's stlPulse, unchanged)
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
  // Main's C.green/C.amber are #3F3F46/#52525B (zinc-700/zinc-600) in this
  // file's local palette, NOT real hues — this admin surface is monochrome
  // by design (only C.red is a genuine color, reserved for the >=15min
  // alert). Restored as the exact matching zinc shades, not invented amber.
  const colorClass =
    mins < 5
      ? "text-zinc-700"
      : mins < 15
        ? "text-zinc-600"
        : "text-alert-fg";
  const shouldPulse = mins >= 5;
  return (
    <span
      className={`text-ui-body font-medium ${colorClass}`}
      style={{
        animation: shouldPulse ? "stlPulse 1.5s ease-in-out infinite" : "none",
      }}
    >
      {hh}:{mm}:{ss}
    </span>
  );
}
const LOST_REASONS = [
  {
    value: "price",
    label: "Price too high",
  },
  {
    value: "competitor",
    label: "Chose competitor",
  },
  {
    value: "diy",
    label: "DIY / self-treating",
  },
  {
    value: "not_ready",
    label: "Not ready yet",
  },
  {
    value: "no_response",
    label: "No response",
  },
  {
    value: "out_of_area",
    label: "Out of service area",
  },
  {
    value: "no_need",
    label: "No longer needed",
  },
  {
    value: "other",
    label: "Other",
  },
];

// ═══════════════════════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════════════════════
// Read the dashboard "drill into source" params off the URL once, so the leads
// filters can be initialized from them on the very first render — the initial
// pipeline load is then already scoped, avoiding an unfiltered first fetch that
// (with no stale-response guard) could resolve last and overwrite the results.
function readSourceDrillParams(
  sp = new URLSearchParams(window.location.search),
) {
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
const LEAD_FILTER_KEYS = {
  status: "leadStatus",
  search: "leadSearch",
  sort: "leadSort",
  page: "leadPage",
  source_name: "source_name",
  start_date: "start_date",
  end_date: "end_date",
  builder_warranty: "builder_warranty",
};
function leadFiltersFromParams(params) {
  const drill = readSourceDrillParams(params);
  const status = params.get("leadStatus");
  return {
    status:
      status === "all"
        ? ""
        : ["open", ...STATUSES].includes(status)
          ? status
          : params.has("lead")
            ? ""
            : (drill?.status ?? "open"),
    search: params.get("leadSearch") || "",
    sort: params.get("leadSort") || "first_contact_at",
    page: Math.max(1, Number.parseInt(params.get("leadPage"), 10) || 1),
    source_name: params.get("source_name") || "",
    start_date: params.get("start_date") || drill?.start_date || "",
    end_date: params.get("end_date") || drill?.end_date || "",
    builder_warranty:
      params.get("builder_warranty") === "expiring" ? "expiring" : "",
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
  const messageLead = (lead, initialDraft = "") =>
    openMessages?.(
      {
        id: lead.customer_id,
        firstName: lead.first_name,
        lastName: lead.last_name,
        phone: lead.phone,
      },
      {
        leadId: lead.id,
        initialDraft,
        onSent: () => {
          loadLeads();
          loadLeadActivities(lead.id, {
            silent: true,
          });
        },
      },
    );
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
    if (showModal !== "newLead" || (!formData.phone && !formData.email))
      return undefined;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const query = new URLSearchParams({
          phone: formData.phone || "",
          email: formData.email || "",
        });
        const data = await adminFetch(`/admin/leads/contact-matches?${query}`);
        if (!cancelled) setContactMatches(data);
      } catch {
        if (!cancelled)
          setContactMatches({
            error: true,
          });
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [showModal, formData.phone, formData.email]);
  const filters = useMemo(
    () => leadFiltersFromParams(searchParams),
    [searchParams],
  );
  const linkedLeadId = searchParams.get("lead");
  const setFilters = useCallback(
    (updater) => {
      setSearchParams(
        (params) => {
          const current = leadFiltersFromParams(params);
          const next =
            typeof updater === "function" ? updater(current) : updater;
          const updated = new URLSearchParams(params);
          ["from", "to", "status", "lead"].forEach((key) =>
            updated.delete(key),
          );
          if (!next.source_name) updated.delete("period_label");
          for (const [key, param] of Object.entries(LEAD_FILTER_KEYS)) {
            if (key === "status") updated.set(param, next[key] || "all");
            else if (next[key] && !(key === "page" && next[key] === 1))
              updated.set(param, String(next[key]));
            else updated.delete(param);
          }
          return updated;
        },
        {
          replace: true,
        },
      );
    },
    [setSearchParams],
  );
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
  const pipelineView =
    searchParams.get("leadView") === "board" ? "board" : "table";
  const setPipelineView = useCallback(
    (view) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          if (view === "board") next.set("leadView", "board");
          else next.delete("leadView");
          return next;
        },
        {
          replace: true,
        },
      );
    },
    [setSearchParams],
  );
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
  const loadLeads = useCallback(
    async ({ silent = false } = {}) => {
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
        if (debouncedSearch.trim())
          params.set("search", debouncedSearch.trim());
        if (filters.source_name) params.set("source_name", filters.source_name);
        if (filters.builder_warranty)
          params.set("builder_warranty", filters.builder_warranty);
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
    },
    [
      linkedLeadId,
      filters.status,
      filters.sort,
      filters.page,
      filters.source_name,
      filters.start_date,
      filters.end_date,
      filters.builder_warranty,
      debouncedSearch,
    ],
  );
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
      ).catch(() => ({
        services: [],
      }));
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
    if (tab === "pipeline") void loadLeads();
  }, [tab, loadLeads]);
  useEffect(() => {
    void loadSources();
    if (tab === "sources") void loadSourceROI();
    if (tab === "analytics") void loadAnalytics();
  }, [tab, loadSources, loadSourceROI, loadAnalytics]);
  useEffect(() => {
    if (tab !== "pipeline") return undefined;
    const id = window.setInterval(() => {
      if (isPageVisible())
        void loadLeads({
          silent: true,
        });
    }, LEADS_REFRESH_MS);
    return () => {
      window.clearInterval(id);
      leadsRequestRef.current += 1;
    };
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
      loadLeadActivities(expandedLead, {
        silent: true,
      });
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
        <div className="mb-[16px]">
          <div className="flex gap-[8px] items-center flex-wrap">
            <div className="relative flex-[1_1_180px] min-w-[0px]">
              <Search
                size={18}
                aria-hidden
                className="pointer-events-none absolute left-3 top-1/2 z-10 -translate-y-1/2 text-ink-secondary"
              />
              <Input
                type="search"
                aria-label="Search leads"
                placeholder="Search leads"
                value={filters.search}
                onChange={(event) =>
                  setFilters((f) => ({
                    ...f,
                    search: event.target.value,
                    page: 1,
                  }))
                }
                className="w-full pl-10"
              />
            </div>
            <Button
              onClick={() => setFiltersOpen((open) => !open)}
              aria-expanded={filtersOpen}
              aria-controls="lead-queue-filters"
              variant="primary"
              className="inline-flex gap-[6px] items-center"
            >
              <SlidersHorizontal size={18} aria-hidden /> Filters
              {(filters.status !== "open" ||
                filters.source_name ||
                filters.builder_warranty ||
                filters.sort !== "first_contact_at") && (
                <span
                  aria-label="Active filters"
                  className="h-[6px] w-[6px] rounded-sm bg-white"
                />
              )}
            </Button>
            {!isMobile && (
              <div
                role="group"
                aria-label="Lead view"
                className="flex gap-[4px]"
              >
                {["table", "board"].map((view) => (
                  <Button
                    key={view}
                    onClick={() => setPipelineView(view)}
                    aria-pressed={pipelineView === view}
                    variant={pipelineView === view ? "primary" : "secondary"}
                  >
                    {view === "table" ? "List" : "Board"}
                  </Button>
                ))}
              </div>
            )}
          </div>
          {(filtersOpen || !isMobile) && (
            <div
              id="lead-queue-filters"
              className="flex flex-wrap items-end gap-[12px] mt-[12px]"
            >
              <LeadField
                label="Stage"
                value={filters.status || "all"}
                onChange={(value) =>
                  setFilters((f) => ({
                    ...f,
                    status: value === "all" ? "" : value,
                    page: 1,
                  }))
                }
                options={[
                  {
                    value: "open",
                    label: "Open leads",
                  },
                  {
                    value: "all",
                    label: "All stages",
                  },
                  ...STATUSES.map((value) => ({
                    value,
                    label: value.replace(/_/g, " "),
                  })),
                ]}
              />
              <LeadField
                label="Sort"
                value={filters.sort}
                onChange={(sort) =>
                  setFilters((f) => ({
                    ...f,
                    sort,
                    page: 1,
                  }))
                }
                options={[
                  {
                    value: "first_contact_at",
                    label: "Newest first",
                  },
                  {
                    value: "name",
                    label: "Name A–Z",
                  },
                  {
                    value: "status",
                    label: "Stage",
                  },
                  {
                    value: "response_time",
                    label: "Response time",
                  },
                  {
                    value: "monthly_value",
                    label: "Monthly value",
                  },
                ]}
              />
              {isMobile && (
                <LeadField
                  label="View"
                  value={pipelineView}
                  onChange={setPipelineView}
                  options={[
                    {
                      value: "table",
                      label: "List",
                    },
                    {
                      value: "board",
                      label: "Board",
                    },
                  ]}
                />
              )}
              {(filters.source_name || filters.builder_warranty) && (
                <p className="text-ui-body">
                  {[
                    filters.source_name,
                    sourcePeriodLabel,
                    filters.builder_warranty && "Builder warranty expiring",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </p>
              )}
              <Button
                onClick={() => {
                  setFilters({
                    status: "open",
                    search: "",
                    sort: "first_contact_at",
                    page: 1,
                  });
                  setSourcePeriodLabel("");
                }}
                variant="secondary"
                className="mb-[12px]"
              >
                Reset filters
              </Button>
            </div>
          )}
          <div
            role="status"
            aria-live="polite"
            className="mt-[12px] text-ink-secondary text-ui-body"
          >
            {leadsTotal === 0
              ? "No matching leads"
              : `${(filters.page - 1) * 50 + 1}–${Math.min(filters.page * 50, leadsTotal)} of ${leadsTotal} matching leads`}
            {pipelineView === "board" ? " · column counts show this page" : ""}
          </div>
        </div>
        {pipelineView === "table" && (
          <>
            {/* Leads Table */}
            <Card className="p-[0px]">
              {" "}
              <Table className="lead-queue-table table-fixed" layout="records">
                {!compactQueue && (
                  <colgroup>
                    {[26, 13, 19, 8, 18, 10, 6].map((width, index) => (
                      <col key={index} style={{ width: `${width}%` }} />
                    ))}
                  </colgroup>
                )}
                <THead className={compactQueue ? "hidden" : ""}>
                  <TR>
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
                      <TH key={h} className="text-left text-ink-secondary">
                        {h}
                      </TH>
                    ))}
                  </TR>
                </THead>
                <TBody>
                  {leads.map((lead) => {
                    const isExpanded = expandedLead === lead.id;
                    return (
                      <React.Fragment key={lead.id}>
                        <TR
                          className={`lead-queue-record cursor-pointer ${isExpanded ? "bg-zinc-50" : ""}`}
                          onClick={() => expandLead(lead)}
                        >
                          <TD>
                            {" "}
                            <div className="flex flex-wrap items-center gap-[8px]">
                              {" "}
                              <Button
                                type="button"
                                onClick={(event) => {
                                  event.stopPropagation();
                                  expandLead(lead);
                                }}
                                aria-expanded={isExpanded}
                                variant="secondary"
                                className="min-h-[44px] text-left"
                              >
                                {[lead.first_name, lead.last_name]
                                  .filter(Boolean)
                                  .join(" ") || "Unknown"}
                              </Button>{" "}
                              <AgingBadge lead={lead} />{" "}
                            </div>{" "}
                            <div className="text-ink-secondary text-ui-body">
                              {lead.phone || lead.email || "--"}
                            </div>{" "}
                            {compactQueue && lead.service_interest && (
                              <div className="text-zinc-900 text-ui-body">
                                {lead.service_interest}
                              </div>
                            )}{" "}
                            {lead.estimate_id && (
                              <div className="text-ui-body text-ink-secondary">
                                Estimate: {lead.estimate_status || "linked"}
                              </div>
                            )}
                            <div className="text-ui-body text-ink-secondary">
                              {lead.next_follow_up_at
                                ? `Follow up ${fmtShortDate(lead.next_follow_up_at)}`
                                : `Added ${fmtShortDate(lead.first_contact_at)}`}
                            </div>
                          </TD>
                          {!compactQueue && (
                            <>
                              <TD>
                                {lead.source_name ? (
                                  <LeadBadge
                                    label={lead.source_name}
                                    tone={"strong"}
                                  />
                                ) : (
                                  <span className="text-ink-secondary text-ui-body">
                                    --
                                  </span>
                                )}
                              </TD>
                              <TD className="text-zinc-900">
                                {lead.service_interest || "--"}
                                {lead.builder_warranty_expires_on && (
                                  <LeadBadge
                                    label={`warranty exp ${String(lead.builder_warranty_expires_on).slice(0, 10)}`}
                                    tone={"neutral"}
                                    className="ml-[6px]"
                                  />
                                )}
                              </TD>
                              <TD>
                                {" "}
                                <LeadBadge
                                  label={lead.urgency || "normal"}
                                  tone={
                                    lead.urgency === "urgent"
                                      ? "alert"
                                      : "neutral"
                                  }
                                  // Main's C.amber (zinc-600) distinguished
                                  // "high" from normal (muted); restored as
                                  // an explicit zinc-600 chip rather than
                                  // reusing "strong" (a different tier
                                  // elsewhere) or collapsing into neutral.
                                  className={
                                    lead.urgency === "high"
                                      ? "!bg-zinc-600/15 !text-zinc-600"
                                      : undefined
                                  }
                                />{" "}
                              </TD>
                            </>
                          )}
                          <TD onClick={(e) => e.stopPropagation()}>
                            {" "}
                            <Select
                              aria-label={`Stage for ${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "lead"}`}
                              value={lead.status}
                              onChange={(e) =>
                                updateLeadStatus(lead.id, e.target.value)
                              }
                              className={statusSelectClass(lead.status)}
                            >
                              {STATUSES.map((s) => (
                                <option key={s} value={s}>
                                  {s.replace(/_/g, " ")}
                                </option>
                              ))}
                            </Select>{" "}
                          </TD>
                          {!compactQueue && (
                            <>
                              <TD
                                className={
                                  lead.response_time_minutes != null
                                    ? lead.response_time_minutes < 15
                                      ? "text-zinc-700"
                                      : lead.response_time_minutes < 60
                                        ? "text-zinc-600"
                                        : "text-alert-fg"
                                    : "text-ink-secondary"
                                }
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
                              </TD>
                              <TD onClick={(e) => e.stopPropagation()}>
                                <Button
                                  onClick={() => expandLead(lead)}
                                  aria-expanded={isExpanded}
                                  variant="secondary"
                                  className="whitespace-nowrap"
                                >
                                  Open
                                </Button>
                              </TD>
                            </>
                          )}
                        </TR>
                        {isExpanded && (
                          <TR>
                            <TD
                              colSpan={compactQueue ? 2 : 7}
                              className="p-[0px]"
                            >
                              {" "}
                              <div className="border-b border-solid border-zinc-200 bg-zinc-50 px-6 py-4">
                                {" "}
                                <div className="flex gap-[16px] flex-wrap mb-[16px]">
                                  {" "}
                                  <div className="flex-[1_1_300px]">
                                    {" "}
                                    <h4 className="m-0 mb-[8px] text-zinc-900 text-ui-body">
                                      Details
                                    </h4>{" "}
                                    <div className="text-ui-body text-ink-secondary">
                                      {" "}
                                      <div>
                                        Service:{" "}
                                        <span className="text-zinc-900 font-medium">
                                          {lead.service_interest || "--"}
                                        </span>
                                      </div>{" "}
                                      <div>
                                        Email:{" "}
                                        <span className="text-zinc-900">
                                          {lead.email || "--"}
                                        </span>
                                      </div>{" "}
                                      <div>
                                        Address:{" "}
                                        <span className="text-zinc-900">
                                          {formatLeadAddress(lead) || "--"}
                                        </span>
                                      </div>{" "}
                                      {leadAdditionalProperties(lead).length >
                                        0 && (
                                        <div>
                                          Also cover:{" "}
                                          <span className="text-zinc-900">
                                            {leadAdditionalProperties(
                                              lead,
                                            ).join(" · ")}
                                          </span>
                                        </div>
                                      )}{" "}
                                      <div>
                                        Type:{" "}
                                        <span className="text-zinc-900">
                                          {lead.lead_type?.replace(/_/g, " ") ||
                                            "--"}
                                        </span>
                                      </div>{" "}
                                      <div>
                                        First Contact:{" "}
                                        <span className="text-zinc-900">
                                          {lead.first_contact_at
                                            ? new Date(
                                                lead.first_contact_at,
                                              ).toLocaleString()
                                            : "--"}
                                        </span>
                                      </div>
                                      <div>
                                        Builder Warranty:{" "}
                                        <span className="text-zinc-900">
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
                                                    `expires ${String(lead.builder_warranty_expires_on).slice(0, 10)}`
                                                  : null,
                                              ]
                                                .filter(Boolean)
                                                .join(" — ")
                                            : "--"}
                                        </span>{" "}
                                        <Button
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
                                        </Button>
                                      </div>
                                      {lead.monthly_value && (
                                        <div>
                                          Monthly Value:{" "}
                                          <span className="text-zinc-700">
                                            {fmtMoneyExact(lead.monthly_value)}
                                          </span>
                                        </div>
                                      )}
                                      {lead.transcript_summary && (
                                        <div>
                                          Notes:{" "}
                                          <span className="text-zinc-900">
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
                                                <span className="text-zinc-900">
                                                  {timelineLabel}
                                                </span>
                                              </div>
                                            )}
                                            {ex.pain_points && (
                                              <div>
                                                Concerns:{" "}
                                                <span className="text-zinc-900">
                                                  {ex.pain_points}
                                                </span>
                                              </div>
                                            )}
                                            {ex.preferred_date_time && (
                                              <div>
                                                Preferred Time:{" "}
                                                <span className="text-zinc-900">
                                                  {fmtPreferredDateTime(
                                                    ex.preferred_date_time,
                                                  )}
                                                </span>
                                              </div>
                                            )}
                                            {quoteFlags.length > 0 && (
                                              <div className="mt-[4px]">
                                                {quoteFlags.map((f) => (
                                                  <LeadBadge
                                                    key={f}
                                                    label={f}
                                                    tone={"neutral"}
                                                    className="mr-[6px]"
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
                                      <div className="mt-[12px]">
                                        <h4 className="m-0 mb-[8px] text-zinc-900 text-ui-body">
                                          Calls
                                        </h4>
                                        {leadCalls.map((call) => (
                                          <div
                                            key={call.id}
                                            className="border-hairline border-zinc-200 rounded-md p-[10px] mb-[8px] text-ui-body text-ink-secondary"
                                          >
                                            <div className="mb-[6px]">
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
                                                className="mb-[6px] text-zinc-900"
                                              />
                                            )}
                                            {call.transcription && (
                                              <details>
                                                <summary className="cursor-pointer text-zinc-900 text-ui-body">
                                                  View transcript
                                                </summary>
                                                <div className="mt-[6px] max-h-[180px] overflow-y-auto whitespace-pre-wrap text-zinc-900 text-ui-body">
                                                  {call.transcription}
                                                </div>
                                              </details>
                                            )}
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>{" "}
                                  <div className="flex-[1_1_300px]">
                                    {" "}
                                    <h4 className="m-0 mb-[8px] text-zinc-900 text-ui-body">
                                      Activity Timeline
                                    </h4>{" "}
                                    <div className="max-h-[200px] overflow-y-auto">
                                      {leadActivitiesLoading && (
                                        <div className="text-ink-secondary text-ui-body">
                                          Loading activities...
                                        </div>
                                      )}
                                      {!leadActivitiesLoading &&
                                        leadActivitiesError && (
                                          <div className="text-alert-fg text-ui-body">
                                            Activity failed to load:{" "}
                                            {leadActivitiesError.message ||
                                              String(leadActivitiesError)}
                                          </div>
                                        )}
                                      {!leadActivitiesLoading &&
                                        !leadActivitiesError &&
                                        leadActivities.length === 0 && (
                                          <div className="text-ink-secondary text-ui-body">
                                            No activities logged
                                          </div>
                                        )}
                                      {leadActivities.map((a) => (
                                        <div
                                          key={a.id}
                                          // border-left is not a Tailwind
                                          // utility, and border-hairline
                                          // sets width+style on all four
                                          // sides — main's 2px left-side
                                          // timeline connector needs the
                                          // side-specific utilities below.
                                          className="text-ui-body text-ink-secondary border-l-2 border-solid border-zinc-200 pl-[12px] ml-[4px] mb-[4px]"
                                        >
                                          {" "}
                                          <LeadBadge
                                            label={a.activity_type}
                                            tone={"strong"}
                                            className="mr-[8px]"
                                          />{" "}
                                          <span className="text-zinc-900">
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
                                              <div className="mt-[2px] text-zinc-900">
                                                {lines.join(" — ")}
                                              </div>
                                            );
                                          })()}
                                          <div className="text-ui-body mt-[2px]">
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
                                    <div className="border-hairline border-zinc-200 rounded-md p-[14px] mb-[14px]">
                                      {" "}
                                      <div className="text-ui-body text-zinc-900 font-medium mb-[6px]">
                                        AI Suggested Reply
                                      </div>{" "}
                                      <div className="text-ui-body text-zinc-900 mb-[8px]">
                                        {meta.suggestedReply}
                                      </div>
                                      {meta.serviceInterest && (
                                        <LeadBadge
                                          label={meta.serviceInterest}
                                          tone={"strong"}
                                          className="mr-[6px]"
                                        />
                                      )}
                                      {meta.urgency &&
                                        meta.urgency !== "normal" && (
                                          <LeadBadge
                                            label={meta.urgency}
                                            tone={
                                              meta.urgency === "urgent"
                                                ? "alert"
                                                : "neutral"
                                            }
                                            className={
                                              meta.urgency === "urgent"
                                                ? "mr-[6px]"
                                                : "mr-[6px] !bg-zinc-600/15 !text-zinc-600"
                                            }
                                          />
                                        )}
                                      <div className="mt-[10px]">
                                        {" "}
                                        <Button
                                          variant={"primary"}
                                          onClick={() =>
                                            messageLead(
                                              lead,
                                              meta.suggestedReply,
                                            )
                                          }
                                        >
                                          Review reply
                                        </Button>{" "}
                                      </div>{" "}
                                    </div>
                                  );
                                })()}
                                {/* Quick Actions */}
                                <div className="flex gap-[8px] flex-wrap mb-[12px]">
                                  {" "}
                                  <Button
                                    variant={"primary"}
                                    onClick={() => {
                                      messageLead(lead);
                                    }}
                                  >
                                    Message
                                  </Button>{" "}
                                  <Button
                                    variant={"primary"}
                                    onClick={() => {
                                      const next = new URLSearchParams(
                                        searchParams,
                                      );
                                      for (const [
                                        key,
                                        value,
                                      ] of leadEstimateParams(lead))
                                        next.set(key, value);
                                      next.set("tab", "new");
                                      navigate(`/admin/pipeline?${next}`);
                                    }}
                                  >
                                    Create Estimate
                                  </Button>{" "}
                                  {agentEstimateEnabled &&
                                    OPEN_FILTER_STATUSES.includes(
                                      lead.status,
                                    ) && (
                                      <Button
                                        variant={"primary"}
                                        onClick={() =>
                                          navigate(`/admin/agent-estimate?leadId=${encodeURIComponent(lead.id)}`)
                                        }
                                      >
                                        Agent Estimate
                                      </Button>
                                    )}{" "}
                                  <Button
                                    variant={"primary"}
                                    // Main's C.amber is #52525B (zinc-600) in
                                    // this file's local palette, not a real
                                    // amber — restored as the exact gray.
                                    className="!bg-zinc-600 !border-zinc-600 hover:!bg-zinc-700"
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
                                  </Button>{" "}
                                  <details>
                                    <summary className="cursor-pointer min-h-[44px] text-ui-body font-medium">
                                      More actions
                                    </summary>
                                    <div className="flex flex-wrap gap-[8px] pb-[8px]">
                                      <Button
                                        variant={"primary"}
                                        // Main's C.green is #3F3F46 (zinc-700) in this file's local
                                        // palette, not a real green — restored as the exact gray.
                                        className="!bg-zinc-700 !border-zinc-700 hover:!bg-zinc-800"
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
                                          const segs = (
                                            lead.service_interest || ""
                                          )
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
                                              [
                                                s.name,
                                                s.short_name,
                                                s.service_key,
                                              ]
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
                                      </Button>
                                      {lead.phone && (
                                        <Button
                                          variant={"primary"}
                                          // Main's C.green is #3F3F46 (zinc-700) in this file's local
                                          // palette, not a real green — restored as the exact gray.
                                          className="!bg-zinc-700 !border-zinc-700 hover:!bg-zinc-800"
                                          onClick={() =>
                                            callViaBridge(
                                              lead.phone,
                                              `${lead.first_name || ""} ${lead.last_name || ""}`.trim(),
                                            )
                                          }
                                        >
                                          Call Now
                                        </Button>
                                      )}
                                      <Button
                                        variant={"primary"}
                                        // Main's C.green is #3F3F46 (zinc-700) in this file's local
                                        // palette, not a real green — restored as the exact gray.
                                        className="!bg-zinc-700 !border-zinc-700 hover:!bg-zinc-800"
                                        onClick={() => {
                                          setFormData({
                                            leadId: lead.id,
                                          });
                                          setShowModal("convert");
                                        }}
                                      >
                                        Convert to Customer
                                      </Button>{" "}
                                      <Button
                                        variant={"danger"}
                                        onClick={() => {
                                          setFormData({
                                            leadId: lead.id,
                                          });
                                          setShowModal("lost");
                                        }}
                                      >
                                        Mark Lost
                                      </Button>{" "}
                                      <Button
                                        variant={"primary"}
                                        onClick={() => {
                                          setFormData({
                                            leadId: lead.id,
                                          });
                                          setShowModal("assign");
                                        }}
                                      >
                                        Assign
                                      </Button>{" "}
                                      <Button
                                        disabled={deletingLeadId === lead.id}
                                        onClick={() => deleteLead(lead)}
                                        variant="danger"
                                        className="inline-flex items-center gap-[6px]"
                                      >
                                        <Trash2 size={14} strokeWidth={1.8} />
                                        {deletingLeadId === lead.id
                                          ? "Deleting"
                                          : "Delete Lead"}
                                      </Button>{" "}
                                    </div>
                                  </details>
                                </div>
                                {/* Inline Schedule Callback */}
                                {callbackForm &&
                                  callbackForm.leadId === lead.id && (
                                    <div className="border-hairline border-zinc-200 rounded-md p-[14px] mb-[12px] bg-white">
                                      {" "}
                                      <div className="text-ui-body text-zinc-600 font-medium mb-[8px]">
                                        Schedule Callback
                                      </div>{" "}
                                      <div className="flex gap-[8px] mb-[8px]">
                                        {" "}
                                        <Input
                                          type="date"
                                          value={callbackForm.date}
                                          onChange={(e) =>
                                            setCallbackForm((prev) => ({
                                              ...prev,
                                              date: e.target.value,
                                            }))
                                          }
                                          className="flex-[1]"
                                        />{" "}
                                        <Input
                                          type="time"
                                          value={callbackForm.time}
                                          onChange={(e) =>
                                            setCallbackForm((prev) => ({
                                              ...prev,
                                              time: e.target.value,
                                            }))
                                          }
                                          className="flex-[1]"
                                        />{" "}
                                      </div>{" "}
                                      <Textarea
                                        value={callbackForm.notes || ""}
                                        onChange={(e) =>
                                          setCallbackForm((prev) => ({
                                            ...prev,
                                            notes: e.target.value,
                                          }))
                                        }
                                        placeholder="Notes..."
                                        className="w-full min-h-[40px] resize-y box-border mb-[8px]"
                                      />{" "}
                                      <div className="flex gap-[8px]">
                                        {" "}
                                        <Button
                                          variant={"primary"}
                                          // Main's C.amber is #52525B (zinc-600)
                                          // here, not a real amber.
                                          className="!bg-zinc-600 !border-zinc-600 hover:!bg-zinc-700"
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
                                        </Button>{" "}
                                        <Button
                                          variant={"secondary"}
                                          onClick={() => setCallbackForm(null)}
                                        >
                                          Cancel
                                        </Button>{" "}
                                      </div>{" "}
                                    </div>
                                  )}
                                {/* Inline Add Appointment */}
                                {apptForm && apptForm.leadId === lead.id && (
                                  <div className="border-hairline border-zinc-200 rounded-md p-[14px] mb-[12px] bg-white">
                                    <div className="text-ui-body text-zinc-700 font-medium mb-[8px]">
                                      Add Appointment
                                    </div>
                                    <div className="flex gap-[8px] mb-[8px]">
                                      <Input
                                        type="date"
                                        value={apptForm.date}
                                        onChange={(e) =>
                                          setApptForm((prev) => ({
                                            ...prev,
                                            date: e.target.value,
                                          }))
                                        }
                                        className="flex-[1]"
                                      />
                                      {/* Windows start on the hour (owner rule) — an
                                          hourly select, not a free time input; the
                                          server rejects non-HH:00 anyway. */}
                                      <Select
                                        value={apptForm.time}
                                        onChange={(e) =>
                                          setApptForm((prev) => ({
                                            ...prev,
                                            time: e.target.value,
                                          }))
                                        }
                                        className="flex-[1]"
                                      >
                                        <option value="">Time…</option>
                                        {/* All 24 hours, mirroring the shared
                                            CreateAppointmentModal's HOURLY_TIME_OPTIONS —
                                            the endpoint accepts any HH:00. */}
                                        {Array.from(
                                          {
                                            length: 24,
                                          },
                                          (_, h) => {
                                            const value = `${String(h).padStart(2, "0")}:00`;
                                            const hour12 = h % 12 || 12;
                                            const label = `${hour12}:00 ${h >= 12 ? "PM" : "AM"}`;
                                            return (
                                              <option key={value} value={value}>
                                                {label}
                                              </option>
                                            );
                                          },
                                        )}
                                      </Select>
                                    </div>
                                    <div className="flex gap-[8px] mb-[8px]">
                                      <Select
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
                                        className="flex-[2]"
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
                                      </Select>
                                      <Select
                                        value={apptForm.technicianId}
                                        onChange={(e) =>
                                          setApptForm((prev) => ({
                                            ...prev,
                                            technicianId: e.target.value,
                                          }))
                                        }
                                        className="flex-[1]"
                                      >
                                        <option value="">— Unassigned —</option>
                                        {techs.map((t) => (
                                          <option key={t.id} value={t.id}>
                                            {t.first_name} {t.last_name || ""}
                                          </option>
                                        ))}
                                      </Select>
                                    </div>
                                    <Textarea
                                      value={apptForm.notes || ""}
                                      onChange={(e) =>
                                        setApptForm((prev) => ({
                                          ...prev,
                                          notes: e.target.value,
                                        }))
                                      }
                                      placeholder="Notes for this appointment..."
                                      className="w-full min-h-[40px] resize-y box-border mb-[8px]"
                                    />
                                    <div className="text-ui-body text-ink-secondary mb-[8px]">
                                      Saving creates a customer from this lead
                                      (if not already linked) and marks the lead
                                      won.
                                    </div>
                                    <div className="flex gap-[8px]">
                                      <Button
                                        variant={"primary"}
                                        // Main's C.green is #3F3F46 (zinc-700), not a real green.
                                        className="!bg-zinc-700 !border-zinc-700 hover:!bg-zinc-800"
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
                                                e?.code !==
                                                  "EMAIL_MATCH_CONFIRM" &&
                                                e?.code !==
                                                  "EMAIL_MATCH_AMBIGUOUS"
                                              )
                                                throw e;
                                              const ambiguous =
                                                e.code ===
                                                "EMAIL_MATCH_AMBIGUOUS";
                                              if (ambiguous) {
                                                // Several accounts share this
                                                // email: list them; attaching
                                                // is done from the customer's
                                                // own record, not here.
                                                const list = (
                                                  e.candidates || []
                                                )
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
                                                  attachToAccountId:
                                                    m.accountId,
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
                                      </Button>
                                      <Button
                                        variant={"secondary"}
                                        onClick={() => setApptForm(null)}
                                      >
                                        Cancel
                                      </Button>
                                    </div>
                                  </div>
                                )}
                              </div>{" "}
                            </TD>
                          </TR>
                        )}
                      </React.Fragment>
                    );
                  })}
                  {leads.length === 0 && (
                    <TR>
                      <TD
                        colSpan={compactQueue ? 2 : 7}
                        className="p-[40px] text-center text-ink-secondary"
                      >
                        No leads found
                      </TD>
                    </TR>
                  )}
                </TBody>
              </Table>{" "}
            </Card>
          </>
        )}

        {pipelineView === "board" && (
          <div
            role="region"
            aria-label="Lead board"
            tabIndex={0}
            className="flex gap-[12px] overflow-x-auto pb-[8px]"
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
                  className={
                    isDropTarget
                      ? "flex-[0_0_260px] min-w-[240px] bg-zinc-50 border-hairline border-zinc-200 rounded-md p-[10px] ring-2 ring-zinc-900"
                      : "flex-[0_0_260px] min-w-[240px] bg-zinc-50 border-hairline border-zinc-200 rounded-md p-[10px]"
                  }
                >
                  {" "}
                  <div className="flex items-center gap-[8px] mb-[10px]">
                    {" "}
                    {/* lost/disqualified are a genuine alert (real red)
                        in main's STATUS_COLORS, not a zinc weight —
                        statusDotClass keeps that distinct from the other
                        stages' grayscale ladder. */}
                    <span
                      className={`w-2.5 h-2.5 rounded-full inline-block ${statusDotClass(stage)}`}
                    />{" "}
                    <span className="text-zinc-900 text-ui-body font-medium flex-[1]">
                      {stage.replace(/_/g, " ")}
                    </span>{" "}
                    <span className="text-ink-secondary text-ui-body">
                      {stageLeads.length}
                    </span>{" "}
                  </div>{" "}
                  <div className="max-h-[70vh] overflow-y-auto flex flex-col gap-[8px]">
                    {stageLeads.map((lead) => (
                      <div
                        key={lead.id}
                        draggable
                        role="button"
                        tabIndex={0}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setPipelineView("table");
                            expandLead(lead);
                          }
                        }}
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
                            setFilters((f) => ({
                              ...f,
                              status: "",
                              page: 1,
                            }));
                          }
                          expandLead(lead);
                        }}
                        className={`bg-white border-hairline border-zinc-200 rounded-md p-[10px] cursor-grab ${draggingLeadId === lead.id ? "opacity-40" : "opacity-100"}`}
                      >
                        {" "}
                        <div className="flex items-center gap-[8px] mb-[6px]">
                          {" "}
                          <div className="text-zinc-900 text-ui-body font-medium overflow-hidden whitespace-nowrap text-ellipsis flex-[1]">
                            {[lead.first_name, lead.last_name]
                              .filter(Boolean)
                              .join(" ") || "Unknown"}
                          </div>{" "}
                          <AgingBadge lead={lead} />{" "}
                        </div>{" "}
                        <div className="text-ink-secondary text-ui-body mb-[5px] overflow-hidden whitespace-nowrap text-ellipsis">
                          {lead.phone || lead.email || "--"}
                        </div>{" "}
                        <div className="text-zinc-900 text-ui-body mb-[8px] overflow-hidden whitespace-nowrap text-ellipsis">
                          {lead.service_interest || "--"}
                        </div>{" "}
                        <div className="flex items-center gap-[6px] flex-wrap">
                          {lead.source_name && (
                            <LeadBadge
                              label={
                                lead.source_name.length > 16
                                  ? lead.source_name.slice(0, 13) + "..."
                                  : lead.source_name
                              }
                              tone={"strong"}
                            />
                          )}
                          {lead.urgency && lead.urgency !== "normal" && (
                            <LeadBadge
                              label={lead.urgency}
                              tone={
                                lead.urgency === "urgent" ? "alert" : "neutral"
                              }
                              className={
                                lead.urgency === "urgent"
                                  ? undefined
                                  : "!bg-zinc-600/15 !text-zinc-600"
                              }
                            />
                          )}
                        </div>{" "}
                        <Button
                          type="button"
                          aria-label={`Delete lead for ${[lead.first_name, lead.last_name].filter(Boolean).join(" ") || "unknown"}`}
                          title="Delete lead"
                          disabled={deletingLeadId === lead.id}
                          onClick={(e) => {
                            e.stopPropagation();
                            deleteLead(lead);
                          }}
                          variant="danger"
                          className="inline-flex items-center gap-[5px] mt-[10px]"
                        >
                          <Trash2 size={13} strokeWidth={1.8} />
                          {deletingLeadId === lead.id ? "Deleting" : "Delete"}
                        </Button>
                      </div>
                    ))}
                    {stageLeads.length === 0 && (
                      <div className="text-ink-secondary text-ui-body text-center">
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
          <div className="flex justify-center gap-[8px] mt-[16px]">
            {" "}
            <Button
              variant="secondary"
              disabled={filters.page <= 1}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  page: f.page - 1,
                }))
              }
            >
              Prev
            </Button>{" "}
            <span className="text-ink-secondary text-ui-body self-center">
              Page {filters.page} of {Math.ceil(leadsTotal / 50)}
            </span>{" "}
            <Button
              variant="secondary"
              disabled={filters.page >= Math.ceil(leadsTotal / 50)}
              onClick={() =>
                setFilters((f) => ({
                  ...f,
                  page: f.page + 1,
                }))
              }
            >
              Next
            </Button>{" "}
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
        <div className="flex justify-between items-center mb-[16px]">
          {" "}
          <h2 className="m-0 text-zinc-900 text-ui-body font-medium">
            Lead Sources ({sources.length})
          </h2>{" "}
          <div className="flex gap-[8px]">
            {" "}
            <Button
              onClick={() => {
                setFormData({
                  source_type: "phone_tracking",
                  cost_type: "per_month",
                });
                setShowModal("newSource");
              }}
            >
              + Add Source
            </Button>{" "}
          </div>{" "}
        </div>{" "}
        <Card className="p-[0px] overflow-auto">
          {" "}
          <Table className="w-full min-w-[900px]">
            <THead>
              <TR>
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
                  <TH
                    key={h}
                    className="text-left text-ink-secondary whitespace-nowrap"
                  >
                    {h}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
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
                    <TR
                      onClick={() => expandSource(src)}
                      className={`cursor-pointer ${isExp ? "bg-zinc-50" : ""} ${src.is_active ? "" : "opacity-50"}`}
                    >
                      <TD>
                        {" "}
                        <div className="text-zinc-900 text-ui-body font-medium">
                          {src.name}
                        </div>
                        {src.domain && (
                          <div className="text-ink-secondary text-ui-body">
                            {src.domain}
                          </div>
                        )}
                      </TD>
                      <TD>
                        <LeadBadge
                          label={src.source_type?.replace(/_/g, " ")}
                          tone={"strong"}
                        />
                      </TD>
                      <TD className="text-zinc-900">{src.channel || "--"}</TD>
                      <TD className="text-zinc-900">{fmtMoney(mc)}</TD>
                      <TD className="text-zinc-900">{monthLeads}</TD>
                      <TD className="text-zinc-700">{monthConv}</TD>
                      <TD
                        className={
                          convRate > 20
                            ? "text-zinc-700"
                            : convRate > 10
                              ? "text-zinc-600"
                              : "text-ink-secondary"
                        }
                      >
                        {fmtPct(convRate)}
                      </TD>
                      <TD className="text-zinc-900">
                        {cpl > 0 ? fmtMoney(cpl) : "--"}
                      </TD>
                      <TD className="text-zinc-900">
                        {cpa > 0 ? fmtMoney(cpa) : "--"}
                      </TD>
                      <TD className={`font-medium ${hasRoiSignal ? roiColorClass(roi) : "text-ink-secondary"}`}>
                        {hasRoiSignal ? fmtPct(roi) : "--"}
                      </TD>
                    </TR>
                    {isExp && detail && (
                      <TR>
                        <TD colSpan={10} className="p-[0px]">
                          {" "}
                          <div className="border-b border-solid border-zinc-200 bg-zinc-50 px-6 py-4">
                            {" "}
                            <div className="flex gap-[24px] flex-wrap mb-[12px]">
                              {" "}
                              <div>
                                <span className="text-ink-secondary text-ui-body">
                                  Total Leads:{" "}
                                </span>
                                <span className="text-zinc-900">
                                  {detail.totalLeads}
                                </span>
                              </div>{" "}
                              <div>
                                <span className="text-ink-secondary text-ui-body">
                                  Conversions:{" "}
                                </span>
                                <span className="text-zinc-700">
                                  {detail.conversions}
                                </span>
                              </div>{" "}
                              <div>
                                <span className="text-ink-secondary text-ui-body">
                                  Total Cost:{" "}
                                </span>
                                <span className="text-zinc-900">
                                  {fmtMoney(detail.totalCost)}
                                </span>
                              </div>{" "}
                              <div>
                                <span className="text-ink-secondary text-ui-body">
                                  Total Revenue:{" "}
                                </span>
                                <span className="text-zinc-700">
                                  {fmtMoney(detail.totalRevenue)}
                                </span>
                              </div>{" "}
                              <div>
                                <span className="text-ink-secondary text-ui-body">
                                  ROI:{" "}
                                </span>
                                <span className={roiColorClass(detail.roi)}>
                                  {fmtPct(detail.roi)}
                                </span>
                              </div>{" "}
                              <div>
                                <span className="text-ink-secondary text-ui-body">
                                  Avg Response:{" "}
                                </span>
                                <span className="text-zinc-900">
                                  {fmtTime(detail.avgResponseTime)}
                                </span>
                              </div>{" "}
                            </div>{" "}
                            <Button
                              variant={"primary"}
                              // Main's C.amber is #52525B (zinc-600), not a
                              // real amber.
                              className="!bg-zinc-600 !border-zinc-600 hover:!bg-zinc-700"
                              onClick={() => {
                                setFormData({
                                  sourceId: src.id,
                                  cost_category: "monthly_fee",
                                });
                                setShowModal("logCost");
                              }}
                            >
                              Log Cost
                            </Button>{" "}
                          </div>{" "}
                        </TD>
                      </TR>
                    )}
                  </React.Fragment>
                );
              })}
            </TBody>
          </Table>{" "}
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
      {
        stage: "new",
        label: "New Leads",
        count: countStages(["new"]),
      },
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
      {
        stage: "won",
        label: "Won",
        count: countStages(["won"]),
      },
      {
        stage: "lost",
        label: "Lost",
        count: countStages([
          "lost",
          "unresponsive",
          "disqualified",
          "duplicate",
        ]),
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
    // Main's C.red/C.heading/C.text/C.green/C.amber/C.muted are (in this
    // file's local palette) #991B1B (real red) / #09090B / #27272A / #3F3F46
    // / #52525B / #71717A — i.e. zinc-950/800/700/600/500 for all but the
    // first slot. Main gave the first (most common) lost-reason slice the
    // real red, but that's whichever reason happens to sort first — neutral
    // categorical/frequency data, not a genuinely negative condition — so
    // alert red is NOT reused here; this is a pure zinc gradient instead.
    const pieClasses = [
      "text-zinc-900",
      "text-zinc-800",
      "text-zinc-700",
      "text-zinc-600",
      "text-zinc-500",
      "text-zinc-400",
      "text-zinc-300",
    ];

    // Phone number ROI
    const phoneROI = bySource.filter((s) => s.source?.twilio_phone_number);
    return (
      <>
        {/* Metric Cards */}
        <div className="flex gap-[16px] flex-wrap mb-[24px]">
          {" "}
          <MetricCard label="New Leads (Month)" value={ov.total || 0} />{" "}
          <MetricCard
            label="Conversion Rate"
            value={fmtPct(ov.conversionRate)}
          />{" "}
          <MetricCard
            label="Median Response Time"
            value={fmtTime(ov.medianResponseTime)}
            sub={
              ov.recentMedianResponseTime != null
                ? `7-day: ${fmtTime(ov.recentMedianResponseTime)}`
                : undefined
            }
          />{" "}
          <MetricCard label="Cost per Acquisition" value={fmtMoney(ov.cpa)} />{" "}
          <MetricCard
            label="Avg Speed to Lead"
            value={
              ov.avgSpeedToLead != null ? fmtTime(ov.avgSpeedToLead) : "--"
            }
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
            alert={ov.avgSpeedToLead >= 15}
            valueClassName={
              ov.avgSpeedToLead != null && ov.avgSpeedToLead >= 5
                ? "text-zinc-600"
                : "text-zinc-700"
            }
          />{" "}
          <MetricCard
            label="Monthly ROI"
            value={ov.roi != null ? fmtPct(ov.roi) : "--"}
            alert={ov.roi < 0}
          />{" "}
        </div>
        {/* Pipeline status */}
        <div className="mb-[10px]">
          <h2 className="m-0 mb-[6px] text-zinc-900 text-ui-body font-medium">
            Pipeline status
          </h2>
          <div className="m-0 text-ink-secondary text-ui-body">
            Current lead counts by status for the selected month.
          </div>
        </div>
        <div className="flex items-center gap-[8px] mb-[16px] flex-wrap">
          {funnelData.map((f) => (
            <PipelineStatusCard
              key={f.stage}
              label={f.label || f.stage.replace(/_/g, " ")}
              value={f.count}
            />
          ))}
        </div>
        {/* Channel Comparison */}
        <Card className="mb-[24px] p-5">
          {" "}
          <h2 className="m-0 mb-[16px] text-zinc-900 text-ui-body font-medium">
            Channel comparison
          </h2>
          {byChannel.length === 0 && (
            <div className="text-ink-secondary text-ui-body">
              No channel data available yet
            </div>
          )}
          {byChannel.map((ch) => (
            <div key={ch.channel} className="mb-[12px]">
              {" "}
              <div className="flex justify-between text-ui-body mb-[4px]">
                {" "}
                <span className="text-zinc-900 font-medium">
                  {ch.channel}
                </span>{" "}
                <span className="text-ink-secondary">
                  Leads: {ch.totalLeads} | Conv: {ch.conversions} | ROI:{" "}
                  {fmtPct(ch.roi)}
                </span>{" "}
              </div>{" "}
              <div className="grid grid-cols-2 gap-2">
                <progress
                  aria-label={`${ch.channel} cost`}
                  value={ch.totalCost}
                  max={maxChannelVal}
                  // Main painted this C.red, but alert-fg is reserved for
                  // genuinely negative conditions (e.g. negative ROI) — cost
                  // here is routine comparison data, not an alert. Restored
                  // as a lighter zinc weight, distinct from revenue's zinc-700.
                  className="h-3 w-full accent-zinc-400"
                />
                <progress
                  aria-label={`${ch.channel} revenue`}
                  value={ch.totalRevenue}
                  max={maxChannelVal}
                  className="h-3 w-full accent-zinc-700"
                />
              </div>{" "}
              <div className="flex gap-[16px] text-ui-body text-ink-secondary mt-[2px]">
                {" "}
                <span>Cost: {fmtMoney(ch.totalCost)}</span>{" "}
                <span>Revenue: {fmtMoney(ch.totalRevenue)}</span>{" "}
              </div>{" "}
            </div>
          ))}
          <div className="flex gap-[16px] text-ui-body text-ink-secondary mt-[8px]">
            {" "}
            <span>
              <span className="inline-block w-3 h-3 rounded-sm mr-1 bg-zinc-400" />
              Cost
            </span>{" "}
            <span>
              <span className="inline-block w-3 h-3 rounded-sm mr-1 bg-zinc-700" />
              Revenue
            </span>{" "}
          </div>{" "}
        </Card>
        {/* Source ROI Matrix */}
        <Card className="mb-[24px] p-5">
          {" "}
          <h2 className="m-0 mb-[16px] text-zinc-900 text-ui-body font-medium">
            Source ROI matrix
          </h2>
          {scatterSources.length === 0 ? (
            <div className="text-ink-secondary text-ui-body">
              No source data with leads yet
            </div>
          ) : (
            <svg viewBox="0 0 400 300" className="w-full max-w-[600px]">
              {/* Quadrant lines */}
              <line
                x1="200"
                y1="10"
                x2="200"
                y2="280"
                stroke="currentColor"
                className="text-zinc-200"
                strokeDasharray="4"
              />{" "}
              <line
                x1="20"
                y1="145"
                x2="380"
                y2="145"
                stroke="currentColor"
                className="text-zinc-200"
                strokeDasharray="4"
              />
              {/* Quadrant labels */}
              <text
                x="110"
                y="80"
                fill="currentColor"
                className="text-ink-secondary text-[14px]"
                fontSize="14"
                textAnchor="middle"
              >
                Question Marks
              </text>{" "}
              <text
                x="300"
                y="80"
                fill="currentColor"
                className="text-zinc-900 text-[14px]"
                fontSize="14"
                textAnchor="middle"
              >
                Stars
              </text>{" "}
              <text
                x="110"
                y="230"
                fill="currentColor"
                className="text-ink-secondary text-[14px]"
                fontSize="14"
                textAnchor="middle"
              >
                Dogs
              </text>{" "}
              <text
                x="300"
                y="230"
                fill="currentColor"
                className="text-zinc-700 text-[14px]"
                fontSize="14"
                textAnchor="middle"
              >
                Cash Cows
              </text>
              {/* Axes */}
              <text
                x="200"
                y="296"
                fill="currentColor"
                className="text-ink-secondary text-[14px]"
                fontSize="14"
                textAnchor="middle"
              >
                Revenue --&gt;
              </text>{" "}
              <text
                x="12"
                y="145"
                fill="currentColor"
                className="text-ink-secondary text-[14px]"
                fontSize="14"
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
                // Main's C.heading/C.green/C.amber are zinc-950/zinc-700/
                // zinc-600 in this file's local palette, NOT real hues —
                // only C.red is a genuine color (the <=0% tier, a real
                // alert). Restored as the matching zinc shades.
                const toneClass =
                  s.roi > 200
                    ? "text-zinc-900"
                    : s.roi > 50
                      ? "text-zinc-700"
                      : s.roi > 0
                        ? "text-zinc-600"
                        : "text-alert-fg";
                return (
                  <g key={i}>
                    {" "}
                    <circle
                      cx={x}
                      cy={y}
                      r={r}
                      fill="currentColor"
                      className={toneClass}
                      opacity={0.7}
                    />{" "}
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
        <div className="flex gap-[16px] flex-wrap mb-[24px]">
          {/* Response Time vs Conversion */}
          <Card className="flex-[1_1_400px] p-5">
            {" "}
            <h2 className="m-0 mb-[16px] text-zinc-900 text-ui-body font-medium">
              Response time vs conversion
            </h2>
            <div className="text-ink-secondary text-ui-body">Year to date</div>
            {responseBuckets.length === 0 ? (
              <div className="text-ink-secondary text-ui-body">
                No response data yet
              </div>
            ) : (
              <div className="grid gap-3 mt-3">
                {responseBuckets.map((b, i) => {
                  return (
                    <div
                      key={i}
                      className="grid grid-cols-[minmax(90px,1fr)_2fr_auto] items-center gap-3"
                    >
                      <span className="text-ui-body text-ink-secondary">
                        {b.label}
                      </span>
                      <div className="grid gap-1">
                        <progress
                          aria-label={`${b.label} total leads`}
                          value={b.total}
                          max={maxResp}
                          className="h-1.5 w-full accent-zinc-400"
                        />
                        <progress
                          aria-label={`${b.label} won leads`}
                          value={b.won || 0}
                          max={maxResp}
                          className="h-1.5 w-full accent-zinc-700"
                        />
                      </div>
                      <span className="text-ui-body text-ink-secondary">
                        {b.total} · {b.conversionRate}%
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
            <div className="flex gap-[12px] text-ui-body text-ink-secondary mt-[12px]">
              {" "}
              <span>
                <span className="inline-block w-[10px] h-[10px] bg-zinc-400 rounded-sm mr-[4px]" />
                Total
              </span>{" "}
              <span>
                <span className="inline-block w-[10px] h-[10px] bg-zinc-700 rounded-sm mr-[4px]" />
                Won
              </span>{" "}
            </div>{" "}
          </Card>
          {/* Lost Lead Analysis */}
          <Card className="flex-[1_1_300px] p-5">
            {" "}
            <h2 className="m-0 mb-[16px] text-zinc-900 text-ui-body font-medium">
              Lost lead reasons
            </h2>
            <div className="text-ink-secondary text-ui-body">Year to date</div>
            {totalLost === 0 ? (
              <div className="text-ink-secondary text-ui-body">
                No lost leads yet
              </div>
            ) : (
              <div className="flex gap-[24px] items-center">
                {" "}
                <svg viewBox="0 0 100 100" className="w-[120px] h-[120px]">
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
                            fill="currentColor"
                            className={pieClasses[i % pieClasses.length]}
                          />
                        );
                      }
                      return (
                        <path
                          key={i}
                          d={`M50,50 L${x1},${y1} A45,45 0 ${largeArc},1 ${x2},${y2} Z`}
                          fill="currentColor"
                          className={pieClasses[i % pieClasses.length]}
                        />
                      );
                    });
                  })()}
                </svg>{" "}
                <div>
                  {lostReasons.slice(0, 7).map((r, i) => (
                    <div
                      key={i}
                      className="text-ui-body mb-[4px] flex items-center gap-[6px]"
                    >
                      {" "}
                      <span
                        className={`inline-block w-2.5 h-2.5 rounded-sm bg-current ${pieClasses[i % pieClasses.length]}`}
                      />{" "}
                      <span className="text-zinc-900">{r.reason}</span>{" "}
                      <span className="text-ink-secondary">{r.count}</span>{" "}
                    </div>
                  ))}
                </div>{" "}
              </div>
            )}
          </Card>{" "}
        </div>
        {/* Phone Number ROI Table */}
        <Card className="p-[0px] overflow-auto">
          {" "}
          <div className="border-b border-solid border-zinc-200 px-5 py-4">
            {" "}
            <h2 className="m-0 text-zinc-900 text-ui-body font-medium">
              Phone number ROI
            </h2>{" "}
          </div>{" "}
          <Table className="w-full min-w-[700px]">
            <THead>
              <TR>
                {[
                  "Number",
                  "Source",
                  "Cost",
                  "Leads",
                  "Conversions",
                  "Revenue",
                  "ROI %",
                ].map((h) => (
                  <TH key={h} className="text-left text-ink-secondary">
                    {h}
                  </TH>
                ))}
              </TR>
            </THead>
            <TBody>
              {phoneROI.map((s, i) => (
                <TR key={i}>
                  <TD className="text-zinc-900">
                    {s.source?.twilio_phone_number}
                  </TD>
                  <TD className="text-zinc-900">
                    {s.source?.name?.slice(0, 30)}
                  </TD>
                  <TD className="text-zinc-900">{fmtMoney(s.totalCost)}</TD>
                  <TD className="text-zinc-900">{s.totalLeads}</TD>
                  <TD className="text-zinc-700">{s.conversions}</TD>
                  <TD className="text-zinc-700">{fmtMoney(s.totalRevenue)}</TD>
                  {/* Main applied roiColor(s.roi) unconditionally (so a
                      negative ROI showed red) but only displayed the
                      percentage text when roi > 0 (otherwise "--") — the
                      color and the value-guard are independent, not gated
                      on the same condition. */}
                  <TD className={`font-medium ${roiColorClass(s.roi)}`}>
                    {s.roi > 0 ? fmtPct(s.roi) : "--"}
                  </TD>
                </TR>
              ))}
              {phoneROI.length === 0 && (
                <TR>
                  <TD
                    colSpan={7}
                    className="p-[30px] text-center text-ink-secondary"
                  >
                    No phone source data yet
                  </TD>
                </TR>
              )}
            </TBody>
          </Table>{" "}
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
        <LeadDialog title="New lead" onClose={() => setShowModal(null)}>
          {" "}
          <div className="flex gap-[12px] flex-wrap">
            {" "}
            <div className="flex-[1_1_45%]">
              <LeadField
                label="First Name"
                value={formData.first_name}
                onChange={(v) =>
                  setFormData((f) => ({
                    ...f,
                    first_name: v,
                  }))
                }
              />
            </div>{" "}
            <div className="flex-[1_1_45%]">
              <LeadField
                label="Last Name"
                value={formData.last_name}
                onChange={(v) =>
                  setFormData((f) => ({
                    ...f,
                    last_name: v,
                  }))
                }
              />
            </div>{" "}
          </div>{" "}
          <LeadField
            label="Phone"
            value={formData.phone}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                phone: v,
              }))
            }
          />{" "}
          <LeadField
            label="Email"
            value={formData.email}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                email: v,
              }))
            }
          />{" "}
          {contactMatches?.total > 0 && (
            <Card className="mb-[12px] p-[12px]">
              <p className="m-0 mb-[8px] text-ui-body">
                Possible existing leads with this contact (
                {contactMatches.total}). Review before creating another record.
              </p>
              {contactMatches.matches.map((match) => (
                <Button
                  key={match.id}
                  onClick={() => {
                    setShowModal(null);
                    navigate(`/admin/pipeline?lead=${match.id}`);
                  }}
                >
                  {[match.first_name, match.last_name]
                    .filter(Boolean)
                    .join(" ") || "Open lead"}{" "}
                  · {match.status}
                </Button>
              ))}
            </Card>
          )}
          {contactMatches?.error && (
            <p role="status" className="text-ui-body">
              Existing-contact check unavailable. Search the queue before
              creating another record.
            </p>
          )}
          <LeadField
            label="Service Interest"
            value={formData.service_interest}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                service_interest: v,
              }))
            }
            placeholder="e.g. General Pest, Lawn Care, Termite"
          />{" "}
          <LeadField
            label="Lead Source"
            value={formData.lead_source_id}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                lead_source_id: v,
              }))
            }
            options={sources.map((s) => ({
              value: s.id,
              label: s.name,
            }))}
          />{" "}
          <LeadField
            label="Notes"
            value={formData.notes}
            onChange={(notes) =>
              setFormData((f) => ({
                ...f,
                notes,
              }))
            }
          />
          <details className="mb-[16px]">
            <summary className="min-h-[44px] cursor-pointer text-ui-body">
              Property and intake details (optional)
            </summary>
            <LeadField
              label="Address"
              value={formData.address}
              onChange={(v) =>
                setFormData((f) => ({
                  ...f,
                  address: v,
                }))
              }
            />{" "}
            <div className="flex gap-[12px] flex-wrap">
              {" "}
              <div className="flex-[1_1_60%]">
                <LeadField
                  label="City"
                  value={formData.city}
                  onChange={(v) =>
                    setFormData((f) => ({
                      ...f,
                      city: v,
                    }))
                  }
                />
              </div>{" "}
              <div className="flex-[1_1_30%]">
                <LeadField
                  label="ZIP"
                  value={formData.zip}
                  onChange={(v) =>
                    setFormData((f) => ({
                      ...f,
                      zip: v,
                    }))
                  }
                />
              </div>{" "}
            </div>{" "}
            <LeadField
              label="Lead Type"
              value={formData.lead_type}
              onChange={(v) =>
                setFormData((f) => ({
                  ...f,
                  lead_type: v,
                }))
              }
              options={LEAD_TYPES.map((t) => ({
                value: t,
                label: t.replace(/_/g, " "),
              }))}
            />{" "}
            <div className="flex gap-[12px] flex-wrap">
              {" "}
              <div className="flex-[1_1_55%]">
                <LeadField
                  label="Builder Termite Warranty (provider)"
                  value={formData.builder_warranty_provider}
                  onChange={(v) =>
                    setFormData((f) => ({
                      ...f,
                      builder_warranty_provider: v,
                    }))
                  }
                  placeholder="who covers the home today"
                />
              </div>{" "}
              <div className="flex-[1_1_35%]">
                <LeadField
                  label="Warranty Expires"
                  type="date"
                  value={formData.builder_warranty_expires_on}
                  onChange={(v) =>
                    setFormData((f) => ({
                      ...f,
                      builder_warranty_expires_on: v,
                    }))
                  }
                />
              </div>{" "}
            </div>{" "}
          </details>
          <Button onClick={submitForm} disabled={loading}>
            {loading ? "Saving..." : "Create Lead"}
          </Button>{" "}
        </LeadDialog>
      );
    if (showModal === "builderWarranty")
      return (
        <LeadDialog
          title="Builder termite warranty"
          onClose={() => setShowModal(null)}
        >
          {" "}
          <LeadField
            label="Provider"
            value={formData.builder_warranty_provider}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                builder_warranty_provider: v,
              }))
            }
            placeholder="who covers the home today"
          />{" "}
          <LeadField
            label="Expires"
            type="date"
            value={formData.builder_warranty_expires_on}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                builder_warranty_expires_on: v,
              }))
            }
          />{" "}
          <div className="text-ui-body text-ink-secondary mb-[12px]">
            Clearing both fields removes the warranty from this lead.
          </div>{" "}
          <Button onClick={submitForm} disabled={loading}>
            {loading ? "Saving..." : "Save"}
          </Button>{" "}
        </LeadDialog>
      );
    if (showModal === "convert")
      return (
        <LeadDialog
          title="Convert to customer"
          onClose={() => setShowModal(null)}
        >
          {" "}
          <LeadField
            label="Customer ID (required)"
            value={formData.customer_id}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                customer_id: v,
              }))
            }
            placeholder="Existing customer UUID"
          />{" "}
          <LeadField
            label="Monthly Value ($)"
            value={formData.monthly_value}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                monthly_value: v,
              }))
            }
            type="number"
          />{" "}
          <LeadField
            label="Initial Service Value ($)"
            value={formData.initial_service_value}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                initial_service_value: v,
              }))
            }
            type="number"
          />{" "}
          <LeadField
            label="WaveGuard Tier"
            value={formData.waveguard_tier}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                waveguard_tier: v,
              }))
            }
            options={["Platinum", "Gold", "Silver", "Bronze", "One-Time"]}
          />{" "}
          <Button
            onClick={submitForm}
            disabled={loading}
            variant={"primary"}
            // Main's C.green is #3F3F46 (zinc-700), not a real green.
            className="!bg-zinc-700 !border-zinc-700 hover:!bg-zinc-800"
          >
            {loading ? "Converting..." : "Convert"}
          </Button>{" "}
        </LeadDialog>
      );
    if (showModal === "lost")
      return (
        <LeadDialog title="Mark lead lost" onClose={() => setShowModal(null)}>
          {" "}
          <LeadField
            label="Reason"
            value={formData.reason}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                reason: v,
              }))
            }
            options={LOST_REASONS}
          />
          {formData.reason === "competitor" && (
            <LeadField
              label="Competitor Name"
              value={formData.competitor}
              onChange={(v) =>
                setFormData((f) => ({
                  ...f,
                  competitor: v,
                }))
              }
              placeholder="e.g. Terminix, Orkin, HomeTeam"
            />
          )}
          <Field label="Notes" className="mb-[12px]">
            <Textarea
              value={formData.notes || ""}
              onChange={(e) =>
                setFormData((f) => ({
                  ...f,
                  notes: e.target.value,
                }))
              }
              placeholder="Additional context about why this lead was lost..."
              className="w-full min-h-[80px] resize-y box-border"
            />
          </Field>{" "}
          <Button onClick={submitForm} disabled={loading} variant={"danger"}>
            {loading ? "Saving..." : "Mark Lost"}
          </Button>{" "}
        </LeadDialog>
      );
    if (showModal === "assign")
      return (
        <LeadDialog title="Assign lead" onClose={() => setShowModal(null)}>
          {" "}
          <LeadField
            label="Technician"
            value={formData.technician_id}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                technician_id: v,
              }))
            }
            options={techs.map((t) => ({
              value: t.id,
              label: `${t.first_name} ${t.last_name || ""}`,
            }))}
          />{" "}
          <Button onClick={submitForm} disabled={loading} variant={"primary"}>
            {loading ? "Assigning..." : "Assign"}
          </Button>{" "}
        </LeadDialog>
      );
    if (showModal === "newSource")
      return (
        <LeadDialog title="Add lead source" onClose={() => setShowModal(null)}>
          {" "}
          <LeadField
            label="Name"
            value={formData.name}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                name: v,
              }))
            }
          />{" "}
          <LeadField
            label="Source Type"
            value={formData.source_type}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                source_type: v,
              }))
            }
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
            ].map((t) => ({
              value: t,
              label: t.replace(/_/g, " "),
            }))}
          />{" "}
          <LeadField
            label="Channel"
            value={formData.channel}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                channel: v,
              }))
            }
            placeholder="e.g. google, facebook, referral"
          />{" "}
          <LeadField
            label="Twilio Phone Number"
            value={formData.twilio_phone_number}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                twilio_phone_number: v,
              }))
            }
            placeholder="+1XXXXXXXXXX"
          />{" "}
          <LeadField
            label="Domain"
            value={formData.domain}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                domain: v,
              }))
            }
            placeholder="example.com"
          />{" "}
          <LeadField
            label="Cost Type"
            value={formData.cost_type}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                cost_type: v,
              }))
            }
            options={["free", "fixed", "per_lead", "per_month", "one_time"]}
          />{" "}
          <LeadField
            label="Monthly Cost ($)"
            value={formData.monthly_cost}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                monthly_cost: v,
              }))
            }
            type="number"
          />{" "}
          <Button onClick={submitForm} disabled={loading}>
            {loading ? "Creating..." : "Create Source"}
          </Button>{" "}
        </LeadDialog>
      );
    if (showModal === "logCost")
      return (
        <LeadDialog title="Log source cost" onClose={() => setShowModal(null)}>
          {" "}
          <LeadField
            label="Month"
            value={formData.month}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                month: v,
              }))
            }
            type="date"
          />{" "}
          <LeadField
            label="Cost Amount ($)"
            value={formData.cost_amount}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                cost_amount: v,
              }))
            }
            type="number"
          />{" "}
          <LeadField
            label="Category"
            value={formData.cost_category}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                cost_category: v,
              }))
            }
            options={[
              "monthly_fee",
              "domain_renewal",
              "ad_spend",
              "setup",
              "content",
              "other",
            ]}
          />{" "}
          <LeadField
            label="Notes"
            value={formData.notes}
            onChange={(v) =>
              setFormData((f) => ({
                ...f,
                notes: v,
              }))
            }
          />{" "}
          <Button
            onClick={submitForm}
            disabled={loading}
            variant={"primary"}
            // Main's C.amber is #52525B (zinc-600), not a real amber.
            className="!bg-zinc-600 !border-zinc-600 hover:!bg-zinc-700"
          >
            {loading ? "Logging..." : "Log Cost"}
          </Button>{" "}
        </LeadDialog>
      );
    return null;
  };

  // ═════════════════════════════════════════════════════════════════════════
  // MAIN RENDER
  // ═════════════════════════════════════════════════════════════════════════
  return (
    <UiSurface className="min-w-0 max-w-[1400px] mx-auto text-zinc-900">
      <style>{`
        .lead-queue-table td { overflow-wrap: anywhere; }
        .lead-queue-table :is(td, th) { padding-inline: 8px !important; }
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
        <ActionFeedback error className="mb-4">
          Pipeline data failed to load: {loadError.message || String(loadError)}
          <Button
            type="button"
            onClick={retryCurrentTab}
            variant="secondary"
            className="ml-2"
          >
            Retry
          </Button>{" "}
        </ActionFeedback>
      )}
      {tab === "pipeline" && renderPipeline()}
      {tab === "sources" && renderSources()}
      {tab === "analytics" && renderAnalytics()}
      {renderModal()}
    </UiSurface>
  );
}
