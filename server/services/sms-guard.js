/**
 * Pre-send SMS safety validator.
 *
 * Runs on every outbound SMS body in TwilioService.sendSMS. Rejects messages
 * that look like a template-rendering bug instead of quietly delivering them
 * to customers. Real-world failures motivating each rule are in the
 * referenced issue — examples: a template with a stale {month} sent to
 * Heidi saying "January" in April; "undefined" / "null" bodies from null
 * customer fields.
 *
 *   validateOutbound(body, options?)  -> { ok: true } | { ok: false, reason }
 *
 * The validator is conservative — any miss degrades to sending. These are
 * belt-and-suspenders checks for patterns we know break trust with the
 * customer when they ship. When a message is rejected, the caller logs +
 * alerts Virginia instead of silently dropping the SMS.
 *
 * `options.messageType === 'internal_alert'` bypasses the month check
 * because admin-facing alerts often reference past months intentionally.
 */

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

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

// Return any month-name mentioned in the body that's obviously stale —
// i.e. more than 1 calendar month off from today. Allows current month,
// the month before, and the month after (handles "we'll see you in May"
// late-April / early-May cases).
function findStaleMonth(body, now = new Date()) {
  const idx = now.getMonth(); // 0..11
  const allowed = new Set([
    MONTHS[(idx + 11) % 12],
    MONTHS[idx],
    MONTHS[(idx + 1) % 12],
  ]);
  const lower = body.toLowerCase();
  for (const m of MONTHS) {
    if (allowed.has(m)) continue;
    // Word-boundary match so "March" doesn't trigger on "marching orders".
    const re = new RegExp(`\\b${m}\\b`, 'i');
    if (re.test(lower)) return m;
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

  if (options.messageType !== 'internal_alert') {
    const stale = findStaleMonth(body, options.now);
    if (stale) {
      return { ok: false, reason: `stale-month:${stale}` };
    }
  }

  return { ok: true };
}

module.exports = { validateOutbound, findStaleMonth, hasBrokenRender };
