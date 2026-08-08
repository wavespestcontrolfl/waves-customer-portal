/**
 * compliance-gate.js — LLM semantic check for the two compliance hard codes
 * (REENTRY_SAFETY_CLAIM, BANNED_TOPIC) before content publishes.
 *
 * WHY THIS EXISTS. content-guardrails.js enforces the same two rules with
 * regexes, and 23 rounds of adversarial review hardened it to ~48 findings.
 * Three consecutive rounds then produced a RULE defect in the same exemption:
 *   r21  "safe UNTIL dry"                     — inverse polarity
 *   r22  "safe WHILE WET AND once dry"        — a competing pre-dry condition
 *   r23  "safe for pets AND WORKS after it dries"
 * r23 is the one the regex representation cannot express. Whether the
 * approved idiom applies depends on which predicate the dry clause ATTACHES
 * to — it governs `safe` in "the treatment is safe once dry" (exempt) and
 * `works` in "the treatment is safe for pets and works after it dries"
 * (a bare unconditional safety claim, must block). That is syntactic
 * attachment, not pattern matching; every additional branch only moves the
 * failure to the next phrasing.
 *
 * So this gate reads the copy for MEANING. The regex layer stays exactly as
 * it is — fail-closed, authoritative for everything it does match, and no
 * longer growing.
 *
 * Contract mirrors content-guardrails and fact-check-gate:
 *   { pass, findings:[{severity, code, claim, issue, fix, message}], checked, model }
 * The codes are the EXISTING ones, not new ones, so gate-retry-directives
 * lookup, reviewer notes, and the writer's redraft path all work unchanged.
 *
 * Fail-OPEN by design, same as fact-check-gate: the regex layer is still
 * fail-closed and still runs, so this is defense in depth — a transient API
 * hiccup must not stall the publish pipeline.
 *
 * SHIPS DARK. The gate is OFF unless GATE_COMPLIANCE=true. It P0-blocks a
 * publish, and its precision against real copy has not been measured yet —
 * enabling an unvalidated blocking gate on the auto-publish path would park
 * legitimate drafts for reasons nobody has checked. Run
 * `node ops/agents/compliance-gate-eval.js --all` (needs live API keys) to get
 * recall/precision over the 389-case labelled corpus, then flip the flag. If
 * precision is poor, tune the prompt before enabling rather than shipping the
 * block. Once enabled, GATE_COMPLIANCE=false is the one-click revoke.
 *
 * Model: MODEL_COMPLIANCE env swaps the Anthropic leg only; the cross-provider
 * fallback stays (no single-provider dependency for a publish gate).
 */

const MODELS = require('../../config/models');
const logger = require('../logger');
const { dispatchWithFallback } = require('../llm/call');
const { GATE_RETRY_INSTRUCTIONS } = require('./gate-retry-directives');

const COMPLIANCE_MODEL_OVERRIDE = process.env.MODEL_COMPLIANCE || null;
// Same 60s ceiling and no-retry posture as fact-check-gate: DEEP thinks before
// answering, and a slow check must fail open fast rather than hold the publish
// (or the autonomous publishing lock) for the SDK's 10-minute retrying default.
const COMPLIANCE_TIMEOUT_MS = Number.parseInt(process.env.COMPLIANCE_TIMEOUT_MS, 10) || 60000;

// Only these two — a code outside the set is a model hallucination and is
// dropped rather than surfaced under a name nothing downstream understands.
const VALID_CODES = new Set(['REENTRY_SAFETY_CLAIM', 'BANNED_TOPIC']);

// The rule text is NOT restated here. gate-retry-directives.js is already the
// single source of truth consumed by the writer prompts, precisely so that
// instruction and enforcement can never drift; this gate reads from the same
// constant, so a rule change lands in one place and reaches writer, redraft
// directive, and semantic gate together.
const SYSTEM_PROMPT = `You are a compliance reviewer for a Southwest Florida (Manatee/Sarasota/Charlotte county) pest-control and lawn-care company. Content publishes under an FDACS-licensed operator's byline, so these two rules are legal hard lines, not style preferences.

RULE 1 — REENTRY_SAFETY_CLAIM
${GATE_RETRY_INSTRUCTIONS.REENTRY_SAFETY_CLAIM}

RULE 2 — BANNED_TOPIC
${GATE_RETRY_INSTRUCTIONS.BANNED_TOPIC}

THE APPROVED SAFETY IDIOM — read it as a structural condition, not a phrase.
A safety statement is acceptable ONLY when BOTH hold:
  (a) the claim is CONDITIONAL on the treated surface being dry, and that dry
      condition GOVERNS THE SAFETY PREDICATE ITSELF; and
  (b) a technician-confirms-the-timing clause is present nearby.

Judge (a) by what the clause modifies, not by whether the words co-occur:
  ACCEPTABLE  "The treatment is safe once dry. Your technician confirms the timing."
              -> "once dry" governs "is safe".
  VIOLATION   "The treatment is safe for pets and works after it dries. Your technician confirms the timing."
              -> "after it dries" governs "works". "safe for pets" is left
                 UNCONDITIONAL, so this is a bare safety claim.
  VIOLATION   "The treatment is safe until dry."
              -> claims safety DURING the wet period, the inverse of the rule.
  VIOLATION   "The treatment is safe while wet and once dry."
              -> asserts safety in the wet state too.
A timing or drying clause attached to any other predicate (works, dries,
absorbs, bonds, activates) NEVER earns the exemption for a safety claim.

Negated or disclaiming copy is COMPLIANT and must not be flagged: "no product
is completely safe", "we do not offer wildlife trapping", "the treatment will
not be safe until it dries", "wildlife removal is not offered by Waves".
Purely informational mentions of a banned topic are compliant — the rule bans
presenting it as OUR service, not discussing what the method is.

Flag ONLY actual violations of the two rules above. Do NOT flag writing style,
tone, marketing phrasing, calls to action, or copy that is merely incomplete or
could be more precise. If the copy complies, return an empty list.

Severity — ONLY P0 blocks publishing, so reserve it for the unambiguous:
- P0: a clear violation any compliance reviewer would agree on — an
  unconditional safety claim about a pesticide/treatment/treated area, a
  pet-safe/child-safe/family-safe compound, "EPA-approved", a fixed
  re-entry/drying figure, or a first-person offer of door-to-door sales,
  structural fumigation/tenting, insulation, or wildlife/animal trapping.
- P1: probably a violation, or a judgment call. Surfaced for review, does NOT
  block. When you are unsure whether something crosses the line, use P1.
- P2: technically loose but not a violation.

Return ONLY JSON, no prose:
{"findings":[{"severity":"P0|P1|P2","code":"REENTRY_SAFETY_CLAIM|BANNED_TOPIC","claim":"<exact quoted text from the content>","issue":"<which rule it breaks and why>","fix":"<compliant rewrite>"}]}
An empty findings array means the content is compliant.`;

