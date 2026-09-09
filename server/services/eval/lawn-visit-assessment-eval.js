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

const { applySeasonalAdjustment, getSeason } = require('../lawn-assessment');
const { deriveLegacyScores, adjustAvailableScores, contextHash } = require('../lawn-visit-assessment');
const { SUMMARY_CAUSE_RE, CUSTOMER_TEXT_URL, CUSTOMER_TEXT_EMAIL, CUSTOMER_TEXT_PHONE, STREET_ADDRESS } = require('../lawn-diagnostic-report');
const { containsReportAccessCode } = require('../service-report/technician-report-copy');
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
// The naming-discipline vocabulary is the production one: the naming gate's
// species / condition patterns PLUS the report lane's governed-cause lexicon
// (SUMMARY_CAUSE_RE — generic fungus / disease / insect / pest terms too), so
// a low-confidence "fungal activity" or "insect damage" counts as a cause
// named below moderate exactly as the customer egress treats it (Codex
// #4153 r7).
const ANY_CAUSE = [...Object.values(CAUSE_PATTERNS), SUMMARY_CAUSE_RE];

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
  // A photo whose upload failed is stored under a `pending/` key, but the
  // scores were computed from the full submitted set — a replay on the rest
  // would compare a partial-input answer against full-input scores, so the
  // case is exported photo-less and skipped, never replayed partially
  // (Codex #4153 r8).
  // … or when fewer rows were stored than the visit submitted (the route
  // swallows a failed row insert and still returns success — the
  // assessment's own `photos` metadata lists every submitted image).
  const submitted = parseJson(row.photos, []);
  const incompletePhotos = photos.some((photo) => photo && String(photo.s3_key || '').startsWith('pending/'))
    || (Array.isArray(submitted) && submitted.length > photos.filter(Boolean).length);
  return {
    assessmentId: row.id,
    customerId: row.customer_id,
    serviceId: row.service_id || null,
    visitDate,
    month,
    season: row.season || null,
    confirmed: Object.fromEntries(SCORE_KEYS.map((key) => [key, numberOrNull(row[key])])),
    legacyAi: Object.fromEntries(SCORE_KEYS.map((key) => [key, numberOrNull(composite[key])])),
    incompletePhotos,
    photos: (incompletePhotos ? [] : photos)
      .filter((photo) => photo && photo.s3_key)
      .sort((a, b) => (a.photo_order ?? 0) - (b.photo_order ?? 0))
      .map((photo) => ({ id: photo.id, s3Key: photo.s3_key, mimeType: photo.mime_type || 'image/jpeg', zone: photo.zone || null })),
    context: {
      grassType: context.grassType || null,
      irrigation: context.irrigation || null,
      // Every context field the exporter could NOT prove visit-time is
      // omitted AND named here with its reason, so a replay that ran without
      // it is never silent about it (Codex #4153 r13/r14): the report counts
      // them. Also a prior summary this module itself withheld.
      omitted: [
        ...(Array.isArray(context.omitted) ? context.omitted : []),
        ...(context.priorSummary && nameCollidesWithVocabulary(context.priorSummary, context.customerNames) ? [{ field: 'priorSummary', reason: 'customer_name_is_lawn_vocabulary' }] : []),
      ],
      // Only a captured analysis-time reading can reproduce the prompt.
      // Legacy exports omit it; completion readings may have changed since
      // Analyze. Retain the route's accepted 0.5–8 in range for supplied context.
      turfHeightIn: turfHeightInRange(context.turfHeightIn),
      priorSummary: scrubPriorSummary(context.priorSummary, context.customerNames),
    },
  };
}
function turfHeightInRange(value) {
  const n = numberOrNull(value);
  return n != null && n >= 0.5 && n <= 8 ? n : null;
}

