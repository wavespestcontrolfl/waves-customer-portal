#!/usr/bin/env node
'use strict';
// Glass audit — static renders of the SERVER-RENDERED customer surfaces.
//
// Requires only pure renderers (no app boot, no DB, no provider clients) and
// writes HTML into client/glass-audit-html/ so the Vite dev server serves each
// file at /glass-audit-html/<name>.html for scenarios/50-server-html.cjs.
//
//   export PATH=/opt/homebrew/opt/node@20/bin:$PATH
//   node scripts/qa/glass-audit/render-server-html.cjs
//
// How each renderer is obtained:
//   - email-template.js exports wrapEmail / wrapServiceEmail / wrapNewsletter /
//     ctaButton / stripeFooterLine / currency directly; the module only pulls
//     constants/business + utils/date-only, so a plain require() is enough.
//   - public-newsletter.js does NOT export renderConfirmPage and requires
//     models/db at load time, so we never require it. Instead the function's
//     source is sliced out of the file text (from `function renderConfirmPage`
//     to its closing brace) and evaluated with its single free dependency,
//     glassUniversalFooterHtml, injected. If the slice ever fails to compile the
//     script exits non-zero rather than emitting a stale page.
//   - routes/estimate-public.js renderPage is NOT rendered: the module boots
//     db/config/Twilio at require time, renderPage spans ~3.4k lines
//     (4669-8041) of module-scope helpers, and it signs a JWT
//     (signEstimateAskToken) with config secrets. Faking that in a few dozen
//     lines is not realistic; see the audit report for the reachability answer.
//
// Fixture rule: fictional content only (Jordan Rivera / 1200 Sample Lane style).
// Post-processing: absolute https://portal.wavespestcontrol.com/ asset URLs are
// rewritten to same-origin paths so the harness (which blocks every external
// origin) can load the logo/badges from client/public. Nothing else is touched.

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../../..');
const outDir = path.join(root, 'client/glass-audit-html');
const email = require(path.join(root, 'server/services/email-template'));

const UNSUB = 'https://example.invalid/unsub';
const PORTAL = 'https://example.invalid/portal';

