/**
 * SMS Sealed Eval — a locked exam for the house-voice drafter.
 *
 * The live judge measures the drafter on the same traffic the prompt is
 * iterated against, and at ~9 scored texts/week a new PROMPT_VERSION takes
 * months to accumulate evidence. This module fixes both:
 *
 *   - SEAL (freezer): select up to SEALED_EVAL_TARGET judged live drafts and
 *     freeze the (inbound, day-of facts_block, human reply) triple into
 *     sms_sealed_eval_items. Items are never edited after insert and are
 *     excluded from few-shot exemplar retrieval (sms-shadow-drafter), so the
 *     drafter can never study from the exam's answer key. Selection requires
 *     a NON-backfill source draft: backfill rows carry today's facts on old
 *     inbounds (drift), and a drift-contaminated snapshot would grade every
 *     future version against facts the customer's question never had.
 *   - EXAM (runner): replay every active item through the CURRENT drafter —
 *     same system prompt, verify/revise loop, and few-shot path as live —
 *     with the provider pinned to one leg ('anthropic' | 'openai'), then
 *     grade each draft with the exact live judge (sms-shadow-judge.judgeOne)
 *     against the frozen human reply and frozen facts. Results live ONLY in
 *     sms_sealed_eval_results — never message_drafts — so exam replays can
 *     never contaminate live judge/graduation cohorts or reach a send path.
 *   - SIGNIFICANCE: a completed run is compared to its baseline run (same
 *     leg, usually the prior PROMPT_VERSION) item-by-item with McNemar's
 *     exact test on the draft_unsafe indicator — deterministic code decides
 *     "real improvement or luck", not eyeballed rate deltas.
 *
 * Per-provider legs exist because prompts tuned on one model don't
 * automatically transfer (the live default SMS lane is OpenAI-primary while
 * save-the-sale drafts on Claude — both legs matter).
 *
 * Spend: one exam run ≈ items × (draft gens + 1 judge call). Runs are
 * MANUAL-TRIGGER ONLY (admin endpoint / script) — never a cron. The weekly
 * cron only tops up the sealed item pool (pure selection, no LLM).
 *
 * PII: items/results carry raw bodies like message_drafts (same
 * internal-ops posture). Never log message bodies from this module.
 */

const db = require('../models/db');
const logger = require('./logger');
const MODELS = require('../config/models');

const SCHEMA_VERSION = 'sms-sealed-eval.v1';

const envNum = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
};

// Pool size the freezer tops up to; items must be this old before sealing so
// the human-reply pairing has matured (mirrors the judge's eligibility delay,
// with margin for late corrections).
const SEALED_EVAL_TARGET = envNum('SEALED_EVAL_TARGET', 100);
const SEALED_EVAL_MIN_AGE_DAYS = envNum('SEALED_EVAL_MIN_AGE_DAYS', 7);
// Two-sided alpha for the paired significance verdict.
const SIGNIFICANCE_ALPHA = envNum('SEALED_EVAL_ALPHA', 0.05);
// Bail out of a run after this many CONSECUTIVE item failures — a pinned leg
// has no fallback, so a provider outage would otherwise burn through every
// item producing nothing.
const MAX_CONSECUTIVE_FAILURES = envNum('SEALED_EVAL_MAX_CONSEC_FAILURES', 5);

// The two exam legs. Models come from the central registry — the anthropic
// leg is the live save-the-sale/tone model, the openai leg is the live
// default-draft model, so each leg examines the provider exactly as the live
// router would use it.
const EXAM_LEG_ROUTES = Object.freeze({
  anthropic: Object.freeze({ provider: MODELS.PROVIDER.ANTHROPIC, model: MODELS.SMS_SONNET }),
  openai: Object.freeze({ provider: MODELS.PROVIDER.OPENAI, model: MODELS.OPENAI_SMS_DRAFT }),
});
const EXAM_LEGS = Object.freeze(Object.keys(EXAM_LEG_ROUTES));

/* ── Freezer ──────────────────────────────────────────────────────────── */

