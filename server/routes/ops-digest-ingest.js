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
 *   404  token unset — the endpoint does not exist (this IS the kill switch)
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
const NotificationService = require('../services/notification-service');
const { safeEqual } = require('../middleware/hermes-auth');
const { unauthenticatedAuthLimitKey } = require('../middleware/rate-limit-key');
const { inAppEnabled, resolveOpsDigest, CATEGORY } = require('../services/ops-digest');

const router = express.Router();

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
  skip: () => process.env.NODE_ENV !== 'production',
});

function ingestAuth(req, res, next) {
  const expected = process.env.OPS_DIGEST_INGEST_TOKEN;
  if (!expected) return res.status(404).json({ ok: false, reason: 'not_configured' });
  const header = String(req.headers.authorization || '');
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!safeEqual(provided, expected)) return res.status(401).json({ ok: false, reason: 'invalid_token' });
  return next();
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
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
  return { value: { key, kind, subject, text, link: link.value, metadata: metadata.value } };
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

function validateMetadata(raw) {
  if (raw === undefined || raw === null) return { value: {} };
  if (!isPlainObject(raw)) return { error: 'metadata must be an object' };
  if (Buffer.byteLength(JSON.stringify(raw)) > MAX_METADATA_BYTES) return { error: `metadata exceeds ${MAX_METADATA_BYTES} bytes` };
  return { value: raw };
}

router.post('/', ingestLimiter, ingestAuth, async (req, res) => {
  // Read at CALL time (both gates), same as the in-process senders: with
  // the lane off the caller keeps emailing — nothing is dropped silently.
  if (!inAppEnabled()) return res.status(409).json({ ok: false, reason: 'in_app_disabled' });
  const { error, value } = validateDigest(req.body);
  if (error) return res.status(400).json({ ok: false, reason: 'invalid_payload', error });

  const { key, kind, subject, text, link, metadata } = value;
  const title = `${kind}: ${subject}`;
  let row = null;
  try {
    // Same row shape as services/ops-digest.js deliverOpsDigest (opsKey +
    // subject in metadata, bell:true past the bell policy — this row is the
    // only copy once the email is skipped), plus the rolling-day dedupe.
    row = await NotificationService.notifyAdmin(CATEGORY, title, text, {
      link,
      bell: true,
      dedupeKey: `${SOURCE}:${key}`,
      dedupeWindowMs: DEDUPE_WINDOW_MS,
      metadata: { ...metadata, opsKey: key, subject: title, kind, source: SOURCE },
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
router.post('/resolve', ingestLimiter, ingestAuth, async (req, res) => {
  const body = isPlainObject(req.body) ? req.body : {};
  const key = typeof body.key === 'string' ? body.key.trim() : '';
  if (!KEY_RE.test(key)) return res.status(400).json({ ok: false, reason: 'invalid_payload', error: 'key: 1-120 chars of letters, digits, . _ : -' });
  const successes = Number.isInteger(body.successes) && body.successes > 0 ? body.successes : null;
  const resolved = await resolveOpsDigest({ key, source: SOURCE, resolvedBy: successes ? `${SOURCE}:${successes}-clean-runs` : SOURCE });
  logger.info(`[ops-digest-ingest] ${key}: resolve → ${resolved} row(s)`);
  return res.status(200).json({ ok: true, resolved });
});

module.exports = router;
module.exports._private = { validateDigest, ingestAuth, KINDS };
