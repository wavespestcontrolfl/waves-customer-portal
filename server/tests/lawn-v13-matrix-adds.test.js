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

describe('1. mole crickets: Talak 1.0 fl oz on nymph areas in July and August', () => {
  test.each([7, 8])('month %i names the nymph rate, the backpack and the water-in', (month) => {
    const [line] = lineFor(month, N.TAL).filter((l) => /mole cricket/.test(l));
    expect(line).toMatch(/mole cricket nymph areas/);
    expect(line).toMatch(/1\.0 fl oz per 1,000 sq ft/);
    expect(line).toMatch(/backpack/);
    expect(line).toMatch(/water in at once with up to 0\.5 in/);
  });
  test('the other months carry no mole cricket Talak line, and Dylox stays on spreader visits', () => {
    for (const month of [1, 2, 3, 4, 5, 6, 9, 10, 11, 12]) expect(lineFor(month, N.TAL).filter((l) => /mole cricket/.test(l))).toEqual([]);
    expect(lineFor(10, N.DYL)[0]).toMatch(/spreader visit only, water in/);
  });
  test('the 24-hour bifenthrin hold names its one exception', () => {
    expect(v13.st_augustine.safety_rules.join(' ')).toMatch(/delay watering 24 hours, except mole cricket nymph spots/);
  });
});

describe('2. take-all: the second pass of each Artavia pair is Headway', () => {
  test('spring pair Mar (Artavia) then Apr (Headway); fall pair Sep (Artavia) then Oct (Headway)', () => {
    expect(lineFor(3, N.ART)[0]).toMatch(/take-all areas, first spring application/);
    expect(lineFor(4, matrix.HEAD)[0]).toMatch(/take-all areas, second spring application, 3 fl oz per 1,000 sq ft in 2 to 4 gal of water, 28 days after the first/);
    expect(lineFor(4, N.ART)).toEqual([]);
    expect(lineFor(9, N.ART)[0]).toMatch(/take-all areas, first fall application/);
    expect(lineFor(10, matrix.HEAD)[0]).toMatch(/take-all areas, second fall application, 3 fl oz per 1,000 sq ft/);
    // October's Artavia line is large patch only now.
    expect(lineFor(10, N.ART)[0]).toBe(`${N.ART} — mapped large patch with Velista at 2 gal per 1,000 sq ft`);
  });
  test('Headway rate is the Headway liquid label (EPA 100-1216): 3 fl oz, 28 days, so no "label rate to confirm" mark', () => {
    const headway = matrix.CATALOG.find((p) => p.name === matrix.HEAD);
    expect(headway).toMatchObject({ epa_reg_number: '100-1216', default_rate_per_1000: 3, max_label_rate_per_1000: 3, max_annual_per_1000: 23.75 });
    // Two Headway passes a year (3 fl oz each) stay far under the label's 23.75 fl oz per 1,000 sq ft a year.
    expect(2 * 3).toBeLessThan(headway.max_annual_per_1000);
    expect(JSON.stringify(v13)).not.toMatch(/label rate to confirm/);
  });
  test('the notes keep the pair as the one named group 11 exception (Headway still carries the azoxystrobin)', () => {
    const notes = v13.st_augustine.notes.join(' ');
    expect(notes).toMatch(/Take-all: Artavia first, then Headway 28 days later/);
    expect(notes).toMatch(/planned take-all pair: Headway adds propiconazole \(group 3\) to the same azoxystrobin \(group 11\), so group 11 repeats once and this is the named take-all exception/);
    expect(notes).toMatch(/and the take-all pair \(Artavia, then Headway 28 days later, or Artavia twice; both recorded for take-all\)/);
  });
});

