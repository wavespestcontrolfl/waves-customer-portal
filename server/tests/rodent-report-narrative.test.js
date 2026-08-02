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
  // every numeral in clean copy is grounded (7 traps, Aug 3, 8–10 window)
  expect(ungroundedClaims('We inspected all 7 traps. Next visit Monday, August 3, arriving 8–10 AM.', facts)).toEqual([]);
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

  // standalone clock times validate against the window boundaries (codex
  // round-8 P1): a reformatted single time keeps the meridiem honest
  expect(ungroundedClaims('Your next visit is Monday, August 3 at 8 PM.', facts))
    .toContain('ungrounded_time:8 PM');
  expect(ungroundedClaims('We arrive Monday, August 3 starting at 8 AM.', facts)).toEqual([]);

  // standalone weekday mentions validate against the grounded visit (codex
  // round-6 P1): no month-day needed for "Tuesday" to contradict a Monday
  expect(ungroundedClaims('Your next visit is Tuesday.', facts).some((p) => p.startsWith('ungrounded_weekday'))).toBe(true);
  expect(ungroundedClaims('We will see you Monday for the next check.', facts)).toEqual([]);

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

  // the next visit is validated as TEXT, not just numerals (codex round-4
  // P1): a flipped meridiem or wrong weekday/month rejects
  expect(ungroundedClaims('Your next visit is Monday, August 3, arriving 8–10 PM.', facts))
    .toContain('ungrounded_window:8–10 PM');
  expect(ungroundedClaims('Your next visit is Tuesday, August 3, arriving 8–10 AM.', facts))
    .toContain('ungrounded_date:Tuesday, August 3');
  expect(ungroundedClaims('See you on September 3.', facts)).toContain('ungrounded_date:September 3');
  // with no grounded next visit, any window/date mention rejects
  const noVisit = groundingFacts(input({ nextAppointment: null }));
  expect(ungroundedClaims('We will arrive 8–10 AM.', noVisit).some((p) => p.startsWith('ungrounded_window'))).toBe(true);
});

test('withheld product identity partitions the narrative cache', async () => {
  const clean = 'Today we completed your rodent trapping visit and inspected all 7 traps, with no captures recorded. We documented droppings in the attic insulation, and today’s moderate activity reading sets the baseline for your program. Your next visit is Monday, August 3, arriving 8–10 AM.';
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

test('deterministic summary = ratified copy + factual counts + next visit', () => {
  const text = deterministicSummary(groundingFacts(input()));
  expect(text).toContain('Rodent activity was moderate today.');
  expect(text).toContain('We checked 7 traps today.');
  // the zero-captures claim is grounded in the typed Captures finding
  expect(text).toContain('7 of 7 traps were inspected, with no captures recorded.');
  expect(text).toContain('Photos from this visit are included with this report.');
  expect(text).toContain('Your next visit is scheduled for Monday, August 3, arriving 8–10 AM.');

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
    json: { summary: 'Today we completed your rodent trapping visit and inspected all 7 traps, with no captures recorded. We documented droppings in the attic insulation, and today’s moderate activity reading sets the baseline for your program. Your next visit is Monday, August 3, arriving 8–10 AM.' },
  });
  const one = input();
  const first = await applyRodentReportNarrative(one, { callModel });
  expect(first).toContain('sets the baseline');
  const again = await applyRodentReportNarrative(one, { callModel });
  expect(again).toBe(first);
  expect(callModel).toHaveBeenCalledTimes(1);
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
