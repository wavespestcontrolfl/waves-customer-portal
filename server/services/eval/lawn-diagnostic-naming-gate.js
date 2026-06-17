/**
 * lawn-diagnostic-naming-gate.js — live-model eval for the Lawn Diagnostic prompt's
 * v0.4 "naming gate": a cause may be NAMED only when its minimum-evidence signature
 * is visible; otherwise the finding must stay a SYMPTOM at low/unknown confidence,
 * and the customer summary may never upgrade a symptom into a named pest/disease.
 *
 * Why this exists when jest tests already cover the contract: the unit tests mock
 * (or never call) the model, so they lock the CODE contract but can't see whether
 * the MODEL actually honors the gate on messy real photos. This harness replays a
 * curated fixture set of real lawn photos through the LIVE runDiagnosis (+ optional
 * runNarrative) pass and scores each against structured naming-gate expectations.
 *
 * Contract (mirrors server/services/eval/incident-regression.js):
 *   - Fixtures are photos + non-PII expectations in server/fixtures/lawn-diagnostic-eval/.
 *   - LLM output is non-deterministic, so a failing case is retried once; pass-on-retry
 *     is reported as flaky, not failing. Only a clean PASS clears a case.
 *   - The pure scorers (evaluateFindings / evaluateNarrative) take no model and no I/O,
 *     so they are unit-tested in jest; the live runner is opt-in (needs ANTHROPIC_API_KEY
 *     + committed photos) and never runs in CI.
 *
 * Manual run: node server/scripts/run-lawn-diagnostic-eval.js [--json] [--case <id>]
 */

const fs = require('fs');
const path = require('path');

const DEFAULT_FIXTURE_DIR = path.join(__dirname, '..', '..', 'fixtures', 'lawn-diagnostic-eval');
const IMAGE_EXT = /\.(jpe?g|png|webp|heic)$/i;

// ── Lexicons (shared by the pure scorers) ─────────────────────────────────────
const CONFIDENCE_RANK = { unknown: 0, low: 1, moderate: 2, high: 3 };

// Named causes the naming gate governs. A finding may only carry one of these names
// at moderate+ confidence when its Required signature was met.
const CAUSE_PATTERNS = {
  chinch: /\bchinch\b/i,
  large_patch: /\blarge patch\b|\brhizoctonia\b/i,
  brown_patch: /\bbrown patch\b/i,
  gray_leaf_spot: /\bgr[ae]y leaf spot\b/i,
  dollar_spot: /\bdollar spot\b/i,
  take_all: /\btake[-\s]?all\b|\bTARR\b/i,
  nutsedge: /\b(nut)?sedge\b/i,
  crabgrass: /\bcrabgrass\b/i,
  dollarweed: /\bdollarweed\b/i,
  grub: /\bgrub\b/i,
  armyworm: /\barmyworm\b|\bsod\s?webworm\b/i,
  iron_deficiency: /\biron (deficiency|chlorosis)\b/i,
  nitrogen_deficiency: /\bnitrogen deficiency\b/i,
  magnesium_deficiency: /\bmagnesium deficiency\b/i,
  drought: /\bdrought\b/i,
};

// Any named cause at all (used to decide whether a finding name is a "symptom").
const ANY_CAUSE = new RegExp(
  Object.values(CAUSE_PATTERNS).map((re) => re.source).join('|'),
  'i',
);

const SYMPTOM_TERMS = /\b(brown(ing|ed)?|thinn?ing|thin|yellow(ing)?|discolor\w*|color stress|weed pressure|patch[-\s]pattern|stress(ed)?|sparse|bare|spots?|decline|monitor)\b/i;

// Customer copy must never carry these (mirrors lawn-diagnostic-report scrub list).
const BRAND_TERMS = /\b(talstar|arena|celsius|sedgehammer|prodiamine|dimension|barricade|bifenthrin|fipronil|imidacloprid|acelepryn|chlorantraniliprole|tenacity|mesotrione)\b/i;
const CODE_TERMS = /\b(FRAC|IRAC|HRAC)\b/;
const OVERPROMISE_TERMS = /\b(guarantee[d]?|100%|eliminate|pest[-\s]free|cure)\b/i;

