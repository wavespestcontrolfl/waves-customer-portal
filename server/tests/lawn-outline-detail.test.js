// The detailed lawn service outline, behind GATE_LAWN_OUTLINE_DETAIL (owner 2026-10-26: "this needs to be more
// detailed, and we should be using the protocols, and youtube transcripts to further develop it"; the decision
// page's choices D1-B, D2-A, "do whatever you recommend"). Synthetic inputs: no database.
//
// Pins: the gate needs GATE_LAWN_OUTLINE_V13 and is strict; off = the v13 outline exactly; on = the month list (the
// report's own month text, one thing to do at home, the build month and the next two open) in place of the Service
// Focus box, the detail sections in order, the corrected chinch bug tile, the product list from the v13 track with
// the catalog's active ingredient and never a rate, the watering-order tile only for Manatee and Sarasota and only
// until the order ends, and every word passing the customer-copy checks.

const outline = require('../services/lawn-service-outline');
const { PROGRAM_DETAIL_V13 } = require('../services/service-report/lawn-program-line');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const GATE_NAMES = ['GATE_LAWN_V13', 'GATE_LAWN_OUTLINE_V13', 'GATE_LAWN_OUTLINE_DETAIL', 'GATE_LAWN_BERMUDA_REMOVAL'];
const V13 = { GATE_LAWN_V13: 'true', GATE_LAWN_OUTLINE_V13: 'true' };
const DETAIL = { ...V13, GATE_LAWN_OUTLINE_DETAIL: 'true' };
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
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

// Catalog rows as production stores them for a few v13 products (product facts only).
const CATALOG = [
  { name: 'Celsius WG', display_name: null, active_ingredient: 'Thiencarbazone + Iodosulfuron + Dicamba', category: 'herbicide', product_type: 'pesticide' },
  { name: 'Arena 50 WDG', display_name: null, active_ingredient: 'Clothianidin 50%', category: 'insecticide', product_type: 'pesticide' },
  { name: 'Acelepryn Insecticide', display_name: null, active_ingredient: '18.4% Chlorantraniliprole', category: 'insecticide', product_type: null },
  { name: 'Artavia 2 SC (Azoxy)', display_name: null, active_ingredient: 'Azoxystrobin', category: 'fungicide', product_type: null },
  { name: 'LESCO 24-0-11 with PolyPlus OPTI', display_name: 'LESCO 24-0-11', active_ingredient: '24-0-11', category: 'fertilizer', product_type: null },
  { name: 'LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer', display_name: null, active_ingredient: 'dithiopyr 0.21% + 18-0-10', category: 'herbicide', product_type: 'pesticide' },
  { name: 'LESCO 90/10 Nonionic Surfactant', display_name: null, active_ingredient: 'Nonionic surfactant', category: 'adjuvant', product_type: null },
  { name: 'Topchoice Granular Insecticide', display_name: null, active_ingredient: 'Fipronil 0.0143%', category: 'insecticide', product_type: 'pesticide' },
];

function makeDb({ jurisdictionId = 'sarasota_county_fl', catalog = CATALOG, catalogFails = false } = {}) {
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
    const rows = table === 'products_catalog' ? catalog : [];
    const chain = {
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      orWhere: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      select: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      first: jest.fn(() => Promise.resolve(table === 'jurisdiction_fertilizer_rules' ? rule : null)),
      then: (resolve, reject) => (table === 'products_catalog' && catalogFails
        ? Promise.reject(new Error('catalog read failed'))
        : Promise.resolve(rows)).then(resolve, reject),
    };
    return chain;
  });
  db.fn = { now: jest.fn(() => OCT_26) };
  return db;
}

const ADDRESSES = {
  sarasota_county_fl: '100 Test Way, Sarasota, FL 34240',
  manatee_county_fl: '100 Test Way, Bradenton, FL 34202',
  charlotte_county_fl: '100 Test Way, Port Charlotte, FL 33948',
};
const formLawn = (grassType) => ({
  inputs: { svcLawn: true, grassType, bermudaSuppression: false },
  engineRequest: { selectedServices: ['LAWN'], options: { grassType } },
  result: { results: { lawnMeta: { grassType } } },
});
const estimate = (grass = 'st_augustine', jurisdictionId = 'sarasota_county_fl') => ({
  id: 'estimate-1',
  customer_name: 'Test Customer',
  address: ADDRESSES[jurisdictionId],
  token: 'estimate-token',
  estimate_data: formLawn(grass),
});
const build = ({ grass, jurisdictionId, month = 10, now = OCT_26, ...db } = {}) => outline.buildOutline({
  db: makeDb({ jurisdictionId, ...db }), estimate: estimate(grass, jurisdictionId), input: { month }, now,
});
const section = (result, key) => result.content.sections.find((s) => s.key === key);
const tileTitles = (result, key) => section(result, key).visual.items.map((item) => item.title);

