/**
 * Typed-decisions evaluation (dark behind GATE_TYPED_DECISIONS; reads only).
 *
 * Turns the reviewer labels in decision_reviews into the per-capability status
 * the owner's 2026-10-01 GO rules ask for (jev scope §9): labeled counts,
 * precision and recall with a 95% one-sided exact-binomial lower bound, the
 * tier those bounds clear, automation coverage, and the one blocker to the
 * next tier. Nothing here acts on an answer; a tier is a report, and promotion
 * stays a human decision taken from it.
 *
 * Two label sets, kept apart (§9 rule 4):
 *   representative = rows sampled for random_audit or held out. The random
 *                    audit is drawn population-wide, before and independent
 *                    of the disagreement check (shadow-recorder.sampleFor), so
 *                    it is a true sample of every answer, hard cases included.
 *                    Release performance is measured here, and only here.
 *   development    = rows sampled because the model disagreed with a baseline.
 *                    Biased toward hard cases; reported for the reviewer, never
 *                    used to clear a tier.
 * Labels are the only ground truth (owner 2026-10-01: outcome evidence was
 * dropped). A label's truth: jev_right → the recorded answer; jev_wrong → its
 * correct_value (a yes/no row without one is read as the opposite answer);
 * unclear (label_status disagreement) → excluded from every rate and counted.
 *
 * Rows are grouped by package version, provider and served model, so a new
 * package version, a second provider, or a newly pinned model version earns
 * its tier on its own labels (§9 rule 1: per capability, per version) and a
 * retired version's weak question never holds the current one back. Two
 * providers answering the same subjects (one row each, migration
 * 20261002010000) report side by side here on the same label set.
 * Rows carry ids and answers only; no message text is read here.
 */
const db = require('../../models/db');
const { packageFor } = require('./packages');

const TABLE = 'decision_reviews';
const REPRESENTATIVE = ['random_audit', 'heldout'];
const DEVELOPMENT = ['disagreement'];
const LABELED = ['confirmed_correct', 'confirmed_error', 'disagreement'];
const CONFIDENCE = 0.95;
const DEFAULT_WINDOW_DAYS = 90;
const MAX_WINDOW_DAYS = 365;

// The evidence-gated tiers (jev scope §9 rule 1). Every floor is cleared by the
// 95% one-sided lower confidence bound, never by the point estimate. Tier 4
// (consequential actions) is approval-controlled and has no numeric floor.
const TIERS = Object.freeze([
  Object.freeze({ tier: 1, name: 'reviewed suggestions', floors: Object.freeze({ precision: 0.90, recall: 0.90 }) }),
  Object.freeze({ tier: 2, name: 'reversible internal automation', floors: Object.freeze({ precision: 0.95, recall: 0.95 }) }),
  Object.freeze({ tier: 3, name: 'narrow customer-flow automation', floors: Object.freeze({ acceptedCorrect: 0.995, actionableRecall: 0.99 }) }),
]);
const METRIC_LABELS = Object.freeze({
  precision: 'precision',
  recall: 'recall',
  acceptedCorrect: 'correct among confident answers',
  actionableRecall: 'recall of actionable cases among confident answers',
});

/**
 * Exact one-sided lower confidence bound (Clopper–Pearson) for a proportion
 * after k successes in n trials: the p at which observing at least k successes
 * has probability 1 − confidence. k = n gives (1 − confidence)^(1/n), so 59 of
 * 59 clears 0.95 and 598 of 598 clears 0.995. k = 0 or n = 0 gives 0.
 */
function binomialLowerBound(k, n, { confidence = CONFIDENCE } = {}) {
  if (!Number.isInteger(k) || !Number.isInteger(n) || n <= 0 || k <= 0) return 0;
  if (k > n) throw new RangeError('successes exceed trials');
  const alpha = 1 - confidence;
  if (k === n) return Math.pow(alpha, 1 / n);
  // log C(n, x) for x = k..n, built once.
  const logChoose = new Array(n + 1);
  logChoose[0] = 0;
  for (let x = 1; x <= n; x += 1) logChoose[x] = logChoose[x - 1] + Math.log(n - x + 1) - Math.log(x);
  const tail = (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    const lp = Math.log(p);
    const lq = Math.log1p(-p);
    let sum = 0;
    for (let x = k; x <= n; x += 1) sum += Math.exp(logChoose[x] + x * lp + (n - x) * lq);
    return Math.min(1, sum);
  };
  // tail(p) rises with p; bisect for tail(p) = alpha.
  let lo = 0;
  let hi = 1;
  // 60 halvings put the bound within 1e-18 of exact: far inside any floor.
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (tail(mid) < alpha) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}

const parse = (value) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};

