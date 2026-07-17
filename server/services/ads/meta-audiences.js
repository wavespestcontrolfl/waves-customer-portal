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
const { filterMarketingSuppressed, partitionMarketingSuppressed, loadMarketingSuppression } = require('./ad-audience-consent');

const GRAPH = 'https://graph.facebook.com';
const STATE_TABLE = 'ad_audience_syncs';
const SCHEMA = ['EMAIL', 'PHONE']; // Meta multi-key schema; data rows align to this order
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
async function collectCustomerMembers({ partition = false } = {}) {
  // REAL customers only. `customers.active` is also true for CRM lead/prospect rows
  // (public quote leads are inserted as customers at pipeline_stage 'new_lead'), so
  // use the canonical live-customer predicate, not just `active`.
  const rows = await whereLiveCustomer(db('customers'))
    .where((q) => q.whereNotNull('email').orWhereNotNull('phone'))
    .select('id', 'email', 'phone');
  const members = rows.map((r) => ({ key: `customer:${r.id}`, email: r.email, phone: r.phone }));
  // identifiers-only: this audience is the prospecting EXCLUSION list — an
  // opted-out customer must STAY in it or they start seeing prospecting ads
  // again. Only invalid identifiers (wrong_number = a stranger's phone) are
  // stripped. Google Customer Match shares this collector and semantics.
  const opts = { audienceKey: 'customers', mode: 'identifiers-only' };
  return partition ? partitionMarketingSuppressed(members, opts) : filterMarketingSuppressed(members, opts);
}

async function collectUnbookedLeadMembers({ windowDays = DEFAULT_LEAD_WINDOW_DAYS, partition = false } = {}) {
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const placeholders = LEAD_CLOSED.map(() => '?').join(',');
  // Recent, not-closed leads who are NOT already real customers. We can't filter on
  // `whereNull('customer_id')` — quote-wizard leads get a 'new_lead' prospect customer
  // linked back, which would drop the biggest retargeting source. Instead exclude only
  // leads whose linked customer is a LIVE customer.
  const rows = await db('leads')
    .whereRaw(`LOWER(COALESCE(status, '')) NOT IN (${placeholders})`, LEAD_CLOSED)
    .whereNull('deleted_at')
    .where('created_at', '>=', cutoff)
    .where((q) => q.whereNotNull('email').orWhereNotNull('phone'))
    .whereNotExists(function existsLiveCustomer() {
      whereLiveCustomer(this.select(db.raw('1')).from('customers as c').whereRaw('c.id = leads.customer_id'));
    })
    .select('id', 'email', 'phone');
  const members = rows.map((r) => ({ key: `lead:${r.id}`, email: r.email, phone: r.phone }));
  const opts = { audienceKey: 'unbooked_leads' };
  return partition ? partitionMarketingSuppressed(members, opts) : filterMarketingSuppressed(members, opts);
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

async function pushUsers(audienceId, rows, method) {
  let count = 0;
  for (let i = 0; i < rows.length; i += MAX_USERS_PER_CALL) {
    const batch = rows.slice(i, i + MAX_USERS_PER_CALL);
    await graph(`${audienceId}/users`, { method, body: { payload: { schema: SCHEMA, data: batch } } });
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
    const collected = await def.collect({ partition: true });
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
      if (data) current.push({ k: m.key, d: data }); else skippedNoKeys++;
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
    const currentHashes = new Set();
    for (const e of currentByHash.values()) {
      if (e.d[0]) currentHashes.add(e.d[0]);
      if (e.d[1]) currentHashes.add(e.d[1]);
    }
    const safeToDelete = (d) => !((d[0] && currentHashes.has(d[0])) || (d[1] && currentHashes.has(d[1])));

    // Identifier hashes of active marketing opt-outs (and wrong_number phones),
    // hashed exactly like uploaded members. A prior row carrying one of these
    // must be removed even when it shares its OTHER identifier with a current
    // member — shared-identifier retention must not keep an opted-out email
    // matchable forever via a household phone. (Gmail dot-variants uploaded
    // under a different raw string hash differently and can't be derived here;
    // the collector-level canonical match prevents new ones from uploading.)
    const suppression = await loadMarketingSuppression();
    const suppressedIdHashes = new Set();
    for (const raw of suppression.rawOptOutEmails) {
      const email = normalizeEmail(raw);
      if (email) suppressedIdHashes.add(sha256Hex(email));
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
    const hasSuppressedId = (d) => !!((d[0] && suppressedIdHashes.has(d[0])) || (d[1] && suppressedIdHashes.has(d[1])));

    const addRows = [];
    for (const [h, e] of currentByHash) if (!priorByHash.has(h)) addRows.push(e.d);

    const removeRows = [];
    const retained = []; // uploaded rows no longer current but unsafe to delete now
    const removedSuppressedIds = new Set(); // ALL identifiers on consent-removed rows
    let consentRemovals = 0;
    for (const [h, e] of priorByHash) {
      if (currentByHash.has(h)) continue; // still a current member
      if (hasSuppressedId(e.d)) {
        // Consent removal overrides shared-identifier retention.
        removeRows.push(e.d);
        consentRemovals += 1;
        if (e.d[0]) removedSuppressedIds.add(e.d[0]);
        if (e.d[1]) removedSuppressedIds.add(e.d[1]);
        continue;
      }
      if (safeToDelete(e.d)) removeRows.push(e.d); else retained.push(e);
    }

    // Persist current rows + retained orphans, so a future sync deletes each orphan
    // once its shared identifier leaves the audience (self-healing, no orphan leak).
    // EXCEPT: a current member sharing an identifier with a consent-removed row is
    // dropped from state — Meta's DELETE matches by ANY identifier, so the remove
    // (which runs AFTER this run's adds) may knock them out too; absent from state,
    // the next sync re-adds them. One-cycle flicker, guaranteed consent removal.
    const persisted = [];
    let deferredReAdds = 0;
    for (const e of currentByHash.values()) {
      const sharesRemoved = (e.d[0] && removedSuppressedIds.has(e.d[0])) || (e.d[1] && removedSuppressedIds.has(e.d[1]));
      if (sharesRemoved) { deferredReAdds += 1; continue; }
      persisted.push(e);
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
      toRemove: removeRows.length,
      retained: retained.length,
      consentRemovals,
      deferredReAdds,
    };

    if (dryRun) {
      return { ...summary, note: 'Dry run — set META_AUDIENCES_ALLOW_UPLOADS=true to apply.' };
    }

    const audienceId = await ensureAudience(audienceKey, def);
    const added = addRows.length ? await pushUsers(audienceId, addRows, 'POST') : 0;
    const removed = removeRows.length ? await pushUsers(audienceId, removeRows, 'DELETE') : 0;

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
    uploadsAllowed,
  },
};
