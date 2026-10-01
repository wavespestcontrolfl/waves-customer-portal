/**
 * SWFL yard pressure calendar — a derived monthly view of the species catalog.
 *
 * The catalog (services/species-catalog.js) owns WHEN each pest, disease or
 * weed is active (`active_months`, `peak_months`). This module adds only the
 * small editorial overlay the catalog does not carry: which entries appear,
 * how they are grouped (lawn / shrub / weed), host and grass text, the
 * homeowner-facing sign and look-alike copy, and the plan-ahead notes. No
 * month array is copied here, so a catalog edit flows straight through.
 *
 * Level rule per calendar month m (1-12), over the entry's catalog months:
 *   m in peak_months                          -> 3  Peak season
 *   m in active_months, active all 12 months  -> 1  Low year-round
 *   m in active_months otherwise              -> 2  In season
 *   anything else                             -> 0  Off season
 * A combined row (several catalog slugs) takes the max level of its members.
 *
 * Pure and synchronous: no DB, no network, no LLM. The overlay is checked
 * against the catalog at require time; a missing or unapproved slug is left
 * out with a warning (never a boot crash), and the overlay test fails CI.
 */

'use strict';

const catalog = require('../species-catalog');
const logger = require('../logger');

const REVIEWED_AT = '2026-09-30';
const AREA = 'Southwest Florida';

const GRASSES = Object.freeze(['sta', 'bah', 'zoy', 'ber']);
const GRASS_FILTERS = Object.freeze(['all', ...GRASSES]);
const CATEGORIES = Object.freeze(['lawn', 'shrub', 'weed']);

const LEVEL_LABELS = Object.freeze({
  3: 'Peak season',
  2: 'In season',
  1: 'Low year-round',
  0: 'Off season',
});

