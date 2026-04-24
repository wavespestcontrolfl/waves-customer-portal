/**
 * Shared branded email template used by every transactional email we
 * send (invoice, receipt, estimate, future). Single source of truth for
 * the Waves logo header + navy/gold palette + gold CTA + footer so a
 * copy-change lands everywhere.
 *
 * Consumers:
 *   server/services/invoice-email.js   — invoice + receipt sends
 *   server/routes/admin-estimates.js   — estimate-ready send
 *
 * If you add a new transactional email, import wrapEmail + ctaButton
 * from here instead of hand-rolling another <div style>.
 */

// Brand colors — mirrors client/src/theme-brand.js
const NAVY = '#1B2C5B';
const WAVES_BLUE = '#009CDE';
const GOLD = '#FFD700';
const INK = '#0F172A';
const BODY = '#334155';
const MUTED = '#64748B';
const SAND = '#FDF6EC';
const CARD = '#FFFFFF';
const RULE = '#E2E8F0';

function currency(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d) {
  if (!d) return '';
  const dt = new Date(typeof d === 'string' ? (d.length === 10 ? d + 'T12:00:00' : d) : d);
  return dt.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
}

// Gold CTA with navy 3D-offset shadow — matches theme-brand.js GOLD_CTA identity.
function ctaButton(href, label) {
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
      <tr>
        <td style="border-radius:12px;background:${GOLD};border:2px solid ${NAVY};box-shadow:4px 4px 0 ${NAVY};">
          <a href="${href}" style="display:inline-block;padding:16px 28px;font-family:Inter,Arial,sans-serif;font-size:16px;font-weight:800;color:${NAVY};text-decoration:none;text-transform:uppercase;letter-spacing:0.03em;line-height:1;">
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
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:560px;background:${CARD};border-radius:16px;overflow:hidden;box-shadow:0 10px 24px rgba(27,44,91,.08);">
        <tr><td style="background:${NAVY};padding:24px 32px;text-align:center;">
          <img src="https://portal.wavespestcontrol.com/waves-logo.png" alt="Waves Pest Control &amp; Lawn Care" width="140" height="140" style="display:inline-block;width:140px;height:140px;max-width:140px;border:0;outline:none;text-decoration:none;" />
        </td></tr>
        <tr><td style="padding:36px 32px 8px 32px;">
          <h1 style="margin:0 0 16px 0;font-family:'Instrument Serif',Georgia,serif;font-style:italic;font-size:28px;line-height:1.15;color:${INK};font-weight:400;">${heading}</h1>
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
        <tr><td style="padding:0 32px 28px 32px;">
          <div style="font-family:Inter,Arial,sans-serif;font-size:13px;line-height:1.55;color:${MUTED};">
            ${footerNote || 'Questions? Reply to this email or call <a href="tel:+19412975749" style="color:' + WAVES_BLUE + ';text-decoration:none;">(941) 297-5749</a>.'}
          </div>
        </td></tr>
        <tr><td style="background:${SAND};padding:20px 32px;border-top:1px solid ${RULE};">
          <div style="font-family:Inter,Arial,sans-serif;font-size:11px;color:${MUTED};line-height:1.55;">
            Waves Pest Control, LLC · <a href="tel:+19412975749" style="color:${MUTED};text-decoration:none;">(941) 297-5749</a> · FL License #JF336375
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

module.exports = {
  wrapEmail,
  ctaButton,
  currency,
  formatDate,
  plainText,
  colors: { NAVY, WAVES_BLUE, GOLD, INK, BODY, MUTED, SAND, CARD, RULE },
};
