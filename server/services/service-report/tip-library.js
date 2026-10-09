'use strict';

/**
 * Tips from your tech — the owner-approved homeowner-advice registry.
 *
 * At completion the tech picks up to three tips from this list; the ids go
 * over the wire, the server resolves them here, and the resolved copy is
 * frozen into structured_notes.techTips. The live service report renders the
 * frozen copy as a first-person note from the technician (scope: the
 * "Tips From Your Tech" artifact, owner decisions 2026-09-01).
 *
 * Rules every entry obeys (enforced by tip-library.test.js):
 *  - `copy` is customer-facing verbatim text: it passes customerCopyViolations
 *    (no safety claims, no "eliminate", no "-proof", no guarantees).
 *  - `copy` is ADVICE, never an observation of this visit. "If you have
 *    bromeliads…" is fine; "I noticed your bromeliads…" is a finding and
 *    belongs in the tech's notes. The visit-claim lint rejects it.
 *  - `watchKeys` (optional, tree & shrub tips only) names the seasonal watch
 *    list items (config/tree-shrub-watch-list.js) the tip is advice for. The
 *    Fast Complete sheet floats a tip to the top when the tech marks one of
 *    them Seen; it never selects a tip. Every key must exist in that list.
 *  - Ids are stable forever — frozen structured_notes reference them and the
 *    picker's "already sent" mark matches on id. Never rename; retire by
 *    removing the entry (frozen reports keep their copy).
 *
 * Lawn tips (owner 2026-09-29) may also carry `findings` and `months`, which
 * only reorder the picker (see LAWN_FINDINGS).
 *
 * A tip may carry `pests` (owner 2026-10-09): the pest sheet's chips
 * (TIP_PESTS) it is advice for. The pest sheet lifts it when the tech taps or
 * names that pest, on any visit; it never selects a tip. Only a tip that
 * claims no work (no bait, traps, stations or treated soil) is tagged, so a
 * lifted tip is true on a visit that did none of that work.
 *
 * Search happens on the client (the registry is small and ships whole);
 * `keywords` are the tech's vocabulary so a query typed at the truck hits.
 */

const { etParts } = require('../../utils/datetime-et');
const { customerCopyViolations } = require('./technician-report-copy');
const { detectServiceLine } = require('./service-line-configs');

const SERVICE_LINES = Object.freeze(['pest', 'lawn', 'mosquito', 'termite', 'rodent', 'tree_shrub']);
const SEASONS = Object.freeze(['wet', 'dry', 'all']);
const MAX_TIPS_PER_VISIT = 3;
// The pest sheet's pest chips (FastCompleteSheet PEST_CHIPS, less "Other").
const TIP_PESTS = Object.freeze(['Ants', 'Roaches', 'Spiders', 'Silverfish', 'Wasps', 'Earwigs', 'Fleas', 'Crickets', 'Centipedes']);
// The "write your own" line: one sentence. The picker enforces the same
// maxLength; the server rejects, never trims.
const MAX_CUSTOM_TIP_CHARS = 240;

// SWFL rain season, June–October. This is the rainfall calendar (standing
// water, humidity), not turf growth — lawn-seasonality's peak/shoulder/dormant
// answers a different question and deliberately isn't reused here.
const WET_SEASON_MONTHS = new Set([6, 7, 8, 9, 10]);

// Accepts a Date (read in ET) or a 'YYYY-MM-DD' calendar day, which is how
// the schedule stores a visit date — never parse that string through
// `new Date()`, which reads it as UTC midnight (the previous ET evening).
function monthForDate(date = new Date()) {
  const day = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim()) : null;
  return day ? Number(day[2]) : etParts(date).month;
}

function seasonForDate(date = new Date()) {
  return WET_SEASON_MONTHS.has(monthForDate(date)) ? 'wet' : 'dry';
}

// Lawn finding keys (owner 2026-09-29, scope round 3c). A lawn tip may carry
// `findings`: the watch-list issues it is advice for; and `months`: the
// calendar months (1-12) the owner has supplied for it. Both only REORDER the
// picker (tipsForVisit); neither hides a tip from search. Each key maps to its
// family, so a coarse finding ('disease') lifts every tip for the issues in
// it, and a specific one ('gray_leaf_spot') lifts just its own tips.
const LAWN_FINDINGS = Object.freeze({
  gray_leaf_spot: 'disease',
  large_patch: 'disease',
  take_all: 'disease',
  sod_webworm: 'insects',
  armyworm: 'insects',
  chinch_bugs: 'insects',
  white_grubs: 'insects',
  mole_crickets: 'insects',
  dollarweed: 'weeds',
  sedges: 'weeds',
  broadleaf_weeds: 'weeds',
  crabgrass: 'weeds',
  thatch: 'thatch',
  shade: 'shade',
  drought: 'drought',
  scalping: 'scalping',
});

// Finding keys from the visit's TECH-CONFIRMED lawn assessment (never an
// unconfirmed read). Confirmed scores are 0-100, higher = healthier; the
// cut-offs are the "minor or worse" step of the assessment's own category
// ramp (lawn-assessment.js FUNGUS_DISPLAY / THATCH_DISPLAY) and 10% weed
// cover. The tech's stress flags add what the scores cannot say. Coarse keys
// only: the scores do not name an issue. Named findings join this list when
// the lawn confirm tiles land.
const LAWN_SCORE_CUTOFFS = Object.freeze({ fungus_control: 75, thatch_level: 60, weed_suppression: 90 });
const LAWN_FLAG_FINDINGS = Object.freeze({
  disease_suspicion: 'disease', shade_stress: 'shade', drought_stress: 'drought', recent_scalp: 'scalping',
});

function lawnFindingsFromAssessment(row) {
  if (!row || row.confirmed_by_tech !== true) return [];
  const found = new Set();
  const atOrBelow = (value, max) => value !== null && value !== undefined && value !== '' && Number.isFinite(Number(value)) && Number(value) <= max;
  if (atOrBelow(row.fungus_control, LAWN_SCORE_CUTOFFS.fungus_control)) found.add('disease');
  if (atOrBelow(row.thatch_level, LAWN_SCORE_CUTOFFS.thatch_level)) found.add('thatch');
  if (atOrBelow(row.weed_suppression, LAWN_SCORE_CUTOFFS.weed_suppression)) found.add('weeds');
  let flags = row.stress_flags;
  if (typeof flags === 'string') {
    try { flags = JSON.parse(flags); } catch { flags = null; }
  }
  if (flags && typeof flags === 'object') {
    for (const [flag, finding] of Object.entries(LAWN_FLAG_FINDINGS)) if (flags[flag] === true) found.add(finding);
  }
  return [...found];
}

// Named findings: the technician-reviewed findings on the visit's assessment
// run (lawn_assessment_runs.reviewed_findings / added_details). Each carries
// the allowlisted customer label of lawn-diagnostic-report CONDITION_LABELS;
// this table says which finding keys a label stands for. A label not listed
// (overwatering, thinning, color, a generic or clean label) lifts nothing.
// "Caterpillar activity" does not say which caterpillar, so it lifts both.
const LAWN_LABEL_FINDINGS = Object.freeze({
  'chinch bug activity': ['chinch_bugs'],
  'caterpillar activity': ['sod_webworm', 'armyworm'],
  'grub activity': ['white_grubs'],
  'large patch (fungal) activity': ['large_patch'],
  'gray leaf spot': ['gray_leaf_spot'],
  'dollar spot': ['disease'],
  'fungal activity': ['disease'],
  'weed pressure': ['weeds'],
  'drought stress': ['drought'],
});

// The rows of one assessment run's technician review that count: only a
// finding the technician KEPT (a rejected one has keep: false), and a
// technician-added detail unless it rules the condition out (negated). A run
// not yet reviewed has neither list and gives nothing. Shared by the tip
// ranking (lawnFindingsFromRun) and the report's "What the photos showed"
// block (lawn-photo-findings.js) so both read the review the same way.
function keptRunRows(run) {
  if (!run) return { reviewed: [], added: [] };
  const list = (value) => {
    let rows = value;
    if (typeof rows === 'string') {
      try { rows = JSON.parse(rows); } catch { rows = null; }
    }
    return Array.isArray(rows) ? rows : [];
  };
  return {
    reviewed: list(run.reviewed_findings).filter((row) => row && row.keep !== false),
    added: list(run.added_details).filter((row) => row && row.negated !== true),
  };
}

// Finding keys from one assessment run's technician review (keptRunRows).
function lawnFindingsFromRun(run) {
  const { reviewed, added } = keptRunRows(run);
  const found = new Set();
  for (const row of [...reviewed, ...added]) {
    const keys = Object.prototype.hasOwnProperty.call(LAWN_LABEL_FINDINGS, row.label) ? LAWN_LABEL_FINDINGS[row.label] : [];
    for (const key of keys) found.add(key);
  }
  return [...found];
}

// 4 for a tip written for one of this visit's findings, 2 for the owner's
// months, 1 for the wet/dry season (the old in-season-first order).
function tipRank(tip, { season, month, findings }) {
  const fits = findings.size > 0 && (tip.findings || []).some((key) => findings.has(key) || findings.has(LAWN_FINDINGS[key]));
  return (fits ? 4 : 0)
    + ((tip.months || []).includes(month) ? 2 : 0)
    + (tip.season === 'all' || tip.season === season ? 1 : 0);
}

// Picker group order per season: wet leads with water and humidity, dry with
// lighting and exclusion. The season only reorders groups — it never hides
// a tip from search.
const TIP_GROUPS = Object.freeze([
  { id: 'moisture', label: 'Moisture' },
  { id: 'water', label: 'Standing water' },
  { id: 'lighting', label: 'Lighting' },
  { id: 'exterior', label: 'Around the house' },
  { id: 'kitchen', label: 'Kitchen and pantry' },
  { id: 'sealing', label: 'Sealing them out' },
  { id: 'rodent', label: 'Rodents' },
  { id: 'termite', label: 'Termite' },
  { id: 'lawn', label: 'Lawn' },
  { id: 'tree_shrub', label: 'Trees and shrubs' },
  { id: 'fleas', label: 'Fleas and ticks' },
  { id: 'bed_bugs', label: 'Bed bugs' },
  { id: 'roaches', label: 'Roaches' },
  { id: 'fire_ants', label: 'Fire ants' },
  { id: 'stinging', label: 'Bees and wasps' },
  { id: 'wildlife', label: 'Wildlife' },
]);
const GROUP_ORDER = Object.freeze({
  wet: ['moisture', 'water', 'lighting', 'exterior', 'kitchen', 'sealing', 'rodent', 'termite', 'lawn', 'tree_shrub', 'fleas', 'bed_bugs', 'roaches', 'fire_ants', 'stinging', 'wildlife'],
  dry: ['lighting', 'sealing', 'exterior', 'moisture', 'kitchen', 'water', 'rodent', 'termite', 'lawn', 'tree_shrub', 'fleas', 'bed_bugs', 'roaches', 'fire_ants', 'stinging', 'wildlife'],
});
// The leading group of a visit whose service has its own tips.
const FOR_SERVICE_GROUP = Object.freeze({ id: 'for_service', label: 'For this service' });

// Every general-pest identity (recurring, one-time, WaveGuard) and the
// native-roach packages: the service keys several tips share.
const GENERAL_PEST_SERVICES = Object.freeze(["pest_initial_palmetto_knockdown", "pest_control", "pest_recurring", "pest_general_quarterly", "pest_general_bimonthly", "pest_general_monthly", "pest_general_semiannual", "waveguard_membership", "pest_onetime", "one_time_pest_control", "pest_initial_cleanout"]);
const NATIVE_ROACH_SERVICES = Object.freeze(['cockroach_control', 'pest_initial_roach', 'pest_initial_palmetto_knockdown']);

