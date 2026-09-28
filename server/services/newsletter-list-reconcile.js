/**
 * Newsletter list reconciliation — filtered customer import with a dry run.
 * Supersedes the old POST /subscribers/import-customers (every live customer
 * with an email, leads included, ignoring marketing consent/suppressions).
 * CANDIDATE: a live customer — the canonical whereLiveCustomer/CUSTOMER_STAGES
 * rule from customer-stages.js (active, not deleted, pipeline_stage IN
 * active_customer/won/at_risk; a NULL pipeline_stage is NOT a candidate) —
 * with a non-empty email and no ACTIVE subscriber row (by customer_id or
 * lower(email)). Every exclusion is checked in ONE fixed priority order —
 * an existing subscriber-state row always outranks a preference/suppression
 * check, so a both-unsubscribed-AND-marketing-off customer counts once, under the higher reason:
 *   1. existing non-active row: unsubscribed / pending / inactive+waitlist
 *   2. an active suppression, global or group 'marketing_newsletter'
 *      (activeSuppressionsFor is the single source of truth here)
 *   3. notification_prefs.email_enabled === false -> email_switch_off
 *   4. marketing_offers !== true (null/false/no row) -> marketing_flag_not_on
 *   5. otherwise -> importable
 *
 * The write is a plain INSERT with `ON CONFLICT (email) DO NOTHING` (backed
 * by newsletter_subscribers.email's real UNIQUE constraint, from the
 * original 20260416000001 migration — `subscribeOrResubscribe`'s own insert
 * path relies on the same constraint's 23505 to detect a concurrent row).
 * There is no UPDATE branch in this statement, so it is IMPOSSIBLE for this
 * write to touch an existing row: a row that turned pending/unsubscribed/
 * suppressed a millisecond earlier is left byte-for-byte unchanged, and the
 * 0-rows-returned case is counted under `row_appeared` rather than treated
 * as success. `subscribeOrResubscribe` is deliberately NOT called here (it
 * can resubscribe an existing row) — the insert instead mirrors its own
 * insertNewSubscriber() column values for a trusted, already-confirmed
 * subscriber (status 'active', confirmed_at, source 'customer_import';
 * subscribed_at and unsubscribe_token take their column defaults, exactly as
 * insertNewSubscriber leaves them), then reuses the canonical linkToCustomer
 * picker for customer_id — same as every other trusted caller.
 */

const db = require('../models/db');
const logger = require('./logger');
const { cityToZone } = require('./event-freshness');
const { activeSuppressionsFor } = require('./email-template-library');
const { linkToCustomer } = require('./newsletter-subscribers');
const { CUSTOMER_STAGES } = require('./customer-stages');

// The ONE canonical candidate-stage predicate, named and reused verbatim by
// every query below that needs it, so they can never drift out of sync with
// each other. Derived directly from the canonical whereLiveCustomer /
// CUSTOMER_STAGES rule (customer-stages.js) — no hand-rolled stage list, no
// NULL-pipeline-stage special case: the SAME "is this a real, live
// customer" definition the rest of the app uses (owner ruling 2026-09-28 —
// the build's earlier narrower definition, active_customer/won only with
// NULL counted in, was a build choice, not a ruling).
const candidateStageSql = (alias) => `${alias}.pipeline_stage = ANY(?)`;

async function fetchCandidateRows(conn) {
  const result = await conn.raw(`
    SELECT c.id AS customer_id, c.email, c.first_name, c.last_name, c.city
      FROM customers c
     WHERE c.deleted_at IS NULL
       AND c.active = true
       AND ${candidateStageSql('c')}
       AND c.email IS NOT NULL
       AND TRIM(c.email) <> ''
       AND NOT EXISTS (
             SELECT 1 FROM newsletter_subscribers ns
              WHERE (ns.customer_id = c.id OR LOWER(ns.email) = LOWER(TRIM(c.email)))
                AND ns.status = 'active'
           )
  `, [CUSTOMER_STAGES]);
  return result.rows || [];
}

