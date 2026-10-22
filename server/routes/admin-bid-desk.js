const express = require('express');
const Joi = require('joi');
const db = require('../models/db');
const { adminAuthenticate, requireAdmin } = require('../middleware/admin-auth');
const { bidDeskLive } = require('../config/feature-gates');
const { markEmailAsBid, BID_COLUMNS } = require('../services/bid-desk');
const { daysLeft } = require('../services/bid-desk/rules');
const { parseETDateTime, validCalendarDate } = require('../utils/datetime-et');

// Bid Desk (GATE_BID_DESK, dark). Staff-only list, detail and decisions for bid invites found in the email table.
// Nothing here sends a message to anyone; a due date only becomes "confirmed" when the operator types or confirms it.
const router = express.Router();
router.use(adminAuthenticate, requireAdmin);
// Gate off = the whole surface answers 404, exactly as if it were not mounted.
router.use((req, res, next) => (bidDeskLive() ? next() : res.status(404).json({ error: 'Not found' })));

const STATUSES = ['new', 'bid', 'no_bid', 'submitted', 'won', 'lost'];
const LIST_LIMIT = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Operator-typed ET wall time: "2026-10-05T14:00" (what a datetime-local input sends), or null to clear.
const etWallTime = Joi.string().pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/).allow(null);

const patchSchema = Joi.object({
  due_at: etWallTime,
  confirm_due: Joi.boolean().strict().valid(true),
  expected_updated_at: Joi.string().isoDate(),
  job_walk_at: etWallTime,
  questions_due_at: etWallTime,
  status: Joi.string().valid(...STATUSES),
  decision_note: Joi.string().trim().max(2000).allow('', null),
}).min(1).unknown(false);

const DATE_CHANGED = 'The due date changed since you opened this bid. Reload and check it again.';

const fromEmailSchema = Joi.object({ email_id: Joi.string().uuid().required() }).unknown(false);

function toInstant(value) {
  if (value === null) return { ok: true, at: null };
  if (!validCalendarDate(value.slice(0, 10))) return { ok: false };
  const at = parseETDateTime(value);
  return Number.isNaN(at.getTime()) ? { ok: false } : { ok: true, at };
}

function present(row, extra = {}) {
  return { ...row, days_left: daysLeft(row.due_at), ...extra };
}

router.get('/', async (req, res, next) => {
  try {
    const rows = await db('bid_opportunities as b')
      .leftJoin('emails as fe', 'fe.id', 'b.first_email_id')
      .select(BID_COLUMNS.map((column) => `b.${column}`))
      .select('fe.subject as first_subject', 'fe.from_name as first_from_name', 'fe.from_address as first_from_address')
      .select(db('bid_opportunity_emails as l').whereRaw('l.bid_id = b.id').count('*').as('email_count'))
      // Open bids first by due date (undated last), then the decided ones, newest first.
      .orderByRaw("(b.status IN ('new', 'bid')) DESC, CASE WHEN b.status IN ('new', 'bid') THEN b.due_at END ASC NULLS LAST, b.created_at DESC")
      .limit(LIST_LIMIT);
    res.json({ bids: rows.map((row) => present({ ...row, email_count: Number(row.email_count) })) });
  } catch (err) {
    next(err);
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

router.get('/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const bid = await db('bid_opportunities').where({ id: req.params.id }).first(BID_COLUMNS);
    if (!bid) return res.status(404).json({ error: 'Not found' });
    const emails = await db('bid_opportunity_emails as l')
      .join('emails as e', 'e.id', 'l.email_id')
      .where('l.bid_id', bid.id)
      .orderBy('l.received_at')
      .select('l.email_id', 'l.kind', 'l.received_at', 'e.subject', 'e.from_name', 'e.from_address');
    res.json({ bid: present(bid), emails });
  } catch (err) {
    next(err);
  }
});

router.patch('/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'Not found' });
    const { error, value } = patchSchema.validate(req.body || {});
    if (error) return res.status(400).json({ error: 'Invalid bid update' });
    const bid = await db('bid_opportunities').where({ id: req.params.id }).first(BID_COLUMNS);
    if (!bid) return res.status(404).json({ error: 'Not found' });

    const patch = {};
    let fence = null;
    for (const key of ['job_walk_at', 'questions_due_at']) {
      if (value[key] === undefined) continue;
      const parsed = toInstant(value[key]);
      if (!parsed.ok) return res.status(400).json({ error: `${key} is not a real date` });
      patch[key] = parsed.at;
    }
    if (value.due_at !== undefined) {
      const parsed = toInstant(value.due_at);
      if (!parsed.ok) return res.status(400).json({ error: 'due_at is not a real date' });
      // A date a person typed is the confirmed date. Clearing it un-confirms. Reminders start over for the new date.
      Object.assign(patch, {
        due_at: parsed.at,
        due_confirmed: parsed.at !== null,
        needs_date_confirmation: false,
        reminder_7d_sent_at: null,
        reminder_2d_sent_at: null,
      });
    } else if (value.confirm_due) {
      if (!bid.due_at) return res.status(400).json({ error: 'There is no date to confirm' });
      // Confirm only the bid version the operator looked at: an addendum filed since the page loaded moves
      // updated_at, and the write below is refused. Compared at millisecond precision, the precision the page has.
      if (!value.expected_updated_at) return res.status(409).json({ error: DATE_CHANGED });
      fence = (q) => q.whereRaw("date_trunc('milliseconds', updated_at) = ?::timestamptz", [value.expected_updated_at]);
      Object.assign(patch, { due_confirmed: true, needs_date_confirmation: false });
    }
    if (value.status !== undefined) patch.status = value.status;
    if (value.decision_note !== undefined) patch.decision_note = value.decision_note || null;

    const written = await db('bid_opportunities').where({ id: bid.id }).modify((q) => { if (fence) fence(q); }).update({ ...patch, updated_at: db.fn.now() });
    if (!written) return res.status(409).json({ error: DATE_CHANGED });
    const updated = await db('bid_opportunities').where({ id: bid.id }).first(BID_COLUMNS);
    res.json({ ok: true, bid: present(updated) });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
