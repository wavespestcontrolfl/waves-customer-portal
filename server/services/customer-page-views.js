/**
 * Customer page views — one shared, fire-and-forget recorder.
 *
 * recordPageView({ req, page, customerId, subjectType, subjectId }) writes a
 * customer_page_views row for a real customer open of a token page (later:
 * portal routes as `page: 'portal:<route>'`). Contract:
 *
 *   - Never throws and never delays the response: the insert is not awaited
 *     by callers and every failure (bad req, DB error) is logged and dropped.
 *   - Skips the same non-customer traffic the estimate page skips before it
 *     counts a view (routes/estimate-public.js shouldCountView): link
 *     unfurlers/scanners/CLI clients via the shared isBotUserAgent filter,
 *     staff browsers carrying the signed `waves_admin` marker cookie (set by
 *     admin-auth at login), and IPs in WAVES_ADMIN_IPS. No row for those.
 *   - Dedupes in the SAME statement: a view is skipped when the same
 *     page + subject + ip_hash already has a row inside the dedupe window
 *     (default DEDUPE_MINUTES; callers may pass `dedupeMinutes`). The track
 *     page polls its data endpoint every 30s while a tech is en route, so it
 *     passes a longer window (a whole tracking session is one view). The
 *     window is a fixed lookback from the latest ROW, not a sliding one: a
 *     page left open longer than the window writes one more row per window.
 *     The check lives in SQL (INSERT ... WHERE NOT EXISTS) so it holds across
 *     pods and deploys; two simultaneous first loads can both pass it (no
 *     unique constraint) — an accepted, rare double count.
 *
 * ip_hash is sha256 of the client IP, hex — identical to short_code_clicks.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const db = require('../models/db');
const config = require('../config');
const logger = require('./logger');
const { isBotUserAgent } = require('../utils/bot-ua');

const DEDUPE_MINUTES = 10;
const UA_MAX = 500;

// Mirrors estimate-public.js (private there, 28k-line file): comma list of
// staff IPs whose opens are never customer views.
function adminIps() {
  return (process.env.WAVES_ADMIN_IPS || '').split(',').map((s) => s.trim()).filter(Boolean);
}

function readCookie(req, name) {
  const header = req?.headers?.cookie;
  if (!header) return null;
  const target = `${name}=`;
  for (const part of String(header).split(';')) {
    const trimmed = part.trim();
    if (trimmed.startsWith(target)) {
      try { return decodeURIComponent(trimmed.slice(target.length)); } catch { return null; }
    }
  }
  return null;
}

function hasAdminMarker(req) {
  const token = readCookie(req, 'waves_admin');
  if (!token) return false;
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    return !!payload && payload.kind === 'admin_marker';
  } catch { return false; }
}

function userAgentOf(req) {
  if (typeof req?.get === 'function') return req.get('user-agent') || '';
  return req?.headers?.['user-agent'] || '';
}

function forwardedIp(req) {
  return String(req?.headers?.['x-forwarded-for'] || '').split(',')[0].trim().slice(0, 64);
}

function shouldRecord(req) {
  if (isBotUserAgent(userAgentOf(req))) return false;
  if (hasAdminMarker(req)) return false;
  const ips = adminIps();
  if (ips.length && (ips.includes(String(req.ip || '')) || ips.includes(forwardedIp(req)))) return false;
  return true;
}

function hashIp(ip) {
  return ip ? crypto.createHash('sha256').update(String(ip)).digest('hex') : null;
}

/**
 * Failure log line. Deliberately NEVER includes err.message: a Knex/pg error
 * message carries the SQL text and bound values, which for a token page can
 * include the bearer token (the secure-card lookup is keyed on it). Only the
 * page name, the subject type and the driver error code are logged.
 */
function logViewFailure(what, page, subjectType, err) {
  try {
    const code = err && (typeof err.code === 'string' || typeof err.code === 'number') ? String(err.code).slice(0, 32) : 'unknown';
    logger.warn(`[page-views] ${what} failed (page=${String(page || 'unknown').slice(0, 64)} subject=${String(subjectType || 'none').slice(0, 64)} code=${code})`);
  } catch { /* never throw */ }
}

/**
 * Returns a promise that always resolves (true = row written, false =
 * skipped or failed). Callers should NOT await it on the response path.
 */
function recordPageView({
  req, page, customerId = null, subjectType = null, subjectId = null, dedupeMinutes = DEDUPE_MINUTES,
} = {}) {
  try {
    if (!req || !page) return Promise.resolve(false);
    if (!shouldRecord(req)) return Promise.resolve(false);

    const ipHash = hashIp(req.ip);
    const ua = String(userAgentOf(req) || '').slice(0, UA_MAX) || null;
    const subjType = subjectType || null;
    const subjId = subjectId == null ? null : String(subjectId);
    const custId = customerId || null;
    const windowMinutes = Number.isInteger(dedupeMinutes) && dedupeMinutes > 0 ? dedupeMinutes : DEDUPE_MINUTES;

    return Promise.resolve(db.raw(
      `INSERT INTO customer_page_views (customer_id, page, subject_type, subject_id, ip_hash, user_agent)
       SELECT ?::uuid, ?::text, ?::text, ?::text, ?::text, ?::text
       WHERE NOT EXISTS (
         SELECT 1 FROM customer_page_views
         WHERE page = ?::text
           AND subject_type IS NOT DISTINCT FROM ?::text
           AND subject_id IS NOT DISTINCT FROM ?::text
           AND ip_hash IS NOT DISTINCT FROM ?::text
           AND viewed_at > now() - (?::int * interval '1 minute')
       )`,
      [custId, page, subjType, subjId, ipHash, ua, page, subjType, subjId, ipHash, windowMinutes],
    )).then((res) => !!(res && (res.rowCount === undefined || res.rowCount > 0)))
      .catch((err) => {
        logViewFailure('insert', page, subjType, err);
        return false;
      });
  } catch (err) {
    logViewFailure('record', page, subjectType, err);
    return Promise.resolve(false);
  }
}

module.exports = { recordPageView, logViewFailure, shouldRecord, hashIp, DEDUPE_MINUTES };
