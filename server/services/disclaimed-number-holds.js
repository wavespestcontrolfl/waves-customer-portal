/**
 * Disclaimed-number SMS hold (callback_number_needed, PR #4807 codex
 * round 6 — structural).
 *
 * A caller who says "this number isn't mine" and gives no callback of their
 * own leaves us exactly one number on file that we now KNOW is wrong to
 * text. Rounds 2–6 kept that promise per appointment (scheduled_services.
 * callback_number_hold_at) and each round found another sender the
 * appointment key could not see (estimate/invoice follow-ups text
 * customers.phone with no visit id at all). The invariant is about the
 * DESTINATION NUMBER, so the durable state is a row per (number, call) in
 * disclaimed_number_holds and the one predicate below is checked by
 * sendCustomerMessage for EVERY SMS — at the pipeline and again at the
 * provider boundary — whatever metadata the sender carries.
 *
 * Active = cleared_at IS NULL. Not customer-scoped (see the migration,
 * 20260925000200_disclaimed_number_holds.js): a duplicate/merged customer
 * record or a lead carrying the same ANI must not route around it.
 */
const db = require('../models/db');
const logger = require('./logger');
const { toE164, isLikelyE164 } = require('../utils/phone');

const TABLE = 'disclaimed_number_holds';
const NO_TEXT_LINE_LOCK_PREFIX = 'no_text_line:';

// Marks a no-text hold leaves on an OPEN callback_number_needed card an earlier pass filed:
// no_text_hold (its Resolve must not release this hold) and, when the card did not already carry
// no_text_hold, ownership_disclaimed — that card was filed because the caller said the number is
// not theirs, and "Line can get texts" (which proves only that the line takes SMS) must not clear
// it (codex #6112 r8 P1). The routing-gates stamp writes the same two keys on a dual-signal card.
const NO_TEXT_MARK_SQL = `COALESCE(payload, '{}'::jsonb) || jsonb_build_object(
  'no_text_hold', true,
  'ownership_disclaimed', COALESCE((payload->>'ownership_disclaimed')::boolean, COALESCE(payload->>'no_text_hold', '') <> 'true'))`;
// An open callback_number_needed card that still stands for "that is not my number": filed without
// the no-text mark, or marked while carrying the ownership disclaimer. Only its own Resolve clears it.
const OWNERSHIP_DISCLAIMER_CARD_SQL = `(COALESCE(payload->>'no_text_hold', '') <> 'true' OR COALESCE(payload->>'ownership_disclaimed', '') = 'true')`;

// Canonical key for a hold row / a send's `to`. null for anything that is
// not a dialable number (the send can't reach a disclaimed number with it,
// and a hold on it could never match a real send either).
function holdPhoneKey(raw) {
  if (!raw) return null;
  const e164 = toE164(raw);
  return typeof e164 === 'string' && isLikelyE164(e164) ? e164 : null;
}

// Postgres 42P01: the table does not exist (migration not applied). Nothing
// can ever have been written to a table that isn't there — so, unlike every
// other read error, this one PROVES there is no hold (the same reasoning
// messaging/validators/suppression.js applies to its own table). Treating
// it as "held" would block every SMS in the system for no recorded reason.
function isMissingTable(err) {
  return !!err && (err.code === '42P01' || /relation .*disclaimed_number_holds.* does not exist/i.test(err.message || ''));
}

/**
 * Record (or re-arm) the hold for one disclaimed number from one call.
 * Idempotent per (number, call) on an active row (it only fills
 * customer_id when the earlier write didn't know it). A write against a
 * CLEARED row re-arms it — a stale clearance must never satisfy a freshly
 * raised flag (the round-5 P1 re-arm rule, now on the number row).
 *
 * Round 7 P1: this re-arming write is for the DECISION POINT only, and the
 * processor reaches it through armDisclaimedNumberHold below (serialized
 * with the card resolve under the per-call triage lock). Every LATER write
 * in the same pass uses ensureDisclaimedNumberHold, which never re-arms.
 * Returns { recorded, phoneE164, heldAt } (heldAt = the row's held_at as text, full precision: the arming).
 * Call it under the per-call triage lock AND the line's no-text lock (lockNoTextLines); armDisclaimedNumberHold
 * does. Throws on DB error.
 */
async function recordDisclaimedNumberHold({ phone, customerId = null, callLogId, conn = db }) {
  const phoneE164 = holdPhoneKey(phone);
  if (!phoneE164 || !callLogId) return { recorded: false, reason: phoneE164 ? 'no_call' : 'no_phone' };
  const result = await conn.raw(
    `INSERT INTO ${TABLE} (phone_e164, customer_id, source_call_log_id, held_at)
     VALUES (?, ?, ?, now())
     ON CONFLICT (phone_e164, source_call_log_id) DO UPDATE SET
       customer_id = COALESCE(EXCLUDED.customer_id, ${TABLE}.customer_id),
       held_at = CASE WHEN ${TABLE}.cleared_at IS NULL THEN ${TABLE}.held_at ELSE now() END,
       cleared_at = NULL,
       cleared_by = NULL,
       clear_reason = NULL,
       updated_at = now()
     RETURNING held_at::text AS held_at`,
    [phoneE164, customerId || null, callLogId],
  );
  return { recorded: true, phoneE164, heldAt: result?.rows?.[0]?.held_at ?? null };
}