// provider is NOT NULL since migration 20261002010000 and every reader selects
// it, so a row without one is malformed input, never a legacy row: refuse it
// rather than score its evidence as Jev's (Codex r5, #5555).
const providerOf = (row) => {
  if (typeof row.provider !== 'string' || !row.provider) throw new Error('decision_reviews row without a provider');
  return row.provider;
};
const groupKey = (row) => `${row.capability}|${row.package_id}|${providerOf(row)}|${row.question_id}|${row.served_model || ''}`;

// The question's type from the registered package; a package that has since
// left the registry still scores, read from the shape of its stored answer.
function questionType(row) {
  const registered = packageFor(row.package_id)?.questions?.[row.question_id]?.type;
  if (registered) return registered;
  const answer = parse(row.jev_answer);
  if (typeof answer?.yes === 'boolean') return 'noul';
  if (typeof answer?.choice === 'string') return 'choice';
  if (Number.isFinite(answer?.score)) return 'score';
  return null;
}

function emptyStats() {
  return {
    labeled: 0, correct: 0, errors: 0, unclear: 0,
    tp: 0, fp: 0, fn: 0, tn: 0,
    acceptedLabeled: 0, acceptedCorrect: 0, actionable: 0, actionableCaught: 0,
  };
}

// What the label says the right answer was. null = unclear (not a truth).
function truthOf(type, answer, label) {
  if (!label || label.verdict === 'unclear') return null;
  if (type === 'noul') {
    const pred = typeof answer?.yes === 'boolean' ? answer.yes : (Number(answer?.p) >= 0.5);
    if (label.verdict === 'jev_right') return { pred, truth: pred };
    const correct = typeof label.correct_value === 'boolean' ? label.correct_value : !pred;
    return { pred, truth: correct };
  }
  if (type === 'choice') {
    const pred = typeof answer?.choice === 'string' ? answer.choice : null;
    if (label.verdict === 'jev_right') return { pred, truth: pred };
    return { pred, truth: typeof label.correct_value === 'string' ? label.correct_value : null };
  }
  if (type === 'score') {
    const pred = Number.isFinite(answer?.score) ? answer.score : null;
    if (label.verdict === 'jev_right') return { pred, truth: pred };
    return { pred, truth: Number.isFinite(label.correct_value) ? label.correct_value : null };
  }
  return null;
}

// Folds one labeled row into a stats bucket.
function tally(stats, type, row) {
  const answer = parse(row.jev_answer);
  const label = parse(row.label);
  if (row.label_status === 'disagreement' || !label || label.verdict === 'unclear') {
    stats.unclear += 1;
    return;
  }
  const t = truthOf(type, answer, label);
  if (!t) { stats.unclear += 1; return; }
  const right = row.label_status === 'confirmed_correct';
  stats.labeled += 1;
  if (right) stats.correct += 1; else stats.errors += 1;
  const confident = answer?.confident === true;
  if (confident) {
    stats.acceptedLabeled += 1;
    if (right) stats.acceptedCorrect += 1;
  }
  if (type === 'noul') {
    const { pred, truth } = t;
    if (pred && truth) stats.tp += 1;
    else if (pred && !truth) stats.fp += 1;
    else if (!pred && truth) stats.fn += 1;
    else stats.tn += 1;
    if (truth) {
      stats.actionable += 1;
      if (confident && pred) stats.actionableCaught += 1;
    }
  }
}

// Full precision: tiers are judged on these numbers. Display rounding happens
// once, in displayMetrics, so 597/597 (bound 0.99499) can never round up past
// a 0.995 floor.
function rate(num, den) {
  return {
    value: den > 0 ? num / den : null,
    lowerBound: binomialLowerBound(num, den),
    numerator: num,
    denominator: den,
  };
}

const round4 = (x) => (x == null ? null : Number(x.toFixed(4)));
function displayMetrics(metrics) {
  return Object.fromEntries(Object.entries(metrics).map(([name, m]) => [name, { ...m, value: round4(m.value), lowerBound: round4(m.lowerBound) }]));
}

// The rates a tier reads. A choice or score question has no yes class, so its
// precision and recall are both its accuracy (documented in the status payload).
function metricsOf(type, stats) {
  const accuracy = rate(stats.correct, stats.correct + stats.errors);
  const noul = type === 'noul';
  return {
    accuracy,
    precision: noul ? rate(stats.tp, stats.tp + stats.fp) : accuracy,
    recall: noul ? rate(stats.tp, stats.tp + stats.fn) : accuracy,
    acceptedCorrect: rate(stats.acceptedCorrect, stats.acceptedLabeled),
    actionableRecall: noul ? rate(stats.actionableCaught, stats.actionable) : rate(stats.acceptedCorrect, stats.acceptedLabeled),
  };
}