const TIPS = Object.freeze([
  // ── Moisture ──────────────────────────────────────────────────────────
  {
    id: 'moisture_ac_drip', group: 'moisture', label: 'A/C condensate line',
    pests: ['Ants', 'Roaches'], keywords: ['ac', 'condensate', 'drip', 'slab', 'ants'], lines: ['pest'], season: 'all',
    copy: "Your A/C condensate line runs all summer, and where it drips the soil against the slab never dries. Ants and roaches follow that moisture gradient straight to the foundation. If the line ends at the wall, a short extension that carries it a couple of feet into the bed makes that strip dry again.",
  },
  {
    id: 'moisture_hose_bib', group: 'moisture', label: 'Fix drips at hose bibs',
    pests: ['Ants'], keywords: ['hose', 'spigot', 'leak', 'water', 'ghost ants'], lines: ['pest'], season: 'all',
    copy: "A slow drip at a hose bib keeps one patch of soil wet around the clock — exactly the micro-habitat ghost ants and springtails move toward. It's usually a worn washer, and it's a quick fix that removes a whole colony's reason to be there.",
  },
  {
    id: 'moisture_bath_fan', group: 'moisture', label: 'Bath fan until the mirror clears',
    pests: ['Roaches'], keywords: ['bathroom', 'humidity', 'fan', 'roach'], lines: ['pest'], season: 'all',
    copy: "Humidity trapped in a closed bathroom keeps the baseboards and cabinet kicks damp. German roaches need that humidity more than they need food, so run the fan after every shower until the mirror clears — that drops the room below what they can live on.",
  },
  {
    id: 'moisture_under_sink', group: 'moisture', label: 'Check under the kitchen sink',
    pests: ['Roaches'], keywords: ['sink', 'cabinet', 'leak', 'trap', 'roach'], lines: ['pest'], season: 'all',
    copy: "The cabinet under the kitchen sink is the harborage I find most often in SWFL kitchens. A slow weep at the trap or the supply lines keeps the cabinet floor dark and damp. Once a month, run a hand along the back corner — if it's damp, that repair does more than anything I can apply.",
  },
  {
    id: 'moisture_ac_auto', group: 'moisture', label: 'A/C fan on Auto, not On',
    pests: ['Roaches', 'Silverfish'], keywords: ['thermostat', 'humidity', 'silverfish', 'booklice'], lines: ['pest'], season: 'wet',
    copy: "Roaches, silverfish, and booklice all track indoor humidity. With the thermostat fan set to On, the coil re-evaporates the water it just pulled out; on Auto the house settles around 50% humidity, and that takes away the conditions they establish in.",
  },

  // ── Lighting ──────────────────────────────────────────────────────────
  {
    id: 'light_warm_bulbs', group: 'lighting', label: 'Warm porch bulbs',
    pests: ['Spiders', 'Crickets'], keywords: ['porch', 'light', 'bulb', '2700k', 'spiders', 'moths'], lines: ['pest', 'mosquito'], season: 'all',
    copy: "Insects steer by short-wavelength light, so a bright white or blue-white bulb — anything over about 3000K — pulls flying insects to your door, and the spiders and geckos that eat them follow. A warm 2700K bulb, or a yellow \"bug\" bulb, is far less visible to them.",
  },
  {
    id: 'light_motion_sensor', group: 'lighting', label: 'Lights on a motion sensor',
    pests: ['Spiders', 'Crickets'], keywords: ['porch', 'light', 'sensor', 'timer'], lines: ['pest', 'mosquito'], season: 'all',
    copy: "Every hour the porch light runs is another hour insects collect at the door. A motion sensor gives you light when you walk up and dark the rest of the night — by morning the difference at the threshold is obvious.",
  },
  {
    id: 'light_aim_away', group: 'lighting', label: 'Aim landscape lights away',
    pests: ['Spiders'], keywords: ['landscape', 'uplight', 'spotlight', 'entry'], lines: ['pest'], season: 'all',
    copy: "Uplights pointed back at the walls gather insects at the entries every night. Turning them out toward the yard, or switching them to warm bulbs, moves that crowd away from the door.",
  },

  // ── Around the house ──────────────────────────────────────────────────
  {
    id: 'ext_shrub_clearance', group: 'exterior', label: "A hand's width off the wall",
    pests: ['Ants'], keywords: ['shrubs', 'hedge', 'trim', 'branches', 'wall'], lines: ['pest', 'tree_shrub'], season: 'all',
    copy: "Branches touching the house are a bridge over the treated band along the foundation — ants and roaches walk the branch, not the ground, and the treatment never touches them. Trim to a hand's width of daylight between plant and wall and the bridge is closed.",
  },
  {
    id: 'ext_mulch_gap', group: 'exterior', label: 'Pull mulch back from the slab',
    keywords: ['mulch', 'foundation', 'slab', 'termite', 'bed'], lines: ['pest', 'termite'], season: 'all',
    copy: "Mulch piled against the block holds moisture and hides the base of the wall where I need to see. Pull it back a few inches and keep it below the top of the slab — that strip dries out, and termites lose a covered route up the wall.",
  },
  {
    id: 'ext_wood_storage', group: 'exterior', label: 'Firewood and pavers off the ground',
    keywords: ['firewood', 'pavers', 'lumber', 'stack', 'harborage'], lines: ['pest', 'termite'], season: 'all',
    copy: "Stacked wood and leftover pavers against the house are cool, dark, undisturbed harborage, and wood sitting on soil is a direct invitation for subterranean termites. Up on a rack, a foot off the wall, and that harborage disappears from the one spot that matters.",
  },
  {
    id: 'ext_lanai_track', group: 'exterior', label: 'Rinse the lanai screen track',
    pests: ['Ants'], keywords: ['lanai', 'screen', 'track', 'leaves', 'ants'], lines: ['pest', 'mosquito'], season: 'all',
    copy: "The screen track collects leaves and holds water after every rain — a food source for ants and a breeding spot for mosquitos in the same six inches. A monthly rinse with the hose takes care of both.",
  },
  {
    id: 'ext_palm_roof', group: 'exterior', label: 'Palm fronds off the roof',
    pests: ['Ants', 'Roaches'], keywords: ['palm', 'fronds', 'roof', 'rats', 'branches'], lines: ['rodent', 'pest', 'tree_shrub'], season: 'all',
    copy: "Fronds and branches touching the roofline are a highway. Roof rats climb better than they burrow, and ants and roaches use the same route into the soffit. A few feet of clearance is exclusion without a single trap.",
  },
  {
    id: 'ext_leaf_litter', group: 'exterior', label: 'Clear leaf litter from the foundation',
    pests: ['Roaches', 'Earwigs', 'Crickets', 'Centipedes'], keywords: ['leaves', 'debris', 'earwigs', 'millipedes'], lines: ['pest'], season: 'all',
    copy: "Leaf litter against the foundation stays damp underneath and harbors roaches, earwigs, and millipedes right where they can find a gap. Keeping that first foot bare and dry is one of the simplest things you can do.",
  },

  // ── Standing water ────────────────────────────────────────────────────
  {
    id: 'water_weekly_dump', group: 'water', label: 'Tip out standing water weekly',
    keywords: ['water', 'buckets', 'saucers', 'toys', 'tarp', 'mosquito'], lines: ['mosquito'], season: 'wet',
    copy: "Mosquitos need about a bottle cap of water and roughly a week to go from egg to adult. One walk-around every weekend to tip out saucers, buckets, toys, and tarps breaks the cycle on your own property before they ever fly.",
  },
  {
    id: 'water_bromeliads', group: 'water', label: 'Flush bromeliads weekly',
    keywords: ['bromeliad', 'plants', 'cups', 'water', 'larvae'], lines: ['mosquito'], season: 'all',
    copy: "If you have bromeliads, the cup of each plant holds water, and they're the most productive mosquito breeding site I find in SWFL yards. Flush the cups with the hose once a week so the larvae wash out before they can mature.",
  },
  {
    id: 'water_bird_bath', group: 'water', label: 'Change bird bath water every 3 days',
    keywords: ['bird bath', 'fountain', 'water'], lines: ['mosquito'], season: 'all',
    copy: "Water changed every few days never reaches the pupal stage. Fountains and bubblers do the same job on their own — larvae can't develop in moving water.",
  },
  {
    id: 'water_gutters', group: 'water', label: 'Keep gutters draining',
    keywords: ['gutters', 'downspout', 'roof', 'storm'], lines: ['mosquito', 'pest'], season: 'wet',
    copy: "A clogged gutter holds water for days after a storm — a nursery right above the entry. Downspouts should carry water a few feet from the foundation, not dump it at the slab.",
  },
  {
    id: 'water_lanai_drains', group: 'water', label: 'Flush lanai and patio drains',
    keywords: ['drain', 'lanai', 'patio', 'catch basin'], lines: ['mosquito'], season: 'wet',
    copy: "Floor drains and catch basins on the lanai hold a few inches of still water between rains. A bucket of water down each one weekly flushes the larvae before they mature.",
  },
  {
    id: 'water_floor_mats', group: 'water', label: 'Flip floor mats after rain',
    pests: ['Roaches', 'Earwigs'], keywords: ['mat', 'door mat', 'rug', 'rubber', 'lanai', 'water'], lines: ['mosquito', 'pest'], season: 'wet',
    copy: "Rubber-backed door mats and lanai floor mats hold a surprising amount of water underneath — enough for mosquitos to breed in, and a cool damp shelter for roaches and earwigs right at the threshold. After a rain, flip them or hang them on the rail until they're dry.",
  },

  // ── Kitchen and pantry ────────────────────────────────────────────────
  {
    id: 'interior_pet_bowls', group: 'kitchen', label: 'Pet bowls up overnight',
    pests: ['Ants'], keywords: ['pet', 'dog', 'cat', 'bowl', 'food', 'ants'], lines: ['pest'], season: 'all',
    copy: "A bowl left down is an open food and water source all night, and it's the most common thing I trace an ant trail back to. Up at bedtime, down at breakfast.",
  },
  {
    id: 'interior_trash_night', group: 'kitchen', label: 'Kitchen trash out at night',
    pests: ['Ants', 'Roaches'], keywords: ['trash', 'garbage', 'can', 'roach'], lines: ['pest'], season: 'all',
    copy: "Roaches and ants forage overnight. An empty can gives them nothing on the shift they're actually working — the difference shows in a week.",
  },
  {
    id: 'interior_sealed_pantry', group: 'kitchen', label: 'Seal flour, rice, cereal, pet food',
    keywords: ['pantry', 'flour', 'rice', 'cereal', 'moths', 'weevils'], lines: ['pest'], season: 'all',
    copy: "Pantry pests usually arrive inside the bag from the store. Sealed containers keep one bad bag from spreading to the whole shelf, and they let you spot which one it was.",
  },
  {
    id: 'interior_range_grease', group: 'kitchen', label: 'Degrease behind the range',
    pests: ['Roaches'], keywords: ['stove', 'range', 'grease', 'oven', 'german roach'], lines: ['pest'], season: 'all',
    copy: "The grease film behind and under a range is a calorie source that can sustain a German roach population on its own. Once a season, pull the range and degrease the wall, the floor, and the sides of the cabinets.",
  },
  {
    id: 'interior_cardboard', group: 'kitchen', label: 'Cardboard boxes to plastic bins',
    pests: ['Roaches', 'Silverfish'], keywords: ['cardboard', 'boxes', 'garage', 'closet', 'storage'], lines: ['pest'], season: 'all',
    copy: "Corrugated cardboard is roach harborage — they feed on the glue and lay egg cases in the flutes. Boxes in the garage and closets do better as plastic bins with lids, and a move-in is when it matters most.",
  },

  // ── Sealing them out ──────────────────────────────────────────────────
  {
    id: 'seal_door_sweeps', group: 'sealing', label: 'Replace worn door sweeps',
    keywords: ['door', 'sweep', 'gap', 'daylight', 'garage', 'mice'], lines: ['pest', 'rodent'], season: 'all',
    copy: "If you can see daylight under a door, that's the gap. A mouse fits through about a quarter inch, a rat through a half. The bottom corners of the garage door are the entry I find most often, and a new sweep closes it.",
  },
  {
    id: 'seal_penetrations', group: 'sealing', label: 'Seal around pipes and vents',
    keywords: ['pipe', 'vent', 'dryer', 'conduit', 'wall', 'gap'], lines: ['pest', 'rodent'], season: 'all',
    copy: "Every pipe, vent, and conduit through the wall leaves a gap around it. Copper mesh packed into the gap with sealant over it shuts the direct route from the wall void into the house — it's the repair that outlasts any treatment.",
  },
  {
    id: 'seal_screen_tears', group: 'sealing', label: 'Patch lanai screen tears',
    pests: ['Wasps'], keywords: ['screen', 'lanai', 'tear', 'wasps', 'mosquito'], lines: ['mosquito', 'pest'], season: 'all',
    copy: "One tear in the lanai screen is a permanent open door for mosquitos and wasps, no matter what I treat outside it. A patch kit from the hardware store handles it in a few minutes.",
  },
  {
    id: 'seal_soffit_vents', group: 'sealing', label: 'Check soffit and gable vents',
    keywords: ['soffit', 'gable', 'attic', 'vent', 'screen', 'rats'], lines: ['rodent'], season: 'all',
    copy: "Roof rats come in through soffit gaps and torn gable-vent screens far more often than through the ground floor. Quarter-inch hardware cloth over the vent keeps the airflow and closes the route.",
  },

  // ── Rodents ───────────────────────────────────────────────────────────
  {
    id: 'rodent_bird_feeders', group: 'rodent', label: 'Move bird feeders off the house',
    keywords: ['bird', 'feeder', 'seed', 'rats'], lines: ['rodent'], season: 'all',
    copy: "Spilled seed under a feeder is the most reliable rat and mouse food source in a yard. Move the feeder well away from the house, add a catch tray, and sweep under it — or take it down for a few weeks while we work.",
  },
  {
    id: 'rodent_fallen_fruit', group: 'rodent', label: 'Pick up fallen fruit',
    keywords: ['fruit', 'citrus', 'mango', 'avocado', 'rats'], lines: ['rodent'], season: 'all',
    copy: "Fallen citrus, mango, and avocado are a roof rat's favorite food, and a tree in season will hold a population by itself. Picking up drops every couple of days takes that food away.",
  },
  {
    id: 'rodent_trash_lids', group: 'rodent', label: 'Lids on, cans off the wall',
    keywords: ['trash', 'can', 'lid', 'garage', 'rats'], lines: ['rodent'], season: 'all',
    copy: "An open can against the garage wall is a food source and a covered runway in one. Lids that latch, and the cans a few feet off the wall, remove both.",
  },

  // ── Termite ───────────────────────────────────────────────────────────
  {
    id: 'termite_wood_soil', group: 'termite', label: 'Break wood-to-soil contact',
    keywords: ['fence', 'post', 'deck', 'trellis', 'soil', 'termite'], lines: ['termite'], season: 'all',
    copy: "Fence posts, deck supports, and trellises in direct contact with soil are a subterranean termite's easiest route into wood. Where you can, a concrete or metal footing breaks that contact and puts the wood back where I can inspect it.",
  },
  {
    id: 'termite_slab_edge', group: 'termite', label: 'Keep the slab edge visible',
    keywords: ['slab', 'grade', 'soil', 'stucco', 'mud tube'], lines: ['termite'], season: 'all',
    copy: "Soil or mulch above the top of the slab covers the inspection gap and lets termites tube straight into the wall unseen. Keeping a few inches of slab edge visible all the way around is your early warning — a mud tube there is easy to spot.",
  },
  {
    id: 'termite_stations', group: 'termite', label: 'Leave the bait stations alone',
    keywords: ['station', 'bait', 'landscaper', 'mulch'], lines: ['termite'], season: 'all',
    copy: "The stations around the house need to stay where I set them, with the lids clear of mulch and sod. If a landscaper pulls one or buries one, let me know and I'll reset it at the next visit.",
  },

  // ── Lawn ──────────────────────────────────────────────────────────────
  {
    id: 'lawn_water_morning', group: 'lawn', label: 'Water the lawn in the early morning',
    keywords: ['irrigation', 'sprinkler', 'water', 'fungus', 'timer', 'night', 'leaf spot'], lines: ['lawn', 'mosquito'], season: 'wet',
    findings: ['gray_leaf_spot', 'large_patch'],
    copy: "Overnight watering leaves the blades wet until morning, which is exactly what fungus needs. Set the irrigation to finish around sunrise; the morning sun dries the turf by midday and gives fungus and mosquitos far less to work with.",
  },
  {
    id: 'lawn_irrigation_portal', group: 'lawn', label: 'Add your irrigation settings to the portal',
    keywords: ['irrigation', 'sprinkler', 'schedule', 'portal', 'zones', 'run time', 'days'], lines: ['lawn'], season: 'all',
    // Conditional: the picker marks this "already on file" when the
    // customer's property row actually carries irrigation settings —
    // watering days, run minutes, inches per week, zones or the rain
    // sensor — NOT the irrigation_system flag, which defaults on
    // (migration 20260828000002). The live note renders the My Property link.
    condition: 'irrigation_on_file',
    link: { label: 'My Property', path: '/portal?tab=property' },
    copy: "If you add your irrigation settings to your Waves portal — the watering days, run minutes per zone, and whether you have a rain sensor — under My Property, I can compare what the lawn is actually getting against what it needs each season and adjust the program to match. It takes about two minutes and makes every lawn report after it more accurate.",
  },
  {
    id: 'lawn_sharp_blade', group: 'lawn', label: 'Sharpen the mower blade',
    keywords: ['mower', 'blade', 'mow', 'brown tips'], lines: ['lawn'], season: 'all',
    findings: ['scalping'],
    copy: "A dull blade tears the leaf instead of cutting it. Torn tips brown out and are the entry point for fungus, so a sharpened blade once a season shows up as a greener lawn a week later.",
  },

  // Lawn seed (owner 2026-09-29, scope round 3c; copy chosen under the owner's
  // 2026-10-03 lawn authorization, list sent to the owner to read). Keyed to the seasonal watch list (`months` are only the
  // months the owner has supplied: October, plus the two seasonal notes) and
  // to the finding families in LAWN_FINDINGS. ADVICE only: no result timelines,
  // no product names, no mowing-height or watering numbers.
  {
    id: 'lawn_bag_clippings', group: 'lawn', label: 'Bag clippings while fungus is active',
    keywords: ['clippings', 'bag', 'mulch', 'fungus', 'leaf spot', 'mower'], lines: ['lawn'], season: 'all',
    findings: ['gray_leaf_spot', 'large_patch'], months: [10],
    copy: "Mowing carries fungus spores from sick turf to healthy turf on the deck and in the clippings. While leaf spot or another fungus is active, bag the clippings and rinse the mower deck afterward. If a crew mows for you, ask them to do the same.",
  },
  {
    id: 'lawn_shade_dry_between', group: 'lawn', label: 'Let shaded areas dry between waterings',
    keywords: ['shade', 'wet', 'patch', 'fungus', 'large patch', 'irrigation'], lines: ['lawn'], season: 'all',
    findings: ['large_patch', 'shade'], months: [10],
    copy: "Turf in the shade stays wet much longer than turf in full sun, and wet shaded turf is where large patch and other fungus get started. If one sprinkler zone covers both sun and shade, check that the shaded part is not still soggy when the sunny part is dry.",
  },
  {
    id: 'lawn_skip_extra_nitrogen', group: 'lawn', label: 'Skip the extra nitrogen on a weak lawn',
    keywords: ['fertilizer', 'nitrogen', 'yellow', 'weak', 'root rot', 'take-all'], lines: ['lawn'], season: 'all',
    findings: ['take_all', 'large_patch'], months: [10],
    copy: "When a lawn looks yellow and thin, the first thought is to feed it. If the roots are the problem, extra nitrogen pushes leaf growth the roots cannot keep up with. Check with me before adding fertilizer of your own, and I will tell you what the lawn needs.",
  },
  {
    id: 'lawn_dont_pull_sedge', group: 'lawn', label: "Don't pull sedge",
    keywords: ['sedge', 'nutsedge', 'kyllinga', 'pull', 'tubers', 'weeds'], lines: ['lawn'], season: 'all',
    findings: ['sedges'], months: [10],
    copy: "Sedge grows from small underground tubers, and pulling the plant usually leaves the tubers behind to send up new ones. Pulling can leave you with more sedge than you started with. Leave it in place and point it out to me.",
  },
  {
    id: 'lawn_dollarweed_wet_soil', group: 'lawn', label: 'Dollarweed likes soil that stays wet',
    keywords: ['dollarweed', 'pennywort', 'wet', 'sprinkler', 'drainage', 'weeds'], lines: ['lawn'], season: 'all',
    findings: ['dollarweed'], months: [10],
    copy: "Dollarweed thrives where the soil stays wet. If it keeps coming back in one spot, look for a sprinkler head that overlaps its neighbor, a small leak, or a low spot that holds water. Correcting the wet spot is usually the first step.",
  },
  {
    id: 'lawn_chinch_hot_edge', group: 'lawn', label: 'Watch the hot strip by the driveway',
    keywords: ['chinch', 'chinch bugs', 'driveway', 'sidewalk', 'edge', 'hot', 'dry'], lines: ['lawn'], season: 'all',
    findings: ['chinch_bugs', 'drought'], months: [10],
    copy: "The strip of lawn along a driveway, sidewalk, or street heats up first and dries out first, and that is where chinch bugs like to settle. Make sure the sprinklers reach that strip, and let me know if it starts to yellow while the rest of the lawn stays green.",
  },
  {
    id: 'lawn_moths_at_dusk', group: 'lawn', label: 'Moths at dusk can mean caterpillars',
    keywords: ['moths', 'webworm', 'sod webworm', 'armyworm', 'chewed', 'caterpillar', 'dusk'], lines: ['lawn'], season: 'all',
    findings: ['sod_webworm', 'armyworm'], months: [10],
    copy: "Small tan moths flying up from the grass as you walk across it, or around the yard at dusk, can be an early sign that sod webworm or armyworm caterpillars will follow. If you see them, let me know so I can take a closer look at the lawn.",
  },
  {
    id: 'lawn_digging_animals', group: 'lawn', label: 'Digging animals can be a grub clue',
    keywords: ['grubs', 'white grubs', 'digging', 'armadillo', 'raccoon', 'holes', 'birds'], lines: ['lawn'], season: 'all',
    findings: ['white_grubs'], months: [10],
    copy: "Armadillos, raccoons, and birds dig up lawns looking for grubs and other insects in the soil. If something keeps digging in the same area, tell me where. It can point to what is living in the root zone, and it is worth a look.",
  },
  {
    id: 'lawn_spongy_soil', group: 'lawn', label: 'Soft, spongy soil is worth a call',
    keywords: ['mole cricket', 'mole crickets', 'spongy', 'tunnel', 'soft', 'ridges'], lines: ['lawn'], season: 'all',
    findings: ['mole_crickets'], months: [10],
    copy: "Mole crickets tunnel just under the surface, which can leave the ground soft and spongy, sometimes with raised, wandering ridges. If you notice that underfoot, let me know where, and I will check the area at my next visit.",
  },
  {
    id: 'lawn_mow_one_third', group: 'lawn', label: 'Never take more than a third off',
    keywords: ['mow', 'mowing', 'height', 'third', 'scalp', 'scalping', 'tall'], lines: ['lawn'], season: 'all',
    findings: ['scalping'],
    copy: "Cutting more than a third of the blade in one mow shocks the grass and can leave a scalped, stressed lawn. If the lawn has gotten tall, raise the mower for the first cut and bring it back down over the next few mows. If a crew mows for you, pass this along.",
  },
  {
    id: 'lawn_mow_after_weed_treatment', group: 'lawn', label: 'Ask before mowing after a weed treatment',
    keywords: ['mow', 'herbicide', 'sedge', 'wait', 'weeds', 'treatment'], lines: ['lawn'], season: 'all',
    findings: ['sedges', 'broadleaf_weeds', 'crabgrass'],
    copy: "Mowing too soon after a weed treatment cuts the weeds before the treatment has worked into them. How long to wait depends on the product I used, so ask me before the next mow. If a crew mows for you, ask them to check with me first.",
  },
  {
    id: 'lawn_check_heads_after_mow', group: 'lawn', label: 'Check the sprinkler heads after a mow',
    keywords: ['heads', 'coverage', 'dry spot', 'sprinkler', 'irrigation', 'mow crew', 'broken'], lines: ['lawn'], season: 'all',
    findings: ['drought'],
    copy: "Mowers and edgers knock sprinkler heads out of line and sometimes crack them. That leaves a dry spot in one place and a soggy spot in another. Run each zone once after the lawn is mowed and watch for heads that spray the wrong way, spray weakly, or sit buried in grass.",
  },
  {
    id: 'lawn_deep_water', group: 'lawn', label: 'Water deeper, not more often',
    keywords: ['deep', 'shallow', 'roots', 'irrigation', 'sprinkler', 'timer', 'frequency'], lines: ['lawn'], season: 'all',
    findings: ['drought', 'take_all'],
    copy: "Short, frequent runs keep the top of the soil wet and the roots shallow. Longer runs on fewer days, within your area's watering rules, send water deeper and give the roots a reason to follow it.",
  },
  {
    id: 'lawn_shade_thin_turf', group: 'lawn', label: 'Thin turf under trees is often a light problem',
    keywords: ['shade', 'thin', 'trees', 'canopy', 'light', 'groundcover'], lines: ['lawn'], season: 'all',
    findings: ['shade'],
    copy: "Grass under a tree canopy often thins out because it is not getting enough light. Trimming up the lower branches lets more light through. Where the shade is heavy, mulch or a shade groundcover under the tree can look better than grass that struggles.",
  },
  {
    id: 'lawn_thatch_half_inch', group: 'lawn', label: 'Thick thatch holds water and insects',
    keywords: ['thatch', 'spongy', 'half inch', 'water', 'insects', 'fertilizer'], lines: ['lawn'], season: 'all',
    findings: ['thatch'],
    copy: "Thatch is the layer of dead and living stems above the soil. Once it is thicker than about half an inch, it holds water against the surface, shelters insects, and keeps water and fertilizer from reaching the soil. Taking no more than a third off in a mow and going easy on nitrogen both help keep it from building up.",
  },
  {
    id: 'lawn_treated_weeds_leave', group: 'lawn', label: 'Leave treated weeds in place',
    keywords: ['weeds', 'yellow', 'brown', 'pull', 'wait', 'treated'], lines: ['lawn'], season: 'all',
    findings: ['sedges', 'broadleaf_weeds', 'crabgrass', 'dollarweed'],
    copy: "Weeds that have been treated can turn yellow or brown while the treatment works through them. Pulling them early can interrupt that, so leave them in place until my next visit. If a weed looks unchanged, point it out to me.",
  },
  {
    id: 'lawn_cooler_nights', group: 'lawn', label: 'Cooler nights slow the lawn',
    keywords: ['color', 'cool', 'cold', 'dormant', 'winter', 'fall', 'lighter'], lines: ['lawn'], season: 'all',
    months: [10, 11],
    copy: "As nights cool in the fall, warm-season grass grows more slowly, and the whole lawn can lighten a little as it heads toward its winter rest. If one patch looks different from the rest instead of the whole lawn easing evenly, tell me.",
  },
  {
    id: 'lawn_early_spring_low_mow', group: 'lawn', label: 'Hold off on a very low mow in early spring',
    keywords: ['scalp', 'scalping', 'spring', 'low mow', 'mow', 'green up'], lines: ['lawn'], season: 'all',
    months: [2, 3],
    copy: "A very low mow in late winter can set back turf that is just waking up. Keep the mower at your normal setting until the lawn is growing steadily, and ask me if you are not sure what is right for your grass.",
  },

  // ── Trees and shrubs ──────────────────────────────────────────────────
  {
    id: 'ts_ants_on_trunk', group: 'tree_shrub', label: 'Ants on the trunk = scale or aphids',
    keywords: ['ants', 'trunk', 'scale', 'aphids', 'sooty mold', 'honeydew'], lines: ['tree_shrub', 'pest'], season: 'all', watchKeys: ['scale', 'sooty_mold', 'aphids'],
    copy: "Ants running up and down a trunk are usually farming scale or aphids for their honeydew, and the black sooty mold on the leaves is growing on that honeydew. If you see the ant traffic, let me know — it tells me exactly where the scale is.",
  },
  {
    id: 'ts_deep_water', group: 'tree_shrub', label: 'Deep and infrequent, not daily',
    keywords: ['shrubs', 'water', 'root rot', 'wilting', 'yellow'], lines: ['tree_shrub'], season: 'all', watchKeys: ['root_rot'],
    copy: "Root rot from overwatering looks like drought — wilting and yellowing — and the reflex is to water more. Established shrubs want deep, infrequent watering; let the top inch of soil dry between runs.",
  },
  {
    id: 'ts_mulch_trunk', group: 'tree_shrub', label: 'Keep mulch off the trunk',
    keywords: ['mulch', 'trunk', 'volcano', 'borers', 'bark'], lines: ['tree_shrub'], season: 'all',
    copy: "Mulch piled against the trunk keeps the bark wet and invites borers and rot at the collar. Pull it back into a ring a few inches from the trunk — a donut, not a volcano.",
  },
  {
    id: 'ts_black_film', group: 'tree_shrub', label: 'Black film on leaves comes from insects',
    keywords: ['sooty mold', 'black', 'sticky', 'scale'], lines: ['tree_shrub'], season: 'all', watchKeys: ['scale', 'sooty_mold'],
    copy: "That black film on leaves usually grows on the sticky honeydew insects leave behind, and it fades once the insects are under control.",
  },
  {
    id: 'ts_leaf_undersides', group: 'tree_shrub', label: 'Check leaf undersides',
    keywords: ['whitefly', 'underside', 'sticky'], lines: ['tree_shrub'], season: 'all', watchKeys: ['whitefly', 'scale'],
    copy: "Whitefly and scale live on the underside of leaves, so that's the best place to look between visits.",
  },
  {
    id: 'ts_dusty_leaves_dry', group: 'tree_shrub', label: 'Dusty leaves in dry weeks',
    keywords: ['mites', 'dusty', 'dry', 'rinse'], lines: ['tree_shrub'], season: 'dry', watchKeys: ['spider_mites'],
    copy: "Rinsing dusty shrubs with plain water during dry spells helps keep mites from building up.",
  },
  {
    id: 'ts_chewed_new_leaves', group: 'tree_shrub', label: 'Chewed new leaves',
    keywords: ['chewed', 'caterpillar', 'holes'], lines: ['tree_shrub'], season: 'all', watchKeys: ['caterpillars'],
    copy: "Fresh chewing on new growth is often caterpillars; a quick look at dusk can spot them.",
  },
  {
    id: 'ts_yellow_new_leaves', group: 'tree_shrub', label: 'Yellow new leaves with green veins',
    keywords: ['yellow', 'chlorosis', 'iron', 'veins'], lines: ['tree_shrub'], season: 'all', watchKeys: ['chlorosis'],
    copy: "Yellow new leaves with green veins usually mean the plant can't pull iron or manganese from the soil, which takes a few weeks to green up after treatment.",
  },
  {
    id: 'ts_palm_dont_trim_yellow', group: 'tree_shrub', label: "Don't trim yellow palm fronds",
    keywords: ['palm', 'yellow fronds', 'trim', 'prune'], lines: ['tree_shrub'], season: 'all', watchKeys: ['palm_potassium_deficiency', 'palm_magnesium_deficiency'],
    copy: "Leave yellowing lower palm fronds on; the palm pulls nutrients from them, and cutting them speeds the decline.",
  },
  {
    id: 'ts_palm_nine_and_three', group: 'tree_shrub', label: "Never prune above 9 and 3 o'clock",
    keywords: ['palm', 'prune', 'hurricane cut'], lines: ['tree_shrub'], season: 'all',
    copy: "When fronds are trimmed, keep everything above the 9-to-3 o'clock line on the palm.",
  },
  {
    id: 'ts_palm_fertilizer_canopy', group: 'tree_shrub', label: 'Keep fertilizer off the trunk',
    keywords: ['palm', 'fertilizer', 'trunk'], lines: ['tree_shrub'], season: 'all', watchKeys: ['palm_potassium_deficiency', 'palm_magnesium_deficiency'],
    copy: "Palm fertilizer works spread under the whole canopy, not piled against the trunk.",
  },
  {
    id: 'ts_water_early_morning', group: 'tree_shrub', label: 'Water beds in the early morning',
    keywords: ['water', 'morning', 'leaf spot'], lines: ['tree_shrub'], season: 'wet', watchKeys: ['leaf_spot'],
    copy: "Watering beds early in the morning lets leaves dry fast, which keeps leaf spot down.",
  },
  {
    id: 'ts_soggy_beds_root_rot', group: 'tree_shrub', label: 'Wet beds invite root rot',
    keywords: ['soggy', 'wet', 'root rot', 'sprinkler'], lines: ['tree_shrub'], season: 'wet', watchKeys: ['root_rot'],
    copy: "Beds that stay soggy for days are where root rot starts; check for a stuck zone or a broken head.",
  },
  {
    id: 'ts_new_plantings_water', group: 'tree_shrub', label: 'New plantings need extra water the first summer',
    keywords: ['new plants', 'heat', 'wilt'], lines: ['tree_shrub'], season: 'all', watchKeys: ['heat_stress', 'heat_drought_decline'],
    copy: "Shrubs planted in the last year need more water than established ones through their first summer.",
  },
  {
    id: 'ts_wait_prune_cold', group: 'tree_shrub', label: 'Wait to prune cold damage',
    keywords: ['cold', 'freeze', 'brown', 'prune'], lines: ['tree_shrub'], season: 'dry', watchKeys: ['cold_freeze_damage'],
    copy: "After a cold snap, wait until spring growth starts before cutting back damaged branches.",
  },
  {
    id: 'ts_fresh_mulch_weeds', group: 'tree_shrub', label: 'Weeds in fresh mulch',
    keywords: ['weeds', 'mulch', 'beds'], lines: ['tree_shrub'], season: 'all', watchKeys: ['bed_weeds'],
    copy: "A thin layer of fresh mulch helps the pre-emergent hold weeds back between treatments.",
  },
  {
    id: 'ts_blooms_gentler', group: 'tree_shrub', label: 'Blooming shrubs get gentler treatment',
    keywords: ['bees', 'blooms', 'flowers'], lines: ['tree_shrub'], season: 'all',
    copy: "We time insect treatments around blooms to protect bees, so flowering shrubs may get a lighter touch that visit.",
  },

  // ── Pets and fleas ────────────────────────────────────────────────────
  {
    id: 'flea_bedding_vacuum', group: 'fleas', label: 'Hot-wash bedding, vacuum daily',
    pests: ['Fleas'], keywords: ['flea', 'dog', 'cat', 'bedding', 'vacuum', 'eggs'], lines: ['pest'], season: 'all',
    copy: "Flea eggs and larvae live in the bedding and carpet where the pet sleeps, not on the pet. A hot wash of the bedding weekly and a daily vacuum of those spots for a couple of weeks removes the stages a treatment can't reach — and empty the vacuum outside.",
  },
  // ── Bed bugs (service tips, owner-approved 2026-10-02) ────────────────────────────────────────────────────
  {
    id: 'bb_dryer_heat', group: 'bed_bugs', label: "Dryer on high, 30 minutes",
    keywords: ["laundry", "dryer", "bedding", "clothes", "heat"], lines: ["pest"], season: 'all',
    services: ["bed_bug_treatment"],
    copy: "Heat is what bed bugs can't take. Run bedding, clothes, and anything else that can handle it through the dryer on high for at least 30 minutes; the dryer does the work, not the wash. Bag it at the bed and carry the bag to the machine so nothing drops on the way.",
  },
  {
    id: 'bb_stay_put', group: 'bed_bugs', label: "Keep sleeping in your own bed",
    keywords: ["couch", "bedroom", "sleep", "spread", "move rooms"], lines: ["pest"], season: 'all',
    services: ["bed_bug_treatment"],
    copy: "It's natural to want to sleep on the couch, but bed bugs follow the person, and moving rooms carries them to a new spot that then needs treating too. Keep sleeping in your own bed so they keep coming to the treated room.",
  },
  {
    id: 'bb_no_foggers', group: 'bed_bugs', label: "Skip store-bought foggers",
    keywords: ["fogger", "bug bomb", "spray", "store", "over the counter"], lines: ["pest"], season: 'all',
    services: ["bed_bug_treatment"],
    copy: "Foggers and store sprays don't reach where bed bugs hide, and they push them deeper into the walls and into the next room. If you want to help, vacuum the mattress seams and the bed frame, then empty the vacuum outside.",
  },
  {
    id: 'bb_encasements', group: 'bed_bugs', label: "Zippered mattress encasements",
    keywords: ["encasement", "mattress", "box spring", "cover", "zipper"], lines: ["pest"], season: 'all',
    services: ["bed_bug_treatment"],
    copy: "A zippered encasement made for bed bugs closes in any that are inside the mattress and box spring, and its smooth outside leaves them nowhere to hide. Leave it on for at least a year; they can go many months without feeding.",
  },
  {
    id: 'bb_travel', group: 'bed_bugs', label: "Luggage on the rack when traveling",
    keywords: ["hotel", "travel", "suitcase", "luggage", "trip"], lines: ["pest"], season: 'all',
    services: ["bed_bug_treatment"],
    copy: "Most bed bugs come home in a suitcase. At a hotel, keep the bag on the luggage rack instead of the bed or the floor, and when you get home, run the clothes through the dryer before putting them away.",
  },
  {
    id: 'bb_clutter', group: 'bed_bugs', label: "Clear the floor around the bed",
    keywords: ["clutter", "boxes", "under the bed", "storage", "piles"], lines: ["pest"], season: 'all',
    services: ["bed_bug_treatment"],
    copy: "Every box and pile near the bed is another hiding place the treatment can't reach. Clearing the floor around and under the bed, and keeping it clear between visits, leaves them in the places I treat.",
  },

  // ── German roaches (service tips, owner-approved 2026-10-02) ──────────────────────────────────────────────
  {
    // German roach services only: cockroach_control and pest_initial_roach
    // are priced on the native-roach scale, so German-roach advice is not
    // theirs (Codex #5582).
    id: 'gr_bait_spots', group: 'roaches', label: "Clean around the bait spots",
    keywords: ["bait", "gel", "cabinet", "wipe", "cleaner"], lines: ["pest"], season: 'all',
    services: ["german_roach", "german_roach_initial", "pest_initial_german_knockdown"],
    copy: "The small dots of bait in the cabinet corners and hinges are doing the work. Cleaner wiped over them, or anything sprayed near them, makes roaches stay away, so for the next few weeks clean around those spots instead of over them.",
  },
  {
    id: 'gr_no_store_spray', group: 'roaches', label: "No store-bought roach spray",
    keywords: ["spray", "fogger", "raid", "store", "over the counter"], lines: ["pest"], season: 'all',
    services: ["german_roach", "german_roach_initial", "pest_initial_german_knockdown"],
    copy: "Store sprays and foggers scatter German roaches into the walls and teach them to avoid the bait. If you see one, a paper towel and the trash is the better move while the bait works through the colony.",
  },
  {
    id: 'gr_dry_at_night', group: 'roaches', label: "Counters and sink dry at bedtime",
    keywords: ["sink", "counter", "dishes", "water", "night"], lines: ["pest"], season: 'all',
    services: ["german_roach", "german_roach_initial", "pest_initial_german_knockdown"],
    copy: "German roaches can't go long without water. Wiping the counters and sink dry before bed, with no dishes left soaking, takes away what they come out for at night and leaves the bait as their easiest meal.",
  },
  {
    id: 'gr_hitchhikers', group: 'roaches', label: "Unpack deliveries outside",
    pests: ['Roaches'], keywords: ["delivery", "grocery", "appliance", "secondhand", "moving"], lines: ["pest"], season: 'all',
    services: ["german_roach", "german_roach_initial", "pest_initial_german_knockdown"],
    copy: "German roaches usually ride in: grocery boxes, used appliances, and secondhand furniture. Unpack deliveries in the garage or outside, and get the cardboard out of the house the same day.",
  },

  // ── Palmetto bugs (service tips, owner-approved 2026-10-02) ───────────────────────────────────────────────
  {
    id: 'pal_dry_drains', group: 'moisture', label: "Run water in unused drains",
    pests: ['Roaches'], keywords: ["drain", "guest bath", "tub", "laundry sink", "palmetto"], lines: ["pest"], season: 'all',
    // Every general-pest identity: prod's one-time visit is the admin-created
    // one_time_pest_control row, migration-built databases its twin
    // pest_initial_cleanout (sms-book-funnel-map.js).
    services: GENERAL_PEST_SERVICES,
    copy: "A drain nobody uses (a guest tub, a laundry sink, a floor drain in the garage) dries out its trap, and palmetto bugs come up through it from the line. Run water in each one once a week so the trap stays full.",
  },

  // ── Fleas and ticks (service tips, owner-approved 2026-10-02) ─────────────────────────────────────────────
  {
    id: 'flea_keep_vacuuming', group: 'fleas', label: "Keep vacuuming after the treatment",
    keywords: ["vacuum", "carpet", "after treatment", "still seeing fleas", "cocoon"], lines: ["pest"], season: 'all',
    services: ["flea_tick"],
    copy: "Flea pupae sit in cocoons the treatment can't reach and hatch when something moves nearby, so you may still see a few for a couple of weeks. Vacuuming every day brings them out sooner, onto the treated carpet.",
  },
  {
    id: 'flea_pet_prevention', group: 'fleas', label: "Pets on their flea prevention",
    keywords: ["pet", "dog", "cat", "vet", "flea collar"], lines: ["pest"], season: 'all',
    services: ["flea_tick"],
    copy: "Treating the house handles the fleas waiting there, but a pet without its own protection carries new ones back in. Ask your vet which preventive fits your pet and keep it on schedule while we work.",
  },
  {
    id: 'flea_shady_spots', group: 'fleas', label: "Open up where pets rest outside",
    pests: ['Fleas'], keywords: ["yard", "shade", "deck", "fence", "dog run"], lines: ["pest"], season: 'all',
    services: ["flea_tick"],
    copy: "Outside, fleas develop in the shady, sheltered spots where pets lie down: under decks, along fences, beneath shrubs. Keeping those spots raked and open to the sun makes them a poor place for fleas to grow.",
  },
  {
    // Tick visits only: flea_tick is the flea-only Flea Control Service
    // (20260704000010), so tick advice never follows a flea treatment (Codex
    // #5582).
    id: 'tick_mow_edges', group: 'fleas', label: "Mow short, clear the yard edges",
    keywords: ["tall grass", "brush", "leaf litter", "edges", "mow"], lines: ["pest"], season: 'all',
    services: ["tick_control"],
    copy: "Ticks wait on tall grass and brush for something to walk past. Keeping the lawn mowed and the leaf litter raked up along the edges of the yard takes away the places they wait.",
  },
  {
    id: 'tick_wood_line', group: 'fleas', label: "A dry strip at the wood line",
    keywords: ["woods", "wood chips", "gravel", "border", "play set"], lines: ["pest"], season: 'all',
    services: ["tick_control"],
    copy: "Where the lawn meets woods or brush, a 3-foot strip of wood chips or gravel makes a dry border ticks don't like to cross. Keep play sets and seating on the lawn side of it.",
  },
  {
    id: 'tick_check', group: 'fleas', label: "Check for ticks after yard work",
    keywords: ["check", "kids", "pets", "after yard work", "bite"], lines: ["pest"], season: 'all',
    services: ["tick_control"],
    copy: "After time at the edges of the yard, check yourself, the kids, and the pets: behind the knees, the waistband, the hairline, and the ears. Checking soon after you come in finds a tick before it settles in.",
  },

  // ── Fire ants (service tips, owner-approved 2026-10-02) ───────────────────────────────────────────────────
  {
    id: 'fa_leave_mounds', group: 'fire_ants', label: "Leave the mounds alone",
    keywords: ["mound", "dig", "kick", "drench", "bait"], lines: ["pest"], season: 'all',
    services: ["fire_ant"],
    copy: "After a fire ant treatment, digging, kicking, or drenching a mound sends the colony to start over a few feet away. Leave the mounds alone and let the workers carry the bait back to the queen; it works through the colony over the next few weeks.",
  },
  {
    id: 'fa_bait_dry', group: 'fire_ants', label: "Skip the next sprinkler cycle",
    keywords: ["sprinkler", "irrigation", "rain", "bait", "dry"], lines: ["pest"], season: 'all',
    services: ["fire_ant"],
    copy: "Fire ant bait only works while it's dry enough for the workers to pick it up. If your sprinklers are set to run the morning after a treatment, skipping that one cycle gives the bait its chance.",
  },
  {
    id: 'fa_no_store_products', group: 'fire_ants', label: "Nothing else on the mounds",
    keywords: ["store", "drench", "dust", "granules", "home depot"], lines: ["pest"], season: 'all',
    services: ["fire_ant"],
    copy: "Store-bought drenches and dusts kill the foragers that carry the bait home, so it never reaches the queen. Give the treatment a few weeks before using anything else on the mounds.",
  },
  {
    id: 'fa_spot_a_mound', group: 'fire_ants', label: "Show the kids what a mound looks like",
    keywords: ["kids", "stings", "pets", "mound", "yard"], lines: ["pest"], season: 'all',
    services: ["fire_ant"],
    copy: "A fire ant mound is a loose pile of soil with no opening on top, and new ones pop up after a rain. Showing the kids what one looks like, and keeping pet bowls off the lawn, keeps stings down while the treatment works.",
  },

  // ── Bees, wasps and mud daubers (service tips, owner-approved 2026-10-02) ─────────────────────────────────
  {
    id: 'bw_dont_seal_active', group: 'stinging', label: "Don't seal a gap bees are using",
    keywords: ["bees", "gap", "wall", "soffit", "seal"], lines: ["pest"], season: 'all',
    services: ["bee_wasp_removal"],
    copy: "If bees are flying in and out of a gap in the wall or soffit, sealing it from outside traps them, and they look for another way out, sometimes into the house. Let me know first; the gap gets sealed once the colony is handled.",
  },
  {
    id: 'bw_cover_sweets', group: 'stinging', label: "Lids on drinks and trash outside",
    pests: ['Wasps'], keywords: ["yellowjacket", "soda", "juice", "lanai", "trash"], lines: ["pest"], season: 'wet',
    services: ["bee_wasp_removal"],
    copy: "Late in the summer, yellowjackets go after sweets and come to open cans, juice boxes, and fruit on the lanai. Cups with lids and trash cans that close keep them from settling in around where you sit.",
  },
  {
    id: 'bw_call_early', group: 'stinging', label: "Call early about a new nest",
    pests: ['Wasps'], keywords: ["nest", "eaves", "paper wasp", "small", "spring"], lines: ["pest"], season: 'all',
    services: ["bee_wasp_removal"],
    copy: "Paper wasps start a nest under the eaves as a small cluster in spring. A nest the size of a golf ball is a quick visit; by late summer the same spot can hold a few dozen wasps. If you see one starting, let me know.",
  },
  {
    id: 'md_rarely_sting', group: 'stinging', label: "Wash off old mud tubes",
    pests: ['Wasps'], keywords: ["mud dauber", "mud tubes", "eaves", "hose", "lanai"], lines: ["pest"], season: 'all',
    services: ["mud_dauber_removal"],
    copy: "Mud daubers are solitary wasps and rarely sting; the mud tubes on the eaves and the lanai are their nurseries. Once the tubes are empty, washing them off with the hose keeps the eaves clean and shows you right away if new building starts.",
  },
  {
    id: 'md_fewer_spiders', group: 'stinging', label: "Fewer spiders, fewer mud daubers",
    pests: ['Spiders'], keywords: ["spiders", "porch light", "bulbs", "eaves", "webs"], lines: ["pest"], season: 'all',
    services: ["mud_dauber_removal"],
    copy: "Mud daubers stock their nests with spiders, so a house with fewer spiders draws fewer daubers. Warm porch bulbs and swept eaves cut down the insects the spiders live on.",
  },

  // ── Mosquito (service tips, owner-approved 2026-10-02) ────────────────────────────────────────────────────
  {
    id: 'mq_pool', group: 'water', label: "Keep the pool and its cover dry",
    keywords: ["pool", "pool cover", "green pool", "pump", "chlorine"], lines: ["mosquito"], season: 'all',
    services: ["mosquito_monthly", "mosquito_recurring", "mosquito_seasonal", "mosquito", "mosquito_one_time", "mosquito_onetime", "mosquito_event"],
    copy: "A pool that's running and chlorinated is no trouble, but a green pool, or a pool cover holding rainwater, can breed mosquitos all season. Keep the pump on its schedule and pump the cover dry after a rain.",
  },
  {
    id: 'mq_tree_holes', group: 'water', label: "Fill holes in trees",
    keywords: ["tree hole", "trunk", "rainwater", "oak", "fill"], lines: ["mosquito"], season: 'all',
    services: ["mosquito_monthly", "mosquito_recurring", "mosquito_seasonal", "mosquito", "mosquito_one_time", "mosquito_onetime", "mosquito_event"],
    copy: "Holes and crotches in large trees hold rainwater, and some mosquitos breed nowhere else. Filling them with sand or expanding foam takes them off the list of breeding spots in the yard.",
  },

  // ── Rodent trapping (service tips, owner-approved 2026-10-02) ─────────────────────────────────────────────
  {
    // Only services that set traps. A one-time rodent visit completes on the
    // diagnostic inspection form and sets none, so these would claim traps
    // that are not out (codex local r4 on #5582).
    id: 'rt_leave_traps', group: 'rodent', label: "Leave the traps where they are",
    keywords: ["traps", "move", "check", "attic", "garage"], lines: ["rodent"], season: 'all',
    services: ["rodent_trapping", "rodent_trapping_followup", "rodent_trapping_followup_3pack", "rodent_trap_check_additional", "rodent_trapping_exclusion", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation", "trap_only_retainer_monthly", "trap_only_retainer_standard", "trap_only_retainer_plus", "rodent_exclusion"],
    copy: "Rats are wary of anything new, so traps work best once they've sat in place a few nights. Moving them or checking them yourself starts that over; I check them at every visit.",
  },
  {
    id: 'rt_note_noises', group: 'rodent', label: "Note when and where you hear them",
    keywords: ["noise", "scratching", "night", "ceiling", "attic"], lines: ["rodent"], season: 'all',
    services: ["rodent_trapping", "rodent_trapping_followup", "rodent_trapping_followup_3pack", "rodent_trap_check_additional", "rodent_trapping_exclusion", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation", "trap_only_retainer_monthly", "trap_only_retainer_standard", "trap_only_retainer_plus", "rodent_exclusion"],
    copy: "The time of night and the room you hear scratching above show me where they're running. A quick note on your phone, like \"2 a.m., over the kitchen,\" helps me put the next traps right on that path.",
  },
  {
    id: 'rt_no_store_bait', group: 'rodent', label: "No store-bought rat bait inside",
    keywords: ["poison", "bait", "smell", "wall", "store"], lines: ["rodent"], season: 'all',
    services: ["rodent_trapping", "rodent_trapping_followup", "rodent_trapping_followup_3pack", "rodent_trap_check_additional", "rodent_trapping_exclusion", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation", "trap_only_retainer_monthly", "trap_only_retainer_standard", "trap_only_retainer_plus", "rodent_exclusion"],
    copy: "A rat that eats store-bought bait usually dies wherever it is, often inside a wall or the attic, where the smell lasts for weeks. Leave the attic to the traps, and let me know before adding anything of your own.",
  },
  {
    id: 'rt_doors_closed', group: 'rodent', label: "Attic and garage doors closed",
    keywords: ["pets", "kids", "dog", "attic door", "garage"], lines: ["rodent"], season: 'all',
    services: ["rodent_trapping", "rodent_trapping_followup", "rodent_trapping_followup_3pack", "rodent_trap_check_additional", "rodent_trapping_exclusion", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation", "trap_only_retainer_monthly", "trap_only_retainer_standard", "trap_only_retainer_plus", "rodent_exclusion"],
    copy: "The traps go where rodents run, not where people go, but a curious dog or child can still reach one in the garage. Keep the garage and attic doors closed while the traps are out.",
  },

  // ── Rodent exclusion (service tips, owner-approved 2026-10-02) ────────────────────────────────────────────
  {
    // Full exclusion only: a mesh or bird-box job seals one opening, not the
    // house (Codex #5582).
    id: 'rx_garage_door', group: 'rodent', label: "Garage door closed at night",
    keywords: ["garage door", "night", "open", "dusk", "entry"], lines: ["rodent"], season: 'all',
    services: ["rodent_exclusion", "rodent_exclusion_only", "rodent_trapping_exclusion", "rodent_trapping_exclusion_sanitation"],
    copy: "An open garage door at night is the widest way into the house; rats and mice walk right in and climb to the attic from there. Closing it at dusk keeps the sealed house sealed.",
  },
  {
    id: 'rx_leave_seals', group: 'rodent', label: "Leave the seals in place",
    keywords: ["mesh", "flashing", "roofer", "a/c tech", "cable"], lines: ["rodent"], season: 'all',
    services: ["rodent_exclusion", "rodent_exclusion_only", "rodent_wire_mesh", "rodent_bird_box", "rodent_trapping_exclusion", "rodent_trapping_exclusion_sanitation"],
    copy: "The mesh, flashing, and sealant at the entry points are what keep them out. If a roofer, A/C tech, or cable installer needs to open one, let me know so it gets checked afterward.",
  },
  {
    id: 'rx_dryer_vent', group: 'rodent', label: "Dryer vent flap closes",
    keywords: ["dryer vent", "flap", "lint", "mouse", "wall vent"], lines: ["rodent"], season: 'all',
    services: ["rodent_exclusion", "rodent_exclusion_only", "rodent_wire_mesh", "rodent_bird_box", "rodent_trapping_exclusion", "rodent_trapping_exclusion_sanitation"],
    copy: "A dryer vent flap stuck open or broken is an easy way in for a mouse. Make sure it swings shut when the dryer is off, and clear the lint so it keeps closing.",
  },
  {
    id: 'rx_after_storms', group: 'rodent', label: "Look at the roofline after storms",
    keywords: ["storm", "hurricane", "soffit", "roof tile", "wind"], lines: ["rodent"], season: 'all',
    services: ["rodent_exclusion", "rodent_exclusion_only", "rodent_wire_mesh", "rodent_bird_box", "rodent_trapping_exclusion", "rodent_trapping_exclusion_sanitation"],
    copy: "High wind can lift a soffit panel or a roof tile and open a gap that wasn't there before. After a storm, a walk around the house looking up at the roofline for anything hanging or out of line catches it early.",
  },

  // ── Rodent bait stations (service tips, owner-approved 2026-10-02) ────────────────────────────────────────
  {
    id: 'rb_leave_stations', group: 'rodent', label: "Leave the rodent stations in place",
    keywords: ["station", "landscaper", "moved", "mulch", "box"], lines: ["rodent"], season: 'all',
    services: ["rodent_bait", "rodent_bait_quarterly", "rodent_bait_setup", "rodent_monitoring", "pest_rodent_quarterly"],
    copy: "The stations along the wall are anchored where rodents travel. If a landscaper moves one or it gets buried in mulch, let me know and I'll set it back at the next visit.",
  },
  {
    id: 'rb_nothing_added', group: 'rodent', label: "Nothing extra in the stations",
    keywords: ["bait", "food", "station", "add", "store"], lines: ["rodent"], season: 'all',
    services: ["rodent_bait", "rodent_bait_quarterly", "rodent_bait_setup", "rodent_monitoring", "pest_rodent_quarterly"],
    copy: "Adding your own bait or food to the stations changes what I'm reading at each visit, and not every product belongs in an outdoor station. If you see more activity, tell me instead and I'll adjust.",
  },
  {
    id: 'rb_clear_wall', group: 'rodent', label: "Keep the wall line clear",
    keywords: ["wall", "hoses", "pots", "foundation", "path"], lines: ["rodent"], season: 'all',
    services: ["rodent_bait", "rodent_bait_quarterly", "rodent_bait_setup", "rodent_monitoring", "pest_rodent_quarterly"],
    copy: "Rodents run along walls, so stations work best with a clear path along the foundation. Keeping hoses, pots, and stored things a foot off the wall keeps them on the route past the station.",
  },

  // ── Rodent sanitation (service tips, owner-approved 2026-10-02) ───────────────────────────────────────────
  {
    id: 'rs_plastic_bins', group: 'rodent', label: "Attic storage in plastic bins",
    keywords: ["attic", "storage", "cardboard", "bins", "nesting"], lines: ["rodent"], season: 'all',
    services: ["rodent_sanitation_light", "rodent_sanitation_medium", "rodent_sanitation_heavy", "rodent_sanitation_standard", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation"],
    copy: "Rodents nest in cardboard, paper, and old fabric. Anything stored in the attic or garage does better in plastic bins with lids, which keeps the nesting material out of their reach.",
  },

  // ── Termite bait stations (service tips, owner-approved 2026-10-02) ───────────────────────────────────────
  {
    id: 'tb_save_swarmers', group: 'termite', label: "Save a few swarmers and call",
    keywords: ["swarmers", "winged", "flying", "window", "spring"], lines: ["termite"], season: 'all',
    services: ["termite_bait", "termite_active_bait_quarterly", "termite_monitoring", "termite_cartridge_replacement", "pest_termite_bait_quarterly", "termite_installation_setup", "termite_active_annual"],
    copy: "Winged termites at a window or a light in spring are swarmers, a mature colony sending out new ones. Save a few in a zip bag or on tape and call me; they show exactly which termite it is and where to look.",
  },
  {
    // Bait stations only: termite_monitoring is detection-only, no bait
    // (Codex #5582).
    id: 'tb_no_spray_stations', group: 'termite', label: "No insecticide near the stations",
    keywords: ["spray", "insecticide", "station", "bug spray", "perimeter"], lines: ["termite"], season: 'all',
    services: ["termite_bait", "termite_active_bait_quarterly", "termite_cartridge_replacement", "pest_termite_bait_quarterly", "termite_installation_setup", "termite_active_annual"],
    copy: "Termites have to keep feeding at a station for the bait to reach the colony. Insecticide sprayed around a station can turn them away, so leave a clear foot around each one.",
  },

  // ── Termite treatment (liquid, trench, spot, foam) (service tips, owner-approved 2026-10-02) ──────────────
  {
    // Only where the soil along the foundation is the barrier: the full liquid
    // and trench treatments. A foam or spot treatment treats galleries, voids
    // or one spot, so a tip calling the soil treated would claim work that was
    // not done (codex local r4 on #5582).
    id: 'tl_before_digging', group: 'termite', label: "Call before digging by the foundation",
    keywords: ["digging", "planting", "edging", "pavers", "landscaper"], lines: ["termite"], season: 'all',
    services: ["termite_liquid", "termite_trench", "termite_trenching"],
    copy: "The treated soil along the foundation is the barrier. New plantings, edging, or pavers dug into that strip break it, so let me know before any work there starts.",
  },
  {
    id: 'tl_water_off_soil', group: 'termite', label: "Keep water off the treated soil",
    keywords: ["downspout", "sprinkler", "erosion", "foundation", "washout"], lines: ["termite"], season: 'all',
    services: ["termite_liquid", "termite_trench", "termite_trenching"],
    copy: "Downspouts and sprinklers that wash soil away from the foundation take the treated soil with them. Turn sprinkler heads away from the wall and run downspouts out a few feet.",
  },
  {
    id: 'tl_new_slabs', group: 'termite', label: "Tell us before new concrete",
    keywords: ["patio", "addition", "driveway", "slab", "concrete"], lines: ["termite"], season: 'all',
    services: ["termite_liquid", "termite_trench", "termite_trenching", "termite_spot_treatment", "foam_drill", "foam_recurring"],
    copy: "A new patio, addition, or walkway poured against the house covers soil that hasn't been treated. Let me know before it's poured; treating the soil first is far simpler than treating through new concrete.",
  },

  // ── Termite inspection (service tips, owner-approved 2026-10-02) ──────────────────────────────────────────
  {
    id: 'ti_clear_garage', group: 'termite', label: "Clear the base of the garage walls",
    keywords: ["garage", "walls", "storage", "inspection", "slab edge"], lines: ["termite"], season: 'all',
    services: ["termite_inspection"],
    copy: "Termites usually show up first along the garage walls and the slab edge. Keeping a few inches clear along the base of the garage walls lets me see the whole line at every inspection.",
  },
  {
    id: 'ti_fix_leaks', group: 'termite', label: "Fix leaks by the foundation",
    keywords: ["leak", "spigot", "a/c line", "damp", "downspout"], lines: ["termite"], season: 'all',
    services: ["termite_inspection"],
    copy: "Subterranean termites go where the soil stays damp. A leaking spigot, A/C line, or downspout soaking one spot by the slab makes that spot the likeliest place for them to start.",
  },

  // ── Bora-Care (service tips, owner-approved 2026-10-02) ───────────────────────────────────────────────────
  {
    id: 'bc_keep_dry', group: 'termite', label: "Seal treated wood exposed to rain",
    keywords: ["borate", "wood", "rain", "paint", "sealant"], lines: ["termite"], season: 'all',
    services: ["bora_care"],
    copy: "Borate treatment soaks into the wood and stays there as long as the wood stays dry. Where treated wood is open to the weather, a coat of paint or sealant once it's dry keeps rain from washing it back out.",
  },

  // ── Wildlife trapping (service tips, owner-approved 2026-10-02) ───────────────────────────────────────────
  {
    id: 'wl_trap_hands_off', group: 'wildlife', label: "Leave a trapped animal alone",
    keywords: ["raccoon", "opossum", "trap", "bite", "cage"], lines: ["pest"], season: 'all',
    services: ["wildlife_trapping"],
    copy: "A trapped raccoon or opossum is frightened and can bite or scratch through the cage. Keep pets and kids away from the trap and call when something is in it.",
  },
  {
    id: 'wl_feed_inside', group: 'wildlife', label: "Feed pets inside",
    keywords: ["pet food", "lanai", "raccoon", "bowl", "night"], lines: ["pest"], season: 'all',
    services: ["wildlife_trapping"],
    copy: "Pet food left outside overnight is the meal that brings raccoons, opossums, and rats to the lanai. Feeding inside, or picking the bowl up at dusk, takes away the reason to come back.",
  },
  // ── Service tips, second batch (owner-approved 2026-10-09: things the
  // customer can do for their own case) ─────────────────────────────────
  {
    id: 'gp_sprinkler_off_wall', group: 'exterior', label: "Aim sprinklers off the wall",
    keywords: ["sprinkler", "irrigation", "wall", "foundation", "wet"], lines: ["pest"], season: 'all',
    services: GENERAL_PEST_SERVICES,
    copy: "A sprinkler head that hits the house keeps the base of the wall wet and wears down the band I treat along the foundation. Turn that head so it waters the bed and not the wall. The strip dries out, and what I put down lasts the way it should.",
  },
  {
    id: 'gp_first_days', group: 'exterior', label: "A few more bugs for a few days",
    keywords: ["more bugs", "flush", "dead bugs", "first week", "after treatment"], lines: ["pest"], season: 'all',
    services: GENERAL_PEST_SERVICES,
    copy: "For the first few days after a visit you may see more insects than usual, often slow or on their backs. That is the treatment bringing them out of the cracks they hide in, and it settles down over a week or two. If it does not, let me know.",
  },
  {
    id: 'gp_rinse_recycling', group: 'kitchen', label: "Rinse cans before the bin",
    pests: ['Ants', 'Roaches'], keywords: ["recycling", "cans", "bottles", "bin", "rinse"], lines: ["pest"], season: 'all',
    copy: "A soda can or a wine bottle in the recycling bin feeds ants and roaches all week. A quick rinse before it goes in, and a bin with a lid kept off the garage wall, takes that food away.",
  },
  {
    id: 'gp_garage_dusk', group: 'sealing', label: "Garage door down before dark",
    keywords: ["garage", "dusk", "palmetto", "light", "flying"], lines: ["pest"], season: 'all',
    services: [...GENERAL_PEST_SERVICES, ...NATIVE_ROACH_SERVICES.filter((key) => !GENERAL_PEST_SERVICES.includes(key))],
    copy: "Palmetto bugs fly toward light at dusk, and an open garage with the light on is the widest door on the house. Closing it before the lights come on keeps most of them outside, where the treatment is.",
  },
  {
    id: 'cr_gutters', group: 'roaches', label: "Clean the gutters twice a year",
    keywords: ["gutters", "leaves", "roofline", "soffit", "smokybrown"], lines: ["pest"], season: 'all',
    services: NATIVE_ROACH_SERVICES,
    copy: "Wet leaves in a gutter are where the large outdoor roaches live and breed, right at the roofline above your soffits. Cleaning the gutters before and after the rainy season takes away a place they breed at the edge of the house.",
  },
  {
    id: 'cr_dead_ones', group: 'roaches', label: "Dead ones are a good sign",
    keywords: ["dead roaches", "dying", "after treatment", "sweep", "lanai"], lines: ["pest"], season: 'all',
    services: NATIVE_ROACH_SERVICES,
    copy: "Over the next two weeks you may find large roaches dead or slow in the garage, on the lanai, or by the doors. Those are the ones coming in from outside and crossing what I put down. Sweep them up; there is no need to spray anything yourself.",
  },
  {
    id: 'rs_where_and_when', group: 'exterior', label: "Tell me where and when",
    keywords: ["photo", "room", "time of day", "still seeing", "callback"], lines: ["pest"], season: 'all',
    services: ["pest_re_service"],
    copy: "If you see activity again, note the room, the time of day, and what it was. A phone photo is the most helpful thing you can send me. It shows me where they are coming from, so I can treat that spot instead of the whole house.",
  },
  {
    id: 'rs_give_it_time', group: 'exterior', label: "Give it 10 to 14 days",
    keywords: ["how long", "days", "still seeing", "patience", "two weeks"], lines: ["pest"], season: 'all',
    services: ["pest_re_service"],
    copy: "Most of what I put down works over days, not minutes. Insects cross it and carry it back to where they hide, and the activity drops over the next 10 to 14 days. If you still see steady activity after that, let me know.",
  },
  {
    id: 'vr_no_food', group: 'roaches', label: "No food in the car for two weeks",
    keywords: ["car", "crumbs", "wrappers", "trash", "food"], lines: ["pest"], season: 'all',
    services: ["vehicle_german_roach", "vehicle_roach_addon"],
    copy: "Roaches stay in a car for the crumbs under the seats and the wrappers in the door pockets. For the next two weeks, keep food out of the car and empty the trash at the end of every day, so the bait is the only meal they can find.",
  },
  {
    id: 'vr_what_rides', group: 'roaches', label: "Check what rides in the car",
    keywords: ["car", "boxes", "grocery bag", "backpack", "trunk"], lines: ["pest"], season: 'all',
    services: ["vehicle_german_roach", "vehicle_roach_addon"],
    copy: "Roaches usually ride into a car in a box, a grocery bag, or a backpack. Shake bags out before they go in, and do not leave cardboard boxes in the trunk or on the back seat overnight.",
  },
  {
    id: 'vr_no_fogger', group: 'roaches', label: "Skip the bug bomb",
    keywords: ["car", "fogger", "bug bomb", "vacuum", "floor mats"], lines: ["pest"], season: 'all',
    services: ["vehicle_german_roach", "vehicle_roach_addon"],
    copy: "A fogger in a car pushes roaches deeper into the dash and the door panels, where nothing reaches them, and it coats the surfaces you touch. Leave the bait to do the work, and vacuum the seat seams and floor mats every few days.",
  },
  {
    id: 'plug_light_water', group: 'lawn', label: "Light water every day at first",
    keywords: ["plugs", "watering", "new plugs", "roots", "daily"], lines: ["lawn"], season: 'all',
    services: ["plugging"],
    copy: "New plugs have short roots and dry out fast. Water them lightly once or twice a day for the first two weeks, then go back to deeper watering two days a week so the roots follow the water down.",
  },
  {
    id: 'plug_stay_off', group: 'lawn', label: "Mower and feet off the plugs",
    keywords: ["plugs", "mower", "traffic", "dog", "rooted"], lines: ["lawn"], season: 'all',
    services: ["plugging"],
    copy: "A plug has rooted when it does not lift with a gentle tug, usually in about three weeks. Until then, keep the mower, the dog, and foot traffic off those spots so the roots are not torn loose.",
  },
  {
    id: 'td_water_in', group: 'lawn', label: "Water the top dressing in",
    keywords: ["top dressing", "sand", "compost", "water in", "mow"], lines: ["lawn"], season: 'all',
    services: ["top_dressing"],
    copy: "The top dressing works once it settles down between the grass blades. Water it in well today, and wait to mow until the grass tips show through, so the mower does not pick the material back up.",
  },
  {
    id: 'td_rake_level', group: 'lawn', label: "Rake the piles level",
    keywords: ["top dressing", "piles", "rake", "smother", "level"], lines: ["lawn"], season: 'all',
    services: ["top_dressing"],
    copy: "If the top dressing sits in small piles after it dries, pull a leaf rake over them so the grass tips show. A pile left thick smothers the grass under it.",
  },
  {
    id: 'dt_thin_is_normal', group: 'lawn', label: "Thin for a few weeks is normal",
    keywords: ["dethatch", "thin", "rough", "recovery", "verticut"], lines: ["lawn"], season: 'all',
    services: ["dethatching"],
    copy: "The lawn looks thin and a little rough after dethatching because the dead layer is out and the soil shows. Keep it watered on your normal schedule and, while the grass is growing in warm weather, it fills back in over the next few weeks. Hold off on mowing short until it does.",
  },
  {
    id: 'dt_thatch_source', group: 'lawn', label: "Thatch comes from too much food and water",
    keywords: ["thatch", "fertilizer", "overwatering", "spongy", "comes back"], lines: ["lawn"], season: 'all',
    services: ["dethatching"],
    copy: "Thatch builds when a lawn gets more fertilizer and water than it can use. Keep to the watering days and the feeding plan we set, and the layer comes back much slower.",
  },
  {
    id: 'lk_fills_from_edges', group: 'lawn', label: "Brown spots fill in from the edges",
    keywords: ["brown spots", "dead grass", "runners", "chinch", "recovery"], lines: ["lawn"], season: 'all',
    services: ["lawn_pest_knockdown"],
    copy: "Grass that the insects already killed stays brown; it does not turn green again. St. Augustine and Zoysia fill those spots by sending runners in from the healthy edges over several weeks. Regular watering and a normal mowing height help it cover faster.",
  },
  {
    id: 'lk_watch_the_edge', group: 'lawn', label: "Watch the edge of the spot",
    keywords: ["edge", "spreading", "chinch", "webworm", "brown"], lines: ["lawn"], season: 'all',
    services: ["lawn_pest_knockdown"],
    copy: "The insects feed where the brown grass meets the green, not in the middle of a dead spot. Look at that edge once a week. If the brown keeps moving outward, let me know before your next visit.",
  },
  {
    id: 'pi_new_fronds', group: 'tree_shrub', label: "Watch the new fronds",
    keywords: ["palm", "injection", "new fronds", "results", "yellow"], lines: ["tree_shrub"], season: 'all',
    services: ["palm_injection", "palm_injection_semiannual"],
    copy: "What I put into the palm reaches the growth that comes after it. Older fronds that are already yellow or spotted will not change. Look at the new fronds that open over the coming months, sometimes a year or more, for the difference.",
  },
  {
    id: 'pi_trunk_wounds', group: 'tree_shrub', label: "Keep nails and trimmers off the trunk",
    keywords: ["palm", "trunk", "nails", "string trimmer", "wound"], lines: ["tree_shrub"], season: 'all',
    services: ["palm_injection", "palm_injection_semiannual"],
    copy: "A palm cannot close a wound in its trunk the way an oak can. Keep nails, screws, light hooks, and the string trimmer away from the trunk, because every cut or hole stays open for the life of the palm.",
  },
  {
    id: 'ms_nozzles_clear', group: 'water', label: "Keep the nozzles clear",
    keywords: ["misting", "nozzle", "hedge", "blocked", "trim"], lines: ["mosquito"], season: 'all',
    services: ["mosquito_misting_system"],
    copy: "A nozzle that a hedge has grown over sprays into the leaves in front of it and nowhere else. When the landscaping gets trimmed, ask for a hand's width of open space around each nozzle so the mist reaches the yard.",
  },
  {
    id: 'ms_mist_times', group: 'water', label: "Tell me when you use the yard",
    keywords: ["misting", "timer", "schedule", "lanai", "pool"], lines: ["mosquito"], season: 'all',
    services: ["mosquito_misting_system"],
    copy: "The system mists on a timer, at the hours mosquitos are most active. If a cycle runs when you are usually out on the lanai or when the kids are in the pool, tell me, and I will move the times.",
  },
  {
    id: 'ri_listen', group: 'rodent', label: "Note when and where you hear them",
    keywords: ["noise", "scratching", "night", "attic", "ceiling"], lines: ["rodent"], season: 'all',
    services: ["rodent_inspection"],
    copy: "For the next few nights, note the time and the room when you hear scratching or running overhead. Something like \"2 a.m., over the kitchen\" shows me the route they use, and the plan I write is built around it.",
  },
  {
    id: 'ri_no_store_poison', group: 'rodent', label: "Hold off on store-bought bait",
    keywords: ["store bait", "smell", "wall", "attic", "d-con"], lines: ["rodent"], season: 'all',
    services: ["rodent_inspection"],
    copy: "Store-bought bait lets a rat die wherever it happens to be, often inside a wall or the attic, and the smell lasts for weeks. Hold off until we agree on a plan, so we know where every animal ends up.",
  },
  {
    id: 'bc_find_the_water', group: 'termite', label: "Find what wet the wood",
    keywords: ["borate", "wet wood", "gutter", "leak", "sprinkler"], lines: ["termite"], season: 'all',
    services: ["bora_care"],
    copy: "Borate stays in wood that stays dry. If a gutter, a hose bib, or a sprinkler was wetting that wood, fixing it now keeps the treatment where I put it.",
  },
  // ── Third batch (owner-approved 2026-10-09, "batch 2 ok") ─────────────────
  {
    id: 'ant_wipe_trail', group: 'kitchen', label: "Clean up what the ants were after",
    pests: ['Ants'], keywords: ["trail", "crumbs", "spill", "counter", "wipe"], lines: ["pest"], season: 'all',
    copy: "Ants follow a scent trail that the first scouts lay down. Clean up the spill or the crumbs they were walking to, and keep that spot clean for a week. Leave the sill, the door frame, and the baseboard where I worked as they are for now, since wiping there can undo the treatment.",
  },
  {
    id: 'ant_seal_sweets', group: 'kitchen', label: "Wipe the honey jar and the syrup",
    pests: ['Ants'], keywords: ["honey", "syrup", "sugar", "sweets", "ghost ants"], lines: ["pest"], season: 'all',
    copy: "The small ants in a Florida kitchen go for sweets first. A sticky ring under the honey jar, the syrup bottle, or the sugar bowl is enough to keep a trail coming, so wipe the bottoms and keep those in a sealed bin or the fridge.",
  },
  {
    id: 'ant_lanai_pots', group: 'exterior', label: "Let lanai pots dry between waterings",
    pests: ['Ants'], keywords: ["potted plants", "lanai", "saucer", "soil", "ghost ants"], lines: ["pest"], season: 'all',
    copy: "Ghost ants and other small ants nest in the soil of potted plants on the lanai and walk in from there. Let the pots dry on top between waterings, and lift the saucers so water does not sit under them.",
  },
  {
    id: 'spider_brush_webs', group: 'exterior', label: "Brush webs down every couple of weeks",
    pests: ['Spiders'], keywords: ["webs", "broom", "egg sacs", "corner", "cobwebs"], lines: ["pest"], season: 'all',
    copy: "A web that comes back in the same corner means insects are flying there, usually to a light. Brushing webs down with a broom every couple of weeks takes the egg sacs with them, and it shows you which bulb to change.",
  },
  {
    id: 'spider_shake_gloves', group: 'exterior', label: "Shake out garage shoes and gloves",
    pests: ['Spiders'], keywords: ["gloves", "shoes", "garage", "boots", "widow"], lines: ["pest"], season: 'all',
    copy: "Spiders rest in anything dark and still, and garden gloves and shoes by the garage door are the first place they settle. Shake them out before you put a hand or a foot in.",
  },
  {
    id: 'silverfish_paper', group: 'moisture', label: "Keep paper out of damp rooms",
    pests: ['Silverfish'], keywords: ["books", "paper", "photos", "damp", "closet"], lines: ["pest"], season: 'all',
    copy: "Silverfish feed on paper, glue, and starch, and they need damp air to live. Books, photo boxes, and stored papers do better on a shelf in an air-conditioned room than in the garage or under a sink.",
  },
  {
    id: 'damp_things_by_door', group: 'exterior', label: "Lift pots off the ground by the door",
    pests: ['Earwigs', 'Crickets', 'Centipedes'], keywords: ["pots", "pool toys", "hose", "doorstep", "damp"], lines: ["pest"], season: 'all',
    copy: "Earwigs, crickets, and centipedes spend the day under whatever is damp and touching the ground by a door: flower pots, pool toys, a rolled hose. Setting pots up on feet and keeping the first step outside each door bare leaves them nowhere to wait.",
  },
  {
    id: 'wasp_check_covers', group: 'stinging', label: "Look before you lift the grill cover",
    pests: ['Wasps'], keywords: ["grill cover", "umbrella", "patio chair", "paper wasp", "nest"], lines: ["pest"], season: 'all',
    copy: "Paper wasps build in still, sheltered spots: under the grill cover, inside a folded umbrella, on the underside of a chair. Here they build most of the year, so give those spots a quick look before you reach in whenever something has sat unused for a week or two.",
  },
  {
    id: 'wasp_plug_tubing', group: 'stinging', label: "Plug the open ends of patio tubing",
    pests: ['Wasps'], keywords: ["patio furniture", "tubing", "swing set", "mud dauber", "plug"], lines: ["pest"], season: 'all',
    copy: "Paper wasps and mud daubers build inside the hollow ends of patio chairs, swing sets, and umbrella poles. Push a rubber plug or a wad of foil into each open end so the tube is not a ready-made nest.",
  },
  {
    id: 'gp_pressure_wash_first', group: 'exterior', label: "Pressure wash before my visit, not after",
    keywords: ["pressure wash", "power wash", "paint", "pool deck", "wash off"], lines: ["pest"], season: 'all',
    services: GENERAL_PEST_SERVICES,
    copy: "Pressure washing the walls, the lanai, or the pool deck takes what I put down off with the dirt. If you plan to pressure wash or paint, schedule it for the week before my visit instead of the week after.",
  },
  {
    id: 'gp_garage_floor_edge', group: 'exterior', label: "Clear floor along the garage walls",
    keywords: ["garage", "boxes", "storage", "floor", "wall"], lines: ["pest"], season: 'all',
    services: GENERAL_PEST_SERVICES,
    copy: "Insects travel along the edge where the garage floor meets the wall, and that edge is where I treat. Boxes and bags sitting on the floor against the wall cover it up. A hand's width of clear floor along each wall keeps that line working.",
  },
  {
    id: 'mq_thin_hedges', group: 'water', label: "Thin the thick hedges",
    keywords: ["hedge", "shrubs", "shade", "thick", "resting"], lines: ["mosquito"], season: 'all',
    services: ["mosquito_monthly", "mosquito_recurring", "mosquito_seasonal", "mosquito", "mosquito_one_time", "mosquito_onetime", "mosquito_event"],
    copy: "Mosquitos spend the heat of the day resting in thick, shady leaves. A hedge that is thinned so light and air move through it holds far fewer of them, and the treatment reaches the inside of the plant.",
  },
  {
    id: 'mq_lanai_fan', group: 'water', label: "Run a fan where you sit",
    keywords: ["fan", "lanai", "patio", "biting", "sitting outside"], lines: ["mosquito"], season: 'all',
    services: ["mosquito_monthly", "mosquito_recurring", "mosquito_seasonal", "mosquito", "mosquito_one_time", "mosquito_onetime", "mosquito_event"],
    copy: "Mosquitos are weak fliers. A ceiling fan or a box fan aimed across the chairs on the lanai keeps them from landing on you, and it does more than a candle.",
  },
  {
    id: 'mq_downspout_pipe', group: 'water', label: "Check the ribbed downspout pipe",
    keywords: ["downspout", "corrugated", "extension", "drain pipe", "ridges"], lines: ["mosquito"], season: 'all',
    services: ["mosquito_monthly", "mosquito_recurring", "mosquito_seasonal", "mosquito", "mosquito_one_time", "mosquito_onetime", "mosquito_event"],
    copy: "The flexible ribbed pipe on the end of a downspout holds a little water in every ridge, and mosquitos breed there. Swap it for a smooth pipe, or lift it and tip it out once a week.",
  },
  {
    id: 'flea_the_car', group: 'fleas', label: "Vacuum where the pet rides in the car",
    pests: ['Fleas'], keywords: ["car", "back seat", "seat cover", "truck", "cargo"], lines: ["pest"], season: 'all',
    services: ["flea_tick"],
    copy: "Flea eggs fall off wherever the pet rests, and that includes the back seat and the cargo mat. Vacuum the car where the pet rides and wash the seat cover hot, so the pet does not bring a new batch back into the house.",
  },
  {
    id: 'flea_white_towel', group: 'fleas', label: "Comb the pet over a white towel",
    pests: ['Fleas'], keywords: ["flea dirt", "comb", "towel", "specks", "check the pet"], lines: ["pest"], season: 'all',
    services: ["flea_tick"],
    copy: "Flea dirt shows as black specks on a white towel long before you see a flea. Comb the pet over one twice a week and tell me if the specks come back, so we know if the house or the pet is the source.",
  },
  {
    id: 'rs_seed_in_metal', group: 'rodent', label: "Bird seed and pet food in a metal can",
    keywords: ["bird seed", "dog food", "metal can", "chewed", "bag"], lines: ["rodent"], season: 'all',
    services: ["rodent_sanitation_light", "rodent_sanitation_medium", "rodent_sanitation_heavy", "rodent_sanitation_standard", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation"],
    copy: "Rats chew through a bag of bird seed or dog food in one night, and thin plastic does not slow them much. A metal can with a tight lid keeps the food in and the smell down.",
  },
  {
    id: 'rs_dog_waste', group: 'rodent', label: "Pick up dog waste daily",
    keywords: ["dog waste", "poop", "yard", "pickup", "droppings"], lines: ["rodent"], season: 'all',
    services: ["rodent_sanitation_light", "rodent_sanitation_medium", "rodent_sanitation_heavy", "rodent_sanitation_standard", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation"],
    copy: "Rats feed on dog waste left in the yard, and it is a food source most people never think of. A daily pickup takes it away.",
  },
  {
    id: 'wl_strap_the_cans', group: 'wildlife', label: "Strap the trash can lids",
    keywords: ["trash cans", "bungee", "pickup day", "tipped over", "garbage"], lines: ["pest"], season: 'all',
    services: ["wildlife_trapping"],
    copy: "Raccoons work the trash cans the night before pickup. A strap or bungee across the lid, or putting the cans out in the morning instead of the night before, takes away the easiest meal on the street.",
  },
  {
    id: 'wl_pet_door_night', group: 'wildlife', label: "Lock the pet door at night",
    keywords: ["pet door", "dog door", "cat door", "opossum", "kitchen"], lines: ["pest"], season: 'all',
    services: ["wildlife_trapping"],
    copy: "A pet door is the right size for a raccoon or an opossum, and they learn fast where the food is. Lock or cover it at night while the traps are out.",
  },
  {
    id: 'wl_latch_screen_door', group: 'wildlife', label: "Latch the lanai screen door",
    keywords: ["screen door", "latch", "fruit", "table", "slide"], lines: ["pest"], season: 'all',
    services: ["wildlife_trapping"],
    copy: "Raccoons learn to slide an unlatched screen door open to reach the lanai and whatever is on the table. Latch it at dusk, and keep pet food and fruit off the lanai while the traps are out.",
  },
  {
    id: 'lre_weekly_photo', group: 'lawn', label: "One photo a week from the same spot",
    keywords: ["photo", "spot", "spreading", "weekly", "same place"], lines: ["lawn"], season: 'all',
    services: ["lawn_re_service", "lawn_inspection"],
    copy: "A lawn changes slowly, and it is hard to tell from memory if a spot is growing or filling in. Take one photo a week from the same place and send them to me if it gets worse. The photos show me the direction it is going.",
  },
  {
    id: 'ts_trimmer_guard', group: 'tree_shrub', label: "Keep the string trimmer off the bark",
    keywords: ["string trimmer", "weed eater", "bark", "girdle", "guard"], lines: ["tree_shrub"], season: 'all',
    copy: "String trimmer line cuts the bark at the base of a young tree or shrub, and a ring of cuts starves the plant from the bottom up. A bare ring of soil or a plastic guard around the base keeps the trimmer away from it.",
  },
]);

// Deep-frozen: the registry is the screened source of customer copy, and
// tipsForVisit hands out these same objects — a consumer annotating one
// must not be able to change what a later resolveTipIds emits.
function deepFreeze(value, seen = new WeakSet()) {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner, seen);
  }
  return value;
}
deepFreeze(TIPS);
deepFreeze(TIP_GROUPS);

const TIPS_BY_ID = new Map(TIPS.map((tip) => [tip.id, tip]));

// An exact registry line passes through; anything else — a service key
// ('wdo_inspection'), a display name ('Palm Injection'), a companion
// label — goes through the canonical detector (service-line-configs) so
// the picker leads with the right groups. Its `palm` answer is the tree &
// shrub registry line; the detector's own fallback is pest.
function registryLineFor(serviceLine) {
  const line = String(serviceLine || '').trim().toLowerCase();
  if (SERVICE_LINES.includes(line)) return line;
  const detected = detectServiceLine(serviceLine);
  if (detected === 'palm') return 'tree_shrub';
  return SERVICE_LINES.includes(detected) ? detected : 'pest';
}

/**
 * The picker payload for one visit: tips for the visit’s service line, grouped in seasonal order.
 * Out-of-season tips remain available within that line. A tip written for
 * particular services (`services`: catalog service keys, owner-approved
 * 2026-10-02) leads those visits' list in its own group ("For this service")
 * and stays out of every other visit's list.
 *
 * `more` is every tip the list leaves out (owner 2026-10-09, "open search"):
 * the picker searches it and the pest sheet lifts from it, so a recurring
 * visit that finds roaches or fleas can reach that advice. It is never listed
 * unasked, so a tip that names work still leads only its own services.
 */
function tipsForVisit({ serviceLine, serviceKey = null, serviceKeys = [], date = new Date(), findings = [] } = {}) {
  const line = registryLineFor(serviceLine);
  const season = seasonForDate(date);
  // Within a group the best fit leads: this visit's confirmed findings, then
  // the month, then the season; ties keep registry order (the sort is stable).
  const rankCtx = { season, month: monthForDate(date), findings: new Set(Array.isArray(findings) ? findings : []) };
  const bySeason = (a, b) => tipRank(b, rankCtx) - tipRank(a, rankCtx);
  const groups = GROUP_ORDER[season]
    .map((groupId) => {
      const group = TIP_GROUPS.find((g) => g.id === groupId);
      const tips = TIPS.filter((tip) => tip.group === groupId && tip.lines.includes(line) && !tip.services)
        .sort(bySeason);
      return { ...group, primary: tips.some((tip) => tip.lines.includes(line)), tips };
    })
    .filter((group) => group.tips.length > 0);
  // Every service on the visit (the primary and its add-on lines) leads with
  // its own tips (Codex #5582).
  const keys = new Set([serviceKey, ...serviceKeys].filter(Boolean));
  const forService = keys.size ? TIPS.filter((tip) => tip.services?.some((key) => keys.has(key))).sort(bySeason) : [];
  const listed = new Set([...forService, ...groups.flatMap((group) => group.tips)]);
  return {
    line,
    season,
    groups: forService.length ? [{ ...FOR_SERVICE_GROUP, primary: true, tips: forService }, ...groups] : groups,
    more: TIPS.filter((tip) => !listed.has(tip)),
  };
}

/**
 * Resolve picked ids to frozen entries. Unknown ids are dropped — the client
 * never supplies copy, so an unrecognised id has nothing to print. Duplicates
 * collapse and the result is capped at MAX_TIPS_PER_VISIT.
 */
function resolveTipIds(ids) {
  const seen = new Set();
  const resolved = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw || '').trim();
    const tip = TIPS_BY_ID.get(id);
    if (!tip || seen.has(id)) continue;
    seen.add(id);
    // The link is a snapshot, never the registry's own object — a caller
    // that edits its payload must not edit the registry for every later call.
    resolved.push({ id, copy: tip.copy, source: 'library', ...(tip.link ? { link: { ...tip.link } } : {}) });
    if (resolved.length >= MAX_TIPS_PER_VISIT) break;
  }
  return resolved;
}

/**
 * What the completion route freezes into structured_notes.techTips from the
 * client's { ids, custom } payload: library ids resolved to their copy, then
 * the optional "write your own" line — the tech's own words about this
 * house, so it skips the visit-claim rule but goes through the same
 * customer-copy screen as every other verbatim customer string. A line the
 * screen rejects is dropped (reported back so the caller can log it), the
 * whole set is capped at MAX_TIPS_PER_VISIT, and anything malformed yields
 * an empty freeze rather than a throw.
 */
// Sentence terminators followed by whitespace and more text, or the end —
// independent of capitalisation ("Flip the mats. then empty the saucers."
// is two). "A/C" has no terminator and decimals ("1.25") have no
// whitespace after the dot, so neither splits; a mid-line abbreviation
// ("approx. 1 inch") does, and the 400 tells the tech to make it one
// sentence.
function sentenceCount(text) {
  const t = String(text || '').trim();
  if (!t) return 0;
  // interior boundaries + 1: a trailing terminator (or none) is still one sentence
  return (t.match(/[.!?]+(?:["')\]]+)?(?=\s+\S)/g) || []).length + 1;
}

function freezeTechTips(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { tips: [], dropped: [] };
  const tips = resolveTipIds(input.ids);
  const dropped = [];
  // Nothing the tech was told would print may vanish silently: an id the
  // library no longer has (retired between picker load and completion, or
  // an out-of-date client) and any pick past the cap are reported so the
  // completion route can refuse with an actionable message.
  const kept = new Set(tips.map((t) => t.id));
  const seenIds = new Set();
  for (const raw of Array.isArray(input.ids) ? input.ids : []) {
    const id = String(raw || '').trim();
    if (!id || seenIds.has(id)) continue;
    seenIds.add(id);
    if (kept.has(id)) continue;
    dropped.push({ id, violations: [TIPS_BY_ID.has(id) ? 'over_cap' : 'unknown_tip'] });
  }
  // Never truncated: an over-long line is rejected as `too_long` so the
  // tech rewrites it, rather than a silently shortened sentence printing.
  // Only a string is a custom line — a malformed array/object must never be
  // stringified into customer-facing text ("[object Object]").
  const custom = typeof input.custom === 'string' ? input.custom.replace(/\s+/g, ' ').trim() : '';
  if (custom) {
    // One sentence, one slot: a value carrying several sentences would be
    // several tips under one cap entry. customerCopyViolations also runs
    // containsReportAccessCode, so a gate code never freezes.
    const violations = custom.length > MAX_CUSTOM_TIP_CHARS
      ? ['too_long']
      : sentenceCount(custom) > 1
        ? ['multi_sentence']
        : customerCopyViolations(custom);
    if (violations.length) dropped.push({ copy: custom, violations });
    else if (tips.length < MAX_TIPS_PER_VISIT) tips.push({ id: 'custom', copy: custom, source: 'technician' });
    else dropped.push({ copy: custom, violations: ['over_cap'] });
  }
  return { tips, dropped };
}

module.exports = {
  TIPS,
  TIP_GROUPS,
  SERVICE_LINES,
  SEASONS,
  MAX_TIPS_PER_VISIT,
  TIP_PESTS,
  MAX_CUSTOM_TIP_CHARS,
  LAWN_FINDINGS,
  monthForDate,
  seasonForDate,
  LAWN_LABEL_FINDINGS,
  lawnFindingsFromAssessment,
  lawnFindingsFromRun,
  keptRunRows,
  registryLineFor,
  tipsForVisit,
  resolveTipIds,
  freezeTechTips,
  sentenceCount,
};
