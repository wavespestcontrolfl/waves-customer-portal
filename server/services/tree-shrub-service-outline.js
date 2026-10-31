// Tree & Shrub program overview, behind GATE_TS_OUTLINE (owner 2026-10-26: "also we need to go through other related
// outlines, etc and make sure they are more aligned like lawn outline"; decision D4-A, "do whatever you recommend").
// The lawn outline's customer page for the Tree & Shrub program: the same packet shape as lawn-service-outline.js
// buildOutline, so the composer, the send route and the public page take it as they take a lawn packet.
//
// Each fact is the Tree & Shrub protocol's (server/config/protocols.json tree_shrub: the month cards, the annual
// rotation, the costing notes), an approved report tip, or a UF/IFAS fact; the draft went through a review against
// the protocol before the owner's word check (decision page "Tree & Shrub Outline", choices T1-T6 at their
// recommended answers). No rate, price, tier, visit count or visit date; product names only in the product list.
const { inferEstimateServiceLines } = require('./estimate-service-lines');
const {
  PRODUCT_REGISTRY_VERSION,
  TEMPLATE_VERSION,
  V13_COPY,
  WATERING_ORDER,
  addressSummary,
  currentMonthNumber,
  estimateSnapshot,
  estimateViewPath,
  firstNonEmpty,
  isRestrictedSeason,
  loadFertilizerRule,
  makeSection,
  parseJsonMaybe,
  renderOutlineHtml,
  resolveJurisdictionId,
  resolveSeasonBand,
  validateContent,
} = require('./lawn-service-outline');
const featureGates = require('../config/feature-gates');
const { etDateString } = require('../utils/datetime-et');
const PROTOCOLS = require('../config/protocols.json');

const SERVICE_LINE = 'tree_shrub';
const TS_CONTENT_LIBRARY_VERSION = 'ts-v1-copy-1';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const FULL_MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

// GATE_TS_OUTLINE: staff can build and send a Tree & Shrub outline from an estimate. Off = no Tree & Shrub outline
// can be built, regenerated or sent; a stored one still opens for the customer who has the link.
function treeShrubOutlineLive() {
  return featureGates.tsOutlineLive?.() === true;
}

function treeShrubProtocol() {
  return PROTOCOLS.tree_shrub || {};
}

// The stamp a packet keeps: a protocol edit marks older outlines for a regenerate on the Estimates list.
function treeShrubProtocolVersion() {
  return treeShrubProtocol().version || null;
}

function estimateHasTreeShrubService(estimate = {}, estimateData = {}) {
  const lines = inferEstimateServiceLines({ ...estimate, estimateData: estimate.estimate_data ?? estimateData });
  return lines.some((line) => line.key === SERVICE_LINE);
}

const tilesSection = (key, title, body, tiles) => makeSection(key, title, body, tiles.map((tile) => `${tile.title}: ${tile.text}`), { type: 'tiles', items: tiles });

const STEP_LABELS = Object.freeze({
  inspection: 'Inspection',
  barrier: 'Bed weed barrier',
  feeding: 'Fertilizer',
  insects: 'Insect and mite control',
  micros: 'Micronutrients',
  disease: 'Disease control',
});
const STEP_ORDER = Object.keys(STEP_LABELS);
const MAIN_STEPS = new Set(['inspection', 'barrier', 'feeding']);

// Each month card line's step, first match wins; a line no step covers is left out (a note, a scout reminder, the
// summer-limit line). Not program steps: root stimulants and the hedge growth regulator (quoted separately, decision
// T3), injections (the Palm Injections add-on) and the year report (not promised, decision T5).
const NOT_PROGRAM_LINE_RE = /nutriroot|cytogro|superthrive|shortstop|mn-jet|palm-jet|propizol|injection|annual health report/i;
const STEP_PATTERNS = Object.freeze([
  [/snapshot/i, 'barrier'],
  [/\b\d{1,2}-0-\d{1,2}\b/, 'feeding'],
  [/sequestar|manganese sulfate|acidifier/i, 'micros'],
  [/merit|zylam|tristar|tritek|conserve|floramite|mainspring|distance igr|acelepryn|dipel|4a\/neonic/i, 'insects'],
  [/reliant|copper|fungicide/i, 'disease'],
]);