describe('the gate', () => {
  test('GATE_LAWN_OUTLINE_DETAIL needs GATE_LAWN_OUTLINE_V13 and reads strict "true" only', async () => {
    await withGates({ GATE_LAWN_V13: 'true', GATE_LAWN_OUTLINE_DETAIL: 'true' }, async () => {
      const result = await build();
      expect(section(result, 'problems')).toBeUndefined();
      expect(result.meta.contentLibraryVersion).toBe('seed-v1');
    });
    for (const loose of ['1', 'on', 'TRUE']) {
      await withGates({ ...V13, GATE_LAWN_OUTLINE_DETAIL: loose }, async () => {
        expect(section(await build(), 'problems')).toBeUndefined();
      });
    }
  });

  test('off: the v13 outline exactly, unset and "false" alike', async () => {
    const unset = await withGates(V13, () => build());
    const off = await withGates({ ...V13, GATE_LAWN_OUTLINE_DETAIL: 'false' }, () => build());
    expect(JSON.stringify(off.content)).toBe(JSON.stringify(unset.content));
    expect(unset.content.sections.map((s) => s.key)).toEqual([
      'lawn_program', 'season_focus', 'program_year', 'treatment_categories', 'typical_visit',
      'local_rules', 'safety', 'after_visit', 'not_included',
    ]);
    expect(unset.meta.contentLibraryVersion).toBe('lawn-v13-copy-2');
  });

  test('on: its own content version, so outlines built before the flip show as updated', async () => {
    await withGates(DETAIL, async () => {
      expect(outline.contentLibraryVersion()).toBe('lawn-v13-detail-2');
      expect((await build()).meta.contentLibraryVersion).toBe('lawn-v13-detail-2');
    });
    await withGates(V13, async () => expect(outline.contentLibraryVersion()).toBe('lawn-v13-copy-2'));
  });
});

describe('the detailed outline', () => {
  test('sections, in order: the month list replaces the Service Focus box', async () => {
    await withGates(DETAIL, async () => {
      const result = await build();
      expect(result.content.sections.map((s) => s.key)).toEqual([
        'lawn_program', 'program_year', 'problems', 'treatment_categories', 'products', 'typical_visit',
        'after_treatment', 'your_watering', 'your_mowing', 'what_to_expect', 'common_questions',
        'local_rules', 'safety', 'after_visit', 'not_included',
      ]);
      expect(result.validation).toEqual({ status: 'passed', errors: [], warnings: [] });
    });
  });

  test('the chinch bug tile says confirmed before any spot treatment (May has one pass with no count)', async () => {
    await withGates(DETAIL, async () => {
      const program = section(await build(), 'lawn_program');
      expect(program.visual.items.map((t) => t.title)).toEqual([
        'One whole-lawn pass per visit', 'Spot work, not blanket spraying', 'Confirmed before treating', 'Resistance management',
      ]);
      expect(program.bullets).toContain('Confirmed before treating: Chinch bugs and other insects are confirmed where the damage starts before any spot treatment');
    });
  });

  test.each(MONTHS)('month %i: the month list carries the report\'s own text and opens this month and the next two', async (month) => {
    await withGates(DETAIL, async () => {
      const result = await build({ month });
      const year = section(result, 'program_year');
      const { visual } = year;
      expect(visual.type).toBe('months');
      expect(visual.months).toHaveLength(12);
      for (const m of visual.months) {
        expect(m.visit).toBe(PROGRAM_DETAIL_V13[m.month].whyNow);
        expect(m.atHome).toEqual(expect.any(String));
        expect(m.atHome.length).toBeGreaterThan(20);
      }
      const open = visual.months.filter((m) => m.open).map((m) => m.month);
      expect(open.sort((a, b) => a - b)).toEqual([month, (month % 12) + 1, ((month + 1) % 12) + 1].sort((a, b) => a - b));
      expect(year.bullets).toHaveLength(12);
      expect(year.bullets.every((line) => line.includes(' At home: '))).toBe(true);
      // A 9-visit plan skips some months: the list never says every month has a visit.
      expect(year.body).toMatch(/^Each visit follows the step for the month it falls in\./);
      expect(year.body).not.toMatch(/what that visit does/);
    });
  });

  test('the month list draws the same steps and summer limits as the v13 year chart', async () => {
    const chart = section(await withGates(V13, () => build()), 'program_year').visual;
    const list = section(await withGates(DETAIL, () => build()), 'program_year').visual;
    expect(list.months.map(({ month, label, main, asNeeded, limited }) => ({ month, label, main, asNeeded, limited }))).toEqual(chart.months);
    expect(list.labels).toEqual(chart.labels);
    expect(list.limitLabel).toBe(chart.limitLabel);
  });
});

