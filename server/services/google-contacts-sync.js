/**
 * Google Contacts sync — every customer and every incoming lead becomes a
 * Google Contact in the operator's account (contact@), starred and in
 * myContacts, so Gmail/phone surfaces them as known senders/callers (owner
 * directive 2026-07-28: hands-off, no triage).
 *
 * Shape: row-level sync state (google_contact_id + google_contact_synced_at
 * on customers/leads) + a 10-minute incremental cron. The predicate
 * (synced_at NULL or older than updated_at) makes every run both the
 * incremental pass AND the reconcile — contact-field touch triggers
 * (migration 20260729000002) bump updated_at from EVERY writer, so no
 * per-insert hooks and no writer audits.
 *
 * Safety model:
 * - GATE_CONTACTS_SYNC (default OFF everywhere) — this service WRITES into
 *   the operator's live Google account, and preview/dev environments carry
 *   real Gmail credentials; only prod, explicitly flipped by the owner,
 *   may run it.
 * - Stamps compare updated_at at MILLISECOND precision (node-postgres
 *   truncates microseconds) and copy the column's own full-precision value
 *   into google_contact_synced_at via SQL — a raced edit loses the stamp
 *   and re-syncs; an unraced row can never wedge on lost microseconds.
 * - Creation is recoverable: contacts carry a waves_row clientData tag, a
 *   pre-create search adopts a match (lost-response replay), and a failed
 *   DB stamp rolls back ONLY a genuinely fresh create (adopted or updated
 *   contacts are never deleted by compensation).
 * - One person, one contact: converted leads TRANSFER their contact to the
 *   customer row (refreshing the in-run customer snapshot); repeat-inquiry
 *   leads adopt the sibling lead's contact; a contact is deleted only when
 *   NO other live row references it; soft-deleted rows (customer merges,
 *   removals) get a tombstone lane that retires their contacts.
 * - Drift repair: a bounded verification lane revisits long-unverified
 *   synced rows so external deletion/unstarring heals within days.
 * - People API write budget is ~90/min — writes are throttled and each run
 *   is capped, with capacity RESERVED for leads so a fresh inquiry never
 *   waits behind the historical customer backfill.
 */
const { google } = require('googleapis');
const db = require('../models/db');
const logger = require('./logger');
const gmailClient = require('./email/gmail-client');

const RUN_CAP = 60; // fresh/stale rows per run — under the People API write budget
const LEAD_RESERVE = 15; // slots leads always get, even mid-backfill
const TOMBSTONE_SLOTS = 10; // soft-deleted rows retired per run
const VERIFY_SLOTS = 5; // long-unverified rows re-checked per run
const VERIFY_AFTER_DAYS = 7;
const WRITE_GAP_MS = 800;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function isScopeError(err) {
  const status = err?.code || err?.response?.status;
  const msg = String(err?.response?.data?.error?.message || err?.message || '');
  return status === 403 && /insufficient|scope|permission/i.test(msg);
}

function isGone(err) {
  return err?.code === 404 || err?.response?.status === 404;
}

/**
 * PII-safe error rendering: Google validation errors can echo the submitted
 * email/phone/address back in message text — log status/reason codes only
 * (AGENTS.md non-card PII logging rule).
 */
function safeErr(err) {
  const status = err?.code || err?.response?.status || '';
  const reason = err?.response?.data?.error?.status || err?.name || 'Error';
  return `${reason}${status ? ` (${status})` : ''}`;
}

const rowTag = (table, row) => `${table}:${row.id}`;

function contactBodyFor(row, kind, table) {
  const email = String(row.email || '').trim();
  const phone = String(row.phone || '').trim();
  const body = {
    names: [{
      givenName: String(row.first_name || '').trim().slice(0, 60) || (kind === 'lead' ? 'Lead' : 'Customer'),
      familyName: String(row.last_name || '').trim().slice(0, 60),
    }],
    // Stable source pointer — the pre-create reconcile finds a contact this
    // row already minted even when the create response was lost.
    clientData: [{ key: 'waves_row', value: rowTag(table, row) }],
  };
  if (email) body.emailAddresses = [{ value: email }];
  if (phone) body.phoneNumbers = [{ value: phone }];
  if (kind === 'customer' && row.address_line1) {
    body.addresses = [{
      streetAddress: [row.address_line1, row.address_line2].filter(Boolean).join(', '),
      city: row.city || '',
      region: row.state || 'FL',
      postalCode: row.zip || '',
    }];
  }
  return body;
}

