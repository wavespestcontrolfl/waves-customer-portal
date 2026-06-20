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
import React, { useState, useEffect, useCallback, useMemo } from "react";
import { createPortal } from "react-dom";
import { useSearchParams, useNavigate } from "react-router-dom";
import {
  STATUS_CONFIG,
  PIPELINE_FILTERS,
  classifyEstimate,
  getUrgencyIndicator,
  detectCompetitor,
} from "./EstimatePage";
import { LeadsSection } from "./LeadsTabs";
import PricingLogicPanel from "../../components/admin/PricingLogicPanel";
import { MarginCalculator } from "./PricingLogicPage";
import EstimateToolViewV2 from "./EstimateToolViewV2";
import CustomerEstimatesPanel from "./CustomerEstimatesPanel";
import ServiceOutlineComposerModal from "../../components/admin/ServiceOutlineComposerModal";
import CommercialProposalModal from "../../components/estimates/CommercialProposalModal";
import WinLossSlicesCard from "./WinLossSlicesCard";
import PipelineAnalytics, {
  isFollowUpOverdueEstimate,
  isGoingColdEstimate,
} from "./PipelineAnalytics";
import {
  FollowUpModalV2,
  DeclineModalV2,
  ExtendEstimateModalV2,
} from "../../components/admin/EstimateModalsV2";
import useIsMobile from "../../hooks/useIsMobile";
import { useFeatureFlag } from "../../hooks/useFeatureFlag";
import { Badge, Button, Card, CardBody, cn } from "../../components/ui";
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
} from "lucide-react";

import CreateAppointmentModal from "../../components/schedule/CreateAppointmentModal";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const ROBOTO = "'Roboto', Arial, sans-serif";

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
      if (estimate?.id && !byId.has(estimate.id)) byId.set(estimate.id, estimate);
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
  return mergeEstimateRows(...responses.map((d) => d.estimates || []));
}

function summarizeEstimateSend(data) {
  const parts = [];
  if (data?.channels?.sms) {
    parts.push(
      data.channels.sms.ok
        ? "SMS sent"
        : `SMS failed: ${data.channels.sms.error || "unknown error"}`,
    );
  }
  if (data?.channels?.email) {
    parts.push(
      data.channels.email.ok
        ? "Email sent"
        : `Email failed: ${data.channels.email.error || "unknown error"}`,
    );
  }
  if (parts.length === 0) return data?.error || "Estimate send failed";
  return parts.join(" / ");
}

function isQuietHoursEstimateSend(data) {
  const message = String(data?.channels?.sms?.error || data?.error || "");
  return /quiet-hours|quiet hours|federal holidays/i.test(message);
}

async function sendEstimateFromPipeline(id, sendMethod = "both", options = {}) {
  const r = await fetch(`${API_BASE}/admin/estimates/${id}/send`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      sendMethod,
      quietHoursOverride: options.quietHoursOverride === true,
      idempotencyKey:
        globalThis.crypto?.randomUUID?.() ||
        `estimate-send-${Date.now()}-${Math.random()}`,
    }),
  });
  const data = await r.json().catch(() => ({}));
  const summary = summarizeEstimateSend(data);
  if (!options.quietHoursOverride && isQuietHoursEstimateSend(data)) {
    const retry = window.confirm(`${summary}\n\nSend the SMS now anyway?`);
    if (retry) {
      return sendEstimateFromPipeline(id, "sms", { quietHoursOverride: true });
    }
  }
  if (!r.ok) throw new Error(summary || `HTTP ${r.status}`);
  if (data.partialFailure) window.alert(`Send had issues: ${summary}`);
  return data;
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
  // Common base for the filled-pill variants.
  const filled =
    "inline-flex items-center gap-1 h-5 px-2 rounded-full text-11 font-medium whitespace-nowrap";
  switch (status) {
    case "expired":
      return (
        <span className={cn(filled, "bg-alert-fg text-white")}>{label}</span>
      );
    case "viewed":
      return (
        <span className={cn(filled, "bg-zinc-200 text-zinc-900")}>
          {" "}
          <span aria-hidden className="w-1.5 h-1.5 rounded-full bg-zinc-900" />
          {label}
        </span>
      );
    case "accepted":
      return (
        <span className={cn(filled, "bg-zinc-200 text-zinc-900")}>
          {" "}
          <Check size={10} strokeWidth={2.5} aria-hidden />
          {label}
        </span>
      );
    case "sent":
      return (
        <span className={cn(filled, "bg-zinc-200 text-zinc-900")}>{label}</span>
      );
    case "scheduled":
      return (
        <span className={cn(filled, "bg-zinc-200 text-zinc-900")}>
          {" "}
          <CalendarCheck size={10} strokeWidth={2.5} aria-hidden />
          {label}
        </span>
      );
    case "declined":
      return (
        <span className="inline-flex items-center h-5 px-2 rounded-full text-11 font-normal whitespace-nowrap border-hairline border-zinc-300 text-ink-tertiary bg-white">
          {label}
        </span>
      );
    case "draft":
    default:
      return (
        <span className="inline-flex items-center h-5 px-2 rounded-full text-11 font-normal whitespace-nowrap border-hairline border-zinc-300 text-ink-tertiary bg-white">
          {label}
        </span>
      );
  }
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
  { key: "all", label: "All" },
  { key: "action", label: "Action Required" },
  { key: "pricing_risk", label: "Pricing Risk" },
  { key: "missing_cogs", label: "Missing COGS" },
  { key: "low_margin", label: "Low Margin" },
  { key: "open", label: "Open" },
  { key: "closed", label: "Closed" },
  { key: "drafts", label: "Drafts" },
  { key: "archived", label: "Archived" },
];

function v3ChipMatches(e, chip) {
  if (chip === "all") return true;
  if (chip === "pricing_risk") return !!e.pricingRisk?.hasRisk;
  if (chip === "missing_cogs")
    return (e.pricingRisk?.missingCogsCount || 0) > 0;
  if (chip === "low_margin") return (e.pricingRisk?.lowMarginCount || 0) > 0;
  if (chip === "archived") return !!e.archivedAt;
  if (chip === "drafts") return e.status === "draft";
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
  { key: "pricing_risk", label: "Pricing Risk" },
  { key: "missing_cogs", label: "Missing COGS" },
  { key: "low_margin", label: "Low Margin" },
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
  if (filter === "pricing_risk") return !!e.pricingRisk?.hasRisk;
  if (filter === "missing_cogs")
    return (e.pricingRisk?.missingCogsCount || 0) > 0;
  if (filter === "low_margin") return (e.pricingRisk?.lowMarginCount || 0) > 0;
  return e._class === filter;
}

function estimateFilterLabel(filter) {
  if (filter === "drafts") return "Drafts";
  if (filter === "sent_group") return "Sent";
  if (filter === "follow_up_overdue") return "Follow-up overdue";
  if (filter === "going_cold") return "Going cold";
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
  if (value.includes("lawn")) return "lawn";
  if (value.includes("tree") || value.includes("shrub")) return "tree_shrub";
  return "pest";
}

function PricingRiskBadges({ risk, onMissingCogs, onLowMargin }) {
  if (!risk?.hasRisk) return null;
  return (
    <>
      {(risk.missingCogsCount || 0) > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMissingCogs?.();
          }}
          className="inline-flex u-focus-ring rounded-full"
          title="Open pricing audit focused on missing inventory COGS"
        >
          {" "}
          <Badge tone="alert">Missing COGS</Badge>{" "}
        </button>
      )}
      {(risk.lowMarginCount || 0) > 0 && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onLowMargin?.();
          }}
          className="inline-flex u-focus-ring rounded-full"
          title="Open pricing audit focused on low-margin lines"
        >
          {" "}
          <Badge tone="alert">Low Margin</Badge>{" "}
        </button>
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
  const status = outline.validationStatus === "blocked" ? "blocked" : outline.status || "draft";
  const tone = status === "blocked" || outline.stale ? "alert" : ["sent", "viewed"].includes(status) ? "strong" : "neutral";
  const label = status === "blocked"
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
    outline.lastCtaClickedAt && `Estimate clicked ${timeAgo(outline.lastCtaClickedAt)}`,
    outline.lastViewedAt && `Last viewed ${timeAgo(outline.lastViewedAt)}`,
    outline.sentAt && `Sent ${timeAgo(outline.sentAt)}`,
    outline.staleReasons?.length ? `Regenerate: ${outline.staleReasons.join(", ")}` : null,
  ].filter(Boolean).join(" · ");
  return (
    <Badge tone={tone} title={detail || undefined}>
      <ClipboardList size={11} strokeWidth={1.75} aria-hidden />
      {label}
    </Badge>
  );
}