function rank(confidence) {
  return CONFIDENCE_RANK[String(confidence || '').toLowerCase()] ?? 0;
}

function causePattern(token) {
  if (CAUSE_PATTERNS[token]) return CAUSE_PATTERNS[token];
  // Freeform fallback: word-boundary match on the raw token.
  const escaped = String(token).replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '[\\s_-]');
  return new RegExp(`\\b${escaped}\\b`, 'i');
}

// ── Pure scorers (no model, no I/O — unit-tested) ─────────────────────────────

/**
 * Score a findings array against a case's naming-gate expectations.
 * Returns { ok, checks: [{ name, pass, detail }], passed, failed }.
 */
function evaluateFindings(findings = [], expect = {}) {
  const list = Array.isArray(findings) ? findings.filter((f) => f && typeof f === 'object') : [];
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });

  if (expect.maxConfidence) {
    const cap = rank(expect.maxConfidence);
    const worst = list.reduce((m, f) => Math.max(m, rank(f.confidence)), 0);
    add('max-confidence', worst <= cap, `worst=${worst} cap(${expect.maxConfidence})=${cap}`);
  }

  // The cause must not appear as a finding NAME at moderate+ confidence. (A low/unknown
  // differential that names the cause with a confirmation step is allowed by the gate.)
  for (const token of expect.forbidNamedCause || []) {
    const re = causePattern(token);
    const offenders = list.filter((f) => re.test(String(f.name || '')) && rank(f.confidence) >= CONFIDENCE_RANK.moderate);
    add(`forbid-named:${token}`, offenders.length === 0, offenders.map((o) => `${o.name}@${o.confidence}`).join(', '));
  }

  if (expect.expectSymptomPrimary) {
    const primary = list[0];
    const name = String(primary?.name || '');
    const isSymptom = !!primary && SYMPTOM_TERMS.test(name) && !ANY_CAUSE.test(name);
    add('symptom-primary', isSymptom, `primary=${name || '(none)'}`);
  }

  // Positive cases: when the signature IS present the model SHOULD still name the cause
  // (guards against over-correction into vague mush).
  for (const token of expect.allowNamedCause || []) {
    const re = causePattern(token);
    const minRank = rank(expect.minConfidence || 'moderate');
    const found = list.some((f) => re.test(String(f.name || '')) && rank(f.confidence) >= minRank);
    add(`names-cause:${token}`, found, found ? '' : `no ${token} finding at >= ${expect.minConfidence || 'moderate'}`);
  }

  if (expect.requireConfirmationStep) {
    const has = list.some((f) => String(f.confirmation_step || '').trim().length > 0);
    add('confirmation-step', has);
  }

  if (expect.forbidBrandsInWording) {
    const offenders = list.filter((f) => {
      const w = String(f.customer_wording || '');
      return BRAND_TERMS.test(w) || CODE_TERMS.test(w);
    });
    add('no-brands-in-wording', offenders.length === 0, offenders.map((o) => o.customer_wording).join(' | '));
  }

  return summarize(checks);
}

/**
 * Score a customer_summary string against a case's narrative expectations.
 */
function evaluateNarrative(summary = '', expect = {}) {
  const text = String(summary || '');
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail: detail || '' });

  for (const token of expect.forbidNamedCause || []) {
    const re = causePattern(token);
    add(`narrative-no-named:${token}`, !re.test(text), re.test(text) ? token : '');
  }
  if (expect.forbidBrands) {
    add('narrative-no-brands', !BRAND_TERMS.test(text) && !CODE_TERMS.test(text));
  }
  if (expect.forbidOverpromise) {
    add('narrative-no-overpromise', !OVERPROMISE_TERMS.test(text));
  }
  if (expect.nonEmpty) {
    add('narrative-non-empty', text.trim().length > 0);
  }
  return summarize(checks);
}

function summarize(checks) {
  const passed = checks.filter((c) => c.pass).length;
  return { ok: checks.every((c) => c.pass), checks, passed, failed: checks.length - passed };
}

// ── Live runner (opt-in; needs API key + committed photos) ────────────────────

function loadCases(fixtureDir = DEFAULT_FIXTURE_DIR) {
  const file = path.join(fixtureDir, 'cases.json');
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { ...parsed, cases: Array.isArray(parsed.cases) ? parsed.cases : [] };
}

