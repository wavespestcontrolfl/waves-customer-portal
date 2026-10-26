// Mosquito program overview, behind GATE_MOSQUITO_OUTLINE (owner 2026-10-26: "also we need to go through other related
// outlines, etc and make sure they are more aligned like lawn outline"; decision D4-A, "do whatever you recommend": Tree
// & Shrub, then Pest, then Mosquito). The lawn outline's customer page for the recurring mosquito program, in the same
// packet shape, so the composer, the send route and the public page take it as they take a lawn packet.
//
// Each fact is an owner ruling, the mosquito protocol, the Service Details guide, a fact-register source or an approved
// service-report tip; the words are the reviewed draft 2 (mosquito-draft, after the Fable review). The ten library tips
// are read by id at build time (the builder owns their words; GATE_TECH_TIP_SOURCES picks the sourced or the plain
// wording, and a sourced-only tip drops with its tile when the gate is off). No rate, price, visit count, cadence or
// terms; product names only in the product list, read from the catalog. Bti dunks and mosquito stations are estimate
// add-ons: their products and their "not included" tags follow the estimate's own counts. The page never says mist or
// misting (GATE_MOSQUITO_MISTING is off).
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
  loadActiveCatalogRows,
  loadFertilizerRule,
  makeSection,
  parseJsonMaybe,
  renderOutlineHtml,
  resolveJurisdictionId,
  resolveSeasonBand,
  validateContent,
} = require('./lawn-service-outline');
const { storedEstimateContainer } = require('./estimate-result-container');
const { resolveTipIds } = require('./service-report/tip-library');
const featureGates = require('../config/feature-gates');
const PROTOCOLS = require('../config/protocols.json');

const SERVICE_LINE = 'mosquito';
const MOSQUITO_CONTENT_LIBRARY_VERSION = 'mosquito-v1-copy-1';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// GATE_MOSQUITO_OUTLINE: staff can build and send a Mosquito outline from an estimate. Off = no Mosquito outline can be
// built, regenerated or sent; a stored one still opens for the customer who has the link.
function mosquitoOutlineLive() {
  return featureGates.mosquitoOutlineLive?.() === true;
}

// The stamp a packet keeps: the protocol's version when it carries one; today's `mosquito` protocol carries none.
function mosquitoProtocolVersion() {
  return PROTOCOLS.mosquito?.version || null;
}

// The recurring mosquito program row of a stored estimate: an exact `service === 'mosquito'` row in the authoritative
// container's recurring services (estimate-result-container.js, as the misting rows are read). The misting plan row
// ('mosquito_misting'), a one-time mosquito item ('one_time_mosquito') and a commercial row ('commercial_mosquito') are
// other keys and never match. The estimate's service-line text cannot tell these apart (estimate-service-lines.js), so
// both the Estimates list and the builder use this rule.
function mosquitoProgramRow(estimateData) {
  const container = storedEstimateContainer(estimateData);
  if (!container) return null;
  const recurring = [container.recurring?.services, container.results?.recurring?.services];
  return recurring.filter(Array.isArray).flat().find((row) => row && typeof row === 'object' && row.service === 'mosquito') || null;
}

// The add-on counts the pricer stored on the row (service-pricing.js addOns.stationCount / dunkCount).
function addOnCounts(row) {
  const count = (value) => (Number(value) > 0 ? Number(value) : 0);
  return { dunks: count(row?.addOns?.dunkCount), stations: count(row?.addOns?.stationCount) };
}

// A builder with no program row has nothing to describe. The outline routes pass an error to the app's error handler,
// which answers an operational error with its status code (middleware/errors.js).
function noProgramRowError() {
  const error = new Error('This estimate has no recurring mosquito program, so there is no mosquito outline to build.');
  error.isOperational = true;
  error.statusCode = 422;
  error.code = 'mosquito_program_row_missing';
  return error;
}

const tile = (icon, title, text) => Object.freeze({ icon, title, text });
const tilesSection = (key, title, body, tiles) => makeSection(key, title, body, tiles.map((t) => `${t.title}: ${t.text}`), { type: 'tiles', items: tiles });

// A tile or season line whose words are a library tip's: the page stores the id, the builder reads the words.
const tipTile = (icon, title, tipId) => Object.freeze({ icon, title, tipId });

