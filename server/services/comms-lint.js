/**
 * COMMS LINT — graded eval harness for outgoing customer communications.
 *
 * Every rule is a binary pass/fail with a one-line reason, deterministic
 * code wherever the rule permits it (owner directive, 2026-08-10). The
 * contract that makes this a harness rather than a style guide:
 *
 *   1. Rules encode standing owner rulings that were previously enforced
 *      by hand in weekly sweeps (emoji ban, A2P link rules, price-unit
 *      wording, FDACS re-entry language, segment limits). The prompt-side
 *      version lives in CUSTOMER_SMS_HOUSE_VOICE — this module is the
 *      code-side check of the SAME rulings, so drift between them is a bug.
 *   2. The thing producing drafts never moves the bar: rule changes land
 *      only via PR review. Threshold or exemption changes are owner calls.
 *   3. Every miss found in a later sweep becomes a permanent regression
 *      fixture (server/tests/fixtures/comms-lint-regressions/) — the suite
 *      only ever grows.
 *
 * Advisory by design at this layer: callers record failures (e.g. on the
 * shadow draft's flags array) — nothing is blocked here. Blocking a send
 * on a failed rule is a delivery-mode decision that belongs to the caller.
 *
 * Deliberately NOT here (existing mechanisms own them — never duplicate):
 *   - Quiet hours / send windows: runtime send gate, not text lint.
 *   - "Sounds like the owner": the shadow judge's voice score (LLM metric).
 *   - Long-form anti-AI-tell style: services/llm/human-prose-rules.js.
 */

// Segment math and encoding detection delegate to the canonical counter the
// send path uses (messaging/segment-counter.js) — the lint verdict must
// match what Twilio is actually handed, so this module never re-derives it.
const { countSegments, detectEncoding } = require('./messaging/segment-counter');
// Canonical emoji detector (covers regional-indicator flags and keycap
// sequences that bare Extended_Pictographic misses).
const { findEmoji } = require('./messaging/validators/voice');
// Canonical re-entry/safety compliance predicate — 20+ review rounds of
// paraphrase coverage live there, and this rule and the publish gate must
// never drift apart.
const { reentrySafetyClaimFinding } = require('./content/content-guardrails');

// URL-shortener hosts. One shortened link in an SMS can burn the A2P 10DLC
// registration, and A2P is non-resubmittable — this rule is downside
// protection, not style. Matched as hostnames (word-boundary + '/'), never
// as substrings of longer domains.
const URL_SHORTENER_HOSTS = [
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'tiny.cc', 'rb.gy', 'shorturl.at', 'lnkd.in',
  's.id', 'soo.gd', 'bl.ink', 'snip.ly',
];

const SMS_SEGMENT_LIMIT = 2; // owner ruling: 2 segments is fine, 3+ is not

function isGsm7(text) {
  return detectEncoding(String(text ?? '')).encoding === 'GSM_7';
}

function smsSegmentCount(text) {
  if (!text) return 0;
  return countSegments(String(text)).segmentCount;
}

// Typographic characters the house voice bans outright: they read as
// machine-written AND silently flip SMS encoding to UCS-2.
const TYPOGRAPHIC_RE = /[\u2018\u2019\u201C\u201D\u2013\u2014\u2026]/;

const SIGNOFF_BOILERPLATE_RE = /reply to this (?:message|text)|thank you for choosing waves|questions or requests\?|simply reply\b/i;

/**
 * Each rule: { name, applies(ctx) => bool, check(text, ctx) => reason|null }.
 * A non-null reason is a FAIL with that one-line explanation.
 *
 * Context: { channel: 'sms'|'email'|'web', audience: 'customer'|'internal',
 *   commercial?: bool, stopExpected?: bool|undefined }
 * Rules whose precondition the caller can't assert (e.g. stopExpected
 * unknown) are skipped, never guessed.
 */
