// The lawn service outline on the v13 program, behind GATE_LAWN_OUTLINE_V13 (owner 2026-10-22:
// "lawn service outline ... updated with the new protocols, check other sections").
// Synthetic inputs: no database.
//
// Pins: the gate needs GATE_LAWN_V13; the outline reads the grass the estimate recorded
// (never the bermudaSuppression flag or a note); bahia is blocked; every other lawn gets the
// same customer page, with no grass on it (owner 2026-10-24: "i dont think we make this for
// specific lawn types"); every section is drawn and keeps its text lines; the month text is
// the lawn report's own; the year chart and the month chips are drawn from the recipe; every
// v13 line, each plan size included, reaches a category and no product, number or rate does;
// the outline stamps its own content version.

const v13 = require('../config/lawn-protocol-v13.json');
const outline = require('../services/lawn-service-outline');
const { PROGRAM_DETAIL_V13 } = require('../services/service-report/lawn-program-line');
const { findBannedCustomerCopy } = require('../services/service-report/activity-indicators');
const { validateCustomerCopy } = require('../services/service-report/premium-experience');

const GATE_NAMES = ['GATE_LAWN_V13', 'GATE_LAWN_OUTLINE_V13', 'GATE_LAWN_BERMUDA_REMOVAL'];
const BOTH = { GATE_LAWN_V13: 'true', GATE_LAWN_OUTLINE_V13: 'true' };
const MONTHS = Array.from({ length: 12 }, (_, i) => i + 1);
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const CONDITIONAL_TAIL = ' may be relevant when turf condition, weather, label directions, and local rules allow.';

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

const MODULE_KEYS = [
  'assessment_protocol', 'st_augustine_protocol_summary', 'bermuda_protocol_summary', 'zoysia_protocol_summary',
  'bahia_protocol_summary', 'mixed_turf_summary', 'unknown_turf_summary', 'season_jan_mar', 'season_apr_may',
  'season_jun_sep', 'season_oct_dec', 'product_transparency', 'safety_and_label_compliance', 'local_fertilizer_rules',
  'post_service_reports', 'gps_tracking', 'service_reminders', 'customer_portal', 'what_this_does_not_include',
];

function makeDb() {
  const moduleRows = MODULE_KEYS.map((key) => ({ key, plain_text: `Approved ${key} text.`, status: 'approved', version: 1 }));
  const rule = {
    jurisdiction_id: 'sarasota_county_fl',
    jurisdiction_name: 'Sarasota County, FL',
    version: '2026-05-30',
    public_summary: 'Local fertilizer rules may restrict nitrogen and phosphorus applications during the summer rainy season.',
    restricted_start_month: 6,
    restricted_start_day: 1,
    restricted_end_month: 9,
    restricted_end_day: 30,
  };
  const db = jest.fn((table) => {
    const chain = {
      where: jest.fn(() => chain),
      whereIn: jest.fn(() => chain),
      whereNull: jest.fn(() => chain),
      orWhere: jest.fn(() => chain),
      orderBy: jest.fn(() => chain),
      select: jest.fn(() => chain),
      limit: jest.fn(() => chain),
      first: jest.fn(() => Promise.resolve(table === 'jurisdiction_fertilizer_rules' ? rule : null)),
      then: (resolve, reject) => Promise.resolve(table === 'lawn_service_content_modules' ? moduleRows : []).then(resolve, reject),
    };
    return chain;
  });
  db.fn = { now: jest.fn(() => new Date('2026-10-24T12:00:00Z')) };
  return db;
}

// A St. Augustine estimate as the admin form writes it (production shape, read-only 10-24): the
// lawn line in inputs (svcLawn + grassType), the saved request, the stored lawn meta, and the
// bermuda suppression add-on flag in the same inputs.
function estimateWith(estimateData, extra = {}) {
  return {
    id: 'estimate-1',
    customer_name: 'Test Customer',
    address: '100 Test Way, Sarasota, FL 34240',
    token: 'estimate-token',
    estimate_data: estimateData,
    ...extra,
  };
}
const formLawn = (grassType) => ({
  inputs: { svcLawn: true, grassType, bermudaSuppression: false },
  engineRequest: { selectedServices: ['LAWN'], options: { grassType } },
  result: { results: { lawnMeta: { grassType } } },
});
// The estimator engine, quote wizard and one-tap shape: engine inputs with a lawn line and its track.
const engineLawn = (track) => ({ engineInputs: { services: { lawn: { track } } } });
const ST_AUG_ESTIMATE = estimateWith(formLawn('st_augustine'));

