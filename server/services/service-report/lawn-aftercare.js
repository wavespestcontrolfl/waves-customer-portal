'use strict';

const LEGACY_WATER_IN_COPY = 'Water in today’s application — give the lawn a normal watering within the next 24 hours to move the product into the soil, unless your technician advised otherwise.';
const WATER_IN_CONFIRMATION = 'Today’s application is recorded as requiring water-in. Confirm the directions with your technician before changing irrigation.';
const LEGACY_NOTE_CONFIRMATION = 'Confirm the product watering directions with your technician before changing irrigation.';

// The one resolved state of this visit's watering aftercare. Every surface
// that credits a watering-in, suppresses watering advice, reduces the weekly
// plan, or states a customer task (hero, insights, follow-up card, narrative
// rewrite, report assistant) reads resolveLawnAftercare() through the helpers
// below — never the raw flags. The client card mirrors the same table
// (LawnReportV2.jsx aftercareVerdict).
//
// Fail closed, first match wins:
//   neutral fallback, no direction claimed          → none
//   no recorded instruction, a direction claimed    → review
//   instruction, evidence source not allowlisted    → review
//   instruction, allowlisted but unverified source  → review
//   verified instruction, needsReview               → review
//   verified instruction, wateringHold              → hold
//   verified instruction, creditableWaterIn         → credit
//   verified instruction, no hold or water-in       → none
// Outputs: verdict; customerTask (review/hold confirmation or restriction
// copy; the credited instruction itself); restricts (review/hold outrank all
// other watering advice); credited (the water-in may reduce this week's plan).
const EVIDENCE_SOURCES = {
  product_instruction: 'verified',
  legacy_unverified_instruction: 'unverified',
};

const HOLD_TASK = 'Follow the product-specific watering restriction in Aftercare before making any other irrigation changes.';

function recordedInstruction(aftercare) {
  return typeof aftercare?.watering === 'string' ? aftercare.watering.trim() : '';
}

function claimsDirection(aftercare) {
  return aftercare.waterInRequired === true || aftercare.creditableWaterIn === true
    || aftercare.wateringHold === true || aftercare.needsReview === true || Boolean(aftercare.evidenceSource);
}

function aftercareVerdict(aftercare) {
  if (!aftercare || typeof aftercare !== 'object') return 'none';
  const claimed = claimsDirection(aftercare);
  if (aftercare.neutral === true && !claimed) return 'none';
  if (!recordedInstruction(aftercare)) return claimed ? 'review' : 'none';
  if (EVIDENCE_SOURCES[aftercare.evidenceSource] !== 'verified' || aftercare.needsReview === true) return 'review';
  if (aftercare.wateringHold === true) return 'hold';
  if (aftercare.creditableWaterIn === true) return 'credit';
  return 'none';
}

function resolveLawnAftercare(aftercare) {
  const verdict = aftercareVerdict(aftercare);
  const customerTask = {
    review: LEGACY_NOTE_CONFIRMATION,
    hold: HOLD_TASK,
    credit: recordedInstruction(aftercare),
  }[verdict] || null;
  return {
    verdict,
    customerTask,
    restricts: verdict === 'review' || verdict === 'hold',
    credited: verdict === 'credit',
  };
}

// Condition placed ahead of a weekly plan while the verdict is unresolved.
const VERDICT_PLAN_CONDITION = {
  review: 'Confirm the product watering directions with your technician before applying the plan below. Any recorded restriction must also have ended; use only the plan’s listed days and watering windows.',
  hold: 'The recorded product watering restriction comes first. Use the plan below only after that restriction has ended, and only within the plan’s listed days and watering windows.',
};

function hasCreditableWaterIn(aftercare) {
  return resolveLawnAftercare(aftercare).credited;
}

// The task that outranks every other watering instruction (review / hold).
function wateringRestrictionAction(aftercare) {
  const state = resolveLawnAftercare(aftercare);
  return state.restricts ? state.customerTask : null;
}