// Editorial overlay, in display order. `slugs` are catalog entry slugs;
// `grassKeys` (lawn only) lists the grasses the item affects, omitted = all.
const ITEMS = [
  { id: 'sod-webworm', slugs: ['sod-webworm'], category: 'lawn', name: 'Tropical sod webworm', hosts: 'St. Augustine, Bermuda, Bahia', grassKeys: ['sta', 'ber', 'bah'], sign: 'Notched, chewed blades and ragged patches. The larvae do the damage; moths flying up at dusk mean it is time to look.', lookAlike: 'Looks like: chinch bug or drought patches, but the blades are chewed.' },
  { id: 'white-grub', slugs: ['white-grub'], category: 'lawn', name: 'White grubs', hosts: 'All grasses', sign: 'Wilting patches that peel back like carpet, with C-shaped grubs in the soil.', lookAlike: 'Looks like: drought stress, but the turf lifts with no roots.' },
  { id: 'fall-armyworm', slugs: ['fall-armyworm'], category: 'lawn', name: 'Fall armyworm', hosts: 'All grasses, Bermuda most', sign: 'Large areas browned almost overnight, with caterpillars feeding in groups.', lookAlike: 'Looks like: sod webworm, but the damage is even and fast.' },
  { id: 'mole-cricket', slugs: ['mole-cricket'], category: 'lawn', name: 'Mole crickets', hosts: 'Bahia, Bermuda', grassKeys: ['bah', 'ber'], sign: 'Raised tunnels and spongy soil that feels loose underfoot.', lookAlike: 'Looks like: animal digging, but with tunnels near the surface.' },
  { id: 'chinch-bug', slugs: ['chinch-bug'], category: 'lawn', name: 'Chinch bugs', hosts: 'St. Augustine', grassKeys: ['sta'], sign: 'Yellow-to-brown patches in the sunniest, driest spots, often along drives.', lookAlike: 'Looks like: drought, but water doesn\'t bring it back.' },
  { id: 'take-all-root-rot', slugs: ['take-all-root-rot'], category: 'lawn', name: 'Take-all root rot', hosts: 'St. Augustine, Bermuda', grassKeys: ['sta', 'ber'], sign: 'Thinning, yellow turf with short, dark roots. Roots are hit weeks before leaves show it.', lookAlike: 'Looks like: drought or nutrient problems.' },
  { id: 'gray-leaf-spot', slugs: ['gray-leaf-spot'], category: 'lawn', name: 'Gray leaf spot', hosts: 'St. Augustine', grassKeys: ['sta'], sign: 'Gray-brown oval spots with dark borders on the blades.' },
  { id: 'large-patch', slugs: ['large-patch'], category: 'lawn', name: 'Large patch', hosts: 'St. Augustine, Zoysia', grassKeys: ['sta', 'zoy'], sign: 'Yellow-orange rings that brown as nights cool. Blades pull free at the base.', lookAlike: 'Looks like: take-all, but the rot is at the leaf base, not the roots.' },
  { id: 'ficus-whitefly', slugs: ['ficus-whitefly'], category: 'shrub', name: 'Ficus whitefly', hosts: 'Ficus hedges', sign: 'A white cloud when you brush the hedge, then leaf drop and thin, bare stems.' },
  { id: 'chilli-thrips', slugs: ['chilli-thrips'], category: 'shrub', name: 'Chilli thrips', hosts: 'New growth on many shrubs', sign: 'Curled, bronzed or stunted new leaves.', lookAlike: 'Looks like: herbicide drift or cold injury.' },
  { id: 'spider-mites', slugs: ['spider-mites'], category: 'shrub', name: 'Spider mites', hosts: 'Dry, dusty shrubs', sign: 'Fine speckling on leaves, sometimes with fine webbing underneath.' },
  { id: 'aphid', slugs: ['aphid'], category: 'shrub', name: 'Aphids', hosts: 'New growth', sign: 'Clusters on tender shoots, with sticky honeydew and black sooty mold.' },
  { id: 'asian-citrus-psyllid', slugs: ['asian-citrus-psyllid'], category: 'shrub', name: 'Asian citrus psyllid', hosts: 'Citrus new flush', sign: 'Tiny insects tilted head-down on new citrus growth.' },
  { id: 'citrus-leafminer', slugs: ['citrus-leafminer'], category: 'shrub', name: 'Citrus leafminer', hosts: 'Young citrus leaves', sign: 'Silvery, winding trails inside young leaves, which curl.' },
  { id: 'florida-wax-scale', slugs: ['florida-wax-scale'], category: 'shrub', name: 'Florida wax scale', hosts: 'Hollies and other shrubs', sign: 'White waxy bumps along stems, with yellowing and sooty mold.' },
  { id: 'potassium-deficiency-palm', slugs: ['potassium-deficiency-palm'], category: 'shrub', name: 'Potassium deficiency', hosts: 'Palms', sign: 'Older fronds with yellow-orange spots and dead, frizzled tips.', lookAlike: 'Looks like: disease, but it starts on the oldest fronds.' },
  { id: 'ganoderma-butt-rot', slugs: ['ganoderma-butt-rot'], category: 'shrub', name: 'Ganoderma butt rot', hosts: 'Palms', infoOnly: true, sign: 'A shelf-like conk at the trunk base. The palm can fall; call an arborist.' },
  { id: 'citrus-greening', slugs: ['citrus-greening'], category: 'shrub', name: 'Citrus greening', hosts: 'Citrus', infoOnly: true, sign: 'Blotchy, uneven yellowing on leaves and small, lopsided fruit.', lookAlike: 'Looks like: nutrient deficiency, but the yellowing is not symmetrical.' },
  { id: 'dollarweed', slugs: ['dollarweed'], category: 'weed', name: 'Dollarweed', hosts: 'Wet spots', sign: 'Round, coin-shaped leaves spreading where the lawn stays wet.' },
  { id: 'nutsedge', slugs: ['yellow-nutsedge', 'purple-nutsedge'], category: 'weed', name: 'Nutsedge', hosts: 'Irrigated lawns', sign: 'Bright green, upright clumps that outgrow the lawn. Pulling alone rarely controls an established patch.', lookAlike: 'Looks like: a grass weed, but the stem is triangular.' },
  { id: 'doveweed', slugs: ['doveweed'], category: 'weed', name: 'Doveweed', hosts: 'Wet, thin lawns', sign: 'Glossy, grass-like leaves that creep and root at the joints.' },
  { id: 'green-kyllinga', slugs: ['green-kyllinga'], category: 'weed', name: 'Green kyllinga', hosts: 'Wet lawns', sign: 'Low, dense mats of bright green sedge with round seed heads.' },
  { id: 'winter-weeds', slugs: ['cudweed', 'asiatic-hawksbeard'], category: 'weed', name: 'Winter weeds (cudweed, hawksbeard)', hosts: 'Thin lawns', sign: 'Flat rosettes appearing as nights cool.' },
];

// Prevention windows from the owner-approved protocols, keyed by calendar
// month (1-12).
const PLAN_AHEAD = {
  10: [
    'Large patch starts in November. October is the preventive window on St. Augustine and Zoysia.',
    'Winter weeds are starting. October and November are the pre-emergent window.',
  ],
  11: ['Winter weeds are still in the pre-emergent window.'],
};