function cardLines(text) {
  return String(text || '').split('\n').map((line) => line.trim()).filter(Boolean);
}

function lineStep(line, { primary }) {
  if (NOT_PROGRAM_LINE_RE.test(line)) return null;
  if (primary && /^scout\b/i.test(line)) return 'inspection';
  return STEP_PATTERNS.find(([pattern]) => pattern.test(line))?.[1] || null;
}

// A month's steps from its protocol card: the bed weed barrier, the feedings and a scouting visit are the card's main
// work (each "only when due"); every other step goes on only where needed, primary-line sprays included ("where the
// target pest fits").
function monthSteps(visit) {
  const steps = [
    ...cardLines(visit?.primary).map((line) => lineStep(line, { primary: true })),
    ...cardLines(visit?.secondary).map((line) => lineStep(line, { primary: false })),
  ].filter(Boolean);
  const primarySteps = new Set(cardLines(visit?.primary).map((line) => lineStep(line, { primary: true })).filter((step) => MAIN_STEPS.has(step)));
  return {
    main: STEP_ORDER.filter((step) => primarySteps.has(step)),
    asNeeded: STEP_ORDER.filter((step) => !primarySteps.has(step) && steps.includes(step)),
  };
}

const TS_COPY = Object.freeze({
  title: 'Your Waves Tree & Shrub Program Overview',
  intro: (customerName) => `Based on your estimate for ${customerName}. One program covers the trees, shrubs, palms and beds on your estimate. What each visit applies is decided on site, from what the plants show, the weather, the product label, and local rules.`,
  programLabel: 'One program for every landscape',
  programTitle: 'One Program For Every Landscape',
  programBody: 'Built for Southwest Florida yards: palms, hedges such as ficus, and shrubs such as ixora, hibiscus and crotons. Every product is applied within its label.',
  programTiles: Object.freeze([
    { icon: 'inspection', title: 'Look first, treat second', text: 'Each visit starts with a walk of the beds, palms and trees. Sprays go only where live insects or mites are found. A root-zone treatment goes only on plants where the same pest has come back.' },
    { icon: 'feeding', title: 'Palm care for palms', text: 'Palms get their own slow-release fertilizer, weighed for each palm.' },
    { icon: 'rotate', title: 'Resistance management', text: 'Products are rotated by chemical group and logged after every use.' },
  ].map((tile) => Object.freeze(tile))),
  yearTitle: 'Your Year At A Glance',
  yearBody: 'Each visit does the work of the month it falls in. This month and the next two are open; tap any month to see what a visit then does and one thing to do at home. Feedings and the bed weed barrier go down only when due.',
  limitLabel: 'Local summer limits on nitrogen and phosphorus',
  // The month's visit line and one thing to do at home: the protocol card's work in plain words, and an approved
  // report tip or a UF/IFAS fact word for word.
  months: Object.freeze({
    1: { visit: 'Weed barrier and winter palm feeding when due; insect, oil and iron treatments only where needed.', atHome: 'After a cold snap, wait until spring growth starts before cutting back damaged branches.' },
    2: { visit: 'A spray visit for scale, mites and whitefly where found; the spring shrub feeding goes down if due.', atHome: 'Leave yellowing lower palm fronds on; the palm pulls nutrients from them, and cutting them speeds the decline.' },
    3: { visit: 'A spray visit aimed at whitefly and scale before summer, where found.', atHome: 'Rinsing dusty shrubs with plain water during dry spells helps keep mites from building up.' },
    4: { visit: 'Feedings when due and allowed; scale crawlers and young whitefly checked for.', atHome: 'Whitefly and scale live on the underside of leaves, so that’s the best place to look between visits.' },
    5: { visit: 'The last nitrogen feedings before the summer limits, where allowed.', atHome: 'When fronds are trimmed, keep everything above the 9-to-3 o’clock line on the palm.' },
    6: { visit: 'Summer limits: palms may get a feeding with no nitrogen or phosphorus; heat-stressed plants are noted, not sprayed.', atHome: 'Beds that stay soggy for days are where root rot starts; check for a stuck zone or a broken head.' },
    7: { visit: 'A scouting visit: bed weeds, whitefly, scale crawlers, palm symptoms and heat stress; treatment only where found.', atHome: 'Fresh chewing on new growth is often caterpillars; a quick look at dusk can spot them.' },
    8: { visit: 'Lightest on products, heaviest on looking; whitefly treated by life stage where found.', atHome: 'New trees and shrubs need extra water at first. UF/IFAS says a small new tree needs daily water for its first 2 weeks, and full establishment takes 3 to 4 months per inch of trunk thickness. The watering rules allow new plants extra days for their first 60.' },
    9: { visit: 'Late-summer scale and whitefly treated where found.', atHome: 'After saltwater flooding, UF/IFAS says to flush the soil thoroughly with fresh water to move the salt down through it, and not to rush to prune or pull plants that look burned. Text us a photo.' },
    10: { visit: 'The fall reset: weed barrier and nitrogen feedings again where allowed, and a fall scale check.', atHome: 'When the sprinklers go back up after the rains, check that they reach the beds without hitting stems and trunks.' },
    11: { visit: 'A cool-season cleanup, not a dormant spray: late-fall feedings when due, micronutrients where needed.', atHome: 'UF/IFAS says 2 to 3 inches of mulch controls weeds without smothering the roots, and more than 3 inches can hurt the plants. Topping up the thin spots in the beds helps between visits.' },
    12: { visit: 'Feedings when due; declining palms and stubborn yellowing get a closer look for next year’s plan.', atHome: 'After a freeze, leave brown palm fronds on until the cold season ends; we check the spear leaf at the next visit.' },
  }),
  problemsTitle: 'Problems We Watch For',
  problemsBody: 'How to spot common Southwest Florida plant problems, and what we do.',
  problemTiles: Object.freeze([
    { icon: 'insects', title: 'Scale and sooty mold', text: 'Bumps or wax on stems and leaves, sticky leaves, black film and ants. The film grows on honeydew the insects drip, sometimes from a tree above. We check that the scale is alive before treating, because dead scale stays on leaves for months; we treat the insect, and the film weathers off after.' },
    { icon: 'insects', title: 'Whitefly on ficus', text: 'Ficus hedges are the whitefly’s favorite here. UF/IFAS calls Ficus benjamina the preferred host of the ficus whitefly in Florida, and says left untreated it can strip a hedge of its leaves. Leaf drop on a ficus is worth a call.' },
    { icon: 'micros', title: 'Yellow new leaves', text: 'Yellow new leaves with green veins, often on ixora by a driveway, usually mean alkaline soil, not hunger. More fertilizer or Epsom salt does not fix it; root-zone iron goes on where it shows.' },
    { icon: 'feeding', title: 'Yellow or spotted palm fronds', text: 'Spotted or yellow-banded oldest fronds usually mean a potassium or magnesium shortage; frizzled new fronds, manganese. Old fronds never turn green again: three to six months for manganese, one to two years or more for potassium.' },
    { icon: 'disease', title: 'Palm decline', text: 'An even bronze rising from the oldest fronds, a hard shelf low on the trunk, fronds dying down one side, or a collapsed spear: we photograph it and call you. It needs a diagnosis; feeding does not prevent it.' },
    { icon: 'dry_spots', title: 'Water, not pests', text: 'Root rot from overwatering looks like drought — wilting and yellowing — and the reflex is to water more. Established shrubs want deep, infrequent watering; let the top inch of soil dry between runs.' },
  ].map((tile) => Object.freeze(tile))),
  treatmentsTitle: 'Treatments That May Be Used',
  treatmentsBody: 'Which ones a visit uses depends on the season, the weather, the label, local rules, and what the plants show.',
  // Two cards share the fertilizer icon and two the insect icon: `key` is the icon, so the page keys a card by its label.
  treatments: Object.freeze([
    { key: 'inspection', label: 'Inspection', text: 'Every palm, bed and tree, each visit; some visits are inspection only.' },
    { key: 'barrier', label: 'Bed weed barrier', text: 'A granular pre-emergent in beds, at least 60 days apart; it stops weed seeds, not weeds already up.' },
    { key: 'feeding', label: 'Palm fertilizer', text: 'Slow-release, spread under the whole canopy, at least three months apart.' },
    { key: 'feeding', label: 'Shrub fertilizer', text: 'Slow-release, up to twice a year in spring and late fall, below the bag’s amount to stay inside the county nitrogen limit.' },
    { key: 'micros', label: 'Micronutrients', text: 'Iron, manganese or soil acidifier, only where a shortage shows.' },
    { key: 'insects', label: 'Insect and mite control', text: 'Sprays on live finds, matched to the life stage. Root-zone (neonicotinoid) treatments only where the same pest has come back, within a yearly limit.' },
    { key: 'insects', label: 'Spray oil', text: 'For live scale crawlers and mites; never above 90°F, on drought-stressed plants or before a cold snap.' },
    { key: 'disease', label: 'Disease control', text: 'Only for a diagnosed problem; beds with a root-rot history, and replacement plantings, may get a root-rot product. No routine fungicide.' },
  ].map((item) => Object.freeze(item))),
  productsTitle: 'Products We May Use',
  productsBody: 'Each visit uses only what the plants need. Your service report names every product applied, with its EPA number.',
  visitSteps: Object.freeze([
    { icon: 'inspection', title: 'Check', text: 'Every palm, bed and tree: leaves, stems, trunks, soil moisture, mulch and sprinkler spray' },
    { icon: 'decide', title: 'Decide', text: 'Treat, fix the site, or watch, by pest, life stage, blooms, weather, label and local rules' },
    { icon: 'treat', title: 'Treat', text: 'Bed and palm granules when due, then spot sprays only where needed' },
    { icon: 'report', title: 'Report', text: 'Products with EPA numbers, findings, photos, and next steps for you' },
  ].map((step) => Object.freeze(step))),
  afterTreatmentTitle: 'After A Treatment',
  afterTreatmentBody: 'Your service report lists any instructions for that visit. These are the common ones.',
  afterTreatmentTiles: Object.freeze([
    { icon: 'dry_spots', title: 'Water in, or keep leaves dry', text: 'Granules (the weed barrier and fertilizer) are watered in; some sprays need time on dry leaves. Your report says which. Run no extra irrigation unless it says to.' },
    { icon: 'calendar', title: 'Hold the trimming', text: 'Tell us before hedge trimming; pruning right after a treatment removes treated leaves.' },
    { icon: 'label', title: 'Store products', text: 'Send us a photo of the label before you put any store product on covered plants. Many store “tree and shrub” drenches carry the same insecticide we use, and the label’s yearly limit covers the whole bed, whoever applies it.' },
  ].map((tile) => Object.freeze(tile))),
  yourPartTitle: 'Your Part: Water, Mulch And Plants',
  yourPartBody: 'A few habits at home do as much as any treatment.',
  keepDryTile: Object.freeze({ icon: 'dry_spots', title: 'Keep the leaves dry', text: 'Watering beds early in the morning lets leaves dry fast, which keeps leaf spot down.' }),
  // Decision D2-A, as on the lawn outline: only for the order's rule areas, and only while it runs.
  wateringOrderTile: Object.freeze({ icon: 'calendar', title: 'Your watering day', text: 'Manatee and Sarasota are under a one-day-a-week order through March 31, 2027; your city or county sets your day by address. Beds on your sprinkler zones follow that day. Drip, soaker hoses and hand watering of plants and shrubs are allowed any day before 8 a.m. or after 6 p.m.; a hose rinse counts as hand watering. New plants get extra days for their first 60 days.' }),
  yourPartTiles: Object.freeze([
    { icon: 'area', title: 'Mulch: a donut, not a volcano', text: 'Mulch piled against the trunk keeps the bark wet, and UF/IFAS says that encourages rot. Keep it about a foot back from trees and large shrubs, 2 to 3 inches deep: a donut, not a volcano.' },
    { icon: 'feeding', title: 'New and replaced plants', text: 'Tell us when you add or replace plants. They go on your plant inventory, and a bed with a root-rot history may get a root-rot product in its first season.' },
    { icon: 'dry_spots', title: 'Reclaimed water', text: 'If your sprinklers run reclaimed (purple-pipe) water, it carries nutrients and salts: lush, soft growth or stubborn yellowing in a bed can trace to it. Tell us.' },
    { icon: 'rotate', title: 'Palm trimming', text: 'Ask your trimmer to clean tools between palms.' },
  ].map((tile) => Object.freeze(tile))),
  expectTitle: 'What To Expect',
  expectBody: 'Plants change over seasons, not days.',
  expectTiles: Object.freeze([
    { icon: 'calendar', title: 'Quiet visits are normal', text: 'Some visits find nothing to spray; deciding not to spray is part of the program.' },
    { icon: 'feeding', title: 'New growth tells', text: 'Damaged leaves stay damaged; progress shows in cleaner new growth and less honeydew.' },
    { icon: 'label', title: 'Yearly label limits', text: 'Some products are allowed once a year per label. When a plant has had it, we switch to another chemical group or wait.' },
    { icon: 'report', title: 'Something looks wrong between visits?', text: 'Text us a photo. We read the last report and look at the plant before anything is re-sprayed.' },
    { icon: 'area', title: 'Some fixes are not sprays', text: 'We do not prune or remove trees. Leaning or storm-damaged trees need an arborist; drainage or a wrong plant needs a site fix. We note and refer them.' },
  ].map((tile) => Object.freeze(tile))),
  injectionsTitle: 'Palm Injections (Add-On)',
  injectionsBody: 'Quoted per palm, after a look. Not part of the program.',
  injectionTiles: Object.freeze([
    { icon: 'inspection', title: 'Only after a diagnosis', text: 'We inject only for a diagnosed shortage or pest, or as a preventive against a disease on a palm with no symptoms, never for one yellow frond. Each injection leaves a permanent hole; results show slowly, in new fronds.' },
  ].map((tile) => Object.freeze(tile))),
  rulesInstead: 'Palms get a summer feeding with no nitrogen or phosphorus; shrubs wait for fall. Fertilizer stays 10 feet back from water and off walks.',
  safetyTiles: Object.freeze([
    { icon: 'insects', title: 'Bees and blooms', text: 'We time insect treatments around blooms to protect bees, so flowering shrubs may get a lighter touch that visit.' },
    { icon: 'area', title: 'Edible plants', text: 'The program covers ornamentals. Tell us about citrus, mango, avocado, herbs and vegetable beds before service; they are marked as no-treatment areas.' },
  ].map((tile) => Object.freeze(tile))),
  notIncludedTags: Object.freeze(['Pruning and hedge trimming', 'Tree removal', 'Arborist tree-risk check', 'Irrigation repair', 'Weeds already growing in beds', 'Palm injections', 'Plant replacement', 'Edible plants', 'Root stimulants and hedge growth regulator', 'Repeat fungicide sprays']),
  notIncludedNote: 'Pruning, removal, arborist checks and irrigation repair are other trades; we note the need and refer you. Some plant problems need a change at home instead, such as watering, drainage, mulch, or a plant suited to the spot.',
});

