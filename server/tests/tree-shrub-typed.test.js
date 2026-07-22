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
  validateNextStepChips,
  validateTypedFindings,
  buildTodaysResult,
  buildTypedReportSnapshot,
  findingsSchemaForType,
  getActivityIndicator,
} = require('../services/service-report/activity-indicators');
const { PROJECT_TYPES } = require('../services/project-types');
const { validateTreeShrubTypedCompliance, deriveTreeShrubTreatments } = require('../services/tree-shrub-closeout');

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
    // Owner directive 2026-07-21 (closeout simplification): only scope +
    // condition are typed by hand — treatments derive from products,
    // observed conditions come from the AI photo review, detail modules are
    // optional.
    expect(REQUIRED_FINDINGS_FIELDS.tree_shrub).toEqual([
      'plant_groups', 'landscape_condition',
    ]);
    expect(nextStepRequiredForType('tree_shrub')).toBe(true);
  });

  test('simplified-closeout field flags (owner directive 2026-07-21)', () => {
    const schema = findingsSchemaForType('tree_shrub');
    const byKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));
    // Treatments never render on the PRIMARY form — derived from products at
    // completion (companion sections render it as a dropdown; the shared
    // products list on combined visits can't be attributed per line).
    expect(byKey.treatments_completed.autoFilled).toBe(true);
    expect(byKey.treatments_completed.type).toBe('multi_select');
    // Detail modules live behind the optional expander.
    for (const key of ['observed_conditions', 'palms_serviced', 'palm_condition', 'ganoderma_conk_observed', 'pest_pressure', 'bed_weed_pressure', 'weed_breakthrough_areas']) {
      expect({ key, detail: byKey[key].detail }).toEqual({ key, detail: true });
    }
    // Core scope fields stay primary.
    expect(byKey.plant_groups.detail).toBe(false);
    expect(byKey.landscape_condition.detail).toBe(false);
    // Compliance renders only once a pesticide product is on the visit.
    expect(byKey.pollinator_status.pesticideOnly).toBe(true);
    expect(byKey.irac_frac_logged.pesticideOnly).toBe(true);
    // Multi-value fields are dropdowns now; the comma-joined storage contract
    // is shared with chips so downstream consumers are unaffected.
    expect(byKey.plant_groups.type).toBe('multi_select');
    expect(byKey.observed_conditions.type).toBe('multi_select');
    expect(byKey.customer_recommendations.type).toBe('multi_select');
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
  test('palm module is optional detail even when Palms is a serviced group (owner directive 2026-07-21)', () => {
    const result = validateTypedFindings({
      type: 'tree_shrub',
      values: {
        plant_groups: 'Palms, Shrubs',
        landscape_condition: 'Good',
      },
      expectedType: 'tree_shrub',
      enforceRequired: true,
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);

    const noPalms = validateTypedFindings({
      type: 'tree_shrub',
      values: {
        plant_groups: 'Shrubs',
        landscape_condition: 'Good',
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
      { observed_conditions: 'No major issues observed', pruning_issue_observed: 'Yes' },
      { observed_conditions: 'No major issues observed', irrigation_issue_observed: 'Yes' },
      { observed_conditions: 'No major issues observed', mulch_depth_concern: 'Yes' },
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

    // Applied-treatment module fields contradict inspection-only too.
    const preEmergent = validateTypedFindings({
      type: 'tree_shrub',
      values: { ...BASE_VALUES, treatments_completed: 'Inspection only', pre_emergent_applied: 'Yes' },
      expectedType: 'tree_shrub',
      enforceRequired: true,
    });
    expect(preEmergent.ok).toBe(false);
    expect(preEmergent.errors.join(' ')).toMatch(/Pre-emergent applied/);
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

  test('herbicide chips require a matching product (FDACS ledger, audit 2026-07-18 P2)', () => {
    // A pre-emergent is a pesticide application — completing the chip with
    // no product left service_products / property_application_history empty
    // while the typed summary claimed the application.
    const noProduct = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Pre-emergent bed treatment' },
      products: [],
      productRows: [],
      completionPhotos: photos,
    });
    expect(noProduct.ok).toBe(false);
    expect(noProduct.blocks.map((b) => b.code)).toContain('tree_shrub_products_required');

    // An unrelated product must not satisfy the herbicide chip.
    const wrongProduct = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Weed spot treatment' },
      products: [product('p8', 'Palm Fertilizer 8-2-12')],
      productRows: [row('p8', 'Palm Fertilizer 8-2-12')],
      completionPhotos: photos,
    });
    expect(wrongProduct.blocks.map((b) => b.code)).toContain('tree_shrub_products_required');

    // A SEAWEED biostimulant is not an herbicide (codex P2 r2 class —
    // 'weed' must match as a word, never inside 'seaweed').
    const seaweed = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Weed spot treatment' },
      products: [product('p10', 'Seaweed Extract Biostimulant')],
      productRows: [row('p10', 'Seaweed Extract Biostimulant')],
      completionPhotos: photos,
    });
    expect(seaweed.blocks.map((b) => b.code)).toContain('tree_shrub_products_required');

    const withHerbicide = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Pre-emergent bed treatment' },
      products: [product('p9', 'Barricade 4FL Pre-Emergent')],
      productRows: [row('p9', 'Barricade 4FL Pre-Emergent')],
      completionPhotos: photos,
    });
    expect(withHerbicide.blocks.map((b) => b.code)).not.toContain('tree_shrub_products_required');
    // Herbicides carry rotation history too (HRAC): the rotation-log
    // confirmation gates the application like IRAC/FRAC ones (codex P2 r3).
    expect(withHerbicide.blocks.map((b) => b.code)).toContain('tree_shrub_irac_frac_required');
    const withHerbicideLogged = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Pre-emergent bed treatment', irac_frac_logged: 'Yes' },
      products: [product('p9', 'Barricade 4FL Pre-Emergent')],
      productRows: [row('p9', 'Barricade 4FL Pre-Emergent')],
      completionPhotos: photos,
    });
    expect(withHerbicideLogged.blocks.map((b) => b.code)).not.toContain('tree_shrub_irac_frac_required');
    expect(withHerbicideLogged.blocks.map((b) => b.code)).not.toContain('tree_shrub_products_required');
  });

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

  test('each regulated chip needs a MATCHING product — an unrelated one never satisfies it (Codex P2)', () => {
    // Fertilizer product alone cannot satisfy the insect chip: the
    // pollinator/IRAC gates would never see the insect application.
    const mismatch = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Fertilizer, Insect treatment' },
      products: [product('p4', 'Ornamental 13-0-13')],
      productRows: [row('p4', 'Ornamental 13-0-13')],
      completionPhotos: photos,
    });
    const productBlocks = mismatch.blocks.filter((b) => b.code === 'tree_shrub_products_required');
    expect(productBlocks).toHaveLength(1);
    expect(productBlocks[0].message).toContain('Insect treatment');

    // Matching products for both chips clear the rule (pollinator + IRAC
    // recorded for the insect application).
    const matched = validateTreeShrubTypedCompliance({
      service: manateeService,
      serviceDate: '2026-12-15',
      values: { ...BASE_VALUES, treatments_completed: 'Fertilizer, Insect treatment', pollinator_status: 'No blooms or no bees', irac_frac_logged: 'Yes' },
      products: [product('p4', 'Ornamental 13-0-13'), product('p3', 'Bifenthrin Pro')],
      productRows: [row('p4', 'Ornamental 13-0-13'), row('p3', 'Bifenthrin Pro')],
      completionPhotos: photos,
    });
    expect(matched.blocks.map((b) => b.code)).not.toContain('tree_shrub_products_required');
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

