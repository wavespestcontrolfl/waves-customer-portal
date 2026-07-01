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
  calculateEstimate,
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

const COMMERCIAL_WARNING_TEXT =
  "Commercial property detected. Residential lawn and pest pricing is not valid. Manual quote required unless small-commercial pilot pricing is enabled.";

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
    config: "78 oz @ $174.72 | 0.8 oz / 10 sqft | contextual minimum",
  },
  taurus_sc: {
    warning: "Value fipronil non-repellent pre-slab treatment. Confirm label rate and product configuration.",
    config: "78 oz @ $95.00 | 0.8 oz / 10 sqft | contextual minimum",
  },
  bifen_it: {
    warning: "Bifenthrin repellent barrier. Not equivalent to non-repellent fipronil positioning. Confirm label supports pre-construction subterranean termite treatment.",
    config: "128 oz @ $41.53 | 1.0 oz / 10 sqft | contextual minimum",
  },
  talstar_p: {
    warning: "Branded bifenthrin repellent barrier. Confirm exact Talstar P label and rate before treatment.",
    config: "128 oz @ $38.99 | 1.0 oz / 10 sqft | contextual minimum",
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
            Estimate Render Error
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
  fontWeight: 600,
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
  fontWeight: 600,
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

/* ═══════════════════════════════════════════════════════════════
   ESTIMATE PAGE COMPONENT
   ═══════════════════════════════════════════════════════════════ */

function EstimateToolView() {
  /* ── Google Maps script ───────────────────────────────────── */
  const addressRef = useRef(null);
  const autocompleteRef = useRef(null);

  useEffect(() => {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
    if (!apiKey) return;

    // Inject dark-theme styles for the Google autocomplete dropdown
    if (!document.getElementById("pac-dark-style")) {
      const style = document.createElement("style");
      style.id = "pac-dark-style";
      style.textContent = `
        .pac-container { background: #FFFFFF !important; border: 1px solid #E2E8F0 !important; border-radius: 8px !important; margin-top: 4px !important; z-index: 99999 !important; font-family: 'Roboto', Arial, sans-serif !important; box-shadow: 0 8px 24px rgba(0,0,0,0.1) !important; }
        .pac-item { padding: 8px 12px !important; border-top: 1px solid #E2E8F0 !important; color: #334155 !important; cursor: pointer !important; font-size: 14px !important; }
        .pac-item:first-child { border-top: none !important; }
        .pac-item:hover, .pac-item-selected { background: #F0F7FC !important; }
        .pac-item-query { color: #0F172A !important; font-weight: 600 !important; }
        .pac-matched { color: #0A7EC2 !important; font-weight: 700 !important; }
        .pac-icon { display: none !important; }
        .pac-item span { color: #64748B !important; }
        .pac-item-query span { color: #0F172A !important; }
        .pac-logo::after { display: none !important; }
      `;
      document.head.appendChild(style);
    }

    function tryInit() {
      if (
        window.google &&
        window.google.maps &&
        window.google.maps.places &&
        addressRef.current
      ) {
        initAutocomplete();
        return true;
      }
      return false;
    }

    if (tryInit()) return;

    // Check if script is already loading
    if (
      document.querySelector('script[src*="maps.googleapis.com/maps/api/js"]')
    ) {
      const interval = setInterval(() => {
        if (tryInit()) clearInterval(interval);
      }, 300);
      return () => clearInterval(interval);
    }

    const script = document.createElement("script");
    script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places&loading=async`;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      const interval = setInterval(() => {
        if (tryInit()) clearInterval(interval);
      }, 200);
      setTimeout(() => clearInterval(interval), 5000);
    };
    document.head.appendChild(script);
    // Don't remove the script on unmount — it breaks Google Maps global state
  }, []);

  function initAutocomplete() {
    if (!addressRef.current || !window.google?.maps?.places) return;
    if (autocompleteRef.current) return; // Already initialized
    const ac = new window.google.maps.places.Autocomplete(addressRef.current, {
      types: ["address"],
      componentRestrictions: { country: "us" },
      fields: ["formatted_address", "address_components", "geometry"],
    });
    ac.addListener("place_changed", () => {
      const p = ac.getPlace();
      if (p && p.formatted_address) {
        setForm((f) => ({ ...f, address: p.formatted_address }));
      }
    });
    autocompleteRef.current = ac;
  }

  /* ── fonts ────────────────────────────────────────────────── */
  useEffect(() => {
    const link = document.createElement("link");
    link.href =
      "https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,300;0,9..40,500;0,9..40,700;1,9..40,400&family=JetBrains+Mono:wght@400;600&family=Montserrat:wght@600;700;800&family=Poppins:wght@400;500;600&display=swap";
    link.rel = "stylesheet";
    document.head.appendChild(link);
    return () => {
      if (link.parentNode) link.parentNode.removeChild(link);
    };
  }, []);

  /* ── form state ───────────────────────────────────────────── */
  const [form, setForm] = useState({
    address: "",
    homeSqFt: "",
    stories: "1",
    lotSqFt: "",
    propertyType: "Single Family",
    isCommercial: "NO",
    commercialSubtype: "",
    commercialPricingMode: "manual_quote",
    hasPool: "NO",
    hasPoolCage: "NO",
    poolCageSize: "MEDIUM",
    hasLargeDriveway: "NO",
    shrubDensity: "MODERATE",
    treeDensity: "MODERATE",
    landscapeComplexity: "MODERATE",
    nearWater: "NO",
    urgency: "ROUTINE",
    isAfterHours: "NO",
    isRecurringCustomer: "NO",
    bedArea: "",
    palmCount: "",
    palmTreatmentCount: "",
    palmTreatmentType: "combo",
    palmSize: "medium",
    treeCount: "",
    roachModifier: "NONE",
    lawnFreq: "9",
    pestFreq: "4",
    plugArea: "",
    plugSpacing: "12",
    dethatchingCleanupLevel: "none",
    dethatchingDebrisRemovalIncluded: false,
    dethatchingAccess: "easy",
    dethatchingManagerApproved: false,
    dethatchingManagerApprovalReason: "",
    thatchProbe1Inches: "",
    thatchProbe2Inches: "",
    thatchProbe3Inches: "",
    thatchDepthInches: "",
    thatchMeasurementSource: "manual",
    manualDiscountPreset: "",
    manualDiscountType: "NONE",
    manualDiscountValue: "",
    manualDiscountLabel: "",
    manualDiscountInternalReason: "",
    manualDiscountEligibilityConfirmed: false,
    manualDiscountEligibilityOverrideReason: "",
    serviceSpecificDiscountKeys: [],
    grassType: "st_augustine",
    otLawnType: "FERT",
    exclSimple: "0",
    exclModerate: "0",
    exclAdvanced: "0",
    exclWaive: "NO",
    bedbugRooms: "1",
    bedbugMethod: "CHEMICAL",
    bedbugSeverity: "light",
    germanRoachSeverity: "light",
    bedbugPrepStatus: "ready",
    bedbugOccupancyType: "singleFamily",
    bedbugEquipment: "INHOUSE",
    bedbugHeatScope: "ROOMS_ONLY",
    bedbugSubcontractCost: "",
    termiteFootprintSqFt: "",
    termitePerimeterLF: "",
    termiteBaitComplexity: "",
    termiteBaitSystem: "advance",
    termiteMonitoringTier: "basic",
    trenchingPerimeterLF: "",
    trenchingConcreteLF: "",
    trenchingDirtLF: "",
    trenchingConcretePct: "",
    trenchingEstimateFromFootprint: false,
    trenchingProductKey: "taurus_sc",
    trenchingApplicationRate: "standard",
    trenchingDepthFt: "1",
    trenchingWarrantyTier: "one_year_retreat",
    trenchingLabelConfirmed: false,
    boracareSqft: "",
    preslabSqft: "",
    preslabProductKey: "termidor_sc",
    preslabLabelConfirmed: false,
    preslabWarranty: "BASIC",
    preslabVolume: "NONE",
    preslabJobContext: "standalone",
    _preslabJobContextEdited: false,
    foamPoints: "5",
    foamRecurringPoints: "5",
    foamRecurringFreq: "quarterly",
    roachType: "REGULAR",
    // services
    svcLawn: true,
    svcPest: true,
    svcTs: false,
    svcInjection: false,
    svcMosquito: false,
    svcTermiteBait: false,
    svcWdo: false,
    svcRodentBait: false,
    svcOnetimePest: false,
    svcOnetimeLawn: false,
    svcOnetimeMosquito: false,
    svcPlugging: false,
    svcTopdress: false,
    svcDethatch: false,
    svcTrenching: false,
    svcBoracare: false,
    svcPreslab: false,
    svcFoam: false,
    svcFoamRecurring: false,
    svcRodentTrap: false,
    svcFlea: false,
    svcWasp: false,
    svcRoach: false,
    svcBedbug: false,
    svcExclusion: false,
  });

  /* ── live pricing preview (approximate from form state) ──── */
  const livePreview = useMemo(() => {
    const commercialDetected = isCommercialEstimateInput(form);
    // Count recurring services
    const qualifyingRecurringKeys = [
      "svcLawn",
      "svcPest",
      "svcTs",
      "svcMosquito",
      "svcTermiteBait",
    ];
    const separateRecurringKeys = ["svcInjection", "svcRodentBait", "svcFoamRecurring"];
    // ALL commercial pest-family services now auto-price as recurring lines
    // (lawn, pest, tree/shrub, mosquito, termite-bait, rodent-bait). None collapse
    // to a manual commercial quote.
    const commercialAutoKeys = ["svcLawn", "svcPest", "svcTs", "svcMosquito", "svcTermiteBait", "svcRodentBait"];
    // Mirror the server commercial pricers' real-size gates so the preview's
    // auto-priced vs manual buckets match what Generate Estimate produces:
    // lawn/tree are lot-derivable (always auto); pest/rodent-bait need a real
    // BUILDING footprint (home size — the termite-specific measurements do NOT
    // feed them); termite-bait accepts a home size OR an admin termite
    // footprint/perimeter measurement; mosquito needs a real LOT. Else the pricer
    // returns a quoteRequired manual line and the warning below must surface.
    const hasCommercialHomeSize = Number(form.homeSqFt) > 0;
    const hasCommercialTermiteSize =
      hasCommercialHomeSize ||
      Number(form.termiteFootprintSqFt) > 0 ||
      Number(form.termitePerimeterLF) > 0;
    const hasCommercialLotSize = Number(form.lotSqFt) > 0;
    const commercialKeyFallsToManual = (k) => {
      if (k === "svcMosquito") return !hasCommercialLotSize;
      if (k === "svcTermiteBait") return !hasCommercialTermiteSize;
      if (k === "svcPest" || k === "svcRodentBait") return !hasCommercialHomeSize;
      return false; // lawn / tree are lot-derivable and always auto-price
    };
    const commercialAutoPricedCount = commercialDetected
      ? commercialAutoKeys.filter((k) => form[k] && !commercialKeyFallsToManual(k)).length
      : 0;
    const commercialManualQuoteCount = commercialDetected
      ? commercialAutoKeys.filter((k) => form[k] && commercialKeyFallsToManual(k)).length
      : 0;
    // Commercial lines are FLAT / non-WaveGuard (excludeFromPctDiscount) — they
    // NEVER count toward the WaveGuard tier or its % discount. So a commercial
    // estimate has a WaveGuard recurringCount of 0 and shows a commercial
    // non-member state, not a fake Silver/Gold bundle discount.
    const recurringCount = commercialDetected
      ? 0
      : qualifyingRecurringKeys.filter((k) => form[k]).length;
    // For commercial, rodent-bait (a separate-recurring key) is now a commercial
    // auto-priced line counted above — don't double-count it here.
    const separateRecurringCount = separateRecurringKeys
      .filter((k) => form[k] && !(commercialDetected && commercialAutoKeys.includes(k)))
      .length;

    // Tier logic
    const tierMap = {
      0: { name: "None", discount: 0 },
      1: { name: "Bronze", discount: 0 },
      2: { name: "Silver", discount: 0.1 },
      3: { name: "Gold", discount: 0.15 },
    };
    const tier = commercialDetected
      ? { name: "Commercial", discount: 0 }
      : recurringCount >= 4
        ? { name: "Platinum", discount: 0.2 }
        : tierMap[recurringCount] || tierMap[0];

    // Approximate monthly costs for recurring (rough averages based on typical property)
    const sqft = Number(form.homeSqFt) || 2000;
    const lotSqft = Number(form.lotSqFt) || 8000;
    const approx = {};
    if (form.svcLawn && !commercialDetected) approx.lawn = Math.max(55, Math.round(sqft * 0.028 + 10));
    if (form.svcPest && !commercialDetected) {
      const freqMult = { 4: 1, 6: 1.3, 12: 2.2 };
      approx.pest = Math.max(
        35,
        Math.round((sqft * 0.022 + 20) * (freqMult[form.pestFreq] || 1)),
      );
    }
    if (form.svcTs && !commercialDetected)
      approx.ts = Math.max(
        45,
        Math.round((Number(form.bedArea) || lotSqft * 0.15) * 0.012 + 30),
      );
    if (form.svcInjection) {
      const treatmentCount = parsePositiveInteger(form.palmTreatmentCount)
        ?? (String(form.palmTreatmentCount || "").trim() === "" ? parsePositiveInteger(form.palmCount) : undefined);
      if (treatmentCount) {
        approx.injection = Math.round((Math.max(treatmentCount * 75, 75) * 2) / 12);
      }
    }
    if (form.svcMosquito && !commercialDetected)
      approx.mosquito = Math.max(40, Math.round(lotSqft * 0.005 + 15));
    if (form.svcTermiteBait && !commercialDetected) approx.termiteBait = 50;
    if (form.svcRodentBait && !commercialDetected) approx.rodentBait = sqft > 2500 ? 69 : 49;
    if (form.svcFoamRecurring) {
      // Rough preview; engine is authoritative. One-time per-visit by tier
      // (no floor) × cadence multiplier × visits/yr ÷ 12.
      const oneTimeByPoints = { 5: 182, 10: 308, 15: 434, 20: 598 };
      const cadMult = { quarterly: 0.9, bimonthly: 0.85, monthly: 0.8 };
      const cadVisits = { quarterly: 4, bimonthly: 6, monthly: 12 };
      const cad = cadMult[form.foamRecurringFreq] ? form.foamRecurringFreq : "quarterly";
      const base = oneTimeByPoints[form.foamRecurringPoints] || oneTimeByPoints[5];
      approx.foamRecurring = Math.round((base * cadMult[cad] * cadVisits[cad]) / 12);
    }

    const separateRecurringMonthly = (approx.injection || 0) + (approx.rodentBait || 0) + (approx.foamRecurring || 0);
    const discountableRecurringMonthlyBefore = Object.entries(approx).reduce(
      (s, [key, value]) => s + (key === "injection" || key === "rodentBait" || key === "foamRecurring" ? 0 : value),
      0,
    );
    const recurringMonthly = Math.round(
      discountableRecurringMonthlyBefore * (1 - tier.discount) + separateRecurringMonthly,
    );
    const annualRecurring = recurringMonthly * 12;
    const annualSavings = Math.round(
      discountableRecurringMonthlyBefore * tier.discount * 12,
    );

    // Count one-time services
    const onetimeKeys = [
      "svcOnetimePest",
      "svcOnetimeLawn",
      "svcOnetimeMosquito",
      "svcPlugging",
      "svcTopdress",
      "svcDethatch",
      "svcTrenching",
      "svcBoracare",
      "svcPreslab",
      "svcFoam",
      "svcRodentTrap",
      "svcFlea",
      "svcWasp",
      "svcRoach",
      "svcBedbug",
      "svcExclusion",
    ];
    const onetimeCount = onetimeKeys.filter((k) => form[k]).length;
    const anySelected = recurringCount > 0 || commercialAutoPricedCount > 0 || separateRecurringCount > 0 || commercialManualQuoteCount > 0 || onetimeCount > 0;

    return {
      recurringCount,
      totalRecurringCount: recurringCount + commercialAutoPricedCount + separateRecurringCount + commercialManualQuoteCount,
      commercialManualQuoteCount,
      onetimeCount,
      tier,
      recurringMonthly,
      annualRecurring,
      annualSavings,
      anySelected,
    };
  }, [form]);

  const [estimate, setEstimate] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [lookupStatus, setLookupStatus] = useState({ type: "", msg: "" });
  const [customerSearch, setCustomerSearch] = useState("");
  const [customers, setCustomers] = useState([]);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [showSendForm, setShowSendForm] = useState(false);
  const [sendSearch, setSendSearch] = useState("");
  const [sendCustomerResults, setSendCustomerResults] = useState([]);
  const searchSendCustomers = useCallback(async (q) => {
    if (!q || q.length < 2) {
      setSendCustomerResults([]);
      return;
    }
    try {
      const r = await fetch(
        `/api/admin/customers?search=${encodeURIComponent(q)}&limit=5`,
        { headers: authHeaders },
      );
      if (r.ok) {
        const d = await r.json();
        setSendCustomerResults(d.customers || d || []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  const token = localStorage.getItem("waves_admin_token");
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  /* ── field setter ─────────────────────────────────────────── */
  const set = useCallback(
    (key, val) => {
      setForm((f) => {
        const next = {
          ...f,
          [key]: val,
          ...(key === "preslabJobContext" ? { _preslabJobContextEdited: true } : {}),
          ...(key === "preslabVolume" && !f._preslabJobContextEdited
            ? { preslabJobContext: String(val || "NONE").toUpperCase() === "NONE" ? "standalone" : "builderBatch" }
            : {}),
          ...(key === "poolCageSize" ? { _poolCageSizeEdited: true } : {}),
          ...(key === "stories" ? { _storiesEdited: true } : {}),
          ...(key === "termiteFootprintSqFt" ? { _termiteFootprintAuto: false } : {}),
        };
        if (key === "palmCount" && String(f.palmTreatmentCount || "").trim() === "") {
          next.palmTreatmentCount = val;
        }
        return next;
      });
      if (DETHATCHING_ESTIMATE_RESET_FIELDS.has(key)) {
        setEstimate(null);
        setSavedId(null);
      }
    },
    [],
  );
  const toggle = useCallback((key) => {
    setForm((f) => {
      const next = { ...f, [key]: !f[key] };
      if (key === "svcInjection" && !f.svcInjection && String(f.palmTreatmentCount || "").trim() === "") {
        next.palmTreatmentCount = f.palmCount || "";
      }
      return next;
    });
    // Reset generated estimate so bottom preview bar updates
    if (key.startsWith("svc") || DETHATCHING_ESTIMATE_RESET_FIELDS.has(key)) {
      setEstimate(null);
      setSavedId(null);
    }
  }, []);

  /* ── termite footprint prefill ─────────────────────────────── */
  useEffect(() => {
    const sqft = Number(form.homeSqFt) || 0;
    const st = Math.max(1, Number(form.stories) || 1);
    if (sqft > 0) {
      const fp = Math.round(sqft / st);
      setForm((f) => {
        const upd = {};
        if (!f.termiteFootprintSqFt || f._termiteFootprintAuto)
          upd.termiteFootprintSqFt = String(fp);
        if (Object.keys(upd).length === 0) return f;
        return { ...f, ...upd, _termiteFootprintAuto: true };
      });
    }
  }, [form.homeSqFt, form.stories]);

  /* ── customer search ──────────────────────────────────────── */
  const searchCustomers = useCallback(async (q) => {
    if (!q || q.length < 2) {
      setCustomers([]);
      return;
    }
    try {
      const r = await fetch(
        `/api/admin/customers?search=${encodeURIComponent(q)}`,
        { headers: authHeaders },
      );
      if (r.ok) {
        const d = await r.json();
        setCustomers(d.customers || d || []);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchCustomers(customerSearch), 300);
    return () => clearTimeout(t);
  }, [customerSearch]);

  function selectCustomer(c) {
    const fullName = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
    const phoneDigits = String(c.phone || "").replace(/\D/g, "");
    const normalizedPhone =
      phoneDigits.length === 11 && phoneDigits.startsWith("1")
        ? phoneDigits.slice(1)
        : phoneDigits.slice(0, 10);
    setForm((f) => ({
      ...f,
      address: c.address || "",
      homeSqFt: c.homeSqFt ? String(c.homeSqFt) : f.homeSqFt,
      lotSqFt: c.lotSqFt ? String(c.lotSqFt) : f.lotSqFt,
      stories: c.stories ? String(c.stories) : f.stories,
      customerName: fullName || f.customerName,
      customerPhone: normalizedPhone || f.customerPhone,
      customerEmail: c.email || f.customerEmail,
    }));
    setCustomerSearch("");
    setCustomers([]);
  }

  /* ── v2 Property Lookup — AI property search + satellite review in one call ── */
  const [enrichedProfile, setEnrichedProfile] = useState(null);
  const [existingCustomerMatch, setExistingCustomerMatch] = useState(null);

  /* ── Manual discount presets (pulled from /admin/discounts) ── */
  const [discountPresets, setDiscountPresets] = useState([]);
  const [serviceCreditPresets, setServiceCreditPresets] = useState([]);
  useEffect(() => {
    (async () => {
      try {
        const r = await adminFetch("/admin/discounts");
        if (!r.ok) return;
        const rows = await r.json();
        const manual = (rows || [])
          .filter(isEstimatorManualDiscount)
          .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999));
        const serviceCredits = (rows || [])
          .filter(isServiceSpecificCredit)
          .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999));
        setDiscountPresets(manual);
        setServiceCreditPresets(serviceCredits);
      } catch {
        /* ignore */
      }
    })();
  }, []);

  function applyDiscountPreset(key) {
    if (!key) {
      setForm((f) => ({
        ...f,
        manualDiscountPreset: "",
        manualDiscountType: "NONE",
        manualDiscountValue: "",
        manualDiscountLabel: "",
        manualDiscountInternalReason: "",
        manualDiscountEligibilityConfirmed: false,
        manualDiscountEligibilityOverrideReason: "",
      }));
      return;
    }
    if (key === "__custom__") {
      setForm((f) => ({
        ...f,
        manualDiscountPreset: key,
        manualDiscountEligibilityConfirmed: false,
        manualDiscountEligibilityOverrideReason: "",
      }));
      return;
    }
    const d = discountPresets.find((x) => x.discount_key === key);
    if (!d) return;
    const manualType = manualDiscountTypeForCatalogRow(d);
    setForm((f) => ({
      ...f,
      manualDiscountPreset: key,
      manualDiscountType: manualType,
      manualDiscountValue: isCustomDiscountTemplate(d) ? "" : String(d.amount || 0),
      manualDiscountLabel: d.name,
      manualDiscountEligibilityConfirmed: false,
      manualDiscountEligibilityOverrideReason: "",
    }));
  }

  function toggleServiceSpecificDiscount(key) {
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
    setForm((f) => {
      const current = new Set(Array.isArray(f.serviceSpecificDiscountKeys) ? f.serviceSpecificDiscountKeys : []);
      if (current.has(key)) current.delete(key);
      else current.add(key);
      return { ...f, serviceSpecificDiscountKeys: Array.from(current) };
    });
  }

  async function doLookup() {
    const address = form.address.trim();
    if (!address) {
      setLookupStatus({ type: "err", msg: "Enter an address" });
      return;
    }
    setLookupStatus({
      type: "loading",
      msg: "Looking up property... (AI property search + AI satellite analysis)",
    });
    setSatelliteStatus({
      type: "loading",
      msg: "Running AI satellite analysis...",
    });
    try {
      const r = await fetch("/api/admin/estimator/property-lookup", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ address }),
      });
      if (!r.ok) throw new Error("API " + r.status);
      const data = await r.json();

      if (data.errors?.length > 0 && !data.enriched) {
        setLookupStatus({
          type: "err",
          msg: data.errors.map((e) => e.message).join(", "),
        });
        setSatelliteStatus({ type: "", msg: "" });
        return;
      }

      const ep = data.enriched;
      setEnrichedProfile(ep);

      // Fill form from enriched profile
      const upd = {};
      if (ep.homeSqFt) upd.homeSqFt = String(ep.homeSqFt);
      if (ep.lotSqFt) upd.lotSqFt = String(ep.lotSqFt);
      if (ep.stories) upd.stories = String(ep.stories);
      if (ep.propertyType || ep.category) {
        Object.assign(upd, resolveLookupPropertyTypeAutofill(ep.propertyType, ep.category));
      }
      if (ep.commercialSubtype) upd.commercialSubtype = ep.commercialSubtype;
      if (ep.pool === "YES" || ep.pool === "POSSIBLE") upd.hasPool = "YES";
      if (ep.poolCage === "YES") upd.hasPoolCage = "YES";
      if (ep.poolCageSize && ep.poolCageSize !== "NONE")
        upd.poolCageSize = ep.poolCageSize;
      if (ep.largeDriveway) upd.hasLargeDriveway = "YES";
      if (ep.shrubDensity) upd.shrubDensity = ep.shrubDensity;
      if (ep.treeDensity) upd.treeDensity = ep.treeDensity;
      if (ep.landscapeComplexity)
        upd.landscapeComplexity = ep.landscapeComplexity;
      if (ep.nearWater && ep.nearWater !== "NONE") upd.nearWater = "YES";
      if (ep.estimatedBedAreaSf) upd.bedArea = String(ep.estimatedBedAreaSf);
      if (ep.estimatedPalmCount) upd.palmCount = String(ep.estimatedPalmCount);
      if (ep.estimatedTreeCount) upd.treeCount = String(ep.estimatedTreeCount);

      setForm((f) => {
        const next = {
          ...f,
          ...upd,
          _boracareAuto: true,
          _preslabAuto: true,
          _poolCageSizeEdited: false,
          _storiesEdited: false,
        };
        if (upd.palmCount && String(f.palmTreatmentCount || "").trim() === "") {
          next.palmTreatmentCount = upd.palmCount;
        }
        return next;
      });

      // Auto-detect existing customer by address
      try {
        const addrSearch = address.split(",")[0].trim();
        const custR = await fetch(
          `/api/admin/customers?search=${encodeURIComponent(addrSearch)}&limit=3`,
          { headers: authHeaders },
        );
        if (custR.ok) {
          const custData = await custR.json();
          const custs = custData.customers || custData || [];
          const match = custs.find(
            (c) =>
              c.address &&
              address
                .toLowerCase()
                .includes(c.address.split(",")[0].trim().toLowerCase()),
          );
          if (match) {
            setExistingCustomerMatch(match);
            // Only apply loyalty discount if they have an active WaveGuard tier.
            // 'Commercial' is a flat non-member tier — exclude it so a commercial
            // customer doesn't unlock recurring-customer loyalty discounts.
            const hasActivePlan =
              match.tier && match.tier !== "null" && match.tier !== "Commercial" && match.monthlyRate > 0;
            setForm((f) => ({
              ...f,
              isRecurringCustomer: hasActivePlan ? "YES" : "NO",
              customerName:
                `${match.firstName || ""} ${match.lastName || ""}`.trim(),
              customerPhone: match.phone || f.customerPhone || "",
              customerEmail: match.email || f.customerEmail || "",
            }));
          } else {
            setExistingCustomerMatch(null);
          }
        }
      } catch {
        /* ignore customer lookup errors */
      }

      // Satellite images
      if (data.satellite) {
        const aiSources = normalizeAiSources(
          data.aiAnalysis?.aiSources || data.aiAnalysis?._sources,
        );
        setSatelliteData({
          imageUrl: data.satellite.closeUrl,
          microCloseUrl: data.satellite.microCloseUrl,
          ultraCloseUrl: data.satellite.ultraCloseUrl,
          superCloseUrl: data.satellite.superCloseUrl,
          closeUrl: data.satellite.closeUrl,
          wideUrl: data.satellite.wideUrl,
          inServiceArea: data.satellite.inServiceArea,
          aiSources,
          aiWarnings: buildAiProviderWarnings({
            sources: aiSources,
            errors: data.errors || [],
            providerStatus: data.meta?.providerStatus?.satelliteVision,
          }),
        });
      }

      // Build status messages
      const rc = data.propertyRecord || data.rentcast;
      const ai = data.aiAnalysis;
      const lines = [];
      if (rc)
        lines.push(
          `${rc.formattedAddress} — ${rc.squareFootage || "?"} sf / ${rc.lotSize || "?"} sf lot / ${rc.stories || 1} story`,
        );
      if (ep.yearBuilt)
        lines.push(
          `Built ${ep.yearBuilt} · ${ep.constructionMaterial} · ${ep.foundationType} foundation · ${ep.roofType} roof`,
        );
      if (ep.propertyDataQuality)
        lines.push(
          `Property data quality: ${String(ep.propertyDataQuality.level || "unknown").toUpperCase()} (${ep.propertyDataQuality.score || 0}/100)`,
        );
      setLookupStatus({ type: "ok", msg: lines.join("\n") });

      if (ai) {
        const conf =
          ep.aiConfidence >= 70
            ? "HIGH"
            : ep.aiConfidence >= 40
              ? "MEDIUM"
              : "LOW";
        const flags = ep.fieldVerifyFlags?.length || 0;
        setSatelliteStatus({
          type: "ok",
          msg: `AI Analysis complete — Confidence: ${conf} (${ep.aiConfidence}%)${flags > 0 ? ` · ${flags} field(s) flagged` : ""}\nPest pressure: ${ep.overallPestPressure} · Water: ${ep.nearWater} · Turf: ${ep.estimatedTurfSf} sf`,
        });
      } else {
        setSatelliteStatus({
          type: "err",
          msg: "AI satellite analysis unavailable",
        });
      }

      if (data.errors?.length > 0) {
        console.warn("[estimate] Partial errors:", data.errors);
      }
    } catch (e) {
      setLookupStatus({ type: "err", msg: e.message });
      setSatelliteStatus({ type: "", msg: "" });
    }
  }

  /* ── Satellite AI analysis (Claude + Gemini dual vision) ──── */
  const [satelliteStatus, setSatelliteStatus] = useState({ type: "", msg: "" });
  const [satelliteData, setSatelliteData] = useState(null);

  async function doSatelliteAnalysis() {
    const address = form.address.trim();
    if (!address) {
      setSatelliteStatus({ type: "err", msg: "Enter an address first" });
      return;
    }
    setSatelliteStatus({
      type: "loading",
      msg: "Analyzing satellite imagery with AI...",
    });
    setSatelliteData(null);
    try {
      const r = await fetch("/api/admin/lookup/satellite-ai", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ address }),
      });
      const data = await r.json();
      if (data.error) {
        setSatelliteStatus({ type: "err", msg: data.error });
        return;
      }

      const aiSources = normalizeAiSources(
        data.aiSources || data._sources || data.source,
      );
      setSatelliteData({
        ...data,
        aiSources,
        aiWarnings: buildAiProviderWarnings({
          sources: aiSources,
          errors: data.errors || [],
          providerStatus: data.providerStatus,
        }),
      });

      // Auto-fill form fields from AI analysis
      const upd = {};
      if (data.lot_sqft) upd.lotSqFt = String(Math.round(data.lot_sqft));
      if (data.bed_area_sqft)
        upd.bedArea = String(Math.round(data.bed_area_sqft));
      if (data.palm_count) upd.palmCount = String(data.palm_count);
      if (data.tree_count) upd.treeCount = String(data.tree_count);
      if (data.shrub_density) upd.shrubDensity = data.shrub_density;
      if (data.tree_density) upd.treeDensity = data.tree_density;
      if (data.landscape_complexity)
        upd.landscapeComplexity = data.landscape_complexity;
      if (data.has_pool) upd.hasPool = "YES";
      if (data.has_pool_cage) upd.hasPoolCage = "YES";
      if (data.has_large_driveway) upd.hasLargeDriveway = "YES";
      if (data.near_water) upd.nearWater = "YES";
      const termiteFootprint =
        data.footprint_sqft ||
        data.footprintSqFt ||
        data.building_footprint_sqft ||
        data.buildingFootprintSqFt;
      if (termiteFootprint)
        upd.termiteFootprintSqFt = String(Math.round(termiteFootprint));
      if (data.property_type || data.category) {
        Object.assign(upd, resolveLookupPropertyTypeAutofill(data.property_type, data.category));
      }
      if (data.perimeter_linear_ft)
        upd.trenchingPerimeterLF = String(Math.round(data.perimeter_linear_ft));
      if (data.attic_sqft || data.atticSqFt)
        upd.boracareSqft = String(Math.round(data.attic_sqft || data.atticSqFt));
      if (data.slab_sqft || data.slabSqFt)
        upd.preslabSqft = String(Math.round(data.slab_sqft || data.slabSqFt));

      setForm((f) => {
        const next = { ...f, ...upd };
        if (upd.palmCount && String(f.palmTreatmentCount || "").trim() === "") {
          next.palmTreatmentCount = upd.palmCount;
        }
        return next;
      });

      const verify = (data.fieldVerify || []).length;
      const conf =
        data.confidence === "high"
          ? " HIGH"
          : data.confidence === "medium"
            ? " MEDIUM"
            : " LOW";
      setSatelliteStatus({
        type: "ok",
        msg: `AI Analysis complete — Confidence: ${conf} (${data.agreementPct || "?"}% model agreement)${verify > 0 ? ` · ${verify} field(s) flagged for field verification` : ""}`,
      });
    } catch (e) {
      setSatelliteStatus({ type: "err", msg: e.message });
    }
  }

  /* ── generate estimate ────────────────────────────────────── */
  async function doGenerate(overrides = {}) {
    const formIsCommercial = isCommercialEstimateInput(form);
    const serviceFlagValues = [
      form.svcLawn,
      form.svcPest,
      form.svcTs,
      form.svcInjection,
      form.svcMosquito,
      form.svcTermiteBait,
      form.svcWdo,
      form.svcRodentBait,
      form.svcOnetimePest,
      form.svcOnetimeLawn,
      form.svcOnetimeMosquito,
      form.svcPlugging,
      form.svcTopdress,
      form.svcDethatch,
      form.svcTrenching,
      form.svcBoracare,
      form.svcPreslab,
      form.svcFoam,
      form.svcFoamRecurring,
      form.svcRodentTrap,
      form.svcFlea,
      form.svcWasp,
      form.svcRoach,
      form.svcBedbug,
      form.svcExclusion,
    ];
    const bedBugOnlyManual =
      form.svcBedbug && serviceFlagValues.filter(Boolean).length === 1;
    const hasLawnPricedService =
      !formIsCommercial &&
      (form.svcLawn ||
        form.svcOnetimeLawn ||
        form.svcTopdress ||
        form.svcDethatch ||
        form.svcPlugging);
    const hasManualLawnDimensions =
      (Number(form.lotSqFt) || 0) > 0 ||
      (Number(form.measuredTurfSf) || 0) > 0 ||
      (Number(form.estimatedTurfSf) || 0) > 0;
    const hasManualPropertyDimensions =
      (Number(form.homeSqFt) || 0) > 0 || (Number(form.lotSqFt) || 0) > 0;
    const canUseServerForBedBug =
      enrichedProfile ||
      (form.svcBedbug && (bedBugOnlyManual || hasManualPropertyDimensions));
    const hasServerOnlyService = !!form.svcWdo;
    // Commercial estimates are server-priced: the cost-buildup commercial
    // pricers (lawn / tree / pest) live ONLY in the server engine. Force
    // commercial through the server calculator whenever we have a lookup or
    // manual dimensions, so a commercial estimate never falls back to the
    // deprecated client engine (which would persist a $0 manual quote).
    const canUseServerForCommercial = formIsCommercial && (enrichedProfile || hasManualPropertyDimensions);

    if (form.svcBedbug && hasLawnPricedService && !enrichedProfile && !hasManualLawnDimensions) {
      alert("Enter lot size or run Property Lookup before generating a bed bug estimate with lawn services.");
      return;
    }

    if (form.svcBedbug && !canUseServerForBedBug) {
      alert("Enter home sq ft or run Property Lookup before generating a mixed bed bug estimate.");
      return;
    }

    // Without dimensions or a lookup the server can't size a commercial job —
    // block (with guidance) rather than fall through to the client engine.
    if (formIsCommercial && !canUseServerForCommercial) {
      alert("Enter home or lot sq ft, or run Property Lookup, to price a commercial estimate.");
      return;
    }

    // Bed bug pricing is server-only. Without lookup data, keep the legacy
    // dimension guard for any non-bed-bug services still selected.
    if (enrichedProfile || canUseServerForBedBug || hasServerOnlyService || canUseServerForCommercial) {
      try {
        // Don't overwrite lookup status — keep property specs visible

        // Build selected services array from form checkboxes
        const selectedServices = [];
        if (form.svcLawn) selectedServices.push("LAWN");
        if (form.svcPest) selectedServices.push("PEST");
        if (form.svcTs) selectedServices.push("TREE_SHRUB");
        if (form.svcInjection) selectedServices.push("PALM_INJECTION");
        if (form.svcMosquito) selectedServices.push("MOSQUITO");
        if (form.svcTermiteBait) selectedServices.push("TERMITE_BAIT");
        if (form.svcWdo) selectedServices.push("WDO");
        if (form.svcRodentBait) selectedServices.push("RODENT_BAIT");
        if (form.svcOnetimePest) selectedServices.push("OT_PEST");
        if (form.svcOnetimeLawn) selectedServices.push("OT_LAWN");
        if (form.svcOnetimeMosquito) selectedServices.push("OT_MOSQUITO");
        if (form.svcPlugging) selectedServices.push("PLUGGING");
        if (form.svcTopdress) selectedServices.push("TOPDRESS");
        if (form.svcDethatch) selectedServices.push("DETHATCH");
        if (form.svcTrenching) selectedServices.push("TRENCHING");
        if (form.svcBoracare) selectedServices.push("BORACARE");
        if (form.svcPreslab) selectedServices.push("PRESLAB");
        if (form.svcFoam) selectedServices.push("FOAM");
        if (form.svcFoamRecurring) selectedServices.push("FOAM_RECURRING");
        if (form.svcRodentTrap) selectedServices.push("RODENT_TRAP");
        if (form.svcFlea) selectedServices.push("FLEA");
        if (form.svcWasp) selectedServices.push("STING");
        if (form.svcRoach) selectedServices.push("ROACH");
        if (form.svcBedbug) selectedServices.push("BEDBUG");
        if (form.svcExclusion) selectedServices.push("EXCLUSION");

        const manualDiscountType =
          overrides.manualDiscountType ?? form.manualDiscountType;
        const manualDiscountValue =
          Number(overrides.manualDiscountValue ?? form.manualDiscountValue) ||
          0;
        const selectedManualPreset = discountPresets.find(
          (x) => x.discount_key === form.manualDiscountPreset,
        );
        if (manualDiscountType !== "NONE" && (form.manualDiscountPreset || manualDiscountValue > 0) && manualDiscountValue <= 0) {
          alert("Manual discount amount must be greater than zero.");
          return null;
        }
        if (
          manualDiscountType !== "NONE" &&
          manualDiscountValue > 0 &&
          (!selectedManualPreset || isCustomDiscountTemplate(selectedManualPreset)) &&
          !String(form.manualDiscountInternalReason || "").trim()
        ) {
          alert("Enter an internal reason for custom discounts.");
          return null;
        }
        if (
          manualDiscountType !== "NONE" &&
          manualDiscountValue > 0 &&
          selectedManualPreset?.warnings?.some((warning) => String(warning).startsWith("manual_discount_requires_")) &&
          form.manualDiscountEligibilityConfirmed !== true
        ) {
          alert("Confirm eligibility or enter an approved override before applying this discount.");
          return null;
        }
        const manualDiscount = buildManualDiscountPayload({
          form: { ...form, manualDiscountType },
          selectedPreset: selectedManualPreset,
          valueOverride: manualDiscountValue,
        });
        const serviceSpecificDiscounts = buildServiceSpecificDiscountPayloads({
          form,
          presets: serviceCreditPresets,
        });
        const termiteFootprintSqFt = parsePositiveNumber(form.termiteFootprintSqFt);
        const termitePerimeterLF = parsePositiveNumber(form.termitePerimeterLF);
        const trenchingPerimeterLF = parsePositiveNumber(form.trenchingPerimeterLF);
        const trenchingConcreteLF = parseNonNegativeNumber(form.trenchingConcreteLF);
        const trenchingDirtLF = parseNonNegativeNumber(form.trenchingDirtLF);
        const trenchingConcretePct = parseNonNegativeNumber(form.trenchingConcretePct);
        const boracareSqft = parsePositiveNumber(form.boracareSqft);
        const preslabSqft = parsePositiveNumber(form.preslabSqft);
        const propertyPalmCount = parsePositiveInteger(form.palmCount);
        const palmTreatmentCountBlank = String(form.palmTreatmentCount || "").trim() === "";
        const palmTreatmentCount = parsePositiveInteger(form.palmTreatmentCount)
          ?? (palmTreatmentCountBlank ? propertyPalmCount : undefined);
        if (form.svcInjection) {
          if (hasInvalidPositiveInteger(form.palmCount) || hasInvalidPositiveInteger(form.palmTreatmentCount)) {
            alert("Palm count must be a positive whole number.");
            return null;
          }
          if (!palmTreatmentCount) {
            alert("Palm count is required for palm injection pricing.");
            return null;
          }
        }
        const options = {
          grassType: form.grassType || "st_augustine",
          lawnFreq: parseInt(overrides.lawnFreq ?? form.lawnFreq) || 9,
          pestFreq: parseInt(overrides.pestFreq ?? form.pestFreq) || 4,
          manualDiscount,
          serviceSpecificDiscounts,
          roachModifier: form.roachModifier || "NONE",
          recurringRoachType: form.roachModifier || "NONE",
          urgency: form.urgency || "ROUTINE",
          afterHours: form.isAfterHours === "YES",
          recurringCustomer: form.isRecurringCustomer === "YES",
          plugArea: parseInt(form.plugArea) || 0,
          plugSpacing: parseInt(form.plugSpacing) || 12,
          dethatchingCleanupLevel: form.dethatchingCleanupLevel || "none",
          dethatchingDebrisRemovalIncluded: !!form.dethatchingDebrisRemovalIncluded,
          dethatchingAccess: form.dethatchingAccess || "easy",
          dethatchingManagerApproved: !!form.dethatchingManagerApproved,
          dethatchingManagerApprovalReason: form.dethatchingManagerApprovalReason || "",
          thatchProbe1Inches: form.thatchProbe1Inches,
          thatchProbe2Inches: form.thatchProbe2Inches,
          thatchProbe3Inches: form.thatchProbe3Inches,
          thatchDepthInches: form.thatchDepthInches,
          thatchMeasurementSource: form.thatchMeasurementSource || "manual",
          termiteBaitSystem: form.termiteBaitSystem || "advance",
          termiteMonitoringTier: form.termiteMonitoringTier || "basic",
          termiteBaitComplexity: form.termiteBaitComplexity || "",
          termiteFootprintSqFt,
          termitePerimeterLF,
          trenchingPerimeterLF,
          trenchingConcreteLF,
          trenchingDirtLF,
          trenchingConcretePct,
          trenchingEstimateFromFootprint: !!form.trenchingEstimateFromFootprint,
          trenchingProductKey: form.trenchingProductKey || "taurus_sc",
          trenchingApplicationRate: form.trenchingApplicationRate || "standard",
          trenchingDepthFt: form.trenchingDepthFt || "1",
          trenchingWarrantyTier: form.trenchingWarrantyTier || "one_year_retreat",
          trenchingLabelConfirmed: !!form.trenchingLabelConfirmed,
          boracareSqft,
          preslabSqft,
          preslabProductKey: form.preslabProductKey || "termidor_sc",
          preslabLabelConfirmed: !!form.preslabLabelConfirmed,
          preslabWarranty: form.preslabWarranty || "BASIC",
          preslabVolume: form.preslabVolume || "NONE",
          preslabJobContext: resolvePreSlabJobContextForForm(form),
          includePreSlabWarrantyExtended: form.preslabWarranty === "EXTENDED",
          foamPoints: form.foamPoints === undefined ? undefined : form.foamPoints,
          foamRecurringPoints: form.foamRecurringPoints === undefined ? undefined : form.foamRecurringPoints,
          foamRecurringFreq: form.foamRecurringFreq || "quarterly",
          bedbugRooms: parseInt(form.bedbugRooms) || 1,
          bedbugMethod: form.bedbugMethod || "CHEMICAL",
          bedbugSeverity: form.bedbugSeverity || "light",
          bedbugPrepStatus: form.bedbugPrepStatus || "ready",
          bedbugOccupancyType: form.bedbugOccupancyType || "singleFamily",
          bedbugEquipment: form.bedbugEquipment || "INHOUSE",
          bedbugHeatScope: form.bedbugHeatScope || "ROOMS_ONLY",
          bedbugSubcontractCost: form.bedbugSubcontractCost,
          exclSimple: parseInt(form.exclSimple) || 0,
          exclModerate: parseInt(form.exclModerate) || 0,
          exclAdvanced: parseInt(form.exclAdvanced) || 0,
          exclWaiveInspection: form.exclWaive === "YES",
          roachType: form.roachType || "REGULAR",
          standaloneRoachTreatment: !!form.svcRoach && form.roachType === "REGULAR",
          germanRoachCleanoutSelected: !!form.svcRoach && form.roachType === "GERMAN",
          germanRoachSeverity: form.germanRoachSeverity || "light",
          onetimeLawnType: form.otLawnType || "FERT",
          commercialPricingMode: form.commercialPricingMode || "manual_quote",
          commercialSubtype: formIsCommercial ? form.commercialSubtype || "" : "",
        };
        if (form.svcInjection) {
          options.palmInjection = {
            selected: true,
            treatmentType: form.palmTreatmentType || "combo",
            palmCount: palmTreatmentCount,
            measurements: { palmCount: palmTreatmentCount },
            palmSize: form.palmSize || "medium",
          };
        }

        // Override enriched profile with any manual form edits. When bed bug is
        // the only service, a minimal manual profile is enough for the server.
        const profile = { ...(enrichedProfile || {}) };
        const manualNumber = (value, fallback = 0) => {
          const n = parseInt(value, 10);
          return Number.isFinite(n) ? n : fallback;
        };
        profile.homeSqFt = manualNumber(
          form.homeSqFt,
          Number(profile.homeSqFt || profile.squareFootage) || 0,
        );
        profile.lotSqFt = manualNumber(form.lotSqFt, Number(profile.lotSqFt) || 0);
        profile.stories = manualNumber(form.stories, Number(profile.stories) || 1);
        if (form.bedArea) profile.estimatedBedAreaSf = parseInt(form.bedArea);
        if (propertyPalmCount) {
          profile.palmCount = propertyPalmCount;
          profile.estimatedPalmCount = propertyPalmCount;
          profile.palmInventory = { ...(profile.palmInventory || {}), palmCount: propertyPalmCount };
        }
        if (form.treeCount) profile.estimatedTreeCount = parseInt(form.treeCount);
        if (profile.homeSqFt > 0) {
          profile.footprint = Math.round(
            profile.homeSqFt / (profile.stories || 1),
          );
        } else {
          delete profile.footprint;
        }
        if (trenchingPerimeterLF) profile.perimeterLF = trenchingPerimeterLF;
        if (boracareSqft) profile.atticSqFt = boracareSqft;
        if (preslabSqft) profile.slabSqFt = preslabSqft;
        // Override property features from form dropdowns
        profile.pool = form.hasPool === "YES" ? "YES" : "NO";
        profile.poolCage = form.hasPoolCage === "YES" ? "YES" : "NO";
        profile.poolCageSize =
          form.hasPoolCage === "YES" ? form.poolCageSize || "MEDIUM" : "NONE";
        profile.poolCageSizeInferred =
          !!profile.poolCageSizeInferred &&
          !form._poolCageSizeEdited &&
          profile.poolCage === "YES" &&
          profile.poolCageSize === "MEDIUM";
        profile.storiesSource = form._storiesEdited
          ? "manual"
          : profile.storiesSource;
        profile.hasLargeDriveway = form.hasLargeDriveway === "YES";
        profile.shrubDensity = form.shrubDensity || profile.shrubDensity;
        profile.treeDensity = form.treeDensity || profile.treeDensity;
        profile.landscapeComplexity =
          form.landscapeComplexity || profile.landscapeComplexity;
        profile.nearWater = form.nearWater === "YES" ? "YES" : "NO";
        profile.propertyType = form.propertyType || profile.propertyType;
        profile.isCommercial = formIsCommercial;
        profile.commercialSubtype = formIsCommercial ? form.commercialSubtype || null : null;

        const r = await fetch("/api/admin/estimator/calculate-estimate", {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({ profile, selectedServices, options }),
        });
        const result = await r.json();
        if (result.error) {
          alert(result.error);
          setLookupStatus((s) => ({ ...s, type: "err", msg: result.error }));
          return;
        }

        // Add pricing modifiers from property data if not returned by server
        if (!result.modifiers) {
          const p = result.property || profile || {};
          const mods = [];
          const add = (svc, label, impact, type) =>
            mods.push({ service: svc, label, impact, type });

          const interp = (v, b) => {
            if (v <= b[0].at) return b[0].adj;
            if (v >= b[b.length - 1].at) return b[b.length - 1].adj;
            for (let i = 1; i < b.length; i++) {
              if (v <= b[i].at) {
                const lo = b[i - 1];
                const hi = b[i];
                const ratio = (v - lo.at) / (hi.at - lo.at);
                return Math.round(lo.adj + ratio * (hi.adj - lo.adj));
              }
            }
            return 0;
          };

          const homeSf = p.homeSqFt || p.squareFootage || 0;
          const stories = p.stories || 1;
          const fp = p.footprint || Math.round(homeSf / stories);

          const fpAdj = interp(fp, [
            { at: 800, adj: -15 },
            { at: 1200, adj: -10 },
            { at: 1500, adj: -5 },
            { at: 1750, adj: -5 },
            { at: 2000, adj: 0 },
            { at: 2500, adj: 3 },
            { at: 3000, adj: 6 },
            { at: 4000, adj: 10 },
            { at: 5500, adj: 16 },
          ]);

          add(
            "property",
            `Home: ${homeSf.toLocaleString()} sq ft · ${stories} story`,
            0,
            "info",
          );
          add(
            "pest",
            `Footprint: ${fp.toLocaleString()} sq ft → ${fpAdj >= 0 ? "+" : ""}$${fpAdj}/visit`,
            fpAdj,
            fpAdj > 0 ? "up" : fpAdj < 0 ? "down" : "info",
          );
          if (p.poolCage === "YES") {
            const cageSize = String(p.poolCageSize || "MEDIUM").toUpperCase();
            const cageAdj =
              { SMALL: 5, MEDIUM: 8, LARGE: 12, OVERSIZED: 18 }[cageSize] || 8;
            add(
              "pest",
              `Pool cage (${cageSize.toLowerCase()}): +$${cageAdj}/visit`,
              cageAdj,
              "up",
            );
          } else if (p.pool === "YES")
            add("pest", "Pool (no cage): $0/visit", 0, "info");
          else add("pest", "No pool: $0/visit", 0, "info");
          const sd = p.shrubDensity || p.shrubs;
          if (sd === "HEAVY") add("pest", "Heavy shrubs: +$6/visit", 6, "up");
          else if (sd === "MODERATE")
            add("pest", "Moderate shrubs: $0/visit", 0, "info");
          else if (sd === "LIGHT")
            add("pest", "Light shrubs: -$5/visit", -5, "down");
          else add("pest", "Shrubs: not specified", 0, "info");
          const td = p.treeDensity || p.trees;
          if (td === "HEAVY") add("pest", "Heavy trees: +$6/visit", 6, "up");
          else if (td === "MODERATE")
            add("pest", "Moderate trees: $0/visit", 0, "info");
          else if (td === "LIGHT")
            add("pest", "Light trees: -$5/visit", -5, "down");
          else add("pest", "Trees: not specified", 0, "info");
          const lc = p.landscapeComplexity || p.complexity;
          if (lc === "COMPLEX")
            add("pest", "Complex landscape: +$3/visit", 3, "up");
          else if (lc === "SIMPLE")
            add("pest", "Simple landscape: -$5/visit", -5, "down");
          else add("pest", `${lc || "Simple"} landscape: $0/visit`, 0, "info");
          const nw = p.nearWater || p.waterProximity;
          if (nw && nw !== "NONE" && nw !== "NO" && nw !== false)
            add("pest", "Near water: +$3/visit", 3, "up");
          else add("pest", "No water nearby: $0/visit", 0, "info");
          if (p.hasLargeDriveway)
            add("pest", "Large driveway: +$3/visit", 3, "up");
          if (p.yearBuilt)
            add(
              "property",
              `Built: ${p.yearBuilt} · ${p.constructionMaterial || "CBS"} · ${p.foundationType || "Slab"} · ${p.roofType || "Shingle"}`,
              0,
              "info",
            );
          result.modifiers = mods;
        }

        setEstimate(result);
        setSavedId(null);
        setLookupStatus((s) => ({ ...s, type: "ok" }));
      } catch (e) {
        alert("Estimate calculation failed: " + e.message);
      }
      return;
    }

    // Fallback: use v1 client-side calculation
    const manualDiscountType =
      overrides.manualDiscountType ?? form.manualDiscountType;
    const manualDiscountValue =
      Number(overrides.manualDiscountValue ?? form.manualDiscountValue) || 0;
    const selectedManualPreset = discountPresets.find(
      (x) => x.discount_key === form.manualDiscountPreset,
    );
    if (manualDiscountType !== "NONE" && (form.manualDiscountPreset || manualDiscountValue > 0) && manualDiscountValue <= 0) {
      alert("Manual discount amount must be greater than zero.");
      return;
    }
    if (
      manualDiscountType !== "NONE" &&
      manualDiscountValue > 0 &&
      (!selectedManualPreset || isCustomDiscountTemplate(selectedManualPreset)) &&
      !String(form.manualDiscountInternalReason || "").trim()
    ) {
      alert("Enter an internal reason for custom discounts.");
      return;
    }
    if (
      manualDiscountType !== "NONE" &&
      manualDiscountValue > 0 &&
      selectedManualPreset?.warnings?.some((warning) => String(warning).startsWith("manual_discount_requires_")) &&
      form.manualDiscountEligibilityConfirmed !== true
    ) {
      alert("Confirm eligibility or enter an approved override before applying this discount.");
      return;
    }
    const manualDiscount = buildManualDiscountPayload({
      form: { ...form, manualDiscountType },
      selectedPreset: selectedManualPreset,
      valueOverride: manualDiscountValue,
    });
    const yesNo = (v) => v === "YES" || v === true;
    const inputs = {
      ...form,
      manualDiscount,
      roachSeverity: form.germanRoachSeverity || "light",
      hasPool: yesNo(form.hasPool),
      hasPoolCage: yesNo(form.hasPoolCage),
      hasLargeDriveway: yesNo(form.hasLargeDriveway),
      nearWater: yesNo(form.nearWater),
      isAfterHours: yesNo(form.isAfterHours),
      isRecurringCustomer: yesNo(form.isRecurringCustomer),
      exclWaive: yesNo(form.exclWaive),
      isCommercial: formIsCommercial,
      commercialSubtype: formIsCommercial ? form.commercialSubtype || "" : "",
      commercialPricingMode: form.commercialPricingMode || "manual_quote",
    };
    const result = calculateEstimate(inputs);
    if (result.error) {
      alert(result.error);
      return;
    }
    setEstimate(result);
    setSavedId(null);
  }

  /* ── save estimate ────────────────────────────────────────── */
  async function doSave() {
    if (!estimate) return null;
    setSaving(true);
    try {
      const E = estimate;
      const quoteRequired = estimateRequiresQuote(E);
      const monthlyTotal = quoteRequired ? 0 : E.recurring?.grandTotal || 0;
      const onetimeTotal = quoteRequired ? 0 : E.oneTime?.total || 0;
      const estimateSummary = {
        manualDiscount: E.manualDiscount || E.totals?.manualDiscount || null,
        serviceSpecificDiscounts: E.serviceSpecificDiscounts || E.totals?.serviceSpecificDiscounts || [],
      };
      const r = await fetch("/api/admin/estimates", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          address: form.address,
          customerName: customerSearch || form.customerName || "",
          customerPhone: form.customerPhone || "",
          customerEmail: form.customerEmail || "",
          estimateData: { inputs: form, result: E, summary: estimateSummary },
          monthlyTotal,
          annualTotal: monthlyTotal * 12,
          onetimeTotal,
          waveguardTier: E.recurring?.tier || "Bronze",
          notes: form.notes || "",
          satelliteUrl: satelliteData?.imageUrl || null,
        }),
      });
      if (!r.ok) throw new Error("Save failed: " + r.status);
      const d = await r.json();
      const id = d.id || d.estimateId;
      setSavedId(id);
      return id;
    } catch (e) {
      alert(e.message);
      return null;
    } finally {
      setSaving(false);
    }
  }

  /* ── send estimate ────────────────────────────────────────── */
  async function doSend(id, method) {
    const useId = id || savedId;
    if (!useId) {
      alert("Save the estimate first.");
      return;
    }
    const sendMethod = method || "both";
    let scheduled = null;
    if (form.scheduleSend) {
      if (!form.scheduledAt) {
        alert("Pick a send time.");
        return;
      }
      const when = new Date(form.scheduledAt);
      if (isNaN(when.getTime())) {
        alert("Invalid send time.");
        return;
      }
      if (when <= new Date()) {
        alert("Send time must be in the future.");
        return;
      }
      // datetime-local has no timezone; serialize the instant the user picked
      // (browser-local) to an unambiguous ISO string so the server doesn't
      // re-parse "2026-04-26T03:48" as UTC and reject it as already past.
      scheduled = when.toISOString();
    }
    setSending(true);
    try {
      const sendRequest = async (quietHoursOverride = false) => {
        const r = await fetch(`/api/admin/estimates/${useId}/send`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify({
            sendMethod: quietHoursOverride ? "sms" : sendMethod,
            scheduledAt: quietHoursOverride ? null : scheduled,
            quietHoursOverride,
            idempotencyKey:
              globalThis.crypto?.randomUUID?.() ||
              `estimate-send-${Date.now()}-${Math.random()}`,
          }),
        });
        const d = await r.json().catch(() => ({}));
        return { r, d };
      };
      let { r, d } = await sendRequest(false);
      const smsError = String(d?.channels?.sms?.error || d?.error || "");
      if (
        !scheduled &&
        smsError &&
        /quiet-hours|quiet hours|federal holidays/i.test(smsError) &&
        confirm(`SMS failed: ${smsError}\n\nSend the SMS now anyway?`)
      ) {
        ({ r, d } = await sendRequest(true));
      }
      if (!r.ok) {
        const currentSmsError = String(d?.channels?.sms?.error || d?.error || "");
        throw new Error(currentSmsError || `Send failed: ${r.status}`);
      }
      const label =
        sendMethod === "sms"
          ? "SMS"
          : sendMethod === "email"
            ? "email"
            : "SMS & email";
      if (d.scheduled) {
        const when = new Date(d.scheduledAt).toLocaleString();
        alert(`Estimate scheduled via ${label} for ${when}`);
      } else if (d.channels) {
        const parts = [];
        if (d.channels.sms)
          parts.push(
            d.channels.sms.ok
              ? "SMS sent"
              : `SMS failed: ${d.channels.sms.error}`,
          );
        if (d.channels.email)
          parts.push(
            d.channels.email.ok
              ? "Email sent"
              : `Email failed: ${d.channels.email.error}`,
          );
        const anyFail =
          (d.channels.sms && !d.channels.sms.ok) ||
          (d.channels.email && !d.channels.email.ok);
        alert((anyFail ? "Send had issues: " : "Sent: ") + parts.join(" / "));
      } else {
        alert(`Estimate sent via ${label}!`);
      }
    } catch (e) {
      alert(e.message);
    }
    setSending(false);
  }

  /* ── batch-flow helper: reset customer/property/estimate, keep service selections ── */
  function nextEstimate() {
    setForm((f) => ({
      ...f,
      address: "",
      homeSqFt: "",
      stories: "1",
      lotSqFt: "",
      propertyType: "Single Family",
      isCommercial: "NO",
      commercialSubtype: "",
      commercialPricingMode: "manual_quote",
      hasPool: "NO",
      hasPoolCage: "NO",
      poolCageSize: "MEDIUM",
      hasLargeDriveway: "NO",
      nearWater: "NO",
      shrubDensity: "MODERATE",
      treeDensity: "MODERATE",
      landscapeComplexity: "MODERATE",
      urgency: "ROUTINE",
      isAfterHours: "NO",
      isRecurringCustomer: "NO",
      bedArea: "",
      palmCount: "",
      palmTreatmentCount: "",
      palmTreatmentType: "combo",
      palmSize: "medium",
      treeCount: "",
      boracareSqft: "",
      preslabSqft: "",
      preslabProductKey: "termidor_sc",
      preslabLabelConfirmed: false,
      preslabWarranty: "BASIC",
      preslabVolume: "NONE",
      preslabJobContext: "standalone",
      _preslabJobContextEdited: false,
      termiteFootprintSqFt: "",
      termitePerimeterLF: "",
      termiteBaitComplexity: "",
      termiteBaitSystem: "advance",
      termiteMonitoringTier: "basic",
      trenchingPerimeterLF: "",
      trenchingConcreteLF: "",
      trenchingDirtLF: "",
      trenchingConcretePct: "",
      trenchingEstimateFromFootprint: false,
      trenchingProductKey: "taurus_sc",
      trenchingApplicationRate: "standard",
      trenchingDepthFt: "1",
      trenchingWarrantyTier: "one_year_retreat",
      trenchingLabelConfirmed: false,
      customerName: "",
      customerPhone: "",
      customerEmail: "",
      _termiteFootprintAuto: false,
      _boracareAuto: false,
      _preslabAuto: false,
    }));
    setEstimate(null);
    setSavedId(null);
    setShowSendForm(false);
    setLookupStatus({ type: "", msg: "" });
    setEnrichedProfile(null);
    setExistingCustomerMatch(null);
    setSatelliteStatus({ type: "", msg: "" });
    setSatelliteData(null);
    setCustomerSearch("");
    setCustomers([]);
  }

  /* ── one-shot save + send (used by SMS/Email/Both buttons) ── */
  async function saveAndSend(method) {
    if (!estimate) {
      alert('Click "Generate Estimate" first.');
      return;
    }
    if (form.scheduleSend) {
      if (!form.scheduledAt) {
        alert("Pick a send time.");
        return;
      }
      const when = new Date(form.scheduledAt);
      if (isNaN(when.getTime()) || when <= new Date()) {
        alert("Send time must be a valid future date/time.");
        return;
      }
    }
    const id = savedId || (await doSave());
    if (id) await doSend(id, method);
  }

  const E = estimate; // shorthand
  const commercialDetected = isCommercialEstimateInput(form);
  const formCtx = { form, set, toggle };
  const R = E?.results || {};
  const isDethatchingStAugustine = String(form.grassType || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .includes("staugustine");
  const dethatchingLawnSqFtUsed =
    Number(form.measuredTurfSf) ||
    Number(enrichedProfile?.estimatedTurfSf) ||
    Number(satelliteData?.estimatedTurfSf) ||
    Math.round((Number(form.lotSqFt) || 0) * 0.35) ||
    0;
  const hasAnyTermiteSelection =
    !!form.svcTermiteBait ||
    !!form.svcWdo ||
    !!form.svcTrenching ||
    !!form.svcBoracare ||
    !!form.svcPreslab;
  const termiteMeasurementWarnings = [
    form.svcTermiteBait &&
      !parsePositiveNumber(form.termiteFootprintSqFt) &&
      !parsePositiveNumber(form.termitePerimeterLF)
      ? "Termite bait needs footprint sqft or a perimeter LF override."
      : null,
    form.svcTrenching &&
      !parsePositiveNumber(form.trenchingPerimeterLF) &&
      !form.trenchingEstimateFromFootprint
      ? "Trenching needs measured perimeter LF before pricing."
      : null,
    form.svcBoracare && !parsePositiveNumber(form.boracareSqft)
      ? "Bora-Care needs attic/raw wood sqft."
      : null,
    form.svcPreslab && !parsePositiveNumber(form.preslabSqft)
      ? "Pre-Slab Termiticide Treatment needs slab sqft."
      : null,
  ].filter(Boolean);

  /* ═══════════════════════════════════════════════════════════
     RENDER
     ═══════════════════════════════════════════════════════════ */
  return (
    <FormCtx.Provider value={formCtx}>
      {" "}
      <div
        style={{
          background: C.dark,
          color: C.white,
          maxWidth: 1440,
          margin: "0 auto",
          padding:
            typeof window !== "undefined" && window.innerWidth < 640 ? 12 : 28,
          paddingBottom:
            livePreview.anySelected && !estimate
              ? 80
              : typeof window !== "undefined" && window.innerWidth < 640
                ? 12
                : 28,
          minHeight: "100vh",
          fontSize: 16,
          fontFamily: "'Roboto', Arial, sans-serif",
        }}
      >
        {" "}
        <style>{`
        @media (max-width: 640px) {
          .estimate-layout { grid-template-columns: 1fr !important; }
          .estimate-header { flex-direction: column !important; align-items: flex-start !important; gap: 8px !important; }
          .estimate-header h1 { font-size: 20px !important; }
          .estimate-tier-row { grid-template-columns: 100px 1fr 80px !important; padding: 10px 12px !important; font-size: 13px !important; }
          .estimate-spec-grid { grid-template-columns: 1fr !important; }
          .estimate-summary-flex { gap: 16px !important; }
          .estimate-summary-flex >div { min-width: 80px; }
          .estimate-actions { grid-template-columns: 1fr !important; }
          .estimate-send-grid { grid-template-columns: 1fr !important; }
          .estimate-sticky-bar { flex-direction: column !important; gap: 8px !important; padding: 10px 16px !important; }
        }
      `}</style>
        {/* HEADER */}
        <div
          className="estimate-header"
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            marginBottom: 28,
            paddingBottom: 18,
            borderBottom: `2px solid ${C.border}`,
          }}
        >
          {" "}
          <h1
            style={{
              fontSize: 28,
              fontWeight: 400,
              color: C.heading,
              margin: 0,
            }}
          >
            Waves Estimating Engine
          </h1>{" "}
          <span
            style={{
              fontFamily: "'JetBrains Mono', monospace",
              fontSize: 13,
              color: C.gray,
              background: C.navy,
              padding: "6px 14px",
              borderRadius: 20,
            }}
          >
            v1.3 — Internal Use Only
          </span>{" "}
        </div>{" "}
        <div
          className="estimate-layout"
          style={{ display: "grid", gridTemplateColumns: "440px 1fr", gap: 28 }}
        >
          {/* ═══ LEFT COLUMN: FORM ═══ */}
          <div>
            {/* Property Lookup */}
            <div style={sPanel}>
              {" "}
              <div style={sPanelTitle}>Property Lookup</div>{" "}
              <Field label="Address">
                {" "}
                <input
                  ref={addressRef}
                  type="text"
                  value={form.address}
                  onChange={(e) => set("address", e.target.value)}
                  placeholder="Start typing an address..."
                  style={sInput}
                />{" "}
              </Field>
              {lookupStatus.type && (
                <div style={statusStyle(lookupStatus.type)}>
                  {lookupStatus.msg}
                </div>
              )}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr",
                  gap: 8,
                  marginBottom: 8,
                }}
              >
                {" "}
                <button style={sBtnSm(C.blue, "white")} onClick={doLookup}>
                  Property Lookup
                </button>{" "}
                <button
                  style={sBtnSm("transparent", C.gray)}
                  onClick={() => {
                    setForm((f) => ({
                      ...f,
                      address: "",
                      homeSqFt: "",
                      lotSqFt: "",
                      stories: "1",
                      propertyType: "Single Family",
                      isCommercial: "NO",
                      commercialSubtype: "",
                      commercialPricingMode: "manual_quote",
                      hasPool: "NO",
                      hasPoolCage: "NO",
                      poolCageSize: "MEDIUM",
                      hasLargeDriveway: "NO",
                      shrubDensity: "MODERATE",
                      treeDensity: "MODERATE",
                      landscapeComplexity: "MODERATE",
                      nearWater: "NO",
                      bedArea: "",
                      palmCount: "",
                      palmTreatmentCount: "",
                      palmTreatmentType: "combo",
                      palmSize: "medium",
                      treeCount: "",
                    }));
                    setLookupStatus({ type: "", msg: "" });
                    setSatelliteStatus({ type: "", msg: "" });
                    setSatelliteData(null);
                    setEstimate(null);
                  }}
                >
                  Clear All
                </button>{" "}
              </div>
              {satelliteStatus.type && (
                <div style={statusStyle(satelliteStatus.type)}>
                  {satelliteStatus.msg}
                </div>
              )}
              {enrichedProfile?.propertyDataQuality && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: "10px 12px",
                    background: "#F8FAFC",
                    border: `1px solid ${C.border}`,
                    borderRadius: 8,
                  }}
                >
                  {" "}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 12,
                      marginBottom: 4,
                    }}
                  >
                    {" "}
                    <strong
                      style={{
                        fontSize: 12,
                        color: C.navy,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      Property Data Quality
                    </strong>{" "}
                    <strong
                      style={{
                        fontSize: 12,
                        color:
                          enrichedProfile.propertyDataQuality.level === "high"
                            ? C.green
                            : enrichedProfile.propertyDataQuality.level ===
                                "medium"
                              ? C.amber
                              : C.red,
                        textTransform: "uppercase",
                      }}
                    >
                      {enrichedProfile.propertyDataQuality.level || "unknown"} ·{" "}
                      {enrichedProfile.propertyDataQuality.score || 0}/100
                    </strong>{" "}
                  </div>{" "}
                  <div style={{ fontSize: 12, color: C.gray }}>
                    {(enrichedProfile.propertyProviders || []).join(" + ") ||
                      "No provider"}{" "}
                    ·{" "}
                    {(
                      enrichedProfile.propertyDataQuality.sourceTypes || []
                    ).join(", ") || "no source type"}{" "}
                    ·{" "}
                    {enrichedProfile.propertyDataQuality
                      .verifiedCriticalFields || 0}
                    /
                    {enrichedProfile.propertyDataQuality.totalCriticalFields ||
                      4}{" "}
                    critical fields verified
                  </div>{" "}
                </div>
              )}
              {/* AI analysis inline flags */}
              {enrichedProfile?.fieldVerifyFlags?.length > 0 && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: "8px 12px",
                    background: "rgba(239,68,68,0.08)",
                    border: "1px solid rgba(239,68,68,0.2)",
                    borderRadius: 8,
                  }}
                >
                  {enrichedProfile.fieldVerifyFlags.map((flag, i) => (
                    <div
                      key={i}
                      style={{
                        fontSize: 12,
                        color: C.red,
                        marginBottom:
                          i < enrichedProfile.fieldVerifyFlags.length - 1
                            ? 4
                            : 0,
                      }}
                    >
                      {"\u26A0\uFE0F"}{" "}
                      {typeof flag === "string"
                        ? flag.replace(/_/g, " ")
                        : (flag.field || flag.name || "").replace(/_/g, " ")}
                      {flag.reason ? ` \u2014 ${flag.reason}` : ""}
                    </div>
                  ))}
                </div>
              )}
              {/* Existing customer match */}
              {existingCustomerMatch && (
                <div
                  style={{
                    marginBottom: 10,
                    padding: "10px 14px",
                    background: "rgba(16,185,129,0.1)",
                    border: "1px solid rgba(16,185,129,0.25)",
                    borderRadius: 8,
                    fontSize: 13,
                    color: C.green,
                  }}
                >
                  Existing customer:{" "}
                  <strong>
                    {existingCustomerMatch.firstName}{" "}
                    {existingCustomerMatch.lastName}
                  </strong>
                  {existingCustomerMatch.tier &&
                  existingCustomerMatch.tier !== "null"
                    ? ` · WaveGuard ${existingCustomerMatch.tier}`
                    : " · No active plan"}
                  {existingCustomerMatch.tier &&
                  existingCustomerMatch.tier !== "null" &&
                  existingCustomerMatch.monthlyRate > 0
                    ? " · 15% loyalty discount applied"
                    : ""}
                </div>
              )}
              {satelliteData &&
                (satelliteData.imageUrl || satelliteData.closeUrl) && (
                  <div style={{ marginBottom: 12 }}>
                    {" "}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "repeat(5, 1fr)",
                        gap: 4,
                        marginBottom: 8,
                      }}
                    >
                      {satelliteData.microCloseUrl && (
                        <div>
                          {" "}
                          <img
                            src={satelliteData.microCloseUrl}
                            alt="Micro close"
                            style={{
                              width: "100%",
                              borderRadius: 8,
                              border: `2px solid ${C.teal}`,
                              aspectRatio: "1",
                              objectFit: "cover",
                            }}
                          />{" "}
                          <div
                            style={{
                              fontSize: 9,
                              color: C.teal,
                              textAlign: "center",
                              marginTop: 2,
                              fontWeight: 600,
                            }}
                          >
                            Micro
                          </div>{" "}
                        </div>
                      )}
                      {satelliteData.ultraCloseUrl && (
                        <div>
                          {" "}
                          <img
                            src={satelliteData.ultraCloseUrl}
                            alt="Ultra close"
                            style={{
                              width: "100%",
                              borderRadius: 8,
                              border: `2px solid ${C.teal}`,
                              aspectRatio: "1",
                              objectFit: "cover",
                            }}
                          />{" "}
                          <div
                            style={{
                              fontSize: 9,
                              color: C.teal,
                              textAlign: "center",
                              marginTop: 2,
                              fontWeight: 600,
                            }}
                          >
                            Ultra
                          </div>{" "}
                        </div>
                      )}
                      {satelliteData.superCloseUrl && (
                        <div>
                          {" "}
                          <img
                            src={satelliteData.superCloseUrl}
                            alt="Super close"
                            style={{
                              width: "100%",
                              borderRadius: 8,
                              border: `1px solid ${C.border}`,
                              aspectRatio: "1",
                              objectFit: "cover",
                            }}
                          />{" "}
                          <div
                            style={{
                              fontSize: 9,
                              color: C.gray,
                              textAlign: "center",
                              marginTop: 2,
                            }}
                          >
                            Detail
                          </div>{" "}
                        </div>
                      )}
                      <div>
                        {" "}
                        <img
                          src={satelliteData.closeUrl || satelliteData.imageUrl}
                          alt="Close view"
                          style={{
                            width: "100%",
                            borderRadius: 8,
                            border: `1px solid ${C.border}`,
                            aspectRatio: "1",
                            objectFit: "cover",
                          }}
                        />{" "}
                        <div
                          style={{
                            fontSize: 9,
                            color: C.gray,
                            textAlign: "center",
                            marginTop: 2,
                          }}
                        >
                          Property
                        </div>{" "}
                      </div>
                      {satelliteData.wideUrl && (
                        <div>
                          {" "}
                          <img
                            src={satelliteData.wideUrl}
                            alt="Area view"
                            style={{
                              width: "100%",
                              borderRadius: 8,
                              border: `1px solid ${C.border}`,
                              aspectRatio: "1",
                              objectFit: "cover",
                            }}
                          />{" "}
                          <div
                            style={{
                              fontSize: 9,
                              color: C.gray,
                              textAlign: "center",
                              marginTop: 2,
                            }}
                          >
                            Area
                          </div>{" "}
                        </div>
                      )}
                    </div>
                    {satelliteData.aiSources?.length > 0 && (
                      <div
                        style={{ fontSize: 10, color: C.teal, marginBottom: 4 }}
                      >
                        AI Analysis: {formatAiSources(satelliteData.aiSources)}{" "}
                        {satelliteData.aiSources.length > 1
                          ? "(multi-model)"
                          : ""}
                      </div>
                    )}
                    {satelliteData.aiWarnings?.length > 0 && (
                      <div style={{ fontSize: 11, color: C.red, marginBottom: 4 }}>
                        {satelliteData.aiWarnings.join(" ")}
                      </div>
                    )}
                    {satelliteData.fieldVerify?.length > 0 && (
                      <div
                        style={{
                          fontSize: 12,
                          color: C.red,
                          fontWeight: 600,
                          padding: "6px 10px",
                          background: "rgba(239,68,68,0.1)",
                          borderRadius: 6,
                        }}
                      >
                        Field verify:{" "}
                        {satelliteData.fieldVerify
                          .map((f) =>
                            typeof f === "string"
                              ? f.replace(/_/g, " ")
                              : f.field || "",
                          )
                          .join(", ")}
                      </div>
                    )}
                    {satelliteData.notes && (
                      <div
                        style={{
                          fontSize: 11,
                          color: C.gray,
                          marginTop: 4,
                          fontStyle: "italic",
                        }}
                      >
                        {satelliteData.notes}
                      </div>
                    )}
                  </div>
                )}
            </div>
            {/* Property Data */}
            <div style={sPanel}>
              {" "}
              <div style={sPanelTitle}>Property Data</div>{" "}
              <Field label="Property Type">
                {" "}
                <Select
                  k="propertyType"
                  options={[
                    { value: "Single Family", label: "Single Family ($0)" },
                    { value: "Townhome", label: "Townhome — End Unit (-$8)" },
                    {
                      value: "Townhome Interior",
                      label: "Townhome — Interior Unit (-$12)",
                    },
                    { value: "Duplex", label: "Duplex (-$10)" },
                    { value: "Condo", label: "Condo — Ground Floor (-$18)" },
                    {
                      value: "Condo Upper",
                      label: "Condo — Upper Floor (-$22)",
                    },
                    { value: "Commercial", label: "Commercial" },
                  ]}
                />{" "}
              </Field>{" "}
              <div style={sRow}>
                <Field label="Commercial">
                  <Select
                    k="isCommercial"
                    options={[
                      { value: "NO", label: "No" },
                      { value: "YES", label: "Yes" },
                    ]}
                  />
                </Field>
                <Field label="Commercial Pricing">
                  <Select
                    k="commercialPricingMode"
                    options={[
                      { value: "manual_quote", label: "Manual quote" },
                      { value: "small_commercial_pilot", label: "Small-commercial pilot" },
                    ]}
                  />
                </Field>
              </div>
              {(commercialDetected || form.commercialSubtype) && (
                <Field label="Commercial Subtype">
                  <Input k="commercialSubtype" placeholder="Optional" />
                </Field>
              )}
              {commercialDetected && (
                <div
                  style={{
                    background: "rgba(245,158,11,0.12)",
                    border: "1px solid rgba(245,158,11,0.45)",
                    color: C.amber,
                    borderRadius: 8,
                    padding: "10px 12px",
                    fontSize: 13,
                    lineHeight: 1.45,
                    marginBottom: 12,
                  }}
                >
                  {COMMERCIAL_WARNING_TEXT}
                </div>
              )}
              <div style={sRow}>
                {" "}
                <Field label="Home Sq Ft">
                  <Input k="homeSqFt" type="number" placeholder="2000" />
                </Field>{" "}
                <Field label="Stories">
                  <Input k="stories" type="number" min="1" max="4" />
                </Field>{" "}
              </div>{" "}
              <Field label="Lot Sq Ft">
                <Input k="lotSqFt" type="number" placeholder="8000" />
              </Field>
              {(form.svcTs || form.svcInjection) && (
                <div style={sRow}>
                  {" "}
                  {form.svcTs && (
                    <Field label="Bed Area (sq ft)">
                      <Input
                        k="bedArea"
                        type="number"
                        placeholder="Auto-estimate"
                      />
                    </Field>
                  )}{" "}
                  <Field label="Palms on property">
                    <Input k="palmCount" type="number" placeholder="Manual override" />
                  </Field>{" "}
                </div>
              )}
              {form.svcTs && (
                <Field label="Tree Count">
                  <Input k="treeCount" type="number" placeholder="Auto" />
                </Field>
              )}
            </div>
            {/* Property Features */}
            <div style={sPanel}>
              {" "}
              <div style={sPanelTitle}>Property Features</div>{" "}
              <div style={sRow3}>
                {" "}
                <Field label="Pool">
                  <Select
                    k="hasPool"
                    options={[
                      { value: "NO", label: "No" },
                      { value: "YES", label: "Yes" },
                    ]}
                  />
                </Field>{" "}
                <Field label="Pool Cage">
                  <Select
                    k="hasPoolCage"
                    options={[
                      { value: "NO", label: "No" },
                      { value: "YES", label: "Yes" },
                    ]}
                  />
                </Field>{" "}
                <Field label="Large Driveway">
                  <Select
                    k="hasLargeDriveway"
                    options={[
                      { value: "NO", label: "No" },
                      { value: "YES", label: "Yes" },
                    ]}
                  />
                </Field>{" "}
              </div>
              {form.hasPoolCage === "YES" && (
                <Field label="Pool Cage Size">
                  {" "}
                  <Select
                    k="poolCageSize"
                    options={[
                      { value: "SMALL", label: "Small (+$5)" },
                      { value: "MEDIUM", label: "Medium (+$8)" },
                      { value: "LARGE", label: "Large (+$12)" },
                      { value: "OVERSIZED", label: "Oversized (+$18)" },
                    ]}
                  />{" "}
                </Field>
              )}
              <div style={sRow3}>
                {" "}
                <Field label="Shrub Density">
                  <Select
                    k="shrubDensity"
                    options={[
                      { value: "LIGHT", label: "Light" },
                      { value: "MODERATE", label: "Moderate" },
                      { value: "HEAVY", label: "Heavy" },
                    ]}
                  />
                </Field>{" "}
                <Field label="Tree Density">
                  <Select
                    k="treeDensity"
                    options={[
                      { value: "LIGHT", label: "Light" },
                      { value: "MODERATE", label: "Moderate" },
                      { value: "HEAVY", label: "Heavy" },
                    ]}
                  />
                </Field>{" "}
                <Field label="Complexity">
                  <Select
                    k="landscapeComplexity"
                    options={[
                      { value: "SIMPLE", label: "Simple" },
                      { value: "MODERATE", label: "Moderate" },
                      { value: "COMPLEX", label: "Complex" },
                    ]}
                  />
                </Field>{" "}
              </div>{" "}
              <div style={sRow}>
                {" "}
                <Field label="Near Water">
                  <Select
                    k="nearWater"
                    options={[
                      { value: "NO", label: "No" },
                      { value: "YES", label: "Yes" },
                    ]}
                  />
                </Field>{" "}
                <Field label="Urgency">
                  <Select
                    k="urgency"
                    options={[
                      { value: "ROUTINE", label: "Routine" },
                      { value: "SOON", label: "Soon (same/next day)" },
                      { value: "URGENT", label: "Urgent (within 12 hrs)" },
                    ]}
                  />
                </Field>{" "}
              </div>{" "}
              <div style={sRow}>
                {" "}
                <Field label="After Hours">
                  <Select
                    k="isAfterHours"
                    options={[
                      { value: "NO", label: "No — business hours" },
                      {
                        value: "YES",
                        label: "Yes — evenings/weekends/holidays",
                      },
                    ]}
                  />
                </Field>{" "}
                <Field label="Recurring Customer">
                  <Select
                    k="isRecurringCustomer"
                    options={[
                      { value: "NO", label: "No — new customer" },
                      { value: "YES", label: "Yes — 15% off one-time" },
                    ]}
                  />
                </Field>{" "}
              </div>{" "}
            </div>
            {/* Services */}
            <div style={sPanel}>
              {" "}
              <div style={sPanelTitle}>Services to Quote</div>{" "}
              <div style={sSvcSection}>Recurring Programs</div>{" "}
              <Checkbox k="svcLawn" label="Lawn Care" />
              {form.svcLawn && commercialDetected && (
                <div style={{
                  ...sSubOpts,
                  background: "rgba(113,113,122,0.10)",
                  border: "1px solid rgba(113,113,122,0.30)",
                  color: C.textBody || C.muted,
                  fontSize: 13,
                }}>
                  Commercial turf treatment is auto-priced (estimated — confirmed on site). Residential lawn pricing is suppressed.
                </div>
              )}
              {form.svcLawn && !commercialDetected && (
                <div style={sSubOpts}>
                  {" "}
                  <Field label="Grass Type / Track">
                    {" "}
                    <Select
                      k="grassType"
                      options={[
                        { value: "st_augustine", label: "St. Augustine" },
                        { value: "bermuda", label: "Bermuda" },
                        { value: "zoysia", label: "Zoysia" },
                        { value: "bahia", label: "Bahia" },
                      ]}
                    />{" "}
                  </Field>{" "}
                </div>
              )}
              <Checkbox k="svcPest" label="Pest Control" />
              {form.svcPest && commercialDetected && (
                <div style={{
                  ...sSubOpts,
                  background: "rgba(113,113,122,0.10)",
                  border: "1px solid rgba(113,113,122,0.30)",
                  color: C.textBody || C.muted,
                  fontSize: 13,
                }}>
                  Commercial pest is auto-priced (estimated — confirmed on site). Residential pest pricing is suppressed.
                </div>
              )}
              {form.svcPest && !commercialDetected && (
                <div style={sSubOpts}>
                  {" "}
                  <div style={sRow}>
                    {" "}
                    <Field label="Frequency">
                      <Select
                        k="pestFreq"
                        options={[
                          { value: "4", label: "Quarterly (4x/yr)" },
                          { value: "6", label: "Bi-Monthly (6x/yr)" },
                          { value: "12", label: "Monthly (12x/yr)" },
                        ]}
                      />
                    </Field>{" "}
                    <Field label="Roach Activity on Initial Visit">
                      <Select
                        k="roachModifier"
                        options={[
                          { value: "NONE", label: "None" },
                          {
                            value: "REGULAR",
                            label: "Native / Palmetto / American roaches",
                          },
                          {
                            value: "GERMAN",
                            label: "German roaches",
                          },
                        ]}
                      />
                    </Field>{" "}
                  </div>{" "}
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
                    Adds a one-time Initial Roach Knockdown line to recurring pest. This is not a recurring per-visit multiplier.
                  </div>
                </div>
              )}
              <Checkbox k="svcTs" label="Tree & Shrub" />{" "}
              <Checkbox k="svcInjection" label="Palm Injection" />{" "}
              {form.svcInjection && (
                <div
                  style={{
                    marginLeft: 28,
                    marginBottom: 8,
                    padding: 12,
                    background: "rgba(255,255,255,0.05)",
                    borderRadius: 8,
                  }}
                >
                  <div style={sRow}>
                    <Field label="Treatment Type">
                      <Select
                        k="palmTreatmentType"
                        options={[
                          { value: "nutrition", label: "Palm Nutrition Injection" },
                          { value: "insecticide", label: "Preventive Palm Insecticide" },
                          { value: "combo", label: "Nutrition + Insecticide" },
                        ]}
                      />
                    </Field>
                    <Field label="Palms to treat">
                      <Input k="palmTreatmentCount" type="number" placeholder={form.palmCount || "Required"} />
                    </Field>
                  </div>
                  {(form.palmTreatmentType === "insecticide" || form.palmTreatmentType === "combo") && (
                    <Field label="Palm size for this treatment">
                      <Select
                        k="palmSize"
                        options={[
                          { value: "small", label: "Small" },
                          { value: "medium", label: "Medium" },
                          { value: "large", label: "Large" },
                        ]}
                      />
                    </Field>
                  )}
                  {(hasInvalidPositiveInteger(form.palmCount) ||
                    hasInvalidPositiveInteger(form.palmTreatmentCount) ||
                    !(
                      parsePositiveInteger(form.palmTreatmentCount) ||
                      (String(form.palmTreatmentCount || "").trim() === "" && parsePositiveInteger(form.palmCount))
                    )) && (
                    <div style={{ color: C.warn, fontSize: 12 }}>
                      Palm count is required for palm injection pricing.
                    </div>
                  )}
                </div>
              )}
              <Checkbox k="svcMosquito" label="Mosquito Program" />{" "}
              <Checkbox k="svcTermiteBait" label="Termite Bait Stations" />{" "}
              <Checkbox k="svcRodentBait" label="Rodent Bait Stations" />
              {/* Dynamic tier badge */}
              {livePreview.recurringCount > 0 && (
                <div
                  style={{
                    margin: "12px 0 6px 0",
                    padding: "8px 14px",
                    borderRadius: 8,
                    background:
                      livePreview.tier.discount > 0
                        ? "rgba(16,185,129,0.08)"
                        : "rgba(14,165,233,0.08)",
                    border: `1px solid ${livePreview.tier.discount > 0 ? "rgba(16,185,129,0.25)" : "rgba(14,165,233,0.2)"}`,
                    fontSize: 13,
                    color: livePreview.tier.discount > 0 ? C.green : C.teal,
                  }}
                >
                  {livePreview.recurringCount} service
                  {livePreview.recurringCount > 1 ? "s" : ""} selected{" "}
                  {"\u2192"} <strong>WaveGuard {livePreview.tier.name}</strong>
                  {livePreview.tier.discount > 0
                    ? ` (${Math.round(livePreview.tier.discount * 100)}% bundle discount)`
                    : " (no discount \u2014 add 1 more for Silver 10%)"}
                </div>
              )}
              {livePreview.commercialManualQuoteCount > 0 && (
                <div
                  style={{
                    margin: "12px 0 6px 0",
                    padding: "8px 14px",
                    borderRadius: 8,
                    background: "rgba(245,158,11,0.12)",
                    border: "1px solid rgba(245,158,11,0.45)",
                    fontSize: 13,
                    color: C.amber,
                  }}
                >
                  {livePreview.commercialManualQuoteCount} commercial selection
                  {livePreview.commercialManualQuoteCount > 1 ? "s" : ""} (mosquito / termite) set to manual quote.
                </div>
              )}
              <div style={sSvcSection}>One-Time Services</div>
              {/* -- Lawn Services -- */}
              <div style={{ ...sSvcSection, color: C.green, fontSize: 11 }}>
                Lawn
              </div>{" "}
              <Checkbox k="svcOnetimeLawn" label="Lawn Treatment" />
              {form.svcOnetimeLawn && (
                <div style={sSubOpts}>
                  {" "}
                  <Field label="Type" style={{ marginBottom: 0 }}>
                    {" "}
                    <Select
                      k="otLawnType"
                      options={[
                        { value: "FERT", label: "Fertilization (base)" },
                        { value: "WEED", label: "Weed Control (+15%)" },
                        { value: "PEST", label: "Lawn Pest (+30%)" },
                        { value: "FUNGICIDE", label: "Fungicide (+45%)" },
                      ]}
                    />{" "}
                  </Field>{" "}
                </div>
              )}
              <Checkbox k="svcPlugging" label="Lawn Plugging" />
              {form.svcPlugging && (
                <div style={sSubOpts}>
                  {" "}
                  <div style={sRow}>
                    {" "}
                    <Field label="Plug Area (sq ft)">
                      <Input
                        k="plugArea"
                        type="number"
                        placeholder="e.g. 1000"
                      />
                    </Field>{" "}
                    <Field label="Spacing">
                      <Select
                        k="plugSpacing"
                        options={[
                          { value: "12", label: '12" Economy' },
                          { value: "9", label: '9" Standard' },
                          { value: "6", label: '6" Premium' },
                        ]}
                      />
                    </Field>{" "}
                  </div>{" "}
                </div>
              )}
              <Checkbox k="svcTopdress" label="Top Dressing" />{" "}
              <Checkbox
                k="svcDethatch"
                label={
                  isDethatchingStAugustine
                    ? "Dethatching - manager approval required for St. Augustine / Floratam"
                    : "Dethatching"
                }
              />{" "}
              {form.svcDethatch && (
                <div style={sSubOpts}>
                  <div style={sRow}>
                    <Field label="Lawn Sq Ft Used">
                      <input
                        type="text"
                        readOnly
                        value={`${Math.round(dethatchingLawnSqFtUsed || 0).toLocaleString()} sf`}
                        style={{ ...sInput, background: "rgba(255,255,255,0.04)" }}
                      />
                    </Field>
                    <Field label="Grass Type / Track">
                      <Select
                        k="grassType"
                        options={[
                          { value: "st_augustine", label: "St. Augustine / Floratam" },
                          { value: "bermuda", label: "Bermuda" },
                          { value: "zoysia", label: "Zoysia" },
                          { value: "bahia", label: "Bahia" },
                          { value: "unknown", label: "Unknown - review" },
                        ]}
                      />
                    </Field>
                  </div>
                  <div style={sRow}>
                    <Field label="Cleanup Level">
                      <Select
                        k="dethatchingCleanupLevel"
                        options={[
                          { value: "none", label: "No debris removal" },
                          { value: "light", label: "Light cleanup" },
                          { value: "moderate", label: "Moderate cleanup" },
                          { value: "heavy", label: "Heavy cleanup / bagging" },
                        ]}
                      />
                    </Field>
                    <Field label="Access">
                      <Select
                        k="dethatchingAccess"
                        options={[
                          { value: "easy", label: "Easy" },
                          { value: "moderate", label: "Moderate" },
                          { value: "difficult", label: "Difficult - review" },
                        ]}
                      />
                    </Field>
                  </div>
                  <Checkbox k="dethatchingDebrisRemovalIncluded" label="Debris removal included" />
                  <div style={sRow}>
                    <Field label="Thatch Probe #1">
                      <Input k="thatchProbe1Inches" type="number" min="0" placeholder="inches" />
                    </Field>
                    <Field label="Thatch Probe #2">
                      <Input k="thatchProbe2Inches" type="number" min="0" placeholder="inches" />
                    </Field>
                    <Field label="Thatch Probe #3">
                      <Input k="thatchProbe3Inches" type="number" min="0" placeholder="inches" />
                    </Field>
                  </div>
                  {form.dethatchingCleanupLevel === "none" && !form.dethatchingDebrisRemovalIncluded && (
                    <div style={{ ...sModNote, marginBottom: 8 }}>
                      Base price does not include bagging or debris hauling.
                    </div>
                  )}
                  {(form.dethatchingCleanupLevel === "moderate" || form.dethatchingCleanupLevel === "heavy" || form.dethatchingDebrisRemovalIncluded) && (
                    <div style={{ ...sModNote, marginBottom: 8 }}>
                      Cleanup/debris removal included.
                    </div>
                  )}
                  {isDethatchingStAugustine && (
                    <div style={{ ...statusStyle("err"), marginBottom: 12 }}>
                      Manager approval required. Dethatching St. Augustine / Floratam can damage stolons.
                    </div>
                  )}
                  {isDethatchingStAugustine && (
                    <div style={sRow}>
                      <Field label="Manager Approval Reason">
                        <Select
                          k="dethatchingManagerApprovalReason"
                          options={[
                            { value: "", label: "Select reason" },
                            { value: "verified_thatch_probe", label: "Verified thatch probe" },
                            { value: "customer_requested_after_warning", label: "Customer requested after warning" },
                            { value: "bermuda_or_zoysia_confirmed", label: "Bermuda/Zoysia confirmed" },
                            { value: "manager_override", label: "Manager override" },
                          ]}
                        />
                      </Field>
                      <div style={{ paddingTop: 28, flex: 1 }}>
                        <Checkbox k="dethatchingManagerApproved" label="Manager approval confirmed" />
                      </div>
                    </div>
                  )}
                </div>
              )}
              <Checkbox k="svcOverseed" label="Overseeding" />
              {/* -- Termite Services -- */}
              <div style={{ ...sSvcSection, color: C.red, fontSize: 11 }}>
                Termite
              </div>{" "}
              <Checkbox k="svcWdo" label="WDO / Termite Inspection" />{" "}
              <Checkbox k="svcTrenching" label="Termite Trenching" />{" "}
              <Checkbox k="svcBoracare" label="Termite Attic Remediation" />
              <Checkbox k="svcPreslab" label="Pre-Slab Termiticide Treatment" />
              {hasAnyTermiteSelection && (
                <div style={sSubOpts}>
                  {" "}
                  <div style={{ fontSize: 13, fontWeight: 600, color: C.heading, marginBottom: 6 }}>
                    Termite Measurements
                  </div>
                  <div style={{ fontSize: 11, color: C.gray, marginBottom: 12 }}>
                    Manual/admin-entered values override property lookup.
                  </div>
                  {termiteMeasurementWarnings.length > 0 && (
                    <div style={{ ...statusStyle("err"), marginBottom: 12 }}>
                      {termiteMeasurementWarnings.join(" ")}
                    </div>
                  )}
                  {form.svcTermiteBait && (
                    <>
                      <div style={sRow}>
                        <Field label="Footprint Sq Ft">
                          <Input k="termiteFootprintSqFt" type="number" placeholder="Admin-entered" />
                        </Field>
                        <Field label="Perimeter LF Override">
                          <Input k="termitePerimeterLF" type="number" placeholder="Optional" />
                        </Field>
                      </div>
                      <div style={sRow}>
                        <Field label="Layout">
                          <Select
                            k="termiteBaitComplexity"
                            options={[
                              { value: "", label: "Auto from property" },
                              { value: "standard", label: "Standard" },
                              { value: "moderate", label: "Moderate" },
                              { value: "complex", label: "Complex" },
                            ]}
                          />
                        </Field>
                        <Field label="System">
                          <Select
                            k="termiteBaitSystem"
                            options={[
                              { value: "advance", label: "Advance" },
                              { value: "trelona", label: "Trelona" },
                            ]}
                          />
                        </Field>
                      </div>
                      <Field label="Monitoring">
                        <Select
                          k="termiteMonitoringTier"
                          options={[
                            { value: "basic", label: "Basic" },
                            { value: "premier", label: "Premier" },
                          ]}
                        />
                      </Field>
                    </>
                  )}
                  {form.svcTrenching && (
                    <>
                      <Field label="Trenching Product">
                        <Select
                          k="trenchingProductKey"
                          options={TRENCHING_PRODUCT_OPTIONS}
                        />
                      </Field>
                      <div style={sRow}>
                        <Field label="Application Rate">
                          <Select
                            k="trenchingApplicationRate"
                            options={[
                              { value: "standard", label: "Standard 0.06%" },
                              { value: "high", label: "High/problem-soil rate" },
                            ]}
                          />
                        </Field>
                        <Field label="Trench Depth">
                          <Select
                            k="trenchingDepthFt"
                            options={[
                              { value: "0.5", label: "0.5 ft / 6 in" },
                              { value: "1", label: "1.0 ft / 12 in" },
                              { value: "1.5", label: "1.5 ft / 18 in" },
                            ]}
                          />
                        </Field>
                      </div>
                      <Field label="Warranty">
                        <Select
                          k="trenchingWarrantyTier"
                          options={[
                            { value: "none", label: "None" },
                            { value: "one_year_retreat", label: "1-Year Retreat" },
                            { value: "three_year_repair_retreat", label: "3-Year Repair + Retreat" },
                            { value: "five_year_repair_retreat", label: "5-Year Repair + Retreat" },
                          ]}
                        />
                      </Field>
                      <div style={sRow}>
                        <Field label="Perimeter LF">
                          <Input k="trenchingPerimeterLF" type="number" placeholder="Measured LF" />
                        </Field>
                        <Field label="Concrete / Slab LF">
                          <Input k="trenchingConcreteLF" type="number" placeholder="Optional" />
                        </Field>
                      </div>
                      <div style={sRow}>
                        <Field label="Dirt Trench LF">
                          <Input k="trenchingDirtLF" type="number" placeholder="Optional" />
                        </Field>
                        <Field label="Concrete %">
                          <Input k="trenchingConcretePct" type="number" placeholder="0.40 or 40" />
                        </Field>
                      </div>
                      <Checkbox k="trenchingEstimateFromFootprint" label="Estimate trenching perimeter from footprint" />
                      <Checkbox
                        k="trenchingLabelConfirmed"
                        label="Label rate and trench depth confirmed"
                      />
                      <div style={sModNote}>
                        {(TRENCHING_PRODUCT_META[form.trenchingProductKey] || TRENCHING_PRODUCT_META.taurus_sc).warning}
                        {form.trenchingApplicationRate === "high" ? " High rate requires label confirmation." : ""}
                      </div>
                      <div style={sSeasonal}>
                        Admin config: {(TRENCHING_PRODUCT_META[form.trenchingProductKey] || TRENCHING_PRODUCT_META.taurus_sc).config}
                      </div>
                    </>
                  )}
                  {form.svcBoracare && (
                    <Field label="Attic / Raw Wood Sq Ft">
                      <Input k="boracareSqft" type="number" placeholder="Admin-entered" />
                    </Field>
                  )}
                  {form.svcPreslab && (
                    <>
                      <Field label="Product">
                        <Select
                          k="preslabProductKey"
                          options={PRE_SLAB_PRODUCT_OPTIONS}
                        />
                      </Field>
                      <div style={sRow}>
                        {" "}
                        <Field label="Slab Sq Ft">
                          <Input
                            k="preslabSqft"
                            type="number"
                            placeholder="Admin-entered"
                          />
                        </Field>{" "}
                        <Field label="Warranty">
                          <Select
                            k="preslabWarranty"
                            options={[
                              { value: "NONE", label: "No warranty" },
                              { value: "BASIC", label: "Basic 1-yr (included)" },
                              { value: "EXTENDED", label: "Extended 5-yr (+$200)" },
                            ]}
                          />
                        </Field>{" "}
                      </div>{" "}
                      <Field label="Builder Volume">
                        <Select
                          k="preslabVolume"
                          options={[
                            { value: "NONE", label: "No discount" },
                            { value: "5", label: "5+ homes (-10%)" },
                            { value: "10", label: "10+ homes (-15%)" },
                          ]}
                        />
                      </Field>{" "}
                      <Field label="Pre-Slab Job Context">
                        <Select
                          k="preslabJobContext"
                          options={PRE_SLAB_JOB_CONTEXT_OPTIONS}
                        />
                      </Field>
                      <Checkbox
                        k="preslabLabelConfirmed"
                        label="Label rate and finished dilution confirmed"
                      />
                      <div style={sModNote}>
                        Certificate of Compliance required. {(PRE_SLAB_PRODUCT_META[form.preslabProductKey] || PRE_SLAB_PRODUCT_META.termidor_sc).warning}
                      </div>
                      <div style={sSeasonal}>
                        Admin config: {(PRE_SLAB_PRODUCT_META[form.preslabProductKey] || PRE_SLAB_PRODUCT_META.termidor_sc).config}
                      </div>
                    </>
                  )}
                </div>
              )}
              <Checkbox k="svcFoam" label="Termite Foam Treatment" />
              {form.svcFoam && (
                <div style={sSubOpts}>
                  {" "}
                  <Field label="Drill Points" style={{ marginBottom: 0 }}>
                    {" "}
                    <Select
                      k="foamPoints"
                      options={[
                        { value: "5", label: "1-5 Spot" },
                        { value: "10", label: "6-10 Moderate" },
                        { value: "15", label: "11-15 Extensive" },
                        { value: "20", label: "15+ Full Perimeter" },
                      ]}
                    />{" "}
                  </Field>{" "}
                </div>
              )}
              <Checkbox k="svcFoamRecurring" label="Recurring Foam Treatment" />
              {form.svcFoamRecurring && (
                <div style={sSubOpts}>
                  {" "}
                  <Field label="Cadence" style={{ marginBottom: 8 }}>
                    {" "}
                    <Select
                      k="foamRecurringFreq"
                      options={[
                        { value: "quarterly", label: "Quarterly (every 3 mo) — 10% off" },
                        { value: "bimonthly", label: "Bimonthly (every 2 mo) — 15% off" },
                        { value: "monthly", label: "Monthly — 20% off" },
                      ]}
                    />{" "}
                  </Field>{" "}
                  <Field label="Drill Points" style={{ marginBottom: 0 }}>
                    {" "}
                    <Select
                      k="foamRecurringPoints"
                      options={[
                        { value: "5", label: "1-5 Spot" },
                        { value: "10", label: "6-10 Moderate" },
                        { value: "15", label: "11-15 Extensive" },
                        { value: "20", label: "15+ Full Perimeter" },
                      ]}
                    />{" "}
                  </Field>{" "}
                </div>
              )}
              {/* -- Pest Services -- */}
              <div style={{ ...sSvcSection, color: C.amber, fontSize: 11 }}>
                Pest
              </div>{" "}
              <Checkbox k="svcOnetimePest" label="Pest Treatment" />{" "}
              <Checkbox k="svcOnetimeMosquito" label="Mosquito Treatment" />{" "}
              <Checkbox k="svcFlea" label="Flea Treatment" />{" "}
              <Checkbox k="svcRoach" label="Cockroach Specialty Service" />
              {form.svcRoach && (
                <div style={sSubOpts}>
                  {" "}
                  <div style={{ fontSize: 12, fontWeight: 700, color: C.ink, marginBottom: 8 }}>
                    Standalone / Specialty Services
                  </div>
                  <Field label="Service Type" style={{ marginBottom: 0 }}>
                    {" "}
                    <Select
                      k="roachType"
                      options={[
                        {
                          value: "REGULAR",
                          label: "Standalone Native Cockroach Treatment",
                        },
                        { value: "GERMAN", label: "German Roach Cleanout" },
                      ]}
                    />{" "}
                  </Field>{" "}
                  {form.roachType === "GERMAN" && (
                    <Field label="Infestation Severity" style={{ marginBottom: 0, marginTop: 8 }}>
                      <Select
                        k="germanRoachSeverity"
                        options={[
                          { value: "light", label: "Light — 2 Visits ($350)" },
                          { value: "moderate", label: "Medium — 3 Visits ($450)" },
                          { value: "heavy", label: "Heavy — 4 Visits ($550)" },
                        ]}
                      />
                    </Field>
                  )}
                  {form.roachType === "GERMAN" && (
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
                      German Roach Cleanout is a separate specialty program, not the German version of native cockroach treatment.
                    </div>
                  )}
                </div>
              )}
              <Checkbox k="svcWasp" label="Wasp/Bee/Stinging Insect" />{" "}
              <Checkbox k="svcBedbug" label="Bed Bug Treatment" />
              {form.svcBedbug && (
                <div style={sSubOpts}>
                  {" "}
                  <div style={sRow}>
                    {" "}
                    <Field label="Rooms">
                      <Input k="bedbugRooms" type="number" min="1" max="10" />
                    </Field>{" "}
                    <Field label="Method">
                      <Select
                        k="bedbugMethod"
                        options={[
                          { value: "CHEMICAL", label: "Chemical Only" },
                          { value: "HEAT", label: "Heat Only" },
                          { value: "HYBRID", label: "Hybrid" },
                        ]}
                      />
                    </Field>{" "}
                  </div>{" "}
                  <div style={sRow3}>
                    <Field label="Severity">
                      <Select
                        k="bedbugSeverity"
                        options={[
                          { value: "light", label: "Light" },
                          { value: "moderate", label: "Moderate" },
                          { value: "heavy", label: "Heavy" },
                          { value: "severe", label: "Severe/Quote" },
                        ]}
                      />
                    </Field>
                    <Field label="Prep">
                      <Select
                        k="bedbugPrepStatus"
                        options={[
                          { value: "ready", label: "Ready" },
                          { value: "partial", label: "Partial" },
                          { value: "poor", label: "Poor" },
                          { value: "refused", label: "Refused/Quote" },
                        ]}
                      />
                    </Field>
                    <Field label="Occupancy">
                      <Select
                        k="bedbugOccupancyType"
                        options={[
                          { value: "singleFamily", label: "Single Family" },
                          { value: "apartment", label: "Apartment" },
                          { value: "hotel", label: "Hotel" },
                          { value: "studentHousing", label: "Student Housing" },
                        ]}
                      />
                    </Field>
                  </div>
                  {form.bedbugMethod !== "CHEMICAL" && (
                    <div style={sRow3}>
                      <Field label="Equipment">
                        <Select
                          k="bedbugEquipment"
                          options={[
                            { value: "INHOUSE", label: "In-House" },
                            { value: "SUBCONTRACT", label: "Subcontract" },
                          ]}
                        />
                      </Field>
                      <Field label="Heat Scope">
                        <Select
                          k="bedbugHeatScope"
                          options={[
                            { value: "ROOMS_ONLY", label: "Rooms Only" },
                            { value: "WHOLE_HOME", label: "Whole Home" },
                          ]}
                        />
                      </Field>
                      {form.bedbugEquipment === "SUBCONTRACT" && (
                        <Field label="Vendor Cost">
                          <Input k="bedbugSubcontractCost" type="number" min="1" />
                        </Field>
                      )}
                    </div>
                  )}
                </div>
              )}
              {/* -- Rodent Services -- */}
              <div style={{ ...sSvcSection, color: C.gray, fontSize: 11 }}>
                Rodent
              </div>{" "}
              <Checkbox k="svcRodentTrap" label="Rodent Trapping" />{" "}
              <Checkbox k="svcRodentSanitation" label="Rodent Sanitation" />{" "}
              <Checkbox k="svcExclusion" label="Rodent Exclusion" />
              {form.svcExclusion && (
                <div style={sSubOpts}>
                  {" "}
                  <div style={sRow3}>
                    {" "}
                    <Field label="Simple Seals">
                      <Input k="exclSimple" type="number" min="0" />
                    </Field>{" "}
                    <Field label="Moderate">
                      <Input k="exclModerate" type="number" min="0" />
                    </Field>{" "}
                    <Field label="Advanced/Roof">
                      <Input k="exclAdvanced" type="number" min="0" />
                    </Field>{" "}
                  </div>{" "}
                  <Field label="Waive Inspection ($85)?">
                    <Select
                      k="exclWaive"
                      options={[
                        { value: "NO", label: "No — charge $85" },
                        { value: "YES", label: "Yes — booking work" },
                      ]}
                    />
                  </Field>{" "}
                </div>
              )}
            </div>
            {/* Manual recurring discount (stacks on top of WaveGuard bundle discount) */}
            <div style={{ ...sPanel, borderColor: C.border, marginBottom: 14 }}>
              {" "}
              <div style={sPanelTitle}>Manual Recurring Discount (optional)</div>{" "}
              <div style={{ marginBottom: 10 }}>
                {" "}
                <Field label="Preset">
                  {" "}
                  <select
                    value={form.manualDiscountPreset || ""}
                    onChange={(e) => applyDiscountPreset(e.target.value)}
                    style={{
                      width: "100%",
                      padding: "8px 10px",
                      borderRadius: 6,
                      border: `1px solid ${C.border}`,
                      background: C.white,
                      color: C.text,
                      fontSize: 14,
                    }}
                  >
                    {" "}
                    <option value="">— None —</option>
                    {discountPresets.map((d) => {
                      const amt = discountPresetAmountLabel(d);
                      return (
                        <option key={d.id} value={d.discount_key}>
                          {d.name} — {amt}
                        </option>
                      );
                    })}
                    <option value="__custom__">Custom…</option>{" "}
                  </select>{" "}
                </Field>{" "}
              </div>{" "}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "140px 120px 1fr",
                  gap: 10,
                }}
              >
                {" "}
                <Field label="Type">
                  {" "}
                  <Select
                    k="manualDiscountType"
                    options={[
                      { value: "NONE", label: "None" },
                      { value: "PERCENT", label: "Percent %" },
                      { value: "FIXED", label: "Dollar $" },
                    ]}
                  />{" "}
                </Field>{" "}
                <Field label="Amount">
                  {" "}
                  <Input
                    k="manualDiscountValue"
                    type="number"
                    min="0"
                    placeholder="0"
                  />{" "}
                </Field>{" "}
                <Field label="Label (shown on estimate)">
                  {" "}
                  <Input
                    k="manualDiscountLabel"
                    placeholder="e.g. Military, Referral"
                  />{" "}
                </Field>{" "}
              </div>{" "}
              <div style={{ marginTop: 10 }}>
                <Field label="Internal reason">
                  <Input
                    k="manualDiscountInternalReason"
                    placeholder="Required for custom or eligibility override"
                  />
                </Field>
                <label style={{ ...sCheckbox, marginTop: 2 }}>
                  <input
                    type="checkbox"
                    checked={form.manualDiscountEligibilityConfirmed === true}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        manualDiscountEligibilityConfirmed: e.target.checked,
                      }))
                    }
                    style={sCb}
                  />
                  Eligibility confirmed or approved override
                </label>
                {form.manualDiscountEligibilityConfirmed && (
                  <Field label="Override reason">
                    <Input
                      k="manualDiscountEligibilityOverrideReason"
                      placeholder="e.g. verified ID, referral noted, annual prepay confirmed"
                    />
                  </Field>
                )}
              </div>
              <div style={{ fontSize: 12, color: C.gray, marginTop: 4 }}>
                Applies after WaveGuard bundle discount. Re-click Generate
                Estimate to recalculate.
              </div>{" "}
            </div>
            {serviceCreditPresets.length > 0 && (
              <div style={{ ...sPanel, borderColor: C.border, marginBottom: 14 }}>
                <div style={sPanelTitle}>Service-Specific Credits</div>
                {serviceCreditPresets.map((credit) => {
                  const key = credit.discount_key || credit.key;
                  const checked = (form.serviceSpecificDiscountKeys || []).includes(key);
                  return (
                    <label key={credit.id || key} style={{ ...sCheckbox, justifyContent: "space-between" }}>
                      <span>{credit.name}</span>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggleServiceSpecificDiscount(key)}
                        style={sCb}
                      />
                    </label>
                  );
                })}
              </div>
            )}
            {/* Action buttons */}
            <div
              className="estimate-actions"
              style={{
                display: "grid",
                gridTemplateColumns: "1fr 1fr",
                gap: 12,
                marginBottom: 18,
              }}
            >
              {" "}
              <button
                style={{
                  ...sBtn(C.teal, "#fff"),
                  fontSize: 16,
                  padding: "16px 28px",
                }}
                onClick={() => doGenerate()}
              >
                GENERATE ESTIMATE
              </button>{" "}
              <button
                style={{
                  ...sBtn(C.blue, "#fff"),
                  fontSize: 16,
                  padding: "16px 28px",
                }}
                onClick={() => {
                  if (!estimate) {
                    doGenerate();
                  }
                  setShowSendForm(true);
                }}
              >
                SEND ESTIMATE
              </button>{" "}
            </div>
            {/* Send Estimate Form */}
            {showSendForm && (
              <div style={{ ...sPanel, borderColor: C.teal }}>
                {" "}
                <div style={sPanelTitle}>Send Estimate</div>{" "}
                <Field label="Customer Phone Number">
                  {" "}
                  <input
                    type="tel"
                    value={form.customerPhone || ""}
                    onChange={async (e) => {
                      let raw = e.target.value.replace(/\D/g, "");
                      if (raw.length === 11 && raw.startsWith("1"))
                        raw = raw.slice(1);
                      const digits = raw.slice(0, 10);
                      set("customerPhone", digits);
                      if (digits.length >= 7) {
                        try {
                          const r = await fetch(
                            `/api/admin/customers?search=${encodeURIComponent(digits)}&limit=1`,
                            { headers: authHeaders },
                          );
                          if (r.ok) {
                            const d = await r.json();
                            const c = (d.customers || d)?.[0];
                            if (c) {
                              set(
                                "customerName",
                                `${c.firstName} ${c.lastName}`,
                              );
                              set("customerEmail", c.email || "");
                            }
                          }
                        } catch {
                          /* ignore */
                        }
                      }
                    }}
                    placeholder="9415551234"
                    style={{
                      ...sInput,
                      fontSize: 20,
                      fontWeight: 700,
                      letterSpacing: 1,
                    }}
                  />{" "}
                </Field>
                {form.customerName && (
                  <div
                    style={{
                      fontSize: 14,
                      color: C.green,
                      marginBottom: 12,
                      padding: "8px 12px",
                      background: "rgba(16,185,129,0.1)",
                      borderRadius: 8,
                    }}
                  >
                    Found: <strong>{form.customerName}</strong>
                    {form.customerEmail ? ` · ${form.customerEmail}` : ""}
                  </div>
                )}
                {!form.customerName && form.customerPhone?.length >= 7 && (
                  <div style={{ marginBottom: 12 }}>
                    {" "}
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: "1fr 1fr",
                        gap: 8,
                      }}
                    >
                      {" "}
                      <Field label="Name">
                        <input
                          type="text"
                          value={form.customerName || ""}
                          onChange={(e) => set("customerName", e.target.value)}
                          placeholder="Full name"
                          style={sInput}
                        />
                      </Field>{" "}
                      <Field label="Email">
                        <input
                          type="email"
                          value={form.customerEmail || ""}
                          onChange={(e) => set("customerEmail", e.target.value)}
                          placeholder="email@example.com"
                          style={sInput}
                        />
                      </Field>{" "}
                    </div>{" "}
                  </div>
                )}
                {/* Schedule toggle */}
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    marginBottom: 8,
                  }}
                >
                  {" "}
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      cursor: "pointer",
                      fontSize: 13,
                      color: C.gray,
                    }}
                  >
                    {" "}
                    <input
                      type="checkbox"
                      checked={form.scheduleSend || false}
                      onChange={(e) => set("scheduleSend", e.target.checked)}
                      style={{ accentColor: C.teal }}
                    />
                    Schedule for later
                  </label>
                  {form.scheduleSend && (
                    <input
                      type="datetime-local"
                      value={form.scheduledAt || ""}
                      onChange={(e) => set("scheduledAt", e.target.value)}
                      style={{
                        ...sInput,
                        width: "auto",
                        padding: "6px 10px",
                        fontSize: 13,
                      }}
                    />
                  )}
                </div>
                {form.scheduleSend && !form.scheduledAt && (
                  <div
                    style={{ fontSize: 11, color: C.amber, marginBottom: 8 }}
                  >
                    Quick:{" "}
                    <button
                      onClick={() => {
                        const tomorrow = new Date();
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        tomorrow.setHours(8, 0, 0, 0);
                        set("scheduledAt", tomorrow.toISOString().slice(0, 16));
                      }}
                      style={{
                        background: "none",
                        border: "none",
                        color: C.teal,
                        cursor: "pointer",
                        fontSize: 11,
                        fontWeight: 600,
                        textDecoration: "underline",
                      }}
                    >
                      Tomorrow 8:00 AM
                    </button>{" "}
                  </div>
                )}
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  {" "}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr 1fr",
                      gap: 8,
                    }}
                  >
                    {" "}
                    <button
                      style={{
                        ...sBtn(C.green, "white"),
                        fontSize: 13,
                        padding: "12px 10px",
                      }}
                      onClick={async () => {
                        if (!form.customerPhone) {
                          alert("Enter a phone number.");
                          return;
                        }
                        await saveAndSend("sms");
                      }}
                      disabled={sending}
                    >
                      {sending
                        ? "..."
                        : form.scheduleSend
                          ? "Schedule SMS"
                          : "SMS Only"}
                    </button>{" "}
                    <button
                      style={{
                        ...sBtn(C.blue, "#fff"),
                        fontSize: 13,
                        padding: "12px 10px",
                      }}
                      onClick={async () => {
                        if (!form.customerEmail) {
                          alert("Enter an email.");
                          return;
                        }
                        await saveAndSend("email");
                      }}
                      disabled={sending}
                    >
                      {sending
                        ? "..."
                        : form.scheduleSend
                          ? "Schedule Email"
                          : "Email Only"}
                    </button>{" "}
                    <button
                      style={{
                        ...sBtn(C.teal, "white"),
                        fontSize: 13,
                        padding: "12px 10px",
                      }}
                      onClick={async () => {
                        if (!form.customerPhone && !form.customerEmail) {
                          alert("Enter phone or email.");
                          return;
                        }
                        await saveAndSend("both");
                      }}
                      disabled={sending}
                    >
                      {sending
                        ? "..."
                        : form.scheduleSend
                          ? "Schedule Both"
                          : "Both"}
                    </button>{" "}
                  </div>{" "}
                  <button
                    style={{
                      ...sBtn("transparent", C.gray),
                      fontSize: 13,
                      padding: "10px 16px",
                      border: `1px solid ${C.border}`,
                    }}
                    onClick={() => setShowSendForm(false)}
                  >
                    Cancel
                  </button>{" "}
                </div>{" "}
              </div>
            )}

            {savedId && (
              <div style={{ fontSize: 12, color: C.green, marginBottom: 12 }}>
                Saved — ID #{savedId}.
              </div>
            )}
          </div>
          {/* ═══ RIGHT COLUMN: RESULTS ═══ */}
          <div>
            {!estimate ? (
              <div
                style={{ ...sPanel, textAlign: "center", padding: "60px 24px" }}
              >
                {" "}
                <div style={{ fontSize: 56, marginBottom: 18 }}>
                  {livePreview.anySelected ? "\u26A1" : "\uD83D\uDCCB"}
                </div>{" "}
                <div
                  style={{
                    fontSize: 20,
                    fontWeight: 700,
                    marginBottom: 10,
                    color: C.heading,
                  }}
                >
                  {!livePreview.anySelected
                    ? "Select Services to Get Started"
                    : "Ready to Generate"}
                </div>{" "}
                <div style={{ fontSize: 15, color: C.gray, marginBottom: 16 }}>
                  {!livePreview.anySelected
                    ? "Select at least one service to see pricing"
                    : `${livePreview.totalRecurringCount || livePreview.recurringCount} recurring/manual + ${livePreview.onetimeCount} one-time selected \u2014 click Generate Estimate`}
                </div>
                {/* Mini property summary if lookup done */}
                {enrichedProfile && (
                  <div
                    style={{
                      textAlign: "left",
                      padding: "12px 16px",
                      background: C.navy,
                      borderRadius: 8,
                      border: `1px solid ${C.border}`,
                      marginTop: 10,
                      fontSize: 13,
                      color: C.gray,
                      lineHeight: 1.7,
                    }}
                  >
                    {" "}
                    <div
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: C.teal,
                        textTransform: "uppercase",
                        letterSpacing: 1,
                        marginBottom: 6,
                      }}
                    >
                      Property Loaded
                    </div>{" "}
                    <div>{form.address}</div>{" "}
                    <div>
                      {(Number(form.homeSqFt) || 0).toLocaleString()} sf home{" "}
                      {"\u00B7"} {(Number(form.lotSqFt) || 0).toLocaleString()}{" "}
                      sf lot {"\u00B7"} {form.stories || 1} story
                    </div>
                    {form.hasPool === "YES" && (
                      <div>
                        Pool: Yes{form.hasPoolCage === "YES" ? " (caged)" : ""}
                      </div>
                    )}
                    <div>
                      Shrubs: {form.shrubDensity} {"\u00B7"} Trees:{" "}
                      {form.treeDensity} {"\u00B7"} Complexity:{" "}
                      {form.landscapeComplexity}
                    </div>{" "}
                  </div>
                )}
              </div>
            ) : (
              <EstimateErrorBoundary
                key={JSON.stringify(estimate).slice(0, 100)}
              >
                {" "}
                <div style={sPanel}>
                  {" "}
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      gap: 8,
                      marginBottom: 8,
                    }}
                  >
                    {" "}
                    <button
                      style={{
                        padding: "6px 14px",
                        background: "transparent",
                        border: `1px solid ${C.teal}`,
                        borderRadius: 8,
                        color: C.teal,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                      onClick={nextEstimate}
                    >
                      Next Estimate (keep services)
                    </button>{" "}
                    <button
                      style={{
                        padding: "6px 14px",
                        background: "transparent",
                        border: `1px solid ${C.border}`,
                        borderRadius: 8,
                        color: C.gray,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                      }}
                      onClick={() => {
                        setEstimate(null);
                        setSavedId(null);
                        setShowSendForm(false);
                      }}
                    >
                      New Estimate
                    </button>{" "}
                  </div>{" "}
                  <div
                    style={{
                      maxHeight: "calc(100vh - 120px)",
                      overflowY: "auto",
                      paddingRight: 10,
                    }}
                  >
                    {/* ── Summary Card ──────────────────────── */}
                    {(E.recurring.serviceCount > 0 ||
                      E.oneTime.total > 0 ||
                      E.recurring.palmInjectionMo > 0 ||
                      E.recurring.rodentBaitMo > 0) && (
                      <>
                        {" "}
                        <div
                          style={{
                            background:
                              "linear-gradient(135deg, rgba(14,165,233,0.15), rgba(16,185,129,0.10))",
                            border: `2px solid ${C.teal}`,
                            borderRadius: C.radius,
                            padding: 24,
                            marginBottom: 24,
                            textAlign: "center",
                          }}
                        >
                          {" "}
                          <div
                            style={{
                              fontFamily: "'JetBrains Mono', monospace",
                              fontSize: 36,
                              fontWeight: 700,
                              color: C.green,
                            }}
                          >
                            {fmt(
                              E.recurring.grandTotal ||
                                E.recurring.monthlyTotal +
                                  (E.recurring.rodentBaitMo || 0) +
                                  (E.recurring.palmInjectionMo || 0),
                            )}
                            /mo
                          </div>{" "}
                          <div
                            style={{
                              fontSize: 14,
                              color: C.gray,
                              marginTop: 4,
                            }}
                          >
                            Recurring monthly
                            {E.recurring.savings > 0
                              ? ` (WaveGuard ${E.recurring.waveGuardTier} pricing)`
                              : ""}
                            {E.manualDiscount && E.manualDiscount.amount > 0
                              ? " + manual discount"
                              : ""}
                          </div>{" "}
                          <div
                            className="estimate-summary-flex"
                            style={{
                              display: "flex",
                              justifyContent: "center",
                              gap: 40,
                              marginTop: 14,
                              flexWrap: "wrap",
                            }}
                          >
                            {E.oneTime.total > 0 && (
                              <div style={{ textAlign: "center" }}>
                                {" "}
                                <div
                                  style={{
                                    fontFamily: "'JetBrains Mono', monospace",
                                    fontSize: 20,
                                    fontWeight: 700,
                                    color: C.heading,
                                  }}
                                >
                                  {fmtInt(E.oneTime.total)}
                                </div>{" "}
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: C.gray,
                                    textTransform: "uppercase",
                                    letterSpacing: 0.5,
                                  }}
                                >
                                  {E.oneTime.tmInstall > 0
                                    ? `One-Time (incl ${fmtInt(E.oneTime.tmInstall)} install)`
                                    : "WaveGuard Membership"}
                                </div>{" "}
                              </div>
                            )}
                            <div style={{ textAlign: "center" }}>
                              {" "}
                              <div
                                style={{
                                  fontFamily: "'JetBrains Mono', monospace",
                                  fontSize: 20,
                                  fontWeight: 700,
                                  color: C.heading,
                                }}
                              >
                                {fmt(E.totals.year1)}
                              </div>{" "}
                              <div
                                style={{
                                  fontSize: 12,
                                  color: C.gray,
                                  textTransform: "uppercase",
                                  letterSpacing: 0.5,
                                }}
                              >
                                Year 1 Total
                              </div>{" "}
                            </div>
                            {E.recurring.savings > 0 && (
                              <div style={{ textAlign: "center" }}>
                                {" "}
                                <div
                                  style={{
                                    fontFamily: "'JetBrains Mono', monospace",
                                    fontSize: 20,
                                    fontWeight: 700,
                                    color: C.green,
                                  }}
                                >
                                  -{fmt(E.recurring.savings)}
                                </div>{" "}
                                <div
                                  style={{
                                    fontSize: 12,
                                    color: C.gray,
                                    textTransform: "uppercase",
                                    letterSpacing: 0.5,
                                  }}
                                >
                                  Bundle Savings/yr
                                </div>{" "}
                              </div>
                            )}
                          </div>{" "}
                        </div>
                        {/* Recommendation */}
                        {E.recurring.serviceCount >= 2 &&
                          (() => {
                            const parts = [];
                            if (R.lawn) parts.push("Lawn Care");
                            if (R.pest) parts.push(R.pest.label + " Pest");
                            if (R.mq) {
                              const ri = E.results.mqMeta?.ri ?? 1;
                              parts.push(R.mq[ri].n + " Mosquito");
                            }
                            if (R.tmBait && !R.tmBait.quoteRequired && !R.tmBait.requiresMeasurement) {
                              parts.push(termiteBaitSelectionLabel(R.tmBait, form));
                            }
                            if (parts.length < 2) return null;
                            return (
                              <div
                                style={{
                                  background: "rgba(16,185,129,0.08)",
                                  border: "1px solid rgba(16,185,129,0.25)",
                                  borderRadius: 8,
                                  padding: "14px 18px",
                                  marginBottom: 20,
                                  fontSize: 14,
                                  color: C.gray,
                                  lineHeight: 1.6,
                                }}
                              >
                                {" "}
                                <strong style={{ color: C.green }}>
                                  Recommended:
                                </strong>
                                {parts.join(" + ")} for comprehensive coverage
                                at {fmt(E.recurring.monthlyTotal)}/mo recurring.
                              </div>
                            );
                          })()}
                        {/* Field verify */}
                        {E.fieldVerify?.length > 0 && (
                          <div
                            style={{
                              background: "rgba(16,185,129,0.08)",
                              border: "1px solid rgba(239,68,68,0.3)",
                              borderRadius: 8,
                              padding: "14px 18px",
                              marginBottom: 20,
                              fontSize: 14,
                              color: C.gray,
                              lineHeight: 1.6,
                            }}
                          >
                            {" "}
                            <strong style={{ color: C.red }}>
                              Field Verify:
                            </strong>
                            {E.fieldVerify
                              .map((f) =>
                                typeof f === "string"
                                  ? f
                                  : f.field || f.name || JSON.stringify(f),
                              )
                              .join(", ")}{" "}
                            — estimated from satellite data, tech should confirm
                            on-site.
                          </div>
                        )}
                      </>
                    )}

                    {/* ── Property Summary ──────────────────── */}
                    <div style={{ marginBottom: 24 }}>
                      {" "}
                      <div style={sSectionTitle}>Property Summary</div>{" "}
                      <div
                        style={{ fontSize: 15, color: C.gray, lineHeight: 1.8 }}
                      >
                        {" "}
                        <strong style={{ color: C.heading }}>
                          {E.property?.type ||
                            E.property?.propertyType ||
                            "Residential"}
                        </strong>
                        — {(E.property?.homeSqFt || 0).toLocaleString()} sf /{" "}
                        {(E.property?.lotSqFt || 0).toLocaleString()} sf lot /{" "}
                        {E.property?.stories || 1} story
                        <br />
                        Footprint:{" "}
                        <strong>
                          {(E.property?.footprint || 0).toLocaleString()} sf
                        </strong>
                        | Pool:{" "}
                        {E.property?.pool === "YES" || E.property?.pool === true
                          ? "Yes"
                          : "No"}
                        {E.property?.poolCage === "YES" ||
                        E.property?.poolCage === true
                          ? ` (caged${E.property?.poolCageSize ? `: ${String(E.property.poolCageSize).toLowerCase()}` : ""})`
                          : ""}{" "}
                        | Driveway:{" "}
                        {E.property?.largeDriveway === "YES" ||
                        E.property?.largeDriveway === true
                          ? "Large"
                          : "Normal"}
                        <br />
                        Shrubs:{" "}
                        {E.property?.shrubDensity ||
                          E.property?.shrubs ||
                          "--"}{" "}
                        | Trees:{" "}
                        {E.property?.treeDensity || E.property?.trees || "--"} |
                        Complexity:{" "}
                        {E.property?.landscapeComplexity ||
                          E.property?.complexity ||
                          "--"}{" "}
                        | Water:{" "}
                        {E.property?.nearWater &&
                        E.property.nearWater !== "NONE"
                          ? E.property.nearWater.replace(/_/g, " ")
                          : "No"}
                        {E.property?.yearBuilt && (
                          <>
                            <br />
                            Built: {E.property.yearBuilt} |{" "}
                            {E.property?.constructionMaterial} |{" "}
                            {E.property?.foundationType} foundation |{" "}
                            {E.property?.roofType} roof
                          </>
                        )}
                        {E.property?.estimatedValue && (
                          <>
                            <br />
                            Estimated value:{" "}
                            <strong style={{ color: C.heading }}>
                              $
                              {Math.round(
                                E.property.estimatedValue,
                              ).toLocaleString()}
                            </strong>
                            {E.property.estimatedValueLow &&
                            E.property.estimatedValueHigh ? (
                              <>
                                ($
                                {Math.round(
                                  E.property.estimatedValueLow,
                                ).toLocaleString()}
                                –$
                                {Math.round(
                                  E.property.estimatedValueHigh,
                                ).toLocaleString()}
                                )
                              </>
                            ) : null}
                          </>
                        )}
                        {E.urgency?.label && (
                          <>
                            <br />
                            <span style={sTag("amber")}>{E.urgency.label}</span>
                          </>
                        )}
                        {E.recurringCustomer && (
                          <span style={sTag("green")}>
                            Recurring -15% one-time
                          </span>
                        )}
                      </div>{" "}
                    </div>
                    {/* ── Pricing Modifiers ────────────────── */}
                    {E.modifiers?.length > 0 && (
                      <div style={{ marginBottom: 24 }}>
                        {" "}
                        <div style={sSectionTitle}>Pricing Modifiers</div>{" "}
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 4,
                          }}
                        >
                          {E.modifiers.map((m, i) => (
                            <div
                              key={i}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "6px 10px",
                                background:
                                  m.type === "up"
                                    ? "rgba(239,68,68,0.06)"
                                    : m.type === "down"
                                      ? "rgba(16,185,129,0.06)"
                                      : "rgba(14,165,233,0.06)",
                                borderRadius: 6,
                                border: `1px solid ${m.type === "up" ? "rgba(239,68,68,0.15)" : m.type === "down" ? "rgba(16,185,129,0.15)" : "rgba(14,165,233,0.15)"}`,
                              }}
                            >
                              {" "}
                              <span style={{ fontSize: 12, flexShrink: 0 }}>
                                {m.type === "up"
                                  ? "▲"
                                  : m.type === "down"
                                    ? "▼"
                                    : "●"}
                              </span>{" "}
                              <span
                                style={{
                                  fontSize: 12,
                                  color:
                                    m.type === "up"
                                      ? C.red
                                      : m.type === "down"
                                        ? C.green
                                        : C.gray,
                                  flex: 1,
                                }}
                              >
                                {m.label}
                              </span>{" "}
                              <span
                                style={{
                                  fontSize: 11,
                                  fontWeight: 600,
                                  fontFamily: "'JetBrains Mono', monospace",
                                  color:
                                    m.type === "up"
                                      ? C.red
                                      : m.type === "down"
                                        ? C.green
                                        : C.gray,
                                }}
                              >
                                {m.impact != null
                                  ? m.impact >= 0
                                    ? "+$" + m.impact
                                    : "-$" + Math.abs(m.impact)
                                  : "$0"}
                              </span>{" "}
                            </div>
                          ))}
                        </div>{" "}
                      </div>
                    )}

                    <PestProductionDiagnosticsPanel
                      diagnostics={E.productionDiagnostics}
                    />
                    {/* ── Recurring Programs ────────────────── */}
                    {E.hasRecurring && (
                      <>
                        {" "}
                        <div style={sGroupHeader}>Recurring Programs</div>
                        {/* Lawn */}
                        {R.lawn && (
                          <div style={{ marginBottom: 24 }}>
                            {" "}
                            <div style={sSectionTitle}>
                              Lawn Care{" "}
                              <span style={sTag("blue")}>
                                {R.lawnMeta?.lsf?.toLocaleString()} sf turf
                              </span>
                              {R.lawnMeta?.grassName && (
                                <span style={sTag("green")}>
                                  {R.lawnMeta.grassName}
                                </span>
                              )}
                            </div>{" "}
                            <TierGrid>
                              {R.lawn.map((t, i) => (
                                <TierRow
                                  key={i}
                                  name={t.name}
                                  detail={`${fmt(t.pa)}/app x ${t.v}`}
                                  price={`${fmt(t.mo)}/mo`}
                                  recommended={t.recommended}
                                  dimmed={t.dimmed}
                                  selected={
                                    String(t.v) === String(form.lawnFreq)
                                  }
                                  onSelect={() => {
                                    set("lawnFreq", String(t.v));
                                    doGenerate({ lawnFreq: t.v });
                                  }}
                                />
                              ))}
                            </TierGrid>{" "}
                          </div>
                        )}
                        {/* Pest */}
                        {R.pestTiers && (
                          <div style={{ marginBottom: 24 }}>
                            {" "}
                            <div style={sSectionTitle}>Pest Control</div>{" "}
                            <TierGrid>
                              {R.pestTiers.map((t, i) => (
                                <TierRow
                                  key={i}
                                  name={t.label}
                                  detail={`${fmt(t.pa)}/app x ${t.apps}`}
                                  price={`${fmt(t.mo)}/mo`}
                                  recommended={t.recommended}
                                  dimmed={t.dimmed}
                                  selected={
                                    String(t.apps) === String(form.pestFreq)
                                  }
                                  onSelect={() => {
                                    set("pestFreq", String(t.apps));
                                    doGenerate({ pestFreq: t.apps });
                                  }}
                                />
                              ))}
                            </TierGrid>
                            {R.pestInitialRoachPrice > 0 && (
                              <div style={sModNote}>
                                {R.pestRoachMod === "GERMAN"
                                  ? "German"
                                  : "Native"}{" "}
                                roach initial is added as a one-time knockdown,
                                not a recurring per-visit premium.
                              </div>
                            )}
                          </div>
                        )}
                        {/* Tree & Shrub */}
                        {R.ts && (
                          <div style={{ marginBottom: 24 }}>
                            {" "}
                            <div style={sSectionTitle}>
                              Tree &amp; Shrub{" "}
                              <span style={sTag("blue")}>
                                {R.tsMeta?.eb} sf beds | {R.tsMeta?.et} trees
                              </span>
                              {R.tsMeta?.bedAreaIsEstimated && (
                                <span style={sFieldVerify}>FIELD VERIFY</span>
                              )}
                            </div>{" "}
                            <TierGrid>
                              {R.ts.map((t, i) => (
                                <TierRow
                                  key={i}
                                  name={t.name}
                                  detail={`${fmt(t.pa)}/app x ${t.v}`}
                                  price={`${fmt(t.mo)}/mo`}
                                  recommended={t.recommended}
                                  dimmed={t.dimmed}
                                />
                              ))}
                            </TierGrid>{" "}
                          </div>
                        )}
                        {/* Palm Injection */}
                        {R.injection && (
                          <div style={{ marginBottom: 24 }}>
                            {" "}
                            <div style={sSectionTitle}>
                              Palm Injection{" "}
                              <span style={sTag("blue")}>
                                {R.injection.palms} palms
                              </span>
                            </div>{" "}
                            <TierGrid>
                              {" "}
                              <TierRow
                                name="Arborjet"
                                detail={
                                  R.injection.detail ||
                                  `${R.injection.palms} palms x $${R.injection.pricePerPalm || 75} x ${R.injection.appsPerYear || 2}/yr`
                                }
                                price={`${fmt(R.injection.mo)}/mo`}
                                recommended
                              />{" "}
                            </TierGrid>{" "}
                          </div>
                        )}
                        {/* Mosquito */}
                        {R.mq && (
                          <div style={{ marginBottom: 24 }}>
                            {" "}
                            <div style={sSectionTitle}>
                              Mosquito{" "}
                              <span style={sTag("amber")}>
                                Pressure {R.mqMeta?.pr}x
                              </span>
                            </div>{" "}
                            <TierGrid>
                              {R.mq.map((t, i) => {
                                const flags = mosquitoTierSelectionFlags(R, t, i);
                                return (
                                  <TierRow
                                    key={i}
                                    name={t.n}
                                    detail={`$${t.pv}/visit x ${t.v}`}
                                    price={`${fmt(t.mo)}/mo`}
                                    recommended={flags.recommended}
                                    dimmed={flags.dimmed}
                                    selected={flags.selected}
                                  />
                                );
                              })}
                            </TierGrid>{" "}
                          </div>
                        )}
                        {/* Termite Bait */}
                        {R.tmBait && (
                          <div style={{ marginBottom: 24 }}>
                            {" "}
                            <div style={sSectionTitle}>
                              Termite Bait{" "}
                              <span style={sTag("blue")}>
                                {R.tmBait.quoteRequired || R.tmBait.requiresMeasurement
                                  ? "Quote Required"
                                  : `${R.tmBait.sta} sta | ${R.tmBait.perim} ft`}
                              </span>
                            </div>{" "}
                            {R.tmBait.quoteRequired || R.tmBait.requiresMeasurement ? (
                              <div style={sModNote}>
                                Footprint sqft or perimeter LF is required before pricing termite bait.
                              </div>
                            ) : (
                              <>
                                <TierGrid>
                                  {" "}
                                  {R.tmBait.ai != null && (
                                    <TierRow
                                      name="Advance"
                                      detail={`${fmtInt(R.tmBait.ai)} install | Basic $35 | Premier $65/mo`}
                                      price="$35-65"
                                      recommended={R.tmBait.selectedSystem === "advance"}
                                      dimmed={R.tmBait.selectedSystem && R.tmBait.selectedSystem !== "advance"}
                                    />
                                  )}{" "}
                                  {R.tmBait.ti != null && (
                                    <TierRow
                                      name="Trelona"
                                      detail={`${fmtInt(R.tmBait.ti)} install | Basic $35 | Premier $65/mo`}
                                      price="$35-65"
                                      recommended={R.tmBait.selectedSystem === "trelona"}
                                      dimmed={R.tmBait.selectedSystem && R.tmBait.selectedSystem !== "trelona"}
                                    />
                                  )}{" "}
                                </TierGrid>{" "}
                                <div style={sModNote}>
                                  Install cost is a one-time setup fee, not a
                                  recurring charge
                                </div>{" "}
                              </>
                            )}
                          </div>
                        )}
                        {/* Rodent Bait */}
                        {R.rodBaitMo && (
                          <div style={{ marginBottom: 24 }}>
                            {" "}
                            <div style={sSectionTitle}>
                              Rodent Bait Stations
                            </div>{" "}
                            <TierGrid>
                              {" "}
                              <TierRow
                                name="Monthly"
                                detail={`${R.rodBaitSize} property`}
                                price={`$${R.rodBaitMo}/mo`}
                                recommended
                              />{" "}
                            </TierGrid>{" "}
                            <div style={sModNote}>
                              Not included in WaveGuard bundle discount — priced
                              separately
                            </div>{" "}
                          </div>
                        )}
                      </>
                    )}

                    {/* ── One-Time Services ────────────────── */}
                    {E.hasOneTime && (
                      <>
                        {" "}
                        <div style={sGroupHeader}>One-Time Services</div>
                        {E.oneTime.items.map((item, i) => {
                          // Top Dressing has tiers
                          if (item.name === "Top Dressing" && R.tdTiers) {
                            return (
                              <div key={i} style={{ marginBottom: 24 }}>
                                {" "}
                                <div style={sSectionTitle}>
                                  Top Dressing
                                  {E.isRecurringCustomer && (
                                    <span style={sDiscBadge}>-15%</span>
                                  )}
                                </div>{" "}
                                <TierGrid>
                                  {R.tdTiers.map((t, j) => (
                                    <TierRow
                                      key={j}
                                      name={t.name}
                                      detail={t.detail}
                                      price={fmtInt(t.price)}
                                    />
                                  ))}
                                </TierGrid>{" "}
                              </div>
                            );
                          }
                          // Trenching has renewal row
                          if (item.name === "Trenching" && R.trench) {
                            return (
                              <div key={i} style={{ marginBottom: 24 }}>
                                {" "}
                                <div style={sSectionTitle}>
                                  Trenching
                                  {E.isRecurringCustomer && (
                                    <span style={sDiscBadge}>-15%</span>
                                  )}
                                </div>{" "}
                                <TierGrid>
                                  {item.productLabel && (
                                    <TierRow
                                      name="Product"
                                      detail={`${item.productLabel} | ${item.applicationRate || "standard"} | ${item.trenchDepthFt || 1} ft`}
                                      price={item.activeIngredient || ""}
                                    />
                                  )}
                                  {" "}
                                  <TierRow
                                    name="Treatment"
                                    detail={item.detail}
                                    price={fmtInt(item.price)}
                                  />{" "}
                                  {item.productSurcharge > 0 && (
                                    <TierRow
                                      name="Product Premium"
                                      detail="Premium product/rate surcharge"
                                      price={`+$${item.productSurcharge}`}
                                    />
                                  )}
                                  {item.warrantyAdder > 0 && (
                                    <TierRow
                                      name="Warranty"
                                      detail={item.warrantyTier || "Warranty"}
                                      price={`+$${item.warrantyAdder}`}
                                    />
                                  )}
                                  <TierRow
                                    name="Renewal"
                                    detail="Annual warranty"
                                    price="$325/yr"
                                    dimmed
                                  />{" "}
                                </TierGrid>{" "}
                                <div style={sSeasonal}>
                                  Best scheduled before rainy season (Apr-May)
                                </div>{" "}
                                {item.warningText && (
                                  <div style={sModNote}>{item.warningText}</div>
                                )}
                                {item.allocatedChemicalCost !== undefined && (
                                  <div style={sSeasonal}>
                                    Internal: {item.finishedGallons} gal | {item.productOz} oz | Chemical ${item.allocatedChemicalCost}
                                    {item.labelConfirmed ? " | Label confirmed" : " | Label review required"}
                                  </div>
                                )}
                              </div>
                            );
                          }
                          // Bora-Care
                          if (item.name === "Bora-Care") {
                            return (
                              <div key={i} style={{ marginBottom: 24 }}>
                                {" "}
                                <div style={sSectionTitle}>
                                  Bora-Care Attic
                                  {E.isRecurringCustomer && (
                                    <span style={sDiscBadge}>-15%</span>
                                  )}
                                  {item.atticIsEstimated && (
                                    <span style={sFieldVerify}>
                                      FIELD VERIFY ATTIC
                                    </span>
                                  )}
                                </div>{" "}
                                <TierGrid>
                                  {" "}
                                  <TierRow
                                    name="Treatment"
                                    detail={item.detail}
                                    price={fmtInt(item.price)}
                                  />{" "}
                                </TierGrid>{" "}
                                <div style={sSeasonal}>
                                  Best time: Oct-Mar (cooler attic temps)
                                </div>{" "}
                              </div>
                            );
                          }
                          // Pre-Slab
                          if (item.name === "Pre-Slab") {
                            return (
                              <div key={i} style={{ marginBottom: 24 }}>
                                {" "}
                                <div style={sSectionTitle}>
                                  {item.displayName || "Pre-Slab Termiticide Treatment"}
                                  {E.isRecurringCustomer && (
                                    <span style={sDiscBadge}>-15%</span>
                                  )}
                                </div>{" "}
                                <TierGrid>
                                  {item.productLabel && (
                                    <TierRow
                                      name="Product"
                                      detail={item.productLabel}
                                      price={item.activeIngredient || ""}
                                    />
                                  )}
                                  {" "}
                                  <TierRow
                                    name="Treatment"
                                    detail={item.detail}
                                    price={fmtInt(item.basePrice || item.price)}
                                  />
                                  {item.warrAdd > 0 && (
                                    <TierRow
                                      name="5yr Warranty"
                                      detail="Extended transferable"
                                      price="+$200"
                                    />
                                  )}
                                </TierGrid>
                                {!item.warrAdd && String(item.warrantyTier || "BASIC").toUpperCase() !== "NONE" && (
                                  <div style={sModNote}>
                                    {item.warrantyStatus || "No extended warranty selected"}
                                  </div>
                                )}
                                {!item.warrAdd && String(item.warrantyTier || "").toUpperCase() === "NONE" && (
                                  <div style={sModNote}>No warranty selected</div>
                                )}
                                {item.warningText && (
                                  <div style={sModNote}>{item.warningText}</div>
                                )}
                                <div style={sSeasonal}>
                                  Certificate of Compliance required{item.labelConfirmed ? " | Label confirmed" : " | Label review required"}
                                  {item.productCost !== undefined && item.rawPrice !== undefined
                                    ? ` | ${item.preSlabJobContextLabel || item.jobContext || "Standalone"} | ${item.productOz} oz | Allocated material $${item.productCost.toFixed(2)} | Raw $${item.rawPrice} | Floor $${item.contextualFloor || item.priceBeforeVolumeDiscount}`
                                    : ""}
                                </div>
                              </div>
                            );
                          }
                          // Foam Drill
                          if (item.name === "Foam Drill") {
                            return (
                              <div key={i} style={{ marginBottom: 24 }}>
                                {" "}
                                <div style={sSectionTitle}>
                                  Foam Drill
                                  {E.isRecurringCustomer && (
                                    <span style={sDiscBadge}>-15%</span>
                                  )}
                                </div>{" "}
                                <TierGrid>
                                  {" "}
                                  <TierRow
                                    name={item.tierName}
                                    detail={item.detail}
                                    price={fmtInt(item.price)}
                                  />{" "}
                                </TierGrid>{" "}
                                <div style={sModNote}>
                                  For localized drywood, wall voids, door/window
                                  frames
                                </div>{" "}
                              </div>
                            );
                          }
                          // Plugging
                          if (item.name === "Plugging") {
                            return (
                              <div key={i} style={{ marginBottom: 24 }}>
                                {" "}
                                <div style={sSectionTitle}>
                                  Plugging
                                  {E.isRecurringCustomer && (
                                    <span style={sDiscBadge}>-15%</span>
                                  )}
                                </div>{" "}
                                <TierGrid>
                                  {" "}
                                  <TierRow
                                    name={item.spacing}
                                    detail={item.detail}
                                    price={fmtInt(item.price)}
                                  />{" "}
                                </TierGrid>
                                {item.warn6 && (
                                  <div style={sModNote}>
                                    Sod may be more cost-effective at 6"
                                  </div>
                                )}
                              </div>
                            );
                          }
                          // Generic one-time
                          const nameMap = {
                            "OT Pest": "One-Time Pest",
                            "OT Mosquito": "One-Time Mosquito",
                            "German Roach": "German Roach Initial",
                            "German Roach Initial": "German Roach Initial",
                            "Native Roach Initial": "Native Roach Initial",
                            "Initial German Roach Knockdown":
                              "Initial German Roach Knockdown",
                            "Initial Native Roach Knockdown":
                              "Initial Native Roach Knockdown",
                          };
                          const displayName = item.lawnType
                            ? `One-Time Lawn (${item.lawnType})`
                            : nameMap[item.name] || item.name;
                          return (
                            <div key={i} style={{ marginBottom: 24 }}>
                              {" "}
                              <div style={sSectionTitle}>
                                {displayName}
                                {E.isRecurringCustomer &&
                                  !item.noRecurringDiscount && (
                                    <span style={sDiscBadge}>-15%</span>
                                  )}
                              </div>{" "}
                              <TierGrid>
                                {" "}
                                <TierRow
                                  name={
                                    item.lawnType ||
                                    (item.service === "one_time_pest" || item.name === "OT Pest"
                                      ? "Full Spray"
                                      : item.name === "OT Mosquito"
                                        ? "Event Spray"
                                        : item.service ===
                                              "pest_initial_roach" ||
                                            item.name === "German Roach" ||
                                            item.name ===
                                              "German Roach Initial" ||
                                            item.name === "Native Roach Initial"
                                          ? "Initial"
                                          : item.name === "Trapping"
                                            ? "Trapping"
                                            : "Standalone")
                                  }
                                  detail={item.detail}
                                  price={fmtInt(item.price)}
                                />{" "}
                              </TierGrid>{" "}
                            </div>
                          );
                        })}
                      </>
                    )}

                    {/* ── Specialty Pest ───────────────────── */}
                    {E.specItems && E.specItems.length > 0 && (
                      <>
                        {" "}
                        <div style={sGroupHeader}>Specialty Pest</div>{" "}
                        <div
                          className="estimate-spec-grid"
                          style={{
                            display: "grid",
                            gridTemplateColumns: "1fr 1fr",
                            gap: 10,
                            marginBottom: 24,
                          }}
                        >
                          {E.specItems.map((s, i) => {
                            const quoteDetail = s.quoteRequired ? quoteRequiredDetailText(s, s.det || "") : "";
                            const detailText = [s.det, quoteDetail].filter(Boolean).join(" · ");
                            return (
                              <div key={i} style={sSpecCard}>
                                {" "}
                                <div style={sSpecName}>{s.name}</div>{" "}
                                <div style={sSpecPrice}>
                                  {s.quoteRequired ? "Quote Required" : s.onProg ? "$0 — Included" : fmtInt(s.price)}
                                </div>{" "}
                                <div style={sSpecDet}>{detailText}</div>{" "}
                              </div>
                            );
                          })}
                        </div>{" "}
                      </>
                    )}
                    {E.pricingMetadata && (
                      (E.pricingMetadata.skippedServices?.length > 0 ||
                        E.pricingMetadata.warnings?.length > 0 ||
                        E.pricingMetadata.manualReviewReasons?.length > 0) && (
                        <div
                          style={{
                            marginBottom: 24,
                            padding: 12,
                            background: C.card,
                            border: `1px solid ${C.border}`,
                            borderRadius: 6,
                            fontSize: 12,
                            color: C.ink,
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: 4 }}>Roach Routing Notes</div>
                          {(E.pricingMetadata.skippedServices || []).map((item, i) => (
                            <div key={`skip-${i}`} style={{ color: C.muted }}>
                              {item.skippedReason === "recurring_pest_initial_roach_already_covers_regular_roach"
                                ? "Skipped standalone native cockroach charge because recurring pest already includes Initial Native Roach Knockdown."
                                : item.skippedReason}
                            </div>
                          ))}
                          {(E.pricingMetadata.warnings || []).map((warning, i) => (
                            <div key={`warning-${i}`} style={{ color: C.muted }}>
                              {warning}
                            </div>
                          ))}
                          {(E.pricingMetadata.manualReviewReasons || []).map((reason, i) => (
                            <div key={`manual-review-${i}`} style={{ color: C.muted }}>
                              {humanizeQuoteReason(reason)}
                            </div>
                          ))}
                        </div>
                      )
                    )}

                    {/* ── WaveGuard + Totals ───────────────── */}
                    {(E.recurring.serviceCount > 0 ||
                      E.oneTime.total > 0 ||
                      E.recurring.rodentBaitMo > 0 ||
                      E.recurring.palmInjectionMo > 0) && (
                      <>
                        {" "}
                        <div
                          style={{
                            height: 1,
                            background: C.border,
                            margin: "18px 0",
                          }}
                        />
                        {/* WaveGuard card */}
                        {E.recurring.serviceCount > 0 && (
                          <div
                            style={{
                              background:
                                "linear-gradient(135deg, rgba(14,165,233,0.12), rgba(37,99,235,0.12))",
                              border: "2px solid rgba(14,165,233,0.35)",
                              borderRadius: C.radius,
                              padding: "20px 24px",
                              marginBottom: 24,
                            }}
                          >
                            {" "}
                            <div
                              style={{
                                fontSize: 24,
                                fontWeight: 700,
                                color: C.teal,
                              }}
                            >
                              WaveGuard {E.recurring.waveGuardTier}
                            </div>{" "}
                            <div
                              style={{
                                fontSize: 15,
                                color: C.gray,
                                marginTop: 4,
                              }}
                            >
                              {E.recurring.serviceCount} recurring service
                              {E.recurring.serviceCount > 1 ? "s" : ""} —{" "}
                              {Math.round(E.recurring.discount * 100)}% bundle
                              discount
                            </div>
                            {E.recurring.savings > 0 && (
                              <div
                                style={{
                                  color: C.green,
                                  fontSize: 18,
                                  fontWeight: 700,
                                  marginTop: 4,
                                }}
                              >
                                Bundling saves {fmt(E.recurring.savings)}/year
                              </div>
                            )}
                            {/* Breakdown */}
                            <div
                              style={{
                                display: "grid",
                                gridTemplateColumns: "1fr auto",
                                gap: "4px 16px",
                                fontSize: 14,
                                marginTop: 10,
                                padding: "12px 16px",
                                background: "rgba(14,165,233,0.06)",
                                borderRadius: 8,
                              }}
                            >
                              {E.recurring.services.map((s, i) => (
                                <React.Fragment key={i}>
                                  {" "}
                                  <div style={{ color: C.gray }}>
                                    {s.name}
                                  </div>{" "}
                                  <div
                                    style={{
                                      fontFamily: "'JetBrains Mono', monospace",
                                      color: C.heading,
                                      textAlign: "right",
                                    }}
                                  >
                                    {fmt(s.mo)}/mo
                                  </div>{" "}
                                </React.Fragment>
                              ))}
                              <div
                                style={{
                                  fontWeight: 700,
                                  color: C.heading,
                                  borderTop: `1px solid ${C.border}`,
                                  paddingTop: 6,
                                  marginTop: 4,
                                }}
                              >
                                Total before discount
                              </div>{" "}
                              <div
                                style={{
                                  fontFamily: "'JetBrains Mono', monospace",
                                  fontWeight: 700,
                                  borderTop: `1px solid ${C.border}`,
                                  paddingTop: 6,
                                  marginTop: 4,
                                  textAlign: "right",
                                  color: C.heading,
                                }}
                              >
                                {fmt(
                                  Math.round(
                                    (E.recurring.annualBeforeDiscount / 12) *
                                      100,
                                  ) / 100,
                                )}
                                /mo
                              </div>
                              {E.recurring.discount > 0 && (
                                <>
                                  {" "}
                                  <div style={{ color: C.green }}>
                                    {E.recurring.waveGuardTier} discount (-
                                    {Math.round(E.recurring.discount * 100)}%)
                                  </div>{" "}
                                  <div
                                    style={{
                                      fontFamily: "'JetBrains Mono', monospace",
                                      color: C.green,
                                      textAlign: "right",
                                    }}
                                  >
                                    -
                                    {fmt(
                                      Math.round(
                                        (E.recurring.savings / 12) * 100,
                                      ) / 100,
                                    )}
                                    /mo
                                  </div>{" "}
                                </>
                              )}
                              <div style={{ fontWeight: 700, color: C.teal }}>
                                Your monthly rate
                              </div>{" "}
                              <div
                                style={{
                                  fontFamily: "'JetBrains Mono', monospace",
                                  fontWeight: 700,
                                  color: C.teal,
                                  textAlign: "right",
                                }}
                              >
                                {fmt(E.recurring.monthlyTotal)}/mo
                              </div>{" "}
                            </div>{" "}
                          </div>
                        )}
                        {/* Totals */}
                        <div
                          style={{
                            background:
                              "linear-gradient(135deg, rgba(16,185,129,0.08), rgba(14,165,233,0.08))",
                            border: "2px solid rgba(16,185,129,0.3)",
                            borderRadius: C.radius,
                            padding: 24,
                          }}
                        >
                          {E.recurring.serviceCount > 0 && (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                padding: "8px 0",
                                fontSize: 16,
                              }}
                            >
                              {" "}
                              <span>Recurring (after WaveGuard)</span>{" "}
                              <span
                                style={{
                                  fontFamily: "'JetBrains Mono', monospace",
                                  fontWeight: 600,
                                  color: C.green,
                                }}
                              >
                                {fmt(E.recurring.annualAfterDiscount)}/yr (
                                {fmt(E.recurring.monthlyTotal)}/mo)
                              </span>{" "}
                            </div>
                          )}
                          {E.recurring.rodentBaitMo > 0 && (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                padding: "8px 0",
                                fontSize: 16,
                              }}
                            >
                              {" "}
                              <span>Rodent bait (separate)</span>{" "}
                              <span
                                style={{
                                  fontFamily: "'JetBrains Mono', monospace",
                                  fontWeight: 600,
                                  color: C.green,
                                }}
                              >
                                {fmtInt(E.recurring.rodentBaitMo * 12)}/yr ($
                                {E.recurring.rodentBaitMo}/mo)
                              </span>{" "}
                            </div>
                          )}
                          {E.recurring.palmInjectionMo > 0 && (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                padding: "8px 0",
                                fontSize: 16,
                              }}
                            >
                              {" "}
                              <span>Palm injection (separate)</span>{" "}
                              <span
                                style={{
                                  fontFamily: "'JetBrains Mono', monospace",
                                  fontWeight: 600,
                                  color: C.green,
                                }}
                              >
                                {fmtInt(
                                  E.recurring.palmInjectionAnn ||
                                    E.recurring.palmInjectionMo * 12,
                                )}
                                /yr ({fmt(E.recurring.palmInjectionMo)}/mo)
                              </span>{" "}
                            </div>
                          )}
                          {E.manualDiscount && E.manualDiscount.amount > 0 && (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                padding: "8px 0",
                                fontSize: 16,
                              }}
                            >
                              {" "}
                              <span style={{ color: C.green }}>
                                {E.manualDiscount.label ||
                                  (E.manualDiscount.type === "PERCENT"
                                    ? `Discount (${E.manualDiscount.value}%)`
                                    : `Discount`)}
                              </span>{" "}
                              <span
                                style={{
                                  fontFamily: "'JetBrains Mono', monospace",
                                  fontWeight: 600,
                                  color: C.green,
                                }}
                              >
                                -{fmt(E.manualDiscount.amount)}/yr
                              </span>{" "}
                            </div>
                          )}
                          {E.oneTime.tmInstall > 0 && (
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                alignItems: "center",
                                padding: "8px 0",
                                fontSize: 16,
                              }}
                            >
                              {" "}
                              <span>
                                {`Termite bait install (${termiteBaitSystemLabel(
                                  R.tmBait?.selectedSystem ||
                                    R.tmBait?.system ||
                                    form.termiteBaitSystem,
                                )})`}
                              </span>{" "}
                              <span
                                style={{
                                  fontFamily: "'JetBrains Mono', monospace",
                                  fontWeight: 600,
                                  color: C.green,
                                }}
                              >
                                {fmtInt(E.oneTime.tmInstall)}
                              </span>{" "}
                            </div>
                          )}
                          {E.oneTime.otSubtotal > 0 && (
                            <>
                              {" "}
                              <div
                                style={{
                                  display: "flex",
                                  justifyContent: "space-between",
                                  alignItems: "center",
                                  padding: "8px 0",
                                  fontSize: 16,
                                  borderTop: `1px solid ${C.border}`,
                                  marginTop: 6,
                                  paddingTop: 10,
                                }}
                              >
                                {" "}
                                <span style={{ fontWeight: 700 }}>
                                  One-Time Services
                                </span>{" "}
                                <span
                                  style={{
                                    fontFamily: "'JetBrains Mono', monospace",
                                    fontWeight: 600,
                                    color: C.green,
                                  }}
                                >
                                  {fmtInt(E.oneTime.otSubtotal)}
                                </span>{" "}
                              </div>
                              {E.oneTime.items.map((item, i) => (
                                <div
                                  key={i}
                                  style={{
                                    display: "flex",
                                    justifyContent: "space-between",
                                    alignItems: "center",
                                    padding: "3px 0 3px 16px",
                                    fontSize: 14,
                                    color: C.gray,
                                  }}
                                >
                                  {" "}
                                  <span>
                                    {item.name}
                                    {item.waivedWithPrepay ? (
                                      <span
                                        style={{
                                          fontSize: 11,
                                          color: C.green,
                                          marginLeft: 6,
                                        }}
                                      >
                                        waived with annual prepay
                                      </span>
                                    ) : (
                                      ""
                                    )}
                                  </span>{" "}
                                  <span
                                    style={{
                                      fontFamily: "'JetBrains Mono', monospace",
                                      fontSize: 14,
                                      color: C.green,
                                    }}
                                  >
                                    {fmtInt(item.price)}
                                  </span>{" "}
                                </div>
                              ))}
                              {E.oneTime.specItems.map((s, i) => {
                                const quoteDetail = s.quoteRequired ? quoteRequiredDetailText(s, s.det || s.detail || "") : "";
                                return (
                                  <div
                                    key={`sp-${i}`}
                                    style={{
                                      display: "flex",
                                      justifyContent: "space-between",
                                      alignItems: "flex-start",
                                      gap: 12,
                                      padding: "3px 0 3px 16px",
                                      fontSize: 14,
                                      color: C.gray,
                                    }}
                                  >
                                    {" "}
                                    <span>
                                      {s.name}
                                      {quoteDetail ? (
                                        <span style={{ display: "block", fontSize: 11, color: C.gray, lineHeight: 1.25 }}>
                                          {quoteDetail}
                                        </span>
                                      ) : null}
                                    </span>{" "}
                                    <span
                                      style={{
                                        fontFamily: "'JetBrains Mono', monospace",
                                        fontSize: 14,
                                        color: C.green,
                                      }}
                                    >
                                      {s.quoteRequired ? "Quote Required" : fmtInt(s.price)}
                                    </span>{" "}
                                  </div>
                                );
                              })}
                            </>
                          )}
                          {/* Big totals */}
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              padding: "14px 0",
                              fontSize: 22,
                              fontWeight: 700,
                              borderTop: `2px solid ${C.border}`,
                              marginTop: 10,
                            }}
                          >
                            {" "}
                            <span>Year 1 Total</span>{" "}
                            <span
                              style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontWeight: 600,
                                color: C.green,
                              }}
                            >
                              {fmt(E.totals.year1)}
                            </span>{" "}
                          </div>{" "}
                          <div
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              alignItems: "center",
                              padding: "8px 0",
                              fontSize: 16,
                            }}
                          >
                            {" "}
                            <span>Year 2+ Annual</span>{" "}
                            <span
                              style={{
                                fontFamily: "'JetBrains Mono', monospace",
                                fontWeight: 600,
                                color: C.green,
                              }}
                            >
                              {fmt(E.totals.year2)}/yr ({fmt(E.totals.year2mo)}
                              /mo)
                            </span>{" "}
                          </div>{" "}
                        </div>{" "}
                      </>
                    )}
                  </div>{" "}
                </div>{" "}
              </EstimateErrorBoundary>
            )}
          </div>{" "}
        </div>{" "}
      </div>{" "}
    </FormCtx.Provider>
  );
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
const DECLINE_REASONS = [
  "Too expensive",
  "Went with competitor",
  "Not ready",
  "Service not needed",
  "No response",
];

/* ── Follow-Up Modal ──────────────────────────────────────── */
function FollowUpModal({ estimate, onClose, onSent }) {
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

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
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
            fontWeight: 600,
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
              fontWeight: 600,
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
    </div>
  );
}

/* ── Decline Reason Modal ─────────────────────────────────── */
function DeclineModal({ estimate, onClose, onSaved }) {
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    if (!reason) return;
    setSaving(true);
    try {
      await adminFetch(`/admin/estimates/${estimate.id}`, {
        method: "PATCH",
        body: JSON.stringify({ status: "declined", declineReason: reason }),
      });
      onSaved();
    } catch (err) {
      alert("Failed: " + err.message);
    }
    setSaving(false);
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 9999,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 16,
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
            fontWeight: 600,
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
            <label
              key={r}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 10,
                cursor: "pointer",
                fontSize: 14,
                color: reason === r ? C.heading : C.gray,
                padding: "8px 12px",
                borderRadius: 8,
                background: reason === r ? `${C.red}18` : "transparent",
                border: `1px solid ${reason === r ? C.red : C.border}`,
                transition: "all 0.15s",
              }}
            >
              {" "}
              <input
                type="radio"
                name="declineReason"
                checked={reason === r}
                onChange={() => setReason(r)}
                style={{ accentColor: C.red, width: 16, height: 16 }}
              />
              {r}
            </label>
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
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Cancel
          </button>{" "}
          <button
            onClick={handleSave}
            disabled={saving || !reason}
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
    </div>
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

function EstimatePipelineView() {
  const [estimates, setEstimates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("all");
  const [followUpTarget, setFollowUpTarget] = useState(null);
  const [declineTarget, setDeclineTarget] = useState(null);

  const refreshEstimates = useCallback(() => {
    adminFetch("/admin/estimates")
      .then((d) => {
        setEstimates(d.estimates || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    refreshEstimates();
  }, [refreshEstimates]);

  const togglePriority = useCallback(async (e) => {
    const newVal = !e.isPriority;
    try {
      await adminFetch(`/admin/estimates/${e.id}`, {
        method: "PATCH",
        body: JSON.stringify({ isPriority: newVal }),
      });
      setEstimates((prev) =>
        prev.map((est) =>
          est.id === e.id ? { ...est, isPriority: newVal } : est,
        ),
      );
    } catch (err) {
      alert("Failed to update priority");
    }
  }, []);

  if (loading)
    return (
      <div style={{ padding: 40, textAlign: "center", color: C.gray }}>
        Loading estimates...
      </div>
    );

  // Classify each estimate
  const classified = estimates.map((e) => ({
    ...e,
    _class: classifyEstimate(e),
  }));

  // Sort: priority first, then by created date desc
  const sorted = [...classified].sort((a, b) => {
    if (a.isPriority && !b.isPriority) return -1;
    if (!a.isPriority && b.isPriority) return 1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });

  // Stats
  const total = estimates.length;
  const accepted = estimates.filter((e) => e.status === "accepted").length;
  const sent = estimates.filter((e) =>
    ["sent", "viewed"].includes(e.status),
  ).length;
  const declined = estimates.filter(
    (e) => e.status === "declined" || e.status === "expired",
  ).length;
  const totalMRRWon = estimates
    .filter((e) => e.status === "accepted")
    .reduce((s, e) => s + (e.monthlyTotal || 0), 0);
  const pipelineValue = estimates
    .filter((e) => !["accepted", "declined", "expired"].includes(e.status))
    .reduce((s, e) => s + (e.monthlyTotal || 0), 0);
  const conversionRate =
    sent + accepted + declined > 0
      ? Math.round((accepted / (sent + accepted + declined)) * 100)
      : 0;
  const avgEstimateValue =
    total > 0
      ? Math.round(
          estimates.reduce((s, e) => s + (e.monthlyTotal || 0), 0) / total,
        )
      : 0;

  // Follow-up overdue: viewed >48h or sent >72h without action
  const HOUR = 3600000;
  const now = Date.now();
  const followUpOverdue = estimates.filter((e) => {
    if (
      e.status === "sent" &&
      !e.viewedAt &&
      e.sentAt &&
      now - new Date(e.sentAt).getTime() > 72 * HOUR
    )
      return true;
    if (
      e.status === "viewed" &&
      e.viewedAt &&
      now - new Date(e.viewedAt).getTime() > 48 * HOUR
    )
      return true;
    return false;
  }).length;

  // Filter counts
  const filterCounts = {};
  for (const f of PIPELINE_FILTERS) {
    filterCounts[f.key] =
      f.key === "all"
        ? total
        : classified.filter((e) => e._class === f.key).length;
  }

  const filtered =
    filter === "all" ? sorted : sorted.filter((e) => e._class === filter);

  const fmtDate = (d) => {
    if (!d) return "—";
    return new Date(d).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  };

  const timeAgo = (d) => {
    if (!d) return "";
    const mins = Math.floor((Date.now() - new Date(d)) / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  return (
    <div>
      {/* Follow-Up Modal */}
      {followUpTarget && (
        <FollowUpModal
          estimate={followUpTarget}
          onClose={() => setFollowUpTarget(null)}
          onSent={() => {
            setFollowUpTarget(null);
            refreshEstimates();
          }}
        />
      )}
      {/* Decline Modal */}
      {declineTarget && (
        <DeclineModal
          estimate={declineTarget}
          onClose={() => setDeclineTarget(null)}
          onSaved={() => {
            setDeclineTarget(null);
            refreshEstimates();
          }}
        />
      )}

      {/* Enhanced Stats Bar */}
      <div
        style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}
      >
        {[
          {
            label: "Pipeline Value",
            value: `$${Math.round(pipelineValue)}`,
            sub: "/mo potential",
            color: C.teal,
          },
          {
            label: "MRR Won",
            value: `$${Math.round(totalMRRWon)}`,
            sub: "/mo closed",
            color: C.green,
          },
          {
            label: "Conversion",
            value: `${conversionRate}%`,
            sub: `${accepted} of ${sent + accepted + declined}`,
            color:
              conversionRate >= 50
                ? C.green
                : conversionRate >= 25
                  ? C.amber
                  : C.red,
          },
          {
            label: "Avg Estimate",
            value: `$${avgEstimateValue}`,
            sub: "/mo",
            color: C.heading,
          },
          {
            label: "Follow-Up Overdue",
            value: followUpOverdue,
            sub: followUpOverdue > 0 ? "need attention" : "all clear",
            color: followUpOverdue > 0 ? C.red : C.green,
          },
          {
            label: "Total",
            value: total,
            sub: `${accepted} won · ${declined} lost`,
            color: C.heading,
          },
        ].map((s, i) => (
          <div
            key={i}
            style={{
              flex: "1 1 140px",
              background: C.card,
              borderRadius: 10,
              padding: "14px 16px",
              border: `1px solid ${C.border}`,
              textAlign: "center",
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 10,
                color: C.gray,
                textTransform: "uppercase",
                letterSpacing: 1,
                marginBottom: 4,
              }}
            >
              {s.label}
            </div>{" "}
            <div
              style={{
                fontSize: 22,
                fontWeight: 700,
                color: s.color,
                fontFamily: "'JetBrains Mono', monospace",
              }}
            >
              {s.value}
            </div>
            {s.sub && (
              <div style={{ fontSize: 10, color: C.gray, marginTop: 2 }}>
                {s.sub}
              </div>
            )}
          </div>
        ))}
      </div>
      {/* Action-Oriented Filter Tabs */}
      <div
        style={{ display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" }}
      >
        {PIPELINE_FILTERS.map((f) => {
          const count = filterCounts[f.key];
          const isActive = filter === f.key;
          return (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                padding: "7px 14px",
                borderRadius: 8,
                cursor: "pointer",
                background: isActive ? f.color : C.card,
                color: isActive ? "#fff" : f.color,
                fontSize: 12,
                fontWeight: 600,
                transition: "all 0.15s",
                border: `1px solid ${isActive ? f.color : C.border}`,
              }}
            >
              {f.label} ({count})
            </button>
          );
        })}
      </div>
      {/* Estimates List */}
      {filtered.length === 0 ? (
        <div style={{ padding: 40, textAlign: "center", color: C.gray }}>
          No estimates{" "}
          {filter !== "all"
            ? `in "${PIPELINE_FILTERS.find((f) => f.key === filter)?.label}"`
            : "yet"}
          . Create one using the Create Estimate button.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {filtered.map((e) => {
            const sc = STATUS_CONFIG[e.status] || STATUS_CONFIG.draft;
            const urgency = getUrgencyIndicator(e);
            const competitor = detectCompetitor(e.notes || e.description);

            return (
              <div
                key={e.id}
                style={{
                  background: C.card,
                  borderRadius: 10,
                  padding: "16px 20px",
                  border: e.isPriority
                    ? `2px solid ${C.red}`
                    : `1px solid ${C.border}`,
                  display: "flex",
                  alignItems: "center",
                  gap: 14,
                  flexWrap: "wrap",
                  position: "relative",
                }}
              >
                {/* Priority flag indicator */}
                {e.isPriority && (
                  <div
                    style={{
                      position: "absolute",
                      top: -1,
                      right: 16,
                      background: C.red,
                      color: "#fff",
                      fontSize: 9,
                      fontWeight: 700,
                      padding: "2px 8px",
                      borderRadius: "0 0 6px 6px",
                      textTransform: "uppercase",
                      letterSpacing: 0.5,
                    }}
                  >
                    Urgent
                  </div>
                )}
                {/* Status badge */}
                <span
                  style={{
                    padding: "4px 10px",
                    borderRadius: 8,
                    fontSize: 10,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                    background: sc.bg,
                    color: sc.color,
                    minWidth: 70,
                    textAlign: "center",
                    flexShrink: 0,
                  }}
                >
                  {sc.label}
                </span>
                {/* Customer info */}
                <div style={{ flex: 1, minWidth: 150 }}>
                  {" "}
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      flexWrap: "wrap",
                    }}
                  >
                    {" "}
                    <span
                      style={{
                        fontSize: 14,
                        fontWeight: 600,
                        color: C.heading,
                      }}
                    >
                      {e.customerName || "Unknown"}
                    </span>
                    {e.source === "lead_webhook" && (
                      <span
                        title="Website lead"
                        style={{ fontSize: 14 }}
                      ></span>
                    )}
                    {e.source === "referral" && (
                      <span title="Referral" style={{ fontSize: 14 }}></span>
                    )}
                    {e.source === "ai_agent" && (
                      <span
                        title="AI agent draft — review before sending"
                        style={{ fontSize: 14 }}
                      >
                        {"AI"}
                      </span>
                    )}
                    {/* Urgency indicator */}
                    {urgency && (
                      <span
                        style={{
                          fontSize: 9,
                          padding: "2px 7px",
                          borderRadius: 4,
                          background: urgency.bg,
                          color: urgency.color,
                          fontWeight: 700,
                          textTransform: "uppercase",
                          letterSpacing: 0.3,
                        }}
                      >
                        {urgency.label}
                      </span>
                    )}
                    {/* Competitor intel badge */}
                    {competitor && (
                      <span
                        title={`Switching from ${competitor}`}
                        style={{
                          fontSize: 9,
                          padding: "2px 7px",
                          borderRadius: 4,
                          background: `${C.blue}22`,
                          color: C.blue,
                          fontWeight: 600,
                        }}
                      >
                        Switching from: {competitor}
                      </span>
                    )}
                    {/* Decline reason badge */}
                    {e.declineReason && (
                      <span
                        style={{
                          fontSize: 9,
                          padding: "2px 7px",
                          borderRadius: 4,
                          background: `${C.red}15`,
                          color: C.red,
                          fontWeight: 600,
                        }}
                      >
                        {e.declineReason}
                      </span>
                    )}
                  </div>{" "}
                  <div
                    style={{
                      fontSize: 12,
                      color: C.gray,
                      marginTop: 2,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {e.address || "—"}
                    {e.serviceInterest ? ` · ${e.serviceInterest}` : ""}
                  </div>{" "}
                </div>
                {/* Tier */}
                {e.tier && (
                  <span
                    style={{
                      padding: "3px 8px",
                      borderRadius: 6,
                      fontSize: 10,
                      fontWeight: 700,
                      flexShrink: 0,
                      background:
                        e.tier === "Gold"
                          ? `${C.amber}22`
                          : e.tier === "Platinum"
                            ? `${C.heading}15`
                            : `${C.teal}22`,
                      color:
                        e.tier === "Gold"
                          ? C.amber
                          : e.tier === "Platinum"
                            ? C.heading
                            : C.teal,
                    }}
                  >
                    {e.tier}
                  </span>
                )}
                {/* Monthly */}
                <div
                  style={{ textAlign: "right", minWidth: 80, flexShrink: 0 }}
                >
                  {" "}
                  <div
                    style={{
                      fontSize: 16,
                      fontWeight: 700,
                      color: e.monthlyTotal > 0 ? C.green : C.gray,
                      fontFamily: "'JetBrains Mono', monospace",
                    }}
                  >
                    ${e.monthlyTotal?.toFixed(0) || "0"}
                    <span style={{ fontSize: 11, fontWeight: 400 }}>
                      /mo
                    </span>{" "}
                  </div>{" "}
                </div>
                {/* Timeline */}
                <div
                  style={{ textAlign: "right", minWidth: 100, flexShrink: 0 }}
                >
                  {" "}
                  <div style={{ fontSize: 11, color: C.gray }}>
                    Created {fmtDate(e.createdAt)}
                  </div>
                  {e.sentAt && (
                    <div style={{ fontSize: 10, color: C.teal }}>
                      Sent {timeAgo(e.sentAt)}
                    </div>
                  )}
                  {e.viewedAt && (
                    <div style={{ fontSize: 10, color: C.amber }}>
                      Viewed {timeAgo(e.viewedAt)}
                      {e.viewCount > 1 && ` · ${e.viewCount}×`}
                    </div>
                  )}
                  {e.lastViewedAt && e.viewCount > 1 && (
                    <div style={{ fontSize: 10, color: C.amber }}>
                      Last viewed {timeAgo(e.lastViewedAt)}
                    </div>
                  )}
                  {e.clickCount > 0 && (
                    <div style={{ fontSize: 10, color: C.teal }}>
                      Clicked {timeAgo(e.lastClickedAt)}
                      {e.clickCount > 1 && ` · ${e.clickCount}×`}
                    </div>
                  )}
                  {e.acceptedAt && (
                    <div style={{ fontSize: 10, color: C.green }}>
                      Accepted {timeAgo(e.acceptedAt)}
                    </div>
                  )}
                  {e.declinedAt && (
                    <div style={{ fontSize: 10, color: C.red }}>
                      Declined {timeAgo(e.declinedAt)}
                    </div>
                  )}
                  {e.followUpCount > 0 && (
                    <div style={{ fontSize: 10, color: C.gray }}>
                      Follow-ups: {e.followUpCount}
                    </div>
                  )}
                </div>
                {/* Actions */}
                <div
                  style={{
                    display: "flex",
                    gap: 6,
                    flexShrink: 0,
                    flexWrap: "wrap",
                  }}
                >
                  {/* Priority toggle */}
                  <button
                    onClick={() => togglePriority(e)}
                    title={e.isPriority ? "Remove priority" : "Flag as urgent"}
                    aria-label={
                      e.isPriority ? "Remove priority" : "Flag as urgent"
                    }
                    style={{
                      padding: "6px 8px",
                      borderRadius: 6,
                      border: `1px solid ${e.isPriority ? C.red : C.border}`,
                      cursor: "pointer",
                      background: e.isPriority ? `${C.red}22` : "transparent",
                      color: e.isPriority ? C.red : C.gray,
                      fontSize: 11,
                      fontWeight: 600,
                      lineHeight: 1,
                    }}
                  >
                    {e.isPriority ? "Urgent" : "Flag"}
                  </button>
                  {/* Send button for drafts with pricing */}
                  {e.status === "draft" && e.monthlyTotal > 0 && (
                    <button
                      onClick={async () => {
                        await adminFetch(`/admin/estimates/${e.id}/send`, {
                          method: "POST",
                          body: JSON.stringify({
                            idempotencyKey:
                              globalThis.crypto?.randomUUID?.() ||
                              `estimate-send-${Date.now()}-${Math.random()}`,
                          }),
                        }).catch(() => {});
                        refreshEstimates();
                      }}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 6,
                        border: "none",
                        cursor: "pointer",
                        background: C.teal,
                        color: "#fff",
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      Send
                    </button>
                  )}

                  {/* Follow-up button for sent/viewed — opens modal with pre-filled SMS */}
                  {(e.status === "sent" || e.status === "viewed") && (
                    <button
                      onClick={() => setFollowUpTarget(e)}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 6,
                        border: "none",
                        cursor: "pointer",
                        background: urgency
                          ? `${urgency.color}22`
                          : `${C.amber}22`,
                        color: urgency ? urgency.color : C.amber,
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      Follow Up
                    </button>
                  )}

                  {/* Resend — re-fires SMS + email via the original send endpoint */}
                  {(e.status === "sent" || e.status === "viewed") && (
                    <button
                      onClick={async () => {
                        if (
                          !confirm(
                            `Resend estimate to ${e.customerName || "customer"} via SMS + email?`,
                          )
                        )
                          return;
                        await adminFetch(`/admin/estimates/${e.id}/send`, {
                          method: "POST",
                          body: JSON.stringify({
                            sendMethod: "both",
                            idempotencyKey:
                              globalThis.crypto?.randomUUID?.() ||
                              `estimate-send-${Date.now()}-${Math.random()}`,
                          }),
                        }).catch(() => {});
                        refreshEstimates();
                      }}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 6,
                        border: `1px solid ${C.teal}`,
                        cursor: "pointer",
                        background: "transparent",
                        color: C.teal,
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      Resend
                    </button>
                  )}

                  {/* Mark as Lost button for sent/viewed */}
                  {(e.status === "sent" || e.status === "viewed") && (
                    <button
                      onClick={() => setDeclineTarget(e)}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 6,
                        border: `1px solid ${C.border}`,
                        cursor: "pointer",
                        background: "transparent",
                        color: C.red,
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      Mark Lost
                    </button>
                  )}

                  {/* Copy link for sent/viewed */}
                  {(e.status === "sent" || e.status === "viewed") && (
                    <button
                      onClick={() => {
                        const link = `${window.location.origin}/estimate/${e.token || e.id}`;
                        navigator.clipboard?.writeText(link);
                      }}
                      style={{
                        padding: "6px 12px",
                        borderRadius: 6,
                        border: `1px solid ${C.border}`,
                        cursor: "pointer",
                        background: "transparent",
                        color: C.gray,
                        fontSize: 11,
                        fontWeight: 600,
                      }}
                    >
                      Copy Link
                    </button>
                  )}
                </div>{" "}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// =========================================================================
// =========================================================================
// WEBSITE QUOTES VIEW — leads from website forms, voice agent, referrals
// =========================================================================
function WebsiteQuotesView() {
  const [leads, setLeads] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    adminFetch("/admin/estimates?source=website,lead_webhook,referral")
      .then((d) => {
        setLeads(d.estimates || []);
        setLoading(false);
      })
      .catch(() => {
        // Fallback — get all estimates and filter client-side
        adminFetch("/admin/estimates")
          .then((d) => {
            const webLeads = (d.estimates || []).filter(
              (e) =>
                ["new", "draft"].includes(e.status) ||
                e.source === "lead_webhook",
            );
            setLeads(webLeads.length > 0 ? webLeads : d.estimates || []);
            setLoading(false);
          })
          .catch(() => setLoading(false));
      });
  }, []);

  if (loading)
    return (
      <div style={{ padding: 40, textAlign: "center", color: C.gray }}>
        Loading quotes...
      </div>
    );

  const newLeads = leads.filter(
    (e) => e.status === "new" || e.status === "draft",
  );
  const inProgress = leads.filter(
    (e) => e.status === "sent" || e.status === "viewed",
  );
  const resolved = leads.filter((e) =>
    ["accepted", "declined", "expired"].includes(e.status),
  );

  const fmtDate = (d) =>
    d
      ? new Date(d).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        })
      : "—";

  const sourceIcon = (src) => {
    const icons = {
      lead_webhook: "",
      website: "",
      referral: "",
      manual: "Edit",
      ai_agent: "AI",
    };
    return icons[src] || "";
  };

  const LeadCard = ({ e }) => {
    const sc = STATUS_CONFIG[e.status] || STATUS_CONFIG.draft;
    return (
      <div
        style={{
          background: C.card,
          borderRadius: 10,
          padding: "14px 18px",
          border: `1px solid ${C.border}`,
          marginBottom: 8,
          borderLeft: `3px solid ${e.status === "new" ? C.amber : sc.color}`,
        }}
      >
        {" "}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "flex-start",
            gap: 12,
          }}
        >
          {" "}
          <div style={{ flex: 1 }}>
            {" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                marginBottom: 4,
              }}
            >
              {" "}
              <span style={{ fontSize: 14, fontWeight: 600, color: C.heading }}>
                {e.customerName || "Unknown"}
              </span>{" "}
              <span style={{ fontSize: 16 }}>{sourceIcon(e.source)}</span>{" "}
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 6,
                  fontSize: 10,
                  fontWeight: 700,
                  background: sc.bg,
                  color: sc.color,
                  textTransform: "uppercase",
                }}
              >
                {sc.label}
              </span>
              {e.isPriority && (
                <span
                  style={{
                    fontSize: 10,
                    padding: "2px 6px",
                    borderRadius: 4,
                    background: C.red + "22",
                    color: C.red,
                    fontWeight: 700,
                  }}
                >
                  PRIORITY
                </span>
              )}
            </div>{" "}
            <div style={{ fontSize: 12, color: C.gray }}>
              {e.address || "—"}
            </div>
            {e.serviceType && (
              <div style={{ fontSize: 11, color: C.teal, marginTop: 2 }}>
                {e.serviceType?.replace(/_/g, " ")}
              </div>
            )}
            {e.description && (
              <div
                style={{
                  fontSize: 11,
                  color: C.gray,
                  marginTop: 2,
                  fontStyle: "italic",
                }}
              >
                "{(e.description || "").substring(0, 80)}"
              </div>
            )}
          </div>{" "}
          <div style={{ textAlign: "right" }}>
            {e.monthlyTotal > 0 && (
              <div
                style={{
                  fontSize: 16,
                  fontWeight: 700,
                  color: C.green,
                  fontFamily: "'JetBrains Mono', monospace",
                }}
              >
                ${e.monthlyTotal?.toFixed(0)}/mo
              </div>
            )}
            <div style={{ fontSize: 10, color: C.gray, marginTop: 2 }}>
              {fmtDate(e.createdAt)}
            </div>
            {e.source && (
              <div style={{ fontSize: 10, color: C.gray }}>
                {e.source?.replace(/_/g, " ")}
              </div>
            )}
          </div>{" "}
        </div>{" "}
      </div>
    );
  };

  return (
    <div>
      {/* Summary */}
      <div
        style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}
      >
        {" "}
        <div
          style={{
            flex: "1 1 120px",
            background: C.card,
            borderRadius: 10,
            padding: "14px 16px",
            border: `1px solid ${C.border}`,
            textAlign: "center",
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 10,
              color: C.gray,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 4,
            }}
          >
            New Leads
          </div>{" "}
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: C.amber,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {newLeads.length}
          </div>{" "}
        </div>{" "}
        <div
          style={{
            flex: "1 1 120px",
            background: C.card,
            borderRadius: 10,
            padding: "14px 16px",
            border: `1px solid ${C.border}`,
            textAlign: "center",
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 10,
              color: C.gray,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 4,
            }}
          >
            In Progress
          </div>{" "}
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: C.teal,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {inProgress.length}
          </div>{" "}
        </div>{" "}
        <div
          style={{
            flex: "1 1 120px",
            background: C.card,
            borderRadius: 10,
            padding: "14px 16px",
            border: `1px solid ${C.border}`,
            textAlign: "center",
          }}
        >
          {" "}
          <div
            style={{
              fontSize: 10,
              color: C.gray,
              textTransform: "uppercase",
              letterSpacing: 1,
              marginBottom: 4,
            }}
          >
            Resolved
          </div>{" "}
          <div
            style={{
              fontSize: 22,
              fontWeight: 700,
              color: C.green,
              fontFamily: "'JetBrains Mono', monospace",
            }}
          >
            {resolved.length}
          </div>{" "}
        </div>{" "}
      </div>
      {/* New leads section */}
      {newLeads.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: C.amber,
              marginBottom: 8,
            }}
          >
            New — Needs Estimate ({newLeads.length})
          </div>
          {newLeads.map((e) => (
            <LeadCard key={e.id} e={e} />
          ))}
        </div>
      )}

      {/* In progress */}
      {inProgress.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: C.teal,
              marginBottom: 8,
            }}
          >
            Sent / Viewed ({inProgress.length})
          </div>
          {inProgress.map((e) => (
            <LeadCard key={e.id} e={e} />
          ))}
        </div>
      )}

      {/* Resolved */}
      {resolved.length > 0 && (
        <div>
          {" "}
          <div
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: C.gray,
              marginBottom: 8,
            }}
          >
            Resolved ({resolved.length})
          </div>
          {resolved.map((e) => (
            <LeadCard key={e.id} e={e} />
          ))}
        </div>
      )}

      {leads.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: C.gray }}>
          No website quotes yet. Leads from your website forms, voice agent, and
          referrals will appear here.
        </div>
      )}
    </div>
  );
}

export {
  STATUS_CONFIG,
  PIPELINE_FILTERS,
  DECLINE_REASONS,
  classifyEstimate,
  getUrgencyIndicator,
  detectCompetitor,
  EstimateToolView,
  FollowUpModal,
  DeclineModal,
};