// Decision D1-B, as on the lawn outline: the protocol's product names with the catalog's active ingredient (read
// 2026-10-26), never a rate or a supplier code. `match` finds each product in the protocol, so a product the protocol
// drops fails the test instead of staying on the page.
const TS_PRODUCTS = Object.freeze([
  { step: 'barrier', match: /Snapshot 2\.5TG/, text: 'Snapshot 2.5TG (trifluralin + isoxaben)' },
  { step: 'feeding', match: /LESCO 8-0-12/, text: 'LESCO 8-0-12 Palm & Tropical Ornamental Fertilizer' },
  { step: 'feeding', match: /LESCO 0-0-16/, text: 'LESCO 0-0-16 Palm & Tropical Ornamental Fertilizer (summer)' },
  { step: 'feeding', match: /LESCO 13-0-13/, text: 'LESCO 13-0-13 PolyPlus Landscape' },
  { step: 'micros', match: /Sequestar 6% Fe EDDHA/, text: 'Sequestar 6% Fe EDDHA (iron)' },
  { step: 'micros', match: /Manganese sulfate \(Southern Ag\)/, text: 'Southern Ag manganese sulfate' },
  { step: 'micros', match: /Espoma/, text: 'Espoma soil acidifier (sulfur)' },
  { step: 'insects', match: /Mainspring GNL/, text: 'Mainspring GNL (cyantraniliprole)' },
  { step: 'insects', match: /Distance IGR/, text: 'Distance IGR (pyriproxyfen)' },
  { step: 'insects', match: /Acelepryn Insecticide/, text: 'Acelepryn Insecticide (chlorantraniliprole)' },
  { step: 'insects', match: /Conserve SC/, text: 'Conserve SC (spinosad)' },
  { step: 'insects', match: /DiPel PRO DF/, text: 'DiPel PRO DF (Bacillus thuringiensis)' },
  { step: 'insects', match: /Floramite/, text: 'Floramite (bifenazate)' },
  { step: 'insects', match: /TriStar 8\.5 SL/, text: 'TriStar 8.5 SL (acetamiprid)' },
  { step: 'insects', match: /TriTek spray oil/, text: 'TriTek spray oil (mineral oil)' },
  { step: 'insects', match: /Merit 2F/, text: 'Merit 2F (imidacloprid) and Zylam (dinotefuran), root-zone only where the same pest has come back' },
  { step: 'disease', match: /Reliant Systemic Fungicide/, text: 'Reliant Systemic Fungicide (potassium phosphite), for beds with a root-rot history and replacement plantings' },
  { step: 'disease', match: /Copper only for a diagnosed/, text: 'Southern Ag Copper Fungicide (copper), for a diagnosed case only' },
].map((product) => Object.freeze(product)));

