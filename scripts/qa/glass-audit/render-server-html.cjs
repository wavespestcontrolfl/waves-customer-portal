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
//   - public-newsletter.js does NOT export renderConfirmPage and boots db /
//     rate limiters / the confirmation mailer at load time, so we never
//     require it. The file is parsed with acorn: renderConfirmPage and
//     escapeHtml are sliced out and evaluated with glassUniversalFooterHtml
//     injected, and each landing page's heading + bodyHtml is the route
//     handler's own template expression (found by route + heading text),
//     evaluated with fixture inputs. A missing branch, a renamed heading or a
//     template that no longer compiles exits non-zero — never a stale page.
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

// ---------- public-newsletter.js renderConfirmPage + route bodies ----------
// public-newsletter.js is never require()d (it boots db / rate limiters / the
// confirmation mailer at load time). Instead the file is PARSED (acorn) and
//   - renderConfirmPage / escapeHtml are sliced out and evaluated as-is;
//   - every landing page's heading + bodyHtml is the route handler's OWN
//     template expression, located by route + heading text and evaluated with
//     the same inputs the handler would have (email, token, quiz, reaction…).
// Nothing is hand-copied, so a copy or markup change in any route branch is
// captured on the next run; a branch that disappears or is renamed makes this
// script exit non-zero rather than emit a stale page.
const NEWSLETTER_ROUTE_FILE = path.join(root, 'server/routes/public-newsletter.js');

function sliceFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found in public-newsletter.js`);
  const end = src.indexOf('\n}\n', start); // top-level function: first "\n}\n" closes it
  if (end < 0) throw new Error(`${name} end not found`);
  return src.slice(start, end + 2);
}

function parseNewsletterRoutes() {
  const acorn = require('acorn');
  const walk = require('acorn-walk');
  const src = fs.readFileSync(NEWSLETTER_ROUTE_FILE, 'utf8');
  const ast = acorn.parse(src, { ecmaVersion: 'latest', sourceType: 'script' });
  const text = (n) => src.slice(n.start, n.end);
  const routes = new Map(); // "get /confirm/:token" → [{ kind, name?, src, start }] in source order
  walk.simple(ast, {
    CallExpression(call) {
      const c = call.callee;
      if (c.type !== 'MemberExpression' || c.object.name !== 'router' || !['get', 'post'].includes(c.property.name)) return;
      const first = call.arguments[0];
      if (!first || first.type !== 'Literal') return;
      const handler = call.arguments[call.arguments.length - 1];
      const events = [];
      walk.simple(handler, {
        AssignmentExpression(n) { if (n.left.type === 'Identifier' && ['heading', 'bodyHtml'].includes(n.left.name)) events.push({ kind: n.left.name, src: text(n.right), start: n.start }); },
        VariableDeclarator(n) { if (n.id.type === 'Identifier' && n.init) events.push({ kind: ['heading', 'bodyHtml'].includes(n.id.name) ? n.id.name : 'decl', name: n.id.name, src: text(n.init), start: n.start }); },
        CallExpression(n) { if (n.callee.type === 'Identifier' && n.callee.name === 'renderConfirmPage' && n.arguments[0] && n.arguments[0].type === 'Literal') events.push({ kind: 'callHeading', src: text(n.arguments[0]), start: n.start }); },
      });
      events.sort((a, b) => a.start - b.start);
      routes.set(`${c.property.name} ${first.value}`, events);
    },
  });
  return { src, routes };
}

// Evaluate one route branch: the bodyHtml expression whose paired heading evaluates to `heading`.
// `ctx` supplies the handler's free variables for that branch; `derive` names `const` declarations
// in the handler (e.g. the checkbox `options`) that are evaluated from source, in order, before the body.
function renderRouteBranch({ routes, sandboxBase }, route, heading, ctx, derive = []) {
  const events = routes.get(route);
  if (!events) throw new Error(`route ${route} not found in public-newsletter.js`);
  const sandbox = vm.createContext({ ...sandboxBase, ...ctx });
  const evalSrc = (s) => vm.runInContext(`(${s})`, sandbox, { filename: `public-newsletter.${route}.slice.js` });
  const bodies = events.filter((e) => e.kind === 'bodyHtml');
  for (const body of bodies) {
    // Heading = nearest preceding heading assignment; when the route passes a literal straight to
    // renderConfirmPage (unsubscribe POST), that literal is the heading.
    const before = events.filter((e) => e.start < body.start);
    const h = [...before].reverse().find((e) => e.kind === 'heading') || events.find((e) => e.kind === 'callHeading');
    if (!h) continue;
    let hv;
    try { hv = evalSrc(h.src); } catch (e) { continue; } // a heading needing inputs of another branch
    if (hv !== heading) continue;
    for (const name of derive) {
      const d = [...before].reverse().find((e) => e.kind === 'decl' && e.name === name);
      if (!d) throw new Error(`${route}: derived const ${name} not found before "${heading}"`);
      sandbox[name] = evalSrc(d.src);
    }
    return { heading: hv, bodyHtml: evalSrc(body.src) };
  }
  throw new Error(`${route}: no bodyHtml branch with heading "${heading}" (route copy changed? update the fixture spec)`);
}

function renderNewsletterLanding() {
  const parsed = parseNewsletterRoutes();
  const quizSvc = require(path.join(root, 'server/services/newsletter-quiz'));
  const feedbackSvc = require(path.join(root, 'server/services/newsletter-feedback'));
  const business = require(path.join(root, 'server/constants/business'));
  const base = { glassUniversalFooterHtml: email.glassUniversalFooterHtml };
  vm.createContext(base);
  const renderConfirmPage = vm.runInContext(`${sliceFunction(parsed.src, 'renderConfirmPage')}\n; renderConfirmPage`, base, { filename: 'public-newsletter.renderConfirmPage.slice.js' });
  const escapeHtml = vm.runInContext(`${sliceFunction(parsed.src, 'escapeHtml')}\n; escapeHtml`, base, { filename: 'public-newsletter.escapeHtml.slice.js' });
  const sandboxBase = { escapeHtml, MISSING_OPTIONS: feedbackSvc.MISSING_OPTIONS, WAVES_SUPPORT_PHONE_TEL: business.WAVES_SUPPORT_PHONE_TEL, WAVES_SUPPORT_PHONE_DISPLAY: business.WAVES_SUPPORT_PHONE_DISPLAY };
  const R = (route, heading, ctx, derive) => renderRouteBranch({ routes: parsed.routes, sandboxBase }, route, heading, ctx, derive);

  // Fixture inputs (fictional). `email` is the handler's already-escaped address; `tokenSafe` its escaped token.
  const emailAddr = escapeHtml('jordan.rivera@example.invalid');
  const tokenSafe = escapeHtml('00000000-0000-4000-8000-000000000000');
  const sub = { email: 'jordan.rivera@example.invalid', status: 'active' };
  const quiz = quizSvc.getQuiz(quizSvc.DEFAULT_QUIZ_ID);
  const ans = quizSvc.resolveAnswer(quizSvc.DEFAULT_QUIZ_ID, quiz.answers[0].key);
  // A quiz whose thank-you page suppresses the booking CTA (the stay-subscribed win-back).
  const quietQuizId = Object.keys(quizSvc.QUIZZES).find((id) => quizSvc.getQuiz(id) && quizSvc.getQuiz(id).landingCtaSuppressed);
  if (!quietQuizId) throw new Error('no quiz with landingCtaSuppressed found (newsletter-quiz-thanks-nocta)');
  const quietQuiz = quizSvc.getQuiz(quietQuizId);
  const needsWork = feedbackSvc.resolveReaction('needs-work');
  const positive = feedbackSvc.REACTIONS.find((r) => r.key !== 'needs-work');
  const missingKeys = feedbackSvc.resolveMissingKeys(['closer-events', 'home-tips']);
  const missingLabels = feedbackSvc.MISSING_OPTIONS.filter((o) => missingKeys.includes(o.key)).map((o) => o.label);

  const pages = {
    'newsletter-confirm-pending': R('get /confirm/:token', 'One last click.', { email: emailAddr, tokenSafe }),
    'newsletter-confirmed': R('post /confirm/:token', "You're in!", { email: emailAddr }),
    'newsletter-invalid-link': R('get /confirm/:token', 'Link expired or invalid.', { email: '' }),
    'newsletter-already-active': R('get /confirm/:token', "You're already in.", { email: emailAddr }),
    'newsletter-confirm-unsubscribed': R('get /confirm/:token', "You're unsubscribed.", { email: emailAddr }),
    'newsletter-confirmed-unsubscribed': R('post /confirm/:token', "You're unsubscribed.", { email: emailAddr }),
    'newsletter-confirmed-invalid': R('post /confirm/:token', 'Link expired or invalid.', { email: '' }),
    'newsletter-unsubscribe-confirm': R('get /unsubscribe/:token', 'Confirm unsubscribe.', { email: emailAddr, tokenSafe }),
    'newsletter-already-unsubscribed': R('get /unsubscribe/:token', "You're already unsubscribed.", { email: emailAddr }),
    'newsletter-unsubscribe-invalid': R('get /unsubscribe/:token', 'Link expired or invalid.', { email: '' }),
    'newsletter-unsubscribed': R('post /unsubscribe/:token', "You're unsubscribed.", { sub, email: emailAddr }),
    'newsletter-unsubscribed-invalid': R('post /unsubscribe/:token', "You're unsubscribed.", { sub: null, email: '' }),
    'newsletter-quiz-confirm': R('get /quiz/:token/:quizId/:answer', 'One tap to confirm.', { label: ans.label, tokenSafe, quizIdSafe: encodeURIComponent(quizSvc.DEFAULT_QUIZ_ID), answerSafe: encodeURIComponent(ans.key) }),
    'newsletter-quiz-thanks': R('post /quiz/:token/:quizId/:answer', "Thanks — we've got you.", { quiz, landingLine: quiz.landingLine, bookLabel: quiz.bookLabel, bookUrl: quizSvc.quizBookingUrl(quizSvc.DEFAULT_QUIZ_ID) }),
    'newsletter-quiz-thanks-nocta': R('post /quiz/:token/:quizId/:answer', "Thanks — we've got you.", { quiz: quietQuiz, landingLine: quietQuiz.landingLine, bookLabel: quietQuiz.bookLabel, bookUrl: quizSvc.quizBookingUrl(quietQuizId) }),
    'newsletter-feedback-needs-work': R('get /feedback/:token/:reaction', 'Ouch — help us fix it.', { pick: `${needsWork.emoji} ${needsWork.label}`, reaction: needsWork, formAction: `/api/public/newsletter/feedback/${tokenSafe}/${needsWork.key}` }, ['options']),
    'newsletter-feedback-confirm': R('get /feedback/:token/:reaction', 'One tap to confirm.', { pick: `${positive.emoji} ${positive.label}`, reaction: positive, formAction: `/api/public/newsletter/feedback/${tokenSafe}/${positive.key}` }),
    'newsletter-feedback-thanks': R('post /feedback/:token/:reaction', 'Got it — thanks for the straight talk.', { labels: missingLabels }),
    'newsletter-feedback-thanks-positive': R('post /feedback/:token/:reaction', 'Thanks — that helps! 🌊', { resolved: positive }),
  };
  for (const [name, { heading, bodyHtml }] of Object.entries(pages)) write(name, renderConfirmPage(heading, bodyHtml));
}

fs.mkdirSync(outDir, { recursive: true });
renderEmails();
renderNewsletterLanding();
console.log('skipped: estimate-public.js renderPage (needs db/config/JWT at require time; see header comment)');
