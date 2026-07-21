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

// A GLOBAL ceiling (one shared bucket) on top of the per-IP limit: distributed
// callers could otherwise bypass the per-IP cap and exhaust the Sentry event
// quota, hiding real errors. Client crashes are rare, so 60/min across everyone
// is generous; excess is dropped before it reaches Sentry.
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: () => 'global',
});

// A JS error name. Identifier-shape checks still let attacker PII through (a
// person's name is identifier-shaped), so this is a strict allowlist of standard
// + common web error names; anything else collapses to "Error".
const ERROR_NAMES = new Set([
  'Error', 'TypeError', 'RangeError', 'ReferenceError', 'SyntaxError',
  'EvalError', 'URIError', 'AggregateError', 'DOMException', 'ChunkLoadError',
  'AbortError', 'NetworkError', 'TimeoutError', 'NotFoundError', 'SecurityError',
  'QuotaExceededError', 'NotAllowedError', 'InvalidStateError', 'DataError',
]);
const errorName = (value) =>
  (ERROR_NAMES.has(String(value || '')) ? String(value) : 'Error');

// Context is a FIXED, code-set label — a shape check alone still lets attacker
// text (e.g. "a4242424242424242") through on this public route, so collapse to a
// strict allowlist. New callers add their label here on purpose.
const CONTEXT_LABELS = new Set([
  'PageErrorBoundary',
  'banking:reconcile',
  'banking:download',
  'banking:payout',
]);
const contextLabel = (value) =>
  (CONTEXT_LABELS.has(String(value || '')) ? String(value) : undefined);

// Known top-level route roots. The route is reduced to just its root so no token
// or injected value in the tail can persist; unknown roots become "other".
const ROUTE_ROOTS = new Set([
  'admin', 'tech', 'report', 'pest-report', 'lawn-report', 'estimate', 'pay',
  'receipt', 'track', 'contract', 'card', 'prep', 'rate', 'recap', 'review',
  'secure', 'reschedule', 'price-change', 'service-outlines', 'book', 'login',
]);
// A page-name segment: lowercase letters + hyphens, NO digits — so admin/tech
// page names (banking, dashboard, service-outlines) are kept but any tokenized
// or injected tail (digits, mixed case, PANs) is dropped.
const PAGE_SEG_RE = /^[a-z][a-z-]{0,30}$/;
const routeLabel = (value) => {
  const path = String(value || '');
  if (!path.startsWith('/')) return undefined;
  const segs = path.split('/').filter(Boolean);
  const first = segs[0];
  if (!first) return '/';
  // admin/tech carry no path tokens — keep a safe page segment so distinct pages
  // (/admin/banking vs /admin/dashboard) fingerprint separately.
  if (first === 'admin' || first === 'tech') {
    return segs[1] && PAGE_SEG_RE.test(segs[1]) ? `${first}/${segs[1]}` : first;
  }
  return ROUTE_ROOTS.has(first) ? first : 'other';
};

// POST /api/client-errors  { name, context, route }
// componentStack is intentionally NOT accepted: React component names are
// unbounded, so on a public endpoint an attacker could inject a person's name as
// a fake "component". Only the three allowlisted/transformed fields are kept.
// Per-IP limiter FIRST so only requests that pass it debit the shared global
// bucket — otherwise one noisy IP could drain the all-caller quota with requests
// its own per-IP cap would have rejected anyway.
router.post('/', limiter, globalLimiter, (req, res) => {
  try {
    const { name, context, route } = req.body || {};
    const name_ = errorName(name);
    const context_ = contextLabel(context);
    const route_ = routeLabel(route);
    const err = new Error(name_);
    err.name = name_;
    Sentry.captureException(err, {
      // Every report is constructed at this one line, so without an explicit
      // fingerprint Sentry's default grouping collapses all client errors into a
      // single issue. Group by the bounded (name, context, route) instead so
      // distinct failure classes stay actionable.
      fingerprint: ['client-error', name_, context_ || 'none', route_ || 'none'],
      tags: { source: 'client' },
      contexts: {
        client_error: { context: context_, route: route_ },
      },
    });
  } catch {
    /* telemetry ingestion must never 500 the caller */
  }
  res.status(204).end();
});

module.exports = router;
