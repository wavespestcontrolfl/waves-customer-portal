'use strict';
/**
 * Google Customer Match sync — uploads first-party customer/lead lists to Google Ads
 * Customer Match user lists for SUPPRESSION (exclude existing customers from
 * prospecting) and RETARGETING (re-engage unbooked leads). The Google analog of
 * meta-audiences.js: it reuses the SAME audience definitions + member hashing
 * (meta-audiences._private) and the SAME Data Manager API + service account/scope as
 * the conversion uploader (data-manager.js) — just the audienceMembers endpoints.
 *
 * Ships DARK. No-ops unless the Data Manager service account + customer id + at least
 * one user-list id are set. Writes require GOOGLE_CUSTOMER_MATCH_ALLOW_UPLOADS=true;
 * otherwise every call is a DRY RUN (computes the add/remove delta, no API call).
 *
 * Go-live prereqs (owner): the Google Ads account must have accepted Customer Match
 * terms, and the user lists must already exist (created in Google Ads) — set their ids
 * via GOOGLE_CM_CUSTOMERS_LIST_ID / GOOGLE_CM_UNBOOKED_LEADS_LIST_ID.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { runExclusive } = require('../../utils/cron-lock');
const { collectCustomerMembers, collectUnbookedLeadMembers, hashMember } = require('./meta-audiences')._private;

const DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager';
const INGEST_URL = 'https://datamanager.googleapis.com/v1/audienceMembers:ingest';
const REMOVE_URL = 'https://datamanager.googleapis.com/v1/audienceMembers:remove';
const STATE_TABLE = 'ad_audience_syncs';
const MAX_MEMBERS_PER_CALL = 10000; // Data Manager allows up to 10k AudienceMembers/request

function boolEnv(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(raw).toLowerCase());
}

// audience key -> { name, listIdEnv, collect }. Same two audiences as the Meta lane.
const AUDIENCES = {
  customers: {
    name: 'Customers (suppression)',
    listIdEnv: 'GOOGLE_CM_CUSTOMERS_LIST_ID',
    collect: collectCustomerMembers,
  },
  unbooked_leads: {
    name: 'Unbooked leads (retargeting)',
    listIdEnv: 'GOOGLE_CM_UNBOOKED_LEADS_LIST_ID',
    collect: collectUnbookedLeadMembers,
  },
};

let _google;
function getGoogle() {
  if (_google !== undefined) return _google;
  try { _google = require('googleapis').google; } catch { _google = null; }
  return _google;
}

function credentialsJson() {
  const raw = process.env.GOOGLE_ADS_DATA_MANAGER_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}
function customerId() {
  return String(process.env.GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER_ID || '').trim() || null;
}
function loginCustomerId() {
  return String(process.env.GOOGLE_ADS_DATA_MANAGER_LOGIN_CUSTOMER_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || '').trim() || null;
}
function listIdFor(audienceKey) {
  const def = AUDIENCES[audienceKey];
  return def ? (String(process.env[def.listIdEnv] || '').trim() || null) : null;
}
function uploadsAllowed() {
  return boolEnv('GOOGLE_CUSTOMER_MATCH_ALLOW_UPLOADS', false);
}
function isConfigured() {
  return !!(credentialsJson() && customerId() && (listIdFor('customers') || listIdFor('unbooked_leads')));
}

async function getAccessToken() {
  const g = getGoogle();
  if (!g) throw new Error('googleapis is not installed');
  const creds = credentialsJson();
  if (!creds) throw new Error('Google Data Manager service account not configured');
  const auth = new g.auth.GoogleAuth({ credentials: creds, scopes: [DATA_MANAGER_SCOPE] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  const accessToken = typeof token === 'string' ? token : token && token.token;
  if (!accessToken) throw new Error('Unable to obtain Google Data Manager access token');
  return accessToken;
}

function destination(listId) {
  const cid = customerId();
  if (!cid || !listId) return null;
  const dest = {
    operatingAccount: { accountType: 'GOOGLE_ADS', accountId: cid },
    productDestinationId: String(listId),
  };
  const loginId = loginCustomerId();
  if (loginId) dest.loginAccount = { accountType: 'GOOGLE_ADS', accountId: loginId };
  return dest;
}

// A member hash row [emailSha256, phoneSha256] -> Data Manager UserData.
function toUserData(d) {
  const userIdentifiers = [];
  if (d[0]) userIdentifiers.push({ emailAddress: d[0] });
  if (d[1]) userIdentifiers.push({ phoneNumber: d[1] });
  return { userIdentifiers };
}

async function pushMembers(listId, rows, op, { fetchImpl = global.fetch } = {}) {
  const url = op === 'remove' ? REMOVE_URL : INGEST_URL;
  const dest = destination(listId);
  const token = await getAccessToken();
  let count = 0;
  for (let i = 0; i < rows.length; i += MAX_MEMBERS_PER_CALL) {
    const batch = rows.slice(i, i + MAX_MEMBERS_PER_CALL);
    const body = {
      destinations: [dest],
      audienceMembers: batch.map((d) => ({ userData: toUserData(d) })),
      validateOnly: false,
      encoding: 'HEX',
      termsOfService: { customerMatchTermsOfServiceStatus: 'ACCEPTED' },
    };
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json;
    try { json = await resp.json(); } catch { json = {}; }
    if (!resp.ok || (json && json.error)) {
      const e = (json && json.error) || {};
      throw new Error(`Data Manager audienceMembers:${op} ${resp.status}: ${e.message || 'request failed'}`);
    }
    count += batch.length;
  }
  return count;
}

// State lives in the shared ad_audience_syncs table, namespaced by platform so the
// Google rows don't collide with the Meta rows (which use the bare audience key).
function stateKey(audienceKey) { return `google:${audienceKey}`; }
async function loadState(audienceKey) {
  return (await db(STATE_TABLE).where({ audience_key: stateKey(audienceKey) }).first()) || null;
}
async function saveState(audienceKey, fields) {
  const row = { audience_key: stateKey(audienceKey), platform: 'google', ...fields, updated_at: db.fn.now() };
  await db(STATE_TABLE).insert({ ...row, created_at: db.fn.now() }).onConflict('audience_key').merge(row);
}

async function syncAudience(audienceKey, { validateOnly = false } = {}) {
  const def = AUDIENCES[audienceKey];
  if (!def) throw new Error(`Unknown audience: ${audienceKey}`);
  const listId = listIdFor(audienceKey);
  if (!isConfigured() || !listId) {
    return {
      audienceKey,
      configured: false,
      error: `Google Customer Match not configured (service account + GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID + ${def.listIdEnv}).`,
    };
  }
  const dryRun = validateOnly === true || !uploadsAllowed();

  return runExclusive(`google-customer-match:${audienceKey}`, async () => {
    const members = await def.collect();

    // Keep only members with usable match keys; store the hash row so removals survive
    // a hard-deleted source row and a corrected identifier re-uploads later.
    const current = [];
    let skippedNoKeys = 0;
    for (const m of members) {
      const d = hashMember(m);
      if (d) current.push({ k: m.key, d }); else skippedNoKeys++;
    }

    // Diff by HASH ROW (Google matches/removes users by the hashed identifiers).
    const hashId = (d) => `${d[0]}|${d[1]}`;
    const currentByHash = new Map();
    for (const e of current) if (!currentByHash.has(hashId(e.d))) currentByHash.set(hashId(e.d), e);

    const state = await loadState(audienceKey);
    const prior = (Array.isArray(state && state.member_keys) ? state.member_keys : [])
      .filter((e) => e && Array.isArray(e.d) && e.d.length === 2);
    const priorByHash = new Map();
    for (const e of prior) if (!priorByHash.has(hashId(e.d))) priorByHash.set(hashId(e.d), e);

    // Never remove a row whose email/phone is still held by a current member (a remove
    // matches by any identifier, so it would drop a person we keep) — retain + retry.
    const currentHashes = new Set();
    for (const e of currentByHash.values()) {
      if (e.d[0]) currentHashes.add(e.d[0]);
      if (e.d[1]) currentHashes.add(e.d[1]);
    }
    const safeToDelete = (d) => !((d[0] && currentHashes.has(d[0])) || (d[1] && currentHashes.has(d[1])));

    const addRows = [];
    for (const [h, e] of currentByHash) if (!priorByHash.has(h)) addRows.push(e.d);

    const removeRows = [];
    const retained = [];
    for (const [h, e] of priorByHash) {
      if (currentByHash.has(h)) continue;
      if (safeToDelete(e.d)) removeRows.push(e.d); else retained.push(e);
    }
    const persisted = [...currentByHash.values(), ...retained];

    const summary = {
      audienceKey,
      configured: true,
      dryRun,
      name: def.name,
      listId,
      eligible: members.length,
      withMatchKeys: currentByHash.size,
      skippedNoKeys,
      toAdd: addRows.length,
      toRemove: removeRows.length,
      retained: retained.length,
    };

    if (dryRun) {
      return { ...summary, note: 'Dry run — set GOOGLE_CUSTOMER_MATCH_ALLOW_UPLOADS=true to apply.' };
    }

    const added = addRows.length ? await pushMembers(listId, addRows, 'ingest') : 0;
    const removed = removeRows.length ? await pushMembers(listId, removeRows, 'remove') : 0;

    await saveState(audienceKey, {
      member_keys: JSON.stringify(persisted),
      member_count: currentByHash.size,
      last_synced_at: db.fn.now(),
      last_status: 'synced',
    });

    return { ...summary, added, removed, memberCount: currentByHash.size };
  });
}

async function syncAll({ validateOnly = false } = {}) {
  const results = {};
  for (const key of Object.keys(AUDIENCES)) {
    if (!listIdFor(key)) { results[key] = { audienceKey: key, skipped: true, reason: 'no_list_id' }; continue; }
    try {
      results[key] = await syncAudience(key, { validateOnly });
    } catch (err) {
      results[key] = { audienceKey: key, error: err.message };
    }
  }
  return results;
}

async function buildReadiness() {
  const out = {
    configured: isConfigured(),
    uploadsAllowed: uploadsAllowed(),
    customerId: customerId(),
    note: isConfigured()
      ? undefined
      : 'Set the Data Manager service account + GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID + a GOOGLE_CM_*_LIST_ID, then GOOGLE_CUSTOMER_MATCH_ALLOW_UPLOADS=true to go live.',
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
      listId: listIdFor(key),
      eligible: members.length,
      withMatchKeys: withKeys,
      missingMatchKeys: members.length - withKeys,
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
  _private: { AUDIENCES, destination, toUserData, listIdFor, uploadsAllowed, stateKey, getAccessToken },
};
