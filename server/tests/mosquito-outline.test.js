// The Mosquito service outline, behind GATE_MOSQUITO_OUTLINE (owner 2026-10-26: "also we need to go through other
// related outlines, etc and make sure they are more aligned like lawn outline"; decision D4-A, "do whatever you
// recommend"). Synthetic inputs: no database.
//
// Pins: the gate is strict; the year is four seasons and the build month's season opens; the library tips are read by id
// in both GATE_TECH_TIP_SOURCES states (a sourced-only tip's tile drops with the gate off); the products are the active
// catalog rows with their active ingredient, the dunk and station rows only when the estimate holds that add-on; the
// "not included" tags follow the same counts; only an exact recurring mosquito row is a program (not a one-time job, the
// misting plan or a commercial row); the page-owned figures hold to their fact-register quotes; and every word passes the
// customer-copy checks.

const featureGates = require('../config/feature-gates');
const PROTOCOLS = require('../config/protocols.json');
const mosquito = require('../services/mosquito-service-outline');
const { OUTLINE_PROGRAMS } = require('../services/service-outline-programs');
const { resolveTipIds } = require('../services/service-report/tip-library');
const { FACTS } = require('../services/email-division/fact-register-data');
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
// Catalog rows as production stores them (product facts only), with the duplicate inactive Tekko Pro IGR row (the Tekko
// Trio formula) that production holds.
const CATALOG = [
  { name: 'Atticus Talak 7.9 F', display_name: null, active_ingredient: 'Bifenthrin 7.9%', category: 'insecticide', product_type: 'pesticide', active: true },
  { name: 'Scion Insecticide', display_name: null, active_ingredient: 'Gamma-cyhalothrin 5.9%', category: 'insecticide', product_type: 'pesticide', active: true },
  { name: 'Tekko Pro IGR', display_name: null, active_ingredient: '(S)-Hydroprene 9.0% + Novaluron 2.6% + Pyriproxyfen 2.6%', category: 'insecticide', product_type: 'pesticide', active: false },
  { name: 'Tekko Pro IGR', display_name: null, active_ingredient: 'Pyriproxyfen 1.3% + Novaluron 1.3%', category: 'insecticide', product_type: 'pesticide', active: true },
  { name: 'Summit Mosquito Dunk Tablets', display_name: null, active_ingredient: 'Bacillus thuringiensis subsp. israelensis solids', category: 'larvicide', product_type: 'pesticide', active: true },
  { name: 'In2Care Mosquito Station', display_name: null, active_ingredient: 'Beauveria bassiana spores + Pyriproxyfen', category: 'larvicide', product_type: 'pesticide', active: true },
  { name: 'Tekko Trio', display_name: null, active_ingredient: '(S)-Hydroprene 9.0% + Novaluron 2.6% + Pyriproxyfen 2.6%', category: 'insecticide', product_type: 'pesticide', active: true },
];

// A catalog read as SQL answers it: the names asked for, and only active rows when the read asks for them.
function makeDb({ catalog = CATALOG, catalogFails = false } = {}) {
  return jest.fn((table) => {
    const filters = { names: null, activeOnly: false };
    const chain = {
      where: jest.fn((column, value) => { if (column === 'active' && value === true) filters.activeOnly = true; return chain; }),
      whereIn: jest.fn((column, names) => { if (column === 'name') filters.names = names; return chain; }),
      orderBy: jest.fn(() => chain),
      select: jest.fn(() => chain),
      first: jest.fn(() => Promise.resolve(table === 'jurisdiction_fertilizer_rules' ? RULE : null)),
      then: (resolve, reject) => {
        if (table !== 'products_catalog') return Promise.resolve([]).then(resolve, reject);
        if (catalogFails) return Promise.reject(new Error('catalog read failed')).then(resolve, reject);
        const rows = catalog.filter((row) => (!filters.names || filters.names.includes(row.name)) && (!filters.activeOnly || row.active === true));
        return Promise.resolve(rows).then(resolve, reject);
      },
    };
    return chain;
  });
}

const programRow = (addOns = { stationCount: 0, dunkCount: 0 }) => ({ service: 'mosquito', program: 'silver', displayName: 'Mosquito', addOns });
const estimateDataWith = (rows) => ({ result: { recurring: { services: rows } } });

