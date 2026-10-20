// GATE_REPORT_CLEANUP_1020: the pure helpers behind the simple report's cleanup
// items. ServiceReportDocument calls them only when the payload says
// `reportCleanup === true`; gate off, the document prints as it always did.

// The words after the slash of a stored rate unit ("lb/1000sf" is lb per
// 1,000 sq ft). A basis not listed here is not guessed at.
const BASIS_WORDS = {
  '1000sf': 'per 1,000 sq ft',
  '100sf': 'per 100 sq ft',
  acre: 'per acre',
  gal: 'per gal',
  '100gal': 'per 100 gal',
  '50ft': 'per 50 ft',
  '20ft': 'per 20 ft',
  spot: 'per spot',
  palm: 'per palm',
  station: 'per station',
  placement: 'per placement',
  'inch dbh': 'per inch of trunk width',
};

// A bare weight or volume unit on a record with a square-foot area is a rate per
// 1,000 sq ft: the convention every rate reader in the server follows
// (area-addon-governed-rate.js splitRateUnit).
const PER_1000_BARE_UNITS = new Set(['oz', 'fl_oz', 'lb', 'g', 'ml']);

const unitWords = (unit) => String(unit || '').replace(/_/g, ' ').trim();

/**
 * The words that say what a product's rate is per ("4.04 lb per 1,000 sq ft"),
 * or null when the record does not say: the caller then prints the rate as it
 * always did. `amount` is the rate already formatted.
 */
export function rateWithBasis(app, amount) {
  const raw = String(app?.rateUnit || '').trim().toLowerCase();
  if (!raw || !amount) return null;
  const slash = raw.indexOf('/');
  if (slash > 0) {
    const basis = BASIS_WORDS[raw.slice(slash + 1)];
    return basis ? `${amount} ${unitWords(raw.slice(0, slash))} ${basis}` : null;
  }
  if (PER_1000_BARE_UNITS.has(raw) && app.areaUnit === 'sqft') return `${amount} ${unitWords(raw)} per 1,000 sq ft`;
  return null;
}

// Case, quote style, punctuation and spacing do not make a sentence new.
const plain = (text) => String(text || '')
  .toLowerCase()
  .replace(/['‘’]/g, '')
  .replace(/[^a-z0-9%]+/g, ' ')
  .trim();

/**
 * The technician paragraph when it adds something the summary does not already say, else ''.
 * Every sentence already in the summary -> '' (the section does not print); otherwise the
 * whole paragraph comes back unchanged, word for word.
 */
export function techTextBeyondSummary(techText, summaryParagraphs) {
  const summary = plain((summaryParagraphs || []).join(' '));
  const text = String(techText || '');
  const addsText = text
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => plain(sentence) && !summary.includes(plain(sentence)));
  return addsText ? text : '';
}

/** True for a photo the lawn photo set labels "Trouble spot". */
export const isTroubleSpotPhoto = (photo) => /^\s*trouble spot\b/i.test(String(photo?.caption || photo?.label || ''));
