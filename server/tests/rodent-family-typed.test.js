/**
 * Rodent family typed flows (owner spec 2026-06-12, Phase 2 §§1–4):
 * dedicated exclusion (repair story) + sanitation (cleanup story) +
 * inspection (diagnostic story) forms, combo-module serving per service
 * key, and the owner wording rules (never "rodent-proof"; reduce-access
 * phrasing; observational absence claims).
 */
const {
  ACTIVITY_INDICATORS,
  REQUIRED_FINDINGS_FIELDS,
  TYPE_NEXT_STEP_CHIPS,
  NEXT_STEP_CHIPS,
  customerLabelForValue,
  findBannedCustomerCopy,
  getActivityIndicator,
  nextStepRequiredForType,
  validateTypedFindings,
  buildTodaysResult,
  buildTypedReportSnapshot,
  findingsSchemaForType,
} = require('../services/service-report/activity-indicators');
const { PROJECT_TYPES } = require('../services/project-types');

// Post-simplification shapes (owner 2026-07-23): exclusion_areas /
// evidence_cleaned / the three inspection Assessment selects retired — the
// remaining fields carry the full report story.
const EXCLUSION_VALUES = {
  entry_points_addressed: 'AC line penetration, Garage door gaps',
  exclusion_work_completed: 'Sealed entry point, Installed hardware cloth / mesh',
  exclusion_materials: 'Rodent-resistant mesh, Sealant',
  remaining_concerns: 'Tree limbs touching roof, Trapping still active',
};

const SANITATION_VALUES = {
  sanitation_areas: 'Attic, Garage',
  contamination_level: 'Moderate',
  sanitation_work_completed: 'Removed droppings, Removed nesting material, Disinfected / sanitized affected areas, Deodorized affected areas',
  sanitation_limitations: 'Insulation contamination remains, Electrical / HVAC obstruction',
};

const INSPECTION_VALUES = {
  areas_inspected: 'Exterior perimeter, Garage, Attic access',
  activity_found: 'Yes',
  evidence_observed: 'Droppings, Gnaw marks',
  species: 'Rat',
  entry_points_found: 'AC line gap right side',
  recommended_service: 'Rodent trapping program',
  urgency: 'Soon',
};

describe('rodent family schemas', () => {
  test('three distinct stories — repair, cleanup, diagnostic', () => {
    const exclusion = Object.fromEntries(PROJECT_TYPES.rodent_exclusion.findingsFields.map((f) => [f.key, f]));
    const sanitation = Object.fromEntries(PROJECT_TYPES.rodent_sanitation.findingsFields.map((f) => [f.key, f]));
    const inspection = Object.fromEntries(PROJECT_TYPES.rodent_inspection.findingsFields.map((f) => [f.key, f]));
    expect(exclusion.entry_points_addressed).toBeTruthy();
    expect(exclusion.exclusion_materials).toBeTruthy();
    expect(exclusion.traps_set).toBeUndefined();
    expect(sanitation.contamination_level.options).toContain('Severe — office review needed');
    expect(sanitation.entry_points_addressed).toBeUndefined();
    expect(inspection.recommended_service).toBeTruthy();
    expect(inspection.urgency.options).toEqual(['Routine', 'Soon', 'High']);
    for (const type of ['rodent_exclusion', 'rodent_sanitation', 'rodent_inspection']) {
      expect(nextStepRequiredForType(type)).toBe(true);
      for (const chip of TYPE_NEXT_STEP_CHIPS[type]) {
        expect({ type, chip, hasSentence: !!NEXT_STEP_CHIPS[chip] }).toEqual({ type, chip, hasSentence: true });
      }
    }
  });

  test('gauges: exclusion + inspection share the rodent trend; sanitation has NONE', () => {
    expect(ACTIVITY_INDICATORS.rodent_exclusion.indicatorKey).toBe('rodent_activity');
    expect(ACTIVITY_INDICATORS.rodent_inspection.indicatorKey).toBe('rodent_activity');
    // Contamination is a cleanup measure — never on the activity trend.
    expect(getActivityIndicator('rodent_sanitation')).toBeNull();
  });

  test('combo modules are served per service key (owner spec §3)', () => {
    const plain = findingsSchemaForType('rodent_trapping', { serviceKey: 'rodent_trapping' });
    const combo = findingsSchemaForType('rodent_trapping', { serviceKey: 'rodent_trapping_exclusion_sanitation' });
    const exclusionOnly = findingsSchemaForType('rodent_trapping', { serviceKey: 'rodent_trapping_exclusion' });
    const plainKeys = plain.fields.map((f) => f.key);
    expect(plainKeys).not.toContain('entry_points_addressed');
    expect(plainKeys).not.toContain('sanitation_areas');
    expect(combo.fields.map((f) => f.key)).toEqual(expect.arrayContaining(['entry_points_addressed', 'sanitation_areas']));
    const exclusionKeys = exclusionOnly.fields.map((f) => f.key);
    expect(exclusionKeys).toContain('entry_points_addressed');
    expect(exclusionKeys).not.toContain('sanitation_areas');
    // Unknown context (AI draft labeling) keeps the full registry.
    const unscoped = findingsSchemaForType('rodent_trapping');
    expect(unscoped.fields.map((f) => f.key)).toContain('entry_points_addressed');
  });
});

