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
const { phoneIdentityKey } = require('../utils/phone');
const logger = require('./logger');
const NotificationService = require('./notification-service');
const { excludeRecruitingSmsLog, hideRecruitingThreadsFromNonAdmin } = require('../utils/recruiting-thread-scope');
const {
  inboundSmsReceiptProjectionSql, phoneIdentitySql, canonicalSmsAddressProjectionSql, canonicalSmsLegacyLinkSql,
} = require('./sms-response-policy');

const LEGACY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

// A sender's unlinked bell is shared across business-number threads. Retarget
// it to the oldest unread sibling, or clear it when the sender has none left.
// Bound writes to bells present at request entry, allowing PostgreSQL's
// sub-millisecond precision within the captured JavaScript millisecond.
function nextMillisecondBoundary(date) {
  return new Date(date.getTime() + 1);
}

// An unknown sender's bell carries no customer id: its link is the bare inbox
// or, since the bell opens the conversation, ?message=<MessageSid>
// (notification-triggers.js sms_reply). Both mean "unlinked".
const UNLINKED_BELL_LINK = '/admin/communications';
const isUnlinkedBellLink = (qb, column = 'link') => qb.where((b) => b
  .where(column, UNLINKED_BELL_LINK).orWhere(column, 'like', `${UNLINKED_BELL_LINK}?message=%`));

async function retargetOrClearUnknownSenderBell(phone, cutoff, role) {
  if (!phone) return 0;
  try {
    return await db.transaction(async (trx) => {
      await trx.raw("SET LOCAL lock_timeout = '2s'");
      await trx.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [`inbound_sms_bell_retarget:${phone}`]);
      // Promotion clears conversations.contact_phone; the legacy twin keeps
      // the original sender identity. Use contact_phone only without a twin.
      const remaining = await trx('messages as m')
        .join('conversations as c', 'c.id', 'm.conversation_id')
        .leftJoin('sms_log as l', function join() {
          this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
        })
        .where({ 'm.channel': 'sms', 'm.direction': 'inbound' })
        .whereRaw('COALESCE(l.from_phone, c.contact_phone) = ?', [phone])
        .andWhere(function unread() { this.where({ 'm.is_read': false }).orWhereNull('m.is_read'); })
        .whereNotNull('m.twilio_sid')
        .orderBy('m.created_at', 'asc')
        .first('m.twilio_sid');
      // Match the bell's current target and preserve customer-linked bells.
      const bellCutoff = nextMillisecondBoundary(cutoff);
      const liveBell = () => isUnlinkedBellLink(NotificationService.scopeAdminFeedToRole(trx('notifications'), role)
        .where({ recipient_type: 'admin', category: 'inbound_sms' }))
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
        // The link names the message the bell opens, so it follows the target
        // (a bare-link bell gains ?message=<sid> here).
        await liveBell().update({
          link: `${UNLINKED_BELL_LINK}?message=${encodeURIComponent(remaining.twilio_sid)}`,
          metadata: trx.raw("jsonb_set(metadata, '{payload,twilioSid}', to_jsonb(?::text))", [remaining.twilio_sid]),
        });
        return 0;
      }
      // Appends take this phone lock too. Recheck in the UPDATE for other
      // writers that can insert without the lock after the first SELECT.
      return liveBell()
        .whereNotExists(function stillUnread() {
          this.select(1).from('messages as m3')
            .join('conversations as c3', 'c3.id', 'm3.conversation_id')
            .leftJoin('sms_log as l3', function join() {
              this.on('l3.twilio_sid', '=', 'm3.twilio_sid').andOnVal('l3.direction', 'inbound');
            })
            .where({ 'm3.channel': 'sms', 'm3.direction': 'inbound' })
            .whereRaw('COALESCE(l3.from_phone, c3.contact_phone) = ?', [phone])
            .andWhere(function unread() { this.where({ 'm3.is_read': false }).orWhereNull('m3.is_read'); });
        })
        .update({ read_at: new Date() });
    });
  } catch (e) {
    logger.warn('[inbound-sms-read] unknown-sender bell retarget failed for one sender', { code: e.code || 'unknown' });
    return 0;
  }
}

