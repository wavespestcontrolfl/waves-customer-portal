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

// A sender's unlinked bell is shared across business-number threads. Retarget
// it to the oldest unread sibling, or clear it when the sender has none left.
// Bound writes to bells present at request entry, allowing PostgreSQL's
// sub-millisecond precision within the captured JavaScript millisecond.
function nextMillisecondBoundary(date) {
  return new Date(date.getTime() + 1);
}

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
      const liveBell = () => NotificationService.scopeAdminFeedToRole(trx('notifications'), role)
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
      this.select(1).from('notifications as n')
        .where({ 'n.recipient_type': 'admin', 'n.category': 'inbound_sms', 'n.link': '/admin/communications' })
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
        .whereIn('link', custs.map((cid) => `/admin/communications?thread=${cid}`))
        .whereRaw("jsonb_exists(COALESCE(metadata,'{}'::jsonb), 'backlog_reset')")
        .update({ metadata: db.raw("metadata - 'backlog_reset'") });
    }
  } catch (e) { logger.warn('[inbound-sms-read] backlog-reset marker clear failed', { code: e.code || 'unknown' }); }
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
  await clearBacklogResetMarkers({ scope, ids, convs });

  // 2. The read itself (+ legacy mirror by twilio_sid).
  // A technician's read scope never touches hidden recruiting rows (PR
  // #4623): the display query hides them, so the write must too, or a
  // technician opening the customer part of a shared thread would clear the
  // owner's unread applicant reply.
  const { hideRecruitingThreadsFromNonAdmin } = require('../utils/recruiting-thread-scope');
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

  return { updated, notificationsCleared };
}

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

// The Messages badge's number: contact-phone threads holding an unread inbound
// SMS. CommunicationsPageV2.smsThreadKey groups across business numbers using
// the last 10 digits (or "unknown"); /log prefers contact_phone to customer.phone.
// Count that same identity across every conversation. Internal
// admin-phone traffic is excluded exactly as the inbox log excludes it
// (`excludePhones` = the router's ADMIN_PHONES).
async function countUnreadInboundSms({ excludePhones = [], customerId = null, role = 'admin' } = {}) {
  const { hideRecruitingThreadsFromNonAdmin } = require('../utils/recruiting-thread-scope');
  // Same role-aware recruiting exclusion as the display query (PR #4623):
  // a badge must never count a message its reader cannot open.
  let q = hideRecruitingThreadsFromNonAdmin(db('messages')
    .leftJoin('conversations', 'messages.conversation_id', 'conversations.id')
    .leftJoin('customers', 'conversations.customer_id', 'customers.id')
    .where('messages.channel', 'sms')
    .where('messages.direction', 'inbound'), { techRole: role })
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
