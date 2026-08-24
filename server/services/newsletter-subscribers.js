/**
 * Shared subscriber helpers — single source of truth for the
 * lookup → resub-or-insert → customer-link flow that three call sites
 * (admin add, public signup, quote-wizard dual-write) used to duplicate
 * with subtly different validation. Audit §9.3.
 */

const db = require('../models/db');
const { REENGAGEMENT_TAG } = require('./newsletter-sunset');

// Canonical definition moved to the dependency-free util (pre-push P1 PR
// #3303 r20) so the attribution linkage mirror can share it; re-exported
// below so this module's contract is unchanged.
const { EMAIL_RE } = require('../utils/workable-lead-signal');

// Double-opt-in confirmation link lifetime. After this, the link no longer
// confirms (lookupByToken returns 'expired') — a months-old link in an inbox
// can't silently activate a subscription. Stale 'pending' rows are deleted by
// purgeStalePendingSubscribers() after a longer window so the table (and the
// email's eligibility for a fresh signup) doesn't accrue dead pending rows.
const CONFIRM_TTL_MS = 7 * 24 * 60 * 60 * 1000;       // 7 days — link still confirms
const PENDING_PURGE_MS = 30 * 24 * 60 * 60 * 1000;    // 30 days — then delete the row

/**
 * Subscribe (or resubscribe) an email. Idempotent across all call sites.
 *
 * Returns { subscriber, action } where action is one of:
 *   'created'             — new active row inserted (auto-confirmed path)
 *   'resubscribed'        — unsubscribed row flipped back to active
 *   'already_active'      — existing active row, no change
 *   'already_pending'     — existing pending row, no resend triggered
 *                           (caller passed requireConfirmation=false on
 *                           a row that's mid-DOI; we don't auto-promote)
 *   'confirmation_sent'   — new pending row inserted; caller must send
 *                           the confirmation email (the subscriber row
 *                           contains the freshly-issued confirmation_token)
 *   'confirmation_resent' — existing pending row's confirmation_sent_at
 *                           was bumped; caller resends the email with
 *                           the SAME token (the user may already have
 *                           the prior link)
 *   'confirmed'           — pending row was auto-confirmed without
 *                           sending an email (admin/quote bypass path)
 *
 * Validation tier:
 *   strict=true (default) — full email regex; throws if invalid
 *   strict=false          — minimal "@" check, used by the admin route
 *                           because admin-typed inputs are trusted and
 *                           the existing endpoint accepted
 *                           bare-domain values
 *
 * `linkCustomer` defaults true; pass false if the caller prefers to
 * batch the customer-link query for many emails (the bulk-import path).
 *
 * `requireConfirmation` (default false): when true, new and resubscribe
 * paths land at status='pending' and the caller is expected to send the
 * confirmation email keyed off subscriber.confirmation_token. When
 * false, paths land directly at status='active' (admin add only; public
 * website and quote-wizard signups must pass requireConfirmation=true).
 */
