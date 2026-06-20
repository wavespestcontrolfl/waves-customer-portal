/**
 * Newsletter Phase 2 — in-email engagement quiz.
 *
 * One source of truth for: the quiz definitions (question + answers + the
 * interest tags each answer writes), the per-recipient answer links, the
 * email-safe rendered block, and the tag-write that fires when a recipient
 * clicks an answer.
 *
 * How it flows end-to-end:
 *   1. Operator drops the {{quiz}} token into the HTML body (composer button).
 *   2. At send time, newsletter-sender substitutes {{quiz}} per recipient with
 *      renderQuizHtml() — answer buttons whose hrefs carry that recipient's
 *      engagement_token (newsletter_send_deliveries.engagement_token).
 *   3. The recipient clicks an answer → public route GET renders a thank-you
 *      landing + auto-POSTs → recordQuizResponse() tags the subscriber.
 *   4. The tag (e.g. "lawn-interested", "lawn:brown-patch") is read verbatim by
 *      the composer's segment Tags filter (buildSubscriberQuery jsonb `?|`), so
 *      the click becomes targetable audience data on the next campaign.
 *
 * The answer keys here are the ONLY allowlist — the rendered buttons and the
 * server-side validation both derive from this config, so the email can never
 * carry an answer the server won't honor (and vice-versa).
 */

const db = require('../models/db');
const logger = require('./logger');
const { publicPortalUrl } = require('../utils/portal-url');

// Body substitution tokens. Hyphenated like {{greeting-name}} / {{grass-type}}
// so a model-written _italic_ marker can't split them mid-render. {{quiz}} is
// replaced with the HTML answer block; {{quiz-text}} with the plain-text list —
// two distinct tokens so one SendGrid substitution value never has to serve
// both the HTML and text parts (they differ).
const QUIZ_HTML_TOKEN = '{{quiz}}';
const QUIZ_TEXT_TOKEN = '{{quiz-text}}';

// The {{quiz}} token resolves to this quiz. Versioned so a future copy/answer
// change ships as 'lawn-headache-v2' without retroactively re-mapping the tags
// already written by v1 clicks.
const DEFAULT_QUIZ_ID = 'lawn-headache-v1';

