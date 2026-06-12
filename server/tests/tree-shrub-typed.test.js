/**
 * Tree & Shrub typed checklist (owner spec 2026-06-12, Phase 2 §6): schema
 * shape with modules + internal compliance fields, owner-template Today's
 * Result composition, cross-field story coherence, and the ported legacy
 * closeout compliance (N/P blackout, pollinator, IRAC/FRAC, products,
 * photos, injection redirect).
 */
const {
  REQUIRED_FINDINGS_FIELDS,
  TYPE_NEXT_STEP_CHIPS,
  NEXT_STEP_CHIPS,
  customerLabelForValue,
  findBannedCustomerCopy,
  nextStepRequiredForType,
  validateTypedFindings,
  buildTodaysResult,
  buildTypedReportSnapshot,
  findingsSchemaForType,
  getActivityIndicator,
} = require('../services/service-report/activity-indicators');
const { PROJECT_TYPES } = require('../services/project-types');
const { validateTreeShrubTypedCompliance } = require('../services/tree-shrub-closeout');

const BASE_VALUES = {
  plant_groups: 'Palms, Shrubs, Ornamentals',
  landscape_condition: 'Fair',
  observed_conditions: 'Scale, Yellowing / chlorosis',
  treatments_completed: 'Fertilizer, Palm fertilizer, Insect treatment',
  customer_recommendations: 'Avoid over-pruning, Keep mulch off trunks / stems, Monitor decline',
  palms_serviced: '4',
  palm_condition: 'Fair',
  ganoderma_conk_observed: 'No',
  palm_trunk_concern: 'No',
};

describe('tree & shrub schema', () => {
  test('registered with modular sections and a required core', () => {
    const config = PROJECT_TYPES.tree_shrub;
    expect(config).toBeTruthy();
    const sections = new Set(config.findingsFields.map((f) => f.section));
    for (const section of ['Service scope', 'Observed conditions', 'Treatments', 'Palm module', 'Shrub & ornamental module', 'Bed & pre-emergent module', 'Compliance', 'Recommendations']) {
      expect(sections.has(section)).toBe(true);
    }
    expect(REQUIRED_FINDINGS_FIELDS.tree_shrub).toEqual([
      'plant_groups', 'landscape_condition', 'observed_conditions',
      'treatments_completed', 'customer_recommendations',
    ]);
    expect(nextStepRequiredForType('tree_shrub')).toBe(true);
  });

  test('no pest activity gauge — condition narrative leads instead', () => {
    expect(getActivityIndicator('tree_shrub')).toBeNull();
    expect(findingsSchemaForType('tree_shrub').activity).toBeNull();
  });

  test('compliance fields serve as internal; customer-facing fields do not', () => {
    const schema = findingsSchemaForType('tree_shrub');
    const byKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));
    expect(byKey.pollinator_status.internal).toBe(true);
    expect(byKey.irac_frac_logged.internal).toBe(true);
    expect(byKey.plant_groups.internal).toBe(false);
    expect(byKey.ganoderma_conk_observed.internal).toBe(false);
  });

  test('every tree_shrub next-step chip has a sentence', () => {
    for (const chip of TYPE_NEXT_STEP_CHIPS.tree_shrub) {
      expect({ chip, hasSentence: !!NEXT_STEP_CHIPS[chip] }).toEqual({ chip, hasSentence: true });
    }
  });
});

