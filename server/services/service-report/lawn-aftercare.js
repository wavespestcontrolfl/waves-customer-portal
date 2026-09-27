'use strict';

const LEGACY_WATER_IN_COPY = 'Water in today’s application — give the lawn a normal watering within the next 24 hours to move the product into the soil, unless your technician advised otherwise.';
const WATER_IN_CONFIRMATION = 'Today’s application is recorded as requiring water-in; the exact amount and timing are not recorded in this report. Confirm the directions with your technician before changing irrigation.';
const LEGACY_NOTE_CONFIRMATION = 'Confirm the product watering directions with your technician before changing irrigation.';

function hasCreditableWaterIn(aftercare) {
  return aftercare?.creditableWaterIn === true
    && aftercare?.evidenceSource === 'product_instruction'
    && aftercare?.wateringHold !== true
    && aftercare?.needsReview !== true;
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
  hasCreditableWaterIn,
  normalizeLawnAftercare,
};
