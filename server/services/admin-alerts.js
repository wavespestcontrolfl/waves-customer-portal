const db = require('../models/db');

const ACTIONABLE_SECTIONS = [
  'jobsNeedingAttention',
  'pipelineFollowUp',
  'missedLeads',
  'moneyCollections',
  'customerIssues',
];

const VALID_ACTIONS = new Set(['resolve', 'dismiss', 'snooze', 'assign', 'reopen']);

function normalizeSeverity(severity) {
  if (severity === 'critical') return 'critical';
  if (severity === 'high') return 'high';
  if (severity === 'low') return 'low';
  return 'medium';
}

function dedupeKeyForIssue(row) {
  return [
    row.type || 'unknown',
    row.sourceRecordType || 'unknown',
    row.sourceRecordId || row.id,
    row.id || '',
  ].join(':');
}

function flattenActionableIssues(sections = {}) {
  const rows = [];
  for (const section of ACTIONABLE_SECTIONS) {
    for (const row of sections[section] || []) {
      if (!row?.sourceRecordType || !row?.sourceRecordId || !row?.type) continue;
      rows.push({ ...row, commandCenterSection: section });
    }
  }
  return rows;
}

function toAlertInsert(row, now) {
  return {
    dedupe_key: dedupeKeyForIssue(row),
    type: row.type,
    status: 'open',
    severity: normalizeSeverity(row.severity),
    owner_user_id: row.employee?.id || null,
    source_record_type: row.sourceRecordType,
    source_record_id: String(row.sourceRecordId),
    title: row.label || row.type,
    description: row.summary || null,
    href: row.href || null,
    customer_id: row.customer?.id || null,
    employee_user_id: row.employee?.id || null,
    detected_at: row.occurredAt || now,
    last_seen_at: now,
    created_by_rule: `command_center:${row.type}`,
    metadata: JSON.stringify({
      ...(row.metadata || {}),
      commandCenterIssueId: row.id,
      commandCenterSection: row.commandCenterSection,
      customer: row.customer || null,
      employee: row.employee || null,
    }),
  };
}

function alertVisible(row, now = new Date()) {
  if (!row) return false;
  if (row.status === 'open') return true;
  if (row.status !== 'snoozed') return false;
  if (!row.snoozed_until) return false;
  return row.snoozed_until && new Date(row.snoozed_until) <= now;
}

function overlayAlertState(row, alert) {
  if (!alert) return row;
  return {
    ...row,
    alertId: alert.id,
    alertStatus: alert.status,
    ownerUserId: alert.owner_user_id,
    snoozedUntil: alert.snoozed_until,
    resolvedAt: alert.resolved_at,
    dismissedAt: alert.dismissed_at,
  };
}

async function syncCommandCenterAlerts(sections = {}, { trx } = {}) {
  const rows = flattenActionableIssues(sections);
  if (!rows.length) return new Map();
  const now = new Date();
  const inserts = rows.map((row) => toAlertInsert(row, now));
  const conn = trx || db;

  await conn('admin_alerts')
    .insert(inserts)
    .onConflict('dedupe_key')
    .merge({
      severity: conn.raw('EXCLUDED.severity'),
      owner_user_id: conn.raw('COALESCE(admin_alerts.owner_user_id, EXCLUDED.owner_user_id)'),
      title: conn.raw('EXCLUDED.title'),
      description: conn.raw('EXCLUDED.description'),
      href: conn.raw('EXCLUDED.href'),
      customer_id: conn.raw('EXCLUDED.customer_id'),
      employee_user_id: conn.raw('EXCLUDED.employee_user_id'),
      last_seen_at: conn.raw('EXCLUDED.last_seen_at'),
      metadata: conn.raw('EXCLUDED.metadata'),
      updated_at: conn.fn.now(),
    });

  const dedupeKeys = inserts.map((row) => row.dedupe_key);
  const alerts = await conn('admin_alerts').whereIn('dedupe_key', dedupeKeys);
  return new Map(alerts.map((alert) => [alert.dedupe_key, alert]));
}

function applyAlertLifecycle(sections = {}, alertsByKey, now = new Date()) {
  const next = { ...sections };
  for (const section of ACTIONABLE_SECTIONS) {
    next[section] = (sections[section] || [])
      .map((row) => overlayAlertState(row, alertsByKey.get(dedupeKeyForIssue(row))))
      .filter((row) => alertVisible(alertsByKey.get(dedupeKeyForIssue(row)), now));
  }
  return next;
}

async function recordEvent(conn, { alertId, eventType, actorUserId, previousValue, newValue, note }) {
  await conn('admin_alert_events').insert({
    alert_id: alertId,
    event_type: eventType,
    actor_user_id: actorUserId || null,
    previous_value: previousValue ? JSON.stringify(previousValue) : null,
    new_value: newValue ? JSON.stringify(newValue) : null,
    note: note || null,
  });
}

async function updateAlert({ id, action, actorUserId, ownerUserId, snoozedUntil, note }) {
  if (!id) {
    const err = new Error('alert id is required');
    err.status = 400;
    throw err;
  }
  if (!VALID_ACTIONS.has(action)) {
    const err = new Error('invalid alert action');
    err.status = 400;
    throw err;
  }

  let updated;
  await db.transaction(async (trx) => {
    const current = await trx('admin_alerts').where({ id }).first();
    if (!current) {
      const err = new Error('alert not found');
      err.status = 404;
      throw err;
    }

    const patch = { updated_at: trx.fn.now() };
    if (action === 'resolve') {
      patch.status = 'resolved';
      patch.resolved_at = trx.fn.now();
      patch.snoozed_until = null;
    } else if (action === 'dismiss') {
      patch.status = 'dismissed';
      patch.dismissed_at = trx.fn.now();
      patch.snoozed_until = null;
    } else if (action === 'snooze') {
      if (!snoozedUntil || Number.isNaN(new Date(snoozedUntil).getTime())) {
        const err = new Error('valid snoozedUntil is required');
        err.status = 400;
        throw err;
      }
      patch.status = 'snoozed';
      patch.snoozed_until = new Date(snoozedUntil);
    } else if (action === 'assign') {
      patch.owner_user_id = ownerUserId || null;
    } else if (action === 'reopen') {
      patch.status = 'open';
      patch.resolved_at = null;
      patch.dismissed_at = null;
      patch.snoozed_until = null;
    }

    const rows = await trx('admin_alerts').where({ id }).update(patch).returning('*');
    updated = rows[0];
    await recordEvent(trx, {
      alertId: id,
      eventType: action,
      actorUserId,
      previousValue: {
        status: current.status,
        ownerUserId: current.owner_user_id,
        snoozedUntil: current.snoozed_until,
      },
      newValue: {
        status: updated.status,
        ownerUserId: updated.owner_user_id,
        snoozedUntil: updated.snoozed_until,
      },
      note,
    });
  });
  return updated;
}

async function listEvents(alertId) {
  return db('admin_alert_events as e')
    .leftJoin('technicians as t', 'e.actor_user_id', 't.id')
    .where('e.alert_id', alertId)
    .select('e.*', 't.name as actor_name')
    .orderBy('e.event_at', 'desc')
    .limit(100);
}

module.exports = {
  ACTIONABLE_SECTIONS,
  dedupeKeyForIssue,
  syncCommandCenterAlerts,
  applyAlertLifecycle,
  updateAlert,
  listEvents,
};
