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
const { filterMarketingSuppressed, partitionMarketingSuppressed, loadMarketingSuppression, canonicalEmail } = require('./ad-audience-consent');
const matchFields = require('./ad-match-fields');

const GRAPH = 'https://graph.facebook.com';
const STATE_TABLE = 'ad_audience_syncs';
// Meta multi-key schemas; data rows align to their order. BASE_SCHEMA is the
// row IDENTITY (state, delta, and the removal of legacy rows). ADD_SCHEMA is
// what new/enriched members are uploaded with: the same EMAIL/PHONE plus the
// extra match keys. Every one of those keys is SHA-256 hashed (Meta accepts
// EXTERN_ID unhashed, but our CAPI external_id is hashed and the two must be
// byte-identical to match).
const BASE_SCHEMA = ['EMAIL', 'PHONE'];
const EXTRA_KEYS = ['fn', 'ln', 'zp', 'ct', 'st', 'co', 'xid']; // e-object keys, in ADD_SCHEMA order
const ADD_SCHEMA = [...BASE_SCHEMA, 'FN', 'LN', 'ZIP', 'CT', 'ST', 'COUNTRY', 'EXTERN_ID'];
const MAX_USERS_PER_CALL = 1000; // Meta allows up to 10k/call; keep batches modest
const DEFAULT_LEAD_WINDOW_DAYS = 180;

// Lead statuses that are no longer an "unbooked prospect" — booked/won or dead.
// Mirrors the admin pipeline + agent-workflow closed-status sets (admin-leads.js,
// admin-agents.js), incl. unresponsive/duplicate.
const LEAD_CLOSED = [
  'booked', 'converted', 'won', 'customer', 'active_customer',
  'lost', 'disqualified', 'unqualified', 'spam', 'invalid', 'unresponsive', 'duplicate',
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
  },
  unbooked_leads: {
    name: 'Waves — Unbooked leads (retargeting)',
    description: 'Known leads who have not booked. Use as a retargeting audience.',
    collect: collectUnbookedLeadMembers,
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
  const members = rows.map((r) => ({
    key: `customer:${r.id}`,
    email: r.email,
    phone: r.phone,
    firstName: r.first_name,
    lastName: r.last_name,
    city: r.city,
    state: r.state,
    zip: r.zip,
    externalId: matchFields.externalIdFor({ customerId: r.id }),
  }));
  // identifiers-only: this audience is the prospecting EXCLUSION list — an
  // opted-out customer must STAY in it or they start seeing prospecting ads
  // again. Only invalid identifiers (wrong_number = a stranger's phone) are
  // stripped. Google Customer Match shares this collector and semantics.
  const opts = { audienceKey: 'customers', mode: 'identifiers-only', suppression };
  return partition ? partitionMarketingSuppressed(members, opts) : filterMarketingSuppressed(members, opts);
}

async function collectUnbookedLeadMembers({ windowDays = DEFAULT_LEAD_WINDOW_DAYS, partition = false, suppression = null } = {}) {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const placeholders = LEAD_CLOSED.map(() => '?').join(',');
  // Recent, not-closed leads who are NOT already real customers. We can't filter on
  // `whereNull('customer_id')` — quote-wizard leads get a 'new_lead' prospect customer
  // linked back, which would drop the biggest retargeting source. Instead exclude only
  // leads whose linked customer is a LIVE customer.
  const rows = await db('leads')
    // The linked (prospect) customer only supplies name/address/id fallbacks.
    .leftJoin('customers as lc', 'lc.id', 'leads.customer_id')
    .whereRaw(`LOWER(COALESCE(leads.status, '')) NOT IN (${placeholders})`, LEAD_CLOSED)
    .whereNull('leads.deleted_at')
    .where('leads.created_at', '>=', cutoff)
    .where((q) => q.whereNotNull('leads.email').orWhereNotNull('leads.phone'))
    .whereNotExists(function existsLiveCustomer() {
      whereLiveCustomer(this.select(db.raw('1')).from('customers as c').whereRaw('c.id = leads.customer_id'));
    })
    .select(
      'leads.id', 'leads.email', 'leads.phone', 'leads.customer_id',
      'leads.first_name', 'leads.last_name', 'leads.city', 'leads.zip',
      'lc.first_name as customer_first_name', 'lc.last_name as customer_last_name',
      'lc.city as customer_city', 'lc.state as customer_state', 'lc.zip as customer_zip',
    );
  const members = rows.map((r) => ({
    key: `lead:${r.id}`,
    email: r.email,
    phone: r.phone,
    ...matchFields.mergeIdentity(
      { firstName: r.first_name, lastName: r.last_name, city: r.city, zip: r.zip },
      { firstName: r.customer_first_name, lastName: r.customer_last_name, city: r.customer_city, state: r.customer_state, zip: r.customer_zip },
    ),
    // Same id the Lead/Purchase conversions use: linked customer id, else lead:<id>.
    externalId: matchFields.externalIdFor({ customerId: r.customer_id, leadId: r.id }),
  }));
  const opts = { audienceKey: 'unbooked_leads', suppression };
  return partition ? partitionMarketingSuppressed(members, opts) : filterMarketingSuppressed(members, opts);
}

