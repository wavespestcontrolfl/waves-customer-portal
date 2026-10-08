// Lawn protocol v13, SW Florida matrix adds (20261007180000): the recipe text, the Ronstar hard block,
// the 2027 November schedule (a note only) and the dithiopyr cap math. Synthetic data, no database.
const v13 = require('../config/lawn-protocol-v13.json');
const engine = require('../services/waveguard-plan-engine');
const staged = require('../models/migrations/20261005120000_lawn_protocol_v13_staged');
const october = require('../models/migrations/20261007120500_lawn_v13_october_dimension');
const matrix = require('../models/migrations/20261007180000_lawn_v13_matrix_adds');
const prohibited = require('../services/lawn-prohibited-products');
const featureGates = require('../config/feature-gates');

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TRACKS = Object.keys(v13);
const visitFor = (month, track = 'st_augustine') => v13[track].visits.find((v) => v.month === MONTH_ABBR[month - 1]);
const lines = (text) => String(text || '').split('\n').filter(Boolean);
const nameOf = (line) => line.split(' — ')[0];
const lineFor = (month, name) => [...lines(visitFor(month).primary), ...lines(visitFor(month).secondary)].filter((l) => nameOf(l) === name);
const N = staged.NAMES;

describe('the three tracks carry the same adds', () => {
  test('every track has the same visits, notes and safety rules', () => {
    expect(TRACKS).toEqual(['st_augustine', 'bermuda', 'zoysia']);
    for (const track of TRACKS) {
      expect(v13[track].visits).toEqual(v13.st_augustine.visits);
      expect(v13[track].notes).toEqual(v13.st_augustine.notes);
      expect(v13[track].safety_rules).toEqual(v13.st_augustine.safety_rules);
    }
  });

  test('no visit lists a product twice (the plan reads one staged row per product per window)', () => {
    for (const visit of v13.st_augustine.visits) {
      const all = [...lines(visit.primary), ...lines(visit.secondary)].filter((l) => l.includes(' — ')).map(nameOf);
      expect({ month: visit.month, dupes: all.filter((n, i) => all.indexOf(n) !== i) }).toEqual({ month: visit.month, dupes: [] });
    }
  });

  test('no new line reads as an inspection or a premium step, and none says "if"', () => {
    const added = [matrix.HEAD, matrix.ADVION, N.VEL, N.GRA];
    for (const visit of v13.st_augustine.visits) {
      for (const line of lines(visit.secondary).filter((l) => added.includes(nameOf(l)))) {
        const [parsed] = engine.parseProtocolLines(line, 'conditional', { exactName: true });
        expect({ month: visit.month, line: nameOf(line), scope: parsed.scope }).not.toMatchObject({ scope: 'INSPECTION_ONLY' });
        expect(line).not.toMatch(/\bif\b/);
      }
    }
  });
});

describe('1. mole crickets: Talak 1.0 fl oz on nymph spots in July and August, watered in by the technician', () => {
  test.each([7, 8])('month %i names the nymph rate, the backpack and the technician\'s hose water-in', (month) => {
    const [line] = lineFor(month, N.TAL).filter((l) => /mole cricket/.test(l));
    expect(line).toMatch(/mole cricket nymph spots: Talak 1\.0 fl oz per 1,000 sq ft by backpack/);
    expect(line).toMatch(/the technician waters it in right after application with the hose \(up to 0\.5 inch\) before leaving/);
  });
  test('July keeps the 24-hour customer hold on the same line; no month but July and August has a mole cricket Talak line', () => {
    expect(lineFor(7, N.TAL)[0]).toMatch(/delay watering 24 hours; mole cricket nymph spots/);
    for (const month of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12]) expect(lineFor(month, N.TAL).filter((l) => /mole cricket/.test(l))).toEqual([]);
    expect(lineFor(10, N.DYL)[0]).toMatch(/spreader visit only, water in/);
  });
  test('the notes and the safety rule keep "delay watering 24 hours" for every bifenthrin use and add the technician\'s water-in', () => {
    const track = v13.st_augustine;
    expect(track.notes.join(' ')).toContain('Bifenthrin: delay watering 24 hours on every use. Grubs and mole crickets');
    expect(track.notes.join(' ')).toMatch(/Mole cricket nymphs, July and August: Talak 7\.9 F on the spots, 1\.0 fl oz per 1,000 sq ft by backpack, and the technician waters it in right after application with the hose \(up to 0\.5 inch\) before leaving; the customer's 24-hour hold then applies/);
    expect(track.safety_rules).toContain('Bifenthrin (Atticus Talak 7.9 F): delay watering 24 hours. On mole cricket nymph spots the technician first waters it in right after application with the hose (up to 0.5 inch).');
    expect(JSON.stringify(v13)).not.toMatch(/except mole cricket|water in at once/);
  });
  test('August is a hose visit; July is a spreader visit (potash) with backpack spots: the water-in is the truck hose, never a second whole-lawn tool', () => {
    expect(visitFor(8).notes).toMatch(/Hose visit/);
    expect(visitFor(7).notes).toMatch(/Spreader visit/);
    for (const month of [7, 8]) expect(lineFor(month, N.TAL).filter((l) => /mole cricket/.test(l))[0]).toMatch(/by backpack/);
  });
});

