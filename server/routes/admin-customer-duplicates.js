/**
 * Admin review queue for duplicate customers (customer-dedupe.js).
 *
 * GET  /            — duplicate groups with tier + evidence (read-only)
 * POST /merge       — merge loser into winner (yellow-tier one-click; the
 *                     executor still refuses both-have-Stripe conflicts)
 * POST /link-as-property — merge, then preserve the loser's address as an
 *                     additional property on the winner (multi-property case)
 * POST /dismiss     — record a "not a duplicate" verdict for a pair
 *
 * Merge is destructive-adjacent (soft-delete + FK repoint, journaled), so the
 * whole router requires full admin, not tech.
 */
const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { findDuplicateGroups, executeMerge } = require('../services/customer-dedupe');

const router = express.Router();
router.use(adminAuthenticate, requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function performedBy(req) {
  const tech = req.technician || {};
  return `admin:${tech.name || tech.email || req.technicianId || 'unknown'}`;
}

router.get('/', async (req, res) => {
  try {
    const groups = await findDuplicateGroups();
    res.json({
      groups: groups.map((g) => ({
        phone10: g.phone10,
        winner: g.winner,
        candidates: g.candidates.map((c) => ({
          customer: c.loser,
          tier: c.tier,
          reasons: c.reasons,
          evidence: c.evidence,
        })),
      })),
    });
  } catch (err) {
    logger.error(`[admin-customer-duplicates] list failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load duplicate groups' });
  }
});

async function handleMerge(req, res, { linkAsProperty }) {
  const { winnerId, loserId } = req.body || {};
  if (!UUID_RE.test(String(winnerId)) || !UUID_RE.test(String(loserId))) {
    return res.status(400).json({ error: 'winnerId and loserId must be customer UUIDs' });
  }
  try {
    // Server-side eligibility recheck: the UI hides merge on red pairs, but a
    // stale or tampered request must not merge a red pair — or two unrelated
    // customers. The pair must still be in the live duplicate queue, under
    // this exact winner, and not tiered red.
    const groups = await findDuplicateGroups();
    const group = groups.find((g) => g.winner.id === winnerId);
    const candidate = group?.candidates.find((c) => c.loser.id === loserId);
    if (!candidate) {
      return res.status(409).json({ error: 'Pair is no longer in the duplicate queue — refresh and retry' });
    }
    if (candidate.tier === 'red') {
      return res.status(409).json({ error: 'This pair looks like two different people and cannot be merged from the queue' });
    }
    const result = await executeMerge({
      winnerId,
      loserId,
      mode: 'manual',
      performedBy: performedBy(req),
      evidence: { via: linkAsProperty ? 'admin_link_as_property' : 'admin_review_queue' },
    });
    let propertyLinked = false;
    if (linkAsProperty && result.loserSnapshot?.address_line1) {
      // Post-commit on purpose: an aborted merge must not leave a property row.
      // recordCallProperty computes the canonical address_key and dedupes.
      try {
        const { recordCallProperty } = require('../services/customer-properties');
        await recordCallProperty({
          customerId: winnerId,
          address_line1: result.loserSnapshot.address_line1,
          address_line2: result.loserSnapshot.address_line2,
          city: result.loserSnapshot.city,
          state: result.loserSnapshot.state,
          zip: result.loserSnapshot.zip,
          label: 'From merged duplicate',
          source: 'manual',
        });
        propertyLinked = true;
      } catch (propErr) {
        // The merge itself committed — report the partial outcome honestly.
        logger.error(`[admin-customer-duplicates] merge ok but link-as-property failed: ${propErr.message}`);
      }
    }
    res.json({ ok: true, journalId: result.journalId, repointed: result.repointed, backfills: result.backfills, propertyLinked });
  } catch (err) {
    logger.error(`[admin-customer-duplicates] merge failed: ${err.message}`);
    // "refresh the queue" covers the executor's under-lock rechecks (phone no
    // longer shared, pair now red) — stale-queue races are conflicts, not 500s.
    const conflict = /Stripe profiles|not found|deleted customer|refresh the queue/.test(err.message);
    res.status(conflict ? 409 : 500).json({ error: err.message });
  }
}

router.post('/merge', (req, res) => handleMerge(req, res, { linkAsProperty: false }));
router.post('/link-as-property', (req, res) => handleMerge(req, res, { linkAsProperty: true }));

router.post('/dismiss', async (req, res) => {
  const { customerIdA, customerIdB, reason } = req.body || {};
  if (!UUID_RE.test(String(customerIdA)) || !UUID_RE.test(String(customerIdB)) || customerIdA === customerIdB) {
    return res.status(400).json({ error: 'customerIdA and customerIdB must be distinct customer UUIDs' });
  }
  const [a, b] = customerIdA < customerIdB ? [customerIdA, customerIdB] : [customerIdB, customerIdA];
  try {
    await db('customer_duplicate_dismissals')
      .insert({
        customer_id_a: a,
        customer_id_b: b,
        reason: reason ? String(reason).slice(0, 500) : null,
        created_by: performedBy(req),
      })
      .onConflict(['customer_id_a', 'customer_id_b'])
      .ignore();
    res.json({ ok: true });
  } catch (err) {
    logger.error(`[admin-customer-duplicates] dismiss failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to record dismissal' });
  }
});

module.exports = router;
