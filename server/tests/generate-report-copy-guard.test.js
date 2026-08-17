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

describe('global delivery kill switch and generation authorization (r74)', () => {
  test('SPECIALTY_REPORT_DELIVERY_DISABLED empties customer-facing companion types', () => {
    const { customerFacingCompanionTypes } = require('../routes/admin-schedule')._test;
    const companions = [{ type: 'termite_bait_station', delivery: 'auto_send' }];
    expect(customerFacingCompanionTypes(companions)).toEqual(['termite_bait_station']);
    process.env.SPECIALTY_REPORT_DELIVERY_DISABLED = 'true';
    try {
      expect(customerFacingCompanionTypes(companions)).toEqual([]);
    } finally {
      delete process.env.SPECIALTY_REPORT_DELIVERY_DISABLED;
    }
  });
});

describe('deterministic fallback parser approval (r16)', () => {
  test('echoed typed free text with parser-only terms degrades to the generic template', () => {
    const report = buildDeterministicReportCopy({
      serviceType: 'Termite Inspection Service',
      areas: [], actions: [],
      observations: ['Infestation extent: localized infestation at the garage sill'],
      recommendations: [], ratingLabel: null,
    });
    // parser-only 'infestation' nulls the body — the fallback must degrade
    // to the generic template rather than hand back undeliverable copy
    expect(report).toContain('We completed the scheduled service');
    expect(report).not.toContain('Infestation extent');
  });
});

