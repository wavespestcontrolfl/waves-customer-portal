// The Pest Control service outline, behind GATE_PEST_OUTLINE (owner 2026-10-26: "also we need to go through other
// related outlines, etc and make sure they are more aligned like lawn outline"; decision D4-A, "do whatever you
// recommend"). Synthetic inputs: no database.
//
// Pins: the gate is strict; the year is four seasons and the build month's season opens; the plan's opt-outs take their
// promises off the page (an exterior-only plan never reads an inside promise; no sweep, no web line); the products are
// the catalog's rows with their active ingredient, the dinotefuran row inside only; the owner's rulings hold (inside on
// the first visit then on request, rain speaks to effectiveness only, no terms, no timing, no band width, no "kill");
// and every word passes the customer-copy checks.

const featureGates = require('../config/feature-gates');
const PROTOCOLS = require('../config/protocols.json');
const pest = require('../services/pest-service-outline');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const OCT_26 = new Date('2026-10-26T14:00:00Z');
const RULE = {
  jurisdiction_id: 'sarasota_county_fl',
  jurisdiction_name: 'Sarasota County, FL',
  version: '2026-05-30',
  public_summary: 'Local fertilizer rules may restrict nitrogen and phosphorus applications during the summer rainy season.',
  restricted_start_month: 6,
  restricted_end_month: 9,
};
// Catalog rows as production stores them (product facts only).
const CATALOG = [
  { name: 'Taurus SC', display_name: null, active_ingredient: 'Fipronil', category: 'termiticide / insecticide', product_type: null },
  { name: 'Atticus Talak 7.9 F', display_name: null, active_ingredient: 'Bifenthrin 7.9%', category: 'insecticide', product_type: 'pesticide' },
  { name: 'Alpine WSG', display_name: null, active_ingredient: 'Dinotefuran 40.0%', category: 'insecticide', product_type: 'pesticide' },
  { name: 'Advion Ant Bait Gel', display_name: null, active_ingredient: 'Indoxacarb', category: 'insecticide', product_type: null },
];

function makeDb({ catalog = CATALOG, catalogFails = false } = {}) {
  return jest.fn((table) => {
    const chain = {
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      select: jest.fn(() => chain),
      first: jest.fn(() => Promise.resolve(table === 'jurisdiction_fertilizer_rules' ? RULE : null)),
      then: (resolve, reject) => (table === 'products_catalog' && catalogFails
        ? Promise.reject(new Error('catalog read failed'))
        : Promise.resolve(table === 'products_catalog' ? catalog : [])).then(resolve, reject),
    };
    return chain;
  });
}

function build({ preferences, month, catalog, catalogFails, monthlyTotal = '45.00' } = {}) {
  return pest.buildPestOutline({
    db: makeDb({ catalog, catalogFails }),
    estimate: {
      id: 'est-1',
      customer_name: 'Pat Doe',
      address: '1 Palm Way, Sarasota, FL',
      token: 'tok-1',
      monthly_total: monthlyTotal,
      service_interest: 'Pest Control',
      estimate_data: { preferences },
    },
    input: month ? { month } : {},
    now: OCT_26,
  });
}

const section = (result, key) => result.content.sections.find((s) => s.key === key);
const allText = (result) => {
  const drawn = (v) => [
    v?.note, v?.limitLabel, ...Object.values(v?.labels || {}),
    ...(v?.items || []).flatMap((i) => (typeof i === 'string' ? [i] : [i.title, i.text, i.label])),
    ...(v?.months || []).flatMap((m) => [m.label, m.name, m.visit, m.atHome]),
  ];
  return [result.content.title, result.content.intro, ...result.content.sections.flatMap((s) => [s.title, s.body, ...s.bullets, ...drawn(s.visual)])].filter(Boolean);
};
const PLANS = {
  full: undefined,
  exteriorOnly: { interior_spray: false },
  noSweep: { exterior_sweep: false },
  neither: { interior_spray: false, exterior_sweep: false },
};

