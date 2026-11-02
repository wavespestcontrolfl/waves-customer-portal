/**
 * Voice-relay Phase E — URGENT/HOT-LEAD INTERNAL OWNER ALERT.
 *
 * When Sandy captures a lead she classified `hot` (the prompt defines hot as
 * emergency / swarming / active infestation / angry customer), the owner gets
 * an alert IMMEDIATELY instead of finding it in a digest tomorrow.
 *
 * THE PAGE IS A REGISTRY TRIGGER (sweep #7303 B1): relay_hot_lead rings the
 * admin bell and pushes to the owner's phone; relay_reservice_filed pushes the
 * re-service ticket whose own bell card relay-reservice.js already wrote. Both
 * keys are on the bell policy's trigger allowlist: a caller reaching us is
 * customer communication (owner ruling 2026-08-28). These pages used to go out
 * as owner-phone `internal_alert` SMS, which services/twilio.js redirects to
 * the internal_admin_alert trigger — denylisted, so they reached nobody while
 * the result still read as sent.
 *
 * NOT CUSTOMER-FACING, EVER. The house rule ("the owner sends all customer
 * communications") is untouched: both triggers reach admin-role staff only, as
 * a bell row and a phone push. There is no code path from the voice agent to
 * sendCustomerMessage / a customer SMS or email.
 *
 * GATE: the existing context gate (VOICE_RELAY_CONTEXT_ENABLED === 'true',
 * fail-closed). Gate off ⇒ no alert, no sender loaded.
 *
 * IDEMPOTENT: at most ONE SUCCESSFUL alert per call. The session owns the flag
 * (relay-conversation's tool ctx: ctx.ownerAlerted / ctx.markOwnerAlerted), so
 * a model that calls capture_lead twice — or a retry after a tool error —
 * cannot page the owner twice. The flag is set AFTER the send returns: a
 * transient failure must not consume the one-per-call budget and silently
 * swallow the page.
 *
 * FAIL-OPEN: an alert failure must never break the call or the lead write.
 * Everything is inside a try/catch that logs and returns false. Phone numbers
 * are masked in logs and, by the trigger sanitizer, in the bell and the push;
 * the link opens the lead or customer page, which carries the full number.
 */

const logger = require('../logger');
const { maskPhone, agentName } = require('./relay-protocol');

const MAX_ALERT_BODY = 480; // the full text behind the hot-lead bell's "Show full text"

/**
 * Did the page LAND? triggerNotification never throws; it reports what it
 * did. A bell-policy silence, a preference or test-account suppression, or an
 * error is not delivery. A bell row written, or a push handed to at least one
 * device, is.
 */
function pageDelivered(stats) {
  if (!stats || stats.error || stats.policySilenced || stats.suppressed) return false;
  return stats.bellWritten === true || Number(stats.push?.sent || 0) > 0;
}

/** Why pageDelivered said no, for the log line. */
function undeliveredReason(stats) {
  if (stats?.policySilenced) return 'silenced by the bell policy';
  if (stats?.suppressed) return 'suppressed';
  if (stats?.error) return 'notification error';
  return 'no bell row and no push';
}

/**
 * The page's headline and why, composed through docs/admin-notifications.md.
 * Only the caller's own words can break a copy rule here (the copy tests prove
 * our own text passes), so a violation keeps the page in the composer's own
 * fallback shape, as raiseAdminAlert and reservice_self_booked do.
 */
function composePage(spec) {
  const compose = require('../admin-alert-compose');
  try {
    return compose.composeAdminAlert(spec);
  } catch (err) {
    if (err.code !== 'ADMIN_ALERT_RULE') throw err;
    return {
      headline: compose.cutAtWord(`${spec.area} — ${spec.action}`, compose.MAX_HEADLINE_CHARS),
      why: spec.why,
      link: spec.link,
      metadata: { ...compose.validStructuredFields(spec), ruleViolations: err.violations },
    };
  }
}

/**
 * A why that quotes the first sentence of the caller's words (PAN-scrubbed by
 * alertSafe first, like every durable field here), or `plain` when there are
 * none.
 */
function quotedWhy(lead, text, plain) {
  const { firstSentence } = require('../admin-alert-compose');
  const { redactedWords, whyWithQuote } = require('../admin-alert-names');
  const quote = text ? firstSentence(redactedWords(alertSafe(text, 200))).replace(/[.!?]+$/, '') : '';
  return quote ? whyWithQuote({ lead, quote }) : plain;
}