function v3ChipCounts(estimates) {
  const out = {};
  for (const c of V3_CHIPS) {
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

// Row overflow menu. Holds secondary actions (Audit, Preview, Resend, Copy
// Link, 1x Option toggle, Invoice toggle, Send Booking Link, Archive, Delete)
// so the inline action bar stays focused on the single primary action for
// the row's status. Mobile = bottom sheet, desktop = small centered popover.
function RowActionsMenu({ items, label = "More actions" }) {
  const [open, setOpen] = useState(false);
  const visible = (items || []).filter((it) => it && !it.hidden);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (visible.length === 0) return null;

  return (
    <>
      {" "}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        className={cn(
          "inline-flex items-center justify-center flex-shrink-0",
          "h-11 w-11 sm:h-9 sm:w-9 rounded-xs",
          "border-hairline border-zinc-300 bg-white text-ink-secondary",
          "hover:bg-zinc-50 u-focus-ring transition-colors",
        )}
      >
        {" "}
        <MoreHorizontal size={16} strokeWidth={1.75} aria-hidden />{" "}
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
            role="dialog"
            aria-modal="true"
            style={{ fontFamily: ROBOTO }}
            onClick={() => setOpen(false)}
          >
            {" "}
            <div className="absolute inset-0 bg-zinc-900/30" />{" "}
            <div
              onClick={(e) => e.stopPropagation()}
              className="relative bg-white border-hairline border-zinc-200 rounded-t-lg sm:rounded-md w-full sm:w-72 max-w-md shadow-lg overflow-hidden"
            >
              {" "}
              <div className="px-4 py-3 border-b border-zinc-200 text-11 uppercase tracking-label text-ink-tertiary font-medium flex items-center justify-between">
                {" "}
                <span>Actions</span>{" "}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close actions menu"
                  className="text-ink-tertiary hover:text-ink-primary"
                >
                  {" "}
                  <X size={14} strokeWidth={1.75} aria-hidden />{" "}
                </button>{" "}
              </div>{" "}
              <ul className="py-1 max-h-[70vh] overflow-y-auto">
                {visible.map((it) => (
                  <li key={it.key}>
                    {" "}
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOpen(false);
                        it.onClick?.();
                      }}
                      disabled={it.disabled}
                      title={it.title || undefined}
                      className={cn(
                        "w-full text-left px-4 py-3 sm:py-2 text-14 flex items-center gap-3 u-focus-ring",
                        "hover:bg-zinc-50 disabled:opacity-50 disabled:cursor-not-allowed",
                        it.variant === "danger" &&
                          "text-alert-fg hover:bg-alert-bg",
                      )}
                    >
                      {it.icon ? (
                        <span
                          className={cn(
                            "flex-shrink-0",
                            it.variant === "danger"
                              ? "text-alert-fg"
                              : "text-ink-tertiary",
                          )}
                        >
                          {it.icon}
                        </span>
                      ) : (
                        <span className="w-4" />
                      )}{" "}
                      <span className="flex-1">{it.label}</span>
                      {it.detail && (
                        <span className="text-11 text-ink-tertiary">
                          {it.detail}
                        </span>
                      )}{" "}
                    </button>{" "}
                  </li>
                ))}{" "}
              </ul>{" "}
            </div>{" "}
          </div>,
          document.body,
        )}{" "}
    </>
  );
}