function build({ rows = [programRow()], estimateData, month, catalog, catalogFails } = {}) {
  return mosquito.buildMosquitoOutline({
    db: makeDb({ catalog, catalogFails }),
    estimate: {
      id: 'est-1',
      customer_name: 'Pat Doe',
      address: '1 Palm Way, Sarasota, FL',
      token: 'tok-1',
      monthly_total: '45.00',
      service_interest: 'Mosquito',
      estimate_data: estimateData || estimateDataWith(rows),
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
const tileTitles = (result, key) => section(result, key).visual.items.map((i) => i.title);
const tipCopy = (id, sourced) => resolveTipIds([id], { sourced, date: OCT_26 })[0]?.copy;

// The same build with GATE_TECH_TIP_SOURCES on or off.
async function withTipGate(value, run) {
  const saved = process.env.GATE_TECH_TIP_SOURCES;
  if (value === undefined) delete process.env.GATE_TECH_TIP_SOURCES; else process.env.GATE_TECH_TIP_SOURCES = value;
  try { return await run(); } finally {
    if (saved === undefined) delete process.env.GATE_TECH_TIP_SOURCES; else process.env.GATE_TECH_TIP_SOURCES = saved;
  }
}

describe('GATE_MOSQUITO_OUTLINE', () => {
  const saved = process.env.GATE_MOSQUITO_OUTLINE;
  afterEach(() => {
    if (saved === undefined) delete process.env.GATE_MOSQUITO_OUTLINE; else process.env.GATE_MOSQUITO_OUTLINE = saved;
  });

  test('is on only for exactly "true"', () => {
    for (const [value, live] of [[undefined, false], ['false', false], ['1', false], ['TRUE', false], ['true', true]]) {
      if (value === undefined) delete process.env.GATE_MOSQUITO_OUTLINE; else process.env.GATE_MOSQUITO_OUTLINE = value;
      expect(featureGates.mosquitoOutlineLive()).toBe(live);
      expect(mosquito.mosquitoOutlineLive()).toBe(live);
      expect(OUTLINE_PROGRAMS.mosquito.live()).toBe(live);
    }
  });
});

describe('the Mosquito packet', () => {
  test('sections in order, stamped Mosquito, validation passed', async () => {
    const result = await withTipGate('true', () => build());
    expect(result.content.sections.map((s) => s.key)).toEqual([
      'mosquito_program', 'program_year', 'problems', 'treatment_categories', 'products', 'typical_visit',
      'after_treatment', 'your_part', 'what_to_expect', 'common_questions', 'safety', 'after_visit', 'not_included',
    ]);
    expect(result.content.sections.map((s) => s.title)).toEqual([
      'One Routine For Every Yard', 'Your Year At A Glance', 'What We Watch For', 'Treatments That May Be Used',
      'Products We May Use', 'What A Typical Visit Includes', 'After A Treatment', 'Your Part: Water And Shade',
      'What To Expect', 'Common Questions', 'Safety And Labels', 'After Each Visit', 'Not Included Unless Quoted',
    ]);
    expect(result.validation).toEqual({ status: 'passed', errors: [], warnings: [] });
    expect(result.content.serviceLine).toBe('mosquito');
    expect(result.content.title).toBe('Your Waves Mosquito Program Overview');
    expect(result.content.intro).toBe('Based on your estimate for Pat Doe. One routine covers every yard we treat for mosquitoes. What each visit treats is decided on site, from what we find, the weather, and the product label.');
    expect(result.content.property).toEqual(expect.objectContaining({ programLabel: 'One routine for every yard', turfType: null }));
    expect(result.meta).toEqual(expect.objectContaining({
      serviceLine: 'mosquito',
      contentLibraryVersion: 'mosquito-v1-copy-1',
      protocolVersion: PROTOCOLS.mosquito.version ?? null,
    }));
    expect(result.inputSnapshot).toEqual(expect.objectContaining({ serviceLine: 'mosquito', addOns: { dunks: 0, stations: 0 } }));
    expect(result.summary.serviceLineDetected).toBe(true);
    // No tip id leaks into the stored packet.
    expect(JSON.stringify(result.content)).not.toMatch(/tipId/);
  });

  test('the tiles and cards read in the draft’s order and words', async () => {
    const result = await withTipGate('true', () => build());
    expect(tileTitles(result, 'mosquito_program')).toEqual(['Treat where they rest', 'Find where they breed', 'Treat water that has to stay']);
    expect(tileTitles(result, 'problems')).toEqual(['Water in containers', 'Water next door', 'Daytime biters', 'Not every biter is a mosquito']);
    expect(section(result, 'treatment_categories').visual.items.map((i) => [i.key, i.label])).toEqual([
      ['inspection', 'Inspection'], ['dry_spots', 'Source reduction'], ['insects', 'Barrier spray'], ['spots', 'Larval control'],
    ]);
    expect(section(result, 'typical_visit').visual.items.map((i) => i.title)).toEqual(['Check', 'Decide', 'Treat', 'Report']);
    expect(tileTitles(result, 'after_treatment')).toEqual(['Don\'t rinse the shrubs', 'Rain']);
    expect(tileTitles(result, 'your_part')).toEqual(['Flush bromeliads weekly', 'Check the ribbed downspout pipe', 'Thin the thick hedges', 'Run a fan where you sit', 'On service day']);
    expect(tileTitles(result, 'what_to_expect')).toEqual(['Fewer mosquitoes, not zero', 'Rain brings new hatches', 'Weather can change a visit', 'If we also care for your shrubs']);
    expect(tileTitles(result, 'common_questions')).toEqual(['Isn\'t my pest control enough for mosquitoes?', 'Where do my mosquitoes come from?', 'Will a bug zapper help?']);
    expect(tileTitles(result, 'safety')).toEqual(['Label directions', 'Stay off until dry', 'Follow your report', 'EPA numbers', 'Bees and blooms', 'Edible plants and water']);
    expect(tileTitles(result, 'after_visit')).toEqual(['A service report', 'Reminders', 'Your customer portal', 'Arrival record']);
    const text = Object.fromEntries(section(result, 'after_treatment').visual.items.map((i) => [i.title, i.text]));
    expect(text.Rain).toBe('The labels on our sprays say not to apply during rain, so the technician checks the forecast first. A spray needs to dry on the leaves; after that it holds up to weather.');
    expect(section(result, 'not_included').visual.note).toBe('Some mosquito problems need a fix at home instead, such as clearing a gutter, patching a screen, thinning a hedge, or fixing a drainage problem.');
  });
});

describe('the year as four seasons', () => {
  test.each([[1, 'Winter'], [3, 'Winter'], [4, 'Spring'], [7, 'Summer'], [10, 'Fall'], [12, 'Fall']])('month %i opens %s', async (month, open) => {
    const year = section(await withTipGate('true', () => build({ month })), 'program_year');
    expect(year.visual).toEqual(expect.objectContaining({ type: 'months', labels: {}, limitLabel: null }));
    expect(year.visual.months.map((m) => m.label)).toEqual(['Winter', 'Spring', 'Summer', 'Fall']);
    expect(year.visual.months.filter((m) => m.open).map((m) => m.label)).toEqual([open]);
    for (const m of year.visual.months) {
      expect(m.main).toEqual([]);
      expect(m.asNeeded).toEqual([]);
      expect(m.limited).toBe(false);
      expect(m.visit).toEqual(expect.any(String));
      expect(m.atHome.length).toBeGreaterThan(40);
    }
    expect(year.bullets).toHaveLength(4);
  });
});

describe('the library tips are read by id', () => {
  const SEASON_TIPS = ['water_bird_bath', 'mq_tree_holes', 'water_weekly_dump', 'mq_pool'];

  test('gate on: the sourced words, every tip tile present', async () => {
    const result = await withTipGate('true', () => build());
    const atHome = section(result, 'program_year').visual.months.map((m) => m.atHome);
    expect(atHome).toEqual(SEASON_TIPS.map((id) => tipCopy(id, true)));
    expect(atHome[0]).toMatch(/^The Florida Department of Health's rule for birdbaths/);
    const text = (key, title) => section(result, key).visual.items.find((i) => i.title === title).text;
    expect(text('problems', 'Daytime biters')).toBe(tipCopy('mq_daytime_biters', true));
    expect(text('your_part', 'Check the ribbed downspout pipe')).toBe(tipCopy('mq_downspout_pipe', true));
    expect(text('your_part', 'Thin the thick hedges')).toBe(tipCopy('mq_thin_hedges', true));
    expect(text('your_part', 'Run a fan where you sit')).toBe(tipCopy('mq_lanai_fan', true));
    expect(text('common_questions', 'Where do my mosquitoes come from?')).toBe(tipCopy('mq_few_blocks', true));
    expect(text('common_questions', 'Will a bug zapper help?')).toBe(tipCopy('mq_skip_zapper', true));
  });

  test('gate off: the plain words, and a sourced-only tip’s tile drops', async () => {
    const result = await withTipGate(undefined, () => build());
    const atHome = section(result, 'program_year').visual.months.map((m) => m.atHome);
    expect(atHome).toEqual(SEASON_TIPS.map((id) => tipCopy(id, false)));
    expect(atHome[0]).toMatch(/^Water changed every few days/);
    expect(tileTitles(result, 'problems')).toEqual(['Water in containers', 'Water next door', 'Not every biter is a mosquito']);
    expect(tileTitles(result, 'common_questions')).toEqual(['Isn\'t my pest control enough for mosquitoes?']);
    expect(tileTitles(result, 'your_part')).toEqual(['Flush bromeliads weekly', 'Check the ribbed downspout pipe', 'Thin the thick hedges', 'Run a fan where you sit', 'On service day']);
    expect(result.validation.status).toBe('passed');
  });

  test('every tip id the page uses is in the library with the gate on (a renamed tip cannot leave a hole)', () => {
    const ids = [
      ...mosquito.MOSQUITO_COPY.seasons.map((s) => s.atHomeTip),
      ...[...mosquito.MOSQUITO_COPY.problemTiles, ...mosquito.MOSQUITO_COPY.yourPartTips, ...mosquito.MOSQUITO_COPY.questionTiles].map((t) => t.tipId).filter(Boolean),
    ];
    expect(ids).toHaveLength(10);
    for (const id of ids) expect({ id, copy: tipCopy(id, true) }).toEqual({ id, copy: expect.any(String) });
  });
});

describe('the product list', () => {
  test('active catalog rows with the active ingredient, no rate; the inactive duplicate never prints', async () => {
    const products = section(await build(), 'products');
    expect(products.bullets).toEqual([
      'Barrier spray: Atticus Talak 7.9 F (bifenthrin); Scion Insecticide (gamma-cyhalothrin)',
      'Larval control: Tekko Pro IGR (pyriproxyfen + novaluron)',
    ]);
    expect(products.bullets.join(' ')).not.toMatch(/hydroprene|Tekko Trio|%/);
  });

  test.each([
    ['dunks only', { dunkCount: 2, stationCount: 0 }, 'Larval control: Tekko Pro IGR (pyriproxyfen + novaluron); Summit Mosquito Dunk Tablets (bacillus thuringiensis subsp. israelensis solids)'],
    ['stations only', { dunkCount: 0, stationCount: 1 }, 'Larval control: Tekko Pro IGR (pyriproxyfen + novaluron); In2Care Mosquito Station (beauveria bassiana spores + pyriproxyfen)'],
    ['both', { dunkCount: 3, stationCount: 2 }, 'Larval control: Tekko Pro IGR (pyriproxyfen + novaluron); Summit Mosquito Dunk Tablets (bacillus thuringiensis subsp. israelensis solids); In2Care Mosquito Station (beauveria bassiana spores + pyriproxyfen)'],
  ])('add-on rows print only with counts above zero: %s', async (_name, addOns, larval) => {
    const products = section(await build({ rows: [programRow(addOns)] }), 'products');
    expect(products.bullets[1]).toBe(larval);
  });

  test('a row with no add-ons key, or null add-ons, prints neither add-on row', async () => {
    for (const row of [{ service: 'mosquito' }, { service: 'mosquito', addOns: null }]) {
      const products = section(await build({ rows: [row] }), 'products');
      expect(products.bullets[1]).toBe('Larval control: Tekko Pro IGR (pyriproxyfen + novaluron)');
    }
  });

  test('a repo-built catalog names Talak "Atticus Talak"; production’s name wins when both exist', async () => {
    const repoBuilt = CATALOG.map((row) => (row.name === 'Atticus Talak 7.9 F' ? { ...row, name: 'Atticus Talak' } : row));
    expect(section(await build({ catalog: repoBuilt }), 'products').bullets[0]).toBe('Barrier spray: Atticus Talak (bifenthrin); Scion Insecticide (gamma-cyhalothrin)');
    const both = [...repoBuilt, CATALOG[0]];
    expect(section(await build({ catalog: both }), 'products').bullets[0]).toMatch(/^Barrier spray: Atticus Talak 7\.9 F \(bifenthrin\)/);
  });

  test('a retired (inactive) product drops; with every row gone the section leaves out', async () => {
    const noScion = CATALOG.map((row) => (row.name === 'Scion Insecticide' ? { ...row, active: false } : row));
    expect(section(await build({ catalog: noScion }), 'products').bullets[0]).toBe('Barrier spray: Atticus Talak 7.9 F (bifenthrin)');
    const result = await build({ catalog: CATALOG.map((row) => ({ ...row, active: false })) });
    expect(section(result, 'products')).toBeUndefined();
    expect(result.validation.status).toBe('passed');
  });

  test('a failed catalog read leaves the section out; the page still validates', async () => {
    const result = await build({ catalogFails: true });
    expect(section(result, 'products')).toBeUndefined();
    expect(result.validation.status).toBe('passed');
  });
});

describe('"not included" tags follow the estimate’s add-ons', () => {
  const tags = async (addOns) => section(await build({ rows: [programRow(addOns)] }), 'not_included').visual.items;
  const BASE = ['No-see-ums and biting midges', 'Gnats', 'Fleas and ticks', 'Bti dunks', 'Mosquito stations', 'Hedge trimming', 'Gutter, drain and screen repairs'];

  test('no add-ons: both tags stay', async () => {
    expect(await tags({ dunkCount: 0, stationCount: 0 })).toEqual(BASE);
  });

  test('dunks drop the Bti dunks tag; stations drop the Mosquito stations tag', async () => {
    expect(await tags({ dunkCount: 1, stationCount: 0 })).toEqual(BASE.filter((t) => t !== 'Bti dunks'));
    expect(await tags({ dunkCount: 0, stationCount: 4 })).toEqual(BASE.filter((t) => t !== 'Mosquito stations'));
    expect(await tags({ dunkCount: 1, stationCount: 1 })).toEqual(BASE.filter((t) => !['Bti dunks', 'Mosquito stations'].includes(t)));
  });
});

describe('who gets the page: an exact recurring mosquito row', () => {
  test('a recurring row counts in either container shape', () => {
    expect(mosquito.mosquitoProgramRow(estimateDataWith([programRow()]))).toEqual(expect.objectContaining({ service: 'mosquito' }));
    expect(mosquito.mosquitoProgramRow({ result: { results: { recurring: { services: [programRow()] } } } })).not.toBeNull();
    expect(mosquito.mosquitoProgramRow({ engineResult: { recurring: { services: [programRow()] } } })).not.toBeNull();
    expect(mosquito.mosquitoProgramRow(JSON.stringify(estimateDataWith([programRow()])))).not.toBeNull();
  });

  test.each([
    ['no data', null],
    ['no result', {}],
    ['a one-time mosquito job', { result: { oneTime: { items: [{ service: 'one_time_mosquito', price: 189 }] }, recurring: { services: [{ service: 'pest_control' }] } } }],
    ['the misting plan', estimateDataWith([{ service: 'mosquito_misting' }])],
    ['a commercial mosquito row', estimateDataWith([{ service: 'commercial_mosquito' }])],
    ['a mosquito row in the one-time items', { result: { oneTime: { items: [{ service: 'mosquito' }] } } }],
    ['another recurring service', estimateDataWith([{ service: 'pest_control' }])],
  ])('%s is not a program', async (_name, estimateData) => {
    expect(mosquito.mosquitoProgramRow(estimateData)).toBeNull();
    // The builder holds the rule: an operational 422 the error handler answers (middleware/errors.js), no packet.
    await expect(build({ estimateData: estimateData || {} })).rejects.toMatchObject({ isOperational: true, statusCode: 422, code: 'mosquito_program_row_missing' });
  });

  test('the Estimates list offers it only on a mosquito line with a program row', () => {
    const { offeredOn } = OUTLINE_PROGRAMS.mosquito;
    const data = estimateDataWith([programRow()]);
    expect(offeredOn({ key: 'mosquito' }, { estimateData: data })).toBe(true);
    expect(offeredOn({ key: 'mosquito' }, { estimateData: estimateDataWith([{ service: 'mosquito_misting' }]) })).toBe(false);
    expect(offeredOn({ key: 'mosquito' }, { estimateData: {} })).toBe(false);
    expect(offeredOn({ key: 'mosquito' })).toBe(false);
    expect(offeredOn({ key: 'pest' }, { estimateData: data })).toBe(false);
  });

  test('the registry entry carries the stamps, the keys and the send words', () => {
    const program = OUTLINE_PROGRAMS.mosquito;
    expect(program.contentLibraryVersion()).toBe('mosquito-v1-copy-1');
    expect(program.protocolVersion()).toBe(PROTOCOLS.mosquito.version ?? null);
    expect(program.listKeys).toEqual({ available: 'mosquitoOutlineAvailable', outline: 'mosquitoServiceOutline' });
    expect(program.offError).toBe('Mosquito outlines are not turned on.');
    expect(program.send).toEqual({ program: 'mosquito', title: 'Your Waves Mosquito Program Overview', messageType: 'mosquito_service_outline' });
  });
});

describe('page-owned figures hold to their fact-register quotes', () => {
  const quote = (slug) => FACTS.find((fact) => fact.slug === slug).quote;
  const normalize = (text) => text.replace(/[’‘]/g, "'");

  test('"7 to 10 days" is the CDC’s egg-to-adult figure', async () => {
    const result = await withTipGate('true', () => build());
    const text = section(result, 'problems').visual.items.find((i) => i.title === 'Water in containers').text;
    const [, low, high] = text.match(/takes (\d+) to (\d+) days to become an adult/);
    expect(quote('fact-container-mosquitoes')).toContain(`A mosquito egg takes ${low}–${high} days to develop into an adult mosquito.`);
  });

  test('"a bottle cap’s worth" is UF/IFAS’s figure', async () => {
    const result = await withTipGate('true', () => build());
    const text = section(result, 'your_part').visual.items.find((i) => i.title === 'Flush bromeliads weekly').text;
    expect(text).toContain('it takes only a bottle cap\'s worth to breed mosquitoes');
    expect(normalize(quote('fact-tip-water-bromeliads'))).toContain('It only takes a bottle cap\'s worth of water to provide a breeding ground for mosquitoes');
  });
});

describe('the owner’s rulings and the customer-copy checks hold in every state', () => {
  const STATES = [
    ['gate on, no add-ons', 'true', { dunkCount: 0, stationCount: 0 }],
    ['gate on, dunks and stations', 'true', { dunkCount: 2, stationCount: 1 }],
    ['gate off, no add-ons', undefined, { dunkCount: 0, stationCount: 0 }],
    ['gate off, dunks and stations', undefined, { dunkCount: 2, stationCount: 1 }],
  ];

  test.each(STATES)('%s', async (_name, gate, addOns) => {
    const result = await withTipGate(gate, () => build({ rows: [programRow(addOns)] }));
    expect(result.validation).toEqual({ status: 'passed', errors: [], warnings: [] });
    const words = allText(result).join(' ');
    // No price, visit count, cadence, terms or guarantee (the estimate and agreement carry those).
    expect(words).not.toMatch(/\bfree\b|guarantee|unlimited|\$\d|\b\d+\s*(visits|weeks)\b|every \d+ days|monthly|roughly every|annual/i);
    // GATE_MOSQUITO_MISTING is off: the page never says mist or fog.
    expect(words).not.toMatch(/\bmist|\bfog/i);
    // Left off the product list on purpose: Tekko Trio (indoor-only), Bifen I/T, Talstar P, Cyzmic, Altosid; no rate or % figure.
    expect(words).not.toMatch(/Tekko Trio|Bifen I\/T|Talstar|Cyzmic|Altosid|hydroprene|\d\s*%/i);
    // Owner 2026-10-22, 2026-10-24: rain speaks to effectiveness only, no contact prompt and no come-back.
    const rain = section(result, 'after_treatment').visual.items.find((t) => t.title === 'Rain').text;
    expect(rain).not.toMatch(/text us|call us|come back|return|re-?service/i);
    for (const text of allText(result)) {
      expect({ text, banned: findBannedCustomerCopy(text) }).toEqual({ text, banned: [] });
      expect({ text, valid: validateCustomerCopy(text) }).toEqual({ text, valid: true });
    }
  });

  test('no two cards share a label, and every icon is one the page draws', async () => {
    const icons = new Set(['inspection', 'feeding', 'barrier', 'micros', 'weeds', 'insects', 'disease', 'dry_spots', 'report', 'whole_lawn', 'spots', 'count', 'rotate', 'decide', 'treat', 'area', 'calendar', 'label', 'reentry', 'epa', 'reminders', 'portal', 'arrival']);
    const result = await withTipGate('true', () => build({ rows: [programRow({ dunkCount: 1, stationCount: 1 })] }));
    for (const s of result.content.sections) {
      const items = (s.visual?.items || []).filter((i) => typeof i !== 'string');
      const names = items.map((i) => i.title || i.label);
      expect(new Set(names).size).toBe(names.length);
      for (const item of items) expect({ section: s.key, icon: item.icon || item.key, known: icons.has(item.icon || item.key) }).toEqual({ section: s.key, icon: item.icon || item.key, known: true });
    }
  });
});
