'use strict';
/**
 * Meta Custom Audiences sync — uploads first-party customer/lead lists to Meta as
 * Custom Audiences for:
 *   - SUPPRESSION  (`customers`)      → exclude existing customers from prospecting
 *   - RETARGETING  (`unbooked_leads`) → re-engage known leads who haven't booked
 *
 * Ships DARK. No-ops unless META_AUDIENCES_ACCESS_TOKEN + META_ADS_ACCOUNT_ID are set.
 * Writes require META_AUDIENCES_ALLOW_UPLOADS=true; otherwise every call is a DRY RUN
 * that computes the add/remove deltas without touching Meta.
 *
 * Uploading a customer file needs an **ads_management** token (kept SEPARATE from the
 * read-only META_ADS_ACCESS_TOKEN used for ingestion) and the ad account must have
 * accepted Meta's Custom Audience Terms. Reuses the conversion path's PII
 * hashing/normalization (data-manager._private) so both lanes hash identically.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { runExclusive } = require('../../utils/cron-lock');
const { sha256Hex, normalizeEmail, normalizePhone } = require('./data-manager')._private;
const { whereLiveCustomer } = require('../customer-stages');
const { isInternalTestContact } = require('../internal-test-customers');
const matchFields = require('./ad-match-fields');
const {
  filterMarketingSuppressed, partitionMarketingSuppressed, loadMarketingSuppression, canonicalEmail, normPhone,
} = require('./ad-audience-consent');

const GRAPH = 'https://graph.facebook.com';
const STATE_TABLE = 'ad_audience_syncs';
// Meta multi-key schemas; data rows align to the order. ADDS use the enriched
// schema, which carries first/last name, ZIP and country when known. A REMOVAL
// sends the row that was added: the enriched row for a member stored with its
// name/ZIP hashes, the two-key row for one stored before they were added.
const SCHEMA = ['EMAIL', 'PHONE'];
const SCHEMA_ENRICHED = ['EMAIL', 'PHONE', 'FN', 'LN', 'ZIP', 'COUNTRY'];
const MAX_USERS_PER_CALL = 1000; // Meta allows up to 10k/call; keep batches modest
const DEFAULT_LEAD_WINDOW_DAYS = 180;

// Lead statuses that are no longer an "unbooked prospect" — booked/won or dead.
// Mirrors the admin pipeline + agent-workflow closed-status sets (admin-leads.js,
// admin-agents.js), incl. unresponsive/duplicate.
const LEAD_CLOSED = [
  'booked', 'converted', 'won', 'customer', 'active_customer',
  'lost', 'disqualified', 'unqualified', 'spam', 'invalid', 'unresponsive', 'duplicate', 'handled',
];

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

function apiVersion() {
  return process.env.META_AUDIENCES_API_VERSION || process.env.META_ADS_API_VERSION || 'v23.0';
}
function accessToken() {
  return process.env.META_AUDIENCES_ACCESS_TOKEN || '';
}
function adAccountId() {
  const raw = String(process.env.META_ADS_ACCOUNT_ID || '').trim();
  if (!raw) return null;
  return raw.startsWith('act_') ? raw : `act_${raw}`;
}
function isConfigured() {
  return !!(adAccountId() && accessToken());
}
function uploadsAllowed() {
  return boolEnv('META_AUDIENCES_ALLOW_UPLOADS', false);
}

// ── Audience definitions ─────────────────────────────────────────────
const AUDIENCES = {
  customers: {
    name: 'Waves — Customers (suppression)',
    description: 'Existing Waves customers. Use as an EXCLUSION on prospecting campaigns.',
    collect: collectCustomerMembers,
    staleLeavingKeys: staleCustomerLeavingKeys,
  },
  unbooked_leads: {
    name: 'Waves — Unbooked leads (retargeting)',
    description: 'Known leads who have not booked. Use as a retargeting audience.',
    collect: collectUnbookedLeadMembers,
    staleLeavingKeys: staleLeadLeavingKeys,
  },
};

// ── Member collection — returns [{ key, email, phone }] (or, with
// partition:true, { kept, dropped } so sync engines can derive removal
// hashes from the dropped members' raw source values) ────────────────
async function collectCustomerMembers({ partition = false, suppression = null } = {}) {
  // REAL customers only. `customers.active` is also true for CRM lead/prospect rows
  // (public quote leads are inserted as customers at pipeline_stage 'new_lead'), so
  // use the canonical live-customer predicate, not just `active`.
  const rows = await whereLiveCustomer(db('customers'))
    .where((q) => q.whereNotNull('email').orWhereNotNull('phone'))
    .select('id', 'email', 'phone', 'first_name', 'last_name', 'city', 'state', 'zip');
  const { kept: members, testKeys } = splitInternalTest(rows.map((r) => ({
    key: `customer:${r.id}`,
    customerId: r.id,
    email: r.email,
    phone: r.phone,
    ...matchFields.mergeIdentity(
      { firstName: r.first_name, lastName: r.last_name, city: r.city, state: r.state, zip: r.zip },
      {},
    ),
  })), 'customers');
  // identifiers-only: this audience is the prospecting EXCLUSION list — an
  // opted-out customer must STAY in it or they start seeing prospecting ads
  // again. Only invalid identifiers (wrong_number = a stranger's phone) are
  // stripped. Google Customer Match shares this collector and semantics.
  const opts = { audienceKey: 'customers', mode: 'identifiers-only', suppression };
  return partition ? { ...(await partitionMarketingSuppressed(members, opts)), testKeys } : filterMarketingSuppressed(members, opts);
}

// The audience's status rule: open leads only (LEAD_CLOSED out). A lead the staleness sweep parked as
// 'unresponsive' with lost_reason 'no_response' stays in as well: it went quiet but never
// booked (owner 2026-11-02, "B": park quiet leads, keep them in the ads).
function unbookedLeadStatusFilter(q) {
  const placeholders = LEAD_CLOSED.map(() => '?').join(',');
  const open = `LOWER(COALESCE(status, '')) NOT IN (${placeholders})`;
  return q.where(function openOrQuietNoResponse() {
    this.whereRaw(open, LEAD_CLOSED)
      .orWhere(function quietNoResponse() {
        this.whereRaw("LOWER(COALESCE(status, '')) = 'unresponsive'").where('lost_reason', 'no_response');
      });
  });
}

// The owner's own test records never go into an ad-platform list. Dropped here;
// their member keys come back too (testKeys), so a sync removes a row already
// uploaded for one even when it shares a key with a current member.
function splitInternalTest(members, audienceKey) {
  const kept = [];
  const testKeys = [];
  // m.internalTest: set by leadMember, which also checked the lead's linked customer.
  for (const m of members) {
    if (m.internalTest || isInternalTestContact(m)) testKeys.push(m.key); else kept.push(m);
  }
  if (testKeys.length) logger.info(`[ad-audiences] ${audienceKey}: dropped ${testKeys.length} internal test record(s)`);
  return { kept, testKeys };
}

// A lead's linked customer. While it is not deleted, its contact and name/address
// back the lead's own; deleted or not, a test customer marks the lead as a test record
// and an opted-out customer opts the lead out.
async function loadLinkedCustomers(ids) {
  const unique = [...new Set(ids.filter(Boolean).map(String))];
  const byId = new Map();
  for (let i = 0; i < unique.length; i += 1000) {
    const rows = await db('customers')
      .whereIn('id', unique.slice(i, i + 1000))
      .select('id', 'email', 'phone', 'first_name', 'last_name', 'city', 'state', 'zip', 'deleted_at');
    for (const r of rows) byId.set(String(r.id), r);
  }
  return byId;
}

function leadMember(r, customer, sup) {
  // A wrong-number phone reaches a stranger, so it never shows that two sources
  // are one person: it takes no part in the name/ZIP pick (consent strips it from
  // the upload too).
  const usable = (phone) => (sup.invalidPhones.has(normPhone(phone)) ? null : phone);
  const own = { email: r.email, phone: usable(r.phone), firstName: r.first_name, lastName: r.last_name, city: r.city, zip: r.zip };
  const linked = customer && !customer.deleted_at
    ? { email: customer.email, phone: usable(customer.phone), firstName: customer.first_name, lastName: customer.last_name, city: customer.city, state: customer.state, zip: customer.zip }
    : {};
  const internal = isInternalTestContact({ customerId: r.customer_id, firstName: r.first_name, lastName: r.last_name, email: r.email, phone: r.phone })
    || (!!customer && isInternalTestContact({ customerId: customer.id, firstName: customer.first_name, lastName: customer.last_name, email: customer.email, phone: customer.phone }));
  return {
    key: `lead:${r.id}`,
    email: r.email,
    phone: r.phone,
    // Name/address only from a source that is the same person as the uploaded
    // email/phone (see ad-match-fields.identityForContact).
    ...matchFields.identityForContact({ email: r.email, phone: usable(r.phone) }, own, linked),
    internalTest: internal,
    // The linked customer is the same person, so its opt-out is the lead's (the
    // conversion lanes check it the same way, as consentIdentifiers).
    linkedOptOut: !!customer && sup.isSuppressed(customer),
  };
}

async function collectUnbookedLeadMembers({ windowDays = DEFAULT_LEAD_WINDOW_DAYS, partition = false, suppression = null } = {}) {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  // Recent, not-closed leads who are NOT already real customers. We can't filter on
  // `whereNull('customer_id')` — quote-wizard leads get a 'new_lead' prospect customer
  // linked back, which would drop the biggest retargeting source. Instead exclude only
  // leads whose linked customer is a LIVE customer.
  const rows = await unbookedLeadStatusFilter(db('leads'))
    .whereNull('deleted_at')
    .where('created_at', '>=', cutoff)
    .where((q) => q.whereNotNull('email').orWhereNotNull('phone'))
    .whereNotExists(function existsLiveCustomer() {
      whereLiveCustomer(this.select(db.raw('1')).from('customers as c').whereRaw('c.id = leads.customer_id'));
    })
    .select('id', 'customer_id', 'email', 'phone', 'first_name', 'last_name', 'city', 'zip');
  // One snapshot for the name/ZIP pick and the consent pass, so they agree on
  // which phones are wrong numbers.
  const sup = suppression || await loadMarketingSuppression();
  const linked = await loadLinkedCustomers(rows.map((r) => r.customer_id));
  const { kept, testKeys } = splitInternalTest(
    rows.map((r) => leadMember(r, linked.get(String(r.customer_id)), sup)),
    'unbooked_leads',
  );
  // A lead opted out through its linked customer is not uploaded, and a row already
  // uploaded for it leaves (optOutKeys), as a test record's does.
  const optOutKeys = kept.filter((m) => m.linkedOptOut).map((m) => m.key);
  const members = kept.filter((m) => !m.linkedOptOut).map(({ internalTest, linkedOptOut, ...member }) => member);
  const opts = { audienceKey: 'unbooked_leads', suppression: sup };
  if (!partition) return filterMarketingSuppressed(members, opts);
  // A lead the consent pass drops (its own opt-out) leaves the same way: every row
  // stored for it goes, one sent under an older email too.
  const split = await partitionMarketingSuppressed(members, opts);
  return { ...split, testKeys, optOutKeys: [...optOutKeys, ...split.dropped.map((m) => m.key)] };
}

// The stored member keys with this prefix whose record the collector no longer returns.
function staleIds(priorEntries, currentMembers, prefix) {
  const current = new Set(currentMembers.map((m) => m.key));
  return [...new Set(priorEntries.map((e) => e.k)
    .filter((k) => typeof k === 'string' && k.startsWith(prefix) && !current.has(k))
    .map((k) => k.slice(prefix.length)))];
}

// A lead row held in state whose lead is no longer collected (closed, aged out,
// deleted or booked) still leaves as a test record or an opt-out: its own, or its
// linked customer's, deleted or not. The collector checks current leads; this
// checks the rest of the stored lead keys, and their keys come back so the rows
// leave even beside a current member.
async function staleLeadLeavingKeys(priorEntries, currentMembers, sup) {
  const ids = staleIds(priorEntries, currentMembers, 'lead:');
  const leads = [];
  for (let i = 0; i < ids.length; i += 1000) {
    leads.push(...await db('leads').whereIn('id', ids.slice(i, i + 1000))
      .select('id', 'customer_id', 'email', 'phone', 'first_name', 'last_name'));
  }
  const linked = await loadLinkedCustomers(leads.map((r) => r.customer_id));
  const out = { testKeys: [], optOutKeys: [] };
  for (const r of leads) {
    const m = leadMember(r, linked.get(String(r.customer_id)), sup);
    if (m.internalTest) out.testKeys.push(m.key);
    else if (m.linkedOptOut || sup.isSuppressed(r)) out.optOutKeys.push(m.key);
  }
  return out;
}

// A customer row held in state whose customer is no longer collected (not live, or
// deleted) still leaves as a test record. An opt-out stays: this is the prospecting
// exclusion list.
async function staleCustomerLeavingKeys(priorEntries, currentMembers) {
  const customers = await loadLinkedCustomers(staleIds(priorEntries, currentMembers, 'customer:'));
  const testKeys = [...customers.values()]
    .filter((c) => isInternalTestContact({ customerId: c.id, firstName: c.first_name, lastName: c.last_name, email: c.email, phone: c.phone }))
    .map((c) => `customer:${c.id}`);
  return { testKeys, optOutKeys: [] };
}

// ── PII hashing → a data row aligned to SCHEMA, or null if no match keys ──
function hashMember(member) {
  const email = normalizeEmail(member && member.email);
  const phone = normalizePhone(member && member.phone); // -> +1XXXXXXXXXX | null
  const emailHash = email ? sha256Hex(email) : '';
  const phoneHash = phone ? sha256Hex(phone.replace(/^\+/, '')) : ''; // Meta hashes phone w/o '+'
  if (!emailHash && !phoneHash) return null;
  return [emailHash, phoneHash];
}

// Name/ZIP/country hashes for the enriched add rows: [fn, ln, zip, country], each
// '' when unknown. Meta normalization: lowercase, no punctuation, 5-digit ZIP,
// country 'us', then SHA-256. null when nothing but the country would be sent.
function hashIdentity(member) {
  const id = matchFields.normalizeIdentity(member);
  if (!id.fn && !id.ln && !id.zp) return null;
  return [
    id.fn ? sha256Hex(id.fn) : '',
    id.ln ? sha256Hex(id.ln) : '',
    id.zp ? sha256Hex(id.zp) : '',
    sha256Hex('us'),
  ];
}
const NO_IDENTITY = ['', '', '', ''];

// Rows to POST this run, and the entry each current member keeps in state. A
// row's name/ZIP hashes (x), once sent, stay its hashes: an edit is not re-sent,
// so a removal always sends the row that was added. A member is sent when it is
// new, or once when it was stored before names were added and now has them (an
// enrichment). Each row is the email/phone hashes followed by FN/LN/ZIP/COUNTRY,
// aligned to SCHEMA_ENRICHED.
function planAdds(currentByHash, priorByHash) {
  const addRows = [];
  let enrichRows = 0;
  const keep = new Map();
  for (const [h, e] of currentByHash) {
    const prior = priorByHash.get(h);
    const x = (prior && prior.x) || e.x;
    keep.set(h, { k: e.k, d: e.d, c: e.c, ...(x ? { x } : {}) });
    if (prior && (prior.x || !e.x)) continue;
    addRows.push([...e.d, ...(x || NO_IDENTITY)]);
    if (prior) enrichRows += 1;
  }
  return { addRows, enrichRows, keep };
}

// Every key a row carries that can match a person: its email and phone hashes,
// and its name/ZIP hashes when first name, last name and ZIP are all there (a
// name or a ZIP alone is not treated as a match key). A DELETE matches by any.
const idsOf = (e) => [
  e.d[0], e.d[1], e.x && e.x[0] && e.x[1] && e.x[2] ? `x:${e.x.slice(0, 3).join('|')}` : '',
].filter(Boolean);
const sharesAny = (e, ids) => idsOf(e).some((id) => ids.has(id));

// ── Meta Graph helper ────────────────────────────────────────────────
async function graph(path, { method = 'GET', body, fetchImpl = global.fetch } = {}) {
  const url = `${GRAPH}/${apiVersion()}/${path}`;
  const opts = { method, headers: { Authorization: `Bearer ${accessToken()}` } };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const resp = await fetchImpl(url, opts);
  let json;
  try { json = await resp.json(); } catch { json = {}; }
  if (!resp.ok || (json && json.error)) {
    const e = (json && json.error) || {};
    throw new Error(`Meta API ${resp.status}: ${e.message || 'request failed'} (type=${e.type || ''} code=${e.code || ''})`);
  }
  return json;
}

// ── State ────────────────────────────────────────────────────────────
async function loadState(audienceKey) {
  return (await db(STATE_TABLE).where({ audience_key: audienceKey }).first()) || null;
}
async function saveState(audienceKey, fields) {
  const row = { audience_key: audienceKey, platform: 'meta', ...fields, updated_at: db.fn.now() };
  await db(STATE_TABLE)
    .insert({ ...row, created_at: db.fn.now() })
    .onConflict('audience_key')
    .merge(row);
}

async function ensureAudience(audienceKey, def) {
  const state = await loadState(audienceKey);
  if (state && state.meta_audience_id) return state.meta_audience_id;
  const created = await graph(`${adAccountId()}/customaudiences`, {
    method: 'POST',
    body: {
      name: def.name,
      description: def.description,
      subtype: 'CUSTOM',
      customer_file_source: 'USER_PROVIDED_ONLY',
    },
  });
  await saveState(audienceKey, { meta_audience_id: created.id });
  return created.id;
}

async function pushUsers(audienceId, rows, method, schema = SCHEMA) {
  let count = 0;
  for (let i = 0; i < rows.length; i += MAX_USERS_PER_CALL) {
    const batch = rows.slice(i, i + MAX_USERS_PER_CALL);
    await graph(`${audienceId}/users`, { method, body: { payload: { schema, data: batch } } });
    count += batch.length;
  }
  return count;
}

// ── Sync one audience (add/remove delta vs last sync) ────────────────
async function syncAudience(audienceKey, { validateOnly = false } = {}) {
  const def = AUDIENCES[audienceKey];
  if (!def) throw new Error(`Unknown audience: ${audienceKey}`);
  if (!isConfigured()) {
    return { audienceKey, configured: false, error: 'Meta audiences not configured (META_AUDIENCES_ACCESS_TOKEN + META_ADS_ACCOUNT_ID).' };
  }
  const dryRun = validateOnly === true || !uploadsAllowed();

  return runExclusive(`meta-audiences:${audienceKey}`, async () => {
    // ONE suppression snapshot drives both collection filtering and the
    // removal calculation below — separate loads could disagree about an
    // opt-out landing between them, leaving the contact uploaded this run
    // with no matching removal.
    const suppression = await loadMarketingSuppression();
    const collected = await def.collect({ partition: true, suppression });
    const members = Array.isArray(collected) ? collected : collected.kept;
    const suppressedMembers = Array.isArray(collected) ? [] : collected.dropped;
    // Member keys whose uploaded rows leave whatever they share with a current
    // member: dropped test records, and opted-out leads (their own opt-out or a
    // linked customer's). Current records here, stored ones once the state loads
    // (staleLeavingKeys).
    const testKeys = new Set(collected.testKeys);
    const leavingKeys = new Set([...testKeys, ...(collected.optOutKeys || [])]);

    // Keep only members with usable match keys, and store the hashed row in state.
    // Persisting the hash (not just the entity key) means: (a) members skipped for
    // missing keys are NOT recorded, so they upload once their email/phone is fixed,
    // and (b) removals work even if the source row was hard-deleted (we never re-read
    // it). The stored values are SHA-256 hashes — the same match keys sent to Meta —
    // not plaintext PII.
    const current = [];
    let skippedNoKeys = 0;
    for (const m of members) {
      const data = hashMember(m);
      if (!data) { skippedNoKeys++; continue; }
      // c: canonical-email consent hash persisted WITH the row. Meta's match
      // hashes (d) come from the RAW source string, so once the source row is
      // hard-deleted a suppression stored under a different gmail variant can
      // never be matched from d alone — c survives deletion and lets a later
      // sync recognize the opt-out (still a SHA-256 hash, no plaintext PII).
      const canonical = canonicalEmail(m.email);
      const x = hashIdentity(m);
      current.push({ k: m.key, d: data, c: canonical ? sha256Hex(canonical) : '', ...(x ? { x } : {}) });
    }
    const hashId = (d) => `${d[0]}|${d[1]}`;

    // Track membership by HASH ROW (Meta matches/removes by the hashes themselves),
    // not by entity key. `current` = desired rows now; `prior` = rows we previously
    // uploaded, including retained orphans we couldn't safely delete yet.
    const currentByHash = new Map();
    for (const e of current) if (!currentByHash.has(hashId(e.d))) currentByHash.set(hashId(e.d), e);

    const state = await loadState(audienceKey);
    const prior = (Array.isArray(state && state.member_keys) ? state.member_keys : [])
      .filter((e) => e && Array.isArray(e.d) && e.d.length === 2);
    const stale = await def.staleLeavingKeys(prior, members, suppression);
    for (const k of stale.testKeys) testKeys.add(k);
    for (const k of [...stale.testKeys, ...stale.optOutKeys]) leavingKeys.add(k);
    // A leaving row is kept out of planAdds: a current member with the same email and
    // phone is then sent with its own name/ZIP, never handed the leaving row's.
    const leaving = prior.filter((e) => leavingKeys.has(e.k));
    const priorByHash = new Map();
    for (const e of prior) if (!leavingKeys.has(e.k) && !priorByHash.has(hashId(e.d))) priorByHash.set(hashId(e.d), e);

    // Adds go out under the enriched schema; planAdds says which members and why.
    const { addRows, enrichRows, keep } = planAdds(currentByHash, priorByHash);

    // Identifiers held by any current member: keep has every one, with its email and
    // phone and the name/ZIP hashes stored for it or sent this run (an edit that was
    // never sent is not on Meta, so it holds nothing back). Meta's audience DELETE
    // removes a person if ANY identifier in the row matches, so a stale row that still
    // shares a current identifier must NOT be deleted (it would drop a person we keep)
    // — we retain it and retry once that identifier leaves the audience.
    const currentIds = new Set();
    for (const e of keep.values()) for (const id of idsOf(e)) currentIds.add(id);

    // Identifier hashes of active marketing opt-outs (and wrong_number phones),
    // hashed exactly like uploaded members. A prior row carrying one of these
    // must be removed even when it shares its OTHER identifier with a current
    // member — shared-identifier retention must not keep an opted-out email
    // matchable forever via a household phone. (Gmail dot-variants uploaded
    // under a different raw string hash differently and can't be derived here;
    // the collector-level canonical match prevents new ones from uploading.)
    const suppressedIdHashes = new Set();
    const suppressedCanonicalHashes = new Set();
    for (const raw of suppression.rawOptOutEmails) {
      const email = normalizeEmail(raw);
      if (email) suppressedIdHashes.add(sha256Hex(email));
      const canonical = canonicalEmail(raw);
      if (canonical) suppressedCanonicalHashes.add(sha256Hex(canonical));
    }
    for (const raw of suppression.rawOptOutPhones) {
      const phone = normalizePhone(raw);
      if (phone) suppressedIdHashes.add(sha256Hex(phone.replace(/^\+/, '')));
    }
    // Meta rows hash the RAW normalized email (no gmail canonicalization), so
    // a suppression stored under a different dot/+tag variant hashes to a
    // DIFFERENT value than the uploaded row. The dropped members carry the
    // exact source strings the original upload hashed — hash those too, so a
    // canonically-matched opt-out removes the row uploaded under any variant
    // still present in the source tables. (A hard-deleted source row whose
    // suppression uses a different variant remains untraceable — hashes are
    // one-way and the state stores no plaintext PII by design.)
    for (const m of suppressedMembers) {
      const d = hashMember(m);
      if (d) {
        if (d[0]) suppressedIdHashes.add(d[0]);
        if (d[1]) suppressedIdHashes.add(d[1]);
      }
    }
    // Match by raw identifier hash OR by the row's persisted canonical consent
    // hash (rows written before this field exists simply lack c and fall back
    // to raw-hash matching until the next state rewrite refreshes them).
    const hasSuppressedId = (e) => !!(
      (e.d[0] && suppressedIdHashes.has(e.d[0]))
      || (e.d[1] && suppressedIdHashes.has(e.d[1]))
      || (e.c && suppressedCanonicalHashes.has(e.c))
    );

    const removeRows = [];      // stored before names were added: the two-key row
    const removeRowsNamed = []; // stored with name/ZIP hashes: the enriched row that was added
    const remove = (e) => (e.x ? removeRowsNamed.push([...e.d, ...e.x]) : removeRows.push(e.d));
    const retained = []; // uploaded rows no longer current but unsafe to delete now
    const removedSuppressedIds = new Set(); // ALL identifiers on force-removed rows
    let consentRemovals = 0;
    let testRemovals = 0;
    // Consent removal, and removal of a leaving row, override shared-identifier retention.
    const forceRemove = (e) => {
      remove(e);
      if (testKeys.has(e.k)) testRemovals += 1; else consentRemovals += 1;
      for (const id of idsOf(e)) removedSuppressedIds.add(id);
    };
    leaving.forEach(forceRemove);
    for (const [h, e] of priorByHash) {
      if (currentByHash.has(h)) continue; // still a current member
      if (hasSuppressedId(e)) forceRemove(e);
      else if (sharesAny(e, currentIds)) retained.push(e);
      else remove(e);
    }

    // Persist current rows + retained orphans, so a future sync deletes each orphan
    // once its shared identifier leaves the audience (self-healing, no orphan leak).
    // EXCEPT: a current member sharing an identifier with a force-removed
    // row is dropped from state — Meta's DELETE matches by ANY identifier, so the
    // remove (which runs AFTER this run's adds) may knock them out too; absent from
    // state, the next sync re-adds them. One-cycle flicker, guaranteed removal.
    const persisted = [];
    let deferredReAdds = 0;
    for (const row of keep.values()) {
      if (sharesAny(row, removedSuppressedIds)) {
        deferredReAdds += 1;
        continue;
      }
      persisted.push(row);
    }
    persisted.push(...retained);

    const summary = {
      audienceKey,
      configured: true,
      dryRun,
      name: def.name,
      eligible: members.length,
      withMatchKeys: currentByHash.size,
      skippedNoKeys,
      toAdd: addRows.length - enrichRows,
      toEnrich: enrichRows,
      toRemove: removeRows.length + removeRowsNamed.length,
      retained: retained.length,
      consentRemovals,
      testRemovals,
      deferredReAdds,
    };

    if (dryRun) {
      return { ...summary, note: 'Dry run — set META_AUDIENCES_ALLOW_UPLOADS=true to apply.' };
    }

    const audienceId = await ensureAudience(audienceKey, def);
    const added = addRows.length ? await pushUsers(audienceId, addRows, 'POST', SCHEMA_ENRICHED) : 0;
    const removed = (removeRows.length ? await pushUsers(audienceId, removeRows, 'DELETE') : 0)
      + (removeRowsNamed.length ? await pushUsers(audienceId, removeRowsNamed, 'DELETE', SCHEMA_ENRICHED) : 0);

    await saveState(audienceKey, {
      meta_audience_id: audienceId,
      member_keys: JSON.stringify(persisted),
      member_count: currentByHash.size,
      last_synced_at: db.fn.now(),
      last_status: 'synced',
    });

    return { ...summary, audienceId, added, removed, memberCount: currentByHash.size };
  });
}

async function syncAll({ validateOnly = false } = {}) {
  const results = {};
  for (const key of Object.keys(AUDIENCES)) {
    try {
      results[key] = await syncAudience(key, { validateOnly });
    } catch (err) {
      results[key] = { audienceKey: key, error: err.message };
    }
  }
  return results;
}

// ── Readiness (read-only; safe without a token) ──────────────────────
async function buildReadiness() {
  const out = {
    configured: isConfigured(),
    uploadsAllowed: uploadsAllowed(),
    apiVersion: apiVersion(),
    adAccount: adAccountId(),
    note: isConfigured()
      ? undefined
      : 'Set META_AUDIENCES_ACCESS_TOKEN (ads_management) + META_ADS_ACCOUNT_ID, then META_AUDIENCES_ALLOW_UPLOADS=true to go live.',
    audiences: {},
  };
  for (const [key, def] of Object.entries(AUDIENCES)) {
    let members = [];
    let error = null;
    try { members = await def.collect(); } catch (err) { error = err.message; }
    const withKeys = members.filter((m) => hashMember(m)).length;
    const state = await loadState(key).catch(() => null);
    out.audiences[key] = {
      name: def.name,
      eligible: members.length,
      withMatchKeys: withKeys,
      missingMatchKeys: members.length - withKeys,
      metaAudienceId: (state && state.meta_audience_id) || null,
      lastSyncedAt: (state && state.last_synced_at) || null,
      lastMemberCount: (state && state.member_count) || 0,
      error,
    };
  }
  return out;
}

module.exports = {
  isConfigured,
  buildReadiness,
  syncAudience,
  syncAll,
  _private: {
    AUDIENCES,
    apiVersion,
    adAccountId,
    boolEnv,
    collectCustomerMembers,
    collectUnbookedLeadMembers,
    staleLeadLeavingKeys,
    staleCustomerLeavingKeys,
    unbookedLeadStatusFilter,
    hashMember,
    hashIdentity,
    splitInternalTest,
    SCHEMA,
    SCHEMA_ENRICHED,
    uploadsAllowed,
  },
};
