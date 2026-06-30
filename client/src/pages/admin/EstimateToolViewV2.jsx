// client/src/pages/admin/EstimateToolViewV2.jsx
// Monochrome V2 of EstimateToolView. Strict 1:1 on state, refs, effects,
// callbacks, and API calls — all copied verbatim from V1. Only the render
// chrome is reskinned (panels ->Card, tier rows ->zinc, color accents
// collapsed to zinc ramp + alert-fg reserved for real alerts).
//
// Endpoints preserved:
//   POST /admin/estimator/property-lookup
//   POST /admin/lookup/satellite-ai
//   POST /admin/estimator/calculate-estimate
//   POST /admin/estimates           (save)
//   POST /admin/estimates/:id/send  (+ scheduledAt)
//   GET  /admin/customers?search=   (lookup + send-form lookup)
//   GET  /admin/discounts           (manual-discount presets)
//
// Monochrome rules applied:
// - All panels = Card
// - All primary buttons = Button variant="primary" (zinc-900)
// - Supporting buttons = secondary (white + hairline) or ghost
// - Status lines: "ok" =>zinc, "err" =>alert-fg, "loading" =>zinc
// - Field-verify banners and critical confidence flags use alert-fg
// - Tier rows: selected = zinc-900 ring, recommended = zinc-900 dot,
//   dimmed = opacity-50 (no green/teal tint)
// - "Recurring -15% one-time" chip = neutral Badge
// - Manual discount panel = neutral Card
// - Roboto enforced across the full Create Estimate experience
// - Existing customer banner = neutral Card with dot indicator
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
  fmt,
  fmtInt,
  isCommercialEstimateInput,
  resolveLookupPropertyTypeAutofill,
  termiteBaitSelectionLabel,
  termiteBaitSystemLabel,
} from "../../lib/estimateEngine";
import { Button, Badge, Card, cn } from "../../components/ui";
import PestProductionDiagnosticsPanel from "../../components/admin/PestProductionDiagnosticsPanel";
import { ExternalLink, Monitor, X } from "lucide-react";
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
import { computeProvisionalState, provisionalSummary } from "../../utils/estimateProvisional";

const API_BASE = import.meta.env.VITE_API_URL || "/api";
const ROBOTO = "'Roboto', Arial, sans-serif";

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

const COMMERCIAL_WARNING_TEXT =
  "Commercial property detected. Residential lawn and pest pricing is not valid. Manual quote required unless small-commercial pilot pricing is enabled.";
const FLEA_EXTERIOR_SOURCE_OPTIONS = [
  { value: "UNKNOWN", label: "Unknown" },
  { value: "AI_ESTIMATE", label: "AI estimate" },
  { value: "CONFIRMED_SQ_FT", label: "Confirmed Sq Ft" },
  { value: "MEASURED_TURF", label: "Measured turf" },
  { value: "MANUAL_OVERRIDE", label: "Manual override" },
];
const FLEA_OFFER_OPTIONS = [
  {
    value: "flea_elimination_two_visit",
    label: "Flea Elimination Package",
    detail: "2 visits, conditional retreat guarantee",
  },
  {
    value: "flea_knockdown_single",
    label: "Flea Knockdown Visit",
    detail: "1 visit, no retreat warranty",
  },
];
const FLEA_COMPLEXITY_OPTIONS = [
  { value: "light", label: "Light", detail: "$0" },
  { value: "moderate", label: "Moderate", detail: "+$35 initial / +$15 follow-up" },
  { value: "heavy", label: "Heavy", detail: "+$75 initial / +$35 follow-up" },
];
const FLEA_EXTERIOR_ZONES = [
  { value: "PET_RESTING_AREA", label: "Pet resting area" },
  { value: "KENNEL_DOG_RUN", label: "Kennel / dog run" },
  { value: "UNDER_DECK_PATIO", label: "Under deck / patio" },
  { value: "FOUNDATION_PERIMETER", label: "Foundation perimeter" },
  { value: "SHADED_TURF", label: "Shaded turf" },
  { value: "MULCH_LANDSCAPE_BEDS", label: "Mulch / landscape beds" },
  { value: "CRAWLSPACE_WILDLIFE_ACTIVITY", label: "Crawlspace / wildlife activity area" },
  { value: "OTHER", label: "Other" },
];

const PALM_TREATMENT_OPTIONS = [
  { value: "nutrition", label: "Palm Nutrition Injection" },
  { value: "insecticide", label: "Preventive Palm Insecticide" },
  { value: "combo", label: "Nutrition + Insecticide" },
  { value: "fungal", label: "Palm Fungal Treatment" },
  { value: "lethalBronzing", label: "Lethal Bronzing Preventive" },
  { value: "treeAge", label: "Tree-Age Specialty Injection" },
];

const PALM_SIZE_OPTIONS = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];

const PALM_STATUS_OPTIONS = [
  { value: "healthy_preventive", label: "Healthy preventive" },
  { value: "near_infected", label: "Near infected" },
  { value: "tested_negative_preventive", label: "Tested negative preventive" },
  { value: "symptomatic", label: "Symptomatic" },
  { value: "tested_positive", label: "Tested positive" },
  { value: "infected", label: "Infected" },
];

function fleaExteriorSourceLabel(source) {
  return FLEA_EXTERIOR_SOURCE_OPTIONS.find((option) => option.value === source)?.label || "Unknown";
}

function getFleaExteriorPreview(areaSqFt, source, fleaPricingConfig) {
  const area = Math.max(0, Math.round(Number(areaSqFt) || 0));
  const normalizedSource = FLEA_EXTERIOR_SOURCE_OPTIONS.some((option) => option.value === source)
    ? source
    : "UNKNOWN";
  const exteriorConfig = fleaPricingConfig?.exterior || {};
  const maxSqFt = Number(exteriorConfig.maxSqFt ?? exteriorConfig.max_sqft);
  const tiers = Array.isArray(exteriorConfig.tiers) ? exteriorConfig.tiers : [];
  const customQuoteWarning = Number.isFinite(maxSqFt)
    ? `Properties above ${maxSqFt.toLocaleString()} sq ft require a custom quote due to product volume and treatment time.`
    : "Properties above the configured exterior flea limit require a custom quote due to product volume and treatment time.";

  if (exteriorConfig.enabled === false || !Number.isFinite(maxSqFt) || !tiers.length) {
    return {
      priceable: false,
      configUnavailable: true,
      warning: "Exterior flea pricing config is unavailable. Generate the estimate for authoritative pricing.",
    };
  }

  if (area <= 0) {
    return {
      priceable: false,
      warning: "Treatable lawn area must be confirmed before exterior flea pricing.",
    };
  }

  if (area > maxSqFt) {
    return {
      priceable: false,
      customQuote: true,
      maxSqFt,
      warning: customQuoteWarning,
    };
  }

  if (normalizedSource === "UNKNOWN") {
    return {
      priceable: false,
      warning: "Exterior flea pricing needs a confirmed treatable lawn area.",
    };
  }

  const tier = tiers.find((item) => area >= Number(item.min) && area <= Number(item.max));
  if (!tier) {
    return {
      priceable: false,
      customQuote: true,
      maxSqFt,
      warning: customQuoteWarning,
    };
  }

  return {
    priceable: true,
    initial: Math.round(Number(tier.initial) || 0),
    followUp: Math.round(Number(tier.followUp ?? tier.followup) || 0),
    total: Math.round(Number(tier.initial) || 0) + Math.round(Number(tier.followUp ?? tier.followup) || 0),
    reviewRequired: normalizedSource === "AI_ESTIMATE",
    warning:
      normalizedSource === "AI_ESTIMATE"
        ? "AI estimate detected. Please confirm before finalizing the quote."
        : null,
  };
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

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
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

async function summarizeEstimateResponseFailure(response, fallbackLabel) {
  try {
    const data = await response.clone().json();
    if (data?.error) return data.error;
    if (data?.message) return data.message;
  } catch {
    try {
      const text = await response.text();
      if (text) return text;
    } catch {
      /* ignore */
    }
  }
  return `${fallbackLabel}: ${response.status}`;
}

function estimatePreviewUrlFromSave(data) {
  if (data?.token) {
    return `${window.location.origin}/estimate/${encodeURIComponent(data.token)}`;
  }
  return data?.viewUrl || null;
}

// ── Error Boundary ──────────────────────────────────────────────
class EstimateErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("[EstimateToolViewV2 crash]", error, info.componentStack);
  }
  render() {
    if (this.state.error) {
      return (
        <Card className="p-10 text-center border-alert-fg">
          {" "}
          <div className="text-18 font-medium text-alert-fg mb-3">
            Estimate Render Error
          </div>{" "}
          <pre className="text-12 text-ink-secondary mb-4 whitespace-pre-wrap text-left max-h-48 overflow-auto">
            {this.state.error.message}
            {"\n"}
            {this.state.error.stack}
          </pre>{" "}
          <Button onClick={() => this.setState({ error: null })}>
            Try Again
          </Button>{" "}
        </Card>
      );
    }
    return this.props.children;
  }
}

// ── Form context + local V2 helpers ─────────────────────────────
const FormCtx = createContext({});

function FieldV2({ label, children, className }) {
  return (
    <div className={cn("mb-4", className)}>
      {" "}
      <label className="block text-13 font-bold text-zinc-900 tracking-normal mb-2 md:text-11 md:font-medium md:text-ink-secondary md:uppercase md:tracking-label md:mb-1.5">
        {label}
      </label>
      {children}
    </div>
  );
}

const INPUT_CLS =
  "w-full h-10 px-3 text-14 text-zinc-900 bg-white border-hairline border-zinc-300 " +
  "rounded-sm u-focus-ring placeholder:text-ink-disabled";

const CONTACT_FIELDS = new Set([
  "leadId",
  "customerId",
  "customerName",
  "customerPhone",
  "customerEmail",
]);
const SEND_FIELDS = new Set(["scheduleSend", "scheduledAt"]);
const DELIVERY_OPTION_FIELDS = new Set(["showOneTimeOption", "billByInvoice"]);
const ONE_TIME_PEST_CHOICE = { floor: 199, multiplier: 2.2 };
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

const MOSQUITO_PROTOCOL_STEPS = [
  "Inspect shaded foliage, fence lines, lanai perimeter, pool cage edges, drains, planters, and any standing-water source before treatment.",
  "Use a gas-powered backpack sprayer for a directed barrier application to mosquito resting zones. Keep applications off blooms and avoid pollinator activity windows.",
  "Recurring mosquito uses a seasonal 9-visit program or a monthly 12-visit program with pressure-adjusted recurring pricing.",
  "Recommend stations or Bti dunk tablets when breeding sources cannot be fully dumped, drained, or eliminated during the visit.",
  "Document inaccessible water, wind/rain constraints, customer source-reduction notes, and any reinspection trigger on the service record.",
];

function buildMosquitoRecommendations(form) {
  const isMosquitoSelected = !!form.svcMosquito || !!form.svcOnetimeMosquito;
  if (!isMosquitoSelected) return [];

  const heavyVegetation =
    form.treeDensity === "HEAVY" ||
    form.shrubDensity === "HEAVY" ||
    form.landscapeComplexity === "COMPLEX";
  const waterPressure = form.nearWater === "YES";
  const poolPressure = form.hasPool === "YES" || form.hasPoolCage === "YES";
  const lotPressure = Number(form.lotSqFt || 0) >= 12000;
  const recommendations = [];

  if (
    form.svcMosquito &&
    form.mosquitoProgram !== "monthly12" &&
    (heavyVegetation || waterPressure || poolPressure || lotPressure)
  ) {
    const reasons = [
      heavyVegetation ? "heavy landscape pressure" : null,
      waterPressure ? "water adjacency" : null,
      poolPressure ? "pool or cage edges" : null,
      lotPressure ? "larger treatable area" : null,
    ].filter(Boolean);
    recommendations.push({
      key: "monthly12",
      label: "Use monthly mosquito program",
      detail: `Recommended for ${reasons.join(", ")}.`,
      apply: { mosquitoProgram: "monthly12" },
    });
  }

  if (
    (waterPressure || poolPressure) &&
    Number(form.mosquitoStationCount || 0) < 2
  ) {
    recommendations.push({
      key: "stations",
      label: "Add 2 mosquito stations",
      detail: "Use when breeding sources cannot be fully removed or accessed.",
      apply: { mosquitoStationCount: "2" },
    });
  }

  if (waterPressure && Number(form.mosquitoDunkCount || 0) < 4) {
    recommendations.push({
      key: "dunks",
      label: "Add 4 Bti dunk tablets",
      detail:
        "Use for drains, planters, or non-potable standing water where labeled.",
      apply: { mosquitoDunkCount: "4" },
    });
  }

  return recommendations;
}

