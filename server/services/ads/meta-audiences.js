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

const GRAPH = 'https://graph.facebook.com';
const STATE_TABLE = 'ad_audience_syncs';
const SCHEMA = ['EMAIL', 'PHONE']; // Meta multi-key schema; data rows align to this order
const MAX_USERS_PER_CALL = 1000; // Meta allows up to 10k/call; keep batches modest
const DEFAULT_LEAD_WINDOW_DAYS = 180;

// Lead lifecycle states that mean "no longer an unbooked prospect".
const LEAD_BOOKED = ['booked', 'converted', 'won', 'customer', 'active_customer'];
const LEAD_DEAD = ['lost', 'disqualified', 'unqualified', 'spam', 'invalid'];

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

// ── Member collection — returns [{ key, email, phone }] ──────────────
async function collectCustomerMembers() {
  const rows = await db('customers')
    .where('active', true)
    .whereNull('churned_at')
    .where((q) => q.whereNotNull('email').orWhereNotNull('phone'))
    .select('id', 'email', 'phone');
  return rows.map((r) => ({ key: `customer:${r.id}`, email: r.email, phone: r.phone }));
}

async function collectUnbookedLeadMembers({ windowDays = DEFAULT_LEAD_WINDOW_DAYS } = {}) {
  const excluded = [...LEAD_BOOKED, ...LEAD_DEAD];
  const cutoff = new Date(Date.now() - windowDays * 86400000).toISOString();
  const placeholders = excluded.map(() => '?').join(',');
  const rows = await db('leads')
    .whereNull('customer_id')
    .whereRaw(`LOWER(COALESCE(status, '')) NOT IN (${placeholders})`, excluded)
    .where('created_at', '>=', cutoff)
    .where((q) => q.whereNotNull('email').orWhereNotNull('phone'))
    .select('id', 'email', 'phone');
  return rows.map((r) => ({ key: `lead:${r.id}`, email: r.email, phone: r.phone }));
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

// Re-hash members that dropped out of the audience (no longer eligible, but still
// in the DB) so we can DELETE them from the Meta audience.
async function hashRemovedMembers(keys) {
  const out = [];
  const customerIds = keys.filter((k) => k.startsWith('customer:')).map((k) => k.slice('customer:'.length));
  const leadIds = keys.filter((k) => k.startsWith('lead:')).map((k) => k.slice('lead:'.length));
  if (customerIds.length) {
    const rows = await db('customers').whereIn('id', customerIds).select('email', 'phone');
    for (const r of rows) { const h = hashMember(r); if (h) out.push(h); }
  }
  if (leadIds.length) {
    const rows = await db('leads').whereIn('id', leadIds).select('email', 'phone');
    for (const r of rows) { const h = hashMember(r); if (h) out.push(h); }
  }
  return out;
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
    const members = await def.collect();
    const memberByKey = new Map(members.map((m) => [m.key, m]));
    const currentKeys = members.map((m) => m.key);
    const currentSet = new Set(currentKeys);

    const state = await loadState(audienceKey);
    const priorKeys = Array.isArray(state && state.member_keys) ? state.member_keys : [];
    const priorSet = new Set(priorKeys);

    const toAddKeys = currentKeys.filter((k) => !priorSet.has(k));
    const toRemoveKeys = priorKeys.filter((k) => !currentSet.has(k));

    let addSkippedNoKeys = 0;
    const addRows = [];
    for (const k of toAddKeys) {
      const h = hashMember(memberByKey.get(k));
      if (h) addRows.push(h); else addSkippedNoKeys++;
    }

    const summary = {
      audienceKey,
      configured: true,
      dryRun,
      name: def.name,
      eligible: members.length,
      toAdd: toAddKeys.length,
      toRemove: toRemoveKeys.length,
      addWithMatchKeys: addRows.length,
      addSkippedNoKeys,
    };

    if (dryRun) {
      return { ...summary, note: 'Dry run — set META_AUDIENCES_ALLOW_UPLOADS=true to apply.' };
    }

    const removeRows = await hashRemovedMembers(toRemoveKeys);
    const audienceId = await ensureAudience(audienceKey, def);
    const added = addRows.length ? await pushUsers(audienceId, addRows, 'POST') : 0;
    const removed = removeRows.length ? await pushUsers(audienceId, removeRows, 'DELETE') : 0;

    await saveState(audienceKey, {
      meta_audience_id: audienceId,
      member_keys: JSON.stringify(currentKeys),
      member_count: currentKeys.length,
      last_synced_at: db.fn.now(),
      last_status: 'synced',
    });

    return { ...summary, audienceId, added, removed, memberCount: currentKeys.length };
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
    hashRemovedMembers,
    uploadsAllowed,
  },
};
