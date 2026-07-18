/**
 * Newsletter reader feedback — the reaction footer every edition ends with:
 *
 *   "How was this week's newsletter? 👍 Great · 😐 Okay · 👎 Needs work"
 *
 * Owner directive 2026-07-17. One source of truth for: the reaction keys, the
 * 👎 follow-up options ("what was missing?"), the per-recipient reaction
 * links, the email-safe rendered block, and the delivery-row write that fires
 * when a recipient confirms a reaction.
 *
 * How it flows end-to-end (deliberately identical to newsletter-quiz.js):
 *   1. The draft assembler appends {{feedback}} to every edition's HTML body
 *      ({{feedback-text}} to the plain-text part).
 *   2. At send time, newsletter-sender substitutes the token per recipient
 *      with renderFeedbackHtml()/renderFeedbackText() — reaction links whose
 *      hrefs carry that recipient's engagement_token
 *      (newsletter_send_deliveries).
 *   3. The recipient taps a reaction → public GET renders a confirm page; the
 *      write fires on the deliberate POST <form> submit (scanner-safe: mail
 *      gateways pre-fetch every link, some execute JS, so a GET or an on-load
 *      script must never mutate) → recordFeedbackReaction() stamps the
 *      delivery row. For 👎 the same confirm page asks what was missing —
 *      closer events, more local news, restaurant openings, family
 *      activities, or home tips — and the selections ride the same POST.
 *   4. Per-send tallies come straight from GROUP BY feedback_reaction on the
 *      delivery rows (admin send detail) — one row per recipient, so a
 *      changed mind overwrites and never double-counts.
 *
 * The reaction keys and missing-option keys here are the ONLY allowlist —
 * the rendered links and the server-side validation both derive from this
 * config, so the email can never carry a reaction the server won't honor.
 */

const db = require('../models/db');
const logger = require('./logger');
const { publicPortalUrl } = require('../utils/portal-url');

// Body substitution tokens, hyphenated like {{quiz-text}} so a model-written
// _italic_ marker can't split them mid-render. Two tokens so one SendGrid
// substitution value never has to serve both the HTML and text parts.
const FEEDBACK_HTML_TOKEN = '{{feedback}}';
const FEEDBACK_TEXT_TOKEN = '{{feedback-text}}';
// Fresh RegExp per use so the /g lastIndex is never shared across calls.
const FEEDBACK_TOKEN_PATTERN = '\\{\\{feedback(-text)?\\}\\}';

const FEEDBACK_QUESTION = "How was this week's newsletter?";

const REACTIONS = [
  { key: 'great', emoji: '👍', label: 'Great' },
  { key: 'okay', emoji: '😐', label: 'Okay' },
  { key: 'needs-work', emoji: '👎', label: 'Needs work' },
];

