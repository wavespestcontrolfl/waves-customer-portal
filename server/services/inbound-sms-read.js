/**
 * The ONE writer for "a human read inbound SMS" — used by the Communications
 * thread read, the dashboard inbox open/quick-reply, and anything else that
 * marks inbound texts read. A read is not just messages.is_read: it mirrors
 * the legacy sms_log row, strips any backlog-reset marker (so the reset's
 * rollback never reopens what a human looked at), and clears the thread's
 * inbound_sms bells through NotificationService when nothing unread remains.
 *
 *   markInboundSmsRead({ messageIds, conversationIds, readBefore, adminUserId, role })
 *     -> { updated, notificationsCleared }
 *
 * conversationIds require readBefore (the caller's request boundary) so an
 * SMS landing mid-request stays unread. Bell clearing is bounded by `now` at
 * entry and only for customers with no unread inbound row left (unified AND
 * recent legacy-only rows).
 */
const db = require('../models/db');
const logger = require('./logger');
const NotificationService = require('./notification-service');

const LEGACY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// The ONE decision for "what should this sender's shared unlinked-style bell
// (link='/admin/communications', no thread param) do right now" — retarget
// to whatever's still unread, or clear if nothing is. Used both by
// markInboundSmsRead's own by-SID read path below AND by twilio-webhook.js's
// ringSmsReplyBell post-insert race check (codex #4210 round-3 P1): that
// check used to clear the just-rung bell by bare SID when the thread was
// read while the bell was still being written, which — for an unknown
// sender whose bell is phone-shared, not per-message — could clear the only
// bell while a throttled sibling message sat unread with no bell of its own.
// `cutoff` is the caller's own request-entry timestamp (bounds which bells
// are eligible to be touched at all — see the comment on the query below);
// callers that have no broader "read" request in flight (the post-insert
// race check) pass `new Date()` so the bell they just wrote is in scope.
async function retargetOrClearUnknownSenderBell(phone, cutoff) {
  if (!phone) return 0;
  try {
    return await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '2s'");
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`inbound_sms_bell_retarget:${phone}`]);
      // Resolved against COALESCE(sms_log.from_phone, contact_phone):
      // sms_log.from_phone is the durable sender identity (recorded at the
      // moment the text arrived) — unlike conversations.contact_phone,
      // which promoteUnknownPhoneThreadWith NULLs on every message's
      // conversation the instant it promotes or merges an unknown thread
      // (services/conversations.js). A phone-scoped join through the
      // conversation alone finds nothing at all for a message that has
      // since been promoted — stranding the bell rather than protecting it
      // (codex #4210 round-5 P1). contact_phone stays the fallback for a
      // message whose sms_log twin is somehow missing.
      const remaining = await trx('messages as m')
        .join('conversations as c', 'c.id', 'm.conversation_id')
        .leftJoin('sms_log as l', function join() {
          this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
        })
        .where({ 'm.channel': 'sms', 'm.direction': 'inbound' })
        .whereRaw('COALESCE(l.from_phone, c.contact_phone) = ?', [phone])
        // Phone-wide, not customer_id-gated (codex #4210 round-2 P2): a
        // promoted thread's still-unread sibling must still be found here
        // so the shared unlinked-style bell retargets to it instead of
        // being cleared with it left silently unread.
        .andWhere(function unread() { this.where({ 'm.is_read': false }).orWhereNull('m.is_read'); })
        .whereNotNull('m.twilio_sid')
        .orderBy('m.created_at', 'asc')
        .first('m.twilio_sid');
      // Match the LIVE bell by what it currently rang for, not by the
      // SID(s) the caller happened to read — those may differ from the SID
      // the bell is actually keyed to. Scoped to the unlinked-style link so
      // a promoted thread's now-customer-scoped bell (a different
      // notification row, keyed by ?thread=) is never touched here.
      // Bounded by the caller's cutoff (codex #4210 round-2 P1) — a bell
      // created by a NEW inbound message the caller never saw as unread
      // must never be touched. `cutoff` is a JS Date (millisecond
      // precision); created_at is a Postgres timestamptz (microsecond
      // precision) written by a statement that can land microseconds into
      // the SAME millisecond `cutoff` was captured in — a strict `<=`
      // against the truncated JS value would then reject a bell that is,
      // in reality, no later than the cutoff. Compare against the NEXT
      // millisecond boundary so same-millisecond writes (the realistic gap
      // between an insert and the read/check that follows it) still count
      // as "at or before", while a bell from a genuinely later request
      // (materially more than a fraction of a millisecond away in
      // practice) is still excluded.
      const bellCutoff = new Date(cutoff.getTime() + 1);
      const liveBell = () => trx('notifications')
        .where({ recipient_type: 'admin', category: 'inbound_sms', link: '/admin/communications' })
        .whereNull('read_at')
        .where('created_at', '<', bellCutoff)
        .whereRaw(
          `metadata->'payload'->>'twilioSid' IN (
            SELECT m2.twilio_sid FROM messages m2
            JOIN conversations c2 ON c2.id = m2.conversation_id
            LEFT JOIN sms_log l2 ON l2.twilio_sid = m2.twilio_sid AND l2.direction = 'inbound'
            WHERE COALESCE(l2.from_phone, c2.contact_phone) = ?
          )`,
          [phone],
        );
      if (remaining?.twilio_sid) {
        await liveBell().update({ metadata: trx.raw("jsonb_set(metadata, '{payload,twilioSid}', to_jsonb(?::text))", [remaining.twilio_sid]) });
        return 0;
      }
      return liveBell().update({ read_at: new Date() });
    });
  } catch (e) {
    logger.warn(`[inbound-sms-read] unknown-sender bell retarget failed for one sender: ${e.message}`);
    return 0;
  }
}

