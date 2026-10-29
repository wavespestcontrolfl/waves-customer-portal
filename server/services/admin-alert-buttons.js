'use strict';

// Buttons on admin bell rows (docs/admin-notifications.md section 2, part 9; owner 2026-10-29 "ok go"). The
// server sets a row's buttons when it raises the row (composeAdminAlert `buttons`, kept as metadata.buttons);
// this module serves them to the bell and runs a tap. Each kind is a handler that repeats a step a page already
// offers, through the same server function, after reading its record again; it never trusts the row's words.
// Admin role only. One tap runs at a time on a row; each tap is recorded on it, and a successful one closes it.

const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { buttonViolations } = require('./admin-alert-compose');

// kind -> its handler { live() -> boolean, run({ row, item, technicianId }) }. A run answers
// { ok: true, message, resolution } or { ok: false, code, message, close? }, where `close` is the resolution
// for a row whose record was already answered elsewhere. Required at call time: serving the bell list loads no
// emitter. A kind whose step texts or emails a customer, moves money or flips a gate needs the owner's ruling
// for that kind first (section 2, part 9).
const KINDS = {
  // Owner 2026-10-29 "ok go": Confirm is offered only when the tap sends nothing and moves no money.
  referral_inbound: () => require('./referral-inbound-bell').buttonHandler,
};

function parseMetadata(value) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value || '{}') || {}; } catch { return {}; }
}

// The row's own buttons, or null when it has none this server knows how to run.
function storedButtons(row) {
  const { buttons } = parseMetadata(row?.metadata);
  if (!buttons || buttonViolations(buttons).length || !Object.hasOwn(KINDS, buttons.kind)) return null;
  return buttons;
}

function kindLive(kind) {
  try {
    return KINDS[kind]().live() === true;
  } catch (err) {
    logger.warn(`[alert-buttons] ${kind} gate read failed: ${err.message}`);
    return false;
  }
}

// The bell list with each open row's `actions` ({ id, label, prompt? }) added: for the admin role only, never on
// a `live:` overlay row, and only while the row's kind is on. A tap sends back only the action id.
function withAlertButtons(rows, { role } = {}) {
  if (role !== 'admin' || !Array.isArray(rows)) return rows;
  const live = new Map();
  return rows.map((row) => {
    if (row?.done_at != null || String(row?.id || '').startsWith('live:')) return row;
    const buttons = storedButtons(row);
    if (!buttons) return row;
    if (!live.has(buttons.kind)) live.set(buttons.kind, kindLive(buttons.kind));
    if (!live.get(buttons.kind)) return row;
    return { ...row, actions: buttons.items.map(({ id, label, prompt }) => ({ id, label, ...(prompt ? { prompt } : {}) })) };
  });
}

// A tap that crashed before it finished leaves a claim; after this long another tap may take the row.
const CLAIM_TTL_SECONDS = 120;

// Claim the row for one tap, in one conditional write: only while the row is open, still the version the bell
// served, and not claimed by another tap. Of two taps at once, one runs and the other answers 409. Returns
// true when this tap holds the row.
async function claimTap(id, version, { by, action }) {
  const claimed = await db('notifications').where({ id, recipient_type: 'admin' }).whereNull('done_at')
    .whereRaw(`${NotificationService._private.NOTIFICATION_VERSION_SQL} = ?`, [version])
    .whereRaw("(metadata->'buttonClaim' IS NULL OR (metadata->'buttonClaim'->>'at')::timestamptz < now() - (? * interval '1 second'))", [CLAIM_TTL_SECONDS])
    .update({
      metadata: db.raw("COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('buttonClaim', jsonb_build_object('by', ?::text, 'action', ?::text, 'at', now()))", [by, action]),
    });
  return Number(claimed) > 0;
}

// The tap's record, appended to the row's `buttonTaps` (a later tap never erases an earlier one), and the claim
// released. Best effort: the step already ran.
async function finishTap(id, tap) {
  try {
    await db('notifications').where({ id, recipient_type: 'admin' }).update({
      metadata: db.raw("(COALESCE(metadata, '{}'::jsonb) - 'buttonClaim') || jsonb_build_object('buttonTaps', COALESCE(metadata->'buttonTaps', '[]'::jsonb) || jsonb_build_array(?::jsonb))", [JSON.stringify(tap)]),
    });
  } catch (err) {
    logger.warn(`[alert-buttons] tap not recorded on ${id}: ${err.message}`);
  }
}

// Why a claim was lost: the row closed meanwhile, another tap holds it, or its content changed.
async function lostClaim(id) {
  const row = await db('notifications').where({ id, recipient_type: 'admin' }).first('done_at', 'metadata');
  if (!row || row.done_at != null) return reply(409, { error: 'done', message: 'That alert was already handled.' });
  if (parseMetadata(row.metadata).buttonClaim) return reply(409, { error: 'busy', message: 'Someone is already acting on this alert.' });
  return reply(409, { error: 'changed' });
}

const reply = (status, body) => ({ status, body });

/**
 * One tap: `version` is the content version the bell served for the row (the Done fence), so a button runs only
 * on the row the admin saw. Returns { status, body } for the route: 200 { success, message } when the step ran
 * (the row is then done), 409 { error, message? } when the row changed, was handled, or the step refused.
 */
async function runAlertButton({ notificationId, actionId, version, technicianId, role }) {
  if (role !== 'admin' || !technicianId) return reply(403, { error: 'Admin access required' });
  const row = await db('notifications').where({ id: notificationId, recipient_type: 'admin' })
    .first('id', 'done_at', 'metadata', db.raw(`${NotificationService._private.NOTIFICATION_VERSION_SQL} AS version`));
  if (!row) return reply(404, { error: 'not_found' });
  // A second tap, or a row closed meanwhile: nothing runs again.
  if (row.done_at != null) return reply(409, { error: 'done', message: 'That alert was already handled.' });
  if (row.version !== version) return reply(409, { error: 'changed' });
  const buttons = storedButtons(row);
  const item = buttons?.items.find((button) => button.id === actionId);
  if (!item) return reply(400, { error: 'unknown_action' });
  if (!kindLive(buttons.kind)) return reply(409, { error: 'off', message: 'These buttons are turned off. Open the alert to act on it.' });

  const by = String(technicianId);
  if (!(await claimTap(notificationId, version, { by, action: item.id }))) return lostClaim(notificationId);
  const tap = { action: item.id, by, at: new Date().toISOString() };
  let result;
  try {
    result = await KINDS[buttons.kind]().run({ row, item, technicianId });
  } catch (err) {
    await finishTap(notificationId, { ...tap, outcome: 'error' });
    throw err;
  }
  await finishTap(notificationId, { ...tap, outcome: result.ok ? 'done' : result.code });
  if (result.ok) {
    // The step's own close may have marked the row done first; this keeps that close (markAdminDone writes only
    // an open row).
    await NotificationService.markAdminDone([notificationId], { by, resolution: result.resolution, role });
    return reply(200, { success: true, message: result.message });
  }
  if (result.close) await NotificationService.markAdminDone([notificationId], { by: 'alert-button', resolution: result.close });
  return reply(409, { error: result.code, message: result.message });
}

module.exports = { withAlertButtons, runAlertButton, _private: { KINDS, storedButtons } };
