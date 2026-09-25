'use strict';

const fs = require('fs');
const {
  loadGratitudeExam,
  buildGratitudeExamInput,
  gradeGratitudeResults,
} = require('../services/sms-gratitude-grading');
const { evaluateGratitudeContext } = require('../services/sms-gratitude');

const LEGS = ['anthropic', 'openai'];
const PINS = {
  routes: {
    anthropic: { model: 'synthetic-anthropic' },
    openai: { model: 'synthetic-openai' },
  },
  verifier: { enabled: true, model: 'synthetic-verifier' },
  voiceProfileVersion: 'synthetic-profile-v1',
};

function passingResult(fixture, leg) {
  const policy = evaluateGratitudeContext(fixture.source);
  return {
    fixtureId: fixture.id,
    leg,
    output: {
      parsed: {
        reply: fixture.expectedEligible ? policy.reply : '',
        intendedActions: [{ type: 'none' }],
        actionsRawSafe: true,
        missingInfo: null,
      },
      passes: 1,
      converged: true,
      model: PINS.routes[leg].model,
      servedModel: PINS.routes[leg].model,
      verifierModels: fixture.expectedEligible ? [PINS.verifier.model] : [],
      voiceProfileVersion: PINS.voiceProfileVersion,
    },
  };
}

function passingResults(exam) {
  return exam.fixtures.flatMap(fixture => LEGS.map(leg => passingResult(fixture, leg)));
}

function clone(value) {
  return structuredClone(value);
}

