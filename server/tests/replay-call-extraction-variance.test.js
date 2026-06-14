const {
  applyFixtureReplayOptions,
  buildMissingFixtureResults,
  buildReplayErrorResult,
  etScheduleParts,
  evaluateFixtureExpectation,
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
