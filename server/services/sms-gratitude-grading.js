'use strict';

// Pure, synthetic-only fixture and grading contract for gratitude
// qualification. This module performs no database, model, or provider work.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { buildGratitudeReply, evaluateGratitudeContext } = require('./sms-gratitude');

const FIXTURE_PATH = path.join(__dirname, '..', 'config', 'sms-gratitude-exam.json');

function loadGratitudeExam() {
  const raw = fs.readFileSync(FIXTURE_PATH);
  const exam = JSON.parse(raw.toString('utf8'));
  if (exam?.schemaVersion !== 'sms-gratitude-exam.v1'
      || !exam.baselineContext || !Array.isArray(exam.fixtures) || !exam.fixtures.length) {
    throw new Error('invalid_gratitude_exam');
  }
  const ids = new Set();
  for (const fixture of exam.fixtures) {
    if (!fixture?.id || ids.has(fixture.id) || typeof fixture.expectedEligible !== 'boolean'
        || !fixture.source?.inbound || !Array.isArray(fixture.source.history)) {
      throw new Error('invalid_gratitude_fixture');
    }
    ids.add(fixture.id);
  }
  return {
    exam,
    fixtureSha256: crypto.createHash('sha256').update(raw).digest('hex'),
  };
}

function buildGratitudeExamInput(exam, fixture) {
  const { inbound, history, contextComplete, pendingWork } = fixture.source;
  const smsHistory = [inbound, ...history]
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(row => ({ direction: row.direction, body: row.body }));
  const flags = [...(exam.baselineContext.flags || [])];
  if (inbound.mediaCount !== 0) {
    flags.push({ severity: 'high', type: 'sms_media', detail: Number.isInteger(inbound.mediaCount)
      ? `Latest inbound SMS has ${inbound.mediaCount} media attachment(s).`
      : 'Latest inbound SMS media count is unavailable.' });
  }
  if (contextComplete !== true) {
    flags.push({ severity: 'high', type: 'sms_context', detail: 'The recent SMS context read is incomplete.' });
  }
  if (pendingWork !== false) {
    flags.push({ severity: 'high', type: 'sms_pending_work', detail: 'Pending work exists for this SMS conversation.' });
  }
  const inboundAt = new Date(inbound.createdAt).getTime();
  const later = history.filter(row => new Date(row.createdAt).getTime() >= inboundAt);
  if (Number.isFinite(inboundAt) && later.length) {
    flags.push({ severity: 'high', type: 'sms_thread_activity',
      detail: `${later.length} SMS message(s) arrived at or after the candidate inbound.` });
  }
  return {
    context: { ...exam.baselineContext, flags, smsHistory },
    inboundMessage: inbound.body,
    approvedReply: buildGratitudeReply(fixture.source.firstName),
  };
}

function pairPasses({ fixture, leg, result, pins }) {
  const policy = evaluateGratitudeContext(fixture.source);
  const output = Object(Object(result).output);
  const parsed = Object(output.parsed);
  const pinSet = Object(pins);
  const route = Object(Object(pinSet.routes)[leg]);
  const verifier = Object(pinSet.verifier);
  const verifierModels = Array.isArray(output.verifierModels) ? output.verifierModels : [];
  const replyMatches = fixture.expectedEligible
    ? parsed.reply === policy.reply
    : parsed.reply === '';
  const checks = {
    policyMatchesFixture: policy.eligible === fixture.expectedEligible,
    replyMatches,
    actionsRawSafe: parsed.actionsRawSafe === true
      && Array.isArray(parsed.intendedActions)
      && parsed.intendedActions.every(action => Object(action).type === 'none'),
    verifierEnabled: verifier.enabled === true,
    verifierRouteCurrent: !fixture.expectedEligible
      || (typeof verifier.model === 'string' && verifier.model.trim().length > 0
        && verifierModels.length > 0
        && verifierModels.every(model => model === verifier.model)),
    converged: output.converged === true && Number(output.passes) >= 1,
    currentModel: typeof route.model === 'string' && route.model.trim().length > 0
      && output.model === route.model,
    servedModelCurrent: typeof route.model === 'string' && route.model.trim().length > 0
      && output.servedModel === route.model,
    profileCurrent: (output.voiceProfileVersion ?? null) === (pinSet.voiceProfileVersion ?? null),
    noMissingInfo: parsed.missingInfo == null || String(parsed.missingInfo).trim() === '',
  };
  return Object.values(checks).every(Boolean);
}

function gradeGratitudeResults({ exam, results, pins, legs }) {
  if (!Array.isArray(legs) || !legs.length) return { qualified: false, reason: 'result_set_invalid' };
  const expected = new Set(exam.fixtures.flatMap(fixture => legs.map(leg => `${fixture.id}\0${leg}`)));
  const byPair = new Map();
  for (const result of results || []) {
    const key = `${result?.fixtureId}\0${result?.leg}`;
    if (!expected.has(key) || byPair.has(key)) return { qualified: false, reason: 'result_set_invalid' };
    byPair.set(key, result);
  }
  if (byPair.size !== expected.size) return { qualified: false, reason: 'result_set_incomplete' };

  let positives = 0;
  let negatives = 0;
  for (const fixture of exam.fixtures) {
    if (evaluateGratitudeContext(fixture.source).eligible !== fixture.expectedEligible) {
      return { qualified: false, reason: 'fixture_policy_drift' };
    }
    for (const leg of legs) {
      const passed = pairPasses({ fixture, leg, result: byPair.get(`${fixture.id}\0${leg}`), pins });
      if (fixture.expectedEligible) {
        positives += 1;
        if (!passed) return { qualified: false, reason: 'positive_failed' };
      } else {
        negatives += 1;
        if (!passed) return { qualified: false, reason: 'false_positive' };
      }
    }
  }
  return { qualified: true, reason: 'qualified', positives, negatives };
}

module.exports = {
  loadGratitudeExam,
  buildGratitudeExamInput,
  gradeGratitudeResults,
};
