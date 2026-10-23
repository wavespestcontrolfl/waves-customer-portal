const express = require('express');
const Joi = require('joi');
const db = require('../models/db');
const logger = require('../services/logger');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { bidDeskLive, bidChecklistLive } = require('../config/feature-gates');
const { markEmailAsBid, columnsFor } = require('../services/bid-desk');
const checklist = require('../services/bid-desk/checklist');
const { TYPES: SOLICITATION_TYPES } = require('../models/migrations/20261023130000_bid_desk_checklist');
const { daysLeft } = require('../services/bid-desk/rules');
const { parseETDateTime, validCalendarDate, etParts, etWallClockOccurrences } = require('../utils/datetime-et');
const { openAdminAlertKeys, closeAdminAlertKeys } = require('../services/admin-alert-episodes');
const { OPEN_STATUSES } = require('../services/bid-desk/rules');

// Bid Desk (GATE_BID_DESK, dark). Staff-only list, detail and decisions for bid invites found in the email table.
// Nothing here sends a message to anyone; a due date only becomes "confirmed" when the operator types or confirms it.
// GATE_BID_CHECKLIST (also dark) adds the solicitation type, the questions and job-walk dates, the estimate link, the
// documents, the per-bid checklist and the submission record; with it off those fields are refused and the checklist
// routes answer 404.
const router = express.Router();
router.use(adminAuthenticate, requireAdmin);
// Gate off = the whole surface answers 404, exactly as if it were not mounted.
router.use((req, res, next) => (bidDeskLive() ? next() : res.status(404).json({ error: 'Not found' })));

// The checklist routes answer 404 while GATE_BID_CHECKLIST is off, exactly as if they were not mounted.
const requireChecklist = (req, res, next) => (bidChecklistLive() ? next() : res.status(404).json({ error: 'Not found' }));

const STATUSES = ['new', 'bid', 'no_bid', 'submitted', 'won', 'lost'];
const LIST_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Operator-typed ET wall time: "2026-10-05T14:00" (what a datetime-local input sends), or null to clear.
const etWallTime = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).allow(null);

const patchKeys = {
  due_at: etWallTime,
  confirm_due: Joi.boolean().strict().valid(true),
  expected_updated_at: Joi.string().isoDate(),
  job_walk_at: etWallTime,
  questions_due_at: etWallTime,
  status: Joi.string().valid(...STATUSES),
  decision_note: Joi.string().trim().max(2000).allow('', null),
};
const patchSchema = Joi.object(patchKeys).min(1).unknown(false);
// GATE_BID_CHECKLIST: the fields it adds. jobWalkAt and questionsDueAt are the same two dates as job_walk_at and
// questions_due_at (a request may use one spelling of each, not both).
const checklistPatchSchema = Joi.object({
  ...patchKeys,
  solicitationType: Joi.string().valid(...SOLICITATION_TYPES).allow(null),
  scored: Joi.boolean().strict().allow(null),
  questionsDueAt: etWallTime,
  jobWalkAt: etWallTime,
  jobWalkMandatory: Joi.boolean().strict(),
  jobWalkConfirmed: Joi.boolean().strict().valid(true),
  estimateId: Joi.string().uuid().allow(null),
  submittedAt: etWallTime,
  submissionConfirmation: Joi.string().trim().max(500).allow('', null),
}).min(1).unknown(false).oxor('job_walk_at', 'jobWalkAt').oxor('questions_due_at', 'questionsDueAt');

const itemSchema = Joi.object({
  label: Joi.string().trim().min(1).max(500),
  sourceText: Joi.string().trim().max(2000).allow('', null),
  notes: Joi.string().trim().max(2000).allow('', null),
  required: Joi.boolean().strict(),
}).unknown(false);
const addItemSchema = itemSchema.fork(['label'], (field) => field.required());
const updateItemSchema = itemSchema.keys({ checked: Joi.boolean().strict() }).min(1);
const startSchema = Joi.object({ type: Joi.string().valid(...SOLICITATION_TYPES) }).unknown(false);
const reorderSchema = Joi.object({ ids: Joi.array().items(Joi.string().uuid()).min(1).max(200).required() }).unknown(false);

const DATE_CHANGED = 'The due date changed since you opened this bid. Reload and check it again.';

