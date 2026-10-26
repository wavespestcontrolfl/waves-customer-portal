// Pest Control program overview, behind GATE_PEST_OUTLINE (owner 2026-10-26: "also we need to go through other related
// outlines, etc and make sure they are more aligned like lawn outline"; decision D4-A, "do whatever you recommend": Tree
// & Shrub, then Pest, then Mosquito). The lawn outline's customer page for the recurring pest plan, in the same packet
// shape, so the composer, the send route and the public page take it as they take a lawn packet.
//
// Each fact is an owner ruling (sms-company-facts.js, the 2026-10-03 stop walkthrough, the 2026-10-22 inside rule, the
// 2026-10-24 rain rule), the pest protocol, the Service Details guide, an approved report tip (GATE_TECH_TIP_SOURCES is
// on, so the tips' sourced wording) or a UF/IFAS fact; the draft went through a review against them (pest-draft
// fable-attack-pest.md). No rate, price, visit count, band width, timing or terms; product names only in the product
// list, read from the catalog. The plan's two opt-outs (estimate-public.js SERVICE_PREFS: interior spraying and the
// eave sweep) change the words: an exterior-only plan never reads an inside promise.
const { inferEstimateServiceLines } = require('./estimate-service-lines');
const {
  PRODUCT_REGISTRY_VERSION,
  TEMPLATE_VERSION,
  V13_COPY,
  activeIngredientText,
  addressSummary,
  currentMonthNumber,
  estimateSnapshot,
  estimateViewPath,
  firstNonEmpty,
  loadFertilizerRule,
  makeSection,
  parseJsonMaybe,
  renderOutlineHtml,
  resolveJurisdictionId,
  resolveSeasonBand,
  validateContent,
} = require('./lawn-service-outline');
const featureGates = require('../config/feature-gates');
const PROTOCOLS = require('../config/protocols.json');

const SERVICE_LINE = 'pest_control';
const PEST_CONTENT_LIBRARY_VERSION = 'pest-v1-copy-1';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// GATE_PEST_OUTLINE: staff can build and send a Pest Control outline from an estimate. Off = no Pest Control outline can
// be built, regenerated or sent; a stored one still opens for the customer who has the link.
function pestOutlineLive() {
  return featureGates.pestOutlineLive?.() === true;
}

// The stamp a packet keeps. The Pest Control outline reads no protocol line (its products come from the catalog, its
// words are fixed), so the stamp is the protocol's version when it carries one; today's `pest` protocol carries none.
function pestProtocolVersion() {
  return PROTOCOLS.pest?.version || null;
}

// A recurring pest plan (a one-time pest job gets no program overview): a pest line on an estimate with a monthly total,
// as the Estimates list decides (service-outline-programs.js).
function estimateHasPestService(estimate = {}, estimateData = {}) {
  const lines = inferEstimateServiceLines({ ...estimate, estimateData: estimate.estimate_data ?? estimateData });
  const monthlyTotal = parseFloat(estimate.monthly_total ?? estimate.monthlyTotal ?? 0) || 0;
  return lines.some((line) => line.key === 'pest' && line.amountBasis !== 'one_time') && monthlyTotal > 0;
}

// The plan's opt-outs, as the estimate page stores them: only an explicit false turns one off.
function planScope(estimateData = {}) {
  const prefs = estimateData?.preferences || {};
  return { interior: prefs.interior_spray !== false, sweep: prefs.exterior_sweep !== false };
}

const tile = (icon, title, text) => Object.freeze({ icon, title, text });
const tilesSection = (key, title, body, tiles) => makeSection(key, title, body, tiles.map((t) => `${t.title}: ${t.text}`), { type: 'tiles', items: tiles });

