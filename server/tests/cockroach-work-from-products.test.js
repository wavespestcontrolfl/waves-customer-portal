// Cockroach `work_completed` is an autoFilled field derived from the visit's
// SUBMITTED product rows at completion (owner ruling 2026-09-26; the Tree &
// Shrub `treatments_completed` precedent). These tests pin the classifier, the
// completion-side derivation, the schema flag, and that every downstream
// reader (Today's Result, treatment evidence, trace eligibility, the report
// builder) sees ordinary chips. Synthetic data only.

const { deriveCockroachWorkChips, workKeysForProductRow } = require('../services/service-report/cockroach-work-from-products');
const { deriveCockroachWorkFromSubmittedProducts } = require('../services/complete-scheduled-service');
const { PROJECT_TYPES } = require('../services/project-types');
const ActivityIndicators = require('../services/service-report/activity-indicators');
const { resolveTraceEligibility } = require('../services/service-report/trace-eligibility');
const { buildCockroachReportV2 } = require('../services/service-report/cockroach-report-v2');

const row = (over) => ({ name: '', category: '', productType: null, activeIngredient: '', method: 'spot_treatment', applicationArea: null, ...over });
const ADVION = row({ name: 'Advion Cockroach Gel Bait', category: 'bait', method: 'bait_placement', activeIngredient: 'Indoxacarb 0.6%' });
const GENTROL = row({ name: 'Gentrol IGR', category: 'IGR', activeIngredient: 'Hydroprene' });
const ALPINE = row({ name: 'Alpine WSG', category: 'insecticide', activeIngredient: 'Dinotefuran' });

describe('the cockroach work_completed field is autoFilled (hidden from the tech form)', () => {
  test('flag + same option vocabulary; sibling lanes unchanged', () => {
    const field = PROJECT_TYPES.cockroach.findingsFields.find((f) => f.key === 'work_completed');
    expect(field.autoFilled).toBe(true);
    expect(field.options).toEqual(expect.arrayContaining(['Bait placement', 'Insect growth regulator', 'Crack & crevice treatment', 'Dust application', 'Exterior perimeter treatment']));
    const served = ActivityIndicators.findingsSchemaForType('cockroach').fields.find((f) => f.key === 'work_completed');
    expect(served.autoFilled).toBe(true);
    for (const type of ['bed_bug', 'one_time_pest_treatment']) {
      expect(PROJECT_TYPES[type].findingsFields.find((f) => f.key === 'work_completed').autoFilled).toBeUndefined();
    }
  });

  test('a stored snapshot\'s chips and a derived value classify as treatment evidence the same way', () => {
    expect(ActivityIndicators.typedTreatmentEvidence('cockroach', { work_completed: 'Bait placement' }))
      .toMatchObject({ applied: true, dryDown: false });
    expect(ActivityIndicators.typedTreatmentEvidence('cockroach', { work_completed: 'Bait placement, Crack & crevice treatment' }).dryDown).toBe(true);
  });
});

