import React, {
  useState,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  createContext,
  useContext,
  Component,
} from "react";
import {
  applyServerLawnPricingConfig,
  applyServerPestPricingConfig,
  applyServerTermiteBondPricingConfig,
  applyServerTermiteRentalPricingConfig,
  applyServerTermiteMonitoringPricingConfig,
  applyServerTermiteInstallPricingConfig,
  applyServerRodentBaitBracketsPricingConfig,
  applyServerRodentSetupFeePricingConfig,
  applyServerRodentWaveguardPricingConfig,
  calculateEstimate,
  rodentBaitBracketForFootprint,
  rodentBaitPolicyNote,
  rodentBaitWaveguardFlags,
  collectMarginReviewNotes,
  fmt,
  fmtInt,
  isCommercialEstimateInput,
  resolveLookupPropertyTypeAutofill,
  termiteBaitSelectionLabel,
  termiteBaitSystemLabel,
} from "../../lib/estimateEngine";
import { LeadsSection } from "./LeadsTabs";
import PricingLogicPanel from "../../components/admin/PricingLogicPanel";
import { MarginCalculator } from "./PricingLogicPage";
import PestProductionDiagnosticsPanel from "../../components/admin/PestProductionDiagnosticsPanel";
import {
  buildManualDiscountPayload,
  buildServiceSpecificDiscountPayloads,
  discountPresetAmountLabel,
  isCustomDiscountTemplate,
  isEstimatorManualDiscount,
  isServiceSpecificCredit,
  manualDiscountTypeForCatalogRow,
} from "../../lib/discountCatalog";
import { humanizeQuoteReason, quoteRequiredReasonNote } from "../../lib/quoteDisplay";
import { palmPrefillAllowed } from "../../lib/lookupPrefill";
import { createPortal } from "react-dom";
import useIsMobile from "../../hooks/useIsMobile";

const COMMERCIAL_WARNING_TEXT =
  "Commercial property detected. Residential lawn and pest pricing is not valid. Manual quote required unless small-commercial pilot pricing is enabled.";

// Form keys that change WHO/HOW a saved estimate is delivered but never its
// pricing — the only edits saveAndSend may re-save in place without a fresh
// Generate Estimate.
const SEND_ONLY_RESAVE_KEYS = new Set([
  "customerName",
  "customerPhone",
  "customerEmail",
  "notes",
  "scheduleSend",
  "scheduledAt",
]);

const DETHATCHING_ESTIMATE_RESET_FIELDS = new Set([
  "dethatchingCleanupLevel",
  "dethatchingDebrisRemovalIncluded",
  "dethatchingAccess",
  "dethatchingManagerApproved",
  "dethatchingManagerApprovalReason",
  "grassType",
  "thatchProbe1Inches",
  "thatchProbe2Inches",
  "thatchProbe3Inches",
  "thatchDepthInches",
  "thatchMeasurementSource",
  // Commercial cadence: changing the business type re-prices pest/rodent, so it
  // must invalidate a generated estimate (else Save persists stale totals).
  "commercialRiskType",
  "treeShrubDensity",
  "mosquitoPressure",
]);

const TRENCHING_PRODUCT_OPTIONS = [
  { value: "taurus_sc", label: "Taurus SC - Fipronil, standard non-repellent" },
  { value: "termidor_sc", label: "Termidor SC - Fipronil, premium non-repellent" },
  { value: "bifen_it", label: "Bifen I/T - Bifenthrin, standard repellent barrier" },
  { value: "talstar_p", label: "Talstar P / Pro - Bifenthrin, branded repellent barrier" },
];

const TRENCHING_PRODUCT_META = {
  termidor_sc: {
    warning: "Premium fipronil non-repellent trench treatment. Eligible for longer warranty tiers with product premium surcharge.",
    config: "78 oz @ $375 | 0.8 oz / finished gal standard",
  },
  taurus_sc: {
    warning: "Default fipronil non-repellent trench treatment. Existing LF pricing includes Taurus standard-rate chemistry.",
    config: "78 oz @ $85 | 0.8 oz / finished gal standard",
  },
  bifen_it: {
    warning: "Repellent bifenthrin barrier. 3-year warranty requires review; 5-year repair-and-retreat is quote-required by default.",
    config: "96 oz @ $55 | 1.0 oz / finished gal standard",
  },
  talstar_p: {
    warning: "Branded bifenthrin repellent barrier. 3-year warranty requires review; 5-year repair-and-retreat is quote-required by default.",
    config: "96 oz @ $65 | 1.0 oz / finished gal standard",
  },
};

