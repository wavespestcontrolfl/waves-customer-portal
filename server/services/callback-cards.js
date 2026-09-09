'use strict';

const { gateEnvValue, isEnabled } = require('../config/feature-gates');
const { parseETDateTime, etDateString, addETDays } = require('../utils/datetime-et');
const { getBlackoutLayers } = require('./scheduling/blackout-dates');
const { recordAuditEvent } = require('./audit-log');
const logger = require('./logger');
const { isInternalTestCustomerId } = require('./internal-test-customers');

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

async function prepareCallbackCards(conn, { callId = null } = {}) {
  if (!enabled()) return 0;
  const { staleAiRowSql, callEndedAt } = require('./call-commitments');
  const rows = await conn('call_commitments as cc').join('call_log as cl', 'cl.id', 'cc.call_log_id')
    .where({ 'cc.kind': 'callback', 'cc.party': 'waves', 'cc.status': 'open' })
    .whereNull('cc.callback_due_at').whereRaw(`NOT ${staleAiRowSql('cc')}`)
    .modify((q) => { if (callId) q.where('cc.call_log_id', callId); })
    .orderBy('cc.created_at', 'asc').limit(200)
    .select('cc.id', 'cc.source', 'cc.created_at', 'cc.due_at', 'cc.assigned_to', 'cl.created_at as call_started_at',
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
      if (!row.due_at && !calendars.has(day)) calendars.set(day, await loadCalendar(conn, from));
      due = row.due_at ? new Date(row.due_at) : staffedDeadline(from, calendars.get(day));
    } catch (err) {
      logger.warn(`[callback-cards] deadline unavailable for ${row.id}: ${err.code || err.name || 'error'}`);
      continue; // The feed still shows this promise, with an undated warning.
    }
    prepared += await conn.transaction(async (trx) => {
      if (!enabled()) return 0;
      const changed = await trx('call_commitments').where({ id: row.id, status: 'open' })
        .whereNull('callback_due_at').update({ callback_due_at: due,
          assigned_to: trx.raw('COALESCE(assigned_to, ?::uuid)', [owner?.id || null]), updated_at: new Date() });
      if (changed) await recordAuditEvent({ actor_type: 'system', action: 'callback_card_created',
        resource_type: 'call_commitment', resource_id: row.id,
        metadata: { due_at: due.toISOString(), assigned_to: row.assigned_to || owner?.id || null }, critical: true, trx });
      return changed;
    });
  }
  return prepared;
}

async function listCallbackCards(conn, { now = new Date(), limit = 100, offset = 0 } = {}) {
  if (!enabled()) return [];
  const { listOpenCommitments } = require('./call-commitments');
  const rows = await listOpenCommitments(conn, { party: 'waves', kind: 'callback', now, limit, offset });
  const ids = [...new Set(rows.map((r) => r.assigned_to).filter(Boolean))];
  const staff = ids.length ? await conn('technicians').whereIn('id', ids).select('id', 'name', 'employment_status') : [];
  return rows.map((row) => ({ ...row, card_kind: 'callback',
    due_at: row.due_at || row.callback_due_at || null,
    owner_name: staff.find((s) => s.id === row.assigned_to)?.name || null,
    owner_active: staff.find((s) => s.id === row.assigned_to)?.employment_status === 'active',
    snoozed: !!row.snoozed_until && new Date(row.snoozed_until) > now,
  }));
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
    const row = await trx('call_commitments').where({ id, kind: 'callback', party: 'waves' }).forUpdate().first();
    if (!row || !row.call_log_id) throw error('Callback not found', 404);
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
    if (['fulfill', 'dismiss', 'reopen', 'confirm', 'edit'].includes(action)) {
      const changed = await require('./call-commitments').applyHumanUpdate(trx, id, { action, reviewedBy: actorId, description, due_at, note });
      if (action === 'edit' && due_at !== undefined && changed.due_at == null) patch.callback_due_at = null;
      patch.snoozed_until = null;
    }
    await trx('call_commitments').where({ id }).update(patch);
    await recordAuditEvent({ actor_type: 'technician', actor_id: actorId, action: `callback_${action}`,
      resource_type: 'call_commitment', resource_id: id, metadata: { snoozed_until: until?.toISOString() || null }, critical: true, trx });
    await trx('notifications').where({ recipient_type: 'admin' }).where(function containsCallback() {
      this.whereRaw("metadata->>'commitment_id' = ?", [id])
        .orWhereRaw("metadata->'overdue_commitment_ids' @> ?::jsonb", [JSON.stringify([id])]);
    })
      .whereNull('read_at').update({ read_at: now });
    return require('./call-commitments').normalizeRow(await trx('call_commitments').where({ id }).first());
  });
}

