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

Do NOT flag: writing style, tone, opinion, marketing phrasing, calls to action, formatting, or anything that is not a checkable fact. Do NOT invent problems — if the content is factually sound, return an empty list.

Severity:
- P0: clearly wrong fact that misleads or could cause harm (wrong active ingredient, illegal-timing advice, dangerous misidentification).
- P1: likely wrong or misattributed fact (wrong species/pathogen, wrong ordinance date).
- P2: imprecise or needs nuance, but not strictly wrong.

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
  const pass = !findings.some((f) => f.severity === 'P0' || f.severity === 'P1');
  return { pass, findings, checked: true, model: FACTCHECK_MODEL };
}

module.exports = { evaluate, _internals: { normalizeFinding, FACTCHECK_MODEL } };
