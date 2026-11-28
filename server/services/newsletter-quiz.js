/**
 * Newsletter Phase 2 — in-email engagement quiz.
 *
 * One source of truth for: the quiz definitions (question + answers + the
 * interest tags each answer writes), the per-recipient answer links, the
 * email-safe rendered block, and the tag-write that fires when a recipient
 * clicks an answer.
 *
 * How it flows end-to-end:
 *   1. Operator drops a quiz token into the HTML body (composer "Insert lawn
 *      quiz" button). The default quiz is {{quiz}}; a specific quiz is
 *      {{quiz:pest-pressure-v1}} (and {{quiz-text}} / {{quiz-text:id}} for the
 *      plain-text part).
 *   2. At send time, newsletter-sender substitutes each quiz token per recipient
 *      with renderQuizHtml()/renderQuizText() — answer buttons whose hrefs carry
 *      that recipient's engagement_token (newsletter_send_deliveries).
 *   3. The recipient clicks an answer → public GET renders a confirm page; the
 *      tag write fires on the deliberate POST <form> submit (scanner-safe) →
 *      recordQuizResponse() tags the subscriber + stamps the delivery row.
 *   4. The tags (e.g. "lawn-interested", "lawn:brown-patch") are read verbatim by
 *      the composer's segment Tags filter (buildSubscriberQuery jsonb `?|`), so
 *      the click becomes targetable audience data on the next campaign.
 *
 * The answer keys here are the ONLY allowlist — the rendered buttons and the
 * server-side validation both derive from this config, so the email can never
 * carry an answer the server won't honor (and vice-versa).
 */

// The database loads where it is used (recordQuizResponse, newsletterIssuePolls), not here: the
// Waves Pest Insider builder loads this module for its polls and must build offline, with no
// database module (pest-insider/index.js; pre-push round 21).
const logger = require('./logger');
const { publicPortalUrl } = require('../utils/portal-url');
const { PEST_INSIDER_TYPE } = require('../config/newsletter-types');
const { etCalendarDaysUntil } = require('../utils/datetime-et');

// Body substitution tokens. Hyphenated like {{greeting-name}} / {{grass-type}}
// so a model-written _italic_ marker can't split them mid-render. {{quiz}} is
// replaced with the HTML answer block; {{quiz-text}} with the plain-text list —
// two distinct tokens so one SendGrid substitution value never has to serve
// both the HTML and text parts (they differ). An explicit quiz can be named
// with a suffix: {{quiz:pest-pressure-v1}} / {{quiz-text:pest-pressure-v1}}.
const QUIZ_HTML_TOKEN = '{{quiz}}';
const QUIZ_TEXT_TOKEN = '{{quiz-text}}';
// Matches all four forms. group1 = '-text' (text part) | undefined; group2 =
// quiz id | undefined (→ default). Built into a fresh RegExp per use so the
// /g lastIndex is never shared across calls.
const QUIZ_TOKEN_PATTERN = '\\{\\{quiz(-text)?(?::([a-z0-9-]+))?\\}\\}';

// The bare {{quiz}} token resolves to this quiz. Versioned so a future
// copy/answer change ships as 'lawn-headache-v2' without retroactively
// re-mapping the tags already written by v1 clicks.
const DEFAULT_QUIZ_ID = 'lawn-headache-v1';

// Booking-source slug stamped on the thank-you deep-link (self_booked_appointments.source,
// a free-text varchar) so quiz-driven bookings are attributable in /api/booking/sources.
// NOT in ONE_TIME_BOOKING_SOURCES → the booking stays a recurring enrollment.
const QUIZ_BOOKING_SOURCE = 'newsletter-quiz';

