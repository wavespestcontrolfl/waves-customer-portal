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
const { collectCustomerMembers, collectUnbookedLeadMembers, staleLeadOptOutKeys } = require('./meta-audiences')._private;
const { sha256Hex, normalizePhone, cleanNumericId } = require('./data-manager')._private;
const matchFields = require('./ad-match-fields');

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
    staleOptOutKeys: staleLeadOptOutKeys,
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
  if (typeof raw !== 'string') return (raw && typeof raw === 'object') ? raw : null;
  // Mirror data-manager.credentialsJson: tolerate the env value the conversion uploader
  // accepts (sometimes stored without its trailing brace) so GCM doesn't silently no-op.
  let jsonStr = raw.trim();
  if (jsonStr.startsWith('{') && !jsonStr.endsWith('}')) jsonStr += '\n}';
  try { return JSON.parse(jsonStr); } catch { return null; }
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
// Email: lowercase + trim; gmail/googlemail also drop dots and strip a '+tag'
// from the local part per Google's formatting guide. The canonicalizer is
// SHARED with the consent module (ad-audience-consent.canonicalEmail) so a
// suppression match and the uploaded hash can never diverge on a dot-variant.
const { canonicalEmail, loadMarketingSuppression } = require('./ad-audience-consent');

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

// Google AddressInfo needs hashed first + last name, regionCode and a 5-digit
// ZIP together; null unless both names and a ZIP are known (shared formatter in
// ad-match-fields, also used by the conversion lane).
function addressFor(member) {
  return matchFields.googleAddressParts(member, sha256Hex);
}
// A row stores its address as this signature (name hashes, region, ZIP; no
// plaintext name), and every request rebuilds the address from it, so the
// ingest and the later removal of a row carry the same address.
const addressSig = (addr) => (addr ? [addr.givenName, addr.familyName, addr.regionCode, addr.postalCode].join('|') : '');
function addressFromSig(sig) {
  const [givenName, familyName, regionCode, postalCode] = String(sig || '').split('|');
  return givenName && familyName && regionCode && postalCode ? { givenName, familyName, regionCode, postalCode } : null;
}

// A stored row [emailSha256, phoneSha256] + its address signature -> Data
// Manager UserData. Ingest and remove send the same keys; a row stored before
// addresses were added (no signature) is removed by email/phone only.
function toUserData(d, a = '') {
  const userIdentifiers = [];
  if (d[0]) userIdentifiers.push({ emailAddress: d[0] });
  if (d[1]) userIdentifiers.push({ phoneNumber: d[1] });
  const address = addressFromSig(a);
  if (address) userIdentifiers.push({ address });
  return { userIdentifiers };
}

// The fields a row keeps in state and in a pending op: entity key, hash row,
// address signature.
const storedRow = ({ k, d, a }) => ({ k, d, ...(a ? { a } : {}) });
// Every key a request for a row carries. A remove matches by any of them.
const idsOf = (e) => [e.d[0], e.d[1], e.a ? `a:${e.a}` : ''].filter(Boolean);
const sharesAny = (e, ids) => idsOf(e).some((id) => ids.has(id));

function batchSize() {
  const n = Number(process.env.GOOGLE_CM_MAX_MEMBERS_PER_CALL);
  return n > 0 && n <= MAX_MEMBERS_PER_CALL ? n : MAX_MEMBERS_PER_CALL;
}

