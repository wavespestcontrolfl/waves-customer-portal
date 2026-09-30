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
 * check below runs across EVERY non-archived profile whose email is the
 * same MAILBOX (LOWER(TRIM), plus Google's dot/+tag/googlemail identity —
 * sameMailboxSql), and an exclusion on ANY of them excludes the address;
 * existing subscriber rows and suppressions match by that same mailbox
 * identity, in both directions. Every exclusion is checked in ONE fixed priority
 * order — an existing subscriber-state row always outranks a
 * preference/suppression check, so a both-unsubscribed-AND-opted-out
 * address counts once, under the higher reason:
 *   1. an existing row for the address, or linked to any sharing profile:
 *      active (already claimed) / unsubscribed / pending / inactive+waitlist
 *      (and any other stored status, fail closed, with inactive)
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
 *
 * NOTHING HERE RE-DERIVES A LINK OR AN IDENTITY. Which profile a subscriber
 * row belongs to is decided by THE twin picker (liveTwinSubselect,
 * newsletter-subscribers.js — is_primary_profile DESC NULLS LAST,
 * created_at ASC, id ASC over every non-archived profile on the address,
 * any stage), the same fragment linkToCustomer / linkManyToCustomers / the
 * relink helpers use: the import links through linkToCustomer itself, takes
 * the new row's name from that SAME canonical profile (the one the link
 * lands on — never whichever sharing profile the candidate scan returned
 * first), and the orphan link embeds liveTwinSubselect as its target. The
 * zone fill (fillZoneForSubscriber) is one locked read-then-write shared by
 * the fill sweep, the import, and each orphan link: it re-reads the linked customer's live
 * status and CURRENT city under that customer's comms lock and a row lock,
 * so a city edit can never land between the read and the zone write.
 */

const db = require('../models/db');
const logger = require('./logger');
const { cityToZone } = require('./event-freshness');
const { activeSuppressionsFor } = require('./email-template-library');
const { linkToCustomer, liveTwinSubselect } = require('./newsletter-subscribers');
const { CUSTOMER_STAGES } = require('./customer-stages');
const {
  lockCustomerComms, lockCustomerEmail, googleMailboxIdentity, GOOGLE_MAILBOX_SQL,
} = require('../utils/customer-comms-lock');
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

// ORDER BY is THE canonical picker's own tie-break (liveTwinSubselect —
// is_primary_profile DESC NULLS LAST, created_at ASC, id ASC), applied
// globally so it also decides ties ACROSS a Google mailbox group (two
// candidates spelled differently but sharing one inbox — codex round on
// #5165), not just within one literal email spelling. Two candidates
// sharing a mailbox are deduped to ONE projected/imported row in the loop
// below (`projectedAddresses` keyed by mailbox identity) — this order
// guarantees the FIRST one iterated, and therefore the one whose OWN
// canonicalProfile pick and OWN email spelling get kept, is always the
// profile the picker would choose, never whichever the database happened
// to return first. Deterministic across runs: an unordered scan of the
// same rows always sorts back to this one order.
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
     ORDER BY c.is_primary_profile DESC NULLS LAST, c.created_at ASC, c.id ASC
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

// "Is this stored column the SAME MAILBOX as `email`?" — for EXCLUSION
// matching only (sharing profiles, existing subscriber rows, suppressions);
// it never rewrites or chooses a stored address. Exact LOWER(TRIM) match,
// plus, for a Google address, Google's mailbox identity: gmail.com /
// googlemail.com ignore local-part dots and everything after '+', so
// j.o.h.n+news@gmail.com and john@googlemail.com deliver to john@gmail.com's
// inbox. Symmetric by construction (both sides reduce to the identity), so
// an unsubscribe or opt-out recorded under either spelling excludes the
// other. The identity is the repo's one canonical rule —
// customer-comms-lock.js googleMailboxIdentity (JS) / GOOGLE_MAILBOX_SQL
// (SQL), the same identity the address lock this module takes keys on —
// never a local copy. Non-Google addresses keep the exact comparison: dots
// and tags are significant everywhere else.
function sameMailboxSql(column, email) {
  const exact = normalizeEmail(email);
  const identity = googleMailboxIdentity(exact);
  if (!identity) return { sql: `LOWER(TRIM(${column})) = ?`, bindings: [exact] };
  const trimmed = `TRIM(${column})`;
  return {
    sql: `(LOWER(TRIM(${column})) = ? OR (${GOOGLE_MAILBOX_SQL.isGoogle(trimmed)} AND ${GOOGLE_MAILBOX_SQL.mailbox(trimmed)} = ?))`,
    bindings: [exact, identity.split('@')[0]],
  };
}

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

