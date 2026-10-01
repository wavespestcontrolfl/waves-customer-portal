// Rodent report narrative (GATE_RODENT_REPORT_REFRESH summary enrichment).
//
// Load-bearing behaviors: the model NEVER speaks unguarded (banned copy,
// out-of-bounds length, or a withheld product-name echo falls back to the
// deterministic summary), the deterministic summary is assembled only from
// ratified copy (snapshot Today's Result / recap) plus factual counts and a
// plain next-visit sentence, registered pesticide products never enter the
// prompt by name, and generation caches on the grounding-facts hash.

const {
  applyRodentReportNarrative,
  _test,
} = require('../services/service-report/rodent-report-narrative');

const {
  groundingFacts,
  deterministicSummary,
  deviceFacts,
  isNameableDevice,
  echoesWithheldName,
  ungroundedClaims,
  buildUserMessage,
  _cache,
} = _test;

const {
  nextVisitProblems, isVisitClaim, splitSentences, withoutTimedVisitClaims,
} = require('../services/service-report/next-visit-claims');

const RECAP = 'Today we completed your Rodent Trapping Service. We treated the accessible service areas. - Waves';

let seq = 0;
function input(overrides = {}) {
  seq += 1;
  return {
    recap: `${RECAP} (case ${seq})`,
    serviceTypeDisplay: 'Rodent Trapping Service',
    typedReport: {
      todaysResult: {
        headline: 'Rodent activity was moderate today.',
        body: 'We checked 7 traps today. We will return for the scheduled trap check.',
        nextStep: 'We will return for the scheduled trap check.',
      },
      findings: [
        { fieldKey: 'species', customerLabel: 'What we found', customerValueLabel: 'Roof rats', value: 'Roof rat' },
        { fieldKey: 'traps_checked', customerLabel: 'Traps checked', customerValueLabel: '7', value: '7' },
        { fieldKey: 'captures', customerLabel: 'Captures', customerValueLabel: '0', value: '0' },
      ],
    },
    activity: { label: 'Rodent Activity', levelWord: 'Moderate activity', score: 3, maxScore: 5, isBaseline: true, trendWord: null },
    stationSummary: { total: 7, checked: 7, activity: 0, serviced: 0, inaccessible: 0 },
    stationProgram: 'trapping',
    applications: [
      {
        product: {
          name: 'Victor Expanded Trigger Rat Snap Trap',
          epa_reg: 'N/A',
          active_ingredient: 'Mechanical snap trap',
          category: 'Rodent Control',
          service_report_summary: 'A mechanical trap or monitoring device used to detect and capture activity — it contains no pesticide.',
        },
      },
    ],
    photos: [{ caption: 'Attic insulation with a dark pellet consistent with rodent droppings visible on the wiring.' }],
    nextAppointment: { serviceType: 'Rodent Trap Check', scheduledDate: '2026-08-03', windowStart: '08:00' },
    ...overrides,
  };
}

beforeEach(() => _cache.clear());

test('groundingFacts keeps only usable facts', () => {
  const facts = groundingFacts(input());
  expect(facts.findings).toEqual([
    { label: 'What we found', value: 'Roof rats' },
    { label: 'Traps checked', value: '7' },
    { label: 'Captures', value: '0' },
  ]);
  // wording only — the raw score/maxScore never enter the facts (customer
  // copy must never carry the numeric activity score)
  expect(facts.activity).toMatchObject({ levelWord: 'Moderate activity', isBaseline: true });
  expect(facts.activity.score).toBeUndefined();
  expect(facts.activity.maxScore).toBeUndefined();
  // trapping names the fact for what the number IS: traps carrying a
  // capture status, never a capture total (codex P1)
  expect(facts.stations).toEqual({ program: 'trapping', total: 7, checked: 7, trapsWithCaptureRecorded: 0, serviced: 0, inaccessible: 0 });
  // bait-station programs get consumption semantics instead
  expect(groundingFacts(input({ stationProgram: 'rodent', stationSummary: { total: 4, checked: 4, activity: 2, serviced: 0, inaccessible: 0 } })).stations)
    .toEqual({ program: 'rodent', total: 4, checked: 4, stationsWithBaitConsumption: 2, serviced: 0, inaccessible: 0 });
  expect(facts.photoEvidence).toHaveLength(1);
  expect(facts.nextVisit).toMatchObject({ date: 'Monday, August 3', window: '8–10 AM' });

  // absent inputs drop cleanly
  const bare = groundingFacts(input({
    activity: null, stationSummary: null, applications: [], photos: [], nextAppointment: null,
  }));
  expect(bare.activity).toBeNull();
  expect(bare.stations).toBeNull();
  expect(bare.devices).toEqual([]);
  expect(bare.photoEvidence).toEqual([]);
  expect(bare.nextVisit).toBeNull();
  // zero-station summaries hide the counts entirely
  expect(groundingFacts(input({ stationSummary: { total: 0 } })).stations).toBeNull();
});

test('only explicit mechanical devices are nameable — unknown products fail closed', () => {
  const apps = [
    { product: { name: 'Victor Rat Snap Trap', epa_reg: '', active_ingredient: 'Mechanical snap trap', category: 'Rodent Control' } },
    { product: { name: 'Contrac Blox Rodenticide', epa_reg: '12455-79', category: 'Rodenticide' } },
  ];
  const devices = deviceFacts(apps);
  expect(devices[0]).toMatchObject({ name: 'Victor Rat Snap Trap', nameable: true });
  expect(devices[1]).toMatchObject({ name: null, nameable: false, category: 'Rodenticide' });
  // a bare/N-A/none EPA field proves NOTHING (legacy rows, 25(b)-exempt
  // pesticides) — without an explicit device signal the product stays
  // generic (codex P2)
  expect(isNameableDevice({ epa_reg: 'N/A' })).toBe(false);
  expect(isNameableDevice({ epa_reg: 'none' })).toBe(false);
  expect(isNameableDevice({ epa_reg: '', name: 'Essentria IC-3' })).toBe(false);
  expect(isNameableDevice({ epa_reg: '12455-79', active_ingredient: 'Mechanical snap trap' })).toBe(false);
  expect(isNameableDevice({ epa_reg: 'N/A', active_ingredient: 'Mechanical snap trap' })).toBe(true);
  expect(isNameableDevice({ epa_reg: '', service_report_summary: 'A monitoring device — it contains no pesticide.' })).toBe(true);

  const message = buildUserMessage(groundingFacts(input({ applications: apps })));
  expect(message).toContain('Victor Rat Snap Trap');
  expect(message).not.toContain('Contrac');

  // and an echo of the withheld name in model output is caught
  expect(echoesWithheldName('We refreshed the Contrac placements.', apps)).toBe(true);
  expect(echoesWithheldName('We checked the Victor snap traps.', apps)).toBe(false);
  // ...but generic/category vocabulary in a withheld name never blocks
  // compliant copy (codex round-5 P2): "Rodenticide" is the permitted
  // generic description, not the product's identity
  expect(echoesWithheldName('A rodenticide was secured in tamper-resistant stations.', apps)).toBe(false);
});