describe('generate-report output shape gate (r14)', () => {
  test('prose missing the parser shape is rejected so it retries instead of silently falling back at completion', async () => {
    const provider = (name, responses) => ({
      name, model: `${name}-model`,
      call: jest.fn().mockImplementation(() => Promise.resolve(responses.shift())),
    });
    const goodShape = 'WHAT WE DID\n\nWe serviced the bait stations.\n\nWHAT WE FOUND\n\nActivity was light.';
    const badShape = 'We serviced the stations and found light activity.'; // no headers
    const openai = provider('openai', [{ ok: true, text: badShape }, { ok: true, text: goodShape }]);
    const anthropic = provider('anthropic', []);
    const result = await generateReportCopyWithFallback({
      systemPrompt: 's', userMessage: 'u', providers: [openai, anthropic],
    });
    expect(result.ok).toBe(true);
    expect(result.report).toBe(goodShape);
    expect(openai.call).toHaveBeenCalledTimes(2);
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
    // target_termite is completed-work context since r14 (what the
    // treatment targets, not a sighting)
    expect(sections.work.join(' ')).toContain('Subterranean termites');
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
    // measurements beside location words are NOT credentials (codex r30)
    expect(reportCopyRejection('We treated 120 linear feet around the garage and rear entry areas.')).toBeNull();
    expect(reportCopyRejection('The keypad 4521 was used for access.')).toBe('access_code');
    // alphabetic / quoted credentials after a code noun reject too (r34)
    expect(reportCopyRejection('We entered using the gate code BLUE and treated the perimeter.')).toBe('access_code');
    expect(reportCopyRejection('The keypad code is "sunset7" for the side door.')).toBe('access_code');
    expect(reportCopyRejection('The billing code was updated in our office records.')).toBeNull();
    // the APPROVED safe-once-dry idiom parses; unconditional "safe" still
    // rejects (r65)
    const { technicianReportCustomerCopy: parseCopy } = require('../services/service-report/technician-report-copy');
    const idiom = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treated area is safe once dry and your technician confirms timing.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(idiom.body).toBeTruthy();
    // a bare "safe once dry" WITHOUT the timing-confirmation clause still
    // rejects (r66)
    const bare = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treated area is safe once dry.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(bare.body).toBeNull();
    // negative contractions + hyphenated quoted credentials (r68)
    const contraction = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treated area is safe once dry and the technician isn’t confirming timing.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(contraction.body).toBeNull();
    expect(reportCopyRejection('The gate code is "blue-waves" for the side entry.')).toBe('access_code');
    // negated confirmation never unlocks the exemption (r67)
    const negated = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treated area is safe once dry and the technician did not confirm timing.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(negated.body).toBeNull();
    // allow-pets timing, long continuing-state passwords (r81)
    expect(reportCopyRejection('Wait thirty minutes before allowing pets onto the treated lawn.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate password remains sunshineflorida.')).toBe('access_code');
    expect(reportCopyRejection('The password remains confidential per policy.')).toBeNull();
    // indoor-wait timing forms + non-treatment timing confirmations (r80)
    expect(reportCopyRejection('Keep pets indoors for thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Keep pets inside for 30 minutes.')).toMatch(/^banned:/);
    const apptTiming = parseCopy('WHAT WE DID\n\nWe treated the lawn; the technician confirmed the appointment timing and the treated area is safe once dry.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(apptTiming.body).toBeNull();
    // pet-safe compounds never unlock the standalone-safe exemption (r79)
    const petSafe = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treatment is pet-safe once dry and your technician confirms timing.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(petSafe.body).toBeNull();
    // pending-obligation forms never unlock the exemption either (r73)
    const stillNeeds = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treated area is safe once dry; the technician still needs to confirm timing.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(stillNeeds.body).toBeNull();
    const yetTo = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treated area is safe once dry and the technician has yet to confirm timing.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(yetTo.body).toBeNull();
    const waitingTo = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treated area is safe once dry; the technician is waiting to confirm timing.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(waitingTo.body).toBeNull();
    const willConfirm = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treated area is safe once dry and the technician will confirm timing.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(willConfirm.body).toBeNull();
    // failure/inability predicates are negations too (r71)
    const failed = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treated area is safe once dry; the technician failed to confirm timing.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(failed.body).toBeNull();
    const unableTo = parseCopy('WHAT WE DID\n\nWe treated the lawn; the treated area is safe once dry and the technician was unable to confirm timing.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(unableTo.body).toBeNull();
    // perfect-continuous credential linkers (r66)
    expect(reportCopyRejection('The gate code has continued to be BLUE.')).toBe('access_code');
    const unconditional = parseCopy('WHAT WE DID\n\nWe treated the lawn and it is now safe for pets.\n\nWHAT WE FOUND\n\nActivity was light along the fence line.');
    expect(unconditional.body).toBeNull();
    // the shared parser screens post-generation inline edits too (r36)
    const { technicianReportCustomerCopy } = require('../services/service-report/technician-report-copy');
    const edited = technicianReportCustomerCopy('WHAT WE DID\n\nWe treated the home. Use gate code 4545 next time.\n\nWHAT WE FOUND\n\nActivity was low.');
    expect(edited.body).toBeNull();
    expect(edited.violations).toContain('access_code');
    // multiword quoted credentials reject too (r48)
    expect(reportCopyRejection('The gate code “blue waves” opens the side entry.')).toBe('access_code');
    expect(reportCopyRejection("Use passphrase 'open sesame' at the door.")).toBe('access_code');
    // alphabetic credentials beside a device noun — the reverse and
    // positional shapes cover keypad/lockbox too (r46)
    expect(reportCopyRejection('Use BLUE at the keypad to enter the side yard.')).toBe('access_code');
    expect(reportCopyRejection('WAVES is the lockbox for the garage entry.')).toBe('access_code');
    expect(reportCopyRejection('We entered at the keypad and treated the lanai.')).toBeNull();
    // ... and the positional window covers ordinary code nouns (r47)
    expect(reportCopyRejection('Use BLUE for the gate code when you arrive.')).toBe('access_code');
    expect(reportCopyRejection('Use BLUE for the password.')).toBe('access_code');
  });

  test('compliance-language classes reject on the shared gate (r47)', () => {
    expect(reportCopyRejection('We used an EPA-approved treatment; the area will be dry in 30 minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Treated areas are typically dry within 45 minutes of application.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Please wait 2 hours before re-entry to treated rooms.')).toMatch(/^banned:/);
    // spelled-out figures state the same fixed timing (r48)
    expect(reportCopyRejection('The area should dry in thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Re-enter after two hours to be sure.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Everything should be dry in about half an hour.')).toMatch(/^banned:/);
    // dog/cat re-entry, awarded EPA approval, long alphabetic passwords (r78)
    expect(reportCopyRejection('Let your dog outside after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The cats can go outside in 2 hours.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The EPA awarded approval to this treatment.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate password is sunshineflorida.')).toBe('access_code');
    expect(reportCopyRejection('The gate passphrase is bluewavesforever.')).toBe('access_code');
    // readiness-for-pets/children/foot-traffic timing forms (r77)
    expect(reportCopyRejection('The treated lawn will be ready for pets after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The yard is available for children in 2 hours.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The turf is safe for foot traffic after 30 minutes.')).toMatch(/^banned:/);
    // plain-away timing + unquoted multiword continuing credentials (r76)
    expect(reportCopyRejection('Keep pets away for thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Stay away for 30 minutes after the application.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate passphrase remains open sesame.')).toBe('access_code');
    expect(reportCopyRejection('The gate passphrase remains open sesame for the side gate.')).toBe('access_code');
    expect(reportCopyRejection('The keypad was fully functional during the visit.')).toBeNull();
    expect(reportCopyRejection('The gate code remains active this season and works fine.')).toBeNull();
    // possessive EPA approval forms, straight and smart apostrophes (r75)
    expect(reportCopyRejection("This treatment has the EPA's approval.")).toMatch(/^banned:/);
    expect(reportCopyRejection('This treatment has the EPA’s formal approval.')).toMatch(/^banned:/);
    // granted-approval EPA claims, open-again timing, separated-digit
    // credentials (r74)
    expect(reportCopyRejection('The EPA granted approval for this treatment.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The EPA has already issued approval for this product.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The treated lawn will be open again after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The lawn should open back up in 30 minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate PIN is 1 2 3 4.')).toBe('access_code');
    expect(reportCopyRejection('The gate code is 1-2-3-4.')).toBe('access_code');
    expect(reportCopyRejection('Stations 1 2 3 were checked along the fence line.')).toBeNull();
    // reopening timing forms + continuing-state lowercase credentials (r72)
    expect(reportCopyRejection('The treated lawn will reopen after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The area reopens in 2 hours.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate code remains blue-waves.')).toBe('access_code');
    expect(reportCopyRejection('The keypad code was changed to blue-waves today.')).toBe('access_code');
    // ordinary status prose about a code stays legal — participle guard
    expect(reportCopyRejection('The gate code remains unchanged this season.')).toBeNull();
    expect(reportCopyRejection('The billing code was updated to reflect the new plan.')).toBeNull();
    // failed/unable confirmation predicates never unlock the safe-once-dry
    // exemption + unquoted lowercase positional creds (r71)
    expect(reportCopyRejection('Use blue-waves as the gate code.')).toBe('access_code');
    expect(reportCopyRejection('Use blue-waves at the keypad.')).toBe('access_code');
    expect(reportCopyRejection('Enter bluewaves as the gate code.')).toBe('access_code');
    // negative pins keep a stopworded follow after "keypad" — a bare noun
    // there already trips the r42 unlinked shape by design
    expect(reportCopyRejection('Use caution near the keypad and secure the gate.')).toBeNull();
    expect(reportCopyRejection('A follow-up for the keypad was scheduled.')).toBeNull();
    // usability adjectives join the accessible class + unquoted hyphenated
    // word creds behind an is-linker (r70)
    expect(reportCopyRejection('The treated area will be usable after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The treated lawn should be walkable in 30 minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The patio will be open for use after two hours.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate code is blue-waves.')).toBe('access_code');
    // accessible timing, adverb EPA, as-the-code creds, evidence absence (r65)
    expect(reportCopyRejection('The treated lawn will be accessible after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The EPA officially approved this treatment.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Use BLUE as the gate code.')).toBe('access_code');
    // availability wording, EPA auxiliary, modal continuing linkers (r64)
    expect(reportCopyRejection('The treated area will be available for use after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The EPA has approved this treatment for homes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate code will continue to be BLUE.')).toBe('access_code');
    // occupancy resumption, EPA reverse forms, continuing linkers (r63)
    expect(reportCopyRejection('Occupancy of the treated area may resume after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The treatment is approved by the EPA for residential use.')).toMatch(/^banned:/);
    expect(reportCopyRejection('This product has EPA approval.')).toMatch(/^banned:/);
    expect(reportCopyRejection('We applied an EPA-registered product near the lanai.')).toBeNull();
    expect(reportCopyRejection('BLUE continues to be the gate code.')).toBe('access_code');
    // reverse-clock play/sit/use + adverbs inside modal linkers (r62)
    expect(reportCopyRejection('After 4 PM, children can play on the treated lawn.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate code should now be BLUE.')).toBe('access_code');
    // perfect continuing-state linkers + direct use forms (r61)
    expect(reportCopyRejection('The gate code has remained BLUE.')).toBe('access_code');
    expect(reportCopyRejection('Children can use the treated lawn after thirty minutes.')).toMatch(/^banned:/);
    // adverbs inside perfect-tense credential copulas (r60)
    expect(reportCopyRejection('The gate code has always been BLUE.')).toBe('access_code');
    // direct play/sit-on forms + perfect-tense credential copulas (r59)
    expect(reportCopyRejection('Children can play on the treated lawn after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Sit on the treated lawn after 4 PM.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate code has been BLUE all season.')).toBe('access_code');
    expect(reportCopyRejection('BLUE had been the gate code before today.')).toBe('access_code');
    // passive walked-on + progressive reverse credential linkers (r58)
    expect(reportCopyRejection('The treated lawn may be walked on after 4 PM.')).toMatch(/^banned:/);
    expect(reportCopyRejection('BLUE is going to be the gate code.')).toBe('access_code');
    // imperative reverse clock + modal-copula credential linkers (r57)
    expect(reportCopyRejection('After 4 PM, enter the treated area as usual.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate code will be BLUE starting Monday.')).toBe('access_code');
    expect(reportCopyRejection('The gate code should be BLUE.')).toBe('access_code');
    // reverse at-time instructions + adverbs inside aux linkers (r56)
    expect(reportCopyRejection('At 4 PM, you can enter the treated area.')).toMatch(/^banned:/);
    expect(reportCopyRejection('We arrived at 2 PM and completed the perimeter service.')).toBeNull();
    expect(reportCopyRejection('The gate code has now changed to BLUE.')).toBe('access_code');
    // direct access instructions + auxiliary credential linkers (r55)
    expect(reportCopyRejection('Access the treated area after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The gate code has become BLUE.')).toBe('access_code');
    expect(reportCopyRejection('The gate code was changed to "sunrise7" today.')).toBe('access_code');
    expect(reportCopyRejection('The gate code was changed to prevent unauthorized access.')).toBeNull();
    // passive occupancy forms, clock and duration (r54)
    expect(reportCopyRejection('The treated area may be entered after 4 PM.')).toMatch(/^banned:/);
    expect(reportCopyRejection('The room may be reoccupied after two hours.')).toMatch(/^banned:/);
    // reverse credential order with a temporal adverb (r54)
    expect(reportCopyRejection('BLUE is now the gate code.')).toBe('access_code');
    // clock-time forms state the same fixed window (r53)
    expect(reportCopyRejection('Enter the treated area at 4:30 PM.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Stay off the treated lawn until 6 PM.')).toMatch(/^banned:/);
    expect(reportCopyRejection('We arrived at 2 PM and treated the perimeter.')).toBeNull();
    // temporal adverbs between linker and credential (r53)
    expect(reportCopyRejection('The gate code is now BLUE.')).toBe('access_code');
    // keep-out / stay-off instructions state the same window (r52)
    expect(reportCopyRejection('Keep people and pets out of the treated area for thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Stay off the treated lawn for two hours.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Keep an eye out for activity over the next 24 hours.')).toBeNull();
    expect(reportCopyRejection('Avoid mowing for 48 hours after the application.')).toBeNull();
    // continuing-state credential linkers (r52)
    expect(reportCopyRejection('The gate code remains BLUE this season.')).toBe('access_code');
    // direct enter-time instructions reject too (r51)
    expect(reportCopyRejection('Enter the treated area after thirty minutes.')).toMatch(/^banned:/);
    // was/were link a bounded UPPERCASE credential (r51)
    expect(reportCopyRejection('The gate code was BLUE for this visit.')).toBe('access_code');
    expect(reportCopyRejection('The gate code was updated in our records.')).toBeNull();
    // return/go-back wording states the same re-entry timing (r50)
    expect(reportCopyRejection('Return to the treated area after thirty minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('You can go back inside in 45 minutes.')).toMatch(/^banned:/);
    expect(reportCopyRejection('Contact us if activity returns.')).toBeNull();
    // the sanctioned idiom carries no figure and stays legal
    expect(reportCopyRejection('Keep pets off the treated areas until dry.')).toBeNull();
    expect(reportCopyRejection('We applied an EPA-registered product along the perimeter.')).toBeNull();
    // day-based cadences are not re-entry/drying figures
    expect(reportCopyRejection('The barrier typically lasts 21-30 days between visits.')).toBeNull();
  });

  test('abbreviated trade-name echoes still reject; plain vocabulary passes (r36)', () => {
    const { containsProductName } = require('../services/completion-recap');
    const o = { wholeWord: true, extraGenericTokens: new Set(['zone', 'zones']) };
    expect(containsProductName('We applied T-Zone along the walkway edges.', [{ name: 'T-Zone SE' }], o)).toBe(true);
    expect(containsProductName('We treated the affected zone today.', [{ name: 'T-Zone SE' }], o)).toBe(false);
    // r62: common words step aside while a distinctive token protects
    const drive = [{ name: 'Drive XLR8 Post Emergent Liquid Herbicide' }];
    expect(containsProductName('This will help drive crabgrass pressure down.', drive, { wholeWord: true })).toBe(false);
    expect(containsProductName('We applied XLR8 to the treated areas.', drive, { wholeWord: true })).toBe(true);
    expect(containsProductName('We applied Drive XLR8 today.', drive, { wholeWord: true })).toBe(true);
  });

  // r49 (#3420): the shared builder screens extraNames and fails CLOSED
  // when catalog hydration is load-bearing for an id-only entry's name.
  test('buildReportTradeNameScreen: extraNames reject, hydration failure propagates only when load-bearing', async () => {
    const CompletionRecap = require('../services/completion-recap');
    const screen = await CompletionRecap.buildReportTradeNameScreen({
      products: [],
      extraNames: ['Termidor HE'],
    });
    expect(screen('We applied Termidor HE along the foundation.')).toBe(true);
    expect(screen('We applied a non-repellent termiticide along the foundation.')).toBe(false);
    const failingDb = () => ({ whereIn: () => ({ select: () => Promise.reject(new Error('catalog down')) }) });
    await expect(CompletionRecap.buildReportTradeNameScreen({
      products: [{ productId: 'abc' }],
      db: failingDb,
    })).rejects.toThrow('catalog down');
    // a named entry keeps the (stricter) guard on the same failure
    const strict = await CompletionRecap.buildReportTradeNameScreen({
      products: [{ name: 'Talstar P', productId: 'abc' }],
      db: failingDb,
    });
    expect(strict('We applied Talstar around the perimeter.')).toBe(true);
  });

  test('product-record raw values ride productValues for the trade-name output guard', () => {
    const sections = typedFindingsPromptSections('termite_treatment', {
      products_used: 'Termidor HE',
      treatment_method: 'Trenching',
    });
    expect(sections.productValues).toEqual(['Termidor HE']);
  });

  test('named action fields and work sections classify as work (r5)', () => {
    const mosq = typedFindingsPromptSections('mosquito_event', {
      treatment_zones: 'Backyard foliage, fence line',
      source_reduction: 'Tipped plant saucers',
      sensitive_areas_avoided: 'Pollinator garden',
      standing_water: 'Birdbath',
    });
    expect(mosq.work).toHaveLength(3);
    expect(mosq.observations.join(' ')).toContain('Birdbath');
    expect(mosq.observations.join(' ')).not.toContain('fence line');
    const excl = typedFindingsPromptSections('rodent_exclusion', { entry_points_addressed: 'Garage corner gap sealed' });
    expect(excl.work).toHaveLength(1);
  });

  test('customer-communication fields keep their reported-by-customer provenance (r5)', () => {
    const sections = typedFindingsPromptSections('mosquito_event', {
      customer_reported: 'Bites on the lanai at dusk',
      customer_discussed: 'Dumping standing water weekly',
    });
    expect(sections.customer).toHaveLength(2);
    expect(sections.observations).toHaveLength(0);
    const block = buildTypedFindingsPromptBlock({
      findingsType: 'mosquito_event',
      values: { customer_reported: 'Bites on the lanai at dusk' },
      nextStepChips: [],
      companionFindings: [],
      allowedCompanionTypes: [],
    });
    expect(block).toContain('Customer communication (');
    expect(block).toContain('NEVER present as a technician-verified finding');
    expect(block).not.toMatch(/Findings observed:[^]*lanai/);
  });

  test('percent_solution is application-record data, never an observation (r5)', () => {
    const sections = typedFindingsPromptSections('termite_treatment', { percent_solution: '0.06' });
    expect(sections.products.join(' ')).toContain('0.06');
    expect(sections.observations).toHaveLength(0);
  });

  test('termite compliance fields keep application/work provenance (r6)', () => {
    const treat = typedFindingsPromptSections('termite_treatment', {
      linear_feet_or_stations: '120 linear ft',
      posted_notice: 'Yes',
    });
    expect(treat.products.join(' ')).toContain('120 linear ft');
    expect(treat.work.join(' ')).toContain('Yes');
    expect(treat.observations).toHaveLength(0);
    const insp = typedFindingsPromptSections('termite_inspection', { inspection_notice_affixed: 'Yes' });
    expect(insp.work).toHaveLength(1);
    expect(insp.observations).toHaveLength(0);
  });

  test('initial-setup trap counts prompt as "Traps set" (r7)', () => {
    const setup = typedFindingsPromptSections('rodent_trapping', {
      trap_visit_type: 'Initial setup',
      traps_checked: '6',
    });
    // placing traps is work performed — the setup count lives in the work
    // group, not observations (codex r13)
    expect(setup.work.join(' ')).toContain('Traps set: 6');
    expect(setup.observations.join(' ')).not.toContain('Traps set');
    expect(setup.work.concat(setup.observations).join(' ')).not.toContain('Traps checked');
    const check = typedFindingsPromptSections('rodent_trapping', {
      trap_visit_type: 'Check / service',
      traps_checked: '6',
    });
    expect(check.work.concat(check.observations).join(' ')).toContain('Traps checked: 6');
  });

  test('only name-bearing product fields feed the trade-name guard (r7)', () => {
    const sections = typedFindingsPromptSections('termite_treatment', {
      products_used: 'Termidor HE',
      linear_feet_or_stations: '120 linear ft',
      percent_solution: '0.06',
    });
    expect(sections.productValues).toEqual(['Termidor HE']);
    expect(sections.products.length).toBe(3);
  });

  test('serviced-scope fields classify as completed work (r8)', () => {
    const palm = typedFindingsPromptSections('palm_injection', { palms_serviced: '4' });
    expect(palm.work).toHaveLength(1);
    expect(palm.observations).toHaveLength(0);
    const ts = typedFindingsPromptSections('tree_shrub', { plant_groups: 'Palms, Shrubs' });
    expect(ts.work).toHaveLength(1);
  });

  test('a shaped response with parser-only forbidden terms is rejected (r15)', async () => {
    const provider = (name, responses) => ({
      name, model: `${name}-model`,
      call: jest.fn().mockImplementation(() => Promise.resolve(responses.shift())),
    });
    const goodShape = 'WHAT WE DID\n\nWe serviced the bait stations.\n\nWHAT WE FOUND\n\nActivity was light.';
    // parses, but the parser's own screens null the body ('infestation')
    const parserRejected = 'WHAT WE DID\n\nWe treated the infestation areas.\n\nWHAT WE FOUND\n\nActivity was light.';
    const openai = provider('openai', [{ ok: true, text: parserRejected }, { ok: true, text: goodShape }]);
    const result = await generateReportCopyWithFallback({
      systemPrompt: 's', userMessage: 'u', providers: [openai, provider('anthropic', [])],
    });
    expect(result.ok).toBe(true);
    expect(result.report).toBe(goodShape);
    expect(openai.call).toHaveBeenCalledTimes(2);
  });

  test('status-only options split out of work-classified chip fields (r18)', () => {
    const trap = typedFindingsPromptSections('rodent_trapping', {
      trap_actions: 'Traps reset, Damaged or missing traps found',
    });
    expect(trap.work.join(' ')).toContain('Traps reset');
    expect(trap.work.join(' ')).not.toContain('Damaged or missing');
    expect(trap.observations.join(' ')).toContain('Damaged or missing traps found');
    const wild = typedFindingsPromptSections('wildlife_trapping', { trap_actions: 'No activity at traps' });
    expect(wild.work).toHaveLength(0);
    expect(wild.observations.join(' ')).toContain('No activity at traps');
  });

  test('bare "Noises reported" is second-hand evidence too (r25)', () => {
    const wild = typedFindingsPromptSections('wildlife_trapping', {
      evidence_observed: 'Droppings, Noises reported',
    });
    expect(wild.observations.join(' ')).toContain('Droppings');
    expect(wild.observations.join(' ')).not.toContain('Noises');
    expect(wild.customer.join(' ')).toContain('Noises reported');
  });

  test('customer-reported evidence options split to customer provenance (r24)', () => {
    const bb = typedFindingsPromptSections('bed_bug', {
      evidence_observed: 'Live bed bugs, Bites reported by customer',
    });
    expect(bb.observations.join(' ')).toContain('Live bed bugs');
    expect(bb.observations.join(' ')).not.toContain('Bites reported');
    expect(bb.customer.join(' ')).toContain('Bites reported by customer');
  });

  test('historical Completed-previously status is not future advice (r24)', () => {
    const excl = typedFindingsPromptSections('rodent_trapping', {
      exclusion_recommendation: 'Completed previously',
    });
    expect(excl.advice).toHaveLength(0);
    expect(excl.observations).toHaveLength(1);
  });

  test('negative advice answers are status, not recommendations (r27)', () => {
    const g = typedFindingsPromptSections('german_roach_knockdown', { followup_required: 'No' });
    expect(g.advice).toHaveLength(0);
    expect(g.observations).toHaveLength(1);
    const yes = typedFindingsPromptSections('german_roach_knockdown', { followup_required: 'Yes' });
    expect(yes.advice).toHaveLength(1);
  });

  test('negative answers on work fields are status, not completed work (r20)', () => {
    const neg = typedFindingsPromptSections('rodent_bait_station', { bait_replaced: 'No' });
    expect(neg.work).toHaveLength(0);
    expect(neg.observations).toHaveLength(1);
    const pos = typedFindingsPromptSections('rodent_bait_station', { bait_replaced: 'Yes' });
    expect(pos.work).toHaveLength(1);
  });

  test('limited treatments stay completed work; cleanup-needed is advice (r20)', () => {
    const flea = typedFindingsPromptSections('flea', { treatment_completed: 'Limited treatment' });
    expect(flea.work.join(' ')).toContain('Limited treatment');
    expect(flea.observations).toHaveLength(0);
    const clean = typedFindingsPromptSections('rodent_trapping', { additional_cleanup_needed: 'Yes' });
    expect(clean.advice).toHaveLength(1);
    expect(clean.observations).toHaveLength(0);
  });

  test('recommendation and limitation options split out of work chips (r19)', () => {
    const san = typedFindingsPromptSections('rodent_sanitation', {
      sanitation_work_completed: 'Removed droppings, Insulation removal recommended, Limited cleanup due to access',
    });
    expect(san.work.join(' ')).toContain('Removed droppings');
    expect(san.advice.join(' ')).toContain('Insulation removal recommended');
    expect(san.observations.join(' ')).toContain('Limited cleanup due to access');
    expect(san.work.join(' ')).not.toContain('recommended');
    expect(san.work.join(' ')).not.toContain('Limited');
  });

  test('wildlife suspected species stays an observation (r15)', () => {
    const wild = typedFindingsPromptSections('wildlife_trapping', { target_animal: 'Raccoon' });
    expect(wild.observations.join(' ')).toContain('Raccoon');
    expect(wild.work).toHaveLength(0);
  });

  test('treatment targets are completed-work context, not findings (r14)', () => {
    const treat = typedFindingsPromptSections('termite_treatment', { target_termite: 'Unknown / preventive' });
    expect(treat.work.join(' ')).toContain('Unknown / preventive');
    expect(treat.observations).toHaveLength(0);
    const pest = typedFindingsPromptSections('one_time_pest_treatment', { target_pest: 'Ghost ants' });
    expect(pest.work.join(' ')).toContain('Ghost ants');
    expect(pest.observations).toHaveLength(0);
  });

  test('inspected scope is completed work; NOT-inspected scope stays an observation (r9)', () => {
    const insp = typedFindingsPromptSections('termite_inspection', {
      areas_inspected: 'Attic, garage, exterior perimeter',
      areas_not_inspected: 'Crawlspace (no access)',
    });
    expect(insp.work.join(' ')).toContain('Attic');
    expect(insp.observations.join(' ')).toContain('Crawlspace');
    expect(insp.observations.join(' ')).not.toContain('Attic');
  });

  test('contamination severity is an observation; urgency is advice (r10)', () => {
    const san = typedFindingsPromptSections('rodent_sanitation', {
      sanitation_areas: 'Attic',
      contamination_level: 'Heavy',
    });
    expect(san.work.join(' ')).toContain('Attic');
    expect(san.observations.join(' ')).toContain('Heavy');
    const insp = typedFindingsPromptSections('rodent_inspection', { urgency: 'High' });
    expect(insp.advice.join(' ')).toContain('High');
    expect(insp.observations).toHaveLength(0);
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
