// Typed findings rules shared by the office Complete Service form
// (pages/admin/SchedulePage.jsx) and the tech Fast Complete sheet: each
// mirrors a server rule (server/services/service-report/activity-indicators.js)
// so a person gets the prompt before /complete refuses. Moved here from
// SchedulePage.jsx unchanged, so the tech bundle never imports that module.

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

// Typed zero states whose renderer refuses generated copy at completion —
// buildTodaysResult keeps the fixed template for them, so Generate must
// hold: the tech would review (and the business be billed for) prose the
// report never publishes. Bait/trap gauges refuse on a zero score; flea,
// knockdown, and mosquito stories refuse on their cleared/none-observed
// states (codex r43/r44 bait rule, generalized in r45).
export function typedZeroStateRefusesBody(type, values, score) {
  // Story lanes (exclusion/inspection) consume the reviewed body in their
  // own branches at every score, so a generation is never wasted there.
  if (type === "rodent_exclusion" || type === "rodent_inspection") return false;
  if (type === "mosquito_event") return String(values?.activity_level ?? "") === "None observed";
  // Derived from the renderer's refusal rule rather than an enumeration
  // (codex r48): buildTodaysResult keeps the fixed template on a zero
  // indicator score for EVERY gauge lane (bait/trapping, bed bug,
  // cockroach, termite inspection, wildlife trapping, knockdowns, flea) —
  // a non-gauge schema never carries a score, so the check is safe
  // unconditionally.
  if (score === 0) return true;
  // Cleared select states refuse the same way when no score is pinned —
  // reuse the shared cleared-boundary map instead of re-listing the lanes.
  const rule = TYPED_SCORE_CLEARED_SELECT[type];
  if (rule && score == null) return String(values?.[rule.field] ?? "") === rule.cleared;
  // Non-gauge cleared states keep the fixed template in buildTodaysResult's
  // zeroSeverity branch (severity / activity_level "None observed" or
  // "No activity") — Generate must hold for them too (codex r66).
  const clearedSelect = String(values?.severity ?? values?.activity_level ?? "").trim();
  if (clearedSelect === "None observed" || clearedSelect === "No activity") return true;
  return false;
}

// The typed area fields that record where product went down (a migrated
// draft may also carry the lane's legacy generic chips).
export const TREATMENT_AREA_FIELD_KEYS = ["areas_treated", "spot_treatment_areas", "treatment_zones"];

// Per-product treatment areas are multi-select but stored as ONE
// comma-joined string in the existing applicationArea field
// ("Kitchen, Bathrooms") so drafts, the submit payload, and the
// service_products.application_area column keep their shape — only the
// picker UI changed. Area labels are a controlled chip vocabulary and
// never contain commas.
export function parseApplicationAreas(value) {
  return String(value || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function typedTreatmentAreaField(schema) {
  return (schema?.fields || []).find((field) => TREATMENT_AREA_FIELD_KEYS.includes(field?.key)) || null;
}
export function completionAreasForTypedFindings({ typedAreaKey, findingsValues, genericAreas }) {
  if (!typedAreaKey) return genericAreas || [];
  const typedAreas = parseApplicationAreas(findingsValues?.[typedAreaKey]);
  // Drafts saved before a lane gained its typed area field carry only the
  // generic list. Preserve that scope until the technician picks a typed
  // value; new typed selections remain authoritative once present.
  return typedAreas.length ? typedAreas : (genericAreas || []);
}

// The typed forms whose completion records no treated place at all: the
// office form hides its places for them (their own work fields say what was
// done where).
export const TYPED_TYPES_WITHOUT_PLACES = [
  "rodent_trapping", "rodent_exclusion", "rodent_sanitation",
  "rodent_inspection", "rodent_bait_station", "bed_bug",
];