const PRE_SLAB_PRODUCT_OPTIONS = [
  { value: "termidor_sc", label: "Termidor SC - Fipronil, premium non-repellent" },
  { value: "taurus_sc", label: "Taurus SC - Fipronil, standard non-repellent" },
  { value: "bifen_it", label: "Bifen I/T - Bifenthrin, standard repellent barrier" },
  { value: "talstar_p", label: "Talstar P - Bifenthrin, branded repellent barrier" },
];

const PRE_SLAB_JOB_CONTEXT_OPTIONS = [
  { value: "standalone", label: "Standalone one-off job" },
  { value: "builderBatch", label: "Builder batch / same site" },
  { value: "sameTripAddOn", label: "Same-trip add-on" },
];

const PRE_SLAB_PRODUCT_META = {
  termidor_sc: {
    warning: "Premium fipronil non-repellent pre-slab treatment. Confirm label rate and builder documentation requirements.",
    config: "78 oz @ $174.72 | 0.8 oz / 10 sqft | 100 sqft usage steps + contextual minimum",
  },
  taurus_sc: {
    warning: "Value fipronil non-repellent pre-slab treatment. Confirm label rate and product configuration.",
    config: "78 oz @ $95.00 | 0.8 oz / 10 sqft | 100 sqft usage steps + contextual minimum",
  },
  bifen_it: {
    warning: "Bifenthrin repellent barrier. Not equivalent to non-repellent fipronil positioning. Confirm label supports pre-construction subterranean termite treatment.",
    config: "128 oz @ $41.53 | 1.0 oz / 10 sqft | 100 sqft usage steps + contextual minimum",
  },
  talstar_p: {
    warning: "Branded bifenthrin repellent barrier. Confirm exact Talstar P label and rate before treatment.",
    config: "128 oz @ $38.99 | 1.0 oz / 10 sqft | 100 sqft usage steps + contextual minimum",
  },
};

function resolvePreSlabJobContextForForm(form) {
  if (form?._preslabJobContextEdited) return form.preslabJobContext || "standalone";
  const volume = String(form?.preslabVolume || "NONE").trim().toUpperCase();
  return volume === "5" || volume === "10" || volume === "5PLUS" || volume === "10PLUS"
    ? "builderBatch"
    : "standalone";
}

const AI_SOURCE_LABELS = {
  claude: "Claude",
  openai: "ChatGPT",
  gemini: "Gemini",
};

function normalizeAiSources(sources) {
  const raw = Array.isArray(sources)
    ? sources
    : typeof sources === "string"
      ? sources.split(/[+,]/)
      : [];
  return raw
    .map((source) => String(source || "").trim().toLowerCase())
    .filter(Boolean);
}

function formatAiSources(sources) {
  return normalizeAiSources(sources)
    .map((source) => AI_SOURCE_LABELS[source] || source)
    .join(" + ");
}

function isExpectedAiTimeout(message) {
  return /timed out after \d+ms/i.test(String(message || ""));
}

function buildAiProviderWarnings({ sources, errors = [], providerStatus = {} } = {}) {
  const normalizedSources = normalizeAiSources(sources);
  const warnings = [];
  if (!normalizedSources.includes("openai")) {
    const openaiError = errors.find((error) => error?.source === "openai");
    const openaiStatus = providerStatus.openai;
    if (openaiError?.message) {
      if (!isExpectedAiTimeout(openaiError.message)) {
        warnings.push(`ChatGPT skipped: ${openaiError.message}`);
      }
    } else if (openaiStatus === false || openaiStatus?.configured === false) {
      warnings.push("ChatGPT skipped: OPENAI_API_KEY is not configured");
    } else if (openaiStatus?.available === false) {
      warnings.push("ChatGPT skipped: OpenAI returned no usable analysis");
    }
  }
  return warnings;
}