/** One flat, quote-free line for the alert body. */
function alertSafe(value, max = 80) {
  // ⭐ THE PAN SCRUB APPLIES TO EVERY DURABLE SURFACE THE MODEL CAN WRITE.
  // urgency_reason / call_summary are model-authored from the caller's words —
  // a card number read aloud would ride them into the notification feed and
  // push delivery, bypassing the same scrub the transcript deliberately takes.
  // Scrub BEFORE the truncation so a cut cannot split a number past detection.
  // ⭐ FAIL CLOSED: if the scrub itself cannot run, the field is DROPPED — an
  // alert missing its detail line is an inconvenience; an unscrubbed PAN in
  // the durable notification feed is the AGENTS.md P0 card-data rule broken.
  let text = String(value == null ? '' : value);
  try {
    const { scrubPans } = require('../../utils/pan-scrub');
    text = scrubPans(text);
  } catch {
    return '[detail unavailable]';
  }
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * Build the full owner-facing text, read from the bell's "Show full text".
 * The trigger sanitizer masks the callback number there; the page's link
 * opens the lead or customer record, which carries it in full.
 */
function buildHotLeadAlert({ firstName, lastName, phone, city, requestedService, urgencyReason, summary, existingCustomer }) {
  const name = [alertSafe(firstName, 40), alertSafe(lastName, 40)].filter(Boolean).join(' ');
  const lines = [
    '🚨 URGENT lead from the phone assistant:',
    name || 'Caller name not given',
    alertSafe(phone, 20) || 'no callback number',
  ];
  if (city) lines.push(alertSafe(city, 40));
  if (existingCustomer) lines.push('EXISTING CUSTOMER');
  if (requestedService) lines.push(`Wants: ${alertSafe(requestedService, 80)}`);
  if (urgencyReason) lines.push(`Why urgent: ${alertSafe(urgencyReason, 120)}`);
  if (summary) lines.push(alertSafe(summary, 160));
  lines.push('Call them back — this was flagged hot on the call.');
  return lines.join('\n').slice(0, MAX_ALERT_BODY);
}

/**
 * The relay_hot_lead payload: the composed headline and why (what the bell
 * row and the push show), the full text, and the deep link.
 */
function buildHotLeadPage(lead, ctx) {
  // Deep link straight to the actionable record: the trigger sanitizer masks
  // phone numbers in the bell and the push, so the lead (or the matched
  // customer) page is where the full callback number lives.
  const link = lead.leadId
    ? `/admin/leads?leadId=${encodeURIComponent(lead.leadId)}`
    : (ctx.customerId ? `/admin/customers?customerId=${encodeURIComponent(ctx.customerId)}` : '/admin/leads');
  const { fitAction } = require('../admin-alert-names');
  const name = [alertSafe(lead.first_name, 40), alertSafe(lead.last_name, 40)].filter(Boolean).join(' ');
  const page = composePage({
    area: 'Leads',
    action: name ? fitAction('Leads', name, [(n) => `call back ${n} now`]) : 'call back an urgent caller now',
    why: quotedWhy(`${agentName()} flagged the call urgent: `, lead.urgency_reason || lead.call_summary, `${agentName()} flagged the call urgent.`),
    severity: 'needs-you',
    link,
    // The record the owner acts on; a call with neither falls back to its CallSid.
    subject: lead.leadId ? { type: 'lead', id: String(lead.leadId) }
      : (ctx.customerId ? { type: 'customer', id: String(ctx.customerId) } : { type: 'call', id: String(ctx.callSid || 'unknown') }),
    doneWhen: 'urgent_caller_called_back',
    who: 'person',
    contact: true,
  });
  return {
    title: page.headline,
    body: page.why,
    detail: buildHotLeadAlert({
      firstName: lead.first_name,
      lastName: lead.last_name,
      phone: lead.phone,
      city: lead.city,
      requestedService: lead.requested_service,
      urgencyReason: lead.urgency_reason,
      summary: lead.call_summary,
      existingCustomer: Boolean(ctx.customerId),
    }),
    link,
    alert: page.metadata,
    callSid: ctx.callSid || null,
  };
}

/**
 * Fire the internal hot-lead alert for THIS call. Returns true when the page
 * landed (a bell row or a push), false in every other case (gate off, not hot,
 * already alerted, silenced, send failed).
 *
 * @param {object} lead   { first_name, last_name, phone, city, requested_service,
 *                          urgency_reason, call_summary, lead_quality }
 * @param {object} ctx    the relay session tool ctx (callSid, ownerAlerted,
 *                        markOwnerAlerted, customerId)
 */
// ⭐ ONE PAGE PER CALL — DURABLY. The in-memory latch below is per
// RelayConversation, and a legitimate reconnect (Twilio retrying the socket
// with a freshly minted token) builds a NEW conversation with the latch clear:
// same CallSid, second page. The receipt therefore lives where the session
// claim already does — a jsonb key burned atomically on the call's own
// call_log row, one statement, exactly one winner. A send FAILURE releases the
// key so the retry rail stays open (the latch doctrine below, made durable).
// Fail-OPEN on a claim error: for an internal hot-lead page, a rare duplicate
// is safer than a missed swarm call.
// Two keys, because CLAIMED IS NOT DELIVERED: the claim is who owns the send,
// the sent receipt is proof the page went out. A losing claimant that treated
// the claim itself as coverage could tell its caller "the team was notified"
// while the winner's send failed and released — hot lead paged by nobody.
const HOT_ALERT_KEY = 'relay_hot_alert_at';
const HOT_ALERT_SENT_KEY = 'relay_hot_alert_sent_at';
// ⭐ THE CLAIM IS A LEASE, NOT A TOMBSTONE. A process that dies between the
// claim and the send (or the sent receipt) leaves claimed=true/sent=false
// forever — and every later session would wait, see no receipt, and refuse to
// page for the rest of time. A claim with no delivery receipt is therefore
// RECLAIMABLE once it is old enough that no live send can still be running;
// the reclaim is the same single-statement burn, so exactly one taker wins.
const HOT_ALERT_CLAIM_LEASE = "interval '2 minutes'";
// ⭐ THE LEASE HAS AN OWNER, NOT JUST AN AGE. A timestamp-only lease let a
// STALE claimant (its send ran past the lease while another session reclaimed)
// release or receipt a claim that now belongs to someone else — its
// unconditional release opened the door for a THIRD sender while the second
// was still mid-send. Every claim therefore mints a per-attempt token stored
// beside the timestamp in the same atomic statement, and release/receipt
// writes only land while that exact token is still on the row.
const HOT_ALERT_OWNER_KEY = 'relay_hot_alert_owner';

// ⭐ DELIVERY IS BOUNDED INSIDE THE LEASE. The reclaim math assumes no live
// send can still be running once a claim is lease-old; an unbounded send made
// that false (a stalled pool or provider could hold a send open past the lease
// while a reclaimer paged again). 90s < the 2-minute lease keeps the invariant
// honest. A timeout is AMBIGUOUS, not a failure: the page may still land, so
// the caller must NOT release the claim — it expires on its own, and the next
// claimant's delivery probe (or the owner-guarded receipt) settles the truth.
const ALERT_SEND_DEADLINE_MS = 90 * 1000;
const SEND_TIMED_OUT = Symbol('alert-send-timed-out');
function sendWithDeadline(sendPromise) {
  // Materialize ONCE — racing a bare thenable and touching it again re-runs it
  // (the Knex-thenable lesson); triggerNotification returns a real promise but
  // the rule costs nothing to keep.
  const send = Promise.resolve(sendPromise);
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve(SEND_TIMED_OUT), ALERT_SEND_DEADLINE_MS);
    timer.unref?.();
  });
  return Promise.race([send, deadline]).finally(() => clearTimeout(timer));
}