/**
 * The processor's DECISION-POINT write (codex round 7 P1, PR #4807): the
 * moment a pass raises callback_number_needed, before it publishes the
 * card and before any further awaited work — so no sender (an invoice or
 * estimate follow-up mid-flight) ever sees a window with the flag decided
 * but no row. Runs in its own short transaction under lockTriageCall, the
 * same per-call lock the card's /resolve takes, so a re-arm and a human
 * clearance on this call serialize instead of interleaving. This is the
 * ONE write in a pass that re-arms a cleared row (a genuine reprocess
 * raising the flag again); a later clearance wins over every later write
 * in the pass (ensureDisclaimedNumberHold). Throws on DB error — the
 * processor fails the pass closed.
 *
 * Round 8 P1 — fenced to the processing claim. A superseded worker (its
 * heartbeat failed, the call was reclaimed and completed by a peer, or an
 * operator resolved the card in between) must not arm — or RE-arm over a
 * human clearance — from its stale extraction. With `procToken` (and
 * `procGeneration` when known) the transaction verifies the active claim
 * with `SELECT … FROM call_log WHERE id = ? AND processing_token = ?
 * [AND processing_generation = ?] FOR UPDATE` BEFORE the insert; no match
 * returns { recorded: false, claimLost: true } with nothing written, and the
 * processor abandons the pass exactly like its stillOwnsClaim boundaries.
 * Holding the call_log row lock through the insert means a reclaim's token
 * rotation queues behind this write instead of racing it.
 *
 * LOCK ORDER (same as mintEmailReviewCardsFenced, plus the line lock): per-call triage advisory
 * lock → the line's no-text advisory lock (lockNoTextLines, the one a "Line can get texts" release takes)
 * → call_log row (FOR UPDATE) → disclaimed_number_holds row. /resolve
 * and /verdict take the same advisory lock FIRST, so whatever rows they
 * touch after it (triage_items, scheduled_services, disclaimed_number_holds)
 * are only ever reached by one of the two at a time — no deadlock cycle.
 */
async function armDisclaimedNumberHold({ phone, customerId = null, callLogId, procToken = null, procGeneration = null, noTextHold = false, afterArm = null, conn = db }) {
  if (!callLogId || (!holdPhoneKey(phone) && !afterArm)) return recordDisclaimedNumberHold({ phone, customerId, callLogId, conn });
  // No dialable number (anonymous, restricted or masked ANI) but a companion card write: no hold row,
  // yet the card still goes through the same lock and claim fence below, so a worker that lost its
  // claim during extraction cannot file a stale card after the replacement pass finalized the call
  // (codex #6112 r8 P2).
  const holdable = !!holdPhoneKey(phone);
  const { lockTriageCall } = require('../utils/triage-locks');
  return conn.transaction(async (trx) => {
    await lockTriageCall(trx, callLogId);
    // Lock order step 2, shared with every line release (lockNoTextLines): arming or re-arming a line takes the
    // same phone-wide lock a release holds, so a release of line L that began before this arming cannot clear
    // the hold (and bind a card on) this call writes after it. No row is read or written before it.
    if (holdable) await lockNoTextLines(trx, [holdPhoneKey(phone)]);
    if (procToken) {
      const claim = trx('call_log')
        .where({ id: callLogId })
        .where('processing_token', procToken);
      if (procGeneration != null) claim.where('processing_generation', procGeneration);
      const owned = await claim.forUpdate().first('id');
      if (!owned) return { recorded: false, claimLost: true };
    }
    if (!holdable) {
      if (afterArm) await afterArm(trx, { heldAt: null });
      return { recorded: false, reason: 'no_phone' };
    }
    const recorded = await recordDisclaimedNumberHold({ phone, customerId, callLogId, conn: trx });
    if (noTextHold) {
      // A hold armed because the VALID extraction said the line cannot get texts: mark any callback_number_needed
      // card an earlier pass left open, in this same transaction under the per-call lock, so its Resolve can
      // never release the hold we just armed (it would otherwise carry no marker).
      await trx('triage_items')
        .where({ call_log_id: callLogId, reason_code: 'callback_number_needed' })
        .whereIn('status', ['open', 'in_progress'])
        .update({ payload: trx.raw(NO_TEXT_MARK_SQL) });
      // Re-arming invalidates the version of every text_number_differs card this call already has: an
      // older (closed) card on screen can no longer release what this pass just armed.
      await trx('triage_items')
        .where({ call_log_id: callLogId, reason_code: 'text_number_differs' })
        .update({ updated_at: new Date() });
    }
    // afterArm(trx): the caller's companion write (the text_number_differs release card) in THIS
    // transaction, after the hold row and under the same lock and claim fence, so the hold and the
    // only card that can release it commit or roll back together (codex #6112 r7 P2).
    if (afterArm) await afterArm(trx, { heldAt: recorded.heldAt });
    return recorded;
  });
}

