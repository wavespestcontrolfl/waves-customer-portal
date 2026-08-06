'use strict';

// End-of-day owner exception email: today's comms that nobody worked.
//
// Three lanes feed it, all proven dead-ends by the 2026-08-05 weekly sweep:
//   1. call_log.disposition = 'callback_task_created' — the disposition enum
//      promises a task; the code writes a label that NOTHING reads (a
//      15-minute customer call landed there and rotted). This watcher is the
//      first and only consumer.
//   2. ai_follow_up_tasks — written on every scored call, then silently
//      auto-expired by the hourly verifier with no notification; the only
//      UI defaults to hiding expired rows.
//   3. Inbound SMS threads whose LAST message today is inbound — i.e. the
//      customer is waiting and no reply went out ("the afternoon queue
//      simply didn't get worked", 08-04).
//
// Principle (call-booking-miss-watchdog): the triage queue is a park, not a
// pager. This email is the pager. Exception-based: a fully-worked day sends
// nothing. Live by default with a kill switch
// (UNWORKED_COMMS_WATCHER_DISABLED=1). Cron: daily 6:15pm ET — after the
// 6:00pm missed-appointment check closes out no-shows, before the 6:40pm
// stale-visit sweep.

const sendgrid = require('./sendgrid-mail');
const logger = require('./logger');
const db = require('../models/db');
const { isInternalEmailRecipient } = require('../utils/internal-email-recipients');

const watcherDisabled = () => ['1', 'true', 'on']
  .includes(String(process.env.UNWORKED_COMMS_WATCHER_DISABLED || '').toLowerCase());
const watcherEmail = () => process.env.UNWORKED_COMMS_WATCHER_EMAIL || 'contact@wavespestcontrol.com';
const fromEmail = () => process.env.SENDGRID_FROM_EMAIL || 'contact@wavespestcontrol.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Waves Pest Control';
const adminPortalUrl = () => (process.env.ADMIN_PORTAL_URL || 'https://portal.wavespestcontrol.com').replace(/\/+$/, '');

const MAX_PER_SECTION = 12;
// Outbound types that count as a human answer — automated broadcasts
// (reminders, en-route, receipts, review asks) must not clear a waiting
// customer from the digest (codex #3232 r1).
// Canonical human-authored types ONLY (codex r8): estimate_sent can be
// an automated lane send for a SEPARATE matter — treating it as an
// answer advanced the marker and lost the waiting item permanently.
// ai_assistant = the conversational AI's own successful answer — a real
// reply for thread-clearing purposes (codex r20). The reschedule watcher
// keeps its stricter list (the AI stands down on reschedule intent).
const HUMAN_REPLY_TYPES = "('manual', 'ai_approved', 'ai_revised', 'ai_assistant', 'ai_assistant_reply', 'follow_up')";

// Scan window: since the previous SUCCESSFUL send (the ops_email_send_state
// marker), bounded to 7 days — windows tile exactly run-to-run, including
// across ET DST transitions where fixed 24h windows gap or overlap
// (codex r3). Marker missing (first run / quiet stretch) → 25h fallback.
const ET_DAY_START_SQL = `(GREATEST(
  COALESCE((SELECT last_sent_at FROM ops_email_send_state WHERE email_key = 'unworked-comms-eod'), now() - interval '25 hours'),
  now() - interval '7 days'))`;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  return digits.length >= 4 ? `…${digits.slice(-4)}` : '(unknown)';
}