/**
 * Top up the sealed item pool to `target`. Pure selection — no LLM spend.
 * Idempotent: the anti-join + UNIQUE(source_draft_id) make re-runs no-ops
 * once the pool is full. Items are stratified round-robin by intent (most
 * recent first within each intent) so one chatty intent can't crowd out the
 * exam's coverage of the others.
 */
async function sealEvalItems({ target = SEALED_EVAL_TARGET, dbi = db } = {}) {
  const startedAt = Date.now();
  const [{ count: activeCount }] = await dbi('sms_sealed_eval_items')
    .where('active', true)
    .count('* as count');
  const remaining = target - Number(activeCount);
  if (remaining <= 0) {
    return { sealed: 0, activeCount: Number(activeCount), ms: Date.now() - startedAt };
  }

  const cutoff = new Date(Date.now() - SEALED_EVAL_MIN_AGE_DAYS * 86400 * 1000);
  const candidates = await dbi({ md: 'message_drafts' })
    .join({ j: 'shadow_draft_judgments' }, 'j.draft_id', 'md.id')
    .leftJoin({ si: 'sms_sealed_eval_items' }, 'si.source_draft_id', 'md.id')
    .leftJoin({ inbound_sms: 'sms_log' }, 'md.sms_log_id', 'inbound_sms.id')
    .whereNull('si.id')
    // Ground truth must exist: the human actually replied, with real text.
    .where('j.human_replied', true)
    .whereRaw("TRIM(COALESCE(j.human_reply_text, '')) <> ''")
    // The day-of snapshot must exist (v8+ drafts persist facts_block)...
    .whereRaw("TRIM(COALESCE(md.facts_block, '')) <> ''")
    // ...and must NOT be a backfill row: backfill facts are TODAY's context
    // pasted onto a months-old inbound — sealing one would freeze the drift.
    .whereRaw("md.prompt_version NOT LIKE '%backfill'")
    .whereRaw("TRIM(COALESCE(md.inbound_message, '')) <> ''")
    .where('md.created_at', '<', cutoff)
    .select(
      'md.id as source_draft_id', 'md.customer_id', 'md.intent',
      'md.inbound_message', 'md.facts_block', 'md.context_summary',
      'md.scheduling_intent', 'md.created_at',
      'j.human_reply_text', 'j.human_reply_sms_id',
      'inbound_sms.created_at as inbound_at'
    )
    .orderBy('md.created_at', 'desc');

  // Stratify: round-robin across intents, newest first within each.
  const byIntent = new Map();
  for (const c of candidates) {
    const key = c.intent || 'GENERAL';
    if (!byIntent.has(key)) byIntent.set(key, []);
    byIntent.get(key).push(c);
  }
  const picked = [];
  const queues = [...byIntent.values()];
  while (picked.length < remaining && queues.some((q) => q.length)) {
    for (const q of queues) {
      if (picked.length >= remaining) break;
      const next = q.shift();
      if (next) picked.push(next);
    }
  }

  if (!picked.length) {
    logger.info('[sealed-eval] seal: no new eligible candidates');
    return { sealed: 0, activeCount: Number(activeCount), ms: Date.now() - startedAt };
  }

  const rows = picked.map((c) => ({
    source_draft_id: c.source_draft_id,
    customer_id: c.customer_id || null,
    intent: c.intent || 'GENERAL',
    inbound_message: c.inbound_message,
    facts_block: c.facts_block,
    context_summary: c.context_summary || null,
    human_reply_text: c.human_reply_text,
    human_reply_sms_id: c.human_reply_sms_id || null,
    scheduling_intent: Boolean(c.scheduling_intent),
    inbound_at: c.inbound_at || c.created_at || null,
    schema_version: SCHEMA_VERSION,
  }));
  await dbi('sms_sealed_eval_items').insert(rows).onConflict('source_draft_id').ignore();

  const summary = { sealed: rows.length, activeCount: Number(activeCount) + rows.length, ms: Date.now() - startedAt };
  logger.info(`[sealed-eval] seal complete: ${JSON.stringify(summary)}`);
  return summary;
}

/* ── Significance (pure, deterministic) ───────────────────────────────── */