describe('deriveCockroachWorkChips — classification from the recorded row', () => {
  test('the three default cockroach products: bait / IGR / crack & crevice in canonical order', () => {
    expect(deriveCockroachWorkChips([ALPINE, GENTROL, ADVION])).toEqual(['Bait placement', 'Insect growth regulator', 'Crack & crevice treatment']);
  });

  test('category / method / active before brand names; name-only fallbacks for the known products', () => {
    expect(deriveCockroachWorkChips([row({ name: 'Some Roach Product', category: 'gel', method: 'bait_placement' })])).toEqual(['Bait placement']);
    expect(deriveCockroachWorkChips([row({ name: 'Unbranded', category: 'Insect Growth Regulator' })])).toEqual(['Insect growth regulator']);
    expect(deriveCockroachWorkChips([row({ name: 'Unbranded', activeIngredient: 'pyriproxyfen' })])).toEqual(['Insect growth regulator']);
    expect(deriveCockroachWorkChips([row({ name: 'Delta Dust', category: 'insecticide' })])).toEqual(['Dust application']);
    expect(deriveCockroachWorkChips([row({ name: 'Advion Cockroach Gel Bait', method: '' }), row({ name: 'Gentrol IGR', method: '' }), row({ name: 'Alpine WSG', method: '' })]))
      .toEqual(['Bait placement', 'Insect growth regulator', 'Crack & crevice treatment']);
  });

  test('a combination product keeps every action it matches (codex P2, #5365)', () => {
    // The catalog's Vendetta Plus: a bait carrying pyriproxyfen, an IGR.
    const vendettaPlus = row({ name: 'Vendetta Plus', category: 'bait', activeIngredient: 'Abamectin + Pyriproxyfen', method: '' });
    expect(workKeysForProductRow(vendettaPlus)).toEqual(['bait', 'igr']);
    expect(deriveCockroachWorkChips([vendettaPlus])).toEqual(['Bait placement', 'Insect growth regulator']);
  });

  test('an unrecognised product derives NOTHING; adjuvants and other pest classes\' devices too', () => {
    expect(deriveCockroachWorkChips([row({ name: 'Atticus Talak', category: 'insecticide', activeIngredient: 'bifenthrin' })])).toEqual([]);
    expect(deriveCockroachWorkChips([row({ name: 'Taurus SC', category: 'insecticide', method: 'perimeter_spray' })])).toEqual([]);
    expect(deriveCockroachWorkChips([])).toEqual([]);
    expect(deriveCockroachWorkChips(null)).toEqual([]);
    expect(deriveCockroachWorkChips([{}])).toEqual([]);
    expect(deriveCockroachWorkChips([
      row({ name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' }),
      row({ name: 'Bait Station Cartridge', category: 'termite bait', method: 'bait_placement' }),
      row({ name: 'Rodent Block', category: 'rodenticide bait', method: 'bait_placement' }),
      row({ name: 'Glue Board', category: 'glue', method: 'bait_placement' }),
      row({ name: 'Celsius WG', category: 'herbicide' }),
    ])).toEqual([]);
    expect(deriveCockroachWorkChips([row({ name: 'Atticus Talak', category: 'insecticide' }), ADVION])).toEqual(['Bait placement']);
  });

  test('the exterior line rides the row\'s application AREA, never the default stored method', () => {
    expect(workKeysForProductRow(row({ name: 'Taurus SC', category: 'insecticide', method: 'perimeter_spray' }))).toEqual([]);
    expect(deriveCockroachWorkChips([row({ name: 'Alpine WSG', method: 'perimeter_spray' })])).toEqual(['Crack & crevice treatment']);
    // other pesticide + exterior area → Exterior perimeter
    expect(deriveCockroachWorkChips([row({ name: 'Taurus SC', category: 'insecticide', method: 'perimeter_spray', applicationArea: 'Exterior perimeter' })])).toEqual(['Exterior perimeter treatment']);
    // Alpine: exterior + spot method → both; exterior + non-spot method → perimeter only; interior area → crack only
    expect(deriveCockroachWorkChips([row({ name: 'Alpine WSG', method: 'spot_treatment', applicationArea: 'Exterior perimeter' })])).toEqual(['Crack & crevice treatment', 'Exterior perimeter treatment']);
    expect(deriveCockroachWorkChips([row({ name: 'Alpine WSG', method: 'perimeter_spray', applicationArea: 'Exterior perimeter' })])).toEqual(['Exterior perimeter treatment']);
    expect(deriveCockroachWorkChips([row({ name: 'Alpine WSG', applicationArea: 'Kitchen' })])).toEqual(['Crack & crevice treatment']);
    // an INTERIOR chip is never exterior evidence
    expect(deriveCockroachWorkChips([row({ name: 'Taurus SC', category: 'insecticide', applicationArea: 'Interior entry points' })])).toEqual([]);
    // bait / IGR never turn into a perimeter line
    expect(deriveCockroachWorkChips([{ ...ADVION, applicationArea: 'Exterior perimeter' }, { ...GENTROL, applicationArea: 'Exterior perimeter' }])).toEqual(['Bait placement', 'Insect growth regulator']);
  });
});

describe('deriveCockroachWorkFromSubmittedProducts — the completion-side derivation', () => {
  const catalog = new Map([
    ['id-advion', { id: 'id-advion', name: 'Advion Cockroach Gel Bait', category: 'bait', active_ingredient: 'Indoxacarb 0.6%' }],
    ['id-gentrol', { id: 'id-gentrol', name: 'Gentrol IGR', category: 'IGR', active_ingredient: 'Hydroprene' }],
    ['id-alpine', { id: 'id-alpine', name: 'Alpine WSG', category: 'insecticide', active_ingredient: 'Dinotefuran', product_type: 'pesticide' }],
    ['id-taurus', { id: 'id-taurus', name: 'Taurus SC', category: 'insecticide', product_type: 'pesticide' }],
    ['id-surf', { id: 'id-surf', name: 'LESCO 90/10 Nonionic Surfactant', category: 'adjuvant' }],
  ]);
  const derive = (products) => deriveCockroachWorkFromSubmittedProducts({ products, catalogRowsById: catalog, serviceLine: 'pest' });

  test('Advion → Bait, Gentrol → IGR, Alpine interior → Crack & crevice', () => {
    expect(derive([{ productId: 'id-advion' }, { productId: 'id-gentrol', applicationMethod: 'spot_treatment' }, { productId: 'id-alpine', applicationMethod: 'spot_treatment', applicationArea: 'Kitchen' }]))
      .toEqual(['Bait placement', 'Insect growth regulator', 'Crack & crevice treatment']);
  });

  test('Alpine exterior spot → both; other pesticide exterior → Exterior perimeter; unknown / adjuvant → none', () => {
    expect(derive([{ productId: 'id-alpine', applicationMethod: 'spot_treatment', applicationArea: 'Exterior perimeter' }])).toEqual(['Crack & crevice treatment', 'Exterior perimeter treatment']);
    expect(derive([{ productId: 'id-taurus', applicationArea: 'Exterior perimeter' }])).toEqual(['Exterior perimeter treatment']);
    expect(derive([{ productId: 'id-taurus' }])).toEqual([]);
    expect(derive([{ productId: 'id-surf' }, { productId: 'not-in-catalog' }, {}])).toEqual([]);
    expect(derive([])).toEqual([]);
  });

  test('the METHOD is the one the completion stores: a methodless bait row still derives bait; duplicate ids count once', () => {
    expect(derive([{ productId: 'id-advion' }, { productId: 'ID-ADVION' }])).toEqual(['Bait placement']);
  });

  test('only labels the form field offers ever come out', () => {
    const options = new Set(PROJECT_TYPES.cockroach.findingsFields.find((f) => f.key === 'work_completed').options);
    for (const chip of derive([{ productId: 'id-advion' }, { productId: 'id-gentrol' }, { productId: 'id-alpine', applicationArea: 'Exterior perimeter' }])) {
      expect(options.has(chip)).toBe(true);
    }
  });
});

describe('a derived work_completed reads exactly like tech-tapped chips downstream', () => {
  const derived = 'Bait placement, Crack & crevice treatment, Exterior perimeter treatment';
  const gauge = (score) => ({ indicatorKey: 'roach_activity', label: 'Roach Activity', score, source: 'derived' });

  test('the frozen typed values validate (the derived string is a legal chips value)', () => {
    expect(ActivityIndicators.validateTypedFindings({
      type: 'cockroach', expectedType: 'cockroach', values: { species: 'German', activity_level: 'Moderate', work_completed: derived },
    }).ok).toBe(true);
  });

  test('trace eligibility sees the exterior work a derived exterior row records; interior-only stays ineligible', () => {
    expect(resolveTraceEligibility({ findingsType: 'cockroach', typedValues: { work_completed: derived } })).toMatchObject({ eligible: true, variant: 'spray' });
    expect(resolveTraceEligibility({ findingsType: 'cockroach', typedValues: { work_completed: 'Bait placement, Crack & crevice treatment' } }))
      .toMatchObject({ eligible: false, reason: 'no_exterior_work_recorded' });
  });

  test('Today\'s Result composes the work sentence from a derived snapshot, including a None-observed visit', () => {
    const active = ActivityIndicators.buildTypedReportSnapshot({
      projectType: 'cockroach', serviceKey: 'cockroach_control', visitSequence: 1, activity: gauge(3),
      values: { species: 'German', activity_level: 'Moderate', work_completed: 'Bait placement, Insect growth regulator' },
    });
    expect(active.todaysResult.body).toContain('placed targeted bait');
    expect(active.todaysResult.body).toContain('applied an insect growth regulator');
    const none = ActivityIndicators.buildTypedReportSnapshot({
      projectType: 'cockroach', serviceKey: 'cockroach_control', visitSequence: 1, activity: gauge(0),
      values: { species: 'German', activity_level: 'None observed', work_completed: 'Bait placement' },
    });
    expect(none.todaysResult.body).toContain('placed targeted bait');
    expect(none.todaysResult.body).not.toContain('We completed the scheduled service.');
  });

  test('the report builder shows the work, the metric and the bait-aware next steps from the stored chips alone', () => {
    const out = buildCockroachReportV2({
      typedSnapshotValues: { species: 'German', activity_level: 'Moderate', work_completed: 'Bait placement, Insect growth regulator, Crack & crevice treatment' },
      typedReportType: 'cockroach',
    });
    expect(out.work.map((w) => w.short)).toEqual(['Bait', 'IGR', 'Crack & crevice']);
    expect(out.help.items.map((i) => i.key)).toContain('keep_bait');
    // no work derived → no work, no bait promise
    const none = buildCockroachReportV2({ typedSnapshotValues: { species: 'German', activity_level: 'Moderate' }, typedReportType: 'cockroach' });
    expect(none.work).toEqual([]);
    expect(none.help.items.map((i) => i.key)).not.toContain('keep_bait');
  });
});

describe('complete-scheduled-service wiring (source-level guards)', () => {
  const source = require('fs').readFileSync(require.resolve('../services/complete-scheduled-service'), 'utf8');

  test('the stale submitted value is stripped BEFORE validation, then the derivation runs BEFORE the snapshot freezes', () => {
    const stripAt = source.indexOf("if (typedFindingsType === 'cockroach' && structuredFindings?.values");
    const deleteAt = source.indexOf('delete structuredFindings.values.work_completed;');
    const validateAt = source.indexOf('const findingsValidation = ActivityIndicators.validateTypedFindings({');
    const deriveAt = source.indexOf('deriveCockroachWorkFromSubmittedProducts({\n                products: products');
    const snapshotAt = source.indexOf('serviceData.typedReportSnapshot = ActivityIndicators.buildTypedReportSnapshot({');
    expect(stripAt).toBeGreaterThan(-1);
    expect(deleteAt).toBeGreaterThan(stripAt);
    expect(validateAt).toBeGreaterThan(deleteAt);
    expect(deriveAt).toBeGreaterThan(validateAt);
    expect(snapshotAt).toBeGreaterThan(deriveAt);
  });

  test('a stale posted value is replaced by the derivation (posted chips never survive)', () => {
    // the strip removes it, the derivation either re-fills it or deletes it — never leaves the posted one
    expect(source).toMatch(/if \(derivedWork\.length\) typedFindings\.values\.work_completed = derivedWork\.join\(', '\);\s+else delete typedFindings\.values\.work_completed;/);
  });
});

describe('companion cockroach sections keep the work chips tappable (codex P1, #5365)', () => {
  const { findingsSchemaForType } = require('../services/service-report/activity-indicators');
  const field = (opts) => findingsSchemaForType('cockroach', opts).fields.find((f) => f.key === 'work_completed');

  test('primary form: derived, hidden', () => {
    expect(field({}).autoFilled).toBe(true);
  });
  test('companion form: tappable and still optional', () => {
    const f = field({ companion: true });
    expect(f.autoFilled).toBe(false);
    expect(f.required).toBe(false);
  });
});
