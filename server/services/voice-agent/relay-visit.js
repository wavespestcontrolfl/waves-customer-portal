/**
 * Voice-relay Phase D — visit-day surfaces: get_today_eta and
 * get_service_report. READ-ONLY, gated (VOICE_RELAY_CONTEXT_ENABLED, checked
 * in relay-tools before either body runs).
 *
 * get_today_eta answers the #1 existing-customer call — "when is the tech
 * getting here?". It reads the SAME row shape the customer-facing surfaces do:
 *   - scheduled_date is a DATE and the window lives in
 *     scheduled_services.window_start/window_end (TIME) — the fields
 *     routes/schedule.js (GET /api/schedule, /next) and routes/track-public.js
 *     render. When a row carries no window, appointment_reminders
 *     .appointment_time (the reminder rail's stamped clock time, cancelled =
 *     false) is the fallback, mirroring how the reminder/appointment emails
 *     source the spoken time.
 *   - "today" is TODAY IN ET via etDateString() — never a naive UTC
 *     comparison (the timestamptz window leak; scheduled_date is a DATE so an
 *     exact ET-day string equality is the correct predicate).
 *   - the dispatch-owned pending guard (DISPATCH_OWNED_PENDING_SOURCE_ACTIONS)
 *     is the same one GET /api/schedule/next applies: a never-confirmed
 *     dispatch-created row is not the customer's appointment.
 *
 * EN-ROUTE is a READ-ONLY PEEK at the tracker lifecycle columns the
 * track/en-route work writes (scheduled_services.track_state + en_route_at /
 * arrived_at, the columns applyTrackLifecycleCas in services/rebooker.js CASes
 * on and track-transitions.markEnRoute stamps). It mirrors track-public.js's
 * customer-facing state derivation: terminal OPERATIONAL status wins over a
 * stale track_state (a cancelled/completed visit whose track_state was never
 * moved must never be announced as "on the way"). Nothing here writes.
 *
 * get_service_report deepens Phase A's visit summary along the SAME
 * customer-facing shaping helpers:
 *   - the typedReportDelivery suppression predicate (routes/services.js
 *     suppressesCustomerArtifacts) — anything but auto_send keeps findings,
 *     products and notes off customer surfaces, and the phone is one;
 *   - customerSafeServiceNotes (services/project-types.js) for the note text;
 *   - service_findings + service_products, the SAME tables the customer
 *     report renders from (services/service-report/report-data.js), never raw
 *     internal notes and never field_flags (internal QA markers);
 *   - COMPLIANCE LANGUAGE IS NEVER COMPOSED HERE: re-entry wording comes only
 *     from buildReentryContext().customerSummary
 *     (services/service-report/reentry.js) — the one sanctioned sentence —
 *     and product/application wording says "per application", never
 *     "per visit". No re-entry claim is invented, and nothing is ever called
 *     "safe".
 */

const logger = require('../logger');

const SERVICE_REPORT_FINDING_LIMIT = 6;
const SERVICE_REPORT_APPLICATION_LIMIT = 6;

// ⭐ THE REAL scheduled_services.track_state ENUM: scheduled | en_route |
// on_property | complete. Two bugs came out of guessing at it: 'on_site' was in
// the on-property set and is not a value the column ever holds (dead branch),
// and 'complete' was unhandled — so during the completion window, before the
// operational `status` catches up, the agent told a caller whose technician had
// just finished that he "has not started toward the property yet".
const EN_ROUTE_TRACK_STATE = 'en_route';
const ON_PROPERTY_TRACK_STATE = 'on_property';
const COMPLETE_TRACK_STATE = 'complete';
// Terminal OPERATIONAL statuses that outrank a stale track_state (same
// precedence as routes/track-public.js).
const TERMINAL_STATUSES = new Set(['completed', 'cancelled', 'skipped', 'no_show']);