const build = (estimate, input = {}) => outline.buildOutline({ db: makeDb(), estimate, input, now: new Date('2026-10-24T12:00:00Z') });
const section = (result, key) => result.content.sections.find((s) => s.key === key);
const categoriesOf = (bullets) => bullets.map((b) => b.replace(CONDITIONAL_TAIL, ''));
const V13_KEYS = [
  'lawn_program', 'season_focus', 'program_year', 'treatment_categories', 'typical_visit',
  'local_rules', 'safety', 'after_visit', 'not_included',
];
// What the customer page shows (content.turf and generatedAt are not drawn).
const visible = ({ title, intro, property, season, sections, treatmentCategories, productCards, cta }) => (
  { title, intro, property, season, sections, treatmentCategories, productCards, cta }
);

describe('the gate', () => {
  test('GATE_LAWN_OUTLINE_V13 alone does nothing: it needs GATE_LAWN_V13', async () => {
    await withGates({ GATE_LAWN_OUTLINE_V13: 'true' }, async () => {
      const result = await build(ST_AUG_ESTIMATE, { month: 10 });
      expect(section(result, 'your_turf_type')).toBeTruthy();
      expect(section(result, 'lawn_program')).toBeUndefined();
      expect(result.meta.contentLibraryVersion).toBe('seed-v1');
      expect(outline.contentLibraryVersion()).toBe('seed-v1');
    });
  });

  test('stamps: the v13 outline carries its own content version; off keeps seed-v1', async () => {
    await withGates({ GATE_LAWN_V13: 'true' }, async () => {
      expect(outline.contentLibraryVersion()).toBe('seed-v1');
      expect((await build(ST_AUG_ESTIMATE)).meta.contentLibraryVersion).toBe('seed-v1');
    });
    await withGates(BOTH, async () => {
      expect(outline.contentLibraryVersion()).toBe('lawn-v13-copy-2');
      expect(outline.CONTENT_LIBRARY_VERSION).toBe('seed-v1');
      const result = await build(ST_AUG_ESTIMATE);
      expect(result.meta.contentLibraryVersion).toBe('lawn-v13-copy-2');
      expect(result.meta.protocolVersion).toBe('lawn-v13');
    });
  });
});

