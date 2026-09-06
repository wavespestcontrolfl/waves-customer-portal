import { useCustomerSms } from "../../components/admin/customer360/CustomerSmsPanel";
// Canonical admin estimate builder. Create and revise share service inputs
// and the server pricing path; preview uses the persisted customer renderer.
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
  applyServerRodentBaitBracketsPricingConfig,
  applyServerRodentSetupFeePricingConfig,
  applyServerRodentWaveguardPricingConfig,
  collectMarginReviewNotes,
  fmt,
  fmtInt,
  isCommercialEstimateInput,
  resolveLookupPropertyTypeAutofill,
  rodentBaitPolicyNote,
  rodentBaitWaveguardFlags,
  termiteBaitSelectionLabel,
  termiteBaitSystemLabel,
} from "../../lib/estimateEngine";
import { useNavigate } from "react-router-dom";
import { Button, Badge, Card, cn } from "../../components/ui";
import PestProductionDiagnosticsPanel from "../../components/admin/PestProductionDiagnosticsPanel";
import { ExternalLink } from "lucide-react";
import { useEstimateSend } from "../../components/admin/EstimateSendDialog";
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

// Plan status for the existing-customer chip. The hydrated edit-source
// payload carries the server's canonical membership verdict (hasActivePlan:
// sentinel tiers like Commercial are NOT members even with a rate; a
// rate-only member with a null tier IS one — raw tier truthiness gets both
// wrong). Customer-search rows don't carry the boolean, so they keep the
// legacy tier-truthiness reading and their rendering is unchanged.
function matchHasActivePlan(match) {
  if (!match) return false;
  if (typeof match.hasActivePlan === "boolean") return match.hasActivePlan;
  return !!(match.tier && match.tier !== "null");
}

// Where a customer's current per-application figure came from. The office
// needs to know whether a number is a real payment or an inference — an
// upgrade conversation built on a guess goes badly. Mirrors the spendSource
// values loadCurrentServiceSpendContext emits.
const SPEND_SOURCE_LABEL = {
  last_paid_invoice: "last paid invoice",
  scheduled_estimate: "scheduled price",
  prepaid_allocation: "prepaid allocation",
  per_application_fee: "billing stamp",
  monthly_rate_derived: "derived from monthly rate",
  mixed_basis: "mixed basis — see properties",
};

// A service active at more than one property is several contracts, each with
// its own per-application price. currentPerVisit sums them — that is the
// account's spend for the family, NOT one visit's charge — so rendering the
// sum beside "per application" would quote two $100 contracts as $200.00 and
// send staff into an upgrade conversation on a basis that doesn't exist.
// Those keys itemize instead.
function spendContractRows(service) {
  const contracts = Array.isArray(service?.contracts) ? service.contracts : [];
  return contracts.length > 1 ? contracts : [];
}

// Cadence + provenance detail, shared by the family row and each per-property
// contract row (both carry the same three fields).
function spendDetailParts(entry) {
  return [
    entry?.cadenceLabel,
    entry?.visitsPerYear ? `${entry.visitsPerYear}/yr` : null,
    SPEND_SOURCE_LABEL[entry?.spendSource] || null,
  ].filter(Boolean);
}

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
// Flea is sold ONLY as the two-visit Flea Elimination Package (owner ruling
// 2026-09-03: "flea should be two visits"); the single-visit knockdown is no
// longer selectable here. fleaOfferKey stays pinned to the package.
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

// Triage reason codes that mean the lead's address itself is still owed
// or unverified (call-routing-gates address_review lane, validation half).
const ADDRESS_ASK_REASONS = new Set([
  "missing_unit_number",
  "address_unverified",
  "missing_service_address",
  "low_confidence_address",
  "address_validation_unavailable",
  "address_unverifiable",
  "address_not_validated",
]);

// A dwelling unit designator anywhere in a typed address (the server's
// unit-scope model reads the same forms; "#" alone counts).

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

// The turf-relevant slice of the request-profile build, SHARED between
// doGenerate and the stale-imagery /turf-preview effect so the previewed
// number can never drift from the priced one (pre-push P1 #3098 — the
// preview once kept the lookup-time footprint while doGenerate recomputed
// it). Every transform here reaches computeTurfArea through
// translateV2CallToV1Input: dims + bed area (blank field → explicit 0),
// the footprintUnknown clear + footprint recompute, pool/cage (hardscape),
// densities/complexity (turf-factor score), and propertyType (hardscape
// brackets). Service-specific fields (palms, trenching, Bora-Care, slab,
// commercial) stay in doGenerate — they don't feed turf.
function buildTurfRequestProfile(baseProfile, form) {
  const manualNumber = (value, fallback = 0) => {
    const n = parseInt(value, 10);
    return Number.isFinite(n) ? n : fallback;
  };
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
    bedAreaSource: form._manualFields?.includes("bedArea") && parseNonNegativeNumber(form.bedArea) !== undefined
      ? "manual" : baseProfile.bedAreaSource,
  };
  // footprintUnknown (association aggregate, story count unknown): the
  // summed living area over a defaulted story count is NOT a ground-floor
  // footprint — deriving one here would hand pricing the exact fake slab
  // the lookup suppressed (codex P1 #2721). A story count the operator
  // MANUALLY entered supplies exactly the missing datum, so the flag
  // clears and derivation (and footprint-driven pricing) resumes off the
  // corrected value (codex P2 r7 #2721). The edit flag alone is not
  // enough — a cleared/invalid Stories box would fall back to the
  // default and re-derive the fake slab (codex P2 r8 #2721).
  if (
    profile.footprintUnknown === true &&
    form._storiesEdited &&
    Number(form.stories) >= 1
  )
    profile.footprintUnknown = false;
  if (profile.homeSqFt && profile.footprintUnknown !== true)
    profile.footprint = Math.round(profile.homeSqFt / (profile.stories || 1));
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
  profile.shrubDensity = form.shrubDensity || profile.shrubDensity;
  profile.treeDensity = form.treeDensity || profile.treeDensity;
  profile.landscapeComplexity =
    form.landscapeComplexity || profile.landscapeComplexity;
  profile.nearWater = form.nearWater === "YES" ? "YES" : "NO";
  profile.propertyType = form.propertyType || profile.propertyType;
  // Commercial classification follows the FORM, exactly like the pricing
  // request — a lookup-classified commercial corrected to residential (or
  // vice versa) must preview through the same branch it will price through
  // (commercial changes the hardscape model; pre-push P1 #3098).
  const formIsCommercial = isCommercialEstimateInput(form);
  profile.isCommercial = formIsCommercial;
  profile.commercialSubtype = formIsCommercial ? form.commercialSubtype || null : null;
  profile.commercialRiskType = formIsCommercial ? form.commercialRiskType || null : null;
  profile.commercialPestCadence = formIsCommercial ? form.commercialPestCadence || null : null;
  profile.commercialInteriorService = formIsCommercial ? form.commercialInteriorService || null : null;
  profile.commercialLawnCadence = formIsCommercial ? form.commercialLawnCadence || null : null;
  profile.treeShrubDensity = formIsCommercial ? form.treeShrubDensity || null : null;
  profile.mosquitoPressure = formIsCommercial ? form.mosquitoPressure || null : null;
  return profile;
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

// The server recomputes the authoritative price on save (pricing-constant
// changes, existing-customer combined-tier fold). A difference from the
// client preview needs the operator's eyes: banner after a draft save,
// blocking confirm before an edit-mode publish or a send.
function serverRecomputeNotice(saveResponse, clientMonthly, clientOnetime) {
  const serverMonthly = Number(saveResponse.monthlyTotal);
  const serverOnetime = Number(saveResponse.onetimeTotal);
  const monthlyDiffers =
    Number.isFinite(serverMonthly) &&
    Math.abs(serverMonthly - (clientMonthly || 0)) >= 0.5;
  const onetimeDiffers =
    Number.isFinite(serverOnetime) &&
    Math.abs(serverOnetime - (clientOnetime || 0)) >= 0.5;
  if (!(monthlyDiffers || onetimeDiffers) || saveResponse.pricingAuthority !== "SERVER") {
    return null;
  }
  return {
    serverMonthly: monthlyDiffers ? serverMonthly : null,
    clientMonthly: monthlyDiffers ? clientMonthly || 0 : null,
    serverOnetime: onetimeDiffers ? serverOnetime : null,
    clientOnetime: onetimeDiffers ? clientOnetime || 0 : null,
  };
}

function describeRecomputeNotice(notice) {
  const parts = [];
  if (notice.serverMonthly != null) {
    parts.push(
      `$${notice.serverMonthly.toFixed(2)}/mo (preview showed $${Number(notice.clientMonthly || 0).toFixed(2)}/mo)`,
    );
  }
  if (notice.serverOnetime != null) {
    parts.push(
      `$${notice.serverOnetime.toFixed(2)} one-time (preview showed $${Number(notice.clientOnetime || 0).toFixed(2)})`,
    );
  }
  return parts.join(", ");
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
            Estimate render error
          </div>{" "}
          <pre className="text-14 text-ink-secondary mb-4 whitespace-pre-wrap text-left max-h-48 overflow-auto">
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
  const control = React.Children.toArray(children).find((child) => child?.props?.k);
  return (
    <div className={cn("mb-4", className)}>
      {" "}
      <label htmlFor={control ? `estimate-${control.props.k}` : undefined} className="block text-14 font-medium text-zinc-900 mb-2">
        {label}
      </label>
      {children}
    </div>
  );
}

const INPUT_CLS =
  "w-full h-11 px-3 text-16 text-zinc-900 bg-white border-hairline border-zinc-300 " +
  "rounded-sm u-focus-ring placeholder:text-ink-disabled";

const CONTACT_FIELDS = new Set([
  "leadId",
  "customerId",
  "customerName",
  "customerPhone",
  "customerEmail",
]);
// Measurements and property facts cannot follow a draft to another address.
// Cadence and service selections remain available for the new property.
const PROPERTY_FORM_FIELDS = [
  "homeSqFt", "lotSqFt", "stories", "unitCount", "propertyType", "isCommercial",
  "commercialSubtype", "commercialRiskType", "hasPool", "hasPoolCage", "poolCageSize",
  "shrubDensity", "treeDensity", "landscapeComplexity", "nearWater", "bedArea",
  "palmCount", "palmTreatmentCount", "palmDbhInches", "treeCount", "measuredTurfSf",
  "termiteFootprintSqFt", "termitePerimeterLF", "trenchingPerimeterLF",
  "trenchingConcreteLF", "trenchingDirtLF", "boracareSqft", "boracareSurfaceLinearFt",
  "trenchingConcretePct", "trenchingEstimateFromFootprint", "trenchingLabelConfirmed",
  "boracareSurfaceHeightFt", "preslabSqft", "preslabLabelConfirmed", "plugArea",
  "topDressArea", "fleaExteriorAreaSqFt", "fleaExteriorAreaSource", "fleaExteriorZones",
  "palmDiagnosisConfirmed", "palmLicensedApplicator", "palmHighDose", "palmLargeDiameter",
  "palmNonstandardProduct", "_termiteFootprintAuto", "_trenchingPerimeterAuto",
  "_boracareSqftAuto", "_preslabSqftAuto", "_palmCountAuto",
];
const SEND_FIELDS = new Set(["scheduleSend", "scheduledAt"]);
const DELIVERY_OPTION_FIELDS = new Set(["showOneTimeOption", "billByInvoice"]);
const ONE_TIME_PEST_CHOICE = { floor: 199, multiplier: 2.2 };
// The four rodent-guarantee eligibility confirmations. They are per-job
// affirmations (work actually completed for THIS property), so they must reset
// on a fresh estimate / customer-or-address change / when the guarantee toggle
// is turned off — and any change must invalidate a generated estimate, since
// all four gate whether RODENT_GUARANTEE prices at all.
const RODENT_GUARANTEE_ELIGIBILITY_KEYS = [
  "rgTrappingCompleted",
  "rgExclusionCompleted",
  "rgSanitationBaseline",
  "rgNoActivityAfterFinalCheck",
];

// Per-job eligibility confirmations that must never survive a property/
// customer identity change or a "next estimate" reset: the rodent-guarantee
// flags plus the bermuda-suppression add-on (its cultivar / season / turf-
// stress / %-infestation eligibility is verified per lawn, never carried to
// another property).
const PER_JOB_ELIGIBILITY_KEYS = [
  ...RODENT_GUARANTEE_ELIGIBILITY_KEYS,
  "bermudaSuppression",
];

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