/** 'HH:MM:SS' | '9:00 AM' | Date → speakable clock time, else null. */
function speakClock(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    const { formatETTime } = require('../../utils/datetime-et');
    return formatETTime(value) || null;
  }
  const raw = String(value == null ? '' : value).trim();
  if (!raw) return null;
  const m = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!m) return /^\d{1,2}(:\d{2})?\s*(AM|PM)$/i.test(raw) ? raw.toUpperCase() : null;
  let hour = parseInt(m[1], 10);
  const minute = m[2];
  if (!Number.isFinite(hour) || hour > 23) return null;
  const suffix = hour >= 12 ? 'PM' : 'AM';
  hour = hour % 12 || 12;
  return minute === '00' ? `${hour} ${suffix}` : `${hour}:${minute} ${suffix}`;
}

// ── get_today_eta ──────────────────────────────────────────────────────────

/**
 * Today's (ET) appointment for this customer, with a read-only peek at the
 * tracker lifecycle. Returns model-facing text; never writes.
 */
async function todayEtaText(customerId, { tier = 'redacted' } = {}) {
  const redacted = tier !== 'full';
  // PHYSICAL SECURITY: an unverified voice learns NOTHING about today, not even
  // that a visit exists. "Is anyone coming to 42 Oak today?" answered yes/no is
  // the single most abusable disclosure in this lane — it tells a stranger
  // whether a technician (or the resident) will be at that address today. The
  // answer is therefore identical whether or not a visit is on the schedule, so
  // the refusal itself cannot be read as a signal — and the row is never even
  // read.
  if (redacted) {
    return 'Today\'s schedule is only available for the account the caller\'s own phone number matches. '
      + 'Do NOT say whether a visit is or is not on today\'s schedule for this account, do not state a '
      + 'window, and do not describe any technician\'s status. Tell the caller the account holder can see '
      + 'it in the Waves portal, or the office can go over it with them directly.';
  }
  const db = require('../../models/db');
  const { etDateString } = require('../../utils/datetime-et');
  const { DISPATCH_OWNED_PENDING_SOURCE_ACTIONS } = require('../call-booking-source-actions');
  const today = etDateString();
  const row = await db('scheduled_services')
    .where({ customer_id: customerId })
    // Exact ET-day equality: scheduled_date is a DATE column, so this is the
    // whole of "today in ET" with no timestamptz window to leak.
    .where('scheduled_date', today)
    .whereNotIn('status', ['cancelled', 'rescheduled'])
    .where((qb) => qb
      .whereNull('source_action')
      .orWhereNotIn('source_action', DISPATCH_OWNED_PENDING_SOURCE_ACTIONS)
      .orWhereNot('status', 'pending')
      .orWhere('customer_confirmed', true))
    .orderBy('window_start', 'asc')
    .first('id', 'status', 'service_type', 'window_start', 'window_end',
      'track_state', 'en_route_at', 'arrived_at', 'customer_confirmed');
  if (!row) {
    return 'No appointment on the schedule for this account today. Do NOT guess at a time and do NOT '
      + 'claim a technician has left — check get_account_overview for the next scheduled visit instead.';
  }

  let windowStart = speakClock(row.window_start);
  let windowEnd = speakClock(row.window_end);
  if (!windowStart) {
    // Fallback to the reminder rail's stamped clock time (the same
    // appointment_time the confirmation/reminder messages speak).
    const reminder = await db('appointment_reminders')
      .where({ scheduled_service_id: row.id, cancelled: false })
      .orderBy('appointment_time', 'asc')
      .first('appointment_time')
      .catch(() => null);
    if (reminder && reminder.appointment_time) windowStart = speakClock(reminder.appointment_time);
  }

  const { promptSafe } = require('./relay-context');
  const service = promptSafe(row.service_type, 60);
  const parts = [];
  if (windowStart && windowEnd) parts.push(`Today's appointment window is ${windowStart} to ${windowEnd}`);
  else if (windowStart) parts.push(`Today's appointment starts around ${windowStart}`);
  else parts.push('There is an appointment on the schedule for today, but no time window is set on it');
  if (service) parts[0] += ` for ${service}`;
  parts[0] += '.';

  // READ-ONLY tracker peek. Terminal operational status outranks a stale
  // track_state — a completed or cancelled visit is never "on the way".
  const status = String(row.status || '');
  if (TERMINAL_STATUSES.has(status)) {
    parts.push(status === 'completed'
      ? 'That visit is already marked complete for today.'
      : 'That visit is no longer active on today\'s schedule — do not promise an arrival; a team member can sort it out.');
  } else if (String(row.track_state) === COMPLETE_TRACK_STATE) {
    // The tracker reached 'complete' before the operational status did — the
    // work IS done, and "has not started yet" would be flatly wrong.
    parts.push('The technician has finished the visit — the service is complete. The paperwork may take a '
      + 'few more minutes to catch up in the system.');
  } else if (String(row.track_state) === ON_PROPERTY_TRACK_STATE) {
    parts.push('The technician is already at the property.');
  } else if (String(row.track_state) === EN_ROUTE_TRACK_STATE) {
    parts.push('The technician is EN ROUTE right now — on the way to the property.');
  } else {
    parts.push('The technician has not started toward the property yet, so there is no live arrival time. '
      + 'Give the window only; never invent a more precise ETA.');
  }
  return parts.join(' ');
}