function estimateRequiresQuote(value, depth = 0) {
  if (!value || depth > 12) return false;
  if (Array.isArray(value)) {
    return value.some((item) => estimateRequiresQuote(item, depth + 1));
  }
  if (typeof value !== "object") return false;
  if (value.quoteRequired === true || value.requiresCustomQuote === true) {
    return true;
  }
  return Object.values(value).some((item) => estimateRequiresQuote(item, depth + 1));
}

function quoteRequiredDetailText(item = {}, existingText = "") {
  return quoteRequiredReasonNote(item, existingText, "Requires review before final pricing.");
}

class EstimateErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[EstimatePage crash]", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            padding: 40,
            background: "#FFFFFF",
            border: "1px solid #C0392B",
            borderRadius: 12,
            textAlign: "center",
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 18,
              fontWeight: 700,
              color: "#C0392B",
              marginBottom: 12,
            }}
          >
            Estimate render error
          </div>{" "}
          <div
            style={{
              fontSize: 13,
              color: "#64748B",
              marginBottom: 16,
              fontFamily: "'JetBrains Mono', monospace",
              whiteSpace: "pre-wrap",
              textAlign: "left",
              maxHeight: 200,
              overflow: "auto",
            }}
          >
            {this.state.error.message}
            {"\n"}
            {this.state.error.stack}
          </div>{" "}
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              padding: "8px 20px",
              background: "#0A7EC2",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              fontSize: 14,
              cursor: "pointer",
            }}
          >
            Try Again
          </button>{" "}
        </div>
      );
    }
    return this.props.children;
  }
}

/* ── theme tokens ───────────────────────────────────────────── */
const C = {
  dark: "#F1F5F9",
  navy: "#F0F7FC",
  card: "#FFFFFF",
  border: "#E2E8F0",
  teal: "#0A7EC2",
  green: "#16A34A",
  amber: "#F0A500",
  red: "#C0392B",
  blue: "#2563eb",
  white: "#334155",
  gray: "#64748B",
  input: "#FFFFFF",
  heading: "#0F172A",
  inputBorder: "#CBD5E1",
  radius: "10px",
};

/* ── inline style helpers ───────────────────────────────────── */
const sPanel = {
  background: C.card,
  border: `1px solid ${C.border}`,
  borderRadius: C.radius,
  padding: 22,
  marginBottom: 18,
};
const sPanelTitle = {
  fontSize: 15,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 1.5,
  color: C.teal,
  marginBottom: 18,
  paddingBottom: 10,
  borderBottom: `1px solid ${C.border}`,
};
const sLabel = {
  display: "block",
  fontSize: 13,
  fontWeight: 500,
  color: C.gray,
  marginBottom: 6,
  textTransform: "uppercase",
  letterSpacing: 0.8,
};
const sInput = {
  width: "100%",
  padding: "12px 14px",
  background: C.input,
  border: `1px solid ${C.inputBorder}`,
  borderRadius: C.radius,
  color: C.heading,
  fontFamily: "'Roboto', Arial, sans-serif",
  fontSize: 16,
  minHeight: 46,
  boxSizing: "border-box",
  outline: "none",
};
const sSelect = {
  ...sInput,
  cursor: "pointer",
  WebkitAppearance: "none",
  appearance: "none",
  backgroundImage:
    "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' fill='%2394a3b8' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E\")",
  backgroundRepeat: "no-repeat",
  backgroundPosition: "right 14px center",
  paddingRight: 36,
};
const sField = { marginBottom: 16 };
const sRow = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 };
const sRow3 = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 14 };
const sCheckbox = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  marginBottom: 10,
  cursor: "pointer",
  fontSize: 15,
  color: C.heading,
};
const sCb = {
  width: 20,
  height: 20,
  accentColor: C.teal,
  cursor: "pointer",
  flexShrink: 0,
};
const sSvcSection = {
  fontSize: 12,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 1.2,
  color: C.amber,
  margin: "18px 0 10px 0",
  paddingBottom: 6,
  borderBottom: `1px solid rgba(245,158,11,0.2)`,
};
const sSubOpts = {
  margin: "6px 0 10px 30px",
  padding: "10px 14px",
  background: C.input,
  borderRadius: 8,
  border: `1px solid ${C.border}`,
};
const sBtn = (bg, fg) => ({
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "14px 28px",
  border: "none",
  borderRadius: C.radius,
  fontFamily: "'Roboto', Arial, sans-serif",
  fontSize: 16,
  fontWeight: 700,
  cursor: "pointer",
  width: "100%",
  textDecoration: "none",
  background: bg,
  color: fg,
  transition: "all 0.2s",
});
const sBtnSm = (bg, fg) => ({
  ...sBtn(bg, fg),
  padding: "10px 18px",
  fontSize: 14,
});