test('ungrounded numbers and unsupported capture/consumption claims are rejected', () => {
  const facts = groundingFacts(input());
  // every numeral in clean copy is grounded (7 traps)
  expect(ungroundedClaims('We inspected all 7 traps. We will check them again at your next visit.', facts)).toEqual([]);
  // score-ratio phrasing is banned outright (raw activity scores never
  // reach customer copy — codex round-5 P2)
  expect(ungroundedClaims('Rodent activity was 3 out of 5 today.', facts).some((p) => p.startsWith('score_ratio_phrasing'))).toBe(true);
  // a changed count is caught
  expect(ungroundedClaims('We inspected 9 traps today.', facts)).toContain('ungrounded_number:9');
  // an invented capture (zero traps carry the status) is caught even without digits
  expect(ungroundedClaims('We removed a capture from the garage trap.', facts)).toContain('unsupported_capture_claim');
  // negated forms stay clean
  expect(ungroundedClaims('No captures were recorded on this visit.', facts)).toEqual([]);
  // consumption claims need a bait-station fact
  expect(ungroundedClaims('Bait consumption was observed at the rear station.', facts)).toContain('unsupported_consumption_claim');

  // counts are validated against the fact they describe, not the global
  // number pool: 5 is grounded (activity maxScore) but is NOT a trap count
  // (codex round-2 P1)
  expect(ungroundedClaims('We checked 5 traps today.', facts)).toContain('uncorroborated_count:5 traps');
  // spelled-out counts can't route around the numeral check
  expect(ungroundedClaims('We checked five traps today.', facts)).toContain('uncorroborated_count:5 traps');
  expect(ungroundedClaims('We inspected all seven traps today.', facts)).toEqual([]);
  // partitive phrasing claims no count and harmless word-numbers stay clean
  // (no location named — an action-at-location claim would need a paired
  // completed-work fact)
  expect(ungroundedClaims('One of the traps was relocated during the visit.', facts)).toEqual([]);

  // counts validate per NOUN, not against a shared pool (codex round-3 P1):
  // with 7 checked and captures at 2 traps, the model can't swap the facts
  const swapFacts = groundingFacts(input({
    stationSummary: { total: 7, checked: 7, activity: 2, serviced: 0, inaccessible: 0 },
  }));
  expect(ungroundedClaims('A capture was recorded at 2 traps.', swapFacts)).toEqual([]);
  expect(ungroundedClaims('2 traps were inspected today.', swapFacts)).toContain('uncorroborated_count:2 traps');
  expect(ungroundedClaims('We recorded 7 captures today.', swapFacts)).toContain('uncorroborated_count:7 captures');
  // even a SUPPORTED capture only publishes as the grounded generic form —
  // freeform species/room detail rejects (codex round-6 P1)
  expect(ungroundedClaims('We caught a rat in the kitchen.', swapFacts)).toContain('unsupported_capture_claim');
  // a NEGATED claim against a positive record is a contradiction (codex
  // round-7 P1): "no captures" must reject when a capture IS recorded
  expect(ungroundedClaims('No captures were recorded on this visit.', swapFacts))
    .toContain('contradicted_capture_negative');
  // the allowed template is ANCHORED over the clause (codex round-8 P1):
  // an invented location suffix on a safe phrase rejects
  expect(ungroundedClaims('A capture was recorded in the kitchen.', swapFacts))
    .toContain('unsupported_capture_claim');
  expect(ungroundedClaims('7 of 7 traps were inspected, with a capture recorded at 2 traps.', swapFacts)).toEqual([]);
  // a NEGATIVE claim needs explicit zero evidence (codex round-8 P1): with
  // no typed capture finding AND no station map, nothing recorded a zero
  const noRecord = groundingFacts(input({
    stationSummary: null,
    typedReport: {
      todaysResult: { headline: 'Rodent activity was moderate today.', body: 'We completed the rodent service today.', nextStep: null },
      findings: [{ fieldKey: 'traps_checked', customerLabel: 'Traps checked', customerValueLabel: '7', value: '7' }],
    },
  }));
  expect(ungroundedClaims('No captures were recorded on this visit.', noRecord))
    .toContain('ungrounded_capture_negative');

  // totality quantifiers are validated without digits (codex round-7 P1)
  expect(ungroundedClaims('All traps were inspected today.', facts)).toEqual([]); // 7 of 7 — true
  const partialFacts = groundingFacts(input({
    stationSummary: { total: 7, checked: 5, activity: 0, serviced: 0, inaccessible: 2 },
    typedReport: {
      todaysResult: { headline: 'Rodent activity was moderate today.', body: 'We checked 5 traps today.', nextStep: null },
      findings: [
        { fieldKey: 'traps_checked', customerLabel: 'Traps checked', customerValueLabel: '5', value: '5' },
        { fieldKey: 'captures', customerLabel: 'Captures', customerValueLabel: '0', value: '0' },
      ],
    },
  }));
  expect(ungroundedClaims('All traps were inspected today.', partialFacts)).toContain('uncorroborated_totality:All traps');
  expect(ungroundedClaims('Both traps were checked today.', facts)).toContain('uncorroborated_totality:Both traps');
  // post-nominal quantifiers count too (codex round-8 P1)
  expect(ungroundedClaims('The traps were all inspected today.', partialFacts).some((p) => p.startsWith('uncorroborated_totality'))).toBe(true);
  expect(ungroundedClaims('The traps were all inspected today.', facts)).toEqual([]);
  // roster references without a role verb claim nothing
  expect(ungroundedClaims('The service covers all of the traps around your home.', facts)).toEqual([]);

  // With a visit scheduled the narrative never says when we return (owner
  // ruling 2026-09-28): any timed visit claim rejects, agreeing or not. The
  // next-visit fixture table below covers every spelling.
  for (const timed of [
    'Your next visit is Monday, August 3, arriving 8–10 AM.',
    'Next visit Monday, August 3, arriving 8–10 AM.',
    'Your next visit is Monday, August 3 at 8 PM.',
    'Arriving Monday, August 3 at 8 PM.',
    'Your next visit is tomorrow, Monday, August 3, arriving 8–10 AM.',
    'Your next visit is next Monday, arriving 8–10 AM.',
    'Today we completed service. Your next visit is Monday, August 3, arriving 8–10 AM.',
  ]) {
    expect(ungroundedClaims(timed, facts).some((p) => p.startsWith('visit_timing_stated:'))).toBe(true);
  }
  expect(ungroundedClaims('We will check the traps at your next visit.', facts)).toEqual([]);
  expect(ungroundedClaims('Service was completed this afternoon.', facts)).toEqual([]);

  expect(ungroundedClaims('Your next visit is Tuesday.', facts)).toEqual(['visit_timing_stated:tuesday']);
  expect(ungroundedClaims('We will see you Monday for the next check.', facts)).toEqual(['visit_timing_stated:monday']);

  // negation is judged per claim — one negated sentence can't launder a
  // positive claim elsewhere (codex round-3 P2)
  expect(ungroundedClaims('No captures were recorded in the attic. We removed a capture from the garage trap.', facts))
    .toContain('unsupported_capture_claim');
  // ...and an unrelated negative in the SAME sentence can't either (codex
  // round-4 P1): the negator must sit in the claim's own clause
  expect(ungroundedClaims('No droppings were observed, but we removed a capture from the garage.', facts))
    .toContain('unsupported_capture_claim');
  expect(ungroundedClaims('Captures were not recorded on this visit.', facts)).toEqual([]);

  // capture/consumption SYNONYMS are covered (codex round-5 P1): caught,
  // trapped, rodent-removal, and eaten-bait wording all claim the events
  expect(ungroundedClaims('We caught a rat near the garage entry.', facts)).toContain('unsupported_capture_claim');
  expect(ungroundedClaims('A rodent was removed from the attic during service.', facts)).toContain('unsupported_capture_claim');
  expect(ungroundedClaims('One rodent was trapped at the rear station.', facts)).toContain('unsupported_capture_claim');
  expect(ungroundedClaims('The bait had been eaten at the rear placement.', facts)).toContain('unsupported_consumption_claim');
  // negated synonym forms stay clean; removal of non-rodent things is not a claim
  expect(ungroundedClaims('No rodents were caught on this visit.', facts)).toEqual([]);
  expect(ungroundedClaims('We removed debris from the trap line area.', facts)).toEqual([]);

  // station count ROLES stay separate (codex round-4 P1): with 7 total, 5
  // checked, 2 inaccessible, an inaccessible count can't pose as inspected
  const roleFacts = groundingFacts(input({
    stationSummary: { total: 7, checked: 5, activity: 0, serviced: 0, inaccessible: 2 },
    typedReport: {
      todaysResult: { headline: 'Rodent activity was moderate today.', body: 'We checked 5 traps today.', nextStep: null },
      findings: [
        { fieldKey: 'traps_checked', customerLabel: 'Traps checked', customerValueLabel: '5', value: '5' },
        { fieldKey: 'captures', customerLabel: 'Captures', customerValueLabel: '0', value: '0' },
      ],
    },
  }));
  expect(ungroundedClaims('2 traps were inspected today.', roleFacts)).toContain('uncorroborated_count:2 traps');
  expect(ungroundedClaims('5 of 7 traps were inspected, and 2 traps were not accessible.', roleFacts)).toEqual([]);

  // the hidden date's numbers never ground a count either (codex P1 on #5262 r2)
  expect(ungroundedClaims('See you on September 3.', facts)).toEqual(['ungrounded_number:3', 'visit_timing_stated:september 3']);
  // with no grounded next visit, any window/date mention rejects
  const noVisit = groundingFacts(input({ nextAppointment: null }));
  expect(ungroundedClaims('We will arrive 8–10 AM.', noVisit).some((p) => p.startsWith('ungrounded_window'))).toBe(true);
});

test('withheld product identity partitions the narrative cache', async () => {
  const clean = 'Today we completed your rodent trapping visit and inspected all 7 traps, with no captures recorded. We documented droppings in the attic insulation, and today’s moderate activity reading sets the baseline for your program.';
  const callModel = jest.fn().mockResolvedValue({ ok: true, json: { summary: clean } });
  const base = input();
  const withBait = (name) => ({
    ...base,
    applications: [
      ...base.applications,
      { product: { name, epa_reg: '12455-79', category: 'Rodenticide' } },
    ],
  });
  // identical grounding facts (withheld names never enter them), different
  // withheld products — the cache must NOT share the entry (codex round-4 P2)
  await applyRodentReportNarrative(withBait('Contrac Blox Rodenticide'), { callModel });
  await applyRodentReportNarrative(withBait('Ditrac All-Weather Blox'), { callModel });
  expect(callModel).toHaveBeenCalledTimes(2);
});