// Resolve membership by phone, never by the bell's mutable target SID:
// concurrent reads must both enter the lock even if the bell is retargeted.
async function phonesWithLiveUnlinkedBell(candidateRows) {
  const phonesWithLiveBell = new Set();
  const candidatePhones = [...new Set(candidateRows.map((r) => r.contact_phone).filter(Boolean))];
  if (!candidatePhones.length) return phonesWithLiveBell;
  const rows = await db('messages as m')
    .join('conversations as c', 'c.id', 'm.conversation_id')
    .leftJoin('sms_log as l', function join() {
      this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
    })
    .whereRaw('COALESCE(l.from_phone, c.contact_phone) = ANY(?)', [candidatePhones])
    .whereExists(function liveBell() {
      isUnlinkedBellLink(this.select(1).from('notifications as n')
        .where({ 'n.recipient_type': 'admin', 'n.category': 'inbound_sms' }), 'n.link')
        .whereNull('n.read_at')
        .whereRaw("n.metadata->'payload'->>'twilioSid' = m.twilio_sid");
    })
    .distinct(db.raw('COALESCE(l.from_phone, c.contact_phone) as contact_phone'));
  for (const row of rows) { if (row.contact_phone) phonesWithLiveBell.add(row.contact_phone); }
  return phonesWithLiveBell;
}

// Include promoted threads while their phone still owns an unlinked bell.
async function resolveUnknownSenderPhoneMembership(scopedSids) {
  const unknownSenderSids = new Set();
  const phones = new Set();
  const promotedSids = new Map();
  if (!scopedSids.length) return { unknownSenderSids, phones, promotedSids };
  const candidateRows = await db('messages as m')
    .join('conversations as c', 'c.id', 'm.conversation_id')
    .leftJoin('sms_log as l', function join() {
      this.on('l.twilio_sid', '=', 'm.twilio_sid').andOnVal('l.direction', 'inbound');
    })
    .whereIn('m.twilio_sid', scopedSids)
    .select('m.twilio_sid', 'c.customer_id', db.raw('COALESCE(l.from_phone, c.contact_phone) as contact_phone'));
  const phonesWithLiveBell = await phonesWithLiveUnlinkedBell(candidateRows);
  for (const row of candidateRows) {
    const isUnknownSenderScoped = row.customer_id === null
      || (row.contact_phone && phonesWithLiveBell.has(row.contact_phone));
    if (isUnknownSenderScoped) {
      unknownSenderSids.add(row.twilio_sid);
      if (row.contact_phone) phones.add(row.contact_phone);
      if (row.customer_id) {
        if (!promotedSids.has(row.customer_id)) promotedSids.set(row.customer_id, []);
        promotedSids.get(row.customer_id).push(row.twilio_sid);
      }
    }
  }
  return { unknownSenderSids, phones, promotedSids };
}

async function clearBacklogResetMarkers({ scope, ids, convs }) {
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
        .whereRaw("split_part(link, '&message=', 1) = ANY(?)", [custs.map((cid) => `/admin/communications?thread=${cid}`)])
        .whereRaw("jsonb_exists(COALESCE(metadata,'{}'::jsonb), 'backlog_reset')")
        .update({ metadata: db.raw("metadata - 'backlog_reset'") });
    }
  } catch (e) { logger.warn('[inbound-sms-read] backlog-reset marker clear failed', { code: e.code || 'unknown' }); }
}