const MOSQUITO_COPY = Object.freeze({
  title: 'Your Waves Mosquito Program Overview',
  intro: (customerName) => `Based on your estimate for ${customerName}. One routine covers every yard we treat for mosquitoes. What each visit treats is decided on site, from what we find, the weather, and the product label.`,
  programLabel: 'One routine for every yard',
  programTitle: 'One Routine For Every Yard',
  programBody: 'Built for Southwest Florida yards, where shade, sprinklers and nearby water all add to mosquito pressure. Your estimate sets when we come, and every product is applied within its label.',
  programTiles: Object.freeze([
    tile('insects', 'Treat where they rest', 'By day, many adult mosquitoes rest in shaded leaves: hedges, fence lines, under decks, and the lanai and pool-cage edges. The spray goes there, not across the open lawn.'),
    tile('dry_spots', 'Find where they breed', 'Each visit we check gutters, drains, planters, bromeliads, saucers, tarps and toys, and tip out standing water where we can.'),
    tile('spots', 'Treat water that has to stay', 'Where breeding water can’t be removed, a growth regulator goes on only where the label and the site allow. Bti dunks and a mosquito station are added when your estimate includes them.'),
  ]),
  yearTitle: 'Your Year At A Glance',
  yearBody: 'Every visit follows the same routine; what changes through the year is how many mosquitoes are out. This season is open; tap any season to see what to expect and one thing to do at home.',
  // Draft section 2: one visit line a season and one library tip to do at home (read by id at build time).
  seasons: Object.freeze([
    { months: [1, 2, 3], label: 'Winter', visit: 'January to March: The dry months have the fewest mosquitoes. Shaded, irrigated and waterfront yards can still have them.', atHomeTip: 'water_bird_bath' },
    { months: [4, 5, 6], label: 'Spring', visit: 'April to June: Numbers climb as it warms, and peak season typically starts in May. The summer rains usually arrive in June.', atHomeTip: 'mq_tree_holes' },
    { months: [7, 8, 9], label: 'Summer', visit: 'July to September: Peak season and the rainy season together. Afternoon storms keep standing water around.', atHomeTip: 'water_weekly_dump' },
    { months: [10, 11, 12], label: 'Fall', visit: 'October to December: Peak season typically runs through October. Numbers drop once the rainy season ends.', atHomeTip: 'mq_pool' },
  ].map((season) => Object.freeze(season))),
  problemsTitle: 'What We Watch For',
  problemsBody: 'Where Southwest Florida mosquitoes come from, and what we do.',
  // The container tile's "7 to 10 days" is held to the fact register's CDC quote by a test (draft section 5).
  problemTiles: Object.freeze([
    tile('dry_spots', 'Water in containers', 'Container mosquitoes lay eggs on the inside walls of anything holding water, just above the waterline. The CDC says an egg takes 7 to 10 days to become an adult. We tip out what we can and note the rest.'),
    tile('area', 'Water next door', 'Neighboring yards, HOA ponds, storm drains, canals and wetlands are outside what a home program can treat. We note them on your report so you know where mosquitoes come from.'),
    tipTile('insects', 'Daytime biters', 'mq_daytime_biters'),
    tile('insects', 'Not every biter is a mosquito', 'No-see-ums and biting midges are different insects with different habits and labels. They are covered only when your estimate names them. If bites near the water are your real problem, tell us.'),
  ]),
  treatmentsTitle: 'Treatments That May Be Used',
  treatmentsBody: 'Which ones a visit uses depends on what we find, the weather, and the label.',
  treatments: Object.freeze([
    Object.freeze({ key: 'inspection', label: 'Inspection', text: 'A walk of the yard each visit: shady resting spots, and anything holding water.' }),
    Object.freeze({ key: 'dry_spots', label: 'Source reduction', text: 'Standing water tipped out where we can. Sources we can\'t reach, or that need a fix such as a clogged gutter or poor drainage, go on your report.' }),
    Object.freeze({ key: 'insects', label: 'Barrier spray', text: 'A fine spray from a backpack sprayer into and beneath the shaded leaves where adults rest. Kept off blooms with pollinators on them, edible plants, and open water.' }),
    Object.freeze({ key: 'spots', label: 'Larval control', text: 'A growth regulator where the label and the site allow, plus Bti dunks and a mosquito station when your estimate includes them. The growth regulator: eggs don’t hatch and young insects can’t grow into breeding adults.' }),
  ]),
  productsTitle: 'Products We May Use',
  productsBody: 'Each visit uses only what the yard needs. Your service report names every product applied, with its EPA number.',
  visitSteps: Object.freeze([
    tile('inspection', 'Check', 'Shady resting spots, and anything holding water: gutters, drains, planters, bromeliads, saucers, tarps and toys'),
    tile('decide', 'Decide', 'Where to spray and which water to treat, set by the label, the wind and rain, and blooms with pollinators on them'),
    tile('treat', 'Treat', 'Standing water tipped out, shaded leaves sprayed, and water that has to stay treated where the label allows'),
    tile('report', 'Report', 'Where we treated, the water we found, products with EPA numbers, and next steps for you'),
  ]),
  afterTreatmentTitle: 'After A Treatment',
  afterTreatmentBody: 'Your service report lists any instructions for that visit. These are the common ones.',
  afterTreatmentTiles: Object.freeze([
    tile('treat', 'Don\'t rinse the shrubs', 'Let the spray dry on the leaves before anyone hoses them down.'),
    tile('dry_spots', 'Rain', 'The labels on our sprays say not to apply during rain, so the technician checks the forecast first. A spray needs to dry on the leaves; after that it holds up to weather.'),
  ]),
  yourPartTitle: 'Your Part: Water And Shade',
  yourPartBody: 'A few habits at home do as much as any treatment.',
  // The bromeliad tile's "bottle cap" is held to the fact register's quote by a test (draft section 5).
  bromeliadTile: tile('dry_spots', 'Flush bromeliads weekly', 'Bromeliad cups hold water, and UF/IFAS Extension in Sarasota County notes it takes only a bottle cap\'s worth to breed mosquitoes. Flush the cups with the hose once a week before the larvae can mature.'),
  yourPartTips: Object.freeze([
    tipTile('dry_spots', 'Check the ribbed downspout pipe', 'mq_downspout_pipe'),
    tipTile('area', 'Thin the thick hedges', 'mq_thin_hedges'),
    tipTile('rotate', 'Run a fan where you sit', 'mq_lanai_fan'),
  ]),
  serviceDayTile: tile('calendar', 'On service day', 'Unlock gates on service day, keep people and pets clear during application, and tell us about beehives, butterfly gardens, edible plants, koi ponds, or anywhere you do not want treated.'),
  expectTitle: 'What To Expect',
  expectBody: 'Mosquito pressure moves with the weather.',
  expectTiles: Object.freeze([
    tile('insects', 'Fewer mosquitoes, not zero', 'The program lowers the number of mosquitoes in your yard. It is not a wall, and some still fly in from nearby; an occasional mosquito is normal. If you still see activity between visits, text us.'),
    tile('calendar', 'Rain brings new hatches', 'Every heavy rain refills containers and low spots, and new mosquitoes hatch from them. Tipping out water after a storm is the habit that helps most.'),
    tile('decide', 'Weather can change a visit', 'Wind and rain must allow the spray. When they don\'t, we hold or limit the treatment and note it on your report.'),
    tile('area', 'If we also care for your shrubs', 'On yards with our Tree & Shrub service too, the mosquito spray stays on low, shaded leaves and skips plants in bloom and the scale-prone ones: sago, ficus, camellia, holly and magnolia.'),
  ]),
  questionsTitle: 'Common Questions',
  questionsBody: 'The questions we hear most, answered straight.',
  questionTiles: Object.freeze([
    tile('decide', 'Isn\'t my pest control enough for mosquitoes?', 'No. Pest control treats the house; mosquitoes rest in leaves and breed in water, which a house treatment does not reach.'),
    tipTile('area', 'Where do my mosquitoes come from?', 'mq_few_blocks'),
    tipTile('insects', 'Will a bug zapper help?', 'mq_skip_zapper'),
  ]),
  // The lawn outline's label tiles; its EPA tile names fertilizers and wetting agents, so the mosquito one says less.
  safetyTiles: Object.freeze([
    tile('epa', 'EPA numbers', 'Registered pesticides carry one, listed on your report.'),
    tile('insects', 'Bees and blooms', 'Blooming plants with bees or other pollinators on them are not sprayed.'),
    tile('area', 'Edible plants and water', 'Edible plants, fish ponds and other open water are not sprayed. Tell us about them, and about beehives nearby, before service.'),
  ]),
  reportTile: tile('report', 'A service report', 'Where we treated, the water sources we found, the products used with EPA numbers, photos when findings call for them, and any next steps'),
  // The two add-on tags leave the list when the estimate holds that add-on.
  notIncludedTags: Object.freeze(['No-see-ums and biting midges', 'Gnats', 'Fleas and ticks', 'Bti dunks', 'Mosquito stations', 'Hedge trimming', 'Gutter, drain and screen repairs']),
  dunkTag: 'Bti dunks',
  stationTag: 'Mosquito stations',
  notIncludedNote: 'Some mosquito problems need a fix at home instead, such as clearing a gutter, patching a screen, thinning a hedge, or fixing a drainage problem.',
});

