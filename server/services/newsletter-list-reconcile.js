/**
 * Newsletter list reconciliation — filtered customer import with a dry run.
 * Supersedes the old POST /subscribers/import-customers (every live customer
 * with an email, leads included, ignoring marketing consent/suppressions).
 * CANDIDATE: a live customer (deleted_at IS NULL, active, not churned,
 * pipeline_stage active_customer/won — NULL counts as active_customer) with
 * a non-empty email and no ACTIVE subscriber row (by customer_id or
 * lower(email)). Every exclusion is checked in ONE fixed priority order —
 * an existing subscriber-state row always outranks a preference/suppression
 * check, so a both-unsubscribed-AND-marketing-off customer counts once, under the higher reason:
 *   1. existing non-active row: unsubscribed / pending / inactive+waitlist
 *   2. an active suppression, global or group 'marketing_newsletter'
 *      (activeSuppressionsFor is the single source of truth here)
 *   3. notification_prefs.email_enabled === false -> email_switch_off
 *   4. marketing_offers !== true (null/false/no row) -> marketing_flag_not_on
 *   5. otherwise -> importable
 * subscribeOrResubscribe runs only for a row just certified `importable`,
 * re-certified immediately before its write — so a customer who
 * unsubscribes/gets suppressed in between is skipped, never imported.
 */

const db = require('../models/db');
const logger = require('./logger');
const { cityToZone } = require('./event-freshness');
const { activeSuppressionsFor } = require('./email-template-library');
const { subscribeOrResubscribe } = require('./newsletter-subscribers');
const { CUSTOMER_STAGES } = require('./customer-stages');

// Narrower than the canonical whereLiveCustomer (customer-stages.js): this
// only ever ADDS candidates, so `at_risk` is left out, and a NULL
// pipeline_stage (pre backfill) counts as active_customer rather than being
// dropped the way whereLiveCustomer's whereIn would silently drop it.
async function fetchCandidateRows(conn) {
  const result = await conn.raw(`
    SELECT c.id AS customer_id, c.email, c.first_name, c.last_name, c.city
      FROM customers c
     WHERE c.deleted_at IS NULL
       AND c.active = true
       AND c.churned_at IS NULL
       AND (c.pipeline_stage IN ('active_customer', 'won') OR c.pipeline_stage IS NULL)
       AND c.email IS NOT NULL
       AND TRIM(c.email) <> ''
       AND NOT EXISTS (
             SELECT 1 FROM newsletter_subscribers ns
              WHERE (ns.customer_id = c.id OR LOWER(ns.email) = LOWER(TRIM(c.email)))
                AND ns.status = 'active'
           )
  `);
  return result.rows || [];
}

// Highest-priority existing subscriber row for this customer (same match
// rule as the candidate query). Ordered so a still-active row (a race with
// the candidate fetch, or the write-time recheck) always wins the read.
async function existingSubscriberStatus(conn, customerId, email) {
  const result = await conn.raw(
    `SELECT status FROM newsletter_subscribers
      WHERE customer_id = ? OR LOWER(email) = LOWER(TRIM(?))
      ORDER BY CASE status
                 WHEN 'active' THEN 0
                 WHEN 'unsubscribed' THEN 1
                 WHEN 'pending' THEN 2
                 WHEN 'inactive' THEN 3
                 WHEN 'waitlist' THEN 3
                 ELSE 4
               END
      LIMIT 1`,
    [customerId, email],
  );
  return result.rows?.[0]?.status || null;
}

// Classifies ONE candidate against the fixed priority order above. Returns
// an exclusion reason, 'already_active' (a race — no longer a candidate),
// or null (importable). Reused verbatim for the write-time recheck.
async function classifyCustomer(conn, row) {
  const status = await existingSubscriberStatus(conn, row.customer_id, row.email);
  if (status === 'active') return 'already_active';
  if (status === 'unsubscribed') return 'previously_unsubscribed';
  if (status === 'pending') return 'pending_confirmation';
  if (status === 'inactive' || status === 'waitlist') return 'inactive_subscriber';

  const suppressions = await activeSuppressionsFor(null, row.email, 'marketing_newsletter', conn);
  if (suppressions.length) return 'suppressed';

  const prefs = await conn('notification_prefs').where({ customer_id: row.customer_id }).first();
  if (prefs && prefs.email_enabled === false) return 'email_switch_off';
  if (!(prefs && prefs.marketing_offers === true)) return 'marketing_flag_not_on';

  return null;
}

// ACTIVE subscribers missing a region_zone, linked to a live customer
// (canonical whereLiveCustomer stages) whose city maps to a zone. Filtered
// to a mappable city here (SQL can't call cityToZone), so the count already
// equals the rows that WOULD be filled.
async function fetchZoneFillCandidates(conn) {
  const result = await conn.raw(
    `SELECT ns.id AS subscriber_id, c.city
       FROM newsletter_subscribers ns
       JOIN customers c ON c.id = ns.customer_id
      WHERE ns.status = 'active'
        AND (ns.region_zone IS NULL OR TRIM(ns.region_zone) = '')
        AND c.deleted_at IS NULL
        AND c.active = true
        AND c.pipeline_stage = ANY(?)`,
    [CUSTOMER_STAGES],
  );
  return (result.rows || [])
    .map((r) => ({ subscriberId: r.subscriber_id, zone: cityToZone(r.city) }))
    .filter((r) => r.zone);
}