// ── get_service_report ─────────────────────────────────────────────────────

/** Resolve a knex query builder, failing toward an empty list. */
function safeRows(query) {
  return Promise.resolve(query).catch(() => []);
}

function parseJson(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function parseArray(value) {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * The customer-facing detail for one completed visit: findings, applications
 * (per APPLICATION — never "per visit"), the customer-safe note, and the
 * sanctioned re-entry sentence. Suppressed entirely for typed reports whose
 * delivery posture is anything but auto_send.
 */
async function serviceReportText(customerId, { visitDate = null, tier = 'redacted' } = {}) {
  // Per-visit detail is FULL-TIER ONLY (strictly more than the visit summary
  // the redacted tier already withholds), and the tier defaults to redacted so
  // this exported helper cannot fail open.
  if (tier !== 'full') {
    return 'Visit reports are only available for the account whose own phone number the caller is calling '
      + 'from. Do NOT describe any visit, finding, product, or re-entry guidance. Offer to have the office '
      + 'follow up with the account holder.';
  }
  const db = require('../../models/db');
  const { promptSafe, promptSafeUntrusted, speakDate } = require('./relay-context');

  const query = db('service_records')
    .where({ customer_id: customerId })
    .where((qb) => qb.whereNull('status').orWhere('status', 'completed'))
    .orderBy('service_date', 'desc')
    .orderBy('id', 'desc');
  const wanted = String(visitDate || '').trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(wanted)) query.where('service_date', wanted);
  const record = await query.first('id', 'service_date', 'service_type', 'technician_notes',
    'structured_notes', 'status', 'started_at', 'ended_at', 'advisory');
  if (!record) {
    return wanted
      ? 'No completed visit on file for that date on this account. Do not describe a visit that is not on file.'
      : 'No completed visits on file for this account yet.';
  }

  const structured = parseJson(record.structured_notes);
  // THE predicate, imported from routes/services.js rather than re-implemented:
  // any typed delivery posture other than auto_send keeps the report detail off
  // customer surfaces — and the phone is a customer surface.
  const { suppressesCustomerArtifacts } = require('../../routes/services');
  if (suppressesCustomerArtifacts(structured)) {
    return `A visit is on file for ${speakDate(record.service_date) || 'that date'}, but its detailed report is not `
      + 'released for customer delivery. Do NOT describe findings or products. Offer to have the office follow up '
      + 'with the report.';
  }

  const [findings, allProducts] = await Promise.all([
    safeRows(db('service_findings')
      .where({ service_record_id: record.id })
      .orderBy('created_at', 'asc')
      .limit(SERVICE_REPORT_FINDING_LIMIT)
      .select('category', 'severity', 'title', 'detail', 'recommendation')),
    // Columns are the UNION of what the spoken report needs and what
    // buildReentryContext reads (id, applied_at, created_at, application_area,
    // application_method, targets) — one read serves both.
    safeRows(db('service_products')
      .where({ service_record_id: record.id })
      .orderBy('created_at', 'asc')
      .select('id', 'product_name', 'applied_at', 'created_at',
        'application_area', 'application_method', 'targets')),
  ]);

  // The re-entry helper needs EVERY application (its anchor is the latest
  // applied_at); the spoken list is capped for the phone.
  const reentryApplications = Array.isArray(allProducts) ? allProducts : [];
  const products = reentryApplications.slice(0, SERVICE_REPORT_APPLICATION_LIMIT);

  const { customerSafeServiceNotes } = require('../project-types');
  const noteText = promptSafeUntrusted(customerSafeServiceNotes(record.technician_notes, structured), 240);

  const lines = [`Visit on ${speakDate(record.service_date) || 'an unrecorded date'}`
    + `${record.service_type ? ` — ${promptSafeUntrusted(record.service_type, 60)}` : ''}.`];

  if (findings.length) {
    const rendered = findings
      .map((f) => {
        const head = promptSafeUntrusted(f.title, 80);
        const detail = promptSafeUntrusted(f.detail, 140);
        return [head, detail].filter(Boolean).join(': ');
      })
      .filter(Boolean);
    if (rendered.length) lines.push(`What the technician found: ${rendered.join(' | ')}.`);
    const recs = findings.map((f) => promptSafeUntrusted(f.recommendation, 120)).filter(Boolean);
    if (recs.length) lines.push(`Recommended next steps: ${recs.join(' | ')}.`);
  }

  if (products.length) {
    const rendered = products
      .map((p) => {
        const name = promptSafeUntrusted(p.product_name, 60);
        if (!name) return null;
        const area = promptSafeUntrusted(p.application_area, 40);
        const targets = parseArray(p.targets).map((t) => promptSafeUntrusted(t, 30)).filter(Boolean).slice(0, 4);
        // Owner rule: "per application", never "per visit".
        return `${name}${area ? ` applied to the ${area}` : ''}${targets.length ? ` for ${targets.join(', ')}` : ''}`;
      })
      .filter(Boolean);
    if (rendered.length) {
      lines.push(`Products used on this application: ${rendered.join('; ')}.`);
    }
  }

  if (noteText) lines.push(`Technician's customer note: ${noteText}`);

  // COMPLIANCE: the ONLY re-entry wording allowed is the shaping helper's own
  // customerSummary. Never composed, never paraphrased, never "safe".
  try {
    const { buildReentryContext } = require('../service-report/reentry');
    // The products were just read above — hand them over instead of letting
    // buildReentryContext re-query service_products for the same rows. Its own
    // fallback stays intact for every other caller.
    const reentry = await buildReentryContext({
      record: { ...record, applications: reentryApplications },
      knex: db,
    });
    const summary = promptSafe(reentry && reentry.customerSummary, 160);
    if (summary) lines.push(`Re-entry guidance, stated exactly as written: "${summary}"`);
  } catch (err) {
    logger.warn(`[voice-relay-visit] re-entry context skipped: ${err.message}`);
  }

  lines.push('Report only what is above. Do not add findings, products, timings, or re-entry advice of your '
    + 'own, and never tell a caller an area or product is "safe".');
  return lines.join(' ');
}

module.exports = {
  todayEtaText,
  serviceReportText,
  speakClock,
  SERVICE_REPORT_FINDING_LIMIT,
  SERVICE_REPORT_APPLICATION_LIMIT,
};