function loadCasePhotos(testCase, fixtureDir = DEFAULT_FIXTURE_DIR) {
  const dir = path.join(fixtureDir, 'photos');
  const photos = [];
  for (const name of testCase.photos || []) {
    const file = path.join(dir, name);
    if (!IMAGE_EXT.test(name) || !fs.existsSync(file)) return null; // missing → case skipped
    const ext = name.split('.').pop().toLowerCase();
    const mimeType = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
    photos.push({ data: fs.readFileSync(file).toString('base64'), mimeType });
  }
  return photos.length ? photos : null;
}

/**
 * Replay one case through the live diagnosis (+ optional narrative) pass and score it.
 * Retries once on a failed/errored attempt (non-determinism) before declaring failure.
 */
async function runCase(testCase, deps, fixtureDir = DEFAULT_FIXTURE_DIR) {
  const { runDiagnosis, runNarrative, buildDiagnosticReportContract } = deps;
  const photos = loadCasePhotos(testCase, fixtureDir);
  if (!photos) return { id: testCase.id, status: 'skipped', reason: 'missing photo fixture' };

  const attempt = async () => {
    const ctx = testCase.context || {};
    const diag = await runDiagnosis({ photos, ...ctx });
    if (!diag.ok) return { ok: false, reason: diag.reason || 'diagnosis_failed', checks: [] };

    const findingsResult = evaluateFindings(diag.findings, testCase.expect || {});
    let narrativeResult = null;
    if (testCase.narrative) {
      const contract = buildDiagnosticReportContract({
        findings: diag.findings,
        products: ctx.products || [],
        compliance: ctx.compliance || {},
        seasonal_context: ctx.seasonal_context || '',
      });
      const nar = await runNarrative(contract, { season: ctx.season });
      narrativeResult = evaluateNarrative(nar.ok ? nar.customer_summary : '', testCase.narrative);
    }
    const checks = [...findingsResult.checks, ...(narrativeResult ? narrativeResult.checks : [])];
    return { ok: checks.every((c) => c.pass), checks, findings: diag.findings };
  };

  let result = await attempt();
  let flaky = false;
  if (!result.ok) {
    const retry = await attempt();
    if (retry.ok) { flaky = true; result = retry; }
    else result = retry; // report the retry's checks
  }

  return {
    id: testCase.id,
    description: testCase.description,
    status: result.ok ? (flaky ? 'flaky' : 'pass') : 'fail',
    checks: result.checks,
    failedChecks: (result.checks || []).filter((c) => !c.pass),
    reason: result.reason,
  };
}

/**
 * Run the full eval (or a single --case). Returns a summary object; never throws.
 * deps is injected so the runner stays testable; the CLI wires the real modules.
 */
async function runLawnDiagnosticEval({ caseId, fixtureDir = DEFAULT_FIXTURE_DIR, deps } = {}) {
  const resolvedDeps = deps || {
    ...require('../lawn-diagnostic-prompt'),
    buildDiagnosticReportContract: require('../lawn-diagnostic-report').buildDiagnosticReportContract,
  };
  const { promptVersion = null, cases } = loadCases(fixtureDir);
  const selected = caseId ? cases.filter((c) => c.id === caseId) : cases;

  const results = [];
  for (const testCase of selected) {
    // Sequential, not parallel: a model eval should not fan out and hammer the API.
    results.push(await runCase(testCase, resolvedDeps, fixtureDir)); // eslint-disable-line no-await-in-loop
  }

  const counts = results.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
  const scored = results.filter((r) => r.status !== 'skipped').length;
  const cleared = (counts.pass || 0) + (counts.flaky || 0);
  return {
    promptVersion,
    total: cases.length,
    scored,
    passRate: scored ? cleared / scored : null,
    counts,
    results,
  };
}

module.exports = {
  // pure scorers (unit-tested)
  evaluateFindings,
  evaluateNarrative,
  // live runner + helpers
  runLawnDiagnosticEval,
  runCase,
  loadCases,
  loadCasePhotos,
  // exposed for tests/reuse
  CAUSE_PATTERNS,
  DEFAULT_FIXTURE_DIR,
};
