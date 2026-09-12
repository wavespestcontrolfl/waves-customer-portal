/**
 * Ops digest ingest — POST /api/ops/digest (machine auth).
 *
 * The external Waves ops crons on the owner's Mac (~/waves-ops/ops-crons,
 * 35 read-only reconciliation checks, hourly + daily under launchd) used to
 * deliver every finding as an email from "Waves Ops" to contact@. Owner ask
 * 2026-09-11: the EXCEPTIONS belong in the admin bell, next to the
 * in-process digests, instead of the inbox — and only the exceptions.
 * Routine and success reporting ("FYI: 1 autopay text went out", FIRST:
 * firsts, the day-1 baseline, anything a check emits after days of clean
 * runs) must NOT land in the bell (owner, same day): those keep the email
 * path, so the route accepts FIX and ACT and refuses every other kind.
 *
 * One finding in, one ops_digest bell row out — the same category and
 * metadata shape services/ops-digest.js writes, so the Agents → Activity
 * feed lists it under "Waves Ops" and the bell shows it like any digest.
 *
 * Auth: OPS_DIGEST_INGEST_TOKEN bearer, constant-time compare (mcp.js
 * pattern). Fails closed at every step, and every non-2xx tells the caller
 * to fall back to email so a finding is never lost:
 *   404  token unset — the endpoint does not exist (this IS the kill switch);
 *        same generic body as an unknown route
 *   401  token mismatch
 *   409  in-app digests off (GATE_OPS_DIGESTS_IN_APP / GATE_AGENT_ACTIVITY)
 *   400  payload rejected (kind not FIX/ACT, shape, size, link off /admin)
 *   503  bell row not written
 *   201  { ok: true, id, deduped }
 *
 * PII: the checks already write id prefixes and masked phones, never names
 * or emails (ops-crons lib.js contract); the route stores what it is given
 * and logs only the key. Sizes are capped so a runaway check cannot bloat
 * the notifications table. Dedupe: the runner latches each (check, key)
 * once, and the route dedupes the same key inside a rolling day on top, so
 * run.sh re-running after a partial failure cannot double-ring.
 */
const express = require('express');
const rateLimit = require('express-rate-limit');
const logger = require('../services/logger');
const db = require('../models/db');
const NotificationService = require('../services/notification-service');
const { safeEqual } = require('../middleware/hermes-auth');
const { notFoundBody } = require('../middleware/errors');
const { noStore } = require('../middleware/no-store');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
const { inAppEnabled, resolveOpsDigest, CATEGORY } = require('../services/ops-digest');

const router = express.Router();
// Token-route privacy baseline on every outcome (dark 404, 401, 4xx, 201):
// no-store, noindex, no-referrer — middleware/no-store.js, the shared trio.
router.use(noStore);

// Exceptions only — see header. FYI / FIRST are refused on purpose.
const KINDS = new Set(['FIX', 'ACT']);
const KEY_RE = /^[a-z0-9][a-z0-9._:-]{0,119}$/i;
const MAX_SUBJECT_CHARS = 180;   // + "KIND: " stays inside the varchar(200) title
const MAX_BODY_CHARS = 60000;
const MAX_LINK_CHARS = 300;
const MAX_METADATA_BYTES = 4096;
const DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
const SOURCE = 'ops-crons';

const ingestLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  message: { ok: false, reason: 'rate_limited' },
  // The bearer is a shared secret, not a JWT: key by client IP (/64).
  keyGenerator: unauthenticatedAuthLimitKey,
  // Off under jest only — staging / PR environments keep the limiter.
  skip: () => process.env.NODE_ENV === 'test',
});

// The SAME body an unknown route gets — middleware/errors.js notFoundBody,
// the one formatter, never a retyped string — so a distinguishable 404
// cannot tell a prober the route exists while dark (codex P0 r2 on #4392).
function genericNotFound(req, res) {
  return res.status(404).json(notFoundBody(req));
}

// Dark-route check FIRST, ahead of the limiter: while the token is unset
// the endpoint must be a plain 404 at any request volume — a 429 from the
// limiter would tell a prober the route is real (pre-push P1).
function darkUnlessConfigured(req, res, next) {
  if (!process.env.OPS_DIGEST_INGEST_TOKEN) return genericNotFound(req, res);
  return next();
}