// Binomial(n, 1/2) PMF in log space — n is the discordant-pair count
// (typically well under the pool size), but log space keeps it exact-enough
// far past anything the exam can produce.
function binomHalfPmf(n, k) {
  let logC = 0;
  for (let i = 1; i <= k; i += 1) logC += Math.log(n - k + i) - Math.log(i);
  return Math.exp(logC - n * Math.LN2);
}

/**
 * McNemar's exact test (two-sided) on paired binary outcomes.
 *   b = pairs where the candidate is unsafe and the baseline was safe
 *   c = pairs where the candidate is safe and the baseline was unsafe
 * Returns the p-value for "the discordance is symmetric coin-flips".
 */
function mcNemarExact(b, c) {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  let cum = 0;
  for (let i = 0; i <= k; i += 1) cum += binomHalfPmf(n, i);
  return Math.min(1, 2 * cum);
}

function parseScores(scores) {
  if (!scores) return null;
  try {
    const s = typeof scores === 'string' ? JSON.parse(scores) : scores;
    return s && typeof s === 'object' ? s : null;
  } catch {
    return null;
  }
}

/**
 * Pure paired comparison of two runs' result rows over the SAME sealed items.
 * Unsafe indicator = verdict === 'draft_unsafe'. Items missing a verdict in
 * either run drop out (no imputation). Mean score deltas are informational —
 * the verdict-level McNemar decides significance.
 */
function computeSignificance({ candidateResults = [], baselineResults = [], alpha = SIGNIFICANCE_ALPHA } = {}) {
  const baseline = new Map(
    baselineResults.filter((r) => r && r.verdict).map((r) => [String(r.item_id), r])
  );
  let pairedItems = 0;
  let newlyUnsafe = 0; // b — candidate regressed on this item
  let newlySafe = 0; // c — candidate improved on this item
  const deltas = { safety: [], voice: [], overall: [] };

  for (const r of candidateResults) {
    if (!r || !r.verdict) continue;
    const base = baseline.get(String(r.item_id));
    if (!base) continue;
    pairedItems += 1;
    const candUnsafe = r.verdict === 'draft_unsafe';
    const baseUnsafe = base.verdict === 'draft_unsafe';
    if (candUnsafe && !baseUnsafe) newlyUnsafe += 1;
    if (!candUnsafe && baseUnsafe) newlySafe += 1;

    const cs = parseScores(r.scores);
    const bs = parseScores(base.scores);
    if (cs && bs) {
      for (const key of Object.keys(deltas)) {
        const dc = Number(cs[key]);
        const dbase = Number(bs[key]);
        if (Number.isFinite(dc) && Number.isFinite(dbase)) deltas[key].push(dc - dbase);
      }
    }
  }

  const pValue = mcNemarExact(newlyUnsafe, newlySafe);
  const direction = newlySafe > newlyUnsafe ? 'improved' : newlyUnsafe > newlySafe ? 'regressed' : 'equal';
  const mean = (arr) => (arr.length ? Number((arr.reduce((a, x) => a + x, 0) / arr.length).toFixed(2)) : null);
  return {
    method: 'mcnemar_exact',
    alpha,
    pairedItems,
    newlyUnsafe,
    newlySafe,
    pValue: Number(pValue.toFixed(4)),
    // Equal discordance is never "significant" regardless of p — there is no
    // direction to credit.
    significant: pValue < alpha && newlyUnsafe !== newlySafe,
    direction,
    meanDeltas: { safety: mean(deltas.safety), voice: mean(deltas.voice), overall: mean(deltas.overall) },
  };
}

/* ── Exam runner ──────────────────────────────────────────────────────── */

/**
 * Replay one sealed item through the live drafter (frozen facts, pinned
 * provider) and grade it with the live judge against the frozen human reply.
 * Returns true when a result row landed; false leaves the item pending for
 * a resume pass (transient provider/judge misses must not poison the run).
 */