// Each answer carries a broad interest tag (e.g. lawn-interested) plus its
// specific tag, so a segment can target "anyone who engaged" OR a specific
// interest without a second pass. An answer with no buy-intent (e.g. mosquito
// "We're good") writes NO tag — it still records the response on the delivery
// row for the results dashboard. Per-quiz copy (emailCta / landingLine /
// bookLabel) keeps the lawn/pest/mosquito framing honest across quizzes.
// `bookService` is the /book service id the thank-you CTA deep-links to so the
// booking pre-selects the line the respondent just told us they want — it MUST
// match a SERVICES[].id in client/src/pages/PublicBookingPage.jsx.
const QUIZZES = {
  'lawn-headache-v1': {
    label: 'Lawn headache',
    question: "What's your lawn's biggest headache?",
    emailCta: "Tap one — we'll bring a free lawn check on your next visit.",
    landingLine: "We'll bring a free lawn check on your next visit.",
    bookLabel: 'Book a lawn check',
    bookService: 'lawn_care',
    answers: [
      { key: 'brown-patch', label: 'Brown patches', tags: ['lawn-interested', 'lawn:brown-patch'] },
      { key: 'weeds', label: 'Weeds', tags: ['lawn-interested', 'lawn:weeds'] },
      { key: 'bugs', label: 'Bugs', tags: ['lawn-interested', 'lawn:bugs'] },
      { key: 'not-sure', label: 'Not sure', tags: ['lawn-interested'] },
    ],
  },
  'pest-pressure-v1': {
    label: 'Pest pressure',
    question: "What's bugging you most right now?",
    emailCta: "Tap one — we'll do a free pest check on your next visit.",
    landingLine: "We'll do a free pest check on your next visit.",
    bookLabel: 'Book a pest visit',
    bookService: 'pest_control',
    answers: [
      { key: 'ants', label: 'Ants', tags: ['pest-interested', 'pest:ants'] },
      { key: 'roaches', label: 'Roaches', tags: ['pest-interested', 'pest:roaches'] },
      { key: 'rodents', label: 'Rodents', tags: ['pest-interested', 'pest:rodents'] },
      { key: 'mosquitoes', label: 'Mosquitoes', tags: ['pest-interested', 'mosquito-interested'] },
    ],
  },
  'mosquito-v1': {
    label: 'Mosquito',
    question: 'Mosquitoes running you off your own yard?',
    emailCta: "Tap one — we'll size up your yard on your next visit.",
    landingLine: "We'll size up your yard on your next visit.",
    bookLabel: 'Book a mosquito visit',
    bookService: 'mosquito',
    answers: [
      { key: 'every-night', label: 'Every night', tags: ['mosquito-interested', 'mosquito:high'] },
      { key: 'sometimes', label: 'Some nights', tags: ['mosquito-interested'] },
      { key: 'were-good', label: "We're good", tags: [] },
    ],
  },

  // Win-back CTA for the newsletter-sunset lane. The quiz flow's GET-renders /
  // POST-mutates split is the scanner-safe consent the sunset job requires:
  // Safe-Links-style prefetchers can fire raw SendGrid click events, but only
  // a deliberate confirm-form submit stamps quiz_answered_at — the ONE signal
  // reactivateSunsetComebacks() accepts. No interest tags: staying subscribed
  // is not a sales lead, and landingCtaSuppressed keeps the thank-you page
  // from pitching a booking.
  'stay-subscribed-v1': {
    label: 'Stay subscribed',
    question: 'Want to keep getting these emails?',
    emailCta: "Two taps — the button, then a confirm — and you're set.",
    landingLine: "You're staying on the list — see you in the next issue.",
    landingCtaSuppressed: true,
    bookLabel: 'Book a visit',
    bookService: 'pest_control',
    answers: [
      { key: 'stay', label: 'Yes — keep me on the list', tags: [] },
    ],
  },
};