async function subscribeOrResubscribe({
  email,
  firstName = null,
  lastName = null,
  source = 'public_form',
  strict = true,
  linkCustomer = true,
  requireConfirmation = false,
} = {}) {
  if (!email) {
    const err = new Error('email required');
    err.code = 'EMAIL_REQUIRED';
    throw err;
  }
  const lc = String(email).trim().toLowerCase();

  if (strict) {
    if (!EMAIL_RE.test(lc)) {
      const err = new Error('valid email required');
      err.code = 'INVALID_EMAIL';
      throw err;
    }
  } else if (!lc.includes('@')) {
    const err = new Error('email required');
    err.code = 'INVALID_EMAIL';
    throw err;
  }

  const existing = await db('newsletter_subscribers').where({ email: lc }).first();

  if (existing) {
    // Pending → still mid-DOI. Resend the confirmation email if the
    // caller is requesting one (the user re-submitted the form because
    // they didn't see the original); auto-promote if the caller is
    // trusted (admin add) on a previously public-form-pending row.
    if (existing.status === 'pending') {
      if (requireConfirmation) {
        await db('newsletter_subscribers').where({ id: existing.id }).update({
          source,
          first_name: firstName !== null ? firstName : existing.first_name,
          last_name: lastName !== null ? lastName : existing.last_name,
          confirmation_sent_at: new Date(),
          updated_at: new Date(),
        });
        if (linkCustomer) await linkToCustomer(lc);
        const fresh = await db('newsletter_subscribers').where({ id: existing.id }).first();
        return { subscriber: fresh, action: 'confirmation_resent' };
      }
      // Trusted-context promotion: flip pending to active.
      await db('newsletter_subscribers').where({ id: existing.id }).update({
        status: 'active',
        confirmed_at: new Date(),
        updated_at: new Date(),
      });
      if (linkCustomer) await linkToCustomer(lc);
      const fresh = await db('newsletter_subscribers').where({ id: existing.id }).first();
      return { subscriber: fresh, action: 'confirmed' };
    }

    if (existing.status === 'unsubscribed' || existing.status === 'inactive') {
      // A sunset-suppressed row only comes back through a DELIBERATE act:
      // the subscriber's own double-opt-in (requireConfirmation callers) or
      // the win-back quiz confirm (newsletter-sunset.js). Trusted bulk flows
      // (customer import, quote wizard, call pipeline) pass
      // requireConfirmation:false and must NOT resurrect suppressed readers
      // wholesale — skip, leaving the row untouched.
      if (existing.status === 'inactive' && !requireConfirmation) {
        return { subscriber: existing, action: 'skipped_inactive' };
      }
      const updates = {
        source,
        first_name: firstName !== null ? firstName : existing.first_name,
        last_name: lastName !== null ? lastName : existing.last_name,
        resubscribed_at: new Date(),
        unsubscribed_at: null,
        updated_at: new Date(),
      };
      // Sunset hygiene markers (newsletter-sunset.js) are cleared on EVERY
      // comeback, not just when status is exactly 'inactive' — a sunset row
      // can move inactive → unsubscribed (old footer/List-Unsubscribe link)
      // before resubscribing, and stale markers would let the next sunset run
      // pair an old delivered win-back with the fresh subscription and
      // suppress it immediately instead of starting a clean episode. The
      // reengagement_due tag goes too: a flagged reader who unsubscribed
      // before sunset keeps it, and a stale tag would both target the fresh
      // subscription with the next win-back and block clean re-flagging.
      updates.deactivated_at = null;
      updates.deactivated_reason = null;
      updates.reengagement_flagged_at = null;
      updates.tags = db.raw("COALESCE(tags, '[]'::jsonb) - ?", [REENGAGEMENT_TAG]);
      if (requireConfirmation) {
        updates.status = 'pending';
        updates.confirmation_sent_at = new Date();
        updates.confirmation_token = db.raw('gen_random_uuid()');
        updates.confirmed_at = null;
      } else {
        updates.status = 'active';
        updates.confirmed_at = new Date();
      }
      await db('newsletter_subscribers').where({ id: existing.id }).update(updates);
      if (linkCustomer) await linkToCustomer(lc);
      const fresh = await db('newsletter_subscribers').where({ id: existing.id }).first();
      return {
        subscriber: fresh,
        action: requireConfirmation ? 'confirmation_sent' : 'resubscribed',
      };
    }

    // status === 'active' — already confirmed. No-op aside from the
    // customer-link refresh (in case the row predates the customer
    // signup and the link is newly possible).
    if (linkCustomer) await linkToCustomer(lc);
    const fresh = await db('newsletter_subscribers').where({ id: existing.id }).first();
    return { subscriber: fresh, action: 'already_active' };
  }

  // New row.
  const insertRow = {
    email: lc,
    first_name: firstName,
    last_name: lastName,
    source,
    status: requireConfirmation ? 'pending' : 'active',
  };
  if (requireConfirmation) {
    insertRow.confirmation_sent_at = new Date();
  } else {
    insertRow.confirmed_at = new Date();
  }
  const [row] = await db('newsletter_subscribers').insert(insertRow).returning('*');

  if (linkCustomer) await linkToCustomer(lc);
  // Re-read for the same reason — surfaces the freshly populated
  // customer_id without requiring callers to know the link runs.
  const fresh = await db('newsletter_subscribers').where({ id: row.id }).first();
  return {
    subscriber: fresh,
    action: requireConfirmation ? 'confirmation_sent' : 'created',
  };
}

