const express = require('express');
const router = express.Router();
const db = require('../models/db');
const { adminAuthenticate, requireTechOrAdmin } = require('../middleware/admin-auth');
const { addETDays, etDateString, etParts } = require('../utils/datetime-et');
const {
  buildPlanForService,
  buildMixOrder,
  calculateProductAmount,
  effectiveAreaFactor,
  matchCatalogProduct,
  parseVisitNutrientTargets,
  parseProtocolLines,
  resolveProtocolItems,
  summarizeMaterialCost,
} = require('../services/waveguard-plan-engine');
const { matchServiceProtocol } = require('../services/protocol-matcher');
const { scopeFromText } = require('../services/service-report/action-scope');
const {
  getActiveLawnProtocol,
  getProtocolWindowContext,
  summarizeProtocolContext,
} = require('../services/lawn-protocol-operating-layer');

router.use(adminAuthenticate, requireTechOrAdmin);

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const TRACK_MAP = {
  A_St_Aug_Sun: 'st_augustine',
  B_St_Aug_Shade: 'st_augustine',
  C1_Bermuda: 'bermuda',
  C2_Zoysia: 'zoysia',
  D_Bahia: 'bahia',
};
const PROGRAM_KEYS = [
  'tree_shrub',
  'pest',
  'rodent',
  'mosquito',
  'palm_injection',
  'cockroach',
  'bed_bug',
  'termite',
];

function programSummary(key, program) {
  if (!program) return null;
  return {
    key,
    name: program.name,
    visits: Array.isArray(program.visits) ? program.visits.length : 0,
    notes: Array.isArray(program.notes) ? program.notes.length : 0,
  };
}

function monthAbbr(value) {
  const n = parseInt(value, 10);
  if (Number.isFinite(n) && n >= 1 && n <= 12) return MONTH_ABBR[n - 1];
  const raw = String(value || '').slice(0, 3).toLowerCase();
  return MONTH_ABBR.find((m) => m.toLowerCase() === raw) || MONTH_ABBR[etParts(new Date()).month - 1];
}

function dateOnlyToETNoon(value) {
  if (!value) return new Date();
  const dateOnly = String(value).slice(0, 10);
  return new Date(`${dateOnly}T12:00:00`);
}

function normalizeText(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function lawnTrackFromInput(value) {
  const text = normalizeText(value);
  if (text.includes('bermuda')) return 'bermuda';
  if (text.includes('zoysia')) return 'zoysia';
  if (text.includes('bahia')) return 'bahia';
  return 'st_augustine';
}

function actionKindForLine(line, product) {
  const text = normalizeText(`${line?.raw || ''} ${product?.name || ''} ${product?.category || ''}`);
  if (text.includes('pre emerg') || text.includes('prodiamine') || text.includes('stonewall')) return 'pre_emergent';
  if (text.includes('post emerg') || text.includes('celsius') || text.includes('sedge') || text.includes('dismiss') || text.includes('speedzone') || text.includes('weed')) return 'post_emergent';
  if (text.includes('slow release') || text.includes('polyplus') || text.includes('fert') || text.includes('nitrogen') || Number(product?.analysis_n || 0) > 0) return 'slow_release_fertilizer';
  if (text.includes('fungicide') || text.includes('frac') || text.includes('headway') || text.includes('medallion') || text.includes('armada') || text.includes('azoxy')) return 'fungicide';
  if (text.includes('insect') || text.includes('chinch') || text.includes('mole cricket') || text.includes('acelepryn') || text.includes('talstar') || text.includes('demand') || text.includes('alpine')) return 'insecticide';
  if (text.includes('bait')) return 'bait';
  if (text.includes('sweep') || text.includes('webster') || text.includes('de web')) return 'web_sweep';
  if (text.includes('inspect') || text.includes('scout') || text.includes('audit') || text.includes('sample') || text.includes('monitor')) return 'inspection';
  return 'service_action';
}

function actionLabel(kind, line, product) {
  const productName = product?.name || '';
  const raw = String(line?.raw || '').replace(/\s*\([^)]*\)\s*$/g, '').trim();
  if (kind === 'pre_emergent') return `Applied pre-emergent${productName ? ` - ${productName}` : ''}`;
  if (kind === 'post_emergent') return `Applied post-emergent${productName ? ` - ${productName}` : ''}`;
  if (kind === 'slow_release_fertilizer') return `Applied slow-release fertilizer${productName ? ` - ${productName}` : ''}`;
  if (kind === 'fungicide') return `Applied fungicide${productName ? ` - ${productName}` : ''}`;
  if (kind === 'insecticide') return `Applied insect control${productName ? ` - ${productName}` : ''}`;
  if (kind === 'bait') return raw || 'Placed bait';
  if (kind === 'web_sweep') return raw || 'Completed web sweep';
  if (kind === 'inspection') return raw || 'Completed inspection';
  return raw || productName || 'Completed protocol item';
}

// Interim scope classifier for protocol-derived actions (pest services show
// these instead of the generic chips). PR2 replaces this with explicit
// per-line metadata in protocols.json; until then this shared classifier is
// the fallback that lets an interior treatment fire the re-entry countdown.
function actionScopeForLine(line, product) {
  return scopeFromText(`${line?.raw || ''} ${product?.name || ''} ${product?.category || ''}`);
}

function actionTreatmentApplied(kind, line) {
  if (kind === 'inspection') return false;
  const text = normalizeText(line?.raw || '');
  if (/\b(declin|no access|not treated|unavailable|skip|skipped|customer not home)\b/.test(text)) return false;
  return true;
}

function serializeProtocolProduct(product) {
  if (!product) return null;
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    activeIngredient: product.active_ingredient || null,
    defaultRatePer1000: product.default_rate_per_1000 != null ? Number(product.default_rate_per_1000) : null,
    rateUnit: product.rate_unit || null,
    defaultUnit: product.rate_unit || null,
    maxLabelRatePer1000: product.max_label_rate_per_1000 != null ? Number(product.max_label_rate_per_1000) : null,
  };
}

function parsePositiveNumber(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseInventoryQuantity(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function numberOrNull(value) {
  if (value === '' || value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function stringArray(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || '').trim()).filter(Boolean);
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|,/)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function stockStatusForProduct(product) {
  if (!product) return 'unmapped';
  const onHand = parseInventoryQuantity(product.inventory_on_hand);
  const threshold = parsePositiveNumber(product.low_stock_threshold);
  if (onHand == null) return 'not_tracked';
  if (onHand <= 0) return 'depleted';
  if (threshold != null && onHand <= threshold) return 'low';
  return 'ok';
}

function bridgeLink(path, label, description) {
  return { path, label, description };
}

function addReadinessIssue(issues, severity, code, message, metadata = {}) {
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
    addReadinessIssue(
      issues,
      'block',
      'missing_protocol_assignment',
      'Appointment has not been assigned a protocol window and equipment calibration.',
    );
  }

  for (const block of plan?.equipmentCalibration?.blocks || []) {
    addReadinessIssue(issues, 'block', block.code || 'equipment_block', block.message || 'Equipment calibration is blocking readiness.', block);
  }
  for (const warning of plan?.equipmentCalibration?.warnings || []) {
    addReadinessIssue(issues, 'warn', warning.code || 'equipment_warning', warning.message || 'Equipment calibration has a warning.', warning);
  }

  for (const block of plan?.inventory?.blocks || []) {
    addReadinessIssue(issues, 'block', block.code || 'inventory_block', block.message || 'Inventory is blocking readiness.', block);
  }
  for (const warning of plan?.inventory?.warnings || []) {
    addReadinessIssue(issues, 'warn', warning.code || 'inventory_warning', warning.message || 'Inventory has a warning.', warning);
  }

  for (const block of plan?.propertyGate?.blocks || []) {
    if (String(block.code || '').includes('calibration')) continue;
    addReadinessIssue(issues, 'block', block.code || 'property_block', block.message || 'Property gate is blocking readiness.', block);
  }
  for (const warning of plan?.propertyGate?.warnings || []) {
    addReadinessIssue(issues, 'warn', warning.code || 'property_warning', warning.message || 'Property gate has a warning.', warning);
  }

  if (!plan?.propertyGate?.latestAssessment?.id) {
    addReadinessIssue(
      issues,
      'warn',
      'missing_lawn_assessment_baseline',
      'No recent lawn assessment is linked for baseline field conditions.',
    );
  }

  const wikiRefs = plan?.protocol?.structured?.window?.wikiRefs || [];
  if (!Array.isArray(wikiRefs) || !wikiRefs.length) {
    addReadinessIssue(
      issues,
      'warn',
      'missing_window_sop_refs',
      'Protocol window has no SOP/wiki references attached.',
    );
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

function markdownList(items = [], formatter = (item) => item) {
  const lines = (items || [])
    .map(formatter)
    .map((line) => String(line || '').trim())
    .filter(Boolean);
  return lines.length ? lines.map((line) => `- ${line}`).join('\n') : '- None recorded';
}

function protocolSopSlug(protocol, window) {
  return `waveguard-${protocol.protocol_key}-${window.window_key}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 190);
}

function renderWindowSopMarkdown({ protocol, window, products = [], gates = [], calibrations = [] }) {
  const defaultProducts = products.filter((product) => product.default_in_plan);
  const conditionalProducts = products.filter((product) => !product.default_in_plan);
  const applicableGates = gates.filter((gate) => {
    const logic = gate.logic || {};
    const months = Array.isArray(logic.months) ? logic.months : [];
    const windowKeys = Array.isArray(logic.windowKeys) ? logic.windowKeys : [];
    return !months.length && !windowKeys.length
      ? true
      : months.includes(window.month) || windowKeys.includes(window.window_key);
  });

  return [
    `# ${protocol.name} - ${window.title}`,
    '',
    `**Protocol:** ${protocol.protocol_key} ${protocol.version}`,
    `**Window:** ${window.window_key}`,
    `**Visit type:** ${window.visit_type || 'protocol visit'}`,
    `**Production mode:** ${window.production_mode || 'field route'}`,
    `**Carrier target:** ${window.default_carrier_gal_per_1000 || 'label/route'} gal per 1,000 sq ft`,
    '',
    '## Goal',
    window.goal || 'Follow the current WaveGuard lawn protocol for this seasonal window.',
    '',
    '## Required Field Tasks',
    markdownList(window.required_tasks, (task) => String(task).replace(/_/g, ' ')),
    '',
    '## Default Products',
    markdownList(defaultProducts, (product) => {
      const rate = product.rate_per_1000 != null ? `${product.rate_per_1000} ${product.rate_unit || ''}/1,000 sq ft` : 'label-rate';
      return `${product.product_name} - ${product.role || 'protocol product'} - ${rate}`;
    }),
    '',
    '## Conditional Products',
    markdownList(conditionalProducts, (product) => {
      const rate = product.rate_per_1000 != null ? `${product.rate_per_1000} ${product.rate_unit || ''}/1,000 sq ft` : 'label-rate';
      return `${product.product_name} - ${product.role || 'conditional'} - ${rate}`;
    }),
    '',
    '## Enforcement Gates',
    markdownList(applicableGates, (gate) => `${gate.title}: ${gate.rule_text}`),
    '',
    '## Calibration References',
    markdownList(calibrations, (cal) => {
      const carrier = cal.carrier_gal_per_1000 != null ? `${cal.carrier_gal_per_1000} gal/1K` : 'carrier not set';
      return `${cal.system_name} - ${carrier} - ${cal.calibration_status || 'status unknown'}`;
    }),
    '',
    '## Customer Note Templates',
    markdownList(window.customer_note_templates),
    '',
    '## Operating Sentence',
    protocol.operating_sentence || 'Every stop must be legal, calibrated, seasonally justified, and documented.',
  ].join('\n');
}

async function loadWindowSopPayload(knex, protocolId, windowKey) {
  const protocol = await knex('lawn_protocols').where({ id: protocolId }).first();
  if (!protocol) return null;
  const window = await knex('lawn_protocol_windows')
    .where({ lawn_protocol_id: protocol.id, window_key: windowKey })
    .first();
  if (!window) return null;
  const [products, gates, calibrations] = await Promise.all([
    knex('lawn_protocol_products')
      .where({ lawn_protocol_window_id: window.id })
      .orderBy('sort_order', 'asc')
      .catch(() => []),
    knex('lawn_protocol_gates')
      .where({ lawn_protocol_id: protocol.id })
      .orderBy('gate_key', 'asc')
      .catch(() => []),
    knex('equipment_calibrations as ec')
      .join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
      .where('ec.active', true)
      .where('es.active', true)
      .whereIn('es.system_type', ['tank', 'backpack'])
      .select('ec.carrier_gal_per_1000', 'ec.calibration_status', 'es.name as system_name')
      .orderBy('es.name', 'asc')
      .catch(() => []),
  ]);
  return { protocol, window, products, gates, calibrations };
}

async function loadProtocolWikiPages(knex, protocol, window) {
  if (!protocol?.protocol_key || !window?.key) return [];
  const rows = await knex('knowledge_base')
    .where({ category: 'protocols' })
    .whereRaw("metadata->>'protocolKey' = ?", [protocol.protocol_key])
    .whereRaw("metadata->>'windowKey' = ?", [window.key])
    .select('id', 'slug', 'title', 'category', 'confidence', 'status', 'last_verified_at', 'updated_at', 'metadata')
    .orderBy('updated_at', 'desc')
    .limit(10)
    .catch(() => []);
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    title: row.title,
    category: row.category,
    confidence: row.confidence,
    status: row.status,
    lastVerifiedAt: row.last_verified_at,
    updatedAt: row.updated_at,
  }));
}

