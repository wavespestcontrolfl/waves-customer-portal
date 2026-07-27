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
  expect(accepted).toBe(clean);

  const echoed = await applyTypedReportNarrative(roachInput(), {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: 'We applied Gentrol IGR to the cracks and crevices throughout the kitchen and completed a full flush-out treatment of the affected areas today.' } }),
  });
  expect(echoed).toContain('Cockroach activity was high today.');
  expect(echoed).not.toContain('Gentrol');
});
