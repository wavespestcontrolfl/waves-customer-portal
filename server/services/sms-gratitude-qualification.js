'use strict';

// Manual, synthetic-only qualification for the disabled gratitude lane.
// Results live in the shared decision ledger but cannot enter a draft/send path.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../models/db');
const MODELS = require('../config/models');
const drafter = require('./sms-shadow-drafter');
const verifier = require('./sms-draft-verifier');
const {
  GRATITUDE_INTENT,
  GRATITUDE_POLICY_VERSION,
  evaluateGratitudeContext,
} = require('./sms-gratitude');
const { LIVE_EXAM_LEGS, EXAM_LEG_ROUTES } = require('./sms-sealed-eval');
const { runAsReplay } = require('./llm-dispatch-metrics');

const WORKFLOW = 'sms_gratitude_qualification';
const AGENT_NAME = 'sms-gratitude-qualification';
const DECISION_VERSION = 'v1';
const RUN_LOCK_KEY = 2026092401;
const RUN_STALE_MS = 6 * 60 * 60 * 1000;
const FIXTURE_PATH = path.join(__dirname, '..', 'config', 'sms-gratitude-exam.json');
const SOURCE_FILES = Object.freeze([
  'server/services/sms-gratitude.js',
  'server/services/sms-gratitude-context.js',
  'server/services/sms-response-policy.js',
  'server/utils/phone.js',
  'server/services/sms-suggest-mode.js',
  'server/services/sms-intent.js',
  'server/services/context-aggregator.js',
  'server/services/sms-auto-send.js',
  'server/services/sms-shadow-drafter.js',
  'server/services/sms-draft-verifier.js',
  'server/services/llm/call.js',
  'server/services/llm/deep.js',
  'server/services/sms-sealed-eval.js',
  'server/services/sms-gratitude-qualification.js',
  'server/config/models.js',
]);
const ROOT = path.join(__dirname, '..', '..');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function parseSnapshot(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
}

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function same(left, right) {
  return stable(left) === stable(right);
}

function loadExam() {
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
  return { exam, fixtureSha256: sha256(raw) };
}

function sourceSha256() {
  const hash = crypto.createHash('sha256');
  for (const relative of SOURCE_FILES) {
    hash.update(relative).update('\0').update(fs.readFileSync(path.join(ROOT, relative))).update('\0');
  }
  return hash.digest('hex');
}

async function readCurrent({ dbi }) {
  const { fixtureSha256 } = loadExam();
  if (!drafter.PROMPT_VERSION || typeof drafter.VERIFY_ENABLED !== 'boolean'
      || !Number.isInteger(drafter.MAX_REVISIONS) || drafter.MAX_REVISIONS < 0
      || !verifier.VERIFIER_MODEL || !MODELS.FLAGSHIP) {
    throw new Error('invalid_gratitude_qualification_config');
  }
  const voiceProfile = await drafter.resolveEffectiveVoiceProfile({ dbi });
  const renderedPrompt = drafter.buildSystemPromptWithProfile(voiceProfile?.profile_text || '');
  if (!renderedPrompt?.system) throw new Error('invalid_gratitude_system_prompt');
  const routes = Object.fromEntries(LIVE_EXAM_LEGS.map((leg) => {
    const route = EXAM_LEG_ROUTES[leg];
    if (!route?.provider || !route.model) throw new Error('invalid_gratitude_route');
    return [leg, { provider: route.provider, model: route.model }];
  }));
  const pins = {
    policyVersion: GRATITUDE_POLICY_VERSION,
    fixtureSha256,
    promptVersion: drafter.PROMPT_VERSION,
    routes,
    verifier: {
      enabled: drafter.VERIFY_ENABLED === true,
      maxRevisions: drafter.MAX_REVISIONS,
      model: verifier.VERIFIER_MODEL,
      fallbackModel: MODELS.FLAGSHIP,
    },
    systemPromptSha256: sha256(renderedPrompt.system),
    voiceProfileVersion: voiceProfile?.version ?? null,
    voiceProfileTextSha256: voiceProfile ? sha256(String(voiceProfile.profile_text || '')) : null,
    sourceSha256: sourceSha256(),
    sourceFiles: [...SOURCE_FILES],
  };
  return {
    pins,
    voiceProfile: voiceProfile
      ? { version: voiceProfile.version, profile_text: String(voiceProfile.profile_text || '') }
      : null,
  };
}

function frozenContext(exam, fixture) {
  const thread = [fixture.source.inbound, ...fixture.source.history]
    .slice()
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .map(row => ({ direction: row.direction, body: row.body }));
  return { ...exam.baselineContext, smsHistory: thread };
}