test('deterministic summary = ratified copy + factual counts, never the next visit date', () => {
  const text = deterministicSummary(groundingFacts(input()));
  expect(text).toContain('Rodent activity was moderate today.');
  expect(text).toContain('We checked 7 traps today.');
  // the zero-captures claim is grounded in the typed Captures finding
  expect(text).toContain('7 of 7 traps were inspected, with no captures recorded.');
  expect(text).toContain('Photos from this visit are included with this report.');
  // the report's upcoming-visits section carries the date (owner ruling 2026-09-28)
  expect(text).not.toMatch(/August 3|8–10 AM|next visit is scheduled/);

  // NO typed capture record → zero is never inferred from map statuses
  // alone (a positive typed count with unflagged pins is a permitted
  // state — codex round-3 P1); the clause is omitted entirely
  const noTypedCaptures = deterministicSummary(groundingFacts(input({
    typedReport: {
      todaysResult: { headline: 'Rodent activity was moderate today.', body: 'We checked 7 traps today.', nextStep: null },
      findings: [{ fieldKey: 'traps_checked', customerLabel: 'Traps checked', customerValueLabel: '7', value: '7' }],
    },
  })));
  expect(noTypedCaptures).toContain('7 of 7 traps were inspected.');
  expect(noTypedCaptures).not.toContain('captures');

  // typed positive + zero flagged pins → the typed count speaks, never "no captures"
  const typedPositive = deterministicSummary(groundingFacts(input({
    typedReport: {
      todaysResult: { headline: 'We removed captures today.', body: null, nextStep: null },
      findings: [{ fieldKey: 'captures', customerLabel: 'Captures', customerValueLabel: '3', value: '3' }],
    },
  })));
  expect(typedPositive).toContain('7 of 7 traps were inspected, with 3 captures recorded.');
  expect(typedPositive).not.toContain('no captures');

  // bait programs mirror the sourcing rule (codex round-7 P1): a zero
  // claim comes only from the typed bait-consumption finding
  const baitInput = (findings, activity = 0) => input({
    stationProgram: 'rodent',
    stationSummary: { total: 4, checked: 4, activity, serviced: 0, inaccessible: 0 },
    typedReport: {
      todaysResult: { headline: 'Bait stations were checked today.', body: null, nextStep: null },
      findings,
    },
  });
  // typed positive + zero flagged pins → consumption still speaks, never "no"
  const baitPositive = deterministicSummary(groundingFacts(baitInput([
    { fieldKey: 'bait_consumption', customerLabel: 'Bait consumption', customerValueLabel: 'Moderate', value: 'Moderate' },
  ])));
  expect(baitPositive).toContain('4 of 4 bait stations were inspected, with bait consumption observed.');
  expect(baitPositive).not.toContain('no bait consumption');
  // typed "None" grounds the zero claim
  expect(deterministicSummary(groundingFacts(baitInput([
    { fieldKey: 'bait_consumption', customerLabel: 'Bait consumption', customerValueLabel: 'None', value: 'None' },
  ])))).toContain('with no bait consumption observed.');
  // NO typed consumption record → zero is never inferred from pin statuses
  const baitUnreconciled = deterministicSummary(groundingFacts(baitInput([])));
  expect(baitUnreconciled).toContain('4 of 4 bait stations were inspected.');
  expect(baitUnreconciled).not.toContain('consumption');

  // traps-with-capture counts render as locations, never capture totals
  // (one trap can hold multiple captures — codex P1)
  const captures = deterministicSummary(groundingFacts(input({
    stationSummary: { total: 7, checked: 7, activity: 2, serviced: 0, inaccessible: 0 },
  })));
  expect(captures).toContain('with a capture recorded at 2 traps');
  // bait-station programs speak consumption, not captures
  const bait = deterministicSummary(groundingFacts(input({
    stationProgram: 'rodent',
    stationSummary: { total: 4, checked: 4, activity: 1, serviced: 0, inaccessible: 0 },
  })));
  expect(bait).toContain('4 of 4 bait stations were inspected, with bait consumption observed at 1 station.');
  // without a snapshot body the recap carries the summary
  const noSnapshot = groundingFacts(input({ typedReport: null }));
  expect(deterministicSummary(noSnapshot)).toContain('Today we completed your Rodent Trapping Service.');
});

test('model copy is used when clean, and caches on the facts hash', async () => {
  const callModel = jest.fn().mockResolvedValue({
    ok: true,
    json: { summary: 'Today we completed your rodent trapping visit and inspected all 7 traps, with no captures recorded. We documented droppings in the attic insulation, and today’s moderate activity reading sets the baseline for your program.' },
  });
  const one = input();
  const first = await applyRodentReportNarrative(one, { callModel });
  expect(first).toContain('sets the baseline');
  const again = await applyRodentReportNarrative(one, { callModel });
  expect(again).toBe(first);
  expect(callModel).toHaveBeenCalledTimes(1);
});

test('grounded relative care timing survives without authorizing a relative appointment', async () => {
  const args = input();
  args.typedReport = {
    ...args.typedReport,
    todaysResult: {
      ...args.typedReport.todaysResult,
      nextStep: 'Contact us tomorrow if activity returns.',
    },
  };
  const facts = groundingFacts(args);
  const summary = 'Today we completed your rodent trapping visit and inspected all 7 traps, with no captures recorded. '
    + 'We documented droppings in the attic insulation, and today’s moderate activity reading sets the baseline for your program. '
    + 'Contact us tomorrow if activity returns.';
  expect(ungroundedClaims(summary, facts)).toEqual([]);
  expect(ungroundedClaims(
    `${summary} Your next visit is tomorrow.`,
    facts,
  )).toContain('visit_timing_stated:tomorrow');
  for (const appointmentCare of [
    'We will visit tomorrow.',
    'Your service is scheduled for tomorrow.',
    'We will be there tomorrow.',
    'We are returning tomorrow.',
    'The technician returns tomorrow.',
  ]) {
    const appointmentArgs = {
      ...args,
      recap: `${args.recap} ${appointmentCare}`,
      typedReport: {
        ...args.typedReport,
        todaysResult: { ...args.typedReport.todaysResult, nextStep: appointmentCare },
      },
    };
    const appointmentFacts = {
      ...facts,
      todaysResult: { ...facts.todaysResult, nextStep: appointmentCare },
    };
    const invalidSummary = summary.replace('Contact us tomorrow if activity returns.', appointmentCare);
    expect(ungroundedClaims(
      invalidSummary,
      appointmentFacts,
    )).toContain('visit_timing_stated:tomorrow');
    const rejected = await applyRodentReportNarrative(appointmentArgs, {
      callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: invalidSummary } }),
    });
    expect(rejected).not.toContain(appointmentCare);
  }
  const out = await applyRodentReportNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  expect(out).toContain(summary);
  expect(out).toContain('Contact us tomorrow if activity returns.');

  const timedCare = 'Contact us at 8 AM if activity returns.';
  const timedArgs = {
    ...args,
    typedReport: {
      ...args.typedReport,
      todaysResult: { ...args.typedReport.todaysResult, nextStep: timedCare },
    },
  };
  const timedFacts = groundingFacts(timedArgs);
  const timedSummary = summary.replace('Contact us tomorrow if activity returns.', timedCare);
  expect(ungroundedClaims(timedSummary, timedFacts)).toEqual([]);
  const timedOut = await applyRodentReportNarrative(timedArgs, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: timedSummary } }),
  });
  expect(timedOut).toContain(timedSummary);
  expect(timedOut).toContain(timedCare);

  const dottedArgs = input();
  dottedArgs.typedReport = {
    ...dottedArgs.typedReport,
    todaysResult: {
      ...dottedArgs.typedReport.todaysResult,
      nextStep: 'Contact us tomorrow if activity returns.',
    },
  };
  const dottedSummary = summary.replace('Monday, August 3', 'Sep. 3');
  const dottedOut = await applyRodentReportNarrative(dottedArgs, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: dottedSummary } }),
  });
  expect(dottedOut).not.toContain('Sep. 3');

  // Source punctuation never detaches a date or time from its visit claim
  // (independent review P1 on #5055, L1349): the ratified sentence stays
  // whole, so it is validated as a claim instead of leaving an exempt "3.".
  for (const [sourceCare, modelCare, expectedProblem] of [
    [
      'Your next visit is Monday, Aug. 3, arriving 8–10 a.m. tomorrow.',
      'Your next visit is Monday, Aug. 3, arriving 8–10 a.m. tomorrow.',
      'visit_timing_stated:tomorrow',
    ],
    [
      'Your next visit is Sep. 3.',
      'Your next appointment is Sep. 3.',
      'visit_timing_stated:sep. 3',
    ],
    [
      'Your next visit is Monday, Aug. 4.',
      'Your next visit is Monday, Aug. 4.',
      'visit_timing_stated:monday, aug. 4',
    ],
  ]) {
    const appointmentArgs = {
      ...args,
      typedReport: {
        ...args.typedReport,
        todaysResult: { ...args.typedReport.todaysResult, nextStep: sourceCare },
      },
    };
    const appointmentFacts = groundingFacts(appointmentArgs);
    const invalidSummary = summary.replace('Contact us tomorrow if activity returns.', modelCare);
    expect(ungroundedClaims(invalidSummary, appointmentFacts)).toContain(expectedProblem);
    const rejected = await applyRodentReportNarrative(appointmentArgs, {
      callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: invalidSummary } }),
    });
    expect(rejected).not.toContain(modelCare);
    expect(rejected).not.toContain(sourceCare);
  }

  const weatherCare = 'Rain is expected Sep. 3, ending at 8 a.m. tomorrow, so keep the traps dry.';
  const weatherArgs = {
    ...args,
    typedReport: {
      ...args.typedReport,
      todaysResult: { ...args.typedReport.todaysResult, nextStep: weatherCare },
    },
  };
  const weatherFacts = groundingFacts(weatherArgs);
  const weatherSummary = summary.replace('Contact us tomorrow if activity returns.', weatherCare);
  expect(ungroundedClaims(weatherSummary, weatherFacts)).toEqual([]);
  const weatherOut = await applyRodentReportNarrative(weatherArgs, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: weatherSummary } }),
  });
  expect(weatherOut).toContain(weatherSummary);

  const sentenceBoundaryCare = 'Contact us at 8 a.m. We will check the traps at your next visit.';
  const sentenceBoundaryArgs = {
    ...args,
    typedReport: {
      ...args.typedReport,
      todaysResult: { ...args.typedReport.todaysResult, nextStep: sentenceBoundaryCare },
    },
  };
  const sentenceBoundaryFacts = groundingFacts(sentenceBoundaryArgs);
  const sentenceBoundarySummary = summary.replace('Contact us tomorrow if activity returns.', sentenceBoundaryCare);
  expect(ungroundedClaims(sentenceBoundarySummary, sentenceBoundaryFacts)).toEqual([]);
  const sentenceBoundaryOut = await applyRodentReportNarrative(sentenceBoundaryArgs, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: sentenceBoundarySummary } }),
  });
  expect(sentenceBoundaryOut).toContain(sentenceBoundarySummary);
});