async function buildReadinessQueue(knex, { days = 14, limit = 50 } = {}) {
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
      'ss.status',
      'ss.lawn_protocol_key',
      'ss.lawn_protocol_window_title',
      'ss.assigned_equipment_system_id',
      'ss.assigned_calibration_id',
      'c.first_name',
      'c.last_name',
      'c.address_line1',
      'c.city',
      'c.waveguard_tier',
      't.name as technician_name',
    )
    .orderBy('ss.scheduled_date', 'asc')
    .orderBy('ss.window_start', 'asc')
    .limit(Number(limit || 50))
    .catch(() => []);

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
        assignment: plan?.appointmentAssignment || null,
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
        assignment: null,
        status: 'blocked',
        issues: [{
          severity: 'block',
          code: 'readiness_plan_error',
          message: err.message || 'Could not build readiness plan for this appointment.',
        }],
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

async function getUpcomingWaveGuardLawnServices(knex, { days = 14, limit = 75 } = {}) {
  const today = etDateString();
  const endDate = etDateString(addETDays(new Date(), Number(days || 14)));

  return knex('scheduled_services as ss')
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
      'ss.status',
      'ss.lawn_protocol_key',
      'ss.lawn_protocol_window_title',
      'ss.assigned_equipment_system_id',
      'ss.assigned_calibration_id',
      'c.first_name',
      'c.last_name',
      'c.address_line1',
      'c.city',
      'c.waveguard_tier',
      't.name as technician_name',
    )
    .orderBy('ss.scheduled_date', 'asc')
    .orderBy('ss.window_start', 'asc')
    .limit(Number(limit || 75))
    .catch(() => []);
}

async function selectDefaultFieldVerifiedCalibration(knex, serviceDate) {
  const dateOnly = serviceDate ? String(serviceDate).slice(0, 10) : new Date().toISOString().slice(0, 10);
  return knex('equipment_calibrations as ec')
    .join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where('ec.active', true)
    .where('es.active', true)
    .where('ec.calibration_status', 'field_verified')
    .where(function notExpired() {
      this.whereNull('ec.expires_at').orWhere('ec.expires_at', '>=', `${dateOnly}T00:00:00`);
    })
    .select(
      'ec.*',
      'es.name as system_name',
      'es.system_type',
      'es.tank_capacity_gal',
    )
    .orderByRaw("case when es.system_type = 'tank' then 0 when es.system_type = 'backpack' then 1 else 2 end")
    .orderBy('es.name', 'asc')
    .first()
    .catch(() => null);
}

function assignmentUpdateFromPlan(plan, source, actorId) {
  const selectedCalibration = plan?.equipmentCalibration?.selected || null;
  const structured = plan?.protocol?.structured || null;
  const window = structured?.window || null;
  if (!selectedCalibration?.id || !selectedCalibration?.equipment_system_id || !structured?.protocolKey || !window?.key) {
    return null;
  }
  return {
    lawn_protocol_key: structured.protocolKey,
    lawn_protocol_version: structured.version || null,
    lawn_protocol_window_key: window.key,
    lawn_protocol_window_title: window.title || null,
    assigned_equipment_system_id: selectedCalibration.equipment_system_id,
    assigned_calibration_id: selectedCalibration.id,
    lawn_protocol_assignment_source: source,
    lawn_protocol_assigned_by: actorId || null,
    lawn_protocol_assigned_at: new Date(),
    lawn_protocol_assignment_snapshot: JSON.stringify({
      protocol: {
        key: structured.protocolKey,
        version: structured.version || null,
        windowKey: window.key,
        windowTitle: window.title || null,
        goal: window.goal || null,
      },
      equipment: {
        systemId: selectedCalibration.equipment_system_id,
        calibrationId: selectedCalibration.id,
        systemName: selectedCalibration.system_name || null,
        carrierGalPer1000: selectedCalibration.carrier_gal_per_1000 != null
          ? Number(selectedCalibration.carrier_gal_per_1000)
          : null,
        calibrationStatus: selectedCalibration.calibration_status || null,
        expiresAt: selectedCalibration.expires_at || null,
      },
    }),
    updated_at: new Date(),
  };
}

async function bulkAssignReadyAppointments(knex, req, { days = 14, limit = 75 } = {}) {
  const services = await getUpcomingWaveGuardLawnServices(knex, { days, limit });
  const results = [];

  for (const service of services) {
    if (service.assigned_equipment_system_id && service.assigned_calibration_id && service.lawn_protocol_key) {
      results.push({ serviceId: service.id, status: 'skipped', reason: 'already_assigned' });
      continue;
    }

    const calibration = await selectDefaultFieldVerifiedCalibration(knex, service.scheduled_date);
    if (!calibration) {
      results.push({ serviceId: service.id, status: 'skipped', reason: 'no_field_verified_calibration' });
      continue;
    }

    try {
      const plan = await buildPlanForService(service.id, {
        db: knex,
        equipmentSystemId: calibration.equipment_system_id,
        calibrationId: calibration.id,
      });
      const readiness = summarizePlanReadiness({
        ...plan,
        appointmentAssignment: {
          ...(plan.appointmentAssignment || {}),
          assignedAt: new Date().toISOString(),
          equipmentSystemId: calibration.equipment_system_id,
          calibrationId: calibration.id,
        },
      });
      if (readiness.counts.block > 0) {
        results.push({
          serviceId: service.id,
          status: 'skipped',
          reason: 'readiness_blocked',
          issues: readiness.issues.filter((issue) => issue.severity === 'block'),
        });
        continue;
      }

      const update = assignmentUpdateFromPlan(plan, 'readiness_bulk_assign', req.technicianId);
      if (!update) {
        results.push({ serviceId: service.id, status: 'skipped', reason: 'assignment_payload_missing' });
        continue;
      }
      await knex('scheduled_services').where({ id: service.id }).update(update);
      results.push({
        serviceId: service.id,
        status: 'assigned',
        customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim(),
        calibrationId: calibration.id,
        equipmentSystemId: calibration.equipment_system_id,
        protocolWindowTitle: plan?.protocol?.structured?.window?.title || null,
      });
    } catch (err) {
      results.push({ serviceId: service.id, status: 'skipped', reason: 'plan_error', message: err.message });
    }
  }

  return {
    assigned: results.filter((row) => row.status === 'assigned').length,
    skipped: results.filter((row) => row.status !== 'assigned').length,
    results,
  };
}

async function assignReadinessAppointment(knex, req, serviceId) {
  const service = await knex('scheduled_services as ss')
    .leftJoin('customers as c', 'ss.customer_id', 'c.id')
    .where('ss.id', serviceId)
    .select(
      'ss.id',
      'ss.scheduled_date',
      'ss.assigned_equipment_system_id',
      'ss.assigned_calibration_id',
      'ss.lawn_protocol_key',
      'c.first_name',
      'c.last_name',
    )
    .first();
  if (!service) {
    const err = new Error('Scheduled service not found');
    err.statusCode = 404;
    throw err;
  }
  if (service.assigned_equipment_system_id && service.assigned_calibration_id && service.lawn_protocol_key) {
    return { serviceId: service.id, status: 'skipped', reason: 'already_assigned' };
  }
  const calibration = await selectDefaultFieldVerifiedCalibration(knex, service.scheduled_date);
  if (!calibration) {
    const err = new Error('No field-verified calibration is available for this appointment.');
    err.statusCode = 409;
    err.code = 'no_field_verified_calibration';
    throw err;
  }
  const plan = await buildPlanForService(service.id, {
    db: knex,
    equipmentSystemId: calibration.equipment_system_id,
    calibrationId: calibration.id,
  });
  const readiness = summarizePlanReadiness({
    ...plan,
    appointmentAssignment: {
      ...(plan.appointmentAssignment || {}),
      assignedAt: new Date().toISOString(),
      equipmentSystemId: calibration.equipment_system_id,
      calibrationId: calibration.id,
    },
  });
  if (readiness.counts.block > 0) {
    const err = new Error('Appointment still has readiness blocks.');
    err.statusCode = 409;
    err.code = 'readiness_blocked';
    err.details = readiness.issues.filter((issue) => issue.severity === 'block');
    throw err;
  }
  const update = assignmentUpdateFromPlan(plan, 'readiness_single_assign', req.technicianId);
  if (!update) {
    const err = new Error('Assignment payload could not be created.');
    err.statusCode = 409;
    err.code = 'assignment_payload_missing';
    throw err;
  }
  await knex('scheduled_services').where({ id: service.id }).update(update);
  return {
    serviceId: service.id,
    status: 'assigned',
    customerName: `${service.first_name || ''} ${service.last_name || ''}`.trim(),
    calibrationId: calibration.id,
    equipmentSystemId: calibration.equipment_system_id,
    protocolWindowTitle: plan?.protocol?.structured?.window?.title || null,
  };
}

async function loadReadinessSnapshotSummary(knex, limit = 8) {
  if (!(await knex.schema.hasTable('lawn_protocol_readiness_snapshots'))) {
    return { last: null, recent: [] };
  }
  const rows = await knex('lawn_protocol_readiness_snapshots')
    .select(
      'id',
      'snapshot_date',
      'scan_start_date',
      'scan_end_date',
      'days',
      'appointment_count',
      'ready_count',
      'warning_count',
      'blocked_count',
      'generated_by_name',
      'source',
      'created_at',
    )
    .orderBy('created_at', 'desc')
    .limit(Math.max(1, Math.min(30, Number(limit || 8))))
    .catch(() => []);
  return {
    last: rows[0] || null,
    recent: rows,
  };
}