/**
 * Read-only token lookup. Used by the GET confirm-page render path —
 * scanners and link previews would trip a state change if GET were
 * mutating, defeating double-opt-in. The actual flip lives in
 * confirmByToken (POST only).
 *
 * Returns { subscriber, action } where action is one of:
 *   'pending'        — row exists at status='pending', ready to confirm
 *   'already_active' — row was already active (idempotent re-visit)
 *   'unsubscribed'   — row is unsubscribed; nothing to do
 *   'not_found'      — token doesn't match any row
 */
async function lookupByToken(token) {
  if (!token) return { subscriber: null, action: 'not_found' };
  const sub = await db('newsletter_subscribers').where({ confirmation_token: token }).first();
  if (!sub) return { subscriber: null, action: 'not_found' };
  if (sub.status === 'active') return { subscriber: sub, action: 'already_active' };
  if (sub.status === 'unsubscribed') return { subscriber: sub, action: 'unsubscribed' };
  // pending — but reject an aged-out confirmation link (double-opt-in TTL) so a
  // months-old link can't silently activate the subscription. confirmByToken
  // returns this without flipping to active; the confirm page shows the
  // expired/invalid message.
  if (sub.confirmation_sent_at
      && (Date.now() - new Date(sub.confirmation_sent_at).getTime()) > CONFIRM_TTL_MS) {
    return { subscriber: sub, action: 'expired' };
  }
  return { subscriber: sub, action: 'pending' };
}

/**
 * Delete stale 'pending' subscribers whose confirmation link aged past the
 * purge window and never confirmed. Frees the email for a fresh signup and
 * keeps the table from accruing dead double-opt-in rows. Called from a daily
 * cron. Returns the number of rows removed.
 */
async function purgeStalePendingSubscribers() {
  const cutoff = new Date(Date.now() - PENDING_PURGE_MS);
  return db('newsletter_subscribers')
    .where({ status: 'pending' })
    .whereNotNull('confirmation_sent_at')
    .where('confirmation_sent_at', '<', cutoff)
    .del();
}

/**
 * Confirm a pending subscriber by token. Idempotent: confirming an
 * already-active row is a no-op (returns the existing subscriber);
 * confirming an unsubscribed row leaves status alone (the user already
 * opted out — confirming would be wrong).
 *
 * Mutates state — only invoke from a non-GET request handler. Email
 * link scanners and corporate-gateway preview fetchers blast every URL
 * in a message with GET; running this on GET would let them confirm
 * pending rows before the human recipient consents.
 *
 * Returns { subscriber, action } where action is one of:
 *   'confirmed'      — pending → active
 *   'already_active' — row was already active
 *   'unsubscribed'   — row is unsubscribed; nothing to do
 *   'not_found'      — token doesn't match any row
 */
async function confirmByToken(token) {
  const initial = await lookupByToken(token);
  if (initial.action !== 'pending') return initial;
  // status === 'pending' — flip to active. The flip is an atomic CAS on
  // the token AND the pending status (Codex #3084 r41): an email
  // correction can rotate this row's tokens between the lookup and this
  // write — the old link was DELIVERED to a rejected/typo mailbox, and an
  // id-only update would let that stale link activate the freshly
  // retargeted row (a third party confirming an address that isn't
  // theirs). Zero rows means the token no longer owns the row; re-run the
  // lookup so the caller sees the current truth (the stale link reads
  // 'not_found'; a concurrent same-token confirm reads 'already_active').
  const flipped = await db('newsletter_subscribers')
    .where({ id: initial.subscriber.id, confirmation_token: token, status: 'pending' })
    .update({
      status: 'active',
      confirmed_at: new Date(),
      updated_at: new Date(),
    });
  if (!flipped) return lookupByToken(token);
  await linkToCustomer(initial.subscriber.email);
  const fresh = await db('newsletter_subscribers').where({ id: initial.subscriber.id }).first();
  return { subscriber: fresh, action: 'confirmed' };
}