// Filter — 7 pipeline filters exceed the 4-item pill cap. Per UI SoR §6.1
// "over 4" rule + §6.6, we collapse to a single FILTER pill that opens a
// bottom-anchored sheet on mobile (centered modal on desktop) listing every
// option with its live count. Active option marked with a trailing check.
function FilterSheetV2({ value, onChange, options, counts }) {
  const [open, setOpen] = useState(false);
  const active = options.find((o) => o.key === value) || options[0];

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open]);

  return (
    <>
      {" "}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Filter estimates. Current filter: ${active.label} (${counts[active.key] ?? 0})`}
        className={cn(
          "inline-flex items-center gap-2 h-11 sm:h-9 pl-4 pr-5 rounded-full",
          "text-12 font-medium uppercase tracking-label",
          "bg-zinc-900 text-white border-hairline border-zinc-900",
          "u-focus-ring hover:bg-zinc-800 transition-colors",
        )}
      >
        {" "}
        <SlidersHorizontal size={16} strokeWidth={1.75} aria-hidden />{" "}
        <span>
          Filter: {active.label} ({counts[active.key] ?? 0})
        </span>{" "}
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-label="Filter estimates"
            style={{ fontFamily: ROBOTO }}
          >
            {" "}
            <div
              className="absolute inset-0 bg-zinc-900/40"
              onClick={() => setOpen(false)}
            />{" "}
            <div
              className={cn(
                "relative w-full bg-white outline-none",
                "rounded-t-md sm:rounded-md sm:max-w-md",
                "border-hairline border-zinc-200",
                "flex flex-col max-h-[85vh]",
              )}
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0)" }}
            >
              {/* Drag handle (mobile only) */}
              <div className="pt-2 pb-1 sm:hidden">
                {" "}
                <div className="mx-auto w-10 h-1 rounded-full bg-zinc-300" />{" "}
              </div>{" "}
              <div className="px-5 py-3 flex items-center justify-between border-b border-hairline border-zinc-200">
                {" "}
                <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary">
                  Filter estimates
                </div>{" "}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="h-9 w-9 flex items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-zinc-200 u-focus-ring"
                >
                  {" "}
                  <X size={16} strokeWidth={1.75} aria-hidden />{" "}
                </button>{" "}
              </div>{" "}
              <div className="flex-1 overflow-y-auto">
                {options.map((o) => {
                  const isActive = o.key === value;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => {
                        onChange(o.key);
                        setOpen(false);
                      }}
                      className={cn(
                        "w-full flex items-center justify-between gap-3",
                        "px-5 py-4 text-left u-focus-ring",
                        "border-b border-hairline border-zinc-100 last:border-b-0",
                        isActive ? "bg-zinc-50" : "bg-white hover:bg-zinc-50",
                      )}
                    >
                      {" "}
                      <span
                        className={cn(
                          "text-14 tracking-tight",
                          isActive
                            ? "font-medium text-zinc-900"
                            : "text-zinc-700",
                        )}
                      >
                        {o.label}
                      </span>{" "}
                      <span className="flex items-center gap-3">
                        {" "}
                        <span className="text-12 u-nums text-ink-tertiary">
                          {counts[o.key] ?? 0}
                        </span>
                        {isActive && (
                          <Check
                            size={16}
                            strokeWidth={2}
                            className="text-zinc-900"
                            aria-hidden
                          />
                        )}
                      </span>{" "}
                    </button>
                  );
                })}
              </div>{" "}
            </div>{" "}
          </div>,
          document.body,
        )}
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
  if (monthly > 0) return { value: monthly, suffix: "/mo" };
  if (oneTime > 0) return { value: oneTime, suffix: " one-time" };
  return { value: 0, suffix: "/mo" };
}

function canSendEstimate(estimate) {
  return estimateAmountDisplay(estimate).value > 0;
}

function classifyEstimateForPipeline(estimate) {
  if (estimate?.archivedAt) return classifyEstimate(estimate);
  if (estimate?.status === "draft") {
    return canSendEstimate(estimate) ? "ready_to_send" : "needs_estimate";
  }
  return classifyEstimate(estimate);
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
      <div className="text-11 uppercase tracking-label text-ink-tertiary mb-1">
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
      {sub && <div className="text-11 text-ink-tertiary mt-1">{sub}</div>}
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
      <button
        type="button"
        onClick={() => onChange("all")}
        className={cn(
          "w-full h-10 px-3 rounded-sm border-hairline text-left",
          "flex items-center justify-between gap-2 u-focus-ring",
          value === "all"
            ? "bg-zinc-900 text-white border-zinc-900"
            : "bg-white text-zinc-900 border-zinc-200 hover:bg-zinc-50",
        )}
      >
        {" "}
        <span className="text-12 font-medium uppercase tracking-label">
          All Work
        </span>{" "}
        <span className="text-11 u-nums">{counts.all ?? 0}</span>{" "}
      </button>
      {WORK_QUEUE_GROUPS.map((group) => (
        <div key={group.label} className="mt-4">
          {" "}
          <div className="px-1 mb-1.5 text-10 uppercase tracking-label font-medium text-ink-tertiary">
            {group.label}
          </div>{" "}
          <div className="space-y-1">
            {group.keys.map((key) => {
              const item = optionsByKey[key];
              if (!item) return null;
              const active = value === key;
              return (
                <button
                  key={key}
                  type="button"
                  onClick={() => onChange(key)}
                  className={cn(
                    "w-full min-h-9 px-3 rounded-sm text-left",
                    "flex items-center justify-between gap-2 u-focus-ring",
                    active
                      ? "bg-zinc-900 text-white"
                      : "bg-transparent text-zinc-700 hover:bg-zinc-50 hover:text-zinc-900",
                  )}
                >
                  {" "}
                  <span className="text-12">{item.label}</span>{" "}
                  <span className="text-11 u-nums opacity-80">
                    {counts[key] ?? 0}
                  </span>{" "}
                </button>
              );
            })}
          </div>{" "}
        </div>
      ))}
    </Card>
  );
}

function PipelineCommandHeader({ activeTab, onTabChange }) {
  const activeConfig = TABS.find((t) => t.key === activeTab) || TABS[0];
  const ActionIcon = activeTab === "new" ? ClipboardList : FilePlus2;
  const actionLabel =
    activeTab === "new" ? "View Estimates" : "Create Estimate";
  const actionTarget = activeTab === "new" ? "estimates" : "new";

  return (
    <div
      className="md:sticky md:top-0 z-20 mb-5 bg-surface-page/95 pb-3"
      style={{ fontFamily: ROBOTO }}
    >
      {" "}
      <div className="overflow-hidden rounded-md border-hairline border-zinc-200 bg-white">
        {" "}
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 border-b border-hairline border-zinc-200">
          {" "}
          <div className="flex items-center gap-3 min-w-0">
            {" "}
            <div className="h-9 w-9 rounded-sm bg-zinc-900 text-white flex items-center justify-center flex-shrink-0">
              {" "}
              <activeConfig.Icon size={17} strokeWidth={1.9} aria-hidden />{" "}
            </div>{" "}
            <h1
              className="m-0 text-22 font-medium text-zinc-900 tracking-normal"
              style={{ fontFamily: ROBOTO }}
            >
              Pipeline
            </h1>{" "}
          </div>{" "}
          <Button
            size="md"
            variant={activeTab === "new" ? "secondary" : "primary"}
            className="gap-2 text-12 font-medium uppercase tracking-label"
            onClick={() => onTabChange(actionTarget)}
          >
            {" "}
            <ActionIcon size={15} strokeWidth={1.9} aria-hidden />
            {actionLabel}
          </Button>{" "}
        </div>{" "}
        <nav
          aria-label="Pipeline section"
          className="grid grid-cols-2 lg:grid-cols-4 gap-1 p-2"
        >
          {TABS.map(({ key, label, Icon }) => {
            const active = activeTab === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onTabChange(key)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "h-11 px-3 rounded-sm border-hairline text-12 font-medium uppercase tracking-label",
                  "inline-flex items-center justify-center gap-2 u-focus-ring transition-colors",
                  active
                    ? "bg-zinc-900 text-white border-zinc-900"
                    : "bg-white text-zinc-700 border-zinc-200 hover:bg-zinc-50 hover:text-zinc-900",
                )}
              >
                {" "}
                <Icon size={15} strokeWidth={1.8} aria-hidden />
                {label}
              </button>
            );
          })}
        </nav>{" "}
      </div>{" "}
    </div>
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

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

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

  return createPortal(
    <div
      className="fixed inset-0 z-[1000] bg-black/45 flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Estimate pricing audit"
      style={{ fontFamily: ROBOTO }}
      onClick={onClose}
    >
      {" "}
      <div
        className="bg-white border-hairline border-zinc-200 rounded-lg shadow-xl w-full max-w-5xl max-h-[88vh] overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {" "}
        <div className="p-5 border-b border-zinc-200 flex items-start justify-between gap-4">
          {" "}
          <div>
            {" "}
            <div className="text-16 font-semibold text-zinc-900">
              Estimate Pricing Audit
            </div>{" "}
            <div className="text-12 text-ink-secondary mt-1">
              {estimate.customerName || "Unknown"} ·{" "}
              {estimate.address || "No address"}
            </div>{" "}
          </div>{" "}
          <button
            type="button"
            onClick={onClose}
            className="h-9 w-9 inline-flex items-center justify-center rounded-xs border-hairline border-zinc-300 text-zinc-700 hover:bg-zinc-50"
            aria-label="Close pricing audit"
          >
            {" "}
            <X size={16} strokeWidth={1.75} />{" "}
          </button>{" "}
        </div>{" "}
        <div className="p-5 overflow-auto">
          {error && (
            <div className="border-hairline border-alert-fg bg-alert-bg text-alert-fg rounded-xs p-3 text-13">
              {error}
            </div>
          )}
          {!audit && !error && (
            <div className="p-8 text-center text-13 text-ink-secondary">
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
                    <div className="text-11 uppercase tracking-label text-ink-tertiary mb-2">
                      Sent Snapshot
                    </div>{" "}
                    <div className="grid grid-cols-3 gap-3">
                      {" "}
                      <div>
                        {" "}
                        <div className="text-11 text-ink-tertiary">
                          COGS
                        </div>{" "}
                        <div className="text-16 font-medium u-nums text-zinc-900">
                          {fmtMoney(audit.snapshot.totals?.estimatedCost)}
                        </div>{" "}
                      </div>{" "}
                      <div>
                        {" "}
                        <div className="text-11 text-ink-tertiary">
                          Margin
                        </div>{" "}
                        <div className="text-16 font-medium u-nums text-zinc-900">
                          {fmtPct(audit.snapshot.totals?.margin)}
                        </div>{" "}
                      </div>{" "}
                      <div>
                        {" "}
                        <div className="text-11 text-ink-tertiary">
                          Captured
                        </div>{" "}
                        <div className="text-12 text-zinc-900">
                          {fmtDateTime(audit.snapshot.snapshotAt)}
                        </div>{" "}
                      </div>{" "}
                    </div>{" "}
                  </Card>{" "}
                  <Card className="p-4">
                    {" "}
                    <div className="text-11 uppercase tracking-label text-ink-tertiary mb-2">
                      Current Audit
                    </div>{" "}
                    <div className="grid grid-cols-3 gap-3">
                      {" "}
                      <div>
                        {" "}
                        <div className="text-11 text-ink-tertiary">
                          COGS
                        </div>{" "}
                        <div className="text-16 font-medium u-nums text-zinc-900">
                          {fmtMoney(audit.totals.estimatedCost)}
                        </div>{" "}
                      </div>{" "}
                      <div>
                        {" "}
                        <div className="text-11 text-ink-tertiary">
                          Margin
                        </div>{" "}
                        <div className="text-16 font-medium u-nums text-zinc-900">
                          {fmtPct(audit.totals.margin)}
                        </div>{" "}
                      </div>{" "}
                      <div>
                        {" "}
                        <div className="text-11 text-ink-tertiary">
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
                <div className="text-12 text-ink-secondary">
                  Showing{" "}
                  <span className="font-medium text-zinc-900">
                    {focusLabel}
                  </span>
                  {focus !== "all"
                    ? ` (${visibleLines.length} of ${audit.lines.length})`
                    : ""}
                </div>{" "}
                <div className="flex flex-wrap gap-1.5">
                  {[
                    { key: "all", label: "All" },
                    { key: "missing_cogs", label: "Missing COGS" },
                    { key: "low_margin", label: "Low Margin" },
                  ].map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => setFocus(item.key)}
                      className={cn(
                        "h-8 px-3 rounded-full text-11 font-medium border-hairline u-focus-ring",
                        focus === item.key
                          ? "bg-zinc-900 text-white border-zinc-900"
                          : "bg-white text-zinc-700 border-zinc-300 hover:bg-zinc-50",
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>{" "}
              </div>{" "}
              <div className="border-hairline border-zinc-200 rounded-lg overflow-hidden">
                {" "}
                <div className="hidden md:grid grid-cols-[1.1fr_0.85fr_0.75fr_0.65fr_0.75fr_1fr_0.65fr] gap-3 px-3 py-2 bg-zinc-50 text-10 uppercase tracking-label text-ink-tertiary font-medium">
                  {" "}
                  <div>Line</div> <div>Price Source</div> <div>Protocol</div>{" "}
                  <div>Revenue</div> <div>COGS</div>{" "}
                  <div>Margin / Warnings</div> <div>Fix</div>{" "}
                </div>
                {visibleLines.length === 0 ? (
                  <div className="p-4 text-13 text-ink-secondary">
                    {audit.lines.length === 0
                      ? "No saved estimate lines found."
                      : `No ${focusLabel.toLowerCase()} lines found.`}
                  </div>
                ) : (
                  visibleLines.map((line, idx) => (
                    <div
                      key={`${line.serviceKey}-${idx}`}
                      className="grid grid-cols-1 md:grid-cols-[1.1fr_0.85fr_0.75fr_0.65fr_0.75fr_1fr_0.65fr] gap-3 px-3 py-3 border-t border-zinc-100 text-12"
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
                          <div className="mt-1 text-11 text-ink-tertiary">
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
                        <Badge
                          tone={line.status === "ok" ? "neutral" : "alert"}
                        >
                          {fmtPct(line.margin)}
                        </Badge>
                        {line.warnings?.length > 0 && (
                          <div className="mt-1 space-y-1">
                            {line.warnings.slice(0, 3).map((w, i) => (
                              <div key={i} className="text-11 text-alert-fg">
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
                          <button
                            type="button"
                            onClick={() => goFixSource(line)}
                            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-full border-hairline border-zinc-300 text-11 font-medium text-zinc-800 hover:bg-zinc-50 u-focus-ring"
                            title="Open the source setup for this pricing issue"
                          >
                            {" "}
                            <ExternalLink
                              size={13}
                              strokeWidth={1.75}
                              aria-hidden
                            />
                            Fix source
                          </button>
                        )}
                      </div>{" "}
                    </div>
                  ))
                )}
              </div>{" "}
              <div className="text-11 text-ink-tertiary">
                Pricing is read from the saved estimate result. Current COGS is
                recalculated from today's inventory product costs and service
                protocol mappings; sent snapshots preserve the audit values
                captured when the estimate was delivered.
              </div>{" "}
            </div>
          )}
        </div>{" "}
      </div>{" "}
    </div>,
    document.body,
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
  return `/estimate/${encodeURIComponent(estimate.token)}`;
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
  const serviceLines = Array.isArray(estimate.serviceLines) ? estimate.serviceLines : [];
  const haystack = [
    estimate.serviceInterest,
    estimate.description,
    estimate.notes,
    ...serviceLines,
  ].join(" ").toLowerCase();
  return haystack.includes("lawn");
}

function LawnOutlineQuickButton({ estimate, onClick, compact = false }) {
  if (!estimateHasLawnLine(estimate)) return null;
  const outline = estimate.lawnServiceOutline;
  const clicked = outline?.ctaClickCount > 0;
  const viewed = outline?.viewCount > 0;
  const blocked = outline?.validationStatus === "blocked";
  const stale = outline?.stale;
  const active = clicked || viewed || ["sent", "viewed"].includes(outline?.status);
  const title = outline
    ? [
        stale && `Stale: ${outline.staleReasons?.join(", ") || "regenerate recommended"}`,
        clicked && `Estimate clicked ${timeAgo(outline.lastCtaClickedAt)}`,
        viewed && `Viewed ${outline.viewCount}x`,
        outline.sentAt && `Sent ${timeAgo(outline.sentAt)}`,
        outline.productCardCount ? `${outline.productCardCount} product cards` : null,
        blocked ? "Validation blocked" : null,
      ].filter(Boolean).join(" · ")
    : "Generate lawn service outline";
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.(estimate);
      }}
      aria-label={outline ? "Open lawn service outline" : "Generate lawn service outline"}
      title={title || "Open lawn service outline"}
      className={cn(
        "inline-flex items-center justify-center border-hairline rounded-xs u-focus-ring transition-colors",
        compact ? "h-11 w-11 sm:h-9 sm:w-9" : "h-9 px-3 gap-1.5 text-12 font-medium",
        blocked || stale
          ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
          : active
            ? "border-emerald-700 bg-emerald-700 text-white hover:bg-emerald-800"
            : "border-zinc-300 bg-white text-zinc-800 hover:bg-zinc-50",
      )}
    >
      <ClipboardList size={16} strokeWidth={1.75} aria-hidden />
      {!compact && <span>{stale ? "Stale" : clicked ? "Clicked" : viewed ? "Viewed" : outline ? "Outline" : "Outline"}</span>}
    </button>
  );
}

const SOURCE_ICON = {
  lead_webhook: { Icon: Globe, title: "Website lead" },
  referral: { Icon: Users, title: "Referral" },
  ai_agent: { Icon: Bot, title: "AI agent draft — review before sending" },
  call_recording: { Icon: Phone, title: "Phone call recording draft" },
};

function EstimatePipelineViewV2() {
  const v3Flag = useFeatureFlag("estimates_v2_status_pills");
  const navigate = useNavigate();
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [customerPanelId, setCustomerPanelId] = useState(null);
  const [filter, setFilter] = useState("all");
  const [dateRange, setDateRange] = useState("all");
  const [search, setSearch] = useState("");
  const [followUpTarget, setFollowUpTarget] = useState(null);
  const [declineTarget, setDeclineTarget] = useState(null);
  const [auditTarget, setAuditTarget] = useState(null);
  const [extendTarget, setExtendTarget] = useState(null);
  const [outlineTarget, setOutlineTarget] = useState(null);
  const [proposalTarget, setProposalTarget] = useState(null);
  const [pendingToggleKeys, setPendingToggleKeys] = useState(() => new Set());
  const [scheduleEstimate, setScheduleEstimate] = useState(null);

  const refreshEstimates = useCallback(() => {
    setLoading(true);
    setError(null);
    const fetches = [fetchEstimatePipelineRows(filter)];
    if (filter !== "archived") {
      // Won = won forever: archived-accepted rows ride along so the Won
      // funnel and MRR-won KPI don't shrink when old wins get archived.
      // estimateMatchesFilter keeps them out of the All list. Desktop-only —
      // the mobile list view has no KPI bar and skips this fetch.
      fetches.push(
        adminFetch(
          "/admin/estimates?archived=only&status=accepted&limit=all",
        ).then((d) => d.estimates || []),
      );
    }
    Promise.all(fetches)
      .then(([rows, archivedWon = []]) => {
        setEstimates(mergeEstimateRows(rows, archivedWon));
        setLoading(false);
      })
      .catch((err) => {
        setError(err);
        setLoading(false);
      });
  }, [filter]);

  useEffect(() => {
    refreshEstimates();
  }, [refreshEstimates]);

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
            est.id === estimate.id ? { ...est, [field]: value } : est,
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
      // A commercial proposal win auto-creates the customer when none is linked
      // and, in invoice mode, builds the first invoice from the proposal lines.
      const proposalInvoiceMode = !!e.isCommercialProposal && !!e.billByInvoice;
      const confirmMsg = proposalInvoiceMode
        ? `Mark ${e.customerName || "this proposal"} as won?\n\nThis stamps the proposal as won, creates the customer if none is linked, and creates the first invoice from the proposal line items (one-time items plus the first period of each recurring service). The customer is NOT texted and NOT auto-scheduled — ongoing recurring visits are billed as completed.`
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
        if (result?.proposalInvoice?.invoiceNumber) {
          notes.push(
            `Invoice ${result.proposalInvoice.invoiceNumber} for $${Number(
              result.proposalInvoice.total || 0,
            ).toFixed(2)} was created.`,
          );
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
      const annualAmount = e.annualTotal > 0
        ? e.annualTotal
        : (e.monthlyTotal || 0) * 12;
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
          window.alert(`Marked annual prepay accepted, but:\n\n${result.warnings.join("\n")}`);
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

  if (loading) {
    return (
      <div className="p-10 text-center text-13 text-ink-secondary">
        Loading estimates…
      </div>
    );
  }

  if (error && estimates.length === 0) {
    return (
      <div className="p-10 text-center">
        {" "}
        <div className="text-14 text-alert-fg mb-3">
          Failed to load estimates
        </div>{" "}
        <div className="text-13 text-ink-tertiary mb-4">
          {error.message || String(error)}
        </div>{" "}
        <Button variant="primary" onClick={() => refreshEstimates()}>
          Retry
        </Button>{" "}
      </div>
    );
  }

  // Classify + sort newest-first so the most recent estimates stay at the top.
  const classified = estimates.map((e) => ({
    ...e,
    _class: classifyEstimateForPipeline(e),
  }));
  const sorted = [...classified].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );

  const filtered = sorted
    .filter((e) => estimateMatchesFilter(e, filter))
    .filter((e) => {
      const q = search.trim().toLowerCase();
      if (!q) return true;
      const ref = shortEstimateRef(e.id).toLowerCase();
      return (
        (e.customerName || "").toLowerCase().includes(q) ||
        (e.address || "").toLowerCase().includes(q) ||
        (e.customerEmail || "").toLowerCase().includes(q) ||
        (e.customerPhone || "").includes(q) ||
        ref.includes(q)
      );
    });

  return (
    <div style={{ fontFamily: ROBOTO }}>
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

      {outlineTarget && (
        <ServiceOutlineComposerModal
          estimate={outlineTarget}
          adminFetch={adminFetch}
          onClose={() => setOutlineTarget(null)}
        />
      )}

      {proposalTarget && (
        <CommercialProposalModal
          estimate={proposalTarget}
          adminFetch={adminFetch}
          onClose={() => setProposalTarget(null)}
          onSaved={refreshEstimates}
        />
      )}

      {scheduleEstimate && (
        <CreateAppointmentModal
          open
          onClose={() => setScheduleEstimate(null)}
          onChange={() => {
            setScheduleEstimate(null);
            refreshEstimates();
          }}
          defaultCustomer={{
            id: scheduleEstimate.customerId,
            first_name: (scheduleEstimate.customerName || '').split(' ')[0] || '',
            last_name: (scheduleEstimate.customerName || '').split(' ').slice(1).join(' ') || '',
            phone: scheduleEstimate.customerPhone || '',
            email: scheduleEstimate.customerEmail || '',
          }}
          defaultEstimateId={scheduleEstimate.id}
        />
      )}

      {error && (
        <div className="mb-4 border-hairline border-alert-fg bg-alert-bg text-alert-fg rounded-xs p-3 text-13">
          Failed to refresh estimates: {error.message || String(error)}
        </div>
      )}

      <div className="grid gap-4 items-start grid-cols-1">
        <div className="min-w-0">
          <PipelineAnalytics
            estimates={estimates}
            activeFilter={filter}
            onFilterChange={setFilter}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
          />
          <WinLossSlicesCard />
          {/* Search — name / address / phone / email / reference. Sits
              under the Needs Attention strip so the operator can drill
              from "Going cold > 48h" into a specific customer fast. */}
          <div className="mb-3 relative">
            {" "}
            <input
              type="search"
              value={search}
              onChange={(ev) => setSearch(ev.target.value)}
              placeholder="Search by customer name, address, phone, email, or #ref"
              aria-label="Search estimates"
              className={cn(
                "w-full h-10 pl-10 pr-10 text-14 rounded-sm",
                "bg-white border-hairline border-zinc-300",
                "placeholder:text-ink-tertiary u-focus-ring",
              )}
            />{" "}
            <span
              className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-tertiary pointer-events-none"
              aria-hidden
            >
              {" "}
              <SlidersHorizontal size={16} strokeWidth={1.75} />{" "}
            </span>
            {search && (
              <button
                type="button"
                onClick={() => setSearch("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center justify-center h-7 w-7 rounded-full text-ink-tertiary hover:bg-zinc-100 u-focus-ring"
              >
                {" "}
                <X size={14} strokeWidth={1.75} aria-hidden />{" "}
              </button>
            )}{" "}
          </div>
          {/* Estimates list */}
          {filtered.length === 0 ? (
            <div className="p-10 text-center text-13 text-ink-secondary">
              No estimates{" "}
              {filter !== "all"
                ? `in "${estimateFilterLabel(filter) || filter}"`
                : "yet"}
              . Create or send an estimate before it appears here.
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              {filtered.map((e) => {
                const urgency = getUrgencyIndicator(e);
                const competitor = detectCompetitor(e.notes || e.description);
                const source = SOURCE_ICON[e.source];
                const previewHref = estimatePreviewHref(e);
                const amount = estimateAmountDisplay(e);
                const canSend = canSendEstimate(e);

                return (
                  <Card
                    key={e.id}
                    className={cn(
                      "p-4 flex flex-wrap items-center gap-3 relative",
                      e.isPriority && "border-alert-fg",
                    )}
                  >
                    {e.isPriority && (
                      <div className="absolute -top-px right-4 bg-alert-fg text-white text-11 uppercase tracking-label font-medium px-2 py-0.5 rounded-b-xs">
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
                          <button
                            type="button"
                            onClick={(evt) => {
                              evt.stopPropagation();
                              setCustomerPanelId(e.customerId);
                            }}
                            className="text-14 sm:text-14 font-medium text-zinc-900 bg-transparent border-0 p-0 cursor-pointer hover:underline"
                            title="Open customer + estimate history"
                          >
                            {e.customerName || "Unknown"}
                          </button>
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
                            setAuditTarget({ estimate: e, focus: "low_margin" })
                          }
                        />
                        <AutomationStatusBadge automation={e.automation} />
                        <LawnOutlineStatusBadge outline={e.lawnServiceOutline} />
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
                      <div className="text-13 sm:text-12 text-ink-secondary mt-0.5 truncate">
                        {e.address || "—"}
                        {e.serviceInterest ? ` · ${e.serviceInterest}` : ""}
                      </div>{" "}
                    </div>
                    {/* Call + text + send-estimate trailing buttons — matches the
                    CustomersPageV2 list row's icon trio. Send is shown for
                    states where it's a real action (draft / sent / viewed);
                    accepted/declined/expired hide it. */}
                    {(e.customerPhone ||
                      estimateHasLawnLine(e) ||
                      (["draft", "sent", "viewed"].includes(e.status) && canSend)) && (
                      <div className="flex gap-1.5">
                        <LawnOutlineQuickButton estimate={e} onClick={setOutlineTarget} compact />
                        {e.customerPhone && (
                          <button
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
                                    }),
                                  },
                                );
                                if (!r?.success)
                                  alert(
                                    "Call failed: " +
                                      (r?.error || "unknown error"),
                                  );
                              } catch (err) {
                                alert("Call failed: " + err.message);
                              }
                            }}
                            aria-label={`Call ${e.customerName || "customer"} via Waves`}
                            title="Call via Waves — rings your phone first, press 1 to connect"
                            className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
                          >
                            {" "}
                            <Phone size={16} strokeWidth={1.75} />{" "}
                          </button>
                        )}
                        {e.customerPhone && (
                          <a
                            href={`/admin/communications?phone=${encodeURIComponent(e.customerPhone)}`}
                            onClick={(evt) => evt.stopPropagation()}
                            aria-label={`Message ${e.customerName || "customer"}`}
                            title={`Message ${e.customerPhone}`}
                            className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
                          >
                            {" "}
                            <MessageSquare size={16} strokeWidth={1.75} />{" "}
                          </a>
                        )}
                        {/* Create-estimate icon — carries customer fields into the
                        new-estimate form via query string. Always shown when
                        we have a customerId so the operator can start a
                        follow-up quote without leaving the list. */}
                        {e.customerId && (
                          <button
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
                            className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
                          >
                            {" "}
                            <FilePlus2 size={16} strokeWidth={1.75} />{" "}
                          </button>
                        )}
                        {["draft", "sent", "viewed"].includes(e.status) && canSend && (
                          <button
                            type="button"
                            onClick={async (evt) => {
                              evt.stopPropagation();
                              const action =
                                e.status === "draft" ? "Send" : "Resend";
                              if (
                                !window.confirm(
                                  `${action} estimate to ${e.customerName || "customer"} via SMS + email?`,
                                )
                              )
                                return;
                              try {
                                await sendEstimateFromPipeline(e.id, "both");
                                refreshEstimates();
                              } catch (err) {
                                window.alert("Send failed: " + err.message);
                              }
                            }}
                            aria-label={`${e.status === "draft" ? "Send" : "Resend"} estimate to ${e.customerName || "customer"}`}
                            title={
                              e.status === "draft"
                                ? "Send estimate via SMS + email"
                                : "Resend estimate via SMS + email"
                            }
                            className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
                          >
                            {" "}
                            <Send size={16} strokeWidth={1.75} />{" "}
                          </button>
                        )}
                      </div>
                    )}
                    {e.tier && <Badge tone="neutral">{e.tier}</Badge>}
                    {/* Estimate amount */}
                    <div className="text-right min-w-[80px]">
                      {" "}
                      <div
                        className={cn(
                          "text-18 font-medium u-nums",
                          amount.value > 0
                            ? "text-zinc-900"
                            : "text-ink-tertiary",
                        )}
                      >
                        ${amount.value.toFixed(0)}
                        <span className="text-11 font-normal text-ink-tertiary">
                          {amount.suffix}
                        </span>{" "}
                      </div>{" "}
                    </div>
                    {/* Timeline */}
                    <div className="text-right min-w-[110px] text-11 text-ink-secondary space-y-0.5">
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
                    </div>
                    {/* Actions — flag toggle + primary status action(s) +
                    overflow menu. Secondary tools (toggles, audit, preview,
                    copy link, resend, archive, delete) live in the overflow
                    so the inline row stays scannable. */}
                    <div className="flex items-center gap-1.5 w-full sm:w-auto">
                      {" "}
                      <button
                        type="button"
                        onClick={() => togglePriority(e)}
                        disabled={isEstimateTogglePending(e.id, "isPriority")}
                        title={
                          e.isPriority ? "Remove priority" : "Flag as urgent"
                        }
                        aria-label={
                          e.isPriority ? "Remove priority" : "Flag as urgent"
                        }
                        className={cn(
                          "h-11 w-11 sm:h-9 sm:w-9 flex-shrink-0 flex items-center justify-center rounded-full sm:rounded-xs border-hairline u-focus-ring transition-colors",
                          isEstimateTogglePending(e.id, "isPriority") &&
                            "opacity-60 cursor-wait",
                          e.isPriority
                            ? "bg-alert-bg text-alert-fg border-alert-fg"
                            : "bg-white text-ink-secondary border-zinc-300 hover:bg-zinc-50",
                        )}
                      >
                        {" "}
                        <Flag size={16} strokeWidth={1.75} aria-hidden />{" "}
                      </button>{" "}
                      <div className="grid grid-cols-2 sm:flex sm:flex-none gap-1.5 flex-1 sm:flex-none">
                        {e.status === "draft" && canSend && (
                          <Button
                            size="sm"
                            variant="primary"
                            className="w-full sm:w-auto rounded-full whitespace-nowrap"
                            onClick={async () => {
                              try {
                                await sendEstimateFromPipeline(e.id, "both");
                                refreshEstimates();
                              } catch (err) {
                                window.alert("Send failed: " + err.message);
                              }
                            }}
                          >
                            Send
                          </Button>
                        )}

                        {(e.status === "sent" || e.status === "viewed") && (
                          <Button
                            size="sm"
                            variant="primary"
                            className="w-full sm:w-auto rounded-full whitespace-nowrap"
                            onClick={() => setFollowUpTarget(e)}
                          >
                            Follow Up
                          </Button>
                        )}

                        {canMarkEstimateWon(e) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full sm:w-auto rounded-full whitespace-nowrap"
                            onClick={() => markEstimateAccepted(e)}
                          >
                            Mark Won
                          </Button>
                        )}

                        {canMarkEstimateAnnualPrepay(e) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full sm:w-auto rounded-full whitespace-nowrap"
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
                              className="w-full sm:w-auto rounded-full whitespace-nowrap"
                              onClick={() => setScheduleEstimate(e)}
                            >
                              <CalendarPlus size={14} strokeWidth={1.75} className="mr-1" />
                              Schedule
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              className="w-full sm:w-auto rounded-full whitespace-nowrap"
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
                          </>
                        )}

                        {e.archivedAt && (
                          <Button
                            size="sm"
                            variant="secondary"
                            className="w-full sm:w-auto rounded-full whitespace-nowrap"
                            onClick={() => unarchiveEstimate(e)}
                          >
                            Unarchive
                          </Button>
                        )}

                        <RowActionsMenu
                          label={`Actions for ${e.customerName || "estimate"}`}
                          items={[
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
                            (e.status === "sent" ||
                              e.status === "viewed") &&
                              canSend && {
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
                            (e.status === "sent" ||
                              e.status === "viewed") &&
                              canSend && {
                              key: "resend",
                              label: "Resend estimate",
                              icon: <RotateCw size={16} strokeWidth={1.75} />,
                              onClick: async () => {
                                if (
                                  !confirm(
                                    `Resend estimate to ${e.customerName || "customer"} via SMS + email?`,
                                  )
                                )
                                  return;
                                try {
                                  await sendEstimateFromPipeline(e.id, "both");
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
                              onClick: () => markEstimateAnnualPrepayAccepted(e),
                            },
                            (e.status === "sent" ||
                              e.status === "viewed") && {
                              key: "copy-link",
                              label: "Copy estimate link",
                              icon: <LinkIcon size={16} strokeWidth={1.75} />,
                              onClick: () => {
                                const link = `${window.location.origin}/estimate/${e.token || e.id}`;
                                navigator.clipboard?.writeText(link);
                              },
                            },
                            estimateHasLawnLine(e) && {
                              key: "lawn-outline",
                              label: "Lawn service outline",
                              icon: (
                                <ClipboardList
                                  size={16}
                                  strokeWidth={1.75}
                                />
                              ),
                              onClick: () => setOutlineTarget(e),
                            },
                            {
                              key: "proposal",
                              label: "Commercial proposal",
                              icon: <FileText size={16} strokeWidth={1.75} />,
                              title:
                                "Build a multi-building line-item proposal PDF",
                              onClick: () => setProposalTarget(e),
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
                                setAuditTarget({ estimate: e, focus: "all" }),
                            },
                            previewHref && {
                              key: "preview",
                              label: "Preview customer view",
                              icon: (
                                <ExternalLink size={16} strokeWidth={1.75} />
                              ),
                              onClick: () =>
                                window.open(
                                  previewHref,
                                  "_blank",
                                  "noopener,noreferrer",
                                ),
                            },
                            (e.status === "sent" ||
                              e.status === "viewed") && {
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
                  </Card>
                );
              })}
            </div>
          )}
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
  { key: "leads", label: "Leads", Icon: Users },
  { key: "estimates", label: "Estimates", Icon: ClipboardList },
  { key: "new", label: "Create Estimate", Icon: FilePlus2 },
  { key: "pricing", label: "Pricing Logic", Icon: SlidersHorizontal },
];

const PREFILL_PARAM_KEYS = [
  "leadId",
  "customerId",
  "address",
  "customerName",
  "customerPhone",
  "customerEmail",
  "serviceInterest",
  "first_name",
  "last_name",
  "phone",
  "email",
  "service_interest",
];

// Mobile-only filter dimensions. FILTER reuses PIPELINE_FILTERS. DATE filters on
// createdAt relative to now. SORT controls row order; grouping is always by day.
const MOBILE_DATE_FILTERS = [
  { key: "all", label: "All" },
  { key: "today", label: "Today" },
  { key: "week", label: "This week" },
  { key: "month", label: "This month" },
  { key: "last30", label: "Last 30 days" },
];

const MOBILE_SORT_OPTIONS = [
  { key: "newest", label: "Newest" },
  { key: "oldest", label: "Oldest" },
  { key: "amount-desc", label: "Amount: high → low" },
  { key: "amount-asc", label: "Amount: low → high" },
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

function mobileSortFn(sortKey) {
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
  const active = options.find((o) => o.key === value) || options[0];

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <>
      {" "}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label}: ${active.label}`}
        className={cn(
          "inline-flex items-center gap-1.5 h-9 px-4 rounded-lg",
          "bg-zinc-100 border-hairline border-zinc-100",
          "text-13 text-zinc-600 u-focus-ring",
          "hover:bg-zinc-200 active:bg-zinc-200 whitespace-nowrap",
        )}
      >
        {" "}
        <span>{label}</span>{" "}
        <span className="font-medium text-zinc-900">{active.label}</span>{" "}
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            style={{ fontFamily: ROBOTO }}
          >
            {" "}
            <div
              className="absolute inset-0 bg-zinc-900/40"
              onClick={() => setOpen(false)}
            />{" "}
            <div
              className={cn(
                "relative w-full bg-white outline-none",
                "rounded-t-md sm:rounded-md sm:max-w-md",
                "border-hairline border-zinc-200",
                "flex flex-col max-h-[85vh]",
              )}
              style={{ paddingBottom: "env(safe-area-inset-bottom, 0)" }}
            >
              {" "}
              <div className="pt-2 pb-1 sm:hidden">
                {" "}
                <div className="mx-auto w-10 h-1 rounded-full bg-zinc-300" />{" "}
              </div>{" "}
              <div className="px-5 py-3 flex items-center justify-between border-b border-hairline border-zinc-200">
                {" "}
                <div className="text-11 uppercase tracking-label font-medium text-ink-tertiary">
                  {title}
                </div>{" "}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="h-9 w-9 flex items-center justify-center rounded-full bg-zinc-100 text-zinc-900 hover:bg-zinc-200 u-focus-ring"
                >
                  {" "}
                  <X size={16} strokeWidth={1.75} aria-hidden />{" "}
                </button>{" "}
              </div>{" "}
              <div className="flex-1 overflow-y-auto">
                {options.map((o) => {
                  const isActive = o.key === value;
                  return (
                    <button
                      key={o.key}
                      type="button"
                      onClick={() => {
                        onChange(o.key);
                        setOpen(false);
                      }}
                      className={cn(
                        "w-full flex items-center justify-between gap-3",
                        "px-5 py-4 text-left u-focus-ring",
                        "border-b border-hairline border-zinc-100 last:border-b-0",
                        isActive ? "bg-zinc-50" : "bg-white hover:bg-zinc-50",
                      )}
                    >
                      {" "}
                      <span
                        className={cn(
                          "text-14 tracking-tight",
                          isActive
                            ? "font-medium text-zinc-900"
                            : "text-zinc-700",
                        )}
                      >
                        {o.label}
                      </span>
                      {isActive && (
                        <Check
                          size={16}
                          strokeWidth={2}
                          className="text-zinc-900"
                          aria-hidden
                        />
                      )}
                    </button>
                  );
                })}
              </div>{" "}
            </div>{" "}
          </div>,
          document.body,
        )}
    </>
  );
}