const PEST_COPY = Object.freeze({
  title: 'Your Waves Pest Control Program Overview',
  intro: (customerName) => `Based on your estimate for ${customerName}. One program covers every home we treat for pests. What each visit applies is decided on site, from what we find, the weather, and the product label.`,
  programLabel: 'One program for every home',
  programTitle: 'One Program For Every Home',
  programBody: 'Built for Southwest Florida homes: ants, palmetto bugs, spiders, wasps and the other household pests your plan covers. Your estimate sets how often we come, and every product is applied within its label.',
  outsideAndIn: tile('area', 'Outside and in', 'Your first visit treats the outside and the inside. After that, the inside is yours to ask for: tell us before a visit or tell the technician. Someone needs to be home, or leave us access.'),
  outsideOnly: tile('area', 'Outside only', 'Your plan is exterior-only: visits treat the outside of your home. Ask the office to add inside service.'),
  programTiles: Object.freeze([
    tile('barrier', 'Two kinds of product', 'A non-repellent that ants can’t detect, so foraging ants carry it back to the nest, and a residual barrier on soil, walls and covered eaves.'),
    tile('insects', 'Bait on trails, not spray', 'Active ant trails get bait, not a repellent spray, so the ants carry the bait home.'),
  ]),
  yearTitle: 'Your Year At A Glance',
  yearBody: 'Every visit follows the same routine, so each season shows what is active. This season is open; tap any season to see what to watch for and one thing to do at home.',
  // Research §5 by season, with one approved tip each, word for word (sourced wording: GATE_TECH_TIP_SOURCES is on).
  seasons: Object.freeze([
    { months: [1, 2, 3], label: 'Winter', visit: 'January to March: Ghost ants trail in kitchens and baths. Subterranean termite swarms start; UF/IFAS gives one native species’ flights as early January to April.', atHome: 'The small ants in a Florida kitchen go for sweets first. A sticky ring under the honey jar, the syrup bottle, or the sugar bowl is enough to keep a trail coming, so wipe the bottoms and keep those in a sealed bin or the fridge.' },
    { months: [4, 5, 6], label: 'Spring', visit: 'April to June: Ants are at their busiest, paper wasps and mud daubers build, and termites swarm; UF/IFAS says termite activity is most visible from March to June.', atHome: 'Paper wasps and mud daubers build inside the hollow ends of patio chairs, swing sets, and umbrella poles. Push a rubber plug or a wad of foil into each open end so the tube is not a ready-made nest.' },
    { months: [7, 8, 9], label: 'Summer', visit: 'July to September: The rainy season. Heavy rain moves ant trails and large roaches indoors, and millipedes wander in.', atHome: 'Where the A/C condensate line drips, the soil against the slab never dries, and ants and roaches follow that moisture to the foundation. UF/IFAS gives the same advice for termites: point condensate lines away from the house. A short extension into the bed lets that strip dry out.' },
    { months: [10, 11, 12], label: 'Fall', visit: 'October to December: Porch lights draw the insects spiders follow, and large roaches shelter in garages.', atHome: 'Go LED on the porch. In a 2016 field study, LED bulbs drew about four times fewer insects than incandescent bulbs and about half as many as compact fluorescents, and warm versus cool white made no difference. Fewer insects at the door means fewer spiders and geckos following them.' },
  ].map((season) => Object.freeze(season))),
  problemsTitle: 'Pests We Watch For',
  problemsBody: 'How to spot the common Southwest Florida household pests, and what we do.',
  problemTiles: Object.freeze([
    tile('insects', 'Ghost ants and other small ants', 'Tiny ants trailing along counters, sinks and baseboards. UF/IFAS notes ghost ants, one of Florida’s most common pest ants, nest in potted plants as well as wall voids. We find where a trail starts before treating it.'),
    tile('insects', 'Palmetto bugs', 'The big palmetto bugs live outdoors. UF/IFAS says American cockroaches wander inside looking for food and water or to get away from extreme weather, so you may see more around extreme weather. We treat where they get in and note the gaps.'),
    tile('insects', 'German roaches', 'German roaches don’t come in from outdoors. UF/IFAS says they’re spread entirely by people, riding in on grocery bags and the other things we carry inside. Small roaches in the kitchen or bath may be German roaches, which need a separate treatment; text us a photo.'),
    tile('spots', 'Spiders, wasps and mud daubers', 'Webs on eaves, lights and the lanai. Paper wasps build in still, sheltered spots. Mud daubers are solitary wasps that don’t defend their nests, and UF/IFAS says they sting only when handled roughly. If bees are flying in and out of a gap in the wall or soffit, don’t seal it or try to remove them. Text us.'),
    tile('inspection', 'Winged insects at a window', 'These can be termite swarmers. UF/IFAS says most people can see the waist on an ant. Termites are a separate service: text us a photo.'),
  ]),
  treatmentsTitle: 'Treatments That May Be Used',
  treatmentsBody: 'Which ones a visit uses depends on what we find, the weather, and the label.',
  sweepCard: Object.freeze({ key: 'spots', label: 'Web and nest sweep', text: 'Webs, egg sacs and small wasp and mud dauber nests on the house come down from the eaves, window frames, door frames and lanai before anything is sprayed. A large nest is quoted.' }),
  outsideCard: Object.freeze({ key: 'barrier', label: 'Outside band', text: 'A non-repellent along the foundation when it is due, then a residual band around the house and on the covered eaves, the garage and the lanai or pool cage.' }),
  insideCard: Object.freeze({ key: 'treat', label: 'Inside', text: 'On your first visit and whenever you ask: cracks and crevices in the kitchen and baths, at doors, windows and entry points, and wherever you have seen pests.' }),
  baitCard: Object.freeze({ key: 'insects', label: 'Bait', text: 'On active ant trails, once the ant and the trail’s source are known.' }),
  monitorCard: Object.freeze({ key: 'count', label: 'Monitors and notes', text: 'Glue boards may be placed in garage or utility areas. Moisture, gaps, and food or clutter that draw pests are noted on your report.' }),
  productsTitle: 'Products We May Use',
  productsBody: 'Each visit uses only what it needs. Your service report names every product applied, with its EPA number.',
  checkStep: tile('inspection', 'Check', 'The foundation, doors and windows, eaves, the lanai and the garage, plus anything you tell us you’ve seen'),
  decideStep: tile('decide', 'Decide', 'What to apply and where, set by the pest, the label, and the weather'),
  treatStep: Object.freeze({
    full: 'Webs and nests swept first, then the outside; the inside, when you want it, before or after, as you prefer',
    noSweep: 'The outside first; the inside, when you want it',
    noInside: 'Webs and nests swept first, then the outside',
    outsideOnly: 'The outside, where the label allows',
  }),
  reportStep: tile('report', 'Report', 'Products with EPA numbers, findings, photos when findings call for them, and next steps for you'),
  afterTreatmentTitle: 'After A Treatment',
  afterTreatmentBody: 'Your service report lists any instructions for that visit. These are the common ones.',
  afterTreatmentTiles: Object.freeze([
    tile('insects', 'Leave the bait alone', 'Ants on a bait placement are carrying it home. Leave them and the trail alone, and keep sprays and cleaners off the placements.'),
    tile('label', 'Skip store sprays', 'A study found that pyrethroid-based ant sprays, at a low application rate, raised the chance of a colony budding, splitting off new nests. If you see a trail between visits, text us.'),
  ]),
  yourPartTitle: 'Your Part: Around The House',
  yourPartBody: 'A few habits at home do as much as any treatment.',
  yourPartTiles: Object.freeze([
    tile('area', 'Plants off the wall', 'Branches touching the house are a bridge over the treated band along the foundation. UF/IFAS calls limbs that touch the house a highway for rodents, and ants and roaches use it too, so the treatment never touches them. Trim to a hand’s width of daylight between plant and wall.'),
    tile('dry_spots', 'Sprinklers off the wall', 'A sprinkler head that hits the house keeps the base of the wall wet and wears down the treated band along the foundation. Turn that head so it waters the bed and not the wall.'),
  ]),
  homeTile: tile('calendar', 'Being home, gates and pets', 'The outside doesn’t need anyone home. For the first visit, please have an adult home. For the inside on later visits, someone needs to be home, or leave us access; with nobody home, we treat the outside and note it. Leave gates unlocked and pets inside on service day, or we treat what we can reach and note the rest.'),
  homeTileOutsideOnly: tile('calendar', 'Being home, gates and pets', 'The outside doesn’t need anyone home, and your plan is exterior-only. For the first visit, please have an adult home. Leave gates unlocked and pets inside on service day, or we treat what we can reach and note the rest.'),
  expectTitle: 'What To Expect',
  expectBody: 'What you may see between visits, and what it means.',
  firstDaysTile: tile('insects', 'More insects at first', 'Right after a visit you may see more insects than usual, often slow or on their backs. That is the treatment bringing them out of the cracks they hide in.'),
  betweenVisits: 'If you still see activity between visits, text us a photo. A re-service between visits doesn’t move your next visit.',
  websLine: 'Webs are swept at your regular visits.',
  rainTile: tile('dry_spots', 'Rain', 'Labels bar outside sprays during rain. A treatment needs to dry and bond to surfaces; after that it holds up to weather.'),
  safetyTiles: Object.freeze([
    tile('epa', 'EPA numbers', 'Registered pesticides carry one, listed on your report.'),
    tile('insects', 'Bait and glue boards', 'Placed where insects travel, away from toys, food surfaces and pet dishes. Leave them where they are.'),
  ]),
  reportTile: tile('report', 'A service report', 'What was done, the products used with EPA numbers where they apply, photos when findings call for them, and any next steps'),
  notIncludedTags: Object.freeze(['German roach cleanouts', 'Fleas and ticks', 'Bed bugs', 'Rodents', 'Wildlife', 'Termites', 'Mosquitoes', 'Lawn insects', 'Large wasp nests']),
  notIncludedNote: 'Rodent trapping is quoted separately; other wildlife is referred. Some pest problems need a change at home instead, such as sealing a gap, fixing a leak or trimming plants off the wall.',
});

