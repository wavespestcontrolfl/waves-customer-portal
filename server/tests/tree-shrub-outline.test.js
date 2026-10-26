// The Tree & Shrub service outline, behind GATE_TS_OUTLINE (owner 2026-10-26: "also we need to go through other
// related outlines, etc and make sure they are more aligned like lawn outline"; decision D4-A, "do whatever you
// recommend"). Synthetic inputs: no database.
//
// Pins: the gate is strict; the month list's steps come from the protocol's month cards (a protocol edit shows here);
// the build month and the next two open; the summer-limit months follow the rule; every listed product is still in
// the protocol, with no rate, price or supplier code; the watering-order tile only for Manatee and Sarasota and only
// until the order ends; the packet says it is Tree & Shrub; and every word passes the customer-copy checks.

const featureGates = require('../config/feature-gates');
const PROTOCOLS = require('../config/protocols.json');
const ts = require('../services/tree-shrub-service-outline');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const OCT_26 = new Date('2026-10-26T12:00:00Z');
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const RULE_NAMES = { sarasota_county_fl: 'Sarasota County, FL', manatee_county_fl: 'Manatee County, FL', charlotte_county_fl: 'Charlotte County, FL' };
const ADDRESSES = { sarasota_county_fl: '1 Palm Way, Sarasota, FL', manatee_county_fl: '1 Palm Way, Bradenton, FL', charlotte_county_fl: '1 Palm Way, Punta Gorda, FL' };

function makeDb(jurisdictionId) {
  const rule = {
    jurisdiction_id: jurisdictionId,
    jurisdiction_name: RULE_NAMES[jurisdictionId],
    version: '2026-05-30',
    public_summary: 'Local fertilizer rules may restrict nitrogen and phosphorus applications during the summer rainy season.',
    restricted_start_month: 6,
    restricted_start_day: 1,
    restricted_end_month: 9,
    restricted_end_day: 30,
  };
  return jest.fn(() => {
    const chain = {
      where: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      first: jest.fn(() => Promise.resolve(rule)),
    };
    return chain;
  });
}

function build({ jurisdictionId = 'sarasota_county_fl', month, now = OCT_26, estimateData = { inputs: { svcTs: true, tsTier: 'standard' } } } = {}) {
  return ts.buildTreeShrubOutline({
    db: makeDb(jurisdictionId),
    estimate: { id: 'est-1', customer_name: 'Pat Doe', address: ADDRESSES[jurisdictionId], token: 'tok-1', estimate_data: estimateData },
    input: month ? { month } : {},
    now,
  });
}

const section = (result, key) => result.content.sections.find((s) => s.key === key);

describe('GATE_TS_OUTLINE', () => {
  const saved = process.env.GATE_TS_OUTLINE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_TS_OUTLINE; else process.env.GATE_TS_OUTLINE = saved;
  });

  test('is on only for exactly "true"', () => {
    for (const [value, live] of [[undefined, false], ['false', false], ['1', false], ['TRUE', false], ['true', true]]) {
      if (value === undefined) delete process.env.GATE_TS_OUTLINE; else process.env.GATE_TS_OUTLINE = value;
      expect(featureGates.tsOutlineLive()).toBe(live);
      expect(ts.treeShrubOutlineLive()).toBe(live);
    }
  });
});

describe('the Tree & Shrub packet', () => {
  test('sections in order, stamped Tree & Shrub, validation passed', async () => {
    const result = await build();
    expect(result.content.sections.map((s) => s.key)).toEqual([
      'tree_shrub_program', 'program_year', 'problems', 'treatment_categories', 'products', 'typical_visit', 'after_treatment',
      'your_part', 'what_to_expect', 'palm_injections', 'local_rules', 'safety', 'after_visit', 'not_included',
    ]);
    expect(result.validation).toEqual({ status: 'passed', errors: [], warnings: [] });
    expect(result.content.serviceLine).toBe('tree_shrub');
    expect(result.content.title).toBe('Your Waves Tree & Shrub Program Overview');
    expect(result.content.property).toEqual(expect.objectContaining({ turfType: null, programLabel: 'One program for every landscape' }));
    expect(result.meta).toEqual(expect.objectContaining({
      serviceLine: 'tree_shrub',
      contentLibraryVersion: 'ts-v1-copy-1',
      protocolVersion: PROTOCOLS.tree_shrub.version,
    }));
    expect(result.inputSnapshot.serviceLine).toBe('tree_shrub');
    expect(result.summary.serviceLineDetected).toBe(true);
    const lawnOnly = await build({ estimateData: { inputs: { svcLawn: true } } });
    expect(lawnOnly.summary.serviceLineDetected).toBe(false);
  });

  test('every section keeps text bullets for readers that draw none', async () => {
    const result = await build();
    for (const s of result.content.sections) {
      expect(s.bullets.length).toBeGreaterThan(0);
    }
  });
});

