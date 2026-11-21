/**
 * Job offers (GATE_JOB_OFFERS) — the owner's offer to a Recruiting applicant, the applicant's private link, and the
 * state machine behind both. Contract: the job-offer-flow build spec (owner "build" 2026-11-19).
 *
 * Shape of this module:
 *   - pure helpers (dates, validation, snapshot + signature hashes, the letter text, the public state) — no I/O,
 *     unit-tested on their own;
 *   - the Technician Terms lookup (ISSUED versions only, never a draft);
 *   - admin operations (panel, save draft, send, withdraw, revise, signed copy);
 *   - public operations (view, text consent, accept, date request, decline);
 *   - the scheduled 7-day close (closeExpiredOffers) and 2-day reminder (sendDueReminders);
 *   - the staff record a signed offer gets (makeStaffRecord, and its catch-up pass makeDueStaffRecords).
 *
 * Every state change is ONE transaction that locks the application row, then the offer row (always in that order),
 * re-reads the status under the lock and refuses a replay with the current state. Comms and bells run AFTER the
 * commit and never undo it.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { dateOnlyAtNoonUtc, dateOnlyString, formatDateOnly, validDateOnly } = require('../utils/date-only');
const { etDateString, etParts, parseETDateTime } = require('../utils/datetime-et');
const { addStaffWorkDays } = require('../utils/staff-time-work-date');
const { portalUrl } = require('../utils/portal-url');
const { hash: canonicalHash } = require('./staff-document-source');
const { WAVES_SUPPORT_PHONE_DISPLAY } = require('../constants/business');

const TERMS_TEMPLATE_KEY = 'staff.offer-letter';
const LIVE_STATUSES = ['draft', 'sent', 'date_requested'];
const OUT_STATUSES = ['sent', 'date_requested']; // the offer the applicant can act on
const CLOSED_APPLICATION_STATUSES = ['hired', 'rejected', 'withdrawn'];
const TOKEN_RE = /^[0-9a-f]{64}$/;

const DEFAULTS = Object.freeze({
  jobTitle: 'Pest Control Technician',
  hourlyRate: 23,
  stepRate: 25,
  hoursLine: '40 paid hours each full week, four 10-hour days, Monday to Thursday',
  leadDays: 21,
  stepAfterDays: 90,
  expiresAfterDays: 7,
});
const LIMITS = Object.freeze({ minRate: 15, maxRate: 60, titleChars: 100, hoursChars: 300, nameChars: 120, noteChars: 500 });

class OfferError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.name = 'OfferError';
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

// ------------------------------------------------------------------ dates
// Calendar-date checks, arithmetic and formatting come from the shared utils (utils/date-only.js,
// utils/staff-time-work-date.js on utils/datetime-et.js). Only the offer's own rules live here: a Monday-to-Thursday
// start, the Monday pay step after day 90, the 7-day expiry.

const isYmd = validDateOnly;
const dowOf = (ymd) => dateOnlyAtNoonUtc(ymd).getUTCDay(); // 0 Sunday .. 6 Saturday
const nextMondayOnOrAfter = (ymd) => addStaffWorkDays(ymd, (8 - dowOf(ymd)) % 7);

/**
 * First Monday strictly after day 90 (day 1 = the start date, so day 90 = start + 89 days, and the step is the first
 * Monday on or after start + 90 days). Null when that falls past 9999-12-31, which no calendar date can hold.
 */
function stepDateFor(startDate) {
  const dayAfter90 = addStaffWorkDays(startDate, DEFAULTS.stepAfterDays);
  if (!isYmd(dayAfter90)) return null;
  const monday = nextMondayOnOrAfter(dayAfter90);
  return isYmd(monday) ? monday : null;
}

/** The first Monday at least 21 days after today (ET). */
function suggestStartDate(now = new Date()) {
  return nextMondayOnOrAfter(addStaffWorkDays(etDateString(now), DEFAULTS.leadDays));
}

/** 23:59:59 America/New_York on the send day + 7 days. */
function expiryFor(now = new Date()) {
  return parseETDateTime(`${addStaffWorkDays(etDateString(now), DEFAULTS.expiresAfterDays)}T23:59:59`);
}

// "Mon, Jan 4" or, with the year, "Mon, Jan 4, 2027" (a calendar date; no zone shift).
const fmtDay = (ymd, { year = false } = {}) => (isYmd(ymd)
  ? formatDateOnly(ymd, { weekday: 'short', month: 'short', year: year ? 'numeric' : undefined })
  : '');
const fmtMonthDay = (ymd) => (isYmd(ymd) ? formatDateOnly(ymd, { month: 'short', year: undefined }) : '');
const money = (value) => `$${Number(value).toFixed(2)}`;
const instantToEtDay = (value) => etDateString(value instanceof Date ? value : new Date(value));
const iso = (value) => (value ? new Date(value).toISOString() : null);
const ymdOf = (value) => dateOnlyString(value);

// ------------------------------------------------------------- validation

const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const FORBIDDEN_COPY = /background check|drug test|drug screen/i;
const cleanText = (value) => String(value).replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();

function parseRate(value) {
  if (value === null || value === undefined || value === '') return { value: null };
  const number = typeof value === 'number' ? value : (typeof value === 'string' && /^\d+(\.\d{1,2})?$/.test(value.trim()) ? Number(value) : NaN);
  if (!Number.isFinite(number) || Math.abs(number * 100 - Math.round(number * 100)) > 1e-6) return { error: true };
  return { value: Math.round(number * 100) / 100 };
}

function checkText(errors, field, value, max, label) {
  if (typeof value !== 'string' || !cleanText(value)) { errors.push({ field, message: `${label} is required.` }); return null; }
  const text = cleanText(value);
  if (text.length > max) errors.push({ field, message: `${label} must be ${max} characters or fewer.` });
  if (FORBIDDEN_COPY.test(text)) errors.push({ field, message: `${label} cannot mention that.` });
  return text;
}

function checkStartDate(errors, value, now) {
  if (!isYmd(value)) { errors.push({ field: 'startDate', message: 'Pick a start date.' }); return; }
  if (value <= etDateString(now)) errors.push({ field: 'startDate', message: 'The start date must be in the future.' });
  if (![1, 2, 3, 4].includes(dowOf(value))) errors.push({ field: 'startDate', message: 'The start date must be a Monday to Thursday.' });
}

function checkRates(errors, hourly, step) {
  const inRange = (n) => n >= LIMITS.minRate && n <= LIMITS.maxRate;
  if (hourly.error || hourly.value === null || !inRange(hourly.value)) {
    errors.push({ field: 'hourlyRate', message: `The hourly rate must be $${LIMITS.minRate.toFixed(2)} to $${LIMITS.maxRate.toFixed(2)}.` });
  }
  if (step.error || (step.value !== null && !inRange(step.value))) {
    errors.push({ field: 'stepRate', message: `The step rate must be $${LIMITS.minRate.toFixed(2)} to $${LIMITS.maxRate.toFixed(2)}.` });
  } else if (step.value !== null && hourly.value !== null && step.value <= hourly.value) {
    errors.push({ field: 'stepRate', message: 'The step rate must be higher than the hourly rate.' });
  }
}

function checkStepDate(errors, stepRate, stepOn, startDate) {
  const hasRate = stepRate !== null;
  const hasDate = stepOn !== null && stepOn !== undefined && stepOn !== '';
  if (hasRate !== hasDate) {
    errors.push({ field: hasRate ? 'stepEffectiveOn' : 'stepRate', message: 'Set the step rate and its start date together, or neither.' });
    return;
  }
  if (!hasDate) return;
  if (!isYmd(stepOn) || dowOf(stepOn) !== 1) errors.push({ field: 'stepEffectiveOn', message: 'The step date must be a Monday.' });
  else if (isYmd(startDate) && stepOn <= startDate) errors.push({ field: 'stepEffectiveOn', message: 'The step date must be after the start date.' });
}

/**
 * Validates a full offer input (the six owner-editable fields). Returns { value, errors }; value is the normalized
 * input, errors is [] when the offer is valid.
 */
function validateOffer(input, now = new Date()) {
  const errors = [];
  const jobTitle = checkText(errors, 'jobTitle', input.jobTitle, LIMITS.titleChars, 'The job title');
  const hoursLine = checkText(errors, 'hoursLine', input.hoursLine, LIMITS.hoursChars, 'The hours line');
  checkStartDate(errors, input.startDate, now);
  const hourly = parseRate(input.hourlyRate);
  const step = parseRate(input.stepRate);
  checkRates(errors, hourly, step);
  const stepOn = input.stepEffectiveOn === undefined || input.stepEffectiveOn === '' ? null : input.stepEffectiveOn;
  checkStepDate(errors, step.error ? 0 : step.value, stepOn, input.startDate);
  return {
    errors,
    value: {
      jobTitle, hoursLine, startDate: input.startDate,
      hourlyRate: hourly.value, stepRate: step.value, stepEffectiveOn: step.value === null ? null : stepOn,
    },
  };
}

const INPUT_KEYS = ['startDate', 'hourlyRate', 'stepRate', 'stepEffectiveOn', 'jobTitle', 'hoursLine'];
const has = (input, key) => Object.prototype.hasOwnProperty.call(input, key) && input[key] !== undefined;

/**
 * Overlays the keys a request carried on a base (the current draft, or the defaults). A CHANGED start date recomputes the
 * step date (the same date sent again does not) unless the request set it; clearing the step rate clears the step date.
 */
function mergeOfferInput(base, input) {
  const merged = { ...base };
  for (const key of INPUT_KEYS) if (has(input, key)) merged[key] = input[key];
  const stepRateEmpty = merged.stepRate === null || merged.stepRate === '' || merged.stepRate === undefined;
  if (has(input, 'stepRate') && stepRateEmpty && !has(input, 'stepEffectiveOn')) {
    merged.stepEffectiveOn = null;
  } else if (!stepRateEmpty && !has(input, 'stepEffectiveOn') && ((has(input, 'startDate') && input.startDate !== base.startDate) || !merged.stepEffectiveOn) && isYmd(merged.startDate)) {
    merged.stepEffectiveOn = stepDateFor(merged.startDate);
  }
  return merged;
}

function defaultsFor(now = new Date()) {
  const startDate = suggestStartDate(now);
  return {
    jobTitle: DEFAULTS.jobTitle,
    startDate,
    hourlyRate: DEFAULTS.hourlyRate,
    stepRate: DEFAULTS.stepRate,
    stepEffectiveOn: stepDateFor(startDate),
    hoursLine: DEFAULTS.hoursLine,
  };
}

function inputOfRow(row) {
  return {
    jobTitle: row.job_title,
    startDate: ymdOf(row.start_date),
    hourlyRate: Number(row.hourly_rate),
    stepRate: row.step_rate === null || row.step_rate === undefined ? null : Number(row.step_rate),
    stepEffectiveOn: row.step_effective_on ? ymdOf(row.step_effective_on) : null,
    hoursLine: row.hours_line,
  };
}

// ----------------------------------------------------------------- hashes

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');
const snapshotHashOf = (snapshot) => canonicalHash(snapshot);
/** sha256 of snapshot_hash | terms_content_hash | signed_name | signed_at (ISO), joined with a pipe. */
const signatureHashOf = ({ snapshotHash, termsContentHash, signedName, signedAt }) => sha256(
  [snapshotHash, termsContentHash, signedName, new Date(signedAt).toISOString()].join('|'),
);

// ------------------------------------------------------------ the letter

const payLine = (view) => {
  const base = `${money(view.hourlyRate)} an hour`;
  return view.stepRate === null || view.stepRate === undefined || !view.stepEffectiveOn
    ? base
    : `${base}, ${money(view.stepRate)} from ${fmtMonthDay(view.stepEffectiveOn)}`;
};

/**
 * The personal page as one Markdown text: the owner's line, the six rows, the notice line and the issued Terms. The
 * owner reads this before pressing Send; a signed copy is this text from the frozen snapshot.
 */
function renderLetterMarkdown(view) {
  const rows = [
    `- **Job:** ${view.jobTitle}`,
    `- **Start:** ${fmtDay(view.startDate, { year: true })}`,
    `- **Pay:** ${payLine(view)}`,
    `- **Week:** ${view.hoursLine}`,
    `- **Reports to:** ${view.reportTo}`,
    ...(view.payDayLine ? [`- **Pay day:** ${view.payDayLine}`] : []),
  ];
  const parts = [
    '# Your job offer',
    `Signed by ${view.owner.name}, ${view.owner.title} · ${fmtDay(view.owner.sentOn, { year: true })}`,
    rows.join('\n'),
    "Please don't give notice at your current job until you have signed this offer.",
  ];
  if (view.terms && view.terms.markdown) parts.push(`## ${view.terms.title}\n\n${view.terms.markdown}`);
  else parts.push('The Technician Terms are not issued yet.');
  if (view.expiresAt) parts.push(`Open until ${fmtDay(instantToEtDay(view.expiresAt))}`);
  return parts.join('\n\n');
}