// The product list: catalog rows read by name at build time (decision D1-B, as on the lawn and pest outlines), never a
// typed-in name. Talak is "Atticus Talak 7.9 F" in production and "Atticus Talak" in a repo-built catalog: the first
// name found prints. The dunk and station rows print only when the estimate's program row holds that add-on. Left off:
// Tekko Trio (indoor-only, owner 2026-10-01), Bifen I/T and Talstar P (inactive; they are Talak), Cyzmic CS, Altosid.
const MOSQUITO_PRODUCTS = Object.freeze([
  { step: 'insects', names: ['Atticus Talak 7.9 F', 'Atticus Talak'] },
  { step: 'insects', names: ['Scion Insecticide'] },
  { step: 'spots', names: ['Tekko Pro IGR'] },
  { step: 'spots', names: ['Summit Mosquito Dunk Tablets'], addOn: 'dunks' },
  { step: 'spots', names: ['In2Care Mosquito Station'], addOn: 'stations' },
].map((product) => Object.freeze(product)));
const PRODUCT_STEP_LABELS = Object.freeze({ insects: 'Barrier spray', spots: 'Larval control' });

// One query by exact name, active rows only (the shared read in lawn-service-outline.js). A failed read leaves the
// section out rather than showing names without their ingredients.
async function loadMosquitoProductList(db, addOns) {
  const wanted = MOSQUITO_PRODUCTS.filter((product) => !product.addOn || addOns[product.addOn] > 0);
  const rows = await loadActiveCatalogRows(db, wanted.flatMap((product) => product.names));
  const byName = new Map(rows.map((row) => [row.name, row]));
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
  return makeSection('products', MOSQUITO_COPY.productsTitle, MOSQUITO_COPY.productsBody, items.map((item) => `${item.label}: ${item.text}`), { type: 'categories', items });
}

