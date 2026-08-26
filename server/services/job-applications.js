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

function normalizeAnswers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  for (const key of ANSWER_KEYS) {
    const value = raw[key];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    out[key] = trimmed.slice(0, MAX_ANSWER_CHARS);
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

  const email = cleanValidEmailOrNull(body.email);
  const city = cleanText(body.city || '').slice(0, 80) || null;

  const role = ROLES.includes(body.role) ? body.role : null;
  if (!role) {
    throw badRequest('Please pick the role you are applying for.');
  }

  const language = LANGUAGES.includes(body.language) ? body.language : 'en';
  const answers = normalizeAnswers(body.answers);

  const [row] = await database('job_applications')
    .insert({
      role,
      status: 'new',
      language,
      contact_snapshot: JSON.stringify({ name, phone, email, city }),
      answers: JSON.stringify(answers),
      source: (() => {
        const source = normalizeSource(body.source);
        return source ? JSON.stringify(source) : null;
      })(),
    })
    .returning(['id', 'role', 'status', 'language', 'created_at']);

  return row;
}

module.exports = {
  ROLES,
  STATUSES,
  ANSWER_KEYS,
  normalizeAnswers,
  normalizeSource,
  createJobApplication,
};
