// The new lawn outline layout, behind GATE_LAWN_OUTLINE_VISUAL (owner "build" 2026-10-31, the nine-round outline scope
// page). Synthetic inputs: no database.
//
// Pins: the gate is strict and needs GATE_LAWN_OUTLINE_DETAIL; off = the detailed outline exactly; on = the approved
// section order; a rounds estimate (its lawn line seeds as lawn_rounds_9, which needs GATE_LAWN_9X_ROUNDS) draws nine
// year-bar blocks whose main steps are DERIVED from the protocol, the round the visit falls in, the Manatee summer band,
// and no LESCO 44-0-0 in the products; a monthly estimate draws twelve blocks and today's month list; an estimate whose
// plan is not known draws the month view and names no plan; every new section keeps text bullets; every word passes the
// customer-copy checks.

const outline = require('../services/lawn-service-outline');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const GATE_NAMES = ['GATE_LAWN_V13', 'GATE_LAWN_OUTLINE_V13', 'GATE_LAWN_OUTLINE_DETAIL', 'GATE_LAWN_OUTLINE_VISUAL', 'GATE_LAWN_9X_ROUNDS', 'GATE_LAWN_BERMUDA_REMOVAL'];
const DETAIL = { GATE_LAWN_V13: 'true', GATE_LAWN_OUTLINE_V13: 'true', GATE_LAWN_OUTLINE_DETAIL: 'true' };
const VISUAL = { ...DETAIL, GATE_LAWN_OUTLINE_VISUAL: 'true' };
const ROUNDS_ON = { ...VISUAL, GATE_LAWN_9X_ROUNDS: 'true' };
const OCT_26 = new Date('2026-10-26T12:00:00Z');

async function withGates(values, fn) {
  const saved = Object.fromEntries(GATE_NAMES.map((name) => [name, process.env[name]]));
  try {
    for (const name of GATE_NAMES) {
      if (values[name] === undefined) delete process.env[name]; else process.env[name] = values[name];
    }
    return await fn();
  } finally {
    for (const name of GATE_NAMES) {
      if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name];
    }
  }
}

const RULES = {
  sarasota_county_fl: 'Sarasota County, FL',
  manatee_county_fl: 'Manatee County, FL',
  charlotte_county_fl: 'Charlotte County, FL',
};
const ADDRESSES = {
  sarasota_county_fl: '100 Test Way, Sarasota, FL 34240',
  manatee_county_fl: '100 Test Way, Bradenton, FL 34202',
  charlotte_county_fl: '100 Test Way, Port Charlotte, FL 33948',
};