describe('next-visit claims fixture table', () => {
  const facts = { nextVisit: { date: 'Monday, August 3', window: '8–10 AM' } };
  const problemsFor = (text, care = []) => nextVisitProblems(text, facts, { groundedCareExemptions: care });
  // With nothing scheduled, timing in a claim is judged on its own merits.
  const unscheduledProblems = (text, care = []) => nextVisitProblems(text, {}, { groundedCareExemptions: care });

  // With a visit on the schedule the narrative never says when we return
  // (owner ruling 2026-09-28): every spelling of an exact time, date,
  // weekday, window, or relative date inside a future visit claim is a
  // problem, even when it agrees. Care copy and past visits keep their time
  // words. [text, expected problems]
  test.each([
    ['Your next visit is Monday, August 3, arriving 8–10 AM.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:8–10 am.']],
    ['Your next visit is Monday, Aug. 3, arriving eight–ten AM.', ['visit_timing_stated:monday, aug. 3', 'visit_timing_stated:8–10 am.']],
    ['Service was completed this afternoon.', []],
    ['We inspected all 7 traps and recorded a capture at 2 traps.', []],
    ['Results usually show after 2 or 3 days.', []],
    ['Captures were recorded at 2 of 7 stations; one may need moving.', []],
    // word-form exact arrival promises (codex P1 on #5055, L6)
    ['Your next visit is Monday, August 3 at eight AM.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:8 am.']],
    ["Your next visit is Monday, August 3 at eight o'clock.", ['visit_timing_stated:monday, august 3', "visit_timing_stated:8 o'clock"]],
    ['Your next visit is Monday, August 3 at 8 o’clock.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:8 o’clock']],
    ['We arrive Monday, August 3 at nine in the morning.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:9 in the morning']],
    ['We arrive Monday, August 3 at eight thirty a.m.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:8 30 a.m.']],
    ['We arrive Monday, August 3 at half past eight.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:half past 8']],
    ['We arrive Monday, August 3 at eight.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:at 8']],
    ['We arrive Monday, August 3 at 8 sharp.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:at 8']],
    ['We arrive Monday, August 3 at noon.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:noon']],
    ['Your next visit is Monday, August 3, arriving 8–10 AM, specifically at 10 AM.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:8–10 am', 'visit_timing_stated:10 am.']],
    // dates, weekdays, relative dates
    ['Your next visit is Monday, September third.', ['visit_timing_stated:monday, september 3rd']],
    ['Your next visit is on the 3rd of September.', ['visit_timing_stated:3rd of september']],
    ['Your next visit is Monday, August the third.', ['visit_timing_stated:monday, august the 3rd']],
    ['Your next visit is Tue., Aug 3.', ['visit_timing_stated:tue., aug 3']],
    ['Your next visit is Sep 3, arriving 8–10 AM.', ['visit_timing_stated:sep 3', 'visit_timing_stated:8–10 am.']],
    ['Your next visit is next Monday.', ['visit_timing_stated:next monday']],
    ['Your next visit is this coming Monday.', ['visit_timing_stated:this coming monday']],
    ['Your next visit is Monday after next.', ['visit_timing_stated:monday after next']],
    ['Your next visit is tomorrow.', ['visit_timing_stated:tomorrow']],
    ['We will be back Tuesday.', ['visit_timing_stated:tuesday']],
    // relative durations used as the visit date (codex P1 on #5055, L56):
    // only a visit claim makes a span of time an appointment date
    ['Your next visit is in 7 days.', ['visit_timing_stated:in 7 days']],
    ['We will be back in seven days.', ['visit_timing_stated:in 7 days']],
    ['Our technician returns within two weeks.', ['visit_timing_stated:within 2 weeks']],
    ['We will be back in a couple of days.', ['visit_timing_stated:in a couple of days']],
    ['Your follow-up is 10 days from now.', ['visit_timing_stated:10 days from now']],
    ['A follow-up visit in 10–14 days is recommended.', ['visit_timing_stated:in 10–14 days']],
    ['Results should appear within two weeks.', []],
    ['Results should appear within two weeks. We will be back in 7 days.', ['visit_timing_stated:in 7 days']],
    // prose arrival ranges are windows, compared by value (codex P1 on
    // #5055, L46); counts written as ranges are not
    ['Your next visit is Monday, August 3, arriving between 7 and 8.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:between 7 and 8']],
    ['Your next visit is Monday, August 3, arriving from 7 to 8.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:from 7 to 8']],
    ['We will arrive between 7 and 8 on Monday, August 3.', ['visit_timing_stated:between 7 and 8', 'visit_timing_stated:monday, august 3']],
    ['Your next visit is Monday, August 3, arriving 9 to 11 AM.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:9 to 11 am.']],
    ['Your next visit is Monday, August 3, arriving eight to ten in the evening.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:8 to 10 in the evening']],
    ['Your next visit is Monday, August 3, arriving 8–10 PM.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:8–10 pm.']],
    ['Your next visit is Monday, August 3, arriving between eight and ten.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:between 8 and 10']],
    ['Your next visit is Monday, August 3, arriving between 8 and 10 AM.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:between 8 and 10 am.']],
    ['Your next visit is Monday, August 3, arriving 8 to 10 in the morning.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:8 to 10 in the morning']],
    ['Your next visit is Monday, August 3, arriving 8 AM to 10 AM.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:8 am to 10 am.']],
    ['Your next visit is Monday, August 3, arriving from 8:00 until 10:00 a.m.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:from 8:00 until 10:00 a.m.']],
    ['We arrive Monday, August 3 between 8 and 10 AM, specifically at 9 AM.', ['visit_timing_stated:monday, august 3', 'visit_timing_stated:between 8 and 10 am', 'visit_timing_stated:9 am.']],
    ['Captures were recorded at between 2 and 3 traps.', []],
    ['Activity dropped from 3 to 2 stations.', []],
    // Fail closed (codex r3 on #5055): inside a future visit claim every
    // temporal token must agree with the one authoritative appointment, so
    // an unlisted phrasing is rejected instead of passing unseen.
    // lowercase months are months unless a verb follows (L304)
    ['Your next visit is mar 3, arriving 8–10 AM.', ['visit_timing_stated:mar 3', 'visit_timing_stated:8–10 am.']],
    ['Your next visit is may 4, arriving 8–10 AM.', ['visit_timing_stated:may 4', 'visit_timing_stated:8–10 am.']],
    ['Your next visit is may the 4th.', ['visit_timing_stated:may the 4th']],
    ['We will be back in May.', ['visit_timing_stated:may.']],
    ['We will be back in March when activity peaks.', ['visit_timing_stated:march']],
    ['Some traps may need moving before your next visit.', []],
    ['Stains may mar the finish before your next visit.', []],
    // a part of the day must be one the arrival window covers (L260)
    ['Your next visit is Monday afternoon.', ['visit_timing_stated:monday', 'visit_timing_stated:afternoon']],
    ['We will be back Monday evening.', ['visit_timing_stated:monday', 'visit_timing_stated:evening']],
    ['We will be back Monday PM.', ['visit_timing_stated:monday', 'visit_timing_stated:pm']],
    ['Your next visit is tomorrow morning.', ['visit_timing_stated:tomorrow', 'visit_timing_stated:morning']],
    ['Your next visit is this afternoon.', ['visit_timing_stated:this afternoon']],
    ['Your next visit is Monday morning, arriving 8–10 AM.', ['visit_timing_stated:monday', 'visit_timing_stated:morning', 'visit_timing_stated:8–10 am.']],
    // every other token type: relative words, spans, ordinals, numeric
    // dates, bare arrival ranges and hours, abbreviated weekdays
    ['Your next visit is next week.', ['visit_timing_stated:next week']],
    ['We will be back over the weekend.', ['visit_timing_stated:weekend']],
    ['We will be back a week from Monday.', ['visit_timing_stated:a week from monday']],
    ['We will be back on the 4th.', ['visit_timing_stated:on the 4th']],
    ['We will be back on the 3rd.', ['visit_timing_stated:on the 3rd']],
    ['Your next visit is 8/4.', ['visit_timing_stated:8/4']],
    ['Your next visit is 8/3.', ['visit_timing_stated:8/3']],
    ['We will be back Monday, 7–8.', ['visit_timing_stated:monday', 'visit_timing_stated:7–8']],
    ['We will be back Monday by 9.', ['visit_timing_stated:monday', 'visit_timing_stated:by 9']],
    ['We will be back Tue.', ['visit_timing_stated:tue.']],
    ['Your second visit is Monday, August 3.', ['visit_timing_stated:monday, august 3']],
    // completed visits are history, not appointments (L332); anything short
    // of clearly past stays under validation
    ["At today's September 28 visit, we inspected the traps.", []],
    ['We treated on Sep. 3.', []],
    ['Since our visit on Aug. 1, activity has dropped.', []],
    ['Our last visit was Aug. 1.', []],
    ['Our technician visited on Sep. 3.', []],
    // timing binds to the claim clause: the past treatment date is judged
    // against the schedule like any date outside a claim
    ['We treated on Sep. 3 and will return Sep. 10.', ['visit_timing_stated:sep. 10', 'ungrounded_date:Sep. 3']],
    ['Our technician came by Sep. 3 and returns Sep. 10.', ['visit_timing_stated:sep. 3', 'visit_timing_stated:sep. 10']],
    ['Our technician inspected the traps, and the follow-up is Tuesday.', ['visit_timing_stated:tuesday']],
    ['We treated the yard, follow-up Tuesday.', ['visit_timing_stated:tuesday']],
    ['We noted your follow-up as Tuesday.', ['visit_timing_stated:tuesday']],
    ['We set the follow-up for Tuesday.', ['visit_timing_stated:tuesday']],
    // care copy that makes no visit claim keeps its ordinary time words
    ['Keep pets inside this afternoon.', []],
    ['Water the lawn in the morning.', []],
    // relational dates never agree, even when the weekday they name does
    // (codex P1 on #5055 followups, ~L98)
    ['Your next visit is the day after Monday, arriving 8–10 AM.', ['visit_timing_stated:the day after monday', 'visit_timing_stated:8–10 am.']],
    ['Your next visit is the day before Monday, arriving 8–10 AM.', ['visit_timing_stated:the day before monday', 'visit_timing_stated:8–10 am.']],
    ['We will be back the Tuesday after Labor Day.', ['visit_timing_stated:the tuesday after labor day']],
    ['We will be back a week after Labor Day.', ['visit_timing_stated:a week after labor day']],
    // a relational date outside any visit claim is ordinary prose
    ['Mow the lawn the day after treatment.', []],
    // timing anchored on the visit itself is preparation advice
    ['Mow the lawn the day before your next visit.', []],
    // provider prose joined by "and" is not a visit ("front and back")
    ['We treated the front and back yard today.', []],
  ])('%s', (text, expected) => {
    expect(problemsFor(text)).toEqual(expected);
  });

  // Visit claims: which ratified care sentences stay under validation.
  // [ratified sentence, is a visit claim]
  test.each([
    // appointment claims, including return phrasing (codex P1 on #5055, L15)
    ['We are returning tomorrow.', true],
    ['The technician returns tomorrow.', true],
    ["We'll be back Tuesday.", true],
    ['We’ll be back Tuesday.', true],
    ['We return tomorrow to check the traps.', true],
    ['Our team is scheduled to come out tomorrow.', true],
    ['Your technician will stop by tomorrow at 8 AM.', true],
    ['Back Tuesday to check traps.', true],
    ['Returning tomorrow for the trap check.', true],
    ['See you tomorrow.', true],
    ['Expect our technician tomorrow morning.', true],
    ['We will visit tomorrow.', true],
    ['Your service is scheduled for tomorrow.', true],
    ['We will be there tomorrow.', true],
    ['Keep pets inside until we return at 8 AM.', true],
    ['Visit Tuesday at 9 AM.', true],
    ['Please schedule your visit for Tuesday.', true],
    ["We'll do another visit Tuesday.", true],
    // a provider subject carries into a later coordinated clause that names
    // no subject of its own (codex P1 on #5055 followups, ~L157)
    ['We checked all traps and will return tomorrow.', true],
    ['Our technician checked traps but will come back next week.', true],
    ['We inspected the property, then will follow up next week.', true],
    // non-appointment care instructions (codex P1 on #5055, L32)
    ['Contact us at 8 AM if activity returns.', false],
    ['Contact us tomorrow if activity returns.', false],
    ['Water for 20 minutes at 6 AM.', false],
    ['Keep pets off the treated lawn until 2 PM.', false],
    ['If they come back tomorrow, call us.', false],
    ['Contact our team at 8 AM if activity returns.', false],
    ['Call us at 8 AM to book a visit.', false],
    ['We recommend watering at 6 AM on Tuesday.', false],
    // a coordinated clause naming its own (customer) subject never inherits
    // the provider's (codex P1 on #5055 followups, ~L157)
    ['You can mow and water tomorrow.', false],
    ['We treated the yard and noticed increased activity.', false],
    // only auxiliaries may sit between the coordinator and the visit verb, so
    // a clause with its own subject never inherits "we", and a bare "back"
    // is not a visit verb in a coordinated clause
    ['We sealed the entry points, but activity may come back after rain.', false],
    ['We treated the yard and it will come back.', false],
    ['We checked the front and back of the house.', false],
    ['We serviced the bait stations and plan to return next week.', true],
    ['We checked all traps, then will be back Friday.', true],
  ])('%s', (sentence, claim) => {
    expect(isVisitClaim(sentence)).toBe(claim);
    const text = `${sentence} We will check the traps at your next visit.`;
    if (claim) {
      expect(problemsFor(text, [sentence])).toEqual(problemsFor(text));
    } else {
      expect(problemsFor(text, [sentence])).toEqual([]);
    }
  });

  test('with nothing scheduled, a visit-claim span is grounded only by a span the ratified care states', () => {
    const care = 'A follow-up visit in 10–14 days is recommended.';
    expect(unscheduledProblems('A follow-up visit in fourteen days keeps you ahead of new activity.', [care])).toEqual([]);
    expect(unscheduledProblems('Your next visit is in 7 days.', [care])).toEqual(['ungrounded_relative_date:in 7 days']);
    expect(unscheduledProblems('We will be back in 14 weeks.', [care])).toEqual(['ungrounded_relative_date:in 14 weeks']);
  });

  // Only a duration attached to the visit grounds a relative visit promise;
  // outcome timing never does, even beside the word "visit" (codex P1 on
  // #5262).
  test('outcome timing never grounds a relative visit promise and is never itself visit timing', () => {
    const outcome = 'Results should appear within 2 weeks.';
    const outcomeVisit = 'Results should appear within 2 weeks after your visit.';
    const appointmentSpan = 'A follow-up visit in 10–14 days is recommended.';
    expect(unscheduledProblems('We will be back within 2 weeks.', [outcome])).toEqual(['ungrounded_relative_date:within 2 weeks']);
    expect(unscheduledProblems('We will be back within 2 weeks.', [outcomeVisit])).toEqual(['ungrounded_relative_date:within 2 weeks']);
    expect(unscheduledProblems('We will be back within 2 weeks.', [appointmentSpan, outcomeVisit])).toEqual(['ungrounded_relative_date:within 2 weeks']);
    expect(unscheduledProblems('We will be back in 14 days.', [appointmentSpan, outcomeVisit])).toEqual([]);
    expect(unscheduledProblems(outcomeVisit)).toEqual([]);
    expect(problemsFor(outcomeVisit)).toEqual([]);
  });

  // Codex round 1 on #5262.
  test.each([
    // quantified relational dates
    ['We will return two days after Labor Day.', ['visit_timing_stated:2 days after labor day'], ['ungrounded_relative_date:2 days after labor day']],
    // a relational date is read before its embedded date is masked
    ['We will return the day after August 3.', ['visit_timing_stated:the day after august 3'], ['ungrounded_relative_date:the day after august 3']],
    // anchored on the visit, a promise of our return is still timing
    ['We will return the day before your next visit.', ['visit_timing_stated:the day before your next visit'], ['ungrounded_relative_date:the day before your next visit']],
    // anchored on the visit, preparation advice is not
    ['Mow the lawn the day before your next visit.', [], []],
    // the provider carries across a long first clause
    ['We carefully inspected all interior and exterior bait stations throughout the property and will return tomorrow.', ['visit_timing_stated:tomorrow'], ['ungrounded_relative_date:tomorrow']],
    // but not across a clause with its own noun subject
    ['We treated the area and activity subsided but may return tomorrow.', ['ungrounded_relative_date:tomorrow'], ['ungrounded_relative_date:tomorrow']],
    // a visit claim with no timing is fine
    ['We will check the traps at your next visit.', [], []],
  ])('%s', (text, scheduled, unscheduled) => {
    expect(problemsFor(text)).toEqual(scheduled);
    expect(unscheduledProblems(text)).toEqual(unscheduled);
  });

  // Codex round 2 on #5262.
  test.each([
    // a provider after an unpunctuated lead-in still carries
    ['Today we carefully inspected all interior and exterior bait stations and will return tomorrow.', ['visit_timing_stated:tomorrow']],
    // any timeframe word in a promise of our return says when
    ['We will return later in the week.', ['visit_timing_stated:later', 'visit_timing_stated:week']],
    ['We will return in 10 business days.', ['visit_timing_stated:days']],
    ['We will return soon.', ['visit_timing_stated:soon']],
    // preparation anchored on an adjective-qualified visit is not our timing
    ['Mow the lawn the day before your scheduled visit.', []],
    ['Mow the lawn the day before the upcoming visit.', []],
    ['We will return the day before your scheduled visit.', ['visit_timing_stated:the day before your scheduled visit']],
    // a date in a care clause joined to a timing-free claim times the care
    ['Water the lawn Monday, and we will check the traps at your next visit.', []],
    // a range's "and" never splits the claim clause
    ['We will arrive between 7 and 8 on Monday, August 3.', ['visit_timing_stated:between 7 and 8', 'visit_timing_stated:monday, august 3']],
  ])('%s', (text, expected) => {
    expect(problemsFor(text)).toEqual(expected);
  });

  test('ratified copy keeps care and prep timing, loses vague return timing', () => {
    expect(withoutTimedVisitClaims('Mow the lawn the day before your scheduled visit. We will return later in the week. '
      + 'Water the lawn Monday, and we will check the traps at your next visit.', facts.nextVisit))
      .toBe('Mow the lawn the day before your scheduled visit. Water the lawn Monday, and we will check the traps at your next visit.');
  });

  test('an adverb between another subject and its verb still stops the provider carry', () => {
    expect(isVisitClaim('We treated the area and activity gradually subsided but may return tomorrow.')).toBe(false);
  });

  test('with nothing scheduled, a return duration grounds only a promise of OUR return', () => {
    expect(unscheduledProblems('We will be back within 2 weeks.', ['Activity may return within 2 weeks.']))
      .toEqual(['ungrounded_relative_date:within 2 weeks']);
    expect(unscheduledProblems('We will return after 2 hours.', ['You may return indoors after 2 hours.']))
      .toEqual(['ungrounded_relative_date:after 2 hours']);
    expect(unscheduledProblems('We will return in 2 weeks.', ['We will return in 2 weeks to recheck the traps.'])).toEqual([]);
  });

  // Codex round 3 on #5262.
  test.each([
    // a subjectless purpose clause after a return continues the promise
    ['We will return and check the traps Monday.', ['visit_timing_stated:monday'], 'We will return.'],
    // only the timed clause leaves ratified copy; the care stays
    ['Keep the traps dry, and we will return Monday.', ['visit_timing_stated:monday'], 'Keep the traps dry.'],
    ['We will return Monday, and keep pets inside until 2 PM.', ['visit_timing_stated:monday', 'ungrounded_time:2 PM'], 'Keep pets inside until 2 PM.'],
    // a visit named only as the anchor of a customer step claims nothing
    ['Mow Monday before your next visit.', [], 'Mow Monday before your next visit.'],
    ['Keep pets off the lawn until your next visit.', [], 'Keep pets off the lawn until your next visit.'],
  ])('%s', (text, problems, ratified) => {
    expect(problemsFor(text)).toEqual(problems);
    expect(withoutTimedVisitClaims(text, facts.nextVisit)).toBe(ratified);
  });

  test('ratified care anchored on the visit is exempt when copied verbatim, and never visit timing', () => {
    const care = 'Water for 20 minutes at 6 AM before your next visit.';
    expect(isVisitClaim(care)).toBe(true);
    expect(problemsFor(care, [care])).toEqual([]);
    expect(problemsFor(care).some((p) => p.startsWith('visit_timing_stated'))).toBe(false);
    expect(withoutTimedVisitClaims(care, facts.nextVisit)).toBe(care);
  });

  test('a clause with its own noun subject never inherits the provider', () => {
    expect(isVisitClaim('We treated the area and activity subsided but may return tomorrow.')).toBe(false);
    expect(isVisitClaim('We carefully inspected all interior and exterior bait stations throughout the property and will return tomorrow.')).toBe(true);
  });

  test('with a visit scheduled, ratified copy loses every timed visit claim, agreeing or not', () => {
    const block = 'We checked 7 traps today. We will return tomorrow. '
      + 'A follow-up visit in 10–14 days is recommended. We will arrive between 7 and 8. '
      + 'We will check the traps at your next visit. Your next visit is Monday, August 3. '
      + 'Contact us tomorrow if activity returns.';
    expect(withoutTimedVisitClaims(block, facts.nextVisit)).toBe('We checked 7 traps today. '
      + 'We will check the traps at your next visit. Contact us tomorrow if activity returns.');
    expect(withoutTimedVisitClaims(block, null)).toBe(block);
    // outcome timing beside the word "visit" is not visit timing
    expect(withoutTimedVisitClaims('Results should appear within 2 weeks after your visit.', facts.nextVisit))
      .toBe('Results should appear within 2 weeks after your visit.');
    // a sentence about the completed visit is ratified history, never a
    // stale appointment (codex r3 on #5055, L332)
    const october = { date: 'Monday, October 5', window: '8–10 AM' };
    expect(withoutTimedVisitClaims(
      "At today's September 28 visit, we inspected the traps. We will return tomorrow.",
      october,
    )).toBe("At today's September 28 visit, we inspected the traps.");
    expect(withoutTimedVisitClaims('Since our visit on Aug. 1, activity has dropped.', october))
      .toBe('Since our visit on Aug. 1, activity has dropped.');
    // an abbreviation that ends a clause ends the sentence, so only the
    // timed promise leaves (codex r3 on #5055, L154)
    expect(withoutTimedVisitClaims('Keep food sealed and remove clutter, etc. We will return tomorrow.', october))
      .toBe('Keep food sealed and remove clutter, etc.');
  });

  // Sentence boundaries: abbreviations and decimals never end a sentence,
  // so a date or time stays inside its claim (independent review P1, L1349).
  test.each([
    ['Your next visit is Sep. 3.', ['Your next visit is Sep. 3.']],
    ['Your next visit is Monday, Aug. 4.', ['Your next visit is Monday, Aug. 4.']],
    ['Arriving at 8 a.m. Monday.', ['Arriving at 8 a.m. Monday.']],
    ['Your next visit is Monday, Aug. 3, arriving 8–10 a.m. tomorrow.', ['Your next visit is Monday, Aug. 3, arriving 8–10 a.m. tomorrow.']],
    ['Rain is expected Sep. 3, ending at 8 a.m. tomorrow, so keep the traps dry.', ['Rain is expected Sep. 3, ending at 8 a.m. tomorrow, so keep the traps dry.']],
    ['Contact us at 8 a.m. Your next visit is Monday, August 3, arriving 8–10 AM.', ['Contact us at 8 a.m.', 'Your next visit is Monday, August 3, arriving 8–10 AM.']],
    ['Ask for Dr. Lee at the St. Mark office. Keep pets inside.', ['Ask for Dr. Lee at the St. Mark office.', 'Keep pets inside.']],
    ['J. Smith approved the plan. Keep pets inside.', ['J. Smith approved the plan.', 'Keep pets inside.']],
    ['Water 1.5 inches weekly. Keep pets inside.', ['Water 1.5 inches weekly.', 'Keep pets inside.']],
    ['We checked the traps! Keep pets inside? Yes.', ['We checked the traps!', 'Keep pets inside?', 'Yes.']],
    // "etc."-style abbreviations end the sentence before a capitalized word
    // (codex r3 on #5055, L154); a lowercase word or a date still continues
    ['Keep food sealed and remove clutter, etc. We will return tomorrow.', ['Keep food sealed and remove clutter, etc.', 'We will return tomorrow.']],
    ['Bring in pet food, etc. before dusk. Keep pets inside.', ['Bring in pet food, etc. before dusk.', 'Keep pets inside.']],
    ['Seal gaps, vents, etc. Monday works too.', ['Seal gaps, vents, etc. Monday works too.']],
  ])('sentences of %s', (block, expected) => {
    expect(splitSentences(block)).toEqual(expected);
  });

  test('an abbreviated date or time is judged inside its claim', () => {
    expect(withoutTimedVisitClaims('We checked 7 traps today. Your next visit is Sep. 3.', facts.nextVisit))
      .toBe('We checked 7 traps today.');
    expect(withoutTimedVisitClaims('We checked 7 traps today. Your next visit is Monday, Aug. 4.', facts.nextVisit))
      .toBe('We checked 7 traps today.');
    expect(problemsFor('Arriving at 8 a.m. Monday.')).toEqual(['visit_timing_stated:8 a.m.', 'visit_timing_stated:monday']);
    expect(problemsFor('Your next appointment is Sep. 3.', ['Your next visit is Sep. 3.'])).toEqual(['visit_timing_stated:sep. 3']);
  });

  test('an exempt care sentence exempts only its verbatim copy', () => {
    const care = 'Contact us at 8 AM if activity returns.';
    expect(problemsFor(`${care} We will arrive at 8 AM.`, [care])).toEqual(['visit_timing_stated:8 am.']);
    expect(problemsFor('Contact us at 9 AM if activity returns.', [care])).toEqual(['ungrounded_time:9 AM']);
  });
});

