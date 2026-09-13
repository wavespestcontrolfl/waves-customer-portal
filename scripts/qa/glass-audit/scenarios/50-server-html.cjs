'use strict';
// Server-rendered customer surfaces (email chrome + newsletter landing pages).
// Static HTML is produced by scripts/qa/glass-audit/render-server-html.cjs into
// client/glass-audit-html/ (served by Vite at /glass-audit-html/<file>.html).
// run.cjs renders the files on demand when any are missing. No /api calls are expected.

const noApi = () => null;
const EMAIL_WIDTHS = [390, 640, 1440];

// [id, route description, readiness text]. Readiness is page-specific copy (not `body`) so Vite's SPA
// fallback / 404 document can never be captured in a scenario's place; run.cjs also rejects HTTP >= 400.
const emails = [
  ['email-invoice', 'wrapEmail (invoice-email.js sendInvoiceEmail shape)', 'Invoice'],
  ['email-receipt', 'wrapEmail (invoice-email.js sendReceiptEmail shape)', 'Receipt'],
  ['email-appointment', 'wrapEmail (heading + intro + CTA, no lines table)', 'on the schedule'],
  ['email-service', 'wrapServiceEmail (operator body + ctaButton)', 'Waves'],
  ['email-newsletter', 'wrapNewsletter (flagship weekly masthead)', 'Newsletter'],
];

const landing = [
  ['newsletter-confirm-pending', 'GET /api/public/newsletter/confirm/:token (pending)', 'One last click'],
  ['newsletter-confirmed', 'POST /api/public/newsletter/confirm/:token (confirmed)', "You're in"],
  ['newsletter-unsubscribe-confirm', 'GET /api/public/newsletter/unsubscribe/:token (pending confirm form)', 'Confirm unsubscribe'],
  ['newsletter-already-unsubscribed', 'GET /api/public/newsletter/unsubscribe/:token (already unsubscribed)', 'already unsubscribed'],
  ['newsletter-unsubscribe-invalid', 'GET /api/public/newsletter/unsubscribe/:token (invalid)', 'no longer matches'],
  ['newsletter-unsubscribed', 'POST /api/public/newsletter/unsubscribe/:token (form-submit result)', "You're unsubscribed"],
  ['newsletter-invalid-link', 'GET /api/public/newsletter/confirm/:token (invalid)', 'Link expired or invalid'],
  ['newsletter-quiz-confirm', 'GET /api/public/newsletter/quiz/:token/:quizId/:answer (confirm form)', 'One tap to confirm'],
  ['newsletter-quiz-thanks', 'POST /api/public/newsletter/quiz/:token/:quizId/:answer (thank-you + book CTA)', "we've got you"],
  ['newsletter-feedback-needs-work', 'GET /api/public/newsletter/feedback/:token/needs-work (checkbox form)', 'help us fix it'],
  ['newsletter-feedback-confirm', 'GET /api/public/newsletter/feedback/:token/:reaction (confirm form)', 'One tap to confirm'],
  ['newsletter-feedback-thanks', 'POST /api/public/newsletter/feedback/:token/needs-work (result)', 'straight talk'],
  ['newsletter-already-active', 'GET /api/public/newsletter/confirm/:token (already active)', 'already in'],
  ['newsletter-confirm-unsubscribed', 'GET /api/public/newsletter/confirm/:token (unsubscribed)', 'currently unsubscribed'],
  ['newsletter-confirmed-unsubscribed', 'POST /api/public/newsletter/confirm/:token (unsubscribed)', 'currently unsubscribed'],
  ['newsletter-confirmed-invalid', 'POST /api/public/newsletter/confirm/:token (invalid)', 'Link expired or invalid'],
  ['newsletter-unsubscribed-invalid', 'POST /api/public/newsletter/unsubscribe/:token (form submit, expired link)', 'expired or invalid'],
  ['newsletter-quiz-thanks-nocta', 'POST /api/public/newsletter/quiz/:token/:quizId/:answer (thank-you, booking CTA suppressed)', 'staying on the list'],
  ['newsletter-feedback-thanks-positive', 'POST /api/public/newsletter/feedback/:token/:reaction (positive result)', 'that helps'],
];

module.exports = [
  ...emails.map(([id, route, ready]) => ({
    id, family: 'email', surface: 'server-html', role: 'email recipient', route,
    url: `/glass-audit-html/${id}.html`, ready, handle: noApi, widths: EMAIL_WIDTHS, fonts: false,
    notes: 'Rendered by render-server-html.cjs from server/services/email-template.js; portal asset URLs rewritten to same-origin.',
  })),
  ...landing.map(([id, route, ready]) => ({
    id, family: 'newsletter-landing', surface: 'server-html', role: 'public token', route,
    url: `/glass-audit-html/${id}.html`, ready, handle: noApi, fonts: false,
    notes: 'Rendered by render-server-html.cjs: renderConfirmPage sliced from server/routes/public-newsletter.js and the route handler\'s own heading/bodyHtml template evaluated with fixture inputs (no hand-copied bodies).',
  })),
  // family 'estimate-legacy-ssr' intentionally absent: renderPage in
  // server/routes/estimate-public.js is not reachable without db/config.
];