/* ── result display helpers ─────────────────────────────────── */
const sTierRow = (rec, dim, clickable, sel) => ({
  display: "grid",
  gridTemplateColumns: "120px 1fr 110px",
  alignItems: "center",
  background: sel
    ? "rgba(14,165,233,0.08)"
    : rec
      ? "rgba(16,185,129,0.06)"
      : C.navy,
  border: sel
    ? `2px solid ${C.teal}`
    : rec
      ? `2px solid ${C.green}`
      : `1px solid ${C.border}`,
  borderRadius: 8,
  padding: "14px 18px",
  fontSize: 15,
  transition: "all 0.2s",
  opacity: dim && !sel ? 0.5 : 1,
  cursor: clickable ? "pointer" : "default",
});
const sTierName = { fontWeight: 700, color: C.heading, fontSize: 15 };
const sTierDetail = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 13,
  color: C.gray,
};
const sTierPrice = {
  fontFamily: "'JetBrains Mono', monospace",
  fontWeight: 500,
  fontSize: 16,
  color: C.green,
  textAlign: "right",
};
const sSpecCard = {
  background: C.navy,
  border: `1px solid ${C.border}`,
  borderRadius: 8,
  padding: 16,
};
const sSpecName = {
  fontSize: 13,
  fontWeight: 700,
  color: C.gray,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  marginBottom: 6,
};
const sSpecPrice = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 20,
  fontWeight: 700,
  color: C.green,
};
const sSpecDet = { fontSize: 13, color: C.gray, marginTop: 4 };
const sModNote = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 12,
  color: C.amber,
  marginTop: 4,
};
const sSeasonal = {
  fontSize: 12,
  color: C.teal,
  fontStyle: "italic",
  marginTop: 4,
};
const sGroupHeader = {
  fontSize: 13,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 1.5,
  color: C.teal,
  margin: "28px 0 16px 0",
  paddingBottom: 8,
  borderBottom: `2px solid rgba(14,165,233,0.25)`,
};
const sSectionTitle = {
  fontSize: 16,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 1.5,
  color: C.amber,
  marginBottom: 12,
};
const sTag = (c) => ({
  display: "inline-block",
  fontSize: 11,
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: 0.5,
  padding: "3px 10px",
  borderRadius: 12,
  verticalAlign: "middle",
  marginLeft: 8,
  background:
    c === "green"
      ? "rgba(16,185,129,0.15)"
      : c === "amber"
        ? "rgba(245,158,11,0.15)"
        : c === "red"
          ? "rgba(239,68,68,0.15)"
          : "rgba(14,165,233,0.15)",
  color:
    c === "green"
      ? C.green
      : c === "amber"
        ? C.amber
        : c === "red"
          ? C.red
          : C.teal,
});
const sFieldVerify = {
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  color: C.red,
  padding: "2px 8px",
  background: "rgba(239,68,68,0.1)",
  borderRadius: 8,
  display: "inline-block",
  marginLeft: 6,
};
const sDiscBadge = {
  display: "inline-block",
  background: "rgba(16,185,129,0.15)",
  color: C.green,
  fontSize: 11,
  fontWeight: 700,
  padding: "2px 8px",
  borderRadius: 10,
  marginLeft: 6,
  fontFamily: "'JetBrains Mono', monospace",
};

/* ── TierGrid ───────────────────────────────────────────────── */
function TierGrid({ children }) {
  return <div style={{ display: "grid", gap: 10 }}>{children}</div>;
}
function TierRow({
  name,
  detail,
  price,
  recommended,
  dimmed,
  onSelect,
  selected,
}) {
  return (
    <div
      className="estimate-tier-row"
      onClick={onSelect}
      title={onSelect ? "Click to select this frequency" : undefined}
      style={sTierRow(recommended, dimmed, !!onSelect, selected)}
    >
      {" "}
      <div style={sTierName}>
        {name}
        {selected ? " \u2713" : recommended ? " \u2605" : ""}
      </div>{" "}
      <div
        style={{
          ...sTierDetail,
          wordWrap: "break-word",
          overflowWrap: "break-word",
        }}
      >
        {detail}
      </div>{" "}
      <div style={sTierPrice}>{price}</div>{" "}
    </div>
  );
}