// EVERY profile whose customers.email is this MAILBOX (sameMailboxSql —
// exact, or a Google dot/tag/googlemail alias of it) — any stage, any
// `active` flag, only archived (deleted_at) rows left out. A superset of the
// population linkToCustomer's canonical picker (liveTwinSubselect,
// newsletter-subscribers.js) chooses the subscriber's customer_id from, so
// no profile the new row can end up attached to is ever left unchecked, and
// an opt-out on an alias profile of the same inbox excludes it too.
async function profilesSharingAddress(conn, email) {
  const mailbox = sameMailboxSql('c.email', email);
  const result = await conn.raw(
    `SELECT c.id AS profile_id
       FROM customers c
      WHERE ${mailbox.sql}
        AND c.deleted_at IS NULL`,
    mailbox.bindings,
  );
  return (result.rows || []).map((r) => r.profile_id);
}

// Highest-priority existing subscriber row for this MAILBOX: any row whose
// email is the same mailbox (sameMailboxSql — an unsubscribed
// john.doe+news@gmail.com row blocks johndoe@gmail.com and vice versa), or
// that is linked to ANY profile sharing it. Ordered so a still-active row
// always wins the read. Returns the found row (`status` may itself be NULL
// or '' — the column has no CHECK constraint) or `undefined` when NO row
// matches at all — the caller (classifyAddress) must never confuse the two
// (codex P1): a NULL/empty status on a REAL row still fails closed, rather
// than being read as "no existing row" and letting a new active row in
// alongside it.
async function existingAddressStatus(conn, profileIds, email) {
  const mailbox = sameMailboxSql('email', email);
  const result = await conn.raw(
    `SELECT status FROM newsletter_subscribers
      WHERE customer_id = ANY(?::uuid[]) OR ${mailbox.sql}
      ORDER BY CASE status
                 WHEN 'active' THEN 0
                 WHEN 'unsubscribed' THEN 1
                 WHEN 'pending' THEN 2
                 WHEN 'inactive' THEN 3
                 WHEN 'waitlist' THEN 3
                 ELSE 4
               END
      LIMIT 1`,
    [profileIds, ...mailbox.bindings],
  );
  return result.rows?.[0];
}

// Active suppressions for this MAILBOX. activeSuppressionsFor stays the
// single source of truth for which rows count (status, group, global
// types); it matches one exact address, so it runs once per stored spelling
// of the same mailbox (sameMailboxSql) — a suppression recorded for any
// Google alias of the address suppresses it, in both directions.
async function mailboxSuppressions(conn, email) {
  const mailbox = sameMailboxSql('email', email);
  const variants = await conn.raw(
    `SELECT DISTINCT LOWER(TRIM(email)) AS email FROM email_suppressions
      WHERE status = 'active' AND ${mailbox.sql}`,
    mailbox.bindings,
  );
  const spellings = [...new Set([normalizeEmail(email), ...(variants.rows || []).map((r) => r.email)])];
  const found = [];
  for (const spelling of spellings) {
    found.push(...await activeSuppressionsFor(null, spelling, 'marketing_newsletter', conn));
  }
  return found;
}

