/**
 * Shared branded email template used by every transactional email we
 * send (invoice, receipt, estimate, future). Single source of truth for
 * the Waves logo header + palette + CTA + footer so a copy-change lands
 * everywhere.
 *
 * Consumers:
 *   server/services/invoice-email.js   — invoice + receipt sends
 *   server/routes/admin-estimates.js   — estimate-ready send
 *
 * If you add a new transactional email, import wrapEmail + ctaButton
 * from here instead of hand-rolling another <div style>.
 *
 * Theming: every wrapper renders the liquid-glass chrome — the email
 * translation of the liquid-glass tokens for clients without
 * backdrop-filter support: cool gradient wash, #04395E ink, system font
 * stack, gold gradient CTA with navy text — mirroring
 * client/src/glass/glass-theme.css ([data-glass-accent] CTA, --brand ink,
 * pro-scene wash). The old warm-sand chrome and its GATE_EMAIL_GLASS gate
 * were retired once glass shipped to 100%.
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

// Glass chrome — email translation of the liquid-glass tokens. Solid
// colors are the flattened-over-white equivalents of the glass rgba ink
// (--ts/--tt in glass-theme.css); gradients always ride on a solid
// fallback so Outlook/Windows Mail degrade to clean flat color.
const GLASS_THEME = {
  ink: '#04395E', // canonical glass navy (--brand)
  link: '#0A7EC2', // glass accent blue (--accent)
  body: '#555B69', // rgba(12,21,40,.7) over white
  muted: '#81858F', // rgba(12,21,40,.52) over white
  // The scene — the glass-engine orb language, tuned to how the live
  // estimate/report pages actually READ (their orbs render through
  // heavy blur + grain, so the result is far softer than the raw
  // engine stops): dreamy blue blob left, soft sky top-right, faint
  // deep-blue lower-right, creamy gold low-left, pale airy base.
  pageBg: '#EDF4FA',
  pageBgImage: 'radial-gradient(1200px 800px at -8% 12%,rgba(10,126,194,.22),transparent 60%),radial-gradient(1000px 700px at 108% 0%,rgba(56,170,225,.16),transparent 60%),radial-gradient(900px 700px at 96% 90%,rgba(6,90,140,.13),transparent 62%),radial-gradient(800px 600px at -6% 100%,rgba(240,165,0,.15),transparent 58%),linear-gradient(180deg,#EAF3FB 0%,#F6FAFE 48%,#EAF2F9 100%)',
  // Barely-there frosted card, like the estimate page's price/summary
  // cards: a whisper of white over the scene. card stays the solid
  // fallback — glass surfaces emit background:<card>;background:
  // <cardGlassBg> so Outlook and other rgba-less clients degrade to
  // clean flat white.
  card: '#FFFFFF',
  cardGlassBg: 'rgba(255,255,255,0.42)',
  cardBorder: '#EFF6FC', // glass edge highlight (solid — rgba borders go black in Outlook)
  headerBand: 'rgba(255,255,255,0.25)', // legacy-layout bands (unused by the glass layout)
  footerBand: 'rgba(233,243,251,0.5)',
  rule: '#D8E4EF',
  font: "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Inter,Arial,sans-serif",
  headingFont: "-apple-system,BlinkMacSystemFont,'SF Pro Display','Segoe UI',Inter,Arial,sans-serif",
  headingWeight: '700',
  headingTracking: '-0.02em',
  cardRadius: '20px',
  // Soft float + inset white top highlight — the estimate cards are
  // quiet; the deep [data-glass] shadow reads too heavy on email cards.
  cardShadow: '0 18px 60px rgba(4,57,94,0.12),inset 0 1px 0 rgba(255,255,255,0.6)',
  ctaBg: '#F5B520',
  ctaBgImage: 'linear-gradient(135deg,#FFDE78 0%,#F4B014 100%)',
  ctaBorder: '#FFEEB4',
  // Glass keeps CTA text on the legacy navy deliberately — matches
  // [data-glass-accent] in glass-theme.css, which pins #1B2C5B.
  ctaText: '#1B2C5B',
  // Match the live report action bar ([data-glass-accent]): 10px radius,
  // ~48px full-width bars — with bolder labels per owner call 07-06.
  ctaRadius: '10px',
  ctaWeight: '900',
  ctaPad: '11px 20px', // slimmer bars per owner (round 3) — ~42px tall
  ctaSize: '14px', // matches the report action bar's label size
  // Quiet float only — the gold outer glow read as glare (owner call
  // 07-06 round 3); subtle inset top highlight retained.
  ctaShadow: '0 8px 20px rgba(180,110,0,0.20),inset 0 1px 0 rgba(255,255,255,0.5)',
  // Under glass the block palette converges on the chrome palette — the
  // slate/gold clash between DB-template bodies and the wrapper is the
  // thing this theme layer removes. Callout keeps a gold identity but on
  // the glass accent gold (#F4B014, the CTA gradient's solid fallback).
  blocks: {
    font: "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Inter,Arial,sans-serif",
    heading: '#04395E',
    text: '#555B69',
    mutedText: '#81858F',
    rule: '#D8E4EF',
    calloutBorder: '#F4B014',
    calloutBg: '#FFF8E4',
    calloutText: '#04395E',
    footerLink: '#04395E', // value-navy like detail rows (owner call 07-06)
  },
  // Newsletter bodies converge on the same glass tokens: navy ink,
  // accent blue, accent gold, cool card tints and rules.
  newsletter: {
    font: "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',Inter,Arial,sans-serif",
    navy: '#04395E',
    blue: '#0A7EC2',
    gold: '#F4B014',
    muted: '#81858F',
    cardBg: '#F4F9FD',
    homeownerBg: '#E9F3FB',
    rule: '#D8E4EF',
  },
};

// Glass is the unconditional email theme now (GATE_EMAIL_GLASS retired). The
// shared palette helpers (blockPalette, ctaButton, ctaChip, stripeFooterLine,
// the getter palette) resolve through here, so it stays as the single glass
// palette source.
function activeTheme() {
  return GLASS_THEME;
}

/**
 * Block-content palette for email-template-library.js renderBlocks.
 * Resolved per call (like the wrappers) so DB-template bodies follow
 * the active chrome.
 */
