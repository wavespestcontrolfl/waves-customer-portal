/**
 * Customer-voice validators.
 *
 * Hard customer/lead-facing voice rule:
 *   - validateNoCustomerEmoji      Customer/lead messages MUST NOT contain emoji.
 *                                  Internal BI is allowed via policy.allowEmoji.
 *
 * This is policy-aware: it reads the resolved policy.allowEmoji
 * rather than hardcoding the audience check.
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

module.exports = {
  validateNoCustomerEmoji,
  // Exposed for tests
  _internals: {
    findEmoji,
  },
};
