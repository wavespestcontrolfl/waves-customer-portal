const {
  generateReportCopyWithFallback,
  buildDeterministicReportCopy,
  reportCopyRejection,
} = require('../routes/admin-schedule')._test;

describe('generate-report output guard (reportCopyRejection)', () => {
  test('accepts clean, non-empty report copy', () => {
    expect(reportCopyRejection(
      'We treated the perimeter and baited the active ant trail at the front entry.',
    )).toBeNull();
  });

  // Legitimate completed-work descriptions (sweeping cobwebs, removing debris)
  // must pass — they describe work performed, not an overpromise. The prompt
  // examples are kept in alignment with the validator so generation does not
  // self-reject on its own modeled copy and return a needless 502.
  test('accepts completed-work copy that mirrors the prompt examples', () => {
    expect(reportCopyRejection(
      'Cobwebs were swept from eaves and overhangs to reduce activity along the foundation line.',
    )).toBeNull();
    expect(reportCopyRejection(
      'Debris was removed from the bait stations during inspection.',
    )).toBeNull();
  });

  test('rejects empty / whitespace-only / nullish copy as "empty"', () => {
    expect(reportCopyRejection('')).toBe('empty');
    expect(reportCopyRejection('   \n  ')).toBe('empty');
    expect(reportCopyRejection(null)).toBe('empty');
    expect(reportCopyRejection(undefined)).toBe('empty');
  });

  test('rejects liability copy (guaranteed / eliminated) with a banned reason', () => {
    expect(reportCopyRejection('Your home is now guaranteed pest-free.')).toMatch(/^banned:/);
    expect(reportCopyRejection('We eliminated all pests on the property.')).toMatch(/^banned:/);
  });
});

describe('generate-report provider fallback', () => {
  const cleanReport = 'WHAT WE DID\n\nWe treated the exterior entry points.\n\nWHAT WE FOUND\n\nActivity was low.';
  const provider = (name, responses) => ({
    name,
    model: `${name}-model`,
    call: jest.fn().mockImplementation(() => Promise.resolve(responses.shift())),
  });

  test('returns the OpenAI result without calling Anthropic when primary succeeds', async () => {
    const openai = provider('openai', [{ ok: true, text: cleanReport }]);
    const anthropic = provider('anthropic', [{ ok: true, text: cleanReport }]);

    const result = await generateReportCopyWithFallback({
      systemPrompt: 'system', userMessage: 'visit', providers: [openai, anthropic],
    });

    expect(result).toMatchObject({ ok: true, provider: 'openai', report: cleanReport, failures: [] });
    expect(openai.call).toHaveBeenCalledWith(expect.objectContaining({ jsonMode: false, maxTokens: 800 }));
    expect(anthropic.call).not.toHaveBeenCalled();
  });

  test('falls back to Anthropic when OpenAI is overloaded', async () => {
    const openai = provider('openai', [{ ok: false, reason: 'openai_529' }]);
    const anthropic = provider('anthropic', [{ ok: true, text: cleanReport }]);

    const result = await generateReportCopyWithFallback({
      systemPrompt: 'system', userMessage: 'visit', providers: [openai, anthropic],
    });

    expect(result).toMatchObject({
      ok: true,
      provider: 'anthropic',
      failures: [{ provider: 'openai', reason: 'openai_529' }],
    });
    expect(anthropic.call).toHaveBeenCalledTimes(1);
  });

  // Codex round 8: this bespoke chain previously carried NO timeout — a
  // stalled primary sat on callOpenAI's 10-minute default and the admin
  // request died before the backup provider ever ran. Every call now
  // carries a bounded shared budget (≤60s per call within a 120s chain).
  test('every chain call carries a bounded shared timeout budget', async () => {
    const openai = provider('openai', [{ ok: false, reason: 'openai_529' }]);
    const anthropic = provider('anthropic', [{ ok: true, text: cleanReport }]);

    await generateReportCopyWithFallback({
      systemPrompt: 'system', userMessage: 'visit', providers: [openai, anthropic],
    });

    for (const fn of [openai.call, anthropic.call]) {
      const { timeoutMs } = fn.mock.calls[0][0];
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(60000);
    }
  });

  test('retries rejected copy, then uses the backup provider', async () => {
    const unsafe = { ok: true, text: 'Your home is guaranteed pest-free.' };
    const openai = provider('openai', [unsafe, unsafe]);
    const anthropic = provider('anthropic', [{ ok: true, text: cleanReport }]);

    const result = await generateReportCopyWithFallback({
      systemPrompt: 'system', userMessage: 'visit', providers: [openai, anthropic],
    });

    expect(result).toMatchObject({ ok: true, provider: 'anthropic' });
    expect(openai.call).toHaveBeenCalledTimes(2);
    expect(anthropic.call).toHaveBeenCalledTimes(1);
  });

  test('fails cleanly only after both providers are unavailable', async () => {
    const anthropic = provider('anthropic', [{ ok: false, reason: 'anthropic_529' }]);
    const openai = provider('openai', [{ ok: false, reason: 'openai_503' }]);

    const result = await generateReportCopyWithFallback({
      systemPrompt: 'system', userMessage: 'visit', providers: [anthropic, openai],
    });

    expect(result).toEqual({
      ok: false,
      reason: 'all_providers_failed',
      rejection: null,
      failures: [
        { provider: 'anthropic', reason: 'anthropic_529' },
        { provider: 'openai', reason: 'openai_503' },
      ],
    });
  });
});

