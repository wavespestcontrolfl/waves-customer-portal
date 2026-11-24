/**
 * Printed pieces as lead sources — SHARED by every lead-entry path so a visitor
 * who scanned a business card, a yard sign or a new-home postcard resolves to
 * the same lead_sources row whichever door the lead walked in:
 *   - lead-source-evidence.js  (classifyAttributionSignals: the one precedence)
 *   - lead-source-classify.js  (/api/webhooks/lead + self-booking attribution)
 *   - lead-source-resolver.js  (quote wizard: public-quote, property-lookup,
 *                               lead-estimate-link)
 *   - lead-webhook.js          (lead_sources lookup for the classifier result)
 *   - mail/home-book.js        (the postcard's own /h booking)
 *
 * Each piece carries utm_source=<utmSource> on its link (the website keeps the
 * first touch in sessionStorage and sends it with the quote or the form):
 *   business card  /quote/?utm_source=business_card
 *   yard sign      /neighbor/?utm_source=yard_sign&utm_medium=print&utm_campaign=neighbor
 *   postcard       /h/<token> (booked on the portal) or a typed link miss with
 *                  utm_source=new_home_postcard&utm_medium=print
 *
 * Rule: utm_source naming one of the pieces decides, whatever the medium (the
 * business card link has none). Otherwise utm_medium=print with an unknown
 * source falls back to PRINT_OTHER, so an untracked printed piece is still
 * counted as print and never reads as the website it linked to.
 * Precedence against everything else lives in lead-source-evidence.js: GBP and
 * Maps, click ids and paid tags win over print; print wins over AI, social,
 * search, referrers and website landings.
 *
 * `sourceType` and `name` mirror the rows seeded by migration
 * 20261124150000_print_lead_sources.js EXACTLY (a pushed migration is frozen;
 * these constants follow it, not the other way around). Rows share
 * channel='offline' and are matched by source_type, which is stable even if the
 * office renames a row.
 */
const PRINT_SOURCES = [
  { key: 'business_card', utmSource: 'business_card', sourceType: 'business_card', name: 'Business card', label: 'Business card' },
  { key: 'yard_sign', utmSource: 'yard_sign', sourceType: 'yard_sign', name: 'Yard sign', label: 'Yard sign' },
  { key: 'new_home_postcard', utmSource: 'new_home_postcard', sourceType: 'new_home_postcard', name: 'New-home postcard', label: 'New-home postcard' },
];

// Unknown print source: utm_medium=print with a utm_source that names no piece.
const PRINT_OTHER = {
  key: 'print_other', utmSource: null, sourceType: 'print_other', name: 'Print — other', label: 'Print (other piece)',
};

const PRINT_MEDIUM = 'print';
const PRINT_CHANNEL = 'offline';

const ALL = [...PRINT_SOURCES, PRINT_OTHER];

// source / medium: already trimmed, lowercased, spaces and hyphens as "_"
// (attributionParts in lead-source-evidence.js). Null when the touch is not print.
function findPrintSource(source, medium) {
  const named = PRINT_SOURCES.find((row) => source && row.utmSource === source);
  if (named) return named;
  return medium === PRINT_MEDIUM ? PRINT_OTHER : null;
}

// The classifier's lead_source key (determineLeadSource().source) → row, or null.
function printSourceByKey(key) {
  return ALL.find((row) => row.key === key) || null;
}

module.exports = {
  PRINT_SOURCES, PRINT_OTHER, PRINT_MEDIUM, PRINT_CHANNEL, findPrintSource, printSourceByKey,
};
