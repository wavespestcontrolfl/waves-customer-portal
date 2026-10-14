'use strict';

// The target of a spot fungicide / insecticide row on the lawn Fast Complete sheet (lawn-spot-target.js): the closed lists, the
// agreement with the trouble-area type, the completion resolver, and the effect on the customer's "What to expect" rows
// through the real builders. Synthetic data only.

const spotTarget = require('../services/lawn-spot-target');
const { TARGET_CLASS_BY_NAME } = require('../config/lawn-expectations');
const { LAWN_TARGET_SUGGESTIONS } = require('../config/treatment-target-vocabulary');
const { troubleTypeFor } = require('../services/lawn-trouble-areas');
const { buildLawnExpectations } = require('../services/service-report/lawn-expectations');
const reportFacts = require('../services/service-report/lawn-report-facts');

const ARENA = 'aaaaaaaa-0000-4000-8000-000000000001';
const TALAK = 'aaaaaaaa-0000-4000-8000-000000000002';
const ARTAVIA = 'aaaaaaaa-0000-4000-8000-000000000003';
const TAKE_ALL = 'aaaaaaaa-0000-4000-8000-000000000004';
const CELSIUS = 'aaaaaaaa-0000-4000-8000-000000000005';
const IRON = 'aaaaaaaa-0000-4000-8000-000000000006';

const CATALOG = new Map([
  [ARENA, { id: ARENA, name: 'Arena 50 WDG', category: 'insecticide' }],
  [TALAK, { id: TALAK, name: 'Atticus Talak 7.9 F', category: 'insecticide' }],
  [ARTAVIA, { id: ARTAVIA, name: 'Artavia 2 SC (Azoxy)', category: 'fungicide' }],
  [TAKE_ALL, { id: TAKE_ALL, name: 'Velista', category: 'fungicide' }],
  [CELSIUS, { id: CELSIUS, name: 'Celsius WG', category: 'herbicide' }],
  [IRON, { id: IRON, name: 'Iron Plus', category: 'micronutrient' }],
]);
const SETS = () => ({ takeAll: new Set([TAKE_ALL]), chinch: new Set([ARENA, TALAK]), chinchOnly: new Set([ARENA]) });
const methodByRow = (row) => row.method || 'spot_treatment';
const resolve = (rows, over = {}) => spotTarget.resolveForCompletion({
  rows,
  lawnFast: { visitType: 'recurring' },
  catalog: CATALOG,
  canonicalId: (id) => String(id).toLowerCase(),
  inferMethod: (product, row) => methodByRow(row),
  serviceLine: 'lawn',
  confirm: async () => SETS(),
  live: () => true,
  ...over,
});

describe('the closed lists', () => {
  test('every name is on the expectations engine table and the picker vocabulary, in its own family', () => {
    for (const name of [...spotTarget.FUNGICIDE_NAMES, ...spotTarget.INSECTICIDE_NAMES]) {
      expect(LAWN_TARGET_SUGGESTIONS).toContain(name);
      expect(TARGET_CLASS_BY_NAME[name]).toBeTruthy();
    }
    for (const name of spotTarget.FUNGICIDE_NAMES) expect(TARGET_CLASS_BY_NAME[name].family).toBe('fungicide');
    for (const name of spotTarget.INSECTICIDE_NAMES) expect(TARGET_CLASS_BY_NAME[name].family).toBe('insecticide');
    // Weeds and nematodes have no curative row: never offered on these rows.
    expect(spotTarget.FUNGICIDE_NAMES).not.toContain('Dollarweed');
    expect(spotTarget.INSECTICIDE_NAMES).not.toContain('Nematodes');
  });

  test('every name stands for exactly one trouble-area type, and the chinch and take-all names are the typed ones', () => {
    for (const name of spotTarget.FUNGICIDE_NAMES) expect(['fungus', 'take_all']).toContain(spotTarget.typeOfTarget(name));
    for (const name of spotTarget.INSECTICIDE_NAMES) expect(['other_insect', 'chinch']).toContain(spotTarget.typeOfTarget(name));
    expect(spotTarget.typeOfTarget(spotTarget.CHINCH_TARGET)).toBe('chinch');
    expect(spotTarget.typeOfTarget(spotTarget.TAKE_ALL_TARGET)).toBe('take_all');
    expect(spotTarget.typeOfTarget('Dollar spot')).toBe('fungus');
    expect(spotTarget.typeOfTarget('Fall armyworms')).toBe('other_insect');
    expect(spotTarget.typeOfTarget('Crabgrass')).toBeNull();
  });

  test('the context block carries the lists and the two typed names', () => {
    const block = spotTarget.contextBlock();
    expect(block).toMatchObject({ v: 1, chinch: 'Southern chinch bugs', takeAll: 'Take-all root rot' });
    expect(block.fungicide).toEqual(spotTarget.FUNGICIDE_NAMES);
    expect(block.insecticide).toEqual(spotTarget.INSECTICIDE_NAMES);
  });
});

