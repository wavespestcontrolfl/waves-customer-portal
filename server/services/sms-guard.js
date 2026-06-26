/**
 * Pre-send SMS safety validator.
 *
 * Runs on every outbound SMS body in TwilioService.sendSMS. Rejects messages
 * that look like a template-rendering bug instead of quietly delivering them
 * to customers — e.g. "undefined" / "null" bodies from null customer fields,
 * unsubstituted Mustache variables, or a known blocked phrase.
 *
 *   validateOutbound(body, options?)  -> { ok: true } | { ok: false, reason }
 *
 * The validator is conservative — any miss degrades to sending. These are
 * belt-and-suspenders checks for patterns we know break trust with the
 * customer when they ship. When a message is rejected, the caller logs +
 * alerts Virginia instead of silently dropping the SMS.
 *
 * Note: a stale-month check (rejecting a month name >1 calendar month from
 * today) used to live here, motivated by a template that shipped "January"
 * in April. It produced too many false positives on legitimate forward- and
 * backward-looking copy, so it has been removed. The `options.messageType`
 * and `options.humanAuthored` flags are still accepted (callers continue to
 * pass them) but no longer gate any check.
 */

// Unsubstituted Mustache-style variables like `{first_name}`, `{date}`.
// Narrow pattern — only flag short lowercase-snake tokens so we don't false-
// trigger on real text containing a "{" (rare in SMS but possible).
const UNSUBBED_VAR_RE = /\{\s*[a-z][a-z0-9_]{0,40}\s*\}/;

// Literal strings that indicate a broken render.
const BROKEN_RENDER_SUBSTRINGS = [
  'undefined',
  '[object Object]',
  'NaN/NaN',
  'Invalid Date',
  '1970',
];

const BLOCKED_OUTBOUND_PATTERNS = [
  {
    reason: 'blocked-autopay-pre-charge-waveguard',
    re: /\bWaveGuard\s+auto-pay\s+will\s+process\b/i,
  },
];

function hasBrokenRender(body) {
  const lower = body.toLowerCase();
  for (const s of BROKEN_RENDER_SUBSTRINGS) {
    if (lower.includes(s.toLowerCase())) return s;
  }
  // Standalone "null" word (not "nullify" / "annull") — tighter match than
  // a naive indexOf so we don't reject legit words containing "null".
  if (/\bnull\b/i.test(body)) return 'null';
  return null;
}

function findBlockedOutboundPattern(body) {
  for (const pattern of BLOCKED_OUTBOUND_PATTERNS) {
    if (pattern.re.test(body)) return pattern.reason;
  }
  return null;
}

function validateOutbound(body, options = {}) {
  if (typeof body !== 'string' || body.trim().length === 0) {
    return { ok: false, reason: 'empty-body' };
  }
  if (body.length > 1600) {
    return { ok: false, reason: 'body-too-long' };
  }

  const unsubbed = body.match(UNSUBBED_VAR_RE);
  if (unsubbed) {
    return { ok: false, reason: `unsubstituted-variable:${unsubbed[0]}` };
  }

  const broken = hasBrokenRender(body);
  if (broken) {
    return { ok: false, reason: `broken-render:${broken}` };
  }

  const blockedPattern = findBlockedOutboundPattern(body);
  if (blockedPattern) {
    return { ok: false, reason: blockedPattern };
  }

  return { ok: true };
}

module.exports = { validateOutbound, hasBrokenRender, findBlockedOutboundPattern };