// Status label color on mobile row. Draft = waves blue, alert = red,
// accepted = zinc-900, others fall back to ink-tertiary for low emphasis.
function mobileStatusClass(status) {
  if (status === "declined" || status === "expired") return "text-alert-fg";
  if (status === "accepted") return "text-zinc-900";
  if (
    status === "draft" ||
    status === "scheduled" ||
    status === "sent" ||
    status === "viewed"
  )
    return "text-waves-blue";
  return "text-ink-tertiary";
}

function canMarkEstimateWon(estimate) {
  if (!["sent", "viewed"].includes(estimate.status)) return false;
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
  return canMarkEstimateWon(estimate) && Number(estimate.monthlyTotal || 0) > 0;
}

// Row in the mobile list. Mirrors CustomersPageV2 directory row: 64px white
// bordered card, name + sub left, trailing Call / Text actions when phone is
// present. Row tap is currently a no-op — action sheet will land in a
// follow-up PR so this PR stays scoped to the list-view redesign per
// CLAUDE.md Rule 1/2.
function MobileEstimateRow({
  estimate,
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
  v3Flag = false,
}) {
  const navigate = useNavigate();
  const cfg = STATUS_CONFIG[estimate.status] || STATUS_CONFIG.draft;
  const amount = estimateAmountDisplay(estimate);
  const canSend = canSendEstimate(estimate);
  const customerName = estimate.customerName || "Unknown";
  const isDraftMuted = v3Flag && estimate.status === "draft";
  const hasCustomer = !!estimate.customerId;
  const openPanel = () => {
    if (hasCustomer) onOpenCustomerPanel?.(estimate.customerId);
  };
  return (
    <div
      // Row-level click only activates when the estimate is linked to a
      // customer. Showing cursor-pointer + hover shade on an unlinked
      // estimate reads as "this should open a panel" and then silently
      // does nothing on tap — that's been the root of the "customers
      // aren't clickable on mobile" complaint for unlinked rows.
      onClick={hasCustomer ? openPanel : undefined}
      role={hasCustomer ? "button" : undefined}
      tabIndex={hasCustomer ? 0 : undefined}
      onKeyDown={
        hasCustomer
          ? (e) => {
              if (e.key === "Enter" || e.key === " ") openPanel();
            }
          : undefined
      }
      className={cn(
        "bg-white border-hairline border-zinc-200 rounded-sm px-3 flex items-center gap-1.5",
        hasCustomer
          ? "cursor-pointer hover:bg-zinc-50 active:bg-zinc-100"
          : "cursor-default",
        isDraftMuted && "opacity-60",
      )}
      style={{ height: 64 }}
    >
      {" "}
      <div className="flex-1 min-w-0 flex flex-col gap-0.5">
        {hasCustomer ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              openPanel();
            }}
            // Underline-always (not hover:underline) so touch users see
            // the affordance — hover doesn't fire on mobile.
            className="text-14 font-medium text-blue-700 underline decoration-dotted underline-offset-2 truncate text-left bg-transparent border-0 p-0 cursor-pointer"
          >
            {customerName}
          </button>
        ) : (
          <div
            className="text-14 font-medium text-ink-primary truncate"
            title="This estimate isn't linked to a customer yet"
          >
            {customerName}
          </div>
        )}
        {v3Flag ? (
          <div className="flex items-center gap-2 flex-wrap">
            {" "}
            <span className="u-nums text-11 text-ink-tertiary">
              ${amount.value.toFixed(0)}{amount.suffix}
            </span>{" "}
            <StatusPillV3 status={estimate.status} />
            {estimate.viewCount > 1 && (
              <span
                className="u-nums text-11 text-ink-tertiary"
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
            <LawnOutlineStatusBadge outline={estimate.lawnServiceOutline} />
            {estimate.confirmedAppointment && (
              <span
                className="text-11 text-ink-tertiary truncate"
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
            <span className="u-nums text-11 text-ink-tertiary">
              #{shortEstimateRef(estimate.id)}
            </span>{" "}
          </div>
        ) : (
          <div className="text-11 text-ink-tertiary truncate">
            {" "}
            <span className="u-nums">${amount.value.toFixed(0)}{amount.suffix}</span>{" "}
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
                  ["manual_review_required", "generation_failed", "blocked"].includes(
                    estimate.automation?.status,
                  )
                    ? "text-alert-fg"
                    : "text-ink-tertiary",
                )}
                title={(estimate.automation?.review || []).join(" · ")}
              >
                {automationBadgeLabel(estimate.automation)}
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
                Outline {estimate.lawnServiceOutline.stale ? "stale" : estimate.lawnServiceOutline.ctaClickCount > 0 ? "clicked" : estimate.lawnServiceOutline.status || "draft"}
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
      </div>
      {estimate.customerPhone && (
        <button
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
                }),
              });
              if (!r?.success)
                alert("Call failed: " + (r?.error || "unknown error"));
            } catch (err) {
              alert("Call failed: " + err.message);
            }
          }}
          aria-label="Call via Waves"
          title="Call via Waves — rings your phone first, press 1 to connect"
          className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
        >
          {" "}
          <Phone size={16} strokeWidth={1.75} />{" "}
        </button>
      )}
      {estimate.customerPhone && (
        <a
          href={`/admin/communications?phone=${encodeURIComponent(estimate.customerPhone)}`}
          onClick={(e) => e.stopPropagation()}
          aria-label="SMS"
          className="inline-flex items-center justify-center h-11 w-11 sm:h-9 sm:w-9 border-hairline border-zinc-900 rounded-xs text-white bg-zinc-900 hover:bg-zinc-800"
        >
          {" "}
          <MessageSquare size={16} strokeWidth={1.75} />{" "}
        </a>
      )}
      <LawnOutlineQuickButton estimate={estimate} onClick={onLawnOutline} compact />
      {/* Trailing actions — Call + Text (when phone) + Overflow. All
      secondary actions live in the overflow sheet so the row stays a
      single 64px scan line. */}
      <RowActionsMenu
        label={`Actions for ${customerName}`}
        items={[
          ["draft", "sent", "viewed"].includes(estimate.status) && canSend && {
            key: "send",
            label: estimate.status === "draft" ? "Send estimate" : "Resend estimate",
            icon: <Send size={16} strokeWidth={1.75} />,
            onClick: async () => {
              const action = estimate.status === "draft" ? "Send" : "Resend";
              if (
                !window.confirm(
                  `${action} estimate to ${customerName} via SMS + email?`,
                )
              )
                return;
              try {
                await sendEstimateFromPipeline(estimate.id, "both");
                onSend?.();
              } catch (err) {
                window.alert("Send failed: " + err.message);
              }
            },
          },
          (estimate.status === "sent" ||
            estimate.status === "viewed" ||
            (estimate.status === "accepted" && !estimate.archivedAt)) && {
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
          (estimate.status === "sent" || estimate.status === "viewed") && {
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
          {
            key: "audit",
            label: "Audit pricing",
            icon: <SlidersHorizontal size={16} strokeWidth={1.75} />,
            onClick: () => onAudit?.(estimate, "all"),
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
    </div>
  );
}

// Mobile list view for /admin/estimates. Strict 1:1 on data + endpoint
// (GET /admin/estimates) with EstimatePipelineViewV2. KPI bar, Leads tab,
// and Pricing Logic tab are desktop-only by design.
function EstimatesMobileListView({ onNew, onCreateFromAddress }) {
  const v3Flag = useFeatureFlag("estimates_v2_status_pills");
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState("all");
  const [dateFilter, setDateFilter] = useState("all");
  const [customerPanelId, setCustomerPanelId] = useState(null);
  const [auditTarget, setAuditTarget] = useState(null);
  const [extendTarget, setExtendTarget] = useState(null);
  const [outlineTarget, setOutlineTarget] = useState(null);
  const [sort, setSort] = useState("newest");

  const refreshEstimates = useCallback(() => {
    setError(null);
    fetchEstimatePipelineRows(filter)
      .then((rows) => setEstimates(rows))
      .catch((err) => setError(err))
      .finally(() => setLoading(false));
  }, [filter]);

  useEffect(() => {
    setLoading(true);
    refreshEstimates();
  }, [refreshEstimates]);

  const markEstimateAccepted = useCallback(
    async (e) => {
      // A commercial proposal win auto-creates the customer when none is linked
      // and, in invoice mode, builds the first invoice from the proposal lines.
      const proposalInvoiceMode = !!e.isCommercialProposal && !!e.billByInvoice;
      const confirmMsg = proposalInvoiceMode
        ? `Mark ${e.customerName || "this proposal"} as won?\n\nThis stamps the proposal as won, creates the customer if none is linked, and creates the first invoice from the proposal line items (one-time items plus the first period of each recurring service). The customer is NOT texted and NOT auto-scheduled — ongoing recurring visits are billed as completed.`
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
        if (result?.proposalInvoice?.invoiceNumber) {
          notes.push(
            `Invoice ${result.proposalInvoice.invoiceNumber} for $${Number(
              result.proposalInvoice.total || 0,
            ).toFixed(2)} was created.`,
          );
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
      const annualAmount = e.annualTotal > 0
        ? e.annualTotal
        : (e.monthlyTotal || 0) * 12;
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
          window.alert(`Marked annual prepay accepted, but:\n\n${result.warnings.join("\n")}`);
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
        window.alert("Estimate needs a positive monthly or one-time total before it can be sent.");
        return;
      }
      if (
        !window.confirm(
          `Resend estimate to ${e.customerName || "the customer"} via SMS + email?`,
        )
      )
        return;
      try {
        await sendEstimateFromPipeline(e.id, "both");
        refreshEstimates();
      } catch (err) {
        window.alert("Send failed: " + err.message);
      }
    },
    [refreshEstimates],
  );

  const copyEstimateLinkMobile = useCallback((e) => {
    const link = `${window.location.origin}/estimate/${e.token || e.id}`;
    navigator.clipboard?.writeText(link);
  }, []);

  const groups = useMemo(() => {
    const now = Date.now();
    const q = search.trim().toLowerCase();
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
    if (q) {
      list = list.filter((e) => {
        const name = (e.customerName || "").toLowerCase();
        const ref = shortEstimateRef(e.id).toLowerCase();
        return name.includes(q) || ref.includes(q);
      });
    }
    const useV3Sort = v3Flag && sort === "v3";
    list = useV3Sort
      ? [...list].sort(v3SortFn)
      : [...list].sort(mobileSortFn(sort));

    // v3 sort breaks day-grouping (status rank wins, not date), so collapse
    // to a single group preserving the sorted order.
    if (useV3Sort) return [[0, list]];

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
  }, [estimates, search, filter, dateFilter, sort, v3Flag]);

  const filterCounts = useMemo(() => {
    if (v3Flag) return v3ChipCounts(estimates);
    const counts = { all: estimates.length };
    for (const f of PIPELINE_AND_RISK_FILTERS) {
      if (f.key === "all") continue;
      counts[f.key] = estimates
        .map((e) => ({ ...e, _class: classifyEstimateForPipeline(e) }))
        .filter((e) => estimateMatchesFilter(e, f.key)).length;
    }
    return counts;
  }, [estimates, v3Flag]);

  // Reset filter when the v3 flag flips; keep chronological ordering stable.
  useEffect(() => {
    setFilter("all");
  }, [v3Flag]);

  // Flat list across all days — mirrors CustomersPageV2 directory layout.
  const flat = useMemo(() => groups.flatMap(([, items]) => items), [groups]);

  return (
    // Mirrors CustomersPageV2: page padding comes from AdminLayout, no
    // edge-to-edge overrides, list rows are cards (not hairlined rows).
    <div style={{ fontFamily: ROBOTO }}>
      {/* Title row — matches the shared command header scale on mobile. */}
      <div
        className="md:sticky md:top-0 z-20 mb-5 bg-surface-page/95 pb-3"
        style={{ fontFamily: ROBOTO }}
      >
        <div className="overflow-hidden rounded-md border-hairline border-zinc-200 bg-white">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
            <h1
              className="m-0 text-22 font-medium text-zinc-900 tracking-normal"
              style={{ fontFamily: ROBOTO }}
            >
              Pipeline
            </h1>
            <button
              type="button"
              onClick={onNew}
              aria-label="Add estimate"
              className="flex items-center justify-center rounded-full bg-zinc-900 text-white u-focus-ring hover:bg-zinc-800"
              style={{ width: 36, height: 36 }}
            >
              <Plus size={20} strokeWidth={2} />
            </button>
          </div>
        </div>
      </div>
      {/* Search + Add/filter row — mirrors Customers mobile block. */}
      <div className="mb-3">
        {" "}
        <input
          type="search"
          inputMode="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by customer name or reference"
          aria-label="Search estimates"
          className="block w-full bg-white text-14 text-ink-primary border-hairline border-zinc-300 rounded-sm h-12 px-4 focus:outline-none focus:border-zinc-900 focus:ring-2 focus:ring-zinc-900"
        />{" "}
        <div className="mt-3 flex items-center gap-2 flex-wrap">
          {" "}
          <MobileChipSheet
            label="Filter"
            value={filter}
            onChange={setFilter}
            options={(v3Flag ? V3_CHIPS : PIPELINE_AND_RISK_FILTERS).map(
              (f) => ({
                ...f,
                label:
                  f.key === "all"
                    ? `All (${filterCounts.all || 0})`
                    : `${f.label} (${filterCounts[f.key] || 0})`,
              }),
            )}
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
                    { key: "v3", label: "Action Priority" },
                    ...MOBILE_SORT_OPTIONS,
                  ]
                : MOBILE_SORT_OPTIONS
            }
            title="Sort estimates"
          />{" "}
        </div>{" "}
      </div>
      {error && (
        <div className="mb-3 border-hairline border-alert-fg bg-alert-bg text-alert-fg rounded-xs p-3 text-13">
          Failed to load estimates: {error.message || String(error)}
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              refreshEstimates();
            }}
            className="ml-2 underline"
          >
            Retry
          </button>{" "}
        </div>
      )}

      {/* Result count — mirrors Customers */}
      <div className="u-nums text-11 text-ink-tertiary text-right mb-3 mt-3">
        {flat.length} result{flat.length !== 1 ? "s" : ""}
      </div>
      {/* List */}
      {loading ? (
        <div className="p-10 text-center text-13 text-ink-secondary">
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
            <div className="text-13 text-ink-tertiary">
              {estimates.length === 0
                ? "Create or send an estimate before it appears here"
                : "Try adjusting your filters"}
            </div>{" "}
          </CardBody>{" "}
        </Card>
      ) : (
        <div className="flex flex-col gap-2">
          {flat.map((e) => (
            <MobileEstimateRow
              key={e.id}
              estimate={e}
              onCreateFromAddress={onCreateFromAddress}
              onOpenCustomerPanel={setCustomerPanelId}
              onSend={refreshEstimates}
              onMarkAccepted={markEstimateAccepted}
              onMarkAnnualPrepayAccepted={markEstimateAnnualPrepayAccepted}
              onDeleted={refreshEstimates}
              onAudit={(estimate, focus = "all") =>
                setAuditTarget({ estimate, focus })
              }
              onSendBooking={sendBookingLink}
              onArchive={archiveEstimateMobile}
              onUnarchive={unarchiveEstimateMobile}
              onDeleteDraft={deleteDraftMobile}
              onResend={resendEstimateMobile}
              onCopyLink={copyEstimateLinkMobile}
              onExtend={setExtendTarget}
              onLawnOutline={setOutlineTarget}
              v3Flag={v3Flag}
            />
          ))}
        </div>
      )}

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

export default function EstimatesPageV2() {
  const isMobile = useIsMobile(768);
  const [searchParams, setSearchParams] = useSearchParams();
  const readLeadPrefill = useCallback((params) => {
    const legacyName = [params.get("first_name"), params.get("last_name")]
      .filter(Boolean)
      .join(" ")
      .trim();
    return {
      leadId: params.get("leadId") || "",
      customerId: params.get("customerId") || "",
      address: params.get("address") || "",
      customerName: params.get("customerName") || legacyName,
      customerPhone: params.get("customerPhone") || params.get("phone") || "",
      customerEmail: params.get("customerEmail") || params.get("email") || "",
      serviceInterest:
        params.get("serviceInterest") || params.get("service_interest") || "",
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
    prefill.serviceInterest
  );
  const initialTab = TABS.some((t) => t.key === searchParams.get("tab"))
    ? searchParams.get("tab")
    : null;

  const [activeTab, setActiveTab] = useState(
    initialTab || (hasPrefill ? "new" : "leads"),
  );
  const [mobileView, setMobileView] = useState(
    initialTab === "new" || hasPrefill ? "new" : "list",
  ); // 'list' | 'new'

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
      incoming.serviceInterest
    );
    const tabParam = searchParams.get("tab");
    const hasTabParam = TABS.some((t) => t.key === tabParam);
    if (!hasIncoming && !hasTabParam) return;
    if (hasIncoming) {
      setPrefill(incoming);
      setActiveTab("new");
      setMobileView("new");
    } else if (hasTabParam) {
      setActiveTab(tabParam);
      setMobileView(tabParam === "new" ? "new" : "list");
    }
    if (hasIncoming) {
      const stripped = new URLSearchParams(searchParams);
      PREFILL_PARAM_KEYS.forEach((k) => stripped.delete(k));
      stripped.delete("tab");
      setSearchParams(stripped, { replace: true });
    }
  }, [searchParams, setSearchParams, readLeadPrefill]);

  function clearPrefill() {
    setPrefill({
      leadId: "",
      customerId: "",
      address: "",
      customerName: "",
      customerPhone: "",
      customerEmail: "",
      serviceInterest: "",
    });
  }

  const selectTab = useCallback(
    (key) => {
      setActiveTab(key);
      const next = new URLSearchParams(searchParams);
      PREFILL_PARAM_KEYS.forEach((k) => next.delete(k));
      if (key === "leads") next.delete("tab");
      else next.set("tab", key);
      setSearchParams(next, { replace: false });
    },
    [searchParams, setSearchParams],
  );

  // Mobile: list (default) + create-estimate flow. Leads + Pricing Logic are
  // desktop-only per CLAUDE.md Rule 1 (mobile IA scope confirmed with owner).
  if (isMobile) {
    if (mobileView === "new") {
      return (
        <div style={{ fontFamily: ROBOTO }}>
          {" "}
          <button
            type="button"
            onClick={() => {
              setMobileView("list");
              clearPrefill();
            }}
            aria-label="Back to estimates"
            className="inline-flex items-center gap-1 mb-3 h-9 px-2 -ml-2 rounded-md text-14 text-zinc-700 hover:bg-zinc-100 u-focus-ring"
          >
            {" "}
            <ArrowLeft size={18} strokeWidth={1.75} aria-hidden />
            Back
          </button>{" "}
          <EstimateToolViewV2
            initialLeadId={prefill.leadId}
            initialCustomerId={prefill.customerId}
            initialAddress={prefill.address}
            initialCustomerName={prefill.customerName}
            initialCustomerPhone={prefill.customerPhone}
            initialCustomerEmail={prefill.customerEmail}
            initialServiceInterest={prefill.serviceInterest}
          />{" "}
        </div>
      );
    }
    return (
      <EstimatesMobileListView
        onNew={() => {
          clearPrefill();
          setMobileView("new");
        }}
        onCreateFromAddress={(addr) => {
          setPrefill({
            leadId: "",
            customerId: "",
            address: addr || "",
            customerName: "",
            customerPhone: "",
            customerEmail: "",
            serviceInterest: "",
          });
          setMobileView("new");
        }}
      />
    );
  }

  return (
    <div style={{ fontFamily: ROBOTO }}>
      {" "}
      <PipelineCommandHeader activeTab={activeTab} onTabChange={selectTab} />
      {activeTab === "leads" && <LeadsSection />}
      {activeTab === "estimates" && <EstimatePipelineViewV2 />}
      {activeTab === "new" && (
        <EstimateToolViewV2
          initialLeadId={prefill.leadId}
          initialCustomerId={prefill.customerId}
          initialAddress={prefill.address}
          initialCustomerName={prefill.customerName}
          initialCustomerPhone={prefill.customerPhone}
          initialCustomerEmail={prefill.customerEmail}
          initialServiceInterest={prefill.serviceInterest}
        />
      )}
      {activeTab === "pricing" && (
        <>
          {" "}
          <MarginCalculator /> <PricingLogicPanel />{" "}
        </>
      )}
    </div>
  );
}
