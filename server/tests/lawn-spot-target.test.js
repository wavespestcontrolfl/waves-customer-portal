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

  test('a whole-lawn row never carries a target the sheet sent; another category is left to the main flow', async () => {
    const broadcast = row(ARTAVIA, { method: 'broadcast_spray', targets: ['Dollar spot'] });
    expect((await resolve([broadcast])).of(broadcast)).toEqual(['Dollar spot']);
    const herb = row(CELSIUS, { targets: ['Crabgrass'] });
    expect((await resolve([herb])).of(herb)).toEqual(['Crabgrass']);
    const iron = row(IRON, { targets: [] });
    expect((await resolve([iron])).of(iron)).toEqual([]);
  });

  test('no lawnFast block, or the guide off: the row keeps its own tags', async () => {
    const tagged = row(ARTAVIA, { targets: ['Dollar spot'] });
    expect((await resolve([tagged], { lawnFast: null })).of(tagged)).toEqual(['Dollar spot']);
    expect((await resolve([tagged], { live: () => false })).of(tagged)).toEqual(['Dollar spot']);
    const confirm = jest.fn();
    await resolve([tagged], { live: () => false, confirm });
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
