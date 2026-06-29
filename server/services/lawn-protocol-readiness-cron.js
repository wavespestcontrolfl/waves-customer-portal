const db = require('../models/db');
const logger = require('./logger');
const { buildPlanForService } = require('./waveguard-plan-engine');
const { etDateString, addETDays } = require('../utils/datetime-et');

const ADVISORY_LOCK_KEY = 'lawn-protocol-readiness-cron';

let isRunning = false;

function addIssue(issues, severity, code, message, metadata = {}) {
  issues.push({ severity, code, message, metadata });
}

function readinessStatus(issues = []) {
  if (issues.some((issue) => issue.severity === 'block')) return 'blocked';
  if (issues.some((issue) => issue.severity === 'warn')) return 'warning';
  return 'ready';
}

function summarizePlanReadiness(plan) {
  const issues = [];
  const assignment = plan?.appointmentAssignment || {};
  if (!assignment.assignedAt || !assignment.equipmentSystemId || !assignment.calibrationId) {
    addIssue(issues, 'block', 'missing_protocol_assignment', 'Appointment has not been assigned a protocol window and equipment calibration.');
  }
  for (const block of plan?.equipmentCalibration?.blocks || []) {
    addIssue(issues, 'block', block.code || 'equipment_block', block.message || 'Equipment calibration is blocking readiness.', block);
  }
  for (const warning of plan?.equipmentCalibration?.warnings || []) {
    addIssue(issues, 'warn', warning.code || 'equipment_warning', warning.message || 'Equipment calibration has a warning.', warning);
  }
  for (const block of plan?.inventory?.blocks || []) {
    addIssue(issues, 'block', block.code || 'inventory_block', block.message || 'Inventory is blocking readiness.', block);
  }
  for (const warning of plan?.inventory?.warnings || []) {
    addIssue(issues, 'warn', warning.code || 'inventory_warning', warning.message || 'Inventory has a warning.', warning);
  }
  for (const block of plan?.propertyGate?.blocks || []) {
    if (String(block.code || '').includes('calibration')) continue;
    addIssue(issues, 'block', block.code || 'property_block', block.message || 'Property gate is blocking readiness.', block);
  }
  for (const warning of plan?.propertyGate?.warnings || []) {
    addIssue(issues, 'warn', warning.code || 'property_warning', warning.message || 'Property gate has a warning.', warning);
  }
  if (!plan?.propertyGate?.latestAssessment?.id) {
    addIssue(issues, 'warn', 'missing_lawn_assessment_baseline', 'No recent lawn assessment is linked for baseline field conditions.');
  }
  const wikiRefs = plan?.protocol?.structured?.window?.wikiRefs || [];
  if (!Array.isArray(wikiRefs) || !wikiRefs.length) {
    addIssue(issues, 'warn', 'missing_window_sop_refs', 'Protocol window has no SOP/wiki references attached.');
  }

  const deduped = [];
  const seen = new Set();
  for (const issue of issues) {
    const key = `${issue.severity}:${issue.code}:${issue.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(issue);
  }
  return {
    status: readinessStatus(deduped),
    issues: deduped,
    counts: deduped.reduce((acc, issue) => {
      acc[issue.severity] = (acc[issue.severity] || 0) + 1;
      return acc;
    }, { block: 0, warn: 0, info: 0 }),
  };
}

async function buildReadinessQueue({ days = 14, limit = 100, knex = db } = {}) {
  const today = etDateString();
  const endDate = etDateString(addETDays(new Date(), Number(days || 14)));
  const services = await knex('scheduled_services as ss')
    .leftJoin('customers as c', 'ss.customer_id', 'c.id')
    .leftJoin('technicians as t', 'ss.technician_id', 't.id')
    .whereBetween('ss.scheduled_date', [today, endDate])
    .whereNotIn('ss.status', ['completed', 'cancelled', 'canceled', 'void'])
    // Real WaveGuard members only — exclude the flat non-member 'Commercial' tier.
    .whereIn('c.waveguard_tier', ['Bronze', 'Silver', 'Gold', 'Platinum'])
    .where(function lawnService() {
      this.whereILike('ss.service_type', '%lawn%')
        .orWhereILike('ss.service_type', '%fertiliz%')
        .orWhereILike('ss.service_type', '%turf%');
    })
    .select(
      'ss.id',
      'ss.customer_id',
      'ss.service_type',
      'ss.scheduled_date',
      'ss.window_start',
      'ss.lawn_protocol_window_title',
      'c.first_name',
      'c.last_name',
      'c.address_line1',
      'c.city',
      'c.waveguard_tier',
      't.name as technician_name',
    )
    .orderBy('ss.scheduled_date', 'asc')
    .orderBy('ss.window_start', 'asc')
    .limit(Number(limit || 100));

  const appointments = [];
  for (const service of services) {
    try {
      const plan = await buildPlanForService(service.id, { db: knex });
      const readiness = summarizePlanReadiness(plan);
      appointments.push({
        id: service.id,
        customerId: service.customer_id,
        customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim() || 'Customer',
        address: service.address_line1 || null,
        city: service.city || null,
        serviceType: service.service_type,
        scheduledDate: service.scheduled_date,
        windowStart: service.window_start,
        technicianName: service.technician_name || null,
        waveguardTier: service.waveguard_tier || null,
        protocolWindowTitle: plan?.protocol?.structured?.window?.title || service.lawn_protocol_window_title || null,
        status: readiness.status,
        issues: readiness.issues,
        counts: readiness.counts,
      });
    } catch (err) {
      appointments.push({
        id: service.id,
        customerId: service.customer_id,
        customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim() || 'Customer',
        address: service.address_line1 || null,
        city: service.city || null,
        serviceType: service.service_type,
        scheduledDate: service.scheduled_date,
        windowStart: service.window_start,
        technicianName: service.technician_name || null,
        waveguardTier: service.waveguard_tier || null,
        protocolWindowTitle: service.lawn_protocol_window_title || null,
        status: 'blocked',
        issues: [{ severity: 'block', code: 'readiness_plan_error', message: err.message || 'Could not build readiness plan for this appointment.' }],
        counts: { block: 1, warn: 0, info: 0 },
      });
    }
  }

  return {
    days: Number(days || 14),
    startDate: today,
    endDate,
    statusCounts: appointments.reduce((acc, appt) => {
      acc[appt.status] = (acc[appt.status] || 0) + 1;
      return acc;
    }, { ready: 0, warning: 0, blocked: 0 }),
    appointments,
  };
}

function compactAppointment(appt) {
  return {
    id: appt.id,
    customerId: appt.customerId,
    customerName: appt.customerName,
    address: appt.address,
    city: appt.city,
    serviceType: appt.serviceType,
    scheduledDate: appt.scheduledDate,
    windowStart: appt.windowStart,
    technicianName: appt.technicianName,
    waveguardTier: appt.waveguardTier,
    protocolWindowTitle: appt.protocolWindowTitle,
    status: appt.status,
    counts: appt.counts,
    issues: (appt.issues || []).map((issue) => ({
      severity: issue.severity,
      code: issue.code,
      message: issue.message,
      metadata: issue.metadata || {},
    })),
  };
}

async function upsertReadinessAlert(knex, snapshot, queue) {
  if (!(await knex.schema.hasTable('admin_alerts'))) return null;
  const blocked = queue.statusCounts.blocked || 0;
  const warning = queue.statusCounts.warning || 0;
  const appointmentCount = queue.appointments?.length || 0;
  const now = new Date();
  const metadata = {
    snapshotId: snapshot.id,
    scanStartDate: queue.startDate,
    scanEndDate: queue.endDate,
    days: queue.days,
    statusCounts: queue.statusCounts,
  };
  if (!blocked) {
    const resolvedAlerts = await knex('admin_alerts')
      .where({ type: 'lawn_protocol_readiness', status: 'open' })
      .where(function matchingWindow() {
        this.where({ dedupe_key: `lawn_protocol_readiness:${queue.startDate}:${queue.endDate}` })
          .orWhereRaw("metadata->>'scanStartDate' = ? AND metadata->>'scanEndDate' = ?", [queue.startDate, queue.endDate]);
      })
      .update({
        status: 'resolved',
        resolved_at: now,
        last_seen_at: now,
        description: 'Resolved after scheduled readiness snapshot found no blocked appointments.',
        metadata: JSON.stringify(metadata),
        updated_at: now,
      });
    return resolvedAlerts ? { resolved: true, count: resolvedAlerts } : null;
  }

  const payload = {
    dedupe_key: `lawn_protocol_readiness:${queue.startDate}:${queue.endDate}`,
    type: 'lawn_protocol_readiness',
    status: 'open',
    severity: blocked >= 5 ? 'critical' : 'high',
    source_record_type: 'lawn_protocol_readiness_snapshot',
    source_record_id: snapshot.id,
    title: `WaveGuard readiness: ${blocked} blocked appointment${blocked === 1 ? '' : 's'}`,
    description: `${blocked} of ${appointmentCount} upcoming WaveGuard lawn appointment${appointmentCount === 1 ? '' : 's'} are blocked for ${queue.startDate} through ${queue.endDate}. ${warning} appointment${warning === 1 ? '' : 's'} have warnings.`,
    href: '/admin/lawn-protocol?tab=readiness',
    detected_at: now,
    last_seen_at: now,
    created_by_rule: 'lawn_protocol_readiness_scheduled_snapshot',
    metadata: JSON.stringify(metadata),
    updated_at: now,
  };

  const [alert] = await knex('admin_alerts')
    .insert(payload)
    .onConflict('dedupe_key')
    .merge({
      status: 'open',
      severity: payload.severity,
      source_record_id: snapshot.id,
      title: payload.title,
      description: payload.description,
      href: payload.href,
      last_seen_at: payload.last_seen_at,
      metadata: payload.metadata,
      updated_at: payload.updated_at,
    })
    .returning(['id', 'dedupe_key', 'severity', 'title', 'href']);
  return alert || null;
}

async function runReadinessSnapshotInner(knex, { days = 14, limit = 100, source = 'scheduled_daily' } = {}) {
  if (!(await knex.schema.hasTable('lawn_protocol_readiness_snapshots'))) {
    return { skipped: true, reason: 'snapshot_table_missing' };
  }

  const today = etDateString();
  if (source === 'scheduled_daily') {
    const existing = await knex('lawn_protocol_readiness_snapshots')
      .where({ snapshot_date: today, source })
      .first('id');
    if (existing) return { skipped: true, reason: 'already_ran_today', snapshotId: existing.id };
  }

  const queue = await buildReadinessQueue({ days, limit, knex });
  const summary = {
    statusCounts: queue.statusCounts,
    generatedAt: new Date().toISOString(),
    scanStartDate: queue.startDate,
    scanEndDate: queue.endDate,
    days: queue.days,
  };

  const [snapshot] = await knex('lawn_protocol_readiness_snapshots')
    .insert({
      snapshot_date: today,
      scan_start_date: queue.startDate,
      scan_end_date: queue.endDate,
      days: queue.days,
      appointment_count: queue.appointments.length,
      ready_count: queue.statusCounts.ready || 0,
      warning_count: queue.statusCounts.warning || 0,
      blocked_count: queue.statusCounts.blocked || 0,
      source,
      summary: JSON.stringify(summary),
      appointments: JSON.stringify(queue.appointments.map(compactAppointment)),
    })
    .returning('*');

  const alert = await upsertReadinessAlert(knex, snapshot, queue);
  return {
    skipped: false,
    snapshotId: snapshot.id,
    alertId: alert?.id || null,
    appointmentCount: queue.appointments.length,
    ...queue.statusCounts,
  };
}

async function runReadinessSnapshot(options = {}) {
  if (isRunning) return { skipped: true, reason: 'already_running' };
  isRunning = true;
  try {
    return await db.transaction(async (trx) => {
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [ADVISORY_LOCK_KEY]);
      return runReadinessSnapshotInner(trx, options);
    });
  } catch (err) {
    logger.error(`[lawn-protocol-readiness-cron] failed: ${err.message}`);
    return { skipped: false, error: err.message };
  } finally {
    isRunning = false;
  }
}

module.exports = {
  runReadinessSnapshot,
  buildReadinessQueue,
};