// Catalog rows as production stores them, including the 12-visit April bag the rounds list must drop.
const CATALOG = [
  { name: 'Celsius WG', display_name: null, active_ingredient: 'Thiencarbazone + Iodosulfuron + Dicamba', category: 'herbicide', product_type: 'pesticide' },
  { name: 'LESCO 44-0-0 100% PolyPlus OPTI120 Turfgrass Granular Fertilizer', display_name: 'LESCO 44-0-0', active_ingredient: '44-0-0', category: 'fertilizer', product_type: null },
  { name: 'LESCO 24-0-11 with PolyPlus OPTI', display_name: 'LESCO 24-0-11', active_ingredient: '24-0-11', category: 'fertilizer', product_type: null },
  { name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', display_name: null, active_ingredient: 'dithiopyr 0.21% + 18-0-10', category: 'herbicide', product_type: 'pesticide' },
  { name: 'Arena 50 WDG', display_name: null, active_ingredient: 'Clothianidin 50%', category: 'insecticide', product_type: 'pesticide' },
];

function makeDb({ jurisdictionId = 'manatee_county_fl' } = {}) {
  const rule = {
    jurisdiction_id: jurisdictionId,
    jurisdiction_name: RULES[jurisdictionId],
    version: '2026-05-30',
    public_summary: 'Local fertilizer rules may restrict nitrogen and phosphorus applications during the summer rainy season.',
    restricted_start_month: 6,
    restricted_start_day: 1,
    restricted_end_month: 9,
    restricted_end_day: 30,
  };
  const db = jest.fn((table) => {
    const rows = table === 'products_catalog' ? CATALOG : [];
    const chain = {
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      orWhere: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      select: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      first: jest.fn(() => Promise.resolve(table === 'jurisdiction_fertilizer_rules' ? rule : null)),
      then: (resolve, reject) => Promise.resolve(rows).then(resolve, reject),
    };
    return chain;
  });
  db.fn = { now: jest.fn(() => OCT_26) };
  return db;
}

const lawnLine = (visitsPerYear, frequency) => ({ service: 'lawn_care', name: 'Lawn Care', frequency, visitsPerYear });
const estimateOf = (jurisdictionId, line) => ({
  id: 'estimate-1',
  customer_name: 'Test Customer',
  address: ADDRESSES[jurisdictionId],
  token: 'estimate-token',
  estimate_data: {
    inputs: { svcLawn: true, grassType: 'st_augustine', bermudaSuppression: false },
    engineRequest: { selectedServices: ['LAWN'], options: { grassType: 'st_augustine' } },
    result: { ...(line ? { recurring: { services: [line] } } : {}), results: { lawnMeta: { grassType: 'st_augustine' } } },
  },
});
const ROUNDS_LINE = lawnLine(9, 'every_6_weeks');
const MONTHLY_LINE = lawnLine(12, 'monthly');
const build = ({ line, jurisdictionId = 'manatee_county_fl', now = OCT_26 } = {}) => outline.buildOutline({
  db: makeDb({ jurisdictionId }), estimate: estimateOf(jurisdictionId, line), input: { month: 10 }, now,
});
const section = (result, key) => result.content.sections.find((s) => s.key === key);
const keys = (result) => result.content.sections.map((s) => s.key);

const NEW_KEYS = ['year_bar', 'rounds', 'typical_visit', 'after_visit_timeline', 'after_visit', 'your_watering', 'your_mowing', 'problems', 'products', 'not_included', 'faq'];
const NEW_SECTIONS = ['year_bar', 'rounds', 'after_visit_timeline', 'after_visit', 'your_watering', 'your_mowing', 'problems', 'faq'];
// Rounds 1 to 9 on the default track: what the protocol's own lines make of each round's step (round 2 takes April's 9x bag,
// round 3 February's rounds bag), in the order the lines are written.
const AS_NEEDED = [
  ['disease', 'weeds'], ['weeds'], ['disease', 'insects', 'weeds'], ['disease', 'dry_spots', 'insects', 'weeds'],
  ['disease', 'insects'], ['disease', 'insects'], ['disease', 'insects'], ['disease', 'insects', 'weeds'], ['disease', 'weeds'],
];
const DERIVED_MAIN = [['barrier', 'micros'], ['feeding', 'barrier'], ['feeding'], ['insects'], ['micros', 'barrier'], ['micros'], ['micros'], ['feeding', 'barrier'], ['feeding']];

describe('the gate', () => {
  test('GATE_LAWN_OUTLINE_VISUAL needs GATE_LAWN_OUTLINE_DETAIL and reads strict "true" only', async () => {
    await withGates({ GATE_LAWN_V13: 'true', GATE_LAWN_OUTLINE_V13: 'true', GATE_LAWN_OUTLINE_VISUAL: 'true' }, async () => {
      const result = await build({ line: ROUNDS_LINE });
      expect(section(result, 'year_bar')).toBeUndefined();
      expect(result.meta.contentLibraryVersion).toBe('lawn-v13-copy-1');
    });
    for (const loose of ['1', 'on', 'TRUE']) {
      await withGates({ ...DETAIL, GATE_LAWN_OUTLINE_VISUAL: loose, GATE_LAWN_9X_ROUNDS: 'true' }, async () => {
        const result = await build({ line: ROUNDS_LINE });
        expect(section(result, 'year_bar')).toBeUndefined();
        expect(result.meta.contentLibraryVersion).toBe('lawn-v13-detail-1');
      });
    }
  });

  test('off, the detailed outline is exactly what it was, and the stamp changes only with the gate', async () => {
    await withGates({ ...DETAIL, GATE_LAWN_9X_ROUNDS: 'true' }, async () => {
      const off = await build({ line: ROUNDS_LINE });
      expect(keys(off)).toEqual([
        'lawn_program', 'program_year', 'problems', 'treatment_categories', 'products', 'typical_visit', 'after_treatment',
        'your_watering', 'your_mowing', 'what_to_expect', 'common_questions', 'local_rules', 'safety', 'after_visit', 'not_included',
      ]);
      expect(off.content.property.planLabel).toBeUndefined();
      expect(off.content.season.roundLabel).toBeUndefined();
      expect(off.content.intro).toContain('One program covers every lawn we treat.');
      expect(off.meta.contentLibraryVersion).toBe('lawn-v13-detail-1');
    });
    await withGates(ROUNDS_ON, async () => {
      expect((await build({ line: ROUNDS_LINE })).meta.contentLibraryVersion).toBe('lawn-v13-visual-1');
      expect(outline.contentLibraryVersion()).toBe('lawn-v13-visual-1');
    });
  });
});

describe('a 9-visit rounds estimate', () => {
  test('the approved sections, in order, each with text bullets', async () => {
    await withGates(ROUNDS_ON, async () => {
      const result = await build({ line: ROUNDS_LINE });
      expect(keys(result)).toEqual(NEW_KEYS);
      for (const key of NEW_SECTIONS) expect(section(result, key).bullets.length).toBeGreaterThan(0);
      expect(section(result, 'year_bar').bullets).toHaveLength(10);
      expect(section(result, 'rounds').bullets).toHaveLength(9);
      expect(section(result, 'faq').bullets).toHaveLength(19);
      expect(result.content.sections.every((s) => s.title)).toBe(true);
      expect(result.validation).toEqual({ status: 'passed', errors: [], warnings: [] });
    });
  });

  test('nine blocks, main steps derived from the protocol, the round the visit is in', async () => {
    await withGates(ROUNDS_ON, async () => {
      const bar = section(await build({ line: ROUNDS_LINE }), 'year_bar').visual;
      expect(bar.type).toBe('yearBar');
      expect(bar.anchorPrefix).toBe('round');
      expect(bar.blocks.map((b) => b.main)).toEqual(DERIVED_MAIN);
      expect(bar.blocks.map((b) => b.days)).toEqual([40, 40, 40, 40, 40, 40, 40, 40, 45]);
      expect(bar.blocks.map((b) => b.label)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9']);
      expect(bar.blocks[0].window).toBe('Dec 25 – Feb 2');
      expect(bar.blocks[7].window).toBe('Oct 1 – Nov 9');
      expect(bar.blocks.filter((b) => b.current).map((b) => b.key)).toEqual([8]);
      expect(bar.nowLabel).toBe('You are here: round 8 (Oct 1 – Nov 9). Your visit falls inside it.');
      expect(bar.anchors).toEqual(['Dec 25', 'Jul', 'Dec 24']);
      expect(bar.months).toHaveLength(12);
      expect(bar.months[0]).toEqual({ label: 'J', offset: 7 });
      expect(bar.months[11]).toEqual({ label: 'D', offset: 341 });
      expect(bar.labels.micros).toBe('Micronutrients');
      expect(bar.keySteps).toEqual(['feeding', 'barrier', 'micros', 'insects']);
    });
  });

  test('the round follows `now`, and a leap year makes round 2 one day longer', async () => {
    await withGates(ROUNDS_ON, async () => {
      const jan = section(await build({ line: ROUNDS_LINE, now: new Date('2027-01-05T15:00:00Z') }), 'year_bar').visual;
      expect(jan.blocks.find((b) => b.current).key).toBe(1);
      expect(jan.blocks[0].window).toBe('Dec 25 – Feb 2');
      const leap = section(await build({ line: ROUNDS_LINE, now: new Date('2028-03-01T15:00:00Z') }), 'year_bar').visual;
      expect(leap.blocks.map((b) => b.days)).toEqual([40, 41, 40, 40, 40, 40, 40, 40, 45]);
      expect(leap.blocks.find((b) => b.current).key).toBe(2);
      // 12/25 to 1/1 is 7 days, and Jan 1 to Jun 1 in a leap year is 152 more.
      expect(leap.limit.offset).toBe(159);
    });
  });

  test('the Manatee summer band and caption', async () => {
    await withGates(ROUNDS_ON, async () => {
      const bar = section(await build({ line: ROUNDS_LINE }), 'year_bar').visual;
      expect(bar.limit).toEqual({ offset: 158, days: 122, label: 'No nitrogen or phosphorus (local summer rule)' });
      expect(bar.caption).toBe('Your rule area: Manatee County, FL. No nitrogen or phosphorus from June 1 to September 30; micronutrients keep the color instead.');
    });
  });

  test('round cards: the words, derived steps, one open card, the summer-rules post by rule area', async () => {
    await withGates(ROUNDS_ON, async () => {
      const result = await build({ line: ROUNDS_LINE });
      const { rounds, labels } = section(result, 'rounds').visual;
      expect(section(result, 'rounds').visual.type).toBe('rounds');
      expect(labels.feeding).toBe('Fertilizer');
      expect(rounds.map((r) => r.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
      expect(rounds.map((r) => r.main)).toEqual(DERIVED_MAIN);
      expect(rounds.filter((r) => r.open).map((r) => r.n)).toEqual([8]);
      expect(rounds.filter((r) => r.current).map((r) => r.n)).toEqual([8]);
      expect(rounds[0].title).toBe('Winter weed barrier');
      expect(rounds[0].window).toBe('Dec 25 – Feb 2');
      expect(rounds[0].atHome).toBe('Run your normal watering day: that waters in the weed barrier.');
      expect(rounds[2].extra).toMatch(/^Starting your plan in this round\?/);
      expect(rounds[0].extra).toBeUndefined();
      // As needed: the spot rows of the months the window covers, without the fire ant add-on or the weed mix surfactant (which
      // would put a wetting agent in every weed month). Round 2 reads February's rows in March (the green-up rule).
      expect(rounds.map((r) => [...r.asNeeded].sort())).toEqual(AS_NEEDED);
      for (const card of rounds) expect(card.links.every((l) => l.label && l.url && l.source)).toBe(true);
      expect(rounds[4].links.map((l) => l.url)).toEqual(['https://www.wavespestcontrol.com/lawn-care/fertilizer-blackout-manatee-county/']);
    });
    await withGates(ROUNDS_ON, async () => {
      const sarasota = section(await build({ line: ROUNDS_LINE, jurisdictionId: 'sarasota_county_fl' }), 'rounds').visual.rounds[4].links;
      expect(sarasota.map((l) => l.url)).toEqual(['https://www.wavespestcontrol.com/lawn-care/fertilizer-blackout-sarasota-county/']);
      const charlotte = section(await build({ line: ROUNDS_LINE, jurisdictionId: 'charlotte_county_fl' }), 'rounds').visual.rounds[4].links;
      expect(charlotte).toEqual([]);
    });
  });

  test('the plan line, the intro and the round label', async () => {
    await withGates(ROUNDS_ON, async () => {
      const { content } = await build({ line: ROUNDS_LINE });
      expect(content.property.planLabel).toBe('9 visits a year, one per round');
      expect(content.intro).toContain('Your plan is nine visits a year, one in each round.');
      expect(content.intro).not.toContain('One program covers every lawn we treat.');
      expect(content.season.roundLabel).toBe('Round 8 · Oct 1 – Nov 9');
    });
  });

  test('products: no LESCO 44-0-0 on a rounds plan, and the label sentence', async () => {
    await withGates(ROUNDS_ON, async () => {
      const products = section(await build({ line: ROUNDS_LINE }), 'products');
      expect(JSON.stringify(products)).not.toContain('44-0-0');
      expect(products.visual.items.length).toBeGreaterThan(0);
      expect(products.body).toBe('Each visit uses only what the lawn needs, and every pesticide is applied according to its label. Your service report names every product applied, with its EPA number.');
    });
  });

  test('timeline, fact cards, problems and the questions', async () => {
    await withGates(ROUNDS_ON, async () => {
      const result = await build({ line: ROUNDS_LINE });
      expect(section(result, 'after_visit_timeline').visual.items).toHaveLength(4);
      const afterVisit = section(result, 'after_visit').visual.items;
      expect(afterVisit.map((i) => i.video)).toEqual(['/app-email/videos/waves-lawn-tour.mp4', '/app-email/videos/waves-app-tour.mp4']);
      const watering = section(result, 'your_watering').visual.items;
      expect(watering[0]).toMatchObject({ wide: true, image: '/outline/watering-email-sample-thumb.jpg', href: '/outline/watering-email-sample.jpg', linkLabel: 'See a sample email' });
      expect(watering[1]).toMatchObject({ title: 'Your watering day', until: '2027-03-31' });
      const mowing = section(result, 'your_mowing');
      expect(mowing.body).toBe('We do not mow. If a crew mows for you, pass these along.');
      expect(mowing.visual.items).toHaveLength(4);
      expect(mowing.visual.items[0].big).toBe('3.5 to 4 in');
      expect(mowing.visual.items[3].href).toBe('https://www.wavespestcontrol.com/lawn-care/note-for-your-mowing-crew/');
      expect(section(result, 'problems').visual).toMatchObject({ type: 'faq', more: [] });
      expect(section(result, 'problems').visual.items).toHaveLength(9);
      const faq = section(result, 'faq').visual;
      expect(faq.items).toHaveLength(12);
      expect(faq.more).toHaveLength(7);
      expect(faq.items[0].a).toMatch(/^Nine times a year/);
      expect(faq.items[6].a).toContain('In round 4, the sunny turf');
      expect(faq.more.map((m) => m.q)).toEqual(expect.arrayContaining(['Why did a visit look like nothing happened?', 'Can every spot be fixed?']));
    });
  });

  test('without GATE_LAWN_9X_ROUNDS the same estimate seeds as 42-day visits: the month view, no plan line', async () => {
    await withGates(VISUAL, async () => {
      const result = await build({ line: ROUNDS_LINE });
      expect(section(result, 'year_bar').visual.blocks).toHaveLength(12);
      expect(section(result, 'rounds')).toBeUndefined();
      expect(result.content.property.planLabel).toBeUndefined();
    });
  });
});

describe('a 12-visit estimate', () => {
  test('twelve blocks, today\'s month list, a plan line, the month wording', async () => {
    await withGates(ROUNDS_ON, async () => {
      const result = await build({ line: MONTHLY_LINE });
      expect(keys(result)).toEqual(['year_bar', 'program_year', ...NEW_KEYS.slice(2)]);
      const bar = section(result, 'year_bar').visual;
      expect(bar.anchorPrefix).toBe('month');
      expect(bar.blocks).toHaveLength(12);
      expect(bar.blocks.map((b) => b.label)).toEqual(['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
      expect(bar.blocks.map((b) => b.days)).toEqual([31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]);
      expect(bar.blocks.filter((b) => b.current).map((b) => b.label)).toEqual(['Oct']);
      expect(bar.months).toEqual([]);
      expect(bar.anchors).toEqual(['Jan', 'Jul', 'Dec']);
      expect(bar.nowLabel).toBe('You are here: October.');
      expect(bar.limit).toEqual({ offset: 151, days: 122, label: 'No nitrogen or phosphorus (local summer rule)' });
      expect(bar.blocks[3].main).toEqual(['feeding']);
      expect(section(result, 'program_year').visual.type).toBe('months');
      expect(result.content.property.planLabel).toBe('12 visits a year, one a month');
      expect(result.content.intro).toContain('One program covers every lawn we treat.');
      expect(result.content.season.roundLabel).toBeUndefined();
      const faq = section(result, 'faq').visual;
      expect(faq.items[0].a).toMatch(/^Once a month\./);
      expect(faq.items[6].a).toContain('In May, the sunny turf');
      expect(JSON.stringify(section(result, 'products'))).toContain('44-0-0');
      for (const key of ['year_bar', 'program_year', 'faq']) expect(section(result, key).bullets.length).toBeGreaterThan(0);
      expect(result.validation).toEqual({ status: 'passed', errors: [], warnings: [] });
    });
  });
});

describe('an estimate whose plan is not known', () => {
  test('the month view and no plan line', async () => {
    await withGates(ROUNDS_ON, async () => {
      for (const line of [undefined, lawnLine(6, 'bimonthly'), { service: 'lawn_care', name: 'Lawn Care' }]) {
        const result = await build({ line });
        expect(section(result, 'year_bar').visual.blocks).toHaveLength(12);
        expect(section(result, 'program_year').visual.type).toBe('months');
        expect(result.content.property.planLabel).toBeUndefined();
        expect(result.validation.status).toBe('passed');
      }
    });
  });
});

describe('a failed plan read', () => {
  test('draws the month view, names no plan and logs a warning', async () => {
    const converter = require('../services/estimate-converter');
    const logger = require('../services/logger');
    const read = jest.spyOn(converter, 'recurringServicesFromEstimateData').mockImplementation(() => { throw new Error('unreadable'); });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      await withGates(ROUNDS_ON, async () => {
        const result = await build({ line: ROUNDS_LINE });
        expect(section(result, 'year_bar').visual.blocks).toHaveLength(12);
        expect(result.content.property.planLabel).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('lawn plan unreadable'));
      });
    } finally {
      read.mockRestore();
      warn.mockRestore();
    }
  });
});

describe('every word passes the customer-copy checks', () => {
  const strings = (value, out = []) => {
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((v) => strings(v, out));
    else if (value && typeof value === 'object') Object.entries(value).forEach(([k, v]) => { if (!['url', 'href', 'image', 'video', 'icon', 'key', 'source', 'until', 'type', 'anchorPrefix', 'imageAlt'].includes(k)) strings(v, out); });
    return out;
  };

  test('rounds and monthly outlines, every rule area', async () => {
    await withGates(ROUNDS_ON, async () => {
      for (const jurisdictionId of Object.keys(RULES)) {
        for (const line of [ROUNDS_LINE, MONTHLY_LINE]) {
          const result = await build({ line, jurisdictionId });
          expect(result.validation).toEqual({ status: 'passed', errors: [], warnings: [] });
          for (const text of strings(result.content.sections)) {
            expect(findBannedCustomerCopy(text)).toEqual([]);
            expect(validateCustomerCopy(text)).toBe(true);
          }
        }
      }
    });
  });
});
