// Typed-report narrative (GATE_TYPED_REPORT_NARRATIVE) — the generalized
// engine behind rodent-report-narrative.js applied to the OTHER typed
// specialty reports (cockroach, bed bug, termite bait, WDO…).
//
// Load-bearing behaviors on non-station reports: grounding carries the
// typed findings / activity wording / photo captions / next visit,
// registered pesticides (the normal case on these lines) never enter the
// prompt by name, follow-up windows from the ratified copy ground their own
// numerals, and the deterministic fallback assembles only ratified copy.

const {
  applyTypedReportNarrative,
  _test,
} = require('../services/service-report/rodent-report-narrative');

const { groundingFacts, deterministicSummary, ungroundedClaims, buildUserMessage, _cache } = _test;

let seq = 0;
function roachInput(overrides = {}) {
  seq += 1;
  return {
    recap: `Your cockroach service is complete, targeting German cockroaches throughout the home. (case ${seq})`,
    serviceTypeDisplay: 'Cockroach Control Service',
    reportTypeLabel: 'Cockroach Treatment',
    typedReport: {
      reportTypeLabel: 'Cockroach Treatment',
      todaysResult: {
        headline: 'Cockroach activity was high today.',
        body: 'We applied an insect growth regulator, treated cracks and crevices and completed a flush-out treatment today. A follow-up visit in 10–14 days is recommended to stay ahead of newly hatching activity. Please keep treated areas undisturbed so the treatment can work.',
        nextStep: 'A follow-up visit in 10–14 days is recommended to stay ahead of newly hatching activity.',
      },
      findings: [
        { fieldKey: 'species', customerLabel: 'What we found', customerValueLabel: 'German cockroaches', value: 'german' },
        { fieldKey: 'areas', customerLabel: 'Where activity was noted', customerValueLabel: 'Kitchen, Bathrooms, Under sink', value: 'kitchen' },
        { fieldKey: 'work', customerLabel: 'Work completed today', customerValueLabel: 'Insect growth regulator, Crack & crevice treatment, Flush-out treatment', value: 'igr' },
      ],
    },
    activity: { label: 'Roach Activity', levelWord: 'High activity', score: 4, maxScore: 5, isBaseline: true, trendWord: null },
    stationSummary: null,
    stationProgram: null,
    applications: [
      { product: { name: 'Alpine WSG', epa_reg: '499-561', category: 'Insecticide' } },
      { product: { name: 'Gentrol IGR', epa_reg: '2724-351', category: 'Insect Growth Regulator' } },
    ],
    photos: [{ caption: 'Droppings and cast skins visible along the hinge side of the cabinet under the kitchen sink.' }],
    nextAppointment: { serviceType: 'Cockroach Control Service', scheduledDate: '2026-08-03', windowStart: '15:00' },
    ...overrides,
  };
}

beforeEach(() => _cache.clear());

test('grounding carries the typed facts and withholds registered pesticide names', () => {
  const facts = groundingFacts(roachInput());
  expect(facts.reportTypeLabel).toBe('Cockroach Treatment');
  expect(facts.findings).toEqual(expect.arrayContaining([
    { label: 'What we found', value: 'German cockroaches' },
    { label: 'Where activity was noted', value: 'Kitchen, Bathrooms, Under sink' },
  ]));
  expect(facts.activity).toMatchObject({ levelWord: 'High activity', isBaseline: true });
  expect(facts.activity.score).toBeUndefined();
  expect(facts.stations).toBeNull();
  expect(facts.nextVisit).toMatchObject({ date: 'Monday, August 3', window: '3–5 PM' });
  // both products are registered pesticides — neither name enters the prompt
  expect(facts.devices.every((device) => device.name === null && device.nameable === false)).toBe(true);
  const message = buildUserMessage(facts);
  expect(message).not.toContain('Alpine');
  expect(message).not.toContain('Gentrol');
});