// The previous visit's ai_summary was written by a model that was given the
// customer's full name (knowledge-bridge), so the fixture copy goes through
// PII removal (phones, emails, URLs, street addresses), preserving products
// and diagnoses, then loses every known customer-name token —
// the stored first and last name, each in full AND word by word, with and
// without diacritics, so a summary that says only "Mary" of a "Mary Jane",
// or "Jose" of a "José", is scrubbed too (Codex #4153 r5) — before it is
// replayed. Word boundaries are Unicode-aware (JS `\b` knows ASCII letters
// only, so "José" never matched at the end of a word). Null when nothing
// is left.
const NAME_TOKEN_MIN_LENGTH = 2; // an initial is not a name
const withoutDiacritics = (value) => value.normalize('NFD').replace(/\p{M}+/gu, '');
function customerNameTokens(customerNames) {
  const tokens = new Set();
  for (const value of customerNames || []) {
    const full = String(value || '').trim();
    for (const token of [full, ...full.split(/[^\p{L}\p{N}]+/u)]) {
      if (token.length >= NAME_TOKEN_MIN_LENGTH) { tokens.add(token); tokens.add(withoutDiacritics(token)); }
    }
  }
  return [...tokens].sort((a, b) => b.length - a.length);
}
// A customer name that is also lawn vocabulary ("Brown", "Green", "Moss",
// "Fields") cannot be scrubbed without rewriting agronomic evidence ("brown
// patches" → "the customer patches"), and cannot be left in: the summary is
// omitted whole (Codex #4153 r14).
const LAWN_VOCABULARY = new Set(('brown green gray grey white black yellow patch patches moss rose bush field fields lawn lawns grass hill hills wood woods stone rock sand marsh dew rain storm frost weed weeds '
  + 'spring summer fall winter shade sun sunny root roots leaf leaves bloom flower flowers plant garden gardener meadow grove park lake brook river ash oak pine palm cypress maple hedge thorn berry '
  + 'bug bugs worm worms moth chinch grub sedge clover spurge drought water sprinkler mow edge turf blade blades soil clay').split(/\s+/));
function nameCollidesWithVocabulary(text, customerNames = []) {
  const summary = String(text || '').toLowerCase();
  return [...customerNameTokens(customerNames)].some((token) => {
    const lower = token.toLowerCase();
    return (LAWN_VOCABULARY.has(lower) || SUMMARY_CAUSE_RE.test(lower)) && new RegExp(`(?<![\\p{L}\\p{N}])${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'iu').test(summary);
  });
}
// PII only — the report lane's scrubCustomerText also softens confirmed
// language and replaces product names, which would hand the replay weaker
// agronomic evidence than the live call received (Codex #4153 r15): here
// only URLs, emails, phones and street addresses go, then the customer's
// name tokens and any access code.
function scrubPii(text) {
  return String(text)
    .replace(CUSTOMER_TEXT_URL, '')
    .replace(CUSTOMER_TEXT_EMAIL, '')
    .replace(CUSTOMER_TEXT_PHONE, '')
    .replace(STREET_ADDRESS, 'the property')
    .replace(/\s{2,}/g, ' ')
    .trim();
}
function scrubPriorSummary(text, customerNames = []) {
  if (!text) return null;
  if (nameCollidesWithVocabulary(text, customerNames)) return null;
  let out = scrubPii(text);
  for (const token of customerNameTokens(customerNames)) {
    out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![\\p{L}\\p{N}])`, 'giu'), 'the customer');
  }
  out = out.replace(/\b(?:Mr|Mrs|Ms|Miss|Dr)\.?\s+the customer\b/g, 'the customer').replace(/\bthe customer(?:\s+the customer)+\b/g, 'the customer').trim();
  // The scrubber does not know access codes; a summary that repeats a gate /
  // garage / lockbox credential (the report's detector) is omitted whole —
  // no credential ever enters a fixture file (Codex #4153 r8).
  if (containsReportAccessCode(out)) return null;
  // The whole scrubbed value: the live route passes the entire summary, so a
  // cap here would replay a different prompt (Codex #4153 r13).
  return out || null;
}