const WAVES_GROUPS = ['contactGroups/myContacts', 'contactGroups/starred'];
const UPDATE_FIELDS = 'names,emailAddresses,phoneNumbers,addresses,memberships,clientData';
const CREATE_READ_FIELDS = 'names,metadata';

/**
 * Merge memberships: everything the operator already has on the contact
 * stays; ours (myContacts + starred) are ensured. Replacing the list
 * wholesale would strip operator-managed labels on every sync.
 */
function mergedMemberships(current) {
  const existing = (current || [])
    .filter((m) => m.contactGroupMembership?.contactGroupResourceName)
    .map((m) => ({ contactGroupMembership: { contactGroupResourceName: m.contactGroupMembership.contactGroupResourceName } }));
  const have = new Set(existing.map((m) => m.contactGroupMembership.contactGroupResourceName));
  for (const g of WAVES_GROUPS) {
    if (!have.has(g)) existing.push({ contactGroupMembership: { contactGroupResourceName: g } });
  }
  return existing;
}

/**
 * Conditional stamp. node-postgres materializes timestamps at MILLISECOND
 * precision while Postgres keeps microseconds, so a naive equality on the
 * rebound Date can match zero rows forever. Compare at ms precision and
 * copy the column's own full-precision value into the watermark — an
 * unraced row stamps exactly (updated_at > synced_at goes false); a raced
 * edit fails the ms-truncated comparison and re-syncs next run.
 */
async function stampIfUnchanged(table, row, patch) {
  return db(table)
    .where({ id: row.id })
    .whereRaw("date_trunc('milliseconds', updated_at) <= ?", [row.updated_at])
    .update({ ...patch, google_contact_synced_at: db.raw('updated_at') });
}

/**
 * Verification stamp: same raced-edit guard as stampIfUnchanged, but the
 * watermark advances to the CHECK time — copying the unchanged updated_at
 * back would leave the row eligible again immediately and pin the lane to
 * the same oldest rows forever.
 */
async function stampVerified(table, row, resourceName, now) {
  return db(table)
    .where({ id: row.id })
    .whereRaw("date_trunc('milliseconds', updated_at) <= ?", [row.updated_at])
    .update({ google_contact_id: resourceName, google_contact_synced_at: now });
}

/** True when another LIVE row still references this Google contact. */
async function contactInUseElsewhere(resourceName, exceptTable, exceptId) {
  for (const table of ['customers', 'leads']) {
    let q = db(table)
      .where('google_contact_id', resourceName)
      .whereNull('deleted_at');
    if (table === exceptTable) q = q.whereNot('id', exceptId);
    if (await q.first()) return true;
  }
  return false;
}

/**
 * Adopt a contact THIS ROW already minted (lost create response): search by
 * email/phone and match ONLY the waves_row tag. Our own lost creates always
 * carry the tag, so tag-only matching still covers the replay — while an
 * exact-email match without it could be an OPERATOR-authored contact, and
 * adopting one would overwrite it wholesale and expose it to the
 * no-info/tombstone delete paths. Unowned contacts are never touched.
 * Best-effort — search-index lag can miss a seconds-old contact; the tag
 * makes the NEXT pass reconcile it.
 */
async function findExistingContact(people, row, tag) {
  const email = String(row.email || '').trim().toLowerCase();
  const phone = String(row.phone || '').trim();
  const query = email || phone;
  if (!query) return null;
  try {
    const res = await people.people.searchContacts({
      query,
      pageSize: 10,
      readMask: 'metadata,clientData,emailAddresses',
    });
    const match = (res.data.results || []).map((r) => r.person).find((p) => (
      (p?.clientData || []).some((c) => c.key === 'waves_row' && c.value === tag)
    ));
    return match?.resourceName || null;
  } catch (e) {
    return null; // search is an optimization — creation still proceeds
  }
}

/**
 * Returns { resourceName, created } — `created` marks a GENUINELY fresh
 * Google-side create. Adopted (search-matched) and updated contacts report
 * created: false so compensation logic never deletes something that
 * predates this pass (an exact-email search hit can be an
 * operator-authored contact).
 */