/**
 * Phone-wide lock for a "Line can get texts" release (codex #6112 r15 follow-up). A shared line holds
 * one row per call that said it cannot get texts; a release clears its own call's rows and then every
 * other call's rows on the line. Two staff releasing the same line from cards on different calls took
 * those row locks in opposite orders (A then B, B then A) and could deadlock.
 * Lock order for every line release: 1) the per-call triage lock (lockTriageCall), 2) this phone-wide
 * transaction advisory lock, one per line being released, in sorted E.164 order, 3) hold rows,
 * visit rows. Whoever holds a line's lock is the only releaser of that line, so row locks never cross.
 * Call INSIDE the transaction, before any hold row is written.
 */
async function lockNoTextLines(conn, phoneKeys) {
  for (const key of [...new Set(phoneKeys || [])].sort()) {
    await conn.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`${NO_TEXT_LINE_LOCK_PREFIX}${key}`]);
  }
}

/**
 * The lines a call has a hold row on, newest first, one entry per line: [{ key, active }] (active = a row
 * with cleared_at NULL). A plain read; the caller takes the phone locks next and the writes are idempotent.
 */
async function callLineRows(conn, callLogId) {
  if (!callLogId) return [];
  const rows = await conn(TABLE).where({ source_call_log_id: callLogId }).orderBy('held_at', 'desc').select('phone_e164', 'cleared_at');
  const byKey = new Map();
  for (const row of rows || []) {
    const key = holdPhoneKey(row.phone_e164);
    if (!key) continue;
    const seen = byKey.get(key);
    if (!seen) byKey.set(key, { key, active: row.cleared_at == null });
    else if (row.cleared_at == null) seen.active = true;
  }
  return [...byKey.values()];
}

// ── Card <-> hold binding: exact per (line, arming) ────────────────────────────────────────────────────────
// A hold row is one (line, call) with a held_at that changes each time the hold is re-armed after a release.
// A text_number_differs card releases a hold only if it was filed for THAT line in THAT arming. A call can hold
// several lines but has at most ONE open text card (partial unique index), so the card carries a list:
//   payload.hold_bindings = [{ line_e164, held_at }, ...]
// line_e164 is the hold row's own canonical phone_e164 and held_at its full-precision timestamp as text. The list
// is only ever appended to (stampOpenNoTextCards), one binding per card write: the arming the write is for, and a card
// refresh keeps it (refreshedCardPayload). The card is built BEFORE the hold row gets held_at = now(), so no
// created_at comparison can bind them. A hold released and re-armed has a new held_at, so an older closed card
// stops binding to it.
// A card with no list predates this (filed by #6112). It binds to a hold only when the match is UNAMBIGUOUS:
// the hold is of the same call, on the card's line by the hold writer's own rule (holdPhoneKeySql), armed within
// LEGACY_BINDING_WINDOW of the card's created_at and not after the card closed, and no other unstamped card of
// that call fits the same arming. Anything less stays unbound: it binds to nothing and releases nothing.
// A hold row keeps only its LATEST held_at (a re-arm overwrites it), so armings cannot be counted from the row.
// Two facts survive and rule out a later re-arm: a card cannot belong to an arming that happened after the card
// closed (resolved_at), and two cards cannot both own one arming. scripts/backfill-no-text-card-bindings.js stamps
// the unambiguous cards with exactly this rule and lists the ambiguous ones.
const LEGACY_BINDING_WINDOW = "interval '5 minutes'";

// utils/phone.js holdPhoneKey (toE164 accepted only when isLikelyE164) in SQL, so a legacy card's ani_phone and a
// hold row's phone_e164 compare under the SAME rule the hold writer used. A '+' number keeps its country code and
// needs 10..15 digits; any other input is read as NANP and becomes +1 plus its last ten digits when it has at
// least ten digits; everything else is NULL (not a dialable number, so it can never match a hold). Pinned to the JS
// function over a fixture list by server/tests/no-text-held-lines-postgres.test.js.
const holdPhoneKeySql = (expr) => `(CASE
    WHEN ${expr} IS NULL THEN NULL
    WHEN ${expr} ~ '^\\s*\\+' THEN
      CASE WHEN length(regexp_replace(${expr}, '\\D', '', 'g')) BETWEEN 10 AND 15
           THEN '+' || regexp_replace(${expr}, '\\D', '', 'g') END
    WHEN length(regexp_replace(${expr}, '\\D', '', 'g')) >= 10
      THEN '+1' || right(regexp_replace(${expr}, '\\D', '', 'g'), 10)
    END)`;

// Could unstamped card `c` have been filed for the arming of hold `h`? Time only (same call, window, not closed
// before the arming): the base of both the binding and the ambiguity check.
const legacyCardFitsArmingSql = (c, h) => `${c}.payload->'hold_bindings' IS NULL AND ${c}.reason_code = 'text_number_differs'
  AND ${c}.call_log_id = ${h}.source_call_log_id
  AND ${h}.held_at BETWEEN ${c}.created_at - ${LEGACY_BINDING_WINDOW} AND ${c}.created_at + ${LEGACY_BINDING_WINDOW}
  AND (${c}.resolved_at IS NULL OR ${h}.held_at <= ${c}.resolved_at)`;