function compactReadinessAppointment(appt) {
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
  const blocked = queue.statusCounts.blocked || 0;
  if (!(await knex.schema.hasTable('admin_alerts'))) return null;
  const warning = queue.statusCounts.warning || 0;
  const appointmentCount = queue.appointments?.length || 0;
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
        resolved_at: new Date(),
        last_seen_at: new Date(),
        description: 'Resolved after readiness snapshot found no blocked appointments.',
        metadata: JSON.stringify(metadata),
        updated_at: new Date(),
      });
    return resolvedAlerts ? { resolved: true, count: resolvedAlerts } : null;
  }

  const title = `WaveGuard readiness: ${blocked} blocked appointment${blocked === 1 ? '' : 's'}`;
  const description = `${blocked} of ${appointmentCount} upcoming WaveGuard lawn appointment${appointmentCount === 1 ? '' : 's'} are blocked for ${queue.startDate} through ${queue.endDate}. ${warning} appointment${warning === 1 ? '' : 's'} have warnings.`;
  const payload = {
    dedupe_key: `lawn_protocol_readiness:${queue.startDate}:${queue.endDate}`,
    type: 'lawn_protocol_readiness',
    status: 'open',
    severity: blocked >= 5 ? 'critical' : 'high',
    source_record_type: 'lawn_protocol_readiness_snapshot',
    source_record_id: snapshot.id,
    title,
    description,
    href: '/admin/lawn-protocol?tab=readiness',
    detected_at: new Date(),
    last_seen_at: new Date(),
    created_by_rule: 'lawn_protocol_readiness_snapshot',
    metadata: JSON.stringify(metadata),
    updated_at: new Date(),
  };

  const [alert] = await knex('admin_alerts')
    .insert(payload)
    .onConflict('dedupe_key')
    .merge({
      status: 'open',
      severity: payload.severity,
      source_record_id: snapshot.id,
      title,
      description,
      href: payload.href,
      last_seen_at: payload.last_seen_at,
      metadata: payload.metadata,
      updated_at: payload.updated_at,
    })
    .returning(['id', 'dedupe_key', 'type', 'status', 'severity', 'title', 'description', 'href'])
    .catch(() => []);
  return alert || null;
}

async function createReadinessSnapshot(knex, req, { days = 14, limit = 75, source = 'manual_admin' } = {}) {
  if (!(await knex.schema.hasTable('lawn_protocol_readiness_snapshots'))) {
    const err = new Error('Readiness snapshot table is not available. Run database migrations first.');
    err.statusCode = 409;
    throw err;
  }
  const queue = await buildReadinessQueue(knex, { days, limit });
  const actor = actorFromRequest(req);
  const summary = {
    statusCounts: queue.statusCounts,
    generatedAt: new Date().toISOString(),
    scanStartDate: queue.startDate,
    scanEndDate: queue.endDate,
    days: queue.days,
  };
  const [snapshot] = await knex('lawn_protocol_readiness_snapshots')
    .insert({
      scan_start_date: queue.startDate,
      scan_end_date: queue.endDate,
      days: queue.days,
      appointment_count: queue.appointments.length,
      ready_count: queue.statusCounts.ready || 0,
      warning_count: queue.statusCounts.warning || 0,
      blocked_count: queue.statusCounts.blocked || 0,
      generated_by: actor.id,
      generated_by_name: actor.name || actor.email || null,
      source,
      summary: JSON.stringify(summary),
      appointments: JSON.stringify(queue.appointments.map(compactReadinessAppointment)),
    })
    .returning('*');
  const alert = await upsertReadinessAlert(knex, snapshot, queue);
  const readinessSnapshots = await loadReadinessSnapshotSummary(knex);
  return { snapshot, alert, readinessQueue: queue, readinessSnapshots };
}

async function createProductSubstitution(knex, req, serviceId) {
  if (!(await knex.schema.hasTable('lawn_protocol_product_substitutions'))) {
    const err = new Error('Product substitution table is not available. Run database migrations first.');
    err.statusCode = 409;
    throw err;
  }
  const originalProductId = String(req.body?.originalProductId || '').trim();
  const substituteProductId = String(req.body?.substituteProductId || '').trim();
  if (!originalProductId || !substituteProductId) {
    const err = new Error('Original product and substitute product are required.');
    err.statusCode = 400;
    throw err;
  }
  if (originalProductId === substituteProductId) {
    const err = new Error('Substitute product must be different from the blocked product.');
    err.statusCode = 400;
    throw err;
  }

  const [service, originalProduct, substituteProduct] = await Promise.all([
    knex('scheduled_services').where({ id: serviceId }).first(),
    knex('products_catalog').where({ id: originalProductId }).first(),
    knex('products_catalog').where({ id: substituteProductId }).first(),
  ]);
  if (!service) {
    const err = new Error('Scheduled service not found.');
    err.statusCode = 404;
    throw err;
  }
  if (!originalProduct || !substituteProduct) {
    const err = new Error('Original or substitute product was not found.');
    err.statusCode = 400;
    throw err;
  }

  const actor = actorFromRequest(req);
  const payload = {
    scheduled_service_id: serviceId,
    original_product_id: originalProductId,
    substitute_product_id: substituteProductId,
    rate_per_1000: numberOrNull(req.body?.ratePer1000),
    rate_unit: String(req.body?.rateUnit || substituteProduct.rate_unit || '').trim() || null,
    reason: String(req.body?.reason || '').trim() || 'Inventory readiness substitution',
    approved_by: actor.id,
    approved_by_name: actor.name || actor.email || null,
    approved_at: new Date(),
    active: true,
    metadata: JSON.stringify({
      source: 'readiness_exception_resolution',
      originalProductName: originalProduct.name,
      substituteProductName: substituteProduct.name,
    }),
    updated_at: new Date(),
  };

  const [row] = await knex('lawn_protocol_product_substitutions')
    .insert(payload)
    .onConflict(['scheduled_service_id', 'original_product_id'])
    .merge({
      substitute_product_id: payload.substitute_product_id,
      rate_per_1000: payload.rate_per_1000,
      rate_unit: payload.rate_unit,
      reason: payload.reason,
      approved_by: payload.approved_by,
      approved_by_name: payload.approved_by_name,
      approved_at: payload.approved_at,
      active: true,
      metadata: payload.metadata,
      updated_at: payload.updated_at,
    })
    .returning('*');

  return {
    ...row,
    originalProductName: originalProduct.name,
    substituteProductName: substituteProduct.name,
  };
}

async function createRestockRequest(knex, req, serviceId) {
  if (!(await knex.schema.hasTable('product_restock_requests'))) {
    const err = new Error('Restock request table is not available. Run database migrations first.');
    err.statusCode = 409;
    throw err;
  }
  const productId = String(req.body?.productId || '').trim();
  if (!productId) {
    const err = new Error('Product is required.');
    err.statusCode = 400;
    throw err;
  }
  const [service, product] = await Promise.all([
    knex('scheduled_services').where({ id: serviceId }).first(),
    knex('products_catalog').where({ id: productId }).first(),
  ]);
  if (!service) {
    const err = new Error('Scheduled service not found.');
    err.statusCode = 404;
    throw err;
  }
  if (!product) {
    const err = new Error('Product not found.');
    err.statusCode = 400;
    throw err;
  }
  const actor = actorFromRequest(req);
  const currentStock = numberOrNull(product.inventory_on_hand);
  const lowStock = numberOrNull(product.low_stock_threshold);
  const targetStock = numberOrNull(req.body?.targetStock) ?? (lowStock != null ? lowStock * 2 : null);
  const requestedQuantity = numberOrNull(req.body?.requestedQuantity)
    ?? (targetStock != null && currentStock != null ? Math.max(0, targetStock - currentStock) : null);
  const [row] = await knex('product_restock_requests').insert({
    product_id: product.id,
    scheduled_service_id: service.id,
    customer_id: service.customer_id || null,
    status: 'open',
    priority: req.body?.priority || 'high',
    requested_quantity: requestedQuantity,
    unit: String(req.body?.unit || product.inventory_unit || product.rate_unit || '').trim() || null,
    current_stock: currentStock,
    target_stock: targetStock,
    vendor: String(req.body?.vendor || product.best_vendor || '').trim() || null,
    needed_by: req.body?.neededBy ? String(req.body.neededBy).slice(0, 10) : service.scheduled_date || null,
    reason: String(req.body?.reason || '').trim() || `Restock needed for WaveGuard readiness: ${product.name}`,
    source: 'lawn_readiness_exception',
    created_by: actor.id,
    created_by_name: actor.name || actor.email || null,
    metadata: JSON.stringify({
      serviceType: service.service_type || null,
      scheduledDate: service.scheduled_date || null,
      issueCode: req.body?.issueCode || null,
    }),
  }).returning('*');
  return {
    ...row,
    productName: product.name,
    productCategory: product.category || null,
  };
}

function actorFromRequest(req) {
  return {
    id: req.technicianId || req.technician?.id || null,
    name: req.technician?.name || req.technician?.full_name || req.technician?.email || null,
    email: req.technician?.email || null,
  };
}

function normalizeAuditSnapshot(row) {
  if (!row) return {};
  const out = { ...row };
  delete out.created_at;
  delete out.updated_at;
  return out;
}

function changedFields(before, after) {
  const beforeSnap = normalizeAuditSnapshot(before);
  const afterSnap = normalizeAuditSnapshot(after);
  return Object.keys(afterSnap).filter((key) => {
    if (!(key in beforeSnap)) return true;
    return JSON.stringify(beforeSnap[key]) !== JSON.stringify(afterSnap[key]);
  });
}

async function logProtocolAudit(trx, req, {
  protocolId,
  entityType,
  entityId,
  action,
  before,
  after,
  metadata = {},
}) {
  const fields = changedFields(before, after);
  if (!fields.length && action === 'update') return null;
  const actor = actorFromRequest(req);
  const [row] = await trx('lawn_protocol_audit_log').insert({
    lawn_protocol_id: protocolId || null,
    actor_technician_id: actor.id,
    actor_name: actor.name,
    actor_email: actor.email,
    entity_type: entityType,
    entity_id: entityId,
    action,
    changed_fields: JSON.stringify(fields),
    before_snapshot: JSON.stringify(normalizeAuditSnapshot(before)),
    after_snapshot: JSON.stringify(normalizeAuditSnapshot(after)),
    metadata: JSON.stringify(metadata),
  }).returning('*');
  return row;
}

