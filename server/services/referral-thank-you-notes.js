/**
 * Referral program Step 2: the handwritten thank-you notes (owner 2026-11-20, A1: one note to the member for every
 * friend who books; the note never names the friend). The office reads the list in Referrals → Queue, writes the
 * notes and marks each one written. Nothing here sends anything.
 *
 * A referral owes a note when all of this holds:
 *   - the friend booked: converted_at is set and the status is signed_up or credited (a referral the office
 *     rejected afterwards owes none), and the row is not a retired duplicate (reward status 'superseded': another
 *     member's referral for the same friend earned). This is the dashboards' own test for a converted referral
 *     (referral-engine getProgramAnalytics);
 *   - the Step 2 rules apply to it: referrer_reward_reason is set. A conversion with GATE_REFERRAL_STEP2 on writes
 *     'staged' (referral-engine conversionSettings) and a Step 2 settlement writes the final reason. So no row
 *     from before Step 2 enters the list, and a row booked while the gate was on stays on it if the gate goes off;
 *   - the office has not marked it written (thank_you_note_at is null).
 * A member at the yearly limit is on the list too: that member gets no credit, and the note is what the Refer tab
 * promises ("We still send a thank-you note for every friend who books.").
 *
 * The friend's name, phone and email are never read here, so they cannot reach the list.
 */
const db = require('../models/db');

const BOOKED_STATUSES = ['signed_up', 'credited'];
// The list is a to-do for one person with a pen; a longer backlog than this is read oldest first, in parts.
const LIST_LIMIT = 200;

function owedNotes(conn) {
  return conn('referrals')
    .whereNotNull('referrals.converted_at')
    .whereNotNull('referrals.referrer_reward_reason')
    .whereIn('referrals.status', BOOKED_STATUSES)
    .whereRaw("referrals.referrer_reward_status IS DISTINCT FROM 'superseded'")
    .whereNull('referrals.thank_you_note_at');
}

const clean = (value) => String(value ?? '').trim();

// The member's mailing lines as they go on an envelope; an empty part leaves no gap and no stray comma.
function addressLines(row) {
  const cityLine = [clean(row.city), [clean(row.state), clean(row.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [clean(row.address_line1), clean(row.address_line2), cityLine].filter(Boolean);
}

// Oldest booking first. A member whose account is archived is left out.
async function listThankYouNotes(conn = db) {
  const rows = await owedNotes(conn)
    .join('customers', 'customers.id', 'referrals.referrer_customer_id')
    .whereNull('customers.deleted_at')
    .orderBy('referrals.converted_at', 'asc')
    .orderBy('referrals.id', 'asc')
    .limit(LIST_LIMIT)
    .select(
      'referrals.id', 'referrals.converted_at',
      'customers.first_name', 'customers.last_name',
      'customers.address_line1', 'customers.address_line2', 'customers.city', 'customers.state', 'customers.zip',
    );
  return rows.map((row) => ({
    referralId: row.id,
    bookedAt: row.converted_at,
    memberName: [clean(row.first_name), clean(row.last_name)].filter(Boolean).join(' '),
    addressLines: addressLines(row),
  }));
}

// The office wrote the note. The first mark stands: a second tap (a second tab, a slow connection) answers the
// same and changes neither the time nor the name.
async function markThankYouNoteWritten({ referralId, writtenBy = null }, conn = db) {
  const marked = await owedNotes(conn).where('referrals.id', referralId)
    .update({ thank_you_note_at: conn.fn.now(), thank_you_note_by: writtenBy });
  if (marked) return { written: true };
  const row = await conn('referrals').where({ id: referralId }).first('thank_you_note_at');
  if (row?.thank_you_note_at) return { written: true };
  const err = new Error('This referral has no thank-you note to write');
  err.statusCode = 404;
  err.code = 'NO_NOTE_OWED';
  throw err;
}

module.exports = { listThankYouNotes, markThankYouNoteWritten, BOOKED_STATUSES, LIST_LIMIT };
