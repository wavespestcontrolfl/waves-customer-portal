/**
 * sms-graduation.js — Phase E readiness engine for the SMS brand-voice loop.
 *
 * Decides, per intent, whether it has EARNED its next rung on the ladder
 * shadow → suggest → auto_send. This is the "data-gated" GATE: it flips
 * nothing (mode changes stay manual via PUT /intent-modes), it reports
 * eligibility + the SPECIFIC blockers so the operator promotes only when the
 * numbers justify it — and so a future auto-promoter has a single source of
 * truth for "is intent X ready?".
 *
 * Two independent signals, one per rung:
 *   - shadow → suggest is JUDGE-driven. The nightly judge scores shadow
 *     drafts; draft_unsafe = fabrication. **LIVE drafts only** — backfill
 *     cohorts (prompt_version LIKE '%backfill') draft today's schedule/context
 *     onto months-old inbounds, so their unsafe rate is drift-inflated and
 *     would lie about readiness. Excluded here.
 *   - suggest → auto_send is OUTCOME-driven. Once an intent is suggesting, the
 *     human's accept-verbatim / edit / ignore choices ARE the ground truth: a
 *     high accepted rate with few corrections means the draft is send-ready.
 *     A judge backstop (recent unsafe on drafts that reverted to shadow) guards
 *     against a regression the accept-rate hasn't caught yet.
 *
 * Escalation intents never graduate (locked) — enforced here and in
 * sms-suggest-mode.validateModeChange. The auto_send rung is RECOMMEND-ONLY
 * until the executor ships (next PR); eligibleFor:'auto_send' surfaces the
 * recommendation without enabling the flip.
 */

const db = require('../models/db');
const logger = require('./logger');

const LADDER = ['shadow', 'suggest', 'auto_send'];

const envNum = (name, def) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) ? v : def;
};

// Thresholds are env-overridable so they can be tuned from real data without a
// deploy-shaped code change; defaults are deliberately conservative because the
// next rung removes a layer of human review.
const THRESHOLDS = {
  shadowToSuggest: {
    minJudged: envNum('GRAD_SUGGEST_MIN_JUDGED', 40),
    maxUnsafeRate: envNum('GRAD_SUGGEST_MAX_UNSAFE_RATE', 0.08),
    minSafety: envNum('GRAD_SUGGEST_MIN_SAFETY', 8.0),
  },
  suggestToAutosend: {
    minDecided: envNum('GRAD_AUTOSEND_MIN_DECIDED', 60),
    minAcceptedRate: envNum('GRAD_AUTOSEND_MIN_ACCEPTED_RATE', 0.85),
    maxCorrectedRate: envNum('GRAD_AUTOSEND_MAX_CORRECTED_RATE', 0.10),
    maxRecentUnsafe: envNum('GRAD_AUTOSEND_MAX_RECENT_UNSAFE', 0),
    recentWindow: envNum('GRAD_AUTOSEND_RECENT_WINDOW', 30),
  },
};

const rate = (n, d) => (d > 0 ? n / d : 0);
const asPct = (x) => `${Math.round(x * 100)}%`;

/**
 * Pure rung evaluation — no DB, fully testable. Given an intent's current mode
 * and its two signals, returns the next rung, whether it's eligible, and the
 * human-readable blockers standing in the way.
 *
 *   judge   = { judged, unsafe, avgSafety, recentUnsafe }  (LIVE, non-backfill)
 *   suggest = { accepted, corrected, ignored }             (agent_decisions)
 */