test('grounded numerals cannot launder a relative visit date or a prose window', () => {
  // 7 traps grounds the numeral 7, so only the temporal rules can catch
  // these (codex P1 on #5055, L46 + L56).
  const facts = groundingFacts(input());
  expect(ungroundedClaims('Your next visit is in 7 days.', facts)).toContain('visit_timing_stated:in 7 days');
  expect(ungroundedClaims('Your next visit is Monday, August 3, arriving between 7 and 8.', facts))
    .toContain('visit_timing_stated:between 7 and 8');
  // with nothing scheduled the same forms are ungrounded
  const noVisit = groundingFacts(input({ nextAppointment: null }));
  expect(ungroundedClaims('Your next visit is in 7 days.', noVisit)).toContain('ungrounded_relative_date:in 7 days');
  expect(ungroundedClaims('We will arrive from 7 to 8.', noVisit)).toContain('ungrounded_window:FROM 7 TO 8');
});

test('the hidden next-visit numbers never ground a count, and a scheduled visit cannot be denied (codex r2 on #5262)', () => {
  const facts = groundingFacts(input());
  expect(ungroundedClaims('We completed 3 steps today.', facts)).toContain('ungrounded_number:3');
  for (const denial of ['We do not plan to return.', 'We have no plans to return.', 'This was our final visit.', 'No return is planned.']) {
    expect(ungroundedClaims(denial, facts)).toContain('contradicted_scheduled_visit');
  }
  expect(ungroundedClaims('Since your last visit, activity dropped.', facts)).not.toContain('contradicted_scheduled_visit');
  const noVisit = groundingFacts(input({ nextAppointment: null }));
  expect(ungroundedClaims('This was our final visit.', noVisit)).not.toContain('contradicted_scheduled_visit');
});