async function cloneProtocolDraft(trx, active, req) {
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const versionBase = `${active.version}-draft-${stamp}`;
  let version = versionBase;
  let suffix = 1;
  while (await trx('lawn_protocols').where({ protocol_key: active.protocol_key, version }).first()) {
    suffix += 1;
    version = `${versionBase}-${suffix}`;
  }

  const [draft] = await trx('lawn_protocols').insert({
    protocol_key: active.protocol_key,
    version,
    name: active.name,
    region: active.region,
    grass_track: active.grass_track,
    status: 'draft',
    effective_from: active.effective_from,
    effective_to: null,
    operating_sentence: active.operating_sentence,
    default_carriers: JSON.stringify(active.default_carriers || {}),
    production_rules: JSON.stringify(active.production_rules || {}),
    required_profile_fields: JSON.stringify(active.required_profile_fields || []),
    source_refs: JSON.stringify(active.source_refs || []),
  }).returning('*');

  const windows = await trx('lawn_protocol_windows')
    .where({ lawn_protocol_id: active.id })
    .orderBy('sort_order', 'asc');
  const windowIdByOldId = new Map();
  for (const win of windows) {
    const [newWin] = await trx('lawn_protocol_windows').insert({
      lawn_protocol_id: draft.id,
      month: win.month,
      window_key: win.window_key,
      title: win.title,
      visit_type: win.visit_type,
      goal: win.goal,
      default_carrier_gal_per_1000: win.default_carrier_gal_per_1000,
      production_mode: win.production_mode,
      main_tank: JSON.stringify(win.main_tank || {}),
      spot_work: JSON.stringify(win.spot_work || []),
      required_tasks: JSON.stringify(win.required_tasks || []),
      conditional_triggers: JSON.stringify(win.conditional_triggers || []),
      customer_note_templates: JSON.stringify(win.customer_note_templates || []),
      service_report_context: JSON.stringify(win.service_report_context || {}),
      assessment_bridge: JSON.stringify(win.assessment_bridge || {}),
      inventory_bridge: JSON.stringify(win.inventory_bridge || {}),
      wiki_refs: JSON.stringify(win.wiki_refs || []),
      sort_order: win.sort_order,
    }).returning('*');
    windowIdByOldId.set(String(win.id), newWin.id);
  }

  const products = await trx('lawn_protocol_products')
    .whereIn('lawn_protocol_window_id', Array.from(windowIdByOldId.keys()));
  for (const product of products) {
    await trx('lawn_protocol_products').insert({
      lawn_protocol_window_id: windowIdByOldId.get(String(product.lawn_protocol_window_id)),
      product_id: product.product_id,
      product_name: product.product_name,
      role: product.role,
      application_mode: product.application_mode,
      rate_per_1000: product.rate_per_1000,
      rate_unit: product.rate_unit,
      carrier_gal_per_1000: product.carrier_gal_per_1000,
      default_in_plan: product.default_in_plan,
      gates: JSON.stringify(product.gates || {}),
      annual_counter: JSON.stringify(product.annual_counter || {}),
      mixing: JSON.stringify(product.mixing || {}),
      report_copy: JSON.stringify(product.report_copy || {}),
      sort_order: product.sort_order,
    });
  }

  const gates = await trx('lawn_protocol_gates').where({ lawn_protocol_id: active.id });
  for (const gate of gates) {
    await trx('lawn_protocol_gates').insert({
      lawn_protocol_id: draft.id,
      gate_key: gate.gate_key,
      gate_type: gate.gate_type,
      severity: gate.severity,
      title: gate.title,
      rule_text: gate.rule_text,
      logic: JSON.stringify(gate.logic || {}),
      wiki_refs: JSON.stringify(gate.wiki_refs || []),
    });
  }

  await logProtocolAudit(trx, req, {
    protocolId: draft.id,
    entityType: 'protocol',
    entityId: draft.id,
    action: 'clone_draft',
    before: active,
    after: draft,
    metadata: { sourceProtocolId: active.id },
  });

  return draft;
}

function addPublishIssue(issues, severity, code, message, metadata = {}) {
  issues.push({ severity, code, message, metadata });
}

function defaultProductStockPublishIssue(status, { product = {}, catalog = {}, window = {} } = {}) {
  const metadata = {
    windowKey: window?.window_key || null,
    productId: product.id,
    catalogProductId: catalog.id,
    onHand: catalog.inventory_on_hand,
    lowStockThreshold: catalog.low_stock_threshold,
    unit: catalog.inventory_unit,
  };

  if (status === 'depleted') {
    return {
      severity: 'block',
      code: 'depleted_default_product',
      message: `${catalog.name} is depleted and is required by the draft.`,
      metadata,
    };
  }

  if (status === 'low') {
    return {
      severity: 'block',
      code: 'low_stock_default_product',
      message: `${catalog.name} is low stock and is required by the draft.`,
      metadata,
    };
  }

  return null;
}

async function validateLawnProtocolForPublish(knex, protocolId) {
  const protocol = await knex('lawn_protocols').where({ id: protocolId }).first();
  if (!protocol) {
    return {
      canPublish: false,
      issues: [{ severity: 'block', code: 'protocol_not_found', message: 'Protocol not found.', metadata: {} }],
      counts: { block: 1, warn: 0, info: 0 },
    };
  }

  const issues = [];
  const [windows, gates] = await Promise.all([
    knex('lawn_protocol_windows').where({ lawn_protocol_id: protocol.id }).orderBy('month', 'asc'),
    knex('lawn_protocol_gates').where({ lawn_protocol_id: protocol.id }).orderBy('gate_key', 'asc'),
  ]);

  if (!windows.length) {
    addPublishIssue(issues, 'block', 'no_windows', 'Protocol has no monthly windows.');
  }

  const products = windows.length
    ? await knex('lawn_protocol_products')
      .whereIn('lawn_protocol_window_id', windows.map((window) => window.id))
      .orderBy('sort_order', 'asc')
    : [];
  const productIds = products.map((product) => product.product_id).filter(Boolean);
  const catalogRows = productIds.length
    ? await knex('products_catalog')
      .whereIn('id', productIds)
      .select('id', 'name', 'inventory_on_hand', 'inventory_unit', 'low_stock_threshold')
      .catch(() => [])
    : [];
  const catalogById = new Map(catalogRows.map((row) => [String(row.id), row]));
  const windowById = new Map(windows.map((window) => [String(window.id), window]));

  for (const window of windows) {
    if (!Array.isArray(window.wiki_refs) || !window.wiki_refs.length) {
      addPublishIssue(issues, 'block', 'missing_window_sop_refs', `${window.title} is missing wiki/SOP references.`, {
        windowKey: window.window_key,
      });
    }
    if (!Array.isArray(window.required_tasks) || !window.required_tasks.length) {
      addPublishIssue(issues, 'warn', 'missing_required_tasks', `${window.title} has no required closeout tasks.`, {
        windowKey: window.window_key,
      });
    }
  }

  for (const product of products) {
    const window = windowById.get(String(product.lawn_protocol_window_id));
    if (product.default_in_plan && !product.product_id) {
      addPublishIssue(issues, 'block', 'unmapped_default_product', `${product.product_name} is a default product but is not mapped to inventory.`, {
        windowKey: window?.window_key || null,
        productId: product.id,
      });
      continue;
    }
    if (product.default_in_plan && product.product_id) {
      const catalog = catalogById.get(String(product.product_id));
      if (!catalog) {
        addPublishIssue(issues, 'block', 'missing_catalog_product', `${product.product_name} maps to a missing catalog product.`, {
          windowKey: window?.window_key || null,
          productId: product.id,
          catalogProductId: product.product_id,
        });
        continue;
      }
      const status = stockStatusForProduct(catalog);
      const stockIssue = defaultProductStockPublishIssue(status, { product, catalog, window });
      if (stockIssue) {
        addPublishIssue(issues, stockIssue.severity, stockIssue.code, stockIssue.message, stockIssue.metadata);
      }
    }
  }

  if (!gates.length) {
    addPublishIssue(issues, 'block', 'no_gates', 'Protocol has no enforcement gates.');
  }
  for (const gate of gates) {
    if (!gate.title || !gate.rule_text) {
      addPublishIssue(issues, 'block', 'incomplete_gate', `${gate.gate_key} is missing title or rule text.`, {
        gateKey: gate.gate_key,
      });
    }
    if (!gate.logic || typeof gate.logic !== 'object' || Array.isArray(gate.logic)) {
      addPublishIssue(issues, 'block', 'invalid_gate_logic', `${gate.gate_key} has invalid logic JSON.`, {
        gateKey: gate.gate_key,
      });
    }
    if (!Array.isArray(gate.wiki_refs) || !gate.wiki_refs.length) {
      addPublishIssue(issues, 'warn', 'missing_gate_sop_refs', `${gate.gate_key} has no wiki/SOP references.`, {
        gateKey: gate.gate_key,
      });
    }
  }

  const counts = issues.reduce((acc, issue) => {
    acc[issue.severity] = (acc[issue.severity] || 0) + 1;
    return acc;
  }, { block: 0, warn: 0, info: 0 });
  return {
    canPublish: counts.block === 0,
    issues,
    counts,
  };
}

function buildCompletionActions({ lines, products, programKey, visit }) {
  // De-branded pest visits keep primary/secondary as plain strings (so every
  // existing string consumer — protocol UI tabs, /match — still works) and
  // carry per-line metadata here, keyed by the exact de-branded line text.
  const lineMeta = (visit && typeof visit.lineMeta === 'object' && visit.lineMeta) || {};
  return lines.map((line, index) => {
    const meta = lineMeta[line.raw] || null;
    // Feed the catalog matcher the brand hints (the display text is de-branded),
    // so the right product still attaches.
    const lineForMatch = meta && Array.isArray(meta.catalogProductHints)
      ? { ...line, catalogProductHints: meta.catalogProductHints }
      : line;
    const product = matchCatalogProduct(lineForMatch, products);
    const kind = actionKindForLine(line, product);
    // De-branded lines (have lineMeta) display their own text — do NOT run
    // actionLabel, which appends the matched product's brand name and re-leaks
    // it. Product stays attached below for selection/material tracking.
    const label = meta ? line.raw : actionLabel(kind, line, product);
    return {
      id: `${programKey || 'protocol'}_${visit?.visit || 'visit'}_${index}`,
      kind,
      label,
      note: label,
      raw: line.raw,
      role: line.role,
      conditional: !!line.conditional,
      // Prefer explicit metadata; fall back to the keyword classifier for legacy lines.
      scope: meta?.scope || actionScopeForLine(line, product),
      treatmentApplied: meta?.treatmentApplied != null ? meta.treatmentApplied : actionTreatmentApplied(kind, line),
      product: serializeProtocolProduct(product),
    };
  });
}

async function getProtocolProducts() {
  const products = await db('products_catalog')
    .where(function () {
      this.where({ active: true }).orWhereNull('active');
    })
    .select(
      'id', 'name', 'category', 'active_ingredient', 'moa_group',
      'frac_group', 'irac_group', 'hrac_group',
      'analysis_n', 'analysis_p', 'analysis_k',
      'default_rate_per_1000', 'rate_unit',
      'best_price', 'cost_per_unit', 'cost_unit', 'container_size', 'unit_size_oz', 'needs_pricing',
      'mixing_order_category', 'mixing_instructions',
      'label_verified_at', 'rainfast_minutes', 'rei_hours',
      'labeled_turf_species', 'excluded_turf_species',
      'requires_surfactant', 'allows_surfactant',
      'label_source_note', 'label_url', 'sds_url', 'epa_reg_number', 'manufacturer',
    )
    .catch(() => []);

  if (!products.length) return products;

  // Protocol lines reference products by shorthand ("High Mn Combo",
  // "Three-Way") that only resolves through product_aliases; matching
  // without them leaves most shorthand lines unmatched.
  const productIds = products.map((product) => product.id).filter(Boolean);
  const aliases = productIds.length
    ? await db('product_aliases')
      .whereIn('product_id', productIds)
      .select('product_id', 'alias_name')
      .catch(() => [])
    : [];
  const aliasesByProduct = aliases.reduce((acc, row) => {
    if (!acc[row.product_id]) acc[row.product_id] = [];
    acc[row.product_id].push(row.alias_name);
    return acc;
  }, {});

  return products.map((product) => ({
    ...product,
    aliases: aliasesByProduct[product.id] || [],
  }));
}