describe('owner template composition', () => {
  test('condition-led headline + scope + treatments + coupled Ganoderma reassurance', () => {
    const result = buildTodaysResult({
      projectType: 'tree_shrub',
      reportTypeLabel: 'Tree & Shrub Service Summary',
      values: BASE_VALUES,
      chips: ['Continue Tree & Shrub program', 'Monitor plant response'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.headline).toBe('Overall landscape condition is fair.');
    expect(result.body).toContain('Completed Tree & Shrub service for the palms, shrubs and ornamentals.');
    expect(result.body).toContain('applied ornamental fertilizer');
    expect(result.body).toContain('applied palm fertilizer');
    expect(result.body).toContain('No visible Ganoderma conks or trunk decay were observed on the palms today.');
    expect(result.body).toContain('We will continue your Tree & Shrub care program.');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('Ganoderma sighting flips the palm note to an arborist referral', () => {
    const result = buildTodaysResult({
      projectType: 'tree_shrub',
      reportTypeLabel: 'Tree & Shrub Service Summary',
      values: { ...BASE_VALUES, ganoderma_conk_observed: 'Yes', landscape_condition: 'Declining' },
      chips: ['Arborist review recommended'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.headline).toBe('Overall landscape condition is declining — see the recommendations below.');
    expect(result.body).toContain('A possible Ganoderma conk was observed on a palm — an arborist evaluation is recommended.');
  });

  test('trunk concern decouples the trunk-decay half of the reassurance', () => {
    const result = buildTodaysResult({
      projectType: 'tree_shrub',
      reportTypeLabel: 'Tree & Shrub Service Summary',
      values: { ...BASE_VALUES, palm_trunk_concern: 'Yes' },
      chips: ['Monitor plant response'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.body).toContain('No visible Ganoderma conks were observed on the palms today.');
    expect(result.body).not.toContain('or trunk decay');
  });

  test('no palms serviced → no palm note', () => {
    const result = buildTodaysResult({
      projectType: 'tree_shrub',
      reportTypeLabel: 'Tree & Shrub Service Summary',
      values: {
        plant_groups: 'Shrubs, Hedges',
        landscape_condition: 'Good',
        observed_conditions: 'Healthy / new growth',
        treatments_completed: 'Fertilizer',
        customer_recommendations: 'Continue program',
      },
      chips: ['Continue Tree & Shrub program'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.headline).toBe('Overall landscape condition is good.');
    expect(result.body).not.toContain('Ganoderma');
  });

  test('stray palm-module values never produce a palm note on a non-palm visit (Codex P2)', () => {
    const result = buildTodaysResult({
      projectType: 'tree_shrub',
      reportTypeLabel: 'Tree & Shrub Service Summary',
      values: {
        plant_groups: 'Shrubs',
        landscape_condition: 'Good',
        observed_conditions: 'Healthy / new growth',
        treatments_completed: 'Fertilizer',
        customer_recommendations: 'Continue program',
        ganoderma_conk_observed: 'No',
        palm_trunk_concern: 'No',
      },
      chips: ['Continue Tree & Shrub program'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.body).not.toContain('Ganoderma');
  });
});

describe('validation', () => {
  test('palm module core required when Palms is a serviced group', () => {
    const result = validateTypedFindings({
      type: 'tree_shrub',
      values: {
        plant_groups: 'Palms, Shrubs',
        landscape_condition: 'Good',
        observed_conditions: 'Healthy / new growth',
        treatments_completed: 'Palm fertilizer',
        customer_recommendations: 'Continue program',
      },
      expectedType: 'tree_shrub',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['palm_condition', 'ganoderma_conk_observed']));

    const noPalms = validateTypedFindings({
      type: 'tree_shrub',
      values: {
        plant_groups: 'Shrubs',
        landscape_condition: 'Good',
        observed_conditions: 'Healthy / new growth',
        treatments_completed: 'Fertilizer',
        customer_recommendations: 'Continue program',
      },
      expectedType: 'tree_shrub',
      enforceRequired: true,
    });
    expect(noPalms.ok).toBe(true);
  });

  test('"No major issues observed" contradicts recorded issues', () => {
    for (const extra of [
      { observed_conditions: 'No major issues observed, Scale' },
      { observed_conditions: 'No major issues observed', pest_pressure: 'Heavy' },
      { observed_conditions: 'No major issues observed', ganoderma_conk_observed: 'Yes' },
    ]) {
      const result = validateTypedFindings({
        type: 'tree_shrub',
        values: { ...BASE_VALUES, ...extra },
        expectedType: 'tree_shrub',
        enforceRequired: true,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toMatch(/No major issues observed/);
    }
    // Healthy growth + light pressure stay coherent with the claim.
    const clean = validateTypedFindings({
      type: 'tree_shrub',
      values: {
        ...BASE_VALUES,
        observed_conditions: 'No major issues observed, Healthy / new growth',
        pest_pressure: 'Light',
      },
      expectedType: 'tree_shrub',
      enforceRequired: true,
    });
    expect(clean.ok).toBe(true);
  });

  test('palm-module findings require Palms in the service scope (Codex P2)', () => {
    const result = validateTypedFindings({
      type: 'tree_shrub',
      values: {
        plant_groups: 'Shrubs, Hedges',
        landscape_condition: 'Good',
        observed_conditions: 'Healthy / new growth',
        treatments_completed: 'Fertilizer',
        customer_recommendations: 'Continue program',
        palm_condition: 'Fair',
        ganoderma_conk_observed: 'No',
      },
      expectedType: 'tree_shrub',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/Palms is not among the serviced plant groups/);
  });

  test('"Inspection only" cannot ride with applied treatments', () => {
    const result = validateTypedFindings({
      type: 'tree_shrub',
      values: { ...BASE_VALUES, treatments_completed: 'Inspection only, Fertilizer' },
      expectedType: 'tree_shrub',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toMatch(/Inspection only/);
  });
});

describe('snapshot', () => {
  test('internal compliance fields never reach customer findings; values persist', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'tree_shrub',
      values: { ...BASE_VALUES, pollinator_status: 'No blooms or no bees', irac_frac_logged: 'Yes' },
      nextStepChips: ['Continue Tree & Shrub program'],
      serviceKey: 'tree_shrub_program',
      serviceLabel: 'Tree & Shrub Care Program',
      visitSequence: 1,
      activity: null,
    });
    const findingKeys = snapshot.findings.map((f) => f.fieldKey);
    expect(findingKeys).not.toContain('pollinator_status');
    expect(findingKeys).not.toContain('irac_frac_logged');
    expect(snapshot.values.pollinator_status).toBe('No blooms or no bees');
    const ganoderma = snapshot.findings.find((f) => f.fieldKey === 'ganoderma_conk_observed');
    expect(ganoderma.customerValueLabel).toBe('No visible Ganoderma conks observed today');
    expect(findBannedCustomerCopy(JSON.stringify(snapshot))).toEqual([]);
  });

  test('Yes/No selects render as findings sentences, not raw booleans', () => {
    expect(customerLabelForValue('ganoderma_conk_observed', 'Yes')).toContain('arborist');
    expect(customerLabelForValue('pre_emergent_applied', 'Yes')).toContain('Pre-emergent');
    expect(customerLabelForValue('new_growth_present', 'No')).toBe('No new growth observed yet');
  });
});

describe('ported closeout compliance (typed path)', () => {
  const manateeService = { city: 'Bradenton', scheduled_date: '2026-07-15' };
  const photos = [{ url: 'a' }, { url: 'b' }];
  const product = (id, name, extra = {}) => ({ productId: id, totalAmount: 2, amountUnit: 'oz', name, ...extra });
  const row = (id, name) => ({ id, name });

  test('N/P fertilizer blocked in summer blackout window, allowed outside it', () => {
    const summer = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-07-15',
      values: { ...BASE_VALUES, treatments_completed: 'Palm fertilizer' },
      products: [product('p1', 'Palm Fertilizer 8-2-12')],
      productRows: [row('p1', 'Palm Fertilizer 8-2-12')],
      completionPhotos: photos,
    });
    expect(summer.ok).toBe(false);
    expect(summer.blocks.map((b) => b.code)).toContain('tree_shrub_np_blackout');

    const winter = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Palm fertilizer' },
      products: [product('p1', 'Palm Fertilizer 8-2-12')],
      productRows: [row('p1', 'Palm Fertilizer 8-2-12')],
      completionPhotos: photos,
    });
    expect(winter.blocks.map((b) => b.code)).not.toContain('tree_shrub_np_blackout');

    // 0-0-16 (no N, no P) passes even in the window.
    const summerSafe = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-07-15',
      values: { ...BASE_VALUES, treatments_completed: 'Palm fertilizer' },
      products: [product('p2', 'Summer Palm 0-0-16')],
      productRows: [row('p2', 'Summer Palm 0-0-16')],
      completionPhotos: photos,
    });
    expect(summerSafe.blocks.map((b) => b.code)).not.toContain('tree_shrub_np_blackout');
  });

  test('"No insecticide applied" contradicts a recorded insect product (Codex P1)', () => {
    const contradiction = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Insect treatment', pollinator_status: 'No insecticide applied', irac_frac_logged: 'Yes' },
      products: [product('p3', 'Bifenthrin Pro')],
      productRows: [row('p3', 'Bifenthrin Pro')],
      completionPhotos: photos,
    });
    expect(contradiction.ok).toBe(false);
    expect(contradiction.blocks.map((b) => b.code)).toContain('tree_shrub_pollinator_status_contradiction');
  });

  test('insect products require pollinator status and block on active bees', () => {
    const missingStatus = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Insect treatment' },
      products: [product('p3', 'Bifenthrin Pro')],
      productRows: [row('p3', 'Bifenthrin Pro')],
      completionPhotos: photos,
    });
    expect(missingStatus.blocks.map((b) => b.code)).toContain('tree_shrub_pollinator_status_required');

    const beesActive = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Insect treatment', pollinator_status: 'Blooming — bees active', irac_frac_logged: 'Yes' },
      products: [product('p3', 'Bifenthrin Pro')],
      productRows: [row('p3', 'Bifenthrin Pro')],
      completionPhotos: photos,
    });
    expect(beesActive.blocks.map((b) => b.code)).toContain('tree_shrub_pollinator_block');

    const safe = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Insect treatment', pollinator_status: 'No blooms or no bees', irac_frac_logged: 'Yes' },
      products: [product('p3', 'Bifenthrin Pro')],
      productRows: [row('p3', 'Bifenthrin Pro')],
      completionPhotos: photos,
    });
    expect(safe.ok).toBe(true);
  });

  test('pesticide products require the IRAC/FRAC confirmation', () => {
    const unlogged = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Insect treatment', pollinator_status: 'No insecticide applied' },
      products: [product('p3', 'Bifenthrin Pro')],
      productRows: [row('p3', 'Bifenthrin Pro')],
      completionPhotos: photos,
    });
    expect(unlogged.blocks.map((b) => b.code)).toContain('tree_shrub_irac_frac_required');
  });

  test('application chips without recorded products are blocked', () => {
    const result = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Fertilizer, Insect treatment' },
      products: [],
      productRows: [],
      completionPhotos: photos,
    });
    expect(result.blocks.map((b) => b.code)).toContain('tree_shrub_products_required');

    const inspectionOnly = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Inspection only' },
      products: [],
      productRows: [],
      completionPhotos: photos,
    });
    expect(inspectionOnly.blocks.map((b) => b.code)).not.toContain('tree_shrub_products_required');
  });

  test('product actuals, photo minimum, and injection redirect enforced', () => {
    const noActuals = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Fertilizer' },
      products: [{ productId: 'p4', name: 'Ornamental 13-0-13' }],
      productRows: [row('p4', 'Ornamental 13-0-13')],
      completionPhotos: photos,
    });
    expect(noActuals.blocks.map((b) => b.code)).toContain('tree_shrub_product_actuals_required');

    const onePhoto = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Inspection only' },
      products: [],
      productRows: [],
      completionPhotos: [{ url: 'a' }],
    });
    expect(onePhoto.blocks.map((b) => b.code)).toContain('tree_shrub_photos_required');

    const injection = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Insect treatment', pollinator_status: 'No insecticide applied', irac_frac_logged: 'Yes' },
      products: [product('p5', 'Palm-Jet Mg')],
      productRows: [row('p5', 'Palm-Jet Mg')],
      completionPhotos: photos,
    });
    expect(injection.blocks.map((b) => b.code)).toContain('tree_shrub_injection_use_palm_flow');
  });
});
