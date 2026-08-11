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
// protection, not style. Matched as exact extracted hostnames (subdomains
// of a shortener included), never as substrings of longer domains.
const URL_SHORTENER_HOSTS = [
  'bit.ly', 'tinyurl.com', 'goo.gl', 't.co', 'ow.ly', 'is.gd', 'buff.ly',
  'rebrand.ly', 'cutt.ly', 'tiny.cc', 'rb.gy', 'shorturl.at', 'lnkd.in',
  's.id', 'soo.gd', 'bl.ink', 'snip.ly',
];

const SMS_SEGMENT_LIMIT = 2; // owner ruling: 2 segments is fine, 3+ is not

/**
 * Shortener host present in the text, or null. Compares extracted, exact
 * hostnames (a shortener's own subdomains like www.tinyurl.com or a branded
 * custom.bit.ly count; bit.ly.evil.com does not) — substring or word-boundary
 * matching gets both of those wrong.
 */
function findShortenerHost(text) {
  // Scan for hostname-shaped spans directly rather than tokenizing on
  // whitespace: prose punctuation glued to a URL ("Pay here:https://bit.ly/x")
  // must not hide it. Each candidate is the maximal dotted host at that
  // position (leftmost-greedy), so bit.ly inside bit.ly.evil.com is never
  // extracted on its own.
  const candidateRe = /(?:[a-z0-9][a-z0-9-]*\.)+[a-z]{2,}/g;
  // Canonicalize first (shared with rain-out): fullwidth/ideographic dots,
  // zero-width joins, and percent-encoding must not hide a shortener host.
  const lower = normalizeForLinkCheck(String(text || '')).toLowerCase();
  let m;
  while ((m = candidateRe.exec(lower)) !== null) {
    const host = m[0];
    const hit = URL_SHORTENER_HOSTS.find((h) => host === h || host.endsWith(`.${h}`));
    if (hit) return hit;
  }
  return null;
}

// Bare-host detection for the SMS link-scheme rule. The ruling is
// direction-specific: hosts on the canonical schemeless list (shared with
// the SMS template renderer via sms-link-policy.js) plus own-domain hosts
// go bare; every third-party link keeps https:// (a bare host won't
// preview). Host validity is checked against the public-suffix list —
// see the psl note below.
const { SCHEMELESS_SMS_HOSTS, normalizeForLinkCheck } = require('./messaging/sms-link-policy');
function isBareExemptHost(host) {
  const h = String(host || '').toLowerCase();
  return SCHEMELESS_SMS_HOSTS.includes(h) || h === 'wavespestcontrol.com' || h.endsWith('.wavespestcontrol.com');
}
// Scheme-carrying form of a must-go-bare host (the renderer strips these;
// a draft carrying one renders inconsistently with the sent form). NOTE
// the deliberate asymmetry with isBareExemptHost: the exemption set for
// the bare-host rule (any owned host may appear bare) is WIDER than the
// must-go-bare set (exactly the renderer's SCHEMELESS_SMS_HOSTS) — a
// scheme'd https://wavespestcontrol.com marketing link is legitimate both
// ways. The hostname boundary stops a lookalike third-party URL
// (https://portal.wavespestcontrol.com.evil.com/...) from matching on its
// owned-host prefix.
const SCHEMED_PORTAL_RE = new RegExp(
  `https?://(${SCHEMELESS_SMS_HOSTS.map((h) => h.replace(/\./g, '\\.')).join('|')})(?![-a-z0-9]|\\.[a-z0-9])`,
  'i'
);
// Host validity comes from the public-suffix list (psl — the dependency
// rain-out's link guard already uses), not a hand-curated TLD list: it
// accepts every real TLD (.dev, .ai, ccTLDs) while still rejecting prose
// tokens ("no.problem", "today.come", "e.g") whose tails are not suffixes.
const psl = require('psl');
// Generic maximal dotted-host run, no TLD filter and no left-boundary
// class: prose punctuation glued to a link ("See:yelp.com", "[yelp.com]")
// must not hide it, and the exemption below must see the COMPLETE hostname
// — a TLD-anchored match stops at ".com" and would exempt
// portal.wavespestcontrol.com.evil.xyz as ours. Public-suffix validation
// happens after extraction.
const BARE_HOST_RUN_RE = /(?:[a-z0-9][a-z0-9-]*\.)+[a-z0-9][a-z0-9-]*/g;