// Any customer task the aftercare creates, including a credited water-in.
function aftercareCustomerTask(aftercare) {
  return resolveLawnAftercare(aftercare).customerTask;
}

// aftercareCustomerTask, scoped to the visit that actually earned it. A
// reopened/history-carried report can attach an aftercare object that was
// never this visit's own — an old credited water-in or an old review/hold
// confirmation — and week membership is the only signal that distinguishes
// them (the note itself is still shown in the Aftercare section either way).
// Same guard as the client's aftercareAppliesToPlanWeek (LawnReportV2.jsx)
// and wateringPlanCondition below: only an explicit visitInPlanWeek === false
// withholds it; a plan with no membership marker (legacy payloads) or no
// plan at all keeps the current-week reading.
function currentVisitAftercareTask(aftercare, weekPlan) {
  if (weekPlan && weekPlan.visitInPlanWeek === false) return null;
  return aftercareCustomerTask(aftercare);
}

// A visit outside the plan's week cannot qualify that week's plan with its
// own restriction; the note itself stays on the report. A plan without week
// membership (older payloads) keeps the current-week reading.
function wateringPlanCondition(aftercare, weekPlan) {
  if (!weekPlan?.title || weekPlan.visitInPlanWeek === false) return null;
  return VERDICT_PLAN_CONDITION[aftercareVerdict(aftercare)] || null;
}

// The weekly plan the report actually shows: reduced by a credited water-in
// only for a visit inside the plan week on a plan that prescribes a run.
function renderedWeekPlan(aftercare, weekPlan) {
  if (!weekPlan?.title) return null;
  const reduced = hasCreditableWaterIn(aftercare) && weekPlan.visitInPlanWeek === true
    && weekPlan.prescribesRun === true && weekPlan.afterTreatment?.title;
  return reduced ? weekPlan.afterTreatment : weekPlan;
}

function normalizeLawnAftercare(aftercare, { recordedWateringNotes = [] } = {}) {
  if (!aftercare || typeof aftercare !== 'object') return aftercare;
  // Historical neutral fallbacks and payloads with no direction at all carry
  // nothing to verify. Preserve them exactly.
  if (!claimsDirection(aftercare) && (aftercare.neutral === true || !recordedInstruction(aftercare))) return aftercare;
  const source = recordedInstruction(aftercare) ? EVIDENCE_SOURCES[aftercare.evidenceSource] : null;
  if (source === 'verified') {
    return { ...aftercare, creditableWaterIn: hasCreditableWaterIn(aftercare) };
  }
  if (source === 'unverified') {
    return { ...aftercare, needsReview: true, creditableWaterIn: false };
  }

  // Legacy, unsupported, or instruction-less evidence: fail closed into review
  // with every recorded note kept beside the confirmation.
  const notes = [...new Set((recordedWateringNotes || [])
    .map((note) => String(note || '').trim())
    .filter(Boolean))];
  const legacyWatering = recordedInstruction(aftercare);
  if (!notes.length && legacyWatering && legacyWatering !== LEGACY_WATER_IN_COPY) {
    notes.push(legacyWatering);
  }
  const confirmation = aftercare.waterInRequired === true
    ? WATER_IN_CONFIRMATION
    : LEGACY_NOTE_CONFIRMATION;

  return {
    ...aftercare,
    watering: [...notes, confirmation].join(' '),
    evidenceSource: 'legacy_unverified_instruction',
    needsReview: true,
    creditableWaterIn: false,
  };
}

module.exports = {
  LEGACY_WATER_IN_COPY,
  WATER_IN_CONFIRMATION,
  aftercareVerdict,
  resolveLawnAftercare,
  hasCreditableWaterIn,
  wateringRestrictionAction,
  aftercareCustomerTask,
  currentVisitAftercareTask,
  wateringPlanCondition,
  renderedWeekPlan,
  normalizeLawnAftercare,
};
