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
  { id: 'fleas', label: 'Pets and fleas' },
]);
const GROUP_ORDER = Object.freeze({
  wet: ['moisture', 'water', 'lighting', 'exterior', 'kitchen', 'sealing', 'rodent', 'termite', 'lawn', 'tree_shrub', 'fleas'],
  dry: ['lighting', 'sealing', 'exterior', 'moisture', 'kitchen', 'water', 'rodent', 'termite', 'lawn', 'tree_shrub', 'fleas'],
});

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
 * Out-of-season tips remain available within that line.
 */
function tipsForVisit({ serviceLine, date = new Date() } = {}) {
  const line = registryLineFor(serviceLine);
  const season = seasonForDate(date);
  const inSeason = (tip) => tip.season === 'all' || tip.season === season;
  const groups = GROUP_ORDER[season]
    .map((groupId) => {
      const group = TIP_GROUPS.find((g) => g.id === groupId);
      const tips = TIPS.filter((tip) => tip.group === groupId && tip.lines.includes(line))
        .sort((a, b) => Number(inSeason(b)) - Number(inSeason(a)));
      return { ...group, primary: tips.some((tip) => tip.lines.includes(line)), tips };
    })
    .filter((group) => group.tips.length > 0);
  return { line, season, groups };
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