/** First bare (scheme-less) third-party host in the text, or null. */
function findBareThirdPartyHost(text) {
  // Scheme-qualified URLs already satisfy the rule and email addresses are
  // not links — remove both before scanning for what's left bare. The
  // stripped span stops at delimiters (comma, semicolon, quotes, brackets):
  // \S+ would swallow a comma-glued neighbor ("https://example.com,yelp.com")
  // and hide the bare host riding behind it.
  // Lowercased before scanning: the host-run regex is lowercase-only and
  // WWW.EPA.GOV must not evade it.
  const stripped = normalizeForLinkCheck(String(text || ''))
    .toLowerCase()
    .replace(/https?:\/\/[^\s,;'"<>()]+/g, ' ')
    .replace(/[^\s,;'"<>()]+@[^\s,;'"<>()]+/g, ' ');
  BARE_HOST_RUN_RE.lastIndex = 0;
  let m;
  while ((m = BARE_HOST_RUN_RE.exec(stripped)) !== null) {
    const host = m[0].toLowerCase();
    // A host that EXTENDS an owned host is a lookalike, never ours — flag
    // it regardless of its final TLD.
    if (SCHEMELESS_SMS_HOSTS.some((h) => host.startsWith(`${h}.`))
      || host.startsWith('wavespestcontrol.com.')
      || host.includes('.wavespestcontrol.com.')) return m[0];
    if (isBareExemptHost(host)) continue;
    if (psl.isValid(host)) return m[0];
  }
  return null;
}

function isGsm7(text) {
  return detectEncoding(String(text ?? '')).encoding === 'GSM_7';
}

function smsSegmentCount(text) {
  if (!text) return 0;
  return countSegments(String(text)).segmentCount;
}

// Typographic characters the house voice bans outright: they read as
// machine-written AND silently flip SMS encoding to UCS-2. Classification
// delegates to the canonical GSM-7 normalizer's replacement set \u2014 a local
// character list here would drift from it.
const { findTypographicChar, normalizeGsmPunctuation } = require('./messaging/gsm-normalize');

// "Reply to this message" only counts as boilerplate in CLOSER position:
// end of message, terminal punctuation, or a genuine courtesy tail ("if
// you have any questions", "with any concerns", "anytime"). Actionable
// instructions — "reply to this message with the gate code", "reply to
// this message if Tuesday works" — are not sign-offs and never match.
const SIGNOFF_BOILERPLATE_RE = /reply to this (?:message|text)\s*(?:[.!]|$|anytime\b|if\s+you\s+have\s+any\b|with\s+any\s+(?:questions?|concerns?)\b|for\s+any\s+(?:questions?|concerns?)\b)|thank you for choosing waves|questions or requests\?|simply reply\b/i;

/**
 * Each rule: { name, applies(ctx) => bool, check(text, ctx) => reason|null }.
 * A non-null reason is a FAIL with that one-line explanation.
 *
 * Context: { channel: 'sms'|'email'|'web', audience: 'customer'|'internal',
 *   commercialProposal?: bool, stopExpected?: bool|undefined }
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
      const hit = findShortenerHost(text);
      return hit ? `contains URL shortener "${hit}" — one shortened link can kill the A2P registration (non-resubmittable)` : null;
    },
  },
  {
    name: 'portal-link-scheme',
    applies: (ctx) => ctx.channel === 'sms',
    check: (text) => {
      const schemed = normalizeForLinkCheck(text).match(SCHEMED_PORTAL_RE);
      if (schemed) {
        return `portal link carries a scheme — ${schemed[1]} goes bare in SMS`;
      }
      // Third-party links keep their scheme: a bare host won't preview.
      const bare = findBareThirdPartyHost(text);
      return bare ? `bare ${bare} link — third-party links keep https:// in SMS` : null;
    },
  },
  {
    name: 'per-application-wording',
    applies: (ctx) => ctx.audience === 'customer' && !ctx.commercialProposal,
    // "per visit"/"per-visit" is intrinsically price-unit phrasing and always
    // forbidden. "each/every/a visit" is ordinary scheduling language ("we
    // text before each visit"), so those forms only count as price units when
    // a monetary amount anchors them — "$117", "USD 117", "117 dollars",
    // "117 bucks" — same idea as the slash form, where the digit anchor also
    // keeps URL paths from matching.
    check: (text) => (
      /\bper[\s-]+visit\b|\d\s*\/\s*visit\b|(?:\$\s*|\busd\s+)\d[\d.,]*\s+(?:each|every|a)\s+visit\b|\b\d[\d.,]*\s*(?:dollars?|bucks?)\s+(?:each|every|a)\s+visit\b/i.test(text)
        ? 'says "per visit" — recurring pricing is always "per application" (commercial proposals exempt)'
        : null),
  },
  {
    name: 'no-plan-total',
    // Combined plan totals ("$X/mo" / "$X/yr" / "$X monthly") never appear
    // in customer copy (owner rule re-affirmed 2026-07-23). The exemptions
    // are UNIT-SPECIFIC, not lane-wide: a monthly-billed legacy plan may
    // hear its genuine monthly dues but never a yearly aggregate, and an
    // annual-prepay customer may hear the yearly total they already paid
    // but never a fabricated monthly spread. Commercial proposals are
    // exempt entirely. Only checkable when the caller can assert the
    // billing lane; unknown skips, never guesses.
    applies: (ctx) => ctx.audience === 'customer' && !ctx.commercialProposal
      && typeof ctx.monthlyBilled === 'boolean',
    check: (text, ctx) => {
      // Amount: $117 / USD 117 / 117 dollars / 117 bucks. Unit: /mo, "per
      // month", "a year", the adjectival "monthly"/"yearly"/"annually" —
      // AFTER the amount ("$117/mo") or BEFORE it within the same sentence
      // ("your monthly plan total is $117").
      const amountSrc = String.raw`(?:(?:\$\s*|\busd\s+)\d[\d.,]*|\b\d[\d.,]*\s*(?:dollars?|bucks?))`;
      const unitAfterRe = new RegExp(`${amountSrc}(?:\\s*\\/\\s*(mo|month|yr|year)\\b|\\s+(?:per|a|each|every)\\s+(mo|month|yr|year)\\b|\\s+(monthly|yearly|annually)\\b)`, 'gi');
      // The leading unit binds through a billing noun — "your monthly plan
      // total is $117" — never through unrelated facts ("your monthly
      // service is Friday, and your balance is $117" quotes a balance, not
      // a plan total).
      const unitBeforeRe = new RegExp(`\\b(monthly|yearly|annual(?:ized)?)\\b\\s+(?:plan|pricing|price|rate|total|cost|bill(?:ing)?|payment|amount|dues|charge|subscription|spread)\\b[^.!?\\n]{0,30}?${amountSrc}`, 'gi');
      const hits = [];
      let m;
      while ((m = unitAfterRe.exec(text)) !== null) hits.push({ span: m[0], unit: (m[1] || m[2] || m[3]).toLowerCase() });
      while ((m = unitBeforeRe.exec(text)) !== null) hits.push({ span: m[0], unit: m[1].toLowerCase() });
      for (const hit of hits) {
        const monthlyUnit = hit.unit === 'mo' || hit.unit === 'month' || hit.unit === 'monthly';
        const allowed = monthlyUnit
          ? ctx.monthlyBilled === true
          : ctx.billingMode === 'annual_prepay';
        if (!allowed) {
          return `quotes a combined plan total "${hit.span.trim()}" — plan totals never appear in customer copy (a lane's own genuine unit exempt)`;
        }
      }
      return null;
    },
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
      // Count what Twilio actually receives: the send path normalizes
      // typographic punctuation before dispatch (send-customer-message), so
      // the segment verdict runs on the same normalized body — the
      // plain-punctuation rule separately flags the source characters.
      const body = normalizeGsmPunctuation(text);
      const segs = smsSegmentCount(body);
      return segs > SMS_SEGMENT_LIMIT
        ? `${segs} SMS segments (limit ${SMS_SEGMENT_LIMIT})${isGsm7(body) ? '' : ' — non-GSM characters forced UCS-2 encoding'}`
        : null;
    },
  },
  {
    name: 'plain-punctuation',
    applies: (ctx) => ctx.audience === 'customer',
    check: (text) => {
      const hit = findTypographicChar(text);
      return hit ? `typographic character "${hit}" — plain keyboard punctuation only (also silently doubles SMS segments)` : null;
    },
  },
  {
    name: 'stop-line-policy',
    // Only checkable when the caller knows whether this message class keeps
    // its STOP line (the #3343 keep-list) — undefined skips, never guesses.
    applies: (ctx) => ctx.channel === 'sms' && typeof ctx.stopExpected === 'boolean',
    check: (text, ctx) => {
      // A STOP tail in any of its real forms: an instruction verb before it
      // ("Reply STOP", "Send STOP"), an opt-out purpose after it ("STOP to
      // unsubscribe"), or the bare uppercase keyword itself — house voice
      // never shouts, so an all-caps STOP token is always the opt-out
      // keyword, while lowercase prose ("stop by the office") never is.
      const hasStop = /\b(?:reply|send|text|txt)\s+["']?stop\b/i.test(text)
        || /\bstop\b[\s,]+(?:to|2)\s+(?:unsubscribe|opt[\s-]?out|cancel|end)\b/i.test(text)
        || /\bSTOP\b/.test(text);
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

/** flags-array entries for a lintComms result, in the shape consumers already render. */
function toFlags(result) {
  return result.failures.map((f) => ({
    severity: 'warn',
    type: `comms_lint:${f.rule}`,
    detail: f.reason,
  }));
}

/** flags-array entries for a draft row, in the shape consumers already render. */
function lintFlags(text, context = {}) {
  return toFlags(lintComms(text, context));
}

module.exports = { lintComms, lintFlags, toFlags, smsSegmentCount, isGsm7, findBareThirdPartyHost, RULES, URL_SHORTENER_HOSTS };
