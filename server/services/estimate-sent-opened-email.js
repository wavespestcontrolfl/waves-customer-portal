/**
 * The 2-hour estimate_sent email for a customer who already opened the estimate (GATE_ESTIMATE_TWO_HOUR_EMAIL,
 * owner 2026-11-21): it thanks them and offers answers and the Waves app, in place of "just making sure it landed".
 *
 * Pure and fixed: no database, no link, and no estimate field in the text (no price, no service name, no address). The
 * result has the same raw `html_body` / `text_body` shape the automation step holds, so renderAutomationStepContent wraps
 * it unchanged (it merges {{first_name}} and the chrome). automation-runner.js uses it only when the estimate was emailed
 * to the address this step goes to AND was opened (estimateWasOpened); everyone else keeps the step's own body.
 *
 * Kept from the live step body (20260926120200 audit): the greeting, the "A few things folks usually ask" heading, the
 * closing and the sign-off. Changed: the first paragraph, two question rows (start date, price holds) that are the same
 * for every estimate, and the Waves app block before the closing.
 */

const { ESTIMATE_SENT_FAQ } = require('./estimate-followup-copy');

const OPENED_PARAGRAPH = 'Thanks for taking a look at your Waves estimate. Any questions? Just reply to this email and a real person answers.';
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

// Two question rows, the same for every estimate: the email promises nothing that depends on which service was quoted.
const QUESTION_ROWS = [
  ['When can I start?', ESTIMATE_SENT_FAQ.start],
  ['Is the price locked in?', ESTIMATE_SENT_FAQ.price],
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

/**
 * @returns {{ html_body: string, text_body: string }}
 */
function buildEstimateOpenedEmail() {
  const html = [
    `<h2>${GREETING}</h2>`,
    `<p>${OPENED_PARAGRAPH}</p>`,
    `<h2>${FAQ_HEADING}</h2>`,
    `<ul>\n${QUESTION_ROWS.map(([label, answer]) => `  <li><strong>${escapeHtml(label)}</strong> ${escapeHtml(answer)}</li>`).join('\n')}\n</ul>`,
    appBlockHtml(),
    `<p>${CLOSING}</p>`,
    `<p>${SIGN_OFF}</p>`,
  ].join('\n\n');
  const text = [
    `${GREETING}. ${OPENED_PARAGRAPH}`,
    [`${FAQ_HEADING}:`, ...QUESTION_ROWS.map(([label, answer]) => `${label} ${answer}`)].join('\n'),
    `${APP_PARAGRAPH}\n${APP_TEXT_LINE}: ${APP_TOUR_VIDEO_URL}`,
    CLOSING,
    SIGN_OFF,
  ].join('\n\n');
  return { html_body: html, text_body: text };
}

module.exports = {
  buildEstimateOpenedEmail,
  estimateWasOpened,
  OPENED_PARAGRAPH,
  APP_PARAGRAPH,
  APP_IMAGE_ALT,
  APP_CAPTION,
  APP_TOUR_POSTER_URL,
  APP_TOUR_VIDEO_URL,
};
