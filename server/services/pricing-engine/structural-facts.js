// The ONE normalizer pair for a home's wall construction and foundation text (owner 2026-11-26, WDO inspection by size and
// construction). Every entry that turns free text into the construction / foundation enums the pricers compare against goes
// through here: county record ingestion (ai-property-lookup), tech-verified entries (lookup-cache), the WDO service override, and
// priceWDO itself as a last step on whatever string arrives. A test (wdo-size-construction-price.test.js) fails when another
// non-test file in server/ keeps its own text matcher for these two fields.
//
// One ordered rule list per field, most specific first: the first rule that matches wins.
//
// A person's text can deny or doubt a feature: "concrete slab, no crawl space", "CBS, not wood frame", "possible crawl space".
// Text with one of the doubt words below is read clause by clause (split on , ; . ( ) | and line breaks): a clause that denies or
// doubts is dropped, and the rest may give a base reading only (slab or basement; block, brick or metal).
//
// A premium reading (crawl space or raised; wood frame or mixed) raises the WDO price, so it stands only on text that is exactly one
// of its names (PREMIUM_NAMES below; case, spacing and punctuation aside): the enum itself, as a dropdown sends it, or the plain
// words a person types for it. Any other text that reads as a premium reads unknown: "CBS with wood siding" (siding is a finish,
// not a frame), "crawl space: 0", "crawl space excluded", "slab and crawl space". So no wording can raise a price: the quote takes
// the block / slab price with the staff note until someone names the value. A base reading needs no such check: it never raises one.
//
// The one exception is county record ingestion (readCountyConstruction): an appraiser's wall code names what the wall is
// ("WOOD FRAME/STUCCO", "CONC BLOCK/STUCCO"), so a code with no doubt word reads in full, as it always has. Stucco there is the
// finish over either wall and names no wall: "FRAME STUCCO" is wood frame and "STUCCO" alone is unknown, as county ingestion
// always read them.
const DOUBT = /\b(NO|NOT|NON|NONE|NOR|NEITHER|NEVER|WITHOUT|W\/O|N\/A|ABSENT|FORMER|FORMERLY|PREVIOUS|PREVIOUSLY|REMOVED|FILLED|CONVERTED|RULED|POSSIBLE|POSSIBLY|MAYBE|MIGHT|PROBABLY|LIKELY|PERHAPS|UNSURE|UNKNOWN|UNCONFIRMED|UNVERIFIED|SUSPECTED|POTENTIAL)\b|N['\u2019]T\b|\?/;
const CLAUSE_BREAK = /[,;.()|\r\n]+/;

function readDoubtAware(s, read, baseReadings) {
  if (!DOUBT.test(s)) return read(s);
  const reading = read(s.split(CLAUSE_BREAK).filter((clause) => !DOUBT.test(clause)).join(', '));
  return baseReadings.includes(reading) ? reading : undefined;
}

// The exact names of each premium reading, its words joined by single spaces (WOOD_FRAME is "WOOD FRAME"): the enum, the plain
// words for it, and the technician phrasings the WDO tests carry to the price. A new phrasing is added here, with its test.
const PREMIUM_NAMES = {
  WOOD_FRAME: ['WOOD FRAME', 'WOOD FRAMED', 'WOOD', 'FRAME', 'FRAMED', 'FRAME CONSTRUCTION', 'WOOD FRAME CONSTRUCTION', 'TIMBER FRAME'],
  MIXED: ['MIXED', 'MIXED CONSTRUCTION', 'FRAME STUCCO', 'WOOD FRAME STUCCO', 'STUCCO OVER FRAME', 'STUCCO OVER WOOD FRAME',
    'BLOCK WITH WOOD FRAME ADDITION', 'BRICK VENEER OVER FRAME'],
  CRAWLSPACE: ['CRAWLSPACE', 'CRAWL SPACE', 'CRAWL', 'VENTED CRAWLSPACE', 'VENTED CRAWL SPACE', 'CRAWLSPACE FOUNDATION',
    'CRAWL SPACE FOUNDATION'],
  RAISED: ['RAISED', 'RAISED FOUNDATION', 'RAISED FLOOR', 'RAISED SLAB', 'ELEVATED', 'ELEVATED ON STILTS', 'PIERS', 'ON PIERS',
    'RAISED ON PIERS', 'CONCRETE PIERS', 'PIER AND BEAM', 'PIERS AND BEAMS', 'PILINGS', 'ON PILINGS', 'RAISED ON PILINGS',
    'CONCRETE PILINGS', 'STILTS', 'ON STILTS', 'STEM WALL', 'STEMWALL'],
};

function readAffirmed(raw, read, baseReadings) {
  const s = String(raw || '').toUpperCase();
  const reading = readDoubtAware(s, read, baseReadings);
  if (reading === undefined || baseReadings.includes(reading)) return reading;
  return PREMIUM_NAMES[reading].includes(s.split(/[^A-Z0-9]+/).filter(Boolean).join(' ')) ? reading : undefined;
}

// "Steel/metal frame" is metal, never wood frame, so those words are lifted out before the frame test.
const STEEL_FRAME = /(STEEL|METAL)[\s_-]*FRAM(E|ED|ING)/g;
const MASONRY = /CONCRETE|CBS|CMU|BLOCK|MASONRY|STUCCO|BRICK/;

// Construction enums: CBS, BRICK, WOOD_FRAME, MIXED, METAL. Text naming both a wood/frame wall and a masonry wall (block, concrete,
// stucco, brick) is MIXED whatever order the words come in; metal wins only when no wood or masonry is named.
const CONSTRUCTION_RULES = [
  ['MIXED', (s, f) => /MIXED/.test(s) || (f.wood && f.masonry)],
  ['METAL', (s, f) => f.metal && !f.wood && !f.masonry],
  ['CBS', (s) => /CONCRETE|CBS|CMU|BLOCK|MASONRY|STUCCO/.test(s)],
  ['BRICK', (s) => /BRICK/.test(s)],
  ['WOOD_FRAME', (s, f) => f.wood],
];

function readConstruction(s) {
  const withoutSteelFrame = s.replace(STEEL_FRAME, ' ');
  const flags = {
    wood: /WOOD|FRAME|TIMBER/.test(withoutSteelFrame),
    masonry: MASONRY.test(s),
    metal: /METAL|STEEL|PREFAB/.test(s),
  };
  const rule = CONSTRUCTION_RULES.find(([, test]) => test(withoutSteelFrame, flags));
  return rule ? rule[0] : undefined;
}
const CONSTRUCTION_BASE = ['CBS', 'BRICK', 'METAL'];
const normalizeConstruction = (raw) => readAffirmed(raw, readConstruction, CONSTRUCTION_BASE);
const readCountyConstruction = (raw) => readDoubtAware(String(raw || '').toUpperCase().replace(/STUCCO/g, ' '), readConstruction,
  CONSTRUCTION_BASE) || null;

// Foundation enums: CRAWLSPACE, RAISED, BASEMENT, SLAB. A raised or crawl-space read is named before any "concrete" word can make it
// a slab (concrete piers and concrete pilings are raised), and a stem wall is a raised foundation.
const FOUNDATION_RULES = [
  ['CRAWLSPACE', /CRAWL/],
  ['RAISED', /RAISED|ELEVATED|PIER|PILING|PILE|STILT|STEM[\s_-]*WALL/],
  ['BASEMENT', /BASEMENT/],
  ['SLAB', /SLAB|MONOLITHIC|ON[\s_-]*GRADE|CONCRETE/],
];

function readFoundation(s) {
  const rule = FOUNDATION_RULES.find(([, test]) => test.test(s));
  return rule ? rule[0] : undefined;
}
const normalizeFoundation = (raw) => readAffirmed(raw, readFoundation, ['SLAB', 'BASEMENT']);

// The WDO price column of a normalized construction: block-class walls, frame-class walls, or null (unknown, metal: not in the table).
function wdoWallColumn(construction) {
  if (construction === 'CBS' || construction === 'BRICK') return 'block';
  if (construction === 'WOOD_FRAME' || construction === 'MIXED') return 'frame';
  return null;
}

// A crawl space or raised foundation prices in its own WDO column, whatever the walls are made of.
const foundationIsCrawlClass = (foundation) => foundation === 'CRAWLSPACE' || foundation === 'RAISED';

module.exports = { normalizeConstruction, normalizeFoundation, readCountyConstruction, wdoWallColumn, foundationIsCrawlClass, CONSTRUCTION_RULES, FOUNDATION_RULES };