async function examOneItem({ run, item, route, client, dbi = db }) {
  const startedAt = Date.now();
  const drafter = require('./sms-shadow-drafter');
  const judge = require('./sms-shadow-judge');

  const intent = { intent: item.intent || 'GENERAL' };
  const { parsed, passes, converged, model } = await drafter.generateGroundedDraft({
    client,
    inboundMessage: item.inbound_message,
    intent,
    schedulingIntent: Boolean(item.scheduling_intent),
    factsBlock: item.facts_block, // frozen day-of snapshot — never a live context
    routeOverride: route, // pinned leg, cross-provider fallback disabled
  });
  if (!parsed) {
    logger.warn(`[sealed-eval] draft failed for item ${String(item.id).slice(0, 8)} (leg ${run.provider_leg}); left pending`);
    return false;
  }

  // Same grader as the nightly judge — deterministic pairing to the frozen
  // human reply (no window heuristics needed: the pairing was decided when
  // the item was sealed).
  const judgment = await judge.judgeOne(
    {
      id: item.id,
      customer_id: item.customer_id,
      intent: item.intent,
      inbound_message: item.inbound_message,
      draft_response: parsed.reply,
      context_summary: item.context_summary,
      facts_block: item.facts_block,
    },
    { id: item.human_reply_sms_id, message_body: item.human_reply_text }
  );
  if (!judgment) {
    logger.warn(`[sealed-eval] judge unparseable for item ${String(item.id).slice(0, 8)}; left pending`);
    return false;
  }

  const scores = parseScores(judgment.scores);
  await dbi('sms_sealed_eval_results')
    .insert({
      run_id: run.id,
      item_id: item.id,
      draft_response: parsed.reply,
      model: model || null,
      passes,
      converged,
      verdict: judgment.verdict,
      scores: scores ? JSON.stringify(scores) : null,
      notes: judgment.notes || null,
      judge_model: judgment.model || null,
      draft_ms: Date.now() - startedAt,
    })
    .onConflict(['run_id', 'item_id'])
    .ignore();
  return true;
}

/**
 * Recompute a run's aggregates from its result rows (idempotent — safe on
 * resume), attach the significance verdict vs the baseline run when set, and
 * flip status to 'complete' when every active item has a result.
 */
async function finalizeRun({ runId, dbi = db } = {}) {
  const run = await dbi('sms_sealed_eval_runs').where({ id: runId }).first();
  if (!run) return null;

  const results = await dbi('sms_sealed_eval_results').where({ run_id: runId })
    .select('item_id', 'verdict', 'scores');
  const verdictCounts = {};
  let unsafe = 0;
  const sums = { safety: [], voice: [], overall: [] };
  for (const r of results) {
    if (r.verdict) verdictCounts[r.verdict] = (verdictCounts[r.verdict] || 0) + 1;
    if (r.verdict === 'draft_unsafe') unsafe += 1;
    const s = parseScores(r.scores);
    if (s) {
      for (const key of Object.keys(sums)) {
        if (Number.isFinite(Number(s[key]))) sums[key].push(Number(s[key]));
      }
    }
  }
  const avg = (arr) => (arr.length ? Number((arr.reduce((a, x) => a + x, 0) / arr.length).toFixed(2)) : null);

  // Same frozen membership rule as the runner: only items sealed at-or-before
  // run creation count toward completion, so a mid-run seal pass can never
  // hold a run open (or grow it) after the fact.
  const [{ count: pendingCount }] = await dbi({ si: 'sms_sealed_eval_items' })
    .leftJoin({ r: 'sms_sealed_eval_results' }, function pendingJoin() {
      this.on('r.item_id', 'si.id').andOnVal('r.run_id', runId);
    })
    .where('si.active', true)
    .where('si.sealed_at', '<=', run.started_at || new Date())
    .whereNull('r.id')
    .count('* as count');
  const done = Number(pendingCount) === 0;

  let significance = null;
  if (done && run.baseline_run_id) {
    const baselineResults = await dbi('sms_sealed_eval_results')
      .where({ run_id: run.baseline_run_id })
      .select('item_id', 'verdict', 'scores');
    significance = computeSignificance({ candidateResults: results, baselineResults });
  }

  const patch = {
    items_judged: results.length,
    unsafe_count: unsafe,
    avg_safety: avg(sums.safety),
    avg_voice: avg(sums.voice),
    avg_overall: avg(sums.overall),
    verdict_counts: JSON.stringify(verdictCounts),
  };
  if (done) {
    patch.status = 'complete';
    patch.finished_at = new Date();
    if (significance) patch.significance = JSON.stringify(significance);
  }
  await dbi('sms_sealed_eval_runs').where({ id: runId }).update(patch);
  return { ...run, ...patch, done };
}