describe('1b. Talak on mole crickets: a frozen water-in replaces the 24-hour hold for that use only', () => {
  const { approvedReportProductFacts, withApplicationWaterIn, withApplicationHold } = require('../services/service-report/report-data');
  const { freezeReportProductFacts } = require('../services/complete-scheduled-service');
  const talak = { id: '7f1e2d3c-0000-4000-8000-0000000000aa', name: N.TAL, category: 'insecticide', epa_reg_number: '91234-145', active: true,
    label_verified_at: new Date(), approved_for_service_report: true, content_status: 'approved', customer_visibility: 'public',
    post_application_watering: { mode: 'hold', hold_hours: 24, source: 'label', label_note: 'Label: delay watering 24 hours.' } };
  const base = () => approvedReportProductFacts(talak);

  test('the row gate is on the July and August Talak rows, 0.5 inch', () => {
    expect(matrix.MOLE_CRICKET_WATER_IN).toBe(0.5);
    expect(matrix.INSERTS.find((s) => s.name === N.TAL && s.windowKey === matrix.WINDOWS.AUG).gates).toEqual({ trigger: 'mole_cricket_nymphs', moleCricketWaterInInches: 0.5 });
    expect(matrix.UPDATES.find((u) => u.windowKey === matrix.WINDOWS.JUL).gates.moleCricketWaterInInches).toBe(0.5);
  });

  test('a mole cricket target freezes the water-in; every other target, or none, keeps the product\'s hold as it was', () => {
    const facts = base();
    expect(facts.wateringRule).toMatchObject({ mode: 'hold', hold_hours: 24 });
    const wet = withApplicationWaterIn(facts, { inches: 0.5, targets: ['Mole crickets'] });
    expect(wet.wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.5, water_in_by_hours: 1, source: 'label' });
    expect(wet.wateringRule.label_note).toBe('Label: water in right after application with up to 0.5 inch of water (mole cricket use).');
    expect(wet.mowHoldDays).toBeNull();
    for (const targets of [['Mole cricket nymphs'], ['mole-crickets'], ['Chinch bugs', 'Mole crickets']]) {
      expect(withApplicationWaterIn(facts, { inches: 0.5, targets }).wateringRule.mode).toBe('water_in');
    }
    for (const targets of [undefined, [], ['Chinch bugs'], ['Armyworms'], ['White grubs']]) expect(withApplicationWaterIn(facts, { inches: 0.5, targets })).toBe(facts);
    expect(withApplicationWaterIn(facts, { targets: ['Mole crickets'] })).toBe(facts);
    expect(withApplicationWaterIn(facts, { inches: 0, targets: ['Mole crickets'] })).toBe(facts);
    expect(withApplicationWaterIn(null, { inches: 0.5, targets: ['Mole crickets'] })).toBeNull();
  });

  test('the completion freeze applies the applied row gate and the use target', () => {
    const catalogById = new Map([[talak.id, talak]]);
    const row = (gates) => ({ protocol: { structured: { products: [{ productId: talak.id, gates }] } } });
    const frozen = (submitted, plan) => freezeReportProductFacts({ productIds: [talak.id], submitted, catalogById, plan })[talak.id];
    const gated = row({ trigger: 'mole_cricket_nymphs', moleCricketWaterInInches: 0.5 });
    expect(frozen([{ productId: talak.id, targets: ['Mole crickets'] }], gated).wateringRule).toMatchObject({ mode: 'water_in', water_in_inches: 0.5 });
    // Chinch bugs, caterpillars, no target: the catalog's 24-hour hold, unchanged.
    for (const targets of [['Chinch bugs'], ['Caterpillars'], undefined]) expect(frozen([{ productId: talak.id, targets }], gated).wateringRule).toMatchObject({ mode: 'hold', hold_hours: 24 });
    // A plan whose row has no gate (another month, an older plan) leaves a mole cricket use on the hold.
    expect(frozen([{ productId: talak.id, targets: ['Mole crickets'] }], row({ trigger: 'x' })).wateringRule).toMatchObject({ mode: 'hold', hold_hours: 24 });
    // The Acelepryn caterpillar hold keeps working beside it: it only fills a silent catalog rule.
    const silent = { ...talak, post_application_watering: null };
    const acel = withApplicationHold(approvedReportProductFacts(silent), { hours: 24, targets: ['caterpillars'] });
    expect(withApplicationWaterIn(acel, { inches: 0.5, targets: ['caterpillars'] })).toBe(acel);
  });

  test('the plan note says what the gate does', () => {
    expect(engine.v13GateNotes({ moleCricketWaterInInches: 0.5 })).toEqual([{ key: 'moleCricketWaterInInches', severity: 'note', text: 'Mole cricket nymph use: water in right after application with up to 0.5 inch (label); the 24-hour hold does not apply to this use.' }]);
  });
});

describe('3. spot disease lines from the kit', () => {
  const month = (m, name) => lineFor(m, name).join('\n');
  test('Pythium root rot: Artavia, July to September plus June, 10 to 14 days, two in a row at most', () => {
    for (const m of [6, 7, 8, 9]) expect(month(m, N.ART)).toMatch(/Pythium root rot on saturated areas, 0\.77 fl oz per 1,000 sq ft every 10 to 14 days, two applications in a row at most/);
    for (const m of [1, 2, 3, 4, 5, 10, 11, 12]) expect(month(m, N.ART)).not.toMatch(/Pythium/);
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

describe('4. Arena S.E. (Florida Only) is the Arena row: same EPA number, same cap', () => {
  test('the recipe names the S.E. row everywhere and never the old name', () => {
    expect(JSON.stringify(v13)).not.toContain('Arena 50 WDG');
    for (const m of [4, 5, 6]) expect(lineFor(m, matrix.ARENA_NEW)).toHaveLength(1);
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

describe('7. Advion fire ant bait: an optional add-on in April and October (both spreader visits)', () => {
  test('a secondary line only, priced by the office, 1.5 lb per acre', () => {
    for (const m of [4, 10]) {
      const [line] = lineFor(m, matrix.ADVION);
      expect(line).toMatch(/optional add-on, office prices it/);
      expect(line).toMatch(/1\.5 lb per acre \(0\.034 lb per 1,000 sq ft\) with a hand spreader, on request only/);
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
    const gate = source.indexOf("claim.action === 'proceed' && detectServiceLine(svc?.service_type) === 'lawn' && Array.isArray(products)");
    expect(gate).toBeGreaterThan(source.indexOf('return ({ status: 422, body: internalOnlyProductsBlock });'));
    expect(source.slice(gate, gate + 700)).toContain('lawnProhibitedProductBlocks(db, products)');
    expect(source.slice(gate, gate + 900)).toContain('status: 400, body: lawnProhibitedProductsBlockPayload(prohibited)');
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

  test('the recipe says so, and no v13 line names an oxadiazon product', () => {
    expect(v13.st_augustine.safety_rules.join(' ')).toMatch(/Ronstar and other oxadiazon products: not for use on home lawns/);
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