describe('exclusion report (owner template §1)', () => {
  test('repair story with reduce-access headline, never "rodent-proof"', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_exclusion',
      reportTypeLabel: 'Rodent Exclusion Summary',
      values: EXCLUSION_VALUES,
      chips: ['Continue trapping', 'Customer repair needed'],
      activity: { score: 2 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('Exclusion repairs were completed to reduce rodent access and help prevent re-entry.');
    // exclusion_areas retired 2026-07-23 — the generic opener + the
    // entry-points sentence carry the location story.
    expect(result.body).toContain('Completed rodent exclusion work today.');
    expect(result.body).toContain('Entry points addressed included the ac line penetration and garage door gaps.');
    expect(result.body).toContain('Materials used included rodent-resistant mesh and sealant.');
    expect(result.body).toContain('Remaining concerns: tree limbs touching roof and trapping still active.');
    expect(result.body).toContain('Trapping will continue until activity is reduced.');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('clean exclusion gets the no-remaining-concerns sentence', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_exclusion',
      reportTypeLabel: 'Rodent Exclusion Summary',
      values: { ...EXCLUSION_VALUES, remaining_concerns: 'No remaining concerns observed' },
      chips: ['No follow-up needed'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(result.body).toContain('No remaining concerns were observed today.');
  });
});

describe('sanitation report (owner template §2)', () => {
  test('cleanup story with level, evidence, limitations', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_sanitation',
      reportTypeLabel: 'Rodent Sanitation Summary',
      values: SANITATION_VALUES,
      chips: ['Complete exclusion', 'Continue trapping'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.headline).toBe('Moderate rodent contamination was cleaned and sanitized today.');
    expect(result.body).toContain('Completed rodent sanitation service in the attic and garage.');
    expect(result.body).toContain('Contamination level was moderate.');
    // evidence_cleaned retired 2026-07-23 — the work-chip verb phrases carry
    // the removal story instead of a second "we removed and treated" line.
    expect(result.body).toContain('We removed droppings, removed nesting material, disinfected and sanitized the affected areas and deodorized the service areas today.');
    expect(result.body).toContain('Some areas had limitations: insulation contamination remains and electrical / hvac obstruction.');
    expect(result.body).toContain('Completing the exclusion repairs is the key next step.');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('severe contamination promises office follow-up without saying "office review"', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_sanitation',
      reportTypeLabel: 'Rodent Sanitation Summary',
      values: { ...SANITATION_VALUES, contamination_level: 'Severe — office review needed' },
      chips: ['Additional sanitation recommended'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.headline).toBe('Severe rodent contamination was cleaned and sanitized today.');
    expect(result.body).toContain('our office will follow up with you on next steps');
    expect(customerLabelForValue('contamination_level', 'Severe — office review needed')).not.toContain('office review');
  });
});

describe('inspection report (owner template §4)', () => {
  test('diagnostic + sales-supportive when activity is found', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_inspection',
      reportTypeLabel: 'Rodent Inspection Summary',
      values: INSPECTION_VALUES,
      chips: ['Treatment recommended', 'Estimate to follow'],
      activity: { score: 3 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('Rodent activity was found during today’s inspection.');
    expect(result.body).toContain('We inspected the exterior perimeter, garage and attic access.');
    expect(result.body).toContain('Possible entry points were noted: AC line gap right side.');
    expect(result.body).toContain('we recommend rodent trapping program');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('clean inspection stays observational', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_inspection',
      reportTypeLabel: 'Rodent Inspection Summary',
      values: {
        areas_inspected: 'Exterior perimeter, Garage',
        activity_found: 'No',
        interior_concern: 'No',
        exterior_pressure: 'No',
        photos_taken: 'Yes',
        recommended_service: 'No service needed at this time',
        urgency: 'Routine',
      },
      chips: ['No action needed'],
      activity: { score: 0 },
      visitSequence: 1,
    });
    expect(result.headline).toBe('No current rodent activity was observed during today’s inspection.');
    expect(result.body).toContain('No service is needed at this time');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });
});

describe('combo trapping narrative (owner template §3)', () => {
  test('exclusion + sanitation module work rides the trap sentence', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: {
        species: 'Roof rat',
        traps_checked: '6',
        captures: '1',
        trap_actions: 'Traps reset',
        entry_points_addressed: 'AC line penetration',
        exclusion_materials: 'Rodent-resistant mesh, Sealant',
        sanitation_areas: 'Attic',
        contamination_level: 'Light',
        evidence_cleaned: 'Droppings',
      },
      chips: ['Continue trapping'],
      activity: { score: 2 },
      // A follow-up stop: the traps were already out (reset, with a capture)
      // and the combo modules ran alongside the re-check. Visit 1 is the
      // trap-SETUP lane and has its own wording — covered separately below.
      visitSequence: 2,
    });
    expect(result.body).toContain('We checked 6 traps, removed 1 capture and reset the traps today.');
    expect(result.body).toContain('We also completed exclusion work at the ac line penetration using rodent-resistant mesh and sealant.');
    expect(result.body).toContain('We also completed light sanitation cleanup in the attic.');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('pure trap check narrative is unchanged by empty modules', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { species: 'Roof rat', traps_checked: '4', captures: '0', trap_actions: 'Traps reset' },
      chips: ['Continue trapping'],
      activity: { score: 1 },
      visitSequence: 2,
    });
    expect(result.body).not.toContain('We also completed');
  });
});