function ingestAuth(req, res, next) {
  const expected = process.env.OPS_DIGEST_INGEST_TOKEN;
  if (!expected) return genericNotFound(req, res);
  const header = String(req.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!safeEqual(provided, expected)) return res.status(401).json({ ok: false, reason: 'invalid_token' });
  return next();
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// The observation already stored for this dedupe key, if a row still stands
// inside the rolling window. Mirrors notification-service.js's own dedupe
// probe (recipient_type + metadata->>'dedupeKey' + the window, .first()
// without ordering) so it reads the row notifyAdmin will find.
async function standingObservation(trx, dedupeKey) {
  const row = await trx('notifications')
    .where({ recipient_type: 'admin' })
    .whereRaw("metadata->>'dedupeKey' = ?", [dedupeKey])
    .where('created_at', '>', trx.raw("NOW() - (? * interval '1 millisecond')", [DEDUPE_WINDOW_MS]))
    .first('created_at', trx.raw("metadata->>'observedAt' as observed_at"));
  if (!row) return null;
  return row.observed_at || row.created_at || null;
}

// The later of a stored observation and the incoming one, as an ISO string.
// An unparsable or absent stored value never wins.
function laterOf(stored, incoming) {
  const storedMs = stored === null || stored === undefined ? NaN : new Date(stored).getTime();
  if (!Number.isFinite(storedMs)) return incoming;
  return storedMs > Date.parse(incoming) ? new Date(storedMs).toISOString() : incoming;
}

// Returns { error } or { value } — pure, so the tests can pin every branch.
function validateDigest(body) {
  if (!isPlainObject(body)) return { error: 'body must be a JSON object' };
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!KEY_RE.test(key)) return { error: 'key: 1-120 chars of letters, digits, . _ : -' };
  const kind = typeof body.kind === 'string' ? body.kind.trim().toUpperCase() : '';
  if (!KINDS.has(kind)) return { error: 'kind must be FIX or ACT — routine/FYI reports stay on email' };
  const subject = typeof body.subject === 'string' ? body.subject.replace(/\s+/g, ' ').trim() : '';
  if (!subject) return { error: 'subject is required' };
  if (subject.length > MAX_SUBJECT_CHARS) return { error: `subject exceeds ${MAX_SUBJECT_CHARS} chars` };
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (!text) return { error: 'body is required' };
  if (text.length > MAX_BODY_CHARS) return { error: `body exceeds ${MAX_BODY_CHARS} chars` };
  const link = validateLink(body.link);
  if (link.error) return link;
  const metadata = validateMetadata(body.metadata);
  if (metadata.error) return metadata;
  return { value: { key, kind, subject, text, link: link.value, metadata: metadata.value, observedAt: observedAtFrom(body.observedAt) } };
}

// Admin-relative only: a digest never deep-links off the portal, and a
// stored absolute URL would be a phishing seam in the bell.
function validateLink(raw) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'string') return { error: 'link must be a string' };
  const link = raw.trim();
  if (!/^\/admin(\/|\?|#|$)/.test(link) || link.length > MAX_LINK_CHARS) return { error: 'link must be an /admin path' };
  return { value: link };
}

// Keys the seam owns. A caller must not pre-resolve a finding (it would
// render as cleared), re-key it, or spoof its source; the route sets these
// after the caller's fields and the fall-off path is the only writer of
// the resolved* stamps.
const RESERVED_METADATA_KEYS = ['opsKey', 'subject', 'kind', 'source', 'dedupeKey', 'dedupeVersion', 'resolved', 'resolvedAt', 'resolvedBy', 'observedAt'];

// Observation time of a finding / clean run: the caller's ISO timestamp when
// valid and not in the future, else now. Ordering resolves against ingests
// (resolveOpsDigest notAfter) — a later failure must outlive an earlier
// clean run even when their requests arrive out of order.
function observedAtFrom(raw, now = Date.now()) {
  const t = typeof raw === 'string' ? Date.parse(raw) : NaN;
  if (!Number.isFinite(t) || t > now + 60 * 1000) return new Date(now).toISOString();
  return new Date(t).toISOString();
}

function validateMetadata(raw) {
  if (raw === undefined || raw === null) return { value: {} };
  if (!isPlainObject(raw)) return { error: 'metadata must be an object' };
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_METADATA_BYTES) return { error: `metadata exceeds ${MAX_METADATA_BYTES} bytes` };
  const value = { ...raw };
  for (const k of RESERVED_METADATA_KEYS) delete value[k];
  return { value };
}