describe('1b. no customer-report override for Talak on mole crickets (the code and the gate are gone)', () => {
  const reportData = require('../services/service-report/report-data');
  const { freezeReportProductFacts } = require('../services/complete-scheduled-service');
  const { validateRule } = require('../services/service-report/lawn-watering-rule');
  const talak = { id: '7f1e2d3c-0000-4000-8000-0000000000aa', name: N.TAL, category: 'insecticide', epa_reg_number: '91234-145', active: true,
    label_verified_at: new Date(), approved_for_service_report: true, content_status: 'approved', customer_visibility: 'public',
    post_application_watering: { mode: 'hold', hold_hours: 24, source: 'label', label_note: 'Label: delay watering 24 hours.' } };

  test('the override function and the immediate water-in flag do not exist', () => {
    expect(reportData.withApplicationWaterIn).toBeUndefined();
    expect(validateRule({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 1, water_in_immediately: true, source: 'label' }).valid).toBe(false);
  });

  test('a Talak use that records mole crickets (or no target) freezes the product\'s own 24-hour hold, gate or no gate', () => {
    const catalogById = new Map([[talak.id, talak]]);
    const plan = { protocol: { structured: { products: [{ productId: talak.id, gates: { trigger: 'mole_cricket_nymphs' } }] } } };
    for (const targets of [['Mole crickets'], [], undefined, ['Chinch bugs']]) {
      const frozen = freezeReportProductFacts({ productIds: [talak.id], submitted: [{ productId: talak.id, targets }], catalogById, plan })[talak.id];
      expect(frozen.wateringRule).toMatchObject({ mode: 'hold', hold_hours: 24 });
    }
  });

  test('migration 183000 takes the gate off the July and August Talak rows and gives them the 1.0 fl oz reference rate', () => {
    const round3 = require('../models/migrations/20261007183000_lawn_v13_matrix_adds_round3');
    expect(round3.GATE).toBe('moleCricketWaterInInches');
    expect([round3.MOLE_CRICKET_RATE, round3.MOLE_CRICKET_UNIT]).toEqual([1, 'fl oz']);
    expect([round3.HEADWAY_FRAC, round3.HEADWAY_RATE, round3.HEADWAY_UNIT]).toEqual(['3 + 11', 3, 'fl oz']);
  });
});

