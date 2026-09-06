const db = require('../models/db');
const { WAVES_LOCATIONS, CITY_TO_LOCATION, resolveLocation } = require('../config/locations');
const SocialMediaService = require('./social-media');
const {
  SOCIAL_FLAGS,
  isPausedByAdmin,
  validateContent,
  normalizeUrl,
} = require('./social-media');
const SocialCardRenderer = require('./social-card-renderer');
const { blogPostShareability } = require('./content/blog-share-gate');
const CreativeEngine = require('./social-creative-engine');
const { runExclusive } = require('../utils/cron-lock');
const logger = require('./logger');
const { deliverOpsDigest } = require('./ops-digest');
const { etParts } = require('../utils/datetime-et');

const FASTEST_RISER_PROFILES = [
  {
    companyName: 'Brooks Pest Solutions',
    pctRank: 64,
    revenueRank: 64,
    growthPct: 955,
    city: 'Orem',
    state: 'UT',
    strategicNotes: [
      'Fastest riser on the 2026 PCT Top 100 poster.',
      'Residential-heavy model with simple pest-service positioning.',
      'Use as a benchmark for short-form proof, neighborhood relevance, and aggressive review capture.',
    ],
  },
  {
    companyName: 'Proforce Pest Control',
    pctRank: 56,
    revenueRank: 56,
    growthPct: 500,
    city: 'Boca Raton',
    state: 'FL',
    profileUrls: { website: 'https://proforcepest.com/' },
    strategicNotes: [
      'Florida peer with the largest non-acquisition growth signal in the poster.',
      'Owned-site positioning emphasizes proof count, service accountability, local service pros, and seasonal pressure.',
      'Good pattern for Waves: local problem, proof, accountable next step.',
    ],
  },
  {
    companyName: 'Certus',
    pctRank: 15,
    revenueRank: 15,
    growthPct: 85,
    city: 'Tampa',
    state: 'FL',
    strategicNotes: [
      'High-growth Florida-based consolidator.',
      'Useful for studying multi-location brand consistency and branch-local adaptation.',
    ],
  },
  {
    companyName: 'Banner Pest Services',
    pctRank: 90,
    revenueRank: 90,
    growthPct: 63,
    city: 'San Jose',
    state: 'CA',
    strategicNotes: [
      'Fast riser with likely local-market lead-generation discipline.',
      'Track visible engagement on educational posts versus offer posts.',
    ],
  },
  {
    companyName: 'Best Home & Property Services',
    pctRank: 100,
    revenueRank: 100,
    growthPct: 60,
    city: 'Longs',
    state: 'SC',
    strategicNotes: [
      'New Top 100 entrant with broad home/property service mix.',
      'Watch cross-sell content where pest control is packaged with other home services.',
    ],
  },
  {
    companyName: 'Pest Control Consultants',
    pctRank: 89,
    revenueRank: 89,
    growthPct: 55,
    city: 'Dixon',
    state: 'IL',
    strategicNotes: [
      'New Top 100 entrant with strong growth.',
      'Useful benchmark for simple local authority posts and testimonial cadence.',
    ],
  },
  {
    companyName: 'Prodigy Pest Solutions',
    pctRank: 98,
    revenueRank: 98,
    growthPct: 52,
    city: 'Sarasota',
    state: 'FL',
    strategicNotes: [
      'Direct local competitor in Sarasota and one of the fastest risers.',
      'High-priority manual profile/post capture target for Waves.',
    ],
  },
  {
    companyName: 'Go-Forth Home Services',
    pctRank: 33,
    revenueRank: 33,
    growthPct: 40,
    city: 'High Point',
    state: 'NC',
    strategicNotes: [
      'Home services branding, not only pest control.',
      'Useful for studying community, commercial, and service-bundle posts.',
    ],
  },
  {
    companyName: 'Senske Family of Companies',
    pctRank: 10,
    revenueRank: 10,
    growthPct: 40,
    city: 'Dallas',
    state: 'TX',
    strategicNotes: [
      'Large multi-service brand with high growth.',
      'Good pattern source for lawn, pest, tree, and seasonal cross-sell content.',
    ],
  },
  {
    companyName: 'Mosquito Authority & Pest Authority',
    pctRank: 21,
    revenueRank: 21,
    growthPct: 30,
    city: 'Charlotte',
    state: 'NC',
    strategicNotes: [
      'New entrant with mosquito-first seasonal urgency.',
      'Good source for rain, standing water, outdoor-living, and recurring barrier messaging.',
    ],
  },
  {
    companyName: 'All U Need Pest Control',
    pctRank: 41,
    revenueRank: 41,
    growthPct: 33,
    city: 'Fort Myers',
    state: 'FL',
    profileUrls: { website: 'https://www.alluneedpest.com/' },
    strategicNotes: [
      'Southwest Florida peer with meaningful growth.',
      'Track review proof, local office/service-area content, and offer cadence.',
    ],
  },
  {
    companyName: 'Native Pest Management',
    pctRank: 63,
    revenueRank: 63,
    growthPct: 30,
    city: 'Tallahassee',
    state: 'FL',
    profileUrls: { website: 'https://www.nativepestmanagement.com/' },
    strategicNotes: [
      'Florida peer with strong review and trust positioning.',
      'Useful for family/pet-safe framing, inspection CTAs, and Florida-specific education.',
    ],
  },
];

const DEFAULT_COMPETITOR_PATTERNS = [
  {
    key: 'local_trigger_fact_cta',
    label: 'Local trigger + fact + soft CTA',
    copyablePattern: 'Name the city and trigger, give one specific pest fact, end with a low-pressure inspection or guide CTA.',
  },
  {
    key: 'proof_number',
    label: 'Proof number',
    copyablePattern: 'Lead with a concrete trust signal, then tie it to what the homeowner gets from the service.',
  },
  {
    key: 'review_card',
    label: 'Review card',
    copyablePattern: 'Turn a real 5-star review into a clean first-name/city graphic, then add a short caption about the service outcome.',
  },
  {
    key: 'technician_authority',
    label: 'Technician authority',
    copyablePattern: 'Show what a tech notices in seconds, then explain what it means for the homeowner.',
  },
  {
    key: 'seasonal_urgency',
    label: 'Seasonal urgency',
    copyablePattern: 'Tie pest pressure to rain, humidity, swarms, or turf stress without fearmongering.',
  },
  {
    key: 'service_carousel',
    label: 'Service carousel',
    copyablePattern: 'Use one slide/card per pest or symptom, each with a one-line diagnostic clue.',
  },
];

const CHANNELS = ['facebook', 'instagram', 'linkedin', 'gbp'];
const AUTONOMOUS_SOURCE = 'autonomous_studio';

// Origin for the versus lane's fire counter (see selectAutonomousVersusPlan).
// Any fixed January works — it only sets the rotation's phase, so changing it
// reshuffles which card lands on which date and must not be done casually.
const VERSUS_SEQ_EPOCH_YEAR = 2020;

// Six topics per month (owner ask 2026-09-06: "low on content") so the
// campaign lane's `day % topics.length` pick stops repeating within a month.
// Value-first, seasonal, grounded in SWFL — pest AND lawn AND the
// tree/shrub, mosquito, and rodent lines each month they matter.
const SEASONAL_AUTONOMOUS_TOPICS = {
  1: [
    { topic: 'winter pest pressure indoors', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'winter weeds in St. Augustine lawns', service: 'lawn care', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'rodents nesting in attics on cool nights', service: 'rodent', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'dry-season irrigation and brown spots', service: 'lawn care', angle: 'myth/fact', cta: 'read guide' },
    { topic: 'ghost ants in the kitchen during dry weather', service: 'general pest', angle: 'new Florida homeowner', cta: 'book inspection' },
    { topic: 'cold snaps and palm fronds browning', service: 'tree & shrub', angle: 'what we are seeing', cta: 'read guide' },
  ],
  2: [
    { topic: 'early termite swarm season', service: 'termite', angle: 'new Florida homeowner', cta: 'book inspection' },
    { topic: 'spring lawn green-up problems', service: 'lawn care', angle: 'signs to check', cta: 'request estimate' },
    { topic: 'large patch fungus in cool, wet turf', service: 'lawn care', angle: 'what we are seeing', cta: 'read guide' },
    { topic: 'discarded termite wings on windowsills', service: 'termite', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'spring cleanup: ants and roaches in mulch against the house', service: 'general pest', angle: 'myth/fact', cta: 'book inspection' },
    { topic: 'hibiscus and ixora pests waking up', service: 'tree & shrub', angle: 'signs to check', cta: 'request estimate' },
  ],
  3: [
    { topic: 'peak termite swarm month', service: 'termite', angle: 'do not ignore this', cta: 'book inspection' },
    { topic: 'chinch bug pressure starting early', service: 'lawn care', angle: 'myth/fact', cta: 'read guide' },
    { topic: 'spring weeds before the rains', service: 'lawn care', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'paper wasps building under eaves', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'mosquito activity climbing as March warms up', service: 'mosquito', angle: 'new Florida homeowner', cta: 'request estimate' },
    { topic: 'whitefly on gumbo limbo and ficus', service: 'tree & shrub', angle: 'signs to check', cta: 'request estimate' },
  ],
  4: [
    { topic: 'mosquito season starting after rain', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'Formosan termite swarmers', service: 'termite', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'ants trailing indoors as temperatures climb', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'sod webworm moths at dusk', service: 'lawn care', angle: 'what we are seeing', cta: 'read guide' },
    { topic: 'standing water in bromeliads and saucers', service: 'mosquito', angle: 'myth/fact', cta: 'read guide' },
    { topic: 'roof rats and ripening fruit trees', service: 'rodent', angle: 'signs to check', cta: 'book inspection' },
  ],
  5: [
    { topic: 'rainy season mosquito pressure', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'ants moving around lanais', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'chinch bugs along hot sunny edges', service: 'lawn care', angle: 'signs to check', cta: 'read guide' },
    { topic: 'drywood termite pellets in the garage', service: 'termite', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'millipedes crowding the lanai after rain', service: 'general pest', angle: 'myth/fact', cta: 'read guide' },
    { topic: 'sooty mold on shrubs after aphids', service: 'tree & shrub', angle: 'what we are seeing', cta: 'request estimate' },
  ],
  6: [
    { topic: 'mosquito surge after afternoon storms', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'summer roaches moving indoors', service: 'general pest', angle: 'new Florida homeowner', cta: 'book inspection' },
    { topic: 'lawn fungus after rain', service: 'lawn care', angle: 'signs to check', cta: 'read guide' },
    { topic: 'no-see-ums at the coast at dusk', service: 'general pest', angle: 'myth/fact', cta: 'request estimate' },
    { topic: 'earwigs and springtails after downpours', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'gutters, downspouts, and mosquito breeding', service: 'mosquito', angle: 'signs to check', cta: 'request estimate' },
  ],
  7: [
    { topic: 'peak summer pest pressure', service: 'general pest', angle: 'what we are seeing', cta: 'book inspection' },
    { topic: 'chinch bug damage that looks like drought', service: 'lawn care', angle: 'myth/fact', cta: 'read guide' },
    { topic: 'mosquito pressure at maximum', service: 'mosquito', angle: 'do not ignore this', cta: 'request estimate' },
    { topic: 'flying termites in July: drywood swarms', service: 'termite', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'nutsedge taking over soggy spots', service: 'lawn care', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'huntsman spiders on warm walls at night', service: 'general pest', angle: 'myth/fact', cta: 'read guide' },
  ],
  8: [
    { topic: 'late-summer mosquito pressure', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'ants and roaches after heavy rain', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'fall armyworms moving across lawns', service: 'lawn care', angle: 'do not ignore this', cta: 'read guide' },
    { topic: 'mud daubers on the lanai ceiling', service: 'general pest', angle: 'myth/fact', cta: 'read guide' },
    { topic: 'mole crickets tunneling in wet turf', service: 'lawn care', angle: 'signs to check', cta: 'request estimate' },
    { topic: 'mealybugs on hibiscus in the heat', service: 'tree & shrub', angle: 'signs to check', cta: 'request estimate' },
  ],
  9: [
    { topic: 'last stretch of peak mosquito season', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'fall lawn recovery after summer stress', service: 'lawn care', angle: 'signs to check', cta: 'request estimate' },
    { topic: 'sod webworm damage in September', service: 'lawn care', angle: 'what we are seeing', cta: 'read guide' },
    { topic: 'yellowjackets at fall cookouts', service: 'general pest', angle: 'myth/fact', cta: 'read guide' },
    { topic: 'roof rats scouting the roofline early', service: 'rodent', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'storm cleanup and standing water', service: 'mosquito', angle: 'signs to check', cta: 'request estimate' },
  ],
  10: [
    { topic: 'fall lawn recovery season', service: 'lawn care', angle: 'what we are seeing', cta: 'request estimate' },
    { topic: 'rodent entry points before cooler weather', service: 'rodent', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'brown widows in patio furniture and grills', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'large patch season starts as nights cool', service: 'lawn care', angle: 'do not ignore this', cta: 'read guide' },
    { topic: 'snowbird return: opening up the house', service: 'general pest', angle: 'new Florida homeowner', cta: 'book inspection' },
    { topic: 'palm trimming and pests hiding in the boots', service: 'tree & shrub', angle: 'myth/fact', cta: 'read guide' },
  ],
  11: [
    { topic: 'holiday guest pest prevention', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'winter weed prevention', service: 'lawn care', angle: 'what we are seeing', cta: 'read guide' },
    { topic: 'attic noises at night in November', service: 'rodent', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'dry-season watering and dollarweed', service: 'lawn care', angle: 'myth/fact', cta: 'read guide' },
    { topic: 'firewood, boxes, and the roaches that ride in', service: 'general pest', angle: 'new Florida homeowner', cta: 'book inspection' },
    { topic: 'mosquitoes on warm winter evenings', service: 'mosquito', angle: 'what we are seeing', cta: 'request estimate' },
  ],
  12: [
    { topic: 'holiday-ready pest control', service: 'general pest', angle: 'new Florida homeowner', cta: 'book inspection' },
    { topic: 'winter lawn weed pressure', service: 'lawn care', angle: 'myth/fact', cta: 'request estimate' },
    { topic: 'holiday wreaths and garlands: the spiders and ants that ride in', service: 'general pest', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'rodents in garages and storage over the holidays', service: 'rodent', angle: 'signs to check', cta: 'book inspection' },
    { topic: 'cool-season fungus rings on St. Augustine', service: 'lawn care', angle: 'what we are seeing', cta: 'read guide' },
    { topic: 'year-end lanai and screen check for pest entry', service: 'general pest', angle: 'what we are seeing', cta: 'book inspection' },
  ],
};

// "X vs Y" pest ID comparisons — the highest-repeat format across pest-industry
// social template catalogs (side-by-side ID posts). Facts here are standard
// entomology/turf diagnostics only: sizes, colors, nesting habits, visible
// evidence. No safety, timing, or pricing language (the compliance regexes in
// social-media.js reject those), and nothing framed as a field observation.
const PEST_VERSUS_PAIRS = [
  {
    key: 'carpenter_ant_vs_ghost_ant',
    service: 'general pest',
    left: { name: 'Carpenter Ant', points: ['Large: 1/4 to 1/2 inch', 'Nests in damp or damaged wood', 'Can hollow out wood over time'] },
    right: { name: 'Ghost Ant', points: ['Tiny, with pale legs', 'Dark head, see-through body', 'Trails to kitchens and baths'] },
    verdict: 'One can weaken wood. One is a kitchen nuisance.',
  },
  {
    key: 'subterranean_vs_drywood_termite',
    service: 'termite',
    left: { name: 'Subterranean Termite', points: ['Colonies live in the soil', 'Builds mud tubes up foundations', 'Needs ground moisture'] },
    right: { name: 'Drywood Termite', points: ['Lives inside dry wood', 'No mud tubes', 'Pushes out tiny pellet piles'] },
    verdict: 'Both eat wood. The clues they leave are different.',
  },
  {
    key: 'termite_swarmer_vs_winged_ant',
    service: 'termite',
    // Swarm-season only (ET months): FL swarms run late winter through early
    // summer — subterranean Feb–Apr, Formosan Apr–Jun, drywood tailing into
    // June. "Wings on the windowsill" out of season reads stale; the other
    // termite pair (mud tubes/pellets) is year-round evidence and stays ungated.
    months: [2, 3, 4, 5, 6],
    left: { name: 'Termite Swarmer', points: ['Straight antennae', 'Both wing pairs equal length', 'Thick, straight waist'] },
    right: { name: 'Winged Ant', points: ['Bent antennae', 'Front wings longer than back', 'Pinched waist'] },
    verdict: 'Wings on the windowsill? Check the waist first.',
  },
  {
    key: 'paper_wasp_vs_mud_dauber',
    service: 'general pest',
    left: { name: 'Paper Wasp', points: ['Open umbrella-shaped nest', 'Lives in small colonies', 'Nests under eaves and rails'] },
    right: { name: 'Mud Dauber', points: ['Builds mud tube nests', 'Solitary and docile', 'Hunts spiders'] },
    verdict: 'The nest shape tells you who built it.',
  },
  {
    // Customer-facing diagnostics stay cautious and UF/IFAS-consistent: chinch
    // bugs are confirmed by finding them (flotation test at the patch edge),
    // never by turf lifting out (that signals root loss — a different
    // problem); drought is a coverage/soil-moisture check, not a lawn-wide
    // pattern (uneven sprinklers show as localized dry spots per the lawn
    // report guidance). Neither side is presented as conclusive.
    key: 'chinch_bug_vs_drought_stress',
    service: 'lawn care',
    left: { name: 'Chinch Bug Damage', points: ['Starts along hot, sunny edges', 'Patches keep spreading outward', 'Float test at the edge finds the bugs'] },
    right: { name: 'Drought Stress', points: ['Dry spots where sprinklers miss', 'Blades fold; footprints linger', 'Soil is dry at the patch edge'] },
    verdict: 'Browning turf? Check sprinkler coverage first, then float-test the edge.',
  },
  {
    key: 'roof_rat_vs_norway_rat',
    service: 'rodent',
    left: { name: 'Roof Rat', points: ['Sleek body, extra-long tail', 'Climber: attics and trees', 'The common rat in SWFL'] },
    right: { name: 'Norway Rat', points: ['Heavier build, shorter tail', 'Burrows at ground level', 'Less common in Florida'] },
    verdict: 'In Southwest Florida, think up, not down.',
  },
  // ── Bank refill (owner ask 2026-09-06: "low on content") ─────────────────
  // Appended AFTER the original six so the rotation's relative order is
  // stable; the modulus change reshuffles dates once (accepted). Same rules
  // as above: visible ID facts only, cautious diagnostics, no safety /
  // timing / pricing words (SAFETY_OVERCLAIMS + TARGET_CLAIM_WORD_RE in
  // social-media.js reject them; the all-pairs validator test proves it).
  {
    key: 'bigheaded_ant_vs_fire_ant',
    service: 'general pest',
    left: { name: 'Bigheaded Ant', points: ['Two worker sizes; big square heads', 'Loose dirt piles along pavers', 'Trails follow walls and edges'] },
    right: { name: 'Fire Ant', points: ['Workers vary in size; no giant heads', 'Dome mounds in open sun', 'Swarms up anything that disturbs the mound'] },
    verdict: 'Dirt piles by the pavers usually mean bigheaded ants, not fire ants.',
  },
  {
    key: 'german_roach_vs_american_roach',
    service: 'general pest',
    left: { name: 'German Roach', points: ['Small: about half an inch', 'Two dark stripes behind the head', 'Lives indoors near kitchens and baths'] },
    right: { name: 'American Roach', points: ['Large: 1.5 inches or more', 'Reddish-brown with a pale band', 'Comes in from outside and drains'] },
    verdict: 'Size and stripes tell you which roach you have.',
  },
  {
    key: 'asian_roach_vs_german_roach',
    service: 'general pest',
    left: { name: 'Asian Roach', points: ['Flies to porch lights at night', 'Lives outdoors in mulch and leaf litter', 'Wanders in through open doors'] },
    right: { name: 'German Roach', points: ['Does not fly', 'Stays hidden in warm indoor gaps', 'Egg cases carried until they hatch'] },
    verdict: 'Flew in at the porch light? That is the Asian roach.',
  },
  {
    key: 'black_widow_vs_brown_widow',
    service: 'general pest',
    left: { name: 'Black Widow', points: ['Glossy black body', 'Red hourglass underneath', 'Smooth, round egg sac'] },
    right: { name: 'Brown Widow', points: ['Tan and mottled brown', 'Orange hourglass underneath', 'Spiky, golf-ball egg sacs'] },
    verdict: 'Spiky egg sacs point to the brown widow, the one you will usually find here.',
  },
  {
    key: 'wolf_spider_vs_huntsman',
    service: 'general pest',
    left: { name: 'Wolf Spider', points: ['Hairy, stout body', 'Hunts on the ground and floors', 'Mother carries the egg sac behind her'] },
    right: { name: 'Huntsman Spider', points: ['Flat body, long crab-like legs', 'Sits on walls and ceilings', 'Scoots sideways when startled'] },
    verdict: 'Floor runner or wall sitter? That is your answer.',
  },
  {
    // Caterpillar season on St. Augustine runs late spring through fall.
    key: 'sod_webworm_vs_armyworm',
    service: 'lawn care',
    months: [5, 6, 7, 8, 9, 10],
    left: { name: 'Sod Webworm', points: ['Small tan moths zigzag at dusk', 'Blades look notched or chewed', 'Damage shows as ragged patches'] },
    right: { name: 'Fall Armyworm', points: ['Striped caterpillar with a Y on its head', 'Blades chewed down to the stem', 'Damage moves across the lawn in a front'] },
    verdict: 'Notched blades or mowed-down turf tells the caterpillars apart.',
  },
  {
    key: 'large_patch_vs_dollar_spot',
    service: 'lawn care',
    left: { name: 'Large Patch', points: ['Circles that can span several feet', 'Yellow to orange ring at the edge', 'Shows up in cool, wet months'] },
    right: { name: 'Dollar Spot', points: ['Small straw-colored spots', 'Hourglass lesions on the blades', 'Favors warm days and dewy nights'] },
    verdict: 'Patch size tells the two lawn fungi apart.',
  },
  {
    key: 'grubs_vs_mole_crickets',
    service: 'lawn care',
    left: { name: 'White Grubs', points: ['C-shaped larvae under the sod', 'Turf peels back like carpet', 'Roots chewed away underneath'] },
    right: { name: 'Mole Crickets', points: ['Raised, spongy tunnels in the turf', 'Small mounds of loose soil', 'Soapy water flush brings them up'] },
    verdict: 'Peels back or feels spongy? Different pest underground.',
  },
  {
    key: 'termite_frass_vs_carpenter_ant_frass',
    service: 'termite',
    left: { name: 'Drywood Pellets', points: ['Six-sided pellets, all one size', 'Tiny piles below a pinhole', 'Looks like coarse sand or coffee grounds'] },
    right: { name: 'Carpenter Ant Frass', points: ['Fibrous wood shavings', 'Mixed with insect parts', 'Pushed out of nest openings'] },
    verdict: 'Pellets or shavings? The pile is your first clue; an inspection confirms it.',
  },
  {
    key: 'mosquito_vs_crane_fly',
    service: 'mosquito',
    left: { name: 'Mosquito', points: ['Small, with a needle-like mouth', 'High whine near your ears', 'Active at dawn and dusk'] },
    right: { name: 'Crane Fly', points: ['Big and gangly, legs that fall off', 'Does not bite', 'Bounces off the lanai screen'] },
    verdict: 'The giant one on the screen is a crane fly, not a mega-mosquito.',
  },
  {
    key: 'no_see_um_vs_mosquito',
    service: 'mosquito',
    left: { name: 'No-See-Um', points: ['Tiny enough to pass through screens', 'Bites near water at dawn and dusk', 'Welts show up before you see the bug'] },
    right: { name: 'Mosquito', points: ['Visible, with a distinct whine', 'Breeds in standing water', 'Rests on walls and under eaves'] },
    verdict: 'Cannot see what bit you? Probably a no-see-um.',
  },
  {
    key: 'honey_bee_vs_yellowjacket',
    service: 'general pest',
    left: { name: 'Honey Bee', points: ['Fuzzy, golden-brown body', 'Visits flowers, ignores your food', 'Leave it: a pollinator at work'] },
    right: { name: 'Yellowjacket', points: ['Smooth, bright yellow and black', 'Nests in the ground or wall voids', 'Drawn to drinks and cookouts'] },
    verdict: 'Fuzzy means bee. Shiny and bold means yellowjacket.',
  },
  {
    key: 'silverfish_vs_earwig',
    service: 'general pest',
    left: { name: 'Silverfish', points: ['Teardrop shape, silvery scales', 'Three bristles at the tail', 'Damp closets, baths, and paper'] },
    right: { name: 'Earwig', points: ['Dark brown with pincers at the tail', 'Lives in mulch and damp beds', 'Wanders in after rain'] },
    verdict: 'Bristles or pincers at the tail end.',
  },
  {
    key: 'flea_vs_springtail',
    service: 'general pest',
    left: { name: 'Flea', points: ['Reddish-brown, flattened side to side', 'Jumps from pets and carpet', 'Bites at the ankles'] },
    right: { name: 'Springtail', points: ['Tiny grey or white specks', 'Jumps using a tail spring', 'Crowds damp sinks and drains after rain'] },
    verdict: 'Jumpers by the drain are usually springtails, not fleas.',
  },
  {
    key: 'millipede_vs_centipede',
    service: 'general pest',
    left: { name: 'Millipede', points: ['Round body, many short legs', 'Curls into a coil when touched', 'Shows up indoors after heavy rain'] },
    right: { name: 'Centipede', points: ['Flat body, fewer longer legs', 'Fast runner with long antennae', 'Hunts other bugs in damp spots'] },
    verdict: 'Coils up or runs off? That is how you tell.',
  },
  {
    key: 'whitefly_vs_mealybug',
    service: 'tree & shrub',
    left: { name: 'Spiraling Whitefly', points: ['Cloud of tiny white flyers when leaves shake', 'White spiral egg patterns under leaves', 'Sticky leaves and sooty mold below'] },
    right: { name: 'Mealybug', points: ['White cottony clumps in leaf joints', 'Barely moves', 'Sticky residue on stems'] },
    verdict: 'Flies off or stays cottony? Different shrub pest.',
  },
  {
    key: 'dollarweed_vs_dichondra',
    service: 'lawn care',
    left: { name: 'Dollarweed', points: ['Round, coin-shaped leaves', 'Stem attaches at the leaf center', 'Thrives where the soil stays wet'] },
    right: { name: 'Dichondra', points: ['Kidney-shaped leaves', 'Stem attaches at the notch', 'Low mat in shady, thin turf'] },
    verdict: 'Dollarweed means the spot stays wet. Check drainage and irrigation first.',
  },
  {
    key: 'nutsedge_vs_crabgrass',
    service: 'lawn care',
    left: { name: 'Nutsedge', points: ['Triangular stem you can roll', 'Outgrows the lawn in days', 'Loves soggy, low spots'] },
    right: { name: 'Crabgrass', points: ['Flat, wide blades in a rosette', 'Spreads along the ground', 'Fills thin, bare areas'] },
    verdict: 'Roll the stem: a triangle means sedge.',
  },
];