router.post('/', darkUnlessConfigured, ingestAuth, async (req, res) => {
  // Read at CALL time (both gates), same as the in-process senders: with
  // the lane off the caller keeps emailing — nothing is dropped silently.
  if (!inAppEnabled()) return res.status(409).json({ ok: false, reason: 'in_app_disabled' });
  const { error, value } = validateDigest(req.body);
  if (error) return res.status(400).json({ ok: false, reason: 'invalid_payload', error });

  const { key, kind, subject, text, link, metadata, observedAt } = value;
  const title = `${kind}: ${subject}`;
  const dedupeKey = `${SOURCE}:${key}`;
  let row = null;
  try {
    // ONE transaction under the dedupe's advisory lock — the same lock
    // /resolve takes, and the one notifyAdmin takes on the caller's trx
    // (pg advisory xact locks are re-entrant in a transaction). Taking it
    // FIRST lets the standing observation be read before notifyAdmin's
    // merge can overwrite it, and keeps a resolve from observing any
    // in-between state.
    row = await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`admin:${dedupeKey}`]);
      // MONOTONIC observation, decided BEFORE the write. notifyAdmin's
      // refresh merge takes the incoming metadata verbatim (pinned by
      // notification-dedupe-refresh-semantics.test.js), so a delayed
      // re-post from an EARLIER run would otherwise lower observedAt below
      // a recurrence that already raised it — and a clean run landing in
      // between would retire a live finding. Clamping AFTER the write
      // cannot help: read-your-own-write makes it compare the value
      // against itself (pre-push P1 ×3). The standing probe mirrors
      // notification-service's own dedupe probe so it reads the row that
      // call will find.
      const standing = await standingObservation(trx, dedupeKey);
      const effectiveObservedAt = laterOf(standing, observedAt);
      // dedupeVersion = the EFFECTIVE observation: an older re-post leaves
      // it unchanged (plain dedupe, no rewrite), a later run's recurrence
      // changes it and so rewrites the standing row and re-bells it.
      return NotificationService.notifyAdmin(CATEGORY, title, text, {
        link,
        bell: true,
        dedupeKey,
        dedupeWindowMs: DEDUPE_WINDOW_MS,
        refreshOnDedupe: true,
        dedupeVersion: effectiveObservedAt,
        metadata: { ...metadata, opsKey: key, subject: title, kind, source: SOURCE, observedAt: effectiveObservedAt },
        trx,
      });
    });
  } catch (err) {
    logger.error(`[ops-digest-ingest] ${key}: bell write threw: ${err.message}`);
  }
  // null = insert failed; a suppression sentinel = no row either way. Both
  // mean "not in the bell" — say so, and the caller's email fallback runs.
  if (!row || row.suppressed || !row.id) {
    logger.warn(`[ops-digest-ingest] ${key}: bell row not written`);
    return res.status(503).json({ ok: false, reason: 'bell_write_failed' });
  }
  logger.info(`[ops-digest-ingest] ${key}: recorded ${row.id}${row.deduped ? ' (deduped)' : ''}`);
  return res.status(201).json({ ok: true, id: row.id, deduped: row.deduped === true });
});

// Fall-off rule (owner 2026-09-11): after N consecutive clean runs of the
// check behind a finding (the runner counts — see ops-crons runner.js),
// the standing bell rows for that key are retired: marked read + stamped
// resolved, kept as history. Idempotent; a key with nothing standing is a
// 200 with resolved: 0. Only rows this seam wrote (source = ops-crons) are
// touched — the in-process senders keep their own keys.
router.post('/resolve', darkUnlessConfigured, ingestAuth, async (req, res) => {
  const body = isPlainObject(req.body) ? req.body : {};
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!KEY_RE.test(key)) return res.status(400).json({ ok: false, reason: 'invalid_payload', error: 'key: 1-120 chars of letters, digits, . _ : -' });
  const successes = Number.isInteger(body.successes) && body.successes > 0 ? body.successes : null;
  // lockKey = the dedupeKey the ingest writes for this key, so resolve and a
  // concurrent recurrence serialize under one advisory lock; notAfter = the
  // clean run's observation time, so only findings observed at or before it
  // retire (a newer failure that landed first survives).
  const notAfter = observedAtFrom(body.observedAt);
  const resolved = await resolveOpsDigest({ key, source: SOURCE, lockKey: `${SOURCE}:${key}`, notAfter, resolvedBy: successes ? `${SOURCE}:${successes}-clean-runs` : SOURCE });
  logger.info(`[ops-digest-ingest] ${key}: resolve → ${resolved} row(s)`);
  return res.status(200).json({ ok: true, resolved });
});

// Parser failures after auth: plain JSON, never the HTML default. Only
// reachable once ingestAuth passed (the chain below), so a 400/413 here
// never leaks to an unauthenticated caller.
function ingestBodyErrorHandler(err, req, res, next) {
  if (err && err.type === 'entity.too.large') return res.status(413).json({ ok: false, reason: 'payload_too_large' });
  if (err && err.status === 400) return res.status(400).json({ ok: false, reason: 'invalid_json' });
  return next(err);
}

// Mounted by server/index.js on /api/ops/digest AHEAD of the global body
// parsers (the /api/mcp mcpPreParsers pattern): dark 404 → own limiter →
// bearer auth → small capped JSON parse → JSON body errors, privacy headers
// stamped first. So while the
// token is unset nothing but the generic 404 is observable, and with it set
// an unauthenticated caller gets 401 before any body is parsed (codex P0 r2
// on #4392). The router repeats the dark check + auth as its own first
// layers so it stays fail-closed even if mounted without the chain; the
// limiter lives ONLY here so a request is counted once.
const ingestPreParsers = [noStore, darkUnlessConfigured, ingestLimiter, ingestAuth, express.json({ limit: '1mb' }), ingestBodyErrorHandler];

module.exports = router;
module.exports.ingestPreParsers = ingestPreParsers;
module.exports._private = { validateDigest, ingestAuth, darkUnlessConfigured, ingestBodyErrorHandler, genericNotFound, observedAtFrom, standingObservation, laterOf, KINDS, RESERVED_METADATA_KEYS };
