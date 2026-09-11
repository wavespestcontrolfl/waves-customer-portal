'use strict';

const { gateEnvValue, isEnabled } = require('../config/feature-gates');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');
const { getBlackoutLayers } = require('./scheduling/blackout-dates');
const { recordAuditEvent } = require('./audit-log');
const logger = require('./logger');

const enabled = () => gateEnvValue('GATE_CALLBACK_CARD') && isEnabled('callCommitments');
const error = (message, status = 409) => Object.assign(new Error(message), { status });

// Booking hours and the shared blackout calendar are the office calendar.
// A failed calendar read leaves an undated card visible for staff review.
async function loadCalendar(conn, from) {
  const config = await conn('booking_config').first('day_start', 'day_end');
  const start = String(config?.day_start || '08:00').slice(0, 5);
  const end = String(config?.day_end || '17:00').slice(0, 5);
  if (!/^\d{2}:\d{2}$/.test(start) || !/^\d{2}:\d{2}$/.test(end) || start >= end) {
    throw error('Office hours need review');
  }
  const last = etDateString(addETDays(from, 60));
  const { dates } = await getBlackoutLayers(etDateString(from), last, conn);
  return { start, end, closed: dates };
}

function staffedDeadline(from, calendar, minutes = 240) {
  let remaining = minutes * 60000;
  for (let day = 0; day <= 60; day += 1) {
    const date = etDateString(addETDays(from, day));
    if (calendar.closed.has(date)) continue;
    const opens = parseETDateTime(`${date}T${calendar.start}`).getTime();
    const closes = parseETDateTime(`${date}T${calendar.end}`).getTime();
    const cursor = Math.max(opens, from.getTime());
    if (!Number.isFinite(cursor) || !Number.isFinite(closes)) throw error('Office hours need review');
    if (closes <= cursor) continue;
    if (remaining <= closes - cursor) return new Date(cursor + remaining);
    remaining -= closes - cursor;
  }
  throw error('No working day found for this callback');
}

// A read prepares the callbacks it is about to return: a customer, lead or
// call scope prepares every undated callback in that scope, so a filtered
// queue never waits behind an unrelated backlog. An unscoped read walks the
// backlog oldest-first in batches.
async function prepareCallbackCards(conn, { callId = null, customerId = null, leadId = null, leadSid = null } = {}) {
  if (!enabled()) return 0;
  const { staleAiRowSql, callEndedAt, scopeCommitmentRows } = require('./call-commitments');
  const scoped = !!(callId || customerId || leadId);
  const rows = await conn('call_commitments as cc').join('call_log as cl', 'cl.id', 'cc.call_log_id')
    .where({ 'cc.kind': 'callback', 'cc.party': 'waves', 'cc.status': 'open' })
    .whereNull('cc.callback_due_at').whereRaw(`NOT ${staleAiRowSql('cc')}`)
    .modify((q) => { if (callId) q.where('cc.call_log_id', callId); scopeCommitmentRows(q, { customerId, leadId, leadSid }); })
    .orderBy('cc.created_at', 'asc').modify((q) => { if (!scoped) q.limit(200); })
    .select('cc.id', 'cc.source', 'cc.created_at', 'cc.updated_at', 'cc.due_at', 'cc.assigned_to', 'cl.created_at as call_started_at',
      'cl.bridged_at', 'cl.duration_seconds', 'cl.direction');
  if (!rows.length) return 0;
  const owner = await conn('technicians').where('employment_status', 'active')
    .whereIn('role', ['admin', 'technician']).orderBy('field_dispatchable', 'asc')
    .orderBy('created_at', 'asc').orderBy('id', 'asc').first('id');
  let prepared = 0;
  const calendars = new Map();
  for (const row of rows) {
    const from = row.source === 'human' ? new Date(row.created_at) : callEndedAt({ ...row, created_at: row.call_started_at });
    let due;
    try {
      const day = etDateString(from);
      if (!calendars.has(day)) calendars.set(day, await conn.transaction((sp) => loadCalendar(sp, from)));
      // Keep the fallback independent: re-extraction may withdraw a stated date.
      due = staffedDeadline(from, calendars.get(day));
    } catch (err) {
      logger.warn(`[callback-cards] deadline unavailable for ${row.id}: ${err.code || err.name || 'error'}`);
      continue; // The feed still shows this promise, with an undated warning.
    }
    prepared += await conn.transaction(async (trx) => {
      if (!enabled()) return 0;
      const changed = await trx('call_commitments').where({ id: row.id, status: 'open' })
        .whereNull('callback_due_at')
        .whereRaw("date_trunc('milliseconds', updated_at) = ?", [row.updated_at])
        .update({ callback_due_at: due,
          assigned_to: trx.raw('COALESCE(assigned_to, ?::uuid)', [owner?.id || null]), updated_at: new Date() });
      if (changed) await recordAuditEvent({ actor_type: 'system', action: 'callback_card_created',
        resource_type: 'call_commitment', resource_id: row.id,
        metadata: { due_at: new Date(row.due_at || due).toISOString(), assigned_to: row.assigned_to || owner?.id || null }, critical: true, trx });
      return changed;
    });
  }
  return prepared;
}