// Classifies ONE ADDRESS (never one profile) against the fixed priority
// order in the module header. `profileIds` is every profile sharing the
// address (profilesSharingAddress): an opt-out, email switch-off, or
// SMS-only channel on ANY of them excludes the address — the mailbox is
// one inbox, whichever profile the subscriber row ends up linked to.
// Returns an exclusion reason, 'already_active', or null (importable).
async function classifyAddress(conn, { email, profileIds }) {
  const existing = await existingAddressStatus(conn, profileIds, email);
  const status = existing?.status;
  if (status === 'active') return 'already_active';
  if (status === 'unsubscribed') return 'previously_unsubscribed';
  if (status === 'pending') return 'pending_confirmation';
  // Fail closed: newsletter_subscribers.status has no CHECK constraint, so
  // any other stored value (a bounce/complaint label, a future status —
  // NULL and '' included) is a row this import must not route around —
  // counted with the inactive rows. Judged on `existing` (a found row),
  // never on `status`'s own truthiness (codex P1) — a NULL/empty status on
  // a REAL row must never read as "no existing row at all".
  if (existing) return 'inactive_subscriber';

  const suppressions = await mailboxSuppressions(conn, email);
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

// A count/array field that means "what WOULD happen" on a dry run and
// "what WAS applied" on a confirmed write — never the read-time projection
// once a write-time recheck could have moved it (codex #5165 P2, :717:
// importable/byCity are the two fields reconcileCustomers reports this way).
// Its own tiny branch, so the caller's return statement stays branch-free.
const appliedOrProjected = (write, applied, projected) => (write ? applied : projected);

// Thrown (and retried from a fresh transaction) when the address, or the
// set of profiles sharing it, moved after its comms locks were chosen — a
// comms lock can only be taken in sorted order BEFORE any row lock, so the
// only safe response to a new sharer is to roll back and start over.
class AddressMovedError extends Error {}
const MAX_DECISION_ATTEMPTS = 3;

// Never store or log a raw driver-thrown error message (codex P1): a
// Postgres/pg error's own DETAIL — and, for some error shapes, the message
// itself — can embed the actual row value (a unique-violation's "Key
// (email)=(x@y.com) already exists."), which would leak a customer email
// into the `errors` array or the log line despite every other id-only
// convention in this module. AddressMovedError's own messages are a fixed,
// reviewed allowlist (no row data, ever) and pass through verbatim; any
// other error — almost always the database driver — is reduced to just
// its error CODE (e.g. '23505'), never its message or detail.
function safeErrorDescriptor(e) {
  if (e instanceof AddressMovedError) return e.message;
  return e && e.code ? `db_error_${e.code}` : 'error';
}

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
// Step 5 covers every assignment that took the key FIRST: this decision
// waits on the key, the assignment commits, and the re-read sees the new
// sharer (proven in newsletter-list-reconcile-postgres.test.js). An
// assignment that is still waiting for the key while this decision holds
// it cannot be seen by any read here (its email is uncommitted and names a
// profile this decision has no reason to lock); it commits strictly AFTER
// this import, exactly as if it had started after it.
// `expectedMailbox` (optional): the mailbox key a fallback attempt is
// actually trying to fill (importAddressWithFallback, newsletter-list-
// reconcile.js). Codex P2 (:817) — "Recheck the expected mailbox inside the
// import transaction": that caller's own peek is unlocked and can still
// race against THIS decision's locked read (the address changes again in
// the exact gap between the peek and here) — this check, immediately after
// the row is FOR SHARE-locked and before any further work, is the ONLY
// authoritative one. A mismatch never settles the caller's mailbox: it
// returns 'mailbox_moved' rather than classifying (and possibly importing)
// whatever address the profile now actually has — that address is a
// different candidate's business, never this call's.
async function decideAddress(trx, customerId, expectedMailbox = null) {
  const peek = await fetchLiveCandidate(trx, customerId);
  if (!peek) return { outcome: 'no_longer_live' };
  const lockedIds = sortedUnique([customerId, ...await profilesSharingAddress(trx, peek.email)]);
  for (const id of lockedIds) await lockCustomerComms(trx, id);

  const fresh = await fetchLiveCandidate(trx, customerId, { forShare: true });
  if (!fresh) return { outcome: 'no_longer_live' };
  if (normalizeEmail(fresh.email) !== normalizeEmail(peek.email)) throw new AddressMovedError('address changed');
  if (expectedMailbox) {
    const currentMailbox = googleMailboxIdentity(normalizeEmail(fresh.email)) || normalizeEmail(fresh.email);
    if (currentMailbox !== expectedMailbox) return { outcome: 'mailbox_moved' };
  }
  // Every OTHER sharing profile's customers row FOR SHARE too (still before
  // the address key — rows before the key, like every writer here): the
  // canonical twin picker below orders on these rows' is_primary_profile /
  // created_at, so they must not move between the pick, the insert's name,
  // and linkToCustomer's own pick inside this same transaction.
  await trx.raw('SELECT id FROM customers WHERE id = ANY(?::uuid[]) ORDER BY id FOR SHARE', [lockedIds]);
  for (const id of lockedIds) await trx('notification_prefs').where({ customer_id: id }).forShare();
  await lockCustomerEmail(trx, fresh.email);

  const profileIds = sortedUnique([customerId, ...await profilesSharingAddress(trx, fresh.email)]);
  if (profileIds.some((id) => !lockedIds.includes(id))) throw new AddressMovedError('new profile shares the address');

  const reason = await classifyAddress(trx, { email: fresh.email, profileIds });
  if (reason === 'already_active') return { outcome: 'row_appeared' };
  if (reason) return { outcome: 'excluded', reason };
  return { outcome: 'importable', fresh, canonical: await canonicalProfile(trx, fresh.email) };
}

// The profile THE twin picker (liveTwinSubselect — the fragment
// linkToCustomer runs) links this address to, with the identity fields the
// new subscriber row carries. Always one of profilesSharingAddress's set
// (same population: non-archived, LOWER(TRIM(email)) match), all of which
// the decision has comms-locked and row-locked.
async function canonicalProfile(conn, email) {
  const twin = liveTwinSubselect('?');
  const result = await conn.raw(
    `SELECT canon.id AS canonical_id, canon.first_name, canon.last_name, canon.city
       FROM customers canon
      WHERE canon.id = ${twin.sql}`,
    [normalizeEmail(email), ...twin.bindings],
  );
  return result.rows?.[0] || null;
}

// Opens a transaction on `conn` (a savepoint when `conn` is already one),
// makes the decision, and hands it to `then` INSIDE the same transaction —
// so everything `then` writes commits under the locks the decision took.
// Outcomes: { outcome: 'importable', fresh } | { outcome: 'excluded', reason }
//   | { outcome: 'row_appeared' } — an ACTIVE row already claims the address
//   | { outcome: 'no_longer_live' } — archived/re-staged out since the read
//   | { outcome: 'mailbox_moved' } — expectedMailbox given and the customer's
//     CURRENT (locked) address is a different mailbox now (codex P2 :817)
// `expectedMailbox` passes straight through to decideAddress; omitted for
// the projection's own calls (nothing to compare against there).
async function withAddressDecision(conn, customerId, then, expectedMailbox = null) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await conn.transaction(async (trx) => then(trx, await decideAddress(trx, customerId, expectedMailbox)));
    } catch (e) {
      if (!(e instanceof AddressMovedError) || attempt >= MAX_DECISION_ATTEMPTS) throw e;
    }
  }
}

