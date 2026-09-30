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
// Visit scope is part of the verdict, not a side check some callers remember
// and others forget: a reopened/history-carried report can attach an
// aftercare object that was never THIS visit's own (an old credited water-in
// or an old review/hold confirmation) — week membership is the only signal
// that distinguishes them. Pass the report's water.weekPlan as the second
// argument wherever it is available; an explicit visitInPlanWeek === false
// resolves to verdict 'none' (customerTask null, restricts false, credited
// false) before any of the flags below are even read. A plan with no
// membership marker (legacy payloads) or no plan at all keeps the current-
// week reading — omit the argument or pass null/undefined. The note itself
// (aftercare.watering) is still shown in the Aftercare section either way;
// only the PROMOTED customer task/restriction/credit is scoped.
//
// Fail closed, first match wins:
//   visit outside the plan week (visitInPlanWeek === false) → none
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

const NONE_STATE = { verdict: 'none', customerTask: null, restricts: false, credited: false };

function resolveLawnAftercare(aftercare, weekPlan) {
  if (weekPlan && weekPlan.visitInPlanWeek === false) return NONE_STATE;
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

// aftercare/weekPlan resolve the SAME visit-scoped verdict everywhere: pass
// the report's water.weekPlan as the second argument wherever it is
// available (see the resolveLawnAftercare header comment above).
function hasCreditableWaterIn(aftercare, weekPlan) {
  return resolveLawnAftercare(aftercare, weekPlan).credited;
}

// The task that outranks every other watering instruction (review / hold).
function wateringRestrictionAction(aftercare, weekPlan) {
  const state = resolveLawnAftercare(aftercare, weekPlan);
  return state.restricts ? state.customerTask : null;
}

// Any customer task the aftercare creates, including a credited water-in.
function aftercareCustomerTask(aftercare, weekPlan) {
  return resolveLawnAftercare(aftercare, weekPlan).customerTask;
}

// A visit outside the plan's week cannot qualify that week's plan with its
// own restriction; the note itself stays on the report. A plan without week
// membership (older payloads) keeps the current-week reading. Routed through
// the same scoped verdict as every other helper — a visit outside the plan
// week resolves 'none', which carries no plan condition either.
//
// With NO weekly plan at all there is no "plan below" to place a condition
// ahead of, but an unresolved review/hold verdict still owes the customer its
// confirmation/restriction task — falling all the way through to null here
// silently dropped it (codex P1 #5033 r8: a direct watering question with a
// review-marked instruction and no weekPlan answered with the raw, unreviewed
// label text and nothing else). Fall back to the same plain task
// wateringRestrictionAction() returns, so the task is never conditioned on a
// plan's presence.
function wateringPlanCondition(aftercare, weekPlan) {
  const state = resolveLawnAftercare(aftercare, weekPlan);
  if (!state.restricts) return null;
  if (!weekPlan?.title) return state.customerTask;
  return VERDICT_PLAN_CONDITION[state.verdict] || null;
}

// The weekly plan the report actually shows: reduced by a credited water-in
// only for a visit inside the plan week on a plan that prescribes a run.
function renderedWeekPlan(aftercare, weekPlan) {
  if (!weekPlan?.title) return null;
  const reduced = hasCreditableWaterIn(aftercare, weekPlan) && weekPlan.visitInPlanWeek === true
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
  wateringPlanCondition,
  renderedWeekPlan,
  normalizeLawnAftercare,
};
