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

// POST /api/client-errors  { message, stack, componentStack, context, url }
router.post('/', limiter, (req, res) => {
  try {
    const { message, stack, componentStack, context, url } = req.body || {};
    // @sentry/node 10.x: the second arg is a CaptureContext OBJECT, not a
    // scope-mutator callback (a callback is silently ignored, dropping the tag
    // and context).
    Sentry.captureException(new Error(clip(message, 500) || 'Client error (no message)'), {
      tags: { source: 'client' },
      contexts: {
        client_error: {
          context: clip(context, 200),
          url: safePath(url),
          stack: clip(stack, 4000),
          componentStack: clip(componentStack, 4000),
          userAgent: clip(req.headers['user-agent'], 300),
        },
      },
    });
  } catch {
    /* telemetry ingestion must never 500 the caller */
  }
  res.status(204).end();
});

module.exports = router;
