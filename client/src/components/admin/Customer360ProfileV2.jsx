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
 *   - HealthCircle/RadarChart recolored to zinc; alert tier only when low
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

import { useState, useEffect, useRef } from "react";
import {
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
  PenLine,
  RotateCcw,
  ShieldCheck,
  Trash2,
  XCircle,
} from "lucide-react";
import { CustomerActionBar } from "./StickyActionBar";
import {
  Card,
  CardBody,
  Badge,
  Button,
  Switch,
  Table,
  THead,
  TBody,
  TR,
  TH,
  TD,
  cn,
} from "../ui";
import CallBridgeLink, { callViaBridge } from "./CallBridgeLink";
import {
  CONSENT_TEXT,
  CONSENT_VERSION,
} from "../../lib/paymentMethodConsentText";

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

function fmtCurrency(v) {
  return "$" + parseFloat(v || 0).toFixed(2);
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
  if (subtotal > 0) return subtotal;
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

// ─── Radar Chart (monochrome) ────────────────────────────────────
function RadarChart({ data }) {
  if (!data || data.length < 3) return null;
  const size = 160,
    cx = size / 2,
    cy = size / 2,
    maxR = 60;
  const n = data.length;
  const angleStep = (2 * Math.PI) / n;
  const pointAt = (i, pct) => {
    const a = -Math.PI / 2 + i * angleStep;
    return [
      cx + maxR * (pct / 100) * Math.cos(a),
      cy + maxR * (pct / 100) * Math.sin(a),
    ];
  };
  const gridLevels = [25, 50, 75, 100];
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="block mx-auto"
    >
      {gridLevels.map((lv) => (
        <polygon
          key={lv}
          points={data.map((_, i) => pointAt(i, lv).join(",")).join(" ")}
          fill="none"
          stroke="#E4E4E7"
          strokeWidth={0.5}
        />
      ))}
      {data.map((_, i) => {
        const [x, y] = pointAt(i, 100);
        return (
          <line
            key={i}
            x1={cx}
            y1={cy}
            x2={x}
            y2={y}
            stroke="#E4E4E7"
            strokeWidth={0.5}
          />
        );
      })}
      <polygon
        points={data.map((d, i) => pointAt(i, d.value).join(",")).join(" ")}
        fill="rgba(24,24,27,0.10)"
        stroke="#18181B"
        strokeWidth={1.25}
      />
      {data.map((d, i) => {
        const [x, y] = pointAt(i, 115);
        return (
          <text
            key={i}
            x={x}
            y={y}
            textAnchor="middle"
            fill="#71717A"
            fontSize={9}
          >
            {d.label}
          </text>
        );
      })}
    </svg>
  );
}

// ─── Tier badge (color-coded per metal) ─────────────────────────
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
    <div className={cn("u-label text-ink-secondary mb-2", className)}>
      {children}
    </div>
  );
}

