import {
  CustomerSmsProvider,
  useCustomerSms,
  openEstimateMessages,
} from "../../components/admin/customer360/CustomerSmsPanel";
// client/src/pages/admin/EstimatesPageV2.jsx
// Monochrome V2 of EstimatePage. Strict 1:1 on data, endpoints, behavior:
//   - GET   /admin/estimates
//   - PATCH /admin/estimates/:id            (isPriority, status, declineReason)
//   - POST  /admin/estimates/:id/send
//   - POST  /admin/estimates/:id/follow-up
//   - POST  /admin/estimates/:id/mark-accepted
// Scope (post PR #5c):
//   PR #5a → tab chrome + Pipeline tab (stats bar + filter pills + list rows)
//   PR #5b → Create Estimate tab now renders EstimateToolViewV2 (monochrome
//            estimator — same endpoints/state/pricing as V1)
//   PR #5c → FollowUpModalV2 + DeclineModalV2 replace V1 modals (Dialog
//            primitive, danger variant on Mark-as-Lost)
// Leads / Pricing Logic tabs still render V1 panels.
import React, {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import useRenderedTabBeacon from "../../hooks/useRenderedTabBeacon";
import { useIntelligenceBarActions } from "../../hooks/useIntelligenceBarPageData";
import {
  STATUS_CONFIG,
  PIPELINE_FILTERS,
  canSendEstimate,
  classifyEstimateForPipeline,
  getUrgencyIndicator,
  detectCompetitor,
} from "./EstimatePage";
import { LeadsSection } from "./LeadsTabs";
import AdminCommandHeader from "../../components/admin/AdminCommandHeader";
import PricingLogicPanel from "../../components/admin/PricingLogicPanel";
import { MarginCalculator } from "./PricingLogicPage";
import EstimateToolViewV2 from "./EstimateToolViewV2";
import {
  EstimateSendProvider,
  useEstimateSend,
} from "../../components/admin/EstimateSendDialog";
import CustomerEstimatesPanel from "./CustomerEstimatesPanel";
import ServiceOutlineComposerModal from "../../components/admin/ServiceOutlineComposerModal";
import WinLossSlicesCard from "./WinLossSlicesCard";
import SourcePerformanceCard from "./SourcePerformanceCard";
import PipelineAnalytics, {
  isCallTodayEstimate,
  isFollowUpOverdueEstimate,
  isGoingColdEstimate,
  isPickReasonEstimate,
  lastEngagementMs,
} from "./PipelineAnalytics";
import {
  FollowUpModalV2,
  DeclineModalV2,
  ExtendEstimateModalV2,
} from "../../components/admin/EstimateModalsV2";
import useIsMobile from "../../hooks/useIsMobile";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";
import {
  Badge,
  Button,
  Card,
  CardBody,
  Dialog,
  DialogBody,
  DialogHeader,
  DialogTitle,
  Field,
  Input,
  Select,
  TablePagination,
  TableToolbar,
  UiSurface,
  cn,
} from "../../components/ui";
import {
  Flag,
  Globe,
  Users,
  Bot,
  Phone,
  MessageSquare,
  Send,
  FilePlus2,
  SlidersHorizontal,
  Check,
  X,
  ArrowLeft,
  Plus,
  Trash2,
  CalendarCheck,
  ExternalLink,
  ClipboardList,
  FileText,
  MoreHorizontal,
  Archive,
  Link as LinkIcon,
  RotateCw,
  CalendarPlus,
  DollarSign,
  Pencil,
} from "lucide-react";
import CreateAppointmentModal from "../../components/schedule/CreateAppointmentModal";
import EstimateSoldByRow from "../../components/admin/EstimateSoldByRow";
const API_BASE = import.meta.env.VITE_API_URL || "/api";
function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      let serverMsg = "";
      try {
        const body = await r.clone().json();
        serverMsg = body?.error || "";
      } catch {
        try {
          serverMsg = await r.text();
        } catch {
          /* ignore */
        }
      }
      throw new Error(serverMsg || `HTTP ${r.status}`);
    }
    return r.json();
  });
}
function mergeEstimateRows(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const estimate of list || []) {
      if (estimate?.id && !byId.has(estimate.id))
        byId.set(estimate.id, estimate);
    }
  }
  return Array.from(byId.values());
}
function estimatePipelineFetchPaths(filter) {
  // limit=all → server-side ESTIMATE_LIST_LIMIT cap. PipelineAnalytics
  // computes all-time KPIs from this list, so a numeric page-size here would
  // silently truncate the funnel once the table outgrows it.
  const base = `limit=all&pricingRisk=1`;
  if (filter === "archived") {
    return [`/admin/estimates?archived=only&${base}`];
  }
  return [
    `/admin/estimates?sentOnly=1&${base}`,
    `/admin/estimates?status=draft&${base}`,
  ];
}
async function fetchEstimatePipelineRows(filter) {
  const responses = await Promise.all(
    estimatePipelineFetchPaths(filter).map((path) => adminFetch(path)),
  );
  return {
    rows: mergeEstimateRows(...responses.map((d) => d.estimates || [])),
    // Any capped page means the pipeline list (and its KPIs) is incomplete.
    truncated: responses.some((d) => d?.truncated),
  };
}

// Status badge. V2 collapses to neutral; alert tone only for declined/expired.
function StatusBadgeV2({ status }) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.draft;
  const isAlert = status === "declined" || status === "expired";
  const isStrong = status === "accepted";
  return (
    <Badge tone={isAlert ? "alert" : isStrong ? "strong" : "neutral"}>
      {cfg.label}
    </Badge>
  );
}

// Estimates v2 status pills (spec §6). Monochrome-professional; red is
// reserved strictly for `expired` so Virginia can scan "what needs attention
// today" in under 5 seconds. Gated by the `estimates_v2_status_pills` flag.
function StatusPillV3({ status }) {
  const label = (STATUS_CONFIG[status] || STATUS_CONFIG.draft).label;
  const tone =
    status === "expired"
      ? "alert"
      : status === "accepted"
        ? "strong"
        : "neutral";
  return (
    <Badge tone={tone}>
      {status === "viewed" && (
        <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-current" />
      )}
      {status === "accepted" && (
        <Check size={14} strokeWidth={2.5} aria-hidden />
      )}
      {status === "scheduled" && (
        <CalendarCheck size={14} strokeWidth={2.5} aria-hidden />
      )}
      {label}
    </Badge>
  );
}

// Estimates v2 status-rank sort. Available as an explicit mobile sort option,
// but the Estimates tab defaults to chronological createdAt order.
const V3_STATUS_RANK = {
  expired: 0,
  viewed: 1,
  scheduled: 2,
  sent: 2,
  accepted: 3,
  declined: 3,
  draft: 4,
};
function v3SortFn(a, b) {
  const ra = V3_STATUS_RANK[a.status] ?? 5;
  const rb = V3_STATUS_RANK[b.status] ?? 5;
  if (ra !== rb) return ra - rb;
  const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
  const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
  return tb - ta;
}

// Estimates v2 filter chips (spec §7). Action Required = expired plus viewed
// sitting idle (viewed >48h). Open = sent+viewed. Closed = accepted+declined.
const V3_CHIPS = [
  {
    key: "all",
    label: "All",
  },
  {
    key: "action",
    label: "Action Required",
  },
  {
    key: "pricing_risk",
    label: "Pricing Risk",
  },
  {
    key: "missing_cogs",
    label: "Missing COGS",
  },
  {
    key: "low_margin",
    label: "Low Margin",
  },
  {
    key: "risk_type_review",
    label: "Risk Type",
  },
  {
    key: "open",
    label: "Open",
  },
  {
    key: "closed",
    label: "Closed",
  },
  {
    key: "drafts",
    label: "Drafts",
  },
  {
    key: "archived",
    label: "Archived",
  },
];
// GATE_ESTIMATE_CALL_LIST: the two extra filters, added to whichever chip set is showing (V3_CHIPS
// when estimates_v2_status_pills is on, PIPELINE_AND_RISK_FILTERS otherwise) only while the gate is on.
const CALL_LIST_CHIPS = [
  { key: "call_today", label: "Call today" },
  { key: "pick_reason", label: "Pick reason" },
];
const CALL_LIST_MATCHERS = {
  call_today: (e) => isCallTodayEstimate(e),
  pick_reason: (e) => isPickReasonEstimate(e),
};
function withCallListChips(chips, afterKey, callListOn) {
  if (!callListOn) return chips;
  const at = chips.findIndex((c) => c.key === afterKey);
  if (at < 0) return [...chips, ...CALL_LIST_CHIPS];
  return [...chips.slice(0, at + 1), ...CALL_LIST_CHIPS, ...chips.slice(at + 1)];
}
function v3Chips(callListOn) {
  return withCallListChips(V3_CHIPS, "action", callListOn);
}
function pipelineChips(callListOn) {
  return withCallListChips(PIPELINE_AND_RISK_FILTERS, "follow_up", callListOn);
}
// Call today list order: the offer opened longest ago comes first.
function sortOldestEngagementFirst(rows) {
  const at = (e) => lastEngagementMs(e) ?? Infinity;
  return [...rows].sort((a, b) => at(a) - at(b));
}
// A click-to-call answers once the STAFF leg starts, before the customer picks up, so the
// answered-call proof that takes an offer off Call today (lastCalledAt) lands only after the
// call ends. While a call placed from Call today is pending, re-read the list quietly once a
// minute, for at most 15 minutes, and stop as soon as that offer has left Call today.
export const CALL_WATCH_INTERVAL_MS = 60 * 1000;
export const CALL_WATCH_MAX_MS = 15 * 60 * 1000;
export function useCallListWatch({ enabled, estimates, refresh }) {
  const [pending, setPending] = useState(() => new Map());
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const watch = useCallback(
    (id) => {
      if (enabled && id) setPending((prev) => new Map(prev).set(id, Date.now()));
    },
    [enabled],
  );
  // Every re-read: an offer that left Call today, or whose window ran out, stops its watch.
  useEffect(() => {
    if (!pending.size) return;
    const now = Date.now();
    const byId = new Map((estimates || []).map((e) => [e.id, e]));
    const next = new Map(
      [...pending].filter(
        ([id, startedAt]) =>
          now - startedAt < CALL_WATCH_MAX_MS &&
          byId.has(id) &&
          isCallTodayEstimate(byId.get(id), now),
      ),
    );
    if (next.size !== pending.size) setPending(next);
  }, [estimates, pending]);
  useEffect(() => {
    if (!enabled || !pending.size) return undefined;
    const timer = setInterval(() => {
      const now = Date.now();
      setPending((prev) => {
        const next = new Map(
          [...prev].filter(([, startedAt]) => now - startedAt < CALL_WATCH_MAX_MS),
        );
        return next.size === prev.size ? prev : next;
      });
      refreshRef.current({ silent: true });
    }, CALL_WATCH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [enabled, pending.size]);
  return watch;
}
function v3ChipMatches(e, chip) {
  if (chip === "all") return true;
  if (Object.hasOwn(CALL_LIST_MATCHERS, chip)) return CALL_LIST_MATCHERS[chip](e);
  if (chip === "pricing_risk") return !!e.pricingRisk?.hasRisk;
  if (chip === "missing_cogs")
    return (e.pricingRisk?.missingCogsCount || 0) > 0;
  if (chip === "low_margin") return (e.pricingRisk?.lowMarginCount || 0) > 0;
  if (chip === "risk_type_review") return !!e.riskTypeNeedsReview;
  if (chip === "archived") return !!e.archivedAt;
  if (chip === "drafts") return e.status === "draft" || e.status === "send_failed";
  if (chip === "open")
    return (
      e.status === "scheduled" || e.status === "sent" || e.status === "viewed"
    );
  if (chip === "closed")
    return e.status === "accepted" || e.status === "declined";
  if (chip === "action") {
    if (e.status === "expired") return true;
    if (e.status === "viewed" && e.viewedAt) {
      const hrs = (Date.now() - new Date(e.viewedAt).getTime()) / 3.6e6;
      return hrs >= 48;
    }
    return false;
  }
  return true;
}
const PRICING_RISK_FILTERS = [
  {
    key: "pricing_risk",
    label: "Pricing Risk",
  },
  {
    key: "missing_cogs",
    label: "Missing COGS",
  },
  {
    key: "low_margin",
    label: "Low Margin",
  },
];
const PIPELINE_AND_RISK_FILTERS = [
  ...PIPELINE_FILTERS,
  ...PRICING_RISK_FILTERS,
];
function estimateMatchesFilter(e, filter) {
  // Archived-accepted rows ride along in the pipeline fetch for the Won
  // funnel/MRR stats; the Archived tab (its own fetch) is where archived
  // rows are browsed, so keep them out of All.
  if (filter === "all") return !e.archivedAt;
  if (filter === "won")
    return e._class === "won" || (!!e.archivedAt && e.status === "accepted");
  if (filter === "drafts")
    return e._class === "needs_estimate" || e._class === "ready_to_send";
  if (filter === "sent_group")
    return (
      e._class === "awaiting" ||
      e._class === "follow_up" ||
      e._class === "scheduled"
    );
  if (filter === "follow_up_overdue") return isFollowUpOverdueEstimate(e);
  if (filter === "going_cold") return isGoingColdEstimate(e);
  if (Object.hasOwn(CALL_LIST_MATCHERS, filter)) return CALL_LIST_MATCHERS[filter](e);
  if (filter === "pricing_risk") return !!e.pricingRisk?.hasRisk;
  if (filter === "missing_cogs")
    return (e.pricingRisk?.missingCogsCount || 0) > 0;
  if (filter === "low_margin") return (e.pricingRisk?.lowMarginCount || 0) > 0;
  if (filter === "pricing_warning") return e.pricingRisk?.status === "warning";
  return e._class === filter;
}
function estimateFilterLabel(filter) {
  if (filter === "drafts") return "Drafts";
  if (filter === "sent_group") return "Sent";
  if (filter === "follow_up_overdue") return "Follow-up overdue";
  if (filter === "going_cold") return "Going cold";
  if (filter === "call_today") return "Call today";
  if (filter === "pick_reason") return "Pick reason";
  if (filter === "pricing_warning") return "Pricing warnings";
  return PIPELINE_AND_RISK_FILTERS.find((f) => f.key === filter)?.label;
}
function serviceLineFromAuditLine(line) {
  const value = String(
    line?.protocol?.serviceType || line?.serviceKey || line?.label || "",
  ).toLowerCase();
  if (
    value.includes("termite") ||
    value.includes("bora-care") ||
    value.includes("bora care") ||
    value.includes("termidor")
  )
    return "termite";
  if (value.includes("mosquito")) return "mosquito";
  if (value.includes("rodent")) return "rodent";
  if (value.includes("lawn") || value.includes("turf")) return "lawn";
  if (value.includes("tree") || value.includes("shrub")) return "tree_shrub";
  return "pest";
}
function PricingRiskBadges({ risk, onMissingCogs, onLowMargin }) {
  if (!risk?.hasRisk) return null;
  return (
    <>
      {(risk.missingCogsCount || 0) > 0 && (
        <Button
          type="button"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onMissingCogs?.();
          }}
          className="h-auto p-0"
          title="Open pricing audit focused on missing inventory COGS"
        >
          {" "}
          <Badge tone="alert">Missing COGS</Badge>{" "}
        </Button>
      )}
      {(risk.lowMarginCount || 0) > 0 && (
        <Button
          type="button"
          variant="ghost"
          onClick={(e) => {
            e.stopPropagation();
            onLowMargin?.();
          }}
          className="h-auto p-0"
          title="Open pricing audit focused on low-margin lines"
        >
          {" "}
          <Badge tone="alert">Low Margin</Badge>{" "}
        </Button>
      )}
      {risk.status === "warning" &&
        !(risk.missingCogsCount || risk.lowMarginCount) && (
          <Badge tone="alert">Pricing Warning</Badge>
        )}
    </>
  );
}
function automationBadgeLabel(automation) {
  switch (automation?.status) {
    case "generated":
      return "Auto-priced";
    case "manual_review_required":
      return "Auto review";
    case "generation_failed":
      return "Auto failed";
    case "blocked":
      return "Auto blocked";
    case "ready":
      return "Auto ready";
    default:
      return null;
  }
}
function AutomationStatusBadge({ automation }) {
  const label = automationBadgeLabel(automation);
  if (!label) return null;
  const detail = [
    automation.confidence ? `confidence=${automation.confidence}` : null,
    automation.unsupportedReason,
    automation.quoteRequiredReason,
    ...(automation.missing || []),
    ...(automation.review || []),
  ].filter(Boolean);
  const needsReview = [
    "manual_review_required",
    "generation_failed",
    "blocked",
  ].includes(automation.status);
  return (
    <Badge tone={needsReview ? "alert" : "neutral"} title={detail.join(" · ")}>
      {label}
    </Badge>
  );
}
function LawnOutlineStatusBadge({ outline }) {
  if (!outline) return null;
  const status =
    outline.validationStatus === "blocked"
      ? "blocked"
      : outline.status || "draft";
  const tone =
    status === "blocked" || outline.stale
      ? "alert"
      : ["sent", "viewed"].includes(status)
        ? "strong"
        : "neutral";
  const label =
    status === "blocked"
      ? "Outline blocked"
      : outline.stale
        ? "Outline stale"
        : outline.ctaClickCount > 0
          ? `Outline clicked${outline.ctaClickCount > 1 ? ` ${outline.ctaClickCount}x` : ""}`
          : status === "viewed"
            ? `Outline viewed${outline.viewCount > 1 ? ` ${outline.viewCount}x` : ""}`
            : status === "sent"
              ? "Outline sent"
              : status === "revoked"
                ? "Outline revoked"
                : "Outline draft";
  const detail = [
    outline.turfType && `Turf: ${outline.turfType}`,
    outline.validationStatus && `Validation: ${outline.validationStatus}`,
    outline.lastCtaClickedAt &&
      `Estimate clicked ${timeAgo(outline.lastCtaClickedAt)}`,
    outline.lastViewedAt && `Last viewed ${timeAgo(outline.lastViewedAt)}`,
    outline.sentAt && `Sent ${timeAgo(outline.sentAt)}`,
    outline.staleReasons?.length
      ? `Regenerate: ${outline.staleReasons.join(", ")}`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Badge tone={tone} title={detail || undefined}>
      <ClipboardList size={11} strokeWidth={1.75} aria-hidden />
      {label}
    </Badge>
  );
}
function v3ChipCounts(estimates, chips = V3_CHIPS) {
  const out = {};
  for (const c of chips) {
    out[c.key] = estimates.filter((e) => v3ChipMatches(e, c.key)).length;
  }
  return out;
}

// Urgency indicator — "Going cold" / "Final follow-up" get alert tone,
// "Not opened" / "Follow up" stay neutral. V1 used red-at-72h/168h, amber
// at 24h/48h — we preserve the thresholds; only the visual weight changes.
function UrgencyBadge({ urgency }) {
  if (!urgency) return null;
  const isCritical =
    urgency.label === "Going cold" || urgency.label === "Final follow-up";
  return <Badge tone={isCritical ? "alert" : "neutral"}>{urgency.label}</Badge>;
}