function toJson(value, fallback) {
  if (value == null) return fallback;
  if (Array.isArray(value) || typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function cleanText(value, max = 500) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

// Competitor URLs are persisted then rendered as <a href> in the admin UI, and
// this router only requires tech/admin — so a lower-privileged actor could
// otherwise store a javascript:/data: URL another admin clicks. Accept only
// http(s) absolute URLs at the storage boundary; everything else becomes null.
function httpUrlOrNull(value, max = 1000) {
  const cleaned = cleanText(value, max);
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? cleaned : null;
  } catch {
    return null;
  }
}

function firstSentence(value, max = 220) {
  const text = cleanText(value, max * 2);
  if (!text) return '';
  const sentence = text.match(/^(.+?[.!?])\s/)?.[1] || text;
  return sentence.length > max ? `${sentence.slice(0, max - 3).trim()}...` : sentence;
}

function titleCase(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/\b[a-z]/g, (m) => m.toUpperCase());
}

function normalizeChannels(channels) {
  // Only omitted (null/undefined) defaults to all channels. An explicit value
  // fails closed: a non-array, or an empty/all-invalid/whitespace list, yields
  // NO channels — so a typo or a blank SOCIAL_AUTONOMOUS_CHANNELS can't blast
  // every platform. Mirrors normalizePublishChannels in social-media.js.
  if (channels == null) return [...CHANNELS];
  if (!Array.isArray(channels)) return [];
  return channels
    .map((p) => String(p || '').trim().toLowerCase())
    .filter((p) => CHANNELS.includes(p));
}

async function hasTable(table) {
  try {
    return await db.schema.hasTable(table);
  } catch {
    return false;
  }
}

async function hasColumn(table, column) {
  try {
    return await db.schema.hasColumn(table, column);
  } catch {
    return false;
  }
}

function boolEnv(key, defaultValue = false) {
  const value = process.env[key];
  if (value == null || value === '') return defaultValue;
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase());
}

function numberEnv(key, defaultValue) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

// Resolve an autonomous publish mode. Unset/blank → fallbackWhenUnset (the
// documented default). A set-but-invalid value fails CLOSED to 'draft' so a
// typo never silently routes into live publishing.
function normalizePublishMode(value, fallbackWhenUnset = 'publish') {
  if (value == null || String(value).trim() === '') return fallbackWhenUnset;
  const mode = String(value).trim().toLowerCase();
  return mode === 'publish' || mode === 'draft' ? mode : 'draft';
}

const AUTONOMOUS_FLAGS = {
  get enabled() { return boolEnv('SOCIAL_AUTONOMOUS_STUDIO_ENABLED', false); },
  // Distinct opt-in for the HOURLY scheduler. `enabled` turns the Studio on for
  // manual admin use (and gates writes via requireStudioEnabled); `cronEnabled`
  // is the SEPARATE consent to also run automatic publishing on a schedule.
  // Both must be true for the cron to fire, so enabling the Studio for manual
  // use never silently starts autonomous posting.
  get cronEnabled() { return boolEnv('SOCIAL_AUTONOMOUS_CRON_ENABLED', false); },
  get includeReviews() { return boolEnv('SOCIAL_AUTONOMOUS_INCLUDE_REVIEWS', true); },
  // Dark-ship: the "pest showdown" X-vs-Y ID lane is OFF until explicitly
  // enabled (kill switch = unset SOCIAL_AUTONOMOUS_INCLUDE_VERSUS).
  get includeVersus() { return boolEnv('SOCIAL_AUTONOMOUS_INCLUDE_VERSUS', false); },
  // Dark-ship: review-count milestone celebrations ("300 Google reviews") are
  // OFF until explicitly enabled (kill switch = unset).
  get includeMilestones() { return boolEnv('SOCIAL_AUTONOMOUS_INCLUDE_MILESTONES', false); },
  // CLAMPED below the minimum gap between two daily 6:30 AM ET ticks. This is a
  // same-day DEDUPE guard, NOT the schedule (the fixed once-daily cron is). Two
  // consecutive ET ticks are normally 24h apart but only 23h across the
  // spring-forward DST transition, so cap at 22 — a higher value (e.g. a stale
  // 24 copied from old config) could see <interval elapsed on the DST day and
  // skip the only daily fire. Default 20. To change frequency, change the cron.
  get intervalHours() { return Math.min(numberEnv('SOCIAL_AUTONOMOUS_INTERVAL_HOURS', 20), 22); },
  get mode() {
    return normalizePublishMode(process.env.SOCIAL_AUTONOMOUS_MODE, 'publish');
  },
  get channels() {
    // Only an UNSET env var defaults; a blank/whitespace value passes through so
    // it normalizes to [] (fail closed). Blanking SOCIAL_AUTONOMOUS_CHANNELS to
    // stop output must actually stop it, not fall back to every platform.
    const raw = process.env.SOCIAL_AUTONOMOUS_CHANNELS == null
      ? 'gbp,facebook,instagram'
      : String(process.env.SOCIAL_AUTONOMOUS_CHANNELS);
    const selected = raw.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    return normalizeChannels(selected);
  },
};

async function latestAutonomousRun() {
  if (!(await hasTable('social_content_studio_runs'))) return null;
  return db('social_content_studio_runs')
    .where({ run_type: 'autonomous' })
    .whereIn('status', ['published', 'draft_created', 'dry_run'])
    .orderBy('started_at', 'desc')
    .first();
}

// Cadence/claim guard source: the most recent ATTEMPT, not just a successful
// run. Includes 'started' (in-flight: a run inserts its claim before publishing,
// so a crash after Meta/GBP accepts but before the run is marked complete still
// blocks the next tick from a duplicate with a fresh source_guid) AND 'failed'
// (a total publish failure still counts as an attempt — otherwise the hourly
// cron would ignore SOCIAL_AUTONOMOUS_INTERVAL_HOURS during a persistent outage
// and re-render/re-upload cards and hammer Meta/GBP every hour). Excludes
// 'skipped' (no attempt was made — a cadence/kill-switch/pause skip must not
// reset the clock). The advisory lock covers genuinely-concurrent runs; this
// covers crashed/failed runs whose lock was already released.
async function latestAutonomousClaim() {
  if (!(await hasTable('social_content_studio_runs'))) return null;
  return db('social_content_studio_runs')
    .where({ run_type: 'autonomous' })
    .whereIn('status', ['published', 'draft_created', 'dry_run', 'started', 'failed'])
    .orderBy('started_at', 'desc')
    .first();
}

