'use strict';

// A customer turning the app's "Email messages" switch ON releases THEIR OWN
// email unsubscribe (GATE_PORTAL_EMAIL_RESUBSCRIBE, owner 2026-11-04, gap #18).
// Before this, only staff could release an email_suppressions row
// (admin-email-templates.js POST /suppressions/:id/release).
//
// What counts as releasable (all must hold):
//   - active row covering the address (suppressionCoversEmail: exact + Gmail
//     mailbox equivalence), the same match the send path blocks on;
//   - suppression_type 'unsubscribe' only. Bounce, spam complaint and
//     do_not_email are facts about the address or a staff decision;
//   - group_key NULL (blocks every stream) or 'service_operational'.
//     'marketing_newsletter' is NOT released here: newsletter consent has its
//     own double opt-in flow;
//   - made by the customer, not by staff. Two tests, because `source` is
//     mutable (the SendGrid webhook overwrites an existing active row's source
//     with 'sendgrid_event_webhook' when the same event arrives later):
//       1. source is one of the three customer-origin sources that exist in
//          prod: 'sendgrid_event_webhook' (webhooks-sendgrid.js
//          recordEmailSuppressionForEvent), and 'sendgrid_asm_backfill' and
//          'sendgrid_dropped_backfill_2026_06_01'. The two backfill sources are
//          NOT in the repo: one-off June 2026 prod imports of SendGrid's own
//          unsubscribe lists (unsubscribes the customers made at SendGrid).
//          Prod on 2026-11-04: 5 active global webhook unsubscribes, 2 active
//          service_operational asm-backfill rows, 1 active service_operational
//          dropped-webhook row, 1 active service group_unsubscribe; no
//          admin_manual rows; no row carries metadata.created_by.
//       2. metadata has no 'created_by' key. The admin create route
//          (admin-email-templates.js POST /suppressions) always writes that
//          key (value may be null) and the webhook's metadata merge never
//          writes it, so it survives the source overwrite and marks staff rows.
//
// SendGrid keeps its own unsubscribe lists. Left alone, the next send is
// dropped by SendGrid and the webhook re-creates the local block. So the order
// is: clear SendGrid FIRST (clearSendgridBeforeRelease, before the route's
// transaction), then release locally only the rows whose SendGrid list was
// confirmed cleared. A failed clear leaves the rows active: the switch keeps
// reading OFF and the customer can simply try again.

const db = require('../models/db');
const logger = require('./logger');
const { suppressionCoversEmail } = require('../utils/email-equivalence');

const RELEASABLE_SOURCES = ['sendgrid_event_webhook', 'sendgrid_asm_backfill', 'sendgrid_dropped_backfill_2026_06_01'];
const SERVICE_GROUP_KEY = 'service_operational';
const RELEASE_CONSENT_SOURCE = 'portal_email_switch';
const SENDGRID_TIMEOUT_MS = 8000;

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// ACTIVE customer-made unsubscribes that block this address (see the header).
async function releasableUnsubscribes(email, { dbh = db } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  return dbh('email_suppressions')
    .where(suppressionCoversEmail(normalized))
    .where({ status: 'active', suppression_type: 'unsubscribe' })
    .whereIn('source', RELEASABLE_SOURCES)
    .whereRaw("(COALESCE(metadata, '{}'::jsonb) -> 'created_by') IS NULL")
    .where(function groupScope() {
      this.whereNull('group_key').orWhere('group_key', SERVICE_GROUP_KEY);
    })
    .orderBy('suppressed_at', 'asc');
}

// Read for the preference payload: never throws, so a read problem shows the
// stored value instead of failing the whole preferences screen.
async function hasReleasableUnsubscribe(email, { dbh = db } = {}) {
  try {
    return (await releasableUnsubscribes(email, { dbh })).length > 0;
  } catch (err) {
    logger.warn(`[email-resubscribe] releasable lookup failed: ${err.message}`);
    return false;
  }
}

