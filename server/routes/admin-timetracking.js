const express = require('express');
const router = express.Router();
const db = require('../models/db');
const logger = require('../services/logger');
const timeTracking = require('../services/time-tracking');
const featureGates = require('../config/feature-gates');
const { techWorkDaysLive } = featureGates;
// Looked up at call time: a missing reader (a partial feature-gates mock) reads as off.
const serviceLineMode = () => (typeof featureGates.serviceLineMapMode === 'function' ? featureGates.serviceLineMapMode() : 'off');
// The Team tab card and its endpoints work in 'shadow' and 'live' alike.
const serviceLineMapOn = () => ['shadow', 'live'].includes(serviceLineMode());
const territoryReadoutOn = () => (typeof featureGates.territoryReadoutLive === 'function' ? featureGates.territoryReadoutLive() : false);
// GATE_TECH_SHIFT_HOURS: the Team tab "Shift hours" row; looked up at call time like the readers above.
const techShiftHoursOn = () => (typeof featureGates.techShiftHoursLive === 'function' ? featureGates.techShiftHoursLive() : false);
const PushService = require('../services/push-notifications');
const { adminAuthenticate, requireTechOrAdmin, requireAdmin } = require('../middleware/admin-auth');
const {
  isEmploymentStatus, employmentPatch, isAssignable, isOffDay, loadTechShifts, shiftWarning, storedShift,
} = require('../services/technician-eligibility');
const { rowBlockMinutes } = require('../services/scheduling/window-rules');
const TWILIO_NUMBERS = require('../config/twilio-numbers');
const {
  categoriesForServices,
  listCapabilities,
  normalizeCapabilityEntries,
  seedNewHireCapabilities,
  summarizeCapabilities,
  writeCapabilities,
} = require('../services/technician-capabilities');
const { etParts, etDateString, addETDays, parseETDateTime, etWeekStart } = require('../utils/datetime-et');
const {
  addStaffWorkDays,
  staffWorkDate,
  staffWorkDateSql,
} = require('../utils/staff-time-work-date');
const {
  MAX_STAFF_EMAIL_LENGTH,
  canonicalStaffEmail,
  findStaffByCanonicalEmail,
  // One mailbox, one staff row: another row's staff email or linked Google address.
  findStaffByLoginEmail: findTechnicianByMailbox,
  lockStaffIdentityWrites: lockTechnicianMutations,
} = require('../utils/staff-identity');
const { assertMayChangeFullAccessEmail, ibFullAccess, isFullAccessEmail } = require('../services/intelligence-bar/ib-access');
const googleSignin = require('../services/staff-google-signin');
const analyticsMath = require('../services/time-tracking-analytics');
const { validDateOnly } = require('../utils/date-only');
const { recordAuditEvent } = require('../services/audit-log');
const {
  ALLOWED_DOC_CATEGORIES,
  validateStaffPhotoUpload,
  validateCompanyDocumentUpload,
  safeDownloadFilename,
} = require('../utils/staff-upload-validation');

const UUID_PARAM_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

router.param('id', (req, res, next, id) => {
  if (String(req.path || req.url || '').split('?')[0].endsWith('/voice-pin')) return next();
  if (!UUID_PARAM_RE.test(String(id || ''))) {
    return res.status(400).json({ error: 'Invalid ID' });
  }
  return next();
});

function dateFilterError(query) {
  for (const field of ['startDate', 'endDate']) {
    const value = query?.[field];
    if (value !== undefined && value !== '' && !validDateOnly(value)) {
      return `${field} must be a valid YYYY-MM-DD date`;
    }
  }
  return null;
}

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
  'active', 'employment_status', 'field_dispatchable', 'auto_flip_enabled',
  'twilio_number', 'avatar_url', 'capability_summary',
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
  // Start-of-day point (home address is staff PII: admin-only, never logged).
  'start_address', 'start_lat', 'start_lng',
  // Team tab "Supply store": the supplier branch the Monday buy list names for this person.
  'supply_store',
  // Team tab "Can move visits" switch.
  'can_move_visits',
  // Team tab "Can create estimates" switch (GATE_TECH_ESTIMATES).
  'can_create_estimates',
  // Hired button state (Google press only); derived flags, no credential column ships.
  'hire_action', 'hire_login', 'hire_google_only',
  // Team tab "Work days" (GATE_TECH_WORK_DAYS); dropped from the response while the gate is off.
  'work_days',
  // Team tab "Shift hours" (GATE_TECH_SHIFT_HOURS); dropped from the response while the gate is off.
  'shift_start', 'shift_end',
];

function pickTechResponseFields(tech, fields) {
  if (!tech) return tech;
  const out = {};
  for (const f of fields) {
    if (f in tech) out[f] = tech[f];
  }
  return out;
}

// What a technician may read about a coworker: name, role, status, photo and
// the capability counts the Team tab shows (not PII). No phone, email, tech
// line number or dates (owner 2026-11-04, "Own number only").
const COWORKER_ROSTER_FIELDS = [
  'id', 'name', 'role', 'active', 'employment_status', 'field_dispatchable', 'avatar_url',
  'capability_summary',
];

// A technician reads the roster for names and status only: a coworker's phone
// and email are office-only (owner 2026-10-30); the caller's own row keeps them.
function sanitizeTechForNonAdmin(tech, viewerId) {
  if (tech && tech.id !== viewerId) return pickTechResponseFields(tech, COWORKER_ROSTER_FIELDS);
  return pickTechResponseFields(tech, TECH_ROSTER_RESPONSE_FIELDS);
}

function sanitizeTechForAdmin(tech) {
  const out = pickTechResponseFields(tech, ADMIN_TECH_RESPONSE_FIELDS);
  // pg returns decimal columns as strings; the API hands back numbers.
  for (const f of ['start_lat', 'start_lng']) {
    if (out && out[f] != null) out[f] = Number(out[f]);
  }
  if (out && !techWorkDaysLive()) delete out.work_days;
  // pg returns a time column as 'HH:MM:SS'; the API hands back 'HH:MM', the editor's format.
  for (const f of ['shift_start', 'shift_end']) {
    if (out && !techShiftHoursOn()) delete out[f];
    else if (out && out[f] != null) out[f] = String(out[f]).slice(0, 5);
  }
  // Team tab Google sign-in (GATE_STAFF_GOOGLE_SIGNIN): the linked address and
  // whether its first sign-in pinned a Google account; never Google's id.
  if (out && googleSignin.staffGoogleSigninLive()) {
    out.google_email = tech.google_email || null;
    out.google_linked = Boolean(tech.google_sub);
  }
  return out;
}

const WORK_DAYS_ERROR = 'workDays must be null (every day) or a list of weekday numbers 0 (Sunday) to 6 (Saturday), each once';

// `workDays` on POST/PUT /technicians (GATE_TECH_WORK_DAYS). undefined, or the
// gate off = leave alone (the column is inert and the editor hidden). null or
// all seven days = works every day (stored NULL). Otherwise a sorted list of
// distinct ints 0..6; an empty list is a 400 (the column CHECK refuses it too).
function normalizeWorkDaysInput(value) {
  if (value === undefined || !techWorkDaysLive()) return { patch: {} };
  if (value === null) return { patch: { work_days: null } };
  if (!Array.isArray(value)) return { error: WORK_DAYS_ERROR };
  if (!value.length) return { error: 'Pick at least one work day' };
  const days = new Set();
  for (const raw of value) {
    if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > 6 || days.has(raw)) {
      return { error: WORK_DAYS_ERROR };
    }
    days.add(raw);
  }
  return { patch: { work_days: days.size === 7 ? null : [...days].sort((a, b) => a - b) } };
}

const SHIFT_HOURS_ERROR = 'shiftHours must be null (no set hours) or { start, end } as HH:MM times, with the end after the start';
const SHIFT_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

// `shiftHours` on POST/PUT /technicians (GATE_TECH_SHIFT_HOURS). undefined, or the
// gate off = leave alone (the columns are inert and the editor hidden). null = no
// set hours (both columns NULL). Otherwise { start, end }: 'HH:MM' Eastern
// wall-clock times on one day, the end after the start (the column CHECK too).
function normalizeShiftHoursInput(value) {
  if (value === undefined || !techShiftHoursOn()) return { patch: {} };
  if (value === null) return { patch: { shift_start: null, shift_end: null } };
  const { start, end } = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  if (typeof start !== 'string' || typeof end !== 'string' || !SHIFT_TIME.test(start) || !SHIFT_TIME.test(end) || end <= start) {
    return { error: SHIFT_HOURS_ERROR };
  }
  return { patch: { shift_start: start, shift_end: end } };
}

const START_ADDRESS_MAX = 300;
const START_POINT_ERROR = 'startPoint must be null (office) or { address, lat, lng } with a real address and coordinates';

// `startPoint` on PUT /technicians/:id. undefined = leave alone; null = back to
// the office (all three columns cleared); otherwise address + lat + lng, all
// required. Lat/lng are never accepted without each other, so the engine can
// trust "start_lat set" to mean a usable point.
function normalizeStartPoint(value) {
  if (value === undefined) return { patch: {} };
  if (value === null) return { patch: { start_address: null, start_lat: null, start_lng: null } };
  if (typeof value !== 'object' || Array.isArray(value)) return { error: START_POINT_ERROR };
  const address = typeof value.address === 'string' ? value.address.trim() : '';
  if (!address || address.length > START_ADDRESS_MAX) return { error: START_POINT_ERROR };
  const { lat, lng } = value;
  const okLat = typeof lat === 'number' && Number.isFinite(lat) && lat >= -90 && lat <= 90;
  const okLng = typeof lng === 'number' && Number.isFinite(lng) && lng >= -180 && lng <= 180;
  if (!okLat || !okLng) return { error: START_POINT_ERROR };
  return { patch: { start_address: address, start_lat: lat, start_lng: lng } };
}

const SUPPLY_STORE_MAX = 120;

// `supplyStore` on PUT /technicians/:id: the supplier branch this person buys
// from (free text, e.g. "SiteOne Lakewood Ranch"). undefined = leave alone;
// null or blank = cleared. Same shape as payRateError: a message, or null.
function supplyStoreError(body) {
  const value = body.supplyStore;
  const ok = value == null || (typeof value === 'string' && value.trim().length <= SUPPLY_STORE_MAX);
  return ok ? null : `supplyStore must be null or text of at most ${SUPPLY_STORE_MAX} characters`;
}

function supplyStorePatch(value) {
  return value === undefined ? {} : { supply_store: (typeof value === 'string' && value.trim()) || null };
}

// Authoritative admin check — reads from req.technician.role (the
// full DB row attached by adminAuthenticate), not the parallel
// req.techRole convenience field, so renaming/drift on the convenience
// field can't cause this to fail open. Fails closed: any missing
// piece treats the caller as non-admin.
function isAdminCaller(req) {
  return !!(req.technician && req.technician.role === 'admin');
}

// Owner-only rows on the dashboard feed (ADMIN-BUG-R41): GET / stays
// requireTechOrAdmin (it serves the who's-clocked-in roster both admin and
// dispatch need), but todaySummaries/weekDailies and each activeShifts row
// otherwise carry the exact revenue/overtime/utilization/approval-status/
// approval-notes/clock-in-GPS columns the sibling /entries, /daily, /weekly
// and /analytics routes already reserve for admins (requireAdmin). A
// technician response is projected down to the live-roster shape those
// routes were never meant to duplicate.
function techSafeActiveShift(shift) {
  return {
    id: shift.id,
    technician_id: shift.technician_id,
    tech_name: shift.tech_name,
    clock_in: shift.clock_in,
    onBreak: shift.onBreak,
    currentJob: shift.currentJob ? { service_type: shift.currentJob.service_type } : null,
  };
}
function techSafeDailySummary(row) {
  return {
    technician_id: row.technician_id,
    tech_name: row.tech_name,
    work_date: row.work_date,
    total_shift_minutes: row.total_shift_minutes,
  };
}