function validateDeliveryOptions(form, estimate) {
  const oneTimeAmount = oneTimePestChoiceAmountForPreview(estimate?.results, form)
    || Number(estimate?.oneTime?.total || 0);
  const recurringAmount = Math.max(
    Number(estimate?.recurring?.grandTotal || 0),
    Number(estimate?.recurring?.monthlyTotal || 0),
    Number(estimate?.recurring?.annualAfterDiscount || 0),
  );
  if (form.showOneTimeOption) {
    const nonPestRecurring = nonPestRecurringServicesForDelivery(estimate);
    if (nonPestRecurring.length > 0) {
      return `Offer one-time option is only supported for pest-only recurring estimates. Remove ${nonPestRecurring.join(", ")} or turn off the one-time choice.`;
    }
    if (!hasPestRecurringServiceForDelivery(estimate)) {
      return "Offer one-time option requires recurring pest pricing on the generated estimate.";
    }
    if (oneTimeAmount <= 0) {
      return "Offer one-time option requires a one-time total on the generated estimate.";
    }
  }
  if (form.billByInvoice && oneTimeAmount <= 0 && recurringAmount <= 0) {
    return "Bill by invoice requires a billable recurring or one-time total.";
  }
  return null;
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

function nonPestRecurringServicesForDelivery(estimate) {
  const rows = Array.isArray(estimate?.recurring?.services)
    ? estimate.recurring.services
    : [];
  const seen = new Set();
  return rows
    .filter((service) => {
      const label = String(
        service?.displayName || service?.name || service?.label || service?.service || "",
      );
      const key = String(service?.service || "").toLowerCase();
      return label && !label.toLowerCase().includes("pest") && !key.includes("pest");
    })
    .map((service) => service.displayName || service.name || service.label || service.service)
    .filter((label) => {
      const key = String(label || "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function firstPositivePreviewNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function hasPestRecurringServiceForDelivery(estimate) {
  const rows = Array.isArray(estimate?.recurring?.services)
    ? estimate.recurring.services
    : [];
  const rowHasPestPrice = rows.some((service) => {
    const label = String(
      service?.displayName || service?.name || service?.label || service?.service || "",
    ).toLowerCase();
    const key = String(service?.service || "").toLowerCase();
    if (!label.includes("pest") && !key.includes("pest")) return false;
    return firstPositivePreviewNumber(
      service.mo,
      service.monthly,
      service.monthlyTotal,
      service.ann,
      service.annual,
      service.annualTotal,
      service.perTreatment,
      service.perApp,
      service.perVisit,
      service.pa,
      service.price,
      service.amount,
    ) > 0;
  });
  if (rowHasPestPrice) return true;
  const tiers = Array.isArray(estimate?.results?.pestTiers)
    ? estimate.results.pestTiers
    : [];
  return tiers.some((tier) => firstPositivePreviewNumber(
    tier.pa,
    tier.perApp,
    tier.perVisit,
    tier.perTreatment,
    tier.mo,
    tier.monthly,
    tier.ann,
    tier.annual,
  ) > 0);
}

function rowLooksQuarterlyPestTier(tier = {}) {
  const label = String(tier.label || tier.name || tier.frequency || "").toLowerCase();
  const apps = Number(tier.apps || tier.v || tier.visitsPerYear || tier.frequency);
  return label.includes("quarter") || (Number.isFinite(apps) && apps > 0 && apps <= 4);
}

function pestTierPerAppForOneTimeChoice(tier = {}) {
  if (!tier || typeof tier !== "object") return null;
  const explicit = firstPositivePreviewNumber(
    tier.pa,
    tier.perApp,
    tier.perVisit,
    tier.perTreatment,
  );
  if (explicit) return explicit;
  const apps = firstPositivePreviewNumber(tier.apps, tier.v, tier.visitsPerYear);
  const monthly = firstPositivePreviewNumber(tier.mo, tier.monthly);
  if (apps && monthly) return Math.round(((monthly * 12) / apps) * 100) / 100;
  const annual = firstPositivePreviewNumber(tier.ann, tier.annual);
  if (apps && annual) return Math.round((annual / apps) * 100) / 100;
  return null;
}

function oneTimePestChoiceAmountFromTier(tier = {}) {
  if (!tier || typeof tier !== "object") return null;
  const perApp = pestTierPerAppForOneTimeChoice(tier);
  if (!perApp) return null;
  return Math.max(
    ONE_TIME_PEST_CHOICE.floor,
    Math.round(perApp * ONE_TIME_PEST_CHOICE.multiplier),
  );
}

function oneTimePestChoiceAmountForPreview(R = {}, form = {}) {
  const tiers = Array.isArray(R?.pestTiers) ? R.pestTiers : [];
  const selected = selectedPestTierForPreview(R, form);
  const tier = tiers.find(rowLooksQuarterlyPestTier) || selected;
  return oneTimePestChoiceAmountFromTier(tier);
}

function formatDatetimeLocal(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return (
    [date.getFullYear(), pad(date.getMonth() + 1), pad(date.getDate())].join(
      "-",
    ) + `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function parseNonNegativeInteger(value) {
  if (value === undefined || value === null || value === "") return null;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parsePositiveInteger(value) {
  if (value === undefined || value === null || String(value).trim() === "") return undefined;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

function hasInvalidPositiveInteger(value) {
  return value !== undefined && value !== null && String(value).trim() !== "" && parsePositiveInteger(value) === undefined;
}

function parsePositiveNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parseNonNegativeNumber(value) {
  if (value === undefined || value === null || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function firstPositiveNumber(...values) {
  for (const value of values) {
    const parsed = parsePositiveNumber(value);
    if (parsed) return parsed;
  }
  return undefined;
}

function lookupTermiteFootprintSqFt(data = {}) {
  const explicitFootprint = firstPositiveNumber(
    data.footprint,
    data.footprintSqFt,
    data.footprint_sqft,
    data.buildingFootprintSqFt,
    data.building_footprint_sqft,
    data.structureFootprintSqFt,
    data.structure_footprint_sqft,
  );
  if (explicitFootprint) return explicitFootprint;

  const stories = firstPositiveNumber(data.stories, data.storyCount, data.story_count);
  const livingArea = firstPositiveNumber(
    data.livingAreaSqFt,
    data.living_area_sqft,
    data.homeSqFt,
    data.home_sqft,
  );
  return stories && livingArea
    ? Math.round(livingArea / Math.max(1, stories))
    : undefined;
}

function formatSqFt(value) {
  const n = parseNonNegativeInteger(value);
  return n === null ? "unknown" : `${n.toLocaleString()} sf`;
}

function serviceDetailText(item = {}) {
  const baseParts = [
    item.detail || item.det || item.note || "",
    item.exteriorDetail || "",
    item.warning || "",
    ...(Array.isArray(item.warnings) ? item.warnings : []),
  ].filter(Boolean);
  const quoteDetail = item.quoteRequired || item.requiresCustomQuote
    ? quoteRequiredReasonNote(item, baseParts.join(" · "))
    : "";
  const parts = [...baseParts, quoteDetail].filter(Boolean);
  const unique = [];
  for (const part of parts) {
    if (unique.includes(part)) continue;
    if (unique.some((existing) => existing.includes(part))) continue;
    unique.push(part);
  }
  return unique.join(" · ");
}

function InputV2({ k, type = "text", placeholder, min, max, className }) {
  const { form, set } = useContext(FormCtx);
  return (
    <input
      type={type}
      value={form[k] ?? ""}
      onChange={(e) => set(k, e.target.value)}
      placeholder={placeholder}
      min={min}
      max={max}
      className={cn(INPUT_CLS, className)}
    />
  );
}

function SelectV2({ k, options }) {
  const { form, set } = useContext(FormCtx);
  return (
    <select
      value={form[k] ?? ""}
      onChange={(e) => set(k, e.target.value)}
      className={cn(
        INPUT_CLS,
        "cursor-pointer appearance-none pr-8 bg-no-repeat bg-[right_0.75rem_center]",
      )}
      style={{
        backgroundImage:
          "url(\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' fill='%2371717A' viewBox='0 0 16 16'%3E%3Cpath d='M8 11L3 6h10z'/%3E%3C/svg%3E\")",
      }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

function CheckboxV2({ k, label }) {
  const { form, toggle } = useContext(FormCtx);
  const checked = !!form[k];
  return (
    <label className="relative flex items-center gap-2.5 mb-2.5 cursor-pointer text-14 text-zinc-900 select-none">
      {" "}
      <span
        className={cn(
          "flex-shrink-0 w-4 h-4 border-hairline rounded-xs flex items-center justify-center transition-colors",
          checked ? "bg-zinc-900 border-zinc-900" : "bg-white border-zinc-300",
        )}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            {" "}
            <path
              d="M1.5 5L4 7.5L8.5 2.5"
              stroke="white"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            />{" "}
          </svg>
        )}
      </span>{" "}
      <input
        type="checkbox"
        checked={checked}
        onChange={() => toggle(k)}
        className="sr-only"
      />
      {label}
    </label>
  );
}

// Section header within the Create Estimate form. Matches the
// "Live Status" label style on TimeTrackingPage (15/600).
function PanelTitle({ children, description }) {
  return (
    <>
      {" "}
      <h3
        className="text-zinc-900 mt-0 mb-3"
        style={{ fontSize: 15, fontWeight: 600 }}
      >
        {children}
      </h3>
      {description && (
        <p className="text-14 text-zinc-600 mb-5 leading-snug">{description}</p>
      )}
    </>
  );
}

// Sub-group header inside the Services panel (Recurring / One-Time /
// Lawn / Termite / Pest / Rodent). Matches PanelTitle so the whole
// Create Estimate form reads as one visual family.
function SubGroupLabel({ children, className }) {
  return (
    <h4
      className={cn("text-zinc-900 mt-4 mb-2", className)}
      style={{ fontSize: 15, fontWeight: 600 }}
    >
      {children}
    </h4>
  );
}

function StatusLine({ status }) {
  if (!status?.type) return null;
  const isErr = status.type === "err";
  return (
    <div
      className={cn(
        " text-12 px-3 py-2 rounded-xs mb-3 whitespace-pre-line border-hairline",
        isErr
          ? "bg-alert-bg text-alert-fg border-alert-fg"
          : "bg-zinc-50 text-ink-secondary border-zinc-200",
      )}
    >
      {status.msg}
    </div>
  );
}

// Tier grid + row (monochrome).
function TierGridV2({ children }) {
  return <div className="grid gap-2">{children}</div>;
}

function TierRowV2({
  name,
  detail,
  price,
  recommended,
  dimmed,
  onSelect,
  selected,
}) {
  const clickable = !!onSelect;
  return (
    <div
      onClick={onSelect}
      title={clickable ? "Click to select this frequency" : undefined}
      className={cn(
        "grid items-center rounded-sm transition-colors px-4 py-3 border-hairline",
        "grid-cols-[120px_1fr_110px] gap-3",
        selected
          ? "bg-zinc-50 border-zinc-900 ring-2 ring-zinc-900"
          : "bg-white border-zinc-200",
        clickable ? "cursor-pointer hover:bg-zinc-50" : "cursor-default",
        dimmed && !selected ? "opacity-50" : "",
      )}
    >
      {" "}
      <div className="text-14 font-medium text-zinc-900 flex items-center gap-1.5">
        {name}
        {selected && <span className="text-11 u-nums"></span>}
        {!selected && recommended && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-900"
            title="Recommended"
          />
        )}
      </div>{" "}
      <div className="text-12 text-ink-secondary break-words">{detail}</div>{" "}
      <div className="text-14 font-medium text-zinc-900 text-right u-nums">
        {price}
      </div>{" "}
    </div>
  );
}

function Tag({ children }) {
  return (
    <span className="inline-block text-11 font-medium uppercase tracking-label px-2 py-0.5 rounded-xs bg-zinc-100 text-ink-secondary ml-2 align-middle">
      {children}
    </span>
  );
}

function FieldVerifyTag({ children }) {
  return (
    <span className="inline-block text-11 font-medium uppercase tracking-label px-2 py-0.5 rounded-xs bg-alert-bg text-alert-fg ml-2 align-middle">
      {children}
    </span>
  );
}

function DiscBadge({ children }) {
  return (
    <span className="inline-block text-11 font-medium uppercase tracking-label px-2 py-0.5 rounded-xs bg-zinc-900 text-white ml-2 align-middle u-nums">
      {children}
    </span>
  );
}

function GroupHeader({ children }) {
  return (
    <div className="text-22 font-bold tracking-tight text-zinc-900 mt-7 mb-3 md:text-12 md:font-medium md:uppercase md:tracking-label md:mb-4 md:pb-2 md:border-b-hairline md:border-zinc-300">
      {children}
    </div>
  );
}

function SectionTitle({ children, className }) {
  return (
    <div
      className={cn(
        "text-14 font-medium uppercase tracking-label text-zinc-900 mb-3",
        className,
      )}
    >
      {children}
    </div>
  );
}

const CUSTOMER_PREVIEW_PERKS = [
  "Priority scheduling",
  "Re-service between visits at no charge",
  "Locked-in pricing for 12 months",
  "Free annual termite inspection",
  "15% off one-time treatments",
  "Customer portal for service history",
];

function firstNameFromCustomerName(name) {
  const first = String(name || "").trim().split(/\s+/)[0];
  return first || "there";
}

function selectedPestTierForPreview(R, form) {
  const tiers = Array.isArray(R?.pestTiers) ? R.pestTiers : [];
  if (!tiers.length) return null;
  return (
    tiers.find((t) => String(t.apps) === String(form.pestFreq)) ||
    tiers.find((t) => t.recommended) ||
    tiers[0]
  );
}

function cadenceFromPestTier(tier) {
  const apps = Number(tier?.apps || 0);
  if (apps >= 12) {
    return { key: "monthly", label: "Monthly", intervalMonths: 1, period: "/mo" };
  }
  if (apps >= 6) {
    return {
      key: "bi_monthly",
      label: "Bi-monthly",
      intervalMonths: 2,
      period: "/bi-monthly",
    };
  }
  return { key: "quarterly", label: "Quarterly", intervalMonths: 3, period: "/quarter" };
}

function fallbackCadenceForPreview() {
  return {
    key: "quarterly",
    label: "Quarterly",
    intervalMonths: 3,
    period: "/quarter",
  };
}

function customerPreviewPricing(E, pestTier, form) {
  const oneTimeChoiceAmount = oneTimePestChoiceAmountForPreview(E?.results, form);
  const pestOnlyChoice =
    !!form.showOneTimeOption &&
    !!pestTier &&
    oneTimeChoiceAmount > 0;

  if (pestOnlyChoice) {
    const baseMonthly = Number(pestTier.mo || 0);
    const discount = Number(E?.recurring?.discount || 0);
    return {
      monthlyTotal: Math.max(0, Math.round(baseMonthly * (1 - discount) * 100) / 100),
      baseMonthly,
    };
  }

  const grandTotal = Number(E?.recurring?.grandTotal);
  const hasGrandTotal =
    E?.recurring?.grandTotal !== undefined &&
    E?.recurring?.grandTotal !== null &&
    Number.isFinite(grandTotal);
  const monthlyTotal = hasGrandTotal
    ? grandTotal
    : Number(E?.recurring?.monthlyTotal || 0) +
      Number(E?.recurring?.rodentBaitMo || 0) +
      Number(E?.recurring?.palmInjectionMo || 0);
  const annualBeforeDiscount = Number(E?.recurring?.annualBeforeDiscount || 0);
  return {
    monthlyTotal,
    baseMonthly: annualBeforeDiscount > 0 ? annualBeforeDiscount / 12 : monthlyTotal,
  };
}

function previewVisitsLabel(visits) {
  const n = Number(visits);
  if (n === 12) return "Monthly";
  if (n === 9) return "9-visit";
  if (n === 8) return "8-visit";
  if (n === 6) return "Bi-monthly";
  if (n === 4) return "Quarterly";
  if (n === 2) return "Semi-annual";
  if (n === 1) return "Annual";
  return n > 0 ? `${n}-visit` : "";
}

function previewRecurringServiceName(service) {
  return service?.name || service?.label || service?.displayName || "";
}

function previewRecurringFrequencyLabel(name, R) {
  const label = String(name || "").toLowerCase();
  if (label.includes("lawn") && Array.isArray(R?.lawn)) {
    const selected = R.lawn.find((tier) => tier.recommended) || R.lawn[0];
    return previewVisitsLabel(selected?.v);
  }
  if (label.includes("mosquito") && Array.isArray(R?.mq)) {
    const selected = selectedMosquitoTier(R);
    return previewVisitsLabel(selected?.v);
  }
  if (label.includes("tree") && Array.isArray(R?.ts)) {
    const selected = R.ts.find((tier) => tier.recommended) || R.ts[0];
    return previewVisitsLabel(selected?.v);
  }
  if (label.includes("termite") && label.includes("bait")) return "Quarterly";
  return "";
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

function selectedMosquitoTier(R) {
  const tiers = Array.isArray(R?.mq) ? R.mq : [];
  const ri = Number(R?.mqMeta?.ri);
  return tiers.find((tier) => tier.selected || tier.isSelected) ||
    (Number.isInteger(ri) ? tiers[ri] : null) ||
    tiers.find((tier) => tier.recommended || tier.isRecommended) ||
    tiers[0] ||
    null;
}

function previewRecurringDisplayName(service) {
  return service?.displayName || previewRecurringServiceName(service);
}

function isFrequencyQualifiedPreviewLabel(label) {
  return /\b(monthly|bi[-\s]?monthly|quarterly|seasonal|annual|semi[-\s]?annual|\d+\s*(?:x|visits?|visit)|x\/yr)\b/i.test(
    String(label || ""),
  );
}

function previewRecurringServiceLabel(service, R) {
  const name = previewRecurringServiceName(service);
  if (!name) return "";
  const displayName = previewRecurringDisplayName(service);
  if (
    displayName &&
    displayName !== name &&
    isFrequencyQualifiedPreviewLabel(displayName)
  ) {
    return displayName;
  }
  const frequency = previewRecurringFrequencyLabel(name, R);
  return frequency ? `${frequency} ${displayName || name}` : displayName || name;
}

function previewServiceLabel(E, R, form) {
  const pestTier = selectedPestTierForPreview(R, form);
  if (pestTier) {
    const cadence = cadenceFromPestTier(pestTier);
    if (form.showOneTimeOption && oneTimePestChoiceAmountForPreview(R, form) > 0) {
      return `${cadence.label} Pest Control or One-Time Pest Control`;
    }
    const bundledNames = (E?.recurring?.services || [])
      .filter((service) => {
        const name = previewRecurringServiceName(service).toLowerCase();
        return name && !name.includes("pest");
      })
      .map((service) => previewRecurringServiceLabel(service, R))
      .filter(Boolean);
    return [`${cadence.label} Pest Control`, ...bundledNames].join(" + ");
  }

  const names = (E?.recurring?.services || [])
    .map((s) => previewRecurringServiceLabel(s, R))
    .filter(Boolean)
    .slice(0, 3);
  if (names.length) return names.join(" + ");

  const oneTimeNames = [
    ...(E?.oneTime?.items || []),
    ...(E?.oneTime?.specItems || []),
  ]
    .map((s) => s.displayName || s.name)
    .filter(Boolean)
    .slice(0, 3);
  return oneTimeNames.length ? oneTimeNames.join(" + ") : "Custom quote";
}

function propertyLineForPreview(E, R) {
  const p = E?.property || {};
  const rows = [];
  const homeSqFt = Number(p.homeSqFt || 0);
  const lotSqFt = Number(p.lotSqFt || 0);
  const hasLawnService = (E?.recurring?.services || []).some((service) =>
    previewRecurringServiceName(service).toLowerCase().includes("lawn"),
  );
  const lawnSqFt = hasLawnService ? Number(R?.lawnMeta?.lsf || p.turfSf || 0) : 0;
  const termitePerimeter = Number(R?.tmBait?.perim || 0);
  if (homeSqFt > 0) rows.push(`${Math.round(homeSqFt).toLocaleString()} sq ft home`);
  if (lotSqFt > 0) rows.push(`${Math.round(lotSqFt).toLocaleString()} sq ft lot`);
  if (lawnSqFt > 0) rows.push(`${Math.round(lawnSqFt).toLocaleString()} sq ft treatable lawn`);
  if (termitePerimeter > 0) rows.push(`${Math.round(termitePerimeter).toLocaleString()} linear ft termite perimeter`);
  return rows.join(" · ");
}

const INITIAL_ROACH_PREVIEW_RE = /initial.*(palmetto|german|roach).*knockdown/i;

function previewServiceKey(item, fallbackLabel = "") {
  const service = String(item?.service || "").toLowerCase();
  if (service) return service;
  const label = String(
    fallbackLabel || item?.label || item?.displayName || item?.name || "",
  ).toLowerCase();
  if (INITIAL_ROACH_PREVIEW_RE.test(label)) return "pest_initial_roach";
  if (label.includes("waveguard setup") || label.includes("membership")) {
    return "waveguard_setup";
  }
  return "";
}

function previewLineAmount(price) {
  return price < 0 ? `-${fmtInt(Math.abs(price))}` : fmtInt(price);
}

function termiteInstallPreviewRow(E) {
  const price = Number(E?.oneTime?.tmInstall || 0);
  if (!Number.isFinite(price) || price <= 0) return null;
  const tmBait = E?.results?.tmBait || {};
  const stations = Number(tmBait.sta || tmBait.stations || 0);
  const perimeter = Number(tmBait.perim || tmBait.perimeter || 0);
  const detail = [
    stations > 0 ? `${Math.round(stations).toLocaleString()} stations` : null,
    perimeter > 0 ? `${Math.round(perimeter).toLocaleString()} linear ft perimeter` : null,
  ].filter(Boolean).join(" · ");
  return {
    service: "termite_bait_installation",
    name: "Termite bait installation",
    price,
    detail,
  };
}

function oneTimeRowsForCustomerPreview(E, {
  includeSetupFees = false,
  setupFeeAmount = 0,
  oneTimeTotal = null,
  excludeServices = [],
} = {}) {
  const specRows = Array.isArray(E?.specItems)
    ? E.specItems
    : (E?.oneTime?.specItems || []);
  const rows = [
    ...(E?.oneTime?.items || []),
    ...specRows.filter((item) => {
      const price = Number(item.price ?? item.amount ?? item.total ?? 0);
      return !item.onProg && Number.isFinite(price) && price !== 0;
    }),
  ];

  const excluded = new Set(
    excludeServices.map((service) => String(service || "").toLowerCase()).filter(Boolean),
  );
  const seen = new Set();
  const displayRows = [];

  const addRow = (item) => {
    const name = item.displayName || item.label || item.name || "One-time service";
    const price = Number(item.price ?? item.amount ?? item.total ?? 0);
    const detail = serviceDetailText(item);
    const service = previewServiceKey(item, name);
    const label = String(name).toLowerCase();
    const isSetupFee =
      service === "waveguard_setup" ||
      label.includes("waveguard setup") ||
      label.includes("membership");
    if (
      !Number.isFinite(price) ||
      price === 0 ||
      excluded.has(service) ||
      (!includeSetupFees && isSetupFee)
    ) {
      return;
    }
    const key = `${service}|${name}|${price}|${detail}`;
    if (seen.has(key)) return;
    seen.add(key);
    displayRows.push({ service, name, price, detail });
  };

  rows.forEach(addRow);
  const termiteInstallRow = termiteInstallPreviewRow(E);
  if (termiteInstallRow) {
    const hasTermiteInstallRow = displayRows.some((row) => {
      const label = String(row.name || "").toLowerCase();
      return (
        row.service === "termite_bait_installation" ||
        (label.includes("termite") && label.includes("install")) ||
        (label.includes("trelona") && label.includes("install")) ||
        (label.includes("install") && Math.abs(row.price - termiteInstallRow.price) <= 0.01)
      );
    });
    if (!hasTermiteInstallRow) addRow(termiteInstallRow);
  }

  const setupFee = includeSetupFees ? Number(setupFeeAmount || 0) : 0;
  const targetTotal = Number(oneTimeTotal);
  const rowsTotal = displayRows.reduce((sum, row) => sum + row.price, 0);
  const hasSetupRow = displayRows.some((row) => row.service === "waveguard_setup");
  const targetIncludesSetupFee =
    setupFee > 0 &&
    !hasSetupRow &&
    Number.isFinite(targetTotal) &&
    targetTotal > 0 &&
    Math.abs(targetTotal - (rowsTotal + setupFee)) <= 0.01;
  if (targetIncludesSetupFee) {
    addRow({
      service: "waveguard_setup",
      name: "WaveGuard setup",
      price: setupFee,
      detail: "Membership setup fee",
    });
  }

  return displayRows;
}

function isWaveGuardSetupPreviewRow(row = {}) {
  const service = String(row.service || "").toLowerCase();
  const text = `${row.name || ""} ${row.label || ""} ${row.detail || ""}`.toLowerCase();
  return service === "waveguard_setup" ||
    text.includes("waveguard setup") ||
    text.includes("waveguard membership") ||
    text.includes("membership setup fee");
}

function isOneTimePestChoicePreviewRow(row = {}) {
  const service = String(row.service || "").toLowerCase();
  const text = `${service} ${row.name || ""} ${row.label || ""}`.toLowerCase().replace(/[_-]+/g, " ");
  if (service === "pest_initial_roach" || INITIAL_ROACH_PREVIEW_RE.test(text)) return false;
  return service === "one_time_pest" ||
    text.includes("one time pest") ||
    text.includes("one-time pest") ||
    text.includes("onetime pest");
}

function isPestSpecialtyPreviewRow(row = {}) {
  const service = String(row.service || "").toLowerCase();
  const text = `${service} ${row.name || ""} ${row.label || ""}`.toLowerCase().replace(/[_-]+/g, " ");
  if (
    service === "pest_control" ||
    service === "pest_initial_cleanout" ||
    service === "initial_pest_cleanout" ||
    service === "pest_cleanout" ||
    text.includes("initial pest cleanout") ||
    text.includes("general pest cleanout")
  ) {
    return false;
  }
  return service === "pest_initial_roach" ||
    /\b(roach|cockroach|ant|spider|flea|wasp|bee|hornet|stinging|bed\s*bug|bedbug)\b/.test(text);
}

function oneTimePestSpecialtyRowsForCustomerPreview(E) {
  return oneTimeRowsForCustomerPreview(E).filter((row) => {
    const price = Number(row.price || 0);
    const service = String(row.service || "").toLowerCase();
    return Number.isFinite(price) &&
      price > 0 &&
      service !== "one_time_adjustment" &&
      !isWaveGuardSetupPreviewRow(row) &&
      !isOneTimePestChoicePreviewRow(row) &&
      isPestSpecialtyPreviewRow(row);
  });
}

function oneTimePestChoiceRowsForCustomerPreview(E, pestChoiceAmount) {
  const amount = Number(pestChoiceAmount || 0);
  if (!Number.isFinite(amount) || amount <= 0) return [];
  return [{
    service: "one_time_pest",
    name: "One-Time Pest Control",
    price: Math.round(amount * 100) / 100,
    detail: "Single treatment",
  }, ...oneTimePestSpecialtyRowsForCustomerPreview(E)];
}

function firstVisitFeesForCustomerPreview(E, pestTier) {
  const rows = [];
  const hasRecurringPest = !!pestTier;
  const setupFee = hasRecurringPest
    ? Number(E?.oneTime?.membershipFee || pestTier?.init || 0)
    : 0;
  if (setupFee > 0) {
    rows.push({
      service: "waveguard_setup",
      name: "WaveGuard setup",
      price: setupFee,
      waivedWithPrepay: true,
    });
  }

  const oneTimeSources = [
    ...(E?.oneTime?.items || []),
    ...(E?.oneTime?.specItems || []),
    ...(Array.isArray(E?.specItems) ? E.specItems : []),
  ];
  const roachItem = oneTimeSources.find((item) => {
    const name = item?.displayName || item?.label || item?.name || "";
    return previewServiceKey(item, name) === "pest_initial_roach";
  });
  const roachPrice = Number(roachItem?.price ?? roachItem?.amount ?? roachItem?.total ?? 0);
  if (Number.isFinite(roachPrice) && roachPrice > 0) {
    rows.push({
      service: "pest_initial_roach",
      name: roachItem.displayName || roachItem.label || roachItem.name || "Initial Roach Knockdown",
      price: roachPrice,
      detail: roachItem.detail || roachItem.det || roachItem.note || "",
      waivedWithPrepay: false,
    });
  }

  const seen = new Set();
  return rows.filter((row) => {
    const key = `${row.service}|${row.name}|${row.price}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function oneTimeChoicePreviewMeta(E, pestTier, oneTimeRows = []) {
  const rawRows = [
    ...(E?.oneTime?.items || []),
    ...(E?.oneTime?.specItems || []),
    ...(Array.isArray(E?.specItems) ? E.specItems : []),
  ].map((item) => {
    const name = item?.displayName || item?.label || item?.name || "One-time service";
    return {
      service: previewServiceKey(item, name),
      name,
    };
  });
  const termiteInstallRow = termiteInstallPreviewRow(E);
  if (termiteInstallRow) rawRows.push(termiteInstallRow);
  const candidates = (oneTimeRows.length ? oneTimeRows : rawRows).filter(
    (row) => row.service !== "waveguard_setup",
  );
  const oneTimeText = candidates
    .map((row) => `${row.service || ""} ${row.name || ""}`)
    .join(" ")
    .toLowerCase();
  const recurringText = (E?.recurring?.services || [])
    .map((service) => previewRecurringServiceName(service))
    .join(" ")
    .toLowerCase();
  const matches = (needle) =>
    oneTimeText.includes(needle) || (!oneTimeText && recurringText.includes(needle));

  // German Roach Cleanout only — must not catch the non-roach "Initial Pest
  // Cleanout" (pest_initial_cleanout) service, which keeps the standard
  // one-time pest copy. Mirrors isGermanRoachCleanoutOneTimeItem on the server.
  if (matches("german roach") || (matches("roach") && matches("cleanout"))) {
    const visitMatch = oneTimeText.match(/(\d+)\s*visit/);
    const n = visitMatch ? Number(visitMatch[1]) : 0;
    const words = { 1: "One visit", 2: "Two visits", 3: "Three visits", 4: "Four visits" };
    const phrase = words[n] || (n > 0 ? `${n} visits` : "Multiple visits");
    return {
      recurringLabel: "German Roach Cleanout",
      oneTimeLabel: "German Roach Cleanout",
      description:
        `${phrase} to break the breeding cycle. Pay on service day, no recurring schedule. 100% guaranteed with the Waves Guarantee.`,
    };
  }
  if (matches("mosquito")) {
    return {
      recurringLabel: "Recurring Mosquito Control",
      oneTimeLabel: "One-Time Mosquito Control",
      description:
        "One visit, pay on service day. No recurring schedule, no program discount. Includes the applicable one-time callback period after this visit.",
    };
  }
  if (matches("lawn")) {
    return {
      recurringLabel: "Recurring Lawn Care",
      oneTimeLabel: "One-Time Lawn Care",
      description:
        "One visit, pay on service day. No recurring schedule, no program discount.",
    };
  }
  if (matches("termite")) {
    return {
      recurringLabel: "Recurring Termite Protection",
      oneTimeLabel: "One-Time Termite Service",
      description:
        "One visit, pay on service day. No recurring schedule, no program discount.",
    };
  }

  const hasPest =
    !!pestTier ||
    /\b(pest|roach|ant|spider|flea|wasp|bed\s*bug|bedbug)\b/.test(oneTimeText) ||
    (!oneTimeText && recurringText.includes("pest"));
  if (hasPest) {
    return {
      recurringLabel: "Recurring Pest Control",
      oneTimeLabel: "One-Time Pest Control",
      description:
        "One visit, pay on service day. No recurring schedule, no tier discount. Includes a 30-day callback period if pest activity returns after this visit.",
    };
  }

  const fallbackName = candidates.find((row) => row.name)?.name || "One-Time Service";
  return {
    recurringLabel: "Recurring Service",
    oneTimeLabel: fallbackName.replace(/^OT\b/i, "One-Time"),
    description:
      "One visit, pay on service day. No recurring schedule, no program discount.",
  };
}

function CustomerEstimatePreviewV2({ E, R, form, satelliteUrl, onSelectPestFreq, presentMode = false }) {
  if (!E) return null;

  const pestTier = selectedPestTierForPreview(R, form);
  const cadence = pestTier
    ? cadenceFromPestTier(pestTier)
    : fallbackCadenceForPreview(E, R, form);
  const { monthlyTotal, baseMonthly } = customerPreviewPricing(E, pestTier, form);
  const intervalTotal = Math.round(monthlyTotal * cadence.intervalMonths * 100) / 100;
  const intervalBase = Math.round(baseMonthly * cadence.intervalMonths * 100) / 100;
  const intervalSavings = Math.max(0, Math.round((intervalBase - intervalTotal) * 100) / 100);
  const waveGuardTier = E.recurring?.waveGuardTier || E.recurring?.tier || "Bronze";
  const firstVisitFees = firstVisitFeesForCustomerPreview(E, pestTier);
  const dayPrice = monthlyTotal > 0 ? Math.round((monthlyTotal * 12 / 365) * 100) / 100 : 0;
  const serviceLabel = previewServiceLabel(E, R, form);
  const propertyLine = propertyLineForPreview(E, R);
  const oneTimeStandaloneTotal = Number(E.oneTime?.total || 0);
  const oneTimePestChoiceAmount = oneTimePestChoiceAmountForPreview(R, form);
  const pestChoiceRows = oneTimePestChoiceRowsForCustomerPreview(E, oneTimePestChoiceAmount);
  const oneTimeChoiceAmount = pestChoiceRows.length
    ? pestChoiceRows.reduce((sum, row) => Math.round((sum + Number(row.price || 0)) * 100) / 100, 0)
    : oneTimeStandaloneTotal;
  const hasOneTimeChoice = !!form.showOneTimeOption && oneTimeChoiceAmount > 0 && monthlyTotal > 0;
  const oneTimeRows = oneTimeRowsForCustomerPreview(E, {
    excludeServices: firstVisitFees.map((fee) => fee.service),
  });
  const oneTimeChoiceRows = hasOneTimeChoice
    ? (pestChoiceRows.length ? pestChoiceRows : [{
        service: "one_time_pest",
        name: "One-Time Pest Control",
        price: oneTimeChoiceAmount,
        detail: "Single treatment",
      }])
    : oneTimeRowsForCustomerPreview(E, {
        includeSetupFees: true,
        setupFeeAmount: firstVisitFees.find((fee) => fee.service === "waveguard_setup")?.price || 0,
        oneTimeTotal: oneTimeStandaloneTotal,
      });
  const oneTimeChoiceMeta = oneTimeChoicePreviewMeta(E, pestTier, oneTimeChoiceRows);
  const aiMetrics = [
    E.property?.homeSqFt ? { label: "Home", value: `${Math.round(E.property.homeSqFt).toLocaleString()} sq ft` } : null,
    E.property?.lotSqFt ? { label: "Lot", value: `${Math.round(E.property.lotSqFt).toLocaleString()} sq ft` } : null,
    R?.lawnMeta?.lsf ? { label: "Treatable lawn", value: `${Math.round(R.lawnMeta.lsf).toLocaleString()} sq ft` } : null,
    E.property?.complexity || E.property?.landscapeComplexity
      ? { label: "Complexity", value: String(E.property.complexity || E.property.landscapeComplexity).toLowerCase() }
      : null,
  ].filter(Boolean);

  return (
    <div className="customer-preview-scope rounded-sm overflow-hidden border-hairline border-[#E7E2D7] bg-[#FAF8F3] mb-6">
      <div className="bg-white border-b border-[#E7E2D7] px-5 py-3 flex items-center justify-between gap-4">
        <span className="text-13 font-semibold text-[#1B2C5B]">(941) 297-5749</span>
        <img src="/waves-logo.png" alt="Waves" className="h-7 block" />
      </div>

      <div className="px-5 py-6 max-w-[720px] mx-auto">
        <div className="text-11 uppercase tracking-[0.12em] font-bold text-[#6B7280] mb-1">
          Your estimate · {serviceLabel}
        </div>
        <h2 className="customer-preview-serif text-[#1B2C5B] text-[34px] leading-[1.08] font-medium tracking-normal m-0">
          Hey {firstNameFromCustomerName(form.customerName)}, here's your custom quote.
        </h2>
        {form.address && (
          <div className="text-18 text-[#3F4A65] leading-snug mt-4">
            {form.address}
          </div>
        )}
        {propertyLine && (
          <div className="text-13 text-[#6B7280] mt-1">{propertyLine}</div>
        )}

        {pestTier && Array.isArray(R?.pestTiers) && R.pestTiers.length > 1 && (
          <div className="bg-white rounded-[14px] border border-[#CBD5E1] px-4 py-4 mt-5">
            <div className="text-12 font-bold uppercase tracking-[0.08em] text-[#64748B] mb-3">
              How often?
            </div>
            <div className="grid grid-cols-3 gap-2">
              {R.pestTiers.map((tier) => {
                const selected = String(tier.apps) === String(form.pestFreq);
                return (
                  <button
                    type="button"
                    key={tier.label}
                    onClick={() => onSelectPestFreq?.(tier.apps)}
                    className={cn(
                      "rounded-sm border px-3 py-3 text-left transition-colors",
                      selected
                        ? "bg-[#009CDE] text-white border-[#009CDE]"
                        : "bg-white text-[#1B2C5B] border-[#E2E8F0] hover:border-[#009CDE]",
                    )}
                  >
                    <span className="block text-13 font-bold">{tier.label}</span>
                    <span className={cn("block text-11 mt-1", selected ? "text-white/85" : "text-[#64748B]")}>
                      {fmt(tier.pa)}/visit
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {hasOneTimeChoice && (
          <div className="bg-[#F1F5F9] rounded-full p-1 border border-[#E2E8F0] mt-5 flex gap-1 shadow-[0_1px_4px_rgba(15,23,42,0.04)]">
            <div className="flex-1 rounded-full bg-[#009CDE] text-white text-center text-13 font-semibold px-3 py-2">
              {oneTimeChoiceMeta.recurringLabel}
            </div>
            <div className="flex-1 rounded-full text-[#3F4A65] text-center text-13 font-semibold px-3 py-2">
              {oneTimeChoiceMeta.oneTimeLabel}
            </div>
          </div>
        )}

        {monthlyTotal > 0 ? (
          <div className="pt-5 pb-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              {intervalSavings > 0 && (
                <span className="customer-preview-serif text-24 text-[#9CA3AF] line-through">
                  {fmt(intervalBase)}{cadence.period}
                </span>
              )}
              <span className="customer-preview-serif text-[58px] leading-none font-medium text-[#1B2C5B]">
                {fmt(intervalTotal)}
              </span>
              <span className="text-24 font-medium text-[#6B7280]">{cadence.period}</span>
              <span className="inline-block px-3 py-1 rounded-sm bg-[#EEF2FF] text-[#1B2C5B] text-12 font-bold tracking-[0.02em]">
                WaveGuard {waveGuardTier}
              </span>
            </div>
            {intervalSavings > 0 && (
              <div className="text-14 text-[#16A34A] font-bold mt-2">
                You save {fmt(intervalSavings)}{cadence.period} with WaveGuard {waveGuardTier}
              </div>
            )}
            {dayPrice > 0 && (
              <div className="text-14 text-[#6B7280] mt-2">
                That's just {fmt(dayPrice)}/day for complete home protection.
              </div>
            )}
            {firstVisitFees.map((fee) => (
              <div
                key={`${fee.service}-${fee.price}`}
                className="mt-3 max-w-[520px] p-3.5 rounded-[10px] bg-white border border-[#D4CBB8]"
              >
                <div className="text-14 font-bold text-[#1B2C5B]">
                  + {fmtInt(fee.price)} one-time {fee.name}
                </div>
                {fee.detail && (
                  <div className="text-12 text-[#6B7280] mt-0.5">{fee.detail}</div>
                )}
                {fee.waivedWithPrepay && (
                  <div className="text-12 text-[#6B7280] mt-0.5">
                    Waived when the customer pays the year in full up front.
                  </div>
                )}
              </div>
            ))}
            <div className="text-13 text-[#1B2C5B] mt-3">
              Try us risk-free — 90-day money-back guarantee.
            </div>
          </div>
        ) : oneTimeStandaloneTotal > 0 ? (
          <div className="pt-5 pb-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="customer-preview-serif text-[58px] leading-none font-medium text-[#1B2C5B]">
                {fmt(oneTimeStandaloneTotal)}
              </span>
              <span className="text-24 font-medium text-[#6B7280]">one-time</span>
            </div>
            <div className="text-14 text-[#6B7280] mt-2">
              One visit, pay on service day. No recurring schedule.
            </div>
          </div>
        ) : null}

        {hasOneTimeChoice && (
          <div className="bg-white rounded-[14px] border border-[#E7E2D7] p-5 mt-4">
            <div className="text-11 uppercase tracking-[0.12em] font-bold text-[#6B7280] mb-1">
              {oneTimeChoiceMeta.oneTimeLabel}
            </div>
            <div className="flex items-baseline gap-2 flex-wrap">
              <span className="customer-preview-serif text-[42px] leading-none font-medium text-[#1B2C5B]">
                {fmt(oneTimeChoiceAmount)}
              </span>
              <span className="text-20 font-medium text-[#6B7280]">one-time</span>
            </div>
            <div className="text-14 text-[#6B7280] mt-2">
              {oneTimeChoiceMeta.description}
            </div>
            {oneTimeChoiceRows.length > 0 && (
              <div className="divide-y divide-[#E7E2D7] mt-4">
                {oneTimeChoiceRows.map((item) => (
                  <div key={`${item.name}-${item.price}`} className="flex justify-between gap-4 py-2 text-14">
                    <div className="text-[#3F4A65]">
                      <div>{item.name}</div>
                      {item.detail && <div className="text-12 text-[#6B7280] mt-0.5">{item.detail}</div>}
                    </div>
                    <div className={cn("font-semibold u-nums", item.price < 0 ? "text-[#16A34A]" : "text-[#1B2C5B]")}>
                      {previewLineAmount(item.price)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {(satelliteUrl || aiMetrics.length > 0) && (
          <div className="bg-white rounded-[14px] border border-[#E7E2D7] p-5 mt-4">
            <div className="text-11 uppercase tracking-[0.12em] font-bold text-[#6B7280] mb-1">
              Waves AI analysis
            </div>
            <div className="customer-preview-serif text-24 leading-tight text-[#1B2C5B] mb-2">
              Here's what we found at your property
            </div>
            {satelliteUrl && (
              <img
                src={satelliteUrl}
                alt="Satellite view"
                className="w-full max-h-64 object-cover rounded-[10px] border border-[#E7E2D7] mb-3"
              />
            )}
            {aiMetrics.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {aiMetrics.map((metric) => (
                  <div key={metric.label} className="bg-[#F7F5EE] border border-[#E7E2D7] rounded-[10px] px-3 py-2">
                    <div className="text-10 uppercase tracking-[0.08em] text-[#6B7280] font-bold">
                      {metric.label}
                    </div>
                    <div className="customer-preview-serif text-18 text-[#1B2C5B] capitalize">
                      {metric.value}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {!presentMode && (
          <div className="bg-white rounded-[14px] border border-[#E7E2D7] p-5 mt-4">
            <div className="customer-preview-serif text-24 leading-tight text-[#1B2C5B] mb-3">
              Find a date &amp; time that works for you
            </div>
            <div className="text-14 text-[#6B7280] leading-relaxed mb-4">
              These are the route windows customers see after opening their secure estimate link.
            </div>
            <div className="bg-[#F7F5EE] border border-dashed border-[#D4CBB8] rounded-[10px] p-4 text-center text-13 text-[#6B7280]">
              Live route availability loads on the public estimate.
            </div>
          </div>
        )}

        {oneTimeRows.length > 0 && !hasOneTimeChoice && (
          <div className="bg-white rounded-[14px] border border-[#E7E2D7] p-5 mt-4">
            <div className="text-15 font-bold text-[#1B2C5B] mb-2">
              One-time items billed separately
            </div>
            <div className="divide-y divide-[#E7E2D7]">
              {oneTimeRows.map((item) => (
                <div key={`${item.name}-${item.price}`} className="flex justify-between gap-4 py-2 text-14">
                  <div className="text-[#3F4A65]">
                    <div>{item.name}</div>
                    {item.detail && <div className="text-12 text-[#6B7280] mt-0.5">{item.detail}</div>}
                  </div>
                  <div className={cn("font-semibold u-nums", item.price < 0 ? "text-[#16A34A]" : "text-[#1B2C5B]")}>
                    {previewLineAmount(item.price)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {monthlyTotal > 0 && (
          <div className="bg-white rounded-[14px] border border-[#E7E2D7] p-5 mt-4">
            <div className="customer-preview-serif text-24 leading-tight text-[#1B2C5B] mb-3">
              What WaveGuard members get
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-4 gap-y-2">
              {CUSTOMER_PREVIEW_PERKS.map((perk) => (
                <div key={perk} className="text-14 text-[#3F4A65] flex gap-2">
                  <span className="text-[#16A34A] font-bold">✓</span>
                  <span>{perk}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="bg-[#1B2C5B] text-white text-center rounded-[14px] border border-[#1B2C5B] p-6 mt-4">
          <div className="customer-preview-serif text-26 leading-tight">
            Go Waves!
          </div>
          <div className="customer-preview-serif text-20 leading-tight text-white/90 mt-1">
            Wave Goodbye to Pests!
          </div>
          <div className="text-14 text-white/80 mt-2">No surprise increases, no hidden fees.</div>
          {!presentMode && (
            <div className="inline-flex mt-4 px-5 py-3 rounded-[10px] bg-white text-[#1B2C5B] text-15 font-semibold">
              Pick a time and book
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT — EstimateToolViewV2
// State, refs, effects, callbacks all copied verbatim from V1.
// ═══════════════════════════════════════════════════════════════
export default function EstimateToolViewV2({
  initialLeadId = "",
  initialCustomerId = "",
  initialAddress = "",
  initialCustomerName = "",
  initialCustomerPhone = "",
  initialCustomerEmail = "",
  initialServiceInterest = "",
} = {}) {
  // ── Google Maps script (verbatim from V1) ─────────────────────
  const addressRef = useRef(null);
  const autocompleteRef = useRef(null);

  useEffect(() => {
    const apiKey = import.meta.env.VITE_GOOGLE_MAPS_API_KEY || "";
    if (!apiKey) return;

    if (!document.getElementById("pac-dark-style")) {
      const style = document.createElement("style");
      style.id = "pac-dark-style";
      style.textContent = `
        .pac-container { background: #FFFFFF !important; border: 1px solid #E4E4E7 !important; border-radius: 4px !important; margin-top: 4px !important; z-index: 99999 !important; font-family: 'Roboto', Arial, sans-serif !important; box-shadow: 0 8px 24px rgba(0,0,0,0.1) !important; }
        .pac-item { padding: 8px 12px !important; border-top: 1px solid #E4E4E7 !important; color: #3F3F46 !important; cursor: pointer !important; font-size: 14px !important; }
        .pac-item:first-child { border-top: none !important; }
        .pac-item:hover, .pac-item-selected { background: #FAFAFA !important; }
        .pac-item-query { color: #18181B !important; font-weight: 500 !important; }
        .pac-matched { color: #18181B !important; font-weight: 500 !important; }
        .pac-icon { display: none !important; }
        .pac-item span { color: #71717A !important; }
        .pac-item-query span { color: #18181B !important; }
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function initAutocomplete() {
    if (!addressRef.current || !window.google?.maps?.places) return;
    if (autocompleteRef.current) return;
    const ac = new window.google.maps.places.Autocomplete(addressRef.current, {
      types: ["address"],
      componentRestrictions: { country: "us" },
      fields: ["formatted_address", "address_components", "geometry"],
    });
    ac.addListener("place_changed", () => {
      const p = ac.getPlace();
      if (p && p.formatted_address) {
        setForm((f) => ({
          ...f,
          address: p.formatted_address,
          measuredTurfSf: "",
        }));
      }
    });
    autocompleteRef.current = ac;
  }

  // ── form state (verbatim from V1) ─────────────────────────────
  const [form, setForm] = useState({
    leadId: initialLeadId || "",
    customerId: initialCustomerId || "",
    address: initialAddress || "",
    customerName: initialCustomerName || "",
    customerPhone: initialCustomerPhone || "",
    customerEmail: initialCustomerEmail || "",
    leadServiceInterest: initialServiceInterest || "",
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
    palmAppsPerYear: "1",
    palmIntervalMonths: "",
    palmCustomPricePerPalm: "",
    palmHighDose: false,
    palmLargeDiameter: false,
    palmNonstandardProduct: false,
    palmDiagnosisConfirmed: false,
    palmSelectedProduct: "PHOSPHO-Jet",
    palmStatus: "healthy_preventive",
    palmDbhInches: "",
    palmProduct: "Tree-Age G-4",
    palmLicensedApplicator: false,
    treeCount: "",
    roachModifier: "NONE",
    lawnFreq: "9",
    measuredTurfSf: "",
    pestFreq: "4",
    plugArea: "",
    plugSpacing: "12",
    topDressArea: "",
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
    mosquitoProgram: "monthly12",
    mosquitoStationCount: "0",
    mosquitoDunkCount: "0",
    otLawnType: "FERT",
    exclStandardWireMesh: "0",
    exclAdvancedWireMesh: "0",
    exclStandardBirdBox: "0",
    exclTileHighBirdBox: "0",
    exclCustomBirdBox: "0",
    exclMeshSoftLF: "0",
    exclMeshConcreteLF: "0",
    exclWaive: "NO",
    rodentTrappingPlan: "standard",
    rodentTrappingEmergency: false,
    callbacksUsed: "0",
    extraCallbackCount: "0",
    upgradeToUnlimited: false,
    sanitationTier: "standard",
    sanitationArea: "",
    sanitationDebris: "0",
    sanitationAccess: "normal",
    bedbugRooms: "1",
    bedbugMethod: "CHEMICAL",
    bedbugSeverity: "light",
    germanRoachSeverity: "light",
    bedbugPrepStatus: "ready",
    bedbugOccupancyType: "singleFamily",
    bedbugEquipment: "INHOUSE",
    bedbugHeatScope: "ROOMS_ONLY",
    bedbugSubcontractCost: "",
    boracareSqft: "",
    boracareSurfaceLinearFt: "",
    boracareSurfaceHeightFt: "",
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
    foamPoints: "5",
    foamRecurringPoints: "5",
    foamRecurringFreq: "quarterly",
    roachType: "REGULAR",
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
    svcTrapOnlyRetainer: false,
    trapOnlyRetainerPlan: "standard",
    trapOnlyRetainerBilling: "annual",
    trapOnlyResponseCallbacksUsed: "0",
    trapOnlyExtraCallbackCount: "0",
    trapOnlyAttachedToCompletedTrappingJob: false,
    svcRodentWireMesh: false,
    meshLinearFeet: "",
    meshSubstrate: "wood_soft",
    meshMeasuredOrEstimated: "estimated",
    svcRodentBirdBox: false,
    birdBoxType: "standard_bird_box",
    birdBoxQuantity: "1",
    svcRodentSanitation: false,
    svcFlea: false,
    fleaOfferKey: "flea_elimination_two_visit",
    fleaComplexity: "light",
    fleaExteriorSourceSuspected: false,
    svcFleaExterior: false,
    fleaExteriorAreaSqFt: "0",
    fleaExteriorAreaSource: "UNKNOWN",
    fleaExteriorZones: [],
    svcWasp: false,
    svcRoach: false,
    svcBedbug: false,
    svcExclusion: false,
    showOneTimeOption: false,
    billByInvoice: false,
  });

  useEffect(() => {
    const incoming = {
      leadId: initialLeadId,
      customerId: initialCustomerId,
      address: initialAddress,
      customerName: initialCustomerName,
      customerPhone: initialCustomerPhone,
      customerEmail: initialCustomerEmail,
      leadServiceInterest: initialServiceInterest,
    };
    if (!Object.values(incoming).some(Boolean)) return;
    setForm((f) => {
      const next = { ...f };
      let prefillIdentityChanged = false;
      for (const [key, value] of Object.entries(incoming)) {
        if (value) {
          if (f[key] !== value && key !== "leadServiceInterest") {
            prefillIdentityChanged = true;
          }
          next[key] = value;
        }
      }
      if (prefillIdentityChanged) next.measuredTurfSf = "";
      return next;
    });
  }, [
    initialAddress,
    initialCustomerEmail,
    initialCustomerId,
    initialCustomerName,
    initialCustomerPhone,
    initialLeadId,
    initialServiceInterest,
  ]);

  // ── live preview (verbatim from V1) ───────────────────────────
  const livePreview = useMemo(() => {
    const commercialDetected = isCommercialEstimateInput(form);
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
    //   • lawn / tree → lot-derivable turf/bed, always auto-price.
    //   • pest / termite-bait / rodent-bait → need a real BUILDING footprint
    //     (else the pricer returns a quoteRequired manual line).
    //   • mosquito → needs a real LOT (treatable outdoor area).
    // Without this the sidebar would call a selection "ready as recurring" when
    // Generate Estimate will actually produce a manual quote.
    const hasCommercialBuildingSize =
      Number(form.homeSqFt) > 0 ||
      Number(form.termiteFootprintSqFt) > 0 ||
      Number(form.termitePerimeterLF) > 0;
    const hasCommercialLotSize = Number(form.lotSqFt) > 0;
    const commercialKeyFallsToManual = (k) => {
      if (k === "svcMosquito") return !hasCommercialLotSize;
      if (k === "svcPest" || k === "svcTermiteBait" || k === "svcRodentBait")
        return !hasCommercialBuildingSize;
      return false; // lawn / tree are lot-derivable and always auto-price
    };
    const commercialAutoPricedCount = commercialDetected
      ? commercialAutoKeys.filter((k) => form[k] && !commercialKeyFallsToManual(k)).length
      : 0;
    const commercialManualQuoteCount = commercialDetected
      ? commercialAutoKeys.filter((k) => form[k] && commercialKeyFallsToManual(k)).length
      : 0;
    // Commercial lines are FLAT / non-WaveGuard (excludeFromPctDiscount) — they
    // NEVER count toward the WaveGuard bundle tier or its % discount. So for a
    // commercial estimate the WaveGuard recurringCount is 0 and the preview shows
    // a commercial non-member state, not a fake multi-service bundle discount.
    const recurringCount = commercialDetected
      ? 0
      : qualifyingRecurringKeys.filter((k) => form[k]).length;
    // For commercial, rodent-bait (a separate-recurring key) is now a commercial
    // auto-priced line counted above — don't double-count it here.
    const separateRecurringCount = separateRecurringKeys
      .filter((k) => form[k] && !(commercialDetected && commercialAutoKeys.includes(k)))
      .length;

    const tierMap = {
      0: { name: "No recurring bundle", discount: 0 },
      1: { name: "1-service bundle", discount: 0 },
      2: { name: "2-service bundle", discount: 0.1 },
      3: { name: "3-service bundle", discount: 0.15 },
    };
    const tier = commercialDetected
      ? { name: "Commercial — flat pricing (non-member)", discount: 0 }
      : recurringCount >= 4
        ? { name: "4-service bundle", discount: 0.2 }
        : tierMap[recurringCount] || tierMap[0];

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
        const pricePerPalm = form.palmTreatmentType === "nutrition" ? 35 : 75;
        const appsPerYear = form.palmTreatmentType === "nutrition" ? (parsePositiveInteger(form.palmAppsPerYear) || 1) : 2;
        approx.injection = Math.round(
          (Math.max(treatmentCount * pricePerPalm, 75) * appsPerYear) / 12,
        );
      }
    }
    if (form.svcMosquito && !commercialDetected) {
      const programBase =
        form.mosquitoProgram === "seasonal9" ? 105 : 90;
      approx.mosquito = Math.max(
        programBase,
        Math.round(lotSqft * 0.005 + programBase),
      );
    }
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
      "svcRodentSanitation",
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
      // totalRecurringCount includes services like Palm Injection /
      // Rodent Bait (and commercial auto-priced lines) that don't count toward
      // the WaveGuard tier but are still recurring selections — display surfaces
      // use this to avoid claiming "0 recurring selected" when only a
      // non-qualifying service is chosen. Tier-discount math still keys off
      // recurringCount alone.
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
  const [savedViewUrl, setSavedViewUrl] = useState(null);
  // Full-screen, pricing-only "present to customer" mode — hides the booking
  // section + book CTA so the operator can show prices in person (issue: in-person
  // billing display). Reuses CustomerEstimatePreviewV2 with presentMode=true.
  const [presentMode, setPresentMode] = useState(false);
  // Set when the server-authoritative price (Decision #2) differs from the
  // client preview at save time, so the operator isn't left quoting a stale number.
  const [priceRecomputeNotice, setPriceRecomputeNotice] = useState(null);
  const [lookupStatus, setLookupStatus] = useState({ type: "", msg: "" });
  const [customerSearch, setCustomerSearch] = useState("");
  const [customers, setCustomers] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const [showSendForm, setShowSendForm] = useState(false);
  const [sendSearch, setSendSearch] = useState("");
  const [sendCustomerResults, setSendCustomerResults] = useState([]);
  const token = localStorage.getItem("waves_admin_token");
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  const set = useCallback((key, val) => {
    setForm((f) => {
      const next = {
        ...f,
        [key]: val,
        ...(key === "preslabJobContext" ? { _preslabJobContextEdited: true } : {}),
        ...(key === "preslabVolume" && !f._preslabJobContextEdited
          ? { preslabJobContext: String(val || "NONE").toUpperCase() === "NONE" ? "standalone" : "builderBatch" }
          : {}),
        ...(key === "address" ? { measuredTurfSf: "" } : {}),
        ...(key === "poolCageSize" ? { _poolCageSizeEdited: true } : {}),
        ...(key === "stories" ? { _storiesEdited: true } : {}),
        ...(key === "termiteFootprintSqFt" ? { _termiteFootprintAuto: false } : {}),
      };
      if (key === "palmCount" && String(f.palmTreatmentCount || "").trim() === "") {
        next.palmTreatmentCount = val;
      }
      return next;
    });
    if (SEND_FIELDS.has(key)) return;
    if (CONTACT_FIELDS.has(key) || DELIVERY_OPTION_FIELDS.has(key)) {
      setSavedId(null);
      setSavedViewUrl(null);
      return;
    }
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
  }, []);
  const toggle = useCallback((key) => {
    setForm((f) => {
      const next = { ...f, [key]: !f[key] };
      if (key === "svcFlea" && f.svcFlea) {
        next.svcFleaExterior = false;
      }
      if (key === "svcInjection" && !f.svcInjection && String(f.palmTreatmentCount || "").trim() === "") {
        next.palmTreatmentCount = f.palmCount || "";
      }
      // Auto-enable "Offer one-time option" only when the bundle is pest-only
      // (svcPest + svcOnetimePest with no other recurring service selected) —
      // that's the single flow the public estimate + accept handler actually
      // support without dropping other recurring services from the persisted
      // total (server/routes/estimate-public.js treats show_one_time_option
      // as a pest-only choice path).
      const OTHER_RECURRING_KEYS = [
        "svcLawn", "svcTs", "svcInjection", "svcMosquito",
        "svcTermiteBait", "svcRodentBait",
      ];
      const pestBoth = next.svcPest && next.svcOnetimePest;
      const onlyPestRecurring = OTHER_RECURRING_KEYS.every((k) => !next[k]);
      // _autoOneTimeOwned marks the flag as "owned by the auto-enable
      // path" so we can safely flip it back when the bundle stops being
      // pest-only — without clobbering a manual customer-options check
      // (which clears _autoOneTimeOwned in setCustomerChoiceOption).
      if (pestBoth && onlyPestRecurring) {
        next.showOneTimeOption = true;
        next._autoOneTimeOwned = true;
      } else if (f._autoOneTimeOwned) {
        next.showOneTimeOption = false;
        next._autoOneTimeOwned = false;
      }
      return next;
    });
    if (key.startsWith("svc") || DETHATCHING_ESTIMATE_RESET_FIELDS.has(key)) {
      setEstimate(null);
      setSavedId(null);
      setSavedViewUrl(null);
    }
  }, []);
  const setCustomerChoiceOption = useCallback((enabled) => {
    setForm((f) => {
      // Manual customer-options checkbox — own the flag, don't let
      // toggle()'s auto-clear wipe it on the next service toggle.
      return { ...f, showOneTimeOption: enabled, _autoOneTimeOwned: false };
    });
    setSavedId(null);
    setSavedViewUrl(null);
    setEstimate(null);
  }, []);

  const mosquitoRecommendations = useMemo(
    () => buildMosquitoRecommendations(form),
    [form],
  );
  const applyMosquitoRecommendation = useCallback((recommendation) => {
    setForm((f) => ({ ...f, ...(recommendation?.apply || {}) }));
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
  }, []);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Prefill bait-station footprint from house sqft, but keep BoraCare and
  // Pre-Slab manual because those measurements often are not property-record values.
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const t = setTimeout(() => searchCustomers(customerSearch), 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [customerSearch]);

  const [enrichedProfile, setEnrichedProfile] = useState(null);
  const [existingCustomerMatch, setExistingCustomerMatch] = useState(null);
  const [satelliteStatus, setSatelliteStatus] = useState({ type: "", msg: "" });
  const [satelliteData, setSatelliteData] = useState(null);
  // "" | "saving" | "saved" | "error" — Save-verified action in the
  // field-verify nudge block (persists the edited dimensions as tech-verified
  // overrides so future lookups of this address stop re-flagging them).
  const [verifySaveState, setVerifySaveState] = useState("");

  // A "saved" badge only describes the values it was clicked for — moving to
  // another address or editing sqft/lot/stories re-arms the action.
  useEffect(() => {
    setVerifySaveState("");
  }, [form.address, form.homeSqFt, form.lotSqFt, form.stories]);

  const saveVerifiedValues = useCallback(async () => {
    const fields = {};
    if (String(form.homeSqFt || "").trim() !== "") fields.squareFootage = Number(form.homeSqFt);
    if (String(form.lotSqFt || "").trim() !== "") fields.lotSize = Number(form.lotSqFt);
    if (String(form.stories || "").trim() !== "") fields.stories = Number(form.stories);
    if (!form.address || !Object.keys(fields).length) return;
    setVerifySaveState("saving");
    try {
      const r = await fetch("/api/admin/estimator/property-lookup/verify", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ address: form.address, fields }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setVerifySaveState("saved");
    } catch {
      setVerifySaveState("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [form.address, form.homeSqFt, form.lotSqFt, form.stories]);

  const resolveFleaExteriorDefault = useCallback((currentForm = form) => {
    const currentArea = parseNonNegativeInteger(currentForm.fleaExteriorAreaSqFt);
    const currentSource = currentForm.fleaExteriorAreaSource || "UNKNOWN";
    if (currentArea !== null && currentArea > 0 && currentSource !== "UNKNOWN") {
      return { area: currentArea, source: currentSource };
    }

    const confirmedExterior =
      parseNonNegativeInteger(enrichedProfile?.confirmedExteriorFleaAreaSqFt) ??
      parseNonNegativeInteger(satelliteData?.confirmedExteriorFleaAreaSqFt);
    if (confirmedExterior !== null && confirmedExterior > 0) {
      return { area: confirmedExterior, source: "CONFIRMED_SQ_FT" };
    }

    const manual = currentSource === "MANUAL_OVERRIDE" ? currentArea : null;
    if (manual !== null && manual > 0) {
      return { area: manual, source: "MANUAL_OVERRIDE" };
    }

    const measured =
      parseNonNegativeInteger(currentForm.measuredTurfSf) ??
      parseNonNegativeInteger(enrichedProfile?.measuredTurfSf);
    if (measured !== null && measured > 0) {
      return { area: measured, source: "MEASURED_TURF" };
    }

    const ai =
      parseNonNegativeInteger(enrichedProfile?.estimatedTurfSf) ??
      parseNonNegativeInteger(satelliteData?.estimatedTurfSf);
    if (ai !== null && ai > 0) {
      return { area: ai, source: "AI_ESTIMATE" };
    }

    return { area: 0, source: "UNKNOWN" };
  }, [enrichedProfile, form, satelliteData]);

  const setFleaExteriorEnabled = useCallback((enabled) => {
    setForm((f) => {
      const next = {
        ...f,
        svcFlea: enabled ? true : f.svcFlea,
        svcFleaExterior: enabled,
      };
      if (enabled) {
        const resolved = resolveFleaExteriorDefault(f);
        next.fleaExteriorAreaSqFt = String(resolved.area);
        next.fleaExteriorAreaSource = resolved.source;
      }
      return next;
    });
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
  }, [resolveFleaExteriorDefault]);

  const setFleaExteriorZone = useCallback((zone, checked) => {
    setForm((f) => {
      const zones = new Set(Array.isArray(f.fleaExteriorZones) ? f.fleaExteriorZones : []);
      if (checked) zones.add(zone);
      else zones.delete(zone);
      return { ...f, fleaExteriorZones: Array.from(zones) };
    });
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
  }, []);

  useEffect(() => {
    const incoming = {
      leadId: initialLeadId,
      customerId: initialCustomerId,
      address: initialAddress,
      customerName: initialCustomerName,
      customerPhone: initialCustomerPhone,
      customerEmail: initialCustomerEmail,
      leadServiceInterest: initialServiceInterest,
    };
    if (!Object.values(incoming).some(Boolean)) return;
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
    setShowSendForm(false);
    setLookupStatus({ type: "", msg: "" });
    setEnrichedProfile(null);
    setExistingCustomerMatch(null);
    setSatelliteStatus({ type: "", msg: "" });
    setSatelliteData(null);
  }, [
    initialAddress,
    initialCustomerEmail,
    initialCustomerId,
    initialCustomerName,
    initialCustomerPhone,
    initialLeadId,
    initialServiceInterest,
  ]);

  const [discountPresets, setDiscountPresets] = useState([]);
  const [serviceCreditPresets, setServiceCreditPresets] = useState([]);
  const [fleaPricingConfig, setFleaPricingConfig] = useState(null);
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

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await adminFetch("/admin/pricing-config/onetime_flea");
        if (!r.ok) return;
        const row = await r.json();
        if (active) setFleaPricingConfig(row?.data || null);
      } catch {
        /* ignore */
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  function applyDiscountPreset(key) {
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
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
    setForm((f) => ({ ...f, measuredTurfSf: "" }));
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
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
      setVerifySaveState("");

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
      const termiteFootprintNumber = lookupTermiteFootprintSqFt(ep);
      if (termiteFootprintNumber) upd.termiteFootprintSqFt = String(Math.round(termiteFootprintNumber));
      const perimeterLF = ep.perimeterLF || ep.perimeterLf || ep.perimeter;
      const perimeterNumber = parsePositiveNumber(perimeterLF);
      if (perimeterNumber) upd.trenchingPerimeterLF = String(Math.round(perimeterNumber));
      const atticSqFt = ep.atticSqFt || ep.atticAreaSqFt || ep.rawWoodSqFt || ep.woodTreatmentSqFt;
      const atticNumber = parsePositiveNumber(atticSqFt);
      if (atticNumber) upd.boracareSqft = String(Math.round(atticNumber));
      const slabSqFt = ep.slabSqFt || ep.foundationSqFt || ep.buildingSlabSqFt || ep.newConstructionSlabSqFt;
      const slabNumber = parsePositiveNumber(slabSqFt);
      if (slabNumber) upd.preslabSqft = String(Math.round(slabNumber));

      setForm((f) => {
        const next = {
          ...f,
          ...upd,
          ...(termiteFootprintNumber ? { _termiteFootprintAuto: true } : {}),
          _poolCageSizeEdited: false,
          _storiesEdited: false,
        };
        if (upd.palmCount && String(f.palmTreatmentCount || "").trim() === "") {
          next.palmTreatmentCount = upd.palmCount;
        }
        return next;
      });

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
            // 'Commercial' is a flat non-member tier — exclude it so a commercial
            // customer doesn't unlock recurring-customer loyalty discounts.
            const hasActivePlan =
              match.tier && match.tier !== "null" && match.tier !== "Commercial" && match.monthlyRate > 0;
            setForm((f) => ({
              ...f,
              customerId: match.id || f.customerId || "",
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
          msg: `AI Analysis complete — Confidence: ${conf} (${ep.aiConfidence}%)${flags > 0 ? ` · ${flags} field(s) flagged` : ""}\nPest pressure: ${ep.overallPestPressure} · Water: ${ep.nearWater} · Turf: ${formatSqFt(ep.estimatedTurfSf)}`,
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
    setForm((f) => ({ ...f, measuredTurfSf: "" }));
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
      if (data.property_type || data.category) {
        Object.assign(upd, resolveLookupPropertyTypeAutofill(data.property_type, data.category));
      }
      const termiteFootprintNumber = lookupTermiteFootprintSqFt(data);
      if (termiteFootprintNumber)
        upd.termiteFootprintSqFt = String(Math.round(termiteFootprintNumber));
      const perimeterNumber = parsePositiveNumber(data.perimeter_linear_ft);
      if (perimeterNumber)
        upd.trenchingPerimeterLF = String(Math.round(perimeterNumber));
      const atticSqFt =
        data.attic_sqft ||
        data.atticSqFt ||
        data.raw_wood_sqft ||
        data.rawWoodSqFt;
      const atticNumber = parsePositiveNumber(atticSqFt);
      if (atticNumber)
        upd.boracareSqft = String(Math.round(atticNumber));
      const slabSqFt =
        data.slab_sqft ||
        data.slabSqFt ||
        data.foundation_sqft ||
        data.foundationSqFt;
      const slabNumber = parsePositiveNumber(slabSqFt);
      if (slabNumber)
        upd.preslabSqft = String(Math.round(slabNumber));

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
          ? "HIGH"
          : data.confidence === "medium"
            ? "MEDIUM"
            : "LOW";
      setSatelliteStatus({
        type: "ok",
        msg: `AI Analysis complete — Confidence: ${conf} (${data.agreementPct || "?"}% model agreement)${verify > 0 ? ` · ${verify} field(s) flagged for field verification` : ""}`,
      });
    } catch (e) {
      setSatelliteStatus({ type: "err", msg: e.message });
    }
  }

  async function doGenerate(overrides = {}) {
    if (generating) return null;
    setGenerating(true);
    try {
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
      if (form.svcTrapOnlyRetainer) selectedServices.push("TRAP_ONLY_RETAINER");
      // Legacy RODENT_WIRE_MESH / RODENT_BIRD_BOX — folded into EXCLUSION V2
      if (form.svcRodentSanitation) selectedServices.push("RODENT_SANITATION");
      if (form.svcFlea || form.svcFleaExterior) selectedServices.push("FLEA");
      if (form.svcWasp) selectedServices.push("STING");
      if (form.svcRoach) selectedServices.push("ROACH");
      if (form.svcBedbug) selectedServices.push("BEDBUG");
      if (form.svcExclusion) selectedServices.push("EXCLUSION");

      const manualDiscountType =
        overrides.manualDiscountType ?? form.manualDiscountType;
      const manualDiscountValue =
        Number(overrides.manualDiscountValue ?? form.manualDiscountValue) || 0;
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
      const formIsCommercial = isCommercialEstimateInput(form);
      const termiteFootprintSqFt = parsePositiveNumber(form.termiteFootprintSqFt);
      const termitePerimeterLF = parsePositiveNumber(form.termitePerimeterLF);
      const trenchingPerimeterLF = parsePositiveNumber(form.trenchingPerimeterLF);
      const trenchingConcreteLF = parseNonNegativeNumber(form.trenchingConcreteLF);
      const trenchingDirtLF = parseNonNegativeNumber(form.trenchingDirtLF);
      const trenchingConcretePct = parseNonNegativeNumber(form.trenchingConcretePct);
      const boracareSqft = parsePositiveNumber(form.boracareSqft);
      // Send raw (trimmed) Bora-Care measurements rather than parsed numbers: a
      // present-but-invalid entry (e.g. "-5") must reach the engine so its
      // invalid-measurement review path runs instead of being silently dropped.
      const boracareSqftRaw = String(form.boracareSqft ?? "").trim() || undefined;
      const boracareSurfaceLinearFt = String(form.boracareSurfaceLinearFt ?? "").trim() || undefined;
      const boracareSurfaceHeightFt = String(form.boracareSurfaceHeightFt ?? "").trim() || undefined;
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
        lawnFreq: parseInt(overrides.lawnFreq ?? form.lawnFreq, 10) || 9,
        pestFreq: parseInt(overrides.pestFreq ?? form.pestFreq, 10) || 4,
        manualDiscount,
        serviceSpecificDiscounts,
        roachModifier: form.roachModifier || "NONE",
        recurringRoachType: form.roachModifier || "NONE",
        mosquitoProgram: form.mosquitoProgram || "monthly12",
        mosquitoStationCount: parseInt(form.mosquitoStationCount, 10) || 0,
        mosquitoDunkCount: parseInt(form.mosquitoDunkCount, 10) || 0,
        urgency: form.urgency || "ROUTINE",
        afterHours: form.isAfterHours === "YES",
        recurringCustomer: form.isRecurringCustomer === "YES",
        plugArea: parseInt(form.plugArea, 10) || 0,
        plugSpacing: parseInt(form.plugSpacing, 10) || 12,
        topDressArea: Math.max(0, Math.round(Number(form.topDressArea) || 0)),
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
        boracareSqft: boracareSqftRaw,
        boracareSurfaceLinearFt,
        boracareSurfaceHeightFt,
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
        bedbugRooms: parseInt(form.bedbugRooms, 10) || 1,
        bedbugMethod: form.bedbugMethod || "CHEMICAL",
        bedbugSeverity: form.bedbugSeverity || "light",
        bedbugPrepStatus: form.bedbugPrepStatus || "ready",
        bedbugOccupancyType: form.bedbugOccupancyType || "singleFamily",
        bedbugEquipment: form.bedbugEquipment || "INHOUSE",
        bedbugHeatScope: form.bedbugHeatScope || "ROOMS_ONLY",
        bedbugSubcontractCost: form.bedbugSubcontractCost,
        exclStandardWireMesh: parseInt(form.exclStandardWireMesh, 10) || 0,
        exclAdvancedWireMesh: parseInt(form.exclAdvancedWireMesh, 10) || 0,
        exclStandardBirdBox: parseInt(form.exclStandardBirdBox, 10) || 0,
        exclTileHighBirdBox: parseInt(form.exclTileHighBirdBox, 10) || 0,
        exclCustomBirdBox: parseInt(form.exclCustomBirdBox, 10) || 0,
        exclMeshSoftLF: parseInt(form.exclMeshSoftLF, 10) || 0,
        exclMeshConcreteLF: parseInt(form.exclMeshConcreteLF, 10) || 0,
        exclWaiveInspection: form.exclWaive === "YES",
        rodentTrappingPlan: form.rodentTrappingPlan || "standard",
        rodentTrappingEmergency: !!form.rodentTrappingEmergency,
        callbacksUsed: parseInt(form.callbacksUsed, 10) || 0,
        extraCallbackCount: parseInt(form.extraCallbackCount, 10) || 0,
        upgradeToUnlimited: !!form.upgradeToUnlimited,
        trapOnlyRetainerPlan: form.trapOnlyRetainerPlan || "standard",
        trapOnlyRetainerBilling: form.trapOnlyRetainerBilling || "annual",
        trapOnlyResponseCallbacksUsed: parseInt(form.trapOnlyResponseCallbacksUsed, 10) || 0,
        trapOnlyExtraCallbackCount: parseInt(form.trapOnlyExtraCallbackCount, 10) || 0,
        trapOnlyAttachedToCompletedTrappingJob: !!form.trapOnlyAttachedToCompletedTrappingJob,
        meshLinearFeet: parseInt(form.meshLinearFeet, 10) || 0,
        meshSubstrate: form.meshSubstrate || "wood_soft",
        meshMeasuredOrEstimated: form.meshMeasuredOrEstimated || "estimated",
        birdBoxType: form.birdBoxType || "standard_bird_box",
        birdBoxQuantity: parseInt(form.birdBoxQuantity, 10) || 0,
        sanitationTier: form.sanitationTier || "standard",
        sanitationArea: parseInt(form.sanitationArea, 10) || 0,
        sanitationDebris: parseInt(form.sanitationDebris, 10) || 0,
        sanitationAccess: form.sanitationAccess || "normal",
        roachType: form.roachType || "REGULAR",
        standaloneRoachTreatment: !!form.svcRoach && form.roachType === "REGULAR",
        germanRoachCleanoutSelected: !!form.svcRoach && form.roachType === "GERMAN",
        germanRoachSeverity: form.germanRoachSeverity || "light",
        onetimeLawnType: form.otLawnType || "FERT",
        commercialPricingMode: form.commercialPricingMode || "manual_quote",
        commercialSubtype: formIsCommercial ? form.commercialSubtype || "" : "",
        fleaOfferKey: form.fleaOfferKey || "flea_elimination_two_visit",
        fleaComplexity: form.fleaComplexity || "light",
        fleaExteriorSourceSuspected: !!form.fleaExteriorSourceSuspected,
        fleaExterior: !!form.svcFleaExterior,
        fleaExteriorAreaSqFt: parseInt(form.fleaExteriorAreaSqFt, 10) || 0,
        fleaExteriorAreaSource: form.fleaExteriorAreaSource || "UNKNOWN",
        fleaExteriorZones: Array.isArray(form.fleaExteriorZones) ? form.fleaExteriorZones : [],
      };
      if (form.svcInjection) {
        options.palmInjection = {
          selected: true,
          treatmentType: form.palmTreatmentType || "combo",
          palmCount: palmTreatmentCount,
          measurements: { palmCount: palmTreatmentCount },
          palmSize: form.palmSize || "medium",
          ...(form.palmTreatmentType === "nutrition" ? { appsPerYear: parsePositiveInteger(form.palmAppsPerYear) || 1 } : {}),
          ...(form.palmTreatmentType === "fungal" ? {
            diagnosisConfirmed: !!form.palmDiagnosisConfirmed,
            selectedProduct: form.palmSelectedProduct || "PHOSPHO-Jet",
            intervalMonths: parsePositiveNumber(form.palmIntervalMonths),
          } : {}),
          ...(form.palmTreatmentType === "lethalBronzing" ? {
            palmStatus: form.palmStatus || "healthy_preventive",
          } : {}),
          ...(form.palmTreatmentType === "treeAge" ? {
            dbhInches: parsePositiveNumber(form.palmDbhInches),
            product: form.palmProduct || "Tree-Age G-4",
            licensedApplicator: !!form.palmLicensedApplicator,
          } : {}),
          ...(form.palmTreatmentType === "insecticide" || form.palmTreatmentType === "combo" ? {
            highDose: !!form.palmHighDose,
            largeDiameter: !!form.palmLargeDiameter,
            nonstandardProduct: !!form.palmNonstandardProduct,
          } : {}),
          ...(parsePositiveNumber(form.palmCustomPricePerPalm)
            ? { customPricePerPalm: parsePositiveNumber(form.palmCustomPricePerPalm) }
            : {}),
        };
      }

      const manualNumber = (value, fallback = 0) => {
        const n = parseInt(value, 10);
        return Number.isFinite(n) ? n : fallback;
      };
      const optionalNumber = (value) => {
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      };
      const baseProfile = enrichedProfile || {};
      const treeCount = manualNumber(
        form.treeCount,
        Number(baseProfile.treeCount || baseProfile.estimatedTreeCount) || 0,
      );
      const measuredTurfSf = optionalNumber(form.measuredTurfSf);
      const profile = {
        ...baseProfile,
        homeSqFt: manualNumber(
          form.homeSqFt,
          Number(baseProfile.homeSqFt || baseProfile.squareFootage) || 0,
        ),
        lotSqFt: manualNumber(form.lotSqFt, Number(baseProfile.lotSqFt) || 0),
        stories: manualNumber(form.stories, Number(baseProfile.stories) || 1),
        estimatedBedAreaSf: manualNumber(
          form.bedArea,
          Number(baseProfile.estimatedBedAreaSf) || 0,
        ),
        // Palm pricing requires an explicit positive integer. The property-level
        // count is used only as a prefill/default; the palmInjection service
        // payload below carries the number of palms treated for this line.
        ...(() => {
          const fallback = parsePositiveInteger(baseProfile.palmCount)
            ?? parsePositiveInteger(baseProfile.palmInventory?.palmCount)
            ?? parsePositiveInteger(baseProfile.estimatedPalmCount);
          const value = propertyPalmCount ?? fallback;
          return value
            ? {
                palmCount: value,
                estimatedPalmCount: value,
                palmInventory: { ...(baseProfile.palmInventory || {}), palmCount: value },
              }
            : {};
        })(),
        estimatedTreeCount: treeCount,
        treeCount,
      };
      if (measuredTurfSf !== undefined) {
        profile.measuredTurfSf = measuredTurfSf;
      } else {
        delete profile.measuredTurfSf;
      }
      if (profile.homeSqFt)
        profile.footprint = Math.round(
          profile.homeSqFt / (profile.stories || 1),
        );
      if (trenchingPerimeterLF) profile.perimeterLF = trenchingPerimeterLF;
      if (boracareSqft) {
        profile.atticSqFt = boracareSqft;
      } else if (form.svcBoracare) {
        // Surface-treatment (or attic-cleared) Bora-Care quote: don't inherit a
        // stale lookup attic value, or a surface-only job would be priced as
        // attic+surface. An invalid attic entry is still sent raw via options so
        // the server flags it for review rather than dropping it.
        delete profile.atticSqFt;
        delete profile.atticAreaSqFt;
        delete profile.rawWoodSqFt;
        delete profile.woodTreatmentSqFt;
      }
      if (preslabSqft) profile.slabSqFt = preslabSqft;
      profile.pool = form.hasPool === "YES" ? "YES" : "NO";
      profile.poolCage = form.hasPoolCage === "YES" ? "YES" : "NO";
      profile.poolCageSize =
        form.hasPoolCage === "YES" ? form.poolCageSize || "MEDIUM" : "NONE";
      profile.poolCageSizeInferred =
        !!baseProfile.poolCageSizeInferred &&
        !form._poolCageSizeEdited &&
        profile.poolCage === "YES" &&
        profile.poolCageSize === "MEDIUM";
      profile.storiesSource = form._storiesEdited
        ? "manual"
        : baseProfile.storiesSource;
      profile.hasLargeDriveway = form.hasLargeDriveway === "YES";
      profile.shrubDensity = form.shrubDensity || profile.shrubDensity;
      profile.treeDensity = form.treeDensity || profile.treeDensity;
      profile.landscapeComplexity =
        form.landscapeComplexity || profile.landscapeComplexity;
      profile.nearWater = form.nearWater === "YES" ? "YES" : "NO";
      profile.propertyType = form.propertyType || profile.propertyType;
      profile.isCommercial = formIsCommercial;
      profile.commercialSubtype = formIsCommercial ? form.commercialSubtype || null : null;

      if (!profile.homeSqFt) profile.homeSqFt = 0;
      if (!profile.lotSqFt) profile.lotSqFt = 0;
      const bedBugOnly =
        selectedServices.length === 1 && selectedServices[0] === "BEDBUG";
      const preSlabOnly =
        selectedServices.length === 1 && selectedServices[0] === "PRESLAB";
      // Bora-Care is priced from attic/raw-wood sqft or surface linear ft, not
      // the home/lot footprint, so a Bora-Care-only quote must not be gated on it.
      const boraCareOnly =
        selectedServices.length === 1 && selectedServices[0] === "BORACARE";
      // Recurring foam is priced from drill points + cadence, not home/lot size,
      // so an operator can quote it before a property lookup (or with no sqft).
      const foamRecurringOnly =
        selectedServices.length === 1 && selectedServices[0] === "FOAM_RECURRING";
      if (!bedBugOnly && !preSlabOnly && !boraCareOnly && !foamRecurringOnly && profile.homeSqFt <= 0 && profile.lotSqFt <= 0) {
        alert("Enter home sq ft or lot size.");
        return null;
      }
      const hasPricedTurfService =
        !profile.isCommercial &&
        (form.svcLawn ||
          form.svcOnetimeLawn ||
          (form.svcTopdress && !(parseInt(form.topDressArea, 10) > 0)) ||
          form.svcDethatch ||
          (form.svcPlugging && !(parseInt(form.plugArea, 10) > 0)));
      if (
        hasPricedTurfService &&
        profile.lotSqFt <= 0 &&
        !profile.estimatedTurfSf &&
        !profile.measuredTurfSf
      ) {
        alert("Enter lot size or run Property Lookup for lawn pricing.");
        return null;
      }

      const r = await fetch("/api/admin/estimator/calculate-estimate", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ profile, selectedServices, options }),
      });
      if (!r.ok)
        throw new Error(
          await summarizeEstimateResponseFailure(
            r,
            "Estimate calculation failed",
          ),
        );
      const result = await r.json();
      if (result.error) {
        alert(result.error);
        setLookupStatus((s) => ({ ...s, type: "err", msg: result.error }));
        return null;
      }

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

      // Stash the exact engine request so the server can replay it on save and
      // be the authority on the persisted price (Decision #2). This is the same
      // payload sent to /calculate-estimate above.
      result.engineRequest = { profile, selectedServices, options };
      setEstimate(result);
      setSavedId(null);
      setSavedViewUrl(null);
      setPriceRecomputeNotice(null);
      setLookupStatus((s) => ({ ...s, type: "ok" }));
      return result;
    } catch (e) {
      alert("Estimate calculation failed: " + e.message);
      return null;
    } finally {
      setGenerating(false);
    }
  }

  async function doSave() {
    if (!estimate) return null;
    const deliveryError = validateDeliveryOptions(form, estimate);
    if (deliveryError) {
      alert(deliveryError);
      return null;
    }
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
          customerName: form.customerName || "",
          customerPhone: form.customerPhone || "",
          customerEmail: form.customerEmail || "",
          leadId: form.leadId || null,
          customerId: form.customerId || existingCustomerMatch?.id || null,
          estimateData: { inputs: form, result: E, summary: estimateSummary, engineRequest: E.engineRequest || null },
          monthlyTotal,
          annualTotal: monthlyTotal * 12,
          onetimeTotal,
          waveguardTier: E.recurring?.tier || "Bronze",
          notes: form.notes || "",
          satelliteUrl: satelliteData?.imageUrl || null,
          showOneTimeOption: !!form.showOneTimeOption,
          billByInvoice: !!form.billByInvoice,
        }),
      });
      if (!r.ok)
        throw new Error(
          await summarizeEstimateResponseFailure(r, "Save failed"),
        );
      const d = await r.json();
      const id = d.id || d.estimateId;
      const viewUrl = estimatePreviewUrlFromSave(d);
      // The server recomputes the authoritative price on save. If it differs
      // from the preview, surface it so we don't quote a number the system
      // won't honor.
      const serverMonthly = Number(d.monthlyTotal);
      const serverOnetime = Number(d.onetimeTotal);
      const monthlyDiffers =
        Number.isFinite(serverMonthly) &&
        Math.abs(serverMonthly - (monthlyTotal || 0)) >= 0.5;
      const onetimeDiffers =
        Number.isFinite(serverOnetime) &&
        Math.abs(serverOnetime - (onetimeTotal || 0)) >= 0.5;
      if ((monthlyDiffers || onetimeDiffers) && d.pricingAuthority === "SERVER") {
        setPriceRecomputeNotice({
          serverMonthly: monthlyDiffers ? serverMonthly : null,
          clientMonthly: monthlyDiffers ? monthlyTotal || 0 : null,
          serverOnetime: onetimeDiffers ? serverOnetime : null,
          clientOnetime: onetimeDiffers ? onetimeTotal || 0 : null,
        });
      } else {
        setPriceRecomputeNotice(null);
      }
      setSavedId(id);
      setSavedViewUrl(viewUrl);
      return { id, viewUrl };
    } catch (e) {
      alert(e.message);
      return null;
    } finally {
      setSaving(false);
    }
  }

  async function doSend(id, method) {
    const useId = id || savedId;
    if (!useId) {
      alert("Save the estimate first.");
      return;
    }
    // Provisional guard: a low-confidence / incomplete property lookup means the
    // auto-priced quote may be wrong (the reported 0/100 new-construction case).
    // Make the operator acknowledge before a firm quote goes to the customer.
    const provisional = computeProvisionalState(enrichedProfile?.propertyDataQuality);
    if (provisional.provisional) {
      const proceed = window.confirm(
        `This estimate is based on unverified property data (${provisionalSummary(provisional)}).\n\n` +
          "Pricing may change once verified on site. Send the quote anyway?"
      );
      if (!proceed) return;
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
      if (!r.ok)
        throw new Error(summarizeEstimateSend(d) || `HTTP ${r.status}`);
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
      palmAppsPerYear: "1",
      palmIntervalMonths: "",
      palmCustomPricePerPalm: "",
      palmHighDose: false,
      palmLargeDiameter: false,
      palmNonstandardProduct: false,
      palmDiagnosisConfirmed: false,
      palmSelectedProduct: "PHOSPHO-Jet",
      palmStatus: "healthy_preventive",
      palmDbhInches: "",
      palmProduct: "Tree-Age G-4",
      palmLicensedApplicator: false,
      treeCount: "",
      measuredTurfSf: "",
      topDressArea: "",
      fleaOfferKey: "flea_elimination_two_visit",
      fleaComplexity: "light",
      fleaExteriorSourceSuspected: false,
      svcFleaExterior: false,
      fleaExteriorAreaSqFt: "0",
      fleaExteriorAreaSource: "UNKNOWN",
      fleaExteriorZones: [],
      boracareSqft: "",
      boracareSurfaceLinearFt: "",
      boracareSurfaceHeightFt: "",
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
      customerId: "",
      leadId: "",
      customerName: "",
      customerPhone: "",
      customerEmail: "",
      leadServiceInterest: "",
      _termiteFootprintAuto: false,
    }));
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
    setShowSendForm(false);
    setLookupStatus({ type: "", msg: "" });
    setEnrichedProfile(null);
    setExistingCustomerMatch(null);
    setSatelliteStatus({ type: "", msg: "" });
    setSatelliteData(null);
    setCustomerSearch("");
    setCustomers([]);
  }

  async function saveAndSend(method) {
    if (generating || saving || sending) return;
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
    const saved = savedId
      ? { id: savedId, viewUrl: savedViewUrl }
      : await doSave();
    if (saved?.id) await doSend(saved.id, method);
  }

  async function previewCustomerEstimate() {
    if (generating || saving || sending) return;
    if (!estimate) {
      alert('Click "Generate Estimate" first.');
      return;
    }

    const pendingPreviewWindow = savedViewUrl
      ? null
      : window.open("about:blank", "_blank");
    if (pendingPreviewWindow) pendingPreviewWindow.opener = null;
    if (!savedViewUrl && !pendingPreviewWindow) {
      alert("Your browser blocked the preview tab. Allow pop-ups and try again.");
      return;
    }

    const saved = savedViewUrl
      ? { id: savedId, viewUrl: savedViewUrl }
      : await doSave();
    if (!saved?.id) {
      if (pendingPreviewWindow) pendingPreviewWindow.close();
      return;
    }
    if (!saved.viewUrl) {
      if (pendingPreviewWindow) pendingPreviewWindow.close();
      alert("Preview link unavailable. Save the estimate and try again.");
      return;
    }
    if (pendingPreviewWindow) {
      pendingPreviewWindow.location.replace(saved.viewUrl);
    } else {
      window.open(saved.viewUrl, "_blank", "noopener,noreferrer");
    }
  }

  const E = estimate;
  const commercialDetected = isCommercialEstimateInput(form);
  const R = E?.results || {};
  const aiTurfSqFt =
    parseNonNegativeInteger(enrichedProfile?.estimatedTurfSf) ??
    parseNonNegativeInteger(satelliteData?.estimatedTurfSf) ??
    null;
  const confirmedTurfSqFt = parseNonNegativeInteger(form.measuredTurfSf);
  const lotSqFtForTurf =
    parseNonNegativeInteger(form.lotSqFt) ??
    parseNonNegativeInteger(enrichedProfile?.lotSqFt) ??
    0;
  const lotEstimateTurfSqFt = (() => {
    if (lotSqFtForTurf <= 0) return null;
    const pct = parseNonNegativeNumber(enrichedProfile?.imperviousSurfacePercent) ?? 20;
    const open = Math.round(lotSqFtForTurf * (1 - Math.min(1, pct / 100)));
    const bedPct = parseNonNegativeNumber(enrichedProfile?.estimatedBedAreaPercent);
    const explicitBed = parseNonNegativeNumber(form.bedArea) ?? parseNonNegativeNumber(enrichedProfile?.estimatedBedAreaSf);
    const beds = bedPct !== undefined
      ? Math.round(open * (bedPct / 100))
      : (explicitBed !== undefined ? explicitBed : Math.round(open * 0.15));
    return Math.max(0, open - beds);
  })();
  const effectiveTurfSqFt =
    confirmedTurfSqFt ?? (aiTurfSqFt > 0 ? aiTurfSqFt : null) ?? lotEstimateTurfSqFt ?? 0;
  const turfDisplaySource =
    confirmedTurfSqFt !== null ? "Confirmed" :
    aiTurfSqFt > 0 ? "Using AI" :
    lotEstimateTurfSqFt > 0 ? "Lot estimate" : "No estimate";
  const isDethatchingStAugustine = String(form.grassType || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .includes("staugustine");
  const turfSliderMax = Math.max(
    20000,
    Math.ceil(Math.max(lotSqFtForTurf, aiTurfSqFt || 0, confirmedTurfSqFt || 0, lotEstimateTurfSqFt || 0, 5000) / 1000) * 1000,
  );
  const plugAreaSqFt = parseNonNegativeInteger(form.plugArea);
  const topDressAreaSqFt = parseNonNegativeInteger(form.topDressArea);
  const fleaExteriorAreaSqFt = parseNonNegativeInteger(form.fleaExteriorAreaSqFt) ?? 0;
  const fleaExteriorAreaSource = form.fleaExteriorAreaSource || "UNKNOWN";
  const fleaExteriorMaxSqFt =
    parseNonNegativeInteger(fleaPricingConfig?.exterior?.maxSqFt) ??
    parseNonNegativeInteger(fleaPricingConfig?.exterior?.max_sqft) ??
    20000;
  const fleaExteriorSliderMarks = [0, 2500, 5000, 10000, 15000, fleaExteriorMaxSqFt].filter(
    (value, index, marks) => value <= fleaExteriorMaxSqFt && marks.indexOf(value) === index,
  );
  const fleaExteriorPreview = getFleaExteriorPreview(
    fleaExteriorAreaSqFt,
    fleaExteriorAreaSource,
    fleaPricingConfig,
  );
  const fleaExteriorWarning = !form.svcFleaExterior
    ? null
    : fleaExteriorPreview.warning;
  const pluggingUsesTurfFallback = !!form.svcPlugging && !(plugAreaSqFt > 0);
  const topDressUsesTurfFallback = !!form.svcTopdress && !(topDressAreaSqFt > 0);
  const hasTurfPricedSelection =
    (!commercialDetected && (!!form.svcLawn || !!form.svcOnetimeLawn)) ||
    topDressUsesTurfFallback ||
    !!form.svcDethatch ||
    pluggingUsesTurfFallback;
  const needsTurfConfirmation =
    hasTurfPricedSelection &&
    confirmedTurfSqFt === null &&
    aiTurfSqFt !== null &&
    aiTurfSqFt > 20000;
  const turfReviewReasons = [
    aiTurfSqFt !== null && lotSqFtForTurf > 0 && aiTurfSqFt / lotSqFtForTurf >= 0.55
      ? `AI turf is ${Math.round((aiTurfSqFt / lotSqFtForTurf) * 100)}% of lot`
      : null,
    Number(enrichedProfile?.aiConfidence) > 0 && Number(enrichedProfile?.aiConfidence) < 60
      ? `AI confidence ${enrichedProfile.aiConfidence}%`
      : null,
    form.treeDensity === "HEAVY" ? "heavy tree canopy" : null,
    form.nearWater === "YES" ? "water adjacency" : null,
  ].filter(Boolean);
  const showTurfReview =
    hasTurfPricedSelection &&
    confirmedTurfSqFt === null &&
    aiTurfSqFt !== null &&
    turfReviewReasons.length > 0;
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
    form.svcBoracare && !parsePositiveNumber(form.boracareSqft) && !parsePositiveNumber(form.boracareSurfaceLinearFt)
      ? "Bora-Care needs attic/raw wood sqft or surface linear ft."
      : null,
    form.svcPreslab && !parsePositiveNumber(form.preslabSqft)
      ? "Pre-Slab Termiticide Treatment needs slab sqft."
      : null,
  ].filter(Boolean);
  const palmTreatmentCountForDisplay = parsePositiveInteger(form.palmTreatmentCount)
    ?? (String(form.palmTreatmentCount || "").trim() === "" ? parsePositiveInteger(form.palmCount) : undefined);
  const palmMeasurementWarning = form.svcInjection && (
    hasInvalidPositiveInteger(form.palmCount) ||
    hasInvalidPositiveInteger(form.palmTreatmentCount) ||
    !palmTreatmentCountForDisplay
  )
    ? "Palm count is required for palm injection pricing."
    : null;
  const formCtx = { form, set, toggle };
  const sendBusy = generating || saving || sending;
  const provisionalState = computeProvisionalState(
    enrichedProfile?.propertyDataQuality
  );
  // Present-mode trust gates: a custom-quote estimate has no firm price to show,
  // and an unsaved one hasn't been through the server-authoritative recompute.
  const presentQuoteRequired = !!estimate && estimateRequiresQuote(estimate);
  const presentUnsaved = !savedId;
  const generateBusy = generating || saving || sending;

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════
  return (
    <FormCtx.Provider value={formCtx}>
      {" "}
      <div
        className="max-w-[1440px] mx-auto px-4 md:px-7 pb-7 waves-roboto-scope"
        style={{ fontFamily: ROBOTO }}
      >
        {" "}
        <style>{`
          .waves-roboto-scope,
          .waves-roboto-scope * {
            font-family: ${ROBOTO} !important;
          }
          .customer-preview-scope,
          .customer-preview-scope * {
            font-family: 'Inter', system-ui, sans-serif !important;
          }
          .customer-preview-serif {
            font-family: 'Source Serif 4', Georgia, serif !important;
          }
        `}</style>{" "}
        {/* Full-screen pricing-only present mode — show prices to the customer
            in person without the booking section. Tier toggle stays live so the
            operator can switch frequency in front of the customer. */}
        {presentMode && E && (
          <div className="fixed inset-0 z-50 bg-[#FAF8F3] overflow-y-auto">
            <div className="sticky top-0 z-10 border-b border-[#E7E2D7] bg-white/95 backdrop-blur">
              <div className="flex items-center justify-between gap-4 px-4 py-2.5">
                <span className="text-11 font-medium uppercase tracking-[0.1em] text-[#6B7280]">
                  Presenting to customer · pricing only
                </span>
                <Button
                  variant="secondary"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => setPresentMode(false)}
                >
                  <X size={14} strokeWidth={1.8} aria-hidden />
                  Exit
                </Button>
              </div>
              {/* Operator-facing warning strip — reasons the shown price may not be
                  firm. Suppressed for custom quotes, which show no firm price at all. */}
              {!presentQuoteRequired && priceRecomputeNotice && (
                <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-12 text-ink-secondary">
                  Final price was server-recomputed on save
                  {priceRecomputeNotice.serverMonthly != null && (
                    <> — bills ${priceRecomputeNotice.serverMonthly.toFixed(2)}/mo (preview shows ${Number(priceRecomputeNotice.clientMonthly || 0).toFixed(2)})</>
                  )}
                  {priceRecomputeNotice.serverOnetime != null && (
                    <> — ${priceRecomputeNotice.serverOnetime.toFixed(2)} one-time</>
                  )}
                  . Re-generate before quoting this price.
                </div>
              )}
              {!presentQuoteRequired && provisionalState.provisional && (
                <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-12 text-ink-secondary">
                  Provisional — based on unverified property data ({provisionalSummary(provisionalState)}). Price may change after field verification.
                </div>
              )}
              {!presentQuoteRequired && presentUnsaved && (
                <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-2 text-12 text-ink-secondary">
                  Unsaved preview — save the estimate to lock the server-authoritative price before quoting it as final.
                </div>
              )}
            </div>
            <div className="mx-auto max-w-[760px] px-3 py-5 md:px-5">
              {presentQuoteRequired ? (
                // Custom-quote estimate: no firm price to present (the saved/public
                // flow zeroes totals and the link won't honor a partial price).
                <div className="customer-preview-scope rounded-[14px] border border-[#E7E2D7] bg-white p-8 text-center">
                  <div className="customer-preview-serif text-[28px] leading-tight text-[#1B2C5B] mb-3">
                    This is a custom quote
                  </div>
                  <div className="mx-auto max-w-[460px] text-15 leading-relaxed text-[#6B7280]">
                    The services selected need an on-site inspection before we can set a firm
                    price, so there's no final number to show here yet. We'll prepare a detailed
                    quote and send it over.
                  </div>
                </div>
              ) : (
                <div className="relative">
                  {/* Mask the preview while regenerating so the customer never sees the
                      newly-selected cadence paired with the previous tier's price. */}
                  {generating && (
                    <div className="absolute inset-0 z-10 flex items-start justify-center bg-[#FAF8F3]/70 pt-12 backdrop-blur-[1px]">
                      <span className="rounded-full border border-[#E7E2D7] bg-white px-4 py-2 text-13 font-medium text-[#1B2C5B] shadow-sm">
                        Updating pricing…
                      </span>
                    </div>
                  )}
                  <EstimateErrorBoundary key={JSON.stringify(estimate).slice(0, 100)}>
                    <CustomerEstimatePreviewV2
                      E={E}
                      R={R}
                      form={form}
                      satelliteUrl={satelliteData?.imageUrl || null}
                      presentMode
                      onSelectPestFreq={(apps) => {
                        // Ignore tier taps while a recalc is in flight: doGenerate
                        // early-returns on `generating`, but the form mutation below
                        // would still apply, pairing the in-flight (old-tier) estimate
                        // with the new cadence and showing the customer mismatched
                        // pricing. Wait for the current generate to settle first.
                        if (generating) return;
                        // Update cadence + regenerate WITHOUT routing through set(),
                        // which nulls `estimate` and would unmount this overlay
                        // (presentMode && E) mid-presentation. doGenerate replaces the
                        // estimate in place when it resolves. Still mirror set()'s
                        // saved-state reset, since changing the cadence invalidates the
                        // saved record (keeps the "unsaved preview" warning accurate).
                        setForm((f) => ({ ...f, pestFreq: String(apps) }));
                        setSavedId(null);
                        setSavedViewUrl(null);
                        doGenerate({ pestFreq: apps });
                      }}
                    />
                  </EstimateErrorBoundary>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="grid gap-7 grid-cols-1 lg:grid-cols-[440px_1fr]">
          {/* ═══ LEFT COLUMN: FORM ═══ */}
          <div className="space-y-4">
            {/* Customer Lookup */}
            <div>
              {" "}
              <PanelTitle>Customer Lookup</PanelTitle>{" "}
              <FieldV2 label="Search customers">
                {" "}
                <input
                  type="text"
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)}
                  placeholder="Name, phone, email, or address..."
                  className={INPUT_CLS}
                />{" "}
              </FieldV2>
              {customers.length > 0 && (
                <div className="mb-3 border-hairline border-zinc-300 rounded-xs bg-white max-h-72 overflow-y-auto">
                  {customers.slice(0, 8).map((c) => {
                    const name =
                      `${c.firstName || ""} ${c.lastName || ""}`.trim() ||
                      "(no name)";
                    return (
                      <button
                        key={c.id}
                        type="button"
                        onClick={() => {
                          // 'Commercial' is a flat non-member tier — exclude it
                          // so a commercial customer doesn't unlock loyalty discounts.
                          const hasActivePlan =
                            c.tier && c.tier !== "null" && c.tier !== "Commercial" && c.monthlyRate > 0;
                          setForm((f) => ({
                            ...f,
                            customerId: c.id || "",
                            address: c.address || f.address,
                            measuredTurfSf: "",
                            customerName: name,
                            customerPhone: c.phone || f.customerPhone || "",
                            customerEmail: c.email || f.customerEmail || "",
                            isRecurringCustomer: hasActivePlan
                              ? "YES"
                              : f.isRecurringCustomer,
                          }));
                          setExistingCustomerMatch(c);
                          setCustomerSearch("");
                          setCustomers([]);
                          setEstimate(null);
                          setSavedId(null);
                          setSavedViewUrl(null);
                        }}
                        className="w-full text-left px-3 py-2 border-b-hairline border-zinc-200 last:border-b-0 hover:bg-zinc-50 cursor-pointer"
                      >
                        {" "}
                        <div className="text-14 text-zinc-900 font-medium">
                          {name}
                        </div>{" "}
                        <div className="text-12 text-ink-secondary">
                          {c.address || "no address on file"}
                          {c.phone ? ` · ${c.phone}` : ""}
                        </div>{" "}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
            {/* Property Lookup */}
            <div>
              {" "}
              <PanelTitle>Property Lookup</PanelTitle>{" "}
              <FieldV2 label="Address">
                {" "}
                <input
                  ref={addressRef}
                  type="text"
                  value={form.address}
                  onChange={(e) => set("address", e.target.value)}
                  placeholder="Start typing an address..."
                  className={INPUT_CLS}
                />{" "}
              </FieldV2>
              {form.leadServiceInterest && (
                <div className="mb-3 px-3 py-2 bg-zinc-50 border-hairline border-zinc-300 rounded-xs text-12 text-zinc-900">
                  Lead interest:{" "}
                  <strong>{form.leadServiceInterest}</strong>{" "}
                </div>
              )}
              <StatusLine status={lookupStatus} />{" "}
              <div className="grid grid-cols-2 gap-2 mb-2">
                {" "}
                <Button onClick={doLookup} variant="primary" size="md">
                  Property Lookup
                </Button>{" "}
                <Button
                  variant="secondary"
                  size="md"
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
                      palmAppsPerYear: "1",
                      palmIntervalMonths: "",
                      palmCustomPricePerPalm: "",
                      palmHighDose: false,
                      palmLargeDiameter: false,
                      palmNonstandardProduct: false,
                      palmDiagnosisConfirmed: false,
                      palmSelectedProduct: "PHOSPHO-Jet",
                      palmStatus: "healthy_preventive",
                      palmDbhInches: "",
                      palmProduct: "Tree-Age G-4",
                      palmLicensedApplicator: false,
                      treeCount: "",
                      measuredTurfSf: "",
                    }));
                    setLookupStatus({ type: "", msg: "" });
                    setEnrichedProfile(null);
                    setExistingCustomerMatch(null);
                    setSatelliteStatus({ type: "", msg: "" });
                    setSatelliteData(null);
                    setEstimate(null);
                  }}
                >
                  Clear All
                </Button>{" "}
              </div>{" "}
              <StatusLine status={satelliteStatus} />
              {enrichedProfile?.propertyDataQuality && (
                <div className="mb-2.5 px-3 py-2 bg-zinc-50 border-hairline border-zinc-300 rounded-xs">
                  {" "}
                  <div className="flex items-center justify-between gap-3 mb-1">
                    {" "}
                    <div className="text-11 font-semibold uppercase tracking-label text-ink-secondary">
                      Property Data Quality
                    </div>{" "}
                    <div
                      className={`text-11 font-semibold uppercase tracking-label ${
                        enrichedProfile.propertyDataQuality.level === "high"
                          ? "text-emerald-700"
                          : enrichedProfile.propertyDataQuality.level ===
                              "medium"
                            ? "text-amber-700"
                            : "text-alert-fg"
                      }`}
                    >
                      {enrichedProfile.propertyDataQuality.level || "unknown"} ·{" "}
                      {enrichedProfile.propertyDataQuality.score || 0}/100
                    </div>{" "}
                  </div>{" "}
                  <div className="text-12 text-ink-secondary">
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
                  </div>
                  {enrichedProfile.fieldEvidence && (
                    <div className="mt-2 grid grid-cols-2 gap-1">
                      {[
                        "squareFootage",
                        "lotSize",
                        "stories",
                        "propertyType",
                      ].map((field) => {
                        const item = enrichedProfile.fieldEvidence[field];
                        const missing = (
                          enrichedProfile.propertyDataQuality
                            ?.missingCriticalFields || []
                        ).includes(field);
                        if (!item && !missing) return null;
                        return (
                          <div
                            key={field}
                            className="text-11 text-ink-tertiary truncate"
                          >
                            {" "}
                            <span
                              className={
                                missing || item?.fieldVerify
                                  ? "text-alert-fg font-medium"
                                  : "text-emerald-700 font-medium"
                              }
                            >
                              {missing
                                ? "Missing"
                                : item.fieldVerify
                                  ? "Verify"
                                  : "Trusted"}
                            </span>{" "}
                            {field.replace(/([A-Z])/g, " $1").toLowerCase()}:{" "}
                            {item?.sourceLabel || item?.sourceType || "no source"}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
              {enrichedProfile?.fieldVerifyFlags?.length > 0 && (
                <div className="mb-2.5 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs">
                  {enrichedProfile.fieldVerifyFlags.map((flag, i) => (
                    <div key={i} className="text-12 text-alert-fg">
                      {typeof flag === "string"
                        ? flag.replace(/_/g, " ")
                        : (flag.field || flag.name || "").replace(/_/g, " ")}
                      {flag.reason ? ` — ${flag.reason}` : ""}
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={saveVerifiedValues}
                    disabled={verifySaveState === "saving" || verifySaveState === "saved"}
                    className="mt-1.5 text-12 underline text-zinc-900 disabled:no-underline disabled:text-zinc-500"
                  >
                    {verifySaveState === "saving"
                      ? "Saving verified values…"
                      : verifySaveState === "saved"
                        ? "Verified values saved — future lookups will use them"
                        : verifySaveState === "error"
                          ? "Save failed — tap to retry"
                          : "Save current sqft / lot / stories as field-verified"}
                  </button>
                </div>
              )}
              {existingCustomerMatch && (
                <div className="mb-2.5 px-3 py-2 bg-zinc-50 border-hairline border-zinc-300 rounded-xs text-12 text-zinc-900">
                  {" "}
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-900 mr-1.5 align-middle" />
                  Existing customer:{" "}
                  <strong>
                    {existingCustomerMatch.firstName}{" "}
                    {existingCustomerMatch.lastName}
                  </strong>
                  {existingCustomerMatch.tier &&
                  existingCustomerMatch.tier !== "null"
                    ? " · Recurring plan"
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
                  <div className="mb-3">
                    {" "}
                    <div className="grid grid-cols-5 gap-1 mb-2">
                      {satelliteData.microCloseUrl && (
                        <div>
                          {" "}
                          <img
                            src={satelliteData.microCloseUrl}
                            alt="Micro close"
                            className="w-full rounded-xs border border-zinc-900 aspect-square object-cover"
                          />{" "}
                          <div className="text-11 text-zinc-900 text-center mt-0.5 font-medium uppercase tracking-label">
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
                            className="w-full rounded-xs border border-zinc-900 aspect-square object-cover"
                          />{" "}
                          <div className="text-11 text-zinc-900 text-center mt-0.5 font-medium uppercase tracking-label">
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
                            className="w-full rounded-xs border-hairline border-zinc-300 aspect-square object-cover"
                          />{" "}
                          <div className="text-11 text-ink-tertiary text-center mt-0.5 uppercase tracking-label">
                            Detail
                          </div>{" "}
                        </div>
                      )}
                      <div>
                        {" "}
                        <img
                          src={satelliteData.closeUrl || satelliteData.imageUrl}
                          alt="Close view"
                          className="w-full rounded-xs border-hairline border-zinc-300 aspect-square object-cover"
                        />{" "}
                        <div className="text-11 text-ink-tertiary text-center mt-0.5 uppercase tracking-label">
                          Property
                        </div>{" "}
                      </div>
                      {satelliteData.wideUrl && (
                        <div>
                          {" "}
                          <img
                            src={satelliteData.wideUrl}
                            alt="Area view"
                            className="w-full rounded-xs border-hairline border-zinc-300 aspect-square object-cover"
                          />{" "}
                          <div className="text-11 text-ink-tertiary text-center mt-0.5 uppercase tracking-label">
                            Area
                          </div>{" "}
                        </div>
                      )}
                    </div>
                    {satelliteData.aiSources?.length > 0 && (
                      <div className="text-11 text-ink-secondary mb-1">
                        AI Analysis: {formatAiSources(satelliteData.aiSources)}{" "}
                        {satelliteData.aiSources.length > 1
                          ? "(multi-model)"
                          : ""}
                      </div>
                    )}
                    {satelliteData.aiWarnings?.length > 0 && (
                      <div className="text-11 text-alert-fg mb-1">
                        {satelliteData.aiWarnings.join(" ")}
                      </div>
                    )}
                    {satelliteData.fieldVerify?.length > 0 && (
                      <div className="text-12 text-alert-fg font-medium px-3 py-1.5 bg-alert-bg rounded-xs">
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
                      <div className="text-11 text-ink-tertiary mt-1 italic">
                        {satelliteData.notes}
                      </div>
                    )}
                  </div>
                )}
            </div>
            {/* Property Data */}
            <div>
              {" "}
              <PanelTitle>Property Data</PanelTitle>{" "}
              <FieldV2 label="Property Type">
                {" "}
                <SelectV2
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
              </FieldV2>{" "}
              <div className="grid grid-cols-2 gap-3">
                <FieldV2 label="Commercial">
                  <SelectV2
                    k="isCommercial"
                    options={[
                      { value: "NO", label: "No" },
                      { value: "YES", label: "Yes" },
                    ]}
                  />
                </FieldV2>
                <FieldV2 label="Commercial Pricing">
                  <SelectV2
                    k="commercialPricingMode"
                    options={[
                      { value: "manual_quote", label: "Manual quote" },
                      { value: "small_commercial_pilot", label: "Small-commercial pilot" },
                    ]}
                  />
                </FieldV2>
              </div>
              {(commercialDetected || form.commercialSubtype) && (
                <FieldV2 label="Commercial Subtype">
                  <InputV2 k="commercialSubtype" placeholder="Optional" />
                </FieldV2>
              )}
              {commercialDetected && (
                <div className="mb-3 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs text-12 text-alert-fg">
                  {COMMERCIAL_WARNING_TEXT}
                </div>
              )}
              <div className="grid grid-cols-2 gap-3">
                {" "}
                <FieldV2 label="Home Sq Ft">
                  <InputV2 k="homeSqFt" type="number" placeholder="2000" />
                </FieldV2>{" "}
                <FieldV2 label="Stories">
                  {" "}
                  <InputV2 k="stories" type="number" min="1" max="4" />
                  {enrichedProfile?.storiesSource === "default" && (
                    <div className="mt-1 text-11 text-alert-fg">
                      Verify stories — no data source confirmed a floor count.
                      Defaulted to 1; a 2-story home priced here would
                      under-charge.
                    </div>
                  )}
                </FieldV2>{" "}
              </div>{" "}
              <FieldV2 label="Lot Sq Ft">
                <InputV2 k="lotSqFt" type="number" placeholder="8000" />
              </FieldV2>
              {(form.svcTs || form.svcInjection) && (
                <>
                  {" "}
                  <div className="grid grid-cols-2 gap-3">
                    {" "}
                    {form.svcTs && (
                      <FieldV2 label="Bed Area (sq ft)">
                        <InputV2
                          k="bedArea"
                          type="number"
                          placeholder="Auto-estimate"
                        />
                      </FieldV2>
                    )}{" "}
                    <FieldV2 label="Palms on property">
                      <InputV2 k="palmCount" type="number" placeholder="Manual override" />
                    </FieldV2>{" "}
                  </div>{" "}
                  {form.svcTs && (
                    <FieldV2 label="Tree Count">
                      <InputV2 k="treeCount" type="number" placeholder="Auto" />
                    </FieldV2>
                  )}{" "}
                </>
              )}
            </div>
            {/* Property Features */}
            <div>
              {" "}
              <PanelTitle>Property Features</PanelTitle>{" "}
              <div className="grid grid-cols-3 gap-3">
                {" "}
                <FieldV2 label="Pool">
                  <SelectV2
                    k="hasPool"
                    options={[
                      { value: "NO", label: "No" },
                      { value: "YES", label: "Yes" },
                    ]}
                  />
                </FieldV2>{" "}
                <FieldV2 label="Pool Cage">
                  <SelectV2
                    k="hasPoolCage"
                    options={[
                      { value: "NO", label: "No" },
                      { value: "YES", label: "Yes" },
                    ]}
                  />
                </FieldV2>{" "}
                <FieldV2 label="Large Driveway">
                  <SelectV2
                    k="hasLargeDriveway"
                    options={[
                      { value: "NO", label: "No" },
                      { value: "YES", label: "Yes" },
                    ]}
                  />
                </FieldV2>{" "}
              </div>
              {form.hasPoolCage === "YES" && (
                <FieldV2 label="Pool Cage Size">
                  {" "}
                  <SelectV2
                    k="poolCageSize"
                    options={[
                      { value: "SMALL", label: "Small (+$5)" },
                      { value: "MEDIUM", label: "Medium (+$8)" },
                      { value: "LARGE", label: "Large (+$12)" },
                      { value: "OVERSIZED", label: "Oversized (+$18)" },
                    ]}
                  />{" "}
                </FieldV2>
              )}
              <div className="grid grid-cols-3 gap-3">
                {" "}
                <FieldV2 label="Shrub Density">
                  <SelectV2
                    k="shrubDensity"
                    options={[
                      { value: "LIGHT", label: "Light" },
                      { value: "MODERATE", label: "Moderate" },
                      { value: "HEAVY", label: "Heavy" },
                    ]}
                  />
                </FieldV2>{" "}
                <FieldV2 label="Tree Density">
                  <SelectV2
                    k="treeDensity"
                    options={[
                      { value: "LIGHT", label: "Light" },
                      { value: "MODERATE", label: "Moderate" },
                      { value: "HEAVY", label: "Heavy" },
                    ]}
                  />
                </FieldV2>{" "}
                <FieldV2 label="Complexity">
                  <SelectV2
                    k="landscapeComplexity"
                    options={[
                      { value: "SIMPLE", label: "Simple" },
                      { value: "MODERATE", label: "Moderate" },
                      { value: "COMPLEX", label: "Complex" },
                    ]}
                  />
                </FieldV2>{" "}
              </div>{" "}
              <div className="grid grid-cols-2 gap-3">
                {" "}
                <FieldV2 label="Near Water">
                  <SelectV2
                    k="nearWater"
                    options={[
                      { value: "NO", label: "No" },
                      { value: "YES", label: "Yes" },
                    ]}
                  />
                </FieldV2>{" "}
                <FieldV2 label="Urgency">
                  <SelectV2
                    k="urgency"
                    options={[
                      { value: "ROUTINE", label: "Routine" },
                      { value: "SOON", label: "Soon (same/next day)" },
                      { value: "URGENT", label: "Urgent (within 12 hrs)" },
                    ]}
                  />
                </FieldV2>{" "}
              </div>{" "}
              <div className="grid grid-cols-2 gap-3">
                {" "}
                <FieldV2 label="After Hours">
                  <SelectV2
                    k="isAfterHours"
                    options={[
                      { value: "NO", label: "No — business hours" },
                      {
                        value: "YES",
                        label: "Yes — evenings/weekends/holidays",
                      },
                    ]}
                  />
                </FieldV2>{" "}
                <FieldV2 label="Recurring Customer">
                  <SelectV2
                    k="isRecurringCustomer"
                    options={[
                      { value: "NO", label: "No — new customer" },
                      { value: "YES", label: "Yes — 15% off one-time" },
                    ]}
                  />
                </FieldV2>{" "}
              </div>{" "}
            </div>
            {/* Services */}
            <div>
              {" "}
              <PanelTitle>Services to Quote</PanelTitle>{" "}
              <SubGroupLabel>Recurring Programs</SubGroupLabel>{" "}
              <CheckboxV2 k="svcLawn" label="Lawn Care" />
              {form.svcLawn && commercialDetected && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200 text-12 text-zinc-600">
                  Commercial lawn treatment is auto-priced (estimated — confirmed on site). Residential lawn pricing is suppressed.
                </div>
              )}
              {form.svcLawn && !commercialDetected && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Grass Type / Track" className="mb-0">
                      {" "}
                      <SelectV2
                        k="grassType"
                        options={[
                          { value: "st_augustine", label: "St. Augustine" },
                          { value: "bermuda", label: "Bermuda" },
                          { value: "zoysia", label: "Zoysia" },
                          { value: "bahia", label: "Bahia" },
                        ]}
                      />{" "}
                    </FieldV2>
                    <FieldV2 label="Applications / year" className="mb-0">
                      <SelectV2
                        k="lawnFreq"
                        options={[
                          { value: "4", label: "4 — Quarterly" },
                          { value: "6", label: "6 — Bi-monthly" },
                          { value: "9", label: "9 — Every 6 weeks" },
                          { value: "12", label: "12 — Monthly" },
                        ]}
                      />
                    </FieldV2>
                  </div>{" "}
                </div>
              )}
              {hasTurfPricedSelection && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="text-12 font-semibold text-zinc-900">
                      Treatable Lawn Area
                    </div>
                    <Badge variant="neutral" className="text-10 u-nums">
                      {aiTurfSqFt > 0 ? `AI ${formatSqFt(aiTurfSqFt)}` : lotEstimateTurfSqFt > 0 ? `Lot est. ${formatSqFt(lotEstimateTurfSqFt)}` : "AI 0 sf"}
                    </Badge>
                  </div>
                  <div className="grid grid-cols-[1fr_auto] gap-2 items-end">
                    <FieldV2 label="Confirmed Sq Ft" className="mb-0">
                      <input
                        type="number"
                        min="0"
                        step="250"
                        value={form.measuredTurfSf || ""}
                        onChange={(e) => set("measuredTurfSf", e.target.value)}
                        placeholder={effectiveTurfSqFt > 0 ? String(effectiveTurfSqFt) : "Measured turf"}
                        className={INPUT_CLS}
                      />
                    </FieldV2>
                    {confirmedTurfSqFt !== null && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="h-10 px-3 text-11"
                        onClick={() => set("measuredTurfSf", "")}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={turfSliderMax}
                    step="250"
                    value={effectiveTurfSqFt}
                    onChange={(e) => set("measuredTurfSf", e.target.value)}
                    className="mt-3 w-full accent-zinc-900"
                  />
                  <div className="mt-1 flex items-center justify-between text-11 text-ink-secondary">
                    <span>0 sf</span>
                    <span className="font-medium text-zinc-900 u-nums">
                      {turfDisplaySource}:{" "}
                      {formatSqFt(effectiveTurfSqFt)}
                    </span>
                    <span>{turfSliderMax.toLocaleString()} sf</span>
                  </div>
                  {needsTurfConfirmation && (
                    <div className="mt-3 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs text-12 text-alert-fg">
                      AI turf is over 20,000 sf. Confirm treatable lawn area
                      before generating lawn pricing.
                    </div>
                  )}
                  {!needsTurfConfirmation && showTurfReview && (
                    <div className="mt-3 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs text-12 text-zinc-900">
                      Review turf estimate: {turfReviewReasons.join(", ")}.
                    </div>
                  )}
                  {confirmedTurfSqFt !== null && confirmedTurfSqFt > 20000 && (
                    <div className="mt-3 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs text-12 text-zinc-900">
                      Confirmed turf is over 20,000 sf and will be marked for
                      custom quote review.
                    </div>
                  )}
                </div>
              )}
              <CheckboxV2 k="svcPest" label="Pest Control" />
              {form.svcPest && commercialDetected && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200 text-12 text-zinc-600">
                  Commercial pest is auto-priced (estimated — confirmed on site). Residential pest pricing is suppressed.
                </div>
              )}
              {form.svcPest && !commercialDetected && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="grid grid-cols-2 gap-3">
                    {" "}
                    <FieldV2 label="Frequency">
                      <SelectV2
                        k="pestFreq"
                        options={[
                          { value: "4", label: "Quarterly (4x/yr)" },
                          { value: "6", label: "Bi-Monthly (6x/yr)" },
                          { value: "12", label: "Monthly (12x/yr)" },
                        ]}
                      />
                    </FieldV2>{" "}
                    <FieldV2 label="Roach Activity on Initial Visit">
                      <SelectV2
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
                    </FieldV2>{" "}
                  </div>{" "}
                  <div className="text-11 text-ink-secondary mt-2">
                    Adds a one-time Initial Roach Knockdown line to recurring pest. This is not a recurring per-visit multiplier.
                  </div>
                </div>
              )}
              <CheckboxV2 k="svcTs" label="Tree & Shrub" />{" "}
              <CheckboxV2 k="svcInjection" label="Palm Injection" />{" "}
              {form.svcInjection && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Treatment Type">
                      <SelectV2 k="palmTreatmentType" options={PALM_TREATMENT_OPTIONS} />
                    </FieldV2>
                    <FieldV2 label="Palms to treat">
                      <InputV2 k="palmTreatmentCount" type="number" placeholder={form.palmCount || "Required"} />
                    </FieldV2>
                  </div>
                  {(form.palmTreatmentType === "insecticide" || form.palmTreatmentType === "combo") && (
                    <>
                      <FieldV2 label="Palm size for this treatment">
                        <SelectV2 k="palmSize" options={PALM_SIZE_OPTIONS} />
                      </FieldV2>
                      <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
                        <CheckboxV2 k="palmHighDose" label="High dose" />
                        <CheckboxV2 k="palmLargeDiameter" label="Large diameter" />
                        <CheckboxV2 k="palmNonstandardProduct" label="Nonstandard product" />
                      </div>
                    </>
                  )}
                  {form.palmTreatmentType === "nutrition" && (
                    <FieldV2 label="Applications per year">
                      <SelectV2
                        k="palmAppsPerYear"
                        options={[
                          { value: "1", label: "1" },
                          { value: "2", label: "2" },
                        ]}
                      />
                    </FieldV2>
                  )}
                  {form.palmTreatmentType === "fungal" && (
                    <div className="grid grid-cols-2 gap-3">
                      <FieldV2 label="Selected product">
                        <SelectV2
                          k="palmSelectedProduct"
                          options={[
                            { value: "PHOSPHO-Jet", label: "PHOSPHO-Jet" },
                            { value: "Propizol", label: "Propizol" },
                          ]}
                        />
                      </FieldV2>
                      <FieldV2 label="Interval months">
                        <InputV2 k="palmIntervalMonths" type="number" placeholder="4" />
                      </FieldV2>
                      <CheckboxV2 k="palmDiagnosisConfirmed" label="Diagnosis confirmed" />
                    </div>
                  )}
                  {form.palmTreatmentType === "lethalBronzing" && (
                    <FieldV2 label="Palm status">
                      <SelectV2 k="palmStatus" options={PALM_STATUS_OPTIONS} />
                    </FieldV2>
                  )}
                  {form.palmTreatmentType === "treeAge" && (
                    <div className="grid grid-cols-2 gap-3">
                      <FieldV2 label="DBH inches">
                        <InputV2 k="palmDbhInches" type="number" placeholder="12" />
                      </FieldV2>
                      <FieldV2 label="Product">
                        <SelectV2
                          k="palmProduct"
                          options={[
                            { value: "Tree-Age G-4", label: "Tree-Age G-4" },
                            { value: "Tree-Age R10", label: "Tree-Age R10" },
                          ]}
                        />
                      </FieldV2>
                      {form.palmProduct === "Tree-Age R10" && (
                        <CheckboxV2 k="palmLicensedApplicator" label="Licensed applicator" />
                      )}
                    </div>
                  )}
                  <FieldV2 label="Custom $/palm">
                    <InputV2 k="palmCustomPricePerPalm" type="number" placeholder="Optional" />
                  </FieldV2>
                  {palmMeasurementWarning && (
                    <div className="px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs text-12 text-alert-fg">
                      {palmMeasurementWarning}
                    </div>
                  )}
                </div>
              )}
              <CheckboxV2 k="svcMosquito" label="Mosquito Program" />
              {(form.svcMosquito || form.svcOnetimeMosquito) && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="text-13 font-semibold text-zinc-900 mb-2">
                    Mosquito Estimate
                  </div>{" "}
                  <div
                    className={`grid ${form.svcMosquito ? "grid-cols-3" : "grid-cols-2"} gap-3`}
                  >
                    {form.svcMosquito && (
                      <FieldV2 label="Program">
                        {" "}
                        <SelectV2
                          k="mosquitoProgram"
                          options={[
                            {
                              value: "monthly12",
                              label: "Monthly Program (12 visits)",
                            },
                            {
                              value: "seasonal9",
                              label: "Seasonal Program (9 visits)",
                            },
                          ]}
                        />{" "}
                      </FieldV2>
                    )}
                    <FieldV2 label="Mosquito Stations">
                      {" "}
                      <InputV2
                        k="mosquitoStationCount"
                        type="number"
                        min="0"
                        placeholder="0"
                      />{" "}
                    </FieldV2>{" "}
                    <FieldV2 label="Bti Dunk Tablets">
                      {" "}
                      <InputV2
                        k="mosquitoDunkCount"
                        type="number"
                        min="0"
                        placeholder="0"
                      />{" "}
                    </FieldV2>{" "}
                  </div>
                  {form.svcMosquito && (
                    <div className="grid grid-cols-2 gap-3 mt-3 text-11 text-ink-secondary">
                      {" "}
                      <div className="bg-white border-hairline border-zinc-200 rounded-xs p-3">
                        {" "}
                        <div className="text-12 font-semibold text-zinc-900 mb-1">
                          Seasonal Program
                        </div>
                        9 applications during mosquito season, roughly every 21
                        days while pressure is active.
                      </div>{" "}
                      <div className="bg-white border-hairline border-zinc-200 rounded-xs p-3">
                        {" "}
                        <div className="text-12 font-semibold text-zinc-900 mb-1">
                          Monthly Program
                        </div>
                        12 applications year-round. Recommended for heavy tree
                        cover, water adjacency, and higher mosquito pressure.
                      </div>{" "}
                    </div>
                  )}
                  {(form.svcMosquito || form.svcOnetimeMosquito) && (
                    <div className="mt-3 bg-white border-hairline border-zinc-200 rounded-xs p-3">
                      {" "}
                      <div className="flex items-center justify-between gap-3 mb-2">
                        {" "}
                        <div className="text-12 font-semibold text-zinc-900">
                          Mosquito Protocol
                        </div>{" "}
                        <Badge variant="neutral" className="text-10">
                          Estimate reference
                        </Badge>{" "}
                      </div>{" "}
                      <div className="grid gap-2">
                        {MOSQUITO_PROTOCOL_STEPS.map((step, index) => (
                          <div
                            key={step}
                            className="flex gap-2 text-11 leading-snug text-ink-secondary"
                          >
                            {" "}
                            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-zinc-300 text-10 font-semibold text-zinc-700">
                              {index + 1}
                            </span>{" "}
                            <span>{step}</span>{" "}
                          </div>
                        ))}
                      </div>{" "}
                    </div>
                  )}
                  {mosquitoRecommendations.length > 0 && (
                    <div className="mt-3 bg-zinc-50 border-hairline border-zinc-300 rounded-xs p-3">
                      {" "}
                      <div className="text-12 font-semibold text-zinc-900 mb-2">
                        Field Recommendations
                      </div>{" "}
                      <div className="grid gap-2">
                        {mosquitoRecommendations.map((recommendation) => (
                          <div
                            key={recommendation.key}
                            className="flex items-start justify-between gap-3 rounded-xs bg-white border-hairline border-zinc-200 p-2.5"
                          >
                            {" "}
                            <div>
                              {" "}
                              <div className="text-12 font-semibold text-zinc-900">
                                {recommendation.label}
                              </div>{" "}
                              <div className="text-11 text-ink-secondary leading-snug">
                                {recommendation.detail}
                              </div>{" "}
                            </div>{" "}
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="h-7 shrink-0 px-2 text-11"
                              onClick={() =>
                                applyMosquitoRecommendation(recommendation)
                              }
                            >
                              Apply
                            </Button>{" "}
                          </div>
                        ))}
                      </div>{" "}
                    </div>
                  )}
                </div>
              )}
              <CheckboxV2 k="svcTermiteBait" label="Termite Bait Stations" />{" "}
              <CheckboxV2 k="svcRodentBait" label="Rodent Bait Stations" />
              {livePreview.recurringCount > 0 && (
                <div className="mt-3 mb-1.5 px-3 py-2 rounded-xs bg-zinc-50 border-hairline border-zinc-300 text-12 text-zinc-900">
                  {livePreview.recurringCount} service
                  {livePreview.recurringCount > 1 ? "s" : ""} selected →{" "}
                  <strong>{livePreview.tier.name}</strong>
                  {livePreview.tier.discount > 0
                    ? ` (${Math.round(livePreview.tier.discount * 100)}% bundle discount)`
                    : " (no bundle discount yet)"}
                </div>
              )}
              {livePreview.commercialManualQuoteCount > 0 && (
                <div className="mt-3 mb-1.5 px-3 py-2 rounded-xs bg-alert-bg border-hairline border-alert-fg text-12 text-alert-fg">
                  {livePreview.commercialManualQuoteCount} commercial selection
                  {livePreview.commercialManualQuoteCount > 1 ? "s" : ""} (mosquito / termite) set to manual quote.
                </div>
              )}
              <SubGroupLabel>One-Time Services</SubGroupLabel>{" "}
              <SubGroupLabel className="mt-3">Lawn</SubGroupLabel>{" "}
              <CheckboxV2 k="svcOnetimeLawn" label="Lawn Treatment" />
              {form.svcOnetimeLawn && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <FieldV2 label="Type" className="mb-0">
                    {" "}
                    <SelectV2
                      k="otLawnType"
                      options={[
                        { value: "FERT", label: "Fertilization (base)" },
                        { value: "WEED", label: "Weed Control (+15%)" },
                        { value: "PEST", label: "Lawn Pest (+30%)" },
                        { value: "FUNGICIDE", label: "Fungicide (+45%)" },
                      ]}
                    />{" "}
                  </FieldV2>{" "}
                </div>
              )}
              <CheckboxV2 k="svcPlugging" label="Lawn Plugging" />
              {form.svcPlugging && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="grid grid-cols-2 gap-3">
                    {" "}
                    <FieldV2 label="Plug Area (sq ft)">
                      <InputV2
                        k="plugArea"
                        type="number"
                        placeholder="e.g. 1000"
                      />
                    </FieldV2>{" "}
                    <FieldV2 label="Spacing">
                      <SelectV2
                        k="plugSpacing"
                        options={[
                          { value: "12", label: '12" Economy' },
                          { value: "9", label: '9" Standard' },
                          { value: "6", label: '6" Premium' },
                        ]}
                      />
                    </FieldV2>{" "}
                  </div>{" "}
                </div>
              )}
              <CheckboxV2 k="svcTopdress" label="Top Dressing" />{" "}
              {form.svcTopdress && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <FieldV2 label="Area (sq ft)">
                    <InputV2
                      k="topDressArea"
                      type="number"
                      placeholder="Blank = est. lawn"
                    />
                  </FieldV2>{" "}
                  <div className="mt-1 text-11 text-zinc-500">
                    Optional — enter sq ft for just the front or back yard.
                    Leave blank to auto-estimate from the property's lawn area.
                  </div>{" "}
                </div>
              )}
              <CheckboxV2
                k="svcDethatch"
                label={
                  isDethatchingStAugustine
                    ? "Dethatching - manager approval required for St. Augustine / Floratam"
                    : "Dethatching"
                }
              />{" "}
              {form.svcDethatch && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Lawn Sq Ft Used">
                      <input
                        type="text"
                        readOnly
                        value={`${Math.round(effectiveTurfSqFt || 0).toLocaleString()} sf`}
                        className={cn(INPUT_CLS, "bg-white text-ink-secondary")}
                      />
                    </FieldV2>
                    <FieldV2 label="Grass Type / Track">
                      <SelectV2
                        k="grassType"
                        options={[
                          { value: "st_augustine", label: "St. Augustine / Floratam" },
                          { value: "bermuda", label: "Bermuda" },
                          { value: "zoysia", label: "Zoysia" },
                          { value: "bahia", label: "Bahia" },
                          { value: "unknown", label: "Unknown - review" },
                        ]}
                      />
                    </FieldV2>
                    <FieldV2 label="Cleanup Level">
                      <SelectV2
                        k="dethatchingCleanupLevel"
                        options={[
                          { value: "none", label: "No debris removal" },
                          { value: "light", label: "Light cleanup" },
                          { value: "moderate", label: "Moderate cleanup" },
                          { value: "heavy", label: "Heavy cleanup / bagging" },
                        ]}
                      />
                    </FieldV2>
                    <FieldV2 label="Access">
                      <SelectV2
                        k="dethatchingAccess"
                        options={[
                          { value: "easy", label: "Easy" },
                          { value: "moderate", label: "Moderate" },
                          { value: "difficult", label: "Difficult - review" },
                        ]}
                      />
                    </FieldV2>
                  </div>
                  <CheckboxV2 k="dethatchingDebrisRemovalIncluded" label="Debris removal included" />
                  <div className="grid grid-cols-3 gap-3">
                    <FieldV2 label="Thatch Probe #1">
                      <InputV2 k="thatchProbe1Inches" type="number" min="0" placeholder="inches" />
                    </FieldV2>
                    <FieldV2 label="Thatch Probe #2">
                      <InputV2 k="thatchProbe2Inches" type="number" min="0" placeholder="inches" />
                    </FieldV2>
                    <FieldV2 label="Thatch Probe #3">
                      <InputV2 k="thatchProbe3Inches" type="number" min="0" placeholder="inches" />
                    </FieldV2>
                  </div>
                  {form.dethatchingCleanupLevel === "none" && !form.dethatchingDebrisRemovalIncluded && (
                    <div className="mt-2 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs text-12 text-zinc-900">
                      Base price does not include bagging or debris hauling.
                    </div>
                  )}
                  {(form.dethatchingCleanupLevel === "moderate" || form.dethatchingCleanupLevel === "heavy" || form.dethatchingDebrisRemovalIncluded) && (
                    <div className="mt-2 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs text-12 text-zinc-900">
                      Cleanup/debris removal included.
                    </div>
                  )}
                  {isDethatchingStAugustine && (
                    <div className="mt-3 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs text-12 text-alert-fg">
                      Manager approval required. Dethatching St. Augustine / Floratam can damage stolons.
                    </div>
                  )}
                  {isDethatchingStAugustine && (
                    <div className="grid grid-cols-2 gap-3 mt-3">
                      <FieldV2 label="Manager Approval Reason">
                        <SelectV2
                          k="dethatchingManagerApprovalReason"
                          options={[
                            { value: "", label: "Select reason" },
                            { value: "verified_thatch_probe", label: "Verified thatch probe" },
                            { value: "customer_requested_after_warning", label: "Customer requested after warning" },
                            { value: "bermuda_or_zoysia_confirmed", label: "Bermuda/Zoysia confirmed" },
                            { value: "manager_override", label: "Manager override" },
                          ]}
                        />
                      </FieldV2>
                      <div className="pt-7">
                        <CheckboxV2 k="dethatchingManagerApproved" label="Manager approval confirmed" />
                      </div>
                    </div>
                  )}
                </div>
              )}
              <SubGroupLabel className="mt-3">Termite</SubGroupLabel>{" "}
              <CheckboxV2 k="svcWdo" label="WDO / Termite Inspection" />{" "}
              <CheckboxV2 k="svcTrenching" label="Termite Trenching" />{" "}
              <CheckboxV2 k="svcBoracare" label="Termite Attic Remediation" />
              <CheckboxV2 k="svcPreslab" label="Pre-Slab Termiticide Treatment" />
              {hasAnyTermiteSelection && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="text-12 font-semibold text-zinc-900 mb-2">
                    Termite Measurements
                  </div>
                  <div className="text-11 text-ink-secondary mb-3">
                    Manual/admin-entered values override property lookup.
                  </div>
                  {termiteMeasurementWarnings.length > 0 && (
                    <div className="mb-3 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs text-12 text-alert-fg">
                      {termiteMeasurementWarnings.join(" ")}
                    </div>
                  )}
                  {form.svcTermiteBait && (
                    <>
                      <div className="grid grid-cols-2 gap-3">
                        <FieldV2 label="Footprint Sq Ft">
                          <InputV2
                            k="termiteFootprintSqFt"
                            type="number"
                            placeholder="Admin-entered"
                          />
                        </FieldV2>
                        <FieldV2 label="Perimeter LF Override">
                          <InputV2
                            k="termitePerimeterLF"
                            type="number"
                            placeholder="Optional"
                          />
                        </FieldV2>
                      </div>
                      <div className="grid grid-cols-3 gap-3">
                        <FieldV2 label="Layout">
                          <SelectV2
                            k="termiteBaitComplexity"
                            options={[
                              { value: "", label: "Auto from property" },
                              { value: "standard", label: "Standard" },
                              { value: "moderate", label: "Moderate" },
                              { value: "complex", label: "Complex" },
                            ]}
                          />
                        </FieldV2>
                        <FieldV2 label="System">
                          <SelectV2
                            k="termiteBaitSystem"
                            options={[
                              { value: "advance", label: "Advance" },
                              { value: "trelona", label: "Trelona" },
                            ]}
                          />
                        </FieldV2>
                        <FieldV2 label="Monitoring">
                          <SelectV2
                            k="termiteMonitoringTier"
                            options={[
                              { value: "basic", label: "Basic" },
                              { value: "premier", label: "Premier" },
                            ]}
                          />
                        </FieldV2>
                      </div>
                    </>
                  )}
                  {form.svcTrenching && (
                    <>
                      <FieldV2 label="Trenching Product">
                        <SelectV2
                          k="trenchingProductKey"
                          options={TRENCHING_PRODUCT_OPTIONS}
                        />
                      </FieldV2>
                      <div className="grid grid-cols-3 gap-3">
                        <FieldV2 label="Application Rate">
                          <SelectV2
                            k="trenchingApplicationRate"
                            options={[
                              { value: "standard", label: "Standard 0.06%" },
                              { value: "high", label: "High/problem-soil rate" },
                            ]}
                          />
                        </FieldV2>
                        <FieldV2 label="Trench Depth">
                          <SelectV2
                            k="trenchingDepthFt"
                            options={[
                              { value: "0.5", label: "0.5 ft / 6 in" },
                              { value: "1", label: "1.0 ft / 12 in" },
                              { value: "1.5", label: "1.5 ft / 18 in" },
                            ]}
                          />
                        </FieldV2>
                        <FieldV2 label="Warranty">
                          <SelectV2
                            k="trenchingWarrantyTier"
                            options={[
                              { value: "none", label: "None" },
                              { value: "one_year_retreat", label: "1-Year Retreat" },
                              { value: "three_year_repair_retreat", label: "3-Year Repair + Retreat" },
                              { value: "five_year_repair_retreat", label: "5-Year Repair + Retreat" },
                            ]}
                          />
                        </FieldV2>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <FieldV2 label="Perimeter LF">
                          <InputV2
                            k="trenchingPerimeterLF"
                            type="number"
                            placeholder="Measured LF"
                          />
                        </FieldV2>
                        <FieldV2 label="Concrete / Slab LF">
                          <InputV2
                            k="trenchingConcreteLF"
                            type="number"
                            placeholder="Optional"
                          />
                        </FieldV2>
                      </div>
                      <div className="grid grid-cols-2 gap-3">
                        <FieldV2 label="Dirt Trench LF">
                          <InputV2
                            k="trenchingDirtLF"
                            type="number"
                            placeholder="Optional"
                          />
                        </FieldV2>
                        <FieldV2 label="Concrete %">
                          <InputV2
                            k="trenchingConcretePct"
                            type="number"
                            placeholder="0.40 or 40"
                          />
                        </FieldV2>
                      </div>
                      <CheckboxV2
                        k="trenchingEstimateFromFootprint"
                        label="Estimate trenching perimeter from footprint"
                      />
                      <CheckboxV2
                        k="trenchingLabelConfirmed"
                        label="Label rate and trench depth confirmed"
                      />
                      <div className="text-12 text-zinc-600 leading-snug mb-1">
                        {(TRENCHING_PRODUCT_META[form.trenchingProductKey] || TRENCHING_PRODUCT_META.taurus_sc).warning}
                        {form.trenchingApplicationRate === "high" ? " High rate requires label confirmation." : ""}
                      </div>
                      <div className="text-11 text-zinc-500 leading-snug">
                        Admin config: {(TRENCHING_PRODUCT_META[form.trenchingProductKey] || TRENCHING_PRODUCT_META.taurus_sc).config}
                      </div>
                    </>
                  )}
                  {form.svcBoracare && (
                    <>
                      <FieldV2 label="Attic / Raw Wood Sq Ft">
                        <InputV2
                          k="boracareSqft"
                          type="number"
                          placeholder="Admin-entered"
                        />
                      </FieldV2>
                      <FieldV2 label="Surface Linear Ft">
                        <InputV2
                          k="boracareSurfaceLinearFt"
                          type="number"
                          placeholder="Linear ft of surface"
                        />
                      </FieldV2>
                      <FieldV2 label="Surface Height (ft)">
                        <InputV2
                          k="boracareSurfaceHeightFt"
                          type="number"
                          placeholder="Default 8"
                        />
                      </FieldV2>
                    </>
                  )}
                  {form.svcPreslab && (
                    <>
                      <FieldV2 label="Product">
                        <SelectV2
                          k="preslabProductKey"
                          options={PRE_SLAB_PRODUCT_OPTIONS}
                        />
                      </FieldV2>
                      <div className="grid grid-cols-2 gap-3">
                        {" "}
                        <FieldV2 label="Slab Sq Ft">
                          <InputV2
                            k="preslabSqft"
                            type="number"
                            placeholder="Admin-entered"
                          />
                        </FieldV2>{" "}
                        <FieldV2 label="Warranty">
                          <SelectV2
                            k="preslabWarranty"
                            options={[
                              { value: "NONE", label: "No warranty" },
                              { value: "BASIC", label: "Basic 1-yr (included)" },
                              { value: "EXTENDED", label: "Extended 5-yr (+$200)" },
                            ]}
                          />
                        </FieldV2>{" "}
                      </div>{" "}
                      <FieldV2 label="Builder Volume">
                        <SelectV2
                          k="preslabVolume"
                          options={[
                            { value: "NONE", label: "No discount" },
                            { value: "5", label: "5+ homes (-10%)" },
                            { value: "10", label: "10+ homes (-15%)" },
                          ]}
                        />
                      </FieldV2>
                      <FieldV2 label="Pre-Slab Job Context">
                        <SelectV2
                          k="preslabJobContext"
                          options={PRE_SLAB_JOB_CONTEXT_OPTIONS}
                        />
                      </FieldV2>
                      <CheckboxV2
                        k="preslabLabelConfirmed"
                        label="Label rate and finished dilution confirmed"
                      />
                      <div className="text-12 text-zinc-600 leading-snug mb-1">
                        Certificate of Compliance required. {(PRE_SLAB_PRODUCT_META[form.preslabProductKey] || PRE_SLAB_PRODUCT_META.termidor_sc).warning}
                      </div>
                      <div className="text-11 text-zinc-500 leading-snug">
                        Admin config: {(PRE_SLAB_PRODUCT_META[form.preslabProductKey] || PRE_SLAB_PRODUCT_META.termidor_sc).config}
                      </div>
                    </>
                  )}
                </div>
              )}
              <CheckboxV2 k="svcFoam" label="Termite Foam Treatment" />
              {form.svcFoam && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <FieldV2 label="Drill Points" className="mb-0">
                    {" "}
                    <SelectV2
                      k="foamPoints"
                      options={[
                        { value: "5", label: "1-5 Spot" },
                        { value: "10", label: "6-10 Moderate" },
                        { value: "15", label: "11-15 Extensive" },
                        { value: "20", label: "15+ Full Perimeter" },
                      ]}
                    />{" "}
                  </FieldV2>{" "}
                </div>
              )}
              <CheckboxV2 k="svcFoamRecurring" label="Recurring Foam Treatment" />
              {form.svcFoamRecurring && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <FieldV2 label="Cadence" className="mb-2">
                    {" "}
                    <SelectV2
                      k="foamRecurringFreq"
                      options={[
                        { value: "quarterly", label: "Quarterly (every 3 mo) — 10% off" },
                        { value: "bimonthly", label: "Bimonthly (every 2 mo) — 15% off" },
                        { value: "monthly", label: "Monthly — 20% off" },
                      ]}
                    />{" "}
                  </FieldV2>{" "}
                  <FieldV2 label="Drill Points" className="mb-0">
                    {" "}
                    <SelectV2
                      k="foamRecurringPoints"
                      options={[
                        { value: "5", label: "1-5 Spot" },
                        { value: "10", label: "6-10 Moderate" },
                        { value: "15", label: "11-15 Extensive" },
                        { value: "20", label: "15+ Full Perimeter" },
                      ]}
                    />{" "}
                  </FieldV2>{" "}
                  <div className="text-11 text-zinc-500 leading-snug mt-2">
                    Per-visit rate is discounted off the one-time price by cadence. Standalone — does not count toward WaveGuard tier.
                  </div>
                </div>
              )}
              <SubGroupLabel className="mt-3">Pest</SubGroupLabel>{" "}
              <CheckboxV2 k="svcOnetimePest" label="Pest Treatment" />{" "}
              <CheckboxV2 k="svcOnetimeMosquito" label="Mosquito Treatment" />{" "}
              <CheckboxV2 k="svcFlea" label="Flea Treatment" />{" "}
              {form.svcFlea && (
                <div className="ml-7 mb-3 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-3">
                    {FLEA_OFFER_OPTIONS.map((option) => {
                      const active = (form.fleaOfferKey || "flea_elimination_two_visit") === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => set("fleaOfferKey", option.value)}
                          className={cn(
                            "text-left p-3 rounded-sm border-hairline u-focus-ring",
                            active
                              ? "bg-zinc-900 border-zinc-900 text-white"
                              : "bg-white border-zinc-300 text-zinc-800 hover:bg-zinc-100",
                          )}
                        >
                          <div className="text-13 font-semibold">{option.label}</div>
                          <div className={cn("mt-1 text-11 leading-snug", active ? "text-zinc-200" : "text-ink-secondary")}>
                            {option.detail}
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="mb-3">
                    <div className="text-11 font-medium text-ink-secondary uppercase tracking-label mb-2">
                      Infestation / prep complexity
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {FLEA_COMPLEXITY_OPTIONS.map((option) => {
                        const active = (form.fleaComplexity || "light") === option.value;
                        return (
                          <button
                            key={option.value}
                            type="button"
                            onClick={() => set("fleaComplexity", option.value)}
                            className={cn(
                              "h-8 px-2.5 rounded-sm border-hairline text-11 font-medium u-focus-ring",
                              active
                                ? "bg-zinc-900 border-zinc-900 text-white"
                                : "bg-white border-zinc-300 text-zinc-700 hover:bg-zinc-100",
                            )}
                            title={option.detail}
                          >
                            {option.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <label className="flex items-start gap-2.5 mb-3 cursor-pointer text-12 text-zinc-900 select-none">
                    <input
                      type="checkbox"
                      checked={!!form.fleaExteriorSourceSuspected}
                      onChange={(e) => set("fleaExteriorSourceSuspected", e.target.checked)}
                      className="mt-0.5 h-4 w-4 accent-zinc-900"
                    />
                    <span>Exterior source suspected. If exterior treatment is declined, warranty scope remains interior-only.</span>
                  </label>
                  <label className="flex items-center gap-2.5 mb-3 cursor-pointer text-14 text-zinc-900 select-none">
                    <input
                      type="checkbox"
                      checked={!!form.svcFleaExterior}
                      onChange={(e) => setFleaExteriorEnabled(e.target.checked)}
                      className="h-4 w-4 accent-zinc-900"
                    />
                    Add exterior flea treatment
                  </label>
                  <div className="mb-3 text-11 text-ink-secondary leading-snug">
                    Exterior treatment focuses on likely flea zones such as shaded pet areas, fence lines, under decks, foundation edges, and landscape beds.
                  </div>
                  {form.svcFleaExterior && (
                    <>
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <div>
                          <div className="text-12 font-semibold text-zinc-900">
                            Treatable Lawn Area
                          </div>
                          <div className="mt-0.5 text-11 text-ink-secondary leading-snug">
                            Price exterior flea treatment based on treatable turf and yard area, not the full property lot.
                          </div>
                        </div>
                        <Badge variant="neutral" className="text-10 u-nums">
                          Max {fleaExteriorMaxSqFt.toLocaleString()} sf
                        </Badge>
                      </div>
                      <div className="mb-3">
                        <div className="text-11 font-medium text-ink-secondary uppercase tracking-label mb-2">
                          Area source
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {FLEA_EXTERIOR_SOURCE_OPTIONS.map((option) => {
                            const active = fleaExteriorAreaSource === option.value;
                            return (
                              <button
                                key={option.value}
                                type="button"
                                onClick={() => set("fleaExteriorAreaSource", option.value)}
                                className={cn(
                                  "h-8 px-2.5 rounded-sm border-hairline text-11 font-medium u-focus-ring",
                                  active
                                    ? "bg-zinc-900 border-zinc-900 text-white"
                                    : "bg-white border-zinc-300 text-zinc-700 hover:bg-zinc-100",
                                )}
                              >
                                {option.label}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
                        <FieldV2 label="Area" className="mb-0">
                          <input
                            type="number"
                            min="0"
                            step="250"
                            value={form.fleaExteriorAreaSqFt || ""}
                            onChange={(e) => set("fleaExteriorAreaSqFt", e.target.value)}
                            placeholder="Treatable sq ft"
                            className={INPUT_CLS}
                          />
                        </FieldV2>
                        <div className="h-10 px-3 flex items-center rounded-sm border-hairline border-zinc-300 bg-white text-14 text-zinc-900 u-nums">
                          {formatSqFt(fleaExteriorAreaSqFt)}
                        </div>
                      </div>
                      <input
                        type="range"
                        min="0"
                        max={fleaExteriorMaxSqFt}
                        step="250"
                        value={Math.min(fleaExteriorAreaSqFt, fleaExteriorMaxSqFt)}
                        onChange={(e) => set("fleaExteriorAreaSqFt", e.target.value)}
                        className="mt-3 w-full accent-zinc-900"
                      />
                      <div
                        className="mt-1 grid gap-1 text-10 text-ink-secondary"
                        style={{ gridTemplateColumns: `repeat(${fleaExteriorSliderMarks.length}, minmax(0, 1fr))` }}
                      >
                        {fleaExteriorSliderMarks.map((mark, index) => (
                          <span
                            key={mark}
                            className={cn(
                              index === 0 ? "text-left" : "",
                              index === fleaExteriorSliderMarks.length - 1 ? "text-right" : "text-center",
                            )}
                          >
                            {index === 0 || index === fleaExteriorSliderMarks.length - 1
                              ? `${mark.toLocaleString()} sf`
                              : mark.toLocaleString()}
                          </span>
                        ))}
                      </div>
                      <div className="mt-2 text-12 text-zinc-900 u-nums">
                        Using {fleaExteriorSourceLabel(fleaExteriorAreaSource)}:{" "}
                        {formatSqFt(fleaExteriorAreaSqFt)}
                      </div>
                      <div className="mt-3 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs">
                        <div className="text-11 font-medium text-ink-secondary uppercase tracking-label mb-1">
                          Exterior flea add-on
                        </div>
                        {fleaExteriorPreview.priceable ? (
                          <div className="text-13 text-zinc-900 u-nums">
                            ${fleaExteriorPreview.initial} initial + ${fleaExteriorPreview.followUp} follow-up = ${fleaExteriorPreview.total} total
                          </div>
                        ) : fleaExteriorPreview.configUnavailable ? (
                          <div className="text-13 text-zinc-900">
                            Exterior flea pricing config is unavailable.
                          </div>
                        ) : fleaExteriorPreview.customQuote ? (
                          <div className="text-13 text-zinc-900">
                            {(fleaExteriorPreview.maxSqFt || fleaExteriorMaxSqFt).toLocaleString()}+ sf. Custom quote required.
                          </div>
                        ) : (
                          <div className="text-13 text-zinc-900">
                            Pricing needs a confirmed treatable lawn area.
                          </div>
                        )}
                      </div>
                      {fleaExteriorWarning && (
                        <div className="mt-3 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs text-12 text-zinc-900">
                          {fleaExteriorWarning}
                        </div>
                      )}
                      <div className="mt-3">
                        <div className="text-11 font-medium text-ink-secondary uppercase tracking-label mb-2">
                          Exterior treatment zones
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          {FLEA_EXTERIOR_ZONES.map((zone) => (
                            <label
                              key={zone.value}
                              className="flex items-center gap-2 text-12 text-zinc-900 cursor-pointer select-none"
                            >
                              <input
                                type="checkbox"
                                checked={(form.fleaExteriorZones || []).includes(zone.value)}
                                onChange={(e) => setFleaExteriorZone(zone.value, e.target.checked)}
                                className="h-3.5 w-3.5 accent-zinc-900"
                              />
                              {zone.label}
                            </label>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              )}
              <CheckboxV2 k="svcRoach" label="Cockroach Specialty Service" />
              {form.svcRoach && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="text-12 font-semibold text-zinc-900 mb-2">
                    Standalone / Specialty Services
                  </div>
                  <FieldV2 label="Service Type" className="mb-0">
                    {" "}
                    <SelectV2
                      k="roachType"
                      options={[
                        {
                          value: "REGULAR",
                          label: "Standalone Native Cockroach Treatment",
                        },
                        { value: "GERMAN", label: "German Roach Cleanout" },
                      ]}
                    />{" "}
                  </FieldV2>{" "}
                  {form.roachType === "GERMAN" && (
                    <FieldV2 label="Infestation Severity" className="mb-0 mt-2">
                      <SelectV2
                        k="germanRoachSeverity"
                        options={[
                          { value: "light", label: "Light — 2 Visits ($350)" },
                          { value: "moderate", label: "Medium — 3 Visits ($450)" },
                          { value: "heavy", label: "Heavy — 4 Visits ($550)" },
                        ]}
                      />
                    </FieldV2>
                  )}
                  {form.roachType === "GERMAN" && (
                    <div className="text-11 text-ink-secondary mt-2">
                      German Roach Cleanout is a separate specialty program, not the German version of native cockroach treatment.
                    </div>
                  )}
                </div>
              )}
              <CheckboxV2 k="svcWasp" label="Wasp/Bee/Stinging Insect" />{" "}
              <CheckboxV2 k="svcBedbug" label="Bed Bug Treatment" />
              {form.svcBedbug && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="grid grid-cols-2 gap-3">
                    {" "}
                    <FieldV2 label="Rooms">
                      <InputV2 k="bedbugRooms" type="number" min="1" max="10" />
                    </FieldV2>{" "}
                    <FieldV2 label="Method">
                      <SelectV2
                        k="bedbugMethod"
                        options={[
                          { value: "CHEMICAL", label: "Chemical Only" },
                          { value: "HEAT", label: "Heat Only" },
                          { value: "HYBRID", label: "Hybrid" },
                        ]}
                      />
                    </FieldV2>{" "}
                  </div>{" "}
                  <div className="grid grid-cols-3 gap-3 mt-3">
                    <FieldV2 label="Severity">
                      <SelectV2
                        k="bedbugSeverity"
                        options={[
                          { value: "light", label: "Light" },
                          { value: "moderate", label: "Moderate" },
                          { value: "heavy", label: "Heavy" },
                          { value: "severe", label: "Severe/Quote" },
                        ]}
                      />
                    </FieldV2>
                    <FieldV2 label="Prep">
                      <SelectV2
                        k="bedbugPrepStatus"
                        options={[
                          { value: "ready", label: "Ready" },
                          { value: "partial", label: "Partial" },
                          { value: "poor", label: "Poor" },
                          { value: "refused", label: "Refused/Quote" },
                        ]}
                      />
                    </FieldV2>
                    <FieldV2 label="Occupancy">
                      <SelectV2
                        k="bedbugOccupancyType"
                        options={[
                          { value: "singleFamily", label: "Single Family" },
                          { value: "apartment", label: "Apartment" },
                          { value: "hotel", label: "Hotel" },
                          { value: "studentHousing", label: "Student Housing" },
                        ]}
                      />
                    </FieldV2>
                  </div>
                  {form.bedbugMethod !== "CHEMICAL" && (
                    <div className="grid grid-cols-3 gap-3 mt-3">
                      <FieldV2 label="Equipment">
                        <SelectV2
                          k="bedbugEquipment"
                          options={[
                            { value: "INHOUSE", label: "In-House" },
                            { value: "SUBCONTRACT", label: "Subcontract" },
                          ]}
                        />
                      </FieldV2>
                      <FieldV2 label="Heat Scope">
                        <SelectV2
                          k="bedbugHeatScope"
                          options={[
                            { value: "ROOMS_ONLY", label: "Rooms Only" },
                            { value: "WHOLE_HOME", label: "Whole Home" },
                          ]}
                        />
                      </FieldV2>
                      {form.bedbugEquipment === "SUBCONTRACT" && (
                        <FieldV2 label="Vendor Cost">
                          <InputV2 k="bedbugSubcontractCost" type="number" min="1" />
                        </FieldV2>
                      )}
                    </div>
                  )}
                </div>
              )}
              <SubGroupLabel className="mt-3">Rodent</SubGroupLabel>{" "}
              <CheckboxV2 k="svcRodentTrap" label="Rodent Trapping" />{" "}
              {form.svcRodentTrap && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Trapping Plan">
                      <SelectV2
                        k="rodentTrappingPlan"
                        options={[
                          { value: "standard", label: "Standard - $350 - includes 2 callbacks" },
                          { value: "unlimited", label: "Unlimited Callback - $450" },
                        ]}
                      />
                    </FieldV2>
                    <FieldV2 label="Callbacks Used">
                      <InputV2 k="callbacksUsed" type="number" min="0" />
                    </FieldV2>
                    <FieldV2 label="Extra Callbacks">
                      <InputV2 k="extraCallbackCount" type="number" min="0" />
                    </FieldV2>
                    <div className="pt-7">
                      <CheckboxV2 k="rodentTrappingEmergency" label="Emergency surcharge" />
                    </div>
                    <div className="col-span-2">
                      <CheckboxV2 k="upgradeToUnlimited" label="Upgrade Standard to Unlimited (+$125)" />
                    </div>
                  </div>
                </div>
              )}
              <CheckboxV2 k="svcTrapOnlyRetainer" label="Customer declined exclusion / trap-only monitoring" />
              {form.svcTrapOnlyRetainer && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Retainer Plan">
                      <SelectV2
                        k="trapOnlyRetainerPlan"
                        options={[
                          { value: "standard", label: "Standard $495/yr or $49/mo" },
                          { value: "plus", label: "Plus $695/yr or $69/mo" },
                          { value: "monthly", label: "Monthly $995/yr or $99/mo" },
                        ]}
                      />
                    </FieldV2>
                    <FieldV2 label="Billing">
                      <SelectV2
                        k="trapOnlyRetainerBilling"
                        options={[
                          { value: "annual", label: "Annual prepaid" },
                          { value: "monthly", label: "Monthly, 12-month agreement" },
                        ]}
                      />
                    </FieldV2>
                    <FieldV2 label="Response Callbacks Used">
                      <InputV2 k="trapOnlyResponseCallbacksUsed" type="number" min="0" />
                    </FieldV2>
                    <FieldV2 label="Extra Response Callbacks">
                      <InputV2 k="trapOnlyExtraCallbackCount" type="number" min="0" />
                    </FieldV2>
                    <div className="col-span-2">
                      <CheckboxV2 k="trapOnlyAttachedToCompletedTrappingJob" label="Attached to completed trapping job (waive setup)" />
                    </div>
                  </div>
                  <div className="text-12 text-zinc-600 mt-2">
                    Trap-only monitoring is not a rodent guarantee because exclusion was declined.
                  </div>
                </div>
              )}
              {/* Legacy Wire Mesh / Bird Box checkboxes removed — folded into Rodent Exclusion V2 above */}
              <CheckboxV2 k="svcRodentSanitation" label="Rodent Sanitation" />
              {form.svcRodentSanitation && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="grid grid-cols-2 gap-3">
                    {" "}
                    <FieldV2 label="Tier">
                      <SelectV2
                        k="sanitationTier"
                        options={[
                          { value: "light", label: "Light" },
                          { value: "standard", label: "Standard" },
                          { value: "heavy", label: "Heavy" },
                        ]}
                      />
                    </FieldV2>{" "}
                    <FieldV2 label="Access">
                      <SelectV2
                        k="sanitationAccess"
                        options={[
                          { value: "normal", label: "Normal" },
                          { value: "crawlspace", label: "Crawlspace" },
                          { value: "tight", label: "Tight" },
                        ]}
                      />
                    </FieldV2>{" "}
                    <FieldV2 label="Affected Sq Ft">
                      <InputV2
                        k="sanitationArea"
                        type="number"
                        min="0"
                        placeholder="Auto from footprint"
                      />
                    </FieldV2>{" "}
                    <FieldV2 label="Debris Cu Ft">
                      <InputV2 k="sanitationDebris" type="number" min="0" />
                    </FieldV2>{" "}
                  </div>{" "}
                </div>
              )}
              <CheckboxV2 k="svcExclusion" label="Rodent Exclusion" />
              {form.svcExclusion && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200 space-y-3">
                  <p className="text-[11px] tracking-label uppercase text-zinc-400 font-medium">Wire Mesh Points</p>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Standard — $75/pt">
                      <InputV2 k="exclStandardWireMesh" type="number" min="0" />
                    </FieldV2>
                    <FieldV2 label="Roof/High — $150/pt">
                      <InputV2 k="exclAdvancedWireMesh" type="number" min="0" />
                    </FieldV2>
                  </div>
                  <p className="text-[11px] tracking-label uppercase text-zinc-400 font-medium">Bird Boxes</p>
                  <div className="grid grid-cols-3 gap-3">
                    <FieldV2 label="Standard — $150">
                      <InputV2 k="exclStandardBirdBox" type="number" min="0" />
                    </FieldV2>
                    <FieldV2 label="Tile/High — $210">
                      <InputV2 k="exclTileHighBirdBox" type="number" min="0" />
                    </FieldV2>
                    <FieldV2 label="Custom — $250+">
                      <InputV2 k="exclCustomBirdBox" type="number" min="0" />
                    </FieldV2>
                  </div>
                  <p className="text-[11px] tracking-label uppercase text-zinc-400 font-medium">Linear Mesh (LF)</p>
                  <div className="grid grid-cols-2 gap-3">
                    <FieldV2 label="Soft material — $14/LF">
                      <InputV2 k="exclMeshSoftLF" type="number" min="0" />
                    </FieldV2>
                    <FieldV2 label="Hard material — $22/LF">
                      <InputV2 k="exclMeshConcreteLF" type="number" min="0" />
                    </FieldV2>
                  </div>
                  <FieldV2 label="Waive Inspection ($125)?">
                    <SelectV2
                      k="exclWaive"
                      options={[
                        { value: "NO", label: "No — charge $125" },
                        { value: "YES", label: "Yes — booking work" },
                      ]}
                    />
                  </FieldV2>
                </div>
              )}
            </div>
            {/* Manual / Custom Discount */}
            <div>
              {" "}
              <PanelTitle>Manual / Custom Discount (optional)</PanelTitle>{" "}
              <FieldV2 label="Preset">
                {" "}
                <select
                  value={form.manualDiscountPreset || ""}
                  onChange={(e) => applyDiscountPreset(e.target.value)}
                  className={cn(
                    INPUT_CLS,
                    "cursor-pointer appearance-none pr-8",
                  )}
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
              </FieldV2>
              {form.manualDiscountPreset &&
                form.manualDiscountPreset !== "__custom__" &&
                (() => {
                  const d = discountPresets.find(
                    (x) => x.discount_key === form.manualDiscountPreset,
                  );
                  return d?.description ? (
                    <div className="text-11 text-ink-secondary -mt-1 mb-3">
                      {d.description}
                    </div>
                  ) : null;
                })()}
              <div className="grid grid-cols-2 gap-2">
                {" "}
                <FieldV2 label="Type">
                  {" "}
                  <SelectV2
                    k="manualDiscountType"
                    options={[
                      { value: "NONE", label: "None" },
                      { value: "PERCENT", label: "Percent %" },
                      { value: "FIXED", label: "Dollar $" },
                    ]}
                  />{" "}
                </FieldV2>{" "}
                <FieldV2 label="Amount">
                  {" "}
                  <InputV2
                    k="manualDiscountValue"
                    type="number"
                    min="0"
                    placeholder="0"
                  />{" "}
                </FieldV2>{" "}
                <div className="col-span-2">
                  {" "}
                  <FieldV2 label="Label (shown on estimate)">
                    {" "}
                    <InputV2
                      k="manualDiscountLabel"
                      placeholder="e.g. Military, Referral"
                    />{" "}
                  </FieldV2>{" "}
                </div>{" "}
                <div className="col-span-2">
                  {" "}
                  <FieldV2 label="Internal reason">
                    {" "}
                    <InputV2
                      k="manualDiscountInternalReason"
                      placeholder="Required for custom or eligibility override"
                    />{" "}
                  </FieldV2>{" "}
                </div>{" "}
              </div>{" "}
              <label className="flex items-center gap-2 text-12 text-zinc-900 mt-1">
                <input
                  type="checkbox"
                  checked={form.manualDiscountEligibilityConfirmed === true}
                  onChange={(e) =>
                    setForm((f) => ({
                      ...f,
                      manualDiscountEligibilityConfirmed: e.target.checked,
                    }))
                  }
                  className="h-3.5 w-3.5 accent-zinc-900"
                />
                Eligibility confirmed or approved override
              </label>
              {form.manualDiscountEligibilityConfirmed && (
                <div className="mt-2">
                  <FieldV2 label="Override reason">
                    <InputV2
                      k="manualDiscountEligibilityOverrideReason"
                      placeholder="e.g. verified ID, referral noted, annual prepay confirmed"
                    />
                  </FieldV2>
                </div>
              )}
              <div className="text-11 text-ink-tertiary mt-2">
                Applies after bundle/WaveGuard discounts to both recurring and
                one-time services. Re-click Generate Estimate to recalculate.
              </div>{" "}
            </div>
            {serviceCreditPresets.length > 0 && (
              <div>
                <PanelTitle>Service-Specific Credits</PanelTitle>
                <div className="grid gap-2">
                  {serviceCreditPresets.map((credit) => {
                    const key = credit.discount_key || credit.key;
                    const checked = (form.serviceSpecificDiscountKeys || []).includes(key);
                    return (
                      <label
                        key={credit.id || key}
                        className="flex items-center justify-between gap-3 rounded-xs border-hairline border-zinc-300 bg-white px-3 py-2 text-12 text-zinc-900"
                      >
                        <span>{credit.name}</span>
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleServiceSpecificDiscount(key)}
                          className="h-3.5 w-3.5 accent-zinc-900"
                        />
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
            {/* Action buttons */}
            <div
              className={cn(
                "grid gap-3",
                estimate ? "grid-cols-3" : "grid-cols-2",
              )}
            >
              {" "}
              <Button
                onClick={() => doGenerate()}
                disabled={generateBusy}
                variant="primary"
                size="md"
                className={cn("h-12", estimate ? "text-12" : "text-14")}
              >
                {generating
                  ? "Generating…"
                  : estimate
                    ? "Regenerate"
                    : "Generate Estimate"}
              </Button>{" "}
              {estimate && (
                <Button
                  variant="secondary"
                  size="md"
                  className="h-12 text-12 gap-2"
                  disabled={generateBusy}
                  onClick={previewCustomerEstimate}
                  title="Open the customer-facing estimate in a new tab"
                >
                  <ExternalLink size={14} strokeWidth={1.8} aria-hidden />
                  Preview
                </Button>
              )}
              <Button
                variant="secondary"
                size="md"
                className={cn("h-12", estimate ? "text-12" : "text-14")}
                disabled={generateBusy}
                onClick={async () => {
                  if (estimate || (await doGenerate())) {
                    setShowSendForm(true);
                  }
                }}
              >
                {generating
                  ? "Generating…"
                  : estimate
                    ? "Send"
                    : "Send Estimate"}
              </Button>{" "}
            </div>
            {/* Send form */}
            {showSendForm && (
              <Card className="p-5 border-zinc-900">
                {" "}
                <PanelTitle>Send Estimate</PanelTitle>{" "}
                {provisionalState.provisional && (
                  <div className="mb-3 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs">
                    <div className="text-12 font-medium text-alert-fg">
                      Provisional estimate — {provisionalSummary(provisionalState)}.
                    </div>
                    <div className="text-11 text-ink-secondary mt-0.5">
                      Pricing may change once verified on site. Confirm square
                      footage, lot, stories, and property type in the property
                      panel above (Save as field-verified) before sending a firm
                      quote.
                    </div>
                  </div>
                )}
                <FieldV2 label="Customer Phone Number">
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
                    className={cn(INPUT_CLS, "h-12 text-18 tracking-wider")}
                  />{" "}
                </FieldV2>
                {form.customerName && (
                  <div className="text-12 text-zinc-900 mb-3 px-3 py-2 bg-zinc-50 rounded-xs border-hairline border-zinc-300">
                    Found: <strong>{form.customerName}</strong>
                    {form.customerEmail ? ` · ${form.customerEmail}` : ""}
                  </div>
                )}
                {!form.customerName && form.customerPhone?.length >= 7 && (
                  <div className="mb-3 grid grid-cols-2 gap-2">
                    {" "}
                    <FieldV2 label="Name">
                      {" "}
                      <input
                        type="text"
                        value={form.customerName || ""}
                        onChange={(e) => set("customerName", e.target.value)}
                        placeholder="Full name"
                        className={INPUT_CLS}
                      />{" "}
                    </FieldV2>{" "}
                    <FieldV2 label="Email">
                      {" "}
                      <input
                        type="email"
                        value={form.customerEmail || ""}
                        onChange={(e) => set("customerEmail", e.target.value)}
                        placeholder="email@example.com"
                        className={INPUT_CLS}
                      />{" "}
                    </FieldV2>{" "}
                  </div>
                )}
                <div className="mb-3 p-3 border-hairline border-zinc-300 rounded-xs bg-zinc-50">
                  {" "}
                  <div className="text-11 font-medium text-zinc-900 mb-2 uppercase tracking-label">
                    Customer options
                  </div>{" "}
                  <label className="flex items-start gap-2 cursor-pointer text-12 text-zinc-900 select-none mb-2">
                    {" "}
                    <input
                      type="checkbox"
                      checked={form.showOneTimeOption || false}
                      onChange={(e) =>
                        setCustomerChoiceOption(e.target.checked)
                      }
                      className="accent-zinc-900 mt-0.5"
                    />{" "}
                    <span>
                      {" "}
                      <span className="font-medium">
                        Offer one-time option
                      </span>{" "}
                      <span className="block text-11 text-ink-secondary">
                        Customer sees a Recurring / One-time toggle for
                        pest-only recurring estimates. Mixed service bundles
                        should be sent without this option.
                      </span>{" "}
                    </span>{" "}
                  </label>{" "}
                  <label className="flex items-start gap-2 cursor-pointer text-12 text-zinc-900 select-none">
                    {" "}
                    <input
                      type="checkbox"
                      checked={form.billByInvoice || false}
                      onChange={(e) => set("billByInvoice", e.target.checked)}
                      className="accent-zinc-900 mt-0.5"
                    />{" "}
                    <span>
                      {" "}
                      <span className="font-medium">Bill by invoice</span>{" "}
                      <span className="block text-11 text-ink-secondary">
                        Skip onboarding / payment up front — create an invoice
                        due immediately when the customer accepts.
                      </span>{" "}
                    </span>{" "}
                  </label>{" "}
                </div>{" "}
                <div className="flex items-center gap-2 mb-2 flex-wrap">
                  {" "}
                  <label className="flex items-center gap-2 cursor-pointer text-12 text-ink-secondary select-none">
                    {" "}
                    <input
                      type="checkbox"
                      checked={form.scheduleSend || false}
                      onChange={(e) => set("scheduleSend", e.target.checked)}
                      className="accent-zinc-900"
                    />
                    Schedule for later
                  </label>
                  {form.scheduleSend && (
                    <input
                      type="datetime-local"
                      value={form.scheduledAt || ""}
                      onChange={(e) => set("scheduledAt", e.target.value)}
                      className={cn(INPUT_CLS, "w-auto h-8 text-12 px-2")}
                    />
                  )}
                </div>
                {form.scheduleSend && !form.scheduledAt && (
                  <div className="text-11 text-ink-secondary mb-2">
                    Quick:{" "}
                    <button
                      onClick={() => {
                        const tomorrow = new Date();
                        tomorrow.setDate(tomorrow.getDate() + 1);
                        tomorrow.setHours(8, 0, 0, 0);
                        set("scheduledAt", formatDatetimeLocal(tomorrow));
                      }}
                      className="underline font-medium u-focus-ring"
                    >
                      Tomorrow 8:00 AM
                    </button>{" "}
                  </div>
                )}
                <div className="flex flex-col gap-2">
                  {" "}
                  <div className="grid grid-cols-3 gap-2">
                    {" "}
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={async () => {
                        if (!form.customerPhone) {
                          alert("Enter a phone number.");
                          return;
                        }
                        await saveAndSend("sms");
                      }}
                      disabled={sendBusy}
                    >
                      {sendBusy
                        ? "…"
                        : form.scheduleSend
                          ? "Schedule SMS"
                          : "SMS Only"}
                    </Button>{" "}
                    <Button
                      variant="secondary"
                      size="md"
                      onClick={async () => {
                        if (!form.customerEmail) {
                          alert("Enter an email.");
                          return;
                        }
                        await saveAndSend("email");
                      }}
                      disabled={sendBusy}
                    >
                      {sendBusy
                        ? "…"
                        : form.scheduleSend
                          ? "Schedule Email"
                          : "Email Only"}
                    </Button>{" "}
                    <Button
                      variant="primary"
                      size="md"
                      onClick={async () => {
                        if (!form.customerPhone && !form.customerEmail) {
                          alert("Enter phone or email.");
                          return;
                        }
                        await saveAndSend("both");
                      }}
                      disabled={sendBusy}
                    >
                      {sendBusy
                        ? "…"
                        : form.scheduleSend
                          ? "Schedule Both"
                          : "Both"}
                    </Button>{" "}
                  </div>{" "}
                  <Button
                    variant="ghost"
                    size="md"
                    onClick={() => setShowSendForm(false)}
                  >
                    Cancel
                  </Button>{" "}
                </div>{" "}
              </Card>
            )}

            {savedId && (
              <div className="text-12 text-ink-secondary">
                Saved — ID #{savedId}.
              </div>
            )}

            {priceRecomputeNotice && (
              <div className="text-12 text-ink-secondary bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-3 mt-2">
                Final price recomputed on save (server-authoritative):
                {priceRecomputeNotice.serverMonthly != null && (
                  <> {" "}${priceRecomputeNotice.serverMonthly.toFixed(2)}/mo (preview showed ${priceRecomputeNotice.clientMonthly.toFixed(2)})</>
                )}
                {priceRecomputeNotice.serverOnetime != null && (
                  <> {priceRecomputeNotice.serverMonthly != null ? "·" : ""} ${priceRecomputeNotice.serverOnetime.toFixed(2)} one-time (preview showed ${priceRecomputeNotice.clientOnetime.toFixed(2)})</>
                )}
                . The saved/billed price is the server value.
              </div>
            )}
          </div>
          {/* ═══ RIGHT COLUMN: RESULTS ═══ */}
          <div>
            {!estimate ? (
              <Card className="p-10 text-center">
                {" "}
                <div
                  className="text-zinc-900 mb-3"
                  style={{
                    fontFamily: ROBOTO,
                    fontSize: 12,
                    fontWeight: 500,
                    letterSpacing: "0.02em",
                  }}
                >
                  {!livePreview.anySelected
                    ? "Select Services to Get Started"
                    : "Ready to Generate"}
                </div>{" "}
                <div className="text-14 text-ink-secondary mb-4">
                  {!livePreview.anySelected
                    ? "Select at least one service to see pricing"
                    : `${livePreview.totalRecurringCount} recurring/manual + ${livePreview.onetimeCount} one-time selected — click Generate Estimate`}
                </div>
                {enrichedProfile && (
                  <div className="text-left px-4 py-3 bg-zinc-50 rounded-sm border-hairline border-zinc-200 mt-3 text-13 text-ink-secondary leading-relaxed">
                    {" "}
                    <div className="text-11 font-medium text-zinc-900 uppercase tracking-label mb-1.5">
                      Property Loaded
                    </div>{" "}
                    <div>{form.address}</div>{" "}
                    <div>
                      {(Number(form.homeSqFt) || 0).toLocaleString()} sf home ·{" "}
                      {(Number(form.lotSqFt) || 0).toLocaleString()} sf lot ·{" "}
                      {form.stories || 1} story
                    </div>
                    {form.hasPool === "YES" && (
                      <div>
                        Pool: Yes{form.hasPoolCage === "YES" ? " (caged)" : ""}
                      </div>
                    )}
                    <div>
                      Shrubs: {form.shrubDensity} · Trees: {form.treeDensity} ·
                      Complexity: {form.landscapeComplexity}
                    </div>{" "}
                  </div>
                )}
              </Card>
            ) : (
              <EstimateErrorBoundary
                key={JSON.stringify(estimate).slice(0, 100)}
              >
                {" "}
                <Card className="p-5">
                  {" "}
                  <div className="flex flex-wrap justify-end gap-2 mb-2">
                    {" "}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="gap-1.5"
                      onClick={previewCustomerEstimate}
                      disabled={sendBusy}
                      title="Open the customer-facing estimate in a new tab"
                    >
                      <ExternalLink size={13} strokeWidth={1.8} aria-hidden />
                      Customer View
                    </Button>{" "}
                    <Button
                      variant="secondary"
                      size="sm"
                      className="gap-1.5"
                      onClick={() => setPresentMode(true)}
                      title="Show pricing full-screen to the customer in person — no booking"
                    >
                      <Monitor size={13} strokeWidth={1.8} aria-hidden />
                      Present to Customer
                    </Button>{" "}
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={nextEstimate}
                    >
                      Next Estimate (keep services)
                    </Button>{" "}
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setEstimate(null);
                        setSavedId(null);
                        setSavedViewUrl(null);
                        setShowSendForm(false);
                      }}
                    >
                      New Estimate
                    </Button>{" "}
                  </div>{" "}
                  <div className="max-h-[calc(100vh-120px)] overflow-y-auto pr-2">
                    <CustomerEstimatePreviewV2
                      E={E}
                      R={R}
                      form={form}
                      satelliteUrl={satelliteData?.imageUrl || null}
                      onSelectPestFreq={(apps) => {
                        set("pestFreq", String(apps));
                        doGenerate({ pestFreq: apps });
                      }}
                    />
                    <details className="border-hairline border-zinc-300 rounded-sm bg-white mb-2">
                      <summary className="cursor-pointer px-4 py-3 text-13 font-medium text-zinc-900 list-none border-b-hairline border-zinc-200">
                        Estimator engine details
                        <span className="block text-11 font-normal text-ink-secondary mt-1">
                          Property summary, pricing modifiers, production diagnostics, and raw program tiers.
                        </span>
                      </summary>
                      <div className="p-4">
                    {/* Summary Card */}
                    {(E.recurring.serviceCount > 0 ||
                      E.oneTime.total > 0 ||
                      E.recurring.palmInjectionMo > 0 ||
                      E.recurring.rodentBaitMo > 0) && (
                      <>
                        {" "}
                        <div className="bg-zinc-50 border-hairline border-zinc-900 rounded-sm p-6 mb-6 text-center">
                          {" "}
                          <div className="text-28 font-medium text-zinc-900 u-nums">
                            {fmt(
                              E.recurring.grandTotal ||
                                E.recurring.monthlyTotal +
                                  (E.recurring.rodentBaitMo || 0) +
                                  (E.recurring.palmInjectionMo || 0),
                            )}
                            /mo
                          </div>{" "}
                          <div className="text-12 text-ink-secondary mt-1">
                            Recurring monthly
                            {E.recurring.savings > 0 ? " (bundle pricing)" : ""}
                            {E.manualDiscount &&
                            (E.manualDiscount.recurringAmount ??
                              E.manualDiscount.amount) > 0
                              ? " + manual discount"
                              : ""}
                          </div>{" "}
                          <div className="flex justify-center gap-10 mt-3 flex-wrap">
                            {E.oneTime.total > 0 && (
                              <div className="text-center">
                                {" "}
                                <div className="text-18 font-medium text-zinc-900 u-nums">
                                  {fmtInt(E.oneTime.total)}
                                </div>{" "}
                                <div className="text-11 text-ink-secondary uppercase tracking-label">
                                  {E.oneTime.tmInstall > 0
                                    ? `One-Time (incl ${fmtInt(E.oneTime.tmInstall)} install)`
                                    : "Recurring Membership"}
                                </div>{" "}
                              </div>
                            )}
                            <div className="text-center">
                              {" "}
                              <div className="text-18 font-medium text-zinc-900 u-nums">
                                {fmt(E.totals.year1)}
                              </div>{" "}
                              <div className="text-11 text-ink-secondary uppercase tracking-label">
                                Year 1 Total
                              </div>{" "}
                            </div>
                            {E.recurring.savings > 0 && (
                              <div className="text-center">
                                {" "}
                                <div className="text-18 font-medium text-zinc-900 u-nums">
                                  -{fmt(E.recurring.savings)}
                                </div>{" "}
                                <div className="text-11 text-ink-secondary uppercase tracking-label">
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
                              <div className="bg-zinc-50 border-hairline border-zinc-300 rounded-sm px-4 py-3 mb-5 text-13 text-ink-secondary">
                                {" "}
                                <strong className="text-zinc-900">
                                  Recommended:
                                </strong>{" "}
                                {parts.join(" + ")} for comprehensive coverage
                                at {fmt(E.recurring.monthlyTotal)}/mo recurring.
                              </div>
                            );
                          })()}
                        {E.fieldVerify?.length > 0 && (
                          <div className="bg-alert-bg border-hairline border-alert-fg rounded-sm px-4 py-3 mb-5 text-13 text-alert-fg">
                            {" "}
                            <strong>Field Verify:</strong>
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

                    {/* Property Summary */}
                    <div className="mb-6">
                      {" "}
                      <SectionTitle>Property Summary</SectionTitle>{" "}
                      <div className="text-13 text-ink-secondary leading-relaxed">
                        {" "}
                        <strong className="text-zinc-900">
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
                            {" "}
                            <br />
                            Estimated value:{" "}
                            <strong className="text-zinc-900">
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
                            <Tag>{E.urgency.label}</Tag>
                          </>
                        )}
                        {E.recurringCustomer && (
                          <Tag>Recurring -15% one-time</Tag>
                        )}
                      </div>{" "}
                    </div>
                    {/* Pricing Modifiers */}
                    {E.modifiers?.length > 0 && (
                      <div className="mb-6">
                        {" "}
                        <SectionTitle>Pricing Modifiers</SectionTitle>{" "}
                        <div className="flex flex-col gap-1">
                          {E.modifiers.map((m, i) => (
                            <div
                              key={i}
                              className={cn(
                                "flex items-center gap-2 px-3 py-1.5 rounded-xs border-hairline",
                                m.type === "up"
                                  ? "border-zinc-300 bg-white"
                                  : m.type === "down"
                                    ? "border-zinc-300 bg-zinc-50"
                                    : "border-zinc-200 bg-white",
                              )}
                            >
                              {" "}
                              <span className="text-11 text-ink-tertiary flex-shrink-0 w-3 text-center">
                                {m.type === "up"
                                  ? "▲"
                                  : m.type === "down"
                                    ? "▼"
                                    : "·"}
                              </span>{" "}
                              <span className="text-12 text-ink-secondary flex-1">
                                {m.label}
                              </span>{" "}
                              <span className="text-11 font-medium text-zinc-900 u-nums">
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
                    {/* Recurring Programs */}
                    {E.hasRecurring && (
                      <>
                        {" "}
                        <GroupHeader>Recurring Programs</GroupHeader>
                        {R.lawn && (
                          <div className="mb-6">
                            {" "}
                            <SectionTitle>
                              Lawn Care
                              <Tag>
                                {R.lawnMeta?.lsf?.toLocaleString()} sf turf
                              </Tag>
                              {R.lawnMeta?.grassName && (
                                <Tag>{R.lawnMeta.grassName}</Tag>
                              )}
                            </SectionTitle>{" "}
                            <TierGridV2>
                              {R.lawn.map((t, i) => (
                                <TierRowV2
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
                            </TierGridV2>{" "}
                          </div>
                        )}
                        {R.pestTiers && (
                          <div className="mb-6">
                            {" "}
                            <SectionTitle>Pest Control</SectionTitle>{" "}
                            <TierGridV2>
                              {R.pestTiers.map((t, i) => (
                                <TierRowV2
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
                            </TierGridV2>
                            {R.pestInitialRoachPrice > 0 && (
                              <div className="text-11 text-ink-secondary mt-1">
                                {R.pestRoachMod === "GERMAN"
                                  ? "German"
                                  : "Native"}{" "}
                                roach initial is added as a one-time knockdown,
                                not a recurring per-visit premium.
                              </div>
                            )}
                          </div>
                        )}
                        {R.ts && (
                          <div className="mb-6">
                            {" "}
                            <SectionTitle>
                              Tree &amp; Shrub
                              <Tag>
                                {R.tsMeta?.eb} sf beds | {R.tsMeta?.et} trees
                              </Tag>
                              {R.tsMeta?.bedAreaIsEstimated && (
                                <FieldVerifyTag>FIELD VERIFY</FieldVerifyTag>
                              )}
                            </SectionTitle>{" "}
                            <TierGridV2>
                              {R.ts.map((t, i) => (
                                <TierRowV2
                                  key={i}
                                  name={t.name}
                                  detail={`${fmt(t.pa)}/app x ${t.v}`}
                                  price={`${fmt(t.mo)}/mo`}
                                  recommended={t.recommended}
                                  dimmed={t.dimmed}
                                />
                              ))}
                            </TierGridV2>{" "}
                          </div>
                        )}
                        {R.injection && (
                          <div className="mb-6">
                            {" "}
                            <SectionTitle>
                              Palm Injection{" "}
                              <Tag>{R.injection.palms} palms</Tag>{" "}
                            </SectionTitle>{" "}
                            <TierGridV2>
                              {" "}
                              <TierRowV2
                                name="Arborjet"
                                detail={
                                  R.injection.detail ||
                                  `${R.injection.palms} palms x $${R.injection.pricePerPalm || 75} x ${R.injection.appsPerYear || 2}/yr`
                                }
                                price={`${fmt(R.injection.mo)}/mo`}
                                recommended
                              />{" "}
                            </TierGridV2>{" "}
                          </div>
                        )}
                        {R.mq && (
                          <div className="mb-6">
                            {" "}
                            <SectionTitle>
                              Mosquito <Tag>Pressure {R.mqMeta?.pr}x</Tag>{" "}
                            </SectionTitle>{" "}
                            <TierGridV2>
                              {R.mq.map((t, i) => {
                                const flags = mosquitoTierSelectionFlags(R, t, i);
                                return (
                                  <TierRowV2
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
                            </TierGridV2>{" "}
                          </div>
                        )}
                        {R.tmBait && (
                          <div className="mb-6">
                            {" "}
                            <SectionTitle>
                              Termite Bait{" "}
                              <Tag>
                                {R.tmBait.quoteRequired || R.tmBait.requiresMeasurement
                                  ? "Quote Required"
                                  : `${R.tmBait.sta} sta | ${R.tmBait.perim} ft`}
                              </Tag>{" "}
                            </SectionTitle>{" "}
                            {R.tmBait.quoteRequired || R.tmBait.requiresMeasurement ? (
                              <div className="text-12 text-ink-secondary">
                                Footprint sqft or perimeter LF is required before pricing termite bait.
                              </div>
                            ) : (
                              <>
                                <TierGridV2>
                                  {" "}
                                  {R.tmBait.ai != null && (
                                    <TierRowV2
                                      name="Advance"
                                      detail={`${fmtInt(R.tmBait.ai)} install | Basic $35 | Premier $65/mo`}
                                      price="$35-65"
                                      recommended={R.tmBait.selectedSystem === "advance"}
                                      dimmed={R.tmBait.selectedSystem && R.tmBait.selectedSystem !== "advance"}
                                    />
                                  )}{" "}
                                  {R.tmBait.ti != null && (
                                    <TierRowV2
                                      name="Trelona"
                                      detail={`${fmtInt(R.tmBait.ti)} install | Basic $35 | Premier $65/mo`}
                                      price="$35-65"
                                      recommended={R.tmBait.selectedSystem === "trelona"}
                                      dimmed={R.tmBait.selectedSystem && R.tmBait.selectedSystem !== "trelona"}
                                    />
                                  )}{" "}
                                </TierGridV2>{" "}
                                <div className="text-11 text-ink-secondary mt-1">
                                  Install cost is a one-time setup fee, not a
                                  recurring charge
                                </div>{" "}
                              </>
                            )}
                          </div>
                        )}
                        {R.rodBaitMo && (
                          <div className="mb-6">
                            {" "}
                            <SectionTitle>
                              Rodent Bait Stations
                            </SectionTitle>{" "}
                            <TierGridV2>
                              {" "}
                              <TierRowV2
                                name="Monthly"
                                detail={`${R.rodBaitSize} property`}
                                price={`$${R.rodBaitMo}/mo`}
                                recommended
                              />{" "}
                            </TierGridV2>{" "}
                            <div className="text-11 text-ink-secondary mt-1">
                              Not included in bundle discount — priced
                              separately
                            </div>{" "}
                          </div>
                        )}
                      </>
                    )}

                    {/* One-Time Services */}
                    {E.hasOneTime && (
                      <>
                        {" "}
                        <GroupHeader>One-Time Services</GroupHeader>
                        {E.oneTime.items.map((item, i) => {
                          if (item.name === "Top Dressing" && R.tdTiers) {
                            return (
                              <div key={i} className="mb-6">
                                {" "}
                                <SectionTitle>
                                  Top Dressing
                                  {E.isRecurringCustomer && (
                                    <DiscBadge>-15%</DiscBadge>
                                  )}
                                </SectionTitle>{" "}
                                <TierGridV2>
                                  {R.tdTiers.map((t, j) => (
                                    <TierRowV2
                                      key={j}
                                      name={t.name}
                                      detail={t.detail}
                                      price={fmtInt(t.price)}
                                    />
                                  ))}
                                </TierGridV2>{" "}
                              </div>
                            );
                          }
                          if (item.name === "Trenching" && R.trench) {
                            return (
                              <div key={i} className="mb-6">
                                {" "}
                                <SectionTitle>
                                  Trenching
                                  {E.isRecurringCustomer && (
                                    <DiscBadge>-15%</DiscBadge>
                                  )}
                                </SectionTitle>{" "}
                                <TierGridV2>
                                  {item.productLabel && (
                                    <TierRowV2
                                      name="Product"
                                      detail={`${item.productLabel} | ${item.applicationRate || "standard"} | ${item.trenchDepthFt || 1} ft`}
                                      price={item.activeIngredient || ""}
                                    />
                                  )}
                                  {" "}
                                  <TierRowV2
                                    name="Treatment"
                                    detail={item.detail}
                                    price={fmtInt(item.price)}
                                  />{" "}
                                  {item.productSurcharge > 0 && (
                                    <TierRowV2
                                      name="Product Premium"
                                      detail="Premium product/rate surcharge"
                                      price={`+$${item.productSurcharge}`}
                                    />
                                  )}
                                  {item.warrantyAdder > 0 && (
                                    <TierRowV2
                                      name="Warranty"
                                      detail={item.warrantyTier || "Warranty"}
                                      price={`+$${item.warrantyAdder}`}
                                    />
                                  )}
                                  <TierRowV2
                                    name="Renewal"
                                    detail="Annual warranty"
                                    price="$325/yr"
                                    dimmed
                                  />{" "}
                                </TierGridV2>{" "}
                                <div className="text-12 text-ink-secondary italic mt-1">
                                  Best scheduled before rainy season (Apr-May)
                                </div>{" "}
                                {item.warningText && (
                                  <div className="text-11 text-ink-secondary mt-1">
                                    {item.warningText}
                                  </div>
                                )}
                                {item.allocatedChemicalCost !== undefined && (
                                  <div className="text-11 text-ink-secondary mt-1">
                                    Internal: {item.finishedGallons} gal | {item.productOz} oz | Chemical ${item.allocatedChemicalCost}
                                    {item.labelConfirmed ? " | Label confirmed" : " | Label review required"}
                                  </div>
                                )}
                              </div>
                            );
                          }
                          if (item.name === "Bora-Care") {
                            return (
                              <div key={i} className="mb-6">
                                {" "}
                                <SectionTitle>
                                  Bora-Care Attic
                                  {E.isRecurringCustomer && (
                                    <DiscBadge>-15%</DiscBadge>
                                  )}
                                  {item.atticIsEstimated && (
                                    <FieldVerifyTag>
                                      FIELD VERIFY ATTIC
                                    </FieldVerifyTag>
                                  )}
                                </SectionTitle>{" "}
                                <TierGridV2>
                                  {" "}
                                  <TierRowV2
                                    name="Treatment"
                                    detail={item.detail}
                                    price={fmtInt(item.price)}
                                  />{" "}
                                </TierGridV2>{" "}
                                <div className="text-12 text-ink-secondary italic mt-1">
                                  Best time: Oct-Mar (cooler attic temps)
                                </div>{" "}
                              </div>
                            );
                          }
                          if (item.name === "Pre-Slab") {
                            return (
                              <div key={i} className="mb-6">
                                {" "}
                                <SectionTitle>
                                  {item.displayName || "Pre-Slab Termiticide Treatment"}
                                  {E.isRecurringCustomer && (
                                    <DiscBadge>-15%</DiscBadge>
                                  )}
                                </SectionTitle>{" "}
                                <TierGridV2>
                                  {item.productLabel && (
                                    <TierRowV2
                                      name="Product"
                                      detail={item.productLabel}
                                      price={item.activeIngredient || ""}
                                    />
                                  )}
                                  {" "}
                                  <TierRowV2
                                    name="Treatment"
                                    detail={item.detail}
                                    price={fmtInt(item.basePrice || item.price)}
                                  />
                                  {item.warrAdd > 0 && (
                                    <TierRowV2
                                      name="5yr Warranty"
                                      detail="Extended transferable"
                                      price="+$200"
                                    />
                                  )}
                                </TierGridV2>
                                {!item.warrAdd && String(item.warrantyTier || "BASIC").toUpperCase() !== "NONE" && (
                                  <div className="text-11 text-ink-secondary mt-1">
                                    {item.warrantyStatus || "No extended warranty selected"}
                                  </div>
                                )}
                                {!item.warrAdd && String(item.warrantyTier || "").toUpperCase() === "NONE" && (
                                  <div className="text-11 text-ink-secondary mt-1">
                                    No warranty selected
                                  </div>
                                )}
                                {item.warningText && (
                                  <div className="text-11 text-ink-secondary mt-1">
                                    {item.warningText}
                                  </div>
                                )}
                                <div className="text-11 text-ink-secondary mt-1">
                                  Certificate of Compliance required{item.labelConfirmed ? " | Label confirmed" : " | Label review required"}
                                  {item.productCost !== undefined && item.rawPrice !== undefined
                                    ? ` | ${item.preSlabJobContextLabel || item.jobContext || "Standalone"} | ${item.productOz} oz | Allocated material $${item.productCost.toFixed(2)} | Raw $${item.rawPrice} | Floor $${item.contextualFloor || item.priceBeforeVolumeDiscount}`
                                    : ""}
                                </div>
                              </div>
                            );
                          }
                          if (item.name === "Foam Drill") {
                            return (
                              <div key={i} className="mb-6">
                                {" "}
                                <SectionTitle>
                                  Foam Drill
                                  {E.isRecurringCustomer && (
                                    <DiscBadge>-15%</DiscBadge>
                                  )}
                                </SectionTitle>{" "}
                                <TierGridV2>
                                  {" "}
                                  <TierRowV2
                                    name={item.tierName}
                                    detail={item.detail}
                                    price={fmtInt(item.price)}
                                  />{" "}
                                </TierGridV2>{" "}
                                <div className="text-11 text-ink-secondary mt-1">
                                  For localized drywood, wall voids, door/window
                                  frames
                                </div>{" "}
                              </div>
                            );
                          }
                          if (item.name === "Plugging") {
                            return (
                              <div key={i} className="mb-6">
                                {" "}
                                <SectionTitle>
                                  Plugging
                                  {E.isRecurringCustomer && (
                                    <DiscBadge>-15%</DiscBadge>
                                  )}
                                </SectionTitle>{" "}
                                <TierGridV2>
                                  {" "}
                                  <TierRowV2
                                    name={item.spacing}
                                    detail={item.detail}
                                    price={fmtInt(item.price)}
                                  />{" "}
                                </TierGridV2>
                                {item.warn6 && (
                                  <div className="text-11 text-ink-secondary mt-1">
                                    Sod may be more cost-effective at 6"
                                  </div>
                                )}
                              </div>
                            );
                          }
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
                          const isGeneralOneTimePest =
                            item.service === "one_time_pest" || item.name === "OT Pest";
                          return (
                            <div key={i} className="mb-6">
                              {" "}
                              <SectionTitle>
                                {displayName}
                                {E.isRecurringCustomer &&
                                  !item.noRecurringDiscount && (
                                    <DiscBadge>-15%</DiscBadge>
                                  )}
                              </SectionTitle>{" "}
                              <TierGridV2>
                                {" "}
                                <TierRowV2
                                  name={
                                    item.lawnType ||
                                    (isGeneralOneTimePest
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
                              </TierGridV2>{" "}
                            </div>
                          );
                        })}
                      </>
                    )}

                    {/* Specialty Pest */}
                    {E.specItems && E.specItems.length > 0 && (
                      <>
                        {" "}
                        <GroupHeader>Specialty Pest</GroupHeader>{" "}
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 mb-6">
                          {E.specItems.map((s, i) => (
                            <div
                              key={i}
                              className="bg-white border-hairline border-zinc-200 rounded-sm p-4"
                            >
                              {" "}
                              <div className="text-11 font-medium text-ink-secondary uppercase tracking-label mb-1">
                                {s.name}
                              </div>{" "}
                              <div className="text-18 font-medium text-zinc-900 u-nums">
                                {s.quoteRequired ? "Quote Required" : s.onProg ? "$0 — Included" : fmtInt(s.price)}
                              </div>{" "}
                              {serviceDetailText(s) && (
                                <div className="text-12 text-ink-secondary mt-1">
                                  {serviceDetailText(s)}
                                </div>
                              )}{" "}
                            </div>
                          ))}
                        </div>{" "}
                      </>
                    )}
                    {E.pricingMetadata && (
                      (E.pricingMetadata.skippedServices?.length > 0 ||
                        E.pricingMetadata.warnings?.length > 0 ||
                        E.pricingMetadata.manualReviewReasons?.length > 0) && (
                        <div className="mb-6 p-3 bg-zinc-50 border-hairline border-zinc-300 rounded-sm text-12 text-zinc-900">
                          <div className="font-semibold mb-1">Roach Routing Notes</div>
                          {(E.pricingMetadata.skippedServices || []).map((item, i) => (
                            <div key={`skip-${i}`} className="text-ink-secondary">
                              {item.skippedReason === "recurring_pest_initial_roach_already_covers_regular_roach"
                                ? "Skipped standalone native cockroach charge because recurring pest already includes Initial Native Roach Knockdown."
                                : item.skippedReason}
                            </div>
                          ))}
                          {(E.pricingMetadata.warnings || []).map((warning, i) => (
                            <div key={`warning-${i}`} className="text-ink-secondary">
                              {warning}
                            </div>
                          ))}
                          {(E.pricingMetadata.manualReviewReasons || []).map((reason, i) => (
                            <div key={`manual-review-${i}`} className="text-ink-secondary">
                              {humanizeQuoteReason(reason)}
                            </div>
                          ))}
                        </div>
                      )
                    )}

                    {/* Bundle + Totals */}
                    {(E.recurring.serviceCount > 0 ||
                      E.oneTime.total > 0 ||
                      E.recurring.rodentBaitMo > 0 ||
                      E.recurring.palmInjectionMo > 0) && (
                      <>
                        {" "}
                        <div className="h-px bg-zinc-200 my-4" />
                        {E.recurring.serviceCount > 0 && (
                          <div className="bg-zinc-50 border-hairline border-zinc-300 rounded-sm p-5 mb-6">
                            {" "}
                            <div className="text-18 font-medium text-zinc-900">
                              {E.recurring.serviceCount}-service bundle
                            </div>{" "}
                            <div className="text-13 text-ink-secondary mt-0.5">
                              {E.recurring.serviceCount} recurring service
                              {E.recurring.serviceCount > 1 ? "s" : ""} —{" "}
                              {Math.round(E.recurring.discount * 100)}% bundle
                              discount
                            </div>
                            {E.recurring.savings > 0 && (
                              <div className="text-zinc-900 text-14 font-medium mt-1">
                                Bundling saves{" "}
                                <span className="u-nums">
                                  {fmt(E.recurring.savings)}
                                </span>
                                /year
                              </div>
                            )}
                            <div className="grid grid-cols-[1fr_auto] gap-y-1 gap-x-4 text-13 mt-3 p-3 bg-white rounded-xs border-hairline border-zinc-200">
                              {E.recurring.services.map((s, i) => (
                                <React.Fragment key={i}>
                                  {" "}
                                  <div className="text-ink-secondary">
                                    {" "}
                                    <div>{s.displayName || s.name}</div>
                                    {s.detail && (
                                      <div className="text-11 text-ink-tertiary leading-snug mt-0.5">
                                        {s.detail}
                                      </div>
                                    )}
                                  </div>{" "}
                                  <div className="text-zinc-900 text-right u-nums">
                                    {fmt(s.mo)}/mo
                                  </div>{" "}
                                </React.Fragment>
                              ))}
                              <div className="font-medium text-zinc-900 border-t border-hairline border-zinc-200 pt-1 mt-1">
                                Total before discount
                              </div>{" "}
                              <div className="font-medium border-t border-hairline border-zinc-200 pt-1 mt-1 text-right text-zinc-900 u-nums">
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
                                  <div className="text-ink-secondary">
                                    {E.recurring.waveGuardTier} discount (-
                                    {Math.round(E.recurring.discount * 100)}%)
                                  </div>{" "}
                                  <div className="text-zinc-900 text-right u-nums">
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
                              <div className="font-medium text-zinc-900">
                                Your monthly rate
                              </div>{" "}
                              <div className="font-medium text-zinc-900 text-right u-nums">
                                {fmt(E.recurring.monthlyTotal)}/mo
                              </div>{" "}
                            </div>{" "}
                          </div>
                        )}
                        {/* Grand totals */}
                        <div className="bg-white border-hairline border-zinc-900 rounded-sm p-5">
                          {E.recurring.serviceCount > 0 && (
                            <div className="flex justify-between items-center py-1.5 text-14">
                              {" "}
                              <span className="text-ink-secondary">
                                Recurring (after bundle)
                              </span>{" "}
                              <span className="font-medium text-zinc-900 u-nums">
                                {fmt(E.recurring.annualAfterDiscount)}/yr (
                                {fmt(E.recurring.monthlyTotal)}/mo)
                              </span>{" "}
                            </div>
                          )}
                          {E.recurring.rodentBaitMo > 0 && (
                            <div className="flex justify-between items-center py-1.5 text-14">
                              {" "}
                              <span className="text-ink-secondary">
                                Rodent bait (separate)
                              </span>{" "}
                              <span className="font-medium text-zinc-900 u-nums">
                                {fmtInt(E.recurring.rodentBaitMo * 12)}/yr ($
                                {E.recurring.rodentBaitMo}/mo)
                              </span>{" "}
                            </div>
                          )}
                          {E.recurring.palmInjectionMo > 0 && (
                            <div className="flex justify-between items-center py-1.5 text-14">
                              {" "}
                              <span className="text-ink-secondary">
                                Palm injection (separate)
                              </span>{" "}
                              <span className="font-medium text-zinc-900 u-nums">
                                {fmtInt(
                                  E.recurring.palmInjectionAnn ||
                                    E.recurring.palmInjectionMo * 12,
                                )}
                                /yr ({fmt(E.recurring.palmInjectionMo)}/mo)
                              </span>{" "}
                            </div>
                          )}
                          {E.manualDiscount &&
                            (E.manualDiscount.recurringAmount ??
                              E.manualDiscount.amount) > 0 && (
                              <div className="flex justify-between items-center py-1.5 text-14">
                                {" "}
                                <span className="text-ink-secondary">
                                  {E.manualDiscount.label ||
                                    (E.manualDiscount.type === "PERCENT"
                                      ? `Discount (${E.manualDiscount.value}%)`
                                      : `Discount`)}
                                </span>{" "}
                                <span className="font-medium text-zinc-900 u-nums">
                                  -
                                  {fmt(
                                    E.manualDiscount.recurringAmount ??
                                      E.manualDiscount.amount,
                                  )}
                                  /yr
                                </span>{" "}
                              </div>
                            )}
                          {E.oneTime.tmInstall > 0 && (
                            <div className="flex justify-between items-center py-1.5 text-14">
                              {" "}
                              <span className="text-ink-secondary">
                                {`Termite bait install (${termiteBaitSystemLabel(
                                  R.tmBait?.selectedSystem ||
                                    R.tmBait?.system ||
                                    form.termiteBaitSystem,
                                )})`}
                              </span>{" "}
                              <span className="font-medium text-zinc-900 u-nums">
                                {fmtInt(E.oneTime.tmInstall)}
                              </span>{" "}
                            </div>
                          )}
                          {E.oneTime.otSubtotal > 0 && (
                            <>
                              {" "}
                              <div className="flex justify-between items-center py-2 text-14 border-t border-hairline border-zinc-200 mt-1.5">
                                {" "}
                                <span className="font-medium text-zinc-900">
                                  One-Time Services
                                </span>{" "}
                                <span className="font-medium text-zinc-900 u-nums">
                                  {fmtInt(
                                    E.oneTime.otSubtotal +
                                      (E.manualDiscount?.oneTimeAmount || 0),
                                  )}
                                </span>{" "}
                              </div>
                              {E.oneTime.items.map((item, i) => (
                                <div
                                  key={i}
                                  className="flex justify-between items-start gap-3 py-0.5 pl-4 text-13 text-ink-secondary"
                                >
                                  {" "}
                                  <span>
                                    {" "}
                                    <span>
                                      {item.name}
                                      {item.waivedWithPrepay ? (
                                        <span className="text-11 text-ink-tertiary ml-1">
                                          waived with annual prepay
                                        </span>
                                      ) : (
                                        ""
                                      )}
                                    </span>
                                    {item.detail && (
                                      <span className="block text-11 text-ink-tertiary leading-snug mt-0.5">
                                        {item.detail}
                                      </span>
                                    )}
                                  </span>{" "}
                                  <span className="text-13 u-nums">
                                    {fmtInt(item.price)}
                                  </span>{" "}
                                </div>
                              ))}
                              {E.oneTime.specItems.map((s, i) => (
                                <div
                                  key={`sp-${i}`}
                                  className="flex justify-between items-start gap-3 py-0.5 pl-4 text-13 text-ink-secondary"
                                >
                                  {" "}
                                  <span>
                                    {s.name}
                                    {serviceDetailText(s) && (
                                      <span className="block text-11 text-ink-tertiary leading-snug mt-0.5">
                                        {serviceDetailText(s)}
                                      </span>
                                    )}
                                  </span>{" "}
                                  <span className="text-13 u-nums">
                                    {s.quoteRequired ? "Quote Required" : fmtInt(s.price)}
                                  </span>{" "}
                                </div>
                              ))}
                              {E.manualDiscount &&
                                E.manualDiscount.oneTimeAmount > 0 && (
                                  <div className="flex justify-between items-start gap-3 py-0.5 pl-4 text-13 text-ink-secondary">
                                    {" "}
                                    <span>
                                      {E.manualDiscount.label ||
                                        (E.manualDiscount.type === "PERCENT"
                                          ? `Discount (${E.manualDiscount.value}%)`
                                          : `Discount`)}{" "}
                                      <span className="text-11 text-ink-tertiary">
                                        (one-time)
                                      </span>
                                    </span>{" "}
                                    <span className="text-13 u-nums">
                                      -{fmtInt(E.manualDiscount.oneTimeAmount)}
                                    </span>{" "}
                                  </div>
                                )}
                            </>
                          )}
                          <div className="flex justify-between items-center py-3 text-18 font-medium border-t-2 border-zinc-900 mt-2">
                            {" "}
                            <span className="text-zinc-900">
                              Year 1 Total
                            </span>{" "}
                            <span className="font-medium text-zinc-900 u-nums">
                              {fmt(E.totals.year1)}
                            </span>{" "}
                          </div>{" "}
                          <div className="flex justify-between items-center py-1.5 text-14">
                            {" "}
                            <span className="text-ink-secondary">
                              Year 2+ Annual
                            </span>{" "}
                            <span className="font-medium text-zinc-900 u-nums">
                              {fmt(E.totals.year2)}/yr ({fmt(E.totals.year2mo)}
                              /mo)
                            </span>{" "}
                          </div>{" "}
                        </div>{" "}
                      </>
                    )}
                      </div>
                    </details>
                  </div>{" "}
                </Card>{" "}
              </EstimateErrorBoundary>
            )}
          </div>{" "}
        </div>{" "}
      </div>{" "}
    </FormCtx.Provider>
  );
}
