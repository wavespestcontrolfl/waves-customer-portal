/**
 * Shared branded email template used by every transactional email we
 * send (invoice, receipt, estimate, future). Single source of truth for
 * the Waves logo header + estimate-style palette + blue CTA + footer so a
 * copy-change lands everywhere.
 *
 * Consumers:
 *   server/services/invoice-email.js   — invoice + receipt sends
 *   server/routes/admin-estimates.js   — estimate-ready send
 *
 * If you add a new transactional email, import wrapEmail + ctaButton
 * from here instead of hand-rolling another <div style>.
 */

const {
  WAVES_BUSINESS_NAME,
  WAVES_WEBSITE_HOST,
  WAVES_WEBSITE_URL,
  WAVES_ADDRESS_LINE,
  WAVES_SUPPORT_PHONE_DISPLAY,
  WAVES_SUPPORT_PHONE_E164,
  WAVES_FL_LICENSE_LINE,
} = require('../constants/business');
const { formatDisplayDate } = require('../utils/date-only');

// Customer-facing email colors mirror the public estimate/project pages.
const NAVY = '#1B2C5B';
const WAVES_BLUE = '#009CDE';
const INK = NAVY;
const BODY = '#3F4A65';
const MUTED = '#6B7280';
const SAND = '#FAF8F3';
const CARD = '#FFFFFF';
const RULE = '#E7E2D7';

function currency(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d) {
  return formatDisplayDate(d);
}