describe('the month list', () => {
  test('each month’s steps come from its protocol card', () => {
    // A protocol edit that changes a month's steps shows up here first.
    const expected = {
      Jan: [['barrier', 'feeding'], ['insects', 'micros']],
      Feb: [['barrier', 'feeding'], ['insects', 'micros']],
      Mar: [['barrier', 'feeding'], ['insects', 'disease']],
      Apr: [['barrier', 'feeding'], ['insects']],
      May: [['barrier', 'feeding'], ['insects', 'micros']],
      Jun: [['barrier', 'feeding'], ['insects', 'micros', 'disease']],
      Jul: [['inspection', 'barrier', 'feeding'], ['insects']],
      Aug: [['barrier', 'feeding'], ['insects']],
      Sep: [['barrier', 'feeding'], ['insects', 'micros']],
      Oct: [['barrier', 'feeding'], ['insects', 'disease']],
      Nov: [['barrier', 'feeding'], ['insects', 'micros']],
      Dec: [['barrier', 'feeding'], ['insects', 'micros']],
    };
    for (const visit of PROTOCOLS.tree_shrub.visits) {
      const [main, asNeeded] = expected[visit.month];
      expect({ month: visit.month, ...ts.monthSteps(visit) }).toEqual({ month: visit.month, main, asNeeded });
    }
  });

  test('root stimulants, the hedge growth regulator, injections and the year report are not steps', () => {
    const steps = ts.monthSteps({
      primary: 'NutriRoot: label rate where site supports root nutrition\nAnnual health report with photos',
      secondary: 'Shortstop PGR add-on only on healthy established hedges\nMn-Jet Fe add-on for diagnosed palm Mn/Fe\nPropizol only for labeled diagnosed tree disease\nCytogro: label rate',
    });
    expect(steps).toEqual({ main: [], asNeeded: [] });
  });

  test('the build month and the next two open, across the new year; the summer months carry the limit', async () => {
    for (const [month, open] of [[10, [10, 11, 12]], [11, [11, 12, 1]], [12, [12, 1, 2]], [1, [1, 2, 3]]]) {
      const visual = section(await build({ month }), 'program_year').visual;
      expect(visual.type).toBe('months');
      expect(visual.months.filter((m) => m.open).map((m) => m.month).sort((a, b) => a - b)).toEqual([...open].sort((a, b) => a - b));
      expect(visual.months.filter((m) => m.limited).map((m) => m.month)).toEqual([6, 7, 8, 9]);
      expect(visual.limitLabel).toBe('Local summer limits on nitrogen and phosphorus');
      for (const m of visual.months) {
        expect(m.visit).toBeTruthy();
        expect(m.atHome).toBeTruthy();
        for (const step of [...m.main, ...m.asNeeded]) expect(visual.labels[step]).toBeTruthy();
      }
    }
  });

  test('the year body says each visit follows its month, never that every month has a visit', async () => {
    const year = section(await build(), 'program_year');
    expect(year.body).toMatch(/^Each visit does the work of the month it falls in\./);
    expect(year.body).not.toMatch(/what that visit does/);
  });
});

describe('the product list', () => {
  test('every product is still in the protocol', () => {
    const protocolText = JSON.stringify(PROTOCOLS.tree_shrub);
    for (const product of ts.TS_PRODUCTS) {
      expect({ product: product.text, inProtocol: product.match.test(protocolText) }).toEqual({ product: product.text, inProtocol: true });
    }
  });

  test('names with an active ingredient, no rate, price or supplier code, and no product the protocol never names', async () => {
    const products = section(await build(), 'products');
    expect(products.visual.items.map((item) => item.key)).toEqual(['barrier', 'feeding', 'micros', 'insects', 'disease']);
    const text = products.bullets.join(' ');
    expect(text).not.toMatch(/\d\s*(fl\s*)?oz\b|\d\s*lb\b|\/\s*1,?000|\$|#\d|gal\b/i);
    expect(text).not.toMatch(/dominion|organic/i);
    expect(text).toMatch(/Snapshot 2\.5TG \(trifluralin \+ isoxaben\)/);
  });
});

describe('the watering-order tile', () => {
  test('Manatee and Sarasota only, and only through March 31, 2027', async () => {
    const titles = async (jurisdictionId, now) => section(await build({ jurisdictionId, now }), 'your_part').visual.items.map((tile) => tile.title);
    for (const jurisdictionId of ['sarasota_county_fl', 'manatee_county_fl']) {
      const tiles = section(await build({ jurisdictionId }), 'your_part').visual.items;
      expect(tiles.find((tile) => tile.title === 'Your watering day')).toEqual(expect.objectContaining({ until: '2027-03-31' }));
      expect(await titles(jurisdictionId, new Date('2027-04-01T16:00:00Z'))).not.toContain('Your watering day');
    }
    expect(await titles('charlotte_county_fl', OCT_26)).not.toContain('Your watering day');
  });
});

describe('every word passes the customer-copy checks', () => {
  test('every rule area, every month', async () => {
    for (const jurisdictionId of Object.keys(RULE_NAMES)) {
      for (const month of MONTHS) {
        const result = await build({ jurisdictionId, month });
        expect(result.validation.status).toBe('passed');
        const drawnTexts = (v) => [
          v?.note, v?.limitLabel, ...Object.values(v?.labels || {}),
          ...(v?.items || []).flatMap((i) => (typeof i === 'string' ? [i] : [i.title, i.text, i.label])),
          ...(v?.months || []).flatMap((m) => [m.name, m.visit, m.atHome]),
        ];
        const texts = [result.content.title, result.content.intro, ...result.content.sections.flatMap((s) => [s.title, s.body, ...s.bullets, ...drawnTexts(s.visual)])].filter(Boolean);
        for (const text of texts) {
          expect(findBannedCustomerCopy(text)).toEqual([]);
          expect(validateCustomerCopy(text)).toBe(true);
          // No visit count, price or promised year report: the estimate and the agreement carry those.
          expect(text).not.toMatch(/\b(4|6|9|12|four|six|nine|twelve) visits\b|\$\d|year(ly)? report/i);
        }
      }
    }
  });

  test('two cards may share an icon, but no two share a label', async () => {
    const result = await build();
    for (const s of result.content.sections.filter((x) => x.visual?.type === 'categories')) {
      const labels = s.visual.items.map((item) => item.label);
      expect(new Set(labels).size).toBe(labels.length);
    }
  });
});