describe('the grass is the one the estimate recorded', () => {
  test('a St. Augustine estimate reads St. Augustine; the old whole-estimate scan read its bermudaSuppression flag as Bermuda', async () => {
    await withGates({ GATE_LAWN_V13: 'true' }, async () => {
      expect((await build(ST_AUG_ESTIMATE)).meta.turf.turfType).toBe('bermuda');
    });
    await withGates(BOTH, async () => {
      const result = await build(ST_AUG_ESTIMATE);
      expect(result.meta.turf.turfType).toBe('st_augustine');
      // The page names the program, not the grass.
      expect(result.content.property).toMatchObject({ turfType: null, programLabel: 'Year-round, set to your lawn' });
    });
  });

  test('every stored lawn shape the send path reads: engine inputs, form inputs, the saved request, stored results', async () => {
    await withGates(BOTH, async () => {
      expect((await build(estimateWith(engineLawn('zoysia')))).meta.turf.turfType).toBe('zoysia');
      expect((await build(estimateWith({ engineInput: { services: { lawn: { track: 'bermuda' } } } }))).meta.turf.turfType).toBe('bermuda');
      expect((await build(estimateWith({ inputs: { svcLawn: true, grassType: 'C2' } }))).meta.turf.turfType).toBe('zoysia');
      expect((await build(estimateWith({ engineRequest: { selectedServices: ['LAWN'], options: { grassType: 'C1' } } }))).meta.turf.turfType).toBe('bermuda');
      expect((await build(estimateWith({ result: { results: { lawnMeta: { grassType: 'A' } } } }))).meta.turf.turfType).toBe('st_augustine');
      const zoysiaCards = await build(estimateWith(engineLawn('zoysia')), { includeProductCards: true });
      expect(zoysiaCards.validation.errors.join(' ')).not.toMatch(/turf type is confirmed/);
    });
  });

  test('the composer pick wins over the recorded grass', async () => {
    await withGates(BOTH, async () => {
      expect((await build(ST_AUG_ESTIMATE, { turfType: 'zoysia' })).meta.turf.turfType).toBe('zoysia');
      const picked = await build(estimateWith({ ...engineLawn('st_augustine'), result: { results: { lawnMeta: { grassType: 'bahia' } } } }), { turfType: 'st_augustine' });
      expect(picked.meta.turf.turfType).toBe('st_augustine');
      expect(picked.validation.status).toBe('passed');
    });
  });

  test("a pest-only estimate's default grassType is not a lawn plan: unknown", async () => {
    await withGates(BOTH, async () => {
      const pestOnly = estimateWith({ inputs: { grassType: 'st_augustine' }, engineRequest: { selectedServices: ['PEST'], options: { grassType: 'st_augustine' } } });
      expect((await build(pestOnly)).meta.turf.turfType).toBe('unknown');
    });
  });

  test('no recorded grass is unknown, never a guess from a note or the rest of the estimate', async () => {
    await withGates(BOTH, async () => {
      const estimate = estimateWith(
        { engineRequest: { profile: { possibleGrassType: 'BAHIA' } }, inputs: { bermudaSuppression: true } },
        { notes: 'Bermuda creeping in from the neighbor', description: 'Front yard St. Augustine' },
      );
      const result = await build(estimate, { month: 4 });
      expect(result.meta.turf.turfType).toBe('unknown');
      expect(result.content.title).toBe('Your Waves Lawn Care Program Overview');
      expect(result.content.property.turfType).toBeNull();
      expect(result.content.sections.map((s) => s.key)).toEqual(V13_KEYS);
      // The one program still plans an unknown lawn (the shared key), so the month has its bullets.
      expect(categoriesOf(section(result, 'season_focus').bullets)).toContain('Fertilizer and nutrition');
      expect(result.validation.status).toBe('passed');
    });
  });

  test.each([
    ['form inputs, bahia', formLawn('bahia')],
    ['form inputs, D', formLawn('D')],
    ['form inputs, Argentine bahia', formLawn('Argentine bahia')],
    ['engine inputs, bahia', engineLawn('bahia')],
    ['engine inputs St. Augustine, stored result bahia', { ...engineLawn('st_augustine'), result: { results: { lawnMeta: { grassType: 'bahia' } } } }],
  ])('bahia (%s) is blocked: v13 has no bahia program', async (_label, estimateData) => {
    await withGates(BOTH, async () => {
      const result = await build(estimateWith(estimateData), { month: 10 });
      expect(result.meta.turf.turfType).toBe('bahia');
      expect(result.validation.status).toBe('blocked');
      expect(result.validation.errors.join(' ')).toMatch(/no lawn program/i);
      expect(section(result, 'season_focus').bullets).toEqual([]);
    });
  });

  test('a mixed lawn gets the one program and no staff wording', async () => {
    await withGates(BOTH, async () => {
      const result = await build(estimateWith(formLawn('mixed')), { month: 6 });
      expect(result.meta.turf.turfType).toBe('mixed');
      expect(result.content.sections.map((s) => s.key)).toEqual(V13_KEYS);
      expect(JSON.stringify(result.content)).not.toMatch(/admin confirmation/i);
      expect(categoriesOf(section(result, 'season_focus').bullets)).toContain('Micronutrients');
      expect(result.validation.status).toBe('passed');
    });
  });
});

describe('one page for every lawn', () => {
  test.each(MONTHS)('month %i: every lawn the program covers gets the same page, and no grass is named on it but the program basis', async (month) => {
    await withGates(BOTH, async () => {
      const page = visible((await build(ST_AUG_ESTIMATE, { month })).content);
      for (const grass of ['bermuda', 'zoysia', 'mixed', 'unknown']) {
        expect([grass, visible((await build(estimateWith(formLawn(grass)), { month })).content)]).toEqual([grass, page]);
      }
      const text = JSON.stringify(page);
      expect(section({ content: page }, 'lawn_program').body).toMatch(/^Most of the lawns we treat are St\. Augustine, so the program is built around it\./);
      expect(text.match(/augustine/gi)).toHaveLength(1);
      // The intro (owner-approved words) names bermudagrass only as a spot the crew maps, never as the lawn's grass.
      expect(text.replace('insects, disease or bermudagrass.', 'insects or disease.')).not.toMatch(/bermuda|zoysia|bahia|grass type|turf type/i);
    });
  });
});