function normalizeFinding(f) {
  // Severity is only prompt-constrained, so normalize casing/space before the
  // allowlist — otherwise a real P0 lands outside the set and gets demoted to
  // the non-blocking P2 and ships (the same trap fact-check-gate guards).
  const sev = String((f && f.severity) || '').trim().toUpperCase();
  const severity = ['P0', 'P1', 'P2'].includes(sev) ? sev : 'P2';
  const rawCode = String((f && f.code) || '').trim().toUpperCase();
  const code = VALID_CODES.has(rawCode) ? rawCode : null;
  const claim = String((f && f.claim) || '').slice(0, 300);
  const issue = String((f && f.issue) || '').slice(0, 600);
  const fix = String((f && f.fix) || '').slice(0, 600);
  const message = `${claim ? `"${claim.slice(0, 90)}" — ` : ''}${issue.slice(0, 180)}`;
  return { severity, code, claim, issue, fix, message };
}

/**
 * @param {{title?:string, body:string, city?:string, keyword?:string, tag?:string}} draft
 * @returns {Promise<{pass:boolean, findings:Array, checked:boolean, model?:string, skipped?:string}>}
 */
async function evaluate({ title = '', body = '', city = '', keyword = '', tag = '' } = {}) {
  // Explicit opt-in, not opt-out: see the SHIPS DARK note in the header. An
  // unset flag means "not calibrated yet", which must read as off.
  if (process.env.GATE_COMPLIANCE !== 'true') {
    return { pass: true, findings: [], checked: false, skipped: 'disabled' };
  }
  if (!body || body.trim().length < 50) {
    return { pass: true, findings: [], checked: false, skipped: 'empty_body' };
  }

  let response;
  try {
    const policy = COMPLIANCE_MODEL_OVERRIDE
      ? {
        name: 'complianceOverride',
        primary: { provider: MODELS.PROVIDER.ANTHROPIC, model: COMPLIANCE_MODEL_OVERRIDE },
        fallback: MODELS.TEXT_POLICIES.deepAnalysis.fallback,
      }
      : MODELS.TEXT_POLICIES.deepAnalysis;
    response = await dispatchWithFallback(policy, {
      maxTokens: 6000,
      timeoutMs: COMPLIANCE_TIMEOUT_MS,
      jsonMode: true,
      system: SYSTEM_PROMPT,
      text: `City: ${city || '(none)'}\nKeyword: ${keyword || '(none)'}\nTag: ${tag || '(none)'}\nTitle: ${title || '(none)'}\n\n--- CONTENT ---\n${body}`,
    });
    if (!response.ok || !response.json) throw new Error(response.reason || 'invalid_json');
  } catch (err) {
    logger.warn(`[compliance-gate] check failed for "${title}" — passing (fail-open): ${err.message}`);
    return { pass: true, findings: [], checked: false, skipped: 'api_error' };
  }

  const findings = (Array.isArray(response.json.findings) ? response.json.findings : [])
    .map(normalizeFinding)
    // A finding whose code the model invented cannot be routed to a retry
    // directive or explained to a reviewer, so it is dropped rather than
    // blocking a publish under a meaningless label.
    .filter((f) => f.code !== null);

  // Block ONLY on P0. P1/P2 are advisory — the same calibration fact-check-gate
  // settled on, for the same reason: a model asked to judge borderline copy
  // will reliably flag debatable material, and blocking on that stalls
  // compliant content. The regex layer still hard-blocks everything it matches.
  const pass = !findings.some((f) => f.severity === 'P0');
  return { pass, findings, checked: true, model: response.model };
}

module.exports = { evaluate, _internals: { normalizeFinding, SYSTEM_PROMPT, VALID_CODES, COMPLIANCE_TIMEOUT_MS } };