function mosquitoTierSelectionFlags(R, tier, index) {
  const tiers = Array.isArray(R?.mq) ? R.mq : [];
  const hasSelectionFields = tiers.some((t) => t.selected !== undefined || t.isSelected !== undefined);
  const ri = Number(R?.mqMeta?.ri);
  const selected = hasSelectionFields
    ? !!(tier.selected || tier.isSelected)
    : Number.isInteger(ri)
      ? index === ri
      : !!tier.recommended;
  const recommended = hasSelectionFields
    ? !!(tier.recommended || tier.isRecommended || tier.pressureRecommended)
    : false;
  return { selected, recommended, dimmed: !selected };
}

/* ── Form context + helpers (outside component = stable React identity) ── */
const FormCtx = createContext({});

function Field({ label, children, style: sx }) {
  return (
    <div style={{ ...sField, ...sx }}>
      <label style={sLabel}>{label}</label>
      {children}
    </div>
  );
}
function Input({ k, type = "text", placeholder, min, max }) {
  const { form, set } = useContext(FormCtx);
  return (
    <input
      type={type}
      value={form[k]}
      onChange={(e) => set(k, e.target.value)}
      placeholder={placeholder}
      min={min}
      max={max}
      style={sInput}
    />
  );
}
function Select({ k, options }) {
  const { form, set } = useContext(FormCtx);
  return (
    <select
      value={form[k]}
      onChange={(e) => set(k, e.target.value)}
      style={sSelect}
    >
      {options.map((o) => (
        <option
          key={o.value}
          value={o.value}
          style={{ background: C.input, color: C.heading }}
        >
          {o.label}
        </option>
      ))}
    </select>
  );
}

function parsePositiveNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parsePositiveInteger(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function hasInvalidPositiveInteger(value) {
  return value !== undefined && value !== null && String(value).trim() !== "" && parsePositiveInteger(value) === undefined;
}

function parseNonNegativeNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function Checkbox({ k, label }) {
  const { form, toggle } = useContext(FormCtx);
  return (
    <label style={sCheckbox}>
      {" "}
      <input
        type="checkbox"
        checked={form[k]}
        onChange={() => toggle(k)}
        style={sCb}
      />
      {label}
    </label>
  );
}
function statusStyle(type) {
  if (type === "ok")
    return {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      padding: "10px 14px",
      borderRadius: C.radius,
      marginBottom: 16,
      background: "rgba(16,185,129,0.1)",
      color: C.green,
      border: "1px solid rgba(16,185,129,0.2)",
    };
  if (type === "err")
    return {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      padding: "10px 14px",
      borderRadius: C.radius,
      marginBottom: 16,
      background: "rgba(239,68,68,0.1)",
      color: C.red,
      border: "1px solid rgba(239,68,68,0.2)",
    };
  if (type === "loading")
    return {
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 13,
      padding: "10px 14px",
      borderRadius: C.radius,
      marginBottom: 16,
      background: "rgba(14,165,233,0.1)",
      color: C.teal,
      border: "1px solid rgba(14,165,233,0.2)",
    };
  return { display: "none" };
}


// =========================================================================
// ESTIMATES PIPELINE VIEW — list of sent estimates with status tracking
// =========================================================================
const API_BASE = import.meta.env.VITE_API_URL || "/api";

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  }).then((r) => {
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  });
}

const STATUS_CONFIG = {
  draft: { label: "Draft", color: C.gray, bg: `${C.gray}22` },
  sent: { label: "Sent", color: C.teal, bg: `${C.teal}22` },
  scheduled: { label: "Scheduled", color: C.teal, bg: `${C.teal}22` },
  viewed: { label: "Viewed", color: C.amber, bg: `${C.amber}22` },
  accepted: { label: "Accepted", color: C.green, bg: `${C.green}22` },
  declined: { label: "Declined", color: C.red, bg: `${C.red}22` },
  expired: { label: "Expired", color: C.gray, bg: `${C.gray}15` },
};