// The canonical commitments feed carries callback ownership: who holds the
// card and whether that account is still active. Gate off leaves the rows
// as the existing feed already returns them.
async function decorateCallbackRows(conn, rows) {
  if (!enabled()) return rows;
  const isCard = (r) => r.kind === 'callback' && r.party === 'waves';
  const ids = [...new Set(rows.filter(isCard).map((r) => r.assigned_to).filter(Boolean))];
  const staff = ids.length ? await conn('technicians').whereIn('id', ids).select('id', 'name', 'employment_status') : [];
  return rows.map((row) => {
    if (!isCard(row)) return row;
    const owner = staff.find((s) => s.id === row.assigned_to);
    return { ...row, owner_name: owner?.name || null, owner_active: owner?.employment_status === 'active' };
  });
}

// The edit action's ledger write. Returns the callback_edit event metadata
// (restated, and legacy_boundary for the first unchanged save on a card
// edited before callback cards existed — see callbackEditEventMetadata).
async function applyEdit(trx, row, { actorId, description, due_at, note, patch }) {
  const ledger = require('./call-commitments');
  patch.snoozed_until = null;
  const event = await ledger.callbackEditEventMetadata(trx, row, { description, due_at });
  if (event.restated) {
    const changed = await ledger.applyHumanUpdate(trx, row.id, { action: 'edit', reviewedBy: actorId, description, due_at, note, renewalAudit: false });
    if (due_at !== undefined && changed.due_at == null) patch.callback_due_at = null;
    return event;
  }
  if (note !== undefined) patch.human_note = note ? String(note).slice(0, 2000) : null;
  // Saving an unreviewed AI callback unchanged is still the office vouching
  // for it (the same review a claim records).
  if (row.human_state == null) await ledger.applyHumanUpdate(trx, row.id, { action: 'confirm', reviewedBy: actorId, renewalAudit: false });
  return event;
}

