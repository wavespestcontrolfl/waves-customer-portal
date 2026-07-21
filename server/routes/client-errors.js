const express = require('express');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');

const router = express.Router();

// Client-reported errors (React error boundaries, admin handler catches). There
// was no client-side error telemetry — render crashes and handler failures only
// hit console.error/alert and never reached production monitoring. Unauthenticated
// on purpose (an anonymous page like /admin/login can crash too), so it is tightly
// rate-limited and every field is truncated before it reaches Sentry.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

const clip = (value, max) =>
  typeof value === 'string' && value.length ? value.slice(0, max) : undefined;

// Defense in depth: the client already scrubs token-bearing paths, but never
// forward a raw pathname to Sentry regardless. Keep the token-free admin/tech
// surfaces; for every other route keep only the root and drop what follows
// (public token routes carry bearer credentials, some as short as 3 chars).
const safePath = (value) => {
  const path = clip(value, 500);
  if (!path || !path.startsWith('/')) return undefined;
  if (/^\/(admin|tech)(\/|$)/.test(path)) return path;
  const segments = path.split('/').filter(Boolean);
  return segments.length <= 1 ? path : `/${segments[0]}/:token`;
};

// The free-form fields (message, stack, componentStack, context) can embed a
// tokenized URL, a JWT, or customer PII that a component threw into an error
// string — never persist those in Sentry. Redaction, in order:
//  - token-route paths, browser AND /api/ forms, whole tail incl. nested
//    segments (so /pay/statement/abc and /api/estimates/abc/data both redact
//    the token regardless of length);
//  - JWTs and long opaque tokens;
//  - email addresses and phone numbers.
const TOKEN_ROUTE_ROOTS = 'reports?|estimates?|pay|receipts?|track|contracts?|card|prep|rate|recap|reviews?|secure|reschedule|price-change|lawn-report|pest-report|service-outlines|book';
const TOKEN_ROUTE_RE = new RegExp(`(\\/(?:api\\/)?(?:${TOKEN_ROUTE_ROOTS})\\/)[^\\s"'?)]+`, 'gi');
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\b/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{24,}\b/g;
const EMAIL_RE = /[^\s@<>()"]+@[^\s@<>()"]+\.[^\s@<>()"]+/g;
const PHONE_RE = /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g;
const scrubText = (value, max) => {
  const text = clip(value, max);
  if (!text) return undefined;
  return text
    .replace(TOKEN_ROUTE_RE, '$1:token')
    .replace(JWT_RE, ':jwt')
    .replace(LONG_TOKEN_RE, ':token')
    .replace(EMAIL_RE, ':email')
    .replace(PHONE_RE, ':phone');
};

// POST /api/client-errors  { message, stack, componentStack, context, url }
router.post('/', limiter, (req, res) => {
  try {
    const { message, stack, componentStack, context, url } = req.body || {};
    // @sentry/node 10.x: the second arg is a CaptureContext OBJECT, not a
    // scope-mutator callback (a callback is silently ignored, dropping the tag
    // and context).
    Sentry.captureException(new Error(scrubText(message, 500) || 'Client error (no message)'), {
      tags: { source: 'client' },
      contexts: {
        client_error: {
          context: scrubText(context, 200),
          url: safePath(url),
          stack: scrubText(stack, 4000),
          componentStack: scrubText(componentStack, 4000),
        },
      },
    });
  } catch {
    /* telemetry ingestion must never 500 the caller */
  }
  res.status(204).end();
});

module.exports = router;