/**
 * Create one exam-run row (no processing). Stamps the RUNNING drafter's
 * PROMPT_VERSION — an exam always examines the code that is live; "comparing
 * versions" means comparing two runs recorded before and after a prompt
 * bump, on the same frozen items. Refuses while any run is status='running':
 * exam processing is serialized behind one advisory lock, so a second row
 * would sit unprocessed and read as a wedged run. A run stranded 'running'
 * by a crash is resumed (POST with resumeRunId), not recreated.
 */
async function createExamRun({ providerLeg, baselineRunId, triggeredBy = 'manual', dbi = db } = {}) {
  if (!EXAM_LEG_ROUTES[providerLeg]) throw new Error(`unknown sealed-eval provider leg: ${providerLeg}`);
  const drafter = require('./sms-shadow-drafter');

  const inFlight = await dbi('sms_sealed_eval_runs').where({ status: 'running' }).first('id', 'provider_leg');
  if (inFlight) {
    const err = new Error(`a sealed-eval run is already in progress (${String(inFlight.id).slice(0, 8)}, ${inFlight.provider_leg} leg) — wait for it or resume it`);
    err.code = 'RUN_IN_PROGRESS';
    err.runId = inFlight.id;
    throw err;
  }
  const [{ count: activeCount }] = await dbi('sms_sealed_eval_items').where('active', true).count('* as count');
  if (!Number(activeCount)) throw new Error('no active sealed items — seal the eval set first');

  // Default baseline: the most recent COMPLETE run on the same leg with a
  // different prompt version — "how does this version compare to the last
  // one we examined". Explicit baselineRunId (any complete run) overrides.
  let baseline = baselineRunId || null;
  if (!baseline) {
    const prior = await dbi('sms_sealed_eval_runs')
      .where({ provider_leg: providerLeg, status: 'complete' })
      .whereNot('prompt_version', drafter.PROMPT_VERSION)
      .orderBy('started_at', 'desc')
      .first('id');
    baseline = prior?.id || null;
  }
  try {
    const [run] = await dbi('sms_sealed_eval_runs')
      .insert({
        prompt_version: drafter.PROMPT_VERSION,
        provider_leg: providerLeg,
        status: 'running',
        items_total: Number(activeCount),
        baseline_run_id: baseline,
        triggered_by: String(triggeredBy || 'manual').slice(0, 100),
      })
      .returning('*');
    return run;
  } catch (err) {
    // The one-running partial unique index closes the check-then-insert race:
    // a concurrent create that slipped past the pre-check lands here instead
    // of leaving a second 'running' row wedged behind the advisory lock.
    if (err && err.code === '23505') {
      const raced = new Error('a sealed-eval run is already in progress — wait for it or resume it');
      raced.code = 'RUN_IN_PROGRESS';
      throw raced;
    }
    throw err;
  }
}

/**
 * Run (or resume) one exam sitting. Long-running (items × several LLM
 * calls) — callers fire it in the background under
 * runExclusive('sms-sealed-eval'). Resumable: re-invoke with runId after an
 * interruption and the UNIQUE(run_id, item_id) anti-join skips finished
 * items. On resume, the provider leg comes from the RUN ROW — never from the
 * caller — so a mismatched resume can't grade one leg's run with the other
 * leg's drafts.
 */