// Recorded customer acceptance (terms version + text, time, device) for an
// accepted estimate. Read-only; staff "Mark won" writes no record, and the
// action only appears when the list says one exists.
export function AcceptanceRecordDialog({ estimate, onClose }) {
  const [state, setState] = useState({
    loading: true,
    record: null,
    error: "",
  });
  const estimateId = estimate?.id;
  useEffect(() => {
    if (!estimateId) return undefined;
    let cancelled = false;
    setState({ loading: true, record: null, error: "" });
    adminFetch(`/admin/estimates/${encodeURIComponent(estimateId)}/acceptance`)
      .then((body) => {
        if (!cancelled)
          setState({
            loading: false,
            record: body?.acceptance || null,
            error: "",
          });
      })
      .catch((err) => {
        if (!cancelled)
          setState({
            loading: false,
            record: null,
            error: err.message || "Could not load the record",
          });
      });
    return () => {
      cancelled = true;
    };
  }, [estimateId]);
  const { loading, record, error } = state;
  return (
    <Dialog open={!!estimate} onClose={onClose} size="md">
      <DialogHeader className="flex items-center justify-between gap-3">
        <DialogTitle>Acceptance record</DialogTitle>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          aria-label="Close acceptance record"
          className="h-9 w-9 px-0"
        >
          <X size={16} strokeWidth={1.75} aria-hidden />
        </Button>
      </DialogHeader>
      <DialogBody className="space-y-3 text-ui-body text-ink-secondary">
        {loading && <p>Loading…</p>}
        {!loading && error && <p>{error}</p>}
        {!loading && record && (
          <>
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-ink-tertiary">Accepted</dt>
              <dd>{fmtDateTime(record.acceptedAt)}</dd>
              <dt className="text-ink-tertiary">Terms version</dt>
              <dd>{record.termsVersion || "—"}</dd>
              <dt className="text-ink-tertiary">Device</dt>
              <dd>{record.device || "—"}</dd>
              <dt className="text-ink-tertiary">Network</dt>
              <dd className="u-nums">{record.ipMasked || "—"}</dd>
              <dt className="text-ink-tertiary">Record</dt>
              <dd className="u-nums">{record.recordId || "—"}</dd>
            </dl>
            <div>
              <div className="text-ink-tertiary">
                Terms the customer accepted
              </div>
              <p className="mt-1 max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-md border border-zinc-200 p-3 text-ink-primary">
                {record.termsText || "—"}
              </p>
            </div>
          </>
        )}
      </DialogBody>
    </Dialog>
  );
}

// Row overflow menu. Holds secondary actions (Audit, Preview, Resend, Copy
// Link, 1x Option toggle, Invoice toggle, Send Booking Link, Archive, Delete)
// so the inline action bar stays focused on the single primary action for
// the row's status. Mobile = bottom sheet, desktop = small centered popover.
function RowActionsMenu({ items, label = "More actions" }) {
  const [open, setOpen] = useState(false);
  const visible = (items || []).filter((item) => item && !item.hidden);
  if (visible.length === 0) return null;
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={label}
        className="h-11 w-11 shrink-0 px-0 sm:h-9 sm:w-9"
      >
        <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden />
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} size="sm">
        <DialogHeader className="flex items-center justify-between gap-3">
          <DialogTitle>Actions</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            aria-label="Close actions menu"
            className="h-9 w-9 px-0"
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </Button>
        </DialogHeader>
        <DialogBody className="p-2">
          <ul className="max-h-[70vh] overflow-y-auto">
            {visible.map((item) => (
              <li key={item.key}>
                <Button
                  type="button"
                  variant="ghost"
                  onClick={(event) => {
                    event.stopPropagation();
                    setOpen(false);
                    item.onClick?.();
                  }}
                  disabled={item.disabled}
                  title={item.title || undefined}
                  className={cn(
                    "h-auto min-h-11 w-full justify-start gap-3 px-3 py-2 text-left",
                    item.variant === "danger" &&
                      "text-alert-fg hover:bg-alert-bg",
                  )}
                >
                  <span
                    className={cn(
                      "w-4 shrink-0",
                      item.variant === "danger"
                        ? "text-alert-fg"
                        : "text-ink-tertiary",
                    )}
                  >
                    {item.icon || null}
                  </span>
                  <span className="flex-1">{item.label}</span>
                  {item.detail && (
                    <span className="text-ui-body text-ink-tertiary">
                      {item.detail}
                    </span>
                  )}
                </Button>
              </li>
            ))}
          </ul>
        </DialogBody>
      </Dialog>
    </>
  );
}

// Filter — 7 pipeline filters exceed the 4-item pill cap. Per UI SoR §6.1
// "over 4" rule + §6.6, we collapse to a single FILTER control that opens a
// shared dialog listing every option with its live count.
function FilterSheetV2({ value, onChange, options, counts }) {
  const [open, setOpen] = useState(false);
  const active = options.find((option) => option.key === value) || options[0];
  return (
    <>
      <Button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Filter estimates. Current filter: ${active.label} (${counts[active.key] ?? 0})`}
        className="gap-2"
      >
        <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden />
        <span>
          Filter: {active.label} ({counts[active.key] ?? 0})
        </span>
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        aria-label="Filter estimates"
      >
        <DialogHeader className="flex items-center justify-between gap-3">
          <DialogTitle>Filter estimates</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="h-9 w-9 px-0"
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </Button>
        </DialogHeader>
        <DialogBody className="p-2">
          <div className="space-y-1">
            {options.map((option) => {
              const isActive = option.key === value;
              return (
                <Button
                  key={option.key}
                  type="button"
                  variant={isActive ? "secondary" : "ghost"}
                  onClick={() => {
                    onChange(option.key);
                    setOpen(false);
                  }}
                  className="h-auto min-h-11 w-full justify-between gap-3 px-3 py-2 text-left"
                >
                  <span>{option.label}</span>
                  <span className="flex items-center gap-3">
                    <span className="u-nums text-ink-tertiary">
                      {counts[option.key] ?? 0}
                    </span>
                    {isActive && (
                      <Check size={16} strokeWidth={2} aria-hidden />
                    )}
                  </span>
                </Button>
              );
            })}
          </div>
        </DialogBody>
      </Dialog>
    </>
  );
}
function fmtMoney(value) {
  const n = Number(value || 0);
  return `$${Math.round(n).toLocaleString()}`;
}
function estimateAmountDisplay(estimate) {
  const monthly = Number(estimate?.monthlyTotal || 0);
  const oneTime = Number(estimate?.onetimeTotal || estimate?.oneTimeTotal || 0);
  if (monthly > 0)
    return {
      value: monthly,
      suffix: "/mo",
    };
  if (oneTime > 0)
    return {
      value: oneTime,
      suffix: " one-time",
    };
  return {
    value: 0,
    suffix: "/mo",
  };
}
// Whole dollars when the price is whole, cents otherwise ($94, $56.40), the way
// the estimate PDF prints a per-application price.
function fmtApplicationPrice(value) {
  const n = Number(value || 0);
  return Number.isInteger(n)
    ? `$${n.toLocaleString()}`
    : `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
// What a Pipeline card prints for the price. `perApplication` comes from the
// list endpoint (null when the plan is not described per application); without
// it the card is exactly what it was: "$X/mo" or "$X one-time".
//   single service -> lead "$94 per application" + "4 a year · $31/mo avg"
//   2+ services    -> the existing plan figure + one "Label $X per application" line each
function estimatePriceDisplay(estimate) {
  const base = estimateAmountDisplay(estimate);
  const lines = (
    Array.isArray(estimate?.perApplication) ? estimate.perApplication : []
  ).filter((line) => line && Number(line.amount) > 0);
  if (!lines.length || !(base.value > 0) || base.suffix !== "/mo") {
    return { ...base, lead: `$${base.value.toFixed(0)}`, secondary: [] };
  }
  if (lines.length === 1) {
    const [line] = lines;
    const visits = Number(line.visitsPerYear);
    return {
      value: base.value,
      suffix: " per application",
      lead: fmtApplicationPrice(line.amount),
      secondary: [
        `${visits > 0 ? `${visits} a year · ` : ""}${fmtMoney(base.value)}/mo avg`,
      ],
    };
  }
  return {
    ...base,
    lead: `$${base.value.toFixed(0)}`,
    secondary: lines.map(
      (line) =>
        `${line.label || "Service"} ${fmtApplicationPrice(line.amount)} per application`,
    ),
  };
}
// The one-line form for the 64px mobile card.
function estimatePriceInline(display) {
  return [`${display.lead}${display.suffix}`, ...display.secondary].join(" · ");
}
// Which "view" action a row gets.
//  - Rows the staff preview renders (`staffPreviewable`, the server's verdict:
//    an unpublished draft, or a row the customer page shows): the staff preview
//    of the customer page (?adminPreview=1, never counts a view).
//  - Accepted rows: the customer page shows only the booking step, so the full
//    accepted document is the PDF.
//  - Everything else (expired, send_failed, archived, held for a re-price,
//    invalidated): the public routes 404, so the staff PDF route is the only
//    way to see it.
// Both PDF kinds come from GET /admin/estimates/:id/proposal.pdf (staff auth,
// browser document renderer where the row is viewable, pdfkit otherwise, the
// acceptance record included, never counts a view).
function estimateViewAction(estimate) {
  if (!estimate?.id) return null;
  if (estimate.status === "accepted") {
    return { kind: "pdf", label: "View accepted estimate" };
  }
  const href = estimatePreviewHref(estimate);
  if (href && estimate.staffPreviewable) {
    return { kind: "preview", label: "View estimate", href };
  }
  return { kind: "pdf", label: "View estimate (PDF)" };
}
// Opens the staff PDF in a new tab. The tab opens synchronously on the click
// (popup blockers refuse a window.open issued after an await), then the PDF is
// fetched with the staff token (adminFetch parses JSON, so this is a raw fetch)
// and shown from an object URL. onError gets a message for an inline display.
function openStaffEstimatePdf(estimateId, onError) {
  const win = window.open("", "_blank");
  if (win) {
    win.opener = null;
    try {
      win.document.write("Opening estimate…");
    } catch {
      /* about:blank write can throw in some browsers */
    }
  }
  return fetch(
    `${API_BASE}/admin/estimates/${encodeURIComponent(estimateId)}/proposal.pdf`,
    {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      },
    },
  )
    .then((r) => {
      if (!r.ok)
        throw new Error(`Could not open the estimate PDF (${r.status})`);
      return r.blob();
    })
    .then((blob) => {
      const url = URL.createObjectURL(blob);
      if (win) win.location = url;
      else window.open(url, "_blank", "noopener,noreferrer");
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    })
    .catch((err) => {
      if (win) win.close();
      onError?.(err.message || "Could not open the estimate PDF");
    });
}
// The row's view actions, shared by the desktop and mobile menus: the view
// action, then "View acceptance record" on an accepted row that has one.
function estimateViewMenuItems(estimate, { onPdfError, onViewAcceptance }) {
  const action = estimateViewAction(estimate);
  return [
    action && {
      key: action.kind === "preview" ? "preview" : "view-pdf",
      label: action.label,
      icon: <ExternalLink size={16} strokeWidth={1.75} />,
      onClick: () =>
        action.kind === "preview"
          ? window.open(action.href, "_blank", "noopener,noreferrer")
          : (onPdfError?.(""), openStaffEstimatePdf(estimate.id, onPdfError)),
    },
    estimate.status === "accepted" &&
      estimate.hasAcceptanceRecord &&
      onViewAcceptance && {
        key: "acceptance-record",
        label: "View acceptance record",
        icon: <FileText size={16} strokeWidth={1.75} />,
        onClick: () => onViewAcceptance(estimate),
      },
  ];
}
function fmtPct(value) {
  if (value == null || Number.isNaN(Number(value))) return "—";
  return `${Math.round(Number(value) * 100)}%`;
}
function fmtDateTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
      timeZoneName: "short",
    });
  } catch {
    return "—";
  }
}

