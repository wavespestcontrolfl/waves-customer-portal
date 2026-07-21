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
          url: clip(url, 500),
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