async function claimHotAlertForCall(callSid) {
  const key = String(callSid || '').trim();
  if (!key) return { claimed: true, durable: false, owner: null }; // no call row to claim on
  const owner = require('crypto').randomBytes(8).toString('hex');
  try {
    const db = require('../../models/db');
    const rows = await db('call_log')
      .where({ twilio_call_sid: key })
      .whereRaw(
        `((metadata->>'${HOT_ALERT_KEY}') IS NULL `
        + `OR ((metadata->>'${HOT_ALERT_SENT_KEY}') IS NULL `
        + `AND (metadata->>'${HOT_ALERT_KEY}')::timestamptz < now() - ${HOT_ALERT_CLAIM_LEASE}))`,
      )
      .update({
        metadata: db.raw(
          `jsonb_set(jsonb_set(COALESCE(metadata, '{}'::jsonb), '{${HOT_ALERT_KEY}}', to_jsonb(now()::text), true), `
          + `'{${HOT_ALERT_OWNER_KEY}}', to_jsonb(?::text), true)`,
          [owner],
        ),
      })
      .returning('id');
    if (rows && rows.length > 0) return { claimed: true, durable: true, owner };
    // No unclaimed row: either another session already claimed this call, or
    // there is no call_log row at all (nothing to dedupe against) — only the
    // former means "stand down".
    const exists = await db('call_log').where({ twilio_call_sid: key }).first('id');
    return exists
      ? { claimed: false, durable: true, owner: null }
      : { claimed: true, durable: false, owner: null };
  } catch (err) {
    logger.warn(`[voice-relay-alert] hot-alert claim failed for ${key} — paging anyway (fail-open): ${err.message}`);
    return { claimed: true, durable: false, owner: null };
  }
}