// POST stored rows ({k,d,a}) to ingest/remove in batches. Returns { count, batches }
// where each batch is { requestId, members } — one per Data Manager request, so the
// caller persists a pending entry PER batch (a later batch's success can't mask an
// earlier batch's failure). termsOfService is valid only on :ingest (the :remove
// schema rejects it), so we omit it there.
async function pushMembers(listId, entries, op, { fetchImpl = global.fetch, token } = {}) {
  const url = op === 'remove' ? REMOVE_URL : INGEST_URL;
  const dest = destination(listId);
  const accessToken = token || await getAccessToken();
  const size = batchSize();
  let count = 0;
  const batches = [];
  for (let i = 0; i < entries.length; i += size) {
    const batch = entries.slice(i, i + size);
    const body = {
      destinations: [dest],
      audienceMembers: batch.map((e) => ({ userData: toUserData(e.d, e.a) })),
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
    count += batch.length;
    batches.push({ requestId: (json && json.requestId) || null, members: batch.map(storedRow) });
  }
  return { count, batches };
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
 * Returns the EFFECTIVE member set (a failed op's rows kept: an ingest's flagged
 * to re-send, a remove's to remove again) plus the pending ops still processing. Polls are read-only; a transient poll error
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
    // FAILED / PARTIAL / aged-out: the op did not durably apply; the delta re-sends it.
    if (p.op === 'ingest') {
      // Google may still hold part of it (PARTIAL, aged out), and an enrichment's
      // row was in the list before it. So each row stays in state with the keys
      // it sent, flagged (r) to re-send while it is current and to be removed
      // with those keys once it is not.
      const failed = new Map(asEntries(p.members).map((e) => [hashId(e.d), e]));
      effective = effective.map((e) => (failed.has(hashId(e.d)) ? { ...storedRow(e), r: 1 } : e));
      const have = new Set(effective.map((e) => hashId(e.d)));
      for (const [h, e] of failed) if (!have.has(h)) effective.push({ ...storedRow(e), r: 1 });
    } else { // remove did not durably apply -> the members are still in Google; keep them
      const have = new Set(effective.map((e) => hashId(e.d)));
      for (const e of asEntries(p.members)) {
        if (!have.has(hashId(e.d))) { effective.push(e); have.add(hashId(e.d)); }
      }
    }
  }
  return { effective, stillPending };
}

// What each current member sends this run and keeps in state. A row's address,
// once sent, stays its address: an edit is not re-sent, so a removal always
// carries every address Google may hold for the row. A member is sent when it
// is new, when it was stored before addresses were added and now has one (once:
// an enrichment), or when its last ingest did not apply (r: re-sent with the
// keys it stored). A send that shares a key with a remove still in flight is
// held for a later run; a held row keeps its stored entry.
function planAdds(currentByHash, priorByHash, hasPendingRemove) {
  const out = { addEntries: [], heldAdds: 0, enrichCount: 0, keep: new Map() };
  for (const [h, e] of currentByHash) {
    const prior = priorByHash.get(h);
    const row = storedRow({ k: e.k, d: e.d, a: (prior && prior.a) || e.a });
    const enrich = !!prior && !prior.r && !prior.a && !!e.a;
    if (prior && !prior.r && !enrich) { out.keep.set(h, row); continue; }
    if (hasPendingRemove(row)) {
      if (prior) out.keep.set(h, prior); else out.heldAdds += 1;
      continue;
    }
    out.addEntries.push(row);
    out.keep.set(h, row);
    if (enrich) out.enrichCount += 1;
  }
  return out;
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
    // ONE suppression snapshot for both collection filtering and the removal
    // calculation below — separate loads could disagree about an opt-out
    // landing between them (see meta-audiences for the same contract).
    const suppression = await loadMarketingSuppression();
    const collected = await def.collect({ partition: true, suppression });
    const members = collected.kept;
    // Member keys whose uploaded rows leave whatever they share with a current
    // member: dropped test records, and leads opted out through a linked customer
    // (current leads here, stored ones once the state loads: staleOptOutKeys).
    const testKeys = new Set(collected.testKeys);
    const leavingKeys = new Set([...testKeys, ...(collected.optOutKeys || [])]);

    // Keep only members with usable match keys; store the hash row so removals survive
    // a hard-deleted source row and a corrected identifier re-uploads later.
    const current = [];
    let skippedNoKeys = 0;
    for (const m of members) {
      const d = hashMember(m);
      if (!d) { skippedNoKeys++; continue; }
      current.push(storedRow({ k: m.key, d, a: addressSig(addressFor(m)) }));
    }

    // Diff by HASH ROW (Google matches/removes users by the hashed identifiers).
    const currentByHash = new Map();
    for (const e of current) if (!currentByHash.has(hashId(e.d))) currentByHash.set(hashId(e.d), e);

    const state = await loadState(audienceKey);
    // Scope state to the destination: if the configured Customer Match list / customer
    // id changed since the last sync, the prior member_keys belong to a DIFFERENT (now
    // empty) list — ignore them so the new list gets a full re-upload, not just deltas.
    const destSig = `${customerId() || ''}:${listId}`;
    const destChanged = !!(state && state.destination_sig && state.destination_sig !== destSig);
    if (destChanged) {
      logger.warn('[google-customer-match] destination changed, resetting sync state', { audienceKey, from: state.destination_sig, to: destSig });
    }
    const priorMembers = destChanged ? [] : asEntries(state && state.member_keys);
    const priorPending = destChanged ? null : (state && state.pending);

    // On a dry run we don't poll/persist — report the delta against the stored
    // optimistic state. The live path reconciles first (below).
    let effectivePrior = priorMembers;
    let stillPending = [];
    let token = null;
    if (!dryRun) {
      token = await getAccessToken();
      const rec = await reconcilePending({
        members: priorMembers,
        pending: priorPending,
        token,
        nowMs: Date.now(),
      });
      effectivePrior = rec.effective;
      stillPending = rec.stillPending;
    }

    if (def.staleOptOutKeys) for (const k of await def.staleOptOutKeys(effectivePrior, members, suppression)) leavingKeys.add(k);

    // Identifier hashes of active marketing opt-outs (and wrong_number phones),
    // hashed exactly like uploaded members (canonical email; phone WITH '+').
    // A prior row carrying one of these must be removed even when it shares its
    // OTHER identifier with a current member — shared-identifier retention must
    // not keep an opted-out email matchable forever via a household phone.
    const suppressedIdHashes = new Set();
    for (const raw of suppression.rawOptOutEmails) {
      const email = canonicalEmail(raw);
      if (email) suppressedIdHashes.add(sha256Hex(email));
    }
    for (const raw of suppression.rawOptOutPhones) {
      const phone = normalizePhone(raw);
      if (phone) suppressedIdHashes.add(sha256Hex(phone));
    }
    const hasSuppressedId = (d) => !!((d[0] && suppressedIdHashes.has(d[0])) || (d[1] && suppressedIdHashes.has(d[1])));

    // A leaving row goes whatever it shares with a current member: a row under a
    // leaving key, or a stored row (not current) that carries an opted-out
    // identifier. It is kept out of planAdds, so a current member with the same
    // email and phone is sent with its own address, never handed the leaving row's.
    const isLeaving = (e) => leavingKeys.has(e.k) || (!currentByHash.has(hashId(e.d)) && hasSuppressedId(e.d));
    const leaving = effectivePrior.filter(isLeaving);
    const priorByHash = new Map();
    for (const e of effectivePrior) if (!isLeaving(e) && !priorByHash.has(hashId(e.d))) priorByHash.set(hashId(e.d), e);

    // Data Manager applies ingest/remove ASYNChronously and possibly out of order, and
    // matches/removes by ANY identifier — so we hold a conflicting op while one is still
    // in flight, keyed on INDIVIDUAL identifiers (email, phone, address: idsOf), NOT the
    // exact [email,phone] row (the same person can reappear with a changed identifier and
    // a different row hash, yet a pending remove would still match them by the shared one).
    const pendingIngestIds = new Set();
    const pendingRemoveIds = new Set();
    for (const p of stillPending) {
      const target = p.op === 'ingest' ? pendingIngestIds : pendingRemoveIds;
      for (const e of asEntries(p.members)) for (const id of idsOf(e)) target.add(id);
    }

    const removeEntries = []; // members we remove this run
    const retained = [];      // can't remove: still shares an identifier with a current member
    const heldRemoves = [];   // can't remove yet: an ingest for an identifier is in flight
    const removedSuppressedIds = new Set(); // ALL identifiers on force-removed rows
    let consentRemovals = 0;
    let testRemovals = 0;
    // Consent removal, and removal of a leaving row, override shared-identifier
    // retention. Still deferred while an ingest for one of its identifiers is in
    // flight (out-of-order apply could make the remove a no-op): heldRemoves retries
    // next run.
    const forceRemove = (e) => {
      if (sharesAny(e, pendingIngestIds)) { heldRemoves.push(e); return; }
      removeEntries.push(e);
      if (testKeys.has(e.k)) testRemovals += 1; else consentRemovals += 1;
      for (const id of idsOf(e)) removedSuppressedIds.add(id);
    };
    leaving.forEach(forceRemove);

    // heldAdds: new members deferred, because a remove for one of their identifiers
    // is in flight or is sent this run (Google may apply this run's ingest before its
    // remove, and a member left out of state would then never be removed). A held
    // enrichment or re-send keeps its stored entry in `keep`, so it retries next run.
    const {
      addEntries, heldAdds, enrichCount, keep,
    } = planAdds(currentByHash, priorByHash, (e) => sharesAny(e, pendingRemoveIds) || sharesAny(e, removedSuppressedIds));

    // Never remove a row whose email, phone or address is still held by a current member
    // (a remove matches by any identifier, so it would drop a person we keep) — retain +
    // retry. A current member holds its email and phone, and the address stored for it
    // or sent this run (an edit that was never sent is not on Google).
    const currentIds = new Set();
    for (const e of currentByHash.values()) for (const id of e.d.filter(Boolean)) currentIds.add(id);
    for (const e of keep.values()) for (const id of idsOf(e)) currentIds.add(id);

    for (const [h, e] of priorByHash) {
      if (currentByHash.has(h)) continue;
      if (sharesAny(e, currentIds)) retained.push(e);
      else if (sharesAny(e, pendingIngestIds)) heldRemoves.push(e);
      else removeEntries.push(e);
    }
    // Optimistic state: current members EXCEPT held adds (so they re-add once the remove
    // settles), plus retained orphans, plus held removes (kept so they remove next run).
    // Current members sharing an identifier with a force-removed row are also
    // dropped from state (and not sent this run: held above): the remove matches by
    // ANY identifier and may knock them out;
    // absent from state they re-add next run, and the pending-remove hold keeps that
    // re-add until the remove settles — guaranteed removal, one-cycle flicker for the
    // housemate.
    let deferredReAdds = 0;
    const persisted = [];
    for (const row of keep.values()) {
      if (sharesAny(row, removedSuppressedIds)) {
        deferredReAdds += 1;
        continue;
      }
      persisted.push(row);
    }
    persisted.push(...retained, ...heldRemoves);

    const summary = {
      audienceKey,
      configured: true,
      dryRun,
      name: def.name,
      listId,
      eligible: members.length,
      withMatchKeys: currentByHash.size,
      skippedNoKeys,
      toAdd: addEntries.length - enrichCount,
      toEnrich: enrichCount,
      toRemove: removeEntries.length,
      retained: retained.length,
      heldAdds,
      heldRemoves: heldRemoves.length,
      consentRemovals,
      testRemovals,
      deferredReAdds,
    };

    if (dryRun) {
      return { ...summary, note: 'Dry run — set GOOGLE_CUSTOMER_MATCH_ALLOW_UPLOADS=true to apply.' };
    }

    const addRes = addEntries.length
      ? await pushMembers(listId, addEntries, 'ingest', { token })
      : { count: 0, batches: [] };
    const removeRes = removeEntries.length
      ? await pushMembers(listId, removeEntries, 'remove', { token })
      : { count: 0, batches: [] };

    // Carry forward still-processing ops + one entry PER submitted batch (so a single
    // failed batch is reconciled independently). They stay OPTIMISTICALLY in member_keys;
    // next run's reconcile reverts any batch Google reports failed.
    const nowIso = new Date().toISOString();
    const newPending = [...stillPending];
    for (const b of addRes.batches) if (b.requestId) newPending.push({ requestId: b.requestId, op: 'ingest', at: nowIso, members: b.members });
    for (const b of removeRes.batches) if (b.requestId) newPending.push({ requestId: b.requestId, op: 'remove', at: nowIso, members: b.members });
    const lastBatchId = (arr) => (arr.length && arr[arr.length - 1].requestId) || null;

    await saveState(audienceKey, {
      member_keys: JSON.stringify(persisted),
      member_count: currentByHash.size,
      pending: JSON.stringify(newPending),
      last_request_id: lastBatchId(removeRes.batches) || lastBatchId(addRes.batches) || null,
      destination_sig: destSig,
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
    addressFor,
    addressSig,
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