// The product list: catalog rows read by name at build time (decision D1-B, as on the lawn outline), never a typed-in
// name. The dinotefuran row is inside only (walkthrough 2026-10-03: "we never use alpine outside except for mud
// daubers"); the catalog renames it Atticus Antapex WSG (#6863), so either name is read. Left out: the granular bait
// (owner 2026-10-24 "we dont really use this on pest visits"), the surfactant, the German roach and rodent products.
const PEST_PRODUCTS = Object.freeze([
  { step: 'barrier', names: ['Taurus SC'] },
  { step: 'barrier', names: ['Atticus Talak 7.9 F'] },
  { step: 'treat', names: ['Atticus Antapex WSG', 'Alpine WSG'], inside: true },
  { step: 'insects', names: ['Advion Ant Bait Gel'] },
].map((product) => Object.freeze(product)));
const PRODUCT_STEP_LABELS = Object.freeze({ barrier: 'Outside band', treat: 'Inside', insects: 'Bait' });

// One query by exact name. A failed read leaves the section out rather than showing names without their ingredients.
async function loadPestProductList(db, scope) {
  const wanted = PEST_PRODUCTS.filter((product) => scope.interior || !product.inside);
  let rows;
  try {
    rows = await db('products_catalog')
      .whereIn('name', wanted.flatMap((product) => product.names))
      .select('name', 'display_name', 'active_ingredient', 'category', 'product_type');
  } catch {
    return [];
  }
  const byName = new Map((rows || []).map((row) => [row.name, row]));
  return wanted.map((product) => {
    const row = product.names.map((name) => byName.get(name)).find(Boolean);
    if (!row) return null;
    const ingredient = activeIngredientText(row);
    const name = row.display_name || row.name;
    return { step: product.step, text: ingredient ? `${name} (${ingredient})` : name };
  }).filter(Boolean);
}