// Card `t` (unstamped) is bound to hold `h`: it fits the arming, is on the hold's line, and is the only card ON THAT
// LINE that fits (a card for another line of the same call does not compete: one call can file an X card and a Y card).
const legacyCardBoundSql = (t, h) => `${legacyCardFitsArmingSql(t, h)}
  AND ${holdPhoneKeySql(`${t}.payload->>'ani_phone'`)} = ${h}.phone_e164
  AND NOT EXISTS (SELECT 1 FROM triage_items t2 WHERE t2.id <> ${t}.id AND ${legacyCardFitsArmingSql('t2', h)}
                     AND ${holdPhoneKeySql("t2.payload->>'ani_phone'")} = ${h}.phone_e164)`;

const LEGACY_CARD_FOR_HOLD_SQL = legacyCardBoundSql('t', 'h');

const NO_TEXT_CARD_FOR_HOLD_SQL = `t.call_log_id = h.source_call_log_id AND t.reason_code = 'text_number_differs'
  AND (CASE WHEN t.payload->'hold_bindings' IS NULL THEN (${LEGACY_CARD_FOR_HOLD_SQL})
       ELSE EXISTS (SELECT 1 FROM jsonb_array_elements(t.payload->'hold_bindings') b
                     WHERE b->>'line_e164' = h.phone_e164 AND (b->>'held_at')::timestamptz = h.held_at) END)`;

/**
 * Every (active hold of the call, text card bound to it) pair, newest card first within a line:
 * [{ phone_e164, card_id }]. The one read behind "is this card the current release surface for that line":
 * the held-lines list, the closed-card version check and the lines a release may touch all use the same
 * binding (NO_TEXT_CARD_FOR_HOLD_SQL).
 */
async function boundCardsForActiveHolds(conn, callLogId) {
  const result = await conn.raw(
    `SELECT h.phone_e164, t.id AS card_id FROM ${TABLE} h
       JOIN triage_items t ON ${NO_TEXT_CARD_FOR_HOLD_SQL}
      WHERE h.source_call_log_id = ? AND h.cleared_at IS NULL
      ORDER BY h.phone_e164, t.created_at DESC`,
    [callLogId],
  );
  return result?.rows || [];
}

/**
 * Appends to the call's OPEN text_number_differs card the binding for ONE hold: the arming this card write is
 * for. `phone` is the line the card is filed for; `heldAt` is that arming's held_at (what recordDisclaimedNumberHold
 * returned). Without heldAt the line's current active hold of the call is used. Other active holds of the call
 * (an ownership-only hold on another line) are NOT bound: a card releases only the line it was filed for. A refresh
 * for the same arming appends nothing. Call in the transaction that files or refreshes the card, after the hold row
 * exists, under the per-call lock. Idempotent; never removes or replaces a binding.
 */
async function stampOpenNoTextCards(conn, callLogId, { phone = null, heldAt = null } = {}) {
  const line = holdPhoneKey(phone);
  if (!callLogId || !line) return;
  const armingSql = heldAt ? 'AND h.held_at = ?::timestamptz' : '';
  const params = [line, ...(heldAt ? [heldAt] : []), callLogId];
  await conn.raw(
    `WITH fresh AS (
       SELECT t.id, jsonb_build_array(jsonb_build_object('line_e164', h.phone_e164, 'held_at', h.held_at::text)) AS elems
         FROM triage_items t
         JOIN ${TABLE} h ON h.source_call_log_id = t.call_log_id AND h.cleared_at IS NULL AND h.phone_e164 = ? ${armingSql}
        WHERE t.call_log_id = ? AND t.reason_code = 'text_number_differs' AND t.status IN ('open', 'in_progress')
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(t.payload->'hold_bindings', '[]'::jsonb)) b
                           WHERE b->>'line_e164' = h.phone_e164 AND (b->>'held_at')::timestamptz = h.held_at))
     UPDATE triage_items t
        SET payload = COALESCE(t.payload, '{}'::jsonb)
          || jsonb_build_object('hold_bindings', COALESCE(t.payload->'hold_bindings', '[]'::jsonb) || fresh.elems)
       FROM fresh WHERE t.id = fresh.id`,
    params,
  );
}

/**
 * The payload SQL for refreshing an OPEN card from a newly built one: the new payload, with the card's existing
 * hold_bindings kept (the new payload never carries them). Use as `.update({ payload: refreshedCardPayload(trx, json) })`.
 */
function refreshedCardPayload(conn, payloadJson) {
  return conn.raw(
    `?::jsonb || CASE WHEN payload->'hold_bindings' IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('hold_bindings', payload->'hold_bindings') END`,
    [typeof payloadJson === 'string' ? payloadJson : JSON.stringify(payloadJson)],
  );
}

