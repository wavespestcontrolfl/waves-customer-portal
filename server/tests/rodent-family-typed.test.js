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

  test('the visitSequence fallback still resolves snapshots that carry no value', () => {
    // Completions frozen before the field existed replay through the same
    // copy path — they must still render, on the old inference.
    expect(todaysResult(SETUP_VALUES, 1).body).toContain('We set 8 traps today.');
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

  test('visit 1 reads as a setup — traps SET, no re-check or empty-check wording', () => {
    const result = buildTodaysResult({
      projectType: 'rodent_trapping',
      reportTypeLabel: 'Rodent Trapping Summary',
      values: SETUP_VALUES,
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

  test('the setup visit relabels the count finding to "Traps set"', () => {
    const setup = buildTypedReportSnapshot({
      projectType: 'rodent_trapping',
      serviceKey: 'rodent_trapping_setup',
      serviceLabel: 'Rodent Trapping',
      values: SETUP_VALUES,
      nextStepChips: ['Continue trapping'],
      visitSequence: 1,
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