describe('deterministic report fallback', () => {
  test('produces both required sections from structured inputs only', () => {
    const report = buildDeterministicReportCopy({
      serviceType: 'General Pest Control',
      areas: ['Exterior'],
      actions: ['Treated entry points'],
      observations: ['Light ant activity'],
      recommendations: ['Monitor the kitchen'],
      ratingLabel: 'low',
    });
    expect(report).toContain('WHAT WE DID');
    expect(report).toContain('WHAT WE FOUND');
    expect(report).toContain('Recorded pest activity was low.');
    expect(reportCopyRejection(report)).toBeNull();
  });

  test('does not echo an unsafe request service type', () => {
    const report = buildDeterministicReportCopy({
      serviceType: 'Guaranteed pest-free service',
      areas: ['Exterior'],
    });
    expect(report).toContain('scheduled service');
    expect(report).not.toMatch(/guaranteed|pest-free/i);
    expect(reportCopyRejection(report)).toBeNull();
  });

  test('returns no fallback when only unstructured notes could be preserved', () => {
    expect(buildDeterministicReportCopy({ serviceType: 'General Pest Control' })).toBeNull();
  });
});

describe('generate-report typed findings prompt block (buildTypedFindingsPromptBlock)', () => {
  const {
    buildTypedFindingsPromptBlock,
    typedFindingsPromptSections,
    typedActivityLine,
    customerFacingCompanionTypes,
  } = require('../routes/admin-schedule')._test;

  test('work fields classify as completed work; product fields as application record', () => {
    const block = buildTypedFindingsPromptBlock({
      findingsType: 'termite_treatment',
      values: { treatment_method: 'Spot treatment', products_used: 'Termidor HE', areas_treated: 'Garage slab' },
      nextStepChips: [],
      companionFindings: [],
      allowedCompanionTypes: [],
    });
    expect(block).toContain('Work recorded (completed work):');
    expect(block).toMatch(/Work recorded \(completed work\):[^]*Treatment method: Spot treatment/);
    expect(block).toMatch(/Work recorded \(completed work\):[^]*Areas treated: Garage slab/);
    // product fields live in the context-only application record, never the
    // observed/work groups
    expect(block).toContain('Product application record (context only');
    expect(block).toMatch(/Product application record[^]*Termidor HE/);
    expect(block).toContain('[COMPLETED WORK]');
  });

  test('fallback sections drop product fields and split work from observations', () => {
    const sections = typedFindingsPromptSections('termite_treatment', {
      treatment_method: 'Trenching',
      products_used: 'Termidor HE',
      target_termite: 'Subterranean termites',
    });
    expect(sections.work.join(' ')).toContain('Trenching');
    expect(sections.observations.join(' ')).toContain('Subterranean termites');
    expect(sections.products.join(' ')).toContain('Termidor HE');
    expect(sections.work.join(' ')).not.toContain('Termidor');
    expect(sections.observations.join(' ')).not.toContain('Termidor');
  });

  test('typed activity scores carry the indicator label, never generic pest wording', () => {
    expect(typedActivityLine('rodent_bait_station', 4)).toBe('Bait Station Activity: 4/5 (high)');
    // fallback copy is customer-facing verbatim — words only, or the output
    // guard rejects the whole deterministic report as numeric_rating
    expect(typedActivityLine('rodent_bait_station', 4, { words: true })).toBe('Bait Station Activity: high');
    expect(reportCopyRejection(`x ${typedActivityLine('rodent_bait_station', 4, { words: true })}`)).toBeNull();
    expect(typedActivityLine('termite_bait_station', 0)).toBe('Termite Activity: 0/5 (none)');
    expect(typedActivityLine('rodent_bait_station', 7)).toBeNull();
    expect(typedActivityLine('rodent_bait_station', null)).toBeNull();
    const block = buildTypedFindingsPromptBlock({
      findingsType: 'rodent_bait_station',
      values: { stations_checked: '6' },
      nextStepChips: [],
      companionFindings: [],
      allowedCompanionTypes: [],
      activityScore: 4,
    });
    expect(block).toContain('Bait Station Activity: 4/5 (high)');
    expect(block).not.toContain('Pest activity');
  });

  test('recommendation/prep/follow-up fields classify as future advice, never findings', () => {
    const sections = typedFindingsPromptSections('termite_inspection', {
      treatment_recommendation: 'Recommend liquid perimeter treatment',
    });
    expect(sections.advice.join(' ')).toContain('Recommend liquid perimeter treatment');
    expect(sections.observations.join(' ')).not.toContain('Recommend');
    expect(sections.work.join(' ')).not.toContain('Recommend');
    const block = buildTypedFindingsPromptBlock({
      findingsType: 'termite_inspection',
      values: { treatment_recommendation: 'Recommend liquid perimeter treatment' },
      nextStepChips: [],
      companionFindings: [],
      allowedCompanionTypes: [],
    });
    expect(block).toContain('Recommendations recorded (future advice');
    expect(block).not.toMatch(/Findings observed:[^]*Recommend liquid/);
  });

  test('completed-action suffixes classify as work (r4: _replaced/_placed/_applied/_cleaned)', () => {
    const rodent = typedFindingsPromptSections('rodent_bait_station', { bait_replaced: 'Yes' });
    expect(rodent.work.length).toBe(1);
    expect(rodent.observations.length).toBe(0);
    const roach = typedFindingsPromptSections('german_roach_knockdown', { monitors_placed: '4' });
    expect(roach.work.join(' ')).toContain('4');
    const ts = typedFindingsPromptSections('tree_shrub', { pre_emergent_applied: 'Yes' }, { companion: true });
    expect(ts.work.length).toBe(1);
  });

  test('typed free-text values are access-code redacted before the prompt', () => {
    const sections = typedFindingsPromptSections('termite_treatment', {
      areas_treated: 'Rear beds, gate code 4321, garage slab',
    });
    const all = [...sections.work, ...sections.observations].join(' ');
    expect(all).not.toContain('4321');
    expect(all).toContain('[redacted]');
  });

  test('reportCopyRejection rejects copy carrying an access code', () => {
    expect(reportCopyRejection('We treated the perimeter. The rear gate code 1234 was used for entry.')).toBe('access_code');
    expect(reportCopyRejection('We treated the perimeter and closed the rear gate after service.')).toBeNull();
  });

  test('product-record raw values ride productValues for the trade-name output guard', () => {
    const sections = typedFindingsPromptSections('termite_treatment', {
      products_used: 'Termidor HE',
      treatment_method: 'Trenching',
    });
    expect(sections.productValues).toEqual(['Termidor HE']);
  });

  test('only auto_send companions are customer-facing; internal_only stay staff-only', () => {
    expect(customerFacingCompanionTypes([
      { type: 'tree_shrub', delivery: 'auto_send' },
      { type: 'cockroach', delivery: 'internal_only' },
      { type: 'flea' },
    ])).toEqual(['tree_shrub', 'flea']);
    expect(customerFacingCompanionTypes(null)).toEqual([]);
  });

  test('renders labeled lines, valid chips, and the provenance framing', () => {
    const block = buildTypedFindingsPromptBlock({
      findingsType: 'termite_bait_station',
      values: { total_stations: '12', stations_checked: '11', stations_with_activity: '1' },
      nextStepChips: ['Continue scheduled monitoring'],
      companionFindings: [],
    });
    expect(block).toContain('STRUCTURED SERVICE FINDINGS (Termite Bait Station Inspection form');
    expect(block).toContain('[OBSERVED BY TECHNICIAN]');
    expect(block).toContain('[FUTURE ADVICE — not completed work]');
    expect(block).toMatch(/Total stations.*12/i);
    expect(block).toContain('Next steps selected: Continue scheduled monitoring');
  });

  test('drops empty values, invalid chips, and internal fields', () => {
    const block = buildTypedFindingsPromptBlock({
      findingsType: 'rodent_trapping',
      // trap_visit_type is `internal` — tech-facing data that must never
      // reach a customer-facing prompt (the retired recap draft enforced the same rule)
      values: { trap_visit_type: 'setup', traps_checked: '4', traps_set: '' },
      nextStepChips: ['Not a real chip for this type'],
      companionFindings: [],
    });
    expect(block).not.toContain('setup');
    expect(block).not.toContain('trap_visit_type');
    expect(block).toContain('Next steps selected: None');
    expect(block).toMatch(/4/);
  });

  test('renders bounded companion sections and returns empty when nothing survives', () => {
    const withCompanion = buildTypedFindingsPromptBlock({
      findingsType: 'termite_bait_station',
      values: { total_stations: '8' },
      nextStepChips: [],
      companionFindings: [
        { type: 'cockroach', values: { species: 'German cockroach' } },
        { type: 'not_a_type', values: { species: 'ignored' } },
        // a real type NOT declared on the profile must not render either
        { type: 'flea', values: { flea_activity: 'heavy' } },
      ],
      allowedCompanionTypes: ['cockroach'],
    });
    expect(withCompanion).toContain('Companion findings (');
    expect(withCompanion).toContain('German cockroach');
    expect(withCompanion).not.toContain('ignored');
    expect(withCompanion).not.toContain('heavy');

    expect(buildTypedFindingsPromptBlock({
      findingsType: 'termite_bait_station',
      values: { total_stations: '' },
      nextStepChips: ['bogus'],
      companionFindings: [],
      allowedCompanionTypes: [],
    })).toBe('');
  });

  test('companion-only profiles (findingsType null) still render companion facts, chips, and score', () => {
    const block = buildTypedFindingsPromptBlock({
      findingsType: null,
      values: null,
      nextStepChips: [],
      companionFindings: [{
        type: 'tree_shrub',
        // observed_conditions is companionOnly — the companion schema
        // variant must serve it (primary slice filters it out)
        values: { observed_conditions: 'Yellowing / chlorosis, Leaf spot' },
        nextStepChips: ['Continue Tree & Shrub program'],
        activityScore: 2,
      }],
      allowedCompanionTypes: ['tree_shrub'],
    });
    expect(block).toContain('STRUCTURED SERVICE FINDINGS');
    expect(block).toContain('Yellowing / chlorosis');
    expect(block).toContain('Leaf spot');
    expect(block).toContain(': 2/5 (low)');
    expect(block).toContain('Next steps selected (future advice): Continue Tree & Shrub program');
  });

  test('comma-joined chips/multi_select values map each option through the customer label registry', () => {
    const block = buildTypedFindingsPromptBlock({
      findingsType: 'palm_injection',
      values: { deficiency_signs: 'None observed today, Iron chlorosis' },
      nextStepChips: [],
      companionFindings: [],
      allowedCompanionTypes: [],
    });
    // 'None observed today' has deliberately scoped customer wording — the
    // per-option mapping must apply, not the raw joined technician string
    expect(block).toContain("No nutrient deficiency signs were observed at today's service");
    expect(block).toContain('Iron chlorosis');
    expect(block).not.toContain('None observed today,');
  });
});