describe('GATE_PEST_OUTLINE', () => {
  const saved = process.env.GATE_PEST_OUTLINE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_PEST_OUTLINE; else process.env.GATE_PEST_OUTLINE = saved;
  });

  test('is on only for exactly "true"', () => {
    for (const [value, live] of [[undefined, false], ['false', false], ['1', false], ['TRUE', false], ['true', true]]) {
      if (value === undefined) delete process.env.GATE_PEST_OUTLINE; else process.env.GATE_PEST_OUTLINE = value;
      expect(featureGates.pestOutlineLive()).toBe(live);
      expect(pest.pestOutlineLive()).toBe(live);
    }
  });
});

describe('the Pest Control packet', () => {
  test('sections in order, stamped Pest Control, validation passed', async () => {
    const result = await build();
    expect(result.content.sections.map((s) => s.key)).toEqual([
      'pest_program', 'program_year', 'problems', 'treatment_categories', 'products', 'typical_visit',
      'after_treatment', 'your_part', 'what_to_expect', 'safety', 'after_visit', 'not_included',
    ]);
    expect(result.validation).toEqual({ status: 'passed', errors: [], warnings: [] });
    expect(result.content.serviceLine).toBe('pest_control');
    expect(result.content.title).toBe('Your Waves Pest Control Program Overview');
    expect(result.meta).toEqual(expect.objectContaining({
      serviceLine: 'pest_control',
      contentLibraryVersion: 'pest-v1-copy-1',
      protocolVersion: PROTOCOLS.pest.version ?? null,
    }));
    expect(result.inputSnapshot).toEqual(expect.objectContaining({ serviceLine: 'pest_control', planScope: { interior: true, sweep: true } }));
  });

  test('a recurring plan is a pest plan; a one-time pest job (no monthly total) is not', async () => {
    expect((await build()).summary.serviceLineDetected).toBe(true);
    expect((await build({ monthlyTotal: '0' })).summary.serviceLineDetected).toBe(false);
  });
});

describe('the year as four seasons', () => {
  test.each([[1, 'Winter'], [3, 'Winter'], [4, 'Spring'], [7, 'Summer'], [10, 'Fall'], [12, 'Fall']])('month %i opens %s', async (month, open) => {
    const year = section(await build({ month }), 'program_year');
    expect(year.visual).toEqual(expect.objectContaining({ type: 'months', labels: {}, limitLabel: null }));
    expect(year.visual.months.map((m) => m.label)).toEqual(['Winter', 'Spring', 'Summer', 'Fall']);
    expect(year.visual.months.filter((m) => m.open).map((m) => m.label)).toEqual([open]);
    for (const m of year.visual.months) {
      expect(m.main).toEqual([]);
      expect(m.asNeeded).toEqual([]);
      expect(m.visit).toEqual(expect.any(String));
      expect(m.atHome.length).toBeGreaterThan(40);
    }
    expect(year.bullets).toHaveLength(4);
  });
});

describe('the plan’s opt-outs', () => {
  test('a full plan promises the first-visit inside spray, then inside on request', async () => {
    const result = await build();
    const program = section(result, 'pest_program').visual.items;
    expect(program[0].text).toMatch(/^Your first visit treats the outside and the inside\. After that, the inside is yours to ask for/);
    expect(section(result, 'treatment_categories').visual.items.map((i) => i.label)).toEqual(['Web and nest sweep', 'Outside band', 'Inside', 'Bait', 'Monitors and notes']);
  });

  test('an exterior-only plan reads no inside promise anywhere and no inside product', async () => {
    const result = await build({ preferences: PLANS.exteriorOnly });
    const words = allText(result).join(' ');
    expect(section(result, 'pest_program').visual.items[0].title).toBe('Outside only');
    expect(words).toContain('Your plan is exterior-only');
    expect(words).not.toMatch(/the inside is yours|treats the outside and the inside|On your first visit and whenever you ask|the inside, when you want it|For the inside on later visits/);
    expect(section(result, 'treatment_categories').visual.items.map((i) => i.label)).not.toContain('Inside');
    expect(section(result, 'products').visual.items.map((i) => i.label)).toEqual(['Outside band', 'Bait']);
  });

  test('a plan without the eave sweep drops the sweep card and the web line', async () => {
    const result = await build({ preferences: PLANS.noSweep });
    const words = allText(result).join(' ');
    expect(section(result, 'treatment_categories').visual.items.map((i) => i.label)).not.toContain('Web and nest sweep');
    expect(words).not.toMatch(/Webs are swept|Webs and nests swept first/);
    expect(section(result, 'typical_visit').visual.items[2].text).toBe('The outside first; the inside, when you want it');
  });

  test('a plan with neither keeps only the outside work', async () => {
    const result = await build({ preferences: PLANS.neither });
    expect(section(result, 'typical_visit').visual.items[2].text).toBe('The outside, where the label allows');
    expect(section(result, 'treatment_categories').visual.items.map((i) => i.label)).toEqual(['Outside band', 'Bait', 'Monitors and notes']);
  });
});