const RULES = [
  {
    name: 'no-emoji',
    applies: (ctx) => ctx.audience === 'customer',
    check: (text) => {
      const { found, sample } = findEmoji(text);
      return found ? `contains emoji "${sample}" — customer messages never carry emojis (owner ruling)` : null;
    },
  },
  {
    name: 'no-url-shortener',
    applies: () => true,
    check: (text) => {
      const lower = text.toLowerCase();
      const hit = URL_SHORTENER_HOSTS.find((h) => new RegExp(`(?:^|[^a-z0-9.-])${h.replace(/\./g, '\\.')}(?:/|\\b)`).test(lower));
      return hit ? `contains URL shortener "${hit}" — one shortened link can kill the A2P registration (non-resubmittable)` : null;
    },
  },
  {
    name: 'portal-link-scheme',
    applies: (ctx) => ctx.channel === 'sms',
    check: (text) => {
      if (/https?:\/\/portal\.wavespestcontrol\.com/i.test(text)) {
        return 'portal link carries a scheme — portal.wavespestcontrol.com goes bare in SMS';
      }
      // Third-party links keep their scheme: a bare g.page won't preview.
      const bareGPage = text.replace(/https?:\/\/g\.page/gi, '').match(/(?:^|[^/.\w])g\.page/i);
      return bareGPage ? 'bare g.page link — third-party links keep https:// in SMS' : null;
    },
  },
  {
    name: 'per-application-wording',
    applies: (ctx) => ctx.audience === 'customer' && !ctx.commercial,
    check: (text) => (/\bper\s+visit\b/i.test(text)
      ? 'says "per visit" — recurring pricing is always "per application" (commercial accounts exempt)'
      : null),
  },
  {
    name: 'reentry-language',
    // Delegates wholesale to the publish gate's REENTRY_SAFETY_CLAIM
    // predicate (content-guardrails): unconditional "safe" claims, the
    // "EPA-approved" ban ("EPA-registered"/"EPA-exempt" is the required
    // wording), fixed re-entry/drying figures, and the conditional
    // "safe once dry" + technician-confirms-timing exemption all live there.
    applies: (ctx) => ctx.audience === 'customer',
    check: (text) => {
      const f = reentrySafetyClaimFinding(text);
      return f ? f.message : null;
    },
  },
  {
    name: 'sms-segment-limit',
    applies: (ctx) => ctx.channel === 'sms',
    check: (text) => {
      const segs = smsSegmentCount(text);
      return segs > SMS_SEGMENT_LIMIT
        ? `${segs} SMS segments (limit ${SMS_SEGMENT_LIMIT})${isGsm7(text) ? '' : ' — non-GSM characters forced UCS-2 encoding'}`
        : null;
    },
  },
  {
    name: 'plain-punctuation',
    applies: (ctx) => ctx.audience === 'customer',
    check: (text) => {
      const hit = text.match(TYPOGRAPHIC_RE);
      return hit ? `typographic character "${hit[0]}" — plain keyboard punctuation only (also silently doubles SMS segments)` : null;
    },
  },
  {
    name: 'stop-line-policy',
    // Only checkable when the caller knows whether this message class keeps
    // its STOP line (the #3343 keep-list) — undefined skips, never guesses.
    applies: (ctx) => ctx.channel === 'sms' && typeof ctx.stopExpected === 'boolean',
    check: (text, ctx) => {
      const hasStop = /reply\s+stop\b|txt\s+stop\b|text\s+stop\b/i.test(text);
      if (ctx.stopExpected && !hasStop) return 'missing required STOP opt-out line (compliance/first-touch class)';
      if (!ctx.stopExpected && hasStop) return 'carries a STOP line — transactional messages to known customers go without one';
      return null;
    },
  },
  {
    name: 'no-signoff-boilerplate',
    applies: (ctx) => ctx.audience === 'customer',
    check: (text) => {
      const hit = text.match(SIGNOFF_BOILERPLATE_RE);
      return hit ? `boilerplate closer "${hit[0]}" — when the answer is given, the message just ends` : null;
    },
  },
  {
    name: 'company-name',
    applies: () => true,
    check: (text) => (/waves\s+lawn\s*(?:&|and)\s*pest/i.test(text)
      ? 'says "Waves Lawn & Pest" — the company is "Waves Pest Control", always'
      : null),
  },
  {
    name: 'one-exclamation-max',
    applies: (ctx) => ctx.audience === 'customer' && ctx.channel === 'sms',
    check: (text) => {
      const count = (text.match(/!/g) || []).length;
      return count > 1 ? `${count} exclamation marks — one max, often zero` : null;
    },
  },
];

/**
 * Grade one outgoing message. Returns
 *   { pass, failures: [{rule, reason}], checked: [ruleName…] }
 * `checked` names the rules that actually ran for this context, so a
 * skipped precondition (e.g. stopExpected unknown) is visible as absence,
 * never as a silent pass.
 */
function lintComms(text, context = {}) {
  const ctx = { channel: 'sms', audience: 'customer', ...context };
  const body = String(text || '');
  const failures = [];
  const checked = [];
  for (const rule of RULES) {
    if (!rule.applies(ctx)) continue;
    checked.push(rule.name);
    const reason = rule.check(body, ctx);
    if (reason) failures.push({ rule: rule.name, reason });
  }
  return { pass: failures.length === 0, failures, checked };
}

/** flags-array entries for a draft row, in the shape consumers already render. */
function lintFlags(text, context = {}) {
  return lintComms(text, context).failures.map((f) => ({
    severity: 'warn',
    type: `comms_lint:${f.rule}`,
    detail: f.reason,
  }));
}

module.exports = { lintComms, lintFlags, smsSegmentCount, isGsm7, RULES, URL_SHORTENER_HOSTS };