describe('companion context (combined visits — codex P2)', () => {
  test('companion schema requires treatments and clears autoFilled', () => {
    const companionSchema = findingsSchemaForType('tree_shrub', { companion: true });
    const byKey = Object.fromEntries(companionSchema.fields.map((f) => [f.key, f]));
    expect(byKey.treatments_completed.required).toBe(true);
    expect(byKey.treatments_completed.autoFilled).toBe(false);
    expect(companionSchema.requiredFields).toContain('treatments_completed');
    // Primary schema unchanged: hidden + derived.
    const primary = findingsSchemaForType('tree_shrub');
    const primaryByKey = Object.fromEntries(primary.fields.map((f) => [f.key, f]));
    expect(primaryByKey.treatments_completed.autoFilled).toBe(true);
    expect(primaryByKey.treatments_completed.required).toBe(false);
  });

  test('companion validation requires treatments; primary does not', () => {
    const values = { plant_groups: 'Shrubs', landscape_condition: 'Good' };
    const companion = validateTypedFindings({
      type: 'tree_shrub', values, expectedType: 'tree_shrub', enforceRequired: true, companion: true,
    });
    expect(companion.ok).toBe(false);
    expect(companion.missing).toContain('treatments_completed');
    const primary = validateTypedFindings({
      type: 'tree_shrub', values, expectedType: 'tree_shrub', enforceRequired: true,
    });
    expect(primary.ok).toBe(true);
  });
});