// Waves Newsletter polls: the list the owner approved on 2026-11-20 (NL1-NL10
// on the Pest Insider look page; "other than that looks good"), in his order.
// Just for fun: no interest tags, no visit promise, and landingCtaSuppressed
// keeps the thank-you page from pitching a booking. A vote takes the same two
// taps as every quiz (the answer, then Confirm). The autopilot adds one poll
// to at most every 3rd issue (chooseNewsletterPoll); nothing else adds one.
const NEWSLETTER_POLLS = [
  ['nl-poll-weekend-v1', 'Poll: weekend plans', 'Where will you be this weekend?',
    [['beach', 'Beach'], ['park', 'Park'], ['home', 'Home'], ['out-to-eat', 'Out to eat']]],
  ['nl-poll-drive-v1', 'Poll: drive for an event', 'How far will you drive for a good event?',
    [['15-minutes', '15 minutes'], ['half-hour', 'Half an hour'], ['hour', 'An hour'], ['road-trip', 'Road trip!']]],
  ['nl-poll-sunset-spot-v1', 'Poll: sunset spot', 'Your Gulf sunset spot?',
    [['siesta-key', 'Siesta Key'], ['anna-maria', 'Anna Maria'], ['st-pete-beach', 'St. Pete Beach'], ['somewhere-else', 'Somewhere else']]],
  ['nl-poll-classic-v1', 'Poll: Florida classic', 'Pick one Florida classic',
    [['grouper-sandwich', 'Grouper sandwich'], ['cuban-sandwich', 'Cuban sandwich'], ['stone-crab', 'Stone crab'], ['key-lime-pie', 'Key lime pie']]],
  ['nl-poll-rainy-v1', 'Poll: rainy afternoon', 'Rainy afternoon plan?',
    [['museum', 'Museum'], ['movie', 'Movie'], ['mall', 'Mall'], ['nap', 'Nap']]],
  ['nl-poll-whats-on-v1', "Poll: finding what's on", "How do you find out what's on?",
    [['waves-newsletter', 'Waves Newsletter'], ['friends', 'Friends'], ['social-media', 'Social media'], ['wing-it', 'I wing it']]],
  ['nl-poll-dogs-v1', 'Poll: dogs at events', 'Dogs at events: more, please?',
    [['more', 'More, please'], ['fine', "They're fine"], ['fewer', 'Fewer, please'], ['no-opinion', 'No opinion']]],
  ['nl-poll-sunrise-v1', 'Poll: sunrise or sunset', 'Sunrise or sunset?',
    [['sunrise', 'Sunrise'], ['sunset', 'Sunset'], ['both', 'Both'], ['asleep', "I'm asleep"]]],
  ['nl-poll-season-v1', 'Poll: best season', 'Best Florida season?',
    [['winter', 'Winter'], ['spring', 'Spring'], ['summer', 'Summer'], ['fall', 'Fall (what fall?)']]],
  ['nl-poll-music-v1', 'Poll: live music', "Live music: what's your speed?",
    [['rock', 'Rock'], ['country', 'Country'], ['jazz-blues', 'Jazz or blues'], ['anything-live', 'Anything live']]],
];
// Waves Pest Insider polls: the wording and order the owner approved on
// 2026-11-22 ("polls rec", choice C), which replace the 2026-11-20 list (PI1-PI6
// on the same page). Same rules as the Waves Newsletter's. The Pest Insider
// planner adds one to at most every 3rd issue (pest-insider/schedule.js, through
// chooseNewsletterPoll); nothing else adds one.
const PEST_INSIDER_POLLS = [
  ['pi-poll-house-spider-v1', 'Poll: spider in the house', 'Spider in the house. What happens next?',
    [['cup-and-card', 'Cup and card'], ['leave-it-be', 'Leave it be'], ['shoe', 'Shoe'], ['move-out', 'Move out']]],
  ['pi-poll-worst-guest-v1', 'Poll: worst house guest', 'Which pest is the worst house guest?',
    [['ants', 'Ants'], ['roaches', 'Roaches'], ['mosquitoes', 'Mosquitoes'], ['spiders', 'Spiders']]],
  ['pi-poll-lizards-v1', 'Poll: lizards on the lanai', 'Lizards on the lanai: friend or foe?',
    [['friend', 'Friend'], ['foe', 'Foe'], ['depends', 'Depends'], ['what-lizards', 'What lizards?']]],
  ['pi-poll-bug-surprise-v1', 'Poll: Florida bug surprise', 'Biggest Florida bug surprise?',
    [['palmetto-bugs', 'Palmetto bugs'], ['lovebugs', 'Lovebugs'], ['fire-ants', 'Fire ants'], ['no-see-ums', 'No-see-ums']]],
  ['pi-poll-yard-smell-v1', 'Poll: yard smell', 'Best smell in a Florida yard?',
    [['orange-blossom', 'Orange blossom'], ['cut-grass', 'Cut grass'], ['jasmine', 'Jasmine'], ['rain-coming', 'Rain coming']]],
  ['pi-poll-mosquito-bites-v1', 'Poll: mosquito bites', 'Who gets the mosquito bites at your house?',
    [['me-always', 'Me, always'], ['everyone', 'Everyone'], ['not-me', 'Not me'], ['nobody', 'Nobody']]],
];
// Retired Waves Pest Insider polls: the planner never picks one again, but an
// email already sent can still carry its vote links. So the definition stays:
// a late vote from such an email still counts, the poll rules of
// recordQuizResponse still hold for that issue (no other quiz's answer replaces
// the vote), and the poll history still reads that issue as a poll issue. No
// new issue shows one (render.js pollBlock takes a current poll only) and the
// result line never reports one (pollResultLine).
// pi-poll-bugging-you-v1: reworded and replaced by pi-poll-worst-guest-v1 on
// 2026-11-22; a vote on the old question is not a vote on the new one.
const RETIRED_PEST_INSIDER_POLLS = [
  ['pi-poll-bugging-you-v1', 'Poll: pest bugging you', 'Which pest bugs you most this month?',
    [['ants', 'Ants'], ['roaches', 'Roaches'], ['mosquitoes', 'Mosquitoes'], ['spiders', 'Spiders']]],
];
// Adds one newsletter's polls to QUIZZES; returns their ids in the owner's
// order: the newsletter uses each once, then stops.
function addPolls(polls, landingLine) {
  for (const [id, label, question, answers] of polls) {
    QUIZZES[id] = {
      label,
      question,
      emailCta: 'Tap one, then confirm. Just for fun.',
      landingLine,
      // The archive and the owner's Wednesday or FYI copy show the poll with no links.
      neutralLine: 'Readers vote right in the email. Just for fun.',
      landingCtaSuppressed: true,
      poll: true,
      bookLabel: 'Book a visit',
      bookService: 'pest_control',
      answers: answers.map(([key, text]) => ({ key, label: text, tags: [] })),
    };
  }
  return Object.freeze(polls.map(([id]) => id));
}
const NEWSLETTER_POLL_IDS = addPolls(NEWSLETTER_POLLS, 'Your vote is in. See you in the next Waves Newsletter.');
// The Waves Pest Insider's next issue opens with the last poll's result (pollResultLine).
const PEST_INSIDER_POLL_IDS = addPolls(PEST_INSIDER_POLLS, "Your vote is in. We'll share the top answer in the Waves Pest Insider.");
// A retired poll keeps the thank-you line it had: it promises no result.
const RETIRED_PEST_INSIDER_POLL_IDS = addPolls(RETIRED_PEST_INSIDER_POLLS, 'Your vote is in. See you in the next Waves Pest Insider.');
const isNewsletterPoll = (quizId) => NEWSLETTER_POLL_IDS.includes(quizId);
// A CURRENT Waves Pest Insider poll: one a new issue may show.
const isPestInsiderPoll = (quizId) => PEST_INSIDER_POLL_IDS.includes(quizId);
// Any poll an email can carry, a retired one included (the vote rules).
const isPoll = (quizId) => isNewsletterPoll(quizId) || isPestInsiderPoll(quizId) || RETIRED_PEST_INSIDER_POLL_IDS.includes(quizId);
// A newsletter type's own list: the Waves Pest Insider's for its type, the
// Waves Newsletter's for any other (only the flagship draft shows one).
const pollIdsFor = (newsletterType) => (newsletterType === PEST_INSIDER_TYPE ? PEST_INSIDER_POLL_IDS : NEWSLETTER_POLL_IDS);
// The polls an issue of that type can hold, retired ones included: what the
// poll history reads, so an old issue with a retired poll still counts as a
// poll issue for the every-3rd-issue rule.
const PEST_INSIDER_POLL_HISTORY_IDS = Object.freeze([...PEST_INSIDER_POLL_IDS, ...RETIRED_PEST_INSIDER_POLL_IDS]);
const pollHistoryIdsFor = (newsletterType) => (newsletterType === PEST_INSIDER_TYPE ? PEST_INSIDER_POLL_HISTORY_IDS : NEWSLETTER_POLL_IDS);
// Every poll id carries this; the history query's loose prefilter reads it.
const POLL_ID_MARK = '-poll-';
/** Sent issues between two polls: a poll shows in at most every 3rd issue, never two in a row. */
const POLL_ISSUE_GAP = 2;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Brand palette resolved from the active email theme (glass) so quiz blocks
// match the newsletter chrome they're substituted into — the old hardcoded
// literals (#1B2C5B/#009CDE warm set) rendered old-navy fragments inside
// glass newsletters. Still never imports the draft assembler.
const { newsletterPalette } = require('./email-template');
const C = {
  get navy() { return newsletterPalette().navy; },
  get blue() { return newsletterPalette().blue; },
  get muted() { return newsletterPalette().muted; },
  get rule() { return newsletterPalette().rule; },
  get cardBg() { return newsletterPalette().cardBg; },
};

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