describe('2. take-all: the second pass of each Artavia pair is Headway', () => {
  test('spring pair Mar (Artavia) then Apr (Headway); fall pair Sep (Artavia) then Oct (Headway)', () => {
    expect(lineFor(3, N.ART)[0]).toMatch(/take-all areas, first spring application/);
    expect(lineFor(4, matrix.HEAD)[0]).toMatch(/take-all areas, second spring application, 3 fl oz per 1,000 sq ft in 2 to 4 gal of water, 30 days after the first/);
    expect(lineFor(4, N.ART)).toEqual([]);
    expect(lineFor(9, N.ART)[0]).toMatch(/take-all areas, first fall application/);
    expect(lineFor(10, matrix.HEAD)[0]).toMatch(/take-all areas, second fall application, 3 fl oz per 1,000 sq ft/);
    // October's Artavia line is large patch only now.
    expect(lineFor(10, N.ART)[0]).toBe(`${N.ART} — mapped large patch with Velista at 2 gal per 1,000 sq ft`);
  });
  test('Headway rate is the Headway liquid label (EPA 100-1216): 3 fl oz, 30 days after Artavia, so no "label rate to confirm" mark', () => {
    const headway = matrix.CATALOG.find((p) => p.name === matrix.HEAD);
    expect(headway).toMatchObject({ epa_reg_number: '100-1216', default_rate_per_1000: 3, max_label_rate_per_1000: 3, max_annual_per_1000: 23.75 });
    // Two Headway passes a year (3 fl oz each) stay far under the label's 23.75 fl oz per 1,000 sq ft a year.
    expect(2 * 3).toBeLessThan(headway.max_annual_per_1000);
    expect(JSON.stringify(v13)).not.toMatch(/label rate to confirm/);
  });
  test('Artavia then Headway is 30 days on every track (the Headway label: bermudagrass 3 fl oz per 1,000 sq ft every 30 days); no recipe text says 28 for the Headway pass', () => {
    for (const track of TRACKS) {
      const text = JSON.stringify(v13[track]);
      expect(text).not.toMatch(/Headway 28 days|Headway[^"]{0,120}28 days after the first/);
      expect(text).toMatch(/Headway 30 days later/);
      expect(text).toMatch(/limits bermudagrass to 3 fl oz per 1,000 sq ft every 30 days/);
      for (const month of [4, 10]) expect(lineFor(month, matrix.HEAD)[0]).toMatch(/30 days after the first application/);
    }
  });
  test('the notes keep the pair as the one named group 11 exception (Headway still carries the azoxystrobin)', () => {
    const notes = v13.st_augustine.notes.join(' ');
    expect(notes).toMatch(/Take-all: Artavia first, then Headway 30 days later/);
    expect(notes).toMatch(/planned take-all pair: Headway adds propiconazole \(group 3\) to the same azoxystrobin \(group 11\), so group 11 repeats once and this is the named take-all exception/);
    expect(notes).toMatch(/and the take-all pair \(Artavia, then Headway 30 days later, or Artavia twice; both recorded for take-all\)/);
  });
});

describe('3. spot disease lines from the kit', () => {
  const month = (m, name) => lineFor(m, name).join('\n');
  test('Pythium root rot: Artavia in June, July and August, 10 to 14 days, two in a row at most; September\'s Artavia is the take-all pass only', () => {
    for (const m of [6, 7, 8]) expect(month(m, N.ART)).toMatch(/Pythium root rot on saturated areas, 0\.77 fl oz per 1,000 sq ft every 10 to 14 days, two applications in a row at most/);
    for (const m of [1, 2, 3, 4, 5, 9, 10, 11, 12]) expect(month(m, N.ART)).not.toMatch(/Pythium/);
  });
  test('fairy ring: Velista April to October with a wetting agent', () => {
    for (const m of [4, 5, 6, 7, 8, 9, 10]) expect(month(m, N.VEL)).toMatch(/fairy ring, 0\.5 to 0\.7 oz per 1,000 sq ft every 14 to 21 days, with a wetting agent/);
    for (const m of [1, 2, 3, 11, 12]) expect(month(m, N.VEL)).not.toMatch(/fairy ring/);
  });
  test('dollar spot: Velista or Gravex in April to June and October to November; never Artavia', () => {
    for (const m of [4, 5, 6, 10, 11]) {
      expect(month(m, N.VEL)).toMatch(/dollar spot on bermuda and zoysia, 0\.3 to 0\.5 oz/);
      expect(month(m, N.GRA)).toMatch(/dollar spot on bermuda and zoysia, 1\.2 fl oz per 1,000 sq ft every 14 days, no more than 3 in a row/);
    }
    for (const m of [1, 2, 3, 7, 8, 9, 12]) expect(month(m, N.VEL) + month(m, N.GRA)).not.toMatch(/dollar spot/);
    for (const visit of v13.st_augustine.visits) for (const line of lineFor(MONTH_ABBR.indexOf(visit.month) + 1, N.ART)) expect(line).not.toMatch(/dollar spot/i);
  });
  test('rust on zoysia: Velista or Gravex in March to May and October to November', () => {
    for (const m of [3, 4, 5, 10, 11]) {
      expect(month(m, N.VEL)).toMatch(/rust on zoysia, 0\.3 to 0\.5 oz per 1,000 sq ft every 14 days/);
      expect(month(m, N.GRA)).toMatch(/rust on zoysia, 1\.2 fl oz per 1,000 sq ft every 14 to 28 days/);
    }
  });
  test('leaf spot or melting out on bermuda: Velista in spring and fall', () => {
    for (const m of [3, 4, 5, 9, 10, 11]) expect(month(m, N.VEL)).toMatch(/leaf spot or melting out on bermuda, 0\.3 to 0\.5 oz/);
  });
  test('they are all secondary lines: nothing here is a primary (whole-lawn) line', () => {
    for (const visit of v13.st_augustine.visits) {
      expect(lines(visit.primary).map(nameOf).filter((n) => [N.VEL, N.GRA, N.ART, matrix.HEAD, matrix.ADVION, N.TAL].includes(n))).toEqual([]);
    }
  });
});

describe('4. Arena keeps its name; SiteOne\'s Arena S.E. (Florida only) is the same product (EPA 59639-152)', () => {
  test('the recipe names "Arena 50 WDG" and says the SiteOne jug is the S.E. packaging', () => {
    expect(JSON.stringify(v13)).not.toContain('Arena S.E. 50 WDG Insecticide');
    for (const m of [4, 5, 6]) {
      const [line] = lineFor(m, matrix.ARENA_OLD);
      expect(line).toMatch(/^Arena 50 WDG \u2014 chinch bugs .* \(SiteOne: Arena S\.E\., Florida only\)$/);
    }
    expect(matrix.ARENA_EPA).toBe('59639-152');
    expect(matrix.ARENA_NEW).toBe('Arena S.E. 50 WDG Insecticide 2.5 lb. (Florida Only)');
  });
});

describe('6. July potash on the 12x plan', () => {
  test('the one whole-lawn tool is 1.0 lb of the 0-0-50 on a spreader, 0.5 lb K2O, no N or P', () => {
    const tools = lines(visitFor(7).primary).filter((l) => l.includes(' — '));
    expect(tools).toEqual([`${matrix.SOP} — 1.0 lb per 1,000 sq ft (0.5 lb K2O), spreader`]);
    const targets = engine.parseVisitNutrientTargets(visitFor(7).notes);
    expect([targets.targetNPer1000, targets.targetKPer1000]).toEqual([0, 0.5]);
    const spec = matrix.INSERTS.find((s) => s.name === matrix.SOP);
    expect([spec.rate, spec.unit, spec.mode, spec.defaultInPlan]).toEqual([1, 'lb', 'broadcast', true]);
    const catalog = matrix.CATALOG.find((p) => p.name === matrix.SOP);
    expect([catalog.analysis_n, catalog.analysis_p, catalog.analysis_k]).toEqual([0, 0, 50]);
    // 1 lb of 0-0-50 is 0.5 lb K2O and no N or P, so it is legal in the June to September blackout.
    expect(spec.rate * catalog.analysis_k / 100).toBe(0.5);
  });
  test('the inspection stays and classifies as an inspection; only the 12x plan has a July visit', () => {
    const [first] = engine.parseProtocolLines(visitFor(7).primary, 'base');
    expect(first.scope).toBe('INSPECTION_ONLY');
    const [potash] = engine.parseProtocolLines(lines(visitFor(7).primary)[1], 'base', { exactName: true });
    expect(potash.scope).not.toBe('INSPECTION_ONLY');
    // The 9x plan visits Jan Feb Apr May Jun Aug Sep Oct Dec (docs: protocol-v13 9x): no July.
    expect(['Jan', 'Feb', 'Apr', 'May', 'Jun', 'Aug', 'Sep', 'Oct', 'Dec']).not.toContain('Jul');
  });
  test('one tool per visit: spreader visits carry granulars, hose visits carry liquids', () => {
    const SPREADER_PRODUCTS = new Set([N.F24, october.NEW_NAME, matrix.SOP]);
    const HOSE_PRODUCTS = new Set([N.NT, N.STW, N.DIM, N.TET]);
    for (const [month, mode] of [[1, 'hose'], [2, 'spreader'], [3, 'hose'], [4, 'spreader'], [5, 'hose'], [6, 'hose'], [7, 'spreader'], [8, 'hose'], [9, 'hose'], [10, 'spreader'], [11, 'spreader'], [12, 'spreader']]) {
      const tools = lines(visitFor(month).primary).filter((l) => l.includes(' — ')).map(nameOf);
      for (const tool of tools) expect({ month, tool, ok: (mode === 'spreader' ? SPREADER_PRODUCTS : HOSE_PRODUCTS).has(tool) }).toEqual({ month, tool, ok: true });
    }
    // The 9x April bag stays a spreader product too.
    expect(lines(visitFor(4).cadenceVariants['9'].primary).map(nameOf)).toEqual(['LESCO Dimension 0.21% 18-0-10 50% PolyPlus OPTI45 MOP Pre-Emergent Plus Fertilizer']);
  });
});

describe('6b. July potash is a 12-visit-plan step: a 9-visit lawn with a July appointment plans no potash', () => {
  const { visitForCadence, unknownCadenceWarning } = require('../services/lawn-program');
  const wholeLawn = (visit) => lines(visit.primary).filter((l) => l.includes(' \u2014 ')).map(nameOf);

  test('the July visit carries a scout-only 9x variant on every track', () => {
    for (const track of TRACKS) {
      const july = v13[track].visits.find((v) => v.month === 'Jul');
      expect(july.cadenceVariants).toEqual({ 9: {
        primary: 'Scout visit: inspect the whole lawn and treat spots only',
        notes: 'N rate: 0 lb N. No whole-lawn tool this month: inspect the whole lawn and treat spots only. No N or P from June 1 through September 30.',
        goal: 'No whole-lawn tool on the 9-visit plan: inspect the lawn and treat spots only.',
      } });
      // The 9x notes carry no K rate and no spreader wording; the engine reads no nutrient target from them.
      expect(july.cadenceVariants[9].notes).not.toMatch(/K rate|[Ss]preader/);
      expect(engine.parseVisitNutrientTargets(july.cadenceVariants[9].notes)).toEqual({ targetNPer1000: 0, targetKPer1000: null });
    }
    expect(visitFor(7).notes).toMatch(/if a 9-visit lawn has one, it keeps the scout step with no potash/);
  });

  test('12 visits a year: the 0-0-50; 9 visits: no whole-lawn product; the plan engine reads the step the same way', () => {
    const july = visitFor(7);
    expect(wholeLawn(visitForCadence(july, 12).visit)).toEqual([matrix.SOP]);
    const nine = visitForCadence(july, 9);
    expect(nine.branch).toBe('9');
    // The variant overrides the notes and states the goal; the 12x visit and an unknown plan keep the 12x notes.
    expect(nine.visit.notes).toBe(july.cadenceVariants[9].notes);
    expect(nine.visit.goal).toBe(july.cadenceVariants[9].goal);
    expect(visitForCadence(july, 12).visit.notes).toBe(july.notes);
    expect(visitForCadence(july, 12).visit.notes).toMatch(/K rate: 0\.5 lb K\. Spreader visit/);
    expect(visitForCadence(july, 12).visit.goal).toBeUndefined();
    expect(visitForCadence(july, null).visit.notes).toBe(july.notes);
    // April's variant states neither: the 9x April keeps its notes.
    expect(visitForCadence(visitFor(4), 9).visit.notes).toBe(visitFor(4).notes);
    expect(wholeLawn(nine.visit)).toEqual([]);
    expect(nine.visit.primary).not.toMatch(/0-0-50/);
    const parsed = engine.parseProtocolLines(nine.visit.primary, 'base', { exactName: true });
    expect(parsed.map((line) => line.scope)).toEqual(['INSPECTION_ONLY']);
    // The 9x secondary lines (spot products) are the visit's own.
    expect(nine.visit.secondary).toBe(july.secondary);
  });

  test('the plan engine\'s own step picker (visitForPlan) gives a 9-visit lawn no potash and a 12-visit lawn the potash', async () => {
    const july = visitFor(7);
    const service = { id: 's', customer_id: 'c' };
    const nine = await engine.visitForPlan(null, july, service, 9);
    expect(wholeLawn(nine.visit)).toEqual([]);
    expect(nine.warnings).toEqual([]);
    const twelve = await engine.visitForPlan(null, july, service, 12);
    expect(wholeLawn(twelve.visit)).toEqual([matrix.SOP]);
  });

  test('a base line whose staged row is not a default is not selected and has no amount; conditional lines and default rows are untouched', () => {
    const catalog = [{ id: 'sop', name: matrix.SOP, aliases: [], default_rate_per_1000: 1, rate_unit: 'lb', analysis_n: 0, analysis_k: 50, cost_per_unit: 1, needs_pricing: false }];
    const items = engine.resolveProtocolItems(engine.parseProtocolLines(visitFor(7).primary, 'base', { exactName: true }), catalog, {}, {});
    const sop = items.find((item) => item.product?.id === 'sop');
    expect(sop.selected).toBe(true);
    const row = (defaultInPlan) => new Map([['sop', { productId: 'sop', defaultInPlan, applicationMode: 'broadcast', ratePer1000: 1, rateUnit: 'lb', gates: {} }]]);
    // Default row (the normal 12x July): selected, calculated.
    const normal = engine.suppressNonDefaultBaseProducts(items, row(true));
    expect(normal.find((item) => item.product?.id === 'sop').selected).toBe(true);
    expect(engine.v13LineState(sop.product, row(true), new Set(), {}, sop).state).toBe('calculate');
    // Not a default (the July window kept its scout form): not selected, state not_default, no quantity.
    const suppressed = engine.suppressNonDefaultBaseProducts(items, row(false));
    expect(suppressed.find((item) => item.product?.id === 'sop')).toMatchObject({ selected: false, selectionReason: 'staged_row_not_default' });
    expect(engine.v13LineState(sop.product, row(false), new Set(), {}, sop).state).toBe('not_default');
    expect(engine.v13HoldWarnings(suppressed).map((warning) => warning.code)).toEqual(['lawn_v13_row_not_default']);
    // An optional row is a conditional line, never base: a non-default row does not unselect it.
    const conditional = { ...sop, role: 'conditional', selected: true };
    expect(engine.suppressNonDefaultBaseProducts([conditional], row(false))[0].selected).toBe(true);
    expect(engine.v13LineState(sop.product, row(false), new Set(), {}, conditional).state).toBe('calculate');
    // A row with no stated default (older fixtures) is not suppressed.
    expect(engine.suppressNonDefaultBaseProducts(items, new Map([['sop', { productId: 'sop' }]])).find((item) => item.product?.id === 'sop').selected).toBe(true);
  });

  test('a lawn whose plan is not on file keeps the 12x step and the warning says there is no product on the 9x step', () => {
    const unknown = visitForCadence(visitFor(7), null);
    expect(wholeLawn(unknown.visit)).toEqual([matrix.SOP]);
    expect(unknown.unknownCadence).toEqual({ variantProducts: [], cadences: ['9'] });
    expect(unknownCadenceWarning(unknown.unknownCadence).message).toMatch(/On a 9x plan, this visit has no whole-lawn product\.$/);
    // April still names its product.
    expect(unknownCadenceWarning(visitForCadence(visitFor(4), null).unknownCadence).message).toMatch(/use LESCO Dimension 0\.21%/);
  });
});

describe('7. Advion fire ant bait: an optional add-on in April and October (both spreader visits)', () => {
  test('a secondary line only, priced by the office, 1.5 lb per acre', () => {
    for (const m of [4, 10]) {
      const [line] = lineFor(m, matrix.ADVION);
      expect(line).toMatch(/optional add-on, office prices it/);
      expect(line).toMatch(/1\.5 lb per acre \(0\.0344 lb per 1,000 sq ft\) with a hand spreader, on request only/);
      expect(lines(visitFor(m).primary).map(nameOf)).not.toContain(matrix.ADVION);
    }
    for (const m of [1, 2, 3, 5, 6, 7, 8, 9, 11, 12]) expect(lineFor(m, matrix.ADVION)).toEqual([]);
    const spec = matrix.INSERTS.filter((s) => s.name === matrix.ADVION);
    expect(spec.map((s) => s.defaultInPlan)).toEqual([false, false]);
    expect(matrix.CATALOG.find((p) => p.name === matrix.ADVION).epa_reg_number).toBeNull();
  });
});

describe('5. Ronstar (oxadiazon) is blocked on lawns', () => {
  test.each([
    [{ name: 'Ronstar G Herbicide' }],
    [{ name: 'LESCO Ronstar 20-1-20 Fertilizer' }],
    [{ name: 'Some Pre-Emergent', active_ingredient: 'Oxadiazon 2%' }],
    [{ name: 'x', display_name: 'ronstar granular' }],
  ])('%j is blocked', (product) => {
    const block = prohibited.lawnProhibitedProductBlock(product);
    expect(block).toMatchObject({ code: 'lawn_product_not_for_home_lawns', severity: 'block' });
    expect(block.message).toMatch(/not for use on home lawns/);
  });
  test.each([['Dimension 2EW Dithiopyr 24% Pre-Emergent Liquid Herbicide'], ['LESCO Stonewall 4FL Prodiamine 40.7% Pre-Emergent Liquid Herbicide'], ['Specticle G'], [matrix.ARENA_NEW]])('%s is not blocked', (name) => {
    expect(prohibited.lawnProhibitedProductBlock({ name })).toBeNull();
  });

  test('residential lawns only: a commercial or business property is not blocked, residential and unknown are', () => {
    const ronstar = { name: 'Ronstar G' };
    // Commercial turf only: office, warehouse, retail, medical office ... HOA and multifamily common areas are residential turf (blocked).
    for (const propertyType of ['commercial', 'business', 'Commercial', ' business ', 'office', 'Office', 'warehouse', 'medical_office', 'Medical Office', 'retail', 'restaurant', 'industrial']) {
      expect({ propertyType, block: prohibited.lawnProhibitedProductBlock(ronstar, { propertyType }) }).toEqual({ propertyType, block: null });
    }
    // Residential, unknown, blank and unrecognised types fail closed.
    for (const propertyType of ['residential', 'home', 'single_family', 'Single Family', 'townhome', 'duplex', 'condo', 'mystery type', '', '  ', null, undefined]) {
      expect({ propertyType, code: prohibited.lawnProhibitedProductBlock(ronstar, { propertyType })?.code }).toEqual({ propertyType, code: 'lawn_product_not_for_home_lawns' });
    }
    expect(prohibited.isCommercialProperty('office')).toBe(true);
    expect(prohibited.isCommercialProperty('')).toBe(false);
  });

  test('the closeout check skips a commercial property without reading the catalog', async () => {
    const database = () => { throw new Error('no database read expected'); };
    expect(await prohibited.lawnProhibitedProductBlocks(database, [{ productName: 'Ronstar G' }], { propertyType: 'commercial' })).toEqual([]);
  });

  test('the closeout check reads the catalog rows of the submitted ids and any free-text name', async () => {
    const database = () => ({ whereIn: () => ({ select: async () => [{ id: 'r1', name: 'Ronstar G', active_ingredient: 'Oxadiazon' }, { id: 'd1', name: 'Dylox 6.2 G Granular Insecticide' }] }) });
    const blocks = await prohibited.lawnProhibitedProductBlocks(database, [{ productId: 'r1' }, { productId: 'd1' }, { productName: 'ronstar from the truck' }]);
    expect(blocks.map((b) => b.productName).sort()).toEqual(['Ronstar G', 'ronstar from the truck']);
    expect(await prohibited.lawnProhibitedProductBlocks(database, [])).toEqual([]);
  });

  test('a fresh lawn closeout refuses with a 400 body that names the product; the gate sits right after the internal-only products block', () => {
    const blocks = [prohibited.lawnProhibitedProductBlock({ name: 'Ronstar G' })];
    expect(prohibited.lawnProhibitedProductsBlockPayload(blocks)).toEqual({
      error: 'A product on this lawn visit is not for home lawns',
      code: 'lawn_product_not_for_home_lawns',
      details: [blocks[0].message],
      blocks,
    });
    const source = require('fs').readFileSync(require('path').join(__dirname, '../services/complete-scheduled-service.js'), 'utf8');
    const gate = source.indexOf("claim.action === 'proceed' && detectServiceLine(svc?.service_type) === 'lawn') {");
    expect(gate).toBeGreaterThan(source.indexOf('return ({ status: 422, body: internalOnlyProductsBlock });'));
    expect(source.slice(gate, gate + 700)).toContain('lawnCloseoutProhibitedBlocks(db, svc, products)');
    expect(source.slice(gate, gate + 700)).toContain('status: 400, body: lawnProhibitedProductsBlockPayload(prohibited)');
  });

  test('the closeout check runs only while GATE_LAWN_V13 is on, read at call time: gate off is the pre-v13 closeout', async () => {
    const saved = process.env.GATE_LAWN_V13;
    // A database that would answer "Ronstar" for any id, and fail the test if it is touched while the gate is off.
    const reads = [];
    const database = (table) => { reads.push(table); return { whereIn: () => ({ select: async () => [{ id: 'r1', name: 'Ronstar G', active_ingredient: 'Oxadiazon' }] }), where: () => ({ first: async () => ({ property_type: 'residential' }) }) }; };
    const svc = { property_id: 'p', customer_id: 'c', property_type: 'residential' };
    const products = [{ productId: 'r1' }, { productName: 'Ronstar G' }];
    try {
      delete process.env.GATE_LAWN_V13;
      expect(await prohibited.lawnCloseoutProhibitedBlocks(database, svc, products)).toEqual([]);
      expect(reads).toEqual([]);
      process.env.GATE_LAWN_V13 = 'false';
      expect(await prohibited.lawnCloseoutProhibitedBlocks(database, svc, products)).toEqual([]);
      process.env.GATE_LAWN_V13 = 'true';
      const on = await prohibited.lawnCloseoutProhibitedBlocks(database, svc, products);
      // (One block per product name: the id and the free-text name are both Ronstar G.)
      expect(on.map((block) => block.code)).toEqual(['lawn_product_not_for_home_lawns']);
      // Gate on, nothing listed, or a commercial property: nothing to refuse.
      expect(await prohibited.lawnCloseoutProhibitedBlocks(database, svc, [])).toEqual([]);
      expect(await prohibited.lawnCloseoutProhibitedBlocks(database, svc, undefined)).toEqual([]);
      expect(await prohibited.lawnCloseoutProhibitedBlocks(() => ({ where: () => ({ first: async () => ({ property_type: 'commercial' }) }) }), { ...svc, property_type: 'commercial' }, products)).toEqual([]);
      // Read at call time: turning it back off stops the check at once.
      delete process.env.GATE_LAWN_V13;
      expect(await prohibited.lawnCloseoutProhibitedBlocks(database, svc, products)).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = saved;
    }
  });

  test('the plan caps it: no amount is planned and the sheet shows a block with the label reason', async () => {
    const savedGate = process.env.GATE_LAWN_V13;
    process.env.GATE_LAWN_V13 = 'true';
    try {
      expect(featureGates.lawnV13Live()).toBe(true);
      const items = [{ selected: true, product: { id: 'ron', name: 'Ronstar G' } }];
      // The block returns before any database read: the knex stub must never be touched.
      const knex = () => { throw new Error('no database read expected'); };
      const found = await engine.v13VisitLimits(knex, { scheduled_date: '2026-10-07', customer_id: 'c', id: 'v' }, items, new Map());
      expect(found.capped.get('ron')).toHaveLength(1);
      expect(found.blocks).toHaveLength(1);
      expect(found.blocks[0]).toMatchObject({ code: 'lawn_v13_annual_limit', productName: 'Ronstar G' });
      expect(found.blocks[0].message).toMatch(/oxadiazon.*not for use on home lawns/);
    } finally {
      if (savedGate === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = savedGate;
    }
  });

  test('the plan lets commercial turf through (the customer\'s property_type, read when the row lacks it)', async () => {
    const savedGate = process.env.GATE_LAWN_V13;
    process.env.GATE_LAWN_V13 = 'true';
    const limits = require('../services/application-limits');
    const spy = jest.spyOn(limits, 'checkLimits').mockResolvedValue({ blocks: [], warnings: [] });
    try {
      const items = [{ selected: true, product: { id: 'ron', name: 'Ronstar G' } }];
      const visit = { scheduled_date: '2026-10-07', customer_id: 'c', id: 'v' };
      const customers = (propertyType) => () => ({ where: () => ({ first: async () => ({ property_type: propertyType }) }) });
      const run = (knex, service) => engine.v13VisitLimits(knex, service, items, new Map());
      expect((await run(customers('commercial'), visit)).capped.size).toBe(0);
      expect((await run(customers('residential'), visit)).capped.get('ron')).toHaveLength(1);
      // The plan's own row carries property_type: no read.
      const noRead = () => { throw new Error('no database read expected'); };
      expect((await run(noRead, { ...visit, property_type: 'business' })).capped.size).toBe(0);
      expect((await run(noRead, { ...visit, property_type: 'residential' })).capped.get('ron')).toHaveLength(1);
    } finally {
      spy.mockRestore();
      if (savedGate === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = savedGate;
    }
  });

  test('the treated property decides: the visit\'s linked customer_properties type first, the customer\'s as the fallback', async () => {
    const tables = ({ property, customer }) => (table) => ({ where: () => ({ first: async () => (table === 'customer_properties' ? property : customer) }) });
    const type = (stub, args) => prohibited.treatedPropertyType(stub, args);
    // A residential customer with a commercial lot linked to the visit, and the reverse.
    expect(await type(tables({ property: { property_type: 'commercial' }, customer: { property_type: 'residential' } }), { propertyId: 'p', customerId: 'c', fallback: 'residential' })).toBe('commercial');
    expect(await type(tables({ property: { property_type: 'residential' }, customer: { property_type: 'commercial' } }), { propertyId: 'p', customerId: 'c', fallback: 'commercial' })).toBe('residential');
    // A linked property is judged on its own row ONLY: a missing row, a null or empty type fail closed, however
    // commercial the account is. The account type answers only a visit with no linked property.
    for (const property of [undefined, null, { property_type: null }, { property_type: '' }, { property_type: '  ' }]) {
      expect(await type(tables({ property, customer: { property_type: 'business' } }), { propertyId: 'p', customerId: 'c', fallback: 'business' })).toBe('residential');
      expect(await type(tables({ property, customer: { property_type: 'commercial' } }), { propertyId: 'p', customerId: 'c' })).toBe('residential');
    }
    expect(await type(tables({ property: { property_type: 'business' }, customer: { property_type: 'residential' } }), { propertyId: 'p', customerId: 'c' })).toBe('business');
    // No property on the visit: the fallback, else the customer's row, else nothing; a failed read says nothing.
    expect(await type(tables({ customer: { property_type: 'residential' } }), { customerId: 'c', fallback: 'commercial' })).toBe('commercial');
    expect(await type(tables({ customer: { property_type: 'commercial' } }), { customerId: 'c' })).toBe('commercial');
    expect(await type(tables({}), {})).toBeUndefined();
  });

  test('a FAILED property read fails closed and is logged; an absent one is only absent', async () => {
    const logger = require('../services/logger');
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const broken = () => { throw new Error('boom'); };
      // The linked property read fails while the customer\'s own type is commercial: NOT the commercial answer.
      expect(await prohibited.treatedPropertyType(broken, { propertyId: 'p', customerId: 'c', fallback: 'commercial' })).toBe('residential');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('customer_properties property type read failed'));
      // The customer read fails: closed too.
      expect(await prohibited.treatedPropertyType(broken, { customerId: 'c' })).toBe('residential');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('customers property type read failed'));
      // Ronstar stays blocked on both, and commercial is still allowed when the reads succeed.
      expect(prohibited.lawnProhibitedProductBlock({ name: 'Ronstar G' }, { propertyType: 'residential' })).toMatchObject({ code: 'lawn_product_not_for_home_lawns' });
      // A missing linked row is NOT absent information: it fails closed. With no linked property, nothing on
      // file is just absent (the caller treats it as residential).
      const absent = () => ({ where: () => ({ first: async () => undefined }) });
      expect(await prohibited.treatedPropertyType(absent, { propertyId: 'p', customerId: 'c', fallback: 'commercial' })).toBe('residential');
      expect(await prohibited.treatedPropertyType(absent, { customerId: 'c' })).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });

  test('the plan blocks Ronstar when the linked property read fails, even beside a commercial customer', async () => {
    const savedGate = process.env.GATE_LAWN_V13;
    process.env.GATE_LAWN_V13 = 'true';
    const warn = jest.spyOn(require('../services/logger'), 'warn').mockImplementation(() => {});
    const spy = jest.spyOn(require('../services/application-limits'), 'checkLimits').mockResolvedValue({ blocks: [], warnings: [] });
    try {
      const items = [{ selected: true, product: { id: 'ron', name: 'Ronstar G' } }];
      const broken = () => { throw new Error('boom'); };
      const visit = { scheduled_date: '2026-10-07', customer_id: 'c', id: 'v', property_id: 'p', property_type: 'commercial' };
      expect((await engine.v13VisitLimits(broken, visit, items, new Map())).capped.get('ron')).toHaveLength(1);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
      if (savedGate === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = savedGate;
    }
  });

  test('the plan judges the linked property: commercial lot beside a residential customer passes, the reverse is blocked', async () => {
    const savedGate = process.env.GATE_LAWN_V13;
    process.env.GATE_LAWN_V13 = 'true';
    const spy = jest.spyOn(require('../services/application-limits'), 'checkLimits').mockResolvedValue({ blocks: [], warnings: [] });
    try {
      const items = [{ selected: true, product: { id: 'ron', name: 'Ronstar G' } }];
      const visit = { scheduled_date: '2026-10-07', customer_id: 'c', id: 'v', property_id: 'p', property_type: 'residential' };
      const tables = (property, customer) => (table) => ({ where: () => ({ first: async () => ({ property_type: table === 'customer_properties' ? property : customer }) }) });
      const run = (knex, service) => engine.v13VisitLimits(knex, service, items, new Map());
      expect((await run(tables('commercial', 'residential'), visit)).capped.size).toBe(0);
      expect((await run(tables('residential', 'commercial'), { ...visit, property_type: 'commercial' })).capped.get('ron')).toHaveLength(1);
    } finally {
      spy.mockRestore();
      if (savedGate === undefined) delete process.env.GATE_LAWN_V13; else process.env.GATE_LAWN_V13 = savedGate;
    }
  });

  test('the recipe says so, and no v13 line names an oxadiazon product', () => {
    const scoped = 'Ronstar / oxadiazon: never on residential home lawns (label: not for use on home lawns); commercial turf per label.';
    for (const track of TRACKS) {
      expect(v13[track].safety_rules).toContain(scoped);
      expect(v13[track].notes).toContain(scoped);
    }
    expect(JSON.stringify(v13)).not.toMatch(/Never log them on a lawn visit|Ronstar and other oxadiazon/);
    const lineNames = v13.st_augustine.visits.flatMap((v) => [...lines(v.primary), ...lines(v.secondary)]).filter((l) => l.includes(' — ')).map(nameOf);
    expect(lineNames.filter((n) => prohibited.isProhibitedOnHomeLawns({ name: n }))).toEqual([]);
  });
});

describe('8. November pre-emergent move: a 2027 note only; the 2026 visits do not change', () => {
  const note = v13.st_augustine.notes.find((n) => n.startsWith('Season 2027'));

  test('the note is clearly labeled, 12-visit plan only, from 2027-10-01', () => {
    expect(note).toMatch(/^Season 2027 \(visits from 2027-10-01\), 12-visit plan only\. This is a note and changes no 2026 visit/);
    expect(note).toMatch(/The 9-visit plan keeps the October Dimension step/);
  });

  test('2026 behavior is untouched: October Dimension 4.04 lb, November 24-0-11 3.1 lb, December 24-0-11 2.1 lb', () => {
    expect(lines(visitFor(10).primary)[0]).toBe(`${october.NEW_NAME} — 4.04 lb per 1,000 sq ft (0.73 lb N, 0.4 lb K2O), spreader`);
    expect(lines(visitFor(11).primary)[0]).toMatch(/^LESCO 24-0-11 with PolyPlus OPTI — 3\.1 lb per 1,000 sq ft/);
    expect(lines(visitFor(12).primary)[0]).toMatch(/^LESCO 24-0-11 with PolyPlus OPTI — 2\.1 lb per 1,000 sq ft/);
    expect(lines(visitFor(1).primary)[0]).toMatch(/^LESCO Stonewall 4FL/);
  });

  test('N per application and per year: Oct 0.60, Nov 0.73, Dec 0.75, under 1 lb each and under the 4 lb ordinance cap', () => {
    const oct = 2.5 * 0.24;
    const nov = 4.04 * 0.18;
    const dec = 3.1 * 0.24;
    expect([oct, nov, dec].map((n) => Math.round(n * 100) / 100)).toEqual([0.6, 0.73, 0.74]);
    expect(note).toMatch(/October LESCO 24-0-11 with PolyPlus OPTI at 2\.5 lb per 1,000 sq ft \(0\.60 lb N\)/);
    expect(note).toMatch(/November LESCO Dimension 0\.21% 18-0-10 at 4\.04 lb per 1,000 sq ft \(0\.73 lb N, 0\.37 lb dithiopyr per acre/);
    expect(note).toMatch(/December LESCO 24-0-11 with PolyPlus OPTI at 3\.1 lb per 1,000 sq ft \(0\.75 lb N\)/);
    for (const n of [oct, nov, dec]) expect(n).toBeLessThanOrEqual(1);
    // Feb 0.75 + Apr 0.5 + Oct 0.6 + Nov 0.73 + Dec 0.75 = 3.33 lb N a year.
    expect(0.75 + 0.5 + 0.6 + 0.73 + 0.75).toBeCloseTo(3.33, 2);
    expect(0.75 + 0.5 + 0.6 + 0.73 + 0.75).toBeLessThan(4);
  });

  test('dithiopyr stays under 1.5 lb ai per acre: March and June 2EW 0.5 fl oz each plus the November bag at 4.04 lb', () => {
    const { CAP_GRANULAR, CAP_2EW } = october;
    const share = 2 * (0.5 / CAP_2EW.limit_value) + 4.04 / CAP_GRANULAR.limit_value;
    expect(Math.round(share * 1000) / 10).toBe(70);
    const aiPerAcre = 2 * (0.5 * (2 / 128) * 43.56) + 4.04 * 0.0021 * 43.56;
    expect(aiPerAcre).toBeCloseTo(1.05, 2);
    expect(aiPerAcre).toBeLessThan(1.5);
    // The bag stays under the per-application maximum and its 3 a year; the gaps (Jun to Nov 5 months,
    // Nov to the next March 4 months) are over the 60-day minimum between applications.
    expect(4.04).toBeLessThan(october.MAX_LABEL);
    expect(october.PRODUCT_LIMITS.find((l) => l.limit_type === 'min_interval_days').limit_value).toBeLessThan(4 * 28);
  });

  test('the 2027 schedule keeps January\'s Stonewall hose visit', () => {
    expect(note).toMatch(/January Stonewall 4FL stays/);
  });
});

describe('Ronstar home-lawn block: turf use, not the pricing class', () => {
  const { lawnProhibitedProductBlock } = require('../services/lawn-prohibited-products');
  const ronstar = { name: 'Ronstar G' };
  test.each(['office', 'warehouse', 'medical_office', 'commercial', 'Retail'])('%s turf is commercial: allowed', (propertyType) => {
    expect(lawnProhibitedProductBlock(ronstar, { propertyType })).toBeNull();
  });
  test.each([
    'hoa_common_area_residential', 'multifamily_common_area_residential', 'residential_hoa',
    'residential_common_area', 'apartment', 'residential', '', null, undefined,
  ])('%s turf stays blocked', (propertyType) => {
    expect(lawnProhibitedProductBlock(ronstar, { propertyType })).toEqual(expect.objectContaining({ code: 'lawn_product_not_for_home_lawns' }));
  });
});