// True when some ACTIVE hold on the line (alias `x` = the line's phone_e164 expression) belongs to a call with an
// unresolved "not my number" card: a no-text hold, or a call that only disclaimed the number. One predicate for
// the release check and the held-lines list.
const lineOwnershipBlockSql = (lineExpr) => `EXISTS (SELECT 1 FROM ${TABLE} oh
      JOIN triage_items d ON d.call_log_id = oh.source_call_log_id
     WHERE oh.phone_e164 = ${lineExpr} AND oh.cleared_at IS NULL
       AND d.reason_code = 'callback_number_needed' AND d.status <> 'resolved'
       AND ${OWNERSHIP_DISCLAIMER_CARD_SQL.replaceAll('payload', 'd.payload')})`;

/**
 * Which of these lines are blocked by an unresolved "not my number" card on ANY active hold of the line
 * (#6292 r4/r5). "Line can get texts" proves the line takes SMS, never who owns it, so a call with an open
 * ownership card keeps its row and the line as a whole stays blocked. The release asks this of the LINE, never
 * only of the call whose card was clicked.
 */
async function linesBlockedByOwnershipCard(conn, phoneKeys) {
  if (!phoneKeys?.length) return new Set();
  const result = await conn.raw(
    `SELECT DISTINCT h.phone_e164 FROM ${TABLE} h
      WHERE h.phone_e164 IN (${phoneKeys.map(() => '?').join(', ')}) AND h.cleared_at IS NULL
        AND ${lineOwnershipBlockSql('h.phone_e164')}`,
    phoneKeys,
  );
  return new Set((result?.rows || []).map((r) => r.phone_e164));
}

/**
 * "Line can get texts" (admin-triage releaseNoTextHold): the office verified the LINE, so every
 * active hold a no-text statement placed on that number lifts, whichever call placed it (codex
 * #6112 r7 P2: a shared office or relay line gets one hold row per call, and the send boundary
 * blocks on ANY active row for the number). A hold whose source call carries a plain
 * disclaimed-number card (callback_number_needed WITHOUT the no_text_hold marker, or marked
 * ownership_disclaimed) that is still open, in progress or dismissed is an independent "that is not my
 * number" statement and is NOT touched: that card's own Resolve verifies the number. A RESOLVED
 * ownership card already verified it, so that call's no-text hold joins the release (codex r9 P2). Returns the
 * source call ids whose holds cleared, so the caller can lift those calls' visit-level holds too.
 */
async function clearNoTextHoldsForPhone({ phoneE164, exceptCallLogId = null, clearedBy = null, reason, conn = db }) {
  const key = holdPhoneKey(phoneE164);
  if (!key) return [];
  // The exclusion is built only when a call id is given: a bare `? IS NULL` binding has no type
  // Postgres can infer (42P18 rolled the whole release back; codex r9 P1).
  const exceptSql = exceptCallLogId ? 'AND h.source_call_log_id <> ?' : '';
  const params = [clearedBy ? String(clearedBy).slice(0, 100) : null, reason ? String(reason).slice(0, 100) : null, key];
  if (exceptCallLogId) params.push(exceptCallLogId);
  const result = await conn.raw(
    `UPDATE ${TABLE} h
        SET cleared_at = now(),
            cleared_by = ?,
            clear_reason = ?,
            updated_at = now()
      WHERE h.phone_e164 = ?
        AND h.cleared_at IS NULL
        ${exceptSql}
        AND EXISTS (SELECT 1 FROM triage_items t WHERE ${NO_TEXT_CARD_FOR_HOLD_SQL})
        AND NOT EXISTS (SELECT 1 FROM triage_items d
                         WHERE d.call_log_id = h.source_call_log_id AND d.reason_code = 'callback_number_needed'
                           AND d.status <> 'resolved'
                           AND ${OWNERSHIP_DISCLAIMER_CARD_SQL.replaceAll('payload', 'd.payload')})
      RETURNING h.source_call_log_id`,
    params,
  );
  const clearedCalls = (result?.rows || []).map((r) => r.source_call_log_id);
  if (clearedCalls.length) await settleSiblingTextCards(conn, { callLogIds: clearedCalls, lineKey: key, releasedFromCallLogId: exceptCallLogId, clearedBy });
  return clearedCalls;
}

/**
 * Recompute call_log.review_status from the call's cards, safely against a concurrent card write on the same call
 * (#6292 r10). Two resolutions of different cards on one call each count the OTHER card as still open if they count
 * before the other commits, and both write 'open'. A single UPDATE with a correlated subquery does not fix that
 * under READ COMMITTED: the subquery uses the snapshot taken when the statement STARTED, so a statement that then
 * waits on the call_log row lock still counts the committed-meanwhile card as open. So: lock the call_log rows first
 * (sorted ids, one statement), then run the UPDATE as a NEW statement. Its snapshot is taken after the lock was
 * granted, so it sees whatever the previous holder committed, and the last writer always writes the committed truth.
 * Lock order: line lock (if any) -> call_log row; nothing takes a line lock while holding a call_log row.
 */
