/**
 * Public credentials route — canonical FDACS / insurance / license numbers.
 *
 * Mounted at /api/public/credentials. Consumed by:
 *   - Astro content build (lib/credentials.ts fetches this at build time +
 *     caches in .astro/credentials.json as a fallback for portal outages)
 *   - Any future public surface that needs the credential list
 *
 * Only records with is_public=true + status=active + archived_at IS NULL
 * are returned. Ordered by sort_order so callers don't need to re-sort.
 *
 * Shape matches the spec §3 contract — new response fields should be
 * additive only so existing Astro / helper consumers don't break.
 */
const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');

const CACHE_TTL_SECONDS = 3600; // 1h matches the spec's "generated_at + cache_ttl"

function shape(row) {
  return {
    slug: row.slug,
    display_name: row.display_name,
    credential_type: row.credential_type,
    issuing_authority: row.issuing_authority,
    credential_number: row.credential_number,
    display_format_short: row.display_format_short,
    display_format_long: row.display_format_long,
    display_format_legal: row.display_format_legal,
    status: row.status,
    sort_order: row.sort_order,
  };
}

router.get('/', async (_req, res) => {
  try {
    const rows = await db('business_credentials')
      .where({ is_public: true, status: 'active' })
      .whereNull('archived_at')
      .orderBy('sort_order', 'asc')
      .orderBy('created_at', 'asc');
    res.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
    res.json({
      credentials: rows.map(shape),
      generated_at: new Date().toISOString(),
      cache_ttl_seconds: CACHE_TTL_SECONDS,
    });
  } catch (err) {
    logger.error(`[public-credentials] list failed: ${err.message}`);
    res.status(500).json({ error: 'failed to load credentials' });
  }
});

router.get('/:slug', async (req, res) => {
  try {
    const row = await db('business_credentials')
      .where({ slug: req.params.slug, is_public: true, status: 'active' })
      .whereNull('archived_at')
      .first();
    if (!row) return res.status(404).json({ error: 'credential not found' });
    res.set('Cache-Control', `public, max-age=${CACHE_TTL_SECONDS}`);
    res.json(shape(row));
  } catch (err) {
    logger.error(`[public-credentials] get failed: ${err.message}`);
    res.status(500).json({ error: 'failed to load credential' });
  }
});

module.exports = router;
