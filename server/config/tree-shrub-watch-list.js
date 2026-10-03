/**
 * Tree & Shrub seasonal watch list (GATE_TS_WATCH_LIST, owner DRAFT 2026-10-01,
 * not yet approved: the whole list lives in this one file so it is easy to edit).
 *
 * Each month's list does three jobs: (1) it is fed to the photo read as "this
 * month's watch list" so photos are read against what is likely; (2) it is the
 * source of the technician's one-tap Seen / Not seen and "Add from watch list"
 * on the Fast Complete sheet; (3) nothing on it is something the technician has
 * to go and look for.
 *
 * Pure and frozen. An item is ONE entry however many months it appears in. A
 * key is stable and never renamed (it is stored on the service record).
 * `category` is one of the five photo-read finding keys. `referOnly` items are
 * "photo + note, then call the office": the sheet never takes an extent for
 * them. The read names an item only as a SIGNAL ("possible scale"); a
 * technician's Seen makes it a finding.
 *
 * Hard rule from the draft: three diagnosis-only disease names are never named
 * anywhere in this file or any string derived from it. A test pins that.
 */

const CATEGORY = Object.freeze({
  FOLIAGE: 'foliage_fullness',
  COLOR: 'leaf_color_vigor',
  PEST: 'pest_activity',
  DISEASE: 'disease_leaf_spot',
  STRESS: 'water_heat_mechanical_stress',
});

const item = (key, label, signal, category, referOnly = false) => Object.freeze({
  key, label, signal, category, referOnly,
});

const ITEM_LIST = [
  item('scale', 'Scale', 'Possible scale', CATEGORY.PEST),
  item('whitefly', 'Whitefly', 'Possible whitefly', CATEGORY.PEST),
  item('aphids', 'Aphids', 'Possible aphids', CATEGORY.PEST),
  item('spider_mites', 'Spider mites', 'Possible spider mites', CATEGORY.PEST),
  item('caterpillars', 'Caterpillars', 'Possible caterpillars', CATEGORY.PEST),
  item('sooty_mold', 'Sooty mold', 'Possible sooty mold', CATEGORY.PEST),
  item('bed_weeds', 'Bed weeds', 'Possible bed weeds', CATEGORY.FOLIAGE),
  item('cold_freeze_damage', 'Cold or freeze damage', 'Possible cold or freeze damage', CATEGORY.STRESS),
  item('chlorosis', 'Chlorosis', 'Possible chlorosis', CATEGORY.COLOR),
  item('leaf_spot', 'Leaf spot / bacterial spot', 'Possible leaf spot', CATEGORY.DISEASE),
  item('heat_stress', 'Heat stress', 'Possible heat stress', CATEGORY.STRESS),
  item('heat_drought_decline', 'Heat / drought decline', 'Possible heat or drought decline', CATEGORY.STRESS),
  item('root_rot', 'Root or collar rot', 'Possible root or collar rot', CATEGORY.DISEASE),
  item('palm_weevil_crown_decline', 'Palm weevil / crown decline signs', 'Possible palm weevil or crown decline signs', CATEGORY.PEST, true),
  item('declining_palms', 'Declining palms', 'Possible declining palms', CATEGORY.FOLIAGE, true),
  item('palm_potassium_deficiency', 'Palm potassium deficiency', 'Possible potassium deficiency', CATEGORY.COLOR),
  item('palm_magnesium_deficiency', 'Palm magnesium deficiency', 'Possible magnesium deficiency', CATEGORY.COLOR),
  item('palm_fronds_dying_one_side', 'Fronds dying down one side', 'Possible fronds dying down one side', CATEGORY.FOLIAGE),
  item('trunk_conk_base', 'Trunk conk at the base', 'Possible trunk conk at the base', CATEGORY.DISEASE, true),
];

const ITEMS = Object.freeze(Object.fromEntries(ITEM_LIST.map((entry) => [entry.key, entry])));

// Year-round palm items (palm scout notes, protocol): appended to every month.
const YEAR_ROUND = Object.freeze([
  'palm_potassium_deficiency',
  'palm_magnesium_deficiency',
  'palm_fronds_dying_one_side',
  'trunk_conk_base',
]);

