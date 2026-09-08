/**
 * Lawn visit assessment eval — pure scoring plus a runner with injected I/O.
 *
 * Replays CONFIRMED lawn assessments through the single-call visit assessment
 * (services/lawn-visit-assessment.js) and compares what the one call derives
 * against (a) the scores the technician confirmed and (b) the legacy
 * two-model AI scores stored on the same row, so the owner can hand-check
 * findings and numbers before GATE_LAWN_VISIT_ASSESSMENT is ever flipped.
 *
 * Everything here is pure or takes its I/O through `deps` — the ops CLI
 * (ops/agents/lawn-visit-assessment-eval.js) supplies the database export,
 * the S3 photo reads and the live model call. Nothing in this module writes.
 *
 * What a run measures, per case and in aggregate:
 *   - unavailable rate (both providers missed) and which provider answered
 *   - per-metric error of the derived legacy scores vs the CONFIRMED scores
 *     (post-seasonal, technician-corrected) and vs the legacy AI composite
 *     (pre-seasonal, model-only) — NULL ("not determinable") is reported as
 *     a rate, never scored as 0
 *   - naming discipline: findings whose raw NAME carries a cause below
 *     moderate confidence (the server label hides it; this is the model's own
 *     discipline, the thing the prompt is meant to instil)
 *   - latency p50 / p95, tokens, cost (list prices below), and — with
 *     --repeat — per-case score variance, since temperature is ignored by the
 *     Gemini 3.8 line and stability has to be measured, not assumed
 */

const { applySeasonalAdjustment } = require('../lawn-assessment');
const { deriveLegacyScores, adjustAvailableScores, contextHash } = require('../lawn-visit-assessment');
const { scrubCustomerText } = require('../lawn-diagnostic-report');
const { CAUSE_PATTERNS } = require('./lawn-diagnostic-naming-gate');

// USD per 1M tokens, standard tier, checked 2026-09-08. Thinking is billed at
// the output rate on both providers, but the usage shapes differ: Gemini
// reports thoughts SEPARATELY from candidates (add them), OpenAI's
// reasoning_tokens are a SUBSET of output_tokens (already counted) —
// llm-dispatch-metrics.js extractUsage. Cost is an estimate for the
// hand-check, not a bill.
const PRICES_PER_M = Object.freeze({
  'gemini-3.8-flash': { input: 0.75, output: 3.75, reasoningSeparate: true },
  'gpt-6-astra': { input: 10, output: 50, reasoningSeparate: false },
});