async function recomputeCallReviewStatus(conn, callLogIds) {
  const ids = [...new Set(callLogIds || [])].filter(Boolean).sort();
  if (!ids.length) return;
  const marks = ids.map(() => '?').join(', ');
  await conn.raw(`SELECT id FROM call_log WHERE id IN (${marks}) ORDER BY id FOR UPDATE`, ids);
  await conn.raw(
    `UPDATE call_log c
        SET review_status = CASE WHEN EXISTS (SELECT 1 FROM triage_items o WHERE o.call_log_id = c.id AND o.status IN ('open', 'in_progress'))
                                 THEN 'open' ELSE 'resolved' END,
            updated_at = now()
      WHERE c.id IN (${marks})`,
    ids,
  );
}

/**
 * The calls whose hold on `lineKey` a cross-call release just cleared (#6292 r8): their text_number_differs card
 * for that line is settled in the same transaction, under the line lock the caller holds.
 *   1. BIND first: a card with no hold_bindings (a legacy card) gets { line_e164, held_at } of the hold being
 *      cleared, so its provenance can never again be re-read from a created_at window (a later ownership-only
 *      re-arm of that call within 5 minutes would otherwise still bind to it).
 *   2. CLOSE the call's open card (resolved, human, note "line released from <masked> via call <id>", resolved_at)
 *      unless the card is still bound to another ACTIVE hold of its call: one card can carry several lines, and
 *      closing it would take the release surface of a line that is still held.
 *   3. Keep call_log.review_status in step with the cards that closed.
 * Cards whose row is locked are skipped (SKIP LOCKED): see the comment in the function body.
 * No per-call lock is taken here (the order is call lock, then line lock; taking a second call's lock under a line
 * lock could cross an arm waiting on that line): every write is a single atomic statement.
 */
async function settleSiblingTextCards(conn, { callLogIds, lineKey, releasedFromCallLogId = null, clearedBy = null }) {
  const ids = callLogIds.map(() => '?').join(', ');
  // Both writes pick their rows with FOR UPDATE SKIP LOCKED (#6292 r9). A transition locks its OWN card row first
  // and takes the line lock after; this function runs under the line lock. Waiting here on a card row that a
  // sibling's transition holds, while that transition waits on the line lock we hold, would deadlock. A card whose
  // row is locked is being transitioned by its owner right now, so it is left alone: the owner's own release then
  // finds the hold already cleared (nothing bound and active, lines_released []) and resolves its own card normally.
  await conn.raw(
    `UPDATE triage_items u
        SET payload = COALESCE(u.payload, '{}'::jsonb)
          || jsonb_build_object('hold_bindings', jsonb_build_array(jsonb_build_object('line_e164', c.line_e164, 'held_at', c.held_at)))
       FROM (SELECT t.id, h.phone_e164 AS line_e164, h.held_at::text AS held_at
               FROM triage_items t JOIN ${TABLE} h ON h.phone_e164 = ? AND h.source_call_log_id IN (${ids})
              WHERE t.payload->'hold_bindings' IS NULL AND (${NO_TEXT_CARD_FOR_HOLD_SQL})
                FOR UPDATE OF t SKIP LOCKED) c
      WHERE u.id = c.id`,
    [lineKey, ...callLogIds],
  );
  const masked = `***${lineKey.slice(-4)}`;
  const note = `line released from ${masked} via call ${releasedFromCallLogId || 'another call'}`.slice(0, 500);
  const closed = await conn.raw(
    `UPDATE triage_items u
        SET status = 'resolved', resolution_source = 'human', resolution_note = ?, assigned_to = ?,
            resolved_at = now(), updated_at = now()
      WHERE u.id IN (
        SELECT t.id FROM triage_items t
         WHERE t.call_log_id IN (${ids}) AND t.reason_code = 'text_number_differs' AND t.status IN ('open', 'in_progress')
           AND EXISTS (SELECT 1 FROM ${TABLE} h
                        WHERE h.phone_e164 = ? AND h.source_call_log_id = t.call_log_id AND (${NO_TEXT_CARD_FOR_HOLD_SQL}))
           AND NOT EXISTS (SELECT 1 FROM ${TABLE} h
                            WHERE h.source_call_log_id = t.call_log_id AND h.cleared_at IS NULL AND (${NO_TEXT_CARD_FOR_HOLD_SQL}))
           FOR UPDATE SKIP LOCKED)
      RETURNING u.call_log_id`,
    [note, clearedBy ? String(clearedBy).slice(0, 100) : null, ...callLogIds, lineKey],
  );
  await recomputeCallReviewStatus(conn, [...new Set((closed?.rows || []).map((r) => r.call_log_id).filter(Boolean))]);
}

/**
 * Every write AFTER the decision point in the same processing pass (the
 * post-customer-resolution write, the booking transaction, the post-commit
 * fallback — codex round 7 P1). Never re-arms: the decision-point write
 * already left this pass's row ACTIVE, so a cleared_at seen here can only
 * be a human clearance that landed after this pass decided, and it must
 * stand (re-arming it would block the number with no open card left to
 * lift it). Inserts when no row exists (defensive — the decision write
 * normally created it) and fills customer_id when this write knows it.
 * Atomic per row (ON CONFLICT takes the row lock the clearance UPDATE
 * takes), so it serializes with a concurrent resolve without needing the
 * advisory lock — which matters inside the booking transaction, where
 * taking the triage lock after row locks could deadlock against /resolve.
 *
 * Returns { recorded, phoneE164, active } — active=false means a human
 * cleared this call's hold after the decision; callers skip re-stamping
 * the visit-level hold for the same reason.
 */