// Owner 2026-08-02: "the rodent trapping reports don't really account for the
// fact that it was a first time trapping — it always assumes that it's a
// secondary trapping"… and then: "it could be just the first time trapping,
// but it also could be the second time trapping. So the traps checked thing
// in there could be traps set or traps checked." So the TECH declares it via
// trap_visit_type; the visit number is only the fallback.
describe('trap setup vs. re-check — the tech declares it', () => {
  const SETUP_VALUES = {
    species: 'Roof rat',
    evidence_observed: 'Droppings, Rub marks / grease trails',
    traps_checked: '8',
    captures: '0',
    trap_actions: 'New traps added',
  };
  const todaysResult = (values, visitSequence) => buildTodaysResult({
    projectType: 'rodent_trapping',
    reportTypeLabel: 'Rodent Trapping Summary',
    values,
    chips: ['Continue trapping'],
    activity: { score: 3 },
    visitSequence,
  });

  test('a setup declared on a LATER visit still reads as a setup', () => {
    // The case the visit counter gets wrong: trapping that starts after a
    // rodent inspection already scored the property.
    const result = todaysResult({ ...SETUP_VALUES, trap_visit_type: 'Initial setup' }, 4);
    expect(result.body).toContain('We set 8 traps today.');
    expect(result.body).toContain('We return to check them, record what they catch');
    expect(result.body).not.toMatch(/checked \d+ traps/);
  });

  // codex P2 round 2 on #3159: this is the MAIN case the selector exists for
  // — trapping that starts after a rodent inspection already scored the
  // property. Production supplies visitSequence > 1 AND a trendWord for it,
  // which routed it into the trend branch and dropped the setup guidance.
  // The earlier later-visit test missed it by not supplying a trendWord.
  test('a setup on a TREND visit keeps both the trend headline and the setup guidance', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { ...SETUP_VALUES, trap_visit_type: 'Initial setup' },
      chips: ['Continue trapping'],
      activity: { score: 2, trend: 'improving', trendWord: 'decreased' },
      visitSequence: 3,
    });
    expect(result.headline).toBe('Rodent activity has decreased since our last visit.');
    expect(result.body).toContain('We set 8 traps today.');
    expect(result.body).toContain('We return to check them, record what they catch');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('a re-check declared on visit 1 reads as a re-check', () => {
    // The inverse: traps were already out (set at an earlier untyped stop,
    // or by the customer), so visit 1 is genuinely a check.
    const result = todaysResult({ ...SETUP_VALUES, trap_visit_type: 'Follow-up check' }, 1);
    expect(result.body).toContain('We checked 8 traps, found no new captures and added new traps today.');
    expect(result.body).not.toContain('We return to check them, record what they catch');
  });

  test('the declared value drives the count label, not the visit number', () => {
    const snapshot = (values, visitSequence) => buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      serviceKey: 'rodent_trapping_check',
      serviceLabel: 'Rodent Trapping',
      values,
      nextStepChips: ['Continue trapping'],
      visitSequence,
      activity: { indicatorKey: 'rodent_activity', label: 'Rodent Activity', score: 3, source: 'tech' },
    });
    const labelOf = (snap) => snap.findings.find((f) => f.fieldKey === 'traps_checked').customerLabel;

    expect(labelOf(snapshot({ ...SETUP_VALUES, trap_visit_type: 'Initial setup' }, 4))).toBe('Traps set');
    expect(labelOf(snapshot({ ...SETUP_VALUES, trap_visit_type: 'Follow-up check' }, 1))).toBe('Traps checked');
  });

  test('the selector itself never becomes a customer-facing finding row', () => {
    const snapshot = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      serviceKey: 'rodent_trapping_setup',
      serviceLabel: 'Rodent Trapping',
      values: { ...SETUP_VALUES, trap_visit_type: 'Initial setup' },
      nextStepChips: ['Continue trapping'],
      visitSequence: 1,
      activity: { indicatorKey: 'rodent_activity', label: 'Rodent Activity', score: 3, source: 'tech' },
    });
    // internal: it switches the wording, it is not itself a finding.
    expect(snapshot.findings.some((f) => f.fieldKey === 'trap_visit_type')).toBe(false);
    // …but it is still stored on the snapshot, so the narrative and any
    // replay resolve the same stage the report was written with.
    expect(snapshot.values.trap_visit_type).toBe('Initial setup');
  });

  test('trap_visit_type validates against its options', () => {
    expect(validateTypedFindings({
      type: 'rodent_trapping',
      values: { ...SETUP_VALUES, trap_visit_type: 'Initial setup' },
      expectedType: 'rodent_trapping',
      enforceRequired: true,
    }).ok).toBe(true);

    expect(validateTypedFindings({
      type: 'rodent_trapping',
      values: { ...SETUP_VALUES, trap_visit_type: 'First one ever' },
      expectedType: 'rodent_trapping',
      enforceRequired: true,
    }).ok).toBe(false);
  });

  // codex P2 on #3159: left optional, a blank selector rendered the static
  // "Traps checked" label on the form while the server's visitSequence
  // fallback froze "Traps set" into the report — the tech entering a count
  // under one meaning and the customer reading the other.
  test('a closeout cannot be submitted without declaring the visit', () => {
    const result = validateTypedFindings({
      type: 'rodent_trapping',
      values: SETUP_VALUES,
      expectedType: 'rodent_trapping',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('trap_visit_type');
  });

  test('an undeclared snapshot keeps re-check wording at every sequence', () => {
    // The visitSequence fallback was REMOVED (codex P0): inferring setup from
    // a missing field reclassified every pre-change report at view time.
    expect(todaysResult(SETUP_VALUES, 1).body).toContain('We checked 8 traps');
    expect(todaysResult(SETUP_VALUES, 2).body).toContain('We checked 8 traps');
  });

  // codex P2 on #3159: "we removed 1 capture" beside "we check them and
  // record what they catch" reads as a contradiction.
  test('a capture on a setup visit drops the nothing-caught-yet line, keeps the capture', () => {
    const result = todaysResult(
      { ...SETUP_VALUES, captures: '1', trap_visit_type: 'Initial setup' },
      1,
    );
    expect(result.body).toContain('We set 8 traps and removed 1 capture today.');
    expect(result.body).not.toContain('We return to check them, record what they catch');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('a declared setup reads as one — traps SET, no re-check or empty-check wording', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { ...SETUP_VALUES, trap_visit_type: 'Initial setup' },
      chips: ['Continue trapping'],
      activity: { score: 3 },
      visitSequence: 1,
    });
    expect(result.body).toContain('We set 8 traps today.');
    expect(result.body).toContain('We return to check them, record what they catch');
    expect(result.body).not.toMatch(/checked \d+ traps/);
    // Traps placed today have had no chance to catch anything.
    expect(result.body).not.toContain('found no new captures');
    // The placement chip is already carried by the count sentence.
    expect(result.body).not.toContain('added new traps');
    expect(findBannedCustomerCopy(JSON.stringify(result))).toEqual([]);
  });

  test('visit 2+ keeps the re-check story', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: SETUP_VALUES,
      chips: ['Continue trapping'],
      activity: { score: 3 },
      visitSequence: 2,
    });
    expect(result.body).toContain('We checked 8 traps, found no new captures and added new traps today.');
    expect(result.body).not.toContain('We return to check them, record what they catch');
  });

  test('the declared setup relabels the count finding to "Traps set"', () => {
    const setup = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      serviceKey: 'rodent_trapping_setup',
      serviceLabel: 'Rodent Trapping',
      values: { ...SETUP_VALUES, trap_visit_type: 'Initial setup' },
      nextStepChips: ['Continue trapping'],
      // Sequence is irrelevant now — the declaration decides.
      visitSequence: 4,
      activity: { indicatorKey: 'rodent_activity', label: 'Rodent Activity', score: 3, source: 'tech' },
    });
    expect(setup.findings.find((f) => f.fieldKey === 'traps_checked').customerLabel).toBe('Traps set');

    const followUp = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      serviceKey: 'rodent_trapping_check',
      serviceLabel: 'Rodent Trapping',
      values: SETUP_VALUES,
      nextStepChips: ['Continue trapping'],
      visitSequence: 2,
      activity: { indicatorKey: 'rodent_activity', label: 'Rodent Activity', score: 3, source: 'tech' },
    });
    expect(followUp.findings.find((f) => f.fieldKey === 'traps_checked').customerLabel).toBe('Traps checked');
  });

  test('wildlife trapping is untouched — its own Trap installed chip already reads right', () => {
    const result = buildTodaysResult({
      projectType: 'wildlife_trapping',
      reportTypeLabel: 'Wildlife Trapping Summary',
      values: { target_animal: 'Raccoon', traps_checked: '3', trap_actions: 'Trap installed' },
      chips: ['Continue trapping'],
      activity: null,
      visitSequence: 1,
    });
    expect(result.body).toContain('We checked 3 traps and installed traps today.');
  });
});