test('a ratified denial of the scheduled visit never reaches the facts (codex r3 on #5262)', () => {
  const args = input();
  args.typedReport = {
    ...args.typedReport,
    todaysResult: { ...args.typedReport.todaysResult, body: 'We checked 7 traps today. This was our final visit.', nextStep: 'We do not plan to return.' },
  };
  const facts = groundingFacts(args);
  expect(facts.todaysResult.body).toBe('We checked 7 traps today.');
  expect(facts.todaysResult.nextStep).toBeNull();
  expect(deterministicSummary(facts)).not.toMatch(/final visit|plan to return/);
  // with nothing scheduled there is nothing to contradict
  const undated = groundingFacts({ ...args, nextAppointment: null });
  expect(undated.todaysResult.body).toBe('We checked 7 traps today. This was our final visit.');
});

test('the model never sees the next visit date, only that one is scheduled (owner ruling 2026-09-28)', () => {
  const message = buildUserMessage(groundingFacts(input()));
  expect(message).toContain('"nextVisitScheduled": true');
  expect(message).not.toMatch(/August 3|8–10 AM|"nextVisit"/);
  expect(buildUserMessage(groundingFacts(input({ nextAppointment: null })))).toContain('"nextVisitScheduled": false');
  const { SYSTEM_PROMPT } = require('../services/service-report/rodent-report-narrative')._test;
  expect(SYSTEM_PROMPT).toMatch(/Never say when Waves will return/);
  expect(SYSTEM_PROMPT).not.toMatch(/copying the date and arrival window/);
});

