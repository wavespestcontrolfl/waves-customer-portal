/**
 * Job applications — validation + creation for the public careers funnel.
 *
 * Pure service so the abuse/validation contract is unit-testable without
 * Express (same split as estimate-measurement-review). The route owns the
 * limiter/honeypot/Turnstile chain; this module owns what a valid
 * application IS and the single insert.
 *
 * Applicants are never customers or leads — no reads or writes to either
 * table, mirroring the call pipeline's job_applicant rule.
 */

const { cleanText, cleanValidEmailOrNull, normalizeNanpPhone } = require('../utils/intake-normalize');
const { properCase } = require('../utils/name-case');

const ROLES = ['technician', 'sales', 'other'];
// v1 intake accepts TECHNICIAN ONLY (owner ruling 2026-08-25: tech first).
// The AI screen's rubric is technician-specific — accepting other roles
// would misrank them under a rubric built for field work (codex P1). The
// table CHECK stays wide so widening later is a one-line change here plus
// a role-specific rubric in job-application-screen.js.
const INTAKE_ROLES = ['technician'];
const STATUSES = ['new', 'reviewed', 'interview', 'offer', 'hired', 'rejected', 'withdrawn'];
const LANGUAGES = ['en', 'es'];

// The application IS the first interview — answer keys mirror the owner's
// question set. Unknown keys are dropped, not stored (same posture as
// measurement-review reason chips).
const ANSWER_KEYS = [
  'drivers_license',
  'experience',
  'outdoor_work',
  'judgment_gate_code',
  'phone_apps',
  'availability',
  'pay_expectation',
  'why_waves',
  'physical_limitations',
  'referral_source',
];
const MAX_ANSWER_CHARS = 2000;

const SOURCE_KEYS = ['page_url', 'utm_source', 'utm_medium', 'utm_campaign', 'referrer'];
const MAX_SOURCE_CHARS = 300;

function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

// Fail-closed answer validation (codex P1): a malformed submission is a 400,
// never a silent normalization that loses applicant content. Unknown keys are
// dropped BY CONTRACT (the allowlist is the schema — arbitrary keys are a
// storage vector, not content); everything else about a present answer must
// be well-formed: string-typed and within the length cap.
function normalizeAnswers(raw) {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw badRequest('Answers must be an object.');
  }
  const out = {};
  for (const key of ANSWER_KEYS) {
    if (!(key in raw)) continue;
    const value = raw[key];
    if (typeof value !== 'string') {
      throw badRequest(`Answer "${key}" must be text.`);
    }
    if (value.length > MAX_ANSWER_CHARS) {
      throw badRequest(`Answer "${key}" is too long (max ${MAX_ANSWER_CHARS} characters).`);
    }
    const trimmed = value.trim();
    if (!trimmed) continue;
    out[key] = trimmed;
  }
  return out;
}

function normalizeSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  for (const key of SOURCE_KEYS) {
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    out[key] = trimmed.slice(0, MAX_SOURCE_CHARS);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * Validates and inserts one application. Returns the inserted row.
 * Throws { status: 400 } on invalid input — the route maps it to a 400.
 */
async function createJobApplication({ body = {}, database }) {
  const name = properCase(cleanText(body.name || ''));
  if (!name || name.length < 2 || name.length > 80) {
    throw badRequest('Please provide your name.');
  }

  const phone = normalizeNanpPhone(body.phone);
  if (!phone) {
    throw badRequest('Please provide a valid phone number.');
  }

  // 254 is the RFC 5321 ceiling; anything longer is not a deliverable
  // address, only a storage-bloat vector (codex P1) — treat as absent.
  const emailRaw = cleanValidEmailOrNull(body.email);
  const email = emailRaw && emailRaw.length <= 254 ? emailRaw : null;

  const cityRaw = cleanText(body.city || '');
  if (cityRaw.length > 80) {
    throw badRequest('City is too long (max 80 characters).');
  }
  const city = cityRaw || null;

  const role = INTAKE_ROLES.includes(body.role) ? body.role : null;
  if (!role) {
    throw badRequest('Please pick the role you are applying for.');
  }

  const language = LANGUAGES.includes(body.language) ? body.language : 'en';
  const answers = normalizeAnswers(body.answers);
  const smsConsent = [true, 'true', 'on', 'yes'].includes(body.sms_consent);

  const [row] = await database('job_applications')
    .insert({
      role,
      status: 'new',
      language,
      contact_snapshot: JSON.stringify({ name, phone, email, city }),
      answers: JSON.stringify(answers),
      sms_consent: smsConsent,
      source: (() => {
        const source = normalizeSource(body.source);
        return source ? JSON.stringify(source) : null;
      })(),
    })
    .returning(['id', 'role', 'status', 'language', 'created_at', 'contact_snapshot', 'sms_consent']);

  return row;
}

// Statuses that count as an OPEN application (the same set the recruiting
// reply matcher uses). A rejected, withdrawn or hired applicant who calls again
// is a new application.
const OPEN_STATUSES = ['new', 'reviewed', 'interview', 'offer'];
const CALL_SUMMARY_MAX_CHARS = 500;

function lastTenDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/**
 * Files ONE Careers application from a phone call whose caller was a job
 * applicant (GATE_CALL_APPLICANT_HANDLING). A sibling of createJobApplication,
 * not a loosening of it: the public form's validator stays exactly as it was.
 *
 * COMMS-FREE by contract: this writes one job_applications row and nothing
 * else. It sends no text and no email, mints no interview token or invite,
 * and starts no AI screen. Status is always 'new' (never 'interview' or
 * 'offer': those feed calendar occupancy and an admin move to interview sends
 * an invite text). Role is 'technician' (the only intake role).
 *
 * Idempotent: keyed by call_log_id (a reprocess never files a second row,
 * whatever became of the first) and deduped against an OPEN application with
 * the same phone (last 10 digits).
 *
 * @returns {Promise<{ created: boolean, id: string|null, reason: string }>}
 */
function callerName(caller) {
  const fullName = cleanText(caller.name_full || [caller.first_name, caller.last_name].filter(Boolean).join(' '));
  return fullName ? properCase(fullName) : '';
}

// The caller's own spoken number first, else the number that called us (the
// number we dialed, on an outbound call).
function callerPhone(call, caller) {
  // Every outbound variant ('outbound', 'outbound-api', 'outbound-dial'), the processor's isOutboundCall rule.
  const ani = String(call.direction || '').toLowerCase().startsWith('outbound') ? call.to_phone : call.from_phone;
  return normalizeNanpPhone(caller.phone_e164) || normalizeNanpPhone(ani);
}

// The row's fields from the call, or { reason } when the call cannot file one.
function callApplicationFields(call, extraction) {
  if (!call.id) return { reason: 'no_call' };
  if (extraction?.call_nature !== 'job_applicant') return { reason: 'not_job_applicant' };
  const caller = extraction.caller || {};

  const name = callerName(caller);
  if (!name || name.length < 2 || name.length > 80) return { reason: 'no_name' };

  const phone = callerPhone(call, caller);
  if (!phone) return { reason: 'no_phone' };

  const emailRaw = cleanValidEmailOrNull(caller.email);
  const email = emailRaw && emailRaw.length <= 254 ? emailRaw : null;

  const source = {
    channel: 'phone_call',
    call_log_id: String(call.id),
    organization_name: cleanText(caller.organization_name || '').slice(0, MAX_SOURCE_CHARS) || null,
    call_summary: cleanText(extraction.meta?.call_summary || '').slice(0, CALL_SUMMARY_MAX_CHARS) || null,
  };
  return { name, phone, email, source, phoneKey: lastTenDigits(phone) };
}

async function createJobApplicationFromCall({ call = {}, extraction = null, database, procGeneration = null }) {
  const fields = callApplicationFields(call, extraction);
  if (fields.reason) return { created: false, id: null, reason: fields.reason };
  const { name, phone, email, source, phoneKey } = fields;
  return database.transaction(async (trx) => {
    // Generation fence (the processor's other post-finalization writers do the
    // same): a newer pass that reclaimed or corrected the call owns it now, so
    // this pass's extraction is stale and files nothing. The row lock holds
    // until the insert commits.
    // The fence also names the AUDIO this pass heard (as upsertCommitments does):
    // an adopted or replaced recording swaps recording_sid without moving the
    // generation, so a pass still on the superseded audio files nothing.
    if (procGeneration != null) {
      const live = await trx('call_log').where({ id: call.id }).forUpdate().first('processing_generation', 'recording_sid');
      const sameRecording = !call.recording_sid || live?.recording_sid === call.recording_sid;
      if (!live || Number(live.processing_generation) !== Number(procGeneration) || !sameRecording) {
        return { created: false, id: null, reason: 'superseded' };
      }
    }
    // One writer at a time per call and per phone: two passes of the same call
    // (or two calls from one number) cannot both pass the checks below.
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`job_application_call:${call.id}`]);
    await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`job_application_phone:${phoneKey}`]);

    const forCall = await trx('job_applications')
      .whereRaw("source->>'call_log_id' = ?", [String(call.id)])
      .first('id');
    if (forCall) return { created: false, id: forCall.id, reason: 'already_filed_for_call' };

    const open = await trx('job_applications')
      .whereIn('status', OPEN_STATUSES)
      .whereRaw("right(regexp_replace(COALESCE(contact_snapshot->>'phone', ''), '[^0-9]', '', 'g'), 10) = ?", [phoneKey])
      .first('id');
    if (open) return { created: false, id: open.id, reason: 'open_application_same_phone' };

    const [row] = await trx('job_applications')
      .insert({
        role: 'technician',
        status: 'new',
        language: 'en',
        contact_snapshot: JSON.stringify({ name, phone, email, city: null }),
        answers: JSON.stringify({}),
        sms_consent: false,
        source: JSON.stringify(source),
      })
      .returning(['id']);
    return { created: true, id: row?.id || null, reason: 'created' };
  });
}

module.exports = {
  createJobApplicationFromCall,
  OPEN_STATUSES,
  ROLES,
  INTAKE_ROLES,
  STATUSES,
  ANSWER_KEYS,
  normalizeAnswers,
  normalizeSource,
  createJobApplication,
};