// Every answer carries the broad interest tag (lawn-interested) plus its
// specific tag, so a segment can target "anyone who engaged" OR "brown-patch
// people" without a second pass. "Not sure" is intentionally interest-only.
const QUIZZES = {
  'lawn-headache-v1': {
    question: "What's your lawn's biggest headache?",
    answers: [
      { key: 'brown-patch', label: 'Brown patches', tags: ['lawn-interested', 'lawn:brown-patch'] },
      { key: 'weeds', label: 'Weeds', tags: ['lawn-interested', 'lawn:weeds'] },
      { key: 'bugs', label: 'Bugs', tags: ['lawn-interested', 'lawn:bugs'] },
      { key: 'not-sure', label: 'Not sure', tags: ['lawn-interested'] },
    ],
  },
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Brand palette (mirrors newsletter-draft COLORS — kept local so this module
// stays dependency-light and never imports the draft assembler).
const C = { navy: '#1B2C5B', blue: '#009CDE', muted: '#8B8680', rule: '#E7E2D7', cardBg: '#FAFAF8' };

function getQuiz(quizId) {
  return QUIZZES[quizId || DEFAULT_QUIZ_ID] || null;
}

/**
 * Resolve a (quizId, answerKey) pair to its answer definition, or null if
 * either is unknown. The only place answer keys are validated server-side.
 */
function resolveAnswer(quizId, answerKey) {
  const quiz = getQuiz(quizId);
  if (!quiz) return null;
  return quiz.answers.find((a) => a.key === answerKey) || null;
}

function hasQuizToken(content) {
  const s = String(content || '');
  return s.includes(QUIZ_HTML_TOKEN) || s.includes(QUIZ_TEXT_TOKEN);
}

// Per-recipient answer link. The engagement token is the auth; quizId +
// answerKey tell the server which tags to write.
function quizAnswerUrl(token, quizId, answerKey) {
  const base = publicPortalUrl();
  return `${base}/api/public/newsletter/quiz/${encodeURIComponent(token)}/${encodeURIComponent(quizId)}/${encodeURIComponent(answerKey)}`;
}

// Minimal HTML escape for the question/labels we control (defense in depth —
// these are static config strings, never user input).
function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * Render the email quiz block for ONE recipient. Table-based buttons for broad
 * mail-client support. When `token` is missing (no delivery row / archive
 * render) it falls back to the neutral, link-free version so a recipient never
 * sees a broken link.
 */
function renderQuizHtml({ token, quizId = DEFAULT_QUIZ_ID } = {}) {
  const quiz = getQuiz(quizId);
  if (!quiz) return '';
  if (!token || !UUID_RE.test(String(token))) return renderQuizNeutralHtml({ quizId });

  const buttons = quiz.answers.map((a) => {
    const url = quizAnswerUrl(token, quizId, a.key);
    return `<td style="padding:6px;">
<a href="${esc(url)}" style="display:block;background:${C.navy};color:#ffffff;text-decoration:none;border-radius:8px;padding:12px 10px;font-weight:700;font-size:15px;text-align:center;font-family:Inter,Arial,sans-serif;">${esc(a.label)}</a>
</td>`;
  });
  // Two-per-row grid so 4 answers read as a tidy 2×2 on mobile + desktop.
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(`<tr>${buttons.slice(i, i + 2).join('')}</tr>`);
  }

  return `<div style="margin:24px 0;padding:20px;background:${C.cardBg};border:1px solid ${C.rule};border-radius:12px;">
<p style="margin:0 0 14px 0;font-size:17px;font-weight:800;color:${C.navy};font-family:Inter,Arial,sans-serif;text-align:center;">${esc(quiz.question)}</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-collapse:separate;">
${rows.join('\n')}
</table>
<p style="margin:12px 0 0 0;font-size:12px;color:${C.muted};text-align:center;font-family:Inter,Arial,sans-serif;">Tap one — we'll bring a free lawn check on your next visit.</p>
</div>`;
}

// Plain-text equivalent for the text/plain part.
function renderQuizText({ token, quizId = DEFAULT_QUIZ_ID } = {}) {
  const quiz = getQuiz(quizId);
  if (!quiz) return '';
  if (!token || !UUID_RE.test(String(token))) return renderQuizNeutralText({ quizId });
  const lines = quiz.answers.map((a) => `- ${a.label}: ${quizAnswerUrl(token, quizId, a.key)}`);
  return `${quiz.question}\n${lines.join('\n')}`;
}

// No-recipient renders (public archive, RSS, preview/test send). No per-
// recipient token exists, so the answers are inert text — never dead links.
function renderQuizNeutralHtml({ quizId = DEFAULT_QUIZ_ID } = {}) {
  const quiz = getQuiz(quizId);
  if (!quiz) return '';
  const chips = quiz.answers.map((a) =>
    `<span style="display:inline-block;margin:4px;padding:9px 14px;background:#ffffff;border:1px solid ${C.rule};border-radius:8px;font-size:14px;color:${C.navy};font-family:Inter,Arial,sans-serif;">${esc(a.label)}</span>`,
  ).join('');
  return `<div style="margin:24px 0;padding:20px;background:${C.cardBg};border:1px solid ${C.rule};border-radius:12px;text-align:center;">
<p style="margin:0 0 12px 0;font-size:17px;font-weight:800;color:${C.navy};font-family:Inter,Arial,sans-serif;">${esc(quiz.question)}</p>
<div>${chips}</div>
<p style="margin:12px 0 0 0;font-size:12px;color:${C.muted};font-family:Inter,Arial,sans-serif;">Subscribers tap an answer right in the email to get a free lawn check.</p>
</div>`;
}

function renderQuizNeutralText({ quizId = DEFAULT_QUIZ_ID } = {}) {
  const quiz = getQuiz(quizId);
  if (!quiz) return '';
  return `${quiz.question} (${quiz.answers.map((a) => a.label).join(' / ')})`;
}

/**
 * Replace the quiz tokens in a body string with their NEUTRAL renders. Used by
 * stripPersonalizationTokens so every no-recipient surface (archive/RSS/preview)
 * shows the quiz without per-recipient links. (Live sends use SendGrid
 * substitutions in newsletter-sender, not this.)
 */
function neutralizeQuizTokens(content) {
  return String(content || '')
    .split(QUIZ_HTML_TOKEN).join(renderQuizNeutralHtml())
    .split(QUIZ_TEXT_TOKEN).join(renderQuizNeutralText());
}

/**
 * Record a quiz answer: tag the matching subscriber and stamp the delivery row.
 * Idempotent and safe to call from the public POST handler. Never throws — the
 * public endpoint must not leak token validity or DB state to the caller.
 *
 * Returns { ok, reason } where reason ∈ 'tagged' | 'bad-token' | 'bad-answer' |
 * 'no-delivery' | 'no-subscriber' | 'error'.
 */
async function recordQuizResponse({ token, quizId, answerKey }) {
  try {
    if (!token || !UUID_RE.test(String(token))) return { ok: false, reason: 'bad-token' };
    const answer = resolveAnswer(quizId, answerKey);
    if (!answer) return { ok: false, reason: 'bad-answer' };

    const delivery = await db('newsletter_send_deliveries')
      .where({ engagement_token: token })
      .first('id', 'subscriber_id');
    if (!delivery) return { ok: false, reason: 'no-delivery' };

    // Stamp the answer on the delivery row regardless (engagement record).
    await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
      quiz_id: quizId || DEFAULT_QUIZ_ID,
      quiz_answer: answer.key,
      quiz_answered_at: new Date(),
      updated_at: new Date(),
    });

    if (delivery.subscriber_id == null) return { ok: false, reason: 'no-subscriber' };

    // Atomic, order-independent tag merge in SQL: concat the existing tags with
    // this answer's tags (both jsonb arrays) and dedupe. Avoids a read-modify-
    // write race when a subscriber answers from two devices, and never clobbers
    // tags written by another path. Legacy/null/non-array tags coerce to []
    // first. The new tags bind as a single JSON string (?::jsonb) — not a JS
    // array — so there's no knex array-binding placeholder expansion.
    await db.raw(
      `UPDATE newsletter_subscribers
         SET tags = (
           SELECT COALESCE(jsonb_agg(DISTINCT e ORDER BY e), '[]'::jsonb)
           FROM jsonb_array_elements_text(
             (CASE WHEN jsonb_typeof(tags) = 'array' THEN tags ELSE '[]'::jsonb END) || ?::jsonb
           ) AS e
         ),
         updated_at = NOW()
       WHERE id = ?`,
      [JSON.stringify(answer.tags), delivery.subscriber_id],
    );

    logger.info(`[newsletter-quiz] subscriber id=${delivery.subscriber_id} answered ${quizId}/${answer.key} → tags ${answer.tags.join(', ')}`);
    return { ok: true, reason: 'tagged' };
  } catch (err) {
    logger.error(`[newsletter-quiz] recordQuizResponse failed: ${err.message}`);
    return { ok: false, reason: 'error' };
  }
}

module.exports = {
  QUIZ_HTML_TOKEN,
  QUIZ_TEXT_TOKEN,
  DEFAULT_QUIZ_ID,
  QUIZZES,
  getQuiz,
  resolveAnswer,
  hasQuizToken,
  quizAnswerUrl,
  renderQuizHtml,
  renderQuizText,
  renderQuizNeutralHtml,
  renderQuizNeutralText,
  neutralizeQuizTokens,
  recordQuizResponse,
};