async function markHotAlertSent(callSid, owner) {
  const key = String(callSid || '').trim();
  if (!key) return;
  try {
    const db = require('../../models/db');
    // Owner-guarded: a claimant whose lease was reclaimed mid-send must not
    // receipt someone else's claim. Its delivered page is not lost — the next
    // claimant's hotAlertAlreadyDelivered probe finds the notification row and
    // repairs the receipt under its OWN claim.
    const q = db('call_log').where({ twilio_call_sid: key });
    if (owner) q.whereRaw(`(metadata->>'${HOT_ALERT_OWNER_KEY}') = ?`, [owner]);
    await q.update({
      metadata: db.raw(
        `jsonb_set(COALESCE(metadata, '{}'::jsonb), '{${HOT_ALERT_SENT_KEY}}', to_jsonb(now()::text), true)`,
      ),
    });
  } catch (err) {
    // The claim key still stands, so no duplicate page — a loser just cannot
    // confirm coverage and stays conservative about the promise.
    logger.warn(`[voice-relay-alert] hot-alert sent receipt failed for ${key}: ${err.message}`);
  }
}

async function hotAlertState(callSid) {
  const key = String(callSid || '').trim();
  if (!key) return null;
  try {
    const db = require('../../models/db');
    const row = await db('call_log').where({ twilio_call_sid: key }).first('metadata');
    const meta = row && (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata);
    return {
      claimed: !!(meta && meta[HOT_ALERT_KEY]),
      sent: !!(meta && meta[HOT_ALERT_SENT_KEY]),
    };
  } catch {
    return null;
  }
}

async function releaseHotAlertClaim(callSid, owner) {
  const key = String(callSid || '').trim();
  if (!key) return;
  try {
    const db = require('../../models/db');
    // Owner-guarded: only the claimant that still HOLDS the lease may release
    // it. A stale claimant releasing unconditionally deleted a newer sender's
    // live claim and let a third sender page in parallel. No owner token (a
    // pre-owner row, or a non-durable claim) ⇒ leave the lease to expire.
    const q = db('call_log').where({ twilio_call_sid: key });
    if (owner) q.whereRaw(`(metadata->>'${HOT_ALERT_OWNER_KEY}') = ?`, [owner]);
    else q.whereRaw(`(metadata->>'${HOT_ALERT_OWNER_KEY}') IS NULL`);
    await q.update({
      metadata: db.raw(
        `(COALESCE(metadata, '{}'::jsonb) - '${HOT_ALERT_KEY}') - '${HOT_ALERT_OWNER_KEY}'`,
      ),
    });
  } catch (err) {
    logger.warn(`[voice-relay-alert] hot-alert claim release failed for ${key}: ${err.message}`);
  }
}

// Ends the sweep's obligation for a call (its relay_hot_alert_needed marker):
// a linkage to a deleted lead, or a page every admin muted. Best effort.
async function dropHotAlertObligation(callSid) {
  const key = String(callSid || '').trim();
  if (!key) return;
  try {
    const db = require('../../models/db');
    await db('call_log')
      .where({ twilio_call_sid: key })
      .update({ metadata: db.raw("COALESCE(metadata, '{}'::jsonb) - 'relay_hot_alert_needed'") });
  } catch (err) {
    logger.warn(`[voice-relay-alert] hot-alert obligation clear failed for ${key}: ${err.message}`);
  }
}

// The per-call delivery-level dedupe key. triggerNotification stamps it on the
// bell row (metadata.dedupeKey) under notifyAdmin's advisory lock, so a retry
// after an AMBIGUOUS receipt failure (page delivered, receipt write lost) can
// probe for it instead of paging twice. The CallSid is an opaque id, not PII.
function hotAlertDedupeKey(callSid) {
  return `relay-hot-lead:${callSid}`;
}

async function hotAlertAlreadyDelivered(callSid) {
  const key = String(callSid || '').trim();
  if (!key) return false;
  try {
    const db = require('../../models/db');
    const row = await db('notifications')
      .where({ recipient_type: 'admin' })
      .whereRaw("metadata->>'dedupeKey' = ?", [hotAlertDedupeKey(key)])
      .first('id');
    return !!row;
  } catch {
    return false; // unknown ⇒ page (a duplicate beats a missed swarm)
  }
}

