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
// Row marker for an AMBIGUOUS createContact failure (Google may have created
// before the error surfaced). A marked row re-enters every pass but only
// creates again after a CONCLUSIVE tag search plus a grace window for search
// indexing — a lagging index must never read as "no orphan exists".
const PENDING_CREATE = 'pending_create_recovery';
const RECOVERY_GRACE_MS = 3600000;

/**
 * Marker format: 'pending_create_recovery[:priorId[:encodedSearchKey]]'.
 * priorId = the dead resource the replacement was for (sharer repoint);
 * searchKey = the identity used AT CREATE TIME — a later merge can scramble
 * the row's email/phone (customer-dedupe), and recovery must search Google
 * by what the orphan actually contains, not the scrambled values.
 */
const isPendingMarker = (v) => typeof v === 'string' && v.startsWith(PENDING_CREATE);
const pendingMarkerFor = (priorId, searchKey) => `${PENDING_CREATE}:${priorId || ''}:${encodeURIComponent(searchKey || '')}`;
const priorIdFromMarker = (v) => {
  if (!isPendingMarker(v)) return null;
  const parts = v.split(':');
  // resource names look like 'people/x' — no ':' inside.
  return parts[1] || null;
};
const searchKeyFromMarker = (v) => {
  if (!isPendingMarker(v)) return null;
  const parts = v.split(':');
  return parts[2] ? decodeURIComponent(parts[2]) : null;
};
/**
 * Retirement marker: 'pending_retire_recovery:people/x'. Written in place of
 * the pointer BEFORE the external delete — a crash mid-retirement leaves a
 * durable record of WHICH contact still needs deleting instead of an
 * orphaned contact with a nulled pointer.
 */
const PENDING_RETIRE = 'pending_retire_recovery';
const isRetireMarker = (v) => typeof v === 'string' && v.startsWith(PENDING_RETIRE);
const retireMarkerFor = (resourceId) => `${PENDING_RETIRE}:${resourceId}`;
const retireIdFromMarker = (v) => (isRetireMarker(v) && v.length > PENDING_RETIRE.length + 1
  ? v.slice(PENDING_RETIRE.length + 1) : null);

const rowSearchKey = (row) => {
  // The create request publishes the CANONICAL identity when one is loaded
  // — the recovery key must match what the orphan actually contains, not a
  // stale property copy (presence semantics incl. canonical nulls).
  const hasCanon = !!row.__canonicalIdentity;
  const src = row.__canonicalIdentity || row;
  const email = String((hasCanon ? src.email : row.email) || '').trim().toLowerCase();
  const phone = String((hasCanon ? src.phone : row.phone) || '').trim();
  const name = `${String((hasCanon ? src.first_name : row.first_name) || '').trim()} ${String((hasCanon ? src.last_name : row.last_name) || '').trim()}`.trim();
  return email || phone || name;
};

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
 * Revoked/expired Google credentials (invalid_grant etc.) fail EVERY row —
 * treating them as per-row errors would park rows and slowly turn job
 * health green while nothing syncs. They block the whole run instead, and
 * no watermark moves.
 */
function isAuthError(err) {
  const status = err?.code || err?.response?.status;
  const raw = err?.response?.data || {};
  const msg = `${raw.error || ''} ${raw.error_description || ''} ${err?.message || ''}`;
  return status === 401
    || /invalid_grant|invalid_rapt|unauthorized_client|invalid_credentials|expired or revoked/i.test(msg);
}

/**
 * The People API being disabled for the project (SERVICE_DISABLED /
 * accessNotConfigured) is a deterministic 403 that fails EVERY row — a
 * systemic configuration state, not a row problem. Parking rows on it would
 * strand the whole backfill invisibly once the API is enabled.
 */
function isServiceDisabledError(err) {
  const status = err?.code || err?.response?.status;
  if (status !== 403) return false;
  const reason = String(err?.response?.data?.error?.status || '');
  const msg = String(err?.response?.data?.error?.message || err?.message || '');
  const details = JSON.stringify(err?.response?.data?.error?.details || '');
  return /SERVICE_DISABLED|accessNotConfigured|has not been used in project|is disabled/i.test(`${reason} ${msg} ${details}`);
}

/**
 * Retryable 4xx: throttling and quota exhaustion recover on their own —
 * parking those rows would strand them (a new row with no contact never
 * re-enters any lane without an edit).
 */