// THE zone-fill predicate, one fragment for the projection and the locked
// write: an ACTIVE subscriber missing a region_zone, linked to a live
// customer (canonical whereLiveCustomer stages). The zone itself always
// comes from cityToZone(c.city) of the row this predicate just read.
// `customerRef` defaults to the row's own link; the orphan projection
// passes the link target it WOULD set, so it reads the identical predicate.
const zoneFillFrom = (customerRef = 'ns.customer_id') => `FROM newsletter_subscribers ns
       JOIN customers c ON c.id = ${customerRef}
      WHERE ns.status = 'active'
        AND (ns.region_zone IS NULL OR TRIM(ns.region_zone) = '')
        AND c.deleted_at IS NULL
        AND c.active = true
        AND c.pipeline_stage = ANY(?)`;

// Projection: filtered to a mappable city here (SQL can't call cityToZone),
// so the count already equals the rows that WOULD be filled.
async function fetchZoneFillCandidates(conn) {
  const result = await conn.raw(
    `SELECT ns.id AS subscriber_id, c.city
       ${zoneFillFrom()}`,
    [CUSTOMER_STAGES],
  );
  return (result.rows || [])
    .map((r) => ({ subscriberId: r.subscriber_id, zone: cityToZone(r.city) }))
    .filter((r) => r.zone);
}

