/**
 * Customer360ProfileV2.jsx
 * client/src/components/admin/Customer360ProfileV2.jsx
 *
 * Monochrome rewrite of Customer360Profile (PR #4c).
 * Strict 1:1 with V1 on:
 *   - endpoints (GET /admin/customers/:id, /timeline, /autopay-state;
 *     POST /admin/communications/sms, /admin/customers/:id/refund,
 *     /admin/customers/:id/charge-now)
 *   - state (data, loading, activeTab, timelineFilter, smsReply, sendingSms)
 *   - tabs (overview / services / billing / contracts / comms / property / compliance)
 *   - slide-out overlay structure + ESC handler
 *   - mobile sticky-bottom CustomerActionBar (standalone)
 *
 * Visual changes vs V1:
 *   - Tailwind zinc ramp + components/ui primitives (Card, Badge, Button)
 *   - Hairline borders, no colored tinted backgrounds
 *   - alert-fg reserved for: overdue balance, expiring card, refund/failed
 *     payments, at_risk/churned stage, health score < 40
 *   - Tier collapses to neutral Badge (no purple/gold/teal)
 *   - Operational summary uses recorded billing and communication facts
 *
 * Audit focus:
 * - Six tabs each fetch their own data on mount/switch — confirm we
 *   don't re-fetch on every re-render (useEffect deps), and that
 *   switching tabs back doesn't re-flicker if data is already cached
 *   in component state.
 * - Slide-out lifecycle: ESC handler should detach on unmount, clicks
 *   on the overlay should close cleanly, focus should return to the
 *   row that opened the panel.
 * - SMS reply submit (POST /communications/sms): must be
 *   debounced or single-flight so a double-click doesn't double-send.
 *   Also: empty / whitespace-only message should not submit.
 * - Refund / charge-now (POST /:id/refund, /:id/charge-now): these
 *   are real money operations. Confirm they require explicit
 *   confirmation before fire and that error states surface clearly
 *   (e.g. Stripe declined → not silently swallowed).
 * - alert-fg coverage: the spec reserves red for overdue balance,
 *   expiring card, refund/failed payments, at_risk/churned stage,
 *   health < 40. Verify nothing else in the V2 paint accidentally
 *   uses alert-fg as decoration.
 * - Mobile sticky CustomerActionBar: when an action sheet opens
 *   (call, SMS, follow-up), confirm the ActionBar doesn't double-
 *   stack with the underlying sheet's own buttons.
 * - Timeline filter: SMS / calls / notes filter on the timeline tab.
 *   Switching filter should clear stale rows / not mix categories.
 */

import { useState, useEffect, useRef, useId, useCallback, lazy, Suspense } from "react";
import { useIntelligenceBarActions, usePublishIntelligenceBarPageData } from "../../hooks/useIntelligenceBarPageData";
import { createPortal } from "react-dom";
import "./customer360-workspace.css";
import AddressAutocomplete, { sameAutocompleteAddress } from "../AddressAutocomplete";
import {
  ArrowUpRight,
  ChevronDown,
  Bell,
  CheckCircle2,
  ChevronLeft,
  Copy,
  CreditCard,
  Droplets,
  FileText,
  Link2,
  Mail,
  MessageSquare,
  MoreHorizontal,
  MapPin,
  Phone,
  PenLine,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Trash2,
  XCircle,
} from "lucide-react";
import { CustomerActionBar, customerEstimateHref } from "./StickyActionBar";
import Customer360Sections, { CUSTOMER_360_SECTIONS, CUSTOMER_WORKSPACE_SECTIONS } from "./Customer360Sections";
import Customer360Activity from "./Customer360Activity";
import Customer360Summary from "./Customer360Summary";
import Customer360Estimates from "./Customer360Estimates";
import useUnreadConversations from "../../hooks/useUnreadConversations";
import { formatETDateOnly } from "../../lib/timezone";
import useModalFocus from "../../hooks/useModalFocus";
import AuthenticatedCallAudio from "./AuthenticatedCallAudio";
import OwedCommitmentsSummary from "./OwedCommitmentsSummary";
import { formatAddress } from "../../utils/format-address";
import { Textarea,
  Card,
  CardBody,
  Badge,
  Button,
  buttonStyles,
  UiSurface,
  useUiDensity,
  inputStyles,
  ActionFeedback,
  Input,
  Select,
  Switch,
  Sheet,
  SheetHeader,
  SheetBody,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  cn,
} from "../ui";

// Invoice status tone, shared by the Overview list and the Billing table.
// alert-fg is reserved for overdue (header contract); paid/prepaid read
// strong; draft and void are neutral, not alarms. Nothing flips a stored
// status to 'overdue' — the late-payment checker treats a sent/viewed
// invoice as overdue by due_date (created_at when due_date is null) past a
// 7-day grace, so this mirrors that predicate on the raw rows.
const OVERDUE_GRACE_MS = 7 * 86400000;
export function invoiceStatusTone(inv, now = Date.now()) {
  const status = inv?.status;
  if (status === "paid" || status === "prepaid") return "strong";
  if (status === "overdue") return "alert";
  if (status === "sent" || status === "viewed") {
    const ref = inv.due_date || inv.created_at;
    const t = ref ? new Date(ref).getTime() : NaN;
    if (Number.isFinite(t) && t <= now - OVERDUE_GRACE_MS) return "alert";
  }
  return "neutral";
}
const INVOICE_STATUS_TEXT = {
  alert: "text-alert-fg",
  strong: "text-zinc-900",
  neutral: "text-ink-secondary",
};
import CallBridgeLink, { callViaBridge } from "./CallBridgeLink";
import CustomerRequestsPanel from "./CustomerRequestsPanel";
import CustomerPropertiesPanelV2 from "./CustomerPropertiesPanelV2";
import CancelPlanDialog from "./CancelPlanDialog";
import { CONTACT_ROLE_OPTIONS, contactRoleLabel, contactRoleTitle } from "../../lib/contact-roles";
import { ZoneMarkingStep, StationMarkingStep } from "../../pages/admin/SchedulePage";
import { useFeatureFlagReady } from "../../hooks/useFeatureFlag";
import { describeAutopaySetupLinkResult } from "../schedule/cardLinkStatus";
import {
  CONSENT_TEXT,
  CONSENT_VERSION,
} from "../../lib/paymentMethodConsentText";

// Reuse the Communications composer without loading the whole Messages page
// until a profile opens Comms. Its send, attachment, and AI guards stay shared.
const CustomerMessageMedia = lazy(() => import("../../pages/admin/CommunicationsPageV2").then((module) => ({ default: module.MessageMediaV2 })));
const CustomerSmsComposer = lazy(() => import("../../pages/admin/CommunicationsPageV2").then((module) => ({ default: module.SmsTab })));

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
        serverMsg =
          body?.error || body?.reason || body?.message || body?.code || "";
      } catch {
        try {
          serverMsg = (await r.text()).trim();
        } catch {
          /* ignore */
        }
      }
      const err = new Error(serverMsg || `HTTP ${r.status}`);
      err.status = r.status;
      // Structured refusals (e.g. the annual-prepay mint's 409 naming an
      // owed setup + anchor) ride along so a caller can act on them.
      try { err.body = await r.clone().json(); } catch { /* not JSON */ }
      throw err;
    }
    if (r.status === 204) return null;
    return r.json();
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return "";
  const mins = Math.floor((Date.now() - new Date(dateStr)) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function fmtDate(d) {
  if (!d) return "—";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(d))) {
    return new Date(`${d}T12:00:00`).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  return new Date(d).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// Postgres DATE columns (service_date, scheduled_date, payment_date) arrive
// as UTC midnight ISO strings; fmtDate would render them in browser-local
// time, a day early for every ET viewer. Anchor the calendar day instead.
function fmtDateOnly(d) {
  if (!d) return "—";
  return (
    formatETDateOnly(d, { month: "short", day: "numeric", year: "numeric" }) ||
    "—"
  );
}

function fmtCurrency(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(v));
}
function dateInputValue(value) {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return String(value).slice(0, 10);
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}
function todayDateInput() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
function addDaysInput(value, days) {
  const d = new Date(`${dateInputValue(value) || todayDateInput()}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}
function addMonthsInput(value, months) {
  const text = dateInputValue(value) || todayDateInput();
  const [year, month, day] = text.split("-").map(Number);
  const monthIndex = month - 1 + Number(months || 0);
  const targetYear = year + Math.floor(monthIndex / 12);
  const targetMonthIndex = ((monthIndex % 12) + 12) % 12;
  const targetMonth = targetMonthIndex + 1;
  const lastDay = new Date(Date.UTC(targetYear, targetMonth, 0, 12)).getUTCDate();
  return `${targetYear}-${String(targetMonth).padStart(2, "0")}-${String(Math.min(day, lastDay)).padStart(2, "0")}`;
}
function defaultAnnualPrepayStart(activeTerm) {
  const today = todayDateInput();
  const end = dateInputValue(activeTerm?.termEnd);
  // A payment_pending term that STILL covers today is sent-but-unpaid: anchor a
  // new term at its start (not term_end + 1) so the server overlap guard rejects
  // stacking a second paid term beyond the open invoice (forcing the admin to
  // resolve the outstanding invoice). An EXPIRED pending window (term_end before
  // today) is moot — fall through to the normal default so a fresh prepay isn't
  // blocked by a stale unpaid row.
  if (activeTerm?.status === "payment_pending" && end && end >= today) {
    return dateInputValue(activeTerm.termStart) || today;
  }
  return end && end >= today ? addDaysInput(end, 1) : today;
}
function getAdminRole() {
  try {
    return (
      JSON.parse(localStorage.getItem("waves_admin_user") || "{}")?.role || null
    );
  } catch {
    return null;
  }
}
function fmtNumber(v, digits = 3) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "0";
  return n.toFixed(digits).replace(/\.?0+$/, "");
}

function parseStructuredNotes(value) {
  if (!value) return {};
  if (typeof value === "object") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function labelFromKey(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function projectReportUrlFromNotes(notes = {}) {
  const report = notes.projectReport || {};
  if (report.url) return report.url;
  if (report.token) return `/report/project/${report.token}`;
  return null;
}

function approvalCodeLabel(code) {
  return String(code || "")
    .replace(/^repeat_/, "repeat ")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function inventoryAuditAmount(item) {
  const deducted = String(item.status || "").startsWith("deducted");
  if (!deducted) return "No deduction";
  const amount = item.deductedAmount ?? item.deducted_amount;
  return `${fmtNumber(amount, 4)} ${item.inventoryUnit || item.inventory_unit || item.unit || ""}`.trim();
}

const ANNUAL_PREPAY_CADENCE_OPTIONS = [
  { value: "monthly", label: "Monthly", visits: 12 },
  { value: "bimonthly", label: "Every 2 months", visits: 6 },
  { value: "quarterly", label: "Quarterly", visits: 4 },
  { value: "triannual", label: "Every 4 months", visits: 3 },
  { value: "semiannual", label: "Semiannual", visits: 2 },
  { value: "every_6_weeks", label: "Every 6 weeks", visits: 9 },
  { value: "annual", label: "Annual", visits: 1 },
];

const ANNUAL_PREPAY_CADENCE_VISITS = Object.fromEntries(
  ANNUAL_PREPAY_CADENCE_OPTIONS.map((option) => [option.value, String(option.visits)]),
);

function inferAnnualPrepayCadenceFromLabel(value) {
  const text = String(value || "").toLowerCase();
  if (/\bevery\s*6\s*weeks?\b|\b6\s*weeks\b|\b42\s*days\b/.test(text)) return "every_6_weeks";
  if (/\bbi[-\s]?monthly\b|\bevery\s*2\s*months?\b/.test(text)) return "bimonthly";
  if (/\bquarterly\b|\bevery\s*3\s*months?\b/.test(text)) return "quarterly";
  if (/\btri[-\s]?annual\b|\bevery\s*4\s*months?\b/.test(text)) return "triannual";
  if (/\bsemi[-\s]?annual\b|\bevery\s*6\s*months?\b/.test(text)) return "semiannual";
  if (/\bmonthly\b/.test(text)) return "monthly";
  if (/\bannual\b|\byearly\b|\bevery\s*12\s*months?\b/.test(text)) return "annual";
  return null;
}

function annualPrepayCadencePrefix(cadence) {
  const normalized = inferAnnualPrepayCadenceFromLabel(cadence) || String(cadence || "").toLowerCase();
  if (normalized === "monthly") return "Monthly";
  if (normalized === "bimonthly") return "Every 2 months";
  if (normalized === "quarterly") return "Quarterly";
  if (normalized === "triannual") return "Every 4 months";
  if (normalized === "semiannual") return "Semiannual";
  if (normalized === "every_6_weeks") return "Every 6 weeks";
  if (normalized === "annual") return "Annual";
  return null;
}

function normalizeAnnualPrepayLabelKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/\bevery\s*(?:(?:2|3|4|6|12)\s*months?|6\s*weeks?)\b/g, " ")
    .replace(/\b(every|monthly|bimonthly|bi-monthly|quarterly|triannual|semiannual|semi-annual|annual|yearly|six|weeks?|days?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "")
    .trim();
}

function annualPrepayLabelsMatch(left, right) {
  const a = normalizeAnnualPrepayLabelKey(left);
  const b = normalizeAnnualPrepayLabelKey(right);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

function formatAnnualPrepayServiceLabel(baseLabel, cadence) {
  const base = String(baseLabel || "").trim();
  if (!base) return "";

  const prefix = annualPrepayCadencePrefix(cadence);
  if (!prefix) return base;

  const existingCadence = inferAnnualPrepayCadenceFromLabel(base);
  if (existingCadence === inferAnnualPrepayCadenceFromLabel(cadence)) return base;

  const stripped = base
    .replace(/^(monthly|bi[-\s]?monthly|quarterly|tri[-\s]?annual|semi[-\s]?annual|annual|yearly|every\s*6\s*weeks?)\s+/i, "")
    .trim();
  return `${prefix} ${stripped || base}`;
}

function inferAnnualPrepayServiceBase(customer, activeTerm = null, prepaidPlans = []) {
  const activeLabel = activeTerm?.coverageServiceType || activeTerm?.planLabel || "";
  if (activeLabel) return activeLabel.replace(/\s+Annual Prepay$/i, "").trim();

  const matchingPlan = Array.isArray(prepaidPlans) && prepaidPlans.length > 0
    ? prepaidPlans.find((plan) => String(plan?.serviceType || "").trim())
    : Array.isArray(customer?.prepaidPlans)
      ? customer.prepaidPlans.find((plan) => String(plan?.serviceType || "").trim())
      : null;
  if (matchingPlan?.serviceType) return String(matchingPlan.serviceType).trim();

  const serviceTypes = String(customer?.serviceTypes || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  if (serviceTypes.length > 0) return serviceTypes[0];

  return "Pest Control";
}

function deriveAnnualPrepayServiceOptions(customer, activeTerm = null, prepaidPlans = [], annualPrepayTerms = []) {
  const seen = new Set();
  const options = [];
  const push = (label, source = "saved") => {
    const text = String(label || "").trim();
    if (!text) return;
    const key = normalizeAnnualPrepayLabelKey(text);
    if (!key || seen.has(key)) return;
    seen.add(key);
    options.push({ value: text, label: text, source });
  };

  push(activeTerm?.coverageServiceType, "active_term");
  push(activeTerm?.planLabel?.replace(/\s+Annual Prepay$/i, ""), "active_term");

  const activeService = annualPrepayTerms.find((term) => term?.status === "active" && term?.coverageServiceType);
  push(activeService?.coverageServiceType, "active_term");

  for (const plan of prepaidPlans || []) {
    push(plan?.serviceType, "prepaid_plan");
  }
  for (const term of annualPrepayTerms || []) {
    push(term?.coverageServiceType, "annual_term");
    push(term?.planLabel?.replace(/\s+Annual Prepay$/i, ""), "annual_term");
  }

  for (const service of String(customer?.serviceTypes || "").split(",")) {
    push(service, "customer_services");
  }

  if (!options.length) {
    push("Pest Control", "fallback");
  }

  return options;
}

// The amount field POSTs a PRE-TAX service amount, but a term's stored
// prepayAmount is the tax-inclusive invoice total for commercial prepays (the
// per-visit coverage credit is applied after tax). When renewing/defaulting from
// an existing term, prefer the linked invoice's pre-tax subtotal so the next
// invoice isn't taxed twice; fall back to prepayAmount for terms with no recorded
// subtotal (e.g. residential, where subtotal === total, or legacy rows).
function annualPrepayPretaxBase(term) {
  if (!term) return 0;
  const subtotal = Number(term.prepayInvoiceSubtotal);
  if (subtotal > 0) {
    // The first prepay's one-time bait-station setup rides its invoice
    // subtotal but is NOT renewal coverage (codex #3591 r72 P1) — the
    // renewal default must be coverage-only or it silently re-charges the
    // $99 as unlabeled recurring money. The share comes from the immutable
    // claim ledger via the term payload.
    const setupShare = Number(term.prepaySetupFeeAmount) || 0;
    const coverage = Math.round((subtotal - setupShare) * 100) / 100;
    if (coverage > 0) return coverage;
    return subtotal;
  }
  return Number(term.prepayAmount) || 0;
}

// A term that is current for renewal-amount defaulting: truly active OR moved to
// renewal_pending by the reminder flow (the renewal modals are opened for that
// term, so its pre-tax invoice subtotal is the correct default base).
const ANNUAL_PREPAY_CURRENT_STATUSES = ["active", "renewal_pending"];

function inferAnnualPrepaySuggestedAmount(customer, serviceType, coverageCadence, activeTerm = null, prepaidPlans = []) {
  const matchingActiveTerm = activeTerm && ANNUAL_PREPAY_CURRENT_STATUSES.includes(activeTerm.status) && annualPrepayLabelsMatch(
    activeTerm.coverageServiceType || activeTerm.planLabel || "",
    serviceType,
  )
    ? activeTerm
    : null;
  const matchingActiveBase = annualPrepayPretaxBase(matchingActiveTerm);
  if (matchingActiveBase > 0) return matchingActiveBase;

  const activeTermMatch = Array.isArray(customer?.annualPrepayTerms)
    ? customer.annualPrepayTerms.find((term) => {
      const termLabel = term?.coverageServiceType || term?.planLabel || "";
      return ANNUAL_PREPAY_CURRENT_STATUSES.includes(term?.status) && annualPrepayLabelsMatch(termLabel, serviceType);
    })
    : null;
  const activeTermMatchBase = annualPrepayPretaxBase(activeTermMatch);
  if (activeTermMatchBase > 0) return activeTermMatchBase;

  const matchingPlan = Array.isArray(prepaidPlans) && prepaidPlans.length > 0
    ? prepaidPlans.find((plan) => annualPrepayLabelsMatch(plan?.serviceType, serviceType))
    : Array.isArray(customer?.prepaidPlans)
      ? customer.prepaidPlans.find((plan) => annualPrepayLabelsMatch(plan?.serviceType, serviceType))
      : null;
  if (matchingPlan?.seriesTotal > 0) return Number(matchingPlan.seriesTotal);

  const annualValue = Number(customer?.annualValue || 0);
  if (annualValue > 0) return annualValue;

  const monthlyRate = Number(customer?.monthlyRate || 0);
  if (monthlyRate > 0) return monthlyRate * 12;

  const cadence = String(coverageCadence || "").toLowerCase();
  if (cadence === "every_6_weeks") return monthlyRate > 0 ? monthlyRate * 12 : 0;

  return 0;
}

function inferAnnualPrepayInitialCadence(activeTerm = null, prepaidPlans = []) {
  const activeCadence = String(activeTerm?.coverageCadence || "").trim();
  if (activeCadence) return activeCadence;

  const planPattern = String(prepaidPlans[0]?.recurringPattern || "").trim();
  if (planPattern && planPattern !== "custom") {
    return inferAnnualPrepayCadenceFromLabel(planPattern) || planPattern;
  }

  const planServiceLabel = String(prepaidPlans[0]?.serviceType || "").trim();
  return inferAnnualPrepayCadenceFromLabel(planServiceLabel) || "quarterly";
}

const STAGE_LABELS = {
  new_lead: "New Lead",
  contacted: "Contacted",
  estimate_sent: "Est. Sent",
  estimate_viewed: "Est. Viewed",
  follow_up: "Follow Up",
  won: "Won",
  active_customer: "Active",
  at_risk: "At Risk",
  churned: "Churned",
  past_customer: "Past Customer",
  lost: "Lost",
  dormant: "Dormant",
};

// ─── Health Score Circle (monochrome) ────────────────────────────
function HealthCircle({ score }) {
  if (score == null) return null;
  const stroke = score >= 70 ? "#10B981" : score >= 40 ? "#F59E0B" : "#C8312F";
  const r = 18,
    circ = 2 * Math.PI * r,
    offset = circ - (score / 100) * circ;
  return (
    <svg width={44} height={44} viewBox="0 0 44 44" className="flex-shrink-0">
      {" "}
      <circle
        cx={22}
        cy={22}
        r={r}
        fill="none"
        stroke="#E4E4E7"
        strokeWidth={3}
      />{" "}
      <circle
        cx={22}
        cy={22}
        r={r}
        fill="none"
        stroke={stroke}
        strokeWidth={3}
        strokeDasharray={circ}
        strokeDashoffset={offset}
        strokeLinecap="round"
        transform="rotate(-90 22 22)"
      />{" "}
      <text
        x={22}
        y={26}
        textAnchor="middle"
        fill={stroke}
        fontSize={12}
        fontWeight={500}
        className="u-nums"
        fontFamily="ui-monospace, monospace"
      >
        {score}
      </text>{" "}
    </svg>
  );
}


const TIER_STYLES = {
  Platinum: { backgroundColor: "#E5E7EB", color: "#1F2937" },
  Gold: { backgroundColor: "#D4A017", color: "#FFFFFF" },
  Silver: { backgroundColor: "#9CA3AF", color: "#FFFFFF" },
  Bronze: { backgroundColor: "#A16207", color: "#FFFFFF" },
};
function TierBadgeV2({ tier }) {
  if (!tier) return <Badge tone="neutral">No Plan</Badge>;
  const style = TIER_STYLES[tier];
  if (!style) return <Badge tone="neutral">{tier}</Badge>;
  return (
    <Badge tone="neutral" style={style}>
      {tier}
    </Badge>
  );
}

// ─── Stage badge — green for active customers, red for everything else ───
function StageBadgeV2({ stage }) {
  const label = STAGE_LABELS[stage] || stage;
  const isActive = stage === "active_customer" || stage === "won";
  const style = isActive
    ? { backgroundColor: "#10B981", color: "#FFFFFF" }
    : { backgroundColor: "#C8312F", color: "#FFFFFF" };
  return (
    <Badge tone="neutral" style={style}>
      {label}
    </Badge>
  );
}

// ─── Section title ───────────────────────────────────────────────
function SectionTitle({ children, className }) {
  return (
    <div className={cn("c360-section-heading ui-label text-ink-secondary mb-2", className)}>
      {children}
    </div>
  );
}

// ─── Stat card (alert color only for overdue balances) ───────────
function StatCardV2({ label, value, alert }) {
  return (
    <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-3 text-center">
      {" "}
      <div className="ui-label text-ink-secondary mb-1">{label}</div>{" "}
      <div
        className={cn(
          "u-nums text-16 font-medium tracking-tight",
          alert ? "text-alert-fg" : "text-zinc-900",
        )}
      >
        {value}
      </div>{" "}
    </div>
  );
}

function sourceLabel(source) {
  const labels = {
    pay_page: "Payment page",
    onboarding: "Setup",
    portal_add_card: "Customer portal",
    admin_tap_to_pay: "Admin tap to pay",
    contract_signing: "Contract signing",
    backfill: "Backfill",
  };
  return labels[source] || String(source || "Unknown").replace(/_/g, " ");
}

const FLORIDA_COMPLIANCE_ITEMS = [
  {
    title: "Automatic renewal disclosure",
    body: "Service contracts with automatic renewal terms should disclose those terms clearly and conspicuously. For covered 12-month-plus contracts that renew for more than one month, send renewal notice 30-60 days before the cancellation deadline and support cancellation through the same acceptance method.",
    citation: "Fla. Stat. 501.165",
    href: "https://www.flsenate.gov/Laws/Statutes/2025/501.165",
  },
  {
    title: "No unfair or deceptive billing practice",
    body: "Keep payment timing, saved-payment use, processing fees, cancellation, and revocation terms easy to understand so the billing practice does not create avoidable FDUTPA risk.",
    citation: "Fla. Stat. 501.204",
    href: "https://www.leg.state.fl.us/statutes/index.cfm/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.204.html",
  },
  {
    title: "Electronic signature record",
    body: "Capture the customer's intent to sign electronically and retain the electronic record, signature, initials, IP address, user agent, timestamp, and exact contract snapshot.",
    citation: "Fla. Stat. 668.50",
    href: "https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0600-0699/0668/Sections/0668.50.html",
  },
  {
    title: "Personal information security",
    body: "Use reasonable safeguards for electronic personal information and retain only processor-safe payment tokens. Do not treat this admin contract view as a place to store raw card data.",
    citation: "Fla. Stat. 501.171",
    href: "https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0500-0599/0501/Sections/0501.171.html",
  },
];

function paymentMethodLabel(method) {
  if (!method) return "No payment method selected";
  const methodType = method.methodType || method.method_type;
  if (methodType === "ach" || methodType === "us_bank_account") {
    return `${method.bankName || method.bank_name || "Bank account"} ending ${method.lastFour || method.bank_last_four || "—"}`;
  }
  const brand = method.cardBrand || method.card_brand || "Card";
  const lastFour = method.lastFour || method.last_four || "—";
  return `${brand} ending ${lastFour}`;
}

function ContractMeta({ label, value }) {
  return (
    <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2">
      {" "}
      <div className="ui-label text-ink-tertiary mb-1">{label}</div>{" "}
      <div className="text-ui-body text-zinc-900 break-words">
        {value || "—"}
      </div>{" "}
    </div>
  );
}

function contractStatusTone(status) {
  if (status === "signed") return "strong";
  if (status === "cancelled" || status === "voided") return "alert";
  return "neutral";
}

function contractStatusLabel(status) {
  return String(status || "draft")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function contractEventLabel(eventType) {
  const labels = {
    created: "Created",
    created_from_document_template: "Created from template",
    share_link_created: "Signing link",
    email_sent: "Email sent",
    sms_sent: "SMS sent",
    reminder_sent: "Reminder sent",
    delivery_failed: "Delivery failed",
    viewed: "Viewed",
    signed: "Signed",
    cancelled: "Cancelled",
    auto_renewal_notice_marked_sent: "Renewal notice",
  };
  return labels[eventType] || contractStatusLabel(eventType || "event");
}

function isContractExpired(contract) {
  if (!contract?.shareTokenExpiresAt) return false;
  if (["signed", "cancelled", "voided"].includes(contract.status)) return false;
  return new Date(contract.shareTokenExpiresAt).getTime() < Date.now();
}

function contractDeliverySteps(contract) {
  if (!contract) return [];
  const steps = [
    { key: "created", label: "Created", at: contract.createdAt, done: !!contract.createdAt },
    { key: "sent", label: "Sent", at: contract.sharedAt, done: !!contract.sharedAt },
    { key: "viewed", label: "Viewed", at: contract.viewedAt, done: !!contract.viewedAt },
  ];
  if (contract.status === "cancelled") {
    steps.push({ key: "cancelled", label: "Cancelled", at: contract.cancelledAt, done: true });
  } else if (contract.status === "signed") {
    steps.push({ key: "signed", label: "Signed", at: contract.signedAt, done: true });
  } else if (isContractExpired(contract)) {
    steps.push({ key: "expired", label: "Expired", at: contract.shareTokenExpiresAt, done: true });
  } else {
    steps.push({ key: "open", label: "Open", at: contract.shareTokenExpiresAt, done: false });
  }
  return steps;
}

function canDeliverDocumentContract(contract) {
  return contract?.contractType === "document_template" &&
    !["signed", "cancelled", "voided"].includes(contract.status);
}

function ContractSection({ title, description, defaultOpen = false, children }) {
  return <details className="c360-contract-section" open={defaultOpen}>
    <summary>
      <span><strong>{title}</strong><span>{description}</span></span>
      <ChevronDown size={18} aria-hidden="true" />
    </summary>
    <div className="c360-contract-section-body">{children}</div>
  </details>;
}

function ElectronicAuthorizationContractV2({
  customer,
  consents = [],
  cards = [],
  contracts = [],
  onRefresh,
}) {
  const latest = consents[0] || null;
  const autopayContracts = contracts.filter((contract) =>
    !contract.contractType || contract.contractType === "autopay_authorization",
  );
  const latestContract = autopayContracts[0] || null;
  const activeContract = autopayContracts.find((contract) =>
    ["draft", "sent", "viewed"].includes(contract.status),
  );
  const displayedText =
    latestContract?.consentTextSnapshot ||
    latest?.consentTextSnapshot ||
    CONSENT_TEXT;
  const displayedVersion =
    latestContract?.consentTextVersion ||
    latest?.consentTextVersion ||
    CONSENT_VERSION;
  const contractSignedAt = latestContract?.signedAt || null;
  const consentSignedAt = latest?.createdAt || null;
  const signedTimestamp = contractSignedAt || consentSignedAt;
  const signedAt = signedTimestamp
    ? `${fmtDate(signedTimestamp)} · ${new Date(signedTimestamp).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`
    : "Not signed";
  const requestedAt = latestContract?.createdAt
    ? new Date(latestContract.createdAt)
    : latest?.createdAt
      ? new Date(latest.createdAt)
      : new Date();
  const requestedLabel = requestedAt.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
  const contractDate = requestedAt.toLocaleDateString("en-US");
  const signerName =
    `${customer.firstName || ""} ${customer.lastName || ""}`.trim() ||
    "Customer";
  const defaultCard =
    cards.find(
      (card) =>
        card.is_default ||
        card.isDefault ||
        card.autopay_enabled ||
        card.autopayEnabled,
    ) ||
    cards[0] ||
    null;
  const [contractForm, setContractForm] = useState({
    paymentMethodId: "",
    serviceName: customer.tier
      ? `${customer.tier} service agreement`
      : "Waves service agreement",
    renewalDate: "",
    cancellationDeadline: "",
  });
  const [creatingContract, setCreatingContract] = useState(false);
  const [contractAction, setContractAction] = useState("");
  const [contractErr, setContractErr] = useState("");
  const [signingUrl, setSigningUrl] = useState("");
  // Standalone Auto Pay setup link (GATE_AUTOPAY_SETUP_LINK): copy the
  // tokenized /secure link or text it — outcome reported verbatim.
  const [setupLinkBusy, setSetupLinkBusy] = useState(false);
  const [setupLinkResult, setSetupLinkResult] = useState(null);
  const [contractDeliveryActionKey, setContractDeliveryActionKey] = useState("");
  const [documentTemplates, setDocumentTemplates] = useState([]);
  const [documentTemplatesLoading, setDocumentTemplatesLoading] = useState(false);
  const [selectedDocumentTemplateKey, setSelectedDocumentTemplateKey] = useState("");
  const [documentValues, setDocumentValues] = useState({
    serviceName: customer.tier || customer.waveguard_tier || "Waves service",
    agreementStartDate: "",
    serviceDate: "",
    inspectionDate: "",
  });
  const [documentAllowUnresolved, setDocumentAllowUnresolved] = useState(false);
  const [documentPropertyAddress, setDocumentPropertyAddress] = useState("");
  // Scoped to the profiled customer: if this panel survives a customer
  // switch, a stale override must not rewrite the next customer's
  // document address.
  useEffect(() => {
    setDocumentPropertyAddress("");
  }, [customer?.id]);
  const [documentSigningUrl, setDocumentSigningUrl] = useState("");
  const [documentAction, setDocumentAction] = useState("");
  const [documentErr, setDocumentErr] = useState("");
  const [creatingDocument, setCreatingDocument] = useState(false);
  const [auditContractId, setAuditContractId] = useState("");
  const [auditContract, setAuditContract] = useState(null);
  const [auditEvents, setAuditEvents] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditErr, setAuditErr] = useState("");
  const selectedPaymentMethodId =
    contractForm.paymentMethodId || defaultCard?.id || "";
  const selectedPaymentMethod =
    cards.find((card) => card.id === selectedPaymentMethodId) || defaultCard;
  const selectedDocumentTemplate =
    documentTemplates.find((template) => template.templateKey === selectedDocumentTemplateKey) ||
    documentTemplates[0] ||
    null;
  const methodForSummary =
    latestContract || latest || selectedPaymentMethod || defaultCard;
  const hasSignedAuthorization =
    latestContract?.status === "signed" || consents.length > 0;
  const displayedContractText =
    latestContract?.contractTextSnapshot ||
    ["AutoPay Authorization", displayedText].join("\n\n");
  const updateContractForm = (key, value) =>
    setContractForm((prev) => ({ ...prev, [key]: value }));
  const canCreateContract = !!selectedPaymentMethodId;
  const canCreateDocument = !!selectedDocumentTemplate?.templateKey && !creatingDocument;

  useEffect(() => {
    let cancelled = false;
    setDocumentTemplatesLoading(true);
    adminFetch("/admin/document-templates?status=active&limit=100")
      .then((result) => {
        if (cancelled) return;
        const templates = result.templates || [];
        setDocumentTemplates(templates);
        setSelectedDocumentTemplateKey((current) =>
          current && templates.some((template) => template.templateKey === current)
            ? current
            : templates[0]?.templateKey || "",
        );
      })
      .catch((err) => {
        if (!cancelled) setDocumentErr(err.message || "Could not load document templates");
      })
      .finally(() => {
        if (!cancelled) setDocumentTemplatesLoading(false);
      });
    return () => { cancelled = true; };
  }, []);

  const requestAutopaySetupLink = async (delivery) => {
    if (setupLinkBusy) return;
    if (delivery === "sms" && !window.confirm("Text this customer an Auto Pay setup link now?")) return;
    if (delivery === "email" && !window.confirm("Email this customer an Auto Pay setup link now?")) return;
    setSetupLinkBusy(true);
    setSetupLinkResult(null);
    try {
      const result = await adminFetch(
        `/admin/customers/${customer.id}/autopay-setup-link`,
        { method: "POST", body: JSON.stringify({ delivery }) },
      );
      let copied = false;
      if (result?.action === "link_created" && result.secureUrl) {
        try { await navigator.clipboard.writeText(result.secureUrl); copied = true; } catch { copied = false; }
      }
      // Never claim "copied" when the clipboard write failed — the URL is
      // rendered below either way.
      setSetupLinkResult({ ...result, copied });
      if (result?.action === "auto_secured") await onRefresh?.();
    } catch (err) {
      setSetupLinkResult({ action: "skipped", reason: err.message || "request_failed" });
    } finally {
      setSetupLinkBusy(false);
    }
  };

  const createContract = async () => {
    if (!canCreateContract || creatingContract) return;
    setCreatingContract(true);
    setContractErr("");
    setContractAction("");
    try {
      const result = await adminFetch(
        `/admin/contracts/customer/${customer.id}/autopay-authorization`,
        {
          method: "POST",
          body: JSON.stringify({
            paymentMethodId: selectedPaymentMethodId,
            serviceName: contractForm.serviceName,
            renewalDate: contractForm.renewalDate || null,
            cancellationDeadline: contractForm.cancellationDeadline || null,
          }),
        },
      );
      setSigningUrl(result.signingUrl || result.contract?.signingUrl || "");
      setContractAction(
        "Signing link created. The template remains off until you send this manually or wire an automation.",
      );
      await onRefresh?.();
    } catch (err) {
      setContractErr(err.message || "Could not create contract link");
    } finally {
      setCreatingContract(false);
    }
  };

  const regenerateLink = async (contract) => {
    if (!contract?.id || creatingContract) return;
    setCreatingContract(true);
    setContractErr("");
    setContractAction("");
    try {
      const result = await adminFetch(
        `/admin/contracts/${contract.id}/share-link`,
        { method: "POST" },
      );
      setSigningUrl(result.signingUrl || result.contract?.signingUrl || "");
      setContractAction("New signing link created.");
      await onRefresh?.();
    } catch (err) {
      setContractErr(err.message || "Could not create signing link");
    } finally {
      setCreatingContract(false);
    }
  };

  const cancelContract = async (contract) => {
    if (!contract?.id) return;
    const revokeAutopay = contract.status === "signed";
    const ok = window.confirm(
      revokeAutopay
        ? "Cancel this signed authorization and revoke future automatic payment authorization for this customer?"
        : "Cancel this signing request? This will invalidate the link and keep any existing AutoPay authorization in place.",
    );
    if (!ok) return;
    setCreatingContract(true);
    setContractErr("");
    setContractAction("");
    try {
      const result = await adminFetch(
        `/admin/contracts/${contract.id}/cancel`,
        {
          method: "POST",
          body: JSON.stringify({
            reason: "Cancelled from customer contracts tab",
            revokeAutopay,
          }),
        },
      );
      setSigningUrl("");
      setContractAction(
        revokeAutopay
          ? result.autopayRevoked
            ? "Contract cancelled and future autopay authorization revoked."
            : "Contract cancelled. Current AutoPay was not changed."
          : "Signing request cancelled.",
      );
      await onRefresh?.();
    } catch (err) {
      setContractErr(err.message || "Could not cancel contract");
    } finally {
      setCreatingContract(false);
    }
  };

  const markRenewalNoticeSent = async (contract) => {
    if (!contract?.id) return;
    setCreatingContract(true);
    setContractErr("");
    setContractAction("");
    try {
      await adminFetch(`/admin/contracts/${contract.id}/renewal-notice`, {
        method: "POST",
      });
      setContractAction("Renewal notice marked as sent for this contract.");
      await onRefresh?.();
    } catch (err) {
      setContractErr(err.message || "Could not mark renewal notice");
    } finally {
      setCreatingContract(false);
    }
  };

  const copySigningUrl = async () => {
    if (!signingUrl) return;
    try {
      await navigator.clipboard?.writeText(signingUrl);
      setContractAction("Signing link copied.");
    } catch {
      setContractAction("Signing link is ready.");
    }
  };

  const deliverDocumentContract = async (contract, channel, action = "send") => {
    if (!contract?.id || !canDeliverDocumentContract(contract)) return;
    const actionKey = `${contract.id}:${channel}:${action}`;
    setContractDeliveryActionKey(actionKey);
    setContractErr("");
    setContractAction("");
    try {
      const endpoint =
        action === "reminder"
          ? `/admin/contracts/${contract.id}/remind`
          : `/admin/contracts/${contract.id}/send-${channel}`;
      const result = await adminFetch(endpoint, {
        method: "POST",
        body: JSON.stringify(action === "reminder" ? { channel } : {}),
      });
      if (!result?.ok) {
        throw new Error(result?.error || "Delivery failed");
      }
      const label = channel === "email" ? "Email" : "SMS";
      setSigningUrl(result.signingUrl || result.contract?.signingUrl || "");
      setDocumentSigningUrl(result.signingUrl || result.contract?.signingUrl || "");
      setContractAction(
        action === "reminder"
          ? `${label} reminder sent with a fresh document link.`
          : `${label} sent with a fresh document link.`,
      );
      await onRefresh?.();
      if (auditContractId === contract.id) {
        await loadContractAudit(contract);
      }
    } catch (err) {
      setContractErr(err.message || "Could not deliver document request");
    } finally {
      setContractDeliveryActionKey("");
    }
  };

  const updateDocumentValue = (key, value) =>
    setDocumentValues((prev) => ({ ...prev, [key]: value }));

  const createDocumentLink = async () => {
    if (!canCreateDocument || !selectedDocumentTemplate?.templateKey) return;
    setCreatingDocument(true);
    setDocumentErr("");
    setDocumentAction("");
    setDocumentSigningUrl("");
    try {
      const result = await adminFetch(
        `/admin/document-templates/${encodeURIComponent(selectedDocumentTemplate.templateKey)}/contracts`,
        {
          method: "POST",
          body: JSON.stringify({
            customerId: customer.id,
            values: documentValues,
            allowUnresolved: documentAllowUnresolved,
            ...(documentPropertyAddress.trim()
              ? { propertyAddress: documentPropertyAddress.trim() }
              : {}),
          }),
        },
      );
      setDocumentSigningUrl(result.signingUrl || result.contract?.signingUrl || "");
      setDocumentAction("Document link created.");
      await onRefresh?.();
    } catch (err) {
      setDocumentErr(err.message || "Could not create document link");
    } finally {
      setCreatingDocument(false);
    }
  };

  const copyDocumentSigningUrl = async () => {
    if (!documentSigningUrl) return;
    try {
      await navigator.clipboard?.writeText(documentSigningUrl);
      setDocumentAction("Document link copied.");
    } catch {
      setDocumentAction("Document link is ready.");
    }
  };

  const loadContractAudit = async (contract) => {
    if (!contract?.id) return;
    setAuditContractId(contract.id);
    setAuditContract(contract);
    setAuditEvents([]);
    setAuditErr("");
    setAuditLoading(true);
    try {
      const result = await adminFetch(`/admin/contracts/${contract.id}/events`);
      setAuditContract(result.contract || contract);
      setAuditEvents(result.events || result.contract?.events || []);
    } catch (err) {
      setAuditErr(err.message || "Could not load contract audit");
    } finally {
      setAuditLoading(false);
    }
  };

  return (
    <div className="c360-contracts-content">
      <div className="c360-contracts-heading">
        <h2 className="text-18 font-medium">Contracts &amp; authorizations</h2>
        <p className="text-14 text-ink-secondary">Review existing records or prepare a document for signing.</p>
      </div>
      <ContractSection title={`Contract history (${contracts.length})`} description="Status, delivery, and actions for existing agreements." defaultOpen>
      <div className="mt-5">
        {" "}

        {contracts.length > 0 ? (
          <div className="overflow-x-auto mb-5">
            {" "}
            <div className="c360-contract-records">
              {contracts.map((contract) => (
                <article key={contract.id} className="c360-contract-record">
                    <div className="c360-contract-record-document">
                      {contract.contractType === "document_template"
                        ? contract.title || contract.documentTemplateKey || "Document"
                        : paymentMethodLabel(contract)}
                    </div>
                    <div className="c360-contract-record-status">
                      {" "}
                      <Badge tone={contractStatusTone(contract.status)}>
                        {contractStatusLabel(contract.status)}
                      </Badge>{" "}
                    </div>
                    <div className="c360-contract-record-created"><span className="c360-contract-field-label">Created</span>{fmtDate(contract.createdAt)}</div>
                    <div className="c360-contract-record-signed"><span className="c360-contract-field-label">Signed</span>
                      {contract.signedAt ? fmtDate(contract.signedAt) : "—"}
                    </div>
                    <div className="c360-contract-record-delivery"><span className="c360-contract-field-label">Recorded events</span>
                      <div className="flex flex-wrap gap-1">
                        {contractDeliverySteps(contract).filter((step) => step.done).map((step) => (
                          <span
                            key={step.key}
                            className={cn(
                              "h-5 px-1.5 inline-flex items-center rounded-xs border-hairline text-ui-caption ui-label",
                              step.done
                                ? "bg-zinc-50 border-zinc-200 text-zinc-900"
                                : "bg-zinc-50 border-zinc-200 text-ink-secondary",
                            )}
                            title={step.at ? fmtDate(step.at) : ""}
                          >
                            {step.label}{step.at ? ` · ${fmtDate(step.at)}` : " · Date not recorded"}
                          </span>
                        ))}
                      </div>
                    </div>
                    <div className="c360-contract-record-actions">
                      {" "}
                      <div className="flex flex-wrap gap-1.5">
                        <Button
                          size="sm"
                          variant="secondary"
                          onClick={() => loadContractAudit(contract)}
                          disabled={auditLoading && auditContractId === contract.id}
                        >
                          {" "}
                          <FileText size={13} className="mr-1" />
                          Audit
                        </Button>
                        {canDeliverDocumentContract(contract) && (
                          <>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => deliverDocumentContract(contract, "email")}
                              disabled={!!contractDeliveryActionKey}
                            >
                              {" "}
                              <Mail size={13} className="mr-1" />
                              Email
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => deliverDocumentContract(contract, "sms")}
                              disabled={!!contractDeliveryActionKey}
                            >
                              {" "}
                              <MessageSquare size={13} className="mr-1" />
                              SMS
                            </Button>
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => deliverDocumentContract(contract, "email", "reminder")}
                              disabled={!!contractDeliveryActionKey}
                            >
                              {" "}
                              <Bell size={13} className="mr-1" />
                              Remind
                            </Button>
                          </>
                        )}
                        {!["signed", "cancelled", "voided"].includes(
                          contract.status,
                        ) && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => regenerateLink(contract)}
                            disabled={creatingContract}
                          >
                            {" "}
                            <RotateCcw size={13} className="mr-1" />
                            Link
                          </Button>
                        )}
                        {contract.autoRenewalNoticeRequired &&
                          !contract.autoRenewalNoticeSentAt && (
                            <Button
                              size="sm"
                              variant="secondary"
                              onClick={() => markRenewalNoticeSent(contract)}
                              disabled={creatingContract}
                            >
                              {" "}
                              <CheckCircle2 size={13} className="mr-1" />
                              Notice
                            </Button>
                          )}
                        {contract.status !== "cancelled" && (
                          <Button
                            size="sm"
                            variant="danger"
                            onClick={() => cancelContract(contract)}
                            disabled={creatingContract}
                          >
                            {" "}
                            <XCircle size={13} className="mr-1" />
                            Cancel
                          </Button>
                        )}
                      </div>{" "}
                    </div>
                </article>
              ))}
            </div>{" "}
          </div>
        ) : (
          <div className="mb-5 text-ui-body text-ink-secondary">
            No contract records created yet.
          </div>
        )}
        {auditContractId && (
          <div className="mb-5 rounded-sm border-hairline border-zinc-200 bg-white p-4">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <SectionTitle>
                  Delivery Audit
                </SectionTitle>
                <div className="text-ui-label text-ink-secondary">
                  {auditContract?.title || "Contract"} · {auditLoading ? "Loading events" : `${auditEvents.length} event${auditEvents.length === 1 ? "" : "s"}`}
                </div>
              </div>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setAuditContractId("");
                  setAuditContract(null);
                  setAuditEvents([]);
                  setAuditErr("");
                }}
              >
                Close
              </Button>
            </div>
            {auditErr && (
              <div className="mb-3 rounded-sm border-hairline border-red-200 bg-red-50 px-3 py-2 text-ui-label text-red-900">
                {auditErr}
              </div>
            )}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {contractDeliverySteps(auditContract || contracts.find((contract) => contract.id === auditContractId)).map((step) => (
                <span
                  key={step.key}
                  className={cn(
                    "h-6 px-2 inline-flex items-center rounded-xs border-hairline text-ui-caption ui-label",
                    step.done
                      ? "bg-zinc-900 border-zinc-900 text-white"
                      : "bg-zinc-50 border-zinc-200 text-ink-secondary",
                  )}
                >
                  {step.label}
                  {step.at ? <span className="u-nums ml-1 opacity-80">{fmtDate(step.at)}</span> : null}
                </span>
              ))}
            </div>
            <div className="divide-y divide-zinc-100 rounded-sm border-hairline border-zinc-200">
              {auditEvents.map((event) => (
                <div key={event.id} className="c360-contract-grid grid gap-2 px-3 py-2 md:grid-cols-[180px_1fr_160px]">
                  <div className="text-ui-label font-medium text-zinc-900">
                    {contractEventLabel(event.eventType)}
                  </div>
                  <div className="min-w-0 text-ui-label text-ink-secondary">
                    {event.actorType || "system"}
                    {event.ip ? ` · ${event.ip}` : ""}
                    {event.metadata?.templateKey ? ` · ${event.metadata.templateKey}` : ""}
                    {event.metadata?.reason ? ` · ${event.metadata.reason}` : ""}
                  </div>
                  <div className="u-nums text-ui-caption text-ink-secondary md:text-right">
                    {fmtDate(event.createdAt)}
                  </div>
                </div>
              ))}
              {!auditLoading && auditEvents.length === 0 && (
                <div className="px-3 py-4 text-ui-label text-ink-secondary">
                  No audit events recorded for this contract.
                </div>
              )}
              {auditLoading && (
                <div className="px-3 py-4 text-ui-label text-ink-secondary">
                  Loading audit events...
                </div>
              )}
            </div>
          </div>
        )}
      </div>
      </ContractSection>
      <ContractSection title={"Auto Pay authorization"} description="Payment authorization and signing links.">
      <div className="c360-contract-form mb-5 rounded-sm border-hairline border-zinc-200 bg-white">
        {" "}
        <div className="c360-contract-form-header flex items-center justify-between gap-3 px-4 py-3 border-b border-hairline border-zinc-200">
          {" "}
          <div className="c360-contract-form-duplicate-title">
            {" "}
            <div className="text-16 font-medium text-zinc-900">
              AutoPay Authorization
            </div>{" "}
            <div className="text-ui-label text-ink-secondary mt-1">
              Create, share, sign, and audit saved-payment authorization
              contracts.
            </div>{" "}
          </div>{" "}
          <div className="c360-contract-form-actions flex flex-wrap items-center justify-end gap-2">
            {" "}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => requestAutopaySetupLink("inline")}
              disabled={setupLinkBusy}
              title="Copy a 30-day Auto Pay setup link (card or bank account) for this customer"
            >
              Copy Auto Pay link
            </Button>{" "}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => requestAutopaySetupLink("sms")}
              disabled={setupLinkBusy}
              title="Text this customer an Auto Pay setup link"
            >
              Text Auto Pay link
            </Button>{" "}
            <Button
              size="sm"
              variant="secondary"
              onClick={() => requestAutopaySetupLink("email")}
              disabled={setupLinkBusy}
              title="Email this customer an Auto Pay setup link"
            >
              Email Auto Pay link
            </Button>{" "}
            <Button
              size="sm"
              variant="secondary"
              onClick={
                activeContract
                  ? () => regenerateLink(activeContract)
                  : createContract
              }
              disabled={creatingContract || !canCreateContract}
            >
              {" "}
              <Link2 size={13} className="mr-1" />
              {activeContract ? "New Link" : "Create Link"}
            </Button>{" "}
          </div>{" "}
        </div>{" "}
        {setupLinkResult ? (
          <div
            className={cn(
              "px-4 py-2 text-ui-label border-b border-hairline border-zinc-200",
              describeAutopaySetupLinkResult(setupLinkResult).tone === "bad"
                ? "text-alert-fg"
                : "text-ink-secondary",
            )}
          >
            {describeAutopaySetupLinkResult(setupLinkResult).text}
            {setupLinkResult.secureUrl ? (
              <span className="ml-2 break-all u-nums text-zinc-900">{setupLinkResult.secureUrl}</span>
            ) : null}
          </div>
        ) : null}
        <div className="c360-contract-grid grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 p-4">
          {" "}
          <ContractMeta label="Recipient" value={signerName} />{" "}
          <ContractMeta label="Contract name" value="AutoPay Authorization" />{" "}
          <ContractMeta
            label="Status"
            value={
              latestContract
                ? contractStatusLabel(latestContract.status)
                : "No contract created"
            }
          />{" "}
          <ContractMeta
            label="Payment method"
            value={paymentMethodLabel(selectedPaymentMethod)}
          />{" "}
        </div>{" "}
        <div className="c360-contract-grid grid grid-cols-1 md:grid-cols-[1fr_0.8fr] gap-3 px-4 pb-4">
          {" "}
          <div className="c360-contract-grid grid grid-cols-1 sm:grid-cols-2 gap-3">
            {" "}
            <label className="block">
              {" "}
              <div className="ui-label text-ink-secondary mb-1">
                Payment method
              </div>{" "}
              <Select
                value={selectedPaymentMethodId}
                onChange={(e) =>
                  updateContractForm("paymentMethodId", e.target.value)
                }
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-ui-body text-zinc-900"
              >
                {cards.length === 0 && (
                  <option value="">No saved payment method</option>
                )}
                {cards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {paymentMethodLabel(card)}
                  </option>
                ))}
              </Select>{" "}
            </label>{" "}
            <label className="block">
              {" "}
              <div className="ui-label text-ink-secondary mb-1">
                Service name
              </div>{" "}
              <Input
                value={contractForm.serviceName}
                onChange={(e) =>
                  updateContractForm("serviceName", e.target.value)
                }
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-ui-body text-zinc-900"
              />{" "}
            </label>{" "}
            <label className="block">
              {" "}
              <div className="ui-label text-ink-secondary mb-1">
                Renewal date
              </div>{" "}
              <Input
                type="date"
                value={contractForm.renewalDate}
                onChange={(e) =>
                  updateContractForm("renewalDate", e.target.value)
                }
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-ui-body text-zinc-900"
              />{" "}
            </label>{" "}
            <label className="block">
              {" "}
              <div className="ui-label text-ink-secondary mb-1">
                Cancellation deadline
              </div>{" "}
              <Input
                type="date"
                value={contractForm.cancellationDeadline}
                onChange={(e) =>
                  updateContractForm("cancellationDeadline", e.target.value)
                }
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-ui-body text-zinc-900"
              />{" "}
            </label>{" "}
          </div>{" "}
          <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3">
            {" "}
            <div className="ui-label text-ink-secondary mb-2">Signing Link</div>
            {signingUrl ? (
              <div className="space-y-2">
                {" "}
                <div className="break-all text-ui-label text-zinc-900 leading-5">
                  {signingUrl}
                </div>{" "}
                <Button size="sm" variant="secondary" onClick={copySigningUrl}>
                  {" "}
                  <Copy size={13} className="mr-1" />
                  Copy
                </Button>{" "}
              </div>
            ) : (
              <div className="text-ui-label text-ink-secondary leading-5">
                Create a link to send manually. SMS templates are seeded but
                inactive, so this will not send automatically.
              </div>
            )}
            {!canCreateContract && (
              <div className="mt-2 text-ui-caption text-alert-fg">
                Add a saved payment method before creating an authorization
                contract.
              </div>
            )}
            {contractAction && (
              <div className="mt-2 text-ui-caption text-zinc-900">{contractAction}</div>
            )}
            {contractErr && (
              <div className="mt-2 text-ui-caption text-alert-fg">{contractErr}</div>
            )}
          </div>{" "}
        </div>{" "}
      </div>{" "}
      </ContractSection>
      <ContractSection title={"Create a document"} description="Service agreements, notices, and reusable templates.">
      <div className="c360-contract-form mb-5 rounded-sm border-hairline border-zinc-200 bg-white">
        <div className="c360-contract-form-header flex items-center justify-between gap-3 px-4 py-3 border-b border-hairline border-zinc-200">
          <div className="c360-contract-form-duplicate-title">
            <div className="text-16 font-medium text-zinc-900">
              Reusable documents
            </div>
            <div className="text-ui-label text-ink-secondary mt-1">
              Send service agreements, notices, prep forms, and WDO acknowledgements through the e-sign workflow.
            </div>
          </div>
          <Button className="c360-contract-form-actions"
            size="sm"
            onClick={createDocumentLink}
            disabled={!canCreateDocument || documentTemplatesLoading}
          >
            <Link2 size={13} className="mr-1" />
            {creatingDocument ? "Creating..." : "Create Link"}
          </Button>
        </div>
        <div className="c360-contract-grid grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-3 p-4">
          <div className="c360-contract-grid grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <div className="ui-label text-ink-secondary mb-1">
                Template
              </div>
              <Select
                value={selectedDocumentTemplateKey}
                onChange={(e) => setSelectedDocumentTemplateKey(e.target.value)}
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-ui-body text-zinc-900"
                disabled={documentTemplatesLoading}
              >
                {documentTemplates.length === 0 && (
                  <option value="">No active templates</option>
                )}
                {documentTemplates.map((template) => (
                  <option key={template.templateKey} value={template.templateKey}>
                    {template.name}
                  </option>
                ))}
              </Select>
            </label>
            <label className="block">
              <div className="ui-label text-ink-secondary mb-1">
                Service name
              </div>
              <Input
                value={documentValues.serviceName}
                onChange={(e) => updateDocumentValue("serviceName", e.target.value)}
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-ui-body text-zinc-900"
              />
            </label>
            <label className="block">
              <div className="ui-label text-ink-secondary mb-1">
                Agreement start
              </div>
              <Input
                type="date"
                value={documentValues.agreementStartDate}
                onChange={(e) => updateDocumentValue("agreementStartDate", e.target.value)}
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-ui-body text-zinc-900"
              />
            </label>
            <label className="block">
              <div className="ui-label text-ink-secondary mb-1">
                Service / inspection date
              </div>
              <Input
                type="date"
                value={documentValues.serviceDate || documentValues.inspectionDate}
                onChange={(e) => {
                  updateDocumentValue("serviceDate", e.target.value);
                  updateDocumentValue("inspectionDate", e.target.value);
                }}
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-ui-body text-zinc-900"
              />
            </label>
            <label className="block sm:col-span-2">
              <div className="ui-label text-ink-secondary mb-1">
                Property address (optional)
              </div>
              <Input
                value={documentPropertyAddress}
                onChange={(e) => setDocumentPropertyAddress(e.target.value)}
                placeholder="Overrides the customer's primary address on the document"
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-ui-body text-zinc-900"
              />
            </label>
            <label className="sm:col-span-2 inline-flex min-h-8 items-center gap-2 text-ui-label font-medium text-zinc-900">
              <input
                type="checkbox"
                checked={documentAllowUnresolved}
                onChange={(e) => setDocumentAllowUnresolved(e.target.checked)}
                className="h-4 w-4 rounded-xs border-zinc-300 text-zinc-900 u-focus-ring"
              />
              Allow unresolved merge fields
            </label>
          </div>
          <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3">
            <div className="ui-label text-ink-secondary mb-2">Document link</div>
            <div className="text-ui-label text-ink-secondary leading-5">
              {selectedDocumentTemplate
                ? `${selectedDocumentTemplate.name} will be rendered with this customer's name, address, and the values entered here.`
                : "Select an active template to create a document link."}
            </div>
            {documentSigningUrl && (
              <div className="mt-3 space-y-2">
                <div className="break-all text-ui-label text-zinc-900 leading-5">
                  {documentSigningUrl}
                </div>
                <Button size="sm" variant="secondary" onClick={copyDocumentSigningUrl}>
                  <Copy size={13} className="mr-1" />
                  Copy
                </Button>
              </div>
            )}
            {documentAction && (
              <div className="mt-2 text-ui-caption text-zinc-900">{documentAction}</div>
            )}
            {documentErr && (
              <div className="mt-2 text-ui-caption text-alert-fg">{documentErr}</div>
            )}
          </div>
        </div>
      </div>
      </ContractSection>
      <ContractSection title={"Authorization preview & signature"} description="Full terms, selected clauses, and signing evidence.">
      <div className="c360-contract-grid grid grid-cols-1 md:grid-cols-[1.2fr_0.8fr] gap-5">
        {" "}
        <Card>
          {" "}
          <CardBody className="p-0">
            {" "}
            <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b border-hairline border-zinc-200">
              {" "}
              <div className="flex items-start gap-3">
                {" "}
                <div className="mt-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-sm border-hairline border-zinc-200 bg-zinc-50 text-zinc-900">
                  {" "}
                  <FileText size={18} strokeWidth={1.75} />{" "}
                </div>{" "}
                <div>
                  {" "}
                  <div className="text-18 font-medium tracking-tight text-zinc-900">
                    Electronic Payment Authorization
                  </div>{" "}
                  <div className="text-ui-label text-ink-secondary mt-1">
                    Waves Pest Control, LLC
                  </div>{" "}
                </div>{" "}
              </div>{" "}
              <Badge
                tone={
                  latestContract
                    ? contractStatusTone(latestContract.status)
                    : hasSignedAuthorization
                      ? "strong"
                      : "neutral"
                }
              >
                {latestContract
                  ? contractStatusLabel(latestContract.status)
                  : hasSignedAuthorization
                    ? "Signed"
                    : "Template"}
              </Badge>{" "}
            </div>{" "}
            <div className="px-5 py-5">
              {" "}
              <SectionTitle>Selected Clauses</SectionTitle>{" "}
              <div className="mb-5 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-4">
                {" "}
                <div className="flex flex-wrap items-start justify-between gap-3">
                  {" "}
                  <div>
                    {" "}
                    <div className="text-ui-body font-medium text-zinc-900">
                      AutoPay Authorization - Initials required
                    </div>{" "}
                    <div className="text-ui-label leading-5 text-ink-secondary mt-2">
                      {displayedText}
                    </div>{" "}
                  </div>{" "}
                  <Badge tone="neutral">Clause</Badge>{" "}
                </div>{" "}
              </div>{" "}
              <div className="c360-contract-grid grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
                {" "}
                <ContractMeta label="Customer" value={signerName} />{" "}
                <ContractMeta
                  label="Payment Method"
                  value={paymentMethodLabel(methodForSummary)}
                />{" "}
                <ContractMeta
                  label="Authorization Version"
                  value={displayedVersion}
                />{" "}
                <ContractMeta label="Signed" value={signedAt} />{" "}
              </div>{" "}
              <SectionTitle>Contract Preview</SectionTitle>{" "}
              <div className="rounded-sm border-hairline border-zinc-200 bg-white p-5">
                {" "}
                <div className="flex items-start justify-between gap-4 pb-4 border-b border-hairline border-zinc-200">
                  {" "}
                  <div>
                    {" "}
                    <div className="text-15 font-medium text-zinc-900">
                      Waves Pest Control
                    </div>{" "}
                    <div className="text-ui-label text-ink-secondary mt-1">
                      Signature requested on {requestedLabel}
                    </div>{" "}
                  </div>{" "}
                  <Badge
                    tone={
                      latestContract
                        ? contractStatusTone(latestContract.status)
                        : hasSignedAuthorization
                          ? "strong"
                          : "neutral"
                    }
                  >
                    {latestContract
                      ? contractStatusLabel(latestContract.status)
                      : hasSignedAuthorization
                        ? "Signed"
                        : "Draft"}
                  </Badge>{" "}
                </div>{" "}
                <div className="py-4 border-b border-hairline border-zinc-200">
                  {" "}
                  <div className="text-18 font-medium text-zinc-900 mb-3">
                    AutoPay Authorization
                  </div>{" "}
                  <div className="c360-contract-grid grid grid-cols-1 sm:grid-cols-2 gap-3 text-ui-label">
                    {" "}
                    <div>
                      {" "}
                      <div className="ui-label text-ink-secondary mb-1">
                        Business
                      </div>{" "}
                      <div className="text-zinc-900">Waves Pest Control</div>{" "}
                      <div className="text-ink-secondary mt-1">
                        contact@wavespestcontrol.com
                      </div>{" "}
                      <div className="text-ink-secondary">
                        (941) 318-7612
                      </div>{" "}
                    </div>{" "}
                    <div>
                      {" "}
                      <div className="ui-label text-ink-secondary mb-1">
                        Recipient
                      </div>{" "}
                      <div className="text-zinc-900">{signerName}</div>{" "}
                      <div className="text-ink-secondary mt-1">
                        {customer.email || "No email on file"}
                      </div>{" "}
                      <div className="text-ink-secondary">
                        {customer.phone || "No phone on file"}
                      </div>{" "}
                    </div>{" "}
                  </div>{" "}
                  <div className="mt-4 text-ui-label leading-5 text-zinc-900">
                    This contract is between Waves Pest Control (the Business)
                    and {signerName} (the Client) dated {contractDate}.
                  </div>{" "}
                </div>{" "}
                <div className="py-4 border-b border-hairline border-zinc-200">
                  {" "}
                  <div className="ui-label text-ink-secondary mb-2">
                    Terms
                  </div>{" "}
                  <div className="text-ui-body font-medium text-zinc-900 mb-2">
                    AutoPay Authorization
                  </div>{" "}
                  <p className="text-ui-body leading-6 text-zinc-900 m-0 whitespace-pre-line">
                    {displayedContractText}
                  </p>{" "}
                  <div className="mt-4 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2">
                    {" "}
                    <div className="ui-label text-ink-secondary mb-1">
                      Recipient Initial
                    </div>{" "}
                    <div className="h-7 rounded-sm border-hairline border-zinc-300 bg-white" />{" "}
                  </div>{" "}
                </div>{" "}
                <div className="pt-4">
                  {" "}
                  <div className="ui-label text-ink-secondary mb-2">
                    Signatures
                  </div>{" "}
                  <div className="text-ui-label text-ink-secondary leading-5 mb-4">
                    Electronic signatures count as original for all purposes. By
                    typing their names as signatures below, both parties agree
                    to the terms and provisions of this agreement.
                  </div>{" "}
                  <div className="c360-contract-grid grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {" "}
                    <ContractMeta
                      label="Business signature"
                      value="Waves Pest Control"
                    />{" "}
                    <ContractMeta
                      label="Business date signed"
                      value={contractDate}
                    />{" "}
                    <ContractMeta
                      label="Recipient signature"
                      value={
                        latestContract?.signedName ||
                        (hasSignedAuthorization ? signerName : "")
                      }
                    />{" "}
                    <ContractMeta
                      label="Recipient date signed"
                      value={signedTimestamp ? fmtDate(signedTimestamp) : ""}
                    />{" "}
                  </div>{" "}
                </div>{" "}
              </div>{" "}
              <div className="mt-4 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-ui-label text-ink-secondary leading-5">
                This authorization covers saved-payment use only. Service scope,
                visit frequency, renewal terms, and cancellation policy remain
                controlled by the customer&apos;s service agreement and account
                record.
              </div>{" "}
              <div className="mt-5">
                {" "}
                <SectionTitle>Florida Compliance Reference</SectionTitle>{" "}
                <div className="c360-contract-grid grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {FLORIDA_COMPLIANCE_ITEMS.map((item) => (
                    <div
                      key={item.title}
                      className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3"
                    >
                      {" "}
                      <div className="text-ui-label font-medium text-zinc-900">
                        {item.title}
                      </div>{" "}
                      <div className="text-ui-label text-ink-secondary leading-5 mt-1">
                        {item.body}
                      </div>{" "}
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex mt-2 text-ui-caption ui-label text-zinc-900 hover:underline"
                      >
                        {item.citation}
                      </a>{" "}
                    </div>
                  ))}
                </div>{" "}
                <div className="mt-2 text-ui-caption text-ink-tertiary leading-5">
                  Internal compliance reference only. Final customer-facing
                  contract language should be reviewed by counsel before use.
                </div>{" "}
              </div>{" "}
            </div>{" "}
          </CardBody>{" "}
        </Card>{" "}
        <Card>
          {" "}
          <CardBody className="p-4">
            {" "}
            <div className="flex items-center gap-2 mb-3">
              {" "}
              <PenLine size={16} strokeWidth={1.75} />{" "}
              <div className="text-14 font-medium text-zinc-900">
                Signature record
              </div>{" "}
            </div>
            {latestContract?.signedAt ? (
              <div className="space-y-2 text-ui-label">
                {" "}
                <div className="flex justify-between gap-3 border-b border-hairline border-zinc-200 pb-2">
                  {" "}
                  <span className="text-ink-secondary">Signer</span>{" "}
                  <span className="text-zinc-900 text-right">
                    {latestContract.signedName || signerName}
                  </span>{" "}
                </div>{" "}
                <div className="flex justify-between gap-3 border-b border-hairline border-zinc-200 pb-2">
                  {" "}
                  <span className="text-ink-secondary">Source</span>{" "}
                  <span className="text-zinc-900 text-right">
                    Contract signing
                  </span>{" "}
                </div>{" "}
                <div className="flex justify-between gap-3 border-b border-hairline border-zinc-200 pb-2">
                  {" "}
                  <span className="text-ink-secondary">Accepted</span>{" "}
                  <span className="u-nums text-zinc-900 text-right">
                    {signedAt}
                  </span>{" "}
                </div>{" "}
                <div className="flex justify-between gap-3 border-b border-hairline border-zinc-200 pb-2">
                  {" "}
                  <span className="text-ink-secondary">Initials</span>{" "}
                  <span className="u-nums text-zinc-900 text-right">
                    {latestContract.recipientInitials || "—"}
                  </span>{" "}
                </div>{" "}
                <div className="flex justify-between gap-3 border-b border-hairline border-zinc-200 pb-2">
                  {" "}
                  <span className="text-ink-secondary">IP</span>{" "}
                  <span className="u-nums text-zinc-900 text-right">
                    {latestContract.signerIp || "—"}
                  </span>{" "}
                </div>{" "}
                <div>
                  {" "}
                  <div className="text-ink-secondary mb-1">User agent</div>{" "}
                  <div className="text-zinc-900 break-words leading-5">
                    {latestContract.signerUserAgent || "—"}
                  </div>{" "}
                </div>{" "}
              </div>
            ) : latest ? (
              <div className="space-y-2 text-ui-label">
                {" "}
                <div className="flex justify-between gap-3 border-b border-hairline border-zinc-200 pb-2">
                  {" "}
                  <span className="text-ink-secondary">Signer</span>{" "}
                  <span className="text-zinc-900 text-right">
                    {signerName}
                  </span>{" "}
                </div>{" "}
                <div className="flex justify-between gap-3 border-b border-hairline border-zinc-200 pb-2">
                  {" "}
                  <span className="text-ink-secondary">Source</span>{" "}
                  <span className="text-zinc-900 text-right">
                    {sourceLabel(latest.source)}
                  </span>{" "}
                </div>{" "}
                <div className="flex justify-between gap-3 border-b border-hairline border-zinc-200 pb-2">
                  {" "}
                  <span className="text-ink-secondary">Accepted</span>{" "}
                  <span className="u-nums text-zinc-900 text-right">
                    {signedAt}
                  </span>{" "}
                </div>{" "}
                <div className="flex justify-between gap-3 border-b border-hairline border-zinc-200 pb-2">
                  {" "}
                  <span className="text-ink-secondary">IP</span>{" "}
                  <span className="u-nums text-zinc-900 text-right">
                    {latest.ip || "—"}
                  </span>{" "}
                </div>{" "}
                <div>
                  {" "}
                  <div className="text-ink-secondary mb-1">User agent</div>{" "}
                  <div className="text-zinc-900 break-words leading-5">
                    {latest.userAgent || "—"}
                  </div>{" "}
                </div>{" "}
              </div>
            ) : (
              <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-ui-label text-ink-secondary leading-5">
                No signed saved-payment authorization is recorded for this
                customer yet.
              </div>
            )}
            <div className="mt-4 flex items-start gap-2 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3">
              {" "}
              <CreditCard
                size={15}
                strokeWidth={1.75}
                className="mt-0.5 flex-shrink-0"
              />{" "}
              <div>
                {" "}
                <div className="text-ui-label font-medium text-zinc-900">
                  {paymentMethodLabel(methodForSummary)}
                </div>{" "}
                <div className="text-ui-caption text-ink-secondary mt-0.5">
                  {latest?.isDefault || defaultCard?.is_default
                    ? "Default payment method"
                    : "Saved payment method"}
                  {latest?.autopayEnabled || defaultCard?.autopay_enabled
                    ? " · Autopay enabled"
                    : ""}
                </div>{" "}
              </div>{" "}
            </div>{" "}
          </CardBody>{" "}
        </Card>{" "}
      </div>{" "}
      </ContractSection>
      <ContractSection title={`Authorization history (${consents.length})`} description="Previously recorded payment-method consents.">
      <div>

        {consents.length > 0 ? (
          <div className="overflow-x-auto">
            {" "}
            <Table>

              <THead>

                <TR>

                  <TH>Accepted</TH>
                  <TH>Source</TH>
                  <TH>Method</TH>
                  <TH>Version</TH>
                </TR>
              </THead>
              <TBody>
                {consents.map((consent) => (
                  <TR key={consent.id}>

                    <TD className="u-nums">
                      {fmtDate(consent.createdAt)}
                    </TD>
                    <TD>{sourceLabel(consent.source)}</TD>
                    <TD>{paymentMethodLabel(consent)}</TD>
                    <TD className="u-nums">
                      {consent.consentTextVersion || "—"}
                    </TD>
                  </TR>
                ))}
              </TBody>
            </Table>{" "}
          </div>
        ) : (
          <div className="text-ui-body text-ink-secondary">
            No saved-payment authorizations recorded.
          </div>
        )}
      </div>
      </ContractSection>
    </div>
  );
}

// ─── Service row (collapsible) ───────────────────────────────────
function ServiceRowV2({ service: s, initiallyExpanded = false }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const structuredNotes = parseStructuredNotes(s.structured_notes);
  const managerApproval = structuredNotes.waveguardManagerApproval;
  const blackoutApproval = structuredNotes.waveguardBlackoutApproval;
  const nLimitApproval = structuredNotes.waveguardNLimitApproval;
  const inventoryAdvisory = structuredNotes.waveguardInventoryAdvisory;
  const tankCleanout = structuredNotes.waveguardTankCleanout;
  const isProjectCompletion = structuredNotes.projectCompletion === true;
  const projectReportUrl = isProjectCompletion ? projectReportUrlFromNotes(structuredNotes) : null;
  const inventoryDeductions = Array.isArray(structuredNotes.inventoryDeductions)
    ? structuredNotes.inventoryDeductions
    : [];
  const hasWaveGuardAudit =
    !!managerApproval ||
    !!blackoutApproval ||
    !!nLimitApproval ||
    !!inventoryAdvisory ||
    !!tankCleanout ||
    inventoryDeductions.length > 0;
  return (
    <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm overflow-hidden mb-1.5">
      {" "}
      <button data-ui-text-action
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex justify-between items-center px-3.5 py-2.5 text-ui-body u-focus-ring hover:bg-zinc-100 transition-colors"
      >
        {" "}
        <span className="font-medium text-zinc-900 text-left">
          {s.service_type}
        </span>{" "}
        <span className="flex items-center gap-3">
          {isProjectCompletion && <Badge tone="neutral">Project</Badge>}
          {s.total_cost > 0 && (
            <span className="u-nums text-zinc-900">
              {fmtCurrency(s.total_cost)}
            </span>
          )}
          <span className="text-ink-secondary">{fmtDateOnly(s.service_date)}</span>{" "}
          <span
            className="text-ink-secondary text-ui-label transition-transform"
            style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}
          >
            ▾
          </span>{" "}
        </span>{" "}
      </button>
      {expanded && (
        <div className="px-3.5 py-2.5 border-t border-hairline border-zinc-200 text-ui-label space-y-1">
          {isProjectCompletion && (
            <div className="mb-2 rounded-sm border-hairline border-zinc-200 bg-white p-2.5">
              {" "}
              <div className="flex items-center gap-2 text-zinc-900 font-medium mb-1">
                {" "}
                <FileText size={14} strokeWidth={1.75} />{" "}
                <span>Project Completion</span>{" "}
              </div>{" "}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-ink-secondary">
                {" "}
                <div>
                  Type:{" "}
                  <span className="text-zinc-900">
                    {labelFromKey(structuredNotes.projectType) || "Project"}
                  </span>
                </div>{" "}
                <div>
                  Portal:{" "}
                  <span className="text-zinc-900">
                    {structuredNotes.portalAttached
                      ? "Attached"
                      : "Token-only"}
                  </span>
                </div>{" "}
              </div>
              {projectReportUrl && (
                <a
                  href={projectReportUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 mt-2 text-zinc-900 underline underline-offset-2"
                >
                  <Link2 size={13} strokeWidth={1.75} />
                  Open project report
                </a>
              )}
            </div>
          )}
          {s.notes && <div className="text-zinc-900">{s.notes}</div>}
          {s.products_used && (
            <div className="text-ink-secondary">
              Products: {s.products_used}
            </div>
          )}
          {s.areas_treated && (
            <div className="text-ink-secondary">Areas: {s.areas_treated}</div>
          )}
          {s.technician_name && (
            <div className="text-ink-secondary">Tech: {s.technician_name}</div>
          )}
          {managerApproval && (
            <div className="mt-2 rounded-sm border-hairline border-zinc-200 bg-white p-2.5">
              {" "}
              <div className="flex items-center gap-2 text-zinc-900 font-medium mb-1">
                {" "}
                <ShieldCheck size={14} strokeWidth={1.75} />{" "}
                {/* Advisory records (no approval ceremony — PR #3022) must
                    never read as an approval in the audit history. */}
                <span>
                  {managerApproval.advisory
                    ? "Protocol Exception (advisory)"
                    : "Manager Approval"}
                </span>{" "}
              </div>{" "}
              <div className="text-ink-secondary">
                {managerApproval.advisory
                  ? `Recorded without approval ceremony${
                      managerApproval.recordedAt
                        ? ` on ${fmtDate(managerApproval.recordedAt)}`
                        : ""
                    }`
                  : `${approvalCodeLabel(managerApproval.reasonCode)}${
                      managerApproval.approvedByRole
                        ? ` by ${managerApproval.approvedByRole}`
                        : ""
                    }${
                      managerApproval.approvedAt
                        ? ` on ${fmtDate(managerApproval.approvedAt)}`
                        : ""
                    }`}
              </div>
              {managerApproval.note && (
                <div className="text-zinc-900 mt-1">{managerApproval.note}</div>
              )}
              {Array.isArray(managerApproval.blocks) &&
                managerApproval.blocks.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {managerApproval.blocks.map((block, idx) => (
                      <div key={idx} className="text-ink-secondary">
                        {" "}
                        <span className="font-medium text-zinc-900">
                          {approvalCodeLabel(block.code)}
                        </span>
                        {block.productName ? ` · ${block.productName}` : ""}
                        {block.message ? ` — ${block.message}` : ""}
                      </div>
                    ))}
                  </div>
                )}
            </div>
          )}
          {[
            ["Fertilizer Blackout", blackoutApproval],
            ["Annual N Budget", nLimitApproval],
            ["Inventory Shortfall", inventoryAdvisory],
          ].map(([label, record]) =>
            record ? (
              <div
                key={label}
                className="mt-2 rounded-sm border-hairline border-zinc-200 bg-white p-2.5 text-14"
              >
                {" "}
                <div className="flex items-center gap-2 text-zinc-900 font-medium mb-1">
                  {" "}
                  <ShieldCheck size={14} strokeWidth={1.75} />{" "}
                  <span>
                    {record.advisory
                      ? `${label} (advisory)`
                      : `${label} Approval`}
                  </span>{" "}
                </div>{" "}
                <div className="text-ink-secondary">
                  {record.advisory
                    ? `Recorded without approval ceremony${
                        record.recordedAt
                          ? ` on ${fmtDate(record.recordedAt)}`
                          : ""
                      }`
                    : `${approvalCodeLabel(record.reasonCode)}${
                        record.approvedByRole
                          ? ` by ${record.approvedByRole}`
                          : ""
                      }${
                        record.approvedAt
                          ? ` on ${fmtDate(record.approvedAt)}`
                          : ""
                      }`}
                </div>
                {record.note && (
                  <div className="text-zinc-900 mt-1">{record.note}</div>
                )}
                {Array.isArray(record.blocks) && record.blocks.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {record.blocks.map((block, idx) => (
                      <div key={idx} className="text-ink-secondary">
                        {block.message || approvalCodeLabel(block.code)}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : null,
          )}
          {tankCleanout && (
            <div className="mt-2 rounded-sm border-hairline border-zinc-200 bg-white p-2.5">
              {" "}
              <div className="flex items-center gap-2 text-zinc-900 font-medium mb-1">
                {" "}
                <Droplets size={14} strokeWidth={1.75} />{" "}
                <span>Tank Cleanout Audit</span>{" "}
              </div>{" "}
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-ink-secondary">
                {" "}
                <div>
                  Last product:{" "}
                  <span className="text-zinc-900">
                    {tankCleanout.lastProductInTank || "None recorded"}
                  </span>
                </div>{" "}
                <div>
                  Cleanout:{" "}
                  <span className="text-zinc-900">
                    {/* Advisory-only records (no equipment step in the
                        closeout) carry no attestation — "Not completed"
                        would turn an uncollected answer into an affirmative
                        claim the tech failed to clean the tank. */}
                    {tankCleanout.cleanoutCompleted
                      ? "Completed"
                      : tankCleanout.cleanoutCompleted == null
                        ? "Not recorded"
                        : "Not completed"}
                  </span>
                </div>{" "}
                <div>
                  Method:{" "}
                  <span className="text-zinc-900">
                    {tankCleanout.cleanoutMethod || "—"}
                  </span>
                </div>{" "}
                <div>
                  Recorded:{" "}
                  <span className="text-zinc-900">
                    {tankCleanout.recordedAt
                      ? fmtDate(tankCleanout.recordedAt)
                      : "—"}
                  </span>
                </div>{" "}
              </div>
              {tankCleanout.note && (
                <div className="text-zinc-900 mt-1">{tankCleanout.note}</div>
              )}
              {Array.isArray(tankCleanout.warnings) &&
                tankCleanout.warnings.length > 0 && (
                  <div className="text-ink-secondary mt-1">
                    Warnings:{" "}
                    {tankCleanout.warnings
                      .map((warning) => warning.message)
                      .filter(Boolean)
                      .join("; ")}
                  </div>
                )}
            </div>
          )}
          {inventoryDeductions.length > 0 && (
            <div className="mt-2 rounded-sm border-hairline border-zinc-200 bg-white p-2.5">
              {" "}
              <div className="font-medium text-zinc-900 mb-1">
                Inventory Audit
              </div>{" "}
              <div className="space-y-1">
                {inventoryDeductions.map((item, idx) => (
                  <div key={idx} className="text-ink-secondary">
                    {" "}
                    <div className="flex justify-between gap-3">
                      {" "}
                      <span className="text-zinc-900">
                        {item.productName || item.product_name || "Product"}
                      </span>{" "}
                      <span className="u-nums">
                        {inventoryAuditAmount(item)}
                        {item.costUsed != null || item.cost_used != null
                          ? ` · ${fmtCurrency(item.costUsed ?? item.cost_used)}`
                          : ""}
                      </span>{" "}
                    </div>
                    {item.warning && (
                      <div className="mt-0.5">{item.warning}</div>
                    )}
                  </div>
                ))}
              </div>{" "}
            </div>
          )}
          {!s.notes &&
            !s.products_used &&
            !s.areas_treated &&
            !isProjectCompletion &&
            !hasWaveGuardAudit && (
              <div className="text-ink-secondary">No additional details</div>
            )}
        </div>
      )}
    </div>
  );
}

// ─── Property zones desk backfill (satellite coverage) ──────────────────
// Office flow for the zone-marking lane: re-mark a property whose satellite
// marks were dropped by a geocode drift, or backfill marks onto zones created
// before the capture UI existed. Reuses the completion flow's ZoneMarkingStep
// (retained-module pattern) against the customer-scoped endpoints from
// PR #2386. Server contract: one entry per label; complete line-scoped sets
// (every zone on the selected line ends marked, or everything ends cleared);
// only TOUCHED labels submit — resubmitting an untouched preload would
// restamp its drift ref with today's image params.

function normalizeZoneKey(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Mirrors the server's zoneSupportsServiceLine: untagged zones participate
// in every line; tagged zones only in their own.
function zoneOnServiceLine(zone, line) {
  const lines = Array.isArray(zone.serviceLines) ? zone.serviceLines : [];
  if (!lines.length || !line) return true;
  return lines.includes(line);
}

// Pure entry composition, exported for tests: a drawn shape submits with the
// served image's params as its drift ref; a removed PRELOADED mark submits a
// clear tombstone; a removed same-session mark submits nothing. On an
// all-cleared save, zones whose stored mark was HIDDEN by drift resolution
// (staleKeys — the raw column still holds a shape the PUT's completeness
// check will see) get an explicit clear too, or the server would reject the
// save as partial over a mark the operator cannot even see.
export function composeZoneShapeEntries({
  areas,
  marks,
  dirty,
  preloads,
  image,
  capturedAt,
  staleKeys = new Set(),
  allCleared = false,
}) {
  const ref = {
    lat: image?.center?.lat,
    lng: image?.center?.lng,
    zoom: image?.zoom,
    width: image?.width || 640,
    height: image?.height || 340,
    capturedAt,
  };
  const entries = [];
  for (const label of areas) {
    if (!dirty.has(label)) continue;
    const mark = Object.prototype.hasOwnProperty.call(marks, label)
      ? marks[label]
      : undefined;
    if (mark) entries.push({ areaLabel: label, shape: { ...mark, ref } });
    else if (mark === null && preloads[normalizeZoneKey(label)]) {
      entries.push({ areaLabel: label, clear: true });
    }
  }
  if (allCleared) {
    for (const label of areas) {
      if (entries.some((entry) => entry.areaLabel === label)) continue;
      if (staleKeys.has(normalizeZoneKey(label))) {
        entries.push({ areaLabel: label, clear: true });
      }
    }
  }
  return entries;
}

function PropertyZonesPanel({ customerId }) {
  const [open, setOpen] = useState(false);
  const [map, setMap] = useState(null); // property-map payload
  const [loading, setLoading] = useState(false);
  const [line, setLine] = useState("pest");
  const [marks, setMarks] = useState({}); // this session's edits (null = removed)
  const [preloads, setPreloads] = useState({}); // normalized-label → stored shape
  const dirtyRef = useRef(new Set());
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  // bumped by Retry — the fetch effect must not depend on the map/loading
  // state it mutates, or its own setLoading(true) triggers the cleanup that
  // cancels the request it just started
  const [loadNonce, setLoadNonce] = useState(0);

  // The 360 sheet swaps customers in place (selected360Id) — everything here
  // is per-property state, so a customer change must drop it all or the old
  // satellite image/zones would stay on screen while saves hit the new id.
  // customerRef lets in-flight save responses check whether they still
  // belong to the customer on screen (the load effect uses its own cleanup).
  const customerRef = useRef(customerId);
  useEffect(() => {
    customerRef.current = customerId;
    setOpen(false);
    setMap(null);
    setMarks({});
    setPreloads({});
    dirtyRef.current = new Set();
    setLine("pest");
    setErr("");
    setMsg("");
    setSaving(false);
  }, [customerId]);

  // Deps are the EXPANSION triggers only (open / customer / Retry nonce) —
  // never the map/loading state this effect writes, so starting the request
  // cannot re-run the effect and self-cancel via its own cleanup.
  useEffect(() => {
    if (!open || map) return undefined;
    // cancelled guards the resolve against a customer switch mid-flight —
    // without it, customer A's response would repopulate the panel after the
    // customerId reset, and a later save would post A's zones to B's id
    let cancelled = false;
    setLoading(true);
    setErr("");
    adminFetch(`/admin/dispatch/customers/${customerId}/property-map`)
      .then((res) => {
        if (cancelled) return;
        setMap(res || { available: false, reason: "empty_response" });
        const preload = {};
        const norm01 = (v) =>
          Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 1;
        (res?.zones || []).forEach((zone) => {
          const shape = zone.geometryImage;
          if (!shape || typeof shape !== "object") return;
          if (shape.type === "rect" || shape.type === "circle") {
            preload[normalizeZoneKey(zone.label)] = shape;
          } else if (
            shape.type == null &&
            [shape.x, shape.y, shape.w, shape.h].every(norm01)
          ) {
            // legacy typeless rect — the report renderer treats it as a
            // valid rect, so it must preload (and be clearable) here too
            preload[normalizeZoneKey(zone.label)] = { ...shape, type: "rect" };
          }
        });
        setPreloads(preload);
        const tagged = new Set(
          (res?.zones || []).flatMap((zone) =>
            Array.isArray(zone.serviceLines) ? zone.serviceLines : [],
          ),
        );
        if (tagged.size && !tagged.has("pest")) setLine([...tagged][0]);
      })
      .catch((e) => {
        if (cancelled) return;
        // map must go non-null or this effect refires and loops the failed
        // request forever; the render shows the error with a manual Retry
        setErr(e.message || "Failed to load the property map");
        setMap({ available: false, reason: "load_failed" });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, customerId, loadNonce]);

  const zones = map?.zones || [];
  // only lines that actually surface at least one zone (untagged zones match
  // every line, so an all-untagged property still offers the pest default)
  const lineOptions = [
    ...new Set(["pest", ...zones.flatMap((z) => z.serviceLines || [])]),
  ].filter((opt) => zones.some((zone) => zoneOnServiceLine(zone, opt)));
  // zones whose stored mark was hidden by drift resolution — the raw column
  // still holds a shape the PUT's completeness check will count as marked
  const staleKeys = new Set(
    zones
      .filter((zone) => zone.staleMark)
      .map((zone) => normalizeZoneKey(zone.label)),
  );
  const areas = zones
    .filter((zone) => zoneOnServiceLine(zone, line))
    .map((zone) => zone.label);
  const displayMarks = {};
  areas.forEach((label) => {
    const local = Object.prototype.hasOwnProperty.call(marks, label)
      ? marks[label]
      : undefined;
    const mark = local !== undefined ? local : preloads[normalizeZoneKey(label)];
    if (mark) displayMarks[label] = mark;
  });
  const markedCount = areas.filter((label) => displayMarks[label]).length;
  const dirtyCount = [...dirtyRef.current].filter((label) =>
    areas.includes(label),
  ).length;
  const staleOnLine = areas.filter((label) =>
    staleKeys.has(normalizeZoneKey(label)),
  ).length;
  // A fully-drifted property shows nothing to remove, so there is no dirty
  // action an operator could take — Save doubles as "clear the stale marks"
  // (composeZoneShapeEntries emits the tombstones on all-cleared saves).
  const clearingStaleOnly =
    dirtyCount === 0 && markedCount === 0 && staleOnLine > 0;
  // Server end-state gate: all marked, or all cleared. Anything else is 400.
  const saveable =
    (dirtyCount > 0 && (markedCount === areas.length || markedCount === 0)) ||
    clearingStaleOnly;

  const setZoneMark = (label, shape) => {
    // frozen during a save: ZoneMarkingStep's Remove/resize buttons bypass
    // its disabled prop, and an edit landing here mid-PUT would be wiped by
    // the success handler while the panel reports Saved
    if (saving) return;
    dirtyRef.current.add(label);
    setMarks((prev) => ({ ...prev, [label]: shape }));
  };
  const clearZoneMark = (label) => {
    if (saving) return;
    // removing a preload must submit a clear; removing a session mark is local
    if (preloads[normalizeZoneKey(label)]) dirtyRef.current.add(label);
    else dirtyRef.current.delete(label);
    setMarks((prev) => ({ ...prev, [label]: null }));
  };

  const save = async () => {
    if (!saveable || saving) return;
    setSaving(true);
    setErr("");
    setMsg("");
    try {
      const entries = composeZoneShapeEntries({
        areas,
        marks,
        dirty: dirtyRef.current,
        preloads,
        image: map?.image,
        capturedAt: new Date().toISOString(),
        staleKeys,
        allCleared: markedCount === 0,
      });
      if (!entries.length) {
        setMsg("Nothing to save");
        return;
      }
      const res = await adminFetch(
        `/admin/dispatch/customers/${customerId}/property-zones`,
        {
          method: "PUT",
          body: JSON.stringify({ serviceLine: line, zoneShapes: entries }),
        },
      );
      // the 360 sheet may have swapped customers while the PUT was in
      // flight — this response belongs to the OLD customer, and folding it
      // into state would overwrite the new customer's panel
      if (customerRef.current !== customerId) return;
      // fold the saved state into the preloads so the panel reflects
      // reality, and drop ONLY the saved labels from the edit state — an
      // operator can have unsaved marks on another service line, and wiping
      // everything here would silently discard them
      const savedLabels = new Set(entries.map((entry) => entry.areaLabel));
      const savedKeys = new Set(
        entries.map((entry) => normalizeZoneKey(entry.areaLabel)),
      );
      const nextPreloads = { ...preloads };
      for (const entry of entries) {
        const key = normalizeZoneKey(entry.areaLabel);
        if (entry.clear) delete nextPreloads[key];
        else nextPreloads[key] = entry.shape;
      }
      setPreloads(nextPreloads);
      // saved zones are no longer stale — leaving the flags set would keep
      // the warning (and the Clear-stale-marks button) alive and let every
      // further click send another no-op clear
      setMap((prev) =>
        prev?.zones
          ? {
            ...prev,
            zones: prev.zones.map((zone) =>
              savedKeys.has(normalizeZoneKey(zone.label))
                ? { ...zone, staleMark: false }
                : zone,
            ),
          }
          : prev,
      );
      setMarks((prev) => {
        const next = { ...prev };
        savedLabels.forEach((label) => delete next[label]);
        return next;
      });
      const nextDirty = new Set(dirtyRef.current);
      savedLabels.forEach((label) => nextDirty.delete(label));
      dirtyRef.current = nextDirty;
      const s = res?.summary || {};
      setMsg(
        `Saved — ${s.shapesApplied || 0} mark${(s.shapesApplied || 0) === 1 ? "" : "s"} applied${s.cleared ? `, ${s.cleared} cleared` : ""}${s.created ? `, ${s.created} zone${s.created === 1 ? "" : "s"} created` : ""}`,
      );
    } catch (e) {
      if (customerRef.current === customerId) setErr(e.message || "Save failed");
    } finally {
      if (customerRef.current === customerId) setSaving(false);
    }
  };

  return (
    <div className="mb-4 pb-3 border-b border-hairline border-zinc-200">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle className="mb-0">
          Satellite Coverage Zones
        </SectionTitle>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Mark treated areas"}
        </Button>
      </div>
      {!open && <p className="text-14 text-ink-secondary mt-2">Open the map to review saved coverage or mark treated areas.</p>}
      {open && (
        <div className="mt-3">
          {loading && (
            <div className="text-ui-body text-ink-secondary">Loading the satellite view…</div>
          )}
          {!loading && map && !map.available && (
            <div className="flex items-center gap-3">
              <span className={cn("text-ui-body", map.reason === "load_failed" ? "text-alert-fg" : "text-ink-secondary")}>
                {map.reason === "load_failed"
                  ? err || "Failed to load the property map"
                  : `Satellite view unavailable (${map.reason || "unknown"}).`}
              </span>
              {map.reason === "load_failed" && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setMap(null);
                    setErr("");
                    setLoadNonce((n) => n + 1);
                  }}
                >
                  Retry
                </Button>
              )}
            </div>
          )}
          {!loading && map?.available && !zones.length && (
            <div className="text-ui-body text-ink-secondary">
              No zones yet — zones are created when a visit is completed with
              treated areas.
            </div>
          )}
          {!loading && map?.available && zones.length > 0 && (
            <div>
              {lineOptions.length > 1 && (
                <div className="flex items-center gap-2 mb-2">
                  <span className="text-ui-label text-ink-secondary">Service line</span>
                  {lineOptions.map((opt) => (
                    <button data-ui-text-action
                      key={opt}
                      type="button"
                      onClick={() => setLine(opt)}
                      className={cn(
                        "text-ui-label px-2 py-0.5 rounded-sm border-hairline u-focus-ring",
                        opt === line
                          ? "border-zinc-900 bg-zinc-900 text-white"
                          : "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100",
                      )}
                    >
                      {opt.replace(/_/g, " ")}
                    </button>
                  ))}
                </div>
              )}
              {areas.some((label) => staleKeys.has(normalizeZoneKey(label))) && (
                <div className="text-ui-label text-zinc-700 mb-2">
                  Some zones have marks that no longer match the current
                  satellite image (the property was re-geocoded) — they show
                  as unmarked below. Redraw them, or clear everything to
                  remove the stored marks:{" "}
                  {areas
                    .filter((label) => staleKeys.has(normalizeZoneKey(label)))
                    .join(", ")}
                  .
                </div>
              )}
              <ZoneMarkingStep
                map={map}
                areas={areas}
                marks={displayMarks}
                onSetMark={setZoneMark}
                onClearMark={clearZoneMark}
                disabled={saving}
              />
              <div className="flex items-center gap-3 mt-2">
                <Button size="sm" onClick={save} disabled={!saveable || saving}>
                  {saving
                    ? "Saving…"
                    : clearingStaleOnly
                      ? "Clear stale marks"
                      : "Save zone marks"}
                </Button>
                {!saveable && dirtyCount > 0 && (
                  <span className="text-ui-label text-ink-secondary">
                    Mark every zone on this line (or clear them all) to save.
                  </span>
                )}
                {msg && <span className="text-ui-label text-zinc-700">{msg}</span>}
                {err && map && (
                  <span className="text-ui-label text-alert-fg">{err}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Flag gate — the stations panel stays dark until station-map-v1 is on for
// this operator (DB-backed user_feature_flags, fails closed).
function TermiteStationsGate({ customerId }) {
  const { enabled, ready } = useFeatureFlagReady("station-map-v1");
  if (!ready || !enabled) return null;
  return <TermiteStationsPanel customerId={customerId} />;
}

// ─── Termite bait stations panel (station-map-v1) ────────────────
// Office desk flow for the bait station map: drop/move/retire the
// property's station pins on the satellite view outside a completion.
// This is the takeover path — an account inherited from another company
// gets its stations mapped from the office before our first visit, and
// the tech confirms positions in the field. Positions only: statuses are
// per-visit data and belong to the completion flow.
function TermiteStationsPanel({ customerId }) {
  const [open, setOpen] = useState(false);
  const [map, setMap] = useState(null); // property-map payload
  const [loading, setLoading] = useState(false);
  // program picks which registry slice (termite in-ground vs rodent
  // exterior) the panel edits — pins, numbering, and saves are all scoped
  const [program, setProgram] = useState("termite");
  const [allStations, setAllStations] = useState([]); // both programs, tagged
  const [newPins, setNewPins] = useState([]); // [{ key, number, shape }]
  const [moves, setMoves] = useState({}); // id → shape
  const [retired, setRetired] = useState([]); // ids retired this session
  const [numberBases, setNumberBases] = useState({ termite: 1, rodent: 1, trapping: 1 });
  const newSeqRef = useRef(0);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [loadNonce, setLoadNonce] = useState(0);

  // The 360 sheet swaps customers in place — drop all per-property state on
  // a switch, same rules as PropertyZonesPanel above.
  const customerRef = useRef(customerId);
  useEffect(() => {
    customerRef.current = customerId;
    setOpen(false);
    setMap(null);
    setProgram("termite");
    setAllStations([]);
    setNewPins([]);
    setMoves({});
    setRetired([]);
    setNumberBases({ termite: 1, rodent: 1, trapping: 1 });
    setErr("");
    setMsg("");
    setSaving(false);
  }, [customerId]);

  useEffect(() => {
    if (!open || map) return undefined;
    let cancelled = false;
    setLoading(true);
    setErr("");
    adminFetch(`/admin/dispatch/customers/${customerId}/property-map`)
      .then((res) => {
        if (cancelled) return;
        setMap(res || { available: false, reason: "empty_response" });
        setAllStations((Array.isArray(res?.stations) ? res.stations : []).map((station) => ({
          id: String(station.id),
          number: station.number,
          program: station.program || "termite",
          label: station.label || null,
          shape: station.geometryImage && station.geometryImage.type === "circle"
            ? station.geometryImage
            : null,
          stale: Boolean(station.staleMark),
        })));
        setNumberBases({
          termite: Number(res?.nextStationNumberByProgram?.termite) || Number(res?.nextStationNumber) || 1,
          rodent: Number(res?.nextStationNumberByProgram?.rodent) || 1,
          trapping: Number(res?.nextStationNumberByProgram?.trapping) || 1,
        });
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(e.message || "Failed to load the property map");
        setMap({ available: false, reason: "load_failed" });
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, customerId, loadNonce]);

  const preloads = allStations.filter((station) => station.program === program);
  const display = [
    ...preloads
      .filter((station) => !retired.includes(station.id))
      .map((station) => ({
        key: station.id,
        id: station.id,
        number: station.number,
        label: station.label,
        shape: moves[station.id] || station.shape,
        stale: station.stale && !moves[station.id],
      })),
    ...newPins.map((station) => ({
      key: station.key,
      id: null,
      number: station.number,
      label: null,
      shape: station.shape,
      stale: false,
    })),
  ];
  const dirtyCount = newPins.length + Object.keys(moves).length + retired.length;
  // Unsaved edits belong to the CURRENT program's registry slice — switching
  // mid-edit would save termite pins into the rodent slice (or vice versa),
  // so the toggle locks until the operator saves or the panel reloads.
  const switchProgram = (next) => {
    if (saving || next === program || dirtyCount > 0) return;
    setProgram(next);
    setMsg("");
    setErr("");
  };

  const addPin = (pt) => {
    if (saving) return;
    newSeqRef.current += 1;
    setNewPins((prev) => {
      const base = Math.max(
        Number(numberBases[program]) || 1,
        ...prev.map((station) => (Number(station.number) || 0) + 1),
      );
      return [
        ...prev,
        {
          key: `new-${newSeqRef.current}`,
          number: base,
          shape: { type: "circle", cx: pt.cx, cy: pt.cy, r: 0.035 },
        },
      ];
    });
  };
  const movePin = (key, pt) => {
    if (saving) return;
    const shape = { type: "circle", cx: pt.cx, cy: pt.cy, r: 0.035 };
    if (newPins.some((station) => station.key === key)) {
      setNewPins((prev) => prev.map((station) => (station.key === key ? { ...station, shape } : station)));
    } else {
      setMoves((prev) => ({ ...prev, [key]: shape }));
    }
  };
  const removePin = (key) => {
    if (saving) return;
    if (newPins.some((station) => station.key === key)) {
      setNewPins((prev) => prev.filter((station) => station.key !== key));
    } else {
      // A pending move for this id must not survive the retire — the save
      // payload would carry BOTH a retire and a shape entry for one station,
      // which the server rejects as a duplicate id and Save dead-ends.
      setMoves((prev) => {
        if (!(key in prev)) return prev;
        const next = { ...prev };
        delete next[key];
        return next;
      });
      setRetired((prev) => (prev.includes(key) ? prev : [...prev, key]));
    }
  };

  const save = async () => {
    if (!dirtyCount || saving || !map?.available) return;
    setSaving(true);
    setErr("");
    setMsg("");
    try {
      const image = map.image || {};
      const ref = {
        lat: image.center?.lat,
        lng: image.center?.lng,
        zoom: image.zoom,
        width: image.width || 640,
        height: image.height || 340,
        capturedAt: new Date().toISOString(),
      };
      const entries = [
        ...retired.map((id) => ({ id, retire: true })),
        // belt to removePin's suspenders: one final state per station id
        ...Object.entries(moves)
          .filter(([id]) => !retired.includes(id))
          .map(([id, shape]) => ({ id, shape: { ...shape, ref } })),
        ...newPins.map((station) => ({ shape: { ...station.shape, ref } })),
      ];
      const res = await adminFetch(
        `/admin/dispatch/customers/${customerId}/termite-stations`,
        {
          method: "PUT",
          body: JSON.stringify({ stations: entries, program }),
        },
      );
      if (customerRef.current !== customerId) return;
      const s = res?.summary || {};
      setMsg(
        `Saved — ${s.created || 0} added${s.moved ? `, ${s.moved} moved` : ""}${s.retired ? `, ${s.retired} retired` : ""}`,
      );
      // Refetch so pins show their REAL persisted numbers (the server
      // allocates; provisional numbers were a preview) and edit state
      // starts clean.
      setNewPins([]);
      setMoves({});
      setRetired([]);
      setMap(null);
      setLoadNonce((n) => n + 1);
    } catch (e) {
      if (customerRef.current === customerId) setErr(e.message || "Save failed");
    } finally {
      if (customerRef.current === customerId) setSaving(false);
    }
  };

  return (
    <div className="mb-4 pb-3 border-b border-hairline border-zinc-200">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle className="mb-0">Bait Stations</SectionTitle>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Hide" : "Mark stations"}
        </Button>
      </div>
      {open && (
        <div className="mt-3">
          {loading && (
            <div className="text-ui-body text-ink-secondary">Loading the satellite view…</div>
          )}
          {!loading && map && !map.available && (
            <div className="flex items-center gap-3">
              <span className={cn("text-ui-body", map.reason === "load_failed" ? "text-alert-fg" : "text-ink-secondary")}>
                {map.reason === "load_failed"
                  ? err || "Failed to load the property map"
                  : `Satellite view unavailable (${map.reason || "unknown"}).`}
              </span>
              {map.reason === "load_failed" && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setMap(null);
                    setErr("");
                    setLoadNonce((n) => n + 1);
                  }}
                >
                  Retry
                </Button>
              )}
            </div>
          )}
          {!loading && map?.available && (
            <div>
              <div className="flex items-center gap-2 mb-2">
                <span className="text-ui-label text-ink-secondary">Program</span>
                {["termite", "rodent", "trapping"].map((opt) => (
                  <button data-ui-text-action
                    key={opt}
                    type="button"
                    disabled={saving || (dirtyCount > 0 && opt !== program)}
                    title={dirtyCount > 0 && opt !== program ? "Save or discard this program's edits first" : undefined}
                    onClick={() => switchProgram(opt)}
                    className={cn(
                      "text-ui-label px-2 py-0.5 rounded-sm border-hairline u-focus-ring",
                      opt === program
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-200 bg-zinc-50 text-zinc-700 hover:bg-zinc-100",
                      dirtyCount > 0 && opt !== program ? "opacity-50" : "",
                    )}
                  >
                    {opt === "termite" ? "Termite" : opt === "rodent" ? "Rodent" : "Traps"}
                  </button>
                ))}
              </div>
              <StationMarkingStep
                map={map}
                stations={display}
                statuses={{}}
                onAddStation={addPin}
                onMoveStation={movePin}
                onSetStatus={() => {}}
                onRemoveStation={removePin}
                showStatuses={false}
                maxStations={Number(map?.stationCap) || 80}
                program={program}
                disabled={saving}
              />
              <div className="flex items-center gap-3 mt-2">
                <Button size="sm" onClick={save} disabled={!dirtyCount || saving}>
                  {saving ? "Saving…" : "Save stations"}
                </Button>
                {msg && <span className="text-ui-label text-zinc-700">{msg}</span>}
                {err && map && (
                  <span className="text-ui-label text-alert-fg">{err}</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Autopay panel ───────────────────────────────────────────────
const BILLING_LANE_OPTIONS = [
  { value: "", label: "Not set (legacy — inferred)" },
  { value: "monthly_membership", label: "Monthly membership — dues cover recurring visits" },
  { value: "per_visit", label: "Per visit — invoice on completion" },
  { value: "per_application", label: "Per application — fee collected each visit" },
  { value: "annual_prepay", label: "Annual prepay" },
  { value: "one_time", label: "One-time" },
];

// The ONE place the billing lane is set (customers.billing_mode). Every
// billing flow — the monthly cron, completion invoicing, booking price
// stamps, the schedule sheet's prediction — reads this instead of inferring
// from tier/rate field combinations, so a customer can never sit in two
// lanes at once. Named export for component tests/harnesses.
export function BillingLanePanelV2({ customerId, billingMode, tier, monthlyRate, canEdit }) {
  const [mode, setMode] = useState(billingMode || "");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  useEffect(() => {
    setMode(billingMode || "");
  }, [customerId, billingMode]);
  const inferred =
    tier && parseFloat(monthlyRate || 0) > 0 ? "Monthly membership" : "Per visit";
  const save = async (next) => {
    setSaving(true);
    setErr("");
    setMsg("");
    try {
      const r = await fetch(`${API_BASE}/admin/customers/${customerId}`, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ billingMode: next || null }),
      });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${r.status}`);
      }
      setMode(next);
      setMsg("Saved");
    } catch (e) {
      setErr(e.message || "Save failed");
    }
    setSaving(false);
  };
  return (
    <Card className="mb-5">
      {" "}
      <CardBody className="p-4">
        {" "}
        <label htmlFor={`billing-mode-${customerId}`} className="block ui-label text-ink-secondary mb-1">
          How this customer pays
        </label>{" "}
        <div className="flex items-center gap-2 flex-wrap">
          {" "}
          <Select
            id={`billing-mode-${customerId}`}
            value={mode}
            disabled={!canEdit || saving}
            onChange={(e) => save(e.target.value)}
            className="min-w-0 max-w-full"
          >
            {BILLING_LANE_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </Select>{" "}
          {saving && <span className="text-ui-label text-ink-secondary">Saving…</span>}{" "}
        </div>
        {!mode && (
          <div className="text-ui-label text-ink-secondary mt-1.5">
            Unset — currently behaves as{" "}
            <span className="text-zinc-900">{inferred}</span> (inferred from
            tier + monthly rate).
          </div>
        )}
        {mode === "monthly_membership" && (
          <div className="text-ui-label text-ink-secondary mt-1.5">
            Dues on the 1st cover recurring plan visits — completions never
            invoice them.
          </div>
        )}
        {msg && (
          <div className="mt-2.5 px-2 py-1.5 bg-zinc-100 text-zinc-900 rounded-xs text-ui-label">
            {msg}
          </div>
        )}
        {err && (
          <div className="mt-2.5 px-2 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">
            {err}
          </div>
        )}
      </CardBody>
    </Card>
  );
}

function AdminAutopayPanelV2({
  customerId,
  monthlyRate,
  customerName,
  canCharge = false,
}) {
  const [state, setState] = useState(null);
  const [charging, setCharging] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const outcomeRef = useRef(null);
  useEffect(() => {
    if (msg || err) outcomeRef.current?.scrollIntoView?.({ block: "center" });
  }, [msg, err]);

  const load = () => {
    fetch(`${API_BASE}/admin/customers/${customerId}/autopay-state`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setState(d))
      .catch(() => {});
  };

  useEffect(() => {
    load();
  }, [customerId]);

  const chargeNow = async () => {
    const amt = parseFloat(monthlyRate || 0);
    if (!amt || amt <= 0) {
      setErr("Customer has no monthly_rate set");
      return;
    }
    if (!window.confirm(`Charge ${customerName} $${amt.toFixed(2)} now?`))
      return;
    setCharging(true);
    setErr("");
    setMsg("");
    try {
      const result = await adminFetch(`/admin/customers/${customerId}/charge-now`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      const payment = result?.payment;
      const collected = Number.parseFloat(payment?.amount);
      const amountLabel = Number.isFinite(collected) ? ` $${collected.toFixed(2)}` : "";
      if (payment?.status === "paid") {
        setMsg(`Payment${amountLabel} completed`);
      } else if (payment?.status === "processing") {
        setMsg(`Payment${amountLabel} is processing. Settlement is pending.`);
      } else {
        setMsg("Payment status is not confirmed. Check payment history before trying again.");
      }
      load();
    } catch (e) {
      setErr(e.message || "Charge failed");
    }
    setCharging(false);
  };

  const stateLabel = state?.state || "unknown";
  const isAlertState = stateLabel === "paused" || stateLabel === "failed";

  return (
    <Card className="mb-5">
      {" "}
      <CardBody className="p-4">
        {" "}
        <div className="flex justify-between items-start gap-3 flex-wrap">
          {" "}
          <div>
            {" "}
            <div className="ui-label text-ink-secondary mb-1">Auto-pay</div>{" "}
            <div className="flex items-center gap-2">
              {" "}
              <span
                className={cn(
                  "w-2 h-2 rounded-full inline-block",
                  isAlertState
                    ? "bg-alert-fg"
                    : stateLabel === "active"
                      ? "bg-zinc-900"
                      : "bg-zinc-400",
                )}
              />{" "}
              <span className="text-14 font-medium text-zinc-900 capitalize">
                {stateLabel}
              </span>{" "}
            </div>
            {state && (
              <div className="text-ui-label text-ink-secondary mt-1.5 leading-relaxed">
                Next charge:{" "}
                <span className="u-nums text-zinc-900">
                  {state.next_charge_date || "—"}
                </span>
                {" · "}Day:{" "}
                <span className="u-nums text-zinc-900">
                  {state.billing_day || 1}
                </span>
                {state.paused_until && (
                  <>
                    {" · "}Paused until {fmtDate(state.paused_until)}
                  </>
                )}
              </div>
            )}
          </div>
          {canCharge && (
            <Button onClick={chargeNow} disabled={charging} size="md">
              {charging
                ? "Charging…"
                : `Charge now${monthlyRate ? ` ($${parseFloat(monthlyRate).toFixed(2)})` : ""}`}
            </Button>
          )}
        </div>
        {msg && (
          <div ref={outcomeRef} role="status" className="mt-2.5 px-2 py-1.5 bg-zinc-100 text-zinc-900 rounded-xs text-14">
            {msg}
          </div>
        )}
        {err && (
          <div ref={outcomeRef} role="alert" className="mt-2.5 px-2 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-14">
            {err}
          </div>
        )}
        {state?.recent_events?.length > 0 && (
          <div className="mt-3 border-t border-hairline border-zinc-200 pt-2.5">
            {" "}
            <div className="ui-label text-ink-secondary mb-1.5">
              Recent events
            </div>
            {state.recent_events.slice(0, 5).map((ev) => (
              <div
                key={ev.id}
                className="text-ui-caption text-ink-secondary py-0.5 flex justify-between gap-2"
              >
                {" "}
                <span className="u-nums text-zinc-900">
                  {ev.event_type}
                </span>{" "}
                <span>
                  {ev.amount_cents != null
                    ? `$${(ev.amount_cents / 100).toFixed(2)}`
                    : ""}
                </span>{" "}
                <span>{timeAgo(ev.created_at)}</span>{" "}
              </div>
            ))}
          </div>
        )}
      </CardBody>{" "}
    </Card>
  );
}

// ─── Account credit panel ───────────────────────────────────────
// Shows the customer's account-credit balance + ledger history and lets
// admins issue or adjust credit. Credit is the holding bucket for money
// paid ahead (quarterly prepay) and goodwill; it is drawn down against
// invoices from the invoice's "Apply credit" action. Self-contained:
// fetches /admin/customers/:id/credits on its own.
const CREDIT_SOURCE_LABELS = {
  manual: "Manual credit",
  adjustment: "Adjustment",
  invoice_application: "Applied to invoice",
  invoice_prepaid: "Prepaid invoice",
  referral: "Referral",
};

function AccountCreditPanelV2({ customerId, customerName, canEdit = false, onChanged }) {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [direction, setDirection] = useState("add");
  const [amount, setAmount] = useState("");
  // Funding kind for an addition: 'prepayment' (cash received → books revenue
  // at issuance) or 'goodwill' (courtesy, no money). A deduction is always an
  // 'adjustment'. Method applies to a prepayment only.
  const [fundKind, setFundKind] = useState("prepayment");
  const [method, setMethod] = useState("cash");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");
  const [loadError, setLoadError] = useState(false);

  // Tracks the customer the panel is currently bound to. Every /credits fetch
  // (initial, Retry, post-mutation refresh) tags its response against this so a
  // response for a previously-selected customer can never write into the panel
  // after a switch — which would otherwise show A's ledger while submits target B.
  const currentCustomerRef = useRef(customerId);
  const load = () => {
    const reqId = customerId;
    setLoadError(false);
    adminFetch(`/admin/customers/${reqId}/credits`)
      .then((d) => {
        if (currentCustomerRef.current !== reqId) return;
        setData(d);
        setLoadError(false);
      })
      .catch(() => {
        if (currentCustomerRef.current !== reqId) return;
        setLoadError(true);
      });
  };
  // On customer switch, drop the previous customer's data immediately (so the
  // panel never shows a stale balance) and re-bind the ref before fetching.
  useEffect(() => {
    currentCustomerRef.current = customerId;
    setData(null);
    setLoadError(false);
    setOpen(false);
    load();
  }, [customerId]);

  // Only treat the ledger as known once a fetch has succeeded AND the latest
  // fetch didn't fail. A failed refresh (even after a prior success) flips back
  // to not-loaded so the panel shows "Balance unavailable" + disables the form
  // — never a stale balance with an enabled form (would invite duplicate credit).
  const loaded = data != null && !loadError;
  const balance = Number(data?.balance || 0);
  const ledger = data?.ledger || [];

  const submit = async () => {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      setErr("Enter an amount greater than 0");
      return;
    }
    const delta = direction === "deduct" ? -amt : amt;
    const kind = direction === "deduct" ? "adjustment" : fundKind;
    setSaving(true);
    setErr("");
    try {
      await adminFetch(`/admin/customers/${customerId}/credits`, {
        method: "POST",
        body: JSON.stringify({
          amount: delta,
          kind,
          method: kind === "prepayment" ? method : undefined,
          note: note.trim() || undefined,
        }),
      });
      setOpen(false);
      setAmount("");
      setNote("");
      setDirection("add");
      setFundKind("prepayment");
      setMethod("cash");
      load();
      if (onChanged) onChanged();
    } catch (e) {
      setErr(e.message || "Failed to update credit");
    } finally {
      setSaving(false);
    }
  };

  const inputClass =
    "block w-full bg-white text-ui-body text-ink-primary border-hairline border-zinc-300 rounded-sm h-9 px-2.5 focus:outline-none focus:border-zinc-900";

  return (
    <Card className="mb-5">
      <CardBody className="p-4">
        <div className="flex justify-between items-start gap-3 flex-wrap mb-3">
          <div>
            <div className="ui-label text-ink-secondary mb-1">Account credit</div>
            <div className="text-22 text-zinc-900 u-nums leading-none">
              {loaded ? fmtCurrency(balance) : loadError ? "—" : "…"}
            </div>
            <div className="text-ui-label text-ink-tertiary mt-1">
              {loadError && !loaded
                ? "Balance unavailable"
                : "Available to apply to invoices"}
            </div>
          </div>
          {canEdit && (
            <Button
              size="sm"
              variant="secondary"
              disabled={!loaded}
              onClick={() => setOpen((v) => !v)}
            >
              {open ? "Cancel" : "Issue credit"}
            </Button>
          )}
        </div>

        {loadError && !loaded && (
          <div className="text-ui-label text-alert-fg mb-3 flex items-center gap-2">
            <span>Couldn't load the credit balance.</span>
            <button data-ui-text-action
              type="button"
              className="underline"
              onClick={load}
            >
              Retry
            </button>
          </div>
        )}

        {open && (
          <div className="border-hairline border-zinc-200 rounded-sm p-3 mb-3 bg-zinc-50">
            <div className="grid grid-cols-2 gap-2 mb-2">
              <label className="block">
                <span className="ui-label text-ink-tertiary block mb-1">Direction</span>
                <Select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value)}
                  className={inputClass}
                >
                  <option value="add">Add credit</option>
                  <option value="deduct">Deduct credit</option>
                </Select>
              </label>
              <label className="block">
                <span className="ui-label text-ink-tertiary block mb-1">Amount</span>
                <Input
                  type="number"
                  min="0"
                  step="0.01"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  className={cn(inputClass, "u-nums")}
                />
              </label>
            </div>
            {direction === "add" ? (
              <div className="grid grid-cols-2 gap-2 mb-2">
                <label className="block">
                  <span className="ui-label text-ink-tertiary block mb-1">Funding</span>
                  <Select
                    value={fundKind}
                    onChange={(e) => setFundKind(e.target.value)}
                    className={inputClass}
                  >
                    <option value="prepayment">Prepayment (money received)</option>
                    <option value="goodwill">Goodwill / courtesy (no money)</option>
                  </Select>
                </label>
                {fundKind === "prepayment" && (
                  <label className="block">
                    <span className="ui-label text-ink-tertiary block mb-1">Method</span>
                    <Select
                      value={method}
                      onChange={(e) => setMethod(e.target.value)}
                      className={inputClass}
                    >
                      <option value="cash">Cash</option>
                      <option value="check">Check</option>
                      <option value="zelle">Zelle</option>
                      <option value="venmo">Venmo</option>
                      <option value="paypal">PayPal</option>
                      <option value="other">Other</option>
                    </Select>
                  </label>
                )}
              </div>
            ) : (
              <div className="text-ui-label text-ink-tertiary mb-2">
                Recorded as an adjustment / correction (no payment booked).
              </div>
            )}
            <div className="text-ui-caption text-ink-tertiary mb-2 leading-snug">
              {direction === "add" && fundKind === "prepayment"
                ? "Books a payment now (counts as collected revenue at receipt)."
                : "No payment booked — does not count as revenue."}
            </div>
            <label className="block mb-2">
              <span className="ui-label text-ink-tertiary block mb-1">Note (optional)</span>
              <Input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Q3 quarterly prepay collected by check"
                className={inputClass}
              />
            </label>
            {err && <div className="text-ui-label text-alert-fg mb-2">{err}</div>}
            <Button size="sm" variant="primary" disabled={saving || !loaded} onClick={submit}>
              {saving
                ? "Saving…"
                : direction === "deduct"
                  ? "Deduct credit"
                  : `Add credit to ${customerName || "account"}`}
            </Button>
          </div>
        )}

        {ledger.length > 0 ? (
          <div>
            {ledger.slice(0, 8).map((row) => {
              const delta = Number(row.delta || 0);
              return (
                <div
                  key={row.id}
                  className="py-1.5 text-ui-label border-b border-hairline border-zinc-200/60 flex justify-between items-center gap-3"
                >
                  <span className={cn("u-nums", delta < 0 ? "text-ink-secondary" : "text-zinc-900")}>
                    {delta >= 0 ? "+" : "−"}
                    {fmtCurrency(Math.abs(delta))}
                  </span>
                  <span className="text-ink-secondary flex-1 truncate">
                    {CREDIT_SOURCE_LABELS[row.source] || row.source}
                    {row.note ? ` · ${row.note}` : ""}
                  </span>
                  <span className="text-ink-tertiary u-nums">
                    {fmtCurrency(Number(row.balance_after || 0))}
                  </span>
                  <span className="text-ink-tertiary">{fmtDate(row.created_at)}</span>
                </div>
              );
            })}
          </div>
        ) : loaded ? (
          <div className="text-ui-label text-ink-tertiary">No credit history yet</div>
        ) : null}
      </CardBody>
    </Card>
  );
}

function AnnualPrepayPanelV2({ activeTerm, onOpen, onSendInvoice }) {
  return (
    <Card className="mb-5">
      <CardBody className="p-4">
        <div className="flex justify-between items-start gap-3 flex-wrap">
          <div>
            <div className="ui-label text-ink-secondary mb-1">Annual prepay</div>
            {activeTerm ? (
              <>
                <div className="text-14 font-medium text-zinc-900">
                  {activeTerm.planLabel || "Annual Prepay"}
                </div>
                <div className="text-ui-label text-ink-secondary mt-1">
                  {fmtDate(activeTerm.termStart)} to {fmtDate(activeTerm.termEnd)} · {String(activeTerm.status || "").replace(/_/g, " ")}
                </div>
                {activeTerm.coverageServiceType && (
                  <div className="text-ui-caption text-ink-secondary mt-1">
                    Covers {activeTerm.coverageVisitCount || 4} {activeTerm.coverageServiceType} visit{Number(activeTerm.coverageVisitCount || 4) === 1 ? "" : "s"}
                  </div>
                )}
              </>
            ) : (
              <div className="text-ui-label text-ink-secondary">
                No annual prepay term on this account.
              </div>
            )}
          </div>
          <div className="flex flex-wrap gap-2 justify-end">
            <Button onClick={onSendInvoice} size="md">
              Send prepay invoice
            </Button>
            <Button onClick={onOpen} size="md" variant="secondary">
              Record collected payment
            </Button>
          </div>
        </div>
        <div className="text-ui-caption text-ink-secondary mt-2">
          Send an invoice to request payment, or record a payment already collected.
        </div>
      </CardBody>
    </Card>
  );
}

// Does the server's estimate-derived prefill apply to what the operator is
// recording? Three checks, all required, all fail-closed:
// 1. Label: EXACT identity of the CADENCE-NEUTRAL service — cadence words
//    and service/plan/program filler drop out, so an estimate line named
//    plain "Pest Control" matches the modal's "Quarterly Pest Control"
//    default — but "Commercial Pest Control" never matches "Pest Control".
//    Never substring-match a money prefill. Cadence safety does NOT ride the
//    label: it is enforced by checks 2-3 against the estimate's own
//    coverageCadence/coverageVisitCount, so a monthly quote still never
//    lands on a quarterly schedule.
// 2. Cadence: the modal's coverage cadence must equal the estimate's own.
// 3. Visit count: ditto — the quoted annual is only valid for the quoted
//    schedule.
function annualPrepaySuggestionLabelKey(value) {
  return normalizeAnnualPrepayLabelKey(value)
    .replace(/service|plan|program/g, "")
    .trim();
}

export function estimateSuggestionMatchesService(suggestion, serviceType, coverageCadence, visitCount) {
  if (!suggestion || suggestion.blocked || !(Number(suggestion.amount) > 0)) return false;
  if (!suggestion.coverageCadence
    || String(suggestion.coverageCadence) !== String(coverageCadence || "")) return false;
  if (Number.parseInt(visitCount, 10) !== Number(suggestion.coverageVisitCount)) return false;
  const suggestionKey = annualPrepaySuggestionLabelKey(suggestion.serviceLabel);
  const serviceKey = annualPrepaySuggestionLabelKey(serviceType);
  return !!suggestionKey && !!serviceKey && suggestionKey === serviceKey;
}

// Both prepay paths use the service library for label selection only; prices
// and coverage still come from their existing, independently guarded handlers.
function AnnualPrepayServiceFields({ serviceOptions, serviceType, onChange }) {
  const listId = useId();
  const [catalog, setCatalog] = useState([]);
  const [catalogError, setCatalogError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    adminFetch("/admin/services/dropdown")
      .then((rows) => { if (!cancelled) setCatalog(rows); })
      .catch(() => { if (!cancelled) setCatalogError(true); });
    return () => { cancelled = true; };
  }, []);

  const options = [...serviceOptions];
  for (const service of catalog) {
    if (service.name && !options.some((option) => option.value === service.name)) {
      options.push({ value: service.name, label: service.name });
    }
  }
  const serviceKey = annualPrepaySuggestionLabelKey(serviceType);
  const selected = options.find((option) => option.value === serviceType)
    || options.find((option) => serviceKey && annualPrepaySuggestionLabelKey(option.value) === serviceKey);

  return <>
    <label className="block sm:col-span-2">
      <div className="ui-label text-ink-secondary mb-1">Service plan</div>
      <Select
        value={selected?.value || "__custom__"}
        onChange={(e) => onChange(e.target.value === "__custom__" ? "" : e.target.value)}
        className="w-full h-9 px-2.5 text-14 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
      >
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        <option value="__custom__">Custom label</option>
      </Select>
    </label>
    <label className="block sm:col-span-2">
      <div className="ui-label text-ink-secondary mb-1">Service covered</div>
      <Input
        value={serviceType}
        onChange={(e) => onChange(e.target.value)}
        list={listId}
        aria-label="Service covered"
        aria-describedby={catalogError ? `${listId}-error` : undefined}
        autoComplete="off"
        placeholder="Search services or enter a custom label"
        className="w-full h-9 px-2.5 text-14 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
      />
      <datalist id={listId}>
        {options.map((option) => <option key={option.value} value={option.value} />)}
      </datalist>
      {catalogError && <div id={`${listId}-error`} className="text-14 text-ink-secondary mt-1">Service library unavailable. You can still enter a service label.</div>}
    </label>
  </>;
}

export function AnnualPrepayModal({ customer, activeTerm, prepaidPlans = [], annualPrepayTerms = [], estimateSuggestion = null, onClose, onSaved }) {
  const density = useUiDensity();
  const initialStart = defaultAnnualPrepayStart(activeTerm);
  const serviceOptions = deriveAnnualPrepayServiceOptions(customer, activeTerm, prepaidPlans, annualPrepayTerms);
  // For a brand-new customer (no options, no term, no prepaid plans) the
  // eligible estimate is the ONLY signal of what plan is being recorded —
  // without this, service/cadence fall to the Quarterly Pest Control
  // defaults and a valid lawn/tree-shrub suggestion could never prefill.
  const inferredServiceBase = inferAnnualPrepayServiceBase(customer, activeTerm, prepaidPlans);
  // inferAnnualPrepayServiceBase never returns "" — its terminal fallback is
  // the literal "Pest Control", which is a GUESS, not a signal, when the
  // customer carries no serviceTypes either. Only then may the estimate
  // seed the defaults.
  const inferredBaseIsGuess = inferredServiceBase === "Pest Control"
    && !String(customer?.serviceTypes || "").trim();
  // deriveAnnualPrepayServiceOptions also pads an empty list with a
  // "Pest Control" fallback option — that lone guess is not a signal either.
  const optionsAreFallbackOnly = serviceOptions.length === 1 && serviceOptions[0]?.source === "fallback";
  const seedFromSuggestion = estimateSuggestion
    && !estimateSuggestion.blocked
    && Number(estimateSuggestion.amount) > 0
    && (serviceOptions.length === 0 || optionsAreFallbackOnly)
    && !activeTerm
    && (prepaidPlans || []).length === 0
    && inferredBaseIsGuess;
  const defaultServiceBase = (!optionsAreFallbackOnly && serviceOptions[0]?.value)
    || (seedFromSuggestion ? estimateSuggestion.serviceLabel : inferredServiceBase);
  const defaultCoverageCadence = seedFromSuggestion && estimateSuggestion.coverageCadence
    ? estimateSuggestion.coverageCadence
    : inferAnnualPrepayInitialCadence(activeTerm, prepaidPlans);
  const defaultServiceType = formatAnnualPrepayServiceLabel(defaultServiceBase, defaultCoverageCadence) || "Quarterly Pest Control";
  const defaultVisitCount = seedFromSuggestion && Number(estimateSuggestion.coverageVisitCount) > 0
    ? String(estimateSuggestion.coverageVisitCount)
    : (ANNUAL_PREPAY_CADENCE_VISITS[defaultCoverageCadence] || "4");
  const suggestedAmount = inferAnnualPrepaySuggestedAmount(
    { ...customer, prepaidPlans, annualPrepayTerms },
    defaultServiceType,
    defaultCoverageCadence,
    activeTerm,
    prepaidPlans,
  );
  // Estimate-derived prefill is the LAST fallback: recorded terms, prepaid
  // plans, and the profile rate all speak to money actually agreed with this
  // customer and win over a quote.
  const estimateFallbackAmount = !suggestedAmount
    && estimateSuggestionMatchesService(estimateSuggestion, defaultServiceType, defaultCoverageCadence, defaultVisitCount)
    ? Number(estimateSuggestion.amount)
    : 0;
  const [amount, setAmount] = useState(
    suggestedAmount
      ? suggestedAmount.toFixed(2)
      : estimateFallbackAmount > 0
        ? estimateFallbackAmount.toFixed(2)
        : "",
  );
  const [serviceType, setServiceType] = useState(defaultServiceType);
  const [coverageCadence, setCoverageCadence] = useState(defaultCoverageCadence);
  const [visitCount, setVisitCount] = useState(defaultVisitCount);
  const [method, setMethod] = useState("card_present");
  const [termStart, setTermStart] = useState(initialStart);
  const [termEnd, setTermEnd] = useState(addMonthsInput(initialStart, 12));
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const cadenceTouchedRef = useRef(false);
  const visitCountTouchedRef = useRef(false);
  // True while the (untouched) amount value came from the estimate prefill —
  // a service change away from the estimate's service must CLEAR it, never
  // let the old service's quoted year get recorded against the new one.
  const amountFromEstimateRef = useRef(estimateFallbackAmount > 0);

  const customerName = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() || "Customer";
  const count = Number.parseInt(visitCount, 10);
  const total = Number(amount);
  const perVisit = Number.isFinite(total) && Number.isInteger(count) && count > 0
    ? total / count
    : 0;
  const activeTermEnd = dateInputValue(activeTerm?.termEnd);
  const submitDisabled = saving
    || !(Number(amount) > 0)
    || !serviceType.trim()
    || !(Number.parseInt(visitCount, 10) > 0)
    || !termStart
    || !termEnd
    || termEnd <= termStart;

  const handleStartChange = (value) => {
    setTermStart(value);
    if (value) setTermEnd(addMonthsInput(value, 12));
  };

  const updateSuggestedAmount = (nextServiceType, nextCoverageCadence, nextVisitCount) => {
    if (amountTouched) return;
    const nextSuggested = inferAnnualPrepaySuggestedAmount(
      { ...customer, prepaidPlans, annualPrepayTerms },
      nextServiceType,
      nextCoverageCadence,
      activeTerm,
      prepaidPlans,
    );
    if (nextSuggested > 0) {
      amountFromEstimateRef.current = false;
      setAmount(nextSuggested.toFixed(2));
    } else if (estimateSuggestionMatchesService(estimateSuggestion, nextServiceType, nextCoverageCadence, nextVisitCount)) {
      amountFromEstimateRef.current = true;
      setAmount(Number(estimateSuggestion.amount).toFixed(2));
    } else if (amountFromEstimateRef.current) {
      // The standing amount was the estimate's quoted year for a DIFFERENT
      // service or schedule — clear rather than silently record it here.
      amountFromEstimateRef.current = false;
      setAmount("");
    }
  };

  const handleServiceTypeChange = (value) => {
    setServiceType(value);
    const inferredCadence = inferAnnualPrepayCadenceFromLabel(value);
    // A label-inferred cadence only takes effect when the operator hasn't
    // chosen one manually — and the prefill must evaluate against the cadence
    // that will actually be SUBMITTED, never the ignored inference (a
    // quarterly quote must not restore onto a manually-selected monthly
    // schedule just because the label says "Quarterly").
    const cadenceApplies = !!inferredCadence && !cadenceTouchedRef.current;
    let nextVisitCount = visitCount;
    if (cadenceApplies) {
      setCoverageCadence(inferredCadence);
      const inferredVisitCount = ANNUAL_PREPAY_CADENCE_VISITS[inferredCadence];
      if (inferredVisitCount && !visitCountTouchedRef.current) {
        setVisitCount(inferredVisitCount);
        nextVisitCount = inferredVisitCount;
      }
    }
    updateSuggestedAmount(value, cadenceApplies ? inferredCadence : coverageCadence, nextVisitCount);
  };

  const handleCadenceChange = (value) => {
    cadenceTouchedRef.current = true;
    setCoverageCadence(value);
    const nextVisitCount = ANNUAL_PREPAY_CADENCE_VISITS[value];
    const effectiveVisitCount = nextVisitCount && !visitCountTouchedRef.current ? nextVisitCount : visitCount;
    if (nextVisitCount && !visitCountTouchedRef.current) setVisitCount(nextVisitCount);
    updateSuggestedAmount(serviceType, value, effectiveVisitCount);
  };

  const handleVisitCountChange = (value) => {
    visitCountTouchedRef.current = true;
    setVisitCount(value);
    // An estimate-derived amount is only valid for the estimate's own visit
    // count — re-evaluate so a mismatched count clears the prefill.
    updateSuggestedAmount(serviceType, coverageCadence, value);
  };

  const handleAmountChange = (value) => {
    amountFromEstimateRef.current = false;
    setAmountTouched(true);
    setAmount(value);
  };

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSaving(true);
    setError("");
    try {
      const recordedPayload = {
        amount: Number(amount),
        serviceType: serviceType.trim(),
        visitCount: Number.parseInt(visitCount, 10),
        coverageCadence,
        method,
        termStart,
        termEnd,
        reference: reference.trim() || undefined,
        note: note.trim() || undefined,
      };
      let result;
      try {
        result = await adminFetch(`/admin/customers/${customer.id}/annual-prepay`, {
          method: "POST",
          body: JSON.stringify(recordedPayload),
        });
      } catch (err) {
        // The route refuses (409, setupFeeRequired) when the coverage
        // series owes the bait-station setup — confirm the collected total
        // includes it and re-submit carrying the server-derived figure
        // (codex #3591 r50 P1).
        const refusal = err?.body;
        if (err?.status === 409 && refusal?.setupFeeRequired && Number(refusal.setupFeeAmount) > 0) {
          const setupFee = Number(refusal.setupFeeAmount);
          // A prefilled amount is COVERAGE-ONLY (the estimate suggestion
          // uses resolveAnnualPrepayInvoiceTotal; the renewal default
          // subtracts the prior setup claim), while the route reads
          // `amount` as setup-INCLUSIVE (coverage = amount − setup). Add
          // the setup for prefills so coverage is not silently shorted by
          // $99 (codex #3591 r77 P1); a staff-typed amount is confirmed as
          // the collected inclusive total instead.
          const coverageOnlyPrefill = !amountTouched || amountFromEstimateRef.current;
          const submittedTotal = coverageOnlyPrefill
            ? Math.round((Number(amount) + setupFee) * 100) / 100
            : Number(amount);
          // Commercial invoices add county tax on top of the entered
          // pre-tax amount and the taxed total is what the ledger records
          // as paid (codex #3591 r78 P2) — say so, or staff confirm a
          // figure ~7% below the recorded payment.
          const taxNote = isCommercialCustomer
            ? ` County sales tax is added on top — approximately $${(Math.round(submittedTotal * 1.07 * 100) / 100).toFixed(2)} will be recorded as paid (the invoice finalizes the exact county rate).`
            : "";
          const ok = window.confirm(coverageOnlyPrefill
            ? `${refusal.error}\n\nRecord $${Number(amount).toFixed(2)} coverage + $${setupFee.toFixed(2)} Bait Station Setup — pre-tax total $${submittedTotal.toFixed(2)}?${taxNote}`
            : `${refusal.error}\n\nRecord the $${setupFee.toFixed(2)} Bait Station Setup as its own line on this prepay? Confirm the $${Number(amount).toFixed(2)} you entered is the pre-tax collected total INCLUDING the setup.${taxNote}`);
          if (!ok) throw new Error("Annual prepay not recorded — the bait-station setup must ride the invoice.");
          result = await adminFetch(`/admin/customers/${customer.id}/annual-prepay`, {
            method: "POST",
            body: JSON.stringify({
              ...recordedPayload,
              amount: submittedTotal,
              setupFeeAmount: setupFee,
              ...(refusal.scheduledServiceId ? { scheduledServiceId: String(refusal.scheduledServiceId) } : {}),
            }),
          });
        } else {
          throw err;
        }
      }
      await onSaved?.(result);
    } catch (err) {
      setError(err.message || "Annual prepay failed");
      setSaving(false);
    }
  };

  const methodOptions = [
    ["card_present", "In-person card"],
    ["cash", "Cash"],
    ["check", "Check"],
    ["zelle", "Zelle"],
    ["venmo", "Venmo"],
    ["paypal", "PayPal"],
    ["other", "Other"],
  ];

  // Commercial invoices add county sales tax on top of the entered amount
  // (residential is tax-free by operator policy), and the server records the
  // taxed invoice total as the paid amount. So this field is the PRE-TAX service
  // amount; surface the estimated tax-inclusive total actually recorded as paid
  // (7% is the commercial default used elsewhere; the invoice finalizes the
  // exact county rate).
  const isCommercialCustomer =
    customer?.property?.type === "commercial" || customer?.property?.type === "business";
  const estTaxInclusiveTotal = isCommercialCustomer && Number(amount) > 0
    ? Math.round(Number(amount) * 1.07 * 100) / 100
    : Number(amount);

  // Owns Escape and the focus trap while open (the profile's window-level
  // Escape defers to any open sub-modal); backdrop clicks stop here so they
  // never bubble through the React tree to the profile overlay's onClose.
  const dialogRef = useModalFocus(true, () => !saving && onClose?.());
  return createPortal(
    <div data-ui-density={density}
      className="admin-shell-v2 fixed inset-0 bg-black/70 z-[1120] flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
      onClick={(e) => {
        e.stopPropagation();
        if (!saving) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Record collected annual prepay"
        className="bg-white w-full min-h-full sm:min-h-0 max-w-none sm:max-w-[540px] rounded-none sm:rounded-sm border-hairline border-zinc-300 my-0 sm:my-4 box-border pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline border-zinc-200">
          <div>
            <div className="text-15 font-medium text-zinc-900">Record collected annual prepay</div>
            <div className="text-ui-caption text-ink-secondary mt-0.5">{customerName}</div>
          </div>
          <button data-ui-text-action
            onClick={() => !saving && onClose?.()}
            aria-label="Close"
            className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring"
          >
            ×
          </button>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {activeTermEnd && (
            <div className="sm:col-span-2 text-ui-label text-ink-secondary bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5">
              Current term ends {fmtDate(activeTermEnd)}
            </div>
          )}
          <AnnualPrepayServiceFields
            serviceOptions={serviceOptions}
            serviceType={serviceType}
            onChange={handleServiceTypeChange}
          />
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">Cadence</div>
            <Select
              value={coverageCadence}
              onChange={(e) => handleCadenceChange(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            >
              {ANNUAL_PREPAY_CADENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">Applications covered</div>
            <Input
              type="number"
              min="1"
              max="24"
              step="1"
              value={visitCount}
              onChange={(e) => handleVisitCountChange(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">
              {isCommercialCustomer ? "Pre-tax service amount collected" : "Amount collected"}
            </div>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
            {perVisit > 0 && (
              <div className="text-ui-caption text-ink-secondary mt-1">
                {fmtCurrency(perVisit)} per application
              </div>
            )}
            {estimateSuggestionMatchesService(estimateSuggestion, serviceType, coverageCadence, visitCount) && (
              <div className="text-ui-caption text-ink-secondary mt-1">
                From estimate #{estimateSuggestion.shortRef} — quoted prepay
                year {fmtCurrency(Number(estimateSuggestion.amount))}
                {Number(estimateSuggestion.discount) > 0
                  ? ` (includes ${fmtCurrency(Number(estimateSuggestion.discount))} prepay discount)`
                  : ""}
              </div>
            )}
            {estimateSuggestion?.blocked && (
              <div className="text-ui-caption text-ink-secondary mt-1">
                Estimate #{estimateSuggestion.shortRef}: {estimateSuggestion.blockReason} —
                enter the amount collected.
              </div>
            )}
            {isCommercialCustomer && Number(amount) > 0 && (
              <div className="text-ui-caption text-ink-secondary mt-1">
                Commercial: ~7% county sales tax is added at invoicing — total
                recorded as paid ≈ {fmtCurrency(estTaxInclusiveTotal)}.
              </div>
            )}
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">Payment already collected by</div>
            <Select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="w-full h-9 px-2 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            >
              {methodOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </Select>
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">Term starts</div>
            <Input
              type="date"
              value={termStart}
              onChange={(e) => handleStartChange(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">Term ends</div>
            <Input
              type="date"
              value={termEnd}
              onChange={(e) => setTermEnd(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block sm:col-span-2">
            <div className="ui-label text-ink-secondary mb-1">Reference</div>
            <Input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Receipt, check, Zelle, or Stripe reference"
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block sm:col-span-2">
            <div className="ui-label text-ink-secondary mb-1">Note</div>
            <Textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-2.5 py-2 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
        </div>
        {error && (
          <div className="mx-4 mb-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-hairline border-zinc-200">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {saving ? "Recording..." : "Create paid annual term"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Exported so the completion screen can reuse the exact same annual-prepay
// invoice flow (correct commercial-tax preview, full cadence set, term dates,
// amount inference) instead of maintaining a parallel modal. See
// schedule/AnnualPrepayLauncher.
export function AnnualPrepayInvoiceModal({ customer, activeTerm, prepaidPlans = [], annualPrepayTerms = [], onClose, onSaved, allowChargeInPerson = false, onChargeInPerson }) {
  const density = useUiDensity();
  const initialStart = defaultAnnualPrepayStart(activeTerm);
  const serviceOptions = deriveAnnualPrepayServiceOptions(customer, activeTerm, prepaidPlans, annualPrepayTerms);
  const defaultServiceBase = serviceOptions[0]?.value || inferAnnualPrepayServiceBase(customer, activeTerm, prepaidPlans);
  const defaultCoverageCadence = inferAnnualPrepayInitialCadence(activeTerm, prepaidPlans);
  const defaultServiceType = formatAnnualPrepayServiceLabel(defaultServiceBase, defaultCoverageCadence) || "Quarterly Pest Control";
  const defaultVisitCount = ANNUAL_PREPAY_CADENCE_VISITS[defaultCoverageCadence] || "4";
  const suggestedAmount = inferAnnualPrepaySuggestedAmount(
    { ...customer, prepaidPlans, annualPrepayTerms },
    defaultServiceType,
    defaultCoverageCadence,
    activeTerm,
    prepaidPlans,
  );
  const [amount, setAmount] = useState(suggestedAmount ? suggestedAmount.toFixed(2) : "");
  const [serviceType, setServiceType] = useState(defaultServiceType);
  const [coverageCadence, setCoverageCadence] = useState(defaultCoverageCadence);
  const [visitCount, setVisitCount] = useState(defaultVisitCount);
  const [termStart, setTermStart] = useState(initialStart);
  const [termEnd, setTermEnd] = useState(addMonthsInput(initialStart, 12));
  const [dueDate, setDueDate] = useState(todayDateInput());
  const [note, setNote] = useState("");
  // First visit already promised to the customer (e.g. booked on the phone).
  // Optional: left blank, coverage generates from the term start as before.
  // Filled in, it anchors the generated visits and gives visit 1 a real
  // arrival time instead of landing windowless — and, because visits are only
  // generated when the invoice is PAID, it survives a mint-to-payment lag.
  const [firstVisitDate, setFirstVisitDate] = useState("");
  const [firstVisitWindowStart, setFirstVisitWindowStart] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const cadenceTouchedRef = useRef(false);
  const visitCountTouchedRef = useRef(false);
  // Open estimate-deposit credit on file (e.g. restored by voiding a prior
  // prepay invoice). The server auto-applies it to the minted invoice, so the
  // operator enters the FULL plan amount and the invoice bills the
  // difference. Preview-only read — the authoritative ledger read re-runs
  // inside the mint transaction.
  const [depositCredit, setDepositCredit] = useState(null);
  const [applyCredit, setApplyCredit] = useState(true);
  useEffect(() => {
    if (!customer?.id) return undefined;
    let cancelled = false;
    adminFetch(`/admin/customers/${customer.id}/deposit-credit`)
      .then((r) => { if (!cancelled) setDepositCredit(r?.credit || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [customer?.id]);

  const customerName = [customer?.firstName, customer?.lastName].filter(Boolean).join(" ").trim() || "Customer";
  const count = Number.parseInt(visitCount, 10);
  const total = Number(amount);
  const perVisit = Number.isFinite(total) && Number.isInteger(count) && count > 0
    ? total / count
    : 0;
  const activeTermEnd = dateInputValue(activeTerm?.termEnd);
  // Mirrors the server's window check — the endpoint 400s on an out-of-window
  // first visit, so catch it before the operator submits.
  const firstVisitDateError = firstVisitDate && termStart && termEnd
    && (firstVisitDate < termStart || firstVisitDate > termEnd)
    ? `First visit must fall between ${termStart} and ${termEnd}`
    : "";
  // Appointment windows start on the hour — the server rejects :15/:30, so
  // catch it here instead of round-tripping a 400.
  const firstVisitTimeError = firstVisitWindowStart && !/^\d{1,2}:00$/.test(firstVisitWindowStart)
    ? "Arrival times start on the hour"
    : "";
  const submitDisabled = saving
    || !(Number(amount) > 0)
    || !serviceType.trim()
    || !(Number.parseInt(visitCount, 10) > 0)
    || !termStart
    || !termEnd
    || termEnd <= termStart
    || !dueDate
    || !!firstVisitDateError
    || !!firstVisitTimeError
    || (!!firstVisitWindowStart && !firstVisitDate);
  // Commercial invoices add county tax to this pre-tax line item (residential is
  // tax-free), so label the field as pre-tax and preview the tax-inclusive total
  // the customer will actually be billed — mirrors the record-collected modal.
  const isCommercialCustomer =
    customer?.property?.type === "commercial" || customer?.property?.type === "business";
  const estTaxInclusiveTotal = isCommercialCustomer && Number(amount) > 0
    ? Math.round(Number(amount) * 1.07 * 100) / 100
    : Number(amount);

  const handleStartChange = (value) => {
    setTermStart(value);
    if (value) setTermEnd(addMonthsInput(value, 12));
  };

  const updateSuggestedAmount = (nextServiceType, nextCoverageCadence) => {
    if (amountTouched) return;
    const nextSuggested = inferAnnualPrepaySuggestedAmount(
      { ...customer, prepaidPlans, annualPrepayTerms },
      nextServiceType,
      nextCoverageCadence,
      activeTerm,
      prepaidPlans,
    );
    if (nextSuggested > 0) setAmount(nextSuggested.toFixed(2));
  };

  const handleServiceTypeChange = (value) => {
    setServiceType(value);
    const inferredCadence = inferAnnualPrepayCadenceFromLabel(value);
    if (inferredCadence && !cadenceTouchedRef.current) {
      setCoverageCadence(inferredCadence);
      const inferredVisitCount = ANNUAL_PREPAY_CADENCE_VISITS[inferredCadence];
      if (inferredVisitCount && !visitCountTouchedRef.current) {
        setVisitCount(inferredVisitCount);
      }
    }
    updateSuggestedAmount(value, inferredCadence || coverageCadence);
  };

  const handleCadenceChange = (value) => {
    cadenceTouchedRef.current = true;
    setCoverageCadence(value);
    const nextVisitCount = ANNUAL_PREPAY_CADENCE_VISITS[value];
    if (nextVisitCount && !visitCountTouchedRef.current) setVisitCount(nextVisitCount);
    updateSuggestedAmount(serviceType, value);
  };

  const handleVisitCountChange = (value) => {
    visitCountTouchedRef.current = true;
    setVisitCount(value);
  };

  const handleAmountChange = (value) => {
    setAmountTouched(true);
    setAmount(value);
  };

  // The mint refuses (409, setupFeeRequired) when the coverage series is a
  // direct non-member rodent plan that still owes its bait-station setup —
  // omission is not a waiver (codex #3591 r37 P1). Confirm the extra line
  // with staff and re-submit carrying the server-derived figure + anchor.
  const mintAnnualPrepay = async (payload) => {
    try {
      return await adminFetch(`/admin/customers/${customer.id}/annual-prepay-invoice`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
    } catch (err) {
      const refusal = err?.body;
      // scheduledServiceId is null for a NEW rodent prepay with no series
      // yet — the mint derives the setup from the coverage family then.
      if (err?.status === 409 && refusal?.setupFeeRequired && Number(refusal.setupFeeAmount) > 0) {
        const ok = window.confirm(
          `${refusal.error}\n\nAdd the $${Number(refusal.setupFeeAmount).toFixed(2)} Bait Station Setup line to this invoice?`,
        );
        if (!ok) throw new Error("Annual prepay not created — the bait-station setup must ride the invoice.");
        return adminFetch(`/admin/customers/${customer.id}/annual-prepay-invoice`, {
          method: "POST",
          body: JSON.stringify({
            ...payload,
            setupFeeAmount: Number(refusal.setupFeeAmount),
            ...(refusal.scheduledServiceId ? { scheduledServiceId: String(refusal.scheduledServiceId) } : {}),
          }),
        });
      }
      throw err;
    }
  };

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSaving(true);
    setError("");
    try {
      const result = await mintAnnualPrepay({
          amount: Number(amount),
          serviceType: serviceType.trim(),
          visitCount: Number.parseInt(visitCount, 10),
          coverageCadence,
          termStart,
          termEnd,
          dueDate,
          ...(firstVisitDate ? { firstVisitDate } : {}),
          ...(firstVisitDate && firstVisitWindowStart ? { firstVisitWindowStart } : {}),
          note: note.trim() || undefined,
          // Only apply when the banner actually RENDERED (preview loaded, not
          // payer-billed): a slow/failed preview must not silently subtract a
          // credit the operator never saw — they may have hand-netted it. The
          // estimate id echoes back so the server consumes exactly the ledger
          // the banner named — the server 409s on a mismatch.
          applyDepositCredit: !!(depositCredit && !depositCredit.payerBilled && applyCredit),
          ...(depositCredit && !depositCredit.payerBilled && applyCredit
            ? { depositCreditEstimateId: depositCredit.estimateId, depositCreditAmount: depositCredit.amount }
            : {}),
      });
      // Advisory warnings (the promised first visit overlaps another job) —
      // blocking on purpose, and BEFORE the delivery check: the invoice and
      // term are already minted either way, and onSaved closes this modal.
      if (Array.isArray(result?.warnings) && result.warnings.length) window.alert(result.warnings.join("\n\n"));
      if (result?.delivery && result.delivery.ok === false) {
        const reason = result.delivery.error || result.delivery.sms?.error || result.delivery.email?.error || "delivery failed";
        setError(`Invoice created, but delivery failed: ${reason}. Open Invoices to resend.`);
        setSaving(false);
        return;
      }
      await onSaved?.(result);
    } catch (err) {
      setError(err.message || "Annual prepay invoice failed");
      setSaving(false);
    }
  };

  // Charge in person (Tap to Pay): mint the prepay invoice WITHOUT sending or
  // creating the term (chargeInPerson), then hand it to the caller's payment sheet.
  // The term is created + activated by the payment webhook, so an aborted charge
  // leaves no orphan term. Only offered when the caller opts in (completion screen).
  const handleChargeInPerson = async () => {
    if (submitDisabled) return;
    setSaving(true);
    setError("");
    try {
      const result = await mintAnnualPrepay({
          amount: Number(amount),
          serviceType: serviceType.trim(),
          visitCount: Number.parseInt(visitCount, 10),
          coverageCadence,
          termStart,
          termEnd,
          dueDate,
          ...(firstVisitDate ? { firstVisitDate } : {}),
          ...(firstVisitDate && firstVisitWindowStart ? { firstVisitWindowStart } : {}),
          note: note.trim() || undefined,
          // Same visible-banner gate + estimate echo as the send path — never
          // apply a credit the operator didn't see.
          applyDepositCredit: !!(depositCredit && !depositCredit.payerBilled && applyCredit),
          ...(depositCredit && !depositCredit.payerBilled && applyCredit
            ? { depositCreditEstimateId: depositCredit.estimateId, depositCreditAmount: depositCredit.amount }
            : {}),
          chargeInPerson: true,
      });
      // Same advisory-overlap surfacing as the send path (blocking: the
      // modal closes / hands off to the payment sheet right after).
      if (Array.isArray(result?.warnings) && result.warnings.length) window.alert(result.warnings.join("\n\n"));
      // Credit covered the whole invoice — it's already settled server-side,
      // so there's nothing for the payment sheet to collect.
      if (result?.settledByDepositCredit) {
        await onSaved?.(result);
        return;
      }
      onChargeInPerson?.(result.invoice);
    } catch (err) {
      setError(err.message || "Couldn't start the charge");
      setSaving(false);
    }
  };

  // Owns Escape and the focus trap while open (the profile's window-level
  // Escape defers to any open sub-modal); backdrop clicks stop here so they
  // never bubble through the React tree to the profile overlay's onClose.
  const dialogRef = useModalFocus(true, () => !saving && onClose?.());
  return createPortal(
    <div data-ui-density={density}
      className="admin-shell-v2 fixed inset-0 bg-black/70 z-[1120] flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
      onClick={(e) => {
        e.stopPropagation();
        if (!saving) onClose?.();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Send annual prepay invoice"
        className="bg-white w-full min-h-full sm:min-h-0 max-w-none sm:max-w-[540px] rounded-none sm:rounded-sm border-hairline border-zinc-300 my-0 sm:my-4 box-border pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline border-zinc-200">
          <div>
            <div className="text-15 font-medium text-zinc-900">Send annual prepay invoice</div>
            <div className="text-ui-caption text-ink-secondary mt-0.5">{customerName}</div>
          </div>
          <button data-ui-text-action
            onClick={() => !saving && onClose?.()}
            aria-label="Close"
            className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring"
          >
            ×
          </button>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {activeTermEnd && (
            <div className="sm:col-span-2 text-ui-label text-ink-secondary bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5">
              Current term ends {fmtDate(activeTermEnd)}
            </div>
          )}
          {depositCredit && depositCredit.payerBilled && (
            <div className="sm:col-span-2 text-ui-label text-zinc-900 bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5">
              ${Number(depositCredit.amount).toFixed(2)} deposit credit on file
              {depositCredit.estimateSlug ? ` (estimate ${depositCredit.estimateSlug})` : ""} — NOT
              applied here: this customer's invoices bill to a third party, and the homeowner's
              deposit never credits a payer's bill. The credit stays on the ledger.
            </div>
          )}
          {depositCredit && !depositCredit.payerBilled && (
            <div className="sm:col-span-2 text-ui-label text-zinc-900 bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5">
              <label className="flex items-start gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={applyCredit}
                  onChange={(e) => setApplyCredit(e.target.checked)}
                  className="mt-0.5 u-focus-ring"
                />
                <span>
                  Apply ${Number(depositCredit.amount).toFixed(2)} deposit credit on file
                  {depositCredit.estimateSlug ? ` from estimate ${depositCredit.estimateSlug}` : ""}.
                  Enter the full plan amount — the credit comes off the invoice automatically
                  {applyCredit && Number(amount) > 0
                    ? ` (customer pays $${Math.max(0, estTaxInclusiveTotal - Number(depositCredit.amount)).toFixed(2)})`
                    : ""}.
                </span>
              </label>
            </div>
          )}
          <AnnualPrepayServiceFields
            serviceOptions={serviceOptions}
            serviceType={serviceType}
            onChange={handleServiceTypeChange}
          />
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">Cadence</div>
            <Select
              value={coverageCadence}
              onChange={(e) => handleCadenceChange(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            >
              {ANNUAL_PREPAY_CADENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </Select>
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">Applications covered</div>
            <Input
              type="number"
              min="1"
              max="24"
              step="1"
              value={visitCount}
              onChange={(e) => handleVisitCountChange(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">
              {isCommercialCustomer ? "Pre-tax service amount" : "Invoice amount"}
            </div>
            <Input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
            {perVisit > 0 && (
              <div className="text-ui-caption text-ink-secondary mt-1">
                {fmtCurrency(perVisit)} per application
              </div>
            )}
            {isCommercialCustomer && Number(amount) > 0 && (
              <div className="text-ui-caption text-ink-secondary mt-1">
                Commercial: ~7% county sales tax is added — customer is invoiced
                ≈ {fmtCurrency(estTaxInclusiveTotal)}.
              </div>
            )}
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">Term starts</div>
            <Input
              type="date"
              value={termStart}
              onChange={(e) => handleStartChange(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">Term ends</div>
            <Input
              type="date"
              value={termEnd}
              onChange={(e) => setTermEnd(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">Invoice due</div>
            <Input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">First visit (optional)</div>
            <Input
              type="date"
              value={firstVisitDate}
              onChange={(e) => {
                const next = e.target.value;
                setFirstVisitDate(next);
                // The time input disables without a date; a retained time would
                // keep submitDisabled true with no way to clear it.
                if (!next) setFirstVisitWindowStart("");
              }}
              min={termStart || undefined}
              max={termEnd || undefined}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
            <div className="text-ui-caption text-ink-secondary mt-1">
              {firstVisitDateError || "Date you already promised the customer. Blank starts coverage at the term start."}
            </div>
          </label>
          <label className="block">
            <div className="ui-label text-ink-secondary mb-1">First visit time</div>
            <Input
              type="time"
              step={3600}
              value={firstVisitWindowStart}
              onChange={(e) => setFirstVisitWindowStart(e.target.value)}
              disabled={!firstVisitDate}
              className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring disabled:bg-zinc-100 disabled:text-zinc-400"
            />
            <div className="text-ui-caption text-ink-secondary mt-1">
              {firstVisitTimeError || "Arrival time for visit 1, on the hour. Needs a first-visit date."}
            </div>
          </label>
          <label className="block sm:col-span-2">
            <div className="ui-label text-ink-secondary mb-1">Invoice note</div>
            <Textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-2.5 py-2 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
        </div>
        {error && (
          <div className="mx-4 mb-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-hairline border-zinc-200">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          {allowChargeInPerson && (
            <Button variant="secondary" onClick={handleChargeInPerson} disabled={submitDisabled}>
              {saving ? "Working…" : "Charge in person"}
            </Button>
          )}
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {saving ? "Sending..." : "Create & send invoice"}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================================
// CANCEL SIGNUP & REFUND DEPOSIT
// Deposit-stage offboarding: previews exactly what the server will do (void
// the unpaid signup invoice, cancel remaining visits, clear the tier, refund
// the deposit at face value, email the customer), or explains why the run is
// blocked. The server re-checks eligibility on confirm.
// ============================================================================
export function CancelSignupModal({ customer, onClose, onDone }) {
  const density = useUiDensity();
  const [preview, setPreview] = useState(null);
  const [loadErr, setLoadErr] = useState("");
  const [running, setRunning] = useState(false);
  const [runErr, setRunErr] = useState("");
  const [result, setResult] = useState(null);

  useEffect(() => {
    let cancelled = false;
    adminFetch(`/admin/customers/${customer.id}/cancel-signup`)
      .then((r) => { if (!cancelled) setPreview(r); })
      .catch((e) => { if (!cancelled) setLoadErr(e.message || "Preview failed"); });
    return () => { cancelled = true; };
  }, [customer.id]);

  const confirm = async () => {
    setRunning(true);
    setRunErr("");
    try {
      const r = await adminFetch(`/admin/customers/${customer.id}/cancel-signup`, {
        method: "POST",
        body: JSON.stringify({ reason: "requested_by_customer" }),
      });
      setResult(r);
      try {
        await onDone?.();
      } catch (refreshError) {
        setRunErr(
          `Cancellation succeeded, but the customer profile could not refresh: ${refreshError.message || "Refresh failed"}`,
        );
      }
    } catch (e) {
      setRunErr(e.message || "Cancellation failed");
    }
    setRunning(false);
  };

  // Owns Escape and the focus trap while open (the profile's window-level
  // Escape defers to any open sub-modal); backdrop clicks stop here so they
  // never bubble through the React tree to the profile overlay's onClose.
  const dialogRef = useModalFocus(true, () => !running && onClose?.());
  return createPortal(
    <div data-ui-density={density}
      className="admin-shell-v2 fixed inset-0 bg-black/70 z-[1100] flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
      onClick={(e) => {
        e.stopPropagation();
        if (!running) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Cancel signup and refund deposit"
        className="bg-white w-full min-h-full sm:min-h-0 max-w-none sm:max-w-[560px] rounded-none sm:rounded-sm border-hairline border-zinc-300 my-0 sm:my-4 box-border pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline border-zinc-200">
          <div className="text-15 font-medium text-zinc-900">
            Cancel signup &amp; refund deposit
          </div>
          <button data-ui-text-action
            onClick={() => !running && onClose()}
            aria-label="Close"
            className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring"
          >
            ×
          </button>
        </div>
        <div className="p-4 text-ui-body text-zinc-900">
          {!preview && !loadErr && (
            <div className="text-ink-secondary">Checking eligibility…</div>
          )}
          {loadErr && (
            <div className="px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">{loadErr}</div>
          )}
          {preview && !preview.eligible && !result && (
            <div>
              <div className="mb-2">This customer can’t be cancelled through this flow:</div>
              <ul className="list-disc pl-5 text-ink-secondary">
                {preview.blockers.map((b, i) => (<li key={i}>{b}</li>))}
              </ul>
            </div>
          )}
          {preview && preview.eligible && !result && (
            <div>
              {/* First-run lesson (2026-07-15): the preview reads "done"
                  enough that the owner closed it here thinking the run had
                  fired. State the not-yet-ness explicitly. */}
              <div className="mb-3 px-2.5 py-1.5 bg-zinc-50 border-hairline border-zinc-200 rounded-xs text-ui-body text-zinc-900">
                <span className="font-medium">Preview only — nothing has happened yet.</span>{" "}
                <span className="text-ink-secondary">
                  No refund is issued and nothing is cancelled until you press the red button below.
                </span>
              </div>
              <div className="mb-3">Pressing it will, in order:</div>
              <ul className="list-disc pl-5 mb-3">
                {preview.invoices.length > 0 && (
                  <li>
                    Void {preview.invoices.map((inv) => `${inv.invoiceNumber || "invoice"} (${fmtCurrency(inv.total)})`).join(", ")}
                    {preview.terms.length > 0 ? " — cancelling the annual prepay term" : ""}
                  </li>
                )}
                <li>
                  Cancel {preview.visits.length} scheduled visit{preview.visits.length === 1 ? "" : "s"}
                  {preview.visits.length > 0 && (
                    <span className="text-ink-secondary">
                      {" "}({preview.visits.slice(0, 4).map((v) => fmtDate(v.serviceDate)).join(", ")}{preview.visits.length > 4 ? "…" : ""})
                    </span>
                  )}
                </li>
                <li>Set the plan to <span className="font-medium">No Plan</span> (record stays active)</li>
                <li>Refund the <span className="font-medium u-nums">{fmtCurrency(preview.refundTotal)}</span> deposit to the original payment method</li>
                <li>Email the customer a cancellation + refund confirmation</li>
              </ul>
              <div className="text-ui-label text-ink-secondary">
                The refund is issued through Stripe and typically lands in 5–10 business days.
              </div>
            </div>
          )}
          {result && (
            <div>
              <div className="mb-2 font-medium">
                {result.refundSkipped || result.refundIncomplete
                  ? "Partially done — check the notes below."
                  : "Done."}
              </div>
              <ul className="list-disc pl-5">
                <li>Invoices voided: {result.invoicesVoided.length ? result.invoicesVoided.join(", ") : "none"}</li>
                <li>Visits cancelled: {result.visitsCancelled}</li>
                <li>Refunded: <span className="u-nums">{fmtCurrency(result.refunded)}</span></li>
                <li>
                  Email: {result.email?.ok
                    ? "sent"
                    : `not sent (${result.email?.reason || result.email?.error || "see logs"})`}
                </li>
              </ul>
              {result.refundSkipped && (
                <div className="mt-2 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">
                  {result.refundSkipped}
                </div>
              )}
              {result.refundIncomplete && (
                <div className="mt-2 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">
                  {result.refundIncomplete}
                </div>
              )}
              {result.visitFailures?.length > 0 && (
                <div className="mt-2 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">
                  {result.visitFailures.length} visit(s) could not be cancelled — handle them on the Schedule page.
                </div>
              )}
              {result.unresolvedInvoices?.length > 0 && (
                <div className="mt-2 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">
                  Open visit invoice(s) could not be voided: {result.unresolvedInvoices.join(", ")} — resolve on the Invoices page.
                </div>
              )}
            </div>
          )}
          {runErr && (
            <div className="mt-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">{runErr}</div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-hairline border-zinc-200">
          <Button variant="secondary" onClick={onClose} disabled={running}>
            {result ? "Close" : "Close without cancelling"}
          </Button>
          {preview?.eligible && !result && (
            <Button variant="danger" onClick={confirm} disabled={running}>
              {running ? "Working…" : `Cancel & refund ${fmtCurrency(preview.refundTotal)} now`}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================================
// REFUND PAYMENT
// Full or partial refund of a Stripe payment row. The server accumulates
// partials (POST /admin/customers/:id/refund → StripeService.refund), so the
// modal caps the entry at the remaining balance, not the original amount.
// ============================================================================

// Refund state derived from a payments row. refund_status alone can't answer
// "fully refunded?": the app refund path stamps Stripe's own status
// ('succeeded'/'pending') and the charge.refunded webhook later normalizes it
// to 'partial'/'full' — so full is derived from status + amounts too.
function paymentRefundState(p) {
  const amountCents = Math.round(parseFloat(p.amount || 0) * 100);
  const refundedCents = Math.round(parseFloat(p.refund_amount || 0) * 100);
  const full =
    p.status === "refunded" ||
    p.refund_status === "full" ||
    (amountCents > 0 && refundedCents >= amountCents);
  const partial = !full && (refundedCents > 0 || !!p.refund_status);
  return {
    full,
    partial,
    refundedCents,
    remainingCents: Math.max(0, amountCents - refundedCents),
  };
}

export function RefundPaymentModal({ customer, payment, onClose, onDone }) {
  const density = useUiDensity();
  const { refundedCents, remainingCents } = paymentRefundState(payment);
  // The entered amount is BASE dollars: the server adds the prorated share
  // of the recorded card surcharge on top and caps the gross at the
  // remaining balance. The entry must therefore be capped at the remaining
  // BASE balance — an entry between remaining-base and remaining-gross
  // would silently issue more than the button says (e.g. entering $102 on
  // a $100 + $2.90-surcharge charge fully refunds $102.90). Derived purely
  // from stored cents columns; the surcharge-rate math itself stays in
  // stripe-pricing (one-authority rule).
  const surchargeCents = Math.max(
    0,
    Number(payment.surcharge_amount_cents) || 0,
  );
  const refundedSurchargeCents = Math.min(
    surchargeCents,
    Math.max(0, Number(payment.refunded_surcharge_cents) || 0),
  );
  const remainingSurchargeCents = Math.min(
    surchargeCents - refundedSurchargeCents,
    remainingCents,
  );
  const remainingBaseCents = Math.max(0, remainingCents - remainingSurchargeCents);
  // Degenerate ledger (base consumed, share still outstanding): fall back
  // to the gross cap so the remainder stays refundable at all.
  const maxEntryCents = remainingBaseCents > 0 ? remainingBaseCents : remainingCents;
  const [amountStr, setAmountStr] = useState((maxEntryCents / 100).toFixed(2));
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState("");
  const [done, setDone] = useState(null);

  const parsed = parseFloat(amountStr);
  const enteredCents = Number.isFinite(parsed) ? Math.round(parsed * 100) : NaN;
  const amountValid =
    Number.isFinite(enteredCents) &&
    enteredCents > 0 &&
    enteredCents <= maxEntryCents;

  // The profile-level Escape handler closes the ENTIRE profile
  // unconditionally; while a refund is in flight, swallow Escape in the
  // capture phase so the operator can't unmount the modal mid-request and
  // lose the outcome (the request itself would still complete server-side).
  useEffect(() => {
    if (!running) return undefined;
    const swallow = (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
      }
    };
    window.addEventListener("keydown", swallow, true);
    return () => window.removeEventListener("keydown", swallow, true);
  }, [running]);

  const confirm = async () => {
    if (!amountValid || running) return;
    setRunning(true);
    setErr("");
    let updatedRow = null;
    try {
      updatedRow = await adminFetch(`/admin/customers/${customer.id}/refund`, {
        method: "POST",
        body: JSON.stringify({
          paymentId: payment.id,
          amount: enteredCents / 100,
          reason: "requested_by_customer",
        }),
      });
    } catch (e) {
      setErr(e.message || "Refund failed");
      setRunning(false);
      return;
    }
    // Report what Stripe actually issued, not the entered base: partials on
    // surcharged payments are grossed up server-side by the prorated
    // surcharge share. Prefer the response's attempt-specific
    // refund_issued_amount — diffing cumulative refund_amount snapshots
    // absorbs any concurrent refund that landed mid-request — and keep the
    // delta only as a fallback for a response without the field.
    const issuedCents = Math.round(
      parseFloat(updatedRow?.refund_issued_amount || 0) * 100,
    );
    const newCumulativeCents = Math.round(
      parseFloat(updatedRow?.refund_amount || 0) * 100,
    );
    const grossNowCents =
      issuedCents > 0
        ? issuedCents
        : newCumulativeCents > refundedCents
          ? newCumulativeCents - refundedCents
          : enteredCents;
    const doneState = {
      refundedNow: grossNowCents / 100,
      includesSurcharge: grossNowCents > enteredCents,
      refreshErr: "",
    };
    try {
      await onDone?.();
    } catch (refreshError) {
      doneState.refreshErr = `The refund went through, but the customer profile could not refresh: ${refreshError.message || "Refresh failed"}`;
    }
    setDone(doneState);
    setRunning(false);
  };

  // Owns Escape and the focus trap while open (the profile's window-level
  // Escape defers to any open sub-modal); backdrop clicks stop here so they
  // never bubble through the React tree to the profile overlay's onClose.
  const dialogRef = useModalFocus(true, () => !running && onClose?.());
  return createPortal(
    <div data-ui-density={density}
      className="admin-shell-v2 fixed inset-0 bg-black/70 z-[1100] flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
      onClick={(e) => {
        e.stopPropagation();
        if (!running) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Refund payment"
        className="bg-white w-full min-h-full sm:min-h-0 max-w-none sm:max-w-[440px] rounded-none sm:rounded-sm border-hairline border-zinc-300 my-0 sm:my-4 box-border pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline border-zinc-200">
          <div className="text-15 font-medium text-zinc-900">Refund payment</div>
          <button data-ui-text-action
            onClick={() => !running && onClose()}
            aria-label="Close"
            className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring"
          >
            ×
          </button>
        </div>
        <div className="p-4 text-ui-body text-zinc-900">
          {done ? (
            <div>
              <div className="mb-2 font-medium">
                Refund issued: <span className="u-nums">{fmtCurrency(done.refundedNow)}</span> to{" "}
                {customer.firstName} {customer.lastName}
                {done.includesSurcharge
                  ? " (includes the returned card-surcharge share)"
                  : ""}
                .
              </div>
              <div className="text-ui-label text-ink-secondary">
                Issued through Stripe — it typically lands in 5–10 business days.
              </div>
              {done.refreshErr && (
                <div className="mt-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">
                  {done.refreshErr}
                </div>
              )}
            </div>
          ) : (
            <div>
              <div className="mb-1 flex justify-between gap-3">
                <span className="text-ink-secondary">Payment</span>
                <span className="u-nums">
                  {fmtCurrency(payment.amount)}
                  {payment.card_brand
                    ? ` · ${payment.card_brand} …${payment.last_four}`
                    : ""}{" "}
                  · {fmtDateOnly(payment.payment_date)}
                </span>
              </div>
              {refundedCents > 0 && (
                <div className="mb-1 flex justify-between gap-3">
                  <span className="text-ink-secondary">Already refunded</span>
                  <span className="u-nums">{fmtCurrency(refundedCents / 100)}</span>
                </div>
              )}
              <div className="mb-3 flex justify-between gap-3">
                <span className="text-ink-secondary">Refundable</span>
                <span className="u-nums font-medium">{fmtCurrency(maxEntryCents / 100)}</span>
              </div>
              <label
                htmlFor="refund-amount"
                className="block text-ui-label text-ink-secondary mb-1"
              >
                Refund amount
              </label>
              <Input
                id="refund-amount"
                type="number"
                inputMode="decimal"
                min="0.01"
                max={(maxEntryCents / 100).toFixed(2)}
                step="0.01"
                value={amountStr}
                disabled={running}
                onChange={(e) => setAmountStr(e.target.value)}
              />
              {amountStr !== "" && !amountValid && (
                <div className="mt-1.5 text-ui-label text-alert-fg">
                  Enter an amount between $0.01 and{" "}
                  {fmtCurrency(maxEntryCents / 100)}.
                </div>
              )}
              {remainingSurchargeCents > 0 && (
                <div className="mt-2 text-ui-label text-ink-secondary">
                  The {fmtCurrency(remainingSurchargeCents / 100)} card-surcharge
                  share is returned automatically on top — in full with a full
                  refund, prorated with a partial amount.
                </div>
              )}
              <div className="mt-2 text-ui-label text-ink-secondary">
                Issued through Stripe — refunds typically land in 5–10 business
                days.
              </div>
              {err && (
                <div className="mt-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">
                  {err}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-hairline border-zinc-200">
          <Button variant="secondary" onClick={onClose} disabled={running}>
            {done ? "Close" : "Cancel"}
          </Button>
          {!done && (
            <Button
              variant="danger"
              onClick={confirm}
              disabled={running || !amountValid}
            >
              {running
                ? "Refunding…"
                : amountValid
                  ? `Refund ${fmtCurrency(enteredCents / 100)}`
                  : "Refund"}
            </Button>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================
function CustomerWorkspaceHeader({
  c,
  isAdmin,
  unreadConversations,
  onEdit,
  onTab,
  onMessage,
  onSendLink,
  menuOpen,
  setMenuOpen,
  menuRef,
}) {
  const menuId = useId();
  const name =
    [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
    "Unnamed customer";
  const address = c.address ? formatAddress(c.address) : "";
  const contacts = ["", "2", "3"]
    .map((suffix) => ({
      name: c[`serviceContact${suffix}Name`],
      phone: c[`serviceContact${suffix}Phone`],
      email: c[`serviceContact${suffix}Email`],
    }))
    .filter((contact) => contact.phone || contact.email);
  const actions = [
    ...(isAdmin
      ? [
          {
            label: "Book appointment",
            href: `/admin/schedule?customer=${c.id}`,
          },
          { label: "Invoices", href: `/admin/invoices?customer=${c.id}` },
        ]
      : []),
    { label: "Activity & notes", onClick: () => onTab("comms") },
    ...(c.phone && isAdmin
      ? [{ label: "Send link", onClick: onSendLink }]
      : []),
    ...(isAdmin ? [{ label: "Edit customer", onClick: onEdit }] : []),
  ];
  return (
    <header className="c360-workspace-header">
      <div className="c360-workspace-identity">
        <div className="c360-workspace-name">
          <div className="c360-workspace-name-row">
            <h1 className="ui-record-title">{name}</h1>
            <StageBadgeV2 stage={c.pipelineStage} />
          </div>
          <div className="c360-workspace-meta">
            <TierBadgeV2 tier={c.tier} />
            {c.memberSince && (
              <span>
                Customer since{" "}
                {formatETDateOnly(c.memberSince, {
                  month: "short",
                  year: "numeric",
                })}
              </span>
            )}
            {c.profileLabel && (
              <Badge className="normal-case tracking-normal">
                {c.profileLabel}
              </Badge>
            )}
            {c.contactRole && c.contactRole !== "owner" && (
              <Badge
                className="normal-case tracking-normal"
                title={contactRoleTitle(c.contactRole)}
              >
                {contactRoleLabel(c.contactRole)}
              </Badge>
            )}
          </div>
        </div>
      </div>
      <div className="c360-workspace-actions ui-record-actions">
        {c.phone && (
          <Button className="c360-message-action" aria-haspopup="dialog" onClick={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            onMessage();
          }}>
            <MessageSquare size={16} />
            Message
            {unreadConversations > 0 && (
              <span
                className="c360-unread-count"
                aria-label={`${unreadConversations} unread conversations`}
              >
                {unreadConversations}
              </span>
            )}
          </Button>
        )}
        {isAdmin && (
          <a
            className={buttonStyles({ variant: "secondary", density: "comfortable" })}
            href={customerEstimateHref({ ...c, address })}
          >
            <FileText size={16} />
            Create estimate
          </a>
        )}
        <div
          className="c360-more-action"
          ref={menuRef}
          onKeyDown={(event) => {
            if (event.key === "Escape" && menuOpen) {
              event.stopPropagation();
              setMenuOpen(false);
              menuRef.current?.querySelector("button")?.focus();
            }
          }}
        >
          <Button
            variant="ghost"
            className="ui-icon-action"
            aria-label="More customer actions"
            aria-expanded={menuOpen}
            aria-controls={menuId}
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              setMenuOpen((open) => !open);
            }}
          >
            <MoreHorizontal size={20} />
          </Button>
          {menuOpen && (
            <div id={menuId} className="ui-action-menu">
              {actions.map((action) =>
                action.href ? (
                  <a
                    key={action.label}
                    className={buttonStyles({ variant: "ghost", density: "comfortable", className: "ui-menu-action" })}
                    href={action.href}
                  >
                    {action.label}
                  </a>
                ) : (
                  <Button
                    key={action.label}
                    type="button"
                    variant="ghost"
                    className="ui-menu-action"
                    onClick={() => {
                      menuRef.current?.querySelector("button")?.focus();
                      setMenuOpen(false);
                      action.onClick();
                    }}
                  >
                    {action.label}
                  </Button>
                ),
              )}
            </div>
          )}
        </div>
      </div>
      <div className="c360-workspace-contact" aria-label="Contact details">
        {c.phone && (
          <div>
            <Button
              variant="secondary"
              className="c360-contact-action"
              onClick={() => callViaBridge(c.phone, name)}
            >
              <Phone size={16} />
              Call
            </Button>
            <span>{c.phone}</span>
          </div>
        )}
        {c.email && (
          <div>
            <a
              className={buttonStyles({ variant: "secondary", density: "comfortable", className: "c360-contact-action" })}
              href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <Mail size={16} />
              Email
            </a>
            <span>{c.email}</span>
          </div>
        )}
        {address && (
          <div>
            <a
              className={buttonStyles({ variant: "secondary", density: "comfortable", className: "c360-contact-action" })}
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <MapPin size={16} />
              Address
            </a>
            <span>{address}</span>
          </div>
        )}
      </div>
      {contacts.length > 0 && (
        <details className="c360-additional-contacts">
          <summary>Service contacts ({contacts.length})</summary>
          {contacts.map((contact, index) => (
            <div key={index}>
              <span>{contact.name || `Service contact ${index + 1}`}</span>
              {contact.phone && (
                <CallBridgeLink
                  phone={contact.phone}
                  customerName={contact.name || name}
                >
                  {contact.phone}
                </CallBridgeLink>
              )}
              {contact.email && (
                <a
                  href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(contact.email)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {contact.email}
                </a>
              )}
            </div>
          ))}
        </details>
      )}
    </header>
  );
}

function CustomerContactLinks({
  phone,
  email,
  customerName,
  phoneClassName,
  emailClassName,
}) {
  return (
    <>
      {phone && (
        <CallBridgeLink
          phone={phone}
          customerName={customerName}
          className={phoneClassName}
        >
          {phone}
        </CallBridgeLink>
      )}
      {email && (
        <a
          href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}`}
          target="_blank"
          rel="noopener noreferrer"
          className={emailClassName}
        >
          {email}
        </a>
      )}
    </>
  );
}
function CustomerContactRoleBadge({ role }) {
  if (!role || role === "owner") return null;
  return (
    <Badge
      tone="neutral"
      className="normal-case tracking-normal"
      title={contactRoleTitle(role)}
    >
      {contactRoleLabel(role)}
    </Badge>
  );
}
function CustomerAddressLink({ address, mobile = false }) {
  const parts = [
    address?.line1,
    address?.line2,
    address?.city,
    address?.state,
    address?.zip,
  ].filter(Boolean);
  const visible = mobile ? address?.line1 || address?.city : parts.length > 0;
  if (!visible) return null;
  const label = mobile ? parts.join(", ") : formatAddress(address);
  return (
    <a
      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(label)}`}
      target="_blank"
      rel="noopener noreferrer"
      className={
        mobile
          ? "block text-ui-body text-ink-secondary no-underline hover:text-zinc-900 mb-2 truncate"
          : "text-zinc-900 hover:underline"
      }
    >
      {label}
    </a>
  );
}
function CustomerMessageTime({ message, inverted = false }) {
  return (
    <div
      className={cn(
        "text-ui-caption mt-1 text-right",
        inverted ? "text-zinc-300" : "text-ink-secondary",
      )}
    >
      {timeAgo(message.createdAt)}
    </div>
  );
}
function CustomerSmsMessage({ message: m, embedded }) {
  const inbound = m.direction === "inbound";
  return (
    <div
      className={cn(
        "max-w-[75%] px-3 py-2 text-ui-body leading-relaxed border-hairline",
        inbound
          ? "self-start bg-zinc-50 border-zinc-200 text-zinc-900 rounded-sm rounded-bl-xs"
          : "self-end bg-zinc-900 border-zinc-900 text-white rounded-sm rounded-br-xs",
      )}
    >
      {" "}
      <div>{m.body}</div>
      {embedded && m.media?.length > 0 && (
        <Suspense fallback={<span>Loading attachments…</span>}>
          <CustomerMessageMedia
            media={m.media}
            inverted={m.direction === "outbound"}
          />
        </Suspense>
      )}{" "}
      <CustomerMessageTime message={m} inverted={!inbound} />
    </div>
  );
}
function CustomerCallMessage({ message: m }) {
  const inbound = m.direction === "inbound"; // voice
  const rec = (m.media || []).find((x) => x.type === "recording");
  const duration = fmtDur(m.durationSeconds ?? rec?.duration_seconds);
  const summary = m.aiSummary || m.body;

  const recordingId =
    (rec?.available || m.recordingSid) && (rec?.sid || m.recordingSid);
  return (
    <div
      className={cn(
        "max-w-[85%] px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm",
        inbound ? "self-start" : "self-end",
      )}
    >
      {" "}
      <div className="flex items-center gap-2 mb-1">
        {" "}
        <span className="text-ui-caption font-medium tracking-label uppercase text-ink-secondary">
          {inbound ? "Call in" : "Call out"}
        </span>
        {duration && (
          <span className="text-ui-caption u-nums text-zinc-900">{duration}</span>
        )}
        {m.answeredBy && (
          <span className="text-ui-caption text-ink-secondary">· {m.answeredBy}</span>
        )}
      </div>
      {summary && (
        <div className="text-ui-label text-zinc-900 leading-relaxed">{summary}</div>
      )}
      {recordingId && (
        <AuthenticatedCallAudio
          recordingId={recordingId}
          className="mt-1.5 w-full h-8"
        />
      )}
      <CustomerMessageTime message={m} />{" "}
    </div>
  );
}

function CustomerOverlayHeader({
  c,
  isAdmin,
  openIntelligenceBar,
  openEditModal,
  score,
  onClose,
  customerId,
  setAnnualPrepayInvoiceOpen,
  setActiveTab,
}) {
  const customerName = [c.firstName, c.lastName]
    .filter(Boolean)
    .join(" ")
    .trim();
  return (
    <>
      {/* ZONE 1 — STICKY HEADER */}
      <div className="sticky top-0 z-10 bg-white border-b border-hairline border-zinc-200">
        {/* Desktop header (>= 768px) */}
        <div className="c360-header-desktop px-6 py-4">
          {" "}
          <div className="flex justify-between items-start mb-2">
            {" "}
            <div className="flex items-center gap-3 flex-wrap">
              {" "}
              <div className="text-22 font-medium tracking-tight text-zinc-900">
                {c.firstName} {c.lastName}
              </div>
              {c.profileLabel && (
                <Badge className="normal-case tracking-normal">
                  {c.profileLabel}
                </Badge>
              )}
              <CustomerContactRoleBadge role={c.contactRole} />
              <HealthCircle score={score} /> <TierBadgeV2 tier={c.tier} />{" "}
              <StageBadgeV2 stage={c.pipelineStage} />{" "}
            </div>{" "}
            <button data-ui-text-action
              onClick={onClose}
              aria-label="Close"
              className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring"
            >
              ×
            </button>{" "}
          </div>
          {(c.phone || c.email) && (
            <div className="flex gap-4 items-center flex-wrap text-ui-label text-ink-secondary mb-1.5">
              <CustomerContactLinks
                phone={c.phone}
                email={c.email}
                customerName={customerName}
                phoneClassName="u-nums text-zinc-900 hover:underline"
                emailClassName="text-zinc-900 hover:underline"
              />
            </div>
          )}
          {[
            {
              key: "1",
              label: "Service contact:",
              name: c.serviceContactName,
              phone: c.serviceContactPhone,
              email: c.serviceContactEmail,
            },
            {
              key: "2",
              label: "Service contact 2:",
              name: c.serviceContact2Name,
              phone: c.serviceContact2Phone,
              email: c.serviceContact2Email,
            },
            {
              key: "3",
              label: "Service contact 3:",
              name: c.serviceContact3Name,
              phone: c.serviceContact3Phone,
              email: c.serviceContact3Email,
            },
          ]
            .filter((slot) => slot.phone || slot.email)
            .map((slot) => (
              <div key={slot.key} className="text-ui-label text-ink-secondary mb-1.5">
                {" "}
                <span className="text-ink-tertiary mr-1">{slot.label}</span>
                {slot.name && (
                  <span className="text-zinc-900 mr-2">{slot.name}</span>
                )}
                <CustomerContactLinks
                  phone={slot.phone}
                  email={slot.email}
                  customerName={slot.name || customerName}
                  phoneClassName="u-nums text-zinc-900 hover:underline mr-3"
                  emailClassName="text-zinc-900 hover:underline"
                />
              </div>
            ))}
          <div className="flex gap-4 items-center flex-wrap text-ui-label text-ink-secondary mb-2.5">
            <CustomerAddressLink address={c.address} />
            <span className="u-nums text-zinc-900">
              {fmtCurrency(c.monthlyRate)}/mo
            </span>{" "}
            <span className="u-nums">{fmtCurrency(c.annualValue)}/yr</span>
            {c.memberSince && <span>Since {fmtDate(c.memberSince)}</span>}
          </div>{" "}
          <div className="flex gap-2 flex-wrap">
            {isAdmin && openIntelligenceBar && (
              <Button variant="secondary" className="text-14" onClick={openIntelligenceBar}>Intelligence Bar</Button>
            )}
            {c.phone && (
              <>
                {" "}
                <a
                  href={`/admin/communications?phone=${encodeURIComponent(c.phone)}&action=sms`}
                  className="inline-flex items-center h-8 px-3.5 text-ui-caption ui-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
                >
                  Text
                </a>{" "}
                <button data-ui-text-action
                  type="button"
                  onClick={() =>
                    callViaBridge(
                      c.phone,
                      `${c.firstName || ""} ${c.lastName || ""}`.trim(),
                    )
                  }
                  className="inline-flex items-center h-8 px-3.5 text-ui-caption ui-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
                >
                  Call
                </button>{" "}
              </>
            )}
            <a
              href={`/admin/schedule?customer=${customerId}`}
              className="inline-flex items-center h-8 px-3.5 text-ui-caption ui-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
            >
              Book Appt
            </a>{" "}
            <a
              href={`/admin/invoices?customer=${customerId}`}
              className="inline-flex items-center h-8 px-3.5 text-ui-caption ui-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
            >
              Invoice
            </a>
            {isAdmin && (
              <button data-ui-text-action
                type="button"
                onClick={() => setAnnualPrepayInvoiceOpen(true)}
                className="inline-flex items-center h-8 px-3.5 text-ui-caption ui-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
              >
                Prepay Invoice
              </button>
            )}
            <button data-ui-text-action
              onClick={() => setActiveTab("comms")}
              className="inline-flex items-center h-8 px-3.5 text-ui-caption ui-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
            >
              Add Note
            </button>
            {isAdmin && (
              <button data-ui-text-action
                onClick={openEditModal}
                className="inline-flex items-center h-8 px-3.5 text-ui-caption ui-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
              >
                Edit
              </button>
            )}
          </div>{" "}
        </div>
        {/* Mobile header (< 768px) — per mobile-admin-audit PR #3 item 2:
              back / menu / Text pills on top, large name, three-stat row */}
        <div className="c360-header-mobile px-4 pb-3">
          {" "}
          {/* Spacer reserving the fixed top action bar's height (8px top
                pad + 44px controls + 8px bottom pad = 60px, plus the iPhone
                safe-area inset) so the name/stats start below it. */}
          <div
            aria-hidden="true"
            style={{
              height: "calc(60px + env(safe-area-inset-top, 0px))",
            }}
          />
          <div className="text-26 font-medium tracking-tight text-zinc-900 leading-tight mb-1">
            {c.firstName} {c.lastName}
          </div>
          <CustomerAddressLink address={c.address} mobile />
          {/* Contact — listed on mobile (desktop shows these in its header) */}
          {(c.phone || c.email) && (
            <div className="flex flex-col gap-1 mb-3 text-ui-body">
              <CustomerContactLinks
                phone={c.phone}
                email={c.email}
                customerName={customerName}
                phoneClassName="u-nums text-ink-secondary hover:text-zinc-900 no-underline self-start"
                emailClassName="text-ink-secondary hover:text-zinc-900 no-underline truncate"
              />
            </div>
          )}
          <div className="flex items-center gap-2 flex-wrap mb-3">
            {" "}
            <TierBadgeV2 tier={c.tier} />{" "}
            <StageBadgeV2 stage={c.pipelineStage} />{" "}
            <CustomerContactRoleBadge role={c.contactRole} />
          </div>{" "}
          <div className="flex items-stretch gap-3 pt-3 border-t border-hairline border-zinc-200">
            {" "}
            <div className="flex-1">
              {" "}
              <div className="ui-label text-ink-tertiary">Monthly</div>{" "}
              <div className="u-nums text-15 font-medium text-zinc-900 mt-0.5">
                {fmtCurrency(c.monthlyRate)}
              </div>{" "}
            </div>{" "}
            <div className="flex-1 border-l border-hairline border-zinc-200 pl-3">
              {" "}
              <div className="ui-label text-ink-tertiary">Annual</div>{" "}
              <div className="u-nums text-15 font-medium text-zinc-900 mt-0.5">
                {fmtCurrency(c.annualValue)}
              </div>{" "}
            </div>{" "}
            <div className="flex-1 border-l border-hairline border-zinc-200 pl-3">
              {" "}
              <div className="ui-label text-ink-tertiary">Health</div>{" "}
              <div
                className={cn(
                  "u-nums text-15 font-medium mt-0.5",
                  score != null && score < 40
                    ? "text-alert-fg"
                    : "text-zinc-900",
                )}
              >
                {score != null ? score : "—"}
              </div>{" "}
            </div>{" "}
          </div>{" "}
        </div>{" "}
      </div>
    </>
  );
}

function CustomerProfileAlerts({ alerts }) {
  return (
    alerts.length > 0 && (
      <div className="c360-alerts flex flex-wrap gap-2 px-6 py-3 bg-zinc-50 border-b border-hairline border-zinc-200">
        {alerts.map((a, i) => (
          <div
            key={i}
            className={cn(
              "inline-flex items-center gap-1.5 h-6 px-2 text-ui-caption font-medium rounded-xs border-hairline",
              a.alert
                ? "bg-alert-bg border-alert-fg text-alert-fg"
                : "bg-white border-zinc-200 text-zinc-700",
            )}
          >
            {" "}
            <span className="ui-label text-ui-caption">
              {a.label}
            </span>{" "}
            <span className="normal-case">{a.text}</span>{" "}
          </div>
        ))}
      </div>
    )
  );
}

function CustomerWorkspaceNavigation({
  tabsAnchorRef,
  c,
  activeTab,
  changeWorkspaceTab,
  profileContentId,
  workspaceSections,
}) {
  return (
    <>
      <div ref={tabsAnchorRef} className="c360-tabs-anchor" />
      <div className="c360-sticky-identity">
        {c.firstName} {c.lastName}
      </div>
      <Customer360Sections
        active={activeTab}
        onChange={changeWorkspaceTab}
        contentId={profileContentId}
        sections={workspaceSections}
      />
    </>
  );
}
function CustomerOverlayNavigation({
  activeTab,
  setActiveTab,
  activeTabButtonRef,
}) {
  return (
    <>
      {/* ZONE 3 — TAB BAR */}
      {/* shrink-0: this is an overflow-x scroll container, so its flex
            auto-minimum-size is 0 — without it the column flex collapses the
            bar to ~0px on mobile (tall content), hiding every section tab. */}
      <div className="flex shrink-0 bg-white border-b border-hairline border-zinc-200 px-6 overflow-x-auto">
        {CUSTOMER_360_SECTIONS.filter(
          (section) => section.key !== "estimates",
        ).map((t) => (
          <button data-ui-text-action
            key={t.key}
            ref={activeTab === t.key ? activeTabButtonRef : null}
            aria-pressed={activeTab === t.key}
            onClick={() => setActiveTab(t.key)}
            className={cn(
              "h-11 px-4 text-ui-label ui-label font-medium whitespace-nowrap u-focus-ring transition-colors border-b-2",
              activeTab === t.key
                ? "text-zinc-900 border-zinc-900"
                : "text-ink-secondary border-transparent hover:text-zinc-900",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
    </>
  );
}

function CustomerProfileOverview({
  embedded,
  isAdmin,
  c,
  upcomingFuture,
  services,
  comms,
  commsLoading,
  commsErr,
  data,
  unreadConversations,
  prefs,
  alerts,
  openMessages,
  changeWorkspaceTab,
  viewServiceRecords,
  discounts,
  referral,
  customerId,
  accountProperties,
  onSelectCustomer,
  addressNeighbors,
  setData,
  setProfileActionErr,
  billingSummary,
}) {
  return (
    <div className="c360-overview-content">
      {embedded && (
        <Customer360Summary
          isAdmin={isAdmin}
          customer={c}
          upcoming={upcomingFuture}
          services={services}
          comms={comms}
          commsLoading={commsLoading}
          commsError={
            isAdmin ? commsErr : "Message history requires admin access"
          }
          balance={data.billingSummary}
          unread={unreadConversations}
          preferences={prefs}
          alerts={alerts}
          onMessage={openMessages}
          onTab={changeWorkspaceTab}
          onViewServices={viewServiceRecords}
          discounts={discounts}
          referral={referral}
        />
      )}
      <CustomerRequestsPanel customerId={customerId} />
      {/* both customer-scoped zone endpoints are requireAdmin — a
                  technician session would only 403 on expand */}
      {!embedded && isAdmin && <PropertyZonesPanel customerId={customerId} />}
      {!embedded && isAdmin && <TermiteStationsGate customerId={customerId} />}
      {accountProperties.length > 0 && (
        <div className="mb-4 pb-3 border-b border-hairline border-zinc-200">
          {" "}
          <SectionTitle>Other Properties For This Customer</SectionTitle>{" "}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {accountProperties.map((p) => {
              const addr = [
                p.address?.line1,
                p.address?.line2,
                p.address?.city,
                p.address?.state,
                p.address?.zip,
              ]
                .filter(Boolean)
                .join(", ");
              const className =
                "text-left rounded-sm border-hairline border-zinc-200 bg-zinc-50 hover:bg-zinc-100 u-focus-ring p-2.5";
              const content = (
                <>
                  {" "}
                  <div className="text-ui-body font-medium text-zinc-900">
                    {p.profileLabel || "Service property"}
                  </div>{" "}
                  <div className="text-ui-label text-ink-secondary truncate">
                    {addr || "No address on file"}
                  </div>{" "}
                  <div className="text-ui-caption text-ink-tertiary mt-1">
                    {fmtCurrency(p.monthlyRate || 0)}/mo
                  </div>{" "}
                </>
              );
              if (!onSelectCustomer) {
                return (
                  <a
                    key={p.id}
                    href={`/admin/customers?customerId=${encodeURIComponent(p.id)}`}
                    className={cn(className, "block no-underline")}
                  >
                    {content}
                  </a>
                );
              }
              return (
                <button data-ui-text-action
                  key={p.id}
                  type="button"
                  onClick={() => onSelectCustomer?.(p.id)}
                  className={className}
                >
                  {content}
                </button>
              );
            })}
          </div>{" "}
        </div>
      )}
      {addressNeighbors.length > 0 && (
        <div
          className="mb-4 pb-3 border-b border-hairline border-zinc-200"
          data-testid="address-neighbors"
        >
          {" "}
          <SectionTitle>Others at this address</SectionTitle>{" "}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {addressNeighbors.map((n) => {
              const name =
                `${n.firstName || ""} ${n.lastName || ""}`.trim() ||
                "(no name)";
              const addr = [n.address?.line1, n.address?.line2]
                .filter(Boolean)
                .join(", ");
              const className =
                "text-left rounded-sm border-hairline border-zinc-200 bg-zinc-50 hover:bg-zinc-100 u-focus-ring p-2.5";
              const content = (
                <>
                  {" "}
                  <div className="text-14 font-medium text-zinc-900">
                    {name}
                  </div>{" "}
                  <div className="text-14 text-ink-secondary truncate">
                    {[n.phone, STAGE_LABELS[n.pipelineStage] || n.pipelineStage]
                      .filter(Boolean)
                      .join(" · ") || "No contact on file"}
                  </div>{" "}
                  <div className="text-ui-label text-ink-tertiary mt-1 truncate">
                    {addr || "Address on file"}
                    {n.matchedVia === "property" ? " · secondary property" : ""}
                  </div>{" "}
                </>
              );
              if (!onSelectCustomer) {
                return (
                  <a
                    key={n.id}
                    href={`/admin/customers?customerId=${encodeURIComponent(n.id)}`}
                    className={cn(className, "block no-underline")}
                  >
                    {content}
                  </a>
                );
              }
              return (
                <button data-ui-text-action
                  key={n.id}
                  type="button"
                  onClick={() => onSelectCustomer?.(n.id)}
                  className={className}
                >
                  {content}
                </button>
              );
            })}
          </div>{" "}
        </div>
      )}
      <div className="flex items-center justify-between mb-4 pb-3 border-b border-hairline border-zinc-200">
        {" "}
        <div>
          {" "}
          <div className="text-ui-body font-medium text-zinc-900">
            Already left a Google review
          </div>{" "}
          <div className="text-ui-caption text-ink-secondary">
            When on, this customer is excluded from review-request and 48h
            followup SMS.
          </div>
          {c.reviewMarkedAt && c.hasLeftGoogleReview && (
            <div className="text-ui-caption text-ink-tertiary mt-0.5 u-nums">
              Marked {fmtDate(c.reviewMarkedAt)}
            </div>
          )}
        </div>{" "}
        <Switch
          id="has-left-review-v2"
          checked={!!c.hasLeftGoogleReview}
          disabled={!isAdmin}
          onChange={async (val) => {
            const previousHasLeftGoogleReview = !!c.hasLeftGoogleReview;
            const previousReviewMarkedAt = c.reviewMarkedAt || null;
            setData((prev) =>
              prev
                ? {
                    ...prev,
                    customer: {
                      ...prev.customer,
                      hasLeftGoogleReview: val,
                      reviewMarkedAt: val ? new Date().toISOString() : null,
                    },
                  }
                : prev,
            );
            try {
              await adminFetch(`/admin/customers/${customerId}`, {
                method: "PUT",
                body: JSON.stringify({ hasLeftGoogleReview: val }),
              });
            } catch (err) {
              setData((prev) =>
                prev
                  ? {
                      ...prev,
                      customer: {
                        ...prev.customer,
                        hasLeftGoogleReview: previousHasLeftGoogleReview,
                        reviewMarkedAt: previousReviewMarkedAt,
                      },
                    }
                  : prev,
              );
              setProfileActionErr(
                err.message || "Review status failed to save",
              );
            }
          }}
        />{" "}
      </div>{" "}
      {!embedded && (
        <>
          <div className="c360-overview-grid grid grid-cols-3 gap-5">
            {/* Col 1: Services */}
            <div className="c360-overview-services">
              {" "}
              <SectionTitle>
                Upcoming Appointments ({upcomingFuture.length})
              </SectionTitle>
              {upcomingFuture.length > 0 ? (
                upcomingFuture.slice(0, 3).map((s, i) => (
                  <div
                    key={i}
                    className="c360-upcoming-appointment bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5 mb-2"
                  >
                    {" "}
                    <div className="text-ui-body font-medium text-zinc-900">
                      {s.service_type}
                    </div>{" "}
                    <div className="text-ui-label text-ink-secondary">
                      {fmtDateOnly(s.scheduled_date)} · {s.status}
                    </div>{" "}
                  </div>
                ))
              ) : (
                <div className="text-ui-label text-ink-secondary mb-3">
                  No upcoming appointments
                </div>
              )}
              <SectionTitle>Recent Services ({services.length})</SectionTitle>
              {services.slice(0, 5).map((s, i) => {
                const recentNotes = parseStructuredNotes(s.structured_notes);
                return (
                  <div
                    key={i}
                    className="c360-recent-service py-1.5 text-ui-label border-b border-hairline border-zinc-200/60 flex justify-between gap-3"
                  >
                    {" "}
                    <span className="text-zinc-900 flex items-center gap-1.5">
                      {s.service_type}
                      {recentNotes.projectCompletion === true && (
                        <Badge tone="neutral">Project</Badge>
                      )}
                    </span>{" "}
                    <span className="text-ink-secondary">
                      {fmtDateOnly(s.service_date)}
                    </span>{" "}
                  </div>
                );
              })}
              {services.length === 0 && (
                <div className="text-ui-label text-ink-secondary">
                  No services recorded
                </div>
              )}
            </div>
            {/* Col 2: Billing snapshot */}
            {!embedded && billingSummary}
            {/* Col 3: Health + Referral + Discounts */}
            <div className="c360-overview-health">
              {referral && (
                <div className="mt-4">
                  {" "}
                  <SectionTitle>Referral Stats</SectionTitle>{" "}
                  <div className="text-ui-label text-zinc-900">
                    Code: <span className="u-nums">{c.referralCode}</span>{" "}
                  </div>
                  {referral.total_referrals != null && (
                    <div className="text-ui-label text-ink-secondary">
                      Referrals: {referral.total_referrals}
                    </div>
                  )}
                  {referral.total_earned != null && (
                    <div className="text-ui-label text-zinc-900">
                      Earned:{" "}
                      <span className="u-nums">
                        {fmtCurrency(referral.total_earned)}
                      </span>
                    </div>
                  )}
                </div>
              )}
              {discounts.length > 0 && (
                <div className="mt-4">
                  {" "}
                  <SectionTitle>Active Discounts</SectionTitle>
                  {discounts.map((d, i) => (
                    <div key={i} className="text-ui-label text-zinc-900 py-0.5">
                      {d.discount_name || "Discount"}:{" "}
                      <span className="u-nums">
                        {d.discount_type === "percentage"
                          ? `${d.discount_value}%`
                          : fmtCurrency(d.discount_value)}
                      </span>{" "}
                    </div>
                  ))}
                </div>
              )}
            </div>{" "}
          </div>{" "}
        </>
      )}
    </div>
  );
}

function CustomerProfileBilling({
  balanceOwed,
  overdueBalance,
  c,
  embedded,
  displayedAnnualPrepayTerm,
  data,
  billingSummary,
  isAdmin,
  setAnnualPrepayOpen,
  setAnnualPrepayInvoiceOpen,
  invoices,
  payments,
  setRefundPayment,
  cards,
  setCancelSignupOpen,
  setCancelPlanOpen,
}) {
  return (
    <div className="c360-billing-content">
      {" "}
      <div className="c360-billing-grid grid grid-cols-4 gap-3 mb-5">
        {" "}
        <StatCardV2
          label="Open balance"
          value={fmtCurrency(balanceOwed)}
          alert={balanceOwed > 0}
        />{" "}
        <StatCardV2
          label="Overdue balance"
          value={fmtCurrency(overdueBalance)}
          alert={overdueBalance > 0}
        />
        <StatCardV2
          label={
            c.billingMode === "monthly_membership"
              ? "Monthly rate"
              : "Billing arrangement"
          }
          value={
            c.billingMode === "monthly_membership"
              ? fmtCurrency(c.monthlyRate)
              : {
                  per_visit: "Per application",
                  per_application: "Per application",
                  annual_prepay: "Annual prepay",
                  one_time: "One-time",
                }[c.billingMode] || "Not set"
          }
        />
        <StatCardV2
          label="Lifetime Revenue"
          value={fmtCurrency(c.lifetimeRevenue)}
        />{" "}
      </div>{" "}
      {embedded && (
        <>
          <div className="c360-billing-actions">
            <a
              className={buttonStyles({ variant: "secondary", density: "comfortable", className: "" })}
              href={`/admin/invoices?customer=${c.id}`}
            >
              Manage invoices
              <ArrowUpRight size={15} />
            </a>
          </div>
          {(c.servicePausedAt ||
            displayedAnnualPrepayTerm ||
            data.prepaidPlans?.length > 0) &&
            billingSummary}
          <Customer360Estimates estimates={data.estimates || []} />
        </>
      )}
      <BillingLanePanelV2
        customerId={c.id}
        billingMode={c.billingMode}
        tier={c.tier}
        monthlyRate={c.monthlyRate}
        canEdit={isAdmin}
      />{" "}
      <AdminAutopayPanelV2
        customerId={c.id}
        monthlyRate={c.monthlyRate}
        customerName={`${c.firstName} ${c.lastName}`}
        canCharge={isAdmin}
      />{" "}
      <AccountCreditPanelV2
        customerId={c.id}
        customerName={`${c.firstName} ${c.lastName}`}
        canEdit={isAdmin}
      />{" "}
      {isAdmin && (
        <AnnualPrepayPanelV2
          customer={c}
          activeTerm={displayedAnnualPrepayTerm}
          onOpen={() => setAnnualPrepayOpen(true)}
          onSendInvoice={() => setAnnualPrepayInvoiceOpen(true)}
        />
      )}
      {embedded ? (
        <div className="c360-invoices-heading">
          <SectionTitle>Recent invoices ({invoices.length})</SectionTitle>
          <a
            className={buttonStyles({ variant: "secondary", density: "comfortable", className: "" })}
            href={`/admin/invoices?customerId=${encodeURIComponent(c.id)}`}
          >
            All invoices
          </a>
        </div>
      ) : (
        <SectionTitle>Invoices ({invoices.length})</SectionTitle>
      )}
      {invoices.length > 0 ? (
        <Table className="mb-5">

          <THead>

            <TR>

              {embedded && <TH>Invoice</TH>}
              <TH>Date</TH>
              <TH align="right">Amount</TH>
              <TH align="right">Paid</TH>
              <TH>Status</TH>
            </TR>
          </THead>
          <TBody>
            {invoices.map((inv, i) => (
              <TR key={i}>
                {embedded && (
                  <TD>
                    <a
                      className="c360-invoice-reference u-focus-ring"
                      href={`/admin/invoices?customerId=${encodeURIComponent(c.id)}&invoice=${encodeURIComponent(inv.id)}`}
                    >
                      #{inv.invoice_number || inv.id.slice(0, 8)}
                    </a>
                  </TD>
                )}
                <TD>{fmtDate(inv.created_at || inv.invoice_date)}</TD>
                <TD align="right" className="u-nums">
                  {fmtCurrency(inv.amount_due)}
                </TD>
                <TD align="right" className="u-nums">
                  {fmtCurrency(inv.amount_paid)}
                </TD>
                <TD>
                  {" "}
                  <Badge tone={invoiceStatusTone(inv)}>
                    {inv.status}
                  </Badge>{" "}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <div className="text-ui-body text-ink-secondary mb-5">No invoices</div>
      )}
      <SectionTitle>Payment History ({payments.length})</SectionTitle>
      {payments.slice(0, 10).map((p, i) => {
        const refundState = paymentRefundState(p);
        const isFailed = p.status === "failed";
        return (
          <div
            key={i}
            className="py-1.5 text-ui-label border-b border-hairline border-zinc-200/60 flex justify-between items-center gap-3"
          >
            {" "}
            <span
              className={cn(
                "u-nums",
                refundState.full ? "text-ink-secondary" : "text-zinc-900",
              )}
            >
              {fmtCurrency(p.amount)}
            </span>{" "}
            <span className="text-ink-secondary">
              {p.card_brand} …{p.last_four}
            </span>{" "}
            <span className="text-ink-secondary">
              {fmtDateOnly(p.payment_date)}
            </span>{" "}
            <Badge
              tone={
                refundState.full || refundState.partial || isFailed
                  ? "alert"
                  : "neutral"
              }
            >
              {refundState.full
                ? "Refunded"
                : refundState.partial
                  ? "Partial refund"
                  : (p.status || "").toUpperCase()}
            </Badge>
            {isAdmin &&
              p.processor === "stripe" &&
              p.status === "paid" &&
              !refundState.full &&
              refundState.remainingCents > 0 && (
                <Button
                  size="sm"
                  variant="danger"
                  onClick={() => setRefundPayment(p)}
                >
                  Refund
                </Button>
              )}
          </div>
        );
      })}
      {cards.length > 0 && (
        <div className="mt-5">
          {" "}
          <SectionTitle>Cards on File ({cards.length})</SectionTitle>
          {cards.map((cd, i) => (
            <div
              key={i}
              className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 text-ui-body flex justify-between items-center"
            >
              {" "}
              <span className="text-zinc-900">
                {cd.card_brand} ending {cd.last_four}
              </span>
              {cd.exp_month && (
                <span className="u-nums text-ink-secondary">
                  {cd.exp_month}/{cd.exp_year}
                </span>
              )}
              {cd.is_default && (
                <Badge
                  tone={embedded ? "neutral" : "strong"}
                  className="c360-payment-method-default"
                >
                  Default
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}
      {isAdmin && (
        <div className="mt-5 px-3 py-2.5 border-hairline border-zinc-200 rounded-sm flex justify-between items-center gap-3">
          {" "}
          <div className="text-ui-label text-ink-secondary">
            Customer cancelling at the deposit stage? This voids the signup
            invoice, cancels visits, and refunds the deposit.
          </div>{" "}
          <Button
            size="sm"
            variant="danger"
            onClick={() => setCancelSignupOpen(true)}
          >
            Cancel signup…
          </Button>{" "}
        </div>
      )}
      {isAdmin && data.cancelPlanEnabled && (
        <div className="mt-3 px-3 py-2.5 border-hairline border-zinc-200 rounded-sm flex justify-between items-center gap-3">
          {" "}
          <div className="text-ui-label text-ink-secondary">
            Cancelling an active plan? Same engine the customer portal uses:
            pulls visits, stops billing, records the case, and confirms to the
            customer.
          </div>{" "}
          <Button
            size="sm"
            variant="danger"
            onClick={() => setCancelPlanOpen(true)}
          >
            Cancel plan…
          </Button>{" "}
        </div>
      )}
    </div>
  );
}

function CustomerProfileServices({
  expanded,
  services,
  initialScheduledServiceId,
  upcomingScheduled,
  photos,
}) {
  return (
    <details className="c360-service-records" open={expanded}>
      <summary>Service records, reports & photos</summary>{" "}
      <SectionTitle>Service History ({services.length})</SectionTitle>
      {services.length === 0 ? (
        <div className="text-ui-body text-ink-secondary">No service records</div>
      ) : (
        <div className="flex flex-col">
          {services.map((s, i) => (
            <ServiceRowV2
              key={i}
              service={s}
              initiallyExpanded={
                !!initialScheduledServiceId &&
                String(s.scheduled_service_id || "") ===
                  String(initialScheduledServiceId)
              }
            />
          ))}
        </div>
      )}
      {upcomingScheduled.length > 0 && (
        <div className="mt-5">
          {" "}
          <SectionTitle>
            Scheduled Services ({upcomingScheduled.length})
          </SectionTitle>
          {upcomingScheduled.map((s, i) => (
            <div
              key={i}
              className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 flex justify-between text-ui-body"
            >
              {" "}
              <span className="font-medium text-zinc-900">
                {s.service_type}
              </span>{" "}
              <span className="text-ink-secondary">
                {fmtDateOnly(s.scheduled_date)}
              </span>{" "}
              <span
                className={cn(
                  "text-ui-caption ui-label font-medium",
                  s.status === "confirmed"
                    ? "text-zinc-900"
                    : "text-ink-secondary",
                )}
              >
                {s.status}
              </span>{" "}
            </div>
          ))}
        </div>
      )}
      {photos.length > 0 && (
        <div className="mt-5">
          {" "}
          <SectionTitle>Service Photos ({photos.length})</SectionTitle>{" "}
          <div className="grid grid-cols-[repeat(auto-fill,minmax(100px,1fr))] gap-2">
            {photos.map((p, i) => (
              <div
                key={i}
                className="rounded-sm overflow-hidden bg-zinc-50 border-hairline border-zinc-200 aspect-square"
              >
                {" "}
                <img
                  src={p.url || ""}
                  alt={p.caption || ""}
                  className="w-full h-full object-cover"
                  onError={(e) => {
                    e.target.style.display = "none";
                  }}
                />{" "}
              </div>
            ))}
          </div>{" "}
        </div>
      )}
    </details>
  );
}

function CustomerProfileProperty({
  embedded,
  recipientDetails,
  isAdmin,
  customerId,
  c,
  profileVersion,
  reloadCustomer,
  prefs,
}) {
  return (
    <div className="c360-details-content">
      {embedded && recipientDetails}
      {embedded && isAdmin && (
        <details className="c360-service-records">
          <summary>Property service tools & historical maps</summary>
          <PropertyZonesPanel customerId={customerId} />
          <TermiteStationsGate customerId={customerId} />
        </details>
      )}
      {/* Admin-only: GET /admin/customers/:id/properties is requireAdmin
                  (it lists every address on the account), so a technician
                  token would only ever see a 403 card here. */}
      {isAdmin && (
        <CustomerPropertiesPanelV2
          key={customerId}
          customerId={customerId}
          primaryAddress={c.address}
          contactRole={c.contactRole}
          // Every profile reload (any Edit save, address changed or
          // not) re-syncs the primary customer_properties row server-side
          // — refetch on the reload counter, never on the address tuple.
          refreshToken={profileVersion}
          onChanged={reloadCustomer}
          canEdit
        />
      )}
      {(c.satelliteUrl || c.address?.line1) && (
        <div className="mb-5 rounded-md overflow-hidden border-hairline border-zinc-200 max-h-[200px]">
          {c.satelliteUrl ? (
            <img
              src={c.satelliteUrl}
              alt="Satellite view"
              className="w-full h-[200px] object-cover"
              onError={(e) => {
                e.target.style.display = "none";
              }}
            />
          ) : (
            <a
              href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(formatAddress(c.address))}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block p-5 bg-zinc-50 text-center text-ui-body text-zinc-900 hover:bg-zinc-100 u-focus-ring"
            >
              View on Google Maps
            </a>
          )}
        </div>
      )}
      <div className="c360-property-grid grid grid-cols-2 gap-5">
        {" "}
        <div>
          {" "}
          <SectionTitle>Property Details</SectionTitle>
          {[
            ["Type", c.property?.type],
            ["Lawn Type", c.property?.lawnType],
            [
              "Property Sqft",
              c.property?.sqft
                ? `${parseInt(c.property.sqft).toLocaleString()} sqft`
                : null,
            ],
            [
              "Lot Sqft",
              c.property?.lotSqft
                ? `${parseInt(c.property.lotSqft).toLocaleString()} sqft`
                : null,
            ],
            ["Palm Count", c.property?.palmCount],
            ["Pool", prefs.has_pool ? "Yes" : null],
            ["Irrigation", prefs.has_irrigation ? "Yes" : null],
          ].map(
            ([label, val]) =>
              val && (
                <div
                  key={label}
                  className="flex justify-between py-1 text-ui-label border-b border-hairline border-zinc-200/60"
                >
                  {" "}
                  <span className="text-ink-secondary">{label}</span>{" "}
                  <span className="text-zinc-900 u-nums">{val}</span>{" "}
                </div>
              ),
          )}
        </div>{" "}
        <div>
          {" "}
          <SectionTitle>Access &amp; Preferences</SectionTitle>
          {[
            ["Property Gate Code", prefs.property_gate_code],
            ["Neighborhood Gate", prefs.neighborhood_gate_code],
            ["Parking Instructions", prefs.parking_instructions],
            ["Interior Access", prefs.interior_access_instructions],
            ["Pet Details", prefs.pet_details],
            ["Chemical Sensitivities", prefs.chemical_sensitivities],
            ["Preferred Time", prefs.preferred_service_time],
            ["Preferred Tech", prefs.preferred_technician],
            ["Special Instructions", prefs.special_instructions],
          ].map(
            ([label, val]) =>
              val && (
                <div
                  key={label}
                  className="flex justify-between py-1 text-ui-label border-b border-hairline border-zinc-200/60 gap-2"
                >
                  {" "}
                  <span className="text-ink-secondary flex-shrink-0">
                    {label}
                  </span>{" "}
                  <span className="text-zinc-900 text-right max-w-[200px] break-words">
                    {val}
                  </span>{" "}
                </div>
              ),
          )}
        </div>{" "}
      </div>{" "}
    </div>
  );
}

function CustomerProfileCompliance({
  showLawnData,
  compliance,
  nutrientSummary,
  nutrientLedger,
  nutrientRows,
}) {
  return (
    <div>
      {" "}
      {showLawnData && (
        <>
          <SectionTitle>Nutrient Ledger YTD</SectionTitle>{" "}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
            {" "}
            <Card>
              {" "}
              <CardBody className="p-4">
                {" "}
                <div className="text-ui-caption ui-label text-ink-secondary mb-1">
                  Nitrogen
                </div>{" "}
                <div className="u-nums text-22 font-medium text-zinc-900">
                  {fmtNumber(nutrientSummary.nApplied)}
                </div>{" "}
                <div className="text-ui-caption text-ink-secondary">
                  lb N / 1k sqft
                </div>{" "}
              </CardBody>{" "}
            </Card>{" "}
            <Card>
              {" "}
              <CardBody className="p-4">
                {" "}
                <div className="text-ui-caption ui-label text-ink-secondary mb-1">
                  Phosphorus
                </div>{" "}
                <div className="u-nums text-22 font-medium text-zinc-900">
                  {fmtNumber(nutrientSummary.pApplied)}
                </div>{" "}
                <div className="text-ui-caption text-ink-secondary">
                  lb P / 1k sqft
                </div>{" "}
              </CardBody>{" "}
            </Card>{" "}
            <Card>
              {" "}
              <CardBody className="p-4">
                {" "}
                <div className="text-ui-caption ui-label text-ink-secondary mb-1">
                  Potassium
                </div>{" "}
                <div className="u-nums text-22 font-medium text-zinc-900">
                  {fmtNumber(nutrientSummary.kApplied)}
                </div>{" "}
                <div className="text-ui-caption text-ink-secondary">
                  lb K / 1k sqft
                </div>{" "}
              </CardBody>{" "}
            </Card>{" "}
            <Card>
              {" "}
              <CardBody className="p-4">
                {" "}
                <div className="text-ui-caption ui-label text-ink-secondary mb-1">
                  Entries
                </div>{" "}
                <div className="u-nums text-22 font-medium text-zinc-900">
                  {nutrientSummary.entries || 0}
                </div>{" "}
                <div className="text-ui-caption text-ink-secondary">
                  {nutrientLedger.year || new Date().getFullYear()}
                </div>{" "}
              </CardBody>{" "}
            </Card>{" "}
          </div>
          {nutrientRows.length > 0 && (
            <Table className="mb-5">

              <THead>

                <TR>

                  <TH>Date</TH>
                  <TH>Product</TH>
                  <TH>Analysis</TH>
                  <TH>N/P/K per 1k</TH>
                  <TH>Blackout</TH>
                </TR>
              </THead>
              <TBody>
                {nutrientRows.map((r) => (
                  <TR key={r.id}>

                    <TD>{fmtDate(r.application_date)}</TD>
                    <TD className="text-zinc-900">{r.product_name}</TD>
                    <TD className="u-nums">{r.analysis || "—"}</TD>
                    <TD className="u-nums">
                      {fmtNumber(r.n_applied_per_1000)} /{" "}
                      {fmtNumber(r.p_applied_per_1000)} /{" "}
                      {fmtNumber(r.k_applied_per_1000)}
                    </TD>
                    <TD>{r.blackout_status || "—"}</TD>
                  </TR>
                ))}
              </TBody>
            </Table>
          )}
        </>
      )}
      <SectionTitle>Application History ({compliance.length})</SectionTitle>
      {compliance.length > 0 ? (
        <Table className="mb-5">

          <THead>

            <TR>

              <TH>Date</TH>
              <TH>Product</TH>
              <TH>Rate</TH>
              <TH>Area</TH>
              <TH>Technician</TH>
            </TR>
          </THead>
          <TBody>
            {compliance.map((r, i) => (
              <TR key={i}>

                <TD>{fmtDate(r.applied_at)}</TD>
                <TD className="text-zinc-900">
                  {r.product_name || r.product_id}
                </TD>
                <TD className="u-nums">
                  {r.rate_per_1000_sqft
                    ? `${r.rate_per_1000_sqft}/1k sqft`
                    : "—"}
                </TD>
                <TD>{r.area_treated || "—"}</TD>
                <TD>{r.technician_name || "—"}</TD>
              </TR>
            ))}
          </TBody>
        </Table>
      ) : (
        <div className="text-ui-body text-ink-secondary">No application records</div>
      )}
      {showLawnData && (
        <Card className="mt-5">
          {" "}
          <CardBody className="p-4">
            {" "}
            <SectionTitle>Product usage</SectionTitle>{" "}
            <div className="text-ui-label text-ink-secondary space-y-1">
              {" "}
              <div>
                Celsius entries in the history shown:{" "}
                <span className="u-nums text-zinc-900">
                  {
                    compliance.filter((r) =>
                      (r.product_name || "").toLowerCase().includes("celsius"),
                    ).length
                  }
                </span>
              </div>{" "}
              <div>
                Total nitrogen applied YTD:{" "}
                <span className="u-nums text-zinc-900">
                  {fmtNumber(nutrientSummary.nApplied)}
                </span>
                lb N / 1k sqft
              </div>{" "}
            </div>{" "}
          </CardBody>{" "}
        </Card>
      )}
    </div>
  );
}

function CustomerProfileTimeline({
  isAdmin,
  timelineError,
  filteredTimeline,
  setTimelineFilter,
  timelineFilter,
  retryTimeline,
  timelineRetrying,
}) {
  return (
    isAdmin && (
      <div className="border-t border-hairline border-zinc-200 px-6 py-4 bg-zinc-50">
        {" "}
        <div className="flex justify-between items-center mb-2.5 flex-wrap gap-2">
          {" "}
          <SectionTitle className="mb-0">
            Timeline{!timelineError && ` (${filteredTimeline.length})`}
          </SectionTitle>{" "}
          <div className="flex gap-1 flex-wrap">
            {[
              {
                key: "all",
                label: "All",
              },
              {
                key: "sms",
                label: "SMS",
              },
              {
                key: "call",
                label: "Calls",
              },
              {
                key: "service",
                label: "Services",
              },
              {
                key: "payment",
                label: "Payments",
              },
              {
                key: "notes",
                label: "Notes",
              },
            ].map((f) => (
              <button data-ui-text-action
                key={f.key}
                onClick={() => setTimelineFilter(f.key)}
                disabled={timelineError}
                className={cn(
                  "h-6 px-2.5 text-ui-caption ui-label font-medium rounded-xs border-hairline u-focus-ring transition-colors",
                  timelineFilter === f.key
                    ? "bg-zinc-900 text-white border-zinc-900"
                    : "bg-white text-ink-secondary border-zinc-200 hover:bg-zinc-100",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>{" "}
        </div>{" "}
        {/* On mobile the timeline grows inline (panel handles the scroll) so
              a nested 250px scroll region doesn't trap touch; capped on desktop. */}
        <div className="md:max-h-[250px] md:overflow-y-auto flex flex-col">
          {filteredTimeline.slice(0, 30).map((item, i) => {
            const TYPE_LABEL = {
              sms: "SMS",
              call: "CALL",
              service: "SVC",
              payment: "PAY",
              review: "REV",
              scheduled_service: "SCHED",
              interaction: "NOTE",
              activity: "ACT",
            };
            return (
              <div
                key={i}
                className="flex gap-2.5 py-1.5 border-b border-hairline border-zinc-200/60 text-ui-label items-center"
              >
                {" "}
                <Badge tone="neutral">
                  {TYPE_LABEL[item.type] || "EVT"}
                </Badge>{" "}
                <div className="flex-1 min-w-0">
                  {" "}
                  <span className="font-medium text-zinc-900">
                    {item.title}
                  </span>
                  {item.description && (
                    <span className="text-ink-secondary ml-1.5">
                      {item.description.substring(0, 80)}
                    </span>
                  )}
                </div>{" "}
                <span className="text-ink-secondary text-ui-caption u-nums flex-shrink-0">
                  {timeAgo(item.date)}
                </span>{" "}
              </div>
            );
          })}
          {timelineError && (
            <div className="flex flex-col items-center gap-3 py-4">
              <p role="alert" className="text-14 text-alert-fg">
                Could not load customer history.
              </p>
              <Button
                variant="secondary"
                aria-label="Retry customer history"
                onClick={retryTimeline}
                disabled={timelineRetrying}
              >
                {timelineRetrying ? "Retrying…" : "Retry"}
              </Button>
            </div>
          )}
          {!timelineError && filteredTimeline.length === 0 && (
            <div className="text-ink-secondary text-ui-label text-center py-4">
              No timeline events
            </div>
          )}
        </div>{" "}
      </div>
    )
  );
}

function CustomerProfileMobileActions({
  onClose,
  c,
  isAdmin,
  openIntelligenceBar,
  openEditModal,
  menuRef,
  menuButtonRef,
  setMenuOpen,
  menuOpen,
  setAnnualPrepayInvoiceOpen,
  setAnnualPrepayOpen,
  setActiveTab,
  customerId,
}) {
  return (
    <>
      {/* Mobile sticky action bar (mirrors desktop pills) */}
      {/* Mobile top action bar — rendered here as a sibling of the scrolling
          .c360-panel (NOT inside it), exactly like the fixed bottom
          CustomerActionBar below. iOS WebKit only honors position:fixed when
          the element is NOT nested inside an overflow-scroll ancestor; #2125
          set position:fixed but left this row inside .c360-panel, so on iOS
          the Back / Text / Call / ⋯ row still scrolled out of reach and
          wasn't tappable (it worked in desktop Chrome, which is why it
          slipped through). Shown/hidden at the <=768px boundary via the
          .c360-mobile-actionbar rule in the panel's <style> block (no
          Tailwind md:hidden, which would blank it at exactly 768px / iPad
          portrait). stopPropagation so taps on the bar (esp. the ⋯ menu)
          don't bubble to the overlay's close handler. */}
      <div
        className="c360-mobile-actionbar fixed left-0 right-0 z-[1001] items-center justify-between gap-2 px-4 pb-2 bg-white/95 backdrop-blur border-b border-hairline border-zinc-200"
        onClick={(e) => e.stopPropagation()}
        style={{
          // Track the Safari-bookmark visual viewport (keyboard / URL bar)
          // like the AdminLayoutV2 header; 0px until the shell sets the var.
          top: "var(--vv-offset-top, 0px)",
          paddingTop: "calc(0.5rem + env(safe-area-inset-top, 0px))",
        }}
      >
        {" "}
        <button data-ui-text-action
          onClick={onClose}
          aria-label="Back"
          className="inline-flex items-center justify-center h-11 w-11 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 u-focus-ring"
        >
          {" "}
          <ChevronLeft size={18} strokeWidth={1.75} />{" "}
        </button>{" "}
        <div className="flex items-center gap-2">
          {isAdmin && openIntelligenceBar && (
            <button type="button" aria-label="Open Intelligence Bar for this customer" onClick={openIntelligenceBar}
              className="inline-flex items-center justify-center h-11 w-11 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 u-focus-ring">
              <Sparkles size={18} strokeWidth={1.75} />
            </button>
          )}
          {c.phone && (
            <a
              href={`/admin/communications?phone=${encodeURIComponent(c.phone)}&action=sms`}
              className="inline-flex items-center h-11 px-3.5 text-ui-caption ui-label font-medium rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 no-underline u-focus-ring"
            >
              Text
            </a>
          )}
          {c.phone && (
            <CallBridgeLink
              phone={c.phone}
              customerName={`${c.firstName || ""} ${c.lastName || ""}`.trim()}
              styledButton
              className="inline-flex items-center h-11 px-3.5 text-ui-caption ui-label font-medium rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 no-underline u-focus-ring"
            >
              Call
            </CallBridgeLink>
          )}
          {isAdmin && (
            <button data-ui-text-action
              onClick={openEditModal}
              className="inline-flex items-center h-11 px-3.5 text-ui-caption ui-label font-medium rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 u-focus-ring"
            >
              Edit
            </button>
          )}
          <div ref={menuRef} className="relative">
            {" "}
            <button data-ui-text-action
              ref={menuButtonRef}
              onClick={() => setMenuOpen((v) => !v)}
              aria-label="More"
              aria-expanded={menuOpen}
              className="inline-flex items-center justify-center h-11 w-11 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 u-focus-ring"
            >
              {" "}
              <MoreHorizontal size={18} strokeWidth={1.75} />{" "}
            </button>
            {menuOpen && (
              <div
                role="menu"
                className="absolute right-0 top-[calc(100%+4px)] z-20 min-w-[180px] rounded-sm border-hairline border-zinc-300 bg-white shadow-md py-1"
              >
                {isAdmin && (
                  <button data-ui-text-action
                    role="menuitem"
                    onClick={() => {
                      menuButtonRef.current?.focus();
                      openEditModal();
                      setMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-ui-body text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                  >
                    Edit customer
                  </button>
                )}
                {isAdmin && (
                  <button data-ui-text-action
                    role="menuitem"
                    onClick={() => {
                      menuButtonRef.current?.focus();
                      setAnnualPrepayInvoiceOpen(true);
                      setMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-ui-body text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                  >
                    Send prepay invoice
                  </button>
                )}
                {isAdmin && (
                  <button data-ui-text-action
                    role="menuitem"
                    onClick={() => {
                      menuButtonRef.current?.focus();
                      setAnnualPrepayOpen(true);
                      setMenuOpen(false);
                    }}
                    className="w-full text-left px-3 py-2 text-ui-body text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                  >
                    Record collected prepay
                  </button>
                )}
                <button data-ui-text-action
                  role="menuitem"
                  onClick={() => {
                    setActiveTab("comms");
                    setMenuOpen(false);
                  }}
                  className="w-full text-left px-3 py-2 text-ui-body text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                >
                  Add note
                </button>{" "}
              </div>
            )}
          </div>{" "}
        </div>{" "}
      </div>{" "}
      <CustomerActionBar
        customer={{
          id: customerId,
          phone: c.phone,
          email: c.email,
          firstName: c.firstName,
          lastName: c.lastName,
          address: c.address
            ? [
                c.address.line1,
                c.address.line2,
                c.address.city,
                c.address.state,
                c.address.zip,
              ]
                .filter(Boolean)
                .join(", ")
            : "",
        }}
        standalone
      />
    </>
  );
}

function CustomerProfileEditor({
  editOpen,
  savingEdit,
  setEditOpen,
  editModalRef,
  editForm,
  setEditForm,
  editAddressRef,
  editErr,
  deletingCustomer,
  setDeletingCustomer,
  setEditErr,
  customerId,
  onClose,
  setSavingEdit,
  initialEditForm,
  reloadCustomer,
}) {
  const density = useUiDensity();
  return (
    editOpen && (
      <div
        className="fixed inset-0 bg-black/70 z-[1100] flex items-start sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
        onClick={(e) => {
          e.stopPropagation();
          if (!savingEdit) setEditOpen(false);
        }}
      >
        {" "}
        <div
          ref={editModalRef}
          role="dialog"
          aria-modal="true"
          aria-label="Edit customer"
          className="bg-white w-full min-h-full sm:min-h-0 max-w-none sm:max-w-[560px] rounded-none sm:rounded-sm border-hairline border-zinc-300 my-0 sm:my-4 box-border pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]"
          onClick={(e) => e.stopPropagation()}
        >
          {" "}
          <div className="flex items-center justify-between px-4 py-3 border-b border-hairline border-zinc-200">
            {" "}
            <div className="text-15 font-medium text-zinc-900">
              Edit customer
            </div>{" "}
            <button data-ui-text-action
              onClick={() => !savingEdit && setEditOpen(false)}
              aria-label="Close"
              className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring"
            >
              ×
            </button>{" "}
          </div>{" "}
          <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
            {[
              { key: "firstName", label: "First name" },
              { key: "lastName", label: "Last name" },
              { key: "email", label: "Email", type: "email" },
              { key: "phone", label: "Phone", type: "tel" },
              { key: "profileLabel", label: "Property label", full: true },
              { key: "addressLine1", label: "Address", full: true },
              { key: "addressLine2", label: "Address line 2", full: true },
              { key: "city", label: "City" },
              { key: "state", label: "State" },
              { key: "zip", label: "ZIP" },
              { key: "monthlyRate", label: "Monthly rate", type: "number" },
            ].map((f) => (
              <div key={f.key} className={f.full ? "sm:col-span-2" : ""}>
                {" "}
                <label htmlFor={`customer-edit-${f.key}`} className="ui-label text-ink-secondary block mb-1">
                  {f.label}
                </label>{" "}
                {f.key === "addressLine1" ? (
                  <AddressAutocomplete
                    id="customer-edit-addressLine1"
                    aria-label="Address"
                    enabled={
                      import.meta.env.VITE_GATE_ADMIN_ADDRESS_AUTOCOMPLETE ===
                      "true"
                    }
                    appearance="admin"
                    geocodeOnBlur={false}
                    placeholder="Start typing an address…"
                    value={editForm.addressLine1}
                    onChange={(value) =>
                      setEditForm((p) => ({ ...p, addressLine1: value }))
                    }
                    onSelect={(parts) => {
                      const previous = editAddressRef.current;
                      editAddressRef.current = {
                        line1: parts.line1 || editForm.addressLine1,
                        city: parts.city || editForm.city,
                        state: parts.state || editForm.state,
                        zip: parts.zip || editForm.zip,
                      };
                      setEditForm((p) => ({
                        ...p,
                        addressLine1: parts.line1 || p.addressLine1,
                        addressLine2:
                          parts.line2 ||
                          (!previous || sameAutocompleteAddress(previous, parts)
                            ? p.addressLine2
                            : ""),
                        city: parts.city || p.city,
                        state: parts.state || p.state,
                        zip: parts.zip || p.zip,
                      }));
                      document
                        .getElementById("customer-edit-addressLine2")
                        ?.focus();
                    }}
                    className={inputStyles({ density, className: "w-full h-10 px-2.5 text-16 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring" })}
                  />
                ) : (
                  <Input
                    id={`customer-edit-${f.key}`}
                    aria-label={f.label}
                    type={f.type || "text"}
                    value={editForm[f.key] ?? ""}
                    onChange={(e) =>
                      setEditForm((p) => ({ ...p, [f.key]: e.target.value }))
                    }
                    className="w-full h-9 px-2.5 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
                  />
                )}{" "}
              </div>
            ))}
            <div>
              {" "}
              <label htmlFor="c360-edit-tier" className="ui-label text-ink-secondary block mb-1">
                Tier
              </label>{" "}
              <Select id="c360-edit-tier"
                value={editForm.tier || ""}
                onChange={(e) =>
                  setEditForm((p) => ({ ...p, tier: e.target.value }))
                }
                className="w-full h-9 px-2 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
              >
                {" "}
                <option value="">No Plan</option>{" "}
                <option value="Platinum">Platinum</option>{" "}
                <option value="Gold">Gold</option>{" "}
                <option value="Silver">Silver</option>{" "}
                <option value="Bronze">Bronze</option>{" "}
                <option value="One-Time">One-Time</option>{" "}
              </Select>{" "}
            </div>{" "}
            <div>
              {" "}
              <label
                className="ui-label text-ink-secondary block mb-1"
                htmlFor="c360-edit-contact-role"
              >
                Contact role
              </label>{" "}
              <Select
                id="c360-edit-contact-role"
                value={editForm.contactRole || ""}
                onChange={(e) =>
                  setEditForm((p) => ({ ...p, contactRole: e.target.value }))
                }
                className="w-full h-9 px-2 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
              >
                {CONTACT_ROLE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>{" "}
            </div>{" "}
            <div>
              {" "}
              <label htmlFor="c360-edit-stage" className="ui-label text-ink-secondary block mb-1">
                Stage
              </label>{" "}
              <Select id="c360-edit-stage"
                value={editForm.pipelineStage || ""}
                onChange={(e) =>
                  setEditForm((p) => ({
                    ...p,
                    pipelineStage: e.target.value,
                  }))
                }
                className="w-full h-9 px-2 text-ui-body text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
              >
                {Object.entries(STAGE_LABELS).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </Select>{" "}
            </div>{" "}
          </div>
          {editErr && (
            <div className="mx-4 mb-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-ui-label">
              {editErr}
            </div>
          )}
          <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-hairline border-zinc-200">
            {" "}
            <button data-ui-text-action
              type="button"
              onClick={async () => {
                if (deletingCustomer || savingEdit) return;
                const name =
                  [editForm.firstName, editForm.lastName]
                    .filter(Boolean)
                    .join(" ")
                    .trim() || "this customer";
                const ok = window.confirm(
                  `Delete ${name}?\n\nThis removes them from the active customer list. Their history (services, invoices, payments) is preserved and can be restored.`,
                );
                if (!ok) return;
                setDeletingCustomer(true);
                setEditErr("");
                try {
                  await adminFetch(`/admin/customers/${customerId}`, {
                    method: "DELETE",
                  });
                  setEditOpen(false);
                  onClose?.();
                } catch (e) {
                  setEditErr(e.message || "Delete failed");
                }
                setDeletingCustomer(false);
              }}
              disabled={deletingCustomer || savingEdit}
              aria-label="Delete customer"
              title="Delete this customer (soft-delete, restorable)"
              className="inline-flex items-center justify-center h-9 w-9 border-hairline border-alert-fg/60 rounded-sm text-alert-fg bg-white hover:bg-alert-bg disabled:opacity-50 disabled:cursor-not-allowed u-focus-ring"
            >
              {" "}
              <Trash2 size={16} strokeWidth={1.75} />{" "}
            </button>{" "}
            <div className="flex gap-2">
              {" "}
              <Button
                variant="secondary"
                onClick={() => setEditOpen(false)}
                disabled={savingEdit || deletingCustomer}
              >
                Cancel
              </Button>{" "}
              <Button
                onClick={async () => {
                  setSavingEdit(true);
                  setEditErr("");
                  try {
                    // Keep address resaves for the server's mirror repair, but
                    // don't re-submit unchanged contacts or billing settings:
                    // legacy shared contacts can block an unrelated city edit.
                    const addressFields = [
                      "addressLine1",
                      "addressLine2",
                      "city",
                      "state",
                      "zip",
                    ];
                    const payload = Object.fromEntries(
                      Object.entries(editForm).filter(
                        ([key, value]) =>
                          addressFields.includes(key) ||
                          value !== initialEditForm.current[key],
                      ),
                    );
                    if ("monthlyRate" in payload)
                      payload.monthlyRate =
                        payload.monthlyRate === ""
                          ? null
                          : parseFloat(payload.monthlyRate);
                    if ("tier" in payload) payload.tier = payload.tier || null;
                    if ("contactRole" in payload)
                      payload.contactRole = payload.contactRole || null;
                    await adminFetch(`/admin/customers/${customerId}`, {
                      method: "PUT",
                      body: JSON.stringify(payload),
                    });
                    await reloadCustomer();
                    setEditOpen(false);
                  } catch (e) {
                    setEditErr(e.body?.message || e.message || "Save failed");
                  }
                  setSavingEdit(false);
                }}
                disabled={savingEdit || deletingCustomer}
              >
                {savingEdit ? "Saving…" : "Save"}
              </Button>{" "}
            </div>{" "}
          </div>{" "}
        </div>{" "}
      </div>
    )
  );
}

function CustomerBillingPause({
  c,
  isAdmin,
  resumeBilling,
  resumingBilling,
  resumeBillingErr,
  resumeBillingNote,
}) {
  const copy =
    c.servicePauseReason === "autopay_final_failure"
      ? {
          reason: " — autopay failed three times",
          policy:
            "The pause clears on its own when a payment from this customer succeeds; clearing",
        }
      : {
          reason: "",
          policy:
            "This pause was set manually and only clears manually; clearing",
        };
  return (
    <>
      {" "}
      {c.servicePausedAt && (
        <div role="alert" className="mb-3 rounded border border-hairline p-2.5">
          <div className="text-ui-label font-medium text-alert-fg">
            {/* servicePausedOn is the ET calendar date; the raw
                            servicePausedAt timestamp would render in the
                            browser's timezone and land on the wrong day. */}
            Billing paused since{" "}
            {fmtDate(c.servicePausedOn || c.servicePausedAt)}
          </div>
          <div className="text-ui-label text-ink-secondary mt-0.5">
            Monthly dues are not being collected
            {copy.reason}. Visits are unaffected. {copy.policy} it removes this
            block only — other billing guards (autopay state, plan type, prepaid
            coverage) still apply — and the paused months are never back-billed.
          </div>
          {isAdmin && (
            <Button
              size="sm"
              variant="secondary"
              className="mt-2"
              onClick={resumeBilling}
              disabled={resumingBilling}
            >
              {resumingBilling ? "Clearing…" : "Clear billing pause"}
            </Button>
          )}
          {resumeBillingErr && (
            <div className="text-ui-label text-alert-fg mt-1">{resumeBillingErr}</div>
          )}
        </div>
      )}
      {/* Outside the banner: the pause is cleared by now, so the
                      banner is gone, but dues still will not run and that is
                      the whole reason someone clicked. */}
      {resumeBillingNote && (
        <div
          role="status"
          className="mb-3 rounded border border-hairline p-2.5 text-ui-label text-ink-secondary"
        >
          {resumeBillingNote}
        </div>
      )}
    </>
  );
}

function CustomerBillingSummary({
  embedded,
  c,
  isAdmin,
  resumeBilling,
  resumingBilling,
  resumeBillingErr,
  resumeBillingNote,
  balanceOwed,
  cards,
  payments,
  displayedAnnualPrepayTerm,
  setAnnualPrepayOpen,
  data,
  invoices,
}) {
  return (
    <div className="c360-overview-billing">
      {" "}
      <SectionTitle>
        {embedded ? "Billing status & prepay" : "Billing Summary"}
      </SectionTitle>{" "}
      <CustomerBillingPause
        c={c}
        isAdmin={isAdmin}
        resumeBilling={resumeBilling}
        resumingBilling={resumingBilling}
        resumeBillingErr={resumeBillingErr}
        resumeBillingNote={resumeBillingNote}
      />
      {!embedded && (
        <>
          <div className="grid grid-cols-2 gap-2 mb-3">
            {" "}
            <StatCardV2
              label="Open balance"
              value={fmtCurrency(balanceOwed)}
              alert={balanceOwed > 0}
            />{" "}
            <StatCardV2
              label="Lifetime Rev"
              value={fmtCurrency(c.lifetimeRevenue)}
            />{" "}
          </div>
          <div className="text-ui-label text-ink-secondary mb-1.5">
            {cards.length > 0
              ? `Card on file: ${cards[0].card_brand} ending ${cards[0].last_four}${cards.length > 1 ? ` · +${cards.length - 1} more` : ""}`
              : "No card on file"}
          </div>
          <div className="mb-3">
            <SectionTitle>Recent Transactions ({payments.length})</SectionTitle>
            {payments.length > 0 ? (
              payments.slice(0, 3).map((p, i) => {
                // Grey only FULLY refunded rows — a partial refund
                // still holds collected money (status stays 'paid') —
                // but flag partials with a chip so the gross amount
                // doesn't read as fully collected.
                const rowRefund = paymentRefundState(p);
                const isRefund = rowRefund.full;
                // Non-collected rows (upcoming/processing/failed) were
                // indistinguishable from paid ones, so the list read as
                // more collected revenue than Lifetime Rev counts.
                const isCollected = !p.status || p.status === "paid";
                return (
                  <div
                    key={i}
                    className="py-1 text-ui-label border-b border-hairline border-zinc-200/60 flex justify-between items-center gap-2"
                  >
                    {" "}
                    <span
                      className={cn(
                        "u-nums flex-shrink-0",
                        isRefund || !isCollected
                          ? "text-ink-secondary"
                          : "text-zinc-900",
                      )}
                    >
                      {fmtCurrency(p.amount)}
                    </span>{" "}
                    {(rowRefund.partial || (!isCollected && !isRefund)) && (
                      <span className="flex-shrink-0 rounded-sm border border-hairline border-zinc-300 bg-surface-sunken px-1 text-ui-caption text-ink-secondary uppercase">
                        {rowRefund.partial
                          ? `${fmtCurrency(rowRefund.refundedCents / 100)} refunded`
                          : p.status}
                      </span>
                    )}{" "}
                    <span className="text-ink-secondary truncate">
                      {p.card_brand
                        ? `${p.card_brand} …${p.last_four}`
                        : p.method || p.processor || ""}
                    </span>{" "}
                    <span className="text-ink-secondary flex-shrink-0">
                      {fmtDateOnly(p.payment_date)}
                    </span>{" "}
                  </div>
                );
              })
            ) : (
              <div className="text-ui-label text-ink-secondary">
                No transactions yet
              </div>
            )}
          </div>
        </>
      )}
      {displayedAnnualPrepayTerm && (
        <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5 mb-3">
          <div className="text-ui-label font-medium text-zinc-900">
            {displayedAnnualPrepayTerm.planLabel || "Annual Prepay"}
          </div>
          <div className="text-ui-caption text-ink-secondary mt-0.5">
            Term ends {fmtDate(displayedAnnualPrepayTerm.termEnd)}
            {" · "}
            {String(displayedAnnualPrepayTerm.status || "").replace(/_/g, " ")}
            {displayedAnnualPrepayTerm.lastScheduledServiceDate
              ? ` · last scheduled ${fmtDate(displayedAnnualPrepayTerm.lastScheduledServiceDate)}`
              : ""}
          </div>
          {displayedAnnualPrepayTerm.renewalDecision && (
            <div className="text-ui-caption text-ink-secondary mt-0.5">
              Decision:{" "}
              {displayedAnnualPrepayTerm.renewalDecision.replace("_", " ")}
            </div>
          )}
        </div>
      )}
      {isAdmin && !embedded && (
        <Button
          size="sm"
          onClick={() => setAnnualPrepayOpen(true)}
          className="mb-3"
        >
          Record prepay already collected
        </Button>
      )}
      {Array.isArray(data.prepaidPlans) && data.prepaidPlans.length > 0 && (
        <div className="mb-3">
          <SectionTitle>Prepaid Plans</SectionTitle>
          {data.prepaidPlans.map((plan) => {
            const active = plan.remainingVisits > 0;
            return (
              <div
                key={plan.seriesParentId}
                className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5 mb-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="text-ui-label font-medium text-zinc-900 truncate">
                    {plan.serviceType}
                    {plan.recurringPattern ? ` · ${plan.recurringPattern}` : ""}
                  </div>
                  <Badge tone={active ? "strong" : "neutral"}>
                    {active ? "Active" : "Used"}
                  </Badge>
                </div>
                <div className="text-ui-caption text-ink-secondary mt-1">
                  {plan.usedVisits} of {plan.paidVisits} used
                  {active ? ` · ${plan.remainingVisits} remaining` : ""}
                  {" · "}${plan.perVisitAmount.toFixed(2)}/visit
                </div>
                <div className="text-ui-caption text-ink-secondary mt-0.5">
                  Total ${plan.seriesTotal.toFixed(2)}
                  {plan.method ? ` · ${plan.method.replace(/_/g, " ")}` : ""}
                  {plan.nextVisitDate
                    ? ` · next ${fmtDate(plan.nextVisitDate)}`
                    : ""}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {!embedded && (
        <>
          <SectionTitle>Recent Invoices</SectionTitle>
          {invoices.slice(0, 3).map((inv, i) => (
            <div
              key={i}
              className="py-1 text-ui-label border-b border-hairline border-zinc-200/60 flex justify-between"
            >
              {" "}
              <span className="u-nums text-zinc-900">
                {fmtCurrency(inv.amount_due)}
              </span>{" "}
              <span
                className={cn(
                  "font-medium ui-label text-ui-caption",
                  INVOICE_STATUS_TEXT[invoiceStatusTone(inv)],
                )}
              >
                {inv.status}
              </span>{" "}
              <span className="text-ink-secondary">
                {fmtDate(inv.created_at)}
              </span>{" "}
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function CustomerPayerEditor({ c, isAdmin, payer }) {
  const {
    payerSaving,
    handlePayerSelect,
    payers,
    showNewPayer,
    newPayer,
    setNewPayer,
    newPayerError,
    saveNewPayer,
    newPayerSaving,
    setShowNewPayer,
    setNewPayerError,
    newPayerNotice,
  } = payer;
  return (
    <div className="px-3 py-3 mb-3 bg-zinc-50 border-hairline border-zinc-200 rounded-sm">
      <div className="text-ui-caption ui-label text-ink-tertiary mb-1">
        Default Bill-To (third-party payer)
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <Select
          aria-label="Default bill-to"
          value={c.payerId ? String(c.payerId) : ""}
          disabled={payerSaving || !isAdmin}
          onChange={(e) => handlePayerSelect(e.target.value)}
          className="h-9 px-3 text-ui-body bg-white border-hairline border-zinc-300 rounded-sm min-w-[16rem] disabled:bg-zinc-100"
        >
          <option value="">Customer pays (self)</option>
          {payers.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.display_name}
              {p.company_name && p.company_name !== p.display_name
                ? ` — ${p.company_name}`
                : ""}
            </option>
          ))}
          {isAdmin && <option value="__new__">＋ New payer…</option>}
        </Select>
        {payerSaving && (
          <span className="text-ui-label text-ink-tertiary">Saving…</span>
        )}
      </div>
      {showNewPayer && isAdmin && (
        <div className="mt-2 px-3 py-3 bg-white border-hairline border-zinc-300 rounded-sm max-w-md">
          <div className="text-ui-label font-medium text-zinc-900 mb-2">
            New payer
          </div>
          {[
            {
              key: "displayName",
              label: "Payer name *",
              type: "text",
              placeholder: "e.g. tenant, builder, or property manager name",
            },
            { key: "companyName", label: "Company (optional)", type: "text" },
            {
              key: "apEmail",
              label: "Invoice email (AP)",
              type: "email",
              placeholder: "Where this payer's invoices are emailed",
            },
            { key: "apPhone", label: "Phone (optional)", type: "tel" },
          ].map((field) => (
            <div key={field.key}>
              <label
                className={
                  field.key === "apEmail" ? "block mb-1" : "block mb-2"
                }
              >
                <span className="ui-label text-ink-tertiary block mb-1">
                  {field.label}
                </span>
                <Input
                  type={field.type}
                  value={newPayer[field.key]}
                  onChange={(e) =>
                    setNewPayer((p) => ({ ...p, [field.key]: e.target.value }))
                  }
                  placeholder={field.placeholder}
                  className="w-full h-9 px-3 text-ui-body bg-white border-hairline border-zinc-300 rounded-sm"
                />
              </label>
              {field.key === "apEmail" && (
                <div className="text-ui-label text-ink-secondary mb-2">
                  Without an email, invoices to this payer can’t be delivered
                  until one is added in Finance → Payers.
                </div>
              )}
            </div>
          ))}
          {newPayerError && (
            <div className="text-ui-label text-alert-fg mb-2">{newPayerError}</div>
          )}
          <div className="flex items-center gap-2">
            <button data-ui-text-action
              type="button"
              onClick={saveNewPayer}
              disabled={newPayerSaving || !newPayer.displayName.trim()}
              className="h-9 px-3 text-ui-body font-medium bg-zinc-900 text-white rounded-sm disabled:opacity-50"
            >
              {newPayerSaving ? "Saving…" : "Create & select"}
            </button>
            <button data-ui-text-action
              type="button"
              onClick={() => {
                setShowNewPayer(false);
                setNewPayerError("");
              }}
              className="h-9 px-3 text-ui-body text-ink-secondary border-hairline border-zinc-300 rounded-sm bg-white"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {newPayerNotice && (
        <div className="text-ui-label text-ink-secondary mt-1.5">
          {newPayerNotice}
        </div>
      )}
      <div className="text-ui-label text-ink-secondary mt-1.5">
        Routes every invoice for this account to a builder / property manager
        instead of the customer. A single job can override this on the
        appointment. Manage payers in Finance → Payers.
      </div>
    </div>
  );
}
function CustomerRecipientDetails({
  c,
  payer,
  recipientRoutesDiffer,
  isAdmin,
  recipientPrefsDraft,
  setRecipientPrefsDraft,
  saveRecipientPrefs,
  recipientPrefsSaving,
  recipientPrefsDirty,
  recipientPrefsErr,
  embedded,
  notificationPrefs,
  updateNotificationPrefs,
}) {
  return (
    <div className="mt-4">
      {" "}
      <SectionTitle>Contacts &amp; Recipients</SectionTitle>
      <p className="text-14 text-ink-secondary">
        Account contact: {[c.firstName, c.lastName].filter(Boolean).join(" ")}
        {c.email ? ` · ${c.email}` : " · No email on file"}
      </p>
      <details
        className="c360-recipient-overrides"
        open={recipientRoutesDiffer}
      >
        <summary>View routing & override recipients</summary>
        <CustomerPayerEditor c={c} isAdmin={isAdmin} payer={payer} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
          {[
            {
              label: "Account owner / payer",
              names: [
                [c.firstName, c.lastName].filter(Boolean).join(" "),
                c.companyName,
                "Customer",
              ],
              contacts: [c.email, "No email"],
            },
            {
              label: "On-location contact",
              names: [c.serviceContactName, "Primary customer"],
              contacts: [
                c.serviceContactEmail,
                c.serviceContactPhone,
                c.email,
                "No contact",
              ],
            },
            {
              label: "Invoice email",
              names: [
                recipientPrefsDraft.billingContactName,
                "Billing recipient",
              ],
              contacts: [recipientPrefsDraft.billingEmail, c.email, "No email"],
            },
          ].map(({ label, names, contacts }) => (
            <div
              key={label}
              className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm"
            >
              <div className="text-ui-caption ui-label text-ink-tertiary">
                {label}
              </div>
              <div className="text-ui-label font-medium text-zinc-900 mt-1">
                {names.find(Boolean)}
              </div>
              <div className="text-ui-label text-ink-secondary break-all">
                {contacts.find(Boolean)}
              </div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
          <label className="block">
            <span className="ui-label text-ink-tertiary block mb-1">
              Billing contact name
            </span>
            <Input
              id="c360-billing-contact-name"
              name="billingContactName"
              value={recipientPrefsDraft.billingContactName}
              disabled={!isAdmin || recipientPrefsSaving}
              onChange={(e) =>
                setRecipientPrefsDraft((prev) => ({
                  ...prev,
                  billingContactName: e.target.value,
                }))
              }
              placeholder="Landlord, AP contact, property manager"
              className="block w-full bg-white text-ui-body text-ink-primary border-hairline border-zinc-300 rounded-sm h-9 px-2.5 focus:outline-none focus:border-zinc-900"
            />
          </label>
          <label className="block">
            <span className="ui-label text-ink-tertiary block mb-1">
              Billing recipient email
            </span>
            <Input
              id="c360-billing-recipient-email"
              name="billingEmail"
              value={recipientPrefsDraft.billingEmail}
              disabled={!isAdmin || recipientPrefsSaving}
              onChange={(e) =>
                setRecipientPrefsDraft((prev) => ({
                  ...prev,
                  billingEmail: e.target.value,
                }))
              }
              type="email"
              placeholder={c.email || "billing@example.com"}
              className="block w-full bg-white text-ui-body text-ink-primary border-hairline border-zinc-300 rounded-sm h-9 px-2.5 focus:outline-none focus:border-zinc-900"
            />
          </label>
        </div>
        <div className="flex items-center justify-between gap-3 mb-3">
          <div className="text-ui-label text-ink-secondary">
            Invoices and receipts use the billing email when set. Appointment
            reminders and service reports use the on-location contact when
            present.
          </div>
          <Button
            onClick={saveRecipientPrefs}
            disabled={recipientPrefsSaving || !isAdmin || !recipientPrefsDirty}
            className="shrink-0"
          >
            {recipientPrefsSaving
              ? "Saving…"
              : recipientPrefsDirty
                ? "Save recipients"
                : "Recipients saved"}
          </Button>
        </div>
        {recipientPrefsErr && (
          <div className="mb-3 text-ui-label text-alert-fg">{recipientPrefsErr}</div>
        )}
        {!embedded &&
          [
            {
              id: "c360-appointment-notify-primary",
              name: "appointmentNotifyPrimary",
              key: "appointment_notify_primary",
              defaultOn: true,
              title: <>Also send appointment SMS to the account owner</>,
              description: (
                <>
                  On by default. On-location contacts receive appointment
                  reminders too. Turn this off only if the account owner should
                  stop receiving them.
                </>
              ),
            },
            {
              id: "c360-service-report-notify-primary",
              name: "serviceReportNotifyPrimary",
              key: "service_report_notify_primary",
              defaultOn: true,
              title: <>Also email service reports to the account owner</>,
              description: (
                <>
                  On by default. Turn this off only if the account owner should
                  stop receiving reports — a distinct service-contact email then
                  receives them instead.
                </>
              ),
            },
            {
              id: "c360-service-report-notify-billing",
              name: "serviceReportNotifyBilling",
              key: "service_report_notify_billing",
              defaultOn: false,
              title: <>Also email service reports to the billing recipient</>,
              description: (
                <>
                  Copies the billing recipient email (landlord, AP contact) on
                  post-service reports. Requires a billing recipient email
                  above; invoices are unaffected.
                </>
              ),
            },
            {
              id: "c360-auto-flip-en-route",
              name: "autoFlipEnRoute",
              key: "auto_flip_en_route",
              defaultOn: true,
              title: <>Auto-flip en route SMS</>,
              description: (
                <>
                  When the tech&apos;s vehicle leaves a previous job area and
                  the next job is this customer, fire the &quot;on the way&quot;
                  SMS automatically. Off here = customer keeps manual en-route
                  SMS but skips auto-flip.
                </>
              ),
            },
          ].map((field) => (
            <label
              key={field.key}
              className="flex items-start gap-2 px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 cursor-pointer"
            >
              <input
                id={field.id}
                name={field.name}
                type="checkbox"
                disabled={!isAdmin || recipientPrefsSaving}
                className="mt-0.5"
                checked={
                  field.defaultOn
                    ? notificationPrefs[field.key] !== false
                    : notificationPrefs[field.key] === true
                }
                onChange={(e) =>
                  updateNotificationPrefs({
                    [field.name]: e.target.checked,
                    [field.key]: e.target.checked,
                  })
                }
              />
              <div>
                <div className="text-ui-label font-medium text-zinc-900">
                  {field.title}
                </div>
                <div className="text-ui-label text-ink-secondary">
                  {field.description}
                </div>
              </div>
            </label>
          ))}
      </details>
    </div>
  );
}

function CustomerConversation({
  customerId,
  comms,
  commsLoading,
  commsErr,
  embedded,
  commsLoaded,
  c,
  commsComposerReady,
  isAdmin,
  messageOpen,
  linkRequest,
  commsReadScope,
  setCommsLoaded,
  reloadCustomer,
  retryTimeline,
  smsReply,
  setSmsReply,
  smsErr,
  setSmsErr,
  sendSms,
  sendingSms,
  recipientDetails,
  data,
}) {
  const interactions = data.interactions || [];
  return (
    <div className="c360-conversation flex flex-col">
      {" "}
      <OwedCommitmentsSummary customerId={customerId} />
      {!embedded && (
        <OwedCommitmentsSummary customerId={customerId} source="sms" />
      )}
      <SectionTitle>Thread ({comms.length})</SectionTitle>{" "}
      <div className="flex flex-col gap-1.5 mb-3">
        {commsLoading && (
          <div className="text-ink-secondary text-ui-body text-center py-5">
            Loading messages…
          </div>
        )}
        {commsErr && (
          <div className="text-alert-fg text-ui-body text-center py-5">
            {commsErr}
          </div>
        )}
        {[...comms].reverse().map((message, i) => {
          const Message =
            message.channel === "sms"
              ? CustomerSmsMessage
              : CustomerCallMessage;
          return (
            <Message
              key={message.id || i}
              message={message}
              embedded={embedded}
            />
          );
        })}
        {!commsLoading && !commsErr && commsLoaded && comms.length === 0 && (
          <div className="text-ink-secondary text-ui-body text-center py-5">
            No messages
          </div>
        )}
      </div>
      {embedded && c.phone && (commsComposerReady || !isAdmin) && (
        <Suspense
          fallback={
            <p className="py-3 text-14 text-ink-secondary">
              Loading message tools…
            </p>
          }
        >
          <CustomerSmsComposer
            key={`${c.id}:${c.phone}`}
            active={messageOpen}
            linkRequest={linkRequest}
            customer={c}
            customerMessages={comms}
            customerReadScope={commsReadScope}
            onSent={async () => {
              setCommsLoaded(false);
              // reloadCustomer refreshes the timeline with the record; a failed
              // refresh must not read as a failed send.
              try { await reloadCustomer(); } catch { /* the message was already sent */ }
            }}
          />
        </Suspense>
      )}
      {!embedded && c.phone && (
        <div className="py-3 border-t border-hairline border-zinc-200">
          {" "}
          <div className="flex gap-2">
            {" "}
            <Input
              id="c360-sms-reply"
              name="smsReply"
              value={smsReply}
              onChange={(e) => {
                setSmsReply(e.target.value);
                if (smsErr) setSmsErr("");
              }}
              placeholder="Type a message…"
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  sendSms();
                }
              }}
              className="flex-1 h-10 px-3.5 bg-white border-hairline border-zinc-300 rounded-sm text-ui-body text-zinc-900 u-focus-ring"
            />{" "}
            <Button onClick={sendSms} disabled={sendingSms || !smsReply.trim()}>
              {sendingSms ? "…" : "Send"}
            </Button>{" "}
          </div>
          {smsErr && (
            <div className="mt-1.5 text-ui-label text-alert-fg">{smsErr}</div>
          )}
        </div>
      )}
      {!embedded && recipientDetails}
      {!embedded && (
        <div className="mt-4">
          {" "}
          <SectionTitle>
            Notes &amp; Interactions ({interactions.length})
          </SectionTitle>
          {interactions.slice(0, 10).map((n, i) => (
            <div
              key={i}
              className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 text-ui-label"
            >
              {" "}
              <div className="flex justify-between mb-1">
                {" "}
                <span className="font-medium text-zinc-900">
                  {n.interaction_type}: {n.subject}
                </span>{" "}
                <span className="text-ink-secondary text-ui-caption">
                  {timeAgo(n.created_at)}
                </span>{" "}
              </div>
              {n.body && (
                <div className="text-ink-secondary">
                  {n.body.substring(0, 200)}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function CustomerProfileStyles() {
  return (
    <style>{`
          @media (max-width: 768px) {
            .c360-overview-grid { grid-template-columns: 1fr !important; }
            .c360-billing-grid { grid-template-columns: 1fr 1fr !important; }
            .c360-property-grid { grid-template-columns: 1fr !important; }
            .c360-panel { width: 100% !important; max-width: 100% !important; }
            .c360-header-desktop { display: none !important; }
            .c360-header-mobile { display: block !important; }
            .c360-mobile-actionbar { display: flex !important; }
            .c360-mobile-footer-spacer { display: block !important; }
          }
          .c360-header-mobile { display: none; }
          .c360-mobile-actionbar { display: none; }
          .c360-mobile-footer-spacer { display: none; }
        `}</style>
  );
}
function CustomerProfileActionError({ error }) {
  return (
    error && (
      <ActionFeedback
        error
        className="mb-4 px-3 py-2 text-14 text-alert-fg bg-red-50 border-hairline border-red-200 rounded-sm"
      >
        {error}
      </ActionFeedback>
    )
  );
}

// The record state remains in Customer360ProfileV2. These presentations own
// section membership and DOM placement, so opening a drawer never remounts it.
function CustomerWorkspacePresentation({
  panelRef,
  headerPast,
  headerProps,
  activeTab,
  tabsAnchorRef,
  profileContentId,
  workspaceSections,
  sections,
  messageOpened,
  messageOpen,
  setMessageOpen,
  hasLawnHistory,
  hasCompliance,
  profileActionErr,
  dialogs,
}) {
  const {
    c,
    isAdmin,
    unreadConversations,
    openEditModal,
    changeWorkspaceTab,
    openMessages,
    setLinkRequest,
    menuOpen,
    setMenuOpen,
    menuRef,
    customerId,
  } = headerProps;
  return (
    <UiSurface density="comfortable" className="c360-embedded">
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className={cn(
          "c360-panel bg-white w-full max-w-[900px] h-full flex flex-col overflow-y-auto text-zinc-900",
          headerPast && "c360-header-past",
        )}
      >
        <CustomerProfileStyles />
        <CustomerWorkspaceHeader
          c={c}
          isAdmin={isAdmin}
          unreadConversations={unreadConversations}
          onEdit={openEditModal}
          onTab={changeWorkspaceTab}
          onMessage={openMessages}
          onSendLink={() => {
            setLinkRequest((value) => value + 1);
            openMessages();
          }}
          menuOpen={menuOpen}
          setMenuOpen={setMenuOpen}
          menuRef={menuRef}
        />
        <CustomerWorkspaceNavigation
          tabsAnchorRef={tabsAnchorRef}
          c={c}
          activeTab={activeTab}
          changeWorkspaceTab={changeWorkspaceTab}
          profileContentId={profileContentId}
          workspaceSections={workspaceSections}
        />
        <div
          className="c360-tab-content p-6 flex-1"
          id={profileContentId}
          role="tabpanel"
          aria-label={
            CUSTOMER_WORKSPACE_SECTIONS.find(
              (section) => section.key === activeTab,
            )?.label
          }
        >
          <CustomerProfileActionError error={profileActionErr} />
          {activeTab === "overview" && sections.overview}
          {activeTab === "billing" && sections.billing}
          {messageOpened && (
            <Sheet
              open={messageOpen}
              keepMounted
              onClose={() => setMessageOpen(false)}
              width="lg"
              className="admin-shell-v2 c360-message-sheet"
              ariaLabel={`Conversation with ${c.firstName} ${c.lastName}`}
            >
              <SheetHeader>
                <div>
                  <strong>
                    {c.firstName} {c.lastName}
                  </strong>
                  <p className="text-14 text-ink-secondary">{c.phone}</p>
                </div>
                <Button
                  variant="secondary"
                  onClick={() => setMessageOpen(false)}
                >
                  Back to customer
                </Button>
              </SheetHeader>
              <SheetBody>{sections.conversation}</SheetBody>
            </Sheet>
          )}
          {activeTab === "comms" && (
            <>
              {/* Staff-wide, like the commitments API and its bells; only the history timeline stays admin-only. */}
              <OwedCommitmentsSummary customerId={customerId} source="sms" />
              {isAdmin && sections.activity}
              {sections.services}
            </>
          )}
          {activeTab === "property" && (
            <>
              {sections.property}
              {(hasLawnHistory || hasCompliance) && sections.compliance}
              {sections.contracts}
            </>
          )}
        </div>
      </div>
      {dialogs}
    </UiSurface>
  );
}

function CustomerOverlayPresentation({
  panelRef,
  activeTabButtonRef,
  headerProps,
  activeTab,
  profileContentId,
  sections,
  alerts,
  profileActionErr,
  actions,
  dialogs,
}) {
  const density = useUiDensity();
  const { onClose, setActiveTab } = headerProps;
  return createPortal(
    <div data-ui-density={density}
      className="admin-shell-v2 fixed inset-0 bg-black/70 z-[1000] flex justify-end font-sans"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="c360-panel bg-white w-full max-w-[900px] h-full flex flex-col overflow-y-auto text-zinc-900"
      >
        <CustomerProfileStyles />
        <CustomerOverlayHeader {...headerProps} />
        <CustomerProfileAlerts alerts={alerts} />
        <CustomerOverlayNavigation
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          activeTabButtonRef={activeTabButtonRef}
        />
        <div className="c360-tab-content p-6 flex-1" id={profileContentId}>
          <CustomerProfileActionError error={profileActionErr} />
          {activeTab === "overview" && sections.overview}
          {activeTab === "billing" && sections.billing}
          {activeTab === "comms" && sections.conversation}
          {activeTab === "services" && sections.services}
          {activeTab === "property" && sections.property}
          {activeTab === "compliance" && sections.compliance}
          {activeTab === "contracts" && sections.contracts}
        </div>
        {sections.timeline}
        <div
          className="c360-mobile-footer-spacer shrink-0"
          style={{
            height:
              "calc(56px + env(safe-area-inset-bottom, 0px) + var(--keyboard-inset, 0px))",
          }}
          aria-hidden="true"
        />
      </div>
      {actions}
      {dialogs}
    </div>,
    document.body,
  );
}

function useCustomerProfileRecord({ customerId, customerIdRef, isAdmin, lastMutation }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [profileLoadError, setProfileLoadError] = useState("");
  const [profileReloadKey, setProfileReloadKey] = useState(0);
  const [profileActionErr, setProfileActionErr] = useState("");
  const [timeline, setTimeline] = useState([]);
  const [timelineMissingSources, setTimelineMissingSources] = useState([]);
  const [timelineError, setTimelineError] = useState(false);
  const [timelineRetrying, setTimelineRetrying] = useState(false);
  const profileSeqRef = useRef(0);
  const profileAbortRef = useRef(null);
  // Bumped on every successful profile reload. The properties panel keys its
  // refetch on this, NOT on the address tuple: the PUT path re-syncs the
  // primary customer_properties row on PRESENCE of address fields (an
  // unchanged resave still self-heals a stale mirror), so a tuple-based
  // signal would leave the panel stale exactly when the server fixed it.
  const [profileVersion, setProfileVersion] = useState(0);
  // One abortable load shared by the mount/customer-change effect and every
  // in-place refresh: profile and timeline move together, so an Intelligence
  // Bar write cannot leave the history showing the pre-write record.
  const reloadCustomer = useCallback(async () => {
    if (customerIdRef.current !== customerId) return null;
    const seq = ++profileSeqRef.current;
    profileAbortRef.current?.abort();
    const ctrl = new AbortController();
    profileAbortRef.current = ctrl;
    setTimelineRetrying(false);
    try {
      const [detail, tl] = await Promise.all([
        adminFetch(`/admin/customers/${customerId}`, { signal: ctrl.signal }),
        isAdmin
          ? adminFetch(`/admin/customers/${customerId}/timeline`, {
              signal: ctrl.signal,
            }).catch((err) => {
              if (err.name === "AbortError") throw err;
              return null;
            })
          : Promise.resolve({ timeline: [] }),
      ]);
      if (ctrl.signal.aborted || seq !== profileSeqRef.current || customerIdRef.current !== customerId) return null;
      setData(detail);
      setProfileVersion((v) => v + 1);
      setProfileLoadError("");
      setTimeline(tl?.timeline || []);
      setTimelineMissingSources(tl?.missingSources || []);
      setTimelineError(tl === null);
      return detail;
    } catch (err) {
      if (ctrl.signal.aborted || seq !== profileSeqRef.current || customerIdRef.current !== customerId) return null;
      throw err;
    } finally {
      if (!ctrl.signal.aborted && seq === profileSeqRef.current && customerIdRef.current === customerId) setLoading(false);
    }
  }, [customerId, customerIdRef, isAdmin]);

  useEffect(() => {
    setLoading(true);
    setData(null);
    setProfileLoadError("");
    setTimelineRetrying(false);
    setProfileActionErr("");
    void reloadCustomer().catch((err) => {
      setProfileLoadError(err.message || "Failed to load customer");
    });
    return () => profileAbortRef.current?.abort();
  }, [profileReloadKey, reloadCustomer]);

  // An Intelligence Bar write against this customer refreshes the open record.
  useEffect(() => {
    if (lastMutation?.customer_id !== customerId) return;
    void reloadCustomer().catch(() => {
      if (customerIdRef.current === customerId) setProfileActionErr("The change was saved. Refresh this record to see it.");
    });
  }, [lastMutation, customerId, customerIdRef, reloadCustomer]);

  const retryTimeline = async () => {
    const seq = profileSeqRef.current;
    const signal = profileAbortRef.current.signal;
    setTimelineRetrying(true);
    try {
      const result = await adminFetch(
        `/admin/customers/${customerId}/timeline`,
        { signal },
      );
      if (signal.aborted || seq !== profileSeqRef.current) return;
      setTimeline(result.timeline || []);
      setTimelineMissingSources(result.missingSources || []);
      setTimelineError(false);
    } catch {
      // Keep the loaded profile and recovery action when history is still unavailable.
    } finally {
      if (!signal.aborted && seq === profileSeqRef.current)
        setTimelineRetrying(false);
    }
  };

  return {
    profileReloadKey,
    reloadCustomer,
    setProfileActionErr,
    loading:
      loading ||
      Boolean(
        data?.customer && String(data.customer.id) !== String(customerId),
      ),
    data,
    profileLoadError,
    setProfileReloadKey,
    setData,
    timeline,
    retryTimeline,
    profileVersion,
    timelineMissingSources,
    timelineError,
    timelineRetrying,
    profileActionErr,
  };
}

// Clearing a billing pause. billing-cron sets service_paused_at when
// autopay's 3-retry ladder exhausts and then skips that customer forever;
// nothing in the product could clear it before this, so the only remedy
// was editing the row by hand.
function useCustomerBillingPause({
  customerId,
  customerIdRef,
  reloadCustomer,
}) {
  // These three are shared component state, so switching customers has to
  // clear them: an in-flight resume for A whose response is discarded (see
  // stillViewing below) would otherwise leave B's Resume button stuck
  // disabled forever, and A's error/note reading as B's.
  const [resumingBilling, setResumingBilling] = useState(false);
  const [resumeBillingErr, setResumeBillingErr] = useState("");
  const [resumeBillingNote, setResumeBillingNote] = useState("");
  const resumeSeqRef = useRef(0);
  useEffect(() => {
    setResumingBilling(false);
    setResumeBillingErr("");
    setResumeBillingNote("");
  }, [customerId]);
  const resumeBilling = async () => {
    // Everything below writes shared component state, so pin THIS attempt:
    // an admin who starts a resume for A and switches to B must not see A's
    // outcome on B. A customerId check alone is not enough — going A → B → A
    // and clicking again would let the first, still-in-flight response land
    // on the second attempt's result. The sequence number makes each click
    // the only writer of its own outcome.
    resumeSeqRef.current += 1;
    const seq = resumeSeqRef.current;
    const forCustomerId = customerId;
    const stillViewing = () =>
      resumeSeqRef.current === seq &&
      String(customerIdRef.current) === String(forCustomerId);

    setResumingBilling(true);
    setResumeBillingErr("");
    setResumeBillingNote("");
    // Tracked separately from the try/catch because the profile reload below
    // must not be able to report itself as a failed resume: the money-moving
    // half already succeeded, and telling an admin otherwise invites a second
    // click on an action they believe did not happen.
    let resumeLanded = false;
    try {
      const result = await adminFetch(
        `/admin/customers/${forCustomerId}/resume-service`,
        { method: "POST" },
      );
      if (!stillViewing()) return;
      // The server deliberately refuses when the pause moved between its read
      // and its write (billing-cron re-paused, or another admin got there
      // first). Treating that as success would show a cleared banner that
      // reappears on the next load with no explanation.
      if (result?.resumed === false) {
        setResumeBillingErr(
          "The pause was not cleared — it changed while you were looking at it. Reloading the current state.",
        );
      } else {
        resumeLanded = true;
      }
    } catch (err) {
      if (!stillViewing()) return;
      setResumeBillingErr(err.message || "Could not clear the billing pause");
      setResumingBilling(false);
      return;
    }

    try {
      await reloadCustomer();
    } catch {
      if (stillViewing()) {
        setResumeBillingNote(
          resumeLanded
            ? "The billing pause was cleared. Refreshing this profile failed — reload the page to see the current state."
            : "Refreshing this profile failed — reload the page to see the current state.",
        );
      }
    } finally {
      if (stillViewing()) setResumingBilling(false);
    }
  };

  return {
    resumeBilling,
    resumingBilling,
    resumeBillingErr,
    resumeBillingNote,
  };
}

function useCustomerPayer({
  setProfileActionErr,
  customerId,
  reloadCustomer,
  isAdmin,
}) {
  const [payers, setPayers] = useState([]);
  const [payerSaving, setPayerSaving] = useState(false);
  // Inline "New payer" quick-add for the default Bill-To select.
  const [showNewPayer, setShowNewPayer] = useState(false);
  const [newPayer, setNewPayer] = useState({
    displayName: "",
    companyName: "",
    apEmail: "",
    apPhone: "",
  });
  const [newPayerSaving, setNewPayerSaving] = useState(false);
  const [newPayerError, setNewPayerError] = useState("");
  const [newPayerNotice, setNewPayerNotice] = useState("");
  useEffect(() => {
    adminFetch("/admin/payers")
      .then((r) => setPayers(Array.isArray(r?.payers) ? r.payers : []))
      .catch(() => setPayers([]));
  }, []);
  const savePayer = async (payerId) => {
    setPayerSaving(true);
    setProfileActionErr("");
    try {
      await adminFetch(`/admin/customers/${customerId}`, {
        method: "PUT",
        body: JSON.stringify({ payerId: payerId || "" }),
      });
      await reloadCustomer();
    } catch (err) {
      setProfileActionErr(err.message || "Bill-To failed to save");
    } finally {
      setPayerSaving(false);
    }
  };
  const handlePayerSelect = (value) => {
    if (!isAdmin) {
      setProfileActionErr("Admin access is required to change Bill-To.");
      return;
    }
    if (value === "__new__") {
      setNewPayerError("");
      setNewPayerNotice("");
      setShowNewPayer(true);
      return;
    }
    savePayer(value);
  };
  const saveNewPayer = async () => {
    const displayName = newPayer.displayName.trim();
    if (!displayName) {
      setNewPayerError("Payer name is required");
      return;
    }
    const apEmail = newPayer.apEmail.trim().toLowerCase();
    setNewPayerSaving(true);
    setNewPayerError("");
    try {
      // dedupeByEmail: the SERVER checks the AP email against every payer
      // (the loaded list is capped) and returns the existing active payer
      // with deduped:true instead of minting a duplicate — AR must not split
      // across payer rows.
      const r = await adminFetch("/admin/payers", {
        method: "POST",
        body: JSON.stringify({
          displayName,
          companyName: newPayer.companyName.trim() || undefined,
          apEmail: apEmail || undefined,
          apPhone: newPayer.apPhone.trim() || undefined,
          dedupeByEmail: true,
        }),
      });
      const created = r?.payer;
      if (created?.id) {
        setPayers((list) =>
          (list.some((p) => String(p.id) === String(created.id))
            ? list
            : [...list, created]
          ).sort((a, b) =>
            String(a.display_name || "").localeCompare(
              String(b.display_name || ""),
            ),
          ),
        );
        setShowNewPayer(false);
        setNewPayer({
          displayName: "",
          companyName: "",
          apEmail: "",
          apPhone: "",
        });
        setNewPayerNotice(
          r?.deduped
            ? `Matched existing payer "${created.display_name}" by AP email — selected it instead.`
            : "",
        );
        await savePayer(String(created.id));
      } else {
        setNewPayerError("Unexpected response — payer not created");
      }
    } catch (e) {
      setNewPayerError(e.message || "Failed to create payer");
    }
    setNewPayerSaving(false);
  };

  return {
    payerSaving,
    handlePayerSelect,
    payers,
    showNewPayer,
    newPayer,
    setNewPayer,
    newPayerError,
    saveNewPayer,
    newPayerSaving,
    setShowNewPayer,
    setNewPayerError,
    newPayerNotice,
  };
}

function useCustomerRecipientPreferences({
  data,
  isAdmin,
  setProfileActionErr,
  setData,
  customerId,
  customerIdRef,
}) {
  const [recipientPrefsDraft, setRecipientPrefsDraft] = useState({
    billingContactName: "",
    billingEmail: "",
  });
  const [recipientPrefsSaving, setRecipientPrefsSaving] = useState(false);
  const [recipientPrefsErr, setRecipientPrefsErr] = useState("");
  const preferenceWriteRef = useRef(false);
  const preferenceWriteSeqRef = useRef(0);
  useEffect(() => {
    preferenceWriteSeqRef.current += 1;
    preferenceWriteRef.current = false;
    setRecipientPrefsSaving(false);
  }, [customerId]);
  useEffect(() => {
    const prefs = data?.notificationPrefs || {};
    setRecipientPrefsDraft({
      billingContactName: prefs.billing_contact_name || "",
      billingEmail: prefs.billing_email || "",
    });
    setRecipientPrefsErr("");
  }, [
    data?.customer?.id,
    data?.notificationPrefs?.billing_contact_name,
    data?.notificationPrefs?.billing_email,
  ]);
  const updateNotificationPrefs = async (patch) => {
    if (!isAdmin) {
      setProfileActionErr(
        "Admin access is required to change notification routing.",
      );
      return;
    }
    if (preferenceWriteRef.current) return;
    preferenceWriteRef.current = true;
    const seq = ++preferenceWriteSeqRef.current;
    const forCustomerId = customerId;
    const stillViewing = () =>
      preferenceWriteSeqRef.current === seq &&
      String(customerIdRef.current) === String(forCustomerId);
    const previous = data.notificationPrefs || {};
    const patchKeys = Object.keys(patch);
    setRecipientPrefsSaving(true);
    setData((prev) =>
      String(prev?.customer?.id) === String(forCustomerId)
        ? {
            ...prev,
            notificationPrefs: {
              ...(prev.notificationPrefs || {}),
              ...patch,
            },
          }
        : prev,
    );
    try {
      setProfileActionErr("");
      const response = await adminFetch(
        `/admin/customers/${forCustomerId}/notification-prefs`,
        {
          method: "PUT",
          body: JSON.stringify(patch),
        },
      );
      if (stillViewing() && response?.notificationPrefs) {
        setData((prev) =>
          String(prev?.customer?.id) === String(forCustomerId)
            ? { ...prev, notificationPrefs: response.notificationPrefs }
            : prev,
        );
      }
    } catch (err) {
      if (!stillViewing()) return;
      setData((prev) => {
        if (String(prev?.customer?.id) !== String(forCustomerId)) return prev;
        const notificationPrefs = { ...(prev.notificationPrefs || {}) };
        patchKeys.forEach((key) => {
          if (Object.prototype.hasOwnProperty.call(previous, key)) {
            notificationPrefs[key] = previous[key];
          } else {
            delete notificationPrefs[key];
          }
        });
        return { ...prev, notificationPrefs };
      });
      setProfileActionErr(
        err.message || "Notification preference failed to save",
      );
    } finally {
      if (stillViewing()) {
        preferenceWriteRef.current = false;
        setRecipientPrefsSaving(false);
      }
    }
  };
  const saveRecipientPrefs = async () => {
    if (!isAdmin) {
      setRecipientPrefsErr("Admin access is required to change recipients");
      return;
    }
    if (preferenceWriteRef.current) return;
    preferenceWriteRef.current = true;
    const seq = ++preferenceWriteSeqRef.current;
    const forCustomerId = customerId;
    const stillViewing = () =>
      preferenceWriteSeqRef.current === seq &&
      String(customerIdRef.current) === String(forCustomerId);
    const recipientPrefsSnapshot = { ...recipientPrefsDraft };
    setRecipientPrefsSaving(true);
    setRecipientPrefsErr("");
    try {
      const response = await adminFetch(
        `/admin/customers/${forCustomerId}/notification-prefs`,
        {
          method: "PUT",
          body: JSON.stringify({
            billingContactName: recipientPrefsSnapshot.billingContactName,
            billingEmail: recipientPrefsSnapshot.billingEmail,
          }),
        },
      );
      if (stillViewing() && response?.notificationPrefs) {
        setData((prev) =>
          String(prev?.customer?.id) === String(forCustomerId)
            ? { ...prev, notificationPrefs: response.notificationPrefs }
            : prev,
        );
      }
    } catch (err) {
      if (!stillViewing()) return;
      setRecipientPrefsErr(
        err.message || "Recipient preferences failed to save",
      );
    } finally {
      if (stillViewing()) {
        preferenceWriteRef.current = false;
        setRecipientPrefsSaving(false);
      }
    }
  };
  const c = data?.customer || {};
  const notificationPrefs = data?.notificationPrefs || {};
  const recipientRoutesDiffer =
    !!c.payerId ||
    [
      c.serviceContactEmail,
      c.serviceContact2Email,
      c.serviceContact3Email,
      notificationPrefs.billing_email,
    ]
      .filter(Boolean)
      .some((email) => email.toLowerCase() !== (c.email || "").toLowerCase());

  const recipientPrefsDirty =
    recipientPrefsDraft.billingContactName !==
      (data?.notificationPrefs?.billing_contact_name || "") ||
    recipientPrefsDraft.billingEmail !==
      (data?.notificationPrefs?.billing_email || "");

  return {
    recipientRoutesDiffer,
    recipientPrefsDraft,
    setRecipientPrefsDraft,
    saveRecipientPrefs,
    recipientPrefsSaving,
    recipientPrefsDirty,
    recipientPrefsErr,
    updateNotificationPrefs,
  };
}

function useCustomerProfileEditor({
  profileReloadKey,
  data,
  customerId,
  isAdmin,
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [editForm, setEditForm] = useState({});
  const editAddressRef = useRef(null);
  const initialEditForm = useRef({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [editErr, setEditErr] = useState("");
  const [deletingCustomer, setDeletingCustomer] = useState(false);
  const editModalRef = useModalFocus(editOpen, () => {
    if (!savingEdit) setEditOpen(false);
  });
  // Single seeding path for the edit-customer modal — the desktop pill, the
  // mobile Edit pill, and the ⋯ menu item must prefill identical fields (the
  // menu copy once dropped profileLabel, so the mobile modal showed it blank).
  const openEditModal = () => {
    const c = data.customer;
    editAddressRef.current = c.address;
    const form = {
      firstName: c.firstName || "",
      lastName: c.lastName || "",
      email: c.email || "",
      phone: c.phone || "",
      profileLabel: c.profileLabel || "",
      addressLine1: c.address?.line1 || "",
      addressLine2: c.address?.line2 || "",
      city: c.address?.city || "",
      state: c.address?.state || "",
      zip: c.address?.zip || "",
      monthlyRate: c.monthlyRate ?? "",
      tier: c.tier || "",
      pipelineStage: c.pipelineStage || "new_lead",
      contactRole: c.contactRole || "",
    };
    initialEditForm.current = form;
    setEditForm(form);
    setEditErr("");
    setEditOpen(true);
  };
  useEffect(() => {
    setEditOpen(false);
    setEditForm({});
    setEditErr("");
    setSavingEdit(false);
    setDeletingCustomer(false);
  }, [customerId, profileReloadKey, isAdmin]);
  return {
    editOpen,
    openEditModal,
    savingEdit,
    setEditOpen,
    editModalRef,
    editForm,
    setEditForm,
    editAddressRef,
    editErr,
    deletingCustomer,
    setDeletingCustomer,
    setEditErr,
    setSavingEdit,
    initialEditForm,
  };
}

function useCustomerMessages({
  profileReloadKey,
  loading,
  isAdmin,
  embedded,
  activeTab,
  customerId,
  data,
  setData,
}) {
  const [comms, setComms] = useState([]);
  const [commsReadScope, setCommsReadScope] = useState(null);
  const [commsLoaded, setCommsLoaded] = useState(false);
  const [commsComposerReady, setCommsComposerReady] = useState(false);
  const [commsLoading, setCommsLoading] = useState(false);
  const [commsErr, setCommsErr] = useState("");
  const [smsReply, setSmsReply] = useState("");
  const [sendingSms, setSendingSms] = useState(false);
  const [smsErr, setSmsErr] = useState("");
  const [messageOpen, setMessageOpen] = useState(false);
  const [messageOpened, setMessageOpened] = useState(false);
  const [linkRequest, setLinkRequest] = useState(0);
  const openMessages = () => {
    setCommsLoaded(false);
    setMessageOpened(true);
    setMessageOpen(true);
  };
  const commsSeqRef = useRef(0);
  const commsAbortRef = useRef(null);
  useEffect(() => {
    if (
      loading ||
      !isAdmin ||
      (!embedded && activeTab !== "comms") ||
      commsLoaded ||
      commsLoading
    )
      return;
    const seq = commsSeqRef.current + 1;
    commsSeqRef.current = seq;
    if (commsAbortRef.current) commsAbortRef.current.abort();
    const ctrl = new AbortController();
    commsAbortRef.current = ctrl;
    setCommsLoading(true);
    setCommsErr("");
    adminFetch(`/admin/customers/${customerId}/comms`, { signal: ctrl.signal })
      .then((data) => {
        if (seq !== commsSeqRef.current) return;
        setComms(data.comms || []);
        setCommsReadScope(data.readScope || null);
        setCommsLoaded(true);
        setCommsComposerReady(true);
      })
      .catch((err) => {
        if (err.name === "AbortError" || seq !== commsSeqRef.current) return;
        setCommsErr(err.message || "Failed to load messages");
        setCommsLoaded(true);
        setCommsComposerReady(true);
      })
      .finally(() => {
        if (seq === commsSeqRef.current) setCommsLoading(false);
      });
  }, [
    activeTab,
    customerId,
    commsLoaded,
    commsLoading,
    embedded,
    isAdmin,
    loading,
  ]);
  useEffect(
    () => () => {
      if (commsAbortRef.current) commsAbortRef.current.abort();
    },
    [],
  );
  const sendSms = async () => {
    const c = data.customer;
    if (sendingSms || !smsReply.trim() || !c.phone) return;
    setSendingSms(true);
    setSmsErr("");
    try {
      await adminFetch("/admin/communications/sms", {
        method: "POST",
        body: JSON.stringify({
          to: c.phone,
          body: smsReply,
          customerId: c.id,
          messageType: "manual",
        }),
      });
      setSmsReply("");
      const [fresh, freshComms] = await Promise.all([
        adminFetch(`/admin/customers/${customerId}`),
        adminFetch(`/admin/customers/${customerId}/comms`).catch(() => ({
          comms: [],
        })),
      ]);
      setData(fresh);
      setComms(freshComms.comms || []);
      setCommsReadScope(freshComms.readScope || null);
      setCommsLoaded(true);
    } catch (err) {
      setSmsErr(err.message || "SMS failed to send");
    }
    setSendingSms(false);
  };
  useEffect(() => {
    setMessageOpen(false);
    setMessageOpened(false);
    setLinkRequest(0);
    commsSeqRef.current += 1;
    if (commsAbortRef.current) commsAbortRef.current.abort();
    setCommsLoading(false);
    setCommsReadScope(null);
    setComms([]);
    setCommsLoaded(false);
    setCommsComposerReady(false);
    setCommsErr("");
  }, [customerId, profileReloadKey, isAdmin]);
  return {
    comms,
    commsLoading,
    commsErr,
    commsLoaded,
    commsComposerReady,
    messageOpen,
    linkRequest,
    commsReadScope,
    setCommsLoaded,
    smsReply,
    setSmsReply,
    smsErr,
    setSmsErr,
    sendSms,
    sendingSms,
    openMessages,
    setLinkRequest,
    messageOpened,
    setMessageOpen,
  };
}

function useCustomerProfileNavigation({
  timeline,
  profileReloadKey,
  initialTab,
  embedded,
  isAdmin,
  editOpen,
  onClose,
  loading,
  data,
  reloadCustomer,
  customerId,
}) {
  const [requestedTab, setActiveTab] = useState(initialTab);
  const [timelineFilter, setTimelineFilter] = useState("all");
  const [timelineSearch, setTimelineSearch] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [annualPrepayOpen, setAnnualPrepayOpen] = useState(false);
  const [annualPrepayInvoiceOpen, setAnnualPrepayInvoiceOpen] = useState(false);
  const [cancelSignupOpen, setCancelSignupOpen] = useState(false);
  const [cancelPlanOpen, setCancelPlanOpen] = useState(false);
  const [refundPayment, setRefundPayment] = useState(null);
  const panelRef = useRef(null);
  const activeTabButtonRef = useRef(null);
  const [headerPast, setHeaderPast] = useState(false);
  const tabsAnchorRef = useRef(null);
  const profileContentId = useId();
  const menuRef = useRef(null);
  // The More (⋯) button outlives its menu items; modals launched from the
  // menu focus it first so useModalFocus can return focus somewhere that
  // still exists when the modal closes (the menu item unmounts on click).
  const menuButtonRef = useRef(null);
  const activeTab =
    embedded && !isAdmin && requestedTab === "billing"
      ? "overview"
      : requestedTab;
  useEffect(() => {
    if (!loading)
      activeTabButtonRef.current?.scrollIntoView?.({
        block: "nearest",
        inline: "nearest",
      });
  }, [loading, activeTab]);
  // Every sub-modal owns Escape while it is open (ui/Dialog and the
  // hand-rolled modals each close themselves through useModalFocus); the
  // profile only closes when nothing sits above it — otherwise one keypress
  // discarded an in-progress edit, refund or prepay form AND the profile.
  const subModalOpen =
    editOpen ||
    annualPrepayOpen ||
    annualPrepayInvoiceOpen ||
    cancelSignupOpen ||
    cancelPlanOpen ||
    !!refundPayment;
  useEffect(() => {
    if (embedded) return undefined;
    const handler = (e) => {
      if (e.key !== "Escape" || subModalOpen) return;
      onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose, embedded, subModalOpen]);
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target))
        setMenuOpen(false);
    };
    document.addEventListener("mousedown", handler);
    document.addEventListener("touchstart", handler);
    return () => {
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [menuOpen]);
  const changeWorkspaceTab = (next) => {
    setActiveTab(next);
    requestAnimationFrame(() => {
      if (panelRef.current && tabsAnchorRef.current) {
        panelRef.current.scrollTo({
          top: tabsAnchorRef.current.offsetTop + 1,
          behavior: "instant",
        });
      }
    });
  };
  useEffect(() => {
    if (!embedded || loading || typeof IntersectionObserver === "undefined")
      return undefined;
    const header = panelRef.current?.querySelector(".c360-workspace-header");
    if (!header) return undefined;
    const observer = new IntersectionObserver(
      ([entry]) => setHeaderPast(entry.intersectionRatio === 0),
      { root: panelRef.current, threshold: 0 },
    );
    observer.observe(header);
    return () => observer.disconnect();
  }, [embedded, loading, data?.customer?.id]);
  const viewServiceRecords = () => {
    setActiveTab("comms");
    requestAnimationFrame(() => {
      const records = panelRef.current?.querySelector(".c360-service-records");
      if (records) {
        records.open = true;
        records.scrollIntoView({ block: "start", behavior: "instant" });
      }
    });
  };
  const handleAnnualPrepaySaved = async () => {
    await reloadCustomer();
    setAnnualPrepayOpen(false);
    setAnnualPrepayInvoiceOpen(false);
    setActiveTab("billing");
  };
  useEffect(() => {
    setMenuOpen(false);
    setAnnualPrepayOpen(false);
    setAnnualPrepayInvoiceOpen(false);
    setCancelSignupOpen(false);
    setCancelPlanOpen(false);
    setRefundPayment(null);
  }, [customerId, profileReloadKey, isAdmin]);
  const filteredTimeline =
    timelineFilter === "all"
      ? timeline
      : timeline.filter(
          (t) =>
            t.type === timelineFilter ||
            (timelineFilter === "notes" && t.type === "interaction"),
        );

  return {
    filteredTimeline,
    activeTab,
    timelineFilter,
    setAnnualPrepayOpen,
    changeWorkspaceTab,
    viewServiceRecords,
    setAnnualPrepayInvoiceOpen,
    setRefundPayment,
    setCancelSignupOpen,
    setCancelPlanOpen,
    setTimelineFilter,
    timelineSearch,
    setTimelineSearch,
    panelRef,
    activeTabButtonRef,
    headerPast,
    menuOpen,
    setMenuOpen,
    menuRef,
    setActiveTab,
    tabsAnchorRef,
    profileContentId,
    menuButtonRef,
    annualPrepayOpen,
    handleAnnualPrepaySaved,
    annualPrepayInvoiceOpen,
    cancelSignupOpen,
    cancelPlanOpen,
    refundPayment,
  };
}

function customerProfileValues(data) {
  const defaults = {
    notificationPrefs: {},
    preferences: {},
    healthScore: {},
    invoices: [],
    cards: [],
    paymentMethodConsents: [],
    contracts: [],
    photos: [],
    customerDiscounts: [],
    complianceRecords: [],
    nutrientLedger: {},
    services: [],
    payments: [],
    scheduled: [],
    accountProperties: [],
    addressNeighbors: [],
    annualPrepayTerms: [],
    prepaidPlans: [],
    annualPrepayEstimateSuggestion: null,
  };
  const values = Object.fromEntries(
    Object.entries(defaults).map(([key, fallback]) => [
      key,
      data[key] || fallback,
    ]),
  );
  return {
    ...values,
    prefs: values.preferences,
    score:
      values.healthScore.overall_score ??
      values.healthScore.health_score ??
      values.healthScore.score ??
      null,
    referral: data.referralInfo,
    discounts: values.customerDiscounts,
    compliance: values.complianceRecords,
    nutrientSummary: values.nutrientLedger.summary || {},
    nutrientRows: values.nutrientLedger.rows || [],
    // The server's upcoming list is active-only and not truncated by past history.
    upcomingScheduled: data.upcomingScheduled || values.scheduled,
  };
}

function customerBillingFacts(annualPrepayTerms, billingSummary) {
  const activeAnnualPrepayTerm =
    annualPrepayTerms.find((t) =>
      ["active", "renewal_pending"].includes(t.status),
    ) || null;
  // What the profile shows/acts on: a truly active term, else a still-outstanding
  // (sent-but-unpaid) prepay invoice, else a renewal-decided term (renewed /
  // switch_plan) or a renewal-lapsed paid term (cancelled with a 'cancel'
  // decision) whose paid window still covers today — all of which the server
  // overlap guard rejects with 409 — so the admin sees the current term instead
  // of being offered a duplicate. Never falls through to an arbitrary refunded /
  // expired term.
  const displayedAnnualPrepayTerm =
    activeAnnualPrepayTerm ||
    annualPrepayTerms.find((t) => t.status === "payment_pending") ||
    annualPrepayTerms.find(
      (t) =>
        (["renewed", "switch_plan"].includes(t.status) ||
          (t.status === "cancelled" && t.renewalDecision === "cancel")) &&
        dateInputValue(t.termEnd) >= todayDateInput(),
    ) ||
    null;

  const balanceOwed = billingSummary?.complete
    ? billingSummary.openBalance
    : null;
  const overdueBalance = billingSummary?.complete
    ? billingSummary.overdueBalance
    : null;

  return {
    activeAnnualPrepayTerm,
    displayedAnnualPrepayTerm,
    balanceOwed,
    overdueBalance,
  };
}

function customerServiceFacts({
  nutrientRows,
  compliance,
  services,
  scheduled,
  upcomingScheduled,
}) {
  const hasLawnHistory =
    nutrientRows.length > 0 ||
    compliance.some((row) => /fertiliz|herbicide/.test(row.category || "")) ||
    [...services, ...scheduled].some((service) =>
      /lawn|fertiliz|turf|shrub/i.test(service.service_type || ""),
    );
  const today = todayDateInput();
  const inactiveNextServiceStatuses = new Set([
    "cancelled",
    "canceled",
    "completed",
    "rescheduled",
    "skipped",
    "no_show",
  ]);
  const isUpcomingAppt = (s) => {
    const status = String(s.status || "").toLowerCase();
    return (
      !inactiveNextServiceStatuses.has(status) &&
      dateInputValue(s.scheduled_date) >= today
    );
  };
  const upcomingFuture = upcomingScheduled
    .filter(isUpcomingAppt)
    .sort((a, b) =>
      dateInputValue(a.scheduled_date) < dateInputValue(b.scheduled_date)
        ? -1
        : 1,
    );

  return { hasLawnHistory, upcomingFuture };
}

function customerProfileAlerts({
  cards,
  prefs,
  balanceOwed,
  activeAnnualPrepayTerm,
}) {
  const expiringCard = cards.find((cd) => {
    if (!cd.exp_month || !cd.exp_year) return false;
    const exp = new Date(cd.exp_year, cd.exp_month, 0);
    const diff = (exp - new Date()) / 86400000;
    return diff < 60 && diff > -30;
  });

  const preferenceAlert = (key, label, prefix = "") => ({
    present: prefs[key],
    alert: false,
    label,
    text: `${prefix}${prefs[key]}`,
  });
  return [
    preferenceAlert("pet_details", "PET", "Pet: "),
    preferenceAlert("property_gate_code", "GATE", "Property gate: "),
    preferenceAlert("neighborhood_gate_code", "GATE", "Neighborhood gate: "),
    {
      present: balanceOwed > 0,
      alert: true,
      label: "$",
      text: `Open balance: ${fmtCurrency(balanceOwed)}`,
    },
    {
      present: expiringCard,
      alert: true,
      label: "CARD",
      text: `Card ending ${expiringCard?.last_four} expiring ${expiringCard?.exp_month}/${expiringCard?.exp_year}`,
    },
    {
      present: activeAnnualPrepayTerm?.status === "renewal_pending",
      alert: true,
      label: "PREPAY",
      text: `Annual prepay renewal due ${fmtDate(activeAnnualPrepayTerm?.termEnd)}`,
    },
    preferenceAlert("chemical_sensitivities", "CHEM", "Chemical sensitivity: "),
    preferenceAlert("special_instructions", "NOTE"),
  ].filter((item) => item.present);
}
const fmtDur = (s) => {
  if (!s && s !== 0) return null;
  const mins = Math.floor(s / 60),
    secs = s % 60;
  return mins ? `${mins}m ${secs}s` : `${secs}s`;
};

function CustomerProfilePending({
  embedded,
  onClose,
  loading,
  profileLoadError,
  onRetry,
}) {
  const content = (
    <div
      className={
        embedded
          ? "c360-embedded"
          : "admin-shell-v2 fixed inset-0 bg-black/70 z-[1000] flex justify-end font-sans"
      }
      onClick={embedded ? undefined : onClose}
    >
      <div
        className="c360-panel bg-white w-full max-w-[900px] h-full flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {loading ? (
          <div className="text-ink-secondary text-center py-16 text-ui-body">
            Loading customer profile…
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-6">
            <div className="text-center max-w-sm">
              <div className="text-alert-fg text-14 mb-2">
                Failed to load customer
              </div>
              <div className="text-14 text-ink-secondary mb-5">
                {profileLoadError ||
                  "The customer profile could not be loaded."}
              </div>
              <div className="flex items-center justify-center gap-2">
                <Button variant="secondary" onClick={onClose}>
                  Close
                </Button>
                <Button onClick={onRetry}>Retry</Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
  return embedded ? content : createPortal(content, document.body);
}

export default function Customer360ProfileV2({
  customerId,
  onClose,
  onSelectCustomer,
  initialTab = "overview",
  initialScheduledServiceId = null,
  embedded = false,
}) {
  const customerIdRef = useRef(customerId);
  customerIdRef.current = customerId;
  const isAdmin = getAdminRole() === "admin";
  const { open: openIntelligenceBar, lastMutation } = useIntelligenceBarActions();
  usePublishIntelligenceBarPageData({ customer_id: customerId, overlay: true });
  const {
    profileReloadKey,
    reloadCustomer,
    setProfileActionErr,
    loading,
    data,
    profileLoadError,
    setProfileReloadKey,
    setData,
    timeline,
    retryTimeline,
    profileVersion,
    timelineMissingSources,
    timelineError,
    timelineRetrying,
    profileActionErr,
  } = useCustomerProfileRecord({ customerId, customerIdRef, isAdmin, lastMutation });
  const {
    resumeBilling,
    resumingBilling,
    resumeBillingErr,
    resumeBillingNote,
  } = useCustomerBillingPause({ customerId, customerIdRef, reloadCustomer });
  const payer = useCustomerPayer({
    setProfileActionErr,
    customerId,
    reloadCustomer,
    isAdmin,
  });
  const {
    recipientRoutesDiffer,
    recipientPrefsDraft,
    setRecipientPrefsDraft,
    saveRecipientPrefs,
    recipientPrefsSaving,
    recipientPrefsDirty,
    recipientPrefsErr,
    updateNotificationPrefs,
  } = useCustomerRecipientPreferences({
    data,
    isAdmin,
    setProfileActionErr,
    setData,
    customerId,
    customerIdRef,
  });
  const {
    editOpen,
    openEditModal,
    savingEdit,
    setEditOpen,
    editModalRef,
    editForm,
    setEditForm,
    editAddressRef,
    editErr,
    deletingCustomer,
    setDeletingCustomer,
    setEditErr,
    setSavingEdit,
    initialEditForm,
  } = useCustomerProfileEditor({ profileReloadKey, data, customerId, isAdmin });
  const {
    filteredTimeline,
    activeTab,
    timelineFilter,
    setAnnualPrepayOpen,
    changeWorkspaceTab,
    viewServiceRecords,
    setAnnualPrepayInvoiceOpen,
    setRefundPayment,
    setCancelSignupOpen,
    setCancelPlanOpen,
    setTimelineFilter,
    timelineSearch,
    setTimelineSearch,
    panelRef,
    activeTabButtonRef,
    headerPast,
    menuOpen,
    setMenuOpen,
    menuRef,
    setActiveTab,
    tabsAnchorRef,
    profileContentId,
    menuButtonRef,
    annualPrepayOpen,
    handleAnnualPrepaySaved,
    annualPrepayInvoiceOpen,
    cancelSignupOpen,
    cancelPlanOpen,
    refundPayment,
  } = useCustomerProfileNavigation({
    timeline,
    profileReloadKey,
    initialTab,
    embedded,
    isAdmin,
    editOpen,
    onClose,
    loading,
    data,
    reloadCustomer,
    customerId,
  });
  const {
    comms,
    commsLoading,
    commsErr,
    commsLoaded,
    commsComposerReady,
    messageOpen,
    linkRequest,
    commsReadScope,
    setCommsLoaded,
    smsReply,
    setSmsReply,
    smsErr,
    setSmsErr,
    sendSms,
    sendingSms,
    openMessages,
    setLinkRequest,
    messageOpened,
    setMessageOpen,
  } = useCustomerMessages({
    profileReloadKey,
    loading,
    isAdmin,
    embedded,
    activeTab,
    customerId,
    data,
    setData,
  });

  const workspaceSections = CUSTOMER_WORKSPACE_SECTIONS.filter(
    (section) => isAdmin || section.key !== "billing",
  );

  const unreadConversations = useUnreadConversations(
    embedded && isAdmin,
    customerId,
  );

  if (loading || !data?.customer)
    return (
      <CustomerProfilePending
        embedded={embedded}
        onClose={onClose}
        loading={loading}
        profileLoadError={profileLoadError}
        onRetry={() => setProfileReloadKey((key) => key + 1)}
      />
    );
  const c = data.customer;
  const {
    notificationPrefs,
    prefs,
    score,
    invoices,
    cards,
    paymentMethodConsents,
    contracts,
    photos,
    referral,
    discounts,
    compliance,
    nutrientLedger,
    nutrientSummary,
    nutrientRows,
    services,
    payments,
    scheduled,
    upcomingScheduled,
    accountProperties,
    addressNeighbors,
    annualPrepayTerms,
    prepaidPlans,
    annualPrepayEstimateSuggestion,
  } = customerProfileValues(data);
  const {
    activeAnnualPrepayTerm,
    displayedAnnualPrepayTerm,
    balanceOwed,
    overdueBalance,
  } = customerBillingFacts(annualPrepayTerms, data.billingSummary);
  const { hasLawnHistory, upcomingFuture } = customerServiceFacts({
    nutrientRows,
    compliance,
    services,
    scheduled,
    upcomingScheduled,
  });
  const alerts = customerProfileAlerts({
    cards,
    prefs,
    balanceOwed,
    activeAnnualPrepayTerm,
  });
  const billingSummary = (
    <CustomerBillingSummary
      embedded={embedded}
      c={c}
      isAdmin={isAdmin}
      resumeBilling={resumeBilling}
      resumingBilling={resumingBilling}
      resumeBillingErr={resumeBillingErr}
      resumeBillingNote={resumeBillingNote}
      balanceOwed={balanceOwed}
      cards={cards}
      payments={payments}
      displayedAnnualPrepayTerm={displayedAnnualPrepayTerm}
      setAnnualPrepayOpen={setAnnualPrepayOpen}
      data={data}
      invoices={invoices}
    />
  );

  const recipientDetails = (
    <CustomerRecipientDetails
      payer={payer}
      c={c}
      recipientRoutesDiffer={recipientRoutesDiffer}
      isAdmin={isAdmin}
      recipientPrefsDraft={recipientPrefsDraft}
      setRecipientPrefsDraft={setRecipientPrefsDraft}
      saveRecipientPrefs={saveRecipientPrefs}
      recipientPrefsSaving={recipientPrefsSaving}
      recipientPrefsDirty={recipientPrefsDirty}
      recipientPrefsErr={recipientPrefsErr}
      embedded={embedded}
      notificationPrefs={notificationPrefs}
      updateNotificationPrefs={updateNotificationPrefs}
    />
  );

  const conversation = (
    <CustomerConversation
      customerId={customerId}
      comms={comms}
      commsLoading={commsLoading}
      commsErr={commsErr}
      embedded={embedded}
      commsLoaded={commsLoaded}
      c={c}
      commsComposerReady={commsComposerReady}
      isAdmin={isAdmin}
      messageOpen={messageOpen}
      linkRequest={linkRequest}
      commsReadScope={commsReadScope}
      setCommsLoaded={setCommsLoaded}
      reloadCustomer={reloadCustomer}
      retryTimeline={retryTimeline}
      smsReply={smsReply}
      setSmsReply={setSmsReply}
      smsErr={smsErr}
      setSmsErr={setSmsErr}
      sendSms={sendSms}
      sendingSms={sendingSms}
      recipientDetails={recipientDetails}
      data={data}
    />
  );

  const sections = {
    overview: (
      <CustomerProfileOverview
        embedded={embedded}
        isAdmin={isAdmin}
        c={c}
        upcomingFuture={upcomingFuture}
        services={services}
        comms={comms}
        commsLoading={commsLoading}
        commsErr={commsErr}
        data={data}
        unreadConversations={unreadConversations}
        prefs={prefs}
        alerts={alerts}
        openMessages={openMessages}
        changeWorkspaceTab={changeWorkspaceTab}
        viewServiceRecords={viewServiceRecords}
        discounts={discounts}
        referral={referral}
        customerId={customerId}
        accountProperties={accountProperties}
        onSelectCustomer={onSelectCustomer}
        addressNeighbors={addressNeighbors}
        setData={setData}
        setProfileActionErr={setProfileActionErr}
        billingSummary={billingSummary}
      />
    ),
    billing: (
      <CustomerProfileBilling
        embedded={embedded}
        balanceOwed={balanceOwed}
        overdueBalance={overdueBalance}
        c={c}
        displayedAnnualPrepayTerm={displayedAnnualPrepayTerm}
        data={data}
        billingSummary={billingSummary}
        isAdmin={isAdmin}
        setAnnualPrepayOpen={setAnnualPrepayOpen}
        setAnnualPrepayInvoiceOpen={setAnnualPrepayInvoiceOpen}
        invoices={invoices}
        payments={payments}
        setRefundPayment={setRefundPayment}
        cards={cards}
        setCancelSignupOpen={setCancelSignupOpen}
        setCancelPlanOpen={setCancelPlanOpen}
      />
    ),
    services: (
      <CustomerProfileServices
        expanded={!embedded}
        services={services}
        initialScheduledServiceId={initialScheduledServiceId}
        upcomingScheduled={upcomingScheduled}
        photos={photos}
      />
    ),
    property: (
      <CustomerProfileProperty
        embedded={embedded}
        recipientDetails={recipientDetails}
        isAdmin={isAdmin}
        customerId={customerId}
        c={c}
        profileVersion={profileVersion}
        reloadCustomer={reloadCustomer}
        prefs={prefs}
      />
    ),
    compliance: (
      <CustomerProfileCompliance
        showLawnData={!embedded || hasLawnHistory}
        compliance={compliance}
        nutrientSummary={nutrientSummary}
        nutrientLedger={nutrientLedger}
        nutrientRows={nutrientRows}
      />
    ),
    contracts: (
      <ElectronicAuthorizationContractV2
        customer={c}
        consents={paymentMethodConsents}
        cards={cards}
        contracts={contracts}
        onRefresh={reloadCustomer}
      />
    ),
    activity: (
      <Customer360Activity
        missingSources={timelineMissingSources}
        timeline={timeline}
        filter={timelineFilter}
        onFilter={setTimelineFilter}
        search={timelineSearch}
        onSearch={setTimelineSearch}
        error={timelineError}
        retrying={timelineRetrying}
        onRetry={retryTimeline}
      />
    ),
    timeline: (
      <CustomerProfileTimeline
        isAdmin={isAdmin}
        timelineError={timelineError}
        filteredTimeline={filteredTimeline}
        setTimelineFilter={setTimelineFilter}
        timelineFilter={timelineFilter}
        retryTimeline={retryTimeline}
        timelineRetrying={timelineRetrying}
      />
    ),
    conversation,
  };
  const Presentation = embedded
    ? CustomerWorkspacePresentation
    : CustomerOverlayPresentation;
  return (
    <Presentation
      panelRef={panelRef}
      activeTabButtonRef={activeTabButtonRef}
      headerPast={headerPast}
      headerProps={{
        c,
        isAdmin,
        openIntelligenceBar,
        unreadConversations,
        openEditModal,
        changeWorkspaceTab,
        openMessages,
        setLinkRequest,
        menuOpen,
        setMenuOpen,
        menuRef,
        score,
        onClose,
        customerId,
        setAnnualPrepayInvoiceOpen,
        setActiveTab,
      }}
      activeTab={activeTab}
      tabsAnchorRef={tabsAnchorRef}
      profileContentId={profileContentId}
      workspaceSections={workspaceSections}
      sections={sections}
      alerts={alerts}
      messageOpened={messageOpened}
      messageOpen={messageOpen}
      setMessageOpen={setMessageOpen}
      hasLawnHistory={hasLawnHistory}
      hasCompliance={compliance.length > 0}
      profileActionErr={profileActionErr}
      actions={
        <CustomerProfileMobileActions
          onClose={onClose}
          c={c}
          isAdmin={isAdmin}
          openIntelligenceBar={openIntelligenceBar}
          openEditModal={openEditModal}
          menuRef={menuRef}
          menuButtonRef={menuButtonRef}
          setMenuOpen={setMenuOpen}
          menuOpen={menuOpen}
          setAnnualPrepayInvoiceOpen={setAnnualPrepayInvoiceOpen}
          setAnnualPrepayOpen={setAnnualPrepayOpen}
          setActiveTab={setActiveTab}
          customerId={customerId}
        />
      }
      dialogs={
        <>
          {annualPrepayOpen && (
            <AnnualPrepayModal
              customer={c}
              activeTerm={displayedAnnualPrepayTerm}
              prepaidPlans={prepaidPlans}
              annualPrepayTerms={annualPrepayTerms}
              estimateSuggestion={annualPrepayEstimateSuggestion}
              onClose={() => setAnnualPrepayOpen(false)}
              onSaved={handleAnnualPrepaySaved}
            />
          )}
          {annualPrepayInvoiceOpen && (
            <AnnualPrepayInvoiceModal
              customer={c}
              activeTerm={displayedAnnualPrepayTerm}
              prepaidPlans={prepaidPlans}
              annualPrepayTerms={annualPrepayTerms}
              onClose={() => setAnnualPrepayInvoiceOpen(false)}
              onSaved={handleAnnualPrepaySaved}
            />
          )}
          {cancelSignupOpen && (
            <CancelSignupModal
              customer={c}
              onClose={() => setCancelSignupOpen(false)}
              onDone={reloadCustomer}
            />
          )}
          {cancelPlanOpen && (
            // This profile is a z-[1000] overlay and its own sub-modals sit at
            // 1100/1120; ui/Dialog defaults to layer 120, which paints BENEATH
            // the profile, so the dialog is raised to the sub-modal layer.
            <CancelPlanDialog
              customer={c}
              onClose={() => setCancelPlanOpen(false)}
              onDone={reloadCustomer}
              layer={1120}
            />
          )}
          {refundPayment && (
            <RefundPaymentModal
              customer={c}
              payment={refundPayment}
              onClose={() => setRefundPayment(null)}
              onDone={reloadCustomer}
            />
          )}
          <CustomerProfileEditor
            editOpen={editOpen}
            savingEdit={savingEdit}
            setEditOpen={setEditOpen}
            editModalRef={editModalRef}
            editForm={editForm}
            setEditForm={setEditForm}
            editAddressRef={editAddressRef}
            editErr={editErr}
            deletingCustomer={deletingCustomer}
            setDeletingCustomer={setDeletingCustomer}
            setEditErr={setEditErr}
            customerId={customerId}
            onClose={onClose}
            setSavingEdit={setSavingEdit}
            initialEditForm={initialEditForm}
            reloadCustomer={reloadCustomer}
          />
        </>
      }
    />
  );
}
