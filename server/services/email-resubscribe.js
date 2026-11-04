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
//   - created by the customer. The only code path that inserts an
//     'unsubscribe' row for a customer action is the SendGrid event webhook
//     (webhooks-sendgrid.js recordEmailSuppressionForEvent, source
//     'sendgrid_event_webhook'). The admin create route defaults to
//     'admin_manual' and stays staff-owned.
//
// SendGrid keeps its own unsubscribe lists. Left alone, the next send is
// dropped by SendGrid and the webhook re-creates the local block, so the
// release also clears SendGrid (after the local transaction commits).

const db = require('../models/db');
const logger = require('./logger');
const { suppressionCoversEmail } = require('../utils/email-equivalence');

const RELEASABLE_SOURCES = ['sendgrid_event_webhook'];
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

// Runs on the caller's transaction. Takes the shared per-address lock the
// SendGrid webhook writer takes, so a block written right now is either seen
// here or lands after this release.
async function releaseOwnUnsubscribes({ email, customerId, actor, contactSlot = null }, { dbh = db } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return [];
  await require('../utils/customer-comms-lock').lockCustomerEmail(dbh, normalized);
  const rows = await releasableUnsubscribes(normalized, { dbh });
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
  const res = await fetch(`https://api.sendgrid.com/v3${path}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${process.env.SENDGRID_API_KEY}` },
    signal: AbortSignal.timeout(SENDGRID_TIMEOUT_MS),
  });
  // 404 = the address was not on that list: already clear.
  if (res.ok || res.status === 404) return { ok: true, status: res.status };
  return { ok: false, status: res.status };
}

// Distinct stored addresses with the list(s) their released rows came from.
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

async function clearAddress(email, { global, service }) {
  const encoded = encodeURIComponent(email);
  const serviceGroup = String(process.env.SENDGRID_ASM_GROUP_SERVICE || '').trim();
  const calls = [];
  if (global) calls.push(`/asm/suppressions/global/${encoded}`);
  if (service && serviceGroup) calls.push(`/asm/groups/${encodeURIComponent(serviceGroup)}/suppressions/${encoded}`);
  if (!calls.length) return { ok: false, reason: 'service_group_not_configured' };
  let outcome = null;
  for (const path of calls) {
    const result = await sendgridDelete(path);
    if (!outcome || !result.ok) outcome = result;
  }
  return outcome;
}

async function recordOutcome(rows, outcome) {
  const sendgridClear = JSON.stringify({ sendgrid_clear: { ...outcome, at: new Date().toISOString() } });
  await db('email_suppressions')
    .whereIn('id', rows.map((r) => r.id))
    .update({ metadata: db.raw('COALESCE(metadata, \'{}\'::jsonb) || ?::jsonb', [sendgridClear]) });
}

// Call AFTER the local transaction commits. Best effort: never throws and
// never fails the customer's save. Returns the per-address outcomes.
async function clearSendgridUnsubscribes(releasedRows) {
  const rows = Array.isArray(releasedRows) ? releasedRows : [];
  if (!rows.length) return [];
  const outcomes = [];
  try {
    const targets = sendgridTargets(rows);
    for (const [email, lists] of targets) {
      const forAddress = rows.filter((r) => String(r.email || '').trim() === email);
      let outcome;
      if (!process.env.SENDGRID_API_KEY) {
        outcome = { ok: false, reason: 'no_api_key' };
      } else {
        try {
          outcome = await clearAddress(email, lists);
        } catch (err) {
          outcome = { ok: false, reason: String(err?.name === 'TimeoutError' ? 'timeout' : err?.message || 'error').slice(0, 200) };
        }
      }
      if (!outcome.ok) logger.warn(`[email-resubscribe] SendGrid clear did not complete (${outcome.status || outcome.reason})`);
      outcomes.push({ ...outcome });
      await recordOutcome(forAddress, outcome).catch((err) => logger.warn(`[email-resubscribe] outcome note failed: ${err.message}`));
    }
  } catch (err) {
    logger.warn(`[email-resubscribe] SendGrid clear failed: ${err.message}`);
  }
  return outcomes;
}

module.exports = {
  releasableUnsubscribes,
  hasReleasableUnsubscribe,
  releaseOwnUnsubscribes,
  clearSendgridUnsubscribes,
  RELEASABLE_SOURCES,
};