// Fills ONE subscriber's zone from its linked customer's CURRENT city —
// never a city read earlier. Must run inside a transaction. Resolve → lock
// → re-read: the linked customer's comms lock (taken before its customers
// row, per customer-comms-lock.js's order contract), THEN the customer row
// FOR SHARE in its OWN statement, THEN the subscriber row FOR UPDATE in a
// SEPARATE statement that re-checks the whole predicate (still active,
// still blank, still linked to that customer, customer still live) and
// reads the city the zone is computed from — the customer lock is already
// held, so this second statement needs no lock directive of its own.
// Customer BEFORE subscriber, in that fixed order, matching every other
// writer of these two tables (customer-email-fanout.js takes `customers
// FOR UPDATE` before its own later subscriber `FOR UPDATE`, with no comms
// lock in between to serialize against this). A single combined `FOR
// UPDATE OF ns FOR SHARE OF c` statement leaves the ACTUAL acquisition
// order to the query planner — measured here as subscriber-then-customer
// (an index scan on ns.id feeding a nested-loop join to c) — the reverse
// of that writer's order, a genuine cross-module deadlock (codex P1). A
// city edit (customer-email-write.js-style FOR UPDATE, or any UPDATE of
// the row) therefore either commits before this read — and the new city
// is used — or waits for this commit; it can never land between the read
// and the write. Returns true only when a zone was written.
async function fillZoneForSubscriber(trx, subscriberId) {
  const link = await trx.raw('SELECT customer_id FROM newsletter_subscribers WHERE id = ?', [subscriberId]);
  const customerId = link.rows?.[0]?.customer_id;
  if (!customerId) return false;
  await lockCustomerComms(trx, customerId);
  await trx.raw('SELECT id FROM customers WHERE id = ? FOR SHARE', [customerId]);
  const locked = await trx.raw(
    `SELECT ns.id AS subscriber_id, c.city
       ${zoneFillFrom()}
        AND ns.id = ?
        AND ns.customer_id = ?
      FOR UPDATE OF ns`,
    [CUSTOMER_STAGES, subscriberId, customerId],
  );
  const row = locked.rows?.[0];
  const zone = row ? cityToZone(row.city) : null;
  if (!zone) return false;
  await trx.raw('UPDATE newsletter_subscribers SET region_zone = ?, updated_at = NOW() WHERE id = ?', [zone, subscriberId]);
  return true;
}

// ACTIVE subscribers with no linked customer yet.
async function fetchOrphanSubscriberRows(conn) {
  const result = await conn.raw(
    `SELECT id, email FROM newsletter_subscribers WHERE status = 'active' AND customer_id IS NULL`,
  );
  return result.rows || [];
}

// THE orphan-link predicate, as one SQL fragment the dry-run projection and
// the write's UPDATE both embed verbatim. The TARGET is never chosen here:
// it is THE canonical twin picker (liveTwinSubselect, newsletter-
// subscribers.js — the same fragment linkToCustomer, linkManyToCustomers
// and the relink helpers run, same deleted_at-only link scope, same
// is_primary_profile / created_at / id order), applied to the orphan's
// normalized email exactly as linkManyToCustomers applies it. So an orphan
// linked here lands on the same profile any other linking path would pick.
// On top of that pick the predicate can only REFUSE, never redirect: the
// orphan must still be an active, unlinked row, and the picked profile must
// not already own an active subscriber (one active subscription per
// customer — the candidate query's rule) — a refused orphan simply stays
// unlinked.
function orphanTargetSql(subscriberId) {
  const twin = liveTwinSubselect('LOWER(TRIM(orphan.email))');
  return {
    sql: `SELECT pick.twin_id AS id
            FROM (
                  SELECT ${twin.sql} AS twin_id
                    FROM newsletter_subscribers orphan
                   WHERE orphan.id = ?
                     AND orphan.status = 'active'
                     AND orphan.customer_id IS NULL
                 ) pick
           WHERE pick.twin_id IS NOT NULL
             AND NOT EXISTS (
                   SELECT 1 FROM newsletter_subscribers ns2
                    WHERE ns2.customer_id = pick.twin_id AND ns2.status = 'active'
                 )`,
    bindings: [...twin.bindings, subscriberId],
  };
}

async function orphanLinkTarget(conn, subscriberId) {
  const { sql, bindings } = orphanTargetSql(subscriberId);
  const result = await conn.raw(sql, bindings);
  const rows = result.rows || [];
  return rows.length === 1 ? rows[0].id : null;
}