const fromEmailSchema = Joi.object({ email_id: Joi.string().uuid().required() }).unknown(false);

// An operator-typed ET wall time must be exactly one real Eastern clock reading: hours 00-23, minutes 00-59, a
// real calendar day, not inside the spring-forward gap (parseETDateTime would roll it forward) and not the
// repeated fall-back hour (two instants; the operator must pick another time).
function toInstant(value) {
  if (value === null) return { ok: true, at: null };
  const [day, clock] = value.split('T');
  const [hour, minute] = clock.split(':').map(Number);
  if (!validCalendarDate(day) || !(hour >= 0 && hour <= 23) || !(minute >= 0 && minute <= 59)) return { ok: false };
  const at = parseETDateTime(value);
  if (Number.isNaN(at.getTime())) return { ok: false };
  const p = etParts(at);
  const pad = (n) => String(n).padStart(2, '0');
  const roundTrip = `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
  if (roundTrip !== value || etWallClockOccurrences(at) !== 1) return { ok: false };
  return { ok: true, at };
}

// The column changes a PATCH asks for, or the refusal. A date save or confirmation is accepted only against the bid
// version the operator looked at (`fenced`): an addendum filed since the page loaded moves updated_at and the write
// is refused. Compared at millisecond precision, the precision the page has.
function datePatch(bid, value) {
  if (value.due_at !== undefined) {
    const parsed = toInstant(value.due_at);
    if (!parsed.ok) return { error: { status: 400, body: { error: 'due_at is not a real Eastern date and time' } } };
    // A date a person typed is the confirmed date. Clearing it un-confirms. Reminders start over for the new date.
    // The email line it was read from no longer describes it, unless the typed date is that same date.
    const unchanged = parsed.at && bid.due_at && new Date(bid.due_at).getTime() === parsed.at.getTime();
    return {
      patch: {
        due_at: parsed.at,
        due_source_line: unchanged ? bid.due_source_line : null,
        due_confirmed: parsed.at !== null,
        needs_date_confirmation: false,
        reminder_7d_sent_at: null,
        reminder_2d_sent_at: null,
        reminder_14d_sent_at: null,
      },
    };
  }
  if (!value.confirm_due) return { patch: {} };
  if (!bid.due_at) return { error: { status: 400, body: { error: 'There is no date to confirm' } } };
  return { patch: { due_confirmed: true, needs_date_confirmation: false } };
}

const sameInstantOrBothNull = (a, b) => (a == null && b == null) || (a != null && b != null && new Date(a).getTime() === new Date(b).getTime());
// The stamp each of the two extra dates keeps; changing the date clears it so the reminder fires once for the new date.
const DATE_STAMPS = { job_walk_at: 'job_walk_reminder_sent_at', questions_due_at: 'questions_reminder_sent_at' };

// The fields GATE_BID_CHECKLIST adds (only present in a request the gate-on schema let through).
function checklistPatch(value) {
  const patch = {};
  if (value.solicitationType !== undefined) patch.solicitation_type = value.solicitationType;
  if (value.scored !== undefined) patch.scored = value.scored;
  if (value.jobWalkMandatory !== undefined) patch.job_walk_mandatory = value.jobWalkMandatory;
  if (value.estimateId !== undefined) patch.estimate_id = value.estimateId;
  if (value.submissionConfirmation !== undefined) patch.submission_confirmation = value.submissionConfirmation || null;
  if (value.submittedAt !== undefined) {
    const parsed = toInstant(value.submittedAt);
    if (!parsed.ok) return { error: { status: 400, body: { error: 'submittedAt is not a real date' } } };
    patch.submitted_at = parsed.at;
  }
  return { patch };
}

function buildPatch(bid, value) {
  const fenced = value.due_at !== undefined || value.confirm_due === true;
  if (fenced && !value.expected_updated_at) return { error: { status: 409, body: { error: DATE_CHANGED } } };
  const patch = {};
  for (const key of ['job_walk_at', 'questions_due_at']) {
    if (value[key] === undefined) continue;
    const parsed = toInstant(value[key]);
    if (!parsed.ok) return { error: { status: 400, body: { error: `${key} is not a real date` } } };
    patch[key] = parsed.at;
    if (!sameInstantOrBothNull(bid[key], parsed.at)) patch[DATE_STAMPS[key]] = null;
    // A site-visit date the operator actually changed is the confirmed date (a new value, even a retyped one that
    // differs). Sending the stored value again is not an edit: the flag stays as it is, so saving the type with the
    // prefilled date never confirms a date that was read from an invite. Clearing the date un-confirms.
    if (key === 'job_walk_at') {
      if (parsed.at === null) patch.job_walk_confirmed = false;
      else if (!sameInstantOrBothNull(bid.job_walk_at, parsed.at)) patch.job_walk_confirmed = true;
    }
  }
  // Confirm the site-visit date as read, without editing it (the page's "Confirm site visit date"); it needs a date.
  if (value.jobWalkConfirmed === true) {
    if (!(value.job_walk_at !== undefined ? patch.job_walk_at : bid.job_walk_at)) {
      return { error: { status: 400, body: { error: 'There is no site visit date to confirm' } } };
    }
    patch.job_walk_confirmed = true;
  }
  const dates = datePatch(bid, value);
  if (dates.error) return dates;
  Object.assign(patch, dates.patch);
  if (value.status !== undefined) patch.status = value.status;
  if (value.decision_note !== undefined) patch.decision_note = value.decision_note || null;
  const extra = checklistPatch(value);
  if (extra.error) return extra;
  Object.assign(patch, extra.patch);
  return { patch, fenced };
}

// GATE_BID_CHECKLIST spells the two extra dates in camelCase; they are the same columns as job_walk_at and
// questions_due_at.
function withDateAliases(value) {
  const { jobWalkAt, questionsDueAt, ...rest } = value;
  return {
    ...rest,
    ...(jobWalkAt !== undefined ? { job_walk_at: jobWalkAt } : {}),
    ...(questionsDueAt !== undefined ? { questions_due_at: questionsDueAt } : {}),
  };
}

// Notifications whose condition a successful save has met leave the bell (docs/admin-notifications.md 4.3).
async function closeDoneAlerts(conn, bidId, before, after) {
  const prefixes = [];
  const reason = [];
  // Every bell on a closed SAM.gov notice asks for a decision, not a date (addendumSpec), so confirming a date leaves
  // them open.
  const keep = [];
  if (after.due_confirmed && (before.needs_date_confirmation || !before.due_confirmed) && !after.needs_date_confirmation) {
    prefixes.push(`bid-desk:addendum:${bidId}:`);
    reason.push('due_date_confirmed');
    keep.push(...(after.source_active === false ? [`bid-desk:addendum:${bidId}:sam:`] : []));
  }
  // A changed or cleared date retires the reminders sent for the old one.
  const dateOf = (row) => (row.due_at ? new Date(row.due_at).getTime() : null);
  if (dateOf(before) !== dateOf(after)) {
    prefixes.push(`bid-desk:remind:${bidId}:`);
    reason.push('due_date_changed');
  }
  // GATE_BID_CHECKLIST reminders: a changed or cleared date retires the reminder sent for the old one.
  if (bidChecklistLive()) {
    const at = (row, key) => (row[key] ? new Date(row[key]).getTime() : null);
    if (at(before, 'questions_due_at') !== at(after, 'questions_due_at')) {
      prefixes.push(`bid-desk:remind-questions:${bidId}:`);
      reason.push('questions_date_changed');
    }
    if (at(before, 'job_walk_at') !== at(after, 'job_walk_at')) {
      prefixes.push(`bid-desk:remind-jobwalk:${bidId}:`);
      reason.push('job_walk_date_changed');
    }
  }
  if (before.status === 'new' && after.status !== 'new') {
    prefixes.push(`bid-desk:new:${bidId}`);
    reason.push('bid_decided');
  }
  if (OPEN_STATUSES.includes(before.status) && !OPEN_STATUSES.includes(after.status)) {
    prefixes.push(`bid-desk:new:${bidId}`, `bid-desk:addendum:${bidId}:`, `bid-desk:remind:${bidId}:`);
    if (bidChecklistLive()) prefixes.push(`bid-desk:remind-questions:${bidId}:`, `bid-desk:remind-jobwalk:${bidId}:`);
    reason.push('bid_closed');
    keep.length = 0;
  }
  if (!prefixes.length) return 0;
  const keys = (await Promise.all([...new Set(prefixes)].map((prefix) => openAdminAlertKeys(conn, prefix)))).flat()
    .filter((key) => !keep.some((prefix) => key.startsWith(prefix)));
  return closeAdminAlertKeys(conn, keys, reason.join(','));
}

function present(row, extra = {}) {
  return { ...row, days_left: daysLeft(row.due_at), ...extra };
}

router.get('/', async (req, res, next) => {
  try {
    const live = bidChecklistLive();
    const rows = await db('bid_opportunities as b')
      .leftJoin('emails as fe', 'fe.id', 'b.first_email_id')
      .select(columnsFor().map((column) => `b.${column}`))
      .select('fe.subject as first_subject', 'fe.from_name as first_from_name', 'fe.from_address as first_from_address')
      .select(db('bid_opportunity_emails as l').whereRaw('l.bid_id = b.id').count('*').as('email_count'))
      // Open bids first by due date (undated last), then the decided ones, newest first.
      .orderByRaw("(b.status IN ('new', 'bid')) DESC, CASE WHEN b.status IN ('new', 'bid') THEN b.due_at END ASC NULLS LAST, b.created_at DESC")
      .limit(LIST_LIMIT);
    if (!live) return res.json({ bids: rows.map((row) => present({ ...row, email_count: Number(row.email_count) })) });
    const progress = await checklist.progressForBids(db, rows.map((row) => row.id));
    return res.json({
      checklist_live: true,
      bids: rows.map((row) => present({ ...row, email_count: Number(row.email_count) }, { checklist_progress: progress[row.id] || { checked: 0, required: 0 } })),
    });
  } catch (err) {
    return next(err);
  }
});

// Registered before '/:id' so "from-email" is never read as an id.
router.post('/from-email', async (req, res, next) => {
  try {
    const { error, value } = fromEmailSchema.validate(req.body || {});
    if (error) return res.status(400).json({ error: 'email_id must be an email id' });
    const outcome = await markEmailAsBid(value.email_id);
    if (outcome.error === 'email_not_found') return res.status(404).json({ error: 'Email not found' });
    return res.status(outcome.created ? 201 : 200).json({ ok: true, bid_id: outcome.bidId, created: !!outcome.created });
  } catch (err) {
    return next(err);
  }
});

// GATE_BID_CHECKLIST: estimates the operator can link to a bid, by estimate number (slug), id or customer name.
// Registered before '/:id'. Lightweight rows only; the proposal itself opens on its own page.
router.get('/estimates', requireChecklist, async (req, res, next) => {
  try {
    const q = String(req.query.q || '').trim().slice(0, 100);
    if (q.length < 2) return res.json({ estimates: [] });
    const like = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
    const rows = await db('estimates')
      .whereNull('archived_at')
      .where((w) => {
        w.whereILike('estimate_slug', like).orWhereILike('customer_name', like);
        if (UUID.test(q)) w.orWhere({ id: q });
      })
      .orderBy('created_at', 'desc').limit(10).select('id', 'estimate_slug', 'customer_name', 'status');
    res.json({ estimates: rows.map(estimateSummary) });
  } catch (err) {
    next(err);
  }
});

// The linked estimate as the page shows it: its number, who it is for, and the proposal link.
function estimateSummary(row) {
  return {
    id: row.id,
    slug: row.estimate_slug || null,
    name: row.customer_name || null,
    status: row.status || null,
    proposal_path: `/admin/estimates/${row.id}/proposal`,
  };
}

// Every attachment of every email linked to the bid, by reference: the file stays in the mailbox and is downloaded
// through the existing email-attachment route (download_path is relative to the API base, as adminFetch expects).
async function bidDocuments(conn, bidId) {
  const rows = await conn('bid_opportunity_emails as l')
    .join('emails as e', 'e.id', 'l.email_id')
    .join('email_attachments as a', 'a.email_id', 'e.id')
    .where('l.bid_id', bidId)
    .orderBy([{ column: 'l.received_at' }, { column: 'a.created_at' }, { column: 'a.id' }])
    .select('a.id', 'a.filename', 'a.mime_type', 'a.size_bytes', 'a.gmail_attachment_id', 'e.id as email_id', 'e.subject', 'l.received_at');
  return rows.map((row) => ({
    id: row.id,
    name: row.filename || 'attachment',
    size: row.size_bytes == null ? null : Number(row.size_bytes),
    mime_type: row.mime_type || null,
    email_id: row.email_id,
    email_subject: row.subject || null,
    received_at: row.received_at,
    download_path: row.gmail_attachment_id
      ? `/admin/email/message/${row.email_id}/attachment/${encodeURIComponent(row.gmail_attachment_id)}`
      : null,
  }));
}

router.get('/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const live = bidChecklistLive();
    const bid = await db('bid_opportunities').where({ id: req.params.id }).first(columnsFor());
    if (!bid) return res.status(404).json({ error: 'Not found' });
    const emails = await db('bid_opportunity_emails as l')
      .join('emails as e', 'e.id', 'l.email_id')
      .where('l.bid_id', bid.id)
      .orderBy('l.received_at')
      .select('l.email_id', 'l.kind', 'l.received_at', 'e.subject', 'e.from_name', 'e.from_address');
    if (!live) return res.json({ bid: present(bid), emails });
    const items = await checklist.listItems(db, bid.id);
    const estimate = bid.estimate_id
      ? await db('estimates').where({ id: bid.estimate_id }).first('id', 'estimate_slug', 'customer_name', 'status')
      : null;
    return res.json({
      bid: present(bid),
      emails,
      checklist_live: true,
      checklist: items,
      checklist_progress: checklist.progressOf(items),
      estimate: estimate ? estimateSummary(estimate) : null,
      documents: await bidDocuments(db, bid.id),
    });
  } catch (err) {
    return next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    // Gate off: only the original fields validate, so every field GATE_BID_CHECKLIST adds is refused.
    const live = bidChecklistLive();
    const { error, value: raw } = (live ? checklistPatchSchema : patchSchema).validate(req.body || {});
    if (error) return res.status(400).json({ error: 'Invalid bid update' });
    const value = live ? withDateAliases(raw) : raw;
    // The read, the write, the fresh read and the closing of done alerts run under one bid-row lock: intake and the
    // owed-bell delivery lock the same row, so an addendum is either before this save (and the version fence refuses
    // it) or after it (and its bell is never closed by this save).
    const outcome = await db.transaction(async (trx) => {
      const bid = await trx('bid_opportunities').where({ id: req.params.id }).forUpdate().first(columnsFor());
      if (!bid) return { status: 404, body: { error: 'Not found' } };
      // A linked estimate must exist (the foreign key would also refuse it, with a worse answer).
      if (value.estimateId && !(await trx('estimates').where({ id: value.estimateId }).first('id'))) {
        return { status: 400, body: { error: 'That estimate does not exist' } };
      }
      const built = buildPatch(bid, value);
      if (built.error) return built.error;
      const { patch, fenced } = built;

      const written = await trx('bid_opportunities').where({ id: bid.id })
        .modify((q) => { if (fenced) q.whereRaw("date_trunc('milliseconds', updated_at) = ?::timestamptz", [value.expected_updated_at]); })
        .update({ ...patch, updated_at: trx.raw('clock_timestamp()') });
      if (!written) return { status: 409, body: { error: DATE_CHANGED } };
      const updated = await trx('bid_opportunities').where({ id: bid.id }).first(columnsFor());
      try {
        await trx.raw('SAVEPOINT bid_desk_close_alerts');
        await closeDoneAlerts(trx, bid.id, bid, updated);
        await trx.raw('RELEASE SAVEPOINT bid_desk_close_alerts');
      } catch (err) {
        // The save stands; an alert left open is closed by hand. Class and code only (row values stay out of logs).
        await trx.raw('ROLLBACK TO SAVEPOINT bid_desk_close_alerts').catch(() => {});
        logger.warn(`[bid-desk] closing done alerts for ${bid.id} failed: ${err?.name || 'Error'}${err?.code ? ` ${err.code}` : ''}`);
      }
      return { status: 200, body: { ok: true, bid: present(updated) } };
    });
    res.status(outcome.status).json(outcome.body);
  } catch (err) {
    next(err);
  }
});

// ---------- the per-bid checklist (GATE_BID_CHECKLIST) ----------

const invalid = (res) => res.status(400).json({ error: 'Invalid checklist update' });
const notFound = (res) => res.status(404).json({ error: 'Not found' });
const bidExists = async (conn, id, lock = false) => conn('bid_opportunities').where({ id }).modify((q) => { if (lock) q.forUpdate(); }).first('id', 'solicitation_type');

// Starts the checklist for the bid's type. Idempotent: lines already there are left alone. ?add=missing adds only the
// template lines the bid does not carry. A type in the body is the type the operator picked; it is saved on the bid.
router.post('/:id/checklist/start', requireChecklist, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return notFound(res);
    const { error, value } = startSchema.validate(req.body || {});
    if (error || (req.query.add !== undefined && req.query.add !== 'missing')) return invalid(res);
    const outcome = await db.transaction(async (trx) => {
      // The bid row is locked, so two presses of the button insert one list.
      const bid = await bidExists(trx, req.params.id, true);
      if (!bid) return null;
      const type = value.type || bid.solicitation_type || null;
      if (value.type && value.type !== bid.solicitation_type) await trx('bid_opportunities').where({ id: bid.id }).update({ solicitation_type: value.type });
      const result = await checklist.startChecklist(trx, bid.id, type, { addMissing: req.query.add === 'missing' });
      const items = await checklist.listItems(trx, bid.id);
      return { ...result, type, checklist: items, checklist_progress: checklist.progressOf(items) };
    });
    if (!outcome) return notFound(res);
    return res.status(outcome.added ? 201 : 200).json({ ok: true, ...outcome });
  } catch (err) {
    return next(err);
  }
});

router.post('/:id/checklist/reorder', requireChecklist, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return notFound(res);
    const { error, value } = reorderSchema.validate(req.body || {});
    if (error) return invalid(res);
    const outcome = await db.transaction(async (trx) => {
      if (!(await bidExists(trx, req.params.id, true))) return null;
      if (!(await checklist.reorderItems(trx, req.params.id, value.ids))) return { stale: true };
      return { checklist: await checklist.listItems(trx, req.params.id) };
    });
    if (!outcome) return notFound(res);
    if (outcome.stale) return res.status(409).json({ error: 'The list changed. Reload and try again.' });
    return res.json({ ok: true, checklist: outcome.checklist, checklist_progress: checklist.progressOf(outcome.checklist) });
  } catch (err) {
    return next(err);
  }
});

// A custom line, with the quote or page cite it came from.
router.post('/:id/checklist', requireChecklist, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return notFound(res);
    const { error, value } = addItemSchema.validate(req.body || {});
    if (error) return invalid(res);
    const outcome = await db.transaction(async (trx) => {
      if (!(await bidExists(trx, req.params.id, true))) return null;
      const item = await checklist.addItem(trx, req.params.id, value);
      return { item, items: await checklist.listItems(trx, req.params.id) };
    });
    if (!outcome) return notFound(res);
    return res.status(201).json({ ok: true, item: outcome.item, checklist_progress: checklist.progressOf(outcome.items) });
  } catch (err) {
    return next(err);
  }
});

// Edit, tick (checked: true) or untick (checked: false) one line.
router.patch('/:id/checklist/:itemId', requireChecklist, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id) || !UUID.test(req.params.itemId)) return notFound(res);
    const { error, value } = updateItemSchema.validate(req.body || {});
    if (error) return invalid(res);
    const outcome = await db.transaction(async (trx) => {
      const item = await checklist.updateItem(trx, req.params.id, req.params.itemId, value, req.technicianId);
      return item ? { item, items: await checklist.listItems(trx, req.params.id) } : null;
    });
    if (!outcome) return notFound(res);
    return res.json({ ok: true, item: outcome.item, checklist_progress: checklist.progressOf(outcome.items) });
  } catch (err) {
    return next(err);
  }
});

// Archive: the line leaves the list; the row stays.
router.delete('/:id/checklist/:itemId', requireChecklist, async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id) || !UUID.test(req.params.itemId)) return notFound(res);
    const outcome = await db.transaction(async (trx) => {
      if (!(await checklist.archiveItem(trx, req.params.id, req.params.itemId))) return null;
      return { items: await checklist.listItems(trx, req.params.id) };
    });
    if (!outcome) return notFound(res);
    return res.json({ ok: true, checklist_progress: checklist.progressOf(outcome.items) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
