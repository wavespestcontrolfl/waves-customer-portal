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

// The Messages badge's number: contact-phone threads that still need a human
// response. State is endpoint-scoped because a customer can text several
// business numbers independently, then deduped by contact phone for the badge.
// Unified messages/conversations remain canonical for display and customer
// ownership. A lateral sms_log twin overlays compliance/reaction types that
// the unified row does not consistently retain. Select only each endpoint's
// newest actionable inbound in SQL, then use the shared JS courtesy classifier
// for historical unstamped rows. No created_at horizon: an old unanswered
// question remains.
async function countUnreadInboundSms({ excludePhones = [], customerId = null, includePending = false } = {}) {
  const {
    HUMAN_REPLY_TYPES,
    DRAFT_REPLY_TYPES,
    NON_ACTIONABLE_INBOUND_TYPES,
    inboundNeedsResponse,
    phoneIdentitySql,
    draftIdSql,
  } = require('./sms-response-policy');
  const eventPeer = phoneIdentitySql('base.contact_phone');
  const eventEndpoint = phoneIdentitySql('base.our_endpoint_id');
  const blockedPeer = phoneIdentitySql('b.number');
  const stopPeer = phoneIdentitySql("COALESCE(NULLIF(stop_conversation.contact_phone, ''), stop_customer.phone, '')");
  const legacyStopPeer = phoneIdentitySql('stop_log.from_phone');
  const { rows = [] } = await db.raw(`
    WITH base_sms AS MATERIALIZED (
      SELECT m.id, m.direction, m.body AS message_body, m.created_at,
             m.twilio_sid, m.message_type AS canonical_message_type,
             m.delivery_status AS canonical_delivery_status,
             m.metadata AS canonical_metadata,
             COALESCE(m.media, '[]'::jsonb) AS media,
             c.customer_id,
             COALESCE(NULLIF(c.contact_phone, ''), cu.phone, '') AS contact_phone,
             COALESCE(c.our_endpoint_id, '') AS our_endpoint_id
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      LEFT JOIN customers cu ON cu.id = c.customer_id
      WHERE m.channel = 'sms'
        AND (CAST(:customerId AS uuid) IS NULL OR c.customer_id = CAST(:customerId AS uuid))
        AND NOT (COALESCE(c.our_endpoint_id, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(c.contact_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(cu.phone, '') = ANY(CAST(:excludePhones AS text[])))
    ), sms_events AS MATERIALIZED (
      SELECT base.*, ${eventPeer} AS peer, ${eventEndpoint} AS endpoint
      FROM base_sms base
    ), inbound_events AS MATERIALIZED (
      SELECT s.*,
             COALESCE(legacy.message_type, s.canonical_message_type, '') AS message_type,
             COALESCE(s.canonical_metadata, '{}'::jsonb)
               || COALESCE(legacy.metadata, '{}'::jsonb) AS metadata
      FROM sms_events s
      LEFT JOIN LATERAL (
        SELECT sl.message_type, sl.status, sl.metadata
        FROM sms_log sl
        WHERE sl.twilio_sid = s.twilio_sid AND sl.direction = s.direction
        ORDER BY sl.created_at DESC, sl.id DESC
        LIMIT 1
      ) legacy ON true
      WHERE s.direction = 'inbound'
    ), latest_inbound AS (
      SELECT DISTINCT ON (s.peer, s.endpoint)
        s.id, s.peer, s.endpoint, s.customer_id, s.message_body,
        s.message_type, s.metadata, s.media, s.created_at, s.twilio_sid
      FROM inbound_events s
      WHERE s.peer <> ''
        AND s.endpoint <> ''
        AND s.message_type <> ALL(CAST(:ignoredInboundTypes AS text[]))
        -- Recruiting replies have their own inbox and notification lifecycle.
        AND s.message_type NOT LIKE 'job\\_%'
        AND NOT EXISTS (
          SELECT 1 FROM blocked_numbers b WHERE ${blockedPeer} = s.peer
      )
      ORDER BY s.peer, s.endpoint, s.created_at DESC, s.id DESC
    ), enriched_inbound AS MATERIALIZED (
      SELECT li.*,
             li.metadata || COALESCE(audit.metadata, '{}'::jsonb) AS enriched_metadata
      FROM latest_inbound li
      LEFT JOIN LATERAL (
        SELECT mal.metadata
        FROM messaging_audit_log mal
        WHERE mal.provider_message_id = li.twilio_sid AND mal.channel = 'sms'
        ORDER BY mal.created_at DESC, mal.id DESC
        LIMIT 1
      ) audit ON true
    ), outbound_events AS MATERIALIZED (
      SELECT s.*, li.id AS inbound_id, li.created_at AS inbound_created_at,
             COALESCE(legacy.created_at, s.created_at) AS response_created_at,
             COALESCE(legacy.message_type, s.canonical_message_type, '') AS message_type,
             COALESCE(legacy.status, s.canonical_delivery_status, '') AS delivery_status,
             response_draft.sms_log_id IS NOT NULL AS has_inbound_draft_anchor,
             response_draft.intent AS draft_intent
      FROM enriched_inbound li
      JOIN sms_events s ON s.peer = li.peer AND s.endpoint = li.endpoint
        AND s.direction = 'outbound'
        AND s.created_at > li.created_at - INTERVAL '24 hours'
      LEFT JOIN LATERAL (
        SELECT sl.message_type, sl.status, sl.metadata, sl.created_at
        FROM sms_log sl
        WHERE sl.twilio_sid = s.twilio_sid AND sl.direction = s.direction
        ORDER BY sl.created_at DESC, sl.id DESC
        LIMIT 1
      ) legacy ON true
      LEFT JOIN LATERAL (
        SELECT mal.metadata
        FROM messaging_audit_log mal
        WHERE mal.provider_message_id = s.twilio_sid AND mal.channel = 'sms'
        ORDER BY mal.created_at DESC, mal.id DESC
        LIMIT 1
      ) audit ON true
      LEFT JOIN message_drafts response_draft
        ON response_draft.id = ${draftIdSql("COALESCE(audit.metadata->>'draft_id', legacy.metadata->>'draft_id', s.canonical_metadata->>'draft_id')")}
    ), prior_context AS MATERIALIZED (
      SELECT DISTINCT ON (prev.inbound_id) prev.inbound_id AS id, prev.message_body
      FROM outbound_events prev
      WHERE prev.endpoint <> ''
        AND prev.delivery_status IN ('queued', 'sent', 'delivered')
        AND prev.message_type <> 'internal_alert'
        AND prev.response_created_at < prev.inbound_created_at
        AND prev.response_created_at > prev.inbound_created_at - INTERVAL '24 hours'
      ORDER BY prev.inbound_id, prev.response_created_at DESC, prev.id DESC
    ), answered_inbound AS MATERIALIZED (
      SELECT DISTINCT os.inbound_id
      FROM outbound_events os
      WHERE os.message_type = ANY(CAST(:humanReplyTypes AS text[]))
        AND os.delivery_status IN ('queued', 'sent', 'delivered')
        AND os.response_created_at > os.inbound_created_at
        -- Approval sends can be proactive nudges. Require an exact draft
        -- inbound anchor for ambiguous types; proactive drafts never clear an ask.
        AND (os.message_type <> ALL(CAST(:draftReplyTypes AS text[])) OR os.has_inbound_draft_anchor)
        AND os.draft_intent IS DISTINCT FROM 'click_followup'
    ), all_stop_events AS MATERIALIZED (
      SELECT ${stopPeer} AS peer,
             COALESCE(stop_legacy.created_at, stop_message.created_at) AS created_at
      FROM messages stop_message
      JOIN conversations stop_conversation ON stop_conversation.id = stop_message.conversation_id
      LEFT JOIN customers stop_customer ON stop_customer.id = stop_conversation.customer_id
      LEFT JOIN LATERAL (
        SELECT sl.message_type, sl.created_at
        FROM sms_log sl
        WHERE sl.twilio_sid = stop_message.twilio_sid AND sl.direction = stop_message.direction
        ORDER BY sl.created_at DESC, sl.id DESC
        LIMIT 1
      ) stop_legacy ON true
      WHERE stop_message.channel = 'sms'
        AND stop_message.direction = 'inbound'
        -- Restrict the lateral overlay to plausible STOP rows. COALESCE then
        -- preserves the canonical type when a nullable legacy twin lacks one.
        AND (stop_message.message_type = 'opt_out' OR EXISTS (
          SELECT 1
          FROM sms_log stop_candidate
          WHERE stop_candidate.twilio_sid = stop_message.twilio_sid
            AND stop_candidate.direction = stop_message.direction
            AND stop_candidate.message_type = 'opt_out'
        ))
        AND COALESCE(stop_legacy.message_type, stop_message.message_type, '') = 'opt_out'
        AND NOT (COALESCE(stop_conversation.our_endpoint_id, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_conversation.contact_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_customer.phone, '') = ANY(CAST(:excludePhones AS text[])))
      UNION ALL
      SELECT ${legacyStopPeer} AS peer, stop_log.created_at
      FROM sms_log stop_log
      LEFT JOIN customers stop_log_customer ON stop_log_customer.id = stop_log.customer_id
      WHERE stop_log.direction = 'inbound'
        AND stop_log.message_type = 'opt_out'
        AND NOT EXISTS (
          SELECT 1
          FROM messages stop_twin
          WHERE stop_twin.twilio_sid = stop_log.twilio_sid AND stop_twin.direction = stop_log.direction
        )
        AND NOT (COALESCE(stop_log.to_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_log.from_phone, '') = ANY(CAST(:excludePhones AS text[]))
          OR COALESCE(stop_log_customer.phone, '') = ANY(CAST(:excludePhones AS text[])))
    ), latest_stop AS MATERIALIZED (
      SELECT st.peer, MAX(st.created_at) AS stopped_at
      FROM all_stop_events st
      WHERE st.peer <> ''
      GROUP BY st.peer
    )
    SELECT li.id, li.peer, li.endpoint, li.customer_id, li.message_body,
           li.message_type, li.enriched_metadata AS metadata, li.media, li.created_at,
           prior_context.message_body AS prior_outbound_body
    FROM enriched_inbound li
    LEFT JOIN prior_context ON prior_context.id = li.id
    LEFT JOIN answered_inbound answered ON answered.inbound_id = li.id
    LEFT JOIN latest_stop stop ON stop.peer = li.peer
    WHERE answered.inbound_id IS NULL
    -- STOP closes every business-number thread for the peer. A later genuine
    -- inbound candidate can reopen only if it arrived after that STOP.
    AND (stop.stopped_at IS NULL OR stop.stopped_at <= li.created_at)
  `, {
    customerId: customerId || null,
    excludePhones,
    ignoredInboundTypes: NON_ACTIONABLE_INBOUND_TYPES,
    humanReplyTypes: HUMAN_REPLY_TYPES,
    draftReplyTypes: DRAFT_REPLY_TYPES,
  });
  const actionable = rows.filter((row) => inboundNeedsResponse({
    direction: 'inbound',
    body: row.message_body,
    priorOutboundBody: row.prior_outbound_body,
    media: row.media,
    metadata: row.metadata,
  }));
  const result = {
    conversations: new Set(actionable.map((row) => row.peer)).size,
    // Kept for response compatibility; this is now the number of endpoint
    // threads needing a reply, rather than the number of unread rows.
    messages: actionable.length,
  };
  if (includePending) result.pendingMessageIds = actionable.map((row) => row.id);
  return result;
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
