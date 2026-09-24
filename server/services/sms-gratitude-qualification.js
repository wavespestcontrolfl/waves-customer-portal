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
} = require('./sms-gratitude');
const {
  loadGratitudeExam,
  buildGratitudeExamInput,
  gradeGratitudeResults,
} = require('./sms-gratitude-grading');
const { LIVE_EXAM_LEGS, EXAM_LEG_ROUTES } = require('./sms-sealed-eval');
const { runAsReplay } = require('./llm-dispatch-metrics');

const WORKFLOW = 'sms_gratitude_qualification';
const AGENT_NAME = 'sms-gratitude-qualification';
const DECISION_VERSION = 'v1';
const RUN_LOCK_KEY = 2026092401;
const RUN_STALE_MS = 6 * 60 * 60 * 1000;
const SOURCE_FILES = Object.freeze([
  'server/services/sms-gratitude.js',
  'server/services/sms-gratitude-grading.js',
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

function sourceSha256() {
  const hash = crypto.createHash('sha256');
  for (const relative of SOURCE_FILES) {
    hash.update(relative).update('\0').update(fs.readFileSync(path.join(ROOT, relative))).update('\0');
  }
  return hash.digest('hex');
}

async function readCurrent({ dbi }) {
  const { fixtureSha256 } = loadGratitudeExam();
  const verifierFallbackModel = MODELS.TEXT_POLICIES?.deepAnalysis?.fallback?.model;
  if (!drafter.PROMPT_VERSION || typeof drafter.VERIFY_ENABLED !== 'boolean'
      || !Number.isInteger(drafter.MAX_REVISIONS) || drafter.MAX_REVISIONS < 0
      || !verifier.VERIFIER_MODEL || !verifierFallbackModel) {
    throw new Error('invalid_gratitude_qualification_config');
  }
  const voiceProfile = await drafter.resolveEffectiveVoiceProfile({ dbi });
  const renderedPrompt = drafter.buildSystemPromptWithProfile(voiceProfile?.profile_text || '');
  if (!renderedPrompt?.system) throw new Error('invalid_gratitude_system_prompt');
  const appliedVoiceProfile = renderedPrompt.applied === true ? voiceProfile : null;
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
      fallbackModel: verifierFallbackModel,
    },
    systemPromptSha256: sha256(renderedPrompt.system),
    voiceProfileVersion: appliedVoiceProfile?.version ?? null,
    voiceProfileTextSha256: appliedVoiceProfile
      ? sha256(String(appliedVoiceProfile.profile_text || '')) : null,
    sourceSha256: sourceSha256(),
    sourceFiles: [...SOURCE_FILES],
  };
  return {
    pins,
    voiceProfile: appliedVoiceProfile
      ? { version: appliedVoiceProfile.version, profile_text: String(appliedVoiceProfile.profile_text || '') }
      : null,
  };
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
    servedModel: typeof output.servedModel === 'string' ? output.servedModel : null,
    verifierModels: Array.isArray(output.verifierModels) ? [...output.verifierModels] : [],
    voiceProfileVersion: output.voiceProfileVersion ?? null,
  };
}

