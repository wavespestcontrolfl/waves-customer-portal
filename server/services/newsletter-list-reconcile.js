/**
 * Newsletter list reconciliation — filtered customer import with a dry run.
 * Supersedes the old POST /subscribers/import-customers (every live customer
 * with an email, leads included, ignoring marketing consent/suppressions).
 * CANDIDATE: a live customer — the canonical whereLiveCustomer/CUSTOMER_STAGES
 * rule from customer-stages.js (active, not deleted, pipeline_stage IN
 * active_customer/won/at_risk; a NULL pipeline_stage is NOT a candidate) —
 * with a non-empty, minimally-valid email ("@" present, matching
 * subscribeOrResubscribe's own strict:false floor) and no ACTIVE subscriber
 * row (by customer_id or LOWER(TRIM(email)) on both sides — a padded legacy
 * row must still block a new one). Every exclusion is checked in ONE
 * fixed priority order —
 * an existing subscriber-state row always outranks a preference/suppression
 * check, so a both-unsubscribed-AND-opted-out customer counts once, under the higher reason:
 *   1. existing non-active row: unsubscribed / pending / inactive+waitlist
 *   2. an active suppression, global or group 'marketing_newsletter'
 *      (activeSuppressionsFor is the single source of truth here)
 *   3. notification_prefs.email_enabled === false -> email_switch_off
 *   4. marketing_offers === false (an EXPLICIT opt-out) -> marketing_opted_out
 *   5. the resolved marketing_channel is 'sms' (channelFor — the SAME
 *      resolution email-division/eligibility.js uses) -> marketing_sms_only
 *   6. otherwise -> importable
 *
 * CONSENT BASIS (owner-approved plan, ~/email-division-final-plan-20260927.md
 * rows 2 and 11 — cited in full in this PR's body): this import's authority
 * to subscribe someone is "add the active customers who are not subscribed,
 * tagged customer_import, [with] double opt-in skipped for imported
 * customers" — an OPT-OUT gate, never an opt-in requirement. marketing_offers
 * is therefore read ONLY for an explicit `false`; a missing row, a NULL, or a
 * legacy-migration-defaulted `true` (20260401000104_notification_prefs_enhanced.js's
 * column default, backfilled by 20260504000009_backfill_customer_default_rows.js
 * without overriding it) is "no opt-out on file", not fabricated consent, and
 * does NOT exclude — the plan's own authority to import is what makes that
 * true, not the column's value. Do not read this as a general precedent:
 * every OTHER email-division sender still requires marketing_offers === true
 * (an opt-IN) via the canonical eligibility pipeline; this import alone is
 * the plan's one-time, owner-approved exception.
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
 * picker for customer_id, on the SAME connection — same as every other
 * trusted caller.
 *
 * The consent decision and the insert are NOT two separate operations: each
 * import runs in its own transaction (importOneCustomer) that takes the
 * shared `customer-comms` lock (customer-comms-lock.js, the SAME lock
 * notification_prefs's own writer takes) and the shared per-email lock (the
 * SAME lock email-suppression writers take) before re-classifying — so a
 * concurrent opt-out or suppression fully serializes behind this decision,
 * never slips in between it and the write. The orphan-link UPDATE also
 * never attaches a second active subscriber to one customer (a NOT EXISTS
 * guard mirrors the candidate query's own one-active-subscription rule).
 */

const db = require('../models/db');
const logger = require('./logger');
const { cityToZone } = require('./event-freshness');
const { activeSuppressionsFor } = require('./email-template-library');
const { linkToCustomer } = require('./newsletter-subscribers');
const { CUSTOMER_STAGES } = require('./customer-stages');
const { lockCustomerComms, lockCustomerEmail } = require('../utils/customer-comms-lock');
// The SAME channel-resolution rule the email-division sender pipeline
// uses (server/services/email-division/eligibility.js) — never a
// re-derived copy: a missing row / null / unrecognised value reads as the
// column's schema default ('email' for marketing_channel); only a
// RESOLVED 'sms' means "email is unwanted".
const { channelFor } = require('./email-division/eligibility');