// ── PII hashing → the BASE_SCHEMA identity row, or null if no match keys ──
function hashMember(member) {
  const email = normalizeEmail(member && member.email);
  const phone = normalizePhone(member && member.phone); // -> +1XXXXXXXXXX | null
  const emailHash = email ? sha256Hex(email) : '';
  const phoneHash = phone ? sha256Hex(phone.replace(/^\+/, '')) : ''; // Meta hashes phone w/o '+'
  if (!emailHash && !phoneHash) return null;
  return [emailHash, phoneHash];
}

// Hashed extra match keys for a member, or null. Only keys we have; the caller
// only ever uploads them alongside a row that already has email/phone (a
// member with neither never enters an audience, so extras cannot create one).
function hashExtras(member) {
  const id = matchFields.normalizeIdentity(member);
  const e = {};
  if (id.fn) e.fn = sha256Hex(id.fn);
  if (id.ln) e.ln = sha256Hex(id.ln);
  if (id.zp) e.zp = sha256Hex(id.zp);
  if (id.ct) e.ct = sha256Hex(id.ct);
  if (id.st) e.st = sha256Hex(id.st);
  if (Object.keys(e).length) e.co = sha256Hex('us');
  const xid = matchFields.normalizeExternalId(member && member.externalId);
  if (xid) e.xid = sha256Hex(xid);
  return Object.keys(e).length ? e : null;
}

// A data row in ADD_SCHEMA order from a state entry's hashed parts.
const fullRow = (d, e) => [d[0], d[1], ...EXTRA_KEYS.map((k) => (e && e[k]) || '')];

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