function evaluateRung({ mode = 'shadow', locked = false, judge = {}, suggest = {}, thresholds = THRESHOLDS } = {}) {
  const currentMode = LADDER.includes(mode) ? mode : 'shadow';

  if (locked) {
    return { currentMode, nextRung: null, eligible: false, blockers: ['Escalation intent — locked to shadow; never graduates.'] };
  }
  if (currentMode === 'auto_send') {
    return { currentMode, nextRung: null, eligible: true, blockers: [] }; // top of ladder
  }

  const blockers = [];

  if (currentMode === 'shadow') {
    const t = thresholds.shadowToSuggest;
    const judged = judge.judged || 0;
    const unsafeRate = rate(judge.unsafe || 0, judged);
    const avgSafety = judge.avgSafety == null ? null : Number(judge.avgSafety);

    if (judged < t.minJudged) blockers.push(`Needs ${t.minJudged - judged} more live judged drafts (${judged}/${t.minJudged}).`);
    if (judged > 0 && unsafeRate > t.maxUnsafeRate) blockers.push(`Unsafe rate ${asPct(unsafeRate)} > ${asPct(t.maxUnsafeRate)} cap.`);
    if (avgSafety != null && avgSafety < t.minSafety) blockers.push(`Avg safety ${avgSafety.toFixed(1)} < ${t.minSafety.toFixed(1)} required.`);

    // No data is never eligible, even if every threshold is vacuously clear.
    const eligible = blockers.length === 0 && judged >= t.minJudged;
    return { currentMode, nextRung: 'suggest', eligible, blockers };
  }

  // currentMode === 'suggest' → auto_send
  const t = thresholds.suggestToAutosend;
  const accepted = suggest.accepted || 0;
  const corrected = suggest.corrected || 0;
  const ignored = suggest.ignored || 0;
  const decided = accepted + corrected + ignored;
  const acceptedRate = rate(accepted, decided);
  const correctedRate = rate(corrected, decided);
  const recentUnsafe = judge.recentUnsafe || 0;

  if (decided < t.minDecided) blockers.push(`Needs ${t.minDecided - decided} more human-decided suggestions (${decided}/${t.minDecided}).`);
  if (decided > 0 && acceptedRate < t.minAcceptedRate) blockers.push(`Accepted-verbatim ${asPct(acceptedRate)} < ${asPct(t.minAcceptedRate)} required.`);
  if (decided > 0 && correctedRate > t.maxCorrectedRate) blockers.push(`Correction rate ${asPct(correctedRate)} > ${asPct(t.maxCorrectedRate)} cap.`);
  if (recentUnsafe > t.maxRecentUnsafe) blockers.push(`${recentUnsafe} unsafe in last ${t.recentWindow} judged (must be ${t.maxRecentUnsafe}).`);

  const eligible = blockers.length === 0 && decided >= t.minDecided;
  return { currentMode, nextRung: 'auto_send', eligible, blockers };
}

/**
 * Per-intent LIVE judge signal. Returns a Map intent → { judged, unsafe,
 * avgSafety, recentUnsafe, backfillJudged }. recentUnsafe counts draft_unsafe
 * among the most recent `recentWindow` LIVE judgments — the backstop for the
 * suggest → auto_send rung.
 *
 * CRITICAL: the backfill cohort lives on message_drafts.prompt_version, NOT on
 * shadow_draft_judgments.prompt_version (that column carries the JUDGE's
 * version, 'shadow_judge_v1', for every row). So "live only" REQUIRES the join
 * to message_drafts. Backfill judgments draft today's schedule onto months-old
 * inbounds — drift-contaminated, and they must never gate autonomy.
 * backfillJudged is informational: it explains a 0/40 live count to the
 * operator ("you have N backfill samples, but graduation needs live ones").
 */
