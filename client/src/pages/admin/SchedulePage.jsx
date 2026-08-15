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
import { confirmCardHoldFeeChoice } from "../../lib/cardHoldCancel";
import { useFeatureFlagReady } from "../../hooks/useFeatureFlag";
import useSpeechDictation from "../../hooks/useSpeechDictation";
import { Mic, MicOff } from "lucide-react";
import ProjectFindingFieldInput from "../../components/tech/ProjectFindingFieldInput";
import TechTreatmentZoneModal from "../../components/tech/TechTreatmentZoneModal";
import EstimateProvenanceCard from "../../components/schedule/EstimateProvenanceCard";
import SlotConflictNotice from "../../components/schedule/SlotConflictNotice";
import { useSlotConflicts } from "../../components/schedule/useSlotConflicts";
import BestTimeHint from "../../components/schedule/BestTimeHint";
import { useBestTimes } from "../../components/schedule/useBestTimes";
import {
  describeCardRequestState,
  describeCardRequestResult,
  canSendCardRequest,
} from "../../components/schedule/cardLinkStatus";
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
const VISIT_OUTCOME_OPTIONS = [
  { value: "completed", label: "Completed" },
  { value: "inspection_only", label: "Inspection only" },
  { value: "customer_declined", label: "Customer declined" },
  { value: "follow_up_needed", label: "Follow-up needed" },
  { value: "customer_concern", label: "Customer concern" },
  { value: "incomplete", label: "Incomplete" },
];
// Plan/approval-engine block messages predate the advisory policy and can
// still phrase conditions as approval mandates. Soften them for display —
// the closeout never blocks, so the copy must not claim review is required.
function softenApprovalWording(text) {
  return String(text || "")
    .replace(
      /;\s*manager (?:review|approval) is required before applying it\.?/gi,
      " — double-check before applying.",
    )
    .replace(/\brequires manager approval\b/gi, "flagged for review")
    .trim();
}
// Rig-calibration states worth a closeout advisory line. Deliberately
// excludes 'equipment_selection_required' — with no equipment step left in
// the closeout, "select equipment" would be permanent noise.
const CALIBRATION_ADVISORY_CODES = new Set([
  "missing_calibration",
  "expired_calibration",
  "calibration_not_field_verified",
]);
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
  // Bed bug is an interior treatment — yard/fence chips read wrong on its
  // closeout (owner 2026-07-31, untype lane). Vocabulary carries over the
  // retired typed form's treatment surfaces. Labels never contain commas
  // (the per-product area field comma-joins selections).
  bed_bug: [
    "Primary bedroom",
    "Guest bedroom",
    "Living room",
    "Mattress & box spring",
    "Bed frame & headboard",
    "Baseboards",
    "Furniture & upholstery",
    "Closets",
    "Adjacent rooms",
  ],
  lawn: [
    "Front yard",
    "Back yard",
    "Side yards",
  ],
};
// Per-product treatment areas are multi-select but stored as ONE
// comma-joined string in the existing applicationArea field
// ("Kitchen, Bathrooms") so drafts, the submit payload, and the
// service_products.application_area column keep their shape — only the
// picker UI changed. Area labels are a controlled chip vocabulary and
// never contain commas.
function parseApplicationAreas(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
// Chip choices = this visit's treated-area chips, plus any already-selected
// area that is no longer chipped at the visit level. Keeping stale
// selections visible (instead of hiding them like the old <select> did)
// lets the tech see and clear a value that would otherwise submit
// invisibly from p.applicationArea (same trap as codex P3 r2 on #2950).
function productAreaChoices(areasServiced, currentValue) {
  const choices = [...areasServiced];
  for (const area of parseApplicationAreas(currentValue)) {
    if (!choices.includes(area)) choices.push(area);
  }
  return choices;
}
function toggleProductAreaValue(currentValue, area, orderedChoices) {
  const selected = parseApplicationAreas(currentValue);
  const next = selected.includes(area)
    ? selected.filter((a) => a !== area)
    : orderedChoices.filter((a) => selected.includes(a) || a === area);
  return next.join(", ");
}
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
      // err.code (lawn_assessment_stale and friends), so a bare
      // "HTTP 409" string breaks that routing.
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

// Token per category that /admin/protocols/photos/relevant classifies to the
// same line the panel renders (its filter matches literal tokens only).
const PHOTO_LOOKUP_TYPE_BY_CATEGORY = {
  lawn: "lawn",
  tree_shrub: "tree shrub",
  pest: "pest",
  mosquito: "mosquito",
  termite: "termite",
};

function detectServiceCategory(serviceType) {
  const s = (serviceType || "").toLowerCase();
  // "Palmetto" is a roach, not a palm — the word-bounded exception must run
  // before the palm check or "Palmetto Roach Knockdown" classifies as
  // tree_shrub (mirrors the server classifier).
  if (/\bpalmetto\b/.test(s)) return "pest";
  // Pest-primary combined names ("Quarterly Pest + Termite Bait Station")
  // stay pest — the companion token names a section, not the line (mirrors
  // the server classifier's rule exactly).
  if (
    /\bpest\b.*\b(rodent|termite)\b/.test(s) &&
    !/\b(lawn|turf|grass|weed|fertil|mosquito)\b/.test(s)
  )
    return "pest";
  // Precedence mirrors the server's detectServiceLine: explicit lawn-SURFACE
  // tokens win (the combined "Lawn + Tree & Shrub" service stays lawn), while
  // tree/shrub outranks only lawn's ambiguous treatment tokens — "Tree &
  // Shrub Fertilization" is a tree & shrub service, not lawn.
  const hasLawnSurface =
    s.includes("lawn") ||
    s.includes("turf") ||
    s.includes("grass") ||
    s.includes("sod");
  if (
    !hasLawnSurface &&
    // Mosquito/termite/WDO tokens outrank tree tokens ("Tree Line Mosquito
    // Treatment" is mosquito work) — mirrors the server normalizer's
    // tree/shrub exclusions exactly. Ornamental/Arborjet are the server's
    // tree/shrub aliases (service-line-configs.js).
    !s.includes("mosquito") &&
    !s.includes("termite") &&
    !s.includes("wdo") &&
    (s.includes("tree") ||
      s.includes("shrub") ||
      s.includes("ornamental") ||
      s.includes("arborjet") ||
      /\bpalm(s)?\b/.test(s))
  )
    return "tree_shrub";
  if (
    hasLawnSurface ||
    s.includes("fertil") ||
    s.includes("weed") ||
    s.includes("dethatch") ||
    s.includes("top dress") ||
    s.includes("aerat")
  )
    return "lawn";
  if (s.includes("mosquito")) return "mosquito";
  // Termite-product aliases mirror the server normalizer, which maps EVERY
  // /advance/ label to a termite type. Word-bounded \badvance\b never
  // matches "Advanced Pest Control" (trailing d), so the bare alias is safe.
  if (
    s.includes("termite") ||
    s.includes("wdo") ||
    s.includes("bora") ||
    s.includes("trelona") ||
    s.includes("termidor") ||
    // Drill-and-foam termite forms only ("Foam Drill", "Drill-and-Foam",
    // "Recurring Foam Treatment (Quarterly)") — NOT a bare 'foam' token,
    // which would steal rodent-exclusion foam-sealing visits.
    /foam[\s_-]*drill|drill[\s_&-]*(?:and[\s_-]*)?foam|recurring[\s_-]*foam|foam[\s_-]*recurring/.test(s) ||
    /\badvance\b/.test(s)
  )
    return "termite";
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

// Total product for an area-based application: rate (per 1,000 sq ft) × sq ft
// treated, in the rate's own unit. Empty string when either side is unusable
// so the field stays blank rather than showing NaN/0.
export function derivedTotalAmount(rate, areaSqft) {
  const r = Number(rate);
  const a = Number(areaSqft);
  if (!Number.isFinite(r) || r <= 0 || !Number.isFinite(a) || a <= 0) return "";
  return Math.round(r * (a / 1000) * 100) / 100;
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

// completion_side_effects_running means the completion COMMITTED (the claim
// only returns it for an attempt that already has a service_record) and the
// server is still running its post-commit side effects — usually the
// original request finishing while this client's response got lost in the
// field. A same-key retry resolves every outcome (replay once it succeeds,
// resume if it failed), so the panel retries quietly instead of surfacing a
// dead-end "Failed to complete service" dialog. ~2 minutes of polling covers
// any live run; a crash-stranded claim only frees after the server's
// 10-minute stale window, which is what the give-up copy points at.
const SIDE_EFFECTS_RETRY_MS = 5000;
const SIDE_EFFECTS_MAX_RETRIES = 24;
export const SIDE_EFFECTS_GIVE_UP_MESSAGE =
  "This visit is saved — its report and billing steps are still wrapping up on the server. You can leave this screen; if the visit still shows incomplete in about 10 minutes, open it and complete it again to finish up.";

// The retry decision for a submit error, given how many quiet retries this
// submit chain has already made: retry (same key, fixed delay), give up with
// the honest saved-not-finalized copy, or null for every other error so the
// existing handlers keep it.
export function completionSideEffectsRetryPlan(error, retryCount) {
  if (error?.code !== "completion_side_effects_running") return null;
  if (retryCount < SIDE_EFFECTS_MAX_RETRIES) {
    return { action: "retry", delayMs: SIDE_EFFECTS_RETRY_MS };
  }
  return { action: "give_up", message: SIDE_EFFECTS_GIVE_UP_MESSAGE };
}

// Cross-key resolution of a committed chain: the server's resumable claim
// matches by SERVICE (any key), but success replay is same-key only — so a
// chain whose 409s were held under key A (panel reloaded / second device)
// sees `service_already_completed` once the original attempt (key B)
// finishes. Inside a committed chain that response IS completion, never a
// failure (codex P1 #3187 r6).
export const CROSS_KEY_COMPLETED_MESSAGE =
  "This visit is completed and saved — the original submission finished while this screen was retrying. If today's invoice is due for collection, open the visit's billing to take payment.";
export function completionCrossKeyCompleted(error, chainCommitted) {
  return chainCommitted === true && error?.code === "service_already_completed";
}

// Maps the completion-status poll response (GET /:serviceId/completion-status,
// codex P1 #3187 r11) to the panel's next move. The media-bearing completion
// body POSTs only to claim/resume ("resume"); everything else resolves from
// the lightweight status. Unknown states keep waiting — the poll cap turns
// persistent nonsense into the honest give-up, never a false failure.
export function completionStatusPlan(status) {
  const state = status?.state;
  if (state === "succeeded") return "success";
  if (state === "succeeded_other_key" || state === "completed_no_attempt") return "cross_key";
  if (state === "resumable" || state === "none") return "resume";
  if (state === "failed") return "failed";
  return "wait";
}

// The completion route's pre-submit reconciliation 409 (code
// 'report_reconcile', behind GATE_REPORT_RECONCILE_PROMPT): the server
// packs the human-readable contradictions into the error string because
// adminFetch surfaces only message + code. Returns the confirm() text, or
// null for any other error so the generic handler keeps it. The 409
// deliberately does NOT reset the idempotency key
// (shouldResetCompletionIdempotencyKey), so a confirmed resubmit replays
// under the same key.
export function completionReconcilePrompt(error) {
  if (error?.code !== "report_reconcile") return null;
  const lead = String(error?.message || "").trim()
    || "The report disagrees with the recorded values.";
  return `${lead}\n\nOK — complete anyway (the recorded values stay authoritative on the report).\nCancel — go back to fix the fields or regenerate the AI report.`;
}

// Human copy for a re-entry stepper value ("No wait", "45 min", "2 hr",
// "2 hr 15 min"). Minutes only — the steppers clamp to 0..1440.
export function formatReentryStepperMinutes(min) {
  const n = Math.max(0, Math.round(Number(min) || 0));
  if (n === 0) return "No wait";
  const hr = Math.floor(n / 60);
  const rem = n % 60;
  if (!hr) return `${n} min`;
  return rem ? `${hr} hr ${rem} min` : `${hr} hr`;
}

export function completionPreferencesNeedDraft({
  sendSms = true,
  includePayLink = true,
  requestReview = true,
  clientPestRating = null,
  backfillCloseout = false,
  backfillCloseoutDefault = false,
  backfillTimeOnSite = "",
  adjustedTimeOnSite = "",
  offerInspectionCredit = true,
  reentryExteriorDirty = false,
  reentryInteriorDirty = false,
} = {}) {
  return sendSms !== true
    || includePayLink !== true
    || requestReview !== true
    || clientPestRating != null
    // The inspection-credit opt-out is default-ON: a cleared box that does
    // not survive the billing/draft detour silently records a credit
    // promise the tech explicitly declined (Codex #3178 r25 P2).
    || offerInspectionCredit !== true
    // The backdated-closeout choices are quiet/loud state: losing a checked
    // box across a reload turns the SAME submit into a LOUD completion
    // (sends + collection rails), and the ≥7-days default is CHECKED, so it
    // is drift from the panel default — either direction — that needs a
    // draft. Typed minutes ride along like any other text field.
    || backfillCloseout !== backfillCloseoutDefault
    || String(backfillTimeOnSite || "").trim() !== ""
    // The live admin override rides along the same way: losing typed
    // minutes across a reload silently records the inflated timer instead.
    || String(adjustedTimeOnSite || "").trim() !== ""
    // A moved re-entry stepper is operator input on the customer's
    // countdown: losing it across a reload silently restores the default
    // window the tech explicitly changed.
    || reentryExteriorDirty
    || reentryInteriorDirty;
}

// timeOnSite fragment of the completion POST body. The panel's running
// `elapsed` derives from the visit's ORIGINAL check-in — for a stale on_site
// row that's days or weeks — and the server books any submitted timeOnSite
// as explicit operator input (persisted service duration + job-costing
// labor). Under a backdated closeout only an operator-TYPED positive number
// of minutes may travel; blank/invalid omits the key so the duration stays
// unknown. On a live completion the wire contract is TYPE-based: a NUMBER
// is an admin-typed override of the running timer (validated 1..720 —
// out-of-range falls back to the elapsed string so a stray value never
// ships as operator input; handleSubmit blocks it with an alert first), a
// string is the auto-elapsed timer, recorded exactly as before.
export function completionTimeOnSiteBody({ backfill, typedMinutes, elapsed, adjustedMinutes = "" }) {
  if (!backfill) {
    const trimmed = String(adjustedMinutes ?? "").trim();
    if (trimmed !== "") {
      const minutes = Math.round(Number(trimmed));
      if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 720) {
        return { timeOnSite: minutes };
      }
    }
    return { timeOnSite: elapsed };
  }
  const minutes = Math.round(Number(typedMinutes));
  return Number.isFinite(minutes) && minutes > 0 ? { timeOnSite: minutes } : {};
}

// Restore leg of the draft snapshot for the backdated-closeout choices. A
// draft that predates these fields restores the panel default (missing ≠
// false: for a ≥7-days-stale visit the default is CHECKED, and restoring
// false would turn the same submit LOUD — sends + collection rails).
// Eligibility is NOT re-checked here: every consumer (backfillQuietCloseout,
// the submit body, the checkbox render) already gates on backfillEligible,
// so a value restored onto a no-longer-eligible panel is inert by
// construction.
export function restoredBackfillChoices(savedDraft, backfillCloseoutDefault = false) {
  return {
    backfillCloseout:
      typeof savedDraft?.backfillCloseout === "boolean"
        ? savedDraft.backfillCloseout
        : backfillCloseoutDefault,
    backfillTimeOnSite:
      typeof savedDraft?.backfillTimeOnSite === "string"
        ? savedDraft.backfillTimeOnSite
        : "",
    adjustedTimeOnSite:
      typeof savedDraft?.adjustedTimeOnSite === "string"
        ? savedDraft.adjustedTimeOnSite
        : "",
  };
}

// Why the review ask will not go out for this completion, or null when it
// follows the operator's toggle. "backfill" mirrors the server forcing
// requestReview=false under a backdated quiet closeout — with the reason set,
// the review checkbox shows the suppressed state and the custom-review-time
// validation never blocks a submit the server would silence anyway.
export function completionReviewSuppressionReason({
  isIncompleteVisit = false,
  backfillQuietCloseout = false,
  visitOutcome = "completed",
  customerConcernInteraction = false,
} = {}) {
  if (isIncompleteVisit) return "incomplete";
  if (backfillQuietCloseout) return "backfill";
  if (visitOutcome === "customer_declined") return "customer_declined";
  if (visitOutcome === "customer_concern" || customerConcernInteraction) {
    return "customer_concern";
  }
  // NOTE (coverage fix, 2026-07-30): an invoiced completion is deliberately
  // NOT a client-side suppression anymore. The server owns the invoice rule —
  // a completion-time ask is blocked only while the invoice is UNPAID
  // (admin-dispatch effectiveRequestReview), and the paid-invoice webhook
  // queues the ask when payment lands. The old blanket willInvoice=false here
  // posted requestReview=false, which killed the ask on BOTH sides — including
  // completions paid on the spot — and drove review coverage to near zero.
  return null;
}

export function completionWillReview({
  oneTimeRecapOnly = false,
  requestReview = true,
  reviewSuppressionReason = null,
} = {}) {
  return (oneTimeRecapOnly || !!requestReview) && !reviewSuppressionReason;
}

function completionDraftKey(serviceId) {
  return `waves_completion_draft_${serviceId}`;
}

// A completed visit whose REQUIRED completion-invoice mint failed (503
// backfill_invoice_mint_failed) still owes its resume: the server released
// the completion attempt to the immediately-resumable state and the visit
// row is already 'completed', so without a marker no dispatch surface would
// reopen completion after a reload/dismiss and the mint could strand until
// Billing Recovery sweeps it. CompletionPanel sets the marker when the 503
// lands and clears it on success; DispatchPageV2's completion-open gates
// honor it for completed visits. Exported for DispatchPageV2 — one key
// derivation, no drift.
export function completionResumeOwedKey(serviceId) {
  return `waves_completion_resume_owed_${serviceId}`;
}

export function completionResumeOwed(serviceId) {
  try {
    return localStorage.getItem(completionResumeOwedKey(serviceId)) === "1";
  } catch {
    return false;
  }
}

// Station edits a completion would silently DROP while the registry is
// loading or failed to load: the payload posts no station entries in that
// state (an unloaded registry is unavailable, not empty), but a
// billing-detour draft restores pins, moves, statuses, and retirements
// into all four of these, and a successful submit clears the draft they
// were restored from — permanently deleting the tech's work (pre-push P0).
// handleSubmit fails CLOSED on this; the registry note offers the explicit
// discard instead.
export function pendingStationEdits({ stationNew, stationMoves, stationStatuses, stationRetired }) {
  return stationNew.length > 0
    || Object.keys(stationMoves).length > 0
    || Object.keys(stationStatuses).length > 0
    || stationRetired.length > 0;
}

// Mirrors positionKey in server/services/termite-stations.js: the
// completion sync deduplicates an id-less create landing on an existing
// row's exact position and attaches its check row to the EXISTING station.
// A draft pin colliding with a registry row confirmed after the draft was
// saved (another writer added a station there while the billing detour
// waited) must therefore not display or auto-count as a second trap — the
// completion would record one station while the frozen count says two
// (codex P1 r18). The pin drops and its status transfers to the existing
// row (the same outcome the server's dedupe produces) unless that row
// already carries one.
export function reconcileNewPinsWithRegistry({ stationNew, stationPreloads, stationStatuses }) {
  const existingByPosition = new Map();
  stationPreloads.forEach((station) => {
    if (station?.shape?.cx != null && station?.shape?.cy != null) {
      existingByPosition.set(`${Number(station.shape.cx)}:${Number(station.shape.cy)}`, station.id);
    }
  });
  const keptNew = [];
  const statuses = { ...stationStatuses };
  let changed = false;
  stationNew.forEach((pin) => {
    const key = pin?.shape?.cx != null && pin?.shape?.cy != null
      ? `${Number(pin.shape.cx)}:${Number(pin.shape.cy)}`
      : null;
    const existingId = key == null ? undefined : existingByPosition.get(key);
    if (existingId === undefined) {
      keptNew.push(pin);
      return;
    }
    changed = true;
    if (statuses[pin.key] && !statuses[existingId]) statuses[existingId] = statuses[pin.key];
    delete statuses[pin.key];
  });
  if (!changed) return { changed, stationNew, stationStatuses };
  return { changed, stationNew: keptNew, stationStatuses: statuses };
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
  fontWeight: 500,
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
  { value: "seasonal_feb_oct", label: "Seasonal (Feb–Oct, monthly)" },
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
  // Seasonal (Feb–Oct): walk the 9-month season ordinally, then convert back
  // to a plain month delta so day semantics match the other month cadences.
  // Mirrors the server's seasonalFebOctDate INCLUDING seasonOrdinalForBase's
  // off-season normalization — Nov/Dec/Jan anchors all sit one slot before
  // the coming February, so occurrence 1 lands on that February. Without this
  // the editor previewed the 91-day fallback for a seasonal mosquito series.
  if (pattern === "seasonal_feb_oct") {
    // The preview's first chip is the anchor itself — display it as booked,
    // never renormalized (an off-season office booking is the operator's).
    if (i === 0) return base;
    const SEASON_MONTHS = 9; // Feb..Oct
    const m1 = base.getMonth() + 1;
    const y = base.getFullYear();
    const baseOrdinal = m1 < 2 ? y * SEASON_MONTHS - 1
      : m1 > 10 ? (y + 1) * SEASON_MONTHS - 1
        : y * SEASON_MONTHS + (m1 - 2);
    const ordinal = baseOrdinal + i;
    const targetYear = Math.floor(ordinal / SEASON_MONTHS);
    const targetMonth1 = ((ordinal % SEASON_MONTHS) + SEASON_MONTHS) % SEASON_MONTHS + 2;
    const monthDelta = (targetYear - y) * 12 + (targetMonth1 - m1);
    const d = new Date(base);
    const nthOfBase = Math.ceil(d.getDate() / 7);
    const target = editNthWeekdayOfMonth(
      d.getFullYear(),
      d.getMonth() + monthDelta,
      nthOfBase,
      d.getDay(),
    );
    return isNaN(target.getTime()) ? base : target;
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

// Mirror of the server's clampDateToSeason: a weekend-shifted seasonal date
// that crossed the season edge (Oct 31 Sat → Nov 2) walks back into Feb–Oct
// so the edit preview matches the dates the server will save.
function editClampToSeason(date, pattern, skip) {
  if (pattern !== "seasonal_feb_oct" || !date || isNaN(date.getTime())) return date;
  const m = date.getMonth(); // 0-indexed: Feb=1 … Oct=9
  if (m >= 1 && m <= 9) return date;
  const step = m === 0 ? 1 : -1; // Jan undershoot → forward; Nov/Dec → back
  const out = new Date(date);
  for (let n = 0; n < 75; n++) {
    out.setDate(out.getDate() + step);
    const mm = out.getMonth();
    if (mm < 1 || mm > 9) continue;
    const day = out.getDay();
    if (skip && (day === 0 || day === 6)) continue;
    return out;
  }
  return date;
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
    // customer's default payer (or self-pay). selfPayOverride pins the visit to
    // "customer pays (self)" so an account default payer is NOT inherited.
    // Both round-trip via ...form on save (the server admin-gates actual
    // changes only, so echoing them on every save is required for tech saves).
    payerId: service.payerId != null ? String(service.payerId) : "",
    poNumber: service.poNumber || "",
    selfPayOverride: service.selfPayOverride === true,
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
  // Recorded time on-site for a COMPLETED visit (forgotten-closeout fix,
  // after-the-fact leg): admin-only correction of an inflated recorded
  // duration. Deliberately OUTSIDE `form` — it saves through the dedicated
  // PATCH /admin/dispatch/:id/time-on-site endpoint, never update-details
  // (whose allowlist stays timing-free). Seeded from whichever recorded
  // field the payload carries (dispatch rows: serviceTimeMinutes; schedule
  // rows: actualDuration); the seed doubles as the dirty check so an
  // untouched field never PATCHes.
  const timeOnSiteSeed = (() => {
    const v = service.serviceTimeMinutes ?? service.actualDuration ?? null;
    return v != null && Number(v) > 0 ? String(Math.round(Number(v))) : "";
  })();
  const [timeOnSiteMinutes, setTimeOnSiteMinutes] = useState(timeOnSiteSeed);
  const isCompletedVisit =
    String(service.status || "").toLowerCase() === "completed";
  // Re-entry windows for a COMPLETED visit (interior/exterior dry-down
  // minutes on the customer report). Same posture as the time-on-site
  // correction: OUTSIDE `form`, saved through the dedicated admin-only
  // PATCH /admin/dispatch/:id/reentry endpoint, and seeded from the server
  // (the values live in the report record's advisory, which the appointment
  // payload doesn't carry) — the seed doubles as the dirty check so an
  // untouched field never PATCHes.
  const [reentryInfo, setReentryInfo] = useState(null);
  const [reentryExterior, setReentryExterior] = useState("");
  const [reentryInterior, setReentryInterior] = useState("");
  // Immediate reschedule text when this save moves the visit's date or
  // arrival time — admin chooses per save; default matches the drag-and-drop
  // reschedule modal (no text).
  const [notificationType, setNotificationType] = useState("none");
  // Cancel-appointment confirm overlay.
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelScope, setCancelScope] = useState("this_only");
  const [cancelNotificationType, setCancelNotificationType] = useState("text");
  const [cancelling, setCancelling] = useState(false);
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
  // Advisory only — the save button never keys off this (warn, don't block).
  // Duration mirrors the save payload's summed group duration (primary line
  // + add-on lines): parent estimated_duration_minutes is the whole-visit
  // total, and that's the span occupancy derives a missing end from.
  const slotCheckDuration = (() => {
    const primaryDur = parseInt(form.estimatedDuration, 10);
    const base = Number.isInteger(primaryDur) && primaryDur > 0 ? primaryDur : 0;
    const addonDur = serviceLines.reduce(
      (s, l) =>
        s +
        ((l.serviceType || "").trim() &&
        l.estimatedDuration !== "" &&
        !isNaN(parseInt(l.estimatedDuration, 10))
          ? parseInt(l.estimatedDuration, 10)
          : 0),
      0,
    );
    return base + addonDur;
  })();
  const { conflicts: slotConflicts } = useSlotConflicts({
    date: form.scheduledDate,
    windowStart: form.windowStart,
    windowEnd: form.windowEnd,
    durationMinutes: slotCheckDuration,
    excludeServiceIds: [service.id],
  });
  // Advisory drive-detour suggestions for the same fixed day — picking a
  // chip only fills the window fields (never saves).
  const { bestTimes } = useBestTimes({
    date: form.scheduledDate,
    serviceId: service.id,
    customerId: service.customerId || service.customer_id,
    durationMinutes: slotCheckDuration,
    technicianId: form.technicianId || undefined,
    excludeServiceIds: [service.id],
  });
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
  // Seed the re-entry fields from the report record's stored advisory.
  // A fetch failure (or a visit with no report record) just leaves the
  // fields hidden — nothing to edit.
  useEffect(() => {
    if (!service?.id || !isCompletedVisit) return undefined;
    let cancelled = false;
    adminFetch(`/admin/dispatch/${service.id}/reentry`)
      .then((data) => {
        if (cancelled) return;
        setReentryInfo(data || null);
        if (data?.hasRecord) {
          setReentryExterior(
            data.exteriorMinutes != null ? String(data.exteriorMinutes) : "",
          );
          setReentryInterior(
            data.interiorMinutes != null ? String(data.interiorMinutes) : "",
          );
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [service?.id, isCompletedVisit]);
  const [isRecurring, setIsRecurring] = useState(serviceIsRecurringTemplate);
  const [recurringFreq, setRecurringFreq] = useState(
    service.recurringPattern || service.recurring_pattern || "quarterly",
  );
  const [recurringCount, setRecurringCount] = useState(4);
  const [recurringOngoing, setRecurringOngoing] = useState(
    service.recurringOngoing ?? service.recurring_ongoing ?? true,
  );
  // How many visits this plan actually has ahead of it. Fetched on open for a
  // series so the Count field starts from the truth instead of a placeholder —
  // a wrong seed here doesn't merely display wrong, it is what the save would
  // resize the plan to. Until it resolves the field stays disabled, and if it
  // fails the operator can still type a length by hand (which is an explicit
  // instruction, unlike a stale default).
  const [seriesSummary, setSeriesSummary] = useState(null);
  const [seriesSummaryState, setSeriesSummaryState] = useState(
    serviceIsRecurringTemplate ? "loading" : "idle",
  );
  const recurringCountTouched = useRef(false);
  const recurringOngoingTouched = useRef(false);
  useEffect(() => {
    // Template only: the panel is hidden on a child visit, so there is no
    // length to seed and no reason to spend the request.
    if (!service?.id || !serviceIsRecurringTemplate) return undefined;
    let cancelled = false;
    adminFetch(`/admin/schedule/${service.id}/series-summary`)
      .then((data) => {
        if (cancelled) return;
        if (!data?.series) {
          setSeriesSummaryState("idle");
          return;
        }
        setSeriesSummary(data);
        setSeriesSummaryState("loaded");
        // Never clobber a number the operator already typed while this was
        // in flight.
        if (!recurringCountTouched.current && data.upcomingCount > 0) {
          setRecurringCount(data.upcomingCount);
        }
        // Adopt the summary's ongoing value too (Codex #3337 r7 P1). The
        // `service` prop comes from a calendar load that may predate another
        // operator's change; leaving the control on that stale value while
        // sending this fresh one as the baseline is worse than not checking at
        // all — the two agree with the database and the server reads the stale
        // flag as a deliberate transition. Control and baseline must come from
        // the same snapshot.
        if (!recurringOngoingTouched.current && typeof data.ongoing === "boolean") {
          setRecurringOngoing(data.ongoing);
        }
      })
      .catch(() => { if (!cancelled) setSeriesSummaryState("error"); });
    return () => { cancelled = true; };
  }, [service?.id, serviceIsRecurringTemplate]);
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
  // Inline "New payer" quick-add (admin-only — POST /admin/payers is
  // requireAdmin, and payer routing changes are admin-gated server-side).
  const isAdminUser = (() => {
    try { return JSON.parse(localStorage.getItem("waves_admin_user") || "{}")?.role === "admin"; }
    catch { return false; }
  })();
  const [showNewPayer, setShowNewPayer] = useState(false);
  const [newPayer, setNewPayer] = useState({ displayName: "", companyName: "", apEmail: "", apPhone: "" });
  const [newPayerSaving, setNewPayerSaving] = useState(false);
  const [newPayerError, setNewPayerError] = useState("");
  const [newPayerNotice, setNewPayerNotice] = useState("");

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

  // Card-on-file / Auto Pay secure-link state for this visit, shown in the
  // Cards on file panel. Best-effort read — a failed load hides the action.
  const [cardRequestInfo, setCardRequestInfo] = useState(null);
  const [cardLinkSending, setCardLinkSending] = useState(false);
  const [cardLinkNotice, setCardLinkNotice] = useState(null);
  useEffect(() => {
    if (!service?.id) return undefined;
    let cancelled = false;
    setCardLinkNotice(null);
    adminFetch(`/admin/schedule/${service.id}/card-request`)
      .then((json) => {
        if (!cancelled) setCardRequestInfo(json);
      })
      .catch(() => {
        if (!cancelled) setCardRequestInfo(null);
      });
    return () => {
      cancelled = true;
    };
  }, [service.id]);

  const sendCardRequestLink = async () => {
    const who =
      customerData?.customer?.first_name ||
      customerData?.customer?.name ||
      "this customer";
    if (!window.confirm(`Text ${who} a secure card / Auto Pay setup link?`))
      return;
    setCardLinkSending(true);
    try {
      const result = await adminFetch(
        `/admin/schedule/${service.id}/card-request`,
        { method: "POST" },
      );
      setCardLinkNotice(describeCardRequestResult(result));
      try {
        const fresh = await adminFetch(
          `/admin/schedule/${service.id}/card-request`,
        );
        setCardRequestInfo(fresh);
      } catch {
        // keep the outcome notice; the rollup refresh is cosmetic
      }
    } catch (e) {
      setCardLinkNotice({ tone: "bad", text: `Send failed: ${e.message}` });
    } finally {
      setCardLinkSending(false);
    }
  };

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
  // Bill-to select: one control drives payerId + the self-pay pin (mutually
  // exclusive). "__self__" pins this visit to customer-pays even when the
  // account has a default payer; "__new__" opens the inline quick-add without
  // changing the current selection.
  const handleBillToChange = (value) => {
    if (value === "__new__") {
      setNewPayerError("");
      setNewPayerNotice("");
      setShowNewPayer(true);
      return;
    }
    setForm((f) => ({
      ...f,
      payerId: value === "__self__" ? "" : value,
      selfPayOverride: value === "__self__",
    }));
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
            String(a.display_name || "").localeCompare(String(b.display_name || "")),
          ),
        );
        setForm((f) => ({ ...f, payerId: String(created.id), selfPayOverride: false }));
        setShowNewPayer(false);
        setNewPayer({ displayName: "", companyName: "", apEmail: "", apPhone: "" });
        setNewPayerNotice(
          r?.deduped
            ? `Matched existing payer "${created.display_name}" by AP email — selected it instead.`
            : "",
        );
      } else {
        setNewPayerError("Unexpected response — payer not created");
      }
    } catch (e) {
      setNewPayerError(e.message || "Failed to create payer");
    }
    setNewPayerSaving(false);
  };
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

  // Plan length on a series that already exists. The save sends a length only
  // when the number is trustworthy — either the live plan came back from the
  // server (so an untouched field still reads the truth) or the operator typed
  // one. Without that gate a failed summary fetch would let the field's
  // placeholder resize a real plan.
  //
  // Dark by default (GATE_EDIT_APPT_VISIT_COUNT): with the gate off the
  // server answers canSetCount:false and a series template shows exactly the
  // panel it showed before this lane existed. Fail closed — an unreadable
  // summary means we don't know the gate state, so the controls stay hidden.
  const planLengthControlsAvailable =
    !serviceIsRecurringTemplate || seriesSummary?.canSetCount === true;
  const countFieldLoading =
    serviceIsRecurringTemplate && seriesSummaryState === "loading";
  // A length is submitted ONLY after the operator explicitly changes it
  // (Codex #3337 r3 P1). Resubmitting a seeded value looked harmless — the
  // server no-ops when it matches — but the seed is a snapshot from the
  // modal's GET: if a visit completes or is cancelled while the modal sits
  // open, an untouched save of some unrelated field would ask the server to
  // "restore" the plan to a length nobody chose, booking a replacement visit.
  // The save also sends the seeded baseline so the server can refuse outright
  // when the live plan moved underneath it.
  const canSetPlanLength =
    serviceIsRecurringTemplate &&
    seriesSummary?.canSetCount === true &&
    recurringCountTouched.current &&
    seriesSummary?.upcomingCount != null;
  const countHint = (() => {
    if (!serviceIsRecurringTemplate) return null;
    if (seriesSummaryState === "loading") return "Reading the current plan…";
    if (seriesSummaryState === "error") {
      return "Couldn’t read the current plan — type a number to set it.";
    }
    if (seriesSummary?.upcomingCount == null) return null;
    // Exhausted plan: nothing is submitted until the operator types a number,
    // so say that rather than describing a diff against zero.
    if (seriesSummary.upcomingCount === 0 && !recurringCountTouched.current) {
      return "This plan has no visits left — type a number to schedule more.";
    }
    const delta = recurringCount - seriesSummary.upcomingCount;
    if (delta === 0) {
      // Nothing is sent unless the number is changed, so an untouched field
      // is genuinely a no-op rather than a value being re-submitted.
      return `${seriesSummary.upcomingCount} visit${seriesSummary.upcomingCount === 1 ? "" : "s"} scheduled — no change to the plan length.`;
    }
    if (delta > 0) {
      return `Adds ${delta} visit${delta === 1 ? "" : "s"} after the last one booked.`;
    }
    return `Cancels the ${-delta} furthest-out visit${delta === -1 ? "" : "s"}.`;
  })();

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
          : editClampToSeason(
              editShiftPastWeekend(d, !!skipWeekends, weekendShift),
              recurringFreq,
              !!skipWeekends,
            );
      dates.push(
        displayDate.toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
      );
    }
    return dates;
  };

  // The reschedule-text choice only appears (and only sends) when the save
  // actually moves the visit: a new date or a new arrival start. End-time-only
  // resizes don't change the arrival and stay silent. A date-only visit (no
  // arrival time picked) never offers a text — there is no arrival window to
  // promise the customer.
  const initialScheduledDate = service.scheduledDate
    ? String(service.scheduledDate).split("T")[0]
    : "";
  const initialWindowStart = service.windowStart || "";
  const scheduleMoved =
    (form.scheduledDate !== initialScheduledDate ||
      (form.windowStart || "") !== initialWindowStart) &&
    !!form.windowStart;

  const handleSave = async ({ takePayment = false } = {}) => {
    setSaving(true);
    // Time-on-site correction rides the same Save button but its own
    // endpoint: validate before anything writes so a typo aborts the whole
    // save rather than landing the update-details half only. The PATCH
    // itself runs AFTER update-details succeeds (codex P2 #3152 round 2):
    // its server-side job-costing recalculation must see the saved service
    // type/price/assignment, and a rejected details save must not leave the
    // correction half-committed behind a "Save failed" alert.
    const timeOnSiteDirty =
      isCompletedVisit &&
      isAdminUser &&
      String(timeOnSiteMinutes || "").trim() !== "" &&
      String(timeOnSiteMinutes || "").trim() !== timeOnSiteSeed;
    if (timeOnSiteDirty) {
      const minutes = Math.round(Number(String(timeOnSiteMinutes).trim()));
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) {
        alert("Time on site must be 1–720 minutes.");
        setSaving(false);
        return;
      }
    }
    // Re-entry correction rides the same Save button through its own
    // admin-only PATCH — same validate-first / PATCH-after-details posture
    // as the time-on-site correction. A side is dirty only when it differs
    // from the server seed; blank never submits (there is no "unset" edit —
    // type 0 to clear a window).
    const reentrySeeded = reentryInfo?.hasRecord === true;
    const reentrySeedValue = (v) => (v != null ? String(v) : "");
    const reentryDirtySide = (value, seed) =>
      reentrySeeded &&
      isAdminUser &&
      String(value || "").trim() !== "" &&
      String(value || "").trim() !== seed;
    const reentryExteriorDirty = reentryDirtySide(
      reentryExterior,
      reentrySeedValue(reentryInfo?.exteriorMinutes),
    );
    const reentryInteriorDirty = reentryDirtySide(
      reentryInterior,
      reentrySeedValue(reentryInfo?.interiorMinutes),
    );
    if (reentryExteriorDirty || reentryInteriorDirty) {
      for (const raw of [
        reentryExteriorDirty ? reentryExterior : null,
        reentryInteriorDirty ? reentryInterior : null,
      ]) {
        if (raw == null) continue;
        const minutes = Math.round(Number(String(raw).trim()));
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 1440) {
          alert("Re-entry must be 0–1440 minutes (0 removes the wait).");
          setSaving(false);
          return;
        }
      }
    }
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
      const notifyOnMove = scheduleMoved && notificationType === "sms";
      const result = await adminFetch(`/admin/schedule/${service.id}/update-details`, {
        method: "PUT",
        body: JSON.stringify({
          ...form,
          notifyCustomer: notifyOnMove || undefined,
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
          // Plan length for a series that already runs — the server reconciles
          // the visits on the calendar to this number (adding from the tail,
          // or cancelling the furthest-out). Sent only for a finite plan whose
          // current length we could actually read; "Never" and the
          // make-this-recurring path both leave it off so the length is
          // untouched (the latter is seeded by recurringCount above).
          recurringPlannedCount:
            canSetPlanLength && !recurringOngoing ? recurringCount : undefined,
          // The plan length the modal READ on open — the server refuses the
          // resize if the live count has moved since, rather than computing
          // against a stale picture.
          recurringPlannedCountBaseline:
            canSetPlanLength && !recurringOngoing ? seriesSummary.upcomingCount : undefined,
          recurringOngoing: recurringControlsActive ? recurringOngoing : undefined,
          // The ongoing flag the modal READ on open. Another operator can flip
          // this plan to fixed while the modal sits there, and an untouched
          // save would then post a stale `true` that the server reads as a
          // genuine fixed→ongoing transition — flipping the plan back and
          // topping it up, recreating visits the other operator just trimmed
          // (Codex #3337 r5 P1). Same optimistic-concurrency contract as the
          // count baseline.
          recurringOngoingBaseline:
            serviceIsRecurringTemplate && seriesSummary?.ongoing != null
              ? seriesSummary.ongoing
              : undefined,
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
      if (notifyOnMove && result?.notificationSent === false) {
        alert(
          `Appointment saved, but SMS notification failed: ${result.notificationError || "customer was not notified"}`,
        );
      }
      // Resizing a plan moves visits the operator can't see from this modal —
      // say what happened rather than closing on a silent change. The count
      // itself may fall short of the target when the cadence has nowhere left
      // to place a visit, so report the real outcome, not the request.
      // `shortfall` is in the condition, not just the message: a top-up that
      // places NOTHING reports 0 added and 0 cancelled, and without it the
      // modal closed silently as though the requested length had been reached
      // (Codex #3337 r6 P1).
      if (result?.visitCount
        && (result.visitCount.added || result.visitCount.cancelled || result.visitCount.shortfall)) {
        const { added, cancelled, target, achieved, shortfall } = result.visitCount;
        const now = achieved != null ? achieved : target;
        const moves = [
          added ? `${added} visit${added === 1 ? "" : "s"} added` : null,
          cancelled ? `${cancelled} visit${cancelled === 1 ? "" : "s"} cancelled` : null,
        ].filter(Boolean);
        if (moves.length === 0) moves.push("nothing could be scheduled");
        // Report what the plan HAS, not what was asked for — the server can
        // place fewer than requested when the cadence runs out of open dates,
        // and silently claiming the target hides missing service.
        alert(
          shortfall
            ? `Plan now has ${now} visit${now === 1 ? "" : "s"}, not the ${target} requested — ${moves.join(", ")}. The cadence had no open date for the remaining ${shortfall}; add ${shortfall === 1 ? "it" : "them"} by hand. The customer was not notified.`
            : `Plan now has ${now} visit${now === 1 ? "" : "s"} — ${moves.join(", ")}. The customer was not notified.`,
        );
      }
      // Details are saved — now the duration correction, so its server-side
      // job-costing recalc prices against the values just persisted. A
      // failure here is a PARTIAL save (details landed, correction didn't):
      // say exactly that, matching the notification partial-failure above.
      if (timeOnSiteDirty) {
        try {
          const correctionMinutes = Math.round(
            Number(String(timeOnSiteMinutes).trim()),
          );
          const patchResult = await adminFetch(
            `/admin/dispatch/${service.id}/time-on-site`,
            {
              method: "PATCH",
              body: JSON.stringify({ minutes: correctionMinutes }),
            },
          );
          // The record leg can be skipped server-side (ambiguous legacy
          // match, or no report record found) — the appointment's duration
          // still corrected, but the customer report did not. Silence here
          // would read as a full success (codex P2 round 3).
          if (patchResult?.recordUpdated === false) {
            alert(
              patchResult?.recordAmbiguous
                ? "Duration corrected on the appointment, but several legacy report records match this visit — the customer report was NOT changed and needs a manual fix."
                : "Duration corrected on the appointment, but no report record was found for this visit — the customer report was not changed.",
            );
          }
          // The costing refresh is derived state — a failure there must not
          // read as full success (codex P2 round 9). "Re-save this
          // correction" as advice was a dead end (codex P2 round 17): after
          // the refresh the corrected value becomes the seed, the dirty flag
          // clears, and Save never re-invokes this PATCH — so the retry
          // happens HERE, while the correction is still in hand.
          if (patchResult?.costingUpdated === false) {
            const retryNow = window.confirm(
              "Duration corrected, but the job-cost refresh failed — costs may show the old labor until the next recalculation. Retry the refresh now?",
            );
            let retried = null;
            if (retryNow) {
              try {
                retried = await adminFetch(
                  `/admin/dispatch/${service.id}/time-on-site`,
                  {
                    method: "PATCH",
                    body: JSON.stringify({ minutes: correctionMinutes }),
                  },
                );
              } catch {
                retried = null;
              }
            }
            if (retryNow && retried?.costingUpdated !== true) {
              alert(
                "The job-cost refresh failed again — the corrected duration itself is saved; use Job Costs → Recalculate to refresh the labor cost.",
              );
            }
          }
          // The linked technician job timer feeds timesheets and
          // utilization — when the server couldn't route it through the
          // audited edit (approved week, several linked entries), the
          // inflated span survives there until corrected by hand.
          if (patchResult?.timeEntryCorrected === false) {
            const timerReason =
              patchResult?.timeEntryCorrectionBlocked === "exceeds_elapsed"
                ? "the corrected minutes exceed the time elapsed since its clock-in"
                : patchResult?.timeEntryCorrectionBlocked === "entry_conflict"
                  ? "it was edited by someone else at the same moment"
                : patchResult?.timeEntryCorrectionBlocked === "entry_open"
                  ? "its timer is still running"
                : patchResult?.timeEntryCorrectionBlocked === "approved_week"
                  ? "its week is already approved"
                  : patchResult?.timeEntryCorrectionBlocked === "multiple_job_entries"
                    ? "several timer entries are linked to this visit"
                    : "it could not be edited automatically";
            alert(
              `Duration corrected, but the technician's linked job timer was NOT changed (${timerReason}) — it still shows the old span in Timesheets until corrected there.`,
            );
          }
        } catch (patchErr) {
          alert(
            `Appointment saved, but the time-on-site correction failed: ${patchErr.message}. Reopen the appointment to retry it.`,
          );
        }
      }
      if (reentryExteriorDirty || reentryInteriorDirty) {
        try {
          await adminFetch(`/admin/dispatch/${service.id}/reentry`, {
            method: "PATCH",
            body: JSON.stringify({
              ...(reentryExteriorDirty
                ? {
                    exteriorMinutes: Math.round(
                      Number(String(reentryExterior).trim()),
                    ),
                  }
                : {}),
              ...(reentryInteriorDirty
                ? {
                    interiorMinutes: Math.round(
                      Number(String(reentryInterior).trim()),
                    ),
                  }
                : {}),
            }),
          });
        } catch (patchErr) {
          alert(
            `Appointment saved, but the re-entry correction failed: ${patchErr.message}. Reopen the appointment to retry it.`,
          );
        }
      }
      onSaved?.();
    } catch (e) {
      alert("Save failed: " + e.message);
    }
    setSaving(false);
  };

  // no_show is terminal on the server too (the status route 409s a
  // no_show → cancelled transition) — don't offer a cancel that must fail.
  const canCancelAppointment = ![
    "completed",
    "cancelled",
    "skipped",
    "no_show",
  ].includes(String(service.status || "").toLowerCase());

  const handleCancelAppointment = async () => {
    if (cancelling) return;
    setCancelling(true);
    // Card-hold visits inside the late-cancel window: the fee decision comes
    // first — backing out of it aborts the cancel entirely.
    const { proceed, waiveCardHoldFee } = await confirmCardHoldFeeChoice(
      service.id,
    );
    if (!proceed) {
      setCancelling(false);
      return;
    }
    try {
      const result = await adminFetch(`/admin/dispatch/${service.id}/status`, {
        method: "PUT",
        body: JSON.stringify({
          status: "cancelled",
          scope: cancelScope,
          notifyCustomer: cancelNotificationType === "text",
          waiveCardHoldFee,
          notes: "Cancelled from Edit appointment",
        }),
      });
      if (
        cancelNotificationType === "text" &&
        result?.notificationSent === false
      ) {
        alert(
          `Appointment cancelled, but the text failed: ${result.notificationError || "customer was not notified"}`,
        );
      }
      setCancelOpen(false);
      onSaved?.();
    } catch (e) {
      alert("Failed to cancel appointment: " + e.message);
    }
    setCancelling(false);
  };

  const customer = customerData?.customer || {};
  const customerDetailsId =
    service.customerId || service.customer_id || customer.id || null;
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
    fontWeight: 500,
  };
  const inputStyle = {
    width: "100%",
    padding: "11px 12px",
    borderRadius: 4,
    background: D.input,
    color: "#111827",
    border: `1px solid ${D.inputBorder}`,
    fontSize: 16,
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
    fontWeight: 500,
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
            <span style={{ fontSize: 12, fontWeight: 500, color: D.muted }}>
              {label || "Additional service"}
            </span>
            {onRemove && (
              <button
                type="button"
                onClick={onRemove}
                className="font-medium"
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
                  className="font-medium"
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
                        className="font-medium"
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
                              className="font-medium"
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
                className="font-medium"
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
                      className="font-medium"
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
              className="font-medium"
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
              className="font-medium"
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
            // Standalone/home-screen mode: keep the title/buttons below the
            // iOS status bar (viewport-fit=cover lets content run under it).
            paddingTop: "calc(14px + env(safe-area-inset-top, 0px))",
          }}
        >
          {" "}
          <div className="min-w-0 flex-1">
            {" "}
            <div style={{ fontSize: 22, fontWeight: 500, color: "#111827" }}>
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
                  fontWeight: 500,
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
            {canCancelAppointment && (
              <button
                onClick={() => setCancelOpen(true)}
                disabled={saving || cancelling}
                className="font-medium flex-1 md:flex-initial"
                style={{
                  padding: "11px 14px",
                  borderRadius: 4,
                  background: "#fff",
                  color: "#C8312F",
                  border: "1px solid #C8312F",
                  fontSize: 13,
                  cursor: saving || cancelling ? "wait" : "pointer",
                  opacity: saving || cancelling ? 0.6 : 1,
                  whiteSpace: "nowrap",
                }}
              >
                Cancel appointment
              </button>
            )}{" "}
            <button
              onClick={() => handleSave({ takePayment: true })}
              disabled={saving}
              className="font-medium flex-1 md:flex-initial"
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
              className="font-medium flex-1 md:flex-initial"
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
              className="font-medium"
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
                fontWeight: 500,
                color: D.muted,
                marginBottom: 12,
              }}
            >
              Customer
            </div>{" "}
            <div
              style={{
                fontSize: 22,
                fontWeight: 500,
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
            {customerDetailsId && (
              <a
                href={`/admin/customers?customerId=${encodeURIComponent(customerDetailsId)}`}
                style={{
                  display: "block",
                  boxSizing: "border-box",
                  width: "100%",
                  padding: "10px 12px",
                  borderRadius: 4,
                  border: `1px solid ${D.inputBorder}`,
                  background: "#fff",
                  color: "#111827",
                  fontSize: 13,
                  fontWeight: 500,
                  textAlign: "center",
                  textDecoration: "none",
                  cursor: "pointer",
                  marginBottom: 18,
                }}
              >
                Customer details
              </a>
            )}{" "}
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
                <div style={{ fontSize: 15, fontWeight: 500 }}>
                  Customer notes
                </div>{" "}
                <button
                  type="button"
                  style={{
                    border: 0,
                    background: "transparent",
                    color: D.teal,
                    fontSize: 12,
                    fontWeight: 500,
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
                <div style={{ fontSize: 15, fontWeight: 500 }}>
                  Cards on file
                </div>{" "}
                <button
                  type="button"
                  style={{
                    border: 0,
                    background: "transparent",
                    color: D.teal,
                    fontSize: 12,
                    fontWeight: 500,
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
              {(() => {
                const state =
                  cardLinkNotice || describeCardRequestState(cardRequestInfo);
                const showSend =
                  !cardLinkNotice && canSendCardRequest(cardRequestInfo);
                if (!state && !showSend) return null;
                const toneColor =
                  state?.tone === "good"
                    ? D.green
                    : state?.tone === "bad"
                      ? D.red
                      : D.muted;
                return (
                  <div style={{ marginTop: 8 }}>
                    {state && (
                      <div style={{ fontSize: 13, color: toneColor }}>
                        {state.text}
                      </div>
                    )}
                    {showSend && (
                      <button
                        type="button"
                        onClick={sendCardRequestLink}
                        disabled={cardLinkSending}
                        style={{
                          border: `1px solid ${D.border}`,
                          background: "transparent",
                          color: D.teal,
                          fontSize: 12,
                          fontWeight: 500,
                          borderRadius: 6,
                          padding: "6px 10px",
                          cursor: cardLinkSending ? "default" : "pointer",
                          opacity: cardLinkSending ? 0.6 : 1,
                        }}
                      >
                        {cardLinkSending
                          ? "Sending..."
                          : "Text card / Auto Pay link"}
                      </button>
                    )}
                  </div>
                );
              })()}
            </div>{" "}
            <div style={{ borderTop: `1px solid ${D.border}`, paddingTop: 16 }}>
              {" "}
              <div style={{ fontSize: 15, fontWeight: 500, marginBottom: 10 }}>
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
                        fontWeight: 500,
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
                  fontWeight: 500,
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
                    className="font-medium"
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
                      className="font-medium"
                      style={{ ...inputStyle, background: "#F9FAFB" }}
                    />{" "}
                  </div>{" "}
                  <div>
                    {" "}
                    <label style={labelStyle}>State</label>{" "}
                    <input
                      value={customer.address?.state || "Florida"}
                      readOnly
                      className="font-medium"
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
                className="font-medium"
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
                  fontWeight: 500,
                  cursor: "pointer",
                  marginBottom: 12,
                }}
              >
                + Add service
              </button>{" "}
              {estimateSource && (
                <EstimateProvenanceCard
                  quotedTotal={estimateSource.quotedTotal}
                  onetimeTotal={estimateSource.onetimeTotal}
                  // Same rule as the mobile sheet: the comparison stands for
                  // the common one-group booking; only a genuinely split
                  // quote (multiple series anchors, counted server-side)
                  // suppresses it.
                  currentPrice={Number(estimateSource.linkedSeriesCount) > 1
                    ? null : appointmentTotal}
                  compareScope="visit"
                  deposit={estimateSource.deposit}
                  payment={estimateSource.payment}
                  lines={estimateSource.lines}
                  estimateRef={estimateSource.estimateSlug}
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
                    <div style={{ fontSize: 13, fontWeight: 500, color: "#166534" }}>
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
                    className="font-medium"
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
                    className="font-medium"
                    style={{
                      padding: "9px 12px",
                      borderRadius: 4,
                      border: `1px solid ${D.inputBorder}`,
                      background: "#fff",
                      fontSize: 13,
                      fontWeight: 500,
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
                  className="font-medium"
                  style={{
                    padding: "9px 12px",
                    borderRadius: 4,
                    border: `1px solid ${D.inputBorder}`,
                    background: "#fff",
                    fontSize: 13,
                    fontWeight: 500,
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
                    className="font-medium"
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
                        className="font-medium"
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
                          className="font-medium"
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
                    className="font-medium"
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
                    className="font-medium"
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
                    className="font-medium"
                    style={inputStyle}
                  />{" "}
                </div>{" "}
              </div>{" "}
              <SlotConflictNotice
                conflicts={slotConflicts}
                style={{ marginTop: -2, marginBottom: 14 }}
              />{" "}
              <BestTimeHint
                bestTimes={bestTimes}
                currentStart={form.windowStart}
                currentTechnicianId={form.technicianId}
                onPick={(slot) =>
                  // An unassigned visit searched all techs, so the detour
                  // is slot.technicianId's — adopt that tech with the
                  // window (visible in the Technician select before save),
                  // mirroring the create modal. An assigned visit's search
                  // was already scoped; its tech never changes here.
                  setForm((f) => ({
                    ...f,
                    windowStart: slot.start,
                    windowEnd: slot.end,
                    technicianId: !f.technicianId && slot.technicianId
                      ? slot.technicianId
                      : f.technicianId,
                  }))
                }
                style={{ marginTop: -2, marginBottom: 14 }}
              />{" "}
              {isCompletedVisit && isAdminUser && (
                <div style={{ marginBottom: 14 }}>
                  {" "}
                  <label style={labelStyle}>Time on site (minutes)</label>{" "}
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="720"
                    step="1"
                    value={timeOnSiteMinutes}
                    onChange={(e) => setTimeOnSiteMinutes(e.target.value)}
                    placeholder="Not recorded"
                    className="font-medium"
                    style={inputStyle}
                  />{" "}
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>
                    Recorded duration for this completed visit — correct it
                    here if the on-site timer wasn&rsquo;t closed out on time.
                    Saving updates the report and job costing; no customer
                    messages are sent, and the report PDF regenerates.
                  </div>{" "}
                </div>
              )}{" "}
              {isCompletedVisit && isAdminUser && reentryInfo?.hasRecord && (
                <div style={{ marginBottom: 14 }}>
                  {" "}
                  <label style={labelStyle}>
                    Re-entry after treatment (minutes)
                  </label>{" "}
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
                      gap: 12,
                    }}
                  >
                    {" "}
                    <div>
                      {" "}
                      <input
                        type="number"
                        inputMode="numeric"
                        min="0"
                        max="1440"
                        step="1"
                        value={reentryExterior}
                        onChange={(e) => setReentryExterior(e.target.value)}
                        placeholder={`Exterior (default ${reentryInfo?.defaults?.exteriorMinutes ?? 30})`}
                        className="font-medium"
                        style={inputStyle}
                      />{" "}
                      <div
                        style={{ fontSize: 11, color: D.muted, marginTop: 4 }}
                      >
                        Exterior
                      </div>{" "}
                    </div>{" "}
                    <div>
                      {" "}
                      <input
                        type="number"
                        inputMode="numeric"
                        min="0"
                        max="1440"
                        step="1"
                        value={reentryInterior}
                        onChange={(e) => setReentryInterior(e.target.value)}
                        placeholder={`Interior (default ${reentryInfo?.defaults?.interiorMinutes ?? 30})`}
                        className="font-medium"
                        style={inputStyle}
                      />{" "}
                      <div
                        style={{ fontSize: 11, color: D.muted, marginTop: 4 }}
                      >
                        Interior
                      </div>{" "}
                    </div>{" "}
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>
                    How long the report tells the customer to stay off treated
                    areas after this visit (0 removes the wait). Saving
                    updates the report and regenerates its PDF; no customer
                    messages are sent.
                  </div>{" "}
                </div>
              )}{" "}
              {scheduleMoved && (
                <div style={{ marginBottom: 14 }}>
                  {" "}
                  <label style={labelStyle}>Client booking notifications</label>{" "}
                  <select
                    value={notificationType}
                    onChange={(e) => setNotificationType(e.target.value)}
                    className="font-medium"
                    style={inputStyle}
                  >
                    <option value="none">Don&rsquo;t send a notification</option>
                    <option value="sms">Text message</option>
                  </select>{" "}
                  <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>
                    This save moves the appointment. This controls the
                    immediate reschedule text; automated reminders will follow
                    the new appointment time.
                  </div>{" "}
                </div>
              )}{" "}
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
                  <div style={{ fontSize: 14, fontWeight: 500 }}>
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
                        className="font-medium"
                        style={inputStyle}
                      >
                        {EDIT_FREQUENCIES.map((f) => (
                          <option key={f.value} value={f.value}>
                            {f.label}
                          </option>
                        ))}
                      </select>{" "}
                    </div>{" "}
                    {planLengthControlsAvailable && (
                    <div>
                      {" "}
                      <label style={labelStyle}>End repeating</label>{" "}
                      <select
                        value={recurringOngoing ? "never" : "count"}
                        onChange={(e) => {
                          const never = e.target.value === "never";
                          // Choosing "After count" IS choosing a plan length —
                          // the displayed number becomes the operator's intent
                          // even if they never touch the input (Codex #3337 r4
                          // P1). Without this the save flipped the plan to
                          // fixed and sent no length, freezing it at whatever
                          // the live count happened to be.
                          if (!never) recurringCountTouched.current = true;
                          recurringOngoingTouched.current = true;
                          setRecurringOngoing(never);
                        }}
                        className="font-medium"
                        style={inputStyle}
                      >
                        {" "}
                        <option value="never">Never</option>{" "}
                        <option value="count">After count</option>{" "}
                      </select>{" "}
                    </div>
                    )}
                    {planLengthControlsAvailable && !recurringOngoing && (
                      <div>
                        {" "}
                        <label style={labelStyle}>
                          {serviceIsRecurringTemplate
                            ? "Visits left (this one included)"
                            : "Count"}
                        </label>{" "}
                        <input
                          type="number"
                          min={serviceIsRecurringTemplate ? 1 : 2}
                          max={24}
                          value={recurringCount}
                          disabled={countFieldLoading}
                          onChange={(e) => {
                            recurringCountTouched.current = true;
                            setRecurringCount(parseInt(e.target.value) || 4);
                          }}
                          className="font-medium"
                          style={{
                            ...inputStyle,
                            ...(countFieldLoading
                              ? { opacity: 0.6, cursor: "wait" }
                              : {}),
                          }}
                        />{" "}
                        {countHint && (
                          <div
                            style={{
                              fontSize: 12,
                              color: D.muted,
                              marginTop: 5,
                            }}
                          >
                            {countHint}
                          </div>
                        )}
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
                        <label style={labelStyle}>Nth</label>{" "}
                        <select
                          value={recurringNth}
                          onChange={(e) =>
                            setRecurringNth(parseInt(e.target.value))
                          }
                          className="font-medium"
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
                        <label style={labelStyle}>Weekday</label>{" "}
                        <select
                          value={recurringWeekday}
                          onChange={(e) =>
                            setRecurringWeekday(parseInt(e.target.value))
                          }
                          className="font-medium"
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
                        <label style={labelStyle}>Days between visits</label>{" "}
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
                          className="font-medium"
                          style={inputStyle}
                        />{" "}
                      </div>
                      <div>
                        <label style={labelStyle}>Weekend rule</label>{" "}
                        <select
                          value={weekendRuleValue}
                          onChange={(e) => updateWeekendRule(e.target.value)}
                          className="font-medium"
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
                        className="font-medium"
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
                            fontWeight: 500,
                          }}
                        >
                          {d}
                        </span>
                      ))}
                      {recurringOngoing ? (
                        <span style={{ padding: "3px 7px" }}>
                          then auto-extends
                        </span>
                      ) : recurringCount > 6 ? (
                        <span style={{ padding: "3px 7px" }}>
                          +{recurringCount - 6} more
                        </span>
                      ) : (
                        // A finite plan ends — say so, rather than leaving the
                        // chips looking like the front of an open cadence.
                        <span style={{ padding: "3px 7px" }}>
                          then the plan ends
                        </span>
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
                className="font-medium"
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
                  style={{ fontSize: 13, color: "#111827", fontWeight: 500 }}
                >
                  Create invoice on completion
                </span>{" "}
              </label>
              <div style={{ marginTop: 14 }}>
                <label style={labelStyle}>Bill to (third-party payer)</label>
                <select
                  value={form.selfPayOverride ? "__self__" : form.payerId}
                  onChange={(e) => handleBillToChange(e.target.value)}
                  className="font-medium"
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
                  {customer.payerId && (
                    <option value="__self__">
                      Customer pays (self) — override default
                    </option>
                  )}
                  {payers.map((p) => (
                    <option key={p.id} value={String(p.id)}>
                      {p.display_name}
                      {p.company_name && p.company_name !== p.display_name
                        ? ` — ${p.company_name}`
                        : ""}
                    </option>
                  ))}
                  {isAdminUser && <option value="__new__">＋ New payer…</option>}
                </select>
                {showNewPayer && (
                  <div
                    style={{
                      marginTop: 10,
                      padding: 12,
                      background: "#F9FAFB",
                      border: `1px solid ${D.border}`,
                      borderRadius: 4,
                    }}
                  >
                    <div style={{ fontSize: 13, color: "#111827", fontWeight: 600, marginBottom: 8 }}>
                      New payer
                    </div>
                    <label style={labelStyle}>Payer name *</label>
                    <input
                      type="text"
                      value={newPayer.displayName}
                      onChange={(e) => setNewPayer((p) => ({ ...p, displayName: e.target.value }))}
                      placeholder="e.g. tenant, builder, or property manager name"
                      className="font-medium"
                      style={inputStyle}
                    />
                    <div style={{ marginTop: 8 }}>
                      <label style={labelStyle}>Company (optional)</label>
                      <input
                        type="text"
                        value={newPayer.companyName}
                        onChange={(e) => setNewPayer((p) => ({ ...p, companyName: e.target.value }))}
                        className="font-medium"
                        style={inputStyle}
                      />
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <label style={labelStyle}>Invoice email (AP)</label>
                      <input
                        type="email"
                        value={newPayer.apEmail}
                        onChange={(e) => setNewPayer((p) => ({ ...p, apEmail: e.target.value }))}
                        placeholder="Where this payer's invoices are emailed"
                        className="font-medium"
                        style={inputStyle}
                      />
                      <div style={{ fontSize: 12, color: D.muted, marginTop: 4 }}>
                        Without an email, invoices to this payer can’t be
                        delivered until one is added in Finance &rarr; Payers.
                      </div>
                    </div>
                    <div style={{ marginTop: 8 }}>
                      <label style={labelStyle}>Phone (optional)</label>
                      <input
                        type="tel"
                        value={newPayer.apPhone}
                        onChange={(e) => setNewPayer((p) => ({ ...p, apPhone: e.target.value }))}
                        className="font-medium"
                        style={inputStyle}
                      />
                    </div>
                    {newPayerError && (
                      <div style={{ fontSize: 12, color: D.red, marginTop: 8 }}>
                        {newPayerError}
                      </div>
                    )}
                    <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                      <button
                        type="button"
                        onClick={saveNewPayer}
                        disabled={newPayerSaving || !newPayer.displayName.trim()}
                        style={{
                          padding: "8px 14px",
                          background: D.teal,
                          color: "#fff",
                          border: "none",
                          borderRadius: 4,
                          fontSize: 13,
                          fontWeight: 600,
                          cursor: newPayerSaving ? "default" : "pointer",
                          opacity: newPayerSaving || !newPayer.displayName.trim() ? 0.6 : 1,
                          minHeight: 44,
                        }}
                      >
                        {newPayerSaving ? "Saving…" : "Create & select"}
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setShowNewPayer(false);
                          setNewPayerError("");
                        }}
                        style={{
                          padding: "8px 14px",
                          background: "transparent",
                          color: D.muted,
                          border: `1px solid ${D.border}`,
                          borderRadius: 4,
                          fontSize: 13,
                          cursor: "pointer",
                          minHeight: 44,
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                )}
                {newPayerNotice && (
                  <div style={{ fontSize: 12, color: D.teal, marginTop: 6 }}>
                    {newPayerNotice}
                  </div>
                )}
                <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>
                  {form.selfPayOverride
                    ? "Pinned to customer pays (self) for this visit — the account default payer is ignored."
                    : customer.payerId
                    ? "Blank inherits this customer’s default payer; pick a payer to override for just this visit."
                    : "Routes this visit’s invoice to a builder / property manager instead of the customer."}{" "}
                  Manage payers in Finance &rarr; Payers.
                </div>
                {(form.payerId || (customer.payerId && !form.selfPayOverride)) && (() => {
                  // PO applies to the EFFECTIVE payer — the per-job override if
                  // set, otherwise the customer's inherited default (unless the
                  // visit is pinned to self-pay) — so a default-payer job can
                  // still capture a PO.
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
                        className="font-medium"
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
      {cancelOpen && (
        <div
          onClick={() => !cancelling && setCancelOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.5)",
            zIndex: 1100,
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
              background: "#fff",
              borderRadius: 8,
              padding: 24,
              maxWidth: 460,
              width: "100%",
              border: `1px solid ${D.inputBorder}`,
            }}
          >
            {" "}
            <div
              style={{
                fontSize: 16,
                fontWeight: 500,
                color: "#111827",
                marginBottom: 8,
              }}
            >
              Cancel appointment
            </div>{" "}
            <div style={{ fontSize: 13, color: D.muted, marginBottom: 16 }}>
              This appointment will be removed from your calendar and will
              appear as canceled in {customerName}&rsquo;s appointment history.
            </div>{" "}
            {serviceHasSeries && (
              <div style={{ marginBottom: 14 }}>
                {" "}
                <label style={labelStyle}>Apply changes to</label>{" "}
                <select
                  value={cancelScope}
                  onChange={(e) => setCancelScope(e.target.value)}
                  disabled={cancelling}
                  className="font-medium"
                  style={inputStyle}
                >
                  <option value="this_only">This appointment only</option>
                  <option value="following">
                    This and following appointments
                  </option>
                  <option value="series">All appointments in series</option>
                </select>{" "}
              </div>
            )}{" "}
            <div style={{ marginBottom: 18 }}>
              {" "}
              <label style={labelStyle}>Client booking notifications</label>{" "}
              <select
                value={cancelNotificationType}
                onChange={(e) => setCancelNotificationType(e.target.value)}
                disabled={cancelling}
                className="font-medium"
                style={inputStyle}
              >
                <option value="text">Text message (preferred)</option>
                <option value="none">Don&rsquo;t send a notification</option>
              </select>{" "}
            </div>{" "}
            <div
              style={{
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
                flexWrap: "wrap",
              }}
            >
              {" "}
              <button
                onClick={() => setCancelOpen(false)}
                disabled={cancelling}
                className="font-medium"
                style={{
                  padding: "10px 14px",
                  borderRadius: 4,
                  background: "#fff",
                  color: "#111827",
                  border: `1px solid ${D.inputBorder}`,
                  fontSize: 13,
                  cursor: cancelling ? "wait" : "pointer",
                }}
              >
                Keep appointment
              </button>{" "}
              <button
                onClick={handleCancelAppointment}
                disabled={cancelling}
                className="font-medium"
                style={{
                  padding: "10px 14px",
                  borderRadius: 4,
                  background: "#C8312F",
                  color: "#fff",
                  border: "none",
                  fontSize: 13,
                  cursor: cancelling ? "wait" : "pointer",
                  opacity: cancelling ? 0.6 : 1,
                }}
              >
                {cancelling ? "Cancelling..." : "Cancel appointment"}
              </button>{" "}
            </div>{" "}
          </div>{" "}
        </div>
      )}
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
  // Classify from the RAW service type when the payload carries it: the
  // schedule day view sends a normalized display name ("Lawn + Tree & Shrub"
  // becomes "Tree & Shrub Care") while the server's line-scoped fields are
  // classified from the raw value — the panel must agree with them.
  const panelServiceType = service.serviceTypeRaw || service.serviceType;
  const serviceCategory = detectServiceCategory(panelServiceType);
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
          // The photos endpoint derives its line from literal tokens
          // (lawn/turf, tree/shrub, pest, mosquito, termite) — send the
          // panel's CLASSIFIED category as that token so the lookup always
          // matches the panel's line, even for raw aliases ("Bora-Care",
          // "Aeration") carrying none of the tokens. "pest" is also the
          // classifier's rodent/unknown fallback though, so that token is
          // only sent when the label genuinely says pest — rodent and
          // unknown labels keep their token-less (unfiltered) lookup.
          `/admin/protocols/photos/relevant?serviceType=${encodeURIComponent(
            (serviceCategory !== "pest" ||
            /\bpest\b/.test(panelServiceType.toLowerCase())
              ? PHOTO_LOOKUP_TYPE_BY_CATEGORY[serviceCategory]
              : null) || service.serviceType,
          )}&month=${month}`,
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
              `/admin/protocols/match?serviceType=${encodeURIComponent(panelServiceType)}`,
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
          // Full-height drawer runs under the iOS status bar in standalone
          // mode — pad the header below it.
          paddingTop: "calc(16px + env(safe-area-inset-top, 0px))",
          borderBottom: `1px solid ${D.border}`,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        {" "}
        <div>
          {" "}
          <div style={{ fontSize: 16, fontWeight: 500, color: D.heading }}>
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
                    fontWeight: 500,
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
                          fontWeight: 500,
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
                                fontWeight: 500,
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
                                    fontWeight: 500,
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
                                fontWeight: 500,
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
                        fontWeight: 500,
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
                              fontWeight: 500,
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
                      fontWeight: 500,
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
                              fontWeight: 500,
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
                              fontWeight: 500,
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
                          fontWeight: 500,
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
                              fontWeight: 500,
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
                      fontWeight: 500,
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
                                fontWeight: 500,
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
                            fontWeight: 500,
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
                                fontWeight: 500,
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
                    fontWeight: 500,
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
                    style={{ fontSize: 13, color: D.heading, fontWeight: 500 }}
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
                      style={{ fontSize: 18, fontWeight: 500, color: D.heading }}
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
                      style={{ fontSize: 18, fontWeight: 500, color: D.heading }}
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
                      style={{ fontSize: 18, fontWeight: 500, color: D.heading }}
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
                        fontWeight: 500,
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
                {/* Last service notes — line-scoped (lastLineServiceNotes) so a
                    pest dashboard never shows the customer's lawn visit notes.
                    No fallback to the any-line field: cross-line notes here
                    were the bug, not a degraded mode. */}
                {service.lastLineServiceNotes &&
                  stripLegacyBoilerplate(service.lastLineServiceNotes) && (
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
                          fontWeight: 500,
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
                        {stripLegacyBoilerplate(service.lastLineServiceNotes)}
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
                    fontWeight: 500,
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
                            fontWeight: 500,
                            color: D.heading,
                          }}
                        >
                          {p.pest_name}
                        </span>{" "}
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 500,
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
                    fontWeight: 500,
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
                          fontWeight: 500,
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
                    fontWeight: 500,
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
                          fontWeight: 500,
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
                    fontWeight: 500,
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
                          fontWeight: 500,
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
                              fontWeight: 500,
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
  // Immediate reschedule text — admin chooses per move ('none' | 'sms'),
  // matching the drag-and-drop RescheduleConfirmModal's default of no text.
  const [notificationType, setNotificationType] = useState("none");
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

  const notifyCustomer = notificationType === "sms";

  // window_end is the visit's SCHEDULING block — it must carry the visit's
  // own duration, never a flat 2-hour span (that inflates occupancy and
  // blocks real slots). The 2-hour arrival range is customer-facing copy
  // only. Duration: the service's estimate, else the original window span,
  // else 60 minutes.
  const durationMinutes = (() => {
    // Stored window span FIRST — the feeds fabricate defaults for
    // null-duration rows (Day: ||60, Month: ||30), so metadata can lie
    // while the persisted span cannot. Metadata (estimatedDuration on
    // day/week payloads, duration on month payloads) is the fallback for
    // windowless rows, then 60.
    const [ws, we] = [service.windowStart, service.windowEnd];
    if (ws && we) {
      const [h1, m1] = String(ws).split(":").map(Number);
      const [h2, m2] = String(we).split(":").map(Number);
      const span = h2 * 60 + (m2 || 0) - (h1 * 60 + (m1 || 0));
      if (span > 0) return span;
    }
    const d = parseInt(service.estimatedDuration ?? service.duration, 10);
    if (Number.isInteger(d) && d > 0) return d;
    return 60;
  })();

  const windowFor = (startHHMM) => {
    const [h, m] = String(startHHMM).split(":").map(Number);
    if (Number.isNaN(h)) return null;
    const endTotal = h * 60 + (m || 0) + durationMinutes;
    // A start whose full duration crosses midnight would truncate the
    // visit's occupancy block and let another booking land inside time the
    // job still needs — reject instead of clamping.
    if (endTotal > 23 * 60 + 59) return null;
    const end = `${String(Math.floor(endTotal / 60)).padStart(2, "0")}:${String(endTotal % 60).padStart(2, "0")}`;
    const start = `${String(h).padStart(2, "0")}:${String(m || 0).padStart(2, "0")}`;
    return {
      start,
      end,
      display: `${formatTimeDisplay(start)} - ${formatTimeDisplay(end)}`,
    };
  };

  const currentDateOnly = service.scheduledDate
    ? String(service.scheduledDate).split("T")[0]
    : "";
  const currentStart = service.windowStart
    ? String(service.windowStart).slice(0, 5)
    : "";

  // Advisory overlap hint for the custom picker — same block derivation the
  // submit uses (windowFor), warn-only (the Reschedule button never keys off
  // it). Suggested options are left unannotated: the server already ranks
  // them.
  const manualBlock = windowFor(manualTime);
  const { conflicts: manualConflicts } = useSlotConflicts({
    date: manualDate,
    windowStart: manualBlock?.start || manualTime,
    windowEnd: manualBlock?.end,
    durationMinutes,
    excludeServiceIds: [service.id],
    enabled: showManual && !!manualDate,
  });
  // Advisory drive-detour suggestions for the picked day — a chip only sets
  // the start select, never submits the reschedule.
  const { bestTimes: manualBestTimes } = useBestTimes({
    date: manualDate,
    serviceId: service.id,
    customerId: service.customerId || service.customer_id,
    durationMinutes,
    technicianId: service.technicianId || service.technician_id || undefined,
    excludeServiceIds: [service.id],
    // The reschedule submit can't change assignment, so an unassigned
    // visit's all-tech detours would be unactionable — no tech, no hint.
    enabled: showManual && !!manualDate && !!(service.technicianId || service.technician_id),
  });

  const handleReschedule = async (opt) => {
    // Suggested starts are morning slots, but stay consistent with the
    // manual path: never submit a midnight-truncated block.
    const suggestedBlock = windowFor(opt.suggestedWindow?.start);
    if (!suggestedBlock) {
      alert(
        "That start time would run past midnight for this visit's duration — pick another slot.",
      );
      return;
    }
    // Same no-op guard as the manual path: a suggestion can equal the
    // current slot (the visit excludes itself from conflict checks), and
    // submitting it would log a reschedule and text an unchanged customer.
    if (opt.date === currentDateOnly && suggestedBlock.start === currentStart) {
      alert("The appointment is already scheduled at that date and time.");
      return;
    }
    setSending(true);
    try {
      const result = await adminFetch(
        `/admin/dispatch/${service.id}/reschedule`,
        {
          method: "POST",
          body: JSON.stringify({
            newDate: opt.date,
            // Re-derive the block from the visit's own duration — the
            // suggested window's 2-3h span is arrival copy, not occupancy.
            newWindow: suggestedBlock,
            // Server re-derives window_end from the CURRENT row, so a stale
            // board snapshot can't shrink or expand the visit's block.
            deriveWindowFromCurrentVisit: true,
            reasonCode: reason,
            reasonText: notes,
            notifyCustomer,
          }),
        },
      );
      if (notifyCustomer && result?.notificationSent === false) {
        alert(
          `Appointment moved, but SMS notification failed: ${result.notificationError || "customer was not notified"}`,
        );
      }
      onRescheduled?.();
      onClose();
    } catch (e) {
      console.error(e);
      alert(
        `Reschedule failed: ${e.message || "the slot may have just been taken — pick another"}`,
      );
    }
    setSending(false);
  };

  const handleManualReschedule = async () => {
    if (!manualDate) return;
    // No-op guard: submitting the visit's existing slot would log a
    // reschedule and (with Text selected) tell the customer their
    // appointment moved when nothing changed.
    if (manualDate === currentDateOnly && manualTime === currentStart) {
      alert("The appointment is already scheduled at that date and time.");
      return;
    }
    const window = windowFor(manualTime);
    if (!window) {
      alert(
        "That start time would run past midnight for this visit's duration — pick an earlier hour.",
      );
      return;
    }
    setSending(true);
    try {
      const result = await adminFetch(
        `/admin/dispatch/${service.id}/reschedule`,
        {
          method: "POST",
          body: JSON.stringify({
            newDate: manualDate,
            newWindow: window,
            // Server re-derives window_end from the CURRENT row, so a stale
            // board snapshot can't shrink or expand the visit's block.
            deriveWindowFromCurrentVisit: true,
            reasonCode: reason,
            reasonText: notes,
            notifyCustomer,
          }),
        },
      );
      if (notifyCustomer && result?.notificationSent === false) {
        alert(
          `Appointment moved, but SMS notification failed: ${result.notificationError || "customer was not notified"}`,
        );
      }
      onRescheduled?.();
      onClose();
    } catch (e) {
      console.error(e);
      alert(
        `Reschedule failed: ${e.message || "the slot may have just been taken — pick another"}`,
      );
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
    fontSize: 16,
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
            fontWeight: 500,
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
              fontWeight: 500,
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
              fontWeight: 500,
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
        <div style={{ marginBottom: 14 }}>
          {" "}
          <div
            style={{
              fontSize: 12,
              fontWeight: 500,
              color: D.muted,
              marginBottom: 6,
            }}
          >
            Client booking notifications
          </div>{" "}
          <select
            value={notificationType}
            onChange={(e) => setNotificationType(e.target.value)}
            disabled={sending}
            style={inputSt}
          >
            <option value="none">Don&rsquo;t send a notification</option>
            <option value="sms">Text message</option>
          </select>{" "}
          <div style={{ fontSize: 12, color: D.muted, marginTop: 6 }}>
            This controls the immediate reschedule text. Automated reminders
            will follow the new appointment time.
          </div>{" "}
        </div>{" "}
        <div
          style={{
            fontSize: 13,
            fontWeight: 500,
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
                    style={{ fontSize: 14, fontWeight: 500, color: D.heading }}
                  >
                    {opt.displayDate}
                  </div>{" "}
                  <div style={{ fontSize: 12, color: D.muted }}>
                    {/* Show the block Select actually books (duration-derived),
                        not the server's wider 2-3h span. */}
                    {windowFor(opt.suggestedWindow?.start)?.display ||
                      opt.suggestedWindow?.display}{" "}
                    · {opt.currentLoad} jobs ·{" "}
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
                    fontWeight: 500,
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
              fontWeight: 500,
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
                {/* Appointment windows ALWAYS start on the hour (owner
                    directive) — an hour select instead of a free time input
                    so an off-hour start can't be submitted. */}
                <select
                  value={manualTime}
                  onChange={(e) => setManualTime(e.target.value)}
                  style={inputSt}
                >
                  {Array.from({ length: 13 }, (_, i) => {
                    const h = i + 6;
                    const value = `${String(h).padStart(2, "0")}:00`;
                    const label = `${h % 12 || 12}:00 ${h >= 12 ? "PM" : "AM"}`;
                    return (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    );
                  })}
                </select>{" "}
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
                    fontWeight: 500,
                    opacity: sending ? 0.6 : 1,
                    whiteSpace: "nowrap",
                  }}
                >
                  Reschedule
                </button>{" "}
              </div>{" "}
            </div>
          )}
          {showManual && (
            <SlotConflictNotice
              conflicts={manualConflicts}
              style={{ marginTop: 10 }}
            />
          )}
          {showManual && (
            <BestTimeHint
              bestTimes={manualBestTimes}
              currentStart={manualTime}
              currentTechnicianId={service.technicianId || service.technician_id}
              onPick={(slot) => setManualTime(slot.start)}
              style={{ marginTop: 10 }}
            />
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
  fontWeight: 500,
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
        height: 44,
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
// metadata ({ field, value } or { field, values }: required exactly when
// the named sibling field holds a non-empty value other than `value` /
// outside `values`). Mirrors the server's conditional enforcement so the
// tech gets the normal pre-submit prompt instead of a post-submit 422
// (Codex P2).
export function typedFieldRequiredNow(field, values) {
  if (field?.required) return true;
  const rule = field?.requiredUnless;
  if (!rule?.field) return false;
  const driver = String(values?.[rule.field] ?? "").trim();
  if (!driver) return false;
  const excluded = Array.isArray(rule.values) ? rule.values : [rule.value];
  return !excluded.includes(driver);
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
  // Mirrors the server rule (codex P2 r6): the chip's report sentence says
  // "Your help with the recommendations above", so it needs a recorded
  // recommendation now that the simplified T&S form no longer requires one.
  if (
    schemaType === "tree_shrub" &&
    chip === "Customer action needed" &&
    !String(values?.customer_recommendations ?? "").trim()
  ) {
    return `"Customer action needed" requires a recorded customer recommendation — add one or remove the chip`;
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

// Follow-up-only trap actions a declared Initial setup cannot carry —
// mirrors SETUP_INCOMPATIBLE_TRAP_ACTIONS in
// server/services/service-report/activity-indicators.js.
const SETUP_INCOMPATIBLE_TRAP_ACTIONS = [
  "Traps reset",
  "Traps moved",
  "Traps replaced",
  "Bait/lure refreshed",
  "Damaged or missing traps found",
];

// Termite Phase-3 attestation contradictions, mirrored pre-submit so the
// tech gets the inline prompt instead of the server 422 (Codex P3 r3 on
// #2703). The method list mirrors TERMITE_PERIMETER_METHODS in
// project-types.js; the messages mirror validateTypedFindings.
export function typedFieldValueConflicts(schemaType, values) {
  const conflicts = [];
  if (schemaType === "termite_treatment") {
    const method = String(values?.treatment_method ?? "").trim();
    const notice = String(values?.posted_notice ?? "").trim();
    if (
      ["Liquid perimeter", "Trenching"].includes(method) &&
      notice &&
      notice !== "Yes"
    ) {
      conflicts.push(
        `Posted notice "${notice}" conflicts with the ${method} application — exterior/perimeter treatments require the posted notice: place it and select "Yes"`,
      );
    }
  }
  if (
    schemaType === "termite_inspection" &&
    String(values?.inspection_notice_affixed ?? "").trim() === "No"
  ) {
    conflicts.push(
      'The inspection notice must be affixed before completing — affix the notice and select "Yes"',
    );
  }
  // Initial-setup constraints on rodent trapping, mirrored pre-submit so
  // the tech gets the inline prompt instead of the server 422 (codex P2
  // round 14 on #3159) — same rationale as the termite mirrors above, and
  // the caller already runs this for both the primary and every companion
  // section. The action list mirrors SETUP_INCOMPATIBLE_TRAP_ACTIONS and
  // the messages mirror validateTypedFindings in activity-indicators.js.
  if (
    schemaType === "rodent_trapping" &&
    String(values?.trap_visit_type ?? "").trim() === "Initial setup"
  ) {
    const followUpOnly = String(values?.trap_actions ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .filter((action) => SETUP_INCOMPATIBLE_TRAP_ACTIONS.includes(action));
    if (followUpOnly.length) {
      conflicts.push(
        `Trap actions ${followUpOnly.map((a) => `"${a}"`).join(", ")} describe traps that were already out — either clear them or set this visit to "Follow-up check"`,
      );
    }
    // Shape FIRST, exactly as validateTypedFindings checks a count field:
    // Number("1.0") and Number("1e1") are positive integers here but the
    // server rejects both, so a coercion-only mirror still let the 422 it
    // exists to prevent through (codex P2 round 15).
    const rawCount = values?.traps_checked;
    const countStr = typeof rawCount === "number"
      ? String(rawCount)
      : (typeof rawCount === "string" ? rawCount.trim() : null);
    if (countStr == null || !/^\d{1,4}$/.test(countStr)) {
      conflicts.push(
        'An initial setup must record how many traps were set — enter the count as a whole number, or set this visit to "Follow-up check"',
      );
    } else if (Number(countStr) < 1) {
      conflicts.push(
        'An initial setup must record how many traps were set — enter the count, or set this visit to "Follow-up check"',
      );
    }
  }
  return conflicts;
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
    } else if (field.autoFilled) {
      // Derived server-side (e.g. primary T&S treatments) — a restored
      // pre-cutover draft value has no visible input and could trip
      // validation the tech can't fix (codex P2). Companion slices clear
      // the flag for fields they collect, so those restores survive.
      delete values[key];
    } else if ((field.type === "chips" || field.type === "multi_select") && Array.isArray(field.options)) {
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

// Field labels that follow a sibling selection. Registry labels are static,
// but rodent trapping's count means two different things depending on the
// visit the tech just declared — and a form reading "Traps checked" under
// "Initial setup" would contradict the report, which labels the very same
// number "Traps set" (owner 2026-08-02). Kept to this one pair rather than a
// general mechanism: it is the only field whose noun flips.
export function typedFieldLabel(schemaType, field, values = {}) {
  if (
    schemaType === "rodent_trapping"
    && field.key === "traps_checked"
    && String(values.trap_visit_type || "").trim() === "Initial setup"
  ) {
    return "Traps set";
  }
  return field.label;
}

// Typed specialty completion form (specialty-service-completion-contract.md
// §3-§4, §7): registry-driven findings fields + activity gauge + next-step
// chips + optional AI-drafted recommendations. Shared by the mobile and
// desktop renders of CompletionPanel — `variant` only switches the
// palette/label chrome between the CP mobile tokens and the D palette.
export function TypedFindingsSection({
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
  pesticideProductPresent = true,
  frozen = false,
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
    fontWeight: 500,
    color: textColor,
    marginBottom: 6,
  };
  const sectionHeaderStyle = {
    fontSize: 12,
    fontWeight: 500,
    letterSpacing: "0.06em",
    textTransform: "uppercase",
    color: mutedColor,
    margin: "16px 0 8px",
    paddingBottom: 4,
    borderBottom: `1px solid ${hairline}`,
  };
  // autoFilled fields are derived server-side at completion (treatments from
  // products) and never rendered — companion schema slices clear the flag
  // for fields the companion must collect (shared products list can't be
  // attributed per service line), so this filter is schema-driven for both
  // contexts. pesticideOnly compliance fields appear once a pesticide
  // product is recorded (the server 422s them if missed, so hiding them
  // can't skip enforcement). detail fields collapse behind one optional
  // expander so routine visits stay a short form (owner directive
  // 2026-07-21).
  const visibleFields = (schema.fields || []).filter(
    (f) => !f.autoFilled && (!f.pesticideOnly || pesticideProductPresent),
  );
  const primaryFields = visibleFields.filter((f) => !f.detail);
  const detailFields = visibleFields.filter((f) => f.detail);
  const renderField = (field, index, list) => (
    <div key={field.key} style={{ marginBottom: 12 }}>
      {/* Sectioned schemas (rodent trapping): header above the first
          field of each section so the checklist scans in groups. */}
      {field.section && field.section !== list[index - 1]?.section && (
        <div style={sectionHeaderStyle}>{field.section}</div>
      )}
      <div style={fieldLabelStyle}>
        {typedFieldLabel(schema.type, field, values)}
        {/* pesticideOnly compliance fields only render when a pesticide
            product is recorded — and then the server REQUIRES them
            (validateTreeShrubTypedCompliance), so they carry the required
            marker whenever visible (codex P2 r13). */}
        {(typedFieldRequiredNow(field, values) || field.pesticideOnly) && (
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
  );
  return (
    <div style={{ marginBottom: 20 }}>
      {/* Companion sections (onRecommendationsChange null) label themselves
          by schema so stacked sections stay distinguishable. */}
      <label style={labelCss}>
        {onRecommendationsChange ? "Service findings" : schema.label || "Service findings"}
      </label>
      {/* While an AI report is generating, the request's findings snapshot
          must stay what completion will persist — a disabled fieldset
          natively freezes every descendant control (fields, chips, activity
          buttons, recommendations) for pointer AND keyboard input, same rule
          the notes/observations fields already follow. */}
      <fieldset
        disabled={frozen}
        aria-disabled={frozen || undefined}
        style={{ border: "none", margin: 0, padding: 0, minWidth: 0, opacity: frozen ? 0.55 : 1 }}
      >
      {primaryFields.map(renderField)}
      {detailFields.length > 0 && (
        <details style={{ marginBottom: 12 }}>
          <summary
            style={{
              ...sectionHeaderStyle,
              cursor: "pointer",
              listStyle: "none",
              borderBottom: "none",
            }}
          >
            More detail (optional) ▸
          </summary>
          {detailFields.map(renderField)}
        </details>
      )}
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
                    fontWeight: 500,
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
        {schema.type === "tree_shrub" ? (
          /* Owner directive 2026-07-21 round 2: NO pills/chips on the T&S
             closeout — every selection is a dropdown like the findings
             fields (and lawn), so the whole form closes out in seconds.
             Same toggle contract as the chip row: the diff between the
             dropdown's value and current state is the one toggled chip. */
          <ProjectFindingFieldInput
            field={{
              key: "next_steps",
              label: "Next steps",
              type: "multi_select",
              options: schema.nextStepChips || [],
            }}
            id={`typed-next-steps-${schema.type}`}
            name="nextStepChips"
            value={nextStepChips.join(", ")}
            onChange={(value) => {
              const next = String(value || "")
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
              // The dropdown can change several chips at once (its Clear
              // action empties the whole selection) — toggle EVERY diff, not
              // just the first (codex P3 r10).
              const added = next.filter((c) => !nextStepChips.includes(c));
              const removed = nextStepChips.filter((c) => !next.includes(c));
              [...added, ...removed].forEach((chip) => onToggleChip(chip));
            }}
            inputStyle={{ width: "100%", boxSizing: "border-box" }}
            optionDisabledReason={(option) => {
              if (nextStepChips.includes(option)) return null;
              const conflict = typedNextStepChipConflict(
                schema.type,
                option,
                values,
              );
              if (conflict) return conflict;
              if (nextStepChips.length >= 4) return "Up to 4 next steps";
              return null;
            }}
          />
        ) : (
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
        )}
      </div>
      {/* Recommendations textarea stays PRIMARY-only: companion sections pass
          onRecommendationsChange={null} and are chips-first deterministic copy
          (combined-service-completions.md). The old recommendations-only
          "AI draft" was retired 2026-08-15 (owner): typed completions now use
          the panel's single full "Generate AI report" action, whose payload
          carries these structured findings (buildAiReportPayload). */}
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
      </div>
      )}
      </fieldset>
    </div>
  );
}

// The four scores the tech reviews/adjusts, matching the customer report's
// consolidated diagnosis (Density / Weeds / Color / Stress-Damage). The AI still
// assesses the underlying fungus/thatch/insect/drought/mechanical signals — those
// stay on the assessment row for analytics + folding into stress_damage — but the
// tech now corrects one "Stress" score directly instead of separate Fungus/Thatch.
const LAWN_ASSESSMENT_METRICS = [
  { key: "turf_density", label: "Density" },
  { key: "weed_suppression", label: "Weeds" },
  { key: "color_health", label: "Color" },
  { key: "stress_damage", label: "Stress" },
];

// Stress flags and the "Protocol field checks" inputs (thatch, chinch pair,
// nematode/large-patch pills, Soil K, protocol notes) were removed from this
// sheet entirely (owner trim 2026-08-07) — nearly all were captured on every
// visit and read by nothing, and the owner ruled the rest off too. The
// completion capture is now photos, the gauge reading, and the four score
// counters. The server endpoints still accept the retired keys from old
// payloads. Soil K no longer has a client input anywhere, so the plan
// engine's profile-completeness check no longer requires it; drought_stress
// likewise no longer reaches the planner's drought-prep selection — both are
// deliberate owner rulings, not oversights.

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
  const turf_density = row.turf_density ?? row.turfDensity ?? 0;
  const weed_suppression = row.weed_suppression ?? row.weedSuppression ?? 0;
  const color_health = row.color_health ?? row.colorHealth ?? 0;
  // Kept (not shown as chips) so a re-confirm preserves the AI values; the tech
  // now corrects stress_damage directly instead of these two.
  const fungus_control = row.fungus_control ?? row.fungusControl ?? 0;
  const thatch_level = row.thatch_level ?? row.thatchLevel ?? 0;
  // Legacy assessments (created before the stress_damage column) have a null
  // stress_damage. Coercing that to 0 would make a plain re-confirm POST
  // stress_damage: 0, which /confirm treats as an explicit "push Stress to 0"
  // override and persists an artificially low score. Instead derive it exactly the
  // way the server's confirm fallback does — min(fungus, thatch, AI-floor) with the
  // legacy 95 floor — so posting the seeded chip value is a no-op, not an override.
  const rawStress = row.stress_damage ?? row.stressDamage;
  const stress_damage = rawStress != null
    ? rawStress
    : Math.min(Number(fungus_control) || 0, Number(thatch_level) || 0, 95);
  return { turf_density, weed_suppression, color_health, fungus_control, thatch_level, stress_damage };
}


function LawnAssessmentCompletionBlock({
  service,
  disabled,
  onConfirmed,
  // Fires false while the existing-assessment lookup is in flight and true
  // once it settles — the parent must not treat the pre-load null confirmed
  // id as "retake pending".
  onReady,
  // Optional on-site lawn-length (gauge) photo — captured inline next to the turf
  // photos here, but stored on the shared turf-height state (CompletionPanel owns
  // it). Only rendered when the gauge-reading capture applies (turf-height flag).
  gaugePhoto = null,
  onGaugePhoto,
  showGaugePhoto = false,
  // Gauge reading (height-of-cut) — sits inline with the lawn-length photo it
  // documents. Stored on the same shared turf-height state.
  gaugeHeightIn = null,
  onGaugeHeight,
  // The tech's free-text visit notes (owned by CompletionPanel) — passed through
  // so the AI photo analysis can factor them in alongside the images.
  technicianNotes = "",
}) {
  const [photos, setPhotos] = useState([]);
  const [result, setResult] = useState(null);
  const [techScores, setTechScores] = useState(null);
  const [confirmedId, setConfirmedId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState("");
  const fileRef = useRef(null);
  const gaugeFileRef = useRef(null);

  async function onPickGaugePhoto(e) {
    const file = (e.target.files || [])[0];
    if (!file) return;
    try {
      const photo = await prepareCompletionPhoto(file);
      onGaugePhoto?.({ data: photo.data, name: photo.name || "lawn-length.jpg" });
    } catch { alert("Could not prepare the lawn length photo."); }
    if (gaugeFileRef.current) gaugeFileRef.current.value = "";
  }

  useEffect(() => {
    let cancelled = false;
    setPhotos([]);
    setResult(null);
    setTechScores(null);
    setConfirmedId(null);
    setError("");
    onConfirmed?.(null);
    onReady?.(false);
    if (!service?.id) {
      onReady?.(true);
      return () => { cancelled = true; };
    }

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
        if (assessment.confirmed_by_tech) {
          setConfirmedId(assessment.id);
          onConfirmed?.(assessment.id);
        }
      })
      .then(() => {
        if (!cancelled) onReady?.(true);
      })
      .catch(() => {
        // The lookup learned NOTHING — report failed, never ready: the parent
        // omits lawnAssessmentId so the server's visit-linked fallback (DB
        // truth) still grounds any existing confirmed scores.
        if (!cancelled) onReady?.("failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [service?.id]);

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
    // Same suspension as the confirmation POST: the vision analysis can run
    // long, and a report generated mid-analysis would carry an explicit-null
    // assessment state for scores that are about to be reviewed.
    onReady?.(false);
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
          // Extra context for the vision model (see buildVisionPrompt server-side).
          turfHeightIn: gaugeHeightIn,
          technicianNotes,
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
      // Settled either way: post-analysis the row is unconfirmed (or the
      // analysis failed with photos pending) — explicit null IS the true
      // "review outstanding" state.
      onReady?.(true);
    }
  }

  async function confirm() {
    if (!result?.assessment?.id) return;
    setConfirming(true);
    // Readiness is suspended while the confirmation POST is in flight — the
    // parent's id is stale until it lands, and generating meanwhile would
    // send an explicit null that suppresses the assessment being confirmed.
    onReady?.(false);
    setError("");
    try {
      const response = await adminFetch("/admin/lawn-assessment/confirm", {
        method: "POST",
        body: JSON.stringify({
          assessmentId: result.assessment.id,
          adjustedScores: techScores || result.adjustedScores || result.displayScores,
        }),
      });
      const assessmentId = response?.assessment?.id || result.assessment.id;
      setConfirmedId(assessmentId);
      onConfirmed?.(assessmentId);
      onReady?.(true);
    } catch (err) {
      setError(err.message || "Confirm failed");
      // A definitive 4xx rejection means the write did NOT commit — null is
      // the true state (retake still pending), so readiness returns true and
      // the explicit-null payload keeps any superseded row suppressed.
      // Ambiguous failures (network, 5xx, lost response) report failed: the
      // write may have committed, so the server grounds from DB truth.
      const definitiveRejection =
        Number(err?.status) >= 400 && Number(err?.status) < 500;
      onReady?.(definitiveRejection ? true : "failed");
    } finally {
      setConfirming(false);
    }
  }

  const scoreSource = techScores || result?.adjustedScores || result?.displayScores || null;
  const hasResult = !!result?.assessment?.id;
  const confirmed = !!confirmedId;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {loading && (
        <div style={{ fontSize: 12, color: D.muted }}>Checking existing assessment...</div>
      )}
      {/* Capture row — always visible so the lawn-length photo + gauge reading can be
          added even after the assessment is analyzed (Codex P1). "Add turf photos" +
          "Analyze lawn" stay pre-analysis only. */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        multiple
        onChange={addPhotos}
        style={{ display: "none" }}
      />
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        {!hasResult && (
          <>
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
                fontWeight: 500,
                cursor: disabled || photos.length >= 3 || analyzing ? "not-allowed" : "pointer",
                opacity: disabled || photos.length >= 3 || analyzing ? 0.55 : 1,
              }}
            >
              Add turf photos
            </button>
            <span style={{ fontSize: 12, color: D.muted }}>{photos.length}/3</span>
          </>
        )}
            {showGaugePhoto && (
              <>
                <input
                  ref={gaugeFileRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  onChange={onPickGaugePhoto}
                  style={{ display: "none" }}
                />
                <button
                  type="button"
                  onClick={() => gaugeFileRef.current?.click()}
                  disabled={disabled || analyzing}
                  style={{
                    height: 38,
                    padding: "0 14px",
                    borderRadius: 8,
                    border: `1px solid ${D.border}`,
                    background: D.white,
                    color: D.heading,
                    fontSize: 13,
                    fontWeight: 500,
                    cursor: disabled || analyzing ? "not-allowed" : "pointer",
                    opacity: disabled || analyzing ? 0.55 : 1,
                  }}
                >
                  Add lawn length photo
                </button>
                <span style={{ fontSize: 12, color: D.muted }}>{gaugePhoto ? 1 : 0}/1</span>
                {/* Gauge reading (height of cut) — sits with the lawn-length photo it documents. */}
                <span style={{ fontSize: 12, color: D.muted, fontWeight: 500 }}>Gauge reading</span>
                <input
                  type="number"
                  inputMode="decimal"
                  step="0.25"
                  min="0.5"
                  max="8"
                  value={gaugeHeightIn ?? ""}
                  disabled={disabled || analyzing}
                  placeholder="e.g. 4"
                  onChange={(e) => onGaugeHeight?.(e.target.value === "" ? null : Number(e.target.value))}
                  style={{
                    width: 64,
                    height: 38,
                    padding: "0 10px",
                    borderRadius: 8,
                    border: `1px solid ${D.border}`,
                    background: D.white,
                    color: D.heading,
                    fontSize: 13,
                  }}
                />
                <span style={{ fontSize: 12, color: D.muted }}>inches</span>
              </>
            )}
          </div>
          {!hasResult && (
            <>
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
              fontWeight: 500,
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
          <div style={{ display: "grid", gridTemplateColumns: `repeat(${LAWN_ASSESSMENT_METRICS.length}, minmax(0, 1fr))`, gap: 6 }}>
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
                  <div style={{ fontSize: 15, fontWeight: 500, color: lawnScoreColor(value), lineHeight: 1.1 }}>
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
                  fontWeight: 500,
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
                  fontWeight: 500,
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
                setConfirmedId(null);
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
                fontWeight: 500,
                cursor: disabled || analyzing || confirming ? "not-allowed" : "pointer",
                opacity: disabled || analyzing || confirming ? 0.55 : 1,
              }}
            >
              Retake
            </button>
          </div>
        </>
      )}
      {error && <div style={{ fontSize: 12, color: D.red, lineHeight: 1.45 }}>{error}</div>}
    </div>
  );
}

const scoreButtonStyle = {
  width: 24,
  height: 24,
  borderRadius: 6,
  border: `1px solid ${D.border}`,
  background: D.white,
  color: D.heading,
  fontSize: 14,
  fontWeight: 500,
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
      "soil_drench",
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

export function defaultApplicationMethod(product = {}, serviceType = "", { interiorLane = false } = {}) {
  const category = String(product.category || product.product_category || "").toLowerCase();
  const explicit = product.application_method || product.method;
  if (explicit) return normalizeApplicationMethod(explicit);
  if (category.includes("bait") || category.includes("gel") || category.includes("glue")) return "bait_placement";
  // Liquid fertilizers (K-Flow, Green Flo, chelated micros — catalog rate
  // unit fl_oz/gal or "Liquid" in the name) go down as a spray, not granular.
  const rateUnit = String(
    product.rate_unit || product.rateUnit || product.default_unit || product.defaultUnit || "",
  ).toLowerCase();
  const liquidProduct =
    rateUnit.includes("fl") || rateUnit.includes("gal") ||
    /\b(liquid|flow?)\b/i.test(String(product.name || ""));
  if (category.includes("fert") && liquidProduct) return "broadcast_spray";
  if (category.includes("fert") || category.includes("granular")) return "granular_broadcast";
  const serviceLine = serviceLineFromType(serviceType);
  if (serviceLine === "mosquito") return "fog_ulv";
  if (serviceLine === "lawn") return category.includes("herb") ? "spot_treatment" : "broadcast_spray";
  if (serviceLine === "palm" || serviceLine === "tree_shrub") return "foliar_spray";
  if (serviceLine === "termite" || serviceLine === "rodent") return "station_check";
  // Bed bug is an interior treatment: the pest perimeter_spray fallback
  // recorded interior work as exterior AND demanded perimeter footage the
  // (hidden) zone tracer would have prefilled, blocking a routine closeout
  // — default methodless products to an interior spot application instead
  // (codex P1 on the bed-bug untype). interiorLane comes from the STABLE
  // profile key; the name regex is the fallback for callers without it.
  if (interiorLane || /\bbed\s*bugs?\b/i.test(String(serviceType || ""))) return "spot_treatment";
  return "perimeter_spray";
}

// Whether a product controls something a tech would list as a target.
// Adjuvants/surfactants, soil amendments/wetting agents, and growth
// regulators don't — their cards skip the Targets picker. Fertilizer-family
// products DO (owner request 2026-07-23): their targets are the nutrition
// goals of the application (green-up, iron chlorosis, potassium deficiency),
// prefilled from the catalog like pest targets. Unknown catalog rows keep it.
export function productControlsTargets(product) {
  const category = String(
    product?.category || product?.product_category || "",
  ).toLowerCase();
  if (!category) return true;
  return !/(adjuvant|surfactant|soil|moisture|growth regulator|pgr)/.test(
    category,
  );
}

// Fertilizer-family products (incl. micros/biostimulants) target nutrition
// goals rather than pests — their picker swaps to the nutrition suggestions.
export function productTargetsNutrition(product) {
  const category = String(
    product?.category || product?.product_category || "",
  ).toLowerCase();
  return /(fert|micronutrient|biostimulant)/.test(category);
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
      product.activeIngredient,
      product.applicationMethod,
      product.rateUnit,
    );
  // Mirrors the server's isInsectLikeProduct (incl. the bifen\w*/\w*thrin/
  // named-active terms added for blank-category catalog rows like Delta Dust
  // and Elector PSP — codex P1 r5). Keep the two regexes in sync.
  const hasInsectProduct = selectedProducts.some((product) =>
    /\b(insect|miticide|igr|whitefly|scale|aphid|thrip|caterpillar|mite|neonic|imidacloprid|dinotefuran|bifen\w*|\w*thrin|pyrethroid|spinosad|spinetoram|indoxacarb|abamectin|emamectin|pyriproxyfen|acephate|chlorantraniliprole|acelepryn|fipronil|merit|zylam|kontos|mainspring|distance|talus|suffoil|oil|conserve|floramite|talstar|sevin|azamax|ima[\s-]*jet)\b/.test(productsText(product)),
  );
  const hasFungicideProduct = selectedProducts.some((product) =>
    /\b(fungicide|fungus|disease|phytophthora|kphite|phosphite|phosphonate|copper|headway|artavia|propizol|frac)\b/.test(productsText(product)),
  );
  // Mirrors the server's herbicide family classifier: herbicides carry
  // rotation history too (HRAC), so the server requires iracFracLogged for
  // them — without this flag the form enables Submit and then 400s (codex
  // P2 r4).
  const hasHerbicideProduct = selectedProducts.some((product) =>
    /\b(herbicide|pre[\s-]?emergent|post[\s-]?emergent|weeds?|glyphosate|prodiamine|dithiopyr|isoxaben|oxadiazon|pendimethalin|indaziflam|barricade|dimension|gallery|ronstar|snapshot|specticle|marengo|freehand|roundup|finale|reward|sedgehammer)\b/.test(productsText(product)),
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
    hasHerbicideProduct,
    needsIracFracLog: hasInsectProduct || hasFungicideProduct || hasHerbicideProduct,
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
      <label style={{ display: "flex", alignItems: "center", gap: 8, color: colors.text, fontSize: 13, fontWeight: 500 }}>
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
      <label style={{ display: "flex", alignItems: "center", gap: 8, color: colors.text, fontSize: 13, fontWeight: 500 }}>
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

// (Removed the standalone TurfHeightCapture component + its grass-band map — the
// gauge reading is now captured inline in LawnAssessmentCompletionBlock next to
// the lawn-length photo it documents.)

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

// ── Zone marking (satellite coverage) ────────────────────────────────────────
// Marks WHERE each chipped area actually is on the property's satellite
// image; shapes persist into property_zones.geometry_image, which lights up
// the satellite coverage map on the customer report. Coordinates are
// normalized 0-1 against the 640x340 image; circle radius normalizes against
// the SHORT side (r = px/340) to match the server contract.
// No longer rendered in the completion flow (retired 2026-07-23 in favor of
// the traced Treatment Zone Mapper) — the property-capture UI in
// Customer360ProfileV2 still uses it to record zone geometry.
const ZONE_MARK_DEFAULT_R = 0.07;
const ZONE_MARK_MIN_RECT = 0.02;

export function ZoneMarkingStep({
  map,
  areas,
  marks,
  onSetMark,
  onClearMark,
  dark = false,
  disabled = false,
}) {
  const [activeLabel, setActiveLabel] = useState(null);
  const [tool, setTool] = useState("circle");
  const [rectDraft, setRectDraft] = useState(null);
  const svgRef = useRef(null);

  // keep the active row valid as chips toggle
  useEffect(() => {
    if (!areas.length) { setActiveLabel(null); return; }
    if (!activeLabel || !areas.includes(activeLabel)) setActiveLabel(areas[0]);
  }, [areas, activeLabel]);

  if (!map?.available || !map.image?.url || !areas.length) return null;

  const ink = dark ? "#e2e8f0" : "#1a1a1a";
  const mutedInk = dark ? "#94a3b8" : "#6b6b6b";
  const cardBg = dark ? "#1e293b" : "#ffffff";
  const hairline = dark ? "#334155" : "#e4e4e4";
  const accent = "#0ea5e9";

  const svgPointFromEvent = (evt) => {
    const el = svgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    return {
      x: Math.min(1, Math.max(0, (evt.clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (evt.clientY - rect.top) / rect.height)),
    };
  };

  const commitCircle = (pt) => {
    onSetMark(activeLabel, { type: "circle", cx: pt.x, cy: pt.y, r: ZONE_MARK_DEFAULT_R });
  };

  const handlePointerDown = (evt) => {
    if (disabled || !activeLabel) return;
    const pt = svgPointFromEvent(evt);
    if (!pt) return;
    if (tool === "rect") {
      evt.currentTarget.setPointerCapture?.(evt.pointerId);
      setRectDraft({ x0: pt.x, y0: pt.y, x1: pt.x, y1: pt.y });
    }
  };
  const handlePointerMove = (evt) => {
    if (!rectDraft) return;
    const pt = svgPointFromEvent(evt);
    if (!pt) return;
    setRectDraft((prev) => (prev ? { ...prev, x1: pt.x, y1: pt.y } : prev));
  };
  const handlePointerUp = (evt) => {
    if (disabled || !activeLabel) { setRectDraft(null); return; }
    if (tool === "rect" && rectDraft) {
      // Close the box at the RELEASE point, not the last pointermove — a fast
      // drag can release with zero/stale move events, and committing the
      // draft alone would shrink the box to the down point and drop the mark.
      const end = svgPointFromEvent(evt) || { x: rectDraft.x1, y: rectDraft.y1 };
      const x = Math.min(rectDraft.x0, end.x);
      const y = Math.min(rectDraft.y0, end.y);
      const w = Math.abs(end.x - rectDraft.x0);
      const h = Math.abs(end.y - rectDraft.y0);
      setRectDraft(null);
      if (w >= ZONE_MARK_MIN_RECT && h >= ZONE_MARK_MIN_RECT) {
        onSetMark(activeLabel, { type: "rect", x, y, w, h });
      }
      return;
    }
    const pt = svgPointFromEvent(evt);
    if (pt) commitCircle(pt);
  };

  const resizeActiveCircle = (delta) => {
    // disabled must freeze EVERY mutating control, not just the pointer
    // handlers — an edit landing mid-submit is not in the payload already
    // sent, so it would silently vanish behind a successful save
    if (disabled) return;
    const mark = marks[activeLabel];
    if (!mark || mark.type !== "circle") return;
    const r = Math.min(0.4, Math.max(0.02, Number(mark.r) + delta));
    onSetMark(activeLabel, { ...mark, r });
  };

  const markedCount = areas.filter((a) => marks[a]).length;
  const activeMark = activeLabel ? marks[activeLabel] : null;

  const renderMark = (label, mark, isActive) => {
    const stroke = isActive ? accent : "rgba(255,255,255,0.9)";
    const fill = isActive ? "rgba(14,165,233,0.25)" : "rgba(255,255,255,0.16)";
    const letter = String(areas.indexOf(label) + 1);
    if (mark.type === "rect") {
      const cx = (mark.x + mark.w / 2) * 640;
      const cy = (mark.y + mark.h / 2) * 340;
      return (
        <g key={label}>
          <rect x={mark.x * 640} y={mark.y * 340} width={mark.w * 640} height={mark.h * 340} rx={8} fill={fill} stroke={stroke} strokeWidth={2.5} />
          <circle cx={cx} cy={cy} r={11} fill="rgba(2,20,35,0.75)" />
          <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fontWeight={700} fill="#fff">{letter}</text>
        </g>
      );
    }
    const cx = mark.cx * 640;
    const cy = mark.cy * 340;
    return (
      <g key={label}>
        <circle cx={cx} cy={cy} r={mark.r * 340} fill={fill} stroke={stroke} strokeWidth={2.5} />
        <circle cx={cx} cy={cy} r={11} fill="rgba(2,20,35,0.75)" />
        <text x={cx} y={cy + 4} textAnchor="middle" fontSize={12} fontWeight={700} fill="#fff">{letter}</text>
      </g>
    );
  };

  return (
    <div style={{ marginTop: 12, border: `1px solid ${hairline}`, borderRadius: 12, background: cardBg, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: ink }}>Mark treated areas on the map</div>
        <div style={{ fontSize: 11, color: markedCount === areas.length ? "#10b981" : mutedInk, fontWeight: 500 }}>
          {markedCount} of {areas.length} marked
        </div>
      </div>
      <div style={{ fontSize: 11, color: mutedInk, margin: "2px 0 8px" }}>
        Pick an area, then tap the photo to drop a circle (or switch to box and drag).
        Mark every area to unlock the satellite map on the customer report.
      </div>
      {markedCount > 0 && markedCount < areas.length ? (
        <div style={{ fontSize: 11, color: "#f59e0b", fontWeight: 500, margin: "0 0 8px" }}>
          Marks only save when every area is marked — finish the remaining {areas.length - markedCount} or they will be discarded.
        </div>
      ) : null}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
        {areas.map((label) => {
          const isActive = label === activeLabel;
          const isMarked = Boolean(marks[label]);
          return (
            <button
              key={label}
              type="button"
              onClick={() => setActiveLabel(label)}
              style={{
                padding: "5px 12px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 500,
                cursor: "pointer",
                background: isActive ? accent : "transparent",
                color: isActive ? "#fff" : ink,
                border: `1px solid ${isActive ? accent : hairline}`,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
              }}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: isMarked ? "#10b981" : (isActive ? "rgba(255,255,255,0.6)" : hairline) }} />
              {areas.indexOf(label) + 1}. {label}
            </button>
          );
        })}
      </div>
      <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", border: `1px solid ${hairline}` }}>
        <svg
          ref={svgRef}
          viewBox="0 0 640 340"
          style={{ display: "block", width: "100%", touchAction: "none", cursor: disabled ? "default" : "crosshair" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
        >
          <image href={map.image.url} x="0" y="0" width="640" height="340" preserveAspectRatio="xMidYMid slice" />
          {areas.filter((label) => marks[label] && label !== activeLabel).map((label) => renderMark(label, marks[label], false))}
          {activeMark ? renderMark(activeLabel, activeMark, true) : null}
          {rectDraft ? (
            <rect
              x={Math.min(rectDraft.x0, rectDraft.x1) * 640}
              y={Math.min(rectDraft.y0, rectDraft.y1) * 340}
              width={Math.abs(rectDraft.x1 - rectDraft.x0) * 640}
              height={Math.abs(rectDraft.y1 - rectDraft.y0) * 340}
              fill="rgba(14,165,233,0.2)"
              stroke="#38bdf8"
              strokeWidth={2}
              strokeDasharray="6 4"
            />
          ) : null}
        </svg>
        {map.image.attributionText ? (
          <div style={{ position: "absolute", right: 6, bottom: 4, fontSize: 10, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.9)", pointerEvents: "none" }}>
            {map.image.attributionText}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <button type="button" onClick={() => setTool("circle")} style={{ padding: "4px 12px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer", background: tool === "circle" ? accent : "transparent", color: tool === "circle" ? "#fff" : ink, border: `1px solid ${tool === "circle" ? accent : hairline}` }}>Circle</button>
        <button type="button" onClick={() => setTool("rect")} style={{ padding: "4px 12px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer", background: tool === "rect" ? accent : "transparent", color: tool === "rect" ? "#fff" : ink, border: `1px solid ${tool === "rect" ? accent : hairline}` }}>Box</button>
        {activeMark && activeMark.type === "circle" ? (
          <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
            <button type="button" disabled={disabled} onClick={() => resizeActiveCircle(-0.015)} style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${hairline}`, background: "transparent", color: ink, fontSize: 15, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}>-</button>
            <button type="button" disabled={disabled} onClick={() => resizeActiveCircle(0.015)} style={{ width: 28, height: 28, borderRadius: 8, border: `1px solid ${hairline}`, background: "transparent", color: ink, fontSize: 15, cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1 }}>+</button>
            <span style={{ fontSize: 11, color: mutedInk }}>size</span>
          </span>
        ) : null}
        {activeMark ? (
          <button type="button" disabled={disabled} onClick={() => { if (!disabled) onClearMark(activeLabel); }} style={{ padding: "4px 12px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: disabled ? "default" : "pointer", background: "transparent", color: dark ? "#f87171" : "#b91c1c", border: `1px solid ${dark ? "#7f1d1d" : "#fecaca"}`, opacity: disabled ? 0.5 : 1 }}>Remove mark</button>
        ) : null}
      </div>
    </div>
  );
}

// ── Bait station marking (station-map-v1) ────────────────────────────────────
// Bait stations (termite in-ground or rodent exterior, per `program`) as
// individually-numbered pins on the same satellite image the zone step
// draws on. Unlike zones (areas, all-or-nothing gate), stations are
// independent point pins that each carry a per-visit status — the tech's
// zero-tap path is "everything OK": every station defaults to 'ok' and only
// exceptions get a tap. Pins persist as normalized circles so the shared
// zone-drift re-anchoring applies to them unchanged. Status VALUES are
// shared across programs (one DB CHECK); only the labels differ —
// 'activity' reads "Activity" for termite, "Consumption" for rodent
// (owner rodent-wording rules: exterior bait consumption, never
// interior-infestation language).
const STATION_PIN_R = 0.035; // normalized against the SHORT side (~12px @340)
const STATION_TAP_RADIUS_PX = 22;
// Frame size the pins and the tap math are authored against. Zooming shrinks
// the rendered viewBox around this same frame — the satellite image and the
// stored NORMALIZED pin coordinates never change, so a zoomed placement is
// byte-identical to the same placement at 1× (no re-anchoring, no drift).
const STATION_FRAME_W = 640;
const STATION_FRAME_H = 340;
// The Static Map basemap is fetched at scale=2, so 4× is where the imagery
// itself runs out of detail — past that the tech is magnifying blur.
const STATION_MAX_ZOOM = 4;
const STATION_ZOOM_STEP = 2;
// Pointer travel in CLIENT PIXELS that turns a tap into a pan. Below it the
// gesture still places/selects a pin, so the one-tap flow survives the shaky
// thumb a phone in the field always has. Deliberately NOT frame units: those
// scale with the rendered width and the zoom, which would shrink a thumb
// tolerance on exactly the small screens that need it most.
const STATION_DRAG_SLOP = 6;
const STATION_FULL_VIEW = { x: 0, y: 0, w: STATION_FRAME_W, h: STATION_FRAME_H };
// Keep the window inside the basemap so zooming can never reveal blank space.
// Rounded to 2dp: a pan otherwise writes a 15-decimal viewBox string on every
// pointermove, and sub-hundredth precision is invisible on a 640-unit frame.
function clampStationView(view) {
  const round = (n) => Math.round(n * 100) / 100;
  return {
    ...view,
    x: round(Math.min(Math.max(0, view.x), STATION_FRAME_W - view.w)),
    y: round(Math.min(Math.max(0, view.y), STATION_FRAME_H - view.h)),
  };
}
const STATION_STATUS_UI = {
  ok: { color: "#10b981", label: "OK" },
  activity: { color: "#ef4444", label: "Activity" },
  serviced: { color: "#f59e0b", label: "Serviced" },
  inaccessible: { color: "#94a3b8", label: "No access" },
};
const STATION_PROGRAM_UI = {
  termite: {
    title: "Bait station map",
    hint: "Every station starts as OK — tap a pin to flag activity, service, or no access.",
    activityLabel: "Activity",
    activityCounter: "with activity",
  },
  rodent: {
    title: "Rodent bait station map",
    hint: "Every station starts as OK — tap a pin to flag consumption, service, or no access.",
    activityLabel: "Consumption",
    activityCounter: "with consumption",
  },
  trapping: {
    title: "Rodent trap map",
    hint: "Every trap starts as OK — tap a pin to record a capture, service, or no access.",
    activityLabel: "Capture",
    activityCounter: "with captures",
  },
};
function stationStatusLabel(status, program) {
  if (status === "activity") return STATION_PROGRAM_UI[program]?.activityLabel || "Activity";
  return STATION_STATUS_UI[status]?.label || status;
}

export function StationMarkingStep({
  map,
  stations, // [{ key, id?, number, label?, shape: {cx,cy,r}|null, stale }]
  statuses, // { key → status } — absent key renders as 'ok'
  onAddStation, // ({ cx, cy }) — parent appends a provisional-numbered pin
  onMoveStation, // (key, { cx, cy })
  onSetStatus, // (key, status)
  onRemoveStation, // (key) — new pins delete; existing stations retire
  // false = office desk mode (Customer 360): positions only, no visit to
  // hang statuses on — pins render neutral and the status chips hide.
  showStatuses = true,
  // server cap (property-map stationCap) — add-mode stops here so the
  // counts can never claim a pin the registry will refuse
  maxStations = 80,
  program = "termite", // 'termite' | 'rodent' — labels only, mechanics shared
  disabled = false,
  dark = false,
  // A declared trap SETUP cannot carry serviced pins (the server rejects
  // the completion) — hide the chip so the conflict can't be created by
  // tap. A pin already serviced (restored, or marked before the visit-type
  // selector changed) keeps its chip visible so the operator can see the
  // mark and switch it off; the handleSubmit mirror still catches it if
  // they don't (codex P2 r18).
  disallowServiced = false,
}) {
  const [selectedKey, setSelectedKey] = useState(null);
  const [addMode, setAddMode] = useState(false);
  const [armedMoveKey, setArmedMoveKey] = useState(null);
  // Magnifier over the SAME basemap (owner 2026-08-02: "when I mark rodent
  // traps I can't zoom in and zoom out like I can with trace where we
  // sprayed"). Deliberately NOT the tracer's approach — that one re-fetches
  // the Static Map at a new Google zoom, which is fine for a throwaway trace
  // but would re-project every stored pin here. This is a pure viewBox
  // window: the image, the normalized pin coordinates, and the drift
  // re-anchoring are all untouched, so a pin dropped at 4× lands exactly
  // where the same tap would land at 1×.
  const [view, setView] = useState(STATION_FULL_VIEW);
  const svgRef = useRef(null);
  // Live pan gesture: null between gestures, else the pointer origin and the
  // view it started from. `moved` latches once the drag passes the slop, and
  // suppresses the pin tap that would otherwise fire on pointerup.
  const gestureRef = useRef(null);

  // A new basemap invalidates the window (and the pins re-anchor against it).
  useEffect(() => { setView(STATION_FULL_VIEW); }, [map?.image?.url]);

  if (!map?.available || !map.image?.url) return null;

  const ink = dark ? "#e2e8f0" : "#1a1a1a";
  const mutedInk = dark ? "#94a3b8" : "#6b6b6b";
  const cardBg = dark ? "#1e293b" : "#ffffff";
  const hairline = dark ? "#334155" : "#e4e4e4";
  const accent = "#0ea5e9";

  const pinned = stations.filter((station) => station.shape);
  const stale = stations.filter((station) => !station.shape);
  const selected = stations.find((station) => station.key === selectedKey) || null;
  const statusOf = (key) => statuses[key] || "ok";
  const activityCount = pinned.filter((station) => statusOf(station.key) === "activity").length;

  // How much of the frame one rendered pixel covers. 1 at full view; 0.5 at
  // 2×, 0.25 at 4× — the single factor every screen-space number below is
  // divided by so pins, taps, and labels stay physically the same size.
  const viewScale = view.w / STATION_FRAME_W;
  const zoomLevel = Math.round(1 / viewScale);
  const canPan = view.w < STATION_FRAME_W;

  const svgPointFromEvent = (evt) => {
    const el = svgRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    // Client px → viewBox units → normalized against the FULL frame, which
    // is the coordinate space the pins persist in. At full view the two
    // conversions cancel and this is the original 0-1 mapping.
    const frameX = view.x + ((evt.clientX - rect.left) / rect.width) * view.w;
    const frameY = view.y + ((evt.clientY - rect.top) / rect.height) * view.h;
    return {
      x: Math.min(1, Math.max(0, frameX / STATION_FRAME_W)),
      y: Math.min(1, Math.max(0, frameY / STATION_FRAME_H)),
    };
  };

  const nearestPin = (pt) => {
    let best = null;
    let bestDist = Infinity;
    pinned.forEach((station) => {
      const dx = (station.shape.cx - pt.x) * STATION_FRAME_W;
      const dy = (station.shape.cy - pt.y) * STATION_FRAME_H;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < bestDist) {
        best = station;
        bestDist = dist;
      }
    });
    // The tap target is a THUMB, so its tolerance is fixed in screen pixels
    // and converted with the CURRENT rendered width — not with the nominal
    // 640-unit frame. Using the frame made the radius scale with the card's
    // rendered size: on a 390px phone (~340px frame) at 2× it was ~11.7
    // physical px, so a 15px-off tap missed the pin and add-mode could drop
    // a duplicate beside it. The 640px test stub hid this because there the
    // two denominators are equal (codex P2 on #3159).
    const rect = svgRef.current?.getBoundingClientRect();
    const unitsPerClientPx = rect?.width ? view.w / rect.width : viewScale;
    return bestDist <= STATION_TAP_RADIUS_PX * unitsPerClientPx ? best : null;
  };

  const changeZoom = (factor) => {
    if (disabled) return;
    const next = Math.min(STATION_MAX_ZOOM, Math.max(1, zoomLevel * factor));
    if (next === zoomLevel) return;
    const w = STATION_FRAME_W / next;
    const h = STATION_FRAME_H / next;
    // Zoom about the current centre — the tech has already panned to the
    // part of the property they're working on.
    const cx = view.x + view.w / 2;
    const cy = view.y + view.h / 2;
    setView(clampStationView({ x: cx - w / 2, y: cy - h / 2, w, h }));
  };

  const handlePointerDown = (evt) => {
    // Panning only exists while zoomed in; at full view the frame keeps its
    // original tap-only behavior with no gesture state at all.
    if (disabled || !canPan) return;
    const el = svgRef.current;
    const rect = el?.getBoundingClientRect();
    if (!rect?.width || !rect?.height) return;
    gestureRef.current = {
      clientX: evt.clientX,
      clientY: evt.clientY,
      view,
      rect,
      moved: false,
    };
    if (evt.pointerId != null && el.setPointerCapture) {
      try { el.setPointerCapture(evt.pointerId); } catch { /* not a real pointer event */ }
    }
  };

  const handlePointerMove = (evt) => {
    const gesture = gestureRef.current;
    if (!gesture) return;
    // The slop is a THUMB tolerance, so it is measured in the client pixels
    // the thumb actually moved — never in frame units (codex P2 on #3159).
    // Converting first made the advertised 6px scale with the rendered
    // width: on a 390px phone the frame renders ~340px, so 6 frame units was
    // ~3.2 real pixels and an ordinary shake latched `moved`, silently
    // swallowing the pin placement. The earlier test hid this by stubbing a
    // 640px-wide SVG, where the two units happen to coincide.
    const dxPx = evt.clientX - gesture.clientX;
    const dyPx = evt.clientY - gesture.clientY;
    if (!gesture.moved && Math.abs(dxPx) + Math.abs(dyPx) <= STATION_DRAG_SLOP) return;
    const dx = (dxPx / gesture.rect.width) * gesture.view.w;
    const dy = (dyPx / gesture.rect.height) * gesture.view.h;
    gesture.moved = true;
    // Drag the MAP, not the window: content follows the thumb.
    setView(clampStationView({ ...gesture.view, x: gesture.view.x - dx, y: gesture.view.y - dy }));
  };

  const handlePointerUp = (evt) => {
    const gesture = gestureRef.current;
    gestureRef.current = null;
    const el = svgRef.current;
    if (evt.pointerId != null && el?.releasePointerCapture) {
      try { el.releasePointerCapture(evt.pointerId); } catch { /* already released */ }
    }
    if (disabled) return;
    // That gesture was a pan — it must not also drop or select a pin.
    if (gesture?.moved) return;
    const pt = svgPointFromEvent(evt);
    if (!pt) return;
    if (armedMoveKey) {
      // Same occupied-pin rule as add mode: dropping the moved station on
      // ANOTHER pin would be skipped server-side (position-occupied) while
      // the tech believes it moved — ignore the tap and stay armed. A tap
      // back on the station's own pin just re-places it.
      const occupied = nearestPin(pt);
      if (occupied && occupied.key !== armedMoveKey) return;
      onMoveStation(armedMoveKey, { cx: pt.x, cy: pt.y });
      setSelectedKey(armedMoveKey);
      setArmedMoveKey(null);
      return;
    }
    if (addMode) {
      // A tap landing on an existing pin must NOT stack a duplicate on top
      // of it (a double-tap would create two stations at one spot, and the
      // auto counts would claim a pin the server dedupes away). Ignore it —
      // the tech moves a thumb-width away or exits add mode to select.
      if (nearestPin(pt)) return;
      // Cap gating counts EVERY non-retired station, stale (drift-hidden)
      // pins included — they hold registry slots even though they don't
      // render, and an add past the real cap would 400 on save.
      if (stations.length >= maxStations) return;
      // stay in add mode — installs drop many pins in a row
      onAddStation({ cx: pt.x, cy: pt.y });
      return;
    }
    const hit = nearestPin(pt);
    setSelectedKey(hit ? hit.key : null);
  };

  const removeSelected = () => {
    if (disabled || !selected) return;
    onRemoveStation(selected.key);
    setSelectedKey(null);
    setArmedMoveKey(null);
  };

  const chipStyle = (active, color) => ({
    padding: "4px 12px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 500,
    cursor: disabled ? "default" : "pointer",
    background: active ? color : "transparent",
    color: active ? "#fff" : ink,
    border: `1px solid ${active ? color : hairline}`,
    opacity: disabled ? 0.5 : 1,
  });

  const renderPin = (station) => {
    const isSelected = station.key === selectedKey;
    const meta = STATION_STATUS_UI[statusOf(station.key)] || STATION_STATUS_UI.ok;
    const fill = showStatuses ? meta.color : "#64748b";
    const cx = station.shape.cx * STATION_FRAME_W;
    const cy = station.shape.cy * STATION_FRAME_H;
    // Pins are UI chrome, not map features: scaling them by the view keeps
    // them a constant size on screen, so zooming in reveals more IMAGE
    // rather than growing the markers over the detail being aimed at.
    return (
      <g key={station.key}>
        {isSelected && (
          <circle cx={cx} cy={cy} r={17 * viewScale} fill="none" stroke={accent} strokeWidth={3 * viewScale} />
        )}
        <circle
          cx={cx}
          cy={cy}
          r={12 * viewScale}
          fill={fill}
          stroke="rgba(255,255,255,0.95)"
          strokeWidth={2.5 * viewScale}
        />
        <text
          x={cx}
          y={cy + 4 * viewScale}
          textAnchor="middle"
          fontSize={12 * viewScale}
          fontWeight={700}
          fill="#fff"
        >
          {station.number}
        </text>
      </g>
    );
  };

  const programUi = STATION_PROGRAM_UI[program] || STATION_PROGRAM_UI.termite;

  return (
    <div style={{ marginTop: 12, border: `1px solid ${hairline}`, borderRadius: 12, background: cardBg, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <div style={{ fontSize: 13, fontWeight: 500, color: ink }}>{programUi.title}</div>
        <div style={{ fontSize: 11, color: showStatuses && activityCount ? "#ef4444" : mutedInk, fontWeight: 500 }}>
          {pinned.length} pinned{showStatuses && activityCount ? ` · ${activityCount} ${programUi.activityCounter}` : ""}
        </div>
      </div>
      <div style={{ fontSize: 11, color: mutedInk, margin: "2px 0 8px" }}>
        {addMode
          ? "Tap the photo where each station sits — one pin per tap."
          : armedMoveKey
            ? `Tap the photo to place station ${stations.find((s) => s.key === armedMoveKey)?.number ?? ""}.`
            : showStatuses
              ? programUi.hint
              : "Tap a pin to move or retire it, or add the property's stations from the satellite view."}
      </div>
      {stale.length > 0 && !addMode && !armedMoveKey && (
        <div style={{ fontSize: 11, color: "#f59e0b", fontWeight: 500, margin: "0 0 8px", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span>
            The satellite image changed — re-pin station{stale.length === 1 ? "" : "s"}{" "}
            {stale.map((station) => station.number).join(", ")}:
          </span>
          {stale.map((station) => (
            <button
              key={station.key}
              type="button"
              disabled={disabled}
              onClick={() => { if (!disabled) { setArmedMoveKey(station.key); setSelectedKey(station.key); } }}
              style={chipStyle(false, accent)}
            >
              Place #{station.number}
            </button>
          ))}
        </div>
      )}
      <div style={{ position: "relative", borderRadius: 10, overflow: "hidden", border: `1px solid ${hairline}` }}>
        <svg
          ref={svgRef}
          viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
          style={{ display: "block", width: "100%", touchAction: "none", cursor: disabled ? "default" : "crosshair" }}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => { gestureRef.current = null; }}
        >
          <image
            href={map.image.url}
            x="0"
            y="0"
            width={STATION_FRAME_W}
            height={STATION_FRAME_H}
            preserveAspectRatio="xMidYMid slice"
          />
          {pinned.filter((station) => station.key !== selectedKey).map(renderPin)}
          {selected && selected.shape ? renderPin(selected) : null}
        </svg>
        {/* Zoom stepper — deliberately the SAME affordance as the treatment-
            zone tracer (position, 40px thumb target, glass chip), because the
            owner asked for these two map tools to behave alike. It sits over
            the frame rather than in the button row below so it stays under
            the thumb while pins are being placed. */}
        <div style={{ position: "absolute", top: 8, right: 8, display: "flex", flexDirection: "column", gap: 6 }}>
          {[
            { label: "+", factor: STATION_ZOOM_STEP, blocked: zoomLevel >= STATION_MAX_ZOOM, name: "Zoom in" },
            { label: "−", factor: 1 / STATION_ZOOM_STEP, blocked: zoomLevel <= 1, name: "Zoom out" },
          ].map(({ label, factor, blocked, name }) => (
            <button
              key={name}
              type="button"
              aria-label={name}
              disabled={disabled || blocked}
              // Belt and braces with the tracer: never let the stepper start a
              // pan gesture on the frame behind it.
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => { e.stopPropagation(); changeZoom(factor); }}
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                border: "none",
                background: "rgba(15,25,35,0.72)",
                color: "#fff",
                fontSize: 22,
                lineHeight: 1,
                fontWeight: 600,
                cursor: disabled || blocked ? "default" : "pointer",
                opacity: disabled || blocked ? 0.35 : 1,
                touchAction: "manipulation",
              }}
            >
              {label}
            </button>
          ))}
        </div>
        {/* Bottom-LEFT, opposite the required attribution: on a 390px phone
            the frame is only ~172px tall, and the stepper already covers the
            right edge — parking this in a third corner would leave barely any
            unobstructed ground to pin on. */}
        {canPan ? (
          <div style={{ position: "absolute", bottom: 4, left: 6, padding: "3px 8px", borderRadius: 999, background: "rgba(15,25,35,0.72)", color: "#fff", fontSize: 11, fontWeight: 600, pointerEvents: "none" }}>
            {zoomLevel}× · drag to pan
          </div>
        ) : null}
        {map.image.attributionText ? (
          <div style={{ position: "absolute", right: 6, bottom: 4, fontSize: 10, color: "#fff", textShadow: "0 1px 2px rgba(0,0,0,0.9)", pointerEvents: "none" }}>
            {map.image.attributionText}
          </div>
        ) : null}
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
        <button
          type="button"
          disabled={disabled || (!addMode && stations.length >= maxStations)}
          onClick={() => {
            if (disabled) return;
            if (!addMode && stations.length >= maxStations) return;
            setAddMode((v) => !v);
            setArmedMoveKey(null);
            setSelectedKey(null);
          }}
          style={chipStyle(addMode, accent)}
        >
          {addMode ? "Done adding" : stations.length >= maxStations ? `Station cap (${maxStations})` : "Add stations"}
        </button>
        {selected && !addMode && (
          <>
            <span style={{ fontSize: 11, color: mutedInk }}>Station {selected.number}:</span>
            {showStatuses && Object.entries(STATION_STATUS_UI)
              .filter(([status]) => status !== "serviced"
                || !disallowServiced
                || statusOf(selected.key) === "serviced")
              .map(([status, meta]) => (
                <button
                  key={status}
                  type="button"
                  disabled={disabled}
                  onClick={() => { if (!disabled) onSetStatus(selected.key, status); }}
                  style={chipStyle(statusOf(selected.key) === status, meta.color)}
                >
                  {stationStatusLabel(status, program)}
                </button>
              ))}
            {selected.shape && (
              <button
                type="button"
                disabled={disabled}
                onClick={() => { if (!disabled) setArmedMoveKey(selected.key); }}
                style={chipStyle(armedMoveKey === selected.key, accent)}
              >
                Move pin
              </button>
            )}
            <button
              type="button"
              disabled={disabled}
              onClick={removeSelected}
              style={{ padding: "4px 12px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: disabled ? "default" : "pointer", background: "transparent", color: dark ? "#f87171" : "#b91c1c", border: `1px solid ${dark ? "#7f1d1d" : "#fecaca"}`, opacity: disabled ? 0.5 : 1 }}
            >
              {selected.id ? "Retire station" : "Remove pin"}
            </button>
          </>
        )}
      </div>
      {showStatuses && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 8 }}>
          {Object.entries(STATION_STATUS_UI)
            .filter(([status]) => status !== "serviced"
              || !disallowServiced
              || stations.some((station) => statusOf(station.key) === "serviced"))
            .map(([status, meta]) => (
              <span key={status} style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11, color: mutedInk }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: meta.color }} />
                {stationStatusLabel(status, program)}
              </span>
            ))}
        </div>
      )}
    </div>
  );
}

function RecapCapture({ serviceId }) {
  const [items, setItems] = useState([]);
  const [pendingFile, setPendingFile] = useState(null);
  const [showMore, setShowMore] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState(null);
  const fileRef = useRef(null);

  const refresh = () => adminFetch(`/admin/dispatch/${serviceId}/recap-media`)
    .then((d) => setItems(d?.items || [])).catch(() => {});
  useEffect(() => { refresh();   }, [serviceId]);

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
  const chip = { display: "flex", alignItems: "center", gap: 7, padding: "12px 10px", borderRadius: 11, background: D.bg, border: `1px solid ${D.border}`, color: D.text, fontSize: 12.5, fontWeight: 500, cursor: "pointer", textAlign: "left" };

  return (
    <div style={wrap}>
      <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 500, fontSize: 14, color: D.text, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 8 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: "#111" }} /> Recap clips</span>
        <span style={{ fontSize: 12, color: D.muted }}>{items.length ? `${items.length} captured` : "optional"}</span>
      </div>
      <div style={{ fontSize: 12.5, color: D.muted, margin: "6px 0 10px", lineHeight: 1.45 }}>Grab a few 5-sec clips of the work — they play in the customer’s recap. Skip it and the recap still generates.</div>

      <input ref={fileRef} type="file" accept="video/*,image/*" capture="environment" onChange={onPick} style={{ display: "none" }} />

      {items.length > 0 && (
        <div style={{ display: "grid", gap: 8, marginBottom: 10 }}>
          {items.map((m) => (
            <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, background: D.bg, border: `1px solid ${D.border}`, borderRadius: 10, padding: 8 }}>
              <div style={{ width: 40, height: 40, borderRadius: 7, background: "linear-gradient(135deg,#3f3f46,#18181b)", flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: D.white, textTransform: "capitalize" }}>{m.role}</div>
                <div style={{ fontSize: 11.5, color: "#111" }}>“{m.caption}”</div>
              </div>
              <span style={{ fontSize: 10.5, color: m.status === "ready" ? "#111" : D.muted, fontWeight: 500 }}>{m.status === "ready" ? "Uploaded" : m.status}</span>
              <button onClick={() => remove(m.id)} style={{ background: "none", border: "none", color: D.muted, fontSize: 18, cursor: "pointer" }}>×</button>
            </div>
          ))}
        </div>
      )}

      {err && <div style={{ fontSize: 12, color: D.red, margin: "0 0 8px", lineHeight: 1.4 }}>{err}</div>}
      <button onClick={() => fileRef.current && fileRef.current.click()} style={{ width: "100%", padding: "12px", borderRadius: 10, border: "none", background: "#111", color: "#fff", fontWeight: 500, fontSize: 13.5, cursor: "pointer", fontFamily: "'Montserrat', sans-serif" }}>
        {uploading ? `Uploading… (${uploading})` : "+ Capture clip"}
      </button>

      {pendingFile && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(5,8,13,.7)", zIndex: 50, display: "flex", alignItems: "flex-end" }} onClick={() => setPendingFile(null)}>
          <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", background: D.card, borderRadius: "18px 18px 0 0", border: `1px solid ${D.border}`, padding: "16px 14px 22px", maxHeight: "82%", overflowY: "auto" }}>
            <div style={{ width: 40, height: 4, background: D.border, borderRadius: 3, margin: "0 auto 12px" }} />
            <div style={{ fontFamily: "'Montserrat', sans-serif", fontWeight: 500, fontSize: 16, color: D.white, textAlign: "center" }}>What were you doing?</div>
            <div style={{ fontSize: 12, color: D.muted, textAlign: "center", margin: "4px 0 12px" }}>One tap. We caption it for the customer.</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {(showMore ? [...RECAP_CHIPS_TOP, ...RECAP_CHIPS_MORE] : RECAP_CHIPS_TOP).map((c) => (
                <button key={c.role} onClick={() => tag(c.role)} style={chip}><span style={{ width: 9, height: 9, borderRadius: "50%", background: "#111", flexShrink: 0 }} />{c.label}</button>
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
  const head = { fontFamily: "'Montserrat', sans-serif", fontWeight: 500, fontSize: 14, color: D.text, display: "flex", alignItems: "center", gap: 8, marginBottom: 8 };
  const btn = (bg, color) => ({ flex: 1, padding: "11px", borderRadius: 10, border: "none", background: bg, color, fontWeight: 500, fontSize: 13, cursor: busy ? "wait" : "pointer", fontFamily: "'Montserrat', sans-serif" });

  return (
    <div style={wrap}>
      <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
      <div style={head}><span style={{ width: 8, height: 8, borderRadius: "50%", background: "#111" }} /> Visit recap video</div>
      {s === "loading" && <div style={{ fontSize: 13, color: D.muted }}>Checking recap…</div>}
      {(s === "none") && (
        <>
          <div style={{ fontSize: 12.5, color: D.muted, marginBottom: 10 }}>Generate a ~30-sec recap from this visit. You’ll preview & approve before it sends.</div>
          <button style={btn("#111", "#fff")} disabled={busy} onClick={() => act("generate")}>Generate recap</button>
        </>
      )}
      {(s === "pending" || s === "rendering") && (
        <div style={{ fontSize: 13, color: D.muted, display: "flex", alignItems: "center", gap: 10 }}>
          <span style={{ width: 16, height: 16, border: `2px solid ${D.border}`, borderTopColor: "#111", borderRadius: "50%", display: "inline-block", animation: "spin 0.8s linear infinite" }} />
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
                <span style={{ flex: 1, fontSize: 12.5, color: "#111", fontWeight: 500 }}>Approved &amp; sent to the customer</span>
                <button style={btn("transparent", D.muted)} disabled={busy} onClick={regenerate}>Regenerate</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ flex: 1, fontSize: 12, color: D.amber, fontWeight: 500, minWidth: 130 }}>Approved — the text didn’t send</span>
                <button style={btn("#111", "#fff")} disabled={busy} onClick={() => act("approve")}>Retry send</button>
                <button style={btn("transparent", D.muted)} disabled={busy} onClick={regenerate}>Regenerate</button>
              </div>
            )
          ) : (
            <div style={{ display: "flex", gap: 8 }}>
              <button style={btn("#111", "#fff")} disabled={busy} onClick={() => act("approve")}>Approve &amp; send</button>
              <button style={btn("transparent", D.muted)} disabled={busy} onClick={regenerate}>Regenerate</button>
            </div>
          )}
        </>
      )}
      {s === "failed" && (
        <>
          <div style={{ fontSize: 12.5, color: D.amber, marginBottom: 10 }}>Recap render didn’t complete.{state.error ? ` (${state.error})` : ""}</div>
          <button style={btn("#111", "#fff")} disabled={busy} onClick={regenerate}>Try again</button>
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
  // Typed specialty completion (PR 4): parent-owned success-screen
  // follow-up CTA (the button only renders when provided).
  onScheduleFollowup,
  // Cross-key completion (codex P1 #3187 r8): the visit completed under a
  // DIFFERENT idempotency key (original attempt finished while this panel
  // polled), so onSubmit never resolved and the parent's normal success
  // bookkeeping (status flip, schedule cache refresh) never ran — this
  // callback is its equivalent. The mobile payment handoff cannot run here
  // (the invoice payload only travels on the same-key response), which the
  // cross-key copy tells the tech.
  onCompletedElsewhere,
  // Status-poll resolution (codex P1 #3187 r11): when the completion
  // resolves via the lightweight status route's stored response instead of
  // a resolved onSubmit, the parent runs its full success bookkeeping —
  // including the mobile payment handoff — through this callback.
  onCompletionResult,
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
  // Customer email isn't on the schedule payload (only name/phone are), so fetch
  // it for the header contact card's tap-to-email link. The same fetch surfaces
  // the account's default payer for the third-party-billing banner below.
  const [customerEmail, setCustomerEmail] = useState("");
  const [customerDefaultPayerId, setCustomerDefaultPayerId] = useState(null);
  useEffect(() => {
    let live = true;
    setCustomerEmail(""); // clear stale email before (re)fetching for a new service
    setCustomerDefaultPayerId(null);
    const cid = service.customerId || service.customer_id;
    if (!cid) return undefined;
    adminFetch(`/admin/customers/${cid}`)
      .then((d) => {
        if (!live) return;
        setCustomerEmail(d?.customer?.email || "");
        setCustomerDefaultPayerId(d?.customer?.payerId || null);
      })
      .catch(() => { if (live) setCustomerEmail(""); });
    return () => { live = false; };
  }, [service.customerId, service.customer_id]);
  // Third-party Bill-To: when this visit resolves to a payer (per-job override,
  // else the account default unless the visit is pinned to self-pay), the
  // invoice routes to the payer's AP inbox and the tech must NOT collect on
  // site (the server blocks in-person collection for payer-billed visits).
  // The banner and the self-pay UI suppression only engage for a CONFIRMED
  // live ACTIVE payer — server resolution ignores missing/inactive payers
  // (falls back to self-pay), so a stale link must not tell the tech "don't
  // collect" on a visit that will actually mint a self-pay invoice.
  // Preferred source: `service.billedToPayer`, resolved (active-checked)
  // server-side on the tech-visible schedule day payload — /admin/payers/* is
  // admin-only, so a tech can't look the payer up client-side. Payloads that
  // don't carry the field (older list shapes) fall back to the admin lookup;
  // when that fails (403/offline) nothing is suppressed — the server-side
  // guards still prevent real mis-collection either way.
  const serverBilledTo = service.billedToPayer;
  const effectivePayerId =
    service.payerId ||
    (service.selfPayOverride === true ? null : customerDefaultPayerId) ||
    null;
  const [payerBillTo, setPayerBillTo] = useState(null);
  useEffect(() => {
    let live = true;
    setPayerBillTo(null);
    if (serverBilledTo !== undefined) {
      if (serverBilledTo) {
        setPayerBillTo({ name: serverBilledTo.name || "a third-party payer" });
      }
      return undefined;
    }
    if (!effectivePayerId) return undefined;
    adminFetch(`/admin/payers/${effectivePayerId}`)
      .then((d) => {
        if (!live) return;
        const p = d?.payer;
        if (p && p.active !== false) {
          setPayerBillTo({ name: p.display_name || p.company_name || "a third-party payer" });
        }
      })
      .catch(() => { /* unconfirmed — keep self-pay UI */ });
    return () => { live = false; };
  }, [serverBilledTo, effectivePayerId]);
  const payerBanner = payerBillTo
    ? `Billed to ${payerBillTo.name} — don't collect payment on site. The invoice goes to the payer, and the customer's completion text gets no pay link.`
    : null;
  // Measured lawn sqft from the turf profile: seeds the Sq ft field (and the
  // derived Total) when a broadcast/granular lawn product is added. No
  // profile / not a lawn visit → the fields stay manual as before.
  const [lawnSqftForPrefill, setLawnSqftForPrefill] = useState(null);
  useEffect(() => {
    let live = true;
    setLawnSqftForPrefill(null);
    const cid = service.customerId || service.customer_id;
    const type = service?.serviceType || service?.service_type || "";
    if (!cid || serviceLineFromType(type) !== "lawn") return undefined;
    adminFetch(`/admin/customers/${cid}/turf-profile`)
      .then((d) => {
        if (!live) return;
        const n = Number(d?.profile?.lawn_sqft);
        setLawnSqftForPrefill(Number.isFinite(n) && n > 0 ? n : null);
      })
      .catch(() => { if (live) setLawnSqftForPrefill(null); });
    return () => { live = false; };
  }, [service.customerId, service.customer_id, service.serviceType, service.service_type]);
  const [selectedProducts, setSelectedProducts] = useState([]);
  // Treatment Zone mapper (owner 2026-07-22): the same tracer the tech portal
  // has — admin closeouts can trace where we sprayed without switching apps.
  const [zoneMapOpen, setZoneMapOpen] = useState(false);
  // Gates the pesticideOnly compliance fields (pollinator / IRAC-FRAC) in the
  // typed findings form — they appear once a pesticide-family product is on
  // the visit. Display-only: the server compliance validation is authoritative.
  // Brand-named catalog rows ("Dominion 2L") reach the client without a
  // category, and the server classifies them from catalog text we don't have —
  // so a row with NO category conservatively shows the fields rather than
  // hiding ones the server will 422 on (codex P1). Hiding requires a category
  // that is positively non-pesticide.
  // Reuses the legacy closeout's family classifiers (insect/fungicide/
  // herbicide incl. the pre-emergent brands — Snapshot, Barricade,
  // Prodiamine…) so every product the server will demand irac_frac_logged
  // for surfaces the fields here; a category-word-only test hid them for
  // brand-named pre-emergents and left the tech no way to satisfy the
  // server 400 (codex P1 r5).
  const tsPesticideFlags = treeShrubProductFlagsClient(selectedProducts);
  const pesticideProductPresent =
    tsPesticideFlags.hasInsectProduct ||
    tsPesticideFlags.hasFungicideProduct ||
    tsPesticideFlags.hasHerbicideProduct ||
    selectedProducts.some((p) => {
      const category = String(p.category || p.product_category || "");
      if (/pesticid|termitic|systemic|hort/i.test(`${p.name || ""} ${category}`)) return true;
      // "Uncategorized"/"other" style categories are non-blank but carry no
      // signal (prod has Bifen XTS filed as Uncategorized) — they must stay
      // on the conservative show-the-fields path, same as a missing category.
      return !category.trim() || /uncategor|unknown|\bother\b|\bmisc\b|n\/a/i.test(category);
    });
  const [productSearch, setProductSearch] = useState("");
  const [sendSms, setSendSms] = useState(true);
  const [includePayLink, setIncludePayLink] = useState(true);
  // Re-entry countdown steppers (owner rule 2026-08-11): tech-adjustable at
  // completion. Seeds come from the tech-accessible /reentry-defaults
  // endpoint (what a hands-off completion would persist for this service
  // type); values stay null until seeded so an untouched panel posts
  // nothing and the server's computed-default path stays byte-identical.
  // A side whose seed is 0 (no countdown concept for the line — e.g. lawn
  // interior, rodent both) renders no stepper.
  const [reentrySeeds, setReentrySeeds] = useState(null);
  const [reentryExtMinutes, setReentryExtMinutes] = useState(null);
  const [reentryIntMinutes, setReentryIntMinutes] = useState(null);
  useEffect(() => {
    let live = true;
    if (!service?.id) return undefined;
    adminFetch(`/admin/dispatch/${service.id}/reentry-defaults`)
      .then((d) => {
        if (!live) return;
        const ext = Number(d?.exteriorMinutes);
        const int_ = Number(d?.interiorMinutes);
        const seeds = {
          exteriorMinutes: Number.isFinite(ext) && ext > 0 ? Math.round(ext) : 0,
          interiorMinutes: Number.isFinite(int_) && int_ > 0 ? Math.round(int_) : 0,
        };
        setReentrySeeds(seeds);
        // Functional updates: a draft restore may have already set a value —
        // the seed must never clobber restored operator input.
        setReentryExtMinutes((cur) => (cur == null ? seeds.exteriorMinutes : cur));
        setReentryIntMinutes((cur) => (cur == null ? seeds.interiorMinutes : cur));
      })
      .catch(() => {}); // fetch failure → steppers stay hidden, server defaults apply
    return () => { live = false; };
  }, [service?.id]);
  // Dirty per side = the tech moved the stepper off its seed (or a restored
  // draft carries a moved value). Only dirty sides post — see the body build.
  const reentryExtDirty =
    reentryExtMinutes != null && reentryExtMinutes !== (reentrySeeds?.exteriorMinutes ?? null);
  const reentryIntDirty =
    reentryIntMinutes != null && reentryIntMinutes !== (reentrySeeds?.interiorMinutes ?? null);
  const stepReentryMinutes = (setter) => (delta) =>
    setter((cur) => Math.min(1440, Math.max(0, (cur ?? 0) + delta)));
  const stepReentryExt = stepReentryMinutes(setReentryExtMinutes);
  const stepReentryInt = stepReentryMinutes(setReentryIntMinutes);
  // Inspection credit — DEFAULT ON per the owner ruling: an inspection
  // carries the credit promise unless the tech clears it. The server
  // defaults it on too, so an older client that sends nothing behaves
  // identically.
  const [offerInspectionCredit, setOfferInspectionCredit] = useState(true);
  const [requestReview, setRequestReview] = useState(true);
  const [reviewTiming, setReviewTiming] = useState("120");
  const [reviewCustomAt, setReviewCustomAt] = useState("");
  const [oneTimeRecapOnly, setOneTimeRecapOnly] = useState(false);
  // Backdated closeout ("backfill") of a past-dated visit: the server records
  // the completion to the visit's scheduled day, sends NO customer messages
  // (SMS / report email / review ask), and skips the automatic charge rails.
  // Only offered when the scheduled date is before today (ET). Defaults ON at
  // ≥7 days past (stale-backlog cleanup from the dashboard card); OFF at 1–6
  // days past — a next-morning closeout of yesterday's visit is a normal
  // completion and must not silently go quiet.
  // Backfill is admin-only server-side (it suppresses comms and the charge
  // rails), and this panel is shared with technician users — so a tech must
  // never see it defaulted on, or every stale closeout 403s until they find
  // the checkbox. Same reasoning as the prepay CTA below.
  const panelIsAdmin = (() => {
    try { return JSON.parse(localStorage.getItem("waves_admin_user") || "{}")?.role === "admin"; }
    catch { return false; }
  })();
  const backfillScheduledDate = String(
    service.scheduledDate || service.scheduled_date || service.date || "",
  ).split("T")[0];
  const backfillDaysPast = /^\d{4}-\d{2}-\d{2}$/.test(backfillScheduledDate)
    ? Math.round(
        (Date.parse(etDateString()) - Date.parse(backfillScheduledDate)) /
          86400000,
      )
    : 0;
  const backfillEligible = panelIsAdmin && backfillDaysPast >= 1;
  const backfillCloseoutDefault = panelIsAdmin && backfillDaysPast >= 7;
  const [backfillCloseout, setBackfillCloseout] = useState(
    backfillCloseoutDefault,
  );
  // Operator-typed minutes for a backdated closeout. Starts EMPTY on
  // purpose: the running `elapsed` spans the whole stale gap, so backfill
  // must never inherit it — blank submits no timeOnSite and the duration
  // stays unknown (see completionTimeOnSiteBody).
  const [backfillTimeOnSite, setBackfillTimeOnSite] = useState("");
  // Admin-typed minutes overriding the running timer on a LIVE completion
  // (forgotten-closeout fix: the timer kept running, so the auto-elapsed is
  // inflated). Starts EMPTY — blank records the timer exactly as before.
  // Admin-only server-side (403 for a tech token), so like backfill the
  // input never renders for technician users.
  const [adjustedTimeOnSite, setAdjustedTimeOnSite] = useState("");
  // A backdated quiet closeout suppresses every customer send server-side —
  // the client-side flags must agree, or the success overlay and CTA
  // sub-label claim sends for a completion that texted nobody. Derived here,
  // above the recap/review state, so recap eligibility and the review
  // suppression chain can fold it in.
  const backfillQuietCloseout = backfillEligible && backfillCloseout;
  // The live override input hides while the backfill checkbox is checked —
  // that mode has its own minutes input with different blank semantics
  // (blank = unknown, not "use timer").
  const liveAdjustEligible = panelIsAdmin && !backfillQuietCloseout;
  const [visitOutcome, setVisitOutcome] = useState("completed");
  const [customerRecap, setCustomerRecap] = useState("");
  const [recapSource, setRecapSource] = useState("template");
  const [recapStaleAfterEdit, setRecapStaleAfterEdit] = useState(false);
  const [recapDraftStatus, setRecapDraftStatus] = useState("idle");
  const [recapLoading, setRecapLoading] = useState(false);
  const [recapError, setRecapError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [generating, setGenerating] = useState(false);
  // F2 (ratified Q13): windowed comms context on the AI report draft — default CHECKED.
  const [aiReportIncludeComms, setAiReportIncludeComms] = useState(true);
  const [success, setSuccess] = useState(false);
  const [completionResult, setCompletionResult] = useState(null);
  // The annual-prepay offer was REMOVED from the completion success screen
  // (owner 2026-07-29: success stays minimal — service complete + delivery
  // status only). Prepay lives in Customer 360; don't re-add a CTA here.
  const [elapsed, setElapsed] = useState("0:00");
  const [quickComplete, setQuickComplete] = useState(false);
  // Completion photos are intentionally kept out of localStorage (a handful
  // of base64 images can exceed its quota).
  const [servicePhotos, setServicePhotos] = useState([]);
  // Turf height-of-cut capture (lawn completion, behind the flag). `ready` gates
  // submit so a lawn visit can't be completed before the flag state is known —
  // otherwise a pre-load submit hides the field the server still requires (422).
  const { enabled: turfHeightFlag, ready: turfHeightFlagReady } = useFeatureFlagReady("turf-height-capture");
  // Phase 3 fast closeout — flag-gated (default off). Existing completion flow is unchanged when off.
  // Tree & Shrub exception-based closeout — UNCONDITIONAL (the per-user
  // tree-shrub-closeout-v2 flag is retired; owner ungated 2026-07-09). This
  // also closes a trap: the server's validateTreeShrubCloseout enforcement is
  // unconditional for tree_shrub/palm completions, so a tech WITHOUT the old
  // flag had no closeout UI to collect the required fields and every
  // completion hard-400'd (tree_shrub_closeout_lockout).
  const { enabled: pestRecapFlag, ready: pestRecapReady } = useFeatureFlagReady("pest-recap-v1");
  const [turfHeight, setTurfHeight] = useState({ heightIn: null, gaugePhoto: null });
  const [treeShrubCloseout, setTreeShrubCloseout] = useState(() =>
    defaultTreeShrubCloseout(service),
  );
  const [areasServiced, setAreasServiced] = useState([]);
  // Property satellite basemap (bait-station marking). The manual per-area
  // zone-mark widget this also fed was retired 2026-07-23 — the traced
  // Treatment Zone Mapper is the report's coverage-map source now.
  const [propertyMap, setPropertyMap] = useState(null);
  // The station QUERY inside /property-map failed and the server substituted
  // an empty roster (stationsLoaded false). The map still renders, so
  // without this flag the tech could pin "new" traps numbered from 1 over
  // an invisible existing registry and submit duplicate or skipped entries
  // (codex P2 round 12). While set, station marking is disabled and the
  // completion posts no station entries at all — an unloaded registry is
  // unavailable, not empty.
  // "loading" until the property-map request settles, so the surface fails
  // CLOSED for the whole in-flight window too (codex P2 round 15): a
  // billing-detour draft can restore moves, retirements, and new pins
  // before the fetch resolves, and an already-complete form submitted in
  // that window would serialize them — against a registry never confirmed
  // — using the restored zoneMapImageFallback ref. Only a settled,
  // available response with a loaded station query re-arms it.
  const [stationRegistryState, setStationRegistryState] = useState("loading");
  const stationRegistryFailed = stationRegistryState !== "ready";
  // Image params restored from a saved draft (checkout detour) — lets a
  // restored station submit stamp the drift ref for pins placed pre-detour
  // even if the live /property-map refetch hasn't resolved yet.
  const [zoneMapImageFallback, setZoneMapImageFallback] = useState(null);
  // Traced treatment-zone linear footage (Treatment Zone Mapper): prefills a
  // perimeter-spray product row's Linear ft so the tech doesn't retype the
  // footage the trace already measured. Fail-soft — no trace (or gate off)
  // just leaves the field manual.
  const [tracedLinearFt, setTracedLinearFt] = useState(null);
  const [customerInteraction, setCustomerInteraction] = useState("");
  const [customerConcern, setCustomerConcern] = useState("");

  // Bait station map (station-map-v1). Only station-typed completions
  // (termite or rodent, primary or companion) surface the station step — the
  // flag alone must not put pins on lawn/pest completions, and the visit's
  // typed flow picks the PROGRAM whose registry slice loads. Eligibility
  // reads the service prop directly so the property-map effect below can
  // depend on it.
  const { enabled: stationMapFlag } = useFeatureFlagReady("station-map-v1");
  const stationTypeSet = [
    service.completionProfile?.findingsType,
    ...(Array.isArray(service.companionSchemas)
      ? service.companionSchemas.map((s) => s?.type)
      : []),
  ];
  // This selection must be IDENTICAL to the server's
  // stationProgramForProfile, which /complete syncs against (codex r1+r2):
  // a station PRIMARY (findingsType, first entry) wins outright; among
  // COMPANIONS the tie breaks termite-first. Any divergence makes the panel
  // load/submit one program's station ids while the sync targets the other,
  // silently skipping the visit's checks.
  const stationTypeProgram = {
    termite_bait_station: "termite",
    rodent_bait_station: "rodent",
    rodent_trapping: "trapping",
  };
  const companionStationTypes = stationTypeSet.slice(1);
  const stationProgram = stationTypeProgram[stationTypeSet[0]]
    || (companionStationTypes.includes("termite_bait_station") ? "termite"
      : companionStationTypes.includes("rodent_bait_station") ? "rodent"
        : companionStationTypes.includes("rodent_trapping") ? "trapping" : null);
  const stationFeatureOn = stationMapFlag && Boolean(stationProgram);
  const [stationPreloads, setStationPreloads] = useState([]); // property's existing stations
  const [stationNew, setStationNew] = useState([]); // pins dropped this session [{ key, number, shape }]
  const [stationMoves, setStationMoves] = useState({}); // id → shape re-positioned this session
  const [stationStatuses, setStationStatuses] = useState({}); // key → status ('ok' when absent)
  const [stationRetired, setStationRetired] = useState([]); // existing ids retired this session
  const [stationNumberBase, setStationNumberBase] = useState(1); // server's next number (never reuses retired)
  const stationNewSeqRef = useRef(0);
  // Blocks completion (fail closed) while edits exist that the station-less
  // payload below would silently drop — see pendingStationEdits. Pending is
  // computed from the restored state WITHOUT stationFeatureOn: a flag
  // kill-switched (or a program change) after the draft was saved posts no
  // station entries either, and gating pending on the flag would bypass
  // the guard in exactly that state (codex P1 r17). With the flag off no
  // fetch is coming, so the block is terminal, not transient.
  const stationEditsPending = pendingStationEdits({ stationNew, stationMoves, stationStatuses, stationRetired });
  const stationEditsBlocked = stationEditsPending && (!stationFeatureOn || stationRegistryFailed);
  const stationEditsBlockTransient = stationFeatureOn && stationRegistryState === "loading";
  const discardStationEdits = () => {
    setStationNew([]);
    setStationMoves({});
    setStationStatuses({});
    setStationRetired([]);
  };
  // Latest new-pin/status state for the async /property-map resolution: a
  // restore can land while the fetch is in flight, and the effect closure
  // would reconcile the PRE-restore values (resurrecting state the restore
  // replaced). The editor is disabled for the whole in-flight window, so
  // the restore is the only writer this bridges.
  const stationEditsRef = useRef({ stationNew: [], stationStatuses: {} });
  stationEditsRef.current = { stationNew, stationStatuses };

  // Default the rodent trapping "This visit" select, into whichever slice
  // owns the rodent_trapping schema for this visit (primary findings vs. a
  // companion section) — same primary/companion split the station auto-count
  // effect uses. Only fills a BLANK field: a tech selection, or a restored
  // draft, always wins.
  const prefillTrapVisitType = (value) => {
    const fill = (values) => (
      String(values?.trap_visit_type || "").trim()
        ? values
        : { ...values, trap_visit_type: value }
    );
    if (service.completionProfile?.findingsType === "rodent_trapping") {
      setFindingsValues((prev) => fill(prev));
      return;
    }
    setCompanionState((prev) => {
      const entry = prev.rodent_trapping || EMPTY_COMPANION_ENTRY;
      const nextValues = fill(entry.values);
      if (nextValues === entry.values) return prev;
      return { ...prev, rodent_trapping: { ...entry, values: nextValues } };
    });
  };

  // Satellite basemap + the property's existing bait-station pins. The fetch
  // runs only when the station surface is on — the manual zone-mark step that
  // also consumed this payload was retired in favor of the traced Treatment
  // Zone Mapper.
  useEffect(() => {
    if (!stationFeatureOn || !service?.id) return undefined;
    let cancelled = false;
    // Re-arm fail-closed for the WHOLE in-flight window, and drop the
    // previous registry's rows before refetching. Without this a re-run
    // (the panel switching service or program, or the flag toggling back
    // on) left the surface marked "ready" with the OLD program's preloads
    // still in state, so the submit guard could serialize stale station
    // ids against the new one. `stationProgram` also has to be a dependency
    // — the effect filters by it (codex P1 on the pre-push audit).
    setStationRegistryState("loading");
    setStationPreloads([]);
    setStationNumberBase(1);
    adminFetch(`/admin/dispatch/${service.id}/property-map`)
      .then((res) => {
        if (cancelled) return;
        setPropertyMap(res || null);
        if (!res?.available) {
          // Fail CLOSED (codex P2 round 13): an unavailable response leaves
          // the registry unconfirmed, and a billing-detour draft restore
          // may already hold station edits plus a zoneMapImageFallback ref
          // that the submit path would serialize against a roster we could
          // not reload.
          setStationRegistryState("failed");
          return;
        }
        setStationRegistryState(res.stationsLoaded === false ? "failed" : "ready");
        const freshPreloads = (Array.isArray(res.stations) ? res.stations : [])
          .filter((station) => (station.program || "termite") === stationProgram)
          .map((station) => ({
            id: String(station.id),
            number: station.number,
            label: station.label || null,
            shape: station.geometryImage && station.geometryImage.type === "circle"
              ? station.geometryImage
              : null,
            stale: Boolean(station.staleMark),
          }));
        setStationPreloads(freshPreloads);
        // Draft pins restored while this fetch was in flight can collide
        // with rows another writer confirmed since the draft was saved —
        // same reconcile as the restore's ready path, via the latest-edits
        // ref (the effect closure predates the restore).
        if (res.stationsLoaded !== false) {
          const reconciled = reconcileNewPinsWithRegistry({
            ...stationEditsRef.current,
            stationPreloads: freshPreloads,
          });
          if (reconciled.changed) {
            setStationNew(reconciled.stationNew);
            setStationStatuses(reconciled.stationStatuses);
          }
        }
        setStationNumberBase(
          Number(res.nextStationNumberByProgram?.[stationProgram])
          || Number(res.nextStationNumber)
          || 1,
        );
        // Pre-select "is this a setup or a re-check?" from the property's
        // own trap registry: no trap pins on record = the traps go out
        // today. Done HERE, inside the resolved fetch, because an empty
        // preload array before it lands is indistinguishable from a
        // property with no traps. This is only a DEFAULT — the tech owns
        // the field and an untouched-by-the-map property (traps predating
        // the trap map) is exactly the case they override. Never
        // overwrites a value already on the form.
        //
        // stationsLoaded false means the station query FAILED and the empty
        // array is a fallback (the server converts that error into a
        // successful payload). Inferring "Initial setup" from it would
        // silently satisfy the required selector with the wrong value on a
        // follow-up, and freeze "the traps were newly set" into the customer
        // report (codex P2 on #3159). Leave it blank instead — the field is
        // required, so a tech pick is the worst case, and a wrong default is
        // strictly worse than one tap.
        if (stationProgram === "trapping" && res.stationsLoaded !== false) {
          const existingTraps = (Array.isArray(res.stations) ? res.stations : [])
            .filter((station) => (station.program || "termite") === "trapping").length;
          prefillTrapVisitType(existingTraps > 0 ? "Follow-up check" : "Initial setup");
        }
      })
      .catch(() => {
        if (cancelled) return;
        setPropertyMap(null);
        // Same fail-closed rule as the available:false branch above.
        setStationRegistryState("failed");
      });
    return () => { cancelled = true; };
  }, [stationFeatureOn, service?.id, stationProgram]);

  // Existing traced treatment zone for this visit — its measured linear feet
  // prefill the perimeter-spray Linear ft inputs (see addProduct /
  // applyTracedTreatmentZone, which also backfills rows added before this
  // fetch resolves). Same endpoint the Treatment Zone Mapper modal reads;
  // enabled:false (gate off) or no trace resolves to null and leaves the
  // field manual.
  useEffect(() => {
    if (!service?.id) return undefined;
    let cancelled = false;
    fetch(`${API_BASE}/tech/services/${service.id}/treatment-zone`, {
      headers: {
        Authorization: `Bearer ${localStorage.getItem("waves_admin_token")}`,
      },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (cancelled) return;
        applyTracedTreatmentZone(data?.treatmentZone || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [service?.id]);

  // Bait station display list + edit handlers (station-map-v1). Moves
  // overlay preloaded shapes; retired stations drop from display but submit
  // a retire intent; new pins get provisional numbers from the server's
  // nextStationNumber base so what the tech sees matches what persists.
  // The failed-registry NOTE only renders when something is actually at
  // stake: a live map whose station query failed, or restored draft edits a
  // rejected/unavailable refetch left unconfirmed. A property that simply
  // has no map yet fails closed silently — there is no editor and nothing
  // to submit, so an orange warning on every mapless completion is noise.
  // The note is a FAILURE message, so the in-flight window never shows it —
  // that state is transient and the editor simply stays inert until the
  // fetch settles.
  const stationRegistryNoteVisible = stationRegistryState === "failed"
    && (propertyMap?.available === true || stationPreloads.length > 0 || stationNew.length > 0
      // Restored moves/statuses/retirements block completion even when the
      // rejected refetch left no roster to display them against — the note
      // is where the discard escape hatch lives, so it must show.
      || stationEditsPending);
  const stationDisplay = stationFeatureOn
    ? [
      ...stationPreloads
        .filter((station) => !stationRetired.includes(station.id))
        .map((station) => ({
          key: station.id,
          id: station.id,
          number: station.number,
          label: station.label,
          shape: stationMoves[station.id] || station.shape,
          stale: station.stale && !stationMoves[station.id],
        })),
      ...stationNew.map((station) => ({
        key: station.key,
        id: null,
        number: station.number,
        label: null,
        shape: station.shape,
        stale: false,
      })),
    ]
    : [];
  const addStationPin = (pt) => {
    stationNewSeqRef.current += 1;
    setStationNew((prev) => {
      const base = Math.max(
        Number(stationNumberBase) || 1,
        ...prev.map((station) => (Number(station.number) || 0) + 1),
      );
      return [
        ...prev,
        {
          key: `new-${stationNewSeqRef.current}`,
          number: base,
          shape: { type: "circle", cx: pt.cx, cy: pt.cy, r: STATION_PIN_R },
        },
      ];
    });
  };
  const moveStationPin = (key, pt) => {
    const shape = { type: "circle", cx: pt.cx, cy: pt.cy, r: STATION_PIN_R };
    if (stationNew.some((station) => station.key === key)) {
      setStationNew((prev) => prev.map((station) => (station.key === key ? { ...station, shape } : station)));
    } else {
      setStationMoves((prev) => ({ ...prev, [key]: shape }));
    }
  };
  const setStationStatus = (key, status) => {
    setStationStatuses((prev) => ({ ...prev, [key]: status }));
  };
  const removeStationPin = (key) => {
    if (stationNew.some((station) => station.key === key)) {
      setStationNew((prev) => prev.filter((station) => station.key !== key));
    } else {
      setStationRetired((prev) => (prev.includes(key) ? prev : [...prev, key]));
    }
  };

  // Auto-fill the termite station counts from the map so the typed report's
  // numbers can never contradict the pins. A count field stays auto-owned
  // while it is empty or still equals the last auto-written value — the
  // moment the tech hand-edits one, autofill leaves it alone.
  const stationAutoCountsRef = useRef({});
  useEffect(() => {
    if (!stationFeatureOn) return;
    // While an AI report request is in flight, the payload snapshot must stay
    // what the model saw — a late station-registry load must not rewrite the
    // counts mid-generation (codex r3). The `generating` dep re-runs this
    // effect when the request settles, so the auto-counts still land (and the
    // tech reviews the draft against them before completing).
    if (generating) return;
    // Never auto-write counts for a property whose map was never populated —
    // the tech may be entering counts by hand for unmapped stations. Once
    // pins exist (preloaded or dropped), the counts follow the map, INCLUDING
    // down to zero when every station is retired this session: leaving the
    // pre-retire totals in place would publish counts for stations the
    // submit payload just removed.
    if (!stationPreloads.length && !stationNew.length) return;
    // Drift-hidden ("stale") pins that haven't been re-placed are excluded:
    // the report map cannot render them this visit, so counting them as
    // checked would publish typed counts the customer-visible map can't
    // show. Re-pinning (a move) brings a stale station back into the counts.
    const activeKeys = [
      ...stationPreloads
        .filter((station) => !stationRetired.includes(station.id)
          && (station.shape || stationMoves[station.id]))
        .map((station) => station.id),
      ...stationNew.map((station) => station.key),
    ];
    const statusOf = (key) => stationStatuses[key] || "ok";
    const inaccessible = activeKeys.filter((key) => statusOf(key) === "inaccessible").length;
    // Each program maps to ITS schema's count keys — never auto-write a key
    // the schema doesn't own, or submit validation rejects the unknown
    // field. Trapping owns traps_checked only: captures is a tech-judgment
    // count (one trap can hold multiple captures), and the schema has no
    // total/inaccessible keys.
    const counts = stationProgram === "trapping"
      ? { traps_checked: String(activeKeys.length - inaccessible) }
      : {
        // total_stations is termite-only since 2026-07-23: the rodent
        // schema retired it (the map's pins ARE the roster), and writing it
        // there would trip the unknown-field rejection at submit
        // (codex P1 on #2963).
        ...(stationProgram === "termite"
          ? { total_stations: String(activeKeys.length) }
          : {}),
        stations_checked: String(activeKeys.length - inaccessible),
        stations_inaccessible: String(inaccessible),
        // Only the termite schema carries a per-station activity COUNT; the
        // rodent flow records consumption as a select (tech judgment).
        ...(stationProgram === "termite"
          ? { stations_with_activity: String(activeKeys.filter((key) => statusOf(key) === "activity").length) }
          : {}),
      };
    // Snapshot the last auto-written values BEFORE scheduling the state
    // updates: the updater callbacks run after this effect finishes, so
    // reading the ref inside them would see the values we're about to
    // write below and misread every auto-owned field as hand-edited.
    const lastAuto = { ...stationAutoCountsRef.current };
    // Auto-written counts that CHANGE after a report was installed are typed
    // edits too — a deferred registry write or mid-generation pin edit lands
    // here, bypassing the mutation handlers, and must invalidate an
    // untouched draft the same way (codex r24). Unchanged re-runs (e.g. the
    // generating->false re-fire) never clear a fresh draft.
    const autoCountsChanged = Object.entries(counts)
      .some(([key, value]) => String(lastAuto[key] ?? '') !== String(value));
    if (autoCountsChanged) invalidateGeneratedReportOnTypedEdit();
    const applyCounts = (values) => {
      let changed = false;
      const next = { ...values };
      for (const [key, value] of Object.entries(counts)) {
        const current = next[key];
        const autoOwned = current == null || current === "" || String(current) === String(lastAuto[key]);
        if (autoOwned && String(current ?? "") !== value) {
          next[key] = value;
          changed = true;
        }
      }
      return changed ? next : values;
    };
    const stationTypedFlow = stationProgram === "trapping" ? "rodent_trapping"
      : stationProgram === "rodent" ? "rodent_bait_station" : "termite_bait_station";
    if (service.completionProfile?.findingsType === stationTypedFlow) {
      setFindingsValues((prev) => applyCounts(prev));
    } else {
      setCompanionState((prev) => {
        const entry = prev[stationTypedFlow] || EMPTY_COMPANION_ENTRY;
        const nextValues = applyCounts(entry.values);
        if (nextValues === entry.values) return prev;
        return { ...prev, [stationTypedFlow]: { ...entry, values: nextValues } };
      });
    }
    stationAutoCountsRef.current = counts;
  }, [stationFeatureOn, stationProgram, stationPreloads, stationNew, stationMoves, stationStatuses, stationRetired, generating]);
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
  // The trapping section — primary OR companion, `trap_visit_type` can
  // live in either — declares this visit as the initial trap setup. ONE
  // source for the serviced-pin rules: the handleSubmit mirror of the
  // server's rejection, and the editor hiding the "Serviced" chip so the
  // conflict can't be created by tap in the first place (codex P2 r18).
  const declaresTrapSetup = [
    findingsValues,
    ...companionSchemas.map(
      (schema) => (companionState[schema.type] || EMPTY_COMPANION_ENTRY).values,
    ),
  ].some(
    (values) => String(values?.trap_visit_type ?? "").trim() === "Initial setup",
  );
  const [typedActivityScore, setTypedActivityScore] = useState(null);
  // Pin semantics (contract §4): while untouched, the score recomputes from
  // deriveScores[values[deriveField]]; the FIRST tap on the picker pins
  // technician-set — even on the same value.
  const [typedActivityTouched, setTypedActivityTouched] = useState(false);
  const [typedNextStepChips, setTypedNextStepChips] = useState([]);
  const [typedRecommendations, setTypedRecommendations] = useState("");
  const [typedRecommendationsEdited, setTypedRecommendationsEdited] =
    useState(false);
  // True once a unified Generate AI report result was installed into the
  // notes — persisted at completion as ai_draft_used (adoption telemetry,
  // specialty completion contract).
  const [aiReportUsed, setAiReportUsed] = useState(false);
  // The exact text applyGeneratedReport installed — while the notes still
  // equal it (untouched draft), a typed-findings edit clears the draft so
  // stale AI prose can't publish beside contradicting structured findings
  // (codex r23). An edited draft is the tech's reviewed copy and is theirs.
  const generatedReportTextRef = useRef(null);
  const [generatedReportCleared, setGeneratedReportCleared] = useState(false);
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
  const [treatmentPlanBlocks, setTreatmentPlanBlocks] = useState([]);
  // Calibration state of the plan's auto-selected rig — advisory-only since
  // the closeout no longer has an equipment step (missing/expired/unverified
  // must still be VISIBLE, or the server would record an advisory the tech
  // never saw).
  const [treatmentPlanCalibrationBlocks, setTreatmentPlanCalibrationBlocks] =
    useState([]);
  // Ordinance restriction windows active on THIS service date (evaluated
  // server-side against the property's real municipality rules) — drives the
  // off-plan N/P advisory below.
  const [treatmentPlanOrdinanceWindows, setTreatmentPlanOrdinanceWindows] =
    useState([]);
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
  // Pending until the plan request settles — WaveGuard lawn completion waits
  // on it so a fast/restored closeout can never POST before the compliance
  // advisories had a chance to render.
  const [treatmentPlanLoading, setTreatmentPlanLoading] = useState(false);
  const [protocolActions, setProtocolActions] = useState([]);
  const [protocolActionMeta, setProtocolActionMeta] = useState(null);
  const [protocolActionError, setProtocolActionError] = useState("");
  const [protocolActionsLoading, setProtocolActionsLoading] = useState(false);
  // True only after a SUCCESSFUL load — an empty filtered result is a real
  // "no product-backed actions" answer, distinct from unloaded/failed.
  const [protocolActionsLoaded, setProtocolActionsLoaded] = useState(false);
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
  // Free-text observations/recommendations (owner 2026-07-30): the preset
  // dropdowns are gone — the tech types what they saw / what's next, only
  // when there's something to say. One entry per line; submitted as the
  // same observations/recommendations arrays the server already reads.
  // The selected-label arrays above stay only so restored older drafts
  // keep their chip selections.
  const [observationsText, setObservationsText] = useState("");
  const [recommendationsText, setRecommendationsText] = useState("");
  // Flips true once Generate AI report replaces the notes with clean prose.
  // Before that, the [Protocol]/[Found]/[Next] chip lines in the notes are the
  // selection source of truth (delete a line = deselect); after, the label
  // arrays are authoritative and selections render as removable pills instead
  // of tagged lines inside the report text. Persisted with the draft.
  const [chipLinesDetached, setChipLinesDetached] = useState(false);
  const [protocolCarrierGalPer1000, setProtocolCarrierGalPer1000] =
    useState("");
  const [treatmentPlanMixItems, setTreatmentPlanMixItems] = useState([]);
  const [treatmentPlanProductIds, setTreatmentPlanProductIds] = useState([]);
  const [treatmentPlanPlannedProductIds, setTreatmentPlanPlannedProductIds] =
    useState([]);
  const [lawnAssessmentId, setLawnAssessmentId] = useState(null);
  // False while the assessment block is still looking up the visit's existing
  // assessment — the AI-report payload omits lawnAssessmentId until then so a
  // pre-load null is never misread as "retake pending".
  const [lawnAssessmentReady, setLawnAssessmentReady] = useState(false);
  const [lawnAssessmentRevision, setLawnAssessmentRevision] = useState(0);
  const [savedDraft, setSavedDraft] = useState(null);
  const [showDraftPrompt, setShowDraftPrompt] = useState(false);
  // Tree & Shrub AI photo review. Runs silently in the background (owner
  // 2026-07-23: no closeout card, no tech review step) — treeShrubReview holds
  // the signed preview { scores, observations, findings } so the submit body
  // can carry it and the server persists the scores without a second vision
  // pass. Absent (still analyzing / preview failed) → the server auto-scores
  // at completion and the report finalizes on its own.
  const [treeShrubReview, setTreeShrubReview] = useState(null);
  const treeShrubScoredKeyRef = useRef("");
  const photoInputRef = useRef(null);
  const recapRequestRef = useRef(0);
  const recapAbortRef = useRef(null);
  const draftSnapshotRef = useRef(null);
  const completionIdempotencyKeyRef = useRef(null);
  // Consecutive completion_side_effects_running retries in the current
  // submit chain — see SIDE_EFFECTS_RETRY_MS for the contract.
  const sideEffectsRetryRef = useRef(0);
  // The exact body of the submit that COMMITTED (first side-effects 409):
  // a rebuild stamps fresh volatile fields (station reference capturedAt)
  // and the committed-attempt matcher would 409
  // completion_resume_payload_mismatch instead of resuming (codex P1 #3187
  // r3). The committed flag — not the body ref — gates the replay, and it
  // survives give-up so the instructed MANUAL retry also replays the
  // committed body, not a fresh rebuild (codex P1 r5); a non-committed
  // failure leaves the flag false and the next submit sends fresh state.
  const lastSubmitBodyRef = useRef(null);
  // Initialized from the DURABLE marker: a panel reopened on a marker-owed
  // visit is mid-committed-chain even though the in-memory refs died with
  // the previous mount — without this, the reopened panel's fresh key gets
  // service_already_completed once the original attempt finishes and the
  // cross-key branch would reject it as a generic failure, leaving the
  // marker and visit repeatedly reopenable (codex P1 #3187 r9). The BODY
  // snapshot deliberately does not persist (photos are in-memory Files);
  // a reopened resume of a still-stranded attempt lands on the existing
  // completion_resume_payload_mismatch handler → Billing Recovery.
  const sideEffectsCommittedRef = useRef(completionResumeOwed(service?.id));
  // Unmount ends the quiet poll: without this, closing the panel mid-delay
  // let the stale timer re-invoke handleSubmit, whose alerts and
  // onClose(true) could then close a DIFFERENT visit the user had opened
  // meanwhile (codex P2 #3187 r7).
  const sideEffectsPollTimerRef = useRef(null);
  const completionPanelClosedRef = useRef(false);
  useEffect(() => () => {
    completionPanelClosedRef.current = true;
    window.clearTimeout(sideEffectsPollTimerRef.current);
  }, []);
  const draftReadyRef = useRef(false);

  // Typed jobs use the findings form — lawn/WaveGuard closeout sections
  // (soil readings, treatment plan/calibration, tank cleanout) never apply.
  const isLawn =
    !isTypedFindings && detectServiceCategory(service.serviceType) === "lawn";
  // The tracer's capture mode follows the SERVER's eligibility variant
  // when the feed carries one (codex P2 r3): typed lawn visits
  // (aeration/fungicide/insect control) set isTypedFindings, which forces
  // isLawn false — without this, their newly enabled mapper would run the
  // building-perimeter workflow and store a spray barrier the report then
  // renders as a treated-lawn outline. Absent variant (gate off, other
  // feeds) keeps the isLawn heuristic.
  // Mosquito traces the treated YARD — turf + landscape beds — with the
  // outline workflow, saved as captureMode 'yard' (owner 2026-08-11: the
  // mosquito report gets the lawn-style overlay with the bedding included).
  // The feed's captionKey is authoritative when present (codex P2 on
  // #3354): an ineligible primary rescued by a mosquito ADD-ON carries
  // 'yardCoverage' from the winning satellite line, which the primary's
  // display name cannot reveal. Absent captionKey (gate off, older
  // payloads) keeps the category heuristic.
  const isMosquitoTrace = service.traceCaptionKey
    ? service.traceCaptionKey === "yardCoverage"
    : detectServiceCategory(service.serviceType) === "mosquito";
  const traceOutlineMode = service.traceVariant
    ? service.traceVariant === "outline"
    : isLawn || isMosquitoTrace;
  // Lawn visits replace the Service Photos uploader with the turf photos from
  // the Lawn Assessment block — but only for a PURE lawn visit. A combined
  // visit (e.g. lawn + Tree & Shrub) carries a companion findings schema whose
  // compliance gate still requires its own completion photos (T&S needs >=2),
  // so keep the uploader whenever any companion is present.
  const hideServicePhotos = isLawn && companionSchemas.length === 0;
  const serviceTypeForArea = service?.serviceType || service?.service_type || "";
  const calibrationRequired = isLawn && !!service.waveguardTier;
  // Advisory inventory posture is member-tier only — mirrors the server's
  // isWaveGuardLawnCompletion. A One-Time/Commercial lawn visit still gets
  // the hard inventory gate client-side, because the server passes
  // allowNegative: false for it and would 400 the closeout with the original
  // inventory lockout (codex P2 r3 on #3179).
  const inventoryAdvisoryTier = ["Bronze", "Silver", "Gold", "Platinum"].includes(
    service?.waveguardTier,
  );
  const currentAdminUser = (() => {
    try {
      return JSON.parse(localStorage.getItem("waves_admin_user") || "null");
    } catch {
      return null;
    }
  })();
  const canApproveOfficeExceptions = currentAdminUser?.role === "admin";
  const serviceCategory = detectServiceCategory(service.serviceType);
  // Bed bug closeouts get interior-specific treated-area chips, skip the
  // satellite spray-trace (a perimeter trace has no meaning for an interior
  // treatment), and hide the no-invoice recap — owner 2026-07-31, bed-bug
  // untype lane. The STABLE profile key is authoritative (display labels
  // are admin-editable); the name regex is only a fallback for rows whose
  // profile did not resolve (codex P2 r8).
  // Inspection closeouts carry the credit promise — the toggle only renders
  // for them AND only when the server says the lane is live, so a dark gate
  // never shows the tech a promise that will be silently dropped. The
  // server independently re-checks the category too, so a crafted payload
  // can't promise a credit on a treatment visit.
  // Category OR the typed-family inspection keys: rodent_inspection and
  // termite_inspection's typed profiles carry their family category, not
  // 'inspection' — mirrors the server's isCreditableInspectionProfile
  // (Codex #3178 r24 P0, r30 P2); the server still re-checks independently.
  const isInspectionVisit = (service.completionProfile?.category === "inspection"
    || service.completionProfile?.serviceKey === "rodent_inspection"
    || service.completionProfile?.serviceKey === "termite_inspection")
    && service.inspectionCreditAvailable === true;
  const isBedBugVisit = service.completionProfile?.serviceKey === "bed_bug_treatment"
    || /\bbed\s*bugs?\b/.test(String(service.serviceType || "").toLowerCase());
  // Rodent trapping skips the spray tracer for the same reason bed bug does:
  // nothing is sprayed on a trapping stop, so "Trace where we sprayed" has
  // nothing to trace and a spray outline on the report would be a claim the
  // visit can't support (owner 2026-08-02). The trap map below owns this
  // visit's spatial story. PRIMARY flow only — a trapping COMPANION riding a
  // pest visit keeps the tracer, because that visit really did spray.
  const isRodentTrappingVisit =
    service.completionProfile?.findingsType === "rodent_trapping";
  const serviceLineForCloseout = serviceLineFromType(serviceTypeForArea);
  // Tree & shrub / palm visits swap the Targets picker suggestions to the
  // ornamental pest list (see targetPickerConfig).
  const isTreeShrub =
    !isTypedFindings && ["tree_shrub", "palm"].includes(serviceLineForCloseout);
  // Under a backdated quiet closeout the server never enqueues the recap
  // render and recap delivery refuses the send — so hide the capture/approve
  // cards and let the success overlay auto-close instead of holding it open
  // for a recap that will never exist.
  const recapEligible =
    pestRecapFlag &&
    pestRecapReady &&
    serviceLineForCloseout === "pest" &&
    !backfillQuietCloseout;
  const treeShrubCloseoutOn = serviceLineForCloseout === "tree_shrub";
  // Areas-treated chips are structural-pest rooms/zones. They describe
  // neither plant work (T&S — the Treatment Zone trace records where the
  // visit treated; owner 2026-07-23), nor rodent visits (the typed forms
  // carry their own location semantics — trap activity locations, entry
  // points, sanitation areas, the station map; owner 2026-07-23), nor bed
  // bug treatments (an interior service whose typed form records the rooms
  // treated directly — the chip list doesn't even offer a bedroom; owner
  // 2026-07-23). Keyed on the completion profile's TYPED FINDINGS TYPE,
  // not the name-derived service line: a pest-primary bundle like
  // "Pest & Rodent Control" classifies as the rodent LINE by name while
  // its completion is a generic pest form (rodent work is a companion),
  // and hiding areas there would lose where the pest treatment went
  // (codex P2 r2 on #2963). The stale-draft clearing effect below keys
  // off the same flag so hidden state can't ride a restored draft into
  // the submit.
  const areasTreatedHidden = treeShrubCloseoutOn
    || [
      "rodent_trapping", "rodent_exclusion", "rodent_sanitation",
      "rodent_inspection", "rodent_bait_station", "bed_bug",
    ].includes(service.completionProfile?.findingsType);

  // Auto-run the AI photo review once enough closeout photos are captured. The
  // dual-vision scoring lives server-side (no persistence); the result rides the
  // submit body silently. Keyed by a photo FINGERPRINT (not just count) so swapping
  // a photo for another at the same count still re-runs. Fully guarded — on failure
  // the server's auto-score at completion still backstops.
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
    // adminFetch resolves to the parsed JSON (and throws on non-2xx) — consume it
    // directly; do NOT treat the result as a Response.
    adminFetch(`/admin/dispatch/${service.id}/tree-shrub/assess-preview`, {
      method: "POST",
      body: JSON.stringify({ photos: photos.map((p) => ({ data: p.data })) }),
    })
      .then((result) => {
        if (cancelled) return;
        if (result && result.scores) {
          setTreeShrubReview({ ...result, _fingerprint: fingerprint });
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [treeShrubCloseoutOn, servicePhotos, service.id]);
  // Lines that dropped the Areas-treated picker (T&S 2026-07-23, rodent
  // 2026-07-23) — a draft saved BEFORE the change can still restore stale
  // room/zone chips into hidden state, where the tech can't see or clear
  // them and the submit/recap/report paths would still consume them (codex
  // P3 on #2950). Clear the state whenever it appears so every consumer
  // sees empty. The same applies to each restored product's
  // applicationArea: with the chips gone the per-product area selector
  // never renders (it requires areasServiced.length), so a stale
  // 'Kitchen'-style value would submit invisibly from p.applicationArea
  // (codex P3 r2 on #2950).
  useEffect(() => {
    if (!areasTreatedHidden) return;
    if (areasServiced.length) setAreasServiced([]);
    setSelectedProducts((prev) => (
      prev.some((p) => p && p.applicationArea)
        ? prev.map((p) => (p && p.applicationArea ? { ...p, applicationArea: "" } : p))
        : prev
    ));
  }, [areasTreatedHidden, areasServiced, selectedProducts]);
  const treeShrubCloseoutRequired =
    !isTypedFindings &&
    ["tree_shrub", "palm"].includes(serviceLineForCloseout);
  const handleLawnAssessmentConfirmed = (assessmentId) => {
    setLawnAssessmentId(assessmentId || null);
    setLawnAssessmentRevision((v) => v + 1);
  };
  // Real treated areas only — the generic status chips ("No issues found" /
  // "Follow-up recommended") were dropped everywhere (owner 2026-07-30):
  // they aren't areas and don't belong in the treated-areas list.
  const areaOptions = [
    ...(isBedBugVisit
      ? AREAS_BY_SERVICE.bed_bug
      : (AREAS_BY_SERVICE[serviceCategory] || AREAS_BY_SERVICE.pest)),
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
  // Typed one-time completions bill by PROFILE: since the billing pre-gate
  // removal (2026-07-27) the server mints the completion invoice at the row
  // price for a billingType 'one_time' profile even without the scheduler
  // flag or a tier. Mirror that conjunction here (row-priced, performed,
  // non-callback, not an included follow-up) so the SMS preview, pay-link
  // toggle, and review controls show the completion the server actually
  // performs.
  const typedOneTimeBilling =
    String(service.completionProfile?.billingType || "").toLowerCase() ===
      "one_time" &&
    service.followupIncluded !== true &&
    hasVisitPrice &&
    !isCallback &&
    visitOutcome !== "inspection_only" &&
    visitOutcome !== "customer_declined";
  const willInvoice =
    !oneTimeRecapOnly &&
    !reportOnlyCompletion &&
    (!!service.createInvoiceOnComplete ||
      !!service.waveguardTier ||
      typedOneTimeBilling) &&
    invoiceAmount > 0;
  // A pay link is only inserted when an invoice will be created AND the
  // operator hasn't opted to send the report on its own (e.g. paid in person).
  // Payer-billed visits never text the homeowner a pay link (the server
  // suppresses it — the invoice routes to the payer's AP inbox), so the
  // toggle is hidden and the preview drops the marker. Keyed on the
  // CONFIRMED-active payer (payerBanner), matching server resolution — an
  // inactive/stale link resolves self-pay and keeps the normal pay-link UI.
  const willSendPayLink = willInvoice && includePayLink && !payerBanner;
  const completionSmsTemplateName = willSendPayLink
    ? "Service Complete + Invoice"
    : "Service Complete";
  const isIncompleteVisit = visitOutcome === "incomplete";
  // Backfill rides the suppression chain (reason "backfill"): willReview goes
  // false while the backdate checkbox is active, so the review checkbox shows
  // "Review request suppressed", the timing selector hides, and the
  // custom-review-time validation cannot block a submit whose review the
  // server forces off anyway.
  const reviewSuppressionReason = completionReviewSuppressionReason({
    isIncompleteVisit,
    backfillQuietCloseout,
    visitOutcome,
    customerConcernInteraction:
      isCustomerConcernInteraction(customerInteraction),
  });
  const willReview = completionWillReview({
    oneTimeRecapOnly,
    requestReview,
    reviewSuppressionReason,
  });
  const effectiveSendSms =
    !isIncompleteVisit && !backfillQuietCloseout && (oneTimeRecapOnly || sendSms);
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
  // Recap auto-drafting is disabled: the customer-facing report summary is now
  // generated server-side from the technician notes at completion. There's no
  // recap editor/preview to review a client draft, and drafting here would burn
  // a second LLM call for hidden state. Kept as a const so dependent effects/deps
  // stay inert.
  const canAutoDraftRecap = false;
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
  // Protocol checklist / default-product disposition were removed with the
  // read-only protocol redesign — they no longer gate completion.
  const selectedProductsMissingActualAmount = selectedProducts.filter(
    (product) =>
      !product.totalAmount ||
      Number(product.totalAmount) <= 0 ||
      !product.amountUnit,
  );
  // The protocol is now a read-only reference (mixing ratios), so the checklist
  // and default-product-disposition no longer gate completion. Real safeguards
  // stay: a WaveGuard lawn completion must record at least one applied product
  // (an empty list would write a protocol completion with no actuals or
  // inventory deductions) and every applied product needs actual amounts.
  // Inventory shortfalls no longer gate MEMBER-tier closeouts (owner
  // directive 2026-08-03): the plan banner still shows them, and the server
  // records them as an advisory and lets stock go negative. Non-member lawn
  // tiers keep the full gate — the server hard-fails their deductions.
  // Inactive products stay a hard gate for EVERY tier: the completion route
  // rejects them product-by-product regardless of the advisory posture, so
  // letting the submit through would trap the tech on a closeout error
  // (codex P2 r4 on #3179).
  const treatmentPlanGatingInventoryBlocks = inventoryAdvisoryTier
    ? treatmentPlanInventoryBlocks.filter(
        (block) => block?.code === "inventory_product_inactive",
      )
    : treatmentPlanInventoryBlocks;
  const protocolActualsCompletionBlocked =
    calibrationRequired &&
    !isIncompleteVisit &&
    (selectedProducts.length === 0 ||
      selectedProductsMissingActualAmount.length > 0 ||
      treatmentPlanGatingInventoryBlocks.length > 0);
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
      message: `${product.name || "Selected product"} is conditional on the WaveGuard protocol card and was not in the generated mix — double-check the fit before applying.`,
    })),
    ...highRateSelectedProducts.map((product) => ({
      code: "high_rate_application",
      message: `${product.name || "Selected product"} rate ${product.rate} ${product.rateUnit || ""}/1k exceeds label max ${product.maxLabelRatePer1000} ${product.catalogRateUnit || ""}/1k.`,
    })),
    ...labelUnitReviewProducts.map((product) => ({
      code: "label_rate_unit_review",
      message: `${product.name || "Selected product"} rate unit ${product.rateUnit || "unknown"} does not match label unit ${product.catalogRateUnit || "unknown"} — double-check the rate math before applying.`,
    })),
  ];
  const managerApprovalRequired =
    calibrationRequired &&
    !isIncompleteVisit &&
    managerApprovalBlocks.length > 0;
  const managerApprovalHelpText = managerApprovalBlocks
    .map((block) => block.message)
    .filter(Boolean)
    .join(" ");
  // Off-plan N/P check the plan can't see: the property-gate blocks cover
  // PLANNED products only, so a tech-added fertilizer would otherwise reach
  // completion without any blackout warning. The restriction windows come
  // from the plan payload — evaluated server-side against the property's
  // real municipality ordinances for this service date (no client month
  // math, no timezone handling). Advisory only; the server still records
  // the authoritative condition on the completion.
  // Per-nutrient suppression, not all-or-nothing: a plan already blocked for
  // nitrogen must still warn about an off-plan PHOSPHORUS product the tech
  // swapped in (the plan block only speaks for the nutrient it names).
  const planBlackoutNutrients = new Set(
    blackoutBlocks
      .map((block) =>
        block?.code === "nitrogen_blackout"
          ? "n"
          : block?.code === "phosphorus_blackout"
            ? "p"
            : null,
      )
      .filter(Boolean),
  );
  const offPlanNpAdvisories =
    calibrationRequired && !isIncompleteVisit
      ? treatmentPlanOrdinanceWindows.flatMap((window) => {
          // One line per NUTRIENT so a both-restricted window never claims a
          // nitrogen-only product also contains phosphorus.
          const lines = [];
          for (const [flagKey, short, nutrient, analysisField] of [
            ["restrictedNitrogen", "n", "nitrogen", "analysis_n"],
            ["restrictedPhosphorus", "p", "phosphorus", "analysis_p"],
          ]) {
            if (!window?.[flagKey] || planBlackoutNutrients.has(short))
              continue;
            const names = [
              ...new Set(
                selectedProducts
                  .map((sp) =>
                    (products || []).find(
                      (p) => String(p.id) === String(sp.productId),
                    ),
                  )
                  .filter((row) => Number(row?.[analysisField] || 0) > 0)
                  .map((row) => row.name)
                  .filter(Boolean),
              ),
            ];
            if (names.length) {
              lines.push(
                `${window.jurisdictionName || "The local ordinance"} restricts ${nutrient} during this visit window — ${names.join(", ")} contains ${nutrient}; completion records this.`,
              );
            }
          }
          return lines;
        })
      : [];
  // Non-blocking closeout advisories (owner directive 2026-07-29): the old
  // office/N-budget/manager approval ceremonies are gone — each condition is
  // one quiet line the tech can read and move past. The server records the
  // same conditions on the completion for the audit trail.
  const closeoutAdvisories = [
    ...(blackoutApprovalRequired ? [blackoutHelpText] : []),
    ...offPlanNpAdvisories,
    ...(nLimitApprovalRequired
      ? [[nLimitHelpText, nLimitSummaryText].filter(Boolean).join(" ")]
      : []),
    ...(managerApprovalRequired && managerApprovalHelpText
      ? [softenApprovalWording(managerApprovalHelpText)]
      : []),
    ...(calibrationRequired && !isIncompleteVisit
      ? treatmentPlanCalibrationBlocks
          .map((block) => block?.message)
          .filter(Boolean)
      : []),
    // A failed plan fetch means the compliance advisories above CANNOT be
    // computed — say so instead of rendering an empty (falsely clean) list.
    ...(calibrationRequired && !isIncompleteVisit && treatmentPlanError
      ? [
          `WaveGuard plan unavailable (${treatmentPlanError}) — blackout/N-budget/protocol advisories can't be shown for this visit.`,
        ]
      : []),
  ];
  // WaveGuard lawn completion waits for the plan request to settle so a fast
  // or restored closeout can never POST before the advisories had a chance to
  // render (the server records conditions now instead of rejecting them).
  const closeoutAdvisoriesPending =
    calibrationRequired &&
    !isIncompleteVisit &&
    (treatmentPlanLoading || (isLawn && protocolActionsLoading));
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
    : closeoutAdvisoriesPending
      ? "Loading plan…"
    : protocolActualsCompletionBlocked
      ? !selectedProducts.length
        ? "Products Applied Required"
        : selectedProductsMissingActualAmount.length
          ? "Product Actuals Required"
          : "Inventory Blocked"
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
    setProtocolActionsLoaded(false);
    adminFetch(`/admin/protocols/completion-actions?${params.toString()}`)
      .then((data) => {
        if (cancelled) return;
        const rows = Array.isArray(data.actions) ? data.actions : [];
        // Lawn closeouts list only product-backed applications — the
        // scout/task/expectation rows (chinch re-check, irrigation audit,
        // soil sample) are protocol-reference material, not 30-second
        // closeout material (owner directive 2026-07-29). The Protocols
        // tab keeps the full row set.
        setProtocolActions(isLawn ? rows.filter((a) => a?.product?.id) : rows);
        setProtocolActionMeta(data || null);
        setProtocolActionsLoaded(true);
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
    setTreatmentPlanError("");
    setTreatmentPlanLoading(true);
    // No equipment/calibration selection in the closeout any more (owner
    // directive 2026-07-29) — the plan endpoint auto-selects the assigned
    // rig server-side when one exists.
    adminFetch(`/admin/treatment-plans/${service.id}`)
      .then((data) => {
        if (cancelled) return;
        const blocks =
          data?.plan?.propertyGate?.blocks ||
          data?.plan?.protocol?.blocked ||
          [];
        setTreatmentPlanBlocks(Array.isArray(blocks) ? blocks : []);
        setTreatmentPlanCalibrationBlocks(
          (Array.isArray(data?.plan?.equipmentCalibration?.blocks)
            ? data.plan.equipmentCalibration.blocks
            : []
          ).filter((block) => CALIBRATION_ADVISORY_CODES.has(block?.code)),
        );
        setTreatmentPlanOrdinanceWindows(
          Array.isArray(data?.plan?.propertyGate?.activeOrdinanceWindows)
            ? data.plan.propertyGate.activeOrdinanceWindows
            : [],
        );
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
        // The carrier feeds the read-only mix box; it tracks every plan
        // fetch (the plan endpoint picks the rig server-side).
        setProtocolCarrierGalPer1000(
          data?.plan?.mixCalculator?.carrierGalPer1000
            ? String(data.plan.mixCalculator.carrierGalPer1000)
            : "",
        );
        const baseItems = data?.plan?.protocol?.base || [];
        const conditionalItems = data?.plan?.protocol?.conditional || [];
        const mixItems = data?.plan?.mixCalculator?.items || [];
        setTreatmentPlanMixItems(mixItems);
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
      })
      .finally(() => {
        if (!cancelled) setTreatmentPlanLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [calibrationRequired, service.id, lawnAssessmentRevision]);

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
      observationsText.trim() ||
      recommendationsText.trim() ||
      nextVisitNote.trim() ||
      oneTimeRecapOnly ||
      reviewTiming !== "120" ||
      reviewCustomAt.trim() ||
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
      completionPreferencesNeedDraft({
        sendSms,
        includePayLink,
        requestReview,
        clientPestRating,
        backfillCloseout,
        backfillCloseoutDefault,
        backfillTimeOnSite,
        adjustedTimeOnSite,
        offerInspectionCredit,
        reentryExteriorDirty: reentryExtDirty,
        reentryInteriorDirty: reentryIntDirty,
      }) ||
      visitOutcome !== "completed";
    if (!hasDraftContent) {
      // A field can return to its default after an earlier debounced write.
      // Remove both copies so a billing 409 cannot flush stale preferences.
      // Only remove storage when this mounted panel created the snapshot:
      // during draft discovery, state updates for the restore prompt have not
      // rendered yet and the form still appears empty here.
      if (draftSnapshotRef.current) {
        localStorage.removeItem(completionDraftKey(service.id));
      }
      draftSnapshotRef.current = null;
      return;
    }

    const draft = {
        serviceId: service.id,
        savedAt: new Date().toISOString(),
        notes,
        selectedProducts,
        sendSms,
        includePayLink,
        requestReview,
        clientPestRating,
        reviewTiming,
        reviewCustomAt,
        oneTimeRecapOnly,
        // The inspection-credit opt-out survives the detour too — a cleared
        // box restoring to the default-ON state would promise a credit the
        // tech explicitly declined (Codex #3178 r25 P2).
        offerInspectionCredit,
        // Backdated-closeout choices: the checked box is what keeps this
        // submit QUIET (no sends, no collection rails) and the typed minutes
        // are operator input — both must survive the billing-409 detour and
        // any panel reload, or the restored submit silently turns LOUD.
        backfillCloseout,
        backfillTimeOnSite,
        // Live-override minutes are operator input the same way: losing
        // them across a reload records the inflated timer instead.
        adjustedTimeOnSite,
        // Moved re-entry steppers ride along (dirty sides only — an
        // untouched side restores to the live seed, not a stale copy).
        ...(reentryExtDirty ? { reentryExteriorMinutes: reentryExtMinutes } : {}),
        ...(reentryIntDirty ? { reentryInteriorMinutes: reentryIntMinutes } : {}),
        visitOutcome,
        customerRecap,
        recapSource,
        areasServiced,
        // The satellite image params the station pins were placed against
        // ride along (center/zoom/size only — never the live-display-only
        // image URL), so a restored draft can submit with the CORRECT drift
        // ref even before the /property-map refetch resolves.
        zoneMapImage: propertyMap?.available && propertyMap.image
          ? {
            center: propertyMap.image.center || null,
            zoom: propertyMap.image.zoom,
            width: propertyMap.image.width || 640,
            height: propertyMap.image.height || 340,
          }
          : null,
        // Bait station edits survive the billing-409 checkout detour like
        // zone marks (statuses/pins are this visit's data — losing them
        // behind a payment detour would silently publish a wrong map).
        // Preloads ride along too: the submit payload iterates them, so a
        // restore that submits BEFORE the /property-map refetch resolves
        // would otherwise drop every existing-station status/move/retire
        // while still sending the new pins.
        stationNew,
        stationMoves,
        stationStatuses,
        stationRetired,
        stationPreloads,
        stationNumberBase,
        customerInteraction,
        customerConcern,
        selectedProtocolActionLabels,
        actionScopeByLabel,
        selectedObservationLabels,
        selectedRecommendationLabels,
        observationsText,
        recommendationsText,
        // Which deselect model the label arrays were saved under — a restored
        // post-AI-draft (no chip lines in notes) must restore as detached or
        // labelsStillInNotes would silently drop every structured selection.
        chipLinesDetached,
        // AI-usage telemetry must survive the supported draft-resume flows
        // (billing-409 detour, reload) or the resumed completion records
        // aiDraftUsed: false for an AI-installed report (codex r17).
        aiReportUsed,
        // The installed-report identity restores too, so an UNTOUCHED
        // restored draft stays invalidatable on later typed edits (codex r24).
        generatedReportText: generatedReportTextRef.current,
        nextVisitNote,
        showNextVisitNote,
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
    clientPestRating,
    reviewTiming,
    reviewCustomAt,
    oneTimeRecapOnly,
    offerInspectionCredit,
    backfillCloseout,
    backfillTimeOnSite,
    adjustedTimeOnSite,
    // Moved re-entry steppers are operator input (codex P1 #3360 r2): the
    // effect must rerun on a stepper-only change or the draft never saves
    // it. Dirty flags ride along so a seed arriving late (flipping dirty
    // false without changing the value) also re-evaluates hasDraftContent.
    reentryExtMinutes,
    reentryIntMinutes,
    reentryExtDirty,
    reentryIntDirty,
    visitOutcome,
    customerRecap,
    recapSource,
    areasServiced,
    stationNew,
    stationMoves,
    stationStatuses,
    stationRetired,
    stationPreloads,
    stationNumberBase,
    customerInteraction,
    customerConcern,
    selectedProtocolActionLabels,
    actionScopeByLabel,
    selectedObservationLabels,
    selectedRecommendationLabels,
    observationsText,
    recommendationsText,
    chipLinesDetached,
    aiReportUsed,
    nextVisitNote,
    showNextVisitNote,
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
        ? savedDraft.selectedProducts.map((product) => {
            const normalized = normalizeProductArea(product, serviceTypeForArea);
            // Bed bug: a pre-migration draft carries the old inferred
            // perimeter default — reclassify it to the interior default so
            // a restored draft can't demand perimeter footage or record
            // interior work as exterior (codex P2 r10).
            if (
              isBedBugVisit &&
              effectiveApplicationMethod(normalized.applicationMethod) ===
                "perimeter_spray"
            ) {
              return { ...normalized, applicationMethod: "spot_treatment" };
            }
            return normalized;
          })
        : [],
    );
    setSendSms(savedDraft.sendSms !== false);
    setIncludePayLink(savedDraft.includePayLink !== false);
    setRequestReview(savedDraft.requestReview !== false);
    setClientPestRating(
      Number.isInteger(savedDraft.clientPestRating)
        ? savedDraft.clientPestRating
        : null,
    );
    setReviewTiming(savedDraft.reviewTiming || "120");
    setReviewCustomAt(savedDraft.reviewCustomAt || "");
    // Bed bug hides the recap-only control (typed-era billing parity) — a
    // pre-migration draft must not restore the flag into invisible state
    // where the server's recap_only_not_allowed 409 becomes unclearable
    // (codex P2 r9).
    setOneTimeRecapOnly(isBedBugVisit ? false : !!savedDraft.oneTimeRecapOnly);
    // Only an explicit saved `false` restores as opted-out — a legacy draft
    // without the field keeps the default-ON promise (missing ≠ declined).
    setOfferInspectionCredit(savedDraft.offerInspectionCredit !== false);
    // Quiet/loud choice + typed minutes come back exactly as saved; a legacy
    // draft without the fields falls back to the panel default. Consumers all
    // gate on backfillEligible, so this stays inert if the visit is somehow
    // no longer past-dated.
    const restoredBackfill = restoredBackfillChoices(
      savedDraft,
      backfillCloseoutDefault,
    );
    setBackfillCloseout(restoredBackfill.backfillCloseout);
    setBackfillTimeOnSite(restoredBackfill.backfillTimeOnSite);
    setAdjustedTimeOnSite(restoredBackfill.adjustedTimeOnSite);
    // Moved re-entry steppers restore as-is; a draft without the field (or
    // an untouched side) leaves null so the live seed fills it in.
    if (Number.isFinite(savedDraft.reentryExteriorMinutes)) {
      setReentryExtMinutes(Math.min(1440, Math.max(0, Math.round(savedDraft.reentryExteriorMinutes))));
    }
    if (Number.isFinite(savedDraft.reentryInteriorMinutes)) {
      setReentryIntMinutes(Math.min(1440, Math.max(0, Math.round(savedDraft.reentryInteriorMinutes))));
    }
    setVisitOutcome(savedDraft.visitOutcome || "completed");
    setCustomerRecap(savedDraft.customerRecap || "");
    setRecapSource(savedDraft.recapSource || "draft");
    setRecapDraftStatus(
      savedDraft.recapSource === "manual" ? "manual" : "ready",
    );
    setRecapStaleAfterEdit(false);
    setAreasServiced(
      // Map the legacy singular "Side yard" to the renamed "Side yards" so a draft
      // saved before the rename restores as the currently-rendered option (and
      // dedupe, so re-selecting can't submit both strings). Then prune to the
      // CURRENT chip vocabulary: a draft saved before an option was removed
      // ("No issues found" / "Follow-up recommended", dropped 2026-07-30)
      // would otherwise restore an invisible value with no control to
      // deselect it — and it could even leak into a product's
      // applicationArea (codex P2).
      // Lines without the picker (T&S + rodent, owner 2026-07-23) never restore
      // areas — a pre-change draft's chips would sit invisible in state (codex P3
      // on #2950); the areasTreatedHidden clearing effect backstops any other path.
      !areasTreatedHidden && Array.isArray(savedDraft.areasServiced)
        ? [...new Set(savedDraft.areasServiced.map((a) => (a === "Side yard" ? "Side yards" : a)))]
            .filter((a) => areaOptions.includes(a))
        : [],
    );
    setZoneMapImageFallback(
      savedDraft.zoneMapImage && typeof savedDraft.zoneMapImage === "object"
        ? savedDraft.zoneMapImage
        : null,
    );
    const restoredStationNew = Array.isArray(savedDraft.stationNew)
      ? savedDraft.stationNew.filter((station) => station
        && typeof station.key === "string"
        && station.shape && typeof station.shape === "object")
      : [];
    // keep the key sequence ahead of restored pins so a new add can't
    // collide with a restored key
    stationNewSeqRef.current = restoredStationNew.reduce((max, station) => {
      const n = Number(String(station.key).replace("new-", ""));
      return Number.isFinite(n) ? Math.max(max, n) : max;
    }, stationNewSeqRef.current);
    setStationMoves(
      savedDraft.stationMoves && typeof savedDraft.stationMoves === "object"
        ? savedDraft.stationMoves
        : {},
    );
    const restoredStatuses = savedDraft.stationStatuses && typeof savedDraft.stationStatuses === "object"
      ? savedDraft.stationStatuses
      : {};
    // Against a CONFIRMED registry, a restored pin can collide with a row
    // another writer added at the same position while the draft waited —
    // the server dedupes that create onto the existing row, so displaying
    // and auto-counting both here records one station while the frozen
    // count says two (codex P1 r18). Reconcile before setting; the
    // unconfirmed path keeps the raw restore and reconciles when the
    // fetch resolves (see the /property-map effect).
    if (stationRegistryState === "ready") {
      const reconciled = reconcileNewPinsWithRegistry({
        stationNew: restoredStationNew,
        stationPreloads,
        stationStatuses: restoredStatuses,
      });
      setStationNew(reconciled.stationNew);
      setStationStatuses(reconciled.stationStatuses);
    } else {
      setStationNew(restoredStationNew);
      setStationStatuses(restoredStatuses);
    }
    setStationRetired(
      Array.isArray(savedDraft.stationRetired) ? savedDraft.stationRetired : [],
    );
    // Bridge until the /property-map refetch resolves — submit iterates
    // preloads, so restored existing-station edits need their rows present.
    // The live fetch overwrites these with fresh (drift-resolved) data.
    // ONLY while the registry is unconfirmed: when the fetch resolved
    // BEFORE the operator clicked Restore, the confirmed roster stays and
    // the restored edit intents overlay it by id — replacing it with the
    // draft's older rows re-submitted stations retired since the draft,
    // skipped this visit's check on stations added since, and recomputed
    // auto-counts from the stale roster, with nothing triggering another
    // fetch (codex P1 r17). An intent whose id no longer exists simply
    // doesn't render or submit, the safe direction.
    if (stationRegistryState !== "ready") {
      setStationPreloads(
        Array.isArray(savedDraft.stationPreloads)
          ? savedDraft.stationPreloads.filter((station) => station
            && typeof station.id === "string" && station.id)
          : [],
      );
      if (Number.isFinite(Number(savedDraft.stationNumberBase)) && Number(savedDraft.stationNumberBase) >= 1) {
        setStationNumberBase(Number(savedDraft.stationNumberBase));
      }
    }
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
    setObservationsText(
      typeof savedDraft.observationsText === "string"
        ? savedDraft.observationsText
        : "",
    );
    setRecommendationsText(
      typeof savedDraft.recommendationsText === "string"
        ? savedDraft.recommendationsText
        : "",
    );
    // Drafts saved before the detached-selection model lack the field → false,
    // which matches their notes still carrying the chip-marker lines.
    setChipLinesDetached(savedDraft.chipLinesDetached === true);
    // Older drafts lack the field → false, matching their pre-AI notes.
    setAiReportUsed(savedDraft.aiReportUsed === true);
    generatedReportTextRef.current = typeof savedDraft.generatedReportText === "string" && savedDraft.generatedReportText
      ? savedDraft.generatedReportText
      : null;
    setNextVisitNote(savedDraft.nextVisitNote || "");
    setShowNextVisitNote(!!savedDraft.showNextVisitNote);
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
    } else {
      // The profile untyped since this draft was saved (bed_bug,
      // 20260731400000): the typed controls no longer render and the submit
      // path would silently drop EVERY retired typed field as invisible
      // state — findings values, activity score, next-step chips, and the
      // typed recommendation all count (codex P2 r1 + r4). Discard them
      // LOUDLY so the tech re-enters what still matters; generic fields
      // (notes, products, rating…) still restore normally.
      const draftHadTypedEntries =
        Object.values(restoredFindings).some((v) =>
          Array.isArray(v) ? v.length > 0 : String(v ?? "").trim() !== "",
        )
        || Number.isInteger(savedDraft.typedActivityScore)
        || (Array.isArray(savedDraft.typedNextStepChips) && savedDraft.typedNextStepChips.length > 0)
        || String(savedDraft.typedRecommendations || "").trim() !== "";
      if (draftHadTypedEntries) {
        alert(
          "This service now completes with the standard form. The typed findings saved in this draft (rooms, evidence, treatment, activity, next steps…) can't be restored — re-enter anything still needed in the notes or observations.",
        );
      }
      setFindingsValues({});
      setTypedActivityScore(null);
      setTypedActivityTouched(false);
      setTypedNextStepChips([]);
      setTypedRecommendations("");
    }
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
    // Photos live in memory rather than localStorage. A deliberate Discard
    // must clear them too or old evidence remains attached to the
    // otherwise-reset completion.
    setServicePhotos([]);
    setSavedDraft(null);
    setShowDraftPrompt(false);
  }

  // Serialized product context for the recap auto-draft dependency: id +
  // method + targets per product (rate edits excluded — they never reach
  // the prompt).
  const recapProductsKey = JSON.stringify(selectedProducts.map((p) => [
    p.productId,
    p.applicationMethod || null,
    Array.isArray(p.targets) ? p.targets.join('|') : '',
  ]));
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
            // serviceId → server resolves the customer geocode for the
            // season/weather/expectations prompt context.
            serviceId: service.id || null,
            serviceType: service.serviceType,
            areasTreated: areasServiced,
            // Tech-chosen solutions feed the AI recap prompt on every line
            // (owner directive 2026-07-21) — context only, the prompt rules
            // keep product names out of the customer copy.
            products: selectedProducts.map((p) => ({
              productId: p.productId,
              name: p.displayName || p.name,
              applicationMethod: p.applicationMethod || null,
              targets: Array.isArray(p.targets) ? p.targets.slice(0, 6) : [],
            })),
            // Observations/recommendations/rating ground the recap the same
            // way they ground the AI report (owner 2026-07-30).
            observations: [
              ...activeSelectedLabels(selectedObservationLabels),
              ...freeTextLines(observationsText),
            ],
            recommendations: [
              ...activeSelectedLabels(selectedRecommendationLabels),
              ...freeTextLines(recommendationsText),
            ],
            pestActivityRating: clientPestRating,
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
    // Full product CONTEXT, not just the count — a method or target edit
    // after drafting must mark the recap for redraft, or the customer copy
    // describes the previous product context (codex P2 2026-07-22). The
    // debounce above absorbs per-keystroke churn.
    recapProductsKey,
    visitOutcome,
    areasServiced,
    observationsText,
    recommendationsText,
    clientPestRating,
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
          serviceId: service.id || null,
          serviceType: service.serviceType,
          areasTreated: areasServiced,
          products: selectedProducts.map((p) => ({
            productId: p.productId,
            name: p.displayName || p.name,
            applicationMethod: p.applicationMethod || null,
            targets: Array.isArray(p.targets) ? p.targets.slice(0, 6) : [],
          })),
          observations: [
            ...activeSelectedLabels(selectedObservationLabels),
            ...freeTextLines(observationsText),
          ],
          recommendations: [
            ...activeSelectedLabels(selectedRecommendationLabels),
            ...freeTextLines(recommendationsText),
          ],
          pestActivityRating: clientPestRating,
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
    // Once an AI draft has replaced the notes, the label arrays are the
    // selection source of truth and selections render as removable pills —
    // don't write tagged template lines back into the clean report prose.
    if (chipLinesDetached) return;
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
    // Pre-draft deselect model only (see activeSelectedLabels for the
    // post-draft one): a selected label counts as still-active if it appears
    // inside one of the bracketed chip-marker lines ([Protocol]/[Protocol
    // optional]/[Action]/[Found]/[Next] …) — NOT in arbitrary prose. The label
    // arrays are only ever populated alongside a marker (the chip handlers, or
    // a restored pre-draft whose saved notes carry the markers), so deleting a
    // marker line truly deselects the item.
    const markerLines = notes
      .split("\n")
      .filter((line) => /^\s*\[[^\]]+\]\s/.test(line))
      .map((line) => line.toLowerCase());
    return (Array.isArray(labels) ? labels : []).filter((label) => {
      const text = String(label || "").trim().toLowerCase();
      return text && markerLines.some((line) => line.includes(text));
    });
  }
  // The still-selected structured labels, honoring whichever deselect model is
  // active: before an AI draft, the [Protocol]/[Found]/[Next] chip lines in the
  // notes are the source of truth (delete a line = deselect); after Generate
  // replaces the notes with clean prose (chipLinesDetached), the label arrays
  // are authoritative and the removable pills below the notes are the deselect
  // handle. Every reader (submit, AI payload, applied-count) goes through this
  // so the structured visit record can't drift from what the tech sees.
  function activeSelectedLabels(labels) {
    if (!chipLinesDetached) return labelsStillInNotes(labels);
    return (Array.isArray(labels) ? labels : []).filter((label) =>
      String(label || "").trim(),
    );
  }
  // Generate AI report replaces the notes wholesale with AI prose. The tagged
  // [Protocol]/[Found]/[Next] template lines are NOT re-appended to the report
  // (owner request: the drafted copy must be clean prose only). Instead, prune
  // the label arrays to the labels whose tagged lines survived in the pre-draft
  // notes (honoring deselect-by-deletion up to this point) and flip
  // chipLinesDetached so the arrays become authoritative — the structured visit
  // record (and interior-treatment safety scopes) survive drafting, and the
  // pills UI takes over as the deselect handle. (notes still holds the
  // pre-draft text here; setNotes(report) hasn't applied yet.)
  function applyGeneratedReport(reportText, { deterministic = false } = {}) {
    // Telemetry (specialty completion contract): an installed AI report is
    // an AI-assisted completion — persisted as ai_draft_used (codex r14).
    // A double-provider miss returns deterministic template copy, which is
    // NOT AI-assisted and must not inflate the metric (codex r19).
    if (!deterministic) setAiReportUsed(true);
    generatedReportTextRef.current = String(reportText || "").trim();
    setGeneratedReportCleared(false);
    if (!chipLinesDetached) {
      setSelectedProtocolActionLabels(
        labelsStillInNotes(selectedProtocolActionLabels),
      );
      setSelectedObservationLabels(
        labelsStillInNotes(selectedObservationLabels),
      );
      setSelectedRecommendationLabels(
        labelsStillInNotes(selectedRecommendationLabels),
      );
      setChipLinesDetached(true);
    }
    setNotes(String(reportText || "").trim());
  }
  // Deselect handle after an AI draft: remove a structured selection from its
  // label array (and its recorded re-entry/treatment scope, for protocol
  // actions). Products added by a protocol action stay — they have their own
  // remove control, same as deleting a tagged line never removed them.
  function removeSelectedLabel(kind, label) {
    if (kind === "protocol") {
      setSelectedProtocolActionLabels((prev) =>
        prev.filter((item) => item !== label),
      );
      setActionScopeByLabel((prev) => {
        if (!(label in prev)) return prev;
        const next = { ...prev };
        delete next[label];
        return next;
      });
    } else if (kind === "observation") {
      setSelectedObservationLabels((prev) =>
        prev.filter((item) => item !== label),
      );
    } else if (kind === "recommendation") {
      setSelectedRecommendationLabels((prev) =>
        prev.filter((item) => item !== label),
      );
    }
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
  // Free-text observations/recommendations → the same string[] the server
  // already reads (one entry per non-empty line).
  function freeTextLines(text) {
    return String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
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
    const actionsCompleted = activeSelectedLabels(selectedProtocolActionLabels);
    // Free text is the input surface now; restored older drafts can still
    // carry chip-label selections, so both merge into the same arrays.
    const observations = [
      ...activeSelectedLabels(selectedObservationLabels),
      ...freeTextLines(observationsText),
    ];
    const recommendations = [
      ...activeSelectedLabels(selectedRecommendationLabels),
      ...freeTextLines(recommendationsText),
      // Typed completions keep their own recommendations box (inside the
      // findings section) — since the recap-only draft was retired, the full
      // generate action is the one AI path and must see that text too.
      ...(isTypedFindings ? freeTextLines(typedRecommendations) : []),
    ];
    // Typed structured findings ground the prompt the same way the retired
    // findings-recap draft grounded its recommendations: only non-empty
    // values ship. Companion sections ride along INDEPENDENTLY of the
    // primary — companion-only profiles (e.g. lawn_tree_shrub_combo) have no
    // primary findings type, and each companion carries its own chips and
    // activity score with the same provenance split the server prompt draws.
    // Schema-internal fields (compliance/calibration) never reach the prompt,
    // so they can't open the generation gate either — mirrors the server's
    // sections-based check (codex r4).
    const nonInternalValuesNonEmpty = (schema, obj) => {
      const internalKeys = new Set(
        (schema?.fields || []).filter((f) => f.internal).map((f) => f.key),
      );
      return Object.entries(obj || {}).some(
        ([key, v]) => !internalKeys.has(key)
          && (Array.isArray(v) ? v.length > 0 : String(v ?? "").trim() !== ""),
      );
    };
    const companionPayload = companionSchemas.length
      ? {
        companionFindings: companionSchemas.map((schema) => {
          const entry = companionState[schema.type] || EMPTY_COMPANION_ENTRY;
          return {
            type: schema.type,
            values: entry.values,
            nextStepChips: entry.chips,
            activityScore: Number.isInteger(entry.score) ? entry.score : null,
          };
        }),
      }
      : {};
    const typedFindingsPayload = {
      ...(isTypedFindings && typedFindingsSchema
        ? {
          structuredFindings: {
            type: typedFindingsSchema.type,
            values: findingsValues,
          },
          nextStepChips: typedNextStepChips,
          typedActivityScore: Number.isInteger(typedActivityScore) ? typedActivityScore : null,
        }
        : {}),
      ...companionPayload,
    };
    // Only chips that don't conflict with the recorded findings count — a
    // stale conflicted selection stays tappable for removal but the server's
    // validatedChipCount gate would 400 a request it alone opened (codex r12).
    // Membership in the CURRENT schema's chip list is required too — a
    // restored draft can carry a chip removed from the schema, which the
    // server's validateNextStepChips rejects (codex r24).
    const validChipCount = (schema, chips, values) => (chips || []).filter(
      (chip) => (schema?.nextStepChips || []).includes(chip)
        && !typedNextStepChipConflict(schema?.type, chip, values),
    ).length;
    const typedHasFindingInput = (isTypedFindings && (
      nonInternalValuesNonEmpty(typedFindingsSchema, findingsValues)
      || (typedFindingsSchema && validChipCount(typedFindingsSchema, typedNextStepChips, findingsValues) > 0)
      || typedActivityScore != null
    ))
      || companionSchemas.some((schema) => {
        // internal_only shadow companions render and submit but never open
        // Generate — the server's strict gate filters them, so counting one
        // here would enable a button that 400s (codex r11). Absent delivery
        // (older feeds) defaults customer-facing, matching the server.
        if (schema.delivery === "internal_only") return false;
        const entry = companionState[schema.type] || EMPTY_COMPANION_ENTRY;
        // A manually tapped companion activity gauge is substantive on its
        // own — same rule as the primary score (codex r3).
        return nonInternalValuesNonEmpty(schema, entry.values)
          || validChipCount(schema, entry.chips, entry.values) > 0
          || Number.isInteger(entry.score);
      });
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
      // The CURRENTLY confirmed assessment: an id grounds exactly that row,
      // null means a retake is pending, and the field is OMITTED while the
      // block's existing-assessment lookup is still in flight (the server
      // then falls back to the visit-linked row) or for non-lawn visits.
      // Tri-state: true = lookup succeeded (send id or explicit null);
      // "failed"/false = omit the field so the server grounds from its own
      // visit-linked lookup (DB truth) instead of trusting a blind client.
      ...(isLawn && lawnAssessmentReady === true
        ? { lawnAssessmentId: lawnAssessmentId || null }
        : {}),
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
      // The generic pest-rating field stays the untyped customer chip row —
      // typed panels send their 0–5 gauge as typedActivityScore instead, so
      // the server can pair it with the indicator's OWN label ("Bait Station
      // Activity") and bait-consumption scores never read as generic pest
      // activity (codex r2).
      pestActivityRating: clientPestRating ?? null,
      photoCount: Array.isArray(servicePhotos) ? servicePhotos.length : 0,
      includeCustomerComms: aiReportIncludeComms,
      ...typedFindingsPayload,
    };
    const hasReportInput =
      Boolean(payload.serviceNotes) ||
      productsApplied.length > 0 ||
      areasServiced.length > 0 ||
      actionsCompleted.length > 0 ||
      observations.length > 0 ||
      recommendations.length > 0 ||
      Boolean(concern) ||
      payload.pestActivityRating !== null ||
      typedHasFindingInput ||
      // A confirmed photo-scored assessment is substantive visit detail on
      // its own — a scores-only lawn visit can still generate.
      Boolean(payload.lawnAssessmentId) ||
      // The omitted-field fallback state must REACH the server — after a
      // failed lookup the client can't know whether a visit-linked confirmed
      // row exists; the server's validated gate decides.
      (isLawn && lawnAssessmentReady === "failed");
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
    const applicationMethod = defaultApplicationMethod(product, serviceTypeForArea, { interiorLane: isBedBugVisit });
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
    const catalogRate =
      product.defaultRatePer1000 ?? product.default_rate_per_1000 ?? product.ratePer1000 ?? "";
    // Generic "insecticide" categories cover dry/bait/packet forms too (e.g.
    // Advion WDG Granular, Delta Dust, Alpine WSG), whose inferred method
    // still falls through to perimeter_spray — a 4 oz liquid default would be
    // a wrong compliance record for those, so screen the name/category for
    // dry-form and dry-formulation markers (WSG/WDG/WG/WP/DF).
    const dryFormProduct =
      /\b(granul\w*|dust|bait|gel|station|trap|briquet|tablet|blox|dunk|packet|wsg|wdg|wg|wp|df)\b/i.test(
        `${product.name || ""} ${product.category || product.product_category || ""}`,
      );
    // General-pest perimeter sprays: when the catalog carries no rate, start
    // at the house default of 4 oz (rate/total units move together with it so
    // a catalog unit like "oz/1000sf" can't pair with the fallback value).
    // Editable as before; catalog rates still win when present.
    const usePestSprayDefault =
      catalogRate === "" &&
      !dryFormProduct &&
      applicationMethod === "perimeter_spray" &&
      serviceLineFromType(serviceTypeForArea) === "pest";
    // Dilution products carry their verified label rate in the legacy display
    // fields (default_rate "0.2-0.8" + default_unit "fl_oz/gal"). When there
    // is no per-1k rate and the pest 4-oz house default doesn't apply, start
    // the tech at the label band's LOW end in the label's own /gal unit —
    // parseFloat reads the low bound out of an "X-Y" band.
    const dilutionRate = defaultUnit.endsWith("/gal")
      ? parseFloat(String(product.default_rate ?? product.defaultRate ?? ""))
      : NaN;
    // DB numerics arrive as strings with trailing zeros ("0.5000") — show the
    // tech a clean number.
    const prefillRate = usePestSprayDefault
      ? 4
      : catalogRate !== "" && Number.isFinite(Number(catalogRate))
        ? Number(catalogRate)
        : Number.isFinite(dilutionRate)
          ? dilutionRate
          : catalogRate;
    // Lawn broadcast/granular products treat the whole measured lawn: start
    // the Sq ft field at the turf profile's treatable area and derive Total =
    // rate × area / 1,000 in the rate's own unit. Both stay editable; a
    // hand-edited Total is never recomputed (see updateProduct).
    // Perimeter sprays start from the traced barrier's measured footage
    // (Treatment Zone Mapper) so the tech doesn't retype what the trace
    // already measured. Editable as before.
    const prefillArea =
      areaRequirement?.unit === "sqft" && Number(lawnSqftForPrefill) > 0
        ? Number(lawnSqftForPrefill)
        : areaRequirement?.unit === "linear_ft" && Number(tracedLinearFt) > 0
          ? Number(tracedLinearFt)
          : "";
    // A "/gal" rate is a mix concentration — rate × sqft would fabricate an
    // applied amount that really depends on carrier volume, so leave Total
    // blank for the tech to enter. A linear-ft prefill derives nothing
    // either: the derived Total is a per-1,000-sqft calculation and has no
    // meaning against perimeter footage.
    const prefillTotal =
      defaultUnit.endsWith("/gal") || areaRequirement?.unit === "linear_ft"
        ? ""
        : derivedTotalAmount(prefillRate, prefillArea);
    setSelectedProducts((prev) => [
      ...prev,
      {
        productId: product.id,
        name: product.name,
        // Card display only — the submitted record keeps the canonical name.
        displayName: product.display_name || product.displayName || null,
        // The catalog category and active ingredient feed the pesticide/
        // family flags — without them every selected product falls into the
        // blank-category pesticide fallback and the simplified T&S form shows
        // compliance fields on ordinary fertilizer visits (codex P3 r4),
        // while blank-category insecticides (Delta Dust, Elector PSP) are
        // only recognizable by their active (codex P1 r5). Protocol-added
        // products are serialized without either, so fall back to the loaded
        // catalog row.
        category:
          product.category ??
          product.product_category ??
          (products || []).find((p) => String(p.id) === String(product.id))?.category ??
          null,
        activeIngredient:
          product.active_ingredient ??
          product.activeIngredient ??
          (products || []).find((p) => String(p.id) === String(product.id))?.active_ingredient ??
          null,
        rate: prefillRate,
        rateUnit: usePestSprayDefault ? "oz" : defaultUnit,
        catalogRateUnit: product.rateUnit || product.rate_unit || defaultUnit,
        // A "/gal" unit is a mix concentration — fine as the rate, but
        // "Total used" records a real quantity (and inventory deduction
        // can't convert a concentration), so default the amount unit to
        // the base unit instead.
        amountUnit: usePestSprayDefault
          ? "oz"
          : defaultUnit.endsWith("/gal")
            ? defaultUnit.slice(0, -"/gal".length)
            : defaultUnit,
        maxLabelRatePer1000:
          product.maxLabelRatePer1000 ??
          product.max_label_rate_per_1000 ??
          null,
        totalAmount: prefillTotal,
        totalAmountManual: false,
        applicationMethod,
        applicationArea: "",
        areaValue: prefillArea,
        areaUnit: areaRequirement?.unit || "",
        // Prefill the targets from the manufacturer label (products_catalog
        // target_pests) so the tech starts from what the product is labeled to
        // control and trims rather than typing from scratch. Editable as before.
        // Protocol-added products (addProduct(action.product)) are serialized
        // without target_pests, so fall back to the loaded catalog row by id.
        // Only targets belonging to THIS visit's service line(s) prefill,
        // capped at MAX_LABEL_TARGET_PREFILL (owner 2026-08-01) — a pest
        // visit drops Talstar's chinch bugs, a lawn visit drops its ants and
        // roaches; the tech can still add any target by hand. Keyed to the
        // detected service lines, not the panel's `isLawn` (false for typed
        // lawn visits — codex P2). The lines come from the whole visit, not
        // just its primary name: serviceTypeRaw survives the normalization
        // that collapses "Lawn + Tree & Shrub" to "Tree & Shrub Care" (codex
        // P1 r1), and scheduled add-ons contribute their own lines (codex P2
        // r2) so a pest visit with a mosquito add-on keeps In2Care's targets.
        targets: filterLabelTargetsForLine(
          normalizeLabelTargets(
            product.target_pests
              ?? product.targetPests
              ?? (products || []).find((p) => String(p.id) === String(product.id))?.target_pests,
          ),
          allowedTargetLinesForVisit(service),
        ),
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
  // A fresh trace saved from the Treatment Zone Mapper: adopt its measured
  // footage and fill any perimeter-spray rows whose Linear ft is still empty.
  // A typed value is the tech's actual and is never overwritten.
  function applyTracedTreatmentZone(zone) {
    const ft = Number(zone?.linear_ft);
    if (!Number.isFinite(ft) || ft <= 0) return;
    const rounded = Math.round(ft);
    setTracedLinearFt(rounded);
    setSelectedProducts((prev) =>
      prev.map((p) => {
        const areaRequirement = requiredApplicationArea(
          productApplicationMethod(p, serviceTypeForArea),
          serviceTypeForArea,
        );
        if (areaRequirement?.unit !== "linear_ft") return p;
        if (Number(p.areaValue) > 0) return p;
        return { ...p, areaValue: rounded, areaUnit: "linear_ft" };
      }),
    );
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
            // Switching onto perimeter spray starts from the traced barrier's
            // measured footage when the field is empty (typed values win).
            if (
              areaRequirement.unit === "linear_ft" &&
              !(Number(next.areaValue) > 0) &&
              Number(tracedLinearFt) > 0
            ) {
              next.areaValue = Number(tracedLinearFt);
            }
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
        // A hand-entered Total is the tech's actual and is never recomputed;
        // otherwise rate/area edits keep the derived Total (rate × sq ft /
        // 1,000) in sync on area-based applications — including back to blank
        // when the rate/area is cleared or the method stops being area-based,
        // so a stale full-lawn total can't be submitted. The derived total is
        // in the rate's unit, so a rate-unit change moves the total unit too.
        if (field === "totalAmount") {
          next.totalAmountManual = true;
        } else if (!next.totalAmountManual) {
          if (next.areaUnit !== "sqft") {
            if (field === "applicationMethod" && p.areaUnit === "sqft") {
              next.totalAmount = "";
            }
          } else if (field === "rate" || field === "areaValue") {
            next.totalAmount = String(next.rateUnit || "").endsWith("/gal")
              ? ""
              : derivedTotalAmount(next.rate, next.areaValue);
          } else if (field === "rateUnit") {
            // Concentration rate units keep Total in the base quantity unit,
            // and can't derive a total at all (it depends on carrier volume).
            const isConcentration = String(value).endsWith("/gal");
            next.amountUnit = isConcentration
              ? value.slice(0, -"/gal".length)
              : value;
            if (isConcentration) next.totalAmount = "";
          }
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

  // Shared success handling for BOTH resolution paths — a resolved onSubmit
  // POST and a status-poll replay of the stored response. Returns "closed"
  // when the panel unmounted mid-flight (caller stops without touching
  // submitting state on the stale mount), else "done".
  function finishCompletionSuccess(result) {
    sideEffectsRetryRef.current = 0;
    sideEffectsCommittedRef.current = false;
    lastSubmitBodyRef.current = null;
    // Panel closed while the request was in flight (codex P2 r10): unmount
    // can't abort a fetch. The completion is durable server-side and the
    // parent's bookkeeping already ran (onSubmit / onCompletionResult) —
    // clear the local artifacts, but never alert or onClose from a stale
    // mount (they'd target whichever visit the operator opened next).
    if (completionPanelClosedRef.current) {
      localStorage.removeItem(completionDraftKey(service.id));
      try {
        localStorage.removeItem(completionResumeOwedKey(service.id));
      } catch { /* ignore */ }
      return "closed";
    }
    const photoResult = result?.completionPhotoUpload;
    if (photoResult?.failed > 0) {
      alert(
        `Service completed, but ${photoResult.failed} photo${photoResult.failed === 1 ? "" : "s"} failed to upload.`,
      );
    }
    // A live time-on-site override syncs the technician's linked job
    // timer server-side; when that sync is blocked the inflated span
    // survives in Timesheets/utilization — say so, since the corrected
    // value seeds the edit modal and no later save will retry it.
    if (result?.timeEntryCorrected === false) {
      const timerReason =
        result?.timeEntryCorrectionBlocked === "exceeds_elapsed"
          ? "the corrected minutes exceed the time elapsed since its clock-in"
          : result?.timeEntryCorrectionBlocked === "entry_conflict"
            ? "it was edited by someone else at the same moment"
          : result?.timeEntryCorrectionBlocked === "entry_open"
            ? "its timer is still running"
          : result?.timeEntryCorrectionBlocked === "approved_week"
            ? "its week is already approved"
            : result?.timeEntryCorrectionBlocked === "multiple_job_entries"
              ? "several timer entries are linked to this visit"
              : "it could not be edited automatically";
      alert(
        `Service completed with the corrected duration, but the technician's linked job timer was NOT changed (${timerReason}) — it still shows the old span in Timesheets until corrected there.`,
      );
    }
    localStorage.removeItem(completionDraftKey(service.id));
    try {
      localStorage.removeItem(completionResumeOwedKey(service.id));
    } catch { /* storage unavailable — marker never existed either */ }
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
    // Completion advisories also hold the overlay open (codex P2 r2 on
    // #3179): the 1.2s auto-dismiss isn't enough to read even one
    // shortfall message — the tech dismisses via the Done button instead.
    const advisoriesNeedReading =
      Array.isArray(result?.completionAdvisories) &&
      result.completionAdvisories.length > 0;
    if (
      !result?.followupSuggestion?.required &&
      !recapEligible &&
      !advisoriesNeedReading
    ) {
      setTimeout(() => onClose(true), smsNeedsAttention ? 3200 : 1200);
    }
    return "done";
  }

  // Terminal SUCCESS for a committed chain resolved under ANOTHER key (see
  // completionCrossKeyCompleted): clear every chain artifact so the
  // completed visit stops being reopenable, run the parent-equivalent
  // bookkeeping, and close out — never the generic failure path.
  function resolveCrossKeyCompleted() {
    sideEffectsCommittedRef.current = false;
    lastSubmitBodyRef.current = null;
    completionIdempotencyKeyRef.current = null;
    localStorage.removeItem(completionDraftKey(service.id));
    try {
      localStorage.removeItem(completionResumeOwedKey(service.id));
    } catch { /* ignore */ }
    // Parent-equivalent success bookkeeping — onSubmit never resolved, so
    // the parent's own status flip / cache refresh never ran.
    if (onCompletedElsewhere) onCompletedElsewhere(service.id);
    // Stale-mount guard (codex P2 r10): bookkeeping and storage cleanup
    // above are safe post-close; the dialog and onClose(true) are not.
    if (!completionPanelClosedRef.current) {
      alert(CROSS_KEY_COMPLETED_MESSAGE);
      setSubmitting(false);
      onClose(true);
    }
  }

  // Lightweight side-effects poll (codex P1 #3187 r11): while the server
  // runs a committed completion's side effects, poll the read-only status
  // route instead of replaying the media-bearing completion POST (base64
  // photos = ~MBs per submit) every five seconds. The full body re-POSTs
  // exactly once per "resumable" verdict, through handleSubmit's normal
  // committed-replay machinery.
  async function pollCompletionSideEffects(reconcileConfirmed) {
    while (sideEffectsRetryRef.current < SIDE_EFFECTS_MAX_RETRIES) {
      sideEffectsRetryRef.current += 1;
      await new Promise((resolve) => {
        sideEffectsPollTimerRef.current = window.setTimeout(
          resolve,
          SIDE_EFFECTS_RETRY_MS,
        );
      });
      // Panel closed during the delay — stop quietly; the durable reopen
      // marker (set when the chain committed) carries the resume.
      if (completionPanelClosedRef.current) return;
      let status = null;
      try {
        status = await adminFetch(
          `/admin/dispatch/${service.id}/completion-status?idempotencyKey=${encodeURIComponent(completionIdempotencyKeyRef.current || "")}`,
        );
      } catch {
        // Transient poll failure — the attempt state is durable
        // server-side; the next tick re-reads it.
        continue;
      }
      if (completionPanelClosedRef.current) return;
      const action = completionStatusPlan(status);
      if (action === "wait") continue;
      if (action === "success") {
        // The stored response IS the completion result — run the parent's
        // bookkeeping (status flip, cache refresh, payment handoff) that a
        // resolved onSubmit would have run, then the shared success path.
        const result = onCompletionResult
          ? await onCompletionResult(service.id, status.response)
          : status.response;
        if (finishCompletionSuccess(result || status.response) === "closed") return;
        setSubmitting(false);
        return;
      }
      if (action === "cross_key") return resolveCrossKeyCompleted();
      if (action === "resume") {
        return handleSubmit(reconcileConfirmed, { resumingPoll: true });
      }
      if (action === "failed") {
        // Pre-commit failure (e.g. a stale claim was reclaimed-as-failed):
        // a fresh manual submit is correct — drop the chain so it rebuilds.
        sideEffectsCommittedRef.current = false;
        lastSubmitBodyRef.current = null;
        if (!completionPanelClosedRef.current) {
          alert(
            "Completion needs another try: " +
              (status.error || "the previous attempt did not finish."),
          );
          setSubmitting(false);
        }
        return;
      }
    }
    // Polling window exhausted — honest give-up; the reopen marker was set
    // when the chain committed.
    sideEffectsRetryRef.current = 0;
    if (!completionPanelClosedRef.current) {
      alert(SIDE_EFFECTS_GIVE_UP_MESSAGE);
      setSubmitting(false);
    }
  }

  async function handleSubmit(reconcileConfirmed = false, { resumingPoll = false } = {}) {
    // The status poll's "resumable" verdict re-enters here while submitting
    // is STILL true (the button stayed in its completing state through the
    // whole chain) — that re-entry is the continuation of the same logical
    // submission, not a double-tap, so it bypasses the guard (codex P1
    // #3187 r18: the guard silently swallowed the resume POST and left the
    // button disabled forever).
    if (submitting && !resumingPoll) return;
    // Don't complete while an AI draft is in flight — the response is about to
    // replace the notes, and submitting now would either lose the generated copy
    // or rebuild the structured fields from soon-to-be-overwritten notes.
    if (generating) {
      alert("Hang on — finishing the AI draft. Try again in a moment.");
      return;
    }
    // A billing-detour draft can restore station pins, moves, statuses, and
    // retirements while the registry request is still loading or failed.
    // The completion payload posts no station entries in that state, and a
    // successful submit clears the draft those edits were restored from —
    // silently deleting the tech's work (pre-push P0). Fail closed until
    // the registry confirms, or the tech explicitly discards the edits via
    // the registry note.
    if (stationEditsBlocked) {
      alert(stationEditsBlockTransient
        ? "Hang on — confirming the existing trap/station map. Try again in a moment."
        : "The trap/station map isn't available for this completion, so it can't save the map edits restored from your draft. Discard them from the station section, or reload to retry.");
      return;
    }
    // WaveGuard lawn: the compliance advisories come from the plan request —
    // completing before it settles would record conditions the tech never saw.
    if (closeoutAdvisoriesPending) {
      alert("Hang on — loading the WaveGuard plan. Try again in a moment.");
      return;
    }
    // The turf-height flag drives the (optional) gauge-reading section on lawn
    // visits; don't submit until its state is loaded so a pre-load submit can't
    // silently drop a reading/photo. The flag is session-cached so this rarely waits.
    if (isLawn && !turfHeightFlagReady) {
      alert("Completion options are still loading — please try again in a moment.");
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
    // A typo in the live time-on-site override must never silently fall
    // back to the inflated timer — the whole point of the field is that the
    // timer is wrong. Block here; completionTimeOnSiteBody's range check is
    // only the belt-and-suspenders for a stale draft restore.
    if (liveAdjustEligible && String(adjustedTimeOnSite || "").trim() !== "") {
      const adjusted = Math.round(Number(adjustedTimeOnSite));
      if (!Number.isFinite(adjusted) || adjusted < 1 || adjusted > 720) {
        alert("Adjusted time on site must be 1–720 minutes.");
        return;
      }
    }
    // The server normalizer silently trims each observation/recommendation
    // line to 240 chars and keeps at most 20 entries — reject oversized
    // input here instead of letting the saved report lose text without
    // warning (codex P2). Counted on the MERGED payload the submit actually
    // sends (restored chip labels + free text + the typed recommendation),
    // not per-textarea — the cap applies to the whole array, and an
    // overflow would silently drop the entries after the twentieth
    // (codex r8: the typed recommendation is appended last and vanished
    // first).
    {
      const freeTextProblems = [];
      const mergedCounts = [
        [
          "Observations",
          activeSelectedLabels(selectedObservationLabels).length +
            freeTextLines(observationsText).length,
          observationsText,
        ],
        [
          "Recommendations",
          activeSelectedLabels(selectedRecommendationLabels).length +
            freeTextLines(recommendationsText).length +
            (isTypedFindings && typedRecommendations.trim() ? 1 : 0),
          recommendationsText,
        ],
      ];
      for (const [label, mergedCount, text] of mergedCounts) {
        if (mergedCount > 20) {
          freeTextProblems.push(
            `${label}: at most 20 entries total (${mergedCount} entered)`,
          );
        }
        if (freeTextLines(text).some((line) => line.length > 240)) {
          freeTextProblems.push(`${label}: keep each line under 240 characters`);
        }
      }
      if (freeTextProblems.length) {
        alert(`Shorten these before submitting — ${freeTextProblems.join("; ")}.`);
        return;
      }
    }
    if (isTypedFindings && !isIncompleteVisit) {
      const missingTypedRequired = (typedFindingsSchema.fields || [])
        .filter(
          (f) =>
            typedFieldRequiredNow(f, findingsValues) &&
            String(findingsValues[f.key] ?? "").trim() === "",
        )
        .map((f) => f.label);
      // Pesticide compliance answers: the server blocks completion without
      // pollinator_status and irac_frac_logged = Yes whenever a pesticide
      // product is recorded — mirror that pre-submit so the tech is guided
      // to the field instead of a generic server failure (codex P2 r13).
      if (pesticideProductPresent) {
        for (const f of typedFindingsSchema.fields || []) {
          if (!f.pesticideOnly) continue;
          const value = String(findingsValues[f.key] ?? "").trim();
          if (!value) missingTypedRequired.push(f.label);
          else if (f.key === "irac_frac_logged" && value !== "Yes") {
            missingTypedRequired.push(`${f.label} (must be confirmed Yes)`);
          }
        }
      }
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
      // Mirror the server's field-value contradiction rejections (termite
      // attestations) pre-submit — same rationale as the chip mirror.
      const fieldConflicts = typedFieldValueConflicts(
        typedFindingsSchema.type,
        findingsValues,
      );
      if (fieldConflicts.length) {
        completionTelemetryRef.current.requiredFieldErrorCount += 1;
        alert(
          `Fix the findings before submitting: ${fieldConflicts.join("; ")}.`,
        );
        return;
      }
    }
    // A declared trap SETUP cannot carry serviced pins — the map relabels
    // `ok` to "Set this visit" but leaves `serviced` saying "Serviced this
    // visit", so the frozen report would contradict its own stage (codex
    // P1). Mirrors the server's rejection so the tech gets the inline
    // prompt instead of a 422. Checked across the primary AND companion
    // sections, since `trap_visit_type` can live in either.
    // Trapping program only — a combined profile can resolve to the
    // termite/rodent bait program while a trapping companion declares a
    // setup, and a legitimate serviced BAIT-STATION pin must not be blocked
    // (codex P1). Mirrors the server's scoping exactly.
    if (stationFeatureOn && stationProgram === "trapping" && !isIncompleteVisit) {
      // declaresTrapSetup is the hoisted component-level source — the same
      // value hides the "Serviced" chip in the editor (codex P2 r18).
      if (
        declaresTrapSetup &&
        stationDisplay.some(
          (station) => (stationStatuses[station.key] || "ok") === "serviced",
        )
      ) {
        completionTelemetryRef.current.requiredFieldErrorCount += 1;
        alert(
          'A trap marked "Serviced" contradicts an initial setup — the traps went out on this visit. Clear the serviced mark, or set this visit to "Follow-up check".',
        );
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
        // Pesticide compliance mirror for companions (codex P2 r15): same
        // gate as the primary form — the server requires these whenever a
        // pesticide product is on the (shared) products list.
        if (pesticideProductPresent) {
          for (const f of schema.fields || []) {
            if (!f.pesticideOnly) continue;
            const value = String(entry.values[f.key] ?? "").trim();
            if (!value) missingCompanionRequired.push(f.label);
            else if (f.key === "irac_frac_logged" && value !== "Yes") {
              missingCompanionRequired.push(`${f.label} (must be confirmed Yes)`);
            }
          }
        }
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
        const companionFieldConflicts = typedFieldValueConflicts(
          schema.type,
          entry.values,
        );
        if (companionFieldConflicts.length) {
          completionTelemetryRef.current.requiredFieldErrorCount += 1;
          alert(
            `${label}: fix the findings before submitting: ${companionFieldConflicts.join("; ")}.`,
          );
          return;
        }
      }
    }
    if (calibrationRequired && !isIncompleteVisit && !selectedProducts.length) {
      alert(
        "Add the products applied on this visit before closeout — a WaveGuard lawn completion records product actuals.",
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
      treatmentPlanGatingInventoryBlocks.length
    ) {
      alert(
        `Resolve inventory blocks before closeout: ${treatmentPlanGatingInventoryBlocks
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
    // The ONLY time-dependent pre-submit gate — skipped for a committed
    // chain retry: the replayed body is immutable and the server ignores
    // its review timing on replay/resume, so Date.now() advancing past a
    // custom review time mid-poll must not strand the poll behind this
    // alert with the button stuck on submitting (codex P2 #3187 r7). All
    // other gates are pure over form state the poll never changes.
    if (
      !sideEffectsCommittedRef.current &&
      !oneTimeRecapOnly &&
      willReview &&
      reviewTiming === "custom"
    ) {
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
      // Lawn closeouts enforce the product-backed rule at submit too: a
      // draft saved before the scout/task rows were filtered out can restore
      // labels the selector no longer offers — they must not persist as
      // completed protocol actions. Only applied once the (filtered) action
      // set has loaded; pest keeps its fallback-chip labels untouched.
      const reportProtocolActions = activeSelectedLabels(
        selectedProtocolActionLabels,
      ).filter(
        (label) =>
          !isLawn ||
          (protocolActionsLoaded &&
            protocolActions.some(
              (action) =>
                (action.label || action.note || action.raw || "") === label,
            )),
      );
      const reportProtocolActionScopes = reportProtocolActions
        .map((label) => {
          const meta = actionScopeByLabel[label];
          if (!meta) return null;
          return { label, scope: meta.scope, treatmentApplied: meta.treatmentApplied === true };
        })
        .filter(Boolean);
      const reportObservations = [
        ...activeSelectedLabels(selectedObservationLabels),
        ...freeTextLines(observationsText),
      ];
      // Typed mode appends the optional recommendations textarea into the
      // existing recommendations array — no new server field.
      const reportRecommendations = [
        ...activeSelectedLabels(selectedRecommendationLabels),
        ...freeTextLines(recommendationsText),
        ...(isTypedFindings && typedRecommendations.trim()
          ? [typedRecommendations.trim()]
          : []),
      ];
      const body = {
        idempotencyKey: completionIdempotencyKeyRef.current,
        technicianNotes: notes,
        // Set only on the resubmit after the tech OK'd the reconciliation
        // prompt — the server then skips the 409 and completes.
        ...(reconcileConfirmed ? { reportReconcileConfirmed: true } : {}),
        // customerRecap is intentionally NOT sent: the report summary is generated
        // server-side from the technician notes (there's no recap editor here).
        // Sending a hidden/restored stale draft would bypass that and become
        // unreviewed customer-facing copy (Codex P1).
        visitOutcome,
        reviewSuppression: reviewSuppressionReason,
        // Equipment/calibration, tank cleanout, and the office/N/manager
        // approval ceremonies are gone from the closeout (owner directive
        // 2026-07-29). The server records blackout/N-budget/protocol
        // conditions as advisories on the completion by itself.
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
        // The protocol block is now read-only (mixing-ratio reference), so the tech
        // no longer submits a checklist / treated-sqft / disposition. The server
        // still records a protocol completion for WaveGuard lawn visits, deriving
        // treated area + carrier from the plan; what was actually applied comes
        // through the products list.
        lawnProtocolCompletion: null,
        treeShrubCompletion: treeShrubCloseoutRequired
          ? {
              ...treeShrubCloseout,
              // Don't fall back to the hidden customerRecap state (auto-generated /
              // restored, never reviewed) — use the tech's note or the typed notes.
              customerNote:
                treeShrubCloseout.customerNote || notes || "",
            }
          : null,
        oneTimeRecapOnly,
        // Backdated quiet closeout — only ever posted for a past-dated visit
        // (the server 400s otherwise); the flag overrides the SMS/review
        // toggles server-side.
        ...(backfillEligible && backfillCloseout ? { backfill: true } : {}),
        sendCompletionSms: effectiveSendSms,
        // Only meaningful when an invoice/pay link would be texted; mirror the
        // sub-toggle's visibility (invoice + SMS being sent) so a stale false
        // never posts when the completion SMS is off. false = report-only SMS.
        includePayLink: willInvoice && effectiveSendSms ? includePayLink : true,
        // Only meaningful on an inspection closeout; mirror the toggle's
        // visibility so a stale cleared box can't suppress the credit on a
        // non-inspection visit (where the server ignores it anyway).
        // A FAILED profile lookup hides the credit toggle without meaning
        // "not an inspection" — omitting the field (undefined drops out of
        // the JSON body) records no explicit choice, and the server's
        // default-on ruling applies against ITS OWN resolution instead of
        // a fabricated opt-in (Codex #3178 r32 P2).
        offerInspectionCredit: service.completionProfileLookupFailed === true
          ? undefined
          : (isInspectionVisit ? offerInspectionCredit : true),
        requestReview: oneTimeRecapOnly ? !reviewSuppressionReason : willReview,
        reviewTiming: oneTimeRecapOnly ? "now" : reviewTiming,
        reviewDelayMinutes: selectedReviewDelayMinutes,
        reviewScheduledFor: oneTimeRecapOnly
          ? null
          : selectedReviewScheduledFor,
        // Backfill: never the auto-elapsed (it spans the stale gap) — only
        // what the operator typed, or nothing. Live: an admin-typed number
        // overrides the running timer. See completionTimeOnSiteBody.
        ...completionTimeOnSiteBody({
          backfill: backfillEligible && backfillCloseout,
          typedMinutes: backfillTimeOnSite,
          elapsed,
          adjustedMinutes: liveAdjustEligible ? adjustedTimeOnSite : "",
        }),
        // Re-entry steppers: only sides the tech moved off their seed post.
        // An untouched panel sends nothing and the server's computed
        // defaults (line + product-label REI floor) apply unchanged.
        ...(reentryExtDirty ? { reentryExteriorMinutes: reentryExtMinutes } : {}),
        ...(reentryIntDirty ? { reentryInteriorMinutes: reentryIntMinutes } : {}),
        // Single source of truth for the treated areas. The server reads
        // areasServiced (falling back to a legacy areasTreated only if present),
        // so we no longer post the same list under both keys.
        areasServiced,
        // Bait station pins + this visit's statuses (station-map-v1).
        // Statuses post for EVERY active station — 'ok' is the zero-tap
        // default, so an untouched map still records a full check. Shapes
        // post only for pins placed or moved THIS session (an untouched
        // pin must not restamp its drift ref with today's image params);
        // creates go last so server numbering (payload order) matches the
        // provisional numbers the tech saw.
        // A failed station registry (stationsLoaded false) posts NOTHING:
        // the editor is disabled, but the submit guard is the boundary that
        // matters — a status-only entry against a fallback roster would
        // still mint check rows the visit's map cannot show (codex P2 r12).
        ...(stationFeatureOn && !stationRegistryFailed
          ? (() => {
            const image = (propertyMap?.available && propertyMap.image) || zoneMapImageFallback;
            const ref = image
              ? {
                lat: image.center?.lat,
                lng: image.center?.lng,
                zoom: image.zoom,
                width: image.width || 640,
                height: image.height || 340,
                capturedAt: new Date().toISOString(),
              }
              : null;
            const entries = [];
            stationPreloads.forEach((station) => {
              if (stationRetired.includes(station.id)) {
                entries.push({ id: station.id, retire: true });
                return;
              }
              const moved = stationMoves[station.id];
              const status = stationStatuses[station.id] || "ok";
              if (moved && ref) entries.push({ id: station.id, shape: { ...moved, ref }, status });
              // A drift-hidden pin that was never re-placed submits NOTHING:
              // a status would mint a check row for a station the visit's
              // map cannot show (mirrors the auto-count exclusion above).
              else if (station.shape) entries.push({ id: station.id, status });
            });
            if (ref) {
              stationNew.forEach((station) => {
                entries.push({
                  shape: { ...station.shape, ref },
                  status: stationStatuses[station.key] || "ok",
                });
              });
            }
            return entries.length ? { termiteStations: entries } : {};
          })()
          : {}),
        customerInteraction: normalizeCustomerInteractionValue(customerInteraction),
        protocolActionsCompleted: reportProtocolActions,
        protocolActionScopesCompleted: reportProtocolActionScopes,
        observations: reportObservations,
        recommendations: reportRecommendations,
        lawnAssessmentId,
        // Tree & Shrub AI photo assessment. When the background review ran,
        // carry the signed scores so the server persists them without a second
        // vision pass. There is no tech review step (owner 2026-07-23) — every
        // finding rides as its default "monitor" action, which keeps the
        // report's signals-only language. Absent → server auto-scores.
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
                decisions: (treeShrubReview.findings || []).map((f) => ({ key: f.key, action: f.defaultAction || "monitor", detail: f.detail })),
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
        // Gauge reading (lawn only, behind the flag). Both the height-of-cut
        // reading and the on-site lawn-length photo are OPTIONAL; the server
        // snapshots the authoritative band. Off-flag/non-lawn these are inert.
        ...(turfHeightFlag && isLawn ? {
          manualHeightIn: turfHeight.heightIn,
          gaugePhoto: turfHeight.gaugePhoto,
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
          // The recommendations-only recap draft was retired 2026-08-15 for
          // the unified Generate AI report (which drafts NOTES) — this flag
          // now records an installed unified generation, keeping the
          // ai_draft_used adoption metric meaningful (codex r14).
          aiDraftUsed: aiReportUsed,
          recommendationTextEdited: typedRecommendationsEdited,
          activityScoreTouched: typedActivityTouched,
        };
      }
      // Companion-only profiles (findingsType null, e.g. lawn_tree_shrub_combo)
      // never enter the typed branch above, but their techs use the same
      // unified Generate action — persist the telemetry so ai_draft_used
      // doesn't undercount this supported flow (codex r16).
      if (!body.completionTelemetry && companionSchemas.length && !isIncompleteVisit) {
        body.completionTelemetry = {
          ...completionTelemetryRef.current,
          submitClickedAt: new Date().toISOString(),
          aiDraftUsed: aiReportUsed,
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
      // Once the completion is KNOWN COMMITTED, every submit — automatic
      // retry or the manual one after give-up — must replay the committed
      // body byte-for-byte (same key AND same payload); until then each
      // submit sends the fresh build and becomes the candidate snapshot.
      const submitBody =
        sideEffectsCommittedRef.current && lastSubmitBodyRef.current
          ? lastSubmitBodyRef.current
          : body;
      lastSubmitBodyRef.current = submitBody;
      const result = await onSubmit(service.id, submitBody);
      if (finishCompletionSuccess(result) === "closed") return;
    } catch (e) {
      // Any outcome but another quiet side-effects retry ends the retry
      // COUNT — the committed flag and body snapshot deliberately survive
      // (see the ref declarations): after a committed 409, even the manual
      // resubmit the give-up copy instructs must replay the committed body.
      const sideEffectsRetryCount = sideEffectsRetryRef.current;
      sideEffectsRetryRef.current = 0;
      if (shouldResetCompletionIdempotencyKey(e)) {
        completionIdempotencyKeyRef.current = null;
      }
      // Reconciliation prompt (409, key preserved): the tech either
      // confirms — one resubmit with the flag set — or goes back to fix
      // the typed fields / regenerate the AI report.
      const reconcileText = completionReconcilePrompt(e);
      if (reconcileText) {
        setSubmitting(false);
        if (window.confirm(reconcileText)) {
          return handleSubmit(true);
        }
        return;
      }
      if (e?.code === "backfill_invoice_mint_failed") {
        // The closeout committed but its REQUIRED invoice didn't mint. Mark
        // the visit as owing a resume so the dispatch page can reopen this
        // panel for the (now completed) visit even after a reload — the
        // re-submitted completion replays through the server's resume claim
        // and retries the mint.
        try {
          localStorage.setItem(completionResumeOwedKey(service.id), "1");
        } catch { /* storage full — the mounted panel's retry still works */ }
      } else if (e?.code === "completion_resume_payload_mismatch") {
        // A marker-resume rebuilt from the draft can differ from the
        // committed body (photos live only in memory). The closeout itself
        // is saved; the office bills the visit from Billing Recovery — stop
        // re-offering a resume that can never match, and drop the committed
        // snapshot with it.
        sideEffectsCommittedRef.current = false;
        lastSubmitBodyRef.current = null;
        try {
          localStorage.removeItem(completionResumeOwedKey(service.id));
        } catch { /* ignore */ }
        alert(
          "This closeout is already saved — the retry didn't match the original submission (photos don't survive a reload). The office can bill the visit from Billing Recovery.",
        );
        setSubmitting(false);
        return;
      }
      // Committed completion, side effects still running (see the
      // completionSideEffectsRetryPlan contract): retry the same key AND
      // the same chain-opening body quietly — the button keeps showing its
      // completing state — and only give up with honest copy after the
      // polling window.
      if (completionCrossKeyCompleted(e, sideEffectsCommittedRef.current)) {
        return resolveCrossKeyCompleted();
      }
      const retryPlan = completionSideEffectsRetryPlan(e, sideEffectsRetryCount);
      if (retryPlan?.action === "retry") {
        // The 409 itself proves the visit is COMMITTED — persist the reopen
        // marker now, not only at give-up: a mid-poll network/5xx error
        // exits through the generic path with the chain state cleared, and
        // without the marker DispatchPageV2 refuses to reopen the completed
        // visit after a reload (codex P1 r4). Success removes it.
        try {
          localStorage.setItem(completionResumeOwedKey(service.id), "1");
        } catch { /* storage unavailable — the mounted panel's retry still works */ }
        sideEffectsCommittedRef.current = true;
        sideEffectsRetryRef.current = sideEffectsRetryCount;
        return pollCompletionSideEffects(reconcileConfirmed);
      }
      if (retryPlan?.action === "give_up") {
        // Reached when the 409 lands with the poll budget already spent —
        // the durable marker is what lets DispatchPageV2 reopen a COMPLETED
        // visit's panel after a reload (codex P1 r3; same marker as
        // backfill_invoice_mint_failed).
        try {
          localStorage.setItem(completionResumeOwedKey(service.id), "1");
        } catch { /* storage unavailable — the mounted panel's retry still works */ }
        if (!completionPanelClosedRef.current) {
          alert(retryPlan.message);
          setSubmitting(false);
        }
        return;
      }
      if (!completionPanelClosedRef.current) {
        alert("Failed to complete service: " + e.message);
      }
    }
    setSubmitting(false);
  }

  const filteredProducts = (products || []).filter((p) =>
    `${p.name} ${p.display_name || ""}`
      .toLowerCase()
      .includes(productSearch.toLowerCase()),
  );
  function isProtocolActionSelected(action) {
    const noteText = action?.note || action?.label || action?.raw || "";
    // After an AI draft the notes are clean prose (no tagged lines), so check
    // the authoritative label array instead of the notes text.
    const inSelection = chipLinesDetached
      ? selectedProtocolActionLabels.some(
          (label) =>
            String(label).trim().toLowerCase() ===
            noteText.trim().toLowerCase(),
        )
      : notes.includes(noteText);
    return (
      (!!noteText && inSelection) ||
      (action?.product?.id &&
        selectedProducts.some((p) => p.productId === action.product.id))
    );
  }
  // Lawn closeouts are product-backed-only: no generic pest fallback chips
  // (a scout-only or unmatched-catalog visit must not surface "Cobweb sweep"),
  // and an empty list hides the field instead of exposing the fallback.
  const protocolActionFallbackChips = isLawn ? [] : CHIP_ACTIONS;
  const hideProtocolActionsField =
    isLawn &&
    !protocolActionsLoading &&
    !protocolActionError &&
    protocolActions.length === 0;
  const protocolActionSelectOptions = protocolActions.map((action, index) => ({
    value: action.id ? String(action.id) : `action-${index}`,
    label: action.label || action.note || action.raw || "Protocol action",
    selected: isProtocolActionSelected(action),
    action,
  }));
  const selectedProtocolActionCount = protocolActionSelectOptions.filter(
    (opt) => opt.selected,
  ).length;
  // After an AI draft, the tagged chip lines no longer ride in the notes, so
  // the still-selected structured items render as removable pills below the
  // notes box — the ×-pill replaces delete-the-line as the deselect handle.
  const detachedSelectionEntries = chipLinesDetached
    ? [
        ...activeSelectedLabels(selectedProtocolActionLabels).map((label) => ({
          kind: "protocol",
          prefix: "Protocol",
          label,
        })),
        ...activeSelectedLabels(selectedObservationLabels).map((label) => ({
          kind: "observation",
          prefix: "Found",
          label,
        })),
        ...activeSelectedLabels(selectedRecommendationLabels).map((label) => ({
          kind: "recommendation",
          prefix: "Next",
          label,
        })),
      ]
    : [];
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
  function markTypedFirstFieldTouch() {
    if (!completionTelemetryRef.current.firstFieldTouchedAt) {
      completionTelemetryRef.current.firstFieldTouchedAt =
        new Date().toISOString();
    }
  }
  // A typed edit AFTER generation settles invalidates an UNTOUCHED draft —
  // the installed prose described the old facts, and completion would
  // publish it beside contradicting structured findings (codex r23). Prose
  // the tech already edited is their reviewed copy and stays.
  function invalidateGeneratedReportOnTypedEdit() {
    const installed = generatedReportTextRef.current;
    if (!installed) return;
    generatedReportTextRef.current = null;
    if (String(notes || "").trim() === installed) {
      setNotes("");
      setAiReportUsed(false);
      setGeneratedReportCleared(true);
    }
  }
  function handleTypedFindingChange(key, value) {
    // While a Generate request is in flight the snapshot must stay what the
    // model saw — the disabled fieldset stops taps, but a running per-field
    // SpeechRecognition still fires onresult -> onFieldChange (codex r12),
    // so the WRITE is the freeze point.
    if (generating) return;
    invalidateGeneratedReportOnTypedEdit();
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
    // While a Generate request is in flight the snapshot must stay what the
    // model saw — the disabled fieldset stops taps, but a running per-field
    // SpeechRecognition still fires onresult -> onFieldChange (codex r12),
    // so the WRITE is the freeze point.
    if (generating) return;
    invalidateGeneratedReportOnTypedEdit();
    markTypedFirstFieldTouch();
    // First tap pins technician-set, even when the value doesn't change.
    setTypedActivityTouched(true);
    setTypedActivityScore(n);
  }
  function toggleTypedNextStepChip(chip) {
    // While a Generate request is in flight the snapshot must stay what the
    // model saw — the disabled fieldset stops taps, but a running per-field
    // SpeechRecognition still fires onresult -> onFieldChange (codex r12),
    // so the WRITE is the freeze point.
    if (generating) return;
    invalidateGeneratedReportOnTypedEdit();
    markTypedFirstFieldTouch();
    setTypedNextStepChips((prev) => {
      if (prev.includes(chip)) return prev.filter((c) => c !== chip);
      if (prev.length >= 4) return prev;
      return [...prev, chip];
    });
  }
  function handleTypedRecommendationsChange(value) {
    // While a Generate request is in flight the snapshot must stay what the
    // model saw — the disabled fieldset stops taps, but a running per-field
    // SpeechRecognition still fires onresult -> onFieldChange (codex r12),
    // so the WRITE is the freeze point.
    if (generating) return;
    invalidateGeneratedReportOnTypedEdit();
    markTypedFirstFieldTouch();
    setTypedRecommendations(value);
    setTypedRecommendationsEdited(true);
  }
  // Companion section handlers — mirror the primary typed handlers PER
  // companion type, including derive-then-pin: while a companion's gauge is
  // untouched, its score recomputes from the schema's derive-field select on
  // every change; the first tap pins technician-set.
  function handleCompanionFieldChange(type, key, value) {
    // While a Generate request is in flight the snapshot must stay what the
    // model saw — the disabled fieldset stops taps, but a running per-field
    // SpeechRecognition still fires onresult -> onFieldChange (codex r12),
    // so the WRITE is the freeze point.
    if (generating) return;
    invalidateGeneratedReportOnTypedEdit();
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
    // While a Generate request is in flight the snapshot must stay what the
    // model saw — the disabled fieldset stops taps, but a running per-field
    // SpeechRecognition still fires onresult -> onFieldChange (codex r12),
    // so the WRITE is the freeze point.
    if (generating) return;
    invalidateGeneratedReportOnTypedEdit();
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
    // While a Generate request is in flight the snapshot must stay what the
    // model saw — the disabled fieldset stops taps, but a running per-field
    // SpeechRecognition still fires onresult -> onFieldChange (codex r12),
    // so the WRITE is the freeze point.
    if (generating) return;
    invalidateGeneratedReportOnTypedEdit();
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
  // Optional AI photo analysis — sends the attached photos (still local
  // data-URLs pre-submit) for a customer-facing summary + per-photo
  // captions. Failures surface inline and never block submit. Typed
  // completions ground the vision prompt in the findings form; basic
  // completions (owner 2026-07-30) ground it in the notes/observations,
  // and the tech can pull the summary into the notes.
  async function handlePhotoAnalyze() {
    if (photoAnalyzing || !servicePhotos.length) return;
    if (isTypedFindings && !typedFindingsSchema) return;
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
            ...(isTypedFindings
              ? {
                  structuredFindings: {
                    type: typedFindingsSchema.type,
                    values: findingsValues,
                  },
                }
              : {
                  // Observations only — raw technician notes never reach a
                  // customer-facing LLM (AGENTS.md report/track egress).
                  context: {
                    observations: freeTextLines(observationsText),
                  },
                }),
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
      fontWeight: 500,
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
      fontWeight: 500,
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
          role="dialog"
          aria-modal="true"
          aria-labelledby={`completion-panel-title-${service.id}`}
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
          {success && (
            <div
              style={{
                // Fixed, not absolute: the panel scrolls, and completion is
                // triggered from its bottom — an absolute overlay renders at
                // the top of the scrolled content, off-screen (owner 07-29).
                position: "fixed",
                inset: 0,
                background: "rgba(250,250,250,0.96)",
                display: "flex",
                flexDirection: "column",
                // Scrollable, with margin-auto centering on the inner wrapper
                // (not justifyContent center — centered flex overflow clips
                // the top unreachably on short/landscape viewports when the
                // recap card or follow-up CTAs make the content tall).
                overflowY: "auto",
                WebkitOverflowScrolling: "touch",
                zIndex: 10,
                padding: 24,
              }}
            >
              <div
                style={{
                  margin: "auto",
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  width: "100%",
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
                  fontWeight: 500,
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
                {completionResult?.typedDeliveryMode === "disabled"
                  ? "Completion recorded"
                  : completionResult?.typedDeliveryMode === "internal_only"
                    ? "Report stored internally"
                    : completionResult?.completionSmsStatus === "sent"
                      ? "SMS + report sent"
                      : completionResult?.completionSmsStatus === "blocked"
                        ? `Report saved. SMS blocked${completionResult?.completionSmsError ? `: ${completionResult.completionSmsError}` : ""}`
                        : completionResult?.completionSmsStatus === "failed"
                          ? `Report saved. SMS failed${completionResult?.completionSmsError ? `: ${completionResult.completionSmsError}` : ""}`
                          : "Report saved"}{" "}
                for {service.customerName}
              </div>{" "}
              {/* Advisories recorded on the completion (inventory shortfall,
                  blackout, annual-N, …) — surfaced here per owner 2026-08-03,
                  reversing the 2026-07-29 minimal-success-screen call; they
                  are also recorded server-side and surface in Customer 360. */}
              {Array.isArray(completionResult?.completionAdvisories) &&
                completionResult.completionAdvisories.length > 0 && (
                  <div
                    style={{
                      fontFamily: font,
                      fontSize: 14,
                      color: M.warn,
                      background: M.warn + "14",
                      border: `1px solid ${M.warn}`,
                      borderRadius: 10,
                      padding: "10px 12px",
                      marginTop: 10,
                      maxWidth: 360,
                      textAlign: "left",
                      lineHeight: 1.4,
                    }}
                  >
                    {completionResult.completionAdvisories.map((msg, i) => (
                      <div key={i} style={{ marginTop: i ? 6 : 0 }}>
                        {msg}
                      </div>
                    ))}
                  </div>
                )}
              {["internal_only", "disabled"].includes(completionResult?.typedDeliveryMode) && (
                <div
                  style={{
                    fontFamily: font,
                    fontSize: 13,
                    color: M.ink3,
                    marginTop: 8,
                    textAlign: "center",
                  }}
                >
                  {completionResult.typedDeliveryMode === "internal_only"
                    ? "Report stored — customer delivery is off for this service type."
                    : "Customer delivery is off for this service — no report or SMS was sent."}
                </div>
              )}
              {recapEligible && (
                <div style={{ marginTop: 18, width: "100%", maxWidth: 360 }}>
                  <PestRecapCard serviceId={service.id} />
                </div>
              )}
              {(recapEligible ||
                (completionResult?.completionAdvisories?.length ?? 0) > 0) &&
                !completionResult?.followupSuggestion?.required && (
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
            </div>
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
                width: 44,
                height: 44,
                minWidth: 44,
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
                id={`completion-panel-title-${service.id}`}
                style={{
                  fontFamily: font,
                  fontSize: 17,
                  fontWeight: 500,
                  color: M.ink,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                Complete service
              </div>{" "}
            </div>
            {onViewDetails ? (
              <button
                type="button"
                onClick={() => onViewDetails(service)}
                style={{
                  height: 44,
                  minWidth: 72,
                  borderRadius: 999,
                  background: M.card,
                  border: `1px solid ${M.hairline}`,
                  color: M.ink,
                  fontFamily: font,
                  fontSize: 13,
                  fontWeight: 500,
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
            {/* Visit recap (pest) — below the title, top of the form body */}
            {recapEligible && (
              <div style={{ marginBottom: 16 }}>
                <RecapCapture serviceId={service.id} />
                <PestRecapCard serviceId={service.id} />
              </div>
            )}
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
                    fontWeight: 500,
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
            {/* Customer contact card — name + tap-to-navigate / call / email */}
            <div style={{ marginBottom: 20, lineHeight: 1.5 }}>
              {(service.customerId || service.customer_id) ? (
                <a
                  href={`/admin/customers?customerId=${encodeURIComponent(service.customerId || service.customer_id)}`}
                  style={{
                    display: "block",
                    fontFamily: font,
                    fontSize: 16,
                    fontWeight: 500,
                    color: M.ink,
                    marginBottom: 4,
                    textDecoration: "underline",
                    cursor: "pointer",
                  }}
                >
                  {service.customerName}
                </a>
              ) : (
                <div
                  style={{
                    fontFamily: font,
                    fontSize: 16,
                    fontWeight: 500,
                    color: M.ink,
                    marginBottom: 4,
                  }}
                >
                  {service.customerName}
                </div>
              )}
              {service.address ? (
                <a
                  href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(service.address)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ display: "block", fontFamily: font, fontSize: 13, color: M.ink, textDecoration: "underline", marginTop: 2 }}
                >
                  {service.address}
                </a>
              ) : null}
              {service.customerPhone ? (
                <a
                  href={`tel:${service.customerPhone}`}
                  style={{ display: "block", fontFamily: font, fontSize: 13, color: M.ink, textDecoration: "underline", marginTop: 2 }}
                >
                  {service.customerPhone}
                </a>
              ) : null}
              {customerEmail ? (
                <a
                  href={`mailto:${customerEmail}`}
                  style={{ display: "block", fontFamily: font, fontSize: 13, color: M.ink, textDecoration: "underline", marginTop: 2, wordBreak: "break-word" }}
                >
                  {customerEmail}
                </a>
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
                    fontWeight: 500,
                    color: M.ink,
                    fontVariantNumeric: "tabular-nums",
                    lineHeight: 1.15,
                  }}
                >
                  {elapsed}
                </div>{" "}
              </div>
            )}
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
                  disabled={isIncompleteVisit || submitting || generating}
                  onConfirmed={handleLawnAssessmentConfirmed}
                  onReady={setLawnAssessmentReady}
                  showGaugePhoto={turfHeightFlag}
                  gaugePhoto={turfHeight.gaugePhoto}
                  onGaugePhoto={(p) => setTurfHeight((v) => ({ ...v, gaugePhoto: p }))}
                  gaugeHeightIn={turfHeight.heightIn}
                  onGaugeHeight={(v) => setTurfHeight((t) => ({ ...t, heightIn: v }))}
                  technicianNotes={notes}
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
              <Field label="Lawn Care Protocol">
                <ProtocolMixSummary
                  protocol={treatmentPlanStructuredProtocol}
                  mixItems={treatmentPlanMixItems}
                  carrierGalPer1000={
                    protocolCarrierGalPer1000 ||
                    treatmentPlanStructuredProtocol.window.defaultCarrierGalPer1000
                  }
                  inventoryBlocks={treatmentPlanInventoryBlocks}
                  theme={{
                    card: M.card,
                    border: M.hairline,
                    ink: M.ink,
                    muted: M.ink3,
                    err: M.err,
                    errBg: M.err + "10",
                    font,
                  }}
                />
              </Field>
            )}
            {closeoutAdvisories.length > 0 && (
              <div
                style={{
                  marginBottom: 12,
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: `1px solid ${M.hairline}`,
                  background: M.card,
                }}
              >
                {closeoutAdvisories.map((text, i) => (
                  <div
                    key={i}
                    style={{
                      fontFamily: font,
                      fontSize: 12,
                      color: M.ink3,
                      lineHeight: 1.35,
                      marginTop: i === 0 ? 0 : 6,
                    }}
                  >
                    ⚠️ {text}
                  </div>
                ))}
              </div>
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
                      width: 44,
                      height: 44,
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
                    {dictation.listening ? <MicOff size={16} strokeWidth={2.2} /> : <Mic size={16} strokeWidth={2.2} />}
                  </button>
                )}
              </div>
            </Field>
            {/* Post-AI-draft structured selections — the tagged lines no
                longer ride in the report text, so the pills are the deselect
                handle (tap × to remove an item before completing). */}
            {detachedSelectionEntries.length > 0 && (
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: 6,
                  marginTop: -8,
                  marginBottom: 16,
                }}
              >
                {detachedSelectionEntries.map(({ kind, prefix, label }) => (
                  <span
                    key={`${kind}:${label}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 6,
                      fontFamily: font,
                      fontSize: 12,
                      color: M.ink2,
                      background: M.muted,
                      border: `1px solid ${M.hairline}`,
                      borderRadius: 999,
                      padding: "4px 6px 4px 10px",
                    }}
                  >
                    <span style={{ color: M.ink3 }}>{prefix}:</span>
                    {label}
                    <button
                      type="button"
                      aria-label={`Remove ${prefix.toLowerCase()} item: ${label}`}
                      onClick={() => removeSelectedLabel(kind, label)}
                      style={{
                        border: "none",
                        background: "transparent",
                        color: M.ink3,
                        fontSize: 14,
                        lineHeight: 1,
                        padding: "2px 4px",
                        cursor: "pointer",
                      }}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
            {!isTypedFindings && !hideProtocolActionsField && (
              <Field label="Protocol actions">
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
                        : protocolActionFallbackChips.map((chip) => (
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
            {/* Frozen while an AI draft is in flight (codex P2) — the
                generate payload snapshots these fields, and an edit landing
                mid-request would ship a summary that contradicts what the
                completion then persists (same rule the old chip handlers
                enforced with their `generating` guard). Observations also
                freeze during photo analysis (codex r9): they're the vision
                prompt's context on basic completions, and captions returned
                against a stale snapshot would persist under the photos. */}
            <Field label="Observations">
              {" "}
              <textarea
                aria-label="Observations"
                value={observationsText}
                onChange={(e) => setObservationsText(e.target.value)}
                rows={2}
                placeholder="Optional — anything you noticed (one per line)"
                disabled={generating || photoAnalyzing}
                style={{ ...mTextarea, opacity: generating || photoAnalyzing ? 0.55 : 1 }}
              />{" "}
            </Field>
            <Field label="Recommendations">
              {" "}
              <textarea
                aria-label="Recommendations"
                value={recommendationsText}
                onChange={(e) => setRecommendationsText(e.target.value)}
                rows={2}
                placeholder="Optional — next steps if needed (one per line)"
                disabled={generating}
                style={{ ...mTextarea, opacity: generating ? 0.55 : 1 }}
              />{" "}
            </Field>
            {/* AI report — drafts customer-facing visit copy into the notes box
                from the structured visit data (actions, observations, products,
                concern), for the tech to review/edit before completing. */}
            {!quickComplete && (
              <label
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 13,
                  color: "#71717A",
                  cursor: "pointer",
                  marginBottom: 6,
                }}
              >
                <input
                  type="checkbox"
                  checked={aiReportIncludeComms}
                  onChange={(e) => setAiReportIncludeComms(e.target.checked)}
                  style={{ width: 16, height: 16 }}
                />
                Include recent customer calls/texts/emails
              </label>
            )}
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
                    if (r.report) applyGeneratedReport(r.report, { deterministic: r.deterministic === true });
                  } catch (e) {
                    alert("AI report failed: " + e.message);
                  }
                  setGenerating(false);
                }}
                disabled={generating
                  || (isLawn && lawnAssessmentReady === false)
                  // A mid-load station registry would land counts AFTER the
                  // model saw the snapshot (the paused autofill re-runs when
                  // generating settles) — hold generation until it resolves
                  // (codex r6).
                  || (stationFeatureOn && stationRegistryState === "loading")}
                style={{
                  ...secondaryPill,
                  marginTop: 4,
                  marginBottom: 20,
                  opacity: generating ? 0.5 : 1,
                }}
              >
                {generating ? "Generating…" : "Generate AI report"}
              </button>
            )}
            {!quickComplete && generatedReportCleared && (
              <div style={{ fontSize: 13, color: "#B45309", marginTop: -12, marginBottom: 16 }}>
                Findings changed after the AI report was generated — the draft
                was cleared. Generate again to include the updated findings.
              </div>
            )}
            {/* Service photos — pure lawn visits capture turf photos in the
                Lawn Assessment block above, which flow into the report gallery,
                so this redundant second upload is hidden. Combined visits keep
                it (companions have their own completion-photo gates). */}
            {/* Interior-only treatments (bed bug) skip the tracer: it is a
                SATELLITE perimeter tool, and an exterior spray outline on an
                interior treatment's report would be wrong. Photos carry the
                visual story; a room-level interior marker is its own lane.
                Rodent trapping skips it too — nothing is sprayed on a trapping
                stop, and the trap map below is that visit's spatial story
                (owner 2026-08-02). */}
            {/* traceEligible rides the schedule feed (GATE_TRACE_ELIGIBILITY):
                bait/inspection/exclusion visits hide the tracer here too —
                the standalone TechHome button was only one of the two entry
                points, and inviting a trace the save route will 403 is a
                dead end (codex P2 r1). Absent flag (other feeds, gate off)
                keeps today's behavior; the named lane checks stay as belt. */}
            {!quickComplete && !isBedBugVisit && !isRodentTrappingVisit
              && service.traceEligible !== false && (
              <Field label="Treatment zone map">
                <button
                  type="button"
                  onClick={() => setZoneMapOpen(true)}
                  style={secondaryPill}
                >
                  {traceOutlineMode
                    ? (isMosquitoTrace ? "Outline the treated yard" : "Outline the treated lawn")
                    : "Trace where we sprayed"}
                </button>
                {zoneMapOpen && (
                  <TechTreatmentZoneModal
                    serviceId={service.id}
                    customerName={service.customerName || "Customer"}
                    address={service.address || ""}
                    lat={service.lat ?? service.customer_latitude}
                    lng={service.lng ?? service.customer_longitude}
                    onClose={() => setZoneMapOpen(false)}
                    onSaved={applyTracedTreatmentZone}
                    appearance="light"
                    lawnMode={traceOutlineMode}
                    yardMode={isMosquitoTrace}
                  />
                )}
                <span style={{ fontSize: 13, color: "var(--muted, #667085)", marginLeft: 10 }}>
                  {traceOutlineMode
                    ? (isMosquitoTrace
                      ? "Auto-trace the yard — lawn and landscape beds — on the satellite photo; it renders as the treated-area outline on the customer report."
                      : "Auto-trace the lawn on the satellite photo — it renders as a highlighted treated-area outline on the customer report.")
                    : "Auto-trace the perimeter on the satellite photo — it renders as the spray map on the customer report."}
                </span>
              </Field>
            )}
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
                {/* AI photo analysis — typed services persist the summary via
                    the typedReportSnapshot; basic completions (owner
                    2026-07-30) let the tech pull it into the notes. */}
                {servicePhotos.length > 0 && (
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
                        <div style={{ fontSize: 14, fontWeight: 500, color: M.ink, marginBottom: 4 }}>
                          {isTypedFindings
                            ? "Photo summary (appears on the customer report)"
                            : "Photo summary — review, then add to notes if useful"}
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
                        {!isTypedFindings && (
                          <button
                            type="button"
                            onClick={() => {
                              const summary = typedPhotoSummary.trim();
                              if (!summary) return;
                              setNotes((prev) =>
                                prev.trim() ? `${prev.trimEnd()}\n\n${summary}` : summary,
                              );
                            }}
                            disabled={!typedPhotoSummary.trim() || generating}
                            style={{
                              ...secondaryPill,
                              marginTop: 8,
                              opacity: !typedPhotoSummary.trim() || generating ? 0.5 : 1,
                            }}
                          >
                            Add to technician notes
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </Field>
            )}
            {/* Bait station map — pins + per-visit statuses (station-map-v1) */}
            {stationFeatureOn && (
              <StationMarkingStep
                map={propertyMap}
                stations={stationDisplay}
                statuses={stationStatuses}
                onAddStation={addStationPin}
                onMoveStation={moveStationPin}
                onSetStatus={setStationStatus}
                onRemoveStation={removeStationPin}
                program={stationProgram || "termite"}
                maxStations={Number(propertyMap?.stationCap) || 80}
                disallowServiced={stationProgram === "trapping" && declaresTrapSetup}
                disabled={generating || success || stationRegistryFailed}
              />
            )}
            {((stationEditsBlocked && !stationEditsBlockTransient)
              || (stationFeatureOn && stationRegistryNoteVisible)) && (
              <div style={{ fontSize: 14, color: "#b45309", marginTop: 6 }}>
                {stationEditsBlocked ? (
                  <>
                    Existing {stationProgram === "trapping" ? "traps" : "stations"} couldn&apos;t
                    be confirmed for this completion, so the map edits restored from your draft
                    can&apos;t be saved with it. Reload to retry, or discard them to complete without.{" "}
                    <button
                      type="button"
                      onClick={discardStationEdits}
                      style={{
                        fontSize: 14, textDecoration: "underline", background: "none",
                        border: "none", padding: 0, color: "inherit", cursor: "pointer",
                      }}
                    >
                      Discard {stationProgram === "trapping" ? "trap" : "station"} edits
                    </button>
                  </>
                ) : (
                  <>
                    Existing {stationProgram === "trapping" ? "traps" : "stations"} couldn&apos;t
                    be loaded, so marking is unavailable for this completion. Complete the visit
                    normally — the registry is unchanged.
                  </>
                )}
              </div>
            )}
            {/* Service findings — typed specialty completion */}
            {isTypedFindings && (
              <TypedFindingsSection
                variant="mobile"
                frozen={generating}
                pesticideProductPresent={pesticideProductPresent}
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
                  frozen={generating}
                  pesticideProductPresent={pesticideProductPresent}
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
                        {p.display_name || p.name}
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
                          {p.display_name || p.name}
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
                          fontWeight: 500,
                          color: M.ink,
                          flex: 1,
                          minWidth: 120,
                        }}
                      >
                        {sp.displayName || sp.name}
                      </span>{" "}
                      <span style={{ fontSize: 12, fontWeight: 500, color: M.ink3 }}>
                        {sp.areaUnit === "sqft" ? "Rate /1k sq ft" : "Rate"}
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
                        <option value="oz/gal">oz/gal</option>{" "}
                        <option value="fl_oz/gal">fl oz/gal</option>{" "}
                        <option value="g/gal">g/gal</option>{" "}
                      </select>{" "}
                      <span style={{ fontSize: 12, fontWeight: 500, color: M.ink3 }}>
                        Total used
                      </span>{" "}
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
                      {areasServiced.length > 0 && (() => {
                        const selectedAreas = parseApplicationAreas(
                          sp.applicationArea,
                        );
                        const areaChoices = productAreaChoices(
                          areasServiced,
                          sp.applicationArea,
                        );
                        return (
                          <div
                            style={{
                              flexBasis: "100%",
                              display: "flex",
                              flexWrap: "wrap",
                              gap: 6,
                            }}
                          >
                            <span
                              style={{
                                width: "100%",
                                fontSize: 12,
                                fontWeight: 500,
                                color: M.ink3,
                              }}
                            >
                              Treatment areas
                            </span>
                            {areaChoices.map((area) => (
                              <Chip
                                key={area}
                                selected={selectedAreas.includes(area)}
                                onClick={() =>
                                  updateProduct(
                                    sp.productId,
                                    "applicationArea",
                                    toggleProductAreaValue(
                                      sp.applicationArea,
                                      area,
                                      areaChoices,
                                    ),
                                  )
                                }
                              >
                                {area}
                              </Chip>
                            ))}
                          </div>
                        );
                      })()}
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
                        <option value="soil_drench">Soil drench</option>
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
                      {(() => {
                        // Fall back to the selected row's serialized category
                        // when the catalog row is absent (protocol- or
                        // substitution-added products), so fertilizer rows keep
                        // the nutrition suggestions and excluded helper
                        // categories stay hidden.
                        const pickerProduct = (products || []).find(
                          (p) => String(p.id) === String(sp.productId),
                        ) || sp;
                        if (!productControlsTargets(pickerProduct)) return null;
                        const picker = targetPickerConfig(pickerProduct, {
                          isLawn,
                          isTreeShrub,
                        });
                        return (
                        <ProductTargetsPicker
                          idSuffix={sp.productId}
                          targets={sp.targets}
                          suggestions={picker.suggestions}
                          noun={picker.noun}
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
                        );
                      })()}
                    </div>
                  ))}
                </div>
              )}
            </Field>
            {/* Areas serviced — hidden for Tree & Shrub and rodent lines
                (owner 2026-07-23): the chips are structural-pest rooms/zones;
                those visits carry their own location semantics (zone trace,
                trap locations, entry points, station map). */}
            {!quickComplete && !areasTreatedHidden && (
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
                </div>
              </Field>
            )}
            {/* The customer-facing report summary is now auto-generated from the
                technician notes at completion (server: CompletionRecap.generateRecap)
                — no manual "Customer recap" box or SMS preview here. */}
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
                <div
                  style={{
                    display: "flex",
                    gap: 8,
                    flexWrap: "wrap",
                    justifyContent: "center",
                  }}
                >
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
                          fontWeight: 500,
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
                    textAlign: "center",
                  }}
                >
                  0 = none, 5 = severe. Tap a number again to clear.
                </div>
              </Field>
            )}
            {/* Options */}
            <Field label="Options">
              {" "}
              {payerBanner && (
                <div
                  style={{
                    padding: "12px 16px",
                    marginBottom: 8,
                    background: "#FFF7ED",
                    border: "1px solid #FDBA74",
                    borderRadius: 12,
                    fontFamily: font,
                    fontSize: 14,
                    color: "#9A3412",
                  }}
                >
                  {payerBanner}
                </div>
              )}{" "}
              {/* Inspection credit — DEFAULT ON. The customer is promised
                  the inspection fee toward anything they book in the
                  window; the credit only becomes real money when they
                  actually book. Clearing this is the opt-out for the rare
                  inspection that shouldn't carry it. */}
              {isInspectionVisit && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    padding: "12px 16px",
                    margin: "0 0 8px",
                    background: M.card,
                    border: `0.5px solid ${M.hairline}`,
                    borderRadius: 12,
                    cursor: "pointer",
                  }}
                >
                  {" "}
                  <input
                    type="checkbox"
                    checked={offerInspectionCredit}
                    onChange={(e) => setOfferInspectionCredit(e.target.checked)}
                    style={{ width: 18, height: 18, accentColor: M.ink, marginTop: 1 }}
                  />{" "}
                  <span style={{ fontFamily: font, fontSize: 14, color: M.ink }}>
                    Credit this inspection toward booked service
                    <span
                      style={{
                        display: "block",
                        fontSize: 12,
                        color: M.ink3,
                        marginTop: 2,
                      }}
                    >
                      Applies as account credit only if they book — nothing is
                      credited now.
                    </span>
                  </span>{" "}
                </label>
              )}{" "}
              {/* Bed bug never offers the no-invoice recap: a performed
                  treatment must mint its invoice (typed-era parity; the
                  server 409s this too — codex P1 r7). */}
              {!isBedBugVisit && (
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
              </label>
              )}{" "}
              {backfillEligible && (
                <label
                  style={{
                    display: "flex",
                    alignItems: "flex-start",
                    gap: 12,
                    padding: "14px 16px",
                    background: M.card,
                    border: `0.5px solid ${backfillCloseout ? M.ink : M.hairline}`,
                    borderRadius: 12,
                    marginBottom: 8,
                    cursor: "pointer",
                  }}
                >
                  {" "}
                  <input
                    type="checkbox"
                    checked={backfillCloseout}
                    onChange={(e) => setBackfillCloseout(e.target.checked)}
                    style={{
                      width: 18,
                      height: 18,
                      accentColor: M.ink,
                      marginTop: 1,
                    }}
                  />{" "}
                  <span style={{ fontFamily: font, fontSize: 15, color: M.ink }}>
                    Backdated closeout — {backfillDaysPast} day
                    {backfillDaysPast === 1 ? "" : "s"} past its date
                    <span
                      style={{
                        display: "block",
                        fontSize: 14,
                        color: M.ink3,
                        marginTop: 2,
                      }}
                    >
                      {backfillCloseout
                        ? "Records to the visit day, sends no customer messages, and skips auto-charge."
                        : "Unchecked: completes as today with the normal customer messages."}
                    </span>
                  </span>{" "}
                </label>
              )}{" "}
              {backfillEligible && backfillCloseout && (
                <div
                  style={{
                    padding: "14px 16px",
                    background: M.card,
                    border: `0.5px solid ${M.hairline}`,
                    borderRadius: 12,
                    marginBottom: 8,
                  }}
                >
                  {" "}
                  <span
                    style={{
                      display: "block",
                      fontFamily: font,
                      fontSize: 15,
                      color: M.ink,
                      marginBottom: 8,
                    }}
                  >
                    Time on site (minutes)
                  </span>{" "}
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="720"
                    step="1"
                    value={backfillTimeOnSite}
                    onChange={(e) => setBackfillTimeOnSite(e.target.value)}
                    placeholder="Unknown"
                    style={mInput}
                  />{" "}
                  <span
                    style={{
                      display: "block",
                      fontFamily: font,
                      fontSize: 14,
                      color: M.ink3,
                      marginTop: 6,
                    }}
                  >
                    The running timer spans the missed days and is not
                    submitted — leave blank to record no duration.
                  </span>{" "}
                </div>
              )}{" "}
              {liveAdjustEligible && (
                <div
                  style={{
                    padding: "14px 16px",
                    background: M.card,
                    border: `0.5px solid ${M.hairline}`,
                    borderRadius: 12,
                    marginBottom: 8,
                  }}
                >
                  {" "}
                  <span
                    style={{
                      display: "block",
                      fontFamily: font,
                      fontSize: 15,
                      color: M.ink,
                      marginBottom: 8,
                    }}
                  >
                    Adjust time on site (minutes)
                  </span>{" "}
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    max="720"
                    step="1"
                    value={adjustedTimeOnSite}
                    onChange={(e) => setAdjustedTimeOnSite(e.target.value)}
                    placeholder="Use timer"
                    style={mInput}
                  />{" "}
                  <span
                    style={{
                      display: "block",
                      fontFamily: font,
                      fontSize: 14,
                      color: M.ink3,
                      marginTop: 6,
                    }}
                  >
                    Overrides the running timer ({elapsed}) in the recorded
                    duration — use it when the visit wasn't closed out on
                    time. Leave blank to record the timer.
                  </span>{" "}
                </div>
              )}{" "}
              {!isIncompleteVisit &&
                reentrySeeds &&
                (reentrySeeds.exteriorMinutes > 0 ||
                  reentrySeeds.interiorMinutes > 0) && (
                <div
                  style={{
                    padding: "14px 16px",
                    background: M.card,
                    border: `0.5px solid ${M.hairline}`,
                    borderRadius: 12,
                    marginBottom: 8,
                  }}
                >
                  {" "}
                  <span
                    style={{
                      display: "block",
                      fontFamily: font,
                      fontSize: 15,
                      color: M.ink,
                    }}
                  >
                    Re-entry countdown
                  </span>{" "}
                  <span
                    style={{
                      display: "block",
                      fontFamily: font,
                      fontSize: 14,
                      color: M.ink3,
                      marginTop: 2,
                      marginBottom: 12,
                    }}
                  >
                    What the customer's report counts down before treated
                    areas are ready.
                  </span>{" "}
                  {[
                    reentrySeeds.exteriorMinutes > 0 && {
                      key: "exterior",
                      label: "Exterior (dry-down)",
                      value: reentryExtMinutes ?? reentrySeeds.exteriorMinutes,
                      step: 5,
                      onStep: stepReentryExt,
                    },
                    reentrySeeds.interiorMinutes > 0 && {
                      key: "interior",
                      label: "Interior re-entry",
                      value: reentryIntMinutes ?? reentrySeeds.interiorMinutes,
                      step: 15,
                      onStep: stepReentryInt,
                    },
                  ]
                    .filter(Boolean)
                    .map((row, i, rows) => (
                      <div
                        key={row.key}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "space-between",
                          gap: 12,
                          marginBottom: i < rows.length - 1 ? 12 : 0,
                        }}
                      >
                        {" "}
                        <span
                          style={{
                            fontFamily: font,
                            fontSize: 14,
                            color: M.ink2,
                            flex: 1,
                          }}
                        >
                          {row.label}
                          <span
                            style={{
                              display: "block",
                              fontFamily: font,
                              fontSize: 15,
                              color: M.ink,
                              marginTop: 2,
                            }}
                          >
                            {formatReentryStepperMinutes(row.value)}
                          </span>
                        </span>{" "}
                        <button
                          type="button"
                          aria-label={`Decrease ${row.label} by ${row.step} minutes`}
                          disabled={row.value <= 0}
                          onClick={() => row.onStep(-row.step)}
                          style={{
                            minWidth: 56,
                            height: 44,
                            border: `0.5px solid ${M.hairline}`,
                            borderRadius: 10,
                            background: M.muted,
                            color: M.ink,
                            fontFamily: font,
                            fontSize: 15,
                            opacity: row.value <= 0 ? 0.4 : 1,
                          }}
                        >
                          −{row.step}
                        </button>{" "}
                        <button
                          type="button"
                          aria-label={`Increase ${row.label} by ${row.step} minutes`}
                          disabled={row.value >= 1440}
                          onClick={() => row.onStep(row.step)}
                          style={{
                            minWidth: 56,
                            height: 44,
                            border: `0.5px solid ${M.hairline}`,
                            borderRadius: 10,
                            background: M.muted,
                            color: M.ink,
                            fontFamily: font,
                            fontSize: 15,
                            opacity: row.value >= 1440 ? 0.4 : 1,
                          }}
                        >
                          +{row.step}
                        </button>{" "}
                      </div>
                    ))}{" "}
                </div>
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
              {willInvoice && effectiveSendSms && !oneTimeRecapOnly && !payerBanner && (
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
                    fontWeight: 500,
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
                closeoutAdvisoriesPending ||
                treeShrubCompletionBlocked ||
                protocolActualsCompletionBlocked
              }
              style={{
                ...primaryPill,
                opacity:
                  submitting ||
                  closeoutAdvisoriesPending ||
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
        role="dialog"
        aria-modal="true"
        aria-labelledby={`completion-panel-title-${service.id}`}
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
              flexDirection: "column",
              // Scrollable, with margin-auto centering on the inner wrapper —
              // centered flex overflow clips the top unreachably once the
              // advisories/follow-up CTAs make the content taller than the
              // panel (codex P2 r3 on #3179; mirrors the mobile overlay).
              overflowY: "auto",
              zIndex: 10,
              padding: 24,
            }}
          >
            <div
              style={{
                margin: "auto",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                width: "100%",
              }}
            >
            {" "}
            <div style={{ fontSize: 64, marginBottom: 16, color: D.green }}>
              &#10003;
            </div>{" "}
            <div style={{ fontSize: 20, fontWeight: 500, color: D.green }}>
              Service Completed!
            </div>{" "}
            <div style={{ fontSize: 14, color: D.muted, marginTop: 8 }}>
              {completionResult?.typedDeliveryMode === "disabled"
                ? "Completion recorded"
                : completionResult?.typedDeliveryMode === "internal_only"
                  ? "Report stored internally"
                  : !effectiveSendSms
                    ? "Report saved"
                    : completionResult?.completionSmsStatus === "blocked"
                      ? `Report saved. SMS blocked${completionResult?.completionSmsError ? `: ${completionResult.completionSmsError}` : ""}`
                      : completionResult?.completionSmsStatus === "failed"
                        ? `Report saved. SMS failed${completionResult?.completionSmsError ? `: ${completionResult.completionSmsError}` : ""}`
                        : "SMS + Report sent"}{" "}
              for {service.customerName}
            </div>{" "}
            {["internal_only", "disabled"].includes(completionResult?.typedDeliveryMode) && (
              <div
                style={{
                  fontSize: 13,
                  color: D.muted,
                  marginTop: 8,
                  textAlign: "center",
                }}
              >
                {completionResult.typedDeliveryMode === "internal_only"
                  ? "Report stored — customer delivery is off for this service type."
                  : "Customer delivery is off for this service — no report or SMS was sent."}
              </div>
            )}
            {/* Completion advisories (inventory shortfall, blackout, annual-N,
                …) — surfaced per owner 2026-08-03; also in Customer 360. */}
            {Array.isArray(completionResult?.completionAdvisories) &&
              completionResult.completionAdvisories.length > 0 && (
                <div
                  style={{
                    fontSize: 14,
                    color: D.amber,
                    background: D.amber + "14",
                    border: `1px solid ${D.amber}`,
                    borderRadius: 8,
                    padding: "10px 12px",
                    marginTop: 12,
                    maxWidth: 360,
                    textAlign: "left",
                    lineHeight: 1.4,
                  }}
                >
                  {completionResult.completionAdvisories.map((msg, i) => (
                    <div key={i} style={{ marginTop: i ? 6 : 0 }}>
                      {msg}
                    </div>
                  ))}
                </div>
              )}
            {(recapEligible ||
              (completionResult?.completionAdvisories?.length ?? 0) > 0) &&
              !completionResult?.followupSuggestion?.required && (
              <button
                type="button"
                onClick={() => onClose(true)}
                style={{ ...btnBase, width: "100%", maxWidth: 312, marginTop: 20, background: "transparent", color: D.text, border: `1px solid ${D.border}`, fontSize: 14 }}
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
            <div
              id={`completion-panel-title-${service.id}`}
              style={{ fontSize: 18, fontWeight: 500, color: D.heading }}
            >
              Complete Service
            </div>{" "}
            <button
              type="button"
              aria-label="Close complete service"
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
          {(service.customerId || service.customer_id) ? (
            <a
              href={`/admin/customers?customerId=${encodeURIComponent(service.customerId || service.customer_id)}`}
              style={{ display: "block", fontSize: 14, color: D.text, fontWeight: 500, textDecoration: "underline", cursor: "pointer" }}
            >
              {service.customerName}
            </a>
          ) : (
            <div style={{ fontSize: 14, color: D.text, fontWeight: 500 }}>
              {service.customerName}
            </div>
          )}{" "}
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
                    fontWeight: 500,
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
                    fontWeight: 500,
                    color: D.teal,
                    letterSpacing: 1,
                  }}
                >
                  {elapsed}
                </div>{" "}
              </div>{" "}
            </div>
          )}
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
              fontWeight: 500,
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
              <div style={{ fontSize: 14, fontWeight: 500, color: D.heading }}>
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
                disabled={isIncompleteVisit || submitting || generating}
                onConfirmed={handleLawnAssessmentConfirmed}
                onReady={setLawnAssessmentReady}
                showGaugePhoto={turfHeightFlag}
                gaugePhoto={turfHeight.gaugePhoto}
                onGaugePhoto={(p) => setTurfHeight((v) => ({ ...v, gaugePhoto: p }))}
                gaugeHeightIn={turfHeight.heightIn}
                onGaugeHeight={(v) => setTurfHeight((t) => ({ ...t, heightIn: v }))}
                technicianNotes={notes}
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
              <label style={labelStyle}>Lawn Care Protocol</label>
              <div style={{ marginBottom: 10 }}>
                <ProtocolMixSummary
                  protocol={treatmentPlanStructuredProtocol}
                  mixItems={treatmentPlanMixItems}
                  carrierGalPer1000={
                    protocolCarrierGalPer1000 ||
                    treatmentPlanStructuredProtocol.window.defaultCarrierGalPer1000
                  }
                  inventoryBlocks={treatmentPlanInventoryBlocks}
                  theme={{
                    card: D.input,
                    border: D.border,
                    ink: D.heading,
                    muted: D.muted,
                    err: D.red,
                    errBg: D.red + "12",
                  }}
                />
              </div>
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
                        <div style={{ fontWeight: 500, color: D.heading }}>
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
                            fontWeight: 500,
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
            </div>
          )}
          {closeoutAdvisories.length > 0 && (
            <div
              style={{
                marginBottom: 20,
                padding: "10px 12px",
                borderRadius: 8,
                border: `1px solid ${D.border}`,
                background: D.bg,
              }}
            >
              {closeoutAdvisories.map((text, i) => (
                <div
                  key={i}
                  style={{
                    fontSize: 12,
                    color: D.muted,
                    lineHeight: 1.4,
                    marginTop: i === 0 ? 0 : 6,
                  }}
                >
                  ⚠️ {text}
                </div>
              ))}
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
                  width: 44,
                  height: 44,
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
                {dictation.listening ? <MicOff size={16} strokeWidth={2.2} /> : <Mic size={16} strokeWidth={2.2} />}
              </button>
            )}
          </div>
          {/* Post-AI-draft structured selections — the tagged lines no longer
              ride in the report text, so the pills are the deselect handle
              (click × to remove an item before completing). */}
          {detachedSelectionEntries.length > 0 && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: 6,
                marginTop: 8,
              }}
            >
              {detachedSelectionEntries.map(({ kind, prefix, label }) => (
                <span
                  key={`${kind}:${label}`}
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 6,
                    fontSize: 12,
                    color: D.text,
                    background: D.card,
                    border: `1px solid ${D.border}`,
                    borderRadius: 999,
                    padding: "4px 6px 4px 10px",
                  }}
                >
                  <span style={{ color: D.muted }}>{prefix}:</span>
                  {label}
                  <button
                    type="button"
                    aria-label={`Remove ${prefix.toLowerCase()} item: ${label}`}
                    onClick={() => removeSelectedLabel(kind, label)}
                    style={{
                      border: "none",
                      background: "transparent",
                      color: D.muted,
                      fontSize: 14,
                      lineHeight: 1,
                      padding: "2px 4px",
                      cursor: "pointer",
                    }}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          {/* Compact completion quick-picks */}
          <div style={{ marginTop: 10, marginBottom: 16 }}>
            {!isTypedFindings && !hideProtocolActionsField && (
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
                      : protocolActionFallbackChips.map((chip) => (
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
            {/* Frozen while an AI draft is in flight (codex P2) — mirrors
                the mobile variant. Observations also freeze during photo
                analysis (codex r9): they're the vision prompt's context. */}
            <div style={{ marginBottom: 12 }}>
              <label style={{ ...labelStyle, color: D.amber }}>
                Observations
              </label>{" "}
              <textarea
                aria-label="Observations"
                value={observationsText}
                onChange={(e) => setObservationsText(e.target.value)}
                rows={2}
                placeholder="Optional — anything you noticed (one per line)"
                disabled={generating || photoAnalyzing}
                style={{ ...inputStyle, height: "auto", resize: "vertical", opacity: generating || photoAnalyzing ? 0.55 : 1 }}
              />{" "}
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ ...labelStyle, color: D.green }}>
                Recommendations
              </label>{" "}
              <textarea
                aria-label="Recommendations"
                value={recommendationsText}
                onChange={(e) => setRecommendationsText(e.target.value)}
                rows={2}
                placeholder="Optional — next steps if needed (one per line)"
                disabled={generating}
                style={{ ...inputStyle, height: "auto", resize: "vertical", opacity: generating ? 0.55 : 1 }}
              />{" "}
            </div>{" "}
          </div>
          {/* AI Service Report — drafts customer-facing visit copy into the
              notes box from the structured visit data, for the tech to
              review/edit before completing. */}
          {!quickComplete && (
            <label
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 13,
                color: "#71717A",
                cursor: "pointer",
                marginTop: 8,
              }}
            >
              <input
                type="checkbox"
                checked={aiReportIncludeComms}
                onChange={(e) => setAiReportIncludeComms(e.target.checked)}
                style={{ width: 16, height: 16 }}
              />
              Include recent customer calls/texts/emails
            </label>
          )}
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
                  if (r.report) applyGeneratedReport(r.report, { deterministic: r.deterministic === true });
                } catch (e) {
                  alert("AI report failed: " + e.message);
                }
                setGenerating(false);
              }}
              disabled={generating
                || (isLawn && lawnAssessmentReady === false)
                // Same station-registry hold as the mobile Generate button.
                || (stationFeatureOn && stationRegistryState === "loading")}
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
                fontWeight: 500,
                cursor: generating ? "wait" : "pointer",
                marginTop: 8,
                marginBottom: 20,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
              }}
            >
              {generating ? "Generating Report..." : "Generate AI Service Report"}
            </button>
          )}
          {!quickComplete && generatedReportCleared && (
            <div style={{ fontSize: 13, color: "#B45309", marginTop: -14, marginBottom: 18 }}>
              Findings changed after the AI report was generated — the draft
              was cleared. Generate again to include the updated findings.
            </div>
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
                          fontWeight: 500,
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
              {/* AI photo analysis — typed services persist the summary via
                  the typedReportSnapshot; basic completions (owner
                  2026-07-30) let the tech pull it into the notes. */}
              {servicePhotos.length > 0 && (
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
                      <div style={{ fontSize: 14, fontWeight: 500, color: D.text, marginBottom: 4 }}>
                        {isTypedFindings
                          ? "Photo summary (appears on the customer report)"
                          : "Photo summary — review, then add to notes if useful"}
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
                      {!isTypedFindings && (
                        <button
                          type="button"
                          onClick={() => {
                            const summary = typedPhotoSummary.trim();
                            if (!summary) return;
                            setNotes((prev) =>
                              prev.trim() ? `${prev.trimEnd()}\n\n${summary}` : summary,
                            );
                          }}
                          disabled={!typedPhotoSummary.trim() || generating}
                          style={{
                            background: "transparent",
                            color: D.teal,
                            border: `1px solid ${D.teal}`,
                            borderRadius: 8,
                            padding: "8px 14px",
                            fontSize: 14,
                            marginTop: 8,
                            cursor: "pointer",
                            opacity: !typedPhotoSummary.trim() || generating ? 0.5 : 1,
                          }}
                        >
                          Add to technician notes
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
          {/* Bait station map — pins + per-visit statuses (station-map-v1) */}
          {stationFeatureOn && (
            <StationMarkingStep
              map={propertyMap}
              stations={stationDisplay}
              statuses={stationStatuses}
              onAddStation={addStationPin}
              onMoveStation={moveStationPin}
              onSetStatus={setStationStatus}
              onRemoveStation={removeStationPin}
              program={stationProgram || "termite"}
              maxStations={Number(propertyMap?.stationCap) || 80}
              dark
              disallowServiced={stationProgram === "trapping" && declaresTrapSetup}
              disabled={generating || success || stationRegistryFailed}
            />
          )}
          {((stationEditsBlocked && !stationEditsBlockTransient)
            || (stationFeatureOn && stationRegistryNoteVisible)) && (
            <div style={{ fontSize: 14, color: "#fbbf24", marginTop: 6 }}>
              {stationEditsBlocked ? (
                <>
                  Existing {stationProgram === "trapping" ? "traps" : "stations"} couldn&apos;t
                  be confirmed for this completion, so the map edits restored from your draft
                  can&apos;t be saved with it. Reload to retry, or discard them to complete without.{" "}
                  <button
                    type="button"
                    onClick={discardStationEdits}
                    style={{
                      fontSize: 14, textDecoration: "underline", background: "none",
                      border: "none", padding: 0, color: "inherit", cursor: "pointer",
                    }}
                  >
                    Discard {stationProgram === "trapping" ? "trap" : "station"} edits
                  </button>
                </>
              ) : (
                <>
                  Existing {stationProgram === "trapping" ? "traps" : "stations"} couldn&apos;t
                  be loaded, so marking is unavailable for this completion. Complete the visit
                  normally — the registry is unchanged.
                </>
              )}
            </div>
          )}
          {/* Service findings — typed specialty completion */}
          {isTypedFindings && (
            <TypedFindingsSection
              variant="desktop"
              frozen={generating}
              pesticideProductPresent={pesticideProductPresent}
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
                frozen={generating}
                pesticideProductPresent={pesticideProductPresent}
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
                      fontWeight: 500,
                      cursor: "pointer",
                      background: isSelected ? D.teal + "22" : D.card,
                      color: isSelected ? D.teal : D.text,
                      border: `1px solid ${isSelected ? D.teal : D.border}`,
                    }}
                  >
                    {isSelected ? "\u2713 " : ""}
                    {p.display_name || p.name}
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
                      {p.display_name || p.name}
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
                      fontWeight: 500,
                      color: D.text,
                      flex: 1,
                      minWidth: 120,
                    }}
                  >
                    {sp.displayName || sp.name}
                  </span>{" "}
                  <span style={{ fontSize: 12, fontWeight: 500, color: D.muted }}>
                    {sp.areaUnit === "sqft" ? "Rate /1k sq ft" : "Rate"}
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
                    <option value="oz/gal">oz/gal</option>{" "}
                    <option value="fl_oz/gal">fl oz/gal</option>{" "}
                    <option value="g/gal">g/gal</option>{" "}
                  </select>{" "}
                  <span style={{ fontSize: 12, fontWeight: 500, color: D.muted }}>
                    Total used
                  </span>{" "}
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
                  {areasServiced.length > 0 && (() => {
                    const selectedAreas = parseApplicationAreas(
                      sp.applicationArea,
                    );
                    const areaChoices = productAreaChoices(
                      areasServiced,
                      sp.applicationArea,
                    );
                    return (
                      <div
                        style={{
                          flexBasis: "100%",
                          display: "flex",
                          flexWrap: "wrap",
                          alignItems: "center",
                          gap: 6,
                        }}
                      >
                        <span
                          style={{
                            fontSize: 12,
                            fontWeight: 500,
                            color: D.muted,
                          }}
                        >
                          Treatment areas
                        </span>
                        {areaChoices.map((area) => {
                          const selected = selectedAreas.includes(area);
                          return (
                            <button
                              key={area}
                              type="button"
                              onClick={() =>
                                updateProduct(
                                  sp.productId,
                                  "applicationArea",
                                  toggleProductAreaValue(
                                    sp.applicationArea,
                                    area,
                                    areaChoices,
                                  ),
                                )
                              }
                              style={{
                                padding: "6px 14px",
                                borderRadius: 20,
                                fontSize: 12,
                                fontWeight: 500,
                                cursor: "pointer",
                                background: selected ? D.teal + "22" : D.card,
                                color: selected ? D.teal : D.muted,
                                border: `1px solid ${selected ? D.teal : D.border}`,
                                transition: "all 0.15s",
                              }}
                            >
                              {selected ? "✓ " : ""}
                              {area}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })()}
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
                    <option value="soil_drench">Soil drench</option>
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
                  {(() => {
                    // Fall back to the selected row's serialized category when
                    // the catalog row is absent (protocol- or substitution-
                    // added products), so fertilizer rows keep the nutrition
                    // suggestions and excluded helper categories stay hidden.
                    const pickerProduct = (products || []).find(
                      (p) => String(p.id) === String(sp.productId),
                    ) || sp;
                    if (!productControlsTargets(pickerProduct)) return null;
                    const picker = targetPickerConfig(pickerProduct, {
                      isLawn,
                      isTreeShrub,
                    });
                    return (
                    <ProductTargetsPicker
                      idSuffix={sp.productId}
                      targets={sp.targets}
                      suggestions={picker.suggestions}
                      noun={picker.noun}
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
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
          {/* Areas Serviced — hidden for Tree & Shrub and rodent lines (owner
              2026-07-23): the chips are structural-pest rooms/zones; those
              visits carry their own location semantics. */}
          {!quickComplete && !areasTreatedHidden && (
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
                        fontWeight: 500,
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
              </div>
            </div>
          )}
          {/* Customer recap + SMS preview removed (desktop) — the report summary is
              auto-generated server-side from the technician notes at completion
              (CompletionRecap.generateRecap). Kept in lockstep with the mobile layout. */}
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
            <div style={{ marginBottom: 20, textAlign: "center" }}>
              <label style={labelStyle}>
                Pest activity rating (0–5, optional)
              </label>
              <div
                style={{
                  display: "flex",
                  gap: 8,
                  flexWrap: "wrap",
                  justifyContent: "center",
                }}
              >
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
                        fontWeight: 500,
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
          {payerBanner && (
            <div
              style={{
                padding: "10px 12px",
                marginBottom: 8,
                background: "#FFF7ED",
                border: "1px solid #FDBA74",
                borderRadius: 8,
                fontSize: 13,
                color: "#9A3412",
              }}
            >
              {payerBanner}
            </div>
          )}{" "}
          {/* Bed bug never offers the no-invoice recap (typed-era parity;
              server 409s this too — codex P1 r7). */}
          {!isBedBugVisit && (
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
          </label>
          )}{" "}
          {/* Inspection credit — DEFAULT ON, mirroring the mobile closeout
              (Codex #3178 r22 P1: the control existed only in the isMobile
              branch, so a desktop tech or CSR could not clear the
              default-on promise and would record an unintended $75). The
              customer is promised the inspection fee toward anything they
              book in the window; it becomes real money only on a booking. */}
          {isInspectionVisit && (
            <label
              style={{
                ...checkboxRow,
                alignItems: "flex-start",
                fontSize: 14,
                borderColor: offerInspectionCredit ? D.teal : checkboxRow.borderColor,
              }}
            >
              {" "}
              <input
                type="checkbox"
                checked={offerInspectionCredit}
                onChange={(e) => setOfferInspectionCredit(e.target.checked)}
                style={{ marginTop: 2 }}
              />{" "}
              <span>
                Credit this inspection toward booked service
                <span
                  style={{
                    display: "block",
                    fontSize: 14,
                    color: D.muted,
                    marginTop: 2,
                  }}
                >
                  Applies as account credit only if they book — nothing is
                  credited now.
                </span>
              </span>{" "}
            </label>
          )}{" "}
          {backfillEligible && (
            <label
              style={{
                ...checkboxRow,
                alignItems: "flex-start",
                fontSize: 14,
                borderColor: backfillCloseout ? D.teal : checkboxRow.borderColor,
              }}
            >
              {" "}
              <input
                type="checkbox"
                checked={backfillCloseout}
                onChange={(e) => setBackfillCloseout(e.target.checked)}
                style={{ marginTop: 2 }}
              />{" "}
              <span>
                Backdated closeout — {backfillDaysPast} day
                {backfillDaysPast === 1 ? "" : "s"} past its date
                <span
                  style={{
                    display: "block",
                    fontSize: 14,
                    color: D.muted,
                    marginTop: 2,
                  }}
                >
                  {backfillCloseout
                    ? "Records to the visit day, sends no customer messages, and skips auto-charge."
                    : "Unchecked: completes as today with the normal customer messages."}
                </span>
              </span>{" "}
            </label>
          )}{" "}
          {backfillEligible && backfillCloseout && (
            <div style={{ marginBottom: 8 }}>
              {" "}
              <div style={{ fontSize: 14, color: D.text, marginBottom: 4 }}>
                Time on site (minutes)
              </div>{" "}
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max="720"
                step="1"
                value={backfillTimeOnSite}
                onChange={(e) => setBackfillTimeOnSite(e.target.value)}
                placeholder="Unknown"
                style={{ ...inputStyle, fontSize: 14, marginBottom: 4 }}
              />{" "}
              <div style={{ fontSize: 14, color: D.muted }}>
                The running timer spans the missed days and is not submitted —
                leave blank to record no duration.
              </div>{" "}
            </div>
          )}{" "}
          {liveAdjustEligible && (
            <div style={{ marginBottom: 8 }}>
              {" "}
              <div style={{ fontSize: 14, color: D.text, marginBottom: 4 }}>
                Adjust time on site (minutes)
              </div>{" "}
              <input
                type="number"
                inputMode="numeric"
                min="1"
                max="720"
                step="1"
                value={adjustedTimeOnSite}
                onChange={(e) => setAdjustedTimeOnSite(e.target.value)}
                placeholder="Use timer"
                style={{ ...inputStyle, fontSize: 14, marginBottom: 4 }}
              />{" "}
              <div style={{ fontSize: 14, color: D.muted }}>
                Overrides the running timer ({elapsed}) in the recorded
                duration — use it when the visit wasn't closed out on time.
                Leave blank to record the timer.
              </div>{" "}
            </div>
          )}{" "}
          {!isIncompleteVisit &&
            reentrySeeds &&
            (reentrySeeds.exteriorMinutes > 0 ||
              reentrySeeds.interiorMinutes > 0) && (
            <div style={{ marginBottom: 8 }}>
              {" "}
              <div style={{ fontSize: 14, color: D.text, marginBottom: 2 }}>
                Re-entry countdown
              </div>{" "}
              <div style={{ fontSize: 14, color: D.muted, marginBottom: 8 }}>
                What the customer's report counts down before treated areas
                are ready.
              </div>{" "}
              {[
                reentrySeeds.exteriorMinutes > 0 && {
                  key: "exterior",
                  label: "Exterior (dry-down)",
                  value: reentryExtMinutes ?? reentrySeeds.exteriorMinutes,
                  step: 5,
                  onStep: stepReentryExt,
                },
                reentrySeeds.interiorMinutes > 0 && {
                  key: "interior",
                  label: "Interior re-entry",
                  value: reentryIntMinutes ?? reentrySeeds.interiorMinutes,
                  step: 15,
                  onStep: stepReentryInt,
                },
              ]
                .filter(Boolean)
                .map((row) => (
                  <div
                    key={row.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      marginBottom: 6,
                    }}
                  >
                    {" "}
                    <span style={{ fontSize: 14, color: D.text, flex: 1 }}>
                      {row.label}:{" "}
                      <span style={{ color: D.white }}>
                        {formatReentryStepperMinutes(row.value)}
                      </span>
                    </span>{" "}
                    <button
                      type="button"
                      aria-label={`Decrease ${row.label} by ${row.step} minutes`}
                      disabled={row.value <= 0}
                      onClick={() => row.onStep(-row.step)}
                      style={{
                        padding: "6px 14px",
                        border: `1px solid ${D.border}`,
                        borderRadius: 8,
                        background: "transparent",
                        color: D.text,
                        fontSize: 14,
                        cursor: row.value <= 0 ? "default" : "pointer",
                        opacity: row.value <= 0 ? 0.4 : 1,
                      }}
                    >
                      −{row.step}
                    </button>{" "}
                    <button
                      type="button"
                      aria-label={`Increase ${row.label} by ${row.step} minutes`}
                      disabled={row.value >= 1440}
                      onClick={() => row.onStep(row.step)}
                      style={{
                        padding: "6px 14px",
                        border: `1px solid ${D.border}`,
                        borderRadius: 8,
                        background: "transparent",
                        color: D.text,
                        fontSize: 14,
                        cursor: row.value >= 1440 ? "default" : "pointer",
                        opacity: row.value >= 1440 ? 0.4 : 1,
                      }}
                    >
                      +{row.step}
                    </button>{" "}
                  </div>
                ))}{" "}
            </div>
          )}{" "}
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
          {willInvoice && effectiveSendSms && !oneTimeRecapOnly && !payerBanner && (
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
                  fontWeight: 500,
                  color: D.muted,
                  textTransform: "uppercase",
                  letterSpacing: 0.5,
                  marginBottom: 6,
                }}
              >
                Next Scheduled Visit
              </div>{" "}
              <div style={{ fontSize: 14, color: D.heading, fontWeight: 500 }}>
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
              closeoutAdvisoriesPending ||
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
                closeoutAdvisoriesPending ||
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
                <span style={{ fontSize: 15, fontWeight: 500 }}>
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
  fontWeight: 500,
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
// Normalize a products_catalog.target_pests value (JSONB array, or a stringified
// one) into a clean string[] for prefilling a product's Targets from its label.
function normalizeLabelTargets(value) {
  let v = value;
  if (typeof v === "string") {
    try { v = JSON.parse(v); } catch { return []; }
  }
  if (!Array.isArray(v)) return [];
  return v.map((t) => String(t).trim()).filter(Boolean);
}

// Every service line a label target can be classified onto.
export const ALL_TARGET_LINES = ["pest", "lawn", "tree_shrub", "termite", "mosquito"];

// Turf-only label targets that must not prefill on a structural-pest (or any
// non-lawn) visit: turf insects, turf diseases, and weeds. Matching is
// substring-loose because catalog target_pests values are free text pulled
// from labels ("Southern Chinch Bugs", "sod webworm", "chinch bug (southern)").
const LAWN_ONLY_TARGET_RE =
  /chinch|sod webworm|armyworm|white grub|\bgrubs?\b|mole cricket|billbug|spittlebug|nematode|crabgrass|goosegrass|torpedograss|bahiagrass|foxtail|kyllinga|dollarweed|doveweed|chamberbitter|chickweed|burweed|pusley|buttonweed|spurge|clover|nutsedge|\bsedge\b|flatsedge|broadleaf weed|\bweeds?\b|poa annua|bluegrass|brown patch|large patch|dollar spot|leaf spot|anthracnose|summer patch|take-?all|fairy ring|pythium|yellow tuft|turf/i;

// Bed/hardscape work happens on lawn AND tree & shrub visits — the quarterly
// T&S protocol applies Snapshot for bed pre-emergence, and the bed-only
// herbicides (SureGuard, Fusilade, Segment) are directed bed/border work
// wherever they ride. Checked BEFORE the turf pattern because these strings
// contain "weeds", which the lawn regex would otherwise claim lawn-only and
// filterLabelTargetsForLine would drop the whole list on a T&S completion
// (codex P2 r1 on the 20260807200000 fills).
const BED_WORK_TARGET_RE =
  /landscape bed|bed & border|non-selective weed|driveway & sidewalk/i;

// Ornamental-only targets (tree & shrub / palm work): sap feeders, mites,
// borers, and foliar issues. Checked BEFORE the structural set so "Spider
// mites" classifies as ornamental instead of matching the spider pattern.
const ORNAMENTAL_ONLY_TARGET_RE =
  /whitefl|spiraling|scale insect|soft scale|mealybug|aphid|thrips|\bmites?\b|leafminer|\bborer|weevil|sooty mold|powdery mildew|fungal leaf spot/i;

// Targets NOTHING controls. UF/IFAS is explicit that Ganoderma butt rot has no
// chemical control and Thielaviopsis trunk rot has no prevention or cure, so
// they must never prefill: a chip on a completed visit reads as "this product
// treated it", which would be a claim no product can support. A tech can still
// type either by hand as an observation — this only blocks the automatic fill.
const NO_CONTROL_TARGET_RE = /ganoderma|thielaviopsis/i;

// Palm and ornamental diseases. Checked BEFORE the turf pattern because the
// lawn regex claims a bare "leaf spot" — without this, "Palm leaf spot" files
// as turf. Palm disease tokens carry an explicit "(palm)" marker so the intent
// is legible in the catalog as well as here; turf oomycetes keep their own
// "Pythium ..." wording and stay on the lawn line.
// NOTE: no bare "downy mildew" here. Yellow tuft — a St. Augustine turf
// disease — is written "Yellow tuft (downy mildew)" on the Subdue Maxx turf
// directions, so a generic downy-mildew rule would steal a turf target and
// drop it from lawn visits. The turf form is claimed by the lawn pattern below.
const ORNAMENTAL_DISEASE_RE =
  /fungal leaf spot|\(palm\)|palm leaf spot|palm bud rot|lethal bronzing|lethal yellowing|fusarium wilt/i;

// Nutrition goals, not pests: what a feeding is meant to correct or stimulate.
// Fertilizer-family products get applied on turf AND on palms/ornamentals, so
// these read on every line. Checked AFTER the turf pattern so an explicitly
// turf-worded goal ("Iron chlorosis (yellowing turf)") stays a lawn target.
const NUTRITION_TARGET_RE =
  /deficiency|green-?up|deep green|color & density|root support|root strength|balanced feeding|slow-release|micronutrient|winter hardiness|chlorosis/i;

// Caterpillars feed on both turf (sod webworms, armyworms are caterpillars —
// Conserve SC is labeled for all three) and ornamentals, so a bare
// "Caterpillars" target belongs on either line.
const CATERPILLAR_TARGET_RE = /caterpillar/i;

// Wood-destroying-organism targets: pass on termite/WDO visits, and carpenter
// ants also read fine on a general pest visit.
// "Wood borers" alone stays ornamental (the pattern above claims it — Tree-Age
// and Ima-Jet are injection products), but the wood-DESTROYING organisms off a
// Bora-Care label are WDO work.
const TERMITE_TARGET_RE = /termite|wood-?boring|wood borer|wood-?destroying|wood-? ?decay/i;
const CARPENTER_ANT_RE = /carpenter ant/i;

const MOSQUITO_TARGET_RE = /mosquito/i;

// Fleas and ticks are yard pests as much as indoor ones — the turf insecticides
// carry them on the label right alongside mole crickets (Topchoice Granular:
// fire ants, tawny mole crickets, fleas, ticks), and the yard is where the
// life cycle actually breaks. So they read on both lines, like fire ants
// (codex P2 r2).
const FLEA_TICK_TARGET_RE = /\bfleas?\b|\bticks?\b/i;

// Structural/household pests — the general-pest line. Broad on purpose: any
// ant species, roaches, spiders (mites already claimed above), the usual
// occasional invaders, stingers, biters, and vertebrates. `\bmoles?\b` is safe
// here only because the turf pattern claims "Tawny mole crickets" first, the
// same way it claims them ahead of the bare `cricket` alternative.
const STRUCTURAL_ONLY_TARGET_RE =
  /\bants?\b|roach|spider|silverfish|earwig|centipede|millipede|springtail|booklice|cricket|wasp|mud dauber|yellowjacket|hornet|\bfl(y|ies)\b|flea|tick|bed bug|pantry|darkling beetle|scorpion|\brats?\b|\bmouse\b|\bmice\b|rodent|\bmoles?\b/i;

// Every service line a label target belongs on. Precedence matters: turf
// before structural ("Tawny mole crickets" is a lawn pest, not a cricket),
// ornamental before structural ("Spider mites" is not a spider),
// termite/carpenter-ant before the generic ant pattern.
//
// Returns [] for a target no pattern claims, which drops it from the prefill
// (codex P2 r2). This used to fail OPEN — an unclassified target passed on
// every line, which recreated exactly the cross-line prefills this filtering
// exists to remove: "Chickweed" is a lawn weed no pattern matched, so a pest
// visit dropped SpeedZone's three recognized weeds and prefilled Chickweed
// alone. Failing closed can only ever under-fill, and the picker stays
// free-text, so the tech can add anything by hand. Every target the catalog
// carries AND every target the seed migrations write classifies — the contract
// test fixture covers both, since a value can be seeded (Talpirid's "Moles")
// without appearing in the prod catalog snapshot.
export function labelTargetLines(target) {
  // Nothing controls these, so nothing may prefill them — checked first so no
  // later pattern can claim them onto a line.
  if (NO_CONTROL_TARGET_RE.test(target)) return [];
  if (/fire ant/i.test(target)) return ["pest", "lawn"];
  if (ORNAMENTAL_DISEASE_RE.test(target)) return ["tree_shrub"];
  if (BED_WORK_TARGET_RE.test(target)) return ["lawn", "tree_shrub"];
  if (LAWN_ONLY_TARGET_RE.test(target)) return ["lawn"];
  if (CATERPILLAR_TARGET_RE.test(target)) return ["tree_shrub", "lawn"];
  if (ORNAMENTAL_ONLY_TARGET_RE.test(target)) return ["tree_shrub"];
  if (TERMITE_TARGET_RE.test(target)) return ["termite"];
  if (CARPENTER_ANT_RE.test(target)) return ["termite", "pest"];
  if (MOSQUITO_TARGET_RE.test(target)) return ["mosquito"];
  if (FLEA_TICK_TARGET_RE.test(target)) return ["pest", "lawn"];
  if (STRUCTURAL_ONLY_TARGET_RE.test(target)) return ["pest"];
  // Nutrition goals apply wherever a fertilizer does — turf and palms alike.
  if (NUTRITION_TARGET_RE.test(target)) return ALL_TARGET_LINES;
  return [];
}

// The service lines whose targets may prefill on this visit. The primary line
// comes from the classifier, but a combined display name carries companion
// sections whose targets are just as legitimate — "Lawn + Tree & Shrub"
// classifies lawn yet must keep ornamental prefills (and the day view
// normalizes that name to "Tree & Shrub Care", so callers pass serviceTypeRaw
// when present). Companion token rules mirror detectServiceCategory's own
// exclusions ("Tree Line Mosquito Treatment" adds mosquito, not tree_shrub;
// "Palmetto" never reads as palm work).
export function allowedTargetLinesForServiceType(rawServiceType) {
  const lines = new Set([detectServiceCategory(rawServiceType)]);
  const s = String(rawServiceType || "").toLowerCase();
  if (
    !s.includes("mosquito") &&
    !s.includes("termite") &&
    !s.includes("wdo") &&
    (s.includes("tree") ||
      s.includes("shrub") ||
      s.includes("ornamental") ||
      s.includes("arborjet") ||
      /\bpalm(s)?\b/.test(s))
  ) {
    lines.add("tree_shrub");
  }
  if (
    s.includes("lawn") ||
    s.includes("turf") ||
    s.includes("grass") ||
    s.includes("sod")
  ) {
    lines.add("lawn");
  }
  if (s.includes("mosquito")) lines.add("mosquito");
  // Termite tokens mirror the classifier's aliases — a pest-primary combined
  // name ("Quarterly Pest + Termite Bait Station") classifies pest but must
  // keep its termite targets (codex P1 r2).
  if (
    s.includes("termite") ||
    s.includes("wdo") ||
    s.includes("bora") ||
    s.includes("trelona") ||
    s.includes("termidor") ||
    /\badvance\b/.test(s)
  ) {
    lines.add("termite");
  }
  if (/\bpest\b/.test(s)) lines.add("pest");
  return lines;
}

// Same question, asked of the whole visit rather than one name. A scheduled
// add-on is a real service line on the appointment — a quarterly pest visit
// with a One-Time Mosquito Treatment add-on genuinely treats for mosquitoes,
// so In2Care must keep its mosquito targets there. The schedule payloads carry
// those companion lines in serviceAddons/extraServiceTypes; union them into
// the allowed set (codex P2 r2).
export function allowedTargetLinesForVisit(service) {
  const lines = allowedTargetLinesForServiceType(
    service?.serviceTypeRaw || service?.serviceType,
  );
  const addonNames = [
    ...(Array.isArray(service?.extraServiceTypes) ? service.extraServiceTypes : []),
    ...(Array.isArray(service?.serviceAddons)
      ? service.serviceAddons.map((a) => a?.serviceName)
      : []),
  ].filter(Boolean);
  addonNames.forEach((name) => {
    allowedTargetLinesForServiceType(name).forEach((line) => lines.add(line));
  });
  return lines;
}

// A prefill is a starting point, not a transcription of the label — cap it at
// the few most popular targets (catalog arrays are ordered most-common-first)
// and let the tech add the rest by hand (owner 2026-08-01: "3 at most, and
// popular SWFL pests").
export const MAX_LABEL_TARGET_PREFILL = 3;

// Keep only the label targets that belong on one of the visit's service lines
// (a Set from allowedTargetLinesForServiceType), then cap. Filtering runs in
// BOTH directions now — a lawn visit drops Talstar's ants/roaches just like a
// pest visit drops its chinch bugs (owner 2026-08-01: targets must populate
// for the service at hand).
export function filterLabelTargetsForLine(targets, allowedLines) {
  const allowed =
    allowedLines instanceof Set && allowedLines.size
      ? allowedLines
      : new Set(["pest"]);
  return targets
    .filter((t) => labelTargetLines(t).some((line) => allowed.has(line)))
    .slice(0, MAX_LABEL_TARGET_PREFILL);
}

// Species-specific, not category-broad (owner request 2026-07-23): the chips
// a tech commits become the report's "targets tagged today", so "Ghost ants"
// beats "ants" and "German cockroaches" beats "roaches".
const PEST_TARGET_SUGGESTIONS = [
  "Ghost ants",
  "Big-headed ants",
  "Crazy ants",
  "White-footed ants",
  "Carpenter ants",
  "Fire ants",
  "Argentine ants",
  "Pharaoh ants",
  "Rover ants",
  "German cockroaches",
  "American cockroaches",
  "Smokybrown cockroaches",
  "Australian cockroaches",
  "Florida woods cockroaches",
  "Wolf spiders",
  "Widow spiders",
  "Orb-weaver spiders",
  "Silverfish",
  "Earwigs",
  "Millipedes",
  "Centipedes",
  "Springtails",
  "Booklice",
  "Crickets",
  "Paper wasps",
  "Mud daubers",
  "Yellowjackets",
  "Drain flies",
  "House flies",
  "Fleas",
  "Ticks",
  "Bed bugs",
  "Pantry moths & beetles",
  "Subterranean termites",
  "Drywood termites",
  "Roof rats",
  "Norway rats",
  "House mice",
  "Mosquitoes",
  "Scorpions",
];

// What a lawn product treats: weeds, turf-damaging insects, and turf diseases —
// what a lawn tech actually enters as a product's target, not structural pests.
const LAWN_TARGET_SUGGESTIONS = [
  "Broadleaf weeds",
  "Crabgrass",
  "Nutsedge / sedge",
  "Green kyllinga",
  "Dollarweed",
  "Doveweed",
  "Chamberbitter",
  "Spurge",
  "Clover",
  "Goosegrass",
  "Torpedograss",
  "Annual bluegrass (Poa annua)",
  "Southern chinch bugs",
  "Fall armyworms",
  "Tropical sod webworms",
  "White grubs",
  "Tawny mole crickets",
  "Fire ants",
  "Nematodes",
  "Large patch",
  "Dollar spot",
  "Gray leaf spot",
  "Take-all root rot",
  "Fairy ring",
  "Pythium root rot",
];

// Tree & shrub / palm targets: the SWFL ornamental pests a T&S tech actually
// treats — whitefly species, scale, thrips, mites — plus the foliar diseases.
const ORNAMENTAL_TARGET_SUGGESTIONS = [
  "Ficus whitefly",
  "Rugose spiraling whitefly",
  "Chilli thrips",
  "Sri Lanka weevil",
  "Aphids",
  "Scale insects",
  "Mealybugs",
  "Spider mites",
  "Leafminers",
  "Caterpillars",
  "Wood borers",
  "Sooty mold (sap-feeder cleanup)",
  "Fungal leaf spot",
  "Powdery mildew",
];

// Fertilizer-family targets are the nutrition goal of the application — what
// the feeding is meant to correct or stimulate, in customer-report language.
const NUTRITION_TARGET_SUGGESTIONS = [
  "Nitrogen green-up",
  "Deep green color",
  "Color & density",
  "Iron chlorosis (yellowing turf)",
  "Potassium deficiency",
  "Root strength & stress tolerance",
  "Balanced feeding",
  "Micronutrient deficiency",
  "Slow-release feeding",
  "Winter hardiness",
  "Magnesium deficiency (palms)",
  "Manganese deficiency (palms)",
  "Potassium deficiency (palms)",
];

// Which suggestion list / placeholder noun a product's Targets picker gets:
// fertilizer-family products always take the nutrition goals; otherwise the
// service line decides (lawn → weeds/turf pests/diseases, tree & shrub →
// ornamental pests, pest default).
function targetPickerConfig(product, { isLawn, isTreeShrub } = {}) {
  if (productTargetsNutrition(product)) {
    return { suggestions: NUTRITION_TARGET_SUGGESTIONS, noun: "nutrition" };
  }
  if (isLawn) return { suggestions: LAWN_TARGET_SUGGESTIONS, noun: "" };
  if (isTreeShrub) {
    return { suggestions: ORNAMENTAL_TARGET_SUGGESTIONS, noun: "pest" };
  }
  return { suggestions: PEST_TARGET_SUGGESTIONS, noun: "pest" };
}

// The standard field rig. The protocol mix amounts are shown for this tank so
// the tech reads the ratios off one number they recognize.
const PROTOCOL_TANK_GAL = 110;

function formatMixAmount(n) {
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Read-only Lawn Care Protocol reference: the protocol window (title + goal) and,
// for each product in the generated plan, how much to put in a 110-gallon tank
// (ratePer1000 × tank-coverage). Rows come from plan.mixCalculator.items — the
// per-visit mix, which carries engine-derived nutrition rates, selected
// conditionals, and approved substitutes that the static protocol definitions
// don't. No inputs, no checklist — the tech reads it and records what they
// actually applied through the Products Applied list. Inventory blocks (a real
// stock safeguard) still surface here.
function ProtocolMixSummary({ protocol, mixItems = [], carrierGalPer1000, inventoryBlocks = [], theme }) {
  if (!protocol?.window) return null;
  const t = theme || {};
  const carrier = Number(carrierGalPer1000);
  const hasCarrier = Number.isFinite(carrier) && carrier > 0;
  const planRows = (mixItems || [])
    .filter((item) => item?.product)
    .map((item) => ({
      key: item.product.id || item.product.name,
      name: item.product.name,
      // Null when the engine couldn't derive a rate — rendered as "—", never 0.
      ratePer1000: Number(item.mix?.ratePer1000) || null,
      rateUnit: item.mix?.rateUnit || null,
    }));
  // Fallback while the plan hasn't loaded (or matched no catalog products):
  // static protocol rows, defaults preferred, excluding rows without a usable
  // stored rate — a null rate must not read as a concrete 0.
  const allProducts = protocol.products || [];
  const planned = allProducts.filter((p) => p.defaultInPlan);
  const staticRows = (planned.length ? planned : allProducts)
    .filter((p) => Number(p.ratePer1000) > 0)
    .map((p) => ({
      key: p.id || p.productId || p.productName,
      name: p.productName,
      ratePer1000: Number(p.ratePer1000),
      rateUnit: p.rateUnit || null,
    }));
  const rows = planRows.length ? planRows : staticRows;
  return (
    <div style={{ background: t.card, border: `1px solid ${t.border}`, borderRadius: 12, padding: 12 }}>
      <div style={{ fontFamily: t.font, fontSize: 13, fontWeight: 500, color: t.ink }}>
        {protocol.window.title}
      </div>
      {protocol.window.goal ? (
        <div style={{ fontFamily: t.font, fontSize: 12, color: t.muted, lineHeight: 1.35, marginTop: 4 }}>
          {protocol.window.goal}
        </div>
      ) : null}
      {rows.length ? (
        <div style={{ marginTop: 10 }}>
          <div style={{ fontFamily: t.font, fontSize: 11, fontWeight: 500, color: t.muted, textTransform: "uppercase", letterSpacing: 0.3 }}>
            Mix for a {PROTOCOL_TANK_GAL}-gal tank
          </div>
          <div style={{ marginTop: 6, display: "flex", flexDirection: "column", gap: 5 }}>
            {rows.map((row, i) => {
              const amt =
                hasCarrier && row.ratePer1000 > 0
                  ? row.ratePer1000 * (PROTOCOL_TANK_GAL / carrier)
                  : null;
              return (
                <div key={row.key || i} style={{ display: "flex", justifyContent: "space-between", gap: 10, fontFamily: t.font, fontSize: 13, color: t.ink }}>
                  <span>{row.name}</span>
                  <strong style={{ whiteSpace: "nowrap" }}>
                    {amt != null ? `${formatMixAmount(amt)} ${row.rateUnit || "oz"}` : "—"}
                  </strong>
                </div>
              );
            })}
          </div>
          <div style={{ marginTop: 6, fontFamily: t.font, fontSize: 11, color: t.muted }}>
            {hasCarrier
              ? `Based on ${carrier} gal/1K carrier — reference only, nothing to fill in.`
              : "Carrier rate unavailable — see the treatment plan for amounts."}
          </div>
        </div>
      ) : null}
      {inventoryBlocks.length ? (
        <div style={{ marginTop: 10, background: t.errBg, border: `1px solid ${t.err}`, borderRadius: 10, color: t.err, fontFamily: t.font, fontSize: 12, lineHeight: 1.35, padding: 10 }}>
          {inventoryBlocks.map((b) => b.message).filter(Boolean).join(" ")}
        </div>
      ) : null}
    </div>
  );
}

// Per-product target multiselect: free-text chips with datalist suggestions.
// Stored on the selected product as `targets` (string[]); the completion route
// persists it to service_products.targets. Optional. `suggestions`/`noun` are
// service-line aware — pest services get pests, lawn services get weeds/turf
// pests/diseases — so the label and datalist match what's actually being treated.
function ProductTargetsPicker({ targets, onChange, idSuffix, theme, suggestions = PEST_TARGET_SUGGESTIONS, noun = "pest" }) {
  const [draft, setDraft] = useState("");
  const list = Array.isArray(targets) ? targets : [];
  const datalistId = `targets-${idSuffix}`;
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
      <span style={{ fontSize: 12, fontWeight: 500, color: theme.labelColor }}>
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
        placeholder={list.length || !noun ? "Add target…" : `Add ${noun} target…`}
        onChange={(e) => {
          const value = e.target.value;
          if (value.includes(",")) {
            commit(value);
            return;
          }
          // Auto-commit when the value exactly matches a suggestion (datalist
          // pick), so selecting works without relying on Enter/blur on mobile.
          if (
            suggestions.some(
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
        {suggestions.map((p) => (
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
  "speedzone southern": "kills broadleaf weeds — NOT for Floratam/Bitterblue St. Augustine; 50-85\u00b0F only",
  speedzone: "kills broadleaf weeds — NOT for Floratam/Bitterblue St. Augustine; 50-85\u00b0F only",
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
    "fungicide for large patch — different mode of action (FRAC 12)",
  medallion: "fungicide for large patch — different mode of action (FRAC 12)",
  "torque sc": "fungicide for fall disease prevention (FRAC 3)",
  torque: "fungicide for fall disease prevention (FRAC 3)",
  velista: "fungicide for large patch rescue — SDHI mode of action (FRAC 7)",
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
  tritek: "horticultural oil for scale, mites, and whitefly crawlers when plant/weather safe",
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
    "SpeedZone: verify cultivar; apply only 50\u201385\u00b0F; NOT during spring green-up or fall transition",
    "Hold PGR/hot herbicide on stressed turf",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
  A_St_Aug_Sun: [
    "Celsius WG: MAX 3 apps/year/property",
    "SpeedZone: verify cultivar; apply only 50\u201385\u00b0F; NOT during spring green-up or fall transition",
    "Hold PGR/hot herbicide on stressed turf",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
  B_St_Aug_Shade: [
    "Celsius WG: MAX 3 apps/year/property",
    "SpeedZone: verify cultivar; apply only 50\u201385\u00b0F; NOT during spring green-up or fall transition",
    "Hold PGR/hot herbicide on stressed turf",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
  C1_Bermuda: [
    "Celsius WG: MAX 3 apps/year/property",
    "No Atrazine on Bermuda \u2014 EVER",
    "SpeedZone: apply only 50\u201385\u00b0F",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
  C2_Zoysia: [
    "Celsius WG: MAX 3 apps/year/property",
    "No Atrazine on Zoysia \u2014 EVER",
    "SpeedZone: apply only 50\u201385\u00b0F",
    "N blackout Jun 1 \u2013 Sep 30",
  ],
  D_Bahia: [
    "Celsius WG: MAX 3 apps/year/property",
    "SpeedZone: apply only 50\u201385\u00b0F",
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