// A clause heading carries its stable id ("## Title {#anchor}"); a reader sees the title only.
const readableTerms = (body) => String(body || '').replace(/^(#{1,6} .+?) \{#[a-z][a-z0-9-]*\}[ \t]*$/gm, '$1');

function payDayLineFrom(values) {
  if (!values || typeof values.pay_frequency !== 'string' || typeof values.pay_schedule !== 'string') return null;
  const frequency = { weekly: 'weekly', biweekly: 'every two weeks', 'semi-monthly': 'twice a month', monthly: 'monthly' }[values.pay_frequency];
  const schedule = values.pay_schedule.trim();
  if (!frequency || !schedule || /\[DECISION|\{\{/.test(schedule)) return null;
  const line = `Paid ${frequency}. ${schedule}${/[.!?]$/.test(schedule) ? '' : '.'}`;
  // Never cut an issued schedule short: a line that does not fit the 500-character column is no line (a Send blocker).
  return line.length > 500 ? null : line;
}

// ------------------------------------------------------------- the Terms

const asObject = (value) => {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(value) || {}; } catch { return {}; }
};

async function currentPolicyValues(conn, now) {
  const policy = await conn('policy_values').where('effective_at', '<=', now).orderBy('effective_at', 'desc').first();
  return policy ? asObject(policy.values) : null;
}

/**
 * The Technician Terms an offer can be sent with: the staff document `staff.offer-letter`, its ISSUED version in force
 * now (never a draft), with no [DECISION marker in the rendered text. Returns { terms, payDayLine, blockers }; terms
 * and payDayLine are null while any blocker stands.
 */
async function loadIssuedTerms(conn = db, now = new Date()) {
  const blockers = [];
  const document = await conn('document_templates').where({ template_key: TERMS_TEMPLATE_KEY, audience: 'staff' }).first('id', 'name');
  if (!document) return { terms: null, payDayLine: null, blockers: ['The Technician Terms document is not set up.'] };
  const version = await conn('document_template_versions')
    .where({ template_id: document.id })
    .whereNotNull('published_at').whereNotNull('content_snapshot')
    .where('effective_at', '<=', now)
    .orderBy('effective_at', 'desc').orderBy('version_number', 'desc')
    .first('id', 'content_hash', 'published_at', 'content_snapshot');
  if (!version) return { terms: null, payDayLine: null, blockers: ['The Technician Terms have no issued version.'] };

  const snapshot = asObject(version.content_snapshot);
  if (!snapshot.body || !snapshot.title) blockers.push('The issued Technician Terms are empty.');
  if (/\[DECISION/.test(`${snapshot.title || ''}\n${snapshot.body || ''}`)) blockers.push('The issued Technician Terms still hold a [DECISION marker.');
  const payDayLine = payDayLineFrom(snapshot.policy_values || await currentPolicyValues(conn, now));
  if (!payDayLine) blockers.push('The pay frequency and pay schedule are missing, or too long to print on the offer (500 characters in all).');
  if (blockers.length) return { terms: null, payDayLine: null, blockers };
  return {
    blockers,
    payDayLine,
    terms: {
      templateId: document.id,
      versionId: version.id,
      title: snapshot.title,
      issuedAt: iso(version.published_at),
      contentHash: version.content_hash,
      markdown: readableTerms(snapshot.body),
    },
  };
}

// --------------------------------------------------------------- snapshot

function buildSnapshot({ offer, application, owner, terms, payDayLine, expiresAt, sentAt }) {
  const input = inputOfRow(offer);
  return {
    version: 1,
    offerId: offer.id,
    firstName: firstNameOf(application),
    applicantName: contactOf(application).name || '',
    jobTitle: input.jobTitle,
    startDate: input.startDate,
    hourlyRate: input.hourlyRate,
    stepRate: input.stepRate,
    stepEffectiveOn: input.stepEffectiveOn,
    hoursLine: input.hoursLine,
    reportTo: owner.reportTo,
    payDayLine,
    owner: { name: owner.name, title: 'owner', sentOn: etDateString(sentAt) },
    expiresAt: expiresAt.toISOString(),
    terms: { templateId: terms.templateId, versionId: terms.versionId, contentHash: terms.contentHash, title: terms.title, markdown: terms.markdown },
  };
}

function contactOf(application) {
  let snap = application && application.contact_snapshot;
  if (typeof snap === 'string') snap = asObject(snap);
  snap = snap || {};
  return { name: snap.name || '', phone: snap.phone || null, email: snap.email || null };
}
const firstNameOf = (application) => String(contactOf(application).name).trim().split(/\s+/)[0] || 'there';
const ownerReportTo = (name) => `${name}, owner`;
// The signer a draft's preview names (Signed by, Reports to) when the reader is not an owner account. Only an owner
// account sends, and the Send names the owner who sends it, so another admin's preview names no one: never the reader.
const UNNAMED_SIGNER = "[owner's name]";
const ownerFirstName = (snapshot) => String((snapshot && snapshot.owner && snapshot.owner.name) || 'Adam').trim().split(/\s+/)[0] || 'Adam';

// ----------------------------------------------------------------- state

/**
 * What the applicant's page shows for a row: open | signed | declined | date_requested | expired | withdrawn |
 * superseded, or null for a draft. An offer past its expiry reads expired, before that state is stored and after it,
 * whatever the application does later: it closed on that date. (The 7-day close, a Send and a stage move each store
 * it.) An open offer or a date request whose application the owner closed or moved back reads withdrawn.
 */
function publicStateOf(offer, { now = new Date(), applicationStatus = null } = {}) {
  switch (offer.status) {
    case 'accepted': return 'signed';
    case 'declined': return 'declined';
    case 'withdrawn': return 'withdrawn';
    case 'superseded': return 'superseded';
    case 'expired': return 'expired';
    case 'sent':
    case 'date_requested': {
      if (expiredByClock(offer, now)) return 'expired';
      // A live offer belongs to an application sitting at 'offer': closed, or moved back to review or interview, it is dead.
      if (applicationStatus && applicationStatus !== 'offer') return 'withdrawn';
      return offer.status === 'date_requested' ? 'date_requested' : 'open';
    }
    default: return null;
  }
}

function closedMessage(state, snapshot, offer) {
  const owner = ownerFirstName(snapshot);
  if (state === 'superseded') return `This offer was updated. Please use the newest link ${owner} sent you.`;
  if (state === 'withdrawn') return `This offer is no longer open. Please call ${owner} at ${WAVES_SUPPORT_PHONE_DISPLAY}.`;
  return `This offer closed on ${fmtDay(instantToEtDay(offer.expires_at), { year: true })}. Please call ${owner} at ${WAVES_SUPPORT_PHONE_DISPLAY} if you still want the job.`;
}

// A sent offer past its expiry whose row does not say so yet. One rule for every reader and writer: such an offer is
// expired. The 7-day close stores it (closeExpiredOffers); a Send (supersedePrior) or a stage move
// (closeOffersWithApplication) that comes first stores the same state.
const expiredByClock = (row, now) => row.status === 'sent' && Boolean(row.expires_at) && now.getTime() > new Date(row.expires_at).getTime();

// ------------------------------------------------------------ admin shape

function timelineOf(row, { sentByName = null } = {}) {
  const items = [{ at: iso(row.created_at), kind: 'drafted', label: 'Offer drafted' }];
  const add = (at, kind, label) => { if (at) items.push({ at: iso(at), kind, label }); };
  add(row.sent_at, 'sent', sentByName ? `Offer sent by ${sentByName}` : 'Offer sent');
  add(row.opened_at, 'opened', 'Applicant opened the offer');
  add(row.text_consent_at, 'text_consent', 'Applicant agreed to texts about the offer');
  add(row.reminder_sent_at, 'reminded', 'Reminder sent');
  add(row.signed_at, 'signed', `Signed by ${row.signed_name}`);
  add(row.declined_at, 'declined', row.decline_reason ? `Declined: ${row.decline_reason}` : 'Declined');
  if (row.date_requested_at) {
    const note = row.date_request_note ? ` (${row.date_request_note})` : '';
    add(row.date_requested_at, 'date_requested', `Asked to start ${fmtDay(ymdOf(row.requested_start_date), { year: true })}${note}`);
  }
  add(row.withdrawn_at, 'withdrawn', 'Offer withdrawn');
  if (row.status === 'superseded') add(row.updated_at, 'superseded', 'Replaced by an updated offer');
  if (row.status === 'expired') add(row.expires_at, 'expired', 'Closed unsigned');
  const staff = asObject(row.checklist)[STAFF_RECORD_KEY];
  if (staff && staffRecordLabel(staff)) add(staff.at, 'staff_record', staffRecordLabel(staff));
  add(row.activated_at, 'activated', 'Login turned on');
  for (const item of FIRST_DAYS_ITEMS) {
    const mark = asObject(row.checklist)[item.key];
    if (mark) add(mark.at, 'checklist_done', `${item.label} marked done${mark.by_name ? ` by ${mark.by_name}` : ''}`);
  }
  return items.sort((a, b) => a.at.localeCompare(b.at));
}

/** The admin shape of an offer row (camelCase). The offer URL rides only here and only once a token exists. */
function presentOffer(source, { sentByName = null, draftHash = null, now = new Date(), includeUrl = false } = {}) {
  if (!source) return null;
  // A sent offer past its expiry reads expired (as on the applicant's page) until the sweep flips the row.
  const row = expiredByClock(source, now) ? { ...source, status: 'expired' } : source;
  return {
    id: row.id,
    applicationId: row.application_id,
    status: row.status,
    ...inputOfRow(row),
    reportTo: row.report_to,
    payDayLine: row.pay_day_line || null,
    expiresAt: iso(row.expires_at),
    // The link is the applicant's signing credential: only the owner account reads it.
    offerUrl: includeUrl && row.token ? portalUrl(`/careers/offer/${row.token}`) : null,
    sentAt: iso(row.sent_at),
    sentByName,
    openedAt: iso(row.opened_at),
    lastViewedAt: iso(row.last_viewed_at),
    textConsentAt: iso(row.text_consent_at),
    reminderSentAt: iso(row.reminder_sent_at),
    signedAt: iso(row.signed_at),
    signedName: row.signed_name || null,
    declinedAt: iso(row.declined_at),
    declineReason: row.decline_reason || null,
    dateRequestedAt: iso(row.date_requested_at),
    requestedStartDate: row.requested_start_date ? ymdOf(row.requested_start_date) : null,
    dateRequestNote: row.date_request_note || null,
    withdrawnAt: iso(row.withdrawn_at),
    supersedesId: row.supersedes_id || null,
    supersededById: row.superseded_by_id || null,
    technicianId: row.technician_id || null,
    activatedAt: iso(row.activated_at),
    checklist: asObject(row.checklist),
    termsVersionId: row.terms_version_id || null,
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
    timeline: timelineOf(row, { sentByName }),
    ...(row.status === 'draft' ? { draftHash } : {}),
  };
}

async function sentByNames(conn, rows) {
  const ids = [...new Set(rows.map((r) => r.sent_by).filter(Boolean))];
  if (!ids.length) return new Map();
  try {
    const staff = await conn('technicians').whereIn('id', ids).select('id', 'name');
    return new Map(staff.map((s) => [s.id, s.name]));
  } catch (err) {
    logger.warn(`[job-offers] sender names unavailable: ${errTag(err)}`);
    return new Map();
  }
}

const errTag = (err) => `${(err && err.name) || 'Error'}${err && err.code ? ` ${err.code}` : ''}`;

// ------------------------------------------------------------ admin reads

async function loadApplication(conn, applicationId, { lock = false } = {}) {
  let query = conn('job_applications').where({ id: applicationId });
  if (lock) query = query.forUpdate();
  const application = await query.first();
  if (!application) throw new OfferError(404, 'NOT_FOUND', 'Not found');
  return application;
}

function assertOfferable(application) {
  if (application.role !== 'technician') {
    throw new OfferError(409, 'ROLE_NOT_SUPPORTED', 'Offers are for the Technician role only.');
  }
  if (CLOSED_APPLICATION_STATUSES.includes(application.status)) {
    throw new OfferError(409, 'APPLICATION_CLOSED', `This application is ${application.status}.`);
  }
}

function previewView({ offerInput, application, actor, terms, payDayLine, expiresAt = null, now }) {
  return {
    ...offerInput,
    reportTo: ownerReportTo(actor.name),
    payDayLine,
    owner: { name: actor.name, title: 'owner', sentOn: etDateString(now) },
    expiresAt,
    terms,
    firstName: firstNameOf(application),
  };
}

const money2 = (value) => (value === null || value === undefined ? null : Number(value).toFixed(2));

/**
 * What a Send is checked against: sha256 of the personal fields (rates as 2-decimal strings), the issued Terms version
 * the preview used and the letter text the owner read. Any edit to the draft, a new Terms version, a new pay policy or a
 * new day changes it, so a Send of a stale preview is refused (DRAFT_CHANGED).
 */
function draftHashOf(row, { terms, payDayLine, ownerName, now }) {
  const input = inputOfRow(row);
  const letter = renderLetterMarkdown(previewView({
    offerInput: input, application: null, actor: { name: ownerName }, terms, payDayLine, now, expiresAt: iso(expiryFor(now)),
  }));
  return canonicalHash({
    fields: {
      jobTitle: input.jobTitle, startDate: input.startDate, hourlyRate: money2(input.hourlyRate), stepRate: money2(input.stepRate),
      stepEffectiveOn: input.stepEffectiveOn, hoursLine: input.hoursLine,
    },
    termsVersionId: terms ? terms.versionId : null,
    letter,
  });
}

// The admin shape of a draft row, with its hash, for a writer that has the transaction at hand.
async function presentDraft(conn, row, ownerName, now) {
  const { terms, payDayLine } = await loadIssuedTerms(conn, now);
  return presentOffer(row, { draftHash: draftHashOf(row, { terms, payDayLine, ownerName, now }) });
}

/** GET /:id/offer */
// Which of an application's offers (rows newest first) the panel shows where:
// - out: the offer the applicant can act on (sent / date_requested, not past its expiry); draft: the open draft.
// - current: out, else the open draft, else the newest offer the applicant received (signed, declined, withdrawn,
//   replaced or expired), else the newest of any status (a draft closed unsent). A revision that was never sent and
//   was then closed is newer, but never outranks the offer the applicant received: signing or declining the offer
//   out closes the revision the owner was drafting.
// - revision: a revision in progress, the open draft when it is not itself current.
function panelOffers(rows, now) {
  const draft = rows.find((r) => r.status === 'draft') || null;
  const out = rows.find((r) => OUT_STATUSES.includes(r.status) && !expiredByClock(r, now)) || null;
  const current = out || draft || rows.find((r) => r.sent_at) || rows[0] || null;
  const revision = draft && draft.id !== current.id ? draft : null; // a draft makes current non-null (out || draft)
  return { draft, out, current, revision };
}

// The panel reads the application and its offers in one snapshot. A signature or a decline moves both in one
// transaction, so the stage the panel returns (applicationStatus) is the one its offers were read with, and the page
// can tell when its own, separate read of the application is behind the offer card.
const PANEL_SNAPSHOT = Object.freeze({ isolationLevel: 'repeatable read', readOnly: true });

async function adminPanel(applicationId, actor, now = new Date()) {
  const { application, rows, signed, firstDay } = await db.transaction(async (trx) => {
    const app = await loadApplication(trx, applicationId);
    const offers = await trx('job_offers').where({ application_id: applicationId }).orderBy('created_at', 'desc');
    // The first-days checklist: a Hired application's signed offers, newest signature first, and the first day.
    const signedOffers = app.status === 'hired' ? newestSignedFirst(offers) : [];
    return { application: app, rows: offers, signed: signedOffers, firstDay: signedOffers.length ? await firstDayOf(trx, signedOffers) : null };
  }, PANEL_SNAPSHOT);
  const names = await sentByNames(db, rows);
  const { terms, payDayLine, blockers } = await loadIssuedTerms(db, now);
  const hashCtx = { terms, payDayLine, ownerName: actor.name, now };
  const present = (row) => presentOffer(row, {
    now,
    includeUrl: Boolean(actor.ownerAccount),
    sentByName: (row && names.get(row.sent_by)) || null,
    ...(row && row.status === 'draft' ? { draftHash: draftHashOf(row, hashCtx) } : {}),
  });
  const { draft, out, current, revision } = panelOffers(rows, now);
  // The preview names the reader as the signer only for an owner account (who would send it). The draft hash keeps the
  // reader's own name: for another admin it is only the token their save is checked against, by that same name.
  const signer = actor.ownerAccount ? actor.name : UNNAMED_SIGNER;
  const defaults = { ...defaultsFor(now), reportTo: ownerReportTo(signer), payDayLine, expiresAt: iso(expiryFor(now)) };
  // The letter preview follows the draft being worked on; with no draft it is the frozen letter of the offer that is out.
  const shown = draft || out;
  // With no draft, the preview is the letter the applicant received (the frozen snapshot of the current offer, closed or
  // out), never today's defaults, name and Terms.
  const frozen = !draft && current && current.snapshot ? current : null;
  const view = frozen
    ? asObject(frozen.snapshot)
    : previewView({
      offerInput: shown ? inputOfRow(shown) : defaults, application, actor: { ...actor, name: signer }, terms, payDayLine, now,
      expiresAt: iso(expiryFor(now)),
    });
  return {
    enabled: true,
    // The application's stage as this read saw it with the offers below.
    applicationStatus: application.status,
    termsIssued: !blockers.length,
    terms: terms ? { templateId: terms.templateId, versionId: terms.versionId, title: terms.title, issuedAt: terms.issuedAt } : null,
    termsBlockers: blockers,
    defaults,
    sendTo: sendTargetsOf(application),
    // The offer out now that sending the open draft replaces (its link stops working at the send), or null. `out` is
    // already null for an offer past its expiry, whose link no longer works.
    sendReplacesId: replacedBySend(out, revision),
    // The offers the applicant holds now (a sent offer not past its expiry, a date request) as this read saw them, each
    // with its version. Send carries it back (expectedOut), so an answer or a date request after this read refuses the
    // send (commitSend). An offer past its expiry is left out, stored as expired or not: see liveOffersOf.
    outStamp: offerStampOf(rows.filter((r) => isHeldOffer(r, now))),
    // The preview names the offer its letter belongs to (the open draft, else the frozen letter of the current offer, else
    // none: the defaults) and that draft's hash, so a Save, Send or Discard can be tied to what was read.
    letterPreview: {
      offerId: draft ? draft.id : (frozen ? current.id : null),
      draftHash: draft ? draftHashOf(draft, hashCtx) : null,
      markdown: renderLetterMarkdown(view),
    },
    current: present(current),
    // The first-days checklist of a Hired application, on its newest signed offer (firstDays.offerId), or null.
    firstDays: signed.length ? firstDaysOf(signed[0], firstDaysMarks(signed), firstDay) : null,
    draft: present(revision),
    history: rows.filter((r) => !current || (r.id !== current.id && !(revision && r.id === revision.id))).map(present),
  };
}

// ----------------------------------------------------------- admin writes

async function actorName(conn, actor) {
  if (actor && actor.name) return actor.name;
  const row = await conn('technicians').where({ id: actor.id }).first('name');
  return (row && row.name) || 'Adam';
}

// A save over an open draft must name that draft and the hash of the preview the saver read (another admin's edit since
// then refuses the save, writing nothing). With no draft yet, the two are ignored.
async function assertDraftUnchanged(trx, draft, input, ownerName, now) {
  const { terms, payDayLine } = await loadIssuedTerms(trx, now);
  const current = draftHashOf(draft, { terms, payDayLine, ownerName, now });
  if (!input || input.draftId !== draft.id || input.draftHash !== current) {
    throw new OfferError(409, 'DRAFT_CHANGED', 'This draft changed after you opened it. Review the new preview, then save.');
  }
}

/** POST /:id/offer — create or update the one DRAFT. */
async function saveDraft(applicationId, input, actor, now = new Date()) {
  return db.transaction(async (trx) => {
    const application = await loadApplication(trx, applicationId, { lock: true });
    assertOfferable(application);
    const draft = await trx('job_offers').where({ application_id: applicationId, status: 'draft' }).forUpdate().first();
    if (draft) await assertDraftUnchanged(trx, draft, input, await actorName(trx, actor), now);
    // A save that names a draft which is gone (withdrawn, sent) must not quietly start a new one from defaults.
    if (!draft && input && input.draftId) {
      throw new OfferError(409, 'DRAFT_CHANGED', 'This draft changed after you opened it. Review the new preview, then save.');
    }
    if (!draft) {
      const out = await trx('job_offers').where({ application_id: applicationId }).whereIn('status', OUT_STATUSES).first('id', 'status', 'expires_at');
      // An offer past its expiry reads expired already; a fresh draft may replace it (the send closes the old row).
      if (out && !expiredByClock(out, now)) throw new OfferError(409, 'OFFER_ALREADY_OPEN', 'An offer is already out. Use Revise to make an updated one.', { offerId: out.id });
    }
    const base = draft ? inputOfRow(draft) : defaultsFor(now);
    const { value, errors } = validateOffer(mergeOfferInput(base, input), now);
    if (errors.length) throw new OfferError(400, 'INVALID_OFFER', errors[0].message, { errors });
    const reportTo = ownerReportTo(await actorName(trx, actor));
    const columns = columnsOf(value, reportTo);
    if (draft) {
      const [row] = await trx('job_offers').where({ id: draft.id }).update({ ...columns, updated_at: nextVersion(draft) }).returning('*');
      return presentDraft(trx, row, await actorName(trx, actor), now);
    }
    const [row] = await trx('job_offers').insert({ application_id: applicationId, status: 'draft', created_by: actor.id, ...columns }).returning('*');
    return presentDraft(trx, row, await actorName(trx, actor), now);
  });
}

function columnsOf(value, reportTo) {
  return {
    job_title: value.jobTitle,
    start_date: value.startDate,
    hourly_rate: value.hourlyRate,
    step_rate: value.stepRate,
    step_effective_on: value.stepEffectiveOn,
    hours_line: value.hoursLine,
    report_to: reportTo,
  };
}

async function loadOffer(conn, applicationId, offerId, { lock = false } = {}) {
  let query = conn('job_offers').where({ id: offerId, application_id: applicationId });
  if (lock) query = query.forUpdate();
  const offer = await query.first();
  if (!offer) throw new OfferError(404, 'NOT_FOUND', 'Not found');
  return offer;
}

// The status the caller saw, checked under the row lock: a stale tab must not act on an offer that moved on.
function assertExpectedStatus(offer, expectedStatus, allowed) {
  if (!allowed.includes(expectedStatus)) {
    throw new OfferError(400, 'EXPECTED_STATUS_REQUIRED', 'Say which state of the offer you are acting on.');
  }
  if (offer.status !== expectedStatus) {
    throw new OfferError(409, 'OFFER_CHANGED', 'This offer changed after you opened it. Review it again.', { status: offer.status });
  }
}

// Revise yields an editable draft: a start date that no longer works (passed, or not Monday to Thursday) falls back to the
// suggested start, and the raise date follows the start date. Save and Send validate dates. Only an explicit start date
// that no longer works is refused (reviseOffer), so the fallback here applies to the asked or the old start date.
function reviseInput(offer, requested, now) {
  const base = inputOfRow(offer);
  const wanted = requested || base.startDate;
  const checks = [];
  checkStartDate(checks, wanted, now);
  const startDate = checks.length ? suggestStartDate(now) : wanted;
  if (startDate === base.startDate) return base;
  return { ...base, startDate, stepEffectiveOn: base.stepRate === null ? null : stepDateFor(startDate) };
}

/**
 * POST /:id/offer/:offerId/revise — a new draft copied from a sent / date_requested offer. Needs { expectedStatus }; an
 * optional { startDate } (the card's dated update) must still be a start date the server takes, or nothing is written.
 * fixedNow: a clock for tests; without it the clock is read once every row lock is held.
 */
async function reviseOffer(applicationId, offerId, input, actor, fixedNow) {
  const request = input && typeof input === 'object' ? input : {};
  if (!OUT_STATUSES.includes(request.expectedStatus)) {
    throw new OfferError(400, 'EXPECTED_STATUS_REQUIRED', 'Say which state of the offer you are acting on.');
  }
  return db.transaction(async (trx) => {
    const application = await loadApplication(trx, applicationId, { lock: true });
    assertOfferable(application);
    const offer = await loadOffer(trx, applicationId, offerId, { lock: true });
    assertExpectedStatus(offer, request.expectedStatus, OUT_STATUSES);
    const existing = await trx('job_offers').where({ application_id: applicationId, status: 'draft' }).forUpdate().first();
    // Every row lock is held: the clock is read now, so a request that waited for a lock across Eastern midnight is
    // judged by the day it writes in (the expiry, the start date and the draft alike).
    const now = fixedNow || new Date();
    if (expiredByClock(offer, now)) {
      throw new OfferError(409, 'OFFER_NOT_REVISABLE', 'Only an offer that is out can be revised.', { status: 'expired' });
    }
    if (existing && existing.supersedes_id !== offer.id) {
      throw new OfferError(409, 'DRAFT_EXISTS', 'There is already a draft. Send or withdraw it first.', { offerId: existing.id });
    }
    const ownerName = await actorName(trx, actor);
    // A retry (or a second tab) gets the draft that is already there, untouched: it may hold newer edits.
    if (existing) return presentDraft(trx, existing, ownerName, now);
    // An explicit start date comes from the card's dated update, whose button names that day. When the server no longer
    // takes it (the Eastern day came while the click was on its way), the revision is refused and nothing is written, so
    // no draft starts on another day than the button named. Any value the request carries is checked, an empty one too;
    // only a request without the field falls back (reviseInput).
    if (request.startDate !== undefined) {
      const checks = [];
      checkStartDate(checks, request.startDate, now);
      if (checks.length) {
        throw new OfferError(409, 'START_DATE_UNAVAILABLE', `${checks.map((c) => c.message).join(' ')} Nothing was changed. Use Revise to choose another start date.`);
      }
    }

    const requested = request.startDate || (offer.requested_start_date ? ymdOf(offer.requested_start_date) : null);
    const [row] = await trx('job_offers').insert({
      application_id: applicationId, status: 'draft', created_by: actor.id, supersedes_id: offer.id,
      ...columnsOf(reviseInput(offer, requested, now), ownerReportTo(ownerName)),
    }).returning('*');
    return presentDraft(trx, row, ownerName, now);
  });
}

/**
 * POST /:id/offer/:offerId/withdraw — sends nothing; the application status stays as it is. Needs { expectedStatus } (the
 * state the owner saw: 'draft', 'sent' or 'date_requested') and, for a draft, the { draftHash } of the preview he read.
 * fixedNow: a clock for tests; without it the clock is read once both row locks are held.
 */
async function withdrawOffer(applicationId, offerId, actor, precondition = {}, fixedNow) {
  const { expectedStatus, draftHash } = precondition || {};
  if (!LIVE_STATUSES.includes(expectedStatus)) {
    throw new OfferError(400, 'EXPECTED_STATUS_REQUIRED', 'Say which state of the offer you are acting on.');
  }
  if (expectedStatus === 'draft' && (typeof draftHash !== 'string' || !draftHash)) {
    throw new OfferError(400, 'DRAFT_HASH_REQUIRED', 'Discarding a draft needs the hash of the preview you reviewed.');
  }
  return db.transaction(async (trx) => {
    await loadApplication(trx, applicationId, { lock: true });
    const offer = await loadOffer(trx, applicationId, offerId, { lock: true });
    // Both rows are locked: the clock is read now. A withdrawal that waited for a lock while the offer passed its
    // expiry is refused, so an offer whose link already read closed is never stored as withdrawn.
    const now = fixedNow || new Date();
    assertExpectedStatus(offer, expectedStatus, LIVE_STATUSES);
    if (expectedStatus === 'draft') {
      const { terms, payDayLine } = await loadIssuedTerms(trx, now);
      const current = draftHashOf(offer, { terms, payDayLine, ownerName: await actorName(trx, actor), now });
      if (current !== draftHash) throw new OfferError(409, 'DRAFT_CHANGED', 'This draft changed after you opened it. Review the new preview, then discard it.');
    }
    if (expiredByClock(offer, now)) {
      throw new OfferError(409, 'OFFER_NOT_WITHDRAWABLE', 'This offer can no longer be withdrawn.', { status: 'expired' });
    }
    const [row] = await trx('job_offers').where({ id: offer.id }).update({
      status: 'withdrawn', withdrawn_at: now, withdrawn_by: actor.id, updated_at: new Date(),
    }).returning('*');
    return presentOffer(row);
  });
}

/**
 * An application the owner closes (rejected, withdrawn, hired) takes its outstanding offers with it, in the same
 * transaction as the stage change: moving the application back later must never revive the old link. Sends nothing.
 */
/**
 * The offers on an application that the applicant still holds: a sent offer not past expires_at, or a date request.
 * Locked. A stage move that would withdraw one is the owner account's call, like POST .../withdraw.
 */
// An offer the applicant holds: a date request (held past the expiry, since the owner answers it), or a sent offer
// that has not expired.
const HELD_STATUSES = ['sent', 'date_requested'];
const isHeldOffer = (o, now) => HELD_STATUSES.includes(o.status)
  && (o.status === 'date_requested' || !o.expires_at || new Date(o.expires_at).getTime() >= now.getTime());

async function heldOffersOf(trx, applicationId, now = new Date()) {
  const rows = await trx('job_offers').where({ application_id: applicationId })
    .whereIn('status', HELD_STATUSES).forUpdate().select('id', 'status', 'expires_at');
  return rows.filter((o) => isHeldOffer(o, now));
}

/**
 * Leaving the offer stage (back to review or interview), or closing the application (rejected, withdrawn, hired),
 * withdraws its live offers. The stage move applies this rule (admin-careers.js applyStatusTransition) and the stage
 * dialog's preview reads it, with GATE_JOB_OFFERS on or off.
 */
function stageMoveClosesOffers(fromStatus, toStatus) {
  return (fromStatus === 'offer' && toStatus !== 'offer')
    || (['rejected', 'withdrawn', 'hired'].includes(toStatus) && fromStatus !== toStatus);
}

// The live offers a stamp names: a draft, a date request, and a sent offer not past its expiry. A sent offer past its
// expiry is left out whether or not the 7-day close has stored that state (closeExpiredOffers): both pages already
// show it closed, so storing it must not change a stamp the owner read. (A stage move stores such a row's expiry,
// closeOffersWithApplication; no dialog names it, because the applicant no longer holds it.)
const liveRowsOf = (knex, applicationId) => knex('job_offers').where({ application_id: applicationId }).whereIn('status', LIVE_STATUSES);
const STAMP_COLUMNS = ['id', 'status', 'expires_at', 'updated_at'];

async function liveOffersOf(knex, applicationId, now = new Date()) {
  const rows = await liveRowsOf(knex, applicationId).select(...STAMP_COLUMNS);
  return rows.filter((o) => !expiredByClock(o, now));
}

// The same offers, locked, and the clock read once they are: for a write that judges an expiry and stores a state at
// one instant (a Send, a stage move). The applicant's page holds an offer row while it stamps a view, so a clock read
// before these locks could be older than the closed state the link already showed. fixedNow: a test's clock.
async function lockLiveOffers(trx, applicationId, fixedNow) {
  const rows = await liveRowsOf(trx, applicationId).forUpdate().select(...STAMP_COLUMNS);
  const now = fixedNow || new Date();
  return { now, offers: rows.filter((o) => !expiredByClock(o, now)) };
}

// One stamp for the offers a stage move withdraws, from their ids, statuses and versions (updated_at, which every offer
// write sets). A write that changes the status changes the stamp by its status; a write that keeps it (a draft edited
// in place, a second date request, a text-consent choice) takes nextVersion, so even two such writes in one
// millisecond give two stamps. A move that keeps the offers withdraws none: the empty list has a stamp of its own. The
// stage preview returns it and the move names the offers again under its lock, so a move never withdraws an offer, or
// a version of one, that its dialog did not show. The Send's outStamp is the same stamp of the offers out.
function offerStampOf(rows) {
  const parts = rows.map((o) => `${o.id}:${o.status}:${iso(o.updated_at)}`).sort();
  return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 32);
}

// The version (updated_at) for a write that keeps an offer's status, on a row this transaction holds locked: strictly
// later than the version it replaces, so two writes in one millisecond still get two versions (offerStampOf, and the
// applicant page's `version` in changedSince, compare it).
function nextVersion(row) {
  return new Date(Math.max(Date.now(), new Date(row.updated_at).getTime() + 1));
}

/** What such a move would withdraw, for the stage dialog's preview: a plain read (the move re-checks under its lock). */
async function liveOfferStake(knex, applicationId, now = new Date()) {
  const rows = await liveOffersOf(knex, applicationId, now);
  return { held: rows.some((o) => isHeldOffer(o, now)), draft: rows.some((o) => o.status === 'draft'), stamp: offerStampOf(rows) };
}

async function closeOffersWithApplication(trx, applicationId, actorId, now = new Date()) {
  // A sent offer already past its expiry closed on that date. The move stores that, as the 7-day close does, so the
  // applicant's link reads the same whichever of the two came first.
  await trx('job_offers').where({ application_id: applicationId, status: 'sent' }).where('expires_at', '<', now)
    .update({ status: 'expired', updated_at: new Date() });
  const withdrawn = await trx('job_offers').where({ application_id: applicationId }).whereIn('status', LIVE_STATUSES)
    .update({ status: 'withdrawn', withdrawn_at: now, withdrawn_by: actorId || null, updated_at: new Date() });
  await clearExpiredBells(trx, applicationId, 'Cleared: the application left the offer stage');
  return withdrawn;
}

/** GET /:id/offer/:offerId/signed-copy */
async function signedCopy(applicationId, offerId) {
  const offer = await loadOffer(db, applicationId, offerId);
  if (offer.status !== 'accepted' || !offer.snapshot) throw new OfferError(409, 'OFFER_NOT_SIGNED', 'This offer has not been signed.');
  const snapshot = asObject(offer.snapshot);
  const signedOn = new Date(offer.signed_at).toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York', timeZoneName: 'short',
  });
  return {
    markdown: `${renderLetterMarkdown(snapshot)}\n\n---\n\nSigned electronically by ${offer.signed_name} on ${signedOn}.`,
    signedName: offer.signed_name,
    signedAt: iso(offer.signed_at),
    signedIp: offer.signed_ip || null,
    signatureHash: offer.signature_hash,
  };
}

// -------------------------------------------------------------- send

async function assertSendable(trx, application, offer, { now, ownerName, draftHash }) {
  if (offer.status !== 'draft') {
    throw new OfferError(409, 'OFFER_NOT_DRAFT', 'This offer is not a draft.', { status: offer.status });
  }
  assertOfferable(application);
  const to = sendTargetsOf(application);
  if (!to.sms && !to.email) throw new OfferError(409, 'NO_CONTACT', 'This applicant has no phone number or email.');
  const issued = await loadIssuedTerms(trx, now);
  if (issued.blockers.length) {
    throw new OfferError(409, 'TERMS_NOT_ISSUED', 'The Technician Terms are not issued.', { blockers: issued.blockers });
  }
  const { errors } = validateOffer(inputOfRow(offer), now);
  if (errors.length) throw new OfferError(400, 'INVALID_OFFER', errors[0].message, { errors });
  // The owner presses Send on the preview he read: any change since (another admin's edit, new Terms or pay policy, a new day) refuses the send.
  const current = draftHashOf({ ...offer, report_to: ownerReportTo(ownerName) }, { terms: issued.terms, payDayLine: issued.payDayLine, ownerName, now });
  if (current !== draftHash) {
    throw new OfferError(409, 'DRAFT_CHANGED', 'This draft changed after you opened it. Review the new preview, then send.');
  }
  return issued;
}

// The id of the offer out now that a Send of `draft` replaces (its link stops working at the send, before any text or
// email), or null. supersedePrior applies it under the lock; the offer read names it, so the Send question can say so.
function replacedBySend(out, draft) {
  return out && draft && out.id === draft.supersedes_id ? out.id : null;
}

// Stores the expiry of a sent offer past its date, for the 7-day close and for a Send. The 7-day close also rings the
// owner (closeIfExpired). A Send over a lapsed offer does not ring: the owner sent the new offer on the card that
// showed the old one closed, so that Send is his answer to it and a bell would ask for it again.
const storeExpiry = (trx, offerId) => trx('job_offers').where({ id: offerId }).update({ status: 'expired', updated_at: new Date() });

async function supersedePrior(trx, applicationId, offer, now) {
  const out = await trx('job_offers').where({ application_id: applicationId }).whereIn('status', OUT_STATUSES).forUpdate().first();
  if (!out) return;
  // An offer past its expiry is expired, also when this Send is a revision of it drafted while it was open: its link
  // already reads closed, and the offer read names no offer this Send replaces (sendReplacesId).
  if (expiredByClock(out, now)) {
    await storeExpiry(trx, out.id);
    return;
  }
  if (!replacedBySend(out, offer)) {
    throw new OfferError(409, 'OFFER_ALREADY_OPEN', 'An offer is already out. Use Revise to make an updated one.', { offerId: out.id });
  }
  await trx('job_offers').where({ id: out.id }).update({ status: 'superseded', superseded_by_id: offer.id, updated_at: new Date() });
}

function sentHistoryEntry(application, actor) {
  const sameStage = application.status === 'offer';
  return {
    from: application.status,
    to: 'offer',
    note: sameStage ? 'Updated job offer sent' : 'Job offer sent',
    by: actor.id,
    at: new Date().toISOString(),
  };
}

async function commitSend(applicationId, offerId, actor, fixedNow, draftHash, expectedOut) {
  return db.transaction(async (trx) => {
    const application = await loadApplication(trx, applicationId, { lock: true });
    const offer = await loadOffer(trx, applicationId, offerId, { lock: true });
    // Every row this Send reads or writes is locked before the clock is read, as in reviseOffer. A Send that waited for
    // a lock while the offer out passed its expiry is judged at the instant it writes (the stamp, the offer it
    // replaces, the new expiry).
    const { now, offers: live } = await lockLiveOffers(trx, applicationId, fixedNow);
    const name = await actorName(trx, actor);
    const { terms, payDayLine } = await assertSendable(trx, application, offer, { now, ownerName: name, draftHash });
    // The owner sends on a read of the offers out now (the offer read's outStamp, which sendOffer requires). An answer, a
    // date request or any other write to them since that read refuses the send, before anything is replaced or sent: the
    // owner sees it first. Every offer writer locks the application row first, so this read holds until the commit.
    const outNow = live.filter((o) => OUT_STATUSES.includes(o.status));
    if (offerStampOf(outNow) !== expectedOut) {
      throw new OfferError(409, 'OFFERS_CHANGED', 'The offer you sent before changed after you opened this, so nothing was sent.');
    }
    await supersedePrior(trx, applicationId, offer, now);

    const owner = { name, reportTo: ownerReportTo(name) };
    const expiresAt = expiryFor(now);
    const token = crypto.randomBytes(32).toString('hex');
    const snapshot = buildSnapshot({ offer: { ...offer, report_to: owner.reportTo }, application, owner, terms, payDayLine, expiresAt, sentAt: now });
    const [row] = await trx('job_offers').where({ id: offer.id }).update({
      status: 'sent', token, token_created_at: now, report_to: owner.reportTo, pay_day_line: payDayLine, expires_at: expiresAt,
      terms_template_id: terms.templateId, terms_version_id: terms.versionId, terms_content_hash: terms.contentHash,
      snapshot: JSON.stringify(snapshot), snapshot_hash: snapshotHashOf(snapshot),
      sent_at: now, sent_by: actor.id, updated_at: new Date(),
    }).returning('*');
    // Same rule as the status PATCH: entering a slot-blocking stage from a non-blocking one clears the old interview
    // booking, whose slot was released to other applicants when the row left interview.
    const releasedSlot = ['interview', 'offer'].includes(application.status)
      ? {}
      : { interview_mode: null, interview_at: null, interview_end_at: null, interview_booked_at: null };
    const [updatedApplication] = await trx('job_applications').where({ id: applicationId }).update({
      ...releasedSlot,
      status: 'offer',
      status_history: JSON.stringify([...(Array.isArray(application.status_history) ? application.status_history : []), sentHistoryEntry(application, actor)]),
      updated_at: new Date(),
    }).returning('*');
    await clearExpiredBells(trx, applicationId, 'Cleared: a new offer was sent');
    return { offer: row, application: updatedApplication, ownerName: name, snapshot };
  });
}

// The text + email, after the commit. Comms never undo the send: a failure is reported per channel.
// Who Send reaches: a text to the phone on file and an email to the email on file, whatever their form. The send tries
// each one (a number or address it cannot use still gets the attempt, and the outcome says it did not go out). The offer
// read returns the same list, masked ('***' when a mask cannot be made), so the Send question names every channel the
// send tries.
function sendTargetsOf(application) {
  const RecruitingComms = require('./recruiting-comms');
  const contact = RecruitingComms.contactOf(application);
  return {
    sms: contact.phone ? RecruitingComms.maskPhone(contact.phone) : null,
    email: contact.email ? RecruitingComms.maskEmail(contact.email) : null,
  };
}
async function deliverOfferComms({ offer, application, ownerName, snapshot }, actor) {
  const RecruitingComms = require('./recruiting-comms');
  const to = sendTargetsOf(application);
  const stillEligible = async (conn = db) => {
    const row = await conn('job_offers').where({ id: offer.id }).first('status', 'token');
    const app = await conn('job_applications').where({ id: application.id }).first('status');
    return Boolean(row && row.status === 'sent' && row.token === offer.token && app && app.status === 'offer');
  };
  try {
    const comms = await RecruitingComms.sendStageComms(application, 'offer_sent', {
      sms: Boolean(to.sms),
      email: Boolean(to.email),
      by: actor.id,
      stillEligible,
      offerId: offer.id,
      offerToken: offer.token,
      vars: {
        offer_link: portalUrl(`/careers/offer/${offer.token}`),
        expires_on: fmtDay(instantToEtDay(offer.expires_at)),
        job_title: snapshot.jobTitle,
        sender_name: ownerName,
      },
    });
    return outcomesOf(comms);
  } catch (err) {
    logger.error(`[job-offers] offer comms failed after the committed send (offer ${offer.id}): ${errTag(err)}`);
    // The send threw partway, so a channel it tried may already have gone out (the text leg runs before the email
    // leg): its outcome is not known. 'uncertain', never 'failed', so the page does not ask for a Revise that would
    // stop a link the applicant may already have. A channel with nothing on file was not tried.
    const unknown = (target) => (target ? { outcome: 'uncertain', code: 'comms_threw' } : { outcome: 'not_requested', code: null });
    return { sms: unknown(to.sms), email: unknown(to.email) };
  }
}

const outcomesOf = (comms) => ({
  sms: { outcome: comms.sms, code: null },
  email: { outcome: comms.email, code: null },
});

/** POST /:id/offer/:offerId/send */
// expectedOut: the offer read's outStamp, which the page always sends; null skips the check.
// fixedNow: a test's clock. The route passes none, so the clock is read under the locks (commitSend).
async function sendOffer(applicationId, offerId, actor, draftHash, fixedNow, { expectedOut } = {}) {
  if (typeof draftHash !== 'string' || !draftHash) {
    throw new OfferError(400, 'DRAFT_HASH_REQUIRED', 'Send needs the hash of the preview you reviewed.');
  }
  // And the offers out the owner reviewed (the read's outStamp): without it, a Send could replace an answer or a date
  // request the owner never saw.
  if (typeof expectedOut !== 'string' || !expectedOut) {
    throw new OfferError(400, 'OUT_STAMP_REQUIRED', 'Send needs the offers out you reviewed. Open the offer again, then send.');
  }
  const committed = await commitSend(applicationId, offerId, actor, fixedNow, draftHash, expectedOut);
  const comms = await deliverOfferComms(committed, actor);
  const fresh = await db('job_offers').where({ id: committed.offer.id }).first();
  return { offer: presentOffer(fresh || committed.offer, { sentByName: committed.ownerName, includeUrl: true }), comms };
}

// ----------------------------------------------------------- public side

async function loadByToken(conn, token, { lock = false } = {}) {
  if (!TOKEN_RE.test(String(token || ''))) return null;
  let query = conn('job_offers as o')
    .join('job_applications as a', 'a.id', 'o.application_id')
    .where('o.token', token)
    .select('o.*', 'a.status as application_status');
  if (lock) query = query.forUpdate('o');
  return (await query.first()) || null;
}

const closedPayload = (state, offer, snapshot) => ({
  state, message: closedMessage(state, snapshot, offer), contactPhone: WAVES_SUPPORT_PHONE_DISPLAY,
});

function openPayload(offer, state) {
  const snapshot = asObject(offer.snapshot);
  return {
    state,
    firstName: snapshot.firstName,
    jobTitle: snapshot.jobTitle,
    startDate: snapshot.startDate,
    hourlyRate: snapshot.hourlyRate,
    stepRate: snapshot.stepRate,
    stepEffectiveOn: snapshot.stepEffectiveOn,
    hoursLine: snapshot.hoursLine,
    reportTo: snapshot.reportTo,
    payDayLine: snapshot.payDayLine,
    owner: snapshot.owner,
    expiresAt: snapshot.expiresAt,
    textConsent: Boolean(offer.text_consent_at),
    version: iso(offer.updated_at),
    signedName: offer.signed_name || null,
    signedAt: iso(offer.signed_at),
    requestedStartDate: offer.requested_start_date ? ymdOf(offer.requested_start_date) : null,
    terms: { title: snapshot.terms.title, markdown: snapshot.terms.markdown },
  };
}

function payloadFor(offer, now) {
  const state = publicStateOf(offer, { now, applicationStatus: offer.application_status });
  if (!state) return null;
  if (['superseded', 'withdrawn', 'expired'].includes(state)) return closedPayload(state, offer, asObject(offer.snapshot));
  return openPayload(offer, state);
}

/** GET /:token — null for an unknown token. Stamps opened_at (first view) and last_viewed_at. */
async function publicView(token, now = new Date()) {
  const offer = await loadByToken(db, token);
  if (!offer) return null;
  const payload = payloadFor(offer, now);
  if (!payload) return null;
  try {
    await db('job_offers').where({ id: offer.id }).update({
      opened_at: db.raw('COALESCE(opened_at, ?)', [now]), last_viewed_at: now,
    });
  } catch (err) {
    logger.warn(`[job-offers] view stamp failed (offer ${offer.id}): ${errTag(err)}`);
  }
  return payload;
}

// Locks the application, then the offer found by token; returns the rows, the state under the lock and the clock.
async function lockByToken(trx, token) {
  const peek = await loadByToken(trx, token);
  if (!peek) return null;
  await trx('job_applications').where({ id: peek.application_id }).forUpdate().first('id');
  const offer = await loadByToken(trx, token, { lock: true });
  // The clock is read AFTER both locks: a request that waited on a lock across the expiry must not sign with an
  // earlier instant.
  const now = new Date();
  const state = offer ? publicStateOf(offer, { now, applicationStatus: offer.application_status }) : null;
  return offer && state ? { offer, state, now } : null;
}

// Every write the applicant makes is made on what the page shows: `version` is the offer's version from the read or
// save the page last applied, the text-consent choice included. A change since then (another tab's consent save, a
// save that landed late) refuses the write with the state still open (409), so the page reads the offer again and the
// applicant answers on what it now shows. A signature, a date request or a decline therefore never fixes a consent
// choice the applicant did not see. The page always sends it, and a write without one is refused the same way, so no
// write skips the check (a text choice equal to the stored one and an identical replay of a signature write nothing,
// so they answer as for any resend). The page posts under /v2, which no server from before the version has.
const changedSince = (offer, version) => version !== iso(offer.updated_at);
const CHANGED = Object.freeze({ refused: true, body: Object.freeze({ state: 'open' }) });

const refusal = (state, offer) => ({
  refused: true,
  body: state === 'superseded' || state === 'withdrawn' || state === 'expired'
    ? closedPayload(state, offer, asObject(offer.snapshot))
    : { state },
});

/**
 * POST /:token/v2/text-consent. `version` is the offer's version from the read the choice was made on. A save can land
 * late (its reply was lost and the page saved the same choice again), so a change made from an older version is
 * refused: it cannot undo a later choice. A choice that is already stored writes nothing.
 */
async function setTextConsent(token, consent, version) {
  return db.transaction(async (trx) => {
    const found = await lockByToken(trx, token);
    if (!found) return { notFound: true };
    if (found.state !== 'open') return refusal(found.state, found.offer);
    if (typeof consent !== 'boolean') return { invalid: 'Choose yes or no.' };
    const current = iso(found.offer.updated_at);
    if (Boolean(found.offer.text_consent_at) === consent) return { body: { textConsent: consent, version: current } };
    if (changedSince(found.offer, version)) return CHANGED;
    const updatedAt = nextVersion(found.offer);
    await trx('job_offers').where({ id: found.offer.id }).update({ text_consent_at: consent ? found.now : null, updated_at: updatedAt });
    return { body: { textConsent: consent, version: iso(updatedAt) } };
  });
}

// Typed full name: trimmed, 3 to 120 characters, at least two words.
function parseSignedName(value) {
  if (typeof value !== 'string') return null;
  const name = cleanText(value);
  if (name.length < 3 || name.length > LIMITS.nameChars) return null;
  return /^\S+(\s+\S+)+$/.test(name) ? name : null;
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/** POST /:token/v2/accept. `version`: see changedSince. */
// The terms a signature binds, as the page shows them, by the page's own rule (offerFormat.hasOfferFacts and
// exactAmount, which this mirrors): the job, a real start date, an hourly rate as a number of whole cents (at least one
// cent), the week, who they report to, pay day and the Terms, and a pay step only with both its rate and its date (no
// raise: both null). buildSnapshot freezes a checked draft with numeric rates, so a gap here is a bug; the check holds
// for every client, a tab from before the page's own check included.
const textFact = (value) => typeof value === 'string' && value.trim() !== '';
const centsFact = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0.01
  && /^\d+\.\d{2}$/.test(value.toFixed(2)) && Number(value.toFixed(2)) === value;

function signableSnapshot(snapshot) {
  const s = snapshot || {};
  const noStep = s.stepRate === null && s.stepEffectiveOn === null;
  return textFact(s.jobTitle) && textFact(s.hoursLine) && textFact(s.reportTo) && textFact(s.payDayLine)
    && isYmd(s.startDate) && centsFact(s.hourlyRate)
    && (noStep || (centsFact(s.stepRate) && isYmd(s.stepEffectiveOn)))
    && Boolean(s.terms) && textFact(s.terms.markdown);
}

async function acceptOffer(token, { signedName, version, ip, userAgent }) {
  const name = parseSignedName(signedName);
  const result = await db.transaction(async (trx) => {
    const found = await lockByToken(trx, token);
    if (!found) return { notFound: true };
    const { offer, state } = found;
    // An identical replay of a signature is answered with the stored one, never a second signature. `replay`: this
    // request signed nothing (another tab, or an earlier send whose reply was lost, signed first), so the page names
    // the signer instead of saying "You signed".
    if (state === 'signed' && name && sameName(name, offer.signed_name)) {
      return { body: { state: 'signed', signedAt: iso(offer.signed_at), signedName: offer.signed_name, replay: true } };
    }
    if (state !== 'open') return refusal(state, offer);
    if (!name) return { invalid: 'Type your full name to sign.' };
    if (changedSince(offer, version)) return CHANGED;
    // A frozen offer missing a term it shows is never signed: the same 409 with no write, and the page's read of it
    // shows the load error.
    if (!signableSnapshot(asObject(offer.snapshot))) {
      logger.warn(`[job-offers] signature refused: offer ${offer.id} lacks a term the page shows`);
      return CHANGED;
    }
    return { body: await signOffer(trx, offer, { name, ip, userAgent, now: found.now }), forBell: offer };
  });
  if (result.forBell) {
    await bell('signed', result.forBell, null);
    await staffRecordAfterSigning(result.forBell.id);
  }
  return result;
}

async function signOffer(trx, offer, { name, ip, userAgent, now }) {
  const signatureHash = signatureHashOf({
    snapshotHash: offer.snapshot_hash, termsContentHash: offer.terms_content_hash, signedName: name, signedAt: now,
  });
  await trx('job_offers').where({ id: offer.id }).update({
    status: 'accepted', signed_at: now, signed_name: name,
    signed_ip: ip ? String(ip).slice(0, 64) : null, signed_user_agent: userAgent ? String(userAgent).slice(0, 300) : null,
    signature_hash: signatureHash, updated_at: new Date(),
  });
  await moveApplication(trx, offer.application_id, {
    to: 'hired', note: 'Signed the job offer', extra: {},
  });
  // A revision the owner was drafting meanwhile is moot: it must not be sendable if the application is reopened.
  await closeOffersWithApplication(trx, offer.application_id, null, now);
  return { state: 'signed', signedAt: now.toISOString() };
}

async function moveApplication(trx, applicationId, { to, note, extra }) {
  const application = await trx('job_applications').where({ id: applicationId }).first('status', 'status_history');
  const history = Array.isArray(application.status_history) ? application.status_history : [];
  const entry = { from: application.status, to, note, by: 'applicant', at: new Date().toISOString(), ...extra };
  await trx('job_applications').where({ id: applicationId }).update({
    status: to, status_history: JSON.stringify([...history, entry]), updated_at: new Date(),
  });
}

/** POST /:token/v2/date-request. `version`: see changedSince. */
async function requestDate(token, { requestedStartDate, note, version }) {
  const result = await db.transaction(async (trx) => {
    const found = await lockByToken(trx, token);
    if (!found) return { notFound: true };
    if (found.state !== 'open') return refusal(found.state, found.offer);
    const errors = [];
    checkStartDate(errors, requestedStartDate, found.now);
    if (errors.length) return { invalid: errors[0].message.replace('start date', 'date') };
    if (note !== undefined && note !== null && (typeof note !== 'string' || cleanText(note).length > LIMITS.noteChars)) {
      return { invalid: `The note must be ${LIMITS.noteChars} characters or fewer.` };
    }
    if (changedSince(found.offer, version)) return CHANGED;
    const cleanNote = note ? cleanText(note) : null;
    await trx('job_offers').where({ id: found.offer.id }).update({
      status: 'date_requested', date_requested_at: found.now, requested_start_date: requestedStartDate,
      date_request_note: cleanNote || null, updated_at: nextVersion(found.offer),
    });
    return { body: { state: 'date_requested' }, forBell: found.offer };
  });
  if (result.forBell) await bell('date_requested', result.forBell, fmtDay(requestedStartDate));
  return result;
}

/** POST /:token/v2/decline. `version`: see changedSince. */
async function declineOffer(token, { reason, version }) {
  const result = await db.transaction(async (trx) => {
    const found = await lockByToken(trx, token);
    if (!found) return { notFound: true };
    if (found.state !== 'open') return refusal(found.state, found.offer);
    if (reason !== undefined && reason !== null && (typeof reason !== 'string' || cleanText(reason).length > LIMITS.noteChars)) {
      return { invalid: `The reason must be ${LIMITS.noteChars} characters or fewer.` };
    }
    if (changedSince(found.offer, version)) return CHANGED;
    await trx('job_offers').where({ id: found.offer.id }).update({
      status: 'declined', declined_at: found.now, decline_reason: reason ? cleanText(reason) : null, updated_at: new Date(),
    });
    await moveApplication(trx, found.offer.application_id, { to: 'withdrawn', note: 'Declined the job offer', extra: { reason: 'offer_declined' } });
    await closeOffersWithApplication(trx, found.offer.application_id, null, found.now);
    return { body: { state: 'declined' }, forBell: found.offer };
  });
  if (result.forBell) await bell('declined', result.forBell, null);
  return result;
}

// ------------------------------------------------------------ 7-day close

// Stores the expiry of one sent offer and writes its bell in the same transaction, so the two commit together: a close
// whose bell was not written is rolled back, the row stays sent, and the next pass does both again. False when there
// is nothing to close: the applicant answered, the owner withdrew or replaced the offer, or the application left Offer
// since the pass listed it. Both rows are read SKIP LOCKED: a row another transaction holds is left for the next pass,
// so one slow write cannot hold back the offers after it (the whole pass runs under one job lock).
async function closeIfExpired(applicationId, offerId) {
  return db.transaction(async (trx) => {
    const application = await trx('job_applications').where({ id: applicationId }).forUpdate().skipLocked().first('status');
    const offer = application && await trx('job_offers').where({ id: offerId }).forUpdate().skipLocked().first();
    // The clock is read after both locks, as for the applicant's own writes (lockByToken).
    if (!application || application.status !== 'offer' || !offer || !expiredByClock(offer, new Date())) return false;
    await storeExpiry(trx, offerId);
    const written = await raiseBell('expired', offer, fmtDay(instantToEtDay(offer.expires_at)), trx);
    if (!written) throw new Error('the closed-unsigned bell was not written');
    return true;
  });
}

/**
 * The 7-day close. Each sent offer past its expiry, on an application still at Offer, is stored as 'expired' and rings
 * one bell for the owner. Both pages already read such a row as expired by the clock (expiredByClock); this stores it,
 * so the row stops being an offer out. A date request does not expire: the owner answers it. The sweep is a catch-up
 * (every pass tries each offer that is due, so a missed pass loses nothing) and sends the applicant nothing.
 *
 * The list has no page size: an application has at most one sent offer (the partial unique index), so it is never
 * longer than the applications at Offer, and an offer that keeps failing cannot hold back the ones after it.
 */
async function closeExpiredOffers() {
  const due = await db('job_offers as o').join('job_applications as a', 'a.id', 'o.application_id')
    .where('o.status', 'sent').where('a.status', 'offer').where('o.expires_at', '<', new Date())
    .orderBy('o.expires_at').select('o.id', 'o.application_id');
  const result = { closed: 0, failed: 0 };
  for (const row of due) {
    try {
      if (await closeIfExpired(row.application_id, row.id)) result.closed += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`[job-offers] close failed (offer ${row.id}): ${errTag(err)}`);
    }
  }
  return result;
}

// ----------------------------------------------------------- 2-day reminder

const REMINDER_AFTER_MS = 2 * 24 * 60 * 60 * 1000;
// The reminder goes out in the working day (Eastern). It is a courtesy to the applicant, not a legal window: the text
// rail keeps its own 8 AM to 8 PM, and the email has none. The pass takes an offer from 9:00 AM until 5:55 PM, and a
// channel's handoff starts only before 6:00 PM (the check before each provider reads the clock); the five minutes
// are for the provider calls of the last offer taken. A handoff that passed its check finishes: the sender takes
// its own locks after that check, and no clock read can sit on the provider request itself.
const REMINDER_DAY_ET = Object.freeze({ from: 9 * 60, lastClaim: 17 * 60 + 55, until: 18 * 60 });
const minuteOfDayEt = (now) => {
  const { hour, minute } = etParts(now);
  return hour * 60 + minute;
};
const mayClaimAt = (now) => minuteOfDayEt(now) >= REMINDER_DAY_ET.from && minuteOfDayEt(now) < REMINDER_DAY_ET.lastClaim;
const maySendAt = (now) => minuteOfDayEt(now) >= REMINDER_DAY_ET.from && minuteOfDayEt(now) < REMINDER_DAY_ET.until;
// The reminder's gates (GATE_JOB_OFFER_REMINDER and GATE_JOB_OFFERS), as the sender reads them for the stage. The
// scheduler reads them before its lock. The pass reads them again before it takes an offer: a claim made with a
// gate off would use up the offer's one attempt on a send that the sender refuses.
const reminderOn = () => require('./recruiting-comms').stageEnabled('offer_reminder');
// A channel that did not go cleanly for a reason on our side: it failed, or its result is not known (the applicant
// may hold the message, and nobody can say so).
const NOT_CLEAN = ['failed', 'uncertain'];

// The applicant's yes to a text about this offer: the "Text me about this offer" box on the offer page. It starts
// empty and the applicant can clear it again. The page shows that box, so it alone decides: the application's own
// text consent (sms_consent) is about the application, and it does not stand in for a box the applicant sees empty
// or has cleared. The reminder is the one message of the flow that no person presses, so its text needs this yes
// when the pass takes the offer and again when the text goes to the provider.
const agreedToTexts = (offer) => Boolean(offer.text_consent_at);

// What the reminder may use for one applicant: a text with the applicant's yes, an email when one is on file.
function reminderChannels(application, offer) {
  const contact = contactOf(application);
  return { sms: Boolean(contact.phone) && agreedToTexts(offer), email: Boolean(contact.email) };
}

// An offer sent two days ago or more, still open, on an application still at Offer, that has had no reminder. A
// reminder that went out (reminder_sent_at) counts by itself, also on a row that holds no claim.
const reminderDue = (application, offer, now) => application.status === 'offer' && offer.status === 'sent'
  && !expiredByClock(offer, now) && !offer.reminder_claimed_at && !offer.reminder_sent_at && Boolean(offer.sent_at)
  && now.getTime() - new Date(offer.sent_at).getTime() >= REMINDER_AFTER_MS;

// Takes one offer for its reminder. Null when it is not due any more, it is past 5:55 PM, it has no channel to
// use, or a row is held by another transaction (SKIP LOCKED: the next pass takes it). The claim (reminder_claimed_at)
// commits before anything is sent, so an offer is tried once: a send that fails, or a process that stops after it,
// never leads to a second reminder. An offer with no channel is not claimed: it gets its reminder if the applicant
// agrees to texts later. The claim does not move updated_at: a reminder changes nothing the applicant or the owner
// acts on, so no page they have open goes stale.
async function claimReminder(applicationId, offerId, clock) {
  return db.transaction(async (trx) => {
    const application = await trx('job_applications').where({ id: applicationId }).forUpdate().skipLocked().first();
    const offer = application && await trx('job_offers').where({ id: offerId }).forUpdate().skipLocked().first();
    // The clock is read after both locks, as for every offer write. Each offer has its own read, so a long pass
    // stops taking offers at 5:55 PM.
    const now = clock();
    if (!offer || !mayClaimAt(now) || !reminderDue(application, offer, now)) return null;
    const channels = reminderChannels(application, offer);
    if (!channels.sms && !channels.email) return null;
    await trx('job_offers').where({ id: offerId }).update({ reminder_claimed_at: now });
    return { application, offer, channels };
  });
}

// Sends the reminder of a claimed offer through the recruiting sender (the stage 'offer_reminder'): the same link and
// the same link rules as the offer text and email. The sender reads stillEligible again before each provider, for the
// text inside its locked handoff (the application row is held, and every offer write takes that row first): the offer
// must still be the open one with this link, it must be before 6:00 PM, and the text needs the applicant's yes to
// texts at that moment. The sender never queues a reminder text for later (recruiting-comms TRIED_ONCE_STAGES).
// Returns the sender's outcome for each channel, and checkFailed: a read of that check threw. The sender stops that
// channel (it reports 'stale'), and the offer is not tried again, so the pass counts it as a failure.
async function deliverReminder({ application, offer, channels }, clock) {
  const snapshot = asObject(offer.snapshot);
  let checkFailed = false;
  const stillEligible = async (conn = db, channel) => {
    try {
      const row = await conn('job_offers').where({ id: offer.id }).first('status', 'token', 'expires_at', 'text_consent_at');
      const app = await conn('job_applications').where({ id: application.id }).first('status');
      const now = clock();
      const open = Boolean(row && row.status === 'sent' && row.token === offer.token && !expiredByClock(row, now) && app && app.status === 'offer');
      return open && maySendAt(now) && (channel !== 'sms' || agreedToTexts(row));
    } catch (err) {
      checkFailed = true;
      logger.error(`[job-offers] reminder check failed before the ${channel || 'send'} (offer ${offer.id}): ${errTag(err)}`);
      return false;
    }
  };
  const comms = await require('./recruiting-comms').sendStageComms(application, 'offer_reminder', {
    sms: channels.sms,
    email: channels.email,
    by: 'system',
    stillEligible,
    vars: {
      offer_link: portalUrl(`/careers/offer/${offer.token}`),
      expires_on: fmtDay(instantToEtDay(offer.expires_at)),
      job_title: snapshot.jobTitle || offer.job_title,
      sender_name: String((snapshot.owner && snapshot.owner.name) || '').trim() || ownerFirstName(snapshot),
    },
  });
  return { sms: comms.sms, email: comms.email, checkFailed };
}

/**
 * The 2-day reminder: the one message of the offer flow that no person presses (GATE_JOB_OFFER_REMINDER, read by the
 * scheduler with GATE_JOB_OFFERS). Each sent offer that is two days old or more and still open, on an application
 * still at Offer, gets one reminder: an email, and a text when the applicant ticked "Text me about this offer". A date request gets
 * none: the owner answers it. A catch-up pass (each run takes every offer that is due); it takes an offer only from
 * 9:00 AM to 5:55 PM Eastern, and no channel's handoff starts after 6:00 PM.
 *
 * Returns { reminded, notSent, failed }. reminded: a provider took the text or the email (reminder_sent_at is set;
 * the offer timeline reads it as "Reminder sent", so a result that is not known does not set it). notSent: nothing went out, for a known reason (the offer closed first, the address is
 * suppressed, the applicant opted out, it was 6 PM). failed: a channel failed or its result is not known, a check
 * before a provider could not be read, or the pass threw; the scheduler fails the job. The sender reads the reminder
 * text fail-loud (recruiting-comms triedOnceTextOutcome): a text that did not go is 'failed' unless the rail refused
 * it because of the applicant.
 * One offer can count as reminded and as failed (the email went, and the text failed or its result is not known).
 * With either gate off the pass takes nothing, also on a direct call.
 * clock: the time source, for tests. The scheduler passes none.
 */
async function sendDueReminders(clock = () => new Date()) {
  const now = clock();
  const result = { reminded: 0, notSent: 0, failed: 0 };
  if (!reminderOn() || !mayClaimAt(now)) return result;
  const due = await db('job_offers as o').join('job_applications as a', 'a.id', 'o.application_id')
    .where('o.status', 'sent').where('a.status', 'offer').whereNull('o.reminder_claimed_at').whereNull('o.reminder_sent_at')
    .where('o.sent_at', '<=', new Date(now.getTime() - REMINDER_AFTER_MS)).where('o.expires_at', '>=', now)
    .orderBy('o.sent_at').select('o.id', 'o.application_id');
  for (const row of due) {
    try {
      const claimed = await claimReminder(row.application_id, row.id, clock);
      if (claimed) await remindClaimed(claimed, result, clock);
    } catch (err) {
      // A claimed offer is not tried again: a channel may already have gone out. The application's message history
      // has what each channel did.
      result.failed += 1;
      logger.error(`[job-offers] reminder failed (offer ${row.id}): ${errTag(err)}`);
    }
  }
  return result;
}

// Sends one claimed offer's reminder and counts it. A channel the sender reports as failed or as not known, or a
// check before a provider that could not be read, fails the pass, also when the other channel went out: the offer is
// not tried again, so the job's health is the only place the failure shows.
// reminder_sent_at is written after the send, and only when a provider took a channel: the timeline must not say
// "Reminder sent" for a result nobody knows (the claim alone keeps the offer from a second attempt). When that write
// fails the reminder still went, so it counts as reminded and as a failure.
async function remindClaimed(claimed, result, clock) {
  const { id } = claimed.offer;
  const comms = await deliverReminder(claimed, clock);
  const went = comms.sms === 'sent' || comms.email === 'sent';
  const channelFailed = NOT_CLEAN.includes(comms.sms) || NOT_CLEAN.includes(comms.email) || comms.checkFailed;
  if (channelFailed) {
    result.failed += 1;
    logger.error(`[job-offers] reminder channel failed (offer ${id}): text ${comms.sms}, email ${comms.email}${comms.checkFailed ? ', a check could not be read' : ''}`);
  } else if (!went) {
    result.notSent += 1;
    logger.warn(`[job-offers] reminder not sent (offer ${id}): text ${comms.sms}, email ${comms.email}`);
  }
  if (!went) return;
  result.reminded += 1;
  try {
    await db('job_offers').where({ id }).update({ reminder_sent_at: new Date() });
  } catch (err) {
    if (!channelFailed) result.failed += 1;
    logger.error(`[job-offers] reminder went out but its time was not stored (offer ${id}): ${errTag(err)}`);
  }
}

// ------------------------------------------------- the staff record at signing

// What the staff record step stores on the offer (job_offers.checklist.staff_record). It is there = the step ran for
// this offer, and it never runs a second time.
//   { at, made: true, pay_step: 'made' | 'refused' | 'none' }   the prospective staff row exists (technician_id)
//   { at, made: false, reason: 'email_in_use' }                 no row: the owner adds the hire on the Team tab
//   { at, made: false, reason: 'earlier_record' }               an earlier signed offer of this application made the
//                                                               row: the owner sets it to this offer's terms
//   { at, made: false, reason: 'newer_offer' }                  a newer signature is the hire's contract: nothing to do
const STAFF_RECORD_KEY = 'staff_record';
// The longest this step waits for a lock (the staff table, the payroll lock). Past it the step fails with nothing
// written, and the 15-minute pass tries the offer again.
const STAFF_LOCK_WAIT_MS = 3000;
// technicians.name and technicians.phone hold this many characters.
const STAFF_NAME_CHARS = 100;
const STAFF_PHONE_CHARS = 20;

// The timeline row of the step, or null for a signature a newer one replaced (the newer offer shows the record).
function staffRecordLabel(staff) {
  if (staff.reason === 'newer_offer') return null;
  if (staff.reason === 'earlier_record') return 'Staff record kept from an earlier offer: set its first day and pay by hand';
  if (!staff.made) return 'Staff record not made: the email is already a staff login';
  if (staff.pay_step === 'refused') return 'Staff record made, without the pay step';
  return staff.pay_step === 'made' ? 'Staff record made, with the pay step' : 'Staff record made';
}

const staffRecordDue = (application, offer) => application.status === 'hired' && offer.status === 'accepted'
  && !offer.technician_id && !asObject(offer.checklist)[STAFF_RECORD_KEY];

// The signed offers of one application, newest signature first. Read under the application row's lock: a signature
// takes that lock, so the set cannot change.
const signedOffersOf = (trx, applicationId) => trx('job_offers').where({ application_id: applicationId, status: 'accepted' })
  .orderBy([{ column: 'signed_at', order: 'desc' }, { column: 'id', order: 'desc' }])
  .select('id', 'application_id', 'technician_id', 'start_date', 'signed_at', 'checklist');

// The pay step of the offer, by the payroll rules (payroll-rate-steps.js createStep, in a savepoint of `trx`), in the
// name of the owner who sent the offer. A step those rules refuse is 'refused'; any other error is the caller's.
async function addOfferPayStep(trx, technicianId, offer) {
  const { createStep } = require('./payroll-rate-steps');
  const { PayrollError } = require('./payroll-w4');
  try {
    await createStep(technicianId, {
      effectiveOn: ymdOf(offer.step_effective_on), hourlyRate: String(offer.step_rate), note: 'From the signed job offer.',
    }, offer.sent_by, trx);
    return 'made';
  } catch (err) {
    if (!(err instanceof PayrollError)) throw err;
    logger.warn(`[job-offers] pay step refused by the payroll rules (offer ${offer.id}, status ${err.status})`);
    return 'refused';
  }
}

/**
 * A signed offer gets the hire's staff record: a PROSPECTIVE staff row (first day, pay rate, job title, W-2) and, when
 * the offer has one, the pay rate step. A prospective row signs in nowhere, takes no visit and is on no customer
 * surface (technician-eligibility.js); the Team tab makes it active. Nothing here sends a message to anyone.
 *
 * One transaction, after the signature's own commit, so it never undoes a signature. Its first statement limits
 * every lock wait in it to 3 seconds. Locks, in this order: the application row, the offer row, the payroll lock (only
 * for an offer with a step, and BEFORE the staff table lock: a pay run holds the payroll lock while it writes a staff
 * row), then the staff table lock every staff identity writer takes. checklist.staff_record is written in the same
 * transaction as what the step made, so a second call does nothing, and an error leaves no mark: the 15-minute pass
 * (makeDueStaffRecords) tries that offer again.
 *
 * Only the NEWEST signature of an application is the hire's contract. An application the owner reopened can hold two
 * signed offers: the older one makes nothing (marked, no bell), whatever order the pass reads them in. And when an
 * earlier signed offer already made the staff row, the newer one changes nothing on it: a bell asks the owner to set
 * that row's first day, pay and pay step to the new offer. The portal never rewrites a staff row's pay by itself.
 *
 * No row is made when the application's email is already a staff login's (the staff email or the linked Google
 * address of another staff row, of any status, or an owner login address): a bell asks the owner to add the hire by hand. A pay step the payroll rules refuse leaves the
 * row made, with a bell. Both bells are written in this transaction.
 *
 * Returns 'made' | 'refused' (a bell rang) | null (nothing to do: not signed, the application is no longer Hired, the
 * step already ran, a newer signature replaced this one, or another call holds the rows).
 */
async function makeStaffRecord(offerId) {
  return db.transaction(async (trx) => {
    await trx.raw("SELECT set_config('lock_timeout', ?, true)", [String(STAFF_LOCK_WAIT_MS)]);
    const found = await trx('job_offers').where({ id: offerId }).first('application_id');
    const application = found && await trx('job_applications').where({ id: found.application_id }).forUpdate().skipLocked().first();
    const offer = application && await trx('job_offers').where({ id: offerId }).forUpdate().skipLocked().first();
    if (!offer || !staffRecordDue(application, offer)) return null;

    const at = new Date().toISOString();
    const store = (staff, more = {}) => trx('job_offers').where({ id: offer.id }).update({
      ...more, checklist: JSON.stringify({ ...asObject(offer.checklist), [STAFF_RECORD_KEY]: { at, ...staff } }),
    });
    // The application's signed offers, newest first (the application row is locked, so the set cannot change).
    const signed = await signedOffersOf(trx, application.id);
    if (signed[0].id !== offer.id) {
      await store({ made: false, reason: 'newer_offer' });
      return null;
    }
    if (signed.some((row) => row.technician_id)) {
      await store({ made: false, reason: 'earlier_record' });
      await raiseBell('staff_terms', offer, null, trx);
      return 'refused';
    }

    const { canonicalStaffEmail, findStaffByLoginEmail, lockStaffIdentityWrites } = require('../utils/staff-identity');
    const hasStep = offer.step_rate != null && Boolean(offer.step_effective_on);
    if (hasStep) await require('./payroll-lock').lockPayrollMutations(trx);
    await lockStaffIdentityWrites(trx);
    const contact = contactOf(application);
    const email = canonicalStaffEmail(contact.email);
    const emailTaken = Boolean(email) && (require('./intelligence-bar/ib-access').isFullAccessEmail(email)
      || Boolean(await findStaffByLoginEmail(trx, email)));
    if (emailTaken) {
      await store({ made: false, reason: 'email_in_use' });
      await raiseBell('staff_record', offer, null, trx);
      return 'refused';
    }

    const phone = String(contact.phone || '').trim();
    const [tech] = await trx('technicians').insert({
      name: String(contact.name || offer.signed_name || '').trim().slice(0, STAFF_NAME_CHARS),
      // A phone too long for the column is left for the owner to type; an email that is not a valid address also is.
      phone: phone && phone.length <= STAFF_PHONE_CHARS ? phone : null,
      email,
      ...require('./technician-eligibility').employmentPatch('prospective'),
      field_dispatchable: false,
      hire_date: ymdOf(offer.start_date),
      pay_rate: offer.hourly_rate,
      job_title: offer.job_title,
      employment_type: 'w2',
    }).returning('id');
    // Every hire starts able to take every service, pending review (as a row added on the Team tab does).
    await require('./technician-capabilities').seedNewHireCapabilities(trx, tech.id);
    // Ids only: no name, email, phone or pay in the audit row.
    await require('./audit-log').recordAuditEvent({
      trx, critical: true, actor_type: 'system', actor_id: null,
      action: 'staff.prospective_from_offer', resource_type: 'technician', resource_id: tech.id,
      metadata: { technician_id: tech.id, job_offer_id: offer.id },
    });
    const payStep = hasStep ? await addOfferPayStep(trx, tech.id, offer) : 'none';
    await store({ made: true, pay_step: payStep }, { technician_id: tech.id });
    if (payStep === 'refused') await raiseBell('pay_step', offer, null, trx);
    return 'made';
  });
}

/** Right after a signature: one try. An error is logged and left to the 15-minute pass; the applicant never sees it. */
async function staffRecordAfterSigning(offerId) {
  try {
    await makeStaffRecord(offerId);
  } catch (err) {
    logger.error(`[job-offers] staff record not made at signing (offer ${offerId}), the next pass tries again: ${errTag(err)}`);
  }
}

/**
 * The catch-up pass (scheduler.js, every 15 minutes): every signed offer of a Hired application whose staff record
 * step has not run. It covers a signature whose own try failed or never ran (a restart between the two commits).
 * Returns { made, refused, failed }; the caller fails the job when failed > 0.
 */
async function makeDueStaffRecords() {
  const result = { made: 0, refused: 0, failed: 0 };
  const due = await db('job_offers as o').join('job_applications as a', 'a.id', 'o.application_id')
    .where('o.status', 'accepted').where('a.status', 'hired').whereNull('o.technician_id')
    .whereRaw(`o.checklist -> '${STAFF_RECORD_KEY}' IS NULL`)
    .orderBy('o.signed_at').pluck('o.id');
  for (const id of due) {
    try {
      const outcome = await makeStaffRecord(id);
      if (outcome) result[outcome] += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`[job-offers] staff record not made (offer ${id}): ${errTag(err)}`);
    }
  }
  return result;
}

// ------------------------------------------------ the first-days checklist

// What the owner does by hand after a signature (owner plan 2026-11-19, "build"): three items before the first day,
// and Form I-9 within 3 business days of it. A mark is job_offers.checklist[<key>] = { at, by, by_name }, kept on the
// hire's contract: the newest signed offer of the application. An item is done when ANY signed offer of the
// application holds its mark, so a second signature of a reopened application keeps what was done; a write moves the
// marks to the newest signed offer.
// job_offers.checklist.first_days_bell: the Eastern day the morning pass last handled the offer, or 'closed' (the
// pass closed the bell of an application that is no longer Hired).
const FIRST_DAYS_ITEMS = [
  { key: 'driving_record', label: 'Driving record copy', inBell: 'the driving record copy' },
  { key: 'license', label: "Driver's license check", inBell: "the driver's license check" },
  { key: 'workers_comp', label: "Workers' comp in force", inBell: "workers' comp in force" },
  { key: 'i9', label: 'Form I-9', inBell: 'Form I-9', afterStart: true },
];
const I9_BUSINESS_DAYS = 3;
const FIRST_DAYS_BELL_KEY = 'first_days_bell';
const FIRST_DAYS_BELL_FROM_ET = 7 * 60;
// One bell for a hire, whichever signed offer is the contract.
const checklistBellKey = (applicationId) => bellKey('checklist', applicationId);
// Monday to Friday; a holiday counts, so the day is never later than the rule's.
const addBusinessDays = (ymd, days) => {
  let day = ymd;
  for (let left = days; left > 0;) {
    day = addStaffWorkDays(day, 1);
    if (dowOf(day) !== 0 && dowOf(day) !== 6) left -= 1;
  }
  return day;
};
// The newest signature first, as signedOffersOf reads them.
const newestSignedFirst = (rows) => rows.filter((row) => row.status === 'accepted')
  .sort((a, b) => (new Date(b.signed_at) - new Date(a.signed_at)) || (a.id < b.id ? 1 : -1));
const firstDaysMarks = (signed) => Object.fromEntries(FIRST_DAYS_ITEMS
  .map((item) => [item.key, signed.map((row) => asObject(row.checklist)[item.key]).find(Boolean)])
  .filter(([, mark]) => mark));
const withoutFirstDaysMarks = (checklist) => Object.fromEntries(Object.entries(asObject(checklist))
  .filter(([key]) => !FIRST_DAYS_ITEMS.some((item) => item.key === key)));
// The first day the checklist counts from: the staff record's (the owner can move it on the Team tab), or the newest
// signed offer's start date while no signed offer of the application has made a staff record.
async function firstDayOf(conn, signed) {
  const withStaff = signed.find((row) => row.technician_id);
  const staff = withStaff && await conn('technicians').where({ id: withStaff.technician_id }).first('hire_date');
  return ymdOf((staff && staff.hire_date) || signed[0].start_date);
}

// Each item with its due day and its mark. The morning bell names an item from `ringFrom`: the day after the
// signature for the three items due before the first day, the first day for Form I-9.
function firstDaysItems(offer, marks, firstDay) {
  const i9Due = addBusinessDays(firstDay, I9_BUSINESS_DAYS);
  const dayAfterSignature = addStaffWorkDays(instantToEtDay(offer.signed_at), 1);
  return FIRST_DAYS_ITEMS.map((item) => {
    const mark = marks[item.key];
    return {
      key: item.key,
      label: item.label,
      due: item.afterStart
        ? `Due ${fmtDay(i9Due, { year: true })}, ${I9_BUSINESS_DAYS} business days after the first day`
        : `Due before the first day, ${fmtDay(firstDay, { year: true })}`,
      dueOn: item.afterStart ? i9Due : firstDay,
      doneAt: mark ? mark.at : null,
      doneByName: (mark && mark.by_name) || null,
      ringFrom: item.afterStart ? firstDay : dayAfterSignature,
      afterStart: Boolean(item.afterStart),
      inBell: item.inBell,
    };
  });
}

/** The checklist as the offer card shows it. `offer`: the newest signed offer of a Hired application. */
function firstDaysOf(offer, marks, firstDay) {
  return {
    offerId: offer.id,
    firstDay,
    items: firstDaysItems(offer, marks, firstDay).map(({ ringFrom, afterStart, inBell, ...shown }) => shown),
  };
}

// The checklist of an application, for a write: its signed offers (newest first, their rows locked), the marks and
// the first day. Null when the application has no checklist: it is not Hired, or it has no signed offer. The caller
// holds the application row's lock.
async function loadFirstDays(trx, application) {
  const signed = application.status === 'hired' ? await signedOffersOf(trx, application.id).forUpdate() : [];
  if (!signed.length) return null;
  return { signed, marks: firstDaysMarks(signed), firstDay: await firstDayOf(trx, signed) };
}

// Writes the marks on the newest signed offer and takes them off the older ones, keeping every other key.
async function storeFirstDaysMarks(trx, signed, marks, more = {}) {
  for (const [index, row] of signed.entries()) {
    const next = index === 0 ? { ...withoutFirstDaysMarks(row.checklist), ...marks, ...more } : withoutFirstDaysMarks(row.checklist);
    if (JSON.stringify(next) !== JSON.stringify(asObject(row.checklist))) {
      await trx('job_offers').where({ id: row.id }).update({ checklist: JSON.stringify(next) });
    }
  }
}

/**
 * Marks one first-days item done, or not done again (done: false). Owner account only (the route). The write names
 * the offer the card showed the checklist on: when the application is no longer Hired, or a newer offer was signed
 * since that read, nothing is written (CHECKLIST_CLOSED). A second mark of a done item keeps the first one.
 *
 * A mark closes the checklist's open bell in the same transaction. While an item is still due, the next morning's
 * pass raises it again with what is left (ringDueChecklists). Undoing a mark leaves the bell to that pass.
 * Returns { firstDays } as the write left it.
 */
async function setChecklistItem(applicationId, offerId, key, done, actor, now = new Date()) {
  if (!FIRST_DAYS_ITEMS.some((item) => item.key === key) || typeof done !== 'boolean') {
    throw new OfferError(400, 'INVALID_CHECKLIST_ITEM', 'This is not a first-days item.');
  }
  return db.transaction(async (trx) => {
    const application = await loadApplication(trx, applicationId, { lock: true });
    const held = await loadFirstDays(trx, application);
    if (!held || held.signed[0].id !== offerId) {
      throw new OfferError(409, 'CHECKLIST_CLOSED',
        'This checklist is closed: the application is no longer Hired, or a newer offer was signed. Nothing was changed.');
    }
    const marks = { ...held.marks };
    if (done && !marks[key]) marks[key] = { at: now.toISOString(), by: actor.id, by_name: await actorName(trx, actor) };
    if (!done) delete marks[key];
    await storeFirstDaysMarks(trx, held.signed, marks);
    if (done) {
      const all = FIRST_DAYS_ITEMS.every((item) => marks[item.key]);
      await require('./admin-alert-episodes').closeAdminAlertKeys(trx, [checklistBellKey(application.id)], 'checklist_done', {
        now, resolution: all ? 'Every first-days item is marked done' : 'A first-days item was marked done',
      });
    }
    return { firstDays: firstDaysOf(held.signed[0], marks, held.firstDay) };
  });
}

// The morning bell of one offer. Locks, in this order: the application row, its signed offers. The clock is read
// after them. Returns 'rung' (a new bell) | 'closed' (the bell of an application no longer Hired) | null.
async function ringChecklist(offerId, clock) {
  return db.transaction(async (trx) => {
    await trx.raw("SELECT set_config('lock_timeout', ?, true)", [String(STAFF_LOCK_WAIT_MS)]);
    const found = await trx('job_offers').where({ id: offerId }).first('application_id');
    const application = found && await trx('job_applications').where({ id: found.application_id }).forUpdate().skipLocked().first();
    if (!application) return null;
    const held = await loadFirstDays(trx, application);
    const now = clock();
    const today = etDateString(now);
    if (!held) {
      const offer = await trx('job_offers').where({ id: offerId }).forUpdate().first();
      await trx('job_offers').where({ id: offerId }).update({
        checklist: JSON.stringify({ ...asObject(offer.checklist), [FIRST_DAYS_BELL_KEY]: 'closed' }),
      });
      const closed = await require('./admin-alert-episodes').closeAdminAlertKeys(trx, [checklistBellKey(application.id)], 'checklist_done', {
        now, resolution: 'The application is no longer Hired',
      });
      return closed ? 'closed' : null;
    }
    const [offer] = held.signed;
    if (offer.id !== offerId || asObject(offer.checklist)[FIRST_DAYS_BELL_KEY] === today) return null;
    // Once a day for a hire, with or without a bell: the day's mark keeps the offer out of the later ticks.
    await storeFirstDaysMarks(trx, held.signed, held.marks, { [FIRST_DAYS_BELL_KEY]: today });
    const open = firstDaysItems(offer, held.marks, held.firstDay).filter((item) => !item.doneAt);
    const due = open.filter((item) => item.ringFrom <= today);
    if (!due.length) return null;
    const next = due.reduce((first, item) => (item.dueOn < first.dueOn ? item : first));
    const raised = await raiseBell('checklist', offer, { open: open.length, next, today }, trx);
    return raised && !raised.deduped ? 'rung' : null;
  });
}

/**
 * The morning bell of the first-days checklist (scheduler.js, the 15-minute job offer tick; GATE_JOB_OFFERS). From
 * 7:00 AM Eastern, once a day for each hire: while an item is due, the owner has ONE open bell that says how many
 * items are open and which is next. An open bell is updated with no ring. A bell that the owner closed, or that a mark
 * closed, is raised again the next morning while an item is still due. A catch-up pass within the day: each run takes
 * every hire the day's pass has not handled, so a dropped tick loses nothing. It also closes the bell of an
 * application that is no longer Hired. It sends no one anything.
 * Returns { rung, closed, failed }; the caller fails the job when failed > 0.
 * clock: the time source, for tests. The scheduler passes none.
 */
async function ringDueChecklists(clock = () => new Date()) {
  const result = { rung: 0, closed: 0, failed: 0 };
  const now = clock();
  if (minuteOfDayEt(now) < FIRST_DAYS_BELL_FROM_ET) return result;
  const handled = `o.checklist ->> '${FIRST_DAYS_BELL_KEY}'`;
  const allDone = FIRST_DAYS_ITEMS.map((item) => `o.checklist -> '${item.key}' IS NOT NULL`).join(' AND ');
  // A Hired application's newest signed offer with an item not marked on it, or an offer the pass handled before whose
  // application is no longer Hired (its bell closes once).
  const due = await db('job_offers as o').join('job_applications as a', 'a.id', 'o.application_id')
    .where('o.status', 'accepted').whereRaw(`${handled} IS DISTINCT FROM ?`, [etDateString(now)])
    .whereRaw(`((a.status = 'hired' AND NOT (${allDone}) AND NOT EXISTS (
        SELECT 1 FROM job_offers n WHERE n.application_id = o.application_id AND n.status = 'accepted'
          AND (n.signed_at, n.id) > (o.signed_at, o.id)))
      OR (a.status <> 'hired' AND ${handled} IS NOT NULL AND ${handled} <> 'closed'))`)
    .orderBy('o.signed_at').pluck('o.id');
  for (const id of due) {
    try {
      const outcome = await ringChecklist(id, clock);
      if (outcome) result[outcome] += 1;
    } catch (err) {
      result.failed += 1;
      logger.error(`[job-offers] checklist bell failed (offer ${id}): ${errTag(err)}`);
    }
  }
  return result;
}

// ------------------------------------------------------------------ bells

const BELLS = {
  signed: {
    actions: [(n) => `${n} signed the job offer`],
    why: () => 'The offer is signed and the application is now Hired.',
    doneWhen: 'offer_reviewed',
  },
  declined: {
    actions: [(n) => `${n} declined the job offer`],
    why: () => 'The application is now Withdrawn.',
    doneWhen: 'offer_reviewed',
  },
  date_requested: {
    actions: [
      (n, extra) => `${n} asked for another start date: ${extra}`,
      (n) => `${n} asked for another start date`,
      (n) => `${n} asked for a new start date`,
    ],
    why: (extra) => `Asked to start ${extra}; open the application to make an updated offer or withdraw.`,
    doneWhen: 'offer_answered',
  },
  expired: {
    actions: [(n) => `${n}'s job offer closed unsigned`, (n) => `${n}'s offer closed unsigned`],
    why: (extra) => `It closed ${extra} with no answer; open the application to make a new offer or close it.`,
    doneWhen: 'offer_reviewed',
  },
  staff_record: {
    actions: [(n) => `${n}'s staff record was not made`],
    why: () => 'The email on the application is already a staff login, so add this hire on the Team tab by hand.',
    doneWhen: 'offer_reviewed',
  },
  staff_terms: {
    actions: [(n) => `${n}'s staff record needs the new terms`, (n) => `${n}'s staff record needs new terms`],
    why: () => 'An earlier signed offer made the staff record; set its first day, pay and pay step to the new offer by hand.',
    doneWhen: 'offer_reviewed',
  },
  pay_step: {
    actions: [(n) => `${n}'s pay step was not made`],
    why: () => 'The staff record is made without the pay step of the offer; add the step on the staff record.',
    doneWhen: 'offer_reviewed',
  },
  // The first-days checklist: one open bell for a hire (keyed by the application), updated with no ring while it is
  // open, and raised again only after it was closed (admin-alert-retention.js RERING 'job-offer-checklist').
  checklist: {
    actions: [(n) => `finish ${n}'s first-days checklist`, (n) => `finish ${n}'s checklist`],
    why: ({ open, next, today }) => {
      const late = next.afterStart ? today > next.dueOn : today >= next.dueOn;
      const due = `${late ? 'was due' : 'due'}${next.afterStart ? '' : ' before'} ${fmtDay(next.dueOn)}`;
      return `${open} of ${FIRST_DAYS_ITEMS.length} items ${open === 1 ? 'is' : 'are'} open; next: ${next.inBell}, ${due}.`;
    },
    doneWhen: 'checklist_done',
    keyOf: (offer) => checklistBellKey(offer.application_id),
    standing: { dedupeOpenOnly: true, refreshOnDedupe: true, ringOnRefresh: () => false },
  },
};

const bellKey = (kind, offerId) => `job-offer-${kind}:${offerId}`;

// The "closed unsigned" bell asks the owner to make a new offer or to close the application. Each of the two clears
// it, in the transaction that does it: a Send, and a stage move that takes the application out of Offer.
async function clearExpiredBells(trx, applicationId, resolution) {
  const ids = await trx('job_offers').where({ application_id: applicationId, status: 'expired' }).pluck('id');
  if (!ids.length) return;
  await require('./admin-alert-episodes').closeAdminAlertKeys(trx, ids.map((id) => bellKey('expired', id)), 'offer_reviewed', { resolution });
}

// Raises the bell for one offer event. It names the applicant (the bell is admin-only and rings whatever the category
// override says: an applicant acting, or an offer closing, is the owner's to see). With `trx` the bell row is written
// in that transaction and an error propagates to it.
async function raiseBell(kind, offer, extra, trx = null) {
  const { raiseAdminAlert } = require('./admin-alert-compose');
  const { fitAction } = require('./admin-alert-names');
  const application = await (trx || db)('job_applications').where({ id: offer.application_id }).first('contact_snapshot');
  const name = contactOf(application).name || 'An applicant';
  const spec = BELLS[kind];
  const templates = spec.actions.map((make) => (who) => make(who, extra));
  return raiseAdminAlert('job_application', {
    area: 'Leads',
    action: fitAction('Leads', name, templates),
    why: spec.why(extra),
    severity: 'needs-you',
    link: `/admin/recruiting?application=${offer.application_id}`,
    subject: { type: 'check', id: `job-offer:${offer.id}` },
    doneWhen: spec.doneWhen,
    who: 'person',
  }, {
    bell: true,
    dedupeKey: spec.keyOf ? spec.keyOf(offer) : bellKey(kind, offer.id),
    metadata: { applicationId: offer.application_id, offerId: offer.id },
    ...(spec.standing || {}),
    ...(trx ? { trx } : {}),
  });
}

/** One bell per applicant answer, after the commit: it never undoes the answer and never throws. */
async function bell(kind, offer, extra) {
  try {
    await raiseBell(kind, offer, extra);
  } catch (err) {
    logger.error(`[job-offers] ${kind} bell not raised (offer ${offer.id}): ${errTag(err)}`);
  }
}

module.exports = {
  OfferError,
  TERMS_TEMPLATE_KEY,
  TOKEN_RE,
  DEFAULTS,
  LIMITS,
  // pure helpers (unit-tested)
  dowOf, isYmd, stepDateFor, suggestStartDate, expiryFor, fmtDay, defaultsFor,
  validateOffer, mergeOfferInput, inputOfRow, parseSignedName,
  snapshotHashOf, signatureHashOf, renderLetterMarkdown, readableTerms, payDayLineFrom,
  publicStateOf, closedMessage, presentOffer, timelineOf, buildSnapshot,
  // admin
  loadIssuedTerms, draftHashOf, heldOffersOf, stageMoveClosesOffers, lockLiveOffers, offerStampOf, liveOfferStake, closeOffersWithApplication, adminPanel, saveDraft, sendOffer, withdrawOffer, reviseOffer, signedCopy,
  // public
  publicView, setTextConsent, acceptOffer, requestDate, declineOffer,
  // scheduled
  closeExpiredOffers, sendDueReminders, makeDueStaffRecords, ringDueChecklists,
  // after signing
  setChecklistItem,
  makeStaffRecord,
};