// Projection of the zone fills successful orphan links run: the SAME
// predicate fillZoneForSubscriber re-checks, read as if each orphan were
// already linked to its projected `customerId`.
async function projectedOrphanZoneFills(conn, links) {
  let fills = 0;
  for (const { subscriberId, customerId } of links) {
    const result = await conn.raw(
      `SELECT c.city ${zoneFillFrom('?')} AND ns.id = ?`,
      [customerId, CUSTOMER_STAGES, subscriberId],
    );
    if (result.rows?.[0] && cityToZone(result.rows[0].city)) fills += 1;
  }
  return fills;
}

// Links ONE orphan. Resolve → lock → re-check: the target's customer-comms
// lock (the same lock every import of that customer's address holds while
// it inserts and links) is taken BEFORE the one-active-subscription check
// that matters, and the UPDATE re-evaluates the WHOLE predicate in its own
// statement after the lock — so two reconciles linking different orphans
// to one customer serialize, and the second sees the first's committed
// link and refuses. A landed link then runs the SAME locked zone fill in
// the same transaction — the fill sweep ran before any link, and its
// predicate joins through customer_id, so a newly linked orphan would
// otherwise wait for a second run. Returns { linked, zoneFilled }.
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
    if (!(result.rows || []).length) return { linked: false, zoneFilled: false };
    return { linked: true, zoneFilled: await fillZoneForSubscriber(trx, subscriberId) };
  });
}