async function upsertContact(people, table, row, kind, gapMs) {
  const body = contactBodyFor(row, kind, table);
  let resourceName = row.google_contact_id;
  if (!resourceName) {
    resourceName = await findExistingContact(people, row, rowTag(table, row));
  }
  if (resourceName) {
    try {
      // updateContact needs the CURRENT etag; memberships are merged from
      // the live contact so operator labels survive.
      const current = await people.people.get({
        resourceName,
        personFields: 'metadata,memberships',
      });
      await sleep(gapMs);
      const updated = await people.people.updateContact({
        resourceName,
        updatePersonFields: UPDATE_FIELDS,
        requestBody: {
          ...body,
          memberships: mergedMemberships(current.data.memberships),
          // The People API REQUIRES the contact source metadata (with its
          // etag) on updates — omitting it 400s every update.
          metadata: current.data.metadata,
          etag: current.data.etag,
        },
      });
      return { resourceName: updated.data.resourceName || resourceName, created: false };
    } catch (err) {
      if (!isGone(err)) throw err;
      // Contact deleted on the Google side — fall through and recreate.
    }
  }
  const created = await people.people.createContact({
    personFields: CREATE_READ_FIELDS,
    requestBody: { ...body, memberships: WAVES_GROUPS.map((g) => ({ contactGroupMembership: { contactGroupResourceName: g } })) },
  });
  return { resourceName: created.data.resourceName || null, created: true };
}

/** Delete tolerating already-gone. */
async function deleteContact(people, resourceName) {
  try {
    await people.people.deleteContact({ resourceName });
  } catch (err) {
    if (!isGone(err)) throw err;
  }
}

/**
 * A lead must not own a contact that belongs to the same person elsewhere:
 * converted leads and customer-email matches defer to the customer row
 * (TRANSFERRING an already-minted contact); a sibling lead (same email or
 * phone) that already holds a contact is adopted so repeat inquiries update
 * one contact.
 */
async function resolveLeadOwnership(row) {
  const email = String(row.email || '').trim().toLowerCase();
  const phone = String(row.phone || '').trim();
  if (row.customer_id) return { deferToCustomer: true, customerId: row.customer_id };
  if (email) {
    const customer = await db('customers')
      .whereRaw('LOWER(email) = ?', [email])
      .whereNull('deleted_at')
      .first();
    if (customer) return { deferToCustomer: true, customerId: customer.id };
  }
  const sibling = await db('leads')
    .whereNot('id', row.id)
    .whereNotNull('google_contact_id')
    .where((q) => {
      if (email) q.orWhereRaw('LOWER(email) = ?', [email]);
      if (phone) q.orWhere('phone', phone);
    })
    .first();
  if (sibling?.google_contact_id) return { adoptContactId: sibling.google_contact_id };
  return {};
}

const SYNC_COLUMNS = ['id', 'first_name', 'last_name', 'email', 'phone', 'google_contact_id', 'updated_at'];

/**
 * One incremental pass. Returns { synced, skipped, failed, retired,
 * verified, blocked } — blocked is set (and NOTHING is stamped) when the
 * gate is off, auth is missing, or the token lacks the contacts scope.
 */
