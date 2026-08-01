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
  REVERT_FINANCIAL_TABLES, CONSENT_CRITICAL_TABLES,
  countActivityRows, activityColumnsFor,
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
      .leftJoin('customers as l', 'j.loser_customer_id', 'l.id')
      .select(
        'j.id', 'j.winner_customer_id', 'j.loser_customer_id', 'j.tier', 'j.performed_by',
        'j.created_at', 'j.undone_at', 'j.undone_by', 'j.loser_snapshot', 'j.repointed_ids',
        'j.evidence',
        'w.first_name as winner_first_name', 'w.last_name as winner_last_name',
        'w.active as winner_active', 'w.deleted_at as winner_deleted_at',
        // Compared server-side for the revertible flag ONLY — never emitted.
        'w.stripe_customer_id as winner_stripe_customer_id',
        // The LOSER's live state (revertMerge refuses a purged or
        // already-live row — the snapshot alone is not the live state).
        'l.id as loser_row_id', 'l.deleted_at as loser_row_deleted_at',
      )
      .orderBy('j.created_at', 'desc')
      .limit(20);
    const parse = (v) => {
      if (v === null || v === undefined) return null;
      if (typeof v === 'object') return v;
      try { return JSON.parse(v); } catch { return null; }
    };
    // Post-merge-cards mirror: revertMerge refuses when the transferred
    // Stripe id still sits on the winner but a NON-JOURNALED payment method
    // has joined it since the merge. That check needs the winner's CURRENT
    // cards — fetched here as ONE batched query for the listed page (route
    // contract: never offer an undo the endpoint would 409). If the lookup
    // fails, affected rows read non-revertible — fail closed, same as the
    // revert endpoint's posture on unverifiable financial state.
    const stripeReturnRows = rows.filter((row) => {
      if (row.undone_at) return false;
      const recorded = parse(row.repointed_ids);
      return Boolean(recorded?.stripe_transferred_id)
        && row.winner_stripe_customer_id === recorded.stripe_transferred_id;
    });
    const pmByWinner = new Map();
    let pmLookupFailed = false;
    if (stripeReturnRows.length) {
      try {
        const pmRows = await db('payment_methods')
          .whereIn('customer_id', [...new Set(stripeReturnRows.map((r) => r.winner_customer_id))])
          .select('id', 'customer_id', 'stripe_customer_id');
        for (const pm of pmRows) {
          if (!pmByWinner.has(pm.customer_id)) pmByWinner.set(pm.customer_id, []);
          pmByWinner.get(pm.customer_id).push(pm);
        }
      } catch (pmErr) {
        pmLookupFailed = true;
        logger.warn(`[admin-customer-duplicates] payment_methods lookup for revertible flags failed (marking affected merges non-revertible): ${pmErr.message}`);
      }
    }
    // Post-merge-visit mirror for link-as-property merges: revertMerge
    // refuses when a WINNER-owned visit outside the journaled repoint set
    // still references the linked property (transferring the property would
    // strand the appointment). One batched probe for the page; a failed
    // lookup marks affected rows non-revertible (fail closed).
    const linkedPropRows = rows.filter((row) => {
      if (row.undone_at) return false;
      const recorded = parse(row.repointed_ids);
      return Boolean(recorded?.linked_property_id);
    });
    const visitsByProperty = new Map();
    let visitLookupFailed = false;
    if (linkedPropRows.length) {
      try {
        const visitRows = await db('scheduled_services')
          .whereIn('property_id', [...new Set(linkedPropRows.map((r) => parse(r.repointed_ids).linked_property_id))])
          .select('id', 'customer_id', 'property_id');
        for (const visit of visitRows) {
          if (!visitsByProperty.has(visit.property_id)) visitsByProperty.set(visit.property_id, []);
          visitsByProperty.get(visit.property_id).push(visit);
        }
      } catch (visitErr) {
        visitLookupFailed = true;
        logger.warn(`[admin-customer-duplicates] scheduled_services lookup for revertible flags failed (marking affected merges non-revertible): ${visitErr.message}`);
      }
    }
    // Batched ACTIVITY mirrors (r16) for the refusals that key on journaled
    // INVOICE ids — the one activity family the page can probe in a fixed
    // number of queries regardless of merge count:
    //   1. a journaled invoice TOUCHED since the merge (revertMerge's
    //      verification-pass updated_at check on financial rows);
    //   2. invoice children — payments (invoice linkage lives in metadata
    //      jsonb: invoice_id / dispute_invoice_id / waves_invoice_id, the
    //      same resolution invoice.js uses), customer_credit_ledger,
    //      payment_plans and invoice_followup_sequences (real invoice_id
    //      columns) — recorded against a journaled invoice from OUTSIDE
    //      the journal (revertMerge's pre-write invoiceChildProbes).
    // Counting goes through the exported countActivityRows so the predicate
    // can never drift from the endpoint's own. Failed lookups mark affected
    // merges non-revertible (fail closed, same posture as the card/visit
    // mirrors above).
    const journaledIdsOf = (recorded, table) => {
      const set = new Set();
      for (const [key, ids] of Object.entries(recorded?.tables || {})) {
        if (key.startsWith(`${table}.`) && Array.isArray(ids)) {
          for (const id of ids) set.add(id);
        }
      }
      return set;
    };
    const invoiceBearingRows = rows.filter((row) => !row.undone_at
      && journaledIdsOf(parse(row.repointed_ids), 'invoices').size > 0);
    const allJournaledInvoiceIds = [...new Set(
      invoiceBearingRows.flatMap((row) => [...journaledIdsOf(parse(row.repointed_ids), 'invoices')]),
    )];
    const invoiceRowById = new Map();
    const invoiceChildrenByTable = new Map(); // table -> [{ invoiceIds: [..], row }]
    let invoiceActivityLookupFailed = false;
    if (allJournaledInvoiceIds.length) {
      try {
        const invRows = await db('invoices')
          .whereIn('id', allJournaledInvoiceIds)
          .select(['id', ...activityColumnsFor('invoices')]);
        for (const inv of invRows) invoiceRowById.set(inv.id, inv);
        const paymentRows = await db('payments')
          .whereRaw(
            "(metadata::jsonb ->> 'invoice_id' = ANY(?) OR metadata::jsonb ->> 'dispute_invoice_id' = ANY(?) OR metadata::jsonb ->> 'waves_invoice_id' = ANY(?))",
            [allJournaledInvoiceIds, allJournaledInvoiceIds, allJournaledInvoiceIds],
          )
          .select([
            'id', ...activityColumnsFor('payments'),
            db.raw("metadata::jsonb ->> 'invoice_id' as linked_invoice_id"),
            db.raw("metadata::jsonb ->> 'dispute_invoice_id' as linked_dispute_invoice_id"),
            db.raw("metadata::jsonb ->> 'waves_invoice_id' as linked_waves_invoice_id"),
          ]);
        invoiceChildrenByTable.set('payments', paymentRows.map((p) => ({
          invoiceIds: [p.linked_invoice_id, p.linked_dispute_invoice_id, p.linked_waves_invoice_id].filter(Boolean),
          row: p,
        })));
        for (const childTable of ['customer_credit_ledger', 'payment_plans', 'invoice_followup_sequences']) {
          const childRows = await db(childTable)
            .whereIn('invoice_id', allJournaledInvoiceIds)
            .select(['id', 'invoice_id', ...activityColumnsFor(childTable)]);
          invoiceChildrenByTable.set(childTable, childRows.map((c) => ({
            invoiceIds: [c.invoice_id].filter(Boolean),
            row: c,
          })));
        }
      } catch (invErr) {
        invoiceActivityLookupFailed = true;
        logger.warn(`[admin-customer-duplicates] invoice-activity lookup for revertible flags failed (marking affected merges non-revertible): ${invErr.message}`);
      }
    }
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
        // Count-only journal records on tables the revert endpoint refuses
        // outright: financial (money ownership must revert exactly) and
        // consent-critical (recipient_optin — composite PK journals
        // count-only ALWAYS, and a skipped restoration widens texting
        // consent). Pure journal data, no live query.
        const countOnlyRefused = Boolean(recorded?.tables) && Object.entries(recorded.tables)
          .some(([key, ids]) => !Array.isArray(ids)
            && (REVERT_FINANCIAL_TABLES.has(key.slice(0, key.indexOf('.')))
              || CONSENT_CRITICAL_TABLES.has(key.slice(0, key.indexOf('.')))));
        // Transferred Stripe id no longer on the winner + moved saved cards:
        // revertMerge refuses (the repointed cards would reference a Stripe
        // profile the restored customer doesn't have).
        const stripeDriftStrandsCards = Boolean(recorded?.stripe_transferred_id)
          && row.winner_stripe_customer_id !== recorded.stripe_transferred_id
          && Boolean(recorded?.tables) && Object.entries(recorded.tables)
            .some(([key, ids]) => key.startsWith('payment_methods.')
              && (Array.isArray(ids) ? ids.length > 0 : true));
        // Winner/both-DERIVED Stripe profile plus journaled loser cards:
        // revertMerge refuses unconditionally (the returned cards would ride
        // a profile the restored customer doesn't own). Pure journal data —
        // no live query — and none of the other guards catch it, so without
        // this the UI offers an Undo that always 409s. A pre-upgrade journal
        // (no stripe_derived_from) with returned cards refuses there too.
        const journaledLoserCards = Boolean(recorded?.tables) && Object.entries(recorded.tables)
          .some(([key, ids]) => key.startsWith('payment_methods.') && Array.isArray(ids) && ids.length > 0);
        const derivedFrom = recorded && Object.prototype.hasOwnProperty.call(recorded, 'stripe_derived_from')
          ? recorded.stripe_derived_from
          : undefined;
        const stripeDerivationRefuses = Boolean(recorded?.stripe_transferred_id)
          && row.winner_stripe_customer_id === recorded.stripe_transferred_id
          && journaledLoserCards
          && (derivedFrom === undefined || derivedFrom === 'winner' || derivedFrom === 'both');
        // The mirror image: transferred id still on the winner, but a card
        // NOT in the journaled repointed set is attached to it (saved after
        // the merge; NULL linkage counts — ambiguous fails closed) —
        // revertMerge refuses, so the row must not offer the undo.
        let postMergeCardsStrand = false;
        if (!row.undone_at && Boolean(recorded?.stripe_transferred_id)
          && row.winner_stripe_customer_id === recorded.stripe_transferred_id) {
          if (pmLookupFailed) {
            postMergeCardsStrand = true;
          } else {
            const journaledPmIds = new Set();
            for (const [key, ids] of Object.entries(recorded?.tables || {})) {
              if (key.startsWith('payment_methods.') && Array.isArray(ids)) {
                for (const id of ids) journaledPmIds.add(id);
              }
            }
            // Winner pre-merge cards are exempt (derived-profile case: they
            // legitimately sat on the transferred profile before the merge);
            // pre-upgrade journals lack the key → conservative refusal.
            const winnerPremergePmIds = new Set(
              Array.isArray(recorded.winner_premerge_pm_ids) ? recorded.winner_premerge_pm_ids : [],
            );
            postMergeCardsStrand = (pmByWinner.get(row.winner_customer_id) || [])
              .some((pm) => !journaledPmIds.has(pm.id)
                && !winnerPremergePmIds.has(pm.id)
                && (!pm.stripe_customer_id || pm.stripe_customer_id === recorded.stripe_transferred_id));
          }
        }
        // Winner-owned visit outside the journaled repoint set referencing
        // the linked property: revertMerge refuses (transfer would strand
        // the appointment on the wrong customer).
        let postMergeVisitStrand = false;
        if (!row.undone_at && recorded?.linked_property_id) {
          if (visitLookupFailed) {
            postMergeVisitStrand = true;
          } else {
            const journaledVisitIds = new Set();
            for (const [key, ids] of Object.entries(recorded?.tables || {})) {
              if (key.startsWith('scheduled_services.') && Array.isArray(ids)) {
                for (const id of ids) journaledVisitIds.add(id);
              }
            }
            // r8: strand-free = journaled AND currently winner-owned (the
            // undo moves it back to the loser) OR already loser-owned;
            // anything else — winner-owned unjournaled, or a journaled
            // visit drifted to a third customer — makes revertMerge refuse.
            postMergeVisitStrand = (visitsByProperty.get(recorded.linked_property_id) || [])
              .some((visit) => {
                const movesBack = journaledVisitIds.has(visit.id)
                  && visit.customer_id === row.winner_customer_id;
                const loserOwned = visit.customer_id === row.loser_customer_id;
                return !movesBack && !loserOwned;
              });
          }
        }
        // Invoice-keyed activity mirrors (r16, batched above): a journaled
        // invoice touched since the merge, or a payment child recorded
        // against one from outside the journal — revertMerge refuses both
        // in its pre-write pass, so the row must not offer the undo.
        let invoiceActivityRefuses = false;
        if (!row.undone_at) {
          const journaledInvoiceIds = journaledIdsOf(recorded, 'invoices');
          if (journaledInvoiceIds.size) {
            if (invoiceActivityLookupFailed) {
              invoiceActivityRefuses = true;
            } else {
              const mergeAt = row.created_at;
              // 1. Journaled-invoice updated_at (the verification pass's
              //    activity check on financial rows).
              const journaledInvoiceRows = [...journaledInvoiceIds]
                .map((id) => invoiceRowById.get(id))
                .filter(Boolean);
              invoiceActivityRefuses = countActivityRows(journaledInvoiceRows, {
                journaledIds: journaledInvoiceIds, mergeAt, table: 'invoices',
              }) > 0;
              // 2. Payment children outside the journal (invoiceChildProbes).
              if (!invoiceActivityRefuses) {
                for (const childTable of ['payments', 'customer_credit_ledger', 'payment_plans', 'invoice_followup_sequences']) {
                  const childRows = (invoiceChildrenByTable.get(childTable) || [])
                    .filter((c) => c.invoiceIds.some((id) => journaledInvoiceIds.has(id)))
                    .map((c) => c.row);
                  if (countActivityRows(childRows, {
                    journaledIds: journaledIdsOf(recorded, childTable), mergeAt, table: childTable,
                  }) > 0) {
                    invoiceActivityRefuses = true;
                    break;
                  }
                }
              }
            }
          }
        }
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
          // unrecorded linked property, stranded cards/visits, invoice
          // activity/children). The winner must be POSITIVELY live
          // (=== true): a purged winner row leaves the left-join columns
          // null, and null must read dead, not alive.
          //
          // MIRRORED activity refusals (batchable — a fixed number of
          // queries per page): journaled-invoice touched-since-merge and
          // invoice children (payments / credit-ledger entries / payment
          // plans / dunning follow-up sequences) outside the journal —
          // invoiceActivityRefuses above.
          // DOCUMENTED EXCEPTIONS to the never-offer-a-409 contract (each
          // needs per-merge live probes across many tables or the locked
          // winner/loser row state, too heavy for this list — the revert
          // endpoint 409s with a clear, actionable reason instead):
          // email/name-bound identity artifact probes (EMAIL_BOUND_SURFACES),
          // the billing-identity, address-clear and service-contact-clear
          // activity gates,
          // non-invoice journaled-row activity (estimates / visits /
          // contracts updated_at), children minted by journaled estimates /
          // visits / contracts, since-merge recipient_optin rows,
          // Stripe-profile transaction activity, the email-claim check, and
          // the cached-credit reconciliation refusals.
          revertible: Boolean(
            !row.undone_at
            && snapshot?.id
            && recorded?.tables
            && row.winner_active === true
            && !row.winner_deleted_at
            // The merged-away row must EXIST and still be merged-away:
            // a purged loser cannot be restored, and a live one has
            // nothing to undo (mirrors revertMerge's refusals).
            && Boolean(row.loser_row_id)
            && Boolean(row.loser_row_deleted_at)
            && !collisionHandled
            && !pmMovedWithoutFlags
            && !linkedPropertyUnrecorded
            && !countOnlyRefused
            && !stripeDriftStrandsCards
            && !stripeDerivationRefuses
            && !postMergeCardsStrand
            && !postMergeVisitStrand
            && !invoiceActivityRefuses,
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
