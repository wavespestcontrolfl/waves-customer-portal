/**
 * The 2-hour estimate_sent email, built per estimate (GATE_ESTIMATE_EMAILS_NAME_SERVICE, owner 2026-11-21).
 *
 * Pure: no database, no link minting. automation-runner.js reads the estimate, mints the link and calls
 * buildEstimateSentEmail; the result has the same raw `html_body` / `text_body` shape the automation step holds,
 * so renderAutomationStepContent wraps it unchanged (it merges {{first_name}} and the chrome).
 *
 * Kept from the live step body (20260926120200 audit): the greeting, the "A few things folks usually ask" heading,
 * the closing and the sign-off. Changed: the first paragraph (it names the quoted service and no longer says the
 * email is "just making sure it landed"), a View my estimate button, and a question row only when its answer is not
 * blank, then the Waves app block (paragraph, linked tour poster, caption) before the closing. Every answer comes from followupEmailVars, so a one-time job gets no contract or between-visits row and a
 * termite estimate gets no guarantee line.
 */

const { followupEmailVars, neutralFollowupEmailVars, quotedServiceName } = require('./estimate-followup-copy');
const { closedServiceKeys } = require('./estimate-service-lines');
const { ctaButton } = require('./email-template');

const BUTTON_LABEL = 'View my estimate';
const NEUTRAL_SERVICE = 'Waves';
const GREETING = 'Hi {{first_name}} — thanks for considering Waves';
const FAQ_HEADING = 'A few things folks usually ask';
const CLOSING = "If you've got a question that's not on that list, just reply to this email. It goes straight to our local team — no call center, no ticket queue.";
const SIGN_OFF = '— The Waves Pest Control team';

// The Waves app block (owner 2026-11-21: these emails show the app). A linked poster that opens the app tour video.
const APP_PARAGRAPH = 'The Waves app keeps everything in one place — every visit and every report, pay in a tap, and if a time stops working you can reschedule a visit yourself, right from the app.';
const APP_IMAGE_ALT = 'Tap to watch: the Waves app — visits, reports, reschedule, and payments in one place';
const APP_CAPTION = 'Tap to watch the Waves app in action.';
const APP_TOUR_POSTER_URL = 'https://portal.wavespestcontrol.com/app-email/videos/waves-app-tour-poster.jpg';
const APP_TOUR_VIDEO_URL = 'https://portal.wavespestcontrol.com/app-email/videos/waves-app-tour.mp4';
const APP_TEXT_LINE = 'Watch the Waves app in action';

function appBlockHtml() {
  return [
    `<p>${escapeHtml(APP_PARAGRAPH)}</p>`,
    `<p style="margin:16px 0 4px;"><a href="${APP_TOUR_VIDEO_URL}"><img src="${APP_TOUR_POSTER_URL}" alt="${escapeHtml(APP_IMAGE_ALT)}" width="520" style="display:block;width:520px;max-width:100%;height:auto;border:0;border-radius:18px;"></a></p>`,
    `<p style="font-size:13px;margin:4px 0 16px;">${escapeHtml(APP_CAPTION)}</p>`,
  ].join('\n');
}

// Question rows in the order the email shows them: [label, followupEmailVars key].
const QUESTION_ROWS = [
  ['What is included?', 'category_included'],
  ['When can I start?', 'faq_start'],
  ['Am I locked in?', 'faq_terms'],
  ['What if I see activity between visits?', 'faq_between_visits'],
  ['Is the price locked in?', 'faq_price'],
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// A customer opened the estimate when either view stamp is set (the public route writes last_viewed_at
// before viewed_at) or the view counter is above zero.
function estimateWasOpened(estimate) {
  return !!(estimate?.viewed_at || estimate?.last_viewed_at || Number(estimate?.view_count) > 0);
}

function firstParagraph(estimate, service) {
  return estimateWasOpened(estimate)
    ? `Thanks for taking a look at your ${service} estimate. Any questions? Just reply to this email and a real person answers.`
    : `Your ${service} estimate is ready whenever you are.`;
}

function questionRows(vars) {
  return QUESTION_ROWS
    .map(([label, key]) => [label, String(vars[key] || '').trim()])
    .filter(([, answer]) => answer);
}

// An estimate that names no service through a closed source gets a neutral email: "your Waves estimate" and the
// property-generic pack's answers. Nothing here reads notes, description or service_interest (the free-text match).
function hasClosedService(estimate) {
  try { return closedServiceKeys(estimate || {}).length > 0; } catch { return false; }
}
function serviceAndVars(estimate) {
  if (!hasClosedService(estimate)) return { service: NEUTRAL_SERVICE, vars: neutralFollowupEmailVars() };
  return { service: quotedServiceName(estimate), vars: followupEmailVars(estimate) };
}

/**
 * @param {{ estimate: object, estimateUrl?: string|null }} args  `estimateUrl` is the minted email link, or
 *   null/empty when the guard refused or the mint failed: the email then goes without the button.
 * @returns {{ html_body: string, text_body: string, service: string }}
 */
function buildEstimateSentEmail({ estimate, estimateUrl = null }) {
  const { service, vars } = serviceAndVars(estimate);
  const paragraph = firstParagraph(estimate, service);
  const rows = questionRows(vars);
  const url = String(estimateUrl || '').trim();

  const htmlParts = [
    `<h2>${GREETING}</h2>`,
    `<p>${escapeHtml(paragraph)}</p>`,
  ];
  if (url) htmlParts.push(`<div style="margin:16px 0;">${ctaButton(escapeHtml(url), BUTTON_LABEL)}</div>`);
  if (rows.length) {
    htmlParts.push(
      `<h2>${FAQ_HEADING}</h2>`,
      `<ul>\n${rows.map(([label, answer]) => `  <li><strong>${escapeHtml(label)}</strong> ${escapeHtml(answer)}</li>`).join('\n')}\n</ul>`,
    );
  }
  htmlParts.push(appBlockHtml(), `<p>${CLOSING}</p>`, `<p>${SIGN_OFF}</p>`);

  const textParts = [`${GREETING}. ${paragraph}`];
  if (url) textParts.push(`${BUTTON_LABEL}: ${url}`);
  if (rows.length) textParts.push([`${FAQ_HEADING}:`, ...rows.map(([label, answer]) => `${label} ${answer}`)].join('\n'));
  textParts.push(`${APP_PARAGRAPH}\n${APP_TEXT_LINE}: ${APP_TOUR_VIDEO_URL}`, CLOSING, SIGN_OFF);

  return {
    html_body: htmlParts.join('\n\n'),
    text_body: textParts.join('\n\n'),
    service,
  };
}

module.exports = {
  buildEstimateSentEmail,
  estimateWasOpened,
  BUTTON_LABEL,
  APP_PARAGRAPH,
  APP_IMAGE_ALT,
  APP_CAPTION,
  APP_TOUR_POSTER_URL,
  APP_TOUR_VIDEO_URL,
};