async function alertOwnerHotLead(lead = {}, ctx = {}) {
  // Hoisted so the catch block can give back OUR claim (owner-guarded) and
  // never someone else's.
  let claim = null;
  try {
    // ⭐ THE CREATION GATE DOES NOT GOVERN RECOVERY. A persisted
    // relay_hot_alert_needed obligation was minted while the lane was live;
    // gating its DELIVERY on the same switch meant a rollback or gate outage
    // silently discarded owed pages. The sweep passes recovery:true and
    // delivers regardless — new obligations still cannot be created gate-off
    // (capture_lead itself is gate-checked upstream).
    const { isContextEnabled } = require('./relay-context');
    if (!isContextEnabled() && ctx.recovery !== true) return false;
    if (String(lead.lead_quality || '').toLowerCase() !== 'hot') return false;
    // One per CALL, never per turn. The session exposes a LIVE reader
    // (isOwnerAlerted) because the tool ctx is rebuilt each turn while two
    // capture_lead calls can land inside one turn; a plain `ownerAlerted`
    // boolean is honoured too so a test ctx stays simple.
    const alreadyAlerted = typeof ctx.isOwnerAlerted === 'function'
      ? ctx.isOwnerAlerted() === true
      : ctx.ownerAlerted === true;
    if (alreadyAlerted) return false;

    // The durable one-per-CALL receipt (reconnects build a fresh session).
    claim = await claimHotAlertForCall(ctx.callSid);
    if (!claim.claimed) {
      // Somebody else holds the claim — but CLAIMED IS NOT DELIVERED. Wait
      // briefly for their SENT receipt: present ⇒ this call is covered (latch
      // + true, the promise stands). Claim released mid-wait ⇒ their send
      // FAILED — take the claim over and page ourselves. Still claimed with
      // no receipt after the wait ⇒ report false WITHOUT the latch: the
      // caller is not promised a page nobody can prove, and a later
      // capture_lead on this session can try again.
      for (let i = 0; i < 3; i += 1) {
        await new Promise((r) => { const t = setTimeout(r, 400); t.unref?.(); });
        const state = await hotAlertState(ctx.callSid);
        if (state && state.sent) {
          if (typeof ctx.markOwnerAlerted === 'function') ctx.markOwnerAlerted();
          logger.info(`[voice-relay-alert] hot-lead page already sent for callSid=${ctx.callSid} — not paging twice`);
          return true;
        }
        if (state && !state.claimed) {
          claim = await claimHotAlertForCall(ctx.callSid);
          break; // released — the winner failed; try to take over
        }
      }
      if (!claim.claimed) {
        logger.warn(
          `[voice-relay-alert] hot-lead claim held elsewhere with NO delivery receipt callSid=${ctx.callSid} `
          + '— not paging (no duplicate) and not confirming (no false promise)'
        );
        return false;
      }
    }

    // ⭐ THE DELIVERY-LEVEL DEDUPE. A page that was DELIVERED but whose sent
    // receipt failed to write leaves claimed-but-unsent — the lease expires and
    // the sweep would page again. The notification row IS delivery evidence:
    // probe for this call's dedupe key before sending, and a hit just repairs
    // the receipt instead of re-paging.
    if (await hotAlertAlreadyDelivered(ctx.callSid)) {
      if (claim.durable) await markHotAlertSent(ctx.callSid, claim.owner);
      if (typeof ctx.markOwnerAlerted === 'function') ctx.markOwnerAlerted();
      logger.info(`[voice-relay-alert] hot-lead page already delivered for callSid=${ctx.callSid} — receipt repaired, not paging twice`);
      return true;
    }

    const { triggerNotification } = require('../notification-triggers');
    const sent = await sendWithDeadline(triggerNotification(
      'relay_hot_lead',
      buildHotLeadPage(lead, ctx),
      ctx.callSid ? { dedupeKey: hotAlertDedupeKey(ctx.callSid) } : {},
    ));
    if (sent === SEND_TIMED_OUT) {
      // AMBIGUOUS — the page may still land after this returns. No latch, no
      // receipt, and crucially NO release: releasing would invite an immediate
      // re-page racing a send that might yet deliver. The lease expires on its
      // own and the next claimant's delivery probe settles it.
      logger.error(
        `[voice-relay-alert] hot-lead owner alert timed out after ${ALERT_SEND_DEADLINE_MS}ms `
        + `callSid=${ctx.callSid || 'n/a'} — leaving the claim to expire (delivery is ambiguous)`
      );
      return false;
    }
    // ⭐ A RETURNED CALL IS NOT DELIVERY. triggerNotification reports a bell
    // policy silence, a suppression or an error without throwing. Until sweep
    // #7303 B1 this page rode the denylisted internal_alert redirect and every
    // silenced result read as sent: the latch closed, the retry never ran, and
    // the caller was told the team was notified. Only a bell row or a push
    // counts.
    if (!pageDelivered(sent)) {
      logger.error(
        `[voice-relay-alert] hot-lead owner alert NOT delivered callSid=${ctx.callSid || 'n/a'} `
        + `(${undeliveredReason(sent)}) — latch left open for a retry`
      );
      // A deliberate mute (every admin turned this page off on both channels)
      // is the owner's choice, not an outage: nothing is owed, so the hourly
      // sweep stops retrying this call. The caller is still promised nothing.
      if (sent?.suppressed) await dropHotAlertObligation(ctx.callSid);
      if (claim.durable) await releaseHotAlertClaim(ctx.callSid, claim.owner); // the retry rail stays open
      return false;
    }
    // ⭐ THE LATCH IS SET AFTER A SUCCESSFUL SEND, NOT BEFORE IT. Marking first
    // meant a transient bell/DB blip PERMANENTLY consumed the one-per-call
    // budget: the retry (or the second capture_lead) saw `alreadyAlerted` and
    // returned quietly, and the hot lead — a swarm, a sting, an angry customer —
    // was never paged at all. The failure path below now leaves the latch open
    // so the next attempt on this call can still get through, and the send
    // itself stays idempotent-by-latch once it succeeds.
    if (typeof ctx.markOwnerAlerted === 'function') ctx.markOwnerAlerted();
    // The durable DELIVERY receipt — what a losing claimant on a reconnect
    // needs to see before telling its caller the team was notified.
    if (claim.durable) await markHotAlertSent(ctx.callSid, claim.owner);
    logger.info(`[voice-relay-alert] hot-lead owner alert sent callSid=${ctx.callSid || 'n/a'} caller=${maskPhone(lead.phone)}`);
    return true;
  } catch (err) {
    // FAIL-OPEN, loudly: the lead is already written and the caller is still
    // on the line — an alert failure can never surface to either. The
    // one-per-call latch is deliberately NOT set here, so a later attempt on
    // this same call can still page the owner.
    logger.error(`[voice-relay-alert] hot-lead owner alert FAILED callSid=${ctx.callSid || 'n/a'}: ${err.message}`);
    // Give back the durable claim too — a failed page must stay retryable
    // across sessions, not just within this one. Owner-guarded: if we never
    // held a durable claim (or lost it), this touches nothing.
    if (claim && claim.durable) await releaseHotAlertClaim(ctx.callSid, claim.owner).catch(() => {});
    return false;
  }
}

