'use strict';
/**
 * Google Customer Match sync — uploads first-party customer/lead lists to Google Ads
 * Customer Match user lists for SUPPRESSION (exclude existing customers from
 * prospecting) and RETARGETING (re-engage unbooked leads). The Google analog of
 * meta-audiences.js: it reuses the SAME audience definitions (meta-audiences._private
 * collectors) and the SAME Data Manager API + service account/scope as the conversion
 * uploader (data-manager.js) — just the audienceMembers endpoints.
 *
 * Hashing is GOOGLE-correct (NOT reused from the Meta lane, which formats differently):
 *   - phone: E.164 WITH the leading '+' (data-manager.normalizePhone), then SHA-256.
 *   - email: lowercase + trim; for gmail.com/googlemail.com also drop dots and strip a
 *     '+tag' from the local part, per Google's Data Manager formatting guide.
 *   - account ids run through cleanNumericId so a dashed UI value (339-393-6713) works.
 *
 * Ships DARK. No-ops unless the Data Manager service account + customer id + at least
 * one user-list id are set. Writes require GOOGLE_CUSTOMER_MATCH_ALLOW_UPLOADS=true;
 * otherwise every call is a DRY RUN (computes the add/remove delta, no API call).
 *
 * Async results: audienceMembers:ingest/:remove return a requestId and finish
 * asynchronously. We persist the upload OPTIMISTICALLY but keep the in-flight ops in
 * `pending`; the next run polls requestStatus and, on FAILED/PARTIAL, REVERTS that op's
 * rows so the delta re-sends them (idempotent) — mirroring data-manager's
 * pending/reconcile flow. A row is only treated as durably applied once Google confirms.
 *
 * Go-live prereqs (owner): the Google Ads account must have accepted Customer Match
 * terms, and the user lists must already exist (created in Google Ads) — set their ids
 * via GOOGLE_CM_CUSTOMERS_LIST_ID / GOOGLE_CM_UNBOOKED_LEADS_LIST_ID.
 */
const db = require('../../models/db');
const logger = require('../logger');
const { runExclusive } = require('../../utils/cron-lock');
const { collectCustomerMembers, collectUnbookedLeadMembers } = require('./meta-audiences')._private;
const { sha256Hex, normalizeEmail, normalizePhone, cleanNumericId } = require('./data-manager')._private;

const DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager';
const INGEST_URL = 'https://datamanager.googleapis.com/v1/audienceMembers:ingest';
const REMOVE_URL = 'https://datamanager.googleapis.com/v1/audienceMembers:remove';
const REQUEST_STATUS_URL = 'https://datamanager.googleapis.com/v1/requestStatus:retrieve';
const STATE_TABLE = 'ad_audience_syncs';
const MAX_MEMBERS_PER_CALL = 10000; // Data Manager allows up to 10k AudienceMembers/request
const PENDING_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // give up waiting after a week -> retry

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
// Google Ads account ids may arrive as the dashed UI value (339-393-6713); strip to
// digits like the conversion uploader so live uploads target a valid account.
function customerId() {
  return cleanNumericId(process.env.GOOGLE_ADS_DATA_MANAGER_CUSTOMER_ID || process.env.GOOGLE_ADS_CUSTOMER_ID) || null;
}
function loginCustomerId() {
  return cleanNumericId(process.env.GOOGLE_ADS_DATA_MANAGER_LOGIN_CUSTOMER_ID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || null;
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

// ── Google-correct member hashing ────────────────────────────────────
// Email: lowercase + trim (data-manager.normalizeEmail); gmail/googlemail also drop
// dots and strip a '+tag' from the local part per Google's formatting guide.
function canonicalEmail(value) {
  const email = normalizeEmail(value);
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at <= 0) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    const canonicalLocal = local.split('+')[0].replace(/\./g, '');
    return canonicalLocal ? `${canonicalLocal}@${domain}` : null;
  }
  return email;
}

