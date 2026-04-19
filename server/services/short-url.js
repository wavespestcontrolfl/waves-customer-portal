/**
 * Self-hosted URL shortener. Issues branded `portal.wavespestcontrol.com/l/k3j9`
 * links that customers see in SMS / email / PDF surfaces and that redirect to
 * the real long URL via GET /l/:code in routes/public-shortlinks.js.
 *
 * Why not Twilio Link Shortening? It's SMS-only (leaves email/PDF uncovered),
 * uses `twil.io` by default which looks like phishing coming from a pest co,
 * and sends click data into a 3rd-party webhook instead of our own DB.
 *
 * Why not Bitly/Rebrandly? Monthly cost + external dep for something that's
 * one table + one redirect route.
 */

const db = require('../models/db');
const crypto = require('crypto');
const logger = require('./logger');

// Lowercase alphanum, no ambiguous chars (0/o/1/l/i) — the code shows up in
// SMS and occasionally gets read over the phone to support.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function generateCode(length = 5) {
  const bytes = crypto.randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

function baseUrl() {
  // Keep on-brand. If we later register a genuinely short domain (wvs.co etc),
  // swap one env var + DNS and every historical code keeps working.
  return process.env.SHORTLINK_BASE_URL
    || process.env.PUBLIC_PORTAL_URL
    || 'https://portal.wavespestcontrol.com';
}

/**
 * Create a short code for targetUrl. Returns { code, shortUrl }.
 *
 * opts: { kind, entityType, entityId, customerId, createdBy, expiresAt }
 * all optional except targetUrl.
 *
 * On insert collision (race on same code), retry up to 5× at length 5, then
 * bump to length 6. Unique index is the source of truth — generateCode alone
 * is not enough.
 */
async function createShortCode(targetUrl, opts = {}) {
  if (!targetUrl || typeof targetUrl !== 'string') {
    throw new Error('createShortCode: targetUrl required');
  }

  const row = {
    target_url: targetUrl,
    kind: opts.kind || 'other',
    entity_type: opts.entityType || null,
    entity_id: opts.entityId || null,
    customer_id: opts.customerId || null,
    created_by: opts.createdBy || null,
    expires_at: opts.expiresAt || null,
  };

  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    const length = attempt < 5 ? 5 : 6;
    const code = generateCode(length);
    try {
      const [inserted] = await db('short_codes')
        .insert({ ...row, code })
        .returning(['code']);
      return { code: inserted.code, shortUrl: `${baseUrl()}/l/${inserted.code}` };
    } catch (err) {
      // Postgres unique_violation on the unique index → retry with a new code.
      // Any other error bubbles up immediately.
      if (err && err.code === '23505' && /short_codes_code/.test(err.detail || err.message || '')) {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  logger.error(`[short-url] Exhausted retries on code collision: ${lastErr && lastErr.message}`);
  throw new Error('short-url: code-generation retries exhausted');
}

/**
 * Look up target_url for a code. Returns null if unknown or expired.
 * Increments click_count + updates last_click_* on hit. Safe to call per-request.
 */
async function resolveShortCode(code, { ip, userAgent } = {}) {
  if (!code || typeof code !== 'string') return null;
  const row = await db('short_codes').where({ code }).first();
  if (!row) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return null;

  // Fire-and-forget — redirect latency matters more than telemetry durability.
  db('short_codes').where({ id: row.id }).update({
    click_count: db.raw('click_count + 1'),
    last_clicked_at: new Date(),
    last_click_ip: ip ? ip.toString().slice(0, 64) : null,
    last_click_ua: userAgent ? userAgent.toString().slice(0, 500) : null,
    updated_at: new Date(),
  }).catch((err) => logger.error(`[short-url] click-log update failed: ${err.message}`));

  return row.target_url;
}

/**
 * Best-effort: given an already-computed long URL + an estimate context, hand
 * back a short URL. Falls back to the original URL on any error — we never
 * block a send on shortener failure.
 */
async function shortenOrPassthrough(longUrl, opts = {}) {
  try {
    const { shortUrl } = await createShortCode(longUrl, opts);
    return shortUrl;
  } catch (err) {
    logger.error(`[short-url] shorten failed, using long URL: ${err.message}`);
    return longUrl;
  }
}

module.exports = {
  createShortCode,
  resolveShortCode,
  shortenOrPassthrough,
};
