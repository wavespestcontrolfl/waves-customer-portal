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
  if (mirrorSids.length) {
    try {
      // Retarget an unknown-sender bell BEFORE clearing (codex #4210
      // head-round P2): the throttle rings once per 4h window, so a
      // single-message read of exactly that alerted SID would otherwise
      // clear the thread's only bell while a later throttled message from
      // the SAME sender is still unread — and that later message's own
      // read, in a future call, can never match the bell (it's keyed to
      // the SID that just cleared). Point the bell at a still-unread SID
      // from that sender first, mirroring the customer-scoped
      // nothing-left-unread check below for threads that have no
      // customer_id to key that check on. Scoped by contact_phone, not
      // conversation_id: the throttle and the claim are keyed on the raw
      // sender phone across every conversation it owns (one per
      // our_endpoint_id it has texted), so a sender who has texted two
      // business numbers within the window shares ONE bell across both
      // conversations (pre-push audit P1).
      const unknownReadRows = await db('messages as m')
        .join('conversations as c', 'c.id', 'm.conversation_id')
        .whereNull('c.customer_id')
        .whereIn('m.twilio_sid', mirrorSids)
        .select('m.twilio_sid', 'c.contact_phone');
      const readSidsByPhone = {};
      for (const row of unknownReadRows) {
        if (row.contact_phone) (readSidsByPhone[row.contact_phone] ??= []).push(row.twilio_sid);
      }
      for (const [phone, readSids] of Object.entries(readSidsByPhone)) {
        const remaining = await db('messages as m')
          .join('conversations as c', 'c.id', 'm.conversation_id')
          .where({ 'c.contact_phone': phone, 'm.channel': 'sms', 'm.direction': 'inbound' })
          .whereNull('c.customer_id')
          .andWhere(function unread() { this.where({ 'm.is_read': false }).orWhereNull('m.is_read'); })
          .whereNotNull('m.twilio_sid')
          .orderBy('m.created_at', 'asc')
          .first('m.twilio_sid');
        if (!remaining?.twilio_sid) continue; // nothing left unread — leave the bell keyed to a SID that will clear normally below
        await db('notifications')
          .where({ recipient_type: 'admin', category: 'inbound_sms' })
          .whereNull('read_at')
          .whereRaw("metadata->'payload'->>'twilioSid' = ANY(?)", [readSids])
          .update({ metadata: db.raw("jsonb_set(metadata, '{payload,twilioSid}', to_jsonb(?::text))", [remaining.twilio_sid]) });
      }
    } catch (e) { logger.warn(`[inbound-sms-read] unknown-sender bell retarget failed: ${e.message}`); }
    try {
      notificationsCleared += await NotificationService.markInboundSmsReadAdmin({ twilioSids: mirrorSids, before: now, role });
    } catch (e) { logger.warn(`[inbound-sms-read] bell clear by sid failed: ${e.message}`); }
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

module.exports = { markInboundSmsRead, countUnreadInboundSms };