async function insertAutonomousRun(row) {
  if (!(await hasTable('social_content_studio_runs'))) return null;
  const [inserted] = await db('social_content_studio_runs')
    .insert({
      run_type: 'autonomous',
      status: row.status || 'started',
      mode: row.mode || null,
      topic: row.topic || null,
      city: row.city || null,
      service: row.service || null,
      angle: row.angle || null,
      channels: JSON.stringify(row.channels || []),
      input: JSON.stringify(row.input || {}),
      preview: JSON.stringify(row.preview || {}),
      publish_result: JSON.stringify(row.publishResult || {}),
      skip_reason: row.skipReason || null,
      social_media_post_id: row.socialMediaPostId || null,
      started_at: row.startedAt || new Date(),
      finished_at: row.finishedAt || null,
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returning('*');
  return inserted;
}

async function updateAutonomousRun(id, patch) {
  if (!id || !(await hasTable('social_content_studio_runs'))) return null;
  const updates = {
    status: patch.status,
    skip_reason: patch.skipReason || null,
    social_media_post_id: patch.socialMediaPostId || null,
    finished_at: new Date(),
    updated_at: new Date(),
  };
  if (patch.preview) updates.preview = JSON.stringify(patch.preview);
  if (patch.publishResult) updates.publish_result = JSON.stringify(patch.publishResult);
  const [updated] = await db('social_content_studio_runs')
    .where({ id })
    .update(updates)
    .returning('*');
  return updated;
}

async function logAutonomousSkip(skipReason, input = {}) {
  return insertAutonomousRun({
    status: 'skipped',
    mode: AUTONOMOUS_FLAGS.mode,
    input,
    channels: AUTONOMOUS_FLAGS.channels,
    skipReason,
    startedAt: new Date(),
    finishedAt: new Date(),
  });
}

function applySearch(query, columns, values) {
  const terms = values.map(cleanText).filter(Boolean).slice(0, 4);
  if (!terms.length) return query;
  return query.where(function searchTerms() {
    for (const term of terms) {
      this.orWhere(function searchColumns() {
        for (const column of columns) {
          this.orWhereRaw(`LOWER(${column}) LIKE LOWER(?)`, [`%${term}%`]);
        }
      });
    }
  });
}

function locationForCity(city) {
  const resolved = resolveLocation(city);
  const label = cleanText(city, 80) || resolved?.name || 'Southwest Florida';
  return {
    id: resolved?.id || 'lakewood-ranch',
    name: resolved?.name || label,
    city: label,
  };
}

// ── City grounding ──────────────────────────────────────────────────────────
// Campaign copy targets ONE city, but the fact sources (blog posts matched by
// an OR topic search, review text, service descriptions) can carry a different
// city's name — live example 07-03: a Venice-targeted Facebook post opened
// "around Venice" then said "Your Sarasota lawn" because a Sarasota blog post
// won the content search. Facts naming a different service-area city are
// dropped, and an AI draft naming one falls back to the (city-clean) template.
// The comparison is strict per city name, not per office: "around Venice …
// your Punta Gorda lawn" reads just as wrong to the reader even though both
// route to the Venice office.
// "palmetto bugs" / "saw palmetto" / "laurel oaks" are Florida vernacular, not
// the cities Palmetto / Laurel — scrub them before scanning.
const KNOWN_CITY_NAMES = Object.keys(CITY_TO_LOCATION);
// Longest name first, and each match is consumed from the haystack, so nested
// names can't double-read: "Bradenton Beach homeowners" is one mention of
// bradenton beach, NOT also a (foreign) mention of bradenton.
const KNOWN_CITIES_BY_LENGTH = [...KNOWN_CITY_NAMES].sort((a, b) => b.length - a.length);
const CITY_FALSE_POSITIVES = /\b(?:saw\s+palmetto|palmetto\s+bugs?|laurel\s+oaks?)\b/gi;

// A city shows up in prose ("Sarasota") or in the hashtag forms the Instagram
// prompt itself suggests ("#sarasotafl", "#lakewoodranch") — scan all of them.
function cityForms(name) {
  const compact = name.replace(/ /g, '');
  return Array.from(new Set([name, compact, `${compact}fl`]));
}

function citiesMentioned(text) {
  let haystack = ` ${String(text || '').toLowerCase().replace(CITY_FALSE_POSITIVES, ' ').replace(/[^a-z]+/g, ' ').trim()} `;
  const found = [];
  for (const name of KNOWN_CITIES_BY_LENGTH) {
    let hit = false;
    for (const form of cityForms(name)) {
      const needle = ` ${form} `;
      if (haystack.includes(needle)) {
        hit = true;
        haystack = haystack.split(needle).join('  ');
      }
    }
    if (hit) found.push(name);
  }
  return found;
}

function mentionsOtherCity(text, targetCity) {
  const target = String(targetCity || '').toLowerCase().trim();
  return citiesMentioned(text).some((name) => name !== target);
}

// Blog rows about a different city are excluded up front: content[0] feeds a
// draft fact AND suggestedLink, so a cross-city row means wrong-city copy plus
// a wrong-city link. A row is cross-city when its city tag names a different
// known city, OR — for untagged/region-tagged rows ("SWFL") — when its
// title/meta/keyword/slug text names one; the fact scrub alone can't fix
// suggestedLink, which reads the row, not the fact.
function contentRowMatchesCity(row, targetCity) {
  const target = String(targetCity || '').toLowerCase().trim();
  if (!target) return true;
  const rowCity = String(row?.city || '').toLowerCase().trim();
  if (rowCity && rowCity !== target && KNOWN_CITY_NAMES.includes(rowCity)) return false;
  const rowText = [row?.title, row?.meta_description, row?.keyword, row?.slug].filter(Boolean).join(' ');
  return !mentionsOtherCity(rowText, target);
}

async function getCampaignContext({ topic, city, service }) {
  const location = locationForCity(city);
  const context = {
    location,
    services: [],
    content: [],
    recentSocials: [],
    pestPressure: null,
    reviews: [],
    competitorPatterns: DEFAULT_COMPETITOR_PATTERNS,
    fastestRisers: FASTEST_RISER_PROFILES.slice(0, 8),
  };

  if (await hasTable('services')) {
    try {
      let query = db('services')
        .select('id', 'service_key', 'name', 'short_name', 'description', 'category', 'subcategory', 'customer_visible')
        .where(function activeServices() {
          this.where('is_active', true).orWhereNull('is_active');
        })
        // Campaign facts/CTAs are public-facing, so never seed copy from a
        // service the customer site hides (internal-only or retired offerings).
        .where(function visibleServices() {
          this.where('customer_visible', true).orWhereNull('customer_visible');
        })
        .limit(8);
      query = applySearch(query, ['name', 'short_name', 'description', 'category', 'subcategory'], [topic, service]);
      context.services = await query;
    } catch {
      context.services = [];
    }
  }

  if (await hasTable('blog_posts')) {
    try {
      let query = db('blog_posts')
        .select('id', 'title', 'slug', 'city', 'tag', 'keyword', 'meta_description', 'status', 'publish_date', 'source', 'astro_live_url', 'astro_status')
        // suggestedLink turns a content row into a public social CTA, so only
        // posts the hub has actually served may feed copy/links. status =
        // 'published' alone is NOT enough: legacy rows keep a planned-era
        // slug (e.g. parrish-garage-door-seal-roach-entry) that never became
        // a path — that row shipped a 404 to every network on 2026-08-29.
        // The ONE share policy is content/blog-share-gate.js
        // (blogPostShareability) — every fetched row passes through it below.
        // The SQL mirrors it only to keep the recency window useful; the
        // predicate is authoritative and cannot drift from the admin share
        // button. Legacy status='published' rows that never had astro_status
        // stamped stay OUT: 'merged' already carries astro_live_url before
        // production serves the page. The live URL is then used verbatim,
        // never rebuilt from slug.
        .where('status', 'published')
        .where('astro_status', 'live')
        .whereNotNull('astro_live_url')
        .orderBy('publish_date', 'desc')
        // Rank relevance BEFORE capping: take a wider recency window so a
        // topic/service-relevant post that isn't in the 8 newest still wins,
        // then slice to 8 after the sort below.
        .limit(40);
      query = applySearch(query, ['title', 'keyword', 'tag', 'city', 'meta_description'], [topic, city, service]);
      const rows = await query;
      // The OR search also matches city-only posts; context.content[0] feeds
      // both a draft fact and the suggested link, so rank topic/service-
      // relevant posts ahead of city-only ones (stable sort keeps recency
      // within each tier) to avoid cross-service copy/links.
      const intentKeywords = serviceIntentKeywords({ topic, service });
      const matchesIntent = (row) => rowMatchesIntentKeywords(row, intentKeywords);
      const ranked = rows
        .filter((row) => blogPostShareability(row).ok)
        .filter((row) => contentRowMatchesCity(row, location.city))
        .map((row, index) => ({ row, index, relevant: matchesIntent(row) }))
        .sort((a, b) => (b.relevant - a.relevant) || (a.index - b.index));
      // The link is chosen by topic/service, never by city alone: a city-only
      // match sent a roach headline to the Venice office-opening (termite)
      // post on 2026-08-27. No relevant live page → no link (the post still
      // goes out; a wrong or dead link is worse than none).
      context.linkPage = await firstLivePage(ranked.filter((entry) => entry.relevant).map((entry) => entry.row));
      // sourceFacts reads content[0]: the page we link, title and illustrate
      // must also be the page the caption quotes — so the probed row leads,
      // ahead of any newer relevant row whose URL failed the probe. City-only
      // rows never reach content at all: with no relevant row they would
      // become content[0] and quote an unrelated service into the caption
      // (the copy-side twin of the 08-27 Venice/termite link). No relevant
      // row → no content fact; the caption leans on service/pest-pressure.
      context.content = captionContentRows(ranked, context.linkPage);
    } catch {
      context.content = [];
      context.linkPage = null;
    }
  }

  if (await hasTable('social_media_posts')) {
    try {
      let query = db('social_media_posts')
        .select('id', 'title', 'description', 'source_url', 'source_type', 'status', 'created_at')
        .orderBy('created_at', 'desc')
        .limit(8);
      query = applySearch(query, ['title', 'description', 'source_type'], [topic, city, service]);
      context.recentSocials = await query;
    } catch {
      context.recentSocials = [];
    }
  }

  if (await hasTable('pest_pressure_configs')) {
    try {
      const row = await db('pest_pressure_configs')
        .where({ scope: 'global' })
        .select('enabled', 'labels', 'customer_explanation_text', 'calculation_version')
        .first();
      if (row) {
        context.pestPressure = {
          enabled: row.enabled,
          labels: toJson(row.labels, []),
          explanation: row.customer_explanation_text,
          calculationVersion: row.calculation_version,
        };
      }
    } catch {
      context.pestPressure = null;
    }
  }

  if (await hasTable('google_reviews')) {
    try {
      context.reviews = await db('google_reviews')
        .where('reviewer_name', '!=', '_stats')
        .where('star_rating', 5)
        .whereNotNull('review_text')
        // Never quote a review Google has removed in marketing content.
        .whereNull('missing_since')
        .where(function activeLocations() {
          this.where('location_id', location.id).orWhereNull('location_id');
        })
        .select('id', 'reviewer_name', 'location_id', 'star_rating', 'review_text', 'review_created_at')
        .orderBy('review_created_at', 'desc')
        .limit(4);
    } catch {
      context.reviews = [];
    }
  }

  return context;
}

// A content row is relevant when any intent keyword appears as a whole word
// in its title/keyword/tag/meta (same boundary rule as the requested topic).
function rowMatchesIntentKeywords(row = {}, keywords = []) {
  if (!keywords.length) return false;
  const text = [row.title, row.keyword, row.tag, row.meta_description]
    .map((v) => String(v || '').toLowerCase()).join(' ');
  return keywords.some((kw) => textHasIntentKeyword(text, kw));
}

// Did a legacy brand card actually reach a network? True only for a
// successful platform result that retained one of the rendered card URLs:
// Facebook/GBP/LinkedIn report `imageUrl` when their media attached (text-only
// fallbacks and thumbnail misses carry none); Instagram has no text fallback,
// so its success means the shared image it was given went out.
function legacyCardShipped(platformResults = [], cardUrls = new Set(), sharedImageUrl = null) {
  if (!cardUrls.size) return false;
  return platformResults.some((p) => p?.success && (
    (p.imageUrl && cardUrls.has(p.imageUrl))
    || (p.platform === 'instagram' && sharedImageUrl && cardUrls.has(sharedImageUrl))
  ));
}

// A row's public URL is ONLY its pages-poll-stamped astro_live_url — never a
// URL rebuilt from `slug` (flat, category-less, and stale for legacy rows).
// Used verbatim: the hub's canonical form keeps the trailing slash, which
// normalizeUrl would strip (every link would then ship as a 301 hop).
function liveUrlForRow(row = {}) {
  return httpUrlOrNull(row.astro_live_url);
}

// Liveness probe for a link about to ship to every network. The DB stamp says
// the page WAS live; the hub can still retire/rename it (redirect rules,
// content rebases). Only wavespestcontrol.com is probed, and only a direct
// 200 at the stamped URL counts: redirects are NOT followed, so a retired
// path that 301s to the homepage/another post reads as dead, and the
// server-side request can never be steered off-domain by a redirect. The
// stamped astro_live_url is already the hub's canonical form (trailing
// slash), so a live page never needs a hop. Any failure = dead.
const HUB_HOST = /(^|\.)wavespestcontrol\.com$/i;
const LINK_PROBE_TIMEOUT_MS = 5000;
async function linkIsLive(url, fetchImpl = globalThis.fetch) {
  try {
    const parsed = new URL(String(url || ''));
    if (!HUB_HOST.test(parsed.hostname)) return false;
    const res = await fetchImpl(parsed.href, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(LINK_PROBE_TIMEOUT_MS) });
    // Only the status is needed — release the body so the pooled socket is
    // returned instead of held open until GC (undici keeps an unconsumed
    // body's connection reserved).
    if (res?.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
    // Exactly 200 — `ok` would also accept a 204 blank route as "live".
    return res?.status === 200;
  } catch {
    return false;
  }
}

const LINK_PROBE_LIMIT = 3;

// First candidate (in rank order) whose live URL answers 200. The ≤3 probes
// run in PARALLEL under one LINK_PROBE_TIMEOUT_MS ceiling, so an unreachable
// hub costs a preview request ~5s, not 3×10s serial — and yields "no link",
// never a dead one.
async function firstLivePage(rows = [], probe = linkIsLive) {
  const candidates = rows.filter((row) => liveUrlForRow(row)).slice(0, LINK_PROBE_LIMIT);
  if (!candidates.length) return null;
  const verdicts = await Promise.all(candidates.map((row) => probe(liveUrlForRow(row)).catch(() => false)));
  const index = verdicts.findIndex(Boolean);
  return index === -1 ? null : candidates[index];
}

// Rows the caption may quote: topic/service-relevant only, the probed link
// page first. Never a city-only row (see getCampaignContext).
function captionContentRows(ranked = [], linkPage = null) {
  const relevantRows = ranked.filter((entry) => entry.relevant).map((entry) => entry.row);
  return (linkPage
    ? [linkPage, ...relevantRows.filter((row) => row !== linkPage)]
    : relevantRows).slice(0, 8);
}

function suggestedLink(context) {
  return context?.linkPage ? liveUrlForRow(context.linkPage) || '' : '';
}

// LinkedIn does not scrape article URLs — the portal supplies the article
// title itself, so a linked post carries the page's real headline instead of
// the lowercase topic literal ("ants and roaches after heavy rain").
function suggestedLinkTitle(context) {
  return context?.linkPage ? cleanText(context.linkPage.title, 200) : '';
}

// Hero photo of the linked page (og:image re-hosted as JPEG) — the visual the
// studio prefers over the legacy fixed SVG brand card whenever a live page is
// attached. null = no link, page had no og:image, or the fetch failed.
async function heroImageForLink(link) {
  if (!link || typeof SocialMediaService.blogHeroSocialImageUrl !== 'function') return null;
  try {
    return await SocialMediaService.blogHeroSocialImageUrl(link);
  } catch {
    return null;
  }
}

// The legacy SVG card is the fallback of last resort, not a design choice —
// surface every publish that fell back to it so the owner sees it (ops
// convention: FIX: subject, contact@). Never throws.
// creative: { enabled, eligible, produced } — the engine's ACTUAL state on
// this run, so the diagnosis never sends the owner after a phantom provider
// failure when the engine was simply off, skipped (GBP-only run), or did
// produce the Meta image while GBP needed a card.
function creativeStateSummary({ enabled, eligible, produced } = {}) {
  if (!enabled) return 'SOCIAL_CREATIVE_ENGINE_ENABLED is not true (engine off)';
  if (!eligible) return 'creative engine enabled but not eligible for this run (GBP-only, or no publish-ready non-GBP channel)';
  if (produced) return 'creative engine produced the Meta image; the GBP card was the fallback (GBP never posts AI imagery)';
  return 'creative engine attempted and returned no image (provider/upload failure)';
}

async function alertLegacyCardFallback(plan = {}, { link, creative }) {
  try {
    const sendgrid = require('./sendgrid-mail');
    const to = process.env.SOCIAL_STUDIO_ALERT_EMAIL || 'contact@wavespestcontrol.com';
    const fromEmail = process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
    const why = [
      creativeStateSummary(creative),
      link ? `linked page hero unavailable (${link})` : 'no live page matched the topic, so no hero to use',
    ].join('; ');
    const subject = `FIX: social studio fell back to the legacy brand card — ${cleanText(plan.topic, 80)} (${cleanText(plan.city, 40)})`;
    const text = `The autonomous social studio published with the legacy fixed SVG card.\n\nTopic: ${plan.topic}\nCity: ${plan.city}\nChannels: ${(plan.channels || []).join(', ')}\nLink: ${link || '(none)'}\n\nWhy: ${why}\n\nFix: set SOCIAL_CREATIVE_ENGINE_ENABLED=true on Railway, or make sure a live blog post matches this topic so its hero photo is used.`;
    await deliverOpsDigest({
      key: 'social-studio-fallback',
      subject,
      text,
      link: '/admin/social-media',
      sendEmail: () => sendgrid.sendOne({
        to,
        fromEmail,
        fromName: 'Waves Pest Control',
        subject,
        text,
        categories: ['ops', 'social-studio'],
        suppressErrorLog: true,
      }),
    });
  } catch (err) {
    // err.message carries the raw SendGrid body, which can echo addresses —
    // log only the status/code (non-card PII logging rule).
    logger.warn(`[social-studio] legacy-card fallback alert failed: status=${err?.status || err?.code || 'unknown'}`);
  }
}

function sourceDetailForCard(preview) {
  const preferred = (preview?.sources || []).find((source) =>
    ['service', 'content', 'pest_pressure'].includes(source.type) && source.detail
  );
  if (preferred?.detail) return preferred.detail;
  const gbp = cleanText(preview?.drafts?.gbp, 320);
  if (gbp) return gbp;
  return 'Local pest pressure changes quickly with heat, rain, and property conditions.';
}

function buildCampaignCardInput(input = {}, preview = {}) {
  const inputs = preview.inputs || {};
  return {
    variant: 'campaign',
    city: inputs.city || input.city,
    topic: inputs.topic || input.topic,
    service: inputs.service || input.service,
    detail: sourceDetailForCard(preview),
    cta: ctaText(inputs.cta || input.cta),
  };
}

function buildMilestoneCardInput(plan = {}) {
  return {
    variant: 'milestone',
    // Company-wide count — no city stamp (plan.city only routes the GBP location).
    city: null,
    service: 'Google reviews',
    count: plan.milestone,
    averageRating: plan.averageRating,
    thanks: 'Thank you, Southwest Florida.',
  };
}

function buildVersusCardInput(pair = {}, input = {}) {
  return {
    variant: 'versus',
    city: input.city,
    // General-pest comparisons carry a neutral ID label: several pairs (German
    // roach, flea, honey bee) belong to specialty services, and stamping
    // "General Pest" on them would imply the recurring program covers them.
    service: (input.service || pair.service) === 'general pest' ? 'Pest ID' : titleCase(input.service || pair.service || 'Pest ID'),
    left: pair.left,
    right: pair.right,
    verdict: pair.verdict,
  };
}

function buildReviewCardInput(candidate = {}) {
  return {
    variant: 'review',
    city: candidate.city,
    reviewerDisplayName: candidate.reviewerDisplayName,
    excerpt: candidate.excerpt,
    service: 'Google review',
  };
}

async function uploadSocialCard(cardInput, filenameSeed, platform) {
  if (typeof SocialMediaService.uploadImageToS3 !== 'function') return null;
  try {
    const base64 = await SocialCardRenderer.renderSocialCardJpegBase64(cardInput, { platform });
    const suffix = platform && platform !== 'square' ? `-${platform}` : '';
    const filename = `${SocialCardRenderer.filenameSlug(filenameSeed)}${suffix}-${Date.now()}.jpg`;
    return await SocialMediaService.uploadImageToS3(base64, filename);
  } catch {
    return null;
  }
}

// platform: 'square' (default, Instagram/Facebook 1:1) or 'gbp' (4:3) — GBP can
// center-crop a square, clipping the logo/CTA, so it gets its own 4:3 render.
async function renderCampaignImageUrl(input, preview, platform) {
  return uploadSocialCard(
    buildCampaignCardInput(input, preview),
    `${preview?.inputs?.city || input.city}-${preview?.inputs?.topic || input.topic}`,
    platform
  );
}

async function renderMilestoneImageUrl(plan, platform) {
  return uploadSocialCard(buildMilestoneCardInput(plan), `milestone-${plan.milestone}-reviews`, platform);
}

async function renderVersusImageUrl(pair, input, platform) {
  return uploadSocialCard(
    buildVersusCardInput(pair, input),
    `versus-${pair.key || 'pest-id'}-${input.city || 'swfl'}`,
    platform
  );
}

async function renderReviewGraphicImageUrl(candidate, platform) {
  return uploadSocialCard(
    buildReviewCardInput(candidate),
    `review-${candidate.city || 'waves'}-${candidate.googleReviewId || Date.now()}`,
    platform
  );
}

function previewWithVisual(preview, { imageUrl, gbpImageUrl, gbpImageBranded, variant, templateKey, creative, variants, videoUrl }) {
  if (!imageUrl) return preview;
  return {
    ...preview,
    visual: {
      imageUrl,
      variant,
      templateKey: templateKey || (variant === 'review' ? 'waves_clean_square' : 'waves_campaign_square'),
      // gbpImageBranded:false = the GBP image is a hero PHOTO (no chrome), so
      // postToGBP must watermark it on approval; omitted/true = deterministic
      // card whose chrome already carries the logo.
      ...(gbpImageUrl && gbpImageBranded === false ? { gbpImageBranded: false } : {}),
      // Creative-engine metadata: which scene concept made this image (feeds the
      // no-repeat rotation) and, on draft runs, the alternate variants the admin
      // can pick from in the approval queue. videoUrl records an approved Reel
      // (the primary imageUrl stays a still for thumbnails).
      // gbpImageUrl is the DETERMINISTIC GBP card for this run — persisted so
      // an approved draft's GBP post keeps its compliant image (publishToAll
      // never falls back to the shared image for GBP; no AI imagery on GBP).
      ...(gbpImageUrl ? { gbpImageUrl } : {}),
      ...(creative ? { creative } : {}),
      ...(Array.isArray(variants) && variants.length ? { variants } : {}),
      ...(videoUrl ? { videoUrl } : {}),
    },
  };
}

// Concept keys of recently PUBLISHED/chosen creative visuals — the engine skips
// these so back-to-back posts don't reuse a scene. Only the chosen concept
// counts (not every draft variant): the banks are ~5 deep per service, and
// excluding whole draft batches would exhaust a bank in two days and disable
// exclusion entirely (pickConcepts ignores an exhausted exclusion list).
async function recentCreativeConceptKeys(limit = 6) {
  if (!(await hasTable('social_content_studio_runs'))) return [];
  try {
    const rows = await db('social_content_studio_runs')
      .where({ run_type: 'autonomous' })
      .orderBy('started_at', 'desc')
      .limit(Math.max(1, Math.min(30, Number(limit) || 6)))
      .select('preview');
    const keys = [];
    for (const row of rows) {
      const conceptKey = toJson(row.preview, {})?.visual?.creative?.conceptKey;
      if (conceptKey) keys.push(conceptKey);
    }
    return Array.from(new Set(keys));
  } catch {
    return [];
  }
}

// AI-scene photo card variants for an autonomous run (creative engine). Returns
// [] when the engine is disabled or every variant fails, so callers keep the
// legacy SVG-card path as the fallback. Draft runs get the multi-variant batch
// for the approval queue; publish runs render exactly one.
// A Veo clip only ever publishes to Facebook/Instagram — publishToAll routes
// video to Meta while GBP keeps the still — so don't spend on a clip unless a
// REQUESTED channel can actually take it. E.g. SOCIAL_AUTONOMOUS_CHANNELS=gbp,
// or FB/IG disabled/missing credentials, would otherwise buy a clip that can
// never publish and put a misleading video option in the approval queue.
// Mirrors publishToAll's fbReady/igReady env checks.
function hasVideoCapableChannel(channels) {
  const list = Array.isArray(channels) ? channels : [];
  // Mirror publishToAll's readiness SPLIT exactly: its fbReady is CREDENTIALS-
  // only (page token + page id — IG Graph publishing rides those even with
  // Facebook posting off), while the SOCIAL_FACEBOOK_ENABLED / _INSTAGRAM_
  // flags each gate only their own platform entry. So an IG-only config with
  // Facebook disabled still earns a video, and one missing the page id doesn't.
  const pageCreds = !!process.env.FACEBOOK_ACCESS_TOKEN && !!process.env.FACEBOOK_PAGE_ID;
  const fbReady = SOCIAL_FLAGS.facebookEnabled && pageCreds;
  const igReady = SOCIAL_FLAGS.instagramEnabled && pageCreds && !!process.env.INSTAGRAM_ACCOUNT_ID;
  return (list.includes('facebook') && fbReady) || (list.includes('instagram') && igReady);
}

// Is a fixed (deterministic) card that reached a network a FIX: alert?
// Always for a campaign: a hero photo or a scene was expected, and its GBP
// card beside a successful scene is still the fallback for the hero. For the
// other kinds the GBP card beside a scene is the DESIGNED visual (GBP never
// posts AI imagery), so the card is a fallback only when the engine was on
// and eligible yet produced nothing — engine off means the card is the
// designed visual everywhere.
function fixedCardIsFallback({ isCampaignRun, engineProduced, creativeEligible, engineEnabled }) {
  if (isCampaignRun) return true;
  return !engineProduced && !!creativeEligible && !!engineEnabled;
}

// Everything that differs per run kind, in ONE table: the creative engine's
// variant + overlay input, the deterministic card renderer (the GBP image and
// the engine-off / engine-failed fallback, at 'gbp' or square), and the
// template keys stamped on the preview. runAutonomousLocked reads the kind
// once and never branches on it again; adding a kind means adding a row.
// Campaign is the only kind with a hero-photo alternative to its card — the
// caller resolves that (resolveCampaignHero), the table just renders cards.
const RUN_KINDS = {
  review: {
    variant: 'review',
    cardInput: (plan) => buildReviewCardInput(plan.reviewGraphic),
    renderCard: (plan, preview, platform) => renderReviewGraphicImageUrl(plan.reviewGraphic, platform),
    photoTemplateKey: 'waves_photo_review_v1',
    cardTemplateKey: 'waves_clean_square',
  },
  versus: {
    variant: 'versus',
    cardInput: (plan) => buildVersusCardInput(plan.versusPair, plan),
    renderCard: (plan, preview, platform) => renderVersusImageUrl(plan.versusPair, plan, platform),
    photoTemplateKey: 'waves_photo_versus_v1',
    cardTemplateKey: 'waves_versus_square',
  },
  milestone: {
    variant: 'milestone',
    cardInput: (plan) => buildMilestoneCardInput(plan),
    renderCard: (plan, preview, platform) => renderMilestoneImageUrl(plan, platform),
    photoTemplateKey: 'waves_photo_milestone_v1',
    cardTemplateKey: 'waves_milestone_square',
  },
  campaign: {
    variant: 'campaign',
    cardInput: (plan, preview) => buildCampaignCardInput(plan, preview),
    renderCard: (plan, preview, platform) => renderCampaignImageUrl(plan, preview, platform),
    photoTemplateKey: 'waves_photo_square_v1',
    cardTemplateKey: 'waves_campaign_square',
  },
};

// Classify a plan. A review run is identified by its source review id ALONE
// (see the liveness note in runAutonomousLocked); versus and milestone by
// their plan payloads; everything else is a campaign.
function runKindFor(plan = {}) {
  if (plan.reviewGraphic?.googleReviewId) return RUN_KINDS.review;
  if (plan.versusPair) return RUN_KINDS.versus;
  if (plan.milestone) return RUN_KINDS.milestone;
  return RUN_KINDS.campaign;
}

async function creativeVariantsForRun(plan, preview, { kind, wantsGbp, effectiveMode, now }) {
  if (!CreativeEngine.CREATIVE_FLAGS.enabled) return [];
  try {
    const { variant } = kind;
    const excludeConcepts = await recentCreativeConceptKeys();
    const variants = await CreativeEngine.generateVariants({
      cardInput: kind.cardInput(plan, preview),
      topic: plan.topic,
      service: plan.service,
      city: plan.city,
      variant,
      count: effectiveMode === 'draft' ? CreativeEngine.CREATIVE_FLAGS.variantCount : 1,
      excludeConcepts,
      wantGbp: wantsGbp,
      now,
    });

    // Veo Reel option — DRAFT campaign runs only (approval required for video:
    // real cost per clip and the most public artifact the brand ships), on
    // every Nth ET day, and only when at least one image variant succeeded (a
    // video-only queue entry would leave GBP with no media and the runs list
    // with no thumbnail). Appended LAST so variants[0] — the run's primary
    // visual — stays a still.
    if (
      variants.length
      && variant === 'campaign'
      && effectiveMode === 'draft'
      && CreativeEngine.VIDEO_FLAGS.enabled
      && CreativeEngine.isVideoDay(now)
      && hasVideoCapableChannel(plan.channels)
    ) {
      const video = await CreativeEngine.generateVideoVariant({
        topic: plan.topic,
        service: plan.service,
        city: plan.city,
        excludeConcepts: [...excludeConcepts, ...variants.map((v) => v.conceptKey).filter(Boolean)],
        now,
      });
      if (video) variants.push(video);
    }

    return variants;
  } catch {
    return [];
  }
}

// Campaign slot days: the ET days the campaign lane owns outright — not a
// review day (day % 4 === 0) and, while the versus lane is on, not a versus
// day (day % 4 === 2). Flipping SOCIAL_AUTONOMOUS_INCLUDE_VERSUS changes the
// slot set and so reshuffles the walk once (accepted; same posture as a bank
// size change in the versus lane).
function isCampaignSlotDay(day) {
  return day % 4 !== 0 && (day % 4 !== 2 || !AUTONOMOUS_FLAGS.includeVersus);
}

// Slot days from the sequence epoch up to (not including) the given ET date.
// A few thousand iterations at most — pure, no DB, deterministic per day.
function campaignSlotsBefore(year, month, day) {
  let count = 0;
  for (let y = VERSUS_SEQ_EPOCH_YEAR; y <= year; y += 1) {
    const lastMonth = y === year ? month : 12;
    for (let m = 1; m <= lastMonth; m += 1) {
      const lastDay = (y === year && m === month) ? day - 1 : new Date(Date.UTC(y, m, 0)).getUTCDate();
      for (let d = 1; d <= lastDay; d += 1) if (isCampaignSlotDay(d)) count += 1;
    }
  }
  return count;
}

// Cards the campaign lane ACTUALLY published recently — topic|city of the
// last `limit` autonomous campaign runs, whichever lane's day they landed on.
// The static slot walk cannot see a fire that happened because another lane
// yielded (no review candidate, pair out of season), so the walk skips any
// state still inside this window instead of repeating it weeks later.
// Fail-open: no table / query error → empty set → the plain walk.
async function recentCampaignCards(limit = 24) {
  if (!(await hasTable('social_content_studio_runs'))) return new Set();
  try {
    const rows = await db('social_content_studio_runs')
      .where({ run_type: 'autonomous' })
      .whereIn('status', ['published', 'draft_created', 'dry_run'])
      .orderBy('started_at', 'desc')
      .limit(Math.max(1, Math.min(120, Number(limit) * 3 || 72)))
      .select('topic', 'city', 'input');
    const cards = [];
    for (const row of rows) {
      const input = toJson(row.input, {}) || {};
      if (input.versusPair || input.reviewGraphic || input.milestone) continue; // other lanes
      if (row.topic && row.city) cards.push(`${row.topic}|${row.city}`);
      if (cards.length >= limit) break;
    }
    return new Set(cards);
  } catch {
    return new Set();
  }
}

// The campaign card at walk position `slot` for a month's bank: topic index
// walks the bank, the city is phase-shifted one step per topic cycle, so
// every topic×city combination (6 × 4 = 24 positions) occurs before any
// repeat.
function campaignCardAt(seasonal, slot) {
  const topic = seasonal[slot % seasonal.length];
  const topicCycle = Math.floor(slot / seasonal.length);
  const city = WAVES_LOCATIONS[(slot + topicCycle) % WAVES_LOCATIONS.length]?.name || 'Sarasota';
  return { topic, city };
}

// `recent` = recentCampaignCards(): states already published inside the
// last full cycle are skipped, so a fire on a day another lane yielded can
// neither repeat a recent card nor be repeated by the next owned slot.
function selectAutonomousCampaign(now = new Date(), { recent = new Set() } = {}) {
  // Anchor seasonal topic + city rotation to Eastern business dates, not UTC
  // (Railway runs TZ=UTC, which would flip topics a few hours early each day).
  const { year, month, day } = etParts(now);
  const seasonal = SEASONAL_AUTONOMOUS_TOPICS[month] || SEASONAL_AUTONOMOUS_TOPICS[6];
  // The walk advances one step per campaign SLOT (the days this lane owns
  // outright — see isCampaignSlotDay), never from the raw day: indexing by
  // day aliased to the lanes' parity (day % 6 reached topics 1/3/5, day % 4
  // cities 1/3), the same defect #3651 fixed in the versus lane. A yielded
  // day is not a slot: it takes the state half a cycle ahead PLUS ONE
  // (farthest from its neighbours by city, and — since half a cycle is a
  // whole number of topic cycles — one topic over, so a yielded day never
  // posts the same subject as the owned slot before or after it). The
  // recent-cards skip below keeps that state from being replayed when the
  // walk reaches it.
  const cycle = seasonal.length * WAVES_LOCATIONS.length;
  const slotsBefore = campaignSlotsBefore(year, month, day);
  const start = isCampaignSlotDay(day) ? slotsBefore : slotsBefore + Math.floor(cycle / 2) + 1;
  let card = campaignCardAt(seasonal, start);
  for (let step = 0; step < cycle; step += 1) {
    const candidate = campaignCardAt(seasonal, start + step);
    if (!recent.has(`${candidate.topic.topic}|${candidate.city}`)) { card = candidate; break; }
  }
  return {
    ...card.topic,
    city: card.city,
    channels: AUTONOMOUS_FLAGS.channels,
  };
}

async function selectAutonomousReviewPlan(now = new Date()) {
  if (!AUTONOMOUS_FLAGS.includeReviews) return null;
  const { day } = etParts(now); // Eastern business date, not UTC (see selectAutonomousCampaign)
  if (day % 4 !== 0) return null;

  const { candidates } = await listReviewGraphicCandidates({ limit: 10 });
  const candidate = candidates[0];
  if (!candidate) return null;

  const city = candidate.city || 'SWFL';
  const topic = `5-star review from ${city}`;
  const excerpt = reviewExcerpt(candidate.excerpt, 180);
  const drafts = {
    facebook: `"${excerpt}"\n\nA real 5-star Google review from ${candidate.reviewerDisplayName}. Local service, clear communication, and follow-through matter.`,
    instagram: `"${excerpt}"\n\nThanks for trusting Waves, ${city}.\n\n#wavespestcontrol #swfl #pestcontrol #googlereview`,
    linkedin: `Customer trust compounds when service teams communicate clearly and follow through. Recent 5-star feedback from ${city}: "${excerpt}"`,
    gbp: `A ${city} customer left Waves a 5-star Google review: "${excerpt}" Thanks for trusting our local team.`,
  };
  return {
    topic,
    city,
    service: 'review proof',
    angle: 'review highlight',
    cta: 'book inspection',
    channels: AUTONOMOUS_FLAGS.channels,
    reviewGraphic: candidate,
    preview: {
      inputs: {
        topic,
        city,
        service: 'review proof',
        angle: 'review highlight',
        cta: 'book inspection',
        channels: AUTONOMOUS_FLAGS.channels,
      },
      suggestedLink: 'https://www.wavespestcontrol.com/pest-control-reviews/',
      drafts: Object.fromEntries(AUTONOMOUS_FLAGS.channels.map((channel) => [channel, drafts[channel]]).filter(([, text]) => text)),
      validation: validateDrafts(drafts),
      sources: [{
        type: 'google_review',
        label: candidate.reviewerDisplayName,
        detail: excerpt,
      }],
      fastestRisers: FASTEST_RISER_PROFILES.slice(0, 8),
    },
  };
}

function buildVersusDrafts(pair, city) {
  const leftName = pair.left.name;
  const rightName = pair.right.name;
  // Neutral comparison hook — never assert the two LOOK similar (some pairs
  // differ visibly by the pair's own facts; an unconditional similarity claim
  // would contradict the card copy).
  const hook = `${leftName} or ${rightName}? Here is how ${city} homeowners can tell the difference.`;
  const leftLine = `${leftName}: ${pair.left.points.map((p) => p.toLowerCase()).join('; ')}.`;
  const rightLine = `${rightName}: ${pair.right.points.map((p) => p.toLowerCase()).join('; ')}.`;
  return {
    facebook: `${hook}\n\n${leftLine}\n${rightLine}\n\n${pair.verdict} Not sure which one you have? A quick inspection settles it.`,
    instagram: `${hook}\n\n${leftLine}\n${rightLine}\n\n${pair.verdict} Which one have you seen around the house?\n\n${hashtags({ topic: `${leftName} vs ${rightName}`, city, service: pair.service })}`,
    linkedin: `Correct pest ID changes the response. ${leftName} vs ${rightName}: ${pair.verdict} ${leftLine} ${rightLine} Waves turns local pest pressure and service data into practical homeowner guidance.`,
    // Both pests' facts: GBP can publish text-only (media retry path), so the
    // post must stand as a comparison without the card.
    gbp: `${city} homeowners: ${leftName.toLowerCase()} or ${rightName.toLowerCase()}? ${pair.verdict} ${leftLine} ${rightLine} ${ctaText('book inspection')}.`,
  };
}

// The "pest showdown" lane: a deterministic X-vs-Y pest ID comparison every 4th
// ET day (offset 2, so it never collides with the review lane's offset 0).
// Pure — no DB — so a selection failure can never block the campaign fallback.
function selectAutonomousVersusPlan(now = new Date()) {
  if (!AUTONOMOUS_FLAGS.includeVersus) return null;
  const { year, month, day } = etParts(now); // Eastern business date (see selectAutonomousCampaign)
  if (day % 4 !== 2) return null;

  // Both rotations advance from a +1-per-FIRE sequence number, never from the
  // raw day: the lane only fires when day % 4 === 2, so indexing by day pinned
  // the city to WAVES_LOCATIONS[2] (Sarasota) forever, and the day's stride of
  // 4 against a 6-pair bank (gcd 2) made only half the pairs reachable in a
  // given month — the same card published up to 3x/month.
  //
  // The count must be of days that actually fire, not a fixed 8 slots per
  // month: fire days are 2/6/10/14/18/22/26/30, so every month has 8 except
  // February (no 30th) with 7. Reserving a phantom February slot skipped a
  // sequence value and broke the cycle — 2026-02-02 and 2026-05-02 both landed
  // on chinch-bug|Sarasota, 23 fires apart instead of the full 24.
  const monthsBefore = (year - VERSUS_SEQ_EPOCH_YEAR) * 12 + (month - 1);
  const februariesBefore = (year - VERSUS_SEQ_EPOCH_YEAR) + (month > 2 ? 1 : 0);
  const seq = monthsBefore * 8 - februariesBefore + Math.floor((day - 2) / 4);

  // Index the FULL bank with a fixed modulus and let an out-of-season slot
  // yield to the (already seasonal) campaign lane. Filtering the bank first
  // would shrink the modulus and shift the survivors' indices at every season
  // boundary, replaying the prior month's cards within days.
  const pair = PEST_VERSUS_PAIRS[seq % PEST_VERSUS_PAIRS.length];
  if (pair.months && !pair.months.includes(month)) return null;
  // The city also advances every fire, phase-shifted one slot per full pair
  // cycle: bare seq % 4 shares a factor with the pair bank (6 then, 24 now),
  // so most pair+city combinations could never occur and identical cards
  // would recur early; the shift walks every pair×city combination (24 pairs
  // × 4 cities = 96 fires, about a year) before any repeat.
  const pairCycle = Math.floor(seq / PEST_VERSUS_PAIRS.length);
  const city = WAVES_LOCATIONS[(seq + pairCycle) % WAVES_LOCATIONS.length]?.name || 'Sarasota';
  const topic = `${pair.left.name} vs ${pair.right.name}`;
  const drafts = buildVersusDrafts(pair, city);
  const channels = AUTONOMOUS_FLAGS.channels;
  return {
    topic,
    city,
    service: pair.service,
    angle: 'pest showdown',
    cta: 'book inspection',
    channels,
    versusPair: pair,
    preview: {
      inputs: { topic, city, service: pair.service, angle: 'pest showdown', cta: 'book inspection', channels },
      // CTA is "schedule an inspection" — the link (Facebook + GBP LEARN_MORE)
      // must land on the booking flow, not the blog index.
      suggestedLink: 'https://www.wavespestcontrol.com/book/',
      drafts: Object.fromEntries(channels.map((channel) => [channel, drafts[channel]]).filter(([, text]) => text)),
      validation: validateDrafts(drafts),
      sources: [{
        type: 'versus_pair',
        label: topic,
        detail: `${pair.verdict} ${pair.left.name}: ${pair.left.points.join('; ')}. ${pair.right.name}: ${pair.right.points.join('; ')}.`,
      }],
      fastestRisers: FASTEST_RISER_PROFILES.slice(0, 8),
    },
  };
}

// Approval-time counterpart of the selection months gate (same posture as
// milestonePublishBlocker): a versus draft can sit in the queue past its
// pair's season window, and publishing it then is exactly the stale
// off-season content the gate exists to prevent. Null = publishable.
//
// Seasonality is resolved from the CANONICAL bank by key, never from the
// stored pair: run.input is a JSON snapshot frozen at selection, so a draft
// created before `months` existed carries a pair object without it, and
// trusting that snapshot would wave an off-season card straight through.
// Keying off the bank also means editing a pair's season applies to drafts
// already queued.
function versusPublishBlocker(input, now = new Date()) {
  const key = input?.versusPair?.key;
  if (!key) return null;
  const months = PEST_VERSUS_PAIRS.find((p) => p.key === key)?.months;
  if (!Array.isArray(months) || !months.length) return null;
  if (months.includes(etParts(now).month)) return null;
  return 'versus pair is out of season — reject this draft so the lane can regenerate';
}

// ── Review-count milestone lane ─────────────────────────────────────────────
// Celebrates crossing a round Google-review count (the single best-engaging
// organic format for local service brands). Company-wide count from Google's
// own per-location totals (see fleetReviewStats); fires ONCE per threshold and
// only while the count is within MILESTONE_WINDOW of it, so a lane enabled
// long after a threshold passed never posts a stale "we just hit 250".

const MILESTONE_ANGLE = 'review milestone';
const MILESTONE_WINDOW = 30;

// Highest ladder rung <= count: every 50 to 500, 250s to 2,000, 500s to
// 5,000, then every 1,000. Returns null below the first rung.
function milestoneThresholdFor(count) {
  const n = Math.floor(Number(count) || 0);
  if (n < 50) return null;
  if (n < 500) return Math.floor(n / 50) * 50;
  if (n < 2000) return Math.floor(n / 250) * 250;
  if (n < 5000) return Math.floor(n / 500) * 500;
  return Math.floor(n / 1000) * 1000;
}

// Authoritative count = Google's own per-location totals, which the Places
// stats sync stores as one '_stats' pseudo-row per location (review_text =
// {rating, totalReviews}). Same completeness/freshness rule as the admin
// dashboard and the BI review tool: EVERY configured location must have a
// row synced inside 24h with a finite totalReviews, else the snapshot is
// partial and this returns null — a public milestone claim never falls back
// to counting synced rows (incomplete, duplicable, may include retired
// locations). Rating = location ratings WEIGHTED by their review counts —
// stricter than the dashboard's simple mean, because this number is
// published: a 10-review 5.0 location must not lift a 300-review 4.6.
const STATS_FRESH_MS = 24 * 60 * 60 * 1000;

function fleetReviewStats(statsRows, locations = WAVES_LOCATIONS, now = Date.now()) {
  const fresh = {};
  for (const row of statsRows || []) {
    const t = new Date(row.synced_at).getTime();
    if (!(t > 0 && now - t <= STATS_FRESH_MS)) continue;
    try {
      const p = JSON.parse(row.review_text);
      if (p && typeof p === 'object' && Number.isFinite(p.totalReviews)) fresh[row.location_id] = p;
    } catch { /* unparseable stats payload — location stays incomplete */ }
  }
  if (!locations.length || !locations.every((loc) => fresh[loc.id])) return null;
  let count = 0;
  let weightedSum = 0;
  let weight = 0;
  let ratingComplete = true;
  for (const loc of locations) {
    const p = fresh[loc.id];
    count += p.totalReviews;
    if (p.totalReviews <= 0) continue; // zero-review location: no rating needed
    if (Number.isFinite(p.rating) && p.rating > 0) {
      weightedSum += p.rating * p.totalReviews;
      weight += p.totalReviews;
    } else {
      // Reviews exist but Google gave no rating: the fleet average would
      // describe only the other locations — publish no average at all.
      ratingComplete = false;
    }
  }
  if (count <= 0) return null;
  return { count, average: ratingComplete && weight ? Math.round((weightedSum / weight) * 10) / 10 : null };
}

async function reviewMilestoneStats() {
  if (!(await hasTable('google_reviews'))) return null;
  try {
    const rows = await db('google_reviews')
      .where({ reviewer_name: '_stats' })
      .whereIn('location_id', WAVES_LOCATIONS.map((loc) => loc.id))
      .select('location_id', 'review_text', 'synced_at');
    return fleetReviewStats(rows);
  } catch {
    return null;
  }
}

// Durable milestone ownership, independent of the run row. Written as
// 'claimed' under the fleet-stats leases BEFORE the external post and
// upgraded to 'published' after it — so neither an onFirstPlatformSuccess
// hook failure nor an audit-update crash that leaves the run 'failed' can
// let the next tick celebrate the same threshold again. Cleared only when
// the publish produced ZERO provider successes (nothing is live), so the
// threshold becomes selectable again for a retry.
function milestoneStampKey(threshold) {
  return `social.milestone.celebrated.${threshold}`;
}

// Insert-ONLY acquisition (never overwrites another run's stamp):
//   'acquired' — this run now owns the threshold
//   'owned'    — this run already owns it (a retry of the same run)
//   'other'    — another run owns it → caller must block
async function claimMilestone(threshold, runId) {
  const now = new Date();
  const value = JSON.stringify({ threshold, runId: runId || null, state: 'claimed', at: now.toISOString() });
  const inserted = await db('system_settings')
    .insert({
      key: milestoneStampKey(threshold),
      value,
      category: 'social',
      description: `Google review milestone ${threshold} celebrated on social`,
      created_at: now,
      updated_at: now,
    })
    .onConflict('key')
    .ignore()
    .returning('key');
  if (inserted.length) return 'acquired';
  const row = await db('system_settings').where({ key: milestoneStampKey(threshold) }).first('value');
  const parsed = toJson(row?.value, {});
  return parsed?.runId && runId && parsed.runId === runId ? 'owned' : 'other';
}

// Upgrade claimed → published, only by the owning run.
async function markMilestonePublished(threshold, runId) {
  const key = milestoneStampKey(threshold);
  const row = await db('system_settings').where({ key }).first('value');
  const parsed = toJson(row?.value, {});
  if (!row || (parsed?.runId && runId && parsed.runId !== runId)) return;
  const now = new Date();
  await db('system_settings')
    .where({ key })
    .update({ value: JSON.stringify({ ...parsed, state: 'published', publishedAt: now.toISOString() }), updated_at: now });
}

async function clearMilestoneStamp(threshold, runId) {
  const row = await db('system_settings').where({ key: milestoneStampKey(threshold) }).first('value').catch(() => null);
  if (!row) return;
  const parsed = toJson(row.value, {});
  // Only the owning run may release its own claim.
  if (parsed?.runId && runId && parsed.runId !== runId) return;
  await db('system_settings').where({ key: milestoneStampKey(threshold) }).del();
}

// A threshold is claimed by the durable stamp above (any state — it is the
// authority for "a post is or may be live"), by a published run, by an
// approval-queue draft, or by a RECENT in-flight 'started' row. 'started'
// is bounded: the stamp is written before any provider call, so a stale
// unstamped 'started' row (process crash between insert and stamp) cannot
// represent a live post and must not park the threshold until the next rung.
const MILESTONE_INFLIGHT_MS = 2 * 60 * 60 * 1000;

async function milestoneAlreadyClaimed(threshold) {
  if (!(await hasTable('social_content_studio_runs'))) return true;
  // Fail CLOSED: if the stamp can't be read, treat the threshold as claimed —
  // a missed celebration is recoverable, a duplicate one is not.
  const stamped = await db('system_settings')
    .where({ key: milestoneStampKey(threshold) })
    .first('key')
    .catch(() => ({ unreadable: true }));
  if (stamped) return true;
  const inflightSince = new Date(Date.now() - MILESTONE_INFLIGHT_MS);
  const row = await db('social_content_studio_runs')
    .where({ run_type: 'autonomous', angle: MILESTONE_ANGLE })
    .whereRaw("input->>'milestone' = ?", [String(threshold)])
    .where((qb) => qb
      .whereIn('status', ['published', 'draft_created'])
      .orWhere((q) => q.where('status', 'started').andWhere('started_at', '>', inflightSince)))
    .first('id');
  return !!row;
}

// Copy states only what the snapshot proves: a count and a rating. No
// claims about who wrote the reviews (residents/homeowners/customers) and
// no recency ("just passed") — the window bounds the count, not the date.
function buildMilestoneDrafts({ threshold, average }) {
  const n = threshold.toLocaleString('en-US');
  const avgLine = average ? `Average rating: ${average.toFixed(1)} stars. ` : '';
  return {
    facebook: `${n} Google reviews. Thank you, Southwest Florida.\n\n${avgLine}We read every one, and they shape how we work.\n\nTo everyone who took a minute to share their experience: thank you.`,
    instagram: `${n} Google reviews. Thank you, Southwest Florida.\n\n${avgLine}We read every one, and they shape how we work.\n\n#wavespestcontrol #swfl #googlereviews #thankyou`,
    linkedin: `Waves Pest Control has reached ${n} Google reviews. ${avgLine}A small local team, one visit at a time. Thank you to everyone who took the time to share their experience.`,
    gbp: `${n} Google reviews and counting. Thank you to everyone in Southwest Florida who took a minute to share their experience. ${avgLine}We read every one.`,
  };
}

// Pure plan builder (DB-free) — selection reads stats + claims, then hands
// off here so the copy/preview shape is unit-testable.
function planMilestone({ threshold, count, average, city, channels }) {
  const topic = `${threshold.toLocaleString('en-US')} Google reviews`;
  const drafts = buildMilestoneDrafts({ threshold, average });
  return {
    topic,
    city,
    service: 'review proof',
    angle: MILESTONE_ANGLE,
    cta: 'read guide',
    channels,
    milestone: threshold,
    reviewCount: count,
    averageRating: average,
    preview: {
      inputs: { topic, city, service: 'review proof', angle: MILESTONE_ANGLE, cta: 'read guide', channels },
      suggestedLink: 'https://www.wavespestcontrol.com/pest-control-reviews/',
      drafts: Object.fromEntries(channels.map((channel) => [channel, drafts[channel]]).filter(([, text]) => text)),
      validation: validateDrafts(drafts),
      sources: [{
        type: 'google_review_count',
        label: `${count} Google-reported reviews across all locations (fresh Places snapshot)`,
        detail: average ? `Average star rating ${average.toFixed(1)}; milestone threshold ${threshold}.` : `Milestone threshold ${threshold}.`,
      }],
      fastestRisers: FASTEST_RISER_PROFILES.slice(0, 8),
    },
  };
}

// Why a stored milestone plan may no longer be publishable: the count fell
// below the rung (reviews removed), advanced past the window (a stale
// "we just hit 300"), or the average the copy states has drifted. Pure —
// returns the reason string, or null when the plan still matches reality.
function milestoneDrift(plan, stats) {
  if (!stats) return 'review stats unavailable — milestone publish blocked';
  const threshold = Number(plan?.milestone);
  if (milestoneThresholdFor(stats.count) !== threshold) {
    return `review count is now ${stats.count}; the ${threshold} milestone no longer matches — reject this draft so the lane can regenerate`;
  }
  if (stats.count - threshold >= MILESTONE_WINDOW) {
    return `review count (${stats.count}) has moved past the ${threshold} milestone window — reject this draft so the lane can regenerate`;
  }
  const stated = plan?.averageRating == null ? null : Number(plan.averageRating);
  if ((stated ?? null) !== (stats.average ?? null)) {
    return `average rating changed (${stated ?? 'n/a'} → ${stats.average ?? 'n/a'}) since the copy was written — reject this draft so the lane can regenerate`;
  }
  return null;
}

// Re-read stats immediately before publication (direct run) or approval
// (draft) — the plan was built earlier and reviews/ratings move.
async function milestonePublishBlocker(plan) {
  return milestoneDrift(plan, await reviewMilestoneStats());
}

async function selectAutonomousMilestonePlan(now = new Date()) {
  if (!AUTONOMOUS_FLAGS.includeMilestones) return null;
  const stats = await reviewMilestoneStats();
  if (!stats) return null;
  const threshold = milestoneThresholdFor(stats.count);
  if (!threshold || stats.count - threshold >= MILESTONE_WINDOW) return null;
  if (await milestoneAlreadyClaimed(threshold)) return null;
  const { day } = etParts(now); // GBP location rotation only — the copy is company-wide
  const city = WAVES_LOCATIONS[day % WAVES_LOCATIONS.length]?.name || 'Sarasota';
  return planMilestone({
    threshold,
    count: stats.count,
    average: stats.average,
    city,
    channels: AUTONOMOUS_FLAGS.channels,
  });
}

async function selectAutonomousPlan(now = new Date()) {
  // One-shot celebration outranks the recurring lanes on the day it fires.
  const milestonePlan = await selectAutonomousMilestonePlan(now);
  if (milestonePlan) return milestonePlan;

  const reviewPlan = await selectAutonomousReviewPlan(now);
  if (reviewPlan) return reviewPlan;

  const versusPlan = selectAutonomousVersusPlan(now);
  if (versusPlan) return versusPlan;

  const input = selectAutonomousCampaign(now, { recent: await recentCampaignCards() });
  const preview = await previewCampaign(input);
  return {
    ...input,
    preview,
  };
}

function ctaText(cta) {
  const key = cleanText(cta, 80).toLowerCase();
  if (key.includes('guide')) return 'Read the local guide';
  if (key.includes('estimate')) return 'Request an estimate';
  if (key.includes('call')) return 'Use the call button to reach Waves';
  return 'Schedule an inspection';
}

function angleHook({ topic, city, angle }) {
  const topicLabel = cleanText(topic, 100) || 'pest pressure';
  const cityLabel = cleanText(city, 80) || 'SWFL';
  const key = cleanText(angle, 80).toLowerCase();
  if (key.includes('sign')) return `${cityLabel} homeowners: here is what to check before this becomes a bigger ${topicLabel} problem.`;
  if (key.includes('myth')) return `Myth check: ${topicLabel} in ${cityLabel} is not just a one-day nuisance.`;
  if (key.includes('new')) return `New to Florida? ${topicLabel} in ${cityLabel} catches a lot of homeowners off guard.`;
  if (key.includes('seeing')) return `Here is what we are watching around ${cityLabel}: ${topicLabel}.`;
  return `${titleCase(topicLabel)} is showing up around ${cityLabel}.`;
}

function hashtags({ topic, city, service }) {
  const tags = ['#wavespestcontrol'];
  const cityKey = cleanText(city).toLowerCase().replace(/[^a-z]/g, '');
  if (cityKey.includes('sarasota')) tags.push('#sarasotafl');
  else if (cityKey.includes('bradenton')) tags.push('#bradentonfl');
  else if (cityKey.includes('venice')) tags.push('#venicefl');
  else tags.push('#swfl');

  const text = `${topic} ${service}`.toLowerCase();
  if (text.includes('termite')) tags.push('#termites');
  else if (text.includes('chinch')) tags.push('#chinchbugs', '#staugustinegrass');
  else if (text.includes('mosquito')) tags.push('#mosquitocontrol');
  else if (text.includes('lawn')) tags.push('#lawncare');
  else tags.push('#pestcontrol');

  return tags.slice(0, 5).join(' ');
}

const SERVICE_INTENT_KEYWORDS = [
  { match: ['lawn', 'turf', 'grass', 'weed', 'fungus', 'fertilizer', 'fertilize', 'fertilizing', 'fertilization', 'chinch', 'st. augustine'] },
  { match: ['termite', 'swarm', 'swarming', 'wdo', 'wood destroying'] },
  { match: ['mosquito', 'standing water'] },
  // No-see-ums are a separate service contract (covered only when named —
  // estimate-service-details.js), so their intent never pulls mosquito pages.
  { match: ['no-see-um', 'no-see-ums', 'biting midge', 'biting midges'] },
  { match: ['rodent', 'rat', 'rats', 'mouse', 'mice'] },
  { match: ['roach', 'cockroach', 'palmetto bug'] },
  { match: ['ant', 'ants'] },
  { match: ['flea', 'fleas'] },
  { match: ['bed bug', 'bedbug'] },
  { match: ['spider', 'spiders', 'black widow', 'brown widow'] },
  { match: ['wasp', 'hornet', 'yellow jacket', 'yellowjacket', 'bee', 'bees'] },
  // Mud daubers stand alone: the August "mud daubers on the lanai ceiling"
  // topic asks for a guide, and a yellowjacket or bee page is not that guide.
  { match: ['mud dauber', 'dirt dauber'] },
  { match: ['silverfish', 'earwig', 'millipede', 'centipede', 'springtail'] },
  { match: ['tree', 'shrub', 'ornamental', 'palm', 'tree and shrub', 'tree & shrub', 'whitefly', 'scale insect', 'mealybug', 'sooty mold'] },
];

// Boundary-aware keyword test shared by the requested topic/service and the
// content rows: whole words plus the English PLURAL only ('ant' → ant, ants,
// ant-proof; 'roach' → roaches; 'mosquito' → mosquitoes) — never bare
// substrings ('important' is not an ant campaign; 'plant' is not) and never
// derivational suffixes ('top rated' / 'five-star rating' / 'our rates' are
// not a rodent campaign). Stems that need other forms list them explicitly
// (fertilizer/fertilizing/fertilization, swarming).
function intentPluralSuffix(kw) {
  return /(?:[sxzo]|ch|sh)$/.test(kw) ? '(?:s|es)?' : 's?';
}
function textHasIntentKeyword(text, kw) {
  const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}${intentPluralSuffix(kw)}\\b`).test(text);
}

function serviceIntentKeywords(input = {}) {
  const requested = `${input.service || ''} ${input.topic || ''}`.toLowerCase();
  const matches = SERVICE_INTENT_KEYWORDS
    .filter((group) => group.match.some((keyword) => textHasIntentKeyword(requested, keyword)))
    .flatMap((group) => group.match);
  return Array.from(new Set(matches));
}

function serviceRowMatchesIntent(row = {}, input = {}) {
  const keywords = serviceIntentKeywords(input);
  if (!keywords.length) return false;
  const text = [
    row.name,
    row.short_name,
    row.service_key,
    row.description,
    row.category,
    row.subcategory,
  ].map((value) => String(value || '').toLowerCase()).join(' ');
  return keywords.some((keyword) => text.includes(keyword));
}

function relevantServices(context = {}, input = {}) {
  const services = Array.isArray(context.services) ? context.services : [];
  const matches = services.filter((service) => serviceRowMatchesIntent(service, input));
  return matches.length ? matches : [];
}

function sourceFacts(context, input = {}) {
  const targetCity = context?.location?.city || input.city;
  const serviceFact = firstSentence(relevantServices(context, input)[0]?.description);
  const contentFact = firstSentence(context.content[0]?.meta_description || context.content[0]?.title);
  const pestPressureFact = firstSentence(context.pestPressure?.explanation);
  const reviewFact = firstSentence(context.reviews[0]?.review_text, 160);
  return [serviceFact, contentFact, pestPressureFact, reviewFact]
    .filter(Boolean)
    // Review text and brand-wide sources can name any city regardless of the
    // row-level filters — drop cross-city facts rather than publish them.
    .filter((fact) => !mentionsOtherCity(fact, targetCity));
}

function buildCampaignDrafts(input, context) {
  const city = context.location.city || cleanText(input.city, 80) || 'SWFL';
  const topic = cleanText(input.topic, 120) || 'seasonal pest pressure';
  const matchedService = relevantServices(context, input)[0];
  const serviceLabel = matchedService?.short_name || matchedService?.name || titleCase(input.service || 'pest control');
  const hook = angleHook({ topic, city, angle: input.angle });
  const facts = sourceFacts(context, input);
  const fact = facts[0] || `${serviceLabel} problems usually build where food, water, shelter, or weather pressure line up.`;
  const secondFact = facts[1] || 'A quick inspection can separate normal seasonal activity from a problem that needs treatment.';
  const cta = ctaText(input.cta);

  const drafts = {
    facebook: `${hook}\n\n${fact} ${secondFact}\n\n${cta}.`,
    instagram: `${hook}\n\n${fact} ${secondFact}\n\nWhat are you seeing around the house this week?\n\n${hashtags({ topic, city, service: input.service })}`,
    linkedin: `${titleCase(serviceLabel)} demand is seasonal in ${city}. ${fact} Waves is turning local pest pressure, field notes, and service data into practical homeowner guidance.`,
    gbp: `${city} homeowners: ${topic} can move fast when weather and property conditions line up. ${fact} ${cta}.`,
  };

  const selected = normalizeChannels(input.channels);
  return Object.fromEntries(selected.map((channel) => [channel, drafts[channel]]));
}

function validateDrafts(drafts) {
  return Object.fromEntries(Object.entries(drafts).map(([platform, text]) => [platform, validateContent(text, platform)]));
}

function buildSourcePanel(context, input = {}) {
  const rows = [];
  for (const service of relevantServices(context, input).slice(0, 4)) {
    rows.push({
      type: 'service',
      label: service.name,
      detail: firstSentence(service.description, 180),
    });
  }
  for (const item of context.content.slice(0, 4)) {
    rows.push({
      type: 'content',
      label: item.title,
      detail: [item.city, item.tag, item.status].filter(Boolean).join(' | '),
    });
  }
  for (const post of context.recentSocials.slice(0, 3)) {
    rows.push({
      type: 'recent_social',
      label: post.title,
      detail: [post.source_type, post.status].filter(Boolean).join(' | '),
    });
  }
  if (context.pestPressure?.explanation) {
    rows.push({
      type: 'pest_pressure',
      label: 'Pest pressure definition',
      detail: firstSentence(context.pestPressure.explanation, 220),
    });
  }
  for (const pattern of context.competitorPatterns.slice(0, 3)) {
    rows.push({
      type: 'competitor_pattern',
      label: pattern.label,
      detail: pattern.copyablePattern,
    });
  }
  return rows;
}

// Grounded fact pack for AI copy — the same context buildCampaignDrafts draws
// from, as a short bullet list the model may use (and must not exceed/invent
// beyond). Keeps the AI captions factual and local.
function campaignFactPack(context, input) {
  const targetCity = context?.location?.city || input?.city;
  const lines = [];
  const svc = relevantServices(context, input)[0];
  if (svc?.description) lines.push(svc.description);
  for (const f of (sourceFacts(context, input) || [])) lines.push(f);
  if (context?.pestPressure?.explanation) lines.push(context.pestPressure.explanation);
  return Array.from(new Set(lines.map((l) => cleanText(l, 400)).filter(Boolean)))
    // sourceFacts is already scrubbed; this catches the two lines pushed
    // directly (full service description, pest-pressure explanation).
    .filter((l) => !mentionsOtherCity(l, targetCity))
    .slice(0, 6)
    .map((l) => `- ${l}`)
    .join('\n');
}

// Brand-voice AI drafts grounded in the campaign context. Per-channel fall back
// to the deterministic template, so a Claude outage/invalid output never blocks
// a post and the copy is always present + length-valid.
async function buildCampaignDraftsAI(input, context) {
  const template = buildCampaignDrafts(input, context);
  try {
    if (typeof SocialMediaService.generateCampaignDrafts !== 'function' || !process.env.ANTHROPIC_API_KEY) {
      return template;
    }
    const channels = normalizeChannels(input.channels);
    if (!channels.length) return template;
    const svc = relevantServices(context, input)[0];
    const ai = await SocialMediaService.generateCampaignDrafts({
      topic: cleanText(input.topic, 200),
      facts: campaignFactPack(context, input),
      cta: ctaText(input.cta),
      city: context?.location?.city || input.city,
      service: svc?.name || svc?.short_name || input.service,
      channels,
    });
    const out = { ...template };
    const targetCity = context?.location?.city || input.city;
    // Belt and suspenders: even with a city-scrubbed fact pack the model can
    // still name a stray city. A cross-city draft falls back to the
    // (city-clean) template for that channel instead of publishing mixed-city
    // copy — the 07-03 live failure this grounding exists to prevent.
    for (const ch of channels) if (ai && ai[ch] && !mentionsOtherCity(ai[ch], targetCity)) out[ch] = ai[ch];
    return out;
  } catch {
    return template;
  }
}

async function previewCampaign(input) {
  const context = await getCampaignContext(input);
  const drafts = await buildCampaignDraftsAI(input, context);
  return {
    inputs: {
      topic: cleanText(input.topic, 120),
      city: context.location.city,
      locationId: context.location.id,
      service: cleanText(input.service, 120),
      angle: cleanText(input.angle, 80),
      cta: cleanText(input.cta, 80),
      channels: normalizeChannels(input.channels),
    },
    suggestedLink: suggestedLink(context),
    suggestedLinkTitle: suggestedLinkTitle(context),
    drafts,
    validation: validateDrafts(drafts),
    sources: buildSourcePanel(context, input),
    fastestRisers: context.fastestRisers,
  };
}

async function saveCampaignDraft(input) {
  if (!(await hasTable('social_media_posts'))) {
    throw new Error('social_media_posts table is not available');
  }
  const preview = input.preview || await previewCampaign(input);
  // image_url is persisted then rendered as <a href>/<img src> in the admin UI,
  // and both input.imageUrl and a caller-supplied preview.visual.imageUrl reach
  // here from req.body — so validate each to http(s) before trusting it, falling
  // back to the freshly rendered card (an https S3/CDN URL).
  const imageUrl = httpUrlOrNull(input.imageUrl)
    || httpUrlOrNull(preview.visual?.imageUrl)
    || await renderCampaignImageUrl(input, preview);
  // Preserve an existing visual's identity (photo-card runs pass a preview that
  // already carries variant/templateKey/creative/variants for the approval
  // queue) — only default the legacy campaign card when nothing is set.
  // previewWithVisual REPLACES preview.visual, so the run's GBP image and its
  // watermark provenance (gbpImageBranded:false = hero PHOTO, postToGBP
  // watermarks on approval) must be forwarded or the approved draft posts
  // GBP text-only / unwatermarked. gbpImageUrl can arrive from req.body —
  // validate it like imageUrl.
  const finalPreview = previewWithVisual(preview, {
    imageUrl,
    gbpImageUrl: httpUrlOrNull(preview.visual?.gbpImageUrl),
    gbpImageBranded: preview.visual?.gbpImageBranded,
    variant: preview.visual?.variant || 'campaign',
    templateKey: preview.visual?.templateKey || 'waves_campaign_square',
    creative: preview.visual?.creative,
    variants: preview.visual?.variants,
  });
  const title = cleanText(input.title || `${preview.inputs.city}: ${preview.inputs.topic}`, 180);
  const [post] = await db('social_media_posts')
    .insert({
      title,
      description: cleanText(input.description || preview.inputs.service || preview.inputs.topic, 1000),
      // normalizeUrl canonicalizes (forces https, strips UTM) but its catch
      // fallback passes non-URL junk through and doesn't reject javascript:/
      // data: schemes — and source_url is later rendered as an admin link. Gate
      // the normalized value through httpUrlOrNull so only http(s) is stored.
      source_url: httpUrlOrNull(normalizeUrl(input.link || preview.suggestedLink)),
      source_guid: `campaign_builder_${Date.now()}`,
      source_type: 'campaign_builder',
      platforms_posted: JSON.stringify(preview.inputs.channels || Object.keys(preview.drafts || {})),
      image_url: imageUrl || null,
      status: 'draft',
      publish_status: 'pending',
      custom_content: JSON.stringify(finalPreview.drafts || {}),
      published_content: JSON.stringify(finalPreview.drafts || {}),
      ai_model: 'template:v1',
      created_at: new Date(),
    })
    .returning('*');
  return { post, preview: finalPreview };
}

async function autonomousStatus() {
  const latest = await latestAutonomousRun();
  return {
    enabled: AUTONOMOUS_FLAGS.enabled,
    globalAutomationEnabled: SOCIAL_FLAGS.automationEnabled,
    paused: await isPausedByAdmin(),
    dryRun: SOCIAL_FLAGS.dryRun,
    mode: AUTONOMOUS_FLAGS.mode,
    intervalHours: AUTONOMOUS_FLAGS.intervalHours,
    channels: AUTONOMOUS_FLAGS.channels,
    includeReviews: AUTONOMOUS_FLAGS.includeReviews,
    latestRun: latest,
  };
}

function platformResultsFrom(runResult, postPlatforms) {
  if (Array.isArray(runResult?.platforms)) return runResult.platforms;
  if (Array.isArray(runResult?.results)) return runResult.results;
  if (Array.isArray(postPlatforms) && postPlatforms.some((item) => item && typeof item === 'object')) {
    return postPlatforms;
  }
  return [];
}

function serializeAutonomousRun(row = {}) {
  const input = toJson(row.input, {});
  const preview = toJson(row.preview, {});
  const publishResult = toJson(row.publish_result || row.publishResult, {});
  const postPlatforms = toJson(row.post_platforms_posted, []);
  const platformResults = platformResultsFrom(publishResult, postPlatforms);
  const previewInputs = preview.inputs || {};
  const rowChannels = toJson(row.channels, []);
  const channels = Array.from(new Set(normalizeChannels([
    ...(Array.isArray(rowChannels) ? rowChannels : []),
    ...(Array.isArray(input.channels) ? input.channels : []),
    ...(Array.isArray(previewInputs.channels) ? previewInputs.channels : []),
    ...platformResults.map((item) => item?.platform),
  ])));
  const socialMediaPostId = row.social_media_post_id || row.post_id || null;
  const imageUrl = cleanText(
    preview.visual?.imageUrl ||
    publishResult.imageUrl ||
    publishResult.draftImageUrl ||
    row.post_image_url,
    1000
  ) || null;

  return {
    id: row.id || null,
    runType: row.run_type || 'autonomous',
    status: row.status || 'unknown',
    mode: row.mode || input.mode || null,
    topic: row.topic || input.topic || previewInputs.topic || null,
    city: row.city || input.city || previewInputs.city || null,
    service: row.service || input.service || previewInputs.service || null,
    angle: row.angle || input.angle || previewInputs.angle || null,
    channels,
    input,
    preview,
    publishResult,
    platformResults,
    imageUrl,
    skipReason: row.skip_reason || null,
    socialMediaPostId,
    startedAt: row.started_at || null,
    finishedAt: row.finished_at || null,
    createdAt: row.created_at || null,
    updatedAt: row.updated_at || null,
    post: socialMediaPostId ? {
      id: socialMediaPostId,
      title: row.post_title || null,
      status: row.post_status || null,
      publishStatus: row.post_publish_status || null,
      sourceUrl: row.post_source_url || null,
      imageUrl: row.post_image_url || null,
      createdAt: row.post_created_at || null,
    } : null,
  };
}

async function listAutonomousRuns({ limit = 30 } = {}) {
  if (!(await hasTable('social_content_studio_runs'))) return { runs: [] };
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));
  const rows = await db('social_content_studio_runs as r')
    .leftJoin('social_media_posts as p', 'p.id', 'r.social_media_post_id')
    .where('r.run_type', 'autonomous')
    .select(
      'r.*',
      'p.id as post_id',
      'p.title as post_title',
      'p.status as post_status',
      'p.publish_status as post_publish_status',
      'p.source_url as post_source_url',
      'p.image_url as post_image_url',
      'p.platforms_posted as post_platforms_posted',
      'p.created_at as post_created_at'
    )
    .orderBy('r.started_at', 'desc')
    .limit(safeLimit);

  return {
    runs: rows.map((row) => serializeAutonomousRun(row)),
  };
}

function hasValidationFailure(preview) {
  return Object.entries(preview?.validation || {})
    .filter(([platform]) => (preview?.inputs?.channels || CHANNELS).includes(platform))
    .flatMap(([, result]) => result?.issues || [])
    .filter(Boolean);
}

// Serialize the whole run behind a Postgres advisory lock: the cadence guard
// reads-then-writes and then calls external Meta/GBP APIs, so without this two
// concurrent triggers (double force-clicks, overlapping pods) could each pass
// the guard and double-post. If the lease is held elsewhere, this tick skips.
async function runAutonomous(opts = {}) {
  return runExclusive('social_autonomous_studio', () => runAutonomousLocked(opts));
}

async function runAutonomousLocked({ force = false, mode } = {}) {
  const startedAt = new Date();
  // Omitted → env default; an explicit but invalid mode fails closed to draft.
  const effectiveMode = mode == null || String(mode).trim() === ''
    ? AUTONOMOUS_FLAGS.mode
    : normalizePublishMode(mode, AUTONOMOUS_FLAGS.mode);

  // The studio-enable flag is the feature kill switch and is ALWAYS enforced —
  // even an admin "Run Draft/Run Publish" (force:true). force only bypasses the
  // cadence guard below, so a dark feature can't publish just because global
  // social automation happens to be on.
  if (!AUTONOMOUS_FLAGS.enabled) {
    await logAutonomousSkip('SOCIAL_AUTONOMOUS_STUDIO_ENABLED is not true');
    return { skipped: true, reason: 'SOCIAL_AUTONOMOUS_STUDIO_ENABLED is not true' };
  }
  if (!SOCIAL_FLAGS.automationEnabled) {
    await logAutonomousSkip('SOCIAL_AUTOMATION_ENABLED is not true');
    return { skipped: true, reason: 'SOCIAL_AUTOMATION_ENABLED is not true' };
  }
  if (await isPausedByAdmin()) {
    await logAutonomousSkip('social automation is paused by admin');
    return { skipped: true, reason: 'social automation is paused by admin' };
  }

  // Fail closed if the audit/cadence table is missing. latestAutonomousRun()
  // and insertAutonomousRun() both no-op when social_content_studio_runs is
  // absent, so without this the cadence guard would see "no prior run" on every
  // tick and the hourly cron would publish each fire with no throttle and no
  // audit trail. Require the table before selecting/rendering/publishing.
  if (!(await hasTable('social_content_studio_runs'))) {
    return { skipped: true, reason: 'social_content_studio_runs table is unavailable' };
  }

  if (!force) {
    const latest = await latestAutonomousClaim();
    if (latest?.started_at) {
      const elapsedHours = (startedAt.getTime() - new Date(latest.started_at).getTime()) / 36e5;
      if (elapsedHours < AUTONOMOUS_FLAGS.intervalHours) {
        const reason = `cadence guard: ${elapsedHours.toFixed(1)}h since last autonomous run (status=${latest.status})`;
        return { skipped: true, reason, latestRun: latest };
      }
    }
  }

  const plan = await selectAutonomousPlan(startedAt);
  const run = await insertAutonomousRun({
    status: 'started',
    mode: effectiveMode,
    topic: plan.topic,
    city: plan.city,
    service: plan.service,
    angle: plan.angle,
    channels: plan.channels,
    input: plan,
    startedAt,
  });

  try {
    const preview = plan.preview || await previewCampaign(plan);
    const validationIssues = hasValidationFailure(preview);
    if (validationIssues.length) {
      const reason = `validation failed: ${validationIssues[0]}`;
      await updateAutonomousRun(run?.id, {
        status: 'failed',
        preview,
        skipReason: reason,
      });
      return { success: false, skipped: true, reason, preview };
    }

    let imageUrl = null;
    let gbpImageUrl = null;
    let finalPreview = preview;
    const wantsGbp = Array.isArray(plan.channels) && plan.channels.includes('gbp');
    // Liveness protection derives from the source review id ALONE: hasTable
    // swallows transient schema-lookup failures as false, and letting it
    // into this classification reclassified a testimonial as an ordinary
    // campaign — skipping every source-liveness check on the publish path.
    // The fallible schema gate only decides whether the graphic can be
    // PERSISTED after a successful publish.
    // Every run kind (review / versus / milestone / campaign) takes the
    // creative engine (owner ruling 2026-09-06: the fixed SVG card reads as
    // the "old post"); RUN_KINDS carries each kind's overlay, card renderer,
    // and template keys. GBP still gets the deterministic card (no AI imagery).
    const kind = runKindFor(plan);
    const isReviewRun = kind === RUN_KINDS.review;
    const isVersusRun = kind === RUN_KINDS.versus;
    const isMilestoneRun = kind === RUN_KINDS.milestone;
    const isCampaignRun = kind === RUN_KINDS.campaign;
    const canPersistGraphic = isReviewRun && await hasTable('review_graphics');

    // Creative engine first (AI photo scene + deterministic brand overlay,
    // gated by SOCIAL_CREATIVE_ENGINE_ENABLED). An empty result — engine off,
    // provider outage, upload failure — falls through to the legacy SVG brand
    // card below, so the engine can only ever upgrade a post, never block one.
    // GBP never posts AI imagery (owner rule): creative variants are AI photo
    // scenes, so the engine is asked for no GBP (4:3) scene at all — GBP takes
    // the deterministic card render below, same as the non-creative branches.
    // A GBP-ONLY run skips the engine entirely: nothing would consume the
    // square scenes, so generating them just burns paid image credits. For
    // an immediate publish, additionally require at least one non-GBP
    // channel to be actually publish-ready (creds/flags present) — otherwise
    // publishToAll skips Meta and every generated asset is discarded. Draft
    // runs keep generating regardless of readiness: their variants are the
    // approval queue's content and publish later, when readiness may differ.
    const hasNonGbpChannel = Array.isArray(plan.channels)
      && plan.channels.some((c) => c !== 'gbp');
    let creativeEligible = hasNonGbpChannel;
    if (creativeEligible && effectiveMode !== 'draft') {
      creativeEligible = false;
      for (const ch of plan.channels) {
        if (ch === 'gbp') continue;
         
        const readiness = await SocialMediaService.assertSocialPublishingReady(ch);
        if (readiness.ready) { creativeEligible = true; break; }
      }
    }
    const creativeVariants = creativeEligible
      ? await creativeVariantsForRun(plan, preview, {
        kind, wantsGbp: false, effectiveMode, now: startedAt,
      })
      : [];
    // Campaign runs with a live page attached use that page's hero photo
    // wherever a deterministic visual is needed (GBP under the creative
    // engine, and the whole post when the engine is off/failed) — the legacy
    // fixed SVG card is the last resort, and every publish that lands on it
    // is emailed as a FIX:.
    // Resolved lazily — the fetch + CDN upload only happens on a branch that
    // will actually consume it (creative Meta image + no GBP would otherwise
    // orphan an S3 object every run).
    let campaignHeroUrl = null;
    const resolveCampaignHero = async () => {
      if (isCampaignRun && campaignHeroUrl === null) {
        campaignHeroUrl = (await heroImageForLink(finalPreview.suggestedLink)) || '';
      }
      return campaignHeroUrl || null;
    };
    // The run kind's deterministic visual at a platform: the linked page's
    // hero for a campaign when one exists, otherwise the kind's fixed card.
    // For a review run the card is rendered but the graphic is NOT persisted
    // or approved yet: listReviewGraphicCandidates() excludes any review
    // already joined to review_graphics, so creating the row here would
    // consume the review from the candidate queue even on a dry run or a
    // failed publish. Persist + approve happens only after a confirmed
    // successful publish (below).
    const deterministicVisual = async (platform) => {
      const hero = await resolveCampaignHero();
      if (hero) return { url: hero, hero: true };
      return { url: await kind.renderCard(plan, preview, platform), hero: false };
    };
    const cardIsFallback = fixedCardIsFallback({
      isCampaignRun,
      engineProduced: creativeVariants.length > 0,
      creativeEligible,
      engineEnabled: CreativeEngine.CREATIVE_FLAGS.enabled,
    });
    const legacyCardUrls = new Set();
    const trackFallbackCard = (visual) => {
      if (visual?.url && !visual.hero && cardIsFallback) legacyCardUrls.add(visual.url);
    };
    let gbpImageBranded = true;
    if (creativeVariants.length) {
      imageUrl = creativeVariants[0].imageUrl;
      if (wantsGbp) {
        const gbp = await deterministicVisual('gbp');
        gbpImageUrl = gbp.url;
        gbpImageBranded = !gbp.hero;
        trackFallbackCard(gbp);
      }
      finalPreview = previewWithVisual(preview, {
        imageUrl,
        gbpImageUrl,
        gbpImageBranded,
        variant: kind.variant,
        templateKey: kind.photoTemplateKey,
        creative: {
          conceptKey: creativeVariants[0].conceptKey,
          sceneModel: creativeVariants[0].sceneModel,
        },
        variants: creativeVariants,
      });
    } else {
      const main = await deterministicVisual();
      imageUrl = main.url;
      const gbp = wantsGbp ? (main.hero ? main : await deterministicVisual('gbp')) : null;
      gbpImageUrl = gbp?.url || null;
      gbpImageBranded = !main.hero;
      finalPreview = previewWithVisual(preview, {
        imageUrl,
        gbpImageUrl,
        gbpImageBranded,
        variant: kind.variant,
        templateKey: main.hero ? 'waves_blog_hero' : kind.cardTemplateKey,
      });
      trackFallbackCard(main);
      trackFallbackCard(gbp);
    }

    if (effectiveMode === 'draft') {
      const saved = await saveCampaignDraft({
        ...plan,
        link: finalPreview.suggestedLink,
        preview: finalPreview,
        imageUrl,
        title: plan.topic,
        description: plan.service,
      });
      const updated = await updateAutonomousRun(run?.id, {
        status: 'draft_created',
        preview: finalPreview,
        publishResult: { draftId: saved.post?.id, imageUrl },
        socialMediaPostId: saved.post?.id,
      });
      return { success: true, mode: effectiveMode, post: saved.post, run: updated, preview: finalPreview };
    }

    // Pre-publish liveness gate (mirrors approveAutonomousRun): the candidate
    // was selected before the creative render/upload, and the hourly sync can
    // stamp the review missing inside that window. Re-read the source row so
    // a removed review never publishes as a "current Google review" — the
    // post-publish createReviewGraphic re-check is bookkeeping only and its
    // rejection is swallowed after the post is already live.
    if (isReviewRun && (await hasTable('google_reviews'))) {
      const srcReview = await db('google_reviews')
        .where({ id: plan.reviewGraphic.googleReviewId })
        .first()
        .catch(() => null);
      if (!srcReview || srcReview.missing_since) {
        const reason = srcReview
          ? 'source Google review has been removed from Google — testimonial publish blocked'
          : 'source Google review no longer exists — testimonial publish blocked';
        await updateAutonomousRun(run?.id, {
          status: 'failed',
          preview: finalPreview,
          skipReason: reason,
        });
        return { success: false, skipped: true, reason, mode: effectiveMode, preview: finalPreview };
      }
    }

    // Milestone counterpart of the liveness gate: the count/average were read
    // at selection, before render/upload — cheap re-check here; the lease
    // below re-checks again with the stats sync excluded.
    if (isMilestoneRun) {
      const reason = await milestonePublishBlocker(plan);
      if (reason) {
        await updateAutonomousRun(run?.id, { status: 'failed', preview: finalPreview, skipReason: reason });
        return { success: false, skipped: true, reason, mode: effectiveMode, preview: finalPreview };
      }
    }

    const guid = `${AUTONOMOUS_SOURCE}_${startedAt.toISOString()}`;
    // The link was probed when the preview was built; creative rendering and
    // uploads sit between that and here. Re-probe once more so the URL that
    // ships is the URL that answered 200 seconds ago (same rule as approval).
    const publishLink = finalPreview.suggestedLink && (await linkIsLive(finalPreview.suggestedLink))
      ? finalPreview.suggestedLink
      : '';
    if (finalPreview.suggestedLink && !publishLink) {
      logger.warn(`[social-studio] link no longer live at publish time, publishing without it: ${finalPreview.suggestedLink}`);
    }

    // Versus counterpart of the liveness gate, and the LAST await before the
    // post: the season was checked at selection, and render, uploads and the
    // link probe (5s timeout) all sit between there and here — a run selected
    // in the last minutes of June must not post a swarmer card in July. Placed
    // after the probe deliberately, so no network call can widen the window
    // again. Same re-check the approval path applies to a queued draft.
    if (isVersusRun) {
      const reason = versusPublishBlocker(plan);
      if (reason) {
        await updateAutonomousRun(run?.id, { status: 'failed', preview: finalPreview, skipReason: reason });
        return { success: false, skipped: true, reason, mode: effectiveMode, preview: finalPreview };
      }
    }
    // The snapshot gates above reject cheaply; the locks close their TOCTOU —
    // the reconcile cannot stamp the source row (review runs) and the stats
    // sync cannot move the fleet count (milestone runs) between here and the post.
    const publishFn = () => SocialMediaService.publishToAll({
        // LinkedIn renders `title` as the article headline — use the linked
        // page's real title when there is one, the topic literal otherwise.
        title: (publishLink && finalPreview.suggestedLinkTitle) || plan.topic,
        description: plan.service,
        link: publishLink,
        guid,
        source: AUTONOMOUS_SOURCE,
        customContent: finalPreview.drafts,
        channels: plan.channels,
        imageUrl,
        gbpImageUrl,
        gbpImageBranded, // card = chrome carries the logo; hero photo = watermark in postToGBP
        noAiImage: true, // brand card only — never a literal AI image
        gbpLocationIds: finalPreview.inputs?.locationId ? [finalPreview.inputs.locationId] : [locationForCity(plan.city).id],
        // Durable stamp at the FIRST provider success — a crash or stall in a
        // later provider call can no longer outlive the claim TTL with the
        // testimonial live externally but unrecorded. First-win: the
        // post-publish stamp below becomes a no-op backstop.
        onFirstPlatformSuccess: isReviewRun && !SOCIAL_FLAGS.dryRun
          ? () => recordTestimonialPublished(plan.reviewGraphic.googleReviewId, run?.id)
          : null,
      });
    const publishOutcome = isMilestoneRun
      ? await publishWithFleetStatsLease(plan, publishFn, run?.id)
      : await publishWithReviewLivenessLock(
        isReviewRun ? plan.reviewGraphic.googleReviewId : null,
        publishFn,
        { rejectConsumed: true },
      );
    if (publishOutcome.blocked) {
      const reason = publishOutcome.driftReason
        ? publishOutcome.driftReason
        : publishOutcome.claimedElsewhere
        ? 'milestone already claimed by another run — duplicate celebration blocked'
        : publishOutcome.lockBusy
        ? (isMilestoneRun
          ? 'review stats sync in progress — milestone publish deferred, retry the run'
          : 'review sync in progress for this location — testimonial publish deferred, retry the run')
        : publishOutcome.consumed
          ? 'source Google review was already published as a testimonial — candidate consumed'
          : publishOutcome.missing
            ? 'source Google review no longer exists — testimonial publish blocked'
            : 'source Google review has been removed from Google — testimonial publish blocked';
      await updateAutonomousRun(run?.id, {
        status: 'failed',
        preview: finalPreview,
        skipReason: reason,
      });
      return { success: false, skipped: true, reason, mode: effectiveMode, preview: finalPreview };
    }
    const publishResult = publishOutcome.result;
    // The claim is held through the durable published stamp below —
    // releasing it right after the publish would let a second draft run
    // referencing the same review acquire and double-publish in the
    // publish→stamp gap. If the STAMP fails after a live publish, the claim
    // is RETAINED and its release transfers to the detached recovery loop —
    // the finally must not release it (no durable record plus a cleared
    // claim IS the double-publish window).
    let claimRetained = false;
    try {

    const post = await db('social_media_posts')
      .where({ source_guid: guid })
      .orderBy('created_at', 'desc')
      .first()
      .catch(() => null);

    // Now that the post actually published, record + approve the review graphic,
    // which consumes the review from the candidate queue. A dry run
    // (publishResult.success === false) or a total publish failure leaves the
    // review available for a future run. Also require imageUrl: if the card
    // failed to render (no CDN/S3 or a sharp/S3 error) the post may still have
    // gone out as text, but consuming the review with a null-image graphic would
    // drop it from the candidate queue forever and it could never be rendered.
    // DURABLE published stamp on the FIRST successful external post — before
    // and independent of the review_graphics bookkeeping. Once it lands,
    // candidate selection and the publish-time consumed check both reject
    // this review permanently, so a bookkeeping failure (or a process crash
    // after this point) can no longer reopen a double-publish window. If
    // the stamp itself fails, RETAIN the claim and hand recovery to the
    // detached loop — releasing it with no durable record IS the window.
    if (isReviewRun && !SOCIAL_FLAGS.dryRun && publishResult.success) {
      try {
        await recordTestimonialPublished(plan.reviewGraphic.googleReviewId, run?.id);
      } catch (err) {
        logger.error(`[studio] testimonial-published stamp FAILED after publish (review ${plan.reviewGraphic.googleReviewId}): ${err.message} — claim retained, recovery loop will write the durable record`);
        claimRetained = true;
        // Intentional fire-and-forget — the helper attaches its own terminal
        // catch and the claim self-expires if the process dies mid-loop.
        void holdClaimUntilPublishRecorded({
          googleReviewId: plan.reviewGraphic.googleReviewId,
          record: () => recordTestimonialPublished(plan.reviewGraphic.googleReviewId, run?.id),
          claim: publishOutcome,
        });
      }
    }
    // Graphic bookkeeping — admin history and the saved-graphics list. The
    // durable stamp above already blocks reselection, so a failure here is
    // loud but does not need to hold the claim.
    if (canPersistGraphic && !SOCIAL_FLAGS.dryRun && publishResult.success && imageUrl) {
      await persistReviewGraphicWithRetry({
        googleReviewId: plan.reviewGraphic.googleReviewId,
        privacyMode: plan.reviewGraphic.privacyMode || 'first_name_city',
        // Follow the visual that actually published (photo card vs SVG card).
        templateKey: finalPreview.visual?.templateKey || 'waves_clean_square',
        channels: plan.channels,
        status: 'approved',
        imageUrl,
      }).catch((err) => {
        logger.error(`[studio] review-graphic bookkeeping FAILED after publish (review ${plan.reviewGraphic.googleReviewId}): ${err.message} — graphic record missing from admin history; reselection stays durably blocked by the published stamp`);
        return null;
      });
    } else if (isReviewRun && !canPersistGraphic && !SOCIAL_FLAGS.dryRun && publishResult.success) {
      logger.error(`[studio] review_graphics table unavailable — published review ${plan.reviewGraphic.googleReviewId} has no graphic bookkeeping row; reselection stays durably blocked by the published stamp`);
    }

    const status = SOCIAL_FLAGS.dryRun ? 'dry_run' : publishResult.success ? 'published' : 'failed';
    const updated = await updateAutonomousRun(run?.id, {
      status,
      preview: finalPreview,
      publishResult,
      socialMediaPostId: post?.id,
      skipReason: publishResult.success ? null : 'all platforms skipped or failed',
    });

    // Only a CONFIRMED external publish of the legacy card is worth an email —
    // a disabled channel, compliance rejection, or provider failure would
    // otherwise report a card that never went out — and only AFTER the
    // durable published stamp above, so a slow SendGrid call can never sit
    // between a live post and its record. Draft runs park in the approval
    // queue where the admin sees the card; they never reach here.
    if (!SOCIAL_FLAGS.dryRun && legacyCardShipped(publishResult.platforms, legacyCardUrls, imageUrl)) {
      await alertLegacyCardFallback(plan, {
        link: finalPreview.suggestedLink,
        creative: {
          enabled: CreativeEngine.CREATIVE_FLAGS.enabled,
          eligible: creativeEligible,
          produced: creativeVariants.length > 0,
        },
      });
    }

    return {
      success: publishResult.success,
      dryRun: SOCIAL_FLAGS.dryRun,
      mode: effectiveMode,
      post,
      run: updated,
      preview: finalPreview,
      publishResult,
    };
    } finally {
      if (!claimRetained) await publishOutcome.releaseClaim();
    }
  } catch (err) {
    await updateAutonomousRun(run?.id, {
      status: 'failed',
      skipReason: err.message,
    });
    throw err;
  }
}

function cityFromLocationId(locationId) {
  return WAVES_LOCATIONS.find((loc) => loc.id === locationId)?.name || 'SWFL';
}

// ── Approval queue (draft_created runs) ─────────────────────────────────────
// A draft autonomous run holds everything needed to publish (channel drafts,
// suggested link, rendered visual + creative-engine variants) in its preview.
// Approve publishes the stored content with the admin's chosen variant and
// folds the outcome into the SAME run + draft post row; reject retires both.

// Resolve the publishable variant list for a run preview. Creative-engine runs
// carry preview.visual.variants; legacy single-card drafts collapse to a
// one-entry list so the same approve path serves both.
/**
 * Serialize a testimonial's liveness decision with the reconcile's stamping
 * UPDATE. The snapshot gates in runAutonomous/approveAutonomousRun are
 * TOCTOU: `_reconcileMissingReviews` can stamp the source review between
 * the read and publishToAll. FOR UPDATE on the source row makes the hourly
 * claim (an UPDATE on the same row) queue behind the publish, so "checked
 * live" and "published" are one atomic decision — a stamp that loses the
 * race lands after commit, where it is a genuinely concurrent removal (the
 * watchdog alert still fires and stamped rows drop off every surface).
 * The liveness DECISION runs under the per-location advisory lock the sync
 * holds across its whole fetch→reconcile cycle (gbp-review-sync:<loc>):
 * while the lock is held no cycle is in flight and no stamp is pending
 * (the reconcile is the only stamp writer and runs inside the same lock).
 * The decision is a CONDITIONAL CLAIM — one statement that verifies the
 * row is unstamped and stamps publish_claimed_until — and then the lock
 * (and its pooled connection) is released BEFORE the slow multi-provider
 * publish: holding it across provider stalls pinned a pool connection per
 * in-flight publish and could starve unrelated queries. The durable claim
 * covers the publish interval instead: the reconcile skips rows with an
 * unexpired claim, so no removal stamp can land mid-publication either.
 * The claim self-expires (PUBLISH_CLAIM_MS) and is cleared best-effort
 * afterwards, so a crashed publisher only defers that row's stamping to
 * the next hourly cycle. When a LIVE publish cannot get its DURABLE
 * published stamp written (recordTestimonialPublished), callers retain
 * the claim instead of releasing it and holdClaimUntilPublishRecorded
 * owns the release (see its doc).
 * Non-review publishes (no sourceReviewId) pass straight through.
 * FAIL CLOSED: no hasTable pre-check — a DB error rejects and the publish
 * fails loudly.
 */
const PUBLISH_CLAIM_MS = 10 * 60 * 1000;

const NOOP_RELEASE = async () => {};
const NOOP_ABANDON = () => {};

// Milestone counterpart of publishWithReviewLivenessLock, same shape as the
// review lane's release-before-publish design: the fleet snapshot is
// written by the Places stats sync under runExclusive
// `gbp-review-sync:<location>`, so EVERY configured location's lease is
// held (non-blocking try-locks, fixed order → no deadlock) only for the
// atomic part — the final drift re-check plus writing the durable 'claimed'
// stamp — and released BEFORE the external provider calls (which have no
// total deadline; holding four sync leases and pool connections across them
// would starve review sync fleet-wide). The stamp is what survives: a
// stats change during the publish itself can only shift the count by the
// handful of reviews that land in those seconds — the same staleness any
// published statistic has — and can never produce a second celebration.
// Any lease contention → { blocked, lockBusy } and the caller retries later.
async function publishWithFleetStatsLease(plan, publishFn, runId) {
  const ids = WAVES_LOCATIONS.map((loc) => loc.id).sort();
  const HELD = Symbol('held');
  // Dry runs post nothing externally — never write ownership for them.
  const persistClaim = !SOCIAL_FLAGS.dryRun;
  const acquire = async (i) => {
    if (i >= ids.length) {
      const driftReason = await milestonePublishBlocker(plan);
      if (driftReason) return { [HELD]: true, blocked: true, driftReason };
      if (persistClaim && (await claimMilestone(plan.milestone, runId)) === 'other') {
        return { [HELD]: true, blocked: true, claimedElsewhere: true };
      }
      return { [HELD]: true, claimed: true };
    }
    return runExclusive(`gbp-review-sync:${ids[i]}`, () => acquire(i + 1), { recordHealth: false });
  };
  const gate = await acquire(0);
  if (!gate || !gate[HELD]) return { blocked: true, lockBusy: true };
  if (gate.blocked) return { blocked: true, driftReason: gate.driftReason, claimedElsewhere: gate.claimedElsewhere };

  // Leases released — publish. Same { blocked, result, releaseClaim,
  // abandonClaim } outcome shape the callers already handle.
  // A thrown publish leaves the 'claimed' stamp in place on purpose: provider
  // state is unknown, and a duplicate celebration is worse than a missed one.
  const outcome = await publishWithReviewLivenessLock(null, publishFn);
  if (!persistClaim) return outcome;
  const disposition = milestoneClaimDisposition(outcome?.result);
  if (disposition === 'published') {
    await markMilestonePublished(plan.milestone, runId).catch((err) => {
      logger.error(`[studio] milestone ${plan.milestone} published but stamp upgrade failed (claim retained): ${err.message}`);
    });
  } else if (disposition === 'release') {
    await clearMilestoneStamp(plan.milestone, runId).catch(() => {});
  } else {
    logger.warn(`[studio] milestone ${plan.milestone} publish reported no success after provider attempts — claim retained (owner review)`);
  }
  return outcome;
}

// What happens to the durable claim after a publish attempt (pure):
//   'published' — some provider accepted the post → claimed → published
//   'release'   — NOTHING reached a provider (empty channel set, or every
//                 entry skipped before an external call: automation
//                 paused, channel disabled, judge rejection) → the
//                 threshold is selectable again
//   'retain'    — a provider was ATTEMPTED and reported failure; a lost
//                 response may still have gone live, so ownership stays
function milestoneClaimDisposition(result) {
  const platforms = Array.isArray(result?.platforms) ? result.platforms : [];
  if (result?.success || platforms.some((p) => p?.success)) return 'published';
  if (platforms.every((p) => p?.skipped)) return 'release';
  return 'retain';
}

async function publishWithReviewLivenessLock(sourceReviewId, publishFn, { rejectConsumed = false, allowConsumedByRunId = null } = {}) {
  if (!sourceReviewId) {
    return { blocked: false, result: await publishFn(), releaseClaim: NOOP_RELEASE, abandonClaim: NOOP_ABANDON };
  }
  const source = await db('google_reviews').where({ id: sourceReviewId }).first();
  if (!source || source.missing_since) {
    return { blocked: true, missing: !source };
  }
  // The claimed-until value doubles as the ownership token: acquisition is
  // serialized under the advisory lock, so exactly one publisher can win a
  // given claim window — and releaseClaim below releases ONLY a claim this
  // invocation owns, never a successor's.
  const claimUntil = new Date(Date.now() + PUBLISH_CLAIM_MS).toISOString();
  const decision = await runExclusive(`gbp-review-sync:${source.location_id}`, async () => {
    if (rejectConsumed) {
      // Two draft runs can reference the same review (drafts don't insert
      // review_graphics) — once one approval consumed the candidate, a
      // second acquisition must fail permanently, not just while the first
      // claim is live. FAIL CLOSED: duplicate prevention is the whole point
      // of these lookups, so a transient DB failure must abort the publish
      // (the error propagates and the run fails loudly) — swallowing it
      // would treat "couldn't check" as "not consumed" and re-publish a
      // testimonial another run already posted.
      const consumedRow = await db('review_graphics')
        .where({ google_review_id: sourceReviewId, status: 'approved' })
        .first();
      if (consumedRow) return { consumed: true };
      // The DURABLE published stamp — written on the first successful
      // external post, before and independent of review_graphics
      // bookkeeping, so it survives bookkeeping failures and process
      // crashes. Only the OWNING run (a partial approval retrying its
      // remaining channels) may publish past its own stamp; everyone
      // else is consumed. Fresh read inside the advisory lock.
      const currentSource = await db('google_reviews').where({ id: sourceReviewId }).first();
      if (currentSource?.testimonial_published_at
        && (allowConsumedByRunId == null
          || String(currentSource.testimonial_published_run) !== String(allowConsumedByRunId))) {
        return { consumed: true };
      }
    }
    const claimed = await db('google_reviews')
      .where({ id: sourceReviewId })
      .whereNull('missing_since')
      // Acquire only when unclaimed or expired — a live claim means another
      // publish of this review is in flight, and accepting anyway would
      // double-publish and let the first finisher erase the second's claim.
      .whereRaw('(publish_claimed_until IS NULL OR publish_claimed_until < ?)', [new Date().toISOString()])
      .update({ publish_claimed_until: claimUntil });
    return { claimed: (Array.isArray(claimed) ? claimed.length : claimed) > 0 };
  }, { recordHealth: false });
  if (decision?.skipped) {
    return { blocked: true, lockBusy: true };
  }
  if (decision.consumed) {
    return { blocked: true, consumed: true };
  }
  if (!decision.claimed) {
    // Zero rows: stamped/deleted, or another publisher holds a live claim.
    const fresh = await db('google_reviews').where({ id: sourceReviewId }).first();
    if (fresh && !fresh.missing_since) {
      return { blocked: true, lockBusy: true };
    }
    return { blocked: true, missing: !fresh };
  }
  // Heartbeat: provider requests carry no total deadline, so a stalled
  // publish could outlive the claim TTL and let the reconcile stamp the
  // review mid-publication. Renew the OWNED claim (token-matched, so a
  // successor's claim is never touched) at a third of the TTL. If a
  // renewal is still in flight when the release runs, the clear can miss
  // the rotated token — that orphan self-expires within one TTL and only
  // defers that row's stamping by one cycle.
  let currentClaim = claimUntil;
  const heartbeat = setInterval(async () => {
    try {
      const next = new Date(Date.now() + PUBLISH_CLAIM_MS).toISOString();
      const renewed = await db('google_reviews')
        .where({ id: sourceReviewId })
        .where('publish_claimed_until', currentClaim)
        .update({ publish_claimed_until: next });
      if ((Array.isArray(renewed) ? renewed.length : renewed) > 0) currentClaim = next;
    } catch { /* best-effort — the TTL still bounds the window */ }
  }, Math.floor(PUBLISH_CLAIM_MS / 3));
  heartbeat.unref?.();
  let released = false;
  const releaseClaim = async () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
    await db('google_reviews')
      .where({ id: sourceReviewId })
      .where('publish_claimed_until', currentClaim)
      .update({ publish_claimed_until: null })
      .catch(() => null);
  };
  // Abandon = stop renewing but DELIBERATELY leave the claim standing, so it
  // self-expires within one TTL. Used when a live external publish could not
  // get its candidate consumption recorded: actively clearing the claim
  // would re-open reselection (and double-publish) immediately, while an
  // expiring claim never blocks the reconcile for longer than one TTL after
  // the heartbeat stops.
  const abandonClaim = () => {
    if (released) return;
    released = true;
    clearInterval(heartbeat);
  };
  try {
    const result = await publishFn();
    // The claim deliberately SURVIVES a successful publish: callers hold it
    // through their post-publish bookkeeping (candidate consumption, local
    // record) and release via releaseClaim() — otherwise a competitor could
    // acquire in the publish→consume gap and double-publish.
    return { blocked: false, result, releaseClaim, abandonClaim };
  } catch (err) {
    await releaseClaim();
    throw err;
  }
}

function runVariants(preview = {}) {
  const visual = preview.visual || {};
  if (Array.isArray(visual.variants) && visual.variants.length) return visual.variants;
  if (visual.imageUrl) {
    return [{
      imageUrl: visual.imageUrl,
      gbpImageUrl: null,
      conceptKey: visual.creative?.conceptKey || null,
      sceneModel: visual.creative?.sceneModel || null,
    }];
  }
  return [];
}

// Pure: merge a prior approval attempt's platform successes with the current
// attempt and decide whether the approval is COMPLETE. Rules:
// - success: any platform success across attempts (the post-level rule).
// - videoPosted: a video approval needs at least one reel/video success.
// - videoBlocked: a video approval stays incomplete while any REQUESTED Meta
//   channel has been attempted and failed without ever succeeding — so a
//   half-posted FB+IG pair keeps the run retryable for the missing platform.
//   A SKIP (platform not configured/enabled) doesn't block: it can never
//   succeed, and the capability gate means a video variant only exists when
//   at least one Meta channel was publish-ready.
// Exported for tests.
function assessApprovalPublish({ isVideoVariant, channels, priorPlatforms, current } = {}) {
  const priorSuccesses = (Array.isArray(priorPlatforms) ? priorPlatforms : []).filter((p) => p?.success);
  const platforms = [...priorSuccesses, ...((current && current.platforms) || [])];
  const success = platforms.some((p) => p?.success);
  const videoPosted = !isVideoVariant
    || platforms.some((p) => p?.success && (p.mediaType === 'reel' || p.mediaType === 'video'));
  const metaChannels = (channels || []).filter((c) => c === 'facebook' || c === 'instagram');
  // A requested Meta channel must be RESOLVED before a video approval can
  // finalize: a success (now or prior), or a channel-level skip in the current
  // attempt (unconfigured/disabled — can never succeed). A channel with no
  // entry at all stays blocking: prior failures are not carried into the merge,
  // so a retry that comes back with only a GLOBAL skip (automation disabled/
  // paused → one {platform:'all', skipped} row) must not let the prior
  // success finalize a run whose other Meta channel never got the video.
  const videoBlocked = !!isVideoVariant && metaChannels.some((channel) => {
    const entries = platforms.filter((p) => p?.platform === channel);
    if (entries.some((p) => p?.success)) return false;
    if (entries.length && entries.every((p) => p?.skipped)) return false; // channel-level skip
    return true; // failed, dry-run, or unresolved (global skip / never attempted)
  });
  return {
    success,
    videoPosted,
    videoBlocked,
    complete: success && videoPosted && !videoBlocked,
    mergedPublishResult: { ...(current || {}), success, platforms },
  };
}

async function approveAutonomousRun(runId, { variantIndex = 0 } = {}) {
  if (!(await hasTable('social_content_studio_runs'))) {
    return { ok: false, status: 503, error: 'social_content_studio_runs table is unavailable' };
  }
  // Per-run advisory lock: a double-clicked Approve (or two admin tabs) must
  // not publish twice. Non-blocking — the loser gets a 409, not a queue.
  const result = await runExclusive(`social_autonomous_approve_${runId}`, async () => {
    // .catch(null): a malformed :id (not a UUID) is a 404, not a 500.
    const run = await db('social_content_studio_runs')
      .where({ id: runId, run_type: 'autonomous' })
      .first()
      .catch(() => null);
    if (!run) return { ok: false, status: 404, error: 'autonomous run not found' };
    if (run.status !== 'draft_created') {
      return { ok: false, status: 409, error: `run is '${run.status}' — only draft_created runs can be approved` };
    }

    const preview = toJson(run.preview, {});
    const input = toJson(run.input, {});
    // A review-testimonial draft must not publish a review Google has since
    // removed — the stored draft copy would post as a "current Google
    // review". createReviewGraphic re-checks eligibility, but only AFTER a
    // successful publish (bookkeeping); this is the pre-publish gate. Also
    // blocks partial-publish retries: stopping further spread beats
    // completing the channel set with a removed review.
    const sourceReviewId = input.reviewGraphic?.googleReviewId || null;
    if (sourceReviewId && (await hasTable('google_reviews'))) {
      const srcReview = await db('google_reviews').where({ id: sourceReviewId }).first().catch(() => null);
      if (!srcReview) {
        return { ok: false, status: 409, error: 'source Google review no longer exists — testimonial cannot be published' };
      }
      if (srcReview.missing_since) {
        return { ok: false, status: 409, error: 'source Google review has been removed from Google — testimonial cannot be published' };
      }
    }
    // A milestone draft can sit in the queue for days; the stored copy and
    // card state a count/average that may no longer hold. Re-validate before
    // publishing (rejecting the draft releases the threshold claim).
    if (input.milestone) {
      const reason = await milestonePublishBlocker(input);
      if (reason) return { ok: false, status: 409, error: reason };
    }
    const variants = runVariants(preview);
    const priorRecordFull = toJson(run.publish_result, {});
    const priorHasSuccess = Array.isArray(priorRecordFull?.platforms)
      && priorRecordFull.platforms.some((p) => p?.success);
    let idx = Number(variantIndex ?? 0);
    // Once any platform has actually posted, the creative is LOCKED to the
    // variant that posted it: a retry (page refresh → variantIndex defaults to
    // 0) must finish the same publish, not post a DIFFERENT still/video to the
    // remaining channels while earlier channels carry the original.
    const lockedIdx = priorHasSuccess ? Number(priorRecordFull?.approval?.variantIndex) : NaN;
    if (Number.isInteger(lockedIdx) && lockedIdx >= 0 && lockedIdx < variants.length) {
      idx = lockedIdx;
    }
    if (!Number.isInteger(idx) || idx < 0 || idx >= variants.length) {
      return { ok: false, status: 400, error: variants.length ? `variantIndex must be 0..${variants.length - 1}` : 'run has no publishable image' };
    }
    const chosen = variants[idx];
    const isVideoVariant = chosen?.type === 'video';
    // Variants were persisted server-side at run time, but re-validate to http(s)
    // anyway — preview JSON is also reachable through admin save endpoints.
    const chosenVideoUrl = isVideoVariant ? httpUrlOrNull(chosen?.videoUrl) : null;
    if (isVideoVariant && !chosenVideoUrl) {
      return { ok: false, status: 400, error: 'selected variant has no hosted video' };
    }
    // The still that rides along with the publish: for an image approval it's
    // the chosen variant; for a video approval it's the run's first image
    // variant (GBP has no video ingestion, and the post row keeps an image
    // thumbnail). A video approval with no image variant just posts GBP
    // text-only — its CTA button still carries the link.
    const imageVariant = isVideoVariant
      ? variants.find((v) => v?.type !== 'video' && v?.imageUrl)
      : chosen;
    const chosenImageUrl = httpUrlOrNull(imageVariant?.imageUrl);
    if (!isVideoVariant && !chosenImageUrl) {
      return { ok: false, status: 400, error: 'selected variant has no hosted image' };
    }

    const channels = normalizeChannels(
      toJson(run.channels, null) ?? input.channels ?? preview.inputs?.channels
    );
    if (!channels.length) return { ok: false, status: 400, error: 'run has no publishable channels' };

    const city = run.city || preview.inputs?.city || input.city;
    const gbpLocationId = preview.inputs?.locationId || locationForCity(city).id;

    // Retry of a partially-published approval: channels that already posted in
    // a PRIOR attempt (recorded on the run's publish_result) are skipped this
    // time — a video failure after a GBP success retries WITHOUT double-posting
    // GBP, and a half-posted FB+IG pair retries only the missing platform. GBP
    // posts per-location but is treated as one channel: any location success
    // skips it (re-posting the succeeded locations would duplicate).
    const priorPlatforms = Array.isArray(priorRecordFull?.platforms) ? priorRecordFull.platforms : [];
    const alreadyPosted = new Set(priorPlatforms.filter((p) => p?.success).map((p) => p?.platform));
    const remainingChannels = channels.filter((channel) => !alreadyPosted.has(channel));

    // Nothing left to attempt → assess purely from the record (defensive; a
    // fully-posted run normally finalizes on the attempt that completed it).
    // The liveness gate above is a snapshot; the lock closes its TOCTOU
    // against the reconcile stamping the source review mid-approval.
    // allowConsumedByRunId: a PARTIAL prior attempt stamps this run as the
    // owner of the testimonial — only this run's retry may publish the
    // remaining channels past its own stamp; every other run is consumed.
    // Milestone drafts take the fleet-stats lease instead (see
    // publishWithFleetStatsLease) — the drift re-check and the post happen
    // with the stats sync excluded.
    // The stored link was probed when the draft was previewed; a draft can sit
    // in the queue for days while the hub retires that page. Re-probe right
    // before publishing and drop a dead link (and the page title that rode
    // with it) rather than recreate the 2026-08-29 404.
    const approvedLink = preview.suggestedLink && (await linkIsLive(preview.suggestedLink))
      ? preview.suggestedLink
      : '';
    if (preview.suggestedLink && !approvedLink) {
      logger.warn(`[social-studio] approval link no longer live, publishing without it: ${preview.suggestedLink}`);
    }
    // A season-gated versus draft (e.g. termite swarmers, Feb–Jun) must not
    // publish once its window has passed. Sits AFTER the link probe for the
    // same reason as the direct path's copy: an approval landing seconds
    // before ET midnight would otherwise clear the gate in June and post in
    // July while the probe (5s timeout) ran. Keep this the last await-free
    // gate before the publish call.
    const versusSeasonBlock = versusPublishBlocker(input);
    if (versusSeasonBlock) return { ok: false, status: 409, error: versusSeasonBlock };
    const withPublishLock = (fn) => (input.milestone
      ? publishWithFleetStatsLease(input, fn, run.id)
      : publishWithReviewLivenessLock(sourceReviewId, fn, { rejectConsumed: true, allowConsumedByRunId: run.id }));
    const publishOutcome = remainingChannels.length
      ? await withPublishLock(() => SocialMediaService.publishToAll({
        title: (approvedLink && preview.suggestedLinkTitle) || run.topic || preview.inputs?.topic || 'Waves update',
        description: run.service || preview.inputs?.service || '',
        link: approvedLink,
        guid: `${AUTONOMOUS_SOURCE}_approved_${run.id}`,
        source: AUTONOMOUS_SOURCE,
        customContent: preview.drafts,
        channels: remainingChannels,
        imageUrl: chosenImageUrl,
        // ONLY the run-level deterministic GBP card — never the per-variant
        // gbpImageUrl. Post-deploy, creative variants carry no GBP URL at all
        // (wantsGbp:false), so a variant-level value can only be a LEGACY
        // pre-deploy AI 4:3 scene queued in an old draft — reading it would
        // publish AI imagery to GBP on approval. publishToAll posts GBP
        // text-only when the card is absent.
        gbpImageUrl: httpUrlOrNull(preview.visual?.gbpImageUrl),
        // Stored deterministic card (already logo'd) unless the run recorded a
        // hero PHOTO for GBP — then postToGBP watermarks it.
        gbpImageBranded: preview.visual?.gbpImageBranded !== false,
        videoUrl: chosenVideoUrl,
        noAiImage: true, // stored visual only — never a fresh literal AI image
        gbpLocationIds: [gbpLocationId],
        postId: run.social_media_post_id || null,
        // Durable stamp at the FIRST provider success — mirrors the
        // autonomous path; the post-publish stamp below is the no-op backstop.
        onFirstPlatformSuccess: input.reviewGraphic?.googleReviewId && !SOCIAL_FLAGS.dryRun
          ? () => recordTestimonialPublished(input.reviewGraphic.googleReviewId, run.id)
          : null,
      }))
      : { blocked: false, result: { success: false, platforms: [], note: 'all requested channels already posted in a prior attempt' }, releaseClaim: async () => {}, abandonClaim: () => {} };
    if (publishOutcome.blocked) {
      return {
        ok: false,
        status: 409,
        error: publishOutcome.driftReason
          ? publishOutcome.driftReason
          : publishOutcome.claimedElsewhere
          ? 'this milestone was already claimed by another run — reject this draft'
          : publishOutcome.lockBusy
          ? (input.milestone
            ? 'review stats sync is in progress — approve again in a moment'
            : 'review sync is in progress for this location — approve again in a moment')
          : publishOutcome.consumed
            ? 'this review was already published as a testimonial by another run'
            : publishOutcome.missing
              ? 'source Google review no longer exists — testimonial cannot be published'
              : 'source Google review has been removed from Google — testimonial cannot be published',
      };
    }
    const publishResult = publishOutcome.result;
    // Claim held through the durable published stamp below (see
    // publishWithReviewLivenessLock) — released in the finally UNLESS the
    // stamp failed after a live publish, where the claim is retained and
    // the detached recovery loop owns its release.
    let claimRetained = false;
    try {

    // A VIDEO approval only finalizes when the video itself posted AND no
    // requested Meta channel is left attempted-but-failed (see
    // assessApprovalPublish) — a GBP-only success can't consume the draft, and
    // an FB-posted/IG-failed split stays retryable for Instagram alone.
    const assessment = assessApprovalPublish({
      isVideoVariant,
      channels,
      priorPlatforms,
      current: publishResult,
    });
    // Stamp the approval's variant identity onto the stored record — the lock
    // above reads it so retries can't switch creative mid-publish.
    assessment.mergedPublishResult.approval = {
      variantIndex: idx,
      type: isVideoVariant ? 'video' : 'image',
      conceptKey: chosen.conceptKey || null,
    };
    const published = assessment.complete && !SOCIAL_FLAGS.dryRun;

    // DURABLE published stamp on the FIRST successful external post — on
    // ANY success, not only completion: a partial attempt (Facebook posted,
    // Instagram failed) already put this testimonial live externally, and
    // without the stamp the review stayed selectable by other runs while
    // this run remained retryable. The stamp records THIS run as owner, so
    // only this run's retry passes the consumed check for its remaining
    // channels. Stamp failure retains the claim — recovery loop writes it.
    if (input.reviewGraphic?.googleReviewId && !SOCIAL_FLAGS.dryRun && assessment.mergedPublishResult.success) {
      try {
        await recordTestimonialPublished(input.reviewGraphic.googleReviewId, run.id);
      } catch (err) {
        logger.error(`[studio] testimonial-published stamp FAILED after approval publish (review ${input.reviewGraphic.googleReviewId}): ${err.message} — claim retained, recovery loop will write the durable record`);
        claimRetained = true;
        // Intentional fire-and-forget — the helper attaches its own terminal
        // catch and the claim self-expires if the process dies mid-loop.
        void holdClaimUntilPublishRecorded({
          googleReviewId: input.reviewGraphic.googleReviewId,
          record: () => recordTestimonialPublished(input.reviewGraphic.googleReviewId, run.id),
          claim: publishOutcome,
        });
      }
    }

    // publishToAll's postId update wrote only THIS attempt's results to the
    // post-history row; overwrite with the merged cross-attempt record so
    // admin history and the per-platform failure alerting keep the earlier
    // successes (e.g. attempt-1 Facebook video + retry Instagram Reel).
    if (run.social_media_post_id && remainingChannels.length && priorPlatforms.length) {
      const mergedContent = {};
      for (const p of assessment.mergedPublishResult.platforms) {
        if (p?.content) mergedContent[p.location ? `${p.platform}_${p.location}` : p.platform] = p.content;
      }
      await db('social_media_posts')
        .where({ id: run.social_media_post_id })
        .update({
          platforms_posted: JSON.stringify(assessment.mergedPublishResult.platforms),
          // publishToAll derived the row status from THIS attempt alone, so a
          // no-success retry (IG failed/skipped while attempt-1's FB video is
          // already live) just flipped a live post to 'failed'. Re-derive from
          // the merged record: any cross-attempt success = 'published' — the
          // same any-success rule publishToAll itself applies. (published_at
          // was already stamped by the attempt that first succeeded.)
          ...(assessment.mergedPublishResult.success ? { status: 'published' } : {}),
          ...(Object.keys(mergedContent).length ? { published_content: JSON.stringify(mergedContent) } : {}),
        })
        .catch(() => null);
    }

    // Graphic bookkeeping on completion — admin history and the saved-
    // graphics list. The durable stamp above already blocks reselection
    // from the first success, so a failure here is loud but does not need
    // to hold the claim. No hasTable pre-gate: createReviewGraphic fails
    // loudly when the table is unreachable instead of silently skipping.
    if (published && input.reviewGraphic?.googleReviewId) {
      await persistReviewGraphicWithRetry({
        googleReviewId: input.reviewGraphic.googleReviewId,
        privacyMode: input.reviewGraphic.privacyMode || 'first_name_city',
        templateKey: preview.visual?.templateKey || 'waves_clean_square',
        channels,
        status: 'approved',
        imageUrl: chosenImageUrl,
      }).catch((err) => {
        logger.error(`[studio] review-graphic bookkeeping FAILED after approval publish (review ${input.reviewGraphic.googleReviewId}): ${err.message} — graphic record missing from admin history; reselection stays durably blocked by the published stamp`);
        return null;
      });
    }

    // Promote the chosen variant to the run's primary visual so the audit list
    // shows what actually published. A failed/dry-run attempt keeps the run in
    // draft_created (still approvable once the blocker clears) but records the
    // attempt for the audit trail. For a video approval the primary imageUrl
    // stays the still (thumbnails/GBP) and videoUrl records the published Reel.
    const approvedPreview = previewWithVisual(preview, {
      imageUrl: chosenImageUrl || preview.visual?.imageUrl,
      // Carry the deterministic GBP card forward — a failed attempt stays
      // draft_created and a RETRY re-reads preview.visual.gbpImageUrl; losing
      // it here would demote the retry's GBP post to text-only. Run-level
      // ONLY: a per-variant gbpImageUrl is a legacy pre-deploy AI scene.
      gbpImageUrl: preview.visual?.gbpImageUrl || null,
      // ...and whether that GBP image is a hero PHOTO (watermark on retry) —
      // dropping the flag here would default a retry to "branded" and post
      // the raw photo unwatermarked.
      gbpImageBranded: preview.visual?.gbpImageBranded,
      variant: preview.visual?.variant || 'campaign',
      templateKey: preview.visual?.templateKey,
      creative: chosen.conceptKey ? { conceptKey: chosen.conceptKey, sceneModel: chosen.sceneModel || null } : preview.visual?.creative,
      variants,
      // Only stamp the Reel onto the run's visual when it actually shipped —
      // the audit row renders visual.videoUrl as "the published Reel".
      videoUrl: published ? chosenVideoUrl : null,
    });
    const updated = await updateAutonomousRun(run.id, {
      status: published ? 'published' : 'draft_created',
      preview: approvedPreview,
      // The MERGED record (prior successes + this attempt) — the next retry's
      // channel narrowing and the audit trail both read from it.
      publishResult: assessment.mergedPublishResult,
      socialMediaPostId: run.social_media_post_id,
      skipReason: published ? null
        : SOCIAL_FLAGS.dryRun ? 'approve ran in dry-run mode — not published'
        : assessment.success && !assessment.complete
          ? 'approve publish incomplete: the video has not posted on every requested Meta channel — a retry publishes only the missing channels'
          : 'approve publish failed: all platforms skipped or failed',
    });

    return { ok: true, published, dryRun: SOCIAL_FLAGS.dryRun, publishResult: assessment.mergedPublishResult, run: updated };
    } finally {
      if (!claimRetained) await publishOutcome.releaseClaim();
    }
    // recordHealth: false — per-run approval lock, not a scheduled job.
  }, { recordHealth: false });

  if (result?.skipped) {
    return { ok: false, status: 409, error: 'an approval for this run is already in progress' };
  }
  return result;
}

async function rejectAutonomousRun(runId, { reason } = {}) {
  if (!(await hasTable('social_content_studio_runs'))) {
    return { ok: false, status: 503, error: 'social_content_studio_runs table is unavailable' };
  }
  // SAME per-run lock as approve: a reject racing an in-flight approve would
  // otherwise read stale draft_created and mark the run rejected while the
  // approve is mid-publish on Meta/GBP — the finishing approve then flips the
  // "rejected" run to published and a draft the admin rejected is live anyway.
  // Serializing on the shared lock means the reject either runs first (and the
  // approve 409s on the status guard) or arrives during a publish and 409s here.
  const result = await runExclusive(`social_autonomous_approve_${runId}`, async () => {
    const run = await db('social_content_studio_runs')
      .where({ id: runId, run_type: 'autonomous' })
      .first()
      .catch(() => null); // malformed :id → 404, not a 500
    if (!run) return { ok: false, status: 404, error: 'autonomous run not found' };
    if (run.status !== 'draft_created') {
      return { ok: false, status: 409, error: `run is '${run.status}' — only draft_created runs can be rejected` };
    }
    // A partially-published approval (some platform already posted, e.g. GBP
    // went out before the video failed) can NOT be rejected — marking it
    // rejected would hide LIVE external posts behind a rejected draft. The
    // path forward is retrying the approval (which narrows to the missing
    // channels) or removing the live posts manually first.
    const priorPlatforms = toJson(run.publish_result, {})?.platforms;
    const postedPlatforms = (Array.isArray(priorPlatforms) ? priorPlatforms : [])
      .filter((p) => p?.success)
      .map((p) => (p.location ? `${p.platform}/${p.location}` : p.platform));
    if (postedPlatforms.length) {
      return {
        ok: false,
        status: 409,
        error: `this run has already posted to ${Array.from(new Set(postedPlatforms)).join(', ')} — it cannot be rejected; retry the approval to finish publishing, or remove the live posts manually first`,
      };
    }
    const note = cleanText(reason, 300);
    const updated = await updateAutonomousRun(run.id, {
      status: 'rejected',
      skipReason: note ? `rejected by admin: ${note}` : 'rejected by admin',
      socialMediaPostId: run.social_media_post_id,
    });
    if (run.social_media_post_id) {
      await db('social_media_posts')
        .where({ id: run.social_media_post_id })
        .update({ status: 'rejected' })
        .catch(() => null);
    }
    return { ok: true, run: updated };
    // recordHealth: false — per-run approval lock, not a scheduled job.
  }, { recordHealth: false });
  if (result?.skipped) {
    return { ok: false, status: 409, error: 'an approval for this run is in progress — retry once it finishes' };
  }
  return result;
}

function initials(name) {
  const parts = cleanText(name, 80).split(/\s+/).filter(Boolean);
  if (!parts.length) return 'W';
  return parts.slice(0, 2).map((part) => part[0]?.toUpperCase()).filter(Boolean).join('.');
}

function privacyDisplayName(reviewerName, city, privacyMode = 'first_name_city') {
  const cleanName = cleanText(reviewerName, 100);
  const firstName = cleanName.split(/\s+/).filter(Boolean)[0];
  if (privacyMode === 'anonymous') return `Waves customer in ${city}`;
  if (privacyMode === 'initials') return `${initials(cleanName)}., ${city}`;
  return `${firstName || 'Waves customer'}, ${city}`;
}

function reviewExcerpt(text, max = 180) {
  const clean = cleanText(text, max * 2);
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max - 3);
  const boundary = slice.lastIndexOf(' ');
  return `${slice.slice(0, boundary > 80 ? boundary : slice.length).trim()}...`;
}

function buildReviewGraphicCandidate(review, { privacyMode = 'first_name_city', templateKey = 'waves_clean_square', channels } = {}) {
  const locationId = review.location_id || review.locationId || null;
  const city = cityFromLocationId(locationId);
  const displayName = privacyDisplayName(review.reviewer_name || review.reviewerName, city, privacyMode);
  const excerpt = reviewExcerpt(review.review_text || review.reviewText || '');
  return {
    googleReviewId: review.id,
    locationId,
    city,
    starRating: review.star_rating || review.starRating || 5,
    reviewerDisplayName: displayName,
    privacyMode,
    reviewerPhotoAllowed: false,
    excerpt,
    caption: `A 5-star Google review from ${displayName}.`,
    templateKey,
    channels: normalizeChannels(channels || ['gbp', 'facebook', 'instagram']),
    reviewCreatedAt: review.review_created_at || review.reviewCreatedAt || null,
  };
}

async function listReviewGraphicCandidates({ limit = 30 } = {}) {
  if (!(await hasTable('google_reviews'))) return { candidates: [], saved: [] };
  const hasGraphics = await hasTable('review_graphics');
  const safeLimit = Math.max(1, Math.min(100, Number(limit) || 30));

  let rows = [];
  try {
    let query = db('google_reviews as gr')
      .where('gr.reviewer_name', '!=', '_stats')
      .where('gr.star_rating', 5)
      .whereNotNull('gr.review_text')
      .whereRaw("TRIM(gr.review_text) <> ''")
      // Never offer a review Google has removed as marketing material.
      .whereNull('gr.missing_since')
      // Never re-offer a review already published as a testimonial — the
      // durable stamp survives review_graphics bookkeeping failures, so
      // this exclusion holds even when no rg row exists.
      .whereNull('gr.testimonial_published_at')
      .select('gr.id', 'gr.location_id', 'gr.reviewer_name', 'gr.star_rating', 'gr.review_text', 'gr.review_created_at')
      .orderBy('gr.review_created_at', 'desc')
      .limit(safeLimit);
    if (hasGraphics) {
      query = query.leftJoin('review_graphics as rg', 'rg.google_review_id', 'gr.id').whereNull('rg.id');
    }
    rows = await query;
  } catch {
    rows = [];
  }

  let saved = [];
  if (hasGraphics) {
    try {
      saved = await db('review_graphics')
        .select('*')
        .orderBy('created_at', 'desc')
        .limit(50);
    } catch {
      saved = [];
    }
  }

  return {
    candidates: rows.map((row) => buildReviewGraphicCandidate(row)),
    saved,
  };
}

/**
 * Post-publish bookkeeping wrapper: createReviewGraphic consumes the review
 * from the candidate queue, and a swallowed failure here means the
 * testimonial is live externally with nothing consuming the candidate — a
 * later autonomous run would publish the SAME review again. Lock contention
 * (a sync cycle holding the location lock right after publish) is the
 * expected transient, so retry through it; sync cycles run seconds, not
 * minutes. Non-busy errors propagate to the caller's handling.
 */
async function persistReviewGraphicWithRetry(input, { attempts = 6, delayMs = 10000 } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await createReviewGraphic(input);
    } catch (err) {
      if (err?.code !== 'SYNC_LOCK_BUSY' || attempt >= attempts) throw err;
      logger.info(`[studio] review-graphic persist deferred by location sync lock (attempt ${attempt}/${attempts}) — retrying in ${delayMs / 1000}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

const CLAIM_RECOVERY_ATTEMPTS = 60;
const CLAIM_RECOVERY_DELAY_MS = 60 * 1000;

/**
 * Stamp the DURABLE testimonial-published marker on the source review —
 * first-win, one conditional UPDATE, executed the moment any external
 * channel successfully posts the review. This is the record that outlives
 * bookkeeping failures and process crashes: candidate selection excludes
 * stamped rows and the publish-time consumed check rejects them (except
 * the owning run retrying its remaining channels). Throws on DB failure —
 * the caller retains the publish claim and hands recovery to
 * holdClaimUntilPublishRecorded. Idempotent for the owner: an existing
 * own-run stamp is success; a FOREIGN stamp is logged loudly (it means
 * two publishers raced through a crash-expired claim) but still returns —
 * the durable protection is in place either way.
 */
async function recordTestimonialPublished(googleReviewId, runToken) {
  const stamped = await db('google_reviews')
    .where({ id: googleReviewId })
    .whereNull('testimonial_published_at')
    .update({
      testimonial_published_at: new Date().toISOString(),
      testimonial_published_run: runToken == null ? null : String(runToken),
    });
  if ((Array.isArray(stamped) ? stamped.length : stamped) > 0) return;
  const row = await db('google_reviews').where({ id: googleReviewId }).first();
  if (!row) return; // review row gone — nothing selectable remains to guard
  if (row.testimonial_published_at
    && String(row.testimonial_published_run) !== String(runToken == null ? null : runToken)) {
    logger.error(`[studio] testimonial-published stamp for review ${googleReviewId} already owned by run ${row.testimonial_published_run} (this publisher: ${runToken}) — two publishers posted this review; investigate the claim window`);
  }
}

/**
 * Detached post-publish recovery: the testimonial is LIVE externally but the
 * durable published stamp failed to write, so nothing durable stops a later
 * run from re-selecting and double-publishing the same review. The caller
 * RETAINS the publish claim (its heartbeat keeps renewing, which blocks
 * competitor acquisition and defers reconcile stamping) and this loop owns
 * the claim's release: it keeps retrying `record` until the durable record
 * lands, then releases. It releases early when the review is stamped
 * removed or deleted — stamped rows are excluded from every candidate and
 * approve surface, so no reselection risk remains. An unreadable review
 * keeps the claim held (never release on unverifiable state). If recovery
 * exhausts its attempts (~1h of a DB that cannot take one UPDATE), the
 * claim is ABANDONED rather than cleared: it self-expires within one TTL,
 * and was never actively released while unrecorded. Crash caveat (same as
 * the claim design itself): process death in the stamp-failed window lets
 * the claim expire with no durable record — the error logs are the
 * operator signal.
 */
function holdClaimUntilPublishRecorded({
  googleReviewId,
  record,
  claim,
  attempts = CLAIM_RECOVERY_ATTEMPTS,
  delayMs = CLAIM_RECOVERY_DELAY_MS,
}) {
  const loop = async () => {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      await new Promise((resolve) => { const t = setTimeout(resolve, delayMs); t.unref?.(); });
      let review; let readOk = true;
      try {
        review = await db('google_reviews').where({ id: googleReviewId }).first();
      } catch { readOk = false; }
      if (readOk && (!review || review.missing_since)) {
        logger.info(`[studio] claim recovery: review ${googleReviewId} is ${review ? 'stamped removed' : 'deleted'} — excluded from every candidate surface, no reselection risk; releasing claim`);
        await claim.releaseClaim();
        return;
      }
      if (!readOk) continue; // can't verify liveness — keep holding, retry next tick
      try {
        await record();
        logger.info(`[studio] claim recovery: durable publish record landed for review ${googleReviewId} on attempt ${attempt} — releasing claim`);
        await claim.releaseClaim();
        return;
      } catch (err) {
        logger.warn(`[studio] claim recovery attempt ${attempt}/${attempts} for review ${googleReviewId} failed: ${err.message}`);
      }
    }
    logger.error(`[studio] claim recovery EXHAUSTED for review ${googleReviewId} — abandoning the claim (self-expires within ${Math.round(PUBLISH_CLAIM_MS / 60000)} minutes). The published testimonial has NO durable record and may be re-selected by a later run — investigate google_reviews writes`);
    claim.abandonClaim();
  };
  // Detached promise — never let a rejection escape unhandled.
  return loop().catch((err) => {
    logger.error(`[studio] claim recovery loop crashed for review ${googleReviewId}: ${err.message} — abandoning the claim`);
    claim.abandonClaim();
  });
}

async function createReviewGraphic(input) {
  if (!(await hasTable('review_graphics'))) throw new Error('review_graphics table is not available');
  const review = await db('google_reviews').where({ id: input.googleReviewId }).first();
  if (!review) throw new Error('Google review not found');
  // The card/copy is labeled a 5-star Google review, so enforce the same
  // eligibility the list endpoint uses — a caller can't render a misleading
  // graphic from a lower-rated, blank, or stats-sentinel review.
  if (Number(review.star_rating) !== 5
    || !String(review.review_text || '').trim()
    || review.reviewer_name === '_stats'
    // Mirror the candidate query: a review Google removed must not become a
    // "current Google review" marketing card, even by direct ID.
    || review.missing_since) {
    throw new Error('Review is not eligible for a 5-star graphic (requires star_rating=5, non-empty review text, and the review still live on Google)');
  }
  const candidate = buildReviewGraphicCandidate(review, input);
  // image_url is persisted then rendered as an <a href>/<img src> in the admin
  // UI, so a caller-supplied override must be an http(s) URL — never a
  // javascript:/data: link. Anything else falls back to the rendered card.
  const imageUrl = httpUrlOrNull(input.imageUrl) || await renderReviewGraphicImageUrl(candidate);
  // Refuse to create a graphic with no image. listReviewGraphicCandidates
  // excludes any review that already has a review_graphics row, so inserting a
  // null-image row (e.g. when S3/CDN/sharp render failed) would consume the
  // review from the candidate queue forever and leave an approvable-but-blank
  // draft. Fail loudly instead so the caller can retry once rendering works.
  if (!imageUrl) {
    throw new Error('Review graphic image could not be rendered (check S3/CDN config); refusing to create a graphic without an image');
  }
  const row = {
    google_review_id: candidate.googleReviewId,
    status: input.status || 'draft',
    privacy_mode: candidate.privacyMode,
    reviewer_display_name: candidate.reviewerDisplayName,
    location_id: candidate.locationId,
    city: candidate.city,
    // The excerpt is the verbatim review text rendered on a "5-star Google
    // review" card, so it MUST come from the stored review (candidate.excerpt
    // = reviewExcerpt(review.review_text)) — never a caller-supplied override,
    // which would let an admin paint arbitrary words as a real review.
    excerpt: cleanText(candidate.excerpt, 500),
    caption: cleanText(input.caption || candidate.caption, 1000),
    template_key: candidate.templateKey,
    channels: JSON.stringify(candidate.channels),
    render_settings: JSON.stringify({
      ...(input.renderSettings || {}),
      imageTemplate: 'svg:review:v1',
      imageUrl: imageUrl || null,
    }),
    updated_at: new Date(),
  };
  if (await hasColumn('review_graphics', 'image_url')) row.image_url = imageUrl || null;

  // The render/upload above can take seconds — long enough for the hourly
  // sync to stamp the review removed. Re-check and persist ATOMICALLY under
  // the per-location sync advisory lock: the row-level FOR UPDATE alone only
  // serializes against the stamping UPDATE, but a sync cycle that already
  // FETCHED a snapshot without this review could stamp it right after this
  // persist commits — and callers can pass status:'approved' directly, so
  // the persisted row would skip the advisory-locked approve gates. Sharing
  // gbp-review-sync:<loc> (the lock the sync holds across fetch→reconcile)
  // closes that window; a stamp committed first is seen here (abort), and a
  // busy lock defers the persist with a retryable error.
  const outcome = await runExclusive(`gbp-review-sync:${candidate.locationId}`, async () => db.transaction(async (trx) => {
    const fresh = await trx('google_reviews')
      .where({ id: input.googleReviewId })
      .forUpdate()
      .first();
    if (!fresh || fresh.missing_since) {
      throw new Error('Review was removed from Google while the graphic rendered — refusing to persist it');
    }
    const [saved] = await trx('review_graphics')
      .insert({ ...row, created_at: new Date() })
      .onConflict(['google_review_id', 'template_key'])
      .merge(row)
      .returning('*');
    return saved;
  }), { recordHealth: false });
  if (outcome?.skipped) {
    const busy = new Error('Review sync is in progress for this location — retry creating the graphic in a moment');
    busy.code = 'SYNC_LOCK_BUSY';
    throw busy;
  }
  const graphic = outcome;
  return { ...graphic, image_url: graphic.image_url || imageUrl || null };
}

async function ensureFastestRisersSeeded() {
  if (!(await hasTable('competitor_social_profiles'))) return;
  for (const profile of FASTEST_RISER_PROFILES) {
    await db('competitor_social_profiles')
      .insert({
        company_name: profile.companyName,
        pct_rank: profile.pctRank,
        revenue_rank: profile.revenueRank,
        growth_pct: profile.growthPct,
        city: profile.city,
        state: profile.state,
        source_label: 'PCT 2026 Top 100 poster',
        profile_urls: JSON.stringify(profile.profileUrls || {}),
        strategic_notes: JSON.stringify(profile.strategicNotes || []),
        active: true,
        created_at: new Date(),
        updated_at: new Date(),
      })
      // Insert-only: never .merge() over an existing row. Re-running this must
      // not clobber admin edits to a seeded profile (rank/notes/active) — it
      // only backfills profiles that don't exist yet.
      .onConflict('company_name')
      .ignore();
  }
}

async function listCompetitorSwipeFile() {
  const hasProfiles = await hasTable('competitor_social_profiles');
  const hasPosts = await hasTable('competitor_social_posts');
  // Read-only endpoint: never write here. Seeding runs only on studio writes
  // (createCompetitorPost, gated by requireStudioEnabled), so the kill switch
  // truly blocks all studio DB writes. Until a row exists, fall back to the
  // in-memory seed list for display.
  let profiles = FASTEST_RISER_PROFILES;
  if (hasProfiles) {
    const rows = await db('competitor_social_profiles')
      .where({ active: true })
      .select('*')
      .orderBy('growth_pct', 'desc')
      .limit(50);
    if (rows.length) profiles = rows;
  }

  let posts = [];
  if (hasPosts) {
    posts = await db('competitor_social_posts')
      .select('*')
      .orderBy('engagement_score', 'desc')
      .orderBy('created_at', 'desc')
      .limit(100);
  }

  return {
    profiles,
    posts,
    patterns: DEFAULT_COMPETITOR_PATTERNS,
    sourceNote: 'Growth figures come from the local 2026 PCT Top 100 poster PDF supplied by Waves.',
  };
}

function engagementScore({ likesCount = 0, commentsCount = 0, sharesCount = 0, viewsCount = 0 }) {
  return Math.round(
    (Number(likesCount) || 0)
    + ((Number(commentsCount) || 0) * 3)
    + ((Number(sharesCount) || 0) * 5)
    + ((Number(viewsCount) || 0) / 100)
  );
}

async function createCompetitorPost(input) {
  if (!(await hasTable('competitor_social_posts'))) throw new Error('competitor_social_posts table is not available');
  const companyName = cleanText(input.companyName, 180);
  const platform = cleanText(input.platform, 30).toLowerCase();
  if (!companyName) throw new Error('companyName is required');
  if (!platform) throw new Error('platform is required');

  let profile = null;
  if (await hasTable('competitor_social_profiles')) {
    await ensureFastestRisersSeeded();
    profile = await db('competitor_social_profiles').where({ company_name: companyName }).first();
  }

  const counts = {
    likesCount: Number(input.likesCount) || 0,
    commentsCount: Number(input.commentsCount) || 0,
    sharesCount: Number(input.sharesCount) || 0,
    viewsCount: Number(input.viewsCount) || 0,
  };

  const [post] = await db('competitor_social_posts')
    .insert({
      profile_id: profile?.id || null,
      company_name: companyName,
      platform,
      profile_url: httpUrlOrNull(input.profileUrl),
      post_url: httpUrlOrNull(input.postUrl),
      post_date: input.postDate || null,
      topic: cleanText(input.topic, 180) || null,
      hook_type: cleanText(input.hookType, 80) || null,
      creative_format: cleanText(input.creativeFormat, 80) || null,
      likes_count: counts.likesCount,
      comments_count: counts.commentsCount,
      shares_count: counts.sharesCount,
      views_count: counts.viewsCount,
      engagement_score: engagementScore(counts),
      visible_text: cleanText(input.visibleText, 2000) || null,
      why_it_worked: cleanText(input.whyItWorked, 2000) || null,
      copyable_pattern: cleanText(input.copyablePattern, 2000) || null,
      source: cleanText(input.source, 40) || 'manual',
      created_at: new Date(),
      updated_at: new Date(),
    })
    .returning('*');
  return post;
}

module.exports = {
  AUTONOMOUS_FLAGS,
  AUTONOMOUS_SOURCE,
  publishWithReviewLivenessLock,
  holdClaimUntilPublishRecorded,
  recordTestimonialPublished,
  CHANNELS,
  DEFAULT_COMPETITOR_PATTERNS,
  FASTEST_RISER_PROFILES,
  PEST_VERSUS_PAIRS,
  SEASONAL_AUTONOMOUS_TOPICS,
  buildVersusCardInput,
  buildVersusDrafts,
  selectAutonomousVersusPlan,
  versusPublishBlocker,
  MILESTONE_WINDOW,
  buildMilestoneCardInput,
  buildMilestoneDrafts,
  milestoneThresholdFor,
  milestoneDrift,
  milestoneClaimDisposition,
  fleetReviewStats,
  planMilestone,
  selectAutonomousMilestonePlan,
  approveAutonomousRun,
  assessApprovalPublish,
  autonomousStatus,
  buildCampaignCardInput,
  buildCampaignDrafts,
  buildCampaignDraftsAI,
  campaignFactPack,
  buildReviewCardInput,
  buildReviewGraphicCandidate,
  normalizePublishMode,
  createCompetitorPost,
  createReviewGraphic,
  engagementScore,
  httpUrlOrNull,
  normalizeChannels,
  getCampaignContext,
  mentionsOtherCity,
  contentRowMatchesCity,
  liveUrlForRow,
  linkIsLive,
  creativeStateSummary,
  captionContentRows,
  rowMatchesIntentKeywords,
  legacyCardShipped,
  RUN_KINDS,
  runKindFor,
  fixedCardIsFallback,
  firstLivePage,
  suggestedLink,
  suggestedLinkTitle,
  listCompetitorSwipeFile,
  listAutonomousRuns,
  listReviewGraphicCandidates,
  previewCampaign,
  privacyDisplayName,
  recentCreativeConceptKeys,
  rejectAutonomousRun,
  reviewExcerpt,
  serviceIntentKeywords,
  runAutonomous,
  saveCampaignDraft,
  serializeAutonomousRun,
  selectAutonomousCampaign,
  validateDrafts,
};
