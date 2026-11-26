// The ONE normalizer pair for a home's wall construction and foundation text (owner 2026-11-26, WDO inspection by size and
// construction). Every entry that turns free text into the construction / foundation enums the pricers compare against goes
// through here: county record ingestion (ai-property-lookup), tech-verified entries (lookup-cache), the WDO service override, and
// priceWDO itself as a last step on whatever string arrives. A test (wdo-size-construction-price.test.js) fails when another
// non-test file in server/ keeps its own text matcher for these two fields.
//
// One ordered rule list per field, most specific first: the first rule that matches wins.

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

function normalizeConstruction(raw) {
  const s = String(raw || '').toUpperCase();
  const withoutSteelFrame = s.replace(STEEL_FRAME, ' ');
  const flags = {
    wood: /WOOD|FRAME|TIMBER/.test(withoutSteelFrame),
    masonry: MASONRY.test(s),
    metal: /METAL|STEEL|PREFAB/.test(s),
  };
  const rule = CONSTRUCTION_RULES.find(([, test]) => test(withoutSteelFrame, flags));
  return rule ? rule[0] : undefined;
}

// Foundation enums: CRAWLSPACE, RAISED, BASEMENT, SLAB. A raised or crawl-space read is named before any "concrete" word can make it
// a slab (concrete piers and concrete pilings are raised), and a stem wall is a raised foundation.
const FOUNDATION_RULES = [
  ['CRAWLSPACE', /CRAWL/],
  ['RAISED', /RAISED|ELEVATED|PIER|PILING|PILE|STILT|STEM[\s_-]*WALL/],
  ['BASEMENT', /BASEMENT/],
  ['SLAB', /SLAB|MONOLITHIC|ON[\s_-]*GRADE|CONCRETE/],
];

function normalizeFoundation(raw) {
  const s = String(raw || '').toUpperCase();
  const rule = FOUNDATION_RULES.find(([, test]) => test.test(s));
  return rule ? rule[0] : undefined;
}

// The WDO price column of a normalized construction: block-class walls, frame-class walls, or null (unknown, metal: not in the table).
function wdoWallColumn(construction) {
  if (construction === 'CBS' || construction === 'BRICK') return 'block';
  if (construction === 'WOOD_FRAME' || construction === 'MIXED') return 'frame';
  return null;
}

// A crawl space or raised foundation prices in its own WDO column, whatever the walls are made of.
const foundationIsCrawlClass = (foundation) => foundation === 'CRAWLSPACE' || foundation === 'RAISED';

module.exports = { normalizeConstruction, normalizeFoundation, wdoWallColumn, foundationIsCrawlClass, CONSTRUCTION_RULES, FOUNDATION_RULES };