function productsSection(productList) {
  const items = Object.entries(PRODUCT_STEP_LABELS)
    .map(([step, label]) => ({ key: step, label, text: productList.filter((product) => product.step === step).map((product) => product.text).join('; ') }))
    .filter((item) => item.text);
  if (!items.length) return null;
  return makeSection('products', PEST_COPY.productsTitle, PEST_COPY.productsBody, items.map((item) => `${item.label}: ${item.text}`), { type: 'categories', items });
}

// The year as four seasons in the month list's drawing: no step changes by season, so each row carries its season's
// watch-for line and one thing to do at home. The season of the build month arrives open.
function seasonsVisual(month) {
  const seasons = PEST_COPY.seasons.map((season) => ({
    month: season.months[0],
    label: season.label,
    name: season.label,
    main: [],
    asNeeded: [],
    limited: false,
    visit: season.visit,
    atHome: season.atHome,
    open: season.months.includes(Number(month)),
  }));
  return { type: 'months', months: seasons, labels: {}, limitLabel: null };
}

function treatStep(scope) {
  const { treatStep: words } = PEST_COPY;
  const text = scope.interior && scope.sweep ? words.full
    : scope.interior ? words.noSweep
      : scope.sweep ? words.noInside
        : words.outsideOnly;
  return tile('treat', 'Treat', text);
}

