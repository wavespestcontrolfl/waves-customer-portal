const express = require('express');
const rateLimit = require('express-rate-limit');
const Sentry = require('@sentry/node');

const router = express.Router();

// Client-reported errors (React error boundaries, admin handler catches). There
// was no client-side error telemetry — render crashes and handler failures only
// hit console.error/alert and never reached production monitoring. Unauthenticated
// on purpose (an anonymous page like /admin/login can crash too) and tightly
// rate-limited.
//
// CRITICAL: this endpoint is PUBLIC, so EVERY field is attacker-controllable.
// Free-form error text can carry bearer tokens, card PANs/CVVs, SSNs, emails,
// phones, addresses, or names — regex scrubbing can never catch them all. So we
// do NOT forward any free-form string: each field is strictly transformed into a
// known non-sensitive shape (validated error name, allowlisted route root,
// validated context label, component-name-only stack) before it reaches Sentry.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
});

// A JS error name / constructor name (TypeError, ChunkLoadError, …). Anything
// else collapses to a generic label — never echo attacker text.
const errorName = (value) =>
  (/^[A-Za-z][A-Za-z0-9_.$]{0,60}$/.test(String(value || '')) ? String(value) : 'Error');

// A caller-set context label — the code passes fixed strings like
// "PageErrorBoundary" or "banking:payout". Reject anything that isn't that shape.
const contextLabel = (value) =>
  (/^[A-Za-z][A-Za-z0-9:._ -]{0,60}$/.test(String(value || '')) ? String(value) : undefined);

// Known top-level route roots. The route is reduced to just its root so no token
// or injected value in the tail can persist; unknown roots become "other".
const ROUTE_ROOTS = new Set([
  'admin', 'tech', 'report', 'pest-report', 'lawn-report', 'estimate', 'pay',
  'receipt', 'track', 'contract', 'card', 'prep', 'rate', 'recap', 'review',
  'secure', 'reschedule', 'price-change', 'service-outlines', 'book', 'login',
]);
const routeRoot = (value) => {
  const path = String(value || '');
  if (!path.startsWith('/')) return undefined;
  const first = path.split('/').filter(Boolean)[0];
  if (!first) return '/';
  return ROUTE_ROOTS.has(first) ? first : 'other';
};

// React component stacks are "in ComponentName" / "at ComponentName" lines.
// Extract ONLY those identifier tokens (dropping any injected free text), which
// are code symbols, not user data. Capped.
const componentNames = (value) => {
  const matches = String(value || '').match(/\b(?:in|at) [A-Za-z][A-Za-z0-9]{0,50}/g);
  if (!matches) return undefined;
  return matches.slice(0, 40).join('\n');
};

// POST /api/client-errors  { name, context, route, componentStack }
router.post('/', limiter, (req, res) => {
  try {
    const { name, context, route, componentStack } = req.body || {};
    const err = new Error(errorName(name));
    err.name = errorName(name);
    Sentry.captureException(err, {
      tags: { source: 'client' },
      contexts: {
        client_error: {
          context: contextLabel(context),
          route: routeRoot(route),
          componentStack: componentNames(componentStack),
        },
      },
    });
  } catch {
    /* telemetry ingestion must never 500 the caller */
  }
  res.status(204).end();
});

module.exports = router;