test('stale appointment copy in the ratified result never reaches the published summary', async () => {
  // Frozen Today's Result copy that contradicts the dated next visit (codex
  // P1 on #5055, L1350). Before the fix the stale sentence was published
  // either way: the fallback copied the body verbatim, and the care append
  // re-added it after the model's copy had passed the guard.
  const stale = 'We will return tomorrow.';
  const staleStep = 'We will be back Tuesday.';
  const care = 'Contact us tomorrow if activity returns.';
  const args = input();
  args.typedReport = {
    ...args.typedReport,
    todaysResult: {
      ...args.typedReport.todaysResult,
      body: `We checked 7 traps today. ${stale} ${care}`,
      nextStep: staleStep,
    },
  };
  const facts = groundingFacts(args);
  expect(facts.todaysResult.body).toBe(`We checked 7 traps today. ${care}`);
  expect(facts.todaysResult.nextStep).toBeNull();
  const clean = 'Today we completed your rodent trapping visit and inspected all 7 traps, with no captures recorded. '
    + 'We documented droppings in the attic insulation, and today’s moderate activity reading sets the baseline for your program.';
  // the model omits the stale sentence: the care append adds only live care
  const omitted = await applyRodentReportNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: clean } }),
  });
  expect(omitted).toContain(clean);
  expect(omitted).toContain(care);
  expect(omitted).not.toContain(stale);
  expect(omitted).not.toContain(staleStep);
  // the model repeats it: rejected, and the fallback no longer copies it
  _cache.clear();
  const repeated = await applyRodentReportNarrative(args, {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: `${clean} ${stale}` } }),
  });
  expect(repeated).toContain('7 of 7 traps were inspected');
  expect(repeated).not.toContain('August 3');
  expect(repeated).toContain(care);
  expect(repeated).not.toContain(stale);
  expect(repeated).not.toContain(staleStep);
  // with no dated visit there is nothing to contradict: the copy stays
  const undated = groundingFacts({ ...args, nextAppointment: null });
  expect(undated.todaysResult.body).toBe(`We checked 7 traps today. ${stale} ${care}`);
  expect(undated.todaysResult.nextStep).toBe(staleStep);
});

test('banned copy, bad length, and withheld-name echoes fall back deterministically', async () => {
  const fallbackFor = (summary, extra = {}) => applyRodentReportNarrative(input(extra), {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });

  // banned vocabulary (shared list + EXTRA_FORBIDDEN)
  for (const bad of [
    'Great news, the rodents have been eliminated from your property for good, and every trap we checked today confirmed it.',
    'The infestation is under control now that all seven traps have been inspected and reset around your home today.',
  ]) {
    const text = await fallbackFor(bad);
    expect(text).toContain('7 of 7 traps were inspected');
  }

  // too short / too long
  expect(await fallbackFor('Too short.')).toContain('7 of 7 traps were inspected');
  expect(await fallbackFor('x'.repeat(1500))).toContain('7 of 7 traps were inspected');

  // withheld registered-product echo
  const withBait = await applyRodentReportNarrative(input({
    applications: [
      { product: { name: 'Victor Rat Snap Trap', epa_reg: 'N/A', active_ingredient: 'Mechanical snap trap', category: 'Rodent Control' } },
      { product: { name: 'Contrac Blox Rodenticide', epa_reg: '12455-79', category: 'Rodenticide' } },
    ],
  }), {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary: 'We inspected all seven traps around the home today and also refreshed the Contrac bait placements at the exterior stations for continued monitoring this season.' } }),
  });
  expect(withBait).toContain('7 of 7 traps were inspected');
});

test('a model miss or throw falls back deterministically and never throws', async () => {
  const missed = await applyRodentReportNarrative(input(), {
    callModel: jest.fn().mockResolvedValue({ ok: false, reason: 'provider_down' }),
  });
  expect(missed).toContain('7 of 7 traps were inspected');
  const threw = await applyRodentReportNarrative(input(), {
    callModel: jest.fn().mockRejectedValue(new Error('boom')),
  });
  expect(threw).toContain('7 of 7 traps were inspected');
});

// ---------------------------------------------------------------------------
// Trap-SETUP visits (owner 2026-08-02; codex P2 on #3159). The prompt rule
// alone was not a guard: on a mapped setup the station facts still ground the
// checked count and a typed `captures: 0` still grounds negative capture
// wording, so a re-check story cleared every fail-closed check while flatly
// contradicting visitStage.
// ---------------------------------------------------------------------------

function setupInput(overrides = {}) {
  return input({
    typedReport: {
      type: 'rodent_trapping',
      visitSequence: 1,
      values: { trap_visit_type: 'Initial setup' },
      todaysResult: {
        headline: 'Rodent activity was moderate today.',
        body: 'We set 7 traps today. We will return for the scheduled trap check.',
        nextStep: 'We will return for the scheduled trap check.',
      },
      findings: [
        { fieldKey: 'species', customerLabel: 'What we found', customerValueLabel: 'Roof rats', value: 'Roof rat' },
        { fieldKey: 'traps_checked', customerLabel: 'Traps set', customerValueLabel: '7', value: '7' },
        { fieldKey: 'captures', customerLabel: 'Captures', customerValueLabel: '0', value: '0' },
      ],
    },
    ...overrides,
  });
}

