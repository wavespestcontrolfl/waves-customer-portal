const {
  applyFixtureReplayOptions,
  buildMissingFixtureResults,
  buildReplayErrorResult,
  etScheduleParts,
  evaluateFixtureExpectation,
  goldFieldValues,
  GOLD_FIELDS,
  loadReplayFixture,
  parseArgs,
  shouldFailRun,
  summarizeResults,
} = require('../scripts/replay-call-extraction-variance');

function validResult(overrides = {}) {
  return {
    callId: '11111111-1111-4111-8111-111111111111',
    current: {
      status: 'valid',
      wouldAutoRoute: true,
      flags: [],
      schedulingStatus: 'confirmed',
    },
    legacy: {
      scheduledCreated: false,
    },
    variance: {
      routeChangedVsLegacySchedule: false,
      appointmentCandidateChangedVsLegacy: false,
      priorV2RouteChanged: false,
      legacyFieldVariances: [],
      legacyScheduledServiceVariances: [],
      priorV2FieldVariances: [],
    },
    transcription: {
      replay: { attempted: false, status: 'not_requested' },
    },
    ...overrides,
  };
}

describe('call extraction replay variance reporting', () => {
  test('parses naive extracted schedule timestamps as ET wall-clock', () => {
    expect(etScheduleParts('2026-06-15T11:00:00')).toEqual({
      scheduled_date: '2026-06-15',
      window_start: '11:00',
    });
  });

  test('evaluates fixture expectations against replay results', () => {
    const result = validResult({
      current: {
        status: 'valid',
        wouldAutoRoute: false,
        flags: ['name_email_mismatch'],
        schedulingStatus: 'confirmed',
      },
    });

    expect(evaluateFixtureExpectation(result, {
      expect: {
        current_status: 'valid',
        current_scheduling_status: 'confirmed',
        current_schedule_date: '2026-06-15',
        current_schedule_window_start: '11:00',
        current_would_auto_route: false,
        current_flags_include: ['name_email_mismatch'],
        current_flags_exclude: ['address_unverifiable'],
      },
    }, {
      currentSchedule: {
        scheduled_date: '2026-06-15',
        window_start: '11:00',
      },
    })).toMatchObject({
      status: 'pass',
      checked: 7,
      failures: [],
    });
  });

  test('reports fixture expectation failures without throwing', () => {
    const expectation = evaluateFixtureExpectation(validResult(), {
      expect: {
        current_would_auto_route: false,
        current_flags_include: ['name_email_mismatch'],
      },
    });

    expect(expectation.status).toBe('fail');
    expect(expectation.failures.map((failure) => failure.name)).toEqual([
      'current_would_auto_route',
      'current_flags_include:name_email_mismatch',
    ]);
  });

  test('block-reasons subset passes when only allowed holds block the call', () => {
    const result = validResult({
      current: {
        status: 'valid',
        wouldAutoRoute: false,
        routeReason: 'address_not_validated',
        appointmentBlockingFlags: [],
        flags: [],
        schedulingStatus: 'confirmed',
      },
    });

    expect(evaluateFixtureExpectation(result, {
      expect: { current_block_reasons_subset_of: ['address_not_validated'] },
    })).toMatchObject({ status: 'pass', failures: [] });
  });

  test('block-reasons subset passes when the call auto-routes outright', () => {
    expect(evaluateFixtureExpectation(validResult(), {
      expect: { current_block_reasons_subset_of: ['address_not_validated'] },
    })).toMatchObject({ status: 'pass', failures: [] });
  });

  test('block-reasons subset unwraps the triage_flags umbrella to its specific flags', () => {
    const result = validResult({
      current: {
        status: 'valid',
        wouldAutoRoute: false,
        routeReason: 'triage_flags',
        appointmentBlockingFlags: ['no_sms_consent_captured'],
        flags: ['no_sms_consent_captured'],
        schedulingStatus: 'confirmed',
      },
    });

    expect(evaluateFixtureExpectation(result, {
      expect: {
        current_block_reasons_subset_of: ['address_not_validated', 'no_sms_consent_captured'],
      },
    })).toMatchObject({ status: 'pass', failures: [] });
  });

  test('block-reasons subset ignores the all-flags fallback on central-gate vetoes', () => {
    // On a central-gate veto routeForV2 falls back to ALL merged flags for
    // appointmentBlockingFlags — advisory flags there must not count as holds.
    const result = validResult({
      current: {
        status: 'valid',
        wouldAutoRoute: false,
        routeReason: 'address_not_validated',
        appointmentBlockingFlags: ['no_sms_consent_captured', 'prior_complaint_unresolved'],
        flags: ['no_sms_consent_captured', 'prior_complaint_unresolved'],
        schedulingStatus: 'confirmed',
      },
    });

    expect(evaluateFixtureExpectation(result, {
      expect: { current_block_reasons_subset_of: ['address_not_validated'] },
    })).toMatchObject({ status: 'pass', failures: [] });
  });

  test('block-reasons subset fails on any hold outside the allowed list', () => {
    const result = validResult({
      current: {
        status: 'valid',
        wouldAutoRoute: false,
        routeReason: 'triage_flags',
        appointmentBlockingFlags: ['no_sms_consent_captured', 'name_email_mismatch'],
        flags: ['no_sms_consent_captured', 'name_email_mismatch'],
        schedulingStatus: 'confirmed',
      },
    });

    const expectation = evaluateFixtureExpectation(result, {
      expect: {
        current_block_reasons_subset_of: ['address_not_validated', 'no_sms_consent_captured'],
      },
    });
    expect(expectation.status).toBe('fail');
    expect(expectation.failures.map((failure) => failure.name)).toEqual([
      'current_block_reasons_subset_of',
    ]);
  });

  test('block-reasons subset records a fixture error on a non-array value', () => {
    const expectation = evaluateFixtureExpectation(validResult(), {
      expect: { current_block_reasons_subset_of: 'address_not_validated' },
    });
    expect(expectation.status).toBe('fail');
    expect(expectation.failures.map((failure) => failure.name)).toEqual([
      'fixture_error:invalid_current_block_reasons_subset_of',
      'fixture_error:no_recognized_checks',
    ]);
  });

  test('scores the per-field answer key: high misses fail, medium/low misses only lower accuracy', () => {
    const result = validResult({
      current: {
        status: 'valid',
        wouldAutoRoute: false,
        flags: ['voicemail'],
        schedulingStatus: 'none',
        fields: {
          is_voicemail: true,
          is_spam: false,
          call_nature: 'new_lead',
          scheduling_status: 'none',
          recommended_disposition: 'callback_task_created',
          primary_service_category: 'termite',
          urgency: 'within_48_hours',
          schedule_window_start: null,
        },
      },
    });

    const pass = evaluateFixtureExpectation(result, {
      expect: { current_status: 'valid' },
      gold: {
        is_voicemail: true,
        call_nature: ['new_lead', 'voicemail_message'],
        recommended_disposition: 'CALLBACK_TASK_CREATED',
      },
    });
    expect(pass).toMatchObject({ status: 'pass', checked: 3, failures: [] });
    expect(pass.gold.scored).toHaveLength(3);
    expect(pass.gold.misses).toEqual([]);

    const mixed = evaluateFixtureExpectation(result, {
      expect: { current_status: 'valid' },
      gold: {
        is_spam: true,                       // high miss -> fails the case
        primary_service_category: 'wdo',     // medium miss -> accuracy only
        urgency: ['emergency_same_day', 'within_48_hours'],
      },
    });
    expect(mixed.status).toBe('fail');
    expect(mixed.failures.map((failure) => failure.name)).toEqual(['gold:is_spam']);
    expect(mixed.failures[0]).toMatchObject({ actual: false, expected: true });
    expect(mixed.gold.misses.map((miss) => miss.field).sort()).toEqual(['is_spam', 'primary_service_category']);
    expect(mixed.gold.scored.find((entry) => entry.field === 'urgency').correct).toBe(true);

    // A missing/null model value never matches a gold label.
    const nullMiss = evaluateFixtureExpectation(result, {
      expect: { current_status: 'valid' },
      gold: { schedule_window_start: '11:00' },
    });
    expect(nullMiss.status).toBe('fail');
    expect(nullMiss.failures[0]).toMatchObject({ name: 'gold:schedule_window_start', actual: null });
  });

  test('answer key is unscored (not wrong) when the replay produced no extraction', () => {
    const errored = validResult({ current: { status: 'error', wouldAutoRoute: false, flags: [], fields: null } });
    const expectation = evaluateFixtureExpectation(errored, {
      expect: { current_would_auto_route: false },
      gold: { is_spam: false, call_nature: 'new_lead' },
    });
    expect(expectation.failures.map((failure) => failure.name)).toEqual([]);
    expect(expectation.gold.scored).toEqual([]);
    expect(expectation.gold.unscored.map((entry) => entry.field)).toEqual(['is_spam', 'call_nature']);
  });

  test('rejects unknown gold fields and malformed gold values as fixture errors', () => {
    const expectation = evaluateFixtureExpectation(validResult({
      current: { status: 'valid', wouldAutoRoute: true, flags: [], fields: { is_spam: false } },
    }), {
      expect: { current_status: 'valid' },
      gold: { caller_phone: '+19415550100', is_spam: [], call_nature: 42 },
    });
    expect(expectation.status).toBe('fail');
    expect(expectation.failures.map((failure) => failure.name)).toEqual([
      'fixture_error:unknown_gold_field:caller_phone',
      'fixture_error:invalid_gold_value:is_spam',
      'fixture_error:invalid_gold_value:call_nature',
    ]);

    expect(evaluateFixtureExpectation(validResult(), { expect: { current_status: 'valid' }, gold: ['is_spam'] }).failures)
      .toEqual([expect.objectContaining({ name: 'fixture_error:invalid_gold' })]);
  });

  test('summarizes answer-key accuracy overall and per field', () => {
    const scoredResult = (caseId, scored, unscored = []) => validResult({
      fixture: { caseId, expectation: { status: 'pass', checked: 1, failures: [], gold: { scored, unscored, misses: scored.filter((s) => !s.correct) } } },
    });
    const summary = summarizeResults([
      scoredResult('a', [
        { field: 'is_spam', severity: 'high', expected: false, actual: false, correct: true },
        { field: 'call_nature', severity: 'high', expected: 'new_lead', actual: 'other', correct: false },
      ]),
      scoredResult('b', [
        { field: 'is_spam', severity: 'high', expected: false, actual: false, correct: true },
      ], [{ field: 'urgency', severity: 'medium', expected: 'within_48_hours' }]),
      validResult(), // no fixture at all
    ], parseArgs([]));

    expect(summary.goldAccuracy).toEqual({
      labeled: 3,
      correct: 2,
      unscored: 1,
      accuracy: 0.6667,
      byField: {
        is_spam: { severity: 'high', labeled: 2, correct: 2, accuracy: 1, missCaseIds: [] },
        call_nature: { severity: 'high', labeled: 1, correct: 0, accuracy: 0, missCaseIds: ['a'] },
      },
    });
    expect(summarizeResults([validResult()], parseArgs([])).goldAccuracy).toEqual({
      labeled: 0, correct: 0, unscored: 0, accuracy: null, byField: {},
    });
  });

  test('goldFieldValues reads only enum/boolean/date fields off the extraction', () => {
    const values = goldFieldValues({
      meta: { is_voicemail: false, is_spam: false },
      call_nature: 'new_lead',
      recommended_disposition: 'estimate_send',
      caller: { first_name: 'Pat', phone_e164: '+19415550100' },
      property: { property_type: 'condo', service_address: { line1: '1 Main St' } },
      scheduling: { status: 'confirmed', agent_committed_booking: true },
      service_request: { primary_service_category: 'wdo', service_intent: 'quote_only', urgency: 'within_one_week', quote_promised: true },
      customer_history: { status: 'new_customer' },
      sentiment_and_lead: { lead_quality: 'hot' },
      language: 'english',
    }, { scheduled_date: '2026-06-15', window_start: '11:00' });

    expect(Object.keys(values).sort()).toEqual(Object.keys(GOLD_FIELDS).sort());
    expect(values).toMatchObject({
      is_voicemail: false,
      call_nature: 'new_lead',
      scheduling_status: 'confirmed',
      agent_committed_booking: true,
      schedule_date: '2026-06-15',
      schedule_window_start: '11:00',
      quote_promised: true,
      property_type: 'condo',
      customer_history_status: 'new_customer',
      lead_quality: 'hot',
      language: 'english',
    });
    expect(JSON.stringify(values)).not.toMatch(/Pat|9415550100|Main St/);
    expect(goldFieldValues({}, {})).toMatchObject({ is_spam: null, schedule_date: null });
  });

  test('checks call-nature and recommended-disposition membership expectations', () => {
    const result = validResult({
      current: {
        status: 'valid',
        wouldAutoRoute: false,
        flags: ['voicemail'],
        schedulingStatus: 'none',
        callNature: 'new_lead',
        recommendedDisposition: 'callback_task_created',
      },
    });

    expect(evaluateFixtureExpectation(result, {
      expect: {
        current_call_nature_in: ['new_lead', 'voicemail_message'],
        current_recommended_disposition_in: ['callback_task_created', 'lead_response_flow_triggered'],
      },
    })).toMatchObject({
      status: 'pass',
      checked: 2,
      failures: [],
    });

    const miss = evaluateFixtureExpectation(result, {
      expect: {
        current_call_nature_in: ['spam_solicitation'],
        current_recommended_disposition_in: ['booked'],
      },
    });
    expect(miss.status).toBe('fail');
    expect(miss.failures.map((failure) => failure.name)).toEqual([
      'current_call_nature_in',
      'current_recommended_disposition_in',
    ]);

    // Older extractions predate call_nature (schema 1.6.0) — a null never matches.
    const nullNature = evaluateFixtureExpectation(validResult(), {
      expect: { current_call_nature_in: ['new_lead'] },
    });
    expect(nullNature.status).toBe('fail');
    expect(nullNature.failures[0]).toMatchObject({ name: 'current_call_nature_in', actual: undefined });

    expect(evaluateFixtureExpectation(validResult(), {
      expect: {
        current_call_nature_in: [],
        current_recommended_disposition_in: 'booked',
      },
    })).toMatchObject({
      status: 'fail',
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'fixture_error:invalid_current_call_nature_in' }),
        expect.objectContaining({ name: 'fixture_error:invalid_current_recommended_disposition_in' }),
      ]),
    });
  });

  test('fails fixture expectations with empty, unknown, or invalid checks', () => {
    expect(evaluateFixtureExpectation(validResult(), { expect: {} })).toMatchObject({
      status: 'fail',
      checked: 0,
      failures: [expect.objectContaining({ name: 'fixture_error:no_recognized_checks' })],
    });

    expect(evaluateFixtureExpectation(validResult(), {
      expect: {
        current_flags_include: ['name_email_mismatch', 123],
        current_route_allowed: true,
      },
    })).toMatchObject({
      status: 'fail',
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'fixture_error:invalid_current_flags_include' }),
        expect.objectContaining({ name: 'fixture_error:unknown_key:current_route_allowed' }),
        expect.objectContaining({ name: 'fixture_error:no_recognized_checks' }),
      ]),
    });

    expect(evaluateFixtureExpectation(validResult(), {
      expect: {
        current_status: 'valid',
        current_scheduling_status: false,
        current_schedule_window_start: false,
        current_flags_exclude: [],
      },
    })).toMatchObject({
      status: 'fail',
      checked: 1,
      failures: expect.arrayContaining([
        expect.objectContaining({ name: 'fixture_error:invalid_current_scheduling_status' }),
        expect.objectContaining({ name: 'fixture_error:invalid_current_schedule_window_start' }),
        expect.objectContaining({ name: 'fixture_error:invalid_current_flags_exclude' }),
      ]),
    });
  });

  test('builds an error result that summary counts instead of aborting the batch', () => {
    const result = buildReplayErrorResult({
      id: '22222222-2222-4222-8222-222222222222',
      transcription: 'Agent: hello',
      ai_extraction: JSON.stringify({ appointment_confirmed: true }),
    }, new Error('model timeout'), {});

    const summary = summarizeResults([result], {
      limit: 1,
      ids: [],
      days: 30,
      statuses: ['processed'],
      fixturePath: null,
      retranscribe: false,
      onlyAppointmentCandidates: false,
      includeValues: false,
    });

    expect(result.current.status).toBe('error');
    expect(result.error.message).toBe('model timeout');
    expect(summary.replayErrors).toBe(1);
    expect(summary.replayErrorCallIds).toEqual(['22222222-2222-4222-8222-222222222222']);
  });

  test('turns missing fixture call rows into failing error results', () => {
    const missing = buildMissingFixtureResults({
      cases: [
        {
          id: 'loaded-case',
          call_log_id: '11111111-1111-4111-8111-111111111111',
          expect: { current_status: 'valid' },
        },
        {
          id: 'missing-case',
          call_log_id: '33333333-3333-4333-8333-333333333333',
          expect: { current_status: 'valid' },
        },
      ],
      byCallId: new Map([
        ['33333333-3333-4333-8333-333333333333', {
          id: 'missing-case',
          call_log_id: '33333333-3333-4333-8333-333333333333',
          expect: { current_status: 'valid' },
        }],
      ]),
    }, [{ id: '11111111-1111-4111-8111-111111111111' }], {
      fixtureCaseByCallId: new Map([
        ['33333333-3333-4333-8333-333333333333', {
          id: 'missing-case',
          expect: { current_status: 'valid' },
        }],
      ]),
    });

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      callId: '33333333-3333-4333-8333-333333333333',
      current: { status: 'error', routeReason: 'replay_error' },
      error: { message: 'fixture call was not loaded by call_log query' },
      fixture: {
        caseId: 'missing-case',
        expectation: {
          status: 'fail',
        },
      },
    });
  });

  test('honors explicit fixture ids when reporting missing cases', () => {
    const fixture = {
      cases: [
        {
          id: 'requested-missing-case',
          call_log_id: '33333333-3333-4333-8333-333333333333',
          expect: { current_status: 'valid' },
        },
        {
          id: 'unrequested-case',
          call_log_id: '44444444-4444-4444-8444-444444444444',
          expect: { current_status: 'valid' },
        },
      ],
    };
    const fixtureCaseByCallId = new Map(fixture.cases.map((item) => [item.call_log_id, item]));

    const missing = buildMissingFixtureResults(fixture, [], {
      fixtureCaseByCallId,
      requiredCallIds: ['33333333-3333-4333-8333-333333333333'],
    });

    expect(missing.map((item) => item.callId)).toEqual(['33333333-3333-4333-8333-333333333333']);
  });

  test('fixture loader rejects empty and duplicate fixture case sets', () => {
    const originalCwd = process.cwd();
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'call-fixture-'));
    try {
      process.chdir(dir);
      fs.writeFileSync('empty.json', JSON.stringify({ cases: [] }));
      fs.writeFileSync('dupe.json', JSON.stringify({
        cases: [
          { id: 'a', call_log_id: '11111111-1111-4111-8111-111111111111', expect: { current_status: 'valid' } },
          { id: 'b', call_log_id: '11111111-1111-4111-8111-111111111111', expect: { current_status: 'valid' } },
        ],
      }));

      expect(() => loadReplayFixture('empty.json')).toThrow(/at least one reviewed case/);
      expect(() => loadReplayFixture('dupe.json')).toThrow(/duplicate call_log_id/);
    } finally {
      process.chdir(originalCwd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('parseArgs records explicit ids separately from fixture-expanded ids', () => {
    expect(parseArgs(['--fixture=reviewed.json']).explicitIds).toBe(false);
    expect(parseArgs(['--fixture=reviewed.json', '--ids=11111111-1111-4111-8111-111111111111'])).toMatchObject({
      explicitIds: true,
      ids: ['11111111-1111-4111-8111-111111111111'],
    });
  });

  test('fixture setup raises limit for explicit ids and rejects non-fixture ids', () => {
    const ids = Array.from({ length: 11 }, (_, index) => `fixture-call-${index + 1}`);
    const fixture = {
      path: 'reviewed.json',
      cases: ids.map((callId) => ({ call_log_id: callId })),
      byCallId: new Map(ids.map((callId) => [callId, { call_log_id: callId }])),
    };
    const options = {
      limit: 10,
      ids,
      explicitIds: true,
    };

    expect(applyFixtureReplayOptions(options, fixture)).toEqual(ids);
    expect(options.limit).toBe(11);

    expect(() => applyFixtureReplayOptions({
      limit: 10,
      ids: ['not-in-fixture'],
      explicitIds: true,
    }, fixture)).toThrow(/does not contain explicit --ids/);
    expect(() => applyFixtureReplayOptions({
      limit: 10,
      ids: [],
      explicitIds: true,
    }, fixture)).toThrow(/must include at least one fixture call_log_id/);
  });

  test('fixture runs should fail after printing summary when errors or expectation failures exist', () => {
    const options = {
      fixturePath: 'server/fixtures/call-extraction-eval/reviewed-calls.json',
    };
    expect(shouldFailRun({
      replayErrors: 1,
      fixtureExpectations: { failed: 0 },
    }, options)).toBe(true);
    expect(shouldFailRun({
      replayErrors: 0,
      fixtureExpectations: { failed: 1 },
    }, options)).toBe(true);
    expect(shouldFailRun({
      replayErrors: 0,
      fixtureExpectations: { failed: 0 },
    }, options)).toBe(false);
    expect(shouldFailRun({
      replayErrors: 1,
      fixtureExpectations: { failed: 0 },
    }, { fixturePath: null })).toBe(false);
  });
});