// Human label for a stored answer key (results dashboard). Falls back to the
// raw key so a legacy/removed answer still renders something.
function answerLabel(quizId, answerKey) {
  const a = resolveAnswer(quizId, answerKey);
  return a ? a.label : answerKey;
}

/**
 * Aggregate raw per-answer count rows (from newsletter_send_deliveries grouped
 * by quiz_id + quiz_answer) into the History view's results shape. Pure — the
 * route does the DB query and passes the rows in, so this is unit-testable.
 *
 * @param {object} args
 * @param {Array<{quiz_id?:string, quiz_answer:string, n?:number|string, count?:number|string}>} args.rows
 * @param {number} args.totalRecipients
 */
function aggregateQuizResults({ rows = [], totalRecipients = 0 } = {}) {
  const byQuiz = new Map();
  let totalResponses = 0;
  for (const r of rows) {
    const n = Number(r.n ?? r.count ?? 0);
    totalResponses += n;
    const quizId = r.quiz_id || DEFAULT_QUIZ_ID;
    if (!byQuiz.has(quizId)) byQuiz.set(quizId, []);
    byQuiz.get(quizId).push({ key: r.quiz_answer, label: answerLabel(quizId, r.quiz_answer), count: n });
  }
  const quizzes = Array.from(byQuiz.entries()).map(([quizId, answers]) => {
    const quiz = getQuiz(quizId);
    // Order answers by the quiz config; unknown/legacy keys sort last.
    const order = quiz ? quiz.answers.map((a) => a.key) : [];
    answers.sort((a, b) => {
      const ia = order.indexOf(a.key); const ib = order.indexOf(b.key);
      return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
    });
    return {
      quizId,
      question: quiz?.question || quizId,
      responses: answers.reduce((s, a) => s + a.count, 0),
      answers,
    };
  });
  return {
    totalRecipients,
    totalResponses,
    responseRate: totalRecipients ? Math.round((totalResponses / totalRecipients) * 1000) / 10 : 0,
    quizzes,
  };
}

/**
 * Parse every distinct quiz token in a body string.
 * Returns [{ raw, isText, quizId }]. Deduped on the raw token text.
 */
function parseQuizTokens(content) {
  const re = new RegExp(QUIZ_TOKEN_PATTERN, 'gi');
  const out = [];
  const seen = new Set();
  let m;
  while ((m = re.exec(String(content || ''))) !== null) {
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push({ raw: m[0], isText: !!m[1], quizId: m[2] || DEFAULT_QUIZ_ID });
  }
  return out;
}

