/**
 * LLM compliance judge for generated social copy (owner ruling 2026-07-30 on
 * PR #3066: "judge"). The deterministic validateContent checks remain the
 * fast first-pass, but enumerating English phrasings of banned claims proved
 * unbounded across the #3059/#3066 review rounds — a small cross-provider
 * model call answers the SEMANTIC question instead. Volume is a few posts a
 * day; each check costs fractions of a cent.
 *
 * Contract:
 *   judgeSocialCopy(text) → { ok: true, compliant, violations }  (judged)
 *                         | { ok: false, reason }                (unavailable)
 *
 * FAIL-OPEN by design: an unavailable judge returns ok:false and callers
 * proceed on the deterministic layer alone — a provider outage must never
 * stop the posting lanes (the regex layer still guards). Kill switch:
 * SOCIAL_COMPLIANCE_JUDGE=false disables the LLM pass entirely.
 */

const logger = require('./logger');

const RULES = `You review ONE piece of social-media copy for a Florida pest-control company against these compliance rules:

1. PRODUCT SAFETY: Never call a pesticide, product, treatment, spray, application, or the service itself "safe" in ANY phrasing (examples: "pet-safe", "safe for kids/families", "our products are safe", "safe pest control", "safely applied"). The ONLY approved safety phrasing is the drying idiom: "safe once (completely) dry" / re-entry once dry with timing confirmed by the technician. ALLOWED: protective framing about pests ("keep your home safe FROM termites"), worker-PPE mentions ("technicians wear equipment to stay safe"), and the phrase "safety data sheet".
2. EPA: "EPA-registered" or "EPA-exempt" only. Never "EPA-approved" in any phrasing, including "approved by the EPA".
3. FIXED TIMING: Never a specific re-entry or drying time in minutes or hours, in any phrasing ("dries in 30 minutes", "wait an hour before letting pets out", "re-enter after 45 minutes"). ALLOWED: agronomic aftercare windows (mowing/watering/fertilizing, e.g. "avoid mowing for 48 hours"), service durations ("visits take about 45 minutes"), response times ("we respond within 24 hours"), and day-based cadences ("barrier lasts 21-30 days", "we return after 30 days").
4. OVERCLAIMS: No guarantees, "100% effective", "risk-free", "no side effects".

Respond with STRICT JSON only, no prose: {"compliant": true} or {"compliant": false, "violations": ["<short reason>", ...]}`;

function judgeEnabled() {
  return String(process.env.SOCIAL_COMPLIANCE_JUDGE || 'true') !== 'false';
}

function parseVerdict(text) {
  try {
    const match = String(text || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (typeof parsed.compliant !== 'boolean') return null;
    const violations = Array.isArray(parsed.violations)
      ? parsed.violations.map((v) => String(v).slice(0, 200)).slice(0, 5)
      : [];
    return { compliant: parsed.compliant, violations };
  } catch {
    return null;
  }
}

async function judgeSocialCopy(text) {
  const copy = String(text || '').trim();
  if (!copy) return { ok: true, compliant: true, violations: [] };
  if (!judgeEnabled()) return { ok: false, reason: 'disabled' };
  try {
    const MODELS = require('../config/models');
    const { dispatchWithFallback } = require('./llm/call');
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const routed = await dispatchWithFallback(
      MODELS.TEXT_POLICIES.fastStructured,
      {
        text: `${RULES}\n\nCOPY:\n<<<\n${copy.slice(0, 4000)}\n>>>`,
        jsonMode: false,
        maxTokens: 300,
        anthropicClient: client,
      },
      { validate: (result) => (parseVerdict(result.text || '') ? null : 'unparseable') },
    );
    if (!routed.ok) {
      logger.warn(`[social-judge] dispatch failed (${routed.reason}); deterministic checks only`);
      return { ok: false, reason: routed.reason };
    }
    const verdict = parseVerdict(routed.text);
    if (!verdict) return { ok: false, reason: 'unparseable' }; // validate() makes this unreachable; belt only
    return { ok: true, ...verdict };
  } catch (err) {
    logger.warn(`[social-judge] error (${err.message}); deterministic checks only`);
    return { ok: false, reason: err.message };
  }
}

module.exports = { judgeSocialCopy, parseVerdict, judgeEnabled };
