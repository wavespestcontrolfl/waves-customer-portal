/**
 * Referral program Step 2: the handwritten thank-you notes (owner 2026-11-20, A1: one note to the member for every
 * friend who books; the note never names the friend). The office reads the list in Referrals → Queue, writes the
 * notes and marks each one written. Nothing here sends anything.
 *
 * A referral owes a note when all of this holds (one test, `owedNotes`, for the list and for the mark):
 *   - the referral was converted under Step 2: thank_you_note_due_at is set. The referral engine stamps it with
 *     the conversion when GATE_REFERRAL_STEP2 is on (conversionSettings), and nothing else writes it. The
 *     conversion is the moment the system records that the friend booked through this member: the office's
 *     Convert, the office's confirm of an inbound referral, or the estimate sweep. It can be later than the day
 *     the friend signed up, so the stamp is "owed since", never "booked on". A conversion under the gate is a
 *     Step 2 referral in every respect (the engine stages it by the Step 2 rules), also when the friend signed up
 *     before the gate went on. A referral converted before the gate never owes a note, whenever it is settled,
 *     and a note owed from a conversion under the gate stays owed if the gate goes off;
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
// The list is a to-do for one person with a pen. One read answers the oldest PAGE_SIZE notes and the total; the
// page asks for a longer list ("Show more"), so a later note is reachable without a mark on an earlier one.
const PAGE_SIZE = 200;

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

// An envelope needs the street, the city, the state and the ZIP. A profile from a lead can hold a state alone
// (the column defaults to FL), so "some line is present" does not mean the note can be mailed.
const addressComplete = (row) => ['address_line1', 'city', 'state', 'zip'].every((part) => clean(row[part]));

// Oldest first, at most `limit` rows, with the count of every note owed (one statement, so the two agree).
async function listThankYouNotes({ limit = PAGE_SIZE } = {}, conn = db) {
  const rows = await owedNotes(conn)
    .join('customers', 'customers.id', 'referrals.referrer_customer_id')
    .orderBy('referrals.thank_you_note_due_at', 'asc')
    .orderBy('referrals.id', 'asc')
    .limit(limit)
    .select(
      'referrals.id', 'referrals.thank_you_note_due_at',
      'customers.id as member_customer_id', 'customers.first_name', 'customers.last_name',
      'customers.address_line1', 'customers.address_line2', 'customers.city', 'customers.state', 'customers.zip',
      conn.raw('count(*) OVER () AS owed_total'),
    );
  const notes = rows.map((row) => ({
    referralId: row.id,
    owedSince: row.thank_you_note_due_at,
    memberCustomerId: row.member_customer_id,
    memberName: [clean(row.first_name), clean(row.last_name)].filter(Boolean).join(' '),
    addressLines: addressLines(row),
    addressComplete: addressComplete(row),
  }));
  return { notes, total: rows.length ? Number(rows[0].owed_total) : 0 };
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

module.exports = { listThankYouNotes, markThankYouNoteWritten, BOOKED_STATUSES, PAGE_SIZE };
