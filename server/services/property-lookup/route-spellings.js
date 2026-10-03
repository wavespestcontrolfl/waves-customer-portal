'use strict';

// Other spellings a county roll uses for a canonical numbered route (the key
// normalizeCountyStreetLine produces: "SR 70", "US 41", "CR 675"). Live reads
// 10-02: Manatee/Charlotte spell "SR 70 E" / "SR 31", but Sarasota has no SR
// rows at all — it writes "STATE ROAD 72" (and one "STATE RD 72") — and
// Hillsborough writes "US HWY 41" / "STATE ROAD 674". A LIKE on the canonical
// key alone reads "street not found" there. The optional leading house number
// (the audit's targeted "9155 SR 70" query) is kept on every variant. Row
// text coming back is re-normalized to the canonical key by the caller.
// A street NAMED "Avenue C" / "Avenue A" (beach towns) normalizes to
// "AVE C" — the roll writes "AVENUE C", which a LIKE on "AVE C" never finds
// (live 10-02). The spelled-out form rides along as a second spelling.
const LEADING_AVENUE_RE = /^((?:\d+[A-Z]?\s+)?(?:(?:N|S|E|W|NE|NW|SE|SW)\s+)?)AVE(\s+[A-Z0-9]{1,3})$/;

// A street type that is the street's NAME ("100 W LAKE" → key "W LK") cannot
// be stripped from the query, and a roll may spell it either way. The other
// spelling of a terminal USPS suffix word (standard → its USPS primary
// name: LK → LAKE, VW → VIEW, VLG → VILLAGE) rides along as a second query (live audit
// P1 10-02). A word whose two forms are equal adds nothing.
const { USPS_STREET_SUFFIXES, USPS_PRIMARY_BY_STANDARD } = require('./usps-street-suffixes');

// Only when the suffix word IS the whole name (optional house number and
// directions around it) — every other street reaches the roll with its
// suffix already stripped, so it needs no second spelling.
const TERMINAL_WORD_RE = /^((?:\d+[A-Z]?\s+)?(?:(?:NE|NW|SE|SW|N|S|E|W)\s+)?)([A-Z]+)(\s+(?:NE|NW|SE|SW|N|S|E|W))?$/;
function otherSuffixSpelling(text) {
  const m = TERMINAL_WORD_RE.exec(text);
  const standard = m && USPS_STREET_SUFFIXES[m[2]];
  if (!standard) return null;
  // Only abbreviated → spelled: the normalizer only ever WRITES the
  // abbreviation ("W LK"); a spelled word in the query came from the typed
  // text as-is ("HARBOR" from "Harbor Blvd") and needs no second request.
  const primary = USPS_PRIMARY_BY_STANDARD[standard];
  if (m[2] !== standard || !primary || primary === standard) return null;
  return `${m[1]}${primary}${m[3] || ''}`;
}

function routeSpellingVariants(text) {
  const avenue = LEADING_AVENUE_RE.exec(text);
  if (avenue) return [text, `${avenue[1]}AVENUE${avenue[2]}`];
  const suffixSpelling = otherSuffixSpelling(text);
  if (suffixSpelling) return [text, suffixSpelling];
  // The targeted query can carry a pre-direction ("123 N US 41"); it is kept
  // ahead of every spelling ("123 N US HWY 41").
  const m = /^((?:\d+[A-Z]?\s+)?(?:(?:N|S|E|W|NE|NW|SE|SW)\s+)?)(SR|US|CR)\s+(\d{1,4}[A-Z]?)$/.exec(text);
  if (!m) return [text];
  const [, prefix = '', type, number] = m;
  const spellings = {
    SR: [`SR ${number}`, `STATE ROAD ${number}`, `STATE RD ${number}`],
    US: [`US ${number}`, `US HWY ${number}`, `US HIGHWAY ${number}`],
    CR: [`CR ${number}`, `COUNTY ROAD ${number}`, `COUNTY RD ${number}`],
  }[type];
  return spellings.map((spelling) => `${prefix}${spelling}`);
}

module.exports = { routeSpellingVariants };