async function markInboundSmsRead({ messageIds = [], conversationIds = [], readBefore = null, adminUserId = null, role } = {}) {
  const ids = messageIds.filter((id) => typeof id === 'string' && id.trim());
  const convs = conversationIds.filter((id) => typeof id === 'string' && id.trim());
  if (!ids.length && !convs.length) return { updated: 0, notificationsCleared: 0 };
  if (convs.length && !(readBefore instanceof Date && !Number.isNaN(readBefore.getTime()))) {
    throw new Error('readBefore required when marking a conversation read');
  }
  const now = new Date();
  const scope = function scope() {
    if (ids.length) this.whereIn('id', ids);
    if (convs.length) this.orWhere(function conv() { this.whereIn('conversation_id', convs).where('created_at', '<=', readBefore); });
  };

  // 1. Strip backlog-reset markers across the request scope regardless of
  //    read state (rows the reset already read are exactly the ones a human
  //    is now looking at), on messages, legacy twins, and the thread's bells.
  try {
    const marked = () => db('messages').where({ channel: 'sms', direction: 'inbound' })
      .whereRaw("jsonb_exists(COALESCE(metadata,'{}'::jsonb), 'backlog_reset')").andWhere(scope);
    const markedSids = (await marked().whereNotNull('twilio_sid').pluck('twilio_sid')).filter(Boolean);
    await marked().update({ metadata: db.raw("metadata - 'backlog_reset'") });
    if (markedSids.length) {
      await db('sms_log').whereIn('twilio_sid', markedSids)
        .whereRaw("jsonb_exists(COALESCE(metadata,'{}'::jsonb), 'backlog_reset')")
        .update({ metadata: db.raw("metadata - 'backlog_reset'") });
    }
    const custs = await customerIdsInScope(ids, convs);
    if (custs.length) {
      await db('notifications').where({ category: 'inbound_sms' })
        .whereIn('link', custs.map((cid) => `/admin/communications?thread=${cid}`))
        .whereRaw("jsonb_exists(COALESCE(metadata,'{}'::jsonb), 'backlog_reset')")
        .update({ metadata: db.raw("metadata - 'backlog_reset'") });
    }
  } catch (e) { logger.warn(`[inbound-sms-read] backlog-reset marker clear failed: ${e.message}`); }

  // 2. The read itself (+ legacy mirror by twilio_sid).
  const q = () => db('messages').where({ channel: 'sms', direction: 'inbound' })
    .andWhere(function unreadOnly() { this.where({ is_read: false }).orWhereNull('is_read'); })
    .andWhere(scope);
  const mirrorSids = (await q().whereNotNull('twilio_sid').pluck('twilio_sid')).filter(Boolean);
  const updated = await q().update({ is_read: true, read_at: now, read_by_admin_user_id: adminUserId || null, updated_at: now });
  if (mirrorSids.length) {
    try {
      await db('sms_log').where({ direction: 'inbound' }).whereIn('twilio_sid', mirrorSids)
        .andWhere(function unread() { this.where({ is_read: false }).orWhereNull('is_read'); })
        .update({ is_read: true });
    } catch (e) { logger.warn(`[inbound-sms-read] sms_log read mirror failed: ${e.message}`); }
  }

  // 3. Bell cross-clear — only threads with nothing unread left, bells that
  //    existed at entry, through the notification service.
  let notificationsCleared = 0;
  // 3a. By message SID first: an unknown-sender thread has no customer_id,
  //     so the customer-scoped clear below can never reach its bells; the
  //     bell carries the SID it rang for (codex #4210 P2).
  const unknownSenderSids = new Set();
  if (mirrorSids.length) {
    try {
      // An unknown-sender thread has no customer_id, so the customer-scoped
      // nothing-left-unread clear below can never reach its bell — it only
      // carries the SID it rang for (codex #4210 P2). The throttle rings
      // once per 4h window, so a single-message read of exactly that
      // alerted SID must not clear the bell while a later throttled message
      // from the SAME sender is still unread; it must hand the bell to that
      // later SID instead. Scoped by contact_phone, not conversation_id or
      // "the SID this call happened to read": the throttle/claim is keyed
      // on the raw sender phone across every conversation it owns (one per
      // our_endpoint_id it has texted — pre-push audit P1), and the decision
      // of what to do with the bell must be made fresh from ITS CURRENT
      // target, not from an assumption that this call owns that target —
      // two concurrent reads of a sender's two messages otherwise strand
      // the bell: whichever read did NOT originally own the alerted SID can
      // never match it to clear it, so if a hand-off lands after that read
      // already ran, nothing ever clears the bell again (pre-push audit
      // P1, second round). A short-lived per-phone advisory lock (bounded
      // by lock_timeout, releases on rollback; scoped to a few fast DB
      // statements with no notification dispatch inside it, so holding it
      // is cheap) makes every read for the same sender go through ONE
      // retarget-or-clear decision instead of splitting it across two
      // independent code paths.
      // Resolve every read SID's durable phone (see retargetOrClearUnknownSenderBell
      // for why sms_log.from_phone, not contact_phone, is the source of truth
      // once a thread is promoted).
      const candidateRows = await db('messages as m')
        .join('conversations as c', 'c.id', 'm.conversation_id')
        .leftJoin('sms_log as l', function join() {
          this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
        })
        .whereIn('m.twilio_sid', mirrorSids)
        .select('m.twilio_sid', 'c.customer_id', db.raw('COALESCE(l.from_phone, c.contact_phone) as contact_phone'));
      // Which of those phones currently own a live unlinked-style bell
      // (link='/admin/communications', unread) — resolved by PHONE, not by
      // "is this exact SID the bell's current target" (codex #4210
      // round-7 P1). The target-SID check used here through round 6 was a
      // TOCTOU race for a promoted thread with two unread siblings: reading
      // them as two concurrent calls, whichever call's SID the bell did NOT
      // currently target failed this membership check (evaluated outside
      // any lock) and fell to the by-SID clear/no-op, while the OTHER call
      // retargeted the bell onto it under the phone lock — the retarget
      // landing after the membership check already missed it permanently
      // orphans the bell on an already-read message nothing revisits.
      // Resolving by phone is stable regardless of which SID the bell
      // happens to target at the instant this runs: a promoted phone with
      // an active bell always routes ALL of its scoped SIDs through the
      // phone lock, so the retarget-or-clear decision — not this
      // membership check — is what's left to serialize, and the lock
      // already does that.
      const phonesWithLiveBell = new Set();
      const candidatePhones = [...new Set(candidateRows.map((r) => r.contact_phone).filter(Boolean))];
      if (candidatePhones.length) {
        const liveBellRows = await db('notifications')
          .where({ recipient_type: 'admin', category: 'inbound_sms', link: '/admin/communications' })
          .whereNull('read_at')
          .select(db.raw("metadata->'payload'->>'twilioSid' as sid"));
        const liveBellSids = liveBellRows.map((r) => r.sid).filter(Boolean);
        if (liveBellSids.length) {
          const rows = await db('messages as m')
            .join('conversations as c', 'c.id', 'm.conversation_id')
            .leftJoin('sms_log as l', function join() {
              this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
            })
            .whereIn('m.twilio_sid', liveBellSids)
            .select(db.raw('COALESCE(l.from_phone, c.contact_phone) as contact_phone'));
          for (const row of rows) { if (row.contact_phone) phonesWithLiveBell.add(row.contact_phone); }
        }
      }
      const phones = new Set();
      for (const row of candidateRows) {
        // Still unlinked (the ordinary case) OR promoted but this phone
        // owns a live unlinked bell right now.
        const isUnknownSenderScoped = row.customer_id === null
          || (row.contact_phone && phonesWithLiveBell.has(row.contact_phone));
        if (isUnknownSenderScoped) {
          unknownSenderSids.add(row.twilio_sid);
          if (row.contact_phone) phones.add(row.contact_phone);
        }
      }
      for (const phone of phones) {
        notificationsCleared += await retargetOrClearUnknownSenderBell(phone, now);
      }
    } catch (e) { logger.warn(`[inbound-sms-read] unknown-sender bell retarget failed: ${e.message}`); }
    // The unknown-sender SIDs above are fully handled (retargeted or
    // cleared) inside the per-phone lock; only known-customer SIDs still
    // need the ordinary by-SID clear.
    const knownSids = mirrorSids.filter((sid) => !unknownSenderSids.has(sid));
    if (knownSids.length) {
      try {
        notificationsCleared += await NotificationService.markInboundSmsReadAdmin({ twilioSids: knownSids, before: now, role });
      } catch (e) { logger.warn(`[inbound-sms-read] bell clear by sid failed: ${e.message}`); }
    }
  }
  try {
    const convIds = new Set(convs);
    if (ids.length) {
      for (const r of await db('messages').whereIn('id', ids).whereNotNull('conversation_id').distinct('conversation_id')) convIds.add(r.conversation_id);
    }
    if (convIds.size) {
      const threads = await db('conversations as cv')
        .whereIn('cv.id', [...convIds]).whereNotNull('cv.customer_id')
        .whereNotExists(function stillUnread() {
          this.select(1).from('messages as m').join('conversations as c2', 'c2.id', 'm.conversation_id')
            .whereRaw('c2.customer_id = cv.customer_id').where({ 'm.channel': 'sms', 'm.direction': 'inbound' })
            .andWhere(function unread() { this.where({ 'm.is_read': false }).orWhereNull('m.is_read'); });
        })
        // legacy-ONLY (no unified twin) and recent — historical rows were
        // initialized unread and never mirrored
        .whereNotExists(function stillUnreadLegacy() {
          this.select(1).from('sms_log as l').whereRaw('l.customer_id = cv.customer_id').where({ 'l.direction': 'inbound' })
            .where('l.created_at', '>', new Date(Date.now() - LEGACY_WINDOW_MS))
            .andWhere(function unread() { this.where({ 'l.is_read': false }).orWhereNull('l.is_read'); })
            .whereNotExists(function hasTwin() { this.select(1).from('messages as mm').whereRaw('mm.twilio_sid = l.twilio_sid').where({ 'mm.channel': 'sms' }); });
        })
        .distinct('cv.customer_id');
      for (const t of threads) {
        notificationsCleared += await NotificationService.markInboundSmsReadAdmin({ customerId: t.customer_id, before: now, role });
      }
    }
  } catch (e) { logger.warn(`[inbound-sms-read] bell cross-clear failed: ${e.message}`); }

  return { updated, notificationsCleared };
}