function productsSection() {
  const items = ['barrier', 'feeding', 'micros', 'insects', 'disease']
    .map((step) => ({ key: step, label: STEP_LABELS[step], text: TS_PRODUCTS.filter((product) => product.step === step).map((product) => product.text).join('; ') }))
    .filter((item) => item.text);
  return makeSection('products', TS_COPY.productsTitle, TS_COPY.productsBody, items.map((item) => `${item.label}: ${item.text}`), { type: 'categories', items });
}

// The month list: each month's steps from its protocol card, its visit line and one thing to do at home. The build
// month and the next two open; the rest open on a tap.
function monthsVisual(jurisdictionRule, month) {
  const visits = treeShrubProtocol().visits || [];
  const open = new Set([0, 1, 2].map((ahead) => ((Number(month) - 1 + ahead) % 12) + 1));
  const months = MONTHS.map((label, index) => {
    const number = index + 1;
    const card = visits.find((visit) => visit.month === label);
    return {
      month: number,
      label,
      name: FULL_MONTHS[index],
      ...monthSteps(card),
      limited: isRestrictedSeason(jurisdictionRule, number),
      visit: TS_COPY.months[number].visit,
      atHome: TS_COPY.months[number].atHome,
      open: open.has(number),
    };
  });
  return { type: 'months', months, labels: STEP_LABELS, limitLabel: months.some((m) => m.limited) ? TS_COPY.limitLabel : null };
}