function hasQuizToken(content) {
  return new RegExp(QUIZ_TOKEN_PATTERN, 'i').test(String(content || ''));
}

// Per-recipient answer link. The engagement token is the auth; quizId +
// answerKey tell the server which tags to write.
function quizAnswerUrl(token, quizId, answerKey) {
  const base = publicPortalUrl();
  return `${base}/api/public/newsletter/quiz/${encodeURIComponent(token)}/${encodeURIComponent(quizId)}/${encodeURIComponent(answerKey)}`;
}

/**
 * Thank-you-page "book now" deep link. Pre-selects the quiz's service on /book
 * (?service=<id>, matched against PublicBookingPage SERVICES) and attributes the
 * booking (?source=newsletter-quiz) so the respondent never has to re-pick the
 * line they just told us. An unknown quiz (or one without a bookService) degrades
 * to /book with the source only — never a broken or mis-selected link.
 */
function quizBookingUrl(quizId) {
  const quiz = getQuiz(quizId);
  const params = new URLSearchParams();
  if (quiz?.bookService) params.set('service', quiz.bookService);
  params.set('source', QUIZ_BOOKING_SOURCE);
  return `${publicPortalUrl()}/book?${params.toString()}`;
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
    return `<td style="border-radius:10px;background:${C.navy};mso-padding-alt:12px 10px;"><a href="${esc(url)}" class="dm-onnavy" style="display:block;color:#fff;text-decoration:none;padding:12px 10px;font-weight:700;font-size:16px;text-align:center;font-family:Inter,Arial,sans-serif;">${esc(a.label)}</a></td>`;
  });
  // Two-per-row grid so up to 4 answers read as a tidy grid on mobile + desktop.
  const rows = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(`<tr>${buttons.slice(i, i + 2).join('')}</tr>`);
  }

  return `<div class="dm-box" style="margin:24px 0;padding:20px;background:${C.cardBg};border:1px solid ${C.rule};border-radius:12px;">
<p style="margin:0 0 14px;font-size:18px;font-weight:700;color:${C.navy};font-family:Inter,Arial,sans-serif;text-align:center;">${esc(quiz.question)}</p>
<table role="presentation" cellpadding="0" cellspacing="12" style="width:100%;border-collapse:separate">
${rows.join('\n')}
</table>
<p style="margin:12px 0 0 0;font-size:14px;color:${C.muted};text-align:center;font-family:Inter,Arial,sans-serif;">${esc(quiz.emailCta || "Tap one — we'll follow up on your next visit.")}</p>
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
    `<span class="dm-chip-lite" style="display:inline-block;margin:4px;padding:9px 14px;background:#ffffff;border:1px solid ${C.rule};border-radius:10px;font-size:14px;color:${C.navy};font-family:Inter,Arial,sans-serif;">${esc(a.label)}</span>`,
  ).join('');
  return `<div class="dm-box" style="margin:24px 0;padding:20px;background:${C.cardBg};border:1px solid ${C.rule};border-radius:12px;text-align:center;">
