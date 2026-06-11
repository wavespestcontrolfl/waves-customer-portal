/**
 * fact-check-gate.js — LLM fact-check for blog content before it publishes.
 *
 * The other pre-publish gates (content-guardrails, uniqueness-gate) are
 * rule-based: they catch hardcoded prices, brand-token leaks, doorway/scaled
 * content. None can catch a *factual* error — a wrong species/pathogen name, a
 * mislabeled pesticide, a bad Florida ordinance date. Those are exactly what
 * slips through and ships under the owner's FDACS-licensed "technically
 * reviewed by" byline. This gate asks a capable model to flag verifiable
 * factual mistakes so auto-content gets a fact-check without a human read.
 *
 * Contract mirrors content-guardrails: returns
 *   { pass, findings:[{severity, code, claim, issue, fix, message}], checked, model }
 * pass === no P0/P1 finding. Blocking caller throws on !pass.
 *
 * Fail-OPEN by design: if the model is unavailable, errors, or returns garbage,
 * the gate passes (and logs loudly). It's an ADDITIONAL layer — the Astro PR
 * Codex review is still a backstop — so a transient API hiccup must not stall
 * the whole publish pipeline. Disable entirely with GATE_FACTCHECK=false.
 *
 * Model: MODEL_FACTCHECK env (falls back to the flagship tier). Set
 * MODEL_FACTCHECK in Railway to point it at a specific model — no code deploy.
 */

const MODELS = require('../../config/models');
const logger = require('../logger');

let Anthropic;
try { Anthropic = require('@anthropic-ai/sdk'); } catch { Anthropic = null; }

const FACTCHECK_MODEL = process.env.MODEL_FACTCHECK || MODELS.FLAGSHIP;
// Bound how long a publish (or the autonomous publishing lock) can wait on this
// advisory check. The SDK default is a 10-minute timeout WITH retries, so a
// stalled model could hold the pipeline for many minutes before fail-open
// triggers. Cap it and don't retry — a slow check should just fail open fast.
const FACTCHECK_TIMEOUT_MS = Number.parseInt(process.env.FACTCHECK_TIMEOUT_MS, 10) || 30000;

const SYSTEM_PROMPT = `You are a meticulous fact-checker for a Southwest Florida (Manatee/Sarasota/Charlotte county) pest-control and lawn-care blog. The post will publish under a licensed pest-control operator's byline, so factual accuracy is critical.

Flag ONLY verifiable factual errors a domain expert would catch:
- Pest & turf biology: species names, pathogen names (e.g. dollar spot is Clarireedia — C. monteithiana on warm-season turf, C. jacksonii on cool-season), life cycles, host plants.
- Treatment claims: pesticide/fungicide/herbicide active ingredients and what they actually control; application facts.
- Florida specifics: county fertilizer ordinances and summer nitrogen blackout dates, climate/seasonality, geography, warm- vs cool-season turf (St. Augustine, Bahia, Zoysia, Bermuda are warm-season).
- Internal contradictions or unsupported quantitative claims.

CRITICAL — flag a statement ONLY if it is actually FALSE as written. Do NOT flag a statement that is correct but could be more complete, more precise, more nuanced, or that omits a related fact. Adding caveats, exceptions, or extra detail is NOT a finding. Examples of what NOT to flag:
- "the June 1–Sep 30 nitrogen blackout" when the ordinance also restricts phosphorus — the nitrogen claim is correct; omitting phosphorus is not an error.
- a recommended mowing height that is right for common cultivars but not every dwarf cultivar — a correct generalization is not an error.
- naming one effective active ingredient among several — listing a real, labeled option is not an error even if others exist.
A claim is only a finding if a domain expert would say it is WRONG, not merely incomplete.

Do NOT flag: writing style, tone, opinion, marketing phrasing, calls to action, formatting, or anything that is not a checkable fact. Do NOT invent problems — if every stated fact is true, return an empty list. When unsure whether something is actually wrong vs. just incomplete, do NOT flag it.

Severity (only for statements that are actually wrong). NOTE: only P0 blocks publishing — reserve it for errors you are CERTAIN about, where any competent expert would agree the statement is objectively wrong:
- P0: an OBJECTIVE, unambiguous factual error — a wrong/reversed species or pathogen name, a wrong ordinance date, an active ingredient that is genuinely NOT labeled for / does not control the named pest, illegal-timing advice, or a dangerous misidentification. The kind of thing with one correct answer that any expert would agree on.
- P1: probably wrong, OR a debatable expert judgment. JUDGMENT CALLS ARE ALWAYS P1, NEVER P0 — this includes prevalence / how common a disease is on a given turf type, host-range emphasis, efficacy rankings of labeled products, and best-practice opinions. Even if you strongly disagree with such a claim, it is P1 at most. Surfaced for review but does NOT block.
- P2: technically imprecise but not actually wrong. Do NOT use for "could add more detail."

Return ONLY JSON, no prose:
{"findings":[{"severity":"P0|P1|P2","claim":"<exact quoted text from the post>","issue":"<what's wrong and why>","fix":"<the correction>"}]}
Empty findings array means the content is factually clean.`;