describe('Products We May Use (decision D1-B)', () => {
  test('names from the v13 track with the catalog\'s active ingredient, never a rate, an add-on or the surfactant', async () => {
    await withGates(DETAIL, async () => {
      const products = section(await build(), 'products');
      const text = JSON.stringify(products);
      expect(products.visual.type).toBe('categories');
      const weeds = products.visual.items.find((item) => item.key === 'weeds');
      expect(weeds.text).toContain('Celsius WG (thiencarbazone + iodosulfuron + dicamba)');
      const insects = products.visual.items.find((item) => item.key === 'insects');
      expect(insects.text).toContain('Arena 50 WDG (clothianidin)');
      expect(insects.text).toContain('Acelepryn Insecticide (chlorantraniliprole)');
      expect(products.visual.items.find((item) => item.key === 'disease').text).toContain('Artavia 2 SC (azoxystrobin)');
      const barrier = products.visual.items.find((item) => item.key === 'barrier');
      expect(barrier.text).toContain('LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer (dithiopyr)');
      const feeding = products.visual.items.find((item) => item.key === 'feeding');
      expect(feeding.text).toContain('LESCO 24-0-11');
      expect(feeding.text).not.toContain('(');
      expect(text).not.toMatch(/Topchoice|Nonionic Surfactant|per 1,000|\bfl oz\b|\boz\b|\blb\b|sq ft|\$/);
      expect(products.visual.items.map((item) => item.key)).not.toContain('inspection');
      expect(products.visual.items.map((item) => item.key)).not.toContain('report');
    });
  });

  test('a product the catalog does not list still shows by its v13 name; a failed catalog read leaves the section out', async () => {
    await withGates(DETAIL, async () => {
      const bare = section(await build({ catalog: [] }), 'products');
      expect(bare.visual.items.find((item) => item.key === 'weeds').text).toContain('Celsius WG');
      expect(JSON.stringify(bare)).not.toMatch(/Topchoice|Nonionic Surfactant/);
      const failed = await build({ catalogFails: true });
      expect(section(failed, 'products')).toBeUndefined();
      expect(failed.validation.status).toBe('passed');
    });
  });
});

describe('the watering order tile (decision D2-A)', () => {
  test.each(['sarasota_county_fl', 'manatee_county_fl'])('%s: shown second, carrying the day it ends', async (jurisdictionId) => {
    await withGates(DETAIL, async () => {
      const watering = section(await build({ jurisdictionId }), 'your_watering');
      expect(watering.visual.items[1]).toEqual(expect.objectContaining({ title: 'Your watering day', until: '2027-03-31' }));
      expect(watering.visual.items[1].text).toMatch(/^Manatee and Sarasota are under a one-day-a-week order through March 31, 2027\./);
    });
  });

  test('not shown in Charlotte, or once the order has ended', async () => {
    await withGates(DETAIL, async () => {
      expect(tileTitles(await build({ jurisdictionId: 'charlotte_county_fl' }), 'your_watering')).not.toContain('Your watering day');
      expect(tileTitles(await build({ now: new Date('2027-04-01T12:00:00Z') }), 'your_watering')).not.toContain('Your watering day');
      expect(tileTitles(await build({ now: new Date('2027-03-31T23:00:00Z') }), 'your_watering')).toContain('Your watering day');
    });
  });

  test('"When to water" is the report\'s approved sentence', async () => {
    const { deficitAdvice } = require('../../shared/watering-copy.json');
    await withGates(DETAIL, async () => {
      const first = section(await build(), 'your_watering').visual.items[0];
      expect(first.text.startsWith(deficitAdvice)).toBe(true);
    });
  });
});

describe('every word passes the customer-copy checks', () => {
  test('every grass the program covers, every month', async () => {
    await withGates(DETAIL, async () => {
      for (const grass of ['st_augustine', 'bermuda', 'zoysia', 'mixed', 'unknown']) {
        for (const month of MONTHS) {
          const result = await build({ grass, month });
          expect(result.validation).toEqual({ status: 'passed', errors: [], warnings: [] });
          const drawnTexts = (v) => [
            v?.note, v?.limitLabel, ...Object.values(v?.labels || {}),
            ...(v?.items || []).flatMap((i) => (typeof i === 'string' ? [i] : [i.title, i.text, i.label])),
            ...(v?.months || []).flatMap((m) => [m.name, m.visit, m.atHome]),
          ];
          const texts = result.content.sections.flatMap((s) => [s.title, s.body, ...s.bullets, ...drawnTexts(s.visual)]).filter(Boolean);
          for (const text of texts) {
            expect(findBannedCustomerCopy(text)).toEqual([]);
            expect(validateCustomerCopy(text)).toBe(true);
          }
        }
      }
    });
  });
});