/**
 * THE twin picker — the single SQL that decides which customer profile a
 * subscriber email links to. Shared by linkToCustomer (first link),
 * linkManyToCustomers (bulk import), the relink helpers (archive/restore)
 * and mirrored by the 20260823000005 backfill. One email may span several
 * customer profiles (20260417000010), some archived: pick a NON-ARCHIVED one
 * deterministically — is_primary_profile DESC NULLS LAST, created_at ASC,
 * id ASC, LIMIT 1. An unordered match could pin an archived profile and the
 * sender's anti-join would then suppress the household forever.
 *
 * SCOPE IS DELIBERATELY NARROWER THAN whereLiveCustomer: `deleted_at IS NULL`
 * only — no `active = true`, no `pipeline_stage IN CUSTOMER_STAGES`. This PR
 * is about ARCHIVED customers, and customer_id here carries LINK semantics,
 * not lifecycle semantics: a lead-stage row (new_lead, contacted, …) is a
 * legitimate link target and always has been, and buildSubscriberQuery's
 * customers/leads audiences key on customer_id IS [NOT] NULL. Adding the
 * lifecycle scope here would silently unlink future lead-stage subscribers
 * while historical ones kept their link — two different audiences for
 * identical data. Lifecycle filtering belongs in the readers, not the link.
 *
 * Returns a correlated scalar-subselect fragment: `emailExprSql` is the SQL
 * expression (already normalized by the caller or normalized here) the
 * customer email is compared against; `excludeCustomerId` (optional) keeps
 * the archived profile itself out of the candidates.
 */
function liveTwinSubselect(emailExprSql, { excludeCustomerId = null } = {}) {
  const bindings = [];
  let sql = `(SELECT c.id FROM customers c
       WHERE LOWER(TRIM(c.email)) = ${emailExprSql}`;
  if (excludeCustomerId != null) { sql += '\n         AND c.id <> ?'; bindings.push(excludeCustomerId); }
  sql += `
         AND c.deleted_at IS NULL
       ORDER BY c.is_primary_profile DESC NULLS LAST, c.created_at ASC, c.id ASC
       LIMIT 1)`;
  return { sql, bindings };
}

/**
 * Link a newsletter subscriber to its matching customer (by email) when
 * one isn't linked yet. Case-insensitive on the customers side because
 * customer rows come from many entry points (booking, lead webhooks,
 * Twilio call ingestion, admin add) and not all of them lowercase email
 * before insert. Idempotent: only touches rows where customer_id IS NULL,
 * so calling repeatedly on the same email is a no-op. Candidate = the live
 * twin from liveTwinSubselect (never an archived / non-customer profile);
 * when there is none the row simply stays unlinked.
 *
 * Without this, the "Customers only" / "Leads only" segment filters in
 * the composer match ~zero subscribers because customer_id was NULL on
 * every legacy row.
 */
async function linkToCustomer(email) {
  if (!email) return;
  const lc = email.toLowerCase();
  const twin = liveTwinSubselect('?');
  await db.raw(
    `UPDATE newsletter_subscribers
       SET customer_id = twin.id, updated_at = NOW()
       FROM ${twin.sql} twin
       WHERE newsletter_subscribers.email = ?
         AND newsletter_subscribers.customer_id IS NULL`,
    [lc.trim(), ...twin.bindings, lc],
  );
}

/**
 * Set-based first-link for a batch of emails (the CSV bulk import). Same
 * decision as linkToCustomer / liveTwinSubselect — same scope (deleted_at
 * IS NULL only; see the picker's note on why it is narrower than
 * whereLiveCustomer) and same ordering (is_primary_profile DESC NULLS LAST,
 * created_at ASC, id ASC) — expressed once per email with DISTINCT ON
 * instead of a correlated LIMIT 1, so a 25k-row import stays one query. An
 * email whose only profiles are archived matches no candidate and the row
 * stays unlinked (the sender's anti-join would suppress an archived link
 * anyway). Idempotent: only rows with customer_id IS NULL move. Returns the
 * number of rows linked.
 */
