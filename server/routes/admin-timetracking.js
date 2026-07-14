const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const timeTracking = require('../services/time-tracking');
const PushService = require('../services/push-notifications');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const { etParts, etDateString, addETDays, parseETDateTime, etWeekStart } = require('../utils/datetime-et');
const {
  addStaffWorkDays,
  staffWorkDate,
  staffWorkDateSql,
} = require('../utils/staff-time-work-date');
const {
  MAX_STAFF_EMAIL_LENGTH,
  canonicalStaffEmail,
} = require('../utils/staff-identity');

const STAFF_ENTRY_WORK_DATE_SQL = staffWorkDateSql('time_entries.clock_in');

function staffAnalyticsDateRange({ startDate, endDate } = {}, now = new Date()) {
  const today = staffWorkDate(now);
  return {
    start: startDate || addStaffWorkDays(today, -30),
    end: endDate || today,
  };
}

function applyStaffEntryWorkDateRange(query, start, end) {
  return query.whereRaw(
    `${STAFF_ENTRY_WORK_DATE_SQL} BETWEEN ?::date AND ?::date`,
    [start, end],
  );
}

// Pure calendar arithmetic on YYYY-MM-DD strings — no timezone enters
// because we never read hours. Use this anywhere we need a "+ N days
// from this calendar date" string, instead of stringing together
// addETDays + etDateString (which works but invites questions every
// time it's audited).
function addCalendarDaysToYMD(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

// Authentication is router-wide; authorization is per-route. The
// previous setup mounted requireTechOrAdmin at the router level, but
// that pattern is harder to audit when individual routes also stack
// requireAdmin on top — readers (and code-review tools) have to
// reason about whether the chain still flows. Each route now
// declares its access scope inline: tech-or-admin reads/edits get
// requireTechOrAdmin, admin-only payroll/PII paths get requireAdmin.
router.use(adminAuthenticate);

// Positive response allowlists for `technicians`. Authentication state lives
// on the same row as the team/payroll profile, so returning `technicians.*`
// and deleting known secrets is unsafe: future auth columns would otherwise
// become API fields by default.
const TECH_ROSTER_RESPONSE_FIELDS = [
  'id', 'name', 'phone', 'email', 'role',
  'active', 'auto_flip_enabled',
  'avatar_url',
  'created_at', 'updated_at',
];

const ADMIN_TECH_RESPONSE_FIELDS = [
  ...TECH_ROSTER_RESPONSE_FIELDS,
  'pay_rate', 'hire_date', 'job_title', 'employment_type',
  'address', 'dob', 'emergency_contact_name',
  'emergency_contact_phone', 'ssn_last4',
  'fl_applicator_license', 'license_expiry', 'license_categories',
  'applicator_printed_name',
  'bouncie_imei', 'bouncie_vin', 'vehicle_name',
];

function pickTechResponseFields(tech, fields) {
  if (!tech) return tech;
  const out = {};
  for (const f of fields) {
    if (f in tech) out[f] = tech[f];
  }
  return out;
}

function sanitizeTechForNonAdmin(tech) {
  return pickTechResponseFields(tech, TECH_ROSTER_RESPONSE_FIELDS);
}

function sanitizeTechForAdmin(tech) {
  return pickTechResponseFields(tech, ADMIN_TECH_RESPONSE_FIELDS);
}

// Authoritative admin check — reads from req.technician.role (the
// full DB row attached by adminAuthenticate), not the parallel
// req.techRole convenience field, so renaming/drift on the convenience
// field can't cause this to fail open. Fails closed: any missing
// piece treats the caller as non-admin.
function isAdminCaller(req) {
  return !!(req.technician && req.technician.role === 'admin');
}

// ---------------------------------------------------------------------------
// GET /  — Dashboard: who's clocked in, today's labor, weekly stats
// ---------------------------------------------------------------------------
router.get('/', requireTechOrAdmin, async (req, res, next) => {
  try {
    const today = etDateString(new Date());

    // Active shifts
    const activeShifts = await db('time_entries')
      .where({ entry_type: 'shift', status: 'active' })
      .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
      .select(
        'time_entries.*',
        'technicians.name as tech_name',
      );

    // Enrich each with current job/break status
    const liveStatus = await Promise.all(activeShifts.map(async (shift) => {
      const currentJob = await db('time_entries')
        .where({ technician_id: shift.technician_id, entry_type: 'job', status: 'active' })
        .leftJoin('customers', 'time_entries.customer_id', 'customers.id')
        .select('time_entries.*', 'customers.first_name', 'customers.last_name')
        .first();
      const onBreak = await db('time_entries')
        .where({ technician_id: shift.technician_id, entry_type: 'break', status: 'active' })
        .first();
      return {
        ...shift,
        currentJob: currentJob || null,
        onBreak: !!onBreak,
      };
    }));

    // Today's daily summaries
    const todaySummaries = await db('time_entry_daily_summary')
      .where({ work_date: today })
      .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
      .select('time_entry_daily_summary.*', 'technicians.name as tech_name');

    // This week's summaries — Monday-anchored week in ET.
    const now = new Date();
    const dayOfWeek = etParts(now).dayOfWeek;
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStartStr = etDateString(addETDays(now, mondayOffset));

    const weekDailies = await db('time_entry_daily_summary')
      .where('work_date', '>=', weekStartStr)
      .where('work_date', '<=', today)
      .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
      .select('time_entry_daily_summary.*', 'technicians.name as tech_name');

    // All technicians for status display. pay_rate flows through
    // so the dashboard can compute labor cost at per-tech rates
    // instead of the legacy hardcoded $35 — admin only. Tech-role
    // callers (dispatch, status displays) get the same row shape with
    // pay_rate stripped so they never see coworker wages.
    const techCols = ['id', 'name', 'role'];
    if (isAdminCaller(req)) techCols.push('pay_rate');
    const activeTechs = await db('technicians')
      .where({ active: true })
      .select(techCols);
    // Pull rates for any inactive tech that still has activity in
    // todaySummaries / weekDailies / activeShifts so labor-cost
    // calculations don't silently fall back to the $35 default. A
    // tech deactivated mid-day still earned their configured rate
    // for the hours worked. Admin only — tech-role responses never
    // got pay_rate to start with.
    let allTechs = activeTechs;
    if (isAdminCaller(req)) {
      const activityIds = new Set([
        ...todaySummaries.map(s => s.technician_id),
        ...weekDailies.map(d => d.technician_id),
        ...liveStatus.map(s => s.technician_id),
      ]);
      const knownIds = new Set(activeTechs.map(t => t.id));
      const missingIds = [...activityIds].filter(id => id && !knownIds.has(id));
      if (missingIds.length) {
        const inactiveActive = await db('technicians')
          .whereIn('id', missingIds)
          .select(techCols);
        allTechs = [...activeTechs, ...inactiveActive];
      }
    }

    res.json({
      activeShifts: liveStatus,
      todaySummaries,
      weekDailies,
      allTechs,
      today,
      weekStart: weekStartStr,
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /entries — paginated entries with filters
// ---------------------------------------------------------------------------
router.get('/entries', requireAdmin, async (req, res, next) => {
  try {
    const { technicianId, startDate, endDate, entryType, status, limit, offset } = req.query;
    const result = await timeTracking.getEntries({
      technicianId,
      startDate,
      endDate,
      entryType,
      status,
      limit: parseInt(limit) || 50,
      offset: parseInt(offset) || 0,
    });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /entries/:id — single entry
// ---------------------------------------------------------------------------
router.get('/entries/:id', requireAdmin, async (req, res, next) => {
  try {
    const entry = await db('time_entries')
      .where('time_entries.id', req.params.id)
      .leftJoin('customers', 'time_entries.customer_id', 'customers.id')
      .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
      .leftJoin('scheduled_services', 'time_entries.job_id', 'scheduled_services.id')
      .select(
        'time_entries.*',
        'customers.first_name as customer_first_name',
        'customers.last_name as customer_last_name',
        'technicians.name as tech_name',
        'scheduled_services.service_type as job_service_type',
      )
      .first();
    if (!entry) return res.status(404).json({ error: 'Entry not found' });
    res.json(entry);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /entries/:id — admin edit (requires edit_reason)
// ---------------------------------------------------------------------------
router.put('/entries/:id', requireAdmin, async (req, res, next) => {
  try {
    const { clock_in, clock_out, entry_type, notes, edit_reason } = req.body;
    if (!edit_reason) return res.status(400).json({ error: 'edit_reason is required' });

    const updated = await timeTracking.adminEditEntry(req.params.id, {
      clock_in,
      clock_out,
      entry_type,
      notes,
      edit_reason,
      edited_by: req.technicianId,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// DELETE /entries/:id — void entry
// ---------------------------------------------------------------------------
router.delete('/entries/:id', requireAdmin, async (req, res, next) => {
  try {
    const { reason } = req.body || {};
    const voided = await timeTracking.voidEntry(req.params.id, {
      reason: reason || 'Admin voided',
      voided_by: req.technicianId,
    });
    res.json(voided);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /daily — daily summaries with filters
// ---------------------------------------------------------------------------
router.get('/daily', requireAdmin, async (req, res, next) => {
  try {
    const { technicianId, startDate, endDate, status } = req.query;
    const summaries = await timeTracking.getDailySummaries({ technicianId, startDate, endDate, status });
    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

function retiredDailyApproval(_req, res) {
  return res.status(410).json({
    error: 'Legacy daily approval/export endpoints are retired. Use weekly approved snapshots.',
  });
}

// ---------------------------------------------------------------------------
// PUT /daily/:id/approve — approve a daily summary
// ---------------------------------------------------------------------------
router.put('/daily/:id/approve', requireAdmin, retiredDailyApproval);

// ---------------------------------------------------------------------------
// PUT /daily/:id/reject — reject a daily summary with reason
// ---------------------------------------------------------------------------
router.put('/daily/:id/reject', requireAdmin, retiredDailyApproval);

// ---------------------------------------------------------------------------
// PUT /daily/:id/reopen — return an approved/rejected summary to pending
// ---------------------------------------------------------------------------
router.put('/daily/:id/reopen', requireAdmin, retiredDailyApproval);

// ---------------------------------------------------------------------------
// GET /daily/:id/history — approval audit trail for a summary
// ---------------------------------------------------------------------------
router.get('/daily/:id/history', requireAdmin, async (req, res, next) => {
  try {
    const rows = await db('timesheet_approvals')
      .where({ daily_summary_id: req.params.id })
      .leftJoin('technicians', 'technicians.id', 'timesheet_approvals.admin_id')
      .select(
        'timesheet_approvals.id',
        'timesheet_approvals.action',
        'timesheet_approvals.reason',
        'timesheet_approvals.prior_status',
        'timesheet_approvals.created_at',
        'technicians.name as admin_name',
      )
      .orderBy('timesheet_approvals.created_at', 'desc');
    res.json({ history: rows });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /daily/bulk-approve — approve multiple daily summaries
// ---------------------------------------------------------------------------
router.post('/daily/bulk-approve', requireAdmin, retiredDailyApproval);

// ---------------------------------------------------------------------------
// GET /weekly — weekly summaries
// ---------------------------------------------------------------------------
router.get('/weekly', requireAdmin, async (req, res, next) => {
  try {
    const { technicianId, startDate, endDate } = req.query;
    const summaries = await timeTracking.getWeeklySummaries({ technicianId, startDate, endDate });
    res.json(summaries);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /payroll-export — retired daily export (weekly approved snapshots only)
// ---------------------------------------------------------------------------
router.get('/payroll-export', requireAdmin, retiredDailyApproval);

// ---------------------------------------------------------------------------
// GET /analytics — actual vs estimated, utilization, RPMH, overtime
// ---------------------------------------------------------------------------
router.get('/analytics', requireAdmin, async (req, res, next) => {
  try {
    const { startDate, endDate, technicianId } = req.query;
    const now = new Date();
    const { start, end } = staffAnalyticsDateRange({ startDate, endDate }, now);

    // Actual vs estimated by service type
    let svcQuery = applyStaffEntryWorkDateRange(
      db('time_entries')
        .where('time_entries.entry_type', 'job')
        .where('time_entries.status', '!=', 'voided')
        .whereNotNull('time_entries.duration_minutes')
        .whereNotNull('time_entries.job_id'),
      start,
      end,
    )
      .leftJoin('scheduled_services', 'time_entries.job_id', 'scheduled_services.id')
      .select(
        db.raw("COALESCE(time_entries.service_type, scheduled_services.service_type, 'Unknown') as svc_type"),
        db.raw('AVG(time_entries.duration_minutes) as avg_actual'),
        db.raw('COUNT(*) as job_count'),
        db.raw('AVG(scheduled_services.estimated_duration) as avg_estimated'),
      )
      .groupByRaw("COALESCE(time_entries.service_type, scheduled_services.service_type, 'Unknown')");

    if (technicianId) svcQuery = svcQuery.where('time_entries.technician_id', technicianId);
    const serviceTypeStats = await svcQuery;

    // Utilization by tech
    let utilQuery = db('time_entry_daily_summary')
      .where('work_date', '>=', start)
      .where('work_date', '<=', end)
      .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
      .select(
        'technicians.name as tech_name',
        'time_entry_daily_summary.technician_id',
        db.raw('AVG(utilization_pct) as avg_utilization'),
        db.raw('SUM(total_shift_minutes) as total_shift'),
        db.raw('SUM(total_job_minutes) as total_job'),
        db.raw('SUM(revenue_generated) as total_revenue'),
        db.raw('SUM(overtime_minutes) as total_ot'),
        db.raw('SUM(job_count) as total_jobs'),
      )
      .groupBy('technicians.name', 'time_entry_daily_summary.technician_id');

    if (technicianId) utilQuery = utilQuery.where('time_entry_daily_summary.technician_id', technicianId);
    const utilizationByTech = await utilQuery;

    // RPMH by tech (recent weeks)
    const fourWeeksAgo = addStaffWorkDays(staffWorkDate(now), -28);
    const rpmhByTech = await db('time_weekly_summary')
      .where('week_start', '>=', fourWeeksAgo)
      .leftJoin('technicians', 'time_weekly_summary.technician_id', 'technicians.id')
      .select(
        'technicians.name as tech_name',
        'time_weekly_summary.technician_id',
        'time_weekly_summary.week_start',
        'time_weekly_summary.avg_rpmh',
        'time_weekly_summary.total_revenue',
        'time_weekly_summary.total_shift_minutes',
        'time_weekly_summary.overtime_minutes',
      )
      .orderBy(['technicians.name', 'time_weekly_summary.week_start']);

    // Weekly overtime trend
    const overtimeTrend = await db('time_weekly_summary')
      .where('week_start', '>=', addStaffWorkDays(staffWorkDate(now), -12 * 7))
      .leftJoin('technicians', 'time_weekly_summary.technician_id', 'technicians.id')
      .select(
        'technicians.name as tech_name',
        'time_weekly_summary.week_start',
        'time_weekly_summary.overtime_minutes',
        'time_weekly_summary.utilization_pct',
      )
      .orderBy('time_weekly_summary.week_start');

    res.json({
      serviceTypeStats,
      utilizationByTech,
      rpmhByTech,
      overtimeTrend,
      dateRange: { start, end },
    });
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// GET /analytics/comparison — service type time comparison by tech
// ---------------------------------------------------------------------------
router.get('/analytics/comparison', requireAdmin, async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const { start, end } = staffAnalyticsDateRange({ startDate, endDate });

    const comparison = await applyStaffEntryWorkDateRange(
      db('time_entries')
        .where('time_entries.entry_type', 'job')
        .where('time_entries.status', '!=', 'voided')
        .whereNotNull('time_entries.duration_minutes'),
      start,
      end,
    )
      .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
      .leftJoin('scheduled_services', 'time_entries.job_id', 'scheduled_services.id')
      .select(
        'technicians.name as tech_name',
        'time_entries.technician_id',
        db.raw("COALESCE(time_entries.service_type, scheduled_services.service_type, 'Unknown') as svc_type"),
        db.raw('AVG(time_entries.duration_minutes) as avg_actual'),
        db.raw('COUNT(*) as job_count'),
        db.raw('AVG(scheduled_services.estimated_duration) as avg_estimated'),
      )
      .groupBy('technicians.name', 'time_entries.technician_id',
        db.raw("COALESCE(time_entries.service_type, scheduled_services.service_type, 'Unknown')"))
      .orderBy(['technicians.name', 'svc_type']);

    res.json(comparison);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// TECHNICIAN MANAGEMENT — CRUD
// ═══════════════════════════════════════════════════════════════════

// GET /technicians — list all technicians (including inactive).
// Tech-role tokens get the rows with payroll/PII columns stripped;
// admin tokens get the full rows. Keeping the route accessible to
// techs preserves the pre-existing dispatch/team-roster use cases
// without exposing each coworker's wage, DOB, address, etc.
async function listTechnicians(req, res, next) {
  try {
    const techs = await db('technicians').orderBy('active', 'desc').orderBy('name');
    // Presign photo_s3_key into avatar_url for the response. After
    // PR #344 photo uploads write only photo_s3_key (no row-level URL
    // baked in); consumers (TeamTab list, dispatch board /board)
    // resolve to a fresh presigned URL inside their own auth boundary.
    // This route is admin-authed so presigning is safe.
    const { resolveTechPhotoUrl } = require('../services/tech-photo');
    const callerIsAdmin = isAdminCaller(req);
    const enriched = await Promise.all(techs.map(async (t) => {
      const row = {
        ...t,
        avatar_url: await resolveTechPhotoUrl(t.photo_s3_key, t.avatar_url),
      };
      return callerIsAdmin ? sanitizeTechForAdmin(row) : sanitizeTechForNonAdmin(row);
    }));
    res.json({ technicians: enriched });
  } catch (err) { next(err); }
}

router.get('/technicians', requireTechOrAdmin, listTechnicians);

// Map camelCase payroll-profile fields from the client to snake_case
// columns. Each mapping is conditional — undefined leaves the column
// alone, explicit '' or null clears it. ssn_last4 is normalized to
// the trailing 4 digits in case the form passed a longer string.
function applyPayrollProfileFields(updates, body) {
  const map = {
    payRate: 'pay_rate',
    hireDate: 'hire_date',
    jobTitle: 'job_title',
    employmentType: 'employment_type',
    address: 'address',
    dob: 'dob',
    emergencyContactName: 'emergency_contact_name',
    emergencyContactPhone: 'emergency_contact_phone',
  };
  for (const [k, col] of Object.entries(map)) {
    if (body[k] !== undefined) updates[col] = body[k] === '' ? null : body[k];
  }
  if (body.ssnLast4 !== undefined) {
    const digits = String(body.ssnLast4 || '').replace(/\D/g, '').slice(-4);
    updates.ssn_last4 = digits || null;
  }
}

// Staff emails are authentication identifiers. Store one canonical form so
// login/reset lookups cannot diverge on casing or surrounding whitespace.
function normalizeTechnicianEmail(value) {
  if (value === undefined) return { value: undefined };
  if (value === null) return { value: null };
  if (typeof value !== 'string') return { error: 'Email must be a string or null' };

  if (!value.trim()) return { value: null };
  const email = canonicalStaffEmail(value);
  if (!email) {
    return { error: `Email must be a valid address of ${MAX_STAFF_EMAIL_LENGTH} characters or fewer` };
  }
  return { value: email };
}

async function findTechnicianByCanonicalEmail(connection, email, excludeId) {
  if (!email) return null;
  let query = connection('technicians')
    .whereNotNull('email')
    .whereRaw('LOWER(BTRIM(email)) = ?', [email]);
  if (excludeId) query = query.whereNot('id', excludeId);
  return query.first('id');
}

// The staff table is small and identity mutations are rare. Serialize them to
// make canonical-email uniqueness and last-admin checks race-safe.
async function lockTechnicianMutations(trx) {
  await trx.raw('LOCK TABLE technicians IN SHARE ROW EXCLUSIVE MODE');
}

function disconnectRevokedStaffSessions(technicianId, reason) {
  try {
    const { disconnectStaffSockets } = require('../sockets');
    disconnectStaffSockets(technicianId, reason);
  } catch (error) {
    logger.error(`[team] Live-session disconnect failed for technician id=${technicianId} (${error.message})`);
  }
}

async function deactivationBlocker(trx, target, actorId) {
  if (!target.active) return null;
  if (target.id === actorId) return 'You cannot deactivate your own staff account';
  if (target.role !== 'admin') return null;

  const otherActiveAdmin = await trx('technicians')
    .where({ role: 'admin', active: true })
    .whereNot('id', target.id)
    .first('id');
  if (!otherActiveAdmin) return 'The final active admin cannot be deactivated';
  return null;
}

// POST /technicians — add a new technician. Admin only because the
// payload now carries payroll/PII fields (pay_rate, DOB, address,
// SSN-4, emergency contact). Pre-existing route protection was
// requireTechOrAdmin; tightening to requireAdmin since we widened
// the body shape.
async function createTechnician(req, res, next) {
  try {
    const body = req.body || {};
    const { name, phone, email, autoFlipEnabled } = body;
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    const normalizedEmail = normalizeTechnicianEmail(email);
    if (normalizedEmail.error) return res.status(400).json({ error: normalizedEmail.error });
    if (!normalizedEmail.value) {
      return res.status(400).json({ error: 'An active technician requires a valid staff email' });
    }

    const insertRow = {
      name: name.trim(),
      phone: phone || null,
      email: normalizedEmail.value ?? null,
      active: true,
    };
    // Honor the create-form's auto-flip checkbox. Without this, an
    // operator unchecking "Auto-flip enabled" during creation would
    // see the value silently dropped and the row created at the
    // column DEFAULT (TRUE), needing a second edit to actually opt
    // the tech out. Falsy explicit value → false; undefined → leave
    // it to the column DEFAULT.
    if (autoFlipEnabled !== undefined) insertRow.auto_flip_enabled = !!autoFlipEnabled;
    applyPayrollProfileFields(insertRow, body);

    const outcome = await db.transaction(async (trx) => {
      await lockTechnicianMutations(trx);
      if (insertRow.email && await findTechnicianByCanonicalEmail(trx, insertRow.email)) {
        return { conflict: true };
      }
      const [tech] = await trx('technicians').insert(insertRow).returning('*');
      return { tech };
    });
    if (outcome.conflict) return res.status(409).json({ error: 'Email already in use' });

    const { tech } = outcome;
    // Log id + structural state only; the row now carries payroll/PII
    // so names stay out of logs per AGENTS.md.
    logger.info(`[team] Added technician id=${tech.id} (auto_flip_enabled=${tech.auto_flip_enabled})`);
    return res.json({ success: true, technician: sanitizeTechForAdmin(tech) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    return next(err);
  }
}

router.post('/technicians', requireAdmin, createTechnician);

// PUT /technicians/:id — update a technician. Admin only — same
// reasoning as POST: techs must not be able to edit their own (or
// anyone else's) pay rate, DOB, SSN, address, or emergency contact.
async function updateTechnician(req, res, next) {
  try {
    const body = req.body || {};
    const { name, phone, email, active, autoFlipEnabled } = body;
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }
    if (active !== undefined && typeof active !== 'boolean') {
      return res.status(400).json({ error: 'active must be a boolean' });
    }
    const normalizedEmail = normalizeTechnicianEmail(email);
    if (normalizedEmail.error) return res.status(400).json({ error: normalizedEmail.error });

    const outcome = await db.transaction(async (trx) => {
      // Every Staff identity writer takes the table lock before a row lock.
      // Keeping one global order avoids deadlocks with password reset/register.
      await lockTechnicianMutations(trx);
      const target = await trx('technicians')
        .where({ id: req.params.id })
        .forUpdate()
        .first();
      if (!target) return { notFound: true };

      const storedEmail = canonicalStaffEmail(target.email);
      const resultingEmail = email === undefined ? storedEmail : normalizedEmail.value;
      const resultingActive = active === undefined ? Boolean(target.active) : active;
      if (resultingActive && !resultingEmail) return { missingEmail: true };

      if (active === false) {
        const blocker = await deactivationBlocker(trx, target, req.technicianId);
        if (blocker) return { blocker };
        const activeTimer = await trx('time_entries')
          .where({ technician_id: target.id, status: 'active' })
          .forUpdate()
          .first('id');
        if (activeTimer) return { activeTimer: true };
      }
      if (normalizedEmail.value && await findTechnicianByCanonicalEmail(
        trx,
        normalizedEmail.value,
        target.id,
      )) {
        return { conflict: true };
      }

      const updates = {};
      if (name !== undefined) updates.name = name.trim();
      if (phone !== undefined) updates.phone = phone || null;
      if (email !== undefined) updates.email = normalizedEmail.value;
      if (active !== undefined) updates.active = active;

      const activeChanged = active !== undefined && active !== Boolean(target.active);
      const emailChanged = email !== undefined && normalizedEmail.value !== storedEmail;
      const credentialsChanged = activeChanged || emailChanged;
      if (credentialsChanged) {
        updates.auth_token_version = Number(target.auth_token_version || 0) + 1;
        updates.password_reset_token_hash = null;
        updates.password_reset_expires_at = null;
        updates.password_reset_requested_at = null;
      }
      if (autoFlipEnabled !== undefined) updates.auto_flip_enabled = !!autoFlipEnabled;
      applyPayrollProfileFields(updates, body);
      updates.updated_at = new Date();
      await trx('technicians').where({ id: target.id }).update(updates);

      const revokeAccess = credentialsChanged || active === false;
      if (revokeAccess) await PushService.deactivateStaffUser(target.id, trx);
      const tech = await trx('technicians').where({ id: target.id }).first();
      return {
        tech,
        revokeAccess,
        revocationReason: active === false
          ? 'account_deactivated'
          : activeChanged
            ? 'account_status_changed'
            : 'email_changed',
      };
    });

    if (outcome.notFound) return res.status(404).json({ error: 'Technician not found' });
    if (outcome.missingEmail) {
      return res.status(400).json({ error: 'An active technician requires a valid staff email' });
    }
    if (outcome.blocker) return res.status(409).json({ error: outcome.blocker });
    if (outcome.activeTimer) {
      return res.status(409).json({
        error: 'Close every active time entry before deactivating this staff account',
        code: 'ACTIVE_TIME_ENTRIES',
      });
    }
    if (outcome.conflict) return res.status(409).json({ error: 'Email already in use' });

    const { tech } = outcome;
    if (outcome.revokeAccess) {
      disconnectRevokedStaffSessions(tech.id, outcome.revocationReason);
    }
    logger.info(`[team] Updated technician id=${tech.id} (active=${tech.active}, auto_flip_enabled=${tech.auto_flip_enabled})`);
    return res.json({ success: true, technician: sanitizeTechForAdmin(tech) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'Email already in use' });
    return next(err);
  }
}

router.put('/technicians/:id', requireAdmin, updateTechnician);

// GET /technicians/:id/earnings — hours × pay_rate breakdown for a
// window. OT pays at 1.5×. Falls back to $35/hr if pay_rate is unset
// (matches the legacy hardcoded LABOR_RATE so dashboards stay
// consistent). Admin only — payroll info, even one tech's own, isn't
// a tech-role surface.
//
// Window is selected via either:
//   - period=this-week | last-week  (server anchors on ET, preferred)
//   - from=YYYY-MM-DD & to=YYYY-MM-DD (explicit, for ad-hoc windows)
//
// Clients should prefer ?period= so week boundaries don't drift on
// browsers outside ET or near midnight.
router.get('/technicians/:id/earnings', requireAdmin, async (req, res, next) => {
  try {
    const tech = await db('technicians').where({ id: req.params.id }).first();
    if (!tech) return res.status(404).json({ error: 'Technician not found' });

    let { from, to } = req.query;
    const { period } = req.query;
    if (period === 'this-week' || period === 'last-week') {
      const offsetDays = period === 'last-week' ? -7 : 0;
      const anchor = addETDays(new Date(), offsetDays);
      from = etWeekStart(anchor);
      // Pure calendar +6 on the YYYY-MM-DD Monday string — no
      // timezone ambiguity since we never read hours.
      to = addCalendarDaysToYMD(from, 6);
    }
    if (!from || !to) return res.status(400).json({ error: 'from+to (YYYY-MM-DD) or period=this-week|last-week required' });
    // Validate shape AND calendar-validity before parseETDateTime —
    // bad shape (`from=bad`) would throw "Invalid time value" → 500;
    // an invalid date like `2026-02-31` would silently overflow to
    // `2026-03-03` and return earnings for the wrong window.
    const ymdRe = /^\d{4}-\d{2}-\d{2}$/;
    const realDate = (s) => {
      if (!ymdRe.test(s)) return false;
      const [y, m, d] = s.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      return dt.getUTCFullYear() === y && dt.getUTCMonth() + 1 === m && dt.getUTCDate() === d;
    };
    if (!realDate(from) || !realDate(to)) {
      return res.status(400).json({ error: 'from/to must be a valid YYYY-MM-DD calendar date' });
    }
    if (from > to) {
      return res.status(400).json({ error: 'from must be on or before to' });
    }

    // Recompute the weekly summaries that overlap the window before
    // reading dailies. time_entry_daily_summary.overtime_minutes is
    // populated by computeWeeklySummary as a per-day allocation of
    // weekly OT, and admin entry edits clear sign-off but don't always
    // re-run that compute, so OT minutes can be stale → wrong gross
    // pay. Iterating week starts is bounded (one call per ISO week
    // in the window).
    const firstWeekStart = etWeekStart(parseETDateTime(`${from}T12:00`));
    const lastWeekStart = etWeekStart(parseETDateTime(`${to}T12:00`));
    let cursor = firstWeekStart;
    while (cursor <= lastWeekStart) {
      try { await timeTracking.computeWeeklySummary(tech.id, cursor); } catch (_) { /* noop */ }
      cursor = addCalendarDaysToYMD(cursor, 7);
    }

    const rows = await db('time_entry_daily_summary')
      .where({ technician_id: tech.id })
      .where('work_date', '>=', from)
      .where('work_date', '<=', to)
      .select('work_date', 'total_shift_minutes', 'overtime_minutes', 'job_count');

    const totalMin = rows.reduce((s, r) => s + parseFloat(r.total_shift_minutes || 0), 0);
    const otMin = rows.reduce((s, r) => s + parseFloat(r.overtime_minutes || 0), 0);
    const regMin = Math.max(0, totalMin - otMin);

    const rate = parseFloat(tech.pay_rate) > 0 ? parseFloat(tech.pay_rate) : 35;
    // Round line items to cents and reconcile gross from those rounded
    // components so the response is internally self-consistent — the
    // earnings modal renders reg + ot + gross side by side, and admins
    // double-checking payroll should never see line items that don't
    // sum to the displayed gross. computeDailySummary leaves zero rows
    // in place after voids, so daysWorked filters on actual worked
    // time too.
    const regularPay = Number(((regMin / 60) * rate).toFixed(2));
    const overtimePay = Number(((otMin / 60) * rate * 1.5).toFixed(2));
    const grossPay = Number((regularPay + overtimePay).toFixed(2));
    const daysWorked = rows.filter(r =>
      parseFloat(r.total_shift_minutes || 0) > 0 || (r.job_count || 0) > 0
    ).length;

    res.json({
      technicianId: tech.id,
      technicianName: tech.name,
      from,
      to,
      payRate: rate,
      payRateSource: parseFloat(tech.pay_rate) > 0 ? 'tech' : 'default',
      regularMinutes: regMin,
      overtimeMinutes: otMin,
      totalMinutes: totalMin,
      regularPay,
      overtimePay,
      grossPay,
      daysWorked,
    });
  } catch (err) { next(err); }
});

// POST /technicians/:id/photo — upload tech profile photo.
//
// Multipart upload. Stores the binary in S3 at
// tech-photos/<technician_id>/<timestamp>-<safename> and sets
// technicians.photo_s3_key (canonical S3 reference).
//
// Read pattern: consumers (track-public.js, documents.js,
// review-request.js) presign technicians.photo_s3_key on demand
// at the trusted-context boundary they already authenticate. There
// is NO public unauthenticated proxy — adding one would put a new
// route outside AGENTS.md's allowed-list of public-by-token routes
// (P0; Codex caught this on PR #344). UUIDs are not secrets —
// booking responses already expose technician_id to unauth callers.
//
// photo_url is left untouched. It coexists as a fallback for
// techs whose photo lives at an external URL (e.g., Google Business
// profile). Read sites use photo_s3_key first, fall back to
// photo_url.
//
// Re-uploading a photo for the same tech overwrites photo_s3_key
// (old S3 object stays orphaned — cleanup is a separate concern).
//
// Lazy multer init: defining the route requires `upload`, which is
// declared further down the file (with the company-documents block).
// Reuse it inline below — same multer instance, same 25 MB cap.
const PHOTO_PREFIX = 'tech-photos/';
router.post(
  '/technicians/:id/photo',
  // Two-stage gate: requireTechOrAdmin first to reject any role that
  // isn't admin/technician (matches every other route on this file
  // now that router-level role gating is gone), then a stricter
  // self-or-admin guard so a tech-role token can only update its
  // own photo, not a coworker's row.
  requireTechOrAdmin,
  (req, res, next) => {
    if (isAdminCaller(req)) return next();
    if (req.params.id && req.technicianId && req.params.id === req.technicianId) return next();
    return res.status(403).json({ error: 'Can only update your own photo' });
  },
  (req, res, next) => upload.single('photo')(req, res, next),
  async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'No file provided' });
      if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });

      const tech = await db('technicians').where({ id: req.params.id }).first('id', 'name');
      if (!tech) return res.status(404).json({ error: 'Technician not found' });

      const safeName = req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      const key = `${PHOTO_PREFIX}${tech.id}/${Date.now()}-${safeName}`;
      await s3.send(new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: req.file.buffer,
        ContentType: req.file.mimetype,
      }));

      await db('technicians').where({ id: tech.id }).update({
        photo_s3_key: key,
        updated_at: new Date(),
      });

      logger.info(`[team] Uploaded photo for ${tech.name}: ${key}`);

      // Return the row with avatar_url presigned from the new
      // photo_s3_key — same shape as GET /technicians, so the
      // client can render the new photo immediately without a
      // follow-up GET. Sanitize for non-admin callers since the
      // technicians row now carries payroll/PII columns; this route
      // is requireTechOrAdmin pre-this-PR and we keep that gate so a
      // tech-side avatar update path (if/when we add one) doesn't
      // 403, but tech-role responses get the same private columns
      // stripped as GET /technicians does.
      const updated = await db('technicians').where({ id: tech.id }).first();
      const { resolveTechPhotoUrl } = require('../services/tech-photo');
      updated.avatar_url = await resolveTechPhotoUrl(updated.photo_s3_key, updated.avatar_url);

      const responseRow = isAdminCaller(req) ? sanitizeTechForAdmin(updated) : sanitizeTechForNonAdmin(updated);
      res.json({ success: true, technician: responseRow });
    } catch (err) {
      logger.error(`[team] Tech photo upload failed: ${err.message}`);
      next(err);
    }
  }
);

// DELETE /technicians/:id — compatibility alias for deactivation. A staff id
// is historical identity for time, payroll, jobs, compliance, and audit rows;
// even ?force=true must never turn this endpoint into a data purge.
async function deactivateTechnician(req, res, next) {
  try {
    const outcome = await db.transaction(async (trx) => {
      await lockTechnicianMutations(trx);
      const target = await trx('technicians')
        .where({ id: req.params.id })
        .forUpdate()
        .first();
      if (!target) return { notFound: true };

      const blocker = await deactivationBlocker(trx, target, req.technicianId);
      if (blocker) return { blocker };
      const activeTimer = await trx('time_entries')
        .where({ technician_id: target.id, status: 'active' })
        .forUpdate()
        .first('id');
      if (activeTimer) return { activeTimer: true };

      if (target.active) {
        await trx('technicians').where({ id: target.id }).update({
          active: false,
          auth_token_version: Number(target.auth_token_version || 0) + 1,
          password_reset_token_hash: null,
          password_reset_expires_at: null,
          password_reset_requested_at: null,
          updated_at: new Date(),
        });
      }
      await PushService.deactivateStaffUser(target.id, trx);
      const tech = target.active
        ? await trx('technicians').where({ id: target.id }).first()
        : target;
      return { tech, changed: Boolean(target.active) };
    });

    if (outcome.notFound) return res.status(404).json({ error: 'Technician not found' });
    if (outcome.blocker) return res.status(409).json({ error: outcome.blocker });
    if (outcome.activeTimer) {
      return res.status(409).json({
        error: 'Close every active time entry before deactivating this staff account',
        code: 'ACTIVE_TIME_ENTRIES',
      });
    }
    disconnectRevokedStaffSessions(outcome.tech.id, 'account_deactivated');
    if (outcome.changed) logger.info(`[team] Deactivated technician id=${outcome.tech.id}`);
    return res.json({
      success: true,
      deactivated: true,
      technician: sanitizeTechForAdmin(outcome.tech),
    });
  } catch (err) {
    return next(err);
  }
}

router.delete('/technicians/:id', requireAdmin, deactivateTechnician);

// =============================================================================
// COMPANY DOCUMENTS — admin-only internal docs (SOPs, onboarding, offer letters)
// =============================================================================
const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const config = require('../config');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25 MB max

const s3 = new S3Client({
  region: config.s3.region,
  credentials: { accessKeyId: config.s3.accessKeyId, secretAccessKey: config.s3.secretAccessKey },
});
const DOC_PREFIX = 'company-documents/';

async function ensureDocTable() {
  if (!(await db.schema.hasTable('company_documents'))) {
    await db.schema.createTable('company_documents', t => {
      t.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      t.string('title', 200).notNullable();
      t.string('category', 50).notNullable().defaultTo('general');
      t.text('description');
      t.string('file_name', 255).notNullable();
      t.string('file_type', 50);
      t.integer('file_size');
      t.string('s3_key', 500).notNullable();
      t.uuid('uploaded_by');
      t.boolean('is_archived').defaultTo(false);
      // Per-tech binding + expiration (added by migration
      // 20260428000008). Mirror the columns here so a fresh env that
      // auto-creates this table doesn't 500 on the GET /documents
      // join below — the route now leftJoins technicians on
      // company_documents.technician_id.
      t.uuid('technician_id');
      t.date('expiration_date');
      t.index('technician_id');
      t.index('expiration_date');
      t.timestamps(true, true);
    });
  }
}

// GET /documents — list all (admin only). Optional filters:
//   category=<one of DOC_CATEGORIES> | 'all'
//   technicianId=<uuid> — docs bound to that tech
//   technicianId='company' — only company-wide docs (technician_id IS NULL)
// requireAdmin: documents now hold per-tech HR records (W-4, I-9,
// license, cert expirations). Tech-role tokens must not be able to
// list/read/upload/edit those, even their own — pre-existing tech
// access to company-wide SOPs is acceptable collateral here.
router.get('/documents', requireAdmin, async (req, res, next) => {
  try {
    await ensureDocTable();
    const { category, technicianId } = req.query;
    let query = db('company_documents')
      .leftJoin('technicians', 'company_documents.technician_id', 'technicians.id')
      .where('company_documents.is_archived', false)
      .select('company_documents.*', 'technicians.name as technician_name')
      .orderBy('company_documents.created_at', 'desc');
    if (category && category !== 'all') query = query.where('company_documents.category', category);
    if (technicianId === 'company') {
      query = query.whereNull('company_documents.technician_id');
    } else if (technicianId) {
      query = query.where('company_documents.technician_id', technicianId);
    }
    const docs = await query;
    res.json({ documents: docs });
  } catch (err) { next(err); }
});

// POST /documents/upload — upload a file. Optional binding:
//   technicianId — bind to one tech (omit / empty for company-wide)
//   expirationDate — YYYY-MM-DD for licenses, certs, I-9s with reverify dates
router.post('/documents/upload', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    await ensureDocTable();
    if (!req.file) return res.status(400).json({ error: 'No file provided' });

    const { title, category, description, technicianId, expirationDate } = req.body;
    const ext = req.file.originalname.split('.').pop().toLowerCase();
    const key = `${DOC_PREFIX}${Date.now()}-${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;

    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }));

    const [doc] = await db('company_documents').insert({
      title: title || req.file.originalname,
      category: category || 'general',
      description: description || null,
      file_name: req.file.originalname,
      file_type: ext,
      file_size: req.file.size,
      s3_key: key,
      uploaded_by: req.technicianId || null,
      technician_id: technicianId || null,
      expiration_date: expirationDate || null,
    }).returning('*');

    // Log structural metadata only — titles and filenames for HR
    // documents (W-4, I-9, licenses) commonly embed employee names
    // and other PII per AGENTS.md guidance, so keep them out of logs.
    logger.info(`[docs] Uploaded id=${doc.id} category=${doc.category} ext=${ext} size=${req.file.size}B${doc.technician_id ? ` tech=${doc.technician_id}` : ''}`);
    res.status(201).json(doc);
  } catch (err) { next(err); }
});

// GET /documents/:id/download — get presigned download URL
router.get('/documents/:id/download', requireAdmin, async (req, res, next) => {
  try {
    const doc = await db('company_documents').where({ id: req.params.id }).first();
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: doc.s3_key,
    }), { expiresIn: 3600 });

    res.json({ url, fileName: doc.file_name });
  } catch (err) { next(err); }
});

// PUT /documents/:id — update metadata. Pass technicianId='' to
// unbind from a tech back to company-wide; expirationDate='' to
// clear an expiration.
router.put('/documents/:id', requireAdmin, async (req, res, next) => {
  try {
    const { title, category, description, technicianId, expirationDate } = req.body;
    const updates = { updated_at: new Date() };
    if (title !== undefined) updates.title = title;
    if (category !== undefined) updates.category = category;
    if (description !== undefined) updates.description = description;
    if (technicianId !== undefined) updates.technician_id = technicianId === '' ? null : technicianId;
    if (expirationDate !== undefined) updates.expiration_date = expirationDate === '' ? null : expirationDate;
    await db('company_documents').where({ id: req.params.id }).update(updates);
    const doc = await db('company_documents').where({ id: req.params.id }).first();
    res.json(doc);
  } catch (err) { next(err); }
});

// DELETE /documents/:id — archive (soft delete)
router.delete('/documents/:id', requireAdmin, async (req, res, next) => {
  try {
    await db('company_documents').where({ id: req.params.id }).update({ is_archived: true, updated_at: new Date() });
    logger.info(`[docs] Archived document: ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

router._test = {
  STAFF_ENTRY_WORK_DATE_SQL,
  applyStaffEntryWorkDateRange,
  staffAnalyticsDateRange,
};

module.exports = router;
module.exports._handlers = {
  createTechnician,
  deactivateTechnician,
  listTechnicians,
  updateTechnician,
};