async function fetchLiveJudgeSignals(dbi = db, { recentWindow = THRESHOLDS.suggestToAutosend.recentWindow } = {}) {
  const liveOnly = function () {
    this.whereNotNull('j.intent').whereRaw("md.prompt_version NOT LIKE '%backfill'");
  };

  const [totals, recent, backfill] = await Promise.all([
    dbi({ j: 'shadow_draft_judgments' })
      .join({ md: 'message_drafts' }, 'md.id', 'j.draft_id')
      .where(liveOnly)
      .groupBy('j.intent')
      .select('j.intent')
      .select(dbi.raw('COUNT(*)::int as judged'))
      .select(dbi.raw("COUNT(*) FILTER (WHERE j.verdict = 'draft_unsafe')::int as unsafe"))
      .select(dbi.raw("AVG((j.scores->>'safety')::numeric) FILTER (WHERE j.scores IS NOT NULL) as avg_safety")),
    dbi
      .with('ranked', (qb) => {
        qb.from({ j: 'shadow_draft_judgments' })
          .join({ md: 'message_drafts' }, 'md.id', 'j.draft_id')
          .where(liveOnly)
          .select('j.intent', 'j.verdict')
          .select(dbi.raw('ROW_NUMBER() OVER (PARTITION BY j.intent ORDER BY j.judged_at DESC) as rn'));
      })
      .from('ranked')
      .where('rn', '<=', recentWindow)
      .groupBy('intent')
      .select('intent')
      .select(dbi.raw("COUNT(*) FILTER (WHERE verdict = 'draft_unsafe')::int as recent_unsafe")),
    // Informational: judged drafts that ARE backfill, per intent.
    dbi({ j: 'shadow_draft_judgments' })
      .join({ md: 'message_drafts' }, 'md.id', 'j.draft_id')
      .whereNotNull('j.intent')
      .whereRaw("md.prompt_version LIKE '%backfill'")
      .groupBy('j.intent')
      .select('j.intent')
      .select(dbi.raw('COUNT(*)::int as backfill_judged')),
  ]);

  const map = new Map();
  const ensure = (intent) => {
    if (!map.has(intent)) map.set(intent, { judged: 0, unsafe: 0, avgSafety: null, recentUnsafe: 0, backfillJudged: 0 });
    return map.get(intent);
  };
  for (const r of totals) {
    const e = ensure(r.intent);
    e.judged = r.judged || 0;
    e.unsafe = r.unsafe || 0;
    e.avgSafety = r.avg_safety == null ? null : Number(Number(r.avg_safety).toFixed(1));
  }
  for (const r of recent) ensure(r.intent).recentUnsafe = r.recent_unsafe || 0;
  for (const r of backfill) ensure(r.intent).backfillJudged = r.backfill_judged || 0;
  return map;
}

/**
 * Per-intent readiness, ready to attach to the /intent-modes payload. Takes
 * the suggest-outcome buckets the endpoint already computed (accepted /
 * corrected / ignored from agent_decisions) so there's one rollup, not two.
 * Fail-soft: a signal-fetch error degrades to "no judge data" rather than
 * breaking the modes endpoint.
 */
async function computeReadiness({ intents, dbi = db } = {}) {
  let judgeSignals = new Map();
  try {
    judgeSignals = await fetchLiveJudgeSignals(dbi);
  } catch (err) {
    logger.warn(`[sms-graduation] judge-signal fetch failed: ${err.message}; readiness degrades to outcome-only`);
  }

  const out = new Map();
  for (const { intent, mode, locked, suggest } of intents) {
    const judge = judgeSignals.get(intent) || { judged: 0, unsafe: 0, avgSafety: null, recentUnsafe: 0, backfillJudged: 0 };
    const verdict = evaluateRung({ mode, locked, judge, suggest });
    out.set(intent, {
      ...verdict,
      eligibleFor: verdict.eligible ? verdict.nextRung : null,
      judge: {
        judged: judge.judged,
        unsafe: judge.unsafe,
        unsafeRate: Number(rate(judge.unsafe, judge.judged).toFixed(3)),
        avgSafety: judge.avgSafety,
        recentUnsafe: judge.recentUnsafe,
        backfillJudged: judge.backfillJudged || 0,
      },
    });
  }
  return out;
}

module.exports = {
  LADDER,
  THRESHOLDS,
  evaluateRung,
  fetchLiveJudgeSignals,
  computeReadiness,
};
