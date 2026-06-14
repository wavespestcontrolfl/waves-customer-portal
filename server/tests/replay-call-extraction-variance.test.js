const {
  buildReplayErrorResult,
  evaluateFixtureExpectation,
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
});