// Month -> the draft table's items, most likely first, before the year-round
// palm items. Where the draft names one item two ways in different months
// (scale / scale crawlers / fall scale flush, whitefly / whitefly nymphs, mites,
// bed weeds / bed weed breakthrough, root rot / collar rot) it is the one entry.
const MONTH_ITEMS = {
  1: ['scale', 'bed_weeds', 'cold_freeze_damage', 'sooty_mold'],
  2: ['scale', 'spider_mites', 'chlorosis', 'caterpillars'],
  3: ['whitefly', 'scale', 'aphids', 'sooty_mold'],
  4: ['whitefly', 'scale', 'caterpillars', 'bed_weeds', 'aphids'],
  5: ['whitefly', 'spider_mites', 'chlorosis', 'palm_weevil_crown_decline'],
  6: ['leaf_spot', 'whitefly', 'caterpillars', 'heat_stress'],
  7: ['bed_weeds', 'whitefly', 'scale', 'leaf_spot', 'heat_stress'],
  8: ['whitefly', 'spider_mites', 'caterpillars', 'heat_drought_decline', 'root_rot'],
  9: ['scale', 'whitefly', 'leaf_spot', 'chlorosis', 'bed_weeds'],
  10: ['scale', 'whitefly', 'root_rot', 'bed_weeds'],
  11: ['chlorosis', 'scale', 'sooty_mold', 'caterpillars'],
  12: ['scale', 'cold_freeze_damage', 'declining_palms', 'sooty_mold'],
};

const MONTHS = Object.freeze(Object.fromEntries(
  Object.entries(MONTH_ITEMS).map(([month, keys]) => [month, Object.freeze([...keys, ...YEAR_ROUND])]),
));

// Extent a technician may give a seen item (never on a referOnly item).
const EXTENTS = Object.freeze(['one_plant', 'a_few', 'many']);
const REFER_ONLY_LINE = 'Take a photo, add a note and call the office.';

function validMonth(month) {
  const n = typeof month === 'string' && /^\d{1,2}$/.test(month.trim()) ? Number(month) : month;
  return Number.isInteger(n) && n >= 1 && n <= 12 ? n : null;
}

// A known key or null. Strings are trimmed and lower-cased; anything else is null.
function normalizeWatchKey(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim().toLowerCase();
  return Object.hasOwn(ITEMS, key) ? key : null;
}

// The month's items in list order (a fresh array of the frozen entries);
// an invalid month answers [].
function watchListForMonth(month) {
  const m = validMonth(month);
  return m ? MONTHS[m].map((key) => ITEMS[key]) : [];
}

// The model's optional watch_signals -> known keys on THIS month's list, no
// duplicates, in list order. Missing or malformed = []. Never throws.
function normalizeWatchSignals(value, month) {
  if (!Array.isArray(value)) return [];
  const allowed = new Set(watchListForMonth(month).map((entry) => entry.key));
  const found = new Set();
  for (const raw of value) {
    const key = normalizeWatchKey(raw);
    if (key && allowed.has(key)) found.add(key);
  }
  return watchListForMonth(month).map((entry) => entry.key).filter((key) => found.has(key));
}

// The standalone prompt for the watch-signal read, or '' for a month with no
// list. A separate call from the main photo read: it asks ONLY for the keys, as
// possible signals, never a confirmed diagnosis, no scores and no prose.
function watchListPromptBlock(month) {
  const items = watchListForMonth(month);
  if (!items.length) return '';
  const lines = items.map((entry) => `- ${entry.key}: ${entry.signal}`).join('\n');
  return `You look at one photo of shrubs, hedges, palms, trees or landscape beds for a professional pest control company in Southwest Florida.

This month's watch list (what is most likely on these plants this time of year, most likely first):
${lines}

Name the keys above, exactly as written, of any watch-list items this photo shows signs of. Name an item only as a possible signal, never a confirmed diagnosis. Base this strictly on what is visible, and use an empty array when none are visible.

Return ONLY this JSON object and nothing else, with no scores, no observations, no markdown and no backticks:
{"watch_signals": ["<watch-list key>"]}`;
}

module.exports = {
  CATEGORY,
  ITEMS,
  MONTHS,
  YEAR_ROUND,
  EXTENTS,
  REFER_ONLY_LINE,
  validMonth,
  normalizeWatchKey,
  watchListForMonth,
  normalizeWatchSignals,
  watchListPromptBlock,
};