// deferInvoiceTotals: the commercial-proposal handoff saves a manual-quote
// draft whose totals are zero until the proposal line items are authored —
// the proposal PUT recomputes the billable totals immediately after, so the
// zero-total bill-by-invoice guard below would block that flow at the save.
function validateDeliveryOptions(form, estimate, { deferInvoiceTotals = false } = {}) {
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
  if (form.billByInvoice && !deferInvoiceTotals && oneTimeAmount <= 0 && recurringAmount <= 0) {
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

// The satellite analyzer emits SPARSE for low vegetation density; the form
// dropdowns and pricing engine only know LIGHT/MODERATE/HEAVY.
function normalizeDensityValue(value) {
  const v = String(value || "").toUpperCase();
  if (v === "SPARSE") return "LIGHT";
  return ["LIGHT", "MODERATE", "HEAVY"].includes(v) ? v : undefined;
}

function lookupTermiteFootprintSqFt(data = {}) {
  // Association aggregates with unknown stories publish footprintUnknown —
  // deriving homeSqFt/stories here would prefill a summed-living-area
  // "slab" the lookup explicitly refused to claim (codex P1 #2721).
  if (data.footprintUnknown === true) return undefined;
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
      id={`estimate-${k}`}
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
      id={`estimate-${k}`}
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
    <label className="relative flex items-center gap-2.5 min-h-11 mb-1 cursor-pointer text-14 text-zinc-900 select-none focus-within:ring-2 focus-within:ring-zinc-900 focus-within:rounded-sm">
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
        style={{ fontSize: 15, fontWeight: 500 }}
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
      style={{ fontSize: 15, fontWeight: 500 }}
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
        " text-14 px-3 py-2 rounded-xs mb-3 whitespace-pre-line border-hairline",
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
        {selected && <span className="text-14 u-nums"></span>}
        {!selected && recommended && (
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-900"
            title="Recommended"
          />
        )}
      </div>{" "}
      <div className="text-14 text-ink-secondary break-words">{detail}</div>{" "}
      <div className="text-14 font-medium text-zinc-900 text-right u-nums">
        {price}
      </div>{" "}
    </div>
  );
}

function Tag({ children }) {
  return (
    <span className="inline-block text-14 font-medium uppercase tracking-label px-2 py-0.5 rounded-xs bg-zinc-100 text-ink-secondary ml-2 align-middle">
      {children}
    </span>
  );
}

function FieldVerifyTag({ children }) {
  return (
    <span className="inline-block text-14 font-medium uppercase tracking-label px-2 py-0.5 rounded-xs bg-alert-bg text-alert-fg ml-2 align-middle">
      {children}
    </span>
  );
}

function DiscBadge({ children }) {
  return (
    <span className="inline-block text-14 font-medium uppercase tracking-label px-2 py-0.5 rounded-xs bg-zinc-900 text-white ml-2 align-middle u-nums">
      {children}
    </span>
  );
}

function GroupHeader({ children }) {
  return (
    <div className="text-22 font-bold tracking-tight text-zinc-900 mt-7 mb-3 md:text-14 md:font-medium md:uppercase md:tracking-label md:mb-4 md:pb-2 md:border-b-hairline md:border-zinc-300">
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

function selectedPestTierForPreview(R, form) {
  const tiers = Array.isArray(R?.pestTiers) ? R.pestTiers : [];
  if (!tiers.length) return null;
  return (
    tiers.find((t) => String(t.apps) === String(form.pestFreq)) ||
    tiers.find((t) => t.recommended) ||
    tiers[0]
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

function RoachOverrideAppliedNote({ estimate, variant }) {
  const item = (estimate?.oneTime?.items || []).find(
    (it) =>
      it.service === "pest_initial_roach" &&
      (variant === "standalone" ? it.standalone : it.autoFiredFromRecurringPest),
  );
  if (!item || !item.priceOverridden) return null;
  return (
    <div className="text-14 text-ink-secondary mt-1">
      Override applied: {fmtInt(item.price)} on the generated estimate
      {Number.isFinite(Number(item.bracketPrice))
        ? ` (engine bracket price ${fmtInt(item.bracketPrice)})`
        : ""}
      .
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════
// MAIN COMPONENT — EstimateToolViewV2
// ═══════════════════════════════════════════════════════════════
export default function EstimateToolViewV2({
  initialLeadId = "",
  initialCustomerId = "",
  initialAddress = "",
  initialCustomerName = "",
  initialCustomerPhone = "",
  initialCustomerEmail = "",
  initialServiceInterest = "",
  // When set, the builder reopens this existing estimate for in-place editing:
  // the form seeds from its saved inputs and Save PUTs a revision instead of
  // creating a new estimate (the customer's link stays the same).
  editEstimateId = "",
  onDraftSaved,
  onBack,
  onStartNew,
} = {}) {
  const navigate = useNavigate();
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
        set("address", p.formatted_address);
      }
    });
    autocompleteRef.current = ac;
  }

  // ── form state (verbatim from V1) ─────────────────────────────
  // Blank builder form. A function (not a literal in useState) so edit mode
  // can re-seed the form from a saved estimate's stored inputs merged over
  // these defaults — fields added to the builder after that estimate was
  // saved still initialize instead of arriving undefined.
  const buildDefaultEstimateForm = ({
    leadId = "",
    customerId = "",
    address = "",
    customerName = "",
    customerPhone = "",
    customerEmail = "",
    serviceInterest = "",
  } = {}) => ({
    leadId,
    customerId,
    address,
    customerName,
    customerPhone,
    customerEmail,
    leadServiceInterest: serviceInterest,
    homeSqFt: "",
    stories: "1",
    unitCount: "",
    lotSqFt: "",
    propertyType: "Single Family",
    isCommercial: "NO",
    commercialSubtype: "",
    commercialRiskType: "",
    commercialPestCadence: "",
    commercialInteriorService: "",
    commercialLawnCadence: "",
    treeShrubDensity: "",
    mosquitoPressure: "",
    commercialPricingMode: "manual_quote",
    hasPool: "NO",
    hasPoolCage: "NO",
    poolCageSize: "MEDIUM",
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
    tsTier: "standard",
    tsAccess: "easy",
    roachModifier: "NONE",
    roachFeeOverride: "",
    standaloneRoachFeeOverride: "",
    lawnFreq: "9",
    bermudaSuppression: false,
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
    rodentTrappingEmergency: false,
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
    // Trelona-only menu (owner 2026-07-28); tier is a retired concept the
    // API still accepts.
    termiteBaitSystem: "trelona",
    termiteMonitoringTier: "basic",
    termiteBondTerm: "none",
    termiteOwnership: "own",
    termiteScope: "bait_monitoring_no_warranty",
    trenchingPerimeterLF: "",
    trenchingConcreteLF: "",
    trenchingDirtLF: "",
    trenchingConcretePct: "",
    trenchingEstimateFromFootprint: false,
    trenchingProductKey: "taurus_sc",
    trenchingApplicationRate: "standard",
    trenchingDepthFt: "0.5",
    trenchingWarrantyTier: "one_year_retreat",
    trenchingLabelConfirmed: false,
    foamPoints: "5",
    foamRecurringPoints: "5",
    foamRecurringFreq: "quarterly",
    roachType: "REGULAR",
    svcLawn: false,
    svcPest: false,
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
    stingSpecies: "PAPER_WASP",
    stingTier: "2",
    stingRemoval: "NONE",
    stingAggressive: "NO",
    stingHeight: "GROUND",
    stingConfined: "NO",
    svcRoach: false,
    svcBedbug: false,
    svcExclusion: false,
    svcRodentGuarantee: false,
    rgTrappingCompleted: false,
    rgExclusionCompleted: false,
    rgSanitationBaseline: false,
    rgNoActivityAfterFinalCheck: false,
    showOneTimeOption: false,
    billByInvoice: false,
  });

  function clearedPropertyFields() {
    const defaults = buildDefaultEstimateForm();
    return {
      ...Object.fromEntries(PROPERTY_FORM_FIELDS.map((field) => [field, defaults[field] ?? ""])),
      propertyId: "", _manualFields: [], _unitCountEdited: false,
    };
  }

  const [form, setForm] = useState(() =>
    buildDefaultEstimateForm({
      leadId: initialLeadId,
      customerId: initialCustomerId,
      address: initialAddress,
      customerName: initialCustomerName,
      customerPhone: initialCustomerPhone,
      customerEmail: initialCustomerEmail,
      serviceInterest: initialServiceInterest,
    }),
  );

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
      if (initialAddress && initialAddress !== f.address) Object.assign(next, clearedPropertyFields());
      else if (prefillIdentityChanged) next.measuredTurfSf = "";
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

  // Per-job eligibility confirmations (rodent-guarantee flags + the bermuda-
  // suppression add-on) never survive an identity change. A rep can change the
  // property/customer identity through many paths (prefill props, address
  // autocomplete, property lookup, customer search, manual edits) that each call
  // setForm directly, so enforce the reset centrally: whenever the address or
  // customer identity changes, drop the flags so neither the guarantee nor the
  // cultivar/season-gated suppression program can be re-priced for a new
  // property without fresh confirmation. (toggle() still clears the rg* flags
  // when the guarantee is switched off; nextEstimate resets everything.)
  const rgIdentityKey = `${form.address || ""}|${form.customerId || ""}|${form.customerName || ""}|${form.customerEmail || ""}`;
  const rgIdentityRef = useRef(rgIdentityKey);
  useEffect(() => {
    if (rgIdentityRef.current === rgIdentityKey) return;
    rgIdentityRef.current = rgIdentityKey;
    // Only act when confirmations were actually set, so a plain address/contact
    // edit on a non-guarantee estimate never needlessly wipes a valid quote.
    if (!PER_JOB_ELIGIBILITY_KEYS.some((k) => form[k])) return;
    setForm((f) => {
      const next = { ...f };
      for (const k of PER_JOB_ELIGIBILITY_KEYS) next[k] = false;
      return next;
    });
    // The generated estimate baked the (now-reset) flags into its engineRequest;
    // invalidate it so a stale guarantee line can't be saved or sent.
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
  }, [rgIdentityKey, form]);

  // Leaving the St. Augustine track clears the suppression confirmation too —
  // hiding the checkbox alone would let a track round-trip restore it checked
  // and price the add-on without fresh cultivar/season verification (same
  // per-job rule as the lawn-deselect / identity / next-estimate resets).
  useEffect(() => {
    if (form.grassType !== "st_augustine" && form.bermudaSuppression) {
      setForm((f) => ({ ...f, bermudaSuppression: false }));
    }
  }, [form.grassType, form.bermudaSuppression]);

  // Live rodent WaveGuard posture (codex #3591 r34 P1): module state the
  // rodent pricing-config loader effect below mutates; mirrored here so the
  // preview memo re-runs once the live rows land (the bracket helper reads
  // the same freshly-applied module state on that re-run).
  const [rodentWaveguardPosture, setRodentWaveguardPosture] = useState(() => rodentBaitWaveguardFlags());
  // ── live preview (verbatim from V1) ───────────────────────────
  const livePreview = useMemo(() => {
    const commercialDetected = isCommercialEstimateInput(form);
    const qualifyingRecurringKeys = [
      "svcLawn",
      "svcPest",
      "svcTs",
      "svcMosquito",
      "svcTermiteBait",
      // Rodent bait counts toward the tier ONLY while the live
      // rodent_waveguard.tier_qualifier flag says so (codex #3591 r33 P1) —
      // the same mechanism calculateEstimate and the server engine read, so
      // the preview never advertises a Silver a Bronze estimate won't give.
      // Read from the mirrored posture state, which the loader effect
      // refreshes after the live row applies (codex #3591 r34 P1).
      ...(rodentWaveguardPosture.tierQualifier !== false ? ["svcRodentBait"] : []),
    ];
    const separateRecurringKeys = ["svcInjection", "svcFoamRecurring"];
    // ALL commercial pest-family services now auto-price as recurring lines
    // (lawn, pest, tree/shrub, mosquito, termite-bait, rodent-bait). None collapse
    // to a manual commercial quote.
    const commercialAutoKeys = ["svcLawn", "svcPest", "svcTs", "svcMosquito", "svcTermiteBait", "svcRodentBait"];
    // Mirror the server commercial pricers' real-size gates so the preview's
    // auto-priced vs manual buckets match what Generate Estimate produces:
    //   • lawn / tree → lot-derivable turf/bed, always auto-price.
    //   • pest / rodent-bait → need a real BUILDING footprint (home size). The
    //     server derives their footprint from homeSqFt only — the termite-specific
    //     measurements do NOT feed them.
    //   • termite-bait → a home size OR an admin-entered termite footprint/perimeter
    //     measurement (priceCommercialTermiteBait consumes those).
    //   • mosquito → needs a real LOT (treatable outdoor area).
    // Without this the sidebar would call a selection "ready as recurring" when
    // Generate Estimate will actually produce a manual quote.
    const hasCommercialHomeSize = Number(form.homeSqFt) > 0;
    const hasCommercialTermiteSize =
      hasCommercialHomeSize ||
      Number(form.termiteFootprintSqFt) > 0 ||
      Number(form.termitePerimeterLF) > 0;
    const hasCommercialLotSize = Number(form.lotSqFt) > 0;
    // Mirror of the server termiteScope gate: auto-price ONLY a recognized auto
    // scope — bond / warranty / initial-install AND any unrecognized value fail
    // closed to a manual quote regardless of building size.
    const COMMERCIAL_TERMITE_AUTO_SCOPES = new Set(["inspection_only", "monitoring_only", "bait_monitoring_no_warranty"]);
    const commercialKeyFallsToManual = (k) => {
      if (k === "svcMosquito") return !hasCommercialLotSize;
      if (k === "svcTermiteBait") return !hasCommercialTermiteSize || !COMMERCIAL_TERMITE_AUTO_SCOPES.has(form.termiteScope || "bait_monitoring_no_warranty");
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
    // NEVER count toward the WaveGuard bundle tier or its % discount. So for a
    // commercial estimate the WaveGuard recurringCount is 0 and the preview shows
    // a commercial non-member state, not a fake multi-service bundle discount.
    const recurringCount = commercialDetected
      ? 0
      : qualifyingRecurringKeys.filter((k) => form[k]).length;
    // For commercial, palm/foam separate-recurring keys are counted here; a commercial
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
      "svcRodentGuarantee",
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
      anySelected,
    };
  }, [form, rodentWaveguardPosture]);

  const [estimate, setEstimateState] = useState(null);
  // Monotonic invalidation version for the generated estimate. Every
  // setEstimate(null) bumps it; doGenerate snapshots it at start and discards
  // its result if an invalidation landed while /calculate-estimate was in
  // flight — otherwise the resolving generate re-mounts a price computed from
  // pre-edit inputs, and Save would persist that stale engineRequest (which
  // the server replays verbatim, so the recompute agrees with the stale price
  // and no drift notice fires).
  const estimateVersionRef = useRef(0);
  const setEstimate = useCallback((value) => {
    if (value === null) estimateVersionRef.current += 1;
    setEstimateState(value);
  }, []);
  // Address-lookup guards (same seq+abort pattern as the send-phone lookup
  // below): a slow property/customer response for a PREVIOUS address must
  // never autofill — or stamp its customer match onto — a newer one.
  const lookupSeqRef = useRef(0);
  const lookupAbortRef = useRef(null);
  // The address a unit-scoped lookup was run for — the satellite guard
  // below keys on it, not on the (possibly stale) profile alone, so editing
  // the address after a unit lookup re-enables the standalone analysis
  // (codex r2 P2).
  const unitLookupAddressRef = useRef("");
  // Live mirror of form.address for the in-flight lookup's apply gate: the
  // seq only advances when ANOTHER lookup starts, so an address
  // edit/select/clear during a lookup needs its own invalidation — the
  // response is compared against the address the form holds NOW before
  // anything (property autofill, customer match) applies.
  const formAddressRef = useRef("");
  const [savedId, setSavedId] = useState(null);
  const [savedViewUrl, setSavedViewUrl] = useState(null);
  useEffect(() => {
    formAddressRef.current = String(form.address || "");
  }, [form.address]);
  // Set when the server-authoritative price (Decision #2) differs from the
  // client preview at save time, so the operator isn't left quoting a stale number.
  const [priceRecomputeNotice, setPriceRecomputeNotice] = useState(null);
  // Server-detected unlinked-member save (2026-08-10): the typed address
  // matches an active member but no customer was linked, so the combined
  // WaveGuard tier was NOT applied — surfaced beside the saved totals so the
  // operator links and re-saves before sending.
  const [memberLinkageWarning, setMemberLinkageWarning] = useState(null);
  const [lookupStatus, setLookupStatus] = useState({ type: "", msg: "" });
  const [customerSearch, setCustomerSearch] = useState("");
  const [customers, setCustomers] = useState([]);
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState(false);
  const openSend = useEstimateSend();
  const token = localStorage.getItem("waves_admin_token");
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };

  function formFromEditSource(d) {
    return {
          ...buildDefaultEstimateForm(),
          ...(d.inputs || {}),
          // Live contact columns win over the stored form snapshot, and a
          // revise never re-links a lead — the row keeps its own linkage
          // server-side, so the form's leadId must stay blank here.
          leadId: "",
          customerId: d.customerId || "",
          propertyId: d.propertyId || "",
          address: d.address || "",
          customerName: d.customerName || "",
          customerPhone: d.customerPhone || "",
          customerEmail: d.customerEmail || "",
          // Delivery flags too: the pipeline's 1×-option / invoice-mode
          // toggles PATCH the row columns after the original save, so the
          // stored inputs snapshot can be stale — saving it back would
          // silently flip the row's settings.
          showOneTimeOption: !!d.showOneTimeOption,
          billByInvoice: !!d.billByInvoice,
          // Row notes win over the inputs snapshot for the same reason —
          // lead/webhook/automation rows carry notes the builder never wrote,
          // and the revise PUT sends form.notes back verbatim; seeding ""
          // would erase them on a service-only edit.
          notes: d.notes || "",
        };
  }

  // ── Edit mode: reopen an existing estimate for in-place revision ──
  // Loaded from GET /:id/edit-source. `hasInputs` is false for estimates
  // created outside the builder (lead auto-send / agent drafts) — those seed
  // contact fields only and the operator rebuilds the quote before saving.
  const [editMode, setEditMode] = useState(null);
  const [editLoadError, setEditLoadError] = useState(null);
  useEffect(() => {
    if (!editMode || !/^#estimate-(customer|services|pricing|review)$/.test(window.location.hash)) return;
    requestAnimationFrame(() => document.querySelector(window.location.hash)?.scrollIntoView({ block: "start" }));
  }, [editMode?.id]);
  const [saveError, setSaveError] = useState("");
  const saveInFlightRef = useRef(false);
  const draftIdRef = useRef(null);
  const savedFormRef = useRef(JSON.stringify(form));
  const formRef = useRef(form);
  formRef.current = form;
  const dirty = JSON.stringify(form) !== savedFormRef.current;
  const openMessages = useCustomerSms();
  useEffect(() => {
    if (!dirty) return undefined;
    const beforeUnload = (event) => { event.preventDefault(); event.returnValue = ""; };
    const guardLink = (event) => {
      const link = event.target.closest?.("a[href]");
      if (!link || link.target === "_blank" || event.metaKey || event.ctrlKey || link.hash) return;
      if (!window.confirm("Leave this estimate with unsaved changes?")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    // Browser Back/Forward does not click an anchor. BrowserRouter tracks
    // an index on each entry, letting cancellation restore that entry before
    // its ordinary popstate listener can unmount this unsaved editor.
    const entryIndex = window.history.state?.idx;
    let restoring = false;
    const guardHistory = (event) => {
      if (restoring) { restoring = false; event.stopImmediatePropagation(); return; }
      const nextIndex = event.state?.idx;
      if (!Number.isInteger(entryIndex) || !Number.isInteger(nextIndex) || entryIndex === nextIndex) return;
      if (window.confirm("Leave this estimate with unsaved changes?")) return;
      event.stopImmediatePropagation();
      restoring = true;
      window.history.go(entryIndex - nextIndex);
    };
    window.addEventListener("popstate", guardHistory, true);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", guardLink, true);
    return () => {
      window.removeEventListener("popstate", guardHistory, true);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", guardLink, true);
    };
  }, [dirty]);

  // Multi-property group: anchor id set when the operator chains "Add another
  // property" off a saved estimate (the next save joins the anchor's group via
  // groupWithEstimateId), plus the sibling list the group strip renders.
  const [groupAnchorId, setGroupAnchorId] = useState(null);
  const [groupEstimates, setGroupEstimates] = useState([]);
  const groupSourceId = savedId || editMode?.id || groupAnchorId;
  useEffect(() => {
    if (!groupSourceId) {
      setGroupEstimates([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/admin/estimates/${groupSourceId}/group`, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          },
        });
        if (!r.ok) return;
        const d = await r.json().catch(() => ({}));
        if (!cancelled) {
          setGroupEstimates(Array.isArray(d.estimates) ? d.estimates : []);
        }
      } catch {
        /* the group strip is informational — never block the builder */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [groupSourceId]);

  // Call-intake tie-in: when this estimate is being built from a lead whose
  // call extraction captured ADDITIONAL properties ("my home and my rental"),
  // surface them so the operator can chain grouped estimates instead of the
  // extra addresses dying in leads.extracted_data.
  const [leadAdditionalProperties, setLeadAdditionalProperties] = useState([]);
  const activeLeadId = form.leadId || initialLeadId || "";
  useEffect(() => {
    if (!activeLeadId) {
      // Mid-group chaining drops form.leadId (the sibling draft must not
      // re-link the lead), but the extracted address list must survive so a
      // 3+ property call can keep chaining (codex #3244 r3). Only a true
      // context reset (no group in progress) clears it.
      if (!groupAnchorId) setLeadAdditionalProperties([]);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`/api/admin/leads/${activeLeadId}`, {
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          },
        });
        if (!r.ok) return;
        const d = await r.json().catch(() => ({}));
        let extracted = d?.lead?.extracted_data;
        if (typeof extracted === "string") {
          try {
            extracted = JSON.parse(extracted);
          } catch {
            extracted = null;
          }
        }
        const list = Array.isArray(extracted?.additional_properties)
          ? extracted.additional_properties.filter(
            (p) => p && String(p.address_line1 || "").trim(),
          )
          : [];
        if (!cancelled) setLeadAdditionalProperties(list);
      } catch {
        /* informational only — never block the builder */
      }
    })();
    return () => {
      cancelled = true;
    };
    // groupAnchorId is a dependency so a group RESET (anchor cleared with no
    // lead active) reruns the empty-ID branch and clears the extracted list —
    // otherwise a previous lead's addresses could chain onto the next
    // customer's group (codex #3244 r4).
  }, [activeLeadId, groupAnchorId]);

  useEffect(() => {
    if (!editEstimateId || editEstimateId === editMode?.id) return undefined;
    let cancelled = false;
    (async () => {
      setEditLoadError(null);
      try {
        const r = await fetch(
          `/api/admin/estimates/${editEstimateId}/edit-source`,
          {
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
            },
          },
        );
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || `HTTP ${r.status}`);
        if (cancelled) return;
        if (!d.editable) {
          setEditMode(null);
          setEditLoadError(
            d.blockReason || "This estimate can no longer be edited.",
          );
          return;
        }
        const seeded = formFromEditSource(d);
        // Reopening the SAME job must not trip the per-job rodent-guarantee
        // confirmation reset (it fires on identity change vs this ref).
        rgIdentityRef.current = `${seeded.address || ""}|${seeded.customerId || ""}|${seeded.customerName || ""}|${seeded.customerEmail || ""}`;
        previousAddressRef.current = seeded.address;
        savedFormRef.current = JSON.stringify(seeded);
        setForm(seeded);
        setEnrichedProfile(d.engineProfile || null);
        setSatelliteData(null);
        setEstimate(d.result ? { ...d.result, engineRequest: d.engineRequest } : null);
        setSavedId(d.id);
        setSavedViewUrl(estimatePreviewUrlFromSave(d));
        setPriceRecomputeNotice(null);
        setEditMode({
          id: d.id,
          status: d.status,
          editVersion: d.editVersion,
          customerName: d.customerName || "",
          hasInputs: !!d.inputs,
        });
        // The Customer Lookup panel's only linked-customer visual is this
        // chip — without seeding it here, an opened estimate always shows
        // the empty search state even though the row IS linked (and
        // form.customerId was seeded above). Display-only: pricing inputs
        // like isRecurringCustomer stay exactly as the estimate saved them.
        setExistingCustomerMatch(d.customer || null);
      } catch (e) {
        if (!cancelled) {
          setEditMode(null);
          setEditLoadError(e.message);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [editEstimateId]);

  function exitEditMode() {
    if (dirty && !window.confirm("Start a new estimate with unsaved changes?")) return;
    onStartNew?.();
    setEditMode(null);
    draftIdRef.current = null;
    setEditLoadError(null);
    setForm(buildDefaultEstimateForm());
    setEnrichedProfile(null);
    setSatelliteData(null);
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
    setPriceRecomputeNotice(null);
    setGroupAnchorId(null);
    // Hydration now seeds the linked-customer chip — clear it with the rest
    // of the edit state or it lingers over the next blank form.
    setExistingCustomerMatch(null);
    setAddressMatches([]);
    preLinkContactRef.current = null;
  }

  const previousAddressRef = useRef(form.address);
  useEffect(() => {
    if (previousAddressRef.current === form.address) return;
    previousAddressRef.current = form.address;
    lookupSeqRef.current += 1;
    lookupAbortRef.current?.abort();
    setEnrichedProfile(null);
    setSatelliteData(null);
    setLookupStatus({ type: "", msg: "" });
    setSatelliteStatus({ type: "", msg: "" });
  }, [form.address]);

  const set = useCallback((key, val) => {
    setForm((f) => {
      const next = {
        ...f,
        [key]: val,
        ...(key === "preslabJobContext" ? { _preslabJobContextEdited: true } : {}),
        ...(key === "preslabVolume" && !f._preslabJobContextEdited
          ? { preslabJobContext: String(val || "NONE").toUpperCase() === "NONE" ? "standalone" : "builderBatch" }
          : {}),
        // Typing a NEW address immediately invalidates the previous
        // address's unit count — the save-before-lookup path could
        // otherwise permanently verify A's count against B (codex P1 r7).
        ...(key === "address" ? {
          ...clearedPropertyFields(),
        } : { _manualFields: [...new Set([...(f._manualFields || []), key])] }),
        ...(key === "poolCageSize" ? { _poolCageSizeEdited: true } : {}),
        ...(key === "stories" ? { _storiesEdited: true } : {}),
        // The edit is BOUND to the address it was typed for — every
        // address-replacement path (typed, autocomplete, customer select,
        // incoming prefill) then disarms the save without each needing its
        // own reset (pre-push codex P1 r7).
        ...(key === "unitCount" ? { _unitCountEdited: true, _unitCountAddress: f.address } : {}),
        ...(key === "termiteFootprintSqFt" ? { _termiteFootprintAuto: false } : {}),
        ...(key === "trenchingPerimeterLF" ? { _trenchingPerimeterAuto: false } : {}),
        ...(key === "boracareSqft" ? { _boracareSqftAuto: false } : {}),
        ...(key === "preslabSqft" ? { _preslabSqftAuto: false } : {}),
        // palmCount ONLY: the auto flag tracks the PROPERTY count's
          // provenance — a treatment-count edit says nothing about it, and
          // flipping the flag there would leave a stale property prefill
          // uncleared on the next lookup.
          ...(key === "palmCount" ? { _palmCountAuto: false } : {}),
      };
      // Entering a Bora-Care surface run while the attic box still holds an
      // untouched lookup estimate signals a surface-only job — drop the auto
      // attic value so priceBoraCare takes its surface-only path instead of
      // silently quoting attic + surface. A manually entered attic survives.
      if (key === "boracareSurfaceLinearFt" && f._boracareSqftAuto && String(val || "").trim() !== "") {
        next.boracareSqft = "";
        next._boracareSqftAuto = false;
      }
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
      // Turning the guarantee off drops the per-job eligibility confirmations so
      // they can't be silently reused if it's re-enabled for a different scope.
      if (key === "svcRodentGuarantee" && f.svcRodentGuarantee) {
        for (const k of RODENT_GUARANTEE_ELIGIBILITY_KEYS) next[k] = false;
      }
      // Same per-job rule for the bermuda-suppression confirmation: deselecting
      // Lawn Care clears it, so reselecting never restores a checked add-on
      // without fresh verification.
      if (key === "svcLawn" && f.svcLawn) {
        next.bermudaSuppression = false;
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
    // Every CheckboxV2 key is a pricing input or pricing gate (service
    // selections, palm/trenching/pre-slab flags, rodent surcharges, rg
    // eligibility, dethatching approvals…), so any flip invalidates a
    // generated estimate. An allowlist here previously let flags like
    // rodentTrappingEmergency slip through: the preview kept the pre-flip
    // price, Save persisted the pre-flip engineRequest, and the server's
    // authoritative replay agreed with the stale number — no drift notice.
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
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

  // Prefill bait-station footprint from house sqft, but keep BoraCare and
  // Pre-Slab manual because those measurements often are not property-record values.
  useEffect(() => {
    // Reopening a persisted offer must not add today's inferred measurements
    // or dirty fields for an unselected service. Explicit measurement/service
    // edits clear savedId before this effect runs.
    if (!form.svcTermiteBait || savedId) return;
    const sqft = Number(form.homeSqFt) || 0;
    const st = Math.max(1, Number(form.stories) || 1);
    if (sqft > 0) {
      const fp = Math.round(sqft / st);
      setForm((f) => {
        // footprintUnknown lookup (association aggregate, story count
        // unknown): homeSqFt is the summed living area and stories a
        // default — deriving a "footprint" here re-arms the fake-slab
        // autofill the lookup suppressed (codex P1 #2721). Manual entry
        // stays possible; the box just never self-fills. A MANUALLY entered
        // POSITIVE story count supplies the missing datum, so derivation
        // resumes — an edited-then-cleared box does not (codex P2 r7+r8
        // #2721).
        if (
          f._footprintUnknownLookup &&
          !(f._storiesEdited && Number(f.stories) >= 1)
        )
          return f;
        const upd = {};
        if (!f.termiteFootprintSqFt || f._termiteFootprintAuto)
          upd.termiteFootprintSqFt = String(fp);
        if (Object.keys(upd).length === 0) return f;
        return { ...f, ...upd, _termiteFootprintAuto: true };
      });
    }
  }, [form.homeSqFt, form.stories, form.svcTermiteBait]);

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

  const [enrichedProfile, setEnrichedProfile] = useState(null);
  const [existingCustomerMatch, setExistingCustomerMatch] = useState(null);
  // Customers whose street line matches the looked-up address. Surfaced as a
  // suggestion the operator links explicitly — never auto-applied. Two adults
  // at one address (spouses quoting separately) each need their own estimate;
  // the old silent first-hit link put the second person's quote on the first
  // person's profile.
  const [addressMatches, setAddressMatches] = useState([]);
  // The address + typed contact those matches were found and ranked for.
  // Suggestions render only while the form still matches — an edited
  // address must not keep a stale Link actionable for the previous
  // property, and an edited phone/email must not keep a stale
  // "phone matches" label (codex #3782 r1).
  const [addressMatchesFor, setAddressMatchesFor] = useState("");
  const addressMatchKey = (address, phone, email) =>
    `${String(address || "").trim()}|${phone || ""}|${email || ""}`;
  // Contact fields as typed before a link, so Unlink restores them instead
  // of leaving the unlinked customer's name/phone/email on the estimate.
  const preLinkContactRef = useRef(null);

  // The ONE way a customer row becomes the linked customer — shared by the
  // Customer Lookup list and the address-match suggestion. The lookup list
  // adopts the customer's address (the operator searched by person); the
  // suggestion keeps the address the operator just looked up.
  function applyCustomerLink(c, { adoptAddress }) {
    const name = `${c.firstName || ""} ${c.lastName || ""}`.trim();
    if (!preLinkContactRef.current) {
      preLinkContactRef.current = {
        customerName: form.customerName || "",
        customerPhone: form.customerPhone || "",
        customerEmail: form.customerEmail || "",
        isRecurringCustomer: form.isRecurringCustomer,
      };
    }
    // 'Commercial' is a flat non-member tier — exclude it so a commercial
    // customer doesn't unlock recurring-customer loyalty discounts.
    const hasActivePlan =
      c.tier && c.tier !== "null" && c.tier !== "Commercial" && c.monthlyRate > 0;
    setForm((f) => ({
      ...f,
      customerId: c.id || "",
      propertyId: "",
      ...(adoptAddress
        ? { ...(c.address && c.address !== f.address ? clearedPropertyFields() : {}), address: c.address || f.address }
        : {}),
      customerName: name,
      customerPhone: c.phone || f.customerPhone || "",
      customerEmail: c.email || f.customerEmail || "",
      // No plan: the address suggestion resets the loyalty flag (it may have
      // been set for whoever was linked before); the lookup list keeps the
      // operator's own answer, as it always has.
      isRecurringCustomer: hasActivePlan ? "YES" : adoptAddress ? f.isRecurringCustomer : "NO",
    }));
    setExistingCustomerMatch(c);
    setAddressMatches([]);
    setCustomerSearch("");
    setCustomers([]);
    // isRecurringCustomer is a pricing input — a preview or saved row priced
    // before the link is stale.
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
  }

  // Unlink is offered only where a save can actually honor it: the revise
  // PUT keeps the row's customer_id (codex #3768 r1), and a grouped sibling
  // must share the anchor's customer or the save 400s (codex #3768 r3).
  const canUnlink = !editMode?.id && !groupAnchorId;

  // Drops the linked customer but keeps the typed contact fields, so a wrong
  // link (address suggestion, deep link, or a mis-click) is one tap to undo.
  function unlinkCustomer() {
    setExistingCustomerMatch(null);
    // No snapshot (edit hydration, deep link): keep the contact fields as
    // they are — only the linkage and its pricing flag go.
    const restore = preLinkContactRef.current || { isRecurringCustomer: "NO" };
    preLinkContactRef.current = null;
    setForm((f) => ({ ...f, customerId: "", propertyId: "", ...restore }));
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
  }
  // What the linked customer already buys and pays PER APPLICATION today —
  // the office prices an upgrade against this. Read-only context: it never
  // feeds the quote, so a failed/absent load just renders no panel (the
  // behavior before this existed) rather than blocking the builder.
  const [customerSpend, setCustomerSpend] = useState(null);
  useEffect(() => {
    // Clear FIRST, on every relink. The chip above switches to the newly
    // linked customer the instant staff clicks them, so carrying the
    // previous customer's figures until this fetch resolves would caption
    // one customer's per-application prices with another customer's name —
    // and these are numbers the office reads out loud. The cancelled guard
    // below stops a slow response for an earlier selection from landing on
    // top of the current one; this stops the stale render before it.
    setCustomerSpend(null);
    // The EFFECTIVE linked customer, not just a search-and-click match
    // (codex #3353 r3): opening the builder through the existing-customer
    // deep link (?tab=new&customerId=…) seeds form.customerId but
    // deliberately leaves existingCustomerMatch null, so keying only off the
    // match left the panel absent on exactly the entry path where staff
    // already told us which customer they mean.
    const customerId = existingCustomerMatch?.id || form.customerId;
    if (!customerId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(
          `/api/admin/estimates/customer-spend/${encodeURIComponent(customerId)}`,
          { headers: authHeaders },
        );
        if (!r.ok) {
          if (!cancelled) setCustomerSpend(null);
          return;
        }
        const d = await r.json();
        if (!cancelled) setCustomerSpend(d);
      } catch {
        if (!cancelled) setCustomerSpend(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [existingCustomerMatch?.id, form.customerId]);
  const [customerProperties, setCustomerProperties] = useState([]);
  const [propertiesError, setPropertiesError] = useState("");
  useEffect(() => {
    setCustomerProperties([]);
    setPropertiesError("");
    if (!form.customerId) return undefined;
    const controller = new AbortController();
    void adminFetch(`/admin/customers/${encodeURIComponent(form.customerId)}/properties`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load service properties. Retry before choosing an address.");
        const data = await response.json();
        if (!controller.signal.aborted) setCustomerProperties(data.properties || []);
      }).catch((error) => { if (!controller.signal.aborted) setPropertiesError(error.message); });
    return () => controller.abort();
  }, [form.customerId]);

  function selectServiceProperty(propertyId) {
    const property = customerProperties.find((item) => item.id === propertyId);
    if (!property) { set("propertyId", ""); return; }
    const address = [[property.address_line1, property.address_line2].filter(Boolean).join(" "), property.city,
      [property.state, property.zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
    set("address", address);
    setForm((current) => ({ ...current, propertyId }));
  }

  // The linked customer's OPEN address-review cards (an owed unit number,
  // an unverified address) from the call that created the lead. Without
  // this the property panel prices whatever address the lead carries and
  // nothing on this page says the office still owes a callback for it —
  // the Triage Inbox knew, the estimate tool didn't (2026-09-02: a tenant's
  // bare complex address quoted as a 358-unit commercial property).
  // Read-only context, same fail-open contract as customerSpend.
  const [openAddressAsks, setOpenAddressAsks] = useState([]);
  useEffect(() => {
    setOpenAddressAsks([]);
    const customerId = existingCustomerMatch?.id || form.customerId;
    if (!customerId) return undefined;
    let cancelled = false;
    (async () => {
      try {
        const r = await adminFetch(
          // active = open OR in_progress: a card the office already claimed
          // is still an owed callback (pre-push codex P1).
          `/admin/triage?status=active&customer_id=${encodeURIComponent(customerId)}`,
        );
        if (!r.ok) return;
        const d = await r.json();
        if (cancelled) return;
        // Validation-ask cards only: the address_review lane also files
        // multi-property / second-address / property-role / dropped-call
        // cards, which are not "this address may be wrong" (codex r1 P2).
        setOpenAddressAsks(
          (Array.isArray(d.items) ? d.items : []).filter((i) => ADDRESS_ASK_REASONS.has(i.reason_code)),
        );
      } catch {
        if (!cancelled) setOpenAddressAsks([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [existingCustomerMatch?.id, form.customerId]);
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

  // Live engine preview for the treatable-turf "Lot estimate" fallback.
  // Originally stale-imagery only (codex P1 r2 + pre-push P1 r3 #3098);
  // widened 2026-08-28 to EVERY profile: the local lot × (1 − impervious%)
  // − beds heuristic below skipped the building footprint, hardscape and
  // the engine's plausible-max cap, so a 2026 new build (AI turf 0 sf,
  // impervious 0%) showed "Lot est. 4,920 sf" — the whole parcel, house
  // included — while /calculate-estimate priced 2,368 and the customer's
  // estimate said so. When the rep edits the fields that feed pricing,
  // re-ask /turf-preview so the displayed number keeps tracking what
  // /calculate-estimate will price. The payload is the SAME profile shape
  // doGenerate builds (spread profile + the identical form overrides,
  // parseInt semantics and the blank-bed-area→0 default included) so the
  // server can run it through the real translate/engine boundary.
  // Debounced; a sequence counter drops out-of-order responses. Null while
  // no fresh answer — the render falls back to the profile's lookup-time
  // value (stale-imagery path) or the local heuristic (fail-open).
  const [enginePreviewSf, setEnginePreviewSf] = useState(null);
  const enginePreviewSeq = useRef(0);
  const turfUnobservable = enrichedProfile?.turfObservation === "unobservable";
  const previewLotSqFt =
    parseNonNegativeInteger(form.lotSqFt) ??
    parseNonNegativeInteger(enrichedProfile?.lotSqFt) ??
    0;
  useEffect(() => {
    setEnginePreviewSf(null);
    // Bump the sequence BEFORE any early return so an in-flight answer for
    // the previous profile can never land after the lot clears (pre-push
    // P1: switching to a lot-less address would otherwise re-display the
    // prior property's turf area).
    const seq = ++enginePreviewSeq.current;
    // Without a lot the engine has nothing to derive from — the local
    // heuristic returns null there too, so skip the round-trip.
    if (previewLotSqFt <= 0) return undefined;
    const timer = setTimeout(async () => {
      try {
        // The SAME builder doGenerate uses — preview and priced request
        // share one profile construction by design.
        const previewProfile = buildTurfRequestProfile(enrichedProfile || {}, form);
        // Preview only renders while Confirmed Sq Ft is blank.
        delete previewProfile.measuredTurfSf;
        const r = await fetch("/api/admin/estimator/turf-preview", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
          },
          body: JSON.stringify({ profile: previewProfile }),
        });
        if (!r.ok) return;
        const data = await r.json();
        if (seq !== enginePreviewSeq.current) return;
        const sf = Number(data?.turfSf);
        // Zero is a REAL engine answer (footprint + hardscape can consume
        // the lot) — coercing it to null would fall back to a stale
        // positive number (codex P2 r4 #3098). Null only for no-answer.
        setEnginePreviewSf(Number.isFinite(sf) && sf >= 0 ? Math.round(sf) : null);
      } catch {
        // Fall back to the lookup-time profile value / local heuristic.
      }
    }, 350);
    return () => clearTimeout(timer);
  }, [
    previewLotSqFt,
    enrichedProfile,
    form.lotSqFt,
    form.homeSqFt,
    form.stories,
    form.bedArea,
    form.propertyType,
    form.isCommercial,
    form.commercialSubtype,
    form.commercialRiskType,
    form.commercialPestCadence,
    form.commercialInteriorService,
    form.commercialLawnCadence,
    form.treeShrubDensity,
    form.mosquitoPressure,
    form.hasPool,
    form.hasPoolCage,
    form.poolCageSize,
    form._poolCageSizeEdited,
    form._storiesEdited,
    form.shrubDensity,
    form.treeDensity,
    form.landscapeComplexity,
    form.nearWater,
  ]);

  const saveVerifiedValues = useCallback(async () => {
    const fields = {};
    if (String(form.homeSqFt || "").trim() !== "") fields.squareFootage = Number(form.homeSqFt);
    if (String(form.lotSqFt || "").trim() !== "") fields.lotSize = Number(form.lotSqFt);
    // A story count nobody actually knew (lookup default, operator never
    // touched it) must not be persisted as "tech verified" — for an
    // unknown-stories aggregate that would defeat the footprint suppression
    // on every future lookup of the address (codex P2 #2721).
    const storiesIsUntouchedDefault =
      enrichedProfile?.storiesSource === "default" && !form._storiesEdited;
    if (String(form.stories || "").trim() !== "" && !storiesIsUntouchedDefault)
      fields.stories = Number(form.stories);
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
  }, [form.address, form.homeSqFt, form.lotSqFt, form.stories, form._storiesEdited, enrichedProfile]);

  // Unit-count corrections have their OWN save action (pre-push codex P0
  // r5): the shared sqft/lot/stories save would also bless every populated
  // lookup dimension as tech-verified — correcting a wrong count must not
  // permanently verify whole-building sqft it rode in with. It also needs
  // to exist when NO fieldVerify flag rendered the shared button (a
  // confident-but-wrong listing count produces no flag).
  const [unitSaveState, setUnitSaveState] = useState("");
  useEffect(() => {
    setUnitSaveState("");
  }, [form.address, form.unitCount, form._unitCountAddress]);
  const unitCountNumber = Number(form.unitCount);
  const unitCountSavable =
    form._unitCountEdited &&
    form._unitCountAddress === form.address &&
    String(form.unitCount || "").trim() !== "" &&
    Number.isInteger(unitCountNumber) &&
    unitCountNumber >= 1;
  const saveVerifiedUnitCount = useCallback(async () => {
    const n = Number(form.unitCount);
    if (!form.address || form._unitCountAddress !== form.address || !Number.isInteger(n) || n < 1) return;
    setUnitSaveState("saving");
    try {
      const r = await fetch("/api/admin/estimator/property-lookup/verify", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ address: form.address, fields: { unitCount: n } }),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      setUnitSaveState("saved");
      // The current quote must not keep pricing off the OLD count's
      // classification/dimensions (pre-push codex P1 r6) — re-run the
      // lookup so the rebuilt profile (verified count folded in
      // server-side) replaces the stale one. doLookup is a hoisted
      // component-scope function; a refresh failure leaves the saved
      // override intact and the operator can re-run Lookup manually.
      try { await doLookup(); } catch { /* override saved; manual re-lookup */ }
    } catch {
      setUnitSaveState("error");
    }
  }, [form.address, form.unitCount, form._unitCountAddress]);

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
    setLookupStatus({ type: "", msg: "" });
    setEnrichedProfile(null);
    setExistingCustomerMatch(null);
    setAddressMatches([]);
    preLinkContactRef.current = null;
    setSatelliteStatus({ type: "", msg: "" });
    setSatelliteData(null);
    // A fresh lead/customer prefill is a new job — never chain it into a
    // previous customer's multi-property group.
    setGroupAnchorId(null);
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
  // Whether the SERVER will actually honor a rented-stations selection.
  // GATE_TERMITE_STATION_RENTAL defaults off and the engine silently reprices
  // a dark 'rent' to outright purchase — so offering the control while the
  // gate is down lets an operator pick "Rented" and send a purchase quote
  // carrying the install charge. The first server calculation already ignored
  // the choice, so the save-time recompute check sees no drift to warn about
  // (codex P1). Fail closed: null/false hides the control entirely.
  const [termiteRentalAvailable, setTermiteRentalAvailable] = useState(false);
  // Bermuda-suppression add-on availability (GATE_BERMUDA_SUPPRESSION, read
  // at request time server-side). Explicit true only — 404 / transport
  // failure / older server all keep the option hidden rather than offering
  // a control the engine would reject with a 400.
  const [bermudaSuppressionAvailable, setBermudaSuppressionAvailable] = useState(false);
  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await adminFetch("/admin/pricing-config/lawn_pricing_v2");
        if (!r.ok) return;
        const row = await r.json();
        if (active) setBermudaSuppressionAvailable(row?.subFeaturesAvailable?.bermudaSuppression === true);
      } catch {
        /* ignore — stays unavailable */
      }
    })();
    return () => {
      active = false;
    };
  }, []);
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

  // Live rodent bait pricing rows (codex #3591 r34 P1): the sidebar's tier
  // count reads rodentBaitWaveguardFlags() and the bracket helper reads the
  // ladder, both module state the LEGACY estimator's loader mutates through
  // these same appliers — this view never loaded them, so it advertised the
  // in-code default (Silver) while the server priced from the live row
  // (Bronze). Same semantics as EstimatePage.refreshPricingConfig: a 404 is
  // AUTHORITATIVE (row removed ⇒ reset to the in-code default via `null`),
  // any other failure leaves the last applied state. The posture state
  // (declared beside the preview memo) is refreshed AFTER all three rows
  // apply, so the memo re-runs once against the live ladder + flags.
  useEffect(() => {
    let active = true;
    const fetchRow = async (key) => {
      try {
        const r = await adminFetch(`/admin/pricing-config/${key}`);
        if (r.status === 404) return { ok: true, data: null };
        if (!r.ok) return { ok: false, data: null };
        const body = await r.json();
        return { ok: true, data: body?.data ?? null };
      } catch {
        return { ok: false, data: null };
      }
    };
    (async () => {
      const [bracketsRow, setupRow, waveguardRow] = await Promise.all([
        fetchRow("rodent_bait_brackets"),
        fetchRow("rodent_setup_fee"),
        fetchRow("rodent_waveguard"),
      ]);
      if (!active) return;
      // ALL THREE rows or nothing (codex #3591 r55 local P1): applying a
      // partial set leaves module defaults beside live values — the sidebar
      // could advertise a Silver/discounted posture the server's disabled
      // policy won't give. A failed load keeps the fail-closed posture
      // (tierQualifier false ⇒ rodent stays out of the member-key preview).
      if (bracketsRow.ok && setupRow.ok && waveguardRow.ok) {
        applyServerRodentBaitBracketsPricingConfig(bracketsRow.data);
        applyServerRodentSetupFeePricingConfig(setupRow.data);
        applyServerRodentWaveguardPricingConfig(waveguardRow.data);
        setRodentWaveguardPosture(rodentBaitWaveguardFlags());
      } else {
        setRodentWaveguardPosture({ tierQualifier: false, excludeFromPctDiscount: true, unavailable: true });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const r = await adminFetch("/admin/pricing-config/termite_rental");
        if (!r.ok) return;
        const row = await r.json();
        // Explicit true only — a 404 (row not seeded), a transport failure,
        // or an older server that does not send the field all keep the
        // rental choice hidden rather than offering an option the engine
        // would silently discard.
        if (active) setTermiteRentalAvailable(row?.featureAvailable === true);
      } catch {
        /* ignore — stays unavailable */
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
      }));
      return;
    }
    if (key === "__custom__") {
      // "Custom…" is a hardcoded sentinel, not a catalog row, so there is no
      // discount_type to source the manual type from the way the preset
      // branch below does. Leaving the type alone meant a fresh form kept
      // its "NONE" default, buildManualDiscountPayload returned null, and
      // the operator's amount was dropped with no warning at all. Seed
      // PERCENT (the common custom case) while preserving a type the
      // operator already chose, so switching presets never clobbers it.
      setForm((f) => ({
        ...f,
        manualDiscountPreset: key,
        manualDiscountType:
          f.manualDiscountType && f.manualDiscountType !== "NONE"
            ? f.manualDiscountType
            : "PERCENT",
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
    }));
  }

  // "Add another property": chain a sibling estimate for the same customer —
  // keeps the contact identity, clears the property/services/quote, and links
  // the next save into the anchor's group (groupWithEstimateId). The catalog
  // Multi-Home Discount is pre-selected on the new draft (owner decision
  // 2026-08-06: the 10% applies to EVERY property in a multi-property group —
  // add it to the first estimate too via Edit if it was saved without one).
  // The lead link is NOT carried over: a lead attaches to one estimate.
  function addAnotherProperty(prefill = {}) {
    if (dirty && !window.confirm("Start another property and discard unsaved changes?")) return;
    const anchorId = savedId || editMode?.id;
    if (!anchorId) return;
    setGroupAnchorId(anchorId);
    lookupAbortRef.current?.abort();
    lookupSeqRef.current += 1;
    onStartNew?.();
    setEditMode(null);
    draftIdRef.current = null;
    setEditLoadError(null);
    const multiHome = discountPresets.find((x) => x.discount_key === "multi_home");
    setForm((f) => ({
      ...buildDefaultEstimateForm({
        customerId: f.customerId,
        customerName: f.customerName,
        customerPhone: f.customerPhone,
        customerEmail: f.customerEmail,
        address: prefill.address || "",
      }),
      // Account-level facts survive the property reset (codex #3244 r7):
      // the recurring-customer 15% one-time perk belongs to the PERSON —
      // resetting it silently overcharges a member's second property, and
      // the new address's lookup can't rediscover membership keyed to the
      // primary address.
      isRecurringCustomer: f.isRecurringCustomer,
      ...(multiHome
        ? {
          manualDiscountPreset: "multi_home",
          manualDiscountType: manualDiscountTypeForCatalogRow(multiHome),
          manualDiscountValue: String(multiHome.amount || 0),
          manualDiscountLabel: multiHome.name,
        }
        : {}),
    }));
    setEnrichedProfile(null);
    setSatelliteData(null);
    setSatelliteStatus({ type: "", msg: "" });
    setLookupStatus({ type: "", msg: "" });
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
    setPriceRecomputeNotice(null);
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
    // Read at click time: a deep link seeds form.customerId with no chip.
    const customerAlreadyLinked = !!(existingCustomerMatch || form.customerId);
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
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
    // Every lookup supersedes any in-flight one: bump the sequence and abort
    // the old fetch so a slow response for a previous address can never
    // autofill this one.
    const lookupSeq = ++lookupSeqRef.current;
    if (lookupAbortRef.current) lookupAbortRef.current.abort();
    const lookupController = new AbortController();
    lookupAbortRef.current = lookupController;
    // Supersession gate for everything this lookup applies. A NEWER lookup
    // owns the status UI (plain return); an address edit with NO new lookup
    // leaves nobody to clear the "loading" status this lookup set — clear it
    // here or the page shows the AI/property lookup running forever.
    const lookupSuperseded = () => {
      if (lookupSeq !== lookupSeqRef.current) return true;
      if (formAddressRef.current.trim() !== address) {
        setLookupStatus({ type: "", msg: "" });
        setSatelliteStatus({ type: "", msg: "" });
        return true;
      }
      return false;
    };
    try {
      const r = await fetch("/api/admin/estimator/property-lookup", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ address }),
        signal: lookupController.signal,
      });
      if (!r.ok) throw new Error("API " + r.status);
      const data = await r.json();
      if (lookupSuperseded()) return;

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
      unitLookupAddressRef.current = ep.residentialUnitLookup ? address : "";

      const upd = {};
      if (ep.homeSqFt) upd.homeSqFt = String(ep.homeSqFt);
      if (ep.lotSqFt) upd.lotSqFt = String(ep.lotSqFt);
      if (ep.stories) upd.stories = String(ep.stories);
      if (ep.propertyType || ep.category) {
        Object.assign(upd, resolveLookupPropertyTypeAutofill(ep.propertyType, ep.category));
      }
      if (ep.commercialSubtype) upd.commercialSubtype = ep.commercialSubtype;
      if (ep.residentialUnitLookup) {
        // One unit inside a building: the server already blanked the
        // parcel's dims and dropped its parcel-wide reads, but the copies
        // above only land TRUTHY values — so a bare-building lookup run a
        // moment earlier (the usual sequence: address first, then "which
        // apartment?") would keep the complex's sqft / lot / stories /
        // pool / landscape in the form through the spread below and price
        // the whole property anyway (codex r1 P1). Reset those to the form
        // defaults; the operator supplies the unit's own figures.
        Object.assign(upd, {
          homeSqFt: ep.homeSqFt ? String(ep.homeSqFt) : "",
          lotSqFt: "",
          stories: ep.stories ? String(ep.stories) : "1",
          hasPool: "NO",
          hasPoolCage: "NO",
          poolCageSize: "MEDIUM",
          shrubDensity: "MODERATE",
          treeDensity: "MODERATE",
          landscapeComplexity: "MODERATE",
          nearWater: "NO",
          bedArea: "",
          // Parcel-wide canopy count from the earlier bare-building lookup
          // (pre-push codex P1 r4); palms clear through palmPrefillAllowed.
          treeCount: "",
        });
      }
      if (ep.pool === "YES" || ep.pool === "POSSIBLE") upd.hasPool = "YES";
      if (ep.poolCage === "YES") upd.hasPoolCage = "YES";
      if (ep.poolCageSize && ep.poolCageSize !== "NONE")
        upd.poolCageSize = ep.poolCageSize;
      if (ep.shrubDensity) upd.shrubDensity = ep.shrubDensity;
      if (ep.treeDensity) upd.treeDensity = ep.treeDensity;
      if (ep.landscapeComplexity)
        upd.landscapeComplexity = ep.landscapeComplexity;
      if (ep.nearWater && ep.nearWater !== "NONE") upd.nearWater = "YES";
      if (ep.estimatedBedAreaSf) upd.bedArea = String(ep.estimatedBedAreaSf);
      // Palm prefill rides the server-stamped trust verdict — a distrusted
      // AI count leaves the field empty for the operator to count
      // (lib/lookupPrefill.js; owner ruling 2026-08-10). When THIS lookup
      // supplies no trusted count (distrusted, zero, or absent), the
      // setForm below clears a previous lookup's auto-fill instead of
      // letting the form merge carry it into pricing; operator-typed
      // values (_palmCountAuto false) always stand.
      if (palmPrefillAllowed(ep)) {
        upd.palmCount = String(ep.estimatedPalmCount);
      }
      if (ep.estimatedTreeCount) upd.treeCount = String(ep.estimatedTreeCount);
      const termiteFootprintNumber = lookupTermiteFootprintSqFt(ep);
      if (termiteFootprintNumber) upd.termiteFootprintSqFt = String(Math.round(termiteFootprintNumber));
      const perimeterLF = ep.estimatedPerimeterLF || ep.perimeterLF || ep.perimeterLf || ep.perimeter;
      const perimeterNumber = parsePositiveNumber(perimeterLF);
      const atticSqFt = ep.estimatedAtticSqFt || ep.atticSqFt || ep.atticAreaSqFt || ep.rawWoodSqFt || ep.woodTreatmentSqFt;
      const atticNumber = parsePositiveNumber(atticSqFt);
      const slabSqFt = ep.estimatedSlabSqFt || ep.slabSqFt || ep.foundationSqFt || ep.buildingSlabSqFt || ep.newConstructionSlabSqFt;
      const slabNumber = parsePositiveNumber(slabSqFt);

      setForm((f) => {
        const next = {
          ...f,
          ...upd,
          ...(termiteFootprintNumber ? { _termiteFootprintAuto: true } : {}),
          // Rides the form so the homeSqFt/stories effect can't re-derive a
          // footprint the lookup refused to claim (codex P1 #2721).
          _footprintUnknownLookup: ep.footprintUnknown === true,
          _poolCageSizeEdited: false,
          _storiesEdited: false,
          _unitCountEdited: false,
          // Every lookup re-seeds the count for ITS address — a value typed
          // for the previous address must never linger where an edit could
          // verify it against the wrong parcel (pre-push codex P1 r5).
          // The truthy-1 seed renders blank: it is "no signal", not a fact.
          unitCount: Number(ep.unitCount) > 1 ? String(ep.unitCount) : "",
        };
        // With derivation suppressed nothing would refresh a previous
        // address's auto-derived footprint — clear it (manual entries keep
        // the same never-overwritten contract as the boxes below).
        // A unit lookup has no building footprint to offer either, and the
        // bare-building lookup's auto-derived one must not survive as a
        // "manual" termite measurement (codex r2 P1).
        if ((ep.footprintUnknown === true || ep.residentialUnitLookup) && f._termiteFootprintAuto) {
          next.termiteFootprintSqFt = "";
          next._termiteFootprintAuto = false;
        }
        // Termite measurement pre-fills honor the section contract: a
        // manually entered value is never overwritten by a lookup estimate,
        // and a lookup miss clears a value only if a previous lookup put it
        // there (never a manual one) so it can't leak onto the next address.
        const applyTermiteEstimate = (key, flagKey, estimate) => {
          if (estimate) {
            if (String(f[key] || "").trim() === "" || f[flagKey]) {
              next[key] = String(Math.round(estimate));
              next[flagKey] = true;
            }
          } else if (f[flagKey]) {
            next[key] = "";
            next[flagKey] = false;
          }
        };
        applyTermiteEstimate("trenchingPerimeterLF", "_trenchingPerimeterAuto", perimeterNumber);
        // Attic pre-fill also stands down when a surface run is already
        // entered — that's a surface-only Bora-Care job (see set()).
        applyTermiteEstimate(
          "boracareSqft",
          "_boracareSqftAuto",
          String(f.boracareSurfaceLinearFt || "").trim() === "" ? atticNumber : undefined,
        );
        applyTermiteEstimate("preslabSqft", "_preslabSqftAuto", slabNumber);
        if (upd.palmCount && String(f.palmTreatmentCount || "").trim() === "") {
          next.palmTreatmentCount = upd.palmCount;
        }
        if (upd.palmCount !== undefined) {
          next._palmCountAuto = true;
        } else if (f._palmCountAuto && String(f.palmCount || "").trim() !== "") {
          // This lookup supplied no trusted count — clear the previous
          // lookup's auto-fill (and the treatment count that still mirrors
          // it) so a stale prefill can't ride into T&S reserve or
          // injection pricing. Operator-typed values keep the flag false
          // via the change handler and are never touched.
          next.palmCount = "";
          if (String(f.palmTreatmentCount || "") === String(f.palmCount || "")) {
            next.palmTreatmentCount = "";
          }
          next._palmCountAuto = false;
        }
        for (const key of f._manualFields || []) {
          if (PROPERTY_FORM_FIELDS.includes(key)) next[key] = f[key];
        }
        if (f._manualFields?.includes("palmCount")) next._palmCountAuto = false;
        if (f._manualFields?.includes("termiteFootprintSqFt")) next._termiteFootprintAuto = false;
        if (f._manualFields?.includes("trenchingPerimeterLF")) next._trenchingPerimeterAuto = false;
        if (f._manualFields?.includes("boracareSqft")) next._boracareSqftAuto = false;
        if (f._manualFields?.includes("preslabSqft")) next._preslabSqftAuto = false;
        if (f._manualFields?.includes("stories")) next._storiesEdited = f._storiesEdited;
        if (f._manualFields?.includes("unitCount")) {
          next._unitCountEdited = f._unitCountEdited;
          next._unitCountAddress = f._unitCountAddress;
        }
        return next;
      });
      // Invalidate again at apply time (mirrors doSatelliteAnalysis): a
      // Generate run while the lookup was in flight would otherwise mount a
      // price from pre-lookup inputs — and Save would persist that stale
      // engineRequest, which the server replays verbatim and *confirms*, so
      // no drift notice ever fires.
      setEstimate(null);
      setSavedId(null);
      setSavedViewUrl(null);

      // Existing customers at this street. A SUGGESTION only: the operator
      // links one explicitly (or keeps what they typed). Skipped when a
      // customer is already linked — a deliberate link is never second-
      // guessed by a re-lookup.
      setAddressMatches([]);
      if (!customerAlreadyLinked) {
        try {
          // Server-side, unit-aware (the canonical street comparator): a
          // typed "Unit 4" excludes "Apt 7" at the same building; a typed
          // address with no unit still lists every unit there.
          const custR = await fetch("/api/admin/customers/at-address", {
            method: "POST",
            headers: authHeaders,
            // Typed/prefilled contact ranks the matching household member
            // first (server tags it contactMatch).
            body: JSON.stringify({
              address,
              phone: form.customerPhone || null,
              email: form.customerEmail || null,
            }),
            signal: lookupController.signal,
          });
          if (custR.ok) {
            const custData = await custR.json();
            if (lookupSuperseded()) return;
            setAddressMatches(custData.customers || []);
            setAddressMatchesFor(addressMatchKey(address, form.customerPhone, form.customerEmail));
          }
        } catch {
          /* ignore customer lookup errors */
        }
      }

      // The inner catch above deliberately swallows customer-lookup errors —
      // including the AbortError a NEWER lookup raises by aborting this one —
      // so re-gate before the satellite/status writes below.
      if (lookupSuperseded()) return;

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
      // A superseded lookup aborts deliberately — its error must not paint
      // over the newer lookup's status.
      if (e?.name === "AbortError" || lookupSeq !== lookupSeqRef.current) return;
      setLookupStatus({ type: "err", msg: e.message });
      setSatelliteStatus({ type: "", msg: "" });
    }
  }

  async function doGenerate(overrides = {}) {
    if (editEstimateId && !editMode) return null;
    if (generating) return null;
    // Snapshot the invalidation version. Inputs stay editable while the
    // calculate call is in flight, so an edit that lands mid-flight must make
    // this generate discard its result (it was priced from pre-edit inputs).
    const versionAtStart = estimateVersionRef.current;
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
      if (form.svcRodentGuarantee) selectedServices.push("RODENT_GUARANTEE");

      const manualDiscountType =
        overrides.manualDiscountType ?? form.manualDiscountType;
      const manualDiscountValue =
        Number(overrides.manualDiscountValue ?? form.manualDiscountValue) || 0;
      const selectedManualPreset = discountPresets.find(
        (x) => x.discount_key === form.manualDiscountPreset,
      );
      // An amount with no type is the silent-drop case: every guard below is
      // itself gated on type !== NONE, and buildManualDiscountPayload returns
      // null for a NONE type — so without this the estimate regenerated at
      // full price with no error and the discount vanished. Fail loudly.
      if (manualDiscountType === "NONE" && manualDiscountValue > 0) {
        alert(
          "Pick a discount type (Percent % or Dollar $) — a discount amount with no type is not applied.",
        );
        return null;
      }
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
      // Tree & Shrub prices the PROPERTY palm count too (routine palm-care
      // reserve). A malformed entry is silently dropped by
      // parsePositiveInteger and an oversized one is clamped to 200 by the
      // pricer — either way the estimate would quote the wrong palm count
      // with no error and no review marker. Checked INDEPENDENTLY of the
      // injection branch: with both services selected the injection line can
      // legitimately use its own treatment count while the recurring line
      // silently clamps. Same 1–200 contract as the public route and the
      // intent schema.
      if (form.svcTs && String(form.palmCount || "").trim() !== ""
        && !(propertyPalmCount && propertyPalmCount <= 200)) {
        alert("Palm count must be a whole number between 1 and 200.");
        return null;
      }
      // Tree count: a typed value must be a whole number (0 allowed — an
      // explicit zero is a real answer); the server rejects anything else
      // with a 400, so surface it here before the request.
      if (form.svcTs && String(form.treeCount || "").trim() !== ""
        && !/^\d+$/.test(String(form.treeCount).trim())) {
        alert("Tree count must be a whole number (0 or more).");
        return null;
      }
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

      // Per-estimate overrides for the one-time pest_initial_roach fee.
      // Recurring auto-fire and standalone native carry SEPARATE fields so an
      // estimate with both lines never reprices one from the other's input
      // (codex P2 #3223). A filled-but-invalid entry fails loudly — silently
      // dropping it would regenerate at the bracket price with no notice
      // (same class as the manual-discount silent-drop guard above).
      const roachFeeOverrideRaw = String(form.roachFeeOverride ?? "").trim();
      const roachFeeOverride = parsePositiveNumber(form.roachFeeOverride);
      const roachFeeOverrideRelevant =
        form.svcPest && form.roachModifier && form.roachModifier !== "NONE";
      const standaloneRoachFeeOverrideRaw = String(
        form.standaloneRoachFeeOverride ?? "",
      ).trim();
      const standaloneRoachFeeOverride = parsePositiveNumber(
        form.standaloneRoachFeeOverride,
      );
      // Duplicate state: recurring pest with REGULAR roach activity makes the
      // translator skip the standalone native branch entirely — a standalone
      // override sent then prices NOTHING, so don't send it (the field is
      // also hidden in this state; codex P2 r2 #3223).
      const standaloneRoachDuplicate =
        form.svcPest && form.roachModifier === "REGULAR";
      const standaloneRoachFeeOverrideRelevant =
        form.svcRoach && form.roachType === "REGULAR" && !standaloneRoachDuplicate;
      if (roachFeeOverrideRelevant && roachFeeOverrideRaw && !roachFeeOverride) {
        alert(
          "Roach one-time fee override must be a positive dollar amount — leave it blank to use the engine price.",
        );
        return null;
      }
      if (
        standaloneRoachFeeOverrideRelevant &&
        standaloneRoachFeeOverrideRaw &&
        !standaloneRoachFeeOverride
      ) {
        alert(
          "Standalone roach fee override must be a positive dollar amount — leave it blank to use the engine price.",
        );
        return null;
      }

      const options = {
        grassType: form.grassType || "st_augustine",
        // The matched account — the server derives its canonical qualifying
        // families for tier + rodent setup waiver (codex #3591 r16 P1).
        existingCustomerId: existingCustomerMatch?.id || form.customerId || null,
        // The quoted address + group anchor let the server scope the TIER
        // list per property (grouped / non-primary street) while the rodent
        // setup waiver stays account-wide — the same signals the save body
        // carries, so preview and save resolve identically (codex #3591 r34
        // P1). A revise keeps its stored group linkage (not sent here either).
        address: form.address || null,
        ...(!editMode?.id && groupAnchorId ? { groupWithEstimateId: groupAnchorId } : {}),
        lawnFreq: parseInt(overrides.lawnFreq ?? form.lawnFreq, 10) || 9,
        // Availability gates only the CHECKBOX (new selections); a selection
        // already in the form — e.g. seeded from a saved estimate's inputs
        // while the availability probe is still in flight — is ALWAYS
        // forwarded, and the server's live gate rejects it loudly if off.
        // Silently dropping it here priced an ordinary lawn ladder under a
        // checked box (codex #3272 r2). Commercial estimates are excluded:
        // the engine's commercial branch ignores the option, so forwarding
        // it would stamp a suppression-bearing engineRequest onto an
        // ordinary commercial quote and falsely trip the send/accept gate
        // later (codex #3272 r5).
        ...(form.svcLawn && form.grassType === "st_augustine" && form.bermudaSuppression
          && !isCommercialEstimateInput(form)
          ? { bermudaSuppression: true }
          : {}),
        pestFreq: parseInt(overrides.pestFreq ?? form.pestFreq, 10) || 4,
        manualDiscount,
        serviceSpecificDiscounts,
        roachModifier: form.roachModifier || "NONE",
        recurringRoachType: form.roachModifier || "NONE",
        ...(roachFeeOverrideRelevant && roachFeeOverride
          ? { initialRoachPriceOverride: roachFeeOverride }
          : {}),
        ...(standaloneRoachFeeOverrideRelevant && standaloneRoachFeeOverride
          ? { standaloneRoachPriceOverride: standaloneRoachFeeOverride }
          : {}),
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
        termiteBaitSystem: form.termiteBaitSystem || "trelona",
        termiteMonitoringTier: form.termiteMonitoringTier || "basic",
        termiteBondTerm: form.termiteBondTerm || "none",
        // Hard floor to purchase when the server has not advertised the
        // rental feature: a prefilled/edited draft or a gate flipped OFF
        // mid-session can still carry termiteOwnership='rent' in form state
        // after the control stops rendering, and sending that would quote a
        // rental the engine will reprice as a purchase.
        termiteOwnership: (termiteRentalAvailable && form.termiteOwnership === "rent") ? "rent" : "own",
        termiteBaitComplexity: form.termiteBaitComplexity || "",
        termiteScope: form.termiteScope || "bait_monitoring_no_warranty",
        termiteFootprintSqFt,
        termitePerimeterLF,
        trenchingPerimeterLF,
        trenchingConcreteLF,
        trenchingDirtLF,
        trenchingConcretePct,
        trenchingEstimateFromFootprint: !!form.trenchingEstimateFromFootprint,
        trenchingProductKey: form.trenchingProductKey || "taurus_sc",
        trenchingApplicationRate: form.trenchingApplicationRate || "standard",
        trenchingDepthFt: form.trenchingDepthFt || "0.5",
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
        rgTrappingCompleted: !!form.rgTrappingCompleted,
        rgExclusionCompleted: !!form.rgExclusionCompleted,
        rgSanitationBaseline: !!form.rgSanitationBaseline,
        rgNoActivityAfterFinalCheck: !!form.rgNoActivityAfterFinalCheck,
        rodentTrappingPlan: "standard",
        rodentTrappingEmergency: !!form.rodentTrappingEmergency,
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
        commercialRiskType: formIsCommercial ? form.commercialRiskType || "" : "",
        commercialPestCadence: formIsCommercial ? form.commercialPestCadence || "" : "",
        commercialInteriorService: formIsCommercial ? form.commercialInteriorService || "" : "",
        commercialLawnCadence: formIsCommercial ? form.commercialLawnCadence || "" : "",
        treeShrubDensity: formIsCommercial ? form.treeShrubDensity || "" : "",
        // Tree & shrub program + access ride the service line (server
        // translator builds services.treeShrub from these — audit INP-004).
        treeShrubTier: form.svcTs ? form.tsTier || "standard" : undefined,
        treeShrubAccess: form.svcTs ? form.tsAccess || "easy" : undefined,
        mosquitoPressure: formIsCommercial ? form.mosquitoPressure || "" : "",
        fleaOfferKey: "flea_elimination_two_visit",
        fleaComplexity: form.fleaComplexity || "light",
        fleaExteriorSourceSuspected: !!form.fleaExteriorSourceSuspected,
        fleaExterior: !!form.svcFleaExterior,
        fleaExteriorAreaSqFt: parseInt(form.fleaExteriorAreaSqFt, 10) || 0,
        fleaExteriorAreaSource: form.fleaExteriorAreaSource || "UNKNOWN",
        fleaExteriorZones: Array.isArray(form.fleaExteriorZones) ? form.fleaExteriorZones : [],
      };
      if (form.svcWasp) {
        Object.assign(options, {
          stingSpecies: form.stingSpecies,
          stingTier: Number(form.stingTier),
          stingRemoval: form.stingRemoval,
          stingAggressive: form.stingAggressive,
          stingHeight: form.stingHeight,
          stingConfined: form.stingConfined,
        });
      }
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

      const optionalNumber = (value) => {
        const n = parseInt(value, 10);
        return Number.isFinite(n) && n >= 0 ? n : undefined;
      };
      const baseProfile = enrichedProfile || {};
      // Tree count: a typed value (an explicit 0 included) wins; otherwise the
      // lookup's positive estimate; otherwise ABSENT — the translator and the
      // pricer treat absence as "unknown" and fall back to the treeDensity
      // estimate, where the old `|| 0` fabricated a zero that priced the
      // per-tree material away (audit INP-002).
      const typedTreeCount = String(form.treeCount ?? "").trim() === ""
        ? undefined
        : parseInt(form.treeCount, 10);
      const estimatedTreeCount = parseInt(baseProfile.treeCount || baseProfile.estimatedTreeCount, 10);
      const treeCount = typedTreeCount
        ?? (Number.isFinite(estimatedTreeCount) && estimatedTreeCount > 0 ? estimatedTreeCount : undefined);
      const measuredTurfSf = optionalNumber(form.measuredTurfSf);
      // Turf-relevant transforms (dims, bed area, footprint, pool/cage,
      // densities, type) live in buildTurfRequestProfile, SHARED with the
      // stale-imagery /turf-preview effect — edit them there, not here
      // (pre-push P1 #3098).
      const profile = buildTurfRequestProfile(baseProfile, form);
      // Palm pricing requires an explicit positive integer. The property-level
      // count is used only as a prefill/default; the palmInjection service
      // payload below carries the number of palms treated for this line.
      // An operator who CLEARED the palm field said "no palms" — the AI
      // estimate must not resurrect through the fallback (or the server
      // translator's promotion) and reprice the count they rejected.
      const palmManuallyCleared = form._palmCountAuto === false
        && String(form.palmCount || "").trim() === "";
      if (palmManuallyCleared) {
        // The operator said "no palms": EVERY saved/AI leg is void — on an
        // estimate revision the saved engine profile carries
        // palmCount/palmInventory.palmCount too, and any surviving field
        // would show an empty palm box while T&S silently priced the prior
        // count.
        delete profile.palmCount;
        delete profile.estimatedPalmCount;
        if (profile.palmInventory) delete profile.palmInventory.palmCount;
      } else {
        Object.assign(profile, (() => {
          const fallback = parsePositiveInteger(baseProfile.palmCount)
            ?? parsePositiveInteger(baseProfile.palmInventory?.palmCount)
            // The raw vision estimate only backstops when the server-stamped
            // verdict trusts it — a distrusted count must not slip into T&S
            // pricing through this request-profile fallback.
            ?? (palmPrefillAllowed(baseProfile)
              ? parsePositiveInteger(baseProfile.estimatedPalmCount)
              : undefined);
          const value = propertyPalmCount ?? fallback;
          return value
            ? {
                palmCount: value,
                estimatedPalmCount: value,
                palmInventory: { ...(baseProfile.palmInventory || {}), palmCount: value },
              }
            : {};
        })());
        // The profile spread above still carries the RAW baseProfile fields —
        // when the verdict rejected the AI count and nothing explicit
        // replaced it, strip the estimate so the server translator (which
        // promotes estimatedPalmCount into palmInventory.palmCount) can't
        // price it.
        if (!palmPrefillAllowed(baseProfile) && !parsePositiveInteger(profile.palmCount)) {
          delete profile.estimatedPalmCount;
          if (profile.palmInventory && !parsePositiveInteger(profile.palmInventory.palmCount)) {
            delete profile.palmInventory.palmCount;
          }
        }
      }
      if (treeCount !== undefined) {
        profile.estimatedTreeCount = treeCount;
        profile.treeCount = treeCount;
      } else {
        delete profile.treeCount;
        delete profile.estimatedTreeCount;
      }
      if (measuredTurfSf !== undefined) {
        profile.measuredTurfSf = measuredTurfSf;
      } else {
        delete profile.measuredTurfSf;
      }
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
      // pool/cage, storiesSource, densities, nearWater, propertyType, and
      // the form-driven commercial classification are all set by
      // buildTurfRequestProfile above.

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

      // Stale rental gate (codex P1, round 2): the availability probe runs
      // once at mount, so GATE_TERMITE_STATION_RENTAL flipped OFF mid-session
      // (a deploy under an open tab) still sends termiteOwnership='rent' —
      // and the server silently prices a purchase while the form shows
      // "Rented". The calculation RESPONSE is the live truth: a rent request
      // on a selected termite program that comes back with no rental line
      // means the server no longer honors the feature. Reset to purchase,
      // hide the control, and drop this result so the operator regenerates
      // and SEES the purchase quote they would actually send.
      if (
        options.termiteOwnership === "rent"
        && selectedServices.includes("TERMITE_BAIT")
        && !(result?.recurring?.services || []).some((svc) => svc.service === "termite_station_rental")
      ) {
        setTermiteRentalAvailable(false);
        setForm((f) => ({ ...f, termiteOwnership: "own" }));
        setEstimate(null);
        alert("The server did not price this quote as a station rental (the rental option is off or not priceable for this configuration). The form has been reset to purchased stations — generate again to see the purchase quote.");
        return null;
      }

      // Stash the exact engine request so the server can replay it on save and
      // be the authority on the persisted price (Decision #2). This is the same
      // payload sent to /calculate-estimate above.
      result.engineRequest = { profile, selectedServices, options };
      if (estimateVersionRef.current !== versionAtStart) {
        // A pricing edit landed while the calculate call was in flight; the
        // invalidation already cleared the preview. Mounting this result would
        // pair stale pricing with the new form state (and Save would persist
        // the stale engineRequest), so drop it and let the operator regenerate.
        return null;
      }
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

  // estimateOverride: callers that generate-then-save in one handler pass the
  // freshly returned estimate — the `estimate` state in this closure is still
  // the pre-generate value (React state doesn't update mid-handler).
  async function doSave(estimateOverride = null, { deferInvoiceTotals = false } = {}) {
    if (editEstimateId && !editMode) return null;
    if (saveInFlightRef.current) return null;
    const estimateToSave = estimateOverride || estimate;
    if (!estimateToSave) return null;
    const deliveryError = validateDeliveryOptions(form, estimateToSave, { deferInvoiceTotals });
    if (deliveryError) {
      alert(deliveryError);
      return null;
    }
    saveInFlightRef.current = true;
    setSaving(true);
    setSaveError("");
    const savingForm = JSON.stringify(form);
    try {
      const E = estimateToSave;
      const quoteRequired = estimateRequiresQuote(E);
      const monthlyTotal = quoteRequired ? 0 : E.recurring?.grandTotal || 0;
      const onetimeTotal = quoteRequired ? 0 : E.oneTime?.total || 0;
      const estimateSummary = {
        manualDiscount: E.manualDiscount || E.totals?.manualDiscount || null,
        serviceSpecificDiscounts: E.serviceSpecificDiscounts || E.totals?.serviceSpecificDiscounts || [],
      };
      const isEditRevision = !!editMode?.id;
      if (!isEditRevision && !draftIdRef.current) draftIdRef.current = crypto.randomUUID();
      const payload = {
        ...(isEditRevision ? { expectedEditVersion: editMode.editVersion } : { clientDraftId: draftIdRef.current }),
        propertyId: form.propertyId || null,
        address: form.address,
        customerName: form.customerName || "",
        customerPhone: form.customerPhone || "",
        customerEmail: form.customerEmail || "",
        leadId: isEditRevision ? null : form.leadId || null,
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
        // Multi-property chain: a create started via "Add another property"
        // joins (or starts) the anchor estimate's group server-side. Never
        // sent on a revise — the row keeps its stored group linkage.
        ...(!isEditRevision && groupAnchorId
          ? { groupWithEstimateId: groupAnchorId }
          : {}),
      };
      // Edit mode publishes on save (same id + token — the customer's link
      // starts showing the updated quote), so a server-side reprice must be
      // confirmed BEFORE the write: preflight the same payload with dryRun.
      // A create lands as a draft and the send flow gates on the banner, so
      // it needs no preflight.
      if (isEditRevision) {
        const pf = await fetch(`/api/admin/estimates/${editMode.id}`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify({ ...payload, dryRun: true }),
        });
        if (!pf.ok)
          throw new Error(
            await summarizeEstimateResponseFailure(pf, "Save failed"),
          );
        const preflight = await pf.json();
        const preNotice = serverRecomputeNotice(preflight, monthlyTotal, onetimeTotal);
        if (preNotice) {
          const proceed = window.confirm(
            `The server recomputed the final price: ${describeRecomputeNotice(preNotice)}.\n\n` +
              "Saving publishes this recomputed price to the customer's existing link. Save it?",
          );
          if (!proceed) return null;
        }
      }
      // Edit mode revises the existing estimate in place; otherwise a
      // normal create.
      const r = await fetch(
        isEditRevision
          ? `/api/admin/estimates/${editMode.id}`
          : "/api/admin/estimates",
        {
          method: isEditRevision ? "PUT" : "POST",
          headers: authHeaders,
          body: JSON.stringify(payload),
        },
      );
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
      const recomputeNotice = serverRecomputeNotice(d, monthlyTotal, onetimeTotal);
      setPriceRecomputeNotice(recomputeNotice);
      setMemberLinkageWarning(d.memberLinkageWarning || null);
      setEditMode({ id, status: d.status || "draft", editVersion: d.editVersion, customerName: form.customerName || "", hasInputs: true });
      savedFormRef.current = savingForm;
      // A slow save must not bless fields edited while it was in flight.
      const stillCurrent = JSON.stringify(formRef.current) === savingForm;
      setSavedId(stillCurrent ? id : null);
      setSavedViewUrl(stillCurrent ? viewUrl : null);
      onDraftSaved?.(id);
      // recomputeNotice + memberLinkageWarning ride along so saveAndSend can
      // gate the send on them — the banner state set above renders too late
      // to stop an in-flight send (codex #3338 r6).
      return { id, viewUrl, recomputeNotice, memberLinkageWarning: d.memberLinkageWarning || null };
    } catch (e) {
      setSaveError(e.message);
      return null;
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  }

  // Commercial hand-off: the estimator can't price a commercial property
  // (manual quote required), so generate if needed, persist the draft —
  // capturing the contact, address, and property specs — and jump straight
  // into the proposal builder where the operator authors the line-item quote.
  async function openProposalBuilder() {
    // Every form/pricing/delivery-option edit clears savedId, so a non-null id
    // is a draft that already matches the current form — reuse it. Re-saving
    // a lead-less estimate inserts a duplicate row and leaves the earlier
    // draft (and its customer link) dangling in the pipeline.
    if (savedId) {
      navigate(`/admin/estimates/${savedId}/proposal`);
      return;
    }
    const generated = estimate || (await doGenerate());
    if (!generated) return;
    // Defer the bill-by-invoice zero-total guard: the manual-quote commercial
    // draft has no billable totals until the proposal lines are authored on
    // the page this navigates to.
    const saved = await doSave(generated, { deferInvoiceTotals: true });
    if (saved?.id) navigate(`/admin/estimates/${saved.id}/proposal`);
  }

  function nextEstimate() {
    if (dirty && !window.confirm("Start another estimate with unsaved changes?")) return;
    onStartNew?.();
    // A fresh estimate is OUTSIDE any group build: a stale anchor would make
    // the next unrelated save carry groupWithEstimateId and 400 on the
    // same-customer guard (codex #3244 r5). Clearing it also lets the
    // intake-list effect clear extracted addresses.
    setGroupAnchorId(null);
    setForm((f) => ({
      ...f,
      address: "",
      homeSqFt: "",
      stories: "1",
      unitCount: "",
      lotSqFt: "",
      propertyType: "Single Family",
      isCommercial: "NO",
      commercialSubtype: "",
      commercialRiskType: "",
      commercialPestCadence: "",
      commercialInteriorService: "",
      commercialLawnCadence: "",
      treeShrubDensity: "",
      mosquitoPressure: "",
      commercialPricingMode: "manual_quote",
      hasPool: "NO",
      hasPoolCage: "NO",
      poolCageSize: "MEDIUM",
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
      tsTier: "standard",
      tsAccess: "easy",
      measuredTurfSf: "",
      topDressArea: "",
      // Per-estimate dollar overrides never carry into the next customer's
      // quote (codex P2 #3223) — services stay selected, custom fees do not.
      roachFeeOverride: "",
      standaloneRoachFeeOverride: "",
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
      termiteBaitSystem: "trelona",
      termiteMonitoringTier: "basic",
      termiteBondTerm: "none",
      termiteOwnership: "own",
      termiteScope: "bait_monitoring_no_warranty",
      trenchingPerimeterLF: "",
      trenchingConcreteLF: "",
      trenchingDirtLF: "",
      trenchingConcretePct: "",
      trenchingEstimateFromFootprint: false,
      trenchingProductKey: "taurus_sc",
      trenchingApplicationRate: "standard",
      trenchingDepthFt: "0.5",
      trenchingWarrantyTier: "one_year_retreat",
      trenchingLabelConfirmed: false,
      customerId: "",
      leadId: "",
      customerName: "",
      customerPhone: "",
      customerEmail: "",
      leadServiceInterest: "",
      _termiteFootprintAuto: false,
      _footprintUnknownLookup: false,
      _trenchingPerimeterAuto: false,
      _boracareSqftAuto: false,
      _preslabSqftAuto: false,
      // Guarantee eligibility is per-job; the next property must re-confirm.
      ...Object.fromEntries(PER_JOB_ELIGIBILITY_KEYS.map((k) => [k, false])),
    }));
    // Starting the next customer's quote ends any in-place edit — otherwise
    // Save changes would still PUT the new quote over the estimate that was
    // being edited.
    setEditMode(null);
    draftIdRef.current = null;
    setEditLoadError(null);
    setEstimate(null);
    setSavedId(null);
    setSavedViewUrl(null);
    setLookupStatus({ type: "", msg: "" });
    setEnrichedProfile(null);
    setExistingCustomerMatch(null);
    setAddressMatches([]);
    preLinkContactRef.current = null;
    setSatelliteStatus({ type: "", msg: "" });
    setSatelliteData(null);
    setCustomerSearch("");
    setCustomers([]);
  }

  async function reviewAndSend() {
    if (generating || saving || sending) return;
    if (!savedId || !editMode?.editVersion) {
      setSaveError("Save this version before reviewing its recipient and sending.");
      return;
    }
    const warnings = [
      priceRecomputeNotice ? `The server recomputed the saved price: ${describeRecomputeNotice(priceRecomputeNotice)}.` : null,
      memberLinkageWarning?.message,
      provisionalState.provisional ? `Property data is provisional: ${provisionalSummary(provisionalState)}. Pricing may change after field verification.` : null,
    ].filter(Boolean).join(" ");
    setSending(true);
    try {
      const outcome = await openSend(savedId, { expectedEditVersion: editMode.editVersion, warning: warnings });
      if (!outcome) return;
      // Sending changes status/timestamps. Refresh our own concurrency token
      // without discarding edits or claiming that a handoff means delivery.
      const response = await fetch(`/api/admin/estimates/${editMode.id}/edit-source`, { headers: authHeaders });
      const source = await response.json();
      if (!response.ok) throw new Error(source.error || "Refresh the estimate before another edit.");
      if (JSON.stringify(formRef.current) !== savedFormRef.current) {
        throw new Error("The saved estimate changed while you were editing. Your fields are retained; reopen the saved version before another save.");
      }
      const seeded = formFromEditSource(source);
      previousAddressRef.current = seeded.address;
      rgIdentityRef.current = `${seeded.address || ""}|${seeded.customerId || ""}|${seeded.customerName || ""}|${seeded.customerEmail || ""}`;
      savedFormRef.current = JSON.stringify(seeded);
      setForm(seeded);
      setEnrichedProfile(source.engineProfile || null);
      setExistingCustomerMatch(source.customer || null);
      setEditMode((current) => ({ ...current, status: source.status, editVersion: source.editVersion }));
      if (!source.editable) setEditLoadError(source.blockReason);
      setEstimate(source.result ? { ...source.result, engineRequest: source.engineRequest } : null);

    } catch (err) {
      setSaveError(err.message);
    } finally {
      setSending(false);
    }
  }

  function previewCustomerEstimate() {
    if (generating || saving || sending) return;
    if (!savedId || !savedViewUrl) {
      setSaveError("Save this version before opening its customer preview.");
      document.getElementById("estimate-review")?.scrollIntoView({ block: "start" });
      return;
    }
    window.open(`${savedViewUrl}${savedViewUrl.includes("?") ? "&" : "?"}adminPreview=1`, "_blank", "noopener,noreferrer");
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
    // Show the number the pricing engine will ACTUALLY use — footprint,
    // hardscape and plausible-max cap included — not the local 20%/15%
    // heuristic below. Live value from /turf-preview tracks form edits;
    // on the stale-imagery path the profile's lookup-time
    // turfFallbackPreviewSf covers the gap until it answers. The heuristic
    // is only the fail-open fallback for a preview miss.
    const enginePreview = parseNonNegativeInteger(
      enginePreviewSf ??
        (turfUnobservable ? enrichedProfile?.turfFallbackPreviewSf : null),
    );
    // Zero included: an engine 0 (footprint + hardscape consume the lot) is
    // the authoritative answer, not a miss — falling through to the local
    // heuristic would display a positive area the engine won't price
    // (codex P2 r4 #3098).
    if (enginePreview !== null) return enginePreview;
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
  const turfHighLotRatio =
    aiTurfSqFt !== null && lotSqFtForTurf > 0 && aiTurfSqFt / lotSqFtForTurf >= 0.55;
  const turfReviewReasons = [
    turfHighLotRatio
      ? `AI turf is ${Math.round((aiTurfSqFt / lotSqFtForTurf) * 100)}% of lot`
      : null,
    Number(enrichedProfile?.aiConfidence) > 0 && Number(enrichedProfile?.aiConfidence) < 60
      ? `AI confidence ${enrichedProfile.aiConfidence}%`
      : null,
    form.treeDensity === "HEAVY" ? "heavy tree canopy" : null,
    // Qualifier only — mirrors turfRiskReasons() in property-lookup-v2.js.
    turfHighLotRatio && form.nearWater === "YES" ? "water adjacency" : null,
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
  const provisionalState = computeProvisionalState(
    enrichedProfile?.propertyDataQuality
  );
  // Present-mode trust gates: a custom-quote estimate has no firm price to show,
  // and an unsaved one hasn't been through the server-authoritative recompute.
  const presentQuoteRequired = !!estimate && estimateRequiresQuote(estimate);
  const generateBusy = generating || saving || sending || (!!editEstimateId && !editMode);

  // ═══════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════
  return (
    <FormCtx.Provider value={formCtx}>
      <header className="px-4 md:px-7 py-4 border-b border-zinc-200 mb-5">
        <Button variant="ghost" className="min-h-11 mb-2" onClick={() => {
          if (!dirty || window.confirm("Leave this estimate with unsaved changes?")) onBack?.();
        }}>← Back to Pipeline</Button>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h1 className="text-24 font-semibold">{editMode ? "Edit estimate" : "Create estimate"}</h1>
          <span role="status" className="text-14 text-zinc-600">{saving ? "Saving…" : generating ? "Recalculating pricing…" : dirty ? "Unsaved changes" : editMode ? "Saved estimate loaded" : "New estimate"}</span>
        </div>
        {form.customerPhone && <Button variant="secondary" className="min-h-11" onClick={() => openMessages?.({ id: form.customerId, firstName: form.customerName, phone: form.customerPhone })}>Message contact</Button>}
        <nav aria-label="Estimate sections" className="flex flex-wrap gap-2 mt-3">
          {[["customer", "Customer & property"], ["services", "Services"], ["pricing", "Pricing & terms"], ["review", "Review & send"]].map(([key, label]) =>
            <Button key={key} variant="ghost" className="min-h-11" onClick={() => document.getElementById(`estimate-${key}`)?.scrollIntoView({ block: "start" })}>{label}</Button>)}
        </nav>
      </header>
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
          .waves-roboto-scope :is(button, input, select, textarea), .estimate-workflow-section { scroll-margin-block: 100px; }
        `}</style>
        {editLoadError && (
          <div className="mb-4 flex items-start justify-between gap-4 border-hairline border-zinc-300 rounded-xs bg-zinc-50 px-4 py-3">
            <div className="text-14 text-zinc-700">
              <span className="font-medium text-zinc-900">
                Couldn&apos;t open the estimate for editing.
              </span>{" "}
              {editLoadError}
            </div>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setEditLoadError(null)}
            >
              Dismiss
            </Button>
          </div>
        )}
        {editMode && (
          <div className="mb-4 flex flex-wrap items-start justify-between gap-3 border-hairline border-zinc-900 rounded-xs bg-zinc-50 px-4 py-3">
            <div className="text-14 text-zinc-700">
              <div className="font-medium text-zinc-900">
                Editing existing estimate
                {editMode.customerName ? ` for ${editMode.customerName}` : ""} ·
                status {editMode.status}
              </div>
              <div className="mt-1">
                {["sent", "viewed"].includes(editMode.status)
                  ? "Saving publishes changes to the customer's existing link. Resend after saving to notify them."
                  : "Saving keeps this draft under the same estimate. Sending is a separate action."}
              </div>
              {!editMode.hasInputs && (
                <div className="mt-1">
                  This estimate wasn&apos;t authored in the builder, so its
                  original inputs couldn&apos;t be restored. Re-enter the
                  property details and services, then Generate before saving.
                </div>
              )}
            </div>
            <Button variant="secondary" size="sm" onClick={exitEditMode}>
              Exit edit mode
            </Button>
          </div>
        )}
        {(groupEstimates.length > 1 || groupAnchorId) && (
          <Card className="p-4 mb-5">
            <PanelTitle description="One customer, several service addresses. Sending any estimate in the group delivers a single link that shows every property; each is accepted on its own.">
              Multi-Property Group
            </PanelTitle>
            <div className="flex flex-col">
              {groupEstimates.map((g) => (
                <div
                  key={g.id}
                  className="flex items-center gap-3 py-2 border-b-hairline border-zinc-200 last:border-b-0"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-14 text-zinc-900 truncate">
                      {g.address || "(no address)"}
                    </div>
                    <div className="text-14 text-ink-secondary">
                      {g.monthlyTotal != null && g.monthlyTotal > 0
                        ? `$${Number(g.monthlyTotal).toFixed(2)}/mo`
                        : g.onetimeTotal != null && g.onetimeTotal > 0
                          ? `$${Number(g.onetimeTotal).toFixed(2)} one-time`
                          : "no total yet"}
                    </div>
                  </div>
                  <Badge>{g.status}</Badge>
                  {editMode?.id === g.id || savedId === g.id ? (
                    <span className="text-14 text-ink-secondary">
                      on screen
                    </span>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        if (!dirty || window.confirm("Leave this estimate with unsaved changes?")) navigate(`/admin/estimates?editEstimateId=${g.id}`);
                      }}
                    >
                      Edit
                    </Button>
                  )}
                </div>
              ))}
              {groupAnchorId && !savedId && (
                <div className="flex items-center gap-3 py-2">
                  <div className="flex-1 min-w-0">
                    <div className="text-14 text-zinc-900 truncate">
                      {form.address || "New property — enter address"}
                    </div>
                    <div className="text-14 text-ink-secondary">
                      current draft, not saved yet
                    </div>
                  </div>
                  <Badge>unsaved</Badge>
                </div>
              )}
            </div>
            <div className="text-14 text-ink-secondary mt-2">
              The 10% Multi-Home Discount applies to ADDED properties only —
              it is pre-selected on each new draft here. The first property
              stays full price (owner ruling 2026-08-06); do not add the
              discount to the anchor estimate.
            </div>
          </Card>
        )}
        {leadAdditionalProperties.length > 0 && (
          <Card className="p-4 mb-5">
            <PanelTitle description="The call for this lead mentioned more than one service address. Quote each as its own estimate — chained estimates group under one customer link.">
              Caller Mentioned Additional Properties
            </PanelTitle>
            <div className="flex flex-col">
              {leadAdditionalProperties.map((p, i) => {
                const composedAddress = [
                  [p.address_line1, p.address_line2].filter(Boolean).join(" "),
                  p.city,
                  [p.state || "FL", p.zip].filter(Boolean).join(" "),
                ]
                  .filter(Boolean)
                  .join(", ");
                return (
                  <div
                    key={`${p.address_line1}-${i}`}
                    className="flex items-center gap-3 py-2 border-b-hairline border-zinc-200 last:border-b-0"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-14 text-zinc-900 truncate">
                        {composedAddress}
                      </div>
                      <div className="text-14 text-ink-secondary">
                        {[
                          p.is_rental ? "rental" : null,
                          p.property_type || null,
                          p.notes || null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "no extra details from the call"}
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={!savedId && !editMode?.id}
                      onClick={() => addAnotherProperty({ address: composedAddress })}
                    >
                      Quote next
                    </Button>
                  </div>
                );
              })}
            </div>
            {!savedId && !editMode?.id && (
              <div className="text-14 text-ink-secondary mt-2">
                Save the current estimate first — then each of these can be
                quoted as the next property in the group.
              </div>
            )}
          </Card>
        )}
        <div className="grid gap-7 grid-cols-1 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)]">
          {/* ═══ LEFT COLUMN: FORM ═══ */}
          <div className="space-y-6 min-w-0">
            <section id="estimate-customer" className="estimate-workflow-section space-y-4" aria-label="Customer and property">
            <h2 className="text-20 font-semibold">Customer & property</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-3">
              <FieldV2 label="Customer name"><InputV2 k="customerName" /></FieldV2>
              <FieldV2 label="Phone"><InputV2 k="customerPhone" type="tel" /></FieldV2>
              <FieldV2 label="Email" className="sm:col-span-2"><InputV2 k="customerEmail" type="email" /></FieldV2>
            </div>
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
                        onClick={() => applyCustomerLink(c, { adoptAddress: true })}
                        className="w-full text-left px-3 py-2 border-b-hairline border-zinc-200 last:border-b-0 hover:bg-zinc-50 cursor-pointer"
                      >
                        {" "}
                        <div className="text-14 text-zinc-900 font-medium">
                          {name}
                        </div>{" "}
                        <div className="text-14 text-ink-secondary">
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
              <PanelTitle>Service property</PanelTitle>
              {propertiesError && <p role="alert" className="text-14 text-alert-fg mb-3">{propertiesError}</p>}
              {customerProperties.length > 0 && <div className="mb-4">
                <label htmlFor="estimate-service-property" className="block text-14 font-medium mb-2">Customer property</label>
                <select id="estimate-service-property" className={INPUT_CLS} value={form.propertyId || ""} onChange={(event) => selectServiceProperty(event.target.value)}>
                  <option value="">Choose a saved service property, or enter an address</option>
                  {customerProperties.map((property) => <option key={property.id} value={property.id}>
                    {[property.label, property.address_line1, property.address_line2, property.city, property.zip].filter(Boolean).join(" · ")}
                  </option>)}
                </select>
                <p className="text-14 text-zinc-600 mt-2">Changing property clears its measurements. Contact and account records are unchanged.</p>
              </div>}
              <FieldV2 label="Service address">
                {" "}
                <input
                  ref={addressRef}
                  aria-label="Service address"
                  type="text"
                  value={form.address}
                  onChange={(e) => set("address", e.target.value)}
                  placeholder="Start typing an address..."
                  className={INPUT_CLS}
                />{" "}
              </FieldV2>
              {form.leadServiceInterest && (
                <div className="mb-3 px-3 py-2 bg-zinc-50 border-hairline border-zinc-300 rounded-xs text-14 text-zinc-900">
                  Lead interest:{" "}
                  <strong>{form.leadServiceInterest}</strong>{" "}
                </div>
              )}
              <StatusLine status={lookupStatus} />{" "}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-2">
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
                      unitCount: "",
                      propertyType: "Single Family",
                      isCommercial: "NO",
                      commercialSubtype: "",
                      commercialRiskType: "",
                      commercialPestCadence: "",
                      commercialInteriorService: "",
                      commercialLawnCadence: "",
                      treeShrubDensity: "",
                      mosquitoPressure: "",
                      commercialPricingMode: "manual_quote",
                      hasPool: "NO",
                      hasPoolCage: "NO",
                      poolCageSize: "MEDIUM",
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
                      // Billable per-property T&S choices — a 9x / difficult
                      // pick must not ride into the next property's quote
                      // (pre-push r8 P1).
                      tsTier: "standard",
                      tsAccess: "easy",
                      measuredTurfSf: "",
                      // Structure-specific measurements must clear with the
                      // property — leaving them meant house B could be quoted
                      // on house A's attic sqft or trench footage. (Contact/
                      // lead linkage intentionally survives Clear All; product
                      // choices keep their defaults.)
                      termiteFootprintSqFt: "",
                      termitePerimeterLF: "",
                      boracareSqft: "",
                      boracareSurfaceLinearFt: "",
                      boracareSurfaceHeightFt: "",
                      preslabSqft: "",
                      trenchingPerimeterLF: "",
                      trenchingConcreteLF: "",
                      trenchingDirtLF: "",
                      trenchingConcretePct: "",
                      // The footprint-derivation choice is a per-property
                      // measurement method — left true, the next property
                      // auto-prices trenching from ITS footprint with the
                      // missing-measurement warning suppressed.
                      trenchingEstimateFromFootprint: false,
                      _termiteFootprintAuto: false,
                      _footprintUnknownLookup: false,
                      _trenchingPerimeterAuto: false,
                      _boracareSqftAuto: false,
                      _preslabSqftAuto: false,
                    }));
                    setLookupStatus({ type: "", msg: "" });
                    setEnrichedProfile(null);
                    setExistingCustomerMatch(null);
                    setAddressMatches([]);
                    // The customer linkage survives Clear All (customerId is
                    // kept above), so the pre-link snapshot must survive with
                    // it — a later Unlink still restores what was typed
                    // (codex #3768 r4).
                    setSatelliteStatus({ type: "", msg: "" });
                    setSatelliteData(null);
                    setEstimate(null);
                    // A saved row priced on the cleared property is stale too.
                    setSavedId(null);
                    setSavedViewUrl(null);
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
                    <div className="text-14 font-medium uppercase tracking-label text-ink-secondary">
                      Property Data Quality
                    </div>{" "}
                    <div
                      className={`text-14 font-medium uppercase tracking-label ${
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
                  <div className="text-14 text-ink-secondary">
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
                    <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-1">
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
                            className="text-14 text-ink-tertiary truncate"
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
                    <div key={i} className="text-14 text-alert-fg">
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
                    className="mt-1.5 text-14 underline text-zinc-900 disabled:no-underline disabled:text-zinc-500"
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
                <div className="mb-2.5 px-3 py-2 bg-zinc-50 border-hairline border-zinc-300 rounded-xs text-14 text-zinc-900 flex items-center gap-2">
                  <span className="flex-1 min-w-0">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-900 mr-1.5 align-middle" />
                    Existing customer:{" "}
                    <strong>
                      {existingCustomerMatch.firstName}{" "}
                      {existingCustomerMatch.lastName}
                    </strong>
                    {matchHasActivePlan(existingCustomerMatch)
                      ? " · Recurring plan"
                      : " · No active plan"}
                    {matchHasActivePlan(existingCustomerMatch) &&
                    existingCustomerMatch.monthlyRate > 0 &&
                    form.isRecurringCustomer === "YES"
                      ? " · 15% loyalty discount applied"
                      : ""}
                  </span>
                  {canUnlink && (
                    <button
                      type="button"
                      onClick={unlinkCustomer}
                      className="bg-transparent border-0 p-0 cursor-pointer text-14 text-zinc-600 underline underline-offset-2 hover:text-zinc-900 shrink-0"
                    >
                      Unlink
                    </button>
                  )}
                </div>
              )}
              {/* ID-only linked state: the customer-record deep link seeds
                  form.customerId with no match object. The estimate IS linked
                  (lookup skips suggestions, save carries the id), so the
                  operator needs the same Unlink here (see canUnlink). */}
              {!existingCustomerMatch && form.customerId && canUnlink && (
                <div className="mb-2.5 px-3 py-2 bg-zinc-50 border-hairline border-zinc-300 rounded-xs text-14 text-zinc-900 flex items-center gap-2">
                  <span className="flex-1 min-w-0">
                    <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-900 mr-1.5 align-middle" />
                    Linked customer:{" "}
                    <strong>{form.customerName || "from the customer record"}</strong>
                  </span>
                  <button
                    type="button"
                    onClick={unlinkCustomer}
                    className="bg-transparent border-0 p-0 cursor-pointer text-14 text-zinc-600 underline underline-offset-2 hover:text-zinc-900 shrink-0"
                  >
                    Unlink
                  </button>
                </div>
              )}
              {addressMatches.length > 0 &&
                addressMatchesFor === addressMatchKey(form.address, form.customerPhone, form.customerEmail) &&
                !existingCustomerMatch &&
                !form.customerId && (
                  <div className="mb-2.5 border-hairline border-zinc-300 rounded-xs overflow-hidden">
                    <div className="px-3 py-2 bg-zinc-50 border-b border-zinc-200 text-14 font-medium text-zinc-900">
                      This address matches{" "}
                      {addressMatches.length === 1
                        ? "an existing customer"
                        : `${addressMatches.length} existing customers`}
                    </div>
                    {addressMatches.map((c) => {
                      const name =
                        `${c.firstName || ""} ${c.lastName || ""}`.trim() ||
                        "(no name)";
                      return (
                        <div
                          key={c.id}
                          className="flex items-center gap-3 px-3 py-2 border-b-hairline border-zinc-200"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="text-14 text-zinc-900 font-medium truncate">
                              {name}
                              {c.contactMatch === "phone" && (
                                <span className="font-normal text-zinc-500"> · phone matches</span>
                              )}
                              {c.contactMatch === "email" && (
                                <span className="font-normal text-zinc-500"> · email matches</span>
                              )}
                            </div>
                            <div className="text-14 text-ink-secondary truncate">
                              {[
                                // Street line incl. unit, so two units of one
                                // building are distinguishable before linking.
                                c.streetLine || (c.address ? c.address.split(",")[0].trim() : null),
                                c.phone,
                                c.email,
                                matchHasActivePlan(c) ? c.tier : null,
                              ]
                                .filter(Boolean)
                                .join(" · ") || "no contact on file"}
                            </div>
                          </div>
                          <Button
                            type="button"
                            variant="secondary"
                            size="sm"
                            onClick={() => applyCustomerLink(c, { adoptAddress: false })}
                          >
                            Link
                          </Button>
                        </div>
                      );
                    })}
                    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 px-3 py-2 bg-zinc-50">
                      <span className="text-14 text-ink-secondary">
                        Or search above to link someone else.
                      </span>
                      <button
                        type="button"
                        onClick={() => setAddressMatches([])}
                        className="bg-transparent border-0 p-0 cursor-pointer text-14 text-zinc-900 underline underline-offset-2 shrink-0 self-start sm:self-auto"
                      >
                        Not this person — keep what I typed
                      </button>
                    </div>
                  </div>
                )}
              {openAddressAsks.length > 0 && (
                <div className="mb-2.5 px-3 py-2 bg-zinc-50 border-hairline border-zinc-300 rounded-xs text-14 text-zinc-900">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-zinc-900 mr-1.5 align-middle" />
                  <strong>Address still being confirmed</strong>
                  {" — "}
                  {openAddressAsks.some((i) => i.reason_code === "missing_unit_number")
                    ? "the caller gave the building but no unit number"
                    : "the address from the call did not validate"}
                  {(() => {
                    const b = openAddressAsks.find((i) => i.payload?.unit_ask_building?.street_line_1)?.payload
                      ?.unit_ask_building;
                    return b
                      ? ` (${[b.street_line_1, b.city, b.postal_code].filter(Boolean).join(", ")})`
                      : "";
                  })()}
                  . Callback pending in the Triage Inbox — this lookup may be the whole building, not
                  the unit.
                </div>
              )}
              {/* Gated on the DATA, not on existingCustomerMatch — the
                  deep-link entry path links a customer without setting a
                  match object, and the panel must render there too. */}
              {customerSpend?.currentServices?.length > 0 && (
                  <div className="mb-2.5 border-hairline border-zinc-300 rounded-xs overflow-hidden">
                    <div className="px-3 py-2 border-b border-zinc-200 bg-zinc-50 text-14 font-medium text-zinc-900">
                      Currently pays per application
                      {customerSpend.currentTierLabel ? (
                        <span className="font-normal text-zinc-500">
                          {" "}
                          · {customerSpend.currentTierLabel}
                          {Number(customerSpend.currentDiscountPct) > 0
                            ? ` (${customerSpend.currentDiscountPct}% off)`
                            : ""}
                        </span>
                      ) : null}
                    </div>
                    {customerSpend.currentServices.map((service) => {
                      const perProperty = spendContractRows(service);
                      return (
                        <div
                          key={service.key}
                          className="px-3 py-2 border-b border-zinc-100 last:border-b-0"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div>
                              <div className="text-14 text-zinc-900">
                                {service.label}
                              </div>
                              <div className="text-14 text-zinc-500">
                                {[
                                  ...spendDetailParts(service),
                                  service.qualifiesForWaveGuard === false
                                    ? "not a tier service"
                                    : null,
                                  perProperty.length
                                    ? `${perProperty.length} properties`
                                    : null,
                                ]
                                  .filter(Boolean)
                                  .join(" · ")}
                              </div>
                            </div>
                            {/* ml-auto keeps the amount right-aligned on
                                phones, where flex-wrap drops it onto its own
                                line and justify-between would otherwise
                                left-align it. */}
                            {perProperty.length ? null : (
                              <div className="text-right ml-auto">
                                <div className="text-16 text-zinc-900 tabular-nums">
                                  {service.currentPerVisit == null
                                    ? "Not available"
                                    : `$${Number(service.currentPerVisit).toFixed(2)}`}
                                </div>
                                <div className="text-14 text-zinc-500">
                                  per application
                                </div>
                              </div>
                            )}
                          </div>
                          {perProperty.map((contract, i) => (
                            <div
                              key={contract.serviceAddress || i}
                              className="flex flex-wrap items-baseline justify-between gap-2 mt-1.5 pl-3 border-l-hairline border-zinc-200"
                            >
                              <div className="text-14 text-zinc-500">
                                {[
                                  contract.serviceAddress || "Property not recorded",
                                  ...spendDetailParts(contract),
                                ].join(" · ")}
                              </div>
                              <div className="ml-auto text-14 text-zinc-900 tabular-nums">
                                {contract.perVisit == null
                                  ? "Not available"
                                  : `$${Number(contract.perVisit).toFixed(2)}`}
                                <span className="text-zinc-500">
                                  {" "}
                                  / application
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      );
                    })}
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
                          <div className="text-14 text-zinc-900 text-center mt-0.5 font-medium uppercase tracking-label">
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
                          <div className="text-14 text-zinc-900 text-center mt-0.5 font-medium uppercase tracking-label">
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
                          <div className="text-14 text-ink-tertiary text-center mt-0.5 uppercase tracking-label">
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
                        <div className="text-14 text-ink-tertiary text-center mt-0.5 uppercase tracking-label">
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
                          <div className="text-14 text-ink-tertiary text-center mt-0.5 uppercase tracking-label">
                            Area
                          </div>{" "}
                        </div>
                      )}
                    </div>
                    {satelliteData.aiSources?.length > 0 && (
                      <div className="text-14 text-ink-secondary mb-1">
                        AI Analysis: {formatAiSources(satelliteData.aiSources)}{" "}
                        {satelliteData.aiSources.length > 1
                          ? "(multi-model)"
                          : ""}
                      </div>
                    )}
                    {satelliteData.aiWarnings?.length > 0 && (
                      <div className="text-14 text-alert-fg mb-1">
                        {satelliteData.aiWarnings.join(" ")}
                      </div>
                    )}
                    {satelliteData.fieldVerify?.length > 0 && (
                      <div className="text-14 text-alert-fg font-medium px-3 py-1.5 bg-alert-bg rounded-xs">
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
                      <div className="text-14 text-ink-tertiary mt-1 italic">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              {(commercialDetected || form.commercialRiskType) && (
                <FieldV2 label="Business type (cadence)">
                  <SelectV2
                    k="commercialRiskType"
                    options={[
                      { value: "", label: "— Select business type —" },
                      { value: "office_low", label: "Office / low-traffic" },
                      { value: "retail_standard", label: "Retail / standard" },
                      { value: "hoa_common_area", label: "HOA / common area" },
                      { value: "warehouse_distribution", label: "Warehouse / distribution" },
                      { value: "restaurant_food", label: "Restaurant / food service" },
                      { value: "healthcare_childcare", label: "Healthcare / childcare" },
                      { value: "hotel_resort", label: "Hotel / resort" },
                      { value: "multifamily", label: "Multifamily" },
                    ]}
                  />
                </FieldV2>
              )}
              {(commercialDetected || form.commercialPestCadence) && (
                <FieldV2 label="Pest cadence override">
                  <SelectV2
                    k="commercialPestCadence"
                    options={[
                      { value: "", label: "Program default (by business type)" },
                      { value: "quarterly", label: "Quarterly (4x/yr)" },
                      { value: "bimonthly", label: "Bi-monthly (6x/yr)" },
                      { value: "monthly", label: "Monthly (12x/yr)" },
                    ]}
                  />
                </FieldV2>
              )}
              {(commercialDetected || form.commercialInteriorService) && (
                <FieldV2 label="Pest interior service">
                  <SelectV2
                    k="commercialInteriorService"
                    options={[
                      { value: "", label: "Included (default)" },
                      { value: "excluded", label: "Exterior-only (interior offered as add-on)" },
                    ]}
                  />
                </FieldV2>
              )}
              {(commercialDetected || form.commercialLawnCadence) && form.svcLawn && (
                <FieldV2 label="Lawn cadence override">
                  <SelectV2
                    k="commercialLawnCadence"
                    options={[
                      { value: "", label: "Program default (8 apps/yr)" },
                      { value: "4", label: "4 apps/yr (quarterly)" },
                      { value: "6", label: "6 apps/yr (every other month)" },
                      { value: "10", label: "10 apps/yr" },
                      { value: "12", label: "12 apps/yr (monthly)" },
                    ]}
                  />
                </FieldV2>
              )}
              {commercialDetected && form.svcTs && (
                <FieldV2 label="Tree & Shrub density">
                  <SelectV2
                    k="treeShrubDensity"
                    options={[
                      { value: "", label: "Normal (default)" },
                      { value: "low", label: "Low / sparse (0.75×)" },
                      { value: "normal", label: "Normal (1.0×)" },
                      { value: "high", label: "High / dense (1.5×)" },
                      { value: "very_high", label: "Very high — manual quote" },
                    ]}
                  />
                </FieldV2>
              )}
              {commercialDetected && form.svcMosquito && (
                <FieldV2 label="Mosquito pressure">
                  <SelectV2
                    k="mosquitoPressure"
                    options={[
                      { value: "", label: "Normal (default)" },
                      { value: "low", label: "Low (0.85×)" },
                      { value: "normal", label: "Normal (1.0×)" },
                      { value: "high", label: "High (1.35×)" },
                      { value: "severe", label: "Severe — manual quote" },
                    ]}
                  />
                </FieldV2>
              )}
              {commercialDetected && (
                <div className="mb-3 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs text-14 text-alert-fg">
                  {COMMERCIAL_WARNING_TEXT}
                  <div className="mt-2">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={saving || generating}
                      title="Generates and saves a draft estimate, then opens the line-item proposal builder"
                      onClick={openProposalBuilder}
                    >
                      {generating
                        ? "Generating…"
                        : saving
                          ? "Saving…"
                          : "Save draft & build commercial proposal"}
                    </Button>
                  </div>
                </div>
              )}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {" "}
                <FieldV2 label="Home Sq Ft">
                  <InputV2 k="homeSqFt" type="number" placeholder="2000" />
                </FieldV2>{" "}
                <FieldV2 label="Stories">
                  {" "}
                  <InputV2 k="stories" type="number" min="1" max="4" />
                  {enrichedProfile?.storiesSource === "default" && (
                    <div className="mt-1 text-14 text-alert-fg">
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
              <FieldV2 label="Units on parcel">
                <InputV2 k="unitCount" type="number" min="1" max="2000" placeholder="1" />
                <div className="mt-1 text-14 opacity-70">
                  Whole-parcel total. Corrects a wrong lookup count (e.g. a
                  single condo unit read as the whole building) when saved as
                  verified.
                </div>
                {unitCountSavable && (
                  <button
                    type="button"
                    onClick={saveVerifiedUnitCount}
                    disabled={unitSaveState === "saving" || unitSaveState === "saved"}
                    className="mt-1 text-14 underline text-zinc-900 disabled:no-underline disabled:text-zinc-500"
                  >
                    {unitSaveState === "saving"
                      ? "Saving verified count…"
                      : unitSaveState === "saved"
                        ? "Verified count saved — future lookups will use it"
                        : unitSaveState === "error"
                          ? "Save failed — tap to retry"
                          : "Save unit count as field-verified"}
                  </button>
                )}
              </FieldV2>
              {(form.svcTs || form.svcInjection) && (
                <>
                  {" "}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                  {form.svcTs && !commercialDetected && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      {/* Residential only: the commercial ornamental pricer
                          has a fixed cadence and no access term, so these
                          would be inert there. Tier names are application
                          counts (owner directive 2026-08-04) and the 9x
                          program is sellable here — the builder used to
                          hardcode standard (audit INP-004). Keys stay
                          light/standard/enhanced. */}
                      <FieldV2 label="Program">
                        <SelectV2
                          k="tsTier"
                          options={[
                            { value: "light", label: "4x applications/yr" },
                            { value: "standard", label: "6x applications/yr" },
                            { value: "enhanced", label: "9x applications/yr" },
                          ]}
                        />
                      </FieldV2>
                      <FieldV2 label="Access">
                        <SelectV2
                          k="tsAccess"
                          options={[
                            { value: "easy", label: "Easy" },
                            { value: "moderate", label: "Moderate (+8m)" },
                            { value: "difficult", label: "Difficult (+15m)" },
                          ]}
                        />
                      </FieldV2>
                    </div>
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
            </section>
            {/* Services */}
            <section id="estimate-services" className="estimate-workflow-section" aria-label="Services">
              <h2 className="text-20 font-semibold mb-4">Services</h2>
              {" "}
              <PanelTitle>Services to Quote</PanelTitle>{" "}
              <SubGroupLabel>Recurring Programs</SubGroupLabel>{" "}
              <CheckboxV2 k="svcLawn" label="Lawn Care" />
              {form.svcLawn && commercialDetected && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200 text-14 text-zinc-600">
                  Commercial turf treatment is auto-priced (estimated — confirmed on site). Residential lawn pricing is suppressed.
                </div>
              )}
              {form.svcLawn && !commercialDetected && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                      {/* 4 — Quarterly retired for new sales (owner directive
                          2026-07-09); the engine hides the basic tier. */}
                      <SelectV2
                        k="lawnFreq"
                        options={[
                          { value: "6", label: "6 — Bi-monthly" },
                          { value: "9", label: "9 — Every 6 weeks" },
                          { value: "12", label: "12 — Monthly" },
                        ]}
                      />
                    </FieldV2>
                  </div>{" "}
                  {/* Bermuda-in-St.-Augustine suppression add-on — dark behind
                      GATE_BERMUDA_SUPPRESSION. The control renders when the
                      server reports the gate on (subFeaturesAvailable) OR the
                      form already carries a saved selection — while gated off
                      the checkbox is the only way to UNCHECK a reopened saved
                      estimate (every regeneration/send 409s until it's
                      removed). The engine additionally fails closed, so a
                      stale client can never produce a silent unchanged price.
                      St. Augustine track only. */}
                  {(bermudaSuppressionAvailable || form.bermudaSuppression) && form.grassType === "st_augustine" && (
                    <div className="mt-3">
                      <CheckboxV2
                        k="bermudaSuppression"
                        label="Bermudagrass suppression add-on (baked into per-application price)"
                      />
                      {form.bermudaSuppression && !bermudaSuppressionAvailable && (
                        <div className="ml-7 mb-1 text-14 text-zinc-600">
                          This add-on is currently disabled (GATE_BERMUDA_SUPPRESSION) — uncheck it
                          to reprice, send, or accept this estimate without it.
                        </div>
                      )}
                      {form.bermudaSuppression && (
                        <div className="ml-7 mb-1 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200 text-14 text-zinc-600">
                          Recognition + Fusilade II tank mix under the FL 2(ee) — max 2 applications
                          per growing season, spring only. Verify before quoting: cultivar
                          (ProVista/Captiva excluded; Seville do-not-treat; CitraBlue or unknown
                          cultivar needs a test area first), lawn is not already mostly bermuda
                          (recommend renovation instead), turf unstressed. Torpedograss is
                          suppression-only — never sell as removal. Pricing is plan-spread by
                          design (owner ruling): the adder raises every application, annualizing
                          a program that includes up to 2 suppression treatments each spring
                          plus the follow-up inspection.
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
              {hasTurfPricedSelection && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="flex items-center justify-between gap-3 mb-2">
                    <div className="text-14 font-medium text-zinc-900">
                      Treatable Lawn Area
                    </div>
                    <Badge variant="neutral" className="text-14 u-nums">
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
                        className="h-10 px-3 text-14"
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
                  <div className="mt-1 flex items-center justify-between text-14 text-ink-secondary">
                    <span>0 sf</span>
                    <span className="font-medium text-zinc-900 u-nums">
                      {turfDisplaySource}:{" "}
                      {formatSqFt(effectiveTurfSqFt)}
                    </span>
                    <span>{turfSliderMax.toLocaleString()} sf</span>
                  </div>
                  {enrichedProfile?.turfObservation === "unobservable" &&
                    confirmedTurfSqFt === null && (
                      <div className="mt-2 text-14 text-amber-700">
                        Low confidence — satellite imagery appears to predate
                        construction, so this lot-based estimate is unverified.
                        Confirm sq ft before pricing.
                      </div>
                    )}
                  {needsTurfConfirmation && (
                    <div className="mt-3 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs text-14 text-alert-fg">
                      AI turf is over 20,000 sf. Confirm treatable lawn area
                      before generating lawn pricing.
                    </div>
                  )}
                  {!needsTurfConfirmation && showTurfReview && (
                    <div className="mt-3 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs text-14 text-zinc-900">
                      Review turf estimate: {turfReviewReasons.join(", ")}.
                    </div>
                  )}
                  {confirmedTurfSqFt !== null && confirmedTurfSqFt > 20000 && (
                    <div className="mt-3 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs text-14 text-zinc-900">
                      Confirmed turf is over 20,000 sf and will be marked for
                      custom quote review.
                    </div>
                  )}
                </div>
              )}
              <CheckboxV2 k="svcPest" label="Pest Control" />
              {form.svcPest && commercialDetected && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200 text-14 text-zinc-600">
                  Commercial pest is auto-priced (estimated — confirmed on site). Residential pest pricing is suppressed.
                </div>
              )}
              {form.svcPest && !commercialDetected && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                    <FieldV2 label="Roach Activity">
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
                  {form.roachModifier && form.roachModifier !== "NONE" && (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-2">
                        <FieldV2 label="One-Time Fee Override ($)">
                          <InputV2
                            k="roachFeeOverride"
                            type="number"
                            placeholder="Engine price"
                          />
                        </FieldV2>
                      </div>
                      <RoachOverrideAppliedNote
                        estimate={estimate}
                        variant="recurring"
                      />
                    </>
                  )}
                  <div className="text-14 text-ink-secondary mt-2">
                    Adds a one-time Cockroach Treatment line to recurring pest. This is not a recurring per-visit multiplier.
                    {form.roachModifier && form.roachModifier !== "NONE"
                      ? " Leave the override blank to use the engine's footprint-bracket price."
                      : ""}
                  </div>
                </div>
              )}
              <CheckboxV2 k="svcTs" label="Tree & Shrub" />{" "}
              <CheckboxV2 k="svcInjection" label="Palm Injection Service" />{" "}
              {form.svcInjection && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                    <div className="px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs text-14 text-alert-fg">
                      {palmMeasurementWarning}
                    </div>
                  )}
                </div>
              )}
              <CheckboxV2 k="svcMosquito" label="Mosquito Control" />
              {(form.svcMosquito || form.svcOnetimeMosquito) && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="text-14 font-medium text-zinc-900 mb-2">
                    Mosquito estimate
                  </div>{" "}
                  <div
                    className={`grid ${form.svcMosquito ? "grid-cols-1 sm:grid-cols-3" : "grid-cols-1 sm:grid-cols-2"} gap-3`}
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
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3 text-14 text-ink-secondary">
                      {" "}
                      <div className="bg-white border-hairline border-zinc-200 rounded-xs p-3">
                        {" "}
                        <div className="text-14 font-medium text-zinc-900 mb-1">
                          Seasonal Program
                        </div>
                        9 applications during mosquito season, roughly every 21
                        days while pressure is active.
                      </div>{" "}
                      <div className="bg-white border-hairline border-zinc-200 rounded-xs p-3">
                        {" "}
                        <div className="text-14 font-medium text-zinc-900 mb-1">
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
                        <div className="text-14 font-medium text-zinc-900">
                          Mosquito Protocol
                        </div>{" "}
                        <Badge variant="neutral" className="text-14">
                          Estimate reference
                        </Badge>{" "}
                      </div>{" "}
                      <div className="grid gap-2">
                        {MOSQUITO_PROTOCOL_STEPS.map((step, index) => (
                          <div
                            key={step}
                            className="flex gap-2 text-14 leading-snug text-ink-secondary"
                          >
                            {" "}
                            <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-zinc-300 text-14 font-medium text-zinc-700">
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
                      <div className="text-14 font-medium text-zinc-900 mb-2">
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
                              <div className="text-14 font-medium text-zinc-900">
                                {recommendation.label}
                              </div>{" "}
                              <div className="text-14 text-ink-secondary leading-snug">
                                {recommendation.detail}
                              </div>{" "}
                            </div>{" "}
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="h-7 shrink-0 px-2 text-14"
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
              <CheckboxV2 k="svcRodentBait" label="Rodent Bait Station" />
              {livePreview.recurringCount > 0 && (
                <div className="mt-3 mb-1.5 px-3 py-2 rounded-xs bg-zinc-50 border-hairline border-zinc-300 text-14 text-zinc-900">
                  {livePreview.recurringCount} service
                  {livePreview.recurringCount > 1 ? "s" : ""} selected →{" "}
                  <strong>{livePreview.tier.name}</strong>
                  {livePreview.tier.discount > 0
                    ? ` (${Math.round(livePreview.tier.discount * 100)}% bundle discount)`
                    : " (no bundle discount yet)"}
                </div>
              )}
              {livePreview.commercialManualQuoteCount > 0 && (
                <div className="mt-3 mb-1.5 px-3 py-2 rounded-xs bg-alert-bg border-hairline border-alert-fg text-14 text-alert-fg">
                  {livePreview.commercialManualQuoteCount} commercial selection
                  {livePreview.commercialManualQuoteCount > 1 ? "s" : ""} (mosquito / termite) set to manual quote.
                </div>
              )}
              <SubGroupLabel>One-Time Services</SubGroupLabel>{" "}
              <SubGroupLabel className="mt-3">Lawn</SubGroupLabel>{" "}
              <CheckboxV2 k="svcOnetimeLawn" label="One-Time Lawn Care Service" />
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
              <CheckboxV2 k="svcPlugging" label="Lawn Plugging Service" />
              {form.svcPlugging && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <CheckboxV2 k="svcTopdress" label="Lawn Top Dressing Service" />{" "}
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
                  <div className="mt-1 text-14 text-zinc-500">
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
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                    <div className="mt-2 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs text-14 text-zinc-900">
                      Base price does not include bagging or debris hauling.
                    </div>
                  )}
                  {(form.dethatchingCleanupLevel === "moderate" || form.dethatchingCleanupLevel === "heavy" || form.dethatchingDebrisRemovalIncluded) && (
                    <div className="mt-2 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs text-14 text-zinc-900">
                      Cleanup/debris removal included.
                    </div>
                  )}
                  {isDethatchingStAugustine && (
                    <div className="mt-3 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs text-14 text-alert-fg">
                      Manager approval required. Dethatching St. Augustine / Floratam can damage stolons.
                    </div>
                  )}
                  {isDethatchingStAugustine && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mt-3">
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
              <CheckboxV2 k="svcWdo" label="WDO Inspection Service" />{" "}
              <CheckboxV2 k="svcTrenching" label="Termite Trenching Service" />{" "}
              <CheckboxV2 k="svcBoracare" label="Bora-Care Wood Treatment Service" />
              <CheckboxV2 k="svcPreslab" label="Slab Pre-Treat Termite Service" />
              {hasAnyTermiteSelection && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="text-14 font-medium text-zinc-900 mb-2">
                    Termite Measurements
                  </div>
                  <div className="text-14 text-ink-secondary mb-3">
                    Manual/admin-entered values override property lookup.
                  </div>
                  {termiteMeasurementWarnings.length > 0 && (
                    <div className="mb-3 px-3 py-2 bg-alert-bg border-hairline border-alert-fg rounded-xs text-14 text-alert-fg">
                      {termiteMeasurementWarnings.join(" ")}
                    </div>
                  )}
                  {form.svcTermiteBait && (
                    <>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                        {/* System + Monitoring selects removed (owner
                            2026-07-28): the menu is Trelona-only at its
                            label 15-ft spacing, and the station check is
                            bracket-priced by station count — no tiers.
                            Advance stays priceable in the engine for
                            replaying old estimates; the form always sends
                            trelona/basic for new quotes. */}
                        {/* Residential bond rider (owner 2026-07-20): fixed
                            quarterly warranty rate per term, priced by the
                            engine — labels stay term-only so a DB rate change
                            never strands a stale price here. Commercial keeps
                            the manual-quote scope split below. */}
                        {!isCommercialEstimateInput(form) && (
                          <FieldV2 label="Bond (warranty)">
                            <SelectV2
                              k="termiteBondTerm"
                              options={[
                                { value: "none", label: "No bond" },
                                { value: "1yr", label: "1-Year term" },
                                { value: "5yr", label: "5-Year term" },
                                { value: "10yr", label: "10-Year term" },
                              ]}
                            />
                          </FieldV2>
                        )}
                        {/* Station ownership (owner 2026-07-26): rental drops
                            the one-time install and recovers it as a per-
                            application uplift on the quarterly check. Amount
                            comes from the engine (pricing_config.termite_rental),
                            so no rate is spelled out here. Residential only —
                            commercial routes hardware through the manual-quote
                            scope split below. */}
                        {!isCommercialEstimateInput(form) && termiteRentalAvailable && (
                          <FieldV2 label="Stations">
                            <SelectV2
                              k="termiteOwnership"
                              options={[
                                { value: "own", label: "Purchased" },
                                { value: "rent", label: "Rented" },
                              ]}
                            />
                          </FieldV2>
                        )}
                      </div>
                      {/* Scope-split is commercial-only — the residential termite
                          pricer ignores termiteScope, so hide it there to avoid a
                          "Bond — manual quote" label that still auto-prices. */}
                      {isCommercialEstimateInput(form) && (
                        <FieldV2 label="Scope (liability)">
                          <SelectV2
                            k="termiteScope"
                            options={[
                              { value: "inspection_only", label: "Inspection only" },
                              { value: "monitoring_only", label: "Monitoring only" },
                              { value: "bait_monitoring_no_warranty", label: "Bait monitoring (no warranty)" },
                              { value: "bond_manual", label: "Bond — manual quote" },
                              { value: "warranty_manual", label: "Warranty — manual quote" },
                              { value: "initial_install_manual", label: "Initial install — manual quote" },
                            ]}
                          />
                        </FieldV2>
                      )}
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
                              { value: "high", label: "High/problem-soil rate (+12%)" },
                            ]}
                          />
                        </FieldV2>
                        <FieldV2 label="Trench Depth">
                          <SelectV2
                            k="trenchingDepthFt"
                            options={[
                              { value: "0.5", label: "0.5 ft / 6 in (standard)" },
                              { value: "1", label: "1.0 ft / 12 in (+15%)" },
                              { value: "1.5", label: "1.5 ft / 18 in (+30%)" },
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
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                      <div className="text-14 text-zinc-600 leading-snug mb-1">
                        {(TRENCHING_PRODUCT_META[form.trenchingProductKey] || TRENCHING_PRODUCT_META.taurus_sc).warning}
                        {form.trenchingApplicationRate === "high" ? " High rate requires label confirmation." : ""}
                      </div>
                      <div className="text-14 text-zinc-500 leading-snug">
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
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                      <div className="text-14 text-zinc-600 leading-snug mb-1">
                        Certificate of Compliance required. {(PRE_SLAB_PRODUCT_META[form.preslabProductKey] || PRE_SLAB_PRODUCT_META.termidor_sc).warning}
                      </div>
                      <div className="text-14 text-zinc-500 leading-snug">
                        Admin config: {(PRE_SLAB_PRODUCT_META[form.preslabProductKey] || PRE_SLAB_PRODUCT_META.termidor_sc).config}
                      </div>
                    </>
                  )}
                </div>
              )}
              <CheckboxV2 k="svcFoam" label="Termite Foam Service" />
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
              <CheckboxV2 k="svcFoamRecurring" label="Recurring Termite Foam Service" />
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
                  <div className="text-14 text-zinc-500 leading-snug mt-2">
                    Per-visit rate is discounted off the one-time price by cadence. Standalone — does not count toward WaveGuard tier.
                  </div>
                </div>
              )}
              <SubGroupLabel className="mt-3">Pest</SubGroupLabel>{" "}
              <CheckboxV2 k="svcOnetimePest" label="One-Time Pest Control Service" />{" "}
              <CheckboxV2 k="svcOnetimeMosquito" label="One-Time Mosquito Control Service" />{" "}
              <CheckboxV2 k="svcFlea" label="Flea Control Service" />{" "}
              {form.svcFlea && (
                <div className="ml-7 mb-3 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="mb-3">
                    <div className="text-14 font-medium text-ink-secondary uppercase tracking-label mb-2">
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
                              "h-8 px-2.5 rounded-sm border-hairline text-14 font-medium u-focus-ring",
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
                  <label className="flex items-start gap-2.5 mb-3 cursor-pointer text-14 text-zinc-900 select-none">
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
                  <div className="mb-3 text-14 text-ink-secondary leading-snug">
                    Exterior treatment focuses on likely flea zones such as shaded pet areas, fence lines, under decks, foundation edges, and landscape beds.
                  </div>
                  {form.svcFleaExterior && (
                    <>
                      <div className="flex items-center justify-between gap-3 mb-2">
                        <div>
                          <div className="text-14 font-medium text-zinc-900">
                            Treatable Lawn Area
                          </div>
                          <div className="mt-0.5 text-14 text-ink-secondary leading-snug">
                            Price exterior flea treatment based on treatable turf and yard area, not the full property lot.
                          </div>
                        </div>
                        <Badge variant="neutral" className="text-14 u-nums">
                          Max {fleaExteriorMaxSqFt.toLocaleString()} sf
                        </Badge>
                      </div>
                      <div className="mb-3">
                        <div className="text-14 font-medium text-ink-secondary uppercase tracking-label mb-2">
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
                                  "h-8 px-2.5 rounded-sm border-hairline text-14 font-medium u-focus-ring",
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
                        className="mt-1 grid gap-1 text-14 text-ink-secondary"
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
                      <div className="mt-2 text-14 text-zinc-900 u-nums">
                        Using {fleaExteriorSourceLabel(fleaExteriorAreaSource)}:{" "}
                        {formatSqFt(fleaExteriorAreaSqFt)}
                      </div>
                      <div className="mt-3 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs">
                        <div className="text-14 font-medium text-ink-secondary uppercase tracking-label mb-1">
                          Exterior flea add-on
                        </div>
                        {fleaExteriorPreview.priceable ? (
                          <div className="text-14 text-zinc-900 u-nums">
                            ${fleaExteriorPreview.initial} initial + ${fleaExteriorPreview.followUp} follow-up = ${fleaExteriorPreview.total} total
                          </div>
                        ) : fleaExteriorPreview.configUnavailable ? (
                          <div className="text-14 text-zinc-900">
                            Exterior flea pricing config is unavailable.
                          </div>
                        ) : fleaExteriorPreview.customQuote ? (
                          <div className="text-14 text-zinc-900">
                            {(fleaExteriorPreview.maxSqFt || fleaExteriorMaxSqFt).toLocaleString()}+ sf. Custom quote required.
                          </div>
                        ) : (
                          <div className="text-14 text-zinc-900">
                            Pricing needs a confirmed treatable lawn area.
                          </div>
                        )}
                      </div>
                      {fleaExteriorWarning && (
                        <div className="mt-3 px-3 py-2 bg-white border-hairline border-zinc-300 rounded-xs text-14 text-zinc-900">
                          {fleaExteriorWarning}
                        </div>
                      )}
                      <div className="mt-3">
                        <div className="text-14 font-medium text-ink-secondary uppercase tracking-label mb-2">
                          Exterior treatment zones
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          {FLEA_EXTERIOR_ZONES.map((zone) => (
                            <label
                              key={zone.value}
                              className="flex items-center gap-2 text-14 text-zinc-900 cursor-pointer select-none"
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
              <CheckboxV2 k="svcRoach" label="Cockroach Treatment Service" />
              {form.svcRoach && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="text-14 font-medium text-zinc-900 mb-2">
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
                    <div className="text-14 text-ink-secondary mt-2">
                      German Roach Cleanout is a separate specialty program, not the German version of native cockroach treatment.
                    </div>
                  )}
                  {form.roachType === "REGULAR" &&
                    (form.svcPest && form.roachModifier === "REGULAR" ? (
                      // Duplicate state: the engine skips this standalone line
                      // (recurring pest already auto-fires the same knockdown),
                      // so an override typed here would price nothing. Point at
                      // the field that does apply instead of showing an inert
                      // input (codex P2 r2 #3223).
                      <div className="text-14 text-ink-secondary mt-2">
                        Covered by the recurring pest roach knockdown — this
                        standalone line is skipped. Use the One-Time Fee
                        Override under Pest Control's Roach Activity instead.
                      </div>
                    ) : (
                      <>
                        <FieldV2 label="Fee Override ($)" className="mb-0 mt-2">
                          <InputV2
                            k="standaloneRoachFeeOverride"
                            type="number"
                            placeholder="Engine price"
                          />
                        </FieldV2>
                        <div className="text-14 text-ink-secondary mt-2">
                          Leave blank to use the engine's footprint-bracket
                          price.
                        </div>
                        <RoachOverrideAppliedNote
                          estimate={estimate}
                          variant="standalone"
                        />
                      </>
                    ))}
                </div>
              )}
              <CheckboxV2 k="svcWasp" label="Bee / Wasp Nest Removal Service" />
              {form.svcWasp && <div className="ml-7 mb-4 grid grid-cols-1 sm:grid-cols-2 gap-x-3">
                <FieldV2 label="Species"><SelectV2 k="stingSpecies" options={[
                  { value: "PAPER_WASP", label: "Paper wasps" }, { value: "YJ_AERIAL", label: "Yellow jackets — aerial" },
                  { value: "YJ_GROUND", label: "Yellow jackets — ground" }, { value: "MUD_DAUBER", label: "Mud daubers" },
                  { value: "HONEYBEE_NEW", label: "Honeybees — new colony" }, { value: "HONEYBEE_EST", label: "Honeybees — established" },
                  { value: "CARPENTER", label: "Carpenter bees" }, { value: "BALDFACED", label: "Baldfaced hornets" },
                  { value: "AFRICANIZED", label: "Africanized bees" },
                ]} /></FieldV2>
                <FieldV2 label="Scope tier"><SelectV2 k="stingTier" options={[1, 2, 3, 4].map((tier) => ({ value: String(tier), label: `Tier ${tier}` }))} /></FieldV2>
                <FieldV2 label="Nest removal"><SelectV2 k="stingRemoval" options={[
                  { value: "NONE", label: "No removal" }, { value: "SMALL", label: "Small nest" },
                  { value: "LARGE", label: "Large comb" }, { value: "HONEYCOMB", label: "Honeycomb extraction" },
                  { value: "RELOCATE", label: "Live bee relocation" },
                ]} /></FieldV2>
                <FieldV2 label="Aggressiveness"><SelectV2 k="stingAggressive" options={[
                  { value: "NO", label: "None" }, { value: "MILD", label: "Mild" }, { value: "HIGH", label: "High" }, { value: "EXTREME", label: "Extreme" },
                ]} /></FieldV2>
                <FieldV2 label="Access height"><SelectV2 k="stingHeight" options={[
                  { value: "GROUND", label: "Ground" }, { value: "MID", label: "Mid-level" }, { value: "HIGH", label: "High" },
                ]} /></FieldV2>
                <FieldV2 label="Confined space"><SelectV2 k="stingConfined" options={[
                  { value: "NO", label: "No" }, { value: "YES", label: "Yes" },
                ]} /></FieldV2>
              </div>}
              <CheckboxV2 k="svcBedbug" label="Bed Bug Treatment Service" />
              {form.svcBedbug && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <CheckboxV2 k="svcRodentTrap" label="Rodent Trapping Service" />{" "}
              {form.svcRodentTrap && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="text-14 text-zinc-600 mb-3">
                    Standard plan — $350 flat, unlimited callbacks/checks for the active trapping job.
                  </div>
                  <CheckboxV2 k="rodentTrappingEmergency" label="Emergency surcharge" />
                </div>
              )}
              <CheckboxV2 k="svcTrapOnlyRetainer" label="Customer declined exclusion / trap-only monitoring" />
              {form.svcTrapOnlyRetainer && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
                  <div className="text-14 text-zinc-600 mt-2">
                    Trap-only monitoring is not a rodent guarantee because exclusion was declined.
                  </div>
                </div>
              )}
              {/* Legacy Wire Mesh / Bird Box checkboxes removed — folded into Rodent Exclusion V2 above */}
              <CheckboxV2 k="svcRodentSanitation" label="Rodent Sanitation" />
              {form.svcRodentSanitation && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  {" "}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
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
              <CheckboxV2 k="svcExclusion" label="Rodent Exclusion Service" />
              {form.svcExclusion && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200 space-y-3">
                  <p className="text-14 tracking-label uppercase text-zinc-400 font-medium">Wire Mesh Points</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldV2 label="Standard — $75/pt">
                      <InputV2 k="exclStandardWireMesh" type="number" min="0" />
                    </FieldV2>
                    <FieldV2 label="Roof/High — $150/pt">
                      <InputV2 k="exclAdvancedWireMesh" type="number" min="0" />
                    </FieldV2>
                  </div>
                  <p className="text-14 tracking-label uppercase text-zinc-400 font-medium">Bird Boxes</p>
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
                  <p className="text-14 tracking-label uppercase text-zinc-400 font-medium">Linear Mesh (LF)</p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <FieldV2 label="Soft material — $14/LF">
                      <InputV2 k="exclMeshSoftLF" type="number" min="0" />
                    </FieldV2>
                    <FieldV2 label="Hard material — $22/LF">
                      <InputV2 k="exclMeshConcreteLF" type="number" min="0" />
                    </FieldV2>
                  </div>
                  <FieldV2 label="Waive Inspection ($75)?">
                    <SelectV2
                      k="exclWaive"
                      options={[
                        { value: "NO", label: "No — charge $75 (credits toward treatment)" },
                        { value: "YES", label: "Yes — booking work" },
                      ]}
                    />
                  </FieldV2>
                </div>
              )}
              <CheckboxV2 k="svcRodentGuarantee" label="Rodent Guarantee Service" />
              {form.svcRodentGuarantee && (
                <div className="ml-7 mb-2 p-3 bg-zinc-50 rounded-xs border-hairline border-zinc-200">
                  <p className="text-14 tracking-label uppercase text-zinc-400 font-medium mb-2">
                    Guarantee Eligibility — all four required
                  </p>
                  <CheckboxV2 k="rgTrappingCompleted" label="Trapping completed" />
                  <CheckboxV2 k="rgExclusionCompleted" label="Exclusion completed" />
                  <CheckboxV2 k="rgSanitationBaseline" label="Sanitation completed or photo baseline on file" />
                  <CheckboxV2 k="rgNoActivityAfterFinalCheck" label="No activity after final trap check" />
                  <div className="text-14 text-zinc-600 mt-2">
                    $199–$299/yr by property tier. 12-month re-entry warranty, renewable annually — free re-service during the term. All four boxes must be confirmed or the guarantee will not be added.
                  </div>
                </div>
              )}
            </section>
            <section id="estimate-pricing" className="estimate-workflow-section space-y-4" aria-label="Pricing and terms">
            <h2 className="text-20 font-semibold">Pricing & terms</h2>
            <label className="block text-14 font-medium">Customer-visible notes
              <textarea className={`${INPUT_CLS} h-24 mt-2 py-2`} value={form.notes || ""} onChange={(event) => set("notes", event.target.value)} />
            </label>
            <p className="text-14 text-zinc-600">These notes appear on the customer estimate. Keep internal instructions in the lead activity record.</p>
                <div className="mb-3 p-3 border-hairline border-zinc-300 rounded-xs bg-zinc-50">
                  {" "}
                  <div className="text-14 font-medium text-zinc-900 mb-2 uppercase tracking-label">
                    Customer options
                  </div>{" "}
                  <label className="flex items-start gap-2 cursor-pointer text-14 text-zinc-900 select-none mb-2">
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
                      <span className="block text-14 text-ink-secondary">
                        Customer sees a Recurring / One-time toggle for
                        pest-only recurring estimates. Mixed service bundles
                        should be sent without this option.
                      </span>{" "}
                    </span>{" "}
                  </label>{" "}
                  <label className="flex items-start gap-2 cursor-pointer text-14 text-zinc-900 select-none">
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
                      <span className="block text-14 text-ink-secondary">
                        Skip onboarding / payment up front — create an invoice
                        due immediately when the customer accepts.
                      </span>{" "}
                    </span>{" "}
                  </label>{" "}
                </div>{" "}
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
                    <div className="text-14 text-ink-secondary -mt-1 mb-3">
                      {d.description}
                    </div>
                  ) : null;
                })()}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
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
                      placeholder="Required for custom discounts"
                    />{" "}
                  </FieldV2>{" "}
                </div>{" "}
              </div>{" "}
              <div className="text-14 text-ink-tertiary mt-2">
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
                        className="flex items-center justify-between gap-3 rounded-xs border-hairline border-zinc-300 bg-white px-3 py-2 text-14 text-zinc-900"
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
            </section>
            <section id="estimate-review" className="estimate-workflow-section space-y-4" aria-label="Review and send">
            <h2 className="text-20 font-semibold">Review & send</h2>
            {saveError && <p role="alert" className="text-14 text-alert-fg">{saveError}</p>}
            {/* Action buttons */}
            <div
              className={cn(
                "grid gap-3",
                estimate
                  ? editMode
                    ? "grid-cols-2 sm:grid-cols-4"
                    : "grid-cols-3"
                  : "grid-cols-2",
              )}
            >
              {" "}
              <Button
                onClick={() => doGenerate()}
                disabled={generateBusy}
                variant="primary"
                size="md"
                className={cn("h-12", estimate ? "text-14" : "text-14")}
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
                  className="h-12 text-14"
                  disabled={generateBusy || saving}
                  onClick={() => doSave()}
                  title="Update the existing estimate — the customer's link shows the new quote without a resend"
                >
                  {saving ? "Saving…" : editMode?.status === "sent" || editMode?.status === "viewed" ? "Save changes" : "Save draft"}
                </Button>
              )}
              {estimate && (
                <Button
                  variant="secondary"
                  size="md"
                  className="h-12 text-14 gap-2"
                  disabled={generateBusy || saving || !savedId}
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
                className={cn("h-12", estimate ? "text-14" : "text-14")}
                disabled={generateBusy || !savedId}
                onClick={reviewAndSend}
              >
                Review and send
              </Button>{" "}
            </div>

            {savedId && (
              <div className="text-14 text-ink-secondary">
                {["sent", "viewed"].includes(editMode?.status)
                  ? "Changes saved to the existing customer link. Resend to notify them."
                  : "Draft saved. It has not been sent."}
              </div>
            )}
            {(savedId || editMode?.id) && (
              <Button
                variant="secondary"
                size="md"
                className="mt-2"
                onClick={() => addAnotherProperty()}
              >
                Add another property for this customer
              </Button>
            )}

            {savedId && <Button variant="ghost" onClick={nextEstimate}>Next estimate (keep services)</Button>}
            {memberLinkageWarning && (
              <div className="text-14 text-ink bg-zinc-50 border-hairline border-zinc-300 rounded-sm p-3 mt-2">
                <span className="font-medium">Member pricing not applied.</span>{" "}
                {memberLinkageWarning.message}
              </div>
            )}
            {priceRecomputeNotice && (
              <div className="text-14 text-ink-secondary bg-zinc-50 border-hairline border-zinc-200 rounded-sm p-3 mt-2">
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
            </section>
          </div>
          {/* Saved/working price summary and optional internal diagnostics. */}
          <aside className="min-w-0 lg:sticky lg:top-6 self-start">
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
                  <div className="text-left px-4 py-3 bg-zinc-50 rounded-sm border-hairline border-zinc-200 mt-3 text-14 text-ink-secondary leading-relaxed">
                    {" "}
                    <div className="text-14 font-medium text-zinc-900 uppercase tracking-label mb-1.5">
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
                  <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                    <h2 className="text-18 font-semibold">Pricing summary</h2>
                    <Button variant="secondary" onClick={previewCustomerEstimate} disabled={generateBusy || !savedId}>
                      <ExternalLink size={16} aria-hidden /> Preview saved estimate
                    </Button>
                  </div>
                  <p className="text-14 text-zinc-600 mb-4">{savedId ? "Saved pricing. Preview shows the customer document." : "Working pricing. Save this version before previewing or sending."}</p>
                  {presentQuoteRequired ? <p role="status" className="text-14 mb-4">This scope requires a quote review before a firm price can be sent.</p> : (
                    <dl className="grid grid-cols-2 gap-3 mb-4 text-14">
                      <div><dt className="text-zinc-600">Recurring monthly equivalent</dt><dd className="text-20 font-semibold">{fmt(E.recurring?.grandTotal || 0)}</dd></div>
                      <div><dt className="text-zinc-600">One-time and setup charges</dt><dd className="text-20 font-semibold">{fmt(E.oneTime?.total || 0)}</dd></div>
                    </dl>
                  )}
                  <p className="text-14 text-zinc-600 mb-4">Service cadence, per-application amounts and payment choices appear in the saved customer preview.</p>
                  <div>
                    <details className="border-hairline border-zinc-300 rounded-sm bg-white mb-2">
                      <summary className="cursor-pointer px-4 py-3 text-14 font-medium text-zinc-900 list-none border-b-hairline border-zinc-200">
                        Estimator engine details
                        <span className="block text-14 font-normal text-ink-secondary mt-1">
                          Property summary, pricing modifiers, production diagnostics, and raw program tiers.
                        </span>
                      </summary>
                      <div className="p-4">
                    {/* Summary Card */}
                    {(E.recurring.serviceCount > 0 ||
                      Number(E.recurring.monthlyTotal) > 0 ||
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
                          <div className="text-14 text-ink-secondary mt-1">
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
                                <div className="text-14 text-ink-secondary uppercase tracking-label">
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
                              <div className="text-14 text-ink-secondary uppercase tracking-label">
                                Year 1 Total
                              </div>{" "}
                            </div>
                            {E.recurring.savings > 0 && (
                              <div className="text-center">
                                {" "}
                                <div className="text-18 font-medium text-zinc-900 u-nums">
                                  -{fmt(E.recurring.savings)}
                                </div>{" "}
                                <div className="text-14 text-ink-secondary uppercase tracking-label">
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
                              <div className="bg-zinc-50 border-hairline border-zinc-300 rounded-sm px-4 py-3 mb-5 text-14 text-ink-secondary">
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
                          <div className="bg-alert-bg border-hairline border-alert-fg rounded-sm px-4 py-3 mb-5 text-14 text-alert-fg">
                            {" "}
                            <strong>Field Verify:</strong>{" "}
                            {E.fieldVerify
                              .map((f) =>
                                humanizeQuoteReason(
                                  typeof f === "string"
                                    ? f
                                    : f.field || f.name || JSON.stringify(f),
                                ),
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
                      <div className="text-14 text-ink-secondary leading-relaxed">
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
                          : ""}
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
                              <span className="text-14 text-ink-tertiary flex-shrink-0 w-3 text-center">
                                {m.type === "up"
                                  ? "▲"
                                  : m.type === "down"
                                    ? "▼"
                                    : "·"}
                              </span>{" "}
                              <span className="text-14 text-ink-secondary flex-1">
                                {m.label}
                              </span>{" "}
                              <span className="text-14 font-medium text-zinc-900 u-nums">
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
                              {R.lawnMeta?.turfConfidence &&
                                R.lawnMeta.turfConfidence !== "HIGH" && (
                                  <Tag>
                                    {R.lawnMeta.turfConfidence === "LOW"
                                      ? "Low-confidence turf"
                                      : "Estimated turf"}
                                  </Tag>
                                )}
                              {R.lawnMeta?.turfConfidence === "LOW" && (
                                <FieldVerifyTag>FIELD VERIFY</FieldVerifyTag>
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
                              <div className="text-14 text-ink-secondary mt-1">
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
                              <div className="text-14 text-ink-secondary">
                                Footprint sqft or perimeter LF is required before pricing termite bait.
                              </div>
                            ) : (
                              <>
                                <TierGridV2>
                                  {" "}
                                  {/* Trelona-only menu + station-count
                                      bracket pricing (owner 2026-07-28) —
                                      the retired flat Basic/Premier figures
                                      must never render beside a bracketed
                                      quote total. Renders whichever system
                                      the result actually priced: new quotes
                                      are Trelona, but a replayed pre-change
                                      Advance draft still shows ITS row
                                      (server adapter exposes monMonthly;
                                      bmo is the legacy fallback name). */}
                                  {(() => {
                                    const tmSys =
                                      R.tmBait.selectedSystem === "advance"
                                        ? "advance"
                                        : "trelona";
                                    const tmInstallPrice =
                                      tmSys === "advance"
                                        ? R.tmBait.ai
                                        : R.tmBait.ti;
                                    const tmMon =
                                      R.tmBait.monMonthly ?? R.tmBait.bmo;
                                    return tmInstallPrice != null ? (
                                      <TierRowV2
                                        name={
                                          tmSys === "advance"
                                            ? "Advance (legacy)"
                                            : "Trelona"
                                        }
                                        detail={`${fmtInt(tmInstallPrice)} install | ${R.tmBait.sta} stations | $${tmMon}/mo station check`}
                                        price={`$${Math.round((tmMon ?? 0) * 3)}/app`}
                                        recommended
                                      />
                                    ) : null;
                                  })()}{" "}
                                </TierGridV2>{" "}
                                <div className="text-14 text-ink-secondary mt-1">
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
                                name={R.rodBait ? "Quarterly" : "Monthly"}
                                detail={R.rodBait
                                  ? `Up to ${R.rodBait.stations} stations`
                                  : `${R.rodBaitSize} property`}
                                price={R.rodBait
                                  ? `$${R.rodBait.perVisit}/application`
                                  : `$${R.rodBaitMo}/mo`}
                                recommended
                              />{" "}
                            </TierGridV2>{" "}
                            <div className="text-14 text-ink-secondary mt-1">
                              {rodentBaitPolicyNote(E)}
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
                                <div className="text-14 text-ink-secondary italic mt-1">
                                  Best scheduled before rainy season (Apr-May)
                                </div>{" "}
                                {item.warningText && (
                                  <div className="text-14 text-ink-secondary mt-1">
                                    {item.warningText}
                                  </div>
                                )}
                                {item.allocatedChemicalCost !== undefined && (
                                  <div className="text-14 text-ink-secondary mt-1">
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
                                <div className="text-14 text-ink-secondary italic mt-1">
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
                                  <div className="text-14 text-ink-secondary mt-1">
                                    {item.warrantyStatus || "No extended warranty selected"}
                                  </div>
                                )}
                                {!item.warrAdd && String(item.warrantyTier || "").toUpperCase() === "NONE" && (
                                  <div className="text-14 text-ink-secondary mt-1">
                                    No warranty selected
                                  </div>
                                )}
                                {item.warningText && (
                                  <div className="text-14 text-ink-secondary mt-1">
                                    {item.warningText}
                                  </div>
                                )}
                                <div className="text-14 text-ink-secondary mt-1">
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
                                <div className="text-14 text-ink-secondary mt-1">
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
                                  <div className="text-14 text-ink-secondary mt-1">
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
                              {item.service === "pest_initial_roach" &&
                                item.priceOverridden && (
                                  <div className="text-14 text-ink-secondary mt-1">
                                    Fee manually overridden — engine bracket
                                    price is {fmtInt(item.bracketPrice)}.
                                  </div>
                                )}
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
                              <div className="text-14 font-medium text-ink-secondary uppercase tracking-label mb-1">
                                {s.name}
                              </div>{" "}
                              <div className="text-18 font-medium text-zinc-900 u-nums">
                                {s.quoteRequired ? "Quote Required" : s.onProg ? "$0 — Included" : fmtInt(s.price)}
                              </div>{" "}
                              {serviceDetailText(s) && (
                                <div className="text-14 text-ink-secondary mt-1">
                                  {serviceDetailText(s)}
                                </div>
                              )}{" "}
                            </div>
                          ))}
                        </div>{" "}
                      </>
                    )}
                    {(() => {
                      // Report-only low-margin signals (owner ruling
                      // 2026-07-17: margins are surfaced, never enforced) —
                      // rendered alongside the engine's pricing metadata so
                      // the owner sees "this looks low" before sending.
                      const marginNotes = collectMarginReviewNotes(E);
                      const pm = E.pricingMetadata || {};
                      const hasNotes =
                        pm.skippedServices?.length > 0 ||
                        pm.warnings?.length > 0 ||
                        pm.manualReviewReasons?.length > 0 ||
                        marginNotes.length > 0;
                      if (!hasNotes) return null;
                      return (
                        <div className="mb-6 p-3 bg-zinc-50 border-hairline border-zinc-300 rounded-sm text-14 text-zinc-900">
                          <div className="font-medium mb-1">Pricing Review Notes</div>
                          {(pm.skippedServices || []).map((item, i) => (
                            <div key={`skip-${i}`} className="text-ink-secondary">
                              {item.skippedReason === "recurring_pest_initial_roach_already_covers_regular_roach"
                                ? "Skipped standalone native cockroach charge because recurring pest already includes the Cockroach Treatment."
                                : item.skippedReason}
                            </div>
                          ))}
                          {(pm.warnings || []).map((warning, i) => (
                            <div key={`warning-${i}`} className="text-ink-secondary">
                              {warning}
                            </div>
                          ))}
                          {(pm.manualReviewReasons || []).map((reason, i) => (
                            <div key={`manual-review-${i}`} className="text-ink-secondary">
                              {humanizeQuoteReason(reason)}
                            </div>
                          ))}
                          {marginNotes.map((note, i) => (
                            <div key={`margin-${i}`} className="text-zinc-900 font-medium">
                              {note}
                            </div>
                          ))}
                        </div>
                      );
                    })()}

                    {/* Bundle + Totals */}
                    {(E.recurring.serviceCount > 0 ||
                      Number(E.recurring.monthlyTotal) > 0 ||
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
                            <div className="text-14 text-ink-secondary mt-0.5">
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
                            <div className="grid grid-cols-[1fr_auto] gap-y-1 gap-x-4 text-14 mt-3 p-3 bg-white rounded-xs border-hairline border-zinc-200">
                              {E.recurring.services.map((s, i) => (
                                <React.Fragment key={i}>
                                  {" "}
                                  <div className="text-ink-secondary">
                                    {" "}
                                    <div>{s.displayName || s.name}</div>
                                    {s.detail && (
                                      <div className="text-14 text-ink-tertiary leading-snug mt-0.5">
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
                          {/* Legacy scalar-only results only — a 2026-08-29+
                              rodent_bait services row is already inside the
                              recurring totals (codex #3591 r7). */}
                          {E.recurring.rodentBaitMo > 0
                            && !(E.recurring.services || []).some((s) => (s.service || '') === 'rodent_bait') && (
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
                                  className="flex justify-between items-start gap-3 py-0.5 pl-4 text-14 text-ink-secondary"
                                >
                                  {" "}
                                  <span>
                                    {" "}
                                    <span>
                                      {item.name}
                                      {item.waivedWithPrepay ? (
                                        <span className="text-14 text-ink-tertiary ml-1">
                                          waived with annual prepay
                                        </span>
                                      ) : (
                                        ""
                                      )}
                                    </span>
                                    {item.detail && (
                                      <span className="block text-14 text-ink-tertiary leading-snug mt-0.5">
                                        {item.detail}
                                      </span>
                                    )}
                                  </span>{" "}
                                  <span className="text-14 u-nums">
                                    {fmtInt(item.price)}
                                  </span>{" "}
                                </div>
                              ))}
                              {E.oneTime.specItems.map((s, i) => (
                                <div
                                  key={`sp-${i}`}
                                  className="flex justify-between items-start gap-3 py-0.5 pl-4 text-14 text-ink-secondary"
                                >
                                  {" "}
                                  <span>
                                    {s.name}
                                    {serviceDetailText(s) && (
                                      <span className="block text-14 text-ink-tertiary leading-snug mt-0.5">
                                        {serviceDetailText(s)}
                                      </span>
                                    )}
                                  </span>{" "}
                                  <span className="text-14 u-nums">
                                    {s.quoteRequired ? "Quote Required" : fmtInt(s.price)}
                                  </span>{" "}
                                </div>
                              ))}
                              {E.manualDiscount &&
                                E.manualDiscount.oneTimeAmount > 0 && (
                                  <div className="flex justify-between items-start gap-3 py-0.5 pl-4 text-14 text-ink-secondary">
                                    {" "}
                                    <span>
                                      {E.manualDiscount.label ||
                                        (E.manualDiscount.type === "PERCENT"
                                          ? `Discount (${E.manualDiscount.value}%)`
                                          : `Discount`)}{" "}
                                      <span className="text-14 text-ink-tertiary">
                                        (one-time)
                                      </span>
                                    </span>{" "}
                                    <span className="text-14 u-nums">
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
          </aside>{" "}
        </div>{" "}
      </div>{" "}
    </FormCtx.Provider>
  );
}
