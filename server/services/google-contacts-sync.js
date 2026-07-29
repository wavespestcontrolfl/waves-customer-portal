/**
 * Google Contacts sync — every customer and every incoming lead becomes a
 * Google Contact in the operator's account (contact@), starred and in
 * myContacts, so Gmail/phone surfaces them as known senders/callers (owner
 * directive 2026-07-28: hands-off, no triage).
 *
 * Shape: row-level sync state (google_contact_id + google_contact_synced_at
 * on customers/leads) + a 10-minute incremental cron. The predicate
 * (synced_at NULL or older than updated_at) makes every run both the
 * incremental pass AND the reconcile — no per-insert hooks across the seven
 * lead-creation sites, no global watermark to corrupt.
 *
 * Safety model:
 * - GATE_CONTACTS_SYNC (default OFF everywhere) — this service WRITES into
 *   the operator's live Google account, and preview/dev environments carry
 *   real Gmail credentials; only prod, explicitly flipped by the owner,
 *   may run it.
 * - All stamps are CONDITIONAL on the row's selected updated_at — an edit
 *   racing the sync loses the stamp and the row re-syncs next run instead
 *   of freezing a stale snapshot.
 * - Creation is recoverable: contacts carry a waves_row clientData tag, a
 *   pre-create search adopts a match (lost-response replay), and a failed
 *   DB stamp rolls the fresh contact back (compensating delete).
 * - One person, one contact: converted leads TRANSFER their contact to the
 *   customer row (or delete the duplicate); repeat-inquiry leads adopt the
 *   sibling lead's contact; rows stripped of all contact info get their
 *   Google contact deleted, not orphaned.
 * - People API write budget is ~90/min — writes are throttled and each run
 *   is capped, with capacity RESERVED for leads so a fresh inquiry never
 *   waits behind the historical customer backfill.
 */
const { google } = require('googleapis');
const db = require('../models/db');
const logger = require('./logger');
const gmailClient = require('./email/gmail-client');

const RUN_CAP = 60; // rows per run — under the People API write budget
const LEAD_RESERVE = 15; // slots leads always get, even mid-backfill
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
 * Merge memberships: everything the operator already has on the contact stays;
 * ours (myContacts + starred) are ensured. Replacing the list wholesale
 * would strip operator-managed labels on every sync.
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

/** Conditional stamp — no-ops (0 rows) when an edit raced this pass. */
async function stampIfUnchanged(table, row, patch) {
  return db(table)
    .where({ id: row.id })
    .where('updated_at', row.updated_at)
    .update({ ...patch, google_contact_synced_at: new Date() });
}

/**
 * Adopt a contact this row (or a lost create) already minted: search by
 * email/phone and match the waves_row tag or an exact email. Best-effort —
 * search-index lag can miss a seconds-old contact; the clientData tag makes
 * the NEXT pass reconcile it.
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
      || (email && (p?.emailAddresses || []).some((e) => String(e.value || '').trim().toLowerCase() === email))
    ));
    return match?.resourceName || null;
  } catch (e) {
    return null; // search is an optimization — creation still proceeds
  }
}

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
          etag: current.data.etag,
        },
      });
      return updated.data.resourceName || resourceName;
    } catch (err) {
      if (!isGone(err)) throw err;
      // Contact deleted on the Google side — fall through and recreate.
    }
  }
  const created = await people.people.createContact({
    personFields: CREATE_READ_FIELDS,
    requestBody: { ...body, memberships: WAVES_GROUPS.map((g) => ({ contactGroupMembership: { contactGroupResourceName: g } })) },
  });
  return created.data.resourceName || null;
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
 * One incremental pass. Returns { synced, skipped, failed, blocked } —
 * blocked is set (and NOTHING is stamped) when the gate is off, auth is
 * missing, or the token lacks the contacts scope.
 */
async function runContactsSync({ cap = RUN_CAP, gapMs = WRITE_GAP_MS } = {}) {
  const counts = { synced: 0, skipped: 0, failed: 0, blocked: null };
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

  const work = [
    ...leads.map((row) => ({ table: 'leads', kind: 'lead', row })),
    ...customers.map((row) => ({ table: 'customers', kind: 'customer', row })),
  ];

  for (const { table, kind, row } of work) {
    try {
      const hasContactInfo = !!(String(row.email || '').trim() || String(row.phone || '').trim());
      if (!hasContactInfo) {
        // Nothing publishable. A contact minted earlier must not keep
        // serving data the source row no longer contains — delete it.
        if (row.google_contact_id) {
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
          // already minted; if the customer already has its own, the
          // lead's is a duplicate — remove it.
          if (row.google_contact_id) {
            const transferred = await db('customers')
              .where({ id: ownership.customerId })
              .whereNull('google_contact_id')
              .update({ google_contact_id: row.google_contact_id });
            if (!transferred) {
              await deleteContact(people, row.google_contact_id);
              await sleep(gapMs);
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
      const hadContactId = row.google_contact_id;
      const resourceName = await upsertContact(people, table, row, kind, gapMs);
      try {
        await stampIfUnchanged(table, row, { google_contact_id: resourceName });
      } catch (stampErr) {
        // The row didn't record the contact — a FRESH create would leak a
        // duplicate on retry; roll it back (adopted/updated contacts stay).
        if (!hadContactId && resourceName) {
          await deleteContact(people, resourceName).catch(() => {});
        }
        throw stampErr;
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
      logger.warn(`[contacts-sync] sync failed for ${table} ${row.id}: ${err.message}`);
    }
  }
  if (counts.synced || counts.failed) {
    logger.info(`[contacts-sync] ${counts.synced} synced, ${counts.skipped} skipped, ${counts.failed} failed`);
  }
  return counts;
}

module.exports = { runContactsSync };