test('deterministic fallback = ratified copy + photos line + next visit; no station clause', () => {
  const text = deterministicSummary(groundingFacts(roachInput()));
  expect(text).toContain('Cockroach activity was high today.');
  expect(text).toContain('We applied an insect growth regulator');
  expect(text).toContain('Photos from this visit are included with this report.');
  expect(text).toContain('Your next visit is scheduled for Monday, August 3, arriving 3–5 PM.');
  expect(text).not.toContain('traps were inspected');
});

test('follow-up windows from the ratified copy ground their own numerals', () => {
  const facts = groundingFacts(roachInput());
  expect(ungroundedClaims('A follow-up visit in 10–14 days keeps you ahead of newly hatching activity.', facts)).toEqual([]);
  // an altered follow-up window is ungrounded
  expect(ungroundedClaims('A follow-up visit in 21 days is recommended.', facts)).toContain('ungrounded_number:21');
  // capture/consumption talk has no grounding on a cockroach report
  expect(ungroundedClaims('A capture was recorded at the kitchen monitor.', facts)).toContain('unsupported_capture_claim');
});

test('cross-domain claims reject: pests, actions, and locations must exist in the facts', () => {
  const facts = groundingFacts(roachInput());
  // grounded control — everything below appears in the typed facts
  expect(ungroundedClaims('We treated cracks and crevices in the kitchen and completed a flush-out treatment.', facts)).toEqual([]);
  // invented action + invented location reject
  expect(ungroundedClaims('We applied gel bait in the kitchen.', facts)).toContain('ungrounded_action:gel bait');
  expect(ungroundedClaims('Activity was documented in the attic.', facts)).toContain('ungrounded_location:attic');
  // a DIFFERENT pest on this report rejects (the codex bed-bug example,
  // inverted: bed bugs claimed on a cockroach report)
  expect(ungroundedClaims('We also inspected for bed bugs during the visit.', facts)).toContain('ungrounded_pest:bed bugs');
});

test('typed count findings validate their own noun (codex r2: palms serviced)', () => {
  const palmFacts = groundingFacts(roachInput({
    serviceTypeDisplay: 'Palm Injection Service',
    reportTypeLabel: 'Palm Injection',
    typedReport: {
      reportTypeLabel: 'Palm Injection',
      todaysResult: { headline: 'Palm service complete.', body: 'We serviced 1 palm today.', nextStep: null },
      findings: [{ fieldKey: 'palms_serviced', customerLabel: 'Palms serviced', customerValueLabel: '1', value: '1' }],
    },
    activity: null,
    applications: [],
    photos: [],
    nextAppointment: { serviceType: 'Palm Injection Service', scheduledDate: '2026-08-27', windowStart: '08:00' },
  }));
  expect(ungroundedClaims('We serviced 1 palm today.', palmFacts)).toEqual([]);
  // 27 is grounded globally (August 27) but is NOT the palms-serviced count
  expect(ungroundedClaims('27 palms were serviced today.', palmFacts)).toContain('uncorroborated_count:27 palms');
  // spelled-out counts beyond twenty and hyphenated compounds normalize too
  expect(ungroundedClaims('Thirty palms were serviced today.', palmFacts)).toContain('uncorroborated_count:30 palms');
  expect(ungroundedClaims('Twenty-one palms were serviced today.', palmFacts)).toContain('uncorroborated_count:21 palms');
});