async function ensureDisclaimedNumberHold({ phone, customerId = null, callLogId, conn = db }) {
  const phoneE164 = holdPhoneKey(phone);
  if (!phoneE164 || !callLogId) return { recorded: false, reason: phoneE164 ? 'no_call' : 'no_phone' };
  const result = await conn.raw(
    `INSERT INTO ${TABLE} (phone_e164, customer_id, source_call_log_id, held_at)
     VALUES (?, ?, ?, now())
     ON CONFLICT (phone_e164, source_call_log_id) DO UPDATE SET
       customer_id = COALESCE(EXCLUDED.customer_id, ${TABLE}.customer_id),
       updated_at = now()
     RETURNING cleared_at`,
    [phoneE164, customerId || null, callLogId],
  );
  const row = result?.rows?.[0];
  return { recorded: true, phoneE164, active: !row || row.cleared_at == null };
}

/**
 * Lift every active hold a call placed. Called ONLY for the single-card
 * /resolve (admin-triage.js, clear_reason 'verified_same_number' — the
 * office's explicit word that this same number is safe to text). Closing
 * the card after a REPLACEMENT number (the bulk /verdict) does not come
 * here: that verified the replacement, not this number (round 7 P1). A
 * customer phone edit clears nothing either.
 */
async function clearDisclaimedNumberHoldsForCall({ callLogId, clearedBy = null, reason, phoneKeys = null, conn = db }) {
  if (!callLogId) return 0;
  const now = new Date();
  // phoneKeys: release only these lines of the call (the held-lines panel's selected line); null = every line.
  return conn(TABLE)
    .where({ source_call_log_id: callLogId })
    .whereNull('cleared_at')
    .modify((q) => { if (phoneKeys) q.whereIn('phone_e164', phoneKeys); })
    .update({
      cleared_at: now,
      cleared_by: clearedBy ? String(clearedBy).slice(0, 100) : null,
      clear_reason: reason ? String(reason).slice(0, 100) : null,
      updated_at: now,
    });
}

/**
 * Raw read: true/false, THROWS on a read error (other than a missing
 * table). The two wrappers below decide what an error means.
 */
async function disclaimedNumberHeld(to, conn = db) {
  const phoneE164 = holdPhoneKey(to);
  if (!phoneE164) return false;
  try {
    const row = await conn(TABLE).where({ phone_e164: phoneE164 }).whereNull('cleared_at').first('id');
    return !!row;
  } catch (err) {
    // Inside a caller's transaction the failed statement has already
    // aborted it — rethrow (the wrapper fails closed) rather than claim a
    // clean answer on a poisoned connection.
    if (!conn.isTransaction && isMissingTable(err)) {
      logger.warn('[disclaimed-number-hold] table missing — no hold can exist; not holding');
      return false;
    }
    throw err;
  }
}

/**
 * THE predicate every SMS passes (sendCustomerMessage step 6.45 and its
 * providerPreparationCheck / withSmsHandoff rechecks). FAILS CLOSED: this
 * decides whether we may text a number at all, so an unreadable answer is
 * "held", never "safe" — the send comes back retryable (and senders with an
 * email leg fall back to it), so a blip costs a delayed text, never a text
 * to a number the caller disclaimed.
 */
async function disclaimedNumberBlocksSend({ to, conn = db } = {}) {
  try {
    return await disclaimedNumberHeld(to, conn);
  } catch (err) {
    logger.warn(`[disclaimed-number-hold] read failed — failing CLOSED (treating as held): ${err.code || err.name || 'db_error'}`);
    return true;
  }
}

/**
 * Visit-level read for the PRE-checks (appointment-reminders.js's
 * callbackNumberHoldActiveForVisit / ...ConfirmedForVisit, which decide up
 * front to route a visit's notice to email instead of attempting SMS): is
 * the phone on file for the customer(s) of this visit an actively held
 * number? Same rows as the send predicate, so the pre-check and the
 * boundary can never disagree about a number — and nothing here reads a
 * per-visit hold column, so a terminal member kept in a frozen visit group
 * cannot strand its live siblings (round-6 P2).
 *
 * Accepts a bare scheduledServiceId or { scheduledServiceId, visitId }.
 * Every member of a grouped occurrence is resolved (a pre-existing sibling
 * can be the notification owner). A caller that already resolved visitId —
 * even to null, "confirmed ungrouped" — passes the key and it is trusted;
 * a caller with no visitId KEY at all gets it resolved from the row
 * (round-3 finding #4: a plain `undefined` never reads as "no group").
 * No visit context at all → false. THROWS on a read error — both callers
 * map that to their own posture (fail-closed boolean vs. tri-state null).
 */