/* ── Competitor detection for intel badge ──────────────────── */
const COMPETITORS = [
  "trugreen",
  "massey",
  "turner",
  "all u need",
  "terminix",
  "orkin",
];
function detectCompetitor(notes) {
  if (!notes) return null;
  const lower = notes.toLowerCase();
  for (const c of COMPETITORS) {
    if (lower.includes(c)) {
      // Capitalize for display
      return c
        .split(" ")
        .map((w) => w[0].toUpperCase() + w.slice(1))
        .join(" ");
    }
  }
  return null;
}

/* ── Urgency indicator logic based on timestamps ──────────── */
function getUrgencyIndicator(e) {
  const now = Date.now();
  const HOUR = 3600000;

  if (e.status === "sent" && !e.viewedAt && e.sentAt) {
    const hoursSinceSent = (now - new Date(e.sentAt).getTime()) / HOUR;
    if (hoursSinceSent >= 72)
      return { label: "Going cold", color: C.red, bg: `${C.red}18` };
    if (hoursSinceSent >= 24)
      return { label: "Not opened", color: C.amber, bg: `${C.amber}18` };
  }

  if (e.status === "viewed" && e.viewedAt) {
    // Key off the latest engagement (re-view/click), not the first view — a
    // customer who re-opened the estimate yesterday isn't overdue.
    const engagementStamps = [e.lastViewedAt, e.viewedAt, e.lastClickedAt]
      .map((iso) => (iso ? new Date(iso).getTime() : NaN))
      .filter((ts) => !Number.isNaN(ts));
    const hoursSinceViewed = (now - Math.max(...engagementStamps)) / HOUR;
    if (hoursSinceViewed >= 168)
      return { label: "Final follow-up", color: C.red, bg: `${C.red}18` };
    if (hoursSinceViewed >= 48)
      return { label: "Follow up", color: C.amber, bg: `${C.amber}18` };
  }

  return null;
}

/* ── Decline reason options ────────────────────────────────── */
// Normalized loss dispositions (server/services/estimate-disposition.js —
// staff codes). `code` is what analytics slice on; `label` is what the
// operator reads and what lands in the legacy decline_reason badge.
// `fields` opens the extra inputs for that option.
const DECLINE_REASONS = [
  { code: "declined_price", label: "Too expensive" },
  { code: "declined_competitor", label: "Went with competitor", fields: "competitor" },
  { code: "declined_timing", label: "Not ready / timing" },
  { code: "not_needed", label: "Service not needed" },
  { code: "diy", label: "Doing it themselves" },
  { code: "no_response", label: "No response" },
  { code: "invalid_lead", label: "Invalid / out of area / duplicate" },
  { code: "declined_other", label: "Other", fields: "note" },
];

// Body for PATCH /admin/estimates/:id from a decline modal's state.
function declinePayload({ reason, competitorName, competitorPrice, note }) {
  const option = DECLINE_REASONS.find((r) => r.code === reason);
  return {
    status: "declined",
    disposition: reason,
    declineReason: option?.label || reason,
    // The note travels only with the option that owns it — a stale Other
    // note must not ride along after the radio selection changes.
    dispositionNote: option?.fields === "note" ? note?.trim() || undefined : undefined,
    competitorName: option?.fields === "competitor" ? competitorName?.trim() || undefined : undefined,
    competitorPrice: option?.fields === "competitor" && competitorPrice?.trim() ? competitorPrice.trim() : undefined,
  };
}