function ctaButton(href, label) {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
      <tr>
        <td style="border-radius:10px;background:${NAVY};border:1px solid ${NAVY};">
          <a href="${href}" style="display:inline-block;padding:14px 24px;font-family:Inter,Arial,sans-serif;font-size:15px;font-weight:800;color:#FFFFFF;text-decoration:none;letter-spacing:0;line-height:1.1;">
            ${label}
          </a>
        </td>
      </tr>
    </table>
  `;
}

/**
 * @param {{
 *   preheader?: string,
 *   heading: string,
 *   intro: string,
 *   lines?: Array<[string, string, boolean?]>, // [label, value, emphasis]
 *   ctaHref?: string,
 *   ctaLabel?: string,
 *   footerNote?: string,
 * }} opts
 */
function wrapEmail({ preheader, heading, intro, lines, ctaHref, ctaLabel, footerNote }) {
  const linesHtml = (lines || []).map(([label, value, emphasis]) => `
    <tr>
      <td style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:${MUTED};">${label}</td>
      <td align="right" style="padding:6px 0;font-family:Inter,Arial,sans-serif;font-size:14px;color:${INK};font-weight:${emphasis ? '700' : '500'};">${value}</td>
    </tr>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Waves Pest Control</title>
</head>
<body style="margin:0;padding:0;background:${SAND};font-family:Inter,Arial,sans-serif;color:${BODY};">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;color:${SAND};">${preheader}</div>` : ''}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${SAND};">
    <tr><td align="center" style="padding:32px 16px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:560px;background:${CARD};border-radius:16px;overflow:hidden;border:1px solid ${RULE};box-shadow:none;">
        <tr><td style="background:${CARD};padding:18px 24px;border-bottom:1px solid ${RULE};">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
            <tr>
              <td align="left">
                <img src="https://portal.wavespestcontrol.com/waves-logo-2026.png" alt="Waves Pest Control &amp; Lawn Care" width="64" height="64" style="display:inline-block;width:64px;height:64px;max-width:64px;border:0;outline:none;text-decoration:none;" />
              </td>
              <td align="right" style="font-family:Inter,Arial,sans-serif;font-size:13px;font-weight:800;color:${NAVY};">
                <a href="tel:${WAVES_SUPPORT_PHONE_E164}" style="color:${NAVY};text-decoration:none;">${WAVES_SUPPORT_PHONE_DISPLAY}</a>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:36px 32px 8px 32px;">
          <h1 style="margin:0 0 16px 0;font-family:'Source Serif 4',Georgia,serif;font-style:normal;font-size:28px;line-height:1.15;color:${NAVY};font-weight:500;">${heading}</h1>
          <div style="font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.55;color:${BODY};">
            ${intro}
          </div>
        </td></tr>
        ${linesHtml ? `
        <tr><td style="padding:20px 32px 4px 32px;">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-top:1px solid ${RULE};padding-top:8px;">
            ${linesHtml}
          </table>
        </td></tr>` : ''}
        ${ctaHref && ctaLabel ? `
        <tr><td align="center" style="padding:28px 32px;">
          ${ctaButton(ctaHref, ctaLabel)}
        </td></tr>` : ''}
        <tr><td align="center" style="padding:0 32px 28px 32px;">
          <div style="font-family:Inter,Arial,sans-serif;font-size:13px;line-height:1.55;color:${MUTED};text-align:center;">
            ${footerNote || `Questions? Reply to this email or call <a href="tel:${WAVES_SUPPORT_PHONE_E164}" style="color:${WAVES_BLUE};text-decoration:none;">${WAVES_SUPPORT_PHONE_DISPLAY}</a>.`}
          </div>
        </td></tr>
        <tr><td align="center" style="background:${SAND};padding:20px 32px;border-top:1px solid ${RULE};">
          <div style="font-family:Inter,Arial,sans-serif;font-size:11px;color:${MUTED};line-height:1.55;text-align:center;">
            ${WAVES_BUSINESS_NAME} · ${WAVES_ADDRESS_LINE} · <a href="${WAVES_WEBSITE_URL}" style="color:${MUTED};text-decoration:none;">${WAVES_WEBSITE_HOST}</a> · <a href="tel:${WAVES_SUPPORT_PHONE_E164}" style="color:${MUTED};text-decoration:none;">${WAVES_SUPPORT_PHONE_DISPLAY}</a> · ${WAVES_FL_LICENSE_LINE}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function plainText(lines) {
  return lines.filter(Boolean).join('\n');
}

/**
 * Service/account email wrapper. This is the professional customer-facing
 * shell for invoices, estimates, onboarding, reports, prep guides, payment
 * notices, and account-state messages. It shares the Waves logo, public
 * estimate-page palette, footer, and CTA style, but deliberately avoids newsletter labeling
 * or promotional chrome.
 *
 * @param {{
 *   preheader?: string,
 *   body: string,
 *   footerNote?: string,
 * }} opts
 */
function wrapServiceEmail({ preheader, body, footerNote } = {}) {
  const safeBody = body || '';
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Waves Pest Control</title>
</head>
<body style="margin:0;padding:0;background:${SAND};font-family:Inter,Arial,sans-serif;color:${BODY};">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;color:${SAND};">${preheader}</div>` : ''}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${SAND};">
    <tr><td align="center" style="padding:28px 12px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:620px;background:${CARD};border-radius:16px;overflow:hidden;border:1px solid ${RULE};box-shadow:none;">
        <tr><td style="background:${CARD};padding:16px 24px;text-align:left;border-bottom:1px solid ${RULE};">
          <a href="https://wavespestcontrol.com" style="text-decoration:none;display:inline-flex;align-items:center;">
            <img src="https://portal.wavespestcontrol.com/waves-logo-2026.png" alt="Waves Pest Control &amp; Lawn Care" width="64" height="64" style="display:inline-block;width:64px;height:64px;max-width:64px;border:0;outline:none;vertical-align:middle;" />
          </a>
        </td></tr>
        <tr><td style="padding:30px 30px 8px 30px;font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.58;color:${BODY};">
          ${safeBody}
        </td></tr>
        <tr><td align="center" style="padding:10px 30px 28px 30px;">
          <div style="font-family:Inter,Arial,sans-serif;font-size:13px;line-height:1.55;color:${MUTED};text-align:center;">
            ${footerNote || `Questions? Reply to this email or call <a href="tel:${WAVES_SUPPORT_PHONE_E164}" style="color:${WAVES_BLUE};text-decoration:none;">${WAVES_SUPPORT_PHONE_DISPLAY}</a>.`}
          </div>
        </td></tr>
        <tr><td align="center" style="background:${SAND};padding:18px 24px;border-top:1px solid ${RULE};">
          <div style="font-family:Inter,Arial,sans-serif;font-size:11px;color:${MUTED};line-height:1.55;text-align:center;">
            ${WAVES_BUSINESS_NAME} · ${WAVES_ADDRESS_LINE} · <a href="${WAVES_WEBSITE_URL}" style="color:${MUTED};text-decoration:none;">${WAVES_WEBSITE_HOST}</a> · <a href="tel:${WAVES_SUPPORT_PHONE_E164}" style="color:${MUTED};text-decoration:none;">${WAVES_SUPPORT_PHONE_DISPLAY}</a> · ${WAVES_FL_LICENSE_LINE}
          </div>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Newsletter / automation chrome wrapper. Unlike wrapEmail() (which is
 * tightly templated for transactional content — heading + intro +
 * lines + CTA), this wrapper takes operator-written HTML body and
 * surrounds it with brand chrome only. Used by both
 * newsletter-sender.js (campaign sends) and automation-runner.js
 * (drip sequence sends) so every customer-facing email shares the
 * same Waves identity.
 *
 * @param {{
 *   body: string,                  // operator HTML — inserted as-is
 *   unsubscribeUrl?: string,       // pre-resolved URL OR a SendGrid
 *                                  // substitution token. When omitted
 *                                  // the footer skips the unsub line
 *                                  // (e.g. automations where SendGrid
 *                                  // ASM groups handle unsub natively
 *                                  // via the List-Unsubscribe header).
 *   preheader?: string,            // hidden inbox preview text
 *   footerNote?: string,           // optional small print under unsub
 *   newsletterType?: string,       // when 'local-weekly-fresh-events',
 *                                  // renders the local guide header
 *                                  // instead of "The Waves Newsletter"
 *   preferredSourcesCta?: boolean, // newsletter broadcasts only — renders
 *                                  // the Google Preferred Sources opt-in
 *                                  // line above the unsub footer. Off by
 *                                  // default so automation drips and
 *                                  // library templates stay unchanged.
 * }} opts
 */
function wrapNewsletter({ body, unsubscribeUrl, preheader, footerNote, newsletterType, preferredSourcesCta } = {}) {
  const safeBody = body || '';
  const unsubLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:${MUTED};text-decoration:underline;">Unsubscribe</a> · `
    : '';

  // Google Preferred Sources is per-user search personalization: a signed-in
  // reader who follows this link and checks the box sees Waves badged and
  // surfaced more often in their own Top Stories / AI Overviews / AI Mode
  // results. Domain-level only, so the hub domain is the one to promote.
  const preferredSourcesLine = preferredSourcesCta
    ? `<div style="margin-bottom:10px;font-family:Inter,Arial,sans-serif;font-size:12px;line-height:1.6;color:${BODY};text-align:center;">
            Like what we send? <a href="https://www.google.com/preferences/source?q=${WAVES_WEBSITE_HOST}" style="color:${WAVES_BLUE};text-decoration:underline;font-weight:600;">Make Waves a preferred source on Google</a> — one tap, and you'll see more of us in your searches.
          </div>`
    : '';

  const isLocalGuide = newsletterType === 'local-weekly-fresh-events';

  const headerBlock = isLocalGuide
    ? `<a href="https://wavespestcontrol.com" style="text-decoration:none;display:inline-block;">
            <img src="https://portal.wavespestcontrol.com/waves-logo-2026.png" alt="Waves Pest Control &amp; Lawn Care" width="88" height="88" style="display:inline-block;width:88px;height:88px;max-width:88px;border:0;outline:none;" />
          </a>
          <div style="margin-top:10px;font-family:Inter,Arial,sans-serif;font-size:16px;letter-spacing:-0.01em;color:${NAVY};font-weight:800;">
            Fresh This Week
          </div>
          <div style="margin-top:2px;font-family:Inter,Arial,sans-serif;font-size:11px;letter-spacing:0.02em;text-transform:uppercase;color:${MUTED};font-weight:600;">
            A local weekend guide from the Waves crew
          </div>`
    : `<a href="https://wavespestcontrol.com" style="text-decoration:none;display:inline-block;">
            <img src="https://portal.wavespestcontrol.com/waves-logo-2026.png" alt="Waves Pest Control &amp; Lawn Care" width="88" height="88" style="display:inline-block;width:88px;height:88px;max-width:88px;border:0;outline:none;" />
          </a>
          <div style="margin-top:8px;font-family:Inter,Arial,sans-serif;font-size:12px;letter-spacing:0;text-transform:none;color:${NAVY};font-weight:800;">
            The Waves Newsletter
          </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${isLocalGuide ? 'Fresh This Week — Waves' : 'Waves Pest Control'}</title>
</head>
<body style="margin:0;padding:0;background:${SAND};font-family:Inter,Arial,sans-serif;color:${BODY};">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;color:${SAND};">${preheader}</div>` : ''}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${SAND};">
    <tr><td align="center" style="padding:24px 12px;">
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:640px;background:${CARD};border-radius:16px;overflow:hidden;border:1px solid ${RULE};box-shadow:none;">
        <tr><td style="background:${CARD};padding:18px 24px;text-align:center;border-bottom:1px solid ${RULE};">
          ${headerBlock}
        </td></tr>
        <tr><td style="padding:28px 28px 8px 28px;font-family:Inter,Arial,sans-serif;font-size:15px;line-height:1.6;color:${BODY};">
          ${safeBody}
        </td></tr>
        <tr><td align="center" style="background:${SAND};padding:18px 24px 22px 24px;border-top:1px solid ${RULE};">
          ${preferredSourcesLine}<div style="font-family:Inter,Arial,sans-serif;font-size:12px;line-height:1.6;color:${MUTED};text-align:center;">
            ${unsubLine}<a href="${WAVES_WEBSITE_URL}" style="color:${MUTED};text-decoration:underline;">${WAVES_WEBSITE_HOST}</a> · <a href="tel:${WAVES_SUPPORT_PHONE_E164}" style="color:${MUTED};text-decoration:none;">${WAVES_SUPPORT_PHONE_DISPLAY}</a>
          </div>
          <div style="margin-top:6px;font-family:Inter,Arial,sans-serif;font-size:11px;color:${MUTED};text-align:center;">
            ${WAVES_BUSINESS_NAME} · ${WAVES_ADDRESS_LINE} · ${WAVES_FL_LICENSE_LINE}
          </div>
          ${footerNote ? `<div style="margin-top:8px;font-family:Inter,Arial,sans-serif;font-size:11px;color:${MUTED};text-align:center;">${footerNote}</div>` : ''}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

/**
 * Default unsubscribe placeholder for `ensureLegalTextFooter` — SendGrid's
 * ASM substitution token. Resolves at send time whenever an asm group is
 * attached, which is the case for automation sends via `sendgrid.sendOne`.
 *
 * Newsletter broadcasts use a different token (`{{unsubscribe_url}}`) that
 * `sendgrid.sendBatch` substitutes per-recipient into the Waves portal
 * unsubscribe URL. Call sites that go through sendBatch should override
 * via the `unsubscribeUrl` option so customers land on the portal flow,
 * not SendGrid's hosted ASM page.
 */
const DEFAULT_TEXT_UNSUB_PLACEHOLDER = '<%asm_group_unsubscribe_raw_url%>';

/**
 * Append a CAN-SPAM § 7704(a)(5) compliant footer to a plain-text body
 * (physical postal address + visible unsubscribe link). Use this at
 * every commercial/promotional text send-site — compliance becomes a
 * system property instead of relying on each template author to
 * remember the legal boilerplate.
 *
 * Idempotent via the address-string guard. Returns the input unchanged
 * when `text` is empty/null/undefined — we don't want a "footer-only"
 * body with no message above it.
 *
 * @param {string} text  Plain-text body, already personalized.
 * @param {{unsubscribeUrl?: string}} [opts]
 *   `unsubscribeUrl` — substitution token or pre-resolved URL the
 *   recipient should see for unsubscribe. Defaults to the SendGrid ASM
 *   token (correct for automation/sendOne); override with
 *   `'{{unsubscribe_url}}'` for newsletter/sendBatch sends.
 */
function ensureLegalTextFooter(text, opts = {}) {
  if (!text) return text;
  // Idempotency: only skip when BOTH legal lines are already present.
  // Checking for the address alone would false-positive on any body
  // that mentions the office address in passing (e.g., "stop by our
  // shop at 13649 Luxe Ave…"), causing the unsubscribe line to be
  // silently dropped from the plain-text part. The "Unsubscribe:"
  // marker — with the colon — is specific enough that an operator
  // who includes it is intentionally setting their own footer.
  if (text.includes('13649 Luxe Ave') && text.includes('Unsubscribe:')) return text;
  // Resolve the unsubscribe URL. `opts.unsubscribeUrl === null` is a
  // deliberate "no URL available" signal from the caller (e.g.,
  // automation-runner when no asm group is configured) — in that case
  // skip the footer entirely rather than ship a broken/literal token.
  // Mirrors wrapNewsletter's behavior on the HTML side, which omits the
  // unsubscribe line when no URL is available. Compliance still requires
  // the caller to refuse commercial sends in that state.
  const unsubscribeUrl = opts.unsubscribeUrl !== undefined
    ? opts.unsubscribeUrl
    : DEFAULT_TEXT_UNSUB_PLACEHOLDER;
  if (!unsubscribeUrl) return text;
  return `${text}\n\n--\nWaves Pest Control, LLC · 13649 Luxe Ave #110, Bradenton, FL 34211\nUnsubscribe: ${unsubscribeUrl}`;
}

module.exports = {
  wrapEmail,
  wrapServiceEmail,
  wrapNewsletter,
  ensureLegalTextFooter,
  ctaButton,
  currency,
  formatDate,
  plainText,
  colors: { NAVY, WAVES_BLUE, INK, BODY, MUTED, SAND, CARD, RULE },
};