// A pg DATE arrives as a Date (local midnight) or 'YYYY-MM-DD'; either way the
// calendar day is the first ten characters of the ISO form — never String(Date).
function dateString(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
  const text = String(value).slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

const SCORE_KEYS = ['turf_density', 'weed_suppression', 'color_health', 'fungus_control', 'thatch_level', 'stress_damage'];
const CONFIDENCE_RANK = { unknown: 0, low: 1, moderate: 2, high: 3 };
const ANY_CAUSE = Object.values(CAUSE_PATTERNS);

const numberOrNull = (value) => {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const parseJson = (value, fallback) => {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
};

// ── Fixture (export phase) ────────────────────────────────────────────
/**
 * One exported case: ids, dates, keys, scores and agronomic context only —
 * no names, addresses, phones or notes ever enter the fixture file.
 *   row      lawn_assessments row (confirmed), with `scheduled_date` joined
 *   photos   lawn_assessment_photos rows for it, prompt order
 *   context  { grassType, irrigation, priorSummary } resolved by the exporter
 */
function fixtureCase(row, photos = [], context = {}) {
  const composite = parseJson(row.composite_scores, {}) || {};
  const visitDate = dateString(row.scheduled_date) || dateString(row.service_date) || '';
  const month = Number(visitDate.slice(5, 7)) || null;
  return {
    assessmentId: row.id,
    customerId: row.customer_id,
    serviceId: row.service_id || null,
    visitDate,
    month,
    season: row.season || null,
    confirmed: Object.fromEntries(SCORE_KEYS.map((key) => [key, numberOrNull(row[key])])),
    legacyAi: Object.fromEntries(SCORE_KEYS.map((key) => [key, numberOrNull(composite[key])])),
    photos: photos
      .filter((photo) => photo && photo.s3_key && !String(photo.s3_key).startsWith('pending/'))
      .sort((a, b) => (a.photo_order ?? 0) - (b.photo_order ?? 0))
      .map((photo) => ({ id: photo.id, s3Key: photo.s3_key, mimeType: photo.mime_type || 'image/jpeg', zone: photo.zone || null })),
    context: {
      grassType: context.grassType || null,
      irrigation: context.irrigation || null,
      priorSummary: scrubPriorSummary(context.priorSummary, context.customerNames),
    },
  };
}

// The previous visit's ai_summary was written by a model that was given the
// customer's full name (knowledge-bridge), so the fixture copy goes through
// the customer egress scrubber (phones, emails, URLs, street addresses,
// brands) and then loses every customer-name token the exporter knows —
// first, last, and the household's other names — before it is clipped.
// Null when nothing is left.
function scrubPriorSummary(text, customerNames = []) {
  if (!text) return null;
  let out = scrubCustomerText(String(text));
  const names = (customerNames || []).map((value) => String(value || '').trim()).filter((value) => value.length >= 2).sort((a, b) => b.length - a.length);
  for (const name of names) {
    out = out.replace(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), 'the customer');
  }
  out = out.replace(/\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+the customer\b/g, 'the customer').replace(/\bthe customer(?:\s+the customer)+\b/g, 'the customer').trim();
  return out ? out.slice(0, 400) : null;
}

// Deterministic selection: explicit ids first (in the order given), else a
// stable pseudo-random sample keyed on the id so two runs pick the same set.
function selectCases(cases, { ids = [], sample = null } = {}) {
  if (ids.length) {
    const wanted = new Set(ids.map(String));
    return cases.filter((c) => wanted.has(String(c.assessmentId)));
  }
  if (!sample) return cases;
  const keyed = cases.map((c) => ({ c, k: hashKey(c.assessmentId) })).sort((a, b) => a.k.localeCompare(b.k));
  return keyed.slice(0, sample).map((x) => x.c);
}
function hashKey(value) {
  let h = 2166136261;
  for (const ch of String(value)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// The known-visit context the route would build for this visit — season and
// month from the VISIT date, grass / irrigation on file, the previous visit's
// summary. No technician notes (not stored) and never the planned products.
function contextFor(testCase) {
  const context = { region: 'Southwest Florida' };
  if (testCase.month) { context.month = testCase.month; context.season = seasonOf(testCase.month); }
  if (testCase.context?.grassType) context.grassType = testCase.context.grassType;
  if (testCase.context?.irrigation) context.irrigation = testCase.context.irrigation;
  if (testCase.context?.priorSummary) context.priorSummary = testCase.context.priorSummary;
  return context;
}
function seasonOf(month) {
  if (month >= 5 && month <= 9) return 'peak';
  if ((month >= 3 && month <= 4) || (month >= 10 && month <= 11)) return 'shoulder';
  return 'dormant';
}

// ── Scoring (pure) ────────────────────────────────────────────────────
function costUsd(model, usage) {
  const price = PRICES_PER_M[String(model || '')];
  if (!price || !usage) return null;
  const input = Number(usage.input_tokens) || 0;
  const output = (Number(usage.output_tokens) || 0) + (price.reasoningSeparate ? (Number(usage.reasoning_tokens) || 0) : 0);
  return Math.round(((input * price.input) + (output * price.output)) / 1e6 * 1e4) / 1e4;
}

// The legs that spent tokens, in call order: a failed leg carries its usage
// on the failure entry (llm/call.js failedLeg); the winning leg is the outcome.
function billedLegs(analysis) {
  const failed = (analysis.failures || []).filter((leg) => leg && leg.usage)
    .map((leg) => ({ provider: leg.provider || null, model: leg.model || null, reason: leg.reason || null, usage: leg.usage }));
  const won = analysis.status === 'complete' && analysis.usage
    ? [{ provider: analysis.provider || null, model: analysis.model || null, reason: null, usage: analysis.usage }]
    : [];
  return [...failed, ...won];
}

function sumUsage(legs) {
  const total = { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0 };
  for (const { usage } of legs) {
    total.input_tokens += Number(usage.input_tokens) || 0;
    total.output_tokens += Number(usage.output_tokens) || 0;
    total.reasoning_tokens += Number(usage.reasoning_tokens) || 0;
  }
  return total;
}

// Null until at least one leg is priced (an unpriced model's leg adds nothing).
function legsCostUsd(legs) {
  const priced = legs.map((leg) => costUsd(leg.model, leg.usage)).filter((value) => value != null);
  return priced.length ? Math.round(priced.reduce((sum, value) => sum + value, 0) * 1e4) / 1e4 : null;
}

function causeNamedBelowModerate(findings = []) {
  return findings.filter((finding) => {
    const rank = CONFIDENCE_RANK[String(finding.confidence || '').toLowerCase()] ?? 0;
    return rank < CONFIDENCE_RANK.moderate && ANY_CAUSE.some((re) => re.test(String(finding.name || '')));
  }).map((finding) => ({ finding_id: finding.finding_id, name: finding.name, confidence: finding.confidence, label: finding.label }));
}

/**
 * Score one replay. `adjust` defaults to the calendar-month seasonal factor
 * (the weather-driven variant needs the temperatures of that day, which the
 * replay cannot reproduce — so confirmed-score deltas carry that caveat).
 */
function scoreResult(testCase, analysis, { adjust = (scores, month) => applySeasonalAdjustment(scores, month) } = {}) {
  const legs = billedLegs(analysis);
  const base = {
    assessmentId: testCase.assessmentId,
    visitDate: testCase.visitDate,
    photoCount: testCase.photos.length,
    status: analysis.status,
    unavailableReason: analysis.reason || null,
    provider: analysis.provider || null,
    model: analysis.model || null,
    fallbackUsed: !!analysis.fallbackUsed,
    failures: analysis.failures || [],
    latencyMs: analysis.latencyMs ?? null,
    // Every billed leg — a primary answer the validator rejected before the
    // fallback answered, or both legs on an unavailable run — counts toward
    // the tokens and cost the run actually spent, not only the winning leg.
    legs,
    usage: legs.length ? sumUsage(legs) : null,
    costUsd: legsCostUsd(legs),
    contextHash: analysis.contextHash || null,
  };
  if (analysis.status !== 'complete') {
    return { ...base, derived: null, adjusted: null, deltas: null, undeterminable: SCORE_KEYS.slice(), causeNamedBelowModerate: [], findings: [], severities: null, observations: analysis.observations || null };
  }
  const derived = deriveLegacyScores(analysis);
  const adjusted = adjustAvailableScores(derived, (scores) => adjust(scores, testCase.month));
  const deltas = { vsConfirmed: {}, vsLegacyAi: {} };
  const undeterminable = [];
  for (const key of SCORE_KEYS) {
    if (derived[key] == null) { undeterminable.push(key); continue; }
    const confirmed = testCase.confirmed?.[key];
    const legacy = testCase.legacyAi?.[key];
    deltas.vsConfirmed[key] = confirmed == null ? null : adjusted[key] - confirmed;
    deltas.vsLegacyAi[key] = legacy == null ? null : derived[key] - legacy;
  }
  return {
    ...base,
    derived,
    adjusted,
    deltas,
    undeterminable,
    causeNamedBelowModerate: causeNamedBelowModerate(analysis.findings),
    findings: (analysis.findings || []).map((finding) => ({
      finding_id: finding.finding_id, name: finding.name, label: finding.label, confidence: finding.confidence, severity: finding.severity,
      urgency: finding.urgency, photo_refs: finding.photo_refs, zone: finding.zone, can_determine: finding.can_determine,
      cannot_determine_reason: finding.cannot_determine_reason, observed_evidence: finding.observed_evidence, negative_evidence: finding.negative_evidence,
      confirmation_step: finding.confirmation_step,
    })),
    severities: analysis.severities,
    grassType: analysis.grassType || null,
    photoQuality: analysis.photoQuality,
    observations: analysis.observations,
  };
}

function percentile(values, p) {
  const sorted = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}
function mean(values) {
  const list = values.filter((v) => Number.isFinite(v));
  return list.length ? list.reduce((sum, v) => sum + v, 0) / list.length : null;
}
function stddev(values) {
  const list = values.filter((v) => Number.isFinite(v));
  if (list.length < 2) return null;
  const m = mean(list);
  return Math.sqrt(list.reduce((sum, v) => sum + (v - m) ** 2, 0) / (list.length - 1));
}
const round = (value, digits = 1) => (value == null ? null : Math.round(value * 10 ** digits) / 10 ** digits);

function summarize(results = []) {
  const complete = results.filter((r) => r.status === 'complete');
  const byProvider = {};
  for (const r of results) {
    const key = r.status === 'complete' ? `${r.provider}:${r.model}${r.fallbackUsed ? ' (fallback)' : ''}` : 'unavailable';
    byProvider[key] = (byProvider[key] || 0) + 1;
  }
  const mae = { vsConfirmed: {}, vsLegacyAi: {} };
  const undeterminableRate = {};
  for (const key of SCORE_KEYS) {
    for (const side of ['vsConfirmed', 'vsLegacyAi']) {
      const diffs = complete.map((r) => r.deltas?.[side]?.[key]).filter((v) => Number.isFinite(v)).map(Math.abs);
      mae[side][key] = { mae: round(mean(diffs)), bias: round(mean(complete.map((r) => r.deltas?.[side]?.[key]).filter((v) => Number.isFinite(v)))), n: diffs.length };
    }
    undeterminableRate[key] = complete.length ? round(complete.filter((r) => r.undeterminable.includes(key)).length / complete.length, 3) : null;
  }
  // Repeat-run variance: per assessment, the spread of each derived score.
  const byCase = new Map();
  for (const r of complete) {
    if (!byCase.has(r.assessmentId)) byCase.set(r.assessmentId, []);
    byCase.get(r.assessmentId).push(r);
  }
  const repeated = [...byCase.values()].filter((runs) => runs.length > 1);
  const variance = repeated.length ? Object.fromEntries(SCORE_KEYS.map((key) => [key, round(mean(repeated.map((runs) => stddev(runs.map((r) => r.derived?.[key])))))])) : null;
  const latencies = results.map((r) => r.latencyMs);
  const costs = results.map((r) => r.costUsd).filter((v) => Number.isFinite(v));
  return {
    runs: results.length,
    cases: new Set(results.map((r) => r.assessmentId)).size,
    unavailable: results.length - complete.length,
    unavailableRate: results.length ? round((results.length - complete.length) / results.length, 3) : null,
    byProvider,
    mae,
    undeterminableRate,
    causeNamedBelowModerate: complete.reduce((sum, r) => sum + r.causeNamedBelowModerate.length, 0),
    findingsPerRun: round(mean(complete.map((r) => r.findings.length))),
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    tokens: {
      input: results.reduce((sum, r) => sum + (Number(r.usage?.input_tokens) || 0), 0),
      output: results.reduce((sum, r) => sum + (Number(r.usage?.output_tokens) || 0), 0),
      reasoning: results.reduce((sum, r) => sum + (Number(r.usage?.reasoning_tokens) || 0), 0),
    },
    costUsd: { total: round(costs.reduce((sum, v) => sum + v, 0), 4), perRun: round(mean(costs), 4), priced: costs.length },
    repeatVariance: variance,
  };
}

function renderMarkdown(summary, results = [], { title = 'Lawn visit assessment eval' } = {}) {
  const lines = [`## ${title}`, ''];
  lines.push(`runs ${summary.runs} · cases ${summary.cases} · unavailable ${summary.unavailable} (${fmtRate(summary.unavailableRate)}) · findings/run ${summary.findingsPerRun ?? 'n/a'} · cause named below moderate: ${summary.causeNamedBelowModerate}`);
  lines.push(`latency p50 ${summary.latencyMs.p50 ?? 'n/a'} ms · p95 ${summary.latencyMs.p95 ?? 'n/a'} ms · tokens in ${summary.tokens.input} / out ${summary.tokens.output} / reasoning ${summary.tokens.reasoning} · est. cost $${summary.costUsd.total ?? 'n/a'} ($${summary.costUsd.perRun ?? 'n/a'} per run, ${summary.costUsd.priced} priced)`);
  lines.push(`answered by: ${Object.entries(summary.byProvider).map(([k, v]) => `${k} ×${v}`).join(', ') || 'n/a'}`, '');
  lines.push('| metric | MAE vs confirmed | bias | n | MAE vs legacy AI | bias | n | not determinable |');
  lines.push('|---|---|---|---|---|---|---|---|');
  for (const key of SCORE_KEYS) {
    const c = summary.mae.vsConfirmed[key]; const l = summary.mae.vsLegacyAi[key];
    lines.push(`| ${key} | ${c.mae ?? 'n/a'} | ${fmtSigned(c.bias)} | ${c.n} | ${l.mae ?? 'n/a'} | ${fmtSigned(l.bias)} | ${l.n} | ${fmtRate(summary.undeterminableRate[key])} |`);
  }
  if (summary.repeatVariance) {
    lines.push('', `repeat-run spread (mean per-case stddev): ${SCORE_KEYS.map((key) => `${key} ${summary.repeatVariance[key] ?? 'n/a'}`).join(' · ')}`);
  }
  lines.push('', '| assessment | date | photos | status | answered by | ms | turf | weeds | color | fungus | thatch | stress | findings (label @ confidence) |', '|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const r of results) {
    const cell = (key) => (r.status !== 'complete' ? '—' : r.derived[key] == null ? 'n/d' : `${r.adjusted[key]}${fmtDelta(r.deltas.vsConfirmed[key])}`);
    const findings = r.status === 'complete' ? r.findings.map((f) => `${f.label} @ ${f.confidence}${f.can_determine ? '' : ' (n/d)'}`).join('; ') : (r.unavailableReason || 'unavailable');
    lines.push(`| ${String(r.assessmentId).slice(0, 8)} | ${r.visitDate} | ${r.photoCount} | ${r.status} | ${r.status === 'complete' ? `${r.provider}${r.fallbackUsed ? ' (fallback)' : ''}` : '—'} | ${r.latencyMs ?? ''} | ${cell('turf_density')} | ${cell('weed_suppression')} | ${cell('color_health')} | ${cell('fungus_control')} | ${cell('thatch_level')} | ${cell('stress_damage')} | ${findings} |`);
  }
  lines.push('', 'Score cells: seasonally adjusted derived score, then its delta vs the confirmed score in parentheses; n/d = the model could not determine it. Confirmed scores carry technician corrections and, for same-day visits, a weather-driven seasonal factor the replay cannot reproduce.');
  return lines.join('\n');
}
const fmtRate = (value) => (value == null ? 'n/a' : `${Math.round(value * 100)}%`);
const fmtSigned = (value) => (value == null ? 'n/a' : `${value > 0 ? '+' : ''}${value}`);
const fmtDelta = (value) => (value == null ? '' : ` (${value > 0 ? '+' : ''}${value})`);

// ── Runner (I/O injected) ─────────────────────────────────────────────
/**
 * deps: { analyzeVisit(args) → analysis, loadPhoto(s3Key) → { data, mimeType }, log? }
 * Every case is replayed `repeat` times; a case whose photos cannot be read
 * is reported as skipped rather than analyzed on partial input.
 */
async function runEval(cases, deps, { repeat = 1, concurrency = 2, thinkingLevel } = {}) {
  const results = [];
  const skipped = [];
  const queue = cases.slice();
  const log = deps.log || (() => {});
  async function worker() {
    while (queue.length) {
      const testCase = queue.shift();
      let photos;
      try {
        photos = await Promise.all(testCase.photos.map(async (photo) => ({ ...(await deps.loadPhoto(photo.s3Key)), zone: photo.zone })));
      } catch (err) {
        skipped.push({ assessmentId: testCase.assessmentId, reason: `photo read failed: ${err.message}` });
        log(`skip ${testCase.assessmentId}: ${err.message}`);
        continue;
      }
      if (!photos.length) { skipped.push({ assessmentId: testCase.assessmentId, reason: 'no stored photos' }); continue; }
      const photoZones = photos.map((photo) => photo.zone || null);
      const visionContext = contextFor(testCase);
      for (let i = 0; i < repeat; i += 1) {
        const analysis = await deps.analyzeVisit({ photos, photoZones, visionContext, thinkingLevel });
        results.push({ ...scoreResult(testCase, analysis), repeatIndex: i, inputHash: contextHash({ photos, photoZones, visionContext }) });
        log(`${testCase.assessmentId} run ${i + 1}/${repeat}: ${analysis.status}${analysis.status === 'complete' ? ` via ${analysis.provider}${analysis.fallbackUsed ? ' (fallback)' : ''}` : ` (${analysis.reason})`} ${analysis.latencyMs} ms`);
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, cases.length || 1)) }, worker));
  results.sort((a, b) => String(a.visitDate).localeCompare(String(b.visitDate)) || String(a.assessmentId).localeCompare(String(b.assessmentId)) || a.repeatIndex - b.repeatIndex);
  return { results, skipped, summary: summarize(results) };
}

module.exports = {
  PRICES_PER_M,
  SCORE_KEYS,
  dateString,
  fixtureCase,
  selectCases,
  contextFor,
  costUsd,
  scrubPriorSummary,
  billedLegs,
  sumUsage,
  legsCostUsd,
  causeNamedBelowModerate,
  scoreResult,
  summarize,
  renderMarkdown,
  runEval,
  percentile,
};