test('action terms ground only on completed-work evidence, never the service label', () => {
  const baitFacts = groundingFacts(roachInput({
    serviceTypeDisplay: 'Termite Bait Station Monitoring',
    reportTypeLabel: 'Termite Bait Station Check',
    typedReport: {
      reportTypeLabel: 'Termite Bait Station Check',
      todaysResult: { headline: 'Stations were checked today.', body: 'We inspected the stations today.', nextStep: null },
      findings: [
        { fieldKey: 'species', customerLabel: 'Target pest', customerValueLabel: 'Subterranean termites', value: 'subterranean' },
        { fieldKey: 'bait_replaced', customerLabel: 'Bait replaced', customerValueLabel: 'No', value: 'No' },
      ],
    },
    activity: null,
    stationSummary: { total: 10, checked: 10, activity: 0, serviced: 0, inaccessible: 0 },
    stationProgram: 'termite',
    applications: [],
    photos: [],
  }));
  // the LABEL says Bait Station, but no completed-work fact says baiting happened
  expect(ungroundedClaims('We baited the stations today.', baitFacts)).toContain('ungrounded_action:baited');
  // typed station findings stay role-specific: activity counts can't pose as roster
  const activityFactsTermite = groundingFacts(roachInput({
    serviceTypeDisplay: 'Termite Bait Station Monitoring',
    reportTypeLabel: 'Termite Bait Station Check',
    typedReport: {
      reportTypeLabel: 'Termite Bait Station Check',
      todaysResult: { headline: 'Stations were checked today.', body: 'We inspected the stations today.', nextStep: null },
      findings: [{ fieldKey: 'stations_with_activity', customerLabel: 'Stations with activity', customerValueLabel: '2', value: '2' }],
    },
    activity: null,
    stationSummary: { total: 10, checked: 10, activity: 2, serviced: 0, inaccessible: 0 },
    stationProgram: 'termite',
    applications: [],
    photos: [],
  }));
  expect(ungroundedClaims('There are 2 stations on the property.', activityFactsTermite))
    .toContain('uncorroborated_count:2 stations');
  expect(ungroundedClaims('Activity was observed at 2 stations.', activityFactsTermite)).toEqual([]);
});

test('bare "one" is a numeric claim; the partitive idiom stays exempt', () => {
  const facts = groundingFacts(roachInput());
  // ratified window is 10–14 days — "one day" contradicts it
  expect(ungroundedClaims('We recommend a follow-up in one day.', facts)).toContain('ungrounded_number:1');
  expect(ungroundedClaims('One of the treated areas will be rechecked at the next visit.', facts)).toEqual([]);
});

test('zero-state contradiction is evaluated per clause', () => {
  const clearedFacts = groundingFacts(roachInput({
    typedReport: {
      reportTypeLabel: 'Cockroach Treatment',
      todaysResult: { headline: 'No live roach activity was observed today.', body: 'We completed the scheduled service and monitoring today.', nextStep: null },
      findings: [{ fieldKey: 'species', customerLabel: 'Target pest', customerValueLabel: 'German cockroaches', value: 'german' }],
    },
    activity: null,
  }));
  expect(ungroundedClaims('No concerns were reported by the customer, but live roaches were observed today.', clearedFacts))
    .toContain('contradicted_zero_state');
});

test('zero-state polarity: negated ratified copy rejects positive observation claims', () => {
  const clearedFacts = groundingFacts(roachInput({
    typedReport: {
      reportTypeLabel: 'Cockroach Treatment',
      todaysResult: { headline: 'No live roach activity was observed today.', body: 'We completed the scheduled service and monitoring today.', nextStep: null },
      findings: [{ fieldKey: 'species', customerLabel: 'Target pest', customerValueLabel: 'German cockroaches', value: 'german' }],
    },
    activity: null,
  }));
  // the ratified zero-state can't be flipped into a positive sighting —
  // even though the service label grounds the roach family term
  expect(ungroundedClaims('Live roaches were observed in the kitchen today.', clearedFacts))
    .toContain('contradicted_zero_state');
  // negated model copy restating the zero-state stays clean of this guard
  expect(ungroundedClaims('No live roach activity was observed today.', clearedFacts)
    .filter((p) => p === 'contradicted_zero_state')).toEqual([]);
});

test('word-form intervals hit the global number check', () => {
  const facts = groundingFacts(roachInput());
  // the ratified window is 10–14 days; "twenty days" has no raw digit but
  // must still be grounded (codex P1 r4)
  expect(ungroundedClaims('A follow-up in twenty days is recommended.', facts)).toContain('ungrounded_number:20');
  expect(ungroundedClaims('A follow-up in fourteen days is recommended.', facts)).toEqual([]);
});