// Re-verifies ONE customer is STILL a live candidate (same predicate as
// fetchCandidateRows) and returns its CURRENT email/name/city — closes the
// gap where an archive, pipeline-stage change, or email edit mid-batch would
// otherwise leave a stale row importable.
async function fetchLiveCandidateNow(conn, customerId) {
  const result = await conn.raw(
    `SELECT c.id AS customer_id, c.email, c.first_name, c.last_name, c.city
       FROM customers c
      WHERE c.id = ?
        AND c.deleted_at IS NULL
        AND c.active = true
        AND ${candidateStageSql('c')}
        AND c.email IS NOT NULL
        AND TRIM(c.email) <> ''`,
    [customerId, CUSTOMER_STAGES],
  );
  return result.rows?.[0] || null;
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

// Links ONE orphan subscriber to its live twin in a SINGLE statement — the
// exactly-one-match check and the write are the same atomic UPDATE, not a
// separate read followed by a write, so there is no window between "we
// looked" and "we wrote" for a second live customer (or an email change on
// either side) to land in. Returns true only when a row was actually
// updated (the report below distinguishes "matched at read time" from
// "actually linked").
async function applyOrphanLink(conn, link) {
  const result = await conn.raw(
    `UPDATE newsletter_subscribers ns
        SET customer_id = twin.id, updated_at = NOW()
       FROM (
             SELECT id FROM customers
              WHERE LOWER(TRIM(email)) = LOWER(TRIM(?))
                AND deleted_at IS NULL AND active = true AND pipeline_stage = ANY(?)
              LIMIT 1
           ) twin
      WHERE ns.id = ?
        AND ns.email = ?
        AND ns.status = 'active'
        AND ns.customer_id IS NULL
        AND (
              SELECT count(*) FROM customers c2
               WHERE LOWER(TRIM(c2.email)) = LOWER(TRIM(?))
                 AND c2.deleted_at IS NULL AND c2.active = true AND c2.pipeline_stage = ANY(?)
            ) = 1
      RETURNING ns.id`,
    [link.email, CUSTOMER_STAGES, link.subscriberId, link.email, link.email, CUSTOMER_STAGES],
  );
  return (result.rows || []).length > 0;
}

/**
 * Reconcile the newsletter list against live customers. Read-only unless
 * `dryRun === false` — the route is responsible for requiring an explicit
 * confirmation before ever passing that. `conn` runs the READS AND the
 * INSERT-only import write on a connection of the caller's choosing
 * (default the shared db pool); `linkToCustomer` always writes through the
 * shared pool (no connection override, same as every other trusted caller),
 * so a write-mode call is never fully wrapped in one outer transaction.
 */
async function reconcileCustomers({ dryRun = true, conn = db } = {}) {
  const write = dryRun === false;
  const excluded = {
    previously_unsubscribed: 0, pending_confirmation: 0, inactive_subscriber: 0,
    suppressed: 0, marketing_flag_not_on: 0, email_switch_off: 0, row_appeared: 0,
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
    if (matches.length === 1) orphanLinks.push({ subscriberId: orphan.id, email: orphan.email, customerId: matches[0].id });
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
  let zoneFillsApplied = 0;
  let orphanLinksApplied = 0;
  if (write) {
    await guardedEach(importableRows, (row) => ({ customerId: row.customer_id }), async (row) => {
      // Re-check immediately before writing: reload the customer (an
      // archive, pipeline-stage change, or email edit mid-batch drops it)
      // and re-classify consent/suppression on the FRESH row — a customer
      // who unsubscribes, gets suppressed, or flips marketing_offers off
      // in between must be skipped, never imported.
      const fresh = await fetchLiveCandidateNow(conn, row.customer_id);
      if (!fresh || await classifyCustomer(conn, fresh)) return;

      const lc = fresh.email.trim().toLowerCase();
      // INSERT-only: no UPDATE branch exists for this statement to take, so
      // a row that appeared for this email in the instant between the
      // recheck above and this write is left completely untouched — the
      // conflict just yields zero returned rows.
      const inserted = await conn('newsletter_subscribers')
        .insert({
          email: lc,
          first_name: fresh.first_name || null,
          last_name: fresh.last_name || null,
          source: 'customer_import',
          status: 'active',
          confirmed_at: new Date(),
        })
        .onConflict('email')
        .ignore()
        .returning('id');
      if (!inserted.length) {
        excluded.row_appeared += 1;
        return;
      }

      imported += 1;
      await linkToCustomer(lc); // canonical picker — same as every other trusted caller
      const zone = cityToZone(fresh.city);
      if (zone) {
        await conn('newsletter_subscribers')
          .where({ id: inserted[0].id })
          .whereNull('region_zone')
          .update({ region_zone: zone });
      }
    });

    await guardedEach(zoneFillCandidates, (fill) => ({ subscriberId: fill.subscriberId }), async (fill) => {
      const updated = await conn('newsletter_subscribers')
        .where({ id: fill.subscriberId, status: 'active' })
        .where((qb) => qb.whereNull('region_zone').orWhereRaw("TRIM(region_zone) = ''"))
        .update({ region_zone: fill.zone });
      if (updated) zoneFillsApplied += 1;
    });

    // applyOrphanLink is ONE atomic statement — the exactly-one-match check
    // and the write happen together, so there is no separate read to trust.
    await guardedEach(orphanLinks, (link) => ({ subscriberId: link.subscriberId }), async (link) => {
      if (await applyOrphanLink(conn, link)) orphanLinksApplied += 1;
    });
  }

  return {
    dryRun: !write,
    candidates: candidateRows.length,
    importable: importableRows.length,
    imported,
    excluded,
    // Dry run reports the read-phase candidate/match count (what WOULD
    // happen); write mode reports what was ACTUALLY applied — a race can
    // make these differ even within one call.
    zoneFills: write ? zoneFillsApplied : zoneFillCandidates.length,
    orphanLinks: write ? orphanLinksApplied : orphanLinks.length,
    byCity,
    errors,
  };
}

module.exports = { reconcileCustomers };