async function createGratitudeQualification({ dbi = db, triggeredBy = null } = {}) {
  if (typeof dbi.transaction !== 'function') throw new Error('gratitude_qualification_transaction_required');
  return dbi.transaction(async (trx) => {
    await trx.raw('SELECT pg_advisory_xact_lock(?)', [RUN_LOCK_KEY]);
    const prior = await trx('agent_decisions').where({ workflow: WORKFLOW })
      .orderBy('created_at', 'desc').first('id', 'input_snapshot', 'created_at');
    const priorSnapshot = parseSnapshot(prior?.input_snapshot);
    if (priorSnapshot?.state === 'running') {
      const executionToken = priorSnapshot.executionToken;
      const hasExecutionClaim = executionToken != null;
      const progressAt = new Date(hasExecutionClaim
        ? priorSnapshot.executionStartedAt : prior.created_at).getTime();
      const runInProgress = (message = 'a gratitude qualification run is already in progress') => {
        const error = new Error(message);
        error.code = 'RUN_IN_PROGRESS';
        error.runId = prior.id;
        return error;
      };
      if (!Number.isFinite(progressAt) || Date.now() - progressAt <= RUN_STALE_MS) {
        throw runInProgress();
      }
      if (hasExecutionClaim) {
        let leaseHeld = null;
        try {
          const { lockHeldByAnySession } = require('../utils/cron-lock');
          leaseHeld = await lockHeldByAnySession(`sms-gratitude-qualification:${prior.id}`, trx);
        } catch { /* an unknown lease state must fail closed */ }
        if (leaseHeld !== false) throw runInProgress();
      }
      let recoveryQuery = trx('agent_decisions').where({ id: prior.id, workflow: WORKFLOW })
        .whereRaw("input_snapshot->>'state' = 'running'");
      if (hasExecutionClaim) {
        recoveryQuery = recoveryQuery
          .whereRaw("input_snapshot->>'executionToken' = ?", [executionToken])
          .whereRaw("input_snapshot->>'executionStartedAt' = ?", [priorSnapshot.executionStartedAt]);
      } else {
        recoveryQuery = recoveryQuery.whereRaw("input_snapshot->>'executionToken' IS NULL");
      }
      const recovered = await recoveryQuery.update({
        input_snapshot: JSON.stringify({
          ...priorSnapshot,
          state: 'failed',
          results: [],
          failure: 'stale_run_recovered',
        }),
        status: 'failed',
        correction_note: 'stale_run_recovered',
        updated_at: trx.fn.now(),
      });
      if (recovered !== 1) {
        const latest = await trx('agent_decisions').where({ id: prior.id, workflow: WORKFLOW })
          .first('id', 'input_snapshot');
        const error = runInProgress('gratitude qualification run changed during stale recovery');
        error.state = parseSnapshot(latest?.input_snapshot)?.state || 'missing';
        throw error;
      }
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
      status: 'initiated',
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
  let active = initial;
  const executionToken = crypto.randomUUID();

  try {
    const { runExclusive, wasLockSkipped } = require('../utils/cron-lock');
    const outcome = await runExclusive(`sms-gratitude-qualification:${runId}`, async () => {
      const durable = await dbi('agent_decisions').where({ id: runId, workflow: WORKFLOW })
        .first('id', 'input_snapshot');
      active = parseSnapshot(durable?.input_snapshot);
      if (!durable || active?.state !== 'running' || !active.pins) {
        return { id: runId, state: active?.state || 'missing', skipped: true, reason: 'run_not_running' };
      }
      const executing = { ...active, executionToken, executionStartedAt: new Date().toISOString() };
      active = executing;
      const claimed = await dbi('agent_decisions').where({ id: runId, workflow: WORKFLOW })
        .whereRaw("input_snapshot->>'state' = 'running'")
        .whereRaw("input_snapshot->>'executionToken' IS NULL")
        .update({ input_snapshot: JSON.stringify(executing), updated_at: dbi.fn.now() });
      if (claimed !== 1) {
        const latest = await dbi('agent_decisions').where({ id: runId, workflow: WORKFLOW })
          .first('id', 'input_snapshot');
        active = parseSnapshot(latest?.input_snapshot);
        return { id: runId, state: active?.state || 'missing', skipped: true, reason: 'run_not_running' };
      }
      const current = await readCurrent({ dbi });
      if (!same(active.pins, current.pins)
          || !same(active.frozenVoiceProfile, current.voiceProfile)
          || current.pins.verifier.enabled !== true) {
        throw new Error('gratitude_qualification_pins_changed');
      }
      const { exam } = loadGratitudeExam();
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const results = await runAsReplay(async () => {
        const modelResults = [];
        for (const fixture of exam.fixtures) {
          const examInput = buildGratitudeExamInput(exam, fixture);
          for (const leg of LIVE_EXAM_LEGS) {
            const generated = await drafter.generateGroundedDraft({
              client,
              context: examInput.context,
              inboundMessage: examInput.inboundMessage,
              intent: { intent: GRATITUDE_INTENT, confidence: 1,
                approvedReply: examInput.approvedReply },
              schedulingIntent: false,
              routeOverride: EXAM_LEG_ROUTES[leg],
              voiceProfile: active.frozenVoiceProfile,
              metricsLane: 'sealed',
              laneId: 'sealed_eval',
            });
            if (!generated?.parsed) throw new Error('gratitude_qualification_draft_failed');
            modelResults.push({
              fixtureId: fixture.id,
              leg,
              output: outputShape(generated),
            });
          }
        }
        return modelResults;
      });
      const graded = gradeGratitudeResults({ exam, results, pins: current.pins, legs: LIVE_EXAM_LEGS });
      const complete = { ...active, state: 'complete', results, summary: graded };
      const updated = await dbi('agent_decisions').where({ id: runId, workflow: WORKFLOW })
        .whereRaw("input_snapshot->>'state' = 'running'")
        .whereRaw("input_snapshot->>'executionToken' = ?", [executionToken])
        .update({
          input_snapshot: JSON.stringify(complete),
          status: graded.qualified ? 'shadow' : 'qualification_failed',
          correction_note: graded.qualified ? null : graded.reason,
          updated_at: dbi.fn.now(),
        });
      if (updated !== 1) throw new Error('gratitude_qualification_run_superseded');
      return { id: runId, state: 'complete', results: results.length, ...graded };
    }, { recordHealth: false });
    if (wasLockSkipped(outcome)) {
      // Another invocation holds this job. A duplicate must not fail its
      // durable row while the owning runner is still in flight.
      if (outcome.reason === 'lease_held') return outcome;
      throw new Error(`gratitude_qualification_lock_${outcome.reason}`);
    }
    return outcome;
  } catch (error) {
    const failed = {
      ...active,
      state: 'failed',
      results: [],
      failure: String(error?.message || 'qualification_failed').slice(0, 200),
    };
    try {
      const failureUpdate = dbi('agent_decisions').where({ id: runId, workflow: WORKFLOW })
        .whereRaw("input_snapshot->>'state' = 'running'")
        .whereRaw("(input_snapshot->>'executionToken' IS NULL OR input_snapshot->>'executionToken' = ?)", [executionToken]);
      await failureUpdate.update({
        input_snapshot: JSON.stringify(failed),
        status: 'failed',
        correction_note: failed.failure,
        updated_at: dbi.fn.now(),
      });
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

    const graded = gradeGratitudeResults({
      exam: loadGratitudeExam().exam,
      results: snapshot.results,
      pins: current.pins,
      legs: LIVE_EXAM_LEGS,
    });
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