// `applicationId` — the recruiting scope (PR #4623 r20): opening an
// application in Recruiting reads its applicant replies (job_applicant_reply
// rows carrying that application id) up to the snapshot the owner saw
// (readBefore), through this one writer — same read stamp, legacy mirror,
// backlog-marker strip and bell reconciliation as any other read.
// The application scope is bound to the replies the owner actually SAW
// (Codex r29 P1): `replyMessageIds` are the unified message ids carried by
// the applicant_reply entries in the returned application snapshot, and
// `replyEntryIds` those entries' own ids (the bell's replyId is the Twilio
// SID when there is one, else the entry id). A time cutoff alone is wrong:
// the unified row is written BEFORE the comms_history append, so a reply
// can exist in `messages` under the cutoff and still be absent from the
// snapshot — acknowledging it would read a reply nobody has seen and retire
// its bell as soon as it rings.
async function markInboundSmsRead({
  messageIds = [], conversationIds = [], applicationId = null, replyMessageIds = null, replyEntryIds = [],
  readBefore = null, adminUserId = null, role,
} = {}) {
  const ids = messageIds.filter((id) => typeof id === 'string' && id.trim());
  const convs = conversationIds.filter((id) => typeof id === 'string' && id.trim());
  if (!ids.length && !convs.length && !applicationId) return { updated: 0, notificationsCleared: 0 };
  if ((convs.length || applicationId) && !(readBefore instanceof Date && !Number.isNaN(readBefore.getTime()))) {
    throw new Error('readBefore required when marking a conversation or application read');
  }
  if (applicationId && !Array.isArray(replyMessageIds)) {
    throw new Error('replyMessageIds (the replies in the returned snapshot) required when marking an application read');
  }
  const appReplyIds = applicationId ? replyMessageIds.filter((id) => typeof id === 'string' && id.trim()) : [];
  const appEntryIds = applicationId ? (replyEntryIds || []).filter((id) => typeof id === 'string' && id.trim()) : [];
  if (!ids.length && !convs.length && applicationId && !appReplyIds.length) return { updated: 0, notificationsCleared: 0 };
  const now = new Date();
  const scope = function scope() {
    if (ids.length) this.whereIn('id', ids);
    if (convs.length) this.orWhere(function conv() { this.whereIn('conversation_id', convs).where('created_at', '<=', readBefore); });
    if (applicationId && appReplyIds.length) {
      this.orWhere(function applicant() {
        this.where({ message_type: 'job_applicant_reply' })
          .whereRaw("metadata->>'job_application_id' = ?", [String(applicationId)])
          .whereIn('id', appReplyIds)
          .where('created_at', '<=', readBefore);
      });
    }
  };

  // 1. Strip backlog-reset markers across the request scope regardless of
  //    read state (rows the reset already read are exactly the ones a human
  //    is now looking at), on messages, legacy twins, and the thread's bells.
  await clearBacklogResetMarkers({ scope, ids, convs });

  // 2. The read itself (+ legacy mirror by twilio_sid).
  // A technician's read scope never touches hidden recruiting rows (PR
  // #4623): the display query hides them, so the write must too, or a
  // technician opening the customer part of a shared thread would clear the
  // owner's unread applicant reply.
  const q = () => hideRecruitingThreadsFromNonAdmin(db('messages').where({ channel: 'sms', direction: 'inbound' }), { techRole: role }, 'message_type')
    .andWhere(function unreadOnly() { this.where({ is_read: false }).orWhereNull('is_read'); })
    .andWhere(scope);
  // Reconcile every requested inbound SID, including already-read rows:
  // a prior read can commit while its later bell reconciliation times out.
  const scopedSids = (await db('messages').where({ channel: 'sms', direction: 'inbound' })
    .andWhere(scope).whereNotNull('twilio_sid').pluck('twilio_sid')).filter(Boolean);
  const mirrorSids = (await q().whereNotNull('twilio_sid').pluck('twilio_sid')).filter(Boolean);
  const updated = await q().update({ is_read: true, read_at: now, read_by_admin_user_id: adminUserId || null, updated_at: now });
  try {
    await db('sms_log').where({ direction: 'inbound' }).whereIn('twilio_sid', mirrorSids)
      .andWhere(function unread() { this.where({ is_read: false }).orWhereNull('is_read'); })
      .update({ is_read: true });
  } catch (e) { logger.warn('[inbound-sms-read] sms_log read mirror failed', { code: e.code || 'unknown' }); }

  // 3. Bell cross-clear — only threads with nothing unread left, bells that
  //    existed at entry, through the notification service.
  let notificationsCleared = 0;
  // Reconcile generic sender bells separately from customer-linked bells.
  let knownSids = [];
  try {
    const membership = await resolveUnknownSenderPhoneMembership(scopedSids);
    knownSids = scopedSids.filter((sid) => !membership.unknownSenderSids.has(sid));
    // Promoted SIDs can own both bell types. Clear only their customer
    // link here; the generic bell remains protected by the phone lock.
    for (const [customerId, twilioSids] of membership.promotedSids) {
      notificationsCleared += await NotificationService.markInboundSmsReadAdmin({ customerId, twilioSids, before: now, role });
    }
    for (const phone of membership.phones) {
      notificationsCleared += await retargetOrClearUnknownSenderBell(phone, now, role);
    }
  } catch (e) { logger.warn('[inbound-sms-read] unknown-sender bell retarget failed', { code: e.code || 'unknown' }); }
  // Generic bells require phone reconciliation; other SIDs clear directly.
  // Membership failure must not turn unknown senders into unlocked SID clears.
  try {
    notificationsCleared += await NotificationService.markInboundSmsReadAdmin({ twilioSids: knownSids, before: now, role });
  } catch (e) { logger.warn('[inbound-sms-read] bell clear by sid failed', { code: e.code || 'unknown' }); }
  notificationsCleared += await clearCustomerThreadCrossBells({ ids, convs, now, role });
  if (applicationId && appReplyIds.length) {
    try {
      // Only the bells of the replies in the snapshot: their SIDs (the
      // bell's replyId for a Twilio-delivered reply) plus the entry ids.
      const snapshotSids = (await db('messages').whereIn('id', appReplyIds).whereNotNull('twilio_sid').pluck('twilio_sid')).filter(Boolean);
      const replyIds = [...new Set([...snapshotSids, ...appEntryIds])];
      if (replyIds.length) {
        notificationsCleared += await NotificationService.markApplicantRepliesReadAdmin({ applicationId, replyIds, before: readBefore, role });
      }
    } catch (e) { logger.warn('[inbound-sms-read] applicant-reply bell clear failed', { code: e.code || 'unknown' }); }
  }

  return { updated, notificationsCleared };
}