describe('Customer action needed chip requires a recommendation (codex P2 r6)', () => {
  test('chip beside empty customer_recommendations is rejected', () => {
    const result = validateNextStepChips(
      ['Customer action needed'], 'tree_shrub',
      { plant_groups: 'Shrubs', landscape_condition: 'Good', customer_recommendations: '' },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/recorded customer recommendation/);
  });

  test('chip with a recorded recommendation passes', () => {
    const result = validateNextStepChips(
      ['Customer action needed'], 'tree_shrub',
      { customer_recommendations: 'Adjust irrigation' },
    );
    expect(result.ok).toBe(true);
    expect(result.chips).toEqual(['Customer action needed']);
  });

  test('other chips stay valid without recommendations', () => {
    const result = validateNextStepChips(
      ['Continue Tree & Shrub program'], 'tree_shrub',
      { customer_recommendations: '' },
    );
    expect(result.ok).toBe(true);
  });
});

describe('deriveTreeShrubTreatments (owner directive 2026-07-21)', () => {
  const cat = (over) => ({ id: 'p1', name: 'Product', category: '', ...over });
  const derive = (rows) => deriveTreeShrubTreatments({
    products: rows.map((r) => ({ productId: r.id })),
    productRows: rows,
  });

  test('no products → Inspection only', () => {
    expect(deriveTreeShrubTreatments({ products: [], productRows: [] })).toBe('Inspection only');
  });

  test('insecticide → Insect treatment; hort oil variant → Horticultural oil', () => {
    expect(derive([cat({ name: 'Dominion 2L', category: 'insecticide' })])).toContain('Insect treatment');
    const oil = derive([cat({ name: 'Horticultural Oil Concentrate', category: 'insecticide' })]);
    expect(oil).toContain('Horticultural oil');
    expect(oil).not.toContain('Insect treatment');
  });

  test('fertilizer → Fertilizer; palm blend → Palm fertilizer', () => {
    expect(derive([cat({ name: 'Ferromec AC 15-0-0', category: 'fertilizer' })])).toContain('Fertilizer');
    expect(derive([cat({ name: 'Palm Fertilizer 8-2-12', category: 'fertilizer' })])).toContain('Palm fertilizer');
  });

  test('fungicide and herbicide map to their chips; pre-emergent name wins', () => {
    expect(derive([cat({ name: 'Banner Maxx', category: 'fungicide' })])).toContain('Disease / fungicide treatment');
    expect(derive([cat({ name: 'SpeedZone', category: 'herbicide' })])).toContain('Weed spot treatment');
    expect(derive([cat({ name: 'Pre-Emergent Barricade', category: 'herbicide' })])).toContain('Pre-emergent bed treatment');
  });

  test('pre-emergent BRANDS/actives derive the pre-emergent chip, not weed spot (codex P2)', () => {
    for (const name of ['Barricade 4FL', 'Dimension 2EW', 'Prodiamine 65 WDG', 'Snapshot 2.5 TG', 'Specticle FLO', 'Gallery 75 DF']) {
      const out = derive([cat({ name, category: 'herbicide' })]);
      expect({ name, out }).toEqual({ name, out: expect.stringContaining('Pre-emergent bed treatment') });
      expect(out).not.toContain('Weed spot treatment');
    }
    // Post-emergent products still derive the spot chip.
    expect(derive([cat({ name: 'Roundup QuikPro', category: 'herbicide' })])).toContain('Weed spot treatment');
  });

  test('amendment-like products record the soil-amendment chip, never a pesticide claim', () => {
    for (const row of [
      cat({ name: 'Soil Conditioner Plus', category: 'amendment' }),
      cat({ name: 'Espoma Organic Soil Acidifier', category: 'Soil Amendment' }),
      cat({ name: 'LESCO CarbonPro-L w/ MobilEX Biostimulant Liquid Soil Amendment', category: 'soil_amendment' }),
    ]) {
      expect(derive([row])).toBe('Soil amendment / acidifier');
    }
  });

  test('blank-category insecticides classify by active or trade name (codex P1 r5)', () => {
    // Real prod rows whose only pesticide signal is the active ingredient.
    expect(derive([cat({ name: 'Delta Dust', category: '', active_ingredient: 'Deltamethrin 0.05%' })])).toBe('Insect treatment');
    expect(derive([cat({ name: 'Elector PSP', category: '', active_ingredient: 'Spinosad 44.2%' })])).toBe('Insect treatment');
    // Trade-name-only sparse row: Uncategorized, no active recorded.
    expect(derive([cat({ name: 'Bifen XTS', category: 'Uncategorized' })])).toBe('Insect treatment');
  });

  test('real spray oils derive the Horticultural oil chip, not generic insect (audit P1)', () => {
    expect(derive([cat({ name: 'SuffOil-X Spray Oil Emulsion', category: 'Insecticide', active_ingredient: 'Mineral oil 80%' })])).toBe('Horticultural oil');
    expect(derive([cat({ name: 'TriTek Spray Oil Emulsion', category: 'Insecticide', active_ingredient: 'Mineral oil' })])).toBe('Horticultural oil');
    expect(derive([cat({ name: 'Horticultural Oil Concentrate', category: 'insecticide' })])).toBe('Horticultural oil');
  });

  test('chelated micronutrient rows derive Micronutrients, not empty', () => {
    expect(derive([cat({ name: 'LESCO Chelated Iron Plus', category: 'Uncategorized', active_ingredient: 'Iron + N (foliar)' })])).toBe('Micronutrients');
  });

  test('support products (adjuvants/surfactants/PGRs) make NO treatment claim (codex P3 r4)', () => {
    for (const row of [
      cat({ name: 'LESCO 90/10 Nonionic Surfactant', category: 'Adjuvant' }),
      cat({ name: 'BRANDT Indicate 5', category: 'Adjuvant' }),
      cat({ name: 'Shortstop 2SC Plant Growth Regulator for Trees & Shrubs', category: 'Plant Growth Regulator' }),
    ]) {
      expect(derive([row])).toBe('');
    }
    // A support product beside a classified product adds nothing — the
    // classified chip stands alone.
    const mixed = derive([
      cat({ id: 'a', name: 'LESCO 90/10 Nonionic Surfactant', category: 'Adjuvant' }),
      cat({ id: 'b', name: 'Dominion 2L', category: 'insecticide' }),
    ]);
    expect(mixed).toBe('Insect treatment');
  });

  test('explicit soil_drench method derives the Soil drench chip; default foliar does not (codex P2 r6)', () => {
    const rows = [cat({ name: 'Merit 2F', category: 'Insecticide', active_ingredient: 'Imidacloprid' })];
    const drenched = deriveTreeShrubTreatments({
      products: [{ productId: 'p1', applicationMethod: 'soil_drench' }],
      productRows: rows,
    });
    expect(drenched).toContain('Soil drench');
    expect(drenched).toContain('Insect treatment');
    // foliar_spray is the T&S line-wide DEFAULT method — deriving from it
    // would stamp every report, so it must add nothing.
    const foliar = deriveTreeShrubTreatments({
      products: [{ productId: 'p1', applicationMethod: 'foliar_spray' }],
      productRows: rows,
    });
    expect(foliar).toBe('Insect treatment');
  });

  test('every derived chip is a legal treatments_completed option', () => {
    const options = PROJECT_TYPES.tree_shrub.findingsFields.find((f) => f.key === 'treatments_completed').options;
    const out = derive([
      cat({ id: 'a', name: 'Dominion 2L', category: 'insecticide' }),
      cat({ id: 'b', name: 'Palm Fertilizer 8-2-12', category: 'fertilizer' }),
      cat({ id: 'c', name: 'Banner Maxx', category: 'fungicide' }),
    ]);
    for (const chip of out.split(',').map((x) => x.trim())) {
      expect(options).toContain(chip);
    }
  });

  test('derived chips satisfy the chip↔product compliance rule by construction', () => {
    const rows = [cat({ name: 'Dominion 2L', category: 'insecticide' })];
    const values = {
      plant_groups: 'Shrubs',
      landscape_condition: 'Good',
      treatments_completed: deriveTreeShrubTreatments({ products: [{ productId: 'p1', amount: 2, amountUnit: 'oz' }], productRows: rows }),
      pollinator_status: 'No blooms or no bees',
      irac_frac_logged: 'Yes',
    };
    const result = validateTreeShrubTypedCompliance({
      service: { address_line1: '1 Test St', city: 'Parrish' },
      serviceDate: '2026-03-10',
      values,
      products: [{ productId: 'p1', amount: 2, amountUnit: 'oz' }],
      productRows: rows,
      completionPhotos: ['a', 'b'],
    });
    expect(result.blocks.filter((b) => b.code === 'tree_shrub_products_required')).toEqual([]);
  });
});