describe('regenerating an older outline', () => {
  // A packet the old outline built for a St. Augustine estimate: it guessed Bermuda, and staff picked nothing.
  const guessedPacket = { turf_type: 'bermuda', input_snapshot_json: { turfType: null, month: 10 } };
  const pickedPacket = { turf_type: 'zoysia', input_snapshot_json: { turfType: 'zoysia', month: 10 } };

  test('gate off keeps the packet grass; the v13 outline keeps only a staff pick and re-reads the estimate', async () => {
    await withGates({ GATE_LAWN_V13: 'true' }, async () => {
      expect(outline.regenerationTurfType(guessedPacket)).toBe('bermuda');
      expect(outline.regenerationTurfType(pickedPacket)).toBe('zoysia');
    });
    await withGates(BOTH, async () => {
      expect(outline.regenerationTurfType(guessedPacket)).toBeNull();
      expect(outline.regenerationTurfType(pickedPacket)).toBe('zoysia');
      const regenerated = await build(ST_AUG_ESTIMATE, { month: 10, turfType: outline.regenerationTurfType(guessedPacket) });
      expect(regenerated.meta.turf.turfType).toBe('st_augustine');
      expect(regenerated.meta.contentLibraryVersion).toBe('lawn-v13-copy-2');
    });
  });
});