// The Messages badge's number: contact-phone threads holding an unread inbound
// SMS. CommunicationsPageV2.smsThreadKey groups across business numbers using
// the last 10 digits (or "unknown"); /log prefers contact_phone to customer.phone.
// Count that same identity across every conversation. Internal
// admin-phone traffic is excluded exactly as the inbox log excludes it
// (`excludePhones` = the router's ADMIN_PHONES).
async function countUnreadInboundSms({ excludePhones = [], customerId = null } = {}) {
  let q = db('messages')
    .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
    .leftJoin('customers', 'conversations.customer_id', 'customers.id')
    .where('messages.channel', 'sms')
    .where('messages.direction', 'inbound')
    .andWhere(function unread() { this.where({ 'messages.is_read': false }).orWhereNull('messages.is_read'); });
  if (customerId) q = q.where('conversations.customer_id', customerId);
  // A blocked number's existing thread must not keep the badge lit: "Mark
  // spam" in the inbox blocks the sender and the thread stops counting.
  // NANP blocks match on the same last-10 identity the COUNT below groups
  // on; any other country code must match in full (utils/phone.js keeps
  // international numbers whole — codex #4213).
  q = q.whereNotExists(function blocked() {
    this.select(db.raw('1')).from('blocked_numbers')
      .whereRaw(`(
        (regexp_replace(COALESCE(blocked_numbers.number, ''), '[^0-9]', '', 'g') ~ '^1[0-9]{10}$'
          AND regexp_replace(COALESCE(NULLIF(conversations.contact_phone, ''), customers.phone, ''), '[^0-9]', '', 'g') ~ '^1{0,1}[0-9]{10}$'
          AND (COALESCE(NULLIF(conversations.contact_phone, ''), customers.phone, '') NOT LIKE '+%'
            OR COALESCE(NULLIF(conversations.contact_phone, ''), customers.phone, '') LIKE '+1%')
          AND RIGHT(regexp_replace(COALESCE(blocked_numbers.number, ''), '[^0-9]', '', 'g'), 10)
            = RIGHT(regexp_replace(COALESCE(NULLIF(conversations.contact_phone, ''), customers.phone, ''), '[^0-9]', '', 'g'), 10))
        OR NULLIF(regexp_replace(COALESCE(blocked_numbers.number, ''), '[^0-9]', '', 'g'), '')
            = regexp_replace(COALESCE(NULLIF(conversations.contact_phone, ''), customers.phone, ''), '[^0-9]', '', 'g')
      )`);
  });
  for (const phone of excludePhones) {
    q = q
      .whereNot('conversations.our_endpoint_id', phone)
      .where((b) => b.whereNot('conversations.contact_phone', phone).orWhereNull('conversations.contact_phone'))
      .where((b) => b.whereNot('customers.phone', phone).orWhereNull('customers.phone'));
  }
  const row = await q.first(
    db.raw(`COUNT(DISTINCT COALESCE(NULLIF(
      CASE WHEN COALESCE(NULLIF(conversations.contact_phone, ''), customers.phone, '') NOT LIKE '+%'
        AND regexp_replace(COALESCE(NULLIF(conversations.contact_phone, ''), customers.phone, ''), '[^0-9]', '', 'g') ~ '^[0-9]{10}$'
      THEN '1' || regexp_replace(COALESCE(NULLIF(conversations.contact_phone, ''), customers.phone, ''), '[^0-9]', '', 'g')
      ELSE regexp_replace(COALESCE(NULLIF(conversations.contact_phone, ''), customers.phone, ''), '[^0-9]', '', 'g')
      END, ''), 'unknown'))::int AS conversations`),
    db.raw('COUNT(*)::int AS messages'),
  );
  return { conversations: Number(row?.conversations || 0), messages: Number(row?.messages || 0) };
}

async function customerIdsInScope(ids, convs) {
  const convIds = new Set(convs);
  if (ids.length) {
    for (const r of await db('messages').whereIn('id', ids).whereNotNull('conversation_id').distinct('conversation_id')) convIds.add(r.conversation_id);
  }
  if (!convIds.size) return [];
  return db('conversations').whereIn('id', [...convIds]).whereNotNull('customer_id').distinct('customer_id').pluck('customer_id');
}

module.exports = { markInboundSmsRead, countUnreadInboundSms, retargetOrClearUnknownSenderBell };