// The inbox's Mark all read (owner 2026-11-19): every unread inbound text the
// inbox can show, created up to readBefore (the newest text the caller's list
// showed, never later than now), through the one writer above, so the legacy
// mirror, backlog-marker strip and bell clear are the same as a thread read.
// The client's stamp is millisecond-rounded, so the cutoff takes the whole
// millisecond (PostgreSQL keeps microseconds). Office roles only: the route
// refuses a technician, who reads one thread at a time through the scoped
// /messages/read check. `excludePhones` is the
// inbox log's own internal-phone exclusion (either side of the thread, or the
// customer's phone). Recruiting replies are read on the Recruiting page, never
// by an inbox-wide read.
async function markAllInboundSmsRead({ readBefore, adminUserId = null, role, excludePhones = [], contactPhone = null } = {}) {
  if (!(readBefore instanceof Date) || Number.isNaN(readBefore.getTime())) {
    throw new Error('readBefore required when marking every text read');
  }
  // `contactPhone`: one inbox row's Mark read: that sender's texts across every
  // business line and page, up to the row's newest text, under the same rules.
  // Other phones sharing the conversation stay as they are.
  const senderKey = contactPhone === null ? null : phoneIdentityKey(contactPhone);
  if (contactPhone !== null && !senderKey) throw new Error('contactPhone must be a phone number');
  const cutoff = nextMillisecondBoundary(new Date(Math.min(readBefore.getTime(), Date.now())));
  // The inbox shows a text at its effective time (an opt-out receipt can date
  // it earlier than the row), so the cutoff compares that same time.
  const receipt = inboundSmsReceiptProjectionSql({ messageAlias: 'm', legacyAlias: 'legacy', receiptAlias: 'r' });
  // A blocked sender is hidden from the inbox (and the badge), so its texts
  // keep their read state for the day it is unblocked. The sender is the
  // inbox's per-text identity (/log): the linked legacy row's sender first,
  // as a customer's two phones can share one conversation.
  const address = canonicalSmsAddressProjectionSql({ messageAlias: 'm', conversationAlias: 'c', customerAlias: 'cu', legacyAlias: 'legacy' });
  const ids = await db('messages as m')
    .join('conversations as c', 'c.id', 'm.conversation_id')
    .leftJoin('customers as cu', 'cu.id', 'c.customer_id')
    .joinRaw(`LEFT JOIN LATERAL (${canonicalSmsLegacyLinkSql({ messageAlias: 'm', conversationAlias: 'c' })}) legacy ON true`)
    .joinRaw(receipt.joinSql)
    .where({ 'm.channel': 'sms', 'm.direction': 'inbound' })
    // A backlog reset read a text and tagged it for rollback; the writer strips
    // that tag, so a later rollback cannot reopen a text staff marked read. A
    // read text whose bell is still live (an earlier read committed, then its
    // bell step failed) joins too, so a retry finishes that bell.
    .andWhere(function unreadOrUnfinished() {
      this.where({ 'm.is_read': false }).orWhereNull('m.is_read')
        .orWhereRaw("jsonb_exists(COALESCE(m.metadata, '{}'::jsonb), 'backlog_reset')")
        .orWhereIn('m.twilio_sid', function liveBells() {
          this.select(db.raw("n.metadata->'payload'->>'twilioSid'")).from('notifications as n')
            .where({ 'n.recipient_type': 'admin', 'n.category': 'inbound_sms' }).whereNull('n.read_at');
        });
    })
    .whereRaw(`${receipt.effectiveCreatedAtSql} < ?`, [cutoff])
    // An inbox-wide read leaves recruiting replies for the Recruiting page; one
    // sender's row reads them as opening the thread does, for the roles that
    // see them.
    .modify((q) => {
      if (!senderKey) excludeRecruitingSmsLog(q, 'm.message_type');
      else hideRecruitingThreadsFromNonAdmin(q, { techRole: role }, 'm.message_type');
    })
    .modify((q) => { if (senderKey) q.whereRaw(`${address.peerSql} = ?`, [senderKey]); })
    .modify((q) => {
      for (const phone of excludePhones) {
        q.whereNot('c.our_endpoint_id', phone)
          .where((b) => b.whereNot('c.contact_phone', phone).orWhereNull('c.contact_phone'))
          .where((b) => b.whereNot('cu.phone', phone).orWhereNull('cu.phone'));
      }
    })
    .whereNotExists(function blockedSender() {
      // A digitless legacy block normalizes to '' like a text with no number; it blocks nothing (as on screen).
      this.select(1).from('blocked_numbers as b').whereRaw(`${phoneIdentitySql('b.number')} <> ''`)
        .whereRaw(`${phoneIdentitySql('b.number')} = ${address.peerSql}`);
    })
    .pluck('m.id');
  // The writer binds each id (and its SIDs); batches keep a long backlog
  // under PostgreSQL's bind-parameter limit.
  const total = { updated: 0, notificationsCleared: 0 };
  for (let i = 0; i < ids.length; i += MARK_ALL_BATCH) {
    const done = await markInboundSmsRead({ messageIds: ids.slice(i, i + MARK_ALL_BATCH), adminUserId, role });
    total.updated += done.updated;
    total.notificationsCleared += done.notificationsCleared;
  }
  return total;
}
const MARK_ALL_BATCH = 500;

