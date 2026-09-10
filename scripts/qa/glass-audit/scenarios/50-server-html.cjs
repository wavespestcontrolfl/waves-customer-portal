'use strict';
// Server-rendered customer surfaces (email chrome + newsletter landing pages).
// Static HTML is produced by scripts/qa/glass-audit/render-server-html.cjs into
// client/glass-audit-html/ (served by Vite at /glass-audit-html/<file>.html).
// Run the render script before this family. No /api calls are expected.

const noApi = () => null;
const EMAIL_WIDTHS = [390, 640, 1440];

const emails = [
  ['email-invoice', 'wrapEmail (invoice-email.js sendInvoiceEmail shape)'],
  ['email-receipt', 'wrapEmail (invoice-email.js sendReceiptEmail shape)'],
  ['email-appointment', 'wrapEmail (heading + intro + CTA, no lines table)'],
  ['email-service', 'wrapServiceEmail (operator body + ctaButton)'],
  ['email-newsletter', 'wrapNewsletter (flagship weekly masthead)'],
];

const landing = [
  ['newsletter-confirm-pending', 'GET /api/public/newsletter/confirm/:token (pending)'],
  ['newsletter-confirmed', 'POST /api/public/newsletter/confirm/:token (confirmed)'],
  ['newsletter-unsubscribed', 'GET /api/public/newsletter/unsubscribe/:token (done)'],
  ['newsletter-invalid-link', 'GET /api/public/newsletter/confirm/:token (invalid)'],
];

module.exports = [
  ...emails.map(([id, route]) => ({
    id, family: 'email', surface: 'server-html', role: 'email recipient', route,
    url: `/glass-audit-html/${id}.html`, ready: 'css:body', handle: noApi, widths: EMAIL_WIDTHS, fonts: false,
    notes: 'Rendered by render-server-html.cjs from server/services/email-template.js; portal asset URLs rewritten to same-origin.',
  })),
  ...landing.map(([id, route]) => ({
    id, family: 'newsletter-landing', surface: 'server-html', role: 'public token', route,
    url: `/glass-audit-html/${id}.html`, ready: 'css:body', handle: noApi, fonts: false,
    notes: 'Rendered by render-server-html.cjs from a source slice of renderConfirmPage in server/routes/public-newsletter.js.',
  })),
  // family 'estimate-legacy-ssr' intentionally absent: renderPage in
  // server/routes/estimate-public.js is not reachable without db/config.
];