// Imports ONE customer's address: the decision (withAddressDecision) and
// the insert + link commit in ONE transaction under the decision's locks —
// never a separate read then a trusted write. Returns the decision's own
// outcome, or { outcome: 'imported' }, or { outcome: 'row_appeared' } when
// the INSERT's own ON CONFLICT fired. `expectedMailbox` (optional) passes
// straight through to withAddressDecision/decideAddress — a caller
// retrying fallbacks for a specific mailbox (importAddressWithFallback)
// gives it the mailbox it's trying to fill, so the outcome can never be
// this profile's own DIFFERENT (moved) address (codex P2 :817).
async function importOneCustomer(conn, customerId, expectedMailbox = null) {
  return withAddressDecision(conn, customerId, async (trx, decision) => {
    if (decision.outcome !== 'importable') return decision;
    const { fresh, canonical } = decision;
    const lc = normalizeEmail(fresh.email);
    // INSERT-only: no UPDATE branch exists for this statement to take, so
    // a row that appeared for this email in the instant between the
    // decision and this write is left completely untouched — the conflict
    // just yields zero returned rows.
    const inserted = await trx('newsletter_subscribers')
      .insert({
        email: lc,
        // The CANONICAL profile's name — the profile linkToCustomer links
        // this row to below — never the (unordered) candidate's.
        first_name: canonical?.first_name || null,
        last_name: canonical?.last_name || null,
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
    // Identity follows the link that actually landed: re-read from the
    // linked profile (a no-op when it is the canonical pick above, which
    // the decision's locks make it on unchanged data). RETURNING the
    // linked profile's CURRENT city too — never the pre-insert
    // decision.canonical.city — so the caller's applied-city accounting
    // (reconcileCustomers' appliedByCity) reflects the row this write
    // actually produced.
    const identity = await trx.raw(
      `UPDATE newsletter_subscribers ns
          SET first_name = linked.first_name, last_name = linked.last_name
         FROM customers linked
        WHERE ns.id = ? AND linked.id = ns.customer_id
        RETURNING linked.city AS city`,
      [inserted[0].id],
    );
    // The SAME locked zone fill the sweep runs — the linked customer's
    // current city and live status, never a snapshot.
    await fillZoneForSubscriber(trx, inserted[0].id);
    const city = (identity.rows?.[0]?.city || '').trim() || 'Unknown';
    return { outcome: 'imported', city };
  }, expectedMailbox);
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
  // Codex P2 (:699) — "Retry a surviving profile after the projected winner
  // disappears": fetchCandidateRows' ORDER BY picks ONE canonical candidate
  // per mailbox to project/import (projectedAddresses dedup below), but
  // every OTHER independently-importable candidate sharing that mailbox is
  // a real, live FALLBACK — if the kept candidate is archived/re-staged
  // between this projection and its write-time recheck (outcome
  // 'no_longer_live'), the mailbox itself is very likely still eligible
  // through one of these siblings. mailboxFallbacks holds them in the SAME
  // canonical order, keyed by mailbox identity, for the write loop below to
  // retry — never assumed still-importable; each retry re-runs the full,
  // fresh withAddressDecision (importOneCustomer), exactly like the first
  // attempt.
  const mailboxFallbacks = new Map();

  for (const row of candidateRows) {
    let decision;
    try {
      decision = await withAddressDecision(conn, row.customer_id, async (_trx, d) => d);
    } catch (e) {
      const safe = safeErrorDescriptor(e);
      errors.push({ customerId: row.customer_id, error: safe });
      logger.error(`[newsletter-list-reconcile] classify customer id=${row.customer_id} failed: ${safe}`);
      continue;
    }
    if (decision.outcome === 'excluded') { excluded[decision.reason] += 1; continue; }
    // 'row_appeared' (an active row already claims the address) and
    // 'no_longer_live' keep their own buckets — never silently dropped.
    if (decision.outcome !== 'importable') { excluded[decision.outcome] += 1; continue; }
    // Two candidate profiles sharing one MAILBOX are ONE subscriber: the
    // first is projected, the rest counted here — exactly what the write
    // would do (its second insert finds the first's active row through
    // sameMailboxSql). Keyed by the same mailbox identity the write uses,
    // so equivalent Google spellings (john.doe+work@gmail.com and
    // johndoe@gmail.com) count once (codex round on 78312cbf27).
    const address = normalizeEmail(decision.fresh.email);
    const mailbox = googleMailboxIdentity(address) || address;
    if (projectedAddresses.has(mailbox)) {
      excluded.duplicate_address += 1;
      mailboxFallbacks.get(mailbox).push(row.customer_id);
      continue;
    }
    projectedAddresses.add(mailbox);
    mailboxFallbacks.set(mailbox, []);
    importableRows.push(decision.fresh);
    // The canonical profile's city — the profile the row links to, whose
    // city the write's zone fill reads.
    const city = (decision.canonical?.city || '').trim() || 'Unknown';
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
  // full row (an importable row carries email/first_name/last_name), and
  // never the raw driver error message/detail either (safeErrorDescriptor).
  async function guardedEach(items, idFor, action) {
    for (const item of items) {
      try { await action(item); } catch (e) {
        const id = idFor(item);
        const safe = safeErrorDescriptor(e);
        errors.push({ ...id, error: safe });
        logger.error(`[newsletter-list-reconcile] write failed for ${JSON.stringify(id)}: ${safe}`);
      }
    }
  }

  // Codex P2 (:795, :817) — "Retry fallbacks when the selected profile
  // changes address" / "Recheck the expected mailbox inside the import
  // transaction": a 'no_longer_live' outcome isn't the only way an attempt
  // can fail to fulfil the projected mailbox — the attempted profile's
  // address may simply have CHANGED to a DIFFERENT mailbox since the
  // projection (this run's own candidate read, or a later fallback retry),
  // and importOneCustomer would then classify — and possibly import — THAT
  // new address instead, which is a different candidate's business
  // entirely, never this mailbox's. So this loop judges by MAILBOX, never
  // by outcome code, with TWO checks: a cheap unlocked peek of that
  // profile's CURRENT address (fetchLiveCandidate, no lock, no
  // transaction) up front, as a pre-filter that skips an obviously-moved
  // profile without even opening a transaction; and the authoritative one
  // — importOneCustomer is given the SAME expected mailbox, and
  // decideAddress re-checks it itself immediately after the row is
  // FOR SHARE-locked, since the unlocked peek here can still race against
  // that locked read in the exact gap between the two. Either check finding
  // a mismatch ('mailbox_moved' from the locked one) skips this attempt
  // WITHOUT ever importing it — its new address is left to its own
  // candidate row, never imported here as a side effect of THIS mailbox's
  // fallback chain — and the next fallback (in the SAME canonical order the
  // projection picked them) is tried. Only an attempt still in the
  // projected mailbox is ever imported, and its outcome (imported /
  // excluded / row_appeared / a race-driven no_longer_live) settles the
  // mailbox — counted once, as the FINAL outcome, never once per attempt.
  async function importAddressWithFallback(customerId, mailbox, fallbackIds) {
    for (const id of [customerId, ...fallbackIds]) {
      const peek = await fetchLiveCandidate(conn, id);
      if (peek) {
        const peekMailbox = googleMailboxIdentity(normalizeEmail(peek.email)) || normalizeEmail(peek.email);
        if (peekMailbox !== mailbox) continue;
      }
      const result = await importOneCustomer(conn, id, mailbox);
      if (result.outcome === 'no_longer_live' || result.outcome === 'mailbox_moved') continue;
      return result;
    }
    return { outcome: 'no_longer_live' };
  }

  let imported = 0;
  let zoneFillsApplied = 0;
  let orphanLinksApplied = 0;
  const appliedCityCounts = new Map();
  if (write) {
    await guardedEach(importableRows, (row) => ({ customerId: row.customer_id }), async (row) => {
      const address = normalizeEmail(row.email);
      const mailbox = googleMailboxIdentity(address) || address;
      const result = await importAddressWithFallback(row.customer_id, mailbox, mailboxFallbacks.get(mailbox) || []);
      if (result.outcome === 'imported') {
        imported += 1;
        appliedCityCounts.set(result.city, (appliedCityCounts.get(result.city) || 0) + 1);
        return;
      }
      if (result.outcome === 'excluded') { excluded[result.reason] = (excluded[result.reason] || 0) + 1; return; }
      // 'row_appeared' and 'no_longer_live' each have their own bucket —
      // a rejected candidate always keeps its reason and is counted,
      // never silently dropped as importable-with-imported:0. Only the
      // FINAL outcome (after exhausting every fallback) is counted here —
      // never once per attempt.
      excluded[result.outcome] += 1;
    });

    await guardedEach(zoneFillCandidates, (fill) => ({ subscriberId: fill.subscriberId }), async (fill) => {
      // Re-reads the linked customer under lock — the projected zone is
      // never trusted as the value to write.
      if (await conn.transaction((trx) => fillZoneForSubscriber(trx, fill.subscriberId))) zoneFillsApplied += 1;
    });

    await guardedEach(orphanLinks, (link) => ({ subscriberId: link.subscriberId }), async (link) => {
      const { linked, zoneFilled } = await applyOrphanLink(conn, link.subscriberId);
      if (linked) orphanLinksApplied += 1;
      if (zoneFilled) zoneFillsApplied += 1;
    });
  }

  // Applied-vs-projected (codex #5165 P2, :717): a candidate that classified
  // importable at read time can still fail its write-time recheck (opted
  // out / archived / a race) — importOneCustomer already counts that
  // rejection under its OWN reason above, but the row never left
  // importableRows or cityCounts, so a confirmed run could report
  // importable:1 / imported:0 / one exclusion, with byCity still showing an
  // import that never happened. In write mode, importable/byCity now
  // describe ONLY what was actually applied (== imported, keyed by the
  // ACTUAL linked profile's city importOneCustomer returns); the read-time
  // projection is always available under `projected`, unchanged by write
  // mode and identical to the top-level fields on a dry run.
  const appliedByCity = Array.from(appliedCityCounts.entries())
    .map(([city, count]) => ({ city, count }))
    .sort((a, b) => b.count - a.count || a.city.localeCompare(b.city));

  return {
    dryRun: !write,
    candidates: candidateRows.length,
    importable: appliedOrProjected(write, imported, importableRows.length),
    imported,
    excluded,
    // Dry run reports the projection (what WOULD happen); write mode
    // reports what was ACTUALLY applied — a change landing between the two
    // can make these differ, never the rules themselves.
    // The dry run adds the fills its projected orphan links would run, as
    // the write counts the fills its links actually made. (Kept as ternaries,
    // not appliedOrProjected: the dry-run branch's projectedOrphanZoneFills
    // call must stay short-circuited out of write mode, never evaluated.)
    zoneFills: write ? zoneFillsApplied : zoneFillCandidates.length + await projectedOrphanZoneFills(conn, orphanLinks),
    orphanLinks: write ? orphanLinksApplied : orphanLinks.length,
    byCity: appliedOrProjected(write, appliedByCity, byCity),
    // The pre-write classification, always — identical to the top-level
    // importable/byCity on a dry run; the ONLY place to see what the batch
    // looked like before the write-time recheck ran, in write mode.
    projected: { importable: importableRows.length, byCity },
    errors,
  };
}

module.exports = { reconcileCustomers };