/* ── Follow-Up Modal ──────────────────────────────────────── */
function FollowUpModal({ estimate, onClose, onSent }) {
  const isMobile = useIsMobile();
  const firstName = estimate.customerName?.split(" ")[0] || "there";
  const addrShort = estimate.address?.split(",")[0] || "your property";
  const [message, setMessage] = useState(
    `Hi ${firstName}, just checking in on the estimate I sent for ${addrShort}. Any questions? — Adam, Waves`,
  );
  const [sending, setSending] = useState(false);

  const handleSend = async () => {
    setSending(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}/follow-up`, {
        method: "POST",
        body: JSON.stringify({ message }),
      });
      onSent();
    } catch (err) {
      alert("Follow-up failed: " + err.message);
    }
    setSending(false);
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 16,
      }}
      onClick={onClose}
    >
      {" "}
      <div
        style={{
          background: C.card,
          borderRadius: 12,
          border: `1px solid ${C.border}`,
          padding: 24,
          maxWidth: 480,
          width: "100%",
          ...(isMobile
            ? {
                width: "100%",
                maxWidth: "none",
                height: "100%",
                maxHeight: "none",
                borderRadius: 0,
                boxSizing: "border-box",
                overflowY: "auto",
                paddingTop: "calc(24px + env(safe-area-inset-top, 0px))",
                paddingBottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
                paddingLeft: "calc(24px + env(safe-area-inset-left, 0px))",
                paddingRight: "calc(24px + env(safe-area-inset-right, 0px))",
              }
            : {}),
        }}
        onClick={(ev) => ev.stopPropagation()}
      >
        {" "}
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: C.heading,
            marginBottom: 4,
          }}
        >
          Follow Up — {estimate.customerName}
        </div>{" "}
        <div style={{ fontSize: 12, color: C.gray, marginBottom: 16 }}>
          {estimate.address}
        </div>{" "}
        <label
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: C.gray,
            textTransform: "uppercase",
            letterSpacing: 0.8,
            marginBottom: 6,
            display: "block",
          }}
        >
          SMS Message
        </label>{" "}
        <textarea
          value={message}
          onChange={(ev) => setMessage(ev.target.value)}
          rows={4}
          style={{
            ...sInput,
            resize: "vertical",
            minHeight: 90,
            marginBottom: 16,
          }}
        />{" "}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          {" "}
          <button
            onClick={onClose}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: "transparent",
              color: C.gray,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>{" "}
          <button
            onClick={handleSend}
            disabled={sending}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: C.amber,
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              opacity: sending ? 0.6 : 1,
            }}
          >
            {sending ? "Sending..." : "Send Follow-Up SMS"}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </div>,
    document.body,
  );
}

/* ── Decline Reason Modal ─────────────────────────────────── */
function DeclineModal({ estimate, onClose, onSaved }) {
  const isMobile = useIsMobile();
  const [reason, setReason] = useState("");
  const [competitorName, setCompetitorName] = useState("");
  const [competitorPrice, setCompetitorPrice] = useState("");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  // "Other" needs its note — the server 400s a blank one.
  const incomplete = !reason || (reason === "declined_other" && !note.trim());

  const handleSave = async () => {
    if (incomplete) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}`, {
        method: "PATCH",
        body: JSON.stringify(declinePayload({ reason, competitorName, competitorPrice, note })),
      });
      onSaved();
    } catch (err) {
      alert("Failed: " + err.message);
    }
    setSaving(false);
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: isMobile ? 0 : 16,
      }}
      onClick={onClose}
    >
      {" "}
      <div
        style={{
          background: C.card,
          borderRadius: 12,
          border: `1px solid ${C.border}`,
          padding: 24,
          maxWidth: 400,
          width: "100%",
          ...(isMobile
            ? {
                width: "100%",
                maxWidth: "none",
                height: "100%",
                maxHeight: "none",
                borderRadius: 0,
                boxSizing: "border-box",
                overflowY: "auto",
                paddingTop: "calc(24px + env(safe-area-inset-top, 0px))",
                paddingBottom: "calc(24px + env(safe-area-inset-bottom, 0px))",
                paddingLeft: "calc(24px + env(safe-area-inset-left, 0px))",
                paddingRight: "calc(24px + env(safe-area-inset-right, 0px))",
              }
            : {}),
        }}
        onClick={(ev) => ev.stopPropagation()}
      >
        {" "}
        <div
          style={{
            fontSize: 16,
            fontWeight: 700,
            color: C.heading,
            marginBottom: 4,
          }}
        >
          Mark as Lost
        </div>{" "}
        <div style={{ fontSize: 12, color: C.gray, marginBottom: 16 }}>
          {estimate.customerName} — {estimate.address?.split(",")[0]}
        </div>{" "}
        <label
          style={{
            fontSize: 12,
            fontWeight: 500,
            color: C.gray,
            textTransform: "uppercase",
            letterSpacing: 0.8,
            marginBottom: 8,
            display: "block",
          }}
        >
          Reason
        </label>{" "}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 6,
            marginBottom: 18,
          }}
        >
          {DECLINE_REASONS.map((r) => (
            <React.Fragment key={r.code}>
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                fontSize: 14,
                color: reason === r.code ? C.heading : C.gray,
                padding: "8px 12px",
                borderRadius: 8,
                background: reason === r.code ? `${C.red}18` : "transparent",
                border: `1px solid ${reason === r.code ? C.red : C.border}`,
                transition: "all 0.15s",
              }}
            >
              {" "}
              <input
                type="radio"
                name="declineReason"
                checked={reason === r.code}
                onChange={() => setReason(r.code)}
                style={{ accentColor: C.red, width: 16, height: 16 }}
              />
              {r.label}
            </label>
            {reason === r.code && r.fields === "competitor" && (
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, margin: "0 0 4px 26px" }}>
                <input
                  value={competitorName}
                  onChange={(ev) => setCompetitorName(ev.target.value)}
                  placeholder="Competitor"
                  aria-label="Competitor"
                  style={{ padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.heading, fontSize: 14 }}
                />
                <input
                  value={competitorPrice}
                  onChange={(ev) => setCompetitorPrice(ev.target.value)}
                  placeholder="Their price ($)"
                  aria-label="Competitor price"
                  inputMode="decimal"
                  style={{ padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.heading, fontSize: 14 }}
                />
              </div>
            )}
            {reason === r.code && r.fields === "note" && (
              <input
                value={note}
                onChange={(ev) => setNote(ev.target.value)}
                placeholder="What happened?"
                aria-label="Decline note"
                style={{ margin: "0 0 4px 26px", padding: "8px 10px", borderRadius: 6, border: `1px solid ${C.border}`, background: "transparent", color: C.heading, fontSize: 14 }}
              />
            )}
            </React.Fragment>
          ))}
        </div>{" "}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          {" "}
          <button
            onClick={onClose}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              background: "transparent",
              color: C.gray,
              fontSize: 13,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>{" "}
          <button
            onClick={handleSave}
            disabled={saving || incomplete}
            style={{
              padding: "10px 20px",
              borderRadius: 8,
              border: "none",
              background: C.red,
              color: "#fff",
              fontSize: 13,
              fontWeight: 700,
              cursor: "pointer",
              opacity: saving || !reason ? 0.5 : 1,
            }}
          >
            {saving ? "Saving..." : "Mark as Lost"}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </div>,
    document.body,
  );
}

