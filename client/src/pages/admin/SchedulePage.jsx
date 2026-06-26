// client/src/pages/admin/SchedulePage.jsx
//
// Shared-utility module for the V2 dispatch surface. The V1 page
// component was retired in the dispatch V1→V2 migration; this file is
// retained only for the inline modal/panel components consumed by
// DispatchPageV2 + ProtocolReferenceTabV2:
//   - CompletionPanel       — mark service complete + record products /
//                             observations / labor minutes
//   - RescheduleModal       — move an appointment to a new slot
//   - EditServiceModal      — edit notes / billable items / tech
//                             assignment / status
//   - ProtocolPanel         — surface the appropriate service protocol
//                             (lawn / pest / tree-shrub / mosquito) for
//                             the tech on-site
//   - MONTH_NAMES, PRODUCT_DESCRIPTIONS, TRACK_SAFETY_RULES,
//     stripLegacyBoilerplate (consumed by ProtocolReferenceTabV2)
//
// Endpoints these helpers are wired against:
//   GET   /admin/schedule/services?date=…
//   PATCH /admin/services/:id
//   POST  /admin/services/:id/complete
//   POST  /admin/services/:id/reschedule
//   GET   /admin/techs/availability
//
// Audit focus:
// - The four exported sub-components are state-heavy — confirm they
//   don't carry hidden assumptions about a V1 page parent's state
//   shape that break under V2's parent.
// - CompletionPanel's products + observations submit creates the
//   service_record + invoice line items — verify it's idempotent
//   (operator double-clicks "Complete" should not double-bill).
// - RescheduleModal's slot-conflict handling — what happens if the
//   chosen slot is taken between modal open and submit?
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";

import { addETDays, etDateString } from "../../lib/timezone";
import { useFeatureFlagReady } from "../../hooks/useFeatureFlag";
import AnnualPrepayLauncher from "../../components/schedule/AnnualPrepayLauncher";
import useSpeechDictation from "../../hooks/useSpeechDictation";
import ProjectFindingFieldInput from "../../components/tech/ProjectFindingFieldInput";
import EstimateProvenanceCard from "../../components/schedule/EstimateProvenanceCard";
import TreeShrubCloseoutSummary from "../../components/tech/TreeShrubCloseoutSummary";

const API_BASE = import.meta.env.VITE_API_URL || "/api";

const D = {
  bg: "#F1F5F9",
  card: "#FFFFFF",
  border: "#E2E8F0",
  input: "#FFFFFF",
  teal: "#0A7EC2",
  green: "#16A34A",
  amber: "#F0A500",
  red: "#C0392B",
  blue: "#0A7EC2",
  purple: "#7C3AED",
  gray: "#64748B",
  text: "#334155",
  muted: "#64748B",
  white: "#FFFFFF",
  heading: "#0F172A",
  inputBorder: "#CBD5E1",
};

// Each action carries explicit scope + treatmentApplied so the re-entry
// advisory never has to regex the label. treatmentApplied:false = a
// non-chemical action (inspection/monitor/sweep) that must NOT fire the
// interior dry-time countdown. (Shown only for services without a protocol;
// pest services show protocol-derived actions that carry their own scope.)
const CHIP_ACTIONS = [
  { label: "Applied perimeter band", scope: "exterior", treatmentApplied: true },
  { label: "Applied non-repellent solutions (exterior)", scope: "exterior", treatmentApplied: true },
  { label: "Applied non-repellent solutions (interior)", scope: "interior", treatmentApplied: true },
  { label: "Applied repellent solutions (exterior)", scope: "exterior", treatmentApplied: true },
  { label: "Applied repellent solutions (interior)", scope: "interior", treatmentApplied: true },
  { label: "Applied interior treatment", scope: "interior", treatmentApplied: true },
  { label: "Interior — baseboards/kitchen/baths", scope: "interior", treatmentApplied: true },
  { label: "Cobweb sweep", scope: "exterior", treatmentApplied: false },
  { label: "Granular applied in beds", scope: "exterior", treatmentApplied: true },
  { label: "Spot-treated weeds", scope: "exterior", treatmentApplied: true },
  { label: "Checked bait stations", scope: "exterior", treatmentApplied: false },
  { label: "Barrier treatment", scope: "exterior", treatmentApplied: true },
  { label: "Larvicide applied", scope: "exterior", treatmentApplied: true },
  { label: "De-webbed eaves", scope: "exterior", treatmentApplied: false },
  { label: "Dusted wall voids", scope: "interior", treatmentApplied: true },
  { label: "Applied gel bait", scope: "interior", treatmentApplied: true },
  { label: "Crack and crevice treatment", scope: "interior", treatmentApplied: true },
  { label: "Flushed with aerosol", scope: "interior", treatmentApplied: true },
  { label: "Treated entry points (doors/windows/pipes)", scope: "exterior", treatmentApplied: true },
];
const CHIP_ACTION_BY_LABEL = Object.fromEntries(
  CHIP_ACTIONS.map((chip) => [chip.label, chip]),
);
// Completion-panel quick-entry chips are service-aware: pest-line services
// (pest control, mosquito, termite, rodent) get a pest-focused list, while
// plant-health services (lawn, tree/shrub) keep the original broad list that
// includes lawn/ornamental entries like irrigation, fungus, and weeds.
const CHIP_OBSERVATIONS_PEST = [
  "Pest activity noted",
  "Ant trails observed",
  "Roach activity (live/dead)",
  "Spider webs/egg sacs",
  "Wasp/bee nests found",
  "Rodent signs",
  "Entry points identified",
  "Moisture/conducive conditions",
  "Conducive vegetation against structure",
  "Standing water found",
  "Debris in gutters",
  "Property access issue",
  "Customer concern discussed",
];
const CHIP_OBSERVATIONS_HORTICULTURAL = [
  "Pest activity noted",
  "Standing water found",
  "Irrigation issue",
  "Rodent signs",
  "Lawn stress/dry patches",
  "Fungus visible",
  "Weeds spreading",
  "Property access issue",
  "Customer concern discussed",
  "Debris in gutters",
  "Ant trails observed",
  "Roach activity (live/dead)",
  "Spider webs/egg sacs",
  "Wasp/bee nests found",
  "Moisture/conducive conditions",
  "Entry points identified",
  "Conducive vegetation against structure",
];
const CHIP_RECOMMENDATIONS_PEST = [
  "Callback recommended",
  "Follow-up in 2 weeks",
  "Schedule interior next visit",
  "Bait station replacement",
  "Customer wants estimate",
];
const CHIP_RECOMMENDATIONS_HORTICULTURAL = [
  "Callback recommended",
  "Irrigation adjustment needed",
  "Follow-up in 2 weeks",
  "Schedule interior next visit",
  "Bait station replacement",
  "Customer wants estimate",
];
const VISIT_OUTCOME_OPTIONS = [
  { value: "completed", label: "Completed" },
  { value: "inspection_only", label: "Inspection only" },
  { value: "customer_declined", label: "Customer declined" },
  { value: "follow_up_needed", label: "Follow-up needed" },
  { value: "customer_concern", label: "Customer concern" },
  { value: "incomplete", label: "Incomplete" },
];
const OFFICE_APPROVAL_REASONS = [
  {
    value: "office_approved_blackout_exception",
    label: "Office approved exception",
  },
  {
    value: "soil_test_supported_phosphorus",
    label: "Soil test supports phosphorus",
  },
  {
    value: "non_fertilizer_application_only",
    label: "No N/P fertilizer applied",
  },
];
const N_LIMIT_APPROVAL_REASONS = [
  {
    value: "admin_approved_n_budget_exception",
    label: "Admin approved exception",
  },
  { value: "ledger_adjustment_pending", label: "Ledger adjustment pending" },
  {
    value: "site_specific_agronomic_need",
    label: "Site-specific agronomic need",
  },
];
const MANAGER_APPROVAL_REASONS = [
  {
    value: "manager_approved_protocol_exception",
    label: "Manager approved protocol exception",
  },
  {
    value: "field_conditions_documented",
    label: "Field conditions documented",
  },
  { value: "label_review_completed", label: "Label / rotation reviewed" },
];
const MANAGER_APPROVAL_CODES = new Set([
  "off_protocol_product",
  "high_rate_application",
  "fungicide_frac_rotation_approval",
  "repeat_moa_group",
  "repeat_frac_group",
  "repeat_irac_group",
  "repeat_hrac_group",
  "pgr_on_stressed_turf",
  "st_augustine_dethatching",
]);
function normalizeRateUnit(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  const aliases = {
    floz: "fl_oz",
    fl_oz: "fl_oz",
    fluid_ounce: "fl_oz",
    fluid_ounces: "fl_oz",
    lbs: "lb",
    pounds: "lb",
    ounces: "oz",
  };
  return aliases[normalized] || normalized;
}
function rateUnitsMatch(a, b) {
  const left = normalizeRateUnit(a);
  const right = normalizeRateUnit(b);
  return !!left && !!right && left === right;
}
const TANK_CLEANOUT_METHODS = [
  "Triple rinse",
  "Clean water flush",
  "Tank cleaner flush",
  "Dedicated tank, no residue risk",
];
const AREAS_BY_SERVICE = {
  pest: [
    "Perimeter",
    "Garage",
    "Kitchen",
    "Bathrooms",
    "Entry points",
    "Yard",
    "Fence line",
    "Trash area",
  ],
  lawn: [
    "Front yard",
    "Back yard",
    "Side yard",
    "Landscape beds",
    "Shrubs",
    "Palms",
    "Problem area",
    "Irrigation zone",
  ],
  universal: [
    "Customer spoke with tech",
    "No issues found",
    "Follow-up recommended",
  ],
};
const CUSTOMER_INTERACTION_OPTIONS = [
  { value: "tech_home_spoke_with_them", label: "Customer home — spoke with them" },
  { value: "not_home_full_access", label: "Customer not home — full access" },
  { value: "not_home_partial_access", label: "Customer not home — partial access" },
  { value: "customer_specific_concern", label: "Customer had specific concern" },
];
const CUSTOMER_INTERACTION_ALIASES = {
  spoke: "tech_home_spoke_with_them",
  not_home_full: "not_home_full_access",
  not_home_partial: "not_home_partial_access",
  concern: "customer_specific_concern",
};
const COMPLETION_PHOTO_MAX_BYTES = 1.5 * 1024 * 1024;
const COMPLETION_PHOTO_MAX_DIMENSION = 1600;
const COMPLETION_PHOTO_QUALITY_STEPS = [0.82, 0.72, 0.62, 0.54];

function normalizeCustomerInteractionValue(value) {
  return CUSTOMER_INTERACTION_ALIASES[value] || value || "";
}

function isCustomerConcernInteraction(value) {
  return normalizeCustomerInteractionValue(value) === "customer_specific_concern";
}

function dataUrlApproxBytes(dataUrl) {
  const encoded = String(dataUrl || "").split(",")[1] || "";
  return Math.ceil((encoded.length * 3) / 4);
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Could not read photo"));
    };
    img.src = url;
  });
}

async function prepareCompletionPhoto(file) {
  if (!file?.type?.startsWith("image/")) {
    throw new Error("Only image files can be attached.");
  }
  const image = await loadImageFromFile(file);
  const largestSide = Math.max(image.naturalWidth || image.width, image.naturalHeight || image.height);
  let scale = largestSide > COMPLETION_PHOTO_MAX_DIMENSION
    ? COMPLETION_PHOTO_MAX_DIMENSION / largestSide
    : 1;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const width = Math.max(1, Math.round((image.naturalWidth || image.width) * scale));
    const height = Math.max(1, Math.round((image.naturalHeight || image.height) * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(image, 0, 0, width, height);

    for (const quality of COMPLETION_PHOTO_QUALITY_STEPS) {
      const data = canvas.toDataURL("image/jpeg", quality);
      if (dataUrlApproxBytes(data) <= COMPLETION_PHOTO_MAX_BYTES) {
        return {
          data,
          name: file.name?.replace(/\.[^.]+$/, ".jpg") || "service-photo.jpg",
          capturedAt: new Date().toISOString(),
        };
      }
    }
    scale *= 0.75;
  }
  throw new Error("Photo is too large to attach to completion.");
}

const isMobile = typeof window !== "undefined" && window.innerWidth < 640;

const SKIP_REASONS = [
  { value: "not_home", label: "Customer not home" },
  { value: "inaccessible", label: "Property inaccessible" },
  { value: "weather", label: "Weather" },
  { value: "customer_requested", label: "Customer requested" },
  { value: "tech_behind", label: "Tech running behind" },
];

/* ── Helpers ──────────────────────────────────────────── */

// Strips legacy boilerplate from historical imported appointment notes.
function stripLegacyBoilerplate(notes) {
  if (!notes) return "";
  return notes
    .replace(/\*{3}\s*Please make changes.*?(?:\*{3}|$)/gis, "")
    .replace(
      /Please make changes to this appointment in the [\s\S]*?next sync\./gi,
      "",
    )
    .replace(/New customer\s*[-\u2013\u2014]\s*first visit/gi, "")
    .replace(/New customer\s*[-\u2013\u2014]\s*first time/gi, "")
    .replace(/First[-\s]time customer/gi, "")
    .replace(/Booked online/gi, "")
    .replace(/Any changes made here will be overwritten.*$/gim, "")
    .replace(/\|\s*$/g, "")
    .replace(/^\s*\|/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function adminFetch(path, options = {}) {
  return fetch(`${API_BASE}${path}`, {
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  }).then(async (r) => {
    if (!r.ok) {
      // Surface the server's error body — completion handlers branch on
      // err.code (completion_billing_required and friends), so a bare
      // "HTTP 409" string breaks the billing-detour routing.
      let body = null;
      try { body = await r.json(); } catch { /* non-JSON error */ }
      const err = new Error(body?.error || `HTTP ${r.status}`);
      err.status = r.status;
      if (body?.code) err.code = body.code;
      if (body?.violations) err.violations = body.violations;
      throw err;
    }
    return r.json();
  });
}

async function generateAiReport(payload) {
  const r = await fetch(`${API_BASE}/admin/schedule/generate-report`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  let body = null;
  try {
    body = await r.json();
  } catch {
    /* non-JSON body */
  }
  if (!r.ok) {
    const detail = body?.error || `HTTP ${r.status}`;
    const err = new Error(detail);
    err.status = r.status;
    throw err;
  }
  return body || {};
}

function googleMapsUrl(address) {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

function detectServiceCategory(serviceType) {
  const s = (serviceType || "").toLowerCase();
  if (
    s.includes("lawn") ||
    s.includes("turf") ||
    s.includes("grass") ||
    s.includes("fertil") ||
    s.includes("weed") ||
    s.includes("dethatch") ||
    s.includes("top dress") ||
    s.includes("aerat") ||
    s.includes("sod")
  )
    return "lawn";
  if (s.includes("tree") || s.includes("shrub") || s.includes("palm"))
    return "tree_shrub";
  if (s.includes("mosquito")) return "mosquito";
  if (s.includes("termite")) return "termite";
  if (
    s.includes("rodent") ||
    /\brat(s)?\b/.test(s) ||
    /\bmouse\b/.test(s) ||
    /\bmice\b/.test(s) ||
    /\bmole\b/.test(s)
  )
    return "pest";
  return "pest";
}

function fmtProtocolNumber(value, suffix = "") {
  if (value == null || value === "") return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  return `${n.toLocaleString(undefined, { maximumFractionDigits: 3 })}${suffix}`;
}

function protocolTrackForLawnType(lawnType) {
  const value = String(lawnType || "")
    .trim()
    .toLowerCase();
  const legacyTrackMap = {
    a_st_aug_sun: "st_augustine",
    b_st_aug_shade: "st_augustine",
    c1_bermuda: "bermuda",
    c2_zoysia: "zoysia",
    d_bahia: "bahia",
  };
  if (legacyTrackMap[value]) return legacyTrackMap[value];
  if (["st_augustine", "bermuda", "zoysia", "bahia"].includes(value))
    return value;
  if (value.includes("bermuda")) return "bermuda";
  if (value.includes("zoysia")) return "zoysia";
  if (value.includes("bahia")) return "bahia";
  if (
    value.includes("st. augustine") ||
    value.includes("st augustine") ||
    value.includes("st_augustine")
  )
    return "st_augustine";
  return null;
}

function lawnAreaForProtocol(service) {
  const candidates = [service.lawnSqft, service.lawn_sqft];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function createCompletionIdempotencyKey(serviceId) {
  const randomPart =
    window.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `complete_${serviceId}_${randomPart}`;
}

export function shouldResetCompletionIdempotencyKey(error) {
  const status = Number(error?.status);
  if (!Number.isFinite(status) || status < 400 || status >= 500) return false;
  if (status !== 409) return true;
  return error?.code === "lawn_assessment_stale";
}

function completionDraftKey(serviceId) {
  return `waves_completion_draft_${serviceId}`;
}

// Accepts "HH:MM" or "HH:MM:SS" (DB rows carry seconds; time inputs don't).
function timeToMinutes(value) {
  if (typeof value !== "string") return null;
  const m = value.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function minutesToTime(total) {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

function elapsedSince(isoTime) {
  if (!isoTime) return "0:00";
  const diff = Math.max(
    0,
    Math.floor((Date.now() - new Date(isoTime).getTime()) / 1000),
  );
  const m = Math.floor(diff / 60);
  const s = diff % 60;
  const h = Math.floor(m / 60);
  if (h > 0)
    return `${h}:${String(m % 60).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

const btnBase = {
  height: 44,
  minWidth: 110,
  padding: "0 18px",
  borderRadius: 12,
  border: "none",
  fontWeight: 700,
  fontSize: 13,
  cursor: "pointer",
  transition: "all 0.2s",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
};

/* ── Edit Service Modal ───────────────────────────────── */

const EDIT_CATEGORY_LABELS = {
  recurring: "Recurring Services",
  one_time: "One-Time Treatments",
  assessment: "Assessments",
  pest_control: "Pest Control",
  lawn_care: "Lawn Care",
  mosquito: "Mosquito",
  termite: "Termite",
  rodent: "Rodent",
  tree_shrub: "Tree & Shrub",
  inspection: "Inspections",
  specialty: "Specialty",
  other: "Other",
};
const EDIT_CATEGORY_EMOJI = {
  recurring: "",
  one_time: "",
  assessment: "",
  pest_control: "",
  lawn_care: "",
  mosquito: "",
  termite: "",
  rodent: "",
  tree_shrub: "",
  inspection: "",
  specialty: "",
  other: "",
};
const EDIT_FREQUENCIES = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "biweekly", label: "Every 2 weeks" },
  { value: "monthly", label: "Monthly" },
  { value: "bimonthly", label: "Every 2 months" },
  { value: "quarterly", label: "Quarterly" },
  { value: "triannual", label: "Every 4 months" },
  { value: "semiannual", label: "Semiannual" },
  { value: "annual", label: "Annual" },
  { value: "monthly_nth_weekday", label: "Every month on the Nth weekday" },
  { value: "custom", label: "Custom (every N days)" },
];
const EDIT_NTH_OPTIONS = [
  { value: 1, label: "1st" },
  { value: 2, label: "2nd" },
  { value: 3, label: "3rd" },
  { value: 4, label: "4th" },
  { value: 5, label: "5th / last" },
];
const EDIT_WEEKDAY_OPTIONS = [
  { value: 0, label: "Sunday" },
  { value: 1, label: "Monday" },
  { value: 2, label: "Tuesday" },
  { value: 3, label: "Wednesday" },
  { value: 4, label: "Thursday" },
  { value: 5, label: "Friday" },
  { value: 6, label: "Saturday" },
];

function editNthWeekdayOfMonth(year, month, nth, weekday) {
  const d = new Date(year, month, 1, 12, 0, 0);
  const firstW = d.getDay();
  const offset = (weekday - firstW + 7) % 7;
  const lastDay = new Date(year, month + 1, 0).getDate();
  let day = 1 + offset + (Math.max(1, nth) - 1) * 7;
  if (day > lastDay) day -= 7;
  return new Date(year, month, day, 12, 0, 0);
}

function editNextRecurringDate(baseDateStr, pattern, i, opts = {}) {
  const { nth, weekday, intervalDays } = opts;
  const safe = baseDateStr ? String(baseDateStr).split("T")[0] : etDateString();
  const base = new Date(safe + "T12:00:00");
  if (isNaN(base.getTime())) return new Date();
  const nthNum =
    nth != null && nth !== "" && !isNaN(parseInt(nth)) ? parseInt(nth) : null;
  const wdayNum =
    weekday != null && weekday !== "" && !isNaN(parseInt(weekday))
      ? parseInt(weekday)
      : null;
  const intNum =
    intervalDays != null &&
    intervalDays !== "" &&
    !isNaN(parseInt(intervalDays))
      ? parseInt(intervalDays)
      : null;
  if (pattern === "monthly_nth_weekday" && nthNum != null && wdayNum != null) {
    const d = editNthWeekdayOfMonth(
      base.getFullYear(),
      base.getMonth() + i,
      nthNum,
      wdayNum,
    );
    return isNaN(d.getTime()) ? base : d;
  }
  const monthIntervals = {
    monthly: 1,
    bimonthly: 2,
    quarterly: 3,
    triannual: 4,
    semiannual: 6,
    biannual: 6,
    annual: 12,
    yearly: 12,
  };
  if (monthIntervals[pattern]) {
    const d = new Date(base);
    const nth = Math.ceil(d.getDate() / 7);
    const target = editNthWeekdayOfMonth(
      d.getFullYear(),
      d.getMonth() + monthIntervals[pattern] * i,
      nth,
      d.getDay(),
    );
    return isNaN(target.getTime()) ? base : target;
  }
  const intervals = { daily: 1, weekly: 7, biweekly: 14 };
  let gap;
  if (pattern === "custom" && intNum) gap = Math.max(1, intNum);
  else gap = intervals[pattern] || 91;
  const d = new Date(base);
  d.setDate(d.getDate() + gap * i);
  return isNaN(d.getTime()) ? base : d;
}

function editShiftPastWeekend(date, skip, direction) {
  if (!skip || !date || isNaN(date.getTime())) return date;
  const day = date.getDay();
  if (day !== 0 && day !== 6) return date;
  const shifted = new Date(date);
  if (direction === "back") {
    shifted.setDate(shifted.getDate() - (day === 6 ? 1 : 2));
  } else {
    shifted.setDate(shifted.getDate() + (day === 6 ? 2 : 1));
  }
  return shifted;
}
const EDIT_FALLBACK_SERVICES = [
  {
    category: "pest_control",
    items: [
      { name: "Pest Control Service" },
      { name: "Mosquito Control Service" },
      { name: "Tick Control Service" },
      { name: "Wasp Control Service" },
      { name: "Quarterly Pest Control Service" },
      { name: "Bi-Monthly Pest Control Service" },
      { name: "Monthly Pest Control Service" },
    ],
  },
  {
    category: "rodent",
    items: [
      { name: "Rodent Control Service" },
      { name: "Rodent Trapping Service" },
      { name: "Rodent Exclusion Service" },
      { name: "Rodent Bait Station Service" },
    ],
  },
  {
    category: "termite",
    items: [
      { name: "Termite Monitoring Service" },
      { name: "Termite Active Bait Station Service" },
      { name: "Termite Spot Treatment Service" },
      { name: "Termite Trenching Service" },
    ],
  },
  {
    category: "lawn_care",
    items: [
      { name: "Lawn Care Service" },
      { name: "Lawn Fertilization Service" },
      { name: "Lawn Fungicide Treatment Service" },
      { name: "Lawn Insect Control Service" },
    ],
  },
  {
    category: "tree_shrub",
    items: [
      { name: "Every 6 Weeks Tree & Shrub Care Service" },
      { name: "Bi-Monthly Tree & Shrub Care Service" },
    ],
  },
  {
    category: "specialty",
    items: [
      { name: "WaveGuard Membership" },
      { name: "Waves Pest Control Appointment" },
    ],
  },
];

export function EditServiceModal({ service, technicians, onClose, onSaved, onMarkPrepaid }) {
  const serviceHasSeries = !!(
    service.isRecurring ||
    service.recurringParentId ||
    service.recurring_parent_id
  );
  const serviceIsRecurringTemplate = !!(
    service.isRecurring &&
    !service.recurringParentId &&
    !service.recurring_parent_id
  );
  const [form, setForm] = useState({
    scheduledDate: service.scheduledDate
      ? String(service.scheduledDate).split("T")[0]
      : "",
    windowStart: service.windowStart || "",
    windowEnd: service.windowEnd || "",
    serviceType: service.serviceType || "",
    // The stored estimated_duration_minutes is the whole-visit total (primary +
    // add-ons). Show the primary line's own duration here by backing out the
    // add-on durations, so on save primary + add-ons re-sum to the total.
    estimatedDuration: (() => {
      const total = service.estimatedDuration;
      if (total == null) return 60;
      const addons = Array.isArray(service.serviceAddons) ? service.serviceAddons : [];
      const addonDur = addons.reduce(
        (s, a) =>
          s +
          (a.estimatedDuration != null && !isNaN(Number(a.estimatedDuration))
            ? Number(a.estimatedDuration)
            : 0),
        0,
      );
      return Math.max(0, Number(total) - addonDur);
    })(),
    technicianId: service.technicianId || "",
    routeOrder: service.routeOrder || "",
    notes: service.notes || "",
    // Per-job third-party Bill-To override + PO. Empty payerId = inherit the
    // customer's default payer (or self-pay). Round-trips via ...form on save.
    payerId: service.payerId != null ? String(service.payerId) : "",
    poNumber: service.poNumber || "",
    // The editable primary "Price" must be the primary line price, NOT the
    // whole-visit total. When the appointment has add-on lines, estimatedPrice
    // is the combined total, so prefer the API's primary_line_price; fall back
    // to backing the add-on grosses out of the total only if it isn't exposed.
    price: (() => {
      // Only trust primaryLinePrice when the add-on lines are also known — a
      // list payload that omits serviceAddons can't distinguish primary from
      // total, so we must fall back to the full visit total (the legacy save
      // path preserves it correctly) instead of rebasing the visit down to the
      // primary line.
      const addonsKnown = Array.isArray(service.serviceAddons);
      const addons = addonsKnown ? service.serviceAddons : [];
      if (addonsKnown && service.primaryLinePrice != null) return String(service.primaryLinePrice);
      const total =
        service.estimatedPrice != null
          ? service.estimatedPrice
          : service.estimated_price != null
            ? service.estimated_price
            : null;
      if (total == null) return "";
      if (addonsKnown && addons.length > 0) {
        const addonGross = addons.reduce((sum, a) => {
          const v =
            a.basePrice != null
              ? a.basePrice
              : a.estimatedPrice != null
                ? a.estimatedPrice
                : 0;
          return sum + (Number(v) || 0);
        }, 0);
        return String(Math.max(0, Math.round((Number(total) - addonGross) * 100) / 100));
      }
      return String(total);
    })(),
  });
  const [saving, setSaving] = useState(false);
  const [serviceGroups, setServiceGroups] = useState(EDIT_FALLBACK_SERVICES);
  const [expandedCategory, setExpandedCategory] = useState(null);
  // Which service line's picker is open: null | 'primary' | line._key
  const [pickerKey, setPickerKey] = useState(null);
  // Additional service lines (add-ons) shown beneath the primary service.
  // Seeded from the appointment's existing add-on rows so reopening the editor
  // round-trips them rather than dropping them.
  const [serviceLines, setServiceLines] = useState(() =>
    (Array.isArray(service.serviceAddons) ? service.serviceAddons : []).map((a, i) => {
      // Seed the editable line Price from the net charge (estimated_price) so it
      // matches what's invoiced.
      const seededPrice =
        a.estimatedPrice != null
          ? String(a.estimatedPrice)
          : a.basePrice != null
            ? String(a.basePrice)
            : "";
      return {
        _key: `addon-${a.id || i}`,
        id: a.id || null,
        serviceId: a.serviceId || null,
        serviceType: a.serviceName || "",
        price: seededPrice,
        // Original economics captured so an unchanged line round-trips its
        // gross/discount breakdown verbatim instead of collapsing to a flat
        // net amount (which would drop the line-discount audit).
        _seededPrice: seededPrice,
        _origBasePrice: a.basePrice != null ? a.basePrice : null,
        _origDiscountType: a.discountType || null,
        _origDiscountAmount: a.discountAmount != null ? a.discountAmount : null,
        _origDiscountId: a.discountId || null,
        _origDiscountName: a.discountName || null,
        estimatedDuration: a.estimatedDuration != null ? String(a.estimatedDuration) : "",
        recurringPattern: a.recurringPattern || null,
        recurringIntervalDays: a.recurringIntervalDays ?? null,
        recurringNth: a.recurringNth ?? null,
        recurringWeekday: a.recurringWeekday ?? null,
        skipWeekends: a.skipWeekends,
        weekendShift: a.weekendShift,
      };
    }),
  );
  const hadAddonsInitially = Array.isArray(service.serviceAddons) && service.serviceAddons.length > 0;
  // Estimate provenance: if this appointment was scheduled from an accepted
  // estimate, surface the same quote/deposit/charge card the New Appointment
  // modal and the appointment detail sheet show. The endpoint resolves the
  // source estimate from the scheduled-service id server-side and returns
  // { linked: false } when there's none, so no client-side guard is needed.
  const [estimateSource, setEstimateSource] = useState(null);
  useEffect(() => {
    if (!service?.id) return undefined;
    let cancelled = false;
    adminFetch(`/admin/schedule/${service.id}/estimate-source`)
      .then((data) => { if (!cancelled) setEstimateSource(data?.linked ? data : null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [service?.id]);
  const [isRecurring, setIsRecurring] = useState(serviceIsRecurringTemplate);
  const [recurringFreq, setRecurringFreq] = useState(
    service.recurringPattern || service.recurring_pattern || "quarterly",
  );
  const [recurringCount, setRecurringCount] = useState(4);
  const [recurringOngoing, setRecurringOngoing] = useState(
    service.recurringOngoing ?? service.recurring_ongoing ?? true,
  );
  const [recurringNth, setRecurringNth] = useState(
    service.recurringNth ?? service.recurring_nth ?? 3,
  );
  const [recurringWeekday, setRecurringWeekday] = useState(
    service.recurringWeekday ?? service.recurring_weekday ?? 3,
  );
  const [recurringIntervalDays, setRecurringIntervalDays] = useState(
    service.recurringIntervalDays ?? service.recurring_interval_days ?? 30,
  );
  const [skipWeekends, setSkipWeekends] = useState(
    !!(service.skipWeekends ?? service.skip_weekends),
  );
  const [weekendShift, setWeekendShift] = useState(
    (service.weekendShift || service.weekend_shift) === "back"
      ? "back"
      : "forward",
  );
  const [assignmentScope, setAssignmentScope] = useState(() =>
    serviceHasSeries ? "following" : "this_only",
  );
  const [discountType, setDiscountType] = useState("");
  const [discountAmount, setDiscountAmount] = useState("");
  const [discountPresets, setDiscountPresets] = useState([]);
  const [discountPresetId, setDiscountPresetId] = useState("");
  const [createInvoice, setCreateInvoice] = useState(
    !!(service.createInvoiceOnComplete ?? service.create_invoice_on_complete),
  );
  const [customerData, setCustomerData] = useState(null);
  const [customerLoading, setCustomerLoading] = useState(false);
  const [payers, setPayers] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const r = await adminFetch("/admin/schedule/services-dropdown");
        if (r.groups?.length) setServiceGroups(r.groups);
      } catch {
        /* keep fallback */
      }
    })();
    (async () => {
      try {
        const r = await adminFetch("/admin/payers");
        if (Array.isArray(r?.payers)) setPayers(r.payers);
      } catch {
        /* payers optional — self-pay still works */
      }
    })();
    (async () => {
      try {
        const r = await adminFetch("/admin/discounts");
        const list = Array.isArray(r) ? r : [];
        const filtered = list.filter(
          (d) =>
            d.is_active &&
            !d.is_auto_apply &&
            (d.discount_type === "percentage" ||
              d.discount_type === "fixed_amount"),
        );
        setDiscountPresets(filtered);
      } catch {
        /* discounts optional */
      }
    })();
  }, []);

  useEffect(() => {
    const customerId = service.customerId || service.customer_id;
    if (!customerId) return;
    let cancelled = false;
    setCustomerLoading(true);
    adminFetch(`/admin/customers/${customerId}`)
      .then((json) => {
        if (!cancelled) setCustomerData(json);
      })
      .catch(() => {
        if (!cancelled) setCustomerData(null);
      })
      .finally(() => {
        if (!cancelled) setCustomerLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service.customerId, service.customer_id]);

  const applyDiscountPreset = (id) => {
    setDiscountPresetId(id);
    if (!id) {
      setDiscountType("");
      setDiscountAmount("");
      return;
    }
    if (id === "custom") return;
    const d = discountPresets.find((x) => String(x.id) === String(id));
    if (!d) return;
    setDiscountType(d.discount_type);
    setDiscountAmount(String(d.amount ?? ""));
  };

  const update = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  // Moving the start time drags the end time with it, preserving the window
  // length (end stays independently editable to resize the window). Clamp at
  // 23:59 — windowEnd is a time-of-day on the same date, so wrapping past
  // midnight would invert the window.
  const updateWindowStart = (newStart) =>
    setForm((f) => {
      const next = { ...f, windowStart: newStart };
      const prevStart = timeToMinutes(f.windowStart);
      const prevEnd = timeToMinutes(f.windowEnd);
      const start = timeToMinutes(newStart);
      if (prevStart != null && prevEnd != null && start != null) {
        const windowLen = prevEnd - prevStart;
        if (windowLen > 0) {
          next.windowEnd = minutesToTime(
            Math.min(start + windowLen, 23 * 60 + 59),
          );
        }
      }
      return next;
    });
  const updateLine = (key, k, v) =>
    setServiceLines((lines) =>
      lines.map((l) => (l._key === key ? { ...l, [k]: v } : l)),
    );
  const addServiceLine = () =>
    setServiceLines((lines) => [
      ...lines,
      {
        _key: `addon-new-${Date.now()}-${lines.length}`,
        id: null,
        serviceId: null,
        serviceType: "",
        price: "",
        _seededPrice: null,
        _origBasePrice: null,
        _origDiscountType: null,
        _origDiscountAmount: null,
        _origDiscountId: null,
        _origDiscountName: null,
        estimatedDuration: "",
        recurringPattern: null,
        recurringIntervalDays: null,
        recurringNth: null,
        recurringWeekday: null,
        skipWeekends: undefined,
        weekendShift: undefined,
      },
    ]);
  const removeServiceLine = (key) =>
    setServiceLines((lines) => lines.filter((l) => l._key !== key));
  const recurringControlsActive = isRecurring || serviceIsRecurringTemplate;

  const recurringPreview = () => {
    if (!recurringControlsActive || !form.scheduledDate) return null;
    const opts = {
      nth: recurringNth,
      weekday: recurringWeekday,
      intervalDays: recurringIntervalDays,
    };
    const limit = Math.min(recurringOngoing ? 4 : recurringCount, 6);
    const dates = [];
    for (let i = 0; i < limit; i++) {
      const d = editNextRecurringDate(
        form.scheduledDate,
        recurringFreq,
        i,
        opts,
      );
      const displayDate =
        i === 0
          ? d
          : editShiftPastWeekend(d, !!skipWeekends, weekendShift);
      dates.push(
        displayDate.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
      );
    }
    return dates;
  };

  const handleSave = async ({ takePayment = false } = {}) => {
    setSaving(true);
    try {
      // Only manage add-on lines when there are any to send (or any existed
      // originally, so removals persist). Otherwise keep the legacy payload.
      const cleanLines = serviceLines
        .map((l) => ({ ...l, serviceType: (l.serviceType || "").trim() }))
        .filter((l) => l.serviceType);
      const sendAddons = cleanLines.length > 0 || hadAddonsInitially;
      const addonsPayload = sendAddons
        ? cleanLines.map((l) => {
            const common = {
              serviceId: l.serviceId || null,
              serviceName: l.serviceType,
              estimatedDuration:
                l.estimatedDuration !== "" && !isNaN(parseInt(l.estimatedDuration, 10))
                  ? parseInt(l.estimatedDuration, 10)
                  : null,
              recurringPattern: l.recurringPattern || null,
              recurringIntervalDays: l.recurringIntervalDays ?? null,
              recurringNth: l.recurringNth ?? null,
              recurringWeekday: l.recurringWeekday ?? null,
              skipWeekends: l.skipWeekends,
              weekendShift: l.weekendShift,
            };
            const priceUnchanged =
              !!l.id && String(l.price) === String(l._seededPrice ?? "");
            // Unchanged existing line that has a real gross + line discount:
            // round-trip its original breakdown so the server reconstructs the
            // same line ($100 − $10), preserving the discount audit. We require
            // _origBasePrice so the server re-derives net from the true gross —
            // a legacy row with a discount but no base_price would otherwise be
            // double-discounted, so it falls through to the flat-net path below.
            if (priceUnchanged && l._origDiscountType && l._origBasePrice != null) {
              return {
                ...common,
                basePrice: l._origBasePrice,
                discountType: l._origDiscountType,
                discountAmount: l._origDiscountAmount != null ? l._origDiscountAmount : null,
                discountId: l._origDiscountId || null,
                discountName: l._origDiscountName || null,
              };
            }
            // New or price-edited line: the editor has no per-line discount UI,
            // so treat the Price as the final (net) charge with no discount.
            // (Re-applying a stored discount here would double-discount rows
            // whose seeded price was already net.)
            return {
              ...common,
              price:
                l.price !== "" && !isNaN(parseFloat(l.price))
                  ? parseFloat(l.price)
                  : null,
            };
          })
        : undefined;
      await adminFetch(`/admin/schedule/${service.id}/update-details`, {
        method: "PUT",
        body: JSON.stringify({
          ...form,
          ...(sendAddons
            ? {
                addons: addonsPayload,
                primaryLinePrice:
                  form.price !== "" && !isNaN(parseFloat(form.price))
                    ? parseFloat(form.price)
                    : undefined,
                // Parent estimated_duration_minutes drives schedule-grid sizing
                // and capacity, so send the summed group duration (primary line
                // + add-on lines), matching the create flow.
                estimatedDuration: (() => {
                  const primaryDur = parseInt(form.estimatedDuration, 10);
                  const base = Number.isInteger(primaryDur) && primaryDur > 0 ? primaryDur : 0;
                  const addonDur = cleanLines.reduce(
                    (s, l) =>
                      s +
                      (l.estimatedDuration !== "" && !isNaN(parseInt(l.estimatedDuration, 10))
                        ? parseInt(l.estimatedDuration, 10)
                        : 0),
                    0,
                  );
                  const total = base + addonDur;
                  return total > 0 ? String(total) : form.estimatedDuration;
                })(),
              }
            : {}),
          isRecurring: recurringControlsActive,
          spawnRecurringChildren: isRecurring && !serviceIsRecurringTemplate,
          recurringPattern: recurringControlsActive ? recurringFreq : undefined,
          recurringCount: isRecurring && !serviceHasSeries
            ? recurringOngoing
              ? 4
              : recurringCount
            : undefined,
          recurringOngoing: recurringControlsActive ? recurringOngoing : undefined,
          recurringNth:
            recurringControlsActive && recurringFreq === "monthly_nth_weekday"
              ? recurringNth
              : undefined,
          recurringWeekday:
            recurringControlsActive && recurringFreq === "monthly_nth_weekday"
              ? recurringWeekday
              : undefined,
          recurringIntervalDays:
            recurringControlsActive && recurringFreq === "custom"
              ? recurringIntervalDays
              : undefined,
          skipWeekends: recurringControlsActive ? !!skipWeekends : undefined,
          weekendShift:
            recurringControlsActive && skipWeekends ? weekendShift : undefined,
          discountType: discountType || undefined,
          discountAmount:
            discountType && discountAmount !== ""
              ? Number(discountAmount)
              : undefined,
          estimatedPrice:
            form.price !== "" && !isNaN(parseFloat(form.price))
              ? parseFloat(form.price)
              : undefined,
          createInvoice: takePayment || createInvoice,
          assignmentScope:
            form.technicianId !== (service.technicianId || "")
              ? assignmentScope
              : undefined,
        }),
      });
      onSaved?.();
    } catch (e) {
      alert("Save failed: " + e.message);
    }
    setSaving(false);
  };

  const customer = customerData?.customer || {};
  const customerName =
    service.customerName ||
    `${customer.firstName || ""} ${customer.lastName || ""}`.trim() ||
    "Customer";
  const customerPhone = service.customerPhone || customer.phone || "";
  const customerEmail = customer.email || "";
  const primaryPrice =
    form.price !== "" && !isNaN(parseFloat(form.price))
      ? parseFloat(form.price)
      : 0;
  const addonLinesTotal = serviceLines.reduce(
    (sum, l) =>
      sum + (l.price !== "" && !isNaN(parseFloat(l.price)) ? parseFloat(l.price) : 0),
    0,
  );
  const servicePrice = primaryPrice + addonLinesTotal;
  const manualDiscount =
    discountType && discountAmount !== ""
      ? discountType === "percentage"
        ? servicePrice * (Number(discountAmount) / 100)
        : Number(discountAmount)
      : 0;
  const appointmentTotal = Math.max(0, servicePrice - manualDiscount);
  const appointmentHistory = Array.isArray(customerData?.scheduled)
    ? [...customerData.scheduled]
        .sort((a, b) =>
          String(b.scheduled_date).localeCompare(String(a.scheduled_date)),
        )
        .slice(0, 6)
    : [];
  const cards = Array.isArray(customerData?.cards) ? customerData.cards : [];

  const formatHistoryDate = (value, time) => {
    if (!value) return "";
    const [year, month, day] = String(value)
      .split("T")[0]
      .split("-")
      .map(Number);
    const d = new Date(Date.UTC(year, month - 1, day, 12));
    const dateText = d.toLocaleDateString("en-US", {
      timeZone: "UTC",
      weekday: "short",
      month: "short",
      day: "numeric",
      year: "numeric",
    });
    const timeMatch = String(time || "").match(/^(\d{1,2}):(\d{2})/);
    const timeText = timeMatch
      ? `${parseInt(timeMatch[1], 10) % 12 || 12}:${timeMatch[2]} ${parseInt(timeMatch[1], 10) >= 12 ? "PM" : "AM"}`
      : "";
    return [dateText, timeText].filter(Boolean).join(", ");
  };

  const labelStyle = {
    fontSize: 12,
    color: "#374151",
    marginBottom: 6,
    display: "block",
    fontWeight: 700,
  };
  const inputStyle = {
    width: "100%",
    padding: "11px 12px",
    borderRadius: 4,
    background: D.input,
    color: "#111827",
    border: `1px solid ${D.inputBorder}`,
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  };
  const sectionStyle = {
    background: "#fff",
    border: `1px solid ${D.border}`,
    borderRadius: 6,
    padding: 18,
    marginBottom: 16,
  };
  const sectionTitleStyle = {
    fontSize: 18,
    fontWeight: 700,
    color: "#111827",
    margin: "0 0 14px",
  };
  const weekendRuleValue = skipWeekends ? weekendShift : "allow";
  const updateWeekendRule = (value) => {
    if (value === "allow") {
      setSkipWeekends(false);
      return;
    }
    setSkipWeekends(true);
    setWeekendShift(value === "back" ? "back" : "forward");
  };

  // Renders one service line (the primary service or an additional add-on).
  // `pickerId` keys this line's service picker; `onField(key, value)` writes
  // back to the owning state; `onRemove` (when provided) deletes the line.
  const renderServiceLine = ({
    pickerId,
    serviceType,
    technicianId,
    estimatedDuration,
    price,
    onField,
    onRemove,
    label,
    showStaff = false,
  }) => {
    const picking = pickerKey === pickerId;
    return (
      <div
        style={{
          border: `1px solid ${D.border}`,
          borderRadius: 6,
          overflow: "hidden",
          marginBottom: 12,
        }}
      >
        {(label || onRemove) && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 14px",
              background: "#F3F4F6",
              borderBottom: `1px solid ${D.border}`,
            }}
          >
            <span style={{ fontSize: 12, fontWeight: 800, color: D.muted }}>
              {label || "Additional service"}
            </span>
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="font-bold"
                style={{
                  padding: "4px 10px",
                  borderRadius: 4,
                  background: "#fff",
                  color: "#B42318",
                  border: "1px solid #FCA5A5",
                  fontSize: 12,
                  cursor: "pointer",
                }}
              >
                Remove
              </button>
            )}
          </div>
        )}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
            gap: 12,
            alignItems: "start",
            padding: 14,
            background: "#F9FAFB",
          }}
        >
          <div>
            <label style={labelStyle}>Service</label>
            {!picking ? (
              <div
                style={{ display: "flex", alignItems: "center", gap: 10 }}
              >
                <div style={{ flex: 1, fontSize: 14, color: "#111827" }}>
                  {serviceType || "Select service"}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setPickerKey(pickerId);
                    setExpandedCategory(null);
                  }}
                  className="font-bold"
                  style={{
                    padding: "8px 10px",
                    borderRadius: 4,
                    background: "#fff",
                    color: "#111827",
                    border: `1px solid ${D.inputBorder}`,
                    fontSize: 12,
                    cursor: "pointer",
                  }}
                >
                  Change
                </button>
              </div>
            ) : (
              <div
                style={{
                  maxHeight: 260,
                  overflowY: "auto",
                  border: `1px solid ${D.inputBorder}`,
                  borderRadius: 4,
                  padding: 6,
                  background: "#fff",
                }}
              >
                {serviceGroups.map((group) => {
                  const isOpen = expandedCategory === group.category;
                  return (
                    <div key={group.category} style={{ marginBottom: 4 }}>
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedCategory(isOpen ? null : group.category)
                        }
                        className="font-bold"
                        style={{
                          width: "100%",
                          textAlign: "left",
                          padding: "8px 10px",
                          borderRadius: 4,
                          background: isOpen ? "#EEF6FF" : "#fff",
                          border: `1px solid ${D.border}`,
                          color: "#111827",
                          fontSize: 13,
                          cursor: "pointer",
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                        }}
                      >
                        <span>
                          {EDIT_CATEGORY_LABELS[group.category] ||
                            group.category}{" "}
                          <span style={{ color: D.muted }}>
                            ({group.items.length})
                          </span>
                        </span>
                        <span style={{ color: D.muted, fontSize: 11 }}>
                          {isOpen ? "v" : ">"}
                        </span>
                      </button>
                      {isOpen && (
                        <div
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            gap: 3,
                            padding: 6,
                          }}
                        >
                          {group.items.map((svc, si) => (
                            <button
                              key={si}
                              type="button"
                              onClick={() => {
                                onField("serviceType", svc.name);
                                if (svc.duration || svc.default_duration_minutes) {
                                  onField(
                                    "estimatedDuration",
                                    svc.duration || svc.default_duration_minutes,
                                  );
                                }
                                if (svc.id !== undefined) {
                                  onField("serviceId", svc.id || null);
                                }
                                setPickerKey(null);
                                setExpandedCategory(null);
                              }}
                              className="font-bold"
                              style={{
                                padding: "8px 10px",
                                background: "#fff",
                                border: `1px solid ${D.border}`,
                                borderRadius: 4,
                                color: "#111827",
                                fontSize: 13,
                                cursor: "pointer",
                                textAlign: "left",
                              }}
                            >
                              {svc.name}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
          {showStaff && (
            <div>
              <label style={labelStyle}>Staff</label>
              <select
                value={technicianId}
                onChange={(e) => onField("technicianId", e.target.value)}
                className="font-bold"
                style={inputStyle}
              >
                <option value="">Unassigned</option>
                {(technicians || []).map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {serviceHasSeries &&
                technicianId !== (service.technicianId || "") && (
                  <div style={{ marginTop: 10 }}>
                    <label style={labelStyle}>Apply staff change to</label>
                    <select
                      value={assignmentScope}
                      onChange={(e) => setAssignmentScope(e.target.value)}
                      className="font-bold"
                      style={inputStyle}
                    >
                      <option value="this_only">This appointment only</option>
                      <option value="following">
                        This and following appointments
                      </option>
                      <option value="series">All appointments in series</option>
                    </select>
                  </div>
                )}
            </div>
          )}
          <div>
            <label style={labelStyle}>Duration</label>
            <input
              type="number"
              value={estimatedDuration}
              onChange={(e) => onField("estimatedDuration", e.target.value)}
              className="font-bold"
              style={inputStyle}
            />
          </div>
          <div>
            <label style={labelStyle}>Price</label>
            <input
              type="number"
              min={0}
              step={0.01}
              value={price}
              onChange={(e) => onField("price", e.target.value)}
              placeholder="0.00"
              className="font-bold"
              style={inputStyle}
            />
          </div>
        </div>
      </div>
    );
  };

  return createPortal(
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "#F6F7F8",
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        color: "#111827",
        fontFamily: "Roboto, Arial, sans-serif",
      }}
    >
      {" "}
      <div
        onClick={(e) => e.stopPropagation()}
        className="font-bold"
        style={{
          height: "100%",
          overflow: "auto",
        }}
      >
        {" "}
        <div
          className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between md:gap-4"
          style={{
            position: "sticky",
            top: 0,
            zIndex: 3,
            background: "#fff",
            borderBottom: `1px solid ${D.border}`,
            padding: "14px 20px",
          }}
        >
          {" "}
          <div className="min-w-0 flex-1">
            {" "}
            <div style={{ fontSize: 22, fontWeight: 800, color: "#111827" }}>
              Edit appointment
            </div>{" "}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flexWrap: "wrap",
                gap: 8,
                marginTop: 5,
              }}
            >
              {" "}
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  height: 22,
                  padding: "0 8px",
                  borderRadius: 999,
                  background: "#ECFDF3",
                  color: "#027A48",
                  fontSize: 12,
                  fontWeight: 800,
                }}
              >
                {service.status || "Accepted"}
              </span>{" "}
              <span
                style={{
                  color: D.muted,
                  fontSize: 13,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  minWidth: 0,
                }}
              >
                {customerName}
              </span>{" "}
            </div>{" "}
          </div>{" "}
          <div
            className="w-full md:w-auto"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flexWrap: "wrap",
              justifyContent: "flex-end",
            }}
          >
            {" "}
            <button
              onClick={() => handleSave({ takePayment: true })}
              disabled={saving}
              className="font-bold flex-1 md:flex-initial"
              style={{
                padding: "11px 14px",
                borderRadius: 4,
                background: "#111827",
                color: "#fff",
                border: "none",
                fontSize: 13,
                cursor: saving ? "wait" : "pointer",
                opacity: saving ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {saving ? "Saving..." : "Save & take payment"}
            </button>{" "}
            <button
              onClick={() => handleSave()}
              disabled={saving}
              className="font-bold flex-1 md:flex-initial"
              style={{
                padding: "11px 14px",
                borderRadius: 4,
                background: "#fff",
                color: "#111827",
                border: `1px solid ${D.inputBorder}`,
                fontSize: 13,
                cursor: saving ? "wait" : "pointer",
                opacity: saving ? 0.6 : 1,
                whiteSpace: "nowrap",
              }}
            >
              {saving ? "Saving..." : "Save"}
            </button>{" "}
            <button
              onClick={onClose}
              disabled={saving}
              className="font-bold"
              style={{
                width: 38,
                height: 38,
                borderRadius: 4,
                background: "#fff",
                color: D.muted,
                border: `1px solid ${D.inputBorder}`,
                fontSize: 22,
                lineHeight: 1,
                cursor: "pointer",
              }}
              aria-label="Close"
            >
              ×
            </button>{" "}
          </div>{" "}
        </div>{" "}
        <div
          className="grid grid-cols-1 md:[grid-template-columns:340px_1fr]"
          style={{
            width: "100%",
            maxWidth: 1180,
            margin: "0 auto",
            padding: "18px 16px 36px",
            gap: 20,
          }}
        >
          {" "}
          <aside
            className="order-2 md:order-1 md:sticky md:top-[88px]"
            style={{
              ...sectionStyle,
              alignSelf: "start",
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 13,
                fontWeight: 800,
                color: D.muted,
                marginBottom: 12,
              }}
            >
              Customer
            </div>{" "}
            <div
              style={{
                fontSize: 22,
                fontWeight: 800,
                color: "#111827",
                marginBottom: 10,
              }}
            >
              {customerName}
            </div>{" "}
            <div
              style={{
                display: "grid",
                gap: 4,
                marginBottom: 14,
                fontSize: 14,
                color: "#374151",
              }}
            >
              {customerPhone && (
                <a
                  href={`tel:${customerPhone}`}
                  style={{ color: "#111827", textDecoration: "none" }}
                >
                  {customerPhone}
                </a>
              )}
              {customerEmail && (
                <a
                  href={`mailto:${customerEmail}`}
                  style={{
                    color: "#111827",
                    textDecoration: "none",
                    wordBreak: "break-word",
                  }}
                >
                  {customerEmail}
                </a>
              )}
              {!customerPhone && !customerEmail && (
                <span style={{ color: D.muted }}>No contact details</span>
              )}
            </div>{" "}
            <button
              type="button"
              style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 4,
                border: `1px solid ${D.inputBorder}`,
                background: "#fff",
                color: "#111827",
                fontSize: 13,
                fontWeight: 800,
                cursor: "pointer",
                marginBottom: 18,
              }}
            >
              Customer details
            </button>{" "}
            <div
              style={{
                borderTop: `1px solid ${D.border}`,
                paddingTop: 16,
                marginBottom: 16,
              }}
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  marginBottom: 8,
                }}
              >
                {" "}
                <div style={{ fontSize: 15, fontWeight: 800 }}>
                  Customer notes
                </div>{" "}
                <button
                  type="button"
                  style={{
                    border: 0,
                    background: "transparent",
                    color: D.teal,
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Add note
                </button>{" "}
              </div>{" "}
              <div style={{ fontSize: 13, color: D.muted }}>
                {customer.notes ||
                  customer.customerNotes ||
                  "No customer notes"}
              </div>{" "}
            </div>{" "}
            <div
              style={{
                borderTop: `1px solid ${D.border}`,
                paddingTop: 16,
                marginBottom: 16,
              }}
            >
              {" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  gap: 10,
                  marginBottom: 10,
                }}
              >
                {" "}
                <div style={{ fontSize: 15, fontWeight: 800 }}>
                  Cards on file
                </div>{" "}
                <button
                  type="button"
                  style={{
                    border: 0,
                    background: "transparent",
                    color: D.teal,
                    fontSize: 12,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Add card
                </button>{" "}
              </div>
              {cards.length ? (
                cards.slice(0, 2).map((card, i) => (
                  <div
                    key={card.id || i}
                    style={{ fontSize: 13, color: "#374151", marginBottom: 6 }}
                  >
                    Card ending in {card.last4 || card.card_last4 || "----"}
                  </div>
                ))
              ) : (
                <div style={{ fontSize: 13, color: D.muted }}>
                  No cards on file
                </div>
              )}
            </div>{" "}
            <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 16 }}>
              {" "}
              <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 10 }}>
                Appointment history
              </div>
              {customerLoading && (
                <div style={{ fontSize: 13, color: D.muted }}>
                  Loading history...
                </div>
              )}
              {!customerLoading && appointmentHistory.length === 0 && (
                <div style={{ fontSize: 13, color: D.muted }}>
                  No appointment history
                </div>
              )}
              <div style={{ display: "grid", gap: 12 }}>
                {appointmentHistory.map((item) => (
                  <div
                    key={item.id}
                    style={{
                      borderLeft: `2px solid ${item.id === service.id ? D.teal : D.border}`,
                      paddingLeft: 10,
                    }}
                  >
                    {" "}
                    <div
                      style={{
                        fontSize: 13,
                        fontWeight: 800,
                        color: "#111827",
                      }}
                    >
                      {item.service_type || item.serviceType || "Service"}
                    </div>{" "}
                    <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                      {formatHistoryDate(
                        item.scheduled_date,
                        item.window_start,
                      )}
                    </div>
                    {item.status && (
                      <div
                        style={{ fontSize: 12, color: "#027A48", marginTop: 2 }}
                      >
                        {item.status}
                      </div>
                    )}
                  </div>
                ))}
              </div>{" "}
            </div>{" "}
          </aside>{" "}
          <main className="order-1 md:order-2 min-w-0 flex flex-col">
            {" "}
            <section style={{ ...sectionStyle, order: 2 }}>
              {" "}
              <h2 style={sectionTitleStyle}>Location</h2>{" "}
              <label style={labelStyle}>Appointment location</label>{" "}
              <div
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 8,
                  height: 36,
                  padding: "0 12px",
                  borderRadius: 999,
                  background: "#EEF6FF",
                  color: D.teal,
                  fontSize: 13,
                  fontWeight: 800,
                  marginBottom: 14,
                }}
              >
                Customer location
              </div>{" "}
              <div style={{ display: "grid", gap: 12 }}>
                {" "}
                <div>
                  {" "}
                  <label style={labelStyle}>Street address</label>{" "}
                  <input
                    value={service.address || customer.address?.line1 || ""}
                    readOnly
                    className="font-bold"
                    style={{ ...inputStyle, background: "#F9FAFB" }}
                  />{" "}
                </div>{" "}
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                    gap: 12,
                  }}
                >
                  {" "}
                  <div>
                    {" "}
                    <label style={labelStyle}>City</label>{" "}
                    <input
                      value={service.city || customer.address?.city || ""}
                      readOnly
                      className="font-bold"
                      style={{ ...inputStyle, background: "#F9FAFB" }}
                    />{" "}
                  </div>{" "}
                  <div>
                    {" "}
                    <label style={labelStyle}>State</label>{" "}
                    <input
                      value={customer.address?.state || "Florida"}
                      readOnly
                      className="font-bold"
                      style={{ ...inputStyle, background: "#F9FAFB" }}
                    />{" "}
                  </div>{" "}
                </div>{" "}
              </div>{" "}
            </section>{" "}
            <section style={{ ...sectionStyle, order: 1 }}>
              {" "}
              <h2 style={sectionTitleStyle}>Services and items</h2>{" "}
              {renderServiceLine({
                pickerId: "primary",
                serviceType: form.serviceType,
                technicianId: form.technicianId,
                estimatedDuration: form.estimatedDuration,
                price: form.price,
                onField: update,
                onRemove: null,
                showStaff: true,
                label: serviceLines.length > 0 ? "Primary service" : null,
              })}
              {serviceLines.map((line) =>
                <div key={line._key}>
                  {renderServiceLine({
                    pickerId: line._key,
                    serviceType: line.serviceType,
                    estimatedDuration: line.estimatedDuration,
                    price: line.price,
                    onField: (k, v) => updateLine(line._key, k, v),
                    onRemove: () => removeServiceLine(line._key),
                  })}
                </div>,
              )}
              <button
                type="button"
                onClick={addServiceLine}
                className="font-bold"
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  padding: "9px 12px",
                  borderRadius: 4,
                  border: `1px dashed ${D.inputBorder}`,
                  background: "#fff",
                  color: "#111827",
                  fontSize: 13,
                  fontWeight: 800,
                  cursor: "pointer",
                  marginBottom: 12,
                }}
              >
                + Add service
              </button>{" "}
              {estimateSource && (
                <EstimateProvenanceCard
                  quotedTotal={estimateSource.quotedTotal}
                  currentPrice={appointmentTotal}
                  deposit={estimateSource.deposit}
                  style={{ marginBottom: 14 }}
                />
              )}
              {service.prepaidAmount != null && Number(service.prepaidAmount) > 0 && (
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    gap: 10,
                    padding: "10px 12px",
                    marginBottom: 12,
                    background: "#DCFCE7",
                    border: "1px solid #86EFAC",
                    borderRadius: 6,
                  }}
                >
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 800, color: "#166534" }}>
                      Prepaid ${Number(service.prepaidAmount).toFixed(2)}
                      {service.prepaidMethod ? ` · ${String(service.prepaidMethod).replace(/_/g, " ")}` : ""}
                    </div>
                    {service.prepaidSeriesContext?.totalCoveredVisits > 1 && (
                      <div style={{ fontSize: 12, color: "#15803D", marginTop: 2 }}>
                        Visit {service.prepaidSeriesContext.visitNumber || "?"} of {service.prepaidSeriesContext.totalVisitsInSeries}
                        {service.prepaidSeriesContext.futureCoveredVisits > 0
                          ? ` · ${service.prepaidSeriesContext.futureCoveredVisits} more covered`
                          : ""}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onMarkPrepaid?.(service)}
                    className="font-bold"
                    style={{
                      padding: "8px 12px",
                      borderRadius: 4,
                      background: "#fff",
                      color: "#166534",
                      border: "1px solid #86EFAC",
                      fontSize: 12,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                    }}
                  >
                    Edit
                  </button>
                </div>
              )}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 8,
                  marginBottom: 14,
                }}
              >
                {" "}
                {onMarkPrepaid && !(service.prepaidAmount != null && Number(service.prepaidAmount) > 0) && (
                  <button
                    type="button"
                    onClick={() => onMarkPrepaid(service)}
                    className="font-bold"
                    style={{
                      padding: "9px 12px",
                      borderRadius: 4,
                      border: `1px solid ${D.inputBorder}`,
                      background: "#fff",
                      fontSize: 13,
                      fontWeight: 800,
                      cursor: "pointer",
                    }}
                  >
                    Mark prepaid
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    setDiscountPresetId(discountPresetId || "custom")
                  }
                  className="font-bold"
                  style={{
                    padding: "9px 12px",
                    borderRadius: 4,
                    border: `1px solid ${D.inputBorder}`,
                    background: "#fff",
                    fontSize: 13,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  Add discount
                </button>{" "}
              </div>{" "}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
                  gap: 12,
                  marginBottom: 14,
                }}
              >
                {" "}
                <div>
                  {" "}
                  <label style={labelStyle}>Discount</label>{" "}
                  <select
                    value={discountPresetId}
                    onChange={(e) => applyDiscountPreset(e.target.value)}
                    className="font-bold"
                    style={inputStyle}
                  >
                    {" "}
                    <option value="">None</option>
                    {discountPresets.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name} -{" "}
                        {d.discount_type === "percentage"
                          ? `${Number(d.amount).toFixed(d.amount % 1 ? 2 : 0)}%`
                          : `$${Number(d.amount).toFixed(2)}`}
                      </option>
                    ))}
                    <option value="custom">Custom</option>{" "}
                  </select>{" "}
                </div>
                {discountPresetId === "custom" && (
                  <>
                    {" "}
                    <div>
                      {" "}
                      <label style={labelStyle}>Discount type</label>{" "}
                      <select
                        value={discountType}
                        onChange={(e) => setDiscountType(e.target.value)}
                        className="font-bold"
                        style={inputStyle}
                      >
                        {" "}
                        <option value="">Select</option>{" "}
                        <option value="percentage">Percentage (%)</option>{" "}
                        <option value="fixed_amount">Amount ($)</option>{" "}
                      </select>{" "}
                    </div>
                    {discountType && (
                      <div>
                        {" "}
                        <label style={labelStyle}>
                          {discountType === "percentage"
                            ? "Amount (%)"
                            : "Amount ($)"}
                        </label>{" "}
                        <input
                          type="number"
                          min={0}
                          step={discountType === "percentage" ? 1 : 0.01}
                          value={discountAmount}
                          onChange={(e) => setDiscountAmount(e.target.value)}
                          className="font-bold"
                          style={inputStyle}
                        />{" "}
                      </div>
                    )}
                  </>
                )}
              </div>{" "}
              <div
                style={{
                  borderTop: `1px solid ${D.border}`,
                  paddingTop: 12,
                  display: "grid",
                  gap: 6,
                  justifyContent: "end",
                }}
              >
                {" "}
                <div
                  style={{
                    minWidth: 220,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 40,
                    fontSize: 14,
                  }}
                >
                  {" "}
                  <span>Subtotal</span>
                  <strong>${servicePrice.toFixed(2)}</strong>{" "}
                </div>
                {manualDiscount > 0 && (
                  <div
                    style={{
                      minWidth: 220,
                      display: "flex",
                      justifyContent: "space-between",
                      gap: 40,
                      fontSize: 14,
                      color: "#B42318",
                    }}
                  >
                    {" "}
                    <span>Custom Discount</span>
                    <strong>(${manualDiscount.toFixed(2)})</strong>{" "}
                  </div>
                )}
                <div
                  style={{
                    minWidth: 220,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 40,
                    fontSize: 16,
                    borderTop: `1px solid ${D.border}`,
                    paddingTop: 8,
                  }}
                >
                  {" "}
                  <span>Total</span>
                  <strong>${appointmentTotal.toFixed(2)}</strong>{" "}
                </div>{" "}
              </div>{" "}
            </section>{" "}
            <section style={{ ...sectionStyle, order: 3 }}>
              {" "}
              <h2 style={sectionTitleStyle}>Date and time</h2>{" "}
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                  gap: 12,
                  marginBottom: 14,
                }}
              >
                {" "}
                <div>
                  {" "}
                  <label style={labelStyle}>Date</label>{" "}
                  <input
                    type="date"
                    value={form.scheduledDate}
                    onChange={(e) => update("scheduledDate", e.target.value)}
                    className="font-bold"
                    style={inputStyle}
                  />{" "}
                </div>{" "}
                <div>
                  {" "}
                  <label style={labelStyle}>Time</label>{" "}
                  <input
                    type="time"
                    value={form.windowStart}
                    onChange={(e) => updateWindowStart(e.target.value)}
                    className="font-bold"
                    style={inputStyle}
                  />{" "}
                </div>{" "}
                <div>
                  {" "}
                  <label style={labelStyle}>End time</label>{" "}
                  <input
                    type="time"
                    value={form.windowEnd}
                    onChange={(e) => update("windowEnd", e.target.value)}
                    className="font-bold"
                    style={inputStyle}
                  />{" "}
                </div>{" "}
              </div>{" "}
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  marginBottom: recurringControlsActive ? 14 : 0,
                }}
              >
                {" "}
                <input
                  type="checkbox"
                  checked={recurringControlsActive}
                  onChange={(e) => setIsRecurring(e.target.checked)}
                  disabled={serviceHasSeries}
                  style={{ width: 17, height: 17, accentColor: D.teal }}
                />{" "}
                <div>
                  {" "}
                  <div style={{ fontSize: 14, fontWeight: 800 }}>
                    Repeat
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted }}>
                    Create future appointments from this date
                  </div>{" "}
                </div>{" "}
              </div>
              {recurringControlsActive && (
                <div
                  style={{
                    border: `1px solid ${D.border}`,
                    borderRadius: 6,
                    padding: 14,
                    background: "#F9FAFB",
                  }}
                >
                  {" "}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns:
                        "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: 10,
                      marginBottom: 10,
                    }}
                  >
                    {" "}
                    <div>
                      {" "}
                      <label style={labelStyle}>Repeats</label>{" "}
                      <select
                        value={recurringFreq}
                        onChange={(e) => setRecurringFreq(e.target.value)}
                        className="font-bold"
                        style={inputStyle}
                      >
                        {EDIT_FREQUENCIES.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>{" "}
                    </div>{" "}
                    {!serviceIsRecurringTemplate && (
                      <div>
                        {" "}
                        <label style={labelStyle}>End repeating</label>{" "}
                        <select
                          value={recurringOngoing ? "never" : "count"}
                          onChange={(e) =>
                            setRecurringOngoing(e.target.value === "never")
                          }
                          className="font-bold"
                          style={inputStyle}
                        >
                          {" "}
                          <option value="never">Never</option>{" "}
                          <option value="count">After count</option>{" "}
                        </select>{" "}
                      </div>
                    )}
                    {!serviceIsRecurringTemplate && !recurringOngoing && (
                      <div>
                        {" "}
                        <label style={labelStyle}>Count</label>{" "}
                        <input
                          type="number"
                          min={2}
                          max={24}
                          value={recurringCount}
                          onChange={(e) =>
                            setRecurringCount(parseInt(e.target.value) || 4)
                          }
                          className="font-bold"
                          style={inputStyle}
                        />{" "}
                      </div>
                    )}
                  </div>
                  {recurringFreq === "monthly_nth_weekday" && (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(150px, 1fr))",
                        gap: 10,
                        marginBottom: 10,
                      }}
                    >
                      {" "}
                      <div>
                        {" "}
                        <label style={labelStyle}>Repeat every</label>{" "}
                        <select
                          value={recurringNth}
                          onChange={(e) =>
                            setRecurringNth(parseInt(e.target.value))
                          }
                          className="font-bold"
                          style={inputStyle}
                        >
                          {EDIT_NTH_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>{" "}
                      </div>{" "}
                      <div>
                        {" "}
                        <label style={labelStyle}>Day of month</label>{" "}
                        <select
                          value={recurringWeekday}
                          onChange={(e) =>
                            setRecurringWeekday(parseInt(e.target.value))
                          }
                          className="font-bold"
                          style={inputStyle}
                        >
                          {EDIT_WEEKDAY_OPTIONS.map((o) => (
                            <option key={o.value} value={o.value}>
                              {o.label}
                            </option>
                          ))}
                        </select>{" "}
                      </div>{" "}
                    </div>
                  )}
                  {recurringFreq === "custom" && (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns:
                          "repeat(auto-fit, minmax(150px, 1fr))",
                        gap: 10,
                        marginBottom: 10,
                      }}
                    >
                      {" "}
                      <div>
                        <label style={labelStyle}>Frequency</label>{" "}
                        <input
                          type="number"
                          min={1}
                          max={365}
                          value={recurringIntervalDays}
                          onChange={(e) =>
                            setRecurringIntervalDays(
                              parseInt(e.target.value) || 30,
                            )
                          }
                          className="font-bold"
                          style={inputStyle}
                        />{" "}
                      </div>
                      <div>
                        <label style={labelStyle}>Weekend rule</label>{" "}
                        <select
                          value={weekendRuleValue}
                          onChange={(e) => updateWeekendRule(e.target.value)}
                          className="font-bold"
                          style={inputStyle}
                        >
                          <option value="allow">Allow weekends</option>
                          <option value="forward">
                            Move Sat/Sun to Monday
                          </option>
                          <option value="back">Move Sat/Sun to Friday</option>
                        </select>
                      </div>
                    </div>
                  )}
                  {recurringFreq !== "custom" && (
                    <div style={{ marginBottom: 10 }}>
                      <label style={labelStyle}>Weekend rule</label>{" "}
                      <select
                        value={weekendRuleValue}
                        onChange={(e) => updateWeekendRule(e.target.value)}
                        className="font-bold"
                        style={inputStyle}
                      >
                        <option value="allow">Allow weekends</option>
                        <option value="forward">Move Sat/Sun to Monday</option>
                        <option value="back">Move Sat/Sun to Friday</option>
                      </select>
                    </div>
                  )}
                  {recurringPreview() && (
                    <div
                      style={{
                        fontSize: 12,
                        color: D.muted,
                        display: "flex",
                        flexWrap: "wrap",
                        gap: 5,
                      }}
                    >
                      {recurringPreview().map((d, i) => (
                        <span
                          key={i}
                          style={{
                            padding: "3px 7px",
                            background: "#EEF6FF",
                            borderRadius: 999,
                            color: D.teal,
                            fontWeight: 800,
                          }}
                        >
                          {d}
                        </span>
                      ))}
                      {recurringOngoing ? (
                        <span style={{ padding: "3px 7px" }}>
                          then auto-extends
                        </span>
                      ) : (
                        recurringCount > 6 && (
                          <span style={{ padding: "3px 7px" }}>
                            +{recurringCount - 6} more
                          </span>
                        )
                      )}
                    </div>
                  )}
                </div>
              )}
            </section>{" "}
            <section style={{ ...sectionStyle, order: 4 }}>
              {" "}
              <h2 style={sectionTitleStyle}>Notes</h2>{" "}
              <label style={labelStyle}>Appointment notes</label>{" "}
              <textarea
                value={form.notes}
                onChange={(e) => update("notes", e.target.value)}
                rows={5}
                className="font-bold"
                style={{ ...inputStyle, resize: "vertical" }}
              />{" "}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  cursor: "pointer",
                  marginTop: 14,
                  padding: "11px 12px",
                  background: "#F9FAFB",
                  border: `1px solid ${D.border}`,
                  borderRadius: 4,
                }}
              >
                {" "}
                <input
                  type="checkbox"
                  checked={createInvoice}
                  onChange={(e) => setCreateInvoice(e.target.checked)}
                  style={{ width: 16, height: 16, accentColor: D.green }}
                />{" "}
                <span
                  style={{ fontSize: 13, color: "#111827", fontWeight: 800 }}
                >
                  Create invoice on completion
                </span>{" "}
              </label>
              <div style={{ marginTop: 14 }}>
                <label style={labelStyle}>Bill to (third-party payer)</label>
                <select
                  value={form.payerId}
                  onChange={(e) => update("payerId", e.target.value)}
                  className="font-bold"
                  style={inputStyle}
                >
                  <option value="">
                    {(() => {
                      const def = customer.payerId
                        ? payers.find(
                            (p) => String(p.id) === String(customer.payerId),
                          )
                        : null;
                      return def
                        ? `Use account default — ${def.display_name}`
                        : "Customer pays (self)";
                    })()}
                  </option>
                  {payers.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.display_name}
                      {p.company_name && p.company_name !== p.display_name
                        ? ` — ${p.company_name}`
                        : ""}
                    </option>
                  ))}
                </select>
                <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>
                  {customer.payerId
                    ? "Blank inherits this customer’s default payer; pick a payer to override for just this visit."
                    : "Routes this visit’s invoice to a builder / property manager instead of the customer."}{" "}
                  Manage payers in Finance &rarr; Payers.
                </div>
                {(form.payerId || customer.payerId) && (() => {
                  // PO applies to the EFFECTIVE payer — the per-job override if
                  // set, otherwise the customer's inherited default — so a
                  // default-payer job can still capture a PO.
                  const effectivePayerId = form.payerId || customer.payerId;
                  const selectedPayer = payers.find(
                    (p) => String(p.id) === String(effectivePayerId),
                  );
                  const needsPo =
                    selectedPayer?.requires_po &&
                    !String(form.poNumber || "").trim();
                  return (
                    <div style={{ marginTop: 10 }}>
                      <label style={labelStyle}>PO number (optional)</label>
                      <input
                        type="text"
                        value={form.poNumber}
                        onChange={(e) => update("poNumber", e.target.value)}
                        placeholder="Purchase order #"
                        className="font-bold"
                        style={inputStyle}
                      />
                      {needsPo && (
                        <div style={{ fontSize: 12, color: "#B45309", marginTop: 6 }}>
                          This payer usually requires a PO — consider adding one
                          before billing.
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
              {service.createdAt && (
                <div style={{ fontSize: 12, color: D.muted, marginTop: 14 }}>
                  Booked on {new Date(service.createdAt).toLocaleString()}
                </div>
              )}
            </section>{" "}
          </main>{" "}
        </div>{" "}
      </div>{" "}
    </div>,
    document.body,
  );
}

/* ── Reschedule Modal ─────────────────────────────────── */

// =========================================================================
// PROTOCOL PANEL — shows all 5 protocol layers for a service
// =========================================================================
export function ProtocolPanel({ service, onClose }) {
  // Monochrome admin V2 palette — shadows the module-level D inside this panel
  // so the Service Protocol flyout matches the zinc admin shell instead of the
  // warmer legacy slate/teal/amber accents.
  const D = {
    bg: "#F4F4F5",
    card: "#FFFFFF",
    border: "#E4E4E7",
    input: "#FFFFFF",
    teal: "#18181B",
    green: "#52525B",
    amber: "#52525B",
    red: "#C8312F",
    blue: "#18181B",
    purple: "#52525B",
    gray: "#A1A1AA",
    text: "#3F3F46",
    muted: "#71717A",
    white: "#FFFFFF",
    heading: "#18181B",
    inputBorder: "#D4D4D8",
  };
  const [photos, setPhotos] = useState([]);
  const [seasonal, setSeasonal] = useState([]);
  const [scripts, setScripts] = useState([]);
  const [equipment, setEquipment] = useState([]);
  const [lawnProtocol, setLawnProtocol] = useState(null);
  const [lawnMix, setLawnMix] = useState(null);
  const [lawnContext, setLawnContext] = useState({
    trackKey: null,
    lawnSqft: null,
  });
  const [serviceProtocol, setServiceProtocol] = useState(null);
  const [matchedProtocolVisit, setMatchedProtocolVisit] = useState(null);
  const [protocolMatchReason, setProtocolMatchReason] = useState(null);
  const [productLabels, setProductLabels] = useState([]);
  const [loading, setLoading] = useState(true);
  const serviceCategory = detectServiceCategory(service.serviceType);
  const isLawn = serviceCategory === "lawn";
  const [activeSection, setActiveSection] = useState(
    isLawn ? "lawn_protocol" : "overview",
  );

  useEffect(() => {
    setActiveSection(isLawn ? "lawn_protocol" : "overview");
  }, [service?.id, isLawn]);

  useEffect(() => {
    let cancelled = false;
    const line = serviceCategory;
    const protocolProgram =
      line === "tree_shrub" ||
      line === "termite" ||
      line === "pest" ||
      line === "mosquito"
        ? line
        : null;
    const month = new Date().getMonth() + 1;

    setLoading(true);
    setLawnProtocol(null);
    setLawnMix(null);
    setLawnContext({ trackKey: null, lawnSqft: null });
    setServiceProtocol(null);
    setMatchedProtocolVisit(null);
    setProtocolMatchReason(null);

    (async () => {
      const profileResponse =
        isLawn && service.customerId
          ? await adminFetch(
              `/admin/customers/${service.customerId}/turf-profile`,
            ).catch(() => null)
          : null;
      const profile = profileResponse?.profile || null;
      const trackKey = isLawn
        ? [
            profile?.track_key,
            profile?.grass_type,
            service.lawnType,
            service.lawn_type,
          ]
            .map(protocolTrackForLawnType)
            .find(Boolean) || null
        : null;
      const lawnSqft = isLawn
        ? lawnAreaForProtocol({
            lawnSqft: profile?.lawn_sqft ?? service.lawnSqft,
            lawn_sqft: profile?.lawn_sqft ?? service.lawn_sqft,
          })
        : null;

      const [p, s, sc, eq, lp, lm, sp] = await Promise.all([
        adminFetch(
          `/admin/protocols/photos/relevant?serviceType=${encodeURIComponent(service.serviceType)}&month=${month}`,
        ),
        adminFetch(
          `/admin/protocols/seasonal-index?month=${month}&service_line=${line}`,
        ),
        adminFetch(`/admin/protocols/scripts?service_line=${line}`),
        adminFetch(`/admin/protocols/equipment?service_line=${line}`),
        isLawn && trackKey
          ? adminFetch(`/admin/protocols/programs?track=${trackKey}`)
          : Promise.resolve(null),
        isLawn && trackKey && lawnSqft
          ? adminFetch(
              `/admin/protocols/lawn-mix?track=${trackKey}&month=${month}&lawnSqft=${encodeURIComponent(lawnSqft)}`,
            )
          : Promise.resolve(null),
        !isLawn && protocolProgram
          ? adminFetch(
              `/admin/protocols/match?serviceType=${encodeURIComponent(service.serviceType)}`,
            )
          : Promise.resolve(null),
      ]);

      if (cancelled) return;
      setPhotos(p.photos || []);
      setSeasonal(s.pests || []);
      setScripts(sc.scripts || []);
      setEquipment(eq.checklists || []);
      setLawnProtocol(lp?.track || null);
      setLawnMix(lm || null);
      setLawnContext({ trackKey, lawnSqft });
      setServiceProtocol(sp?.program || null);
      setMatchedProtocolVisit(sp?.matchedVisit || null);
      setProtocolMatchReason(sp?.reason || null);
      setLoading(false);
    })().catch(() => {
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [service, isLawn, serviceCategory]);

  const SECTIONS = [
    ...(isLawn
      ? [
          {
            id: "lawn_protocol",
            label: " Lawn Protocol",
            count: lawnProtocol?.visits?.length || null,
          },
        ]
      : []),
    ...(!isLawn && serviceProtocol
      ? [
          {
            id: "service_protocol",
            label: " Protocol",
            count: matchedProtocolVisit
              ? 1
              : serviceProtocol?.visits?.length || null,
          },
        ]
      : []),
    { id: "overview", label: " Overview", count: null },
    { id: "seasonal", label: " Pest Pressure", count: seasonal.length },
    { id: "photos", label: " ID Guide", count: photos.length },
    { id: "scripts", label: " Scripts", count: scripts.length },
    { id: "equipment", label: " Equipment", count: equipment.length },
  ];

  // Pest pressure stays ordinal but monochrome — peak gets alert-fg because
  // it's a genuine "act now" signal; the rest step down a zinc ramp.
  const pressureColors = {
    peak: "#C8312F",
    high: "#18181B",
    moderate: "#52525B",
    low: "#71717A",
    dormant: "#A1A1AA",
  };

  return (
    <div
      style={{
        position: "fixed",
        top: 0,
        right: 0,
        width: isMobile ? "100%" : "60%",
        maxWidth: isMobile ? "100%" : 600,
        minWidth: isMobile ? 0 : 380,
        height: "100vh",
        background: D.card,
        borderLeft: isMobile ? "none" : `1px solid ${D.border}`,
        zIndex: 1000,
        display: "flex",
        flexDirection: "column",
        boxShadow: "-8px 0 32px rgba(0,0,0,0.3)",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 20px",
          borderBottom: `1px solid ${D.border}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        {" "}
        <div>
          {" "}
          <div style={{ fontSize: 16, fontWeight: 700, color: D.heading }}>
            Service Protocol
          </div>{" "}
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
            {service.serviceType} — {service.customerName}
          </div>{" "}
        </div>{" "}
        <button
          onClick={onClose}
          style={{
            background: "none",
            border: "none",
            color: D.muted,
            fontSize: 20,
            cursor: "pointer",
          }}
        >
          ×
        </button>{" "}
      </div>
      {/* Section tabs */}
      <div
        style={{
          display: "flex",
          gap: 16,
          padding: "0 16px",
          borderBottom: `1px solid ${D.border}`,
          overflowX: "auto",
          WebkitOverflowScrolling: "touch",
          flexWrap: "nowrap",
        }}
      >
        {SECTIONS.map((s) => {
          const active = activeSection === s.id;
          return (
            <button
              key={s.id}
              onClick={() => setActiveSection(s.id)}
              style={{
                padding: "12px 2px",
                marginBottom: -1,
                background: "transparent",
                border: "none",
                borderBottom: `2px solid ${active ? D.heading : "transparent"}`,
                cursor: "pointer",
                whiteSpace: "nowrap",
                fontSize: 11,
                fontWeight: 500,
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                flexShrink: 0,
                minHeight: 44,
                color: active ? D.heading : D.muted,
              }}
            >
              {s.label.trim()}
              {s.count !== null ? ` (${s.count})` : ""}
            </button>
          );
        })}
      </div>
      {/* Content */}
      <div style={{ flex: 1, overflowY: "auto", padding: "16px 20px" }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: "center", color: D.muted }}>
            Loading protocol...
          </div>
        ) : (
          <>
            {/* LAWN PROTOCOL */}
            {activeSection === "lawn_protocol" && isLawn && (
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: D.heading,
                    marginBottom: 4,
                  }}
                >
                  {lawnProtocol?.name || "Lawn Protocol"}
                </div>{" "}
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>
                  Current month products, mix math, tank calibration, and full
                  annual calendar
                </div>
                {!lawnContext.trackKey ? (
                  <div
                    style={{
                      color: D.muted,
                      fontSize: 13,
                      padding: 20,
                      textAlign: "center",
                    }}
                  >
                    Set the customer turf type to St. Augustine, Bermuda,
                    Zoysia, or Bahia to show the correct protocol.
                  </div>
                ) : !lawnProtocol ? (
                  <div
                    style={{
                      color: D.muted,
                      fontSize: 13,
                      padding: 20,
                      textAlign: "center",
                    }}
                  >
                    Lawn protocol unavailable
                  </div>
                ) : (
                  <>
                    {" "}
                    <div
                      style={{
                        background: D.bg,
                        borderRadius: 10,
                        padding: 14,
                        border: `1px solid ${D.border}`,
                        marginBottom: 12,
                      }}
                    >
                      {" "}
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 800,
                          color: D.heading,
                          marginBottom: 6,
                        }}
                      >
                        {lawnProtocol.name}
                      </div>
                      {(lawnProtocol.notes || []).slice(0, 5).map((note, i) => (
                        <div
                          key={i}
                          style={{
                            fontSize: 11,
                            color: note.startsWith("") ? D.red : D.text,
                            lineHeight: 1.45,
                            marginBottom: 4,
                          }}
                        >
                          {note}
                        </div>
                      ))}
                    </div>
                    {!lawnContext.lawnSqft && (
                      <div
                        style={{
                          background: D.bg,
                          borderRadius: 10,
                          padding: 12,
                          border: `1px solid ${D.border}`,
                          color: D.text,
                          fontSize: 12,
                          lineHeight: 1.45,
                          marginBottom: 12,
                        }}
                      >
                        Mix quantities are withheld because this customer does
                        not have measured lawn sqft in the turf profile. Set
                        lawn sqft before using product amounts.
                      </div>
                    )}
                    {lawnMix && (
                      <div
                        style={{
                          background: D.bg,
                          borderRadius: 10,
                          padding: 14,
                          border: `1px solid ${D.border}`,
                          marginBottom: 12,
                        }}
                      >
                        {" "}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                            alignItems: "flex-start",
                            marginBottom: 10,
                          }}
                        >
                          {" "}
                          <div>
                            {" "}
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 800,
                                color: D.teal,
                                textTransform: "uppercase",
                                letterSpacing: 0.6,
                              }}
                            >
                              Visit {lawnMix.visit?.visit} — {lawnMix.month}
                            </div>{" "}
                            <div
                              style={{
                                fontSize: 11,
                                color: D.muted,
                                marginTop: 2,
                              }}
                            >
                              {lawnMix.equipment?.systemName ||
                                "No calibrated rig"}{" "}
                              ·{" "}
                              {fmtProtocolNumber(
                                lawnMix.equipment?.carrierGalPer1000,
                                " gal/1K",
                              )}{" "}
                              carrier
                            </div>{" "}
                          </div>{" "}
                          <div
                            style={{
                              textAlign: "right",
                              fontSize: 11,
                              color: D.muted,
                            }}
                          >
                            {" "}
                            <div>
                              {fmtProtocolNumber(lawnMix.areaSqft, " sq ft")}
                            </div>{" "}
                            <div>
                              {fmtProtocolNumber(
                                lawnMix.equipment?.tankCoverageSqft,
                                " sq ft/tank",
                              )}
                            </div>{" "}
                          </div>{" "}
                        </div>
                        {(lawnMix.warnings || []).map((w) => (
                          <div
                            key={w.code}
                            style={{
                              fontSize: 11,
                              color: D.red,
                              marginBottom: 6,
                            }}
                          >
                            {" "}
                            <strong>{w.code.replace(/_/g, " ")}:</strong>
                            {w.message}
                          </div>
                        ))}
                        {(lawnMix.items || []).map((item, i) => (
                          <div
                            key={`${i}-${item.raw}`}
                            style={{
                              padding: "9px 0",
                              borderTop:
                                i === 0 ? "none" : `1px solid ${D.border}`,
                            }}
                          >
                            {" "}
                            <div
                              style={{
                                display: "flex",
                                justifyContent: "space-between",
                                gap: 10,
                              }}
                            >
                              {" "}
                              <div style={{ minWidth: 0 }}>
                                {" "}
                                <div
                                  style={{
                                    fontSize: 12,
                                    fontWeight: 700,
                                    color: D.heading,
                                  }}
                                >
                                  {item.product?.name || item.raw}
                                </div>{" "}
                                <div
                                  style={{
                                    fontSize: 10,
                                    color: D.muted,
                                    lineHeight: 1.4,
                                  }}
                                >
                                  {item.raw}
                                </div>{" "}
                              </div>{" "}
                              <div
                                style={{
                                  fontSize: 11,
                                  color: D.text,
                                  textAlign: "right",
                                  flexShrink: 0,
                                }}
                              >
                                {" "}
                                <div>
                                  {fmtProtocolNumber(item.jobMix?.amount)}{" "}
                                  {item.jobMix?.amountUnit || ""}
                                </div>{" "}
                                <div style={{ color: D.muted }}>
                                  {fmtProtocolNumber(item.fullTankMix?.amount)}{" "}
                                  {item.fullTankMix?.amountUnit || ""}/tank
                                </div>{" "}
                              </div>{" "}
                            </div>{" "}
                          </div>
                        ))}
                        {lawnMix.mixingOrder?.length > 0 && (
                          <div
                            style={{
                              marginTop: 10,
                              paddingTop: 10,
                              borderTop: `1px solid ${D.border}`,
                            }}
                          >
                            {" "}
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 800,
                                color: D.muted,
                                textTransform: "uppercase",
                                letterSpacing: 0.6,
                                marginBottom: 6,
                              }}
                            >
                              Mixing Order
                            </div>
                            {lawnMix.mixingOrder.map((step) => (
                              <div
                                key={`${step.step}-${step.productId}`}
                                style={{
                                  fontSize: 11,
                                  color: D.text,
                                  marginBottom: 3,
                                }}
                              >
                                {" "}
                                <strong>
                                  {step.step}. {step.productName}
                                </strong>
                                {step.instruction && (
                                  <div
                                    style={{ color: D.muted, marginLeft: 14 }}
                                  >
                                    {step.instruction}
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 800,
                        color: D.heading,
                        marginBottom: 8,
                      }}
                    >
                      Annual Protocol Calendar
                    </div>
                    {(lawnProtocol.visits || []).map((v) => (
                      <div
                        key={v.visit}
                        style={{
                          background: D.bg,
                          borderRadius: 10,
                          padding: 12,
                          border: `1px solid ${D.border}`,
                          marginBottom: 8,
                        }}
                      >
                        {" "}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                            marginBottom: 6,
                          }}
                        >
                          {" "}
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 800,
                              color: D.heading,
                            }}
                          >
                            Visit {v.visit} · {v.month}
                          </div>{" "}
                          <div style={{ fontSize: 11, color: D.muted }}>
                            Legacy mat: ${v.material_cost || "—"}
                          </div>{" "}
                        </div>{" "}
                        <div
                          style={{
                            fontSize: 11,
                            color: D.text,
                            whiteSpace: "pre-wrap",
                            lineHeight: 1.45,
                          }}
                        >
                          {v.primary}
                        </div>
                        {v.secondary && (
                          <div
                            style={{
                              fontSize: 11,
                              color: D.muted,
                              whiteSpace: "pre-wrap",
                              lineHeight: 1.45,
                              marginTop: 6,
                            }}
                          >
                            {v.secondary}
                          </div>
                        )}
                        {stripLegacyBoilerplate(v.notes) && (
                          <div
                            style={{
                              fontSize: 10,
                              color: D.muted,
                              lineHeight: 1.4,
                              marginTop: 6,
                              paddingTop: 6,
                              borderTop: `1px solid ${D.border}`,
                            }}
                          >
                            {stripLegacyBoilerplate(v.notes)}
                          </div>
                        )}
                      </div>
                    ))}
                  </>
                )}
              </div>
            )}

            {/* SERVICE PROTOCOL */}
            {activeSection === "service_protocol" &&
              !isLawn &&
              serviceProtocol && (
                <div>
                  {" "}
                  <div
                    style={{
                      fontSize: 14,
                      fontWeight: 700,
                      color: D.heading,
                      marginBottom: 4,
                    }}
                  >
                    {serviceProtocol.name}
                  </div>{" "}
                  <div
                    style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}
                  >
                    Best matching template first, with the full service-line
                    protocol available below.
                  </div>
                  {(serviceProtocol.notes || []).map((note, i) => (
                    <div
                      key={i}
                      style={{
                        background: D.bg,
                        borderRadius: 8,
                        padding: 10,
                        border: `1px solid ${D.border}`,
                        color: D.text,
                        fontSize: 11,
                        lineHeight: 1.45,
                        marginBottom: 8,
                      }}
                    >
                      {note}
                    </div>
                  ))}
                  {matchedProtocolVisit && (
                    <div
                      style={{
                        background: D.bg,
                        borderRadius: 10,
                        padding: 12,
                        border: `2px solid ${D.teal}`,
                        marginBottom: 12,
                      }}
                    >
                      {" "}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 10,
                          marginBottom: 8,
                        }}
                      >
                        {" "}
                        <div>
                          {" "}
                          <div
                            style={{
                              fontSize: 10,
                              fontWeight: 800,
                              color: D.teal,
                              textTransform: "uppercase",
                              letterSpacing: 0.6,
                              marginBottom: 3,
                            }}
                          >
                            Matched Template
                          </div>{" "}
                          <div
                            style={{
                              fontSize: 12,
                              fontWeight: 800,
                              color: D.heading,
                            }}
                          >
                            Template {matchedProtocolVisit.visit} ·{" "}
                            {matchedProtocolVisit.month}
                          </div>{" "}
                          <div
                            style={{
                              fontSize: 10,
                              color: D.muted,
                              marginTop: 2,
                            }}
                          >
                            {matchedProtocolVisit.notes ||
                              protocolMatchReason ||
                              "Best match for this service"}
                          </div>{" "}
                        </div>{" "}
                        <div
                          style={{
                            textAlign: "right",
                            fontSize: 10,
                            color: D.muted,
                            flexShrink: 0,
                          }}
                        >
                          {" "}
                          <div>
                            Legacy Mat:{" "}
                            {matchedProtocolVisit.material_cost || "inventory"}
                          </div>{" "}
                          <div>
                            Labor:{" "}
                            {matchedProtocolVisit.labor_cost || "standard"}
                          </div>{" "}
                        </div>{" "}
                      </div>{" "}
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 800,
                          color: D.teal,
                          textTransform: "uppercase",
                          letterSpacing: 0.5,
                          marginBottom: 4,
                        }}
                      >
                        Primary
                      </div>{" "}
                      <div
                        style={{
                          fontSize: 11,
                          color: D.text,
                          whiteSpace: "pre-wrap",
                          lineHeight: 1.45,
                        }}
                      >
                        {matchedProtocolVisit.primary}
                      </div>
                      {matchedProtocolVisit.secondary && (
                        <>
                          {" "}
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 800,
                              color: D.muted,
                              textTransform: "uppercase",
                              letterSpacing: 0.5,
                              marginTop: 10,
                              marginBottom: 4,
                            }}
                          >
                            Conditional / Follow-up
                          </div>{" "}
                          <div
                            style={{
                              fontSize: 11,
                              color: D.muted,
                              whiteSpace: "pre-wrap",
                              lineHeight: 1.45,
                            }}
                          >
                            {matchedProtocolVisit.secondary}
                          </div>{" "}
                        </>
                      )}
                    </div>
                  )}
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 800,
                      color: D.muted,
                      textTransform: "uppercase",
                      letterSpacing: 0.6,
                      margin: "12px 0 8px",
                    }}
                  >
                    Full Program
                  </div>
                  {(serviceProtocol.visits || [])
                    .filter(
                      (v) =>
                        Number(v.visit) !== Number(matchedProtocolVisit?.visit),
                    )
                    .map((v) => (
                      <div
                        key={v.visit}
                        style={{
                          background: D.bg,
                          borderRadius: 10,
                          padding: 12,
                          border: `1px solid ${D.border}`,
                          marginBottom: 10,
                        }}
                      >
                        {" "}
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            gap: 10,
                            marginBottom: 8,
                          }}
                        >
                          {" "}
                          <div>
                            {" "}
                            <div
                              style={{
                                fontSize: 12,
                                fontWeight: 800,
                                color: D.heading,
                              }}
                            >
                              Template {v.visit} · {v.month}
                            </div>{" "}
                            <div
                              style={{
                                fontSize: 10,
                                color: D.muted,
                                marginTop: 2,
                              }}
                            >
                              {v.notes || "Standard service workflow"}
                            </div>{" "}
                          </div>{" "}
                          <div
                            style={{
                              textAlign: "right",
                              fontSize: 10,
                              color: D.muted,
                              flexShrink: 0,
                            }}
                          >
                            {" "}
                            <div>
                              Legacy Mat: {v.material_cost || "inventory"}
                            </div>{" "}
                            <div>Labor: {v.labor_cost || "standard"}</div>{" "}
                          </div>{" "}
                        </div>{" "}
                        <div
                          style={{
                            fontSize: 11,
                            fontWeight: 800,
                            color: D.teal,
                            textTransform: "uppercase",
                            letterSpacing: 0.5,
                            marginBottom: 4,
                          }}
                        >
                          Primary
                        </div>{" "}
                        <div
                          style={{
                            fontSize: 11,
                            color: D.text,
                            whiteSpace: "pre-wrap",
                            lineHeight: 1.45,
                          }}
                        >
                          {v.primary}
                        </div>
                        {v.secondary && (
                          <>
                            {" "}
                            <div
                              style={{
                                fontSize: 11,
                                fontWeight: 800,
                                color: D.muted,
                                textTransform: "uppercase",
                                letterSpacing: 0.5,
                                marginTop: 10,
                                marginBottom: 4,
                              }}
                            >
                              Conditional / Follow-up
                            </div>{" "}
                            <div
                              style={{
                                fontSize: 11,
                                color: D.muted,
                                whiteSpace: "pre-wrap",
                                lineHeight: 1.45,
                              }}
                            >
                              {v.secondary}
                            </div>{" "}
                          </>
                        )}
                      </div>
                    ))}
                </div>
              )}

            {/* OVERVIEW */}
            {activeSection === "overview" && (
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: D.heading,
                    marginBottom: 12,
                  }}
                >
                  Service Overview
                </div>{" "}
                <div
                  style={{
                    background: D.bg,
                    borderRadius: 10,
                    padding: 14,
                    border: `1px solid ${D.border}`,
                    marginBottom: 12,
                  }}
                >
                  {" "}
                  <div
                    style={{ fontSize: 13, color: D.heading, fontWeight: 600 }}
                  >
                    {service.serviceType}
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
                    {service.customerName} — {service.address}
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
                    Est. duration: {service.estimatedDuration || 30} min
                  </div>
                  {service.lawnType && (
                    <div style={{ fontSize: 12, color: D.teal, marginTop: 2 }}>
                      {service.lawnType} —{" "}
                      {service.lotSqft?.toLocaleString() || "?"} sf lot
                    </div>
                  )}
                </div>
                {/* Quick stats */}
                <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
                  {" "}
                  <div
                    style={{
                      flex: 1,
                      background: D.bg,
                      borderRadius: 8,
                      padding: 10,
                      border: `1px solid ${D.border}`,
                      textAlign: "center",
                    }}
                  >
                    {" "}
                    <div
                      style={{ fontSize: 18, fontWeight: 700, color: D.heading }}
                    >
                      {seasonal.length}
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 9,
                        color: D.muted,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      Active Pests
                    </div>{" "}
                  </div>{" "}
                  <div
                    style={{
                      flex: 1,
                      background: D.bg,
                      borderRadius: 8,
                      padding: 10,
                      border: `1px solid ${D.border}`,
                      textAlign: "center",
                    }}
                  >
                    {" "}
                    <div
                      style={{ fontSize: 18, fontWeight: 700, color: D.heading }}
                    >
                      {photos.length}
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 9,
                        color: D.muted,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      ID Refs
                    </div>{" "}
                  </div>{" "}
                  <div
                    style={{
                      flex: 1,
                      background: D.bg,
                      borderRadius: 8,
                      padding: 10,
                      border: `1px solid ${D.border}`,
                      textAlign: "center",
                    }}
                  >
                    {" "}
                    <div
                      style={{ fontSize: 18, fontWeight: 700, color: D.heading }}
                    >
                      {scripts.length}
                    </div>{" "}
                    <div
                      style={{
                        fontSize: 9,
                        color: D.muted,
                        textTransform: "uppercase",
                        letterSpacing: 0.5,
                      }}
                    >
                      Scripts
                    </div>{" "}
                  </div>{" "}
                </div>
                {/* Property alerts */}
                {service.propertyAlerts?.length > 0 && (
                  <div style={{ marginBottom: 12 }}>
                    {" "}
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        color: D.heading,
                        marginBottom: 6,
                      }}
                    >
                      Property Alerts
                    </div>
                    {service.propertyAlerts.map((a, i) => (
                      <div
                        key={i}
                        style={{
                          fontSize: 12,
                          color: a.type === "chemical" ? D.red : D.text,
                          marginBottom: 3,
                          paddingLeft: 8,
                          borderLeft: `2px solid ${a.type === "chemical" ? D.red : D.heading}`,
                        }}
                      >
                        {a.text}
                      </div>
                    ))}
                  </div>
                )}
                {/* Last service notes */}
                {service.lastServiceNotes &&
                  stripLegacyBoilerplate(service.lastServiceNotes) && (
                    <div
                      style={{
                        background: D.bg,
                        borderRadius: 10,
                        padding: 12,
                        border: `1px solid ${D.border}`,
                      }}
                    >
                      {" "}
                      <div
                        style={{
                          fontSize: 11,
                          fontWeight: 700,
                          color: D.muted,
                          textTransform: "uppercase",
                          letterSpacing: 0.5,
                          marginBottom: 4,
                        }}
                      >
                        Last Visit Notes
                      </div>{" "}
                      <div
                        style={{ fontSize: 12, color: D.text, lineHeight: 1.5 }}
                      >
                        {stripLegacyBoilerplate(service.lastServiceNotes)}
                      </div>{" "}
                    </div>
                  )}
              </div>
            )}

            {/* SEASONAL PEST PRESSURE */}
            {activeSection === "seasonal" && (
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: D.heading,
                    marginBottom: 4,
                  }}
                >
                  This Month in SWFL
                </div>{" "}
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>
                  What to look for and how to respond
                </div>
                {seasonal.length === 0 ? (
                  <div
                    style={{
                      color: D.muted,
                      fontSize: 13,
                      padding: 20,
                      textAlign: "center",
                    }}
                  >
                    No seasonal data for this service line
                  </div>
                ) : (
                  seasonal.map((p, i) => (
                    <div
                      key={i}
                      style={{
                        background: D.bg,
                        borderRadius: 10,
                        padding: 14,
                        border: `1px solid ${D.border}`,
                        marginBottom: 8,
                        borderLeft: `3px solid ${pressureColors[p.pressure_level] || D.gray}`,
                      }}
                    >
                      {" "}
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          marginBottom: 4,
                        }}
                      >
                        {" "}
                        <span
                          style={{
                            fontSize: 13,
                            fontWeight: 600,
                            color: D.heading,
                          }}
                        >
                          {p.pest_name}
                        </span>{" "}
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            textTransform: "uppercase",
                            padding: "2px 8px",
                            borderRadius: 8,
                            background: `${pressureColors[p.pressure_level]}22`,
                            color: pressureColors[p.pressure_level],
                          }}
                        >
                          {p.pressure_level}
                        </span>{" "}
                      </div>{" "}
                      <div
                        style={{
                          fontSize: 12,
                          color: D.muted,
                          lineHeight: 1.5,
                        }}
                      >
                        {p.description}
                      </div>
                      {p.treatment_if_found && (
                        <div
                          style={{
                            fontSize: 11,
                            color: D.teal,
                            marginTop: 6,
                            paddingTop: 6,
                            borderTop: `1px solid ${D.border}`,
                          }}
                        >
                          {" "}
                          <strong>If found:</strong>
                          {p.treatment_if_found}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* PHOTO ID GUIDE */}
            {activeSection === "photos" && (
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: D.heading,
                    marginBottom: 4,
                  }}
                >
                  Identification References
                </div>{" "}
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>
                  Visual ID guides for this service type
                </div>
                {photos.length === 0 ? (
                  <div
                    style={{
                      color: D.muted,
                      fontSize: 13,
                      padding: 20,
                      textAlign: "center",
                    }}
                  >
                    No photo references for this service
                  </div>
                ) : (
                  photos.map((p, i) => (
                    <div
                      key={i}
                      style={{
                        background: D.bg,
                        borderRadius: 10,
                        padding: 14,
                        border: `1px solid ${D.border}`,
                        marginBottom: 8,
                      }}
                    >
                      {" "}
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: D.teal,
                          marginBottom: 6,
                        }}
                      >
                        {p.name}
                      </div>{" "}
                      <div
                        style={{
                          fontSize: 12,
                          color: D.text,
                          lineHeight: 1.6,
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {p.description}
                      </div>
                      {p.photoUrl && (
                        <img
                          src={p.photoUrl}
                          alt={p.name}
                          style={{
                            width: "100%",
                            borderRadius: 8,
                            marginTop: 8,
                          }}
                        />
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* COMMUNICATION SCRIPTS */}
            {activeSection === "scripts" && (
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: D.heading,
                    marginBottom: 4,
                  }}
                >
                  Customer Communication Scripts
                </div>{" "}
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>
                  What to say on the property
                </div>
                {scripts.length === 0 ? (
                  <div
                    style={{
                      color: D.muted,
                      fontSize: 13,
                      padding: 20,
                      textAlign: "center",
                    }}
                  >
                    No scripts for this service line
                  </div>
                ) : (
                  scripts.map((s, i) => (
                    <div
                      key={i}
                      style={{
                        background: D.bg,
                        borderRadius: 10,
                        padding: 14,
                        border: `1px solid ${D.border}`,
                        marginBottom: 8,
                      }}
                    >
                      {" "}
                      <div
                        style={{
                          fontSize: 13,
                          fontWeight: 700,
                          color: D.heading,
                          marginBottom: 6,
                        }}
                      >
                        {s.title}
                      </div>{" "}
                      <div
                        style={{
                          fontSize: 12,
                          color: D.text,
                          lineHeight: 1.6,
                          whiteSpace: "pre-wrap",
                        }}
                      >
                        {s.script}
                      </div>
                      {s.tone_notes && (
                        <div
                          style={{
                            fontSize: 11,
                            color: D.amber,
                            marginTop: 8,
                            fontStyle: "italic",
                          }}
                        >
                          {s.tone_notes}
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
            )}

            {/* EQUIPMENT CHECKLIST */}
            {activeSection === "equipment" && (
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 14,
                    fontWeight: 700,
                    color: D.heading,
                    marginBottom: 4,
                  }}
                >
                  Equipment Checklist
                </div>{" "}
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 12 }}>
                  What to grab before this service
                </div>
                {equipment.length === 0 ? (
                  <div
                    style={{
                      color: D.muted,
                      fontSize: 13,
                      padding: 20,
                      textAlign: "center",
                    }}
                  >
                    No checklist for this service type
                  </div>
                ) : (
                  equipment.map((checklist, ci) => (
                    <div key={ci}>
                      {" "}
                      <div
                        style={{
                          fontSize: 12,
                          fontWeight: 700,
                          color: D.teal,
                          marginBottom: 8,
                        }}
                      >
                        {checklist.service_type || checklist.serviceType}
                      </div>
                      {(
                        checklist.checklist_items ||
                        checklist.checklistItems ||
                        []
                      ).map((cat, cati) => (
                        <div key={cati} style={{ marginBottom: 12 }}>
                          {" "}
                          <div
                            style={{
                              fontSize: 11,
                              fontWeight: 700,
                              color: D.amber,
                              textTransform: "uppercase",
                              letterSpacing: 0.8,
                              marginBottom: 6,
                            }}
                          >
                            {cat.category}
                          </div>
                          {(cat.items || []).map((item, ii) => (
                            <div
                              key={ii}
                              style={{
                                display: "flex",
                                gap: 8,
                                alignItems: "flex-start",
                                marginBottom: 4,
                              }}
                            >
                              {" "}
                              <span
                                style={{
                                  fontSize: 14,
                                  color: item.required ? D.green : D.muted,
                                  flexShrink: 0,
                                }}
                              >
                                {item.required ? "" : "○"}
                              </span>{" "}
                              <div>
                                {" "}
                                <div style={{ fontSize: 12, color: D.text }}>
                                  {item.item}
                                </div>
                                {item.note && (
                                  <div
                                    style={{
                                      fontSize: 10,
                                      color: D.muted,
                                      marginTop: 1,
                                    }}
                                  >
                                    {item.note}
                                  </div>
                                )}
                              </div>{" "}
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                  ))
                )}
              </div>
            )}
          </>
        )}
      </div>{" "}
    </div>
  );
}

export function RescheduleModal({ service, onClose, onRescheduled }) {
  const [options, setOptions] = useState([]);
  const [reason, setReason] = useState("customer_request");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [manualDate, setManualDate] = useState("");
  const [manualTime, setManualTime] = useState("08:00");

  useEffect(() => {
    adminFetch(`/admin/dispatch/${service.id}/reschedule-options`)
      .then((d) => {
        setOptions(d.options || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [service.id]);

  const handleReschedule = async (opt) => {
    setSending(true);
    try {
      const result = await adminFetch(
        `/admin/dispatch/${service.id}/reschedule`,
        {
          method: "POST",
          body: JSON.stringify({
            newDate: opt.date,
            newWindow: opt.suggestedWindow,
            reasonCode: reason,
            reasonText: notes,
            notifyCustomer: true,
          }),
        },
      );
      if (result?.notificationSent === false) {
        alert(
          `Appointment moved, but SMS notification failed: ${result.notificationError || "customer was not notified"}`,
        );
      }
      onRescheduled?.();
      onClose();
    } catch (e) {
      console.error(e);
    }
    setSending(false);
  };

  const handleManualReschedule = async () => {
    if (!manualDate) return;
    setSending(true);
    const [h, m] = manualTime.split(":");
    const endH = String(Math.min(23, parseInt(h) + 2)).padStart(2, "0");
    const window = {
      start: manualTime,
      end: `${endH}:${m}`,
      display: `${formatTimeDisplay(manualTime)} - ${formatTimeDisplay(`${endH}:${m}`)}`,
    };
    try {
      const result = await adminFetch(
        `/admin/dispatch/${service.id}/reschedule`,
        {
          method: "POST",
          body: JSON.stringify({
            newDate: manualDate,
            newWindow: window,
            reasonCode: reason,
            reasonText: notes,
            notifyCustomer: true,
          }),
        },
      );
      if (result?.notificationSent === false) {
        alert(
          `Appointment moved, but SMS notification failed: ${result.notificationError || "customer was not notified"}`,
        );
      }
      onRescheduled?.();
      onClose();
    } catch (e) {
      console.error(e);
    }
    setSending(false);
  };

  function formatTimeDisplay(t) {
    const [h, min] = t.split(":").map(Number);
    return `${h % 12 || 12}:${String(min).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`;
  }

  const REASONS = [
    { value: "weather_rain", label: "Weather — Rain" },
    { value: "weather_wind", label: "Weather — Wind" },
    { value: "customer_request", label: "Customer Request" },
    { value: "customer_noshow", label: "Customer No-Show" },
    { value: "gate_locked", label: "Gate Locked" },
    { value: "tech_callout", label: "Tech Unavailable" },
    { value: "route_overload", label: "Route Overload" },
  ];

  const inputSt = {
    width: "100%",
    padding: "10px 14px",
    borderRadius: 10,
    border: `1px solid ${D.border}`,
    background: D.input,
    color: D.heading,
    fontSize: 14,
    outline: "none",
    boxSizing: "border-box",
  };

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.6)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
      }}
    >
      {" "}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: D.card,
          borderRadius: 16,
          padding: 24,
          maxWidth: 480,
          width: "100%",
          border: `1px solid ${D.border}`,
          maxHeight: "80vh",
          overflowY: "auto",
        }}
      >
        {" "}
        <div
          style={{
            fontSize: 18,
            fontWeight: 700,
            color: D.heading,
            marginBottom: 4,
          }}
        >
          Reschedule Service
        </div>{" "}
        <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>
          {service.customerName} — {service.serviceType}
        </div>{" "}
        <div style={{ marginBottom: 14 }}>
          {" "}
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: D.muted,
              marginBottom: 6,
            }}
          >
            Reason
          </div>{" "}
          <select
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            style={inputSt}
          >
            {REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>{" "}
        </div>{" "}
        <div style={{ marginBottom: 14 }}>
          {" "}
          <div
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: D.muted,
              marginBottom: 6,
            }}
          >
            Notes (optional)
          </div>{" "}
          <input
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Additional context..."
            style={inputSt}
          />{" "}
        </div>{" "}
        <div
          style={{
            fontSize: 13,
            fontWeight: 700,
            color: D.teal,
            marginBottom: 10,
          }}
        >
          Suggested Dates (on route)
        </div>
        {loading ? (
          <div
            style={{
              color: D.muted,
              fontSize: 13,
              padding: 20,
              textAlign: "center",
            }}
          >
            Finding best dates...
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {options.map((opt, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  padding: "12px 14px",
                  borderRadius: 10,
                  background: D.bg,
                  border: `1px solid ${D.border}`,
                  cursor: "pointer",
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) =>
                  (e.currentTarget.style.borderColor = D.teal)
                }
                onMouseLeave={(e) =>
                  (e.currentTarget.style.borderColor = D.border)
                }
              >
                {" "}
                <div>
                  {" "}
                  <div
                    style={{ fontSize: 14, fontWeight: 600, color: D.heading }}
                  >
                    {opt.displayDate}
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted }}>
                    {opt.suggestedWindow?.display} · {opt.currentLoad} jobs ·{" "}
                    {opt.sameAreaServices} same area
                  </div>{" "}
                </div>{" "}
                <button
                  onClick={() => handleReschedule(opt)}
                  disabled={sending}
                  style={{
                    padding: "8px 14px",
                    borderRadius: 8,
                    border: "none",
                    cursor: "pointer",
                    background: D.teal,
                    color: "#fff",
                    fontSize: 12,
                    fontWeight: 600,
                    opacity: sending ? 0.6 : 1,
                  }}
                >
                  Select
                </button>{" "}
              </div>
            ))}
          </div>
        )}
        {/* Manual date/time picker */}
        <div
          style={{
            marginTop: 16,
            borderTop: `1px solid ${D.border}`,
            paddingTop: 14,
          }}
        >
          {" "}
          <button
            onClick={() => setShowManual(!showManual)}
            style={{
              background: "transparent",
              border: "none",
              color: D.teal,
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
              padding: 0,
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            {showManual ? "\u25BC" : "\u25B6"} Pick Custom Date & Time
          </button>
          {showManual && (
            <div style={{ marginTop: 12, display: "flex", gap: 10 }}>
              {" "}
              <div style={{ flex: 1 }}>
                {" "}
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
                  Date
                </div>{" "}
                <input
                  type="date"
                  value={manualDate}
                  onChange={(e) => setManualDate(e.target.value)}
                  style={inputSt}
                />{" "}
              </div>{" "}
              <div style={{ flex: 1 }}>
                {" "}
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 4 }}>
                  Start Time
                </div>{" "}
                <input
                  type="time"
                  value={manualTime}
                  onChange={(e) => setManualTime(e.target.value)}
                  style={inputSt}
                />{" "}
              </div>{" "}
              <div style={{ display: "flex", alignItems: "flex-end" }}>
                {" "}
                <button
                  onClick={handleManualReschedule}
                  disabled={sending || !manualDate}
                  style={{
                    padding: "10px 16px",
                    borderRadius: 10,
                    border: "none",
                    cursor: "pointer",
                    background: manualDate ? D.teal : D.border,
                    color: D.heading,
                    fontSize: 13,
                    fontWeight: 600,
                    opacity: sending ? 0.6 : 1,
                    whiteSpace: "nowrap",
                  }}
                >
                  Reschedule
                </button>{" "}
              </div>{" "}
            </div>
          )}
        </div>{" "}
        <button
          onClick={onClose}
          style={{
            width: "100%",
            marginTop: 14,
            padding: "10px 14px",
            borderRadius: 10,
            background: "transparent",
            border: `1px solid ${D.border}`,
            color: D.muted,
            fontSize: 13,
            cursor: "pointer",
          }}
        >
          Cancel
        </button>{" "}
      </div>{" "}
    </div>
  );
}

/* ── Completion Panel (slide-over) ────────────────────── */

// Module-scoped helpers for the mobile Complete sheet. Keeping these
// outside CompletionPanel is load-bearing: if they're defined inside the
// render, every keystroke creates new component identities and React
// unmounts/remounts the textarea, dropping focus after each word.
const CP_M = {
  card: "#FFFFFF",
  hairline: "#E5E5E5",
  ink: "#111111",
  ink4: "#A3A3A3",
  actionFg: "#FFFFFF",
};
const CP_FONT = "'Roboto', Arial, sans-serif";
const CP_EYEBROW = {
  display: "block",
  fontFamily: CP_FONT,
  fontSize: 11,
  fontWeight: 600,
  color: CP_M.ink4,
  textTransform: "uppercase",
  letterSpacing: "0.3px",
  marginBottom: 8,
};

function CPField({ label, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      {" "}
      <label style={CP_EYEBROW}>{label}</label>
      {children}
    </div>
  );
}

function CPChip({ selected, onClick, children, dot }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        height: 36,
        padding: "0 14px",
        borderRadius: 999,
        background: selected ? CP_M.ink : CP_M.card,
        color: selected ? CP_M.actionFg : CP_M.ink,
        border: `1px solid ${selected ? CP_M.ink : CP_M.hairline}`,
        fontFamily: CP_FONT,
        fontSize: 13,
        fontWeight: 500,
        cursor: "pointer",
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        whiteSpace: "nowrap",
      }}
    >
      {dot && (
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: dot,
            flexShrink: 0,
          }}
        />
      )}
      {children}
    </button>
  );
}

// Whether a typed findings field is required for the CURRENT values —
// static `required` plus the schema's conditional `requiredUnless`
// metadata ({ field, value }: required exactly when the named sibling
// field holds a non-empty value other than `value`). Mirrors the server's
// conditional enforcement so the tech gets the normal pre-submit prompt
// instead of a post-submit 422 (Codex P2).
export function typedFieldRequiredNow(field, values) {
  if (field?.required) return true;
  const rule = field?.requiredUnless;
  if (!rule?.field) return false;
  const driver = String(values?.[rule.field] ?? "").trim();
  return !!driver && driver !== rule.value;
}

// Mirrors the server's chips-vs-values rules (validateNextStepChips) so a
// conflicting chip is disabled in the panel and blocked pre-submit instead
// of failing with a post-submit 400 (Codex P3). Returns the conflict
// message for the chip under the current values, or null when selectable.
export function typedNextStepChipConflict(schemaType, chip, values) {
  if (schemaType === "flea" && chip === "No action needed") {
    const level = String(values?.evidence_level ?? "").trim();
    if (level && level !== "None observed") {
      return `"No action needed" conflicts with the recorded evidence level (${level})`;
    }
  }
  if (schemaType === "german_roach_knockdown") {
    const followupRequired = String(values?.followup_required ?? "").trim();
    const window = String(values?.followup_window ?? "").trim();
    const recommendsFollowup =
      chip === "Follow-up recommended" || chip === "Follow-up in 10–14 days";
    if (followupRequired === "No" && recommendsFollowup) {
      return `"${chip}" conflicts with "Follow-up required: No"`;
    }
    if (chip === "Follow-up in 10–14 days" && window && window !== "10–14 days") {
      return `"Follow-up in 10–14 days" conflicts with the selected follow-up window (${window})`;
    }
  }
  if (schemaType === "palmetto_roach_knockdown") {
    if (
      chip === "Follow-up recommended" &&
      String(values?.followup_needed ?? "").trim() === "No"
    ) {
      return `"Follow-up recommended" conflicts with "Follow-up needed: No"`;
    }
    if (chip === "No action needed") {
      const level = String(values?.activity_level ?? "").trim();
      if (level && level !== "None observed") {
        return `"No action needed" conflicts with the recorded activity level (${level})`;
      }
      if (String(values?.followup_needed ?? "").trim() === "Yes") {
        return `"No action needed" conflicts with "Follow-up needed: Yes"`;
      }
    }
  }
  return null;
}

// Mirrors the server's final-score vs findings cleared-boundary rule
// (validateActivityScoreConsistency / activity_score_inconsistent): a
// pinned nonzero score beside cleared evidence — or a pinned 0 beside
// positive evidence — would publish a headline that says the opposite of
// the findings card. Returns the conflict message or null.
const TYPED_SCORE_CLEARED_SELECT = {
  flea: { field: "evidence_level", cleared: "None observed" },
  german_roach_knockdown: { field: "activity_level", cleared: "None observed" },
  palmetto_roach_knockdown: { field: "activity_level", cleared: "None observed" },
};
export function typedActivityScoreConflict(schemaType, values, score) {
  if (score == null) return null;
  const rule = TYPED_SCORE_CLEARED_SELECT[schemaType];
  if (!rule) return null;
  const selected = String(values?.[rule.field] ?? "").trim();
  if (!selected) return null;
  if (selected === rule.cleared && score > 0) {
    return `Activity score ${score} conflicts with "${rule.cleared}" — set the score to 0 or update the recorded level`;
  }
  if (selected !== rule.cleared && score === 0) {
    return `Activity score 0 conflicts with the recorded level (${selected}) — select "${rule.cleared}" or use a nonzero score`;
  }
  return null;
}

// Prune draft-restored findings values to the CURRENT schema fields (shared
// by the primary and companion restores). Drafts saved before a schema
// cutover carry values the schema no longer accepts; submit sends the whole
// object and the server validation strands the draft. Key presence alone
// isn't enough — a field can keep its key while changing type (textarea →
// chips), so each restored value is validated against the field's CURRENT
// definition: chips keep only allowlisted tokens, selects must match an
// option, counts must be digit-only. Free-text fields keep anything.
// Mutates and returns `restored`.
function pruneRestoredFindingsValues(restored, fields) {
  const values = restored && typeof restored === "object" ? restored : {};
  if (!Array.isArray(fields)) return values;
  const fieldByKey = new Map(fields.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(values)) {
    const field = fieldByKey.get(key);
    if (!field) {
      delete values[key];
    } else if (field.type === "chips" && Array.isArray(field.options)) {
      const kept = String(raw || "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => field.options.includes(s));
      if (kept.length) values[key] = kept.join(", ");
      else delete values[key];
    } else if (
      field.type === "select" &&
      Array.isArray(field.options) &&
      field.options.length &&
      !field.options.includes(String(raw))
    ) {
      delete values[key];
    } else if (field.type === "count") {
      const str =
        typeof raw === "number"
          ? String(raw)
          : typeof raw === "string"
            ? raw.trim()
            : "";
      if (!/^\d{1,4}$/.test(str)) delete values[key];
    }
  }
  return values;
}

// Render-time fallback for a companion section with no state yet. Never
// mutated — every companion handler spreads into fresh objects.
const EMPTY_COMPANION_ENTRY = {
  values: {},
  chips: [],
  score: null,
  scoreTouched: false,
};

// Typed specialty completion form (specialty-service-completion-contract.md
// §3-§4, §7): registry-driven findings fields + activity gauge + next-step
// chips + optional AI-drafted recommendations. Shared by the mobile and
// desktop renders of CompletionPanel — `variant` only switches the
// palette/label chrome between the CP mobile tokens and the D palette.
function TypedFindingsSection({
  variant,
  schema,
  values,
  onFieldChange,
  activityScore,
  activityScoreTouched,
  onActivityTap,
  nextStepChips,
  onToggleChip,
  recommendations,
  onRecommendationsChange,
  aiDrafting,
  aiError,
  includeComms,
  onIncludeCommsChange,
  onAiDraft,
}) {
  const mobile = variant === "mobile";
  const labelCss = mobile ? CP_EYEBROW : labelStyle;
  const textColor = mobile ? CP_M.ink : D.text;
  const mutedColor = mobile ? CP_M.ink4 : D.muted;
  const cardBg = mobile ? CP_M.card : D.card;
  const hairline = mobile ? CP_M.hairline : D.border;
  const accent = mobile ? CP_M.ink : D.teal;
  const accentFg = mobile ? CP_M.actionFg : D.teal;
  const requiredColor = mobile ? "#C2410C" : D.red;
  const scoreLabels = schema.activity?.techScoreLabels || {};
  const fieldLabelStyle = {
    fontSize: 14,
    fontWeight: 600,
    color: textColor,
    marginBottom: 6,
  };
  const sectionHeaderStyle = {
    fontSize: 12,
    fontWeight: 700,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: mutedColor,
    margin: "16px 0 8px",
    paddingBottom: 4,
    borderBottom: `1px solid ${hairline}`,
  };
  return (
    <div style={{ marginBottom: 20 }}>
      {/* Companion sections (onRecommendationsChange null) label themselves
          by schema so stacked sections stay distinguishable. */}
      <label style={labelCss}>
        {onRecommendationsChange ? "Service findings" : schema.label || "Service findings"}
      </label>
      {(schema.fields || []).map((field, index) => (
        <div key={field.key} style={{ marginBottom: 12 }}>
          {/* Sectioned schemas (rodent trapping): header above the first
              field of each section so the checklist scans in groups. */}
          {field.section && field.section !== schema.fields[index - 1]?.section && (
            <div style={sectionHeaderStyle}>{field.section}</div>
          )}
          <div style={fieldLabelStyle}>
            {field.label}
            {typedFieldRequiredNow(field, values) && (
              <span style={{ color: requiredColor }}> *</span>
            )}
          </div>
          <ProjectFindingFieldInput
            field={field}
            id={`typed-finding-${schema.type}-${field.key}`}
            name={`structuredFindings.${field.key}`}
            value={values[field.key] || ""}
            onChange={(value) => onFieldChange(field.key, value)}
            inputStyle={{ width: "100%", boxSizing: "border-box" }}
          />
        </div>
      ))}
      {schema.activity && (
        <div style={{ marginBottom: 12 }}>
          <div style={fieldLabelStyle}>
            {schema.activity.label}
            <span style={{ color: requiredColor }}> *</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {[0, 1, 2, 3, 4, 5].map((n) => {
              const selected = activityScore === n;
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => onActivityTap(n)}
                  aria-pressed={selected}
                  aria-label={`${schema.activity.label}: ${scoreLabels[n] || n}`}
                  style={{
                    minWidth: 64,
                    height: 44,
                    padding: "0 10px",
                    borderRadius: 10,
                    background: selected
                      ? mobile
                        ? accent
                        : accent + "18"
                      : cardBg,
                    color: selected ? accentFg : textColor,
                    border: `1px solid ${selected ? accent : hairline}`,
                    fontSize: 14,
                    fontWeight: 600,
                    cursor: "pointer",
                  }}
                >
                  {scoreLabels[n] || n}
                </button>
              );
            })}
          </div>
          <div style={{ fontSize: 12, color: mutedColor, marginTop: 6 }}>
            {activityScoreTouched
              ? "Set by technician"
              : "Prefills from findings until you tap"}
          </div>
        </div>
      )}
      <div style={{ marginBottom: 12 }}>
        <div style={fieldLabelStyle}>
          Next steps (up to 4)
          {schema.nextStepRequired && (
            <span style={{ color: requiredColor }}> *</span>
          )}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {(schema.nextStepChips || []).map((chip) => {
            const selected = nextStepChips.includes(chip);
            // A chip that conflicts with the recorded findings is disabled
            // (server would reject it) — but a stale selection stays
            // tappable so the tech can deselect it after changing a value.
            const conflict = typedNextStepChipConflict(schema.type, chip, values);
            const disabled = !!conflict && !selected;
            return (
              <button
                key={chip}
                type="button"
                onClick={disabled ? undefined : () => onToggleChip(chip)}
                aria-pressed={selected}
                aria-disabled={disabled}
                disabled={disabled}
                title={conflict || undefined}
                style={{
                  height: 36,
                  padding: "0 14px",
                  borderRadius: 999,
                  background: selected
                    ? mobile
                      ? accent
                      : accent + "18"
                    : cardBg,
                  color: selected ? accentFg : textColor,
                  border: `1px solid ${selected ? accent : hairline}`,
                  fontSize: 14,
                  fontWeight: 500,
                  cursor: disabled ? "not-allowed" : "pointer",
                  opacity: disabled ? 0.45 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                {chip}
              </button>
            );
          })}
        </div>
      </div>
      {/* Recommendations textarea + AI draft stay PRIMARY-only: companion
          sections pass onRecommendationsChange={null} and are chips-first
          deterministic copy (combined-service-completions.md). */}
      {onRecommendationsChange && (
      <div style={{ marginBottom: 4 }}>
        <div style={fieldLabelStyle}>Recommendations (optional)</div>
        <textarea
          value={recommendations}
          onChange={(e) => onRecommendationsChange(e.target.value)}
          rows={3}
          placeholder="Optional customer-facing recommendations..."
          style={{
            width: "100%",
            background: cardBg,
            color: textColor,
            border: `1px solid ${hairline}`,
            borderRadius: 10,
            padding: 12,
            fontSize: 14,
            resize: "vertical",
            boxSizing: "border-box",
          }}
        />
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 12,
            marginTop: 8,
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            onClick={onAiDraft}
            disabled={aiDrafting}
            style={{
              height: 36,
              padding: "0 14px",
              borderRadius: 999,
              background: "transparent",
              color: accent,
              border: `1px solid ${accent}`,
              fontSize: 14,
              fontWeight: 600,
              cursor: aiDrafting ? "wait" : "pointer",
              opacity: aiDrafting ? 0.5 : 1,
            }}
          >
            {aiDrafting ? "Drafting..." : "AI draft"}
          </button>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 14,
              color: textColor,
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={includeComms}
              onChange={(e) => onIncludeCommsChange(e.target.checked)}
              style={{ width: 16, height: 16, accentColor: accent }}
            />
            Include recent customer calls/texts/emails
          </label>
        </div>
        {aiError && (
          <div style={{ fontSize: 12, color: requiredColor, marginTop: 6 }}>
            {aiError}
          </div>
        )}
      </div>
      )}
    </div>
  );
}

const LAWN_ASSESSMENT_METRICS = [
  { key: "turf_density", label: "Density" },
  { key: "weed_suppression", label: "Weeds" },
  { key: "color_health", label: "Color" },
  { key: "fungus_control", label: "Fungus" },
  { key: "thatch_level", label: "Thatch" },
];

const LAWN_STRESS_FLAGS = [
  { key: "drought_stress", label: "Dry / heat" },
  { key: "shade_stress", label: "Shade" },
  { key: "disease_suspicion", label: "Disease" },
  { key: "recent_scalp", label: "Scalp" },
  { key: "new_sod", label: "New sod" },
];

const EMPTY_LAWN_STRESS_FLAGS = Object.fromEntries(
  LAWN_STRESS_FLAGS.map((flag) => [flag.key, false]),
);

const EMPTY_PROTOCOL_FIELD_CHECKS = {
  thatchMeasurementIn: "",
  chinchFloatTestDone: false,
  chinchCountPerSqft: "",
  nematodeAssayFlag: false,
  soilKPpm: "",
  largePatchHistoryObserved: false,
  notes: "",
};

function lawnScoreColor(value) {
  const n = Number(value) || 0;
  if (n >= 75) return D.green;
  if (n >= 50) return D.amber;
  return D.red;
}

function resizeLawnAssessmentImage(dataUrl, maxEdge = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const longEdge = Math.max(img.width, img.height);
      if (longEdge <= maxEdge) return resolve(dataUrl);
      const scale = maxEdge / longEdge;
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => resolve(dataUrl);
    img.src = dataUrl;
  });
}

function readLawnAssessmentPhoto(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = async () => {
      const resized = await resizeLawnAssessmentImage(reader.result);
      resolve({
        data: resized,
        preview: resized,
        name: file.name,
        mimeType: resized.match(/data:([^;]+)/)?.[1] || file.type || "image/jpeg",
      });
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function parseAssessmentScores(row = {}) {
  return {
    turf_density: row.turf_density ?? row.turfDensity ?? 0,
    weed_suppression: row.weed_suppression ?? row.weedSuppression ?? 0,
    color_health: row.color_health ?? row.colorHealth ?? 0,
    fungus_control: row.fungus_control ?? row.fungusControl ?? 0,
    thatch_level: row.thatch_level ?? row.thatchLevel ?? 0,
  };
}

function parseStressFlags(value) {
  if (!value) return EMPTY_LAWN_STRESS_FLAGS;
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return {};
          }
        })()
      : value;
  return { ...EMPTY_LAWN_STRESS_FLAGS, ...(parsed || {}) };
}

function parseProtocolFieldChecks(value) {
  const parsed =
    typeof value === "string"
      ? (() => {
          try {
            return JSON.parse(value);
          } catch {
            return {};
          }
        })()
      : value || {};
  return {
    ...EMPTY_PROTOCOL_FIELD_CHECKS,
    thatchMeasurementIn: parsed.thatchMeasurementIn ?? parsed.thatch_measurement_in ?? "",
    chinchFloatTestDone: !!(parsed.chinchFloatTestDone ?? parsed.chinch_float_test_done),
    chinchCountPerSqft: parsed.chinchCountPerSqft ?? parsed.chinch_count_per_sqft ?? "",
    nematodeAssayFlag: !!(parsed.nematodeAssayFlag ?? parsed.nematode_assay_flag),
    soilKPpm: parsed.soilKPpm ?? parsed.soil_k_ppm ?? "",
    largePatchHistoryObserved: !!(
      parsed.largePatchHistoryObserved ?? parsed.large_patch_history_observed
    ),
    notes: parsed.notes ?? parsed.protocol_field_notes ?? "",
  };
}

function LawnAssessmentCompletionBlock({ service, disabled, onConfirmed }) {
  const [photos, setPhotos] = useState([]);
  const [result, setResult] = useState(null);
  const [techScores, setTechScores] = useState(null);
  const [stressFlags, setStressFlags] = useState(EMPTY_LAWN_STRESS_FLAGS);
  const [protocolFieldChecks, setProtocolFieldChecks] = useState(
    EMPTY_PROTOCOL_FIELD_CHECKS,
  );
  const [confirmedId, setConfirmedId] = useState(null);
  const [snapshotReview, setSnapshotReview] = useState(null);
  const [snapshotLoading, setSnapshotLoading] = useState(false);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setPhotos([]);
    setResult(null);
    setTechScores(null);
    setStressFlags(EMPTY_LAWN_STRESS_FLAGS);
    setProtocolFieldChecks(EMPTY_PROTOCOL_FIELD_CHECKS);
    setConfirmedId(null);
    setSnapshotReview(null);
    setError("");
    onConfirmed?.(null);
    if (!service?.id) return () => { cancelled = true; };

    setLoading(true);
    adminFetch(`/admin/lawn-assessment/service/${service.id}`)
      .then((data) => {
        if (cancelled || !data?.assessment) return;
        const assessment = data.assessment;
        const scores = parseAssessmentScores(assessment);
        setResult({
          success: true,
          assessment,
          adjustedScores: scores,
          displayScores: scores,
          observations: assessment.observations || "",
        });
        setTechScores(scores);
        setStressFlags(parseStressFlags(assessment.stress_flags));
        setProtocolFieldChecks(
          parseProtocolFieldChecks(assessment.protocol_field_checks || assessment),
        );
        if (assessment.confirmed_by_tech) {
          setConfirmedId(assessment.id);
          onConfirmed?.(assessment.id);
          loadSnapshotReview(assessment.id);
        }
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [service?.id]);

  async function loadSnapshotReview(assessmentId) {
    if (!assessmentId) return;
    setSnapshotLoading(true);
    try {
      const data = await adminFetch(`/admin/lawn-assessment/${assessmentId}/snapshot`);
      setSnapshotReview(data);
    } catch {
      setSnapshotReview(null);
    } finally {
      setSnapshotLoading(false);
    }
  }

  async function patchSnapshot(snapshotId, body) {
    if (!snapshotId || !confirmedId) return;
    setSnapshotLoading(true);
    try {
      await adminFetch(`/admin/lawn-assessment/snapshots/${snapshotId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await loadSnapshotReview(confirmedId);
    } catch (err) {
      setError(err.message || "Snapshot update failed");
      setSnapshotLoading(false);
    }
  }

  async function patchRecommendation(recommendationId, body) {
    if (!recommendationId || !confirmedId) return;
    setSnapshotLoading(true);
    try {
      await adminFetch(`/admin/lawn-assessment/recommendations/${recommendationId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      await loadSnapshotReview(confirmedId);
    } catch (err) {
      setError(err.message || "Recommendation update failed");
      setSnapshotLoading(false);
    }
  }

  async function addPhotos(event) {
    const files = Array.from(event.target.files || []);
    const remaining = Math.max(0, 3 - photos.length);
    if (!files.length || remaining === 0) return;
    setError("");
    try {
      const nextPhotos = await Promise.all(
        files.slice(0, remaining).map(readLawnAssessmentPhoto),
      );
      setPhotos((prev) => [...prev, ...nextPhotos].slice(0, 3));
      setResult(null);
      setTechScores(null);
      setConfirmedId(null);
      onConfirmed?.(null);
    } catch (err) {
      setError(err.message || "Photo read failed");
    } finally {
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  function adjustScore(key, delta) {
    setTechScores((prev) => {
      if (!prev) return prev;
      const current = Number(prev[key]) || 0;
      return { ...prev, [key]: Math.max(0, Math.min(100, current + delta)) };
    });
  }

  async function analyze() {
    if (!service?.customerId || photos.length === 0) return;
    setAnalyzing(true);
    setError("");
    try {
      const response = await adminFetch("/admin/lawn-assessment/assess", {
        method: "POST",
        body: JSON.stringify({
          customerId: service.customerId,
          serviceId: service.id,
          photos: photos.map((photo) => ({
            data: photo.data.split(",")[1],
            mimeType: photo.mimeType || "image/jpeg",
          })),
        }),
      });
      if (response.success === false) {
        setError(response.message || "Assessment failed. Retake photos and try again.");
        return;
      }
      const scores = response.adjustedScores || response.displayScores || {};
      setResult(response);
      setTechScores({ ...scores });
      setConfirmedId(null);
      onConfirmed?.(null);
    } catch (err) {
      setError(err.message || "Assessment failed");
    } finally {
      setAnalyzing(false);
    }
  }

  async function confirm() {
    if (!result?.assessment?.id) return;
    setConfirming(true);
    setError("");
    try {
      const response = await adminFetch("/admin/lawn-assessment/confirm", {
        method: "POST",
        body: JSON.stringify({
          assessmentId: result.assessment.id,
          adjustedScores: techScores || result.adjustedScores || result.displayScores,
          stress_flags: stressFlags,
          protocol_field_checks: {
            thatchMeasurementIn: protocolFieldChecks.thatchMeasurementIn,
            chinchFloatTestDone: protocolFieldChecks.chinchFloatTestDone,
            chinchCountPerSqft: protocolFieldChecks.chinchCountPerSqft,
            nematodeAssayFlag: protocolFieldChecks.nematodeAssayFlag,
            soilKPpm: protocolFieldChecks.soilKPpm,
            largePatchHistoryObserved:
              protocolFieldChecks.largePatchHistoryObserved,
            notes: protocolFieldChecks.notes,
          },
        }),
      });
      const assessmentId = response?.assessment?.id || result.assessment.id;
      setConfirmedId(assessmentId);
      onConfirmed?.(assessmentId);
      await loadSnapshotReview(assessmentId);
    } catch (err) {
      setError(err.message || "Confirm failed");
    } finally {
      setConfirming(false);
    }
  }

  const scoreSource = techScores || result?.adjustedScores || result?.displayScores || null;
  const hasResult = !!result?.assessment?.id;
  const confirmed = !!confirmedId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.45 }}>
        Capture turf photos for this lawn visit before closing the service.
      </div>
      {loading && (
        <div style={{ fontSize: 12, color: D.muted }}>Checking existing assessment...</div>
      )}
      {!hasResult && (
        <>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            multiple
            onChange={addPhotos}
            style={{ display: "none" }}
          />
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={disabled || photos.length >= 3 || analyzing}
              style={{
                height: 38,
                padding: "0 14px",
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: D.white,
                color: D.heading,
                fontSize: 13,
                fontWeight: 700,
                cursor: disabled || photos.length >= 3 || analyzing ? "not-allowed" : "pointer",
                opacity: disabled || photos.length >= 3 || analyzing ? 0.55 : 1,
              }}
            >
              Add turf photos
            </button>
            <span style={{ fontSize: 12, color: D.muted }}>{photos.length}/3</span>
          </div>
          {photos.length > 0 && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {photos.map((photo, index) => (
                <div key={`${photo.name}-${index}`} style={{ position: "relative", width: 78, height: 78 }}>
                  <img
                    src={photo.preview}
                    alt=""
                    style={{
                      width: 78,
                      height: 78,
                      objectFit: "cover",
                      borderRadius: 8,
                      border: `1px solid ${D.border}`,
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => setPhotos((prev) => prev.filter((_, i) => i !== index))}
                    aria-label="Remove assessment photo"
                    style={{
                      position: "absolute",
                      top: -7,
                      right: -7,
                      width: 22,
                      height: 22,
                      borderRadius: "50%",
                      border: "none",
                      background: D.heading,
                      color: "#fff",
                      cursor: "pointer",
                      lineHeight: 1,
                    }}
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            type="button"
            onClick={analyze}
            disabled={disabled || photos.length === 0 || analyzing}
            style={{
              height: 40,
              borderRadius: 8,
              border: "none",
              background: D.green,
              color: "#fff",
              fontSize: 13,
              fontWeight: 800,
              cursor: disabled || photos.length === 0 || analyzing ? "not-allowed" : "pointer",
              opacity: disabled || photos.length === 0 || analyzing ? 0.55 : 1,
            }}
          >
            {analyzing ? "Analyzing..." : "Analyze lawn"}
          </button>
        </>
      )}
      {hasResult && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 6 }}>
            {LAWN_ASSESSMENT_METRICS.map((metric) => {
              const value = Number(scoreSource?.[metric.key] || 0);
              return (
                <div
                  key={metric.key}
                  style={{
                    border: `1px solid ${D.border}`,
                    borderRadius: 8,
                    padding: "8px 4px",
                    textAlign: "center",
                    background: D.white,
                    minWidth: 0,
                  }}
                >
                  <div style={{ fontSize: 15, fontWeight: 800, color: lawnScoreColor(value), lineHeight: 1.1 }}>
                    {value}%
                  </div>
                  <div style={{ fontSize: 10, color: D.muted, marginTop: 3 }}>{metric.label}</div>
                  {!confirmed && (
                    <div style={{ display: "flex", justifyContent: "center", gap: 4, marginTop: 6 }}>
                      <button type="button" onClick={() => adjustScore(metric.key, -5)} style={scoreButtonStyle}>
                        -
                      </button>
                      <button type="button" onClick={() => adjustScore(metric.key, 5)} style={scoreButtonStyle}>
                        +
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {!confirmed && (
            <div>
              <div style={{ fontSize: 11, color: D.muted, fontWeight: 700, marginBottom: 6 }}>
                Stress flags
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {LAWN_STRESS_FLAGS.map((flag) => {
                  const selected = !!stressFlags[flag.key];
                  return (
                    <button
                      key={flag.key}
                      type="button"
                      onClick={() => setStressFlags((prev) => ({ ...prev, [flag.key]: !prev[flag.key] }))}
                      style={{
                        padding: "7px 10px",
                        borderRadius: 999,
                        border: `1px solid ${selected ? D.amber : D.border}`,
                        background: selected ? `${D.amber}18` : D.white,
                        color: selected ? D.amber : D.text,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      {selected ? "Selected " : ""}
                      {flag.label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {!confirmed && (
            <div>
              <div style={{ fontSize: 11, color: D.muted, fontWeight: 700, marginBottom: 6 }}>
                Protocol field checks
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(145px, 1fr))", gap: 8 }}>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  placeholder="Thatch inches"
                  value={protocolFieldChecks.thatchMeasurementIn}
                  onChange={(e) =>
                    setProtocolFieldChecks((prev) => ({
                      ...prev,
                      thatchMeasurementIn: e.target.value,
                    }))
                  }
                  style={inputStyle}
                />
                <input
                  type="number"
                  min="0"
                  step="0.1"
                  placeholder="Chinch / sqft"
                  value={protocolFieldChecks.chinchCountPerSqft}
                  onChange={(e) =>
                    setProtocolFieldChecks((prev) => ({
                      ...prev,
                      chinchCountPerSqft: e.target.value,
                    }))
                  }
                  style={inputStyle}
                />
                <input
                  type="number"
                  min="0"
                  step="1"
                  placeholder="Soil K ppm"
                  value={protocolFieldChecks.soilKPpm}
                  onChange={(e) =>
                    setProtocolFieldChecks((prev) => ({
                      ...prev,
                      soilKPpm: e.target.value,
                    }))
                  }
                  style={inputStyle}
                />
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {[
                  ["chinchFloatTestDone", "Chinch float test done"],
                  ["nematodeAssayFlag", "Nematode assay flag"],
                  ["largePatchHistoryObserved", "Large patch history"],
                ].map(([key, label]) => {
                  const selected = !!protocolFieldChecks[key];
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() =>
                        setProtocolFieldChecks((prev) => ({
                          ...prev,
                          [key]: !prev[key],
                        }))
                      }
                      style={{
                        padding: "7px 10px",
                        borderRadius: 999,
                        border: `1px solid ${selected ? D.green : D.border}`,
                        background: selected ? `${D.green}14` : D.white,
                        color: selected ? D.green : D.text,
                        fontSize: 12,
                        fontWeight: 700,
                        cursor: "pointer",
                      }}
                    >
                      {selected ? "Selected " : ""}
                      {label}
                    </button>
                  );
                })}
              </div>
              <textarea
                rows={2}
                placeholder="Protocol notes"
                value={protocolFieldChecks.notes}
                onChange={(e) =>
                  setProtocolFieldChecks((prev) => ({
                    ...prev,
                    notes: e.target.value,
                  }))
                }
                style={{ ...inputStyle, marginTop: 8, resize: "vertical" }}
              />
            </div>
          )}
          <div style={{ display: "flex", gap: 8 }}>
            {confirmed ? (
              <div
                style={{
                  flex: 1,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: `${D.green}14`,
                  color: D.green,
                  fontSize: 13,
                  fontWeight: 800,
                  textAlign: "center",
                }}
              >
                Assessment confirmed
              </div>
            ) : (
              <button
                type="button"
                onClick={confirm}
                disabled={disabled || confirming}
                style={{
                  flex: 1,
                  height: 40,
                  borderRadius: 8,
                  border: "none",
                  background: D.green,
                  color: "#fff",
                  fontSize: 13,
                  fontWeight: 800,
                  cursor: disabled || confirming ? "not-allowed" : "pointer",
                  opacity: disabled || confirming ? 0.55 : 1,
                }}
              >
                {confirming ? "Confirming..." : "Confirm assessment"}
              </button>
            )}
            <button
              type="button"
              onClick={() => {
                setPhotos([]);
                setResult(null);
                setTechScores(null);
                setProtocolFieldChecks(EMPTY_PROTOCOL_FIELD_CHECKS);
                setConfirmedId(null);
                setSnapshotReview(null);
                setError("");
                onConfirmed?.(null);
              }}
              disabled={disabled || analyzing || confirming}
              style={{
                height: 40,
                padding: "0 14px",
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: D.white,
                color: D.text,
                fontSize: 13,
                fontWeight: 700,
                cursor: disabled || analyzing || confirming ? "not-allowed" : "pointer",
                opacity: disabled || analyzing || confirming ? 0.55 : 1,
              }}
            >
              Retake
            </button>
          </div>
        </>
      )}
      {(snapshotLoading || snapshotReview?.snapshot) && (
        <ScheduleLawnSnapshotReview
          review={snapshotReview}
          loading={snapshotLoading}
          onSnapshotAction={patchSnapshot}
          onRecommendationAction={patchRecommendation}
        />
      )}
      {error && <div style={{ fontSize: 12, color: D.red, lineHeight: 1.45 }}>{error}</div>}
    </div>
  );
}

function ScheduleLawnSnapshotReview({ review, loading, onSnapshotAction, onRecommendationAction }) {
  const snapshot = review?.snapshot;
  const cards = review?.recommendationCards || [];
  if (loading && !snapshot) {
    return <div style={{ fontSize: 12, color: D.muted }}>Loading snapshot review...</div>;
  }
  if (!snapshot) return null;

  return (
    <div style={{ border: `1px solid ${D.border}`, borderRadius: 8, padding: 10, background: D.white }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "flex-start" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: D.heading }}>Customer snapshot</div>
          <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
            {snapshot.status} · {snapshot.customer_visible ? "Customer visible" : "Internal only"}
          </div>
        </div>
        <div style={{ display: "flex", gap: 5, flexWrap: "wrap", justifyContent: "flex-end" }}>
          <button type="button" onClick={() => onSnapshotAction(snapshot.id, { approve: true })} style={miniOutlineButton}>
            Approve
          </button>
          <button type="button" onClick={() => onSnapshotAction(snapshot.id, { customer_visible: true })} style={miniOutlineButton}>
            Show
          </button>
          <button type="button" onClick={() => onSnapshotAction(snapshot.id, { hide: true })} style={{ ...miniOutlineButton, color: D.red }}>
            Hide
          </button>
        </div>
      </div>
      <div style={{ fontSize: 12, color: D.text, lineHeight: 1.45, marginTop: 8 }}>
        {snapshot.summary_customer}
      </div>
      {cards.length > 0 && (
        <div style={{ display: "grid", gap: 6, marginTop: 10 }}>
          {cards.map((card) => (
            <div key={card.id} style={{ borderTop: `1px solid ${D.border}`, paddingTop: 8 }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: D.heading }}>{card.title}</div>
              <div style={{ fontSize: 11, color: D.muted, marginTop: 2 }}>
                {card.status} · {card.customer_visible ? "Customer visible" : "Internal only"}
              </div>
              {card.performance && (
                <div style={{ fontSize: 11, color: D.muted, marginTop: 4 }}>
                  Shown {card.performance.counts?.recommendation_shown || card.performance.counts?.shown || 0}
                  {" · "}Clicked {card.performance.counts?.recommendation_clicked || card.performance.counts?.clicked || 0}
                  {" · "}CTR {Number.isFinite(Number(card.performance.clickThroughRate)) ? `${Math.round(Number(card.performance.clickThroughRate) * 100)}%` : "—"}
                </div>
              )}
              <div style={{ display: "flex", gap: 5, marginTop: 6, flexWrap: "wrap" }}>
                <button type="button" onClick={() => onRecommendationAction(card.id, { approve: true })} style={miniOutlineButton}>
                  Approve
                </button>
                <button type="button" onClick={() => onRecommendationAction(card.id, { customer_visible: true })} style={miniOutlineButton}>
                  Show
                </button>
                <button type="button" onClick={() => onRecommendationAction(card.id, { dismiss: true })} style={{ ...miniOutlineButton, color: D.red }}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const miniOutlineButton = {
  height: 28,
  padding: "0 8px",
  borderRadius: 6,
  border: `1px solid ${D.border}`,
  background: D.white,
  color: D.text,
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
};

const scoreButtonStyle = {
  width: 24,
  height: 24,
  borderRadius: 6,
  border: `1px solid ${D.border}`,
  background: D.white,
  color: D.heading,
  fontSize: 14,
  fontWeight: 800,
  lineHeight: 1,
  cursor: "pointer",
};

function serviceLineFromType(serviceType = "") {
  const text = String(serviceType || "").toLowerCase();
  if (/\bpalmetto\b/.test(text)) return "pest";
  if (/\bpalm(s)?\b/.test(text)) return "palm";
  const category = detectServiceCategory(serviceType);
  if (category === "lawn") return "lawn";
  if (category === "tree_shrub") return "tree_shrub";
  if (text.includes("mosquito")) return "mosquito";
  if (/\b(termite|wdo|bora|trelona)\b/.test(text)) return "termite";
  if (/\b(rodent|rat|rats|mouse|mice|mole)\b/.test(text)) return "rodent";
  return "pest";
}

function normalizeApplicationMethod(value = "") {
  const normalized = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  if (!normalized) return "";
  if (
    [
      "perimeter_spray",
      "broadcast_spray",
      "spot_treatment",
      "granular_broadcast",
      "bait_placement",
      "station_check",
      "fog_ulv",
      "foliar_spray",
      "trunk_injection",
      "pin_stream",
    ].includes(normalized)
  ) return normalized;
  if (normalized.includes("trunk") || normalized.includes("inject")) return "trunk_injection";
  if (normalized.includes("foliar")) return "foliar_spray";
  if (normalized.includes("pin")) return "pin_stream";
  if (normalized.includes("granular")) return "granular_broadcast";
  if (normalized.includes("bait") || normalized.includes("gel") || normalized.includes("glue")) return "bait_placement";
  if (normalized.includes("station")) return "station_check";
  if (normalized.includes("fog") || normalized.includes("ulv")) return "fog_ulv";
  if (normalized.includes("spot")) return "spot_treatment";
  if (normalized.includes("broadcast")) return "broadcast_spray";
  if (normalized.includes("perimeter") || normalized.includes("band")) return "perimeter_spray";
  return normalized;
}

function defaultApplicationMethod(product = {}, serviceType = "") {
  const category = String(product.category || product.product_category || "").toLowerCase();
  const explicit = product.application_method || product.method;
  if (explicit) return normalizeApplicationMethod(explicit);
  if (category.includes("bait") || category.includes("gel") || category.includes("glue")) return "bait_placement";
  if (category.includes("fert") || category.includes("granular")) return "granular_broadcast";
  const serviceLine = serviceLineFromType(serviceType);
  if (serviceLine === "mosquito") return "fog_ulv";
  if (serviceLine === "lawn") return category.includes("herb") ? "spot_treatment" : "broadcast_spray";
  if (serviceLine === "palm" || serviceLine === "tree_shrub") return "foliar_spray";
  if (serviceLine === "termite" || serviceLine === "rodent") return "station_check";
  return "perimeter_spray";
}

function requiresLinearFt(method) {
  return normalizeApplicationMethod(method) === "perimeter_spray";
}

function requiresAreaSqft(method, serviceType = "") {
  const serviceLine = serviceLineFromType(serviceType);
  return (
    serviceLine === "lawn" &&
    ["broadcast_spray", "granular_broadcast"].includes(
      normalizeApplicationMethod(method),
    )
  );
}

function requiredApplicationArea(method, serviceType = "") {
  if (requiresLinearFt(method)) {
    return { unit: "linear_ft", label: "Linear ft", alertLabel: "linear feet" };
  }
  if (requiresAreaSqft(method, serviceType)) {
    return { unit: "sqft", label: "Sq ft", alertLabel: "square feet" };
  }
  return null;
}

function effectiveApplicationMethod(method) {
  return normalizeApplicationMethod(method) || "perimeter_spray";
}

function productApplicationMethod(product = {}, serviceType = "") {
  return normalizeApplicationMethod(product.applicationMethod) ||
    defaultApplicationMethod(product, serviceType);
}

function normalizeProductArea(product = {}, serviceType = "") {
  const applicationMethod = productApplicationMethod(product, serviceType);
  const areaRequirement = requiredApplicationArea(applicationMethod, serviceType);
  return {
    ...product,
    applicationMethod,
    areaUnit: areaRequirement?.unit || product.areaUnit || "",
    targets: Array.isArray(product.targets) ? product.targets : [],
  };
}

const TREE_SHRUB_ORDINANCE_OPTIONS = [
  { value: "sarasota_venice", label: "Sarasota / Venice" },
  { value: "north_port", label: "North Port" },
  { value: "manatee_parrish", label: "Manatee / Parrish" },
  { value: "other_unknown", label: "Other / unknown" },
];

const TREE_SHRUB_POLLINATOR_OPTIONS = [
  { value: "", label: "Flowering / pollinator status" },
  { value: "no_blooms_or_no_bees", label: "No blooms or bees observed" },
  { value: "blooming_no_bees", label: "Blooming, no bees active" },
  { value: "blooming_bees_active", label: "Blooming, bees active" },
  { value: "no_insecticide_applied", label: "No insecticide applied" },
];

const TREE_SHRUB_LIFE_STAGE_OPTIONS = [
  { value: "", label: "Pest life stage" },
  { value: "none", label: "None observed" },
  { value: "adult", label: "Adult" },
  { value: "crawler", label: "Crawler" },
  { value: "nymph", label: "Nymph" },
  { value: "eggs", label: "Eggs" },
  { value: "larvae", label: "Larvae" },
  { value: "mites", label: "Mites" },
  { value: "mixed", label: "Mixed stages" },
  { value: "unknown", label: "Unknown" },
];

function treeShrubLocationText(service = {}) {
  return [
    service.city,
    service.address,
    service.serviceAddress,
    service.propertyAddress,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function inferTreeShrubOrdinanceZoneClient(service = {}) {
  const location = treeShrubLocationText(service);
  if (/\bnorth\s*port\b/.test(location)) return "north_port";
  if (/\b(parrish|manatee|bradenton|palmetto|ellenton|lakewood\s*ranch)\b/.test(location)) {
    return "manatee_parrish";
  }
  if (/\b(sarasota|venice|nokomis|osprey|englewood)\b/.test(location)) return "sarasota_venice";
  return "other_unknown";
}

function defaultTreeShrubCloseout(service = {}) {
  return {
    ordinanceZone: inferTreeShrubOrdinanceZoneClient(service),
    bedSqft: "",
    palmCount: "",
    palmRootZoneSqft: "",
    plantInventory: "",
    pollinatorStatus: "",
    targetPestOrDisease: "",
    pestLifeStage: "",
    iracFracLogged: false,
    snapshotAppliedYtd: "",
    fertilizerAppliedYtd: "",
    customerNote: "",
    injectionPerformed: false,
    injectionRecord: {
      plantSpecies: "",
      sizeClassOrDbh: "",
      product: "",
      dose: "",
      numberOfPorts: "",
      targetIssue: "",
      followUpDate: "",
    },
  };
}

function normalizeTreeShrubCloseoutDraft(value = {}, service = {}) {
  const defaults = defaultTreeShrubCloseout(service);
  return {
    ...defaults,
    ...(value || {}),
    ordinanceZone: value?.ordinanceZone || defaults.ordinanceZone,
    injectionRecord: {
      ...defaults.injectionRecord,
      ...(value?.injectionRecord || {}),
    },
  };
}

function treeShrubNumber(value) {
  if (value === "" || value == null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function treeShrubText(...values) {
  return values.filter(Boolean).join(" ").toLowerCase();
}

function treeShrubProductFlagsClient(selectedProducts = []) {
  const productsText = (product) =>
    treeShrubText(
      product.name,
      product.category,
      product.productCategory,
      product.applicationMethod,
      product.rateUnit,
    );
  const hasInsectProduct = selectedProducts.some((product) =>
    /\b(insect|miticide|igr|whitefly|scale|aphid|thrip|caterpillar|mite|neonic|imidacloprid|dinotefuran|bifenthrin|pyrethroid|merit|zylam|kontos|mainspring|distance|talus|suffoil|oil|conserve|floramite|talstar|sevin|azamax|ima[\s-]*jet)\b/.test(productsText(product)),
  );
  const hasFungicideProduct = selectedProducts.some((product) =>
    /\b(fungicide|fungus|disease|phytophthora|kphite|phosphite|phosphonate|copper|headway|artavia|propizol|frac)\b/.test(productsText(product)),
  );
  const hasSnapshot = selectedProducts.some((product) => /\bsnapshot\b/.test(productsText(product)));
  const hasNpFertilizer = selectedProducts.some((product) => {
    const textValue = productsText(product);
    const analysis = textValue.match(/\b(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\b/);
    if (analysis) return Number(analysis[1]) > 0 || Number(analysis[2]) > 0;
    if (/\b0\s*-\s*0\s*-\s*\d+/.test(textValue)) return false;
    return /\b(fertiliz|fertiliser|fertilizer|fert\b|palm\s*fert|alfalfa|13\s*-\s*0\s*-\s*13|8\s*-\s*2\s*-\s*12)\b/.test(textValue);
  });
  const hasInjectionProduct = selectedProducts.some((product) =>
    /\b(palm[\s-]*jet|mn[\s-]*jet|ima[\s-]*jet|propizol|tree[\s-]*age|injection|injectable)\b/.test(productsText(product)),
  );
  const missingActuals = selectedProducts.filter((product) => {
    const amount = treeShrubNumber(product.totalAmount);
    return !amount || amount <= 0 || !product.amountUnit;
  });
  return {
    hasInsectProduct,
    hasFungicideProduct,
    needsIracFracLog: hasInsectProduct || hasFungicideProduct,
    hasSnapshot,
    hasNpFertilizer,
    hasInjectionProduct,
    missingActuals,
  };
}

function treeShrubDateInBlackout(service = {}, zone = "") {
  if (!["sarasota_venice", "manatee_parrish", "other_unknown"].includes(zone)) return false;
  const raw = service.scheduledDate || service.scheduled_date || service.date;
  const dateOnly = raw ? String(raw).split("T")[0] : "";
  const match = dateOnly.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return false;
  const month = Number(match[2]);
  const day = Number(match[3]);
  return (month > 6 || (month === 6 && day >= 1)) && (month < 9 || (month === 9 && day <= 30));
}

function isNoneLikeTreeShrubValue(value = "") {
  return ["", "none", "none observed", "none_observed", "n/a", "na"].includes(
    String(value || "").trim().toLowerCase(),
  );
}

function treeShrubCloseoutBlocksClient({
  closeout,
  productFlags,
  servicePhotos,
  service,
  customerRecap,
  notes,
  isIncompleteVisit,
}) {
  if (isIncompleteVisit) return [];
  const blocks = [];
  const push = (message, field) => blocks.push({ message, field });
  const bedSqft = treeShrubNumber(closeout.bedSqft);
  const palmCount = treeShrubNumber(closeout.palmCount);
  const palmRootZoneSqft = treeShrubNumber(closeout.palmRootZoneSqft);
  const snapshotYtd = treeShrubNumber(closeout.snapshotAppliedYtd);

  if (!closeout.ordinanceZone) push("Select ordinance zone.", "ordinanceZone");
  if (!bedSqft || bedSqft <= 0) push("Enter bed square footage.", "bedSqft");
  if (palmCount === null || palmCount < 0 || !Number.isInteger(palmCount)) push("Enter palm count, even if it is 0.", "palmCount");
  if (palmCount > 0 && (!palmRootZoneSqft || palmRootZoneSqft <= 0)) push("Enter palm canopy/root-zone square footage.", "palmRootZoneSqft");
  if (!String(closeout.plantInventory || "").trim()) push("Record plant inventory.", "plantInventory");
  if (!closeout.pollinatorStatus) push("Record flowering/pollinator status.", "pollinatorStatus");
  if (!String(closeout.targetPestOrDisease || "").trim()) push("Record target pest, disease, or none observed.", "targetPestOrDisease");
  if (!String(closeout.pestLifeStage || "").trim()) push("Record pest life stage or none.", "pestLifeStage");
  if (productFlags.hasInsectProduct && isNoneLikeTreeShrubValue(closeout.targetPestOrDisease)) {
    push("Insecticide/miticide/IGR applications require a target pest ID.", "targetPestOrDisease");
  }
  if (productFlags.hasInsectProduct && isNoneLikeTreeShrubValue(closeout.pestLifeStage)) {
    push("Insecticide/miticide/IGR applications require pest life stage.", "pestLifeStage");
  }
  if (productFlags.hasInsectProduct && closeout.pollinatorStatus === "blooming_bees_active") {
    push("Bee-active blooming plants block insect/contact applications.", "pollinatorStatus");
  }
  if (productFlags.needsIracFracLog && !closeout.iracFracLogged) {
    push("Confirm IRAC/FRAC history was checked and logged.", "iracFracLogged");
  }
  if (snapshotYtd === null || snapshotYtd < 0 || !Number.isInteger(snapshotYtd)) {
    push("Record Snapshot applications year-to-date.", "snapshotAppliedYtd");
  } else if (snapshotYtd > 4) {
    push("Snapshot applications YTD cannot exceed the quarterly program limit.", "snapshotAppliedYtd");
  }
  if (!String(closeout.fertilizerAppliedYtd || "").trim()) {
    push("Record fertilizer applied YTD or none.", "fertilizerAppliedYtd");
  }
  if (!String(closeout.customerNote || customerRecap || notes || "").trim()) {
    push("Enter customer-facing note or technician note.", "customerNote");
  }
  if ((servicePhotos || []).length < 2) push("Attach at least 2 Tree/Shrub closeout photos.", "completionPhotos");
  if (productFlags.missingActuals.length) {
    push(
      `Enter actual product amount and unit: ${productFlags.missingActuals
        .map((product) => product.name || "Selected product")
        .join(", ")}.`,
      "products",
    );
  }
  if (productFlags.hasNpFertilizer && treeShrubDateInBlackout(service, closeout.ordinanceZone)) {
    push("N/P fertilizer is blocked for this ordinance zone from June 1 through September 30.", "ordinanceZone");
  }

  if (closeout.injectionPerformed || productFlags.hasInjectionProduct) {
    const injection = closeout.injectionRecord || {};
    if (!String(injection.plantSpecies || "").trim()) push("Injection record requires plant species.", "injectionRecord.plantSpecies");
    if (!String(injection.sizeClassOrDbh || "").trim()) push("Injection record requires DBH or palm size class.", "injectionRecord.sizeClassOrDbh");
    if (!String(injection.product || "").trim()) push("Injection record requires product.", "injectionRecord.product");
    if (!String(injection.dose || "").trim()) push("Injection record requires dose.", "injectionRecord.dose");
    if (treeShrubNumber(injection.numberOfPorts) === null) push("Injection record requires number of ports.", "injectionRecord.numberOfPorts");
    if (!String(injection.targetIssue || "").trim()) push("Injection record requires target issue.", "injectionRecord.targetIssue");
    if (!String(injection.followUpDate || "").trim()) push("Injection record requires follow-up date.", "injectionRecord.followUpDate");
  }

  return blocks;
}

function TreeShrubCloseoutBlock({
  value,
  onChange,
  blocks,
  productFlags,
  inputStyle: baseInputStyle,
  selectStyle,
  textareaStyle,
  colors,
}) {
  const input = { ...baseInputStyle, marginBottom: 8 };
  const select = { ...(selectStyle || baseInputStyle), marginBottom: 8 };
  const textarea = { ...(textareaStyle || baseInputStyle), marginBottom: 8, minHeight: 82 };
  const setField = (field, nextValue) => onChange({ ...value, [field]: nextValue });
  const setInjectionField = (field, nextValue) =>
    onChange({
      ...value,
      injectionRecord: {
        ...(value.injectionRecord || {}),
        [field]: nextValue,
      },
    });
  const injectionVisible = value.injectionPerformed || productFlags.hasInjectionProduct;
  return (
    <div style={{ display: "grid", gap: 8 }}>
      {blocks.length > 0 && (
        <div
          style={{
            background: `${colors.error}12`,
            border: `1px solid ${colors.error}`,
            borderRadius: 10,
            padding: 10,
            color: colors.error,
            fontSize: 12,
            lineHeight: 1.4,
          }}
        >
          {blocks.slice(0, 4).map((block) => block.message).join(" ")}
          {blocks.length > 4 ? ` ${blocks.length - 4} more required.` : ""}
        </div>
      )}
      <div
        style={{
          background: colors.card,
          border: `1px solid ${colors.border}`,
          borderRadius: 10,
          padding: 10,
          color: colors.muted,
          fontSize: 12,
          lineHeight: 1.4,
        }}
      >
        Closeout is locked until ordinance, plant inventory, pollinator status, pest/life stage, YTD Snapshot/fertilizer, product actuals, and photos are recorded.
      </div>
      <select
        value={value.ordinanceZone || ""}
        onChange={(e) => setField("ordinanceZone", e.target.value)}
        style={select}
      >
        {TREE_SHRUB_ORDINANCE_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <input
          type="number"
          value={value.bedSqft ?? ""}
          onChange={(e) => setField("bedSqft", e.target.value)}
          placeholder="Bed sq ft"
          style={input}
        />
        <input
          type="number"
          value={value.palmCount ?? ""}
          onChange={(e) => setField("palmCount", e.target.value)}
          placeholder="Palm count"
          style={input}
        />
      </div>
      <input
        type="number"
        value={value.palmRootZoneSqft ?? ""}
        onChange={(e) => setField("palmRootZoneSqft", e.target.value)}
        placeholder="Palm canopy/root-zone sq ft"
        style={input}
      />
      <textarea
        value={value.plantInventory || ""}
        onChange={(e) => setField("plantInventory", e.target.value)}
        rows={3}
        placeholder="Plant inventory: palms, ficus, ixora, hibiscus, croton..."
        style={textarea}
      />
      <select
        value={value.pollinatorStatus || ""}
        onChange={(e) => setField("pollinatorStatus", e.target.value)}
        style={select}
      >
        {TREE_SHRUB_POLLINATOR_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <input
          value={value.targetPestOrDisease || ""}
          onChange={(e) => setField("targetPestOrDisease", e.target.value)}
          placeholder="Target pest/disease"
          style={input}
        />
        <select
          value={value.pestLifeStage || ""}
          onChange={(e) => setField("pestLifeStage", e.target.value)}
          style={select}
        >
          {TREE_SHRUB_LIFE_STAGE_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, color: colors.text, fontSize: 13, fontWeight: 700 }}>
        <input
          type="checkbox"
          checked={!!value.iracFracLogged}
          onChange={(e) => setField("iracFracLogged", e.target.checked)}
        />
        IRAC/FRAC history checked and logged
      </label>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
        <input
          type="number"
          value={value.snapshotAppliedYtd ?? ""}
          onChange={(e) => setField("snapshotAppliedYtd", e.target.value)}
          placeholder="Snapshot YTD"
          style={input}
        />
        <input
          value={value.fertilizerAppliedYtd || ""}
          onChange={(e) => setField("fertilizerAppliedYtd", e.target.value)}
          placeholder="Fertilizer YTD"
          style={input}
        />
      </div>
      <textarea
        value={value.customerNote || ""}
        onChange={(e) => setField("customerNote", e.target.value)}
        rows={2}
        placeholder="Customer note"
        style={textarea}
      />
      <label style={{ display: "flex", alignItems: "center", gap: 8, color: colors.text, fontSize: 13, fontWeight: 700 }}>
        <input
          type="checkbox"
          checked={!!value.injectionPerformed || productFlags.hasInjectionProduct}
          onChange={(e) => setField("injectionPerformed", e.target.checked)}
          disabled={productFlags.hasInjectionProduct}
        />
        Injection add-on performed
      </label>
      {injectionVisible && (
        <div style={{ display: "grid", gap: 8 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input
              value={value.injectionRecord?.plantSpecies || ""}
              onChange={(e) => setInjectionField("plantSpecies", e.target.value)}
              placeholder="Plant species"
              style={input}
            />
            <input
              value={value.injectionRecord?.sizeClassOrDbh || ""}
              onChange={(e) => setInjectionField("sizeClassOrDbh", e.target.value)}
              placeholder="DBH / palm size"
              style={input}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input
              value={value.injectionRecord?.product || ""}
              onChange={(e) => setInjectionField("product", e.target.value)}
              placeholder="Injection product"
              style={input}
            />
            <input
              value={value.injectionRecord?.dose || ""}
              onChange={(e) => setInjectionField("dose", e.target.value)}
              placeholder="Dose"
              style={input}
            />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <input
              type="number"
              value={value.injectionRecord?.numberOfPorts ?? ""}
              onChange={(e) => setInjectionField("numberOfPorts", e.target.value)}
              placeholder="Ports"
              style={input}
            />
            <input
              type="date"
              value={value.injectionRecord?.followUpDate || ""}
              onChange={(e) => setInjectionField("followUpDate", e.target.value)}
              style={input}
            />
          </div>
          <input
            value={value.injectionRecord?.targetIssue || ""}
            onChange={(e) => setInjectionField("targetIssue", e.target.value)}
            placeholder="Injection target issue"
            style={input}
          />
        </div>
      )}
    </div>
  );
}

// Mirror of server `completion-recap.smsRecap` (server/services/completion-recap.js).
// The stored recap is now full-length (so the service report reads completely),
// and the dispatch/pest-recap SMS paths cap it to a sentence-complete ~232 chars
// at send. The operator's SMS preview must show that SAME capped copy — otherwise
// the tech approves a full recap while the customer receives the shortened one.
// Keep this in lockstep with the server clamp.
const SMS_RECAP_MAX_CHARS = 232;
function smsRecapPreview(value) {
  // Mirrors server sanitizeRecap's normalization chain exactly (same order) so
  // the preview is byte-identical to the sent SMS even when the operator pastes
  // outer quotes, smart quotes, en/em dashes, or an already-signed recap.
  let text = String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[–—]/g, "-");
  text = text.replace(/^["']+|["']+$/g, "");
  text = text.replace(/\s*-\s*Waves\s*$/i, "").trim();
  text = text
    .replace(/^["']+|["']+$/g, "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .trim();
  if (text.length > SMS_RECAP_MAX_CHARS) {
    const slice = text.slice(0, SMS_RECAP_MAX_CHARS);
    const lastStop = Math.max(slice.lastIndexOf(". "), slice.lastIndexOf("! "), slice.lastIndexOf("? "));
    text = lastStop >= Math.floor(SMS_RECAP_MAX_CHARS / 2)
      ? slice.slice(0, lastStop + 1).trim()
      : slice.replace(/\s+\S*$/, "").trim();
  }
  return text ? `${text} - Waves` : "";
}

// Turfchek II gauge stops + grass→ideal-band map. Mirror of
// server/services/service-report/turf-height.js (the server snapshots the
// authoritative band on submit; this drives the tech's live status preview).
const TURF_HEIGHT_BANDS = {
  st_augustine: { min: 3.5, max: 4.0 },
  bahia: { min: 3.0, max: 4.0 },
  bermuda: { min: 1.0, max: 2.0 },
  zoysia: { min: 1.5, max: 2.0 },
};
const TURF_OVERRIDE_REASONS = [
  { code: "no_gauge_on_truck", label: "No gauge on truck" },
  { code: "gauge_unreadable", label: "Gauge unreadable" },
  { code: "not_applicable", label: "Not applicable" },
];
function turfBandFor(grassType) {
  return TURF_HEIGHT_BANDS[grassType] || TURF_HEIGHT_BANDS.st_augustine;
}

// Tech-facing height-of-cut capture (lawn completion, behind the feature flag).
// Numeric height entry + live range status + OPTIONAL gauge photo, or a
// reason-coded override. value = { heightIn, gaugePhoto, overrideReason }.
function TurfHeightCapture({ service, value, onChange, disabled }) {
  const [grassType, setGrassType] = useState(null);
  const fileRef = useRef(null);
  useEffect(() => {
    let live = true;
    if (!service?.customerId) return undefined;
    adminFetch(`/admin/customers/${service.customerId}/turf-profile`)
      .then((d) => { if (live) setGrassType(d?.profile?.grass_type || "unknown"); })
      .catch(() => { if (live) setGrassType("unknown"); });
    return () => { live = false; };
  }, [service?.customerId]);

  const band = turfBandFor(grassType);
  const bandLabel = `${band.min}–${band.max}″`;
  const overridden = !!value.overrideReason;
  const h = value.heightIn;
  const status = h == null ? null : (h < band.min ? "below" : (h > band.max ? "above" : "in_range"));
  const statusMeta = {
    in_range: { color: CP_M.ink, text: `In range (ideal ${bandLabel})` },
    above: { color: CP_M.ink, text: `Above ideal ${bandLabel}` },
    below: { color: "#C8102E", text: `Below ideal ${bandLabel} — scalping risk` },
  }[status];

  async function onPickPhoto(e) {
    const file = (e.target.files || [])[0];
    if (!file) return;
    try {
      const photo = await prepareCompletionPhoto(file);
      onChange({ ...value, gaugePhoto: { data: photo.data, name: photo.name || "turf-gauge.jpg" }, overrideReason: null });
    } catch { alert("Could not prepare the gauge photo."); }
    if (fileRef.current) fileRef.current.value = "";
  }

  return (
    <div style={{ opacity: disabled ? 0.6 : 1 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, opacity: overridden ? 0.45 : 1 }}>
        <input
          type="number"
          inputMode="decimal"
          step="0.25"
          min="0.5"
          max="8"
          value={value.heightIn ?? ""}
          disabled={disabled || overridden}
          placeholder="e.g. 4"
          onChange={(e) => onChange({
            ...value,
            heightIn: e.target.value === "" ? null : Number(e.target.value),
            overrideReason: null,
          })}
          style={{ width: 96, height: 38, padding: "0 12px", borderRadius: 8, border: `1px solid ${CP_M.hairline}`, fontFamily: CP_FONT, fontSize: 15, color: CP_M.ink, background: CP_M.card }}
        />
        <span style={{ fontFamily: CP_FONT, fontSize: 14, color: CP_M.ink4 }}>inches</span>
      </div>
      {statusMeta && !overridden && (
        <div style={{ marginTop: 10, fontFamily: CP_FONT, fontSize: 13, fontWeight: 600, color: statusMeta.color }}>{statusMeta.text}</div>
      )}
      <div style={{ marginTop: 14 }}>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" style={{ display: "none" }} onChange={onPickPhoto} disabled={disabled || overridden} />
        <button type="button" onClick={() => fileRef.current?.click()} disabled={disabled || overridden}
          style={{ height: 36, padding: "0 14px", borderRadius: 999, background: value.gaugePhoto ? CP_M.ink : CP_M.card, color: value.gaugePhoto ? CP_M.actionFg : CP_M.ink, border: `1px solid ${CP_M.hairline}`, fontFamily: CP_FONT, fontSize: 13, fontWeight: 500, cursor: disabled || overridden ? "default" : "pointer" }}>
          {value.gaugePhoto ? "✓ Gauge photo added" : "Add gauge photo (optional)"}
        </button>
        {!value.gaugePhoto && !overridden && (
          <span style={{ marginLeft: 10, fontFamily: CP_FONT, fontSize: 12, color: CP_M.ink4 }}>Optional — gauge scale + canopy line visible.</span>
        )}
      </div>
      <div style={{ marginTop: 14, fontFamily: CP_FONT, fontSize: 12, color: CP_M.ink4 }}>
        Can&rsquo;t capture a reading?
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 6 }}>
          {TURF_OVERRIDE_REASONS.map((r) => (
            <CPChip key={r.code} selected={value.overrideReason === r.code}
              onClick={disabled ? undefined : () => onChange(value.overrideReason === r.code
                ? { ...value, overrideReason: null }
                : { heightIn: null, gaugePhoto: null, overrideReason: r.code })}>
              {r.label}
            </CPChip>
          ))}
        </div>
      </div>
    </div>
  );
}

// Recap chips — action tags (top 8 + more). role is sent to the server, which
// derives the friendly customer caption (recap-media.js ROLE_MAP). Mirrors the
// tech-capture-preview, but here the native camera records and uploads for real.
const RECAP_CHIPS_TOP = [
  { role: "perimeter", label: "Spray — perimeter" },
  { role: "eaves", label: "Spray — eaves/soffits" },
  { role: "entry", label: "Spray — entry points" },
  { role: "deweb", label: "De-web — eaves/corners" },
  { role: "sweep", label: "Sweep — lanai/pool cage" },
  { role: "bait", label: "Bait placement" },
  { role: "granule", label: "Granule spread" },
  { role: "pest", label: "Live pest (found)" },
];
const RECAP_CHIPS_MORE = [
  { role: "inside", label: "Spray — inside" },
  { role: "foundation", label: "Spray — foundation/weep holes" },
  { role: "garage", label: "Spray — garage" },
  { role: "shrubs", label: "Spray — shrubs/beds" },
  { role: "dust", label: "Dust — crack & crevice" },
  { role: "wasp", label: "Wasp nest removal" },
  { role: "acpad", label: "Treat AC pad" },
  { role: "before", label: "Before" },
  { role: "after", label: "After" },
];

function readVideoDurationMs(file) {
  return new Promise((resolve) => {
    try {
      const url = URL.createObjectURL(file);
      const v = document.createElement("video");
      v.preload = "metadata";
      v.onloadedmetadata = () => { URL.revokeObjectURL(url); resolve(Number.isFinite(v.duration) ? Math.round(v.duration * 1000) : null); };
      v.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      v.src = url;
    } catch { resolve(null); }
  });
}

// Tech capture — record a clip (native camera) → tag the action → upload direct to
// S3 (presigned PUT) → it lands in the recap. All optional; flag-gated, pest only.
function RecapCapture({ serviceId }) {
  const [items, setItems] = useState([]);
  const [pendingFile, setPendingFile] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  const refresh = () => adminFetch(`/admin/dispatch/${serviceId}/recap-media`)
    .then((d) => setItems(d?.items || [])).catch(() => {});
  useEffect(() => { refresh(); /* eslint-disable-next-line */ }, [serviceId]);

  const onPick = (e) => {
    const file = e.target.files && e.target.files[0];
    if (fileRef.current) fileRef.current.value = "";
    if (file) setPendingFile(file);
  };

  const tag = async (role) => {
    const file = pendingFile;
    setPendingFile(null);
    setShowMore(false);
    if (!file) return;
    setUploading((n) => n + 1);
    setErr(null);
    try {
      const mediaType = file.type.startsWith("image/") ? "image" : "video";
      const durationMs = mediaType === "video" ? await readVideoDurationMs(file) : null;
      const { mediaId, uploadUrl } = await adminFetch(`/admin/dispatch/${serviceId}/recap-media/presign`, {
        method: "POST", body: JSON.stringify({ role, mediaType, contentType: file.type || (mediaType === "image" ? "image/jpeg" : "video/mp4") }),
      });
      const put = await fetch(uploadUrl, { method: "PUT", headers: { "Content-Type": file.type || "video/mp4" }, body: file });
      if (!put.ok) throw new Error(`upload failed (${put.status})`);
      await adminFetch(`/admin/dispatch/${serviceId}/recap-media/${mediaId}/confirm`, {
        method: "POST", body: JSON.stringify({ bytes: file.size, durationMs }),
      });
      await refresh();
    } catch (e) {
      // Surface the server reason (e.g. unsupported iPhone HEVC/MOV or HEIC) instead of
      // silently dropping the clip; closeout stays unblocked either way.
      setErr(e?.message || "Couldn’t add that clip — use an MP4 video or JPEG photo.");
    } finally { setUploading((n) => Math.max(0, n - 1)); }
  };

  const remove = async (id) => {
    try { await adminFetch(`/admin/dispatch/${serviceId}/recap-media/${id}`, { method: "DELETE" }); await refresh(); } catch { /* ignore */ }
  };

  const wrap = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 14, margin: "0 0 12px" };
  const chip = { display: "flex", alignItems: "center", gap: 7, padding: "12px 10px", borderRadius: 11, background: D.bg, border: `1px solid ${D.border}`, color: D.text, fontSize: 12.5, fontWeight: 700, cursor: "pointer", textAlign: "left" };

  return (
    <div style={wrap}>
      <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 14, color: D.text, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: D.teal }} /> Recap clips</span>
        <span style={{ fontSize: 12, color: D.muted }}>{items.length ? `${items.length} captured` : "optional"}</span>
      </div>
      <div style={{ fontSize: 12.5, color: D.muted, margin: "6px 0 10px", lineHeight: 1.45 }}>Grab a few 5-sec clips of the work — they play in the customer’s recap. Skip it and the recap still generates.</div>

      <input ref={fileRef} type="file" accept="video/*,image/*" capture="environment" onChange={onPick} style={{ display: "none" }} />

      {items.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
          {items.map((m) => (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 10, padding: 8 }}>
              <div style={{ width: 40, height: 40, borderRadius: 7, background: "linear-gradient(135deg,#0ea5e9,#0b1220)", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 700, color: D.white, textTransform: "capitalize" }}>{m.role}</div>
                <div style={{ fontSize: 11.5, color: D.teal }}>“{m.caption}”</div>
              </div>
              <span style={{ fontSize: 10.5, color: m.status === "ready" ? D.green : D.muted, fontWeight: 700 }}>{m.status === "ready" ? "Uploaded" : m.status}</span>
              <button onClick={() => remove(m.id)} style={{ background: "none", border: "none", color: D.muted, fontSize: 18, cursor: "pointer" }}>×</button>
            </div>
          ))}
        </div>
      )}

      {err && <div style={{ fontSize: 12, color: D.red, margin: "0 0 8px", lineHeight: 1.4 }}>{err}</div>}
      <button onClick={() => fileRef.current && fileRef.current.click()} style={{ width: "100%", padding: "12px", borderRadius: 10, border: "none", background: D.teal, color: "#04240f", fontWeight: 800, fontSize: 13.5, cursor: "pointer", fontFamily: "'Montserrat', sans-serif" }}>
        {uploading ? `Uploading… (${uploading})` : "+ Capture clip"}
      </button>

      {pendingFile && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(5,8,13,.7)", zIndex: 50, display: "flex", alignItems: "flex-end" }} onClick={() => setPendingFile(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", background: D.card, borderRadius: "18px 18px 0 0", border: `1px solid ${D.border}`, padding: "16px 14px 22px", maxHeight: "82%", overflowY: "auto" }}>
            <div style={{ width: 40, height: 4, background: D.border, borderRadius: 3, margin: "0 auto 12px" }} />
            <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 800, fontSize: 16, color: D.white, textAlign: "center" }}>What were you doing?</div>
            <div style={{ fontSize: 12, color: D.muted, textAlign: "center", margin: "4px 0 12px" }}>One tap. We caption it for the customer.</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {(showMore ? [...RECAP_CHIPS_TOP, ...RECAP_CHIPS_MORE] : RECAP_CHIPS_TOP).map((c) => (
                <button key={c.role} onClick={() => tag(c.role)} style={chip}><span style={{ width: 9, height: 9, borderRadius: "50%", background: D.teal, flexShrink: 0 }} />{c.label}</button>
              ))}
            </div>
            {!showMore && <button onClick={() => setShowMore(true)} style={{ marginTop: 9, width: "100%", padding: 10, borderRadius: 9, background: "none", border: `1px solid ${D.border}`, color: D.muted, fontSize: 12.5, cursor: "pointer" }}>More actions…</button>}
          </div>
        </div>
      )}
    </div>
  );
}

// "Your Visit, in Motion" recap — preview & approve card for the closeout.
// Polls the recap render status, plays the MP4 (fetched as an authed blob so the
// <video> tag doesn't need to carry a JWT), and gates sending on tech approval.
// Flag-gated (pest-recap-v1) + pest visits only; renders next to FastCloseout.
function PestRecapCard({ serviceId }) {
  const [state, setState] = useState({ status: "loading" });
  const [videoUrl, setVideoUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const blobRef = useRef(null);

  const refresh = () => adminFetch(`/admin/dispatch/${serviceId}/recap-video`)
    .then((d) => { setState(d || { status: "none" }); return d; })
    .catch(() => { setState({ status: "error" }); return null; });

  useEffect(() => {
    let alive = true;
    const fetchStatus = () => adminFetch(`/admin/dispatch/${serviceId}/recap-video`)
      .then((d) => { if (alive) setState(d || { status: "none" }); })
      .catch(() => { if (alive) setState({ status: "error" }); });
    fetchStatus();
    const id = setInterval(fetchStatus, 4000);
    return () => { alive = false; clearInterval(id); if (blobRef.current) URL.revokeObjectURL(blobRef.current); };
  }, [serviceId]);

  useEffect(() => {
    if (!(state.status === "ready" || state.status === "approved") || videoUrl) return undefined;
    let alive = true;
    (async () => {
      try {
        const token = localStorage.getItem("waves_admin_token");
        const res = await fetch(`${API_BASE}/admin/dispatch/${serviceId}/recap-video/file`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        if (!res.ok || !alive) return;
        const blob = await res.blob();
        if (!alive) return;
        const url = URL.createObjectURL(blob);
        blobRef.current = url;
        setVideoUrl(url);
      } catch { /* ignore */ }
    })();
    return () => { alive = false; };
  }, [state.status, videoUrl, serviceId]);

  const act = async (path, body) => {
    setBusy(true);
    try { await adminFetch(`/admin/dispatch/${serviceId}/recap-video/${path}`, { method: "POST", body: JSON.stringify(body || {}) }); await refresh(); }
    catch (e) { setState((s) => ({ ...s, error: e.message })); }
    finally { setBusy(false); }
  };
  const regenerate = () => {
    if (blobRef.current) { URL.revokeObjectURL(blobRef.current); blobRef.current = null; }
    setVideoUrl(null);
    return act("generate", { force: true });
  };

  const s = state.status;
  const wrap = { background: D.card, border: `1px solid ${D.border}`, borderRadius: 12, padding: 14, margin: "0 0 12px" };
  const head = { fontFamily: "'Montserrat', sans-serif", fontWeight: 700, fontSize: 14, color: D.text, display: "flex", alignItems: "center", gap: 8, marginBottom: 8 };
  const btn = (bg, color) => ({ flex: 1, padding: "11px", borderRadius: 10, border: "none", background: bg, color, fontWeight: 700, fontSize: 13, cursor: busy ? "wait" : "pointer", fontFamily: "'Montserrat', sans-serif" });

  return (
    <div style={wrap}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={head}><span style={{ width: 8, height: 8, borderRadius: "50%", background: D.teal }} /> Visit recap video</div>
      {s === "loading" && <div style={{ fontSize: 13, color: D.muted }}>Checking recap…</div>}
      {(s === "none") && (
        <>
          <div style={{ fontSize: 12.5, color: D.muted, marginBottom: 10 }}>Generate a ~30-sec recap from this visit. You’ll preview & approve before it sends.</div>
          <button style={btn(D.teal, "#04240f")} disabled={busy} onClick={() => act("generate")}>Generate recap</button>
        </>
      )}
      {(s === "pending" || s === "rendering") && (
        <div style={{ fontSize: 13, color: D.muted, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 16, height: 16, border: `2px solid ${D.border}`, borderTopColor: D.teal, borderRadius: "50%", display: "inline-block", animation: "spin 0.8s linear infinite" }} />
          Rendering the recap… this takes about a minute.
        </div>
      )}
      {(s === "ready" || s === "approved") && (
        <>
          {videoUrl
            ? <video src={videoUrl} controls playsInline style={{ width: "100%", maxWidth: 240, display: "block", margin: "0 auto 10px", borderRadius: 10, background: "#000" }} />
            : <div style={{ fontSize: 13, color: D.muted, marginBottom: 10 }}>Loading preview…</div>}
          {s === "approved" ? (
            state.sent ? (
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span style={{ flex: 1, fontSize: 12.5, color: D.green, fontWeight: 700 }}>Approved &amp; sent to the customer</span>
                <button style={btn("transparent", D.muted)} disabled={busy} onClick={regenerate}>Regenerate</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ flex: 1, fontSize: 12, color: D.amber, fontWeight: 700, minWidth: 130 }}>Approved — the text didn’t send</span>
                <button style={btn(D.green, "#04240f")} disabled={busy} onClick={() => act("approve")}>Retry send</button>
                <button style={btn("transparent", D.muted)} disabled={busy} onClick={regenerate}>Regenerate</button>
              </div>
            )
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button style={btn(D.green, "#04240f")} disabled={busy} onClick={() => act("approve")}>Approve &amp; send</button>
              <button style={btn("transparent", D.muted)} disabled={busy} onClick={regenerate}>Regenerate</button>
            </div>
          )}
        </>
      )}
      {s === "failed" && (
        <>
          <div style={{ fontSize: 12.5, color: D.amber, marginBottom: 10 }}>Recap render didn’t complete.{state.error ? ` (${state.error})` : ""}</div>
          <button style={btn(D.teal, "#04240f")} disabled={busy} onClick={regenerate}>Try again</button>
        </>
      )}
      {s === "error" && <div style={{ fontSize: 12.5, color: D.muted }}>Couldn’t load recap status.</div>}
    </div>
  );
}

export function CompletionPanel({
  service,
  products,
  onClose,
  onSubmit,
  onViewDetails,
  // Typed specialty completion (PR 3): parent-owned routes for the
  // billing-required 409 (opens the checkout flow) and the success-screen
  // follow-up CTA (wired by PR 4 — the button only renders when provided).
  onBillingRequired,
  onScheduleFollowup,
}) {
  const [notes, setNotes] = useState("");
  // Voice-to-text for the notes box. Appends final transcript chunks; the tech
  // taps the mic again to stop. (Phase 2: the single notes box is the tech's
  // only free-text input — the AI report copy is generated from it + photos.)
  // Ignore any chunk that lands once an AI draft is in flight: SpeechRecognition
  // .stop() can still deliver a final result asynchronously, which would mutate
  // notes after the payload was snapshotted and then be lost when the response
  // replaces the notes.
  const dictation = useSpeechDictation((text) => {
    if (generating) return;
    setNotes((b) => (b ? `${b} ${text}` : text));
  });
  const [selectedProducts, setSelectedProducts] = useState([]);
  const [productSearch, setProductSearch] = useState("");
  const [sendSms, setSendSms] = useState(true);
  const [includePayLink, setIncludePayLink] = useState(true);
  const [requestReview, setRequestReview] = useState(true);
  const [reviewTiming, setReviewTiming] = useState("120");
  const [reviewCustomAt, setReviewCustomAt] = useState("");
  const [oneTimeRecapOnly, setOneTimeRecapOnly] = useState(false);
  const [visitOutcome, setVisitOutcome] = useState("completed");
  const [customerRecap, setCustomerRecap] = useState("");
  const [recapSource, setRecapSource] = useState("template");
  const [recapStaleAfterEdit, setRecapStaleAfterEdit] = useState(false);
  const [recapDraftStatus, setRecapDraftStatus] = useState("idle");
  const [recapLoading, setRecapLoading] = useState(false);
  const [recapError, setRecapError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [success, setSuccess] = useState(false);
  const [completionResult, setCompletionResult] = useState(null);
  // Completion-screen annual-prepay offer (flag-gated, default off): a post-
  // completion CTA that mints the prepay invoice and either sends it alongside
  // the report or charges the year via Tap to Pay. Off = no change to completion.
  const [showPrepay, setShowPrepay] = useState(false);
  const { enabled: prepayAtCompletionFlag } = useFeatureFlagReady("prepay-at-completion");
  // Minting an annual-prepay invoice is admin-only (requireAdmin). The admin app +
  // flags endpoint also serve technician users, so gate the CTA on the admin role
  // exactly like the Customer 360 prepay buttons — otherwise a tech hits a 403
  // after filling the modal.
  const prepayIsAdmin = (() => {
    try { return JSON.parse(localStorage.getItem("waves_admin_user") || "{}")?.role === "admin"; }
    catch { return false; }
  })();
  const showPrepayCta = prepayAtCompletionFlag && prepayIsAdmin;
  const [elapsed, setElapsed] = useState("0:00");
  const [quickComplete, setQuickComplete] = useState(false);
  const [servicePhotos, setServicePhotos] = useState([]);
  // Turf height-of-cut capture (lawn completion, behind the flag). `ready` gates
  // submit so a lawn visit can't be completed before the flag state is known —
  // otherwise a pre-load submit hides the field the server still requires (422).
  const { enabled: turfHeightFlag, ready: turfHeightFlagReady } = useFeatureFlagReady("turf-height-capture");
  // Phase 3 fast closeout — flag-gated (default off). Existing completion flow is unchanged when off.
  // Tree & Shrub exception-based closeout — flag-gated (default off). When off the
  // completion flow is unchanged and the server's post-commit auto-score still runs.
  const { enabled: treeShrubCloseoutFlag, ready: treeShrubCloseoutReady } = useFeatureFlagReady("tree-shrub-closeout-v2");
  const { enabled: pestRecapFlag, ready: pestRecapReady } = useFeatureFlagReady("pest-recap-v1");
  const [turfHeight, setTurfHeight] = useState({ heightIn: null, gaugePhoto: null, overrideReason: null });
  const [treeShrubCloseout, setTreeShrubCloseout] = useState(() =>
    defaultTreeShrubCloseout(service),
  );
  const [areasServiced, setAreasServiced] = useState([]);
  const [customerInteraction, setCustomerInteraction] = useState("");
  const [customerConcern, setCustomerConcern] = useState("");
  // Tech-side Pest Pressure rating (0-5). Companion to the customer-side
  // capture on the public service report — both flows write to
  // service_records.client_pest_rating with their respective source.
  // Null = not entered; 0-5 = explicit rating; backend ignores when the
  // config flag `allowTechnicianClientRatingEntry` is off.
  const [clientPestRating, setClientPestRating] = useState(null);
  // Typed specialty completion (specialty-service-completion-contract.md).
  // A job is "typed" when its completion profile carries a findingsType AND
  // the dispatch payload embedded the registry schema slice for it.
  const typedFindingsSchema = service.findingsSchema || null;
  const isTypedFindings = !!(
    service.completionProfile?.findingsType && typedFindingsSchema
  );
  // Companion typed sections (combined-service-completions.md): zero or more
  // additional findings schemas embedded beside findingsSchema in the
  // dispatch payload. Each keeps its own values/chips/gauge state keyed by
  // type — companions ride typed AND recurring primaries.
  const companionSchemas = Array.isArray(service.companionSchemas)
    ? service.companionSchemas.filter((s) => s && s.type)
    : [];
  const [companionState, setCompanionState] = useState(() =>
    Object.fromEntries(
      companionSchemas.map((s) => [
        s.type,
        { values: {}, chips: [], score: null, scoreTouched: false },
      ]),
    ),
  );
  const [findingsValues, setFindingsValues] = useState({});
  const [typedActivityScore, setTypedActivityScore] = useState(null);
  // Pin semantics (contract §4): while untouched, the score recomputes from
  // deriveScores[values[deriveField]]; the FIRST tap on the picker pins
  // technician-set — even on the same value.
  const [typedActivityTouched, setTypedActivityTouched] = useState(false);
  const [typedNextStepChips, setTypedNextStepChips] = useState([]);
  const [typedRecommendations, setTypedRecommendations] = useState("");
  const [typedRecommendationsEdited, setTypedRecommendationsEdited] =
    useState(false);
  const [typedAiDrafting, setTypedAiDrafting] = useState(false);
  const [typedAiError, setTypedAiError] = useState("");
  // Customer calls/texts/emails reach the AI prompt only on explicit opt-in
  // — they can carry PII, so the box starts unchecked.
  const [typedAiIncludeComms, setTypedAiIncludeComms] = useState(false);
  const [typedAiDraftUsed, setTypedAiDraftUsed] = useState(false);
  // AI photo analysis (optional, never blocks submit): summary is editable,
  // captions attach to the photo entries. Not draft-persisted — photos
  // themselves aren't, and a summary without its photos would be stale.
  const [typedPhotoSummary, setTypedPhotoSummary] = useState("");
  const [photoAnalyzing, setPhotoAnalyzing] = useState(false);
  const [photoAiError, setPhotoAiError] = useState("");
  // Mirror of servicePhotos for the post-await staleness check — reading
  // state captured before the await (or a side effect inside a setState
  // updater) is not reliable.
  const servicePhotosRef = useRef([]);
  useEffect(() => {
    servicePhotosRef.current = servicePhotos;
  }, [servicePhotos]);
  // Tech-speed telemetry (contract §10) — rides inside the completion POST
  // as `completionTelemetry`; never a separate request.
  const completionTelemetryRef = useRef({
    panelOpenedAt: new Date().toISOString(),
    firstFieldTouchedAt: null,
    requiredFieldErrorCount: 0,
  });
  // `null` = unknown (still loading or fetch failed). The picker only
  // renders when this is explicitly `true`, so a config-flag flip OFF
  // hides the UI rather than letting the tech enter data the backend
  // will silently drop.
  const [techRatingAllowed, setTechRatingAllowed] = useState(null);
  useEffect(() => {
    let cancelled = false;
    // Per-service `allowed` boolean from the server. The endpoint
    // applies the SAME `detectServiceLine` classifier and
    // `enabledServiceLines` allow-list that the completion handler
    // uses on write — so the picker's visibility matches what the
    // backend will actually persist. Avoids the
    // detectServiceCategory ↔ detectServiceLine drift (e.g. rodent
    // labels classify as `pest` client-side but `rodent` server-side).
    if (!service || !service.id) return undefined;
    // Typed jobs never show the Pest Pressure picker — activity capture
    // happens through the findings activity gauge instead. Skip the fetch.
    if (isTypedFindings) {
      setTechRatingAllowed(false);
      return undefined;
    }
    adminFetch(`/admin/dispatch/${service.id}/tech-rating-allowed`)
      .then((body) => {
        if (cancelled) return;
        setTechRatingAllowed(!!(body && body.allowed === true));
      })
      .catch(() => {
        // Fetch failure — keep the picker hidden so the tech can still
        // complete the visit without it, and the customer-side capture
        // path is unaffected.
        if (!cancelled) setTechRatingAllowed(false);
      });
    return () => {
      cancelled = true;
    };
  }, [service && service.id]);
  const [nextVisit, setNextVisit] = useState(null);
  const [nextVisitNote, setNextVisitNote] = useState("");
  const [showNextVisitNote, setShowNextVisitNote] = useState(false);
  const [equipmentSystemId, setEquipmentSystemId] = useState("");
  const [calibrationId, setCalibrationId] = useState("");
  const [equipmentCalibrations, setEquipmentCalibrations] = useState([]);
  const [equipmentCalibrationError, setEquipmentCalibrationError] =
    useState("");
  const [treatmentPlanBlocks, setTreatmentPlanBlocks] = useState([]);
  const [treatmentPlanAnnualN, setTreatmentPlanAnnualN] = useState(null);
  const [treatmentPlanStructuredProtocol, setTreatmentPlanStructuredProtocol] =
    useState(null);
  const [treatmentPlanAppointmentAssignment, setTreatmentPlanAppointmentAssignment] =
    useState(null);
  const [treatmentPlanInventoryBlocks, setTreatmentPlanInventoryBlocks] =
    useState([]);
  const [treatmentPlanInventoryWarnings, setTreatmentPlanInventoryWarnings] =
    useState([]);
  const [treatmentPlanSubstitutions, setTreatmentPlanSubstitutions] =
    useState([]);
  const [treatmentPlanError, setTreatmentPlanError] = useState("");
  const [protocolActions, setProtocolActions] = useState([]);
  const [protocolActionMeta, setProtocolActionMeta] = useState(null);
  const [protocolActionError, setProtocolActionError] = useState("");
  const [protocolActionsLoading, setProtocolActionsLoading] = useState(false);
  const [selectedProtocolActionLabels, setSelectedProtocolActionLabels] =
    useState([]);
  // label -> { scope, treatmentApplied } for completed actions, so the
  // submit payload can send structured scope without regexing labels.
  const [actionScopeByLabel, setActionScopeByLabel] = useState({});
  const [selectedObservationLabels, setSelectedObservationLabels] = useState(
    [],
  );
  const [selectedRecommendationLabels, setSelectedRecommendationLabels] =
    useState([]);
  const [protocolTaskStatus, setProtocolTaskStatus] = useState({});
  const [protocolTreatedSqft, setProtocolTreatedSqft] = useState("");
  const [protocolCarrierGalPer1000, setProtocolCarrierGalPer1000] =
    useState("");
  const [skippedProtocolProducts, setSkippedProtocolProducts] = useState({});
  const [officeApprovalReasonCode, setOfficeApprovalReasonCode] = useState("");
  const [officeApprovalNote, setOfficeApprovalNote] = useState("");
  const [nLimitApprovalReasonCode, setNLimitApprovalReasonCode] = useState("");
  const [nLimitApprovalNote, setNLimitApprovalNote] = useState("");
  const [managerApprovalReasonCode, setManagerApprovalReasonCode] =
    useState("");
  const [managerApprovalNote, setManagerApprovalNote] = useState("");
  const [treatmentPlanProductIds, setTreatmentPlanProductIds] = useState([]);
  const [treatmentPlanPlannedProductIds, setTreatmentPlanPlannedProductIds] =
    useState([]);
  const [tankLastProduct, setTankLastProduct] = useState("");
  const [tankLastProductCategory, setTankLastProductCategory] = useState("");
  const [tankCleanoutCompleted, setTankCleanoutCompleted] = useState("");
  const [tankCleanoutMethod, setTankCleanoutMethod] = useState("");
  const [tankCleanoutNote, setTankCleanoutNote] = useState("");
  const [lawnAssessmentId, setLawnAssessmentId] = useState(null);
  const [lawnAssessmentRevision, setLawnAssessmentRevision] = useState(0);
  const [savedDraft, setSavedDraft] = useState(null);
  const [showDraftPrompt, setShowDraftPrompt] = useState(false);
  // Tree & Shrub closeout AI review (flag-gated). treeShrubReview holds the preview
  // { scores, observations, findings }; decisions live in the summary and are
  // captured into the ref on Complete + Send so the submit body can carry them.
  const [treeShrubReview, setTreeShrubReview] = useState(null);
  const [treeShrubAiStatus, setTreeShrubAiStatus] = useState("idle"); // idle|pending|complete|failed
  const treeShrubDecisionsRef = useRef(null);
  const treeShrubScoredKeyRef = useRef("");
  const photoInputRef = useRef(null);
  const recapRequestRef = useRef(0);
  const recapAbortRef = useRef(null);
  const draftSnapshotRef = useRef(null);
  const completionIdempotencyKeyRef = useRef(null);
  const draftReadyRef = useRef(false);

  // Typed jobs use the findings form — lawn/WaveGuard closeout sections
  // (soil readings, treatment plan/calibration, tank cleanout) never apply.
  const isLawn =
    !isTypedFindings && detectServiceCategory(service.serviceType) === "lawn";
  // Lawn visits replace the Service Photos uploader with the turf photos from
  // the Lawn Assessment block — but only for a PURE lawn visit. A combined
  // visit (e.g. lawn + Tree & Shrub) carries a companion findings schema whose
  // compliance gate still requires its own completion photos (T&S needs >=2),
  // so keep the uploader whenever any companion is present.
  const hideServicePhotos = isLawn && companionSchemas.length === 0;
  const serviceTypeForArea = service?.serviceType || service?.service_type || "";
  const calibrationRequired = isLawn && !!service.waveguardTier;
  const currentAdminUser = (() => {
    try {
      return JSON.parse(localStorage.getItem("waves_admin_user") || "null");
    } catch {
      return null;
    }
  })();
  const canApproveOfficeExceptions = currentAdminUser?.role === "admin";
  const serviceCategory = detectServiceCategory(service.serviceType);
  // Plant-health services (lawn, tree/shrub) keep the broad observation list;
  // pest-line services get the pest-focused list.
  const usesPlantHealthChips =
    serviceCategory === "lawn" || serviceCategory === "tree_shrub";
  const serviceLineForCloseout = serviceLineFromType(serviceTypeForArea);
  const recapEligible = pestRecapFlag && pestRecapReady && serviceLineForCloseout === "pest";
  const treeShrubCloseoutOn =
    treeShrubCloseoutReady && treeShrubCloseoutFlag && serviceLineForCloseout === "tree_shrub";

  // Auto-run the AI photo review once enough closeout photos are captured. The
  // dual-vision scoring lives server-side (no persistence) and returns the findings
  // the tech reviews. Keyed by a photo FINGERPRINT (not just count) so swapping a
  // photo for another at the same count still re-runs. Fully guarded — a failure
  // just shows "Will finalize after" and the server's auto-score still backstops.
  useEffect(() => {
    if (!treeShrubCloseoutOn) return undefined;
    const photos = (servicePhotos || []).filter((p) => p && p.data);
    const fingerprint = photos
      .map((p) => `${p.capturedAt || p.name || ""}:${(p.data || "").length}:${(p.data || "").slice(-24)}`)
      .join("|");
    if (photos.length < 2 || fingerprint === treeShrubScoredKeyRef.current) return undefined;
    treeShrubScoredKeyRef.current = fingerprint;
    let cancelled = false;
    // Clear the previous review BEFORE re-scoring: if the new request is still pending
    // or fails, completing must NOT submit the stale scores (the server's count check
    // could otherwise persist them against the new photos). Null → server auto-scores.
    setTreeShrubReview(null);
    treeShrubDecisionsRef.current = null;
    setTreeShrubAiStatus("pending");
    // adminFetch resolves to the parsed JSON (and throws on non-2xx) — consume it
    // directly; do NOT treat the result as a Response.
    adminFetch(`/admin/dispatch/${service.id}/tree-shrub/assess-preview`, {
      method: "POST",
      body: JSON.stringify({ photos: photos.map((p) => ({ data: p.data })) }),
    })
      .then((result) => {
        if (cancelled) return;
        if (result && result.scores) {
          // Tag with the photo fingerprint so the closeout summary resets the tech's
          // per-finding decisions when a NEW preview (new photos) arrives.
          setTreeShrubReview({ ...result, _fingerprint: fingerprint });
          setTreeShrubAiStatus("complete");
        } else {
          setTreeShrubAiStatus("failed");
        }
      })
      .catch(() => { if (!cancelled) setTreeShrubAiStatus("failed"); });
    return () => { cancelled = true; };
  }, [treeShrubCloseoutOn, servicePhotos, service.id]);
  const treeShrubCloseoutRequired =
    !isTypedFindings &&
    ["tree_shrub", "palm"].includes(serviceLineForCloseout);
  const handleLawnAssessmentConfirmed = (assessmentId) => {
    setLawnAssessmentId(assessmentId || null);
    setLawnAssessmentRevision((v) => v + 1);
  };
  const areaOptions = [
    ...(AREAS_BY_SERVICE[serviceCategory] || AREAS_BY_SERVICE.pest),
    ...AREAS_BY_SERVICE.universal,
  ];
  const onSiteEntry = (service.statusLog || []).find(
    (e) => e.status === "on_site",
  );
  const onSiteTime = onSiteEntry ? onSiteEntry.at : service.checkInTime;

  const svcTypeLower = (service.serviceType || "").toLowerCase();
  const isCallback =
    svcTypeLower.includes("re-service") ||
    svcTypeLower.includes("callback") ||
    service.isCallback;
  const hasVisitPrice =
    service.estimatedPrice != null && Number(service.estimatedPrice) > 0;
  // Callbacks (re-services) are free by definition for recurring/WaveGuard
  // customers — the server suppresses the monthly_rate fallback for them
  // (admin-dispatch completion + Charge-now). Mirror that here so the tech UI's
  // willInvoice / pay-link prediction, AI recap framing, and review suppression
  // match the report-only/no-invoice completion the server actually performs.
  const invoiceAmount = hasVisitPrice
    ? Number(service.estimatedPrice)
    : isCallback
      ? 0
      : Number(service.monthlyRate || 0);
  const autopayCoversVisit =
    !!service.autopayActive &&
    !hasVisitPrice &&
    !!service.waveguardTier &&
    Number(service.monthlyRate || 0) > 0;
  const prepaidCovered =
    service.prepaidAmount != null &&
    Number(service.prepaidAmount) > 0 &&
    Number(service.prepaidAmount) >= invoiceAmount;
  const invoiceAlreadyPaid =
    service.checkoutInvoiceStatus === "paid" ||
    service.invoiceStatus === "paid";
  const reportOnlyCompletion =
    prepaidCovered ||
    invoiceAlreadyPaid ||
    autopayCoversVisit ||
    !!service.completionInvoiceAlreadySent;
  const willInvoice =
    !oneTimeRecapOnly &&
    !reportOnlyCompletion &&
    (!!service.createInvoiceOnComplete || !!service.waveguardTier) &&
    invoiceAmount > 0;
  // A pay link is only inserted when an invoice will be created AND the
  // operator hasn't opted to send the report on its own (e.g. paid in person).
  const willSendPayLink = willInvoice && includePayLink;
  const completionSmsTemplateName = willSendPayLink
    ? "Service Complete + Invoice"
    : "Service Complete";
  const isIncompleteVisit = visitOutcome === "incomplete";
  const reviewSuppressionReason = isIncompleteVisit
    ? "incomplete"
    : visitOutcome === "customer_declined"
      ? "customer_declined"
      : visitOutcome === "customer_concern" ||
          isCustomerConcernInteraction(customerInteraction)
        ? "customer_concern"
        : willInvoice
          ? "invoice_created"
          : null;
  const willReview =
    (oneTimeRecapOnly || !!requestReview) &&
    !willInvoice &&
    !reviewSuppressionReason;
  const effectiveSendSms = !isIncompleteVisit && (oneTimeRecapOnly || sendSms);
  const reviewSendsWithCompletionSms =
    willReview &&
    effectiveSendSms &&
    (oneTimeRecapOnly || reviewTiming === "now");
  const smsPreview = [
    smsRecapPreview(customerRecap),
    !isIncompleteVisit && willSendPayLink ? "[pay link inserted]" : "",
    reviewSendsWithCompletionSms ? "[review link inserted]" : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const canAutoDraftRecap =
    !isIncompleteVisit &&
    notes.trim().length >= 15 &&
    (selectedProducts.length > 0 ||
      areasServiced.length > 0 ||
      visitOutcome !== "completed" ||
      customerInteraction);
  const reviewScheduledFor = () => {
    if (!willReview || oneTimeRecapOnly) return null;
    if (reviewTiming === "tomorrow_8") {
      return `${etDateString(addETDays(new Date(), 1))}T08:00`;
    }
    if (reviewTiming === "custom") return reviewCustomAt || null;
    return null;
  };
  const reviewDelayMinutes = () => {
    if (!willReview) return null;
    if (oneTimeRecapOnly || reviewTiming === "now") return 0;
    if (reviewTiming === "custom") {
      const target = new Date(reviewCustomAt);
      return reviewCustomAt && !Number.isNaN(target.getTime()) ? 0 : null;
    }
    return Number(reviewTiming) || 120;
  };
  const recapStatusText = recapLoading
    ? "Drafting customer recap..."
    : recapError
      ? "Couldn't draft. Edit manually or send without SMS."
      : recapStaleAfterEdit
        ? "Notes changed since this draft"
        : recapDraftStatus === "manual"
          ? "Edited by tech"
          : recapSource && recapSource !== "template"
            ? `Draft: ${recapSource}`
            : "";
  const blackoutBlocks = treatmentPlanBlocks.filter(
    (block) =>
      block?.code === "nitrogen_blackout" ||
      block?.code === "phosphorus_blackout",
  );
  const blackoutApprovalRequired =
    calibrationRequired && !isIncompleteVisit && blackoutBlocks.length > 0;
  const blackoutCompletionBlocked =
    blackoutApprovalRequired &&
    (!canApproveOfficeExceptions || !officeApprovalReasonCode);
  const blackoutHelpText =
    treatmentPlanError ||
    blackoutBlocks
      .map((block) => block.message)
      .filter(Boolean)
      .join(" ") ||
    "Nitrogen or phosphorus fertilizer is restricted for this municipality window.";
  const annualNBlocks = treatmentPlanBlocks.filter(
    (block) => block?.code === "annual_n_budget_exceeded",
  );
  const nLimitApprovalRequired =
    calibrationRequired && !isIncompleteVisit && annualNBlocks.length > 0;
  const nLimitCompletionBlocked =
    nLimitApprovalRequired &&
    (!canApproveOfficeExceptions || !nLimitApprovalReasonCode);
  const nLimitHelpText =
    treatmentPlanError ||
    annualNBlocks
      .map((block) => block.message)
      .filter(Boolean)
      .join(" ") ||
    "This visit would exceed the annual nitrogen budget.";
  const nLimitSummaryText = treatmentPlanAnnualN
    ? `Used ${treatmentPlanAnnualN.used ?? 0}, visit ${treatmentPlanAnnualN.visit ?? 0}, projected ${treatmentPlanAnnualN.projected ?? 0} / ${treatmentPlanAnnualN.limit ?? 0} ${treatmentPlanAnnualN.unit || "lb N / 1,000 sqft / year"}.`
    : "";
  const offProtocolSelectedProducts = treatmentPlanProductIds.length
    ? selectedProducts.filter(
        (p) => !treatmentPlanProductIds.includes(String(p.productId)),
      )
    : [];
  const selectedProductIds = new Set(
    selectedProducts.map((product) => String(product.productId)),
  );
  const substitutionByOriginalProductId = new Map(
    treatmentPlanSubstitutions
      .filter((sub) => sub.originalProductId)
      .map((sub) => [String(sub.originalProductId), sub]),
  );
  const requiredProtocolTasks =
    treatmentPlanStructuredProtocol?.window?.requiredTasks || [];
  const missingProtocolTasks = requiredProtocolTasks.filter(
    (task) => !protocolTaskStatus[task],
  );
  const protocolProductKey = (product) =>
    product?.id || product?.productId || product?.productName;
  const defaultProtocolProducts =
    treatmentPlanStructuredProtocol?.products?.filter(
      (product) => product.defaultInPlan,
    ) || [];
  const undispositionedDefaultProtocolProducts = defaultProtocolProducts.filter(
    (product) => {
      const key = protocolProductKey(product);
      const substitution = product.productId
        ? substitutionByOriginalProductId.get(String(product.productId))
        : null;
      const selected = product.productId
        ? selectedProductIds.has(String(product.productId))
          || (substitution?.substituteProductId && selectedProductIds.has(String(substitution.substituteProductId)))
        : false;
      return !selected && !skippedProtocolProducts[key];
    },
  );
  const selectedProductsMissingActualAmount = selectedProducts.filter(
    (product) =>
      !product.totalAmount ||
      Number(product.totalAmount) <= 0 ||
      !product.amountUnit,
  );
  const protocolActualsCompletionBlocked =
    calibrationRequired &&
    !isIncompleteVisit &&
    (missingProtocolTasks.length > 0 ||
      undispositionedDefaultProtocolProducts.length > 0 ||
      selectedProductsMissingActualAmount.length > 0 ||
      treatmentPlanInventoryBlocks.length > 0);
  const conditionalProtocolSelectedProducts = treatmentPlanProductIds.length
    ? selectedProducts.filter((p) => {
        const id = String(p.productId);
        return (
          treatmentPlanProductIds.includes(id) &&
          !treatmentPlanPlannedProductIds.includes(id)
        );
      })
    : [];
  const highRateSelectedProducts = selectedProducts.filter((product) => {
    const enteredRate = Number(product.rate);
    const maxRate = Number(product.maxLabelRatePer1000);
    return (
      Number.isFinite(enteredRate) &&
      Number.isFinite(maxRate) &&
      maxRate > 0 &&
      enteredRate > maxRate &&
      rateUnitsMatch(product.rateUnit, product.catalogRateUnit)
    );
  });
  const labelUnitReviewProducts = selectedProducts.filter((product) => {
    const enteredRate = Number(product.rate);
    const maxRate = Number(product.maxLabelRatePer1000);
    return (
      Number.isFinite(enteredRate) &&
      Number.isFinite(maxRate) &&
      enteredRate > 0 &&
      maxRate > 0 &&
      !rateUnitsMatch(product.rateUnit, product.catalogRateUnit)
    );
  });
  const managerPlanBlocks = treatmentPlanBlocks.filter((block) => {
    if (!MANAGER_APPROVAL_CODES.has(block?.code)) return false;
    if (!block?.productId) return block?.code === "st_augustine_dethatching";
    return selectedProductIds.has(String(block.productId));
  });
  const managerApprovalBlocks = [
    ...managerPlanBlocks,
    ...offProtocolSelectedProducts.map((product) => ({
      code: "off_protocol_product",
      message: `${product.name || "Selected product"} is not part of the current WaveGuard protocol card.`,
    })),
    ...conditionalProtocolSelectedProducts.map((product) => ({
      code: "conditional_protocol_product_review",
      message: `${product.name || "Selected product"} is conditional on the WaveGuard protocol card and was not in the generated mix; manager review is required before applying it.`,
    })),
    ...highRateSelectedProducts.map((product) => ({
      code: "high_rate_application",
      message: `${product.name || "Selected product"} rate ${product.rate} ${product.rateUnit || ""}/1k exceeds label max ${product.maxLabelRatePer1000} ${product.catalogRateUnit || ""}/1k.`,
    })),
    ...labelUnitReviewProducts.map((product) => ({
      code: "label_rate_unit_review",
      message: `${product.name || "Selected product"} rate unit ${product.rateUnit || "unknown"} does not match label unit ${product.catalogRateUnit || "unknown"}; manager review is required before applying it.`,
    })),
  ];
  const managerApprovalRequired =
    calibrationRequired &&
    !isIncompleteVisit &&
    managerApprovalBlocks.length > 0;
  const managerApprovalCompletionBlocked =
    managerApprovalRequired &&
    (!canApproveOfficeExceptions || !managerApprovalReasonCode);
  const managerApprovalHelpText = managerApprovalBlocks
    .map((block) => block.message)
    .filter(Boolean)
    .join(" ");
  const tankCleanoutRequired =
    calibrationRequired && !isIncompleteVisit && !!equipmentSystemId;
  const tankCleanoutCompletionBlocked =
    tankCleanoutRequired &&
    (!tankLastProduct.trim() ||
      tankCleanoutCompleted !== "yes" ||
      !tankCleanoutMethod.trim());
  const tankCleanoutHelpText =
    "Record the prior tank product and confirm cleanout before completing this WaveGuard lawn visit.";
  const treeShrubProductFlags = treeShrubProductFlagsClient(selectedProducts);
  const treeShrubCloseoutBlocks = treeShrubCloseoutRequired
    ? treeShrubCloseoutBlocksClient({
        closeout: treeShrubCloseout,
        productFlags: treeShrubProductFlags,
        servicePhotos,
        service,
        customerRecap,
        notes,
        isIncompleteVisit,
      })
    : [];
  const treeShrubCompletionBlocked =
    treeShrubCloseoutRequired && !isIncompleteVisit && treeShrubCloseoutBlocks.length > 0;
  const structuredCloseoutRequired =
    (calibrationRequired || treeShrubCloseoutRequired) && !isIncompleteVisit;
  const completionCtaLabel = submitting
    ? "Completing..."
    : tankCleanoutCompletionBlocked
      ? "Tank Cleanout Required"
      : protocolActualsCompletionBlocked
        ? missingProtocolTasks.length
          ? "Protocol Checklist Required"
          : selectedProductsMissingActualAmount.length
            ? "Product Actuals Required"
            : treatmentPlanInventoryBlocks.length
              ? "Inventory Blocked"
              : "Product Disposition Required"
        : blackoutCompletionBlocked
          ? canApproveOfficeExceptions
            ? "Office Approval Required"
            : "Admin Approval Required"
          : nLimitCompletionBlocked
            ? canApproveOfficeExceptions
              ? "N Approval Required"
              : "Admin Approval Required"
            : managerApprovalCompletionBlocked
              ? canApproveOfficeExceptions
                ? "Manager Approval Required"
                : "Admin Approval Required"
              : treeShrubCompletionBlocked
                ? "Tree/Shrub Closeout Required"
              : isIncompleteVisit
                ? "Mark Visit Incomplete"
                : !effectiveSendSms
                  ? "Complete Service"
                  : willInvoice
                    ? "Complete & Send Invoice"
                    : "Complete & Send Recap";

  useEffect(() => {
    const iv = setInterval(() => setElapsed(elapsedSince(onSiteTime)), 1000);
    return () => clearInterval(iv);
  }, [onSiteTime]);

  useEffect(() => {
    if (structuredCloseoutRequired && quickComplete) {
      setQuickComplete(false);
    }
  }, [structuredCloseoutRequired, quickComplete]);

  // A flagged lawn visit requires a turf-height reading the server enforces, so
  // Quick complete (which hides the capture) can't apply — force it off so the
  // tech always sees the required field (mirrors structuredCloseoutRequired).
  useEffect(() => {
    if (isLawn && turfHeightFlag && quickComplete) {
      setQuickComplete(false);
    }
  }, [isLawn, turfHeightFlag, quickComplete]);

  // Lock body+html scroll while the panel is mounted. The panel is portaled
  // to document.body so its position:fixed overlay isn't trapped inside the
  // admin shell's -webkit-overflow-scrolling: touch container (iOS Safari
  // pins fixed descendants to that scroll container, clipping the top
  // header and bottom submit bar behind the app's top/tab bars).
  useEffect(() => {
    const prevBody = document.body.style.overflow;
    const prevHtml = document.documentElement.style.overflow;
    document.body.style.overflow = "hidden";
    document.documentElement.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevBody;
      document.documentElement.style.overflow = prevHtml;
    };
  }, []);

  useEffect(() => {
    if (service.customerId) {
      adminFetch(`/admin/schedule/next-visit?customerId=${service.customerId}`)
        .then((d) => {
          if (d.nextVisit) setNextVisit(d.nextVisit);
        })
        .catch(() => {});
    }
  }, [service.customerId]);

  useEffect(() => {
    let cancelled = false;
    setProtocolActions([]);
    setProtocolActionMeta(null);
    setProtocolActionError("");
    // Typed jobs hide the protocol-actions section entirely — skip the fetch.
    if (!service.serviceType || isTypedFindings)
      return () => {
        cancelled = true;
      };
    const params = new URLSearchParams();
    params.set("serviceType", service.serviceType);
    if (isLawn) {
      const track = protocolTrackForLawnType(service.lawnType);
      if (track) params.set("track", track);
      if (service.lawnType) params.set("lawnType", service.lawnType);
      const serviceDate =
        service.scheduledDate || service.scheduled_date || service.date;
      if (serviceDate) {
        const dateOnly = String(serviceDate).split("T")[0];
        const monthDate = new Date(`${dateOnly}T12:00:00`);
        if (!Number.isNaN(monthDate.getTime())) {
          params.set(
            "month",
            monthDate.toLocaleString("en-US", {
              month: "short",
              timeZone: "America/New_York",
            }),
          );
        }
      }
    }
    setProtocolActionsLoading(true);
    adminFetch(`/admin/protocols/completion-actions?${params.toString()}`)
      .then((data) => {
        if (cancelled) return;
        setProtocolActions(Array.isArray(data.actions) ? data.actions : []);
        setProtocolActionMeta(data || null);
      })
      .catch((err) => {
        if (!cancelled)
          setProtocolActionError(
            err.message || "Could not load protocol actions",
          );
      })
      .finally(() => {
        if (!cancelled) setProtocolActionsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [
    service.serviceType,
    service.lawnType,
    service.scheduledDate,
    service.scheduled_date,
    service.date,
    isLawn,
    isTypedFindings,
  ]);

  useEffect(() => {
    if (!calibrationRequired) return;
    let cancelled = false;
    setEquipmentCalibrationError("");
    adminFetch("/admin/equipment-systems/calibrations")
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data.calibrations) ? data.calibrations : [];
        const usableRows = rows.filter(
          (row) => row.calibration_status === "field_verified",
        );
        setEquipmentCalibrations(usableRows);
        if (!equipmentSystemId && usableRows.length === 1) {
          setEquipmentSystemId(usableRows[0].equipment_system_id || "");
          setCalibrationId(usableRows[0].id || "");
        }
      })
      .catch((err) => {
        if (!cancelled)
          setEquipmentCalibrationError(
            err.message || "Could not load equipment calibrations",
          );
      });
    return () => {
      cancelled = true;
    };
  }, [calibrationRequired]);

  useEffect(() => {
    if (!calibrationRequired) return;
    let cancelled = false;
    setTreatmentPlanError("");
    const params = new URLSearchParams();
    if (equipmentSystemId) params.set("equipmentSystemId", equipmentSystemId);
    if (calibrationId) params.set("calibrationId", calibrationId);
    const suffix = params.toString() ? `?${params.toString()}` : "";
    adminFetch(`/admin/treatment-plans/${service.id}${suffix}`)
      .then((data) => {
        if (cancelled) return;
        const blocks =
          data?.plan?.propertyGate?.blocks ||
          data?.plan?.protocol?.blocked ||
          [];
        setTreatmentPlanBlocks(Array.isArray(blocks) ? blocks : []);
        setTreatmentPlanAnnualN(data?.plan?.propertyGate?.annualN || null);
        setTreatmentPlanStructuredProtocol(data?.plan?.protocol?.structured || null);
        setTreatmentPlanAppointmentAssignment(data?.plan?.appointmentAssignment || null);
        setTreatmentPlanInventoryBlocks(
          Array.isArray(data?.plan?.inventory?.blocks)
            ? data.plan.inventory.blocks
            : [],
        );
        setTreatmentPlanInventoryWarnings(
          Array.isArray(data?.plan?.inventory?.warnings)
            ? data.plan.inventory.warnings
            : [],
        );
        const selectedCalibration = data?.plan?.equipmentCalibration?.selected;
        // Only auto-adopt the plan's selected calibration when it's field
        // verified — i.e. one of the rows that actually appears in the dropdown.
        // The plan can surface a stale, unverified calibration as `selected`
        // (it's filtered out of the dropdown); auto-filling that would make the
        // visit look like the tech chose equipment they can't see, defeating the
        // calibration advisory bypass and recording an unverified system as used.
        if (
          !equipmentSystemId &&
          selectedCalibration?.equipment_system_id &&
          selectedCalibration.calibration_status === "field_verified"
        ) {
          setEquipmentSystemId(selectedCalibration.equipment_system_id);
          setCalibrationId(selectedCalibration.id || "");
        }
        const requiredTasks =
          data?.plan?.closeout?.requiredProtocolTasks ||
          data?.plan?.protocol?.structured?.window?.requiredTasks ||
          [];
        setProtocolTaskStatus((prev) => {
          const next = { ...prev };
          requiredTasks.forEach((task) => {
            if (!(task in next)) next[task] = false;
          });
          return next;
        });
        if (!protocolTreatedSqft && data?.plan?.mixCalculator?.lawnSqft) {
          setProtocolTreatedSqft(String(data.plan.mixCalculator.lawnSqft));
        }
        if (!protocolCarrierGalPer1000 && data?.plan?.mixCalculator?.carrierGalPer1000) {
          setProtocolCarrierGalPer1000(String(data.plan.mixCalculator.carrierGalPer1000));
        }
        const baseItems = data?.plan?.protocol?.base || [];
        const conditionalItems = data?.plan?.protocol?.conditional || [];
        const mixItems = data?.plan?.mixCalculator?.items || [];
        setTreatmentPlanSubstitutions(
          mixItems.map((item) => item?.substitution).filter(Boolean),
        );
        const productIdsFor = (items) =>
          items
            .map((item) => item?.product?.id || item?.productId)
            .filter(Boolean)
            .map(String);
        setTreatmentPlanProductIds([
          ...new Set(
            productIdsFor([...baseItems, ...conditionalItems, ...mixItems]),
          ),
        ]);
        setTreatmentPlanPlannedProductIds([
          ...new Set(productIdsFor([...baseItems, ...mixItems])),
        ]);
      })
      .catch((err) => {
        if (!cancelled)
          setTreatmentPlanError(err.message || "Could not load WaveGuard plan");
      });
    return () => {
      cancelled = true;
    };
  }, [
    calibrationRequired,
    service.id,
    equipmentSystemId,
    calibrationId,
    lawnAssessmentRevision,
  ]);

  useEffect(() => {
    setTreeShrubCloseout(defaultTreeShrubCloseout(service));
  }, [service.id]);

  useEffect(() => {
    draftReadyRef.current = false;
    setSavedDraft(null);
    setShowDraftPrompt(false);
    try {
      const raw = localStorage.getItem(completionDraftKey(service.id));
      if (raw) {
        const draft = JSON.parse(raw);
        if (draft && draft.serviceId === service.id) {
          setSavedDraft(draft);
          setShowDraftPrompt(true);
        }
      }
    } catch {
      localStorage.removeItem(completionDraftKey(service.id));
    } finally {
      draftReadyRef.current = true;
    }
  }, [service.id]);

  useEffect(() => {
    if (!draftReadyRef.current || showDraftPrompt || success) return;
    const hasDraftContent =
      notes.trim() ||
      customerRecap.trim() ||
      selectedProducts.length ||
      areasServiced.length ||
      customerInteraction ||
      customerConcern.trim() ||
      selectedProtocolActionLabels.length ||
      selectedObservationLabels.length ||
      selectedRecommendationLabels.length ||
      nextVisitNote.trim() ||
      oneTimeRecapOnly ||
      reviewTiming !== "120" ||
      reviewCustomAt.trim() ||
      tankLastProduct.trim() ||
      tankCleanoutCompleted ||
      tankCleanoutMethod.trim() ||
      tankCleanoutNote.trim() ||
      JSON.stringify(treeShrubCloseout) !== JSON.stringify(defaultTreeShrubCloseout(service)) ||
      Object.keys(findingsValues).length ||
      typedActivityScore != null ||
      typedNextStepChips.length ||
      typedRecommendations.trim() ||
      Object.values(companionState).some(
        (entry) =>
          Object.keys(entry?.values || {}).length ||
          (entry?.chips || []).length ||
          entry?.score != null,
      ) ||
      visitOutcome !== "completed";
    if (!hasDraftContent) return;

    const draft = {
        serviceId: service.id,
        savedAt: new Date().toISOString(),
        notes,
        selectedProducts,
        sendSms,
        includePayLink,
        requestReview,
        reviewTiming,
        reviewCustomAt,
        oneTimeRecapOnly,
        visitOutcome,
        customerRecap,
        recapSource,
        areasServiced,
        customerInteraction,
        customerConcern,
        selectedProtocolActionLabels,
        actionScopeByLabel,
        selectedObservationLabels,
        selectedRecommendationLabels,
        nextVisitNote,
        showNextVisitNote,
        equipmentSystemId,
        calibrationId,
        officeApprovalReasonCode,
        officeApprovalNote,
        nLimitApprovalReasonCode,
        nLimitApprovalNote,
        managerApprovalReasonCode,
        managerApprovalNote,
        tankLastProduct,
        tankLastProductCategory,
        tankCleanoutCompleted,
        tankCleanoutMethod,
        tankCleanoutNote,
        treeShrubCloseout,
        // Typed specialty findings — must survive the billing-409 checkout
        // detour (the panel closes while the tech collects payment).
        findingsValues,
        typedActivityScore,
        typedActivityTouched,
        typedNextStepChips,
        typedRecommendations,
        // Companion section state rides the same draft (and the same
        // billing-409 checkout detour survival).
        companionState,
      };
    // Latest draft is always reachable synchronously — the billing-409
    // detour unmounts this panel before the debounce timer fires, and the
    // cleanup below would otherwise drop the newest edits.
    draftSnapshotRef.current = draft;
    const timer = setTimeout(() => {
      localStorage.setItem(
        completionDraftKey(service.id),
        JSON.stringify(draft),
      );
    }, 700);
    return () => clearTimeout(timer);
  }, [
    service.id,
    showDraftPrompt,
    success,
    notes,
    selectedProducts,
    sendSms,
    includePayLink,
    requestReview,
    reviewTiming,
    reviewCustomAt,
    oneTimeRecapOnly,
    visitOutcome,
    customerRecap,
    recapSource,
    areasServiced,
    customerInteraction,
    customerConcern,
    selectedProtocolActionLabels,
    actionScopeByLabel,
    selectedObservationLabels,
    selectedRecommendationLabels,
    nextVisitNote,
    showNextVisitNote,
    equipmentSystemId,
    calibrationId,
    officeApprovalReasonCode,
    officeApprovalNote,
    nLimitApprovalReasonCode,
    nLimitApprovalNote,
    managerApprovalReasonCode,
    managerApprovalNote,
    tankLastProduct,
    tankLastProductCategory,
    tankCleanoutCompleted,
    tankCleanoutMethod,
    tankCleanoutNote,
    treeShrubCloseout,
    findingsValues,
    typedActivityScore,
    typedActivityTouched,
    typedNextStepChips,
    typedRecommendations,
    companionState,
    service.city,
    service.address,
    service.serviceAddress,
    service.propertyAddress,
  ]);

  function restoreDraft() {
    if (!savedDraft) return;
    setNotes(savedDraft.notes || "");
    setSelectedProducts(
      Array.isArray(savedDraft.selectedProducts)
        ? savedDraft.selectedProducts.map((product) =>
            normalizeProductArea(product, serviceTypeForArea),
          )
        : [],
    );
    setSendSms(savedDraft.sendSms !== false);
    setIncludePayLink(savedDraft.includePayLink !== false);
    setRequestReview(savedDraft.requestReview !== false);
    setReviewTiming(savedDraft.reviewTiming || "120");
    setReviewCustomAt(savedDraft.reviewCustomAt || "");
    setOneTimeRecapOnly(!!savedDraft.oneTimeRecapOnly);
    setVisitOutcome(savedDraft.visitOutcome || "completed");
    setCustomerRecap(savedDraft.customerRecap || "");
    setRecapSource(savedDraft.recapSource || "draft");
    setRecapDraftStatus(
      savedDraft.recapSource === "manual" ? "manual" : "ready",
    );
    setRecapStaleAfterEdit(false);
    setAreasServiced(
      Array.isArray(savedDraft.areasServiced) ? savedDraft.areasServiced : [],
    );
    setCustomerInteraction(
      normalizeCustomerInteractionValue(savedDraft.customerInteraction),
    );
    setCustomerConcern(savedDraft.customerConcern || "");
    setSelectedProtocolActionLabels(
      Array.isArray(savedDraft.selectedProtocolActionLabels)
        ? savedDraft.selectedProtocolActionLabels
        : [],
    );
    setActionScopeByLabel(
      savedDraft.actionScopeByLabel && typeof savedDraft.actionScopeByLabel === "object"
        ? savedDraft.actionScopeByLabel
        : {},
    );
    setSelectedObservationLabels(
      Array.isArray(savedDraft.selectedObservationLabels)
        ? savedDraft.selectedObservationLabels
        : [],
    );
    setSelectedRecommendationLabels(
      Array.isArray(savedDraft.selectedRecommendationLabels)
        ? savedDraft.selectedRecommendationLabels
        : [],
    );
    setNextVisitNote(savedDraft.nextVisitNote || "");
    setShowNextVisitNote(!!savedDraft.showNextVisitNote);
    setEquipmentSystemId(savedDraft.equipmentSystemId || "");
    setCalibrationId(savedDraft.calibrationId || "");
    setOfficeApprovalReasonCode(savedDraft.officeApprovalReasonCode || "");
    setOfficeApprovalNote(savedDraft.officeApprovalNote || "");
    setNLimitApprovalReasonCode(savedDraft.nLimitApprovalReasonCode || "");
    setNLimitApprovalNote(savedDraft.nLimitApprovalNote || "");
    setManagerApprovalReasonCode(savedDraft.managerApprovalReasonCode || "");
    setManagerApprovalNote(savedDraft.managerApprovalNote || "");
    setTankLastProduct(savedDraft.tankLastProduct || "");
    setTankLastProductCategory(savedDraft.tankLastProductCategory || "");
    setTankCleanoutCompleted(savedDraft.tankCleanoutCompleted || "");
    setTankCleanoutMethod(savedDraft.tankCleanoutMethod || "");
    setTankCleanoutNote(savedDraft.tankCleanoutNote || "");
    setTreeShrubCloseout(
      normalizeTreeShrubCloseoutDraft(savedDraft.treeShrubCloseout, service),
    );
    // Type-aware pruning against the CURRENT schema — see
    // pruneRestoredFindingsValues for why key presence alone isn't enough.
    const restoredFindings =
      savedDraft.findingsValues && typeof savedDraft.findingsValues === "object"
        ? savedDraft.findingsValues
        : {};
    if (typedFindingsSchema?.fields) {
      pruneRestoredFindingsValues(restoredFindings, typedFindingsSchema.fields);
    }
    setFindingsValues(restoredFindings);
    setTypedActivityScore(
      Number.isInteger(savedDraft.typedActivityScore)
        ? savedDraft.typedActivityScore
        : null,
    );
    setTypedActivityTouched(!!savedDraft.typedActivityTouched);
    const restoredChips = Array.isArray(savedDraft.typedNextStepChips)
      ? savedDraft.typedNextStepChips
      : [];
    setTypedNextStepChips(
      typedFindingsSchema?.nextStepChips
        ? restoredChips.filter((chip) => typedFindingsSchema.nextStepChips.includes(chip))
        : restoredChips,
    );
    setTypedRecommendations(savedDraft.typedRecommendations || "");
    // Companion draft state — the same type-aware pruning per companion
    // schema; saved types the profile no longer declares are dropped, and
    // chips are filtered to the schema's current allowlist.
    const savedCompanions =
      savedDraft.companionState && typeof savedDraft.companionState === "object"
        ? savedDraft.companionState
        : {};
    setCompanionState(
      Object.fromEntries(
        companionSchemas.map((schema) => {
          const saved = savedCompanions[schema.type];
          if (!saved || typeof saved !== "object") {
            return [
              schema.type,
              { values: {}, chips: [], score: null, scoreTouched: false },
            ];
          }
          const values = pruneRestoredFindingsValues(
            saved.values && typeof saved.values === "object"
              ? { ...saved.values }
              : {},
            schema.fields || [],
          );
          const chips = Array.isArray(saved.chips)
            ? saved.chips.filter((chip) =>
                (schema.nextStepChips || []).includes(chip),
              )
            : [];
          return [
            schema.type,
            {
              values,
              chips,
              score: Number.isInteger(saved.score) ? saved.score : null,
              scoreTouched: !!saved.scoreTouched,
            },
          ];
        }),
      ),
    );
    setShowDraftPrompt(false);
  }

  function discardDraft() {
    localStorage.removeItem(completionDraftKey(service.id));
    setSavedDraft(null);
    setShowDraftPrompt(false);
  }

  useEffect(() => {
    if (!canAutoDraftRecap) return;
    if (recapSource === "manual") {
      if (customerRecap.trim()) setRecapStaleAfterEdit(true);
      return;
    }
    const requestId = ++recapRequestRef.current;
    if (recapAbortRef.current) recapAbortRef.current.abort();
    const controller = new AbortController();
    recapAbortRef.current = controller;
    setRecapError("");
    const timer = setTimeout(async () => {
      try {
        setRecapLoading(true);
        setRecapDraftStatus("drafting");
        const result = await adminFetch("/admin/dispatch/recap-preview", {
          method: "POST",
          signal: controller.signal,
          body: JSON.stringify({
            notes,
            visitOutcome,
            serviceType: service.serviceType,
            areasTreated: areasServiced,
            willInvoice,
            willReview: reviewSendsWithCompletionSms,
          }),
        });
        if (requestId !== recapRequestRef.current) return;
        if (result.recap) {
          setCustomerRecap(result.recap);
          setRecapSource(result.source || "");
          setRecapDraftStatus("ready");
          setRecapStaleAfterEdit(false);
        }
      } catch (err) {
        if (err?.name === "AbortError") return;
        if (requestId !== recapRequestRef.current) return;
        setRecapError(err.message || "Could not draft recap");
        setRecapDraftStatus("failed");
      } finally {
        if (requestId === recapRequestRef.current) setRecapLoading(false);
      }
    }, 600);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    canAutoDraftRecap,
    notes,
    selectedProducts.length,
    visitOutcome,
    areasServiced,
    service.serviceType,
    customerInteraction,
    willInvoice,
    reviewSendsWithCompletionSms,
  ]);

  function handleCustomerRecapChange(value) {
    recapRequestRef.current += 1;
    if (recapAbortRef.current) recapAbortRef.current.abort();
    setRecapLoading(false);
    setCustomerRecap(value);
    setRecapSource("manual");
    setRecapDraftStatus("manual");
    setRecapStaleAfterEdit(false);
  }

  async function regenerateCustomerRecap() {
    const requestId = ++recapRequestRef.current;
    if (recapAbortRef.current) recapAbortRef.current.abort();
    const controller = new AbortController();
    recapAbortRef.current = controller;
    setRecapLoading(true);
    setRecapDraftStatus("drafting");
    setRecapError("");
    try {
      const result = await adminFetch("/admin/dispatch/recap-preview", {
        method: "POST",
        signal: controller.signal,
        body: JSON.stringify({
          notes,
          visitOutcome,
          serviceType: service.serviceType,
          areasTreated: areasServiced,
          willInvoice,
          willReview: reviewSendsWithCompletionSms,
          force: true,
        }),
      });
      if (requestId !== recapRequestRef.current) return;
      if (result.recap) {
        setCustomerRecap(result.recap);
        setRecapSource(result.source || "ai");
        setRecapDraftStatus("ready");
        setRecapStaleAfterEdit(false);
      }
    } catch (err) {
      if (requestId !== recapRequestRef.current) return;
      if (err?.name !== "AbortError") {
        setRecapError(err.message || "Could not draft recap");
        setRecapDraftStatus("failed");
      }
    } finally {
      if (requestId === recapRequestRef.current) setRecapLoading(false);
    }
  }

  function addChipNote(prefix, text) {
    const line = `[${prefix}] ${text}`;
    setNotes((prev) => (prev.trim() ? prev.trimEnd() + "\n" + line : line));
  }
  function appendUniqueLabel(setter, text) {
    const label = String(text || "").trim();
    if (!label) return;
    setter((prev) =>
      prev.some((item) => item.toLowerCase() === label.toLowerCase())
        ? prev
        : [...prev, label],
    );
  }
  function labelsStillInNotes(labels) {
    // A selected label only counts as still-active if it appears inside one of
    // the bracketed chip-marker lines ([Protocol]/[Protocol optional]/[Action]/
    // [Found]/[Next] …) — NOT in arbitrary prose. The label arrays are only ever
    // populated alongside a marker (the chip handlers, or a restored draft whose
    // saved notes carry the markers), so this matches the same items as before
    // for normal completions, but makes the deselect handle reliable after
    // Generate: deleting the marker truly removes the item even when the AI prose
    // happens to repeat the label text verbatim.
    const markerLines = notes
      .split("\n")
      .filter((line) => /^\s*\[[^\]]+\]\s/.test(line))
      .map((line) => line.toLowerCase());
    return (Array.isArray(labels) ? labels : []).filter((label) => {
      const text = String(label || "").trim().toLowerCase();
      return text && markerLines.some((line) => line.includes(text));
    });
  }
  // Generate AI report replaces the notes wholesale with AI prose, which would
  // strip the [Protocol]/[Found]/[Next] tagged lines that handleSubmit reads
  // back via labelsStillInNotes to rebuild protocolActionsCompleted + their
  // re-entry/treatment scopes, observations, and recommendations. Re-append the
  // still-selected labels so the structured visit record (and interior-treatment
  // safety scopes) survive drafting.
  function stitchSelectedLabelsIntoReport(reportText) {
    const base = String(reportText || "");
    const lines = [];
    // Always emit an explicit removable marker (don't skip when the prose
    // happens to mention the label verbatim): the marker is the tech's deselect
    // handle, so leaving a still-selected item in prose-only form would make it
    // impossible to deselect before completing.
    const pushLabel = (prefix, label) => {
      const text = String(label || "").trim();
      if (text) lines.push(`[${prefix}] ${text}`);
    };
    // Only re-stitch labels still present in the pre-generation notes — the tech
    // deselects a wrongly-picked item by deleting its tagged line, and
    // handleSubmit honors that via labelsStillInNotes. Stitching the full
    // selected-label state would resurrect a deliberately-removed action (and its
    // re-entry scope) on the next Generate. (notes still holds the pre-draft text
    // here; setNotes(report) hasn't applied yet.)
    labelsStillInNotes(selectedProtocolActionLabels).forEach((l) =>
      pushLabel("Protocol", l),
    );
    labelsStillInNotes(selectedObservationLabels).forEach((l) =>
      pushLabel("Found", l),
    );
    labelsStillInNotes(selectedRecommendationLabels).forEach((l) =>
      pushLabel("Next", l),
    );
    if (!lines.length) return base;
    return base.trimEnd() + "\n\n" + lines.join("\n");
  }
  // The [Protocol]/[Found]/[Next] chip lines are structured selections that ride
  // along in the notes only as the tech's deselect handle — they're already sent
  // as the typed `actionsCompleted`/`observations`/`recommendations` fields. Keep
  // them out of `serviceNotes` so a future-step [Next] recommendation can't get
  // drafted as completed work (the prompt files serviceNotes under COMPLETED WORK).
  function stripChipTagLines(text) {
    return String(text || "")
      .split("\n")
      .filter((line) => !/^\s*\[(?:Protocol(?: optional)?|Action|Found|Next)\]\s/.test(line))
      .join("\n")
      .trim();
  }
  // Single source of truth for the AI report payload + the "is there enough to
  // generate?" gate, so the two Generate buttons (mobile + desktop) and the
  // server can't drift. The payload classifies inputs by provenance so the
  // prompt won't turn a customer concern or a recommendation into a confirmed
  // finding (see the server prompt). photoCount is reported but never enough on
  // its own — the model can't see the photos.
  function buildAiReportPayload() {
    const productsApplied = selectedProducts
      .map((p) => p.name + (p.rate ? ` (${p.rate} ${p.rateUnit})` : ""))
      .join(", ");
    const actionsCompleted = labelsStillInNotes(selectedProtocolActionLabels);
    const observations = labelsStillInNotes(selectedObservationLabels);
    const recommendations = labelsStillInNotes(selectedRecommendationLabels);
    // Mirror the final-submit gate (handleSubmit only sends customerConcernText
    // when the interaction is still "customer had a concern"): if the tech typed
    // a concern then switched the interaction away, the concern input is hidden
    // and must not leak into AI-drafted copy.
    const concern = isCustomerConcernInteraction(customerInteraction)
      ? customerConcern.trim()
      : "";
    const interactionLabel = CUSTOMER_INTERACTION_OPTIONS.find(
      (o) => o.value === normalizeCustomerInteractionValue(customerInteraction),
    )?.label || "";
    // Reporting is ET-only: resolve the visit date so a non-ET device (or a
    // completion logged just past browser-local midnight) can't draft
    // customer-facing copy with the wrong visit date.
    const scheduledDateOnly = String(
      service.scheduledDate || service.scheduled_date || service.date || "",
    ).split("T")[0];
    let serviceDateLabel;
    if (service.checkInTime) {
      // A real timestamp — format the instant in ET.
      serviceDateLabel = new Date(service.checkInTime).toLocaleDateString(
        "en-US",
        { month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York" },
      );
    } else if (/^\d{4}-\d{2}-\d{2}$/.test(scheduledDateOnly)) {
      // Office closeout / backfilled visit: the scheduled date is already an ET
      // calendar date. Render the Y-M-D verbatim (UTC noon + format in UTC) so
      // no browser-local timezone math can shift it a day in either direction.
      const [y, mo, da] = scheduledDateOnly.split("-").map(Number);
      serviceDateLabel = new Date(Date.UTC(y, mo - 1, da, 12)).toLocaleDateString(
        "en-US",
        { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" },
      );
    } else {
      serviceDateLabel = new Date().toLocaleDateString("en-US", {
        month: "long", day: "numeric", year: "numeric", timeZone: "America/New_York",
      });
    }
    const payload = {
      scheduledServiceId: service.id || null,
      customerName: service.customerName,
      serviceType: service.serviceType,
      serviceLine: service.serviceLine || service.service_line || undefined,
      products: selectedProducts.map((p) => ({
        productId: p.productId || null,
        name: p.name,
        rate: p.rate || null,
        rateUnit: p.rateUnit || null,
        targets: Array.isArray(p.targets) ? p.targets : [],
      })),
      technicianName: service.technicianName || "Waves Tech",
      serviceDate: serviceDateLabel,
      arrivalTime: service.checkInTime
        ? new Date(service.checkInTime).toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", hour12: true,
            timeZone: "America/New_York",
          })
        : "",
      serviceNotes: stripChipTagLines(notes),
      productsApplied,
      areasServiced,
      actionsCompleted,
      observations,
      recommendations,
      customerInteraction: interactionLabel,
      customerConcern: concern,
      pestActivityRating: clientPestRating ?? null,
      photoCount: Array.isArray(servicePhotos) ? servicePhotos.length : 0,
    };
    const hasReportInput =
      Boolean(payload.serviceNotes) ||
      productsApplied.length > 0 ||
      areasServiced.length > 0 ||
      actionsCompleted.length > 0 ||
      observations.length > 0 ||
      recommendations.length > 0 ||
      Boolean(concern) ||
      payload.pestActivityRating !== null;
    return { payload, hasReportInput };
  }
  function recordActionScope(label, scope, treatmentApplied) {
    if (!label || (scope !== "interior" && scope !== "exterior")) return;
    setActionScopeByLabel((prev) => ({
      ...prev,
      [label]: { scope, treatmentApplied: treatmentApplied === true },
    }));
  }
  function applyProtocolAction(action) {
    if (!action) return;
    const noteText =
      action.note || action.label || action.raw || "Completed protocol item";
    appendUniqueLabel(setSelectedProtocolActionLabels, noteText);
    recordActionScope(noteText, action.scope, action.treatmentApplied);
    addChipNote(
      action.conditional ? "Protocol optional" : "Protocol",
      noteText,
    );
    if (
      action.product?.id &&
      !selectedProducts.find((p) => p.productId === action.product.id)
    ) {
      addProduct(action.product);
    }
  }
  function handleOneTimeRecapOnlyChange(checked) {
    setOneTimeRecapOnly(checked);
    if (checked) {
      setSendSms(true);
      setRequestReview(true);
    }
  }
  function addProduct(product) {
    // No payload-feeding mutations while an AI draft is in flight — a product
    // added now would land in the submitted structured data but not in the prose
    // the response is about to write (built from the pre-draft snapshot).
    if (generating) return;
    if (selectedProducts.find((p) => p.productId === product.id)) return;
    const applicationMethod = defaultApplicationMethod(product, serviceTypeForArea);
    const areaRequirement = requiredApplicationArea(
      applicationMethod,
      serviceTypeForArea,
    );
    const defaultUnit =
      product.defaultUnit ||
      product.default_unit ||
      product.rateUnit ||
      product.rate_unit ||
      "oz";
    setSelectedProducts((prev) => [
      ...prev,
      {
        productId: product.id,
        name: product.name,
        rate: product.defaultRatePer1000 ?? product.default_rate_per_1000 ?? product.ratePer1000 ?? "",
        rateUnit: defaultUnit,
        catalogRateUnit: product.rateUnit || product.rate_unit || defaultUnit,
        maxLabelRatePer1000:
          product.maxLabelRatePer1000 ??
          product.max_label_rate_per_1000 ??
          null,
        totalAmount: "",
        amountUnit: defaultUnit,
        applicationMethod,
        applicationArea: "",
        areaValue: "",
        areaUnit: areaRequirement?.unit || "",
        targets: [],
      },
    ]);
    setProductSearch("");
  }
  function addSubstitutionProduct(substitution) {
    if (!substitution?.substituteProductId) return;
    addProduct({
      id: substitution.substituteProductId,
      name: substitution.substituteProductName || "Approved substitute",
      defaultRatePer1000: substitution.ratePer1000 || "",
      rateUnit: substitution.rateUnit || "oz",
      defaultUnit: substitution.rateUnit || "oz",
    });
  }
  function removeProduct(productId) {
    if (generating) return;
    setSelectedProducts((prev) =>
      prev.filter((p) => p.productId !== productId),
    );
  }
  function updateProduct(productId, field, value) {
    setSelectedProducts((prev) =>
      prev.map((p) => {
        if (p.productId !== productId) return p;
        const next = { ...p, [field]: value };
        if (field === "applicationMethod") {
          const areaRequirement = requiredApplicationArea(
            value,
            serviceTypeForArea,
          );
          if (areaRequirement) {
            if (next.areaUnit && next.areaUnit !== areaRequirement.unit) {
              next.areaValue = "";
            }
            next.areaUnit = areaRequirement.unit;
          } else {
            next.areaUnit = "";
            next.areaValue = "";
          }
        } else if (field === "areaValue") {
          const areaRequirement = requiredApplicationArea(
            productApplicationMethod(next, serviceTypeForArea),
            serviceTypeForArea,
          );
          if (areaRequirement) next.areaUnit = areaRequirement.unit;
        }
        return next;
      }),
    );
  }
  function toggleArea(area) {
    if (generating) return;
    setAreasServiced((prev) =>
      prev.includes(area) ? prev.filter((a) => a !== area) : [...prev, area],
    );
  }
  function toggleProtocolTask(task) {
    setProtocolTaskStatus((prev) => ({ ...prev, [task]: !prev[task] }));
  }
  function updateSkippedProtocolProduct(product, skipped, reason = "") {
    const key = product.id || product.productId || product.productName;
    if (!key) return;
    setSkippedProtocolProducts((prev) => {
      const next = { ...prev };
      if (!skipped) {
        delete next[key];
        return next;
      }
      next[key] = {
        protocolProductId: product.id || null,
        productId: product.productId || null,
        productName: product.productName || product.protocolProductName || "Protocol product",
        role: product.role || null,
        reason: reason || next[key]?.reason || "Not applied",
      };
      return next;
    });
  }
  function handleEquipmentSelect(value) {
    setEquipmentSystemId(value);
    const selected = equipmentCalibrations.find(
      (c) => c.equipment_system_id === value,
    );
    setCalibrationId(selected?.id || "");
  }
  async function handlePhotoSelect(e) {
    const files = Array.from(e.target.files || []);
    if (servicePhotos.length + files.length > 5) {
      alert("Maximum 5 photos allowed.");
      if (photoInputRef.current) photoInputRef.current.value = "";
      return;
    }
    let failed = 0;
    for (const file of files) {
      try {
        const photo = await prepareCompletionPhoto(file);
        setServicePhotos((prev) => {
          if (prev.length >= 5) return prev;
          return [...prev, photo];
        });
        // The AI photo summary describes a specific photo set — any
        // mutation stales it (captions travel with their photo objects
        // and stay correct). Re-analyze to regenerate.
        setTypedPhotoSummary("");
      } catch {
        failed += 1;
      }
    }
    if (failed > 0) {
      alert(
        `${failed} photo${failed === 1 ? "" : "s"} could not be prepared for completion.`,
      );
    }
    if (photoInputRef.current) photoInputRef.current.value = "";
  }
  function removePhoto(index) {
    setServicePhotos((prev) => prev.filter((_, i) => i !== index));
    setTypedPhotoSummary("");
  }

  async function handleSubmit() {
    if (submitting) return;
    // Don't complete while an AI draft is in flight — the response is about to
    // replace the notes, and submitting now would either lose the generated copy
    // or rebuild the structured fields from soon-to-be-overwritten notes.
    if (generating) {
      alert("Hang on — finishing the AI draft. Try again in a moment.");
      return;
    }
    // The turf-height flag drives a server-required field on lawn visits; don't
    // submit until its state is loaded, or a pre-load submit hides the field the
    // server still enforces (422). The flag is session-cached so this rarely waits.
    if (isLawn && !turfHeightFlagReady) {
      alert("Completion options are still loading — please try again in a moment.");
      return;
    }
    if (calibrationAdvisory) {
      const proceed = window.confirm(
        `${
          calibrationHelpText ||
          "No field-verified calibrated equipment is selected for this WaveGuard lawn visit."
        }\n\nComplete this visit without field-verified calibrated equipment?`,
      );
      if (!proceed) return;
    }
    if (tankCleanoutCompletionBlocked) {
      alert(tankCleanoutHelpText);
      return;
    }
    if (blackoutCompletionBlocked) {
      alert(
        canApproveOfficeExceptions
          ? "Office approval is required before completing this WaveGuard lawn visit during an N/P blackout."
          : "Admin approval is required before completing this WaveGuard lawn visit during an N/P blackout.",
      );
      return;
    }
    if (nLimitCompletionBlocked) {
      alert(
        "Admin approval is required before completing this WaveGuard lawn visit over the annual N budget.",
      );
      return;
    }
    if (managerApprovalCompletionBlocked) {
      alert(
        canApproveOfficeExceptions
          ? "Manager approval is required before completing this WaveGuard protocol exception."
          : "An admin must approve this WaveGuard protocol exception before completion.",
      );
      return;
    }
    if (treeShrubCompletionBlocked) {
      alert(
        `Complete Tree/Shrub closeout before submitting: ${treeShrubCloseoutBlocks
          .map((block) => block.message)
          .join(" ")}`,
      );
      return;
    }
    if (isTypedFindings && !isIncompleteVisit) {
      const missingTypedRequired = (typedFindingsSchema.fields || [])
        .filter(
          (f) =>
            typedFieldRequiredNow(f, findingsValues) &&
            String(findingsValues[f.key] ?? "").trim() === "",
        )
        .map((f) => f.label);
      // Gauge types require a score on any completed-side outcome — the
      // server 422s (activity_score_required) when findings are submitted
      // without one and the derive field can't fill it.
      const typedScoreMissing =
        !!typedFindingsSchema.activity && typedActivityScore == null;
      // Mirror the server's next_step_required 422 pre-submit so the tech
      // gets the same inline validation as other required fields.
      const nextStepMissing =
        !!typedFindingsSchema.nextStepRequired && !typedNextStepChips.length;
      if (missingTypedRequired.length || typedScoreMissing || nextStepMissing) {
        completionTelemetryRef.current.requiredFieldErrorCount += 1;
        alert(
          `Complete the required service findings before submitting: ${[
            ...missingTypedRequired,
            ...(typedScoreMissing ? [typedFindingsSchema.activity.label] : []),
            ...(nextStepMissing ? ["Next steps (select at least one)"] : []),
          ].join(", ")}.`,
        );
        return;
      }
      // A selected chip can go stale when a findings value changes after the
      // tap (the panel disables conflicting chips, but not ones already
      // selected). Mirror the server's rejection pre-submit (Codex P3).
      const chipConflicts = typedNextStepChips
        .map((chip) =>
          typedNextStepChipConflict(
            typedFindingsSchema.type,
            chip,
            findingsValues,
          ),
        )
        .filter(Boolean);
      if (chipConflicts.length) {
        completionTelemetryRef.current.requiredFieldErrorCount += 1;
        alert(
          `Fix the next-step selections before submitting: ${chipConflicts.join("; ")}.`,
        );
        return;
      }
      // A pinned gauge score can likewise go stale when the evidence select
      // changes after the tap. Mirror activity_score_inconsistent pre-submit.
      const scoreConflict = typedActivityScoreConflict(
        typedFindingsSchema.type,
        findingsValues,
        typedActivityScore,
      );
      if (scoreConflict) {
        completionTelemetryRef.current.requiredFieldErrorCount += 1;
        alert(`Fix the activity score before submitting: ${scoreConflict}.`);
        return;
      }
    }
    // Companion sections mirror every primary typed pre-submit gate PER
    // COMPANION (server-side conditional checks without client mirrors are
    // a known Codex flag). Messages prefix the companion's label so the
    // tech knows which section to fix.
    if (companionSchemas.length && !isIncompleteVisit) {
      for (const schema of companionSchemas) {
        const entry = companionState[schema.type] || EMPTY_COMPANION_ENTRY;
        const label = schema.label || schema.type;
        const missingCompanionRequired = (schema.fields || [])
          .filter(
            (f) =>
              typedFieldRequiredNow(f, entry.values) &&
              String(entry.values[f.key] ?? "").trim() === "",
          )
          .map((f) => f.label);
        const companionScoreMissing = !!schema.activity && entry.score == null;
        const companionNextStepMissing =
          !!schema.nextStepRequired && !entry.chips.length;
        if (
          missingCompanionRequired.length ||
          companionScoreMissing ||
          companionNextStepMissing
        ) {
          completionTelemetryRef.current.requiredFieldErrorCount += 1;
          alert(
            `${label}: complete the required service findings before submitting: ${[
              ...missingCompanionRequired,
              ...(companionScoreMissing ? [schema.activity.label] : []),
              ...(companionNextStepMissing
                ? ["Next steps (select at least one)"]
                : []),
            ].join(", ")}.`,
          );
          return;
        }
        const companionChipConflicts = entry.chips
          .map((chip) =>
            typedNextStepChipConflict(schema.type, chip, entry.values),
          )
          .filter(Boolean);
        if (companionChipConflicts.length) {
          completionTelemetryRef.current.requiredFieldErrorCount += 1;
          alert(
            `${label}: fix the next-step selections before submitting: ${companionChipConflicts.join("; ")}.`,
          );
          return;
        }
        const companionScoreConflict = typedActivityScoreConflict(
          schema.type,
          entry.values,
          entry.score,
        );
        if (companionScoreConflict) {
          completionTelemetryRef.current.requiredFieldErrorCount += 1;
          alert(
            `${label}: fix the activity score before submitting: ${companionScoreConflict}.`,
          );
          return;
        }
      }
    }
    if (
      calibrationRequired &&
      !isIncompleteVisit &&
      missingProtocolTasks.length
    ) {
      alert(
        `Complete the required protocol checklist before closeout: ${missingProtocolTasks
          .map((task) => task.replace(/_/g, " "))
          .join(", ")}.`,
      );
      return;
    }
    if (
      calibrationRequired &&
      !isIncompleteVisit &&
      undispositionedDefaultProtocolProducts.length
    ) {
      alert(
        `Mark each default protocol product as applied or skipped before closeout: ${undispositionedDefaultProtocolProducts
          .map((product) => product.productName)
          .filter(Boolean)
          .join(", ")}.`,
      );
      return;
    }
    if (
      calibrationRequired &&
      !isIncompleteVisit &&
      selectedProductsMissingActualAmount.length
    ) {
      alert(
        `Enter actual product amount and unit before closeout: ${selectedProductsMissingActualAmount
          .map((product) => product.name || "Selected product")
          .join(", ")}.`,
      );
      return;
    }
    if (
      calibrationRequired &&
      !isIncompleteVisit &&
      treatmentPlanInventoryBlocks.length
    ) {
      alert(
        `Resolve inventory blocks before closeout: ${treatmentPlanInventoryBlocks
          .map((block) => block.message)
          .filter(Boolean)
          .join(" ")}`,
      );
      return;
    }
    const selectedReviewDelayMinutes = reviewDelayMinutes();
    const selectedReviewScheduledFor = reviewScheduledFor();
    if (!oneTimeRecapOnly && willReview && selectedReviewDelayMinutes === null) {
      alert("Choose a review request time.");
      return;
    }
    if (!oneTimeRecapOnly && willReview && reviewTiming === "custom") {
      const target = new Date(reviewCustomAt);
      if (
        !reviewCustomAt ||
        Number.isNaN(target.getTime()) ||
        target.getTime() <= Date.now()
      ) {
        alert("Choose a future review request time.");
        return;
      }
    }
      const missingRequiredAreaProduct = selectedProducts.find((p) => {
        const areaRequirement = requiredApplicationArea(
          productApplicationMethod(p, serviceTypeForArea),
          serviceTypeForArea,
        );
      if (!areaRequirement) return false;
      const value = Number(p.areaValue);
      return !Number.isFinite(value) || value <= 0 || p.areaUnit !== areaRequirement.unit;
    });
    if (!isIncompleteVisit && missingRequiredAreaProduct) {
        const areaRequirement = requiredApplicationArea(
          productApplicationMethod(missingRequiredAreaProduct, serviceTypeForArea),
          serviceTypeForArea,
        );
      alert(`Enter ${areaRequirement.alertLabel} for ${missingRequiredAreaProduct.name}.`);
      return;
    }
    setSubmitting(true);
    try {
      if (!completionIdempotencyKeyRef.current) {
        completionIdempotencyKeyRef.current = createCompletionIdempotencyKey(
          service.id,
        );
      }
      const reportProtocolActions = labelsStillInNotes(
        selectedProtocolActionLabels,
      );
      const reportProtocolActionScopes = reportProtocolActions
        .map((label) => {
          const meta = actionScopeByLabel[label];
          if (!meta) return null;
          return { label, scope: meta.scope, treatmentApplied: meta.treatmentApplied === true };
        })
        .filter(Boolean);
      const reportObservations = labelsStillInNotes(selectedObservationLabels);
      // Typed mode appends the optional recommendations textarea into the
      // existing recommendations array — no new server field.
      const reportRecommendations = [
        ...labelsStillInNotes(selectedRecommendationLabels),
        ...(isTypedFindings && typedRecommendations.trim()
          ? [typedRecommendations.trim()]
          : []),
      ];
      const body = {
        idempotencyKey: completionIdempotencyKeyRef.current,
        technicianNotes: notes,
        customerRecap,
        visitOutcome,
        reviewSuppression: reviewSuppressionReason,
        equipmentSystemId: equipmentSystemId || null,
        calibrationId: calibrationId || null,
        officeApproval:
          blackoutApprovalRequired && canApproveOfficeExceptions
            ? {
                reasonCode: officeApprovalReasonCode,
                note: officeApprovalNote,
              }
            : null,
        nLimitApproval:
          nLimitApprovalRequired && canApproveOfficeExceptions
            ? {
                reasonCode: nLimitApprovalReasonCode,
                note: nLimitApprovalNote,
              }
            : null,
        managerApproval:
          managerApprovalRequired && canApproveOfficeExceptions
            ? {
                reasonCode: managerApprovalReasonCode,
                note: managerApprovalNote,
              }
            : null,
        tankCleanout: tankCleanoutRequired
          ? {
              lastProductInTank: tankLastProduct,
              lastProductCategory: tankLastProductCategory,
              cleanoutCompleted: tankCleanoutCompleted === "yes",
              cleanoutMethod: tankCleanoutMethod,
              note: tankCleanoutNote,
            }
          : null,
        products: selectedProducts.map((p) => ({
          productId: p.productId,
          rate: p.rate,
          rateUnit: p.rateUnit,
            totalAmount: p.totalAmount,
            amountUnit: p.amountUnit,
            applicationMethod: productApplicationMethod(p, serviceTypeForArea),
          applicationArea:
            p.applicationArea ||
            (areasServiced.length === 1 ? areasServiced[0] : null),
          areaValue: p.areaValue,
          areaUnit: p.areaUnit,
          targets: Array.isArray(p.targets) ? p.targets : [],
        })),
        lawnProtocolCompletion:
          calibrationRequired && treatmentPlanStructuredProtocol
            ? {
                checklist: requiredProtocolTasks.map((task) => ({
                  key: task,
                  label: task.replace(/_/g, " "),
                  completed: !!protocolTaskStatus[task],
                })),
                treatedSqft: protocolTreatedSqft
                  ? Number(protocolTreatedSqft)
                  : null,
                carrierGalPer1000: protocolCarrierGalPer1000
                  ? Number(protocolCarrierGalPer1000)
                  : null,
                skippedProducts: Object.values(skippedProtocolProducts),
              }
            : null,
        treeShrubCompletion: treeShrubCloseoutRequired
          ? {
              ...treeShrubCloseout,
              customerNote:
                treeShrubCloseout.customerNote || customerRecap || notes || "",
            }
          : null,
        oneTimeRecapOnly,
        sendCompletionSms: effectiveSendSms,
        // Only meaningful when an invoice/pay link would be texted; mirror the
        // sub-toggle's visibility (invoice + SMS being sent) so a stale false
        // never posts when the completion SMS is off. false = report-only SMS.
        includePayLink: willInvoice && effectiveSendSms ? includePayLink : true,
        requestReview: oneTimeRecapOnly ? !reviewSuppressionReason : willReview,
        reviewTiming: oneTimeRecapOnly ? "now" : reviewTiming,
        reviewDelayMinutes: selectedReviewDelayMinutes,
        reviewScheduledFor: oneTimeRecapOnly
          ? null
          : selectedReviewScheduledFor,
        areasTreated: areasServiced,
        timeOnSite: elapsed,
        areasServiced,
        customerInteraction: normalizeCustomerInteractionValue(customerInteraction),
        protocolActionsCompleted: reportProtocolActions,
        protocolActionScopesCompleted: reportProtocolActionScopes,
        observations: reportObservations,
        recommendations: reportRecommendations,
        lawnAssessmentId,
        // Tree & Shrub tech-reviewed assessment (flag-gated). When the closeout AI
        // review ran, carry the scores + the tech's confirm/hide/edit decisions so
        // the server persists THOSE (no re-score). Absent → server auto-scores.
        treeShrubReview:
          treeShrubCloseoutOn && treeShrubReview && treeShrubReview.scores
            ? {
                scores: treeShrubReview.scores,
                observations: treeShrubReview.observations || "",
                // How many photos the preview actually scored — lets the server detect a
                // preview that skipped a photo (vision failure) and re-score instead.
                scoredCount: treeShrubReview.scoredCount,
                // Server HMAC proving these scores came from /assess-preview (anti-tamper).
                signature: treeShrubReview.signature,
                decisions: treeShrubDecisionsRef.current
                  || (treeShrubReview.findings || []).map((f) => ({ key: f.key, action: f.defaultAction || "monitor", detail: f.detail })),
              }
            : undefined,
        completionPhotos: servicePhotos.map((photo, index) => ({
          data: photo.data,
          name: photo.name || `service-photo-${index + 1}.jpg`,
          photoType: "after",
          sortOrder: index,
          capturedAt: photo.capturedAt || null,
          caption: photo.caption || null,
          ...(photo.captionSource === "ai" ? { aiTags: { captionSource: "ai" } } : {}),
        })),
        // Turf height-of-cut (lawn only, behind the flag). The server gates +
        // snapshots the authoritative band; off-flag/non-lawn these are inert.
        ...(turfHeightFlag && isLawn ? {
          manualHeightIn: turfHeight.heightIn,
          gaugePhoto: turfHeight.gaugePhoto,
          turfHeightOverrideReason: turfHeight.overrideReason,
        } : {}),
      };
      if (isCustomerConcernInteraction(customerInteraction) && customerConcern) {
        body.customerConcernText = customerConcern;
      }
      // Only include the rating when the tech actually entered one — null
      // means "no opinion" and lets the engine fall back to customer-side
      // input (or no input at all). Send as a real integer so backend's
      // strict validation passes.
      if (clientPestRating != null && Number.isInteger(clientPestRating)) {
        body.clientPestRating = clientPestRating;
      }
      // Typed specialty findings payload. Skipped on incomplete visits —
      // the server ignores typed findings for them anyway.
      if (isTypedFindings && !isIncompleteVisit) {
        body.structuredFindings = {
          type: typedFindingsSchema.type,
          values: findingsValues,
        };
        if (typedActivityScore != null) {
          body.activityScore = typedActivityScore;
          body.activityScoreSource = typedActivityTouched
            ? "technician"
            : "derived";
        }
        body.nextStepChips = typedNextStepChips;
        if (typedPhotoSummary.trim() && servicePhotos.length) {
          body.typedPhotoSummary = typedPhotoSummary.trim();
        }
        body.completionTelemetry = {
          ...completionTelemetryRef.current,
          submitClickedAt: new Date().toISOString(),
          aiDraftUsed: typedAiDraftUsed,
          recommendationTextEdited: typedRecommendationsEdited,
          activityScoreTouched: typedActivityTouched,
        };
      }
      // Companion findings payload (combined-service-completions.md) —
      // ordered as the schemas arrived (declared profile order). Skipped on
      // incomplete visits; the server skips companions for them entirely.
      if (companionSchemas.length && !isIncompleteVisit) {
        body.companionFindings = companionSchemas.map((schema) => {
          const entry = companionState[schema.type] || EMPTY_COMPANION_ENTRY;
          return {
            type: schema.type,
            values: entry.values,
            nextStepChips: entry.chips,
            // Same pin semantics as the primary: untouched-and-derived
            // submits as 'derived', any tap pins 'technician'.
            ...(entry.score != null
              ? {
                  activityScore: entry.score,
                  activityScoreSource: entry.scoreTouched
                    ? "technician"
                    : "derived",
                }
              : {}),
          };
        });
      }
      if (nextVisitNote) {
        body.nextVisitAdjustmentNote = nextVisitNote;
      }
      if (service?.completionInvoiceAlreadySent) {
        body.invoiceAlreadySent = true;
      }
      const result = await onSubmit(service.id, body);
      const photoResult = result?.completionPhotoUpload;
      if (photoResult?.failed > 0) {
        alert(
          `Service completed, but ${photoResult.failed} photo${photoResult.failed === 1 ? "" : "s"} failed to upload.`,
        );
      }
      localStorage.removeItem(completionDraftKey(service.id));
      setCompletionResult(result || null);
      setSuccess(true);
      const smsNeedsAttention = ["blocked", "failed"].includes(
        result?.completionSmsStatus,
      );
      // A required follow-up suggestion keeps the success overlay open so
      // the tech can act on the CTA — it dismisses via the Done button.
      // Keep the panel open when a pest recap is pending — it renders async and the
      // tech approves/sends it from the success overlay (the approve UI is otherwise
      // unreachable once the panel auto-closes).
      // Keep the success overlay open when the annual-prepay CTA is available so
      // the operator can act on it — otherwise the ~1.2s auto-close unmounts the
      // button (and the prepay modal) mid-flow on the common no-recap path.
      if (!result?.followupSuggestion?.required && !recapEligible && !showPrepayCta) {
        setTimeout(() => onClose(true), smsNeedsAttention ? 3200 : 1200);
      }
    } catch (e) {
      if (shouldResetCompletionIdempotencyKey(e)) {
        completionIdempotencyKeyRef.current = null;
      }
      const billingRequired =
        e?.status === 409 &&
        (e?.code === "completion_billing_required" ||
          /invoice or payment is required/i.test(e?.message || ""));
      if (billingRequired) {
        // Typed one-time billing gate — route to the existing checkout
        // flow. Flush the draft synchronously first: the panel unmounts on
        // detour, which cancels the debounced write and would lose edits
        // made in the last 700ms.
        if (draftSnapshotRef.current) {
          try {
            localStorage.setItem(
              completionDraftKey(service.id),
              JSON.stringify(draftSnapshotRef.current),
            );
          } catch { /* storage full — draft prompt simply won't restore */ }
        }
        alert(
          "An invoice or payment is required before completing this one-time service." +
            (onBillingRequired ? " Opening checkout." : ""),
        );
        if (onBillingRequired) onBillingRequired(service);
      } else {
        alert("Failed to complete service: " + e.message);
      }
    }
    setSubmitting(false);
  }

  const filteredProducts = (products || []).filter((p) =>
    p.name.toLowerCase().includes(productSearch.toLowerCase()),
  );
  const selectedCalibration =
    equipmentCalibrations.find(
      (c) => c.equipment_system_id === equipmentSystemId,
    ) || null;
  const selectedCalibrationExpired =
    !!selectedCalibration?.expires_at &&
    new Date(selectedCalibration.expires_at).getTime() < Date.now();
  const selectedCalibrationUnverified =
    !!selectedCalibration &&
    selectedCalibration.calibration_status !== "field_verified";
  // WaveGuard calibration is advisory at completion, not a hard gate: when no
  // field-verified calibrated equipment is on record (or the selected one is
  // expired/unverified) the tech can still close out — calibrationId is sent as
  // null — after acknowledging a warning, rather than being trapped on this screen.
  const calibrationAdvisory =
    calibrationRequired &&
    !isIncompleteVisit &&
    (!equipmentSystemId ||
      selectedCalibrationExpired ||
      selectedCalibrationUnverified);
  const calibrationHelpText =
    equipmentCalibrationError ||
    (selectedCalibrationUnverified
      ? "Selected calibration is not field verified — verify it when you can. You can still complete this visit."
      : selectedCalibrationExpired
      ? "Selected calibration is expired — record a new one when you can. You can still complete this visit."
      : !equipmentSystemId && calibrationRequired
        ? "No field-verified calibrated equipment on record. You can complete without it; calibration is recorded as none."
        : calibrationRequired
          ? "WaveGuard lawn visits should use field-verified calibrated spray equipment when available."
          : "");
  function isProtocolActionSelected(action) {
    const noteText = action?.note || action?.label || action?.raw || "";
    return (
      (!!noteText && notes.includes(noteText)) ||
      (action?.product?.id &&
        selectedProducts.some((p) => p.productId === action.product.id))
    );
  }
  const protocolActionSelectOptions = protocolActions.map((action, index) => ({
    value: action.id ? String(action.id) : `action-${index}`,
    label: action.label || action.note || action.raw || "Protocol action",
    selected: isProtocolActionSelected(action),
    action,
  }));
  const selectedProtocolActionCount = protocolActionSelectOptions.filter(
    (opt) => opt.selected,
  ).length;
  function handleProtocolActionSelect(value) {
    if (!value) return;
    // No note-mutating selections while an AI draft is in flight — the chip line
    // would be clobbered when the response replaces the notes, and handleSubmit
    // would rebuild the structured fields from the overwritten text. (The select
    // is value="" so it stays on the placeholder; nothing to reset.)
    if (generating) return;
    if (!protocolActions.length) {
      appendUniqueLabel(setSelectedProtocolActionLabels, value);
      const chip = CHIP_ACTION_BY_LABEL[value];
      if (chip) recordActionScope(value, chip.scope, chip.treatmentApplied);
      addChipNote("Action", value);
      return;
    }
    const option = protocolActionSelectOptions.find(
      (opt) => opt.value === value,
    );
    if (option?.action) applyProtocolAction(option.action);
  }
  function handleObservationSelect(value) {
    if (value && !generating) {
      appendUniqueLabel(setSelectedObservationLabels, value);
      addChipNote("Found", value);
    }
  }
  function handleRecommendationSelect(value) {
    if (value && !generating) {
      appendUniqueLabel(setSelectedRecommendationLabels, value);
      addChipNote("Next", value);
    }
  }
  function markTypedFirstFieldTouch() {
    if (!completionTelemetryRef.current.firstFieldTouchedAt) {
      completionTelemetryRef.current.firstFieldTouchedAt =
        new Date().toISOString();
    }
  }
  function handleTypedFindingChange(key, value) {
    markTypedFirstFieldTouch();
    setFindingsValues((prev) => ({ ...prev, [key]: value }));
    // Derived prefill (contract §4): while the picker is untouched, the
    // score recomputes from the derive-field select on every change.
    const activity = typedFindingsSchema?.activity;
    if (activity?.deriveField === key && !typedActivityTouched) {
      const derived = activity.deriveScores?.[String(value)];
      setTypedActivityScore(derived == null ? null : derived);
    }
  }
  function handleTypedActivityTap(n) {
    markTypedFirstFieldTouch();
    // First tap pins technician-set, even when the value doesn't change.
    setTypedActivityTouched(true);
    setTypedActivityScore(n);
  }
  function toggleTypedNextStepChip(chip) {
    markTypedFirstFieldTouch();
    setTypedNextStepChips((prev) => {
      if (prev.includes(chip)) return prev.filter((c) => c !== chip);
      if (prev.length >= 4) return prev;
      return [...prev, chip];
    });
  }
  function handleTypedRecommendationsChange(value) {
    markTypedFirstFieldTouch();
    setTypedRecommendations(value);
    setTypedRecommendationsEdited(true);
  }
  // Companion section handlers — mirror the primary typed handlers PER
  // companion type, including derive-then-pin: while a companion's gauge is
  // untouched, its score recomputes from the schema's derive-field select on
  // every change; the first tap pins technician-set.
  function handleCompanionFieldChange(type, key, value) {
    markTypedFirstFieldTouch();
    setCompanionState((prev) => {
      const entry = prev[type] || EMPTY_COMPANION_ENTRY;
      const next = { ...entry, values: { ...entry.values, [key]: value } };
      const activity = companionSchemas.find((s) => s.type === type)?.activity;
      if (activity?.deriveField === key && !entry.scoreTouched) {
        const derived = activity.deriveScores?.[String(value)];
        next.score = derived == null ? null : derived;
      }
      return { ...prev, [type]: next };
    });
  }
  function handleCompanionActivityTap(type, n) {
    markTypedFirstFieldTouch();
    // First tap pins technician-set, even when the value doesn't change.
    setCompanionState((prev) => ({
      ...prev,
      [type]: {
        ...(prev[type] || EMPTY_COMPANION_ENTRY),
        score: n,
        scoreTouched: true,
      },
    }));
  }
  function toggleCompanionNextStepChip(type, chip) {
    markTypedFirstFieldTouch();
    setCompanionState((prev) => {
      const entry = prev[type] || EMPTY_COMPANION_ENTRY;
      const chips = entry.chips.includes(chip)
        ? entry.chips.filter((c) => c !== chip)
        : entry.chips.length >= 4
          ? entry.chips
          : [...entry.chips, chip];
      return { ...prev, [type]: { ...entry, chips } };
    });
  }
  // Optional AI polish — failures surface inline and never block submit;
  // the Complete button stays usable while a draft is in flight.
  async function handleTypedAiDraft() {
    if (typedAiDrafting || !typedFindingsSchema) return;
    setTypedAiError("");
    setTypedAiDrafting(true);
    try {
      const r = await adminFetch(
        `/admin/dispatch/${service.id}/findings-recap/draft`,
        {
          method: "POST",
          body: JSON.stringify({
            structuredFindings: {
              type: typedFindingsSchema.type,
              values: findingsValues,
            },
            nextStepChips: typedNextStepChips,
            includeCustomerComms: typedAiIncludeComms,
          }),
        },
      );
      if (r?.draft) {
        setTypedRecommendations(r.draft);
        setTypedRecommendationsEdited(false);
        setTypedAiDraftUsed(true);
      } else {
        setTypedAiError("AI draft unavailable — write manually or skip.");
      }
    } catch {
      setTypedAiError("AI draft unavailable — write manually or skip.");
    }
    setTypedAiDrafting(false);
  }
  // Optional AI photo analysis — sends the attached photos (still local
  // data-URLs pre-submit) for a customer-facing summary + per-photo
  // captions. Failures surface inline and never block submit.
  async function handlePhotoAnalyze() {
    if (photoAnalyzing || !typedFindingsSchema || !servicePhotos.length) return;
    setPhotoAiError("");
    setPhotoAnalyzing(true);
    // Snapshot the analyzed photo identities: photos can be added/removed
    // while the request is in flight, and captions must attach to the
    // photos that were actually analyzed — never by index into whatever
    // the list is at response time.
    const analyzed = servicePhotos;
    try {
      const r = await adminFetch(
        `/admin/dispatch/${service.id}/photo-analysis/draft`,
        {
          method: "POST",
          body: JSON.stringify({
            photos: analyzed.map((photo, index) => ({
              data: photo.data,
              name: photo.name || `service-photo-${index + 1}.jpg`,
            })),
            structuredFindings: {
              type: typedFindingsSchema.type,
              values: findingsValues,
            },
          }),
        },
      );
      if (r?.photoSummary) {
        // Captions anchor to the analyzed photo objects — safe under any
        // interleaving. The summary describes the SET, so it only saves
        // when the current set (via ref — state captured before the await
        // is stale) is exactly what was analyzed.
        const current = servicePhotosRef.current;
        const setUnchanged = current.length === analyzed.length
          && analyzed.every((photo) => current.includes(photo));
        setServicePhotos((prev) =>
          prev.map((photo) => {
            const idx = analyzed.indexOf(photo);
            return idx !== -1 && r.captions?.[idx]
              ? { ...photo, caption: r.captions[idx], captionSource: "ai" }
              : photo;
          }),
        );
        if (setUnchanged) {
          setTypedPhotoSummary(r.photoSummary);
        } else {
          setTypedPhotoSummary("");
          setPhotoAiError("Photos changed during analysis — analyze again for an updated summary.");
        }
      } else {
        setPhotoAiError("Photo analysis unavailable — caption manually or skip.");
      }
    } catch {
      setPhotoAiError("Photo analysis unavailable — caption manually or skip.");
    }
    setPhotoAnalyzing(false);
  }
  // ────────────────────────────────────────────────────────────────────
  // Mobile admin render — follows reference_waves_admin_ui_system.md
  // Light mode only. Roboto body. No D.palette.
  // ────────────────────────────────────────────────────────────────────
  if (isMobile) {
    const M = {
      page: "#FAFAFA",
      card: "#FFFFFF",
      pressed: "#F5F5F5",
      muted: "#F5F5F5",
      hairline: "#E5E5E5",
      subtle: "#EEEEEE",
      ink: "#111111",
      ink2: "#333333",
      ink3: "#737373",
      ink4: "#A3A3A3",
      success: "#16A34A",
      warn: "#EA580C",
      err: "#C2410C",
      info: "#2563EB",
      actionBg: "#111111",
      actionBgActive: "#000000",
      actionFg: "#FFFFFF",
      destructive: "#C2410C",
    };
    const font = "'Roboto', Arial, sans-serif";
    const mono = "'JetBrains Mono', ui-monospace, Menlo, monospace";

    const eyebrowStyle = {
      display: "block",
      fontFamily: font,
      fontSize: 11,
      fontWeight: 600,
      color: M.ink4,
      textTransform: "uppercase",
      letterSpacing: "0.3px",
      marginBottom: 8,
    };
    const mInput = {
      width: "100%",
      boxSizing: "border-box",
      height: 48,
      padding: "0 16px",
      background: M.card,
      color: M.ink,
      border: `1px solid ${M.hairline}`,
      borderRadius: 12,
      fontFamily: font,
      fontSize: 16,
      fontWeight: 400,
      lineHeight: 1.5,
      outline: "none",
      WebkitAppearance: "none",
    };
    const mSelect = {
      ...mInput,
      paddingRight: 40,
      WebkitAppearance: "menulist",
      appearance: "auto",
    };
    const mTextarea = {
      ...mInput,
      height: "auto",
      padding: 14,
      resize: "vertical",
    };
    const primaryPill = {
      width: "100%",
      height: 48,
      border: "none",
      borderRadius: 999,
      background: M.actionBg,
      color: M.actionFg,
      fontFamily: font,
      fontSize: 14,
      fontWeight: 600,
      textTransform: "uppercase",
      letterSpacing: "0.3px",
      cursor: "pointer",
      display: "inline-flex",
      alignItems: "center",
      justifyContent: "center",
      gap: 8,
    };
    const secondaryPill = {
      ...primaryPill,
      background: "transparent",
      color: M.ink,
      border: `1px solid ${M.ink}`,
    };
    const tertiaryPill = {
      ...primaryPill,
      background: "transparent",
      color: M.ink,
      height: 44,
    };

    // Field / Chip are hoisted above CompletionPanel so they survive
    // re-renders without unmounting the inputs inside them.
    const Field = CPField;
    const Chip = CPChip;

    return createPortal(
      <>
        {" "}
        <div
          role="presentation"
          onClick={() => onClose(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.4)",
            zIndex: 999,
          }}
        />{" "}
        <div
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1000,
            background: M.page,
            color: M.ink,
            fontFamily: font,
            overflowY: "auto",
            WebkitOverflowScrolling: "touch",
            paddingTop: "env(safe-area-inset-top)",
            paddingBottom: "calc(160px + env(safe-area-inset-bottom))",
            animation: "slideIn 0.25s ease",
          }}
        >
          {treeShrubCloseoutOn && (
            <div style={{ padding: "12px 16px 0" }}>
              <TreeShrubCloseoutSummary
                summary={{
                  productsReady: selectedProducts.length > 0,
                  protocolReady: true,
                  photoCount: servicePhotos.length,
                  areasTreated: (areasServiced || []).join(", "),
                  smsEnabled: true,
                  aiAnalysisStatus: treeShrubAiStatus === "idle" ? "pending" : treeShrubAiStatus,
                  aiSummary: treeShrubReview?.aiSummary || "",
                  suggestedCustomerAction: treeShrubReview?.suggestedCustomerAction || "",
                  findings: treeShrubReview?.findings || [],
                  // Don't advertise one-tap completion while regulatory closeout fields
                  // (bed sqft, pollinator status, IRAC/FRAC, product actuals) are still
                  // required — the same gate handleSubmit enforces.
                  canComplete: !submitting && servicePhotos.length >= 2 && !treeShrubCompletionBlocked,
                }}
                reviewKey={treeShrubReview?._fingerprint || ""}
                completing={submitting}
                onDecisionsChange={(d) => { treeShrubDecisionsRef.current = d; }}
                onComplete={(decided) => {
                  treeShrubDecisionsRef.current = decided?.findings || [];
                  handleSubmit();
                }}
              />
            </div>
          )}
          {recapEligible && (
            <div style={{ padding: "12px 16px 0" }}>
              <RecapCapture serviceId={service.id} />
              <PestRecapCard serviceId={service.id} />
            </div>
          )}
          {success && (
            <div
              style={{
                position: "absolute",
                inset: 0,
                background: "rgba(250,250,250,0.96)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 10,
                flexDirection: "column",
                padding: 24,
              }}
            >
              {" "}
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: "50%",
                  background: M.success,
                  color: "#fff",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 32,
                  marginBottom: 16,
                }}
              >
                </div>{" "}
              <div
                style={{
                  fontFamily: font,
                  fontSize: 20,
                  fontWeight: 600,
                  color: M.ink,
                }}
              >
                Service completed
              </div>{" "}
              <div
                style={{
                  fontFamily: font,
                  fontSize: 13,
                  color: M.ink3,
                  marginTop: 6,
                  textAlign: "center",
                }}
              >
                {completionResult?.completionSmsStatus === "sent"
                  ? "SMS + report sent"
                  : completionResult?.completionSmsStatus === "blocked"
                    ? `Report saved. SMS blocked${completionResult?.completionSmsError ? `: ${completionResult.completionSmsError}` : ""}`
                    : completionResult?.completionSmsStatus === "failed"
                      ? `Report saved. SMS failed${completionResult?.completionSmsError ? `: ${completionResult.completionSmsError}` : ""}`
                      : effectiveSendSms
                        ? "Report saved"
                        : "Report saved"}{" "}
                for {service.customerName}
              </div>{" "}
              {completionResult?.typedDeliveryMode === "internal_only" && (
                <div
                  style={{
                    fontFamily: font,
                    fontSize: 13,
                    color: M.ink3,
                    marginTop: 8,
                    textAlign: "center",
                  }}
                >
                  Report stored — customer delivery is off for this service
                  type.
                </div>
              )}
              {recapEligible && (
                <div style={{ marginTop: 18, width: "100%", maxWidth: 360 }}>
                  <PestRecapCard serviceId={service.id} />
                </div>
              )}
              {showPrepayCta && (
                <button
                  type="button"
                  onClick={() => setShowPrepay(true)}
                  style={{ ...secondaryPill, marginTop: 16 }}
                >
                  Offer annual prepay
                </button>
              )}
              {(recapEligible || showPrepayCta) && !completionResult?.followupSuggestion?.required && (
                <button
                  type="button"
                  onClick={() => onClose(true)}
                  style={{ ...secondaryPill, marginTop: 16 }}
                >
                  Done
                </button>
              )}
              {completionResult?.followupSuggestion?.required && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    marginTop: 20,
                    width: "100%",
                    maxWidth: 360,
                  }}
                >
                  {onScheduleFollowup && (
                    <button
                      type="button"
                      onClick={() =>
                        onScheduleFollowup(completionResult.followupSuggestion)
                      }
                      style={primaryPill}
                    >
                      Schedule follow-up
                      {completionResult.followupSuggestion.suggestedDate
                        ? ` (suggested ${completionResult.followupSuggestion.suggestedDate})`
                        : ""}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => onClose(true)}
                    style={secondaryPill}
                  >
                    Done
                  </button>
                </div>
              )}
            </div>
          )}
          {showPrepay && (
            <AnnualPrepayLauncher
              customerId={service.customerId || service.customer_id}
              onClose={() => setShowPrepay(false)}
              onSaved={() => setShowPrepay(false)}
            />
          )}
          {/* Sticky top bar — Square pattern: ← · centered title · ⋯ */}
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 2,
              background: M.page,
              padding: "12px 12px",
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 64,
              boxSizing: "border-box",
            }}
          >
            {" "}
            <button
              type="button"
              onClick={() => onClose(false)}
              aria-label="Back"
              style={{
                width: 36,
                height: 36,
                minWidth: 36,
                borderRadius: "50%",
                background: M.muted,
                border: "none",
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                padding: 0,
                fontFamily: font,
                fontSize: 20,
                lineHeight: 1,
                color: M.ink,
              }}
            >
              ←
            </button>{" "}
            <div
              style={{
                flex: 1,
                minWidth: 0,
                textAlign: "center",
                padding: "0 8px",
                lineHeight: 1.2,
              }}
            >
              {" "}
              <div
                style={{
                  fontFamily: font,
                  fontSize: 17,
                  fontWeight: 600,
                  color: M.ink,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Complete service
              </div>{" "}
              <div
                style={{
                  fontFamily: font,
                  fontSize: 13,
                  fontWeight: 400,
                  color: M.ink3,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  marginTop: 1,
                }}
              >
                {service.customerName}
              </div>{" "}
            </div>
            {onViewDetails ? (
              <button
                type="button"
                onClick={() => onViewDetails(service)}
                style={{
                  height: 36,
                  minWidth: 72,
                  borderRadius: 999,
                  background: M.card,
                  border: `1px solid ${M.hairline}`,
                  color: M.ink,
                  fontFamily: font,
                  fontSize: 13,
                  fontWeight: 600,
                  cursor: "pointer",
                }}
              >
                Details
              </button>
            ) : (
              <div style={{ width: 36, height: 36 }} aria-hidden />
            )}
          </div>{" "}
          <div style={{ padding: 20, maxWidth: 560, margin: "0 auto" }}>
            {showDraftPrompt && (
              <div
                style={{
                  background: M.card,
                  border: `0.5px solid ${M.hairline}`,
                  borderRadius: 14,
                  padding: 14,
                  marginBottom: 16,
                  display: "flex",
                  flexDirection: "column",
                  gap: 10,
                }}
              >
                {" "}
                <div
                  style={{
                    fontFamily: font,
                    fontSize: 14,
                    fontWeight: 600,
                    color: M.ink,
                  }}
                >
                  Restore saved draft?
                </div>{" "}
                <div style={{ fontFamily: font, fontSize: 12, color: M.ink3 }}>
                  Saved{" "}
                  {savedDraft?.savedAt
                    ? new Date(savedDraft.savedAt).toLocaleString()
                    : "recently"}
                </div>{" "}
                <div style={{ display: "flex", gap: 8 }}>
                  {" "}
                  <button
                    type="button"
                    onClick={restoreDraft}
                    style={{ ...primaryPill, height: 40, fontSize: 12 }}
                  >
                    Restore
                  </button>{" "}
                  <button
                    type="button"
                    onClick={discardDraft}
                    style={{ ...secondaryPill, height: 40, fontSize: 12 }}
                  >
                    Discard
                  </button>{" "}
                </div>{" "}
              </div>
            )}
            {/* Service meta */}
            <div
              style={{
                fontFamily: font,
                fontSize: 13,
                color: M.ink3,
                marginBottom: 20,
                lineHeight: 1.4,
              }}
            >
              {service.serviceType}
              {service.address ? (
                <>
                  <br />
                  {service.address}
                </>
              ) : null}
            </div>
            {/* Time on-site */}
            {onSiteTime && (
              <div
                style={{
                  background: M.card,
                  border: `0.5px solid ${M.hairline}`,
                  borderRadius: 16,
                  padding: 16,
                  marginBottom: 20,
                }}
              >
                {" "}
                <div style={eyebrowStyle}>Time on-site</div>{" "}
                <div
                  style={{
                    fontFamily: mono,
                    fontSize: 28,
                    fontWeight: 700,
                    color: M.ink,
                    fontVariantNumeric: "tabular-nums",
                    lineHeight: 1.15,
                  }}
                >
                  {elapsed}
                </div>{" "}
              </div>
            )}
            {/* Quick complete */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 12,
                marginBottom: 24,
              }}
            >
              {" "}
              <button
                type="button"
                onClick={() => {
                  if (structuredCloseoutRequired) return;
                  setQuickComplete(!quickComplete);
                }}
                disabled={structuredCloseoutRequired}
                style={{
                  height: 36,
                  padding: "0 16px",
                  borderRadius: 999,
                  background: quickComplete ? M.ink : "transparent",
                  color: quickComplete ? M.actionFg : M.ink,
                  border: quickComplete ? "none" : `1px solid ${M.ink}`,
                  fontFamily: font,
                  fontSize: 12,
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.3px",
                  cursor:
                    structuredCloseoutRequired
                      ? "not-allowed"
                      : "pointer",
                  opacity: structuredCloseoutRequired ? 0.55 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                Quick complete {quickComplete ? "on" : "off"}
              </button>{" "}
            </div>
            {/* Callback banner */}
            {isCallback && (
              <div
                style={{
                  background: M.card,
                  border: `0.5px solid ${M.hairline}`,
                  borderRadius: 12,
                  padding: "12px 16px",
                  marginBottom: 20,
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 10,
                }}
              >
                {" "}
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: M.success,
                    marginTop: 7,
                    flexShrink: 0,
                  }}
                />{" "}
                <div
                  style={{
                    fontFamily: font,
                    fontSize: 13,
                    color: M.ink,
                    lineHeight: 1.4,
                  }}
                >
                  Callback visit — will be noted as included with WaveGuard
                  membership on the customer's report.
                </div>{" "}
              </div>
            )}
            {isLawn && !quickComplete && (
              <Field label="Lawn assessment">
                <LawnAssessmentCompletionBlock
                  service={service}
                  disabled={isIncompleteVisit || submitting}
                  onConfirmed={handleLawnAssessmentConfirmed}
                />
              </Field>
            )}
            {isLawn && turfHeightFlag && !quickComplete && (
              <Field label="Mowing height (gauge reading)">
                <TurfHeightCapture
                  service={service}
                  value={turfHeight}
                  onChange={setTurfHeight}
                  disabled={isIncompleteVisit || submitting}
                />
              </Field>
            )}
            {treeShrubCloseoutRequired && !quickComplete && (
              <Field label="Tree & Shrub protocol closeout">
                <TreeShrubCloseoutBlock
                  value={treeShrubCloseout}
                  onChange={(next) =>
                    setTreeShrubCloseout(
                      normalizeTreeShrubCloseoutDraft(next, service),
                    )
                  }
                  blocks={treeShrubCloseoutBlocks}
                  productFlags={treeShrubProductFlags}
                  inputStyle={mInput}
                  selectStyle={mSelect}
                  textareaStyle={mTextarea}
                  colors={{
                    card: M.card,
                    border: M.hairline,
                    text: M.ink,
                    muted: M.ink3,
                    error: M.err,
                  }}
                />
              </Field>
            )}
            {calibrationRequired && treatmentPlanStructuredProtocol?.window && (
              <Field label="10/10 protocol closeout">
                <div
                  style={{
                    background: M.card,
                    border: `0.5px solid ${M.hairline}`,
                    borderRadius: 12,
                    padding: 12,
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      fontFamily: font,
                      fontSize: 13,
                      fontWeight: 700,
                      color: M.ink,
                      marginBottom: 4,
                    }}
                  >
                    {treatmentPlanStructuredProtocol.window.title}
                  </div>
                  <div
                    style={{
                      fontFamily: font,
                      fontSize: 12,
                      color: M.ink3,
                      lineHeight: 1.35,
                    }}
                  >
                    {treatmentPlanStructuredProtocol.window.goal}
                  </div>
                  <div
                    style={{
                      marginTop: 10,
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 8,
                      fontFamily: font,
                      fontSize: 11,
                      color: M.ink3,
                    }}
                  >
                    <div>
                      <strong style={{ color: M.ink }}>Assignment:</strong>{" "}
                      {treatmentPlanAppointmentAssignment?.assignedAt
                        ? "linked"
                        : "plan preview"}
                    </div>
                    <div>
                      <strong style={{ color: M.ink }}>Inventory:</strong>{" "}
                      {treatmentPlanInventoryBlocks.length
                        ? `${treatmentPlanInventoryBlocks.length} block`
                        : treatmentPlanInventoryWarnings.length
                          ? `${treatmentPlanInventoryWarnings.length} warning`
                          : "clear"}
                    </div>
                  </div>
                </div>
                {treatmentPlanInventoryBlocks.length > 0 && (
                  <div
                    style={{
                      background: M.err + "10",
                      border: `1px solid ${M.err}`,
                      borderRadius: 10,
                      color: M.err,
                      fontFamily: font,
                      fontSize: 12,
                      lineHeight: 1.35,
                      padding: 10,
                      marginBottom: 10,
                    }}
                  >
                    {treatmentPlanInventoryBlocks
                      .map((block) => block.message)
                      .filter(Boolean)
                      .join(" ")}
                  </div>
                )}
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                  <input
                    type="number"
                    value={protocolTreatedSqft}
                    onChange={(e) => setProtocolTreatedSqft(e.target.value)}
                    placeholder="Treated sq ft"
                    style={mInput}
                  />
                  <input
                    type="number"
                    step="0.1"
                    value={protocolCarrierGalPer1000}
                    onChange={(e) => setProtocolCarrierGalPer1000(e.target.value)}
                    placeholder="Carrier gal/1K"
                    style={mInput}
                  />
                </div>
                {(treatmentPlanStructuredProtocol.window.requiredTasks || []).length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 10 }}>
                    {treatmentPlanStructuredProtocol.window.requiredTasks.map((task) => {
                      const checked = !!protocolTaskStatus[task];
                      return (
                        <button
                          key={task}
                          type="button"
                          onClick={() => toggleProtocolTask(task)}
                          disabled={isIncompleteVisit || submitting}
                          style={{
                            padding: "10px 12px",
                            borderRadius: 10,
                            fontSize: 13,
                            fontWeight: 600,
                            textAlign: "left",
                            cursor: "pointer",
                            background: checked ? M.success + "18" : M.card,
                            color: checked ? M.success : M.ink,
                            border: `1px solid ${checked ? M.success : M.hairline}`,
                          }}
                        >
                          {checked ? "\u2713 " : ""}
                          {task.replace(/_/g, " ")}
                        </button>
                      );
                    })}
                  </div>
                )}
                {(treatmentPlanStructuredProtocol.products || []).length > 0 && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                    <div style={{ ...subLabelStyle, marginBottom: 2 }}>
                      Default product disposition
                    </div>
                    {undispositionedDefaultProtocolProducts.length > 0 && (
                      <div style={{ fontFamily: font, fontSize: 12, color: M.err, lineHeight: 1.35 }}>
                        Mark default products as applied through the product list or skipped below before closeout.
                      </div>
                    )}
                    {treatmentPlanStructuredProtocol.products
                      .filter((product) => product.defaultInPlan)
                      .slice(0, 6)
                      .map((product) => {
                        const key = product.id || product.productId || product.productName;
                        const skipped = !!skippedProtocolProducts[key];
                        const substitution = product.productId
                          ? substitutionByOriginalProductId.get(String(product.productId))
                          : null;
                        return (
                          <div
                            key={key}
                            style={{
                              display: "grid",
                              gridTemplateColumns: "auto 1fr",
                              gap: 8,
                              alignItems: "center",
                            }}
                          >
                            <button
                              type="button"
                              onClick={() => updateSkippedProtocolProduct(product, !skipped)}
                              style={{
                                height: 34,
                                padding: "0 10px",
                                borderRadius: 8,
                                border: `1px solid ${skipped ? M.err : M.hairline}`,
                                background: skipped ? M.err + "12" : M.card,
                                color: skipped ? M.err : M.ink3,
                                fontSize: 12,
                                fontWeight: 700,
                                cursor: "pointer",
                              }}
                            >
                              {skipped ? "Skipped" : "Applied"}
                            </button>
                            <input
                              value={skippedProtocolProducts[key]?.reason || ""}
                              onChange={(e) => updateSkippedProtocolProduct(product, true, e.target.value)}
                              placeholder={substitution
                                ? `${product.productName} replaced by ${substitution.substituteProductName}`
                                : `${product.productName} skip reason`}
                              disabled={!skipped}
                              style={{ ...mInput, marginBottom: 0, opacity: skipped ? 1 : 0.55 }}
                            />
                          </div>
                        );
                      })}
                  </div>
                )}
              </Field>
            )}
            {calibrationRequired && (
              <Field label="Equipment calibration">
                {" "}
                <select
                  value={equipmentSystemId}
                  onChange={(e) => handleEquipmentSelect(e.target.value)}
                  disabled={isIncompleteVisit}
                  style={mInput}
                >
                  {" "}
                  <option value="">Select calibrated equipment</option>
                  {equipmentCalibrations.map((c) => (
                    <option key={c.id} value={c.equipment_system_id}>
                      {c.system_name || "Equipment"} ·{" "}
                      {c.carrier_gal_per_1000 || "—"} gal/1K
                    </option>
                  ))}
                </select>{" "}
                <div
                  style={{
                    marginTop: 8,
                    fontFamily: font,
                    fontSize: 12,
                    color:
                      selectedCalibrationExpired || equipmentCalibrationError
                        ? M.err
                        : M.ink3,
                    lineHeight: 1.35,
                  }}
                >
                  {isIncompleteVisit
                    ? "Calibration is not required when marking a visit incomplete."
                    : calibrationHelpText}
                </div>{" "}
              </Field>
            )}
            {tankCleanoutRequired && (
              <Field label="Tank cleanout">
                {" "}
                <div
                  style={{
                    marginBottom: 10,
                    fontFamily: font,
                    fontSize: 12,
                    color: tankCleanoutCompletionBlocked ? M.err : M.ink3,
                    lineHeight: 1.35,
                  }}
                >
                  {tankCleanoutHelpText}
                </div>{" "}
                <input
                  value={tankLastProduct}
                  onChange={(e) => setTankLastProduct(e.target.value)}
                  placeholder="Last product in tank"
                  style={mInput}
                />{" "}
                <select
                  value={tankLastProductCategory}
                  onChange={(e) => setTankLastProductCategory(e.target.value)}
                  style={{ ...mInput, marginTop: 8 }}
                >
                  {" "}
                  <option value="">Prior product type</option>{" "}
                  <option value="herbicide">Herbicide / weed control</option>{" "}
                  <option value="insecticide">Insecticide</option>{" "}
                  <option value="fungicide">Fungicide</option>{" "}
                  <option value="fertilizer">Fertilizer / nutrient</option>{" "}
                  <option value="water_only">Water only</option>{" "}
                  <option value="unknown">Unknown</option>{" "}
                </select>{" "}
                <select
                  value={tankCleanoutCompleted}
                  onChange={(e) => setTankCleanoutCompleted(e.target.value)}
                  style={{ ...mInput, marginTop: 8 }}
                >
                  {" "}
                  <option value="">Cleanout completed?</option>{" "}
                  <option value="yes">Yes</option>{" "}
                  <option value="no">No</option>{" "}
                </select>{" "}
                <select
                  value={tankCleanoutMethod}
                  onChange={(e) => setTankCleanoutMethod(e.target.value)}
                  style={{ ...mInput, marginTop: 8 }}
                >
                  {" "}
                  <option value="">Cleanout method</option>
                  {TANK_CLEANOUT_METHODS.map((method) => (
                    <option key={method} value={method}>
                      {method}
                    </option>
                  ))}
                </select>{" "}
                <textarea
                  value={tankCleanoutNote}
                  onChange={(e) => setTankCleanoutNote(e.target.value)}
                  rows={2}
                  placeholder="Cleanout note"
                  style={{ ...mTextarea, minHeight: 72, marginTop: 8 }}
                />{" "}
              </Field>
            )}
            {blackoutApprovalRequired && (
              <Field label="Office approval">
                {" "}
                <div
                  style={{
                    marginBottom: 10,
                    fontFamily: font,
                    fontSize: 12,
                    color: M.err,
                    lineHeight: 1.35,
                  }}
                >
                  {blackoutHelpText}{" "}
                  {!canApproveOfficeExceptions
                    ? "An admin must approve this exception before completion."
                    : ""}
                </div>
                {canApproveOfficeExceptions && (
                  <>
                    {" "}
                    <select
                      value={officeApprovalReasonCode}
                      onChange={(e) =>
                        setOfficeApprovalReasonCode(e.target.value)
                      }
                      style={mInput}
                    >
                      {" "}
                      <option value="">Select approval reason</option>
                      {OFFICE_APPROVAL_REASONS.map((reason) => (
                        <option key={reason.value} value={reason.value}>
                          {reason.label}
                        </option>
                      ))}
                    </select>{" "}
                    <textarea
                      value={officeApprovalNote}
                      onChange={(e) => setOfficeApprovalNote(e.target.value)}
                      rows={2}
                      placeholder="Approval note"
                      style={{ ...mTextarea, minHeight: 72, marginTop: 8 }}
                    />{" "}
                  </>
                )}
              </Field>
            )}
            {nLimitApprovalRequired && (
              <Field label="Annual N budget">
                {" "}
                <div
                  style={{
                    marginBottom: 10,
                    fontFamily: font,
                    fontSize: 12,
                    color: M.err,
                    lineHeight: 1.35,
                  }}
                >
                  {nLimitHelpText} {nLimitSummaryText}{" "}
                  {!canApproveOfficeExceptions
                    ? "An admin must approve this exception before completion."
                    : ""}
                </div>
                {canApproveOfficeExceptions && (
                  <>
                    {" "}
                    <select
                      value={nLimitApprovalReasonCode}
                      onChange={(e) =>
                        setNLimitApprovalReasonCode(e.target.value)
                      }
                      style={mInput}
                    >
                      {" "}
                      <option value="">Select approval reason</option>
                      {N_LIMIT_APPROVAL_REASONS.map((reason) => (
                        <option key={reason.value} value={reason.value}>
                          {reason.label}
                        </option>
                      ))}
                    </select>{" "}
                    <textarea
                      value={nLimitApprovalNote}
                      onChange={(e) => setNLimitApprovalNote(e.target.value)}
                      rows={2}
                      placeholder="Approval note"
                      style={{ ...mTextarea, minHeight: 72, marginTop: 8 }}
                    />{" "}
                  </>
                )}
              </Field>
            )}
            {managerApprovalRequired && (
              <Field label="Manager approval">
                {" "}
                <div
                  style={{
                    marginBottom: 10,
                    fontFamily: font,
                    fontSize: 12,
                    color: M.err,
                    lineHeight: 1.35,
                  }}
                >
                  {managerApprovalHelpText}{" "}
                  {!canApproveOfficeExceptions
                    ? "An admin must approve this exception before completion."
                    : ""}
                </div>
                {canApproveOfficeExceptions && (
                  <>
                    {" "}
                    <select
                      value={managerApprovalReasonCode}
                      onChange={(e) =>
                        setManagerApprovalReasonCode(e.target.value)
                      }
                      style={mInput}
                    >
                      {" "}
                      <option value="">Select approval reason</option>
                      {MANAGER_APPROVAL_REASONS.map((reason) => (
                        <option key={reason.value} value={reason.value}>
                          {reason.label}
                        </option>
                      ))}
                    </select>{" "}
                    <textarea
                      value={managerApprovalNote}
                      onChange={(e) => setManagerApprovalNote(e.target.value)}
                      rows={2}
                      placeholder="Approval note"
                      style={{ ...mTextarea, minHeight: 72, marginTop: 8 }}
                    />{" "}
                  </>
                )}
              </Field>
            )}
            {/* Technician notes */}
            <Field label="Visit outcome">
              {" "}
              <select
                value={visitOutcome}
                onChange={(e) => setVisitOutcome(e.target.value)}
                style={mSelect}
              >
                {VISIT_OUTCOME_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>{" "}
            </Field>{" "}
            <Field label="Technician notes">
              {" "}
              <div style={{ position: "relative" }}>
                <textarea
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  rows={quickComplete ? 3 : 5}
                  // Lock edits while the AI draft is in flight so typing or a
                  // dictated chunk landing mid-call isn't clobbered when the
                  // response replaces the notes.
                  disabled={generating}
                  placeholder={
                    dictation.listening
                      ? "Listening… speak your notes"
                      : "What did you do on this visit?"
                  }
                  style={{
                    ...mTextarea,
                    minHeight: quickComplete ? 90 : 140,
                    // Reserve the bottom-right corner for the dictation mic so
                    // typed text never runs under it.
                    paddingRight: dictation.supported ? 52 : mTextarea.padding,
                    opacity: generating ? 0.6 : 1,
                  }}
                />{" "}
                {dictation.supported && (
                  <button
                    type="button"
                    onClick={dictation.toggle}
                    disabled={generating}
                    aria-label={
                      dictation.listening ? "Stop dictation" : "Dictate notes"
                    }
                    title={
                      dictation.listening ? "Stop dictation" : "Dictate notes"
                    }
                    style={{
                      position: "absolute",
                      bottom: 10,
                      right: 10,
                      width: 38,
                      height: 38,
                      borderRadius: "50%",
                      border: `1px solid ${dictation.listening ? M.err : M.hairline}`,
                      background: dictation.listening ? M.err : M.card,
                      color: dictation.listening ? M.card : M.ink2,
                      fontSize: 17,
                      lineHeight: 1,
                      cursor: generating ? "not-allowed" : "pointer",
                      opacity: generating ? 0.5 : 1,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      boxShadow: "0 1px 3px rgba(0,0,0,0.12)",
                    }}
                  >
                    {dictation.listening ? "■" : "🎙"}
                  </button>
                )}
              </div>
            </Field>
            {!isTypedFindings && (
              <Field label="Protocol actions">
                {protocolActionMeta?.programName && (
                  <div
                    style={{
                      fontFamily: font,
                      fontSize: 12,
                      color: M.ink4,
                      marginBottom: 8,
                    }}
                  >
                    {protocolActionMeta.programName}
                    {protocolActionMeta.visit?.month
                      ? ` - ${protocolActionMeta.visit.month}`
                      : ""}
                  </div>
                )}
                {protocolActionsLoading ? (
                  <div style={{ fontFamily: font, fontSize: 13, color: M.ink4 }}>
                    Loading protocol actions...
                  </div>
                ) : (
                  <>
                    {protocolActionError && !protocolActions.length && (
                      <div
                        style={{
                          fontFamily: font,
                          fontSize: 12,
                          color: M.ink4,
                          marginBottom: 8,
                        }}
                      >
                        Protocol actions unavailable.
                      </div>
                    )}
                    <select
                      aria-label="Add protocol action"
                      value=""
                      onChange={(e) => handleProtocolActionSelect(e.target.value)}
                      style={mSelect}
                    >
                      <option value="">Add protocol action...</option>
                      {protocolActions.length > 0
                        ? protocolActionSelectOptions.map((opt) => (
                            <option key={opt.value} value={opt.value}>
                              {opt.selected ? "(applied) " : ""}
                              {opt.label}
                            </option>
                          ))
                        : CHIP_ACTIONS.map((chip) => (
                            <option key={chip.label} value={chip.label}>
                              {chip.label}
                            </option>
                          ))}
                    </select>
                    {selectedProtocolActionCount > 0 && (
                      <div
                        style={{
                          fontFamily: font,
                          fontSize: 12,
                          color: M.ink3,
                          marginTop: 6,
                        }}
                      >
                        {selectedProtocolActionCount} protocol action
                        {selectedProtocolActionCount === 1 ? "" : "s"} applied
                      </div>
                    )}
                  </>
                )}
              </Field>
            )}
            <Field label="Observations">
              {" "}
              <select
                aria-label="Add observation"
                value=""
                onChange={(e) => handleObservationSelect(e.target.value)}
                style={mSelect}
              >
                <option value="">Add observation...</option>
                {(usesPlantHealthChips
                  ? CHIP_OBSERVATIONS_HORTICULTURAL
                  : CHIP_OBSERVATIONS_PEST
                ).map((chip) => (
                  <option key={chip} value={chip}>
                    {chip}
                  </option>
                ))}
              </select>{" "}
            </Field>
            <Field label="Recommendations">
              {" "}
              <select
                aria-label="Add recommendation"
                value=""
                onChange={(e) => handleRecommendationSelect(e.target.value)}
                style={mSelect}
              >
                <option value="">Add recommendation...</option>
                {(usesPlantHealthChips
                  ? CHIP_RECOMMENDATIONS_HORTICULTURAL
                  : CHIP_RECOMMENDATIONS_PEST
                ).map((chip) => (
                  <option key={chip} value={chip}>
                    {chip}
                  </option>
                ))}
              </select>{" "}
            </Field>
            {/* AI report — drafts customer-facing visit copy into the notes box
                from the structured visit data (actions, observations, products,
                concern), for the tech to review/edit before completing. */}
            {!quickComplete && (
              <button
                type="button"
                onClick={async () => {
                  // Stop dictation BEFORE snapshotting notes for the payload, so
                  // a final spoken chunk lands in serviceNotes rather than after
                  // the snapshot. Once generating flips true the dictation
                  // callback ignores any late chunk (and the mic is disabled).
                  if (dictation.listening) dictation.toggle();
                  const { payload, hasReportInput } = buildAiReportPayload();
                  if (!hasReportInput) {
                    alert("Add service notes, products, or visit details first.");
                    return;
                  }
                  setGenerating(true);
                  try {
                    const r = await generateAiReport(payload);
                    if (r.report)
                      setNotes(stitchSelectedLabelsIntoReport(r.report));
                  } catch (e) {
                    alert("AI report failed: " + e.message);
                  }
                  setGenerating(false);
                }}
                disabled={generating}
                style={{
                  ...secondaryPill,
                  marginTop: 4,
                  marginBottom: 20,
                  opacity: generating ? 0.5 : 1,
                }}
              >
                {generating ? "Generating…" : "✨ Generate AI report"}
              </button>
            )}
            {/* Service photos — pure lawn visits capture turf photos in the
                Lawn Assessment block above, which flow into the report gallery,
                so this redundant second upload is hidden. Combined visits keep
                it (companions have their own completion-photo gates). */}
            {!quickComplete && !hideServicePhotos && (
              <Field label={`Service photos (${servicePhotos.length}/5)`}>
                {" "}
                <input
                  ref={photoInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  onChange={handlePhotoSelect}
                  style={{ display: "none" }}
                />{" "}
                <button
                  type="button"
                  onClick={() => photoInputRef.current?.click()}
                  disabled={servicePhotos.length >= 5}
                  style={{
                    ...secondaryPill,
                    opacity: servicePhotos.length >= 5 ? 0.5 : 1,
                  }}
                >
                  Add photos
                </button>
                {servicePhotos.length > 0 && (
                  <div
                    style={{
                      display: "flex",
                      gap: 8,
                      marginTop: 12,
                      flexWrap: "wrap",
                    }}
                  >
                    {servicePhotos.map((photo, i) => (
                      <div
                        key={i}
                        style={{ position: "relative", width: 80 }}
                      >
                        {" "}
                        <img
                          src={photo.data}
                          alt={photo.name}
                          style={{
                            width: 80,
                            height: 80,
                            objectFit: "cover",
                            borderRadius: 8,
                            border: `0.5px solid ${M.hairline}`,
                          }}
                        />{" "}
                        <button
                          type="button"
                          onClick={() => removePhoto(i)}
                          aria-label="Remove photo"
                          style={{
                            position: "absolute",
                            top: -6,
                            right: -6,
                            width: 22,
                            height: 22,
                            borderRadius: "50%",
                            background: M.ink,
                            color: M.actionFg,
                            border: "none",
                            fontSize: 14,
                            lineHeight: 1,
                            cursor: "pointer",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center",
                          }}
                        >
                          ×
                        </button>{" "}
                        {photo.caption && (
                          <div
                            style={{
                              fontSize: 14,
                              color: M.ink4,
                              marginTop: 4,
                              width: 80,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                            title={photo.caption}
                          >
                            {photo.caption}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                )}
                {/* AI photo analysis — typed services only (the summary
                    persists via the typedReportSnapshot). */}
                {isTypedFindings && servicePhotos.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      onClick={handlePhotoAnalyze}
                      disabled={photoAnalyzing}
                      style={{
                        ...secondaryPill,
                        opacity: photoAnalyzing ? 0.5 : 1,
                        cursor: photoAnalyzing ? "wait" : "pointer",
                      }}
                    >
                      {photoAnalyzing ? "Analyzing…" : "Analyze photos with AI"}
                    </button>
                    {photoAiError && (
                      <div style={{ fontSize: 14, color: "#C2410C", marginTop: 6 }}>
                        {photoAiError}
                      </div>
                    )}
                    {typedPhotoSummary !== "" && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontSize: 14, fontWeight: 600, color: M.ink, marginBottom: 4 }}>
                          Photo summary (appears on the customer report)
                        </div>
                        <textarea
                          value={typedPhotoSummary}
                          onChange={(e) => setTypedPhotoSummary(e.target.value)}
                          rows={3}
                          maxLength={600}
                          style={{
                            width: "100%",
                            boxSizing: "border-box",
                            background: M.card,
                            color: M.ink,
                            border: `1px solid ${M.hairline}`,
                            borderRadius: 10,
                            padding: 10,
                            fontSize: 14,
                            resize: "vertical",
                          }}
                        />
                      </div>
                    )}
                  </div>
                )}
              </Field>
            )}
            {/* Service findings — typed specialty completion */}
            {isTypedFindings && (
              <TypedFindingsSection
                variant="mobile"
                schema={typedFindingsSchema}
                values={findingsValues}
                onFieldChange={handleTypedFindingChange}
                activityScore={typedActivityScore}
                activityScoreTouched={typedActivityTouched}
                onActivityTap={handleTypedActivityTap}
                nextStepChips={typedNextStepChips}
                onToggleChip={toggleTypedNextStepChip}
                recommendations={typedRecommendations}
                onRecommendationsChange={handleTypedRecommendationsChange}
                aiDrafting={typedAiDrafting}
                aiError={typedAiError}
                includeComms={typedAiIncludeComms}
                onIncludeCommsChange={setTypedAiIncludeComms}
                onAiDraft={handleTypedAiDraft}
              />
            )}
            {/* Companion sections — one typed form per companion schema,
                below the primary. Recommendations/AI stay primary-only
                (onRecommendationsChange null hides them in the section). */}
            {companionSchemas.map((schema) => {
              const entry = companionState[schema.type] || EMPTY_COMPANION_ENTRY;
              return (
                <TypedFindingsSection
                  key={schema.type}
                  variant="mobile"
                  schema={schema}
                  values={entry.values}
                  onFieldChange={(key, value) =>
                    handleCompanionFieldChange(schema.type, key, value)
                  }
                  activityScore={entry.score}
                  activityScoreTouched={entry.scoreTouched}
                  onActivityTap={(n) =>
                    handleCompanionActivityTap(schema.type, n)
                  }
                  nextStepChips={entry.chips}
                  onToggleChip={(chip) =>
                    toggleCompanionNextStepChip(schema.type, chip)
                  }
                  recommendations=""
                  onRecommendationsChange={null}
                  aiDrafting={false}
                  aiError=""
                  includeComms={false}
                  onIncludeCommsChange={() => {}}
                  onAiDraft={() => {}}
                />
              );
            })}
            {/* Products applied */}
            <Field label="Products applied">
              {quickComplete ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {(products || []).slice(0, 8).map((p) => {
                    const selected = !!selectedProducts.find(
                      (sp) => sp.productId === p.id,
                    );
                    return (
                      <Chip
                        key={p.id}
                        selected={selected}
                        onClick={() =>
                          selected ? removeProduct(p.id) : addProduct(p)
                        }
                      >
                        {selected ? "" : ""}
                        {p.name}
                      </Chip>
                    );
                  })}
                </div>
              ) : (
                <>
                  {" "}
                  <input
                    type="text"
                    value={productSearch}
                    onChange={(e) => setProductSearch(e.target.value)}
                    placeholder="Search products…"
                    style={mInput}
                  />
                  {productSearch && filteredProducts.length > 0 && (
                    <div
                      style={{
                        background: M.card,
                        border: `0.5px solid ${M.hairline}`,
                        borderRadius: 12,
                        maxHeight: 180,
                        overflowY: "auto",
                        marginTop: 8,
                      }}
                    >
                      {filteredProducts.slice(0, 8).map((p, idx, arr) => (
                        <div
                          key={p.id}
                          onClick={() => addProduct(p)}
                          style={{
                            padding: "12px 16px",
                            fontFamily: font,
                            fontSize: 15,
                            color: M.ink,
                            cursor: "pointer",
                            borderBottom:
                              idx === arr.length - 1
                                ? "none"
                                : `0.5px solid ${M.hairline}`,
                          }}
                        >
                          {p.name}
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
              {selectedProducts.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: 8,
                    marginTop: 12,
                  }}
                >
                  {selectedProducts.map((sp) => (
                    <div
                      key={sp.productId}
                      style={{
                        background: M.card,
                        border: `0.5px solid ${M.hairline}`,
                        borderRadius: 12,
                        padding: 12,
                        display: "flex",
                        alignItems: "center",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      {" "}
                      <span
                        style={{
                          fontFamily: font,
                          fontSize: 15,
                          fontWeight: 600,
                          color: M.ink,
                          flex: 1,
                          minWidth: 120,
                        }}
                      >
                        {sp.name}
                      </span>{" "}
                      <input
                        type="number"
                        placeholder="Rate"
                        value={sp.rate}
                        onChange={(e) =>
                          updateProduct(sp.productId, "rate", e.target.value)
                        }
                        style={{
                          ...mInput,
                          width: 84,
                          height: 40,
                          padding: "0 12px",
                        }}
                      />{" "}
                      <select
                        value={sp.rateUnit}
                        onChange={(e) =>
                          updateProduct(
                            sp.productId,
                            "rateUnit",
                            e.target.value,
                          )
                        }
                        style={{
                          ...mInput,
                          width: 78,
                          height: 40,
                          padding: "0 12px",
                        }}
                      >
                        {" "}
                        <option value="oz">oz</option>{" "}
                        <option value="fl_oz">fl oz</option>{" "}
                        <option value="ml">ml</option>{" "}
                        <option value="g">g</option>{" "}
                        <option value="lb">lb</option>{" "}
                        <option value="gal">gal</option>{" "}
                      </select>{" "}
                      <input
                        type="number"
                        placeholder="Total"
                        value={sp.totalAmount || ""}
                        onChange={(e) =>
                          updateProduct(
                            sp.productId,
                            "totalAmount",
                            e.target.value,
                          )
                        }
                        style={{
                          ...mInput,
                          width: 84,
                          height: 40,
                          padding: "0 12px",
                        }}
                      />{" "}
                      <select
                        value={sp.amountUnit || sp.rateUnit}
                        onChange={(e) =>
                          updateProduct(
                            sp.productId,
                            "amountUnit",
                            e.target.value,
                          )
                        }
                        style={{
                          ...mInput,
                          width: 78,
                          height: 40,
                          padding: "0 12px",
                        }}
                      >
                        {" "}
                        <option value="oz">oz</option>{" "}
                        <option value="fl_oz">fl oz</option>{" "}
                        <option value="ml">ml</option>{" "}
                        <option value="g">g</option>{" "}
                        <option value="lb">lb</option>{" "}
                        <option value="gal">gal</option>{" "}
                      </select>{" "}
                      {areasServiced.length > 0 && (
                        <select
                          value={sp.applicationArea || ""}
                          onChange={(e) =>
                            updateProduct(
                              sp.productId,
                              "applicationArea",
                              e.target.value,
                            )
                          }
                          style={{
                            ...mInput,
                            minWidth: 150,
                            flex: "1 1 150px",
                            height: 40,
                            padding: "0 12px",
                          }}
                        >
                          <option value="">
                            {areasServiced.length === 1
                              ? `Area: ${areasServiced[0]}`
                              : "Treatment area"}
                          </option>
                          {areasServiced.map((area) => (
                            <option key={area} value={area}>
                              {area}
                            </option>
                          ))}
                        </select>
                      )}
                      <select
                        value={productApplicationMethod(sp, serviceTypeForArea)}
                        onChange={(e) =>
                          updateProduct(
                            sp.productId,
                            "applicationMethod",
                            e.target.value,
                          )
                        }
                        style={{
                          ...mInput,
                          minWidth: 150,
                          flex: "1 1 150px",
                          height: 40,
                          padding: "0 12px",
                        }}
                      >
                        <option value="perimeter_spray">Perimeter spray</option>
                        <option value="broadcast_spray">Broadcast spray</option>
                        <option value="spot_treatment">Spot treatment</option>
                        <option value="granular_broadcast">Granular</option>
                        <option value="bait_placement">Bait</option>
                        <option value="station_check">Station check</option>
                        <option value="fog_ulv">Fog/ULV</option>
                        <option value="foliar_spray">Foliar spray</option>
                        <option value="trunk_injection">Trunk injection</option>
                        <option value="pin_stream">Pin stream</option>
                      </select>
                      {(() => {
                        const areaRequirement = requiredApplicationArea(
                          productApplicationMethod(sp, serviceTypeForArea),
                          serviceTypeForArea,
                        );
                        if (!areaRequirement) return null;
                        return (
                          <input
                            type="number"
                            min="1"
                            placeholder={areaRequirement.label}
                            value={sp.areaValue || ""}
                            onChange={(e) =>
                              updateProduct(
                                sp.productId,
                                "areaValue",
                                e.target.value,
                              )
                            }
                            style={{
                              ...mInput,
                              width: areaRequirement.unit === "linear_ft" ? 112 : 98,
                              height: 40,
                              padding: "0 12px",
                            }}
                          />
                        );
                      })()}
                      <button
                        type="button"
                        onClick={() => removeProduct(sp.productId)}
                        aria-label="Remove product"
                        style={{
                          width: 36,
                          height: 36,
                          borderRadius: "50%",
                          background: M.muted,
                          border: "none",
                          cursor: "pointer",
                          fontSize: 18,
                          lineHeight: 1,
                          color: M.ink,
                          padding: 0,
                        }}
                      >
                        ×
                      </button>{" "}
                      <ProductTargetsPicker
                        idSuffix={sp.productId}
                        targets={sp.targets}
                        onChange={(next) =>
                          updateProduct(sp.productId, "targets", next)
                        }
                        theme={{
                          labelColor: M.ink3,
                          chipBg: M.muted,
                          chipText: M.ink,
                          chipBorder: M.hairline,
                          inputStyle: {
                            ...mInput,
                            height: 40,
                            padding: "0 12px",
                            fontSize: 14,
                            width: "auto",
                          },
                        }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </Field>
            {/* Areas serviced */}
            {!quickComplete && (
              <Field label="Areas treated">
                {" "}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {areaOptions.map((area) => {
                    const selected = areasServiced.includes(area);
                    return (
                      <Chip
                        key={area}
                        selected={selected}
                        onClick={() => toggleArea(area)}
                      >
                        {selected ? "" : ""}
                        {area}
                      </Chip>
                    );
                  })}
                </div>{" "}
              </Field>
            )}
            {/* Customer recap + final SMS preview */}
            {isIncompleteVisit ? (
              <Field label="Customer recap">
                {" "}
                <div
                  style={{
                    background: M.card,
                    border: `0.5px solid ${M.hairline}`,
                    borderRadius: 12,
                    padding: 14,
                    fontFamily: font,
                    fontSize: 13,
                    color: M.ink3,
                    lineHeight: 1.45,
                  }}
                >
                  This visit will be closed without a customer recap, charge, or
                  review request. The office will see the reason and follow up.
                </div>{" "}
              </Field>
            ) : (
              <Field label="Customer recap">
                {" "}
                <textarea
                  value={customerRecap}
                  onChange={(e) => handleCustomerRecapChange(e.target.value)}
                  rows={4}
                  placeholder="Customer-facing summary..."
                  style={{ ...mTextarea, minHeight: 112 }}
                />{" "}
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    marginTop: 8,
                    alignItems: "center",
                  }}
                >
                  {" "}
                  <span
                    style={{
                      fontFamily: font,
                      fontSize: 12,
                      color: recapError
                        ? M.err
                        : recapStaleAfterEdit
                          ? M.warn
                          : M.ink4,
                    }}
                  >
                    {recapStatusText}
                  </span>{" "}
                  <button
                    type="button"
                    onClick={regenerateCustomerRecap}
                    disabled={recapLoading}
                    style={{
                      ...tertiaryPill,
                      width: "auto",
                      height: 36,
                      padding: "0 14px",
                      border: `1px solid ${M.hairline}`,
                      fontSize: 12,
                      opacity: recapLoading ? 0.5 : 1,
                    }}
                  >
                    Regenerate
                  </button>{" "}
                </div>{" "}
              </Field>
            )}
            {effectiveSendSms && (
              <Field
                label={`Customer SMS preview - ${completionSmsTemplateName}`}
              >
                {" "}
                <div
                  style={{
                    background: M.card,
                    border: `0.5px solid ${M.hairline}`,
                    borderRadius: 12,
                    padding: 14,
                    fontFamily: font,
                    fontSize: 14,
                    color: M.ink,
                    lineHeight: 1.45,
                    whiteSpace: "pre-wrap",
                  }}
                >
                  {smsPreview || "Add notes to preview the customer message."}
                </div>{" "}
              </Field>
            )}
            {/* Customer interaction */}
            {!quickComplete && (
              <Field label="Customer interaction">
                {" "}
                <div
                  style={{ display: "flex", flexDirection: "column", gap: 8 }}
                >
                  {CUSTOMER_INTERACTION_OPTIONS.map((opt) => {
                    const selected = customerInteraction === opt.value;
                    return (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setCustomerInteraction(opt.value)}
                        style={{
                          textAlign: "left",
                          padding: "12px 16px",
                          borderRadius: 12,
                          background: selected ? M.ink : M.card,
                          color: selected ? M.actionFg : M.ink,
                          border: `1px solid ${selected ? M.ink : M.hairline}`,
                          fontFamily: font,
                          fontSize: 15,
                          fontWeight: 500,
                          cursor: "pointer",
                        }}
                      >
                        {selected ? "" : ""}
                        {opt.label}
                      </button>
                    );
                  })}
                </div>
                {isCustomerConcernInteraction(customerInteraction) && (
                  <input
                    type="text"
                    value={customerConcern}
                    onChange={(e) => setCustomerConcern(e.target.value)}
                    placeholder="Describe the customer's concern…"
                    style={{ ...mInput, marginTop: 8 }}
                  />
                )}
              </Field>
            )}
            {/* Tech-side Pest Pressure rating — companion to the
                customer-side capture; either source feeds the engine's
                client-rating component. Optional — leave null to defer
                to the customer's input.

                Gated entirely on `techRatingAllowed`, which is computed
                server-side per-service against the SAME classifiers and
                allow-list the completion handler enforces on write
                (feature flag + `enabledServiceLines` via
                `detectServiceLine`). No local category check — the
                client used to use `detectServiceCategory` but that maps
                rodent labels to `pest` while the backend resolves them
                to `rodent`, which produced a picker whose data would be
                silently dropped on completion. `null` (still loading or
                fetch failed) keeps the picker hidden too. */}
            {techRatingAllowed === true && !quickComplete && (
              <Field label="Pest activity rating (0–5, optional)">
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {[0, 1, 2, 3, 4, 5].map((n) => {
                    const selected = clientPestRating === n;
                    return (
                      <button
                        key={n}
                        type="button"
                        onClick={() =>
                          setClientPestRating(selected ? null : n)
                        }
                        style={{
                          minWidth: 44,
                          height: 44,
                          borderRadius: 12,
                          background: selected ? M.ink : M.card,
                          color: selected ? M.actionFg : M.ink,
                          border: `1px solid ${
                            selected ? M.ink : M.hairline
                          }`,
                          fontFamily: font,
                          fontSize: 16,
                          fontWeight: 600,
                          cursor: "pointer",
                        }}
                        aria-pressed={selected}
                        aria-label={`Rate pest activity ${n} out of 5`}
                      >
                        {n}
                      </button>
                    );
                  })}
                </div>
                <div
                  style={{
                    marginTop: 6,
                    fontSize: 12,
                    color: M.muted,
                    fontFamily: font,
                  }}
                >
                  0 = none, 5 = severe. Tap a number again to clear.
                </div>
              </Field>
            )}
            {/* Options */}
            <Field label="Options">
              {" "}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "14px 16px",
                  background: M.card,
                  border: `0.5px solid ${oneTimeRecapOnly ? M.ink : M.hairline}`,
                  borderRadius: 12,
                  marginBottom: 8,
                  cursor: isIncompleteVisit ? "not-allowed" : "pointer",
                  opacity: isIncompleteVisit ? 0.55 : 1,
                }}
              >
                {" "}
                <input
                  type="checkbox"
                  checked={oneTimeRecapOnly && !isIncompleteVisit}
                  disabled={isIncompleteVisit}
                  onChange={(e) =>
                    handleOneTimeRecapOnlyChange(e.target.checked)
                  }
                  style={{ width: 18, height: 18, accentColor: M.ink }}
                />{" "}
                <span style={{ fontFamily: font, fontSize: 15, color: M.ink }}>
                  One-time recap + review only (no invoice)
                </span>{" "}
              </label>{" "}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "14px 16px",
                  background: M.card,
                  border: `0.5px solid ${M.hairline}`,
                  borderRadius: 12,
                  marginBottom: 8,
                  cursor: "pointer",
                }}
              >
                {" "}
                <input
                  type="checkbox"
                  checked={effectiveSendSms}
                  disabled={isIncompleteVisit || oneTimeRecapOnly}
                  onChange={(e) => setSendSms(e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: M.ink }}
                />{" "}
                <span style={{ fontFamily: font, fontSize: 15, color: M.ink }}>
                  {isIncompleteVisit
                    ? "Completion SMS suppressed"
                    : oneTimeRecapOnly
                      ? "Completion SMS included"
                      : "Send completion SMS to customer"}
                </span>{" "}
              </label>{" "}
              {willInvoice && effectiveSendSms && !oneTimeRecapOnly && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    padding: "12px 16px",
                    margin: "0 0 8px 30px",
                    background: M.card,
                    border: `0.5px solid ${M.hairline}`,
                    borderRadius: 12,
                    cursor: "pointer",
                  }}
                >
                  {" "}
                  <input
                    type="checkbox"
                    checked={includePayLink}
                    onChange={(e) => setIncludePayLink(e.target.checked)}
                    style={{
                      width: 18,
                      height: 18,
                      accentColor: M.ink,
                      marginTop: 1,
                    }}
                  />{" "}
                  <span style={{ fontFamily: font, fontSize: 14, color: M.ink }}>
                    Include payment link in the text
                    <span
                      style={{
                        display: "block",
                        fontSize: 12,
                        color: M.ink3,
                        marginTop: 2,
                      }}
                    >
                      {includePayLink
                        ? "Texts the service report and the pay link."
                        : "Report only — no pay link (e.g. paid in person)."}
                    </span>
                  </span>{" "}
                </label>
              )}{" "}
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  padding: "14px 16px",
                  background: M.card,
                  border: `0.5px solid ${M.hairline}`,
                  borderRadius: 12,
                  cursor: "pointer",
                }}
              >
                {" "}
                <input
                  type="checkbox"
                  checked={willReview}
                  disabled={!!reviewSuppressionReason || oneTimeRecapOnly}
                  onChange={(e) => setRequestReview(e.target.checked)}
                  style={{ width: 18, height: 18, accentColor: M.ink }}
                />{" "}
                <span style={{ fontFamily: font, fontSize: 15, color: M.ink }}>
                  {reviewSuppressionReason
                    ? "Review request suppressed"
                    : oneTimeRecapOnly
                      ? "Review request included"
                      : "Send review request"}
                </span>{" "}
              </label>{" "}
              {willReview && !oneTimeRecapOnly && (
                <div
                  style={{
                    display: "grid",
                    gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
                    gap: 8,
                    margin: "0 0 8px 30px",
                  }}
                >
                  <select
                    value={reviewTiming}
                    onChange={(e) => setReviewTiming(e.target.value)}
                    style={mInput}
                  >
                    <option value="now">Now</option>
                    <option value="120">In 2 hours</option>
                    <option value="tomorrow_8">Tomorrow at 8 AM</option>
                    <option value="custom">Custom time</option>
                  </select>
                  {reviewTiming === "custom" ? (
                    <input
                      type="datetime-local"
                      value={reviewCustomAt}
                      onChange={(e) => setReviewCustomAt(e.target.value)}
                      style={mInput}
                    />
                  ) : (
                    <div />
                  )}
                </div>
              )}
            </Field>
            {/* Next visit */}
            {nextVisit && (
              <div
                style={{
                  background: M.card,
                  border: `0.5px solid ${M.hairline}`,
                  borderRadius: 12,
                  padding: 16,
                  marginBottom: 24,
                }}
              >
                {" "}
                <div style={eyebrowStyle}>Next scheduled visit</div>{" "}
                <div
                  style={{
                    fontFamily: font,
                    fontSize: 15,
                    fontWeight: 600,
                    color: M.ink,
                  }}
                >
                  {nextVisit.date
                    ? new Date(nextVisit.date + "T00:00:00").toLocaleDateString(
                        "en-US",
                        { weekday: "short", month: "short", day: "numeric" },
                      )
                    : "N/A"}
                </div>{" "}
                <div
                  style={{
                    fontFamily: font,
                    fontSize: 13,
                    color: M.ink3,
                    marginTop: 2,
                  }}
                >
                  {nextVisit.serviceType || "Standard service"}
                </div>
                {!showNextVisitNote ? (
                  <button
                    type="button"
                    onClick={() => setShowNextVisitNote(true)}
                    style={{
                      ...tertiaryPill,
                      height: 36,
                      padding: "0 14px",
                      marginTop: 10,
                      width: "auto",
                      border: `1px solid ${M.hairline}`,
                      fontSize: 12,
                    }}
                  >
                    Needs adjustment?
                  </button>
                ) : (
                  <input
                    type="text"
                    value={nextVisitNote}
                    onChange={(e) => setNextVisitNote(e.target.value)}
                    placeholder="Note about next visit adjustment…"
                    style={{ ...mInput, marginTop: 10 }}
                  />
                )}
              </div>
            )}
          </div>
          {/* Sticky footer */}
          <div
            style={{
              position: "fixed",
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 3,
              background: M.card,
              borderTop: `0.5px solid ${M.hairline}`,
              padding: "12px 16px calc(12px + env(safe-area-inset-bottom))",
              display: "flex",
              flexDirection: "column",
              gap: 8,
            }}
          >
            {" "}
            <button
              type="button"
              onClick={() => handleSubmit()}
              disabled={
                submitting ||
                generating ||
                tankCleanoutCompletionBlocked ||
                blackoutCompletionBlocked ||
                nLimitCompletionBlocked ||
                managerApprovalCompletionBlocked ||
                treeShrubCompletionBlocked ||
                protocolActualsCompletionBlocked
              }
              style={{
                ...primaryPill,
                opacity:
                  submitting ||
                  tankCleanoutCompletionBlocked ||
                  blackoutCompletionBlocked ||
                  nLimitCompletionBlocked ||
                  managerApprovalCompletionBlocked ||
                  treeShrubCompletionBlocked ||
                  protocolActualsCompletionBlocked
                    ? 0.5
                    : 1,
              }}
            >
              {completionCtaLabel.replace("...", "…")}
            </button>{" "}
          </div>{" "}
        </div>{" "}
      </>,
      document.body,
    );
  }

  // ────────────────────────────────────────────────────────────────────
  // Desktop render (legacy D dark palette) — unchanged
  // ────────────────────────────────────────────────────────────────────
  return createPortal(
    <>
      {" "}
      <div
        onClick={() => onClose(false)}
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.6)",
          zIndex: 999,
        }}
      />{" "}
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          bottom: 0,
          width: isMobile ? "100%" : "60%",
          minWidth: isMobile ? 0 : 360,
          maxWidth: isMobile ? "100%" : 640,
          background: D.bg,
          borderLeft: isMobile ? "none" : `1px solid ${D.border}`,
          zIndex: 1000,
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          animation: "slideIn 0.25s ease",
        }}
      >
        {success && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              background: D.bg + "ee",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10,
              flexDirection: "column",
            }}
          >
            {" "}
            <div style={{ fontSize: 64, marginBottom: 16, color: D.green }}>
              &#10003;
            </div>{" "}
            <div style={{ fontSize: 20, fontWeight: 700, color: D.green }}>
              Service Completed!
            </div>{" "}
            <div style={{ fontSize: 14, color: D.muted, marginTop: 8 }}>
              {!effectiveSendSms
                ? "Report saved"
                : completionResult?.completionSmsStatus === "blocked"
                  ? `Report saved. SMS blocked${completionResult?.completionSmsError ? `: ${completionResult.completionSmsError}` : ""}`
                  : completionResult?.completionSmsStatus === "failed"
                    ? `Report saved. SMS failed${completionResult?.completionSmsError ? `: ${completionResult.completionSmsError}` : ""}`
                    : "SMS + Report sent"}{" "}
              for {service.customerName}
            </div>{" "}
            {completionResult?.typedDeliveryMode === "internal_only" && (
              <div
                style={{
                  fontSize: 13,
                  color: D.muted,
                  marginTop: 8,
                  textAlign: "center",
                }}
              >
                Report stored — customer delivery is off for this service type.
              </div>
            )}
            {completionResult?.followupSuggestion?.required && (
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  marginTop: 20,
                  width: "100%",
                  maxWidth: 360,
                  padding: "0 24px",
                  boxSizing: "border-box",
                }}
              >
                {onScheduleFollowup && (
                  <button
                    type="button"
                    onClick={() =>
                      onScheduleFollowup(completionResult.followupSuggestion)
                    }
                    style={{
                      ...btnBase,
                      width: "100%",
                      background: D.teal,
                      color: "#fff",
                      fontSize: 14,
                    }}
                  >
                    Schedule follow-up
                    {completionResult.followupSuggestion.suggestedDate
                      ? ` (suggested ${completionResult.followupSuggestion.suggestedDate})`
                      : ""}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onClose(true)}
                  style={{
                    ...btnBase,
                    width: "100%",
                    background: "transparent",
                    color: D.text,
                    border: `1px solid ${D.border}`,
                    fontSize: 14,
                  }}
                >
                  Done
                </button>
              </div>
            )}
          </div>
        )}
        {/* Header */}
        <div
          style={{
            padding: "20px 24px",
            borderBottom: `1px solid ${D.border}`,
            flexShrink: 0,
          }}
        >
          {" "}
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              marginBottom: 8,
            }}
          >
            {" "}
            <div style={{ fontSize: 18, fontWeight: 700, color: D.heading }}>
              Complete Service
            </div>{" "}
            <button
              onClick={() => onClose(false)}
              style={{
                background: "none",
                border: "none",
                color: D.muted,
                fontSize: 24,
                cursor: "pointer",
                padding: 4,
              }}
            >
              &times;
            </button>{" "}
          </div>{" "}
          <div style={{ fontSize: 14, color: D.text, fontWeight: 600 }}>
            {service.customerName}
          </div>{" "}
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
            {service.address}
          </div>{" "}
          <div style={{ fontSize: 12, color: D.muted, marginTop: 2 }}>
            {service.serviceType}
          </div>
          {/* Service duration — prominent display */}
          {onSiteTime && (
            <div
              style={{
                marginTop: 10,
                padding: "10px 16px",
                borderRadius: 10,
                background: D.teal + "18",
                border: `1px solid ${D.teal}44`,
                display: "flex",
                alignItems: "center",
                gap: 10,
              }}
            >
              {" "}
              <span style={{ fontSize: 20, color: D.teal }}>&#9201;</span>{" "}
              <div>
                {" "}
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 700,
                    color: D.teal,
                    textTransform: "uppercase",
                    letterSpacing: 0.5,
                  }}
                >
                  Time on-site
                </div>{" "}
                <div
                  style={{
                    fontFamily: "'JetBrains Mono', monospace",
                    fontSize: 22,
                    fontWeight: 800,
                    color: D.teal,
                    letterSpacing: 1,
                  }}
                >
                  {elapsed}
                </div>{" "}
              </div>{" "}
            </div>
          )}
          {/* Quick Complete toggle */}
          <div
            style={{
              marginTop: 10,
              display: "flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {" "}
            <button
              onClick={() => {
                if (structuredCloseoutRequired) return;
                setQuickComplete(!quickComplete);
              }}
              disabled={structuredCloseoutRequired}
              style={{
                padding: "6px 14px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: 700,
                cursor:
                  structuredCloseoutRequired
                    ? "not-allowed"
                    : "pointer",
                background: quickComplete ? D.amber : "transparent",
                color: quickComplete ? D.bg : D.amber,
                border: `1px solid ${D.amber}`,
                opacity: structuredCloseoutRequired ? 0.55 : 1,
                transition: "all 0.15s",
              }}
            >
              {quickComplete ? "Quick Complete ON" : "Quick Complete"}
            </button>{" "}
            <span style={{ fontSize: 11, color: D.muted }}>
              {structuredCloseoutRequired
                ? treeShrubCloseoutRequired
                  ? "Tree/Shrub protocol closeout requires full form"
                  : "WaveGuard lawn closeout requires full execution checklist"
                : quickComplete
                ? "Showing minimal fields"
                : "Bulk end-of-day mode"}
            </span>{" "}
          </div>{" "}
        </div>
        {/* Callback banner */}
        {isCallback && (
          <div
            style={{
              padding: "10px 24px",
              background: D.green + "18",
              borderBottom: `1px solid ${D.green}44`,
              fontSize: 13,
              color: D.green,
              fontWeight: 600,
              lineHeight: 1.5,
            }}
          >
            Callback visit — will be noted as included with WaveGuard membership
            on the customer's report.
          </div>
        )}
        {/* Body */}
        <div style={{ flex: 1, padding: 24, overflowY: "auto" }}>
          {showDraftPrompt && (
            <div
              style={{
                background: D.card,
                border: `1px solid ${D.border}`,
                borderRadius: 10,
                padding: 14,
                marginBottom: 16,
              }}
            >
              {" "}
              <div style={{ fontSize: 14, fontWeight: 700, color: D.heading }}>
                Restore saved draft?
              </div>{" "}
              <div style={{ fontSize: 12, color: D.muted, marginTop: 3 }}>
                Saved{" "}
                {savedDraft?.savedAt
                  ? new Date(savedDraft.savedAt).toLocaleString()
                  : "recently"}
              </div>{" "}
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                {" "}
                <button
                  onClick={restoreDraft}
                  style={{
                    ...btnBase,
                    width: "auto",
                    height: 36,
                    padding: "0 14px",
                    background: D.teal,
                    color: "#fff",
                  }}
                >
                  Restore
                </button>{" "}
                <button
                  onClick={discardDraft}
                  style={{
                    ...btnBase,
                    width: "auto",
                    height: 36,
                    padding: "0 14px",
                    background: "transparent",
                    color: D.muted,
                    border: `1px solid ${D.border}`,
                  }}
                >
                  Discard
                </button>{" "}
              </div>{" "}
            </div>
          )}
          {isLawn && !quickComplete && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>Lawn Assessment</label>{" "}
              <LawnAssessmentCompletionBlock
                service={service}
                disabled={isIncompleteVisit || submitting}
                onConfirmed={handleLawnAssessmentConfirmed}
              />
            </div>
          )}
          {isLawn && turfHeightFlag && !quickComplete && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>Mowing height (gauge reading)</label>{" "}
              <TurfHeightCapture
                service={service}
                value={turfHeight}
                onChange={setTurfHeight}
                disabled={isIncompleteVisit || submitting}
              />
            </div>
          )}
          {treeShrubCloseoutRequired && !quickComplete && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>Tree & Shrub Protocol Closeout</label>
              <TreeShrubCloseoutBlock
                value={treeShrubCloseout}
                onChange={(next) =>
                  setTreeShrubCloseout(
                    normalizeTreeShrubCloseoutDraft(next, service),
                  )
                }
                blocks={treeShrubCloseoutBlocks}
                productFlags={treeShrubProductFlags}
                inputStyle={inputStyle}
                selectStyle={inputStyle}
                textareaStyle={{ ...inputStyle, minHeight: 82, resize: "vertical" }}
                colors={{
                  card: D.input,
                  border: D.border,
                  text: D.text,
                  muted: D.muted,
                  error: D.red,
                }}
              />
            </div>
          )}
          {calibrationRequired && treatmentPlanStructuredProtocol?.window && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>WaveGuard Execution Checklist</label>
              <div
                style={{
                  background: D.input,
                  border: `1px solid ${D.border}`,
                  borderRadius: 10,
                  padding: 14,
                  marginBottom: 10,
                }}
              >
                <div style={{ fontSize: 14, fontWeight: 800, color: D.heading }}>
                  {treatmentPlanStructuredProtocol.window.title}
                </div>
                <div style={{ fontSize: 12, color: D.muted, lineHeight: 1.45, marginTop: 4 }}>
                  {treatmentPlanStructuredProtocol.window.goal}
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10, fontSize: 12, color: D.muted }}>
                  <div>
                    <strong style={{ color: D.text }}>Assignment:</strong>{" "}
                    {treatmentPlanAppointmentAssignment?.assignedAt ? "linked" : "plan preview"}
                  </div>
                  <div>
                    <strong style={{ color: D.text }}>Inventory:</strong>{" "}
                    {treatmentPlanInventoryBlocks.length
                      ? `${treatmentPlanInventoryBlocks.length} block`
                      : treatmentPlanInventoryWarnings.length
                        ? `${treatmentPlanInventoryWarnings.length} warning`
                        : "clear"}
                  </div>
                </div>
              </div>
              {treatmentPlanInventoryBlocks.length > 0 && (
                <div style={{ background: D.red + "12", border: `1px solid ${D.red}`, borderRadius: 10, padding: 10, color: D.red, fontSize: 12, lineHeight: 1.4, marginBottom: 10 }}>
                  {treatmentPlanInventoryBlocks.map((block) => block.message).filter(Boolean).join(" ")}
                </div>
              )}
              {treatmentPlanSubstitutions.length > 0 && (
                <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
                  {treatmentPlanSubstitutions.map((sub) => {
                    const selected = selectedProducts.some((product) => String(product.productId) === String(sub.substituteProductId));
                    return (
                      <div
                        key={sub.id || `${sub.originalProductId}-${sub.substituteProductId}`}
                        style={{
                          background: D.green + "12",
                          border: `1px solid ${D.green}`,
                          borderRadius: 10,
                          padding: 10,
                          color: D.text,
                          fontSize: 12,
                          lineHeight: 1.4,
                        }}
                      >
                        <div style={{ fontWeight: 800, color: D.heading }}>
                          Approved substitute: {sub.substituteProductName}
                        </div>
                        <div style={{ color: D.muted, marginTop: 2 }}>
                          Replaces {sub.originalProductName || "planned product"}
                          {sub.reason ? ` · ${sub.reason}` : ""}
                          {sub.approvedByName ? ` · approved by ${sub.approvedByName}` : ""}
                        </div>
                        <button
                          type="button"
                          disabled={selected || isIncompleteVisit || submitting}
                          onClick={() => addSubstitutionProduct(sub)}
                          style={{
                            marginTop: 8,
                            height: 32,
                            padding: "0 10px",
                            borderRadius: 8,
                            border: `1px solid ${selected ? D.green : D.border}`,
                            background: selected ? D.green + "18" : D.card,
                            color: selected ? D.green : D.text,
                            fontSize: 12,
                            fontWeight: 800,
                            cursor: selected ? "default" : "pointer",
                            opacity: isIncompleteVisit || submitting ? 0.6 : 1,
                          }}
                        >
                          {selected ? "Added to products" : "Add substitute to products"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                <input
                  type="number"
                  value={protocolTreatedSqft}
                  onChange={(e) => setProtocolTreatedSqft(e.target.value)}
                  placeholder="Treated sq ft"
                  style={inputStyle}
                />
                <input
                  type="number"
                  step="0.1"
                  value={protocolCarrierGalPer1000}
                  onChange={(e) => setProtocolCarrierGalPer1000(e.target.value)}
                  placeholder="Carrier gal/1K"
                  style={inputStyle}
                />
              </div>
              {requiredProtocolTasks.length > 0 && (
                <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
                  {requiredProtocolTasks.map((task) => {
                    const checked = !!protocolTaskStatus[task];
                    return (
                      <button
                        key={task}
                        type="button"
                        onClick={() => toggleProtocolTask(task)}
                        disabled={isIncompleteVisit || submitting}
                        style={{
                          padding: "10px 12px",
                          borderRadius: 8,
                          fontSize: 13,
                          fontWeight: 700,
                          textAlign: "left",
                          cursor: "pointer",
                          background: checked ? D.green + "18" : D.input,
                          color: checked ? D.green : D.text,
                          border: `1px solid ${checked ? D.green : D.border}`,
                        }}
                      >
                        {checked ? "\u2713 " : ""}
                        {task.replace(/_/g, " ")}
                      </button>
                    );
                  })}
                </div>
              )}
              {defaultProtocolProducts.length > 0 && (
                <div style={{ display: "grid", gap: 6 }}>
                  <div style={{ fontSize: 12, color: undispositionedDefaultProtocolProducts.length ? D.red : D.muted, lineHeight: 1.4 }}>
                    Mark each default protocol product as applied in product actuals or skipped below.
                  </div>
                  {defaultProtocolProducts.slice(0, 6).map((product) => {
                    const key = protocolProductKey(product);
                    const skipped = !!skippedProtocolProducts[key];
                    return (
                      <div key={key} style={{ display: "grid", gridTemplateColumns: "96px 1fr", gap: 8, alignItems: "center" }}>
                        <button
                          type="button"
                          onClick={() => updateSkippedProtocolProduct(product, !skipped)}
                          style={{
                            height: 36,
                            borderRadius: 8,
                            border: `1px solid ${skipped ? D.red : D.border}`,
                            background: skipped ? D.red + "12" : D.input,
                            color: skipped ? D.red : D.text,
                            fontSize: 12,
                            fontWeight: 800,
                            cursor: "pointer",
                          }}
                        >
                          {skipped ? "Skipped" : "Applied"}
                        </button>
                        <input
                          value={skippedProtocolProducts[key]?.reason || ""}
                          onChange={(e) => updateSkippedProtocolProduct(product, true, e.target.value)}
                          placeholder={`${product.productName} skip reason`}
                          disabled={!skipped}
                          style={{ ...inputStyle, margin: 0, opacity: skipped ? 1 : 0.55 }}
                        />
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
          {calibrationRequired && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>Equipment Calibration</label>{" "}
              <select
                value={equipmentSystemId}
                onChange={(e) => handleEquipmentSelect(e.target.value)}
                disabled={isIncompleteVisit}
                style={inputStyle}
              >
                {" "}
                <option value="">Select calibrated equipment</option>
                {equipmentCalibrations.map((c) => (
                  <option key={c.id} value={c.equipment_system_id}>
                    {c.system_name || "Equipment"} ·{" "}
                    {c.carrier_gal_per_1000 || "—"} gal/1K
                  </option>
                ))}
              </select>{" "}
              <div
                style={{
                  fontSize: 12,
                  color:
                    selectedCalibrationExpired || equipmentCalibrationError
                      ? D.red
                      : D.muted,
                  lineHeight: 1.4,
                }}
              >
                {isIncompleteVisit
                  ? "Calibration is not required when marking a visit incomplete."
                  : calibrationHelpText}
              </div>{" "}
            </div>
          )}
          {tankCleanoutRequired && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>Tank Cleanout</label>{" "}
              <div
                style={{
                  fontSize: 12,
                  color: tankCleanoutCompletionBlocked ? D.red : D.muted,
                  lineHeight: 1.4,
                  marginBottom: 8,
                }}
              >
                {tankCleanoutHelpText}
              </div>{" "}
              <input
                value={tankLastProduct}
                onChange={(e) => setTankLastProduct(e.target.value)}
                placeholder="Last product in tank"
                style={inputStyle}
              />{" "}
              <select
                value={tankLastProductCategory}
                onChange={(e) => setTankLastProductCategory(e.target.value)}
                style={{ ...inputStyle, marginTop: 8 }}
              >
                {" "}
                <option value="">Prior product type</option>{" "}
                <option value="herbicide">Herbicide / weed control</option>{" "}
                <option value="insecticide">Insecticide</option>{" "}
                <option value="fungicide">Fungicide</option>{" "}
                <option value="fertilizer">Fertilizer / nutrient</option>{" "}
                <option value="water_only">Water only</option>{" "}
                <option value="unknown">Unknown</option>{" "}
              </select>{" "}
              <select
                value={tankCleanoutCompleted}
                onChange={(e) => setTankCleanoutCompleted(e.target.value)}
                style={{ ...inputStyle, marginTop: 8 }}
              >
                {" "}
                <option value="">Cleanout completed?</option>{" "}
                <option value="yes">Yes</option>{" "}
                <option value="no">No</option>{" "}
              </select>{" "}
              <select
                value={tankCleanoutMethod}
                onChange={(e) => setTankCleanoutMethod(e.target.value)}
                style={{ ...inputStyle, marginTop: 8 }}
              >
                {" "}
                <option value="">Cleanout method</option>
                {TANK_CLEANOUT_METHODS.map((method) => (
                  <option key={method} value={method}>
                    {method}
                  </option>
                ))}
              </select>{" "}
              <textarea
                value={tankCleanoutNote}
                onChange={(e) => setTankCleanoutNote(e.target.value)}
                rows={2}
                placeholder="Cleanout note"
                style={{
                  width: "100%",
                  background: D.input,
                  color: D.text,
                  border: `1px solid ${D.border}`,
                  borderRadius: 10,
                  padding: 12,
                  fontSize: 14,
                  resize: "vertical",
                  fontFamily: "'Nunito Sans', sans-serif",
                  boxSizing: "border-box",
                  marginTop: 8,
                }}
              />{" "}
            </div>
          )}
          {blackoutApprovalRequired && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>Office Approval</label>{" "}
              <div
                style={{
                  fontSize: 12,
                  color: D.red,
                  lineHeight: 1.4,
                  marginBottom: 8,
                }}
              >
                {blackoutHelpText}{" "}
                {!canApproveOfficeExceptions
                  ? "An admin must approve this exception before completion."
                  : ""}
              </div>
              {canApproveOfficeExceptions && (
                <>
                  {" "}
                  <select
                    value={officeApprovalReasonCode}
                    onChange={(e) =>
                      setOfficeApprovalReasonCode(e.target.value)
                    }
                    style={inputStyle}
                  >
                    {" "}
                    <option value="">Select approval reason</option>
                    {OFFICE_APPROVAL_REASONS.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </select>{" "}
                  <textarea
                    value={officeApprovalNote}
                    onChange={(e) => setOfficeApprovalNote(e.target.value)}
                    rows={2}
                    placeholder="Approval note"
                    style={{
                      width: "100%",
                      background: D.input,
                      color: D.text,
                      border: `1px solid ${D.border}`,
                      borderRadius: 10,
                      padding: 12,
                      fontSize: 14,
                      resize: "vertical",
                      fontFamily: "'Nunito Sans', sans-serif",
                      boxSizing: "border-box",
                      marginTop: 8,
                    }}
                  />{" "}
                </>
              )}
            </div>
          )}
          {nLimitApprovalRequired && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>Annual N Budget</label>{" "}
              <div
                style={{
                  fontSize: 12,
                  color: D.red,
                  lineHeight: 1.4,
                  marginBottom: 8,
                }}
              >
                {nLimitHelpText} {nLimitSummaryText}{" "}
                {!canApproveOfficeExceptions
                  ? "An admin must approve this exception before completion."
                  : ""}
              </div>
              {canApproveOfficeExceptions && (
                <>
                  {" "}
                  <select
                    value={nLimitApprovalReasonCode}
                    onChange={(e) =>
                      setNLimitApprovalReasonCode(e.target.value)
                    }
                    style={inputStyle}
                  >
                    {" "}
                    <option value="">Select approval reason</option>
                    {N_LIMIT_APPROVAL_REASONS.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </select>{" "}
                  <textarea
                    value={nLimitApprovalNote}
                    onChange={(e) => setNLimitApprovalNote(e.target.value)}
                    rows={2}
                    placeholder="Approval note"
                    style={{
                      width: "100%",
                      background: D.input,
                      color: D.text,
                      border: `1px solid ${D.border}`,
                      borderRadius: 10,
                      padding: 12,
                      fontSize: 14,
                      resize: "vertical",
                      fontFamily: "'Nunito Sans', sans-serif",
                      boxSizing: "border-box",
                      marginTop: 8,
                    }}
                  />{" "}
                </>
              )}
            </div>
          )}
          {managerApprovalRequired && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>Manager Approval</label>{" "}
              <div
                style={{
                  fontSize: 12,
                  color: D.red,
                  lineHeight: 1.4,
                  marginBottom: 8,
                }}
              >
                {managerApprovalHelpText}{" "}
                {!canApproveOfficeExceptions
                  ? "An admin must approve this exception before completion."
                  : ""}
              </div>
              {canApproveOfficeExceptions && (
                <>
                  {" "}
                  <select
                    value={managerApprovalReasonCode}
                    onChange={(e) =>
                      setManagerApprovalReasonCode(e.target.value)
                    }
                    style={inputStyle}
                  >
                    {" "}
                    <option value="">Select approval reason</option>
                    {MANAGER_APPROVAL_REASONS.map((reason) => (
                      <option key={reason.value} value={reason.value}>
                        {reason.label}
                      </option>
                    ))}
                  </select>{" "}
                  <textarea
                    value={managerApprovalNote}
                    onChange={(e) => setManagerApprovalNote(e.target.value)}
                    rows={2}
                    placeholder="Approval note"
                    style={{
                      width: "100%",
                      background: D.input,
                      color: D.text,
                      border: `1px solid ${D.border}`,
                      borderRadius: 10,
                      padding: 12,
                      fontSize: 14,
                      resize: "vertical",
                      fontFamily: "'Nunito Sans', sans-serif",
                      boxSizing: "border-box",
                      marginTop: 8,
                    }}
                  />{" "}
                </>
              )}
            </div>
          )}
          {/* Visit Outcome */}
          <label style={labelStyle}>Visit Outcome</label>{" "}
          <select
            value={visitOutcome}
            onChange={(e) => setVisitOutcome(e.target.value)}
            style={inputStyle}
          >
            {VISIT_OUTCOME_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          {/* Technician Notes */}
          <label style={labelStyle}>Technician Notes</label>{" "}
          <div style={{ position: "relative" }}>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={quickComplete ? 3 : 5}
              // Lock edits while the AI draft is in flight so typing or a
              // dictated chunk landing mid-call isn't clobbered when the
              // response replaces the notes.
              disabled={generating}
              style={{
                width: "100%",
                background: D.input,
                color: D.text,
                border: `1px solid ${D.border}`,
                borderRadius: 10,
                padding: 12,
                // Reserve the bottom-right corner for the dictation mic.
                paddingRight: dictation.supported ? 50 : 12,
                fontSize: 14,
                resize: "vertical",
                fontFamily: "'Nunito Sans', sans-serif",
                boxSizing: "border-box",
                opacity: generating ? 0.6 : 1,
              }}
              placeholder={
                dictation.listening
                  ? "Listening… speak your notes"
                  : "Notes about this service..."
              }
            />
            {dictation.supported && (
              <button
                type="button"
                onClick={dictation.toggle}
                disabled={generating}
                aria-label={
                  dictation.listening ? "Stop dictation" : "Dictate notes"
                }
                title={dictation.listening ? "Stop dictation" : "Dictate notes"}
                style={{
                  position: "absolute",
                  bottom: 12,
                  right: 10,
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  border: `1px solid ${dictation.listening ? D.red : D.border}`,
                  background: dictation.listening ? D.red : D.card,
                  color: dictation.listening ? D.white : D.text,
                  fontSize: 16,
                  lineHeight: 1,
                  cursor: generating ? "not-allowed" : "pointer",
                  opacity: generating ? 0.5 : 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                {dictation.listening ? "■" : "🎙"}
              </button>
            )}
          </div>
          {/* Compact completion quick-picks */}
          <div style={{ marginTop: 10, marginBottom: 16 }}>
            {!isTypedFindings && (
            <div style={{ marginBottom: 12 }}>
              <label style={{ ...labelStyle, color: D.blue }}>
                Protocol Actions
              </label>
              {protocolActionMeta?.programName && (
                <div style={{ fontSize: 11, color: D.muted, marginBottom: 6 }}>
                  {protocolActionMeta.programName}
                  {protocolActionMeta.visit?.month
                    ? ` - ${protocolActionMeta.visit.month}`
                    : ""}
                </div>
              )}
              {protocolActionsLoading ? (
                <span style={{ fontSize: 12, color: D.muted }}>
                  Loading protocol actions...
                </span>
              ) : (
                <>
                  {protocolActionError && !protocolActions.length && (
                    <div
                      style={{ fontSize: 12, color: D.muted, marginBottom: 6 }}
                    >
                      Protocol actions unavailable.
                    </div>
                  )}
                  <select
                    aria-label="Add protocol action"
                    value=""
                    onChange={(e) => handleProtocolActionSelect(e.target.value)}
                    style={inputStyle}
                  >
                    <option value="">Add protocol action...</option>
                    {protocolActions.length > 0
                      ? protocolActionSelectOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.selected ? "(applied) " : ""}
                            {opt.label}
                          </option>
                        ))
                      : CHIP_ACTIONS.map((chip) => (
                          <option key={chip.label} value={chip.label}>
                            {chip.label}
                          </option>
                        ))}
                  </select>
                  {selectedProtocolActionCount > 0 && (
                    <div style={{ fontSize: 11, color: D.muted }}>
                      {selectedProtocolActionCount} protocol action
                      {selectedProtocolActionCount === 1 ? "" : "s"} applied
                    </div>
                  )}
                </>
              )}
            </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <label style={{ ...labelStyle, color: D.amber }}>
                Observations
              </label>{" "}
              <select
                aria-label="Add observation"
                value=""
                onChange={(e) => handleObservationSelect(e.target.value)}
                style={inputStyle}
              >
                <option value="">Add observation...</option>
                {(usesPlantHealthChips
                  ? CHIP_OBSERVATIONS_HORTICULTURAL
                  : CHIP_OBSERVATIONS_PEST
                ).map((chip) => (
                  <option key={chip} value={chip}>
                    {chip}
                  </option>
                ))}
              </select>{" "}
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ ...labelStyle, color: D.green }}>
                Recommendations
              </label>{" "}
              <select
                aria-label="Add recommendation"
                value=""
                onChange={(e) => handleRecommendationSelect(e.target.value)}
                style={inputStyle}
              >
                <option value="">Add recommendation...</option>
                {(usesPlantHealthChips
                  ? CHIP_RECOMMENDATIONS_HORTICULTURAL
                  : CHIP_RECOMMENDATIONS_PEST
                ).map((chip) => (
                  <option key={chip} value={chip}>
                    {chip}
                  </option>
                ))}
              </select>{" "}
            </div>{" "}
          </div>
          {/* AI Service Report — drafts customer-facing visit copy into the
              notes box from the structured visit data, for the tech to
              review/edit before completing. */}
          {!quickComplete && (
            <button
              type="button"
              onClick={async () => {
                // Stop dictation BEFORE snapshotting notes for the payload, so
                // a final spoken chunk lands in serviceNotes rather than after
                // the snapshot. Once generating flips true the dictation
                // callback ignores any late chunk (and the mic is disabled).
                if (dictation.listening) dictation.toggle();
                const { payload, hasReportInput } = buildAiReportPayload();
                if (!hasReportInput) {
                  alert("Add service notes, products, or visit details first.");
                  return;
                }
                setGenerating(true);
                try {
                  const r = await generateAiReport(payload);
                  if (r.report)
                    setNotes(stitchSelectedLabelsIntoReport(r.report));
                } catch (e) {
                  alert("AI report failed: " + e.message);
                }
                setGenerating(false);
              }}
              disabled={generating}
              style={{
                width: "100%",
                padding: "10px 16px",
                borderRadius: 10,
                border: "none",
                background: generating
                  ? D.card
                  : "linear-gradient(135deg, #8b5cf6, #6366f1)",
                color: D.heading,
                fontSize: 13,
                fontWeight: 700,
                cursor: generating ? "wait" : "pointer",
                marginTop: 8,
                marginBottom: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {generating ? "Generating Report..." : "✨ Generate AI Service Report"}
            </button>
          )}
          {/* Photo Upload — hidden in quick complete. Pure lawn visits capture
              turf photos in the Lawn Assessment block above (which flow into the
              report gallery), so this redundant second upload is hidden.
              Combined visits keep it (companions have their own photo gates). */}
          {!quickComplete && !hideServicePhotos && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>Service Photos</label>{" "}
              <input
                ref={photoInputRef}
                type="file"
                accept="image/*"
                multiple
                onChange={handlePhotoSelect}
                style={{ display: "none" }}
              />{" "}
              <button
                onClick={() => photoInputRef.current?.click()}
                disabled={servicePhotos.length >= 5}
                style={{
                  ...btnBase,
                  background: "transparent",
                  color: D.teal,
                  border: `1px solid ${D.teal}44`,
                  height: 40,
                  fontSize: 13,
                  opacity: servicePhotos.length >= 5 ? 0.5 : 1,
                }}
              >
                {" "}
                <span style={{ fontSize: 16 }}>&#128247;</span>Add Photos (
                {servicePhotos.length}/5)
              </button>
              {servicePhotos.length > 0 && (
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    marginTop: 10,
                    flexWrap: "wrap",
                  }}
                >
                  {servicePhotos.map((photo, i) => (
                    <div
                      key={i}
                      style={{ position: "relative", width: 80 }}
                    >
                      {" "}
                      <img
                        src={photo.data}
                        alt={photo.name}
                        style={{
                          width: 80,
                          height: 80,
                          objectFit: "cover",
                          borderRadius: 8,
                          border: `1px solid ${D.border}`,
                        }}
                      />{" "}
                      <button
                        onClick={() => removePhoto(i)}
                        style={{
                          position: "absolute",
                          top: -6,
                          right: -6,
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          background: D.red,
                          color: "#fff",
                          border: "none",
                          fontSize: 12,
                          cursor: "pointer",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          lineHeight: 1,
                          fontWeight: 700,
                        }}
                      >
                        &times;
                      </button>{" "}
                      {photo.caption && (
                        <div
                          style={{
                            fontSize: 14,
                            color: D.muted,
                            marginTop: 4,
                            width: 80,
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                          }}
                          title={photo.caption}
                        >
                          {photo.caption}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {/* AI photo analysis — typed services only (the summary
                  persists via the typedReportSnapshot). */}
              {isTypedFindings && servicePhotos.length > 0 && (
                <div style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    onClick={handlePhotoAnalyze}
                    disabled={photoAnalyzing}
                    style={{
                      background: "transparent",
                      color: D.teal,
                      border: `1px solid ${D.teal}`,
                      borderRadius: 8,
                      padding: "8px 14px",
                      fontSize: 14,
                      cursor: photoAnalyzing ? "wait" : "pointer",
                      opacity: photoAnalyzing ? 0.5 : 1,
                    }}
                  >
                    {photoAnalyzing ? "Analyzing…" : "Analyze photos with AI"}
                  </button>
                  {photoAiError && (
                    <div style={{ fontSize: 14, color: D.red, marginTop: 6 }}>
                      {photoAiError}
                    </div>
                  )}
                  {typedPhotoSummary !== "" && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontSize: 14, fontWeight: 600, color: D.text, marginBottom: 4 }}>
                        Photo summary (appears on the customer report)
                      </div>
                      <textarea
                        value={typedPhotoSummary}
                        onChange={(e) => setTypedPhotoSummary(e.target.value)}
                        rows={3}
                        maxLength={600}
                        style={{
                          width: "100%",
                          boxSizing: "border-box",
                          background: D.card,
                          color: D.text,
                          border: `1px solid ${D.border}`,
                          borderRadius: 10,
                          padding: 10,
                          fontSize: 14,
                          resize: "vertical",
                        }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Service findings — typed specialty completion */}
          {isTypedFindings && (
            <TypedFindingsSection
              variant="desktop"
              schema={typedFindingsSchema}
              values={findingsValues}
              onFieldChange={handleTypedFindingChange}
              activityScore={typedActivityScore}
              activityScoreTouched={typedActivityTouched}
              onActivityTap={handleTypedActivityTap}
              nextStepChips={typedNextStepChips}
              onToggleChip={toggleTypedNextStepChip}
              recommendations={typedRecommendations}
              onRecommendationsChange={handleTypedRecommendationsChange}
              aiDrafting={typedAiDrafting}
              aiError={typedAiError}
              includeComms={typedAiIncludeComms}
              onIncludeCommsChange={setTypedAiIncludeComms}
              onAiDraft={handleTypedAiDraft}
            />
          )}
          {/* Companion sections — one typed form per companion schema,
              below the primary. Recommendations/AI stay primary-only
              (onRecommendationsChange null hides them in the section). */}
          {companionSchemas.map((schema) => {
            const entry = companionState[schema.type] || EMPTY_COMPANION_ENTRY;
            return (
              <TypedFindingsSection
                key={schema.type}
                variant="desktop"
                schema={schema}
                values={entry.values}
                onFieldChange={(key, value) =>
                  handleCompanionFieldChange(schema.type, key, value)
                }
                activityScore={entry.score}
                activityScoreTouched={entry.scoreTouched}
                onActivityTap={(n) => handleCompanionActivityTap(schema.type, n)}
                nextStepChips={entry.chips}
                onToggleChip={(chip) =>
                  toggleCompanionNextStepChip(schema.type, chip)
                }
                recommendations=""
                onRecommendationsChange={null}
                aiDrafting={false}
                aiError=""
                includeComms={false}
                onIncludeCommsChange={() => {}}
                onAiDraft={() => {}}
              />
            );
          })}
          {/* Products Applied */}
          <label style={labelStyle}>Products Applied</label>
          {quickComplete ? (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginBottom: 16,
              }}
            >
              {(products || []).slice(0, 5).map((p) => {
                const isSelected = selectedProducts.find(
                  (sp) => sp.productId === p.id,
                );
                return (
                  <button
                    key={p.id}
                    onClick={() =>
                      isSelected ? removeProduct(p.id) : addProduct(p)
                    }
                    style={{
                      padding: "6px 12px",
                      borderRadius: 8,
                      fontSize: 12,
                      fontWeight: 600,
                      cursor: "pointer",
                      background: isSelected ? D.teal + "22" : D.card,
                      color: isSelected ? D.teal : D.text,
                      border: `1px solid ${isSelected ? D.teal : D.border}`,
                    }}
                  >
                    {isSelected ? "\u2713 " : ""}
                    {p.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <>
              {" "}
              <input
                type="text"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                placeholder="Search products..."
                style={inputStyle}
              />
              {productSearch && filteredProducts.length > 0 && (
                <div
                  style={{
                    background: D.card,
                    border: `1px solid ${D.border}`,
                    borderRadius: 10,
                    maxHeight: 160,
                    overflowY: "auto",
                    marginTop: 4,
                    marginBottom: 8,
                  }}
                >
                  {filteredProducts.slice(0, 8).map((p) => (
                    <div
                      key={p.id}
                      onClick={() => addProduct(p)}
                      style={{
                        padding: "8px 12px",
                        fontSize: 13,
                        color: D.text,
                        cursor: "pointer",
                        borderBottom: `1px solid ${D.border}`,
                      }}
                    >
                      {p.name}
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {selectedProducts.length > 0 && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 8,
                marginTop: 8,
                marginBottom: 20,
              }}
            >
              {selectedProducts.map((sp) => (
                <div
                  key={sp.productId}
                  style={{
                    background: D.card,
                    border: `1px solid ${D.border}`,
                    borderRadius: 10,
                    padding: 12,
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                    flexWrap: "wrap",
                  }}
                >
                  {" "}
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: D.text,
                      flex: 1,
                      minWidth: 120,
                    }}
                  >
                    {sp.name}
                  </span>{" "}
                  <input
                    type="number"
                    placeholder="Rate"
                    value={sp.rate}
                    onChange={(e) =>
                      updateProduct(sp.productId, "rate", e.target.value)
                    }
                    style={{ ...inputStyle, width: 70, marginBottom: 0 }}
                  />{" "}
                  <select
                    value={sp.rateUnit}
                    onChange={(e) =>
                      updateProduct(sp.productId, "rateUnit", e.target.value)
                    }
                    style={{ ...inputStyle, width: 70, marginBottom: 0 }}
                  >
                    {" "}
                    <option value="oz">oz</option>{" "}
                    <option value="fl_oz">fl oz</option>{" "}
                    <option value="ml">ml</option> <option value="g">g</option>{" "}
                    <option value="lb">lb</option>{" "}
                    <option value="gal">gal</option>{" "}
                  </select>{" "}
                  <input
                    type="number"
                    placeholder="Total"
                    value={sp.totalAmount || ""}
                    onChange={(e) =>
                      updateProduct(sp.productId, "totalAmount", e.target.value)
                    }
                    style={{ ...inputStyle, width: 70, marginBottom: 0 }}
                  />{" "}
                  <select
                    value={sp.amountUnit || sp.rateUnit}
                    onChange={(e) =>
                      updateProduct(sp.productId, "amountUnit", e.target.value)
                    }
                    style={{ ...inputStyle, width: 70, marginBottom: 0 }}
                  >
                    {" "}
                    <option value="oz">oz</option>{" "}
                    <option value="fl_oz">fl oz</option>{" "}
                    <option value="ml">ml</option> <option value="g">g</option>{" "}
                    <option value="lb">lb</option>{" "}
                    <option value="gal">gal</option>{" "}
                  </select>{" "}
                  {areasServiced.length > 0 && (
                    <select
                      value={sp.applicationArea || ""}
                      onChange={(e) =>
                        updateProduct(
                          sp.productId,
                          "applicationArea",
                          e.target.value,
                        )
                      }
                      style={{
                        ...inputStyle,
                        minWidth: 150,
                        flex: "1 1 150px",
                        marginBottom: 0,
                      }}
                    >
                      <option value="">
                        {areasServiced.length === 1
                          ? `Area: ${areasServiced[0]}`
                          : "Treatment area"}
                      </option>
                      {areasServiced.map((area) => (
                        <option key={area} value={area}>
                          {area}
                        </option>
                      ))}
                    </select>
                  )}
                  <select
                    value={productApplicationMethod(sp, serviceTypeForArea)}
                    onChange={(e) =>
                      updateProduct(
                        sp.productId,
                        "applicationMethod",
                        e.target.value,
                      )
                    }
                    style={{
                      ...inputStyle,
                      minWidth: 150,
                      flex: "1 1 150px",
                      marginBottom: 0,
                    }}
                  >
                    <option value="perimeter_spray">Perimeter spray</option>
                    <option value="broadcast_spray">Broadcast spray</option>
                    <option value="spot_treatment">Spot treatment</option>
                    <option value="granular_broadcast">Granular</option>
                    <option value="bait_placement">Bait</option>
                    <option value="station_check">Station check</option>
                    <option value="fog_ulv">Fog/ULV</option>
                    <option value="foliar_spray">Foliar spray</option>
                    <option value="trunk_injection">Trunk injection</option>
                    <option value="pin_stream">Pin stream</option>
                  </select>
                  {(() => {
                    const areaRequirement = requiredApplicationArea(
                      productApplicationMethod(sp, serviceTypeForArea),
                      serviceTypeForArea,
                    );
                    if (!areaRequirement) return null;
                    return (
                      <input
                        type="number"
                        min="1"
                        placeholder={areaRequirement.label}
                        value={sp.areaValue || ""}
                        onChange={(e) =>
                          updateProduct(
                            sp.productId,
                            "areaValue",
                            e.target.value,
                          )
                        }
                        style={{ ...inputStyle, width: 98, marginBottom: 0 }}
                      />
                    );
                  })()}
                  <button
                    onClick={() => removeProduct(sp.productId)}
                    style={{
                      background: "none",
                      border: "none",
                      color: D.red,
                      fontSize: 18,
                      cursor: "pointer",
                      padding: "0 4px",
                    }}
                  >
                    &times;
                  </button>{" "}
                  <ProductTargetsPicker
                    idSuffix={sp.productId}
                    targets={sp.targets}
                    onChange={(next) =>
                      updateProduct(sp.productId, "targets", next)
                    }
                    theme={{
                      labelColor: D.muted,
                      chipBg: D.bg,
                      chipText: D.text,
                      chipBorder: D.border,
                      inputStyle: {
                        ...inputStyle,
                        marginBottom: 0,
                        width: "auto",
                      },
                    }}
                  />
                </div>
              ))}
            </div>
          )}
          {/* Areas Serviced */}
          {!quickComplete && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>Areas Treated</label>{" "}
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {areaOptions.map((area) => {
                  const selected = areasServiced.includes(area);
                  return (
                    <button
                      key={area}
                      onClick={() => toggleArea(area)}
                      style={{
                        padding: "6px 14px",
                        borderRadius: 20,
                        fontSize: 12,
                        fontWeight: 600,
                        cursor: "pointer",
                        background: selected ? D.teal + "22" : D.card,
                        color: selected ? D.teal : D.muted,
                        border: `1px solid ${selected ? D.teal : D.border}`,
                        transition: "all 0.15s",
                      }}
                    >
                      {selected ? "\u2713 " : ""}
                      {area}
                    </button>
                  );
                })}
              </div>{" "}
            </div>
          )}
          {/* Customer Recap */}
          <label style={labelStyle}>Customer Recap</label>
          {isIncompleteVisit ? (
            <div
              style={{
                background: D.card,
                border: `1px solid ${D.border}`,
                borderRadius: 10,
                padding: 12,
                color: D.muted,
                fontSize: 13,
                lineHeight: 1.5,
                marginBottom: 16,
              }}
            >
              This visit will be closed without a customer recap, charge, or
              review request. The office will see the reason and follow up.
            </div>
          ) : (
            <>
              {" "}
              <textarea
                value={customerRecap}
                onChange={(e) => handleCustomerRecapChange(e.target.value)}
                rows={4}
                style={{
                  width: "100%",
                  background: D.input,
                  color: D.text,
                  border: `1px solid ${D.border}`,
                  borderRadius: 10,
                  padding: 12,
                  fontSize: 14,
                  resize: "vertical",
                  fontFamily: "'Nunito Sans', sans-serif",
                  boxSizing: "border-box",
                  marginBottom: 8,
                }}
                placeholder="Customer-facing summary..."
              />{" "}
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  marginBottom: 16,
                }}
              >
                {" "}
                <span
                  style={{
                    fontSize: 12,
                    color: recapError
                      ? D.red
                      : recapStaleAfterEdit
                        ? D.amber
                        : D.muted,
                  }}
                >
                  {recapStatusText}
                </span>{" "}
                <button
                  onClick={regenerateCustomerRecap}
                  disabled={recapLoading}
                  style={{
                    ...btnBase,
                    width: "auto",
                    height: 36,
                    padding: "0 14px",
                    background: "transparent",
                    color: D.teal,
                    border: `1px solid ${D.teal}44`,
                    opacity: recapLoading ? 0.5 : 1,
                  }}
                >
                  Regenerate
                </button>{" "}
              </div>{" "}
            </>
          )}
          {effectiveSendSms && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>
                Customer SMS Preview - {completionSmsTemplateName}
              </label>{" "}
              <div
                style={{
                  background: D.card,
                  border: `1px solid ${D.border}`,
                  borderRadius: 10,
                  padding: 12,
                  color: D.text,
                  fontSize: 13,
                  lineHeight: 1.5,
                  whiteSpace: "pre-wrap",
                }}
              >
                {smsPreview || "Add notes to preview the customer message."}
              </div>{" "}
            </div>
          )}
          {/* Customer Interaction */}
          {!quickComplete && (
            <div style={{ marginBottom: 20 }}>
              {" "}
              <label style={labelStyle}>Customer Interaction</label>{" "}
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {CUSTOMER_INTERACTION_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    onClick={() => setCustomerInteraction(opt.value)}
                    style={{
                      padding: "10px 14px",
                      borderRadius: 10,
                      fontSize: 13,
                      fontWeight: 500,
                      cursor: "pointer",
                      textAlign: "left",
                      background:
                        customerInteraction === opt.value
                          ? D.teal + "18"
                          : D.card,
                      color:
                        customerInteraction === opt.value ? D.teal : D.text,
                      border: `1px solid ${customerInteraction === opt.value ? D.teal : D.border}`,
                      transition: "all 0.15s",
                    }}
                  >
                    {customerInteraction === opt.value ? "\u2713 " : ""}
                    {opt.label}
                  </button>
                ))}
              </div>
              {isCustomerConcernInteraction(customerInteraction) && (
                <input
                  type="text"
                  value={customerConcern}
                  onChange={(e) => setCustomerConcern(e.target.value)}
                  placeholder="Describe the customer's concern..."
                  style={{ ...inputStyle, marginTop: 8 }}
                />
              )}
            </div>
          )}
          {/* Tech-side Pest Pressure rating — desktop variant. Mirrors the
              mobile picker at line ~7392. Same `techRatingAllowed`
              server-computed gate, same payload field, same null-clear
              behavior. The duplication is the cost of the existing
              dual-render architecture (mobile + desktop) in this file —
              keeping both paths in sync prevents desktop techs from
              missing the data-capture entirely (codex-review P2 on the
              first push of #1013). */}
          {techRatingAllowed === true && !quickComplete && (
            <div style={{ marginBottom: 20 }}>
              <label style={labelStyle}>
                Pest activity rating (0–5, optional)
              </label>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                {[0, 1, 2, 3, 4, 5].map((n) => {
                  const selected = clientPestRating === n;
                  return (
                    <button
                      key={n}
                      type="button"
                      onClick={() =>
                        setClientPestRating(selected ? null : n)
                      }
                      style={{
                        minWidth: 44,
                        height: 40,
                        borderRadius: 10,
                        background: selected ? D.teal + "18" : D.card,
                        color: selected ? D.teal : D.text,
                        border: `1px solid ${selected ? D.teal : D.border}`,
                        fontSize: 14,
                        fontWeight: 600,
                        cursor: "pointer",
                        transition: "all 0.15s",
                      }}
                      aria-pressed={selected}
                      aria-label={`Rate pest activity ${n} out of 5`}
                    >
                      {n}
                    </button>
                  );
                })}
              </div>
              <div
                style={{
                  marginTop: 6,
                  fontSize: 12,
                  color: D.muted,
                }}
              >
                0 = none, 5 = severe. Tap a number again to clear.
              </div>
            </div>
          )}
          {/* Options */}
          <label style={labelStyle}>Options</label>{" "}
          <label
            style={{
              ...checkboxRow,
              borderColor: oneTimeRecapOnly ? D.teal : checkboxRow.borderColor,
              opacity: isIncompleteVisit ? 0.55 : 1,
            }}
          >
            {" "}
            <input
              type="checkbox"
              checked={oneTimeRecapOnly && !isIncompleteVisit}
              disabled={isIncompleteVisit}
              onChange={(e) => handleOneTimeRecapOnlyChange(e.target.checked)}
            />{" "}
            <span>One-time recap + review only (no invoice)</span>{" "}
          </label>{" "}
          <label style={checkboxRow}>
            {" "}
            <input
              type="checkbox"
              checked={effectiveSendSms}
              disabled={isIncompleteVisit || oneTimeRecapOnly}
              onChange={(e) => setSendSms(e.target.checked)}
            />{" "}
            <span>
              {isIncompleteVisit
                ? "Completion SMS suppressed"
                : oneTimeRecapOnly
                  ? "Completion SMS included"
                  : "Send completion SMS to customer"}
            </span>{" "}
          </label>{" "}
          {willInvoice && effectiveSendSms && !oneTimeRecapOnly && (
            <label style={{ ...checkboxRow, marginLeft: 24 }}>
              {" "}
              <input
                type="checkbox"
                checked={includePayLink}
                onChange={(e) => setIncludePayLink(e.target.checked)}
              />{" "}
              <span>
                {includePayLink
                  ? "Include payment link in the text"
                  : "Report only — no pay link (paid in person)"}
              </span>{" "}
            </label>
          )}{" "}
          <label style={checkboxRow}>
            {" "}
            <input
              type="checkbox"
              checked={willReview}
              disabled={!!reviewSuppressionReason || oneTimeRecapOnly}
              onChange={(e) => setRequestReview(e.target.checked)}
            />{" "}
            <span>
              {reviewSuppressionReason
                ? "Review request suppressed"
                : oneTimeRecapOnly
                  ? "Review request included"
                  : "Send review request"}
            </span>{" "}
          </label>
          {willReview && !oneTimeRecapOnly && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: isMobile ? "1fr" : "1fr 1fr",
                gap: 8,
                margin: "-4px 0 12px 30px",
              }}
            >
              <select
                value={reviewTiming}
                onChange={(e) => setReviewTiming(e.target.value)}
                style={inputStyle}
              >
                <option value="now">Now</option>
                <option value="120">In 2 hours</option>
                <option value="tomorrow_8">Tomorrow at 8 AM</option>
                <option value="custom">Custom time</option>
              </select>
              {reviewTiming === "custom" ? (
                <input
                  type="datetime-local"
                  value={reviewCustomAt}
                  onChange={(e) => setReviewCustomAt(e.target.value)}
                  style={inputStyle}
                />
              ) : (
                <div />
              )}
            </div>
          )}
          {/* Next Visit Prompt */}
          {nextVisit && (
            <div
              style={{
                marginTop: 16,
                padding: "12px 16px",
                borderRadius: 10,
                background: D.card,
                border: `1px solid ${D.border}`,
              }}
            >
              {" "}
              <div
                style={{
                  fontSize: 12,
                  fontWeight: 700,
                  color: D.muted,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 6,
                }}
              >
                Next Scheduled Visit
              </div>{" "}
              <div style={{ fontSize: 14, color: D.heading, fontWeight: 600 }}>
                {nextVisit.date
                  ? new Date(nextVisit.date + "T00:00:00").toLocaleDateString(
                      "en-US",
                      { weekday: "short", month: "short", day: "numeric" },
                    )
                  : "N/A"}
                <span
                  style={{
                    fontSize: 12,
                    color: D.muted,
                    fontWeight: 400,
                    marginLeft: 8,
                  }}
                >
                  ({nextVisit.serviceType || "Standard service"})
                </span>{" "}
              </div>
              {!showNextVisitNote ? (
                <button
                  onClick={() => setShowNextVisitNote(true)}
                  style={{
                    background: "none",
                    border: "none",
                    color: D.amber,
                    fontSize: 12,
                    cursor: "pointer",
                    padding: 0,
                    marginTop: 6,
                    textDecoration: "underline",
                  }}
                >
                  Needs adjustment?
                </button>
              ) : (
                <input
                  type="text"
                  value={nextVisitNote}
                  onChange={(e) => setNextVisitNote(e.target.value)}
                  placeholder="Note about next visit adjustment..."
                  style={{ ...inputStyle, marginTop: 8, marginBottom: 0 }}
                />
              )}
            </div>
          )}
        </div>
        {/* Footer */}
        <div
          style={{
            padding: "16px 24px",
            borderTop: `1px solid ${D.border}`,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {" "}
          <button
            onClick={() => handleSubmit()}
            disabled={
              submitting ||
              generating ||
              tankCleanoutCompletionBlocked ||
              blackoutCompletionBlocked ||
              nLimitCompletionBlocked ||
              managerApprovalCompletionBlocked ||
              treeShrubCompletionBlocked ||
              protocolActualsCompletionBlocked
            }
            style={{
              ...btnBase,
              width: "100%",
              background: D.green,
              color: "#fff",
              fontSize: 14,
              height: 52,
              opacity:
                submitting ||
                tankCleanoutCompletionBlocked ||
                blackoutCompletionBlocked ||
                nLimitCompletionBlocked ||
                managerApprovalCompletionBlocked ||
                treeShrubCompletionBlocked ||
                protocolActualsCompletionBlocked
                  ? 0.6
                  : 1,
              flexDirection: "column",
              lineHeight: 1.3,
            }}
          >
            {submitting ? (
              completionCtaLabel
            ) : (
              <>
                {" "}
                <span style={{ fontSize: 15, fontWeight: 700 }}>
                  {completionCtaLabel}
                </span>{" "}
                <span style={{ fontSize: 11, fontWeight: 400, opacity: 0.85 }}>
                  {isIncompleteVisit
                    ? "Office follow-up alert will be created"
                    : effectiveSendSms
                      ? `SMS + Report sent to ${service.customerName}`
                      : `Report saved for ${service.customerName}`}
                </span>{" "}
              </>
            )}
          </button>{" "}
        </div>{" "}
      </div>{" "}
    </>,
    document.body,
  );
}

const labelStyle = {
  display: "block",
  fontSize: 12,
  fontWeight: 700,
  color: D.muted,
  textTransform: "uppercase",
  letterSpacing: 0.8,
  marginBottom: 8,
};
const subLabelStyle = { fontSize: 11, color: D.muted, marginBottom: 4 };
const inputStyle = {
  width: "100%",
  background: D.input,
  color: D.text,
  border: `1px solid ${D.border}`,
  borderRadius: 8,
  padding: "10px 12px",
  fontSize: 13,
  boxSizing: "border-box",
  marginBottom: 8,
};
const checkboxRow = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  fontSize: 13,
  color: D.text,
  cursor: "pointer",
  marginBottom: 8,
};

// Quick-pick suggestions for the per-product pest-target picker. The field is
// free-text (string[]), so this list is convenience only — techs can type any
// target. Common SWFL household/lawn pests.
const PEST_TARGET_SUGGESTIONS = [
  "Ghost ants",
  "Big-headed ants",
  "White-footed ants",
  "Carpenter ants",
  "Fire ants",
  "Argentine ants",
  "American roaches",
  "German roaches",
  "Silverfish",
  "Spiders",
  "Earwigs",
  "Millipedes",
  "Centipedes",
  "Springtails",
  "Booklice",
  "Crickets",
  "Wasps / hornets",
  "Fleas",
  "Ticks",
  "Pantry pests",
  "Rodents",
  "Mosquitoes",
  "Scorpions",
];

// Per-product pest-target multiselect: free-text chips with datalist
// suggestions. Stored on the selected product as `targets` (string[]); the
// completion route persists it to service_products.targets. Optional.
function ProductTargetsPicker({ targets, onChange, idSuffix, theme }) {
  const [draft, setDraft] = useState("");
  const list = Array.isArray(targets) ? targets : [];
  const datalistId = `pest-targets-${idSuffix}`;
  function commit(raw) {
    const cleaned = String(raw || "")
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean);
    if (!cleaned.length) {
      setDraft("");
      return;
    }
    const next = [...list];
    for (const value of cleaned) {
      if (!next.some((t) => t.toLowerCase() === value.toLowerCase())) {
        next.push(value);
      }
    }
    if (next.length !== list.length) onChange(next);
    setDraft("");
  }
  function remove(value) {
    onChange(list.filter((t) => t !== value));
  }
  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        alignItems: "center",
        gap: 6,
        flex: "1 1 100%",
        minWidth: 0,
      }}
    >
      <span style={{ fontSize: 12, fontWeight: 600, color: theme.labelColor }}>
        Targets
      </span>
      {list.map((t) => (
        <span
          key={t}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            background: theme.chipBg,
            border: `1px solid ${theme.chipBorder}`,
            color: theme.chipText,
            borderRadius: 999,
            padding: "2px 4px 2px 10px",
            fontSize: 12,
          }}
        >
          {t}
          <button
            type="button"
            onClick={() => remove(t)}
            aria-label={`Remove ${t}`}
            style={{
              background: "none",
              border: "none",
              color: theme.chipText,
              cursor: "pointer",
              fontSize: 14,
              lineHeight: 1,
              padding: "0 2px",
            }}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        list={datalistId}
        value={draft}
        placeholder={list.length ? "Add target…" : "Add pest target…"}
        onChange={(e) => {
          const value = e.target.value;
          if (value.includes(",")) {
            commit(value);
            return;
          }
          // Auto-commit when the value exactly matches a suggestion (datalist
          // pick), so selecting works without relying on Enter/blur on mobile.
          if (
            PEST_TARGET_SUGGESTIONS.some(
              (s) => s.toLowerCase() === value.trim().toLowerCase(),
            )
          ) {
            commit(value);
            return;
          }
          setDraft(value);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && !draft && list.length) {
            remove(list[list.length - 1]);
          }
        }}
        onBlur={() => commit(draft)}
        style={{ ...theme.inputStyle, flex: "1 1 140px", minWidth: 120 }}
      />
      <datalist id={datalistId}>
        {PEST_TARGET_SUGGESTIONS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>
    </div>
  );
}

/* ── Protocol Reference Tab ────────────────────────────── */

const MONTH_NAMES = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/* Product descriptions — plain-language for techs and Virginia */
const PRODUCT_DESCRIPTIONS = {
  "acelepryn xtra": "prevents chinch bugs, webworms, and grubs for 2-3 months",
  acelepryn: "prevents chinch bugs, webworms, and grubs for 2-3 months",
  "speedzone southern": "kills broadleaf weeds without harming St. Augustine",
  speedzone: "kills broadleaf weeds without harming St. Augustine",
  "celsius wg": "selective weed killer for warm-season grass (max 3x/year)",
  celsius: "selective weed killer for warm-season grass (max 3x/year)",
  "k-flow 0-0-25":
    "potassium that strengthens roots against drought and disease",
  "k-flow": "potassium that strengthens roots against drought and disease",
  "prodiamine 65 wdg":
    "pre-emergent that stops crabgrass and weeds before they sprout",
  prodiamine: "pre-emergent that stops crabgrass and weeds before they sprout",
  "lesco 24-0-11": "slow-release nitrogen fertilizer for steady green-up",
  "lesco 24-2-11":
    "slow-release fertilizer with phosphorus for root development",
  "lesco 0-0-18": "potassium + magnesium for winter root strength",
  "lesco elite 0-0-28":
    "premium potassium for winter hardiness and root health",
  "chelated iron plus":
    "foliar iron for deep green color without excess growth",
  "chelated iron": "foliar iron for deep green color without excess growth",
  "high mn combo": "manganese and micronutrients for stress recovery",
  "carbonpro-l":
    "biostimulant that feeds soil biology and improves nutrient uptake",
  "headway g":
    "dual-action fungicide for large patch and take-all root rot (FRAC 11+3)",
  headway:
    "dual-action fungicide for large patch and take-all root rot (FRAC 11+3)",
  "medallion sc":
    "fungicide for large patch — different mode of action (FRAC 7)",
  medallion: "fungicide for large patch — different mode of action (FRAC 7)",
  "torque sc": "fungicide for fall disease prevention (FRAC 12)",
  torque: "fungicide for fall disease prevention (FRAC 12)",
  "sedgehammer plus": "kills nutsedge without damaging turf",
  sedgehammer: "kills nutsedge without damaging turf",
  dismiss: "fast-acting sedge control — visible results in days",
  "primo maxx":
    "plant growth regulator for denser, thicker turf (Premium only)",
  "talstar p": "broad-spectrum insecticide for chinch bug rescue treatment",
  talstar: "broad-spectrum insecticide for chinch bug rescue treatment",
  "arena 50 wdg":
    "backup insecticide if Talstar fails — different mode of action (Group 4A)",
  arena:
    "backup insecticide if Talstar fails — different mode of action (Group 4A)",
  hydretain: "moisture manager that reduces watering needs by 50%",
  "atrazine 4l":
    "winter broadleaf and grassy weed control (apply under 85F only)",
  atrazine: "winter broadleaf and grassy weed control (apply under 85F only)",
  "three-way":
    "broadleaf weed killer — backup when Atrazine is weather-blocked",
  "blindside wdg":
    "broadleaf + sedge control — safe fallback after Celsius cap (Groups 14+2)",
  blindside:
    "broadleaf + sedge control — safe fallback after Celsius cap (Groups 14+2)",
  "pillar sc":
    "dual fungicide for take-all root rot / low-light stress sites (FRAC 11+3)",
  pillar:
    "dual fungicide for take-all root rot / low-light stress sites (FRAC 11+3)",
  "moisture manager": "wetting agent that helps water penetrate compacted soil",
  dispatch: "wetting agent that helps water penetrate compacted soil",
  "green flo 6-0-0": "calcium supplement for summer cation balance",
  "green flo phyte plus":
    "phosphite + potassium for disease suppression and root health",
  "snapshot 2.5tg": "granular bed pre-emergent for long residual weed prevention",
  snapshot: "granular bed pre-emergent for long residual weed prevention",
  "8-2-12": "palm fertilizer with potassium and magnesium for palm nutrition",
  "13-0-13": "ornamental fertilizer used only where N/P rules allow",
  "suffoil-x": "horticultural oil for scale, mites, and whitefly crawlers when plant/weather safe",
  suffoil: "horticultural oil for scale, mites, and whitefly crawlers when plant/weather safe",
  merit: "imidacloprid systemic; counts as IRAC 4A/neonic pressure",
  zylam: "fast systemic rescue; counts as IRAC 4A/neonic pressure",
  kontos: "non-neonic systemic rotation for sucking pests and mites (IRAC 23)",
  mainspring: "non-neonic option for whiteflies, caterpillars, leafminers, and resistance management (IRAC 28)",
  "distance igr": "insect growth regulator for whitefly and scale eggs/nymphs/crawlers (IRAC 7C)",
  distance: "insect growth regulator for whitefly and scale eggs/nymphs/crawlers (IRAC 7C)",
  talus: "insect growth regulator for immature whitefly and scale stages (IRAC 16)",
  "kphite 7lp": "phosphite support for root/oomycete pressure; FRAC P07",
  kphite: "phosphite support for root/oomycete pressure; FRAC P07",
  conserve: "spinosyn option for caterpillar/thrips-type work where labeled",
  floramite: "miticide for confirmed mite pressure only",
  "liquid copper": "contact protectant for labeled leaf or bacterial disease; keep separate from oil",
  eddha: "iron chelate for high-pH chlorosis situations",
  shortstop: "plant growth regulator add-on for healthy established hedges",
};

/* Safety rules per track */
const TRACK_SAFETY_RULES = {
  st_augustine: [
    "Celsius WG: MAX 3 apps/year/property",
    "SpeedZone: verify cultivar and do NOT apply >90\u00b0F",
    "Hold PGR/hot herbicide on stressed turf",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
  A_St_Aug_Sun: [
    "Celsius WG: MAX 3 apps/year/property",
    "SpeedZone: verify cultivar and do NOT apply >90\u00b0F",
    "Hold PGR/hot herbicide on stressed turf",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
  B_St_Aug_Shade: [
    "Celsius WG: MAX 3 apps/year/property",
    "SpeedZone: verify cultivar and do NOT apply >90\u00b0F",
    "Hold PGR/hot herbicide on stressed turf",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
  C1_Bermuda: [
    "Celsius WG: MAX 3 apps/year/property",
    "No Atrazine on Bermuda \u2014 EVER",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
  C2_Zoysia: [
    "Celsius WG: MAX 3 apps/year/property",
    "No Atrazine on Zoysia \u2014 EVER",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
  D_Bahia: [
    "Celsius WG: MAX 3 apps/year/property",
    "SpeedZone: do NOT apply >90\u00b0F",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
};

/* Named exports for V2 reuse (ProtocolReferenceTabV2) */
export {
  MONTH_NAMES,
  PRODUCT_DESCRIPTIONS,
  TRACK_SAFETY_RULES,
  stripLegacyBoilerplate,
};

// V1 page + render chain retired.
//
// /admin/schedule → redirects to /admin/dispatch?tab=schedule
// /admin/dispatch → AdminDispatchPage (Board tab + DispatchPageV2)
//
// This file is retained only as a shared module for V2 consumers:
//   - CompletionPanel / RescheduleModal / EditServiceModal /
//     ProtocolPanel → DispatchPageV2
//   - MONTH_NAMES / PRODUCT_DESCRIPTIONS / TRACK_SAFETY_RULES /
//     stripLegacyBoilerplate → ProtocolReferenceTabV2
//
// Removed in the dead-code cleanup pass:
//   - StatusBadge / TierBadge / LeadScoreBadge / PropertyAlerts /
//     ServiceCard / groupMultiServiceStops / TechSection (the V1
//     render chain — never instantiated since the V1 page was deleted)
//   - sanitizeServiceTypeClient / formatLastServiceDate /
//     formatDateDisplay / isToday (only used by the dead chain)
//   - STATUS_CONFIG / TIER_COLORS (only used by the dead badges)
//   - parseProductLines / TierDot / TierDots / CurrentVisitCard /
//     ProtocolReferenceTab (V2 sibling ProtocolReferenceTabV2 is the
//     only consumer; its imports come from the export block above)
//   - RecurringAlertsBanner (V2 sibling RecurringAlertsBannerV2 in
//     components/schedule/ replaces it)