// A minimal address shape — the same floor subscribeOrResubscribe's own
// strict:false path enforces ("@" present). SQL-side so a malformed address
// is never even a candidate; also used JS-side for the invalid-email count.
const HAS_AT = (alias) => `${alias}.email LIKE '%@%'`;

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
       AND ${HAS_AT('c')}
       AND NOT EXISTS (
             SELECT 1 FROM newsletter_subscribers ns
              WHERE (ns.customer_id = c.id OR LOWER(TRIM(ns.email)) = LOWER(TRIM(c.email)))
                AND ns.status = 'active'
           )
  `, [CUSTOMER_STAGES]);
  return result.rows || [];
}

// Counts otherwise-eligible live customers a malformed (non-empty, no "@")
// email keeps out of fetchCandidateRows above — same predicate, flipped
// email check — so the response can report WHY they never became
// candidates instead of silently dropping them.
async function countInvalidEmailCandidates(conn) {
  const result = await conn.raw(`
    SELECT count(*) AS n
      FROM customers c
     WHERE c.deleted_at IS NULL
       AND c.active = true
       AND ${candidateStageSql('c')}
       AND c.email IS NOT NULL
       AND TRIM(c.email) <> ''
       AND NOT ${HAS_AT('c')}
       AND NOT EXISTS (
             SELECT 1 FROM newsletter_subscribers ns
              WHERE (ns.customer_id = c.id OR LOWER(TRIM(ns.email)) = LOWER(TRIM(c.email)))
                AND ns.status = 'active'
           )
  `, [CUSTOMER_STAGES]);
  return Number(result.rows?.[0]?.n || 0);
}

// Re-verifies ONE customer is STILL a live candidate (same predicate as
// fetchCandidateRows) and returns its CURRENT email/name/city — closes the
// gap where an archive, pipeline-stage change, or email edit mid-batch would
// otherwise leave a stale row importable.
//
// FOR SHARE holds the customers row through classification, the insert, and
// the link — not just this one read: it's a real Postgres row lock, taken
// inside importOneCustomer's transaction, so it stays held until that
// transaction commits or rolls back. That serializes against any writer
// that takes FOR UPDATE on the SAME row before committing an email/archive/
// stage change — customer-email-write.js's `customers row FOR UPDATE` is
// exactly that writer — so it can never commit mid-import and leave a
// stale address active underneath us.
async function fetchLiveCandidateNow(conn, customerId) {
  const result = await conn.raw(
    `SELECT c.id AS customer_id, c.email, c.first_name, c.last_name, c.city
       FROM customers c
      WHERE c.id = ?
        AND c.deleted_at IS NULL
        AND c.active = true
        AND ${candidateStageSql('c')}
        AND c.email IS NOT NULL
        AND TRIM(c.email) <> ''
        AND ${HAS_AT('c')}
        FOR SHARE`,
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
      WHERE customer_id = ? OR LOWER(TRIM(email)) = LOWER(TRIM(?))
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
  // OPT-OUT gate, never an opt-in requirement (see the module header's
  // "CONSENT BASIS" — owner-approved plan rows 2 & 11, cited in the PR
  // body): only an EXPLICIT false excludes. A missing row, a NULL, or a
  // legacy-migration-defaulted true is "no opt-out on file", not consent —
  // this import's authority to subscribe someone comes from the plan, not
  // from this column reading true.
  if (prefs && prefs.marketing_offers === false) return 'marketing_opted_out';
  // The SAME channel-resolution rule email-division/eligibility.js uses
  // (channelFor): a missing row / null / unrecognised value reads as the
  // schema default ('email'); only a RESOLVED 'sms' means email is unwanted.
  if (channelFor(prefs, 'marketing_channel') === 'sms') return 'marketing_sms_only';

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
        AND NOT EXISTS (
              -- never a second active subscriber for one customer — the
              -- candidate query enforces this same one-active-subscription
              -- rule by customer_id, and the orphan path must match it.
              SELECT 1 FROM newsletter_subscribers ns2
               WHERE ns2.customer_id = twin.id AND ns2.status = 'active'
            )
      RETURNING ns.id`,
    [link.email, CUSTOMER_STAGES, link.subscriberId, link.email, link.email, CUSTOMER_STAGES],
  );
  return (result.rows || []).length > 0;
}

