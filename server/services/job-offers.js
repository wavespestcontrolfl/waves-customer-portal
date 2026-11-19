/**
 * Job offers (GATE_JOB_OFFERS) — the owner's offer to a Recruiting applicant, the applicant's private link, and the
 * state machine behind both. Contract: the job-offer-flow build spec (owner "build" 2026-11-19).
 *
 * Shape of this module:
 *   - pure helpers (dates, validation, snapshot + signature hashes, the letter text, the public state) — no I/O,
 *     unit-tested on their own;
 *   - the Technician Terms lookup (ISSUED versions only, never a draft);
 *   - admin operations (panel, save draft, send, withdraw, revise, signed copy);
 *   - public operations (view, text consent, accept, date request, decline).
 *
 * Every state change is ONE transaction that locks the application row, then the offer row (always in that order),
 * re-reads the status under the lock and refuses a replay with the current state. Comms and bells run AFTER the
 * commit and never undo it.
 */

const crypto = require('crypto');
const db = require('../models/db');
const logger = require('./logger');
const { dateOnlyAtNoonUtc, dateOnlyString, formatDateOnly, validDateOnly } = require('../utils/date-only');
const { etDateString, parseETDateTime } = require('../utils/datetime-et');
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
const ownerFirstName = (snapshot) => String((snapshot && snapshot.owner && snapshot.owner.name) || 'Adam').trim().split(/\s+/)[0] || 'Adam';

// ----------------------------------------------------------------- state