function pestSections({ month, scope, productList }) {
  const seasons = seasonsVisual(month);
  const treatments = [
    ...(scope.sweep ? [PEST_COPY.sweepCard] : []),
    PEST_COPY.outsideCard,
    ...(scope.interior ? [PEST_COPY.insideCard] : []),
    PEST_COPY.baitCard,
    PEST_COPY.monitorCard,
  ];
  const visitSteps = [PEST_COPY.checkStep, PEST_COPY.decideStep, treatStep(scope), PEST_COPY.reportStep];
  const betweenVisits = tile('report', 'Between visits', scope.sweep ? `${PEST_COPY.betweenVisits} ${PEST_COPY.websLine}` : PEST_COPY.betweenVisits);
  const afterVisitTiles = V13_COPY.afterVisitTiles.map((t) => (t.icon === 'report' ? PEST_COPY.reportTile : t));
  // The lawn outline's label tiles; its EPA tile names fertilizers and wetting agents, so the pest one says less.
  const safetyTiles = [...V13_COPY.safetyTiles.filter((t) => t.icon !== 'epa'), ...PEST_COPY.safetyTiles];
  return [
    tilesSection('pest_program', PEST_COPY.programTitle, PEST_COPY.programBody, [scope.interior ? PEST_COPY.outsideAndIn : PEST_COPY.outsideOnly, ...PEST_COPY.programTiles]),
    makeSection('program_year', PEST_COPY.yearTitle, PEST_COPY.yearBody, seasons.months.map((s) => `${s.name}: ${s.visit} At home: ${s.atHome}`), seasons),
    tilesSection('problems', PEST_COPY.problemsTitle, PEST_COPY.problemsBody, PEST_COPY.problemTiles),
    makeSection('treatment_categories', PEST_COPY.treatmentsTitle, PEST_COPY.treatmentsBody, treatments.map((item) => `${item.label}: ${item.text}`), { type: 'categories', items: treatments }),
    productsSection(productList),
    makeSection('typical_visit', 'What A Typical Visit Includes', '', visitSteps.map((step) => `${step.title}: ${step.text}`), { type: 'steps', items: visitSteps }),
    tilesSection('after_treatment', PEST_COPY.afterTreatmentTitle, PEST_COPY.afterTreatmentBody, PEST_COPY.afterTreatmentTiles),
    tilesSection('your_part', PEST_COPY.yourPartTitle, PEST_COPY.yourPartBody, [...PEST_COPY.yourPartTiles, scope.interior ? PEST_COPY.homeTile : PEST_COPY.homeTileOutsideOnly]),
    tilesSection('what_to_expect', PEST_COPY.expectTitle, PEST_COPY.expectBody, [PEST_COPY.firstDaysTile, betweenVisits, PEST_COPY.rainTile]),
    tilesSection('safety', V13_COPY.safetyTitle, '', safetyTiles),
    tilesSection('after_visit', V13_COPY.afterVisitTitle, '', afterVisitTiles),
    makeSection('not_included', V13_COPY.notIncludedTitle, '', PEST_COPY.notIncludedTags, { type: 'tags', items: PEST_COPY.notIncludedTags, note: PEST_COPY.notIncludedNote }),
  ].filter(Boolean);
}