/* ── Action-oriented filter logic ─────────────────────────── */
const PIPELINE_FILTERS = [
  { key: "all", label: "All", color: C.heading },
  { key: "needs_estimate", label: "Needs Estimate", color: C.amber },
  { key: "ready_to_send", label: "Ready to Send", color: C.teal },
  { key: "scheduled", label: "Scheduled", color: C.teal },
  { key: "awaiting", label: "Awaiting Response", color: C.blue },
  { key: "follow_up", label: "Follow Up Now", color: C.amber },
  { key: "won", label: "Won", color: C.green },
  { key: "lost", label: "Lost", color: C.red },
  { key: "archived", label: "Archived", color: C.muted || C.heading },
];

function classifyEstimate(e) {
  // Archived trumps status for filter bucketing. The list API returns only
  // archived rows when ?archived=only is set, so this mostly affects the
  // filter-count math in the pills.
  if (e.archivedAt) return "archived";
  if (e.status === "accepted") return "won";
  if (e.status === "declined" || e.status === "expired") return "lost";
  if (e.status === "draft" && (!e.monthlyTotal || e.monthlyTotal === 0))
    return "needs_estimate";
  if (e.status === "draft" && e.monthlyTotal > 0) return "ready_to_send";
  if (e.status === "scheduled") return "scheduled";
  if (e.status === "sent" && !e.viewedAt) return "awaiting";
  if (e.status === "viewed") return "follow_up";
  if (e.status === "sent" && e.viewedAt) return "follow_up";
  return "all";
}



export {
  STATUS_CONFIG,
  PIPELINE_FILTERS,
  DECLINE_REASONS,
  declinePayload,
  classifyEstimate,
  getUrgencyIndicator,
  detectCompetitor,
  FollowUpModal,
  DeclineModal,
};