async function pushUsers(audienceId, rows, method, schema = BASE_SCHEMA) {
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
      const entry = { k: m.key, d: data, c: canonical ? sha256Hex(canonical) : '' };
      // e: the hashed extra keys uploaded with this row. Persisted so a later
      // removal can send the exact row that was uploaded, and so a change in
      // the extras (or their first appearance on an already-uploaded member)
      // is detected and re-sent. d stays the identity, so this never churns.
      const extras = hashExtras(m);
      if (extras) entry.e = extras;
      current.push(entry);
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
    const priorByHash = new Map();
    for (const e of prior) if (!priorByHash.has(hashId(e.d))) priorByHash.set(hashId(e.d), e);

    // Identifiers held by any current member. Meta's audience DELETE removes a person
    // if ANY identifier in the row matches, so a stale row that still shares a current
    // identifier must NOT be deleted (it would drop a person we keep) — we retain it
    // and retry once that identifier leaves the audience.
    // A member uploaded before keeps EVERY extras variant that went up (latest
    // in e, earlier ones in o), even if its source fields changed or vanished.
    for (const [h, cur] of currentByHash) {
      const before = priorByHash.get(h);
      if (before) currentByHash.set(h, matchFields.carryVariants(before, cur));
    }

    // Handles = email/phone hashes plus the external id and the name+ZIP
    // triple of rows uploaded with extras (entryHandles). Legacy rows carry
    // only email/phone handles, so their decisions are exactly as before.
    const currentHashes = new Set();
    for (const e of currentByHash.values()) for (const h of matchFields.entryHandles(e)) currentHashes.add(h);
    const safeToDelete = (entry) => !matchFields.entryHandles(entry).some((h) => currentHashes.has(h));

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
    // Opt-outs are recorded by email/phone only, so this matches d (and c);
    // the extras of an opted-out row leave with it because the removal below
    // deletes the exact row (incl. extras) that was uploaded.
    const hasSuppressedId = (e) => !!(
      (e.d[0] && suppressedIdHashes.has(e.d[0]))
      || (e.d[1] && suppressedIdHashes.has(e.d[1]))
      || (e.c && suppressedCanonicalHashes.has(e.c))
    );

    const addRows = [];
    for (const [h, e] of currentByHash) if (!priorByHash.has(h)) addRows.push(fullRow(e.d, e.e));

    const removeRows = [];
    const retained = []; // uploaded rows no longer current but unsafe to delete now
    const removedSuppressedIds = new Set(); // ALL identifiers on consent-removed rows
    let consentRemovals = 0;
    for (const [h, e] of priorByHash) {
      if (currentByHash.has(h)) continue; // still a current member
      if (hasSuppressedId(e)) {
        // Consent removal overrides shared-identifier retention.
        removeRows.push(e);
        consentRemovals += 1;
        for (const h of matchFields.entryHandles(e)) removedSuppressedIds.add(h);
        continue;
      }
      if (safeToDelete(e)) removeRows.push(e); else retained.push(e);
    }

    // Persist current rows + retained orphans, so a future sync deletes each orphan
    // once its shared identifier leaves the audience (self-healing, no orphan leak).
    // EXCEPT: a current member sharing an identifier with a consent-removed row is
    // dropped from state — Meta's DELETE matches by ANY identifier, so the remove
    // (which runs AFTER this run's adds) may knock them out too; absent from state,
    // the next sync re-adds them. One-cycle flicker, guaranteed consent removal.
    const persisted = [];
    const enrichRows = [];
    let deferredReAdds = 0;
    for (const e of currentByHash.values()) {
      const sharesRemoved = matchFields.entryHandles(e).some((h) => removedSuppressedIds.has(h));
      if (sharesRemoved) { deferredReAdds += 1; continue; }
      persisted.push(e);
      // Already uploaded, but its extra keys are new or changed since the
      // last upload: re-POST the full row (an add is an idempotent upsert —
      // no removal, so no audience churn). Legacy rows enrich once, here.
      const before = priorByHash.get(hashId(e.d));
      if (before && e.e && matchFields.extrasSig(e.e) !== matchFields.extrasSig(before.e)) enrichRows.push(fullRow(e.d, e.e));
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
      toAdd: addRows.length,
      toEnrich: enrichRows.length,
      toRemove: removeRows.length,
      retained: retained.length,
      consentRemovals,
      deferredReAdds,
    };

    if (dryRun) {
      return { ...summary, note: 'Dry run — set META_AUDIENCES_ALLOW_UPLOADS=true to apply.' };
    }

    const audienceId = await ensureAudience(audienceKey, def);
    const upserts = [...addRows, ...enrichRows];
    const added = upserts.length ? await pushUsers(audienceId, upserts, 'POST', ADD_SCHEMA) : 0;
    // Meta matches a DELETE row by ALL of its keys, so removal sends BOTH the
    // legacy email/phone row (how every member was first uploaded) and, for
    // rows uploaded with extras, the exact full row of EVERY variant that was
    // uploaded. Legacy rows: email/phone only.
    const removed = removeRows.length ? await pushUsers(audienceId, removeRows.map((e) => e.d), 'DELETE', BASE_SCHEMA) : 0;
    const removeFull = removeRows.flatMap((e) => matchFields.entryVariants(e).map((v) => fullRow(e.d, v)));
    if (removeFull.length) await pushUsers(audienceId, removeFull, 'DELETE', ADD_SCHEMA);

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
    hashMember,
    hashExtras,
    fullRow,
    ADD_SCHEMA,
    BASE_SCHEMA,
    uploadsAllowed,
  },
};