/**
 * What the applicant's page shows for a row: open | signed | declined | date_requested | expired | withdrawn |
 * superseded, or null for a draft. A sent offer past its expiry reads expired before the sweep flips the row; an offer
 * whose application was closed by the owner meanwhile reads withdrawn.
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
      // A live offer belongs to an application sitting at 'offer': closed, or moved back to review or interview, it is dead.
      if (applicationStatus && applicationStatus !== 'offer') return 'withdrawn';
      if (offer.status === 'date_requested') return 'date_requested';
      return offer.expires_at && now.getTime() > new Date(offer.expires_at).getTime() ? 'expired' : 'open';
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

// A sent offer past its expiry (the sweep has not flipped the row yet).
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
  add(row.activated_at, 'activated', 'Login turned on');
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
async function adminPanel(applicationId, actor, now = new Date()) {
  const application = await loadApplication(db, applicationId);
  const rows = await db('job_offers').where({ application_id: applicationId }).orderBy('created_at', 'desc');
  const names = await sentByNames(db, rows);
  const { terms, payDayLine, blockers } = await loadIssuedTerms(db, now);
  const hashCtx = { terms, payDayLine, ownerName: actor.name, now };
  const present = (row) => presentOffer(row, {
    now,
    includeUrl: Boolean(actor.ownerAccount),
    sentByName: (row && names.get(row.sent_by)) || null,
    ...(row && row.status === 'draft' ? { draftHash: draftHashOf(row, hashCtx) } : {}),
  });
  const draft = rows.find((r) => r.status === 'draft') || null;
  const out = rows.find((r) => OUT_STATUSES.includes(r.status) && !expiredByClock(r, now)) || null;
  // current = the offer that is out (sent / date_requested), else the open draft, else the newest of any status.
  // draft = a revision in progress: the open draft when it is not itself current.
  const current = out || draft || rows[0] || null;
  const revision = draft && current && draft.id !== current.id ? draft : null;
  const defaults = { ...defaultsFor(now), reportTo: ownerReportTo(actor.name), payDayLine, expiresAt: iso(expiryFor(now)) };
  // The letter preview follows the draft being worked on; with no draft it is the frozen letter of the offer that is out.
  const shown = draft || out;
  // With no draft, the preview is the letter the applicant received (the frozen snapshot of the current offer, closed or
  // out), never today's defaults, name and Terms.
  const frozen = !draft && current && current.snapshot ? current : null;
  const view = frozen
    ? asObject(frozen.snapshot)
    : previewView({
      offerInput: shown ? inputOfRow(shown) : defaults, application, actor, terms, payDayLine, now,
      expiresAt: iso(expiryFor(now)),
    });
  return {
    enabled: true,
    termsIssued: !blockers.length,
    terms: terms ? { templateId: terms.templateId, versionId: terms.versionId, title: terms.title, issuedAt: terms.issuedAt } : null,
    termsBlockers: blockers,
    defaults,
    // The preview names the offer its letter belongs to (the open draft, else the frozen letter of the current offer, else
    // none: the defaults) and that draft's hash, so a Save, Send or Discard can be tied to what was read.
    letterPreview: {
      offerId: draft ? draft.id : (frozen ? current.id : null),
      draftHash: draft ? draftHashOf(draft, hashCtx) : null,
      markdown: renderLetterMarkdown(view),
    },
    current: present(current),
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
      const [row] = await trx('job_offers').where({ id: draft.id }).update({ ...columns, updated_at: new Date() }).returning('*');
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

// Revise ALWAYS yields an editable draft: a start date that no longer works (passed, or not Monday to Thursday) falls back
// to the suggested start, and the raise date follows the start date. Save and Send validate dates; Revise never refuses.
function reviseInput(offer, requested, now) {
  const base = inputOfRow(offer);
  const wanted = requested || base.startDate;
  const checks = [];
  checkStartDate(checks, wanted, now);
  const startDate = checks.length ? suggestStartDate(now) : wanted;
  if (startDate === base.startDate) return base;
  return { ...base, startDate, stepEffectiveOn: base.stepRate === null ? null : stepDateFor(startDate) };
}

/** POST /:id/offer/:offerId/revise — a new draft copied from a sent / date_requested offer. Needs { expectedStatus }. */
async function reviseOffer(applicationId, offerId, input, actor, now = new Date()) {
  const request = input && typeof input === 'object' ? input : {};
  if (!OUT_STATUSES.includes(request.expectedStatus)) {
    throw new OfferError(400, 'EXPECTED_STATUS_REQUIRED', 'Say which state of the offer you are acting on.');
  }
  return db.transaction(async (trx) => {
    const application = await loadApplication(trx, applicationId, { lock: true });
    assertOfferable(application);
    const offer = await loadOffer(trx, applicationId, offerId, { lock: true });
    assertExpectedStatus(offer, request.expectedStatus, OUT_STATUSES);
    if (expiredByClock(offer, now)) {
      throw new OfferError(409, 'OFFER_NOT_REVISABLE', 'Only an offer that is out can be revised.', { status: 'expired' });
    }
    const existing = await trx('job_offers').where({ application_id: applicationId, status: 'draft' }).forUpdate().first();
    if (existing && existing.supersedes_id !== offer.id) {
      throw new OfferError(409, 'DRAFT_EXISTS', 'There is already a draft. Send or withdraw it first.', { offerId: existing.id });
    }
    const ownerName = await actorName(trx, actor);
    // A retry (or a second tab) gets the draft that is already there, untouched: it may hold newer edits.
    if (existing) return presentDraft(trx, existing, ownerName, now);

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
 */
async function withdrawOffer(applicationId, offerId, actor, precondition = {}, now = new Date()) {
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
async function heldOffersOf(trx, applicationId, now = new Date()) {
  const rows = await trx('job_offers').where({ application_id: applicationId })
    .whereIn('status', ['sent', 'date_requested']).forUpdate().select('id', 'status', 'expires_at');
  return rows.filter((o) => o.status === 'date_requested' || !o.expires_at || new Date(o.expires_at).getTime() >= now.getTime());
}

async function closeOffersWithApplication(trx, applicationId, actorId, now = new Date()) {
  return trx('job_offers').where({ application_id: applicationId }).whereIn('status', LIVE_STATUSES)
    .update({ status: 'withdrawn', withdrawn_at: now, withdrawn_by: actorId || null, updated_at: new Date() });
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
  const contact = contactOf(application);
  if (!contact.phone && !contact.email) throw new OfferError(409, 'NO_CONTACT', 'This applicant has no phone number or email.');
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

async function supersedePrior(trx, applicationId, offer, now) {
  const out = await trx('job_offers').where({ application_id: applicationId }).whereIn('status', OUT_STATUSES).forUpdate().first();
  if (!out) return;
  if (out.id !== offer.supersedes_id && expiredByClock(out, now)) {
    await trx('job_offers').where({ id: out.id }).update({ status: 'expired', updated_at: new Date() });
    return;
  }
  if (out.id !== offer.supersedes_id) {
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

async function commitSend(applicationId, offerId, actor, now, draftHash) {
  return db.transaction(async (trx) => {
    const application = await loadApplication(trx, applicationId, { lock: true });
    const offer = await loadOffer(trx, applicationId, offerId, { lock: true });
    const name = await actorName(trx, actor);
    const { terms, payDayLine } = await assertSendable(trx, application, offer, { now, ownerName: name, draftHash });
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
    return { offer: row, application: updatedApplication, ownerName: name, snapshot };
  });
}

// The text + email, after the commit. Comms never undo the send: a failure is reported per channel.
async function deliverOfferComms({ offer, application, ownerName, snapshot }, actor) {
  const RecruitingComms = require('./recruiting-comms');
  const contact = RecruitingComms.contactOf(application);
  const stillEligible = async (conn = db) => {
    const row = await conn('job_offers').where({ id: offer.id }).first('status', 'token');
    const app = await conn('job_applications').where({ id: application.id }).first('status');
    return Boolean(row && row.status === 'sent' && row.token === offer.token && app && app.status === 'offer');
  };
  try {
    const comms = await RecruitingComms.sendStageComms(application, 'offer_sent', {
      sms: Boolean(contact.phone),
      email: Boolean(contact.email),
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
    return { sms: { outcome: 'failed', code: 'comms_threw' }, email: { outcome: 'failed', code: 'comms_threw' } };
  }
}

const outcomesOf = (comms) => ({
  sms: { outcome: comms.sms, code: null },
  email: { outcome: comms.email, code: null },
});

/** POST /:id/offer/:offerId/send */
async function sendOffer(applicationId, offerId, actor, draftHash, now = new Date()) {
  if (typeof draftHash !== 'string' || !draftHash) {
    throw new OfferError(400, 'DRAFT_HASH_REQUIRED', 'Send needs the hash of the preview you reviewed.');
  }
  const committed = await commitSend(applicationId, offerId, actor, now, draftHash);
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

const refusal = (state, offer) => ({
  refused: true,
  body: state === 'superseded' || state === 'withdrawn' || state === 'expired'
    ? closedPayload(state, offer, asObject(offer.snapshot))
    : { state },
});

/**
 * POST /:token/text-consent. `version` is the offer's version from the read the choice was made on. A save can land
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
    if (version !== current) return { refused: true, body: { state: 'open' } };
    // Strictly later than the version it replaces, so two changes in one millisecond still get two versions.
    const updatedAt = new Date(Math.max(Date.now(), new Date(found.offer.updated_at).getTime() + 1));
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

/** POST /:token/accept */
async function acceptOffer(token, { signedName, ip, userAgent }) {
  const name = parseSignedName(signedName);
  const result = await db.transaction(async (trx) => {
    const found = await lockByToken(trx, token);
    if (!found) return { notFound: true };
    const { offer, state } = found;
    // An identical replay of a signature is answered with the stored one, never a second signature.
    if (state === 'signed' && name && sameName(name, offer.signed_name)) return { body: { state: 'signed', signedAt: iso(offer.signed_at) } };
    if (state !== 'open') return refusal(state, offer);
    if (!name) return { invalid: 'Type your full name to sign.' };
    return { body: await signOffer(trx, offer, { name, ip, userAgent, now: found.now }), forBell: offer };
  });
  if (result.forBell) await bell('signed', result.forBell, null);
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

/** POST /:token/date-request */
async function requestDate(token, { requestedStartDate, note }) {
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
    const cleanNote = note ? cleanText(note) : null;
    await trx('job_offers').where({ id: found.offer.id }).update({
      status: 'date_requested', date_requested_at: found.now, requested_start_date: requestedStartDate,
      date_request_note: cleanNote || null, updated_at: new Date(),
    });
    return { body: { state: 'date_requested' }, forBell: found.offer };
  });
  if (result.forBell) await bell('date_requested', result.forBell, fmtDay(requestedStartDate));
  return result;
}

/** POST /:token/decline */
async function declineOffer(token, { reason }) {
  const result = await db.transaction(async (trx) => {
    const found = await lockByToken(trx, token);
    if (!found) return { notFound: true };
    if (found.state !== 'open') return refusal(found.state, found.offer);
    if (reason !== undefined && reason !== null && (typeof reason !== 'string' || cleanText(reason).length > LIMITS.noteChars)) {
      return { invalid: `The reason must be ${LIMITS.noteChars} characters or fewer.` };
    }
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
};

/**
 * One bell per offer event, after the commit. Names the applicant (the bell is admin-only and rings whatever the
 * category override says: an applicant signing is a person acting). Never throws.
 */
async function bell(kind, offer, extra) {
  try {
    const { raiseAdminAlert } = require('./admin-alert-compose');
    const { fitAction } = require('./admin-alert-names');
    const application = await db('job_applications').where({ id: offer.application_id }).first('contact_snapshot');
    const name = contactOf(application).name || 'An applicant';
    const spec = BELLS[kind];
    const templates = spec.actions.map((make) => (who) => make(who, extra));
    await raiseAdminAlert('job_application', {
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
      dedupeKey: `job-offer-${kind}:${offer.id}`,
      metadata: { applicationId: offer.application_id, offerId: offer.id },
    });
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
  loadIssuedTerms, draftHashOf, heldOffersOf, closeOffersWithApplication, adminPanel, saveDraft, sendOffer, withdrawOffer, reviseOffer, signedCopy,
  // public
  publicView, setTextConsent, acceptOffer, requestDate, declineOffer,
};