describe('the product list', () => {
  test('catalog names with the active ingredient, no rate; the dinotefuran row inside only', async () => {
    const products = section(await build(), 'products');
    expect(products.bullets).toEqual([
      'Outside band: Taurus SC (fipronil); Atticus Talak 7.9 F (bifenthrin)',
      'Inside: Alpine WSG (dinotefuran)',
      'Bait: Advion Ant Bait Gel (indoxacarb)',
    ]);
  });

  test('the renamed dinotefuran row (#6863) prints its new name; the granular bait never shows', async () => {
    const catalog = [...CATALOG, { name: 'Atticus Antapex WSG', display_name: null, active_ingredient: 'Dinotefuran 40%', category: 'insecticide', product_type: 'pesticide' }, { name: 'Advion WDG Granular', active_ingredient: 'Indoxacarb', category: 'insecticide' }];
    const products = section(await build({ catalog }), 'products');
    expect(products.bullets).toContain('Inside: Atticus Antapex WSG (dinotefuran)');
    expect(products.bullets.join(' ')).not.toMatch(/Alpine|Granular/);
  });

  test('a failed catalog read leaves the section out; the page still validates', async () => {
    const result = await build({ catalogFails: true });
    expect(section(result, 'products')).toBeUndefined();
    expect(result.validation.status).toBe('passed');
  });
});

describe('the owner’s rulings hold on every plan', () => {
  test.each(Object.entries(PLANS))('%s plan', async (_name, preferences) => {
    const result = await build({ preferences });
    const words = allText(result).join(' ');
    // Rain: effectiveness only, no come-back and no prompt (owner 2026-10-22, 2026-10-24).
    const rain = section(result, 'what_to_expect').visual.items.find((t) => t.title === 'Rain').text;
    expect(rain).toBe('Labels bar outside sprays during rain. A treatment needs to dry and bond to surfaces; after that it holds up to weather.');
    // No terms, guarantee, price, visit count, band width, result or re-service timing (the estimate and agreement carry
    // those; owner 2026-09-28; the walkthrough's band widths stay off customer pages).
    expect(words).not.toMatch(/\bfree\b|guarantee|unlimited|\$\d|\b\d+\s*(visits|days|weeks)\b|\b\d+[- ]?(foot|feet|ft)\b|microencapsulated/i);
    // Owner 2026-10-01: never die, dead, dying or kill in customer copy.
    expect(words).not.toMatch(/\b(kill|kills|killed|die|dies|dead|dying)\b/i);
    // Not on a pest page: research trials the owner has not decided, granules, the surfactant, Talstar.
    expect(words).not.toMatch(/Onslaught|bait station|granul|surfactant|Talstar/i);
    for (const text of allText(result)) {
      expect({ text, banned: findBannedCustomerCopy(text) }).toEqual({ text, banned: [] });
      expect({ text, valid: validateCustomerCopy(text) }).toEqual({ text, valid: true });
    }
  });

  test('no two cards share a label, and every icon is one the page draws', async () => {
    const icons = new Set(['inspection', 'feeding', 'barrier', 'micros', 'weeds', 'insects', 'disease', 'dry_spots', 'report', 'whole_lawn', 'spots', 'count', 'rotate', 'decide', 'treat', 'area', 'calendar', 'label', 'reentry', 'epa', 'reminders', 'portal', 'arrival']);
    const result = await build();
    for (const s of result.content.sections) {
      const items = (s.visual?.items || []).filter((i) => typeof i !== 'string');
      const names = items.map((i) => i.title || i.label);
      expect(new Set(names).size).toBe(names.length);
      for (const item of items) expect({ section: s.key, icon: item.icon || item.key, known: icons.has(item.icon || item.key) }).toEqual({ section: s.key, icon: item.icon || item.key, known: true });
    }
  });
});
