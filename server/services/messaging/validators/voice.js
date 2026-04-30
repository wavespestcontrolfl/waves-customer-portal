/**
 * Customer-voice validators.
 *
 * Two hard rules for any audience='customer' or 'lead' message:
 *   - validateNoCustomerEmoji      Customer/lead messages MUST NOT contain emoji.
 *                                  Internal BI is allowed via policy.allowEmoji.
 *   - validateNoPriceLeak          Customer/lead messages MUST NOT contain exact
 *                                  dollar amounts ("$123", "$1,234.56", "123/mo",
 *                                  "123 per month"). Internal/admin can quote.
 *
 * These are policy-aware: they read the resolved policy.allowEmoji /
 * policy.allowExactPrice flags rather than hardcoding the audience check.
 * That keeps the rule-of-thumb in one place (policy.js) and lets the
 * BI internal_briefing purpose continue to use the 📊 emoji + dollar
 * amounts in its Monday SMS.
 */

// Unicode property escape — covers everything Unicode classifies as a
// pictographic emoji including modern emoji presentation variants. Falls
// back to a hand-rolled high-surrogate range check on engines that don't
// support /\p{Extended_Pictographic}/u (Node 12 and older).
let EMOJI_REGEX;
try {
  EMOJI_REGEX = new RegExp('\\p{Extended_Pictographic}', 'u');
} catch {
  // Fallback: detect any code point in common emoji ranges
  EMOJI_REGEX = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{1F000}-\u{1F02F}\u{1F0A0}-\u{1F0FF}\u{1F100}-\u{1F1FF}]/u;
}

/**
 * Detect any emoji-class character in the body. Smart punctuation
 * (em-dash, curly quotes, é) are NOT treated as emoji — those just bump
 * the message into UCS-2 encoding, which is the segment counter's
 * concern, not the voice validator's.
 *
 * @param {string} body
 * @returns {{ found: boolean, sample: string | null }}
 */
function findEmoji(body) {
  if (!body) return { found: false, sample: null };
  const m = body.match(EMOJI_REGEX);
  return { found: !!m, sample: m ? m[0] : null };
}

/**
 * Validator entry — emoji.
 * @param {import('../policy').SendCustomerMessageInput} input
 * @param {Object} policy
 * @returns {{ ok: boolean, code?: string, reason?: string }}
 */
function validateNoCustomerEmoji(input, policy) {
  if (policy.allowEmoji) return { ok: true };
  const { found, sample } = findEmoji(input.body);
  if (found) {
    return {
      ok: false,
      code: 'EMOJI_FOR_CUSTOMER',
      reason: `Body contains emoji "${sample}" but audience="${input.audience}" forbids it. Customer/lead-facing messages must be emoji-free.`,
    };
  }
  return { ok: true };
}

/**
 * Patterns that indicate an exact-price leak. These match aggressively
 * because the policy is explicit: customer/lead-facing messages NEVER
 * type a dollar figure. Operators link to a portal/estimate page instead.
 *
 * Allowed phrasings:
 *   - "the totals shown on your estimate"
 *   - "your portal has the current estimate"
 *   - "the secure payment link"
 *   - "tap-to-pay link"
 *
 * Disallowed (any of):
 *   - $123 or $1,234.56 (with or without commas)
 *   - 123/mo, 123/month, 123 per month, 123 monthly
 *   - "monthly total is 99", "annual total is 1188"
 *   - bare integer with /yr, /year, per year, annually
 */
const PRICE_PATTERNS = [
  // $-prefixed amounts (with or without thousands separators / decimals)
  /\$\s?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?/,
  /\$\s?\d+(?:\.\d{1,2})?/,
  // Bare number followed by per-month / monthly / /mo
  /\b\d{1,5}(?:\.\d{1,2})?\s*(?:\/\s?(?:mo|month|yr|year)\b|per\s+month\b|per\s+year\b|monthly\b|annually\b|a\s+month\b|a\s+year\b)/i,
  // "monthly total is N", "annual total is N", "your bill is N"
  /\b(?:monthly|annual|quarterly)\s+total\s+is\s+\d/i,
  /\bthe\s+(?:monthly|annual|quarterly)\s+(?:rate|charge|amount|cost|price)\s+is\s+\d/i,
  /\byour\s+(?:bill|balance|invoice|total)\s+is\s+\$?\d/i,
  // "It costs $X" / "for $X" / "at $X"
  /\b(?:costs?|for|at|just)\s+\$\s?\d/i,
];

/**
 * Detect exact-price phrasing in the body.
 * @param {string} body
 * @returns {{ found: boolean, pattern: string | null, sample: string | null }}
 */
function findPriceLeak(body) {
  if (!body) return { found: false, pattern: null, sample: null };
  for (let i = 0; i < PRICE_PATTERNS.length; i++) {
    const re = PRICE_PATTERNS[i];
    const m = body.match(re);
    if (m) {
      return { found: true, pattern: String(re), sample: m[0] };
    }
  }
  return { found: false, pattern: null, sample: null };
}

/**
 * Validator entry — price leak.
 * @param {import('../policy').SendCustomerMessageInput} input
 * @param {Object} policy
 * @returns {{ ok: boolean, code?: string, reason?: string }}
 */
function validateNoPriceLeak(input, policy) {
  if (policy.allowExactPrice) return { ok: true };
  const { found, sample } = findPriceLeak(input.body);
  if (found) {
    return {
      ok: false,
      code: 'PRICE_LEAK',
      reason: `Body contains an exact price "${sample}" but audience="${input.audience}" / purpose="${input.purpose}" forbids it. Refer to "the totals shown on your estimate" or link to the portal/payment URL instead.`,
    };
  }
  return { ok: true };
}

module.exports = {
  validateNoCustomerEmoji,
  validateNoPriceLeak,
  // Exposed for tests
  _internals: {
    findEmoji,
    findPriceLeak,
    PRICE_PATTERNS,
  },
};
