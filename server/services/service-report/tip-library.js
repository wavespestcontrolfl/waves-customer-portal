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
 *  - Ids are stable forever — frozen structured_notes reference them and the
 *    picker's "already sent" mark matches on id. Never rename; retire by
 *    removing the entry (frozen reports keep their copy).
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
function seasonForDate(date = new Date()) {
  const day = typeof date === 'string' ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim()) : null;
  const month = day ? Number(day[2]) : etParts(date).month;
  return WET_SEASON_MONTHS.has(month) ? 'wet' : 'dry';
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

const TIPS = Object.freeze([
  // ── Moisture ──────────────────────────────────────────────────────────
  {
    id: 'moisture_ac_drip', group: 'moisture', label: 'A/C condensate line',
    keywords: ['ac', 'condensate', 'drip', 'slab', 'ants'], lines: ['pest'], season: 'all',
    copy: "Your A/C condensate line runs all summer, and where it drips the soil against the slab never dries. Ants and roaches follow that moisture gradient straight to the foundation. If the line ends at the wall, a short extension that carries it a couple of feet into the bed makes that strip dry again.",
  },
  {
    id: 'moisture_hose_bib', group: 'moisture', label: 'Fix drips at hose bibs',
    keywords: ['hose', 'spigot', 'leak', 'water', 'ghost ants'], lines: ['pest'], season: 'all',
    copy: "A slow drip at a hose bib keeps one patch of soil wet around the clock — exactly the micro-habitat ghost ants and springtails move toward. It's usually a worn washer, and it's a quick fix that removes a whole colony's reason to be there.",
  },
  {
    id: 'moisture_bath_fan', group: 'moisture', label: 'Bath fan until the mirror clears',
    keywords: ['bathroom', 'humidity', 'fan', 'roach'], lines: ['pest'], season: 'all',
    copy: "Humidity trapped in a closed bathroom keeps the baseboards and cabinet kicks damp. German roaches need that humidity more than they need food, so run the fan after every shower until the mirror clears — that drops the room below what they can live on.",
  },
  {
    id: 'moisture_under_sink', group: 'moisture', label: 'Check under the kitchen sink',
    keywords: ['sink', 'cabinet', 'leak', 'trap', 'roach'], lines: ['pest'], season: 'all',
    copy: "The cabinet under the kitchen sink is the harborage I find most often in SWFL kitchens. A slow weep at the trap or the supply lines keeps the cabinet floor dark and damp. Once a month, run a hand along the back corner — if it's damp, that repair does more than anything I can apply.",
  },
  {
    id: 'moisture_ac_auto', group: 'moisture', label: 'A/C fan on Auto, not On',
    keywords: ['thermostat', 'humidity', 'silverfish', 'booklice'], lines: ['pest'], season: 'wet',
    copy: "Roaches, silverfish, and booklice all track indoor humidity. With the thermostat fan set to On, the coil re-evaporates the water it just pulled out; on Auto the house settles around 50% humidity, and that takes away the conditions they establish in.",
  },

  // ── Lighting ──────────────────────────────────────────────────────────
  {
    id: 'light_warm_bulbs', group: 'lighting', label: 'Warm porch bulbs',
    keywords: ['porch', 'light', 'bulb', '2700k', 'spiders', 'moths'], lines: ['pest', 'mosquito'], season: 'all',
    copy: "Insects steer by short-wavelength light, so a bright white or blue-white bulb — anything over about 3000K — pulls flying insects to your door, and the spiders and geckos that eat them follow. A warm 2700K bulb, or a yellow \"bug\" bulb, is far less visible to them.",
  },
  {
    id: 'light_motion_sensor', group: 'lighting', label: 'Lights on a motion sensor',
    keywords: ['porch', 'light', 'sensor', 'timer'], lines: ['pest', 'mosquito'], season: 'all',
    copy: "Every hour the porch light runs is another hour insects collect at the door. A motion sensor gives you light when you walk up and dark the rest of the night — by morning the difference at the threshold is obvious.",
  },
  {
    id: 'light_aim_away', group: 'lighting', label: 'Aim landscape lights away',
    keywords: ['landscape', 'uplight', 'spotlight', 'entry'], lines: ['pest'], season: 'all',
    copy: "Uplights pointed back at the walls gather insects at the entries every night. Turning them out toward the yard, or switching them to warm bulbs, moves that crowd away from the door.",
  },

  // ── Around the house ──────────────────────────────────────────────────
  {
    id: 'ext_shrub_clearance', group: 'exterior', label: "A hand's width off the wall",
    keywords: ['shrubs', 'hedge', 'trim', 'branches', 'wall'], lines: ['pest', 'tree_shrub'], season: 'all',
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
    keywords: ['lanai', 'screen', 'track', 'leaves', 'ants'], lines: ['pest', 'mosquito'], season: 'all',
    copy: "The screen track collects leaves and holds water after every rain — a food source for ants and a breeding spot for mosquitos in the same six inches. A monthly rinse with the hose takes care of both.",
  },
  {
    id: 'ext_palm_roof', group: 'exterior', label: 'Palm fronds off the roof',
    keywords: ['palm', 'fronds', 'roof', 'rats', 'branches'], lines: ['rodent', 'pest', 'tree_shrub'], season: 'all',
    copy: "Fronds and branches touching the roofline are a highway. Roof rats climb better than they burrow, and ants and roaches use the same route into the soffit. A few feet of clearance is exclusion without a single trap.",
  },
  {
    id: 'ext_leaf_litter', group: 'exterior', label: 'Clear leaf litter from the foundation',
    keywords: ['leaves', 'debris', 'earwigs', 'millipedes'], lines: ['pest'], season: 'all',
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
    keywords: ['mat', 'door mat', 'rug', 'rubber', 'lanai', 'water'], lines: ['mosquito', 'pest'], season: 'wet',
    copy: "Rubber-backed door mats and lanai floor mats hold a surprising amount of water underneath — enough for mosquitos to breed in, and a cool damp shelter for roaches and earwigs right at the threshold. After a rain, flip them or hang them on the rail until they're dry.",
  },

  // ── Kitchen and pantry ────────────────────────────────────────────────
  {
    id: 'interior_pet_bowls', group: 'kitchen', label: 'Pet bowls up overnight',
    keywords: ['pet', 'dog', 'cat', 'bowl', 'food', 'ants'], lines: ['pest'], season: 'all',
    copy: "A bowl left down is an open food and water source all night, and it's the most common thing I trace an ant trail back to. Up at bedtime, down at breakfast.",
  },
  {
    id: 'interior_trash_night', group: 'kitchen', label: 'Kitchen trash out at night',
    keywords: ['trash', 'garbage', 'can', 'roach'], lines: ['pest'], season: 'all',
    copy: "Roaches and ants forage overnight. An empty can gives them nothing on the shift they're actually working — the difference shows in a week.",
  },
  {
    id: 'interior_sealed_pantry', group: 'kitchen', label: 'Seal flour, rice, cereal, pet food',
    keywords: ['pantry', 'flour', 'rice', 'cereal', 'moths', 'weevils'], lines: ['pest'], season: 'all',
    copy: "Pantry pests usually arrive inside the bag from the store. Sealed containers keep one bad bag from spreading to the whole shelf, and they let you spot which one it was.",
  },
  {
    id: 'interior_range_grease', group: 'kitchen', label: 'Degrease behind the range',
    keywords: ['stove', 'range', 'grease', 'oven', 'german roach'], lines: ['pest'], season: 'all',
    copy: "The grease film behind and under a range is a calorie source that can sustain a German roach population on its own. Once a season, pull the range and degrease the wall, the floor, and the sides of the cabinets.",
  },
  {
    id: 'interior_cardboard', group: 'kitchen', label: 'Cardboard boxes to plastic bins',
    keywords: ['cardboard', 'boxes', 'garage', 'closet', 'storage'], lines: ['pest'], season: 'all',
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
    keywords: ['screen', 'lanai', 'tear', 'wasps', 'mosquito'], lines: ['mosquito', 'pest'], season: 'all',
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
    keywords: ['irrigation', 'sprinkler', 'water', 'fungus', 'timer'], lines: ['lawn', 'mosquito'], season: 'wet',
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
    copy: "A dull blade tears the leaf instead of cutting it. Torn tips brown out and are the entry point for fungus, so a sharpened blade once a season shows up as a greener lawn a week later.",
  },

  // ── Trees and shrubs ──────────────────────────────────────────────────
  {
    id: 'ts_ants_on_trunk', group: 'tree_shrub', label: 'Ants on the trunk = scale or aphids',
    keywords: ['ants', 'trunk', 'scale', 'aphids', 'sooty mold', 'honeydew'], lines: ['tree_shrub', 'pest'], season: 'all',
    copy: "Ants running up and down a trunk are usually farming scale or aphids for their honeydew, and the black sooty mold on the leaves is growing on that honeydew. If you see the ant traffic, let me know — it tells me exactly where the scale is.",
  },
  {
    id: 'ts_deep_water', group: 'tree_shrub', label: 'Deep and infrequent, not daily',
    keywords: ['shrubs', 'water', 'root rot', 'wilting', 'yellow'], lines: ['tree_shrub'], season: 'all',
    copy: "Root rot from overwatering looks like drought — wilting and yellowing — and the reflex is to water more. Established shrubs want deep, infrequent watering; let the top inch of soil dry between runs.",
  },
  {
    id: 'ts_mulch_trunk', group: 'tree_shrub', label: 'Keep mulch off the trunk',
    keywords: ['mulch', 'trunk', 'volcano', 'borers', 'bark'], lines: ['tree_shrub'], season: 'all',
    copy: "Mulch piled against the trunk keeps the bark wet and invites borers and rot at the collar. Pull it back into a ring a few inches from the trunk — a donut, not a volcano.",
  },

  // ── Pets and fleas ────────────────────────────────────────────────────
  {
    id: 'flea_bedding_vacuum', group: 'fleas', label: 'Hot-wash bedding, vacuum daily',
    keywords: ['flea', 'dog', 'cat', 'bedding', 'vacuum', 'eggs'], lines: ['pest'], season: 'all',
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
    id: 'gr_bait_spots', group: 'roaches', label: "Clean around the bait spots",
    keywords: ["bait", "gel", "cabinet", "wipe", "cleaner"], lines: ["pest"], season: 'all',
    services: ["german_roach", "german_roach_initial", "pest_initial_german_knockdown", "cockroach_control", "pest_initial_roach"],
    copy: "The small dots of bait in the cabinet corners and hinges are doing the work. Cleaner wiped over them, or anything sprayed near them, makes roaches stay away, so for the next few weeks clean around those spots instead of over them.",
  },
  {
    id: 'gr_no_store_spray', group: 'roaches', label: "No store-bought roach spray",
    keywords: ["spray", "fogger", "raid", "store", "over the counter"], lines: ["pest"], season: 'all',
    services: ["german_roach", "german_roach_initial", "pest_initial_german_knockdown", "cockroach_control", "pest_initial_roach"],
    copy: "Store sprays and foggers scatter German roaches into the walls and teach them to avoid the bait. If you see one, a paper towel and the trash is the better move while the bait works through the colony.",
  },
  {
    id: 'gr_dry_at_night', group: 'roaches', label: "Counters and sink dry at bedtime",
    keywords: ["sink", "counter", "dishes", "water", "night"], lines: ["pest"], season: 'all',
    services: ["german_roach", "german_roach_initial", "pest_initial_german_knockdown", "cockroach_control", "pest_initial_roach"],
    copy: "German roaches can't go long without water. Wiping the counters and sink dry before bed, with no dishes left soaking, takes away what they come out for at night and leaves the bait as their easiest meal.",
  },
  {
    id: 'gr_hitchhikers', group: 'roaches', label: "Unpack deliveries outside",
    keywords: ["delivery", "grocery", "appliance", "secondhand", "moving"], lines: ["pest"], season: 'all',
    services: ["german_roach", "german_roach_initial", "pest_initial_german_knockdown", "cockroach_control", "pest_initial_roach"],
    copy: "German roaches usually ride in: grocery boxes, used appliances, and secondhand furniture. Unpack deliveries in the garage or outside, and get the cardboard out of the house the same day.",
  },

  // ── Palmetto bugs (service tips, owner-approved 2026-10-02) ───────────────────────────────────────────────
  {
    id: 'pal_dry_drains', group: 'moisture', label: "Run water in unused drains",
    keywords: ["drain", "guest bath", "tub", "laundry sink", "palmetto"], lines: ["pest"], season: 'all',
    services: ["pest_initial_palmetto_knockdown", "pest_general_quarterly", "pest_general_bimonthly", "pest_general_monthly", "pest_onetime"],
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
    copy: "Treating the house and yard handles the fleas waiting there, but a pet without its own protection carries new ones back in. Ask your vet which preventive fits your pet and keep it on schedule while we work.",
  },
  {
    id: 'flea_shady_spots', group: 'fleas', label: "Open up where pets rest outside",
    keywords: ["yard", "shade", "deck", "fence", "dog run"], lines: ["pest"], season: 'all',
    services: ["flea_tick"],
    copy: "Outside, fleas develop in the shady, sheltered spots where pets lie down: under decks, along fences, beneath shrubs. Keeping those spots raked and open to the sun makes them a poor place for fleas to grow.",
  },
  {
    id: 'tick_mow_edges', group: 'fleas', label: "Mow short, clear the yard edges",
    keywords: ["tall grass", "brush", "leaf litter", "edges", "mow"], lines: ["pest"], season: 'all',
    services: ["tick_control", "flea_tick"],
    copy: "Ticks wait on tall grass and brush for something to walk past. Keeping the lawn mowed and the leaf litter raked up along the edges of the yard takes away the places they wait.",
  },
  {
    id: 'tick_wood_line', group: 'fleas', label: "A dry strip at the wood line",
    keywords: ["woods", "wood chips", "gravel", "border", "play set"], lines: ["pest"], season: 'all',
    services: ["tick_control", "flea_tick"],
    copy: "Where the lawn meets woods or brush, a 3-foot strip of wood chips or gravel makes a dry border ticks don't like to cross. Keep play sets and seating on the lawn side of it.",
  },
  {
    id: 'tick_check', group: 'fleas', label: "Check for ticks after yard work",
    keywords: ["check", "kids", "pets", "after yard work", "bite"], lines: ["pest"], season: 'all',
    services: ["tick_control", "flea_tick"],
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
    keywords: ["yellowjacket", "soda", "juice", "lanai", "trash"], lines: ["pest"], season: 'wet',
    services: ["bee_wasp_removal"],
    copy: "Late in the summer, yellowjackets go after sweets and come to open cans, juice boxes, and fruit on the lanai. Cups with lids and trash cans that close keep them from settling in around where you sit.",
  },
  {
    id: 'bw_call_early', group: 'stinging', label: "Call early about a new nest",
    keywords: ["nest", "eaves", "paper wasp", "small", "spring"], lines: ["pest"], season: 'all',
    services: ["bee_wasp_removal"],
    copy: "Paper wasps start a nest under the eaves as a small cluster in spring. A nest the size of a golf ball is a quick visit; by late summer the same spot can hold a few dozen wasps. If you see one starting, let me know.",
  },
  {
    id: 'md_rarely_sting', group: 'stinging', label: "Wash off old mud tubes",
    keywords: ["mud dauber", "mud tubes", "eaves", "hose", "lanai"], lines: ["pest"], season: 'all',
    services: ["mud_dauber_removal"],
    copy: "Mud daubers are solitary wasps and rarely sting; the mud tubes on the eaves and the lanai are their nurseries. Once the tubes are empty, washing them off with the hose keeps the eaves clean and shows you right away if new building starts.",
  },
  {
    id: 'md_fewer_spiders', group: 'stinging', label: "Fewer spiders, fewer mud daubers",
    keywords: ["spiders", "porch light", "bulbs", "eaves", "webs"], lines: ["pest"], season: 'all',
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
    id: 'rt_leave_traps', group: 'rodent', label: "Leave the traps where they are",
    keywords: ["traps", "move", "check", "attic", "garage"], lines: ["rodent"], season: 'all',
    services: ["rodent_trapping", "rodent_trapping_followup", "rodent_trapping_followup_3pack", "rodent_trapping_exclusion", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation", "rodent_general_one_time"],
    copy: "Rats are wary of anything new, so traps work best once they've sat in place a few nights. Moving them or checking them yourself starts that over; I check them at every visit.",
  },
  {
    id: 'rt_note_noises', group: 'rodent', label: "Note when and where you hear them",
    keywords: ["noise", "scratching", "night", "ceiling", "attic"], lines: ["rodent"], season: 'all',
    services: ["rodent_trapping", "rodent_trapping_followup", "rodent_trapping_followup_3pack", "rodent_trapping_exclusion", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation", "rodent_general_one_time"],
    copy: "The time of night and the room you hear scratching above show me where they're running. A quick note on your phone, like \"2 a.m., over the kitchen,\" helps me put the next traps right on that path.",
  },
  {
    id: 'rt_no_store_bait', group: 'rodent', label: "No store-bought rat bait inside",
    keywords: ["poison", "bait", "smell", "wall", "store"], lines: ["rodent"], season: 'all',
    services: ["rodent_trapping", "rodent_trapping_followup", "rodent_trapping_followup_3pack", "rodent_trapping_exclusion", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation", "rodent_general_one_time"],
    copy: "A rat that eats store-bought bait usually dies wherever it is, often inside a wall or the attic, where the smell lasts for weeks. Leave the attic to the traps, and let me know before adding anything of your own.",
  },
  {
    id: 'rt_doors_closed', group: 'rodent', label: "Attic and garage doors closed",
    keywords: ["pets", "kids", "dog", "attic door", "garage"], lines: ["rodent"], season: 'all',
    services: ["rodent_trapping", "rodent_trapping_followup", "rodent_trapping_followup_3pack", "rodent_trapping_exclusion", "rodent_trapping_sanitation", "rodent_trapping_exclusion_sanitation", "rodent_general_one_time"],
    copy: "The traps go where rodents run, not where people go, but a curious dog or child can still reach one in the garage. Keep the garage and attic doors closed while the traps are out.",
  },

  // ── Rodent exclusion (service tips, owner-approved 2026-10-02) ────────────────────────────────────────────
  {
    id: 'rx_garage_door', group: 'rodent', label: "Garage door closed at night",
    keywords: ["garage door", "night", "open", "dusk", "entry"], lines: ["rodent"], season: 'all',
    services: ["rodent_exclusion", "rodent_exclusion_only", "rodent_wire_mesh", "rodent_bird_box", "rodent_trapping_exclusion", "rodent_trapping_exclusion_sanitation"],
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
    id: 'tb_no_spray_stations', group: 'termite', label: "No insecticide near the stations",
    keywords: ["spray", "insecticide", "station", "bug spray", "perimeter"], lines: ["termite"], season: 'all',
    services: ["termite_bait", "termite_active_bait_quarterly", "termite_monitoring", "termite_cartridge_replacement", "pest_termite_bait_quarterly", "termite_installation_setup", "termite_active_annual"],
    copy: "Termites have to keep feeding at a station for the bait to reach the colony. Insecticide sprayed around a station can turn them away, so leave a clear foot around each one.",
  },

  // ── Termite treatment (liquid, trench, spot, foam) (service tips, owner-approved 2026-10-02) ──────────────
  {
    id: 'tl_before_digging', group: 'termite', label: "Call before digging by the foundation",
    keywords: ["digging", "planting", "edging", "pavers", "landscaper"], lines: ["termite"], season: 'all',
    services: ["termite_liquid", "termite_trench", "termite_trenching", "termite_spot_treatment", "foam_drill", "foam_recurring"],
    copy: "The treated soil along the foundation is the barrier. New plantings, edging, or pavers dug into that strip break it, so let me know before any work there starts.",
  },
  {
    id: 'tl_water_off_soil', group: 'termite', label: "Keep water off the treated soil",
    keywords: ["downspout", "sprinkler", "erosion", "foundation", "washout"], lines: ["termite"], season: 'all',
    services: ["termite_liquid", "termite_trench", "termite_trenching", "termite_spot_treatment", "foam_drill", "foam_recurring"],
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
 */
function tipsForVisit({ serviceLine, serviceKey = null, date = new Date() } = {}) {
  const line = registryLineFor(serviceLine);
  const season = seasonForDate(date);
  const inSeason = (tip) => tip.season === 'all' || tip.season === season;
  const bySeason = (a, b) => Number(inSeason(b)) - Number(inSeason(a));
  const groups = GROUP_ORDER[season]
    .map((groupId) => {
      const group = TIP_GROUPS.find((g) => g.id === groupId);
      const tips = TIPS.filter((tip) => tip.group === groupId && tip.lines.includes(line) && !tip.services)
        .sort(bySeason);
      return { ...group, primary: tips.some((tip) => tip.lines.includes(line)), tips };
    })
    .filter((group) => group.tips.length > 0);
  const forService = serviceKey ? TIPS.filter((tip) => tip.services?.includes(serviceKey)).sort(bySeason) : [];
  return {
    line,
    season,
    groups: forService.length ? [{ ...FOR_SERVICE_GROUP, primary: true, tips: forService }, ...groups] : groups,
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
  MAX_CUSTOM_TIP_CHARS,
  seasonForDate,
  registryLineFor,
  tipsForVisit,
  resolveTipIds,
  freezeTechTips,
  sentenceCount,
};