async function linkManyToCustomers(emails, conn = db) {
  const keys = Array.from(new Set((emails || [])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter(Boolean)));
  if (!keys.length) return 0;
  const res = await conn.raw(
    `UPDATE newsletter_subscribers ns
        SET customer_id = t.twin_id, updated_at = NOW()
       FROM (
         SELECT DISTINCT ON (LOWER(TRIM(c.email))) LOWER(TRIM(c.email)) AS email_key, c.id AS twin_id
           FROM customers c
          WHERE LOWER(TRIM(c.email)) = ANY(?)
            AND c.deleted_at IS NULL
          ORDER BY LOWER(TRIM(c.email)), c.is_primary_profile DESC NULLS LAST, c.created_at ASC, c.id ASC
       ) t
      WHERE LOWER(TRIM(ns.email)) = t.email_key
        AND ns.customer_id IS NULL
        AND LOWER(TRIM(ns.email)) = ANY(?)`,
    [keys, keys],
  );
  return Number(res?.rowCount || 0);
}

/**
 * Symmetric relink for one email, used by BOTH the archive route (after
 * deleted_at is set) and the restore route (after it is cleared), inside
 * their transaction. Re-runs the canonical twin picker (liveTwinSubselect)
 * for the SUBSCRIBER's normalized email and points every subscriber row that
 * carries that email AND is linked to one of that email's customer profiles
 * at the winner — so archiving the primary moves the link to the secondary,
 * and restoring the primary moves it back. Rows are matched on their OWN
 * email (never a customer's current email), so a stale email snapshot can't
 * be attached to an unrelated twin. No live winner → links left alone (the
 * sender's anti-join excludes archived links; a later restore lifts it).
 * Returns { winnerId, relinked }.
 */
// Every subscriber-relink WRITER (archive, restore, and the pre-send sweep)
// serializes on this advisory xact lock (codex #3472 r4): the sweep's UPDATE
// computes its winners from one MVCC snapshot, and without the lock it could
// interleave between a restore's canonical relink and that restore's commit —
// overwriting the restored primary with a stale pre-restore winner that later
// sweeps can never repair (the wrong link is live). With the lock, whichever
// writer runs second takes a fresh statement snapshot and converges on the
// canonical picker result. Single deterministic key → no lock-ordering
// deadlocks among the three.
async function acquireRelinkLock(trx) {
  await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', ['newsletter_subscriber_relink']);
}

async function relinkSubscribersForEmail(trx, email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key) return { winnerId: null, relinked: 0 };
  await acquireRelinkLock(trx);
  const twin = liveTwinSubselect('?');
  const picked = await trx.raw(`SELECT ${twin.sql} AS id`, [key, ...twin.bindings]);
  const winnerId = picked?.rows?.[0]?.id ?? null;
  if (!winnerId) return { winnerId: null, relinked: 0 };
  const relinked = await trx('newsletter_subscribers')
    .whereRaw('LOWER(TRIM(email)) = ?', [key])
    .whereNotNull('customer_id')
    .whereNot('customer_id', winnerId)
    .whereIn('customer_id', function () {
      this.select('id').from('customers').whereRaw('LOWER(TRIM(email)) = ?', [key]);
    })
    .update({ customer_id: winnerId, updated_at: trx.fn.now() });
  return { winnerId, relinked: Number(relinked || 0) };
}

/**
 * ARCHIVE-side relink. The subscriber's stored email is a SNAPSHOT taken at
 * signup and is never refreshed, so it can differ from the archived
 * customer's CURRENT email — keying off customer.email alone would miss those
 * rows (and could attach them to a twin of an email they no longer carry).
 * So: resolve the rows BY the archived customer_id, then pick a twin per
 * DISTINCT normalized SUBSCRIBER email, excluding the archived profile
 * itself. Same scope + ordering as liveTwinSubselect, one set-based UPDATE.
 * An email with no non-archived profile matches nothing and its rows stay on
 * the archived id (the sender's anti-join excludes them; restore lifts it).
 * Runs on the caller's transaction. Returns { relinked }.
 */