// 3b. Customer-thread cross-clear: threads with nothing left unread
// (unified AND recent legacy-only rows), through the notification service.
// Separated from the by-SID clear above — this scope is every conversation
// touched by the read, not just the unknown-sender ones that already went
// through their own lock-protected decision.
async function clearCustomerThreadCrossBells({ ids, convs, now, role }) {
  try {
    const convIds = new Set(convs);
    if (ids.length) {
      for (const r of await db('messages').whereIn('id', ids).whereNotNull('conversation_id').distinct('conversation_id')) convIds.add(r.conversation_id);
    }
    if (!convIds.size) return 0;
    const threads = await db('conversations as cv')
      .whereIn('cv.id', [...convIds]).whereNotNull('cv.customer_id')
      .whereNotExists(function stillUnread() {
        this.select(1).from('messages as m').join('conversations as c2', 'c2.id', 'm.conversation_id')
          .whereRaw('c2.customer_id = cv.customer_id').where({ 'm.channel': 'sms', 'm.direction': 'inbound' })
          // Hidden recruiting replies never ring this bell, so they never hold it open.
          .modify((q) => excludeRecruitingSmsLog(q, 'm.message_type'))
          .andWhere(function unread() { this.where({ 'm.is_read': false }).orWhereNull('m.is_read'); });
      })
      // legacy-ONLY (no unified twin) and recent — historical rows were
      // initialized unread and never mirrored
      .whereNotExists(function stillUnreadLegacy() {
        this.select(1).from('sms_log as l').whereRaw('l.customer_id = cv.customer_id').where({ 'l.direction': 'inbound' })
          .where('l.created_at', '>', new Date(Date.now() - LEGACY_WINDOW_MS))
          .modify((q) => excludeRecruitingSmsLog(q, 'l.message_type'))
          .andWhere(function unread() { this.where({ 'l.is_read': false }).orWhereNull('l.is_read'); })
          .whereNotExists(function hasTwin() { this.select(1).from('messages as mm').whereRaw('mm.twilio_sid = l.twilio_sid').where({ 'mm.channel': 'sms' }); });
      })
      .distinct('cv.customer_id');
    let cleared = 0;
    for (const t of threads) {
      cleared += await NotificationService.markInboundSmsReadAdmin({ customerId: t.customer_id, before: now, role });
    }
    return cleared;
  } catch (e) {
    logger.warn('[inbound-sms-read] bell cross-clear failed', { code: e.code || 'unknown' });
    return 0;
  }
}

// Retain the API-facing name while the badge and pending inbox share one query.
const { countPendingSmsConversations: countUnreadInboundSms } = require('./sms-pending-conversations');

async function customerIdsInScope(ids, convs) {
  const convIds = new Set(convs);
  if (ids.length) {
    for (const r of await db('messages').whereIn('id', ids).whereNotNull('conversation_id').distinct('conversation_id')) convIds.add(r.conversation_id);
  }
  if (!convIds.size) return [];
  return db('conversations').whereIn('id', [...convIds]).whereNotNull('customer_id').distinct('customer_id').pluck('customer_id');
}

module.exports = { markInboundSmsRead, markAllInboundSmsRead, countUnreadInboundSms, retargetOrClearUnknownSenderBell };