// ---------------------------------------------------------------------------
// GET /  — Dashboard: who's clocked in, today's labor, weekly stats
// ---------------------------------------------------------------------------
router.get('/', requireTechOrAdmin, async (req, res, next) => {
  try {
    const today = etDateString(new Date());
    // A technician sees its own clock state and hours only: no coworker's
    // status, job type or daily hours (owner 2026-11-04, "Own hours only").
    const ownOnly = !isAdminCaller(req);
    const ownId = req.technicianId;

    // Active shifts
    let shiftQuery = db('time_entries').where({ entry_type: 'shift', status: 'active' });
    if (ownOnly) shiftQuery = shiftQuery.where('time_entries.technician_id', ownId);
    const activeShifts = await shiftQuery
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
    let todayQuery = db('time_entry_daily_summary').where({ work_date: today });
    if (ownOnly) todayQuery = todayQuery.where('time_entry_daily_summary.technician_id', ownId);
    const todaySummaries = await todayQuery
      .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
      .select('time_entry_daily_summary.*', 'technicians.name as tech_name');

    // This week's summaries — Monday-anchored week in ET.
    const now = new Date();
    const dayOfWeek = etParts(now).dayOfWeek;
    const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const weekStartStr = etDateString(addETDays(now, mondayOffset));

    let weekQuery = db('time_entry_daily_summary')
      .where('work_date', '>=', weekStartStr)
      .where('work_date', '<=', today);
    if (ownOnly) weekQuery = weekQuery.where('time_entry_daily_summary.technician_id', ownId);
    const weekDailies = await weekQuery
      .leftJoin('technicians', 'time_entry_daily_summary.technician_id', 'technicians.id')
      .select('time_entry_daily_summary.*', 'technicians.name as tech_name');

    // All technicians for status display. pay_rate flows through
    // so the dashboard can compute labor cost at per-tech rates
    // instead of the legacy hardcoded $35 — admin only. Tech-role
    // callers (dispatch, status displays) get the same row shape with
    // pay_rate stripped so they never see coworker wages.
    const techCols = ['id', 'name', 'role'];
    if (isAdminCaller(req)) techCols.push('pay_rate');
    let techQuery = db('technicians').where({ active: true });
    if (ownOnly) techQuery = techQuery.where('id', ownId);
    const activeTechs = await techQuery.select(techCols);
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

    const isAdminRequest = isAdminCaller(req);
    res.json({
      // codex round-1 P2: the projected summaries drop job_count/
      // total_job_minutes/revenue_generated/utilization_pct entirely for a
      // technician, but TimeTrackingPage.jsx defaults each to 0 and renders
      // it as a real metric (a technician would see "$0 revenue" /
      // "0% utilization" for a coworker instead of "not shown"). This flag
      // tells the client which shape it got so it can hide those tiles/
      // columns instead of rendering an absent value as a real zero.
      viewerRole: isAdminRequest ? 'admin' : 'technician',
      activeShifts: isAdminRequest ? liveStatus : liveStatus.map(techSafeActiveShift),
      todaySummaries: isAdminRequest ? todaySummaries : todaySummaries.map(techSafeDailySummary),
      weekDailies: isAdminRequest ? weekDailies : weekDailies.map(techSafeDailySummary),
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
    const badDate = dateFilterError(req.query);
    if (badDate) return res.status(400).json({ error: badDate });
    const { technicianId, startDate, endDate, entryType, status } = req.query;
    const rawLimit = Number.parseInt(req.query.limit, 10);
    const rawOffset = Number.parseInt(req.query.offset, 10);
    const result = await timeTracking.getEntries({
      technicianId,
      startDate,
      endDate,
      entryType,
      status,
      limit: Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 200) : 50,
      offset: Number.isSafeInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0,
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
// POST /entries — admin adds a shift the technician never clocked (a missed
// day). Same rules as the edit below: edit_reason required, refused on an
// approved or paid week. Body: technician_id, clock_in, clock_out (ISO
// instants), notes, edit_reason. Returns the new entry.
// ---------------------------------------------------------------------------
router.post('/entries', requireAdmin, async (req, res, next) => {
  try {
    const { technician_id, clock_in, clock_out, notes, edit_reason } = req.body || {};
    if (typeof edit_reason !== 'string' || !edit_reason.trim()) {
      return res.status(400).json({ error: 'edit_reason is required' });
    }

    const created = await timeTracking.adminAddEntry({
      technician_id,
      clock_in,
      clock_out,
      notes,
      edit_reason: edit_reason.trim(),
      edited_by: req.technicianId,
    });
    res.status(201).json(created);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// PUT /entries/:id — admin edit (requires edit_reason)
// ---------------------------------------------------------------------------
router.put('/entries/:id', requireAdmin, async (req, res, next) => {
  try {
    const { clock_in, clock_out, entry_type, notes, edit_reason } = req.body || {};
    if (typeof edit_reason !== 'string' || !edit_reason.trim()) {
      return res.status(400).json({ error: 'edit_reason is required' });
    }

    const updated = await timeTracking.adminEditEntry(req.params.id, {
      clock_in,
      clock_out,
      entry_type,
      notes,
      edit_reason: edit_reason.trim(),
      edited_by: req.technicianId,
    });
    res.json(updated);
  } catch (err) {
    next(err);
  }
});

// ---------------------------------------------------------------------------
// POST /entries/:id/confirm-auto-close — an admin confirms a shift the system
// closed (GATE_SHIFT_CLOSE_REVIEW) as it stands. Changes no time; clears the
// "needs review" flag so the technician's pay run line is no longer held.
// Editing the clock-out (PUT above) clears it too.
// ---------------------------------------------------------------------------
router.post('/entries/:id/confirm-auto-close', requireAdmin, async (req, res, next) => {
  try {
    const entry = await timeTracking.confirmAutoClose(req.params.id, { reviewed_by: req.technicianId });
    res.json({ success: true, entry });
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
    const badDate = dateFilterError(req.query);
    if (badDate) return res.status(400).json({ error: badDate });
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
    const badDate = dateFilterError(req.query);
    if (badDate) return res.status(400).json({ error: badDate });
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

// time_entries (job, not voided) joined to the scheduled_services row they
// worked, with the columns workDuration reads aliased ss_*. Shared by the
// analytics and comparison reads so both plan minutes the way the planners do.
function jobEntriesWithPlan(start, end, { requireJob = true } = {}) {
  let q = db('time_entries')
    .where('time_entries.entry_type', 'job')
    .where('time_entries.status', '!=', 'voided')
    .whereNotNull('time_entries.duration_minutes');
  if (requireJob) q = q.whereNotNull('time_entries.job_id');
  return applyStaffEntryWorkDateRange(q, start, end)
    .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
    .leftJoin('scheduled_services', 'time_entries.job_id', 'scheduled_services.id')
    .select(
      'technicians.name as tech_name',
      'time_entries.technician_id',
      'time_entries.job_id',
      'time_entries.service_type',
      'time_entries.duration_minutes',
      'scheduled_services.id as ss_id',
      'scheduled_services.visit_id as ss_visit_id',
      'scheduled_services.service_type as ss_service_type',
      'scheduled_services.is_recurring as ss_is_recurring',
      'scheduled_services.is_callback as ss_is_callback',
      'scheduled_services.window_start as ss_window_start',
      'scheduled_services.window_end as ss_window_end',
      'scheduled_services.estimated_duration_minutes as ss_estimated_duration_minutes',
    );
}

// A grouped visit runs on one timer tied to its primary member, so its planned
// minutes must come from EVERY live member, totalled the way the scheduler
// totals a stop (day-quality's coVisitOnSiteMinutes). Completed members count
// (the work was done); cancelled / skipped / rescheduled / no-show ones do not.
async function withVisitGroupMinutes(entryRows) {
  const visitIds = [...new Set(entryRows.map((r) => r.ss_visit_id).filter((id) => id != null))];
  if (!visitIds.length) return entryRows;
  const { dayStopSelect, coVisitOnSiteMinutes } = require('../services/scheduling/day-quality');
  const { NOT_A_ROUTE_STOP_STATUSES } = require('../services/stops-ahead');
  const members = await db('scheduled_services')
    .leftJoin('customers', 'scheduled_services.customer_id', 'customers.id')
    .whereIn('scheduled_services.visit_id', visitIds)
    .whereNotIn('scheduled_services.status', NOT_A_ROUTE_STOP_STATUSES)
    .select(...dayStopSelect(db));
  const byVisit = new Map();
  for (const m of members) {
    if (!byVisit.has(m.visit_id)) byVisit.set(m.visit_id, []);
    byVisit.get(m.visit_id).push(m);
  }
  const minutesByVisit = new Map([...byVisit].map(([id, rows]) => [id, coVisitOnSiteMinutes(rows)]));
  return analyticsMath.applyVisitGroupMinutes(entryRows, minutesByVisit);
}

// ---------------------------------------------------------------------------
// GET /analytics — actual vs estimated, utilization, RPMH, overtime
// ---------------------------------------------------------------------------
router.get('/analytics', requireAdmin, async (req, res, next) => {
  try {
    const badDate = dateFilterError(req.query);
    if (badDate) return res.status(400).json({ error: badDate });
    const { startDate, endDate, technicianId } = req.query;
    const now = new Date();
    const { start, end } = staffAnalyticsDateRange({ startDate, endDate }, now);

    // Every completed job timer in the range (linked to a scheduled row or
    // not), collapsed ONCE into physical stops; each table below reads the
    // same stops. Planned minutes come from the planners' workDuration.
    let entryQuery = jobEntriesWithPlan(start, end, { requireJob: false });
    if (technicianId) entryQuery = entryQuery.where('time_entries.technician_id', technicianId);
    const stops = analyticsMath.collapseEntriesToStops(await withVisitGroupMinutes(await entryQuery));
    // Actual vs estimated by service type (stops linked to a scheduled row).
    const serviceTypeStats = analyticsMath.buildServiceTypeStats(stops);

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
        db.raw("to_char(time_weekly_summary.week_start, 'YYYY-MM-DD') as week_start"),
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
        db.raw("to_char(time_weekly_summary.week_start, 'YYYY-MM-DD') as week_start"),
        'time_weekly_summary.overtime_minutes',
        'time_weekly_summary.utilization_pct',
      )
      .orderBy('time_weekly_summary.week_start');

    // Efficiency: budget (planned minutes of the stops done) over the shift.
    // The denominator is read from the shift entries themselves, with an open
    // shift counted up to now — the daily summary is only written at clock-out
    // or overnight, so it would leave today's jobs over no shift at all.
    let shiftQuery = applyStaffEntryWorkDateRange(
      db('time_entries')
        .where('time_entries.entry_type', 'shift')
        .where('time_entries.status', '!=', 'voided'),
      start,
      end,
    )
      .leftJoin('technicians', 'time_entries.technician_id', 'technicians.id')
      .select(
        'technicians.name as tech_name',
        'time_entries.technician_id',
        'time_entries.duration_minutes',
        'time_entries.clock_in',
        'time_entries.status',
      );
    if (technicianId) shiftQuery = shiftQuery.where('time_entries.technician_id', technicianId);
    const liveShiftRows = analyticsMath.buildLiveShiftRows(await shiftQuery, now);
    const efficiencyByTech = analyticsMath.buildEfficiencyByTech(stops, liveShiftRows);

    // Booked ahead: the scheduler's own day-quality measurement for the next
    // 3 ET weeks from today — physical stops and co-visit-aware on-site
    // minutes, the same numbers the route scorecard plans with.
    const today = staffWorkDate(now);
    const weekStarts = analyticsMath.loadAheadWeekStarts(now);
    const lastWeekEnd = addStaffWorkDays(weekStarts[weekStarts.length - 1], 6);
    const { getScheduleQualityMeasurements } = require('../services/scheduling/day-quality');
    const ahead = await getScheduleQualityMeasurements(
      { date_from: today, date_to: lastWeekEnd, includeStopExtras: true }, db, now,
    );
    const aheadDays = ahead && !ahead.error ? ahead.days : [];

    // Trailing 4 completed weeks of what the team actually clocked.
    const thisWeek = weekStarts[0];
    let trailingQuery = db('time_weekly_summary')
      .where('week_start', '>=', addStaffWorkDays(thisWeek, -28))
      .where('week_start', '<', thisWeek)
      .select(
        db.raw("to_char(week_start, 'YYYY-MM-DD') as week_start"),
        'total_job_minutes',
        'total_shift_minutes',
      );
    if (technicianId) trailingQuery = trailingQuery.where('technician_id', technicianId);
    const trailingRows = await trailingQuery;

    res.json({
      serviceTypeStats,
      utilizationByTech,
      rpmhByTech,
      overtimeTrend,
      efficiencyByTech,
      efficiencyBands: analyticsMath.EFFICIENCY_BANDS,
      loadAhead: {
        weeks: analyticsMath.buildLoadAhead(aheadDays, now, { technicianId: technicianId || null }),
        trailing: analyticsMath.buildTrailing(trailingRows),
      },
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
    const badDate = dateFilterError(req.query);
    if (badDate) return res.status(400).json({ error: badDate });
    const { startDate, endDate } = req.query;
    const { start, end } = staffAnalyticsDateRange({ startDate, endDate });

    const rows = await withVisitGroupMinutes(await jobEntriesWithPlan(start, end, { requireJob: false }));
    const comparison = analyticsMath.buildComparison(analyticsMath.collapseEntriesToStops(rows));

    res.json(comparison);
  } catch (err) {
    next(err);
  }
});

// ═══════════════════════════════════════════════════════════════════
// TECHNICIAN MANAGEMENT — CRUD
// ═══════════════════════════════════════════════════════════════════

// The company Google address a Hired press would turn on as this row's only
// sign-in, or null. With one, Hired makes a Google-only account: no password,
// no link, no email. It needs:
// - staff Google sign-in ready (gate and Google client) and a linked address
//   the Team tab's link writer takes today;
// - a row that never held a sign-in: no password, no sign-in on record
//   (last_login_at; changing a Google link clears the pinned id), no Google
//   account id pinned, no two-step enrollment. So this press only adds a
//   sign-in. It has nothing of an earlier account to carry over or to remove;
//   a person who had an account before is turned on again from the edit form;
// - a row that is not an office (admin) login: two-step sign-in setup asks
//   for the account password, and GATE_ADMIN_MFA_ENFORCE holds an admin with
//   no authenticator on that setup page, so a Google-only admin could never
//   get past it. The table refuses the mark on an admin row as well.
function hireGoogleAddress(tech) {
  if (!tech.google_email || !googleSignin.googleSigninReady()) return null;
  // A technician row only: an admin needs a password for two-step setup, and
  // a row with no role cannot sign in at all (the column allows NULL).
  if (tech.role !== 'technician') return null;
  // (password_hash: any value, as the table CHECK reads it; an empty string is not NULL.)
  if (tech.password_hash != null || tech.last_login_at || tech.google_sub || tech.mfa_enabled_at) return null;
  return googleSignin.normalizeLinkedGoogleEmail(tech.google_email).value || null;
}

// Whether a Google-only account can sign in today, for the row's label: the
// Team tab hides the linked address with the gate off, so the page cannot
// tell these apart itself. Each state names its own way out.
function googleOnlyState(tech) {
  if (!googleSignin.googleSigninReady()) return 'off';
  if (!tech.google_email) return 'unlinked';
  return googleSignin.normalizeLinkedGoogleEmail(tech.google_email).value ? 'ready' : 'bad_address';
}

// The Hired button state of a Team row, derived from columns that never leave
// the server. A prospective row whose linked Google address can sign in gets
// the Google Hired press (hire_action 'hire', hire_login 'google'); the press
// makes a Google-only login and mails nothing. hire_google_only says how a
// Google-only account stands today. A Google-only account (google_only_login_at,
// set by the Hired press) has no password by design.
function hireStateFor(tech) {
  const status = tech.employment_status || (tech.active ? 'active' : 'inactive');
  const googleOnly = Boolean(tech.google_only_login_at);
  const hireGoogle = status === 'prospective' ? hireGoogleAddress(tech) : null;
  // A prospective row that was made Google-only, still has a Google address
  // and is past the Google press (the person signed in before, or the address
  // cannot sign in today): no press applies, so the row offers none and says
  // what to do.
  const returning = status === 'prospective' && googleOnly && Boolean(tech.google_email) && !hireGoogle;
  // null, or how a Google-only account stands today: 'ready', 'unlinked'
  // (no address), 'bad_address' (outside the sign-in domains) or 'off'
  // (staff Google sign-in off or not set up). 'returning' = the prospective
  // row above while its address can sign in; otherwise that row says why it
  // cannot ('off': the link cannot be cleared until the gate is on again).
  let googleOnlyLabel = null;
  if (returning) {
    const standing = googleOnlyState(tech);
    googleOnlyLabel = standing === 'ready' ? 'returning' : standing;
  } else if (googleOnly && status === 'active' && tech.active === true) {
    googleOnlyLabel = googleOnlyState(tech);
  }
  return {
    // For the Google press the Hired form sends back the address it showed,
    // and the press is refused when the row no longer holds that address.
    ...(hireGoogle ? { hire_action: 'hire', hire_login: 'google' } : {}),
    ...(googleOnlyLabel ? { hire_google_only: googleOnlyLabel } : {}),
  };
}

// GET /technicians — list all technicians (including inactive).
// Tech-role tokens get the rows with payroll/PII columns stripped;
// admin tokens get the full rows. Keeping the route accessible to
// techs preserves the pre-existing dispatch/team-roster use cases
// without exposing each coworker's wage, DOB, address, etc.
async function listTechnicians(req, res, next) {
  try {
    const techs = await db('technicians')
      .orderByRaw("CASE employment_status WHEN 'active' THEN 0 WHEN 'prospective' THEN 1 ELSE 2 END")
      .orderBy('name');
    // Presign photo_s3_key into avatar_url for the response. After
    // PR #344 photo uploads write only photo_s3_key (no row-level URL
    // baked in); consumers (TeamTab list, dispatch board /board)
    // resolve to a fresh presigned URL inside their own auth boundary.
    // This route is admin-authed so presigning is safe.
    const { resolveTechPhotoUrl } = require('../services/tech-photo');
    const callerIsAdmin = isAdminCaller(req);
    // One grouped read for the roster's capability counts (qualified /
    // needs review / off / not set) — the editor itself lives at
    // GET /technicians/:id/capabilities.
    const summaries = await summarizeCapabilities(db, techs.map((t) => t.id));
    // Admins also get each row's hire action (hire_action turns the Hired
    // button on): see hireStateFor. A technician caller gets none.
    // A technician sees active coworkers only: no prospective hires, no staff
    // who left. Its own row always stays.
    const visible = callerIsAdmin
      ? techs
      : techs.filter((t) => t.id === req.technicianId || t.employment_status === 'active');
    const enriched = await Promise.all(visible.map(async (t) => {
      const row = {
        ...t,
        avatar_url: await resolveTechPhotoUrl(t.photo_s3_key, t.avatar_url),
        capability_summary: summaries.get(t.id),
        ...(callerIsAdmin ? hireStateFor(t) : {}),
      };
      return callerIsAdmin ? sanitizeTechForAdmin(row) : sanitizeTechForNonAdmin(row, req.technicianId);
    }));
    res.json({
      technicians: enriched,
      ...(techWorkDaysLive() ? { workDaysEnabled: true } : {}),
      ...(techShiftHoursOn() ? { shiftHoursEnabled: true } : {}),
      ...(serviceLineMapOn() ? { serviceLinesEnabled: true } : {}),
      ...(territoryReadoutOn() ? { territoryReadoutEnabled: true } : {}),
      ...(callerIsAdmin && googleSignin.staffGoogleSigninLive() ? { googleSigninEnabled: true } : {}),
    });
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

// A pay rate must be a number from 0 to 999999.99 (the column is decimal(8,2)). Whether it clears
// the Florida minimum wage is decided when a pay run is drafted, not at save.
const PAY_RATE_CHECK = ['payRate', (v) => typeof v !== 'boolean' && Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 999999.99,
  'Pay rate must be a number between 0 and 999999.99'];

// Absent, null or '' keeps or clears the column (applyPayrollProfileFields); any other value must pass.
function payRateError(body) {
  const [key, valid, message] = PAY_RATE_CHECK;
  return body[key] != null && body[key] !== '' && !valid(body[key]) ? message : null;
}

// A hire date must be a calendar date, YYYY-MM-DD. PostgreSQL's date type also takes a year past 9999 (one key too many in
// the date box) and 'infinity', and no pay code can work an anniversary out from those. Absent, null or '' keeps or clears
// the column, as for the pay rate.
function hireDateError(body) {
  return body.hireDate != null && body.hireDate !== '' && !validDateOnly(body.hireDate) ? 'Hire date must be a valid YYYY-MM-DD date' : null;
}

function dobError(body) {
  return body.dob != null && body.dob !== '' && !validDateOnly(body.dob) ? 'Date of birth must be a valid YYYY-MM-DD date' : null;
}

function employmentTypeError(body) {
  const v = body.employmentType;
  return v != null && v !== '' && !['w2', '1099'].includes(v) ? "Employment type must be 'w2' or '1099'" : null;
}

function jobTitleError(body) {
  const v = body.jobTitle;
  return v != null && v !== '' && (typeof v !== 'string' || v.length > 100) ? 'Job title must be 100 characters or fewer' : null;
}

function ssnLast4Error(body) {
  const v = body.ssnLast4;
  if (v == null || v === '') return null;
  if (typeof v !== 'string' && typeof v !== 'number') return 'SSN last 4 must be 4 digits';
  const digits = String(v).replace(/\D/g, '');
  return digits.length === 4 ? null : 'SSN last 4 must be 4 digits';
}

function profileFieldError(body) {
  if (body.name !== undefined && typeof body.name === 'string' && body.name.trim().length > 120) {
    return 'Name must be 120 characters or fewer';
  }
  return [payRateError, hireDateError, dobError, employmentTypeError, jobTitleError, ssnLast4Error, supplyStoreError]
    .map((check) => check(body))
    .find(Boolean) || null;
}

// One audit row when a save changes the pay rate (the old and new rate only; no other pay data).
async function auditPayRateChange(trx, req, target, updates) {
  if (!('pay_rate' in updates)) return;
  const oldRate = target.pay_rate == null ? null : Number(target.pay_rate);
  const newRate = updates.pay_rate == null ? null : Number(updates.pay_rate);
  if (oldRate === newRate) return;
  await recordAuditEvent({
    trx, critical: true, actor_type: 'admin', actor_id: req.technicianId || null,
    action: 'payroll.pay_rate_changed', resource_type: 'technicians', resource_id: target.id,
    metadata: { technician_id: target.id, old_pay_rate: oldRate, new_pay_rate: newRate },
  });
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

function disconnectRevokedStaffSessions(technicianId, reason) {
  try {
    const { disconnectStaffSockets } = require('../sockets');
    disconnectStaffSockets(technicianId, reason);
  } catch (error) {
    logger.error(`[team] Live-session disconnect failed for technician id=${technicianId} (${error.message})`);
  }
}

// Non-terminal visits from today (ET) forward still assigned to a tech —
// listed on offboarding for manual reassignment, never modified.
function listFutureAssignedVisits(conn, technicianId) {
  return conn('scheduled_services as s')
    .leftJoin('customers as c', 's.customer_id', 'c.id')
    .where('s.technician_id', technicianId)
    .where('s.scheduled_date', '>=', etDateString(new Date()))
    .whereNotIn('s.status', ['completed', 'cancelled', 'skipped', 'no_show', 'rescheduled'])
    .orderBy('s.scheduled_date')
    .select('s.id', 's.scheduled_date', 's.service_type', 's.service_id', 's.service_key_snapshot', 'c.first_name', 'c.last_name',
      's.window_start', 's.window_end', 's.estimated_duration_minutes');
}

function formatFutureAssignedVisits(rows) {
  return (rows || []).map((v) => ({
    id: v.id,
    scheduledDate: v.scheduled_date,
    serviceType: v.service_type,
    customerName: [v.first_name, v.last_name].filter(Boolean).join(' ') || null,
  }));
}

// What a save of the shift hours tells the office (GATE_TECH_SHIFT_HOURS, D4): the technician's visits from
// today (ET) forward that the hours this save set do not hold. They are the visits an office save gets the
// shift line for (shiftWarning: on a day the technician works, the visit's own minutes, today on the hours
// of the clock-in). Listed for the office to move or reassign; never modified, as on offboarding.
// An estimate's slot hold (no customer, a reservation stamp) is not a visit: nobody has booked it, and it is
// left out (the filter of occupancy.js and tech-open-visit-nudge.js).
// {} and no read with the gate off, when the save left the hours as they were, or when the technician now
// has no set hours.
// The reads run in a savepoint of the save's transaction (as dayWarningsFor): a read that fails is logged
// and gives no list, and the save goes on to its commit. The list never fails a save.
async function outsideNewShiftReply(conn, before, tech) {
  const [was, now] = [storedShift(before), storedShift(tech)];
  if (!techShiftHoursOn() || !now || (was && was.startMin === now.startMin && was.endMin === now.endMin)) return {};
  try {
    return await conn.transaction(async (sp) => {
      const shiftOf = await loadTechShifts(sp, { technicianIds: [tech.id] });
      const visits = await listFutureAssignedVisits(sp, tech.id)
        .where((q) => q.whereNotNull('s.customer_id').orWhereNull('s.reservation_expires_at'));
      const outside = visits.filter((visit) => !isOffDay(tech, visit.scheduled_date)
        && shiftWarning(tech, shiftOf(tech.id, visit.scheduled_date), rowBlockMinutes(visit)));
      return { outsideShiftVisits: formatFutureAssignedVisits(outside) };
    });
  } catch (err) {
    logger.warn(`[admin-timetracking] the visits outside the new shift hours were not read (${err.message}): the hours are saved, with no list`);
    return {};
  }
}

// A staff row with any operational or pay history is a person, not a slot.
async function technicianHasHistory(conn, technicianId) {
  const tables = [
    'scheduled_services',
    'service_records',
    'time_entries',
    'review_incentive_payouts',
    'payroll_checks',
    'payroll_pay_lines',
    'payroll_time_off',
    'payroll_w4_elections',
  ];
  for (const table of tables) {
    if (await conn(table).where({ technician_id: technicianId }).first('id')) return true;
  }
  return false;
}

// Owner-only lifecycle (owner ruling 2026-09-28): a non-owner admin must not
// change, delete or re-credential the full-access (owner) row. assertMayChangeFullAccessEmail
// covers the email field only; this covers the rest of the row's lifecycle.
function ownerRowRefusal(req, target) {
  return isFullAccessEmail(target.email) && !ibFullAccess(req)
    ? { error: 'Only the owner account can change this staff account.' }
    : null;
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
// Team-tab tech line input (Field Team Program, Phase 0 item 3): '' / null
// clears the line; anything else must be a registry `fieldTech` number. The
// holder check runs under the technicians table lock; the partial unique
// index (technicians_twilio_number_unique) is the DB fence behind it.
const TECH_LINE_TAKEN = { error: 'That tech line is already assigned to another technician', code: 'TECH_LINE_TAKEN' };
const EMAIL_IN_USE = { error: 'Email already in use' };
// Transaction outcomes the two writers answer with a 409, in check order.
const TECH_WRITE_CONFLICTS = { conflict: EMAIL_IN_USE, lineTaken: TECH_LINE_TAKEN };

// Returns { error } or { patch } — patch is {} when the field was omitted,
// { twilio_number: null } to clear, { twilio_number } for a registry line.
function normalizeTechLine(raw) {
  if (raw === undefined) return { patch: {} };
  if (raw === null || raw === '') return { patch: { twilio_number: null } };
  if (typeof raw !== 'string' || !TWILIO_NUMBERS.fieldTech.some((t) => t.number === raw)) {
    return { error: 'twilioNumber must be one of the registered tech lines' };
  }
  return { patch: { twilio_number: raw } };
}

async function techLineHeldByAnother(trx, number, excludeId) {
  if (!number) return false;
  const q = trx('technicians').where({ twilio_number: number });
  if (excludeId) q.whereNot({ id: excludeId });
  return Boolean(await q.first('id'));
}

function conflictResponse(res, outcome) {
  const key = Object.keys(TECH_WRITE_CONFLICTS).find((k) => outcome[k]);
  return key ? res.status(409).json(TECH_WRITE_CONFLICTS[key]) : null;
}

// The DB fences behind the in-transaction checks (email canonical index,
// technicians_twilio_number_unique) map to the same two 409 bodies.
function uniqueViolationBody(err) {
  if (err.code !== '23505') return null;
  return err.constraint === 'technicians_twilio_number_unique' ? TECH_LINE_TAKEN : EMAIL_IN_USE;
}

// Team tab "Can create estimates" switch (GATE_TECH_ESTIMATES): a boolean, off for every new row.
function canCreateEstimatesInput(body) {
  if (body.canCreateEstimates === undefined) return { patch: {} };
  if (typeof body.canCreateEstimates !== 'boolean') return { error: 'canCreateEstimates must be a boolean' };
  return { patch: { can_create_estimates: body.canCreateEstimates } };
}

async function createTechnician(req, res, next) {
  try {
    const body = req.body || {};
    const { name, phone, email, autoFlipEnabled, employmentStatus, fieldDispatchable, canMoveVisits } = body;
    if (typeof name !== 'string' || !name.trim()) {
      return res.status(400).json({ error: 'Name is required' });
    }
    // Team-tab profiles default to active (legacy behavior). A placeholder
    // for a hire who has not started is created as `prospective`: no email
    // needed, no sign-in, no slots, no capacity, never on a customer surface.
    const status = employmentStatus === undefined ? 'active' : employmentStatus;
    if (!isEmploymentStatus(status) || status === 'inactive') {
      return res.status(400).json({ error: "employmentStatus must be 'active' or 'prospective'" });
    }
    if (fieldDispatchable !== undefined && typeof fieldDispatchable !== 'boolean') {
      return res.status(400).json({ error: 'fieldDispatchable must be a boolean' });
    }
    if (canMoveVisits !== undefined && typeof canMoveVisits !== 'boolean') {
      return res.status(400).json({ error: 'canMoveVisits must be a boolean' });
    }
    const normalizedEmail = normalizeTechnicianEmail(email);
    if (normalizedEmail.error) return res.status(400).json({ error: normalizedEmail.error });
    // Owner-only access model (owner ruling 2026-09-28) — a brand-new row
    // has nothing to strip (fromEmail: null), only a possible assignment.
    const fullAccessEmailGuard = assertMayChangeFullAccessEmail(req, { fromEmail: null, toEmail: normalizedEmail.value });
    if (fullAccessEmailGuard) return res.status(403).json(fullAccessEmailGuard);
    if (!normalizedEmail.value && status === 'active') {
      return res.status(400).json({ error: 'An active technician requires a valid staff email' });
    }
    const techLine = normalizeTechLine(body.twilioNumber);
    if (techLine.error) return res.status(400).json({ error: techLine.error });
    const workDays = normalizeWorkDaysInput(body.workDays);
    if (workDays.error) return res.status(400).json({ error: workDays.error });
    const shiftHours = normalizeShiftHoursInput(body.shiftHours);
    if (shiftHours.error) return res.status(400).json({ error: shiftHours.error });
    const badProfile = profileFieldError(body);
    if (badProfile) return res.status(400).json({ error: badProfile });

    const insertRow = {
      name: name.trim(),
      phone: phone || null,
      email: normalizedEmail.value ?? null,
      ...employmentPatch(status),
      // Field eligibility is granted deliberately on the Team tab, never by
      // the row existing (Field Team Program: assignment ≠ employment).
      field_dispatchable: fieldDispatchable === true,
      // A technician added now starts unable to move visits (the column default)
      // unless the owner ticks the switch in the add form.
      can_move_visits: canMoveVisits === true,
    };
    // Honor the create-form's auto-flip checkbox. Without this, an
    // operator unchecking "Auto-flip enabled" during creation would
    // see the value silently dropped and the row created at the
    // column DEFAULT (TRUE), needing a second edit to actually opt
    // the tech out. Falsy explicit value → false; undefined → leave
    // it to the column DEFAULT.
    if (autoFlipEnabled !== undefined) insertRow.auto_flip_enabled = !!autoFlipEnabled;
    Object.assign(insertRow, techLine.patch);
    Object.assign(insertRow, workDays.patch);
    Object.assign(insertRow, shiftHours.patch);
    Object.assign(insertRow, supplyStorePatch(body.supplyStore));
    applyPayrollProfileFields(insertRow, body);

    const outcome = await db.transaction(async (trx) => {
      await lockTechnicianMutations(trx);
      if (insertRow.email && await findTechnicianByMailbox(trx, insertRow.email)) {
        return { conflict: true };
      }
      if (await techLineHeldByAnother(trx, insertRow.twilio_number)) return { lineTaken: true };
      const [tech] = await trx('technicians').insert(insertRow).returning('*');
      if (insertRow.pay_rate != null) {
        await auditPayRateChange(trx, req, { id: tech.id, pay_rate: null }, { pay_rate: insertRow.pay_rate });
      }
      // Every hire starts able to take every service, pending review — the
      // Team tab's Capabilities editor is where a category becomes Qualified.
      await seedNewHireCapabilities(trx, tech.id);
      return { tech };
    });
    const rejected = conflictResponse(res, outcome);
    if (rejected) return rejected;

    const { tech } = outcome;
    // Log id + structural state only; the row now carries payroll/PII
    // so names stay out of logs per AGENTS.md.
    logger.info(`[team] Added technician id=${tech.id} (employment_status=${tech.employment_status}, field_dispatchable=${tech.field_dispatchable}, auto_flip_enabled=${tech.auto_flip_enabled})`);
    return res.json({ success: true, technician: sanitizeTechForAdmin(tech) });
  } catch (err) {
    const dup = uniqueViolationBody(err);
    if (dup) return res.status(409).json(dup);
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
    const { name, phone, email, autoFlipEnabled, employmentStatus, fieldDispatchable, canMoveVisits } = body;
    if (name !== undefined && (typeof name !== 'string' || !name.trim())) {
      return res.status(400).json({ error: 'Name cannot be empty' });
    }
    if (body.active !== undefined && typeof body.active !== 'boolean') {
      return res.status(400).json({ error: 'active must be a boolean' });
    }
    if (employmentStatus !== undefined && !isEmploymentStatus(employmentStatus)) {
      return res.status(400).json({ error: "employmentStatus must be 'prospective', 'active', or 'inactive'" });
    }
    if (fieldDispatchable !== undefined && typeof fieldDispatchable !== 'boolean') {
      return res.status(400).json({ error: 'fieldDispatchable must be a boolean' });
    }
    if (canMoveVisits !== undefined && typeof canMoveVisits !== 'boolean') {
      return res.status(400).json({ error: 'canMoveVisits must be a boolean' });
    }
    const estimateSwitch = canCreateEstimatesInput(body);
    if (estimateSwitch.error) return res.status(400).json({ error: estimateSwitch.error });
    // Legacy `active` boolean input maps onto employment status; an explicit
    // employmentStatus wins when both are sent.
    const requestedStatus = employmentStatus !== undefined
      ? employmentStatus
      : (body.active === undefined ? undefined : (body.active ? 'active' : 'inactive'));
    // `active` below is the derived legacy view of the requested status; the
    // existing deactivation safeguards key off it.
    const active = requestedStatus === undefined ? undefined : requestedStatus === 'active';
    const normalizedEmail = normalizeTechnicianEmail(email);
    if (normalizedEmail.error) return res.status(400).json({ error: normalizedEmail.error });
    const techLine = normalizeTechLine(body.twilioNumber);
    if (techLine.error) return res.status(400).json({ error: techLine.error });
    const startPoint = normalizeStartPoint(body.startPoint);
    if (startPoint.error) return res.status(400).json({ error: startPoint.error });
    const workDays = normalizeWorkDaysInput(body.workDays);
    if (workDays.error) return res.status(400).json({ error: workDays.error });
    const shiftHours = normalizeShiftHoursInput(body.shiftHours);
    if (shiftHours.error) return res.status(400).json({ error: shiftHours.error });
    const badBody = profileFieldError(body);
    if (badBody) return res.status(400).json({ error: badBody });

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
      const emailChanged = email !== undefined && normalizedEmail.value !== storedEmail;
      if (emailChanged) {
        const fullAccessEmailGuard = assertMayChangeFullAccessEmail(req, { fromEmail: storedEmail, toEmail: normalizedEmail.value });
        if (fullAccessEmailGuard) return { fullAccessEmailGuard };
      }
      // Protect EVERY field on the owner (full-access) row — pay rate, SSN, DOB,
      // capabilities, dispatchable status, etc. — not just active/inactive changes.
      const ownerRowGuard = ownerRowRefusal(req, target);
      if (ownerRowGuard) return { ownerRowGuard };
      const currentStatus = target.employment_status || (target.active ? 'active' : 'inactive');
      const activeChanged = requestedStatus !== undefined && requestedStatus !== currentStatus;
      if (await techLineHeldByAnother(trx, techLine.patch.twilio_number, target.id)) return { lineTaken: true };

      const resultingEmail = email === undefined ? storedEmail : normalizedEmail.value;
      const resultingActive = active === undefined ? Boolean(target.active) : active;
      if (resultingActive && !resultingEmail) return { missingEmail: true };
      // Identity is never recycled: once a row carries service, time, or
      // payout history, a rename would move that history onto a different
      // person. A replacement hire gets a new row.
      if (name !== undefined && name.trim() !== target.name && await technicianHasHistory(trx, target.id)) {
        return { renameLocked: true };
      }

      if (active === false) {
        const blocker = await deactivationBlocker(trx, target, req.technicianId);
        if (blocker) return { blocker };
        const activeTimer = await trx('time_entries')
          .where({ technician_id: target.id, status: 'active' })
          .forUpdate()
          .first('id');
        if (activeTimer) return { activeTimer: true };
      }
      if (normalizedEmail.value && await findTechnicianByMailbox(
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
      if (requestedStatus !== undefined) Object.assign(updates, employmentPatch(requestedStatus));
      if (fieldDispatchable !== undefined) updates.field_dispatchable = fieldDispatchable;
      if (canMoveVisits !== undefined) updates.can_move_visits = canMoveVisits;
      Object.assign(updates, estimateSwitch.patch);
      Object.assign(updates, techLine.patch);
      Object.assign(updates, startPoint.patch);
      Object.assign(updates, supplyStorePatch(body.supplyStore));
      Object.assign(updates, workDays.patch);
      Object.assign(updates, shiftHours.patch);

      // Any transition that leaves `active` (→ inactive OR → prospective)
      // revokes sessions; entering active from prospective also rotates so a
      // token minted under the old state cannot carry over.
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
      await auditPayRateChange(trx, req, target, updates);

      const revokeAccess = credentialsChanged || active === false;
      if (revokeAccess) await PushService.deactivateStaffUser(target.id, trx);
      const tech = await trx('technicians').where({ id: target.id }).first();
      // Leaving the assignable pool through Edit — inactive, prospective, OR
      // field eligibility removed — surfaces the same remaining-assignment
      // list the DELETE path returns; visits are never touched here.
      const futureAssignedVisits = isAssignable(target) && !isAssignable(tech)
        ? await listFutureAssignedVisits(trx, target.id)
        : [];
      return {
        tech,
        futureAssignedVisits,
        shiftReply: await outsideNewShiftReply(trx, target, tech),
        revokeAccess,
        revocationReason: active === false
          ? 'account_deactivated'
          : activeChanged
            ? 'account_status_changed'
            : 'email_changed',
      };
    });

    if (outcome.notFound) return res.status(404).json({ error: 'Technician not found' });
    if (outcome.fullAccessEmailGuard) return res.status(403).json(outcome.fullAccessEmailGuard);
    if (outcome.ownerRowGuard) return res.status(403).json(outcome.ownerRowGuard);
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
    const rejected = conflictResponse(res, outcome);
    if (rejected) return rejected;
    if (outcome.renameLocked) {
      return res.status(409).json({
        error: 'This staff record already has service, time, or payout history and cannot be renamed. Add the new hire as a separate record.',
        code: 'IDENTITY_LOCKED',
      });
    }

    const { tech } = outcome;
    if (outcome.revokeAccess) {
      disconnectRevokedStaffSessions(tech.id, outcome.revocationReason);
    }
    logger.info(`[team] Updated technician id=${tech.id} (employment_status=${tech.employment_status}, field_dispatchable=${tech.field_dispatchable}, auto_flip_enabled=${tech.auto_flip_enabled})`);
    return res.json({
      success: true,
      technician: sanitizeTechForAdmin(tech),
      futureAssignedVisits: formatFutureAssignedVisits(outcome.futureAssignedVisits),
      ...outcome.shiftReply,
    });
  } catch (err) {
    const dup = uniqueViolationBody(err);
    if (dup) return res.status(409).json(dup);
    return next(err);
  }
}

router.put('/technicians/:id', requireAdmin, updateTechnician);

// PUT /technicians/:id/google-signin { googleEmail } — link (or, with null or
// '', clear) the company Google account this staff member signs in with
// (GATE_STAFF_GOOGLE_SIGNIN). A new link waits for its first sign-in to pin
// Google's account id. Moving or clearing an existing link forgets that id and
// signs the person out everywhere, like an email change. Only the owner login
// may change the link on the owner's own row: a link there is a way in.
async function putTechnicianGoogleSignin(req, res, next) {
  try {
    if (!googleSignin.staffGoogleSigninLive()) return res.status(404).json({ error: 'Not found' });
    const parsed = googleSignin.normalizeLinkedGoogleEmail(req.body?.googleEmail);
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const outcome = await db.transaction(async (trx) => {
      await lockTechnicianMutations(trx);
      const target = await trx('technicians').where({ id: req.params.id }).forUpdate().first();
      if (!target) return { notFound: true };
      if (isFullAccessEmail(target.email) && !ibFullAccess(req)) return { ownerOnly: true };
      const current = target.google_email ? target.google_email.toLowerCase() : null;
      if (current === parsed.value) return { tech: target };
      if (parsed.value && await trx('technicians')
        .whereRaw('LOWER(google_email) = ?', [parsed.value])
        .whereNot({ id: target.id })
        .first('id')) {
        return { conflict: true };
      }
      // Nor another staff member's email: that mailbox gets their password reset mail.
      if (parsed.value && await findStaffByCanonicalEmail(trx, parsed.value, target.id)) return { emailConflict: true };
      const revoke = Boolean(current);
      await trx('technicians').where({ id: target.id }).update({
        google_email: parsed.value,
        google_sub: null,
        // Clearing Google sign-in also clears google_only_login_at so the staff
        // member can recover via Forgot password instead of being permanently locked out.
        ...(parsed.value === null ? { google_only_login_at: null } : {}),
        ...(revoke ? { auth_token_version: Number(target.auth_token_version || 0) + 1 } : {}),
        updated_at: new Date(),
      });
      if (revoke) await PushService.deactivateStaffUser(target.id, trx);
      return { tech: await trx('technicians').where({ id: target.id }).first(), revoke };
    });

    if (outcome.notFound) return res.status(404).json({ error: 'Technician not found' });
    if (outcome.ownerOnly) return res.status(403).json({ error: 'Only the owner account can change this Google sign-in.' });
    if (outcome.conflict) return res.status(409).json({ error: 'That Google account is linked to another staff member' });
    if (outcome.emailConflict) return res.status(409).json({ error: "That address is another staff member's email" });
    if (outcome.revoke) disconnectRevokedStaffSessions(outcome.tech.id, 'google_signin_changed');
    logger.info(`[team] Google sign-in ${outcome.tech.google_email ? 'linked' : 'cleared'} for technician id=${outcome.tech.id} (sessions revoked: ${Boolean(outcome.revoke)})`);
    return res.json({ success: true, technician: sanitizeTechForAdmin(outcome.tech) });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That Google account is linked to another staff member' });
    return next(err);
  }
}

router.put('/technicians/:id/google-signin', requireAdmin, putTechnicianGoogleSignin);

// =============================================================================
// HIRED BUTTON, Google press (owner ruling 2026-10-25 D7; staff Google sign-in)
// POST /technicians/:id/hire/google  prospective row -> active Google-only account
// Admin-only. It mails nothing: no link, no email. It answers 404
// { enabled: false } before any database work while staff Google sign-in is
// not ready.
// =============================================================================
const HIRE_EMPLOYMENT_TYPES = ['w2', '1099'];
const HIRE_RENAME_LOCKED = {
  error: 'This staff record already has service, time, or payout history and cannot be renamed. Add the new hire as a separate record.',
  code: 'IDENTITY_LOCKED',
};

// Validate and normalize the hire body with the PUT handler's rules for the
// same fields (canonical email, '' clears a payroll field, name trimmed).
// Returns { error } or { name, email, hireDate, googleEmail, patch } where
// patch carries only the optional fields the caller sent.
// Optional payroll fields: absent, null or '' keeps or clears the column (the
// PUT rule, applied by applyPayrollProfileFields); any other value must pass
// its check, so a bad value is a 400 instead of a database error.
const HIRE_OPTIONAL_FIELD_CHECKS = [
  PAY_RATE_CHECK,
  ['jobTitle', (v) => typeof v === 'string' && v.length <= 100, 'Job title must be 100 characters or fewer'],
  ['employmentType', (v) => HIRE_EMPLOYMENT_TYPES.includes(v), "Employment type must be 'w2' or '1099'"],
];

const HIRE_LOGIN_CHANGED = {
  error: 'The sign-in for this person changed. Reload the page, then press Hired again.',
  code: 'HIRE_LOGIN_CHANGED',
};
const HIRE_GOOGLE_ADDRESS_IN_USE = {
  error: "The linked Google address is another staff member's email. Change the Google sign-in first.",
  code: 'HIRE_GOOGLE_ADDRESS_IN_USE',
};

function parseHireBody(body) {
  if (typeof body.name !== 'string' || !body.name.trim()) return { error: 'Name is required' };
  const normalizedEmail = normalizeTechnicianEmail(body.email);
  if (normalizedEmail.error) return { error: normalizedEmail.error };
  if (!normalizedEmail.value) return { error: 'Email is required' };
  if (!validDateOnly(body.hireDate)) return { error: 'First day must be a valid YYYY-MM-DD date' };
  if (body.phone != null && typeof body.phone !== 'string') return { error: 'Phone must be a string' };
  // The press names the address its form showed.
  const shownGoogle = canonicalStaffEmail(body.googleEmail);
  if (!shownGoogle) return { error: 'Google address must be a valid email' };
  const invalid = HIRE_OPTIONAL_FIELD_CHECKS
    .find(([key, valid]) => body[key] != null && body[key] !== '' && !valid(body[key]));
  if (invalid) return { error: invalid[2] };

  const patch = body.phone === undefined ? {} : { phone: body.phone || null };
  applyPayrollProfileFields(patch, {
    payRate: body.payRate,
    jobTitle: body.jobTitle,
    employmentType: body.employmentType,
  });
  return {
    name: body.name.trim(),
    email: normalizedEmail.value,
    hireDate: body.hireDate,
    googleEmail: shownGoogle,
    patch,
  };
}

// The sign-in the Hired press turns on, decided under the row lock: { google }
// (the address) or { refusal }. The press names the address its form showed
// (shownGoogle). A row that no longer holds exactly that (an address linked,
// cleared, moved to another address or made unusable since the form opened) is
// refused: no press gives a staff login to a Google account the form did not
// show.
async function hireLoginFor(trx, target, shownGoogle) {
  const google = hireGoogleAddress(target);
  if (google !== shownGoogle) return { refusal: HIRE_LOGIN_CHANGED };
  // One mailbox, one staff row (the link writer and every email writer hold
  // the same rule); a row linked before that rule is caught here.
  if (await findTechnicianByMailbox(trx, google, target.id)) {
    return { refusal: HIRE_GOOGLE_ADDRESS_IN_USE };
  }
  return { google };
}

// The credential columns of the Hired press. Google-only. The row held no
// sign-in (hireGoogleAddress, read again under the row lock), so the press only
// adds one: no password and no link. must_change_password stays false, because
// the staff middleware refuses every route while it is true and this account
// has no password to change. The token columns are cleared for the table's CHECK.
function hireCredentialColumns({ now }) {
  return {
    must_change_password: false,
    password_reset_token_hash: null,
    password_reset_expires_at: null,
    password_reset_requested_at: null,
    google_only_login_at: now,
  };
}

// The updated row in the shape GET /technicians returns for an admin.
async function hiredTechnicianResponse(tech) {
  const { resolveTechPhotoUrl } = require('../services/tech-photo');
  const summaries = await summarizeCapabilities(db, [tech.id]);
  return sanitizeTechForAdmin({
    ...tech,
    avatar_url: await resolveTechPhotoUrl(tech.photo_s3_key, tech.avatar_url),
    capability_summary: summaries.get(tech.id),
    ...hireStateFor(tech),
  });
}

async function hireTechnician(req, res, next) {
  try {
    // The Google press mails nothing and belongs to staff Google sign-in;
    // hireLoginFor refuses it unless the row holds exactly the named address
    // as its Google-only sign-in.
    if (!googleSignin.googleSigninReady()) return res.status(404).json({ enabled: false });
    const parsed = parseHireBody(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    const now = new Date();
    const outcome = await db.transaction(async (trx) => {
      // Same global order as every staff identity writer: table lock, then row.
      await lockTechnicianMutations(trx);
      const target = await trx('technicians')
        .where({ id: req.params.id })
        .forUpdate()
        .first();
      if (!target) return { notFound: true };
      if (target.employment_status !== 'prospective') return { notProspective: true };
      const ownerRowGuard = ownerRowRefusal(req, target);
      if (ownerRowGuard) return { ownerRowGuard };

      const storedEmail = canonicalStaffEmail(target.email);
      if (parsed.email !== storedEmail) {
        const fullAccessEmailGuard = assertMayChangeFullAccessEmail(req, { fromEmail: storedEmail, toEmail: parsed.email });
        if (fullAccessEmailGuard) return { fullAccessEmailGuard };
      }
      if (await findTechnicianByMailbox(trx, parsed.email, target.id)) return { conflict: true };
      // A placeholder with history is a person, not a slot (same rule as PUT).
      if (parsed.name !== target.name && await technicianHasHistory(trx, target.id)) {
        return { renameLocked: true };
      }
      const login = await hireLoginFor(trx, target, parsed.googleEmail);
      if (login.refusal) return { loginRefusal: login.refusal };

      await trx('technicians').where({ id: target.id }).update({
        name: parsed.name,
        email: parsed.email,
        hire_date: parsed.hireDate,
        ...parsed.patch,
        ...employmentPatch('active'),
        // Being active never makes someone dispatchable: the Team tab grants
        // field eligibility deliberately.
        field_dispatchable: false,
        ...hireCredentialColumns({ now }),
        // Entering active rotates sessions, as PUT does.
        auth_token_version: Number(target.auth_token_version || 0) + 1,
        updated_at: now,
      });
      if ('pay_rate' in parsed.patch) {
        await auditPayRateChange(trx, req, target, parsed.patch);
      }
      await PushService.deactivateStaffUser(target.id, trx);
      // Ids only: no email, phone or pay in the audit row.
      await recordAuditEvent({
        actor_type: 'admin',
        actor_id: req.technicianId || null,
        action: 'staff.hired',
        resource_type: 'technician',
        resource_id: target.id,
        metadata: { technician_id: target.id },
        critical: true,
        trx,
      });
      // Sync Recruiting's first-days checklist when this prospective hire came
      // from a signed job offer (best-effort inside the transaction).
      try {
        const JobOffers = require('../services/job-offers');
        if (typeof JobOffers.markOfferLoginActivated === 'function') {
          await JobOffers.markOfferLoginActivated(
            trx,
            target.id,
            { id: req.technicianId || null, name: (req.technician && req.technician.name) || null },
            now,
          );
        }
      } catch (syncErr) {
        logger.warn(`[team] job-offer login checklist sync skipped for technician id=${target.id}: ${syncErr.code || syncErr.message}`);
      }
      return { tech: await trx('technicians').where({ id: target.id }).first() };
    });

    if (outcome.notFound) return res.status(404).json({ error: 'Technician not found' });
    if (outcome.notProspective) return res.status(409).json({ error: 'Only a prospective row can be hired.' });
    if (outcome.loginRefusal) return res.status(409).json(outcome.loginRefusal);
    if (outcome.ownerRowGuard) return res.status(403).json(outcome.ownerRowGuard);
    if (outcome.fullAccessEmailGuard) return res.status(403).json(outcome.fullAccessEmailGuard);
    if (outcome.conflict) return res.status(409).json(EMAIL_IN_USE);
    if (outcome.renameLocked) return res.status(409).json(HIRE_RENAME_LOCKED);

    const { tech } = outcome;
    disconnectRevokedStaffSessions(tech.id, 'account_status_changed');
    logger.info(`[team] Hired technician id=${tech.id} (login: google)`);
    // A Google-only hire gets no link and no email: the owner hands over the Google account.
    return res.json({ hired: true, emailed: null, login: 'google', technician: await hiredTechnicianResponse(tech) });
  } catch (err) {
    const dup = uniqueViolationBody(err);
    if (dup) return res.status(409).json(dup);
    return next(err);
  }
}

router.post('/technicians/:id/hire/google', requireAdmin, hireTechnician);

// GET /technicians/:id/capabilities — the dispatch categories for one
// tech, missing rows reported as 'unset'. Admin only: this is the editor's
// read, and capability decisions are a management call.
async function getTechnicianCapabilities(req, res, next) {
  try {
    const tech = await db('technicians').where({ id: req.params.id }).first('id');
    if (!tech) return res.status(404).json({ error: 'Technician not found' });
    const capabilities = await listCapabilities(db, tech.id);
    return res.json({ technicianId: tech.id, capabilities });
  } catch (err) {
    return next(err);
  }
}

// PUT /technicians/:id/capabilities — upsert any subset of the
// categories as { service_category, state, notes }. The caller is stamped as
// verifier. Turning a category Off never touches the schedule: visits already
// assigned in that category are listed back for manual reassignment (same
// shape as leaving the dispatch pool), and auto-dispatch stops offering the
// tech new work in it.
async function putTechnicianCapabilities(req, res, next) {
  try {
    const body = req.body || {};
    const normalized = normalizeCapabilityEntries(body.capabilities);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const { entries } = normalized;

    // A stale entry must roll back EVERY entry in the request (an earlier
    // category may already have been written), so the error escapes the
    // transaction and is translated to 409 outside it.
    let outcome;
    try {
      outcome = await db.transaction(async (trx) => {
        const target = await trx('technicians').where({ id: req.params.id }).forUpdate().first('id', 'email');
        if (!target) return { notFound: true };
        const ownerRowGuard = ownerRowRefusal(req, target);
        if (ownerRowGuard) return { ownerRowGuard };
        await writeCapabilities(trx, target.id, entries, req.technicianId);
        const turnedOff = new Set(entries.filter((e) => e.state === 'off').map((e) => e.service_category));
        let futureAssignedVisits = [];
        if (turnedOff.size) {
          // The same category the capability checks use (catalog first with GATE_TECH_JOB_TYPE_CHECKS).
          const future = await listFutureAssignedVisits(trx, target.id);
          const categories = await categoriesForServices(trx, future);
          futureAssignedVisits = future.filter((v, i) => turnedOff.has(categories[i]));
        }
        const capabilities = await listCapabilities(trx, target.id);
        return { capabilities, futureAssignedVisits };
      });
    } catch (err) {
      if (err.code !== 'CAPABILITY_STALE') throw err;
      return res.status(409).json({ error: err.message, code: err.code, service_category: err.service_category });
    }
    if (outcome.notFound) return res.status(404).json({ error: 'Technician not found' });
    if (outcome.ownerRowGuard) return res.status(403).json(outcome.ownerRowGuard);

    logger.info(`[team] Updated capabilities for technician id=${req.params.id} (${entries.map((e) => `${e.service_category}=${e.state}`).join(', ')}) by staff id=${req.technicianId}`);
    return res.json({
      success: true,
      technicianId: req.params.id,
      capabilities: outcome.capabilities,
      futureAssignedVisits: formatFutureAssignedVisits(outcome.futureAssignedVisits),
    });
  } catch (err) {
    return next(err);
  }
}

router.get('/technicians/:id/capabilities', requireAdmin, getTechnicianCapabilities);
router.put('/technicians/:id/capabilities', requireAdmin, putTechnicianCapabilities);

// PUT /technicians/:id/voice-pin { pin } — set or reset the technician's
// "Waves Tech" voice line PIN (services/tech-voice-pin.js: 4 to 6 digits,
// stored only as a salted hash; a reset also clears a lockout). The PIN is
// never returned or logged; the audit row says who set it, never the value.
const VOICE_PIN_TECH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function putTechnicianVoicePin(req, res, next) {
  try {
    if (!VOICE_PIN_TECH_ID_RE.test(String(req.params.id || ''))) return res.status(404).json({ error: 'Technician not found' });
    const target = await db('technicians').where({ id: req.params.id }).first('id', 'email');
    if (!target) return res.status(404).json({ error: 'Technician not found' });
    const ownerRowGuard = ownerRowRefusal(req, target);
    if (ownerRowGuard) return res.status(403).json(ownerRowGuard);
    const { setTechVoicePin } = require('../services/tech-voice-pin');
    const out = await setTechVoicePin(db, { technicianId: target.id, pin: req.body?.pin });
    if (!out.ok) return res.status(400).json({ error: 'The PIN must be 4 to 6 digits', code: 'PIN_FORMAT' });
    await recordAuditEvent({
      actor_type: 'admin', actor_id: req.technicianId || null, action: 'tech_voice.pin_set',
      resource_type: 'technician', resource_id: String(target.id), metadata: {},
    });
    logger.info(`[team] Set the voice line PIN for technician id=${target.id} by staff id=${req.technicianId}`);
    return res.json({ success: true, technicianId: target.id });
  } catch (err) {
    return next(err);
  }
}
router.put('/technicians/:id/voice-pin', requireAdmin, putTechnicianVoicePin);

// ── Service-line map (GATE_SERVICE_LINE_MAP=shadow|live, owner 2026-10-25 / 2026-10-30) ─
// One home and one gap technician per service line. In shadow, nothing reads this
// to place a visit; the six booking choice points only log what it would pick. In
// live, new /book, phone and after-call bookings and the office Auto choice go to the
// line's home technician, else its gap technician (services/scheduling/line-technician.js).
// Admin only; 404 while the gate is off.
const SERVICE_LINE_KEYS = ['general', 'mosquito', 'lawn', 'rodent', 'exclusion', 'termite'];
const SERVICE_LINE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHADOW_SUMMARY_DEFAULT_DAYS = 14;
const SHADOW_SUMMARY_MAX_DAYS = 90;

function serviceLinesOff(res) {
  if (serviceLineMapOn()) return false;
  res.status(404).json({ error: 'Not found' });
  return true;
}

async function readServiceLines(conn) {
  const rows = await conn('service_line_techs').select('service_category', 'home_technician_id', 'gap_technician_id', 'updated_at');
  const byLine = new Map(rows.map((r) => [r.service_category, r]));
  return SERVICE_LINE_KEYS.map((key) => {
    const row = byLine.get(key);
    return {
      service_category: key,
      home_technician_id: row ? row.home_technician_id : null,
      gap_technician_id: row ? row.gap_technician_id : null,
      updated_at: row ? row.updated_at : null,
    };
  });
}

// PUT body: { lines: [{ service_category, home_technician_id, gap_technician_id }] }.
// Any subset of the lines; a technician id is a uuid or null (cleared).
function normalizeServiceLineEntries(input) {
  if (!Array.isArray(input) || !input.length) return { error: 'lines must be a non-empty array' };
  const seen = new Set();
  const entries = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') return { error: 'Each line must be an object' };
    const key = raw.service_category;
    if (!SERVICE_LINE_KEYS.includes(key)) return { error: `service_category must be one of ${SERVICE_LINE_KEYS.join(', ')}` };
    if (seen.has(key)) return { error: `service_category '${key}' appears more than once` };
    seen.add(key);
    const entry = { service_category: key };
    for (const field of ['home_technician_id', 'gap_technician_id']) {
      const value = raw[field] === '' ? null : raw[field];
      if (value === undefined) return { error: `${field} is required (a technician id, or null for none)` };
      if (value !== null && (typeof value !== 'string' || !SERVICE_LINE_UUID.test(value))) {
        return { error: `${field} must be a technician id or null` };
      }
      entry[field] = value === null ? null : value.toLowerCase();
    }
    entries.push(entry);
  }
  return { entries };
}

router.get('/service-lines', requireAdmin, async (req, res, next) => {
  try {
    if (serviceLinesOff(res)) return undefined;
    return res.json({ mode: serviceLineMode(), lines: await readServiceLines(db) });
  } catch (err) {
    return next(err);
  }
});

const COVER_LINE_LABELS = { general: 'General pest', mosquito: 'Mosquito', rodent: 'Rodent', termite: 'Termite / WDO' };

// The card as it will read after this save (stored rows with the request's entries laid over), and the refusal
// text when a territory technician (a technician who owns ZIPs) would have no cover on a territory line; null
// when every one has a cover or nobody owns a ZIP (territory.lacksCoverLines). The error names the lines, not ids.
async function territoryCoverRefusal(trx, entries, stored) {
  const territory = require('../services/territory');
  const owners = await territory.territoryTechnicianIds(trx);
  if (!owners.length) return null;
  const after = new Map(stored);
  for (const entry of entries) after.set(entry.service_category, entry);
  const rows = [...after.values()];
  for (const ownerId of owners) {
    const lacking = await territory.lacksCoverLines(trx, ownerId, rows);
    if (!lacking.length) continue;
    const owner = await trx('technicians').where({ id: ownerId }).first('name');
    const lines = lacking.map((line) => COVER_LINE_LABELS[line] || line);
    const list = lines.length > 1 ? `${lines.slice(0, -1).join(', ')} and ${lines[lines.length - 1]}` : lines[0];
    return `${list} ${lines.length > 1 ? 'need' : 'needs'} a cover technician besides ${(owner && owner.name) || 'the territory technician'}: set a home or gap technician`;
  }
  return null;
}

router.put('/service-lines', requireAdmin, async (req, res, next) => {
  try {
    if (serviceLinesOff(res)) return undefined;
    const normalized = normalizeServiceLineEntries((req.body || {}).lines);
    if (normalized.error) return res.status(400).json({ error: normalized.error });
    const { entries } = normalized;
    const outcome = await db.transaction(async (trx) => {
      const ids = [...new Set(entries.flatMap((e) => [e.home_technician_id, e.gap_technician_id]).filter(Boolean))];
      const techs = ids.length
        ? await trx('technicians').whereIn('id', ids).forShare().select('id', 'employment_status')
        : [];
      const found = new Map(techs.map((t) => [t.id, t]));
      const stored = new Map((await trx('service_line_techs').select('service_category', 'home_technician_id', 'gap_technician_id'))
        .map((r) => [r.service_category, r]));
      for (const entry of entries) {
        for (const field of ['home_technician_id', 'gap_technician_id']) {
          const id = entry[field];
          if (!id) continue;
          const tech = found.get(id);
          if (!tech) return { error: 'Technician not found' };
          // A technician who has since left may stay where already saved, never be newly picked.
          const unchanged = stored.get(entry.service_category)?.[field] === id;
          if (tech.employment_status === 'inactive' && !unchanged) return { error: 'That technician is no longer active' };
        }
      }
      // GATE_TERRITORY_ROUTING (owner 2026-10-30): a technician who owns ZIPs needs a cover on every territory line.
      const coverError = await territoryCoverRefusal(trx, entries, stored);
      if (coverError) return { error: coverError };
      for (const entry of entries) {
        await trx('service_line_techs')
          .insert({ ...entry, updated_by: req.technicianId || null, updated_at: trx.fn.now() })
          .onConflict('service_category')
          .merge(['home_technician_id', 'gap_technician_id', 'updated_by', 'updated_at']);
      }
      return { lines: await readServiceLines(trx) };
    });
    if (outcome.error) return res.status(400).json({ error: outcome.error });
    // Event ids only: no names, no phone numbers.
    logger.info(`[team] Updated service-line map by staff id=${req.technicianId} (${entries.map((e) => `${e.service_category}: home=${e.home_technician_id || 'none'} gap=${e.gap_technician_id || 'none'}`).join('; ')})`);
    return res.json({ success: true, mode: serviceLineMode(), lines: outcome.lines });
  } catch (err) {
    return next(err);
  }
});

// GET /service-lines/shadow-summary?days=14 — the read-out of service_line_pick_shadow:
// rows by source, by (line, would_reason), and how many had the technician actually
// chosen differ from the one the map would pick. Read only.
router.get('/service-lines/shadow-summary', requireAdmin, async (req, res, next) => {
  try {
    if (serviceLinesOff(res)) return undefined;
    const asked = Number.parseInt(req.query.days, 10);
    const days = Number.isInteger(asked) && asked > 0 ? Math.min(asked, SHADOW_SUMMARY_MAX_DAYS) : SHADOW_SUMMARY_DEFAULT_DAYS;
    const since = new Date(Date.now() - days * 86400000);
    const recent = () => db('service_line_pick_shadow').where('created_at', '>=', since);
    const [bySource, byLineReason, totals] = await Promise.all([
      recent().select('source').count('* as count').groupBy('source').orderBy('source'),
      recent().select('service_line', 'would_reason').count('* as count').groupBy('service_line', 'would_reason')
        .orderBy([{ column: 'service_line' }, { column: 'would_reason' }]),
      recent().first(
        db.raw('COUNT(*)::int AS total'),
        db.raw('COUNT(*) FILTER (WHERE actual_technician_id IS DISTINCT FROM would_technician_id)::int AS differs'),
        db.raw('COUNT(*) FILTER (WHERE would_free IS TRUE)::int AS would_free_yes'),
        db.raw('COUNT(*) FILTER (WHERE would_free IS FALSE)::int AS would_free_no'),
      ),
    ]);
    const asNumber = (rows) => rows.map((r) => ({ ...r, count: Number(r.count) }));
    return res.json({
      days,
      since: since.toISOString(),
      total: Number(totals?.total) || 0,
      differs: Number(totals?.differs) || 0,
      wouldFree: { yes: Number(totals?.would_free_yes) || 0, no: Number(totals?.would_free_no) || 0 },
      bySource: asNumber(bySource),
      byLineReason: asNumber(byLineReason),
    });
  } catch (err) {
    return next(err);
  }
});

// GET /territory-readout?weeks=4 — territories by ZIP, build 3 (GATE_TERRITORY_READOUT, owner
// 2026-10-30): stops per technician and area, booked over the next `weeks` and done over the
// last `weeks` (1-13, default 4), so the re-cut rule is a number on the Team tab. Read only.
const TERRITORY_READOUT_DEFAULT_WEEKS = 4;
const TERRITORY_READOUT_MAX_WEEKS = 13;
router.get('/territory-readout', requireAdmin, async (req, res, next) => {
  try {
    if (!territoryReadoutOn()) return res.status(404).json({ error: 'Not found' });
    const asked = Number.parseInt(req.query.weeks, 10);
    const weeks = Number.isInteger(asked) && asked > 0 ? Math.min(asked, TERRITORY_READOUT_MAX_WEEKS) : TERRITORY_READOUT_DEFAULT_WEEKS;
    const now = new Date();
    const today = etDateString(now);
    const ahead = etDateString(addETDays(now, weeks * 7));
    const back = etDateString(addETDays(now, -weeks * 7));
    const rows = await require('../services/territory').territoryReadout(db, { today, ahead, back });
    return res.json({ weeks, today, rows });
  } catch (err) {
    return next(err);
  }
});

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
    if (to > addCalendarDaysToYMD(from, 400)) {
      return res.status(400).json({ error: 'Date range cannot exceed 400 days' });
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
      .select('work_date', 'total_shift_minutes', 'unpaid_meal_minutes', 'overtime_minutes', 'job_count');

    // Pay is on PAID minutes: shift less the day's stored unpaid meal (0:
    // every clocked minute is paid). overtime_minutes is already a share of the paid minutes.
    const totalMin = rows.reduce((s, r) => s + parseFloat(r.total_shift_minutes || 0), 0);
    const unpaidMin = rows.reduce((s, r) => s + parseFloat(r.unpaid_meal_minutes || 0), 0);
    const otMin = rows.reduce((s, r) => s + parseFloat(r.overtime_minutes || 0), 0);
    const regMin = rows.reduce((s, r) => {
      const shift = parseFloat(r.total_shift_minutes || 0);
      const unpaid = Math.min(shift, parseFloat(r.unpaid_meal_minutes || 0));
      return s + Math.max(0, shift - unpaid - parseFloat(r.overtime_minutes || 0));
    }, 0);

    const hasConfiguredRate = tech.pay_rate != null && tech.pay_rate !== '' && Number.isFinite(Number(tech.pay_rate));
    const rate = hasConfiguredRate ? Number(tech.pay_rate) : 35;
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
      payRateSource: hasConfiguredRate ? 'tech' : 'default',
      regularMinutes: regMin,
      overtimeMinutes: otMin,
      totalMinutes: totalMin,
      unpaidMealMinutes: unpaidMin,
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
// route outside the docs/public-route-contracts.md inventory of public-by-token routes
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
      if (!UUID_PARAM_RE.test(String(req.params.id || ''))) {
        return res.status(400).json({ error: 'Invalid ID' });
      }
      if (!req.file) return res.status(400).json({ error: 'No file provided' });
      const photoCheck = validateStaffPhotoUpload(req.file);
      if (photoCheck.error) return res.status(400).json({ error: photoCheck.error });
      if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });

      const tech = await db('technicians').where({ id: req.params.id }).first('id', 'email');
      if (!tech) return res.status(404).json({ error: 'Technician not found' });
      const ownerRowGuard = ownerRowRefusal(req, tech);
      if (ownerRowGuard) return res.status(403).json(ownerRowGuard);

      const key = `${PHOTO_PREFIX}${tech.id}/${Date.now()}.${photoCheck.ext}`;
      await s3.send(new PutObjectCommand({
        Bucket: config.s3.bucket,
        Key: key,
        Body: req.file.buffer,
        ContentType: photoCheck.contentType,
        ContentDisposition: 'attachment',
      }));

      await db('technicians').where({ id: tech.id }).update({
        photo_s3_key: key,
        updated_at: new Date(),
      });

      logger.info(`[team] Uploaded photo for technician id=${tech.id}`);

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

      const responseRow = isAdminCaller(req) ? sanitizeTechForAdmin(updated) : sanitizeTechForNonAdmin(updated, req.technicianId);
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
      const ownerRowGuard = ownerRowRefusal(req, target);
      if (ownerRowGuard) return { ownerRowGuard };

      const blocker = await deactivationBlocker(trx, target, req.technicianId);
      if (blocker) return { blocker };
      const activeTimer = await trx('time_entries')
        .where({ technician_id: target.id, status: 'active' })
        .forUpdate()
        .first('id');
      if (activeTimer) return { activeTimer: true };

      // A prospective placeholder is offboarded the same way (it simply has
      // no sessions to revoke); an already-inactive row is a no-op.
      const wasOnStaff = (target.employment_status || (target.active ? 'active' : 'inactive')) !== 'inactive';
      if (wasOnStaff) {
        await trx('technicians').where({ id: target.id }).update({
          ...employmentPatch('inactive'),
          twilio_number: null,
          auth_token_version: Number(target.auth_token_version || 0) + 1,
          password_reset_token_hash: null,
          password_reset_expires_at: null,
          password_reset_requested_at: null,
          updated_at: new Date(),
        });
      }
      await trx('tech_voice_pins').where({ technician_id: target.id }).del();
      await PushService.deactivateStaffUser(target.id, trx);
      const tech = wasOnStaff
        ? await trx('technicians').where({ id: target.id }).first()
        : target;
      // Future work still on this tech is surfaced for reassignment — never
      // cancelled or rewritten here. Completed visits keep their attribution.
      const futureAssignedVisits = await listFutureAssignedVisits(trx, target.id);
      return { tech, changed: wasOnStaff, futureAssignedVisits };
    });

    if (outcome.notFound) return res.status(404).json({ error: 'Technician not found' });
    if (outcome.ownerRowGuard) return res.status(403).json(outcome.ownerRowGuard);
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
      futureAssignedVisits: formatFutureAssignedVisits(outcome.futureAssignedVisits),
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
//   archived=only — the archived docs instead of the active ones, so an
//     admin can find one and restore it (POST /documents/:id/restore)
// requireAdmin: documents now hold per-tech HR records (W-4, I-9,
// license, cert expirations). Tech-role tokens must not be able to
// list/read/upload/edit those, even their own — pre-existing tech
// access to company-wide SOPs is acceptable collateral here.
router.use('/documents', (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

router.get('/documents', requireAdmin, async (req, res, next) => {
  try {
    await ensureDocTable();
    const { category, technicianId, archived } = req.query;
    if (technicianId && technicianId !== 'company' && !UUID_PARAM_RE.test(String(technicianId))) {
      return res.status(400).json({ error: 'technicianId must be a valid ID or "company"' });
    }
    let query = db('company_documents')
      .leftJoin('technicians', 'company_documents.technician_id', 'technicians.id')
      .where('company_documents.is_archived', archived === 'only')
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
function validateDocumentUploadBody(body, file) {
  const { title, category, description, technicianId, expirationDate } = body || {};
  const finalTitle = title !== undefined && String(title).trim()
    ? String(title).trim()
    : String(file.originalname || '').trim();
  if (!finalTitle || finalTitle.length > 200) {
    return { error: 'Title must be 1 to 200 characters' };
  }
  const finalCategory = category || 'general';
  if (!ALLOWED_DOC_CATEGORIES.has(finalCategory)) {
    return { error: 'Invalid document category' };
  }
  if (technicianId && !UUID_PARAM_RE.test(String(technicianId))) {
    return { error: 'technicianId must be a valid ID' };
  }
  if (expirationDate && !validDateOnly(expirationDate)) {
    return { error: 'expirationDate must be a valid YYYY-MM-DD date' };
  }
  return {
    finalTitle,
    finalCategory,
    description: description || null,
    technicianId: technicianId || null,
    expirationDate: expirationDate || null,
  };
}

function buildDocumentUpdatePatch(body) {
  const { title, category, description, technicianId, expirationDate } = body || {};
  const updates = { updated_at: new Date() };
  if (title !== undefined) {
    const trimmed = typeof title === 'string' ? title.trim() : '';
    if (!trimmed || trimmed.length > 200) return { error: 'Title must be 1 to 200 characters' };
    updates.title = trimmed;
  }
  if (category !== undefined) {
    if (!ALLOWED_DOC_CATEGORIES.has(category)) return { error: 'Invalid document category' };
    updates.category = category;
  }
  if (description !== undefined) updates.description = description;
  if (technicianId !== undefined) {
    if (technicianId !== '' && technicianId !== null && !UUID_PARAM_RE.test(String(technicianId))) {
      return { error: 'technicianId must be a valid ID' };
    }
    updates.technician_id = technicianId === '' ? null : technicianId;
  }
  if (expirationDate !== undefined) {
    if (expirationDate !== '' && expirationDate !== null && !validDateOnly(expirationDate)) {
      return { error: 'expirationDate must be a valid YYYY-MM-DD date' };
    }
    updates.expiration_date = expirationDate === '' ? null : expirationDate;
  }
  return { updates };
}

router.post('/documents/upload', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    await ensureDocTable();
    if (!req.file) return res.status(400).json({ error: 'No file provided' });
    const fileCheck = validateCompanyDocumentUpload(req.file);
    if (fileCheck.error) return res.status(400).json({ error: fileCheck.error });

    const bodyCheck = validateDocumentUploadBody(req.body, req.file);
    if (bodyCheck.error) return res.status(400).json({ error: bodyCheck.error });
    if (!config.s3?.bucket) return res.status(500).json({ error: 'S3 not configured' });

    const ext = fileCheck.ext;
    const safeOrig = String(req.file.originalname || `document.${ext}`).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 120);
    const key = `${DOC_PREFIX}${Date.now()}-${safeOrig}`;

    await s3.send(new PutObjectCommand({
      Bucket: config.s3.bucket,
      Key: key,
      Body: req.file.buffer,
      ContentType: fileCheck.contentType,
      ContentDisposition: 'attachment',
    }));

    const [doc] = await db('company_documents').insert({
      title: bodyCheck.finalTitle,
      category: bodyCheck.finalCategory,
      description: bodyCheck.description,
      file_name: String(req.file.originalname || '').slice(0, 255),
      file_type: ext,
      file_size: req.file.size,
      s3_key: key,
      uploaded_by: req.technicianId || null,
      technician_id: bodyCheck.technicianId,
      expiration_date: bodyCheck.expirationDate,
    }).returning('*');

    await recordAuditEvent({
      actor_type: 'admin',
      actor_id: req.technicianId || null,
      action: 'company_document.uploaded',
      resource_type: 'company_documents',
      resource_id: doc.id,
      metadata: { category: doc.category, file_type: ext, technician_id: doc.technician_id || null },
    });

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
    if (!UUID_PARAM_RE.test(String(req.params.id || ''))) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    const doc = await db('company_documents').where({ id: req.params.id }).first();
    if (!doc) return res.status(404).json({ error: 'Document not found' });

    const safeFile = safeDownloadFilename(doc.file_name);
    const url = await getSignedUrl(s3, new GetObjectCommand({
      Bucket: config.s3.bucket,
      Key: doc.s3_key,
      ResponseContentDisposition: `attachment; filename="${safeFile}"`,
    }), { expiresIn: 3600 });

    await recordAuditEvent({
      actor_type: 'admin',
      actor_id: req.technicianId || null,
      action: 'company_document.downloaded',
      resource_type: 'company_documents',
      resource_id: doc.id,
      metadata: { category: doc.category, technician_id: doc.technician_id || null },
    });

    res.json({ url, fileName: doc.file_name });
  } catch (err) { next(err); }
});

// PUT /documents/:id — update metadata. Pass technicianId='' to
// unbind from a tech back to company-wide; expirationDate='' to
// clear an expiration.
router.put('/documents/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!UUID_PARAM_RE.test(String(req.params.id || ''))) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    const patch = buildDocumentUpdatePatch(req.body);
    if (patch.error) return res.status(400).json({ error: patch.error });
    const [doc] = await db('company_documents').where({ id: req.params.id }).update(patch.updates).returning('*');
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    await recordAuditEvent({
      actor_type: 'admin',
      actor_id: req.technicianId || null,
      action: 'company_document.updated',
      resource_type: 'company_documents',
      resource_id: doc.id,
      metadata: { category: doc.category, technician_id: doc.technician_id || null },
    });
    res.json(doc);
  } catch (err) { next(err); }
});

// DELETE /documents/:id — archive (soft delete)
router.delete('/documents/:id', requireAdmin, async (req, res, next) => {
  try {
    if (!UUID_PARAM_RE.test(String(req.params.id || ''))) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    const [archived] = await db('company_documents')
      .where({ id: req.params.id })
      .update({ is_archived: true, updated_at: new Date() })
      .returning('id');
    if (!archived) return res.status(404).json({ error: 'Document not found' });
    await recordAuditEvent({
      actor_type: 'admin',
      actor_id: req.technicianId || null,
      action: 'company_document.archived',
      resource_type: 'company_documents',
      resource_id: req.params.id,
      metadata: {},
    });
    logger.info(`[docs] Archived document: ${req.params.id}`);
    res.json({ success: true });
  } catch (err) { next(err); }
});

// POST /documents/:id/restore — undo an archive. Only the flag changes: the
// stored file (s3_key) and every metadata field stay as they were. A document
// that is not archived is returned unchanged.
router.post('/documents/:id/restore', requireAdmin, async (req, res, next) => {
  try {
    if (!UUID_PARAM_RE.test(String(req.params.id || ''))) {
      return res.status(400).json({ error: 'Invalid ID' });
    }
    const [restored] = await db('company_documents')
      .where({ id: req.params.id, is_archived: true })
      .update({ is_archived: false, updated_at: new Date() })
      .returning('*');
    if (restored) {
      await recordAuditEvent({
        actor_type: 'admin',
        actor_id: req.technicianId || null,
        action: 'company_document.restored',
        resource_type: 'company_documents',
        resource_id: req.params.id,
        metadata: {},
      });
      logger.info(`[docs] Restored document: ${req.params.id}`);
      return res.json(restored);
    }
    const doc = await db('company_documents').where({ id: req.params.id }).first();
    if (!doc) return res.status(404).json({ error: 'Document not found' });
    res.json(doc);
  } catch (err) { next(err); }
});

router._test = {
  STAFF_ENTRY_WORK_DATE_SQL,
  applyStaffEntryWorkDateRange,
  hireStateFor,
  staffAnalyticsDateRange,
};

module.exports = router;
module.exports._handlers = {
  createTechnician,
  deactivateTechnician,
  getTechnicianCapabilities,
  hireTechnician,
  listTechnicians,
  putTechnicianCapabilities,
  putTechnicianGoogleSignin,
  putTechnicianVoicePin,
  updateTechnician,
};
