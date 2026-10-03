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

function routeSpellingVariants(text) {
  const avenue = LEADING_AVENUE_RE.exec(text);
  if (avenue) return [text, `${avenue[1]}AVENUE${avenue[2]}`];
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
