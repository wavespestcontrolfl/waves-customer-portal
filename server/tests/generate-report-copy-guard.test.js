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
  const { buildTypedFindingsPromptBlock } = require('../routes/admin-schedule')._test;

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
      // reach a customer-facing prompt (same rule as buildFindingsRecapPrompt)
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
      ],
    });
    expect(withCompanion).toContain('Companion findings (');
    expect(withCompanion).toContain('German cockroach');
    expect(withCompanion).not.toContain('ignored');

    expect(buildTypedFindingsPromptBlock({
      findingsType: 'termite_bait_station',
      values: { total_stations: '' },
      nextStepChips: ['bogus'],
      companionFindings: [],
    })).toBe('');
  });
});