/**
 * The relay_reservice_filed payload: the composed headline and why the push
 * shows, and the deep link to the customer whose ticket it is.
 */
function buildReservicePage(request) {
  const page = composePage({
    area: 'Schedule',
    action: `book the ${request.urgency === 'urgent' ? 'urgent ' : ''}re-service ${agentName()} took`,
    // ⭐ AN UNVERIFIED REQUESTER IS THE WHOLE WHY. The caller matched the
    // account only on a secondary contact slot (spouse, tenant, a previous
    // occupant), so the warning is the push body itself and nothing can
    // truncate it away; the ticket's card carries the full note.
    why: request.unverifiedRequester
      ? 'The caller is not the account holder, so check who they are before you book it.'
      : quotedWhy('They said: ', request.issue || request.subject, `${agentName()} filed it as a re-service request.`),
    severity: 'needs-you',
    link: request.customerId ? `/admin/customers?customerId=${encodeURIComponent(request.customerId)}` : '/admin/customers',
    subject: { type: 'customer', id: String(request.customerId || '') },
    doneWhen: 'reservice_scheduled',
    who: 'person',
    contact: true,
  });
  return { title: page.headline, body: page.why, link: page.link, requestId: request.requestId || null };
}

/**
 * ⭐ OWNER-RULED: every voice-filed re-service pages the owner.
 *
 * routes/requests.js 409s a covered pest/lawn ticket because the ticket queue
 * is "a proven black hole — 14 requests, zero resolved". The voice agent must
 * still file the ticket (it is the durable record) and cannot use the
 * streamline's booking half (that fires customer comms, which the agent may
 * never do) — so the alert is what makes the ticket reach a human.
 *
 * relay-reservice.js writes the ticket's bell card itself (bell:true); this is
 * the card's PHONE page: relay_reservice_filed, sent pushOnly so the bell keeps
 * one row per ticket. Not idempotent-latched like the hot-lead path:
 * request_reservice already refuses to file a second ticket in a lane, and the
 * caller's service_requests claim makes one filed ticket one page.
 *
 * Returns true when the push reached at least one device, the string
 * 'ambiguous' when the send timed out inside the lease (may still land — the
 * caller must keep its claim), false otherwise. Never throws.
 */