test('mandatory care copy covers expectation/monitoring sentences', async () => {
  const zeroStateInput = roachInput({
    typedReport: {
      reportTypeLabel: 'Bed Bug Treatment',
      todaysResult: {
        headline: 'No bed bug activity was found today.',
        body: 'Continue monitoring and contact us if activity returns.',
        nextStep: null,
      },
      findings: [{ fieldKey: 'species', customerLabel: 'Target pest', customerValueLabel: 'Bed bugs', value: 'bed_bug' }],
    },
    activity: null,
    photos: [],
  });
  const clean = 'Your bed bug follow-up visit is complete, and no bed bug activity was found during today’s inspection of the treated areas. We will keep supporting you between visits, and your next visit is scheduled for Monday, August 3, arriving 3–5 PM.';
  const accepted = await applyTypedReportNarrative(zeroStateInput, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: clean } }),
  });
  expect(accepted).toContain('Continue monitoring and contact us if activity returns.');
});

test('chemical/compliance findings never reach the narrative facts', () => {
  const facts = groundingFacts(roachInput({
    typedReport: {
      reportTypeLabel: 'Termite Treatment',
      todaysResult: { headline: 'Termite treatment completed today.', body: 'We completed the scheduled treatment today.', nextStep: null },
      findings: [
        { fieldKey: 'species', customerLabel: 'Target pest', customerValueLabel: 'Subterranean termites', value: 'subterranean' },
        { fieldKey: 'products_used', customerLabel: 'Products used', customerValueLabel: 'Termidor HE', value: 'Termidor HE' },
        { fieldKey: 'epa_registration', customerLabel: 'EPA registration', customerValueLabel: '7969-329', value: '7969-329' },
        { fieldKey: 'percent_solution', customerLabel: 'Percent solution', customerValueLabel: '0.125%', value: '0.125' },
      ],
    },
  }));
  expect(facts.findings).toEqual([{ label: 'Target pest', value: 'Subterranean termites' }]);
  const message = buildUserMessage(facts);
  expect(message).not.toContain('Termidor');
  expect(message).not.toContain('7969');
});

test('long typed schemas keep their late findings (WDO shape)', () => {
  const findings = Array.from({ length: 12 }, (_, i) => ({
    fieldKey: `f${i}`, customerLabel: `Field ${i}`, customerValueLabel: `Value ${i}`, value: `v${i}`,
  }));
  const facts = groundingFacts(roachInput({ typedReport: { reportTypeLabel: 'WDO Inspection', todaysResult: null, findings } }));
  expect(facts.findings).toHaveLength(12);
});

test('species qualifiers ground individually — the family term cannot launder a swap', () => {
  const facts = groundingFacts(roachInput()); // records German cockroaches
  expect(ungroundedClaims('German cockroaches were noted in the kitchen.', facts)).toEqual([]);
  expect(ungroundedClaims('American cockroaches were noted in the kitchen.', facts))
    .toContain('ungrounded_species:american');
});

test('wildlife species are grounded like any other pest term', () => {
  const roachFacts = groundingFacts(roachInput());
  expect(ungroundedClaims('A raccoon was relocated during the visit.', roachFacts)).toContain('ungrounded_pest:raccoon');
  const wildlifeFacts = groundingFacts(roachInput({
    serviceTypeDisplay: 'Wildlife Trapping Service',
    reportTypeLabel: 'Wildlife Trapping',
    typedReport: {
      reportTypeLabel: 'Wildlife Trapping',
      todaysResult: { headline: 'Wildlife service complete.', body: 'One raccoon was captured and relocated today.', nextStep: null },
      findings: [{ fieldKey: 'species', customerLabel: 'What we found', customerValueLabel: 'Raccoon', value: 'raccoon' }],
    },
    activity: null,
    applications: [],
    photos: [],
  }));
  expect(ungroundedClaims('We relocated the raccoon from the property.', wildlifeFacts)
    .filter((p) => p.startsWith('ungrounded_pest'))).toEqual([]);
  // the recorded animal can't be swapped
  expect(ungroundedClaims('A squirrel was relocated from the property.', wildlifeFacts)).toContain('ungrounded_pest:squirrel');
});