// A library tip's words for this build: one call per id (a call caps at three tips), the sourced wording when
// GATE_TECH_TIP_SOURCES is on. A sourced-only tip returns nothing with the gate off, and its tile or row drops.
function tipText(tipId, now) {
  const tip = resolveTipIds([tipId], { sourced: featureGates.techTipSourcesLive?.() === true, date: now })[0];
  return tip?.copy || null;
}

// A tile whose words come from a tip, or null when the tip has none.
function resolveTile(item, now) {
  if (!item.tipId) return item;
  const text = tipText(item.tipId, now);
  return text ? tile(item.icon, item.title, text) : null;
}

// The year as four seasons in the month list's drawing (the pest outline's shape): no step changes by season, so each
// row carries its season's line and one tip to do at home. The season of the build month arrives open.
function seasonsVisual(month, now) {
  const seasons = MOSQUITO_COPY.seasons.map((season) => ({
    month: season.months[0],
    label: season.label,
    name: season.label,
    main: [],
    asNeeded: [],
    limited: false,
    visit: season.visit,
    atHome: tipText(season.atHomeTip, now) || '',
    open: season.months.includes(Number(month)),
  }));
  return { type: 'months', months: seasons, labels: {}, limitLabel: null };
}

function mosquitoSections({ month, addOns, productList, now }) {
  const seasons = seasonsVisual(month, now);
  const tiles = (items) => items.map((item) => resolveTile(item, now)).filter(Boolean);
  const afterVisitTiles = V13_COPY.afterVisitTiles.map((t) => (t.icon === 'report' ? MOSQUITO_COPY.reportTile : t));
  const safetyTiles = [...V13_COPY.safetyTiles.filter((t) => t.icon !== 'epa'), ...MOSQUITO_COPY.safetyTiles];
  const notIncludedTags = MOSQUITO_COPY.notIncludedTags.filter((tag) => !(
    (tag === MOSQUITO_COPY.dunkTag && addOns.dunks > 0) || (tag === MOSQUITO_COPY.stationTag && addOns.stations > 0)
  ));
  return [
    tilesSection('mosquito_program', MOSQUITO_COPY.programTitle, MOSQUITO_COPY.programBody, MOSQUITO_COPY.programTiles),
    makeSection('program_year', MOSQUITO_COPY.yearTitle, MOSQUITO_COPY.yearBody, seasons.months.map((s) => (s.atHome ? `${s.name}: ${s.visit} At home: ${s.atHome}` : `${s.name}: ${s.visit}`)), seasons),
    tilesSection('problems', MOSQUITO_COPY.problemsTitle, MOSQUITO_COPY.problemsBody, tiles(MOSQUITO_COPY.problemTiles)),
    makeSection('treatment_categories', MOSQUITO_COPY.treatmentsTitle, MOSQUITO_COPY.treatmentsBody, MOSQUITO_COPY.treatments.map((item) => `${item.label}: ${item.text}`), { type: 'categories', items: MOSQUITO_COPY.treatments }),
    productsSection(productList),
    makeSection('typical_visit', 'What A Typical Visit Includes', '', MOSQUITO_COPY.visitSteps.map((step) => `${step.title}: ${step.text}`), { type: 'steps', items: MOSQUITO_COPY.visitSteps }),
    tilesSection('after_treatment', MOSQUITO_COPY.afterTreatmentTitle, MOSQUITO_COPY.afterTreatmentBody, MOSQUITO_COPY.afterTreatmentTiles),
    tilesSection('your_part', MOSQUITO_COPY.yourPartTitle, MOSQUITO_COPY.yourPartBody, [MOSQUITO_COPY.bromeliadTile, ...tiles(MOSQUITO_COPY.yourPartTips), MOSQUITO_COPY.serviceDayTile]),
    tilesSection('what_to_expect', MOSQUITO_COPY.expectTitle, MOSQUITO_COPY.expectBody, MOSQUITO_COPY.expectTiles),
    tilesSection('common_questions', MOSQUITO_COPY.questionsTitle, MOSQUITO_COPY.questionsBody, tiles(MOSQUITO_COPY.questionTiles)),
    tilesSection('safety', V13_COPY.safetyTitle, '', safetyTiles),
    tilesSection('after_visit', V13_COPY.afterVisitTitle, '', afterVisitTiles),
    makeSection('not_included', V13_COPY.notIncludedTitle, '', notIncludedTags, { type: 'tags', items: notIncludedTags, note: MOSQUITO_COPY.notIncludedNote }),
  ].filter(Boolean);
}

