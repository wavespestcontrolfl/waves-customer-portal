const {
  buildMissingFixtureResults,
  buildReplayErrorResult,
  evaluateFixtureExpectation,
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
  test('evaluates fixture expectations against replay results', () => {
    const result = validResult({
      current: {
        status: 'valid',
        wouldAutoRoute: false,
        flags: ['name_email_mismatch'],
      },
    });

    expect(evaluateFixtureExpectation(result, {
      expect: {
        current_status: 'valid',
        current_would_auto_route: false,
        current_flags_include: ['name_email_mismatch'],
        current_flags_exclude: ['address_unverifiable'],
      },
    })).toMatchObject({
      status: 'pass',
      checked: 4,
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