async function getActiveCalibration(equipmentSystemId) {
  const query = db('equipment_calibrations as ec')
    .join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
    .where('ec.active', true)
    .where('es.active', true)
    .select(
      'ec.*',
      'es.name as system_name',
      'es.system_type',
      'es.tank_capacity_gal',
      'es.default_application_type',
    )
    .orderByRaw("case when es.name ilike '110-Gallon Spray Tank #1%' then 0 when es.system_type = 'tank' then 1 else 2 end")
    .orderBy('es.name', 'asc');

  if (equipmentSystemId) query.where('ec.equipment_system_id', equipmentSystemId);
  return query.first().catch(() => null);
}

// GET /api/admin/protocols/photos/relevant — context-aware photo references
router.get('/photos/relevant', async (req, res, next) => {
  try {
    const { serviceType, grassType, month } = req.query;
    const currentMonth = month ? parseInt(month) : new Date().getMonth() + 1;

    let query = db('protocol_photos').where({ active: true });

    if (serviceType) {
      const line = (serviceType.toLowerCase().includes('lawn') || serviceType.toLowerCase().includes('turf')) ? 'lawn'
        : serviceType.toLowerCase().includes('tree') || serviceType.toLowerCase().includes('shrub') ? 'tree_shrub'
        : serviceType.toLowerCase().includes('pest') ? 'pest'
        : serviceType.toLowerCase().includes('mosquito') ? 'mosquito'
        : serviceType.toLowerCase().includes('termite') ? 'termite' : null;
      if (line) query = query.whereRaw("service_lines::text ILIKE ?", [`%${line}%`]);
    }

    const photos = await query.orderBy('sort_order');

    // Filter by month relevance
    const filtered = photos.filter(p => {
      const months = typeof p.months_relevant === 'string' ? JSON.parse(p.months_relevant) : p.months_relevant;
      if (!months || !Array.isArray(months)) return true;
      return months.includes(currentMonth);
    });

    res.json({ photos: filtered.map(p => ({
      id: p.id, category: p.category, name: p.name, description: p.description,
      photoUrl: p.photo_url, tags: p.tags, serviceLine: p.service_lines,
    }))});
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/photos — all photos
router.get('/photos', async (req, res, next) => {
  try {
    const { category, tag } = req.query;
    let query = db('protocol_photos').where({ active: true }).orderBy('category').orderBy('sort_order');
    if (category) query = query.where({ category });
    if (tag) query = query.whereRaw("tags::text ILIKE ?", [`%${tag}%`]);
    const photos = await query;
    res.json({ photos });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/seasonal-index
router.get('/seasonal-index', async (req, res, next) => {
  try {
    const month = parseInt(req.query.month || new Date().getMonth() + 1);
    const { service_line } = req.query;
    let query = db('seasonal_pest_index').where({ month });
    if (service_line) query = query.where({ service_line });
    const index = await query.orderBy('sort_order');
    res.json({ month, pests: index });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/scripts
router.get('/scripts', async (req, res, next) => {
  try {
    const { scenario, service_line } = req.query;
    let query = db('communication_scripts').where({ active: true });
    if (scenario) query = query.where({ scenario });
    if (service_line) query = query.where(function () { this.where({ service_line }).orWhere({ service_line: 'general' }); });
    const scripts = await query.orderBy('sort_order');
    res.json({ scripts });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/equipment
router.get('/equipment', async (req, res, next) => {
  try {
    const { service_type, service_line } = req.query;
    let query = db('equipment_checklists');
    if (service_line) query = query.where({ service_line });
    if (service_type) query = query.whereILike('service_type', `%${service_type}%`);
    const checklists = await query;
    res.json({ checklists: checklists.map(c => ({
      ...c, checklist_items: typeof c.checklist_items === 'string' ? JSON.parse(c.checklist_items) : c.checklist_items,
    }))});
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/match — best service template plus full program fallback.
router.get('/match', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const serviceType = req.query.serviceType || req.query.service_type || '';
    const result = matchServiceProtocol(protocols, serviceType);

    if (!result.program) return res.status(404).json({ error: 'Protocol program not found' });

    res.json({
      serviceType,
      programKey: result.programKey,
      program: result.program,
      matchedVisit: result.matchedVisit,
      matched: result.matched,
      reason: result.reason,
    });
  } catch (err) { next(err); }
});

// Protocol visit text mixes product applications with scout/task/expectation
// lines that never resolve to a catalog row by design. Only unmatched lines
// carrying a "($N...)" cost tag — the protocol convention for a priced
// product application — indicate a real catalog/alias gap.
function isPricedProtocolLine(raw) {
  return /\(\s*\$\s*\d/.test(raw || '');
}

function unmatchedPricedProtocolLines(items) {
  return items
    .filter((item) => !item.matched && isPricedProtocolLine(item.raw))
    .map((item) => item.raw);
}

// GET /api/admin/protocols/lawn-mix — generic tech-facing protocol preview.
router.get('/lawn-mix', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const trackKey = TRACK_MAP[req.query.track] || req.query.track || 'st_augustine';
    const track = protocols.lawn?.[trackKey];
    if (!track) return res.status(404).json({ error: 'Lawn protocol track not found' });

    const month = monthAbbr(req.query.month);
    const visit = track.visits?.find((v) => v.month === month);
    if (!visit) return res.status(404).json({ error: 'Protocol visit not found for month' });

    const areaSqft = Math.max(0, Number(req.query.lawnSqft || 10000));
    const calibration = await getActiveCalibration(req.query.equipmentSystemId || null);
    const calibrationExpired = !!(
      calibration?.expires_at && new Date(calibration.expires_at) < new Date()
    );
    const products = await getProtocolProducts();
    const baseLines = parseProtocolLines(visit.primary, 'base');
    const conditionalLines = parseProtocolLines(visit.secondary, 'conditional');
    const allLines = [...baseLines, ...conditionalLines];
    const nutrientTargets = parseVisitNutrientTargets(visit.notes);

    const resolvedLines = resolveProtocolItems(allLines, products, {
      selectedConditionalProductIds: req.query.selectedConditionalProductIds,
      selectedConditionalProductNames: req.query.selectedConditionalProductNames,
      selectedConditionalRaw: req.query.selectedConditionalRaw,
      soilPIndex: req.query.soilPIndex,
      plan: req.query.plan,
      conditionFlags: req.query.conditionFlags,
      propertyFlags: req.query.propertyFlags,
      includePremiumOnly: req.query.includePremiumOnly === 'true',
    });

    const items = resolvedLines.map((line) => {
      const product = line.product;
      const selected = line.selected;
      const carrier = calibrationExpired ? 0 : Number(calibration?.carrier_gal_per_1000 || 0);
      const areaContext = {
        plan: req.query.plan,
        weedPressure: req.query.weedPressure,
        conditionFlags: req.query.conditionFlags,
        propertyFlags: req.query.propertyFlags,
        includePremiumOnly: req.query.includePremiumOnly === 'true',
        isFirstYear: req.query.isFirstYear == null ? undefined : req.query.isFirstYear !== 'false',
      };
      const areaFactor = effectiveAreaFactor(line, areaContext);
      const jobMix = selected && product && carrier
        ? calculateProductAmount({ product, lawnSqft: areaSqft, carrierGalPer1000: carrier, areaFactor, ...nutrientTargets })
        : null;
      // plannedMix mirrors jobMix for unselected conditionals: the mix a tech
      // would put down if the line's trigger fired (rescue threshold met,
      // premium add-on taken). Inspection/scout lines keep a zero factor so a
      // "SKIP" or audit line never shows product math. jobMix stays
      // selected-only — it alone feeds the material-cost summary.
      const plannedAreaFactor = selected
        ? areaFactor
        : effectiveAreaFactor({ ...line, selected: true }, { ...areaContext, includePremiumOnly: true });
      const plannedMix = jobMix || (product && carrier && plannedAreaFactor > 0
        ? calculateProductAmount({ product, lawnSqft: areaSqft, carrierGalPer1000: carrier, areaFactor: plannedAreaFactor, ...nutrientTargets })
        : null);
      const tankCapacity = Number(calibration?.tank_capacity_gal || 0);
      const tankCoverageSqft = carrier && tankCapacity ? (tankCapacity / carrier) * 1000 : 0;
      const fullTankMix = selected && product && carrier && tankCoverageSqft
        ? calculateProductAmount({ product, lawnSqft: tankCoverageSqft, carrierGalPer1000: carrier, ...nutrientTargets })
        : null;
      const plannedFullTankMix = fullTankMix || (product && carrier && tankCoverageSqft && plannedAreaFactor > 0
        ? calculateProductAmount({ product, lawnSqft: tankCoverageSqft, carrierGalPer1000: carrier, ...nutrientTargets })
        : null);

      return {
        raw: line.raw,
        role: line.role,
        conditional: line.conditional,
        scope: line.scope,
        conditionFlag: line.conditionFlag,
        branchGroupId: line.branchGroupId,
        branch: line.branch || null,
        areaFactorDefault: line.areaFactorDefault,
        areaFactorClean: line.areaFactorClean,
        areaFactorHeavy: line.areaFactorHeavy,
        areaFactorBroadcast: line.areaFactorBroadcast,
        selectionReason: line.selectionReason,
        selected,
        matched: !!product,
        // Scout/task/expectation lines carry no "($N)" cost tag and never
        // resolve to a catalog row by design — flag them so the UI can render
        // them as tasks instead of alerting on a missing product match.
        taskLine: !product && !isPricedProtocolLine(line.raw),
        product: product ? {
          id: product.id,
          name: product.name,
          category: product.category,
          activeIngredient: product.active_ingredient,
          groups: {
            moa: product.moa_group || null,
            frac: product.frac_group || null,
            irac: product.irac_group || null,
            hrac: product.hrac_group || null,
          },
          labelVerifiedAt: product.label_verified_at || null,
          bestPrice: product.best_price != null ? Number(product.best_price) : null,
          costPerUnit: product.cost_per_unit != null ? Number(product.cost_per_unit) : null,
          costUnit: product.cost_unit || null,
          containerSize: product.container_size || null,
          unitSizeOz: product.unit_size_oz != null ? Number(product.unit_size_oz) : null,
          needsPricing: product.needs_pricing === true,
          rainfastMinutes: product.rainfast_minutes || null,
          reiHours: product.rei_hours || null,
          labeledTurfSpecies: product.labeled_turf_species || [],
          excludedTurfSpecies: product.excluded_turf_species || [],
          requiresSurfactant: product.requires_surfactant,
          allowsSurfactant: product.allows_surfactant,
          mixingOrderCategory: product.mixing_order_category,
          mixingInstructions: product.mixing_instructions,
          labelSourceNote: product.label_source_note,
          labelUrl: product.label_url || null,
          sdsUrl: product.sds_url || null,
          epaRegNumber: product.epa_reg_number || null,
          manufacturer: product.manufacturer || null,
        } : null,
        jobMix,
        fullTankMix,
        plannedMix,
        plannedFullTankMix,
      };
    });

    const selectedItems = items.filter((item) => item.selected);
    const materialCostSummary = summarizeMaterialCost(selectedItems.map((item) => ({
      selected: item.selected,
      product: item.product,
      mix: item.jobMix,
    })));
    const warnings = [];
    if (!calibration) {
      warnings.push({
        code: 'missing_calibration',
        message: 'No active calibration was found for the selected equipment. Mix amounts require a current carrier rate.',
      });
    }
    if (calibrationExpired) {
      warnings.push({
        code: 'expired_calibration',
        message: `Calibration for ${calibration.system_name || 'selected equipment'} is expired. Mix amounts are withheld until the rig is recalibrated.`,
      });
    }
    const unmatchedPricedLines = unmatchedPricedProtocolLines(items);
    if (unmatchedPricedLines.length) {
      warnings.push({
        code: 'unmatched_product',
        lines: unmatchedPricedLines,
        message: `${unmatchedPricedLines.length} priced protocol line${unmatchedPricedLines.length === 1 ? ' has' : 's have'} no product catalog match; label-rate math is unavailable for: ${unmatchedPricedLines.join(' | ')}`,
      });
    }

    res.json({
      track: { key: trackKey, name: track.name },
      month,
      visit: {
        visit: visit.visit,
        objective: visit.notes,
        primary: visit.primary,
        secondary: visit.secondary,
        tiers: visit.tiers,
      },
      equipment: calibration ? {
        equipmentSystemId: calibration.equipment_system_id,
        calibrationId: calibration.id,
        systemName: calibration.system_name,
        systemType: calibration.system_type,
        carrierGalPer1000: Number(calibration.carrier_gal_per_1000),
        tankCapacityGal: calibration.tank_capacity_gal ? Number(calibration.tank_capacity_gal) : null,
        tankCoverageSqft: calibration.tank_capacity_gal && calibration.carrier_gal_per_1000
          ? Math.round((Number(calibration.tank_capacity_gal) / Number(calibration.carrier_gal_per_1000)) * 1000)
          : null,
        expiresAt: calibration.expires_at || null,
      } : null,
      areaSqft,
      materialCostSummary,
      items,
      selectedItems,
      mixingOrder: buildMixOrder(selectedItems.map((item) => ({
        raw: item.raw,
        product: products.find((p) => String(p.id) === String(item.product?.id)) || null,
      }))),
      warnings,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/lawn/active — structured protocol operating layer.
router.get('/lawn/active', async (req, res, next) => {
  try {
    const protocol = await getActiveLawnProtocol(db, {
      grassTrack: req.query.grassTrack || req.query.grass_track || 'st_augustine',
      region: req.query.region || 'swfl',
      protocolKey: req.query.protocolKey || req.query.protocol_key || null,
    });
    if (!protocol) return res.status(404).json({ error: 'Active lawn protocol not found' });
    res.json({ protocol });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/lawn/window — month-specific bridge context for
// schedule cards, service reports, assessments, inventory, wiki links.
router.get('/lawn/window', async (req, res, next) => {
  try {
    const serviceDate = req.query.date ? dateOnlyToETNoon(req.query.date) : new Date();
    const context = await getProtocolWindowContext(db, {
      serviceDate,
      grassTrack: req.query.grassTrack || req.query.grass_track || 'st_augustine',
      region: req.query.region || 'swfl',
    });
    if (!context?.protocol) return res.status(404).json({ error: 'Active lawn protocol not found' });
    res.json({ context: summarizeProtocolContext(context) });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/completion-actions — targeted completion chips
// derived from the protocol program + matched product catalog rows.
router.get('/completion-actions', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const serviceType = req.query.serviceType || req.query.service_type || '';
    const products = await getProtocolProducts();
    let programKey;
    let program;
    let visit;
    let track = null;
    let month = null;

    if (normalizeText(serviceType).includes('lawn') || normalizeText(serviceType).includes('turf')) {
      programKey = 'lawn';
      track = lawnTrackFromInput(req.query.lawnType || req.query.grassType || req.query.track);
      program = protocols.lawn?.[track] || protocols.lawn?.st_augustine;
      month = monthAbbr(req.query.month);
      visit = program?.visits?.find((v) => v.month === month) || program?.visits?.[0] || null;
    } else {
      const matched = matchServiceProtocol(protocols, serviceType);
      programKey = matched.programKey;
      program = matched.program;
      visit = matched.matchedVisit || program?.visits?.[0] || null;
    }

    if (!program || !visit) return res.status(404).json({ error: 'Protocol actions not found' });

    const baseLines = parseProtocolLines(visit.primary, 'base');
    const conditionalLines = parseProtocolLines(visit.secondary, 'conditional');
    const actions = buildCompletionActions({
      lines: [...baseLines, ...conditionalLines],
      products,
      programKey,
      visit,
    });

    res.json({
      serviceType,
      programKey,
      track,
      month,
      programName: program.name,
      visit: {
        visit: visit.visit,
        month: visit.month,
        objective: visit.notes,
      },
      actions,
    });
  } catch (err) { next(err); }
});

// POST /api/admin/protocols/lawn/drafts — clone active protocol into editable draft.
router.post('/lawn/drafts', async (req, res, next) => {
  try {
    const draft = await db.transaction(async (trx) => {
      const active = await trx('lawn_protocols')
        .where({
          protocol_key: req.body.protocolKey || 'swfl_st_augustine_10_10',
          status: 'active',
        })
        .orderBy('effective_from', 'desc')
        .first();
      if (!active) {
        const err = new Error('Active lawn protocol not found');
        err.statusCode = 404;
        throw err;
      }
      return cloneProtocolDraft(trx, active, req);
    });
    res.status(201).json({ success: true, draft });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/protocols/lawn/drafts/:id/publish — promote draft to active protocol.
router.post('/lawn/drafts/:id/publish', async (req, res, next) => {
  try {
    const published = await db.transaction(async (trx) => {
      const draft = await trx('lawn_protocols').where({ id: req.params.id }).first();
      if (!draft) {
        const err = new Error('Draft protocol not found');
        err.statusCode = 404;
        throw err;
      }
      if (draft.status !== 'draft') {
        const err = new Error('Only draft protocols can be published');
        err.statusCode = 400;
        throw err;
      }
      const validation = await validateLawnProtocolForPublish(trx, draft.id);
      if (!validation.canPublish) {
        const err = new Error('Draft protocol failed publish validation');
        err.statusCode = 409;
        err.details = validation;
        throw err;
      }

      await trx('lawn_protocols')
        .where({ protocol_key: draft.protocol_key, status: 'active' })
        .update({ status: 'archived', effective_to: new Date(), updated_at: new Date() });

      const [row] = await trx('lawn_protocols')
        .where({ id: draft.id })
        .update({
          status: 'active',
          effective_from: req.body.effectiveFrom || new Date(),
          effective_to: null,
          updated_at: new Date(),
        })
        .returning('*');

      await logProtocolAudit(trx, req, {
        protocolId: row.id,
        entityType: 'protocol',
        entityId: row.id,
        action: 'publish',
        before: draft,
        after: row,
        metadata: { route: 'lawn/drafts/:id/publish' },
      });
      return row;
    });
    res.json({ success: true, protocol: published });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message, validation: err.details || null });
    next(err);
  }
});

// GET /api/admin/protocols/lawn/command-center — office operating view that
// bridges protocol, inventory, calibration, service reports, assessment, and wiki.
router.get('/lawn/command-center', async (req, res, next) => {
  try {
    const serviceDate = req.query.date ? dateOnlyToETNoon(req.query.date) : new Date();
    const protocolId = req.query.protocolId || null;
    const context = await getProtocolWindowContext(db, { serviceDate, protocolId });
    const structured = summarizeProtocolContext(context);
    if (!structured) return res.status(404).json({ error: 'Lawn protocol not found' });

    const productIds = (structured.products || []).map((p) => p.productId).filter(Boolean);
    const catalogRows = productIds.length
      ? await db('products_catalog')
        .whereIn('id', productIds)
        .select(
          'id',
          'name',
          'category',
          'active_ingredient',
          'best_vendor',
          'best_price',
          'inventory_on_hand',
          'inventory_unit',
          'low_stock_threshold',
          'label_verified_at',
          'label_url',
          'sds_url',
        )
        .catch(() => [])
      : [];
    const catalogById = new Map(catalogRows.map((row) => [String(row.id), row]));
    const products = (structured.products || []).map((product) => {
      const catalog = product.productId ? catalogById.get(String(product.productId)) : null;
      return {
        ...product,
        inventory: {
          mapped: !!catalog,
          status: stockStatusForProduct(catalog),
          onHand: catalog?.inventory_on_hand != null ? Number(catalog.inventory_on_hand) : null,
          unit: catalog?.inventory_unit || null,
          lowStockThreshold: catalog?.low_stock_threshold != null ? Number(catalog.low_stock_threshold) : null,
          bestVendor: catalog?.best_vendor || null,
          bestPrice: catalog?.best_price != null ? Number(catalog.best_price) : null,
          labelVerifiedAt: catalog?.label_verified_at || null,
          labelUrl: catalog?.label_url || null,
          sdsUrl: catalog?.sds_url || null,
        },
      };
    });

    const calibrations = await db('equipment_calibrations as ec')
      .join('equipment_systems as es', 'ec.equipment_system_id', 'es.id')
      .where('ec.active', true)
      .where('es.active', true)
      .whereIn('es.system_type', ['tank', 'backpack'])
      .select(
        'ec.id',
        'ec.equipment_system_id',
        'ec.carrier_gal_per_1000',
        'ec.pressure_psi',
        'ec.engine_rpm_setting',
        'ec.calibrated_at',
        'ec.expires_at',
        'es.name as system_name',
        'es.system_type',
        'es.tank_capacity_gal',
        'es.default_application_type',
      )
      .orderByRaw("case when es.system_type = 'tank' then 0 else 1 end")
      .orderBy('es.name', 'asc')
      .catch(() => []);

    let completionStats = {
      completions30d: 0,
      missingRequired30d: 0,
      skippedProducts30d: 0,
      recent: [],
    };
    if (await db.schema.hasTable('lawn_protocol_service_completions')) {
      const since = new Date();
      since.setDate(since.getDate() - 30);
      const [totalRow, missingRow] = await Promise.all([
        db('lawn_protocol_service_completions')
          .where('created_at', '>=', since)
          .count('id as count')
          .first(),
        db('lawn_protocol_service_completions')
          .where('created_at', '>=', since)
          .whereRaw("jsonb_array_length(coalesce(missing_required_tasks, '[]'::jsonb)) > 0")
          .count('id as count')
          .first()
          .catch(() => ({ count: 0 })),
      ]);
      const skippedRow = await db('lawn_protocol_product_actuals as lppa')
        .join('lawn_protocol_service_completions as lpsc', 'lppa.lawn_protocol_service_completion_id', 'lpsc.id')
        .where('lpsc.created_at', '>=', since)
        .where('lppa.status', 'skipped')
        .count('lppa.id as count')
        .first()
        .catch(() => ({ count: 0 }));
      const recent = await db('lawn_protocol_service_completions')
        .select('id', 'service_record_id', 'window_title', 'treated_sqft', 'carrier_gal_per_1000', 'missing_required_tasks', 'created_at')
        .orderBy('created_at', 'desc')
        .limit(5)
        .catch(() => []);
      completionStats = {
        completions30d: Number(totalRow?.count || 0),
        missingRequired30d: Number(missingRow?.count || 0),
        skippedProducts30d: Number(skippedRow?.count || 0),
        recent,
      };
    }

    const recentAudit = await db('lawn_protocol_audit_log')
      .where({ lawn_protocol_id: context.protocol.id })
      .orderBy('created_at', 'desc')
      .limit(20)
      .select(
        'id',
        'entity_type',
        'entity_id',
        'action',
        'changed_fields',
        'actor_name',
        'actor_email',
        'created_at',
        'metadata',
      )
      .catch(() => []);

    const drafts = await db('lawn_protocols')
      .where({ protocol_key: context.protocol.protocol_key, status: 'draft' })
      .orderBy('updated_at', 'desc')
      .select('id', 'version', 'name', 'updated_at', 'created_at')
      .catch(() => []);
    const wikiPages = await loadProtocolWikiPages(db, context.protocol, structured.window);
    const readinessQueue = await buildReadinessQueue(db).catch(() => ({
      days: 14,
      statusCounts: { ready: 0, warning: 0, blocked: 0 },
      appointments: [],
    }));
    const readinessSnapshots = await loadReadinessSnapshotSummary(db).catch(() => ({ last: null, recent: [] }));
    const publishValidation = await validateLawnProtocolForPublish(db, context.protocol.id).catch(() => ({
      canPublish: false,
      issues: [{ severity: 'block', code: 'validation_error', message: 'Publish validation could not be completed.', metadata: {} }],
      counts: { block: 1, warn: 0, info: 0 },
    }));

    res.json({
      protocol: {
        ...structured,
        products,
      },
      health: {
        requiredProfileFields: context.protocol.required_profile_fields || [],
        lowStockProducts: products.filter((p) => ['low', 'depleted'].includes(p.inventory?.status)).length,
        depletedStockProducts: products.filter((p) => p.inventory?.status === 'depleted').length,
        unmappedProducts: products.filter((p) => !p.inventory?.mapped).length,
        activeCalibrations: calibrations.length,
        expiredCalibrations: calibrations.filter((row) => row.expires_at && new Date(row.expires_at) < new Date()).length,
      },
      calibrations,
      completionStats,
      recentAudit,
      drafts,
      wikiPages,
      readinessQueue,
      readinessSnapshots,
      publishValidation,
      bridges: {
        fieldExecution: [
          bridgeLink('/admin/dispatch?tab=schedule', 'Appointments', 'Protocol closeout checklist is enforced on lawn appointments.'),
          bridgeLink('/admin/equipment?tab=calibrations', 'Calibration', 'Keep tank and backpack carrier rates current.'),
          bridgeLink('/admin/lawn-assessment', 'Lawn Assessment', 'Capture turf, irrigation, thatch, pest, disease, and chronic decline inputs.'),
        ],
        officeControl: [
          bridgeLink('/admin/inventory?tab=protocols', 'Inventory Protocols', 'Map products, cost, stock, labels, and reorder status.'),
          bridgeLink('/admin/knowledge', 'Wiki', 'Keep crew SOP and seasonal field notes current.'),
          bridgeLink('/admin/kb', 'Knowledge Base', 'Link outcomes, customer notes, and assessment recommendations.'),
        ],
        reporting: [
          bridgeLink('/admin/dispatch?tab=board', 'Service Reports', 'Report context is generated from the active protocol window.'),
          bridgeLink('/admin/compliance', 'Compliance', 'Review ordinance, product, and annual-rate audit risks.'),
        ],
      },
    });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/lawn/readiness — upcoming WaveGuard lawn appointment readiness queue.
router.get('/lawn/readiness', async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(60, Number(req.query.days || 14)));
    const limit = Math.max(1, Math.min(200, Number(req.query.limit || 75)));
    const readinessQueue = await buildReadinessQueue(db, { days, limit });
    const readinessSnapshots = await loadReadinessSnapshotSummary(db);
    res.json({ readinessQueue, readinessSnapshots });
  } catch (err) { next(err); }
});

// POST /api/admin/protocols/lawn/readiness/snapshot — store a scan and raise an admin alert when blocked rows exist.
router.post('/lawn/readiness/snapshot', async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(60, Number(req.body?.days || req.query.days || 14)));
    const limit = Math.max(1, Math.min(200, Number(req.body?.limit || req.query.limit || 75)));
    const result = await createReadinessSnapshot(db, req, { days, limit });
    res.json({ success: true, ...result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/protocols/lawn/readiness/bulk-assign — assign safe upcoming rows.
router.post('/lawn/readiness/bulk-assign', async (req, res, next) => {
  try {
    const days = Math.max(1, Math.min(60, Number(req.body?.days || req.query.days || 14)));
    const limit = Math.max(1, Math.min(200, Number(req.body?.limit || req.query.limit || 75)));
    const result = await bulkAssignReadyAppointments(db, req, { days, limit });
    const readinessQueue = await buildReadinessQueue(db, { days, limit });
    const readinessSnapshots = await loadReadinessSnapshotSummary(db);
    res.json({ success: true, ...result, readinessQueue, readinessSnapshots });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/lawn/substitution-products — searchable catalog for appointment-level substitutions.
router.get('/lawn/substitution-products', async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim();
    const rows = await db('products_catalog')
      .where(function activeProducts() {
        this.where({ active: true }).orWhereNull('active');
      })
      .modify((query) => {
        if (q) {
          query.where(function searchProducts() {
            this.whereILike('name', `%${q}%`)
              .orWhereILike('category', `%${q}%`)
              .orWhereILike('active_ingredient', `%${q}%`);
          });
        }
      })
      .select(
        'id',
        'name',
        'category',
        'active_ingredient',
        'default_rate_per_1000',
        'rate_unit',
        'inventory_on_hand',
        'inventory_unit',
        'low_stock_threshold',
      )
      .orderBy('name', 'asc')
      .limit(30);
    res.json({
      products: rows.map((row) => ({
        id: row.id,
        name: row.name,
        category: row.category,
        activeIngredient: row.active_ingredient,
        defaultRatePer1000: row.default_rate_per_1000 != null ? Number(row.default_rate_per_1000) : null,
        rateUnit: row.rate_unit || null,
        inventoryOnHand: row.inventory_on_hand != null ? Number(row.inventory_on_hand) : null,
        inventoryUnit: row.inventory_unit || null,
        lowStockThreshold: row.low_stock_threshold != null ? Number(row.low_stock_threshold) : null,
      })),
    });
  } catch (err) { next(err); }
});

// POST /api/admin/protocols/lawn/readiness/:serviceId/substitutions — approve an appointment-level product substitute.
router.post('/lawn/readiness/:serviceId/substitutions', async (req, res, next) => {
  try {
    const substitution = await createProductSubstitution(db, req, req.params.serviceId);
    const days = Math.max(1, Math.min(60, Number(req.body?.days || req.query.days || 14)));
    const readinessQueue = await buildReadinessQueue(db, { days, limit: 75 });
    const readinessSnapshots = await loadReadinessSnapshotSummary(db);
    res.json({ success: true, substitution, readinessQueue, readinessSnapshots });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/protocols/lawn/readiness/:serviceId/restock-requests — create a product restock request from readiness.
router.post('/lawn/readiness/:serviceId/restock-requests', async (req, res, next) => {
  try {
    const restockRequest = await createRestockRequest(db, req, req.params.serviceId);
    const days = Math.max(1, Math.min(60, Number(req.body?.days || req.query.days || 14)));
    const readinessQueue = await buildReadinessQueue(db, { days, limit: 75 });
    const readinessSnapshots = await loadReadinessSnapshotSummary(db);
    res.json({ success: true, restockRequest, readinessQueue, readinessSnapshots });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// POST /api/admin/protocols/lawn/readiness/:serviceId/assign — assign one readiness row.
router.post('/lawn/readiness/:serviceId/assign', async (req, res, next) => {
  try {
    const result = await assignReadinessAppointment(db, req, req.params.serviceId);
    const days = Math.max(1, Math.min(60, Number(req.body?.days || req.query.days || 14)));
    const readinessQueue = await buildReadinessQueue(db, { days, limit: 75 });
    const readinessSnapshots = await loadReadinessSnapshotSummary(db);
    res.json({ success: true, result, readinessQueue, readinessSnapshots });
  } catch (err) {
    if (err.statusCode) {
      return res.status(err.statusCode).json({
        error: err.message,
        code: err.code || 'readiness_assign_failed',
        details: err.details || null,
      });
    }
    next(err);
  }
});

// PUT /api/admin/protocols/lawn/products/:id — map/edit a protocol product row.
router.put('/lawn/products/:id', async (req, res, next) => {
  try {
    const existing = await db('lawn_protocol_products').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Protocol product not found' });
    const existingWindow = await db('lawn_protocol_windows').where({ id: existing.lawn_protocol_window_id }).first();
    const existingProtocol = existingWindow
      ? await db('lawn_protocols').where({ id: existingWindow.lawn_protocol_id }).first()
      : null;
    if (existingProtocol?.status !== 'draft') {
      return res.status(409).json({ error: 'Create or select a draft before editing protocol products' });
    }

    const updates = { updated_at: new Date() };
    if (req.body.productId !== undefined) {
      if (req.body.productId === '' || req.body.productId === null) {
        updates.product_id = null;
      } else {
        const product = await db('products_catalog').where({ id: req.body.productId }).first();
        if (!product) return res.status(400).json({ error: 'Catalog product not found' });
        updates.product_id = product.id;
        if (req.body.syncName !== false) updates.product_name = product.name;
      }
    }
    if (req.body.productName !== undefined) updates.product_name = String(req.body.productName || '').trim() || existing.product_name;
    if (req.body.role !== undefined) updates.role = String(req.body.role || '').trim() || existing.role;
    if (req.body.applicationMode !== undefined) updates.application_mode = String(req.body.applicationMode || '').trim() || existing.application_mode;
    if (req.body.ratePer1000 !== undefined) updates.rate_per_1000 = numberOrNull(req.body.ratePer1000);
    if (req.body.rateUnit !== undefined) updates.rate_unit = String(req.body.rateUnit || '').trim() || null;
    if (req.body.carrierGalPer1000 !== undefined) updates.carrier_gal_per_1000 = numberOrNull(req.body.carrierGalPer1000);
    if (req.body.defaultInPlan !== undefined) updates.default_in_plan = !!req.body.defaultInPlan;
    if (req.body.gates !== undefined && typeof req.body.gates === 'object') updates.gates = JSON.stringify(req.body.gates || {});
    if (req.body.mixing !== undefined && typeof req.body.mixing === 'object') updates.mixing = JSON.stringify(req.body.mixing || {});
    if (req.body.reportCopy !== undefined && typeof req.body.reportCopy === 'object') updates.report_copy = JSON.stringify(req.body.reportCopy || {});

    const [updated] = await db.transaction(async (trx) => {
      const [row] = await trx('lawn_protocol_products')
        .where({ id: existing.id })
        .update(updates)
        .returning('*');
      await logProtocolAudit(trx, req, {
        protocolId: existingProtocol.id,
        entityType: 'product',
        entityId: row.id,
        action: 'update',
        before: existing,
        after: row,
        metadata: { route: 'lawn/products/:id', windowKey: existingWindow?.window_key || null },
      });
      return [row];
    });
    res.json({ success: true, product: updated });
  } catch (err) { next(err); }
});

// PUT /api/admin/protocols/lawn/windows/:windowKey — update current SOP/wiki bridge fields.
router.put('/lawn/windows/:windowKey', async (req, res, next) => {
  try {
    const protocolQuery = db('lawn_protocols').orderBy('effective_from', 'desc');
    if (req.body.protocolId) {
      protocolQuery.where({ id: req.body.protocolId });
    } else {
      protocolQuery.where({
        status: 'active',
        protocol_key: req.body.protocolKey || 'swfl_st_augustine_10_10',
      });
    }
    const protocol = await protocolQuery.first();
    if (!protocol) return res.status(404).json({ error: 'Lawn protocol not found' });
    if (protocol.status !== 'draft') {
      return res.status(409).json({ error: 'Create or select a draft before editing protocol windows' });
    }

    const existing = await db('lawn_protocol_windows')
      .where({ lawn_protocol_id: protocol.id, window_key: req.params.windowKey })
      .first();
    if (!existing) return res.status(404).json({ error: 'Protocol window not found' });

    const updates = { updated_at: new Date() };
    if (req.body.wikiRefs !== undefined) updates.wiki_refs = JSON.stringify(stringArray(req.body.wikiRefs));
    if (req.body.requiredTasks !== undefined) updates.required_tasks = JSON.stringify(stringArray(req.body.requiredTasks));
    if (req.body.customerNoteTemplates !== undefined) updates.customer_note_templates = JSON.stringify(stringArray(req.body.customerNoteTemplates));
    if (req.body.goal !== undefined) updates.goal = String(req.body.goal || '').trim() || existing.goal;

    const [updated] = await db.transaction(async (trx) => {
      const [row] = await trx('lawn_protocol_windows')
        .where({ id: existing.id })
        .update(updates)
        .returning('*');
      await logProtocolAudit(trx, req, {
        protocolId: protocol.id,
        entityType: 'window',
        entityId: row.id,
        action: 'update',
        before: existing,
        after: row,
        metadata: { route: 'lawn/windows/:windowKey', windowKey: row.window_key },
      });
      return [row];
    });
    res.json({ success: true, window: updated });
  } catch (err) { next(err); }
});

// POST /api/admin/protocols/lawn/windows/:windowKey/wiki-sync — create/update the window SOP page.
router.post('/lawn/windows/:windowKey/wiki-sync', async (req, res, next) => {
  try {
    const protocolQuery = db('lawn_protocols').orderBy('effective_from', 'desc');
    if (req.body.protocolId) {
      protocolQuery.where({ id: req.body.protocolId });
    } else {
      protocolQuery.where({
        status: 'active',
        protocol_key: req.body.protocolKey || 'swfl_st_augustine_10_10',
      });
    }
    const protocol = await protocolQuery.first();
    if (!protocol) return res.status(404).json({ error: 'Lawn protocol not found' });

    const payload = await loadWindowSopPayload(db, protocol.id, req.params.windowKey);
    if (!payload) return res.status(404).json({ error: 'Protocol window not found' });

    const slug = protocolSopSlug(payload.protocol, payload.window);
    const title = `${payload.protocol.name} - ${payload.window.title}`;
    const content = renderWindowSopMarkdown(payload);
    const metadata = {
      source: 'lawn_protocol_command_center',
      protocolId: payload.protocol.id,
      protocolKey: payload.protocol.protocol_key,
      protocolVersion: payload.protocol.version,
      windowId: payload.window.id,
      windowKey: payload.window.window_key,
      generatedAt: new Date().toISOString(),
    };
    const existing = await db('knowledge_base').where({ slug }).first();
    const rowData = {
      path: `kb/protocols/${slug}.md`,
      slug,
      title,
      content,
      category: 'protocols',
      tags: JSON.stringify(['waveguard', 'lawn_protocol', 'st_augustine', payload.window.window_key]),
      source: 'protocol-sync',
      confidence: 'high',
      metadata: JSON.stringify(metadata),
      status: 'active',
      last_verified_at: new Date(),
      verified_by: actorFromRequest(req).name || 'protocol-sync',
      updated_at: new Date(),
    };

    const [entry] = existing
      ? await db('knowledge_base').where({ id: existing.id }).update(rowData).returning('*')
      : await db('knowledge_base').insert({ ...rowData, created_at: new Date() }).returning('*');

    let attached = false;
    if (payload.protocol.status === 'draft') {
      const existingRefs = Array.isArray(payload.window.wiki_refs) ? payload.window.wiki_refs : [];
      const ref = `kb:${slug}`;
      if (!existingRefs.includes(ref)) {
        const nextRefs = [...existingRefs, ref];
        await db.transaction(async (trx) => {
          const [updatedWindow] = await trx('lawn_protocol_windows')
            .where({ id: payload.window.id })
            .update({ wiki_refs: JSON.stringify(nextRefs), updated_at: new Date() })
            .returning('*');
          await logProtocolAudit(trx, req, {
            protocolId: payload.protocol.id,
            entityType: 'window',
            entityId: payload.window.id,
            action: 'update',
            before: payload.window,
            after: updatedWindow,
            metadata: { route: 'lawn/windows/:windowKey/wiki-sync', kbEntryId: entry.id, slug },
          });
        });
        attached = true;
      } else {
        attached = true;
      }
    }

    res.json({
      success: true,
      attached,
      attachmentRequiresDraft: payload.protocol.status !== 'draft',
      ref: `kb:${slug}`,
      entry: {
        id: entry.id,
        slug: entry.slug,
        title: entry.title,
        category: entry.category,
        status: entry.status,
        confidence: entry.confidence,
        updatedAt: entry.updated_at,
      },
    });
  } catch (err) { next(err); }
});

// PUT /api/admin/protocols/lawn/gates/:id — edit an enforcement/reference gate.
router.put('/lawn/gates/:id', async (req, res, next) => {
  try {
    const existing = await db('lawn_protocol_gates').where({ id: req.params.id }).first();
    if (!existing) return res.status(404).json({ error: 'Protocol gate not found' });
    const existingProtocol = await db('lawn_protocols').where({ id: existing.lawn_protocol_id }).first();
    if (existingProtocol?.status !== 'draft') {
      return res.status(409).json({ error: 'Create or select a draft before editing protocol gates' });
    }

    const updates = { updated_at: new Date() };
    if (req.body.title !== undefined) updates.title = String(req.body.title || '').trim() || existing.title;
    if (req.body.ruleText !== undefined) updates.rule_text = String(req.body.ruleText || '').trim() || existing.rule_text;
    if (req.body.gateType !== undefined) updates.gate_type = String(req.body.gateType || '').trim() || existing.gate_type;
    if (req.body.severity !== undefined) {
      const severity = String(req.body.severity || '').trim();
      updates.severity = severity || existing.severity;
    }
    if (req.body.logic !== undefined) {
      if (!req.body.logic || typeof req.body.logic !== 'object' || Array.isArray(req.body.logic)) {
        return res.status(400).json({ error: 'Gate logic must be a JSON object' });
      }
      updates.logic = JSON.stringify(req.body.logic);
    }
    if (req.body.wikiRefs !== undefined) updates.wiki_refs = JSON.stringify(stringArray(req.body.wikiRefs));

    const [updated] = await db.transaction(async (trx) => {
      const [row] = await trx('lawn_protocol_gates')
        .where({ id: existing.id })
        .update(updates)
        .returning('*');
      await logProtocolAudit(trx, req, {
        protocolId: row.lawn_protocol_id,
        entityType: 'gate',
        entityId: row.id,
        action: 'update',
        before: existing,
        after: row,
        metadata: { route: 'lawn/gates/:id', gateKey: row.gate_key },
      });
      return [row];
    });
    res.json({ success: true, gate: updated });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/product-label/:productId
router.get('/product-label/:productId', async (req, res, next) => {
  try {
    const product = await db('products_catalog').where({ id: req.params.productId }).first();
    if (!product) return res.status(404).json({ error: 'Product not found' });
    res.json({
      name: product.name, category: product.category,
      activeIngredient: product.active_ingredient, moaGroup: product.moa_group,
      signalWord: product.signal_word, reiHours: product.rei_hours,
      rainFreeHours: product.rain_free_hours, minTempF: product.min_temp_f,
      maxTempF: product.max_temp_f, maxWindMph: product.max_wind_mph,
      dilutionRate: product.dilution_rate, mixingInstructions: product.mixing_instructions,
      ppeRequired: product.ppe_required, restrictedUse: product.restricted_use,
      maximumAnnualRate: product.maximum_annual_rate,
      reapplicationIntervalDays: product.reapplication_interval_days,
      pollinatorPrecautions: product.pollinator_precautions,
      aquaticBufferFt: product.aquatic_buffer_ft,
      compatibilityNotes: product.compatibility_notes,
    });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/programs — WaveGuard lawn + service-line protocols
router.get('/programs', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const { track, program } = req.query;

    if (program && PROGRAM_KEYS.includes(program) && protocols[program]) {
      return res.json({ program: protocols[program] });
    }

    // Backward compat: map old track letters to new keys
    const TRACK_MAP = { A_St_Aug_Sun: 'st_augustine', B_St_Aug_Shade: 'st_augustine', C1_Bermuda: 'bermuda', C2_Zoysia: 'zoysia', D_Bahia: 'bahia' };
    const resolvedTrack = TRACK_MAP[track] || track;
    if (resolvedTrack && protocols.lawn[resolvedTrack]) {
      return res.json({ track: protocols.lawn[resolvedTrack] });
    }

    // Return summary of all tracks
    const summary = Object.entries(protocols.lawn).map(([key, t]) => ({
      key, name: t.name, visits: t.visits.length, notes: t.notes.length,
    }));

    res.json({
      operations: protocols.operations || {},
      lawn: { tracks: summary },
      programs: PROGRAM_KEYS.map((key) => programSummary(key, protocols[key])).filter(Boolean),
      tree_shrub: programSummary('tree_shrub', protocols.tree_shrub),
      pest: programSummary('pest', protocols.pest),
      rodent: programSummary('rodent', protocols.rodent),
      mosquito: programSummary('mosquito', protocols.mosquito),
      palm_injection: programSummary('palm_injection', protocols.palm_injection),
      cockroach: programSummary('cockroach', protocols.cockroach),
      bed_bug: programSummary('bed_bug', protocols.bed_bug),
      termite: programSummary('termite', protocols.termite),
    });
  } catch (err) { next(err); }
});

// GET /api/admin/protocols/programs/:track/visit/:num
router.get('/programs/:track/visit/:num', async (req, res, next) => {
  try {
    const protocols = require('../config/protocols.json');
    const { track, num } = req.params;

    if (track === 'tree_shrub') {
      const visit = protocols.tree_shrub.visits.find(v => v.visit === parseInt(num));
      return res.json({ visit, notes: protocols.tree_shrub.notes });
    }

    const VISIT_TRACK_MAP = { A_St_Aug_Sun: 'st_augustine', B_St_Aug_Shade: 'st_augustine', C1_Bermuda: 'bermuda', C2_Zoysia: 'zoysia', D_Bahia: 'bahia' };
    const resolvedVisitTrack = VISIT_TRACK_MAP[track] || track;
    const trackData = protocols.lawn[resolvedVisitTrack];
    if (!trackData) return res.status(404).json({ error: 'Track not found' });

    const visit = trackData.visits.find(v => v.visit === parseInt(num));
    res.json({ visit, trackName: trackData.name, notes: trackData.notes });
  } catch (err) { next(err); }
});

router._internals = {
  defaultProductStockPublishIssue,
  stockStatusForProduct,
  unmatchedPricedProtocolLines,
  isPricedProtocolLine,
};

module.exports = router;