function blockPalette() {
  return activeTheme().blocks;
}

/**
 * Newsletter body palette (newsletter-draft.js). Resolved per call so
 * generated newsletter bodies follow the active chrome.
 */
function newsletterPalette() {
  return activeTheme().newsletter;
}

// Style fragments shared by all three wrappers, kept as helpers so the
// classic theme renders byte-identically to the pre-theme markup.
function pageBgStyle(T) {
  return `background:${T.pageBg};${T.pageBgImage ? `background-image:${T.pageBgImage};` : ''}`;
}
function cardStyle(T, maxWidth) {
  // Two background declarations when the theme carries a frosted overlay:
  // rgba-capable clients composite the translucent card over the wash,
  // everything else keeps the solid fallback.
  return `max-width:${maxWidth};background:${T.card};${T.cardGlassBg ? `background:${T.cardGlassBg};` : ''}border-radius:${T.cardRadius};overflow:hidden;border:1px solid ${T.cardBorder};box-shadow:${T.cardShadow};`;
}

function currency(n) {
  const v = Number(n || 0);
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatDate(d) {
  return formatDisplayDate(d);
}

function ctaButton(href, label) {
  const T = activeTheme();
  // Glass buttons mirror the lawn service report's action bar (owner call
  // 2026-07-06): full-width gold bars with centered labels, stacked.
  // Classic keeps the original auto-width pill — byte-identical gate-off.
  const block = Boolean(T.cardGlassBg);
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;${block ? 'width:100%;' : ''}">
      <tr>
        <td ${block ? 'align="center" ' : ''}style="border-radius:${T.ctaRadius};background:${T.ctaBg};${T.ctaBgImage ? `background-image:${T.ctaBgImage};` : ''}border:1px solid ${T.ctaBorder};${T.ctaShadow ? `box-shadow:${T.ctaShadow};` : ''}">
          <a href="${href}" style="display:${block ? 'block' : 'inline-block'};padding:${T.ctaPad};font-family:${T.font};font-size:${T.ctaSize};font-weight:${T.ctaWeight};color:${T.ctaText};text-decoration:none;letter-spacing:0;line-height:1.1;${block ? 'text-align:center;' : ''}">
            ${label}
          </a>
        </td>
      </tr>
    </table>
  `;
}

// ---------- glass layout ----------
// The glass chrome is a different LAYOUT, not a reskin — mirroring the
// estimate/report glass pages: phone + logo float in a translucent pill,
// the hero (heading/intro) sits DIRECTLY on the orb scene, content lives
// in barely-there frosted cards, and the gold CTA floats between them.
// Classic rendering below is untouched, so the gate-off path stays
// byte-identical to the pre-theme markup.

const GLASS_LOGO_IMG = 'https://portal.wavespestcontrol.com/waves-logo-2026.png';

// Waves app promo row rendered in every email footer (owner ask
// 2026-07-05). Badges are the portal-hosted store art the app_intro
// template already uses; store URLs match account-membership-email.js.
const APP_STORE_URL = 'https://apps.apple.com/us/app/waves-pest-control/id6782775654';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.wavespestcontrol.portal';
const APPLE_BADGE_IMG = 'https://portal.wavespestcontrol.com/app-email/apple-app-store-badge.png';
const GOOGLE_BADGE_IMG = 'https://portal.wavespestcontrol.com/app-email/google-play-badge.png';

function appFooterHtml(T) {
  // Badge art differs: Apple's PNG fills its canvas, Google's (cropped of
  // its baked-in 41px margin) runs visually denser — 36px next to Apple's
  // 40px is the optical match. The 16px bottom margin keeps the badges
  // clear of the business fine-print lines that follow.
  return `<div style="margin:14px 0 10px 0;font-family:${T.font};font-size:13px;font-weight:700;color:${T.ink};text-align:center;">
            Track visits, reports &amp; payments in the Waves app
          </div>
          <div style="text-align:center;margin:0 0 16px 0;">
            <a href="${APP_STORE_URL}" style="display:inline-block;text-decoration:none;border:0;"><img src="${APPLE_BADGE_IMG}" alt="Download on the App Store" height="40" style="height:40px;width:auto;border:0;vertical-align:middle;" /></a>
            <a href="${PLAY_STORE_URL}" style="display:inline-block;text-decoration:none;border:0;margin-left:10px;"><img src="${GOOGLE_BADGE_IMG}" alt="Get it on Google Play" height="38" style="height:38px;width:auto;border:0;vertical-align:middle;" /></a>
          </div>`;
}

/**
 * Quiet chip for SECONDARY actions (owner ask 2026-07-05: templates with
 * two CTA blocks were rendering two stacked gold buttons). Mirrors the
 * glass page language — primary gets the gold [data-glass-accent], the
 * secondary gets a white chip. Theme-aware: classic renders a clean
 * white outline button in the legacy navy.
 */
function ctaChip(href, label) {
  const T = activeTheme();
  // Owner call 2026-07-06: under glass ALL buttons render like the lawn
  // report's action bar (identical gold bars); the quiet chip remains
  // the classic-theme secondary treatment.
  if (T.cardGlassBg) return ctaButton(href, label);
  return `
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
      <tr>
        <td style="border-radius:${T.ctaRadius};background:#FFFFFF;${T.cardGlassBg ? `background:rgba(255,255,255,0.6);` : ''}border:1px solid ${T.cardGlassBg ? T.cardBorder : T.ink};">
          <a href="${href}" style="display:inline-block;padding:12px 22px;font-family:${T.font};font-size:14px;font-weight:700;color:${T.ink};text-decoration:none;letter-spacing:0;line-height:1.1;">
            ${label}
          </a>
        </td>
      </tr>
    </table>
  `;
}

/**
 * Stripe trust line for invoice-family emails (owner ask 2026-07-05) —
 * mirrors Stripe's own invoice-email convention. Styled-text wordmark
 * (no hosted badge asset to maintain); the muted link follows the
 * active theme. Consumed by BOTH invoice send paths: the invoice.*
 * DB-template renderer (email-template-library.js — the path production
 * actually takes) and the legacy SMTP fallback (invoice-email.js).
 */
function stripeFooterLine() {
  return `<div style="margin-top:12px;font-size:12px;">Powered by <a href="https://stripe.com" style="color:#635BFF;font-weight:700;text-decoration:none;">stripe</a>&nbsp;&nbsp;|&nbsp;&nbsp;<a href="https://stripe.com/invoicing" style="color:${activeTheme().muted};text-decoration:underline;">Learn more about Stripe Invoicing</a></div>`;
}

function glassPillHeader(T) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 auto;">
        <tr>
          <td style="background:#FFFFFF;background:rgba(255,255,255,0.55);border:1px solid ${T.cardBorder};border-radius:999px;padding:9px 22px;box-shadow:0 10px 30px rgba(4,57,94,0.10),inset 0 1px 0 rgba(255,255,255,0.6);">
            <a href="tel:${WAVES_SUPPORT_PHONE_E164}" style="font-family:${T.font};font-size:14px;font-weight:700;color:${T.ink};text-decoration:none;vertical-align:middle;">${WAVES_SUPPORT_PHONE_DISPLAY}</a>
            <a href="${WAVES_WEBSITE_URL}" style="text-decoration:none;"><img src="${GLASS_LOGO_IMG}" alt="Waves Pest Control &amp; Lawn Care" width="34" height="34" style="display:inline-block;width:34px;height:34px;border:0;vertical-align:middle;margin-left:14px;" /></a>
          </td>
        </tr>
      </table>`;
}

function glassCard(T, innerHtml, padding = '22px 26px') {
  return `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:${T.card};background:${T.cardGlassBg};border:1px solid ${T.cardBorder};border-radius:${T.cardRadius};box-shadow:${T.cardShadow};">
            <tr><td style="padding:${padding};">${innerHtml}</td></tr>
          </table>`;
}

const SOCIALS = [
  ['facebook', 'https://facebook.com/wavespestcontrol', 'Facebook'],
  ['instagram', 'https://instagram.com/wavespestcontrol', 'Instagram'],
  ['youtube', 'https://youtube.com/@wavespestcontrol', 'YouTube'],
  ['tiktok', 'https://tiktok.com/@wavespestcontrol', 'TikTok'],
  ['x', 'https://x.com/wavespest', 'X'],
];

function socialRowHtml() {
  return `<div style="margin:14px 0 0 0;text-align:center;">${SOCIALS.map(([slug, url, name]) => `<a href="${url}" style="display:inline-block;margin:0 7px;text-decoration:none;border:0;"><img src="https://portal.wavespestcontrol.com/app-email/social/${slug}.png" alt="${name}" width="18" height="18" style="width:18px;height:18px;border:0;vertical-align:middle;opacity:0.8;" /></a>`).join('')}</div>`;
}

function glassFinePrint(T, extra = '') {
  // Balanced, centered stack: business+address / site·email·phone /
  // license — then socials and the logo (owner footer spec 07-06).
  return `${extra}<div style="font-family:${T.font};font-size:11px;letter-spacing:0.02em;color:${T.muted};line-height:1.8;text-align:center;">
            ${WAVES_BUSINESS_NAME} · ${WAVES_ADDRESS_LINE}<br/><a href="${WAVES_WEBSITE_URL}" style="color:${T.muted};text-decoration:none;">${WAVES_WEBSITE_HOST}</a> · <a href="mailto:contact@wavespestcontrol.com" style="color:${T.muted};text-decoration:none;">contact@wavespestcontrol.com</a> · <a href="tel:${WAVES_SUPPORT_PHONE_E164}" style="color:${T.muted};text-decoration:none;">${WAVES_SUPPORT_PHONE_DISPLAY}</a><br/>${WAVES_FL_LICENSE_LINE}
          </div>
          ${socialRowHtml()}
          <div style="margin:12px 0 0 0;text-align:center;"><img src="${GLASS_LOGO_IMG}" alt="${WAVES_BUSINESS_NAME}" width="44" height="44" style="width:44px;height:44px;border:0;" /></div>`;
}

// Trailing filler after the preheader text: without it, clients that build
// the inbox preview from the first visible characters (Gmail, Apple Mail)
// run past a short preheader into the pill header's phone number.
const PREHEADER_PAD = '&nbsp;&zwnj;'.repeat(80);

function glassPage(T, { preheader, title, contentHtml, msoWidth = 640 }) {
  // The <style> block is a safety net for operator/DB-authored body HTML
  // that carries bare headings: without it they'd inherit the body grey.
  // Inline styles always beat these rules, so themed markup is unaffected;
  // clients that strip <style> just show grey headings (readable, not wrong).
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="color-scheme" content="light" />
<meta name="supported-color-schemes" content="light" />
<title>${title || 'Waves Pest Control'}</title>
<style>
  h1, h2, h3, h4 { color: ${T.ink}; font-family: ${T.headingFont}; }
</style>
</head>
<body style="margin:0;padding:0;background:${T.pageBg};font-family:${T.font};color:${T.body};">
  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;color:${T.pageBg};">${preheader}${PREHEADER_PAD}</div>` : ''}
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="${pageBgStyle(T)}">
    <tr><td align="center" style="padding:26px 18px 44px 18px;">
      <!--[if mso]><table role="presentation" width="${msoWidth}" align="center" cellspacing="0" cellpadding="0" border="0"><tr><td><![endif]-->
      ${contentHtml}
      <!--[if mso]></td></tr></table><![endif]-->
    </td></tr>
  </table>
</body>
</html>`;
}

function glassEmail({ preheader, heading, intro, lines, ctaHref, ctaLabel, footerNote }) {
  const T = GLASS_THEME;
  const linesHtml = (lines || []).map(([label, value, emphasis]) => `
    <tr>
      <td style="padding:7px 0;font-family:${T.font};font-size:14px;color:${T.muted};">${label}</td>
      <td align="right" style="padding:7px 0;font-family:${T.font};font-size:14px;color:${T.ink};font-weight:${emphasis ? '700' : '500'};">${value}</td>
    </tr>
  `).join('');

  const contentHtml = `${glassPillHeader(T)}
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:560px;">
        <tr><td align="left" style="padding:30px 4px 0 4px;">
          <h1 style="margin:0 0 14px 0;font-family:${T.headingFont};font-size:34px;line-height:1.08;letter-spacing:-0.03em;color:${T.ink};font-weight:700;">${heading}</h1>
          <div style="font-family:${T.font};font-size:15px;line-height:1.6;color:${T.body};">
            ${intro}
          </div>
        </td></tr>
        ${linesHtml ? `
        <tr><td style="padding:26px 0 0 0;">
          ${glassCard(T, `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${linesHtml}</table>`, '14px 24px')}
        </td></tr>` : ''}
        ${ctaHref && ctaLabel ? `
        <tr><td align="center" style="padding:30px 0 0 0;">
          ${ctaButton(ctaHref, ctaLabel)}
        </td></tr>` : ''}
        ${footerNote ? `
        <tr><td align="center" style="padding:28px 4px 0 4px;">
          <div style="font-family:${T.font};font-size:13px;line-height:1.6;color:${T.muted};text-align:center;">
            ${footerNote}
          </div>
        </td></tr>` : ''}
        <tr><td align="center" style="padding:20px 4px 0 4px;">
          ${glassFinePrint(T, appFooterHtml(T))}
        </td></tr>
      </table>`;

  // msoWidth mirrors each variant's max-width: Outlook's Word engine ignores
  // max-width entirely, so without the glassPage ghost table the email
  // stretches to the full window width.
  return glassPage(T, { preheader, contentHtml, msoWidth: 560 });
}

function glassServiceEmail({ preheader, body, footerNote } = {}) {
  const T = GLASS_THEME;
  const contentHtml = `${glassPillHeader(T)}
      <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:620px;">
        <tr><td style="padding:28px 0 0 0;">
          ${glassCard(T, `<div style="font-family:${T.font};font-size:15px;line-height:1.58;color:${T.body};">${body || ''}</div>`, '26px 28px')}
        </td></tr>
        ${footerNote ? `
        <tr><td align="center" style="padding:24px 4px 0 4px;">
          <div style="font-family:${T.font};font-size:13px;line-height:1.6;color:${T.muted};text-align:center;">
            ${footerNote}
          </div>
        </td></tr>` : ''}
        <tr><td align="center" style="padding:18px 4px 0 4px;">
          ${glassFinePrint(T, appFooterHtml(T))}
        </td></tr>
      </table>`;
  return glassPage(T, { preheader, contentHtml, msoWidth: 620 });
}

function glassNewsletter({ body, unsubscribeUrl, preheader, footerNote, newsletterType, preferredSourcesCta } = {}) {
  const T = GLASS_THEME;
  const isLocalGuide = newsletterType === 'local-weekly-fresh-events';
  const unsubLine = unsubscribeUrl
    ? `<a href="${unsubscribeUrl}" style="color:${T.muted};text-decoration:underline;">Unsubscribe</a> · `
    : '';
  const preferredSourcesLine = preferredSourcesCta
    ? `<div style="margin-bottom:10px;font-family:${T.font};font-size:12px;line-height:1.6;color:${T.body};text-align:center;">
            Like what we send? <a href="https://www.google.com/preferences/source?q=${WAVES_WEBSITE_HOST}" style="color:${T.link};text-decoration:underline;font-weight:600;">Make Waves a preferred source on Google</a> — one tap, and you'll see more of us in your searches.
          </div>`
    : '';

  // Newsletter identity sits directly on the scene like the page heroes.
  const heroBlock = isLocalGuide
    ? `<a href="${WAVES_WEBSITE_URL}" style="text-decoration:none;display:inline-block;"><img src="${GLASS_LOGO_IMG}" alt="Waves Pest Control &amp; Lawn Care" width="72" height="72" style="display:inline-block;width:72px;height:72px;border:0;" /></a>
          <div style="margin-top:12px;font-family:${T.headingFont};font-size:26px;letter-spacing:-0.03em;color:${T.ink};font-weight:700;">Fresh This Week</div>
          <div style="margin-top:4px;font-family:${T.font};font-size:11px;letter-spacing:0.11em;text-transform:uppercase;color:${T.muted};font-weight:700;">A local weekend guide from the Waves crew</div>`
    : `<a href="${WAVES_WEBSITE_URL}" style="text-decoration:none;display:inline-block;"><img src="${GLASS_LOGO_IMG}" alt="Waves Pest Control &amp; Lawn Care" width="72" height="72" style="display:inline-block;width:72px;height:72px;border:0;" /></a>
          <div style="margin-top:10px;font-family:${T.font};font-size:11px;letter-spacing:0.11em;text-transform:uppercase;color:${T.ink};font-weight:700;">The Waves Newsletter</div>`;

  const contentHtml = `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:640px;">
        <tr><td align="center" style="padding:6px 4px 0 4px;">
          ${heroBlock}
        </td></tr>
        <tr><td style="padding:24px 0 0 0;">
          ${glassCard(T, `<div style="font-family:${T.font};font-size:15px;line-height:1.6;color:${T.body};">${body || ''}</div>`, '26px 28px')}
        </td></tr>
        <tr><td align="center" style="padding:24px 4px 0 4px;">
          ${preferredSourcesLine}<div style="font-family:${T.font};font-size:12px;line-height:1.6;color:${T.muted};text-align:center;">
            ${unsubLine}<a href="${WAVES_WEBSITE_URL}" style="color:${T.muted};text-decoration:underline;">${WAVES_WEBSITE_HOST}</a> · <a href="tel:${WAVES_SUPPORT_PHONE_E164}" style="color:${T.muted};text-decoration:none;">${WAVES_SUPPORT_PHONE_DISPLAY}</a>
          </div>
          ${footerNote ? `<div style="margin-top:8px;font-family:${T.font};font-size:11px;color:${T.muted};text-align:center;">${footerNote}</div>` : ''}
        </td></tr>
        <tr><td align="center" style="padding:16px 4px 0 4px;">
          ${glassFinePrint(T, appFooterHtml(T))}
        </td></tr>
      </table>`;

  return glassPage(T, {
    preheader,
    title: isLocalGuide ? 'Fresh This Week — Waves' : 'Waves Pest Control',
    contentHtml,
    msoWidth: 640,
  });
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
  return glassEmail({ preheader, heading, intro, lines, ctaHref, ctaLabel, footerNote });
}

function plainText(lines) {
  return lines.filter(Boolean).join('\n');
}

/**
 * Service/account email wrapper. This is the professional customer-facing
 * shell for invoices, estimates, onboarding, reports, prep guides, payment
 * notices, and account-state messages. It shares the Waves logo, palette,
 * footer, and CTA style, but deliberately avoids newsletter labeling
 * or promotional chrome.
 *
 * @param {{
 *   preheader?: string,
 *   body: string,
 *   footerNote?: string,
 * }} opts
 */
function wrapServiceEmail({ preheader, body, footerNote } = {}) {
  return glassServiceEmail({ preheader, body, footerNote });
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
  return glassNewsletter({ body, unsubscribeUrl, preheader, footerNote, newsletterType, preferredSourcesCta });
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
  blockPalette,
  ctaChip,
  stripeFooterLine,
  newsletterPalette,
  currency,
  formatDate,
  plainText,
  // Body-content palette for consumers that build their own inner HTML
  // (services/email.js, price-scan/mark-email.js). Getters resolve the
  // gate lazily so consumer body content follows the active chrome.
  colors: {
    get NAVY() { return activeTheme().ink; },
    get WAVES_BLUE() { return activeTheme().link; },
    get INK() { return activeTheme().ink; },
    get BODY() { return activeTheme().body; },
    get MUTED() { return activeTheme().muted; },
    get SAND() { return activeTheme().pageBg; },
    get CARD() { return activeTheme().card; },
    get RULE() { return activeTheme().rule; },
    // Typography tokens for consumers that build heading/body HTML
    // inline (email.js h1, invoice-email.js notes) — classic values
    // match the strings those call sites used to hardcode.
    get FONT() { return activeTheme().font; },
    get HEADING_FONT() { return activeTheme().headingFont; },
    get HEADING_WEIGHT() { return activeTheme().headingWeight; },
    get HEADING_TRACKING() { return activeTheme().headingTracking; },
  },
};