describe('pure gratitude qualification grading', () => {
  test('loads and validates the fixed anonymous corpus', () => {
    const { exam, fixtureSha256 } = loadGratitudeExam();

    expect(fixtureSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(exam.fixtures.map(fixture => fixture.id)).toEqual([
      'positive_report', 'positive_receipt', 'positive_completed_service', 'positive_bank_ack',
      'positive_manual_answer', 'positive_manual_after_question',
      'negative_mixed_thanks', 'negative_question', 'negative_promise', 'negative_manual_payment_request', 'negative_complaint',
      'negative_booking_acceptance', 'negative_media', 'negative_prior_operational',
      'negative_new_inbound', 'negative_new_outbound', 'negative_loop',
      'negative_missing_context', 'negative_pending_work',
    ]);
    for (const fixture of exam.fixtures) {
      expect(evaluateGratitudeContext(fixture.source).eligible).toBe(fixture.expectedEligible);
    }
  });

  test.each([
    ['schema', exam => ({ ...exam, schemaVersion: 'wrong' }), 'invalid_gratitude_exam'],
    ['duplicate fixture id', exam => ({ ...exam, fixtures: [exam.fixtures[0], exam.fixtures[0]] }), 'invalid_gratitude_fixture'],
  ])('rejects an invalid %s', (_label, mutate, error) => {
    const valid = loadGratitudeExam().exam;
    const spy = jest.spyOn(fs, 'readFileSync').mockReturnValue(Buffer.from(JSON.stringify(mutate(valid))));
    try {
      expect(() => loadGratitudeExam()).toThrow(error);
    } finally {
      spy.mockRestore();
    }
  });

  test('requires the complete exact fixture-leg pair set', () => {
    const { exam } = loadGratitudeExam();
    const complete = passingResults(exam);
    expect(gradeGratitudeResults({ exam, results: complete, pins: PINS, legs: LEGS }))
      .toEqual({ qualified: true, reason: 'qualified', positives: 12, negatives: 26 });

    expect(gradeGratitudeResults({ exam, results: complete.slice(1), pins: PINS, legs: LEGS }))
      .toMatchObject({ qualified: false, reason: 'result_set_incomplete' });
    expect(gradeGratitudeResults({
      exam, results: [...complete.slice(0, -1), clone(complete[0])], pins: PINS, legs: LEGS,
    })).toMatchObject({ qualified: false, reason: 'result_set_invalid' });
    const unknown = clone(complete);
    unknown[0].fixtureId = 'unknown_fixture';
    expect(gradeGratitudeResults({ exam, results: unknown, pins: PINS, legs: LEGS }))
      .toMatchObject({ qualified: false, reason: 'result_set_invalid' });
  });

  test.each([
    ['changed copy', result => { result.output.parsed.reply = 'You are welcome!'; }],
    ['unsafe raw actions', result => { result.output.parsed.actionsRawSafe = false; }],
    ['non-none action', result => { result.output.parsed.intendedActions = [{ type: 'escalate' }]; }],
    ['unconverged output', result => { result.output.converged = false; }],
    ['wrong model', result => { result.output.model = 'other-model'; }],
    ['missing served-model telemetry', result => { result.output.servedModel = null; }],
    ['different served model', result => { result.output.servedModel = 'provider-resolved-alias'; }],
    ['missing verifier telemetry', result => { result.output.verifierModels = []; }],
    ['fallback verifier model', result => { result.output.verifierModels = ['synthetic-fallback']; }],
    ['wrong profile', result => { result.output.voiceProfileVersion = 'other-profile'; }],
  ])('a positive leg fails on %s', (_label, mutate) => {
    const { exam } = loadGratitudeExam();
    const results = passingResults(exam);
    mutate(results.find(result => result.fixtureId === 'positive_report'));

    expect(gradeGratitudeResults({ exam, results, pins: PINS, legs: LEGS }))
      .toMatchObject({ qualified: false, reason: 'positive_failed' });
  });

  test.each([
    ['nonempty reply', (result) => { result.output.parsed.reply = 'Our pleasure, Casey!'; }],
    ['unsafe raw actions', (result) => { result.output.parsed.actionsRawSafe = false; }],
    ['non-none action', (result) => { result.output.parsed.intendedActions = [{ type: 'escalate' }]; }],
    ['unconverged output', (result) => { result.output.converged = false; }],
    ['zero generation passes', (result) => { result.output.passes = 0; }],
    ['wrong model', (result) => { result.output.model = 'other-model'; }],
    ['missing served-model telemetry', (result) => { result.output.servedModel = null; }],
    ['different served model', (result) => { result.output.servedModel = 'provider-resolved-alias'; }],
    ['wrong profile', (result) => { result.output.voiceProfileVersion = 'other-profile'; }],
    ['claimed missing information', (result) => { result.output.parsed.missingInfo = 'needs review'; }],
  ])('a negative leg fails on %s', (_label, mutate) => {
    const fixture = loadGratitudeExam().exam.fixtures.find(row => row.id === 'negative_question');
    const exam = { schemaVersion: 'sms-gratitude-exam.v1', baselineContext: {}, fixtures: [fixture] };
    const results = LEGS.map(leg => passingResult(fixture, leg));
    mutate(results[0]);

    expect(gradeGratitudeResults({ exam, results, pins: PINS, legs: LEGS }))
      .toMatchObject({ qualified: false, reason: 'false_positive' });
  });

  test('negative abstention still requires the verifier feature to be enabled', () => {
    const fixture = loadGratitudeExam().exam.fixtures.find(row => row.id === 'negative_question');
    const exam = { schemaVersion: 'sms-gratitude-exam.v1', baselineContext: {}, fixtures: [fixture] };
    const pins = { ...PINS, verifier: { enabled: false } };

    expect(gradeGratitudeResults({ exam, results: LEGS.map(leg => passingResult(fixture, leg)), pins, legs: LEGS }))
      .toMatchObject({ qualified: false, reason: 'false_positive' });
  });

  test.each([undefined, {}, { model: '' }, { model: '   ' }])(
    'an absent or empty model pin cannot qualify matching incomplete output: %j', (route) => {
      const { exam } = loadGratitudeExam();
      const pins = clone(PINS);
      pins.routes.anthropic = route;
      const results = passingResults(exam);
      for (const result of results.filter(row => row.leg === 'anthropic')) {
        result.output.model = route?.model;
      }
      expect(gradeGratitudeResults({ exam, results, pins, legs: LEGS }))
        .toMatchObject({ qualified: false, reason: 'positive_failed' });
    },
  );

  test('every class gets the same approved copy and only factual source flags', () => {
    const { exam } = loadGratitudeExam();
    const inputs = new Map(exam.fixtures.map(fixture => [fixture.id, buildGratitudeExamInput(exam, fixture)]));

    expect(new Set([...inputs.values()].map(input => input.approvedReply))).toEqual(new Set(['Our pleasure, Casey!']));
    for (const input of inputs.values()) {
      expect(Object.keys(input).sort()).toEqual(['approvedReply', 'context', 'inboundMessage']);
      expect(JSON.stringify(input)).not.toMatch(/expectedEligible|"eligible"|"reason"|fixture_policy|false_positive/);
    }
    expect(inputs.get('positive_report').context.flags).toEqual([]);
    expect(inputs.get('negative_media').context.flags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'sms_media', severity: 'high' })]));
    expect(inputs.get('negative_missing_context').context.flags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'sms_context', severity: 'high' })]));
    expect(inputs.get('negative_pending_work').context.flags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'sms_pending_work', severity: 'high' })]));
    expect(inputs.get('negative_new_inbound').context.flags)
      .toEqual(expect.arrayContaining([expect.objectContaining({ type: 'sms_thread_activity', severity: 'high' })]));
  });
});