function outputShape(output) {
  return {
    parsed: output.parsed ? {
      reply: output.parsed.reply,
      intendedActions: output.parsed.intended_actions,
      actionsRawSafe: output.parsed.auto_send_safe === true,
      missingInfo: output.parsed.missing_info,
    } : null,
    passes: output.passes,
    converged: output.converged === true,
    model: output.model,
    voiceProfileVersion: output.voiceProfileVersion ?? null,
  };
}

function evaluatePair({ fixture, leg, result, pins }) {
  const policy = evaluateGratitudeContext(fixture.source);
  const output = result?.output;
  const parsed = output?.parsed;
  const route = pins.routes[leg];
  const checks = {
    policyEligible: policy.eligible === true,
    exactFixedCopy: Boolean(policy.reply) && parsed?.reply === policy.reply,
    actionsRawSafe: parsed?.actionsRawSafe === true
      && Array.isArray(parsed.intendedActions)
      && parsed.intendedActions.every(action => action?.type === 'none'),
    verified: pins.verifier.enabled === true && Boolean(parsed?.reply),
    converged: output?.converged === true && Number(output?.passes) >= 1,
    currentModel: output?.model === route?.model,
    profileCurrent: (output?.voiceProfileVersion ?? null) === (pins.voiceProfileVersion ?? null),
    noMissingInfo: parsed?.missingInfo == null || String(parsed.missingInfo).trim() === '',
  };
  return {
    policy,
    checks,
    eligible: Object.values(checks).every(Boolean),
  };
}

function gradeResults(exam, results, pins) {
  const expected = new Set(exam.fixtures.flatMap(fixture => LIVE_EXAM_LEGS.map(leg => `${fixture.id}\0${leg}`)));
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
    const currentPolicy = evaluateGratitudeContext(fixture.source);
    if (currentPolicy.eligible !== fixture.expectedEligible) {
      return { qualified: false, reason: 'fixture_policy_drift' };
    }
    for (const leg of LIVE_EXAM_LEGS) {
      const evaluated = evaluatePair({ fixture, leg, result: byPair.get(`${fixture.id}\0${leg}`), pins });
      if (fixture.expectedEligible) {
        positives += 1;
        if (!evaluated.eligible) return { qualified: false, reason: 'positive_failed' };
      } else {
        negatives += 1;
        if (evaluated.eligible) return { qualified: false, reason: 'false_positive' };
      }
    }
  }
  return { qualified: true, reason: 'qualified', positives, negatives };
}

async function createGratitudeQualification({ dbi = db, triggeredBy = null } = {}) {
  if (typeof dbi.transaction !== 'function') throw new Error('gratitude_qualification_transaction_required');
  return dbi.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [RUN_LOCK_KEY]);
    const prior = await trx('agent_decisions').where({ workflow: WORKFLOW })
      .orderBy('created_at', 'desc').first('id', 'input_snapshot', 'created_at');
    const priorSnapshot = parseSnapshot(prior?.input_snapshot);
    if (priorSnapshot?.state === 'running') {
      const created = new Date(prior.created_at).getTime();
      if (!Number.isFinite(created) || Date.now() - created <= RUN_STALE_MS) {
        const error = new Error('a gratitude qualification run is already in progress');
        error.code = 'RUN_IN_PROGRESS';
        error.runId = prior.id;
        throw error;
      }
      await trx('agent_decisions').where({ id: prior.id, workflow: WORKFLOW }).update({
        input_snapshot: JSON.stringify({
          ...priorSnapshot,
          state: 'failed',
          results: [],
          failure: 'stale_run_recovered',
        }),
        updated_at: trx.fn.now(),
      });
    }

    const current = await readCurrent({ dbi: trx });
    const snapshot = {
      state: 'running',
      triggeredBy: typeof triggeredBy === 'string' ? triggeredBy.slice(0, 100) : null,
      pins: current.pins,
      frozenVoiceProfile: current.voiceProfile,
      results: [],
    };
    const [row] = await trx('agent_decisions').insert({
      workflow: WORKFLOW,
      agent_name: AGENT_NAME,
      decision_version: DECISION_VERSION,
      mode: 'shadow',
      status: 'shadow',
      input_snapshot: JSON.stringify(snapshot),
      reasoning_summary: 'Synthetic gratitude qualification run; no customer or send-path linkage.',
      prompt_version: current.pins.promptVersion,
    }).returning(['id', 'created_at']);
    if (!row?.id) throw new Error('gratitude_qualification_create_failed');
    return { id: row.id, state: 'running', pins: current.pins };
  });
}