const stepNames = (steps) => steps.map((step) => STEP_LABELS[step]).join(', ');

function monthLines(visual) {
  return visual.months.map((m) => `${m.name}: ${stepNames(m.main)}${m.asNeeded.length ? `; as needed: ${stepNames(m.asNeeded)}` : ''}. ${m.visit} At home: ${m.atHome}`);
}

function yourPartTiles(jurisdictionId, now) {
  const orderLive = WATERING_ORDER.jurisdictions.includes(jurisdictionId) && etDateString(now) <= WATERING_ORDER.until;
  return [TS_COPY.keepDryTile, ...(orderLive ? [{ ...TS_COPY.wateringOrderTile, until: WATERING_ORDER.until }] : []), ...TS_COPY.yourPartTiles];
}

// The rule area and its summary come from the rule the outline resolved, as on the lawn outline; no dates.
function ruleTiles(jurisdictionRule) {
  return [
    { icon: 'area', title: 'Your rule area', text: jurisdictionRule?.jurisdiction_name || 'To be confirmed' },
    { icon: 'calendar', title: 'What it limits', text: jurisdictionRule?.public_summary || 'Local fertilizer rules may affect what nutrient products can be used.' },
    { icon: 'micros', title: 'What we do instead', text: TS_COPY.rulesInstead },
  ];
}

