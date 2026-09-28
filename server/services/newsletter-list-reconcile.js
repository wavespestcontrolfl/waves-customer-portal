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
 * row must still block a new one).
 *
 * ELIGIBILITY IS PER ADDRESS, NOT PER PROFILE. Two profiles can share one
 * mailbox, and the subscriber row is one row per address, linked to
 * whichever profile linkToCustomer's canonical picker chooses — so every
 * check below runs across EVERY non-archived profile whose email
 * normalizes (LOWER(TRIM)) to the address, and an exclusion on ANY of them
 * excludes the address. Every exclusion is checked in ONE fixed priority
 * order — an existing subscriber-state row always outranks a
 * preference/suppression check, so a both-unsubscribed-AND-opted-out
 * address counts once, under the higher reason:
 *   1. an existing row for the address, or linked to any sharing profile:
 *      active (already claimed) / unsubscribed / pending / inactive+waitlist
 *   2. an active suppression, global or group 'marketing_newsletter'
 *      (activeSuppressionsFor is the single source of truth here)
 *   3. notification_prefs.email_enabled === false on any sharing profile
 *      -> email_switch_off
 *   4. marketing_offers === false (an EXPLICIT opt-out) on any sharing
 *      profile -> marketing_opted_out
 *   5. the resolved marketing_channel is 'sms' (channelFor — the SAME
 *      resolution email-division/eligibility.js uses) on any sharing
 *      profile -> marketing_sms_only
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
 * ONE decision path (withAddressDecision → decideAddress) serves both the
 * dry run's projection and the write: each runs in its own transaction
 * that takes the shared `customer-comms` lock (customer-comms-lock.js — the
 * SAME lock the notification-prefs writers take) for EVERY profile sharing
 * the address, the customer row FOR SHARE, every sharing profile's prefs
 * row FOR SHARE, and the shared per-address email lock (the SAME lock
 * email-suppression writers take) before classifying; the write inserts
 * inside that same transaction. So the preview can never promise what the
 * write refuses on unchanged data, and a concurrent opt-out, suppression,
 * or email change on any sharing profile serializes behind the decision
 * instead of slipping between it and the insert. The orphan link likewise
 * uses ONE predicate (orphanTargetSql) for the projection and the UPDATE,
 * under the target customer's comms lock.
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

const normalizeEmail = (email) => String(email || '').trim().toLowerCase();
const sortedUnique = (ids) => [...new Set(ids.map(String))].sort();