async function alertOwnerReservice(request = {}, ctx = {}) {
  try {
    // Same recovery carve-out as the hot-lead sender: an obligation persisted
    // while the lane was live must deliver even after a rollback — the sweep
    // passes recovery:true; live callers never do.
    const { isContextEnabled } = require('./relay-context');
    if (!isContextEnabled() && ctx.recovery !== true) return false;
    const { triggerNotification } = require('../notification-triggers');
    const sent = await sendWithDeadline(triggerNotification('relay_reservice_filed', buildReservicePage(request), { pushOnly: true }));
    if (sent === SEND_TIMED_OUT) {
      // AMBIGUOUS, not failed — the page may still land. The caller must NOT
      // release its claim on this result (the lease expires on its own);
      // releasing here is what let a retry page in parallel with a late send.
      logger.error(
        `[voice-relay-alert] re-service owner alert timed out after ${ALERT_SEND_DEADLINE_MS}ms `
        + `callSid=${ctx.callSid || 'n/a'} request=${request.requestId || 'n/a'} — delivery ambiguous`
      );
      return 'ambiguous';
    }
    // Same rule as the hot-lead path: only a push that reached a device is a
    // page. The ticket and its bell card are durable either way; an owed page
    // stays owed, so the caller's claim is released and the sweep retries it
    // while the ticket is open.
    if (!pageDelivered(sent)) {
      logger.error(
        `[voice-relay-alert] re-service owner alert NOT delivered callSid=${ctx.callSid || 'n/a'} `
        + `request=${request.requestId || 'n/a'} (${undeliveredReason(sent)}) — the phone page is still owed`
      );
      return false;
    }
    logger.info(`[voice-relay-alert] re-service owner alert sent callSid=${ctx.callSid || 'n/a'} request=${request.requestId || 'n/a'}`);
    return true;
  } catch (err) {
    logger.error(`[voice-relay-alert] re-service owner alert FAILED callSid=${ctx.callSid || 'n/a'}: ${err.message}`);
    return false;
  }
}

/**
 * Hourly backstop for the crash windows the lease alone cannot cover: died
 * after claiming but before sending, and died before the claim existed at all.
 * The sweep keys on the RELAY'S OWN obligation marker —
 * call_log.metadata.relay_hot_alert_needed, written by capture_lead alongside
 * the exact relay_lead_id linkage BEFORE the page attempt — never on lead
 * urgency: the recorded-call pipeline marks human-call leads urgent too, and an
 * urgency-scoped sweep paged the owner for calls the relay never touched
 * (while a reused lead's stale twilio_call_sid hid genuine relay ones). A row
 * leaves the population when the SENT receipt lands, or when its lead cannot
 * be resolved (marker removed — nothing to page).
 */
async function sweepAbandonedHotAlerts({ limit = 10 } = {}) {
  const db = require('../../models/db');
  let rows = [];
  try {
    rows = await db('call_log')
      .whereRaw("(metadata->>'relay_hot_alert_needed') IS NOT NULL")
      .whereRaw(`(metadata->>'${HOT_ALERT_SENT_KEY}') IS NULL`)
      // No age cutoff: an obligation is retained until its receipt lands or it
      // is explicitly cleared — a gate outage longer than any window must not
      // silently discard an owed page. The population is bounded by the
      // markers themselves (cleared on delivery or on a dead linkage).
      .orderBy('created_at', 'asc')
      .limit(limit)
      // from_phone + call_summary + customer_id feed the lead-LESS branch
      // below (a hot lifecycle-customer call composes its page from the call
      // row itself — and the customer link is what makes the recovered alert
      // actionable: the page's callback number is masked by the trigger
      // sanitizer and there is no lead record to open).
      .select('twilio_call_sid', 'metadata', 'from_phone', 'call_summary', 'customer_id');
  } catch (err) {
    logger.error(`[voice-relay-alert] abandoned hot-alert sweep query failed: ${err.message}`);
    return 0;
  }
  let paged = 0;
  for (const row of rows) {
    const meta = typeof row.metadata === 'string' ? (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })() : (row.metadata || {});
    const leadId = meta.relay_lead_id || null;
    let lead = null;
    let lookupFailed = false;
    if (leadId) {
      try {
         
        lead = await db('leads')
          .where({ id: leadId })
          .whereNull('deleted_at')
          .first('first_name', 'last_name', 'phone', 'city', 'transcript_summary');
      } catch (err) {
        // ⭐ A FAILED LOOKUP PROVES NOTHING. Clearing the obligation on a
        // transient DB error permanently suppressed the page — the marker is
        // only cleared when a SUCCESSFUL lookup shows the lead is gone.
        lookupFailed = true;
        logger.warn(`[voice-relay-alert] lead lookup failed for ${row.twilio_call_sid} — obligation retained: ${err.message}`);
      }
    }
    if (lookupFailed) continue; // next hourly run retries
    if (!lead) {
      // A HOT call from a LIFECYCLE customer has no lead BY DESIGN (capture
      // records on the account instead) — the page is still owed, composed
      // from the call row itself. Only a linkage that points at a DELETED
      // lead has nothing left to page about; that row clears its obligation
      // so it leaves the sweep population instead of retrying forever.
      if (!leadId) {
        lead = { phone: row.from_phone, transcript_summary: row.call_summary, first_name: null, last_name: null, city: null };
      } else {
         
        await dropHotAlertObligation(row.twilio_call_sid);
        continue;
      }
    }
     
    const ok = await alertOwnerHotLead(
      {
        ...lead,
        leadId: leadId || null, // deep link target on the owner page
        lead_quality: 'hot', // the obligation marker is only written for hot captures
        call_summary: lead.transcript_summary,
        urgency_reason: 'recovered by the hot-alert sweep',
      },
      // customer_id rides into the recovery ctx so alertOwnerHotLead's deep
      // link lands on the CUSTOMER page for the leadless (lifecycle) branch —
      // /admin/leads with a masked number was an urgent page with nothing to
      // open. Harmless when a lead exists (leadId wins the link).
      { callSid: row.twilio_call_sid, recovery: true, customerId: row.customer_id || null },
    ).catch(() => false);
    if (ok) paged += 1;
  }
  if (rows.length) logger.info(`[voice-relay-alert] abandoned hot-alert sweep: ${rows.length} candidate(s), ${paged} paged`);
  return paged;
}

