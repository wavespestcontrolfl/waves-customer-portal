/**
 * Referral program Step 2: the handwritten thank-you notes (owner 2026-11-20, A1: one note to the member for every
 * friend who books; the note never names the friend). The office reads the list in Referrals → Queue, writes the
 * notes and marks each one written. Nothing here sends anything.
 *
 * A referral owes a note when all of this holds (one test, `owedNotes`, for the list and for the mark):
 *   - the friend booked under Step 2: thank_you_note_due_at is set. The referral engine stamps it with the
 *     conversion when GATE_REFERRAL_STEP2 is on (conversionSettings), and nothing else writes it. So the note
 *     follows the booking: a referral booked before Step 2 never owes one, whenever it is settled, and a note owed
 *     from a booking under the gate stays owed if the gate goes off;
 *   - the booking stands: the status is signed_up or credited. A referral the office rejected afterwards owes none;
 *   - the office has not marked it written (thank_you_note_at is null);
 *   - the member's account is not archived.
 * The settlement plays no part. A member at the yearly limit is owed the note like any other (that member gets no
 * credit, and the Refer tab promises: "We still send a thank-you note for every friend who books."). Two members
 * who referred the same friend each booked a referral and are each owed a note, also the one whose referral the
 * settlement later retires (reward status 'superseded', status still signed_up): that member sent us the friend
 * too and gets no credit.
 *
 * The friend's name, phone and email are never read here, so they cannot reach the list.
 */
const db = require('../models/db');

const BOOKED_STATUSES = ['signed_up', 'credited'];
// The list is a to-do for one person with a pen; a longer backlog than this is read oldest first, in parts.
const LIST_LIMIT = 200;

function owedNotes(conn) {
  return conn('referrals')
    .whereNotNull('referrals.thank_you_note_due_at')
    .whereIn('referrals.status', BOOKED_STATUSES)
    .whereNull('referrals.thank_you_note_at')
    .whereExists(function activeMember() {
      this.select(conn.raw('1')).from('customers as member')
        .whereRaw('member.id = referrals.referrer_customer_id')
        .whereNull('member.deleted_at');
    });
}

const clean = (value) => String(value ?? '').trim();

// The member's mailing lines as they go on an envelope; an empty part leaves no gap and no stray comma.
function addressLines(row) {
  const cityLine = [clean(row.city), [clean(row.state), clean(row.zip)].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [clean(row.address_line1), clean(row.address_line2), cityLine].filter(Boolean);
}

// Oldest booking first, at most LIST_LIMIT rows: the page reads the list again after every answer to a mark, so
// the rows past the limit come up as the first ones are written.
async function listThankYouNotes(conn = db) {
  const rows = await owedNotes(conn)
    .join('customers', 'customers.id', 'referrals.referrer_customer_id')
    .orderBy('referrals.thank_you_note_due_at', 'asc')
    .orderBy('referrals.id', 'asc')
    .limit(LIST_LIMIT)
    .select(
      'referrals.id', 'referrals.thank_you_note_due_at',
      'customers.first_name', 'customers.last_name',
      'customers.address_line1', 'customers.address_line2', 'customers.city', 'customers.state', 'customers.zip',
    );
  return rows.map((row) => ({
    referralId: row.id,
    bookedAt: row.thank_you_note_due_at,
    memberName: [clean(row.first_name), clean(row.last_name)].filter(Boolean).join(' '),
    addressLines: addressLines(row),
  }));
}

// The office wrote the note. One UPDATE tests and stamps, so a referral that stopped owing a note after the list
// was read (rejected, or its member archived) is refused and not stamped. The first mark stands: a second tap (a
// second tab, a slow connection) answers the same and changes neither the time nor the login.
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