function normalizeFinding(f) {
  // The model's severity is only prompt-constrained, so normalize casing/space
  // ("p1", "P1 ") before the allowlist — otherwise a real P0/P1 gets demoted to
  // the non-blocking P2 and ships.
  const sev = String((f && f.severity) || '').trim().toUpperCase();
  const severity = ['P0', 'P1', 'P2'].includes(sev) ? sev : 'P2';
  const claim = String((f && f.claim) || '').slice(0, 300);
  const issue = String((f && f.issue) || '').slice(0, 600);
  const fix = String((f && f.fix) || '').slice(0, 600);
  const message = `${claim ? `"${claim.slice(0, 90)}" — ` : ''}${issue.slice(0, 180)}`;
  return { severity, code: 'FACTUAL_ERROR', claim, issue, fix, message };
}

/**
 * @param {{title?:string, body:string, city?:string, keyword?:string, tag?:string}} draft
 * @returns {Promise<{pass:boolean, findings:Array, checked:boolean, model?:string, skipped?:string}>}
 */
async function evaluate({ title = '', body = '', city = '', keyword = '', tag = '' } = {}) {
  if (process.env.GATE_FACTCHECK === 'false') {
    return { pass: true, findings: [], checked: false, skipped: 'disabled' };
  }
  if (!Anthropic || !process.env.ANTHROPIC_API_KEY) {
    logger.warn('[fact-check-gate] Anthropic SDK / API key unavailable — passing (fail-open)');
    return { pass: true, findings: [], checked: false, skipped: 'no_api' };
  }
  if (!body || body.trim().length < 50) {
    return { pass: true, findings: [], checked: false, skipped: 'empty_body' };
  }

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 0,
    timeout: FACTCHECK_TIMEOUT_MS,
  });
  let raw;
  try {
    const response = await anthropic.messages.create({
      model: FACTCHECK_MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: `City: ${city || '(none)'}\nKeyword: ${keyword || '(none)'}\nTag: ${tag || '(none)'}\nTitle: ${title || '(none)'}\n\n--- POST BODY ---\n${body}`,
      }],
    });
    raw = response.content[0].text;
  } catch (err) {
    logger.warn(`[fact-check-gate] check failed for "${title}" — passing (fail-open): ${err.message}`);
    return { pass: true, findings: [], checked: false, skipped: 'api_error' };
  }

  let parsed;
  try {
    parsed = JSON.parse(String(raw).replace(/```json|```/g, '').trim());
  } catch {
    logger.warn(`[fact-check-gate] unparseable model output for "${title}" — passing (fail-open)`);
    return { pass: true, findings: [], checked: false, skipped: 'parse_error' };
  }

  const findings = (Array.isArray(parsed.findings) ? parsed.findings : []).map(normalizeFinding);
  // Block ONLY on P0 (objective, unambiguous errors). P1/P2 are debatable
  // expert nuance — surfaced as advisory but never blocking, so the gate
  // doesn't false-positive-block correct-but-arguable content. (A live sanity
  // run showed an LLM reliably flags debatable agronomy at P1; blocking on that
  // would stall accurate posts.)
  const pass = !findings.some((f) => f.severity === 'P0');
  return { pass, findings, checked: true, model: FACTCHECK_MODEL };
}

module.exports = { evaluate, _internals: { normalizeFinding, FACTCHECK_MODEL } };