function etDateTime(value) {
  try {
    return new Date(value).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'numeric', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function etTime(value) {
  try {
    return new Date(value).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

// Lane 1: callback-requested calls from today with nothing behind them.
async function loadCallbackCalls(cutoff = new Date()) {
  const { rows } = await db.raw(
    `
    SELECT c.id, c.created_at, c.duration_seconds,
           CASE WHEN c.direction = 'outbound' THEN c.to_phone ELSE c.from_phone END AS from_phone,
           NULLIF(TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')), '') AS customer_name,
           LEFT(COALESCE(c.call_summary, c.lead_synopsis, ''), 160) AS summary,
           COUNT(*) OVER () AS total_count
    FROM call_log c
    LEFT JOIN customers cu ON cu.id = c.customer_id
    -- Rolling 7-day live worklist (codex r14): callbacks are stateful —
    -- an uncleared item must reappear until worked, so no marker boundary
    -- can strand it (this also moots the mutable-updated_at window
    -- concern) and overflow beyond the cap resurfaces on later runs.
    -- Horizon on IMMUTABLE created_at (codex r27): reprocessing months-old
    -- calls restamps updated_at and would resurrect them; the updated_at
    -- cutoff below still admits rows only once processing settled.
    WHERE c.created_at >= now() - interval '30 days'
      AND c.updated_at <= :cutoff
      AND c.disposition = 'callback_task_created'
      -- One obligation, one lane (codex r22): when the coach minted a
      -- call_back task for the same customer around this call, the task
      -- lane carries it (with the richer recommended action).
      AND NOT EXISTS (
        SELECT 1 FROM ai_follow_up_tasks dt
        WHERE dt.task_type = 'call_back'
          AND dt.customer_id IS NOT NULL
          AND dt.customer_id = c.customer_id
          -- End-of-call boundary (codex r26): recovered rows (Studio /
          -- status fallback) are created near call END; adding duration
          -- again would overshoot. Bridged rows end at bridge + duration.
          AND dt.created_at BETWEEN c.created_at AND COALESCE(c.bridged_at, c.created_at) + CASE WHEN c.bridged_at IS NOT NULL THEN make_interval(secs => COALESCE(c.duration_seconds, 0)) ELSE interval '0' END + interval '45 minutes'
      )
      -- Already returned: a later outbound CALL to the same number, or a
      -- later human-typed text, clears the item (codex #3232 r1).
      -- Cleared only by a CONNECTED callback: the admin callback route
      -- inserts the outbound row at status 'initiated' before anyone
      -- answers — duration > 0 is the connected proxy (codex r2).
      AND NOT EXISTS (
        SELECT 1 FROM call_log oc
        WHERE oc.direction = 'outbound'
          AND oc.created_at > COALESCE(c.bridged_at, c.created_at) + CASE WHEN c.bridged_at IS NOT NULL THEN make_interval(secs => COALESCE(c.duration_seconds, 0)) ELSE interval '0' END
          -- Heuristic: the stored duration is the PARENT leg (admin
          -- answer), so a short pickup-and-abandon still counts positive;
          -- >= 60s approximates a real customer conversation (leg-level
          -- connect state is not recorded) (codex r5).
          AND COALESCE(oc.duration_seconds, 0) >= 60
          -- A LINKED source call is cleared only by an outbound call
          -- linked to the SAME customer (codex r28): call surfaces insert
          -- unlinked rows for shared numbers, and such a call may concern
          -- the other household member. Unlinked source calls keep the
          -- phone-level match (nothing better exists).
          AND (c.customer_id IS NULL OR oc.customer_id = c.customer_id)
          AND RIGHT(REGEXP_REPLACE(COALESCE(oc.to_phone, ''), '\\D', '', 'g'), 10)
            = RIGHT(REGEXP_REPLACE(COALESCE(CASE WHEN c.direction = 'outbound' THEN c.to_phone ELSE c.from_phone END, ''), '\\D', '', 'g'), 10)
      )
      AND NOT EXISTS (
        SELECT 1 FROM sms_log os
        WHERE os.direction = 'outbound'
          AND os.message_type IN ${HUMAN_REPLY_TYPES}
          -- A human-APPROVED PROACTIVE draft (click-followup, lead nudge —
          -- any draft with no inbound sms_log anchor) is not a reply to
          -- this item (codex r24/r28); finalize stamps sent_at at send.
          AND NOT EXISTS (
            SELECT 1 FROM message_drafts mdx
            WHERE mdx.sms_log_id IS NULL
              AND mdx.customer_id = os.customer_id
              AND mdx.sent_at BETWEEN os.created_at - interval '2 minutes'
                                  AND os.created_at + interval '2 minutes'
          )
          AND os.status IN ('queued', 'sent', 'delivered')
          AND os.created_at > COALESCE(c.bridged_at, c.created_at) + CASE WHEN c.bridged_at IS NOT NULL THEN make_interval(secs => COALESCE(c.duration_seconds, 0)) ELSE interval '0' END
          -- Same identity rule as the outbound-call leg (codex r31): a
          -- LINKED callback is cleared only by a text linked to the same
          -- customer — an unlinked manual send on a shared number may
          -- concern the other household member.
          AND (c.customer_id IS NULL OR os.customer_id = c.customer_id)
          AND RIGHT(REGEXP_REPLACE(COALESCE(os.to_phone, ''), '\\D', '', 'g'), 10)
            = RIGHT(REGEXP_REPLACE(COALESCE(CASE WHEN c.direction = 'outbound' THEN c.to_phone ELSE c.from_phone END, ''), '\\D', '', 'g'), 10)
      )
    -- Newest-first (codex r17): a stuck oldest-12 must not starve fresh
    -- requests; older rows persist in the overflow count.
    ORDER BY c.created_at DESC
    LIMIT :cap
    `,
    { cap: MAX_PER_SECTION, cutoff },
  );
  return rows;
}

// Lane 2: follow-up tasks that are overdue-pending, or were auto-expired
// today without any verified action — the silent-drop class.
async function loadDroppedFollowUps(cutoff = new Date()) {
  const { rows } = await db.raw(
    `
    SELECT t.id, t.task_type, t.deadline, t.status, t.recommended_action,
           NULLIF(TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')), '') AS customer_name,
           LEFT(COALESCE(cs.call_summary, ''), 120) AS call_context,
           COUNT(*) OVER () AS total_count
    FROM ai_follow_up_tasks t
    LEFT JOIN customers cu ON cu.id = t.customer_id
    LEFT JOIN csr_call_scores cs ON cs.id = t.call_score_id
    -- A sent estimate fulfills a send_estimate task (codex r19).
    WHERE NOT (t.task_type = 'send_estimate' AND EXISTS (
        SELECT 1 FROM estimates fe
        WHERE fe.customer_id = t.customer_id AND fe.sent_at > t.created_at
      ))
      AND NOT (t.task_type = 'call_back' AND t.customer_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM call_log fc
        WHERE fc.direction = 'outbound'
          AND fc.customer_id = t.customer_id
          AND COALESCE(fc.duration_seconds, 0) >= 60
          AND fc.created_at > t.created_at
      ))
      AND ((t.status IN ('pending', 'in_progress')
           -- Same rolling 30-day horizon as every other leg (codex r30):
           -- a task stuck pending for months is moot, not daily ACT news.
           AND t.deadline > now() - interval '30 days' AND t.deadline <= :cutoff
           -- Revalidated (codex r17): a human send/interaction after the
           -- task means it was worked even if the verifier hasn't run.
           AND NOT EXISTS (
             SELECT 1 FROM sms_log ps
             WHERE ps.customer_id = t.customer_id AND ps.direction = 'outbound'
               AND ps.message_type IN ${HUMAN_REPLY_TYPES}
               -- A human-APPROVED click-followup nudge is proactive marketing,
               -- not a reply to this item (codex r24): its draft intent is
               -- 'click_followup' and finalize stamps sent_at at send time.
               AND NOT EXISTS (
                 SELECT 1 FROM message_drafts mdx
                 WHERE mdx.sms_log_id IS NULL
                   AND mdx.customer_id = ps.customer_id
                   AND mdx.sent_at BETWEEN ps.created_at - interval '2 minutes'
                                       AND ps.created_at + interval '2 minutes'
               )
               AND ps.status IN ('queued', 'sent', 'delivered')
               AND ps.created_at > t.created_at
           )
           AND NOT EXISTS (
             SELECT 1 FROM customer_interactions pi
             WHERE pi.customer_id = t.customer_id
               AND pi.interaction_type IN ('call_outbound', 'call', 'note')
               -- Inbound-call logs and automated pipeline notes are not
               -- staff follow-up (codex r29): 'call'/'note' rows count
               -- only when admin-authored.
               AND (pi.interaction_type = 'call_outbound' OR pi.admin_user_id IS NOT NULL)
               AND pi.created_at > t.created_at
           ))
       -- "Expired today": judged by the DEADLINE window — the hourly
       -- verifier's UPDATE does not bump updated_at (no pg auto-touch;
       -- codex #3232 r1), so a deadline inside the last ~25h means the
       -- expiry happened today.
       -- Half-open 24h window tiles exactly with the daily 6:15pm run —
       -- a 25h window re-reported yesterday's expiries (codex r2).
       OR (t.status = 'expired' AND t.action_verified = false
           AND t.deadline > now() - interval '30 days' AND t.deadline <= :cutoff
           -- Staff completing AFTER auto-expiry counts (codex r16).
           AND NOT EXISTS (
             SELECT 1 FROM sms_log es
             WHERE es.customer_id = t.customer_id AND es.direction = 'outbound'
               AND es.message_type IN ${HUMAN_REPLY_TYPES}
               -- A human-APPROVED click-followup nudge is proactive marketing,
               -- not a reply to this item (codex r24): its draft intent is
               -- 'click_followup' and finalize stamps sent_at at send time.
               AND NOT EXISTS (
                 SELECT 1 FROM message_drafts mdx
                 WHERE mdx.sms_log_id IS NULL
                   AND mdx.customer_id = es.customer_id
                   AND mdx.sent_at BETWEEN es.created_at - interval '2 minutes'
                                       AND es.created_at + interval '2 minutes'
               )
               AND es.status IN ('queued', 'sent', 'delivered')
               AND es.created_at > t.created_at
           )
           AND NOT EXISTS (
             SELECT 1 FROM customer_interactions ei
             WHERE ei.customer_id = t.customer_id
               AND ei.interaction_type IN ('call_outbound', 'call', 'note')
               -- Admin-authored only, same as the adjacent branches
               -- (codex r29/r30): inbound-call logs and automated
               -- pipeline notes are not staff outreach.
               AND (ei.interaction_type = 'call_outbound' OR ei.admin_user_id IS NOT NULL)
               AND ei.created_at > t.created_at
           ))
       -- 'verified' can be bogus (the verifier accepts ANY later outbound,
       -- codex r10): re-surface verified tasks with no HUMAN outbound.
       OR (t.status = 'verified'
           AND t.deadline > now() - interval '30 days' AND t.deadline <= :cutoff
           AND NOT EXISTS (
             SELECT 1 FROM sms_log vs
             WHERE vs.customer_id = t.customer_id
               AND vs.direction = 'outbound'
               AND vs.message_type IN ${HUMAN_REPLY_TYPES}
               -- A human-APPROVED click-followup nudge is proactive marketing,
               -- not a reply to this item (codex r24): its draft intent is
               -- 'click_followup' and finalize stamps sent_at at send time.
               AND NOT EXISTS (
                 SELECT 1 FROM message_drafts mdx
                 WHERE mdx.sms_log_id IS NULL
                   AND mdx.customer_id = vs.customer_id
                   AND mdx.sent_at BETWEEN vs.created_at - interval '2 minutes'
                                       AND vs.created_at + interval '2 minutes'
               )
               AND vs.status IN ('queued', 'sent', 'delivered')
               AND vs.created_at > t.created_at
           )
           -- A logged outbound call / call / note IS a human action
           -- (codex r11) — those verifications stand.
           AND NOT EXISTS (
             SELECT 1 FROM customer_interactions ci
             WHERE ci.customer_id = t.customer_id
               AND ci.interaction_type IN ('call_outbound', 'call', 'note')
               -- Inbound-call logs and automated pipeline notes are not
               -- staff follow-up (codex r29): 'call'/'note' rows count
               -- only when admin-authored.
               AND (ci.interaction_type = 'call_outbound' OR ci.admin_user_id IS NOT NULL)
               AND ci.created_at > t.created_at
           ))
    -- Newest-first (codex r8): oldest-first returned the same stuck 12
    -- forever and newer tasks never surfaced with details; yesterday's
    -- rows were already reported and live on in the overflow count.
    ORDER BY t.deadline DESC NULLS LAST
    LIMIT :cap
    `,
    { cap: MAX_PER_SECTION, cutoff },
  );
  return rows;
}

// Lane 3: threads whose last message today is inbound — customer waiting.
// Peer = normalized last-10 counterpart phone; reactions/opt-flows excluded.
async function loadUnansweredThreads(cutoff = new Date()) {
  const { rows } = await db.raw(
    `
    WITH last_inbound AS (
      SELECT DISTINCT ON (peer) peer, message_body, created_at
      FROM (
        SELECT message_body, created_at,
               RIGHT(REGEXP_REPLACE(COALESCE(from_phone, ''), '\\D', '', 'g'), 10) AS peer
        FROM sms_log
        -- Rolling 7-day live worklist (codex r15): an unanswered thread
        -- must reappear until answered — the marker window stranded
        -- overflow rows.
        WHERE created_at >= now() - interval '30 days'
          AND created_at <= :cutoff
          AND direction = 'inbound'
          -- reschedule_reply rows are machine-handled by RescheduleSMS,
          -- whose confirmation goes out BEFORE the inbound row is
          -- persisted — they are never 'unanswered' (codex r29).
          AND COALESCE(message_type, '') NOT IN ('opt_out', 'opt_in', 'sms_reaction', 'help_request', 'reschedule_reply')
      ) inbound
      WHERE peer <> ''
      ORDER BY peer, created_at DESC
    )
    SELECT l.peer, l.message_body, l.created_at,
           NULLIF(TRIM(COALESCE(cu.first_name, '') || ' ' || COALESCE(cu.last_name, '')), '') AS customer_name,
           cu.id AS customer_id,
           COUNT(*) OVER () AS total_count
    FROM last_inbound l
    LEFT JOIN LATERAL (
      -- Single-match only (mirrors the webhook rule): two customers on one
      -- number must not link the thread to an arbitrary record (codex r3).
      SELECT c2.id, c2.first_name, c2.last_name FROM customers c2
      WHERE c2.deleted_at IS NULL
        AND RIGHT(REGEXP_REPLACE(COALESCE(c2.phone, ''), '\\D', '', 'g'), 10) = l.peer
        AND NOT EXISTS (
          SELECT 1 FROM customers c3
          WHERE c3.deleted_at IS NULL AND c3.id <> c2.id
            AND RIGHT(REGEXP_REPLACE(COALESCE(c3.phone, ''), '\\D', '', 'g'), 10) = l.peer
        )
      LIMIT 1
    ) cu ON true
    -- Answered = a HUMAN outbound after the last inbound. Automated
    -- broadcasts (reminders, receipts, review asks) must not clear a
    -- waiting customer (codex #3232 r1).
    WHERE NOT EXISTS (
      SELECT 1 FROM sms_log os
      WHERE os.direction = 'outbound'
        AND os.message_type IN ${HUMAN_REPLY_TYPES}
        -- A human-APPROVED click-followup nudge is proactive marketing,
        -- not a reply to this item (codex r24): its draft intent is
        -- 'click_followup' and finalize stamps sent_at at send time.
        AND NOT EXISTS (
          SELECT 1 FROM message_drafts mdx
          WHERE mdx.sms_log_id IS NULL
            AND mdx.customer_id = os.customer_id
            AND mdx.sent_at BETWEEN os.created_at - interval '2 minutes'
                                AND os.created_at + interval '2 minutes'
        )
        AND os.status IN ('queued', 'sent', 'delivered')
        AND os.created_at > l.created_at
        AND RIGHT(REGEXP_REPLACE(COALESCE(os.to_phone, ''), '\\D', '', 'g'), 10) = l.peer
    )
    -- A later STOP ends the thread: an opted-out customer must not be
    -- surfaced as waiting for a reply nobody may send (codex r4).
    AND NOT EXISTS (
      SELECT 1 FROM sms_log oo
      WHERE oo.direction = 'inbound'
        AND oo.message_type = 'opt_out'
        AND oo.created_at > l.created_at
        AND RIGHT(REGEXP_REPLACE(COALESCE(oo.from_phone, ''), '\\D', '', 'g'), 10) = l.peer
    )
    ORDER BY l.created_at DESC
    LIMIT :cap
    `,
    { cap: MAX_PER_SECTION, cutoff },
  );
  return rows;
}

// Pure composition: null = the day is fully worked (the common, quiet case).
function composeUnworkedCommsDigest({ callbacks = [], followUps = [], unanswered = [] } = {}) {
  const a = (callbacks || []).filter(Boolean);
  const b = (followUps || []).filter(Boolean);
  const c = (unanswered || []).filter(Boolean);
  // Full per-lane counts ride each row as total_count (COUNT(*) OVER ()) —
  // the LIMIT keeps the email readable, but the SUBJECT and the "+N more"
  // lines must report everything: overflow rows would otherwise vanish
  // forever once the daily send-marker stamps (codex #3232 r1).
  const laneTotal = (rows) => (rows.length && Number(rows[0].total_count) > 0
    ? Number(rows[0].total_count) : rows.length);
  const aTotal = laneTotal(a);
  const bTotal = laneTotal(b);
  const cTotal = laneTotal(c);
  const total = aTotal + bTotal + cTotal;
  if (!total) return null;
  const moreLine = (shown, totalCount) => (totalCount > shown ? [`…and ${totalCount - shown} more not shown`] : []);

  const subject = `ACT: ${total} unworked comm${total === 1 ? '' : 's'} at end of day — ${aTotal} callback${aTotal === 1 ? '' : 's'}, ${bTotal} follow-up${bTotal === 1 ? '' : 's'}, ${cTotal} unanswered text${cTotal === 1 ? '' : 's'}`;

  const sectionText = [];
  const sectionHtml = [];

  if (a.length) {
    sectionText.push('Callbacks requested on calls today (nothing else tracks these):');
    sectionText.push(...a.map((r) => `- ${etDateTime(r.created_at)} ${r.customer_name || maskPhone(r.from_phone)}${r.duration_seconds ? ` (${Math.round(r.duration_seconds / 60)}min)` : ''}${r.summary ? ` — ${String(r.summary).replace(/\s+/g, ' ').trim()}` : ''}`));
    sectionText.push(...moreLine(a.length, aTotal));
    sectionText.push('');
    sectionHtml.push(`<p><strong>Callbacks requested on calls today</strong> (nothing else tracks these):</p><ul style="margin:0 0 12px 18px;padding:0;">${a.map((r) => `<li style="margin:0 0 6px 0;">${esc(etDateTime(r.created_at))} ${esc(r.customer_name || maskPhone(r.from_phone))}${r.duration_seconds ? ` (${Math.round(r.duration_seconds / 60)}min)` : ''}${r.summary ? ` — ${esc(String(r.summary).replace(/\s+/g, ' ').trim())}` : ''}</li>`).join('')}</ul>${aTotal > a.length ? `<p>…and ${aTotal - a.length} more not shown</p>` : ''}`);
  }
  if (b.length) {
    sectionText.push('Follow-up tasks overdue or silently expired today:');
    sectionText.push(...b.map((r) => `- ${r.customer_name || (r.call_context ? `Unlinked caller — ${String(r.call_context).replace(/\s+/g, ' ').trim()}` : 'Unknown')} [${r.task_type || 'task'}${r.status === 'expired' ? ', auto-expired' : r.status === 'verified' ? ', auto-verified by a non-human send' : ''}]${r.recommended_action ? ` — ${String(r.recommended_action).replace(/\s+/g, ' ').trim().slice(0, 120)}` : ''}`));
    sectionText.push(...moreLine(b.length, bTotal));
    sectionText.push('');
    sectionHtml.push(`<p><strong>Follow-up tasks overdue or silently expired today:</strong></p><ul style="margin:0 0 12px 18px;padding:0;">${b.map((r) => `<li style="margin:0 0 6px 0;">${esc(r.customer_name || (r.call_context ? `Unlinked caller — ${String(r.call_context).replace(/\s+/g, ' ').trim()}` : 'Unknown'))} [${esc(r.task_type || 'task')}${r.status === 'expired' ? ', auto-expired' : r.status === 'verified' ? ', auto-verified by a non-human send' : ''}]${r.recommended_action ? ` — ${esc(String(r.recommended_action).replace(/\s+/g, ' ').trim().slice(0, 120))}` : ''}</li>`).join('')}</ul>${bTotal > b.length ? `<p>…and ${bTotal - b.length} more not shown</p>` : ''}`);
  }
  if (c.length) {
    sectionText.push('Texts still waiting on a reply (thread ends inbound):');
    sectionText.push(...c.map((r) => `- ${etDateTime(r.created_at)} ${r.customer_name || maskPhone(r.peer)}: "${String(r.message_body || '').replace(/\s+/g, ' ').trim().slice(0, 120)}"`));
    sectionText.push(...moreLine(c.length, cTotal));
    sectionText.push('');
    sectionHtml.push(`<p><strong>Texts still waiting on a reply</strong> (thread ends inbound):</p><ul style="margin:0 0 12px 18px;padding:0;">${c.map((r) => `<li style="margin:0 0 6px 0;">${esc(etDateTime(r.created_at))} ${r.customer_id ? `<a href="${esc(adminPortalUrl())}/admin/communications?thread=${esc(r.customer_id)}">${esc(r.customer_name || maskPhone(r.peer))}</a>` : esc(r.customer_name || maskPhone(r.peer))}: &quot;${esc(String(r.message_body || '').replace(/\s+/g, ' ').trim().slice(0, 120))}&quot;</li>`).join('')}</ul>${cTotal > c.length ? `<p>…and ${cTotal - c.length} more not shown</p>` : ''}`);
  }

  const text = [
    `End-of-day check: ${total} open comm item${total === 1 ? '' : 's'} (rolling 30-day worklist — items stay until worked).`,
    '',
    ...sectionText,
    ...(a.length ? [`Calls: ${adminPortalUrl()}/admin/communications#tab=calls`] : []),
    `Communications: ${adminPortalUrl()}/admin/communications`,
  ].join('\n');
  const html = [
    `<p>End-of-day check: <strong>${total}</strong> open comm item${total === 1 ? '' : 's'} (rolling 30-day worklist — items stay until worked).</p>`,
    ...sectionHtml,
    ...(a.length ? [`<p><a href="${esc(adminPortalUrl())}/admin/communications#tab=calls">Open the Calls tab</a></p>`] : []),
    `<p><a href="${esc(adminPortalUrl())}/admin/communications">Open communications</a></p>`,
  ].join('\n');

  return { subject, text, html, total, callbacks: aTotal, followUps: bTotal, unanswered: cTotal };
}

// Durable daily-send guard — same rationale as turf-variance-digest.js.
const SEND_MARKER_KEY = 'unworked-comms-eod';
const TWENTY_HOURS_MS = 20 * 60 * 60 * 1000;

async function sentRecently() {
  try {
    const row = await db('ops_email_send_state').where({ email_key: SEND_MARKER_KEY }).first('last_sent_at');
    return Boolean(row?.last_sent_at && (Date.now() - new Date(row.last_sent_at).getTime()) < TWENTY_HOURS_MS);
  } catch (err) {
    logger.warn(`[unworked-comms] send-marker read failed (${err.message}) — proceeding without the guard`);
    return false;
  }
}

async function stampSendMarker(cutoff) {
  try {
    // The marker records the PRE-QUERY cutoff, not send time — an item
    // arriving between the loaders' scan and the send must fall inside
    // the NEXT window, not vanish between them (codex r5).
    const now = cutoff instanceof Date ? cutoff : new Date();
    await db('ops_email_send_state')
      .insert({ email_key: SEND_MARKER_KEY, last_sent_at: now, updated_at: new Date() })
      .onConflict('email_key')
      .merge({ last_sent_at: now, updated_at: new Date() });
  } catch (err) {
    logger.warn(`[unworked-comms] send-marker write failed (${err.message}) — next tick may re-send`);
  }
}

async function runUnworkedCommsWatcher(opts = {}) {
  if (await (opts.sentRecently || sentRecently)()) return { skipped: 'recent_send' };
  const windowCutoff = new Date();

  let sections;
  try {
    const [callbacks, followUps, unanswered] = await Promise.all([
      (opts.loadCallbackCalls || loadCallbackCalls)(windowCutoff),
      (opts.loadDroppedFollowUps || loadDroppedFollowUps)(windowCutoff),
      (opts.loadUnansweredThreads || loadUnansweredThreads)(windowCutoff),
    ]);
    sections = { callbacks, followUps, unanswered };
  } catch (err) {
    logger.error(`[unworked-comms] query failed: ${err.message}`);
    return { skipped: 'query_failed' };
  }

  const composed = composeUnworkedCommsDigest(sections);
  if (!composed) return { skipped: 'nothing_found' };

  if (watcherDisabled()) {
    logger.info(`[unworked-comms] disabled — would send ${composed.total} item(s)`);
    return { skipped: 'disabled', ...composed };
  }

  const mailer = opts.sendgrid || sendgrid;
  if (typeof mailer.isConfigured === 'function' && !mailer.isConfigured()) {
    logger.warn('[unworked-comms] mailer not configured — skipping send');
    return { skipped: 'unconfigured', ...composed };
  }

  // FAIL CLOSED: owner/internal inboxes only.
  const to = watcherEmail();
  if (!isInternalEmailRecipient(to)) {
    logger.warn('[unworked-comms] recipient is not an internal address — skipping send; set a valid UNWORKED_COMMS_WATCHER_EMAIL');
    return { skipped: 'recipient', ...composed };
  }

  try {
    await mailer.sendOne({
      to,
      fromEmail: fromEmail(),
      fromName: FROM_NAME,
      subject: composed.subject,
      html: composed.html,
      text: composed.text,
      categories: ['ops', 'unworked-comms'],
      suppressErrorLog: true,
    });
  } catch (err) {
    logger.error(`[unworked-comms] send failed (status ${Number.isInteger(err?.status) ? err.status : 'network'})`);
    return { sent: false, error: true, ...composed };
  }
  await (opts.stampSendMarker || stampSendMarker)(windowCutoff);
  logger.info(`[unworked-comms] sent: ${composed.total} unworked (${composed.callbacks} callbacks, ${composed.followUps} follow-ups, ${composed.unanswered} unanswered)`);
  return { sent: true, ...composed };
}

module.exports = {
  runUnworkedCommsWatcher,
  _private: { composeUnworkedCommsDigest },
};