test('a declared setup marks the facts and the deterministic summary says SET', () => {
  const facts = groundingFacts(setupInput());
  expect(facts.visitStage).toBe('initial_trap_setup');
  const summary = deterministicSummary(facts);
  expect(summary).toContain('7 of 7 traps were set');
  expect(summary).not.toContain('were inspected');
  // Traps placed today have had no chance to catch anything.
  expect(summary).not.toContain('no captures recorded');
});

test('re-check and empty-check wording is REJECTED on a setup, not merely discouraged', () => {
  const facts = groundingFacts(setupInput());
  const rejected = [
    'We checked 7 traps and found no captures today.',
    'The traps were inspected and reset during the visit.',
    'We reset the traps along the roofline.',
    'No new captures were recorded.',
    'The traps were empty.',
  ];
  for (const text of rejected) {
    expect(ungroundedClaims(text, facts).filter((p) => p.startsWith('setup_')).length)
      .toBeGreaterThan(0);
  }
});

test('legitimate setup prose survives the guard', () => {
  const facts = groundingFacts(setupInput());
  const allowed = [
    'We set 7 traps in the attic and garage today.',
    // "checked" against a NON-trap noun is ordinary inspection prose
    'We checked the roofline for entry points before placing the traps.',
    'We placed the devices along the runways we documented.',
  ];
  for (const text of allowed) {
    expect(ungroundedClaims(text, facts).filter((p) => p.startsWith('setup_'))).toEqual([]);
  }
});

test('the setup guard is inert on a follow-up visit', () => {
  const facts = groundingFacts(input());
  expect(facts.visitStage).toBeNull();
  expect(ungroundedClaims('We checked 7 traps and found no captures today.', facts)
    .filter((p) => p.startsWith('setup_'))).toEqual([]);
});

test('a model that ignores the setup rule falls back to the deterministic setup summary', async () => {
  const out = await applyRodentReportNarrative(setupInput(), {
    callModel: jest.fn().mockResolvedValue({
      ok: true,
      json: { summary: 'We checked 7 traps around the home today and found no captures at any of them, so we will keep monitoring the property between visits this season.' },
    }),
  });
  expect(out).toContain('7 of 7 traps were set');
  expect(out).not.toContain('checked 7 traps');
});

// codex P2 round 2 on #3159: the first setup guard's re-verb alternation
// included a bare `set` behind an optional `re-?`, so it flagged "set the
// traps" — the exact wording the prompt asks for — and bounced compliant
// output to the deterministic fallback.
test('plain setup wording is not mistaken for a re-check', () => {
  const facts = groundingFacts(setupInput());
  for (const text of [
    'We set the traps around the attic today.',
    'We set the devices along the runways we documented.',
  ]) {
    expect(ungroundedClaims(text, facts).filter((p) => p.startsWith('setup_'))).toEqual([]);
  }
  // …while the re- forms it exists to catch still reject.
  for (const text of [
    'We reset the traps along the roofline.',
    'We re-set the traps.',
    'We rebaited all 7 traps.',
    'Seven traps have been checked today.',
    'The traps were reset.',
    'We repositioned the traps near the plenum.',
  ]) {
    expect(ungroundedClaims(text, facts).filter((p) => p.startsWith('setup_')).length)
      .toBeGreaterThan(0);
  }
});

test('a compliant setup narrative survives end to end', async () => {
  // Deliberately stays inside every OTHER guard too (no invented locations,
  // no capture claim — "what they catch" reads as one to the capture guard),
  // so a failure here means the SETUP guard fired, not a neighbour.
  const summary = 'We set 7 traps today to begin tracking the roof rat activity documented at '
    + 'the property. Activity is moderate, and this visit sets the baseline future visits will '
    + 'measure against. We return to adjust placements as needed.';
  const out = await applyRodentReportNarrative(setupInput(), {
    callModel: jest.fn().mockResolvedValue({ ok: true, json: { summary } }),
  });
  // The module appends the ratified next-step sentence to accepted output,
  // so the model's text is CONTAINED rather than returned verbatim.
  expect(out).toContain(summary);
  // i.e. it did NOT bounce to the deterministic fallback
  expect(out).not.toContain('7 of 7 traps were set');
});

// Round 10: when rodent_trapping is a COMPANION to a non-trapping primary,
// `typedReport` is the primary — so deriving the stage from it alone returned
// null and neither the prompt rule nor the setup guards engaged, even though
// the companion-selected trap map was on the page. report-data now resolves
// the stage across primary + companions and passes it explicitly.
test('an explicitly passed visitStage engages the setup lane on a companion trapping visit', () => {
  // A one-time pest PRIMARY: on its own this resolves to no stage at all.
  const primaryOnly = input({
    typedReport: {
      type: 'one_time_pest',
      visitSequence: 1,
      values: { target_pest: 'Ants' },
      findings: [],
    },
  });
  expect(groundingFacts(primaryOnly).visitStage).toBeNull();

  // Same primary, with the caller supplying the companion's declared stage.
  const facts = groundingFacts({ ...primaryOnly, visitStage: 'initial_trap_setup' });
  expect(facts.visitStage).toBe('initial_trap_setup');
  // …and the setup guards are live, so re-check copy is refused.
  expect(ungroundedClaims('We checked the traps and found no captures today.', facts)
    .filter((p) => p.startsWith('setup_')).length).toBeGreaterThan(0);
});

test('an explicit stage never overrides a snapshot that declares one itself', () => {
  // Passing nothing leaves the existing derivation untouched.
  const derived = groundingFacts(setupInput());
  expect(derived.visitStage).toBe('initial_trap_setup');
  // A follow-up snapshot with no explicit stage stays a follow-up.
  expect(groundingFacts({ ...input(), visitStage: null }).visitStage).toBeNull();
});

// Round 12: the map suppresses its own count line when the tech's typed trap
// count disputes the pinned roster (setupCountVerified false on the map
// context), but the narrative only received stationSummary — so its fallback
// printed "N of N traps were set" anyway, and the grounded number set
// licensed the model to echo the same disputed number.
describe('disputed setup counts stay out of the narrative (round 12)', () => {
  test('stationCountDisputed strips roster numbers from the facts', () => {
    const facts = groundingFacts({ ...setupInput(), stationCountDisputed: true });
    expect(facts.stations.countDisputed).toBe(true);
    expect(facts.stations.total).toBeUndefined();
    expect(facts.stations.checked).toBeUndefined();
    expect(facts.stations.serviced).toBeUndefined();
    expect(facts.stations.inaccessible).toBeUndefined();
    // Round 13 overturned the round-12 carve-out: the capture-pin count is
    // pin-derived too — the pins ARE the disputed roster — so it goes with
    // the rest ("a capture was recorded at 7 traps" beside "Traps set: 6").
    expect(facts.stations.trapsWithCaptureRecorded).toBeUndefined();
  });

  test('the capture-pin count is suppressed with the rest (round 13)', () => {
    // 8 pins, 7 of them capture-flagged, typed count 6 — every one of those
    // pin numbers is off-limits once the roster is disputed.
    const facts = groundingFacts({
      ...setupInput(),
      stationSummary: { total: 8, checked: 8, activity: 7, serviced: 0, inaccessible: 0 },
      stationCountDisputed: true,
    });
    expect(facts.stations.trapsWithCaptureRecorded).toBeUndefined();
    const summary = deterministicSummary(facts);
    expect(summary).not.toContain('capture was recorded at');
    expect(ungroundedClaims('A capture was recorded at 7 traps.', facts).length)
      .toBeGreaterThan(0);
  });

  test('the deterministic summary names the stage without restating a number', () => {
    const summary = deterministicSummary(groundingFacts({ ...setupInput(), stationCountDisputed: true }));
    expect(summary).toContain('Traps were set on this visit');
    expect(summary).not.toMatch(/\d+ of \d+/);
  });

  test('a model echo of the disputed map count is ungrounded', () => {
    // The real failure shape: 8 pins on the map, typed count 7 — disputed.
    // Without the strip, total: 8 sits in the facts and licenses "8 of 8".
    const facts = groundingFacts({
      ...setupInput(),
      stationSummary: { total: 8, checked: 8, activity: 0, serviced: 0, inaccessible: 0 },
      stationCountDisputed: true,
    });
    expect(ungroundedClaims('8 of 8 traps were set today.', facts).length).toBeGreaterThan(0);
  });

  test('an undisputed setup still prints the verified count', () => {
    const summary = deterministicSummary(groundingFacts(setupInput()));
    expect(summary).toContain('7 of 7 traps were set');
  });
});

// Round 19 (codex P2): a declared setup can land on ANY visit —
// isInitialRodentTrapSetup deliberately ignores visitSequence — but the
// prompt told the model it was the FIRST visit of the program, licensing
// an ordinal claim no grounding validator can reject when the setup
// follows earlier rodent visits. The rule now says only that the traps
// were placed today, and explicitly forbids ranking the visit.
describe('setup prompt rule asserts no visit ordinal (round 19)', () => {
  const { SYSTEM_PROMPT } = require('../services/service-report/rodent-report-narrative')._test;

  test('the initial_trap_setup rule no longer claims the first program visit', () => {
    expect(SYSTEM_PROMPT).not.toMatch(/FIRST visit of the trapping program/i);
    expect(SYSTEM_PROMPT).toMatch(/never state or imply that this is the first visit/i);
  });
});
