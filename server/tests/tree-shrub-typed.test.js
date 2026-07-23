/**
 * Tree & Shrub typed checklist (owner spec 2026-06-12, Phase 2 §6; simplified
 * 2026-07-21 and again 2026-07-23): the tech types scope + condition only —
 * condition detail comes from the AI photo review, treatments derive from
 * the recorded products. Covers the schema shape, owner-template Today's
 * Result composition, the legacy-field cutover, and the ported legacy
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
  treatments_completed: 'Fertilizer, Palm fertilizer, Insect treatment',
  customer_recommendations: 'Avoid over-pruning, Keep mulch off trunks / stems, Monitor decline',
};

// The hand-entered condition/detail fields left the PRIMARY form 2026-07-23
// (the AI photo review is the source there). They survive as companionOnly:
// COMPANION T&S sections on combined visits run no per-line photo
// assessment, so hand capture stays the only condition source there (codex
// P2 on #2950). A primary submission carrying any of them must reject as an
// unknown field — the primary cutover is total, not soft.
const COMPANION_ONLY_FIELD_KEYS = [
  'observed_conditions', 'palms_serviced', 'palm_condition',
  'palm_nutrient_stress', 'spear_leaf_condition', 'canopy_density',
  'palm_trunk_concern', 'ganoderma_conk_observed', 'injection_recommended',
  'pest_pressure', 'disease_pressure', 'deficiency_symptoms',
  'new_growth_present', 'pruning_issue_observed', 'irrigation_issue_observed',
  'bed_weed_pressure', 'pre_emergent_applied', 'mulch_depth_concern',
  'weed_breakthrough_areas',
];

describe('tree & shrub schema', () => {
  test('primary slice carries the simplified sections and a required core', () => {
    const config = PROJECT_TYPES.tree_shrub;
    expect(config).toBeTruthy();
    const primarySections = new Set(findingsSchemaForType('tree_shrub').fields.map((f) => f.section));
    for (const section of ['Service scope', 'Treatments', 'Compliance', 'Recommendations']) {
      expect(primarySections.has(section)).toBe(true);
    }
    // Owner directive 2026-07-23: the detail modules are gone from the
    // PRIMARY form — the AI photo review carries condition detail there.
    for (const section of ['Observed conditions', 'Palm module', 'Shrub & ornamental module', 'Bed & pre-emergent module']) {
      expect(primarySections.has(section)).toBe(false);
    }
    // Only scope + condition are typed by hand — treatments derive from
    // products, everything condition-grade comes from the AI photo review.
    expect(REQUIRED_FINDINGS_FIELDS.tree_shrub).toEqual([
      'plant_groups', 'landscape_condition',
    ]);
    expect(nextStepRequiredForType('tree_shrub')).toBe(true);
  });

  test('simplified-closeout field flags (owner directives 2026-07-21 / 2026-07-23)', () => {
    const schema = findingsSchemaForType('tree_shrub');
    const byKey = Object.fromEntries(schema.fields.map((f) => [f.key, f]));
    // Treatments never render on the PRIMARY form — derived from products at
    // completion (companion sections render it as a dropdown; the shared
    // products list on combined visits can't be attributed per line).
    expect(byKey.treatments_completed.autoFilled).toBe(true);
    expect(byKey.treatments_completed.type).toBe('multi_select');
    // The manual condition/detail fields are gone from the primary slice.
    for (const key of COMPANION_ONLY_FIELD_KEYS) {
      expect({ key, present: key in byKey }).toEqual({ key, present: false });
    }
    // Core scope fields stay primary (no expander left to hide behind).
    expect(byKey.plant_groups.detail).toBe(false);
    expect(byKey.landscape_condition.detail).toBe(false);
    expect(schema.fields.some((f) => f.detail)).toBe(false);
    // Compliance renders only once a pesticide product is on the visit.
    expect(byKey.pollinator_status.pesticideOnly).toBe(true);
    expect(byKey.irac_frac_logged.pesticideOnly).toBe(true);
    // Multi-value fields are dropdowns; the comma-joined storage contract
    // is shared with chips so downstream consumers are unaffected.
    expect(byKey.plant_groups.type).toBe('multi_select');
    expect(byKey.customer_recommendations.type).toBe('multi_select');
  });

  test('companion slice keeps the condition detail fields behind the expander (codex P2 on #2950)', () => {
    // Combined visits (lawn + T&S companion) run no per-line AI assessment,
    // so the companion form retains the hand-entered condition capture the
    // primary form dropped — collapsed as optional detail, exactly as the
    // pre-cutover form served them.
    const companion = findingsSchemaForType('tree_shrub', { companion: true });
    const byKey = Object.fromEntries(companion.fields.map((f) => [f.key, f]));
    for (const key of COMPANION_ONLY_FIELD_KEYS) {
      expect({ key, present: key in byKey, detail: byKey[key]?.detail }).toEqual({ key, present: true, detail: true });
    }
    // The companion core matches the primary core.
    expect(byKey.plant_groups.detail).toBe(false);
    expect(byKey.landscape_condition.detail).toBe(false);
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
    expect(byKey.customer_recommendations.internal).toBe(false);
  });

  test('every tree_shrub next-step chip has a sentence', () => {
    for (const chip of TYPE_NEXT_STEP_CHIPS.tree_shrub) {
      expect({ chip, hasSentence: !!NEXT_STEP_CHIPS[chip] }).toEqual({ chip, hasSentence: true });
    }
  });
});

describe('owner template composition', () => {
  test('condition-led headline + scope + treatments + next step', () => {
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
    expect(result.body).toContain('We will continue your Tree & Shrub care program.');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('primary completions compose without a palm note — the fields no longer exist there (owner 2026-07-23)', () => {
    // BASE_VALUES is the post-cutover primary shape (no Ganoderma/trunk
    // fields), so even a palms-in-scope primary visit composes without the
    // reassurance sentence; palm detail reaches the customer through the AI
    // photo review on the V2 report.
    const result = buildTodaysResult({
      projectType: 'tree_shrub',
      reportTypeLabel: 'Tree & Shrub Service Summary',
      values: BASE_VALUES,
      chips: ['Monitor plant response'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.body).not.toContain('Ganoderma');
  });

  test('companion values keep the coupled Ganoderma reassurance / flag (codex P2 on #2950)', () => {
    // Companion sections still hand-capture the palm module, so their
    // Today's Result keeps the owner-template palm note.
    const companionValues = { ...BASE_VALUES, ganoderma_conk_observed: 'No', palm_trunk_concern: 'No' };
    const clean = buildTodaysResult({
      projectType: 'tree_shrub',
      reportTypeLabel: 'Tree & Shrub Service Summary',
      values: companionValues,
      chips: ['Continue Tree & Shrub program'],
      activity: null,
      visitSequence: 1,
    });
    expect(clean.body).toContain('No visible Ganoderma conks or trunk decay were observed on the palms today.');

    const flagged = buildTodaysResult({
      projectType: 'tree_shrub',
      reportTypeLabel: 'Tree & Shrub Service Summary',
      values: { ...companionValues, ganoderma_conk_observed: 'Yes', landscape_condition: 'Declining' },
      chips: ['Arborist review recommended'],
      activity: null,
      visitSequence: 1,
    });
    expect(flagged.headline).toBe('Overall landscape condition is declining — see the recommendations below.');
    expect(flagged.body).toContain('A possible Ganoderma conk was observed on a palm — an arborist evaluation is recommended.');

    const trunkConcern = buildTodaysResult({
      projectType: 'tree_shrub',
      reportTypeLabel: 'Tree & Shrub Service Summary',
      values: { ...companionValues, palm_trunk_concern: 'Yes' },
      chips: ['Monitor plant response'],
      activity: null,
      visitSequence: 1,
    });
    expect(trunkConcern.body).toContain('No visible Ganoderma conks were observed on the palms today.');
    expect(trunkConcern.body).not.toContain('or trunk decay');

    // Stray palm values never claim palm findings on a non-palm visit.
    const nonPalm = buildTodaysResult({
      projectType: 'tree_shrub',
      reportTypeLabel: 'Tree & Shrub Service Summary',
      values: { ...companionValues, plant_groups: 'Shrubs' },
      chips: ['Continue Tree & Shrub program'],
      activity: null,
      visitSequence: 1,
    });
    expect(nonPalm.body).not.toContain('Ganoderma');
  });
});

describe('validation', () => {
  test('the minimal scope + condition submission passes with nothing else', () => {
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
  });

  test('companion-only fields reject as unknown on the PRIMARY path — the cutover is total (owner 2026-07-23)', () => {
    // A stale client (or restored pre-cutover draft that escaped the client
    // prune) submitting any companion-only field on a primary completion
    // must fail loudly, not persist hand-entered condition data the primary
    // form can no longer edit.
    for (const key of COMPANION_ONLY_FIELD_KEYS) {
      const result = validateTypedFindings({
        type: 'tree_shrub',
        values: { ...BASE_VALUES, [key]: key === 'palms_serviced' ? '4' : 'Yes' },
        expectedType: 'tree_shrub',
        enforceRequired: true,
      });
      expect({ key, ok: result.ok }).toEqual({ key, ok: false });
      expect(result.errors.join(' ')).toMatch(new RegExp(`Unknown findings field: ${key}`));
    }
  });

  test('companion submissions accept the condition detail fields (codex P2 on #2950)', () => {
    const result = validateTypedFindings({
      type: 'tree_shrub',
      values: {
        plant_groups: 'Palms, Shrubs',
        landscape_condition: 'Good',
        treatments_completed: 'Fertilizer',
        observed_conditions: 'Scale, Yellowing / chlorosis',
        palm_condition: 'Fair',
        ganoderma_conk_observed: 'No',
        pest_pressure: 'Light',
      },
      expectedType: 'tree_shrub',
      enforceRequired: true,
      companion: true,
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
  });

  test('companion cross-field coherence still enforced (No-major-issues / palm scope / pre-emergent)', () => {
    const base = {
      plant_groups: 'Palms, Shrubs',
      landscape_condition: 'Fair',
      treatments_completed: 'Fertilizer',
    };
    for (const extra of [
      { observed_conditions: 'No major issues observed, Scale' },
      { observed_conditions: 'No major issues observed', pest_pressure: 'Heavy' },
      { observed_conditions: 'No major issues observed', ganoderma_conk_observed: 'Yes' },
      { observed_conditions: 'No major issues observed', pruning_issue_observed: 'Yes' },
    ]) {
      const result = validateTypedFindings({
        type: 'tree_shrub',
        values: { ...base, ...extra },
        expectedType: 'tree_shrub',
        enforceRequired: true,
        companion: true,
      });
      expect(result.ok).toBe(false);
      expect(result.errors.join(' ')).toMatch(/No major issues observed/);
    }

    const palmScope = validateTypedFindings({
      type: 'tree_shrub',
      values: { ...base, plant_groups: 'Shrubs, Hedges', palm_condition: 'Fair', ganoderma_conk_observed: 'No' },
      expectedType: 'tree_shrub',
      enforceRequired: true,
      companion: true,
    });
    expect(palmScope.ok).toBe(false);
    expect(palmScope.errors.join(' ')).toMatch(/Palms is not among the serviced plant groups/);

    const preEmergent = validateTypedFindings({
      type: 'tree_shrub',
      values: { ...base, treatments_completed: 'Inspection only', pre_emergent_applied: 'Yes' },
      expectedType: 'tree_shrub',
      enforceRequired: true,
      companion: true,
    });
    expect(preEmergent.ok).toBe(false);
    expect(preEmergent.errors.join(' ')).toMatch(/Pre-emergent applied/);
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
    // The customer-visible findings are exactly the simplified scope story.
    expect(findingKeys).toEqual(['plant_groups', 'landscape_condition', 'treatments_completed', 'customer_recommendations']);
    expect(findBannedCustomerCopy(JSON.stringify(snapshot))).toEqual([]);
  });

  test('detail-field value labels stay renderable (legacy snapshots + companion sections)', () => {
    // Old visits persisted these fields into their immutable snapshots, and
    // companion sections still collect them live — the copy maps must keep
    // rendering them even though the primary form no longer does.
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