<p style="margin:0 0 12px 0;font-size:18px;font-weight:700;color:${C.navy};font-family:Inter,Arial,sans-serif;">${esc(quiz.question)}</p>
<div>${chips}</div>
<p style="margin:12px 0 0 0;font-size:14px;color:${C.muted};font-family:Inter,Arial,sans-serif;">${esc(quiz.neutralLine || 'Subscribers tap an answer right in the email to get a free check.')}</p>
</div>`;
}

function renderQuizNeutralText({ quizId = DEFAULT_QUIZ_ID } = {}) {
  const quiz = getQuiz(quizId);
  if (!quiz) return '';
  return `${quiz.question} (${quiz.answers.map((a) => a.label).join(' / ')})`;
}

/**
 * Build the per-recipient SendGrid substitution map for every quiz token found
 * in `content`. Keyed by the raw token text so each {{quiz}} / {{quiz:id}} /
 * {{quiz-text}} / {{quiz-text:id}} gets the right HTML or text render for its
 * quiz. Used by newsletter-sender.
 */
function buildQuizSubstitutions(content, { token } = {}) {
  const subs = {};
  for (const t of parseQuizTokens(content)) {
    subs[t.raw] = t.isText
      ? renderQuizText({ token, quizId: t.quizId })
      : renderQuizHtml({ token, quizId: t.quizId });
  }
  return subs;
}

/**
 * Replace every quiz token in a body string with its NEUTRAL render. Used by
 * stripPersonalizationTokens so every no-recipient surface (archive/RSS/preview)
 * shows the quiz without per-recipient links. (Live sends use SendGrid
 * substitutions in newsletter-sender, not this.) An unknown quiz id renders to
 * '' — the token is removed, never leaked literally.
 */
function neutralizeQuizTokens(content) {
  return String(content || '').replace(new RegExp(QUIZ_TOKEN_PATTERN, 'gi'), (raw, dashText, id) => {
    const quizId = id || DEFAULT_QUIZ_ID;
    return dashText ? renderQuizNeutralText({ quizId }) : renderQuizNeutralHtml({ quizId });
  });
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
  const db = require('../models/db');
  try {
    if (!token || !UUID_RE.test(String(token))) return { ok: false, reason: 'bad-token' };
    const answer = resolveAnswer(quizId, answerKey);
    if (!answer) return { ok: false, reason: 'bad-answer' };

    const delivery = await db('newsletter_send_deliveries')
      .where({ engagement_token: token })
      .first('id', 'subscriber_id', 'send_id');
    if (!delivery) return { ok: false, reason: 'no-delivery' };

    // A poll answer (Waves Newsletter or Waves Pest Insider) counts only from
    // an issue that showed that poll, and an issue that showed a poll takes
    // answers only to the quizzes it showed (quizzesInIssue, the rule the poll history reads
    // too): an older issue's token must not record a poll its reader never
    // saw, and a hand-made link must not overwrite a poll vote (or add
    // service tags) with another quiz's answer. An issue with no poll keeps
    // the old rule. The public route answers the same either way.
    const answeredQuiz = quizId || DEFAULT_QUIZ_ID;
    const shown = quizzesInIssue(await db('newsletter_sends').where({ id: delivery.send_id }).first('html_body', 'text_body'));
    if ((isPoll(answeredQuiz) || shown.some(isPoll)) && !shown.includes(answeredQuiz)) {
      return { ok: false, reason: 'not-in-issue' };
    }

    // Stamp the answer on the delivery row regardless (engagement record).
    await db('newsletter_send_deliveries').where({ id: delivery.id }).update({
      quiz_id: quizId || DEFAULT_QUIZ_ID,
      quiz_answer: answer.key,
      quiz_answered_at: new Date(),
      updated_at: new Date(),
    });

    if (delivery.subscriber_id == null) return { ok: false, reason: 'no-subscriber' };

    // An answer with no buy-intent tags (e.g. mosquito "We're good") records the
    // response above but writes no tag — skip the tag merge entirely.
    if (!answer.tags.length) {
      logger.info(`[newsletter-quiz] subscriber id=${delivery.subscriber_id} answered ${quizId}/${answer.key} (no tag)`);
      return { ok: true, reason: 'tagged' };
    }

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

/**
 * The quizzes an issue shows: every quiz token, of either form, in either
 * part, in any letter case. These are the tokens the sender renders as vote
 * links: newsletter-sender.js builds one substitution map from both parts
 * joined (buildQuizSubstitutions), and SendGrid applies it to both parts.
 */
function quizzesInIssue(issue) {
  return parseQuizTokens(`${issue?.html_body || ''}\n${issue?.text_body || ''}`).map((token) => token.quizId);
}

// The poll from `ids` (default: the Waves Newsletter's) an issue shows, or null.
function pollInIssue(issue, ids = NEWSLETTER_POLL_IDS) {
  return quizzesInIssue(issue).find((quizId) => ids.includes(quizId)) || null;
}

/**
 * The poll for a newsletter's next issue, or null. `recent` lists the newest
 * POLL_ISSUE_GAP issues readers got (newest first), each as the poll it
 * showed or null; `used` lists every poll an issue holds; `ids` is that
 * newsletter's list (newsletterIssuePolls returns all three; the default is
 * the Waves Newsletter's). No poll when one of the recent issues had one, so a
 * poll shows in at most every 3rd issue and never in two in a row. Otherwise
 * the first poll in the owner's order that no issue holds; none once the list
 * is used up.
 */
function chooseNewsletterPoll({ recent = [], used = [], ids = NEWSLETTER_POLL_IDS } = {}) {
  if (recent.slice(0, POLL_ISSUE_GAP).some(Boolean)) return null;
  const taken = new Set(used);
  return ids.find((id) => !taken.has(id)) || null;
}

// An issue's time: its sent_at, else the earliest time any of its delivery rows
// records, else its schedule, else its draft time (the rule newsletterIssuePolls
// describes). Both history reads sort and date issues by it.
const ISSUE_TIME_SQL = `COALESCE(s.sent_at,
      (SELECT LEAST(MIN(f.sent_at), MIN(f.delivered_at), MIN(f.opened_at), MIN(f.clicked_at),
          MIN(f.complained_at), MIN(f.unsubscribed_at))
        FROM newsletter_send_deliveries f WHERE f.send_id = s.id),
      s.scheduled_for, s.created_at)`;

// whereExists callback: one of the issue's delivery rows reached its reader by
// the sender's own rule. reachedDelivery's unqualified columns are d's: SQL
// resolves a name in the innermost FROM first, before the outer newsletter_sends row.
function reachedRowFilter(knex) {
  // Loaded here, not at the top: newsletter-sender.js loads this module first.
  const { reachedDelivery } = require('./newsletter-sender');
  return (sub) => {
    reachedDelivery(sub.select(knex.raw('1')).from('newsletter_send_deliveries as d').whereRaw('d.send_id = s.id'));
  };
}

// The newest `limit` issues of one newsletter type that readers got (newest
// first), with `columns` of each (newsletter_sends as s).
function newestReachedIssues({ newsletterType, knex, limit, columns }) {
  return knex('newsletter_sends as s')
    .where('s.newsletter_type', newsletterType)
    .whereExists(reachedRowFilter(knex))
    .orderByRaw(`${ISSUE_TIME_SQL} DESC`)
    .limit(limit)
    .select(columns);
}

/**
 * Reads what chooseNewsletterPoll needs from the issues of one newsletter
 * type: its list (pollIdsFor), the polls of the newest POLL_ISSUE_GAP issues
 * that readers got, and every poll an issue holds. An issue reached readers when one of its delivery
 * rows reached its reader by the sender's own rule (newsletter-sender.js
 * reachedDelivery), whatever the issue's status: a send its deadline stopped,
 * or one the stale-claim recovery ended, is 'failed' although its first
 * batches reached readers; a 'sent' issue whose every recipient dropped out
 * before dispatch, or whose every message hard-bounced, reached no one (its
 * recipient_count is no proof either way: a worker that stopped after a
 * batch leaves it at 0).
 * Sent bodies keep their quiz tokens (the per-reader buttons are SendGrid
 * substitutions), so the tokens in html_body and text_body are the record,
 * read as the sender renders them (pollInIssue).
 * An issue's time is its sent_at, else the earliest time any of its delivery
 * rows records (a worker that failed after a batch leaves sent_at empty, a
 * lost SendGrid answer leaves a row's sent_at empty while the webhook still
 * stamps the delivery, and a resume clears scheduled_for), else its schedule,
 * else its draft time.
 *
 * An issue no reader got yet still holds its poll while a Resume could mail
 * one of its rows (newsletter-sender.js outstandingEligibleDeliveries: a
 * retryable row of a still-eligible reader): sendCampaign skips the Thursday
 * window for a resume of existing rows, so that issue can go out after a
 * later one. Its poll is never chosen again, and is skipped if the issue is
 * never resumed. It is held, not every poll: a failed issue nobody resumes
 * would otherwise stop the polls for good.
 * Any other unsent issue holds nothing: a fresh send of a flagship issue goes
 * out only on its own Thursday at 6:00 AM ET (newsletter-sender.js
 * isCurrentFlagshipTarget + isFlagshipDeliveryWindow), and its approval needs
 * that Thursday still ahead (newsletter-proof.js resolveFlagshipCalendarContext),
 * so last week's unsent issue cannot follow this week's.
 */
async function newsletterIssuePolls({ newsletterType, knex = require('../models/db') } = {}) {
  // Loaded here, not at the top: newsletter-sender.js loads this module first.
  const { outstandingEligibleDeliveries } = require('./newsletter-sender');
  const ids = pollIdsFor(newsletterType);
  const issues = () => knex('newsletter_sends as s').where('s.newsletter_type', newsletterType);
  const reachedRow = reachedRowFilter(knex);
  const resumableRow = () => outstandingEligibleDeliveries('s.id', { database: knex, correlate: true })
    .select(knex.raw('1'));
  // An unsent Waves Pest Insider issue holds its poll while its send row
  // exists: a held issue (its send is a draft again), a queued one, one a
  // worker has claimed, and a failed one, whatever its delivery rows say. A
  // person can send or resume any of them by hand, and the sender has no send
  // window on those paths for this newsletter, so such an issue can go out
  // after a later one. A poll held by an issue that never goes out is skipped
  // until that row is deleted: with six polls, a skipped one is cheaper than a
  // repeated one. A flagship issue goes out only on its own Thursday, so there
  // only a resumable row holds.
  const UNSENT = ['draft', 'scheduled', 'sending', 'failed'];
  const newest = await newestReachedIssues({ newsletterType, knex, limit: POLL_ISSUE_GAP, columns: ['s.html_body', 's.text_body'] });
  // A loose prefilter (any token form, either part, any letter case);
  // pollInIssue then reads the tokens exactly as the sender renders them.
  const holding = await issues()
    .where((issue) => {
      issue.whereExists(reachedRow).orWhereExists(resumableRow());
      if (newsletterType === PEST_INSIDER_TYPE) issue.orWhereIn('s.status', UNSENT);
    })
    .where((body) => body.where('s.html_body', 'ilike', `%{{quiz%${POLL_ID_MARK}%`)
      .orWhere('s.text_body', 'ilike', `%{{quiz%${POLL_ID_MARK}%`))
    .select('s.html_body', 's.text_body');
  // `ids` is the list the next issue picks from; the history also reads a
  // retired poll, so the issue that carried one is still a poll issue.
  const historyIds = pollHistoryIdsFor(newsletterType);
  return {
    ids,
    recent: newest.map((issue) => pollInIssue(issue, historyIds)),
    used: holding.map((issue) => pollInIssue(issue, historyIds)).filter(Boolean),
  };
}

/** A poll issue older than this many days (by ET calendar date) leaves its result out of the next issue. */
const POLL_RESULT_MAX_AGE_DAYS = 45;

/**
 * The vote counts of a Waves Pest Insider's last poll, for the issue sent on
 * `sendDate` ('YYYY-MM-DD', ET), or null. Only the NEWEST issue readers got
 * counts (newestReachedIssues, the rule and the issue time newsletterIssuePolls
 * reads): when it held a poll, and its time is at most POLL_RESULT_MAX_AGE_DAYS
 * before `sendDate`, the result is { quizId, counts } with one count per
 * answer key. A vote is one of that issue's own delivery rows with the poll's
 * id and an answer time; a reader who voted again changed the row's answer
 * (recordQuizResponse), so each row counts once. Throws on a read failure: the
 * planner's caller drops the line and warns (schedule.js lastPollLine).
 */
async function newsletterLastPoll({ newsletterType, sendDate, knex = require('../models/db') } = {}) {
  const [issue] = await newestReachedIssues({
    newsletterType,
    knex,
    limit: 1,
    columns: ['s.id', 's.html_body', 's.text_body', knex.raw(`${ISSUE_TIME_SQL} AS issue_time`)],
  });
  const quizId = issue ? pollInIssue(issue, pollIdsFor(newsletterType)) : null;
  if (!quizId) return null;
  // Whole ET calendar days from the issue's day to the new issue's day.
  if (etCalendarDaysUntil(sendDate, new Date(issue.issue_time)) > POLL_RESULT_MAX_AGE_DAYS) return null;
  const rows = await knex('newsletter_send_deliveries')
    .where({ send_id: issue.id, quiz_id: quizId })
    .whereNotNull('quiz_answered_at')
    .groupBy('quiz_answer')
    .select('quiz_answer')
    .count({ n: '*' });
  return { quizId, counts: Object.fromEntries(rows.map((row) => [row.quiz_answer, Number(row.n)])) };
}

// A label ends its sentence with a period unless it already ends in ? . or !
// ("What lizards?" stays "What lizards?").
const endSentence = (text) => (/[.?!]$/.test(text) ? text : `${text}.`);

/**
 * The words that tell readers how a Waves Pest Insider poll came out, or null
 * (owner 2026-11-22, "polls rec"): `Last poll: <question> The top answer was
 * <label>.`; for two answers tied at the top `It was a tie between X and Y.`
 * (the poll's own answer order, except a label that holds " and " goes last);
 * for three or four, `It was a tie. No answer came out on top.` No line for no
 * votes, an unknown poll, or a poll of another newsletter. Only the poll's own
 * answer keys count. It never prints a count or a percentage.
 * @param {{ quizId: string, counts: Record<string, number> }} result
 */
function pollResultLine({ quizId, counts } = {}) {
  const quiz = isPestInsiderPoll(quizId) ? getQuiz(quizId) : null;
  if (!quiz) return null;
  const votes = quiz.answers.map((a) => ({ label: a.label, n: Number(counts?.[a.key]) || 0 }));
  const top = Math.max(...votes.map((v) => v.n));
  if (!(top > 0)) return null;
  const labels = votes.filter((v) => v.n === top).map((v) => v.label);
  if (labels.length === 1) return `Last poll: ${quiz.question} The top answer was ${endSentence(labels[0])}`;
  if (labels.length > 2) return `Last poll: ${quiz.question} It was a tie. No answer came out on top.`;
  const [first, second] = [...labels].sort((a, b) => a.includes(' and ') - b.includes(' and '));
  return `Last poll: ${quiz.question} It was a tie between ${first} and ${endSentence(second)}`;
}

module.exports = {
  NEWSLETTER_POLL_IDS,
  PEST_INSIDER_POLL_IDS,
  RETIRED_PEST_INSIDER_POLL_IDS,
  POLL_ID_MARK,
  POLL_ISSUE_GAP,
  isNewsletterPoll,
  isPestInsiderPoll,
  pollInIssue,
  chooseNewsletterPoll,
  newsletterIssuePolls,
  newsletterLastPoll,
  pollResultLine,
  QUIZ_HTML_TOKEN,
  QUIZ_TEXT_TOKEN,
  QUIZ_TOKEN_PATTERN,
  DEFAULT_QUIZ_ID,
  QUIZ_BOOKING_SOURCE,
  QUIZZES,
  getQuiz,
  resolveAnswer,
  answerLabel,
  aggregateQuizResults,
  parseQuizTokens,
  hasQuizToken,
  quizAnswerUrl,
  quizBookingUrl,
  renderQuizHtml,
  renderQuizText,
  renderQuizNeutralHtml,
  renderQuizNeutralText,
  buildQuizSubstitutions,
  neutralizeQuizTokens,
  recordQuizResponse,
};
