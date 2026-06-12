/**
 * omega-indexer.js — force-indexing for THIRD-PARTY backlink pages.
 *
 * Omega Indexer (omegaindexer.com) is a paid drip-feed indexing service. Unlike
 * IndexNow — which only accepts URLs on a host WE control (key file at site root)
 * — Omega can push ANY URL into Google's crawl queue, which is exactly what we
 * need for directory/citation pages that host our backlink but live on a domain
 * we don't own. An unindexed linking page passes ~no equity, so once the verifier
 * confirms a placement is live AND dofollow, we submit it here.
 *
 * Idempotency is the caller's job: the verifier dedups via
 * quality_signals.omega_submitted so a URL is pushed at most once.
 *
 * Operator setup: set OMEGA_INDEXER_API_KEY on Railway (already present in prod).
 * Inert (no-op) when the key is absent, so non-prod never calls the paid API.
 */
const logger = require('../logger');

const OMEGA_ENDPOINT = 'https://www.omegaindexer.com/amember/dashboard/api';
const DRIP_FEED_DAYS = 2; // spread submissions to look organic

/**
 * Submit URLs to Omega Indexer under a named campaign.
 * @param {string} label - campaign label (we use the linking domain)
 * @param {string[]} urls - absolute URLs of the external pages hosting our link
 * @returns {Promise<{ok:boolean, status?:number, body?:string, error?:string, skipped?:boolean}>}
 */
async function submit(label, urls, { fetchFn = fetch } = {}) {
  const apiKey = process.env.OMEGA_INDEXER_API_KEY;
  const list = (urls || []).filter(Boolean);
  if (!apiKey) return { ok: false, skipped: true, error: 'OMEGA_INDEXER_API_KEY not set' };
  if (list.length === 0) return { ok: false, skipped: true, error: 'no urls' };

  try {
    const urlString = encodeURIComponent(list.join('|'));
    const campaignName = encodeURIComponent(`Waves Backlinks - ${label}`);
    const res = await fetchFn(OMEGA_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `apikey=${apiKey}&campaignname=${campaignName}&dripfeed=${DRIP_FEED_DAYS}&urls=${urlString}`,
    });
    const body = await res.text().catch(() => '');
    logger.info(`[omega-indexer] submitted ${list.length} url(s) for ${label}: ${String(body).slice(0, 200)}`);
    return { ok: !!res.ok, status: res.status, body };
  } catch (err) {
    logger.error(`[omega-indexer] failed for ${label}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = { submit, OMEGA_ENDPOINT };