test('negative-valued findings do not ground their action label (codex r2 polarity)', () => {
  const facts = groundingFacts(roachInput({
    typedReport: {
      reportTypeLabel: 'Cockroach Treatment',
      todaysResult: { headline: 'Cockroach activity was high today.', body: 'We treated cracks and crevices today.', nextStep: null },
      findings: [
        { fieldKey: 'species', customerLabel: 'What we found', customerValueLabel: 'German cockroaches', value: 'german' },
        { fieldKey: 'monitors', customerLabel: 'Monitors placed', customerValueLabel: 'No', value: 'No' },
      ],
    },
  }));
  expect(ungroundedClaims('We placed monitors in the kitchen.', facts)).toContain('ungrounded_action:monitors');
});

test('termite bait maps ground activity-status counts by their own role', () => {
  const termiteFacts = groundingFacts(roachInput({
    serviceTypeDisplay: 'Termite Bait Station Monitoring',
    reportTypeLabel: 'Termite Bait Station Check',
    typedReport: {
      reportTypeLabel: 'Termite Bait Station Check',
      todaysResult: { headline: 'Stations were checked today.', body: 'We checked 10 bait stations today.', nextStep: null },
      findings: [{ fieldKey: 'species', customerLabel: 'What we found', customerValueLabel: 'Subterranean termites', value: 'subterranean' }],
    },
    activity: null,
    stationSummary: { total: 10, checked: 10, activity: 2, serviced: 0, inaccessible: 0 },
    stationProgram: 'termite',
    applications: [],
    photos: [],
  }));
  expect(termiteFacts.stations).toMatchObject({ program: 'termite', stationsWithActivity: 2 });
  // the accurate activity-count sentence survives; role swaps reject
  expect(ungroundedClaims('Termite activity was observed at 2 stations.', termiteFacts)).toEqual([]);
  expect(ungroundedClaims('2 stations were inspected today.', termiteFacts)).toContain('uncorroborated_count:2 stations');
  // deterministic fallback carries the map-recorded activity count
  expect(deterministicSummary(termiteFacts)).toContain('10 of 10 stations were inspected, with activity observed at 2 stations.');
});

test('clean model copy is accepted; a withheld pesticide echo falls back', async () => {
  const clean = 'Cockroach activity was high today, with German cockroaches noted in the kitchen, bathrooms, and under the sink. We applied an insect growth regulator, treated cracks and crevices, and completed a flush-out treatment. Photo evidence documented droppings and cast skins under the kitchen sink. A follow-up visit in 10–14 days is recommended, and your next visit is scheduled for Monday, August 3, arriving 3–5 PM.';
  const accepted = await applyTypedReportNarrative(roachInput(), {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: clean } }),
  });
  // care-instruction preservation is ENFORCED: the narrative paraphrased
  // the follow-up, so the ratified next-step sentence is appended verbatim,
  // and mandatory care sentences embedded in the ratified BODY (the
  // "keep treated areas undisturbed" obligation) append too (codex r2+r3)
  expect(accepted).toContain(clean);
  expect(accepted).toContain('A follow-up visit in 10–14 days is recommended to stay ahead of newly hatching activity.');
  expect(accepted).toContain('Please keep treated areas undisturbed so the treatment can work.');

  const echoed = await applyTypedReportNarrative(roachInput(), {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: 'We applied Gentrol IGR to the cracks and crevices throughout the kitchen and completed a full flush-out treatment of the affected areas today.' } }),
  });
  expect(echoed).toContain('Cockroach activity was high today.');
  expect(echoed).not.toContain('Gentrol');
});
