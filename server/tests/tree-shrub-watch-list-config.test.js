// GATE_TS_WATCH_LIST config: the owner's DRAFT seasonal watch list
// (ts-fast-complete-scope appendix), encoded once. Synthetic data only.
const {
  ITEMS, MONTHS, YEAR_ROUND, EXTENTS, CATEGORY, normalizeWatchKey, watchListForMonth,
  normalizeWatchSignals, watchListPromptBlock, validMonth,
} = require('../config/tree-shrub-watch-list');
const { KEY_TO_SCORE } = require('../services/service-report/tree-shrub-tech-findings');

// The draft table, phrase by phrase, and the one entry each phrase is.
const PHRASE_KEY = {
  'Scale (cool-season flush on ornamentals)': 'scale',
  'bed weeds ahead of Snapshot': 'bed_weeds',
  'cold/freeze damage after a cold snap': 'cold_freeze_damage',
  'sooty mold': 'sooty_mold',
  'Scale crawlers': 'scale',
  'spider mites (dry weather)': 'spider_mites',
  'iron/manganese chlorosis (yellow new leaves, green veins)': 'chlorosis',
  'caterpillars on new growth': 'caterpillars',
  'Whitefly (ficus, spiraling whitefly on palms/gumbo limbo)': 'whitefly',
  'scale': 'scale',
  'aphids on new flush': 'aphids',
  'Whitefly': 'whitefly',
  'caterpillars': 'caterpillars',
  'bed weed breakthrough': 'bed_weeds',
  'aphids': 'aphids',
  'spider mites (heat, dry)': 'spider_mites',
  'chlorosis before the summer blackout': 'chlorosis',
  'palm weevil / crown decline signs (photo + note, refer)': 'palm_weevil_crown_decline',
  'Leaf spot / bacterial spot (rainy season starts)': 'leaf_spot',
  'whitefly': 'whitefly',
  'heat stress on new plantings': 'heat_stress',
  'Bed weeds': 'bed_weeds',
  'scale crawlers': 'scale',
  'leaf spot': 'leaf_spot',
  'heat stress': 'heat_stress',
  'Whitefly (peak)': 'whitefly',
  'mites': 'spider_mites',
  'heat/drought decline': 'heat_drought_decline',
  'root rot in wet beds': 'root_rot',
  'Scale and whitefly (late-summer cycle)': ['scale', 'whitefly'],
  'chlorosis (palm K/Mg/Mn signs)': 'chlorosis',
  'Fall scale flush': 'scale',
  'whitefly nymphs': 'whitefly',
  'root/collar rot in wet beds': 'root_rot',
  'Chlorosis on high-pH beds': 'chlorosis',
  'declining palms (photo + note, refer)': 'declining_palms',
};
const DRAFT = {
  1: ['Scale (cool-season flush on ornamentals)', 'bed weeds ahead of Snapshot', 'cold/freeze damage after a cold snap', 'sooty mold'],
  2: ['Scale crawlers', 'spider mites (dry weather)', 'iron/manganese chlorosis (yellow new leaves, green veins)', 'caterpillars on new growth'],
  3: ['Whitefly (ficus, spiraling whitefly on palms/gumbo limbo)', 'scale', 'aphids on new flush', 'sooty mold'],
  4: ['Whitefly', 'scale crawlers', 'caterpillars', 'bed weed breakthrough', 'aphids'],
  5: ['Whitefly', 'spider mites (heat, dry)', 'chlorosis before the summer blackout', 'palm weevil / crown decline signs (photo + note, refer)'],
  6: ['Leaf spot / bacterial spot (rainy season starts)', 'whitefly', 'caterpillars', 'heat stress on new plantings'],
  7: ['Bed weeds', 'whitefly', 'scale crawlers', 'leaf spot', 'heat stress'],
  8: ['Whitefly (peak)', 'mites', 'caterpillars', 'heat/drought decline', 'root rot in wet beds'],
  9: ['Scale and whitefly (late-summer cycle)', 'leaf spot', 'chlorosis (palm K/Mg/Mn signs)', 'Bed weeds'],
  10: ['Fall scale flush', 'whitefly nymphs', 'root/collar rot in wet beds', 'bed weeds ahead of Snapshot'],
  11: ['Chlorosis on high-pH beds', 'scale', 'sooty mold', 'caterpillars'],
  12: ['Scale', 'cold/freeze damage after a cold snap', 'declining palms (photo + note, refer)', 'sooty mold'],
};
const YEAR_ROUND_KEYS = ['palm_potassium_deficiency', 'palm_magnesium_deficiency', 'palm_fronds_dying_one_side', 'trunk_conk_base'];
const draftKeys = (month) => DRAFT[month].flatMap((phrase) => {
  const hit = PHRASE_KEY[phrase] || PHRASE_KEY[phrase.charAt(0).toLowerCase() + phrase.slice(1)]
    || PHRASE_KEY[phrase.charAt(0).toUpperCase() + phrase.slice(1)];
  if (!hit) throw new Error(`unmapped draft phrase: ${phrase}`);
  return hit;
});