async function runContactsSync({ cap = RUN_CAP, gapMs = WRITE_GAP_MS, now = new Date() } = {}) {
  const counts = { synced: 0, skipped: 0, failed: 0, retired: 0, verified: 0, blocked: null };
  // External-writer gate: preview/dev servers carry real Gmail credentials
  // and cron defaults on outside production — without an explicit owner
  // opt-in this would write copied dev data into the LIVE Google account.
  if (process.env.GATE_CONTACTS_SYNC !== 'true') {
    counts.blocked = 'gate_off';
    return counts;
  }
  const auth = await gmailClient.getAuthClient();
  if (!auth) {
    counts.blocked = 'gmail_not_connected';
    return counts;
  }
  const people = google.people({ version: 'v1', auth });

  const stale = function staleRows() {
    this.whereNull('google_contact_synced_at')
      .orWhereRaw('updated_at > google_contact_synced_at');
  };
  // Newest-first + a reserved lead lane: a fresh inquiry lands in Contacts
  // on the next run even while the historical customer backfill drains
  // (processed rows leave the predicate, so nothing starves).
  const customers = await db('customers')
    .whereNull('deleted_at')
    .where(stale)
    .orderBy('updated_at', 'desc')
    .limit(Math.max(0, cap - LEAD_RESERVE))
    .select(...SYNC_COLUMNS, 'address_line1', 'address_line2', 'city', 'state', 'zip');
  const leadRoom = Math.max(0, cap - customers.length);
  const leads = leadRoom === 0 ? [] : await db('leads')
    .whereNull('deleted_at')
    .where(stale)
    .orderBy('updated_at', 'desc')
    .limit(leadRoom)
    .select(...SYNC_COLUMNS, 'customer_id');
  const customerById = new Map(customers.map((c) => [c.id, c]));

  const work = [
    ...leads.map((row) => ({ table: 'leads', kind: 'lead', row })),
    ...customers.map((row) => ({ table: 'customers', kind: 'customer', row })),
  ];

  for (const { table, kind, row } of work) {
    try {
      const hasContactInfo = !!(String(row.email || '').trim() || String(row.phone || '').trim());
      if (!hasContactInfo) {
        // Nothing publishable. A contact minted earlier must not keep
        // serving data the source row no longer contains — but a SHARED
        // contact (sibling leads) belongs to the surviving rows.
        if (row.google_contact_id && !(await contactInUseElsewhere(row.google_contact_id, table, row.id))) {
          await deleteContact(people, row.google_contact_id);
          await sleep(gapMs);
        }
        await stampIfUnchanged(table, row, { google_contact_id: null });
        counts.skipped += 1;
        continue;
      }
      if (kind === 'lead') {
        const ownership = await resolveLeadOwnership(row);
        if (ownership.deferToCustomer) {
          // The customer row OWNS the contact. Transfer one this lead
          // already minted; the queued in-run customer snapshot is
          // refreshed either way so the customer's own pass in THIS run
          // updates the right contact instead of minting another.
          if (row.google_contact_id) {
            const transferred = await db('customers')
              .where({ id: ownership.customerId })
              .whereNull('google_contact_id')
              .update({ google_contact_id: row.google_contact_id });
            const queued = customerById.get(ownership.customerId);
            if (transferred) {
              if (queued && !queued.google_contact_id) queued.google_contact_id = row.google_contact_id;
            } else {
              const freshCustomer = await db('customers').where({ id: ownership.customerId }).first();
              const customerContact = freshCustomer?.google_contact_id || null;
              if (queued && customerContact) queued.google_contact_id = customerContact;
              // The lead's contact is a duplicate ONLY if the customer owns
              // a different one and no other live row shares the lead's.
              if (customerContact && customerContact !== row.google_contact_id
                && !(await contactInUseElsewhere(row.google_contact_id, table, row.id))) {
                await deleteContact(people, row.google_contact_id);
                await sleep(gapMs);
              }
            }
          }
          await stampIfUnchanged(table, row, { google_contact_id: null });
          counts.skipped += 1;
          continue;
        }
        if (ownership.adoptContactId && !row.google_contact_id) {
          row.google_contact_id = ownership.adoptContactId;
        }
      }
      const { resourceName, created } = await upsertContact(people, table, row, kind, gapMs);
      let stamped = 0;
      try {
        stamped = await stampIfUnchanged(table, row, { google_contact_id: resourceName });
      } catch (stampErr) {
        // The row didn't record the contact — a GENUINELY fresh create
        // would leak a duplicate on retry; roll only that back (adopted or
        // updated contacts predate this pass and are never compensated).
        if (created && resourceName) {
          await deleteContact(people, resourceName).catch(() => {});
        }
        throw stampErr;
      }
      if (!stamped) {
        // A raced edit vetoed the stamp — the same compensation applies:
        // an unrecorded fresh create would duplicate on the retry (search
        // indexing lags), so remove it and let the next run recreate from
        // the fresh row.
        if (created && resourceName) {
          await deleteContact(people, resourceName).catch(() => {});
          await sleep(gapMs);
        }
        logger.info(`[contacts-sync] stamp vetoed by a concurrent edit (${table} ${row.id}) — re-syncing next run`);
        continue;
      }
      counts.synced += 1;
      await sleep(gapMs);
    } catch (err) {
      if (isScopeError(err)) {
        // Token predates the contacts scope — nothing syncs until the
        // owner re-consents once. Abort WITHOUT stamping so every row
        // retries after that.
        counts.blocked = 'contacts_scope_missing';
        logger.warn('[contacts-sync] People API scope missing — waiting on one-time owner re-consent at the admin Gmail auth URL');
        return counts;
      }
      counts.failed += 1;
      logger.warn(`[contacts-sync] sync failed for ${table} ${row.id}: ${safeErr(err)}`);
    }
  }

  // Tombstone lane: soft-deleted rows (customer merges retire the loser
  // with deleted_at + scrambled PII) must not leave their pre-merge PII
  // serving from Google forever. Shared contacts are released, not deleted.
  for (const table of ['customers', 'leads']) {
    let tombstones = [];
    try {
      tombstones = await db(table)
        .whereNotNull('deleted_at')
        .whereNotNull('google_contact_id')
        .limit(TOMBSTONE_SLOTS)
        .select('id', 'google_contact_id');
    } catch (e) {
      logger.warn(`[contacts-sync] tombstone query failed for ${table}: ${safeErr(e)}`);
    }
    for (const row of tombstones) {
      try {
        if (!(await contactInUseElsewhere(row.google_contact_id, table, row.id))) {
          await deleteContact(people, row.google_contact_id);
          await sleep(gapMs);
        }
        // The watermark clears WITH the pointer — a later restore
        // (deleted_at flip only, not a contact-field change) must find the
        // row stale so the restored customer gets a contact again.
        await db(table).where({ id: row.id }).update({ google_contact_id: null, google_contact_synced_at: null });
        counts.retired += 1;
      } catch (err) {
        if (isScopeError(err)) { counts.blocked = 'contacts_scope_missing'; return counts; }
        counts.failed += 1;
        logger.warn(`[contacts-sync] tombstone retire failed for ${table} ${row.id}: ${safeErr(err)}`);
      }
    }
  }

  // Verification lane: external drift (contact deleted, unstarred, label
  // stripped in Google) never advances updated_at, so a bounded batch of
  // the LONGEST-unverified synced rows is re-pushed each run — the upsert
  // path repairs memberships and recreates 404s, and the stamp refreshes
  // the verification watermark. ~7-day full cycle at this budget.
  const verifyCutoff = new Date(now.getTime() - VERIFY_AFTER_DAYS * 86400000);
  const verifyRows = [];
  try {
    const vc = await db('customers')
      .whereNull('deleted_at')
      .whereNotNull('google_contact_id')
      .where('google_contact_synced_at', '<', verifyCutoff)
      .orderBy('google_contact_synced_at', 'asc')
      .limit(VERIFY_SLOTS)
      .select(...SYNC_COLUMNS, 'address_line1', 'address_line2', 'city', 'state', 'zip');
    verifyRows.push(...vc.map((row) => ({ table: 'customers', kind: 'customer', row })));
    if (verifyRows.length < VERIFY_SLOTS) {
      const vl = await db('leads')
        .whereNull('deleted_at')
        .whereNotNull('google_contact_id')
        .where('google_contact_synced_at', '<', verifyCutoff)
        .orderBy('google_contact_synced_at', 'asc')
        .limit(VERIFY_SLOTS - verifyRows.length)
        .select(...SYNC_COLUMNS, 'customer_id');
      verifyRows.push(...vl.map((row) => ({ table: 'leads', kind: 'lead', row })));
    }
  } catch (e) {
    logger.warn(`[contacts-sync] verification query failed: ${safeErr(e)}`);
  }
  for (const { table, kind, row } of verifyRows) {
    try {
      const { resourceName, created } = await upsertContact(people, table, row, kind, gapMs);
      let stamped = 0;
      try {
        stamped = await stampVerified(table, row, resourceName, now);
      } catch (stampErr) {
        // Same fresh-create compensation as the main lane — a 404-recreate
        // whose stamp threw would otherwise leak a replacement per retry.
        if (created && resourceName) {
          await deleteContact(people, resourceName).catch(() => {});
        }
        throw stampErr;
      }
      if (!stamped && created && resourceName) {
        await deleteContact(people, resourceName).catch(() => {});
      }
      if (stamped) counts.verified += 1;
      await sleep(gapMs);
    } catch (err) {
      if (isScopeError(err)) { counts.blocked = 'contacts_scope_missing'; return counts; }
      counts.failed += 1;
      logger.warn(`[contacts-sync] verification failed for ${table} ${row.id}: ${safeErr(err)}`);
    }
  }

  if (counts.synced || counts.failed || counts.retired || counts.verified) {
    logger.info(`[contacts-sync] ${counts.synced} synced, ${counts.skipped} skipped, ${counts.retired} retired, ${counts.verified} verified, ${counts.failed} failed`);
  }
  return counts;
}

module.exports = { runContactsSync };