describe('targetsFor agrees with the type', () => {
  test.each([
    ['insecticide', 'chinch', undefined, ['Southern chinch bugs']],
    ['insecticide', 'chinch', 'White grubs', ['Southern chinch bugs']],
    ['insecticide', 'other_insect', 'Fall armyworms', ['Fall armyworms']],
    ['insecticide', 'other_insect', 'Southern chinch bugs', []],
    ['insecticide', 'other_insect', 'Dollar spot', []],
    ['insecticide', 'other_insect', 'free text', []],
    ['fungicide', 'fungus', 'Dollar spot', ['Dollar spot']],
    ['fungicide', 'fungus', 'Take-all root rot', []],
    ['fungicide', 'fungus', 'Fall armyworms', []],
    ['fungicide', 'take_all', 'Take-all root rot', ['Take-all root rot']],
    ['fungicide', 'take_all', 'Dollar spot', []],
    ['fungicide', 'take_all', undefined, []],
    ['fungicide', null, 'Dollar spot', []],
    ['herbicide', 'weeds', 'Crabgrass', []],
    ['micronutrient', null, 'Dollar spot', []],
  ])('%s %s requested %s -> %j', (category, type, requested, expected) => {
    expect(spotTarget.targetsFor({ category, type, requested })).toEqual(expected);
  });
});

