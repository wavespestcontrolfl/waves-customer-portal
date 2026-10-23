/**
 * Lawn v13 May Tetrino rate at a chinch-mapped lawn (GATE_LAWN_CHINCH_TETRINO_RATE, owner 2026-10-22).
 *
 * Tetrino label (EPA 432-1591), chinch bugs: 16 to 32 fl oz per acre (0.367 to 0.735 fl oz per 1,000 sq ft), the top rate "under high
 * pest pressure"; no more than 2 maximum-rate applications a year, 4 weeks apart, 64 fl oz per acre a year (1.469 fl oz per 1,000 sq ft).
 * The v13 May visit applies Tetrino at 0.367 fl oz per 1,000 sq ft on sunny turf. While the property has a mapped trouble area of type
 * `troubleType` that is ACTIVE or was resolved within `resolvedWithinDays` days, the May line is planned at the top rate instead.
 *
 * The entry applies to the visit whose month number is `month`, to the one product `productName`, and only RAISES its stated rate
 * (a row already at or above `ratePer1000` is unchanged). Nothing else moves. One May application at 0.735 uses half of the 64 fl oz
 * a year, so the label's yearly limit is not reached by this visit.
 * Kept in code, not in a protocol row, so no migration is needed and the gate off leaves every stored row as it was.
 */
const V13_CHINCH_TETRINO = Object.freeze({
  month: 5,
  productName: 'Tetrino Insecticide',
  troubleType: 'chinch',
  resolvedWithinDays: 365,
  normalRate: 0.367,
  ratePer1000: 0.735,
  rateUnit: 'fl oz',
});

// The key of the line note a raised Tetrino rate carries (plan gateNotes), so the Fast Complete sheet can pick that one note out.
const CHINCH_TETRINO_NOTE_KEY = 'chinchTetrinoRate';
const CHINCH_TETRINO_NOTE = `Chinch bugs mapped here: Tetrino at the label's high rate, ${V13_CHINCH_TETRINO.ratePer1000} fl oz per 1,000 sq ft.`;

module.exports = { V13_CHINCH_TETRINO, CHINCH_TETRINO_NOTE_KEY, CHINCH_TETRINO_NOTE };