// 👎 follow-up options (owner-specified list — do not extend casually; the
// admin tally UI renders exactly these).
const MISSING_OPTIONS = [
  { key: 'closer-events', label: 'Closer events' },
  { key: 'local-news', label: 'More local news' },
  { key: 'restaurant-openings', label: 'Restaurant openings' },
  { key: 'family-activities', label: 'Family activities' },
  { key: 'home-tips', label: 'Home tips' },
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Palette resolved from the active email theme so the block matches the
// newsletter chrome it's substituted into (same getter pattern as the quiz).
const { newsletterPalette } = require('./email-template');
const C = {
  get navy() { return newsletterPalette().navy; },
  get muted() { return newsletterPalette().muted; },
  get rule() { return newsletterPalette().rule; },
  get cardBg() { return newsletterPalette().cardBg; },
};

function resolveReaction(key) {
  return REACTIONS.find((r) => r.key === String(key || '')) || null;
}

// Coerce the POST body's missing[] payload (string or array, form or JSON)
// down to the allowlisted option keys, deduped, in config order.
function resolveMissingKeys(input) {
  const raw = Array.isArray(input) ? input : (input == null ? [] : [input]);
  const provided = new Set(raw.map((v) => String(v)));
  return MISSING_OPTIONS.filter((o) => provided.has(o.key)).map((o) => o.key);
}

function feedbackReactionUrl(token, reactionKey) {
  return `${publicPortalUrl()}/api/public/newsletter/feedback/${token}/${reactionKey}`;
}

// Minimal HTML escape for the labels we control (defense in depth — these are
// static config strings, never user input).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Render the feedback footer for ONE recipient. Table-based buttons for broad
 * mail-client support; one row of three so the ask reads as a single line of
 * choices. When `token` is missing (no delivery row / archive render) it
 * falls back to the neutral, link-free version so a reader never sees a
 * broken link.
 */
function renderFeedbackHtml({ token } = {}) {
  if (!token || !UUID_RE.test(String(token))) return renderFeedbackNeutralHtml();

  const buttons = REACTIONS.map((r) => `<td style="padding:5px;">
<a href="${esc(feedbackReactionUrl(token, r.key))}" style="display:block;background:${C.navy};color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 8px;font-weight:700;font-size:15px;text-align:center;font-family:Inter,Arial,sans-serif;white-space:nowrap;">${esc(`${r.emoji} ${r.label}`)}</a>
</td>`).join('');

  return `<div style="margin:24px 0 0 0;padding:20px;background:${C.cardBg};border:1px solid ${C.rule};border-radius:12px;">
<p style="margin:0 0 14px 0;font-size:17px;font-weight:800;color:${C.navy};font-family:Inter,Arial,sans-serif;text-align:center;">${esc(FEEDBACK_QUESTION)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;">
<tr>${buttons}</tr>
</table>
<p style="margin:12px 0 0 0;font-size:12px;color:${C.muted};text-align:center;font-family:Inter,Arial,sans-serif;">One tap — it shapes next week's issue.</p>
</div>`;
}

// Plain-text equivalent for the text/plain part.
function renderFeedbackText({ token } = {}) {
  if (!token || !UUID_RE.test(String(token))) return renderFeedbackNeutralText();
  const lines = REACTIONS.map((r) => `- ${r.emoji} ${r.label}: ${feedbackReactionUrl(token, r.key)}`);
  return `${FEEDBACK_QUESTION}\n${lines.join('\n')}`;
}

// No-recipient renders (public archive, RSS, preview/test send). No per-
// recipient token exists, so the reactions are inert text — never dead links.
function renderFeedbackNeutralHtml() {
  const chips = REACTIONS.map((r) =>
    `<span style="display:inline-block;margin:4px;padding:9px 14px;background:#ffffff;border:1px solid ${C.rule};border-radius:8px;font-size:14px;color:${C.navy};font-family:Inter,Arial,sans-serif;">${esc(`${r.emoji} ${r.label}`)}</span>`,
  ).join('');
  return `<div style="margin:24px 0 0 0;padding:20px;background:${C.cardBg};border:1px solid ${C.rule};border-radius:12px;text-align:center;">
<p style="margin:0 0 12px 0;font-size:17px;font-weight:800;color:${C.navy};font-family:Inter,Arial,sans-serif;">${esc(FEEDBACK_QUESTION)}</p>
<div>${chips}</div>
</div>`;
}

function renderFeedbackNeutralText() {
  return `${FEEDBACK_QUESTION} ${REACTIONS.map((r) => `${r.emoji} ${r.label}`).join(' · ')}`;
}

function parseFeedbackTokens(content) {
  const tokens = [];
  const re = new RegExp(FEEDBACK_TOKEN_PATTERN, 'gi');
  let match;
  while ((match = re.exec(String(content || ''))) !== null) {
    tokens.push({ raw: match[0], isText: Boolean(match[1]) });
  }
  return tokens;
}

function hasFeedbackToken(content) {
  return new RegExp(FEEDBACK_TOKEN_PATTERN, 'i').test(String(content || ''));
}

// Per-recipient SendGrid substitutions for every feedback token in the body.
function buildFeedbackSubstitutions(content, { token } = {}) {
  const subs = {};
  for (const t of parseFeedbackTokens(content)) {
    subs[t.raw] = t.isText
      ? renderFeedbackText({ token })
      : renderFeedbackHtml({ token });
  }
  return subs;
}

/**
 * Replace every feedback token with its NEUTRAL render. Used by
 * stripPersonalizationTokens so every no-recipient surface (archive, RSS,
 * preview/test send) shows the question without per-recipient links. (Live
 * sends use SendGrid substitutions in newsletter-sender, not this.)
 */
function neutralizeFeedbackTokens(content) {
  return String(content || '').replace(new RegExp(FEEDBACK_TOKEN_PATTERN, 'gi'), (raw, dashText) => (
    dashText ? renderFeedbackNeutralText() : renderFeedbackNeutralHtml()
  ));
}

/**
 * Record a reaction (and the 👎 follow-up selections) on the delivery row.
 * Idempotent per recipient — a repeat vote overwrites, so tallies count
 * people, not clicks. Never throws — the public endpoint must not leak token
 * validity or DB state to the caller.
 *
 * Returns { ok, reason } where reason ∈ 'recorded' | 'bad-token' |
 * 'bad-reaction' | 'no-delivery' | 'error'.
 */
async function recordFeedbackReaction({ token, reaction, missing } = {}) {
  try {
    if (!token || !UUID_RE.test(String(token))) return { ok: false, reason: 'bad-token' };
    const resolved = resolveReaction(reaction);
    if (!resolved) return { ok: false, reason: 'bad-reaction' };

    const delivery = await db('newsletter_send_deliveries')
      .where({ engagement_token: token })
      .first('id');
    if (!delivery) return { ok: false, reason: 'no-delivery' };

    // The follow-up list only means anything on a negative vote; a 👍/😐
    // clears any previously stored list so a changed mind leaves no stale
    // "what was missing" attached to a positive reaction.
    const missingKeys = resolved.key === 'needs-work' ? resolveMissingKeys(missing) : [];
    await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
      feedback_reaction: resolved.key,
      feedback_missing: missingKeys.length ? JSON.stringify(missingKeys) : null,
      feedback_at: new Date(),
      updated_at: new Date(),
    });

    logger.info(`[newsletter-feedback] delivery id=${delivery.id} reaction=${resolved.key}${missingKeys.length ? ` missing=${missingKeys.join(',')}` : ''}`);
    return { ok: true, reason: 'recorded' };
  } catch (err) {
    logger.error(`[newsletter-feedback] record failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

module.exports = {
  FEEDBACK_HTML_TOKEN,
  FEEDBACK_TEXT_TOKEN,
  FEEDBACK_QUESTION,
  REACTIONS,
  MISSING_OPTIONS,
  resolveReaction,
  resolveMissingKeys,
  feedbackReactionUrl,
  renderFeedbackHtml,
  renderFeedbackText,
  renderFeedbackNeutralHtml,
  renderFeedbackNeutralText,
  hasFeedbackToken,
  buildFeedbackSubstitutions,
  neutralizeFeedbackTokens,
  recordFeedbackReaction,
};