// Smallest number of further all-correct labels that would lift the lower
// bound to the floor, or null when MAX_MORE_LABELS would not. The bound rises
// monotonically with each all-correct label, so this is a binary search:
// about a dozen bound evaluations, never a scan (pre-push audit P1: a scan
// over a large error count took tens of seconds on the event loop).
const MAX_MORE_LABELS = 5000;
function labelsToFloor(metric, floor) {
  const k = metric.numerator;
  const n = metric.denominator;
  const clears = (more) => binomialLowerBound(k + more, n + more) >= floor;
  if (!clears(MAX_MORE_LABELS)) return null;
  let lo = 1;
  let hi = MAX_MORE_LABELS;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (clears(mid)) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// Highest tier whose floors every lower bound clears, climbed in order, plus
// the first unmet floor of the next tier spelled out for the operator.
function tierOf(metrics, representativeLabeled) {
  let reached = 0;
  let blocker = null;
  let nextTier = null;
  for (const t of TIERS) {
    const unmet = Object.entries(t.floors).find(([name, floor]) => metrics[name].lowerBound < floor);
    if (!unmet) { reached = t.tier; continue; }
    nextTier = t.tier;
    const [name, floor] = unmet;
    const m = metrics[name];
    if (representativeLabeled === 0) {
      blocker = 'No representative labels yet (random audit or held-out rows); development labels never clear a tier.';
    } else if (m.denominator === 0) {
      blocker = `Tier ${t.tier} (${t.name}): no labeled rows count toward ${METRIC_LABELS[name]} yet.`;
    } else {
      const more = labelsToFloor(m, floor);
      blocker = `Tier ${t.tier} (${t.name}): ${METRIC_LABELS[name]} ${round4(m.value)} (lower bound ${round4(m.lowerBound)}, ${m.numerator}/${m.denominator}) is below ${floor}`
        + (more === null ? '.' : `; about ${more} more all-correct representative labels would clear it.`);
    }
    break;
  }
  return { reached, nextTier, blocker };
}

/**
 * Pure scorer. `labeledRows` are decision_reviews rows with a label (any
 * label_status but unreviewed); `coverageRows` are grouped counts of every
 * recorded answer ({ capability, package_id, question_id, served_model,
 * answered, confident }). Returns one status per capability, package version
 * and served model, each with its questions.
 */
function scoreRows(labeledRows = [], coverageRows = []) {
  const groups = new Map();
  const ensure = (row) => {
    const key = groupKey(row);
    if (!groups.has(key)) {
      groups.set(key, {
        capability: row.capability,
        packageId: row.package_id,
        questionId: row.question_id,
        provider: providerOf(row),
        servedModel: row.served_model || null,
        type: questionType(row),
        representative: emptyStats(),
        development: emptyStats(),
        other: 0,
        coverage: { answered: 0, confident: 0 },
      });
    }
    return groups.get(key);
  };
  for (const row of coverageRows) {
    const g = ensure(row);
    g.coverage.answered += Number(row.answered) || 0;
    g.coverage.confident += Number(row.confident) || 0;
  }
  for (const row of labeledRows) {
    if (!LABELED.includes(row.label_status)) continue;
    const g = ensure(row);
    // A group opened by a coverage row (no answer to read) learns its type
    // from the first labeled answer when the package is unregistered.
    if (!g.type) g.type = questionType(row);
    if (REPRESENTATIVE.includes(row.sampled_for)) tally(g.representative, g.type, row);
    else if (DEVELOPMENT.includes(row.sampled_for)) tally(g.development, g.type, row);
    else g.other += 1; // labeled outside any sample: shown, never scored
  }
  // Every question of a registered package is part of its status, evidence or
  // not: a package whose other questions were never labeled (or whose
  // unlabeled answers a re-record replaced under a new model) is not cleared
  // by one strong question (pre-push audit P1). Missing questions sit at tier 0.
  const packages = new Map();
  for (const g of groups.values()) {
    packages.set(`${g.capability}|${g.packageId}|${g.provider}|${g.servedModel || ''}`, { capability: g.capability, package_id: g.packageId, provider: g.provider, served_model: g.servedModel });
  }
  for (const ref of packages.values()) {
    const registered = packageFor(ref.package_id);
    if (!registered) continue;
    for (const questionId of Object.keys(registered.questions)) ensure({ ...ref, question_id: questionId });
  }

  const questions = [];
  for (const g of groups.values()) {
    const representative = metricsOf(g.type, g.representative);
    const development = metricsOf(g.type, g.development);
    const tiered = g.type === 'score'
      ? { reached: 0, nextTier: null, blocker: 'Score questions are not tiered (jev scope §3: no Score in phase 0/1).' }
      : tierOf(representative, g.representative.labeled);
    questions.push({
      capability: g.capability,
      packageId: g.packageId,
      questionId: g.questionId,
      provider: g.provider,
      servedModel: g.servedModel,
      type: g.type,
      representative: { counts: g.representative, metrics: displayMetrics(representative) },
      development: { counts: g.development, metrics: displayMetrics(development) },
      otherLabeled: g.other,
      coverage: {
        answered: g.coverage.answered,
        confident: g.coverage.confident,
        confidentShare: g.coverage.answered > 0 ? Number((g.coverage.confident / g.coverage.answered).toFixed(4)) : null,
      },
      tier: tiered.reached,
      nextTier: tiered.nextTier,
      blocker: tiered.blocker,
      note: g.type === 'noul' ? null : 'No yes class: precision and recall are the accuracy of the chosen option.',
    });
  }
  questions.sort((a, b) => a.capability.localeCompare(b.capability) || a.packageId.localeCompare(b.packageId)
    || a.provider.localeCompare(b.provider) || a.questionId.localeCompare(b.questionId) || String(a.servedModel).localeCompare(String(b.servedModel)));

  // One status per capability, PACKAGE VERSION and served model: its tier is
  // the lowest of that package's questions (one weak question holds the whole
  // package) and its blocker is that question's. Keyed on the package so a
  // retired version still in the window cannot drag the current one to 0.
  const byCapability = new Map();
  for (const q of questions) {
    const key = `${q.capability}|${q.packageId}|${q.provider}|${q.servedModel || ''}`;
    if (!byCapability.has(key)) byCapability.set(key, { capability: q.capability, packageId: q.packageId, provider: q.provider, servedModel: q.servedModel, questions: [], weakest: null });
    const c = byCapability.get(key);
    c.questions.push(q);
    // The weakest question: lowest tier, then fewest representative labels
    // (furthest from clearing), then id order (questions arrive sorted).
    const w = c.weakest;
    if (!w || q.tier < w.tier || (q.tier === w.tier && repLabeled(q) < repLabeled(w))) c.weakest = q;
  }
  return [...byCapability.values()].map((c) => ({
    capability: c.capability,
    packageId: c.packageId,
    // false = the package has left the registry: history, not what runs now.
    registered: Boolean(packageFor(c.packageId)),
    provider: c.provider,
    servedModel: c.servedModel,
    tier: c.weakest ? c.weakest.tier : 0,
    nextTier: c.weakest ? c.weakest.nextTier : null,
    blocker: c.weakest && c.weakest.blocker ? `${c.weakest.questionId}: ${c.weakest.blocker}` : null,
    labeled: {
      representative: c.questions.reduce((n, q) => n + q.representative.counts.labeled + q.representative.counts.unclear, 0),
      development: c.questions.reduce((n, q) => n + q.development.counts.labeled + q.development.counts.unclear, 0),
    },
    questions: c.questions,
  }));
}

const repLabeled = (q) => q.representative.counts.labeled;

function clampDays(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? Math.max(1, Math.min(MAX_WINDOW_DAYS, n)) : DEFAULT_WINDOW_DAYS;
}

/**
 * Status for every capability recorded in the window: the labeled rows and
 * the per-question answer counts, scored by scoreRows. Read-only; throws on
 * a database error (the route maps it).
 */
async function evaluateCapabilities({ days = DEFAULT_WINDOW_DAYS, now = new Date(), conn = db } = {}) {
  const windowDays = clampDays(days);
  const since = new Date(now.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const labeledRows = await conn(TABLE)
    .where('created_at', '>=', since)
    .whereIn('label_status', LABELED)
    .select('capability', 'package_id', 'provider', 'question_id', 'served_model', 'sampled_for', 'label_status', 'jev_answer', 'label');
  const coverageRows = await conn(TABLE)
    .where('created_at', '>=', since)
    .groupBy('capability', 'package_id', 'provider', 'question_id', 'served_model')
    .select('capability', 'package_id', 'provider', 'question_id', 'served_model')
    .count('* as answered')
    .select(conn.raw("COUNT(*) FILTER (WHERE (jev_answer->>'confident')::boolean)::int as confident"));
  return {
    generatedAt: now.toISOString(),
    windowDays,
    confidence: CONFIDENCE,
    tiers: TIERS,
    capabilities: scoreRows(labeledRows, coverageRows),
  };
}

module.exports = {
  TIERS,
  CONFIDENCE,
  DEFAULT_WINDOW_DAYS,
  binomialLowerBound,
  labelsToFloor,
  scoreRows,
  clampDays,
  evaluateCapabilities,
};