async function disclaimedNumberHeldForVisit(idsOrScheduledServiceId, conn = db) {
  const isPlainId = typeof idsOrScheduledServiceId === 'string' || idsOrScheduledServiceId == null;
  const scheduledServiceId = isPlainId ? idsOrScheduledServiceId : idsOrScheduledServiceId.scheduledServiceId;
  const visitIdSupplied = !isPlainId && Object.prototype.hasOwnProperty.call(idsOrScheduledServiceId, 'visitId');
  let visitId = visitIdSupplied ? idsOrScheduledServiceId.visitId : null;
  if (!scheduledServiceId && !visitId) return false;
  if (!visitIdSupplied && scheduledServiceId) {
    const owner = await conn('scheduled_services').where({ id: scheduledServiceId }).first('visit_id');
    visitId = owner?.visit_id || null;
  }
  const rows = await conn('scheduled_services')
    .where(function idOrVisitId() {
      if (scheduledServiceId) this.orWhere('id', scheduledServiceId);
      if (visitId) this.orWhere('visit_id', visitId);
    })
    .select('customer_id');
  const customerIds = [...new Set(rows.map((row) => row.customer_id).filter(Boolean))];
  if (!customerIds.length) return false;
  const customers = await conn('customers').whereIn('id', customerIds).select('phone');
  const phones = [...new Set(customers.map((c) => holdPhoneKey(c.phone)).filter(Boolean))];
  for (const phone of phones) {
    if (await disclaimedNumberHeld(phone, conn)) return true;
  }
  return false;
}

/**
 * VISIT evidence for the card-request email-only path (codex round 8 P1,
 * PR #4807). disclaimedNumberHeldForVisit answers "is the number we would
 * text for this visit held by ANY call?" — right for an SMS pre-check, but
 * not proof that THIS visit's delivery:'none' came from a
 * callback_number_needed hold. A visit suppressed for a different reason
 * (no SMS consent) whose customer happens to share a number another call
 * disclaimed must stay silent, not mint a /secure token and email a card
 * invitation. True only when BOTH hold:
 *   - the visit carries the processor's audit stamp for this hold
 *     (callback_number_hold_at set, and no later call-level clearance:
 *     call_sms_cleared_at is null or older than the stamp) — it was booked
 *     under callback_number_needed; and
 *   - the visit's OWN source call has an ACTIVE hold row on the phone
 *     currently on file for the visit's customer — the number the visit's
 *     SMS leg would use is the one that call disclaimed.
 * Plain scheduledServiceId or { scheduledServiceId }. THROWS on a read
 * error (the caller maps it to "not confirmed").
 */
async function disclaimedNumberHoldEvidenceForVisit(idsOrScheduledServiceId, conn = db) {
  const scheduledServiceId = typeof idsOrScheduledServiceId === 'string'
    ? idsOrScheduledServiceId
    : idsOrScheduledServiceId?.scheduledServiceId;
  if (!scheduledServiceId) return false;
  const visit = await conn('scheduled_services')
    .where({ id: scheduledServiceId })
    .first('customer_id', 'source_call_log_id', 'callback_number_hold_at', 'call_sms_cleared_at');
  if (!visit || !visit.customer_id || !visit.source_call_log_id || !visit.callback_number_hold_at) return false;
  const heldAt = new Date(visit.callback_number_hold_at).getTime();
  if (visit.call_sms_cleared_at && new Date(visit.call_sms_cleared_at).getTime() >= heldAt) return false;
  const customer = await conn('customers').where({ id: visit.customer_id }).first('phone');
  const phoneE164 = holdPhoneKey(customer?.phone);
  if (!phoneE164) return false;
  const row = await conn(TABLE)
    .where({ phone_e164: phoneE164, source_call_log_id: visit.source_call_log_id })
    .whereNull('cleared_at')
    .first('id');
  return !!row;
}

module.exports = {
  holdPhoneKey,
  disclaimedNumberHoldEvidenceForVisit,
  recordDisclaimedNumberHold,
  armDisclaimedNumberHold,
  ensureDisclaimedNumberHold,
  clearDisclaimedNumberHoldsForCall,
  clearNoTextHoldsForPhone,
  lockNoTextLines,
  linesBlockedByOwnershipCard,
  lineOwnershipBlockSql,
  stampOpenNoTextCards,
  recomputeCallReviewStatus,
  boundCardsForActiveHolds,
  refreshedCardPayload,
  holdPhoneKeySql,
  legacyCardFitsArmingSql,
  legacyCardBoundSql,
  LEGACY_CARD_FOR_HOLD_SQL,
  LEGACY_BINDING_WINDOW,
  NO_TEXT_CARD_FOR_HOLD_SQL,
  callLineRows,
  NO_TEXT_LINE_LOCK_PREFIX,
  NO_TEXT_MARK_SQL,
  OWNERSHIP_DISCLAIMER_CARD_SQL,
  disclaimedNumberHeld,
  disclaimedNumberBlocksSend,
  disclaimedNumberHeldForVisit,
  TABLE,
};
