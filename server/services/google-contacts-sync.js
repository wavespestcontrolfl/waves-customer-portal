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
 * Rules:
 * - Rows without an email AND without a phone are stamped synced (nothing
 *   to publish; an edit that adds contact info re-queues them via
 *   updated_at).
 * - A lead that converted (customer_id set) or whose email matches a live
 *   customer is stamped WITHOUT its own contact — the customer row owns the
 *   contact. A lead sharing email/phone with a sibling lead that already
 *   holds a contact ADOPTS that contact instead of minting a duplicate.
 * - The stored refresh token may predate the contacts scope: a
 *   scope-insufficiency error aborts the run WITHOUT stamping anything and
 *   reports { blocked } so the scheduler logs it — rows sync after the
 *   owner's one-time re-consent.
 * - People API write budget is ~90/min — writes are throttled and each run
 *   is capped; the backlog drains across runs.
 */
const { google } = require('googleapis');
const db = require('../models/db');
const logger = require('./logger');
const gmailClient = require('./email/gmail-client');

const RUN_CAP = 60; // rows per run — under the People API write budget
const WRITE_GAP_MS = 800;

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

function isScopeError(err) {
  const status = err?.code || err?.response?.status;
  const msg = String(err?.response?.data?.error?.message || err?.message || '');
  return status === 403 && /insufficient|scope|permission/i.test(msg);
}

function contactBodyFor(row, kind) {
  const body = {
    names: [{
      givenName: String(row.first_name || '').slice(0, 60) || (kind === 'lead' ? 'Lead' : 'Customer'),
      familyName: String(row.last_name || '').slice(0, 60),
    }],
    // Starred + myContacts — the "flagged important" the owner asked for.
    memberships: [
      { contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } },
      { contactGroupMembership: { contactGroupResourceName: 'contactGroups/starred' } },
    ],
  };
  if (row.email) body.emailAddresses = [{ value: String(row.email).trim() }];
  if (row.phone) body.phoneNumbers = [{ value: String(row.phone).trim() }];
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

const PERSON_FIELDS = 'names,emailAddresses,phoneNumbers,addresses,memberships';

async function upsertContact(people, row, kind, gapMs) {
  const body = contactBodyFor(row, kind);
  if (row.google_contact_id) {
    try {
      // updateContact needs the CURRENT etag — fetch, then update.
      const current = await people.people.get({
        resourceName: row.google_contact_id,
        personFields: 'metadata',
      });
      await sleep(gapMs);
      const updated = await people.people.updateContact({
        resourceName: row.google_contact_id,
        updatePersonFields: PERSON_FIELDS,
        requestBody: { ...body, etag: current.data.etag },
      });
      return updated.data.resourceName || row.google_contact_id;
    } catch (err) {
      const gone = err.code === 404 || err.response?.status === 404;
      if (!gone) throw err;
      // Contact deleted on the Google side — fall through and recreate.
    }
  }
  const created = await people.people.createContact({
    personFields: PERSON_FIELDS,
    requestBody: body,
  });
  return created.data.resourceName || null;
}

/**
 * A lead must not mint a contact that already exists for the same person:
 * converted leads and customer-email matches defer to the customer row
 * entirely; a sibling lead (same email or phone) that already holds a
 * contact is ADOPTED so repeat inquiries update one contact.
 */
async function resolveLeadOwnership(row) {
  const email = String(row.email || '').trim().toLowerCase();
  const phone = String(row.phone || '').trim();
  if (row.customer_id) return { deferToCustomer: true };
  if (email) {
    const customer = await db('customers')
      .whereRaw('LOWER(email) = ?', [email])
      .whereNull('deleted_at')
      .first();
    if (customer) return { deferToCustomer: true };
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

/**
 * One incremental pass. Returns { synced, skipped, failed, blocked } —
 * blocked is set (and NOTHING is stamped) when auth is missing or the token
 * lacks the contacts scope.
 */
async function runContactsSync({ cap = RUN_CAP, gapMs = WRITE_GAP_MS } = {}) {
  const counts = { synced: 0, skipped: 0, failed: 0, blocked: null };
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
  const customers = await db('customers')
    .whereNull('deleted_at')
    .where(stale)
    .orderBy('updated_at', 'asc')
    .limit(cap)
    .select('id', 'first_name', 'last_name', 'email', 'phone',
      'address_line1', 'address_line2', 'city', 'state', 'zip',
      'google_contact_id');
  const leadRoom = Math.max(0, cap - customers.length);
  const leads = leadRoom === 0 ? [] : await db('leads')
    .whereNull('deleted_at')
    .where(stale)
    .orderBy('updated_at', 'asc')
    .limit(leadRoom)
    .select('id', 'first_name', 'last_name', 'email', 'phone',
      'customer_id', 'google_contact_id');

  const work = [
    ...customers.map((row) => ({ table: 'customers', kind: 'customer', row })),
    ...leads.map((row) => ({ table: 'leads', kind: 'lead', row })),
  ];

  for (const { table, kind, row } of work) {
    try {
      const hasContactInfo = !!(String(row.email || '').trim() || String(row.phone || '').trim());
      if (!hasContactInfo) {
        // Nothing publishable — stamp synced; adding contact info later
        // re-queues the row through updated_at.
        await db(table).where({ id: row.id })
          .update({ google_contact_synced_at: new Date() });
        counts.skipped += 1;
        continue;
      }
      if (kind === 'lead') {
        const ownership = await resolveLeadOwnership(row);
        if (ownership.deferToCustomer) {
          await db(table).where({ id: row.id })
            .update({ google_contact_synced_at: new Date() });
          counts.skipped += 1;
          continue;
        }
        if (ownership.adoptContactId && !row.google_contact_id) {
          row.google_contact_id = ownership.adoptContactId;
        }
      }
      const resourceName = await upsertContact(people, row, kind, gapMs);
      await db(table).where({ id: row.id }).update({
        google_contact_id: resourceName,
        google_contact_synced_at: new Date(),
      });
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