async function buildPestOutline({ db, estimate, input = {}, now = new Date() }) {
  const estimateData = parseJsonMaybe(estimate.estimate_data || estimate.estimateData) || {};
  const month = Number(input.month || currentMonthNumber(now));
  const seasonBand = resolveSeasonBand(month);
  // Pest has no fertilizer rule, but the packet records its rule area as every outline does (validateContent).
  const jurisdictionId = input.jurisdictionId || resolveJurisdictionId(estimate.address);
  const jurisdictionRule = await loadFertilizerRule(db, jurisdictionId);
  const ruleJurisdictionId = jurisdictionRule?.jurisdiction_id || jurisdictionId;
  const scope = planScope(estimateData);
  const productList = await loadPestProductList(db, scope);
  const snapshot = estimateSnapshot(estimate, estimateData);
  const customerName = firstNonEmpty(snapshot.customerName, 'your property');
  const tier = firstNonEmpty(input.serviceTier, snapshot.tier, estimateData.serviceTier, 'pest control');

  const content = {
    serviceLine: SERVICE_LINE,
    title: PEST_COPY.title,
    intro: PEST_COPY.intro(customerName),
    generatedAt: now.toISOString(),
    detailLevel: input.detailLevel || 'standard',
    property: {
      customerName: snapshot.customerName,
      addressSummary: addressSummary(snapshot.address),
      turfType: null,
      programLabel: PEST_COPY.programLabel,
      serviceTier: tier,
    },
    season: { month, monthName: MONTHS[month - 1], seasonBand, restrictedSeasonActive: false },
    localRule: {
      jurisdictionId: ruleJurisdictionId,
      jurisdictionName: jurisdictionRule?.jurisdiction_name || null,
      version: jurisdictionRule?.version || null,
      summary: jurisdictionRule?.public_summary || null,
      restrictedSeasonActive: false,
    },
    sections: pestSections({ month, scope, productList }),
    treatmentCategories: [],
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
      planScope: scope,
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
      restrictedSeasonActive: false,
      productCardCount: 0,
      validationStatus: validation.status,
      serviceLineDetected: estimateHasPestService(estimate, estimateData),
    },
    content,
    contentHtml: renderOutlineHtml(content),
    validation,
    meta: {
      serviceLine: SERVICE_LINE,
      turf: { turfType: null, label: null, confidence: null, mixed: false },
      track: { name: PROTOCOLS.pest?.name || null },
      visit: null,
      jurisdictionRule,
      templateVersion: TEMPLATE_VERSION,
      contentLibraryVersion: PEST_CONTENT_LIBRARY_VERSION,
      productRegistryVersion: PRODUCT_REGISTRY_VERSION,
      protocolVersion: pestProtocolVersion(),
    },
  };
}

module.exports = {
  PEST_CONTENT_LIBRARY_VERSION,
  PEST_COPY,
  PEST_PRODUCTS,
  SERVICE_LINE,
  buildPestOutline,
  estimateHasPestService,
  pestOutlineLive,
  pestProtocolVersion,
  planScope,
};