async function notifyDueCallbacks(conn, { now = new Date() } = {}) {
  if (!enabled()) return { alerted: 0 };
  await prepareCallbackCards(conn);
  const { refreshFulfillment, staleAiRowSql } = require('./call-commitments');
  const candidates = [];
  // Gather the scan before refreshing: fulfillment removes rows from the
  // open list and would otherwise shift later pages underneath the offset.
  for (let offset = 0; offset < 5000; offset += 200) {
    const rows = await listCallbackCards(conn, { now, limit: 200, offset });
    candidates.push(...rows.filter((row) => !isInternalTestCustomerId(row.customer_id)
      && row.due_at && new Date(row.due_at) <= now && !row.snoozed));
    if (rows.length < 200) break;
  }
  const verifiedCalls = new Set();
  for (const id of new Set(candidates.map((row) => row.call_log_id))) {
    const result = await refreshFulfillment(conn, id).catch(() => ({ failed: 1 }));
    if (!result.failed) verifiedCalls.add(id);
  }
  const ids = candidates.filter((row) => verifiedCalls.has(row.call_log_id)).map((row) => row.id);
  if (!ids.length) {
    if (!candidates.length) await conn('notifications').where({ recipient_type: 'admin' }).whereNull('read_at')
      .whereRaw("metadata->>'dedupeKey' LIKE 'callback-cards-overdue:%'").update({ read_at: now });
    return { alerted: 0 };
  }
  return conn.transaction(async (trx) => {
    const live = await trx('call_commitments as cc').join('call_log as cl', 'cl.id', 'cc.call_log_id')
      .whereIn('cc.id', ids).where({ 'cc.status': 'open', 'cc.kind': 'callback', 'cc.party': 'waves' })
      .whereRaw(`NOT ${staleAiRowSql('cc')}`).orderBy('cc.id').forUpdate('cc')
      .select('cc.*', 'cl.customer_id');
    if (!enabled()) return { alerted: 0 };
    const overdue = live.filter((row) => !isInternalTestCustomerId(row.customer_id)
      && (row.due_at || row.callback_due_at) && new Date(row.due_at || row.callback_due_at) <= now
      && (!row.snoozed_until || new Date(row.snoozed_until) <= now));
    const alertKey = (row) => `callback-card:${row.id}:${[row.due_at || row.callback_due_at, row.snoozed_until, row.reviewed_at]
      .map((value) => value ? new Date(value).toISOString() : '').join(':')}:${row.assigned_to || 'unassigned'}`;
    const notifications = require('./notification-service');
    if (overdue.length > require('./call-commitments-watchdog').AGGREGATE_THRESHOLD) {
      const notice = await notifications.notifyAdmin('alert', `${overdue.length} promised callbacks are due`,
        'Open the callback cards to call, finish, or snooze these promises.', {
          link: '/admin/communications#tab=owed', dedupeKey: `callback-cards-overdue:${etDateString(now)}`,
          dedupeVersion: require('node:crypto').createHash('sha256').update(overdue.map(alertKey).join('|')).digest('hex'),
          refreshOnDedupe: true, bell: true, trx,
          metadata: { triggerKey: 'call_commitment_overdue', overdue_count: overdue.length,
            overdue_commitment_ids: overdue.map((row) => row.id) },
        });
      return { alerted: notice?.id && (!notice.deduped || notice.refreshed) ? 1 : 0, aggregate: true };
    }
    await trx('notifications').where({ recipient_type: 'admin' }).whereNull('read_at')
      .whereRaw("metadata->>'dedupeKey' LIKE 'callback-cards-overdue:%'").update({ read_at: now });
    let alerted = 0;
    for (const row of overdue) {
      const notice = await notifications.notifyAdmin('alert', 'A promised callback is due',
        'Open the callback card to call, finish, or snooze this promise.', {
          link: `/admin/communications#tab=owed&callback=${row.id}`, dedupeKey: alertKey(row),
          bell: true, trx, metadata: { triggerKey: 'call_commitment_overdue', commitment_id: row.id, customer_id: row.customer_id },
        });
      if (notice?.id && !notice.deduped) alerted += 1;
    }
    return { alerted };
  });
}

module.exports = { enabled, loadCalendar, staffedDeadline, prepareCallbackCards, listCallbackCards, actOnCallback, notifyDueCallbacks };