function localizeAssets(html) {
  return html.replace(/https:\/\/portal\.wavespestcontrol\.com\//g, '/');
}

function write(name, html) {
  const file = path.join(outDir, `${name}.html`);
  fs.writeFileSync(file, localizeAssets(html));
  console.log(`wrote ${path.relative(root, file)} (${html.length} bytes)`);
}

// ---------- email-template.js ----------
function renderEmails() {
  const { wrapEmail, wrapServiceEmail, wrapNewsletter, ctaButton, stripeFooterLine, currency, colors } = email;

  // Invoice-shaped transactional email (mirrors invoice-email.js sendInvoiceEmail).
  write('email-invoice', wrapEmail({
    preheader: 'Invoice WPC-000123 — $189.00 due.',
    heading: 'Your invoice is ready.',
    intro: `Hi Jordan,<br><br>Thanks for having Waves out to 1200 Sample Lane. Your quarterly pest control visit is complete and the invoice below is ready whenever you are.
      <div style="margin-top:16px;padding:14px 16px;background:#F8FCFE;border:1px solid #CFE7F5;border-radius:12px;font-family:${colors.FONT};font-size:14px;line-height:1.55;color:${colors.BODY};">Reminder: your account also has a previous balance of ${currency(95)} from an earlier invoice, separate from this invoice.</div>`,
    lines: [
      ['Invoice', 'WPC-000123'],
      ['Service', 'Quarterly Pest Control'],
      ['Service date', 'September 8, 2026'],
      ['Due', 'September 22, 2026'],
      ['Amount due', currency(189), true],
    ],
    ctaHref: `${PORTAL}/pay/sample`,
    ctaLabel: `Pay ${currency(189)}`,
    footerNote: 'Your PDF invoice is attached. Reply to this email or call (941) 555-0100 with any questions.' + stripeFooterLine(),
  }));

  // Receipt-shaped transactional email (mirrors invoice-email.js sendReceiptEmail).
  write('email-receipt', wrapEmail({
    preheader: 'Receipt for WPC-000123 — $189.00 paid.',
    heading: 'Payment received. Thank you!',
    intro: 'Hi Jordan,<br><br>We received your payment for invoice WPC-000123. A PDF receipt is attached for your records.',
    lines: [
      ['Invoice', 'WPC-000123'],
      ['Paid with', 'Visa ending 4242'],
      ['Paid on', 'September 9, 2026'],
      ['Amount paid', currency(189), true],
    ],
    ctaHref: `${PORTAL}/receipt/sample`,
    ctaLabel: 'View receipt online',
    footerNote: 'Your PDF receipt is attached for bookkeeping. Keep this email for your records.',
  }));

  // Appointment-style transactional email without a lines table, CTA only.
  write('email-appointment', wrapEmail({
    preheader: 'Your Waves visit is booked for Thursday.',
    heading: "You're on the schedule.",
    intro: 'Hi Jordan,<br><br>Alex will be at 1200 Sample Lane on <strong>Thursday, September 17</strong> between <strong>9:00 AM and 11:00 AM</strong>. No need to be home — we treat the exterior first and text you when we arrive.',
    ctaHref: `${PORTAL}/reschedule/sample`,
    ctaLabel: 'Need a different time?',
    footerNote: 'Reply to this email or call (941) 555-0100 if anything changes.',
  }));

  // Service email: operator/body HTML with heading, paragraph, table block, CTA.
  const T = email.blockPalette();
  const serviceBody = `
    <h2 style="margin:0 0 10px 0;font-family:${T.font};font-size:22px;line-height:1.2;color:${T.heading};font-weight:700;">Your service summary</h2>
    <p style="margin:0 0 16px 0;">Hi Jordan, here is what we did at 1200 Sample Lane today and what to expect over the next few days.</p>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;margin:0 0 18px 0;">
      <tr><td style="padding:8px 0;border-bottom:1px solid ${T.rule};font-size:14px;color:${T.mutedText};">Technician</td><td align="right" style="padding:8px 0;border-bottom:1px solid ${T.rule};font-size:14px;color:${T.heading};font-weight:600;">Alex M.</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid ${T.rule};font-size:14px;color:${T.mutedText};">Areas treated</td><td align="right" style="padding:8px 0;border-bottom:1px solid ${T.rule};font-size:14px;color:${T.heading};font-weight:600;">Exterior perimeter, garage, lanai</td></tr>
      <tr><td style="padding:8px 0;border-bottom:1px solid ${T.rule};font-size:14px;color:${T.mutedText};">Products</td><td align="right" style="padding:8px 0;border-bottom:1px solid ${T.rule};font-size:14px;color:${T.heading};font-weight:600;">Non-repellent barrier, granular bait</td></tr>
      <tr><td style="padding:8px 0;font-size:14px;color:${T.mutedText};">Next visit</td><td align="right" style="padding:8px 0;font-size:14px;color:${T.heading};font-weight:600;">December 2026</td></tr>
    </table>
    <div style="margin:0 0 18px 0;padding:14px 16px;background:${T.calloutBg};border-left:4px solid ${T.calloutBorder};border-radius:10px;color:${T.calloutText};font-size:15px;line-height:1.5;">Seeing a few ants over the next 48 hours is normal — the barrier works as they cross it.</div>
    ${ctaButton(`${PORTAL}/report/sample`, 'View your full report')}
  `;
  write('email-service', wrapServiceEmail({
    preheader: 'Your Waves service summary for today.',
    body: serviceBody,
    footerNote: 'Questions about today’s visit? Reply to this email and a real person answers.',
  }));

  // Newsletter: h2, paragraphs, list, unsubscribe, preferred-sources CTA, web version.
  const N = email.newsletterPalette();
  const band = email.newsletterSectionTheme(0);
  const band2 = email.newsletterSectionTheme(1);
  const newsletterBody = `
    <h2 class="dm-ink" style="margin:0 0 12px 0;padding:10px 14px;border-radius:10px;background:${band.background};color:${band.text};font-family:${N.font};font-size:22px;line-height:1.2;font-weight:700;border-left:4px solid ${band.accent};">Fresh this week in Venice</h2>
    <p class="dm-page-text" style="margin:0 0 14px 0;">The rain is back, which means the ants are back too. Here is what our techs are seeing on the island this week and three things you can do before the weekend.</p>
    <p class="dm-page-text" style="margin:0 0 14px 0;">Mosquito pressure is up along the canals after last Tuesday’s storm. If your yard is holding water in pots or gutters, tip it out — that alone cuts breeding sites in half.</p>
    <h2 class="dm-ink" style="margin:20px 0 12px 0;padding:10px 14px;border-radius:10px;background:${band2.background};color:${band2.text};font-family:${N.font};font-size:22px;line-height:1.2;font-weight:700;border-left:4px solid ${band2.accent};">Three quick wins</h2>
    <ul class="dm-page-text" style="margin:0 0 14px 22px;padding:0;">
      <li style="margin:0 0 8px 0;">Trim shrubs 12 inches off the stucco so the barrier has room to work.</li>
      <li style="margin:0 0 8px 0;">Empty saucers and bird baths twice a week.</li>
      <li style="margin:0 0 8px 0;">Keep firewood off the ground and away from the house.</li>
    </ul>
    <p class="dm-page-text" style="margin:0;">Have a question for a tech? Just reply — a real person reads every one.</p>
  `;
  write('email-newsletter', wrapNewsletter({
    preheader: 'Ants, mosquitoes and three quick wins before the weekend.',
    body: newsletterBody,
    unsubscribeUrl: UNSUB,
    preferredSourcesCta: true,
    newsletterType: 'local-weekly-fresh-events',
    webVersionUrl: 'https://example.invalid/newsletter/sample-issue',
    footerNote: 'You are receiving this because you signed up at our website.',
  }));
}

// ---------- public-newsletter.js renderConfirmPage ----------
function loadRenderConfirmPage() {
  const file = path.join(root, 'server/routes/public-newsletter.js');
  const src = fs.readFileSync(file, 'utf8');
  const start = src.indexOf('function renderConfirmPage(');
  if (start < 0) throw new Error('renderConfirmPage not found in public-newsletter.js');
  // The function body is a single template literal; the first "\n}\n" after
  // the start closes it.
  const end = src.indexOf('\n}\n', start);
  if (end < 0) throw new Error('renderConfirmPage end not found');
  const slice = src.slice(start, end + 2);
  const sandbox = { glassUniversalFooterHtml: email.glassUniversalFooterHtml };
  vm.createContext(sandbox);
  return vm.runInContext(`${slice}\n; renderConfirmPage`, sandbox, { filename: 'public-newsletter.renderConfirmPage.slice.js' });
}

function renderNewsletterLanding() {
  const renderConfirmPage = loadRenderConfirmPage();
  const emailSpan = '<span class="email">jordan.rivera@example.invalid</span>';
  // Mirrors the route bodies: GET /confirm pending, POST /confirm success,
  // unsubscribe confirmation, and the invalid-link branch.
  write('newsletter-confirm-pending', renderConfirmPage('One last click.', `
          <p>Confirm the subscription for ${emailSpan} to start receiving the Waves Newsletter.</p>
          <form method="POST" action="#">
            <button type="submit" class="btn">Confirm subscription</button>
          </form>
          <p style="margin-bottom:0; font-size:14px; color:#4F5B70;">If you didn't sign up, just close this tab — nothing happens until you click the button.</p>
        `));
  write('newsletter-confirmed', renderConfirmPage("You're in.", `<p>${emailSpan} is confirmed. The next Waves Newsletter lands in your inbox this week.</p><p style="margin-bottom:0">Until then, browse recent issues at <a href="https://example.invalid/newsletter/">/newsletter</a>.</p>`));
  write('newsletter-unsubscribed', renderConfirmPage("You're unsubscribed.", `<p>No more newsletters will be sent to ${emailSpan}.</p><p style="margin-bottom:0">Changed your mind? Sign up again at <a href="https://example.invalid/newsletter/">/newsletter</a>.</p>`));
  // Quiz + feedback landings (GET confirm form, POST result) — mirrors public-newsletter.js quiz/feedback routes.
  const fine = 'margin-bottom:0; font-size:14px; color:#4F5B70;';
  write('newsletter-quiz-confirm', renderConfirmPage('One tap to confirm.', `
          <p>You picked <strong>Brown patches</strong>. Tap confirm and we'll take it from here.</p>
          <form method="POST" action="#"><button type="submit" class="btn">Confirm — Brown patches</button></form>
          <p style="${fine}">If you didn't tap this, just close this tab — nothing changes until you click the button.</p>`));
  write('newsletter-quiz-thanks', renderConfirmPage("Thanks — we've got you.", `
          <p>We'll bring a free lawn check on your next visit.</p>
          <p style="margin-bottom:6px;">Want it sooner?</p>
          <p style="margin:0 0 10px;"><a href="https://example.invalid/book" class="btn">Book a lawn check</a></p>
          <p style="margin-bottom:0; font-size:14px;">or call us at <a href="tel:+19415550100">(941) 555-0100</a>.</p>`));
  const missing = ['Closer events', 'More local news', 'Restaurant openings', 'Family activities', 'Home tips']
    .map((l) => `<label style="display:block;margin:0 0 10px;font-size:16px;color:#3F4A65;cursor:pointer;"><input type="checkbox" name="missing" value="x" style="margin-right:8px;vertical-align:middle;" />${l}</label>`).join('');
  write('newsletter-feedback-needs-work', renderConfirmPage('Ouch — help us fix it.', `
          <p>You picked <strong>👎 Needs work</strong>. What was missing?</p>
          <form method="POST" action="#">${missing}<button type="submit" class="btn" style="margin-top:6px;">Send feedback</button></form>
          <p style="${fine}">Nothing is recorded until you tap the button — check any that apply (or none).</p>`));
  write('newsletter-feedback-confirm', renderConfirmPage('One tap to confirm.', `
          <p>You picked <strong>🔥 Loved it</strong>. Tap confirm and it's counted.</p>
          <form method="POST" action="#"><button type="submit" class="btn">Confirm — Loved it</button></form>
          <p style="${fine}">If you didn't tap this, just close this tab — nothing changes until you click the button.</p>`));
  write('newsletter-feedback-thanks', renderConfirmPage('Got it — thanks for the straight talk.', `
          <p>Noted: <strong>Closer events, Home tips</strong>. Next issues will lean that way.</p>
          <p style="margin-bottom:0;">— The Waves Team 🌊</p>`));
  write('newsletter-invalid-link', renderConfirmPage('Link expired or invalid.', `<p>This confirmation link doesn't match a pending subscription. The link may have already been used or it may have expired.</p><p style="margin-bottom:0">Sign up again at <a href="https://example.invalid/newsletter/">/newsletter</a>.</p>`));
}

fs.mkdirSync(outDir, { recursive: true });
renderEmails();
renderNewsletterLanding();
console.log('skipped: estimate-public.js renderPage (needs db/config/JWT at require time; see header comment)');
