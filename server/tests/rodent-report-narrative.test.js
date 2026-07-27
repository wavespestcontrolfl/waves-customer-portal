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
  ]);
  expect(facts.activity).toMatchObject({ levelWord: 'Moderate activity', score: 3, isBaseline: true });
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
});

test('ungrounded numbers and unsupported capture/consumption claims are rejected', () => {
  const facts = groundingFacts(input());
  // every numeral in clean copy is grounded (7 traps, activity 3/5, Aug 3, 8–10 window)
  expect(ungroundedClaims('We inspected all 7 traps; activity was 3 out of 5. Next visit Monday, August 3, arriving 8–10 AM.', facts)).toEqual([]);
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
  expect(ungroundedClaims('One of the traps was relocated to the attic entry.', facts)).toEqual([]);
});

test('deterministic summary = ratified copy + factual counts + next visit', () => {
  const text = deterministicSummary(groundingFacts(input()));
  expect(text).toContain('Rodent activity was moderate today.');
  expect(text).toContain('We checked 7 traps today.');
  expect(text).toContain('7 of 7 traps were inspected, with no captures recorded.');
  expect(text).toContain('Photos from this visit are included with this report.');
  expect(text).toContain('Your next visit is scheduled for Monday, August 3, arriving 8–10 AM.');

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