function treeShrubSections({ month, jurisdictionRule, now }) {
  const months = monthsVisual(jurisdictionRule, month);
  return [
    tilesSection('tree_shrub_program', TS_COPY.programTitle, TS_COPY.programBody, TS_COPY.programTiles),
    makeSection('program_year', TS_COPY.yearTitle, TS_COPY.yearBody, monthLines(months), months),
    tilesSection('problems', TS_COPY.problemsTitle, TS_COPY.problemsBody, TS_COPY.problemTiles),
    makeSection('treatment_categories', TS_COPY.treatmentsTitle, TS_COPY.treatmentsBody, TS_COPY.treatments.map((item) => `${item.label}: ${item.text}`), { type: 'categories', items: TS_COPY.treatments }),
    productsSection(),
    makeSection('typical_visit', 'What A Typical Visit Includes', '', TS_COPY.visitSteps.map((step) => `${step.title}: ${step.text}`), { type: 'steps', items: TS_COPY.visitSteps }),
    tilesSection('after_treatment', TS_COPY.afterTreatmentTitle, TS_COPY.afterTreatmentBody, TS_COPY.afterTreatmentTiles),
    tilesSection('your_part', TS_COPY.yourPartTitle, TS_COPY.yourPartBody, yourPartTiles(jurisdictionRule?.jurisdiction_id, now)),
    tilesSection('what_to_expect', TS_COPY.expectTitle, TS_COPY.expectBody, TS_COPY.expectTiles),
    tilesSection('palm_injections', TS_COPY.injectionsTitle, TS_COPY.injectionsBody, TS_COPY.injectionTiles),
    tilesSection('local_rules', V13_COPY.rulesTitle, '', ruleTiles(jurisdictionRule)),
    tilesSection('safety', V13_COPY.safetyTitle, '', [...V13_COPY.safetyTiles, ...TS_COPY.safetyTiles]),
    tilesSection('after_visit', V13_COPY.afterVisitTitle, '', V13_COPY.afterVisitTiles),
    makeSection('not_included', V13_COPY.notIncludedTitle, '', TS_COPY.notIncludedTags, { type: 'tags', items: TS_COPY.notIncludedTags, note: TS_COPY.notIncludedNote }),
  ];
}

