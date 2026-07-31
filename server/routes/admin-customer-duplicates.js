/**
 * Admin review queue for duplicate customers (customer-dedupe.js).
 *
 * GET  /            — duplicate groups with tier + evidence (read-only)
 * POST /merge       — merge loser into winner (yellow-tier one-click; the
 *                     executor still refuses both-have-Stripe conflicts)
 * POST /link-as-property — merge, then preserve the loser's address as an
 *                     additional property on the winner (multi-property case)
 * POST /dismiss     — record a "not a duplicate" verdict for a pair
 * GET  /merges      — recent merge-journal rows (winner/loser, revertibility)
 * POST /merges/:journalId/revert — journal-backed undo of a merge
 *
 * Merge is destructive-adjacent (soft-delete + FK repoint, journaled), so the
 * whole router requires full admin, not tech.
 */
const express = require('express');
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const {
  findDuplicateGroups, executeMerge, revertMerge, recordLinkedProperty,
} = require('../services/customer-dedupe');

const router = express.Router();
router.use(adminAuthenticate, requireAdmin);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function performedBy(req) {
  const tech = req.technician || {};
  return `admin:${tech.name || tech.email || req.technicianId || 'unknown'}`;
}

// ID-only identity for plaintext log lines (the full name/email identity
// above is journal/audit-column material, never log material).
function performedById(req) {
  return req.technicianId || (req.technician && req.technician.id) || null;
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
    // A positive address reason means the duplicate carries a DIFFERENT (or
    // incomparable) service address — a plain merge would retire its only
    // copy (the backfill never overwrites the winner's street). Force the
    // link-as-property path so the address survives as a property row.
    if (!linkAsProperty && candidate.reasons.some((r) => r.startsWith('address_'))) {
      return res.status(409).json({ error: "This duplicate has a different service address — use 'Merge + keep address' so the address isn't lost" });
    }
    const result = await executeMerge({
      winnerId,
      loserId,
      mode: 'manual',
      performedBy: performedBy(req),
      evidence: { via: linkAsProperty ? 'admin_link_as_property' : 'admin_review_queue' },
    });
    let propertyLinked = false;
    if (linkAsProperty) {
      // Post-commit on purpose: an aborted merge must not leave a property row.
      // recordCallProperty computes the canonical address_key and dedupes.
      let createdPropertyId = null;
      let propertyFlowFailed = false;
      if (result.loserSnapshot?.address_line1) {
        try {
          const { recordCallProperty } = require('../services/customer-properties');
          const { created, propertyId } = await recordCallProperty({
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
          if (created) createdPropertyId = propertyId;
        } catch (propErr) {
          // The merge itself committed — report the partial outcome honestly.
          propertyFlowFailed = true;
          logger.error(`[admin-customer-duplicates] merge ok but link-as-property failed: ${propErr.message}`);
        }
      }
      // The property row was created AFTER the merge transaction committed,
      // so the journal must learn about it or the undo would leave it
      // behind on the winner. One atomic jsonb_set; null records "nothing
      // created" (deduped / address-less loser). If the flow or this write
      // fails, the journal stays WITHOUT the linked_property_id key and the
      // revert endpoint refuses — non-revertible beats half-recorded.
      if (!propertyFlowFailed) {
        try {
          await recordLinkedProperty({ journalId: result.journalId, propertyId: createdPropertyId });
        } catch (journalErr) {
          logger.error(`[admin-customer-duplicates] merge ok but journal linked-property record failed — merge ${result.journalId} is not auto-revertible: ${journalErr.message}`);
        }
      }
    }
    res.json({ ok: true, journalId: result.journalId, repointed: result.repointed, backfills: result.backfills, propertyLinked });
  } catch (err) {
    logger.error(`[admin-customer-duplicates] merge failed: ${err.message}`);
    // "refresh the queue" covers the executor's under-lock rechecks (phone no
    // longer shared, pair now red) — stale-queue races are conflicts, not 500s.
    const conflict = /Stripe profile|third-party payers|billing modes|per-application fees|multi-property account|not found|deleted customer|refresh the queue/.test(err.message);
    res.status(conflict ? 409 : 500).json({ error: err.message });
  }
}

router.post('/merge', (req, res) => handleMerge(req, res, { linkAsProperty: false }));
router.post('/link-as-property', (req, res) => handleMerge(req, res, { linkAsProperty: true }));

// Recent merges for the review page's undo surface. Read-only, no gate —
// like the queue itself. Names come from the live winner row and the loser's
// journal snapshot (the loser row is retired).
router.get('/merges', async (req, res) => {
  try {
    const rows = await db('customer_merge_journal as j')
      .leftJoin('customers as w', 'j.winner_customer_id', 'w.id')
      .select(
        'j.id', 'j.winner_customer_id', 'j.loser_customer_id', 'j.tier', 'j.performed_by',
        'j.created_at', 'j.undone_at', 'j.undone_by', 'j.loser_snapshot', 'j.repointed_ids',
        'j.evidence',
        'w.first_name as winner_first_name', 'w.last_name as winner_last_name',
        'w.active as winner_active', 'w.deleted_at as winner_deleted_at',
        // Compared server-side for the revertible flag ONLY — never emitted.
        'w.stripe_customer_id as winner_stripe_customer_id',
      )
      .orderBy('j.created_at', 'desc')
      .limit(20);
    const parse = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'object') return v;
      try { return JSON.parse(v); } catch { return null; }
    };
    res.json({
      merges: rows.map((row) => {
        const snapshot = parse(row.loser_snapshot);
        const recorded = parse(row.repointed_ids);
        const evidence = parse(row.evidence);
        // Mirrors revertMerge's refusals so the UI never offers an undo the
        // endpoint would 409: collision-handled tables, payment methods
        // moved without flag records, and link-as-property merges whose
        // created property was never journaled.
        const collisionHandled = Boolean(recorded?.collision_handlers?.length);
        const pmMovedWithoutFlags = Boolean(recorded?.tables) && Object.entries(recorded.tables)
          .some(([key, ids]) => key.startsWith('payment_methods.') && Array.isArray(ids) && ids.length
            && (!recorded.payment_method_flags || ids.some((id) => !recorded.payment_method_flags[id])));
        const linkedPropertyUnrecorded = evidence?.via === 'admin_link_as_property'
          && !(recorded && 'linked_property_id' in recorded);
        // Transferred Stripe id no longer on the winner + moved saved cards:
        // revertMerge refuses (the repointed cards would reference a Stripe
        // profile the restored customer doesn't have).
        const stripeDriftStrandsCards = Boolean(recorded?.stripe_transferred_id)
          && row.winner_stripe_customer_id !== recorded.stripe_transferred_id
          && Boolean(recorded?.tables) && Object.entries(recorded.tables)
            .some(([key, ids]) => key.startsWith('payment_methods.')
              && (Array.isArray(ids) ? ids.length > 0 : true));
        return {
          journalId: row.id,
          winnerId: row.winner_customer_id,
          loserId: row.loser_customer_id,
          winnerName: [row.winner_first_name, row.winner_last_name].filter(Boolean).join(' ') || 'Unknown',
          loserName: [snapshot?.first_name, snapshot?.last_name].filter(Boolean).join(' ') || 'Unknown',
          tier: row.tier,
          performedBy: row.performed_by,
          createdAt: row.created_at,
          undoneAt: row.undone_at,
          undoneBy: row.undone_by,
          // Pre-upgrade merges (no row-level repoint record) are not
          // auto-revertible; neither is a merge whose winner is gone/retired,
          // nor one revertMerge would refuse (collisions, missing pm flags,
          // unrecorded linked property).
          revertible: Boolean(
            !row.undone_at
            && snapshot?.id
            && recorded?.tables
            && row.winner_active !== false
            && !row.winner_deleted_at
            && !collisionHandled
            && !pmMovedWithoutFlags
            && !linkedPropertyUnrecorded
            && !stripeDriftStrandsCards,
          ),
        };
      }),
    });
  } catch (err) {
    logger.error(`[admin-customer-duplicates] merges list failed: ${err.message}`);
    res.status(500).json({ error: 'Failed to load recent merges' });
  }
});

// Journal-backed undo. Owner-initiated, so it works regardless of the
// autonomy gates. Repoints OWNERSHIP rows only — never touches Stripe itself
// and never creates or modifies charges (revertMerge's contract).
router.post('/merges/:journalId/revert', async (req, res) => {
  if (!UUID_RE.test(String(req.params.journalId))) {
    return res.status(400).json({ error: 'journalId must be a journal UUID' });
  }
  try {
    const result = await revertMerge({
      journalId: req.params.journalId,
      performedBy: performedBy(req),
      performedById: performedById(req),
    });
    res.json({
      ok: true,
      winnerId: result.winnerId,
      loserId: result.loserId,
      repointedBack: result.repointedBack,
      skipped: result.skipped,
      stripeMovedBack: result.stripeMovedBack,
    });
  } catch (err) {
    logger.error(`[admin-customer-duplicates] revert failed: ${err.message}`);
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});

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