// Owner 2026-08-02: the trapping report "isn't pulling in the Generate AI
// report". The gauge branch silently dropped the reviewed body, so the
// snapshot never stamped bodySource and report-data kept the generic recap.
describe('tech-reviewed AI report copy on rodent trapping', () => {
  const AI_BODY = 'We placed eight snap traps along the attic runways and the garage wall. '
    + 'Droppings and rub marks were concentrated near the A/C plenum.';

  test('the reviewed body drives the Today’s Result body and stamps bodySource', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { species: 'Roof rat', traps_checked: '8' },
      chips: ['Continue trapping'],
      activity: { score: 3 },
      visitSequence: 1,
      technicianReportBody: AI_BODY,
    });
    expect(result.body).toContain(AI_BODY);
    expect(result.body).not.toContain('We set 8 traps today.');
    expect(result.bodySource).toBe('technician_report');
    // The gauge still owns the headline — AI copy never sets the reading.
    expect(result.headline).toBe('Rodent activity was moderate today.');
  });

  test('a trend visit takes it too, headline still deterministic', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { species: 'Roof rat', traps_checked: '8' },
      chips: ['Continue trapping'],
      activity: { score: 2, trend: 'improving', trendWord: 'decreased' },
      visitSequence: 3,
      technicianReportBody: AI_BODY,
    });
    expect(result.body).toContain(AI_BODY);
    expect(result.bodySource).toBe('technician_report');
    expect(result.headline).toBe('Rodent activity has decreased since our last visit.');
  });

  test('the zero state keeps the template body — a draft must not outrank a typed zero', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { species: 'Roof rat', traps_checked: '8', captures: '0' },
      chips: ['Monitor after no activity'],
      activity: { score: 0 },
      visitSequence: 2,
      technicianReportBody: AI_BODY,
    });
    expect(result.body).not.toContain(AI_BODY);
    expect(result).not.toHaveProperty('bodySource');
  });

  // codex P1 on #3159. A repeat visit with a prior score ALWAYS carries a
  // trendWord (admin-dispatch resolves one), so a gauge the tech flipped to
  // zero reaches the trend branch before the zero-state guard below it — and
  // published a draft written while activity still looked heavy. The first
  // zero-state test missed this purely because it supplied no trendWord.
  test('a zero score on a TREND visit also refuses the draft', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { species: 'Roof rat', traps_checked: '8', captures: '0', trap_visit_type: 'Follow-up check' },
      chips: ['Monitor after no activity'],
      activity: { score: 0, trend: 'improving', trendWord: 'decreased' },
      visitSequence: 3,
      technicianReportBody: AI_BODY,
    });
    expect(result.body).not.toContain(AI_BODY);
    expect(result.body).not.toMatch(/heavy/i);
    expect(result).not.toHaveProperty('bodySource');
    // The gauge headline is untouched — only the body refuses the draft.
    expect(result.headline).toBe('Rodent activity has decreased since our last visit.');
  });

  // codex P1 round 2 on #3159. The draft prompt never receives
  // trap_visit_type, and the tech can flip the selector AFTER generating —
  // so a re-check draft could ride onto a declared setup, stamped and
  // published, with the setup line appended right after it.
  test('a draft contradicting a declared setup is refused, not published', () => {
    const RECHECK_DRAFT = 'We checked 8 traps and found no captures today. '
      + 'Droppings were noted near the plenum.';
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { species: 'Roof rat', traps_checked: '8', captures: '0', trap_visit_type: 'Initial setup' },
      chips: ['Continue trapping'],
      activity: { score: 3 },
      visitSequence: 1,
      technicianReportBody: RECHECK_DRAFT,
    });
    expect(result.body).not.toContain('checked 8 traps');
    expect(result).not.toHaveProperty('bodySource');
    // Falls back to the deterministic sentence, which is stage-correct
    // because it is composed from the same declaration.
    expect(result.body).toContain('We set 8 traps today.');
  });

  test('a stage-CORRECT draft on a declared setup is still used', () => {
    const SETUP_DRAFT = 'We set 8 traps along the attic runways and the garage wall. '
      + 'Droppings and rub marks were concentrated near the A/C plenum.';
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { species: 'Roof rat', traps_checked: '8', trap_visit_type: 'Initial setup' },
      chips: ['Continue trapping'],
      activity: { score: 3 },
      visitSequence: 1,
      technicianReportBody: SETUP_DRAFT,
    });
    expect(result.body).toContain(SETUP_DRAFT);
    expect(result.bodySource).toBe('technician_report');
  });

  test('a re-check visit never runs the setup screen over its draft', () => {
    const RECHECK_DRAFT = 'We checked 8 traps and found no captures today.';
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { species: 'Roof rat', traps_checked: '8', captures: '0', trap_visit_type: 'Follow-up check' },
      chips: ['Continue trapping'],
      activity: { score: 3 },
      visitSequence: 2,
      technicianReportBody: RECHECK_DRAFT,
    });
    expect(result.body).toContain(RECHECK_DRAFT);
    expect(result.bodySource).toBe('technician_report');
  });

  test('bait-station siblings are unchanged — the gauge body stays deterministic', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_bait_station',
      reportTypeLabel: 'Rodent Bait Station Summary',
      values: { stations_checked: '4', bait_consumption: 'Light' },
      chips: ['Monitor for new activity'],
      activity: { score: 2 },
      visitSequence: 2,
      technicianReportBody: AI_BODY,
    });
    expect(result.body).not.toContain(AI_BODY);
    expect(result).not.toHaveProperty('bodySource');
  });
});

describe('validation', () => {
  test('owner-required cores enforce; full submissions pass clean', () => {
    for (const [type, values] of [
      ['rodent_exclusion', EXCLUSION_VALUES],
      ['rodent_sanitation', SANITATION_VALUES],
      ['rodent_inspection', INSPECTION_VALUES],
    ]) {
      const empty = validateTypedFindings({ type, values: {}, expectedType: type, enforceRequired: true });
      expect(empty.ok).toBe(false);
      // Simplified 2026-07-23: each core is back inside the ≤4 budget.
      expect(empty.missing.length).toBeGreaterThanOrEqual(4);
      const full = validateTypedFindings({ type, values, expectedType: type, enforceRequired: true });
      expect({ type, ok: full.ok, errors: full.errors, missing: full.missing })
        .toEqual({ type, ok: true, errors: [], missing: [] });
    }
  });

  test('sanitation closeouts must record performed cleanup, not just a recommendation (codex P2 on #2963)', () => {
    // With evidence_cleaned retired, the work chips are the only proof
    // cleanup happened — a recommendation-only submission must not publish
    // the "cleaned and sanitized" report copy.
    const recommendationOnly = validateTypedFindings({
      type: 'rodent_sanitation',
      values: { ...SANITATION_VALUES, sanitation_work_completed: 'Insulation removal recommended' },
      expectedType: 'rodent_sanitation',
      enforceRequired: true,
    });
    expect(recommendationOnly.ok).toBe(false);
    expect(recommendationOnly.errors.join(' ')).toMatch(/records no cleanup work/);

    // The recommendation beside performed work stays legal.
    const withWork = validateTypedFindings({
      type: 'rodent_sanitation',
      values: { ...SANITATION_VALUES, sanitation_work_completed: 'Removed droppings, Insulation removal recommended' },
      expectedType: 'rodent_sanitation',
      enforceRequired: true,
    });
    expect(withWork.ok).toBe(true);

    // Limited-access cleanup IS performed work.
    const limited = validateTypedFindings({
      type: 'rodent_sanitation',
      values: { ...SANITATION_VALUES, sanitation_work_completed: 'Limited cleanup due to access' },
      expectedType: 'rodent_sanitation',
      enforceRequired: true,
    });
    expect(limited.ok).toBe(true);
  });

  test('"none" chips cannot ride with the findings they negate', () => {
    const concerns = validateTypedFindings({
      type: 'rodent_exclusion',
      values: { ...EXCLUSION_VALUES, remaining_concerns: 'No remaining concerns observed, Activity still present' },
      expectedType: 'rodent_exclusion',
      enforceRequired: true,
    });
    expect(concerns.ok).toBe(false);
    expect(concerns.errors.join(' ')).toMatch(/No remaining concerns observed/);

    const limitations = validateTypedFindings({
      type: 'rodent_sanitation',
      values: { ...SANITATION_VALUES, sanitation_limitations: 'No limitations, PPE / safety limitation' },
      expectedType: 'rodent_sanitation',
      enforceRequired: true,
    });
    expect(limitations.ok).toBe(false);
    expect(limitations.errors.join(' ')).toMatch(/No limitations/);
  });

  test('inspection that found activity requires the evidence and suspected type', () => {
    const result = validateTypedFindings({
      type: 'rodent_inspection',
      values: { ...INSPECTION_VALUES, evidence_observed: '', species: '' },
      expectedType: 'rodent_inspection',
      enforceRequired: true,
    });
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual(expect.arrayContaining(['evidence_observed', 'species']));

    // Old evidence with no current activity stays legal.
    const oldEvidence = validateTypedFindings({
      type: 'rodent_inspection',
      values: {
        areas_inspected: 'Garage',
        activity_found: 'No',
        evidence_observed: 'Droppings',
        recommended_service: 'Bait station monitoring',
        urgency: 'Routine',
      },
      expectedType: 'rodent_inspection',
      enforceRequired: true,
    });
    expect(oldEvidence.ok).toBe(true);
  });
});

