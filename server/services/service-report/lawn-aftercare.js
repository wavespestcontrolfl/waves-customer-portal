'use strict';

const LEGACY_WATER_IN_COPY = 'Water in today’s application — give the lawn a normal watering within the next 24 hours to move the product into the soil, unless your technician advised otherwise.';
const WATER_IN_CONFIRMATION = 'Today’s application is recorded as requiring water-in. Confirm the directions with your technician before changing irrigation.';
const LEGACY_NOTE_CONFIRMATION = 'Confirm the product watering directions with your technician before changing irrigation.';

// The one resolved verdict on this visit's watering aftercare. Every surface
// that credits a watering-in, suppresses watering advice, or states a
// customer task (hero, insights, follow-up card, narrative rewrite, report
// assistant) reads it
// through the helpers below — never the raw flags.
//   review — the recorded direction is unverified; the customer confirms it
//   hold   — a product instruction restricts watering
//   credit — a verified product instruction requires a watering-in
//   none   — no product-driven watering task
function aftercareVerdict(aftercare) {
  if (aftercare?.needsReview === true) return 'review';
  if (aftercare?.wateringHold === true) return 'hold';
  if (aftercare?.creditableWaterIn === true && aftercare?.evidenceSource === 'product_instruction') return 'credit';
  return 'none';
}

const VERDICT_TASK = {
  review: LEGACY_NOTE_CONFIRMATION,
  hold: 'Follow the product-specific watering restriction in Aftercare before making any other irrigation changes.',
};

// Condition placed ahead of a weekly plan while the verdict is unresolved.
const VERDICT_PLAN_CONDITION = {
  review: 'Confirm the product watering directions with your technician before applying the plan below. Any recorded restriction must also have ended; use only the plan’s listed days and watering windows.',
  hold: 'The recorded product watering restriction comes first. Use the plan below only after that restriction has ended, and only within the plan’s listed days and watering windows.',
};

function hasCreditableWaterIn(aftercare) {
  return aftercareVerdict(aftercare) === 'credit';
}

function wateringRestrictionAction(aftercare) {
  return VERDICT_TASK[aftercareVerdict(aftercare)] || null;
}

// A visit outside the plan's week cannot qualify that week's plan with its
// own restriction; the note itself stays on the report. A plan without week
// membership (older payloads) keeps the current-week reading.
function wateringPlanCondition(aftercare, weekPlan) {
  if (!weekPlan?.title || weekPlan.visitInPlanWeek === false) return null;
  return VERDICT_PLAN_CONDITION[aftercareVerdict(aftercare)] || null;
}

function normalizeLawnAftercare(aftercare, { recordedWateringNotes = [] } = {}) {
  if (!aftercare || typeof aftercare !== 'object') return aftercare;
  // Historical neutral fallbacks carry no product direction. Preserve their
  // payload exactly so this guard can land before the product-note classifier.
  if (aftercare.neutral === true || !aftercare.watering) return aftercare;
  if (aftercare.evidenceSource) {
    return { ...aftercare, creditableWaterIn: hasCreditableWaterIn(aftercare) };
  }

  const notes = [...new Set((recordedWateringNotes || [])
    .map((note) => String(note || '').trim())
    .filter(Boolean))];
  const legacyWatering = String(aftercare.watering || '').trim();
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
  hasCreditableWaterIn,
  wateringRestrictionAction,
  wateringPlanCondition,
  normalizeLawnAftercare,
};