// member { key, email, phone } -> [emailSha256, phoneSha256] (hex), or null.
function hashMember(member) {
  const email = canonicalEmail(member && member.email);
  const phone = normalizePhone(member && member.phone); // -> +1XXXXXXXXXX | null (KEEPS '+')
  const emailHash = email ? sha256Hex(email) : '';
  const phoneHash = phone ? sha256Hex(phone) : ''; // Google hashes phone WITH the '+'
  if (!emailHash && !phoneHash) return null;
  return [emailHash, phoneHash];
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

// POST a batch to ingest/remove. Returns { count, requestId }. termsOfService is only
// valid on :ingest — the :remove schema rejects it, so we omit it there.
async function pushMembers(listId, rows, op, { fetchImpl = global.fetch, token } = {}) {
  const url = op === 'remove' ? REMOVE_URL : INGEST_URL;
  const dest = destination(listId);
  const accessToken = token || await getAccessToken();
  let count = 0;
  let requestId = null;
  for (let i = 0; i < rows.length; i += MAX_MEMBERS_PER_CALL) {
    const batch = rows.slice(i, i + MAX_MEMBERS_PER_CALL);
    const body = {
      destinations: [dest],
      audienceMembers: batch.map((d) => ({ userData: toUserData(d) })),
      validateOnly: false,
      encoding: 'HEX',
    };
    if (op !== 'remove') body.termsOfService = { customerMatchTermsOfServiceStatus: 'ACCEPTED' };
    const resp = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let json;
    try { json = await resp.json(); } catch { json = {}; }
    if (!resp.ok || (json && json.error)) {
      const e = (json && json.error) || {};
      throw new Error(`Data Manager audienceMembers:${op} ${resp.status}: ${e.message || 'request failed'}`);
    }
    if (json && json.requestId) requestId = json.requestId;
    count += batch.length;
  }
  return { count, requestId };
}

// Map a requestStatus:retrieve response to a coarse status (mirrors data-manager's
// uploadStatusFromRequestStatus). PROCESSING/UNKNOWN => re-check later; FAILED/PARTIAL
// => the op did not durably apply.
function requestStatusOf(data) {
  const statuses = (data && Array.isArray(data.requestStatusPerDestination) ? data.requestStatusPerDestination : [])
    .map((x) => String((x && x.requestStatus) || '').toUpperCase());
  if (!statuses.length) return 'UNKNOWN';
  if (statuses.some((s) => s === 'PROCESSING' || s === 'REQUEST_STATUS_UNKNOWN')) return 'PROCESSING';
  if (statuses.some((s) => s === 'FAILED')) return 'FAILED';
  if (statuses.some((s) => s === 'PARTIAL_SUCCESS')) return 'PARTIAL';
  if (statuses.every((s) => s === 'SUCCESS')) return 'SUCCESS';
  return 'UNKNOWN';
}

async function getRequestStatus(requestId, { fetchImpl = global.fetch, token } = {}) {
  const accessToken = token || await getAccessToken();
  const url = `${REQUEST_STATUS_URL}?requestId=${encodeURIComponent(requestId)}`;
  const resp = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  let data;
  try { data = await resp.json(); } catch { data = {}; }
  if (!resp.ok) {
    const e = (data && data.error) || {};
    throw new Error(`Data Manager requestStatus ${resp.status}: ${e.message || 'request failed'}`);
  }
  return requestStatusOf(data);
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

const hashId = (d) => `${d[0]}|${d[1]}`;
function asEntries(value) {
  return (Array.isArray(value) ? value : [])
    .filter((e) => e && Array.isArray(e.d) && e.d.length === 2);
}

/**
 * Reconcile in-flight requests from the previous run against the optimistic state.
 * Returns the EFFECTIVE member set (failures reverted so they re-send) plus the
 * pending ops that are still processing. Polls are read-only; a transient poll error
 * leaves the op pending (re-checked next run, unless it has aged out).
 */
async function reconcilePending({ members, pending, token, nowMs }) {
  let effective = members.slice();
  const stillPending = [];
  for (const p of (Array.isArray(pending) ? pending : [])) {
    if (!p || !p.requestId || !Array.isArray(p.members)) continue;
    const aged = p.at ? (nowMs - Date.parse(p.at) > PENDING_MAX_AGE_MS) : false;
    let status;
    try {
      status = await getRequestStatus(p.requestId, { token });
    } catch (err) {
      // Transient poll failure: keep waiting unless the op has aged out.
      if (!aged) { stillPending.push(p); continue; }
      status = 'FAILED';
      logger.warn('[google-customer-match] pending op aged out, reverting', { requestId: p.requestId, op: p.op });
    }
    if (status === 'SUCCESS') continue; // durably applied — optimistic state stands
    if ((status === 'PROCESSING' || status === 'UNKNOWN') && !aged) { stillPending.push(p); continue; }
    // FAILED / PARTIAL / aged-out: revert this op so the delta re-sends it (idempotent).
    if (p.op === 'ingest') {
      const drop = new Set(p.members.map((e) => hashId(e.d)));
      effective = effective.filter((e) => !drop.has(hashId(e.d)));
    } else { // remove did not durably apply -> the members are still in Google; keep them
      const have = new Set(effective.map((e) => hashId(e.d)));
      for (const e of asEntries(p.members)) {
        if (!have.has(hashId(e.d))) { effective.push(e); have.add(hashId(e.d)); }
      }
    }
  }
  return { effective, stillPending };
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
    const currentByHash = new Map();
    for (const e of current) if (!currentByHash.has(hashId(e.d))) currentByHash.set(hashId(e.d), e);

    const state = await loadState(audienceKey);
    const priorMembers = asEntries(state && state.member_keys);

    // On a dry run we don't poll/persist — report the delta against the stored
    // optimistic state. The live path reconciles first (below).
    let effectivePrior = priorMembers;
    let stillPending = [];
    let token = null;
    if (!dryRun) {
      token = await getAccessToken();
      const rec = await reconcilePending({
        members: priorMembers,
        pending: state && state.pending,
        token,
        nowMs: Date.now(),
      });
      effectivePrior = rec.effective;
      stillPending = rec.stillPending;
    }

    const priorByHash = new Map();
    for (const e of effectivePrior) if (!priorByHash.has(hashId(e.d))) priorByHash.set(hashId(e.d), e);

    // Never remove a row whose email/phone is still held by a current member (a remove
    // matches by any identifier, so it would drop a person we keep) — retain + retry.
    const currentHashes = new Set();
    for (const e of currentByHash.values()) {
      if (e.d[0]) currentHashes.add(e.d[0]);
      if (e.d[1]) currentHashes.add(e.d[1]);
    }
    const safeToDelete = (d) => !((d[0] && currentHashes.has(d[0])) || (d[1] && currentHashes.has(d[1])));

    const addEntries = [];
    for (const [h, e] of currentByHash) if (!priorByHash.has(h)) addEntries.push(e);

    const removeEntries = [];
    const retained = [];
    for (const [h, e] of priorByHash) {
      if (currentByHash.has(h)) continue;
      if (safeToDelete(e.d)) removeEntries.push(e); else retained.push(e);
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
      toAdd: addEntries.length,
      toRemove: removeEntries.length,
      retained: retained.length,
    };

    if (dryRun) {
      return { ...summary, note: 'Dry run — set GOOGLE_CUSTOMER_MATCH_ALLOW_UPLOADS=true to apply.' };
    }

    const addRes = addEntries.length
      ? await pushMembers(listId, addEntries.map((e) => e.d), 'ingest', { token })
      : { count: 0, requestId: null };
    const removeRes = removeEntries.length
      ? await pushMembers(listId, removeEntries.map((e) => e.d), 'remove', { token })
      : { count: 0, requestId: null };

    // Carry forward still-processing ops + the ones we just submitted. They stay
    // OPTIMISTICALLY in member_keys; next run's reconcile reverts any that Google fails.
    const nowIso = new Date().toISOString();
    const newPending = [...stillPending];
    if (addRes.requestId) newPending.push({ requestId: addRes.requestId, op: 'ingest', at: nowIso, members: addEntries });
    if (removeRes.requestId) newPending.push({ requestId: removeRes.requestId, op: 'remove', at: nowIso, members: removeEntries });

    await saveState(audienceKey, {
      member_keys: JSON.stringify(persisted),
      member_count: currentByHash.size,
      pending: JSON.stringify(newPending),
      last_request_id: removeRes.requestId || addRes.requestId || null,
      last_synced_at: db.fn.now(),
      last_status: newPending.length ? 'pending' : 'synced',
    });

    return {
      ...summary,
      added: addRes.count,
      removed: removeRes.count,
      memberCount: currentByHash.size,
      pending: newPending.length,
      status: newPending.length ? 'pending' : 'synced',
    };
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
      lastStatus: (state && state.last_status) || null,
      pending: Array.isArray(state && state.pending) ? state.pending.length : 0,
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
    destination,
    toUserData,
    hashMember,
    canonicalEmail,
    customerId,
    loginCustomerId,
    listIdFor,
    uploadsAllowed,
    stateKey,
    getAccessToken,
    requestStatusOf,
    getRequestStatus,
    reconcilePending,
  },
};