async function runGratitudeQualification({ dbi = db, runId } = {}) {
  if (!runId) throw new Error('gratitude_qualification_run_id_required');
  const row = await dbi('agent_decisions').where({ id: runId, workflow: WORKFLOW }).first('id', 'input_snapshot');
  const initial = parseSnapshot(row?.input_snapshot);
  if (!row || initial?.state !== 'running' || !initial.pins) throw new Error('gratitude_qualification_not_runnable');

  try {
    const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
    const outcome = await runExclusive('sms-gratitude-qualification', async () => {
      const current = await readCurrent({ dbi });
      if (!same(initial.pins, current.pins)
          || !same(initial.frozenVoiceProfile, current.voiceProfile)
          || current.pins.verifier.enabled !== true) {
        throw new Error('gratitude_qualification_pins_changed');
      }
      const { exam } = loadExam();
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const results = await runAsReplay(async () => {
        const modelResults = [];
        for (const fixture of exam.fixtures) {
          const policy = evaluateGratitudeContext(fixture.source);
          for (const leg of LIVE_EXAM_LEGS) {
            const generated = await drafter.generateGroundedDraft({
              client,
              context: frozenContext(exam, fixture),
              inboundMessage: fixture.source.inbound.body,
              intent: { intent: GRATITUDE_INTENT, confidence: 1, approvedReply: policy.reply },
              schedulingIntent: false,
              routeOverride: EXAM_LEG_ROUTES[leg],
              voiceProfile: initial.frozenVoiceProfile,
              metricsLane: 'sealed',
              laneId: 'sealed_eval',
            });
            if (!generated?.parsed) throw new Error('gratitude_qualification_draft_failed');
            modelResults.push({
              fixtureId: fixture.id,
              leg,
              policy: { eligible: policy.eligible, reason: policy.reason, reply: policy.reply },
              output: outputShape(generated),
            });
          }
        }
        return modelResults;
      });
      const complete = { ...initial, state: 'complete', results };
      const updated = await dbi('agent_decisions').where({ id: runId, workflow: WORKFLOW })
        .whereRaw("input_snapshot->>'state' = 'running'")
        .update({ input_snapshot: JSON.stringify(complete), updated_at: dbi.fn.now() });
      if (updated !== 1) throw new Error('gratitude_qualification_run_superseded');
      return { id: runId, state: 'complete', results: results.length };
    }, { recordHealth: false });
    if (wasLockSkipped(outcome)) {
      throw new Error(`gratitude_qualification_lock_${outcome.reason}`);
    }
    return outcome;
  } catch (error) {
    const failed = {
      ...initial,
      state: 'failed',
      results: [],
      failure: String(error?.message || 'qualification_failed').slice(0, 200),
    };
    try {
      await dbi('agent_decisions').where({ id: runId, workflow: WORKFLOW })
        .whereRaw("input_snapshot->>'state' = 'running'")
        .update({ input_snapshot: JSON.stringify(failed), updated_at: dbi.fn.now() });
    } catch { /* the original failure remains authoritative */ }
    throw error;
  }
}

async function evaluateGratitudeQualification({ dbi = db, voiceProfileVersion } = {}) {
  const verdict = (qualified, reason, extra = {}) => ({
    eligible: qualified,
    blockers: qualified ? [] : [`Gratitude qualification blocked: ${String(reason).replaceAll('_', ' ')}.`],
    basis: 'fixed_copy_exam',
    qualified,
    reason,
    ...extra,
  });
  try {
    const row = await dbi('agent_decisions').where({ workflow: WORKFLOW })
      .orderBy('created_at', 'desc').first('id', 'input_snapshot', 'created_at');
    const snapshot = parseSnapshot(row?.input_snapshot);
    if (!snapshot || snapshot.state !== 'complete') return verdict(false, snapshot?.state || 'no_complete_run');
    const current = await readCurrent({ dbi });
    if (!same(snapshot.pins, current.pins)) return verdict(false, 'pins_changed', { runId: row.id });
    if (voiceProfileVersion !== undefined
        && (voiceProfileVersion ?? null) !== (current.pins.voiceProfileVersion ?? null)) {
      return verdict(false, 'voice_profile_changed', { runId: row.id });
    }

    const graded = gradeResults(loadExam().exam, snapshot.results, current.pins);
    return verdict(graded.qualified, graded.reason, { runId: row.id, ...graded });
  } catch {
    return verdict(false, 'qualification_unavailable');
  }
}

module.exports = {
  createGratitudeQualification,
  runGratitudeQualification,
  evaluateGratitudeQualification,
  WORKFLOW,
};