function isRetryable4xx(err) {
  const status = err?.code || err?.response?.status;
  // 401 (auth refresh), 408/429 (throttling), 409/412 (etag/precondition
  // conflicts) all recover on their own — only payload-validation
  // rejections are deterministic enough to park.
  if (status === 401 || status === 408 || status === 409 || status === 412 || status === 429) return true;
  const msg = String(err?.response?.data?.error?.message || err?.message || '');
  const reason = String(err?.response?.data?.error?.status || '');
  // The People API reports a stale-etag conflict as 400 FAILED_PRECONDITION
  // (not 409/412) — an operator editing the contact mid-sync is transient.
  if (status === 400 && /FAILED_PRECONDITION|precondition/i.test(`${msg} ${reason}`)) return true;
  return status === 403 && /rate|quota|exhaust/i.test(`${msg} ${reason}`);
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
  // Shared ACCOUNT contacts publish the account's canonical identity — the
  // per-property row's copy can be stale, and letting whichever sibling
  // syncs last overwrite names/email/phone made the contact flap. Once a
  // canonical identity is loaded its fields are authoritative INCLUDING
  // nulls: an admin clearing the account email must not have a sibling's
  // stale property copy republish it.
  const hasCanonical = !!row.__canonicalIdentity;
  const identity = row.__canonicalIdentity || row;
  const email = String((hasCanonical ? identity.email : row.email) || '').trim();
  const phone = String((hasCanonical ? identity.phone : row.phone) || '').trim();
  const body = {
    names: [{
      givenName: String((hasCanonical ? identity.first_name : row.first_name) || '').trim().slice(0, 60) || (kind === 'lead' ? 'Lead' : 'Customer'),
      familyName: String((hasCanonical ? identity.last_name : row.last_name) || '').trim().slice(0, 60),
    }],
    // Stable source pointer — the pre-create reconcile finds a contact this
    // row already minted even when the create response was lost.
    clientData: [{ key: 'waves_row', value: rowTag(table, row) }],
  };
  if (email) body.emailAddresses = [{ value: email, type: WAVES_FIELD_TYPE }];
  if (phone) body.phoneNumbers = [{ value: phone, type: WAVES_FIELD_TYPE }];
  const addressRows = row.__accountAddresses
    || (kind === 'customer' && row.address_line1 ? [row] : []);
  if (addressRows.length) {
    body.addresses = addressRows.map((a) => ({
      streetAddress: [a.address_line1, a.address_line2].filter(Boolean).join(', '),
      city: a.city || '',
      region: a.state || 'FL',
      postalCode: a.zip || '',
      type: WAVES_FIELD_TYPE,
    }));
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
/**
 * Merge multi-valued fields: OUR values lead (canonical identity), values
 * the operator added directly in Google Contacts survive. The update mask
 * replaces these fields wholesale, so sending only ours deleted secondary
 * emails/phones/addresses every sync. Residual trade-off: a value we
 * ourselves published historically is indistinguishable from an
 * operator-added one, so clearing a canonical field demotes its old value
 * to a preserved secondary rather than removing it from Google.
 */
const WAVES_FIELD_TYPE = 'Waves CRM';
function mergeValueLists(ours, existing, keyFn) {
  const ourKeys = new Set((ours || []).map(keyFn).filter(Boolean));
  const preserved = (existing || []).filter((e) => {
    // Entries WE published carry the Waves type — when they leave our
    // canonical set (retired property address, changed email) they must
    // drop, not accumulate as fake operator data. Untyped/other-typed
    // entries are genuinely operator-added and survive.
    if (e?.type === WAVES_FIELD_TYPE) return false;
    const k = keyFn(e);
    return k && !ourKeys.has(k);
  });
  return [...(ours || []), ...preserved];
}
const emailValueKey = (e) => String(e?.value || '').trim().toLowerCase();
const phoneValueKey = (e) => String(e?.value || '').replace(/\D/g, '').slice(-10);
const addressValueKey = (a) => `${String(a?.streetAddress || '').trim().toLowerCase()}|${String(a?.postalCode || '').trim()}`;

/**
 * Merge clientData: entries owned by OTHER integrations survive; only the
 * Waves waves_row key is replaced. The update mask includes clientData, so
 * sending only our entry would silently delete everyone else's linkage
 * metadata.
 */
function mergedClientData(current, tagValue) {
  const others = (current || []).filter((c) => c && c.key !== 'waves_row');
  return [...others, { key: 'waves_row', value: tagValue }];
}

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
/** Row-level raced-edit guard (µs token when selected, ms fallback). */
function applyRowGuard(q, row) {
  if (row.updated_at_us) {
    q.whereRaw("to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.US') = ?", [row.updated_at_us]);
  } else {
    q.whereRaw("date_trunc('milliseconds', updated_at) <= ?", [row.updated_at]);
  }
  return q;
}

const STAMP_VETO = Symbol('stampVeto');

/**
 * Guarded stamp in ONE transaction. The account re-read runs FOR SHARE:
 * an UNCOMMITTED direct account correction holds its row lock, so we
 * BLOCK until it commits and then see its real updated_at — plain
 * timestamp comparison can't observe an uncommitted writer (MVCC reads
 * the old version), and its now() is transaction-start time, so it could
 * commit BEHIND our new watermark and never requeue.
 *
 * LOCK ORDER: the target row's exclusive lock (the UPDATE) comes FIRST
 * and the account lock second — the admin identity path locks the
 * customer row and then touches the account (admin-customers PUT +
 * account-identity trigger), and taking the account lock first here
 * would deadlock against it. A stale-account veto therefore has to ROLL
 * BACK the already-applied stamp instead of skipping it.
 */
async function guardedStamp(table, row, patch, { repoint = null } = {}) {
  try {
    return await db.transaction(async (trx) => {
      const q = applyRowGuard(trx(table).where({ id: row.id }), row);
      const n = await q.update(patch);
      if (n && row.__canonicalIdentity?.id) {
        const acc = await trx('customer_accounts')
          .where({ id: row.__canonicalIdentity.id })
          .select(trx.raw(US_TOKEN))
          .forShare()
          .first();
        const expected = row.__canonicalIdentity.updated_at_us || null;
        const veto = new Error('canonical account changed mid-stamp');
        veto[STAMP_VETO] = true;
        if (acc && expected && acc.updated_at_us !== expected) throw veto;
        if (acc && !expected && row.__canonicalIdentity.updated_at
          && new Date(acc.updated_at_us ? acc.updated_at_us.replace(' ', 'T') : 0).getTime()
            > new Date(row.__canonicalIdentity.updated_at).getTime() + 1) throw veto;
      }
      if (n && repoint && repoint.from && repoint.from !== repoint.to) {
        // ATOMIC sharer repoint: a crash between a committed stamp and a
        // separate repoint pass would erase the durable marker while
        // sharers still hold the dead id — each would then 404, search for
        // its OWN tag (absent: the replacement carries the creator's) and
        // permanently mint a duplicate. One transaction makes it
        // stamp-and-repoint or neither; a veto/rollback leaves the marker
        // for the next run's recovery.
        for (const t of ['customers', 'leads']) {
          await trx(t).where('google_contact_id', repoint.from)
            .update({ google_contact_id: repoint.to });
        }
      }
      return n;
    });
  } catch (err) {
    if (err && err[STAMP_VETO]) return 0;
    throw err;
  }
}

async function stampIfUnchanged(table, row, patch, opts) {
  // GREATEST(updated_at, now()) — DB-side clock, skew-free: the watermark
  // must also cover the ACCOUNT staleness clause (ca.updated_at compares
  // against it), and copying updated_at alone would loop account-stale rows
  // forever.
  return guardedStamp(table, row, { ...patch, google_contact_synced_at: db.raw('GREATEST(updated_at, now())') }, opts);
}

/**
 * Verification stamp: same raced-edit guard as stampIfUnchanged, but the
 * watermark advances to the CHECK time — copying the unchanged updated_at
 * back would leave the row eligible again immediately and pin the lane to
 * the same oldest rows forever.
 */
async function stampVerified(table, row, resourceName, now, opts) {
  return guardedStamp(table, row, { google_contact_id: resourceName, google_contact_synced_at: now }, opts);
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
/**
 * Conclusive fallback for truncated searches: page the full connections
 * list and match our waves_row tag. connections.list reads the primary
 * contact store (creates appear immediately) — unlike searchContacts's
 * lagging cache — so an absent tag here is proof, not lag.
 */
async function findByTagFullScan(people, tag) {
  let pageToken;
  do {
    const res = await people.people.connections.list({
      resourceName: 'people/me',
      pageSize: 1000,
      personFields: 'metadata,clientData',
      ...(pageToken ? { pageToken } : {}),
    });
    const hit = (res.data.connections || []).find((p) => (
      (p?.clientData || []).some((c) => c.key === 'waves_row' && c.value === tag)
    ));
    if (hit?.resourceName) return hit.resourceName;
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return null;
}

async function findExistingContact(people, row, tag, { queryOverride = null, requireConclusive = false } = {}) {
  // queryOverride = the CREATE-TIME identity from a recovery marker — the
  // row's current values may have been scrambled by a merge since.
  const query = queryOverride || rowSearchKey(row);
  if (!query) return null;
  try {
    // Documented People API behavior: searchContacts serves a lagging
    // cache until an empty-query WARMUP primes it — an empty result from
    // an UNWARMED cache is meaningless for duplicate-recovery decisions,
    // so a failed warmup is itself inconclusive (propagates via the catch
    // below).
    await people.people.searchContacts({ query: '', pageSize: 1, readMask: 'names' });
    const res = await people.people.searchContacts({
      query,
      pageSize: 30, // searchContacts maximum — no pagination exists
      readMask: 'metadata,clientData,emailAddresses',
    });
    const results = res.data.results || [];
    const match = results.map((r) => r.person).find((p) => (
      (p?.clientData || []).some((c) => c.key === 'waves_row' && c.value === tag)
    ));
    if (match?.resourceName) return match.resourceName;
    if (results.length >= 30 && requireConclusive) {
      // A FULL result set is a truncated one — absence of the tag among
      // the first 30 hits is not proof no tagged contact exists. Only
      // RECOVERY decisions demand that proof; a first-time create with a
      // common name has no lost contact to find. A common recovery key
      // (e.g. a frequent name) can stay truncated on EVERY run — treating
      // that as inconclusive forever would park the row in recovery and
      // fail the job indefinitely, so fall through to a conclusive
      // full-list scan of connections matched by our tag (the primary
      // store, not the lagging search cache).
      const scanned = await findByTagFullScan(people, tag);
      return scanned || null;
    }
    return null;
  } catch (e) {
    // Scope, AUTH, and service-disabled errors keep their classification —
    // the run must surface the actionable blocked status, not N generic
    // row failures.
    if (isScopeError(e) || isAuthError(e) || isServiceDisabledError(e)) throw e;
    // Any other INCONCLUSIVE search must defer creation — creating past a
    // failed orphan check is how duplicates leak. The row retries next run.
    const err = new Error('contact search inconclusive — creation deferred');
    err.searchInconclusive = true;
    throw err;
  }
}

/**
 * Returns { resourceName, created } — `created` marks a GENUINELY fresh
 * Google-side create. Adopted (search-matched) and updated contacts report
 * created: false so compensation logic never deletes something that
 * predates this pass (an exact-email search hit can be an
 * operator-authored contact).
 */
async function upsertContact(people, table, row, kind, gapMs, { markerSearchKey = null, markerPriorId = null } = {}) {
  const body = contactBodyFor(row, kind, table);
  let resourceName = row.google_contact_id;
  if (!resourceName && !row.__releasedShared) {
    // A row that just RELEASED a shared contact must mint its own — the
    // released contact may still carry this row's stale waves_row tag (we
    // were the last to push it), and tag adoption would re-seize the other
    // person's contact.
    resourceName = await findExistingContact(people, row, rowTag(table, row), { queryOverride: markerSearchKey });
  }
  for (let attempt = 0; resourceName && attempt < 2; attempt += 1) {
    try {
      // updateContact needs the CURRENT etag; memberships are merged from
      // the live contact so operator labels survive.
      const current = await people.people.get({
        resourceName,
        personFields: 'metadata,memberships,clientData,emailAddresses,phoneNumbers,addresses',
      });
      await sleep(gapMs);
      const updated = await people.people.updateContact({
        resourceName,
        updatePersonFields: UPDATE_FIELDS,
        requestBody: {
          ...body,
          // Operator-added values survive; ours lead. names stay
          // canonical-authoritative (single-valued identity).
          emailAddresses: mergeValueLists(body.emailAddresses, current.data.emailAddresses, emailValueKey),
          phoneNumbers: mergeValueLists(body.phoneNumbers, current.data.phoneNumbers, phoneValueKey),
          addresses: mergeValueLists(body.addresses, current.data.addresses, addressValueKey),
          clientData: mergedClientData(current.data.clientData, rowTag(table, row)),
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
      // Contact deleted on the Google side. Before minting a replacement,
      // search by OUR tag — a prior pass may already have replaced it
      // (lost response, partial sharer repoint) and creating again would
      // duplicate. Found → retry the update against the replacement.
      const deadId = resourceName;
      const replacement = await findExistingContact(people, row, rowTag(table, row), { queryOverride: markerSearchKey, requireConclusive: true });
      if (!replacement || replacement === deadId) {
        // A SHARER's replacement may be mid-recovery: its ambiguous-create
        // marker carries this dead id. Racing it would mint a parallel
        // replacement — defer until that recovery resolves.
        for (const t of ['customers', 'leads']) {
          const carrier = await db(t)
            .where('google_contact_id', 'like', `${PENDING_CREATE}:${deadId}:%`)
            .first();
          if (carrier) {
            const deferErr = new Error('sharer replacement mid-recovery — deferring');
            deferErr.searchInconclusive = true;
            throw deferErr;
          }
        }
      }
      resourceName = (replacement && replacement !== deadId) ? replacement : null;
    }
  }
  // Durable PRE-create claim: a crash after Google commits the create but
  // before the stamp leaves no catch-path marker, so the next run would
  // replay this as a FIRST-TIME create — no conclusive search demanded —
  // and a truncated 30-result search can hide the committed contact,
  // minting a duplicate. Claim first (attempt time in the watermark); the
  // conditional may replace NULL, the row's known (dead) resource id, or
  // an existing marker — a repeated recovery create must refresh the
  // attempt timestamp or the next pass would trust a lagging search. The
  // prior dead id survives via markerPriorId.
  const claimMarker = pendingMarkerFor(row.google_contact_id || markerPriorId, markerSearchKey || rowSearchKey(row));
  const claimed = await db(table).where({ id: row.id })
    .where((q) => {
      q.whereNull('google_contact_id');
      if (row.google_contact_id) q.orWhere('google_contact_id', row.google_contact_id);
      q.orWhere('google_contact_id', 'like', `${PENDING_CREATE}%`);
    })
    .update({ google_contact_id: claimMarker, google_contact_synced_at: new Date() });
  if (!claimed) {
    // The pointer moved under us — creating anyway could double-mint.
    const raced = new Error('pre-create claim lost to a concurrent edit — deferred');
    raced.searchInconclusive = true;
    throw raced;
  }
  let created;
  try {
    created = await people.people.createContact({
      personFields: CREATE_READ_FIELDS,
      requestBody: { ...body, memberships: WAVES_GROUPS.map((g) => ({ contactGroupMembership: { contactGroupResourceName: g } })) },
    });
  } catch (createErr) {
    // A definitive 4xx (validation, scope, permission) means Google did
    // NOT create — roll the claim back so the row doesn't serve a
    // pointless conclusive-search grace window. Genuinely AMBIGUOUS
    // failures (network, 5xx, 408 timeouts that may have reached Google)
    // KEEP the claim, which now carries the attempt time.
    const status = createErr?.code || createErr?.response?.status;
    const definitiveRejection = typeof status === 'number' && status >= 400 && status < 500 && status !== 408;
    if (definitiveRejection) {
      await db(table).where({ id: row.id, google_contact_id: claimMarker })
        .update({
          google_contact_id: row.google_contact_id || null,
          google_contact_synced_at: row.google_contact_synced_at || null,
        })
        .catch(() => {});
    }
    throw createErr;
  }
  return { resourceName: created.data.resourceName || null, created: true };
}

/**
 * Duplicate retirement WITHOUT losing operator-managed data: merge the
 * duplicate's emails/phones/addresses and group memberships into the
 * surviving contact, then delete it. Deletion is REFUSED (returns false,
 * duplicate retained, row keeps pointing at it) when: the duplicate
 * carries operator fields we cannot merge (notes, organizations,
 * birthdays, URLs, events, relations, nicknames, custom fields, foreign
 * clientData), the SURVIVOR is missing (deleting the duplicate would
 * destroy the person's only remaining contact), or the merge write
 * fails. A lingering duplicate is recoverable on the next pass; deleted
 * operator data is not.
 */
const UNMERGEABLE_FIELDS = ['organizations', 'biographies', 'birthdays', 'urls', 'events', 'relations', 'nicknames', 'userDefined', 'imClients', 'sipAddresses'];

async function absorbDuplicate(people, dupId, survivorId, gapMs) {
  let dup;
  try {
    dup = await people.people.get({
      resourceName: dupId,
      personFields: `metadata,memberships,clientData,emailAddresses,phoneNumbers,addresses,${UNMERGEABLE_FIELDS.join(',')}`,
    });
  } catch (e) {
    if (isScopeError(e) || isAuthError(e) || isServiceDisabledError(e)) throw e;
    if (isGone(e)) {
      // The DUPLICATE is already gone — nothing to preserve, nothing to
      // delete. (Only a dup-side 404 may take this path: a missing
      // SURVIVOR must never green-light deleting the last contact.)
      await deleteContact(people, dupId);
      return true;
    }
    logger.warn(`[contacts-sync] duplicate ${dupId} RETAINED — fetch failed: ${safeErr(e)}`);
    return false;
  }
  const foreignClientData = (dup.data.clientData || []).some((c) => c.key !== 'waves_row');
  const unmergeable = foreignClientData
    || UNMERGEABLE_FIELDS.some((f) => Array.isArray(dup.data[f]) && dup.data[f].length > 0);
  if (unmergeable) {
    logger.warn(`[contacts-sync] duplicate ${dupId} RETAINED — carries operator fields the merge cannot preserve`);
    return false;
  }
  try {
    const survivor = await people.people.get({
      resourceName: survivorId,
      personFields: 'metadata,memberships,clientData,emailAddresses,phoneNumbers,addresses',
    });
    await sleep(gapMs);
    await people.people.updateContact({
      resourceName: survivorId,
      updatePersonFields: 'emailAddresses,phoneNumbers,addresses,memberships',
      requestBody: {
        emailAddresses: mergeValueLists(survivor.data.emailAddresses, dup.data.emailAddresses, emailValueKey),
        phoneNumbers: mergeValueLists(survivor.data.phoneNumbers, dup.data.phoneNumbers, phoneValueKey),
        addresses: mergeValueLists(survivor.data.addresses, dup.data.addresses, addressValueKey),
        memberships: mergedMemberships([...(survivor.data.memberships || []), ...(dup.data.memberships || [])]),
        metadata: survivor.data.metadata,
        etag: survivor.data.etag,
      },
    });
    await sleep(gapMs);
  } catch (e) {
    // Systemic failures keep their classification for the run-level abort.
    if (isScopeError(e) || isAuthError(e) || isServiceDisabledError(e)) throw e;
    // A missing survivor, a raced etag, or any other merge failure all
    // RETAIN the duplicate — it may be the person's only surviving
    // contact, and ownership re-resolves on the next pass either way.
    logger.warn(`[contacts-sync] duplicate ${dupId} RETAINED — merge into ${survivorId} failed: ${safeErr(e)}`);
    return false;
  }
  await deleteContact(people, dupId);
  return true;
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
  if (row.customer_id) {
    // leads.customer_id has no FK — a dangling or tombstoned link must not
    // defer the lead into oblivion (stamped null, contact orphaned).
    const linked = await db('customers')
      .where({ id: row.customer_id })
      .whereNull('deleted_at')
      .first();
    if (linked) return { deferToCustomer: true, customerId: linked.id };
  }
  if (email) {
    // Match the property copy AND the linked canonical account email —
    // direct account corrections deliberately don't fan back to property
    // rows, so a lead using the corrected email must still defer.
    const customer = await db('customers')
      .whereNull('deleted_at')
      .where((q) => {
        q.whereRaw('LOWER(email) = ?', [email])
          .orWhereRaw(
            'EXISTS (SELECT 1 FROM customer_accounts ca WHERE ca.id = customers.account_id AND LOWER(ca.email) = ?)',
            [email],
          );
      })
      .first();
    if (customer) return { deferToCustomer: true, customerId: customer.id };
  }
  // Name-only leads have NO safe identity key — an empty predicate group
  // would match ANY contact-holding lead and adopt (then overwrite) an
  // unrelated person's contact. They always mint their own.
  const phoneDigits = phone.replace(/\D/g, '').slice(-10);
  if (!email && phoneDigits.length < 7) return {};
  const nameOf = (r) => `${String(r.first_name || '').trim()} ${String(r.last_name || '').trim()}`.trim().toLowerCase();
  const rowName = nameOf(row);
  const phoneSuffixMatch = (q, col) => q.whereRaw(
    `(RIGHT(regexp_replace(${col}, '\\D', '', 'g'), ?) = ?`
    + ` OR (LENGTH(regexp_replace(${col}, '\\D', '', 'g')) BETWEEN 7 AND 9`
    + ` AND RIGHT(?, LENGTH(regexp_replace(${col}, '\\D', '', 'g'))) = regexp_replace(${col}, '\\D', '', 'g')))`,
    [phoneDigits.length, phoneDigits, phoneDigits],
  );
  if (!email && phoneDigits.length >= 7) {
    // PHONE-ONLY leads (supported by manual creation) must still defer to
    // an existing customer on the same number — the email guard above
    // never ran, and minting here would double-contact the person. Same
    // compatibility rules as the sibling probe below: a shared household
    // number with a CONFLICTING name stays a separate lead.
    const phoneCustomer = await phoneSuffixMatch(
      db('customers').whereNull('deleted_at'),
      'phone',
    )
      .where((q) => {
        if (rowName) q.whereRaw("(TRIM(CONCAT_WS(' ', first_name, last_name)) = '' OR LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = ?)", [rowName]);
      })
      .select('id', 'email', 'first_name', 'last_name')
      .first();
    if (phoneCustomer) {
      const namesConflict = !!(rowName && nameOf(phoneCustomer) && rowName !== nameOf(phoneCustomer));
      if (!namesConflict) return { deferToCustomer: true, customerId: phoneCustomer.id };
    }
  }
  const siblingBase = () => db('leads')
    .whereNot('id', row.id)
    .whereNull('deleted_at')
    .whereNotNull('google_contact_id')
    .whereNot('google_contact_id', 'like', `${PENDING_CREATE}%`)
    .whereNot('google_contact_id', 'like', `${PENDING_RETIRE}%`);
  // Email equality is the strong identity — adopt directly.
  if (email) {
    const emailSibling = await siblingBase().whereRaw('LOWER(email) = ?', [email]).first();
    if (emailSibling?.google_contact_id) return { adoptContactId: emailSibling.google_contact_id };
  }
  // A shared phone alone is NOT identity when stronger fields disagree —
  // lead ingestion deliberately keeps separate leads on household/business
  // numbers (see lead-from-extraction's name-conflict guard).
  if (phoneDigits.length >= 7) {
    // Compatibility lives IN the query so a household number with several
    // people's contacts still finds the COMPATIBLE sibling instead of
    // giving up on whichever arbitrary row came first.
    const phoneSibling = await siblingBase()
      // Suffix comparison at the ACCEPTED length in both directions — a
      // legacy 7–9 digit local number must match its full 10-digit form.
      .whereRaw(
        "(RIGHT(regexp_replace(phone, '\\D', '', 'g'), ?) = ?"
        + " OR (LENGTH(regexp_replace(phone, '\\D', '', 'g')) BETWEEN 7 AND 9"
        + " AND RIGHT(?, LENGTH(regexp_replace(phone, '\\D', '', 'g'))) = regexp_replace(phone, '\\D', '', 'g')))",
        [phoneDigits.length, phoneDigits, phoneDigits]
      )
      .where((q) => {
        if (email) q.whereRaw("(email IS NULL OR TRIM(email) = '' OR LOWER(TRIM(email)) = ?)", [email]);
        if (rowName) q.whereRaw("(TRIM(CONCAT_WS(' ', first_name, last_name)) = '' OR LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = ?)", [rowName]);
      })
      .select('id', 'google_contact_id', 'email', 'first_name', 'last_name')
      .first();
    if (phoneSibling?.google_contact_id) {
      // Defense-in-depth re-check of the same compatibility rules.
      const sibEmail = String(phoneSibling.email || '').trim().toLowerCase();
      const emailsDisagree = !!(email && sibEmail && sibEmail !== email);
      const namesConflict = !!(rowName && nameOf(phoneSibling) && rowName !== nameOf(phoneSibling));
      if (!emailsDisagree && !namesConflict) return { adoptContactId: phoneSibling.google_contact_id };
    }
  }
  return {};
}

const SYNC_COLUMNS = ['id', 'first_name', 'last_name', 'email', 'phone', 'google_contact_id', 'updated_at'];
// Microsecond-precision concurrency token: node-postgres Dates are
// millisecond-truncated, so a same-millisecond raced edit would pass a
// ms-level guard and get stamped over. Selected as text, compared as text.
const US_TOKEN = "to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS.US') as updated_at_us";

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
      .orWhereRaw('updated_at > google_contact_synced_at')
      // Ambiguous-create rows re-enter every pass until recovery resolves.
      .orWhere('google_contact_id', 'like', `${PENDING_CREATE}%`);
  };
  // Newest-first + a reserved lead lane: a fresh inquiry lands in Contacts
  // on the next run even while the historical customer backfill drains
  // (processed rows leave the predicate, so nothing starves).
  const customers = await db('customers')
    .whereNull('deleted_at')
    .where((q) => {
      stale.call(q, q);
      // Canonical identity edits requeue linked rows via the ACCOUNT
      // watermark — any writer, no trigger fan-out, no inverted lock
      // order (the old accounts→customers bump could deadlock concurrent
      // property edits).
      q.orWhereRaw('(customers.account_id IS NOT NULL AND EXISTS ('
        + 'SELECT 1 FROM customer_accounts ca WHERE ca.id = customers.account_id'
        + ' AND (customers.google_contact_synced_at IS NULL OR ca.updated_at > customers.google_contact_synced_at)))');
    })
    .orderBy('updated_at', 'desc')
    .limit(Math.max(0, cap - LEAD_RESERVE))
    .select(...SYNC_COLUMNS, db.raw(US_TOKEN), 'account_id', 'address_line1', 'address_line2', 'city', 'state', 'zip');
  const leadRoom = Math.max(0, cap - customers.length);
  const leads = leadRoom === 0 ? [] : await db('leads')
    .whereNull('deleted_at')
    .where(stale)
    .orderBy('updated_at', 'desc')
    .limit(leadRoom)
    .select(...SYNC_COLUMNS, db.raw(US_TOKEN), 'customer_id');
  const customerById = new Map(customers.map((c) => [c.id, c]));

  const work = [
    ...leads.map((row) => ({ table: 'leads', kind: 'lead', row })),
    ...customers.map((row) => ({ table: 'customers', kind: 'customer', row })),
  ];
  // Dead-id → replacement mapping for THIS run: rows loaded before a
  // sharer's 404-recreate still hold the dead resource in memory; without
  // this, each of them would 404 again and mint its own replacement.
  const repointedThisRun = new Map();

  for (const { table, kind, row } of work) {
    try {
      // Ambiguous-create marker: not a real resource name. Cleared here so
      // NOTHING below (transfer, delete, update) treats it as one; the
      // create path gets the recovery context instead.
      if (isRetireMarker(row.google_contact_id)) {
        // A retirement interrupted by a RESTORE: the marked contact was
        // never deleted (the locked tombstone check vetoed) and may carry
        // operator-managed labels/secondary details — deleting it here to
        // mint a lesser copy would burn that data. Unwrap the marker and
        // let the normal update path refresh the contact; if the external
        // delete DID land before the interruption, the 404 path replaces
        // it. A bare marker (no id) clears to a fresh create.
        const retiring = retireIdFromMarker(row.google_contact_id);
        const reclaimed = await db(table).where({ id: row.id, google_contact_id: row.google_contact_id })
          .update({ google_contact_id: retiring });
        if (!reclaimed) {
          counts.skipped += 1; // concurrent edit — re-resolve next tick
          continue;
        }
        row.google_contact_id = retiring;
      }
      const pendingRecovery = isPendingMarker(row.google_contact_id);
      const recoveryAttemptAt = pendingRecovery ? row.google_contact_synced_at : null;
      const markerPriorId = pendingRecovery ? priorIdFromMarker(row.google_contact_id) : null;
      const markerSearchKey = pendingRecovery ? searchKeyFromMarker(row.google_contact_id) : null;
      if (pendingRecovery) {
        row.google_contact_id = null;
        // Resolve the maybe-committed create BEFORE any shortcut (defer,
        // no-info, adoption) can erase the marker — an orphan would keep
        // its PII while a duplicate gets minted elsewhere. Found → the row
        // proceeds as the contact's owner (defer then TRANSFERS it,
        // no-info deletes it); conclusively absent past grace → proceeds
        // clean; otherwise the marker stays for a later pass.
        const attemptedMs = recoveryAttemptAt ? new Date(recoveryAttemptAt).getTime() : 0;
        const pastGrace = Date.now() - attemptedMs >= RECOVERY_GRACE_MS;
        try {
          const recovered = await findExistingContact(people, row, rowTag(table, row), { queryOverride: markerSearchKey, requireConclusive: true });
          if (recovered) {
            row.google_contact_id = recovered;
            // The orphan may have LOST the race: a sibling/account row can
            // have minted the established contact while this one was
            // pending — the ownership blocks below reconcile (retire the
            // orphan, adopt theirs) instead of keeping both forever.
            row.__recoveredFresh = true;
          } else if (!pastGrace) {
            counts.failed += 1;
            logger.info(`[contacts-sync] pending-create recovery deferred inside the grace window (${table} ${row.id})`);
            continue;
          }
        } catch (searchErr) {
          if (isScopeError(searchErr)) {
            counts.blocked = 'contacts_scope_missing';
            logger.warn('[contacts-sync] People API scope missing — waiting on one-time owner re-consent at the admin Gmail auth URL');
            return counts;
          }
          // findExistingContact deliberately rethrows all three systemic
          // classes — swallowing auth/service-disabled here as generic row
          // failures would let a fully-marked batch finish without the
          // actionable blocked status.
          if (isAuthError(searchErr)) {
            counts.blocked = 'google_auth_failed';
            logger.warn('[contacts-sync] Google credentials rejected during pending-create recovery — run blocked; reconnect Google in admin');
            return counts;
          }
          if (isServiceDisabledError(searchErr)) {
            counts.blocked = 'people_api_disabled';
            logger.warn('[contacts-sync] People API disabled during pending-create recovery — run blocked; enable it in Google Cloud console');
            return counts;
          }
          counts.failed += 1;
          logger.warn(`[contacts-sync] pending-create recovery search inconclusive (${table} ${row.id}) — marker retained`);
          continue;
        }
      }
      // Name-only LEADS still sync (the repo permits leads with only a
      // contact name; the every-lead contract includes them). Customers
      // always carry a phone by schema.
      const hasContactInfo = !!(String(row.email || '').trim() || String(row.phone || '').trim()
        || (kind === 'lead' && `${String(row.first_name || '').trim()}${String(row.last_name || '').trim()}`));
      if (!hasContactInfo) {
        // Nothing publishable. A contact minted earlier must not keep
        // serving data the source row no longer contains — but a SHARED
        // contact (sibling leads) belongs to the surviving rows.
        if (row.google_contact_id && !(await contactInUseElsewhere(row.google_contact_id, table, row.id))) {
          // Revalidate the EMPTY state under a row lock held THROUGH the
          // destructive call — a writer restoring contact info blocks on
          // the lock instead of committing into a SELECT→delete window
          // (operator labels/secondary data on a deleted contact are
          // unrecoverable; the conditional stamp alone only queues a
          // hollow recreation).
          let restoredInfo = false;
          await db.transaction(async (trx) => {
            const fresh = await trx(table).where({ id: row.id })
              .select('email', 'phone', 'first_name', 'last_name')
              .forUpdate()
              .first();
            const stillEmpty = !fresh
              || !(String(fresh.email || '').trim() || String(fresh.phone || '').trim()
                || (kind === 'lead' && `${String(fresh.first_name || '').trim()}${String(fresh.last_name || '').trim()}`));
            if (!stillEmpty) { restoredInfo = true; return; }
            await deleteContact(people, row.google_contact_id);
          });
          if (restoredInfo) continue; // its own edit re-queues it with data intact
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
            // The destination CUSTOMER may already be covered — by its own
            // contact OR by its ACCOUNT's (another property row): a naive
            // whereNull transfer would hand a multi-property account a
            // second contact.
            const freshCustomer = await db('customers').where({ id: ownership.customerId }).first();
            let existingContact = freshCustomer?.google_contact_id || null;
            if (!existingContact && freshCustomer?.account_id) {
              const accSibling = await db('customers')
                .whereNot('id', ownership.customerId)
                .where('account_id', freshCustomer.account_id)
                .whereNull('deleted_at')
                .whereNotNull('google_contact_id')
                .whereNot('google_contact_id', 'like', `${PENDING_CREATE}%`)
                .whereNot('google_contact_id', 'like', `${PENDING_RETIRE}%`)
                .first();
              if (accSibling?.google_contact_id) {
                existingContact = accSibling.google_contact_id;
                // The customer row adopts the ACCOUNT's contact...
                await db('customers').where({ id: ownership.customerId })
                  .whereNull('google_contact_id')
                  .whereNull('deleted_at')
                  .update({ google_contact_id: existingContact });
              }
            }
            const queued = customerById.get(ownership.customerId);
            if (existingContact) {
              if (queued && !queued.google_contact_id) queued.google_contact_id = existingContact;
              // ...and the lead's contact is a duplicate (unless shared):
              // operator data is absorbed into the survivor first. A
              // failed merge RETAINS the duplicate and keeps this lead
              // pointing at it — retried next run instead of orphaned.
              if (existingContact !== row.google_contact_id
                && !(await contactInUseElsewhere(row.google_contact_id, table, row.id))) {
                if (!(await absorbDuplicate(people, row.google_contact_id, existingContact, gapMs))) {
                  counts.failed += 1;
                  continue;
                }
              }
            } else {
              // deleted_at predicate: the transfer must not hand the
              // contact to a customer tombstoned since ownership resolved
              // (the tombstone lane would retire it while the live lead
              // points nowhere).
              const transferred = await db('customers')
                .where({ id: ownership.customerId })
                .whereNull('google_contact_id')
                .whereNull('deleted_at')
                .update({ google_contact_id: row.google_contact_id });
              if (transferred && queued && !queued.google_contact_id) queued.google_contact_id = row.google_contact_id;
            }
          }
          // Revalidate destination liveness before stamping the lead away
          // from its contact — a customer soft-deleted mid-run means no
          // live owner exists; leave the lead unstamped so the next tick
          // re-resolves ownership (and mints its own if the link is gone).
          const destStillLive = await db('customers')
            .where({ id: ownership.customerId })
            .whereNull('deleted_at')
            .first();
          if (!destStillLive) {
            counts.failed += 1;
            logger.warn(`[contacts-sync] transfer destination customer tombstoned mid-run (${table} ${row.id}) — lead re-resolves next tick`);
            continue;
          }
          await stampIfUnchanged(table, row, { google_contact_id: null });
          counts.skipped += 1;
          continue;
        }
        if (ownership.adoptContactId && !row.google_contact_id) {
          row.google_contact_id = ownership.adoptContactId;
        } else if (row.__recoveredFresh && ownership.adoptContactId
          && ownership.adoptContactId !== row.google_contact_id) {
          // Recovered orphan vs an established sibling contact: the
          // sibling's wins; the orphan's operator data is absorbed into it
          // before retirement (unless shared).
          if (!(await contactInUseElsewhere(row.google_contact_id, table, row.id))) {
            if (!(await absorbDuplicate(people, row.google_contact_id, ownership.adoptContactId, gapMs))) {
              counts.failed += 1;
              continue; // duplicate retained — row keeps it; retried next run
            }
          }
          row.google_contact_id = ownership.adoptContactId;
        } else if (row.google_contact_id && !ownership.adoptContactId
          && (await contactInUseElsewhere(row.google_contact_id, table, row.id))) {
          // The contact is SHARED but this lead's identity no longer
          // matches any sibling (the ownership probe found none) — an
          // update would overwrite the OTHER person's contact. Release the
          // shared id; this row mints its own contact below (tag adoption
          // bypassed: the released contact may still carry OUR stale tag).
          const releasedId = row.google_contact_id;
          row.google_contact_id = null;
          row.__releasedShared = true;
          // Best-effort: hand the released contact's waves_row tag to a
          // surviving owner so future tag searches resolve to THEM.
          try {
            let survivorTag = null;
            for (const t of ['customers', 'leads']) {
              const survivor = await db(t)
                .where('google_contact_id', releasedId)
                .whereNull('deleted_at')
                .whereNot(t === table ? 'id' : 'id', t === table ? row.id : '00000000-0000-0000-0000-000000000000')
                .first();
              if (survivor) { survivorTag = `${t}:${survivor.id}`; break; }
            }
            if (survivorTag) {
              const current = await people.people.get({ resourceName: releasedId, personFields: 'metadata,clientData' });
              await sleep(gapMs);
              await people.people.updateContact({
                resourceName: releasedId,
                updatePersonFields: 'clientData',
                requestBody: {
                  clientData: mergedClientData(current.data.clientData, survivorTag),
                  metadata: current.data.metadata,
                  etag: current.data.etag,
                },
              });
              await sleep(gapMs);
            }
          } catch (retagErr) {
            // Residual: a stale tag on the released contact. Bounded — the
            // release flag already blocks THIS row's re-adoption, and the
            // survivor's own passes update by resource id, not tag.
            logger.warn(`[contacts-sync] released-contact retag failed: ${safeErr(retagErr)}`);
          }
        }
      }
      if (kind === 'customer' && row.account_id && (!row.google_contact_id || row.__recoveredFresh)) {
        // One contact per ACCOUNT: multi-property accounts own several
        // customer rows BY DESIGN (dup email/phone constraints removed in
        // 20260504000008) — adopt the account's existing contact instead
        // of minting one per property row.
        const accountSibling = await db('customers')
          .whereNot('id', row.id)
          .where('account_id', row.account_id)
          .whereNull('deleted_at')
          .whereNotNull('google_contact_id')
          .whereNot('google_contact_id', 'like', `${PENDING_CREATE}%`)
    .whereNot('google_contact_id', 'like', `${PENDING_RETIRE}%`)
          .first();
        const accountContact = accountSibling?.google_contact_id || null;
        if (accountContact && accountContact !== row.google_contact_id) {
          if (row.google_contact_id
            && !(await contactInUseElsewhere(row.google_contact_id, table, row.id))) {
            // Recovered orphan vs the account's established contact —
            // absorb before retiring.
            if (!(await absorbDuplicate(people, row.google_contact_id, accountContact, gapMs))) {
              counts.failed += 1;
              continue; // duplicate retained — retried next run
            }
          }
          row.google_contact_id = accountContact;
        }
      }
      if (kind === 'customer' && row.account_id) {
        // Multi-property accounts share ONE contact — pushing only the
        // current row's address made each sibling sync overwrite the last
        // (addresses are in the update mask). Aggregate every live
        // property address, stably ordered, so all siblings write the same
        // set.
        try {
          const props = await db('customers')
            .where('account_id', row.account_id)
            .whereNull('deleted_at')
            .whereNotNull('address_line1')
            .orderBy('id', 'asc')
            .select('address_line1', 'address_line2', 'city', 'state', 'zip');
          if (props.length) row.__accountAddresses = props.slice(0, 8);
          // Canonical identity: the customer_accounts row IS the person;
          // property rows are copies that can drift.
          const account = await db('customer_accounts')
            .where({ id: row.account_id })
            .select('*', db.raw(US_TOKEN))
            .first();
          if (account) row.__canonicalIdentity = account;
        } catch (e) {
          // Publishing a KNOWN-incomplete shared contact would strip the
          // sibling addresses (the update mask replaces the whole list) —
          // defer the row instead.
          counts.failed += 1;
          logger.warn(`[contacts-sync] account address aggregation failed (${table} ${row.id}) — row deferred: ${safeErr(e)}`);
          continue;
        }
      }
      if (kind === 'customer' && (!row.google_contact_id || row.__recoveredFresh)) {
        // Insertion order must not matter: a live LEAD with this email may
        // have minted the contact before the customer row existed — adopt
        // it (the lead's row keeps its shared pointer; the in-use guard
        // protects it from deletion).
        // The minting lead may carry EITHER the property copy or the
        // corrected canonical account email — probe both.
        const emailCandidates = [...new Set([
          String(row.email || '').trim().toLowerCase(),
          String(row.__canonicalIdentity?.email || '').trim().toLowerCase(),
        ].filter(Boolean))];
        if (emailCandidates.length) {
          const leadOwner = await db('leads')
            .whereNull('deleted_at')
            .whereNotNull('google_contact_id')
            .whereNot('google_contact_id', 'like', `${PENDING_CREATE}%`)
            .whereNot('google_contact_id', 'like', `${PENDING_RETIRE}%`)
            .whereRaw(`LOWER(email) IN (${emailCandidates.map(() => '?').join(', ')})`, emailCandidates)
            .first();
          const leadContact = leadOwner?.google_contact_id || null;
          if (leadContact && leadContact !== row.google_contact_id) {
            if (row.google_contact_id
              && !(await contactInUseElsewhere(row.google_contact_id, table, row.id))) {
              if (!(await absorbDuplicate(people, row.google_contact_id, leadContact, gapMs))) {
                counts.failed += 1;
                continue; // duplicate retained — retried next run
              }
            }
            row.google_contact_id = leadContact;
          }
        }
        if (!row.google_contact_id) {
          // PHONE-ONLY leads never match the email probe — a previously
          // synced unlinked lead with only a number would leave this
          // customer minting a second contact for the same person. Same
          // phone-suffix + compatible-name rules as the lead-side probe.
          const identity = row.__canonicalIdentity || row;
          const custPhoneDigits = String(identity.phone || row.phone || '').replace(/\D/g, '').slice(-10);
          const custName = `${String(identity.first_name || '').trim()} ${String(identity.last_name || '').trim()}`.trim().toLowerCase();
          if (custPhoneDigits.length >= 7) {
            const phoneLeadOwner = await db('leads')
              .whereNull('deleted_at')
              .whereNotNull('google_contact_id')
              .whereNot('google_contact_id', 'like', `${PENDING_CREATE}%`)
              .whereNot('google_contact_id', 'like', `${PENDING_RETIRE}%`)
              .whereRaw(
                "(RIGHT(regexp_replace(phone, '\\D', '', 'g'), ?) = ?"
                + " OR (LENGTH(regexp_replace(phone, '\\D', '', 'g')) BETWEEN 7 AND 9"
                + " AND RIGHT(?, LENGTH(regexp_replace(phone, '\\D', '', 'g'))) = regexp_replace(phone, '\\D', '', 'g')))",
                [custPhoneDigits.length, custPhoneDigits, custPhoneDigits],
              )
              .whereRaw("(TRIM(email) IS NULL OR TRIM(email) = '')")
              .where((q) => {
                if (custName) q.whereRaw("(TRIM(CONCAT_WS(' ', first_name, last_name)) = '' OR LOWER(TRIM(CONCAT_WS(' ', first_name, last_name))) = ?)", [custName]);
              })
              .select('id', 'google_contact_id', 'first_name', 'last_name')
              .first();
            if (phoneLeadOwner?.google_contact_id) {
              const leadName = `${String(phoneLeadOwner.first_name || '').trim()} ${String(phoneLeadOwner.last_name || '').trim()}`.trim().toLowerCase();
              const namesConflict = !!(custName && leadName && custName !== leadName);
              if (!namesConflict) row.google_contact_id = phoneLeadOwner.google_contact_id;
            }
          }
        }
      }
      const priorContactId = row.google_contact_id;
      if (row.google_contact_id && repointedThisRun.has(row.google_contact_id)) {
        row.google_contact_id = repointedThisRun.get(row.google_contact_id);
      }
      // Recovery was resolved above — upsert sees either the recovered
      // resource (update path) or a clean row (search+create path).
      const { resourceName, created } = await upsertContact(people, table, row, kind, gapMs, { markerSearchKey, markerPriorId });
      const compensateFreshCreate = async () => {
        if (!(created && resourceName)) return;
        try {
          await deleteContact(people, resourceName);
        } catch (delErr) {
          // The compensation itself is ambiguous — the contact may exist
          // with NO pointer, and next tick's lagging search could miss it
          // and mint a duplicate. Mark for the same grace-window recovery
          // as an ambiguous create.
          await db(table).where({ id: row.id })
            .where((q) => {
              q.whereNull('google_contact_id');
              if (priorContactId) q.orWhere('google_contact_id', priorContactId);
            })
            .update({ google_contact_id: pendingMarkerFor(priorContactId, rowSearchKey(row)), google_contact_synced_at: new Date() })
            .catch(() => {});
        }
      };
      // During recovery the row's prior id IS the recovered resource — the
      // dead contact every sharer still holds is the one the MARKER kept.
      const repointFrom = pendingRecovery ? markerPriorId : (created ? priorContactId : null);
      const repoint = (repointFrom && repointFrom !== resourceName)
        ? { from: repointFrom, to: resourceName } : null;
      let stamped = 0;
      try {
        stamped = await stampIfUnchanged(table, row, { google_contact_id: resourceName }, { repoint });
      } catch (stampErr) {
        // The row didn't record the contact — a GENUINELY fresh create
        // would leak a duplicate on retry; roll only that back (adopted or
        // updated contacts predate this pass and are never compensated).
        await compensateFreshCreate();
        throw stampErr;
      }
      if (!stamped) {
        // A raced edit vetoed the stamp — the same compensation applies:
        // an unrecorded fresh create would duplicate on the retry (search
        // indexing lags), so remove it and let the next run recreate from
        // the fresh row.
        await compensateFreshCreate();
        await sleep(gapMs);
        logger.info(`[contacts-sync] stamp vetoed by a concurrent edit (${table} ${row.id}) — re-syncing next run`);
        continue;
      }
      // Sharer repoints committed atomically WITH the stamp above; the
      // in-run map still forwards later batch rows to the replacement.
      if (repoint) repointedThisRun.set(repoint.from, repoint.to);
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
      if (isAuthError(err)) {
        counts.blocked = 'google_auth_failed';
        logger.warn('[contacts-sync] Google credentials rejected (invalid_grant?) — run blocked; reconnect Google in admin');
        return counts;
      }
      if (isServiceDisabledError(err)) {
        counts.blocked = 'people_api_disabled';
        logger.warn('[contacts-sync] People API disabled for this project — run blocked; enable it in Google Cloud console');
        return counts;
      }
      counts.failed += 1;
      const failStatus = err?.code || err?.response?.status;
      if (typeof failStatus === 'number' && failStatus >= 400 && failStatus < 500
        && !isRetryable4xx(err) && !err.searchInconclusive) {
        // Deterministic rejection (validation etc.): retrying every tick
        // would pin the newest-first batch and starve the backfill. Park
        // the row (watermark stamped current) — any contact-field edit
        // re-queues it via the touch triggers, and rows holding a contact
        // retry through the weekly verification lane.
        // Same raced-edit guards as the stamps (row µs token AND canonical
        // account timestamp): a correction racing the rejected request —
        // on either the row or its account — must re-queue, not get
        // parked over.
        await guardedStamp(table, row, { google_contact_synced_at: new Date() })
          .catch(() => {});
        logger.warn(`[contacts-sync] ${table} ${row.id} parked after deterministic rejection (${safeErr(err)}) — an edit re-queues it`);
      } else {
        logger.warn(`[contacts-sync] sync failed for ${table} ${row.id}: ${safeErr(err)}`);
      }
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
        // Fair rotation: failed retirements bump updated_at to the back of
        // this queue instead of monopolizing every slot forever.
        .orderBy('updated_at', 'asc')
        .limit(TOMBSTONE_SLOTS)
        .select('id', 'google_contact_id', 'google_contact_synced_at', 'first_name', 'last_name', 'email', 'phone');
    } catch (e) {
      // A silent query failure would leave deleted rows' PII in Google
      // while job health reports green — mark the run failed.
      counts.failed += 1;
      logger.warn(`[contacts-sync] tombstone query failed for ${table}: ${safeErr(e)}`);
    }
    for (const row of tombstones) {
      try {
        if (isRetireMarker(row.google_contact_id)) {
          // A retirement that crashed between marker and delete — finish
          // it. The claim below guards against a restore racing this batch.
          const retiringId = retireIdFromMarker(row.google_contact_id);
          const reclaimed = await db(table).where({ id: row.id, google_contact_id: row.google_contact_id })
            .whereNotNull('deleted_at')
            .update({ updated_at: new Date() });
          if (!reclaimed) continue; // restored — the main lane's handler owns it now
          // Row lock held through the destructive call — a restore blocks
          // on it instead of committing between the tombstone re-check and
          // the delete (same pattern as the unshared-retirement path).
          let restoredMidRetire = false;
          await db.transaction(async (trx) => {
            const stillDeleted = await trx(table).where({ id: row.id })
              .whereNotNull('deleted_at')
              .forUpdate()
              .first();
            if (!stillDeleted) { restoredMidRetire = true; return; }
            if (retiringId) await deleteContact(people, retiringId);
            await trx(table).where({ id: row.id }).update({ google_contact_id: null, google_contact_synced_at: null });
          });
          if (restoredMidRetire) continue;
          if (retiringId) await sleep(gapMs);
          counts.retired += 1;
          continue;
        }
        if (isPendingMarker(row.google_contact_id)) {
          // Resolve the ambiguous create BEFORE dropping the only marker —
          // a create that actually committed would otherwise orphan the
          // deleted row's PII in Google forever. Inside the grace window
          // (or on an inconclusive search) the marker is kept for a later
          // pass. CLAIM first (same live-row guard as the normal path): a
          // restore racing this batch must not have its contact searched
          // out and deleted from under it.
          const attemptedMs = row.google_contact_synced_at ? new Date(row.google_contact_synced_at).getTime() : 0;
          if (Date.now() - attemptedMs < RECOVERY_GRACE_MS) continue;
          const markerClaimed = await db(table).where({ id: row.id, google_contact_id: row.google_contact_id })
            .whereNotNull('deleted_at')
            .update({ updated_at: new Date() });
          if (!markerClaimed) continue; // restored — main-lane recovery owns it
          try {
            // Search by the CREATE-TIME identity when the marker stored one
            // — a merge may have scrambled this row's email/phone since,
            // and the orphan still carries the original values.
            const storedKey = searchKeyFromMarker(row.google_contact_id);
            const orphan = await findExistingContact(people, row, rowTag(table, row), { queryOverride: storedKey, requireConclusive: true });
            if (orphan) {
              // Same lock-through-the-delete pattern: a restore must not
              // commit between the tombstone re-check and the orphan
              // delete — the restored row may legitimately own it.
              let restoredMidRecovery = false;
              await db.transaction(async (trx) => {
                const stillDeleted = await trx(table).where({ id: row.id })
                  .whereNotNull('deleted_at')
                  .forUpdate()
                  .first();
                if (!stillDeleted) { restoredMidRecovery = true; return; }
                await deleteContact(people, orphan);
              });
              if (restoredMidRecovery) continue;
              await sleep(gapMs);
            }
          } catch (searchErr) {
            if (isScopeError(searchErr)) { counts.blocked = 'contacts_scope_missing'; return counts; }
            if (isAuthError(searchErr)) { counts.blocked = 'google_auth_failed'; return counts; }
            if (isServiceDisabledError(searchErr)) { counts.blocked = 'people_api_disabled'; return counts; }
            // Inconclusive — keep the marker, but the stalled retirement
            // must show in job health.
            counts.failed += 1;
            continue;
          }
          await db(table).where({ id: row.id }).update({ google_contact_id: null, google_contact_synced_at: null });
          counts.retired += 1;
          continue;
        }
        const inUse = await contactInUseElsewhere(row.google_contact_id, table, row.id);
        if (!inUse) {
          // Durable retirement: swap the pointer for a RETIRE marker under
          // the live-row guard (an admin restore racing this batch keeps
          // its contact), THEN delete externally, THEN clear. A crash at
          // any point leaves either the pointer or the marker — never an
          // orphaned contact behind a nulled row.
          const claimed = await db(table).where({ id: row.id, google_contact_id: row.google_contact_id })
            .whereNotNull('deleted_at')
            .update({ google_contact_id: retireMarkerFor(row.google_contact_id), google_contact_synced_at: null });
          if (!claimed) continue; // restored mid-batch — leave the contact alone
          // Revalidate under a row lock held THROUGH the destructive call —
          // a SELECT-then-delete leaves a window where a restore commits
          // deleted_at = NULL and we delete a live customer's contact.
          // With FOR UPDATE, the restore's UPDATE blocks until this
          // transaction commits; a restore that won the race instead makes
          // the tombstone check fail and the contact is left alone (the
          // retire marker hands recovery to the main lane).
          let restoredMidBatch = false;
          await db.transaction(async (trx) => {
            const stillDeleted = await trx(table).where({ id: row.id })
              .whereNotNull('deleted_at')
              .forUpdate()
              .first();
            if (!stillDeleted) { restoredMidBatch = true; return; }
            await deleteContact(people, row.google_contact_id);
            await trx(table).where({ id: row.id }).update({ google_contact_id: null });
          });
          if (restoredMidBatch) continue;
          await sleep(gapMs);
        } else {
          // SHARED contact: released, not deleted — but it may still carry
          // THIS retired row's PII/tag if it was the last pushed source.
          // Requeue a surviving owner FIRST: releasing the tombstone
          // pointer before a failed requeue would leave nobody holding
          // retry state for the scrub (a requeue failure throws → the
          // rotation catch retries this tombstone with its pointer intact).
          for (const t of ['customers', 'leads']) {
            const survivor = await db(t)
              .where('google_contact_id', row.google_contact_id)
              .whereNull('deleted_at')
              .first();
            if (survivor) {
              await db(t).where({ id: survivor.id }).update({ google_contact_synced_at: null });
              break;
            }
          }
          const claimed = await db(table).where({ id: row.id })
            .whereNotNull('deleted_at')
            .update({ google_contact_id: null, google_contact_synced_at: null });
          if (!claimed) continue; // restored mid-batch — leave the contact alone
        }
        counts.retired += 1;
      } catch (err) {
        if (isScopeError(err)) { counts.blocked = 'contacts_scope_missing'; return counts; }
        if (isAuthError(err)) { counts.blocked = 'google_auth_failed'; return counts; }
        if (isServiceDisabledError(err)) { counts.blocked = 'people_api_disabled'; return counts; }
        counts.failed += 1;
        // Fair rotation — the ordered query re-selects by updated_at, so
        // bumping it sends this failure to the back of the line.
        await db(table).where({ id: row.id }).update({ updated_at: new Date() }).catch(() => {});
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
    // Leads keep a reserved verification slot for the same reason the main
    // lane reserves them — a large customer corpus must not monopolize the
    // budget and leave broken lead contacts unrepaired forever.
    const vc = await db('customers')
      .whereNull('deleted_at')
      .whereNotNull('google_contact_id')
      .whereNot('google_contact_id', 'like', `${PENDING_CREATE}%`)
    .whereNot('google_contact_id', 'like', `${PENDING_RETIRE}%`)
      // Source-CURRENT rows only — a stale row (e.g. a converted lead
      // waiting behind the main-pass cap) must go through the main lane's
      // ownership/cleanup, not a direct re-push.
      .whereRaw('updated_at <= google_contact_synced_at')
      .where('google_contact_synced_at', '<', verifyCutoff)
      .orderBy('google_contact_synced_at', 'asc')
      .limit(Math.max(1, VERIFY_SLOTS - 2))
      .select(...SYNC_COLUMNS, db.raw(US_TOKEN), 'account_id', 'address_line1', 'address_line2', 'city', 'state', 'zip');
    verifyRows.push(...vc.map((row) => ({ table: 'customers', kind: 'customer', row })));
    if (verifyRows.length < VERIFY_SLOTS) {
      const vl = await db('leads')
        .whereNull('deleted_at')
        .whereNotNull('google_contact_id')
        .whereNot('google_contact_id', 'like', `${PENDING_CREATE}%`)
    .whereNot('google_contact_id', 'like', `${PENDING_RETIRE}%`)
        .whereRaw('updated_at <= google_contact_synced_at')
        .where('google_contact_synced_at', '<', verifyCutoff)
        .orderBy('google_contact_synced_at', 'asc')
        .limit(VERIFY_SLOTS - verifyRows.length)
        .select(...SYNC_COLUMNS, db.raw(US_TOKEN), 'customer_id');
      verifyRows.push(...vl.map((row) => ({ table: 'leads', kind: 'lead', row })));
    }
  } catch (e) {
    // Same rule as the tombstone queries — a silently skipped drift-repair
    // lane must not read as a green run.
    counts.failed += 1;
    logger.warn(`[contacts-sync] verification query failed: ${safeErr(e)}`);
  }
  for (const { table, kind, row } of verifyRows) {
    try {
      if (kind === 'customer' && row.account_id) {
        // Same account-address aggregation as the main lane — a verify
        // push with only this row's address would strip the siblings'
        // (addresses are in the update mask).
        try {
          const props = await db('customers')
            .where('account_id', row.account_id)
            .whereNull('deleted_at')
            .whereNotNull('address_line1')
            .orderBy('id', 'asc')
            .select('address_line1', 'address_line2', 'city', 'state', 'zip');
          if (props.length) row.__accountAddresses = props.slice(0, 8);
          // Canonical identity: the customer_accounts row IS the person;
          // property rows are copies that can drift.
          const account = await db('customer_accounts')
            .where({ id: row.account_id })
            .select('*', db.raw(US_TOKEN))
            .first();
          if (account) row.__canonicalIdentity = account;
        } catch (e) {
          counts.failed += 1;
          logger.warn(`[contacts-sync] account address aggregation failed (verify ${table} ${row.id}) — row deferred: ${safeErr(e)}`);
          continue;
        }
      }
      if (kind === 'lead') {
        // Ownership rules apply here too: a NON-OWNER lead (converted, or
        // sharing a contact whose identity it no longer matches) must not
        // re-push its snapshot over the owner's — advance its watermark
        // and leave the contact to the owner's verification.
        const ownership = await resolveLeadOwnership(row);
        const sharedElsewhere = await contactInUseElsewhere(row.google_contact_id, table, row.id);
        const nonOwner = ownership.deferToCustomer
          || (sharedElsewhere && ownership.adoptContactId !== row.google_contact_id);
        if (nonOwner) {
          const advanced = await stampVerified(table, row, row.google_contact_id, now);
          if (advanced) counts.verified += 1;
          continue;
        }
      }
      if (row.google_contact_id && repointedThisRun.has(row.google_contact_id)) {
        row.google_contact_id = repointedThisRun.get(row.google_contact_id);
      }
      const priorContactId = row.google_contact_id;
      const { resourceName, created } = await upsertContact(people, table, row, kind, gapMs);
      const compensateVerifyCreate = async () => {
        if (!(created && resourceName)) return;
        try {
          await deleteContact(people, resourceName);
        } catch (delErr) {
          // Inconclusive compensation — durable marker (with the dead
          // prior id + this row's identity) so recovery can find either
          // the replacement or its sharers instead of minting a third.
          await db(table).where({ id: row.id })
            .where((q) => {
              q.whereNull('google_contact_id');
              if (priorContactId) q.orWhere('google_contact_id', priorContactId);
            })
            .update({ google_contact_id: pendingMarkerFor(priorContactId, rowSearchKey(row)), google_contact_synced_at: new Date() })
            .catch(() => {});
        }
      };
      const verifyRepoint = (created && priorContactId && priorContactId !== resourceName)
        ? { from: priorContactId, to: resourceName } : null;
      let stamped = 0;
      try {
        stamped = await stampVerified(table, row, resourceName, now, { repoint: verifyRepoint });
      } catch (stampErr) {
        // Same fresh-create compensation as the main lane — a 404-recreate
        // whose stamp threw would otherwise leak a replacement per retry.
        await compensateVerifyCreate();
        throw stampErr;
      }
      if (!stamped) {
        await compensateVerifyCreate();
      }
      if (stamped) {
        // Sharer repoints committed atomically WITH the stamp — a crash
        // can no longer separate them, and a veto rolls both back.
        if (verifyRepoint) repointedThisRun.set(verifyRepoint.from, verifyRepoint.to);
        counts.verified += 1;
      }
      await sleep(gapMs);
    } catch (err) {
      if (isScopeError(err)) { counts.blocked = 'contacts_scope_missing'; return counts; }
      if (isAuthError(err)) { counts.blocked = 'google_auth_failed'; return counts; }
      if (isServiceDisabledError(err)) { counts.blocked = 'people_api_disabled'; return counts; }
      counts.failed += 1;
      // Rotate instead of pinning the oldest slots every tick: push the
      // watermark to cutoff-minus-one-day (still unverified, retries
      // tomorrow) under the same unchanged-row guard. NEVER rotate a row
      // whose failure just wrote a pending marker — its watermark is the
      // recovery ATTEMPT TIME, and backdating it would fake out the
      // search-lag grace window.
      await db(table).where({ id: row.id })
        .whereRaw("date_trunc('milliseconds', updated_at) <= ?", [row.updated_at])
        .where((q) => {
          q.whereNull('google_contact_id')
            .orWhereRaw('google_contact_id NOT LIKE ?', [`${PENDING_CREATE}%`]);
        })
        .update({ google_contact_synced_at: new Date(now.getTime() - (VERIFY_AFTER_DAYS - 1) * 86400000) })
        .catch(() => {});
      logger.warn(`[contacts-sync] verification failed for ${table} ${row.id}: ${safeErr(err)}`);
    }
  }

  if (counts.synced || counts.failed || counts.retired || counts.verified) {
    logger.info(`[contacts-sync] ${counts.synced} synced, ${counts.skipped} skipped, ${counts.retired} retired, ${counts.verified} verified, ${counts.failed} failed`);
  }
  return counts;
}

module.exports = { runContactsSync };