async function actOnCallback(conn, id, { action, actorId, expectedAt, snooze, description, due_at, note, now = new Date() } = {}) {
  if (!enabled()) throw error('Callback cards are disabled');
  if (!['claim', 'release', 'snooze', 'fulfill', 'dismiss', 'reopen', 'confirm', 'edit'].includes(action)) throw error('Unknown callback action', 400);
  if (!expectedAt || !Number.isFinite(new Date(expectedAt).getTime())) throw error('Refresh this callback before changing it', 400);
  let until = null;
  if (action === 'snooze') {
    if (snooze === 'two_hours') until = new Date(now.getTime() + 2 * 3600000);
    else if (snooze === 'tomorrow') {
      const tomorrow = parseETDateTime(`${etDateString(addETDays(now, 1))}T09:00`);
      until = staffedDeadline(tomorrow, await loadCalendar(conn, tomorrow), 0);
    } else throw error('Choose two hours or the next working morning', 400);
  }
  return conn.transaction(async (trx) => {
    if (!enabled()) throw error('Callback cards are disabled');
    // Extraction takes the source-call lock before writing commitments.
    // Use that order so a newer pass cannot withdraw this promise mid-action.
    const source = await trx('call_log as cl').join('call_commitments as cc', 'cc.call_log_id', 'cl.id')
      .where({ 'cc.id': id, 'cc.kind': 'callback', 'cc.party': 'waves' }).forUpdate('cl').first('cl.id');
    if (!source) throw error('Callback not found', 404);
    const row = await trx('call_commitments as cc').where({ 'cc.id': id })
      .whereRaw(`NOT ${require('./call-commitments').staleAiRowSql('cc')}`).forUpdate('cc').first('cc.*');
    if (!row) throw error('This callback changed. Refresh to see the latest action.');
    if ((row.status !== 'open' && !['reopen', 'edit'].includes(action)) || new Date(row.updated_at).getTime() !== new Date(expectedAt).getTime()) {
      throw error('This callback changed. Refresh to see the latest action.');
    }
    const staff = await trx('technicians').where({ id: actorId, employment_status: 'active' }).first('id');
    if (!staff) throw error('Active staff account required', 403);
    // Acting takes ownership in the same version-bound write. No separate
    // Claim tap is needed; simultaneous actions cannot both match.
    const patch = { updated_at: now, assigned_to: actorId };
    if (action === 'claim') patch.assigned_to = actorId;
    if (action === 'release') patch.assigned_to = null;
    if (action === 'snooze') patch.snoozed_until = until;
    // Claiming, releasing or snoozing an AI callback is the office vouching
    // for it: record the review through the ledger's own confirm action so
    // a later extraction that omits the callback cannot withdraw work staff
    // already took on (staleAiRowSql keeps human-reviewed rows live).
    if (['claim', 'release', 'snooze'].includes(action) && row.human_state == null) {
      await require('./call-commitments').applyHumanUpdate(trx, id, { action: 'confirm', reviewedBy: actorId });
    }
    // A Save that restates nothing is not a new promise. The editor submits
    // description and due_at on every save, so the submitted obligation is
    // compared with the locked row before the edit boundary fulfillment
    // refresh honours is advanced: a return call that landed while the
    // panel was open must still close the callback. An unchanged save
    // still takes ownership, clears the snooze and keeps a note, but leaves
    // reviewed_at alone — for a card edited before callback cards existed
    // that is the only edit boundary on record.
    const editEvent = action === 'edit' ? await applyEdit(trx, row, { actorId, description, due_at, note, patch }) : {};
    if (['fulfill', 'dismiss', 'reopen', 'confirm'].includes(action)) {
      await require('./call-commitments').applyHumanUpdate(trx, id, { action, reviewedBy: actorId, note, renewalAudit: false });
      patch.snoozed_until = null;
    }
    await trx('call_commitments').where({ id }).update(patch);
    await prepareCallbackCards(trx, { callId: row.call_log_id });
    await recordAuditEvent({ actor_type: 'technician', actor_id: actorId, action: `callback_${action}`,
      resource_type: 'call_commitment', resource_id: id,
      // renewed_at: the boundary fulfillment refresh honours for a reopen or
      // edit, stamped here after the row lock and the writes — the audit
      // row's own created_at is the transaction start, which a call returned
      // during a lock wait would post-date.
      metadata: { snoozed_until: until?.toISOString() || null, ...editEvent,
        ...(['edit', 'reopen'].includes(action) ? { renewed_at: new Date().toISOString() } : {}) }, critical: true, trx });
    // Every action retires the reminder for the version staff just acted
    // on. The reminder identity is versioned by owner, deadline, snooze and
    // review (call-commitments-watchdog), so a callback left open re-arms
    // the same bell unread at its next due sweep.
    await trx('notifications').where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'commitment_id' = ?", [id])
      .whereNull('read_at').update({ read_at: now });
    return require('./call-commitments').normalizeRow(await trx('call_commitments').where({ id }).first());
  });
}

module.exports = { enabled, loadCalendar, staffedDeadline, prepareCallbackCards, decorateCallbackRows, actOnCallback };