async function buildMosquitoOutline({ db, estimate, input = {}, now = new Date() }) {
  const estimateData = parseJsonMaybe(estimate.estimate_data || estimate.estimateData) || {};
  // The builder holds the program rule: the outline route picks the program by service line and does not re-run the
  // Estimates list's offer check.
  const programRow = mosquitoProgramRow(estimateData);
  if (!programRow) throw noProgramRowError();
  const addOns = addOnCounts(programRow);
  const month = Number(input.month || currentMonthNumber(now));
  const seasonBand = resolveSeasonBand(month);
  // Mosquito has no fertilizer rule, but the packet records its rule area as every outline does (validateContent).
  const jurisdictionId = input.jurisdictionId || resolveJurisdictionId(estimate.address);
  const jurisdictionRule = await loadFertilizerRule(db, jurisdictionId);
  const ruleJurisdictionId = jurisdictionRule?.jurisdiction_id || jurisdictionId;
  const productList = await loadMosquitoProductList(db, addOns);
  const snapshot = estimateSnapshot(estimate, estimateData);
  const customerName = firstNonEmpty(snapshot.customerName, 'your property');
  const tier = firstNonEmpty(input.serviceTier, snapshot.tier, estimateData.serviceTier, 'mosquito program');

  const content = {
    serviceLine: SERVICE_LINE,
    title: MOSQUITO_COPY.title,
    intro: MOSQUITO_COPY.intro(customerName),
    generatedAt: now.toISOString(),
    detailLevel: input.detailLevel || 'standard',
    property: {
      customerName: snapshot.customerName,
      addressSummary: addressSummary(snapshot.address),
      turfType: null,
      programLabel: MOSQUITO_COPY.programLabel,
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
    sections: mosquitoSections({ month, addOns, productList, now }),
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
      addOns,
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
      serviceLineDetected: true,
    },
    content,
    contentHtml: renderOutlineHtml(content),
    validation,
    meta: {
      serviceLine: SERVICE_LINE,
      turf: { turfType: null, label: null, confidence: null, mixed: false },
      track: { name: PROTOCOLS.mosquito?.name || null },
      visit: null,
      jurisdictionRule,
      templateVersion: TEMPLATE_VERSION,
      contentLibraryVersion: MOSQUITO_CONTENT_LIBRARY_VERSION,
      productRegistryVersion: PRODUCT_REGISTRY_VERSION,
      protocolVersion: mosquitoProtocolVersion(),
    },
  };
}

module.exports = {
  MOSQUITO_CONTENT_LIBRARY_VERSION,
  MOSQUITO_COPY,
  MOSQUITO_PRODUCTS,
  SERVICE_LINE,
  buildMosquitoOutline,
  mosquitoOutlineLive,
  mosquitoProgramRow,
  mosquitoProtocolVersion,
};