// Deterministic selection, in the population's order: the explicit ids plus
// a stable pseudo-random sample keyed on the id (so two runs pick the same
// set) — the export's `--ids … --sample N` is their union, each case once;
// neither asked for is every case.
function selectCases(cases, { ids = [], sample = null } = {}) {
  if (!ids.length && !sample) return cases;
  const wanted = new Set(ids.map(String));
  const sampled = cases.map((c) => ({ c, k: hashKey(c.assessmentId) })).sort((a, b) => a.k.localeCompare(b.k)).slice(0, sample || 0);
  for (const { c } of sampled) wanted.add(String(c.assessmentId));
  return cases.filter((c) => wanted.has(String(c.assessmentId)));
}
function hashKey(value) {
  let h = 2166136261;
  for (const ch of String(value)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return h.toString(16).padStart(8, '0');
}

// The known-visit context the route would build for this visit — season and
// month from the VISIT date, grass / irrigation on file, the visit's gauge
// reading, the previous visit's summary. No technician notes (not stored)
// and never the planned products.
function contextFor(testCase) {
  const context = { region: 'Southwest Florida' };
  // The season is the route's own classifier (lawn-assessment.getSeason) — the
  // one the score adjustment uses too — never a parallel month map that could
  // drift from the live prompt's claim (Codex #4153 r11).
  if (testCase.month) { context.month = testCase.month; context.season = getSeason(testCase.month); }
  if (testCase.context?.grassType) context.grassType = testCase.context.grassType;
  if (testCase.context?.turfHeightIn != null) context.turfHeightIn = testCase.context.turfHeightIn;
  if (testCase.context?.irrigation) context.irrigation = testCase.context.irrigation;
  if (testCase.context?.priorSummary) context.priorSummary = testCase.context.priorSummary;
  return context;
}

// ── Scoring (pure) ────────────────────────────────────────────────────
// Null unless the model is priced AND the usage carries real input and
// output counts: llm/call.js hands back a usage object with null counts when
// a provider omits its metadata, and that is an unknown charge, not $0
// (Codex #4153 r13).
function costUsd(model, usage) {
  const price = PRICES_PER_M[String(model || '')];
  if (!price || !usage) return null;
  const input = numberOrNull(usage.input_tokens);
  const outputBase = numberOrNull(usage.output_tokens);
  if (input == null || outputBase == null) return null;
  const output = outputBase + (price.reasoningSeparate ? (numberOrNull(usage.reasoning_tokens) || 0) : 0);
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

// The chain's cost is known only when EVERY billed leg is priced: one leg on
// a model PRICES_PER_M does not list (a registry override) makes the whole
// chain an unknown spend — a partial sum would present the priced legs as
// the total and understate paid usage (Codex #4153 r11). `unpricedLegs`
// says how many legs were left out.
function legsCostUsd(legs) {
  if (!legs.length) return null;
  const priced = legs.map((leg) => costUsd(leg.model, leg.usage));
  if (priced.some((value) => value == null)) return null;
  return Math.round(priced.reduce((sum, value) => sum + value, 0) * 1e4) / 1e4;
}
function unpricedLegCount(legs) {
  return legs.filter((leg) => costUsd(leg.model, leg.usage) == null).length;
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
    unpricedLegs: unpricedLegCount(legs),
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
    // Traceability/quality gates can downgrade the normalized confidence;
    // naming discipline measures what the model actually claimed.
    causeNamedBelowModerate: causeNamedBelowModerate(analysis.raw.findings),
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
    // Runs that replayed without context the exporter could not prove visit-time, per field.
    contextOmitted: contextOmissions(results),
    latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    tokens: {
      input: results.reduce((sum, r) => sum + (Number(r.usage?.input_tokens) || 0), 0),
      output: results.reduce((sum, r) => sum + (Number(r.usage?.output_tokens) || 0), 0),
      reasoning: results.reduce((sum, r) => sum + (Number(r.usage?.reasoning_tokens) || 0), 0),
    },
    // No priced leg (a registry override selecting a model PRICES_PER_M does
    // not list) is an UNKNOWN spend, never $0 (Codex #4153 r8).
    // A run with an unpriced leg is outside the total (its spend is unknown), and is counted so the report discloses it.
    costUsd: { total: costs.length ? round(costs.reduce((sum, v) => sum + v, 0), 4) : null, perRun: costs.length ? round(mean(costs), 4) : null, priced: costs.length, unpriced: results.filter((r) => (r.unpricedLegs || 0) > 0).length },
    repeatVariance: variance,
  };
}

const unpricedNote = (summary) => (summary.costUsd.unpriced ? `, ${summary.costUsd.unpriced} with an unpriced leg — spend unknown` : '');
function contextOmissions(results) {
  const byField = {};
  let runs = 0;
  for (const r of results) {
    const omitted = Array.isArray(r.contextOmitted) ? r.contextOmitted : [];
    if (omitted.length) runs += 1;
    for (const entry of omitted) byField[entry.field] = (byField[entry.field] || 0) + 1;
  }
  return { runs, byField };
}
const omittedNote = (summary) => (summary.contextOmitted?.runs
  ? `context omitted (not provably visit-time) in ${summary.contextOmitted.runs} run(s): ${Object.entries(summary.contextOmitted.byField).map(([field, n]) => `${field} ×${n}`).join(', ')}`
  : 'no context omitted');
// Every report names what it ran: the prompt version AND digest (a shared
// rubric block can change without a version bump) and the fixture's
// property-history branch, so gate-on and gate-off runs, and runs across a
// silent prompt change, stay distinguishable after the output is redirected
// (Codex #4153 r15).
function provenanceLine({ promptVersion, promptDigest, propertyHistory } = {}) {
  const history = propertyHistory === true ? 'on' : propertyHistory === false ? 'off' : 'unknown';
  return `prompt ${promptVersion || 'unknown'} · digest ${promptDigest || 'unknown'} · fixture property history ${history}`;
}
function renderMarkdown(summary, results = [], { title = 'Lawn visit assessment eval', promptVersion, promptDigest, propertyHistory } = {}) {
  const lines = [`## ${title}`, '', provenanceLine({ promptVersion, promptDigest, propertyHistory })];
  lines.push(`runs ${summary.runs} · cases ${summary.cases} · unavailable ${summary.unavailable} (${fmtRate(summary.unavailableRate)}) · findings/run ${summary.findingsPerRun ?? 'n/a'} · cause named below moderate: ${summary.causeNamedBelowModerate}`);
  lines.push(`latency p50 ${summary.latencyMs.p50 ?? 'n/a'} ms · p95 ${summary.latencyMs.p95 ?? 'n/a'} ms · tokens in ${summary.tokens.input} / out ${summary.tokens.output} / reasoning ${summary.tokens.reasoning} · est. cost $${summary.costUsd.total ?? 'n/a'} ($${summary.costUsd.perRun ?? 'n/a'} per run, ${summary.costUsd.priced} priced${unpricedNote(summary)})`);
  lines.push(`answered by: ${Object.entries(summary.byProvider).map(([k, v]) => `${k} ×${v}`).join(', ') || 'n/a'}`);
  lines.push(omittedNote(summary), '');
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
      if (testCase.incompletePhotos) { skipped.push({ assessmentId: testCase.assessmentId, reason: 'incomplete stored photo set' }); continue; }
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
        results.push({ ...scoreResult(testCase, analysis), repeatIndex: i, inputHash: contextHash({ photos, photoZones, visionContext }), contextOmitted: Array.isArray(testCase.context?.omitted) ? testCase.context.omitted : [] });
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
  scrubPii,
  provenanceLine,
  nameCollidesWithVocabulary,
  contextOmissions,
  billedLegs,
  sumUsage,
  legsCostUsd,
  unpricedLegCount,
  causeNamedBelowModerate,
  scoreResult,
  summarize,
  renderMarkdown,
  runEval,
  percentile,
};