async function buildTreeShrubOutline({ db, estimate, input = {}, now = new Date() }) {
  const estimateData = parseJsonMaybe(estimate.estimate_data || estimate.estimateData) || {};
  const month = Number(input.month || currentMonthNumber(now));
  const seasonBand = resolveSeasonBand(month);
  const jurisdictionId = input.jurisdictionId || resolveJurisdictionId(estimate.address);
  const jurisdictionRule = await loadFertilizerRule(db, jurisdictionId);
  const restrictedSeasonActive = isRestrictedSeason(jurisdictionRule, month);
  const ruleJurisdictionId = jurisdictionRule?.jurisdiction_id || jurisdictionId;
  const snapshot = estimateSnapshot(estimate, estimateData);
  const customerName = firstNonEmpty(snapshot.customerName, 'your property');
  const tier = firstNonEmpty(input.serviceTier, snapshot.tier, estimateData.serviceTier, 'tree & shrub');
  const protocol = treeShrubProtocol();

  const content = {
    serviceLine: SERVICE_LINE,
    title: TS_COPY.title,
    intro: TS_COPY.intro(customerName),
    generatedAt: now.toISOString(),
    detailLevel: input.detailLevel || 'standard',
    property: {
      customerName: snapshot.customerName,
      addressSummary: addressSummary(snapshot.address),
      turfType: null,
      programLabel: TS_COPY.programLabel,
      serviceTier: tier,
    },
    season: {
      month,
      monthName: MONTHS[month - 1],
      seasonBand,
      restrictedSeasonActive,
    },
    localRule: {
      jurisdictionId: ruleJurisdictionId,
      jurisdictionName: jurisdictionRule?.jurisdiction_name || null,
      version: jurisdictionRule?.version || null,
      summary: jurisdictionRule?.public_summary || null,
      restrictedSeasonActive,
    },
    sections: treeShrubSections({ month, jurisdictionRule, now }),
    treatmentCategories: TS_COPY.treatments.map((item) => ({ ...item })),
    productCards: [],
    cta: {
      label: snapshot.token ? 'View Estimate' : 'Request Callback',
      estimatePath: estimateViewPath(snapshot),
    },
  };

  const validation = validateContent(content, { turfType: null, includeProductCards: false, jurisdictionRule });

  return {
    estimateData,
    estimateSnapshot: snapshot,
    inputSnapshot: {
      ...input,
      serviceLine: SERVICE_LINE,
      turfType: null,
      month,
      seasonBand,
      jurisdictionId,
      includeProductCards: false,
      includeProductCategories: input.includeProductCategories !== false,
    },
    summary: {
      title: content.title,
      serviceLine: SERVICE_LINE,
      turfType: null,
      turfLabel: null,
      seasonBand,
      month,
      jurisdictionId: ruleJurisdictionId,
      restrictedSeasonActive,
      productCardCount: 0,
      validationStatus: validation.status,
      serviceLineDetected: estimateHasTreeShrubService(estimate, estimateData),
    },
    content,
    contentHtml: renderOutlineHtml(content),
    validation,
    meta: {
      serviceLine: SERVICE_LINE,
      turf: { turfType: null, label: null, confidence: null, mixed: false },
      track: { name: protocol.name || null },
      visit: null,
      jurisdictionRule,
      templateVersion: TEMPLATE_VERSION,
      contentLibraryVersion: TS_CONTENT_LIBRARY_VERSION,
      productRegistryVersion: PRODUCT_REGISTRY_VERSION,
      protocolVersion: treeShrubProtocolVersion(),
    },
  };
}

module.exports = {
  SERVICE_LINE,
  STEP_LABELS,
  TS_CONTENT_LIBRARY_VERSION,
  TS_COPY,
  TS_PRODUCTS,
  buildTreeShrubOutline,
  estimateHasTreeShrubService,
  monthSteps,
  treeShrubOutlineLive,
  treeShrubProtocolVersion,
};