// ACTIVE subscribers with no linked customer yet.
async function fetchOrphanSubscriberRows(conn) {
  const result = await conn.raw(
    `SELECT id, email FROM newsletter_subscribers WHERE status = 'active' AND customer_id IS NULL`,
  );
  return result.rows || [];
}

// Live customers whose email matches. The orphan link only ever applies
// when this resolves to EXACTLY one row — an ambiguous match is never guessed.
async function findLiveCustomersForEmail(conn, email) {
  const result = await conn.raw(
    `SELECT id FROM customers
      WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
        AND deleted_at IS NULL
        AND active = true
        AND pipeline_stage = ANY(?)`,
    [email, CUSTOMER_STAGES],
  );
  return result.rows || [];
}

/**
 * Reconcile the newsletter list against live customers. Read-only unless
 * `dryRun === false` — the route is responsible for requiring an explicit
 * confirmation before ever passing that. `conn` runs the READS on a
 * connection of the caller's choosing (default the shared db pool);
 * subscribeOrResubscribe always writes through the shared pool (no
 * connection override), so a write-mode call is never wrapped in an outer
 * transaction.
 */
async function reconcileCustomers({ dryRun = true, conn = db } = {}) {
  const write = dryRun === false;
  const excluded = {
    previously_unsubscribed: 0, pending_confirmation: 0, inactive_subscriber: 0,
    suppressed: 0, marketing_flag_not_on: 0, email_switch_off: 0,
  };
  const errors = [];

  const candidateRows = await fetchCandidateRows(conn);
  const importableRows = [];
  const cityCounts = new Map();

  for (const row of candidateRows) {
    let reason;
    try {
      reason = await classifyCustomer(conn, row);
    } catch (e) {
      errors.push({ customerId: row.customer_id, error: e.message });
      logger.error(`[newsletter-list-reconcile] classify customer id=${row.customer_id} failed: ${e.message}`);
      continue;
    }
    if (reason === 'already_active') continue; // no longer a candidate — a race with the fetch above
    if (reason) {
      excluded[reason] += 1;
      continue;
    }
    importableRows.push(row);
    const city = (row.city || '').trim() || 'Unknown';
    cityCounts.set(city, (cityCounts.get(city) || 0) + 1);
  }

  const byCity = Array.from(cityCounts.entries())
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));

  const zoneFillCandidates = await fetchZoneFillCandidates(conn);
  const orphanCandidateRows = await fetchOrphanSubscriberRows(conn);
  const orphanLinks = [];
  for (const orphan of orphanCandidateRows) {
    const matches = await findLiveCustomersForEmail(conn, orphan.email);
    if (matches.length === 1) orphanLinks.push({ subscriberId: orphan.id, customerId: matches[0].id });
  }

  // Runs `action` per item, catching so one failure never aborts the batch.
  // `idFor` returns an id-only descriptor for the error/log — never the
  // full row (an importable row carries email/first_name/last_name).
  async function guardedEach(items, idFor, action) {
    for (const item of items) {
      try { await action(item); } catch (e) {
        const id = idFor(item);
        errors.push({ ...id, error: e.message });
        logger.error(`[newsletter-list-reconcile] write failed for ${JSON.stringify(id)}: ${e.message}`);
      }
    }
  }

  let imported = 0;
  if (write) {
    await guardedEach(importableRows, (row) => ({ customerId: row.customer_id }), async (row) => {
      // Re-check immediately before writing: a customer who unsubscribes,
      // gets suppressed, or flips marketing_offers off between the read
      // and this write must be skipped, never imported.
      if (await classifyCustomer(conn, row)) return;

      const result = await subscribeOrResubscribe({
        email: row.email,
        firstName: row.first_name || null,
        lastName: row.last_name || null,
        source: 'customer_import',
        strict: false,
        requireConfirmation: false,
        linkCustomer: true,
      });
      if (!['created', 'resubscribed', 'confirmed'].includes(result.action)) return;
      imported += 1;
      const zone = cityToZone(row.city);
      if (zone && result.subscriber?.id) {
        await conn('newsletter_subscribers')
          .where({ id: result.subscriber.id })
          .whereNull('region_zone')
          .update({ region_zone: zone });
      }
    });

    await guardedEach(zoneFillCandidates, (fill) => ({ subscriberId: fill.subscriberId }), (fill) => conn('newsletter_subscribers')
      .where({ id: fill.subscriberId })
      .where((qb) => qb.whereNull('region_zone').orWhereRaw("TRIM(region_zone) = ''"))
      .update({ region_zone: fill.zone }));

    await guardedEach(orphanLinks, (link) => ({ subscriberId: link.subscriberId }), (link) => conn('newsletter_subscribers')
      .where({ id: link.subscriberId })
      .whereNull('customer_id')
      .update({ customer_id: link.customerId }));
  }

  return {
    dryRun: !write,
    candidates: candidateRows.length,
    importable: importableRows.length,
    imported,
    excluded,
    zoneFills: zoneFillCandidates.length,
    orphanLinks: orphanLinks.length,
    byCity,
    errors,
  };
}

module.exports = { reconcileCustomers };