function monthLevel(entry, month) {
  const peak = entry.peak_months || [];
  const active = entry.active_months || [];
  if (peak.includes(month)) return 3;
  if (active.includes(month)) return new Set(active).size === 12 ? 1 : 2;
  return 0;
}

// Resolve every overlay item against the catalog once, at load. A malformed
// overlay throws (a code error). A catalog slug that is missing or not
// owner-approved (hash-verified) is dropped with a warning instead of
// throwing: this module loads at server boot, so a catalog edit awaiting
// re-approval must never take the portal down. The overlay-vs-catalog test
// fails CI in that case, so the thinner calendar never ships unnoticed.
function resolveItems() {
  const ids = new Set();
  return ITEMS.map((item) => {
    if (ids.has(item.id)) throw new Error(`landscape-calendar: duplicate item id "${item.id}"`);
    ids.add(item.id);
    if (!CATEGORIES.includes(item.category)) {
      throw new Error(`landscape-calendar: item "${item.id}" has unknown category "${item.category}"`);
    }
    if (item.grassKeys && (item.category !== 'lawn' || !item.grassKeys.every((g) => GRASSES.includes(g)))) {
      throw new Error(`landscape-calendar: item "${item.id}" has invalid grassKeys`);
    }
    const entries = item.slugs.map((slug) => {
      const entry = catalog.getEntry(slug);
      if (!entry) {
        logger.warn(`[landscape-calendar] catalog entry "${slug}" (item "${item.id}") not found; left out`);
        return null;
      }
      if (!catalog.isApproved(entry)) {
        logger.warn(`[landscape-calendar] catalog entry "${slug}" (item "${item.id}") is not owner_approved; left out`);
        return null;
      }
      return entry;
    }).filter(Boolean);
    if (!entries.length) return null;
    const levels = [];
    for (let m = 1; m <= 12; m += 1) levels.push(Math.max(...entries.map((e) => monthLevel(e, m))));
    return Object.freeze({
      id: item.id,
      category: item.category,
      name: item.name,
      hosts: item.hosts,
      grassKeys: item.category === 'lawn' ? Object.freeze([...(item.grassKeys || GRASSES)]) : null,
      levels: Object.freeze(levels),
      sign: item.sign,
      lookAlike: item.lookAlike || null,
      infoOnly: item.infoOnly === true,
      serviceLine: entries[0].service?.line ?? null,
      link: entries.map((e) => e.links?.site_page).find(Boolean) || null,
    });
  }).filter(Boolean);
}

const RESOLVED = Object.freeze(resolveItems());

function trendFor(levels, month) {
  const now = levels[month - 1];
  const next = levels[month % 12];
  if (next > now && now < 3) return next === 3 ? 'peak_next_month' : 'starts_next_month';
  if (now === 3 && next < 3) return 'easing_next_month';
  return null;
}

function isValidMonth(month) {
  return Number.isInteger(month) && month >= 1 && month <= 12;
}

/**
 * @param {{ month: number, grass?: string }} opts  month 1-12; grass one of
 *   all|sta|bah|zoy|ber (missing = all). Throws RangeError on bad input.
 */
function buildYardCalendar({ month, grass = 'all' } = {}) {
  if (!isValidMonth(month)) throw new RangeError('month must be an integer 1-12');
  if (!GRASS_FILTERS.includes(grass)) throw new RangeError(`grass must be one of ${GRASS_FILTERS.join(', ')}`);

  const items = RESOLVED
    .filter((r) => grass === 'all' || !r.grassKeys || r.grassKeys.includes(grass))
    .map((r) => {
      const level = r.levels[month - 1];
      return {
        id: r.id,
        category: r.category,
        name: r.name,
        hosts: r.hosts,
        grassKeys: r.grassKeys ? [...r.grassKeys] : null,
        level,
        levelLabel: LEVEL_LABELS[level],
        levels: [...r.levels],
        trend: trendFor(r.levels, month),
        sign: r.sign,
        lookAlike: r.lookAlike,
        infoOnly: r.infoOnly,
        serviceLine: r.serviceLine,
        link: r.link,
      };
    });

  return {
    month,
    grass,
    area: AREA,
    reviewedAt: REVIEWED_AT,
    items,
    planAhead: [...(PLAN_AHEAD[month] || [])],
  };
}

module.exports = {
  buildYardCalendar,
  isValidMonth,
  GRASS_FILTERS,
  LEVEL_LABELS,
  // Test hooks: the overlay slugs per item, to cross-check against the catalog.
  _overlaySlugs: () => ITEMS.flatMap((i) => i.slugs),
};