describe('resolveForCompletion', () => {
  const row = (productId, extra = {}) => ({ productId, method: 'spot_treatment', targets: [], ...extra });

  test('a chinch-only rung gets the chinch target with no tap; the server decides, not the sheet', async () => {
    const out = await resolve([row(ARENA, { troubleType: 'fungus', targets: ['Dollar spot'] })]);
    expect(out.of(row(ARENA))).toEqual(['Southern chinch bugs']);
  });

  test('a shared rung is chinch only when the chinch entry opened it (the sheet hint) AND the ladder confirms it', async () => {
    expect(
      (await resolve([row(TALAK, { targetFind: 'chinch' })])).of(row(TALAK)),
    ).toEqual(['Southern chinch bugs']);
    expect((await resolve([row(TALAK, { troubleType: 'chinch' })])).of(row(TALAK))).toEqual(['Southern chinch bugs']);
    // No find: Talak is also the caterpillar product, so it is no chinch tag and the tap alone cannot make one.
    expect((await resolve([row(TALAK, { targets: ['Southern chinch bugs'] })])).of(row(TALAK))).toEqual([]);
    expect((await resolve([row(TALAK, { targets: ['Fall armyworms'] })])).of(row(TALAK))).toEqual(['Fall armyworms']);
  });

  test('the standing Found tap: a shared rung already on the sheet is a chinch find from the submitted guide record, with the same ladder confirmation', async () => {
    const found = (productIds, extra = {}) => ({ visitType: 'recurring', treatmentGuide: { v: 1, cards: [{ kind: 'chinch', shown: true, checked: 'found', taken: true, productIds, ...extra }] } });
    const talak = row(TALAK);
    expect((await resolve([talak], { lawnFast: found([TALAK]) })).of(talak)).toEqual(['Southern chinch bugs']);
    // The record is matched by id, case-insensitively, and only a find that was taken.
    expect((await resolve([talak], { lawnFast: found([TALAK.toUpperCase()]) })).of(talak)).toEqual(['Southern chinch bugs']);
    expect((await resolve([talak], { lawnFast: found([TALAK], { taken: false }) })).of(talak)).toEqual([]);
    expect((await resolve([talak], { lawnFast: found([TALAK], { checked: 'none' }) })).of(talak)).toEqual([]);
    expect((await resolve([talak], { lawnFast: found([ARENA]) })).of(talak)).toEqual([]);
    expect((await resolve([talak], { lawnFast: { visitType: 'recurring', treatmentGuide: { v: 2, cards: found([TALAK]).treatmentGuide.cards } } })).of(talak)).toEqual([]);
    // Not a chinch card, or a product the ladder does not confirm: no chinch tag.
    const fung = { v: 1, cards: [{ kind: 'fungus', shown: true, checked: 'found', taken: true, productIds: [TALAK] }] };
    expect((await resolve([talak], { lawnFast: { visitType: 'recurring', treatmentGuide: fung } })).of(talak)).toEqual([]);
    const art = row(ARTAVIA);
    expect((await resolve([art], { lawnFast: found([ARTAVIA]) })).of(art)).toEqual([]);
    // Still only for a spot row, and a read that fails stores nothing.
    const moved = row(TALAK, { method: 'broadcast_spray' });
    expect((await resolve([moved], { lawnFast: found([TALAK]) })).of(moved)).toEqual([]);
    expect((await resolve([talak], { lawnFast: found([TALAK]), confirm: async () => { throw new Error('down'); } })).of(talak)).toEqual([]);
  });

  test('a hint for a product the ladder does not confirm makes no chinch tag', async () => {
    const out = await resolve([row(ARTAVIA, { targetFind: 'chinch', troubleType: 'chinch', targets: ['Dollar spot'] })]);
    expect(out.of(row(ARTAVIA))).toEqual(['Dollar spot']);
  });

  test('a spot fungicide takes a fungicide name; the month take-all product only the take-all name', async () => {
    expect((await resolve([row(ARTAVIA, { targets: ['Large patch'] })])).of(row(ARTAVIA))).toEqual(['Large patch']);
    expect((await resolve([row(ARTAVIA)])).of(row(ARTAVIA))).toEqual([]);
    expect((await resolve([row(TAKE_ALL, { targets: ['Dollar spot'] })])).of(row(TAKE_ALL))).toEqual([]);
    expect((await resolve([row(TAKE_ALL, { targets: ['Take-all root rot'] })])).of(row(TAKE_ALL))).toEqual(['Take-all root rot']);
  });

  test('a whole-lawn row never carries a target; another category is left to the main flow', async () => {
    const broadcast = row(ARTAVIA, { method: 'broadcast_spray', targets: ['Dollar spot'] });
    expect((await resolve([broadcast])).of(broadcast)).toEqual([]);
    const herb = row(CELSIUS, { targets: ['Crabgrass'] });
    expect((await resolve([herb])).of(herb)).toEqual(['Crabgrass']);
    const iron = row(IRON, { targets: [] });
    expect((await resolve([iron])).of(iron)).toEqual([]);
  });

  test('a fungicide or insecticide row the SERVER does not resolve as a spot row stores no target, whatever the sheet sent', async () => {
    const moved = row(ARTAVIA, { method: 'broadcast_spray', targets: ['Dollar spot'], targetFind: 'chinch', troubleType: 'chinch' });
    const movedInsect = row(ARENA, { method: 'granular_broadcast', targets: ['Southern chinch bugs'], targetFind: 'chinch' });
    const spot = row(TALAK, { targets: ['Fall armyworms'] });
    const out = await resolve([moved, movedInsect, spot]);
    expect(out.of(moved)).toEqual([]);
    expect(out.of(movedInsect)).toEqual([]);
    expect(out.of(spot)).toEqual(['Fall armyworms']);
  });

  test('the method is the one persistence resolves (the completion\'s own inference), not the sheet\'s word', async () => {
    const seen = [];
    const out = await resolve([row(ARTAVIA, { method: 'spot_treatment', applicationMethod: 'broadcast_spray', targets: ['Dollar spot'] })], {
      inferMethod: (product, r, line) => { seen.push([product.name, line]); return r.applicationMethod; },
    });
    expect(out.of({ productId: ARTAVIA })).toEqual([]);
    expect(seen).toEqual([['Artavia 2 SC (Azoxy)', 'lawn']]);
  });

  test('a target of another family than the row\'s product (the product changed under the pick) is dropped', async () => {
    const swapped = row(ARTAVIA, { targets: ['White grubs'] });
    expect((await resolve([swapped])).of(swapped)).toEqual([]);
    const swapped2 = row(TALAK, { targets: ['Dollar spot'] });
    expect((await resolve([swapped2])).of(swapped2)).toEqual([]);
  });

  test('no lawnFast block (the full form, other sheets): the row keeps its own tags, gate on or off', async () => {
    const tagged = row(ARTAVIA, { targets: ['Dollar spot'] });
    expect((await resolve([tagged], { lawnFast: null })).of(tagged)).toEqual(['Dollar spot']);
    expect((await resolve([tagged], { lawnFast: null, live: () => false })).of(tagged)).toEqual(['Dollar spot']);
  });

  test('a lawnFast completion with the gate off (a stale sheet loaded while it was on) stores no target, ignores targetFind, reads nothing, and is not refused', async () => {
    const confirm = jest.fn();
    const rows = [row(ARTAVIA, { targets: ['Dollar spot'] }), row(ARENA, { targets: [], targetFind: 'chinch' }), row(CELSIUS, { targets: ['Crabgrass'] }), row(IRON, { targets: [] })];
    const out = await resolve(rows, { live: () => false, confirm });
    for (const r of rows) expect(out.of(r)).toEqual([]);
    expect(confirm).not.toHaveBeenCalled();
  });

  test('the staged sets are read once, and only when a candidate row exists', async () => {
    const confirm = jest.fn(async () => SETS());
    await resolve([row(CELSIUS), row(IRON)], { confirm });
    expect(confirm).not.toHaveBeenCalled();
    await resolve([row(ARTAVIA), row(ARENA)], { confirm });
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  test('a staged-set read that fails stores no target for the candidate rows (fail closed)', async () => {
    const out = await resolve([row(ARENA, { targetFind: 'chinch' }), row(ARTAVIA, { targets: ['Dollar spot'] })], { confirm: async () => { throw new Error('down'); } });
    expect(out.of(row(ARENA))).toEqual([]);
    expect(out.of(row(ARTAVIA))).toEqual([]);
  });
});

describe('one source for what the spot was for: place, type and target never disagree', () => {
  const categories = ['fungicide', 'insecticide'];
  const flags = [
    { takeAll: false, chinch: false, chinchOnly: false },
    { takeAll: true, chinch: false, chinchOnly: false },
    { takeAll: false, chinch: true, chinchOnly: false },
    { takeAll: false, chinch: true, chinchOnly: true },
  ];
  const hints = [null, 'fungus', 'take_all', 'chinch', 'other_insect', 'weeds'];

  test('whatever the sheet hints, a stored target stands for the type the store records', () => {
    for (const category of categories) {
      for (const flag of flags) {
        for (const hint of hints) {
          const type = troubleTypeFor({ category, hint, ...flag });
          for (const requested of [undefined, ...spotTarget.FUNGICIDE_NAMES, ...spotTarget.INSECTICIDE_NAMES]) {
            const [target] = spotTarget.targetsFor({ category, type, requested });
            if (target) expect(spotTarget.typeOfTarget(target)).toBe(type);
          }
        }
      }
    }
  });
});

describe('what the customer report prints for each case (the real builders)', () => {
  const expect_ = (applications, tiedFamilies = []) => buildLawnExpectations({ applications, visitDate: '2026-10-09', nextVisitGapDays: 42, tiedFamilies }, { includeUnapproved: false });
  const sentences = (out) => out.rows.map((r) => [r.id, r.sentences.find((s) => s.key === 'visibleChange').text]);

  test('a spot fungicide with a target prints the curative sentence; without one, the protective sentence', () => {
    expect(sentences(expect_([{ name: 'Artavia 2 SC (Azoxy)', targets: ['Dollar spot'] }]))).toEqual([['fungicide_curative', 'This treatment helps control disease spread. Damaged areas recover as the lawn produces new growth.']]);
    expect(sentences(expect_([{ name: 'Artavia 2 SC (Azoxy)', targets: [] }]))).toEqual([['fungicide_preventive', 'This is a protective treatment, so nothing changes visibly. It helps protect the turf through wet, humid stretches.']]);
  });

  test('a chinch row: the stored chinch target and the technician tie give the same curative row', () => {
    const viaTarget = sentences(expect_([{ name: 'Arena 50 WDG', targets: spotTarget.targetsFor({ category: 'insecticide', type: 'chinch' }) }]));
    expect(viaTarget).toEqual([['insecticide_curative', 'This treatment works to stop the insects causing the damage.']]);
    const rows = [{ product_id: ARENA, product_name: 'Arena 50 WDG', product_category: 'insecticide', application_method: 'spot_treatment' }];
    const facts = reportFacts.buildReportFacts({ rows, run: null, assessment: { id: 'as-1' }, techFindings: [{ kind: 'chinch' }] });
    expect(facts.ties.items).toEqual([{ source: 'technician', kind: 'chinch', product: 'insecticide' }]);
    const tied = reportFacts.frozenTiedFamilies({ lawnReportFacts: facts }, 'as-1');
    expect(tied).toEqual(['insecticide']);
    expect(sentences(expect_([{ name: 'Arena 50 WDG', targets: [] }], tied))).toEqual(viaTarget);
  });

  test('a spot insecticide with no target and no tie prints the protective sentence', () => {
    expect(sentences(expect_([{ name: 'Atticus Talak 7.9 F', targets: [] }]))).toEqual([['insecticide_preventive', 'Nothing changes visibly. This works ahead of the pests, so success looks like damage that never shows up.']]);
  });

  test('a tag of the other family changes nothing (a fungicide tag on an insecticide stays protective)', () => {
    expect(sentences(expect_([{ name: 'Atticus Talak 7.9 F', targets: ['Dollar spot'] }]))[0][0]).toBe('insecticide_preventive');
  });
});

describe('the frozen report facts read the same targets as the stored row', () => {
  const { freezeReportProductFacts } = require('../services/complete-scheduled-service');
  const cat = { id: TALAK, name: 'Atticus Talak 7.9 F', category: 'insecticide', epa_reg_number: '91234-145', active: true, label_verified_at: new Date(),
    approved_for_service_report: true, content_status: 'approved', customer_visibility: 'public' };
  const catalogById = new Map([[TALAK, cat]]);
  // A protocol row that holds watering and mowing after the use: only a caterpillar-like target on the use turns it on (withApplicationHold).
  const plan = { protocol: { structured: { products: [{ productId: TALAK, gates: { delayWateringOrMowingHours: 24 } }] } } };
  const submitted = [{ productId: TALAK, method: 'spot_treatment', targets: ['Fall armyworms'] }];
  const freeze = (list) => freezeReportProductFacts({ productIds: [TALAK], submitted: list, catalogById, plan })[TALAK];
  const names = () => Object.assign(resolveArgs(), {});
  const resolveArgs = () => ({
    rows: submitted, lawnFast: {}, catalog: catalogById, canonicalId: (id) => String(id).toLowerCase(), inferMethod: (p, r) => r.method, serviceLine: 'lawn', live: () => true,
  });

  test('a confirmed target: the frozen facts equal the ones built from the stored row\'s targets', async () => {
    const resolved = await spotTarget.resolveForCompletion({ ...names(), confirm: async () => SETS() });
    expect(resolved.of(submitted[0])).toEqual(['Fall armyworms']);
    expect(freeze(resolved.submitted(submitted))).toEqual(freeze([{ ...submitted[0], targets: resolved.of(submitted[0]) }]));
    expect(freeze(resolved.submitted(submitted)).wateringRule).toMatchObject({ mode: 'hold', hold_hours: 24 });
  });

  test('a rejected target (staged sets unreadable): nothing is stored and the frozen facts hold no target-dependent rule', async () => {
    const resolved = await spotTarget.resolveForCompletion({ ...names(), confirm: async () => { throw new Error('down'); } });
    expect(resolved.of(submitted[0])).toEqual([]);
    expect(freeze(submitted).wateringRule).toBeTruthy();
    expect(freeze(resolved.submitted(submitted)).wateringRule ?? null).toBeNull();
  });

  test('a target dropped for a row that is not spot: no target-dependent hold either', async () => {
    const broadcast = [{ ...submitted[0], method: 'broadcast_spray' }];
    const resolved = await spotTarget.resolveForCompletion({ ...names(), rows: broadcast, confirm: async () => SETS() });
    expect(freeze(resolved.submitted(broadcast)).wateringRule ?? null).toBeNull();
  });

  test('gate off, lawnFast, tags sent by a stale sheet: nothing stored and no target-dependent hold in the frozen facts', async () => {
    const resolved = await spotTarget.resolveForCompletion({ ...names(), live: () => false, confirm: async () => SETS() });
    expect(resolved.of(submitted[0])).toEqual([]);
    expect(freeze(submitted).wateringRule).toBeTruthy();
    expect(freeze(resolved.submitted(submitted)).wateringRule ?? null).toBeNull();
  });

  test('gate off, not a lawnFast completion: the very same list goes to the freeze, with the row\'s own tags (unchanged)', async () => {
    const resolved = await spotTarget.resolveForCompletion({ ...names(), lawnFast: null, live: () => false, confirm: async () => SETS() });
    expect(resolved.submitted(submitted)).toBe(submitted);
    expect(freeze(resolved.submitted(submitted)).wateringRule).toMatchObject({ mode: 'hold', hold_hours: 24 });
  });

  test('gate off, lawnFast, rows with no tags: the very same list (byte-identical to main)', async () => {
    const plain = [{ productId: TALAK, method: 'spot_treatment', targets: [] }];
    const resolved = await spotTarget.resolveForCompletion({ ...names(), rows: plain, live: () => false, confirm: async () => SETS() });
    expect(resolved.submitted(plain)).toBe(plain);
  });
});

describe('GATE_LAWN_SPOT_TARGET (dark; live only while the treatment guide is)', () => {
  const NAMES = ['GATE_LAWN_SPOT_TARGET', 'GATE_LAWN_TREATMENT_GUIDE', 'GATE_LAWN_SPOT_RULES', 'GATE_LAWN_V13'];
  const saved = Object.fromEntries(NAMES.map((name) => [name, process.env[name]]));
  const set = (on) => { for (const name of NAMES) { if (on) process.env[name] = 'true'; else delete process.env[name]; } };
  afterEach(() => { for (const name of NAMES) { if (saved[name] === undefined) delete process.env[name]; else process.env[name] = saved[name]; } });
  const featureGates = require('../config/feature-gates');
  const completionArgs = (rows) => ({ rows, catalog: CATALOG, canonicalId: (id) => String(id).toLowerCase(), inferMethod: (product, row) => row.method, serviceLine: 'lawn', confirm: jest.fn(async () => SETS()) });

  test('the reader is strict and needs the guide (and so the spot rules and v13)', () => {
    set(false);
    expect(featureGates.lawnSpotTargetLive()).toBe(false);
    process.env.GATE_LAWN_SPOT_TARGET = 'true';
    expect(featureGates.lawnSpotTargetLive()).toBe(false);
    process.env.GATE_LAWN_TREATMENT_GUIDE = 'true';
    process.env.GATE_LAWN_SPOT_RULES = 'true';
    expect(featureGates.lawnSpotTargetLive()).toBe(false);
    process.env.GATE_LAWN_V13 = 'true';
    expect(featureGates.lawnSpotTargetLive()).toBe(true);
    process.env.GATE_LAWN_SPOT_TARGET = 'TRUE';
    expect(featureGates.lawnSpotTargetLive()).toBe(false);
  });

  test('off: the context has no spotTargets key, even with the guide live; on: it carries the lists', () => {
    set(true);
    delete process.env.GATE_LAWN_SPOT_TARGET;
    expect(spotTarget.contextKey()).toEqual({});
    process.env.GATE_LAWN_SPOT_TARGET = 'true';
    expect(spotTarget.contextKey()).toEqual({ spotTargets: spotTarget.contextBlock() });
  });

  test('off (the default live reader): a lawnFast completion stores no target and no chinch find; a non-lawnFast completion keeps every tag', async () => {
    set(true);
    delete process.env.GATE_LAWN_SPOT_TARGET;
    const rows = [
      { productId: ARTAVIA, method: 'spot_treatment', targets: ['free text from the picker'] },
      { productId: ARENA, method: 'spot_treatment', targets: [], targetFind: 'chinch' },
      { productId: TAKE_ALL, method: 'spot_treatment', targets: ['Dollar spot', 'Large patch'] },
    ];
    const args = completionArgs(rows);
    const stale = await spotTarget.resolveForCompletion({ ...args, lawnFast: { visitType: 'recurring' } });
    for (const row of rows) expect(stale.of(row)).toEqual([]);
    const fullForm = await spotTarget.resolveForCompletion({ ...args, lawnFast: null });
    for (const row of rows) expect(fullForm.of(row)).toBe(row.targets);
    expect(args.confirm).not.toHaveBeenCalled();
  });

  test('real builders: with the gate off a stale sheet\'s tags print what main prints for the sheet\'s own `targets: []`', async () => {
    set(true);
    delete process.env.GATE_LAWN_SPOT_TARGET;
    const apps = [{ name: 'Artavia 2 SC (Azoxy)', own: ['Dollar spot'], id: ARTAVIA }, { name: 'Arena 50 WDG', own: ['Southern chinch bugs'], id: ARENA }, { name: 'Atticus Talak 7.9 F', own: ['free text'], id: TALAK }];
    for (const app of apps) {
      const row = { productId: app.id, method: 'spot_treatment', targets: app.own, targetFind: 'chinch' };
      const resolved = await spotTarget.resolveForCompletion({ ...completionArgs([row]), lawnFast: {} });
      const printed = (targets) => buildLawnExpectations({ applications: [{ name: app.name, targets }], visitDate: '2026-10-09', nextVisitGapDays: 42 }, { includeUnapproved: false }).rows.map((r) => [r.id, r.sentences.map((x) => x.text)]);
      expect(printed(resolved.of(row))).toEqual(printed([]));
      expect(printed(resolved.of(row))[0][0]).toMatch(/preventive/);
    }
  });

  test('on: the same stale-looking tags are judged by the server (a confirmed target is stored)', async () => {
    set(true);
    const row = { productId: ARTAVIA, method: 'spot_treatment', targets: ['Dollar spot'] };
    expect((await spotTarget.resolveForCompletion({ ...completionArgs([row]), lawnFast: {} })).of(row)).toEqual(['Dollar spot']);
  });
});