// Imports ONE customer in its own transaction, with the consent decision
// and the insert serialized under the same locking protocol the app's other
// comms/suppression writers use — never a separate read then a trusted
// write. `notification_prefs`'s own writer (routes/notifications.js PUT
// /preferences) takes lockCustomerComms before its update; email
// suppression writers (e.g. webhooks-sendgrid.js) take lockCustomerEmail
// before their insert — taking BOTH here means a concurrent opt-out OR a
// concurrent suppression fully serializes behind this decision (whichever
// commits first is the one that's honoured; there is no window between
// them). Returns one of:
//   { outcome: 'imported' }
//   { outcome: 'excluded', reason }   — a real classifyCustomer reason
//   { outcome: 'row_appeared' }       — the INSERT's own ON CONFLICT fired,
//                                       or the fresh reload found an ALREADY
//                                       active row (the same "someone else
//                                       already claimed this address" story)
//   { outcome: 'no_longer_live' }     — archived/re-staged out since the read
async function importOneCustomer(conn, row) {
  return conn.transaction(async (trx) => {
    await lockCustomerComms(trx, row.customer_id);

    // Re-check immediately before writing, INSIDE the lock: reload the
    // customer (an archive, pipeline-stage change, or email edit mid-batch
    // drops it) and re-classify consent/suppression on the FRESH row.
    const fresh = await fetchLiveCandidateNow(trx, row.customer_id);
    if (!fresh) return { outcome: 'no_longer_live' };

    await lockCustomerEmail(trx, fresh.email);
    // FOR SHARE the customer's own prefs row so this decision is fenced
    // against the SAME row the PUT /preferences writer takes FOR UPDATE
    // under the comms lock above — the two can never interleave.
    await trx('notification_prefs').where({ customer_id: row.customer_id }).forShare();

    const reason = await classifyCustomer(trx, fresh);
    if (reason === 'already_active') return { outcome: 'row_appeared' };
    if (reason) return { outcome: 'excluded', reason };

    const lc = fresh.email.trim().toLowerCase();
    // INSERT-only: no UPDATE branch exists for this statement to take, so
    // a row that appeared for this email in the instant between the
    // recheck above and this write is left completely untouched — the
    // conflict just yields zero returned rows.
    const inserted = await trx('newsletter_subscribers')
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
    if (!inserted.length) return { outcome: 'row_appeared' };

    await linkToCustomer(lc, trx); // canonical picker, same connection — never crosses a database boundary
    const zone = cityToZone(fresh.city);
    if (zone) {
      await trx('newsletter_subscribers')
        .where({ id: inserted[0].id })
        .whereNull('region_zone')
        .update({ region_zone: zone });
    }
    return { outcome: 'imported' };
  });
}

/**
 * Reconcile the newsletter list against live customers. Read-only unless
 * `dryRun === false` — the route is responsible for requiring an explicit
 * confirmation before ever passing that. `conn` runs every read on a
 * connection of the caller's choosing (default the shared db pool); each
 * write-mode import runs in its OWN transaction opened on that SAME `conn`
 * (a nested transaction/savepoint when `conn` is already one), so the
 * consent decision, the insert, and the customer link never cross a
 * connection or database boundary the caller didn't choose.
 */
async function reconcileCustomers({ dryRun = true, conn = db } = {}) {
  const write = dryRun === false;
  const excluded = {
    previously_unsubscribed: 0, pending_confirmation: 0, inactive_subscriber: 0,
    suppressed: 0, marketing_opted_out: 0, marketing_sms_only: 0, email_switch_off: 0,
    row_appeared: 0, no_longer_live: 0, invalid_email: 0,
  };
  const errors = [];

  const candidateRows = await fetchCandidateRows(conn);
  excluded.invalid_email = await countInvalidEmailCandidates(conn);
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
    // 'already_active' means a concurrent writer already made this address
    // active between the candidate fetch and this read — the SAME
    // "someone else already claimed it" story as a write-time row_appeared,
    // so it's counted there too rather than silently dropped (a customer
    // whose race lands during THIS read, not the write-time recheck, must
    // still show up in the total).
    if (reason === 'already_active') { excluded.row_appeared += 1; continue; }
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
      const result = await importOneCustomer(conn, row);
      if (result.outcome === 'imported') { imported += 1; return; }
      if (result.outcome === 'excluded') { excluded[result.reason] = (excluded[result.reason] || 0) + 1; return; }
      // 'row_appeared' and 'no_longer_live' each have their own bucket —
      // a rejected candidate always keeps its reason and is counted,
      // never silently dropped as importable-with-imported:0.
      excluded[result.outcome] += 1;
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