describe('the table matches the draft month by month', () => {
  for (let month = 1; month <= 12; month += 1) {
    test(`month ${month}: draft items in draft order, then the year-round palm items`, () => {
      expect(MONTHS[month]).toEqual([...draftKeys(month), ...YEAR_ROUND_KEYS]);
      expect(watchListForMonth(month).map((item) => item.key)).toEqual([...draftKeys(month), ...YEAR_ROUND_KEYS]);
    });
  }
  test('twelve months, no repeated key inside a month', () => {
    expect(Object.keys(MONTHS)).toHaveLength(12);
    for (const keys of Object.values(MONTHS)) expect(new Set(keys).size).toBe(keys.length);
  });
  test('an item in several months is ONE entry; every entry is on some month; every month key is an entry', () => {
    const used = new Set(Object.values(MONTHS).flat());
    expect([...used].sort()).toEqual(Object.keys(ITEMS).sort());
    expect(YEAR_ROUND).toEqual(YEAR_ROUND_KEYS);
    for (const month of Object.keys(MONTHS)) for (const key of YEAR_ROUND_KEYS) expect(MONTHS[month]).toContain(key);
  });
});

describe('entries', () => {
  test('stable snake_case keys, a label, a signal, a finding category, a boolean referOnly', () => {
    const categories = Object.keys(KEY_TO_SCORE);
    for (const [key, item] of Object.entries(ITEMS)) {
      expect(key).toMatch(/^[a-z]+(_[a-z]+)*$/);
      expect(item.key).toBe(key);
      expect(item.label).toEqual(expect.any(String));
      expect(item.signal).toMatch(/^Possible /);
      expect(categories).toContain(item.category);
      expect(typeof item.referOnly).toBe('boolean');
    }
    expect(Object.values(CATEGORY).sort()).toEqual(categories.sort());
  });
  test('refer-only is exactly trunk conk, palm weevil / crown decline and declining palms', () => {
    expect(Object.values(ITEMS).filter((item) => item.referOnly).map((item) => item.key).sort())
      .toEqual(['declining_palms', 'palm_weevil_crown_decline', 'trunk_conk_base']);
  });
  test('frozen all the way down', () => {
    expect(Object.isFrozen(ITEMS)).toBe(true);
    expect(Object.isFrozen(ITEMS.scale)).toBe(true);
    expect(Object.isFrozen(MONTHS)).toBe(true);
    expect(Object.isFrozen(MONTHS[1])).toBe(true);
    expect(Object.isFrozen(EXTENTS)).toBe(true);
    expect(EXTENTS).toEqual(['one_plant', 'a_few', 'many']);
  });
});

describe('diagnosis-only disease names are never named (draft hard rule)', () => {
  const FORBIDDEN = /ganoderma|lethal\s+bronzing|fusarium/i;
  test('not in the config, any month list, or the prompt block for any month', () => {
    expect(JSON.stringify({ ITEMS, MONTHS })).not.toMatch(FORBIDDEN);
    for (let month = 1; month <= 12; month += 1) {
      expect(watchListPromptBlock(month)).not.toMatch(FORBIDDEN);
      expect(JSON.stringify(watchListForMonth(month))).not.toMatch(FORBIDDEN);
    }
    // the source file itself, comments included
    expect(require('fs').readFileSync(require.resolve('../config/tree-shrub-watch-list'), 'utf8')).not.toMatch(FORBIDDEN);
  });
});

describe('watchListForMonth / normalizeWatchKey / normalizeWatchSignals', () => {
  test('an invalid month answers []', () => {
    for (const bad of [0, 13, -1, 1.5, null, undefined, 'x', NaN, {}, []]) expect(watchListForMonth(bad)).toEqual([]);
    expect(validMonth('10')).toBe(10);
    expect(watchListForMonth('10')).toHaveLength(MONTHS[10].length);
  });
  test('normalizeWatchKey is a known key or null', () => {
    expect(normalizeWatchKey('scale')).toBe('scale');
    expect(normalizeWatchKey('  Scale ')).toBe('scale');
    for (const bad of ['nope', '', null, undefined, 5, {}, '__proto__', 'constructor', 'toString']) expect(normalizeWatchKey(bad)).toBeNull();
  });
  test('signals: unknown dropped, duplicates removed, list order, only this month, malformed = []', () => {
    expect(normalizeWatchSignals(['sooty_mold', 'scale', 'scale', 'nope', 5, null, 'SCALE'], 1)).toEqual(['scale', 'sooty_mold']);
    // aphids is not on January's list
    expect(normalizeWatchSignals(['aphids', 'trunk_conk_base'], 1)).toEqual(['trunk_conk_base']);
    for (const bad of [undefined, null, 'scale', 5, {}, { 0: 'scale' }]) expect(normalizeWatchSignals(bad, 1)).toEqual([]);
    expect(normalizeWatchSignals(['scale'], 13)).toEqual([]);
  });
  test('the prompt block lists the month in order, is a standalone prompt asking only for watch_signals as possible signals, and is empty for a bad month', () => {
    const block = watchListPromptBlock(3);
    expect(block).toContain("This month's watch list");
    expect(MONTHS[3].every((key) => block.includes(`- ${key}: ${ITEMS[key].signal}`))).toBe(true);
    expect(block.indexOf('- whitefly:')).toBeLessThan(block.indexOf('- scale:'));
    expect(block).toContain('{"watch_signals": ["<watch-list key>"]}');
    expect(block).toMatch(/Return ONLY this JSON object/);
    expect(block).toMatch(/no scores, no observations/);
    expect(block).toMatch(/possible signal, never a confirmed diagnosis/);
    expect(watchListPromptBlock(0)).toBe('');
  });
  test('no em dashes in any tech-facing string', () => {
    expect(JSON.stringify(ITEMS) + watchListPromptBlock(1)).not.toContain('—');
  });
});