async function relinkSubscribersFromArchivedCustomer(trx, archivedCustomerId) {
  if (!archivedCustomerId) return { relinked: 0 };
  await acquireRelinkLock(trx);
  const res = await trx.raw(
    `UPDATE newsletter_subscribers ns
        SET customer_id = t.twin_id, updated_at = NOW()
       FROM (
         SELECT DISTINCT ON (LOWER(TRIM(c.email))) LOWER(TRIM(c.email)) AS email_key, c.id AS twin_id
           FROM customers c
          WHERE c.deleted_at IS NULL
            AND c.id <> ?
            AND LOWER(TRIM(c.email)) IN (
              SELECT LOWER(TRIM(x.email)) FROM newsletter_subscribers x WHERE x.customer_id = ?
            )
          ORDER BY LOWER(TRIM(c.email)), c.is_primary_profile DESC NULLS LAST, c.created_at ASC, c.id ASC
       ) t
      WHERE ns.customer_id = ?
        AND LOWER(TRIM(ns.email)) = t.email_key`,
    [archivedCustomerId, archivedCustomerId, archivedCustomerId],
  );
  return { relinked: Number(res?.rowCount || 0) };
}

/**
 * Sweep relink: repoint EVERY subscriber whose link is an archived customer
 * at that email's live twin, when one exists. The archive/restore relinks
 * repair links at archive/restore TIME — but a customer re-booked LATER gets
 * a brand-new customers row and none of the ~12 creation entry points
 * re-runs the picker, so the stale archived link survives until the next
 * archive/restore touches that email (i.e. usually forever). Run before
 * selecting a send audience: the sender's archived-link lift decides
 * DELIVERY, but segment resolution, personalization, and touchpoint history
 * all key on ns.customer_id and must read the live profile.
 * Same picker scope (deleted_at IS NULL only) + ordering as
 * liveTwinSubselect, keyed on the SUBSCRIBER's normalized email (the stored
 * email is a signup-time snapshot — see relinkSubscribersFromArchivedCustomer).
 * Set-based, idempotent, no-op when nothing is stale. Returns { relinked }.
 */
async function relinkArchivedLinkedSubscribers(conn = db) {
  // Own transaction so the advisory xact lock brackets exactly this UPDATE
  // (a caller already inside a transaction nests as a savepoint; the lock
  // then rides the outer transaction, which is also correct).
  return conn.transaction(async (trx) => {
    await acquireRelinkLock(trx);
    const res = await trx.raw(
      `UPDATE newsletter_subscribers ns
        SET customer_id = t.twin_id, updated_at = NOW()
       FROM (
         SELECT DISTINCT ON (LOWER(TRIM(c.email))) LOWER(TRIM(c.email)) AS email_key, c.id AS twin_id
           FROM customers c
          WHERE c.deleted_at IS NULL
            AND LOWER(TRIM(c.email)) IN (
              SELECT LOWER(TRIM(x.email))
                FROM newsletter_subscribers x
                JOIN customers ax ON ax.id = x.customer_id
               WHERE ax.deleted_at IS NOT NULL
            )
          ORDER BY LOWER(TRIM(c.email)), c.is_primary_profile DESC NULLS LAST, c.created_at ASC, c.id ASC
       ) t
      WHERE LOWER(TRIM(ns.email)) = t.email_key
        AND ns.customer_id IN (SELECT ac.id FROM customers ac WHERE ac.deleted_at IS NOT NULL)`,
    );
    return { relinked: Number(res?.rowCount || 0) };
  });
}

module.exports = { subscribeOrResubscribe, lookupByToken, confirmByToken, linkToCustomer, linkManyToCustomers, liveTwinSubselect, relinkSubscribersForEmail, relinkSubscribersFromArchivedCustomer, relinkArchivedLinkedSubscribers, purgeStalePendingSubscribers, EMAIL_RE, CONFIRM_TTL_MS };