// Stat card — label, big value, sub. Single alert accent reserved for
// Follow-Up Overdue when >0. Conversion% no longer color-codes; the
// number alone tells the story. Centered both axes per spec.
function StatCard({ label, value, sub, alert }) {
  return (
    <Card className="flex-1 min-w-[140px] p-4 min-h-[104px] flex flex-col items-center justify-center text-center">
      {" "}
      <div className="text-ui-body uppercase tracking-label text-ink-tertiary mb-1">
        {label}
      </div>{" "}
      <div
        className={cn(
          "text-22 font-medium u-nums",
          alert ? "text-alert-fg" : "text-zinc-900",
        )}
      >
        {value}
      </div>
      {sub && <div className="text-ui-body text-ink-tertiary mt-1">{sub}</div>}
    </Card>
  );
}
const WORK_QUEUE_GROUPS = [
  {
    label: "Work Queue",
    keys: [
      "needs_estimate",
      "ready_to_send",
      "scheduled",
      "awaiting",
      "follow_up",
    ],
  },
  {
    label: "Risk Review",
    keys: ["pricing_risk", "missing_cogs", "low_margin"],
  },
  {
    label: "Outcomes",
    keys: ["won", "lost", "archived"],
  },
];
function WorkQueueRail({ value, onChange, counts }) {
  const optionsByKey = useMemo(() => {
    const entries = PIPELINE_AND_RISK_FILTERS.map((item) => [item.key, item]);
    return Object.fromEntries(entries);
  }, []);
  return (
    <Card className="hidden xl:block sticky top-[132px] p-3">
      {" "}
      <Button
        type="button"
        variant={value === "all" ? "primary" : "ghost"}
        onClick={() => onChange("all")}
        className="w-full justify-between gap-2 text-left"
      >
        {" "}
        <span className="text-ui-body font-medium uppercase tracking-label">
          All Work
        </span>{" "}
        <span className="text-ui-body u-nums">{counts.all ?? 0}</span>{" "}
      </Button>
      {WORK_QUEUE_GROUPS.map((group) => (
        <div key={group.label} className="mt-4">
          {" "}
          <div className="px-1 mb-1.5 text-ui-body uppercase tracking-label font-medium text-ink-tertiary">
            {group.label}
          </div>{" "}
          <div className="space-y-1">
            {group.keys.map((key) => {
              const item = optionsByKey[key];
              if (!item) return null;
              const active = value === key;
              return (
                <Button
                  key={key}
                  type="button"
                  variant={active ? "primary" : "ghost"}
                  onClick={() => onChange(key)}
                  className="w-full justify-between gap-2 text-left"
                >
                  {" "}
                  <span className="text-ui-body">{item.label}</span>{" "}
                  <span className="text-ui-body u-nums opacity-80">
                    {counts[key] ?? 0}
                  </span>{" "}
                </Button>
              );
            })}
          </div>{" "}
        </div>
      ))}
    </Card>
  );
}
function PipelineCommandHeader({ activeTab, onTabChange, onNewLead }) {
  if (activeTab === "new") return null;
  const sections = TABS.filter((item) => item.key !== "new");
  const actions = [
    {
      key: "create-estimate",
      label: "Create estimate",
      icon: FilePlus2,
      onClick: () => onTabChange("new"),
      variant: activeTab === "leads" ? "secondary" : "primary",
    },
    activeTab === "leads"
      ? {
          key: "new-lead",
          label: "New lead",
          icon: Plus,
          onClick: onNewLead,
        }
      : null,
  ].filter(Boolean);
  return (
    <AdminCommandHeader
      variant="workspace"
      title="Pipeline"
      icon={Users}
      sections={sections}
      activeKey={activeTab}
      onSectionChange={onTabChange}
      ariaLabel="Pipeline section"
      navGridClassName="grid-cols-3"
      actions={actions}
    />
  );
}
function EstimatePricingAuditModal({
  estimate,
  initialFocus = "all",
  onClose,
}) {
  const navigate = useNavigate();
  const [audit, setAudit] = useState(null);
  const [error, setError] = useState("");
  const [focus, setFocus] = useState(initialFocus || "all");
  useEffect(() => {
    let alive = true;
    setAudit(null);
    setError("");
    setFocus(initialFocus || "all");
    adminFetch(`/admin/estimates/${estimate.id}/pricing-audit`)
      .then((data) => {
        if (alive) setAudit(data);
      })
      .catch((err) => {
        if (alive) setError(err.message);
      });
    return () => {
      alive = false;
    };
  }, [estimate.id, initialFocus]);
  const lineMatchesFocus = (line) => {
    if (focus === "missing_cogs")
      return ["missing_cogs", "unmapped"].includes(line.cogs?.status);
    if (focus === "low_margin")
      return line.margin != null && line.margin < 0.35;
    return true;
  };
  const visibleLines = audit?.lines?.filter(lineMatchesFocus) || [];
  const focusLabel =
    focus === "missing_cogs"
      ? "Missing COGS"
      : focus === "low_margin"
        ? "Low Margin"
        : "All Lines";
  const goFixSource = (line) => {
    const serviceLine = serviceLineFromAuditLine(line);
    if (["missing_cogs", "unmapped"].includes(line.cogs?.status)) {
      navigate(
        `/admin/inventory?tab=protocols&serviceLine=${encodeURIComponent(serviceLine)}&add=1`,
      );
      onClose();
      return;
    }
    if (line.cogs?.status === "warning") {
      navigate(
        `/admin/inventory?tab=protocols&serviceLine=${encodeURIComponent(serviceLine)}&highlight=costs`,
      );
      onClose();
      return;
    }
    navigate(
      `/admin/pricing-logic?service=${encodeURIComponent(line.serviceKey || serviceLine)}&focus=margin`,
    );
    onClose();
  };
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      layer={1000}
      aria-label="Estimate pricing audit"
      className="max-w-5xl"
    >
      <DialogHeader className="flex items-start justify-between gap-4">
        {" "}
        <div>
          {" "}
          <DialogTitle>Estimate pricing audit</DialogTitle>{" "}
          <div className="text-ui-body text-ink-secondary mt-1">
            {estimate.customerName || "Unknown"} ·{" "}
            {estimate.address || "No address"}
          </div>{" "}
        </div>{" "}
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          className="h-9 w-9 px-0"
          aria-label="Close pricing audit"
        >
          {" "}
          <X size={16} strokeWidth={1.75} />{" "}
        </Button>{" "}
      </DialogHeader>
      <DialogBody>
        {error && (
          <div className="border-hairline border-alert-fg bg-alert-bg text-alert-fg rounded-xs p-3 text-ui-body">
            {error}
          </div>
        )}
        {!audit && !error && (
          <div className="p-8 text-center text-ui-body text-ink-secondary">
            Loading audit…
          </div>
        )}
        {audit && (
          <div className="space-y-4">
            {" "}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
              {" "}
              <StatCard
                label="Annual + 1x Revenue"
                value={fmtMoney(audit.totals.revenue)}
                sub="stored estimate"
              />{" "}
              <StatCard
                label="Inventory COGS"
                value={fmtMoney(audit.totals.estimatedCost)}
                sub="current products"
              />{" "}
              <StatCard
                label="Gross Profit"
                value={fmtMoney(audit.totals.grossProfit)}
                sub={fmtPct(audit.totals.margin)}
                alert={
                  audit.totals.margin != null && audit.totals.margin < 0.35
                }
              />{" "}
              <StatCard
                label="WaveGuard"
                value={audit.estimate.waveguardTier || "—"}
                sub={audit.estimate.pricingVersion || "saved result"}
              />{" "}
            </div>
            {audit.snapshot && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {" "}
                <Card className="p-4">
                  {" "}
                  <div className="text-ui-body uppercase tracking-label text-ink-tertiary mb-2">
                    Sent Snapshot
                  </div>{" "}
                  <div className="grid grid-cols-3 gap-3">
                    {" "}
                    <div>
                      {" "}
                      <div className="text-ui-body text-ink-tertiary">
                        COGS
                      </div>{" "}
                      <div className="text-16 font-medium u-nums text-zinc-900">
                        {fmtMoney(audit.snapshot.totals?.estimatedCost)}
                      </div>{" "}
                    </div>{" "}
                    <div>
                      {" "}
                      <div className="text-ui-body text-ink-tertiary">
                        Margin
                      </div>{" "}
                      <div className="text-16 font-medium u-nums text-zinc-900">
                        {fmtPct(audit.snapshot.totals?.margin)}
                      </div>{" "}
                    </div>{" "}
                    <div>
                      {" "}
                      <div className="text-ui-body text-ink-tertiary">
                        Captured
                      </div>{" "}
                      <div className="text-ui-body text-zinc-900">
                        {fmtDateTime(audit.snapshot.snapshotAt)}
                      </div>{" "}
                    </div>{" "}
                  </div>{" "}
                </Card>{" "}
                <Card className="p-4">
                  {" "}
                  <div className="text-ui-body uppercase tracking-label text-ink-tertiary mb-2">
                    Current Audit
                  </div>{" "}
                  <div className="grid grid-cols-3 gap-3">
                    {" "}
                    <div>
                      {" "}
                      <div className="text-ui-body text-ink-tertiary">
                        COGS
                      </div>{" "}
                      <div className="text-16 font-medium u-nums text-zinc-900">
                        {fmtMoney(audit.totals.estimatedCost)}
                      </div>{" "}
                    </div>{" "}
                    <div>
                      {" "}
                      <div className="text-ui-body text-ink-tertiary">
                        Margin
                      </div>{" "}
                      <div className="text-16 font-medium u-nums text-zinc-900">
                        {fmtPct(audit.totals.margin)}
                      </div>{" "}
                    </div>{" "}
                    <div>
                      {" "}
                      <div className="text-ui-body text-ink-tertiary">
                        Delta
                      </div>{" "}
                      <div className="text-16 font-medium u-nums text-zinc-900">
                        {audit.snapshot.totals?.margin == null ||
                        audit.totals.margin == null
                          ? "—"
                          : `${Math.round((audit.totals.margin - audit.snapshot.totals.margin) * 100)} pts`}
                      </div>{" "}
                    </div>{" "}
                  </div>{" "}
                </Card>{" "}
              </div>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-hairline border-zinc-200 rounded-md px-3 py-2">
              {" "}
              <div className="text-ui-body text-ink-secondary">
                Showing{" "}
                <span className="font-medium text-zinc-900">{focusLabel}</span>
                {focus !== "all"
                  ? ` (${visibleLines.length} of ${audit.lines.length})`
                  : ""}
              </div>{" "}
              <div className="flex flex-wrap gap-1.5">
                {[
                  {
                    key: "all",
                    label: "All",
                  },
                  {
                    key: "missing_cogs",
                    label: "Missing COGS",
                  },
                  {
                    key: "low_margin",
                    label: "Low Margin",
                  },
                ].map((item) => (
                  <Button
                    key={item.key}
                    type="button"
                    variant={focus === item.key ? "primary" : "secondary"}
                    size="sm"
                    onClick={() => setFocus(item.key)}
                  >
                    {item.label}
                  </Button>
                ))}
              </div>{" "}
            </div>{" "}
            <div className="border-hairline border-zinc-200 rounded-md overflow-hidden">
              {" "}
              <div className="hidden md:grid grid-cols-[1.1fr_0.85fr_0.75fr_0.65fr_0.75fr_1fr_0.65fr] gap-3 px-3 py-2 bg-zinc-50 text-ui-body uppercase tracking-label text-ink-tertiary font-medium">
                {" "}
                <div>Line</div> <div>Price Source</div> <div>Protocol</div>{" "}
                <div>Revenue</div> <div>COGS</div> <div>Margin / Warnings</div>{" "}
                <div>Fix</div>{" "}
              </div>
              {visibleLines.length === 0 ? (
                <div className="p-4 text-ui-body text-ink-secondary">
                  {audit.lines.length === 0
                    ? "No saved estimate lines found."
                    : `No ${focusLabel.toLowerCase()} lines found.`}
                </div>
              ) : (
                visibleLines.map((line, idx) => (
                  <div
                    key={`${line.serviceKey}-${idx}`}
                    className="grid grid-cols-1 md:grid-cols-[1.1fr_0.85fr_0.75fr_0.65fr_0.75fr_1fr_0.65fr] gap-3 px-3 py-3 border-t border-zinc-100 text-ui-body"
                  >
                    {" "}
                    <div>
                      {" "}
                      <div className="font-medium text-zinc-900">
                        {line.label}
                      </div>{" "}
                      <div className="text-ink-secondary">
                        {line.cadence === "recurring"
                          ? `${line.monthly ? fmtMoney(line.monthly) : "—"}/mo`
                          : "one-time"}{" "}
                        · {line.cogs?.visitsPerYear || 0} visit
                        {line.cogs?.visitsPerYear === 1 ? "" : "s"}
                      </div>{" "}
                    </div>{" "}
                    <div className="text-ink-secondary break-words">
                      {line.priceSource}
                    </div>{" "}
                    <div>
                      {" "}
                      <div className="text-zinc-900">
                        {line.protocol?.programKey || "—"}
                      </div>{" "}
                      <div className="text-ink-secondary">
                        {line.protocol?.matched
                          ? line.protocol.visitName || "matched"
                          : line.protocol?.reason || "not matched"}
                      </div>{" "}
                    </div>{" "}
                    <div className="u-nums font-medium text-zinc-900">
                      {fmtMoney(line.price)}
                    </div>{" "}
                    <div>
                      {" "}
                      <div className="u-nums font-medium text-zinc-900">
                        {fmtMoney(line.cogs?.estimatedCost)}
                      </div>{" "}
                      <div className="text-ink-secondary">
                        {fmtMoney(line.cogs?.totalPerVisit)}/visit ·{" "}
                        {line.cogs?.status}
                      </div>
                      {line.cogs?.lines?.length > 0 && (
                        <div className="mt-1 text-ui-body text-ink-tertiary">
                          {line.cogs.lines
                            .slice(0, 2)
                            .map((p) => p.productName)
                            .join(", ")}
                          {line.cogs.lines.length > 2
                            ? ` +${line.cogs.lines.length - 2}`
                            : ""}
                        </div>
                      )}
                    </div>{" "}
                    <div>
                      {" "}
                      <Badge tone={line.status === "ok" ? "neutral" : "alert"}>
                        {fmtPct(line.margin)}
                      </Badge>
                      {line.warnings?.length > 0 && (
                        <div className="mt-1 space-y-1">
                          {line.warnings.slice(0, 3).map((w, i) => (
                            <div key={i} className="text-ui-body text-alert-fg">
                              {w}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>{" "}
                    <div>
                      {line.status === "ok" ? (
                        <span className="text-ink-tertiary">—</span>
                      ) : (
                        <Button
                          type="button"
                          onClick={() => goFixSource(line)}
                          className="inline-flex items-center gap-1.5 h-8 u-focus-ring"
                          title="Open the source setup for this pricing issue"
                        >
                          {" "}
                          <ExternalLink
                            size={13}
                            strokeWidth={1.75}
                            aria-hidden
                          />
                          Fix source
                        </Button>
                      )}
                    </div>{" "}
                  </div>
                ))
              )}
            </div>{" "}
            <div className="text-ui-body text-ink-tertiary">
              Pricing is read from the saved estimate result. Current COGS is
              recalculated from today's inventory product costs and service
              protocol mappings; sent snapshots preserve the audit values
              captured when the estimate was delivered.
            </div>{" "}
          </div>
        )}
      </DialogBody>
    </Dialog>
  );
}
function fmtDate(d) {
  if (!d) return "—";
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
function estimatePreviewHref(estimate) {
  if (!estimate?.token) return null;
  const base = `/estimate/${encodeURIComponent(estimate.token)}`;
  // Unpublished rows render the legacy SSR page on the bare URL. The param
  // routes staff to the REAL React customer page instead — the /data endpoint
  // verifies the staff JWT before serving a draft, so the link stays inert
  // for anyone else.
  return `${base}?adminPreview=1`;
}

// Formats an appointment row from /admin/estimates as a short label like
// "Tue 5/12 · 9:00 AM". scheduledDate is YYYY-MM-DD in ET, so we render it
// in ET to keep day-of-week consistent regardless of viewer locale.
function formatApptShort(appt) {
  if (!appt?.scheduledDate) return "";
  // Accept either a date-only string (YYYY-MM-DD) or a full ISO timestamp —
  // production rows sometimes carry the latter, and naive concatenation of
  // `${scheduledDate}T12:00:00-05:00` against a full ISO produces Invalid
  // Date (two T-segments). Strip to the date component first.
  const dateOnly = String(appt.scheduledDate).split("T")[0];
  const dt = new Date(`${dateOnly}T12:00:00-05:00`);
  if (Number.isNaN(dt.getTime())) return "";
  const dow = dt.toLocaleDateString("en-US", {
    weekday: "short",
    timeZone: "America/New_York",
  });
  const md = dt.toLocaleDateString("en-US", {
    month: "numeric",
    day: "numeric",
    timeZone: "America/New_York",
  });
  const t = appt.windowDisplay ? ` · ${appt.windowDisplay}` : "";
  return `${dow} ${md}${t}`;
}
function timeAgo(d) {
  if (!d) return "";
  const mins = Math.floor((Date.now() - new Date(d)) / 60000);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}
function estimateHasLawnLine(estimate = {}) {
  const serviceLines = Array.isArray(estimate.serviceLines)
    ? estimate.serviceLines
    : [];
  const haystack = [
    estimate.serviceInterest,
    estimate.description,
    estimate.notes,
    ...serviceLines,
  ]
    .join(" ")
    .toLowerCase();
  // 'turf' covers the commercial turf-treatment label ("Commercial Turf
  // Treatment Program") so the Lawn service-outline workflow still gates on.
  return haystack.includes("lawn") || haystack.includes("turf");
}
function LawnOutlineQuickButton({ estimate, onClick, compact = false }) {
  if (!estimateHasLawnLine(estimate)) return null;
  const outline = estimate.lawnServiceOutline;
  const clicked = outline?.ctaClickCount > 0;
  const viewed = outline?.viewCount > 0;
  const blocked = outline?.validationStatus === "blocked";
  const stale = outline?.stale;
  const active =
    clicked || viewed || ["sent", "viewed"].includes(outline?.status);
  const title = outline
    ? [
        stale &&
          `Stale: ${outline.staleReasons?.join(", ") || "regenerate recommended"}`,
        clicked && `Estimate clicked ${timeAgo(outline.lastCtaClickedAt)}`,
        viewed && `Viewed ${outline.viewCount}x`,
        outline.sentAt && `Sent ${timeAgo(outline.sentAt)}`,
        outline.productCardCount
          ? `${outline.productCardCount} product cards`
          : null,
        blocked ? "Validation blocked" : null,
      ]
        .filter(Boolean)
        .join(" · ")
    : "Generate lawn service outline";
  return (
    <Button
      type="button"
      variant={blocked || stale ? "danger" : active ? "primary" : "secondary"}
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(estimate);
      }}
      aria-label={
        outline ? "Open lawn service outline" : "Generate lawn service outline"
      }
      title={title || "Open lawn service outline"}
      className={compact ? "h-11 w-11 px-0 sm:h-9 sm:w-9" : "gap-1.5"}
    >
      <ClipboardList size={16} strokeWidth={1.75} aria-hidden />
      {!compact && (
        <span>
          {stale
            ? "Stale"
            : clicked
              ? "Clicked"
              : viewed
                ? "Viewed"
                : outline
                  ? "Outline"
                  : "Outline"}
        </span>
      )}
    </Button>
  );
}
const SOURCE_ICON = {
  lead_webhook: {
    Icon: Globe,
    title: "Website lead",
  },
  referral: {
    Icon: Users,
    title: "Referral",
  },
  ai_agent: {
    Icon: Bot,
    title: "AI agent draft — review before sending",
  },
  call_recording: {
    Icon: Phone,
    title: "Phone call recording draft",
  },
  estimator_engine: {
    Icon: Bot,
    title: "Estimator engine draft — review before sending",
  },
};

// Estimator-engine and ai_agent drafts carry their operator review material
// (lane + reasons, or reasoning/assumptions/uncertainty) in the list payload —
// it lives in estimate_data because the notes COLUMN is customer-visible via
// the public endpoint. This badge is the operator's pre-send surface for it.
function EngineReviewBadge({ engine, agentReview, onOpen }) {
  if (!engine?.lane && !agentReview) return null;
  const flagged =
    (engine?.lane && engine.lane !== "green") ||
    (engine?.marginWarnings || []).length > 0 ||
    (agentReview?.uncertainty || []).length > 0 ||
    (agentReview?.belowTargetServices || []).length > 0 ||
    (agentReview?.unverifiedLineCount || 0) > 0;
  return (
    <Button
      type="button"
      variant="ghost"
      onClick={(evt) => {
        evt.stopPropagation();
        onOpen();
      }}
      title={
        flagged
          ? "AI draft flagged for review — open the engine's reasons before sending"
          : "AI draft — open the engine's review notes"
      }
      className="h-auto p-0"
    >
      <Badge tone={flagged ? "alert" : "neutral"}>
        <Bot size={11} strokeWidth={1.75} aria-hidden />
        {flagged ? "AI Review" : "AI Draft"}
      </Badge>
    </Button>
  );
}
export function EngineReviewModal({ estimate, onClose }) {
  const engine = estimate.estimatorEngine || {};
  const agentReview = estimate.agentDraftReview || null;
  const flagged =
    (estimate.estimatorEngine && engine.lane !== "green") ||
    (engine.marginWarnings || []).length > 0 ||
    (agentReview?.uncertainty || []).length > 0 ||
    (agentReview?.belowTargetServices || []).length > 0 ||
    (agentReview?.unverifiedLineCount || 0) > 0;
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      layer={1000}
      aria-label="AI draft review"
      className="max-w-2xl"
    >
      <DialogHeader className="flex items-start justify-between gap-4">
        <div>
          <DialogTitle>AI draft review</DialogTitle>
          <div className="text-ui-body text-ink-secondary mt-1">
            {estimate.customerName || "Unknown"} ·{" "}
            {estimate.address || "No address"}
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          onClick={onClose}
          className="h-9 w-9 px-0"
          aria-label="Close AI draft review"
        >
          <X size={16} strokeWidth={1.75} />
        </Button>
      </DialogHeader>
      <DialogBody className="space-y-4">
        <Badge tone={flagged ? "alert" : "neutral"}>
          {flagged ? "Flagged for review" : "No gaps flagged"}
        </Badge>
        {(engine.laneReasons || []).length > 0 && (
          <div>
            <div className="text-ui-body uppercase tracking-label text-ink-tertiary mb-2">
              Review reasons
            </div>
            <ul className="list-disc pl-5 space-y-1 text-ui-body text-zinc-800">
              {engine.laneReasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          </div>
        )}
        {engine.reviewNotes && (
          <div>
            <div className="text-ui-body uppercase tracking-label text-ink-tertiary mb-2">
              Engine notes and evidence
            </div>
            <pre className="whitespace-pre-wrap font-sans text-ui-body text-zinc-800 bg-zinc-50 border-hairline border-zinc-200 rounded-xs p-3">
              {engine.reviewNotes}
            </pre>
          </div>
        )}
        {(engine.marginWarnings || []).length > 0 && (
          <div>
            <div className="text-ui-body uppercase tracking-label text-ink-tertiary mb-2">
              Margin review (report-only — nothing moved the price)
            </div>
            <ul className="list-disc pl-5 space-y-1 text-ui-body text-zinc-800">
              {engine.marginWarnings.map((warning, i) => (
                <li key={i}>
                  {String(warning?.message || warning?.code || warning).replace(
                    /_/g,
                    " ",
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
        {agentReview?.reasoning && (
          <div>
            <div className="text-ui-body uppercase tracking-label text-ink-tertiary mb-2">
              Agent reasoning
            </div>
            <pre className="whitespace-pre-wrap font-sans text-ui-body text-zinc-800 bg-zinc-50 border-hairline border-zinc-200 rounded-xs p-3">
              {agentReview.reasoning}
            </pre>
            {agentReview.sqftSource && (
              <div className="text-ui-body text-ink-secondary mt-1">
                Sqft source:{" "}
                {agentReview.sqftSource === "property_lookup"
                  ? "property lookup"
                  : "operator input"}
              </div>
            )}
          </div>
        )}
        {(agentReview?.assumptions || []).length > 0 && (
          <div>
            <div className="text-ui-body uppercase tracking-label text-ink-tertiary mb-2">
              Assumptions made
            </div>
            <ul className="list-disc pl-5 space-y-1 text-ui-body text-zinc-800">
              {agentReview.assumptions.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {(agentReview?.uncertainty || []).length > 0 && (
          <div>
            <div className="text-ui-body uppercase tracking-label text-ink-tertiary mb-2">
              Uncertainty flags
            </div>
            <ul className="list-disc pl-5 space-y-1 text-ui-body text-zinc-800">
              {agentReview.uncertainty.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {(agentReview?.belowTargetServices || []).length > 0 && (
          <div>
            <div className="text-ui-body uppercase tracking-label text-ink-tertiary mb-2">
              Below margin target
            </div>
            <ul className="list-disc pl-5 space-y-1 text-ui-body text-zinc-800">
              {agentReview.belowTargetServices.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {(agentReview?.unverifiedLineCount || 0) > 0 && (
          <div className="text-ui-body text-zinc-800">
            Margin could not be verified on {agentReview.unverifiedLineCount}{" "}
            priced line{agentReview.unverifiedLineCount === 1 ? "" : "s"} —
            check the pricing audit before sending.
          </div>
        )}
        {!engine.reviewNotes &&
          !(engine.laneReasons || []).length &&
          !(engine.marginWarnings || []).length &&
          !agentReview?.reasoning &&
          !(agentReview?.assumptions || []).length &&
          !(agentReview?.uncertainty || []).length &&
          !(agentReview?.belowTargetServices || []).length &&
          !(agentReview?.unverifiedLineCount || 0) && (
            <div className="text-ui-body text-ink-secondary">
              No review material recorded for this draft.
            </div>
          )}
      </DialogBody>
    </Dialog>
  );
}

// Deep-link from a notification: /admin/estimates?estimateId=<id> scrolls the
// matching estimate into view and briefly highlights it (estimate_expired and
// bundle_quote_requested notifications). The pipeline has no per-estimate detail
// view, so the highlight is the "you're here" cue. Shared by the desktop and
// mobile estimate lists.
//
// Deliberately minimal: it highlights the row only if it's already visible in
// the current list, and otherwise leaves the list untouched. The notification
// bell navigates with window.location.href (a full reload), so the list always
// mounts fresh with default filters / no search — the target is visible without
// the hook ever having to touch the operator's filters. Not auto-clearing
// filters is what keeps this side-effect-free (no fighting the operator's input,
// no timers, no load-race).
//
// `targetId` is the deep-link id; `token` bumps once per navigation (captured +
// one-shotted by the page) so clicking the same notification again re-arms the
// cue. `rows` is the rendered list — passed only so the effect re-checks as the
// list loads. Returns the id to highlight while active.
function useEstimateDeepLinkHighlight({ targetId, token, rows }) {
  const [activeId, setActiveId] = useState(null);
  // The nav token we've already highlighted — guards against re-scrolling on
  // every later render, while a new token (repeat click) re-arms.
  const doneTokenRef = useRef(null);
  useEffect(() => {
    if (!targetId || doneTokenRef.current === token) return;
    const sel = window.CSS?.escape ? window.CSS.escape(targetId) : targetId;
    const node = document.querySelector(`[data-estimate-id="${sel}"]`);
    if (!node) return; // not visible in the current view — leave the list as-is
    doneTokenRef.current = token;
    node.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
    setActiveId(targetId);
  }, [token, targetId, rows]);

  // Fade the highlight a few seconds after it activates.
  useEffect(() => {
    if (!activeId) return undefined;
    const t = setTimeout(() => setActiveId(null), 2600);
    return () => clearTimeout(t);
  }, [activeId]);
  return activeId;
}

const ESTIMATE_TABLE_PAGE_SIZES = [25, 50, 100, 500];

function estimateMatchesTableSearch(estimate, query) {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    estimate.customerName,
    estimate.address,
    estimate.customerEmail,
    estimate.customerPhone,
    shortEstimateRef(estimate.id),
  ].some((value) =>
    String(value || "")
      .toLowerCase()
      .includes(q),
  );
}

function estimateTableSortFn(sortKey, enabled = true) {
  if (!enabled) return estimateTableSortFn("newest");
  if (sortKey === "v3") return v3SortFn;
  if (sortKey === "oldest") {
    return (a, b) => new Date(a.createdAt) - new Date(b.createdAt);
  }
  if (sortKey === "amount-desc" || sortKey === "amount-asc") {
    const direction = sortKey === "amount-desc" ? -1 : 1;
    return (a, b) =>
      direction *
      (estimateAmountDisplay(a).value - estimateAmountDisplay(b).value);
  }
  return (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
}

function useEstimateTablePaging(
  rows,
  enabled,
  initialPageSize,
  deepLinkEstimateId,
  deepLinkToken,
) {
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(initialPageSize);
  const pagedDeepLinkTokenRef = useRef(null);
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize));
  useEffect(() => {
    if (!enabled) return;
    setPage((current) => Math.min(Math.max(1, current), totalPages));
  }, [enabled, totalPages]);
  useEffect(() => {
    if (
      !enabled ||
      !deepLinkEstimateId ||
      pagedDeepLinkTokenRef.current === deepLinkToken
    )
      return;
    const targetIndex = rows.findIndex(
      (estimate) => String(estimate.id) === String(deepLinkEstimateId),
    );
    if (targetIndex >= 0) {
      pagedDeepLinkTokenRef.current = deepLinkToken;
      setPage(Math.floor(targetIndex / pageSize) + 1);
    }
  }, [deepLinkEstimateId, deepLinkToken, enabled, pageSize, rows]);
  const displayedRows = enabled
    ? rows.slice((page - 1) * pageSize, page * pageSize)
    : rows;
  const changePageSize = useCallback((nextPageSize) => {
    setPageSize(nextPageSize);
    setPage(1);
  }, []);
  return {
    page,
    setPage,
    pageSize,
    changePageSize,
    totalPages,
    displayedRows,
  };
}

function EstimateTableControls({
  enabled,
  search,
  onSearchChange,
  sort,
  onSortChange,
  sortOptions,
  onReset,
  canReset,
  children,
}) {
  if (!enabled) return null;
  return (
    <div className="mb-3 grid gap-2">
      <TableToolbar
        label="Estimates"
        search={search}
        onSearchChange={onSearchChange}
        searchPlaceholder="Search loaded estimates"
        onReset={onReset}
        canReset={canReset}
      >
        {children}
        <Field label="Sort" className="w-48">
          <Select
            aria-label="Estimates sort"
            value={sort}
            onChange={(event) => onSortChange(event.target.value)}
          >
            {sortOptions.map((option) => (
              <option key={option.key} value={option.key}>
                {option.label}
              </option>
            ))}
          </Select>
        </Field>
      </TableToolbar>
      <p className="text-ui-caption text-ink-secondary">
        Search, sorting, and page counts apply to the loaded estimates.
      </p>
    </div>
  );
}

function estimateTableSortOptions(prioritySortEnabled) {
  return prioritySortEnabled
    ? [{ key: "v3", label: "Action priority" }, ...MOBILE_SORT_OPTIONS]
    : MOBILE_SORT_OPTIONS;
}

function estimateTableControlsChanged(search, filter, dateRange, sort) {
  return (
    Boolean(search.trim()) ||
    filter !== "all" ||
    dateRange !== "all" ||
    sort !== "newest"
  );
}

function EstimateLoadedScopeNote({
  enabled = true,
  truncated,
  metrics = false,
}) {
  if (!enabled || !truncated) return null;
  return (
    <div
      role="status"
      className="mb-3 px-3 py-2 rounded-sm border-hairline border-zinc-300 bg-zinc-50 text-ui-body text-ink-secondary"
    >
      {metrics
        ? "Showing the most recent estimates only — the list hit its size cap, so these KPIs may undercount older offers."
        : "Showing the most recent estimates only — the loaded list hit its size cap. Search, filters, and page counts apply to this set."}
    </div>
  );
}

function EstimateTablePagination({ enabled, loading = false, error, ...props }) {
  if (!enabled || loading || error) return null;
  return <TablePagination {...props} />;
}

function EstimatePipelineViewV2({
  deepLinkEstimateId = null,
  deepLinkToken = 0,
  tableControlsEnabled = false,
}) {
  const openMessages = useCustomerSms();
  const sendEstimateFromPipeline = useEstimateSend();
  const v3Flag = useFeatureFlag("estimates_v2_status_pills");
  const callListOn = useFeatureFlag("estimate_call_list");
  const navigate = useNavigate();
  const [estimates, setEstimates] = useState([]);
  const [estimatesTruncated, setEstimatesTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [customerPanelId, setCustomerPanelId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [dateRange, setDateRange] = useState("all");
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("newest");
  const [followUpTarget, setFollowUpTarget] = useState(null);
  const [declineTarget, setDeclineTarget] = useState(null);
  const [reasonTarget, setReasonTarget] = useState(null);
  const [auditTarget, setAuditTarget] = useState(null);
  const [acceptanceTarget, setAcceptanceTarget] = useState(null);
  const [viewErrors, setViewErrors] = useState({});
  const [engineReviewTarget, setEngineReviewTarget] = useState(null);
  const [extendTarget, setExtendTarget] = useState(null);
  const [outlineTarget, setOutlineTarget] = useState(null);
  const [pendingToggleKeys, setPendingToggleKeys] = useState(() => new Set());
  const [scheduleEstimate, setScheduleEstimate] = useState(null);
  const { lastMutation } = useIntelligenceBarActions();
  const estimatesRefresh =
    lastMutation?.domain === "estimate" ? lastMutation.id : null;
  const activeFilterRef = useRef(filter);
  activeFilterRef.current = filter;
  const estimatesRequestRef = useRef(0);
  const foregroundRequestRef = useRef(null);
  const queuedSilentRefreshRef = useRef(false);
  const refreshEstimates = useCallback(({ silent = false } = {}) => {
    if (silent && foregroundRequestRef.current !== null) {
      queuedSilentRefreshRef.current = true;
      return;
    }
    const requestId = ++estimatesRequestRef.current;
    if (!silent) {
      foregroundRequestRef.current = requestId;
      setLoading(true);
      setError(null);
    }
    const currentFilter = activeFilterRef.current;
    const fetches = [fetchEstimatePipelineRows(currentFilter)];
    if (currentFilter !== "archived") {
      // Won = won forever: archived-accepted rows ride along so the Won
      // funnel and MRR-won KPI don't shrink when old wins get archived.
      // estimateMatchesFilter keeps them out of the All list. Desktop-only —
      // the mobile list view has no KPI bar and skips this fetch.
      // Keep the full response (not just .estimates) so its truncated flag
      // isn't lost — the Won funnel / MRR-won KPI depend on these archived wins.
      fetches.push(
        adminFetch("/admin/estimates?archived=only&status=accepted&limit=all"),
      );
    }
    Promise.all(fetches)
      .then(([pipeline, archived = {}]) => {
        if (requestId !== estimatesRequestRef.current) return;
        setEstimates(
          mergeEstimateRows(pipeline.rows, archived.estimates || []),
        );
        setEstimatesTruncated(!!pipeline.truncated || !!archived.truncated);
        setError(null);
        setLoading(false);
      })
      .catch((err) => {
        if (requestId !== estimatesRequestRef.current) return;
        if (!silent) setError(err);
        setLoading(false);
      })
      .finally(() => {
        if (!silent && foregroundRequestRef.current === requestId) {
          foregroundRequestRef.current = null;
        }
        if (
          requestId === estimatesRequestRef.current &&
          foregroundRequestRef.current === null &&
          queuedSilentRefreshRef.current
        ) {
          queuedSilentRefreshRef.current = false;
          refreshEstimates({ silent: true });
        }
      });
  }, []);
  const watchCall = useCallListWatch({
    enabled: callListOn,
    estimates,
    refresh: refreshEstimates,
  });
  useEffect(() => {
    refreshEstimates();
    return () => {
      estimatesRequestRef.current += 1;
    };
  }, [filter, refreshEstimates, estimatesRefresh]);
  const archiveEstimate = useCallback(
    async (e) => {
      if (
        !confirm(
          `Archive this ${e.status} estimate? It stays accessible under the Archived filter.`,
        )
      )
        return;
      try {
        await adminFetch(`/admin/estimates/${e.id}/archive`, {
          method: "POST",
        });
        refreshEstimates();
      } catch (err) {
        alert("Archive failed: " + err.message);
      }
    },
    [refreshEstimates],
  );
  const unarchiveEstimate = useCallback(
    async (e) => {
      try {
        await adminFetch(`/admin/estimates/${e.id}/unarchive`, {
          method: "POST",
        });
        refreshEstimates();
      } catch (err) {
        alert("Unarchive failed: " + err.message);
      }
    },
    [refreshEstimates],
  );
  const patchEstimateToggle = useCallback(
    async (estimate, field, value) => {
      const key = `${estimate.id}:${field}`;
      if (pendingToggleKeys.has(key)) return false;
      setPendingToggleKeys((prev) => new Set(prev).add(key));
      try {
        await adminFetch(`/admin/estimates/${estimate.id}`, {
          method: "PATCH",
          body: JSON.stringify({ [field]: value }),
        });
        setEstimates((prev) =>
          prev.map((est) =>
            est.id === estimate.id
              ? {
                  ...est,
                  [field]: value,
                }
              : est,
          ),
        );
        return true;
      } finally {
        setPendingToggleKeys((prev) => {
          const next = new Set(prev);
          next.delete(key);
          return next;
        });
      }
    },
    [pendingToggleKeys],
  );
  const isEstimateTogglePending = useCallback(
    (estimateId, field) => pendingToggleKeys.has(`${estimateId}:${field}`),
    [pendingToggleKeys],
  );
  const togglePriority = useCallback(
    async (e) => {
      const newVal = !e.isPriority;
      try {
        await patchEstimateToggle(e, "isPriority", newVal);
      } catch (err) {
        alert(`Failed to update priority: ${err.message}`);
      }
    },
    [patchEstimateToggle],
  );
  const toggleOneTimeOption = useCallback(
    async (e) => {
      const newVal = !e.showOneTimeOption;
      try {
        await patchEstimateToggle(e, "showOneTimeOption", newVal);
      } catch (err) {
        alert(`Failed to update one-time option: ${err.message}`);
      }
    },
    [patchEstimateToggle],
  );
  const toggleBillByInvoice = useCallback(
    async (e) => {
      const newVal = !e.billByInvoice;
      if (
        newVal &&
        !window.confirm(
          "Invoice mode: when the customer accepts, an invoice due immediately will be created and pay-link delivery will be attempted — no onboarding or payment method up front.\n\nContinue?",
        )
      )
        return;
      try {
        await patchEstimateToggle(e, "billByInvoice", newVal);
      } catch (err) {
        alert(`Failed to update invoice mode: ${err.message}`);
      }
    },
    [patchEstimateToggle],
  );
  const markEstimateAccepted = useCallback(
    async (e) => {
      // A commercial proposal win auto-creates the customer when none is linked.
      // It makes no invoice: each visit bills when it is completed.
      const proposalInvoiceMode = !!e.isCommercialProposal && !!e.billByInvoice;
      const confirmMsg = proposalInvoiceMode
        ? `Mark ${e.customerName || "this proposal"} as won?\n\nThis stamps the proposal as won and creates the customer if none is linked. No invoice is created now: each visit is billed once when it is completed, including any one-time work booked on it. The customer is NOT texted and NOT auto-scheduled.`
        : e.isCommercialProposal
          ? `Mark ${e.customerName || "this proposal"} as won?\n\nThis stamps the proposal as won and creates the customer if none is linked. The customer is NOT texted, NOT auto-scheduled, and NO invoice is created — bill it from the proposal when ready.`
          : `Mark ${e.customerName || "this customer"} as accepted from a verbal yes?\n\nThis stamps the estimate as won for the funnel and activates the customer. The customer is NOT texted, NOT auto-scheduled, and NO setup or annual prepay invoice is created — use the customer link for annual prepay, or schedule the visit on the calendar and draft any invoice manually.`;
      if (!window.confirm(confirmMsg)) return;
      try {
        const result = await adminFetch(`/admin/estimates/${e.id}/mark-accepted`, {
          method: "POST",
          body: JSON.stringify({ source: "verbal_yes" }),
        });
        refreshEstimates();
        const notes = [];
        if (result?.createdCustomer?.id) {
          notes.push("A new customer record was created from the proposal.");
        }
        if (result?.warnings?.length) notes.push(...result.warnings);
        if (notes.length) window.alert(`Marked won:\n\n${notes.join("\n")}`);
      } catch (err) {
        window.alert("Mark accepted failed: " + err.message);
      }
    },
    [refreshEstimates],
  );
  const markEstimateAnnualPrepayAccepted = useCallback(
    async (e) => {
      const annualAmount =
        e.annualTotal > 0 ? e.annualTotal : (e.monthlyTotal || 0) * 12;
      if (
        !window.confirm(
          `Mark ${e.customerName || "this customer"} as accepted for annual prepay?\n\nThis activates the customer, creates a pending annual prepay invoice${annualAmount > 0 ? ` for about $${annualAmount.toFixed(2)}` : ""}, and creates the renewal term. The customer is NOT texted, NOT emailed, and NOT auto-scheduled.`,
        )
      )
        return;
      try {
        const result = await adminFetch(`/admin/estimates/${e.id}/mark-accepted`, {
          method: "POST",
          body: JSON.stringify({
            source: "verbal_annual_prepay",
            billingTerm: "prepay_annual",
          }),
        });
        refreshEstimates();
        if (result?.warnings?.length) {
          window.alert(
            `Marked annual prepay accepted, but:\n\n${result.warnings.join("\n")}`,
          );
        }
      } catch (err) {
        alert(`Failed to mark annual prepay accepted: ${err.message}`);
      }
    },
    [refreshEstimates],
  );
  const sendBookingLink = useCallback(
    async (e) => {
      if (!e.customerPhone) {
        window.alert(
          "No phone on file for this estimate — can't text a booking link.",
        );
        return;
      }
      if (
        !window.confirm(
          `Text ${e.customerName || "the customer"} a booking link so they can self-schedule?`,
        )
      )
        return;
      try {
        await adminFetch(`/admin/estimates/${e.id}/send-booking-link`, {
          method: "POST",
        });
        refreshEstimates();
      } catch (err) {
        window.alert("Send booking link failed: " + err.message);
      }
    },
    [refreshEstimates],
  );

  // Classify + sort newest-first so the most recent estimates stay at the top.
  // Computed (with the deep-link hook) before the loading/error early returns
  // so the hooks below always run in the same order — `estimates` is [] while
  // loading, so this is cheap and the hook no-ops until rows arrive.
  const classified = estimates.map((e) => ({
    ...e,
    _class: classifyEstimateForPipeline(e),
  }));
  const sortOptions = estimateTableSortOptions(v3Flag);
  const sorted = [...classified].sort(
    estimateTableSortFn(sort, tableControlsEnabled),
  );
  const filteredRows = sorted
    .filter((e) => estimateMatchesFilter(e, filter))
    .filter((e) => estimateMatchesTableSearch(e, search));
  // GATE_ESTIMATE_CALL_LIST: the Call today list runs oldest open first, whatever the table sort.
  const filtered =
    callListOn && filter === "call_today"
      ? sortOldestEngagementFirst(filteredRows)
      : filteredRows;
  const paging = useEstimateTablePaging(
    filtered,
    tableControlsEnabled,
    25,
    deepLinkEstimateId,
    deepLinkToken,
  );
  const highlightId = useEstimateDeepLinkHighlight({
    targetId: deepLinkEstimateId,
    token: deepLinkToken,
    rows: paging.displayedRows,
  });
  if (loading) {
    return (
      <div className="p-10 text-center text-ui-body text-ink-secondary">
        Loading estimates…
      </div>
    );
  }
  if (error) {
    return (
      <div className="p-10 text-center">
        {" "}
        <div className="text-14 text-alert-fg mb-3">
          Failed to load estimates
        </div>{" "}
        <div className="text-ui-body text-ink-tertiary mb-4">
          {error.message || String(error)}
        </div>{" "}
        <Button variant="primary" onClick={() => refreshEstimates()}>
          Retry
        </Button>{" "}
        {filter !== "all" && (
          <Button variant="secondary" onClick={() => setFilter("all")}>
            Show all estimates
          </Button>
        )}
      </div>
    );
  }
  return (
    <div>
      {followUpTarget && (
        <FollowUpModalV2
          estimate={followUpTarget}
          onClose={() => setFollowUpTarget(null)}
          onSent={() => {
            setFollowUpTarget(null);
            refreshEstimates();
          }}
        />
      )}
      {declineTarget && (
        <DeclineModalV2
          estimate={declineTarget}
          onClose={() => setDeclineTarget(null)}
          onSaved={() => {
            setDeclineTarget(null);
            refreshEstimates();
          }}
        />
      )}
      {reasonTarget && (
        <DeclineModalV2
          estimate={reasonTarget}
          reasonOnly
          onClose={() => setReasonTarget(null)}
          onSaved={() => {
            setReasonTarget(null);
            refreshEstimates();
          }}
        />
      )}
      {extendTarget && (
        <ExtendEstimateModalV2
          estimate={extendTarget}
          onClose={() => setExtendTarget(null)}
          onExtended={() => {
            setExtendTarget(null);
            refreshEstimates();
          }}
        />
      )}
      {auditTarget && (
        <EstimatePricingAuditModal
          estimate={auditTarget.estimate || auditTarget}
          initialFocus={auditTarget.focus || "all"}
          onClose={() => setAuditTarget(null)}
        />
      )}
      {acceptanceTarget && (
        <AcceptanceRecordDialog
          estimate={acceptanceTarget}
          onClose={() => setAcceptanceTarget(null)}
        />
      )}
      {engineReviewTarget && (
        <EngineReviewModal
          estimate={engineReviewTarget}
          onClose={() => setEngineReviewTarget(null)}
        />
      )}

      {outlineTarget && (
        <ServiceOutlineComposerModal
          estimate={outlineTarget}
          adminFetch={adminFetch}
          onClose={() => setOutlineTarget(null)}
        />
      )}

      {scheduleEstimate && (
        <CreateAppointmentModal
          open
          onClose={() => setScheduleEstimate(null)}
          onChange={(appointment, outcome = {}) => {
            if (!outcome.background) setScheduleEstimate(null);
            refreshEstimates({ silent: !!outcome.background });
          }}
          defaultCustomer={{
            id: scheduleEstimate.customerId,
            first_name:
              (scheduleEstimate.customerName || "").split(" ")[0] || "",
            last_name:
              (scheduleEstimate.customerName || "")
                .split(" ")
                .slice(1)
                .join(" ") || "",
            phone: scheduleEstimate.customerPhone || "",
            email: scheduleEstimate.customerEmail || "",
          }}
          defaultEstimateId={scheduleEstimate.id}
        />
      )}

      <div className="grid gap-4 items-start grid-cols-1">
        <div className="min-w-0">
          <EstimateLoadedScopeNote truncated={estimatesTruncated} metrics />
          <PipelineAnalytics
            estimates={estimates}
            activeFilter={filter}
            onFilterChange={(nextFilter) => {
              setFilter(nextFilter);
              paging.setPage(1);
            }}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
            callListEnabled={callListOn}
          />
          <WinLossSlicesCard />
          <SourcePerformanceCard />
          {/* Search — name / address / phone / email / reference. Sits
              under the Needs Attention strip so the operator can drill
              from "Going cold > 48h" into a specific customer fast. */}
          <EstimateTableControls
            enabled={tableControlsEnabled}
            search={search}
            onSearchChange={(value) => {
              setSearch(value);
              paging.setPage(1);
            }}
            sort={sort}
            onSortChange={(value) => {
              setSort(value);
              paging.setPage(1);
            }}
            sortOptions={sortOptions}
            onReset={() => {
              setSearch("");
              setFilter("all");
              setDateRange("all");
              setSort("newest");
              paging.setPage(1);
            }}
            canReset={estimateTableControlsChanged(
              search,
              filter,
              dateRange,
              sort,
            )}
          />
          <div hidden={tableControlsEnabled} className="mb-3 relative">
            {" "}
            <Input
              type="search"
              value={search}
              onChange={(ev) => setSearch(ev.target.value)}
              placeholder="Search by customer name, address, phone, email, or #ref"
              aria-label="Search estimates"
              className="w-full pl-10 pr-10"
            />{" "}
            <span
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary pointer-events-none"
              aria-hidden
            >
              {" "}
              <SlidersHorizontal size={16} strokeWidth={1.75} />{" "}
            </span>
            {search && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 h-9 w-9 -translate-y-1/2 px-0"
              >
                {" "}
                <X size={14} strokeWidth={1.75} aria-hidden />{" "}
              </Button>
            )}{" "}
          </div>
          {/* Estimates list */}
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-ui-body text-ink-secondary">
              No estimates{" "}
              {filter !== "all"
                ? `in "${estimateFilterLabel(filter) || filter}"`
                : "yet"}
              . Create or send an estimate before it appears here.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {paging.displayedRows.map((e) => {
                const urgency = getUrgencyIndicator(e);
                const competitor = detectCompetitor(e.notes || e.description);
                const source = SOURCE_ICON[e.source];
                const amount = estimatePriceDisplay(e);
                const canSend = canSendEstimate(e);
                return (
                  <Card
                    key={e.id}
                    data-estimate-id={e.id}
                    className={cn(
                      "p-4 flex flex-wrap items-center gap-3 relative",
                      e.isPriority && "border-alert-fg",
                      String(e.id) === String(highlightId) &&
                        "ring-2 ring-zinc-500 ring-offset-2 ring-offset-white transition-shadow",
                    )}
                  >
                    {e.isPriority && (
                      <div className="absolute -top-px right-4 bg-alert-fg text-white text-ui-body uppercase tracking-label font-medium px-2 py-0.5 rounded-b-xs">
                        Urgent
                      </div>
                    )}
                    {v3Flag ? (
                      <StatusPillV3 status={e.status} />
                    ) : (
                      <StatusBadgeV2 status={e.status} />
                    )}
                    {/* Customer info */}
                    <div className="flex-1 min-w-[150px]">
                      {" "}
                      <div className="flex items-center gap-2 flex-wrap">
                        {e.customerId ? (
                          <Button
                            type="button"
                            variant="ghost"
                            onClick={(evt) => {
                              evt.stopPropagation();
                              setCustomerPanelId(e.customerId);
                            }}
                            className="h-auto justify-start p-0 text-left"
                            title="Open customer + estimate history"
                          >
                            {e.customerName || "Unknown"}
                          </Button>
                        ) : (
                          <span className="text-14 sm:text-14 font-medium text-zinc-900">
                            {e.customerName || "Unknown"}
                          </span>
                        )}
                        {source && (
                          <span
                            title={source.title}
                            className="inline-flex text-ink-tertiary"
                          >
                            {" "}
                            <source.Icon
                              size={14}
                              strokeWidth={1.75}
                              aria-hidden
                            />{" "}
                          </span>
                        )}
                        <UrgencyBadge urgency={urgency} />
                        {competitor && (
                          <Badge
                            tone="neutral"
                            title={`Switching from ${competitor}`}
                          >
                            Switching from: {competitor}
                          </Badge>
                        )}
                        {e.declineReason && (
                          <Badge tone="alert">{e.declineReason}</Badge>
                        )}
                        <PricingRiskBadges
                          risk={e.pricingRisk}
                          onMissingCogs={() =>
                            setAuditTarget({
                              estimate: e,
                              focus: "missing_cogs",
                            })
                          }
                          onLowMargin={() =>
                            setAuditTarget({
                              estimate: e,
                              focus: "low_margin",
                            })
                          }
                        />
                        <AutomationStatusBadge automation={e.automation} />
                        {(e.estimatorEngine || e.agentDraftReview) && (
                          <EngineReviewBadge
                            engine={e.estimatorEngine}
                            agentReview={e.agentDraftReview}
                            onOpen={() => setEngineReviewTarget(e)}
                          />
                        )}
                        {e.riskTypeNeedsReview && (
                          <>
                            {" "}
                            <Badge
                              tone="alert"
                              title="Set the commercial business type — it drives the pest/rodent service cadence."
                            >
                              Risk Type
                            </Badge>
                          </>
                        )}
                        <LawnOutlineStatusBadge
                          outline={e.lawnServiceOutline}
                        />
                        {e.confirmedAppointment && (
                          <Badge
                            tone="neutral"
                            title={
                              e.confirmedAppointment.linked
                                ? `This call also booked an appointment on ${formatApptShort(e.confirmedAppointment)} — review the schedule before sending a fresh quote.`
                                : `Customer already has a confirmed appointment on ${formatApptShort(e.confirmedAppointment)}.`
                            }
                          >
                            {" "}
                            <CalendarCheck
                              size={11}
                              strokeWidth={1.75}
                              aria-hidden
                            />
                            {e.confirmedAppointment.linked
                              ? "Already scheduled"
                              : "Has appointment"}{" "}
                            · {formatApptShort(e.confirmedAppointment)}
                          </Badge>
                        )}
                      </div>{" "}
                      <div className="text-ui-body sm:text-ui-body text-ink-secondary mt-0.5 truncate">
                        {e.address || "—"}
                        {e.serviceInterest ? ` · ${e.serviceInterest}` : ""}
                      </div>{" "}
                      <EstimateSoldByRow estimate={e} onChanged={refreshEstimates} />
                    </div>
                    {/* Call + text + send-estimate trailing buttons — matches the
                     CustomersPageV2 list row's icon trio. Send is shown for
                     states where it's a real action (draft / sent / viewed);
                     accepted/declined/expired hide it. */}
                    {(e.customerPhone ||
                      estimateHasLawnLine(e) ||
                      (SEND_ACTION_STATUSES.includes(e.status) &&
                        canSend)) && (
                      <div className="flex gap-1.5">
                        <LawnOutlineQuickButton
                          estimate={e}
                          onClick={setOutlineTarget}
                          compact
                        />
                        {e.customerPhone && (
                          <Button
                            type="button"
                            onClick={async (evt) => {
                              evt.stopPropagation();
                              if (
                                !window.confirm(
                                  `Call ${e.customerName || "customer"} at ${e.customerPhone}?\n\nWaves will call your phone first — press 1 to connect.`,
                                )
                              )
                                return;
                              try {
                                const r = await adminFetch(
                                  "/admin/communications/call",
                                  {
                                    method: "POST",
                                    body: JSON.stringify({
                                      to: e.customerPhone,
                                      fromNumber: "+19412975749",
                                      customerIdHint: e.customerId || undefined,
                                    }),
                                  },
                                );
                                if (!r?.success)
                                  alert(
                                    "Call failed: " +
                                      (r?.error || "unknown error"),
                                  );
                                else if (callListOn && isCallTodayEstimate(e))
                                  watchCall(e.id);
                              } catch (err) {
                                alert("Call failed: " + err.message);
                              }
                            }}
                            aria-label={`Call ${e.customerName || "customer"} via Waves`}
                            title="Call via Waves — rings your phone first, press 1 to connect"
                            className="ui-icon-action inline-flex h-11 w-11 items-center justify-center sm:h-9 sm:w-9"
                          >
                            {" "}
                            <Phone size={16} strokeWidth={1.75} />{" "}
                          </Button>
                        )}
                        {e.customerPhone && (
                          <Button
                            type="button"
                            onClick={(evt) => {
                              evt.stopPropagation();
                              void openEstimateMessages(e, openMessages);
                            }}
                            aria-label={`Message ${e.customerName || "customer"}`}
                            title={`Message ${e.customerPhone}`}
                            className="ui-icon-action inline-flex h-11 w-11 items-center justify-center sm:h-9 sm:w-9"
                          >
                            {" "}
                            <MessageSquare size={16} strokeWidth={1.75} />{" "}
                          </Button>
                        )}
                        {/* Create-estimate icon — carries customer fields into the
                         new-estimate form via query string. Always shown when
                         we have a customerId so the operator can start a
                         follow-up quote without leaving the list. */}
                        {e.customerId && (
                          <Button
                            type="button"
                            onClick={(evt) => {
                              evt.stopPropagation();
                              const params = new URLSearchParams();
                              params.set("customerId", e.customerId);
                              if (e.address) params.set("address", e.address);
                              if (e.customerName)
                                params.set("customerName", e.customerName);
                              if (e.customerPhone)
                                params.set("customerPhone", e.customerPhone);
                              if (e.customerEmail)
                                params.set("customerEmail", e.customerEmail);
                              navigate(`/admin/estimates?${params.toString()}`);
                            }}
                            aria-label={`Create new estimate for ${e.customerName || "customer"}`}
                            title="Create a new estimate for this customer"
                            className="ui-icon-action inline-flex h-11 w-11 items-center justify-center sm:h-9 sm:w-9"
                          >
                            {" "}
                            <FilePlus2 size={16} strokeWidth={1.75} />{" "}
                          </Button>
                        )}
                        {SEND_ACTION_STATUSES.includes(e.status) &&
                          canSend && (
                            <Button
                              type="button"
                              onClick={async (evt) => {
                                evt.stopPropagation();
                                try {
                                  await sendEstimateFromPipeline(e.id);
                                  refreshEstimates();
                                } catch (err) {
                                  window.alert("Send failed: " + err.message);
                                }
                              }}
                              aria-label={`${sendActionVerb(e.status)} estimate to ${e.customerName || "customer"}`}
                              title={
                                e.status === "draft"
                                  ? "Review recipient and send estimate"
                                  : e.status === "send_failed"
                                    ? "The last send failed. Review recipient and send again"
                                    : "Review recipient and resend estimate"
                              }
                              className="ui-icon-action inline-flex h-11 w-11 items-center justify-center sm:h-9 sm:w-9"
                            >
                              {" "}
                              <Send size={16} strokeWidth={1.75} />{" "}
                            </Button>
                          )}
                      </div>
                    )}
                    {e.tier && <Badge tone="neutral">{e.tier}</Badge>}
                    {/* Estimate amount */}
                    <div className="text-right min-w-[80px] max-w-[260px]">
                      {" "}
                      <div
                        className={cn(
                          "text-18 font-medium u-nums",
                          amount.value > 0
                            ? "text-zinc-900"
                            : "text-ink-tertiary",
                        )}
                      >
                        {amount.lead}
                        <span className="text-ui-body font-normal text-ink-tertiary">
                          {amount.suffix}
                        </span>{" "}
                      </div>{" "}
                      {amount.secondary.map((line) => (
                        <div
                          key={line}
                          className="text-ui-body font-normal text-ink-tertiary"
                        >
                          {line}
                        </div>
                      ))}
                    </div>
                    {/* Timeline */}
                    <div className="text-right min-w-[110px] text-ui-body text-ink-secondary space-y-0.5">
                      {" "}
                      <div>Created {fmtDate(e.createdAt)}</div>
                      {e.scheduledAt && (
                        <div>Scheduled {fmtDate(e.scheduledAt)}</div>
                      )}
                      {e.sentAt && <div>Sent {timeAgo(e.sentAt)}</div>}
                      {e.viewedAt && (
                        <div>
                          Viewed {timeAgo(e.viewedAt)}
                          {e.viewCount > 1 && ` · ${e.viewCount}×`}
                        </div>
                      )}
                      {e.lastViewedAt && e.viewCount > 1 && (
                        <div>Last viewed {timeAgo(e.lastViewedAt)}</div>
                      )}
                      {e.clickCount > 0 && (
                        <div>
                          Clicked {timeAgo(e.lastClickedAt)}
                          {e.clickCount > 1 && ` · ${e.clickCount}×`}
                        </div>
                      )}
                      {e.acceptedAt && (
                        <div>Accepted {timeAgo(e.acceptedAt)}</div>
                      )}
                      {e.declinedAt && (
                        <div>Declined {timeAgo(e.declinedAt)}</div>
                      )}
                      {e.followUpCount > 0 && (
                        <div>Follow-ups: {e.followUpCount}</div>
                      )}
                      {callListOn && e.lastCalledAt && (
                        <div>Called {timeAgo(e.lastCalledAt)}</div>
                      )}
                    </div>
                    {/* Actions — flag toggle + primary status action(s) +
                     overflow menu. Secondary tools (toggles, audit, preview,
                     copy link, resend, archive, delete) live in the overflow
                     so the inline row stays scannable. */}
                    <div className="flex items-center gap-1.5 w-full sm:w-auto">
                      {" "}
                      <Button
                        type="button"
                        variant={e.isPriority ? "danger" : "secondary"}
                        onClick={() => togglePriority(e)}
                        disabled={isEstimateTogglePending(e.id, "isPriority")}
                        title={
                          e.isPriority ? "Remove priority" : "Flag as urgent"
                        }
                        aria-label={
                          e.isPriority ? "Remove priority" : "Flag as urgent"
                        }
                        className={cn(
                          "h-11 w-11 shrink-0 px-0 sm:h-9 sm:w-9",
                          isEstimateTogglePending(e.id, "isPriority") &&
                            "cursor-wait opacity-60",
                        )}
                      >
                        {" "}
                        <Flag size={16} strokeWidth={1.75} aria-hidden />{" "}
                      </Button>{" "}
                      <div className="grid grid-cols-2 sm:flex sm:flex-none gap-1.5 flex-1 sm:flex-none">
                        {(e.status === "draft" || e.status === "send_failed") &&
                          canSend && (
                          <Button
                            size="sm"
                            variant="primary"
                            className="w-full sm:w-auto whitespace-nowrap"
                            onClick={async () => {
                              try {
                                await sendEstimateFromPipeline(e.id);
                                refreshEstimates();
                              } catch (err) {
                                window.alert("Send failed: " + err.message);
                              }
                            }}
                          >
                            {sendActionVerb(e.status)}
                          </Button>
                        )}

                        {callListOn && isPickReasonEstimate(e) && (
                          <Button
                            size="sm"
                            variant="primary"
                            className="w-full sm:w-auto whitespace-nowrap"
                            onClick={() => setReasonTarget(e)}
                          >
                            Pick reason
                          </Button>
                        )}

                        {(e.status === "sent" || e.status === "viewed") && (
                          <Button
                            size="sm"
                            variant="primary"
                            className="w-full sm:w-auto whitespace-nowrap"
                            onClick={() => setFollowUpTarget(e)}
                          >
                            Follow Up
                          </Button>
                        )}

                        {/* Schedule a verbal "yes" before formal acceptance: books
                            the visit and records the win on book (POST /admin/schedule
                            accept-on-book). For a lead's quote (no customer yet) the
                            modal stages the customer from the quote's contact and the
                            estimate is attached to them on book. */}
                        {(e.status === "sent" || e.status === "viewed") &&
                          !e.archivedAt && (
                            <Button
                              size="sm"
                              variant="secondary"
                              className="w-full sm:w-auto whitespace-nowrap"
                              onClick={() => setScheduleEstimate(e)}
                            >
                              <CalendarPlus
                                size={14}
                                strokeWidth={1.75}
                                className="mr-1"
                              />
                              Schedule
                            </Button>
                          )}

                        {canMarkEstimateWon(e) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full sm:w-auto whitespace-nowrap"
                            onClick={() => markEstimateAccepted(e)}
                          >
                            Mark Won
                          </Button>
                        )}

                        {canMarkEstimateAnnualPrepay(e) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full sm:w-auto whitespace-nowrap"
                            onClick={() => markEstimateAnnualPrepayAccepted(e)}
                          >
                            Annual Prepay
                          </Button>
                        )}

                        {e.status === "accepted" && !e.archivedAt && (
                          <>
                            <Button
                              size="sm"
                              variant="primary"
                              className="w-full sm:w-auto whitespace-nowrap"
                              onClick={() => setScheduleEstimate(e)}
                            >
                              <CalendarPlus
                                size={14}
                                strokeWidth={1.75}
                                className="mr-1"
                              />
                              Schedule
                            </Button>
                            {/* The server's verdict: recurring-only and invoice-mode
                                offers never take a booking link. */}
                            {e.bookingLinkEligible === true && (
                              <Button
                                size="sm"
                                variant="secondary"
                                className="w-full sm:w-auto whitespace-nowrap"
                                onClick={() => sendBookingLink(e)}
                                disabled={!e.customerPhone}
                                title={
                                  e.customerPhone
                                    ? "Text the customer a link to self-schedule"
                                    : "No phone on file"
                                }
                              >
                                Send Booking
                              </Button>
                            )}
                          </>
                        )}

                        {e.archivedAt && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full sm:w-auto whitespace-nowrap"
                            onClick={() => unarchiveEstimate(e)}
                          >
                            Unarchive
                          </Button>
                        )}

                        <RowActionsMenu
                          label={`Actions for ${e.customerName || "estimate"}`}
                          items={[
                            canEditEstimateInPlace(e) && {
                              key: "edit",
                              label: "Edit estimate",
                              icon: <Pencil size={16} strokeWidth={1.75} />,
                              title:
                                "Reopen in the builder — saving updates this estimate and its existing customer link",
                              onClick: () =>
                                navigate(
                                  `/admin/estimates?editEstimateId=${e.id}`,
                                ),
                            },
                            ["draft", "sent", "viewed"].includes(e.status) && {
                              key: "one-time",
                              label: e.showOneTimeOption
                                ? "1× Option: On"
                                : "1× Option: Off",
                              icon: e.showOneTimeOption ? (
                                <Check size={16} strokeWidth={1.75} />
                              ) : (
                                <Plus size={16} strokeWidth={1.75} />
                              ),
                              title: e.showOneTimeOption
                                ? "One-time option is visible to the customer"
                                : "Let the customer pick one-time instead of recurring",
                              disabled: isEstimateTogglePending(
                                e.id,
                                "showOneTimeOption",
                              ),
                              onClick: () => toggleOneTimeOption(e),
                            },
                            ["draft", "sent", "viewed"].includes(e.status) && {
                              key: "invoice",
                              label: e.billByInvoice
                                ? "Invoice mode: On"
                                : "Invoice mode: Off",
                              icon: e.billByInvoice ? (
                                <Check size={16} strokeWidth={1.75} />
                              ) : (
                                <Plus size={16} strokeWidth={1.75} />
                              ),
                              title: e.billByInvoice
                                ? "Customer acceptance creates an invoice immediately"
                                : "Switch to invoice mode (skip onboarding, invoice on accept)",
                              disabled: isEstimateTogglePending(
                                e.id,
                                "billByInvoice",
                              ),
                              onClick: () => toggleBillByInvoice(e),
                            },
                            (e.status === "sent" || e.status === "viewed") &&
                              canSend &&
                              e.bookingLinkEligible === true && {
                                key: "send-booking",
                                label: "Send booking link",
                                icon: (
                                  <CalendarCheck size={16} strokeWidth={1.75} />
                                ),
                                disabled: !e.customerPhone,
                                title: e.customerPhone
                                  ? "Text the customer a link to self-schedule"
                                  : "No phone on file",
                                onClick: () => sendBookingLink(e),
                              },
                            ["sent", "viewed", "expired"].includes(
                              e.status,
                            ) && {
                              key: "extend",
                              label:
                                e.status === "expired"
                                  ? "Reopen + extend"
                                  : "Extend estimate",
                              icon: (
                                <CalendarCheck size={16} strokeWidth={1.75} />
                              ),
                              onClick: () => setExtendTarget(e),
                            },
                            (e.status === "sent" || e.status === "viewed") &&
                              canSend && {
                                key: "resend",
                                label: "Resend estimate",
                                icon: <RotateCw size={16} strokeWidth={1.75} />,
                                onClick: async () => {
                                  try {
                                    await sendEstimateFromPipeline(e.id);
                                    refreshEstimates();
                                  } catch (err) {
                                    window.alert("Send failed: " + err.message);
                                  }
                                },
                              },
                            canMarkEstimateAnnualPrepay(e) && {
                              key: "annual-prepay",
                              label: "Mark annual prepay",
                              icon: <DollarSign size={16} strokeWidth={1.75} />,
                              onClick: () =>
                                markEstimateAnnualPrepayAccepted(e),
                            },
                            (e.status === "sent" || e.status === "viewed") &&
                              // Rows without a share token have no customer
                              // link — /estimate/<id> 404s for customers, so
                              // never offer that as a copyable fallback.
                              Boolean(e.token) && {
                                key: "copy-link",
                                label: "Copy estimate link",
                                icon: <LinkIcon size={16} strokeWidth={1.75} />,
                                onClick: () => {
                                  const link = `${window.location.origin}/estimate/${e.token}`;
                                  navigator.clipboard?.writeText(link);
                                },
                              },
                            estimateHasLawnLine(e) && {
                              key: "lawn-outline",
                              label: "Lawn service outline",
                              icon: (
                                <ClipboardList size={16} strokeWidth={1.75} />
                              ),
                              onClick: () => setOutlineTarget(e),
                            },
                            // GATE_TS_OUTLINE: the server marks an estimate with a Tree & Shrub line.
                            e.treeShrubOutlineAvailable && {
                              key: "tree-shrub-outline",
                              label: "Tree & Shrub service outline",
                              icon: (
                                <ClipboardList size={16} strokeWidth={1.75} />
                              ),
                              onClick: () =>
                                setOutlineTarget({
                                  ...e,
                                  outlineServiceLine: "tree_shrub",
                                }),
                            },
                            // GATE_PEST_OUTLINE: the server marks an estimate with a recurring pest line.
                            e.pestOutlineAvailable && {
                              key: "pest-outline",
                              label: "Pest service outline",
                              icon: (
                                <ClipboardList size={16} strokeWidth={1.75} />
                              ),
                              onClick: () =>
                                setOutlineTarget({
                                  ...e,
                                  outlineServiceLine: "pest_control",
                                }),
                            },
                            // GATE_MOSQUITO_OUTLINE: the server marks an estimate with a recurring mosquito program row.
                            e.mosquitoOutlineAvailable && {
                              key: "mosquito-outline",
                              label: "Mosquito service outline",
                              icon: (
                                <ClipboardList size={16} strokeWidth={1.75} />
                              ),
                              onClick: () =>
                                setOutlineTarget({
                                  ...e,
                                  outlineServiceLine: "mosquito",
                                }),
                            },
                            {
                              key: "proposal",
                              label: "Commercial proposal",
                              icon: <FileText size={16} strokeWidth={1.75} />,
                              title:
                                "Build a multi-building line-item proposal PDF",
                              onClick: () =>
                                navigate(`/admin/estimates/${e.id}/proposal`),
                            },
                            {
                              key: "audit",
                              label: "Audit pricing",
                              icon: (
                                <SlidersHorizontal
                                  size={16}
                                  strokeWidth={1.75}
                                />
                              ),
                              onClick: () =>
                                setAuditTarget({
                                  estimate: e,
                                  focus: "all",
                                }),
                            },
                            ...estimateViewMenuItems(e, {
                              onPdfError: (message) =>
                                setViewErrors((prev) => ({
                                  ...prev,
                                  [e.id]: message,
                                })),
                              onViewAcceptance: setAcceptanceTarget,
                            }),
                            (e.status === "sent" || e.status === "viewed") && {
                              key: "mark-lost",
                              label: "Mark lost",
                              icon: <X size={16} strokeWidth={1.75} />,
                              onClick: () => setDeclineTarget(e),
                            },
                            !e.archivedAt &&
                              [
                                "sent",
                                "viewed",
                                "declined",
                                "expired",
                                "accepted",
                              ].includes(e.status) && {
                                key: "archive",
                                label: "Archive",
                                icon: <Archive size={16} strokeWidth={1.75} />,
                                onClick: () => archiveEstimate(e),
                              },
                            e.status === "draft" && {
                              key: "delete",
                              label: "Delete draft",
                              icon: <Trash2 size={16} strokeWidth={1.75} />,
                              variant: "danger",
                              onClick: async () => {
                                if (
                                  !confirm(
                                    `Delete draft estimate for ${e.customerName || "this customer"}?\n\nThis is permanent.`,
                                  )
                                )
                                  return;
                                try {
                                  await adminFetch(
                                    `/admin/estimates/${e.id}`,
                                    { method: "DELETE" },
                                  );
                                  refreshEstimates();
                                } catch (err) {
                                  alert("Delete failed: " + err.message);
                                }
                              },
                            },
                          ]}
                        />
                      </div>{" "}
                    </div>{" "}
                    <ViewErrorNote
                      message={viewErrors[e.id]}
                      className="w-full"
                    />
                  </Card>
                );
              })}
            </div>
          )}
          <EstimateTablePagination
            enabled={tableControlsEnabled}
            label="Estimates"
            page={paging.page}
            totalPages={paging.totalPages}
            total={filtered.length}
            pageSize={paging.pageSize}
            onPageChange={paging.setPage}
            onPageSizeChange={paging.changePageSize}
            itemLabel="loaded estimates"
            pageSizeOptions={ESTIMATE_TABLE_PAGE_SIZES}
          />
        </div>{" "}
      </div>
      {customerPanelId && (
        <CustomerEstimatesPanel
          customerId={customerPanelId}
          onClose={() => setCustomerPanelId(null)}
        />
      )}
    </div>
  );
}
const TABS = [
  {
    key: "leads",
    label: "Leads",
    Icon: Users,
  },
  {
    key: "estimates",
    label: "Estimates",
    Icon: ClipboardList,
  },
  {
    key: "new",
    label: "Create",
    Icon: FilePlus2,
  },
  {
    key: "pricing",
    label: "Pricing",
    Icon: SlidersHorizontal,
  },
];
const PREFILL_PARAM_KEYS = [
  "leadId",
  "customerId",
  "address",
  "customerName",
  "customerPhone",
  "customerEmail",
  "serviceInterest",
  "editEstimateId",
  "first_name",
  "last_name",
  "phone",
  "email",
  "service_interest",
];

// Mobile-only filter dimensions. FILTER reuses PIPELINE_FILTERS. DATE filters on
// createdAt relative to now. SORT controls row order; grouping is always by day.
const MOBILE_DATE_FILTERS = [
  {
    key: "all",
    label: "All",
  },
  {
    key: "today",
    label: "Today",
  },
  {
    key: "week",
    label: "This week",
  },
  {
    key: "month",
    label: "This month",
  },
  {
    key: "last30",
    label: "Last 30 days",
  },
];
const MOBILE_SORT_OPTIONS = [
  {
    key: "newest",
    label: "Newest",
  },
  {
    key: "oldest",
    label: "Oldest",
  },
  {
    key: "amount-desc",
    label: "Amount: high → low",
  },
  {
    key: "amount-asc",
    label: "Amount: low → high",
  },
];
function mobileMatchesDate(createdAt, dateKey, nowTs) {
  if (dateKey === "all") return true;
  if (!createdAt) return false;
  const ts = new Date(createdAt).getTime();
  if (Number.isNaN(ts)) return false;
  if (dateKey === "today") {
    return new Date(ts).toDateString() === new Date(nowTs).toDateString();
  }
  const MS_DAY = 86400000;
  if (dateKey === "week") return nowTs - ts <= 7 * MS_DAY;
  if (dateKey === "month" || dateKey === "last30")
    return nowTs - ts <= 30 * MS_DAY;
  return true;
}
function mobileSortFn(sortKey, tableControlsEnabled = false) {
  if (tableControlsEnabled) return estimateTableSortFn(sortKey);
  switch (sortKey) {
    case "oldest":
      return (a, b) => new Date(a.createdAt) - new Date(b.createdAt);
    case "amount-desc":
      return (a, b) => (b.monthlyTotal || 0) - (a.monthlyTotal || 0);
    case "amount-asc":
      return (a, b) => (a.monthlyTotal || 0) - (b.monthlyTotal || 0);
    case "newest":
    default:
      return (a, b) => new Date(b.createdAt) - new Date(a.createdAt);
  }
}
function mobileMatchesSearch(estimate, search, tableControlsEnabled) {
  if (tableControlsEnabled) return estimateMatchesTableSearch(estimate, search);
  const query = search.trim().toLowerCase();
  return (
    !query ||
    (estimate.customerName || "").toLowerCase().includes(query) ||
    shortEstimateRef(estimate.id).toLowerCase().includes(query)
  );
}
function mobileFilterOptions(v3Flag, filterCounts, callListOn = false) {
  return (v3Flag ? v3Chips(callListOn) : pipelineChips(callListOn)).map((item) => ({
    ...item,
    label:
      item.key === "all"
        ? `All (${filterCounts.all || 0})`
        : `${item.label} (${filterCounts[item.key] || 0})`,
  }));
}

// Short 6-char ref derived from UUID. estimates.id is a UUID (no human-readable
// sequence column exists yet); last-6 uppercased is a pragmatic display token.
function shortEstimateRef(id) {
  if (!id) return "—";
  return String(id)
    .replace(/[^a-zA-Z0-9]/g, "")
    .slice(-6)
    .toUpperCase();
}

// Bottom-sheet single-select chip. Matches FilterSheetV2 pattern but chip
// visual is lighter (zinc-100 bg, label + bold value) to match the mockup.
function MobileChipSheet({ label, value, options, onChange, title }) {
  const [open, setOpen] = useState(false);
  const active = options.find((option) => option.key === value) || options[0];
  return (
    <>
      <Button
        type="button"
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${active.label}`}
        className="gap-1.5 whitespace-nowrap"
      >
        <span className="text-ink-secondary">{label}</span>
        <span>{active.label}</span>
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        size="md"
        aria-label={title}
      >
        <DialogHeader className="flex items-center justify-between gap-3">
          <DialogTitle>{title}</DialogTitle>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            aria-label="Close"
            className="h-9 w-9 px-0"
          >
            <X size={16} strokeWidth={1.75} aria-hidden />
          </Button>
        </DialogHeader>
        <DialogBody className="p-2">
          <div className="space-y-1">
            {options.map((option) => {
              const isActive = option.key === value;
              return (
                <Button
                  key={option.key}
                  type="button"
                  variant={isActive ? "secondary" : "ghost"}
                  onClick={() => {
                    onChange(option.key);
                    setOpen(false);
                  }}
                  className="h-auto min-h-11 w-full justify-between gap-3 px-3 py-2 text-left"
                >
                  <span>{option.label}</span>
                  {isActive && <Check size={16} strokeWidth={2} aria-hidden />}
                </Button>
              );
            })}
          </div>
        </DialogBody>
      </Dialog>
    </>
  );
}

// Status label color on mobile row. Admin stays monochrome: alert = red,
// accepted = zinc-900, in-flight = ink-secondary, others ink-tertiary.
function mobileStatusClass(status) {
  if (status === "declined" || status === "expired") return "text-alert-fg";
  if (status === "accepted") return "text-zinc-900";
  if (
    status === "draft" ||
    status === "send_failed" ||
    status === "scheduled" ||
    status === "sent" ||
    status === "viewed"
  )
    return "text-ink-secondary";
  return "text-ink-tertiary";
}

// Mirrors the server's revise guard (estimateReviseBlock): archived, terminal
// (accepted/declined/expired), mid-send, and commercial-proposal rows can't be
// edited in place — proposals have their own editor (CommercialProposalModal).
// Tokenless rows (quote-wizard mirrors / legacy imports, the same set
// canSendEstimate hides) are excluded too: "edit in place" means updating the
// customer's existing link, and these rows have no link to keep stable.
// Statuses whose row offers Send: an unsent draft, a send the server parked as
// send_failed (POST /:id/send admits it again), and a live offer to resend.
const SEND_ACTION_STATUSES = ["draft", "send_failed", "sent", "viewed"];
function sendActionVerb(status) {
  if (status === "draft") return "Send";
  if (status === "send_failed") return "Retry sending";
  return "Resend";
}
const EDITABLE_ESTIMATE_STATUSES = [
  "draft",
  "scheduled",
  "sent",
  "viewed",
  "send_failed",
];
function canEditEstimateInPlace(estimate) {
  return (
    EDITABLE_ESTIMATE_STATUSES.includes(estimate.status) &&
    !!String(estimate.token || "").trim() &&
    !estimate.isCommercialProposal &&
    !estimate.archivedAt
  );
}
function canMarkEstimateWon(estimate) {
  if (!["sent", "viewed"].includes(estimate.status)) return false;
  // The server rejects any estimate with a one-time option from manual accept
  // (recurring-vs-one-time must be recorded via the customer link) — proposals
  // included. Don't offer a Mark Won that always 400s.
  if (estimate.showOneTimeOption) return false;
  // Commercial proposals are won manually even with no linked customer or in
  // invoice mode — the win auto-creates/promotes the customer and (in invoice
  // mode) builds the first invoice from the proposal lines (#1917).
  if (estimate.isCommercialProposal) return true;
  return (
    !!estimate.customerId &&
    !estimate.billByInvoice &&
    !estimate.showOneTimeOption
  );
}
function canMarkEstimateAnnualPrepay(estimate) {
  // Commercial proposals are won-eligible (above) but the server rejects
  // annualPrepaySelected for them, so never expose the Annual Prepay action for
  // a proposal — it would be a guaranteed-fail button.
  if (estimate.isCommercialProposal) return false;
  return canMarkEstimateWon(estimate) && Number(estimate.monthlyTotal || 0) > 0;
}

// One-line price on the 64px mobile card: never wraps, full text in the title.
function MobilePriceText({ text, className }) {
  return (
    <span
      className={cn(
        "u-nums min-w-0 max-w-full truncate whitespace-nowrap",
        className,
      )}
      title={text}
    >
      {text}
    </span>
  );
}
// Inline failure note for the view-estimate PDF action, desktop and mobile.
function ViewErrorNote({ message, className }) {
  if (!message) return null;
  return (
    <p role="alert" className={cn("text-ui-body text-alert-fg", className)}>
      {message}
    </p>
  );
}

// Row in the mobile list. The customer summary is one explicit button and the
// communication/action controls are siblings. Keeping the card itself
// non-interactive avoids nesting buttons and links inside a role="button" row.
export function MobileEstimateRow({
  estimate,
  onSoldByChanged,
  onCreateFromAddress,
  onOpenCustomerPanel,
  onSend,
  onMarkAccepted,
  onMarkAnnualPrepayAccepted,
  onDeleted,
  onAudit,
  onSendBooking,
  onArchive,
  onUnarchive,
  onDeleteDraft,
  onResend,
  onCopyLink,
  onExtend,
  onLawnOutline,
  onEngineReview,
  onViewAcceptance,
  v3Flag = false,
  highlighted = false,
  callListOn = false,
  onPickReason,
  onCalled,
}) {
  const navigate = useNavigate();
  const sendEstimateFromPipeline = useEstimateSend();
  const openMessages = useCustomerSms();
  const cfg = STATUS_CONFIG[estimate.status] || STATUS_CONFIG.draft;
  const amount = estimatePriceDisplay(estimate);
  const amountInline = estimatePriceInline(amount);
  const canSend = canSendEstimate(estimate);
  const [viewError, setViewError] = useState("");
  const customerName = estimate.customerName || "Unknown";
  const isDraftMuted = v3Flag && estimate.status === "draft";
  const hasCustomer = !!estimate.customerId;
  const openPanel = () => {
    if (hasCustomer) onOpenCustomerPanel?.(estimate.customerId);
  };
  return (
    <>
      <Card
        data-estimate-id={estimate.id}
        className={cn(
          "min-h-16 h-auto px-3 py-3 flex items-center gap-1.5",
          "cursor-default",
          isDraftMuted && "opacity-60",
          highlighted &&
            "ring-2 ring-zinc-500 ring-offset-2 ring-offset-white transition-shadow",
        )}
      >
        {" "}
        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
          {hasCustomer ? (
            <Button
              type="button"
              variant="ghost"
              onClick={openPanel}
              aria-label={`Open ${customerName} customer estimate history`}
              className="h-auto max-w-full justify-start truncate p-0 text-left"
            >
              {customerName}
            </Button>
          ) : (
            <span
              className="text-14 font-medium text-ink-primary truncate"
              title="This estimate isn't linked to a customer yet"
            >
              {customerName}
            </span>
          )}
          {v3Flag ? (
            <div className="flex items-center gap-2 flex-wrap">
              {" "}
              <MobilePriceText
                text={amountInline}
                className="text-ui-body text-ink-tertiary"
              />{" "}
              <StatusPillV3 status={estimate.status} />
              {estimate.viewCount > 1 && (
                <span
                  className="u-nums text-ui-body text-ink-tertiary"
                  title={
                    estimate.lastViewedAt
                      ? `Last viewed ${timeAgo(estimate.lastViewedAt)}`
                      : undefined
                  }
                >
                  {estimate.viewCount}× viewed
                </span>
              )}
              <PricingRiskBadges
                risk={estimate.pricingRisk}
                onMissingCogs={() => onAudit?.(estimate, "missing_cogs")}
                onLowMargin={() => onAudit?.(estimate, "low_margin")}
              />
              <AutomationStatusBadge automation={estimate.automation} />
              {(estimate.estimatorEngine || estimate.agentDraftReview) && (
                <EngineReviewBadge
                  engine={estimate.estimatorEngine}
                  agentReview={estimate.agentDraftReview}
                  onOpen={() => onEngineReview?.(estimate)}
                />
              )}
              {estimate.riskTypeNeedsReview && (
                <>
                  {" "}
                  <Badge
                    tone="alert"
                    title="Set the commercial business type — it drives the pest/rodent service cadence."
                  >
                    Risk Type
                  </Badge>
                </>
              )}
              <LawnOutlineStatusBadge outline={estimate.lawnServiceOutline} />
              {estimate.confirmedAppointment && (
                <span
                  className="text-ui-body text-ink-tertiary truncate"
                  title={
                    estimate.confirmedAppointment.linked
                      ? `This call also booked ${formatApptShort(estimate.confirmedAppointment)} — review the schedule before sending a fresh quote.`
                      : `Customer has a confirmed appointment ${formatApptShort(estimate.confirmedAppointment)}.`
                  }
                >
                  {" "}
                  <CalendarCheck
                    size={11}
                    strokeWidth={1.75}
                    className="inline-block align-text-top"
                    aria-hidden
                  />
                  {formatApptShort(estimate.confirmedAppointment)}
                </span>
              )}
              <span className="u-nums text-ui-body text-ink-tertiary">
                #{shortEstimateRef(estimate.id)}
              </span>{" "}
            </div>
          ) : (
            <div className="text-ui-body text-ink-tertiary truncate">
              {" "}
              <MobilePriceText
                text={amountInline}
                className="inline-block align-bottom"
              />{" "}
              <span
                className={cn(
                  "ml-2 font-medium",
                  mobileStatusClass(estimate.status),
                )}
              >
                {cfg.label}
              </span>
              {estimate.viewCount > 1 && (
                <span
                  className="ml-2 u-nums"
                  title={
                    estimate.lastViewedAt
                      ? `Last viewed ${timeAgo(estimate.lastViewedAt)}`
                      : undefined
                  }
                >
                  {estimate.viewCount}×
                </span>
              )}
              {estimate.pricingRisk?.hasRisk && (
                <span className="ml-2 text-alert-fg">
                  {estimate.pricingRisk.missingCogsCount
                    ? "Missing COGS"
                    : estimate.pricingRisk.lowMarginCount
                      ? "Low Margin"
                      : "Pricing Risk"}
                </span>
              )}
              {automationBadgeLabel(estimate.automation) && (
                <span
                  className={cn(
                    "ml-2",
                    [
                      "manual_review_required",
                      "generation_failed",
                      "blocked",
                    ].includes(estimate.automation?.status)
                      ? "text-alert-fg"
                      : "text-ink-tertiary",
                  )}
                  title={(estimate.automation?.review || []).join(" · ")}
                >
                  {automationBadgeLabel(estimate.automation)}
                </span>
              )}
              {estimate.estimatorEngine?.lane && (
                <span
                  className={cn(
                    "ml-2",
                    estimate.estimatorEngine.lane !== "green"
                      ? "text-alert-fg"
                      : "text-ink-tertiary",
                  )}
                  title={(estimate.estimatorEngine.laneReasons || []).join(
                    " · ",
                  )}
                >
                  {estimate.estimatorEngine.lane !== "green"
                    ? "AI Review"
                    : "AI Draft"}
                </span>
              )}
              {estimate.lawnServiceOutline && (
                <span
                  className={cn(
                    "ml-2",
                    estimate.lawnServiceOutline.validationStatus === "blocked"
                      ? "text-alert-fg"
                      : "text-ink-tertiary",
                  )}
                  title={`Outline ${estimate.lawnServiceOutline.status || "draft"} · ${estimate.lawnServiceOutline.validationStatus || "unchecked"}`}
                >
                  Outline{" "}
                  {estimate.lawnServiceOutline.stale
                    ? "stale"
                    : estimate.lawnServiceOutline.ctaClickCount > 0
                      ? "clicked"
                      : estimate.lawnServiceOutline.status || "draft"}
                </span>
              )}
              {estimate.confirmedAppointment && (
                <span
                  className="ml-2"
                  title={
                    estimate.confirmedAppointment.linked
                      ? `This call also booked ${formatApptShort(estimate.confirmedAppointment)} — review the schedule before sending a fresh quote.`
                      : `Customer has a confirmed appointment ${formatApptShort(estimate.confirmedAppointment)}.`
                  }
                >
                  {" "}
                  <CalendarCheck
                    size={11}
                    strokeWidth={1.75}
                    className="inline-block align-text-top"
                    aria-hidden
                  />
                  {formatApptShort(estimate.confirmedAppointment)}
                </span>
              )}
              <span className="ml-2 u-nums">
                #{shortEstimateRef(estimate.id)}
              </span>{" "}
            </div>
          )}
          <EstimateSoldByRow estimate={estimate} onChanged={onSoldByChanged} />
        </div>
        {estimate.customerPhone && (
          <Button
            type="button"
            onClick={async (e) => {
              e.stopPropagation();
              if (
                !window.confirm(
                  `Call ${estimate.customerName || "customer"} at ${estimate.customerPhone}?\n\nWaves will call your phone first — press 1 to connect.`,
                )
              )
                return;
              try {
                const r = await adminFetch("/admin/communications/call", {
                  method: "POST",
                  body: JSON.stringify({
                    to: estimate.customerPhone,
                    fromNumber: "+19412975749",
                    customerIdHint: estimate.customerId || undefined,
                  }),
                });
                if (!r?.success)
                  alert("Call failed: " + (r?.error || "unknown error"));
                else if (callListOn) onCalled?.(estimate);
              } catch (err) {
                alert("Call failed: " + err.message);
              }
            }}
            aria-label="Call via Waves"
            title="Call via Waves — rings your phone first, press 1 to connect"
            className="ui-icon-action inline-flex h-11 w-11 items-center justify-center sm:h-9 sm:w-9"
          >
            {" "}
            <Phone size={16} strokeWidth={1.75} />{" "}
          </Button>
        )}
        {estimate.customerPhone && (
          <Button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              void openEstimateMessages(estimate, openMessages);
            }}
            aria-label="SMS"
            className="ui-icon-action inline-flex h-11 w-11 items-center justify-center sm:h-9 sm:w-9"
          >
            {" "}
            <MessageSquare size={16} strokeWidth={1.75} />{" "}
          </Button>
        )}
        <LawnOutlineQuickButton
          estimate={estimate}
          onClick={onLawnOutline}
          compact
        />
        {/* Trailing actions — Call + Text (when phone) + Overflow. All
       secondary actions live in the overflow sheet so the row stays a
       single 64px scan line. */}
        <RowActionsMenu
          label={`Actions for ${customerName}`}
          items={[
            canEditEstimateInPlace(estimate) && {
              key: "edit",
              label: "Edit estimate",
              icon: <Pencil size={16} strokeWidth={1.75} />,
              title:
                "Reopen in the builder — saving updates this estimate and its existing customer link",
              onClick: () =>
                navigate(`/admin/estimates?editEstimateId=${estimate.id}`),
            },
            SEND_ACTION_STATUSES.includes(estimate.status) &&
              canSend && {
                key: "send",
                label: `${sendActionVerb(estimate.status)} estimate`,
                icon: <Send size={16} strokeWidth={1.75} />,
                onClick: async () => {
                  try {
                    await sendEstimateFromPipeline(estimate.id);
                    onSend?.();
                  } catch (err) {
                    window.alert("Send failed: " + err.message);
                  }
                },
              },
            (estimate.status === "sent" ||
              estimate.status === "viewed" ||
              (estimate.status === "accepted" && !estimate.archivedAt)) &&
              estimate.bookingLinkEligible === true && {
              key: "send-booking",
              label: "Send booking link",
              icon: <CalendarCheck size={16} strokeWidth={1.75} />,
              disabled: !estimate.customerPhone,
              title: estimate.customerPhone
                ? "Text the customer a link to self-schedule"
                : "No phone on file",
              onClick: () => onSendBooking?.(estimate),
            },
            ["sent", "viewed", "expired"].includes(estimate.status) && {
              key: "extend",
              label:
                estimate.status === "expired"
                  ? "Reopen + extend"
                  : "Extend estimate",
              icon: <CalendarCheck size={16} strokeWidth={1.75} />,
              onClick: () => onExtend?.(estimate),
            },
            callListOn &&
              isPickReasonEstimate(estimate) && {
                key: "pick-reason",
                label: "Pick reason",
                icon: <Flag size={16} strokeWidth={1.75} />,
                onClick: () => onPickReason?.(estimate),
              },
            canMarkEstimateWon(estimate) && {
              key: "mark-won",
              label: "Mark won (verbal yes)",
              icon: <Check size={16} strokeWidth={1.75} />,
              onClick: () => onMarkAccepted?.(estimate),
            },
            canMarkEstimateAnnualPrepay(estimate) && {
              key: "annual-prepay",
              label: "Mark annual prepay",
              icon: <DollarSign size={16} strokeWidth={1.75} />,
              onClick: () => onMarkAnnualPrepayAccepted?.(estimate),
            },
            (estimate.status === "sent" || estimate.status === "viewed") &&
              // Same token gate as the desktop menu — no token, no customer link.
              Boolean(estimate.token) && {
                key: "copy-link",
                label: "Copy estimate link",
                icon: <LinkIcon size={16} strokeWidth={1.75} />,
                onClick: () => onCopyLink?.(estimate),
              },
            estimateHasLawnLine(estimate) && {
              key: "lawn-outline",
              label: "Lawn service outline",
              icon: <ClipboardList size={16} strokeWidth={1.75} />,
              onClick: () => onLawnOutline?.(estimate),
            },
            // GATE_TS_OUTLINE: the same composer, opened on the Tree & Shrub outline.
            estimate.treeShrubOutlineAvailable && {
              key: "tree-shrub-outline",
              label: "Tree & Shrub service outline",
              icon: <ClipboardList size={16} strokeWidth={1.75} />,
              onClick: () =>
                onLawnOutline?.({ ...estimate, outlineServiceLine: "tree_shrub" }),
            },
            // GATE_PEST_OUTLINE: the same composer, opened on the Pest Control outline.
            estimate.pestOutlineAvailable && {
              key: "pest-outline",
              label: "Pest service outline",
              icon: <ClipboardList size={16} strokeWidth={1.75} />,
              onClick: () =>
                onLawnOutline?.({ ...estimate, outlineServiceLine: "pest_control" }),
            },
            // GATE_MOSQUITO_OUTLINE: the same composer, opened on the Mosquito outline.
            estimate.mosquitoOutlineAvailable && {
              key: "mosquito-outline",
              label: "Mosquito service outline",
              icon: <ClipboardList size={16} strokeWidth={1.75} />,
              onClick: () =>
                onLawnOutline?.({ ...estimate, outlineServiceLine: "mosquito" }),
            },
            {
              key: "audit",
              label: "Audit pricing",
              icon: <SlidersHorizontal size={16} strokeWidth={1.75} />,
              onClick: () => onAudit?.(estimate, "all"),
            },
            ...estimateViewMenuItems(estimate, {
              onPdfError: setViewError,
              onViewAcceptance,
            }),
            Boolean(estimate.estimatorEngine) && {
              key: "engine-review",
              label: "AI draft review",
              icon: <Bot size={16} strokeWidth={1.75} />,
              onClick: () => onEngineReview?.(estimate),
            },
            estimate.customerId && {
              key: "new-estimate",
              label: "New estimate for customer",
              icon: <FilePlus2 size={16} strokeWidth={1.75} />,
              onClick: () => {
                const params = new URLSearchParams();
                params.set("customerId", estimate.customerId);
                if (estimate.address) params.set("address", estimate.address);
                if (estimate.customerName)
                  params.set("customerName", estimate.customerName);
                if (estimate.customerPhone)
                  params.set("customerPhone", estimate.customerPhone);
                if (estimate.customerEmail)
                  params.set("customerEmail", estimate.customerEmail);
                navigate(`/admin/estimates?${params.toString()}`);
              },
            },
            !estimate.archivedAt &&
              ["sent", "viewed", "declined", "expired", "accepted"].includes(
                estimate.status,
              ) && {
                key: "archive",
                label: "Archive",
                icon: <Archive size={16} strokeWidth={1.75} />,
                onClick: () => onArchive?.(estimate),
              },
            estimate.archivedAt && {
              key: "unarchive",
              label: "Unarchive",
              icon: <ArrowLeft size={16} strokeWidth={1.75} />,
              onClick: () => onUnarchive?.(estimate),
            },
            estimate.status === "draft" && {
              key: "delete",
              label: "Delete draft",
              icon: <Trash2 size={16} strokeWidth={1.75} />,
              variant: "danger",
              onClick: () => onDeleteDraft?.(estimate),
            },
          ]}
        />
      </Card>
      <ViewErrorNote message={viewError} className="px-3 pt-1" />
    </>
  );
}

// Mobile estimates list — the touch-optimized counterpart to
// EstimatePipelineViewV2, rendered under the Estimates tab on mobile. Strict
// 1:1 on data + endpoint (GET /admin/estimates). The Leads, Create Estimate,
// and Pricing Logic tabs render their own sections under the shared
// PipelineCommandHeader, which now drives all four tabs on mobile too.
function EstimatesMobileListView({
  onCreateFromAddress,
  deepLinkEstimateId = null,
  deepLinkToken = 0,
  tableControlsEnabled = false,
}) {
  const sendEstimateFromPipeline = useEstimateSend();
  const v3Flag = useFeatureFlag("estimates_v2_status_pills");
  const callListOn = useFeatureFlag("estimate_call_list");
  const [reasonTarget, setReasonTarget] = useState(null);
  const [estimates, setEstimates] = useState([]);
  const [estimatesTruncated, setEstimatesTruncated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [customerPanelId, setCustomerPanelId] = useState(null);
  const [auditTarget, setAuditTarget] = useState(null);
  const [acceptanceTarget, setAcceptanceTarget] = useState(null);
  const [engineReviewTarget, setEngineReviewTarget] = useState(null);
  const [extendTarget, setExtendTarget] = useState(null);
  const [outlineTarget, setOutlineTarget] = useState(null);
  const [sort, setSort] = useState("newest");
  const { lastMutation } = useIntelligenceBarActions();
  const estimatesRefresh =
    lastMutation?.domain === "estimate" ? lastMutation.id : null;
  const activeFilterRef = useRef(filter);
  activeFilterRef.current = filter;
  const estimatesRequestRef = useRef(0);
  const refreshEstimates = useCallback(() => {
    const requestId = ++estimatesRequestRef.current;
    setError(null);
    fetchEstimatePipelineRows(activeFilterRef.current)
      .then(({ rows, truncated }) => {
        if (requestId === estimatesRequestRef.current) {
          setEstimates(rows);
          setEstimatesTruncated(!!truncated);
        }
      })
      .catch((err) => {
        if (requestId === estimatesRequestRef.current) setError(err);
      })
      .finally(() => {
        if (requestId === estimatesRequestRef.current) setLoading(false);
      });
  }, []);
  const watchCall = useCallListWatch({
    enabled: callListOn,
    estimates,
    refresh: refreshEstimates,
  });
  useEffect(() => {
    setLoading(true);
    refreshEstimates();
    // A filter change or unmount invalidates every callback of the old load.
    return () => {
      estimatesRequestRef.current += 1;
    };
  }, [filter, refreshEstimates, estimatesRefresh]);
  const markEstimateAccepted = useCallback(
    async (e) => {
      // A commercial proposal win auto-creates the customer when none is linked.
      // It makes no invoice: each visit bills when it is completed.
      const proposalInvoiceMode = !!e.isCommercialProposal && !!e.billByInvoice;
      const confirmMsg = proposalInvoiceMode
        ? `Mark ${e.customerName || "this proposal"} as won?\n\nThis stamps the proposal as won and creates the customer if none is linked. No invoice is created now: each visit is billed once when it is completed, including any one-time work booked on it. The customer is NOT texted and NOT auto-scheduled.`
        : e.isCommercialProposal
          ? `Mark ${e.customerName || "this proposal"} as won?\n\nThis stamps the proposal as won and creates the customer if none is linked. The customer is NOT texted, NOT auto-scheduled, and NO invoice is created — bill it from the proposal when ready.`
          : `Mark ${e.customerName || "this customer"} as accepted from a verbal yes?\n\nThis stamps the estimate as won for the funnel and activates the customer. The customer is NOT texted, NOT auto-scheduled, and NO setup or annual prepay invoice is created — use the customer link for annual prepay, or schedule the visit on the calendar and draft any invoice manually.`;
      if (!window.confirm(confirmMsg)) return;
      try {
        const result = await adminFetch(`/admin/estimates/${e.id}/mark-accepted`, {
          method: "POST",
          body: JSON.stringify({ source: "verbal_yes" }),
        });
        refreshEstimates();
        const notes = [];
        if (result?.createdCustomer?.id) {
          notes.push("A new customer record was created from the proposal.");
        }
        if (result?.warnings?.length) notes.push(...result.warnings);
        if (notes.length) window.alert(`Marked won:\n\n${notes.join("\n")}`);
      } catch (err) {
        window.alert("Mark accepted failed: " + err.message);
      }
    },
    [refreshEstimates],
  );
  const markEstimateAnnualPrepayAccepted = useCallback(
    async (e) => {
      const annualAmount =
        e.annualTotal > 0 ? e.annualTotal : (e.monthlyTotal || 0) * 12;
      if (
        !window.confirm(
          `Mark ${e.customerName || "this customer"} as accepted for annual prepay?\n\nThis activates the customer, creates a pending annual prepay invoice${annualAmount > 0 ? ` for about $${annualAmount.toFixed(2)}` : ""}, and creates the renewal term. The customer is NOT texted, NOT emailed, and NOT auto-scheduled.`,
        )
      )
        return;
      try {
        const result = await adminFetch(`/admin/estimates/${e.id}/mark-accepted`, {
          method: "POST",
          body: JSON.stringify({
            source: "verbal_annual_prepay",
            billingTerm: "prepay_annual",
          }),
        });
        refreshEstimates();
        if (result?.warnings?.length) {
          window.alert(
            `Marked annual prepay accepted, but:\n\n${result.warnings.join("\n")}`,
          );
        }
      } catch (err) {
        alert(`Failed to mark annual prepay accepted: ${err.message}`);
      }
    },
    [refreshEstimates],
  );
  const sendBookingLink = useCallback(
    async (e) => {
      if (!e.customerPhone) {
        window.alert(
          "No phone on file for this estimate — can't text a booking link.",
        );
        return;
      }
      if (
        !window.confirm(
          `Text ${e.customerName || "the customer"} a booking link so they can self-schedule?`,
        )
      )
        return;
      try {
        await adminFetch(`/admin/estimates/${e.id}/send-booking-link`, {
          method: "POST",
        });
        refreshEstimates();
      } catch (err) {
        window.alert("Send booking link failed: " + err.message);
      }
    },
    [refreshEstimates],
  );
  const archiveEstimateMobile = useCallback(
    async (e) => {
      if (
        !window.confirm(
          `Archive this ${e.status} estimate for ${e.customerName || "this customer"}?`,
        )
      )
        return;
      try {
        await adminFetch(`/admin/estimates/${e.id}/archive`, { method: "POST" });
        refreshEstimates();
      } catch (err) {
        window.alert("Archive failed: " + err.message);
      }
    },
    [refreshEstimates],
  );
  const unarchiveEstimateMobile = useCallback(
    async (e) => {
      try {
        await adminFetch(`/admin/estimates/${e.id}/unarchive`, {
          method: "POST",
        });
        refreshEstimates();
      } catch (err) {
        window.alert("Unarchive failed: " + err.message);
      }
    },
    [refreshEstimates],
  );
  const deleteDraftMobile = useCallback(
    async (e) => {
      if (
        !window.confirm(
          `Delete draft estimate for ${e.customerName || "this customer"}?\n\nThis is permanent.`,
        )
      )
        return;
      try {
        await adminFetch(`/admin/estimates/${e.id}`, { method: "DELETE" });
        refreshEstimates();
      } catch (err) {
        window.alert("Delete failed: " + err.message);
      }
    },
    [refreshEstimates],
  );
  const resendEstimateMobile = useCallback(
    async (e) => {
      if (!canSendEstimate(e)) {
        window.alert(
          "Estimate needs a positive monthly or one-time total before it can be sent.",
        );
        return;
      }
      try {
        await sendEstimateFromPipeline(e.id);
        refreshEstimates();
      } catch (err) {
        window.alert("Send failed: " + err.message);
      }
    },
    [refreshEstimates],
  );
  const copyEstimateLinkMobile = useCallback((e) => {
    // The menu item is token-gated, but keep the guard here too — an id-based
    // /estimate/<id> URL 404s for customers and must never reach a clipboard.
    if (!e.token) return;
    const link = `${window.location.origin}/estimate/${e.token}`;
    navigator.clipboard?.writeText(link);
  }, []);
  const groups = useMemo(() => {
    const now = Date.now();
    const classified = estimates.map((e) => ({
      ...e,
      _class: classifyEstimateForPipeline(e),
    }));
    let list = classified;
    if (v3Flag) {
      list = list.filter((e) => v3ChipMatches(e, filter));
    } else if (filter !== "all") {
      list = list.filter((e) => estimateMatchesFilter(e, filter));
    }
    if (dateFilter !== "all") {
      list = list.filter((e) =>
        mobileMatchesDate(e.createdAt, dateFilter, now),
      );
    }
    list = list.filter((e) =>
      mobileMatchesSearch(e, search, tableControlsEnabled),
    );
    // GATE_ESTIMATE_CALL_LIST: the Call today list runs oldest open first, ungrouped.
    if (callListOn && filter === "call_today") {
      return [[0, sortOldestEngagementFirst(list)]];
    }
    const useV3Sort = v3Flag && sort === "v3";
    list = useV3Sort
      ? [...list].sort(v3SortFn)
      : [...list].sort(mobileSortFn(sort, tableControlsEnabled));

    // Preview sorts and v3 priority ranking must remain global before paging,
    // rather than being regrouped into date buckets that change their order.
    if (tableControlsEnabled || useV3Sort) return [[0, list]];

    // Otherwise group by createdAt day; sort=oldest reverses group order.
    const byDay = new Map();
    for (const e of list) {
      const d = e.createdAt ? new Date(e.createdAt) : null;
      const key =
        d && !Number.isNaN(d.getTime())
          ? new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
          : 0;
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(e);
    }
    const sortedGroups = Array.from(byDay.entries()).sort((a, b) =>
      sort === "oldest" ? a[0] - b[0] : b[0] - a[0],
    );
    return sortedGroups;
  }, [
    estimates,
    search,
    filter,
    dateFilter,
    sort,
    tableControlsEnabled,
    v3Flag,
    callListOn,
  ]);
  const filterCounts = useMemo(() => {
    if (v3Flag) return v3ChipCounts(estimates, v3Chips(callListOn));
    const counts = {
      all: estimates.length,
    };
    for (const f of pipelineChips(callListOn)) {
      if (f.key === "all") continue;
      counts[f.key] = estimates
        .map((e) => ({
          ...e,
          _class: classifyEstimateForPipeline(e),
        }))
        .filter((e) => estimateMatchesFilter(e, f.key)).length;
    }
    return counts;
  }, [estimates, v3Flag, callListOn]);
  const filterOptions = mobileFilterOptions(v3Flag, filterCounts, callListOn);

  // Reset filter when the v3 flag flips; keep chronological ordering stable.
  useEffect(() => {
    setFilter("all");
  }, [v3Flag, callListOn]);

  // Flat list across all days — mirrors CustomersPageV2 directory layout.
  const flat = useMemo(() => groups.flatMap(([, items]) => items), [groups]);
  const sortOptions = estimateTableSortOptions(v3Flag);
  const paging = useEstimateTablePaging(
    flat,
    tableControlsEnabled,
    25,
    deepLinkEstimateId,
    deepLinkToken,
  );
  const highlightId = useEstimateDeepLinkHighlight({
    targetId: deepLinkEstimateId,
    token: deepLinkToken,
    rows: paging.displayedRows,
  });
  return (
    // Mirrors CustomersPageV2: page padding comes from AdminLayout, no
    // edge-to-edge overrides, list rows are cards (not hairlined rows).
    <div>
      {/* Title + tab switcher come from the page-level PipelineCommandHeader
          now that the mobile estimates list renders under the shared tabs;
          the list owns only its search/filter row and rows below. */}
      {/* Search + Add/filter row — mirrors Customers mobile block. */}
      <EstimateTableControls
        enabled={tableControlsEnabled}
        search={search}
        onSearchChange={(value) => {
          setSearch(value);
          paging.setPage(1);
        }}
        sort={sort}
        onSortChange={(value) => {
          setSort(value);
          paging.setPage(1);
        }}
        sortOptions={sortOptions}
        onReset={() => {
          setSearch("");
          setFilter("all");
          setDateFilter("all");
          setSort("newest");
          paging.setPage(1);
        }}
        canReset={estimateTableControlsChanged(
          search,
          filter,
          dateFilter,
          sort,
        )}
      >
        <MobileChipSheet
          label="Filter"
          value={filter}
          onChange={(value) => {
            setFilter(value);
            paging.setPage(1);
          }}
          options={filterOptions}
          title="Filter estimates"
        />
        <MobileChipSheet
          label="Date"
          value={dateFilter}
          onChange={(value) => {
            setDateFilter(value);
            paging.setPage(1);
          }}
          options={MOBILE_DATE_FILTERS}
          title="Filter by date"
        />
      </EstimateTableControls>
      <div hidden={tableControlsEnabled} className="mb-3">
        {" "}
        <Input
          type="search"
          inputMode="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by customer name or reference"
          aria-label="Search estimates"
          className="block w-full text-14 h-12"
        />{" "}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {" "}
          <MobileChipSheet
            label="Filter"
            value={filter}
            onChange={setFilter}
            options={filterOptions}
            title="Filter estimates"
          />{" "}
          <MobileChipSheet
            label="Date"
            value={dateFilter}
            onChange={setDateFilter}
            options={MOBILE_DATE_FILTERS}
            title="Filter by date"
          />{" "}
          <MobileChipSheet
            label="Sort"
            value={sort}
            onChange={setSort}
            options={
              v3Flag
                ? [
                    {
                      key: "v3",
                      label: "Action Priority",
                    },
                    ...MOBILE_SORT_OPTIONS,
                  ]
                : MOBILE_SORT_OPTIONS
            }
            title="Sort estimates"
          />{" "}
        </div>{" "}
      </div>
      <EstimateLoadedScopeNote
        enabled={tableControlsEnabled}
        truncated={estimatesTruncated}
      />
      {error && (
        <div className="mb-3 border-hairline border-alert-fg bg-alert-bg text-alert-fg rounded-xs p-3 text-ui-body">
          Failed to load estimates: {error.message || String(error)}
          <Button
            type="button"
            onClick={() => {
              setLoading(true);
              refreshEstimates();
            }}
            className="ml-2 underline"
          >
            Retry
          </Button>{" "}
        </div>
      )}

      {/* Result count — mirrors Customers */}
      <div className="u-nums text-ui-body text-ink-tertiary text-right mb-3 mt-3">
        {flat.length} result{flat.length !== 1 ? "s" : ""}
      </div>
      {/* List */}
      {loading ? (
        <div className="p-10 text-center text-ui-body text-ink-secondary">
          Loading estimates…
        </div>
      ) : flat.length === 0 ? (
        <Card>
          {" "}
          <CardBody className="p-12 text-center">
            {" "}
            <div className="text-14 text-ink-primary mb-1">
              {estimates.length === 0
                ? "No estimates yet"
                : "No estimates found"}
            </div>{" "}
            <div className="text-ui-body text-ink-tertiary">
              {estimates.length === 0
                ? "Create or send an estimate before it appears here"
                : "Try adjusting your filters"}
            </div>{" "}
          </CardBody>{" "}
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {paging.displayedRows.map((e) => (
            <MobileEstimateRow
              key={e.id}
              estimate={e}
              onSoldByChanged={refreshEstimates}
              highlighted={String(e.id) === String(highlightId)}
              onCreateFromAddress={onCreateFromAddress}
              onOpenCustomerPanel={setCustomerPanelId}
              onSend={refreshEstimates}
              onMarkAccepted={markEstimateAccepted}
              onMarkAnnualPrepayAccepted={markEstimateAnnualPrepayAccepted}
              onDeleted={refreshEstimates}
              onAudit={(estimate, focus = "all") =>
                setAuditTarget({
                  estimate,
                  focus,
                })
              }
              onSendBooking={sendBookingLink}
              onArchive={archiveEstimateMobile}
              onUnarchive={unarchiveEstimateMobile}
              onDeleteDraft={deleteDraftMobile}
              onResend={resendEstimateMobile}
              onCopyLink={copyEstimateLinkMobile}
              onExtend={setExtendTarget}
              onLawnOutline={setOutlineTarget}
              onEngineReview={setEngineReviewTarget}
              onViewAcceptance={setAcceptanceTarget}
              v3Flag={v3Flag}
              callListOn={callListOn}
              onPickReason={setReasonTarget}
              onCalled={(row) => {
                if (isCallTodayEstimate(row)) watchCall(row.id);
              }}
            />
          ))}
        </div>
      )}

      <EstimateTablePagination
        enabled={tableControlsEnabled}
        loading={loading}
        error={error}
        label="Estimates"
        page={paging.page}
        totalPages={paging.totalPages}
        total={flat.length}
        pageSize={paging.pageSize}
        onPageChange={paging.setPage}
        onPageSizeChange={paging.changePageSize}
        itemLabel="loaded estimates"
        pageSizeOptions={ESTIMATE_TABLE_PAGE_SIZES}
      />

      {customerPanelId && (
        <CustomerEstimatesPanel
          customerId={customerPanelId}
          onClose={() => setCustomerPanelId(null)}
        />
      )}
      {auditTarget && (
        <EstimatePricingAuditModal
          estimate={auditTarget.estimate || auditTarget}
          initialFocus={auditTarget.focus || "all"}
          onClose={() => setAuditTarget(null)}
        />
      )}
      {acceptanceTarget && (
        <AcceptanceRecordDialog
          estimate={acceptanceTarget}
          onClose={() => setAcceptanceTarget(null)}
        />
      )}
      {engineReviewTarget && (
        <EngineReviewModal
          estimate={engineReviewTarget}
          onClose={() => setEngineReviewTarget(null)}
        />
      )}
      {extendTarget && (
        <ExtendEstimateModalV2
          estimate={extendTarget}
          onClose={() => setExtendTarget(null)}
          onExtended={() => {
            setExtendTarget(null);
            refreshEstimates();
          }}
        />
      )}
      {reasonTarget && (
        <DeclineModalV2
          estimate={reasonTarget}
          reasonOnly
          onClose={() => setReasonTarget(null)}
          onSaved={() => {
            setReasonTarget(null);
            refreshEstimates();
          }}
        />
      )}
      {outlineTarget && (
        <ServiceOutlineComposerModal
          estimate={outlineTarget}
          adminFetch={adminFetch}
          onClose={() => setOutlineTarget(null)}
        />
      )}
    </div>
  );
}
function EstimatesWorkspace() {
  const isMobile = useIsMobile(768);
  const [searchParams, setSearchParams] = useSearchParams();
  const [newLeadRequest, setNewLeadRequest] = useState(0);
  const tableControlsEnabled = searchParams.get("tableControls") === "1";
  const readLeadPrefill = useCallback((params) => {
    // `leadId` predates the consolidated Pipeline and has two meanings:
    // old lead-alert links use it to select a lead, while estimate-builder
    // links pair it with tab=new. Keep the legacy alert on the Leads tab so
    // LeadsSection can normalize it to the canonical `lead` key.
    const estimatePrefillRequested =
      params.get("tab") === "new" ||
      [
        "customerId",
        "address",
        "customerName",
        "customerPhone",
        "customerEmail",
        "serviceInterest",
        "editEstimateId",
        "first_name",
        "last_name",
        "phone",
        "email",
        "service_interest",
      ].some((key) => params.has(key));
    const legacyName = [params.get("first_name"), params.get("last_name")]
      .filter(Boolean)
      .join(" ")
      .trim();
    return {
      leadId: estimatePrefillRequested ? params.get("leadId") || "" : "",
      customerId: params.get("customerId") || "",
      address: params.get("address") || "",
      customerName: params.get("customerName") || legacyName,
      customerPhone: params.get("customerPhone") || params.get("phone") || "",
      customerEmail: params.get("customerEmail") || params.get("email") || "",
      serviceInterest:
        params.get("serviceInterest") || params.get("service_interest") || "",
      // Reopen this existing estimate in the builder for in-place editing
      // (set by the row menus' "Edit estimate" action).
      editEstimateId: params.get("editEstimateId") || "",
    };
  }, []);

  // Prefill from URL params — populated when arriving from a Customer/Lead
  // row's "+ Estimate" quick action. Stays in state so consuming the params
  // (clearing the URL) doesn't blow away the wizard the user just landed on.
  const [prefill, setPrefill] = useState(() => readLeadPrefill(searchParams));
  const hasPrefill = !!(
    prefill.leadId ||
    prefill.customerId ||
    prefill.address ||
    prefill.customerName ||
    prefill.customerPhone ||
    prefill.customerEmail ||
    prefill.serviceInterest ||
    prefill.editEstimateId
  );
  const initialTab = TABS.some((t) => t.key === searchParams.get("tab"))
    ? searchParams.get("tab")
    : // A notification deep-link (?estimateId=<id>) carries no tab but must land
      // on the Estimates list so the row can be scrolled to + highlighted.
      searchParams.get("estimateId")
      ? "estimates"
      : null;

  // Prefill (editEstimateId / lead / customer seeding) must win over a tab
  // param: the legacy /admin/estimates redirect injects tab=estimates into
  // prefill links that omit tab=new, and mounting on any tab other than "new"
  // lets the leave-create-tab cleanup effect below wipe the prefill in the
  // very first effects pass — the builder then opens blank. The URL-watcher
  // effect resolves incoming prefill to the "new" tab anyway; starting there
  // keeps the initial state consistent with it.
  const [activeTab, setActiveTab] = useState(
    hasPrefill ? "new" : initialTab || "leads",
  );

  // Usage beacon for the tab that actually RENDERS. The URL only SEEDS
  // this state (prefill/estimateId deep links resolve to a tab and the
  // one-shot params — including ?tab= itself — are then stripped), so the
  // query can't be trusted as the rendered leaf here (Codex #2961 r17).
  // searchParams is a dep so a same-route handoff that does NOT move the
  // tab (?estimateId= while already on Estimates, a new prefill while on
  // Create Estimate) re-asserts the rendered leaf — the watcher below
  // strips those params, and without the re-assertion the layout's
  // search-change beacons persist a tabless row once the suppression
  // marker expires (Codex #2961 r22).
  useRenderedTabBeacon("/admin/pipeline", activeTab, [searchParams]);

  // The deep-link target for the Estimates list. Captured into state (and
  // stripped from the URL by the effect below) so it's consumed exactly once —
  // a stale ?estimateId left in the URL can't snap later tab changes back to
  // Estimates. `token` bumps on every consume so clicking the same notification
  // again still re-highlights. The effect is the sole consumer (keeps it to a
  // single arming per navigation).
  const [deepLink, setDeepLink] = useState({
    id: null,
    token: 0,
  });

  // Watch URL params for incoming prefill. Two cases this needs to handle:
  //   1. First mount with prefill in URL (e.g. arriving from a Customer panel
  //      "+ Estimate" link). useState initializer already captured the values;
  //      this effect just strips the keys so a refresh doesn't re-snap.
  //   2. Same-route navigation — user clicks the FilePlus2 icon on a row of
  //      this very page. The component is already mounted, so the useState
  //      initializer does NOT re-run. We have to react to searchParams here,
  //      pull the values into prefill state, and switch into the create flow.
  useEffect(() => {
    const incoming = readLeadPrefill(searchParams);
    const hasIncoming = !!(
      incoming.leadId ||
      incoming.customerId ||
      incoming.address ||
      incoming.customerName ||
      incoming.customerPhone ||
      incoming.customerEmail ||
      incoming.serviceInterest ||
      incoming.editEstimateId
    );
    const tabParam = searchParams.get("tab");
    const hasTabParam = TABS.some((t) => t.key === tabParam);
    // A notification deep-link (?estimateId=) that arrives via client-side
    // navigation while this page is already mounted must still snap to the
    // Estimates tab so the row can be scrolled to + highlighted. An explicit
    // tab still wins (e.g. ?estimateId=…&tab=pricing honors pricing).
    const estimateId = searchParams.get("estimateId");
    if (!hasIncoming && !hasTabParam && !estimateId) return;
    if (hasIncoming) {
      setPrefill(incoming);
      setActiveTab("new");
    } else if (hasTabParam) {
      setActiveTab(tabParam);
    } else if (estimateId) {
      setActiveTab("estimates");
    }
    if (estimateId)
      setDeepLink((prev) => ({
        id: estimateId,
        token: prev.token + 1,
      }));
    // Keep editor identity in the URL so refresh reopens the saved draft.
    // Notification highlights remain one-shot; selectTab clears editor keys.
    if (estimateId) {
      const next = new URLSearchParams(searchParams);
      next.delete("estimateId");
      setSearchParams(next, {
        replace: true,
      });
    }
  }, [searchParams, setSearchParams, readLeadPrefill]);

  // One-shot the deep link: once the operator leaves the Estimates tab, drop the
  // captured target. The list unmounts/remounts across tab switches, so without
  // this a stale notification's estimate would re-scroll/re-highlight every time
  // they returned to the tab. A fresh ?estimateId re-populates it (new token).
  useEffect(() => {
    if (activeTab !== "estimates" && deepLink.id) {
      setDeepLink((prev) => ({
        id: null,
        token: prev.token,
      }));
    }
  }, [activeTab, deepLink.id]);

  // Drop lead/customer prefill once the operator leaves the Create Estimate
  // tab, so the next blank "Create Estimate" doesn't reopen seeded with the
  // previous customer's address/contact (EstimateToolViewV2 seeds its form
  // from the initial* props). Mobile + desktop now share the tab header; this
  // replaces the old mobile-only clearPrefill() the create/back handlers ran.
  // onCreateFromAddress sets prefill and switches to "new" in the same batch,
  // so this only fires on an actual move away from the create tab.
  useEffect(() => {
    if (activeTab === "new" || !hasPrefill) return;
    setPrefill({
      leadId: "",
      customerId: "",
      address: "",
      customerName: "",
      customerPhone: "",
      customerEmail: "",
      serviceInterest: "",
      editEstimateId: "",
    });
  }, [activeTab, hasPrefill]);
  const selectTab = useCallback(
    (key) => {
      setNewLeadRequest(0);
      setActiveTab(key);
      const next = new URLSearchParams(searchParams);
      PREFILL_PARAM_KEYS.forEach((k) => next.delete(k));
      if (key === "leads") next.delete("tab");
      else next.set("tab", key);
      setSearchParams(next, {
        replace: false,
      });
    },
    [searchParams, setSearchParams],
  );
  return (
    <UiSurface
      density={activeTab === "new" ? "legacy" : "comfortable"}
      className="mx-auto max-w-[1400px] text-ui-body text-ink-primary"
    >
      {" "}
      <PipelineCommandHeader
        activeTab={activeTab}
        onTabChange={selectTab}
        onNewLead={() => setNewLeadRequest((value) => value + 1)}
      />
      {activeTab === "leads" && (
        <LeadsSection newLeadRequest={newLeadRequest} />
      )}
      {activeTab === "estimates" &&
        // Estimates list: mobile gets the touch-optimized card list with its
        // own filters/sort; desktop gets the full table/board pipeline view.
        (isMobile ? (
          <EstimatesMobileListView
            deepLinkEstimateId={deepLink.id}
            deepLinkToken={deepLink.token}
            tableControlsEnabled={tableControlsEnabled}
            onCreateFromAddress={(addr) => {
              setPrefill({
                leadId: "",
                customerId: "",
                address: addr || "",
                customerName: "",
                customerPhone: "",
                customerEmail: "",
                serviceInterest: "",
                editEstimateId: "",
              });
              selectTab("new");
            }}
          />
        ) : (
          <EstimatePipelineViewV2
            deepLinkEstimateId={deepLink.id}
            deepLinkToken={deepLink.token}
            tableControlsEnabled={tableControlsEnabled}
          />
        ))}
      {activeTab === "new" && (
        <EstimateToolViewV2
          initialLeadId={prefill.leadId}
          initialCustomerId={prefill.customerId}
          initialAddress={prefill.address}
          initialCustomerName={prefill.customerName}
          initialCustomerPhone={prefill.customerPhone}
          initialCustomerEmail={prefill.customerEmail}
          initialServiceInterest={prefill.serviceInterest}
          editEstimateId={prefill.editEstimateId}
          onBack={() => selectTab("leads")}
          onStartNew={() => {
            setPrefill(readLeadPrefill(new URLSearchParams()));
            selectTab("new");
          }}
          onDraftSaved={(id) => {
            const next = new URLSearchParams(searchParams);
            PREFILL_PARAM_KEYS.forEach((key) => next.delete(key));
            next.set("tab", "new");
            next.set("editEstimateId", id);
            setSearchParams(next, {
              replace: true,
            });
          }}
        />
      )}
      {activeTab === "pricing" && (
        <>
          {" "}
          <MarginCalculator /> <PricingLogicPanel />{" "}
        </>
      )}
    </UiSurface>
  );
}
export default function EstimatesPageV2() {
  return (
    <CustomerSmsProvider>
      <EstimateSendProvider>
        <EstimatesWorkspace />
      </EstimateSendProvider>
    </CustomerSmsProvider>
  );
}