describe('the sections', () => {
  test('one program section, the report month text, the drawn year, no tier line and no restricted-season line', async () => {
    await withGates(BOTH, async () => {
      const result = await build(ST_AUG_ESTIMATE, { month: 10 });
      expect(result.content.sections.map((s) => s.key)).toEqual(V13_KEYS);
      expect(result.content.title).toBe('Your Waves Lawn Care Program Overview');
      // The property summary section is gone: the intro names the customer, the side panel the address.
      expect(result.content.intro).toMatch(/^Based on your estimate for Test Customer\. The program follows the time of year\./);
      const text = JSON.stringify(result.content.sections);
      expect(text).not.toMatch(/service tier/i);
      expect(text).not.toMatch(/restricted-season logic/i);
      expect(text).not.toMatch(/soil.test/i);
      // Owner 2026-10-24: the twelve "In <month> the program focuses on ..." sentences read as filler; the year is drawn.
      expect(text).not.toMatch(/program focuses on/i);
      expect(section(result, 'local_rules').bullets).toEqual([
        'Your rule area: Sarasota County, FL',
        'What it limits: Local fertilizer rules may restrict nitrogen and phosphorus applications during the summer rainy season.',
        'What we do instead: Micronutrients for color, inspection, and spot treatments, with no nitrogen or phosphorus',
      ]);
      // One tile row in place of the report and portal sections; GPS records arrival only.
      expect(section(result, 'after_visit').bullets).toContain('Arrival record: GPS on the service vehicle records when the technician arrives');
      expect(text).not.toMatch(/arrival and completion/i);
      expect(result.content.treatmentCategories.map((c) => c.label)).toEqual(section(result, 'treatment_categories').bullets.map((b) => b.split(':')[0]));
    });
  });

  test('every drawn section keeps text bullets that say what the drawing says', async () => {
    await withGates(BOTH, async () => {
      const result = await build(ST_AUG_ESTIMATE, { month: 10 });
      // Every section is boxed (owner 2026-10-24: "make the boxes").
      expect(result.content.sections.map((s) => [s.key, s.visual?.type])).toEqual([
        ['lawn_program', 'tiles'], ['season_focus', 'chips'], ['program_year', 'year'], ['treatment_categories', 'categories'], ['typical_visit', 'steps'],
        ['local_rules', 'tiles'], ['safety', 'tiles'], ['after_visit', 'tiles'], ['not_included', 'tags'],
      ]);
      for (const tiles of result.content.sections.filter((s) => s.visual.type === 'tiles')) {
        expect([tiles.key, tiles.bullets]).toEqual([tiles.key, tiles.visual.items.map((t) => `${t.title}: ${t.text}`)]);
      }
      expect(section(result, 'safety').visual.items.map((t) => t.title)).toEqual(['Label directions', 'Stay off until dry', 'Follow your report', 'EPA numbers']);
      const tags = section(result, 'not_included');
      expect(tags.bullets).toEqual(tags.visual.items);
      expect(tags.visual.items).toEqual(['Irrigation repairs', 'Mowing', 'Sod', 'Seed', 'Topdressing', 'Cultural repairs', 'Heavy shade corrections']);
      expect(tags.visual.note).toMatch(/watering or mowing height/);
      const steps = section(result, 'typical_visit');
      expect(steps.visual.items.map((t) => t.title)).toEqual(['Check', 'Decide', 'Treat', 'Report']);
      expect(steps.bullets).toEqual(steps.visual.items.map((t) => `${t.title}: ${t.text}`));
      expect(steps.body).toBe('');
      const cards = section(result, 'treatment_categories');
      expect(cards.bullets).toEqual(cards.visual.items.map((c) => `${c.label}: ${c.text}`));
      expect(section(result, 'program_year').bullets[9]).toBe('October: Fertilizer, Pre-emergent; as needed: Disease control, Insect control, Weed control, Wetting agent');
      // The legacy outline draws nothing.
      await withGates({ GATE_LAWN_V13: 'true' }, async () => {
        expect((await build(ST_AUG_ESTIMATE, { month: 10 })).content.sections.some((s) => 'visual' in s)).toBe(false);
      });
    });
  });

  test('the year chart is the recipe: each month\'s whole-lawn step, what may be added, and the rule\'s limited months', async () => {
    await withGates(BOTH, async () => {
      const { visual } = section(await build(ST_AUG_ESTIMATE, { month: 10 }), 'program_year');
      const byMonth = Object.fromEntries(visual.months.map((m) => [m.label, m]));
      expect(visual.months.map((m) => m.label)).toEqual(MONTH_ABBR);
      expect(byMonth.Jan).toMatchObject({ main: ['barrier', 'micros'], asNeeded: ['disease', 'weeds'], limited: false });
      // Owner 2026-11-01 (fungus prevention): February carries the Velista large patch spring pass, so disease may be added (after the weed line, in recipe order).
      expect(byMonth.Feb).toMatchObject({ main: ['feeding'], asNeeded: ['weeds', 'disease'] });
      // The 9x April bag (pre-emergent with fertilizer) is a plan-size variant: drawn as may-be-added.
      expect(byMonth.Apr.main).toEqual(['feeding']);
      expect(byMonth.Apr.asNeeded).toEqual(expect.arrayContaining(['barrier', 'disease', 'insects']));
      expect(byMonth.May.main).toEqual(['insects']);
      expect(byMonth.Jul).toMatchObject({ main: ['inspection'], limited: true });
      expect(byMonth.Oct.main).toEqual(['feeding', 'barrier']);
      expect(visual.months.filter((m) => m.limited).map((m) => m.label)).toEqual(['Jun', 'Jul', 'Aug', 'Sep']);
      expect(visual.limitLabel).toBe('Local summer limits on nitrogen and phosphorus');
      for (const m of visual.months) {
        for (const step of [...m.main, ...m.asNeeded]) expect(visual.labels[step]).toEqual(expect.any(String));
        expect(m.main.filter((step) => m.asNeeded.includes(step))).toEqual([]);
      }
      // The month chips are the same steps.
      const chips = section(await build(ST_AUG_ESTIMATE, { month: 10 }), 'season_focus').visual.items;
      expect(chips.filter((c) => c.tier === 'main').map((c) => c.key)).toEqual(byMonth.Oct.main);
      expect(chips.filter((c) => c.tier === 'as_needed').map((c) => c.key)).toEqual(byMonth.Oct.asNeeded);
    });
  });

  test('a lawn with no program (bahia) draws an empty year and no chips', async () => {
    await withGates(BOTH, async () => {
      const result = await build(estimateWith(formLawn('bahia')), { month: 10 });
      expect(section(result, 'program_year').visual.months.every((m) => !m.main.length && !m.asNeeded.length)).toBe(true);
      expect(section(result, 'season_focus').visual.items).toEqual([]);
    });
  });

  test.each(MONTHS)('month %i: the season text is the lawn report\'s own "why now" text', async (month) => {
    await withGates(BOTH, async () => {
      const result = await build(ST_AUG_ESTIMATE, { month });
      const season = section(result, 'season_focus');
      expect(season.title).toBe(`${MONTH_ABBR[month - 1]} Service Focus`);
      expect(season.body).toBe(PROGRAM_DETAIL_V13[month].whyNow);
      expect(season.bullets.length).toBeGreaterThan(0);
    });
  });

  test('every outline the program covers passes validation and the customer-copy checks', async () => {
    await withGates(BOTH, async () => {
      for (const grass of ['st_augustine', 'bermuda', 'zoysia', 'mixed', 'unknown']) {
        for (const month of MONTHS) {
          const result = await build(estimateWith(formLawn(grass)), { month });
          expect(result.validation).toEqual({ status: 'passed', errors: [], warnings: [] });
          const drawnTexts = (v) => [v?.note, v?.limitLabel, ...Object.values(v?.labels || {}), ...(v?.items || []).flatMap((i) => (typeof i === 'string' ? [i] : [i.title, i.text, i.label]))];
          const texts = [result.content.title, result.content.intro, result.content.property.programLabel, ...result.content.sections.flatMap((s) => [s.title, s.body, ...s.bullets, ...drawnTexts(s.visual)])].filter(Boolean);
          for (const text of texts) {
            expect(findBannedCustomerCopy(text)).toEqual([]);
            expect(validateCustomerCopy(text)).toBe(true);
          }
        }
      }
    });
  });
});