// Re-verifies ONE customer is STILL a live candidate (same predicate as
// fetchCandidateRows) and returns its CURRENT email/name/city — closes the
// gap where an archive, pipeline-stage change, or email edit mid-batch would
// otherwise leave a stale row importable.
//
// `forShare` holds the customers row through classification, the insert,
// and the link — a real Postgres row lock taken inside the decision's
// transaction, held until it commits or rolls back. That serializes
// against any writer that takes FOR UPDATE on the SAME row before
// committing an email/archive/stage change — customer-email-write.js's
// `customers row FOR UPDATE` is exactly that writer — so it can never
// commit mid-import and leave a stale address active underneath us.
async function fetchLiveCandidate(conn, customerId, { forShare = false } = {}) {
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
        ${forShare ? 'FOR SHARE' : ''}`,
    [customerId, CUSTOMER_STAGES],
  );
  return result.rows?.[0] || null;
}

// EVERY profile whose customers.email is this normalized address — any
// stage, any `active` flag, only archived (deleted_at) rows left out: the
// SAME population linkToCustomer's canonical picker (liveTwinSubselect,
// newsletter-subscribers.js) chooses the subscriber's customer_id from, so
// no profile the new row can end up attached to is ever left unchecked.
async function profilesSharingAddress(conn, email) {
  const result = await conn.raw(
    `SELECT c.id AS profile_id
       FROM customers c
      WHERE LOWER(TRIM(c.email)) = ?
        AND c.deleted_at IS NULL`,
    [normalizeEmail(email)],
  );
  return (result.rows || []).map((r) => r.profile_id);
}

// Highest-priority existing subscriber row for this ADDRESS: any row whose
// email normalizes to it, or that is linked to ANY profile sharing it.
// Ordered so a still-active row always wins the read.
async function existingAddressStatus(conn, profileIds, email) {
  const result = await conn.raw(
    `SELECT status FROM newsletter_subscribers
      WHERE customer_id = ANY(?::uuid[]) OR LOWER(TRIM(email)) = ?
      ORDER BY CASE status
                 WHEN 'active' THEN 0
                 WHEN 'unsubscribed' THEN 1
                 WHEN 'pending' THEN 2
                 WHEN 'inactive' THEN 3
                 WHEN 'waitlist' THEN 3
                 ELSE 4
               END
      LIMIT 1`,
    [profileIds, normalizeEmail(email)],
  );
  return result.rows?.[0]?.status || null;
}

// Classifies ONE ADDRESS (never one profile) against the fixed priority
// order in the module header. `profileIds` is every profile sharing the
// address (profilesSharingAddress): an opt-out, email switch-off, or
// SMS-only channel on ANY of them excludes the address — the mailbox is
// one inbox, whichever profile the subscriber row ends up linked to.
// Returns an exclusion reason, 'already_active', or null (importable).
async function classifyAddress(conn, { email, profileIds }) {
  const status = await existingAddressStatus(conn, profileIds, email);
  if (status === 'active') return 'already_active';
  if (status === 'unsubscribed') return 'previously_unsubscribed';
  if (status === 'pending') return 'pending_confirmation';
  if (status === 'inactive' || status === 'waitlist') return 'inactive_subscriber';

  const suppressions = await activeSuppressionsFor(null, email, 'marketing_newsletter', conn);
  if (suppressions.length) return 'suppressed';

  const prefsRows = await conn('notification_prefs').whereIn('customer_id', profileIds);
  if (prefsRows.some((p) => p.email_enabled === false)) return 'email_switch_off';
  // OPT-OUT gate, never an opt-in requirement (see the module header's
  // "CONSENT BASIS" — owner-approved plan rows 2 & 11, cited in the PR
  // body): only an EXPLICIT false excludes. A missing row, a NULL, or a
  // legacy-migration-defaulted true is "no opt-out on file", not consent —
  // this import's authority to subscribe someone comes from the plan, not
  // from this column reading true.
  if (prefsRows.some((p) => p.marketing_offers === false)) return 'marketing_opted_out';
  // The SAME channel-resolution rule email-division/eligibility.js uses
  // (channelFor): a missing row / null / unrecognised value reads as the
  // schema default ('email'); only a RESOLVED 'sms' means email is unwanted.
  if (prefsRows.some((p) => channelFor(p, 'marketing_channel') === 'sms')) return 'marketing_sms_only';

  return null;
}

// Thrown (and retried from a fresh transaction) when the address, or the
// set of profiles sharing it, moved after its comms locks were chosen — a
// comms lock can only be taken in sorted order BEFORE any row lock, so the
// only safe response to a new sharer is to roll back and start over.
class AddressMovedError extends Error {}
const MAX_DECISION_ATTEMPTS = 3;

// THE eligibility decision for one customer's CURRENT address — the single
// chokepoint the dry run's projection AND the write's insert both go
// through (withAddressDecision), so the preview can never promise what the
// write refuses. Must run inside a transaction. Lock order, matching every
// other writer of these rows (customer-comms-lock.js's contract;
// notifications.js / admin-customers.js prefs writers take the prefs row
// BEFORE an address key):
//   1. customer-comms advisory lock for EVERY profile sharing the address,
//      in sorted order (the notification-prefs writers take this same lock
//      before touching a profile's prefs row);
//   2. this customer's row FOR SHARE (fences customer-email-write.js);
//   3. every sharing profile's notification_prefs row FOR SHARE (fences a
//      prefs writer that updates the row, lock or no lock);
//   4. the per-address email key (fences suppression writers and an email
//      assignment that would add a new sharer);
//   5. re-resolve the sharing set — anyone new since step 1 retries.
async function decideAddress(trx, customerId) {
  const peek = await fetchLiveCandidate(trx, customerId);
  if (!peek) return { outcome: 'no_longer_live' };
  const lockedIds = sortedUnique([customerId, ...await profilesSharingAddress(trx, peek.email)]);
  for (const id of lockedIds) await lockCustomerComms(trx, id);

  const fresh = await fetchLiveCandidate(trx, customerId, { forShare: true });
  if (!fresh) return { outcome: 'no_longer_live' };
  if (normalizeEmail(fresh.email) !== normalizeEmail(peek.email)) throw new AddressMovedError('address changed');
  for (const id of lockedIds) await trx('notification_prefs').where({ customer_id: id }).forShare();
  await lockCustomerEmail(trx, fresh.email);

  const profileIds = sortedUnique([customerId, ...await profilesSharingAddress(trx, fresh.email)]);
  if (profileIds.some((id) => !lockedIds.includes(id))) throw new AddressMovedError('new profile shares the address');

  const reason = await classifyAddress(trx, { email: fresh.email, profileIds });
  if (reason === 'already_active') return { outcome: 'row_appeared' };
  if (reason) return { outcome: 'excluded', reason };
  return { outcome: 'importable', fresh };
}

// Opens a transaction on `conn` (a savepoint when `conn` is already one),
// makes the decision, and hands it to `then` INSIDE the same transaction —
// so everything `then` writes commits under the locks the decision took.
// Outcomes: { outcome: 'importable', fresh } | { outcome: 'excluded', reason }
//   | { outcome: 'row_appeared' } — an ACTIVE row already claims the address
//   | { outcome: 'no_longer_live' } — archived/re-staged out since the read
async function withAddressDecision(conn, customerId, then) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await conn.transaction(async (trx) => then(trx, await decideAddress(trx, customerId)));
    } catch (e) {
      if (!(e instanceof AddressMovedError) || attempt >= MAX_DECISION_ATTEMPTS) throw e;
    }
  }
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

// THE orphan-link predicate, as one SQL fragment the dry-run projection and
// the write's UPDATE both embed verbatim: the orphan is still an active,
// unlinked row; EXACTLY one live customer matches its address (an
// ambiguous match is never guessed); and that customer does not already own
// an active subscriber (the candidate query's one-active-subscription rule).
function orphanTargetSql(subscriberId) {
  return {
    sql: `SELECT twin.id
            FROM newsletter_subscribers orphan
            JOIN customers twin ON LOWER(TRIM(twin.email)) = LOWER(TRIM(orphan.email))
           WHERE orphan.id = ?
             AND orphan.status = 'active'
             AND orphan.customer_id IS NULL
             AND twin.deleted_at IS NULL AND twin.active = true AND twin.pipeline_stage = ANY(?)
             AND (
                   SELECT count(*) FROM customers c2
                    WHERE LOWER(TRIM(c2.email)) = LOWER(TRIM(orphan.email))
                      AND c2.deleted_at IS NULL AND c2.active = true AND c2.pipeline_stage = ANY(?)
                 ) = 1
             AND NOT EXISTS (
                   SELECT 1 FROM newsletter_subscribers ns2
                    WHERE ns2.customer_id = twin.id AND ns2.status = 'active'
                 )`,
    bindings: [subscriberId, CUSTOMER_STAGES, CUSTOMER_STAGES],
  };
}

async function orphanLinkTarget(conn, subscriberId) {
  const { sql, bindings } = orphanTargetSql(subscriberId);
  const result = await conn.raw(sql, bindings);
  const rows = result.rows || [];
  return rows.length === 1 ? rows[0].id : null;
}

// Links ONE orphan. Resolve → lock → re-check: the target's customer-comms
// lock (the same lock every import of that customer's address holds while
// it inserts and links) is taken BEFORE the one-active-subscription check
// that matters, and the UPDATE re-evaluates the WHOLE predicate in its own
// statement after the lock — so two reconciles linking different orphans
// to one customer serialize, and the second sees the first's committed
// link and refuses. Returns true only when a row was actually updated.
async function applyOrphanLink(conn, subscriberId) {
  return conn.transaction(async (trx) => {
    const target = await orphanLinkTarget(trx, subscriberId);
    if (!target) return false;
    await lockCustomerComms(trx, target);
    const { sql, bindings } = orphanTargetSql(subscriberId);
    const result = await trx.raw(
      `UPDATE newsletter_subscribers ns
          SET customer_id = t.id, updated_at = NOW()
         FROM (${sql}) t
        WHERE ns.id = ?
          AND t.id = ?
        RETURNING ns.id`,
      [...bindings, subscriberId, target],
    );
    return (result.rows || []).length > 0;
  });
}

// Imports ONE customer's address: the decision (withAddressDecision) and
// the insert + link commit in ONE transaction under the decision's locks —
// never a separate read then a trusted write. Returns the decision's own
// outcome, or { outcome: 'imported' }, or { outcome: 'row_appeared' } when
// the INSERT's own ON CONFLICT fired.
async function importOneCustomer(conn, customerId) {
  return withAddressDecision(conn, customerId, async (trx, decision) => {
    if (decision.outcome !== 'importable') return decision;
    const { fresh } = decision;
    const lc = normalizeEmail(fresh.email);
    // INSERT-only: no UPDATE branch exists for this statement to take, so
    // a row that appeared for this email in the instant between the
    // decision and this write is left completely untouched — the conflict
    // just yields zero returned rows.
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

    // Canonical picker, same connection. Its candidates are exactly
    // profilesSharingAddress's set — every one of them was checked and is
    // comms-locked by the decision above.
    await linkToCustomer(lc, trx);
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
 * connection of the caller's choosing (default the shared db pool); every
 * decision runs in its OWN transaction opened on that SAME `conn` (a nested
 * transaction/savepoint when `conn` is already one).
 *
 * The dry run and the write share ONE decision path: the projection below
 * calls withAddressDecision (the same locks, the same address-level
 * classification) that importOneCustomer calls before inserting, and the
 * orphan projection runs the same orphanTargetSql predicate the write's
 * UPDATE embeds. Within one run, one address is imported at most once and
 * one customer receives at most one orphan link — the projection counts
 * the same way (duplicate_address / a claimed twin) so its numbers match
 * what a confirmed run applies against unchanged data.
 */
async function reconcileCustomers({ dryRun = true, conn = db } = {}) {
  const write = dryRun === false;
  const excluded = {
    previously_unsubscribed: 0, pending_confirmation: 0, inactive_subscriber: 0,
    suppressed: 0, marketing_opted_out: 0, marketing_sms_only: 0, email_switch_off: 0,
    row_appeared: 0, no_longer_live: 0, invalid_email: 0, duplicate_address: 0,
  };
  const errors = [];

  const candidateRows = await fetchCandidateRows(conn);
  excluded.invalid_email = await countInvalidEmailCandidates(conn);
  const importableRows = [];
  const projectedAddresses = new Set();
  const cityCounts = new Map();

  for (const row of candidateRows) {
    let decision;
    try {
      decision = await withAddressDecision(conn, row.customer_id, async (_trx, d) => d);
    } catch (e) {
      errors.push({ customerId: row.customer_id, error: e.message });
      logger.error(`[newsletter-list-reconcile] classify customer id=${row.customer_id} failed: ${e.message}`);
      continue;
    }
    if (decision.outcome === 'excluded') { excluded[decision.reason] += 1; continue; }
    // 'row_appeared' (an active row already claims the address) and
    // 'no_longer_live' keep their own buckets — never silently dropped.
    if (decision.outcome !== 'importable') { excluded[decision.outcome] += 1; continue; }
    // Two candidate profiles sharing one address are ONE subscriber: the
    // first is projected, the rest counted here — exactly what the write
    // would do (its second insert would find the first's active row).
    const address = normalizeEmail(decision.fresh.email);
    if (projectedAddresses.has(address)) { excluded.duplicate_address += 1; continue; }
    projectedAddresses.add(address);
    importableRows.push(decision.fresh);
    const city = (decision.fresh.city || '').trim() || 'Unknown';
    cityCounts.set(city, (cityCounts.get(city) || 0) + 1);
  }

  const byCity = Array.from(cityCounts.entries())
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));

  const zoneFillCandidates = await fetchZoneFillCandidates(conn);
  const orphanCandidateRows = await fetchOrphanSubscriberRows(conn);
  const orphanLinks = [];
  const claimedTwins = new Set();
  for (const orphan of orphanCandidateRows) {
    const target = await orphanLinkTarget(conn, orphan.id);
    // A second orphan for a twin this run already links would be refused
    // by the write's own one-active-subscription check — never projected.
    if (!target || claimedTwins.has(String(target))) continue;
    claimedTwins.add(String(target));
    orphanLinks.push({ subscriberId: orphan.id, customerId: target });
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
      const result = await importOneCustomer(conn, row.customer_id);
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

    await guardedEach(orphanLinks, (link) => ({ subscriberId: link.subscriberId }), async (link) => {
      if (await applyOrphanLink(conn, link.subscriberId)) orphanLinksApplied += 1;
    });
  }

  return {
    dryRun: !write,
    candidates: candidateRows.length,
    importable: importableRows.length,
    imported,
    excluded,
    // Dry run reports the projection (what WOULD happen); write mode
    // reports what was ACTUALLY applied — a change landing between the two
    // can make these differ, never the rules themselves.
    zoneFills: write ? zoneFillsApplied : zoneFillCandidates.length,
    orphanLinks: write ? orphanLinksApplied : orphanLinks.length,
    byCity,
    errors,
  };
}

module.exports = { reconcileCustomers };