describe('snapshots', () => {
  test('suspected rodent type + Y/N selects render as customer sentences; all copy-safe', () => {
    expect(customerLabelForValue('species', 'Rat')).toBe('Rats');
    expect(customerLabelForValue('species', 'Mouse')).toBe('Mice');
    expect(customerLabelForValue('exterior_pressure', 'Yes')).toBe('Exterior rodent pressure is present');
    for (const [type, values] of [
      ['rodent_exclusion', EXCLUSION_VALUES],
      ['rodent_sanitation', SANITATION_VALUES],
      ['rodent_inspection', INSPECTION_VALUES],
    ]) {
      const snapshot = buildTypedReportSnapshot({
        projectType: type,
        values,
        nextStepChips: TYPE_NEXT_STEP_CHIPS[type].slice(0, 2),
        serviceKey: type,
        serviceLabel: PROJECT_TYPES[type].label,
        visitSequence: 1,
        activity: type === 'rodent_sanitation' ? null : { indicatorKey: 'rodent_activity', label: 'Rodent Activity', score: 2, source: 'technician' },
      });
      expect(findBannedCustomerCopy(JSON.stringify(snapshot))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Codex round 3 on #3159 — every one of these is a gap in a guard the earlier
// rounds added, not in the original feature. Kept together so the shape stays
// visible: a guard is only as good as the wording it actually recognises.
// ---------------------------------------------------------------------------
describe('setup-stage guards — round 3 gaps', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  // P1: the matcher knew "checked … traps" and passive "traps were
  // inspected", but not the most natural re-check sentence of all.
  test('active-voice inspection claims are caught, not just "checked"', () => {
    for (const text of [
      'We inspected 8 traps today.',
      'We inspected the devices along the runway.',
      'We re-inspected the traps in the attic.',
    ]) {
      expect(setupContradictions(text).length).toBeGreaterThan(0);
    }
  });

  test('…while inspecting something that is not a trap still reads as setup prose', () => {
    for (const text of [
      'We inspected the roofline for entry points.',
      'We set 8 traps today.',
      'We placed the devices along the documented runways.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });

  test('the verb binds to its OWN object, so neighbouring trap nouns are not guilt by association', () => {
    // Earlier revisions matched on proximity — any trap noun within 40
    // characters of a re-check verb — and this sentence was pinned as a
    // deliberate over-rejection. The object-binding rewrite (codex round 6)
    // removed the need for that trade-off: `inspected` binds to `exterior`
    // and `attic`, not to the traps mentioned later in the sentence.
    expect(setupContradictions('We inspected the exterior before placing the traps.')).toEqual([]);
    expect(setupContradictions('We inspected the attic and set eight traps today.')).toEqual([]);
    // …while the verb whose object IS a trap still rejects.
    expect(setupContradictions('We inspected the traps in the attic.').length).toBeGreaterThan(0);
  });

  test('the screen reaches the technician draft, so an inspection draft is refused', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: { species: 'Roof rat', traps_checked: '8', trap_visit_type: 'Initial setup' },
      chips: ['Continue trapping'],
      activity: { score: 3 },
      visitSequence: 1,
      technicianReportBody: 'We inspected 8 traps today. Droppings were noted near the plenum.',
    });
    expect(result.body).not.toContain('inspected 8 traps');
    expect(result).not.toHaveProperty('bodySource');
  });

  // P2: trap_actions is a CUSTOMER-FACING finding row, so suppressing these
  // verbs in the body still left "Traps set: 8" beside "Trap service
  // performed: Traps reset" on the rendered report.
  test('follow-up-only trap actions cannot ride a declared setup', () => {
    const submit = (trap_visit_type, trap_actions) => validateTypedFindings({
      type: 'rodent_trapping',
      values: { species: 'Roof rat', traps_checked: '8', trap_visit_type, trap_actions },
      expectedType: 'rodent_trapping',
      enforceRequired: true,
    });

    for (const action of ['Traps reset', 'Traps moved', 'Traps replaced', 'Bait/lure refreshed', 'Damaged or missing traps found']) {
      expect(submit('Initial setup', action).ok).toBe(false);
      // …and the same action is perfectly legal on a re-check.
      expect(submit('Follow-up check', action).ok).toBe(true);
    }

    // Setup-compatible actions stay legal, alone and combined.
    expect(submit('Initial setup', 'New traps added').ok).toBe(true);
    expect(submit('Initial setup', 'New traps added, Exterior inspection completed').ok).toBe(true);
    // One offender in a mixed list is enough to reject.
    expect(submit('Initial setup', 'New traps added, Bait/lure refreshed').ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Codex round 4 on #3159. The P0 is the one that matters: an earlier revision
// inferred "setup" from visitSequence whenever trap_visit_type was absent,
// which silently reclassified EVERY pre-change snapshot at view time.
// ---------------------------------------------------------------------------
describe('legacy snapshots are never reclassified', () => {
  const { isInitialRodentTrapSetup } = require('../services/service-report/activity-indicators');

  test('a snapshot with no declaration is NOT a setup, whatever its sequence', () => {
    // Every report completed before this PR looks exactly like this.
    for (const seq of [1, 2, 9, null, undefined]) {
      expect(isInitialRodentTrapSetup('rodent_trapping', seq, {})).toBe(false);
      expect(isInitialRodentTrapSetup('rodent_trapping', seq, { trap_visit_type: '' })).toBe(false);
    }
  });

  test('only an explicit declaration decides, and it beats the sequence both ways', () => {
    expect(isInitialRodentTrapSetup('rodent_trapping', 9, { trap_visit_type: 'Initial setup' })).toBe(true);
    expect(isInitialRodentTrapSetup('rodent_trapping', 1, { trap_visit_type: 'Follow-up check' })).toBe(false);
  });

  test('a legacy snapshot keeps its original re-check wording end to end', () => {
    const legacy = { species: 'Roof rat', traps_checked: '7', captures: '0' };
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: legacy,
      chips: ['Continue trapping'],
      activity: { score: 2 },
      visitSequence: 1,
    });
    expect(result.body).toContain('We checked 7 traps');
    expect(result.body).not.toContain('We set 7 traps');
    expect(result.body).not.toContain('We return to check them');
  });
});

describe('setup guards — round 4 gaps', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  // P1: every verb the structured validator rejects on a setup has to reject
  // in prose too, in the natural quantified and passive forms.
  test('replacement, rebaiting and quantified/passive forms all reject', () => {
    for (const text of [
      'We replaced the damaged traps today.',
      'We rebaited all 8 traps.',
      'All 8 traps were rebaited.',
      'The traps were replaced.',
      'We swapped out the old traps.',
      'We repositioned two of the traps.',
    ]) {
      expect(setupContradictions(text).length).toBeGreaterThan(0);
    }
  });

  test('placement wording still survives', () => {
    for (const text of [
      'We set 8 traps today.',
      'We placed the devices along the runways.',
      'We set traps in the attic and the garage.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });

  // P2: "Traps set: 0" was reachable whenever the trap map was off.
  test('a setup that placed no traps is rejected; a re-check finding none is not', () => {
    const submit = (trap_visit_type, traps_checked) => validateTypedFindings({
      type: 'rodent_trapping',
      values: { species: 'Roof rat', trap_visit_type, traps_checked },
      expectedType: 'rodent_trapping',
      enforceRequired: true,
    });
    expect(submit('Initial setup', '8').ok).toBe(true);
    expect(submit('Initial setup', '0').ok).toBe(false);
    expect(submit('Initial setup', '').ok).toBe(false);
    // A re-check legitimately records zero — captures, not placements.
    expect(submit('Follow-up check', '0').ok).toBe(true);
  });
});

// codex P1 round 5: the passive matcher hard-coded `were`, so the singular
// forms a tech would naturally write walked through both screens.
describe('setup guards — singular passive (round 5)', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  test('singular passive re-check claims reject like their plural forms', () => {
    for (const text of [
      'One trap was replaced today.',
      'A trap was reset.',
      'One device was moved.',
      'A trap was rebaited.',
      'One trap was inspected.',
    ]) {
      expect(setupContradictions(text).length).toBeGreaterThan(0);
    }
  });

  test('the plural forms still reject and placement wording still passes', () => {
    expect(setupContradictions('The traps were replaced.').length).toBeGreaterThan(0);
    expect(setupContradictions('We set 8 traps today.')).toEqual([]);
    expect(setupContradictions('A trap was set at the plenum.')).toEqual([]);
  });
});

// Round 6 replaced the pattern list with object binding, after it leaked in
// BOTH directions at once — missing "have been checked" while rejecting
// "we inspected the attic and set eight traps". These pin the construction.
describe('setup matcher binds verbs to their objects (round 6)', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  test('re-check claims reject across voice, number and tense', () => {
    for (const text of [
      'We inspected 8 traps today.',                 // active
      'One trap was replaced today.',                // passive singular
      'The traps were reset.',                       // passive plural
      'Eight traps have been checked today.',        // perfect passive
      'The devices had been inspected.',             // pluperfect passive
      'We rebaited all 8 traps.',                    // quantified object
      'We replaced the damaged traps today.',        // adjective before object
      'We swapped out the old traps.',               // particle verb
      'We re-set the traps.',                        // hyphenated re- form
      'We repositioned two of the traps.',           // partitive object
      'We checked all mechanical traps today.',      // unlisted modifier
      'We inspected the snap traps.',                // compound noun
      'We inspected the wooden rat traps in the attic.',
    ]) {
      expect(setupContradictions(text).length).toBeGreaterThan(0);
    }
  });

  test('setup prose passes, including verbs whose object is NOT a trap', () => {
    for (const text of [
      'We set 8 traps today.',
      'A trap was set at the plenum.',
      'We placed the devices along the documented runways.',
      'We inspected the attic and set eight traps today.',
      'We inspected the exterior before placing the traps.',
      'We inspected the roofline for entry points.',
      // baiting/positioning are what a setup DOES — only their re- forms
      // contradict one.
      'We baited the traps as we set them.',
      // The object phrase ends at a preposition or relative pronoun, so a
      // trap mentioned in a LATER phrase is not the verb's object.
      'We inspected the attic where the traps will sit.',
      'We checked the crawlspace for entry points and set traps.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });
});

// Round 8. Two independent staleness holes, both reachable because the tech
// drafts the AI report and can keep editing the typed fields afterwards.
describe('setup matcher scans past adverbs in the passive (round 8)', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  test('modifiers between the auxiliary and the participle do not hide it', () => {
    for (const text of [
      'All traps were carefully inspected today.',
      'The devices have been thoroughly checked.',
      'The traps were quickly reset this morning.',
      'All 8 traps had been carefully re-baited.',
      'The traps were very carefully repositioned.',   // two modifiers
    ]) {
      expect(setupContradictions(text).length).toBeGreaterThan(0);
    }
  });

  test('an adverb does not manufacture a claim where the participle is legal', () => {
    for (const text of [
      'All traps were carefully set today.',
      'The devices have been carefully placed along the runways.',
      // the participle sits in a NEW phrase, so it is not bound to the traps
      'The traps were set before the attic was inspected.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });
});

// Round 10: the passive scan required an auxiliary, so field shorthand with
// no `was`/`were` was invisible — and the active scan cannot recover it,
// because there the trap noun precedes its verb.
describe('reduced passives are re-check claims too (round 10)', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  test('a trap phrase followed by a re-check participle needs no auxiliary', () => {
    for (const text of [
      'All 8 traps checked today.',
      'Traps inspected this morning.',
      'All traps rebaited.',
      'The snap traps reset this afternoon.',
    ]) {
      expect(setupContradictions(text).length).toBeGreaterThan(0);
    }
  });

  test('setup participles stay legal without an auxiliary', () => {
    for (const text of [
      '8 traps set today.',
      'Traps placed along the documented runways.',
      'All traps baited and set.',
      // the participle sits past a phrase boundary, so it is not bound to
      // the traps
      'The traps were set before the attic was inspected.',
      'We inspected the attic where the traps will sit.',
      'We inspected the exterior before placing the traps.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });
});

describe('coordinated trap objects stay in one clause (round 9)', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  test('`and` joining an object\'s modifiers does not split the claim apart', () => {
    for (const text of [
      'We checked the snap and glue traps today.',
      'We reset the snap and glue traps.',
      'We inspected the wooden and metal traps.',
      'The snap and glue traps were checked.',
    ]) {
      expect(setupContradictions(text).length).toBeGreaterThan(0);
    }
  });

  test('`and` introducing a new predicate still splits, including after an adverb', () => {
    for (const text of [
      'We inspected the attic and set eight traps today.',
      'We inspected the attic and carefully set eight traps.',
      'We baited and set the traps.',
      'We inspected the exterior and placed the devices.',
      'We set the snap and glue traps today.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });
});

describe('technician body count claims reconcile against the typed values (round 8)', () => {
  const { countContradictions } = require('../services/service-report/activity-indicators');

  test('a stale count contradicting the final structured value is rejected', () => {
    // Codex round 8: body drafted at 8 traps, tech corrects the field to 6.
    expect(countContradictions('We checked 8 traps today.', { traps_checked: 6 }).length)
      .toBeGreaterThan(0);
    expect(countContradictions('We set eight traps today.', { traps_checked: 6 }).length)
      .toBeGreaterThan(0);
    expect(countContradictions('We removed 2 rats from the traps.', { captures: 1 }).length)
      .toBeGreaterThan(0);
    expect(countContradictions('There were 3 captures.', { captures: 0 }).length)
      .toBeGreaterThan(0);
  });

  test('agreeing, partitive and unverifiable counts pass', () => {
    expect(countContradictions('We checked 8 traps today.', { traps_checked: 8 })).toEqual([]);
    expect(countContradictions('We checked eight traps today.', { traps_checked: 8 })).toEqual([]);
    // "N of M" claims the roster (M), not the subset
    expect(countContradictions('6 of 8 traps were empty.', { traps_checked: 8 })).toEqual([]);
    expect(countContradictions('One of the traps held a capture.', { traps_checked: 8 })).toEqual([]);
    // a breakdown is not a total claim — summing it would be a guess
    expect(countContradictions('We set two snap traps and six glue traps.', { traps_checked: 8 }))
      .toEqual([]);
    // nothing structured to reconcile against is unverifiable, not wrong
    expect(countContradictions('We checked 8 traps today.', {})).toEqual([]);
    expect(countContradictions('We checked the traps today.', { traps_checked: 6 })).toEqual([]);
  });

  // Round 11: the round-8 narrowness rule (bail when a subject carries more
  // than one distinct claim) also bailed when prose mixed a ROSTER count with
  // a STATUS SUBSET — the common shape — so a stale total escaped entirely.
  // Subsets are now recognized and dropped rather than counted as competing
  // totals, while a genuine breakdown still bails.
  test('a status subset does not make the roster count unverifiable', () => {
    for (const text of [
      'We checked 8 traps and found activity at 2 traps.',   // cue leads its count
      'We checked 8 traps and 2 traps had captures.',        // cue trails its count
      'We checked 8 traps. Activity at 2 traps.',            // separate sentences
      'We set eight traps and 1 trap was damaged.',
    ]) {
      expect(countContradictions(text, { traps_checked: 6 }).length).toBeGreaterThan(0);
    }
    // …and the same shapes pass when the roster agrees
    expect(countContradictions('We checked 8 traps and found activity at 2 traps.', { traps_checked: 8 }))
      .toEqual([]);
  });

  test('a genuine breakdown is still unverifiable, and subsets alone claim nothing', () => {
    // two roster claims with no status cue — summing them would be a guess
    expect(countContradictions('We set two snap traps and six glue traps.', { traps_checked: 8 }))
      .toEqual([]);
    expect(countContradictions(
      'We checked the 8 traps on the north side and the 4 traps on the south side.',
      { traps_checked: 12 },
    )).toEqual([]);
    // a subset on its own asserts no roster size
    expect(countContradictions('Activity was found at 2 traps.', { traps_checked: 6 })).toEqual([]);
  });

  // Round 10: the animal can precede its verb. CAPTURE_CLAIM_RE needs the
  // noun `captures`; CAUGHT_CLAIM_RE needs the verb before the number — so
  // "two mice were caught" was extracted by neither.
  test('passive capture claims reconcile against the typed captures', () => {
    expect(countContradictions('Two mice were caught.', { captures: 1 }).length)
      .toBeGreaterThan(0);
    expect(countContradictions('3 rats have been removed.', { captures: 1 }).length)
      .toBeGreaterThan(0);
    expect(countContradictions('Two roof rats were captured today.', { captures: 1 }).length)
      .toBeGreaterThan(0);
    // agreeing, and unverifiable, still pass
    expect(countContradictions('Two mice were caught.', { captures: 2 })).toEqual([]);
    expect(countContradictions('Two mice were caught.', { captures: '' })).toEqual([]);
  });

  // Round 9: a CLEARED field is missing, not zero — Number('') is 0, which
  // would read as "the tech recorded zero" and reject any body with a count.
  test('a blank or cleared count is unverifiable, not a recorded zero', () => {
    for (const values of [
      { traps_checked: '' },
      { traps_checked: null },
      { traps_checked: '   ' },
      { traps_checked: undefined },
    ]) {
      expect(countContradictions('We checked 8 traps today.', values)).toEqual([]);
    }
    for (const values of [{ captures: '' }, { captures: null }]) {
      expect(countContradictions('We removed 2 rats from the traps.', values)).toEqual([]);
    }
    // a real zero still reconciles
    expect(countContradictions('There were 3 captures.', { captures: 0 }).length)
      .toBeGreaterThan(0);
    expect(countContradictions('There were 0 captures.', { captures: 0 })).toEqual([]);
  });
});

// Round 12: the two windows around a trap count treated a NEIGHBOURING
// capture claim's noun as a status cue. "We checked 8 traps and recorded 2
// captures" dropped its only roster claim as a subset — so the stale 8
// escaped the guard while the capture guard separately validated the 2.
// Capture claims are now masked out of the windows before cues are read.
describe('capture claims are not status cues for the trap roster (round 12)', () => {
  const { countContradictions } = require('../services/service-report/activity-indicators');

  test('a neighbouring capture count no longer hides a stale roster', () => {
    for (const text of [
      'We checked 8 traps and recorded 2 captures.', // capture claim trails
      'We recorded 2 captures and checked 8 traps.', // capture claim leads
      'Two mice were captured and we checked 8 traps.', // passive form leads
    ]) {
      expect(countContradictions(text, { traps_checked: 6 }).length).toBeGreaterThan(0);
    }
  });

  test('the same shapes pass when the roster agrees, and the capture guard still fires', () => {
    expect(countContradictions('We checked 8 traps and recorded 2 captures.', { traps_checked: 8, captures: 2 }))
      .toEqual([]);
    expect(countContradictions('We checked 8 traps and recorded 2 captures.', { traps_checked: 8, captures: 3 }).length)
      .toBeGreaterThan(0);
  });

  test('a cue describing the trap count itself is still a subset', () => {
    // "captures" with no count of its own belongs to the trap number beside
    // it — the masking removes whole capture CLAIMS, not the cue vocabulary.
    expect(countContradictions('We checked 8 traps and found captures at 2 traps.', { traps_checked: 8 }))
      .toEqual([]);
    // a subset on its own still asserts no roster size
    expect(countContradictions('8 traps had captures.', { traps_checked: 6 })).toEqual([]);
  });
});

// Round 12: numeric and word-form zero-capture claims said the same thing as
// "no captures" without the word "no", and the count guard can't help — a
// structured captures of 0 makes the zero claim arithmetically accurate. On
// a setup the traps just went out, so the claim still implies a check that
// never happened.
describe('zero-capture claims contradict a declared setup (round 12)', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  test('digit and word-form zeros are refused', () => {
    for (const text of [
      '0 captures were recorded.',
      'There were zero captures.',
      'We recorded 0 new captures.',
      'Zero catches so far.',
      'We caught 0 rodents.',
      '0 rats were caught.',
    ]) {
      expect(setupContradictions(text).length).toBeGreaterThan(0);
    }
  });

  test('setup prose mentioning zero for anything else survives', () => {
    for (const text of [
      'We set 8 traps with zero disruption to the home.',
      'We placed the traps along the zero-clearance soffit line.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });
});

// Round 13: negated animal forms and do-not-catch phrasings claim an empty
// check with neither the word "captures" nor a number — invisible to both
// the count guard and the round-12 zero patterns.
describe('negated animal capture claims contradict a declared setup (round 13)', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  test('negated caught/captured/trapped animal forms are refused', () => {
    for (const text of [
      'No mice were caught.',
      'No rodents have been trapped.',
      'We did not catch any rodents.',
      "We haven't caught anything yet.",
      'Nothing has been caught so far.',
    ]) {
      expect(setupContradictions(text).length).toBeGreaterThan(0);
    }
  });

  test('negations about anything but catching stay legal setup prose', () => {
    for (const text of [
      'No droppings were found in the attic.',
      'We did not remove the old bait station covers.',
      'No damage to the soffits was noted.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });
});

// Round 13: the two-token modifier cap missed "8 exterior mechanical snap
// traps" entirely, so the roster claim vanished and a stale count published.
// The run is now bounded by meaning (animals/articles/prepositions end it),
// not by length.
describe('long modifier runs still claim the roster (round 13)', () => {
  const { countContradictions } = require('../services/service-report/activity-indicators');

  test('three-plus modifiers between count and noun still reconcile', () => {
    for (const text of [
      'We checked 8 exterior mechanical snap traps.',
      'We placed 8 brand-new heavy-duty snap traps along the wall.',
    ]) {
      expect(countContradictions(text, { traps_checked: 6 }).length).toBeGreaterThan(0);
    }
    expect(countContradictions('We checked 8 exterior mechanical snap traps.', { traps_checked: 8 }))
      .toEqual([]);
  });

  test('a number that counts something else still claims nothing about traps', () => {
    // "2 rats near the traps" counts rats — the excluded tokens end the run.
    expect(countContradictions('We removed 2 rats near the traps.', { traps_checked: 6 }))
      .toEqual([]);
    expect(countContradictions('One of the traps was moved.', { traps_checked: 6 }))
      .toEqual([]);
  });
});

// Round 13: "the traps were set today and the attic was inspected" — the
// conditional and-split only recognized a following VERB, so the attic's
// participle bound to the traps and legitimate setup copy was discarded. A
// new subject (auxiliary within a few tokens of the `and`) now splits too.
describe('a new subject after `and` keeps its verb to itself (round 13)', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  test('coordinated clauses with a new subject read as setup prose', () => {
    for (const text of [
      'The traps were set today and the attic was inspected.',
      'We set 8 traps and the crawlspace was checked for droppings.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });

  test('shared-subject verb phrases and coordinated trap subjects still reject', () => {
    // Auxiliary immediately after `and` = same subject, stays joined.
    expect(setupContradictions('The traps were set and were checked later.').length)
      .toBeGreaterThan(0);
    // The second conjunct's own subject IS a trap noun.
    expect(setupContradictions('The traps and monitoring devices were inspected.').length)
      .toBeGreaterThan(0);
  });
});

// Round 14: "We checked 8 of the traps" names no roster, so no pattern
// claimed it and a stale 8 froze beside a corrected count. Numeric
// partitives with an active check predicate now reconcile; bare partitives
// and subset/distributive actions still claim nothing.
describe('numeric partitives with a check predicate reconcile (round 14)', () => {
  const { countContradictions } = require('../services/service-report/activity-indicators');

  test('checked/inspected N of the traps reconciles against the count', () => {
    expect(countContradictions('We checked 8 of the traps today.', { traps_checked: 6 }).length)
      .toBeGreaterThan(0);
    expect(countContradictions('We inspected eight of the traps.', { traps_checked: 6 }).length)
      .toBeGreaterThan(0);
    expect(countContradictions('We checked 8 of the traps today.', { traps_checked: 8 }))
      .toEqual([]);
  });

  test('bare partitives and subset/distributive actions still claim nothing', () => {
    expect(countContradictions('One of the traps held a capture.', { traps_checked: 6 }))
      .toEqual([]);
    // a subset ACTION on some of the checked traps
    expect(countContradictions('We reset 3 of the traps.', { traps_checked: 6 }))
      .toEqual([]);
    // distributive placement prose
    expect(countContradictions('We set 3 of the traps in the attic.', { traps_checked: 6 }))
      .toEqual([]);
  });
});

// Round 14: the interim {0,6} modifier cap was the two-token mistake made
// smaller — catalog prose runs past any fixed cap. The exclusion boundaries
// alone terminate the noun phrase now.
describe('catalog-length modifier runs still reconcile (round 14)', () => {
  const { countContradictions } = require('../services/service-report/activity-indicators');

  test('seven modifiers between count and noun reconcile', () => {
    const text = 'We placed 8 new black plastic heavy-duty professional-grade mechanical snap traps.';
    expect(countContradictions(text, { traps_checked: 6 }).length).toBeGreaterThan(0);
    expect(countContradictions(text, { traps_checked: 8 })).toEqual([]);
  });

  test('excluded tokens still end the phrase regardless of length', () => {
    expect(countContradictions('We removed 2 rats near the traps.', { traps_checked: 6 }))
      .toEqual([]);
  });
});

// Round 14: a repeated subject pronoun before the predicate — "…and WE set
// eight traps" — blocked the verb test, so the clause stayed joined and the
// attic's `inspected` bound to the later traps.
describe('repeated-subject clauses split (round 14)', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  test('pronoun + predicate after `and` reads as setup prose', () => {
    for (const text of [
      'We inspected the attic and we set eight traps today.',
      'We inspected the crawlspace and I placed the devices.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });

  test('a real recheck in either conjunct still rejects', () => {
    expect(setupContradictions('We checked the traps and we added bait.').length)
      .toBeGreaterThan(0);
  });
});

// Round 15: only the ACTIVE partitive order was covered, so "8 of the traps
// were checked" — the way a report actually reads — extracted nothing, and
// the partitive's own modifier window was still capped at two tokens.
describe('passive and fully modified checked partitives reconcile (round 15)', () => {
  const { countContradictions } = require('../services/service-report/activity-indicators');

  test('passive, reduced-passive, and adverbial forms all reconcile', () => {
    for (const text of [
      '8 of the traps were checked today.',
      '8 of the traps checked today.',
      '8 of the traps have now been inspected.',
      '8 of the traps were carefully re-checked.',
    ]) {
      expect(countContradictions(text, { traps_checked: 6 }).length).toBeGreaterThan(0);
    }
    expect(countContradictions('8 of the traps were checked today.', { traps_checked: 8 }))
      .toEqual([]);
  });

  test('the active partitive takes the shared modifier run', () => {
    expect(countContradictions(
      'We checked 8 of the exterior black mechanical snap traps.',
      { traps_checked: 6 },
    ).length).toBeGreaterThan(0);
  });

  test('a later unrelated participle is not bound to the partitive', () => {
    // The predicate is auxiliaries+adverbs+participle, not "a participle
    // within N characters" — otherwise this discards valid copy.
    expect(countContradictions(
      '8 of the traps were empty and the attic was inspected.',
      { traps_checked: 6 },
    )).toEqual([]);
  });
});

// Round 15: removing the token cap in round 14 left the scan free to run
// through a whole predicate — a regression, caught by codex.
describe('the modifier scan stops at predicate boundaries (round 15)', () => {
  const { countContradictions } = require('../services/service-report/activity-indicators');

  test('a numeral describing something else does not become a trap roster', () => {
    for (const text of [
      'We documented 8 fresh droppings then checked mechanical traps.',
      'We collected 8 samples while inspecting the traps.',
      'We found 8 burrows and checked the traps.',
    ]) {
      expect(countContradictions(text, { traps_checked: 6 })).toEqual([]);
    }
  });

  test('catalog-length trap phrases still reconcile', () => {
    expect(countContradictions(
      'We placed 8 new black plastic heavy-duty professional-grade mechanical snap traps.',
      { traps_checked: 6 },
    ).length).toBeGreaterThan(0);
  });
});

// Round 15: the verb scans never see a noun-form claim — there is no verb
// bound to a trap noun at all.
describe('noun-form trap inspection claims contradict a setup (round 15)', () => {
  const { setupContradictions } = require('../services/service-report/activity-indicators');

  test('completed trap inspections/checks are refused', () => {
    for (const text of [
      'Trap inspection completed today.',
      'We completed a full trap inspection.',
      'The inspection of the traps was completed.',
      'Trap check performed on arrival.',
    ]) {
      expect(setupContradictions(text).length).toBeGreaterThan(0);
    }
  });

  test("the setup's OWN ratified next-step sentence stays legal", () => {
    // "We will return for the scheduled trap check" is the deterministic
    // setup next-step AND what the setup prompt asks the model to say. A
    // completion word is what separates it from a claim.
    for (const text of [
      'We will return for the scheduled trap check.',
      'We set 7 traps today. We will return for the scheduled trap check.',
      'The next trap check is scheduled for next week.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });

  test('non-trap inspections stay legal', () => {
    for (const text of [
      'Exterior inspection completed today.',
      'We completed a full attic inspection.',
    ]) {
      expect(setupContradictions(text)).toEqual([]);
    }
  });
});