async function runSealedExam({ providerLeg, baselineRunId, runId, triggeredBy = 'manual', dbi = db } = {}) {
  let run;
  if (runId) {
    run = await dbi('sms_sealed_eval_runs').where({ id: runId }).first();
    if (!run) throw new Error(`sealed-eval run ${runId} not found`);
    if (run.status !== 'running' && run.status !== 'failed') {
      throw new Error(`sealed-eval run ${runId} is ${run.status}, not resumable`);
    }
    // A run only ever contains ONE drafter version. Resuming after a prompt
    // bump would draft the remaining items under the NEW code and record
    // them beneath the old label — refuse and start a fresh run instead.
    const currentVersion = require('./sms-shadow-drafter').PROMPT_VERSION;
    if (run.prompt_version !== currentVersion) {
      throw new Error(`sealed-eval run ${runId} examined ${run.prompt_version} but the drafter is now ${currentVersion} — start a new run`);
    }
    if (run.status === 'failed') {
      // Failed runs keep every result already paid for — reopen them instead
      // of forcing a fresh, fully billed run. Guarded UPDATE: the one-running
      // index rejects the flip (23505) while another run is processing.
      let reopened = 0;
      try {
        reopened = await dbi('sms_sealed_eval_runs')
          .where({ id: runId, status: 'failed' })
          .update({ status: 'running', error: null, finished_at: null });
      } catch (err) {
        if (err && err.code === '23505') {
          throw new Error('another sealed-eval run is in progress — wait for it before resuming this one');
        }
        throw err;
      }
      if (!reopened) throw new Error(`sealed-eval run ${runId} is no longer resumable`);
      run = { ...run, status: 'running', error: null, finished_at: null };
    }
  } else {
    run = await createExamRun({ providerLeg, baselineRunId, triggeredBy, dbi });
  }
  const route = EXAM_LEG_ROUTES[run.provider_leg];
  if (!route) throw new Error(`run ${String(run.id).slice(0, 8)} has unknown provider leg ${run.provider_leg}`);

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // Run membership is FROZEN at creation: only items sealed at-or-before the
  // run row was created belong to it. Without this, a weekly/manual seal
  // pass landing mid-run would grow the exam under one leg but not the
  // other — different legs (and the baseline) would examine different sets,
  // and judged could exceed items_total. Items are never edited after
  // insert, so sealed_at is a stable membership key.
  const cohortCutoff = run.started_at || new Date();

  let consecutiveFailures = 0;
  let processed = 0;
  try {
    // Sweep pending items until none remain or the leg looks down. The
    // per-batch re-query IS the resume mechanism: results are keyed
    // UNIQUE(run_id, item_id), so finished items drop out of the join.
    for (;;) {
      const items = await dbi({ si: 'sms_sealed_eval_items' })
        .leftJoin({ r: 'sms_sealed_eval_results' }, function pendingJoin() {
          this.on('r.item_id', 'si.id').andOnVal('r.run_id', run.id);
        })
        .where('si.active', true)
        .where('si.sealed_at', '<=', cohortCutoff)
        .whereNull('r.id')
        .orderBy('si.sealed_at', 'asc')
        .limit(25)
        .select('si.*');
      if (!items.length) break;

      let progressed = 0;
      for (const item of items) {
        let ok = false;
        try {
          ok = await examOneItem({ run, item, route, client, dbi });
        } catch (err) {
          logger.error(`[sealed-eval] item ${String(item.id).slice(0, 8)} failed: ${err.message}`);
        }
        if (ok) {
          progressed += 1;
          processed += 1;
          consecutiveFailures = 0;
        } else {
          consecutiveFailures += 1;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            throw new Error(`${consecutiveFailures} consecutive item failures — ${run.provider_leg} leg unavailable?`);
          }
        }
      }
      if (!progressed) throw new Error('no progress in a full batch — aborting run');
    }
  } catch (err) {
    await finalizeRun({ runId: run.id, dbi }); // persist partial aggregates
    await dbi('sms_sealed_eval_runs').where({ id: run.id })
      .update({ status: 'failed', error: String(err.message || err).slice(0, 500), finished_at: new Date() });
    logger.error(`[sealed-eval] run ${String(run.id).slice(0, 8)} failed after ${processed} items: ${err.message}`);
    return { runId: run.id, status: 'failed', processed, error: err.message };
  }

  const finalized = await finalizeRun({ runId: run.id, dbi });
  logger.info(`[sealed-eval] run complete: ${JSON.stringify({
    runId: String(run.id).slice(0, 8),
    leg: run.provider_leg,
    promptVersion: run.prompt_version,
    judged: finalized?.items_judged,
    unsafe: finalized?.unsafe_count,
  })}`);
  return { runId: run.id, status: 'complete', processed };
}

/* ── Read models (UI + graduation advisory) ───────────────────────────── */