/**
 * A caller recognised only through a customer's secondary contact slot
 * (spouse, tenant, prior occupant) needs a human follow-up. Owner ruling
 * 2026-10-03: ring ONE office bell tied to that customer — never a new lead
 * under the caller's number, and nothing on the customer's record changes
 * (the caller is recognised, not verified). Returns true only when a bell row
 * exists, 'superseded' when another socket owns the call now (nothing was
 * written), false otherwise; never throws.
 *
 * ⭐ FENCED LIKE EVERY OTHER RELAY WRITE. The bell is rewritten in place by a
 * later capture, so a stalled capture from a superseded socket must not land
 * over the replacement's corrected number or restriction: ownership is
 * re-proven under the call row's lock in the SAME transaction as the write
 * (claimOwnedElsewhere — the lead, booking and re-service writers' fence).
 */
async function alertOfficeContactFollowUp({ customerId, callbackPhone, summary, callSid, notes = [], sessionKey = null }) {
  if (!customerId || !callSid) return false;
  try {
    const db = require('../../models/db');
    const { raiseAdminAlert, firstSentence } = require('../admin-alert-compose');
    const { lookupCustomerName, fitAction, redactedWords, whyWithQuote } = require('../admin-alert-names');
    const name = await lookupCustomerName(db, customerId);
    let superseded = false;
    const result = await db.transaction(async (trx) => {
      if (sessionKey && await require('./relay-context').claimOwnedElsewhere(trx, callSid, sessionKey)) {
        superseded = true;
        return null;
      }
      return raiseAdminAlert('alert', {
      area: 'Comms',
      // ⭐ ONE NEUTRAL ACTION, WHATEVER THEY ASKED. The bell never tells the
      // office to reach out: the caller may have restricted how (or whether)
      // to be contacted, on a capture or in words before a hangup, and the
      // code does not judge that. A person reads the call and decides.
      action: name
        ? fitAction('Comms', name, [(n) => `review a contact's call on ${n}'s account`, (n) => `review ${n}'s contact's call`])
        : "review a contact's call on a customer account",
      why: whyWithQuote({ lead: `They called ${agentName()} from a number on the account: `, quote: firstSentence(redactedWords(summary)).replace(/[.!?]+$/, '') || 'asked for a follow-up' }),
      severity: 'needs-you',
      link: `/admin/customers?customerId=${encodeURIComponent(customerId)}`,
      subject: { type: 'customer', id: String(customerId) },
      doneWhen: 'contact_call_reviewed',
      who: 'person',
    }, {
      bell: true,
      dedupeKey: `sandy-contact-followup:${callSid}`,
      // One bell per call; a later capture on the same call (a corrected
      // number, an added email, a do-not-contact request) rewrites it in
      // place without ringing again.
      refreshOnDedupe: true,
      // …unless the office already marked it done: new details from the same
      // call are new work, so that refresh rings and reopens the row.
      ringOnRefresh: (existing) => Boolean(existing && existing.done_at),
      trx,
      // The number to reach them on, the whole summary, and anything they
      // asked about HOW to be contacted (a channel, a do-not-contact request)
      // — read from "Show full text".
      detail: [`Their number: ${callbackPhone || 'the number this call came from'}.`, String(summary || '').trim(), ...notes]
        .filter(Boolean).join(' '),
      metadata: { customerId, callSid, callbackPhone: callbackPhone || null, source: 'voice_relay_contact_followup' },
      });
    });
    if (superseded) {
      logger.warn(`[voice-relay] contact follow-up bell refused — session superseded callSid=${callSid}`);
      return 'superseded';
    }
    return Boolean(result?.id) && !result.suppressed;
  } catch (err) {
    logger.error(`[voice-relay] contact follow-up bell failed callSid=${callSid}: ${err.message}`);
    return false;
  }
}

module.exports = {
  alertOfficeContactFollowUp,
  alertOwnerHotLead,
  sweepAbandonedHotAlerts,
  alertOwnerReservice,
  buildHotLeadAlert,
  MAX_ALERT_BODY,
};