// Runs on the caller's transaction, after clearSendgridBeforeRelease. Takes the
// shared per-address lock the SendGrid webhook writer takes, re-reads the
// releasable rows for the address as it stands under the lock, and releases
// only those whose id is in `onlyIds` (SendGrid confirmed that list cleared).
// `sendgridClear` maps row id -> { ok: true, status, at }, written in the same
// update. No onlyIds = nothing released.
async function releaseOwnUnsubscribes({ email, customerId, actor, contactSlot = null, onlyIds = [], sendgridClear = {} }, { dbh = db } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized || !onlyIds.length) return [];
  await require('../utils/customer-comms-lock').lockCustomerEmail(dbh, normalized);
  const allowed = new Set(onlyIds.map(String));
  const rows = (await releasableUnsubscribes(normalized, { dbh })).filter((row) => allowed.has(String(row.id)));
  const now = new Date();
  const released = [];
  for (const row of rows) {
    const metadata = {
      released_via: RELEASE_CONSENT_SOURCE,
      release_reason: 'Customer turned Email messages on in the app',
      released_by: null,
      released_for_customer_id: customerId == null ? null : String(customerId),
      actor,
      contact_slot: contactSlot,
      sendgrid_clear: sendgridClear[row.id] || null,
    };
    const [updated] = await dbh('email_suppressions')
      .where({ id: row.id, status: 'active' })
      .update({
        status: 'released',
        released_at: now,
        updated_at: now,
        consent_source: RELEASE_CONSENT_SOURCE,
        consent_timestamp: now,
        metadata: dbh.raw('COALESCE(metadata, \'{}\'::jsonb) || ?::jsonb', [JSON.stringify(metadata)]),
      })
      .returning('*');
    if (updated) released.push(updated);
  }
  return released;
}

async function sendgridDelete(path) {
  try {
    const res = await fetch(`https://api.sendgrid.com/v3${path}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
      signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
    });
    // 404 = the address was not on that list: already clear.
    if (res.ok || res.status === 404) return { ok: true, status: res.status };
    return { ok: false, status: res.status };
  } catch (err) {
    return { ok: false, reason: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || 'error').slice(0, 200) };
  }
}

// One DELETE per list the address's rows came from, in parallel so the worst
// case stays one timeout. A list that cannot be attempted is a failure.
async function clearAddressLists(email, { global, service }) {
  const encoded = encodeURIComponent(email);
  const serviceGroup = String(process.env.SENDGRID_ASM_GROUP_SERVICE || '').trim();
  const attempt = (wanted, path, missing) => {
    if (!wanted) return Promise.resolve(null);
    if (missing) return Promise.resolve({ ok: false, reason: missing });
    return sendgridDelete(path);
  };
  const noKey = process.env.SENDGRID_API_KEY ? null : 'no_api_key';
  const [globalResult, serviceResult] = await Promise.all([
    attempt(global, `/asm/suppressions/global/${encoded}`, noKey),
    attempt(service, `/asm/groups/${encodeURIComponent(serviceGroup)}/suppressions/${encoded}`,
      noKey || (serviceGroup ? null : 'service_group_not_configured')),
  ]);
  return { global: globalResult, service: serviceResult };
}

// Distinct stored addresses with the list(s) their rows came from.
function sendgridTargets(rows) {
  const byEmail = new Map();
  for (const row of rows) {
    const key = String(row.email || '').trim();
    if (!key) continue;
    const entry = byEmail.get(key) || { global: false, service: false };
    if (!row.group_key) entry.global = true;
    else if (row.group_key === SERVICE_GROUP_KEY) entry.service = true;
    byEmail.set(key, entry);
  }
  return byEmail;
}

// Call BEFORE the route's transaction. Reads the releasable rows (no lock) and
// clears SendGrid's list for each (global for a NULL-group row, the service ASM
// group for a service_operational row; the address exactly as stored). Never
// throws. `clearedIds` = rows whose list SendGrid confirmed cleared (2xx or
// 404); `clearById` = the note to stamp on each. Anything else (no key, no
// service group id, timeout, HTTP error) leaves its rows out and is logged.
async function clearSendgridBeforeRelease(email) {
  const result = { clearedIds: [], outcomes: [], clearById: {} };
  try {
    const rows = await releasableUnsubscribes(email);
    for (const [stored, lists] of sendgridTargets(rows)) {
      const results = await clearAddressLists(stored, lists);
      const at = new Date().toISOString();
      for (const [list, outcome] of Object.entries(results)) {
        if (!outcome) continue;
        result.outcomes.push({ list, ...outcome });
        if (!outcome.ok) logger.warn(`[email-resubscribe] SendGrid ${list} clear did not complete (${outcome.status || outcome.reason})`);
      }
      for (const row of rows.filter((r) => String(r.email || '').trim() === stored)) {
        const outcome = row.group_key ? results.service : results.global;
        if (outcome && outcome.ok) {
          result.clearedIds.push(row.id);
          result.clearById[row.id] = { ok: true, status: outcome.status, at };
        }
      }
    }
  } catch (err) {
    logger.warn(`[email-resubscribe] SendGrid pre-clear failed: ${err.message}`);
    return { clearedIds: [], outcomes: [], clearById: {} };
  }
  return result;
}

module.exports = {
  releasableUnsubscribes,
  hasReleasableUnsubscribe,
  releaseOwnUnsubscribes,
  clearSendgridBeforeRelease,
  normalizeEmail,
  RELEASABLE_SOURCES,
};