function shapeRun(run) {
  if (!run) return null;
  const judged = Number(run.items_judged) || 0;
  const unsafe = Number(run.unsafe_count) || 0;
  return {
    id: run.id,
    promptVersion: run.prompt_version,
    providerLeg: run.provider_leg,
    status: run.status,
    itemsTotal: run.items_total,
    itemsJudged: judged,
    unsafeCount: unsafe,
    unsafeRate: judged > 0 ? Number((unsafe / judged).toFixed(3)) : null,
    avgSafety: run.avg_safety == null ? null : Number(run.avg_safety),
    avgVoice: run.avg_voice == null ? null : Number(run.avg_voice),
    avgOverall: run.avg_overall == null ? null : Number(run.avg_overall),
    verdictCounts: parseScores(run.verdict_counts) || {},
    baselineRunId: run.baseline_run_id,
    significance: parseScores(run.significance),
    triggeredBy: run.triggered_by,
    error: run.error || null,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
  };
}

/**
 * Exam state for the CURRENT drafter version: item-pool counts, recent runs,
 * and the latest complete run per leg. Consumed by the Agents-hub UI and the
 * /intent-modes advisory payload. Callers treat errors as "no exam signal".
 */
async function getSealedExamSummary({ dbi = db } = {}) {
  const currentVersion = require('./sms-shadow-drafter').PROMPT_VERSION;
  const [counts] = await dbi('sms_sealed_eval_items')
    .count('* as total')
    .select(dbi.raw('COUNT(*) FILTER (WHERE active)::int as active'));
  const runs = await dbi('sms_sealed_eval_runs').orderBy('started_at', 'desc').limit(20);

  const legs = {};
  for (const leg of EXAM_LEGS) {
    legs[leg] = shapeRun(
      runs.find((r) => r.provider_leg === leg && r.status === 'complete' && r.prompt_version === currentVersion)
    ) || null;
  }
  return {
    currentVersion,
    items: { active: Number(counts?.active) || 0, total: Number(counts?.total) || 0 },
    legs,
    runs: runs.map(shapeRun),
  };
}

/**
 * Optional hard gate (GRAD_REQUIRE_SEALED_EXAM=true, default OFF): the
 * blockers a prompt version must clear before graduation counts it as
 * exam-passed. Empty array = pass. Fail-closed on missing data: no sealed
 * items, or no completed run on a leg, is a blocker — an unexamined version
 * never passes by default.
 */
async function evaluateExamGate({ dbi = db } = {}) {
  const summary = await getSealedExamSummary({ dbi });
  if (!summary.items.active) {
    return [`Sealed exam required but no sealed items exist yet (POST /admin/agents/sealed-eval/seal).`];
  }
  // Lazy require: graduation ↔ sealed-eval would be circular at module load
  // (graduation ← auto-send ← drafter ← this module).
  const maxUnsafeRate = require('./sms-graduation').THRESHOLDS.shadowToSuggest.maxUnsafeRate;
  const blockers = [];
  for (const leg of EXAM_LEGS) {
    const run = summary.legs[leg];
    if (!run) {
      blockers.push(`Sealed exam: no completed ${leg} run for ${summary.currentVersion}.`);
      continue;
    }
    if (run.unsafeRate != null && run.unsafeRate > maxUnsafeRate) {
      blockers.push(`Sealed exam (${leg}): unsafe rate ${Math.round(run.unsafeRate * 100)}% exceeds the ${Math.round(maxUnsafeRate * 100)}% cap.`);
    }
    if (run.significance?.significant && run.significance.direction === 'regressed') {
      blockers.push(`Sealed exam (${leg}): significant regression vs baseline (p=${run.significance.pValue}).`);
    }
  }
  return blockers;
}

module.exports = {
  sealEvalItems,
  createExamRun,
  runSealedExam,
  finalizeRun,
  computeSignificance,
  getSealedExamSummary,
  evaluateExamGate,
  EXAM_LEGS,
  EXAM_LEG_ROUTES,
  SEALED_EVAL_TARGET,
  _test: {
    mcNemarExact,
    binomHalfPmf,
    parseScores,
    examOneItem,
    shapeRun,
    SEALED_EVAL_MIN_AGE_DAYS,
    MAX_CONSECUTIVE_FAILURES,
    SIGNIFICANCE_ALPHA,
  },
};