describe('the month bullets cover every v13 line', () => {
  const stepsOf = (visit) => [visit, ...Object.values(visit.cadenceVariants || {})];
  const linesOf = (step) => `${step.primary || ''}\n${step.secondary || ''}`.split('\n').map((l) => l.trim()).filter(Boolean);
  const productNames = new Set();
  for (const track of Object.values(v13)) {
    for (const visit of track.visits) {
      for (const step of stepsOf(visit)) for (const line of linesOf(step)) if (line.includes(' — ')) productNames.add(line.split(' — ')[0]);
    }
  }

  test('every line of every track, each plan size included, names a category', async () => {
    await withGates(BOTH, async () => {
      for (const track of Object.values(v13)) {
        for (const visit of track.visits) {
          for (const step of stepsOf(visit)) {
            for (const line of linesOf(step)) {
              expect([line, outline.customerProtocolBullets({ primary: line, secondary: '' }).length]).toEqual([line, 1]);
            }
          }
        }
      }
    });
  });

  test('the lines the GATE_LAWN_V13 outline drops reach their categories', async () => {
    await withGates(BOTH, async () => {
      const categoryOf = (name) => {
        const line = Object.values(v13).flatMap((t) => t.visits).flatMap(stepsOf).flatMap(linesOf).find((l) => l.startsWith(name));
        return categoriesOf(outline.customerProtocolBullets({ primary: line, secondary: '' }))[0];
      };
      expect(categoryOf('LESCO 44-0-0')).toBe('Fertilizer and nutrition');
      expect(categoryOf('Headway Fungicide')).toBe('Disease control');
      expect(categoryOf('Advion Insect Granule')).toBe('Insect control');
      expect(categoryOf('Topchoice Granular Insecticide')).toBe('Insect control');
    });
    await withGates({ GATE_LAWN_V13: 'true' }, async () => {
      const april = v13.st_augustine.visits.find((v) => v.month === 'Apr');
      expect(categoriesOf(outline.customerProtocolBullets(april))).not.toContain('Fertilizer and nutrition');
    });
  });

  test('April lists the 12x bag and the 9x pre-emergent bag', async () => {
    await withGates(BOTH, async () => {
      const result = await build(ST_AUG_ESTIMATE, { month: 4 });
      expect(categoriesOf(section(result, 'season_focus').bullets)).toEqual(expect.arrayContaining([
        'Fertilizer and nutrition',
        'Pre-emergent weed control with fertilizer',
        'Disease control',
        'Insect control',
      ]));
    });
  });

  test('no product name, number or rate reaches a bullet, and add-on steps never do', async () => {
    const aprilBullets = async (gates) => withGates(gates, async () => section(await build(ST_AUG_ESTIMATE, { month: 4 }), 'season_focus').bullets);
    expect(await aprilBullets({ ...BOTH, GATE_LAWN_BERMUDA_REMOVAL: 'true' })).toEqual(await aprilBullets(BOTH));
    await withGates({ ...BOTH, GATE_LAWN_BERMUDA_REMOVAL: 'true' }, async () => {
      for (const grass of ['st_augustine', 'bermuda', 'zoysia']) {
        for (const month of MONTHS) {
          const bullets = section(await build(estimateWith(formLawn(grass)), { month }), 'season_focus').bullets;
          for (const bullet of bullets) {
            expect(bullet).not.toMatch(/\d/);
            for (const name of productNames) {
              const words = name.toLowerCase().split(/\s+/);
              const needle = words[0] === 'lesco' ? name.toLowerCase() : words[0];
              expect(bullet.toLowerCase()).not.toContain(needle);
            }
          }
        }
      }
    });
  });
});