// ─── Stat card (alert color only for overdue balances) ───────────
function StatCardV2({ label, value, alert }) {
  return (
    <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-3 text-center">
      {" "}
      <div className="u-label text-ink-secondary mb-1">{label}</div>{" "}
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
      <div className="u-label text-ink-tertiary mb-1">{label}</div>{" "}
      <div className="text-13 text-zinc-900 break-words">
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
    <div>
      {" "}
      <div className="mb-5 rounded-sm border-hairline border-zinc-200 bg-white">
        {" "}
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-hairline border-zinc-200">
          {" "}
          <div>
            {" "}
            <div className="text-16 font-medium text-zinc-900">
              AutoPay Authorization
            </div>{" "}
            <div className="text-12 text-ink-secondary mt-1">
              Create, share, sign, and audit saved-payment authorization
              contracts.
            </div>{" "}
          </div>{" "}
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
        <div className="grid grid-cols-1 md:grid-cols-3 border-b border-hairline border-zinc-200">
          {[
            ["Details", "Recipient, name, payment, attachments"],
            ["Add information", "Selected clauses and custom fields"],
            ["Review & share", "Preview, signatures, audit status"],
          ].map(([step, sub], idx) => (
            <div
              key={step}
              className={cn(
                "px-4 py-3 border-zinc-200",
                idx < 2 ? "md:border-r border-hairline" : "",
              )}
            >
              {" "}
              <div className="text-12 font-medium text-zinc-900">
                {step}
              </div>{" "}
              <div className="text-11 text-ink-secondary mt-1">{sub}</div>{" "}
            </div>
          ))}
        </div>{" "}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 p-4">
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
        <div className="grid grid-cols-1 md:grid-cols-[1fr_0.8fr] gap-3 px-4 pb-4">
          {" "}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {" "}
            <label className="block">
              {" "}
              <div className="u-label text-ink-secondary mb-1">
                Payment method
              </div>{" "}
              <select
                value={selectedPaymentMethodId}
                onChange={(e) =>
                  updateContractForm("paymentMethodId", e.target.value)
                }
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-13 text-zinc-900"
              >
                {cards.length === 0 && (
                  <option value="">No saved payment method</option>
                )}
                {cards.map((card) => (
                  <option key={card.id} value={card.id}>
                    {paymentMethodLabel(card)}
                  </option>
                ))}
              </select>{" "}
            </label>{" "}
            <label className="block">
              {" "}
              <div className="u-label text-ink-secondary mb-1">
                Service name
              </div>{" "}
              <input
                value={contractForm.serviceName}
                onChange={(e) =>
                  updateContractForm("serviceName", e.target.value)
                }
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-13 text-zinc-900"
              />{" "}
            </label>{" "}
            <label className="block">
              {" "}
              <div className="u-label text-ink-secondary mb-1">
                Renewal date
              </div>{" "}
              <input
                type="date"
                value={contractForm.renewalDate}
                onChange={(e) =>
                  updateContractForm("renewalDate", e.target.value)
                }
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-13 text-zinc-900"
              />{" "}
            </label>{" "}
            <label className="block">
              {" "}
              <div className="u-label text-ink-secondary mb-1">
                Cancellation deadline
              </div>{" "}
              <input
                type="date"
                value={contractForm.cancellationDeadline}
                onChange={(e) =>
                  updateContractForm("cancellationDeadline", e.target.value)
                }
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-13 text-zinc-900"
              />{" "}
            </label>{" "}
          </div>{" "}
          <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3">
            {" "}
            <div className="u-label text-ink-secondary mb-2">Signing Link</div>
            {signingUrl ? (
              <div className="space-y-2">
                {" "}
                <div className="break-all text-12 text-zinc-900 leading-5">
                  {signingUrl}
                </div>{" "}
                <Button size="sm" variant="secondary" onClick={copySigningUrl}>
                  {" "}
                  <Copy size={13} className="mr-1" />
                  Copy
                </Button>{" "}
              </div>
            ) : (
              <div className="text-12 text-ink-secondary leading-5">
                Create a link to send manually. SMS templates are seeded but
                inactive, so this will not send automatically.
              </div>
            )}
            {!canCreateContract && (
              <div className="mt-2 text-11 text-alert-fg">
                Add a saved payment method before creating an authorization
                contract.
              </div>
            )}
            {contractAction && (
              <div className="mt-2 text-11 text-zinc-900">{contractAction}</div>
            )}
            {contractErr && (
              <div className="mt-2 text-11 text-alert-fg">{contractErr}</div>
            )}
          </div>{" "}
        </div>{" "}
      </div>{" "}
      <div className="mb-5 rounded-sm border-hairline border-zinc-200 bg-white">
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-hairline border-zinc-200">
          <div>
            <div className="text-16 font-medium text-zinc-900">
              Reusable Documents
            </div>
            <div className="text-12 text-ink-secondary mt-1">
              Send service agreements, notices, prep forms, and WDO acknowledgements through the e-sign workflow.
            </div>
          </div>
          <Button
            size="sm"
            onClick={createDocumentLink}
            disabled={!canCreateDocument || documentTemplatesLoading}
          >
            <Link2 size={13} className="mr-1" />
            {creatingDocument ? "Creating..." : "Create Link"}
          </Button>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-[1.1fr_0.9fr] gap-3 p-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <div className="u-label text-ink-secondary mb-1">
                Template
              </div>
              <select
                value={selectedDocumentTemplateKey}
                onChange={(e) => setSelectedDocumentTemplateKey(e.target.value)}
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-13 text-zinc-900"
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
              </select>
            </label>
            <label className="block">
              <div className="u-label text-ink-secondary mb-1">
                Service name
              </div>
              <input
                value={documentValues.serviceName}
                onChange={(e) => updateDocumentValue("serviceName", e.target.value)}
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-13 text-zinc-900"
              />
            </label>
            <label className="block">
              <div className="u-label text-ink-secondary mb-1">
                Agreement start
              </div>
              <input
                type="date"
                value={documentValues.agreementStartDate}
                onChange={(e) => updateDocumentValue("agreementStartDate", e.target.value)}
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-13 text-zinc-900"
              />
            </label>
            <label className="block">
              <div className="u-label text-ink-secondary mb-1">
                Service / inspection date
              </div>
              <input
                type="date"
                value={documentValues.serviceDate || documentValues.inspectionDate}
                onChange={(e) => {
                  updateDocumentValue("serviceDate", e.target.value);
                  updateDocumentValue("inspectionDate", e.target.value);
                }}
                className="w-full h-9 rounded-sm border-hairline border-zinc-300 bg-white px-3 text-13 text-zinc-900"
              />
            </label>
            <label className="sm:col-span-2 inline-flex min-h-8 items-center gap-2 text-12 font-medium text-zinc-900">
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
            <div className="u-label text-ink-secondary mb-2">Document link</div>
            <div className="text-12 text-ink-secondary leading-5">
              {selectedDocumentTemplate
                ? `${selectedDocumentTemplate.name} will be rendered with this customer's name, address, and the values entered here.`
                : "Select an active template to create a document link."}
            </div>
            {documentSigningUrl && (
              <div className="mt-3 space-y-2">
                <div className="break-all text-12 text-zinc-900 leading-5">
                  {documentSigningUrl}
                </div>
                <Button size="sm" variant="secondary" onClick={copyDocumentSigningUrl}>
                  <Copy size={13} className="mr-1" />
                  Copy
                </Button>
              </div>
            )}
            {documentAction && (
              <div className="mt-2 text-11 text-zinc-900">{documentAction}</div>
            )}
            {documentErr && (
              <div className="mt-2 text-11 text-alert-fg">{documentErr}</div>
            )}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[1.2fr_0.8fr] gap-5">
        {" "}
        <Card>
          {" "}
          <CardBody className="p-0">
            {" "}
            <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-hairline border-zinc-200">
              {" "}
              <div className="flex items-start gap-3">
                {" "}
                <div className="mt-0.5 inline-flex h-9 w-9 items-center justify-center rounded-sm border-hairline border-zinc-200 bg-zinc-50 text-zinc-900">
                  {" "}
                  <FileText size={18} strokeWidth={1.75} />{" "}
                </div>{" "}
                <div>
                  {" "}
                  <div className="text-18 font-medium tracking-tight text-zinc-900">
                    Electronic Payment Authorization
                  </div>{" "}
                  <div className="text-12 text-ink-secondary mt-1">
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
                <div className="flex items-start justify-between gap-3">
                  {" "}
                  <div>
                    {" "}
                    <div className="text-13 font-medium text-zinc-900">
                      AutoPay Authorization - Initials required
                    </div>{" "}
                    <div className="text-12 leading-5 text-ink-secondary mt-2">
                      {displayedText}
                    </div>{" "}
                  </div>{" "}
                  <Badge tone="neutral">Clause</Badge>{" "}
                </div>{" "}
              </div>{" "}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-5">
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
                    <div className="text-12 text-ink-secondary mt-1">
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-12">
                    {" "}
                    <div>
                      {" "}
                      <div className="u-label text-ink-secondary mb-1">
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
                      <div className="u-label text-ink-secondary mb-1">
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
                  <div className="mt-4 text-12 leading-5 text-zinc-900">
                    This contract is between Waves Pest Control (the Business)
                    and {signerName} (the Client) dated {contractDate}.
                  </div>{" "}
                </div>{" "}
                <div className="py-4 border-b border-hairline border-zinc-200">
                  {" "}
                  <div className="u-label text-ink-secondary mb-2">
                    Terms
                  </div>{" "}
                  <div className="text-13 font-medium text-zinc-900 mb-2">
                    AutoPay Authorization
                  </div>{" "}
                  <p className="text-13 leading-6 text-zinc-900 m-0 whitespace-pre-line">
                    {displayedContractText}
                  </p>{" "}
                  <div className="mt-4 rounded-sm border-hairline border-zinc-200 bg-zinc-50 px-3 py-2">
                    {" "}
                    <div className="u-label text-ink-secondary mb-1">
                      Recipient Initial
                    </div>{" "}
                    <div className="h-7 rounded-sm border-hairline border-zinc-300 bg-white" />{" "}
                  </div>{" "}
                </div>{" "}
                <div className="pt-4">
                  {" "}
                  <div className="u-label text-ink-secondary mb-2">
                    Signatures
                  </div>{" "}
                  <div className="text-12 text-ink-secondary leading-5 mb-4">
                    Electronic signatures count as original for all purposes. By
                    typing their names as signatures below, both parties agree
                    to the terms and provisions of this agreement.
                  </div>{" "}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <div className="mt-4 rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-12 text-ink-secondary leading-5">
                This authorization covers saved-payment use only. Service scope,
                visit frequency, renewal terms, and cancellation policy remain
                controlled by the customer&apos;s service agreement and account
                record.
              </div>{" "}
              <div className="mt-5">
                {" "}
                <SectionTitle>Florida Compliance Reference</SectionTitle>{" "}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {FLORIDA_COMPLIANCE_ITEMS.map((item) => (
                    <div
                      key={item.title}
                      className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3"
                    >
                      {" "}
                      <div className="text-12 font-medium text-zinc-900">
                        {item.title}
                      </div>{" "}
                      <div className="text-12 text-ink-secondary leading-5 mt-1">
                        {item.body}
                      </div>{" "}
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex mt-2 text-11 u-label text-zinc-900 hover:underline"
                      >
                        {item.citation}
                      </a>{" "}
                    </div>
                  ))}
                </div>{" "}
                <div className="mt-2 text-11 text-ink-tertiary leading-5">
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
                Signature Record
              </div>{" "}
            </div>
            {latestContract?.signedAt ? (
              <div className="space-y-2 text-12">
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
              <div className="space-y-2 text-12">
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
              <div className="rounded-sm border-hairline border-zinc-200 bg-zinc-50 p-3 text-12 text-ink-secondary leading-5">
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
                <div className="text-12 font-medium text-zinc-900">
                  {paymentMethodLabel(methodForSummary)}
                </div>{" "}
                <div className="text-11 text-ink-secondary mt-0.5">
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
      <div className="mt-5">
        {" "}
        <SectionTitle>Contract History ({contracts.length})</SectionTitle>
        {contracts.length > 0 ? (
          <div className="overflow-x-auto mb-5">
            {" "}
            <Table>
              {" "}
              <THead>
                {" "}
                <TR>
                  {" "}
                  <TH>Status</TH>
                  <TH>Created</TH>
                  <TH>Signed</TH>
                  <TH>Document</TH>
                  <TH>Delivery</TH>
                  <TH>Actions</TH>{" "}
                </TR>{" "}
              </THead>{" "}
              <TBody>
                {contracts.map((contract) => (
                  <TR key={contract.id}>
                    {" "}
                    <TD>
                      {" "}
                      <Badge tone={contractStatusTone(contract.status)}>
                        {contractStatusLabel(contract.status)}
                      </Badge>{" "}
                    </TD>{" "}
                    <TD className="u-nums">{fmtDate(contract.createdAt)}</TD>{" "}
                    <TD className="u-nums">
                      {contract.signedAt ? fmtDate(contract.signedAt) : "—"}
                    </TD>{" "}
                    <TD>
                      {contract.contractType === "document_template"
                        ? contract.title || contract.documentTemplateKey || "Document"
                        : paymentMethodLabel(contract)}
                    </TD>{" "}
                    <TD>
                      <div className="flex flex-wrap gap-1">
                        {contractDeliverySteps(contract).map((step) => (
                          <span
                            key={step.key}
                            className={cn(
                              "h-5 px-1.5 inline-flex items-center rounded-xs border-hairline text-10 uppercase tracking-label",
                              step.done
                                ? "bg-zinc-900 border-zinc-900 text-white"
                                : "bg-zinc-50 border-zinc-200 text-ink-secondary",
                            )}
                            title={step.at ? fmtDate(step.at) : ""}
                          >
                            {step.label}
                          </span>
                        ))}
                      </div>
                    </TD>{" "}
                    <TD>
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
                    </TD>{" "}
                  </TR>
                ))}
              </TBody>{" "}
            </Table>{" "}
          </div>
        ) : (
          <div className="mb-5 text-13 text-ink-secondary">
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
                <div className="text-12 text-ink-secondary">
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
              <div className="mb-3 rounded-sm border-hairline border-red-200 bg-red-50 px-3 py-2 text-12 text-red-900">
                {auditErr}
              </div>
            )}
            <div className="mb-3 flex flex-wrap gap-1.5">
              {contractDeliverySteps(auditContract || contracts.find((contract) => contract.id === auditContractId)).map((step) => (
                <span
                  key={step.key}
                  className={cn(
                    "h-6 px-2 inline-flex items-center rounded-xs border-hairline text-10 uppercase tracking-label",
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
                <div key={event.id} className="grid gap-2 px-3 py-2 md:grid-cols-[180px_1fr_160px]">
                  <div className="text-12 font-medium text-zinc-900">
                    {contractEventLabel(event.eventType)}
                  </div>
                  <div className="min-w-0 text-12 text-ink-secondary">
                    {event.actorType || "system"}
                    {event.ip ? ` · ${event.ip}` : ""}
                    {event.metadata?.templateKey ? ` · ${event.metadata.templateKey}` : ""}
                    {event.metadata?.reason ? ` · ${event.metadata.reason}` : ""}
                  </div>
                  <div className="u-nums text-11 text-ink-secondary md:text-right">
                    {fmtDate(event.createdAt)}
                  </div>
                </div>
              ))}
              {!auditLoading && auditEvents.length === 0 && (
                <div className="px-3 py-4 text-12 text-ink-secondary">
                  No audit events recorded for this contract.
                </div>
              )}
              {auditLoading && (
                <div className="px-3 py-4 text-12 text-ink-secondary">
                  Loading audit events...
                </div>
              )}
            </div>
          </div>
        )}
        <SectionTitle>Authorization History ({consents.length})</SectionTitle>
        {consents.length > 0 ? (
          <div className="overflow-x-auto">
            {" "}
            <Table>
              {" "}
              <THead>
                {" "}
                <TR>
                  {" "}
                  <TH>Accepted</TH>
                  <TH>Source</TH>
                  <TH>Method</TH>
                  <TH>Version</TH>{" "}
                </TR>{" "}
              </THead>{" "}
              <TBody>
                {consents.map((consent) => (
                  <TR key={consent.id}>
                    {" "}
                    <TD className="u-nums">
                      {fmtDate(consent.createdAt)}
                    </TD>{" "}
                    <TD>{sourceLabel(consent.source)}</TD>{" "}
                    <TD>{paymentMethodLabel(consent)}</TD>{" "}
                    <TD className="u-nums">
                      {consent.consentTextVersion || "—"}
                    </TD>{" "}
                  </TR>
                ))}
              </TBody>{" "}
            </Table>{" "}
          </div>
        ) : (
          <div className="text-13 text-ink-secondary">
            No saved-payment authorizations recorded.
          </div>
        )}
      </div>{" "}
    </div>
  );
}

// ─── Service row (collapsible) ───────────────────────────────────
function ServiceRowV2({ service: s, initiallyExpanded = false }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const structuredNotes = parseStructuredNotes(s.structured_notes);
  const managerApproval = structuredNotes.waveguardManagerApproval;
  const tankCleanout = structuredNotes.waveguardTankCleanout;
  const isProjectCompletion = structuredNotes.projectCompletion === true;
  const projectReportUrl = isProjectCompletion ? projectReportUrlFromNotes(structuredNotes) : null;
  const inventoryDeductions = Array.isArray(structuredNotes.inventoryDeductions)
    ? structuredNotes.inventoryDeductions
    : [];
  const hasWaveGuardAudit =
    !!managerApproval || !!tankCleanout || inventoryDeductions.length > 0;
  return (
    <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm overflow-hidden mb-1.5">
      {" "}
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full flex justify-between items-center px-3.5 py-2.5 text-13 u-focus-ring hover:bg-zinc-100 transition-colors"
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
          <span className="text-ink-secondary">{fmtDate(s.service_date)}</span>{" "}
          <span
            className="text-ink-secondary text-12 transition-transform"
            style={{ transform: expanded ? "rotate(0deg)" : "rotate(-90deg)" }}
          >
            ▾
          </span>{" "}
        </span>{" "}
      </button>
      {expanded && (
        <div className="px-3.5 py-2.5 border-t border-hairline border-zinc-200 text-12 space-y-1">
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
                <span>Manager Approval</span>{" "}
              </div>{" "}
              <div className="text-ink-secondary">
                {approvalCodeLabel(managerApproval.reasonCode)}
                {managerApproval.approvedByRole
                  ? ` by ${managerApproval.approvedByRole}`
                  : ""}
                {managerApproval.approvedAt
                  ? ` on ${fmtDate(managerApproval.approvedAt)}`
                  : ""}
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
                    {tankCleanout.cleanoutCompleted
                      ? "Completed"
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

// ─── Autopay panel ───────────────────────────────────────────────
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
      await adminFetch(`/admin/customers/${customerId}/charge-now`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      setMsg(`Charged $${amt.toFixed(2)} successfully`);
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
            <div className="u-label text-ink-secondary mb-1">Auto-pay</div>{" "}
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
              <div className="text-12 text-ink-secondary mt-1.5 leading-relaxed">
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
          <div className="mt-2.5 px-2 py-1.5 bg-zinc-100 text-zinc-900 rounded-xs text-12">
            {msg}
          </div>
        )}
        {err && (
          <div className="mt-2.5 px-2 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-12">
            {err}
          </div>
        )}
        {state?.recent_events?.length > 0 && (
          <div className="mt-3 border-t border-hairline border-zinc-200 pt-2.5">
            {" "}
            <div className="u-label text-ink-secondary mb-1.5">
              Recent events
            </div>
            {state.recent_events.slice(0, 5).map((ev) => (
              <div
                key={ev.id}
                className="text-11 text-ink-secondary py-0.5 flex justify-between gap-2"
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

  const load = () => {
    adminFetch(`/admin/customers/${customerId}/credits`)
      .then(setData)
      .catch(() => {});
  };
  useEffect(load, [customerId]);

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
    "block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-9 px-2.5 focus:outline-none focus:border-zinc-900";

  return (
    <Card className="mb-5">
      <CardBody className="p-4">
        <div className="flex justify-between items-start gap-3 flex-wrap mb-3">
          <div>
            <div className="u-label text-ink-secondary mb-1">Account credit</div>
            <div className="text-22 text-zinc-900 u-nums leading-none">
              {fmtCurrency(balance)}
            </div>
            <div className="text-12 text-ink-tertiary mt-1">
              Available to apply to invoices
            </div>
          </div>
          {canEdit && (
            <Button size="sm" variant="secondary" onClick={() => setOpen((v) => !v)}>
              {open ? "Cancel" : "Issue credit"}
            </Button>
          )}
        </div>

        {open && (
          <div className="border-hairline border-zinc-200 rounded-sm p-3 mb-3 bg-zinc-50">
            <div className="grid grid-cols-2 gap-2 mb-2">
              <label className="block">
                <span className="u-label text-ink-tertiary block mb-1">Direction</span>
                <select
                  value={direction}
                  onChange={(e) => setDirection(e.target.value)}
                  className={inputClass}
                >
                  <option value="add">Add credit</option>
                  <option value="deduct">Deduct credit</option>
                </select>
              </label>
              <label className="block">
                <span className="u-label text-ink-tertiary block mb-1">Amount</span>
                <input
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
                  <span className="u-label text-ink-tertiary block mb-1">Funding</span>
                  <select
                    value={fundKind}
                    onChange={(e) => setFundKind(e.target.value)}
                    className={inputClass}
                  >
                    <option value="prepayment">Prepayment (money received)</option>
                    <option value="goodwill">Goodwill / courtesy (no money)</option>
                  </select>
                </label>
                {fundKind === "prepayment" && (
                  <label className="block">
                    <span className="u-label text-ink-tertiary block mb-1">Method</span>
                    <select
                      value={method}
                      onChange={(e) => setMethod(e.target.value)}
                      className={inputClass}
                    >
                      <option value="cash">Cash</option>
                      <option value="check">Check</option>
                      <option value="zelle">Zelle</option>
                      <option value="card">Card</option>
                      <option value="other">Other</option>
                    </select>
                  </label>
                )}
              </div>
            ) : (
              <div className="text-12 text-ink-tertiary mb-2">
                Recorded as an adjustment / correction (no payment booked).
              </div>
            )}
            <div className="text-11 text-ink-tertiary mb-2 leading-snug">
              {direction === "add" && fundKind === "prepayment"
                ? "Books a payment now (counts as collected revenue at receipt)."
                : "No payment booked — does not count as revenue."}
            </div>
            <label className="block mb-2">
              <span className="u-label text-ink-tertiary block mb-1">Note (optional)</span>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="e.g. Q3 quarterly prepay collected by check"
                className={inputClass}
              />
            </label>
            {err && <div className="text-12 text-alert-fg mb-2">{err}</div>}
            <Button size="sm" variant="primary" disabled={saving} onClick={submit}>
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
                  className="py-1.5 text-12 border-b border-hairline border-zinc-200/60 flex justify-between items-center gap-3"
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
        ) : (
          <div className="text-12 text-ink-tertiary">No credit history yet</div>
        )}
      </CardBody>
    </Card>
  );
}

function AnnualPrepayPanelV2({ customer, activeTerm, onOpen, onSendInvoice }) {
  return (
    <Card className="mb-5">
      <CardBody className="p-4">
        <div className="flex justify-between items-start gap-3 flex-wrap">
          <div>
            <div className="u-label text-ink-secondary mb-1">Annual prepay</div>
            {activeTerm ? (
              <>
                <div className="text-14 font-medium text-zinc-900">
                  {activeTerm.planLabel || "Annual Prepay"}
                </div>
                <div className="text-12 text-ink-secondary mt-1">
                  {fmtDate(activeTerm.termStart)} to {fmtDate(activeTerm.termEnd)} · {String(activeTerm.status || "").replace(/_/g, " ")}
                </div>
                {activeTerm.coverageServiceType && (
                  <div className="text-11 text-ink-secondary mt-1">
                    Covers {activeTerm.coverageVisitCount || 4} {activeTerm.coverageServiceType} visit{Number(activeTerm.coverageVisitCount || 4) === 1 ? "" : "s"}
                  </div>
                )}
              </>
            ) : (
              <div className="text-12 text-ink-secondary">
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
        <div className="text-11 text-ink-secondary mt-2">
          Default amount: {fmtCurrency(customer?.annualValue || (Number(customer?.monthlyRate || 0) * 12))}
        </div>
      </CardBody>
    </Card>
  );
}

function AnnualPrepayModal({ customer, activeTerm, prepaidPlans = [], annualPrepayTerms = [], onClose, onSaved }) {
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

  const handleServiceOptionChange = (value) => {
    if (value === "__custom__") return;
    handleServiceTypeChange(value);
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

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSaving(true);
    setError("");
    try {
      const result = await adminFetch(`/admin/customers/${customer.id}/annual-prepay`, {
        method: "POST",
        body: JSON.stringify({
          amount: Number(amount),
          serviceType: serviceType.trim(),
          visitCount: Number.parseInt(visitCount, 10),
          coverageCadence,
          method,
          termStart,
          termEnd,
          reference: reference.trim() || undefined,
          note: note.trim() || undefined,
        }),
      });
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

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[1120] flex items-start sm:items-center justify-center p-4 overflow-y-auto"
      onClick={() => !saving && onClose?.()}
    >
      <div
        className="bg-white w-full max-w-[540px] rounded-sm border-hairline border-zinc-300 my-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline border-zinc-200">
          <div>
            <div className="text-15 font-medium text-zinc-900">Record collected annual prepay</div>
            <div className="text-11 text-ink-secondary mt-0.5">{customerName}</div>
          </div>
          <button
            onClick={() => !saving && onClose?.()}
            aria-label="Close"
            className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring"
          >
            ×
          </button>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {activeTermEnd && (
            <div className="sm:col-span-2 text-12 text-ink-secondary bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5">
              Current term ends {fmtDate(activeTermEnd)}
            </div>
          )}
          <label className="block sm:col-span-2">
            <div className="u-label text-ink-secondary mb-1">Service plan</div>
            <select
              value={serviceOptions.some((option) => option.value === serviceType) ? serviceType : "__custom__"}
              onChange={(e) => handleServiceOptionChange(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            >
              {serviceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              <option value="__custom__">Custom label</option>
            </select>
          </label>
          <label className="block sm:col-span-2">
            <div className="u-label text-ink-secondary mb-1">Service covered</div>
            <input
              value={serviceType}
              onChange={(e) => handleServiceTypeChange(e.target.value)}
              placeholder="Enter custom service label"
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">Cadence</div>
            <select
              value={coverageCadence}
              onChange={(e) => handleCadenceChange(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            >
              {ANNUAL_PREPAY_CADENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">Applications covered</div>
            <input
              type="number"
              min="1"
              max="24"
              step="1"
              value={visitCount}
              onChange={(e) => handleVisitCountChange(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">
              {isCommercialCustomer ? "Pre-tax service amount collected" : "Amount collected"}
            </div>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
            {perVisit > 0 && (
              <div className="text-11 text-ink-secondary mt-1">
                {fmtCurrency(perVisit)} per application
              </div>
            )}
            {isCommercialCustomer && Number(amount) > 0 && (
              <div className="text-11 text-ink-secondary mt-1">
                Commercial: ~7% county sales tax is added at invoicing — total
                recorded as paid ≈ {fmtCurrency(estTaxInclusiveTotal)}.
              </div>
            )}
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">Payment already collected by</div>
            <select
              value={method}
              onChange={(e) => setMethod(e.target.value)}
              className="w-full h-9 px-2 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            >
              {methodOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">Term starts</div>
            <input
              type="date"
              value={termStart}
              onChange={(e) => handleStartChange(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">Term ends</div>
            <input
              type="date"
              value={termEnd}
              onChange={(e) => setTermEnd(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block sm:col-span-2">
            <div className="u-label text-ink-secondary mb-1">Reference</div>
            <input
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              placeholder="Receipt, check, Zelle, or Stripe reference"
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block sm:col-span-2">
            <div className="u-label text-ink-secondary mb-1">Note</div>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-2.5 py-2 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
        </div>
        {error && (
          <div className="mx-4 mb-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-12">
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
    </div>
  );
}

function AnnualPrepayInvoiceModal({ customer, activeTerm, prepaidPlans = [], annualPrepayTerms = [], onClose, onSaved }) {
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
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const cadenceTouchedRef = useRef(false);
  const visitCountTouchedRef = useRef(false);

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
    || termEnd <= termStart
    || !dueDate;
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

  const handleServiceOptionChange = (value) => {
    if (value === "__custom__") return;
    handleServiceTypeChange(value);
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

  const handleSubmit = async () => {
    if (submitDisabled) return;
    setSaving(true);
    setError("");
    try {
      const result = await adminFetch(`/admin/customers/${customer.id}/annual-prepay-invoice`, {
        method: "POST",
        body: JSON.stringify({
          amount: Number(amount),
          serviceType: serviceType.trim(),
          visitCount: Number.parseInt(visitCount, 10),
          coverageCadence,
          termStart,
          termEnd,
          dueDate,
          note: note.trim() || undefined,
        }),
      });
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

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[1120] flex items-start sm:items-center justify-center p-4 overflow-y-auto"
      onClick={() => !saving && onClose?.()}
    >
      <div
        className="bg-white w-full max-w-[540px] rounded-sm border-hairline border-zinc-300 my-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-hairline border-zinc-200">
          <div>
            <div className="text-15 font-medium text-zinc-900">Send annual prepay invoice</div>
            <div className="text-11 text-ink-secondary mt-0.5">{customerName}</div>
          </div>
          <button
            onClick={() => !saving && onClose?.()}
            aria-label="Close"
            className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring"
          >
            ×
          </button>
        </div>
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-3">
          {activeTermEnd && (
            <div className="sm:col-span-2 text-12 text-ink-secondary bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5">
              Current term ends {fmtDate(activeTermEnd)}
            </div>
          )}
          <label className="block sm:col-span-2">
            <div className="u-label text-ink-secondary mb-1">Service plan</div>
            <select
              value={serviceOptions.some((option) => option.value === serviceType) ? serviceType : "__custom__"}
              onChange={(e) => handleServiceOptionChange(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            >
              {serviceOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
              <option value="__custom__">Custom label</option>
            </select>
          </label>
          <label className="block sm:col-span-2">
            <div className="u-label text-ink-secondary mb-1">Service covered</div>
            <input
              value={serviceType}
              onChange={(e) => handleServiceTypeChange(e.target.value)}
              placeholder="Enter custom service label"
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">Cadence</div>
            <select
              value={coverageCadence}
              onChange={(e) => handleCadenceChange(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            >
              {ANNUAL_PREPAY_CADENCE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">Applications covered</div>
            <input
              type="number"
              min="1"
              max="24"
              step="1"
              value={visitCount}
              onChange={(e) => handleVisitCountChange(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">
              {isCommercialCustomer ? "Pre-tax service amount" : "Invoice amount"}
            </div>
            <input
              type="number"
              min="0"
              step="0.01"
              value={amount}
              onChange={(e) => handleAmountChange(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
            {perVisit > 0 && (
              <div className="text-11 text-ink-secondary mt-1">
                {fmtCurrency(perVisit)} per application
              </div>
            )}
            {isCommercialCustomer && Number(amount) > 0 && (
              <div className="text-11 text-ink-secondary mt-1">
                Commercial: ~7% county sales tax is added — customer is invoiced
                ≈ {fmtCurrency(estTaxInclusiveTotal)}.
              </div>
            )}
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">Term starts</div>
            <input
              type="date"
              value={termStart}
              onChange={(e) => handleStartChange(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">Term ends</div>
            <input
              type="date"
              value={termEnd}
              onChange={(e) => setTermEnd(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block">
            <div className="u-label text-ink-secondary mb-1">Invoice due</div>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
          <label className="block sm:col-span-2">
            <div className="u-label text-ink-secondary mb-1">Invoice note</div>
            <textarea
              rows={3}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="w-full px-2.5 py-2 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
            />
          </label>
        </div>
        {error && (
          <div className="mx-4 mb-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-12">
            {error}
          </div>
        )}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-hairline border-zinc-200">
          <Button variant="secondary" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={submitDisabled}>
            {saving ? "Sending..." : "Create & send invoice"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// MAIN COMPONENT
// ============================================================================
export default function Customer360ProfileV2({
  customerId,
  onClose,
  onSelectCustomer,
  onAddProperty,
  initialTab = "overview",
  initialScheduledServiceId = null,
}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState(initialTab);
  const [timelineFilter, setTimelineFilter] = useState("all");
  const [timeline, setTimeline] = useState([]);
  const [comms, setComms] = useState([]);
  const [commsLoaded, setCommsLoaded] = useState(false);
  const [commsLoading, setCommsLoading] = useState(false);
  const [commsErr, setCommsErr] = useState("");
  const [smsReply, setSmsReply] = useState("");
  const [sendingSms, setSendingSms] = useState(false);
  const [smsErr, setSmsErr] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [annualPrepayOpen, setAnnualPrepayOpen] = useState(false);
  const [annualPrepayInvoiceOpen, setAnnualPrepayInvoiceOpen] = useState(false);
  const [editForm, setEditForm] = useState({});
  const [savingEdit, setSavingEdit] = useState(false);
  const [editErr, setEditErr] = useState("");
  const [recipientPrefsDraft, setRecipientPrefsDraft] = useState({
    billingContactName: "",
    billingEmail: "",
  });
  const [recipientPrefsSaving, setRecipientPrefsSaving] = useState(false);
  const [recipientPrefsErr, setRecipientPrefsErr] = useState("");
  const [deletingCustomer, setDeletingCustomer] = useState(false);
  const panelRef = useRef(null);
  const menuRef = useRef(null);
  const commsSeqRef = useRef(0);
  const commsAbortRef = useRef(null);
  const isAdmin = getAdminRole() === "admin";

  const reloadCustomer = () =>
    adminFetch(`/admin/customers/${customerId}`)
      .then(setData)
      .catch(() => {});

  useEffect(() => {
    commsSeqRef.current += 1;
    if (commsAbortRef.current) commsAbortRef.current.abort();
    setLoading(true);
    setCommsLoading(false);
    Promise.all([
      adminFetch(`/admin/customers/${customerId}`),
      adminFetch(`/admin/customers/${customerId}/timeline`).catch(() => ({
        timeline: [],
      })),
    ])
      .then(([detail, tl]) => {
        setData(detail);
        setTimeline(tl.timeline || []);
        setComms([]);
        setCommsLoaded(false);
        setCommsErr("");
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [customerId]);

  useEffect(() => {
    if (activeTab !== "comms" || commsLoaded || commsLoading) return;
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
        setCommsLoaded(true);
      })
      .catch((err) => {
        if (err.name === "AbortError" || seq !== commsSeqRef.current) return;
        setCommsErr(err.message || "Failed to load messages");
        setCommsLoaded(true);
      })
      .finally(() => {
        if (seq === commsSeqRef.current) setCommsLoading(false);
      });
  }, [activeTab, customerId, commsLoaded, commsLoading]);

  useEffect(
    () => () => {
      if (commsAbortRef.current) commsAbortRef.current.abort();
    },
    [],
  );

  useEffect(() => {
    const handler = (e) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

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

  if (loading)
    return (
      <div
        className="fixed inset-0 bg-black/70 z-[1000] flex justify-end"
        onClick={onClose}
      >
        {" "}
        <div
          className="c360-panel bg-white w-full max-w-[900px] h-screen flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {" "}
          <div className="text-ink-secondary text-center py-16 text-13">
            Loading customer profile…
          </div>{" "}
        </div>{" "}
      </div>
    );

  if (!data || !data.customer)
    return (
      <div
        className="fixed inset-0 bg-black/70 z-[1000] flex justify-end"
        onClick={onClose}
      >
        {" "}
        <div
          className="c360-panel bg-white w-full max-w-[900px] h-screen flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {" "}
          <div className="text-alert-fg text-center py-16 text-13">
            Failed to load customer
          </div>{" "}
        </div>{" "}
      </div>
    );

  const c = data.customer;
  const notificationPrefs = data.notificationPrefs || {};
  const prefs = data.preferences || {};
  const hs = data.healthScore || {};
  const score = hs.overall_score ?? hs.health_score ?? hs.score ?? null;
  const invoices = data.invoices || [];
  const cards = data.cards || [];
  const paymentMethodConsents = data.paymentMethodConsents || [];
  const contracts = data.contracts || [];
  const photos = data.photos || [];
  const referral = data.referralInfo;
  const discounts = data.customerDiscounts || [];
  const compliance = data.complianceRecords || [];
  const nutrientLedger = data.nutrientLedger || {};
  const nutrientSummary = nutrientLedger.summary || {};
  const nutrientRows = nutrientLedger.rows || [];
  const services = data.services || [];
  const payments = data.payments || [];
  const scheduled = data.scheduled || [];
  // Upcoming, active-only list from the server; data.scheduled is full history
  // (past + future) and limited, so use this for next-service selection.
  const upcomingScheduled = data.upcomingScheduled || scheduled;
  const accountProperties = data.accountProperties || [];
  const annualPrepayTerms = data.annualPrepayTerms || [];
  const activeAnnualPrepayTerm = annualPrepayTerms.find((t) => ['active', 'renewal_pending'].includes(t.status)) || null;
  // What the profile shows/acts on: a truly active term, else a still-outstanding
  // (sent-but-unpaid) prepay invoice, else a renewal-decided term (renewed /
  // switch_plan) or a renewal-lapsed paid term (cancelled with a 'cancel'
  // decision) whose paid window still covers today — all of which the server
  // overlap guard rejects with 409 — so the admin sees the current term instead
  // of being offered a duplicate. Never falls through to an arbitrary refunded /
  // expired term.
  const displayedAnnualPrepayTerm = activeAnnualPrepayTerm
    || annualPrepayTerms.find((t) => t.status === 'payment_pending')
    || annualPrepayTerms.find((t) =>
      (['renewed', 'switch_plan'].includes(t.status)
        || (t.status === 'cancelled' && t.renewalDecision === 'cancel'))
      && dateInputValue(t.termEnd) >= todayDateInput())
    || null;

  const updateNotificationPrefs = async (patch) => {
    const previous = data.notificationPrefs || {};
    const patchKeys = Object.keys(patch);
    setData((prev) =>
      prev
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
      const response = await adminFetch(
        `/admin/customers/${customerId}/notification-prefs`,
        {
          method: "PUT",
          body: JSON.stringify(patch),
        },
      );
      if (response?.notificationPrefs) {
        setData((prev) =>
          prev ? { ...prev, notificationPrefs: response.notificationPrefs } : prev,
        );
      }
    } catch {
      setData((prev) => {
        if (!prev) return prev;
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
    }
  };

  const saveRecipientPrefs = async () => {
    setRecipientPrefsSaving(true);
    setRecipientPrefsErr("");
    try {
      const response = await adminFetch(
        `/admin/customers/${customerId}/notification-prefs`,
        {
          method: "PUT",
          body: JSON.stringify({
            billingContactName: recipientPrefsDraft.billingContactName,
            billingEmail: recipientPrefsDraft.billingEmail,
          }),
        },
      );
      if (response?.notificationPrefs) {
        setData((prev) =>
          prev ? { ...prev, notificationPrefs: response.notificationPrefs } : prev,
        );
      }
    } catch (err) {
      setRecipientPrefsErr(err.message || "Recipient preferences failed to save");
    } finally {
      setRecipientPrefsSaving(false);
    }
  };

  const handleAnnualPrepaySaved = async () => {
    await reloadCustomer();
    setAnnualPrepayOpen(false);
    setAnnualPrepayInvoiceOpen(false);
    setActiveTab("billing");
  };

  const balanceOwed = invoices
    .filter((i) => i.status !== "paid" && i.status !== "prepaid")
    .reduce(
      (s, i) =>
        s + parseFloat(i.amount_due || 0) - parseFloat(i.amount_paid || 0),
      0,
    );
  const lastPayment = payments[0];
  const today = todayDateInput();
  const inactiveNextServiceStatuses = new Set([
    "cancelled",
    "canceled",
    "completed",
    "rescheduled",
    "skipped",
    "no_show",
  ]);
  const nextService = upcomingScheduled.find((s) => {
    const status = String(s.status || "").toLowerCase();
    return (
      !inactiveNextServiceStatuses.has(status) &&
      dateInputValue(s.scheduled_date) >= today
    );
  });

  const expiringCard = cards.find((cd) => {
    if (!cd.exp_month || !cd.exp_year) return false;
    const exp = new Date(cd.exp_year, cd.exp_month, 0);
    const diff = (exp - new Date()) / 86400000;
    return diff < 60 && diff > -30;
  });

  // Alerts — alert-fg only for $/card, otherwise neutral
  const alerts = [];
  if (prefs.pet_details)
    alerts.push({
      alert: false,
      label: "PET",
      text: `Pet: ${prefs.pet_details}`,
    });
  if (prefs.property_gate_code)
    alerts.push({
      alert: false,
      label: "GATE",
      text: `Property gate: ${prefs.property_gate_code}`,
    });
  if (prefs.neighborhood_gate_code)
    alerts.push({
      alert: false,
      label: "GATE",
      text: `Neighborhood gate: ${prefs.neighborhood_gate_code}`,
    });
  if (balanceOwed > 0)
    alerts.push({
      alert: true,
      label: "$",
      text: `Overdue balance: ${fmtCurrency(balanceOwed)}`,
    });
  if (expiringCard)
    alerts.push({
      alert: true,
      label: "CARD",
      text: `Card ending ${expiringCard.last_four} expiring ${expiringCard.exp_month}/${expiringCard.exp_year}`,
    });
  if (activeAnnualPrepayTerm?.status === "renewal_pending")
    alerts.push({
      alert: true,
      label: "PREPAY",
      text: `Annual prepay renewal due ${fmtDate(activeAnnualPrepayTerm.termEnd)}`,
    });
  if (prefs.chemical_sensitivities)
    alerts.push({
      alert: false,
      label: "CHEM",
      text: `Chemical sensitivity: ${prefs.chemical_sensitivities}`,
    });
  if (prefs.special_instructions)
    alerts.push({
      alert: false,
      label: "NOTE",
      text: prefs.special_instructions,
    });

  const filteredTimeline =
    timelineFilter === "all"
      ? timeline
      : timeline.filter(
          (t) =>
            t.type === timelineFilter ||
            (timelineFilter === "notes" && t.type === "interaction"),
        );

  const radarData = hs.risk_factors
    ? [
        { label: "Payment", value: 80 },
        { label: "Engagement", value: 60 },
        { label: "Service", value: 70 },
        { label: "Satisfaction", value: 75 },
        { label: "Tenure", value: 90 },
        { label: "Revenue", value: 65 },
      ]
    : [
        { label: "Payment", value: score ? Math.min(score + 10, 100) : 50 },
        { label: "Engagement", value: score || 50 },
        { label: "Service", value: score ? Math.min(score + 5, 100) : 50 },
        { label: "Satisfaction", value: score ? Math.max(score - 5, 0) : 50 },
        {
          label: "Tenure",
          value: c.memberSince
            ? Math.min(
                Math.floor(
                  (Date.now() - new Date(c.memberSince)) / 86400000 / 3.65,
                ),
                100,
              )
            : 50,
        },
        {
          label: "Revenue",
          value:
            c.lifetimeRevenue > 0
              ? Math.min(Math.floor(c.lifetimeRevenue / 50), 100)
              : 20,
        },
      ];

  const sendSms = async () => {
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
      setCommsLoaded(true);
    } catch (err) {
      setSmsErr(err.message || "SMS failed to send");
    }
    setSendingSms(false);
  };

  const fmtDur = (s) => {
    if (!s && s !== 0) return null;
    const mins = Math.floor(s / 60),
      secs = s % 60;
    return mins ? `${mins}m ${secs}s` : `${secs}s`;
  };

  const TABS = [
    { key: "overview", label: "Overview" },
    { key: "services", label: "Services" },
    { key: "billing", label: "Billing" },
    { key: "contracts", label: "Contracts" },
    { key: "comms", label: "Comms" },
    { key: "property", label: "Property" },
    { key: "compliance", label: "Compliance" },
  ];

  return (
    <div
      className="fixed inset-0 bg-black/70 z-[1000] flex justify-end font-sans"
      onClick={onClose}
    >
      {" "}
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="c360-panel bg-white w-full max-w-[900px] h-screen flex flex-col overflow-y-auto text-zinc-900"
      >
        {" "}
        <style>{`
          @media (max-width: 768px) {
            .c360-overview-grid { grid-template-columns: 1fr !important; }
            .c360-billing-grid { grid-template-columns: 1fr 1fr !important; }
            .c360-property-grid { grid-template-columns: 1fr !important; }
            .c360-panel { width: 100% !important; max-width: 100% !important; }
            .c360-header-desktop { display: none !important; }
            .c360-header-mobile { display: block !important; }
            .c360-mobile-footer-spacer { display: block !important; }
          }
          .c360-header-mobile { display: none; }
          .c360-mobile-footer-spacer { display: none; }
        `}</style>
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
                <HealthCircle score={score} /> <TierBadgeV2 tier={c.tier} />{" "}
                <StageBadgeV2 stage={c.pipelineStage} />{" "}
              </div>{" "}
              <button
                onClick={onClose}
                aria-label="Close"
                className="text-ink-secondary text-22 leading-none px-1 hover:text-zinc-900 u-focus-ring"
              >
                ×
              </button>{" "}
            </div>
            {(c.phone || c.email) && (
              <div className="flex gap-4 items-center flex-wrap text-12 text-ink-secondary mb-1.5">
                {c.phone && (
                  <CallBridgeLink
                    phone={c.phone}
                    customerName={`${c.firstName || ""} ${c.lastName || ""}`.trim()}
                    className="u-nums text-zinc-900 hover:underline"
                  >
                    {c.phone}
                  </CallBridgeLink>
                )}
                {c.email && (
                  <a
                    href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(c.email)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-900 hover:underline"
                  >
                    {c.email}
                  </a>
                )}
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
                <div key={slot.key} className="text-12 text-ink-secondary mb-1.5">
                  {" "}
                  <span className="text-ink-tertiary mr-1">{slot.label}</span>
                  {slot.name && (
                    <span className="text-zinc-900 mr-2">{slot.name}</span>
                  )}
                  {slot.phone && (
                    <CallBridgeLink
                      phone={slot.phone}
                      customerName={
                        slot.name ||
                        `${c.firstName || ""} ${c.lastName || ""}`.trim()
                      }
                      className="u-nums text-zinc-900 hover:underline mr-3"
                    >
                      {slot.phone}
                    </CallBridgeLink>
                  )}
                  {slot.email && (
                    <a
                      href={`https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(slot.email)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-zinc-900 hover:underline"
                    >
                      {slot.email}
                    </a>
                  )}
                </div>
              ))}
            <div className="flex gap-4 items-center flex-wrap text-12 text-ink-secondary mb-2.5">
              {(() => {
                const parts = [
                  c.address?.line1,
                  c.address?.city,
                  c.address?.state,
                  c.address?.zip,
                ].filter(Boolean);
                if (!parts.length) return null;
                const full =
                  `${c.address?.line1 || ""}, ${c.address?.city || ""}, ${c.address?.state || ""} ${c.address?.zip || ""}`.replace(
                    /^,\s*|\s*,\s*$/g,
                    "",
                  );
                return (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(full)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-zinc-900 hover:underline"
                  >
                    {full}
                  </a>
                );
              })()}
              <span className="u-nums text-zinc-900">
                {fmtCurrency(c.monthlyRate)}/mo
              </span>{" "}
              <span className="u-nums">{fmtCurrency(c.annualValue)}/yr</span>
              {c.memberSince && <span>Since {fmtDate(c.memberSince)}</span>}
            </div>{" "}
            <div className="flex gap-2 flex-wrap">
              {c.phone && (
                <>
                  {" "}
                  <a
                    href={`/admin/communications?phone=${encodeURIComponent(c.phone)}&action=sms`}
                    className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
                  >
                    Text
                  </a>{" "}
                  <button
                    type="button"
                    onClick={() =>
                      callViaBridge(
                        c.phone,
                        `${c.firstName || ""} ${c.lastName || ""}`.trim(),
                      )
                    }
                    className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
                  >
                    Call
                  </button>{" "}
                </>
              )}
              <a
                href={`/admin/schedule?customer=${customerId}`}
                className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
              >
                Book Appt
              </a>{" "}
              <a
                href={`/admin/invoices?customer=${customerId}`}
                className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
              >
                Invoice
              </a>
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => setAnnualPrepayInvoiceOpen(true)}
                  className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
                >
                  Prepay Invoice
                </button>
              )}
              {isAdmin && (
                <button
                  type="button"
                  onClick={() => onAddProperty?.(c)}
                  className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
                >
                  Add Property
                </button>
              )}
              <button
                onClick={() => setActiveTab("comms")}
                className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
              >
                Add Note
              </button>
              {isAdmin && (
                <button
                  onClick={() => {
                    setEditForm({
                      firstName: c.firstName || "",
                      lastName: c.lastName || "",
                      email: c.email || "",
                      phone: c.phone || "",
                      profileLabel: c.profileLabel || "",
                      addressLine1: c.address?.line1 || "",
                      city: c.address?.city || "",
                      state: c.address?.state || "",
                      zip: c.address?.zip || "",
                      monthlyRate: c.monthlyRate ?? "",
                      tier: c.tier || "",
                      pipelineStage: c.pipelineStage || "new_lead",
                    });
                    setEditErr("");
                    setEditOpen(true);
                  }}
                  className="inline-flex items-center h-8 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm bg-zinc-900 text-white no-underline hover:bg-zinc-800 u-focus-ring border-0"
                >
                  Edit
                </button>
              )}
            </div>{" "}
          </div>
          {/* Mobile header (< 768px) — per mobile-admin-audit PR #3 item 2:
              back / menu / Text pills on top, large name, three-stat row */}
          <div className="c360-header-mobile px-4 pt-3 pb-3">
            {" "}
            <div className="flex items-center justify-between mb-3">
              {" "}
              <button
                onClick={onClose}
                aria-label="Back"
                className="inline-flex items-center justify-center h-9 w-9 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 u-focus-ring"
              >
                {" "}
                <ChevronLeft size={18} strokeWidth={1.75} />{" "}
              </button>{" "}
              <div className="flex items-center gap-2">
                {c.phone && (
                  <a
                    href={`/admin/communications?phone=${encodeURIComponent(c.phone)}&action=sms`}
                    className="inline-flex items-center h-9 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 no-underline u-focus-ring"
                  >
                    Text
                  </a>
                )}
                {c.phone && (
                  <CallBridgeLink
                    phone={c.phone}
                    customerName={`${c.firstName || ""} ${c.lastName || ""}`.trim()}
                    className="inline-flex items-center h-9 px-3.5 text-11 uppercase tracking-label font-medium rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 no-underline u-focus-ring"
                  >
                    Call
                  </CallBridgeLink>
                )}
                <div ref={menuRef} className="relative">
                  {" "}
                  <button
                    onClick={() => setMenuOpen((v) => !v)}
                    aria-label="More"
                    aria-expanded={menuOpen}
                    className="inline-flex items-center justify-center h-9 w-9 rounded-sm border-hairline border-zinc-300 bg-white text-zinc-900 u-focus-ring"
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
                        <button
                          role="menuitem"
                          onClick={() => {
                            setEditForm({
                              firstName: c.firstName || "",
                              lastName: c.lastName || "",
                              email: c.email || "",
                              phone: c.phone || "",
                              addressLine1: c.address?.line1 || "",
                              city: c.address?.city || "",
                              state: c.address?.state || "",
                              zip: c.address?.zip || "",
                              monthlyRate: c.monthlyRate ?? "",
                              tier: c.tier || "",
                              pipelineStage: c.pipelineStage || "new_lead",
                            });
                            setEditErr("");
                            setEditOpen(true);
                            setMenuOpen(false);
                          }}
                          className="w-full text-left px-3 py-2 text-13 text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                        >
                          Edit customer
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          role="menuitem"
                          onClick={() => {
                            setAnnualPrepayInvoiceOpen(true);
                            setMenuOpen(false);
                          }}
                          className="w-full text-left px-3 py-2 text-13 text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                        >
                          Send prepay invoice
                        </button>
                      )}
                      {isAdmin && (
                        <button
                          role="menuitem"
                          onClick={() => {
                            setAnnualPrepayOpen(true);
                            setMenuOpen(false);
                          }}
                          className="w-full text-left px-3 py-2 text-13 text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                        >
                          Record collected prepay
                        </button>
                      )}
                      <button
                        role="menuitem"
                        onClick={() => {
                          setActiveTab("comms");
                          setMenuOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-13 text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                      >
                        Add note
                      </button>{" "}
                      <button
                        role="menuitem"
                        onClick={() => {
                          onAddProperty?.(c);
                          setMenuOpen(false);
                        }}
                        className="w-full text-left px-3 py-2 text-13 text-zinc-900 hover:bg-zinc-50 u-focus-ring"
                      >
                        Add property
                      </button>{" "}
                    </div>
                  )}
                </div>{" "}
              </div>{" "}
            </div>{" "}
            <div className="text-26 font-medium tracking-tight text-zinc-900 leading-tight mb-1">
              {c.firstName} {c.lastName}
            </div>
            {(c.address?.line1 || c.address?.city) &&
              (() => {
                const parts = [
                  c.address?.line1,
                  c.address?.city,
                  c.address?.state,
                  c.address?.zip,
                ].filter(Boolean);
                const label = parts.join(", ");
                const query = encodeURIComponent(label);
                return (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${query}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-13 text-ink-secondary no-underline hover:text-zinc-900 mb-2 truncate"
                  >
                    {label}
                  </a>
                );
              })()}
            <div className="flex items-center gap-2 flex-wrap mb-3">
              {" "}
              <TierBadgeV2 tier={c.tier} />{" "}
              <StageBadgeV2 stage={c.pipelineStage} />{" "}
            </div>{" "}
            <div className="flex items-stretch gap-3 pt-3 border-t border-hairline border-zinc-200">
              {" "}
              <div className="flex-1">
                {" "}
                <div className="u-label text-ink-tertiary">Monthly</div>{" "}
                <div className="u-nums text-15 font-medium text-zinc-900 mt-0.5">
                  {fmtCurrency(c.monthlyRate)}
                </div>{" "}
              </div>{" "}
              <div className="flex-1 border-l border-hairline border-zinc-200 pl-3">
                {" "}
                <div className="u-label text-ink-tertiary">Annual</div>{" "}
                <div className="u-nums text-15 font-medium text-zinc-900 mt-0.5">
                  {fmtCurrency(c.annualValue)}
                </div>{" "}
              </div>{" "}
              <div className="flex-1 border-l border-hairline border-zinc-200 pl-3">
                {" "}
                <div className="u-label text-ink-tertiary">Health</div>{" "}
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
        {/* ZONE 2 — ALERT BANNERS */}
        {alerts.length > 0 && (
          <div className="flex flex-wrap gap-2 px-6 py-3 bg-zinc-50 border-b border-hairline border-zinc-200">
            {alerts.map((a, i) => (
              <div
                key={i}
                className={cn(
                  "inline-flex items-center gap-1.5 h-6 px-2 text-11 font-medium rounded-xs border-hairline",
                  a.alert
                    ? "bg-alert-bg border-alert-fg text-alert-fg"
                    : "bg-white border-zinc-200 text-zinc-700",
                )}
              >
                {" "}
                <span className="uppercase tracking-label text-10">
                  {a.label}
                </span>{" "}
                <span className="normal-case">{a.text}</span>{" "}
              </div>
            ))}
          </div>
        )}
        {/* ZONE 3 — TAB BAR */}
        <div className="flex bg-white border-b border-hairline border-zinc-200 px-6 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setActiveTab(t.key)}
              className={cn(
                "h-11 px-4 text-12 uppercase tracking-label font-medium whitespace-nowrap u-focus-ring transition-colors border-b-2",
                activeTab === t.key
                  ? "text-zinc-900 border-zinc-900"
                  : "text-ink-secondary border-transparent hover:text-zinc-900",
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
        {/* TAB CONTENT */}
        <div className="p-6 flex-1">
          {/* OVERVIEW */}
          {activeTab === "overview" && (
            <div>
              {accountProperties.length > 0 && (
                <div className="mb-4 pb-3 border-b border-hairline border-zinc-200">
                  {" "}
                  <SectionTitle>
                    Other Properties For This Customer
                  </SectionTitle>{" "}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    {accountProperties.map((p) => {
                      const addr = [
                        p.address?.line1,
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
                          <div className="text-13 font-medium text-zinc-900">
                            {p.profileLabel || "Service property"}
                          </div>{" "}
                          <div className="text-12 text-ink-secondary truncate">
                            {addr || "No address on file"}
                          </div>{" "}
                          <div className="text-11 text-ink-tertiary mt-1">
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
                        <button
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
              <div className="flex items-center justify-between mb-4 pb-3 border-b border-hairline border-zinc-200">
                {" "}
                <div>
                  {" "}
                  <div className="text-13 font-medium text-zinc-900">
                    Already left a Google review
                  </div>{" "}
                  <div className="text-11 text-ink-secondary">
                    When on, this customer is excluded from review-request and
                    48h followup SMS.
                  </div>
                  {c.reviewMarkedAt && c.hasLeftGoogleReview && (
                    <div className="text-10 text-ink-tertiary mt-0.5 u-nums">
                      Marked {fmtDate(c.reviewMarkedAt)}
                    </div>
                  )}
                </div>{" "}
                <Switch
                  id="has-left-review-v2"
                  checked={!!c.hasLeftGoogleReview}
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
                              reviewMarkedAt: val
                                ? new Date().toISOString()
                                : null,
                            },
                          }
                        : prev,
                    );
                    try {
                      await adminFetch(`/admin/customers/${customerId}`, {
                        method: "PUT",
                        body: JSON.stringify({ hasLeftGoogleReview: val }),
                      });
                    } catch {
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
                    }
                  }}
                />{" "}
              </div>{" "}
              <div className="c360-overview-grid grid grid-cols-3 gap-5">
                {/* Col 1: Services */}
                <div>
                  {" "}
                  <SectionTitle>Upcoming Service</SectionTitle>
                  {nextService ? (
                    <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5 mb-3">
                      {" "}
                      <div className="text-13 font-medium text-zinc-900">
                        {nextService.service_type}
                      </div>{" "}
                      <div className="text-12 text-ink-secondary">
                        {fmtDate(nextService.scheduled_date)} ·{" "}
                        {nextService.status}
                      </div>{" "}
                    </div>
                  ) : (
                    <div className="text-12 text-ink-secondary mb-3">
                      No upcoming services
                    </div>
                  )}
                  <SectionTitle>
                    Recent Services ({services.length})
                  </SectionTitle>
                  {services.slice(0, 5).map((s, i) => {
                    const recentNotes = parseStructuredNotes(s.structured_notes);
                    return (
                      <div
                        key={i}
                        className="py-1.5 text-12 border-b border-hairline border-zinc-200/60 flex justify-between gap-3"
                      >
                        {" "}
                        <span className="text-zinc-900 flex items-center gap-1.5">
                          {s.service_type}
                          {recentNotes.projectCompletion === true && (
                            <Badge tone="neutral">Project</Badge>
                          )}
                        </span>{" "}
                        <span className="text-ink-secondary">
                          {fmtDate(s.service_date)}
                        </span>{" "}
                      </div>
                    );
                  })}
                  {services.length === 0 && (
                    <div className="text-12 text-ink-secondary">
                      No services recorded
                    </div>
                  )}
                </div>
                {/* Col 2: Billing snapshot */}
                <div>
                  {" "}
                  <SectionTitle>Billing Summary</SectionTitle>{" "}
                  <div className="grid grid-cols-2 gap-2 mb-3">
                    {" "}
                    <StatCardV2
                      label="Balance Owed"
                      value={fmtCurrency(balanceOwed)}
                      alert={balanceOwed > 0}
                    />{" "}
                    <StatCardV2
                      label="Lifetime Rev"
                      value={fmtCurrency(c.lifetimeRevenue)}
                    />{" "}
                  </div>
                  {cards.length > 0 && (
                    <div className="text-12 text-ink-secondary mb-1.5">
                      Card: {cards[0].card_brand} ending {cards[0].last_four}
                    </div>
                  )}
                  {lastPayment && (
                    <div className="text-12 text-ink-secondary mb-3">
                      Last payment: {fmtCurrency(lastPayment.amount)} on{" "}
                      {fmtDate(lastPayment.payment_date)}
                    </div>
                  )}
                  {displayedAnnualPrepayTerm && (
                    <div className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5 mb-3">
                      <div className="text-12 font-medium text-zinc-900">
                        {displayedAnnualPrepayTerm.planLabel || "Annual Prepay"}
                      </div>
                      <div className="text-11 text-ink-secondary mt-0.5">
                        Term ends {fmtDate(displayedAnnualPrepayTerm.termEnd)}
                        {" · "}
                        {String(displayedAnnualPrepayTerm.status || "").replace(/_/g, " ")}
                        {displayedAnnualPrepayTerm.lastScheduledServiceDate
                          ? ` · last scheduled ${fmtDate(displayedAnnualPrepayTerm.lastScheduledServiceDate)}`
                          : ""}
                      </div>
                      {displayedAnnualPrepayTerm.renewalDecision && (
                        <div className="text-11 text-ink-secondary mt-0.5">
                          Decision:{" "}
                          {displayedAnnualPrepayTerm.renewalDecision.replace(
                            "_",
                            " ",
                          )}
                        </div>
                      )}
                    </div>
                  )}
                  {isAdmin && (
                    <Button
                      size="sm"
                      onClick={() => setAnnualPrepayOpen(true)}
                      className="mb-3"
                    >
                      Record annual prepay
                    </Button>
                  )}
                  {Array.isArray(data.prepaidPlans) && data.prepaidPlans.length > 0 && (
                    <div className="mb-3">
                      <SectionTitle>Prepaid Plans</SectionTitle>
                      {data.prepaidPlans.map((plan) => (
                        <div
                          key={plan.seriesParentId}
                          className="bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-2.5 mb-2"
                        >
                          <div className="flex items-center justify-between gap-2">
                            <div className="text-12 font-medium text-zinc-900 truncate">
                              {plan.serviceType}
                              {plan.recurringPattern ? ` · ${plan.recurringPattern}` : ""}
                            </div>
                            <span
                              className="inline-flex items-center rounded-full text-10 font-medium uppercase tracking-label"
                              style={{
                                height: 18,
                                padding: "0 8px",
                                background: plan.remainingVisits > 0 ? "#DCFCE7" : "#F4F4F5",
                                color: plan.remainingVisits > 0 ? "#166534" : "#52525B",
                              }}
                            >
                              {plan.remainingVisits > 0 ? "Active" : "Used"}
                            </span>
                          </div>
                          <div className="text-11 text-ink-secondary mt-1">
                            {plan.usedVisits} of {plan.paidVisits} used
                            {plan.remainingVisits > 0
                              ? ` · ${plan.remainingVisits} remaining`
                              : ""}
                            {" · "}${plan.perVisitAmount.toFixed(2)}/visit
                          </div>
                          <div className="text-11 text-ink-secondary mt-0.5">
                            Total ${plan.seriesTotal.toFixed(2)}
                            {plan.method ? ` · ${plan.method.replace(/_/g, " ")}` : ""}
                            {plan.nextVisitDate ? ` · next ${fmtDate(plan.nextVisitDate)}` : ""}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <SectionTitle>Recent Invoices</SectionTitle>
                  {invoices.slice(0, 3).map((inv, i) => (
                    <div
                      key={i}
                      className="py-1 text-12 border-b border-hairline border-zinc-200/60 flex justify-between"
                    >
                      {" "}
                      <span className="u-nums text-zinc-900">
                        {fmtCurrency(inv.amount_due)}
                      </span>{" "}
                      <span
                        className={cn(
                          "font-medium uppercase tracking-label text-10",
                          inv.status === "paid"
                            ? "text-zinc-900"
                            : "text-alert-fg",
                        )}
                      >
                        {inv.status}
                      </span>{" "}
                      <span className="text-ink-secondary">
                        {fmtDate(inv.created_at)}
                      </span>{" "}
                    </div>
                  ))}
                </div>
                {/* Col 3: Health + Referral + Discounts */}
                <div>
                  {" "}
                  <SectionTitle>Health Radar</SectionTitle>{" "}
                  <RadarChart data={radarData} />
                  {score != null && (
                    <div className="text-center text-12 text-ink-secondary mt-1">
                      Score:{" "}
                      <span
                        className="font-medium"
                        style={{
                          color:
                            score >= 70
                              ? "#10B981"
                              : score >= 40
                                ? "#F59E0B"
                                : "#C8312F",
                        }}
                      >
                        {score}/100
                      </span>
                      {(hs.churn_risk_level || hs.churn_risk) && (
                        <span>· {hs.churn_risk_level || hs.churn_risk}</span>
                      )}
                    </div>
                  )}
                  {referral && (
                    <div className="mt-4">
                      {" "}
                      <SectionTitle>Referral Stats</SectionTitle>{" "}
                      <div className="text-12 text-zinc-900">
                        Code:{" "}
                        <span className="u-nums">{c.referralCode}</span>{" "}
                      </div>
                      {referral.total_referrals != null && (
                        <div className="text-12 text-ink-secondary">
                          Referrals: {referral.total_referrals}
                        </div>
                      )}
                      {referral.total_earned != null && (
                        <div className="text-12 text-zinc-900">
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
                        <div key={i} className="text-12 text-zinc-900 py-0.5">
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
            </div>
          )}

          {/* SERVICES */}
          {activeTab === "services" && (
            <div>
              {" "}
              <SectionTitle>Service History ({services.length})</SectionTitle>
              {services.length === 0 ? (
                <div className="text-13 text-ink-secondary">
                  No service records
                </div>
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
                      className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 flex justify-between text-13"
                    >
                      {" "}
                      <span className="font-medium text-zinc-900">
                        {s.service_type}
                      </span>{" "}
                      <span className="text-ink-secondary">
                        {fmtDate(s.scheduled_date)}
                      </span>{" "}
                      <span
                        className={cn(
                          "text-11 uppercase tracking-label font-medium",
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
                  <SectionTitle>
                    Service Photos ({photos.length})
                  </SectionTitle>{" "}
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
            </div>
          )}

          {/* BILLING */}
          {activeTab === "billing" && (
            <div>
              {" "}
              <div className="c360-billing-grid grid grid-cols-4 gap-3 mb-5">
                {" "}
                <StatCardV2
                  label="Balance Owed"
                  value={fmtCurrency(balanceOwed)}
                  alert={balanceOwed > 0}
                />{" "}
                <StatCardV2
                  label="Monthly Rate"
                  value={fmtCurrency(c.monthlyRate)}
                />{" "}
                <StatCardV2
                  label="Annual Value"
                  value={fmtCurrency(c.annualValue)}
                />{" "}
                <StatCardV2
                  label="Lifetime Revenue"
                  value={fmtCurrency(c.lifetimeRevenue)}
                />{" "}
              </div>{" "}
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
              <SectionTitle>Invoices ({invoices.length})</SectionTitle>
              {invoices.length > 0 ? (
                <Table className="mb-5">
                  {" "}
                  <THead>
                    {" "}
                    <TR>
                      {" "}
                      <TH>Date</TH>
                      <TH align="right">Amount</TH>
                      <TH align="right">Paid</TH>
                      <TH>Status</TH>{" "}
                    </TR>{" "}
                  </THead>{" "}
                  <TBody>
                    {invoices.map((inv, i) => (
                      <TR key={i}>
                        {" "}
                        <TD>
                          {fmtDate(inv.created_at || inv.invoice_date)}
                        </TD>{" "}
                        <TD align="right" className="u-nums">
                          {fmtCurrency(inv.amount_due)}
                        </TD>{" "}
                        <TD align="right" className="u-nums">
                          {fmtCurrency(inv.amount_paid)}
                        </TD>{" "}
                        <TD>
                          {" "}
                          <Badge
                            tone={
                              inv.status === "paid" || inv.status === "prepaid"
                                ? "strong"
                                : "alert"
                            }
                          >
                            {inv.status}
                          </Badge>{" "}
                        </TD>{" "}
                      </TR>
                    ))}
                  </TBody>{" "}
                </Table>
              ) : (
                <div className="text-13 text-ink-secondary mb-5">
                  No invoices
                </div>
              )}
              <SectionTitle>Payment History ({payments.length})</SectionTitle>
              {payments.slice(0, 10).map((p, i) => {
                const isRefund = !!p.refund_status;
                const isFailed = p.status === "failed";
                return (
                  <div
                    key={i}
                    className="py-1.5 text-12 border-b border-hairline border-zinc-200/60 flex justify-between items-center gap-3"
                  >
                    {" "}
                    <span
                      className={cn(
                        "u-nums",
                        isRefund ? "text-ink-secondary" : "text-zinc-900",
                      )}
                    >
                      {fmtCurrency(p.amount)}
                    </span>{" "}
                    <span className="text-ink-secondary">
                      {p.card_brand} …{p.last_four}
                    </span>{" "}
                    <span className="text-ink-secondary">
                      {fmtDate(p.payment_date)}
                    </span>{" "}
                    <Badge tone={isRefund || isFailed ? "alert" : "neutral"}>
                      {isRefund ? "Refunded" : (p.status || "").toUpperCase()}
                    </Badge>
                    {isAdmin &&
                      p.processor === "stripe" &&
                      p.status === "paid" &&
                      !isRefund && (
                        <Button
                          size="sm"
                          variant="danger"
                          onClick={async () => {
                            if (
                              !window.confirm(
                                `Refund $${parseFloat(p.amount).toFixed(2)} to ${c.firstName} ${c.lastName}?`,
                              )
                            )
                              return;
                            try {
                              await adminFetch(
                                `/admin/customers/${c.id}/refund`,
                                {
                                  method: "POST",
                                  body: JSON.stringify({
                                    paymentId: p.id,
                                    amount: parseFloat(p.amount),
                                    reason: "requested_by_customer",
                                  }),
                                },
                              );
                              const fresh = await adminFetch(
                                `/admin/customers/${customerId}`,
                              );
                              setData(fresh);
                            } catch (err) {
                              alert("Refund failed: " + err.message);
                            }
                          }}
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
                      className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 text-13 flex justify-between items-center"
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
                      {cd.is_default && <Badge tone="strong">Default</Badge>}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* CONTRACTS */}
          {activeTab === "contracts" && (
            <ElectronicAuthorizationContractV2
              customer={c}
              consents={paymentMethodConsents}
              cards={cards}
              contracts={contracts}
              onRefresh={reloadCustomer}
            />
          )}

          {/* COMMS */}
          {activeTab === "comms" && (
            <div className="flex flex-col h-full">
              {" "}
              <SectionTitle>Thread ({comms.length})</SectionTitle>{" "}
              <div className="flex-1 overflow-y-auto flex flex-col gap-1.5 mb-3 max-h-[400px]">
                {commsLoading && (
                  <div className="text-ink-secondary text-13 text-center py-5">
                    Loading messages…
                  </div>
                )}
                {commsErr && (
                  <div className="text-alert-fg text-13 text-center py-5">
                    {commsErr}
                  </div>
                )}
                {[...comms].reverse().map((m, i) => {
                  const inbound = m.direction === "inbound";
                  if (m.channel === "sms") {
                    return (
                      <div
                        key={m.id || i}
                        className={cn(
                          "max-w-[75%] px-3 py-2 text-13 leading-relaxed border-hairline",
                          inbound
                            ? "self-start bg-zinc-50 border-zinc-200 text-zinc-900 rounded-sm rounded-bl-xs"
                            : "self-end bg-zinc-900 border-zinc-900 text-white rounded-sm rounded-br-xs",
                        )}
                      >
                        {" "}
                        <div>{m.body}</div>{" "}
                        <div
                          className={cn(
                            "text-10 mt-1 text-right",
                            inbound ? "text-ink-secondary" : "text-zinc-300",
                          )}
                        >
                          {timeAgo(m.createdAt)}
                        </div>{" "}
                      </div>
                    );
                  }
                  // voice
                  const rec = (m.media || []).find(
                    (x) => x.type === "recording",
                  );
                  const duration = fmtDur(
                    m.durationSeconds ?? rec?.duration_seconds,
                  );
                  const summary = m.aiSummary || m.body;
                  return (
                    <div
                      key={m.id || i}
                      className={cn(
                        "max-w-[85%] px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm",
                        inbound ? "self-start" : "self-end",
                      )}
                    >
                      {" "}
                      <div className="flex items-center gap-2 mb-1">
                        {" "}
                        <span className="text-10 font-medium tracking-label uppercase text-ink-secondary">
                          {inbound ? "Call in" : "Call out"}
                        </span>
                        {duration && (
                          <span className="text-11 u-nums text-zinc-900">
                            {duration}
                          </span>
                        )}
                        {m.answeredBy && (
                          <span className="text-10 text-ink-secondary">
                            · {m.answeredBy}
                          </span>
                        )}
                      </div>
                      {summary && (
                        <div className="text-12 text-zinc-900 leading-relaxed">
                          {summary}
                        </div>
                      )}
                      {rec?.url && rec?.sid && (
                        <audio
                          controls
                          src={`${API_BASE}/admin/call-recordings/audio/${rec.sid}?token=${encodeURIComponent(localStorage.getItem("waves_admin_token") || "")}`}
                          className="mt-1.5 w-full h-8"
                        />
                      )}
                      <div className="text-10 mt-1 text-right text-ink-secondary">
                        {timeAgo(m.createdAt)}
                      </div>{" "}
                    </div>
                  );
                })}
                {!commsLoading &&
                  !commsErr &&
                  commsLoaded &&
                  comms.length === 0 && (
                    <div className="text-ink-secondary text-13 text-center py-5">
                      No messages
                    </div>
                  )}
              </div>
              {c.phone && (
                <div className="py-3 border-t border-hairline border-zinc-200">
                  {" "}
                  <div className="flex gap-2">
                    {" "}
                    <input
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
                      className="flex-1 h-10 px-3.5 bg-white border-hairline border-zinc-300 rounded-sm text-13 text-zinc-900 u-focus-ring"
                    />{" "}
                    <Button
                      onClick={sendSms}
                      disabled={sendingSms || !smsReply.trim()}
                    >
                      {sendingSms ? "…" : "Send"}
                    </Button>{" "}
                  </div>
                  {smsErr && (
                    <div className="mt-1.5 text-12 text-alert-fg">{smsErr}</div>
                  )}
                </div>
              )}
              {/* Notification preferences — admin override for routing fields
                  ops needs to manage landlord / tenant / AP-contact accounts. */}
              <div className="mt-4">
                {" "}
                <SectionTitle>Contacts &amp; Recipients</SectionTitle>{" "}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-2 mb-3">
                  <div className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm">
                    <div className="text-10 uppercase tracking-label text-ink-tertiary">
                      Account owner / payer
                    </div>
                    <div className="text-12 font-medium text-zinc-900 mt-1">
                      {[c.firstName, c.lastName].filter(Boolean).join(" ") ||
                        c.companyName ||
                        "Customer"}
                    </div>
                    <div className="text-12 text-ink-secondary break-all">
                      {c.email || "No email"}
                    </div>
                  </div>
                  <div className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm">
                    <div className="text-10 uppercase tracking-label text-ink-tertiary">
                      On-location contact
                    </div>
                    <div className="text-12 font-medium text-zinc-900 mt-1">
                      {c.serviceContactName || "Primary customer"}
                    </div>
                    <div className="text-12 text-ink-secondary break-all">
                      {c.serviceContactEmail ||
                        c.serviceContactPhone ||
                        c.email ||
                        "No contact"}
                    </div>
                  </div>
                  <div className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm">
                    <div className="text-10 uppercase tracking-label text-ink-tertiary">
                      Invoice email
                    </div>
                    <div className="text-12 font-medium text-zinc-900 mt-1">
                      {recipientPrefsDraft.billingContactName || "Billing recipient"}
                    </div>
                    <div className="text-12 text-ink-secondary break-all">
                      {recipientPrefsDraft.billingEmail || c.email || "No email"}
                    </div>
                  </div>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
                  <label className="block">
                    <span className="u-label text-ink-tertiary block mb-1">
                      Billing contact name
                    </span>
                    <input
                      id="c360-billing-contact-name"
                      name="billingContactName"
                      value={recipientPrefsDraft.billingContactName}
                      onChange={(e) =>
                        setRecipientPrefsDraft((prev) => ({
                          ...prev,
                          billingContactName: e.target.value,
                        }))
                      }
                      placeholder="Landlord, AP contact, property manager"
                      className="block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-9 px-2.5 focus:outline-none focus:border-zinc-900"
                    />
                  </label>
                  <label className="block">
                    <span className="u-label text-ink-tertiary block mb-1">
                      Billing recipient email
                    </span>
                    <input
                      id="c360-billing-recipient-email"
                      name="billingEmail"
                      value={recipientPrefsDraft.billingEmail}
                      onChange={(e) =>
                        setRecipientPrefsDraft((prev) => ({
                          ...prev,
                          billingEmail: e.target.value,
                        }))
                      }
                      type="email"
                      placeholder={c.email || "billing@example.com"}
                      className="block w-full bg-white text-13 text-ink-primary border-hairline border-zinc-300 rounded-sm h-9 px-2.5 focus:outline-none focus:border-zinc-900"
                    />
                  </label>
                </div>
                <div className="flex items-center justify-between gap-3 mb-3">
                  <div className="text-12 text-ink-secondary">
                    Invoices and receipts use the billing email when set.
                    Appointment reminders and service reports use the
                    on-location contact when present.
                  </div>
                  <Button
                    onClick={saveRecipientPrefs}
                    disabled={recipientPrefsSaving}
                    className="shrink-0"
                  >
                    {recipientPrefsSaving ? "Saving..." : "Save Recipients"}
                  </Button>
                </div>
                {recipientPrefsErr && (
                  <div className="mb-3 text-12 text-alert-fg">
                    {recipientPrefsErr}
                  </div>
                )}
                <label className="flex items-start gap-2 px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 cursor-pointer">
                  {" "}
                  <input
                    id="c360-appointment-notify-primary"
                    name="appointmentNotifyPrimary"
                    type="checkbox"
                    className="mt-0.5"
                    checked={notificationPrefs.appointment_notify_primary === true}
                    onChange={(e) =>
                      updateNotificationPrefs({
                        appointmentNotifyPrimary: e.target.checked,
                        appointment_notify_primary: e.target.checked,
                      })
                    }
                  />{" "}
                  <div>
                    {" "}
                    <div className="text-12 font-medium text-zinc-900">
                      Also send appointment SMS to the account owner
                    </div>{" "}
                    <div className="text-12 text-ink-secondary">
                      When an on-location contact has a different phone, they
                      receive appointment reminders by default. Turn this on to
                      copy the payer too.
                    </div>{" "}
                  </div>{" "}
                </label>{" "}
                <label className="flex items-start gap-2 px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 cursor-pointer">
                  {" "}
                  <input
                    id="c360-service-report-notify-primary"
                    name="serviceReportNotifyPrimary"
                    type="checkbox"
                    className="mt-0.5"
                    checked={notificationPrefs.service_report_notify_primary === true}
                    onChange={(e) =>
                      updateNotificationPrefs({
                        serviceReportNotifyPrimary: e.target.checked,
                        service_report_notify_primary: e.target.checked,
                      })
                    }
                  />{" "}
                  <div>
                    {" "}
                    <div className="text-12 font-medium text-zinc-900">
                      Also email service reports to the account owner
                    </div>{" "}
                    <div className="text-12 text-ink-secondary">
                      If off, a distinct service-contact email receives the
                      report and the payer stays on billing-only messages.
                    </div>{" "}
                  </div>{" "}
                </label>{" "}
                <label className="flex items-start gap-2 px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 cursor-pointer">
                  {" "}
                  <input
                    id="c360-auto-flip-en-route"
                    name="autoFlipEnRoute"
                    type="checkbox"
                    className="mt-0.5"
                    checked={
                      notificationPrefs.auto_flip_en_route !== false
                    }
                    onChange={(e) => {
                      const next = e.target.checked;
                      updateNotificationPrefs({
                        autoFlipEnRoute: next,
                        auto_flip_en_route: next,
                      });
                    }}
                  />{" "}
                  <div>
                    {" "}
                    <div className="text-12 font-medium text-zinc-900">
                      Auto-flip en route SMS
                    </div>{" "}
                    <div className="text-12 text-ink-secondary">
                      When the tech&apos;s vehicle leaves a previous job area
                      and the next job is this customer, fire the &quot;on the
                      way&quot; SMS automatically. Off here = customer keeps
                      manual en-route SMS but skips auto-flip.
                    </div>{" "}
                  </div>{" "}
                </label>{" "}
              </div>{" "}
              <div className="mt-4">
                {" "}
                <SectionTitle>
                  Notes &amp; Interactions ({(data.interactions || []).length})
                </SectionTitle>
                {(data.interactions || []).slice(0, 10).map((n, i) => (
                  <div
                    key={i}
                    className="px-3 py-2 bg-zinc-50 border-hairline border-zinc-200 rounded-sm mb-1.5 text-12"
                  >
                    {" "}
                    <div className="flex justify-between mb-1">
                      {" "}
                      <span className="font-medium text-zinc-900">
                        {n.interaction_type}: {n.subject}
                      </span>{" "}
                      <span className="text-ink-secondary text-10">
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
              </div>{" "}
            </div>
          )}

          {/* PROPERTY */}
          {activeTab === "property" && (
            <div>
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
                      href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${c.address.line1}, ${c.address.city}, ${c.address.state} ${c.address.zip}`)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="block p-5 bg-zinc-50 text-center text-13 text-zinc-900 hover:bg-zinc-100 u-focus-ring"
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
                          className="flex justify-between py-1 text-12 border-b border-hairline border-zinc-200/60"
                        >
                          {" "}
                          <span className="text-ink-secondary">
                            {label}
                          </span>{" "}
                          <span className="text-zinc-900 u-nums">
                            {val}
                          </span>{" "}
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
                          className="flex justify-between py-1 text-12 border-b border-hairline border-zinc-200/60 gap-2"
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
          )}

          {/* COMPLIANCE */}
          {activeTab === "compliance" && (
            <div>
              {" "}
              <SectionTitle>Nutrient Ledger YTD</SectionTitle>{" "}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-5">
                {" "}
                <Card>
                  {" "}
                  <CardBody className="p-4">
                    {" "}
                    <div className="text-10 uppercase tracking-label text-ink-secondary mb-1">
                      Nitrogen
                    </div>{" "}
                    <div className="u-nums text-22 font-semibold text-zinc-900">
                      {fmtNumber(nutrientSummary.nApplied)}
                    </div>{" "}
                    <div className="text-11 text-ink-secondary">
                      lb N / 1k sqft
                    </div>{" "}
                  </CardBody>{" "}
                </Card>{" "}
                <Card>
                  {" "}
                  <CardBody className="p-4">
                    {" "}
                    <div className="text-10 uppercase tracking-label text-ink-secondary mb-1">
                      Phosphorus
                    </div>{" "}
                    <div className="u-nums text-22 font-semibold text-zinc-900">
                      {fmtNumber(nutrientSummary.pApplied)}
                    </div>{" "}
                    <div className="text-11 text-ink-secondary">
                      lb P / 1k sqft
                    </div>{" "}
                  </CardBody>{" "}
                </Card>{" "}
                <Card>
                  {" "}
                  <CardBody className="p-4">
                    {" "}
                    <div className="text-10 uppercase tracking-label text-ink-secondary mb-1">
                      Potassium
                    </div>{" "}
                    <div className="u-nums text-22 font-semibold text-zinc-900">
                      {fmtNumber(nutrientSummary.kApplied)}
                    </div>{" "}
                    <div className="text-11 text-ink-secondary">
                      lb K / 1k sqft
                    </div>{" "}
                  </CardBody>{" "}
                </Card>{" "}
                <Card>
                  {" "}
                  <CardBody className="p-4">
                    {" "}
                    <div className="text-10 uppercase tracking-label text-ink-secondary mb-1">
                      Entries
                    </div>{" "}
                    <div className="u-nums text-22 font-semibold text-zinc-900">
                      {nutrientSummary.entries || 0}
                    </div>{" "}
                    <div className="text-11 text-ink-secondary">
                      {nutrientLedger.year || new Date().getFullYear()}
                    </div>{" "}
                  </CardBody>{" "}
                </Card>{" "}
              </div>
              {nutrientRows.length > 0 && (
                <Table className="mb-5">
                  {" "}
                  <THead>
                    {" "}
                    <TR>
                      {" "}
                      <TH>Date</TH>
                      <TH>Product</TH>
                      <TH>Analysis</TH>
                      <TH>N/P/K per 1k</TH>
                      <TH>Blackout</TH>{" "}
                    </TR>{" "}
                  </THead>{" "}
                  <TBody>
                    {nutrientRows.map((r) => (
                      <TR key={r.id}>
                        {" "}
                        <TD>{fmtDate(r.application_date)}</TD>{" "}
                        <TD className="text-zinc-900">{r.product_name}</TD>{" "}
                        <TD className="u-nums">{r.analysis || "—"}</TD>{" "}
                        <TD className="u-nums">
                          {fmtNumber(r.n_applied_per_1000)} /{" "}
                          {fmtNumber(r.p_applied_per_1000)} /{" "}
                          {fmtNumber(r.k_applied_per_1000)}
                        </TD>{" "}
                        <TD>{r.blackout_status || "—"}</TD>{" "}
                      </TR>
                    ))}
                  </TBody>{" "}
                </Table>
              )}
              <SectionTitle>
                Application History ({compliance.length})
              </SectionTitle>
              {compliance.length > 0 ? (
                <Table className="mb-5">
                  {" "}
                  <THead>
                    {" "}
                    <TR>
                      {" "}
                      <TH>Date</TH>
                      <TH>Product</TH>
                      <TH>Rate</TH>
                      <TH>Area</TH>
                      <TH>Technician</TH>{" "}
                    </TR>{" "}
                  </THead>{" "}
                  <TBody>
                    {compliance.map((r, i) => (
                      <TR key={i}>
                        {" "}
                        <TD>{fmtDate(r.applied_at)}</TD>{" "}
                        <TD className="text-zinc-900">
                          {r.product_name || r.product_id}
                        </TD>{" "}
                        <TD className="u-nums">
                          {r.rate_per_1000_sqft
                            ? `${r.rate_per_1000_sqft}/1k sqft`
                            : "—"}
                        </TD>{" "}
                        <TD>{r.area_treated || "—"}</TD>{" "}
                        <TD>{r.technician_name || "—"}</TD>{" "}
                      </TR>
                    ))}
                  </TBody>{" "}
                </Table>
              ) : (
                <div className="text-13 text-ink-secondary">
                  No application records
                </div>
              )}
              <Card className="mt-5">
                {" "}
                <CardBody className="p-4">
                  {" "}
                  <SectionTitle>Product Limits</SectionTitle>{" "}
                  <div className="text-12 text-ink-secondary space-y-1">
                    {" "}
                    <div>
                      Celsius applications this year:{" "}
                      <span className="u-nums text-zinc-900">
                        {
                          compliance.filter((r) =>
                            (r.product_name || "")
                              .toLowerCase()
                              .includes("celsius"),
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
              </Card>{" "}
            </div>
          )}
        </div>
        {/* ZONE 4 — TIMELINE */}
        <div className="border-t border-hairline border-zinc-200 px-6 py-4 bg-zinc-50">
          {" "}
          <div className="flex justify-between items-center mb-2.5 flex-wrap gap-2">
            {" "}
            <SectionTitle className="mb-0">
              Timeline ({filteredTimeline.length})
            </SectionTitle>{" "}
            <div className="flex gap-1 flex-wrap">
              {[
                { key: "all", label: "All" },
                { key: "sms", label: "SMS" },
                { key: "call", label: "Calls" },
                { key: "service", label: "Services" },
                { key: "payment", label: "Payments" },
                { key: "notes", label: "Notes" },
              ].map((f) => (
                <button
                  key={f.key}
                  onClick={() => setTimelineFilter(f.key)}
                  className={cn(
                    "h-6 px-2.5 text-10 uppercase tracking-label font-medium rounded-xs border-hairline u-focus-ring transition-colors",
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
          <div className="max-h-[250px] overflow-y-auto flex flex-col">
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
                  className="flex gap-2.5 py-1.5 border-b border-hairline border-zinc-200/60 text-12 items-center"
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
                  <span className="text-ink-secondary text-10 u-nums flex-shrink-0">
                    {timeAgo(item.date)}
                  </span>{" "}
                </div>
              );
            })}
            {filteredTimeline.length === 0 && (
              <div className="text-ink-secondary text-12 text-center py-4">
                No timeline events
              </div>
            )}
          </div>{" "}
        </div>
        {/* Mobile spacer for sticky action bar */}
        <div
          className="c360-mobile-footer-spacer"
          style={{ height: "calc(56px + env(safe-area-inset-bottom, 0px))" }}
          aria-hidden="true"
        />{" "}
      </div>
      {/* Mobile sticky action bar (mirrors desktop pills) */}
      <CustomerActionBar
        customer={{
          id: customerId,
          phone: c.phone,
          email: c.email,
          firstName: c.firstName,
          lastName: c.lastName,
          address: c.address
            ? [c.address.line1, c.address.city, c.address.state, c.address.zip]
                .filter(Boolean)
                .join(", ")
            : "",
        }}
        standalone
      />
      {annualPrepayOpen && (
        <AnnualPrepayModal
          customer={c}
          activeTerm={displayedAnnualPrepayTerm}
          prepaidPlans={data.prepaidPlans || []}
          annualPrepayTerms={data.annualPrepayTerms || []}
          onClose={() => setAnnualPrepayOpen(false)}
          onSaved={handleAnnualPrepaySaved}
        />
      )}
      {annualPrepayInvoiceOpen && (
        <AnnualPrepayInvoiceModal
          customer={c}
          activeTerm={displayedAnnualPrepayTerm}
          prepaidPlans={data.prepaidPlans || []}
          annualPrepayTerms={data.annualPrepayTerms || []}
          onClose={() => setAnnualPrepayInvoiceOpen(false)}
          onSaved={handleAnnualPrepaySaved}
        />
      )}
      {editOpen && (
        <div
          className="fixed inset-0 bg-black/70 z-[1100] flex items-start sm:items-center justify-center p-4 overflow-y-auto"
          onClick={() => !savingEdit && setEditOpen(false)}
        >
          {" "}
          <div
            className="bg-white w-full max-w-[560px] rounded-sm border-hairline border-zinc-300 my-4"
            onClick={(e) => e.stopPropagation()}
          >
            {" "}
            <div className="flex items-center justify-between px-4 py-3 border-b border-hairline border-zinc-200">
              {" "}
              <div className="text-15 font-medium text-zinc-900">
                Edit customer
              </div>{" "}
              <button
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
                { key: "city", label: "City" },
                { key: "state", label: "State" },
                { key: "zip", label: "ZIP" },
                { key: "monthlyRate", label: "Monthly rate", type: "number" },
              ].map((f) => (
                <div key={f.key} className={f.full ? "sm:col-span-2" : ""}>
                  {" "}
                  <label className="u-label text-ink-secondary block mb-1">
                    {f.label}
                  </label>{" "}
                  <input
                    type={f.type || "text"}
                    value={editForm[f.key] ?? ""}
                    onChange={(e) =>
                      setEditForm((p) => ({ ...p, [f.key]: e.target.value }))
                    }
                    className="w-full h-9 px-2.5 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
                  />{" "}
                </div>
              ))}
              <div>
                {" "}
                <label className="u-label text-ink-secondary block mb-1">
                  Tier
                </label>{" "}
                <select
                  value={editForm.tier || ""}
                  onChange={(e) =>
                    setEditForm((p) => ({ ...p, tier: e.target.value }))
                  }
                  className="w-full h-9 px-2 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
                >
                  {" "}
                  <option value="">No Plan</option>{" "}
                  <option value="Platinum">Platinum</option>{" "}
                  <option value="Gold">Gold</option>{" "}
                  <option value="Silver">Silver</option>{" "}
                  <option value="Bronze">Bronze</option>{" "}
                  <option value="One-Time">One-Time</option>{" "}
                </select>{" "}
              </div>{" "}
              <div>
                {" "}
                <label className="u-label text-ink-secondary block mb-1">
                  Stage
                </label>{" "}
                <select
                  value={editForm.pipelineStage || ""}
                  onChange={(e) =>
                    setEditForm((p) => ({
                      ...p,
                      pipelineStage: e.target.value,
                    }))
                  }
                  className="w-full h-9 px-2 text-13 text-zinc-900 bg-white border-hairline border-zinc-300 rounded-sm u-focus-ring"
                >
                  {Object.entries(STAGE_LABELS).map(([k, label]) => (
                    <option key={k} value={k}>
                      {label}
                    </option>
                  ))}
                </select>{" "}
              </div>{" "}
            </div>
            {editErr && (
              <div className="mx-4 mb-3 px-2.5 py-1.5 bg-alert-bg text-alert-fg rounded-xs text-12">
                {editErr}
              </div>
            )}
            <div className="flex items-center justify-between gap-2 px-4 py-3 border-t border-hairline border-zinc-200">
              {" "}
              <button
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
                      const payload = {
                        ...editForm,
                        monthlyRate:
                          editForm.monthlyRate === ""
                            ? null
                            : parseFloat(editForm.monthlyRate),
                        tier: editForm.tier || null,
                      };
                      await adminFetch(`/admin/customers/${customerId}`, {
                        method: "PUT",
                        body: JSON.stringify(payload),
                      });
                      await reloadCustomer();
                      setEditOpen(false);
                    } catch (e) {
                      setEditErr(e.message || "Save failed");
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
      )}
    </div>
  );
}
